// SPDX-License-Identifier: MIT
pragma solidity ^0.8.11;

import {vm, logUint} from "./Cheats.sol";
import {MockCNY} from "../src/MockCNY.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {TradeEscrow} from "../src/TradeEscrow.sol";

/// These tests PASS when the weakness EXISTS. They document what the contracts do not protect against yet.
contract BusinessRisks {
    MockCNY token; AgentRegistry reg; TradeEscrow esc;
    address owner = address(0xB0B); address operator = address(0x0FE); address payAgent = address(0xA1);
    address docAgent = address(0xA2); address negotiator = address(0xA3); address seller = address(0x5E11);
    address inspector = address(0x1A5); address friendlyInspector = address(0xF1E);
    uint256 constant Y = 1e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockCNY(); reg = new AgentRegistry(address(token)); esc = new TradeEscrow(address(token), address(reg));
        reg.setEscrow(address(esc)); reg.setKyc(owner, true); reg.setKyc(seller, true); reg.setKyc(operator, true);
        token.mint(owner, 10_000_000 * Y); token.mint(operator, 1_000_000 * Y);
        vm.startPrank(owner); token.approve(address(esc), type(uint256).max);
        reg.registerAgent(payAgent, operator, AgentRegistry.Mandate(800_000 * Y, 1_600_000 * Y, 100_000 * Y, 5));
        reg.setPayee(payAgent, seller, true); vm.stopPrank();
        vm.startPrank(operator); token.approve(address(reg), type(uint256).max); reg.topUpBond(payAgent, 50_000 * Y); vm.stopPrank();
    }

    function lines(uint256 qty, uint256 price) internal pure returns (TradeEscrow.Line[] memory l) {
        l = new TradeEscrow.Line[](1); l[0] = TradeEscrow.Line("battery", qty, price * Y);
    }

    function fund(address insp, uint256 qty, uint256 price) internal returns (uint256 id) {
        vm.prank(owner);
        id = esc.fundTrade(TradeEscrow.Parties(payAgent, docAgent, negotiator, seller, insp), keccak256("o"), keccak256("t"), lines(qty, price), false);
    }

    /// Risk 1: the buyer can cancel after the goods have shipped and take the full escrow back. The seller has no claim.
    function testBuyerCanCancelAfterShipmentAndSellerGetsNothing() public {
        uint256 id = fund(inspector, 100, 4000);
        // goods are on the ship; no arrival report yet
        vm.prank(owner); esc.closeTrade(id);
        require(token.balanceOf(seller) == 0, "seller was protected");
        require(token.balanceOf(owner) == 10_000_000 * Y, "buyer got everything back");
    }

    /// Risk 2: the buyer picks the inspector. A friendly inspector under-reports and the seller is paid less.
    function testBuyerChosenInspectorCanUnderReport() public {
        uint256 id = fund(friendlyInspector, 100, 4000);
        uint256[] memory q = new uint256[](1); q[0] = 50; // all 100 arrived; inspector says 50
        vm.prank(friendlyInspector); esc.confirmArrival(id, q);
        vm.prank(owner); esc.releaseByOwner(id);
        vm.prank(owner); esc.closeTrade(id);
        require(token.balanceOf(seller) == 200_000 * Y, "seller was paid in full");
        logUint("seller shortchanged (yuan)", 200_000);
    }

    /// Risk 3: a buyer and a friendly seller can cycle small trades to inflate the credit index and working-capital line.
    function testWashTradingInflatesCreditSignal() public {
        uint256 start = reg.creditIndex(payAgent);
        for (uint256 i = 0; i < 17; i++) {
            uint256 id = fund(inspector, 1, 50_000);
            vm.prank(docAgent); esc.recordDocumentCheck(id, bytes32(i), false, 0);
            uint256[] memory q = new uint256[](1); q[0] = 1;
            vm.prank(inspector); esc.confirmArrival(id, q);
            vm.prank(payAgent); esc.requestPayment(id, seller, 50_000 * Y);
            vm.prank(payAgent); esc.closeTrade(id);
            vm.warp(block.timestamp + 1 days);
        }
        logUint("credit index before", start);
        logUint("credit index after 17 tiny round trips", reg.creditIndex(payAgent));
        logUint("working-capital line (yuan)", reg.workingCapitalLine(payAgent) / Y);
        logUint("alone-limit (yuan)", reg.aloneLimit(payAgent) / Y);
        require(reg.creditIndex(payAgent) == 100, "credit not maxed");
    }
}
