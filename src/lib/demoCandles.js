// Demo site only: made-up 1-minute candles for a symbol and day that pass through the demo trades' real entry and exit
// prices, so the execution charts, drawing tools and replay can be tried without a price feed. Same input → same candles.

const TICK = { ES: 0.25, MES: 0.25, NQ: 0.25, MNQ: 0.25, YM: 1, MYM: 1, RTY: 0.1, M2K: 0.1, CL: 0.01, MCL: 0.01, GC: 0.1, MGC: 0.1 };
const BASE = { ES: 6000, MES: 6000, NQ: 21000, MNQ: 21000, YM: 44000, MYM: 44000, RTY: 2300, M2K: 2300, CL: 70, MCL: 70, GC: 2600, MGC: 2600 };
const rootOf = (s) => { const u = String(s || '').toUpperCase(); return Object.keys(TICK).sort((a, b) => b.length - a.length).find((r) => u.startsWith(r)) || u; };

function rng(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) { h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);

/** [[t, o, h, l, c, v], …] (UTC seconds) for `date` (YYYY-MM-DD, local), 5:00 AM – 2:00 PM local and around any trades. */
export function demoCandles(trades, symbol, date) {
  const root = rootOf(symbol);
  const tick = TICK[root] || 0.01;
  const mine = trades.filter((t) => rootOf(t.symbol) === root);
  const anchors = [];
  for (const t of mine.filter((x) => String(x.entry).slice(0, 10) === date)) {
    for (const f of t.fills?.length ? t.fills : [t]) {
      if (f.entry && Number.isFinite(Number(f.entryPrice))) anchors.push([unix(f.entry), Number(f.entryPrice)]);
      if (f.exit && Number.isFinite(Number(f.exitPrice))) anchors.push([unix(f.exit), Number(f.exitPrice)]);
    }
  }
  anchors.sort((a, b) => a[0] - b[0]);
  // a day without trades still gets candles near this symbol's price on the closest day that has trades
  let base = anchors[0]?.[1];
  if (base === undefined) {
    const near = mine.filter((t) => Number.isFinite(Number(t.entryPrice))).sort((a, b) => Math.abs(new Date(a.entry) - new Date(`${date}T12:00:00`)) - Math.abs(new Date(b.entry) - new Date(`${date}T12:00:00`)))[0];
    base = near ? Number(near.entryPrice) : BASE[root] || 100;
  }
  let from = unix(`${date}T05:00:00`), to = unix(`${date}T14:00:00`);
  if (anchors.length) { from = Math.min(from, anchors[0][0] - 3600); to = Math.max(to, anchors[anchors.length - 1][0] + 3600); }
  from -= from % 60;
  const r = rng(`${root}|${date}`);
  const sigma = Math.max(tick, base * 0.00028); // per-minute move
  const n = Math.floor((to - from) / 60) + 1;
  const path = new Array(n);
  // random walk, bent to pass exactly through each fill (a Brownian bridge between fills)
  const points = [[0, base], ...anchors.map(([t, p]) => [Math.max(0, Math.min(n - 1, Math.round((t - from) / 60))), p])];
  for (let k = 0; k < points.length; k++) {
    const [i0, p0] = points[k];
    const [i1, p1] = points[k + 1] || [n - 1, null];
    const walk = [0];
    for (let i = i0 + 1; i <= i1; i++) walk.push(walk[walk.length - 1] + gauss(r) * sigma);
    const end = walk[walk.length - 1];
    for (let i = i0; i <= i1; i++) {
      const f = i1 === i0 ? 0 : (i - i0) / (i1 - i0);
      path[i] = p1 === null ? p0 + walk[i - i0] : p0 + (p1 - p0) * f + walk[i - i0] - end * f;
    }
  }
  const round = (p) => Math.round(p / tick) * tick;
  const out = [];
  let prev = round(path[0]);
  for (let i = 0; i < n; i++) {
    const t = from + i * 60;
    const o = prev, c = round(path[i]);
    let h = Math.max(o, c) + round(Math.abs(gauss(r)) * sigma * 0.6), l = Math.min(o, c) - round(Math.abs(gauss(r)) * sigma * 0.6);
    for (const [at, p] of anchors) if (at >= t && at < t + 60) { h = Math.max(h, p); l = Math.min(l, p); }
    const hour = new Date(t * 1000).getHours();
    const v = Math.round((hour >= 6 && hour < 8 ? 900 : 350) * (0.4 + r()));
    out.push([t, o, round(h), round(l), c, v]);
    prev = c;
  }
  return out;
}

/** Demo site only: a made-up continuous 1-minute history for automated backtests — 5:00 AM to 2:00 PM local on
 *  weekdays, with calm and busy stretches, trend days and range days. Same input → same bars. */
export function demoHistory(symbol, fromDate, toDate) {
  const root = rootOf(symbol);
  const tick = TICK[root] || 0.01;
  const r = rng(`hist|${root}`);
  let p = BASE[root] || 100;
  const out = { symbol: root, t: [], o: [], h: [], l: [], c: [], v: [], rolls: [] };
  const end = new Date(`${toDate}T12:00:00`);
  const start = new Date(`${fromDate}T12:00:00`);
  // walk from a fixed start so any range gives the same prices
  const d = new Date('2024-01-01T12:00:00');
  let vol = 1;
  const round = (x) => Math.round(x / tick) * tick;
  while (d <= end) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) {
      vol = Math.max(0.5, Math.min(2.2, vol * Math.exp(gauss(r) * 0.18)));
      const base = BASE[root] || 100;
      // most days drift a little, some trend; a slow pull back toward the usual price keeps it realistic
      const dayDrift = (r() < 0.25 ? gauss(r) * 0.006 : gauss(r) * 0.0012) + ((base - p) / base) * 0.01;
      const sigma = p * 0.00025 * vol;
      p += gauss(r) * sigma * 5; // overnight gap
      const keep = d >= start;
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const t0 = Math.floor(new Date(`${day}T05:00:00`).getTime() / 1000);
      for (let k = 0; k < 540; k++) {
        const u = k < 90 ? 0.6 : k < 150 ? 1.7 : k < 420 ? 0.9 : 1.3; // busy around the open and into the close
        const o = p;
        p += (dayDrift * p) / 540 + gauss(r) * sigma * u;
        const c = round(p), hi = Math.max(round(o), c) + round(Math.abs(gauss(r)) * sigma * 0.7 * u), lo = Math.min(round(o), c) - round(Math.abs(gauss(r)) * sigma * 0.7 * u);
        if (keep) { out.t.push(t0 + k * 60); out.o.push(round(o)); out.h.push(hi); out.l.push(lo); out.c.push(c); out.v.push(Math.round((k >= 90 && k < 150 ? 900 : 300) * (0.4 + r()))); }
      }
    }
    d.setDate(d.getDate() + 1);
  }
  out.n = out.t.length;
  return out;
}

/** Made-up ticks inside 1-minute bars: open → nearer extreme → other extreme → close, with small wiggles. */
export function demoTicks(bars, symbol) {
  const tick = TICK[rootOf(symbol)] || 0.25;
  const out = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const [t, o, h, l, c, v] of bars) {
    const n = 12 + Math.floor(rnd() * 24);
    const path = o - l < h - o ? [o, l, h, c] : [o, h, l, c];
    for (let k = 0; k < n; k++) {
      const f = k / (n - 1), seg = Math.min(2, Math.floor(f * 3)), g = f * 3 - seg;
      let p = path[seg] + (path[seg + 1] - path[seg]) * g + (rnd() - 0.5) * tick * 2;
      p = Math.max(l, Math.min(h, Math.round(p / tick) * tick));
      out.push([t * 1000 + Math.floor((k / n) * 60000), p, Math.max(1, Math.round((v / n) * (0.5 + rnd()))), rnd() < 0.5 ? 1 : -1]);
    }
  }
  return out;
}
