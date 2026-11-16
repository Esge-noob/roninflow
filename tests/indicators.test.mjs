import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, vwap, bollinger, rsi, macd } from '../src/lib/indicators.js';

const bars = (closes) => closes.map((c, i) => ({ time: 1000 + i * 60, open: c, high: c + 1, low: c - 1, close: c, volume: 10 }));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`);

test('moving averages', () => {
  const b = bars([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(sma(b, 3).map((p) => p.value), [2, 3, 4, 5]);
  const e = ema(b, 3);
  near(e[0].value, 2, 'ema seeded with the average');
  near(e[1].value, 4 * 0.5 + 2 * 0.5, 'ema step');
  assert.equal(e[0].time, b[2].time);
});

test('vwap restarts each session', () => {
  const b = bars([10, 20, 30, 40]);
  b[1].volume = 30;
  const v = vwap(b, (x) => (x.time < b[2].time ? 'a' : 'b'));
  near(v[1].value, (10 * 10 + 20 * 30) / 40, 'weighted by volume');
  near(v[2].value, 30, 'new session starts over');
});

test('bollinger, rsi and macd', () => {
  const flat = bars(Array(25).fill(100));
  const bb = bollinger(flat, 20, 2);
  assert.equal(bb.mid.length, 6);
  near(bb.upper[0].value, 100, 'no spread on flat prices');
  const up = bars(Array.from({ length: 20 }, (_, i) => 100 + i));
  assert.equal(rsi(up, 14).at(-1).value, 100, 'only gains → 100');
  const zig = bars(Array.from({ length: 40 }, (_, i) => 100 + (i % 2 ? 1 : -1)));
  const r = rsi(zig, 14).at(-1).value;
  assert.ok(r > 40 && r < 60, `balanced → about 50 (${r})`);
  const m = macd(bars(Array.from({ length: 60 }, (_, i) => 100 + i)));
  assert.ok(m.line.at(-1).value > 0, 'rising prices → positive macd');
  assert.equal(m.hist.length, m.signal.length);
});
