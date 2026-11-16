import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolRoot, sameTrade, shareTargets, linkedTrades, reviewPart, mergeReview, backfillReviews } from '../src/lib/linkedTrades.js';

const T = (id, accountId, entry, extra = {}) => ({ id, accountId, symbol: 'MESZ6', direction: 'Long', qty: 1, entry, exit: entry, pnl: 50, ...extra });
const accounts = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'J' }];

test('contract roots', () => {
  assert.equal(symbolRoot('MESZ6'), 'MES');
  assert.equal(symbolRoot('MESZ26'), 'MES');
  assert.equal(symbolRoot('MES 12-26'), 'MES');
  assert.equal(symbolRoot('mes@cme'), 'MES');
  assert.equal(symbolRoot('6EZ5'), '6E');
  assert.equal(symbolRoot('NQ'), 'NQ');
  assert.equal(symbolRoot('MNQH7'), 'MNQ');
});

test('the same trade on another account: same root, direction, entry within a minute', () => {
  const a = T('a', 'A', '2026-11-10T09:31:00');
  assert.ok(sameTrade(a, T('b', 'B', '2026-11-10T09:31:40', { symbol: 'MES', qty: 3 }))); // size and symbol spelling can differ
  assert.ok(!sameTrade(a, T('b', 'B', '2026-11-10T09:32:30'))); // 90 s apart
  assert.ok(!sameTrade(a, T('b', 'B', '2026-11-10T09:31:00', { direction: 'Short' })));
  assert.ok(!sameTrade(a, T('b', 'B', '2026-11-10T09:31:00', { symbol: 'MNQZ6' })));
  assert.ok(!sameTrade(a, T('b', 'A', '2026-11-10T09:31:00'))); // same account: a different trade
});

test('who reviews are shared with', () => {
  assert.deepEqual(shareTargets({ mode: 'off' }, accounts, 'A'), []);
  assert.deepEqual(shareTargets(undefined, accounts, 'A'), []);
  assert.deepEqual(shareTargets({ mode: 'all' }, accounts, 'A'), ['B', 'C', 'J']);
  assert.deepEqual(shareTargets({ mode: 'selected', accounts: ['J', 'gone'] }, accounts, 'A'), ['J']);
  assert.deepEqual(shareTargets({ mode: 'selected', accounts: ['A', 'J'] }, accounts, 'A'), ['J']);
});

test('linked copies: the closest match on each target account', () => {
  const src = T('a', 'A', '2026-11-10T09:31:00');
  const trades = [src, T('b1', 'B', '2026-11-10T09:31:50'), T('b2', 'B', '2026-11-10T09:31:05'), T('c', 'C', '2026-11-10T09:30:30'), T('j', 'J', '2026-11-10T11:00:00')];
  assert.deepEqual(linkedTrades(src, trades, ['B', 'C', 'J']).map((t) => t.id).sort(), ['b2', 'c']);
  assert.deepEqual(linkedTrades(src, trades, []), []);
});

test('only review fields are shared', () => {
  assert.deepEqual(reviewPart({ notes: 'x', tags: ['a'], pnl: 999, entryPrice: 1, reviewed: true }), { notes: 'x', tags: ['a'], reviewed: true });
  assert.deepEqual(reviewPart({ pnl: 1 }), {});
});

test('backfill fills gaps on the copies and never overwrites', () => {
  const merged = mergeReview({ notes: 'mine', tags: ['a'], rating: 0, screenshots: [] }, { notes: 'theirs', tags: ['b', 'a'], rating: 4, screenshots: ['s1'], reviewed: true });
  assert.deepEqual(merged, { tags: ['a', 'b'], rating: 4, screenshots: ['s1'], reviewed: true });
  const trades = [
    T('a1', 'A', '2026-11-10T09:31:00', { notes: 'Good A+ setup', tags: ['ORB'], rating: 5, reviewed: true, strategyId: 's1' }),
    T('j1', 'J', '2026-11-10T09:31:20'), // empty copy on the journal account
    T('b1', 'B', '2026-11-10T09:31:10', { notes: 'already written' }),
    T('a2', 'A', '2026-11-11T10:00:00'), // nothing to copy
    T('j2', 'J', '2026-11-11T10:00:00'),
  ];
  const out = backfillReviews(trades, accounts, { mode: 'all' });
  const get = (id) => out.trades.find((t) => t.id === id);
  assert.deepEqual([get('j1').notes, get('j1').tags, get('j1').rating, get('j1').reviewed, get('j1').strategyId], ['Good A+ setup', ['ORB'], 5, true, 's1']);
  assert.equal(get('b1').notes, 'already written'); // kept
  assert.deepEqual(get('b1').tags, ['ORB']);
  assert.equal(get('a1').notes, 'Good A+ setup'); // source untouched (B's note doesn't overwrite it)
  assert.equal(get('j2').notes, undefined);
  assert.equal(out.changed, 2); // j1 and b1 (a1 already has a note, so B's doesn't overwrite it)
  assert.deepEqual(out.fields, { notes: 1, tags: 2, strategyId: 2, rating: 2, reviewed: 2 });
  // selected: only the journal account
  const sel = backfillReviews(trades, accounts, { mode: 'selected', accounts: ['J'] });
  assert.equal(sel.trades.find((t) => t.id === 'b1').tags, undefined);
  assert.equal(sel.trades.find((t) => t.id === 'j1').notes, 'Good A+ setup');
  // off: nothing
  assert.equal(backfillReviews(trades, accounts, { mode: 'off' }).changed, 0);
});

test('backfill stays fast on a big journal', () => {
  const big = [];
  const accts = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  for (let i = 0; i < 4000; i++) {
    const at = new Date(Date.UTC(2025, 0, 1) + i * 3600_000).toISOString().slice(0, 19);
    big.push(T(`a${i}`, 'A', at, { notes: `n${i}`, reviewed: true, symbol: i % 2 ? 'MESZ6' : 'MNQZ6' }));
    big.push(T(`b${i}`, 'B', at, { symbol: i % 2 ? 'MES' : 'MNQ' }));
    big.push(T(`c${i}`, 'C', at, { symbol: i % 2 ? 'MESZ6' : 'MNQZ6', direction: 'Short' })); // other side: not a copy
  }
  const t0 = Date.now();
  const r = backfillReviews(big, accts, { mode: 'all' });
  assert.equal(r.changed, 4000);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});
