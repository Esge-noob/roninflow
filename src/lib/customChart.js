// Custom chart widget: group trades by a dimension (symbol, weekday, month, strategy …) and plot up to three metrics.
import { toDate, keyOf, holdSeconds, groupByDay, WEEKDAYS, halfHourKey } from './stats.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HOLD = [[60, '< 1 min'], [300, '1–5 min'], [900, '5–15 min'], [3600, '15–60 min'], [14400, '1–4 h'], [Infinity, '> 4 h']];
const weekStart = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return keyOf(x); };
const short = (k) => { const d = toDate(k); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };

/** Ways to group trades: key(trade, ctx) → group key (or keys); order: 'time' (sort by key), a fixed list, or by count. */
export const DIMENSIONS = [
  { key: 'day', label: 'Each day', of: (t) => String(t.entry).slice(0, 10), order: 'time', fmt: short },
  { key: 'week', label: 'Each week', of: (t) => weekStart(toDate(t.entry)), order: 'time', fmt: (k) => `Wk of ${short(k)}` },
  { key: 'month', label: 'Each month', of: (t) => String(t.entry).slice(0, 7), order: 'time', fmt: (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(2, 4)}` },
  { key: 'weekday', label: 'Day of week', of: (t) => WEEKDAYS[toDate(t.entry).getDay()], order: [1, 2, 3, 4, 5, 6, 0].map((d) => WEEKDAYS[d]) },
  { key: 'halfHour', label: 'Half hour of day', of: (t) => halfHourKey(t.entry), order: 'time' },
  { key: 'monthOfYear', label: 'Month of year', of: (t) => MONTHS[toDate(t.entry).getMonth()], order: MONTHS },
  { key: 'symbol', label: 'Symbol', of: (t) => t.symbol || '—', order: 'count' },
  { key: 'strategy', label: 'Strategy', of: (t, c) => c.strategies?.get(t.strategyId) || 'No strategy', order: 'count' },
  { key: 'tag', label: 'Tag', of: (t) => (t.tags?.length ? t.tags : ['No tag']), order: 'count' },
  { key: 'condition', label: 'Market condition', of: (t, c) => c.regimes?.get(c.diary?.[String(t.entry).slice(0, 10)]?.pre?.regime) || 'Not logged', order: 'count' },
  { key: 'direction', label: 'Long / short', of: (t) => (t.direction === 'Short' ? 'Short' : 'Long'), order: ['Long', 'Short'] },
  { key: 'hold', label: 'Hold time', of: (t) => HOLD.find(([max]) => holdSeconds(t) < max)[1], order: HOLD.map((h) => h[1]) },
  { key: 'account', label: 'Account', of: (t, c) => c.accounts?.get(t.accountId) || 'No account', order: 'count' },
];

const sum = (l, f) => l.reduce((a, t) => a + f(t), 0);
const nonBe = (l) => l.filter((t) => t.pnl !== 0);
const wins = (l) => l.filter((t) => t.pnl > 0);
const losses = (l) => l.filter((t) => t.pnl < 0);
const avg = (l, f) => (l.length ? sum(l, f) / l.length : 0);
function dd(l) {
  let c = 0, peak = 0, m = 0;
  for (const t of [...l].sort((a, b) => String(a.entry).localeCompare(String(b.entry)))) { c += t.pnl; peak = Math.max(peak, c); m = Math.max(m, peak - c); }
  return -m;
}

/** What can be plotted; unit decides the axis ($, %, n = count, x = ratio, min = minutes). */
export const METRICS = [
  { key: 'net', label: 'Net P&L', unit: '$', group: 'Profit', f: (l) => sum(l, (t) => t.pnl) },
  { key: 'cum', label: 'Cumulative net P&L', unit: '$', group: 'Profit', cumulative: true, f: (l) => sum(l, (t) => t.pnl) },
  { key: 'avgTrade', label: 'Avg trade (expectancy)', unit: '$', group: 'Profit', f: (l) => avg(nonBe(l), (t) => t.pnl) },
  { key: 'avgDaily', label: 'Avg daily net P&L', unit: '$', group: 'Profit', f: (l) => { const d = groupByDay(l).filter((x) => x.decided > 0); return d.length ? sum(d, (x) => x.net) / d.length : 0; } },
  { key: 'grossProfit', label: 'Gross profit', unit: '$', group: 'Profit', f: (l) => sum(wins(l), (t) => t.pnl) },
  { key: 'grossLoss', label: 'Gross loss', unit: '$', group: 'Profit', f: (l) => sum(losses(l), (t) => t.pnl) },
  { key: 'avgWin', label: 'Avg win', unit: '$', group: 'Profit', f: (l) => avg(wins(l), (t) => t.pnl) },
  { key: 'avgLoss', label: 'Avg loss', unit: '$', group: 'Profit', f: (l) => avg(losses(l), (t) => t.pnl) },
  { key: 'largestWin', label: 'Largest win', unit: '$', group: 'Profit', f: (l) => Math.max(0, ...l.map((t) => t.pnl)) },
  { key: 'largestLoss', label: 'Largest loss', unit: '$', group: 'Profit', f: (l) => Math.min(0, ...l.map((t) => t.pnl)) },
  { key: 'fees', label: 'Fees', unit: '$', group: 'Profit', f: (l) => sum(l, (t) => Number(t.fees) || 0) },
  { key: 'winRate', label: 'Win %', unit: '%', group: 'Quality', f: (l) => { const d = nonBe(l); return d.length ? (wins(l).length / d.length) * 100 : 0; } },
  { key: 'dayWinRate', label: 'Winning days %', unit: '%', group: 'Quality', f: (l) => { const d = groupByDay(l).filter((x) => x.net !== 0); return d.length ? (d.filter((x) => x.net > 0).length / d.length) * 100 : 0; } },
  { key: 'pf', label: 'Profit factor', unit: 'x', group: 'Quality', f: (l) => { const g = sum(wins(l), (t) => t.pnl), b = -sum(losses(l), (t) => t.pnl); return b ? g / b : g ? 5 : 0; } },
  { key: 'wlRatio', label: 'Avg win / avg loss', unit: 'x', group: 'Quality', f: (l) => { const a = avg(wins(l), (t) => t.pnl), b = -avg(losses(l), (t) => t.pnl); return b ? a / b : a ? 5 : 0; } },
  { key: 'maxDD', label: 'Max drawdown', unit: '$', group: 'Risk', f: dd },
  { key: 'count', label: 'Trade count', unit: 'n', group: 'Activity', f: (l) => l.length },
  { key: 'contracts', label: 'Contracts traded', unit: 'n', group: 'Activity', f: (l) => sum(l, (t) => Number(t.qty) || 0) },
  { key: 'avgSize', label: 'Avg position size', unit: 'n', group: 'Activity', f: (l) => avg(nonBe(l), (t) => Number(t.qty) || 0) },
  { key: 'longPct', label: 'Long %', unit: '%', group: 'Activity', f: (l) => { const d = nonBe(l); return d.length ? (d.filter((t) => t.direction !== 'Short').length / d.length) * 100 : 0; } },
  { key: 'avgHold', label: 'Avg hold time', unit: 'min', group: 'Time', f: (l) => avg(nonBe(l), (t) => holdSeconds(t)) / 60 },
];
export const METRIC = Object.fromEntries(METRICS.map((m) => [m.key, m]));
export const DIMENSION = Object.fromEntries(DIMENSIONS.map((d) => [d.key, d]));

/** Groups → rows: [{ key, label, n, values: { metricKey: number } }] in the dimension's order. */
export function customRows(trades, dimKey, metricKeys, ctx = {}) {
  const dim = DIMENSION[dimKey === 'hour' ? 'halfHour' : dimKey] || DIMENSION.symbol;
  const by = new Map();
  for (const t of trades) for (const k of [].concat(dim.of(t, ctx))) { if (!by.has(k)) by.set(k, []); by.get(k).push(t); }
  let keys = [...by.keys()];
  if (dim.order === 'time') keys.sort();
  else if (dim.order === 'count') keys.sort((a, b) => by.get(b).length - by.get(a).length);
  else keys = dim.order.filter((k) => by.has(k));
  const run = {};
  return keys.map((k) => {
    const l = by.get(k);
    const values = {};
    for (const mk of metricKeys) {
      const m = METRIC[mk];
      if (!m) continue;
      const v = m.f(l);
      values[mk] = m.cumulative ? (run[mk] = (run[mk] || 0) + v) : v;
    }
    return { key: k, label: dim.fmt ? dim.fmt(k) : k, n: l.length, values };
  });
}

export function fmtMetric(v, unit) {
  if (!Number.isFinite(v)) return '—';
  if (unit === '$') { const a = Math.abs(v); return `${v < 0 ? '-' : ''}$${a >= 10000 ? `${(a / 1000).toFixed(1)}k` : a >= 100 ? Math.round(a).toLocaleString() : a.toFixed(2)}`; }
  if (unit === '%') return `${v.toFixed(v >= 10 || v === 0 ? 0 : 1)}%`;
  if (unit === 'x') return v.toFixed(2);
  if (unit === 'min') return v >= 60 ? `${Math.floor(v / 60)}h ${Math.round(v % 60)}m` : `${v.toFixed(v >= 10 ? 0 : 1)}m`;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
