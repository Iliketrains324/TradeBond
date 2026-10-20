// SPDX-License-Identifier: MIT
pragma solidity ^0.8.11;

import {vm, logUint} from "./Cheats.sol";
import {MockCNY} from "../src/MockCNY.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {TradeEscrow} from "../src/TradeEscrow.sol";

/// Stress test: random sequences of actions by every role (including an attacker and a fooled payment agent).
/// After every single step, the money-safety properties must still hold.
contract StressTest {
    MockCNY token;
    AgentRegistry reg;
    TradeEscrow esc;
    address owner = address(0xB0B);
    address operator = address(0x0FE);
    address payAgent = address(0xA1);
    address docAgent = address(0xA2);
    address negotiator = address(0xA3);
    address seller = address(0x5E11);
    address inspector = address(0x1A5);
    address attacker = address(0xBAD);
    uint256 constant Y = 1e18;
    uint256 minted;
    uint256 sellerExpected; // sum of every release the escrow reported
    uint256 public blockedAttempts;
    uint256 public paidAlone;
    uint256 public sentToOwner;
    mapping(uint256 => uint256) public agentSpentOnDay; // only payments the agent started (alone, or approved by the owner)
    uint256 public ownerDirectPaid;

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockCNY();
        reg = new AgentRegistry(address(token));
        esc = new TradeEscrow(address(token), address(reg));
        reg.setEscrow(address(esc));
        reg.setKyc(owner, true);
        reg.setKyc(seller, true);
        reg.setKyc(operator, true);
        token.mint(owner, 100_000_000 * Y);
        token.mint(operator, 10_000_000 * Y);
        minted = 110_000_000 * Y;
        vm.startPrank(owner);
        token.approve(address(esc), type(uint256).max);
        reg.registerAgent(payAgent, operator, AgentRegistry.Mandate(800_000 * Y, 1_600_000 * Y, 100_000 * Y, 5));
        reg.setPayee(payAgent, seller, true);
        vm.stopPrank();
        vm.startPrank(operator);
        token.approve(address(reg), type(uint256).max);
        reg.topUpBond(payAgent, 50_000 * Y);
        vm.stopPrank();
    }

    function r(uint256 seed, uint256 i, uint256 mod) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, i))) % mod;
    }

    function fundRandom(uint256 seed, uint256 i) internal {
        uint256 n = 1 + r(seed, i * 7 + 1, 3);
        TradeEscrow.Line[] memory l = new TradeEscrow.Line[](n);
        for (uint256 k = 0; k < n; k++) l[k] = TradeEscrow.Line(bytes32(k), 1 + r(seed, i * 7 + 2 + k, 150), (100 + r(seed, i * 7 + 5 + k, 6000)) * Y);
        vm.prank(owner);
        try esc.fundTrade(TradeEscrow.Parties(payAgent, docAgent, negotiator, seller, inspector), bytes32(i), bytes32(0), l, false) {} catch {}
    }

    function step(uint256 seed, uint256 i) internal {
        uint256 n = esc.tradeCount();
        uint256 id = n == 0 ? 1 : 1 + r(seed, i * 13, n);
        uint256 op = r(seed, i * 13 + 1, 16);
        if (n == 0 || op == 0) { fundRandom(seed, i); return; }
        if (op == 1) { vm.prank(docAgent); try esc.recordDocumentCheck(id, bytes32(i), r(seed, i, 2) == 0, 1) {} catch {} return; }
        if (op == 2) {
            uint256 lines = esc.getLines(id).length;
            uint256[] memory q = new uint256[](lines);
            for (uint256 k = 0; k < lines; k++) q[k] = r(seed, i * 13 + 20 + k, 200); // can be more than ordered
            vm.prank(inspector); try esc.confirmArrival(id, q) {} catch {}
            return;
        }
        if (op <= 7) {
            // the payment agent, fooled or not: random payee and random amount
            address[4] memory who = [seller, attacker, owner, docAgent];
            address payee = who[r(seed, i * 13 + 3, 4)];
            uint256 kind = r(seed, i * 13 + 4, 4);
            uint256 amt;
            TradeEscrow.Trade memory t = esc.tradeInfo(id);
            if (kind == 0) amt = t.payableAmount > t.released ? t.payableAmount - t.released : 1 * Y; // exactly what's due
            else if (kind == 1) amt = (1 + r(seed, i * 13 + 5, 99_999)) * Y; // under the approval line
            else if (kind == 2) amt = (1 + r(seed, i * 13 + 5, 3_000_000)) * Y; // anything
            else amt = 1 + r(seed, i * 13 + 5, 1e24); // raw units
            uint256 before = token.balanceOf(payee);
            vm.prank(payAgent);
            try esc.requestPayment(id, payee, amt) returns (uint8 tier, uint8) {
                if (tier == 3) blockedAttempts++;
                if (tier == 1) { paidAlone++; sellerExpected += token.balanceOf(payee) - before; agentSpentOnDay[reg.today()] += amt; }
                if (tier == 2) sentToOwner++;
            } catch {}
            return;
        }
        if (op == 8) { // the owner approves the latest open request
            uint256 rc = esc.requestCount();
            if (rc == 0) return;
            uint256 b = token.balanceOf(seller);
            vm.prank(owner); try esc.approve(rc) {} catch {}
            sellerExpected += token.balanceOf(seller) - b;
            agentSpentOnDay[reg.today()] += token.balanceOf(seller) - b;
            return;
        }
        if (op == 9) { vm.prank(owner); try esc.closeTrade(id) {} catch {} return; }
        if (op == 10) { // the owner pays the seller directly
            uint256 b = token.balanceOf(seller);
            vm.prank(owner); try esc.releaseByOwner(id) {} catch {}
            sellerExpected += token.balanceOf(seller) - b;
            ownerDirectPaid += token.balanceOf(seller) - b;
            return;
        }
        if (op == 11) { // attacker tries every privileged door
            vm.startPrank(attacker);
            try esc.requestPayment(id, attacker, 1000 * Y) {} catch {}
            try esc.approve(esc.requestCount()) {} catch {}
            try esc.releaseByOwner(id) {} catch {}
            try esc.closeTrade(id) {} catch {}
            try reg.setPayee(payAgent, attacker, true) {} catch {}
            try reg.setMandate(payAgent, AgentRegistry.Mandate(1e30, 1e30, 1e30, 1000)) {} catch {}
            try reg.clearHold(payAgent) {} catch {}
            try reg.payClaim(payAgent, 1e24) {} catch {}
            vm.stopPrank();
            return;
        }
        if (op == 12) { // the fooled payment agent tries to raise its own limits / add a payee
            vm.startPrank(payAgent);
            try reg.setMandate(payAgent, AgentRegistry.Mandate(1e30, 1e30, 1e30, 1000)) {} catch {}
            try reg.setPayee(payAgent, attacker, true) {} catch {}
            try esc.approve(esc.requestCount()) {} catch {}
            vm.stopPrank();
            return;
        }
        if (op == 13) { reg.clearHold(payAgent); vm.prank(operator); try reg.topUpBond(payAgent, 60_000 * Y) {} catch {} return; }
        if (op == 14) { vm.warp(block.timestamp + 1 days); return; }
        vm.prank(negotiator); try esc.recordAgreement(id, 1, bytes32(i)) {} catch {}
    }

    function checkInvariants() internal view {
        require(token.balanceOf(attacker) == 0, "attacker received money");
        require(token.balanceOf(docAgent) == 0 && token.balanceOf(payAgent) == 0 && token.balanceOf(negotiator) == 0, "an agent received money");
        uint256 open;
        uint256 released;
        for (uint256 id = 1; id <= esc.tradeCount(); id++) {
            TradeEscrow.Trade memory t = esc.tradeInfo(id);
            require(t.released <= t.funded, "paid more than funded");
            if (!t.arrived) require(t.released == 0, "paid before arrival");
            else require(t.released <= t.payableAmount, "paid more than the inspector verified");
            if (!t.closed) open += t.funded - t.released;
            released += t.released;
        }
        require(token.balanceOf(address(esc)) == open, "escrow balance does not match open trades");
        require(token.balanceOf(seller) == released, "seller balance does not match releases");
        (uint256 bond, , , , , , , ) = reg.agentInfo(payAgent);
        require(token.balanceOf(address(reg)) == bond + reg.protectionFund(), "registry holds more or less than bond + fund");
        uint256 total = token.balanceOf(owner) + token.balanceOf(seller) + token.balanceOf(address(esc)) + token.balanceOf(address(reg)) + token.balanceOf(operator);
        require(total == minted, "money created or destroyed");
        require(agentSpentOnDay[reg.today()] <= 1_600_000 * Y, "agent broke the daily cap");
        AgentRegistry.Mandate memory m = reg.mandateOf(payAgent);
        require(m.maxPerPayment == 800_000 * Y && m.maxPerDay == 1_600_000 * Y, "mandate changed by someone other than the owner");
        require(!reg.approvedPayee(payAgent, attacker), "attacker became an approved payee");
    }

    /// Forge feeds a fresh random seed to every run.
    function testFuzz_RandomSequencesKeepMoneySafe(uint256 seed) public {
        for (uint256 i = 0; i < 60; i++) {
            step(seed, i);
            checkInvariants();
        }
    }

    /// One long run: 600 random actions in a row.
    function testLongRun600Actions() public {
        for (uint256 i = 0; i < 600; i++) {
            step(424242, i);
            checkInvariants();
        }
        logUint("trades", esc.tradeCount());
        logUint("blocked (tier 3)", blockedAttempts);
        logUint("paid alone (tier 1)", paidAlone);
        logUint("sent to owner (tier 2)", sentToOwner);
        logUint("owner paid directly (yuan)", ownerDirectPaid / Y);
        (uint256 bond, uint256 req, , , uint32 v, , , bool held) = reg.agentInfo(payAgent);
        logUint("violations", v); logUint("bond", bond / Y); logUint("required bond", req / Y); logUint("held", held ? 1 : 0);
        logUint("protection fund", reg.protectionFund() / Y);
    }
}

contract OwnerPaymentSideEffect {
}
