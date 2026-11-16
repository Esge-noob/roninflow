// Custom chart widget: pick what to group by and up to three metrics, each drawn as columns or a line.
// The first metric sets the left axis, the next metric with a different unit the right one.
import { useMemo, useState } from 'react';
import { ChevronDown, Plus, Trash2, ChartColumn, ChartLine, Check } from 'lucide-react';
import { Popover, Seg, useSize } from './ui';
import { DIMENSIONS, DIMENSION, METRICS, METRIC, customRows, fmtMetric } from '../lib/customChart';
import { playbookOf } from '../lib/playbook';

const COLORS = ['auto', '#4f6bed', '#f59e0b', '#2bc48a', '#e5484d', '#a78bfa', '#38bdf8', '#f472b6', '#94a3b8'];
const DEFAULT_SERIES = [{ m: 'net', type: 'column', color: 'auto' }, { m: 'count', type: 'line', color: '#f59e0b' }];
const GROUPS = [...new Set(METRICS.map((m) => m.group))];
const colorOf = (s, i, v) => (s.color && s.color !== 'auto' ? s.color : METRIC[s.m]?.unit === '$' ? (v >= 0 ? 'var(--pos)' : 'var(--neg)') : ['#4f6bed', '#f59e0b', '#38bdf8'][i]);
const swatch = (s, i) => (s.color && s.color !== 'auto' ? s.color : METRIC[s.m]?.unit === '$' ? 'linear-gradient(90deg, var(--pos) 50%, var(--neg) 50%)' : ['#4f6bed', '#f59e0b', '#38bdf8'][i]);

function niceTicks(min, max, n = 4) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0) || step0;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.abs(v) < step / 1e6 ? 0 : v);
  return out;
}

export default function CustomChart({ item, c, title }) {
  const { trades, state } = c;
  const dim = DIMENSION[item.opts?.dim] ? item.opts.dim : 'symbol';
  const series = (Array.isArray(item.opts?.series) && item.opts.series.length ? item.opts.series : DEFAULT_SERIES).filter((s) => METRIC[s.m]).slice(0, 3);
  const setSeries = (next) => c.setOpt(item.id, 'series', next);
  const ctx = useMemo(() => ({
    strategies: new Map(state.strategies.map((x) => [x.id, x.name])),
    accounts: new Map(state.accounts.map((a) => [a.id, a.name || a.id])),
    regimes: new Map((playbookOf(state).regimes || []).map((r) => [r.id, r.name])),
    diary: state.diary,
  }), [state.strategies, state.accounts, state.diary, state.settings.playbook]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => customRows(trades, dim, series.map((s) => s.m), ctx), [trades, dim, JSON.stringify(series), ctx]); // eslint-disable-line react-hooks/exhaustive-deps
  const [ref, { w, h }] = useSize();
  const [hover, setHover] = useState(null);

  // axes: left = first metric's unit; right = the next different unit; anything else gets its own (unlabelled) scale
  const axes = [];
  const axisOf = series.map((s) => {
    const u = METRIC[s.m].unit;
    let ax = axes.find((a) => a.unit === u);
    if (!ax) { ax = { unit: u, side: axes.length === 0 ? 'left' : axes.length === 1 ? 'right' : 'none', keys: [] }; axes.push(ax); }
    ax.keys.push(s.m);
    return ax;
  });
  for (const ax of axes) {
    const vals = rows.flatMap((r) => ax.keys.map((k) => r.values[k])).filter(Number.isFinite);
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    ax.ticks = niceTicks(lo, hi, 4);
    ax.min = ax.ticks[0]; ax.max = ax.ticks[ax.ticks.length - 1];
  }
  const left = axes.find((a) => a.side === 'left'), right = axes.find((a) => a.side === 'right');
  const W = Math.max(200, w || 0), H = Math.max(120, h || 0);
  const pad = { l: left ? 58 : 12, r: right ? 58 : 12, t: 10, b: 28 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const band = rows.length ? iw / rows.length : iw;
  const y = (ax, v) => pad.t + ih - ((v - ax.min) / (ax.max - ax.min || 1)) * ih;
  const cols = series.map((s, i) => ({ s, i })).filter((x) => x.s.type !== 'line');
  const colW = Math.max(2, Math.min(42, (band * 0.7) / Math.max(1, cols.length)));
  const every = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(iw / 64))));

  const setAt = (i, patch) => setSeries(series.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="panel wpanel cchart">
      <div className="panel-head cchart-head">
        <div className="card-title truncate">{title}</div>
        <div className="row gap6 cchart-ctl">
          <Popover align="right" width={200} trigger={({ toggle }) => <button className="btn xs" onClick={toggle} title="Group by">{DIMENSION[dim].label} <ChevronDown size={12} /></button>}>
            {(close) => DIMENSIONS.map((d) => <button key={d.key} className={`pop-item ${d.key === dim ? 'on' : ''}`} onClick={() => { c.setOpt(item.id, 'dim', d.key); close(); }}><span className="grow">{d.label}</span>{d.key === dim && <Check size={13} />}</button>)}
          </Popover>
          {series.map((s, i) => (
            <Popover key={i} align="right" width={260} trigger={({ toggle }) => (
              <button className="btn xs cchart-chip" onClick={toggle} style={{ '--sw': swatch(s, i) }}><i />{METRIC[s.m].label} <ChevronDown size={12} /></button>
            )}>
              {(close) => (
                <div className="cchart-pop">
                  <div className="row gap6">
                    <Seg value={s.type === 'line' ? 'line' : 'column'} onChange={(v) => setAt(i, { type: v })} options={[{ value: 'column', label: <><ChartColumn size={13} /> Column</> }, { value: 'line', label: <><ChartLine size={13} /> Line</> }]} />
                    <div className="grow" />
                    {series.length > 1 && <button className="icon-btn" title="Remove this metric" onClick={() => { setSeries(series.filter((_, j) => j !== i)); close(); }}><Trash2 size={14} /></button>}
                  </div>
                  <div className="cchart-colors">
                    {COLORS.map((col) => <button key={col} className={`cchart-sw ${(s.color || 'auto') === col ? 'on' : ''}`} title={col === 'auto' ? 'Automatic (green / red for $)' : col} style={{ background: col === 'auto' ? 'linear-gradient(135deg, var(--pos) 50%, var(--neg) 50%)' : col }} onClick={() => setAt(i, { color: col })} />)}
                  </div>
                  <div className="cchart-list">
                    {GROUPS.map((g) => (
                      <div key={g}>
                        <div className="cchart-group">{g}</div>
                        {METRICS.filter((m) => m.group === g).map((m) => <button key={m.key} className={`pop-item ${m.key === s.m ? 'on' : ''}`} onClick={() => setAt(i, { m: m.key })}><span className="grow">{m.label}</span>{m.key === s.m && <Check size={13} />}</button>)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Popover>
          ))}
          {series.length < 3 && <button className="btn xs ghost accent" onClick={() => setSeries([...series, { m: ['winRate', 'avgTrade', 'count'].find((m) => !series.some((s) => s.m === m)) || 'winRate', type: 'line', color: COLORS[series.length + 1] }])}><Plus size={12} /> Add metric</button>}
        </div>
      </div>
      <div className="wbody">
        <div ref={ref} className="cchart-box" onMouseLeave={() => setHover(null)}>
          {!rows.length ? <div className="w-empty">Nothing to show</div> : w > 0 && (
            <svg width={W} height={H} className="cchart-svg" onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.floor((e.clientX - r.left - pad.l) / band); setHover(i >= 0 && i < rows.length ? i : null); }}>
              {left && left.ticks.map((t) => <g key={`l${t}`}><line x1={pad.l} x2={W - pad.r} y1={y(left, t)} y2={y(left, t)} className={t === 0 ? 'cchart-zero' : 'cchart-grid'} /><text x={pad.l - 8} y={y(left, t)} className="cchart-tick" textAnchor="end" dominantBaseline="middle">{fmtMetric(t, left.unit)}</text></g>)}
              {right && right.ticks.map((t) => <text key={`r${t}`} x={W - pad.r + 8} y={y(right, t)} className="cchart-tick" dominantBaseline="middle">{fmtMetric(t, right.unit)}</text>)}
              {hover != null && <rect x={pad.l + hover * band} y={pad.t} width={band} height={ih} className="cchart-hover" />}
              {cols.map(({ s, i }, ci) => rows.map((r, ri) => {
                const v = r.values[s.m];
                if (!Number.isFinite(v)) return null;
                const ax = axisOf[i];
                const x = pad.l + ri * band + (band - colW * cols.length) / 2 + ci * colW;
                const y0 = y(ax, 0), y1 = y(ax, v);
                return <rect key={`${i}-${ri}`} x={x + 1} width={colW - 2} y={Math.min(y0, y1)} height={Math.max(1, Math.abs(y1 - y0))} fill={colorOf(s, i, v)} opacity={hover == null || hover === ri ? 0.9 : 0.55} rx="1.5" />;
              }))}
              {series.map((s, i) => {
                if (s.type !== 'line') return null;
                const ax = axisOf[i];
                const P = rows.map((r, ri) => [pad.l + ri * band + band / 2, y(ax, r.values[s.m] || 0)]);
                const col = colorOf(s, i, 1);
                return (
                  <g key={`line${i}`}>
                    <polyline points={P.map((p) => p.join(',')).join(' ')} fill="none" stroke={col} strokeWidth="2" strokeLinejoin="round" />
                    {P.map((p, ri) => <circle key={ri} cx={p[0]} cy={p[1]} r={hover === ri ? 4.5 : rows.length > 40 ? 0 : 3} fill={col} />)}
                  </g>
                );
              })}
              {rows.map((r, ri) => (ri % every === 0 ? <text key={`x${ri}`} x={pad.l + ri * band + band / 2} y={H - 8} className="cchart-tick" textAnchor="middle">{String(r.label).length > 12 ? `${String(r.label).slice(0, 11)}…` : r.label}</text> : null))}
            </svg>
          )}
          {hover != null && rows[hover] && (
            <div className="cchart-tip" style={{ left: Math.min(Math.max(8, pad.l + hover * band + band / 2 + 12), W - 190) }}>
              <b>{rows[hover].label}</b>
              {series.map((s, i) => <div key={i} className="row gap6"><i style={{ background: colorOf(s, i, rows[hover].values[s.m]) }} /><span className="grow">{METRIC[s.m].label}</span><b>{fmtMetric(rows[hover].values[s.m], METRIC[s.m].unit)}</b></div>)}
              <div className="muted">{rows[hover].n} trade{rows[hover].n === 1 ? '' : 's'}</div>
            </div>
          )}
        </div>
        <div className="cchart-legend">
          {series.map((s, i) => <span key={i}><i style={{ background: swatch(s, i) }} />{METRIC[s.m].label}{axisOf[i].side === 'right' ? ' (right)' : axisOf[i].side === 'none' ? ' (own scale)' : ''}</span>)}
        </div>
      </div>
    </div>
  );
}
