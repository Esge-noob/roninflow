// Ronin Score: one 0–100 number for how healthy your trading is, from six parts that are each scored 0–100.
import { summarize, maxDrawdown, groupByDay } from './stats.js';

const clamp = (v) => Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0));

export const RONIN_PARTS = [
  { key: 'win', label: 'Win %', weight: 15, how: 'Your win rate; 60% or more scores 100.' },
  { key: 'pf', label: 'Profit factor', weight: 25, how: 'Gross profit ÷ gross loss; 2.5 or more scores 100.' },
  { key: 'wl', label: 'Avg win/loss', weight: 20, how: 'Average win ÷ average loss; 2.5 or more scores 100.' },
  { key: 'recovery', label: 'Recovery factor', weight: 15, how: 'Net P&L ÷ biggest drawdown; 3 or more scores 100 (0 if you’re down).' },
  { key: 'dd', label: 'Max drawdown', weight: 15, how: 'Biggest drawdown as a share of your starting balance; 0% scores 100, 10% or more scores 0.' },
  { key: 'consistency', label: 'Consistency', weight: 10, how: 'How little of your profit came from your best day; 30% or less scores 100. When you’re down, half your green-day rate.' },
];

/** The score and its parts for a set of trades (initial = starting balance, for the drawdown part). */
export function roninScore(trades, initial = 50000) {
  const s = summarize(trades);
  const dd = maxDrawdown(trades);
  const days = groupByDay(trades);
  const avgLoss = Math.abs(s.avgLoss || 0);
  const wl = avgLoss ? (s.avgWin || 0) / avgLoss : s.avgWin > 0 ? Infinity : 0;
  const recovery = s.net <= 0 ? 0 : dd > 0 ? s.net / dd : Infinity;
  const ddPct = initial > 0 ? (dd / initial) * 100 : 0;
  const best = Math.max(0, ...days.map((d) => d.net));
  const greenRate = days.length ? days.filter((d) => d.net > 0).length / days.length : 0;
  const values = { win: s.winRate, pf: s.profitFactor, wl, recovery, dd: ddPct, consistency: s.net > 0 ? best / s.net : greenRate };
  const parts = {
    win: clamp((s.winRate / 60) * 100),
    pf: s.profitFactor === Infinity ? 100 : clamp((s.profitFactor / 2.5) * 100),
    wl: wl === Infinity ? 100 : clamp((wl / 2.5) * 100),
    recovery: recovery === Infinity ? 100 : clamp((recovery / 3) * 100),
    dd: clamp(100 - ddPct * 10),
    consistency: s.net > 0 ? clamp(((1 - best / s.net) / 0.7) * 100) : clamp(greenRate * 50),
  };
  const score = trades.length ? RONIN_PARTS.reduce((sum, p) => sum + parts[p.key] * p.weight, 0) / 100 : 0;
  return { score, parts, values, trades: trades.length, days: days.length };
}
