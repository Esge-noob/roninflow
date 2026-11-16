import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customRows, fmtMetric, METRICS, DIMENSIONS } from '../src/lib/customChart.js';

const t = (date, sym, pnl, extra = {}) => ({ id: Math.random(), symbol: sym, entry: `${date}T07:00:00`, exit: `${date}T07:10:00`, pnl, qty: 2, direction: 'Long', ...extra });
const trades = [t('2026-11-02', 'MES', 100), t('2026-11-02', 'MNQ', -50), t('2026-11-03', 'MES', 200, { direction: 'Short' }), t('2026-11-09', 'MES', -25, { strategyId: 's1' })];

test('groups by a dimension and computes metrics', () => {
  const r = customRows(trades, 'symbol', ['net', 'count', 'winRate']);
  assert.deepEqual(r.map((x) => x.key), ['MES', 'MNQ'], 'most traded first');
  assert.equal(r[0].values.net, 275);
  assert.equal(r[0].values.count, 3);
  assert.equal(Math.round(r[0].values.winRate), 67);
});

test('time dimensions are in order and cumulative metrics add up', () => {
  const r = customRows(trades, 'day', ['net', 'cum']);
  assert.deepEqual(r.map((x) => x.key), ['2026-11-02', '2026-11-03', '2026-11-09']);
  assert.deepEqual(r.map((x) => x.values.cum), [50, 250, 225]);
  const w = customRows(trades, 'week', ['net']);
  assert.deepEqual(w.map((x) => x.key), ['2026-11-02', '2026-11-09']);
  const s = customRows(trades, 'strategy', ['net'], { strategies: new Map([['s1', 'ORB']]) });
  assert.deepEqual(s.map((x) => x.label).sort(), ['No strategy', 'ORB']);
  const d = customRows(trades, 'direction', ['count']);
  assert.deepEqual(d.map((x) => [x.key, x.values.count]), [['Long', 3], ['Short', 1]]);
});

test('every metric and dimension runs; formatting', () => {
  for (const dim of DIMENSIONS) customRows(trades, dim.key, METRICS.map((m) => m.key), {});
  assert.equal(fmtMetric(-1234.5, '$'), '-$1,235');
  assert.equal(fmtMetric(12345, '$'), '$12.3k');
  assert.equal(fmtMetric(66.666, '%'), '67%');
  assert.equal(fmtMetric(95, 'min'), '1h 35m');
});
