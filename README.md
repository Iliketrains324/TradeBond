# TradeBond v4.1: run it

TradeBond runs in three ways. Each one adds to the one before it.

| Mode | What you need | What is real |
|---|---|---|
| **1. Quick look** | Double-click `index.html` | Nothing. The rules run in the browser. Hashes are samples. The top bar shows **Chain: simulated · AI: offline**. |
| **2. Local chain** | Node 18+, Foundry's `anvil` | Every money step is a **real transaction** on a private local chain, decided by the contracts. |
| **3. Testnet and live AI** | An EVM testnet RPC URL, faucet gas, an Anthropic API key | Real testnet transactions with explorer links. The live AI reads documents, turns chat into orders and writes the negotiation. |

## 1. Quick look
Open `index.html`. Press **Simulator → Run Judge mode** to watch a clean trade, a short shipment and an attack.

## 2. Local chain (real transactions, no internet needed)
```
npm install                 # one dependency: viem
anvil                       # in a second terminal (install Foundry: getfoundry.sh)
npm run deploy:local        # deploys the contracts and writes deployment.json and .env
npm start                   # then open http://localhost:3000
```
The top bar shows **Chain: live**. On a local chain, "Start a new day" in the Simulator moves the chain's clock forward one day.

## 3. Testnet (for the live link)
1. Copy `.env.example` to `.env`. Set `RPC_URL`, `CHAIN_NAME` and `EXPLORER_URL` (for example Sepolia and `https://sepolia.etherscan.io`).
2. Run `npm run deploy`. The first run creates a deployer key and prints its address.
3. Send faucet gas to that address, then run `npm run deploy` again. The deployer then:
   - funds the role wallets with gas
   - deploys the token, the registry and the escrow
   - sets KYC, registers the payment agent, approves the seller, and has the bond operator (its own wallet, never the owner) post the ¥50,000 bond
4. Run `npm start`. Every transaction in the app now links to the explorer.

**FISCO BCOS:** the contracts use Solidity 0.8.11 (`contracts/src`), so they are portable. Point `RPC_URL` at a FISCO BCOS node with Web3 RPC enabled.

## FISCO BCOS (WeBank's chain)
The same three contracts run unchanged on FISCO BCOS 3.x (Solidity 0.8.11), through its Ethereum-compatible Web3 RPC. Tested with a 4-node local chain on an Apple Silicon Mac.
1. **Get FISCO BCOS v3.16.3.** Download the `fisco-bcos` binary for your OS from its GitHub release, plus `tools/BcosAirBuilder/build_chain.sh` from the same tag.
   - Don't use v3.16.4: its Web3 RPC refuses any sender with a zero balance, and FISCO has no gas coin to give.
2. **Build the chain:** `bash build_chain.sh -l 127.0.0.1:4 -p 30300,20200 -e ./fisco-bcos -o nodes -a <admin address>`
   - On Apple Silicon you must pass `-a` (any new address), because the script's account helper only runs on Intel.
3. **Switch on the Web3 RPC:** in `nodes/127.0.0.1/node0/config.ini`, under `[web3_rpc]`, set `enable=true` and `listen_port=8547`.
4. **Start the chain:** `bash nodes/127.0.0.1/start_all.sh`. To stop it, run `stop_all.sh`.
5. **Deploy:** `npm run deploy:fisco`.
   - Keys go to `.env.fisco` and addresses to `deployment.fisco.json`.
   - Your testnet `.env` and `deployment.json` are not touched.
6. **Run the site:** `npm run start:fisco`, then open http://localhost:8083. The top bar shows **Chain: FISCO BCOS**.

**Notes:**
- FISCO charges no gas and has no public explorer. To check a hash, call `eth_getTransactionReceipt` on port 8547.
- FISCO answers event queries for only a few blocks at a time, so the server reads events in 5-block windows (override with `LOGS_BLOCK_RANGE`).

**Changed a contract?** Run `cd contracts && forge test`, then `npm run build:contracts` to rebuild `contracts/build/*.json` with solc 0.8.11, then deploy again.

**Daily cap:** `MAX_PER_DAY` defaults to ¥1,600,000, a real owner's limit, which is what we film. Raise it only for a shared public link.

**Fresh start:** the contracts keep their history, so the agent's record (violations, bond, credit) builds up over runs. To start clean, run the deploy command again. It also clears the saved demo.

## Live AI
Put `ANTHROPIC_API_KEY=` in `.env`. Use a dedicated key with a spending limit, and revoke it after the competition.

The AI only proposes. It never sets a price, an amount or a payee.
- **Document reading:** the AI reads the seller's documents (or files you upload in the Simulator) into a fixed format. Plain code then compares them with the order. A fingerprint of the reading goes on-chain.
- **Chat to order:** the AI picks catalogue products and quantities. Prices come from `catalogue.js`. You confirm the order, and the confirmed lines and prices are committed at funding.
- **Negotiation:** two AI agents, one per side, can only propose a refund or a re-ship. Your policy is enforced in code. With the chain on, each message is signed by that side's wallet. The agreement is recorded on-chain but **moves no money**: the refund happens when the trade closes, and a re-ship is not enforced.
- **Bao's FAQ:** Bao answers from `faq.js` and the numbers on screen, and cannot act.

Without a key, everything falls back to built-in logic, and the screen says so.

## Keys and safety
- **Every secret lives only in `.env`:** the AI key, and one wallet key per role (owner, payment agent, document agent, negotiation agent, inspector, regulator, seller, seller agent).
  - The browser never receives a key.
  - The server refuses to serve `.env`, its own code, `lib/`, `contracts/` and `node_modules/`.
- **On a host** (Render, Railway, a VPS), put the `.env` values in the host's environment-variable settings. Do not upload `.env`.
- **Rate limits** (all settable in `.env`):

  | Endpoints | Per visitor | Whole site |
  |---|---|---|
  | AI | 20 a minute | 500 a day |
  | Transactions | 90 a minute | 3,000 a day |

- **Saved demo:** the demo is saved in `state.json` on the server. Your own uploaded documents stay in browser memory and are never saved.

## Files
| File | What it is |
|---|---|
| `contracts/src/*.sol`, `contracts/test/` | `AgentRegistry` (mandate, bond, trust, credit, suspend/pause) and `TradeEscrow` (funding, document check, inspector arrival, payment decisions, agreements, close, owner release), the protection fund, the security hold and claims. 21 Foundry tests (`forge test` in `contracts/`). |
| `contracts/build/*.json`, `contracts/build.js` | ABI and bytecode used by `deploy.js` and the server, and the script that rebuilds them |
| `deploy.js` | Local and testnet deployment |
| `server.js`, `lib/` | Website, AI endpoints, chain endpoints, saved state |
| `net.js` | The browser's only link to the server (no keys) |
| `sim.js` | Trade flow: in chain mode it acts on the contract's answers; offline it runs the same rules |
| `catalogue.js`, `faq.js` | Products and prices; Bao's FAQ |
| `ui.js`, `stage*.js`, `*.css`, `faces.js` | The interface |
