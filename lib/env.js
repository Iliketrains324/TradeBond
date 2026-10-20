/* Reads settings from .env next to server.js. Keys and secrets live only there (never in browser files). */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// ENV_FILE picks another settings file, e.g. .env.fisco for the FISCO BCOS chain (npm run start:fisco)
const ENV_FILE = process.env.ENV_FILE ? path.resolve(ROOT, process.env.ENV_FILE) : path.join(ROOT, '.env');

function load() {
  if (!fs.existsSync(ENV_FILE)) return;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if (/^["']/.test(v)) v = v.replace(/^(["'])(.*)\1.*$/, '$2');
    else v = v.replace(/(^|\s+)#.*$/, '').trim(); // "VALUE   # comment"
    process.env[m[1]] = v;
  }
}

/** Set or replace keys in .env, keeping everything else (used by deploy.js). */
function save(values) {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^\\s*${k}\\s*=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : text + (text && !text.endsWith('\n') ? '\n' : '') + line + '\n';
    process.env[k] = String(v);
  }
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
}

const has = (k) => {
  const v = (process.env[k] || '').trim();
  return v.length > 0 && !v.includes('...');
};

module.exports = { ROOT, ENV_FILE, load, save, has };
