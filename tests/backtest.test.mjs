import test from 'node:test';
import assert from 'node:assert/strict';
import { marketOrder, flatten, stepBar, toTrade, posQty, posAvg, openPnl, runWhatIf, activeRules, nextWeekday, pointValueOf, localIso } from '../src/lib/backtest.js';

const T0 = Math.floor(new Date('2026-11-13T06:30:00').getTime() / 1000);
const opts = { symbol: 'MNQ', pv: 2, feePerContract: 1 };

test('a long with a target: filled at the target, P&L in dollars after fees', () => {
  let { pos } = marketOrder(null, 1, 2, 21400, T0, { stop: 21390, target: 21420 });
  assert.equal(posQty(pos), 2);
  assert.equal(openPnl(pos, 21405, 2), 20);
  let r = stepBar(pos, [T0 + 60, 21401, 21410, 21395, 21408, 100]);
  assert.equal(r.hit, null);
  r = stepBar(r.pos, [T0 + 120, 21408, 21425, 21404, 21418, 100]);
  assert.equal(r.hit, 'target');
  const t = toTrade(r.closed, opts);
  assert.equal(t.direction, 'Long');
  assert.equal(t.qty, 2);
  assert.equal(t.exitPrice, 21420);
  assert.equal(t.pnl, 20 * 2 * 2 - 2); // 20 points × $2 × 2 contracts − $1 × 2
  assert.equal(t.entry, localIso(T0));
});

test('a bar that reaches both the stop and the target counts as the stop; a gap fills at the open', () => {
  const { pos } = marketOrder(null, -1, 1, 6000, T0, { stop: 6005, target: 5990 });
  const both = stepBar(pos, [T0 + 60, 6001, 6006, 5989, 5995, 1]);
  assert.equal(both.hit, 'stop');
  assert.equal(toTrade(both.closed, { symbol: 'MES', pv: 5 }).pnl, -25);
  const gap = stepBar(pos, [T0 + 60, 6010, 6012, 6008, 6011, 1]);
  assert.equal(toTrade(gap.closed, { symbol: 'MES', pv: 5 }).exitPrice, 6010);
});

test('adding, partly closing and reversing a position', () => {
  let { pos } = marketOrder(null, 1, 1, 100, T0);
  ({ pos } = marketOrder(pos, 1, 1, 110, T0 + 60));
  assert.equal(posAvg(pos), 105);
  let closed;
  ({ pos, closed } = marketOrder(pos, -1, 1, 120, T0 + 120)); // closes the first lot (first in, first out)
  assert.equal(closed, null);
  assert.equal(posQty(pos), 1);
  assert.equal(pos.lots[0].price, 110);
  ({ pos, closed } = marketOrder(pos, -1, 3, 115, T0 + 180)); // closes the rest and goes short 2
  const t = toTrade(closed, { symbol: 'X', pv: 1 });
  assert.equal(t.qty, 2);
  assert.equal(t.pnl, 20 + 5);
  assert.equal(t.fills.length, 2);
  assert.equal(pos.dir, -1);
  assert.equal(posQty(pos), 2);
  const f = flatten(pos, 112, T0 + 240);
  assert.equal(f.pos, null);
  assert.equal(toTrade(f.closed, { symbol: 'X', pv: 1 }).pnl, 6);
});

test('point values and weekdays', () => {
  assert.equal(pointValueOf('MNQZ25'), 2);
  assert.equal(pointValueOf('ES'), 50);
  assert.equal(pointValueOf('AAPL'), 1);
  assert.equal(nextWeekday('2026-11-13'), '2026-11-16'); // Friday → Monday
  assert.equal(nextWeekday('2026-11-16', -1), '2026-11-13');
});

const tr = (entry, pnl, extra = {}) => ({ id: entry, entry, exit: entry, pnl, symbol: 'MES', direction: 'Long', tags: [], ...extra });

test('what-if: daily rules act in time order and the trade that hits a limit still counts', () => {
  const trades = [
    tr('2026-11-12T06:31:00', -100), tr('2026-11-12T06:40:00', -100), tr('2026-11-12T07:00:00', 300), // Thu
    tr('2026-11-13T06:31:00', 200), tr('2026-11-13T06:50:00', 50), tr('2026-11-13T07:10:00', -400), // Fri
  ];
  const a = runWhatIf(trades, { maxLosses: 2 });
  assert.equal(a.kept.length, 5);
  assert.equal(a.removed[0].trade.id, '2026-11-12T07:00:00');
  assert.deepEqual(a.byRule.maxLosses, { count: 1, pnl: 300 });
  const b = runWhatIf(trades, { dayTarget: 200 });
  assert.deepEqual(b.kept.map((t) => t.id), ['2026-11-12T06:31:00', '2026-11-12T06:40:00', '2026-11-12T07:00:00', '2026-11-13T06:31:00']);
  const c = runWhatIf(trades, { maxTrades: 1, tradeLoss: 150 });
  assert.equal(c.kept.length, 2);
  const d = runWhatIf(trades, { tradeLoss: 150 });
  assert.equal(d.kept.find((t) => t.id === '2026-11-13T07:10:00').pnl, -150);
  assert.deepEqual(d.byRule.tradeLoss, { count: 1, saved: 250 });
});

test('what-if: filters by weekday, time, side, strategy, symbol and tag', () => {
  const trades = [
    tr('2026-11-13T06:20:00', 10), // before 06:30
    tr('2026-11-13T06:45:00', 20, { direction: 'Short' }),
    tr('2026-11-13T07:30:00', 30, { strategyId: 's1' }),
    tr('2026-11-13T07:40:00', 40, { symbol: 'MNQ' }),
    tr('2026-11-13T07:50:00', 50, { tags: ['FOMO'] }),
    tr('2026-11-12T07:00:00', 60), // Thursday
  ];
  const r = runWhatIf(trades, { days: [5], from: '06:30', to: '08:00', side: 'long', skipStrategies: ['s1'], skipSymbols: ['MNQ'], skipTags: ['FOMO'] });
  assert.deepEqual(r.kept, []);
  assert.deepEqual(Object.keys(r.byRule).sort(), ['days', 'hours', 'side', 'skipStrategies', 'skipSymbols', 'skipTags'].sort());
  assert.deepEqual(activeRules({ days: [1, 2, 3, 4, 5] }), []);
  assert.equal(runWhatIf(trades, {}).kept.length, 6); // weekdays only by default (all of these are)
});
