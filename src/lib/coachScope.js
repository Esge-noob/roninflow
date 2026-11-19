// The Trading Coach's context filters: which trades a question is about — by strategy, the day's market condition
// (from the diary's pre-session check-in), tags and edge blockers — on top of the account and period.
import { keyOf, toDate } from './stats';

export const ANY = '__any', NONE = '__none';
export const EMPTY_FILTERS = { strategy: '', regime: '', tags: [], blockers: [] };

const dayOf = (t) => keyOf(toDate(String(t.entry)));

/** The trades that pass the filters. Tags and blockers match any of those picked. */
export function filterScope(trades, state, f = {}) {
  let list = trades;
  if (f.strategy === NONE) list = list.filter((t) => !t.strategyId);
  else if (f.strategy) list = list.filter((t) => t.strategyId === f.strategy);
  if (f.regime === NONE) list = list.filter((t) => !state.diary?.[dayOf(t)]?.pre?.regime);
  else if (f.regime) list = list.filter((t) => state.diary?.[dayOf(t)]?.pre?.regime === f.regime);
  if (f.tags?.length) list = list.filter((t) => (t.tags || []).some((x) => f.tags.includes(x)));
  if (f.blockers?.includes(NONE)) list = list.filter((t) => !(t.blockers || []).length);
  else if (f.blockers?.includes(ANY)) list = list.filter((t) => (t.blockers || []).length);
  else if (f.blockers?.length) list = list.filter((t) => (t.blockers || []).some((x) => f.blockers.includes(x)));
  return list;
}

/** How many filters are set (for the Context button). */
export const filterCount = (f = {}) => (f.strategy ? 1 : 0) + (f.regime ? 1 : 0) + (f.tags?.length ? 1 : 0) + (f.blockers?.length ? 1 : 0);

/** The filters in words, for the AI ("only trades tagged A+ setup on trending days"). */
export function describeScope(state, f = {}, regimes = []) {
  const out = {};
  if (f.strategy) out.strategy = f.strategy === NONE ? 'trades with no strategy set' : state.strategies.find((s) => s.id === f.strategy)?.name || f.strategy;
  if (f.regime) out.marketCondition = f.regime === NONE ? 'days with no market condition logged' : regimes.find((r) => r.id === f.regime)?.name || f.regime;
  if (f.tags?.length) out.tags = `trades tagged any of: ${f.tags.join(', ')}`;
  if (f.blockers?.length) out.edgeBlockers = f.blockers.includes(NONE) ? 'only trades with no edge blockers (disciplined trades)' : f.blockers.includes(ANY) ? 'only trades with at least one edge blocker' : `trades with any of these edge blockers: ${f.blockers.join(', ')}`;
  return Object.keys(out).length ? out : null;
}
