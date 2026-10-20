/* Block faces: each agent is a 12×12 pixel character whose expression follows what it is doing.
   Colour and accessory identify the agent; the expression carries its state. */
(function () {
  'use strict';
  const TB = (window.TB = window.TB || {});

  const LOOK = {
    bao: { color: '#4C5FD5', accessory: 'antenna' },
    document: { color: '#1C9AA8', accessory: 'glasses' },
    payment: { color: '#B9831A', accessory: 'coin' },
    negotiation: { color: '#C24C86', accessory: 'headset' },
    seller: { color: '#9A6B47', accessory: 'cap' },
    watchdog: { color: '#5B6B82', accessory: 'ears' },
    inspector: { color: '#4E7D3A', accessory: 'hardhat' },
  };
  const MOOD_LABEL = { neutral: 'calm', happy: 'pleased', thinking: 'thinking', alert: 'alert', stern: 'stopping something', sleep: 'paused' };
  const INK = '#14213D';
  const WHITE = '#FFFFFF';
  const CHEEK = '#F29CA3';

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const mix = (c) => Math.max(0, Math.min(255, Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt)));
    const r = mix(n >> 16), g = mix((n >> 8) & 255), b = mix(n & 255);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  // Head mask: rounded block, rows 2–11 inside a 12×12 grid (rows 0–1 hold accessories).
  function inHead(x, y) {
    if (y === 2 || y === 11) return x >= 2 && x <= 9;
    return y >= 3 && y <= 10 && x >= 1 && x <= 10;
  }

  const MOODS = {
    neutral: { d: [[3, 5], [3, 6], [4, 6], [7, 5], [7, 6], [8, 6], [5, 8], [6, 8]], w: [[4, 5], [8, 5]] },
    happy: { d: [[2, 6], [3, 5], [4, 6], [7, 6], [8, 5], [9, 6], [4, 8], [7, 8], [5, 9], [6, 9]], c: [[2, 8], [9, 8]] },
    thinking: { d: [[4, 4], [4, 5], [8, 4], [8, 5], [6, 9], [7, 9]] },
    alert: { d: [[3, 4], [3, 5], [4, 5], [3, 6], [4, 6], [7, 4], [7, 5], [8, 5], [7, 6], [8, 6], [5, 8], [6, 8], [5, 9], [6, 9]], w: [[4, 4], [8, 4]] },
    stern: { d: [[3, 4], [4, 5], [8, 4], [7, 5], [3, 6], [4, 6], [7, 6], [8, 6], [4, 9], [5, 9], [6, 9], [7, 9]] },
    sleep: { d: [[3, 6], [4, 6], [7, 6], [8, 6], [5, 9], [6, 9]] },
    wink: { d: [[3, 6], [4, 6], [7, 5], [7, 6], [8, 6], [4, 8], [7, 8], [5, 9], [6, 9]], w: [[8, 5]], c: [[2, 8], [9, 8]] },
  };

  function accessory(kind, color) {
    const dark = shade(color, -0.45);
    const px = [];
    const add = (pts, c) => pts.forEach(([x, y]) => px.push([x, y, c]));
    if (kind === 'antenna') { add([[6, 1]], dark); add([[6, 0]], '#F4B740'); }
    if (kind === 'coin') { add([[5, 0], [5, 1], [6, 1]], '#F2C94C'); add([[6, 0]], WHITE); }
    if (kind === 'ears') { add([[2, 0], [2, 1], [3, 1], [9, 0], [9, 1], [8, 1]], shade(color, -0.2)); }
    if (kind === 'cap') {
      const cap = shade(color, -0.35);
      add([[3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [9, 3], [10, 3], [11, 3]], cap);
    }
    if (kind === 'hardhat') {
      add([[3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [1, 2], [10, 2]], '#F2B33D');
      add([[6, 0]], '#FFF3C4');
    }
    if (kind === 'headset') {
      add([[2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [0, 5], [0, 6], [0, 7], [11, 5], [11, 6], [11, 7]], INK);
    }
    return px;
  }

  // Glasses: a dark frame around pale lenses, drawn before the eyes so the eyes stay visible.
  function overlay(kind) {
    if (kind !== 'glasses') return [];
    const px = [];
    for (let x = 2; x <= 9; x++) { px.push([x, 4, INK]); px.push([x, 7, INK]); }
    for (const x of [2, 5, 6, 9]) { px.push([x, 5, INK]); px.push([x, 6, INK]); }
    for (const x of [3, 4, 7, 8]) { px.push([x, 5, '#DDF4F6']); px.push([x, 6, '#DDF4F6']); }
    return px;
  }

  const cache = new Map();

  /** Returns an SVG string for an agent's face. It holds two expressions: the current one, and the one it
      switches to while the cursor is over it (CSS swaps them, so hovering needs no script). */
  TB.face = function face(agentId, mood = 'neutral', size = 40, name = '') {
    const key = `${agentId}|${mood}|${size}|${name}`;
    if (cache.has(key)) return cache.get(key);
    const hover = mood === 'happy' ? 'wink' : 'happy';
    const label = `${name || agentId}, ${MOOD_LABEL[mood] || 'calm'}`;
    const svg = `<svg class="face" role="img" aria-label="${label}" width="${size}" height="${size}" viewBox="0 0 12 12" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><g class="f-base">${pixels(agentId, mood)}</g><g class="f-hover">${pixels(agentId, hover)}</g></svg>`;
    cache.set(key, svg);
    return svg;
  };

  function pixels(agentId, mood) {
    const look = LOOK[agentId] || LOOK.bao;
    const body = look.color;
    const outline = shade(body, -0.4);
    const light = shade(body, 0.35);
    const grid = new Map();
    const put = (x, y, c) => grid.set(`${x},${y}`, c);
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) {
        if (!inHead(x, y)) continue;
        const edge = !inHead(x - 1, y) || !inHead(x + 1, y) || !inHead(x, y - 1) || !inHead(x, y + 1);
        put(x, y, edge ? outline : body);
      }
    }
    [[2, 3], [3, 3], [4, 3]].forEach(([x, y]) => put(x, y, light));
    const m = MOODS[mood] || MOODS.neutral;
    overlay(look.accessory).forEach(([x, y, c]) => put(x, y, c));
    (m.c || []).forEach(([x, y]) => put(x, y, CHEEK));
    (m.d || []).forEach(([x, y]) => put(x, y, INK));
    (m.w || []).forEach(([x, y]) => put(x, y, look.accessory === 'glasses' ? '#9FDDE3' : WHITE));
    accessory(look.accessory, body).forEach(([x, y, c]) => put(x, y, c));
    let rects = '';
    for (const [k, c] of grid) {
      const [x, y] = k.split(',');
      rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${c}"/>`;
    }
    return rects;
  }
  TB.faceLook = LOOK;
})();
