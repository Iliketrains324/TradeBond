/* Rebuilds contracts/build/*.json, the files deploy.js and the server read, after a change to contracts/src.
     npm run build:contracts
   Uses solc 0.8.11 with no optimizer, the same settings as the files shipped in v4.0 (portable to FISCO BCOS).
   Running "forge test" once in contracts/ installs solc 0.8.11; or point SOLC at any solc 0.8.11 binary. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIR = __dirname;
const CONTRACTS = ['MockCNY', 'AgentRegistry', 'TradeEscrow'];
const candidates = [
  process.env.SOLC,
  path.join(os.homedir(), 'Library', 'Application Support', 'svm', '0.8.11', 'solc-0.8.11'),
  path.join(os.homedir(), '.svm', '0.8.11', 'solc-0.8.11'),
].filter(Boolean);
const solc = candidates.find((p) => fs.existsSync(p));
if (!solc) {
  console.error('solc 0.8.11 not found. Run "forge test" once in contracts/ (it installs it), or set SOLC to its path.');
  process.exit(1);
}
const version = execFileSync(solc, ['--version'], { encoding: 'utf8' });
if (!/Version: 0\.8\.11\+/.test(version)) {
  console.error(`${solc} is not solc 0.8.11.`);
  process.exit(1);
}

const out = JSON.parse(execFileSync(solc, ['--combined-json', 'abi,bin', ...CONTRACTS.map((n) => `src/${n}.sol`)], { cwd: DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
for (const name of CONTRACTS) {
  const c = out.contracts[`src/${name}.sol:${name}`];
  if (!c || !c.bin) throw new Error(`No bytecode for ${name}`);
  const abi = typeof c.abi === 'string' ? JSON.parse(c.abi) : c.abi;
  fs.writeFileSync(path.join(DIR, 'build', `${name}.json`), JSON.stringify({ contractName: name, compiler: 'solc 0.8.11', abi, bytecode: `0x${c.bin}` }));
  console.log(`  build/${name}.json (${c.bin.length / 2} bytes)`);
}
console.log('Done. Run "npm run deploy:local" (or "npm run deploy") to put the new contracts on a chain.');
