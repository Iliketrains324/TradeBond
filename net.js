/* TradeBond network client (v4.1). The browser never holds a key: it only calls this site's own server,
   which holds the AI key and the wallet keys, applies rate limits, and sends the real transactions.
   Opened as a plain file (no server), everything stays in the browser simulation. */
(function () {
  'use strict';
  const TB = (window.TB = window.TB || {});
  const served = location.protocol === 'http:' || location.protocol === 'https:';
  const N = { served, ai: false, chain: false, cfg: null, version: '4.1', booted: false };

  async function get(path) {
    const r = await fetch(path, { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { data: d, status: r.status });
    return d;
  }
  async function post(path, body, ms = 60000) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(ms) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { data: d, status: r.status });
    return d;
  }

  N.boot = async () => {
    if (N.booted) return N;
    N.booted = true;
    if (!served) return N;
    try {
      const h = await get('api/health');
      N.ai = !!h.ai;
      N.chain = !!h.chain;
      if (N.chain) N.cfg = await get('api/chain/config');
      if (!N.cfg?.enabled) N.chain = false;
    } catch (e) { N.ai = false; N.chain = false; }
    return N;
  };

  // ---- chain (every call is one or more real transactions, sent by the server with the role's own wallet) ----
  N.tx = (action, body) => post(`api/chain/${action}`, body, 120000);
  N.agent = () => get('api/chain/agent');
  N.events = () => get('api/chain/events');
  N.explorerTx = (h) => (N.cfg?.explorer && h ? `${N.cfg.explorer.replace(/\/$/, '')}/tx/${h}` : null);

  // ---- AI (the server calls the model; the browser only sees the checked result) ----
  N.readDocs = (body) => post('api/read-docs', body, 90000);
  N.order = (body) => post('api/order', body, 60000);
  N.negotiateTurn = (body) => post('api/negotiate-turn', body, 45000);
  // the server signs only messages it builds from the record (the funded terms; refund or re-ship decisions)
  N.signTerms = (tradeId) => post('api/sign/terms', { tradeId }, 30000);
  N.signTurn = (side, turn) => post('api/sign/turn', { side, ...turn }, 30000);

  // ---- demo state, kept on the server so a reload does not lose the demo ----
  const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  N.loadState = async () => {
    if (!served) return null;
    try {
      const raw = await fetch('api/state', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : null));
      if (!raw) return null;
      const d = JSON.parse(raw, (k, v) => (typeof v === 'string' && DATE.test(v) ? new Date(v) : v));
      return d && d.state ? d.state : null;
    } catch (e) { return null; }
  };
  let timer = null, lastSaved = '';
  N.saveState = (S, pick) => {
    if (!served) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const text = JSON.stringify({ state: pick(S) });
      if (text === lastSaved || text.length > 2_900_000) return;
      lastSaved = text;
      fetch('api/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text }).catch(() => { lastSaved = ''; });
    }, 800);
  };
  N.clearState = () => (served ? fetch('api/state', { method: 'DELETE' }).catch(() => {}) : Promise.resolve());

  /** SHA-256 of a canonical JSON form (sorted keys), as 0x-hex: used for order and document fingerprints. */
  const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v));
  N.canonical = canonical;
  N.fingerprint = async (v) => {
    const text = typeof v === 'string' ? v : canonical(v);
    if (!crypto.subtle) { let h = 0; for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0; return '0x' + h.toString(16).padStart(64, '0'); }
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return '0x' + Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  };
  N.fileToPart = (file) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve({ name: file.name, mime: file.type || (file.name.endsWith('.txt') ? 'text/plain' : ''), data: String(fr.result).split(',')[1] || '' });
    fr.onerror = () => reject(new Error(`Could not read ${file.name}`));
    fr.readAsDataURL(file);
  });

  TB.net = N;
})();
