process.env.TZ = 'America/Los_Angeles';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from '../src/lib/autobt.js';

const E = makeEngine();
const DAY0 = Date.parse('2026-03-02T14:30:00Z') / 1000; // Mon 9:30 New York = 6:30 Los Angeles (EST, before DST)

/** 1-minute bars: days × minutes from 9:30 NY; price(i, k) gives [o, h, l, c] for minute k of day i. */
function data(days, mins, price) {
  const d = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < days; i++) {
    const base = DAY0 + i * 86400 + (i >= 5 ? 2 * 86400 : 0); // skip the weekend
    for (let k = 0; k < mins; k++) {
      const [o, h, l, c] = price(i, k);
      d.t.push(base + k * 60); d.o.push(o); d.h.push(h); d.l.push(l); d.c.push(c); d.v.push(10);
    }
  }
  return d;
}
const flat = (p) => [p, p, p, p];
const spec = (x) => ({ tf: 1, tick: 0.25, pv: 2, fee: 0, slip: 0, qty: 1, flatEod: true, stop: { type: 'none' }, target: { type: 'none' }, long: [], short: [], ...x });

test('a signal on a closed bar fills at the next bar’s open, never the bar that made it', () => {
  // close jumps above 100 on minute 10; the next bar opens at 100.5
  const d = data(1, 60, (i, k) => (k < 10 ? flat(99) : k === 10 ? [99, 101, 99, 101] : k === 11 ? [100.5, 101, 100, 100.75] : flat(100.75)));
  const r = E.run(d, spec({ long: [{ a: { k: 'close' }, op: 'xa', b: { k: 'value', v: 100 } }] }));
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].ep, 100.5);
  assert.equal(r.trades[0].e, d.t[11]);
  assert.equal(r.trades[0].r, 'eod');
});

test('stop and target: a bar that reaches both counts as the stop; slippage and commission are charged', () => {
  const d = data(1, 40, (i, k) => (k < 5 ? flat(100) : k === 5 ? [100, 101, 100, 101] : k === 6 ? [101, 101, 101, 101] : k === 8 ? [101, 104, 98, 100] : flat(101)));
  const s = spec({ long: [{ a: { k: 'close' }, op: 'xa', b: { k: 'value', v: 100.5 } }], stop: { type: 'ticks', v: 8 }, target: { type: 'ticks', v: 8 }, slip: 1, fee: 1.5 });
  const t = E.run(d, s).trades[0];
  assert.equal(t.ep, 101.25, 'entry at the next open + 1 tick');
  assert.equal(t.r, 'stop');
  assert.equal(t.xp, 98.75, 'stop at 101 − 2, − 1 tick slippage');
  assert.equal(t.pnl, (98.75 - 101.25) * 2 - 1.5);
});

test('a 5-minute strategy reads 5-minute closes', () => {
  // the 1-minute close crosses 100 on minute 7 but the 5-minute bar (minutes 5–9) closes at minute 9
  const d = data(1, 30, (i, k) => (k < 7 ? flat(99) : flat(101)));
  const t = E.run(d, spec({ tf: 5, long: [{ a: { k: 'close' }, op: 'xa', b: { k: 'value', v: 100 } }] })).trades[0];
  assert.equal(t.e, d.t[10], 'filled at the open of minute 10');
});

test('entry window, flat-by time and one trade a day', () => {
  const d = data(2, 240, (i, k) => flat(100 + (k % 2)));
  const s = spec({ long: [{ a: { k: 'close' }, op: '>', b: { k: 'value', v: 100.5 } }], entryFrom: '07:00', entryTo: '08:00', flatAt: '09:00', maxTradesDay: 1 });
  const r = E.run(d, s);
  assert.equal(r.trades.length, 2, 'one a day');
  for (const t of r.trades) {
    const at = new Date(t.e * 1000);
    assert.ok(at.getHours() * 60 + at.getMinutes() >= 7 * 60, 'a signal read at 7:00 fills at 7:00');
    assert.ok(at.getHours() < 8);
    assert.equal(t.r, 'time');
    assert.equal(new Date(t.x * 1000).getHours(), 9);
  }
});

test('opening range is only known once it has finished', () => {
  const d = data(1, 60, (i, k) => (k < 15 ? [100, 100 + k / 10, 100 - k / 10, 100] : flat(100)));
  const f = E.frames(E.prep(d), 1);
  const H = E.series(d, f, { k: 'orHigh', n: 15 }, {});
  assert.ok(Number.isNaN(H[14]), 'not during the range');
  assert.equal(H[15], 101.4);
});

test('a code strategy gives the same trades as the same rules', () => {
  const d = data(3, 200, (i, k) => flat(100 + 5 * Math.sin((k + i * 37) / 9)));
  const rules = spec({ long: [{ a: { k: 'ema', n: 5 }, op: 'xa', b: { k: 'ema', n: 20 } }], short: [{ a: { k: 'ema', n: 5 }, op: 'xb', b: { k: 'ema', n: 20 } }], stop: { type: 'ticks', v: 12 }, target: { type: 'ticks', v: 16 } });
  const code = { ...rules, mode: 'code', code: `function onBar(bar, i, ctx) {
    const f = ctx.ema(5), s = ctx.ema(20);
    if (ctx.position) return null;
    if (ctx.crossAbove(f, s, i)) return 'buy';
    if (ctx.crossBelow(f, s, i)) return 'sell';
  }` };
  const a = E.run(d, rules).trades, b = E.run(d, code).trades;
  assert.ok(a.length > 3);
  assert.deepEqual(b.map((t) => [t.e, t.d, t.ep, t.xp]), a.map((t) => [t.e, t.d, t.ep, t.xp]));
});

test('sweep: every combination, a robustness score from its neighbours; walk-forward and Monte Carlo', () => {
  const d = data(8, 300, (i, k) => flat(100 + 3 * Math.sin((k + i * 53) / 11) + (k % 7) / 10));
  const s = spec({ long: [{ a: { k: 'ema', n: { p: 'fast' } }, op: 'xa', b: { k: 'ema', n: { p: 'slow' } } }], stop: { type: 'ticks', v: 10 }, target: { type: 'r', v: 2 } });
  const grid = [{ name: 'fast', values: [3, 5, 8] }, { name: 'slow', values: [15, 20, 30, 40] }];
  const sw = E.sweep(d, s, {}, grid, {}, { minTrades: 1 });
  assert.equal(sw.total, 12);
  assert.equal(sw.cells.length, 12);
  const corner = sw.cells.find((c) => c.ix[0] === 0 && c.ix[1] === 0);
  const nb = sw.cells.filter((c) => c.ix[0] <= 1 && c.ix[1] <= 1);
  assert.ok(Math.abs(corner.robust - nb.reduce((a, c) => a + c.m, 0) / nb.length) < 1e-9);
  assert.ok(sw.best && sw.robust);
  const wf = E.walkForward(d, s, {}, grid, {}, { trainDays: 4, testDays: 2, minTrades: 1 });
  assert.equal(wf.folds.length, 2);
  const mc = E.monteCarlo([{ pnl: 50 }, { pnl: -30 }, { pnl: 20 }, { pnl: -10 }], 500);
  assert.ok(mc.net.p5 <= mc.net.p50 && mc.net.p50 <= mc.net.p95 && mc.dd.p50 <= mc.dd.p95);
  assert.deepEqual(E.monteCarlo([{ pnl: 50 }, { pnl: -30 }], 100), E.monteCarlo([{ pnl: 50 }, { pnl: -30 }], 100), 'same seed, same answer');
});
