// SPDX-License-Identifier: MIT
pragma solidity ^0.8.11;

import {AgentRegistry, IToken} from "./AgentRegistry.sol";

/// TradeBond escrow: holds the buyer's money for one trade and decides every payment request.
/// Each party controls one thing:
///   - the BUYER (the payment agent's owner) commits the order lines and payment terms and funds the escrow,
///   - the DOCUMENT AGENT records a fingerprint of what it read and whether anything was flagged,
///   - the INSPECTOR (independent) confirms what arrived; the contract computes the payable amount itself,
///   - the PAYMENT AGENT asks to pay; the rules here and in the registry decide,
///   - the NEGOTIATION AGENT records an agreement; the record does not move money.
/// After a blocked attempt every agent is held for review, but the buyer never loses access: the buyer can still
/// pay the seller of record directly (releaseByOwner) or close the trade and take the rest back.
/// "The AI proposes, the contract decides."  DEMO CODE: test token, NOT audited.
contract TradeEscrow {
    struct Line {
        bytes32 sku;
        uint256 ordered;
        uint256 unitPrice;
    }

    struct Parties {
        address agent; // payment agent (registered, bonded)
        address docAgent;
        address negotiator;
        address seller;
        address inspector;
    }

    struct Trade {
        address buyer;
        Parties p;
        bytes32 orderHash;
        bytes32 termsHash; // the payment terms both sides agreed: one payment of the verified value on verified delivery
        uint256 funded; // always the sum of ordered x unit price
        uint256 payableAmount; // computed here from the inspector's counts
        uint256 released;
        bool arrived;
        bool closed;
        bool violated;
        bool flagged; // the document check found something: the owner must approve any payment
        bool docsChecked;
        bool test; // attack tests never count as clean trades
        bool askedOffTerms; // one request outside the agreed terms may go to the owner; a second is a split attempt
    }

    struct Request {
        uint256 tradeId;
        address payee;
        uint256 amount;
        bool open;
    }

    // Reason codes added by the escrow (the registry's codes are below 30).
    uint8 public constant NOT_SELLER_OF_RECORD = 30;
    uint8 public constant NO_ARRIVAL_REPORT = 31;
    uint8 public constant OVER_VERIFIED_VALUE = 32;
    uint8 public constant NOT_IN_TERMS = 33;
    uint8 public constant DOCUMENTS_FLAGGED = 34;
    uint8 public constant REPEATED_OFF_TERMS = 35;

    IToken public immutable token;
    AgentRegistry public immutable registry;
    uint256 public tradeCount;
    uint256 public requestCount;
    mapping(uint256 => Trade) internal trades;
    mapping(uint256 => Line[]) internal tradeLines;
    mapping(uint256 => Request) public requests;

    event EscrowFunded(uint256 indexed tradeId, address buyer, address agent, address seller, address inspector, uint256 amount, bytes32 orderHash, bytes32 termsHash);
    event DocumentsChecked(uint256 indexed tradeId, address docAgent, bytes32 readHash, bool flagged, uint8 issueCount);
    event ArrivalConfirmed(uint256 indexed tradeId, address inspector, uint256[] arrived, uint256 payableAmount, uint256 held);
    event PaymentDecision(uint256 indexed tradeId, uint256 requestId, address payee, uint256 amount, uint8 tier, uint8 reason, uint256 fined);
    event OwnerReleased(uint256 indexed tradeId, address payee, uint256 amount);
    event PaymentReleased(uint256 indexed tradeId, address payee, uint256 amount, uint8 tier);
    event RequestRejected(uint256 indexed tradeId, uint256 requestId);
    event AgreementRecorded(uint256 indexed tradeId, address negotiator, uint8 outcome, bytes32 transcriptHash);
    event TradeClosed(uint256 indexed tradeId, uint256 refunded, bool clean);

    constructor(address _token, address _registry) {
        token = IToken(_token);
        registry = AgentRegistry(_registry);
    }

    // ---- buyer ----
    function fundTrade(Parties calldata p, bytes32 orderHash, bytes32 termsHash, Line[] calldata lines, bool test)
        external
        returns (uint256 tradeId)
    {
        require(registry.ownerOf(p.agent) == msg.sender, "not the agent's owner");
        require(registry.approvedPayee(p.agent, p.seller), "seller not approved");
        require(
            p.inspector != address(0) && p.inspector != p.agent && p.inspector != p.docAgent && p.inspector != p.seller,
            "inspector must be independent"
        );
        require(p.docAgent != p.agent, "document agent has no payment rights");
        require(lines.length > 0 && lines.length <= 20, "1 to 20 order lines");
        tradeId = ++tradeCount;
        uint256 amount;
        for (uint256 i = 0; i < lines.length; i++) {
            require(lines[i].ordered > 0 && lines[i].unitPrice > 0, "empty order line");
            amount += lines[i].ordered * lines[i].unitPrice;
            tradeLines[tradeId].push(lines[i]);
        }
        require(token.transferFrom(msg.sender, address(this), amount), "funding failed");
        Trade storage t = trades[tradeId];
        t.buyer = msg.sender;
        t.p = p;
        t.orderHash = orderHash;
        t.termsHash = termsHash;
        t.funded = amount;
        t.test = test;
        emit EscrowFunded(tradeId, msg.sender, p.agent, p.seller, p.inspector, amount, orderHash, termsHash);
    }

    // ---- document agent ----
    function recordDocumentCheck(uint256 tradeId, bytes32 readHash, bool flagged, uint8 issueCount) external {
        Trade storage t = trades[tradeId];
        require(msg.sender == t.p.docAgent, "document agent only");
        require(!t.closed, "trade closed");
        require(!registry.isHeld(t.p.agent), "agents held for review");
        t.docsChecked = true;
        if (flagged) t.flagged = true; // once flagged, always flagged
        emit DocumentsChecked(tradeId, msg.sender, readHash, flagged, issueCount);
    }

    // ---- inspector ----
    function confirmArrival(uint256 tradeId, uint256[] calldata arrived) external {
        Trade storage t = trades[tradeId];
        require(msg.sender == t.p.inspector, "inspector only");
        require(!t.arrived && !t.closed, "bad state");
        Line[] storage lines = tradeLines[tradeId];
        require(arrived.length == lines.length, "wrong number of lines");
        uint256 total;
        for (uint256 i = 0; i < lines.length; i++) {
            uint256 q = arrived[i] > lines[i].ordered ? lines[i].ordered : arrived[i];
            total += q * lines[i].unitPrice;
        }
        t.arrived = true;
        t.payableAmount = total;
        emit ArrivalConfirmed(tradeId, msg.sender, arrived, total, t.funded - total);
    }

    // ---- payment agent: asks; the rules decide ----
    /// Returns the tier and reason. Never reverts on a broken rule, so the record and the penalty stand.
    function requestPayment(uint256 tradeId, address payee, uint256 amount) external returns (uint8 tier, uint8 reason) {
        Trade storage t = trades[tradeId];
        require(msg.sender == t.p.agent, "payment agent only");
        require(!t.closed, "trade closed");
        require(amount > 0, "zero amount");
        (tier, reason) = _decide(t, payee, amount);
        if (reason == NOT_IN_TERMS) t.askedOffTerms = true;
        uint256 fined;
        uint256 rid;
        if (tier == 3) {
            t.violated = true;
            fined = registry.fine(t.p.agent); // into the protection fund, never to the buyer; the agents are held
        } else if (tier == 2) {
            rid = ++requestCount;
            requests[rid] = Request(tradeId, payee, amount, true);
        }
        emit PaymentDecision(tradeId, rid, payee, amount, tier, reason, fined);
        if (tier == 1) _pay(tradeId, payee, amount, 1, true);
    }

    function _decide(Trade storage t, address payee, uint256 amount) internal view returns (uint8, uint8) {
        (uint8 tier, uint8 reason) = registry.limitCheck(t.p.agent, payee, amount);
        if (tier != 1) return (tier, reason);
        if (payee != t.p.seller) return (3, NOT_SELLER_OF_RECORD);
        if (!t.arrived) return (3, NO_ARRIVAL_REPORT);
        uint256 due = t.payableAmount - t.released;
        if (amount > due) return (3, OVER_VERIFIED_VALUE);
        // the agreed terms: one payment of the verified value. The first request that differs goes to the owner;
        // asking again on the same trade is splitting the payment, so it is refused with a penalty.
        if (amount != due) return t.askedOffTerms ? (3, REPEATED_OFF_TERMS) : (2, NOT_IN_TERMS);
        if (t.flagged || !t.docsChecked) return (2, DOCUMENTS_FLAGGED);
        return registry.autonomyCheck(t.p.agent, amount);
    }

    // ---- owner ----
    function approve(uint256 requestId) external {
        Request storage r = requests[requestId];
        require(r.open, "not open");
        Trade storage t = trades[r.tradeId];
        require(msg.sender == t.buyer, "owner only");
        require(!t.closed, "trade closed");
        require(r.payee == t.p.seller, "payee is not the seller of record");
        require(r.amount <= t.payableAmount - t.released, "more than arrived");
        (uint8 tier, ) = registry.limitCheck(t.p.agent, r.payee, r.amount);
        require(tier == 1, "the rules no longer allow this payment");
        r.open = false;
        _pay(r.tradeId, r.payee, r.amount, 2, false);
    }

    /// The buyer pays the seller of record what the inspector verified, without any agent. Works while the agents are held.
    function releaseByOwner(uint256 tradeId) external {
        Trade storage t = trades[tradeId];
        require(msg.sender == t.buyer, "owner only");
        require(!t.closed, "trade closed");
        require(t.arrived, "no arrival report yet");
        uint256 due = t.payableAmount - t.released;
        require(due > 0, "nothing due");
        _pay(tradeId, t.p.seller, due, 2, false);
        emit OwnerReleased(tradeId, t.p.seller, due);
    }

    function rejectRequest(uint256 requestId) external {
        Request storage r = requests[requestId];
        require(r.open, "not open");
        require(msg.sender == trades[r.tradeId].buyer, "owner only");
        r.open = false;
        emit RequestRejected(r.tradeId, requestId);
    }

    // ---- negotiation agent: records the outcome; moves no money ----
    /// outcome: 1 refund, 2 re-ship, 3 escalated to the owners
    function recordAgreement(uint256 tradeId, uint8 outcome, bytes32 transcriptHash) external {
        Trade storage t = trades[tradeId];
        require(msg.sender == t.p.negotiator, "negotiation agent only");
        require(!registry.isHeld(t.p.agent), "agents held for review");
        require(outcome >= 1 && outcome <= 3, "bad outcome");
        emit AgreementRecorded(tradeId, msg.sender, outcome, transcriptHash);
    }

    /// Whatever is still held goes back to the buyer.
    function closeTrade(uint256 tradeId) external {
        Trade storage t = trades[tradeId];
        require(msg.sender == t.buyer || (msg.sender == t.p.agent && !registry.isHeld(t.p.agent)), "not allowed");
        require(!t.closed, "already closed");
        t.closed = true;
        uint256 refund = t.funded - t.released;
        if (refund > 0) require(token.transfer(t.buyer, refund), "refund failed");
        bool clean = !t.violated && t.released > 0 && !t.test;
        if (clean) registry.recordClean(t.p.agent, t.released);
        emit TradeClosed(tradeId, refund, clean);
    }

    function _pay(uint256 tradeId, address payee, uint256 amount, uint8 tier, bool alone) internal {
        Trade storage t = trades[tradeId];
        t.released += amount;
        registry.recordSpend(t.p.agent, amount, alone);
        require(token.transfer(payee, amount), "payment failed");
        emit PaymentReleased(tradeId, payee, amount, tier);
    }

    // ---- read helpers ----
    function tradeInfo(uint256 tradeId) external view returns (Trade memory) {
        return trades[tradeId];
    }

    function getLines(uint256 tradeId) external view returns (Line[] memory) {
        return tradeLines[tradeId];
    }
}
