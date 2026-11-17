// Automated backtesting engine. Everything lives inside makeEngine() so it can run in a Web Worker built from its own
// source text (no imports, no outside names) — and be called directly in tests.
//
// Honesty rules the engine enforces:
//   · a signal is read on a bar that has closed, and the order fills at the NEXT 1-minute bar's open (no look-ahead)
//   · stops and targets are checked on 1-minute bars; a bar that reaches both counts as the stop; a gap fills at the open
//   · market orders and stops pay slippage (ticks per side); targets are limit orders (no slippage); commission per contract
//   · indicators only use bars up to the one being read; prior-day levels come from finished days

export function makeEngine() {
  const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric' });

  // ------------------------------------------------------------------------------------------- data preparation
  /** Adds per-bar local minute-of-day, New York minute-of-day and trading-day number (a day starts 6 PM New York). */
  function prep(d) {
    if (d.__prep) return d;
    const n = d.t.length;
    const lmin = new Int16Array(n), nymin = new Int16Array(n), tday = new Int32Array(n), wday = new Int8Array(n);
    const hourCache = new Map();
    for (let i = 0; i < n; i++) {
      const t = d.t[i];
      const dt = new Date(t * 1000);
      lmin[i] = dt.getHours() * 60 + dt.getMinutes();
      const hk = Math.floor(t / 3600);
      let ny = hourCache.get(hk);
      if (!ny) {
        const parts = {};
        for (const p of NY.formatToParts(new Date(hk * 3600 * 1000))) parts[p.type] = p.value;
        const h = Number(parts.hour) % 24;
        // trading day: New York date, plus one after 6 PM (the evening session belongs to the next day)
        const base = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000;
        ny = { h, day: base + (h >= 18 ? 1 : 0) };
        hourCache.set(hk, ny);
      }
      nymin[i] = ny.h * 60 + dt.getUTCMinutes() % 60;
      tday[i] = ny.day;
      wday[i] = new Date(ny.day * 86400000).getUTCDay();
    }
    return Object.assign(d, { lmin, nymin, tday, wday, __prep: true, cache: new Map() });
  }

  /** tf-minute bars from the 1-minute data: { o,h,l,c,v,t, end (last 1m index), lmin (local minute at close), tday } */
  function frames(d, tf) {
    const key = `tf|${tf}`;
    if (d.cache.has(key)) return d.cache.get(key);
    const n = d.t.length;
    const o = [], h = [], l = [], c = [], v = [], t = [], end = [], cl = [], td = [], first = [];
    let cur = null;
    for (let i = 0; i < n; i++) {
      const k = d.tday[i] * 2000 + Math.floor(d.lmin[i] / tf);
      if (k !== cur) {
        cur = k;
        o.push(d.o[i]); h.push(d.h[i]); l.push(d.l[i]); c.push(d.c[i]); v.push(d.v[i]); t.push(d.t[i]); end.push(i); td.push(d.tday[i]); first.push(i);
        cl.push((d.lmin[i] + 1) % 1440);
      } else {
        const j = o.length - 1;
        if (d.h[i] > h[j]) h[j] = d.h[i];
        if (d.l[i] < l[j]) l[j] = d.l[i];
        c[j] = d.c[i]; v[j] += d.v[i]; end[j] = i; cl[j] = (d.lmin[i] + 1) % 1440;
      }
    }
    const f = { o, h, l, c, v, t, end, cl, td, first, n: o.length, cache: new Map() };
    d.cache.set(key, f);
    return f;
  }

  // ------------------------------------------------------------------------------------------- indicators (on frames)
  const NaNs = (n) => new Float64Array(n).fill(NaN);
  function ema(src, n) { const out = NaNs(src.length); const k = 2 / (n + 1); let e = NaN, sum = 0; for (let i = 0; i < src.length; i++) { if (i < n) { sum += src[i]; if (i === n - 1) { e = sum / n; out[i] = e; } continue; } e = src[i] * k + e * (1 - k); out[i] = e; } return out; }
  function sma(src, n) { const out = NaNs(src.length); let sum = 0; for (let i = 0; i < src.length; i++) { sum += src[i]; if (i >= n) sum -= src[i - n]; if (i >= n - 1) out[i] = sum / n; } return out; }
  function stdev(src, n) { const out = NaNs(src.length); for (let i = n - 1; i < src.length; i++) { let m = 0; for (let k = i - n + 1; k <= i; k++) m += src[k]; m /= n; let s = 0; for (let k = i - n + 1; k <= i; k++) s += (src[k] - m) ** 2; out[i] = Math.sqrt(s / n); } return out; }
  function rsi(src, n) { const out = NaNs(src.length); let g = 0, l = 0; for (let i = 1; i < src.length; i++) { const ch = src[i] - src[i - 1]; const up = Math.max(ch, 0), dn = Math.max(-ch, 0); if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } continue; } g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return out; }
  function atr(f, n) { const out = NaNs(f.n); let a = NaN, sum = 0; for (let i = 0; i < f.n; i++) { const tr = i ? Math.max(f.h[i] - f.l[i], Math.abs(f.h[i] - f.c[i - 1]), Math.abs(f.l[i] - f.c[i - 1])) : f.h[i] - f.l[i]; if (i < n) { sum += tr; if (i === n - 1) { a = sum / n; out[i] = a; } continue; } a = (a * (n - 1) + tr) / n; out[i] = a; } return out; }

  /** Per trading day values: VWAP so far, day open (first bar at/after 9:30 NY), high / low so far, opening range,
   *  prior day high / low / close. Built from 1-minute bars, read at each frame's last 1-minute bar. */
  function dayInfo(d) {
    if (d.cache.has('day')) return d.cache.get('day');
    const n = d.t.length;
    const vwap = new Float64Array(n), dOpen = NaNs(n), dHigh = new Float64Array(n), dLow = new Float64Array(n), pdh = NaNs(n), pdl = NaNs(n), pdc = NaNs(n);
    let day = null, pv = 0, vv = 0, hi = -Infinity, lo = Infinity, open = NaN, prev = null, last = null;
    for (let i = 0; i < n; i++) {
      if (d.tday[i] !== day) {
        if (day !== null) prev = { h: hi, l: lo, c: d.c[i - 1] };
        day = d.tday[i]; pv = 0; vv = 0; hi = -Infinity; lo = Infinity; open = NaN;
      }
      const tp = (d.h[i] + d.l[i] + d.c[i]) / 3, vol = d.v[i] || 1;
      pv += tp * vol; vv += vol;
      vwap[i] = pv / vv;
      if (d.h[i] > hi) hi = d.h[i];
      if (d.l[i] < lo) lo = d.l[i];
      if (Number.isNaN(open) && d.nymin[i] >= 570 && d.nymin[i] < 960) open = d.o[i];
      dOpen[i] = open; dHigh[i] = hi; dLow[i] = lo;
      if (prev) { pdh[i] = prev.h; pdl[i] = prev.l; pdc[i] = prev.c; }
      last = i;
    }
    const out = { vwap, dOpen, dHigh, dLow, pdh, pdl, pdc, last };
    d.cache.set('day', out);
    return out;
  }
  /** Opening range (first `mins` minutes from 9:30 New York) high / low, known once the range is complete. */
  function openingRange(d, mins) {
    const key = `or|${mins}`;
    if (d.cache.has(key)) return d.cache.get(key);
    const n = d.t.length;
    const H = NaNs(n), L = NaNs(n);
    let day = null, hi = -Infinity, lo = Infinity, done = false;
    for (let i = 0; i < n; i++) {
      if (d.tday[i] !== day) { day = d.tday[i]; hi = -Infinity; lo = Infinity; done = false; }
      const m = d.nymin[i];
      if (m >= 570 && m < 570 + mins) { if (d.h[i] > hi) hi = d.h[i]; if (d.l[i] < lo) lo = d.l[i]; }
      if (!done && m >= 570 + mins && hi > -Infinity) done = true;
      if (done) { H[i] = hi; L[i] = lo; }
    }
    const out = { H, L };
    d.cache.set(key, out);
    return out;
  }

  /** The series an operand reads, as a Float64Array over frames (cached). */
  function series(d, f, op, P) {
    const num = (x) => (x && typeof x === 'object' && 'p' in x ? Number(P[x.p]) : Number(x));
    const n = Math.max(1, Math.round(num(op.n) || 14));
    const key = `${op.k}|${n}|${op.k === 'bbu' || op.k === 'bbl' ? num(op.m) || 2 : ''}`;
    if (f.cache.has(key)) return f.cache.get(key);
    let out;
    const at1m = (arr) => { const o = NaNs(f.n); for (let i = 0; i < f.n; i++) o[i] = arr[f.end[i]]; return o; };
    switch (op.k) {
      case 'close': out = Float64Array.from(f.c); break;
      case 'open': out = Float64Array.from(f.o); break;
      case 'high': out = Float64Array.from(f.h); break;
      case 'low': out = Float64Array.from(f.l); break;
      case 'ema': out = ema(f.c, n); break;
      case 'sma': out = sma(f.c, n); break;
      case 'rsi': out = rsi(f.c, n); break;
      case 'atr': out = atr(f, n); break;
      case 'bbu': case 'bbl': { const m = sma(f.c, n), s = stdev(f.c, n), k = num(op.m) || 2; out = NaNs(f.n); for (let i = 0; i < f.n; i++) out[i] = m[i] + (op.k === 'bbu' ? k : -k) * s[i]; break; }
      case 'vwap': out = at1m(dayInfo(d).vwap); break;
      case 'dayOpen': out = at1m(dayInfo(d).dOpen); break;
      case 'dayHigh': out = at1m(dayInfo(d).dHigh); break;
      case 'dayLow': out = at1m(dayInfo(d).dLow); break;
      case 'pdHigh': out = at1m(dayInfo(d).pdh); break;
      case 'pdLow': out = at1m(dayInfo(d).pdl); break;
      case 'pdClose': out = at1m(dayInfo(d).pdc); break;
      case 'orHigh': out = at1m(openingRange(d, n).H); break;
      case 'orLow': out = at1m(openingRange(d, n).L); break;
      default: out = NaNs(f.n);
    }
    f.cache.set(key, out);
    return out;
  }
  function operand(d, f, op, P) {
    if (op.k === 'value') { const v = op.v && typeof op.v === 'object' && 'p' in op.v ? Number(P[op.v.p]) : Number(op.v); return { at: () => v }; }
    const s = series(d, f, op, P);
    const off = op.off ? Number(op.off) : 0; // value `off` points away from it (e.g. orHigh + 2 ticks), in price
    return { at: (i) => (i < 0 ? NaN : s[i] + off) };
  }
  function compileConds(d, f, conds, P) {
    const list = (conds || []).filter((c) => c && c.a && c.b).map((c) => ({ a: operand(d, f, c.a, P), b: operand(d, f, c.b, P), op: c.op }));
    return (i) => {
      for (const c of list) {
        const a = c.a.at(i), b = c.b.at(i);
        if (Number.isNaN(a) || Number.isNaN(b)) return false;
        if (c.op === '>' && !(a > b)) return false;
        if (c.op === '<' && !(a < b)) return false;
        if (c.op === 'xa' || c.op === 'xb') {
          const a0 = c.a.at(i - 1), b0 = c.b.at(i - 1);
          if (Number.isNaN(a0) || Number.isNaN(b0)) return false;
          if (c.op === 'xa' && !(a0 <= b0 && a > b)) return false;
          if (c.op === 'xb' && !(a0 >= b0 && a < b)) return false;
        }
      }
      return list.length > 0;
    };
  }
  const anyOf = (d, f, conds, P) => { const fs = (conds || []).filter((c) => c && c.a && c.b).map((c) => compileConds(d, f, [c], P)); return (i) => fs.some((g) => g(i)); };

  /** A code strategy: the user's `function onBar(bar, i, ctx)` → 'buy' | 'sell' | 'exit' | { action, stop, target } | null */
  function compileCode(src, d, f, P) {
    // eslint-disable-next-line no-new-func
    const make = new Function('params', `"use strict";\n${src}\n;return typeof onBar === 'function' ? onBar : null;`);
    const fn = make(P);
    if (!fn) throw new Error('Define a function called onBar(bar, i, ctx).');
    const ser = (k, n, m) => series(d, f, { k, n, m }, P);
    const ctx = {
      params: P, open: f.o, high: f.h, low: f.l, close: f.c, volume: f.v, time: f.cl, n: f.n,
      ema: (n) => ser('ema', n), sma: (n) => ser('sma', n), rsi: (n) => ser('rsi', n), atr: (n) => ser('atr', n),
      bbUpper: (n, m = 2) => ser('bbu', n, m), bbLower: (n, m = 2) => ser('bbl', n, m), vwap: () => ser('vwap'),
      orHigh: (mins) => ser('orHigh', mins), orLow: (mins) => ser('orLow', mins), pdHigh: () => ser('pdHigh'), pdLow: () => ser('pdLow'), pdClose: () => ser('pdClose'),
      dayOpen: () => ser('dayOpen'), dayHigh: () => ser('dayHigh'), dayLow: () => ser('dayLow'),
      crossAbove: (a, b, i) => a[i - 1] <= (typeof b === 'number' ? b : b[i - 1]) && a[i] > (typeof b === 'number' ? b : b[i]),
      crossBelow: (a, b, i) => a[i - 1] >= (typeof b === 'number' ? b : b[i - 1]) && a[i] < (typeof b === 'number' ? b : b[i]),
      position: 0, barsInTrade: 0, tradesToday: 0, entryPrice: NaN,
    };
    return { fn, ctx };
  }

  // ------------------------------------------------------------------------------------------- the run
  const hm = (s) => { if (!s) return null; const [h, m] = String(s).split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; };
  function rng(seed) { let a = seed >>> 0 || 1; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  /**
   * One backtest. spec = { tf, side, mode: 'rules' | 'code', long: [conds], short: [conds], exitWhen: [conds], code,
   *   entry: { type: 'market'|'stop'|'limit', off (ticks), expire (bars) },
   *   stop: { type: 'ticks'|'points'|'atr'|'none', v, n }, target: { type: 'ticks'|'points'|'atr'|'r'|'none', v, n },
   *   trail: { type: 'none'|'ticks'|'atr', v, n }, be: { type: 'none'|'ticks'|'r', v, plus },
   *   sizing: { type: 'fixed'|'risk', risk, max }, path: 'worst' | 'ohlc',
   *   maxBars, entryFrom, entryTo, flatAt, flatEod, maxTradesDay, days: [0..6], reverse, qty, fee, slip, tick, pv }
   * P = parameter values. range = { from, to } unix seconds (signals and entries only inside it).
   * opts.random = { p, longShare, seed } replaces the entry rules with random entries (the baseline check).
   *
   * Fills: market orders at the next 1-minute open (+ slippage); stop entries when a 1-minute bar trades through the level
   * (at the level, or the open on a gap, + slippage); limit entries when price trades at the level or better (no slippage).
   * A bar that reaches both stop and target: 'worst' counts the stop; 'ohlc' follows TradingView's broker emulator
   * (open nearer the high → open, high, low, close; else open, low, high, close). Trailing stops and break-even moves
   * use a bar's high / low only after that bar has been checked against the old stop.
   */
  function run(d0, spec, P = {}, range = {}, opts = {}) {
    const d = prep(d0);
    const tf = Math.max(1, Number(spec.tf) || 1);
    const f = frames(d, tf);
    const tick = Number(spec.tick) || 0.25, pv = Number(spec.pv) || 1;
    const num = (x, def = 0) => { const v = x && typeof x === 'object' && 'p' in x ? Number(P[x.p]) : Number(x); return Number.isFinite(v) ? v : def; };
    const slip = num(spec.slip, 0) * tick, fee = num(spec.fee, 0), qty0 = Math.max(1, Math.round(num(spec.qty, 1)));
    const from = range.from ?? -Infinity, to = range.to ?? Infinity;
    const eFrom = hm(spec.entryFrom), eTo = hm(spec.entryTo), flat = hm(spec.flatAt);
    const days = new Set(spec.days?.length ? spec.days : [0, 1, 2, 3, 4, 5, 6]);
    const maxDay = num(spec.maxTradesDay, 0);
    const maxBars = num(spec.maxBars, 0);
    const entryType = spec.entry?.type || 'market', entryOff = num(spec.entry?.off, 0) * tick, expire = Math.max(1, num(spec.entry?.expire, 1));
    const trail = spec.trail?.type && spec.trail.type !== 'none' ? spec.trail : null;
    const be = spec.be?.type && spec.be.type !== 'none' ? spec.be : null;
    const ohlcPath = spec.path === 'ohlc';
    const sideOk = (dir) => spec.side !== (dir > 0 ? 'short' : 'long');
    let longSig = () => false, shortSig = () => false, exitSig = () => false, code = null;
    if (spec.mode === 'code' && !opts.random) code = compileCode(spec.code || '', d, f, P);
    else if (!opts.random) { longSig = compileConds(d, f, spec.long, P); shortSig = compileConds(d, f, spec.short, P); exitSig = anyOf(d, f, spec.exitWhen, P); }
    else exitSig = spec.mode === 'code' ? () => false : anyOf(d, f, spec.exitWhen, P);
    const atrN = num(spec.stop?.type === 'atr' ? spec.stop.n : spec.target?.type === 'atr' ? spec.target.n : trail?.type === 'atr' ? trail.n : 14, 14) || 14;
    const atrS = [spec.stop?.type, spec.target?.type, trail?.type].includes('atr') ? series(d, f, { k: 'atr', n: atrN }, P) : null;
    const R = opts.random ? rng(opts.random.seed) : null;
    const inWindow = (m) => (eFrom == null || (eFrom <= (eTo ?? 1440) ? m >= eFrom : m >= eFrom || m < (eTo ?? 0))) && (eTo == null || (eFrom != null && eFrom > eTo ? true : m < eTo));
    const pastFlat = (m) => flat != null && m >= flat && (eFrom == null || flat > eFrom);
    const trades = [];
    let pos = null, order = null, pendOut = null, today = null, nToday = 0, codeErr = null, eligible = 0, entries = 0, placed = 0, barsIn = 0, barsAll = 0;
    const close = (j, price, why, t) => {
      const pnl = ((price - pos.ep) * pos.dir * pv - fee) * pos.q;
      trades.push({ e: pos.t, x: t ?? d.t[j] + 30, d: pos.dir, ep: pos.ep, xp: price, q: pos.q, pnl: Math.round(pnl * 100) / 100, fee: fee * pos.q, r: why, bars: pos.bars, day: d.tday[j], mae: Math.round(pos.mae * pv * pos.q * 100) / 100, mfe: Math.round(pos.mfe * pv * pos.q * 100) / 100, sl0: pos.sl0 });
      pos = null;
    };
    const dist = (x, sl, a) => { if (!x || x.type === 'none') return null; if (x.type === 'ticks') return num(x.v) * tick; if (x.type === 'points') return num(x.v); if (x.type === 'atr') return num(x.v) * a; if (x.type === 'r') return sl != null ? num(x.v) * sl : null; return null; };
    const open = (j, dir, ref, fillPx, ord) => {
      const a = atrS ? atrS[ord.frame] : NaN;
      const sl = ord.stop != null ? Math.abs(ref - ord.stop) : dist(spec.stop, null, a);
      const tp = ord.target != null ? Math.abs(ord.target - ref) : dist(spec.target, sl, a);
      let q = qty0;
      if (spec.sizing?.type === 'risk' && sl) q = Math.max(0, Math.min(num(spec.sizing.max, 100) || 100, Math.floor(num(spec.sizing.risk, 0) / (sl * pv + fee))));
      if (q < 1) return false; // the stop is too wide for the risk allowed: no trade
      pos = { dir, ep: fillPx, ref, q, t: d.t[j], bars: 0, stop: sl ? ref - dir * sl : null, target: tp ? ref + dir * tp : null, sl0: sl, atr: a, mae: 0, mfe: 0, hi: ref, lo: ref, intrabar: ord.type !== 'market' };
      nToday += 1; entries += 1;
      return true;
    };
    const fi = new Int32Array(d.t.length).fill(-1); // 1-minute index → frame that ends there
    for (let i = 0; i < f.n; i++) fi[f.end[i]] = i;
    let start = 0;
    while (start < d.t.length && d.t[start] < from) start++;
    let lastJ = start;
    for (let j = start; j < d.t.length && d.t[j] < to; j++) {
      lastJ = j;
      barsAll += 1;
      const day = d.tday[j];
      if (day !== today) { today = day; nToday = 0; if (order) order = null; }
      const lastOfDay = j + 1 >= d.t.length || d.tday[j + 1] !== day;
      const O = d.o[j], H = d.h[j], L = d.l[j], C = d.c[j];
      // 1. orders from the bar that just closed: exits and market entries fill at this bar's open
      if (pendOut && pos) close(j, O - pos.dir * slip, pendOut, d.t[j]);
      pendOut = null;
      if (order && !pos && pastFlat(d.lmin[j])) order = null;
      if (order && !pos) {
        const { dir, type, price } = order;
        let ref = null, px = null;
        if (type === 'market') { ref = O; px = O + dir * slip; }
        else if (type === 'stop') { if (dir > 0 ? O >= price : O <= price) { ref = O; px = O + dir * slip; } else if (dir > 0 ? H >= price : L <= price) { ref = price; px = price + dir * slip; } }
        else if (type === 'limit') { if (dir > 0 ? O <= price : O >= price) { ref = O; px = O; } else if (dir > 0 ? L <= price : H >= price) { ref = price; px = price; } }
        if (ref != null) { open(j, dir, ref, px, order); order = null; }
        else if (type === 'market' || --order.left <= 0) order = null;
      }
      // 2. the bar itself: flat time, stop / target, then trailing and break-even, end of day
      if (pos && pastFlat(d.lmin[j]) && pos.t < d.t[j]) close(j, O - pos.dir * slip, 'time', d.t[j]);
      if (pos) {
        const { dir, stop, target } = pos;
        const fresh = pos.t === d.t[j];
        const hitS = stop != null && (dir > 0 ? L <= stop : H >= stop);
        const hitT = target != null && (dir > 0 ? H >= target : L <= target) && !(fresh && pos.intrabar && !ohlcPath);
        let first = hitS ? 'stop' : hitT ? 'target' : null;
        if (hitS && hitT && ohlcPath) { const highFirst = Math.abs(H - O) < Math.abs(O - L); first = (dir > 0) === highFirst ? 'target' : 'stop'; }
        // excursions (for MAE / MFE) up to the exit
        const adverse = first === 'stop' ? stop : dir > 0 ? L : H;
        const favour = first === 'target' ? target : dir > 0 ? H : L;
        pos.mae = Math.min(pos.mae, (adverse - pos.ep) * dir);
        pos.mfe = Math.max(pos.mfe, (favour - pos.ep) * dir);
        if (first === 'stop') close(j, (fresh ? stop : dir > 0 ? Math.min(O, stop) : Math.max(O, stop)) - dir * slip, pos.trailed ? 'trail' : 'stop');
        else if (first === 'target') close(j, fresh ? target : dir > 0 ? Math.max(O, target) : Math.min(O, target), 'target');
        else {
          pos.hi = Math.max(pos.hi, H); pos.lo = Math.min(pos.lo, L);
          if (be && pos.sl0) {
            const trig = be.type === 'r' ? num(be.v) * pos.sl0 : num(be.v) * tick;
            const run = dir > 0 ? pos.hi - pos.ref : pos.ref - pos.lo;
            const lvl = pos.ref + dir * num(be.plus, 0) * tick;
            if (run >= trig && (pos.stop == null || (dir > 0 ? lvl > pos.stop : lvl < pos.stop))) pos.stop = lvl;
          }
          if (trail) {
            const tdist = trail.type === 'atr' ? num(trail.v) * (pos.atr || 0) : num(trail.v) * tick;
            if (tdist > 0) {
              const lvl = dir > 0 ? pos.hi - tdist : pos.lo + tdist;
              if (pos.stop == null || (dir > 0 ? lvl > pos.stop : lvl < pos.stop)) { pos.stop = lvl; pos.trailed = true; }
            }
          }
        }
      }
      if (pos) barsIn += 1;
      if (pos && lastOfDay && spec.flatEod !== false) { pos.mae = Math.min(pos.mae, ((pos.dir > 0 ? L : H) - pos.ep) * pos.dir); close(j, C - pos.dir * slip, 'eod', d.t[j] + 59); }
      // 3. a frame closed on this bar: read the signals (they act from the next bar)
      const i = fi[j];
      if (i < 0 || lastOfDay) continue;
      if (pos) pos.bars += 1;
      const m = f.cl[i];
      const canEnter = !pos && !order && days.has(d.wday[j]) && inWindow(m) && (!maxDay || nToday < maxDay) && !pastFlat(m);
      const place = (dir, br) => {
        const price = entryType === 'stop' ? (dir > 0 ? f.h[i] + entryOff : f.l[i] - entryOff) : entryType === 'limit' ? f.c[i] - dir * entryOff : null;
        order = { dir, type: entryType, price, left: expire, frame: i, stop: br?.stop ?? null, target: br?.target ?? null };
        placed += 1;
      };
      if (code) {
        const c = code.ctx;
        c.position = pos ? pos.dir : 0; c.barsInTrade = pos ? pos.bars : 0; c.tradesToday = nToday; c.entryPrice = pos ? pos.ep : NaN;
        if (canEnter) eligible += 1;
        let out = null;
        try { out = code.fn({ open: f.o[i], high: f.h[i], low: f.l[i], close: f.c[i], volume: f.v[i], time: m, t: f.t[i] }, i, c); } catch (e) { if (!codeErr) codeErr = `bar ${i}: ${e.message}`; }
        const act = typeof out === 'string' ? out : out?.action;
        if (pos && (act === 'exit' || (act === 'buy' && pos.dir < 0) || (act === 'sell' && pos.dir > 0))) pendOut = 'signal';
        if ((act === 'buy' || act === 'sell') && sideOk(act === 'buy' ? 1 : -1) && (canEnter || (pos && spec.reverse && pendOut))) {
          place(act === 'buy' ? 1 : -1, typeof out === 'object' ? { stop: Number.isFinite(out.stop) ? out.stop : null, target: Number.isFinite(out.target) ? out.target : null } : null);
        }
        continue;
      }
      if (pos) {
        if ((maxBars && pos.bars >= maxBars) || exitSig(i)) pendOut = maxBars && pos.bars >= maxBars ? 'bars' : 'signal';
        else if (spec.reverse && !R && ((pos.dir > 0 && shortSig(i) && sideOk(-1)) || (pos.dir < 0 && longSig(i) && sideOk(1)))) { pendOut = 'reverse'; place(-pos.dir); }
        continue;
      }
      if (!canEnter) continue;
      eligible += 1;
      if (R) { if (R() < opts.random.p) { const dir = R() < opts.random.longShare ? 1 : -1; if (sideOk(dir)) place(dir); } continue; }
      if (sideOk(1) && longSig(i)) place(1);
      else if (sideOk(-1) && shortSig(i)) place(-1);
    }
    if (pos) close(lastJ, d.c[lastJ] - pos.dir * slip, 'end', d.t[lastJ] + 59);
    const bh = lastJ > start ? Math.round((d.c[lastJ] - d.o[start]) * pv * qty0 * 100) / 100 : 0;
    return { trades, error: codeErr, eligible, entries, placed, exposure: barsAll ? barsIn / barsAll : 0, buyHold: bh, span: lastJ > start ? (d.t[lastJ] - d.t[start]) / 86400 : 0 };
  }

  // ------------------------------------------------------------------------------------------- statistics
  /** The report: TradingView's / NinjaTrader's usual figures, from closed trades (intrabar drawdown from each trade's MAE). */
  function stats(trades, initial = 50000, extra = {}) {
    const n = trades.length;
    const r2 = (v) => Math.round(v * 100) / 100;
    let net = 0, gp = 0, gl = 0, w = 0, l = 0, even = 0, fees = 0, peak = 0, eq = 0, dd = 0, ddIntra = 0, runUp = 0, trough = 0, runUpIntra = 0;
    let streakL = 0, streakW = 0, maxL = 0, maxW = 0, largestWin = 0, largestLoss = 0, barsW = 0, barsL = 0, barsAll = 0, mae = 0, mfe = 0;
    let ddStart = null, longestDD = 0, inDD = false;
    const byDay = new Map();
    const side = { long: { n: 0, net: 0, w: 0 }, short: { n: 0, net: 0, w: 0 } };
    for (const t of trades) {
      if (t.mae != null) ddIntra = Math.max(ddIntra, peak - (eq + Math.min(0, t.mae)));
      if (t.mfe != null) runUpIntra = Math.max(runUpIntra, eq + Math.max(0, t.mfe) - trough);
      net += t.pnl; eq += t.pnl; fees += t.fee || 0; barsAll += t.bars || 0; mae += t.mae || 0; mfe += t.mfe || 0;
      const sd = t.d > 0 ? side.long : side.short; sd.n++; sd.net += t.pnl; if (t.pnl > 0) sd.w++;
      if (t.pnl > 0) { gp += t.pnl; w++; streakW++; streakL = 0; maxW = Math.max(maxW, streakW); largestWin = Math.max(largestWin, t.pnl); barsW += t.bars || 0; }
      else if (t.pnl < 0) { gl -= t.pnl; l++; streakL++; streakW = 0; maxL = Math.max(maxL, streakL); largestLoss = Math.min(largestLoss, t.pnl); barsL += t.bars || 0; }
      else { even++; }
      if (eq > peak) { // a new high ends a drawdown: how long it lasted (calendar days)
        if (inDD) { longestDD = Math.max(longestDD, (t.x - ddStart) / 86400); inDD = false; }
        peak = eq; ddStart = t.x;
      } else if (eq < peak && !inDD) { inDD = true; if (ddStart == null) ddStart = trades[0].e; }
      dd = Math.max(dd, peak - eq);
      trough = Math.min(trough, eq);
      runUp = Math.max(runUp, eq - trough);
      byDay.set(t.day, (byDay.get(t.day) || 0) + t.pnl);
    }
    if (inDD && n) longestDD = Math.max(longestDD, (trades[n - 1].x - ddStart) / 86400);
    ddIntra = Math.max(ddIntra, dd);
    // daily P&L → Sharpe and Sortino (annualised, risk-free 0)
    const dayP = [...byDay.values()];
    const mean = dayP.length ? dayP.reduce((a, b) => a + b, 0) / dayP.length : 0;
    const sdv = dayP.length > 1 ? Math.sqrt(dayP.reduce((a, b) => a + (b - mean) ** 2, 0) / (dayP.length - 1)) : 0;
    const down = dayP.length > 1 ? Math.sqrt(dayP.reduce((a, b) => a + Math.min(0, b) ** 2, 0) / (dayP.length - 1)) : 0;
    // per trade: t-statistic of the average trade, and the chance of a result this good from luck alone
    const avg = n ? net / n : 0;
    const sdT = n > 1 ? Math.sqrt(trades.reduce((a, t) => a + (t.pnl - avg) ** 2, 0) / (n - 1)) : 0;
    const tstat = sdT ? avg / (sdT / Math.sqrt(n)) : 0;
    const years = (extra.span || (n ? (trades[n - 1].x - trades[0].e) / 86400 : 0)) / 365.25;
    const ret = initial ? net / initial : 0;
    return {
      trades: n, net: r2(net), grossProfit: r2(gp), grossLoss: r2(-gl), fees: r2(fees), wins: w, losses: l, even, winRate: n ? (w / n) * 100 : 0,
      pf: gl ? gp / gl : gp > 0 ? Infinity : 0, avgWin: w ? gp / w : 0, avgLoss: l ? -gl / l : 0, exp: avg, ratioWL: l && w ? (gp / w) / (gl / l) : 0,
      largestWin: r2(largestWin), largestLoss: r2(largestLoss), largestWinPct: gp ? (largestWin / gp) * 100 : 0, largestLossPct: gl ? (-largestLoss / gl) * 100 : 0,
      avgBars: n ? barsAll / n : 0, avgBarsWin: w ? barsW / w : 0, avgBarsLoss: l ? barsL / l : 0, maxConsecWins: maxW, maxConsecLosses: maxL, worstStreak: maxL,
      maxDD: r2(dd), maxDDIntra: r2(ddIntra), ddPct: initial ? (ddIntra / initial) * 100 : 0, longestDD, maxRunUp: r2(runUp), maxRunUpIntra: r2(Math.max(runUpIntra, runUp)),
      sharpe: sdv ? (mean / sdv) * Math.sqrt(252) : 0, sortino: down ? (mean / down) * Math.sqrt(252) : 0,
      days: byDay.size, retDD: dd ? net / dd : net > 0 ? Infinity : 0, returnPct: ret * 100, cagr: years > 0.05 && 1 + ret > 0 ? (Math.pow(1 + ret, 1 / years) - 1) * 100 : null,
      avgMae: n ? mae / n : 0, avgMfe: n ? mfe / n : 0, tstat, pLuck: n > 1 ? 1 - normCdf(tstat) : 1,
      long: { trades: side.long.n, net: r2(side.long.net), winRate: side.long.n ? (side.long.w / side.long.n) * 100 : 0 },
      short: { trades: side.short.n, net: r2(side.short.net), winRate: side.short.n ? (side.short.w / side.short.n) * 100 : 0 },
      exposure: extra.exposure ?? null, buyHold: extra.buyHold ?? null,
    };
  }
  /** Standard normal CDF (Abramowitz–Stegun 7.1.26). */
  function normCdf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2); return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y); }
  const METRIC = { net: (s) => s.net, pf: (s) => (s.pf === Infinity ? 10 : s.pf), exp: (s) => s.exp, sharpe: (s) => s.sharpe, retDD: (s) => (s.retDD === Infinity ? 50 : s.retDD) };

  // ------------------------------------------------------------------------------------------- parameter sweep
  /** grid = [{ name, values: [...] }]. Every combination is run; each gets its own metric and a robustness score —
   *  the average of the metric over it and its neighbours (one step either way in each parameter), so a lonely peak
   *  scores lower than a broad plateau. */
  function sweep(d, spec, base, grid, range, { metric = 'net', minTrades = 30, onProgress } = {}) {
    const dims = grid.map((g) => g.values.length);
    const total = dims.reduce((a, b) => a * b, 1);
    const cells = new Array(total);
    const idxOf = (k) => { const out = []; for (let i = dims.length - 1; i >= 0; i--) { out[i] = k % dims[i]; k = Math.floor(k / dims[i]); } return out; };
    const keyOf = (ix) => ix.reduce((a, v, i) => a * dims[i] + v, 0);
    const M = METRIC[metric] || METRIC.net;
    for (let k = 0; k < total; k++) {
      const ix = idxOf(k);
      const P = { ...base };
      grid.forEach((g, i) => { P[g.name] = g.values[ix[i]]; });
      const r = run(d, spec, P, range);
      const s = stats(r.trades);
      cells[k] = { ix, P, s, m: s.trades ? M(s) : 0, ok: s.trades >= minTrades, error: r.error };
      if (onProgress && k % 10 === 0) onProgress(k / total);
    }
    for (let k = 0; k < total; k++) {
      const ix = cells[k].ix;
      let sum = 0, cnt = 0, prof = 0;
      const visit = (dim, cur) => {
        if (dim === dims.length) { const c = cells[keyOf(cur)]; sum += c.m; cnt += 1; if (c.s.net > 0) prof += 1; return; }
        for (const dlt of [-1, 0, 1]) { const v = ix[dim] + dlt; if (v >= 0 && v < dims[dim]) visit(dim + 1, [...cur, v]); }
      };
      visit(0, []);
      cells[k].robust = cnt ? sum / cnt : 0;
      cells[k].neighboursProfitable = cnt ? prof / cnt : 0;
    }
    const pool = cells.filter((c) => c.ok);
    const best = [...(pool.length ? pool : cells)].sort((a, b) => b.m - a.m)[0];
    const robust = [...(pool.length ? pool : cells)].sort((a, b) => b.robust - a.robust || b.m - a.m)[0];
    return { cells: cells.map((c) => ({ ix: c.ix, P: c.P, m: c.m, robust: c.robust, np: c.neighboursProfitable, ok: c.ok, trades: c.s.trades, net: c.s.net, pf: c.s.pf, winRate: c.s.winRate, maxDD: c.s.maxDD })), dims, total, best: best && { P: best.P, ix: best.ix }, robust: robust && { P: robust.P, ix: robust.ix }, metric };
  }

  // ------------------------------------------------------------------------------------------- walk-forward
  /** Rolling windows: tune on `trainDays` trading days (the most robust setting), then trade the next `testDays` with it. */
  function walkForward(d0, spec, base, grid, range, { trainDays = 120, testDays = 40, metric = 'net', minTrades = 20, onProgress } = {}) {
    const d = prep(d0);
    const dayStarts = [];
    for (let j = 0; j < d.t.length; j++) {
      if (d.t[j] < (range.from ?? -Infinity) || d.t[j] >= (range.to ?? Infinity)) continue;
      if (!dayStarts.length || d.tday[j] !== d.tday[dayStarts[dayStarts.length - 1]]) dayStarts.push(j);
    }
    const tAt = (k) => (k < dayStarts.length ? d.t[dayStarts[k]] : (range.to ?? d.t[d.t.length - 1] + 60));
    const folds = [];
    const oos = [];
    const steps = Math.max(0, Math.ceil((dayStarts.length - trainDays) / testDays));
    for (let s = 0, k = 0; k + trainDays < dayStarts.length; k += testDays, s++) {
      const train = { from: tAt(k), to: tAt(k + trainDays) };
      const test = { from: tAt(k + trainDays), to: tAt(Math.min(dayStarts.length, k + trainDays + testDays)) };
      const sw = grid.length ? sweep(d, spec, base, grid, train, { metric, minTrades }) : null;
      const P = sw ? { ...base, ...sw.robust.P } : base;
      const tr = stats(run(d, spec, P, train).trades);
      const ts = run(d, spec, P, test).trades;
      oos.push(...ts);
      folds.push({ train, test, P, trainStats: tr, testStats: stats(ts), trainDays, testDays: Math.min(testDays, dayStarts.length - k - trainDays) });
      if (onProgress) onProgress((s + 1) / Math.max(1, steps));
    }
    const perDay = (st, days) => (days ? st.net / days : 0);
    const trainRate = folds.reduce((a, f) => a + perDay(f.trainStats, f.trainDays), 0) / Math.max(1, folds.length);
    const testRate = folds.reduce((a, f) => a + perDay(f.testStats, f.testDays), 0) / Math.max(1, folds.length);
    return { folds, oos, stats: stats(oos), efficiency: trainRate > 0 ? testRate / trainRate : null };
  }

  // ------------------------------------------------------------------------------------------- Monte Carlo
  /** Resample the trades (with replacement) `n` times: the spread of final P&L and worst drawdown you could have had. */
  function monteCarlo(trades, n = 2000, seed = 7) {
    if (!trades.length) return null;
    const R = rng(seed);
    const pnl = trades.map((t) => t.pnl);
    const nets = new Float64Array(n), dds = new Float64Array(n);
    let wins = 0;
    for (let k = 0; k < n; k++) {
      let eq = 0, peak = 0, dd = 0;
      for (let i = 0; i < pnl.length; i++) { eq += pnl[Math.floor(R() * pnl.length)]; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
      nets[k] = eq; dds[k] = dd; if (eq > 0) wins++;
    }
    nets.sort(); dds.sort();
    const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
    return { n, net: { p5: q(nets, 0.05), p50: q(nets, 0.5), p95: q(nets, 0.95) }, dd: { p50: q(dds, 0.5), p95: q(dds, 0.95), p99: q(dds, 0.99) }, profitable: wins / n };
  }

  /** The same exits and settings with random entries, `runs` times: how often luck alone did as well. */
  function randomBaseline(d, spec, P, range, actual, runs = 200) {
    const p = actual.eligible ? (actual.placed ?? actual.entries) / actual.eligible : 0;
    const longs = actual.trades.filter((t) => t.d > 0).length;
    const longShare = actual.trades.length ? longs / actual.trades.length : 0.5;
    const nets = [];
    for (let k = 0; k < runs; k++) nets.push(stats(run(d, { ...spec, mode: 'rules' }, P, range, { random: { p, longShare, seed: 1000 + k } }).trades).net);
    nets.sort((a, b) => a - b);
    const mine = stats(actual.trades).net;
    const beat = nets.filter((x) => x < mine).length / runs;
    return { runs, median: nets[Math.floor(runs / 2)], p95: nets[Math.floor(runs * 0.95)], beat };
  }

  /** Everything a results page needs from one setting: in-sample (and out-of-sample once unlocked) trades and stats,
   *  Monte Carlo, a +1 tick slippage stress test and the random-entry baseline — all on the in-sample period. */
  function analyze(d, spec, P, { is, oos, initial = 50000, checks = true } = {}) {
    const a = run(d, spec, P, is);
    const out = { is: { trades: a.trades, stats: stats(a.trades, initial, a), error: a.error } };
    if (oos) { const b = run(d, spec, P, oos); out.oos = { trades: b.trades, stats: stats(b.trades, initial, b), error: b.error }; }
    if (checks && a.trades.length) {
      out.mc = monteCarlo(a.trades);
      out.stress = stats(run(d, { ...spec, slip: (Number(spec.slip) || 0) + 1 }, P, is).trades, initial);
      out.random = randomBaseline(d, spec, P, is, a, 120);
    }
    return out;
  }

  return { prep, frames, run, stats, sweep, walkForward, monteCarlo, randomBaseline, analyze, series };
}
