import test from 'node:test';
import assert from 'node:assert/strict';
import { volumeProfile, sessionsIn } from '../src/lib/volprofile.js';

const bar = (t, l, h, v, up = true) => [t, up ? l : h, h, l, up ? h : l, v];

test('volume is spread over each bar’s range; POC, value area and buying share', () => {
  // three bars, tick 1: 100–102 (30 up), 101–101.75 (40 down, one row), 101–103 (30 up)
  const rows = [bar(0, 100, 102, 30), bar(60, 101, 101.75, 40, false), bar(120, 101, 103, 30)];
  const p = volumeProfile(rows, 0, 1e9, { tick: 1, rows: 100 });
  assert.equal(p.step, 1);
  assert.equal(p.lo, 100);
  assert.deepEqual([...p.vol], [10, 10 + 40 + 10, 10 + 10, 10]);
  assert.equal(p.total, 100);
  assert.equal(p.poc, 101, 'the 101 row, on the tick grid');
  assert.deepEqual([...p.up], [10, 20, 20, 10], 'the down bar’s 40 isn’t buying');
  // 70%: POC row 60, then the bigger neighbour (102: 20) = 80 ≥ 70
  assert.deepEqual([p.val, p.vah], [101, 103]);
});

test('only the bars in the time range; rows grow to a whole number of ticks; nothing → null', () => {
  const rows = Array.from({ length: 100 }, (_, i) => bar(i * 60, 1000 + i, 1001 + i, 5));
  const p = volumeProfile(rows, 10 * 60, 20 * 60, { tick: 0.25, rows: 8 });
  assert.equal(p.total, 50, 'ten bars');
  assert.equal(p.step % 0.25, 0);
  assert.ok(p.n <= 10);
  assert.equal(volumeProfile(rows, 1e6, 2e6, { tick: 1 }), null);
  assert.equal(volumeProfile([], 0, 1, {}), null);
});

test('sessions in a range', () => {
  const rows = [bar(0, 1, 2, 1), bar(60, 1, 2, 1), bar(86400, 1, 2, 1), bar(86460, 1, 2, 1), bar(2 * 86400, 1, 2, 1)];
  assert.deepEqual(sessionsIn(rows, 0, 2 * 86400, (t) => t - (t % 86400)), [0, 86400]);
});
