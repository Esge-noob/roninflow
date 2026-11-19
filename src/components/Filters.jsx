import { Funnel, X } from 'lucide-react';
import { useStore } from '../store/store';
import { Popover } from './ui';
import { EMPTY_FILTERS, activeFilterCount, applyFilters, hasActiveFilters, normFilterField } from '../lib/filters';

export { EMPTY_FILTERS, activeFilterCount, applyFilters, hasActiveFilters, normFilterField };

export function FilterButton({ value, onChange, trades }) {
  const { state } = useStore();
  const active = activeFilterCount(value);
  const symbols = [...new Set(trades.map((t) => t.symbol))].sort();

  const updateField = (k, patch) => {
    const cur = normFilterField(value?.[k]);
    onChange({ ...value, [k]: { ...cur, ...patch } });
  };
  const setMode = (k, mode) => updateField(k, { mode });
  const addVal = (k, v) => {
    if (!v) return;
    const cur = normFilterField(value?.[k]);
    if (cur.values.includes(v)) return;
    updateField(k, { values: [...cur.values, v] });
  };
  const removeVal = (k, v) => {
    const cur = normFilterField(value?.[k]);
    updateField(k, { values: cur.values.filter((x) => x !== v) });
  };

  const fields = [
    ['symbol', 'Symbol', symbols.map((s) => [s, s])],
    ['direction', 'Direction', [['Long', 'Long'], ['Short', 'Short']]],
    ['result', 'Result', [['win', 'Winners'], ['loss', 'Losers'], ['be', 'Break even']]],
    ['tag', 'Tag', state.tags.map((t) => [t, t])],
    ['strategy', 'Strategy', [['none', 'No strategy'], ...state.strategies.map((s) => [s.id, s.name])]],
  ];

  return (
    <Popover
      align="right"
      width={340}
      trigger={({ toggle }) => (
        <button className="btn" onClick={toggle}>
          <Funnel size={15} fill="currentColor" /> Filters
          {active > 0 && <span className="badge pos" style={{ padding: '1px 6px' }}>{active}</span>}
        </button>
      )}
    >
      <div className="col gap12" style={{ padding: 10 }}>
        {fields.map(([k, label, opts]) => {
          const { mode, values } = normFilterField(value?.[k]);
          const excl = mode === 'exclude';
          const labelOf = (v) => opts.find(([ov]) => ov === v)?.[1] ?? v;
          const remaining = opts.filter(([ov]) => !values.includes(ov));
          return (
            <div key={k} className="field gap6">
              <div className="row between" style={{ alignItems: 'center' }}>
                <label className="label" style={{ margin: 0 }}>{label}</label>
                <div className="flt-mode" role="group" aria-label={`${label} filter mode`}>
                  <button type="button" className={!excl ? 'on' : ''} onClick={() => setMode(k, 'include')}>Include</button>
                  <button type="button" className={excl ? 'on neg' : ''} onClick={() => setMode(k, 'exclude')}>Exclude</button>
                </div>
              </div>
              <select
                className="select"
                style={{ height: 34 }}
                value=""
                onChange={(e) => addVal(k, e.target.value)}
                disabled={!remaining.length}
                aria-label={`${excl ? 'Exclude' : 'Include'} ${label}`}
              >
                <option value="">
                  {values.length
                    ? (remaining.length ? (excl ? 'Exclude another…' : 'Add another…') : 'All selected')
                    : (excl ? 'None excluded' : 'All')}
                </option>
                {remaining.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {values.length > 0 && (
                <div className="row gap6 wrap">
                  {values.map((v) => (
                    <span key={v} className={`chip ${excl ? 'neg-on' : 'on'}`} style={{ padding: '2px 7px', fontSize: 12 }}>
                      {excl ? `≠ ${labelOf(v)}` : labelOf(v)}
                      <button type="button" onClick={() => removeVal(k, v)} aria-label={`Remove ${labelOf(v)}`}><X size={12} /></button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <button className="btn sm" onClick={() => onChange(EMPTY_FILTERS)} disabled={!active}>Clear filters</button>
      </div>
    </Popover>
  );
}
