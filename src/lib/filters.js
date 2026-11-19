// Pure trade filtering logic supporting both Include and Exclude modes (and multiple values per field).

export const FILTER_KEYS = ['symbol', 'direction', 'result', 'tag', 'strategy'];

export const EMPTY_FILTERS = Object.freeze({
  symbol: Object.freeze({ mode: 'include', values: Object.freeze([]) }),
  direction: Object.freeze({ mode: 'include', values: Object.freeze([]) }),
  result: Object.freeze({ mode: 'include', values: Object.freeze([]) }),
  tag: Object.freeze({ mode: 'include', values: Object.freeze([]) }),
  strategy: Object.freeze({ mode: 'include', values: Object.freeze([]) }),
});

/** Normalize a single filter field (accepts legacy string values or { mode, values }). */
export function normFilterField(raw) {
  if (!raw) return { mode: 'include', values: [] };
  if (typeof raw === 'string') return { mode: 'include', values: [raw] };
  const mode = raw.mode === 'exclude' ? 'exclude' : 'include';
  const values = Array.isArray(raw.values) ? raw.values.filter((v) => v !== '' && v != null) : [];
  return { mode, values };
}

export function activeFilterCount(f) {
  if (!f) return 0;
  return FILTER_KEYS.reduce((n, k) => n + normFilterField(f[k]).values.length, 0);
}

export function hasActiveFilters(f) {
  return activeFilterCount(f) > 0;
}

function matchesValue(t, key, v) {
  switch (key) {
    case 'symbol': return t.symbol === v;
    case 'direction': return t.direction === v;
    case 'result': return v === 'win' ? t.pnl > 0 : v === 'loss' ? t.pnl < 0 : t.pnl === 0;
    case 'tag': return (t.tags || []).includes(v);
    case 'strategy': return v === 'none' ? !t.strategyId : t.strategyId === v;
    default: return true;
  }
}

export function applyFilters(trades, f) {
  if (!f) return trades;
  const rules = FILTER_KEYS.map((k) => [k, normFilterField(f[k])]).filter(([, r]) => r.values.length > 0);
  if (!rules.length) return trades;
  return trades.filter((t) =>
    rules.every(([k, { mode, values }]) => {
      const hit = values.some((v) => matchesValue(t, k, v));
      return mode === 'exclude' ? !hit : hit;
    }),
  );
}
