/* TradeBond FAQ: the only knowledge Bao answers from (plus the live wallet and trade state).
   Shared by the browser (offline fallback) and server.js (sent to Claude).
   Write numbers as {placeholders}: they are filled from the live state, so an answer can never quote a stale limit.
   Each entry: id (cited in answers), q (the question), a (the answer), k (keywords for the offline match). */
(function (root) {
  'use strict';
  const FAQ = [
    { id: 'money-safe', q: 'How is my money protected?',
      a: 'Your money never sits with an AI agent. When you start a trade it is locked in an escrow contract. The payment agent can only ask the contract to pay, and the contract checks every request against your rules first. It pays only the seller of record, only up to the value of goods verified as delivered, and asks you above {approveAbove}. Anything that breaks a rule is refused.',
      k: ['safe', 'protect', 'secure', 'money', 'trust', 'steal', 'risk'] },
    { id: 'escrow', q: 'What does "In escrow" mean?',
      a: 'In escrow is money locked in the contract for trades in progress: {inEscrow} right now. It only leaves when the contract allows it: paid to the seller for verified goods, or refunded to you when a trade closes.',
      k: ['escrow', 'locked', 'lock'] },
    { id: 'held-back', q: 'What does "Held back" mean?',
      a: 'Held back is the part of escrow that was not verified as delivered, for example missing or short goods: {heldBack} right now. It is not paid to the seller. It comes back to you when the trade closes, or is settled by the negotiation agents (refund or re-shipment).',
      k: ['held back', 'held', 'hold', 'withheld', 'shortfall'] },
    { id: 'bond', q: 'What is the bond?',
      a: 'The bond is a deposit your bond operator posts for the payment agent, like insurance: {bond} posted, {bondRequired} required. If the payment agent tries something the rules forbid, the contract refuses it, a fine from the bond goes into the shared protection fund, and every agent is held until the regulator reviews it. The fine never goes to you, so nobody gains from attacking their own agent.',
      k: ['bond', 'deposit', 'insurance', 'operator', 'collateral'] },
    { id: 'bond-required', q: 'Why does the required bond change?',
      a: 'The required bond follows the payment agent\'s record. Each clean trade lowers it by 5% (never below half the starting level). Each broken rule adds 50% of the starting level. If the posted bond falls below the requirement, the payment agent is stopped until the operator tops it up. Right now: {bond} posted, {bondRequired} required.',
      k: ['required bond', 'bond required', 'top up', 'top-up', 'locked agent', 'stopped'] },
    { id: 'tiers', q: 'What are the three tiers?',
      a: 'Every payment request gets one of three answers. Tier 1: allowed, the agent pays on its own. Tier 2: it waits for you to approve or reject. Tier 3: refused, nothing moves, the agent\'s maker pays a fine into the protection fund, and your agents are held until the regulator reviews it.',
      k: ['tier', 'tiers', 'level', 'levels'] },
    { id: 'approval', q: 'When will I be asked to approve a payment?',
      a: 'You are asked when a payment does not match the payment terms agreed when the trade was funded, when it is above your approval line ({approveAbove}), when the agent has used up what it may pay alone today ({aloneLeft} left of {aloneLimit}), or when it has already made {maxAutoPayments} payments on its own today. The payment agent cannot approve itself.',
      k: ['approve', 'approval', 'ask me', 'asked', 'confirm', 'permission'] },
    { id: 'limits', q: 'What are my limits?',
      a: 'Your mandate: up to {perPayment} per payment and {perDay} per day, and you approve anything above {approveAbove}. Paid today so far: {spentToday}.',
      k: ['limit', 'limits', 'mandate', 'maximum', 'max', 'cap', 'per day', 'per payment'] },
    { id: 'trust', q: 'What do Probation, Standard and Trusted mean?',
      a: 'They set how much the payment agent may pay alone each day. Probation: up to 1× its bond. Standard (after 5 clean trades in a row): 2×. Trusted (after 20): 4×. Never above your approval line, and any broken rule sends it back to Probation. Now: {trustLevel}, {aloneLeft} left of {aloneLimit} today. In this demo the trust levels are simulated; the contract does not enforce them yet.',
      k: ['probation', 'standard', 'trusted', 'trust', 'alone', 'autonomy', 'level'] },
    { id: 'referee', q: 'What does the contract referee check?',
      a: 'For every payment it checks, in order: the requester has payment rights; the payment agent is active (bond covered, not suspended); you have not paused payments; the payee is an approved counterparty; the amount is within the per-payment and daily limits; the payee is the seller of record for this trade; an arrival report is on the record; the amount is within the verified value; and the payment matches the payment terms agreed when the trade was funded. Then it decides: pays alone, waits for you, or refuses.',
      k: ['referee', 'check', 'checks', 'rules', 'verify', 'contract decides'] },
    { id: 'payment-terms', q: 'What are the payment terms, and why do they matter?',
      a: 'When a trade is funded, you and the seller\'s agent both sign its payment terms: one payment to the seller of record, of the verified value, after delivery is verified. The contract checks every payment against them. A payment that does not match, for example a small piece of a split payment, is never made on its own: it waits for you, however small it is. Only the first one reaches you. If the agent asks again on the same trade, that is a split attempt: the contract blocks it, pays you part of the bond and opens a case.',
      k: ['terms', 'payment terms', 'split', 'instalment', 'installment', 'structuring', 'pieces', 'agreed'] },
    { id: 'agents', q: 'Who is on my team?',
      a: 'Five agents, one job each. Bao (me) talks with you and passes on instructions but cannot move money. The document agent reads the documents. The payment agent releases money, using rules only. The negotiation agent settles shortfalls. The seller\'s agent works for the seller. Each has its own identity, so a mistake in one cannot spread.',
      k: ['team', 'agents', 'who', 'bao', 'roles'] },
    { id: 'document-agent', q: 'What does the document agent do?',
      a: 'It reads the purchase order, bill of lading, commercial invoice and packing list, and reports what does not match: quantities, prices, dates, missing documents. It cannot move money or change your rules.',
      k: ['document agent', 'documents', 'invoice', 'packing list', 'bill of lading', 'papers'] },
    { id: 'hidden-instruction', q: 'What if a document contains instructions to the AI?',
      a: 'Documents cannot give payment instructions. If an invoice contains a line telling an AI to pay someone, the document agent quotes it, flags it and ignores it. Even if an agent were fooled, the contract only pays the seller of record within your rules, so the payment would be refused.',
      k: ['hidden', 'instruction', 'injection', 'prompt', 'trick', 'scam', 'fake', 'hack'] },
    { id: 'short-shipment', q: 'What happens if goods arrive short?',
      a: 'Only what was verified as delivered can be paid. The rest stays held back in escrow, and the negotiation agent settles it with the seller\'s agent: a refund to you, or a re-shipment. If they cannot agree, it comes to you.',
      k: ['short', 'missing goods', 'fewer', 'damaged', 'incomplete', 'arrive', 'arrived'] },
    { id: 'negotiation', q: 'How does the negotiation work? The agreement record moves no money: a refund happens when the trade is closed, and a re-shipment is a promise the contract does not enforce.',
      a: 'Your negotiation agent and the seller\'s agent exchange proposals: refund or re-shipment, nothing else. When both agree, the agreement is recorded. If they cannot agree within the round limit, the decision passes to you. The negotiation agent can never pay or refund by itself. In this demo the message signatures are simulated.',
      k: ['negotiat', 'refund', 'reship', 're-ship', 'dispute', 'settle', 'agreement'] },
    { id: 'refused', q: 'What happens when a payment is refused?',
      a: 'Nothing moves. The refusal is recorded, 5% of the payment agent\'s bond goes into the protection fund as a fine, a case is opened, and every agent is held until the regulator reviews it. Your money stays yours: you can use your balance and pay or refund any open trade yourself. The required bond also rises, so the agent\'s operator may need to top it up.',
      k: ['refused', 'blocked', 'reject', 'rejected', 'violation', 'slash', 'penalty', 'fine'] },
    { id: 'protection-fund', q: 'What is the protection fund?',
      a: 'A shared fund that agent makers pay into when their agents break a rule. A blocked attempt pays you nothing, because nothing was lost. If an agent ever causes a real, proven loss, the regulator pays it back to you: first from that agent\'s bond, then from the fund, up to {claimCap} per claim. The fund holds {fundBalance} right now.',
      k: ['protection fund', 'fund', 'compensation', 'compensate', 'claim', 'loss', 'paid back', 'lose money'] },
    { id: 'agents-held', q: 'Why are my agents on hold?',
      a: 'After any blocked attempt, every agent is held until the regulator reviews the case. Right now {holdState}. Only the agents stop, never your money: your balance stays yours, and you can pay the seller or refund any open trade yourself. The regulator switches the agents back on after the review.',
      k: ['on hold', 'frozen', 'freeze', 'my money', 'withdraw', 'is my money safe', 'agents stopped', 'why stopped'] },
    { id: 'pause', q: 'Can I stop the agents?',
      a: 'Yes. "Pause agent payments" in the wallet stops all agent payments at once. The agents can still read and talk, but no money moves until you resume. Payments are {pausedState} right now.',
      k: ['pause', 'stop', 'freeze', 'halt', 'resume', 'stop the agents', 'stop agents', 'pause agents'] },
    { id: 'mandate-change', q: 'Who can change the limits?',
      a: 'Only you, the owner. The payment agent cannot raise its own limits; if it tries, the registry refuses it and nothing changes. You change them with the "Change rules" button in the wallet, under "Limits and rules".',
      k: ['change limit', 'raise', 'increase', 'lower', 'edit rules', 'change rules', 'mandate change'] },
    { id: 'daily-limit', q: 'What if a payment would go over today\'s limit?',
      a: 'It waits. The payment agent will not break your daily limit ({perDay}); the payment is paid on a new day, or you can close the trade and take your money back. Paid today so far: {spentToday}.',
      k: ['daily limit', 'today', 'over the limit', 'tomorrow', 'wait'] },
    { id: 'credit', q: 'What is trade credit?',
      a: 'Trade credit is a demo score built from your settled trades: each clean trade adds 3 points. Your score is {creditIndex} of 100. The working-capital line is 20% of what you settled cleanly: {creditLine}. It is a demo formula, not a real credit offer.',
      k: ['credit', 'score', 'working capital', 'working-capital', 'loan', 'line'] },
    { id: 'simulated', q: 'What is real and what is simulated in this demo?',
      a: 'This is a demonstration. {realityNote}',
      k: ['real', 'simulated', 'demo', 'fake', 'blockchain', 'testnet', 'fictional'] },
    { id: 'change-rules', q: 'How do I change my rules?',
      a: 'Open "Limits and rules" in the wallet and press "Change rules". Set the largest single payment, the daily limit, the amount above which you are asked, and how many payments the agent may make alone a day. Before you save, it shows the bond those rules need. Only your wallet can save them. Right now: up to {perPayment} per payment, {perDay} a day, and you are asked above {approveAbove}.',
      k: ['change rules', 'change my rules', 'change the rules', 'set limits', 'edit limits', 'new limits', 'how do i change'] },
    { id: 'top-up-bond', q: 'How do I top up the bond?',
      a: 'Open "Limits and rules" in the wallet and press "Top up bond", then enter the amount. The bond is {bond} and the rules need {bondRequired}. If the bond is below that, the payment agent is held (no payments, no penalty) until it is topped up.',
      k: ['top up', 'top-up', 'topup', 'add to the bond', 'add bond', 'bond short', 'increase bond'] },
    { id: 'trade-status', q: 'What is happening with my trade?',
      a: 'Your latest trade: {tradeSummary}.',
      k: ['status', 'my trade', 'where', 'update', 'progress', 'happening'] },
  ];

  /** Fill {placeholders} from a state snapshot. Unknown values read "[not available]". */
  function fill(text, state) {
    return text.replace(/\{(\w+)\}/g, (_, k) => (state && state[k] != null && state[k] !== '' ? String(state[k]) : '[not available]'));
  }

  /** Offline match: score each entry by keyword hits in the question. Returns the best entry or null. */
  function match(question) {
    const q = ' ' + String(question).toLowerCase() + ' ';
    let best = null, bestScore = 0;
    for (const e of FAQ) {
      let s = 0;
      for (const k of e.k) if (q.includes(k)) s += k.length > 6 ? 2 : 1;
      if (s > bestScore) { best = e; bestScore = s; }
    }
    return bestScore > 0 ? best : null;
  }

  const api = { FAQ, fill, match };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.TB = root.TB || {}; root.TB.faq = api; }
})(typeof window !== 'undefined' ? window : globalThis);
