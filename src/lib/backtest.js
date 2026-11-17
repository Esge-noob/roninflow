// Backtesting: simulated trading on the replay (positions, bracket orders, fills) and "what-if" tests that re-run
// your real trades under different rules. Pure functions — the chart and the Backtest page call these.

// $ per 1.00 point move, per contract — most futures roots; anything else defaults to 1 (stocks, crypto, forex units)
export const POINT_VALUES = {
  ES: 50, MES: 5, NQ: 20, MNQ: 2, YM: 5, MYM: 0.5, RTY: 50, M2K: 5,
  CL: 1000, MCL: 100, QM: 500, NG: 10000, QG: 2500, GC: 100, MGC: 10, SI: 5000, SIL: 1000, HG: 25000, PL: 50, PA: 100,
  ZB: 1000, UB: 1000, ZN: 1000, ZF: 1000, ZT: 2000, ZC: 50, ZS: 50, ZW: 50, HE: 400, LE: 400,
  '6E': 125000, M6E: 12500, '6B': 62500, M6B: 6250, '6A': 100000, M6A: 10000, '6J': 12500000, '6C': 100000, '6S': 125000, '6N': 100000, '6M': 500000,
  BTC: 5, MBT: 0.1, ETH: 50, MET: 0.1,
};
const ROOTS = Object.keys(POINT_VALUES).sort((a, b) => b.length - a.length);
export const rootOf = (s) => { const u = String(s || '').toUpperCase().trim(); return ROOTS.find((r) => u.startsWith(r)) || u; };
export const pointValueOf = (symbol) => POINT_VALUES[rootOf(symbol)] ?? 1;

const r2 = (v) => Math.round(v * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
/** unix seconds → the journal's local wall-clock time ("2026-11-13T06:45:59") */
export const localIso = (u) => { const d = new Date(u * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

/*
 * A position: { dir: 1 | -1, lots: [{ t, price, qty }], done: [fills closed so far], stop, target, high }
 *   lots = what's still open (first in, first out); a fill = { entry, entryPrice, exit, exitPrice, qty } like an imported trade's fills.
 * When the position goes flat it becomes one journal trade.
 */
export const posQty = (p) => (p ? p.lots.reduce((s, l) => s + l.qty, 0) : 0);
export const posAvg = (p) => { const q = posQty(p); return q ? p.lots.reduce((s, l) => s + l.price * l.qty, 0) / q : 0; };
export const openPnl = (p, price, pv) => (p ? r2(p.lots.reduce((s, l) => s + (price - l.price) * p.dir * l.qty, 0) * pv) : 0);

/** The journal trade for a position that just went flat. */
export function toTrade(p, { symbol, pv, feePerContract = 0, accountId = 'backtest', strategyId = null, idPrefix = 'bt' }) {
  const fills = p.done;
  const qtyIn = fills.reduce((s, f) => s + f.qty, 0);
  const wavg = (k) => fills.reduce((s, f) => s + f[k] * f.qty, 0) / qtyIn;
  const gross = fills.reduce((s, f) => s + (f.exitPrice - f.entryPrice) * p.dir * f.qty, 0) * pv;
  const fees = r2(feePerContract * qtyIn);
  const entry = fills.map((f) => f.entry).sort()[0];
  const exit = fills.map((f) => f.exit).sort().slice(-1)[0];
  return {
    id: `${idPrefix}_${entry.replace(/\D/g, '')}_${Math.random().toString(36).slice(2, 6)}`,
    accountId, symbol, direction: p.dir > 0 ? 'Long' : 'Short', entry, exit, qty: qtyIn,
    entryPrice: r2(wavg('entryPrice') * 1e4) / 1e4, exitPrice: r2(wavg('exitPrice') * 1e4) / 1e4, fees, pnl: r2(gross - fees),
    fills: fills.length > 1 ? fills : undefined, tags: [], strategyId, notes: '', rating: 0, reviewed: false, screenshots: [],
    stop: p.firstStop ?? undefined, target: p.firstTarget ?? undefined,
  };
}

/** Close `qty` of the position at `price` (first in, first out). Returns the position left (null when flat). */
function reduce(p, qty, price, t) {
  let left = qty;
  const lots = [];
  const done = [...p.done];
  for (const l of p.lots) {
    if (left <= 0) { lots.push(l); continue; }
    const q = Math.min(l.qty, left);
    done.push({ entry: localIso(l.t), entryPrice: l.price, exit: localIso(t), exitPrice: price, qty: q });
    left -= q;
    if (l.qty > q) lots.push({ ...l, qty: l.qty - q });
  }
  return { ...p, lots, done };
}

/**
 * A market order: side 1 = buy, -1 = sell, `qty` contracts at `price`, time `t` (unix seconds).
 * Same direction adds to the position; the other direction reduces it, closes it, or closes and reverses.
 * Returns { pos, closed } — closed = the position that went flat (turn it into a trade with toTrade), or null.
 */
export function marketOrder(pos, side, qty, price, t, { stop = null, target = null } = {}) {
  qty = Math.max(1, Math.floor(Number(qty) || 1));
  if (!pos || !posQty(pos)) {
    return { pos: { dir: side, lots: [{ t, price, qty }], done: [], stop, target, firstStop: stop, firstTarget: target }, closed: null };
  }
  if (pos.dir === side) return { pos: { ...pos, lots: [...pos.lots, { t, price, qty }] }, closed: null };
  const have = posQty(pos);
  const after = reduce(pos, Math.min(qty, have), price, t);
  if (qty < have) return { pos: after, closed: null };
  const rest = qty - have;
  return { pos: rest > 0 ? { dir: side, lots: [{ t, price, qty: rest }], done: [], stop, target, firstStop: stop, firstTarget: target } : null, closed: after };
}

/** Close everything at `price`. */
export function flatten(pos, price, t) {
  if (!pos || !posQty(pos)) return { pos: null, closed: null };
  return { pos: null, closed: reduce(pos, posQty(pos), price, t) };
}

/**
 * One new bar [t, o, h, l, c, v] against the open position's stop and target. A bar that reaches both is counted
 * as the stop (we can't see inside the bar, so the worse fill is assumed). A bar that opens past a level fills at
 * the open (a gap). Returns { pos, closed, hit: 'stop' | 'target' | null }.
 */
export function stepBar(pos, bar, barSec = 60) {
  if (!pos || !posQty(pos)) return { pos, closed: null, hit: null };
  const [t, o, h, l] = bar;
  const { dir, stop, target } = pos;
  const stopHit = stop != null && (dir > 0 ? l <= stop : h >= stop);
  const targetHit = target != null && (dir > 0 ? h >= target : l <= target);
  const at = t + Math.min(30, Math.max(1, Math.floor(barSec / 2)));
  if (stopHit) {
    const px = dir > 0 ? Math.min(o, stop) : Math.max(o, stop);
    return { ...flatten(pos, px, at), hit: 'stop' };
  }
  if (targetHit) {
    const px = dir > 0 ? Math.max(o, target) : Math.min(o, target);
    return { ...flatten(pos, px, at), hit: 'target' };
  }
  return { pos, closed: null, hit: null };
}

/*
 * Working orders: { id, side: 1 | -1, type: 'limit' | 'stop', price, qty }
 *   buy limit fills when price trades at or below it, buy stop at or above it (sells the other way round). A bar that
 *   opens past the level fills at the open (a gap) — a limit gets the better price, a stop the worse one.
 */
const trips = (ord, h, l) => (ord.type === 'limit' ? (ord.side > 0 ? l <= ord.price : h >= ord.price) : (ord.side > 0 ? h >= ord.price : l <= ord.price));
const fillAt = (ord, o) => (ord.type === 'limit' ? (ord.side > 0 ? Math.min(o, ord.price) : Math.max(o, ord.price)) : (ord.side > 0 ? Math.max(o, ord.price) : Math.min(o, ord.price)));

/**
 * One new bar against the position's stop and target and the working orders.
 *   1. the open position's stop / target (a bar reaching both counts as the stop)
 *   2. working orders the bar reached, in the order price got to them from the open; one filling cancels the rest of
 *      its OCO group (`oco`)
 *   3. a position opened by an order inside this bar is stopped out in it too if the bar went past its stop (we can't
 *      see inside the bar, so the worse case is assumed)
 * `bracketsFor(side, price)` gives { stop, target } for a position an order opens.
 * Returns { pos, orders (still working), filled: [{ order, price }], closed: [{ closed, why }] }.
 */
export function stepOrders(pos, orders, bar, barSec = 60, bracketsFor = () => ({})) {
  const [t, o, h, l] = bar;
  const at = t + Math.min(30, Math.max(1, Math.floor(barSec / 2)));
  const closed = [], filled = [];
  const first = stepBar(pos, bar, barSec);
  if (first.closed) closed.push({ closed: first.closed, why: first.hit });
  pos = first.pos;
  let left = [...(orders || [])];
  const reached = left.filter((ord) => trips(ord, h, l)).sort((a, b) => Math.abs(fillAt(a, o) - o) - Math.abs(fillAt(b, o) - o));
  for (const ord of reached) {
    if (!left.includes(ord)) continue; // its OCO partner filled first
    left = left.filter((x) => x !== ord && !(ord.oco && x.oco === ord.oco));
    const px = fillAt(ord, o);
    const have = posQty(pos);
    const opens = !have || pos.dir === ord.side || ord.qty > have;
    const m = marketOrder(pos, ord.side, ord.qty, px, at, opens ? bracketsFor(ord.side, px) : {});
    if (m.closed) closed.push({ closed: m.closed, why: 'order' });
    pos = m.pos;
    filled.push({ order: ord, price: px });
  }
  if (filled.length && pos && posQty(pos) && pos.stop != null && (pos.dir > 0 ? l <= pos.stop : h >= pos.stop)) {
    const f = flatten(pos, pos.stop, at);
    closed.push({ closed: f.closed, why: 'stop' });
    pos = null;
  }
  return { pos, orders: left, filled, closed };
}

/** Stats-friendly summary of a backtest session. */
export function sessionDays(session) {
  const days = new Set((session.trades || []).map((t) => String(t.entry).slice(0, 10)));
  for (const d of session.days || []) days.add(d);
  return [...days].sort();
}

/** The next weekday after `date` (YYYY-MM-DD). */
export function nextWeekday(date, step = 1) {
  const d = new Date(`${date}T12:00:00`);
  do d.setDate(d.getDate() + step); while (d.getDay() === 0 || d.getDay() === 6);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 9:30 AM New York as local "HH:MM" (the US cash open) — the default start of a backtest day. */
export function nyOpenLocal(date) {
  const guess = new Date(`${date}T14:30:00Z`); // 9:30 EST
  const ny = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(guess));
  const at = new Date(guess.getTime() - (ny - 9) * 3600e3);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

// ---------------------------------------------------------------------------------------------- what-if tests

export const WHATIF_DEFAULT = {
  days: [1, 2, 3, 4, 5], from: '', to: '', maxTrades: '', maxLosses: '', dayLoss: '', dayTarget: '', tradeLoss: '',
  side: 'both', skipStrategies: [], skipSymbols: [], skipTags: [], skipBlockers: false,
};
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : Number(v));
const hhmm = (iso) => String(iso).slice(11, 16);
const weekday = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00`).getDay();

/** Which rules are switched on (for "no rules yet" and the summary line). */
export function activeRules(r) {
  const out = [];
  if (r.days && r.days.length < 7 && !(r.days.length === 5 && [1, 2, 3, 4, 5].every((d) => r.days.includes(d)))) out.push('days');
  if (r.from || r.to) out.push('hours');
  if (num(r.maxTrades)) out.push('maxTrades');
  if (num(r.maxLosses)) out.push('maxLosses');
  if (num(r.dayLoss)) out.push('dayLoss');
  if (num(r.dayTarget)) out.push('dayTarget');
  if (num(r.tradeLoss)) out.push('tradeLoss');
  if (r.side && r.side !== 'both') out.push('side');
  if (r.skipStrategies?.length) out.push('skipStrategies');
  if (r.skipSymbols?.length) out.push('skipSymbols');
  if (r.skipTags?.length) out.push('skipTags');
  if (r.skipBlockers) out.push('skipBlockers');
  return out;
}

export const RULE_LABEL = {
  days: 'Only the weekdays picked', hours: 'Only between the times set', maxTrades: 'Max trades a day', maxLosses: 'Stop after losing trades',
  dayLoss: 'Daily loss limit', dayTarget: 'Daily profit target', tradeLoss: 'Max loss per trade', side: 'Long / short only',
  skipStrategies: 'Skipped strategies', skipSymbols: 'Skipped symbols', skipTags: 'Skipped tags', skipBlockers: 'Trades with an edge blocker',
};

/**
 * Re-run `trades` under the rules. Returns { kept: trades as they'd have been (losses capped by the max-loss rule),
 * removed: [{ trade, rule }], capped: [{ trade, saved }], byRule: { rule: { count, pnl } } }.
 * Day rules (max trades, stop after losses, daily loss / profit) act in time order within each day, on the trades the
 * other rules left in — the trade that reaches a limit still counts, the ones after it are skipped.
 * `blockersOf(trade)` → that trade's edge blockers (for skipBlockers).
 */
export function runWhatIf(trades, rules = WHATIF_DEFAULT, { blockersOf = () => [] } = {}) {
  const r = { ...WHATIF_DEFAULT, ...rules };
  const removed = [];
  const capped = [];
  const kept = [];
  const cap = num(r.tradeLoss);
  const days = new Set(r.days?.length ? r.days : [0, 1, 2, 3, 4, 5, 6]);
  const skipS = new Set(r.skipStrategies || []);
  const skipSym = new Set((r.skipSymbols || []).map(rootOf));
  const skipTag = new Set(r.skipTags || []);
  const pre = [];
  for (const t of [...trades].sort((a, b) => String(a.entry).localeCompare(String(b.entry)))) {
    const why = !days.has(weekday(t.entry)) ? 'days'
      : (r.from && hhmm(t.entry) < r.from) || (r.to && hhmm(t.entry) >= r.to) ? 'hours'
        : r.side === 'long' && t.direction === 'Short' ? 'side'
          : r.side === 'short' && t.direction !== 'Short' ? 'side'
            : skipS.has(t.strategyId || '__none') ? 'skipStrategies'
              : skipSym.has(rootOf(t.symbol)) ? 'skipSymbols'
                : (t.tags || []).some((x) => skipTag.has(x)) ? 'skipTags'
                  : r.skipBlockers && blockersOf(t).length ? 'skipBlockers'
                    : null;
    if (why) removed.push({ trade: t, rule: why });
    else pre.push(t);
  }
  const maxT = num(r.maxTrades), maxL = num(r.maxLosses), dLoss = num(r.dayLoss), dTarget = num(r.dayTarget);
  let day = null, n = 0, losses = 0, run = 0, stopped = null;
  for (const t0 of pre) {
    const d = String(t0.entry).slice(0, 10);
    if (d !== day) { day = d; n = 0; losses = 0; run = 0; stopped = null; }
    if (stopped) { removed.push({ trade: t0, rule: stopped }); continue; }
    let t = t0;
    if (cap && t.pnl < -cap) { capped.push({ trade: t0, saved: r2(-cap - t.pnl) }); t = { ...t0, pnl: r2(-cap), capped: true }; }
    kept.push(t);
    n += 1; run += t.pnl; if (t.pnl < 0) losses += 1;
    if (maxT && n >= maxT) stopped = 'maxTrades';
    else if (maxL && losses >= maxL) stopped = 'maxLosses';
    else if (dLoss && run <= -dLoss) stopped = 'dayLoss';
    else if (dTarget && run >= dTarget) stopped = 'dayTarget';
  }
  const byRule = {};
  for (const { trade, rule } of removed) { const b = byRule[rule] || (byRule[rule] = { count: 0, pnl: 0 }); b.count += 1; b.pnl = r2(b.pnl + trade.pnl); }
  if (capped.length) byRule.tradeLoss = { count: capped.length, saved: r2(capped.reduce((s, c) => s + c.saved, 0)) };
  return { kept, removed, capped, byRule };
}
