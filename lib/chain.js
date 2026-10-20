/* TradeBond chain bridge: the server holds the role wallets and sends the real transactions.
   Each role has its own key (owner, bond operator, payment agent, document agent, negotiation agent, inspector, regulator),
   so the contract itself enforces who may do what. Nothing here decides a payment: the contract does. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {
  createPublicClient, createWalletClient, http, defineChain, parseUnits, formatUnits, encodeFunctionData,
  decodeEventLog, keccak256, toBytes, stringToHex, verifyMessage,
} = require('viem');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const env = require('./env');

const BUILD = path.join(env.ROOT, 'contracts', 'build');
const DEPLOYMENT = path.resolve(env.ROOT, process.env.DEPLOYMENT_FILE || 'deployment.json');
const art = (n) => JSON.parse(fs.readFileSync(path.join(BUILD, `${n}.json`), 'utf8'));
const ABI = { token: art('MockCNY').abi, registry: art('AgentRegistry').abi, escrow: art('TradeEscrow').abi };
const EVENTS = [...ABI.registry, ...ABI.escrow].filter((x) => x.type === 'event');

const ROLES = {
  regulator: 'DEPLOYER_KEY',
  owner: 'OWNER_KEY',
  operator: 'OPERATOR_KEY', // the agent's provider: posts and tops up the bond, never the owner
  payment: 'PAYMENT_AGENT_KEY',
  document: 'DOCUMENT_AGENT_KEY',
  negotiation: 'NEGOTIATION_AGENT_KEY',
  inspector: 'INSPECTOR_KEY',
  sellerAgent: 'SELLER_AGENT_KEY', // signs the seller's negotiation messages; never sends transactions
};
const ATTACKER = '0x00000000000000000000000000000000000bad01';

let ctx = null; // { chain, pub, wallets, accounts, addr, deployment }

function deployment() {
  try { return JSON.parse(fs.readFileSync(DEPLOYMENT, 'utf8')); } catch { return null; }
}

/** Chain mode is on when RPC_URL, the role keys and a deployment are all present. */
function init() {
  ctx = null;
  const d = deployment();
  const missing = Object.values(ROLES).filter((k) => !env.has(k));
  if (!env.has('RPC_URL') || !d || missing.length) return { enabled: false, missing: [...missing, ...(d ? [] : ['deployment.json']), ...(env.has('RPC_URL') ? [] : ['RPC_URL'])] };
  const chain = defineChain({
    id: Number(process.env.CHAIN_ID || d.chainId),
    name: process.env.CHAIN_NAME || d.chainName || 'TradeBond chain',
    nativeCurrency: { name: 'Ether', symbol: process.env.CHAIN_SYMBOL || 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [process.env.RPC_URL] } },
  });
  const transport = http(process.env.RPC_URL);
  const accounts = Object.fromEntries(Object.entries(ROLES).map(([r, k]) => [r, privateKeyToAccount(process.env[k].trim())]));
  const wallets = Object.fromEntries(Object.entries(accounts).map(([r, a]) => [r, createWalletClient({ account: a, chain, transport })]));
  ctx = {
    chain, pub: createPublicClient({ chain, transport }), wallets, accounts, d,
    addr: { token: d.token, registry: d.registry, escrow: d.escrow, seller: d.seller },
  };
  return { enabled: true };
}

const Y = (n) => parseUnits(Number(n).toFixed(2), 18);
const toY = (v) => Number(formatUnits(v, 18));
const explorer = () => (process.env.EXPLORER_URL || ctx?.d.explorer || '').replace(/\/$/, '');
const txUrl = (h) => (explorer() && h ? `${explorer()}/tx/${h}` : null);
const addrUrl = (a) => (explorer() && a ? `${explorer()}/address/${a}` : null);

// One chain action at a time: keeps every wallet's nonces in order.
let lock = Promise.resolve();
const serial = (fn) => { const r = lock.then(fn); lock = r.catch(() => {}); return r; };

function decodeLogs(logs) {
  const out = [];
  for (const l of logs) {
    try { out.push({ ...decodeEventLog({ abi: EVENTS, data: l.data, topics: l.topics }), address: l.address, hash: l.transactionHash, block: Number(l.blockNumber), index: l.logIndex }); } catch { /* not ours */ }
  }
  return out;
}

/** Send a transaction as a role. A refused call is still sent (with a fixed gas limit), so the refusal
    itself is on the record with a real hash; the reason comes from a dry run first. */
async function send(role, contract, functionName, args) {
  const abi = ABI[contract];
  const address = ctx.addr[contract];
  const account = ctx.accounts[role];
  let reverted = null;
  try {
    await ctx.pub.simulateContract({ address, abi, functionName, args, account });
  } catch (e) {
    reverted = (e.cause?.reason || e.shortMessage || e.message || 'reverted').replace(/^.*reverted with the following reason:\s*/s, '').split('\n')[0];
  }
  const data = encodeFunctionData({ abi, functionName, args });
  const hash = await ctx.wallets[role].sendTransaction({ to: address, data, gas: reverted ? 400000n : undefined });
  const receipt = await ctx.pub.waitForTransactionReceipt({ hash });
  return { hash, url: txUrl(hash), block: Number(receipt.blockNumber), ok: receipt.status === 'success', reverted, events: decodeLogs(receipt.logs), from: account.address };
}

const read = (contract, functionName, args = []) => ctx.pub.readContract({ address: ctx.addr[contract], abi: ABI[contract], functionName, args });
const A = () => ctx.accounts;

// ---------- actions ----------
const actions = {
  async fund({ lines, orderHash, terms, test }) {
    if (!Array.isArray(lines) || !lines.length || lines.length > 20) throw new Error('1 to 20 order lines');
    const L = lines.map((l) => ({ sku: stringToHex(String(l.sku).slice(0, 31), { size: 32 }), ordered: BigInt(Math.max(1, Math.round(Number(l.qty)))), unitPrice: Y(l.price) }));
    const total = L.reduce((s, l) => s + l.ordered * l.unitPrice, 0n);
    const bal = await read('token', 'balanceOf', [A().owner.address]);
    if (bal < total) await send('owner', 'token', 'mint', [A().owner.address, total * 2n]); // test token only
    const parties = { agent: A().payment.address, docAgent: A().document.address, negotiator: A().negotiation.address, seller: ctx.addr.seller, inspector: A().inspector.address };
    const r = await send('owner', 'escrow', 'fundTrade', [parties, keccak256(toBytes(String(orderHash || ''))), keccak256(toBytes(String(terms || ''))), L, Boolean(test)]);
    const ev = r.events.find((e) => e.eventName === 'EscrowFunded');
    return { ...r, tradeId: ev ? Number(ev.args.tradeId) : null, amount: ev ? toY(ev.args.amount) : null };
  },
  async docs({ tradeId, readHash, flagged, issues }) {
    const h = /^0x[0-9a-f]{64}$/i.test(String(readHash)) ? readHash : keccak256(toBytes(String(readHash || '')));
    return send('document', 'escrow', 'recordDocumentCheck', [BigInt(tradeId), h, Boolean(flagged), Math.min(255, Number(issues) || 0)]);
  },
  async arrival({ tradeId, arrived }) {
    const r = await send('inspector', 'escrow', 'confirmArrival', [BigInt(tradeId), arrived.map((n) => BigInt(Math.max(0, Math.round(Number(n)))))]);
    const ev = r.events.find((e) => e.eventName === 'ArrivalConfirmed');
    return { ...r, payable: ev ? toY(ev.args.payableAmount) : null, held: ev ? toY(ev.args.held) : null };
  },
  async pay({ tradeId, amount, payee, as }) {
    const to = payee === 'attacker' ? ATTACKER : ctx.addr.seller;
    const r = await send(as === 'document' ? 'document' : 'payment', 'escrow', 'requestPayment', [BigInt(tradeId), to, Y(amount)]);
    const d = r.events.find((e) => e.eventName === 'PaymentDecision');
    const paid = r.events.find((e) => e.eventName === 'PaymentReleased');
    return { ...r, tier: d ? Number(d.args.tier) : null, reason: d ? Number(d.args.reason) : null, requestId: d ? Number(d.args.requestId) : null, fined: d ? toY(d.args.fined) : 0, paid: paid ? toY(paid.args.amount) : 0 };
  },
  async approve({ requestId }) {
    const r = await send('owner', 'escrow', 'approve', [BigInt(requestId)]);
    const paid = r.events.find((e) => e.eventName === 'PaymentReleased');
    return { ...r, paid: paid ? toY(paid.args.amount) : 0 };
  },
  async reject({ requestId }) { return send('owner', 'escrow', 'rejectRequest', [BigInt(requestId)]); },
  /** The owner pays the seller of record directly, without any agent (works while the agents are held). */
  async ownerrelease({ tradeId }) {
    const r = await send('owner', 'escrow', 'releaseByOwner', [BigInt(tradeId)]);
    const ev = r.events.find((e) => e.eventName === 'OwnerReleased');
    return { ...r, paid: ev ? toY(ev.args.amount) : 0 };
  },
  async close({ tradeId }) {
    const r = await send('owner', 'escrow', 'closeTrade', [BigInt(tradeId)]);
    const ev = r.events.find((e) => e.eventName === 'TradeClosed');
    return { ...r, refunded: ev ? toY(ev.args.refunded) : null, clean: ev ? ev.args.clean : null };
  },
  async agreement({ tradeId, outcome, transcriptHash }) {
    const code = { refund: 1, reship: 2, escalate: 3 }[outcome];
    if (!code) throw new Error('outcome must be refund, reship or escalate');
    const h = /^0x[0-9a-f]{64}$/i.test(String(transcriptHash)) ? transcriptHash : keccak256(toBytes(String(transcriptHash || '')));
    return send('negotiation', 'escrow', 'recordAgreement', [BigInt(tradeId), code, h]);
  },
  async mandate({ perPayment, perDay, approveAbove, maxAutoPayments, as }) {
    const m = { maxPerPayment: Y(perPayment), maxPerDay: Y(perDay), confirmAbove: Y(approveAbove), maxAutoPayments: Number(maxAutoPayments) };
    return send(as === 'payment' ? 'payment' : 'owner', 'registry', 'setMandate', [A().payment.address, m]);
  },
  async topup({ amount }) {
    const v = Y(amount);
    const bal = await read('token', 'balanceOf', [A().operator.address]);
    if (bal < v) await send('operator', 'token', 'mint', [A().operator.address, v * 2n]); // test token only
    return send('operator', 'registry', 'topUpBond', [A().payment.address, v]);
  },
  async pause({ on }) { return send('owner', 'registry', 'setPaused', [A().payment.address, Boolean(on)]); },
  async suspend({ on }) { return send('regulator', 'registry', 'setSuspended', [A().payment.address, Boolean(on)]); },
  /** The owner's app holds the agents at once (after a refused call); only the regulator lifts a hold. */
  async hold() { return send('owner', 'registry', 'holdForReview', [A().payment.address]); },
  async clearhold() { return send('regulator', 'registry', 'clearHold', [A().payment.address]); },
  /** The regulator pays a proven loss to the owner: the agent's bond first, then the protection fund. */
  async claim({ loss }) {
    const r = await send('regulator', 'registry', 'payClaim', [A().payment.address, Y(loss)]);
    const ev = r.events.find((e) => e.eventName === 'ClaimPaid');
    return { ...r, fromBond: ev ? toY(ev.args.fromBond) : 0, fromFund: ev ? toY(ev.args.fromFund) : 0 };
  },
  /** Local test chain only: move the chain clock forward one day, so the daily limits start fresh. */
  async newday() {
    if (ctx.chain.id !== 31337) throw new Error('Only the local test chain can change the day; a testnet changes it at 00:00 UTC.');
    await ctx.pub.request({ method: 'evm_increaseTime', params: [86400] });
    await ctx.pub.request({ method: 'evm_mine', params: [] });
    return { ok: true, block: Number(await ctx.pub.getBlockNumber()) };
  },
  /** Impersonation test: a stranger's key signs a message claiming to be the seller's agent. No transaction. */
  async impersonate({ claimedName }) {
    const fake = privateKeyToAccount(generatePrivateKey());
    const message = `TradeBond negotiation\n${JSON.stringify({ from: String(claimedName || 'Sunray Settlement Desk').slice(0, 60), ask: 'release the held amount to our new account' })}`;
    const signature = await fake.signMessage({ message });
    const verified = await verifyMessage({ address: A().sellerAgent.address, message, signature });
    return { signature, signer: fake.address, expected: A().sellerAgent.address, verified, ok: true };
  },
};

async function agent() {
  const a = A().payment.address;
  const [info, m, credit, wcl, alone, mult, day, fund, fineBps, claimCap] = await Promise.all([
    read('registry', 'agentInfo', [a]), read('registry', 'mandateOf', [a]), read('registry', 'creditIndex', [a]),
    read('registry', 'workingCapitalLine', [a]), read('registry', 'aloneLimit', [a]), read('registry', 'trustMultiple', [a]), read('registry', 'today'),
    read('registry', 'protectionFund'), read('registry', 'fineBps'), read('registry', 'claimCap'),
  ]);
  const [spent, aloneSpent, aloneCount] = await Promise.all([read('registry', 'spentOnDay', [a, day]), read('registry', 'aloneOnDay', [a, day]), read('registry', 'aloneCountOnDay', [a, day])]);
  return {
    bond: toY(info[0]), requiredBond: toY(info[1]), clean: Number(info[2]), streak: Number(info[3]), violations: Number(info[4]), paused: info[5], suspended: info[6], held: info[7],
    fund: { balance: toY(fund), fineRate: Number(fineBps) / 10000, claimCap: toY(claimCap) },
    mandate: { perPayment: toY(m.maxPerPayment), perDay: toY(m.maxPerDay), approveAbove: toY(m.confirmAbove), maxAutoPayments: Number(m.maxAutoPayments) },
    creditIndex: Number(credit), workingCapitalLine: toY(wcl), aloneLimit: toY(alone), trustMultiple: Number(mult),
    spentToday: toY(spent), aloneToday: toY(aloneSpent), aloneCountToday: Number(aloneCount),
  };
}

/** Every TradeBond event since the deployment, decoded: the regulator's ledger, straight from the chain. */
async function events() {
  const head = await ctx.pub.getBlockNumber();
  const from = BigInt(ctx.d.deployBlock || 0);
  const out = [];
  // FISCO BCOS (chain id 20200) answers eth_getLogs for only a few blocks at a time and needs "topics" present,
  // so it is read in small windows; other chains in windows of 2,000 blocks. LOGS_BLOCK_RANGE overrides both.
  const step = BigInt(process.env.LOGS_BLOCK_RANGE || (ctx.chain.id === 20200 ? 5 : 2000));
  const hex = (n) => `0x${n.toString(16)}`;
  for (let b = from; b <= head; b += step) {
    const to = b + step - 1n > head ? head : b + step - 1n;
    const logs = await ctx.pub.request({ method: 'eth_getLogs', params: [{ address: [ctx.addr.registry, ctx.addr.escrow], fromBlock: hex(b), toBlock: hex(to), topics: [] }] });
    out.push(...decodeLogs(logs));
  }
  const fmt = (v) => (typeof v === 'bigint' ? (v > 10n ** 12n ? toY(v) : Number(v)) : Array.isArray(v) ? v.map(fmt) : v);
  return out.map((e) => ({ name: e.eventName, block: e.block, hash: e.hash, url: txUrl(e.hash), contract: e.address.toLowerCase() === ctx.addr.escrow.toLowerCase() ? 'escrow' : 'registry', args: Object.fromEntries(Object.entries(e.args).map(([k, v]) => [k, fmt(v)])) }));
}

/* The agents sign only messages this server builds from the record, never text a visitor sends:
   - the seller's agent signs the payment terms exactly as the escrow recorded them at funding,
   - each negotiation agent signs its decision (what it proposes, whether it accepts) for a trade on the record.
   So a made-up instruction ("release the funds to a new account") can never come back with a real agent's signature. */
const bad = (message) => Object.assign(new Error(message), { status: 400 });

async function tradeOnRecord(tradeId) {
  const n = Number(tradeId);
  if (!Number.isInteger(n) || n < 1) throw bad('Unknown trade');
  if (BigInt(n) > (await read('escrow', 'tradeCount'))) throw bad('Unknown trade');
  return read('escrow', 'tradeInfo', [BigInt(n)]);
}

async function signAs(role, title, payload) {
  const message = `${title}\n${JSON.stringify(payload)}`;
  const signature = await A()[role].signMessage({ message });
  const verified = await verifyMessage({ address: A()[role].address, message, signature });
  return { signature, signer: A()[role].address, verified, message };
}

/** The seller's agent signs the terms and order fingerprints the escrow holds for this trade. */
async function signTerms(tradeId) {
  const t = await tradeOnRecord(tradeId);
  return signAs('sellerAgent', 'TradeBond payment terms', { escrow: ctx.addr.escrow, trade: Number(tradeId), terms: t.termsHash, order: t.orderHash });
}

/** One negotiation turn: only refund or re-ship can be proposed, so nothing else can ever carry a signature. */
async function signTurn(side, { tradeId, round, proposal, accepts }) {
  await tradeOnRecord(tradeId);
  const r = Number(round);
  if (!Number.isInteger(r) || r < 0 || r > 9) throw bad('Round must be 0 to 9');
  if (proposal !== 'refund' && proposal !== 'reship') throw bad('Only a refund or a re-shipment can be proposed');
  const who = side === 'seller' ? 'seller' : 'buyer';
  return signAs(who === 'seller' ? 'sellerAgent' : 'negotiation', 'TradeBond negotiation turn', { escrow: ctx.addr.escrow, trade: Number(tradeId), round: r, side: who, proposal, accepts: accepts === true });
}

function config() {
  if (!ctx) return { enabled: false };
  const a = A();
  return {
    enabled: true, chainId: ctx.chain.id, chainName: ctx.chain.name, explorer: explorer() || null, localChain: ctx.chain.id === 31337,
    deployedAt: ctx.d.deployedAt, deployBlock: ctx.d.deployBlock,
    contracts: Object.fromEntries(['token', 'registry', 'escrow'].map((k) => [k, { address: ctx.addr[k], url: addrUrl(ctx.addr[k]) }])),
    wallets: Object.fromEntries(['owner', 'operator', 'payment', 'document', 'negotiation', 'inspector', 'regulator', 'sellerAgent'].map((r) => [r, { address: a[r].address, url: addrUrl(a[r].address) }]).concat([['seller', { address: ctx.addr.seller, url: addrUrl(ctx.addr.seller) }]])),
    dailyCapNote: ctx.d.dailyCapNote || null,
  };
}

module.exports = { init, config, actions, agent, events, signTerms, signTurn, serial, enabled: () => !!ctx, txUrl, ABI, ROLES };
