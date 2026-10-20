/* TradeBond deploy (v4.1): puts the contracts on a chain and writes the settings the server needs.
     npm run deploy:local   a throwaway local chain (start one first with: anvil)
     npm run deploy         the testnet named by RPC_URL in .env (DEPLOYER_KEY must hold test gas)
     npm run deploy:fisco   a FISCO BCOS chain through its Web3 RPC (default http://127.0.0.1:8547; no gas coin needed),
                            with its own settings in .env.fisco and deployment.fisco.json, so the testnet setup is kept
   Writes deployment.json (public addresses) and the role keys/addresses into .env (private, never upload it). */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const env = require('./lib/env');
env.load();
const { createPublicClient, createWalletClient, http, defineChain, parseUnits, parseEther, formatEther, maxUint256 } = require('viem');
const { privateKeyToAccount, generatePrivateKey, mnemonicToAccount } = require('viem/accounts');

const LOCAL = process.argv.includes('--local');
const FISCO = process.argv.includes('--fisco');
const DEPLOYMENT_FILE = path.resolve(__dirname, process.env.DEPLOYMENT_FILE || 'deployment.json');
const STATE_FILE = path.resolve(__dirname, process.env.STATE_FILE || 'state.json');
const BUILD = path.join(__dirname, 'contracts', 'build');
const art = (n) => JSON.parse(fs.readFileSync(path.join(BUILD, `${n}.json`), 'utf8'));
const Y = (n) => parseUnits(String(n), 18);

const ROLE_KEYS = ['DEPLOYER_KEY', 'OWNER_KEY', 'PAYMENT_AGENT_KEY', 'DOCUMENT_AGENT_KEY', 'NEGOTIATION_AGENT_KEY', 'INSPECTOR_KEY', 'SELLER_KEY', 'SELLER_AGENT_KEY', 'OPERATOR_KEY'];
const ANVIL = 'test test test test test test test test test test test junk';

async function main() {
  const rpc = LOCAL ? (process.env.LOCAL_RPC_URL || 'http://127.0.0.1:8545') : FISCO ? (process.env.FISCO_RPC_URL || process.env.RPC_URL || 'http://127.0.0.1:8547') : process.env.RPC_URL;
  if (!rpc) throw new Error('Set RPC_URL in .env (your testnet RPC address), or run with --local.');
  const probe = createPublicClient({ transport: http(rpc) });
  const chainId = await probe.getChainId();
  const chain = defineChain({
    id: chainId,
    name: LOCAL ? 'Local test chain' : FISCO ? 'FISCO BCOS' : process.env.CHAIN_NAME || `Chain ${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: process.env.CHAIN_SYMBOL || 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpc) });

  // keys: local uses anvil's well-known test accounts; a testnet uses the .env keys, generating any missing
  const keys = {};
  ROLE_KEYS.forEach((k, i) => {
    if (LOCAL) keys[k] = `0x${Buffer.from(mnemonicToAccount(ANVIL, { addressIndex: i }).getHdKey().privateKey).toString('hex')}`;
    else keys[k] = env.has(k) ? process.env[k].trim() : generatePrivateKey();
  });
  if (!LOCAL && !FISCO && !env.has('DEPLOYER_KEY')) {
    env.save({ DEPLOYER_KEY: keys.DEPLOYER_KEY });
    const a = privateKeyToAccount(keys.DEPLOYER_KEY).address;
    throw new Error(`No DEPLOYER_KEY yet, so one was created and saved in .env.\nSend test gas from the faucet to ${a}, then run "npm run deploy" again.`);
  }
  const acct = Object.fromEntries(ROLE_KEYS.map((k) => [k, privateKeyToAccount(keys[k])]));
  const wallet = (k) => createWalletClient({ account: acct[k], chain, transport: http(rpc) });
  const D = wallet('DEPLOYER_KEY');
  const O = wallet('OWNER_KEY');
  const B = wallet('OPERATOR_KEY');
  const wait = (hash) => pub.waitForTransactionReceipt({ hash });

  const gas = await pub.getBalance({ address: acct.DEPLOYER_KEY.address });
  console.log(`Chain ${chainId} at ${rpc}\nDeployer ${acct.DEPLOYER_KEY.address} ${FISCO ? '(FISCO BCOS charges no gas)' : `holds ${formatEther(gas)} gas coin.`}`);
  if (gas === 0n && !FISCO) throw new Error('The deployer has no gas. Use the testnet faucet first.');

  // give each sending role a little gas (testnet only; anvil accounts are pre-funded, FISCO BCOS has no gas coin)
  if (!LOCAL && !FISCO) {
    const each = parseEther(process.env.GAS_PER_ROLE || '0.02');
    for (const k of ['OWNER_KEY', 'PAYMENT_AGENT_KEY', 'DOCUMENT_AGENT_KEY', 'NEGOTIATION_AGENT_KEY', 'INSPECTOR_KEY', 'OPERATOR_KEY']) {
      const have = await pub.getBalance({ address: acct[k].address });
      if (have < each / 2n) { await wait(await D.sendTransaction({ to: acct[k].address, value: each - have })); console.log(`  gas sent to ${k.replace('_KEY', '').toLowerCase()}`); }
    }
  }

  const deploy = async (name, args = []) => {
    const a = art(name);
    const r = await wait(await D.deployContract({ abi: a.abi, bytecode: a.bytecode, args }));
    console.log(`  ${name} at ${r.contractAddress}`);
    return { address: r.contractAddress, block: Number(r.blockNumber) };
  };
  console.log(FISCO ? 'Deploying to FISCO BCOS (compiler 0.8.11):' : 'Deploying (compiler 0.8.11, portable to FISCO BCOS):');
  const token = await deploy('MockCNY');
  const registry = await deploy('AgentRegistry', [token.address]);
  const escrow = await deploy('TradeEscrow', [token.address, registry.address]);
  const R = art('AgentRegistry').abi, T = art('MockCNY').abi;
  const call = async (w, address, abi, functionName, args) => wait(await w.writeContract({ address, abi, functionName, args }));

  const m = {
    maxPerPayment: Y(process.env.MAX_PER_PAYMENT || 800000),
    maxPerDay: Y(process.env.MAX_PER_DAY || 1600000),
    confirmAbove: Y(process.env.CONFIRM_ABOVE || 100000),
    maxAutoPayments: Number(process.env.MAX_AUTO_PAYMENTS || 5),
  };
  const owner = acct.OWNER_KEY.address, seller = acct.SELLER_KEY.address, agent = acct.PAYMENT_AGENT_KEY.address, operator = acct.OPERATOR_KEY.address;
  const bond = Number(process.env.START_BOND || 50000);
  await call(D, registry.address, R, 'setEscrow', [escrow.address]);
  await call(D, registry.address, R, 'setKyc', [owner, true]);
  await call(D, registry.address, R, 'setKyc', [seller, true]);
  await call(D, registry.address, R, 'setKyc', [operator, true]);
  await call(O, token.address, T, 'mint', [owner, Y(100000000)]);
  await call(O, token.address, T, 'approve', [escrow.address, maxUint256]);
  // the owner registers the agent and sets the rules; the bond operator (the agent's provider) posts the bond
  await call(O, registry.address, R, 'registerAgent', [agent, operator, m]);
  await call(O, registry.address, R, 'setPayee', [agent, seller, true]);
  await call(B, token.address, T, 'mint', [operator, Y(10000000)]);
  await call(B, token.address, T, 'approve', [registry.address, maxUint256]);
  await call(B, registry.address, R, 'topUpBond', [agent, Y(bond)]);
  console.log(`  owner KYC, seller approved, payment agent registered; the bond operator posted a ¥${bond.toLocaleString('en-US')} bond`);

  const explorer = LOCAL || FISCO ? '' : process.env.EXPLORER_URL || '';
  const perDay = Number(process.env.MAX_PER_DAY || 1600000);
  const deployment = {
    chainId, chainName: chain.name, rpc: LOCAL || FISCO ? rpc : '(see RPC_URL in .env)', explorer,
    token: token.address, registry: registry.address, escrow: escrow.address, seller,
    deployBlock: token.block, deployedAt: new Date().toISOString(),
    mandate: { perPayment: Number(process.env.MAX_PER_PAYMENT || 800000), perDay, approveAbove: Number(process.env.CONFIRM_ABOVE || 100000), maxAutoPayments: m.maxAutoPayments },
    // only a raised cap (MAX_PER_DAY above ¥1,600,000, for a shared public link) gets a note in the wallet
    dailyCapNote: perDay > 1600000 ? `For the shared demo link the daily cap is raised to ¥${perDay.toLocaleString('en-US')} so many visitors can run trades on the same day. A real owner would set something like ¥1,600,000.` : null,
  };
  fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(deployment, null, 2));
  const save = { ...keys, RPC_URL: rpc, CHAIN_ID: chainId };
  if (LOCAL || FISCO) save.EXPLORER_URL = '';
  if (FISCO) save.CHAIN_NAME = 'FISCO BCOS';
  env.save(save);
  try { fs.unlinkSync(STATE_FILE); } catch { /* none */ }
  console.log(`\nDone. ${path.basename(DEPLOYMENT_FILE)} written; role keys saved in ${path.basename(env.ENV_FILE)} (keep it private).\nNow run: ${FISCO ? 'npm run start:fisco' : 'npm start'}`);
}

main().catch((e) => { console.error(`\nDeploy stopped: ${e.shortMessage || e.message}`); process.exit(1); });
