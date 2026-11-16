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
  return { score, parts, values, trades: trades.length, days: days.length, net: s.net, maxDD: dd, bestDay: best, avgWin: s.avgWin || 0, avgLoss: avgLoss, netUp: s.net > 0, greenRate };
}

const money = (v) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`;
const pct = (v) => `${Math.round(v)}%`;
const r2 = (v) => (v === Infinity ? 'no losses yet' : v.toFixed(2));

/** What each part of the score says about these trades, weakest first, in plain words. */
export function roninInsights(r) {
  const v = r.values;
  const band = r.score >= 70 ? 'strong' : r.score >= 45 ? 'developing' : 'needs work';
  const say = {
    win: {
      value: `${pct(v.win)} of trades win`,
      meaning: v.win >= 60 ? 'You pick winners more often than most traders.'
        : v.win >= 45 ? 'About half your trades win — normal for most styles.'
          : `You win fewer than ${v.win < 35 ? '1 in 3' : '1 in 2'} trades, so your winners have to be much bigger than your losers to pay off (yours are ${r2(v.wl)}× as big).`,
      tip: 'Review your losing trades for entries taken before your setup was complete, and trades outside your best hours or setups — cutting those lifts win rate fastest.',
    },
    pf: {
      value: `profit factor ${r2(v.pf)}`,
      meaning: v.pf < 1 ? `You lose more than you make — every $1 lost brings back only $${v.pf.toFixed(2)}.`
        : v.pf < 1.5 ? `There's an edge, but it's thin: every $1 lost brings back $${v.pf.toFixed(2)}. A few bad trades can wipe it out.`
          : v.pf < 2.5 ? `A solid edge — every $1 lost brings back $${v.pf.toFixed(2)}.`
            : 'A strong edge: your gross profit is well over twice your gross loss.',
      tip: 'Profit factor improves from both ends: drop the setups that lose money (see Strategy performance) and let your best setups run to their target.',
    },
    wl: {
      value: `average win ${money(r.avgWin)} vs average loss ${money(r.avgLoss)}`,
      meaning: v.wl < 1 ? 'Your losses are bigger than your wins — a sign of holding losers too long or taking profits too early.'
        : v.wl < 1.5 ? 'Wins and losses are about the same size, so you rely on winning more often than not.'
          : v.wl < 2.5 ? 'Your winners are clearly bigger than your losers.'
            : 'Your winners are much bigger than your losers — you cut losses and let winners run.',
      tip: 'Set your stop and target before entering and leave the stop alone; check the Hold time chart — if losers are held longer than winners, that is the leak.',
    },
    recovery: {
      value: r.netUp ? `net ${money(r.net)} vs biggest drawdown ${money(r.maxDD)}` : `net ${money(r.net)}`,
      meaning: !r.netUp ? 'You’re down over this period, so nothing has been recovered yet.'
        : v.recovery < 1 ? 'Your biggest drawdown is larger than everything you’ve made — one bad stretch costs more than your profit.'
          : v.recovery < 3 ? `You’ve made ${r2(v.recovery)}× your biggest drawdown back. Getting it past 3 means drawdowns stop being a threat.`
            : 'Your profit dwarfs your worst drawdown — you recover from bad stretches quickly.',
      tip: 'Use a daily loss limit and step away after it: drawdowns shrink fastest when losing days stay small. Risk tiers on the Risk page do this automatically.',
    },
    dd: {
      value: `biggest drawdown ${money(r.maxDD)} (${v.dd.toFixed(1)}% of your balance)`,
      meaning: v.dd < 2 ? 'Your drawdowns are small for your account size.'
        : v.dd < 5 ? 'Your drawdowns are moderate — within most prop firms’ limits, but worth watching.'
          : 'Your drawdowns are large for your account — on a prop account this is close to or past the max loss.',
      tip: 'Trade smaller after losses (risk tiers), cap trades per day, and avoid adding to losing positions.',
    },
    consistency: {
      value: !r.netUp ? `${pct(r.greenRate * 100)} of days are green` : v.consistency > 1 ? `best day ${money(r.bestDay)} vs total profit ${money(r.net)}` : `best day ${money(r.bestDay)} = ${pct(v.consistency * 100)} of your profit`,
      meaning: !r.netUp ? 'You’re down overall, so this looks at how many of your days end green.'
        : v.consistency > 1 ? 'Your best day made more than your total profit — without it you’d be down. Your other days are giving back what that day made, and prop firms’ consistency rules would hold back a payout.'
        : v.consistency > 0.5 ? 'Most of your profit came from one day — take it away and your results look very different, and many prop firms’ consistency rules would hold back a payout.'
          : v.consistency > 0.3 ? 'A big share of your profit came from your best day; spreading it out makes your results more dependable.'
            : 'Your profit is spread across many days — dependable, and it passes prop firms’ consistency rules.',
      tip: 'Aim for steady days over home runs: same size every day, a daily profit target to stop on, and no oversizing on your best days.',
    },
  };
  const parts = RONIN_PARTS.map((p) => ({ ...p, score: r.parts[p.key], ...say[p.key] })).sort((a, b) => a.score - b.score);
  const strongest = parts[parts.length - 1];
  const summary = !r.trades ? 'No trades in this view yet.'
    : `Your score of ${r.score.toFixed(1)} is ${band === 'needs work' ? 'in the needs-work range' : band}. ${parts[0].label} is holding it back most${parts[0].score < 50 ? ` (${Math.round(parts[0].score)}/100)` : ''}; ${strongest.label.toLowerCase()} is your strongest part (${Math.round(strongest.score)}/100).`;
  return { band, summary, parts };
}
