import test from 'node:test';
import assert from 'node:assert/strict';
import { filterScope, filterCount, describeScope, ANY, NONE } from '../src/lib/coachScope.js';

const trades = [
  { id: 1, entry: '2026-11-17T09:40:00', strategyId: 's1', tags: ['A+ setup'], blockers: [] },
  { id: 2, entry: '2026-11-17T10:10:00', strategyId: 's2', tags: ['News'], blockers: ['FOMO'] },
  { id: 3, entry: '2026-11-18T09:35:00', strategyId: null, tags: [], blockers: ['Tilt', 'FOMO'] },
];
const state = { diary: { '2026-11-17': { pre: { regime: 'trend' } } }, strategies: [{ id: 's1', name: 'ORB' }] };
const ids = (l) => l.map((t) => t.id);

test('the coach context narrows by strategy, market condition, tags and edge blockers', () => {
  assert.deepEqual(ids(filterScope(trades, state, {})), [1, 2, 3]);
  assert.deepEqual(ids(filterScope(trades, state, { strategy: 's1' })), [1]);
  assert.deepEqual(ids(filterScope(trades, state, { strategy: NONE })), [3]);
  assert.deepEqual(ids(filterScope(trades, state, { regime: 'trend' })), [1, 2]);
  assert.deepEqual(ids(filterScope(trades, state, { regime: NONE })), [3]);
  assert.deepEqual(ids(filterScope(trades, state, { tags: ['A+ setup', 'News'] })), [1, 2]);
  assert.deepEqual(ids(filterScope(trades, state, { blockers: [ANY] })), [2, 3]);
  assert.deepEqual(ids(filterScope(trades, state, { blockers: [NONE] })), [1]);
  assert.deepEqual(ids(filterScope(trades, state, { blockers: ['Tilt'] })), [3]);
  assert.deepEqual(ids(filterScope(trades, state, { regime: 'trend', blockers: ['FOMO'] })), [2]);
  assert.equal(filterCount({ strategy: 's1', tags: ['x'], blockers: [] }), 2);
  const d = describeScope(state, { strategy: 's1', regime: 'trend', blockers: [NONE] }, [{ id: 'trend', name: 'Trending' }]);
  assert.equal(d.strategy, 'ORB'); assert.equal(d.marketCondition, 'Trending'); assert.match(d.edgeBlockers, /no edge blockers/);
  assert.equal(describeScope(state, {}), null);
});
