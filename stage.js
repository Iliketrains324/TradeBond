/* TradeBond trade stage: the isometric scene in the centre of the App view.
   It always shows the real state of a trade from TB.S: which step it is on, what is waiting, and the numbers.
   The artwork (stage-art.js) carries the mood; every fact is written as text on the cards. */
(function () {
  'use strict';
  const TB = window.TB;
  const S = TB.S;
  const { SELLER } = TB.sim;
  const { fY, fYs, fN, esc, r2, niceDate } = TB.fmt;

  const LABELS = ['Funded', 'Shipped', 'Documents checked', 'Arrived', 'Paid', 'Settled', 'Closed'];
  const SHORT = ['Funded', 'Shipped', 'Documents', 'Arrived', 'Paid', 'Settled', 'Closed'];
  const ST = { sel: null, view: null, built: false, sig: {}, trades: 0, live: '' };

  // ---------- which trade, which step ----------
  function trade() {
    if (ST.sel) { const t = TB.sim.tradeById(ST.sel); if (t) return t; }
    const list = S.trades;
    return [...list].reverse().find((t) => !['closed', 'stopped'].includes(t.status)) || list[list.length - 1] || null;
  }
  const rows = (t) => S.ledger.filter((r) => r.trade === t.id);
  const blocked = (t) => rows(t).find((r) => r.action.startsWith('Payment request') && r.result.kind === 'block');
  const rejected = (t) => rows(t).find((r) => r.action === 'Owner rejects');
  const held = (t) => r2(t.total - t.released - t.refunded);
  function liveStep(t) {
    if (t.status === 'stopped' && (blocked(t) || rejected(t))) return 4; // stopped at the referee gate
    if (['closed', 'stopped'].includes(t.status)) return 6;
    const i = t.steps.findIndex((s) => s[2] !== 'done' && s[2] !== 'na');
    return i < 0 ? 6 : i;
  }

  // ---------- what the cards say ----------
  // pill: [colour, word]. Colours: amber, cyan, green, blue, red, grey. The word always carries the meaning.
  function statusPill(t, i, live) {
    const st = t.steps[i][2];
    if (i !== live) return st === 'na' ? ['grey', 'Skipped'] : st === 'blocked' ? ['red', 'Stopped'] : ['green', 'Done'];
    const s = t.status;
    if (s === 'closed') return ['green', 'Closed'];
    if (s === 'stopped') return blocked(t) ? ['red', 'Refused'] : rejected(t) ? ['red', 'Rejected'] : ['red', 'Stopped'];
    if (s === 'waiting-owner') return ['amber', 'Awaiting Approval'];
    if (s === 'waiting-documents') return ['amber', 'Missing document'];
    if (s === 'waiting-limit') return ['amber', 'Over daily limit'];
    if (s === 'paused') return ['amber', 'Paused by you'];
    if (s === 'interrupted') return ['amber', 'Stopped mid-step'];
    if (s === 'escalated') return ['amber', 'Your decision'];
    if (s === 'reship') return ['blue', 'Re-ship agreed'];
    return [['amber', 'Locking'], ['cyan', 'In transit'], ['cyan', 'Checking'], ['green', 'Counting'], ['amber', 'Releasing'], ['blue', 'Negotiating'], ['green', 'Closing']][i];
  }

  function title(t, i, live) {
    const s = t.status;
    const f = t.check?.findings || [];
    const atLive = i === live;
    switch (i) {
      case 0: return atLive ? 'Locking money in escrow' : 'Money locked in escrow';
      case 1: return atLive ? 'Cargo is in transit' : 'Cargo delivered to port';
      case 2:
        if (t.check?.missing.length) return `The ${t.check.missing.join(' and ')} is missing`;
        if (!t.check) return 'Verifying the shipping papers';
        return f.length ? `${f.length} thing${f.length === 1 ? " doesn't" : "s don't"} match` : 'The papers agree with the order';
      case 3: return t.settlement ? (t.settlement.held > 0 ? 'Short delivery: part is held back' : 'Everything arrived') : 'Counting what arrived';
      case 4:
        if (atLive && s === 'waiting-owner') return 'Awaiting Approval';
        if (atLive && s === 'paused') return 'Payments are paused by you';
        if (atLive && s === 'waiting-limit') return "Over today's limit: payment waits";
        if (blocked(t)) return 'The contract refused a payment';
        if (rejected(t)) return 'You rejected the payment';
        return t.released > 0 ? `${SELLER.short} has been paid` : 'Paying the seller';
      case 5:
        if (s === 'escalated') return 'No agreement: your decision';
        if (s === 'reship') return 'Re-shipment agreed';
        return t.negotiation?.outcome === 'refund' ? 'Refund agreed by both agents' : 'Agents settle the difference';
      default: return s === 'stopped' ? 'Trade stopped' : atLive && s !== 'closed' ? 'Closing the trade' : 'Trade complete';
    }
  }

  function amount(t, i) {
    const s = t.settlement;
    switch (i) {
      case 0: return fY(t.total);
      case 1: return `ETA ${niceDate(new Date(Date.parse(t.order.departure + 'T00:00:00Z') + t.order.transitDays * 864e5).toISOString().slice(0, 10))}`;
      case 2: return `${t.docs ? t.docs.length : 0} of 3 files`;
      case 3: return s ? `${fN(s.lines.reduce((a, l) => a + l.received, 0))} of ${fN(s.lines.reduce((a, l) => a + l.qty, 0))}` : 'Counting';
      case 4: return S.pending && S.pending.trade === t.id ? fY(S.pending.amount) : blocked(t) ? fY(blocked(t).amount) : rejected(t) ? fY(rejected(t).amount) : fY(t.released || t.verified);
      case 5: return fY(t.settlement ? t.settlement.held : 0);
      default: return fY(t.released);
    }
  }

  // ledger rows: [label, value, tone]; tone up / dn / wa (warning) / ''
  function ledger(t, i) {
    const s = t.settlement;
    switch (i) {
      case 0: return [['Buyer wallet', `−${fYs(t.total)}`, 'dn'], ['Escrow vault', `+${fYs(t.total)}`, 'up'], ['Payment terms', t.terms ? 'one payment on verified delivery' : '—', ''], ['Signed by', 'you and the seller\'s agent', 'up']];
      case 1: return [['Vessel', t.order.vessel, ''], ['Route', `${t.order.route.load} → ${t.order.route.discharge}`, ''], ['Escrow', `${fYs(held(t))} held`, '']];
      case 2: {
        if (!t.docs) return [['Seller documents', 'not yet received', '']];
        const f = t.check?.findings || [];
        const out = [['Read by', t.read?.by === 'ai' ? 'the live AI' : 'built-in reader', '']];
        out.push(...[['commercial_invoice', 'Invoice'], ['bill_of_lading', 'Bill of lading'], ['packing_list', 'Packing list']].map(([k, name]) => {
          if (!t.docs.some((d) => d.kind === k)) return [name, 'missing', 'dn'];
          const flagged = f.some((x) => (x.kind === 'qty' && (k === 'packing_list' ? x.cells?.packing_list : k === 'commercial_invoice' && !x.cells?.packing_list)) || (x.kind === 'price' && k === 'commercial_invoice') || (x.kind === 'date' && k === 'bill_of_lading'));
          return [name, flagged ? 'flagged' : 'passed', flagged ? 'wa' : 'up'];
        }));
        if (f.some((x) => x.kind === 'hidden')) out.push(['Hidden instruction', 'quoted and ignored', 'dn']);
        if (f.length) out.push(['Any payment', 'needs your approval', 'wa']);
        return out;
      }
      case 3: {
        if (!s) return [['Inspection', 'in progress', '']];
        const ord = s.lines.reduce((a, l) => a + l.qty, 0), rec = s.lines.reduce((a, l) => a + l.received, 0), dmg = s.lines.reduce((a, l) => a + l.damaged, 0);
        const out = [['Ordered', fN(ord), ''], ['Arrived', fN(rec), rec >= ord ? 'up' : 'wa'], ['Short', fN(Math.max(0, ord - rec)), ord - rec > 0 ? 'dn' : '']];
        if (dmg) out.push(['Damaged', fN(dmg), 'wa']);
        out.push(['Counted by', 'independent inspector', 'up']);
        out.push(['Payable (worked out by the contract)', fYs(s.payable), 'up']);
        return out;
      }
      case 4: {
        const out = [['Seller of record', 'verified', 'up'], ['Agreed terms', 'one payment on verified delivery', '']];
        if (S.pending && S.pending.trade === t.id) out.push(['Awaiting Approval', fYs(S.pending.amount), 'wa']);
        const b = blocked(t);
        if (b) out.push(['Refused', b.result.text.replace(/^Blocked by contract: /, ''), 'dn']);
        if (rejected(t)) out.push(['Rejected by you', fYs(rejected(t).amount), 'dn']);
        out.push(['Released from escrow', t.released ? `−${fYs(t.released)}` : 'nothing yet', t.released ? 'dn' : '']);
        out.push(['Paid to seller', t.released ? `+${fYs(t.released)}` : 'nothing yet', t.released ? 'up' : '']);
        return out;
      }
      case 5: {
        const n = t.negotiation;
        const issue = s?.shortfall.length ? s.shortfall.map((x) => `${fN(x.qty)} short`).join(', ') : s?.held ? 'price difference' : 'nothing held';
        const outcome = !n ? (s && s.held > 0 ? 'starting' : 'not needed') : n.outcome === 'refund' ? 'refund' : n.outcome === 'reship' ? 're-ship' : n.outcome === 'escalate' ? 'passed to you' : `round ${Math.min(n.turns.length, 6)}`;
        return [['Amount held', fYs(s ? s.held : 0), s && s.held ? 'wa' : ''], ['Issue', issue, ''], ['Outcome', outcome, n?.outcome === 'refund' || n?.outcome === 'reship' ? 'up' : '']];
      }
      default: {
        const diff = t.creditAfter != null ? t.creditAfter - t.creditBefore : 0;
        return [['Paid to seller', fYs(t.released), t.released ? 'up' : ''], ['Refunded to you', fYs(t.refunded), ''], ['Trade credit', diff > 0 ? `+${diff} points` : 'unchanged', diff > 0 ? 'up' : '']];
      }
    }
  }

  // ---------- DOM ----------
  const $ = (s, el = document) => el.querySelector(s);
  function build(el) {
    el.innerHTML = `
      <div class="stage-head">
        <div><h2>Trade stage</h2><span class="sub" id="tbs-sub"></span></div>
        <div class="stage-head-r" id="tbs-headr"></div>
      </div>
      <div class="tbs-tabs" id="tbs-tabs" role="group" aria-label="Steps of this trade"></div>
      <div class="tbs-wrap">
        <div class="tbs" id="tbs">
          ${TB.stageArt}
          <div class="tbs-stamp" id="tbs-stamp" hidden></div>
        </div>
        <div class="tbs-side">
          <div class="tbs-card tbs-status" id="tbs-status"></div>
          <div class="tbs-card tbs-ledger" id="tbs-ledger"></div>
        </div>
      </div>
      <p class="vh" id="tbs-live" aria-live="polite" aria-atomic="true"></p>`;
    ST.built = true;
    ST.sig = {};
    motion();
  }
  // Reduced motion: CSS stops the CSS animations; the SVG's own animations are paused here.
  const RMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  function motion() {
    const svg = document.querySelector('.tbs-art');
    if (!svg || !svg.pauseAnimations) return;
    if (RMQ.matches) svg.pauseAnimations(); else svg.unpauseAnimations();
  }
  RMQ.addEventListener?.('change', motion);
  function put(id, html) {
    if (ST.sig[id] === html) return;
    ST.sig[id] = html;
    const el = document.getElementById(id);
    const focused = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
    el.innerHTML = html;
    if (focused) { const f = el.querySelector(`[data-fk="${focused}"]`); if (f) f.focus(); }
  }

  function render(el) {
    if (!el) return;
    if (!ST.built || !el.querySelector('#tbs')) build(el);
    ST.trades = S.trades.length;
    const t = trade();
    const stage = $('#tbs');
    const scenes = stage.querySelectorAll('.sc');

    if (!t) {
      stage.classList.add('idle');
      stage.classList.remove('refused', 'hold');
      document.getElementById('tbs-stamp').hidden = true;
      scenes.forEach((g, j) => g.classList.toggle('on', j === 0));
      put('tbs-sub', 'No trade yet');
      put('tbs-headr', '');
      put('tbs-tabs', SHORT.map((l, j) => `<button type="button" disabled>${j + 1} ${l}</button>`).join(''));
      const draftId = Object.keys(S.drafts).pop();
      const draft = draftId ? S.drafts[draftId] : null;
      put('tbs-status', draft
        ? `<p class="tbs-kicker">Order ready</p><h3 class="tbs-title">${fN(draft.lines.length)} line${draft.lines.length === 1 ? '' : 's'} for ${esc(SELLER.short)}</h3><div class="tbs-amount"><b>${fY(TB.sim.orderTotal(draft))}</b><span class="tbs-pill cyan"><i></i>Ready</span></div>
           <div class="tbs-actions"><button class="btn sm primary" type="button" data-act="start" data-draft="${draftId}" data-fk="tbs-start" ${TB.sim.canStart(draft).ok && !S.busy ? '' : 'disabled'}>Start trade</button></div>`
        : `<p class="tbs-kicker">No trade yet</p><h3 class="tbs-title">Ready when you are</h3><p class="tbs-text">Tell Bao what to buy, or attach a purchase order. Each step will play out here.</p>
           <div class="tbs-actions"><button class="btn sm primary" type="button" data-act="attach-example" data-fk="tbs-example">Use the example purchase order</button></div>`);
      put('tbs-ledger', '<p class="tbs-kicker">Ledger</p><div class="tbs-row"><span>Escrow vault</span><b>¥0</b></div><div class="tbs-row"><span>Your balance</span><b>' + fYs(S.wallet.balance) + '</b></div>');
      setLive('No trade yet. Tell Bao what to buy, or attach a purchase order.');
      return;
    }

    stage.classList.remove('idle');
    const live = liveStep(t);
    if (ST.view != null && ST.view > live) ST.view = null;
    const i = ST.view ?? live;
    scenes.forEach((g, j) => g.classList.toggle('on', j === i));
    // Scene mood follows the record: money only flows in the picture when it really flows.
    let mood = '', stamp = null;
    if (i === 4 && (blocked(t) || rejected(t))) { mood = 'refused'; stamp = ['red', blocked(t) ? '✕ Refused by the contract' : '✕ Rejected by you']; }
    else if (i === live && i === 4 && S.pending && S.pending.trade === t.id) { mood = 'hold'; stamp = ['amber', '◐ Awaiting Approval']; }
    else if (i === live && t.status === 'paused') { mood = 'hold'; stamp = ['amber', 'Ⅱ Paused by you']; }
    else if (i === live && t.status === 'waiting-limit') { mood = 'hold'; stamp = ['amber', '◐ Over the daily limit']; }
    else if (i === live && t.status === 'waiting-documents') { mood = 'hold'; stamp = ['amber', '✕ Document missing']; }
    else if (i === 4 && t.released === 0) mood = 'hold';
    stage.classList.toggle('refused', mood === 'refused');
    stage.classList.toggle('hold', mood === 'hold');
    const st = document.getElementById('tbs-stamp');
    st.hidden = !stamp;
    if (stamp) { st.className = `tbs-stamp ${stamp[0]}`; st.textContent = stamp[1]; }
    stage.querySelectorAll('[data-tid]').forEach((n) => { n.textContent = `${t.id} · ESCROW`; });

    const [sk, sw] = TB.ui.statusOf(t);
    put('tbs-sub', `${t.id} · ${fY(t.total)}${t.purpose === 'attack' ? ' · attack test (simulated)' : ''}`);
    put('tbs-headr', `${TB.ui.pill(sk, sw)}${ST.view != null ? '<button type="button" class="btn sm" data-act="stage-live" data-fk="tbs-live-b">Back to live</button>' : ''}`);
    put('tbs-tabs', LABELS.map((l, j) => {
      const st = t.steps[j][2];
      const reach = j <= live;
      const mark = j === live && !['closed', 'stopped'].includes(t.status) ? '<span class="tbs-now" aria-hidden="true"></span>' : '';
      const word = j === live ? 'now' : st === 'done' ? 'done' : st === 'na' ? 'skipped' : st === 'blocked' ? 'stopped' : 'not yet';
      return `<button type="button" data-act="stage-step" data-i="${j}" data-fk="tbs-tab-${j}" aria-pressed="${j === i}" ${reach ? '' : 'disabled'} aria-label="Step ${j + 1}, ${l}, ${word}">${mark}${j + 1} ${SHORT[j]}</button>`;
    }).join(''));

    const [pc, pw] = statusPill(t, i, live);
    const waiting = i === live && S.pending && S.pending.trade === t.id;
    const actions = waiting
      ? `<div class="tbs-actions"><button class="btn sm approve" type="button" data-act="approve" data-id="${S.pending.id}" data-fk="tbs-approve">Approve ${fY(S.pending.amount)}</button><button class="btn sm danger" type="button" data-act="reject" data-id="${S.pending.id}" data-fk="tbs-reject">Reject</button></div>`
      : i === live && ['escalated', 'reship', 'waiting-documents', 'waiting-limit'].includes(t.status)
        ? `<div class="tbs-actions"><button class="btn sm" type="button" data-act="owner-close" data-trade="${t.id}" data-fk="tbs-close">Close and refund ${fY(held(t))}</button></div>`
        : i === live && t.status === 'paused' ? '<div class="tbs-actions"><button class="btn sm primary" type="button" data-act="resume" data-fk="tbs-resume">Resume payments</button></div>' : '';
    put('tbs-status', `<p class="tbs-kicker">Step ${i + 1} of 7 · ${LABELS[i]}</p><h3 class="tbs-title">${esc(title(t, i, live))}</h3>
      <div class="tbs-amount"><b>${esc(amount(t, i))}</b><span class="tbs-pill ${pc}"><i></i>${pw}</span></div>
      <div class="tbs-steps" aria-hidden="true">${LABELS.map((_, j) => `<i class="${j < live || (j === live && ['closed', 'stopped'].includes(t.status)) ? 'on' : j === live ? 'cur' : ''}"></i>`).join('')}</div>${actions}`);
    put('tbs-ledger', `<p class="tbs-kicker">Ledger${ST.view != null ? ' · earlier step' : ''}</p>` + ledger(t, i).map(([a, b, c]) => `<div class="tbs-row"><span>${esc(a)}</span><b class="${c}">${esc(b)}</b></div>`).join(''));
    setLive(`${t.id}: step ${i + 1} of 7, ${LABELS[i]}. ${title(t, i, live)}. ${pw}.`);
  }
  function setLive(text) {
    if (text === ST.live) return;
    ST.live = text;
    const n = document.getElementById('tbs-live');
    if (n) n.textContent = text;
  }

  TB.stage = {
    render,
    current: () => trade()?.id || null,
    reset() { ST.built = false; ST.sel = null; ST.view = null; ST.trades = 0; },
    select(id) { ST.sel = id; ST.view = null; },
    step(i) { const t = trade(); ST.view = t && i === liveStep(t) ? null : i; },
    live() { ST.view = null; },
  };
})();
