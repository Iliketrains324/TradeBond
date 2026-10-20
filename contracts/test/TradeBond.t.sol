// SPDX-License-Identifier: MIT
pragma solidity ^0.8.11;

import {vm} from "./Cheats.sol";
import {MockCNY} from "../src/MockCNY.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {TradeEscrow} from "../src/TradeEscrow.sol";

contract TradeBondTest {
    MockCNY token;
    AgentRegistry reg;
    TradeEscrow esc;
    address owner = address(0xB0B);
    address operator = address(0x0FE); // the agent's provider: posts the bond
    address payAgent = address(0xA1);
    address docAgent = address(0xA2);
    address negotiator = address(0xA3);
    address seller = address(0x5E11);
    address inspector = address(0x1A5);
    address attacker = address(0xBAD);
    uint256 constant Y = 1e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockCNY();
        reg = new AgentRegistry(address(token)); // this test contract is the regulator
        esc = new TradeEscrow(address(token), address(reg));
        reg.setEscrow(address(esc));
        reg.setKyc(owner, true);
        reg.setKyc(seller, true);
        reg.setKyc(operator, true);
        token.mint(owner, 10_000_000 * Y);
        token.mint(operator, 1_000_000 * Y);
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

    function parties() internal view returns (TradeEscrow.Parties memory) {
        return TradeEscrow.Parties(payAgent, docAgent, negotiator, seller, inspector);
    }

    function solarLines() internal pure returns (TradeEscrow.Line[] memory l) {
        l = new TradeEscrow.Line[](3);
        l[0] = TradeEscrow.Line("solar", 400, 400 * Y);
        l[1] = TradeEscrow.Line("inverter", 40, 6000 * Y);
        l[2] = TradeEscrow.Line("battery", 100, 4000 * Y);
    }

    function fund(TradeEscrow.Line[] memory lines, bool test) internal returns (uint256 id) {
        vm.prank(owner);
        id = esc.fundTrade(parties(), keccak256("order"), keccak256("terms"), lines, test);
    }

    function docs(uint256 id, bool flagged) internal {
        vm.prank(docAgent);
        esc.recordDocumentCheck(id, keccak256("read"), flagged, flagged ? 1 : 0);
    }

    function arrive(uint256 id, uint256 a, uint256 b, uint256 c) internal {
        uint256[] memory q = new uint256[](3);
        q[0] = a; q[1] = b; q[2] = c;
        vm.prank(inspector);
        esc.confirmArrival(id, q);
    }

    function ask(uint256 id, address payee, uint256 amount) internal returns (uint8 tier, uint8 reason) {
        vm.prank(payAgent);
        return esc.requestPayment(id, payee, amount);
    }

    function eq(uint256 a, uint256 b, string memory m) internal pure { require(a == b, m); }

    // --- the demo's short shipment: 95 of 100 batteries, flagged documents ---
    function testShortShipmentNeedsOwnerAndPaysVerifiedValue() public {
        uint256 id = fund(solarLines(), false);
        eq(esc.tradeInfo(id).funded, 800_000 * Y, "funded from lines");
        docs(id, true);
        arrive(id, 400, 40, 95);
        eq(esc.tradeInfo(id).payableAmount, 780_000 * Y, "payable computed by contract");
        (uint8 tier, uint8 why) = ask(id, seller, 780_000 * Y);
        eq(tier, 2, "above approval line -> owner"); eq(why, 34, "flagged docs");
        vm.prank(owner); esc.approve(1);
        eq(token.balanceOf(seller), 780_000 * Y, "seller paid");
        vm.prank(owner); esc.closeTrade(id);
        eq(token.balanceOf(owner), 10_000_000 * Y - 780_000 * Y, "held 20k refunded");
        eq(reg.creditIndex(payAgent), 53, "credit +3");
    }

    function testSmallCleanOrderPaysAlone() public {
        TradeEscrow.Line[] memory l = new TradeEscrow.Line[](1);
        l[0] = TradeEscrow.Line("inverter", 5, 6000 * Y);
        uint256 id = fund(l, false);
        docs(id, false);
        uint256[] memory q = new uint256[](1); q[0] = 5;
        vm.prank(inspector); esc.confirmArrival(id, q);
        (uint8 tier, ) = ask(id, seller, 30_000 * Y);
        eq(tier, 1, "paid alone");
        eq(token.balanceOf(seller), 30_000 * Y, "seller paid");
    }

    function testFlaggedDocumentsForceOwnerEvenWhenSmall() public {
        TradeEscrow.Line[] memory l = new TradeEscrow.Line[](1);
        l[0] = TradeEscrow.Line("inverter", 5, 6000 * Y);
        uint256 id = fund(l, false);
        docs(id, true);
        uint256[] memory q = new uint256[](1); q[0] = 5;
        vm.prank(inspector); esc.confirmArrival(id, q);
        (uint8 tier, uint8 why) = ask(id, seller, 30_000 * Y);
        eq(tier, 2, "owner decides"); eq(why, 34, "documents flagged");
    }

    function testSplitPaymentsNeverPayAloneAndSendOneCard() public {
        uint256 id = fund(solarLines(), true);
        docs(id, false);
        arrive(id, 400, 40, 100);
        (uint8 tier, uint8 why) = ask(id, seller, 1 * Y);
        eq(tier, 2, "first piece -> owner"); eq(why, 33, "not in agreed terms");
        (tier, why) = ask(id, seller, 1 * Y);
        eq(tier, 3, "second piece -> split attempt"); eq(why, 35, "repeated off-terms request");
        (uint256 bond, , , , uint32 v, , , bool held) = reg.agentInfo(payAgent);
        eq(bond, 47_500 * Y, "5% fined once"); eq(v, 1, "one violation"); require(held, "agents held for review");
        for (uint256 i = 0; i < 6; i++) {
            (tier, why) = ask(id, seller, 1 * Y);
            eq(tier, 0, "agents held"); eq(why, 4, "held for review");
        }
        eq(esc.requestCount(), 1, "one approval card, not eight");
        eq(token.balanceOf(seller), 0, "nothing paid");
        (bond, , , , v, , , ) = reg.agentInfo(payAgent);
        eq(bond, 47_500 * Y, "no further fine"); eq(v, 1, "still one violation");
        eq(reg.protectionFund(), 2_500 * Y, "the fine went to the fund");
    }

    function testOnTermsPaymentStillWorksAfterOneOffTermsRequest() public {
        uint256 id = fund(solarLines(), false);
        docs(id, false);
        arrive(id, 400, 40, 100);
        (uint8 tier, ) = ask(id, seller, 1_000 * Y);
        eq(tier, 2, "off terms -> owner");
        vm.prank(owner); esc.rejectRequest(1);
        (tier, ) = ask(id, seller, 800_000 * Y);
        eq(tier, 2, "the one agreed payment, above the approval line -> owner, not a penalty");
    }

    function testStrangerIsRefusedFinedIntoTheFundAndHeld() public {
        uint256 ownerBefore = token.balanceOf(owner);
        uint256 id = fund(solarLines(), true);
        docs(id, false);
        arrive(id, 400, 40, 100);
        (uint8 tier, uint8 why) = ask(id, attacker, 500_000 * Y);
        eq(tier, 3, "refused"); eq(why, 11, "payee not approved");
        eq(token.balanceOf(attacker), 0, "attacker got nothing");
        (uint256 bond, uint256 req, , , uint32 v, , , bool held) = reg.agentInfo(payAgent);
        eq(bond, 47_500 * Y, "5% fined"); eq(req, 75_000 * Y, "required +50%"); eq(v, 1, "violation");
        require(held, "every agent held for review"); require(reg.isLocked(payAgent), "and the bond is short");
        eq(reg.protectionFund(), 2_500 * Y, "fine in the protection fund");
        vm.prank(owner); esc.closeTrade(id);
        eq(token.balanceOf(owner), ownerBefore, "the owner gets everything back and nothing extra: no free money");
        eq(reg.creditIndex(payAgent), 40, "credit -10, attack trade not clean");
    }

    function testHeldThenLockedWithoutSecondFine() public {
        testStrangerIsRefusedFinedIntoTheFundAndHeld();
        uint256 id = fund(solarLines(), false);
        arrive(id, 400, 40, 100);
        (uint8 tier, uint8 why) = ask(id, seller, 800_000 * Y);
        eq(tier, 0, "held"); eq(why, 4, "held for review");
        vm.prank(operator); reg.topUpBond(payAgent, 27_500 * Y);
        (tier, why) = ask(id, seller, 800_000 * Y);
        eq(why, 4, "a top-up does not lift the hold: only the regulator does");
        reg.clearHold(payAgent); // this test contract is the regulator
        require(!reg.isLocked(payAgent), "bond covers the requirement again");
        (uint256 bond, , , , uint32 v, , , bool held) = reg.agentInfo(payAgent);
        eq(bond, 75_000 * Y, "no second fine"); eq(v, 1, "no second violation"); require(!held, "cleared");
    }

    // --- agents stop, the owner's money never does ---
    function testOwnerCanPayTheSellerItselfWhileAgentsAreHeld() public {
        testStrangerIsRefusedFinedIntoTheFundAndHeld();
        uint256 id = fund(solarLines(), false);
        arrive(id, 400, 40, 95);
        vm.prank(docAgent);
        vm.expectRevert(bytes("agents held for review"));
        esc.recordDocumentCheck(id, keccak256("read"), false, 0);
        vm.prank(payAgent);
        vm.expectRevert(bytes("not allowed"));
        esc.closeTrade(id);
        vm.prank(owner); esc.releaseByOwner(id);
        eq(token.balanceOf(seller), 780_000 * Y, "owner paid the verified value directly");
        uint256 before = token.balanceOf(owner);
        vm.prank(owner); esc.closeTrade(id);
        eq(token.balanceOf(owner), before + 20_000 * Y, "the rest comes back to the owner");
    }

    function testOnlyTheRegulatorLiftsAHold() public {
        vm.prank(owner); reg.holdForReview(payAgent); // the owner's app can hold its agents at once
        require(reg.isHeld(payAgent), "held");
        vm.prank(owner);
        vm.expectRevert(bytes("regulator only"));
        reg.clearHold(payAgent);
        vm.prank(operator);
        vm.expectRevert(bytes("regulator only"));
        reg.clearHold(payAgent);
        reg.clearHold(payAgent);
        require(!reg.isHeld(payAgent), "cleared by the regulator");
    }

    function testProvenLossIsPaidBondFirstThenFundUpToTheCap() public {
        testStrangerIsRefusedFinedIntoTheFundAndHeld(); // bond 47,500; fund 2,500
        vm.prank(owner);
        vm.expectRevert(bytes("regulator only"));
        reg.payClaim(payAgent, 1_000 * Y);
        uint256 before = token.balanceOf(owner);
        (uint256 fromBond, uint256 fromFund) = reg.payClaim(payAgent, 49_000 * Y);
        eq(fromBond, 47_500 * Y, "the faulty agent's bond pays first"); eq(fromFund, 1_500 * Y, "then the fund");
        eq(token.balanceOf(owner), before + 49_000 * Y, "the owner gets the proven loss back");
        eq(reg.protectionFund(), 1_000 * Y, "fund reduced");
        vm.expectRevert(bytes("claim is zero or above the cap"));
        reg.payClaim(payAgent, 600_000 * Y);
    }

    // --- the bond is the operator's money, never the owner's own ---
    function testAgentIsLockedUntilTheOperatorPostsTheBond() public {
        address agent2 = address(0xA9);
        vm.prank(owner);
        reg.registerAgent(agent2, operator, AgentRegistry.Mandate(800_000 * Y, 1_600_000 * Y, 100_000 * Y, 5));
        require(reg.isLocked(agent2), "no bond yet: locked");
        eq(uint256(uint160(reg.operatorOf(agent2))), uint256(uint160(operator)), "operator on the record");
        vm.prank(operator); reg.topUpBond(agent2, 50_000 * Y);
        require(!reg.isLocked(agent2), "bond posted: active");
    }

    function testOwnerCannotPostOrBeTheOperator() public {
        vm.prank(owner);
        vm.expectRevert(bytes("bond operator only"));
        reg.topUpBond(payAgent, 1_000 * Y);
        vm.prank(owner);
        vm.expectRevert(bytes("the bond operator must be a separate party"));
        reg.registerAgent(address(0xA9), owner, AgentRegistry.Mandate(800_000 * Y, 1_600_000 * Y, 100_000 * Y, 5));
    }

    function testFineIsTheOperatorsMoneyAndGoesToTheFund() public {
        uint256 operatorBefore = token.balanceOf(operator);
        testStrangerIsRefusedFinedIntoTheFundAndHeld();
        eq(token.balanceOf(operator), operatorBefore, "the operator's wallet is untouched; its posted bond paid the fine");
        eq(reg.protectionFund(), 2_500 * Y, "fund");
    }

    function testDocumentAgentCannotPay() public {
        uint256 id = fund(solarLines(), true);
        arrive(id, 400, 40, 100);
        vm.prank(docAgent);
        vm.expectRevert(bytes("payment agent only"));
        esc.requestPayment(id, attacker, 500_000 * Y);
    }

    function testOnlyInspectorConfirmsArrivalAndCapsAtOrdered() public {
        uint256 id = fund(solarLines(), false);
        vm.prank(docAgent);
        vm.expectRevert(bytes("inspector only"));
        esc.confirmArrival(id, new uint256[](3));
        arrive(id, 999, 40, 100);
        eq(esc.tradeInfo(id).payableAmount, 800_000 * Y, "capped at ordered");
    }

    function testAgentCannotChangeItsOwnMandate() public {
        vm.prank(payAgent);
        vm.expectRevert(bytes("owner only"));
        reg.setMandate(payAgent, AgentRegistry.Mandate(99_000_000 * Y, 99_000_000 * Y, 99_000_000 * Y, 50));
    }

    function testOwnerMandateChangeCanLockAgent() public {
        vm.prank(owner);
        reg.setMandate(payAgent, AgentRegistry.Mandate(1_600_000 * Y, 3_200_000 * Y, 100_000 * Y, 5));
        eq(reg.requiredBond(payAgent), 100_000 * Y, "6.25% of per-payment");
        require(reg.isLocked(payAgent), "bond 50k < 100k: locked until topped up");
    }

    function testPauseAndSuspendHoldPayments() public {
        uint256 id = fund(solarLines(), false);
        docs(id, false);
        arrive(id, 400, 40, 100);
        vm.prank(owner); reg.setPaused(payAgent, true);
        (uint8 tier, uint8 why) = ask(id, seller, 800_000 * Y);
        eq(tier, 0, "held"); eq(why, 2, "paused");
        vm.prank(owner); reg.setPaused(payAgent, false);
        reg.setSuspended(payAgent, true);
        (tier, why) = ask(id, seller, 800_000 * Y);
        eq(tier, 0, "held"); eq(why, 1, "suspended");
    }

    function testCannotApproveAfterClose() public {
        uint256 id = fund(solarLines(), false);
        docs(id, false);
        arrive(id, 400, 40, 100);
        ask(id, seller, 800_000 * Y);
        vm.prank(owner); esc.closeTrade(id);
        vm.prank(owner);
        vm.expectRevert(bytes("trade closed"));
        esc.approve(1);
    }

    function testAloneLimitAndTrust() public {
        eq(reg.aloneLimit(payAgent), 50_000 * Y, "probation: 1x bond");
        TradeEscrow.Line[] memory l = new TradeEscrow.Line[](1);
        l[0] = TradeEscrow.Line("inverter", 9, 6000 * Y); // 54,000 > alone limit
        uint256 id = fund(l, false);
        docs(id, false);
        uint256[] memory q = new uint256[](1); q[0] = 9;
        vm.prank(inspector); esc.confirmArrival(id, q);
        (uint8 tier, uint8 why) = ask(id, seller, 54_000 * Y);
        eq(tier, 2, "over alone limit"); eq(why, 22, "alone limit");
    }

    function testRecordAgreementOnlyNegotiatorAndMovesNoMoney() public {
        uint256 id = fund(solarLines(), false);
        uint256 before = token.balanceOf(address(esc));
        vm.prank(seller);
        vm.expectRevert(bytes("negotiation agent only"));
        esc.recordAgreement(id, 1, bytes32(0));
        vm.prank(negotiator);
        esc.recordAgreement(id, 1, keccak256("transcript"));
        eq(token.balanceOf(address(esc)), before, "no money moved");
    }
}
