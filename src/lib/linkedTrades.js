// Linked trades: the same trade taken on several accounts (copy trading). Reviews written on one copy —
// notes, tags, strategy, edge blockers, rating, screenshots, reviewed — can be shared with the others, so
// nothing is lost when the account you journal on is breached or closed.

/** The trade fields that make up a review. */
export const REVIEW_FIELDS = ['notes', 'tags', 'strategyId', 'blockers', 'rating', 'screenshots', 'reviewed'];

/** How far apart two copies' entries can be (seconds). */
export const LINK_TOLERANCE = 60;

/** A contract's root: MESZ6 / MESZ26 / MES 12-26 / MES@CME → MES; 6EZ5 → 6E. */
export function symbolRoot(sym) {
  const s = String(sym || '').toUpperCase().trim().split(/[\s@.:]/)[0];
  const m = s.match(/^([A-Z0-9]+?)([FGHJKMNQUVXZ]\d{1,2})?$/);
  return m ? m[1] : s;
}

const secs = (iso) => new Date(iso).getTime() / 1000;

/** Are a and b the same trade on two different accounts? */
export function sameTrade(a, b, tol = LINK_TOLERANCE) {
  if (!a || !b || a.id === b.id || !a.accountId || a.accountId === b.accountId) return false;
  if (a.direction !== b.direction || symbolRoot(a.symbol) !== symbolRoot(b.symbol)) return false;
  const de = Math.abs(secs(a.entry) - secs(b.entry));
  return Number.isFinite(de) && de <= tol;
}

/** Which accounts a trade on `fromAccount` shares its review with, under the setting { mode, accounts }. */
export function shareTargets(sync, accounts, fromAccount) {
  if (!sync || !sync.mode || sync.mode === 'off') return [];
  const ids = sync.mode === 'all' ? accounts.map((a) => a.id) : (sync.accounts || []).filter((id) => accounts.some((a) => a.id === id));
  return ids.filter((id) => id !== fromAccount);
}

/** The copies of `trade` on the target accounts: for each account, the closest-in-time match. */
export function linkedTrades(trade, trades, targets) {
  if (!targets.length) return [];
  const want = new Set(targets);
  const best = new Map(); // accountId → { t, d }
  for (const t of trades) {
    if (!want.has(t.accountId) || !sameTrade(trade, t)) continue;
    const d = Math.abs(secs(t.entry) - secs(trade.entry));
    const cur = best.get(t.accountId);
    if (!cur || d < cur.d) best.set(t.accountId, { t, d });
  }
  return [...best.values()].map((x) => x.t);
}

/** Just the review part of a patch. */
export function reviewPart(patch) {
  const out = {};
  for (const k of REVIEW_FIELDS) if (patch && k in patch) out[k] = patch[k];
  return out;
}

const empty = (v) => v == null || v === '' || v === 0 || v === false || (Array.isArray(v) && !v.length);
const hasReview = (t) => REVIEW_FIELDS.some((k) => !empty(t[k]));

/** Fill the gaps in `into` from `from`, never overwriting: lists are merged, other fields only set if empty. */
export function mergeReview(into, from) {
  const patch = {};
  for (const k of REVIEW_FIELDS) {
    const a = into[k], b = from[k];
    if (empty(b)) continue;
    if (Array.isArray(b)) {
      const merged = [...new Set([...(a || []), ...b])];
      if (merged.length !== (a || []).length) patch[k] = merged;
    } else if (empty(a)) patch[k] = b;
  }
  return patch;
}

/**
 * Copy existing reviews to their linked trades on the target accounts (oldest first; never overwrites).
 * Returns { trades, changed, fields } — `changed`: how many trades got something new; `fields`: per field.
 */
export function backfillReviews(trades, accounts, sync) {
  const byId = new Map(trades.map((t) => [t.id, t]));
  const touched = new Set();
  const fields = {}; // field → how many copies it's added to
  if (!sync || !sync.mode || sync.mode === 'off') return { trades, changed: 0, fields: {} };
  // only trades on the same contract and side can be copies: bucket them so big journals stay fast
  // (each bucket sorted by entry time, so only the minute around a trade is looked at)
  const buckets = new Map();
  for (const t of trades) { const k = `${symbolRoot(t.symbol)}|${t.direction}`; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push({ id: t.id, at: secs(t.entry) }); }
  for (const list of buckets.values()) list.sort((x, y) => x.at - y.at);
  const near = (list, at) => {
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].at < at - LINK_TOLERANCE) lo = mid + 1; else hi = mid; }
    const out = [];
    for (let i = lo; i < list.length && list[i].at <= at + LINK_TOLERANCE; i++) out.push(byId.get(list[i].id));
    return out;
  };
  const sources = trades.filter(hasReview).sort((a, b) => String(a.entry).localeCompare(String(b.entry)));
  for (const src of sources) {
    const targets = shareTargets(sync, accounts, src.accountId);
    if (!targets.length) continue;
    const pool = near(buckets.get(`${symbolRoot(src.symbol)}|${src.direction}`), secs(src.entry));
    for (const copy of linkedTrades(src, pool, targets)) {
      const cur = byId.get(copy.id);
      const patch = mergeReview(cur, byId.get(src.id));
      if (Object.keys(patch).length) {
        byId.set(cur.id, { ...cur, ...patch });
        touched.add(cur.id);
        for (const k of Object.keys(patch)) fields[k] = (fields[k] || new Set()).add(cur.id);
      }
    }
  }
  return { trades: trades.map((t) => byId.get(t.id)), changed: touched.size, fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.size])) };
}
