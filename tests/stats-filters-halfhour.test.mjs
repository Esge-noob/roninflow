import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, perfRatio, periodMetrics, halfHourKey, halfHourRange } from '../src/lib/stats.js';
import { roninScore } from '../src/lib/roninScore.js';
import { customRows, DIMENSIONS } from '../src/lib/customChart.js';
import { WIDGETS, DEFAULT_LAYOUT, layoutFor, presetLayout } from '../src/lib/widgets.js';
import { EMPTY_FILTERS, applyFilters, hasActiveFilters, activeFilterCount } from '../src/lib/filters.js';
import { makeEngine } from '../src/lib/autobt.js';

let seq = 0;
const trade = (date, time, pnl, extra = {}) => ({
  id: `t${++seq}`,
  symbol: 'MES',
  direction: 'Long',
  entry: `${date}T${time}:00`,
  exit: `${date}T${time}:30`,
  pnl,
  qty: 1,
  tags: [],
  ...extra,
});

// ---- 1. Break-even trades excluded from calculations ----

test('summarize excludes break-even trades from winRate and avgTrade', () => {
  const list = [
    trade('2026-10-01', '09:35', 200),
    trade('2026-10-01', '09:45', 200),
    trade('2026-10-01', '10:05', -100),
    trade('2026-10-01', '10:15', 0),
    trade('2026-10-01', '10:35', 0),
    trade('2026-10-01', '10:50', 0),
  ];
  const s = summarize(list);
  assert.equal(s.count, 6);
  assert.equal(s.decided, 3);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  assert.equal(s.be, 3);
  assert.ok(Math.abs(s.winRate - (2 / 3) * 100) < 1e-9, `winRate=${s.winRate}`);
  assert.equal(s.avgTrade, 100); // 300 net / 3 decided (not 300 / 6)
  assert.ok(Math.abs(perfRatio(s) - (4 / 3)) < 1e-9, `perfRatio=${perfRatio(s)}`);

  // all break-even trades → 0 decided, 0 winRate, 0 perfRatio
  const onlyBe = summarize([trade('2026-10-01', '09:35', 0), trade('2026-10-01', '09:40', 0)]);
  assert.equal(onlyBe.decided, 0);
  assert.equal(onlyBe.winRate, 0);
  assert.equal(onlyBe.avgTrade, 0);
  assert.equal(perfRatio(onlyBe), 0);
});

test('periodMetrics excludes BE trades and BE-only days from calculations and streaks', () => {
  const list = [
    trade('2026-10-01', '09:35', 150),
    trade('2026-10-02', '09:35', 0, { blockers: ['FOMO'] }), // BE-only day
    trade('2026-10-03', '09:35', 250),
    trade('2026-10-04', '09:35', -100, { blockers: ['Bad Sizing'] }),
  ];
  const m = periodMetrics(list);
  assert.equal(m.days, 3); // BE-only day excluded
  assert.equal(m.maxWinStreak, 2); // BE-only day did not break the 2-day win streak
  assert.ok(Math.abs(m.winDaysPct - (2 / 3) * 100) < 1e-9);
  assert.equal(m.avgDay, 100); // (150 + 250 - 100) / 3
  assert.equal(m.flaggedTrades, 1); // BE trade's blocker excluded
  assert.ok(Math.abs(m.discipline - (2 / 3) * 100) < 1e-9);
});

test('roninScore excludes break-even trades and BE-only days', () => {
  const base = [
    trade('2026-10-01', '09:35', 300),
    trade('2026-10-02', '09:35', 300),
    trade('2026-10-03', '09:35', -100),
  ];
  const withBe = [
    ...base,
    trade('2026-10-01', '09:45', 0),
    trade('2026-10-04', '09:35', 0),
    trade('2026-10-05', '09:35', 0),
  ];
  assert.equal(roninScore(withBe, 50000).score, roninScore(base, 50000).score);
  assert.equal(roninScore([trade('2026-10-01', '09:35', 0)], 50000).score, 0);
});

test('customRows excludes BE trades from winRate, avgTrade, and dayWinRate', () => {
  const list = [
    trade('2026-10-01', '09:35', 100, { symbol: 'MES' }),
    trade('2026-10-01', '09:45', -50, { symbol: 'MES' }),
    trade('2026-10-01', '09:50', 0, { symbol: 'MES' }),
    trade('2026-10-02', '09:35', 0, { symbol: 'MES' }),
  ];
  const [row] = customRows(list, 'symbol', ['winRate', 'avgTrade', 'dayWinRate', 'avgDaily']);
  assert.equal(row.values.winRate, 50);
  assert.equal(row.values.avgTrade, 25);
  assert.equal(row.values.dayWinRate, 100);
  assert.equal(row.values.avgDaily, 50);
});

test('autobt.stats excludes BE trades from winRate, expectancy, and side win rates', () => {
  const btTrades = [
    { d: 1, pnl: 200, fee: 2, bars: 10, mae: -50, mfe: 250, e: 1000, x: 1600, day: '2026-10-01' },
    { d: 1, pnl: -100, fee: 2, bars: 6, mae: -100, mfe: 20, e: 2000, x: 2400, day: '2026-10-01' },
    { d: 1, pnl: 0, fee: 2, bars: 4, mae: -10, mfe: 10, e: 3000, x: 3200, day: '2026-10-02' },
  ];
  const st = makeEngine().stats(btTrades, 50000);
  assert.equal(st.trades, 3);
  assert.equal(st.decided, 2);
  assert.equal(st.even, 1);
  assert.equal(st.winRate, 50);
  assert.equal(st.exp, 50);
  assert.equal(st.long.winRate, 50);
  assert.equal(st.avgBars, 8);
  assert.equal(st.days, 1); // BE-only day excluded
});

// ---- 2. Filters exclude values ----

test('applyFilters supports include, exclude, multi-value exclude, and legacy string filters', () => {
  const list = [
    trade('2026-10-01', '09:35', 100, { symbol: 'MES', direction: 'Long', tags: ['A+ setup'], strategyId: 's1' }),
    trade('2026-10-01', '09:40', -50, { symbol: 'MNQ', direction: 'Short', tags: ['FOMO'], strategyId: 's2' }),
    trade('2026-10-01', '09:45', 0, { symbol: 'MES', direction: 'Long', tags: ['Revenge'], strategyId: '' }),
    trade('2026-10-01', '09:50', 200, { symbol: 'CL', direction: 'Short', tags: ['Followed plan'], strategyId: 's1' }),
  ];

  assert.equal(hasActiveFilters(EMPTY_FILTERS), false);
  assert.equal(applyFilters(list, EMPTY_FILTERS).length, 4);

  // Exclude single result (Break even)
  const noBe = { ...EMPTY_FILTERS, result: { mode: 'exclude', values: ['be'] } };
  assert.equal(hasActiveFilters(noBe), true);
  assert.equal(activeFilterCount(noBe), 1);
  assert.equal(applyFilters(list, noBe).length, 3);
  assert.ok(applyFilters(list, noBe).every((t) => t.pnl !== 0));

  // Exclude multiple tags
  const noMistakes = { ...EMPTY_FILTERS, tag: { mode: 'exclude', values: ['FOMO', 'Revenge'] } };
  assert.equal(activeFilterCount(noMistakes), 2);
  assert.deepEqual(applyFilters(list, noMistakes).map((t) => t.symbol), ['MES', 'CL']);

  // Combine Include symbol + Exclude direction
  const combo = {
    ...EMPTY_FILTERS,
    symbol: { mode: 'include', values: ['MES', 'MNQ'] },
    direction: { mode: 'exclude', values: ['Short'] },
  };
  assert.equal(applyFilters(list, combo).length, 2);
  assert.ok(applyFilters(list, combo).every((t) => t.symbol === 'MES' && t.direction === 'Long'));

  // Exclude "none" strategy
  const onlyWithStrat = { ...EMPTY_FILTERS, strategy: { mode: 'exclude', values: ['none'] } };
  assert.equal(applyFilters(list, onlyWithStrat).length, 3);

  // Legacy plain-string filter compatibility
  assert.equal(applyFilters(list, { symbol: 'CL', direction: '', result: '', tag: '', strategy: '' }).length, 1);
});

// ---- 3. Performance by Half Hour widget & analysis ----

test('halfHourKey and halfHourRange bucket timestamps into 30-minute windows', () => {
  assert.equal(halfHourKey('2026-10-01T09:00:00'), '09:00');
  assert.equal(halfHourKey('2026-10-01T09:29:59'), '09:00');
  assert.equal(halfHourKey('2026-10-01T09:30:00'), '09:30');
  assert.equal(halfHourKey('2026-10-01T09:59:59'), '09:30');
  assert.equal(halfHourRange('09:00'), '09:00–09:29');
  assert.equal(halfHourRange('09:30'), '09:30–09:59');
});

test('halfHour widget replaces hour in library, presets, customChart, and migrates saved layouts', () => {
  assert.equal(WIDGETS.hour, undefined);
  assert.equal(WIDGETS.halfHour.name, 'Performance by Half Hour');
  assert.ok(DEFAULT_LAYOUT.some((i) => i.id === 'halfHour'));
  assert.ok(!DEFAULT_LAYOUT.some((i) => i.id === 'hour'));
  assert.ok(presetLayout('Risk').some((i) => i.id === 'halfHour'));
  assert.ok(presetLayout('Psychology').some((i) => i.id === 'halfHour'));

  // Legacy saved layout with `hour` migrates seamlessly to `halfHour` preserving position & opts
  const saved = [{ id: 'hour', x: 4, y: 0, w: 4, h: 6, opts: { metric: 'winRate' } }];
  const migrated = layoutFor({ dashLayouts: { 'My Dashboard': saved } }, 'My Dashboard');
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].id, 'halfHour');
  assert.deepEqual(migrated[0].opts, { metric: 'winRate' });

  // CustomChart uses halfHour dimension and maps legacy 'hour' key
  assert.ok(DIMENSIONS.some((d) => d.key === 'halfHour'));
  assert.ok(!DIMENSIONS.some((d) => d.key === 'hour'));
  const rows = customRows([
    trade('2026-10-01', '09:10', 100),
    trade('2026-10-01', '09:40', -50),
    trade('2026-10-01', '10:05', 200),
  ], 'halfHour', ['net']);
  assert.deepEqual(rows.map((r) => [r.key, r.values.net]), [['09:00', 100], ['09:30', -50], ['10:00', 200]]);
  const legacyRows = customRows([trade('2026-10-01', '09:40', -50)], 'hour', ['net']);
  assert.deepEqual(legacyRows.map((r) => r.key), ['09:30']);
});
