// Volume profile: how much volume traded at each price over a stretch of time.
//
// Built from 1-minute bars: each bar's volume is spread evenly over the prices between its low and high (we don't
// have the ticks, so this is the usual approximation — finer bars give a sharper profile). A bar that closed up counts
// as buying, one that closed down as selling, for the two-tone bars.
//   POC  point of control — the price with the most volume
//   VAH / VAL  value area high / low — the range around the POC holding `va` (default 70%) of the volume

/** First index in `rows` (sorted by time) with time >= t. */
function lowerBound(rows, t) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m][0] < t) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * rows: [[t, o, h, l, c, v], …] sorted by time; profile of the bars with from <= t < to.
 * opts: { tick (price step), rows (how many price rows to aim for; 0 = automatic), va (0–1) }
 * Returns null when there's nothing to show, else { lo, step, vol, up, total, max, poc, vah, val, n }.
 */
export function volumeProfile(rows, from, to, { tick = 0.01, rows: want = 0, va = 0.7 } = {}) {
  if (!rows?.length) return null;
  const a = lowerBound(rows, from), b = lowerBound(rows, to);
  if (b <= a) return null;
  let lo = Infinity, hi = -Infinity;
  for (let i = a; i < b; i++) { if (rows[i][3] < lo) lo = rows[i][3]; if (rows[i][2] > hi) hi = rows[i][2]; }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  tick = tick > 0 ? tick : 0.01;
  const target = want > 0 ? want : 80;
  // a whole number of ticks per row, so rows line up with real prices
  const step = Math.max(1, Math.ceil((hi - lo) / tick / target)) * tick;
  lo = Math.floor(lo / step + 1e-9) * step;
  const n = Math.max(1, Math.floor((hi - lo) / step + 1e-9) + 1);
  const vol = new Float64Array(n), up = new Float64Array(n);
  let total = 0;
  for (let i = a; i < b; i++) {
    const [, o, h, l, c, v] = rows[i];
    if (!(v > 0)) continue;
    const r0 = Math.max(0, Math.min(n - 1, Math.floor((l - lo) / step + 1e-9)));
    const r1 = Math.max(0, Math.min(n - 1, Math.floor((h - lo) / step + 1e-9)));
    const each = v / (r1 - r0 + 1);
    const isUp = c >= o;
    for (let r = r0; r <= r1; r++) { vol[r] += each; if (isUp) up[r] += each; }
    total += v;
  }
  if (!total) return null;
  let pocI = 0;
  for (let r = 1; r < n; r++) if (vol[r] > vol[pocI]) pocI = r;
  // value area: grow out from the POC, taking the bigger neighbouring row each time
  let vaLo = pocI, vaHi = pocI, inVa = vol[pocI];
  const goal = total * Math.min(1, Math.max(0, va));
  while (inVa < goal && (vaLo > 0 || vaHi < n - 1)) {
    const below = vaLo > 0 ? vol[vaLo - 1] : -1, above = vaHi < n - 1 ? vol[vaHi + 1] : -1;
    if (above >= below) { vaHi += 1; inVa += above; } else { vaLo -= 1; inVa += below; }
  }
  // the POC as a real price: the middle of its row, on the tick grid
  const poc = Number((lo + pocI * step + Math.floor(step / 2 / tick + 1e-9) * tick).toFixed(10));
  return { lo, step, n, vol, up, total, max: vol[pocI], poc, pocRow: pocI, vah: lo + (vaHi + 1) * step, val: lo + vaLo * step, vaLo, vaHi };
}

/** Start times of the trading days between from and to (sessionStart: unix → that day's session start). */
export function sessionsIn(rows, from, to, sessionStart) {
  const out = [];
  const a = lowerBound(rows, from), b = lowerBound(rows, to);
  let last = null;
  for (let i = a; i < b; i++) { const s = sessionStart(rows[i][0]); if (s !== last) { out.push(s); last = s; } }
  return out;
}
