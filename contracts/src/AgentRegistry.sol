// SPDX-License-Identifier: MIT
pragma solidity ^0.8.11;

interface IToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// TradeBond agent registry: every payment agent, its owner's rules (the mandate), its bond and its record.
/// The owner sets the rules; a separate bond operator (the agent's provider) posts the bond.
/// A broken rule costs the operator a fine from that bond into a shared protection fund (never to the owner, so nobody
/// gains from attacking their own agent), and holds the agents until the regulator reviews the case. The fund pays
/// only proven losses, and only when the regulator decides: the faulty agent's bond first, then the fund, up to a cap.
/// The rules here are the same ones the TradeBond app shows, so the app and the chain always agree:
///   - required bond = 6.25% of the per-payment limit, minus 5% per clean trade (at most 50% off),
///     plus 50% per broken rule; below it, the agent is locked
///   - trust level from the clean streak: Probation (1x bond), Standard after 5 (2x), Trusted after 20 (4x);
///     the agent may pay alone up to min(approval line, level x bond) a day, and at most maxAutoPayments times a day
///   - credit index = 50 + 3 per clean trade - 10 per broken rule (0..100); working-capital line = 20% settled cleanly
/// DEMO CODE: test token, simulated KYC and sanctions lists, NOT audited.
contract AgentRegistry {
    struct Mandate {
        uint256 maxPerPayment;
        uint256 maxPerDay;
        uint256 confirmAbove; // the owner approves anything above this
        uint32 maxAutoPayments; // payments the agent may make alone per day
    }

    struct Agent {
        address owner;
        address operator; // the agent's provider: posts the bond, and a penalty is paid out of it
        uint256 bond;
        uint256 cleanSettled; // value settled in clean trades
        uint32 clean;
        uint32 streak; // clean trades since the last broken rule
        uint32 violations;
        bool active;
        bool paused; // by the owner
        bool suspended; // by the regulator
        bool held; // after a blocked attempt: no agent may act until the regulator clears the review
        Mandate mandate;
    }

    // Reason codes for a decision. Tier 0: nothing happens and nobody is penalised.
    uint8 public constant OK = 0;
    uint8 public constant SUSPENDED = 1;
    uint8 public constant PAUSED = 2;
    uint8 public constant LOCKED = 3;
    uint8 public constant HELD_FOR_REVIEW = 4;
    uint8 public constant NOT_REGISTERED = 9;
    uint8 public constant SANCTIONED = 10;
    uint8 public constant PAYEE_NOT_APPROVED = 11;
    uint8 public constant OVER_PER_PAYMENT = 12;
    uint8 public constant OVER_DAILY = 13;
    uint8 public constant ABOVE_APPROVAL_LINE = 20;
    uint8 public constant AUTO_COUNT_USED = 21;
    uint8 public constant ALONE_LIMIT_USED = 22;

    IToken public immutable token;
    address public immutable complianceOfficer; // the regulator: KYC, sanctions, suspensions
    address public escrow;
    uint256 public protectionFund; // fines from every operator; pays proven losses only
    uint16 public fineBps = 500; // fine for a blocked attempt: 5% of the bond
    uint256 public claimCap = 500_000 * 1e18; // the most one proven-loss claim can pay (like deposit insurance)

    mapping(address => Agent) internal agents;
    mapping(address => mapping(address => bool)) public approvedPayee;
    mapping(address => mapping(uint256 => uint256)) public spentOnDay;
    mapping(address => mapping(uint256 => uint256)) public aloneOnDay;
    mapping(address => mapping(uint256 => uint32)) public aloneCountOnDay;
    mapping(address => bool) public kycVerified;
    mapping(address => bool) public sanctioned;

    event AgentRegistered(address indexed agent, address owner, address operator);
    event MandateSet(address indexed agent, uint256 maxPerPayment, uint256 maxPerDay, uint256 confirmAbove, uint32 maxAutoPayments);
    event PayeeApproved(address indexed agent, address payee, bool approved);
    event AgentUpdated(address indexed agent, uint32 clean, uint32 streak, uint32 violations, uint256 requiredBond);
    event AgentFined(address indexed agent, uint256 amount, uint256 fundBalance);
    event HoldSet(address indexed agent, bool held, address by);
    event ClaimPaid(address indexed agent, address claimant, uint256 fromBond, uint256 fromFund);
    event FundSettings(uint16 fineBps, uint256 claimCap);
    event BondToppedUp(address indexed agent, address from, uint256 amount, uint256 newBond);
    event PausedSet(address indexed agent, bool paused);
    event SuspendedSet(address indexed agent, bool suspended);
    event KycSet(address indexed who, bool verified);
    event SanctionsSet(address indexed who, bool listed);

    modifier onlyEscrow() {
        require(msg.sender == escrow, "escrow only");
        _;
    }

    modifier onlyCompliance() {
        require(msg.sender == complianceOfficer, "regulator only");
        _;
    }

    modifier onlyOwnerOf(address agent) {
        require(msg.sender == agents[agent].owner, "owner only");
        _;
    }

    constructor(address _token) {
        token = IToken(_token);
        complianceOfficer = msg.sender;
    }

    function setEscrow(address _escrow) external onlyCompliance {
        require(escrow == address(0), "escrow already set");
        escrow = _escrow;
    }

    // ---- regulator ----
    function setKyc(address who, bool verified) external onlyCompliance {
        kycVerified[who] = verified;
        emit KycSet(who, verified);
    }

    function setSanctioned(address who, bool listed) external onlyCompliance {
        sanctioned[who] = listed;
        emit SanctionsSet(who, listed);
    }

    function setSuspended(address agent, bool on) external onlyCompliance {
        agents[agent].suspended = on;
        emit SuspendedSet(agent, on);
    }

    /// Only the regulator lifts a hold, after reviewing the case.
    function clearHold(address agent) external onlyCompliance {
        agents[agent].held = false;
        emit HoldSet(agent, false, msg.sender);
    }

    function setFundSettings(uint16 _fineBps, uint256 _claimCap) external onlyCompliance {
        require(_fineBps <= 2000, "fine at most 20%");
        fineBps = _fineBps;
        claimCap = _claimCap;
        emit FundSettings(_fineBps, _claimCap);
    }

    /// A proven loss is paid back to the agent's owner: from that agent's bond first, then from the shared fund.
    function payClaim(address agent, uint256 loss) external onlyCompliance returns (uint256 fromBond, uint256 fromFund) {
        Agent storage a = agents[agent];
        require(a.active, "not registered");
        require(loss > 0 && loss <= claimCap, "claim is zero or above the cap");
        fromBond = loss < a.bond ? loss : a.bond;
        a.bond -= fromBond;
        uint256 rest = loss - fromBond;
        require(rest <= protectionFund, "the fund cannot cover this claim");
        fromFund = rest;
        protectionFund -= fromFund;
        require(token.transfer(a.owner, loss), "claim transfer failed");
        emit ClaimPaid(agent, a.owner, fromBond, fromFund);
    }

    // ---- owner ----
    /// The owner registers its agent, sets the rules and names the bond operator. The agent stays locked
    /// until the operator posts the bond with topUpBond.
    function registerAgent(address agent, address operator, Mandate calldata m) external {
        require(kycVerified[msg.sender], "owner not KYC verified");
        require(kycVerified[operator], "operator not KYC verified");
        require(operator != msg.sender && operator != agent, "the bond operator must be a separate party");
        require(!agents[agent].active, "already registered");
        _checkMandate(m);
        Agent storage a = agents[agent];
        a.owner = msg.sender;
        a.operator = operator;
        a.active = true;
        a.mandate = m;
        emit AgentRegistered(agent, msg.sender, operator);
        emit MandateSet(agent, m.maxPerPayment, m.maxPerDay, m.confirmAbove, m.maxAutoPayments);
    }

    /// Only the owner can change the rules. The agent itself cannot raise its own limits.
    function setMandate(address agent, Mandate calldata m) external onlyOwnerOf(agent) {
        _checkMandate(m);
        agents[agent].mandate = m;
        emit MandateSet(agent, m.maxPerPayment, m.maxPerDay, m.confirmAbove, m.maxAutoPayments);
    }

    function _checkMandate(Mandate calldata m) internal pure {
        require(m.maxPerPayment > 0 && m.maxPerPayment <= m.maxPerDay, "per payment must be > 0 and <= per day");
        require(m.confirmAbove <= m.maxPerPayment, "approval line must be <= per payment");
        require(m.maxAutoPayments <= 50, "at most 50 payments alone a day");
    }

    /// The owner (its wallet app) can hold its own agents at once, for example after a refused call; only the regulator lifts it.
    function holdForReview(address agent) external onlyOwnerOf(agent) {
        agents[agent].held = true;
        emit HoldSet(agent, true, msg.sender);
    }

    function isHeld(address agent) external view returns (bool) {
        return agents[agent].held;
    }

    function setPaused(address agent, bool on) external onlyOwnerOf(agent) {
        agents[agent].paused = on;
        emit PausedSet(agent, on);
    }

    function setPayee(address agent, address payee, bool approved) external onlyOwnerOf(agent) {
        if (approved) {
            require(kycVerified[payee], "payee not KYC verified");
            require(!sanctioned[payee], "payee is sanctioned");
        }
        approvedPayee[agent][payee] = approved;
        emit PayeeApproved(agent, payee, approved);
    }

    // ---- bond operator ----
    /// Only the bond operator posts or adds to the bond; nobody can take it out.
    function topUpBond(address agent, uint256 amount) external {
        Agent storage a = agents[agent];
        require(a.active, "not registered");
        require(msg.sender == a.operator, "bond operator only");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        a.bond += amount;
        emit BondToppedUp(agent, msg.sender, amount, a.bond);
    }

    // ---- the rules ----
    function today() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function requiredBond(address agent) public view returns (uint256) {
        Agent storage a = agents[agent];
        uint256 base = (a.mandate.maxPerPayment * 625) / 10000;
        uint256 disc = a.clean * 5 > 50 ? 50 : uint256(a.clean) * 5;
        return (((base * (100 - disc)) / 100) * (100 + uint256(a.violations) * 50)) / 100;
    }

    function isLocked(address agent) public view returns (bool) {
        return agents[agent].bond < requiredBond(agent);
    }

    function trustMultiple(address agent) public view returns (uint256) {
        uint32 s = agents[agent].streak;
        return s >= 20 ? 4 : s >= 5 ? 2 : 1;
    }

    function aloneLimit(address agent) public view returns (uint256) {
        Agent storage a = agents[agent];
        uint256 byBond = trustMultiple(agent) * a.bond;
        return byBond < a.mandate.confirmAbove ? byBond : a.mandate.confirmAbove;
    }

    function creditIndex(address agent) public view returns (uint256) {
        Agent storage a = agents[agent];
        int256 s = 50 + int256(uint256(a.clean)) * 3 - int256(uint256(a.violations)) * 10;
        if (s < 0) s = 0;
        if (s > 100) s = 100;
        return uint256(s);
    }

    function workingCapitalLine(address agent) external view returns (uint256) {
        return (agents[agent].cleanSettled * 20) / 100;
    }

    /// Status, payee and hard limits. Returns (tier, reason). Tier 1 means "passes these checks".
    function limitCheck(address agent, address payee, uint256 amount) public view returns (uint8, uint8) {
        Agent storage a = agents[agent];
        if (!a.active) return (3, NOT_REGISTERED);
        if (a.suspended) return (0, SUSPENDED);
        if (a.held) return (0, HELD_FOR_REVIEW);
        if (isLocked(agent)) return (0, LOCKED);
        if (a.paused) return (0, PAUSED);
        if (sanctioned[payee]) return (3, SANCTIONED);
        if (!approvedPayee[agent][payee]) return (3, PAYEE_NOT_APPROVED);
        if (amount > a.mandate.maxPerPayment) return (3, OVER_PER_PAYMENT);
        if (spentOnDay[agent][today()] + amount > a.mandate.maxPerDay) return (3, OVER_DAILY);
        return (1, OK);
    }

    /// May the agent pay this alone? Tier 2 means the owner must approve.
    function autonomyCheck(address agent, uint256 amount) public view returns (uint8, uint8) {
        Agent storage a = agents[agent];
        uint256 d = today();
        if (amount > a.mandate.confirmAbove) return (2, ABOVE_APPROVAL_LINE);
        if (aloneCountOnDay[agent][d] >= a.mandate.maxAutoPayments) return (2, AUTO_COUNT_USED);
        if (aloneOnDay[agent][d] + amount > aloneLimit(agent)) return (2, ALONE_LIMIT_USED);
        return (1, OK);
    }

    // ---- called by the escrow contract only ----
    function recordSpend(address agent, uint256 amount, bool alone) external onlyEscrow {
        uint256 d = today();
        spentOnDay[agent][d] += amount;
        if (alone) {
            aloneOnDay[agent][d] += amount;
            aloneCountOnDay[agent][d] += 1;
        }
    }

    function recordClean(address agent, uint256 settled) external onlyEscrow {
        Agent storage a = agents[agent];
        a.clean += 1;
        a.streak += 1;
        a.cleanSettled += settled;
        emit AgentUpdated(agent, a.clean, a.streak, a.violations, requiredBond(agent));
    }

    /// A blocked attempt: a fine from the bond into the protection fund, and every agent held for review.
    function fine(address agent) external onlyEscrow returns (uint256 amount) {
        Agent storage a = agents[agent];
        amount = (a.bond * fineBps) / 10000;
        a.bond -= amount;
        protectionFund += amount;
        a.violations += 1;
        a.streak = 0;
        a.held = true;
        emit AgentFined(agent, amount, protectionFund);
        emit HoldSet(agent, true, msg.sender);
        emit AgentUpdated(agent, a.clean, a.streak, a.violations, requiredBond(agent));
    }

    // ---- read helpers ----
    function ownerOf(address agent) external view returns (address) {
        return agents[agent].owner;
    }

    function operatorOf(address agent) external view returns (address) {
        return agents[agent].operator;
    }

    function mandateOf(address agent) external view returns (Mandate memory) {
        return agents[agent].mandate;
    }

    function agentInfo(address agent)
        external
        view
        returns (uint256 bond, uint256 required, uint32 clean, uint32 streak, uint32 violations, bool paused, bool suspended, bool held)
    {
        Agent storage a = agents[agent];
        return (a.bond, requiredBond(agent), a.clean, a.streak, a.violations, a.paused, a.suspended, a.held);
    }
}
