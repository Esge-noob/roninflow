// Ronin Score widget: a radar of the six parts and the overall score on a 0–100 bar.
import { useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { Popover, useSize } from './ui';
import { roninScore, RONIN_PARTS } from '../lib/roninScore';
import { pfText } from '../lib/stats';

const fmtValue = (key, v, r) => {
  if (key === 'win') return `${Math.round(v)}%`;
  if (key === 'pf') return pfText(v);
  if (key === 'wl' || key === 'recovery') return v === Infinity ? '∞' : v.toFixed(2);
  if (key === 'dd') return `${v.toFixed(1)}% of balance`;
  if (key === 'consistency') return r.netUp ? `best day = ${Math.round(v * 100)}% of profit` : `${Math.round(v * 100)}% green days`;
  return String(v);
};
export const scoreColor = (s) => (s >= 70 ? 'var(--pos)' : s >= 45 ? 'var(--warn)' : 'var(--neg)');

/** Picks the layout from the space the widget has: a KPI-sized card, or the full radar. */
export default function RoninScore({ trades, initial }) {
  const r = useMemo(() => { const x = roninScore(trades, initial); x.netUp = trades.reduce((a, t) => a + t.pnl, 0) > 0; return x; }, [trades, initial]);
  const [ref, { w, h }] = useSize();
  const compact = h > 0 && (h < 330 || w < 300);
  return <div ref={ref} className="ronin-wrap">{h > 0 && (compact ? <RoninCard r={r} /> : <RoninFull r={r} />)}</div>;
}

function HowItWorks({ r }) {
  return (
    <Popover align="right" width={340} trigger={({ toggle }) => <button className="icon-btn" onClick={toggle} title="How it's worked out"><Info size={15} /></button>}>
      {() => (
        <div className="ronin-how">
          <b>How the Ronin Score is worked out</b>
          <p className="muted">Six parts are each scored 0–100, then weighted into one score.</p>
          {RONIN_PARTS.map((p) => (
            <div key={p.key} className="ronin-how-row">
              <div className="row between"><span>{p.label} <span className="muted">· {p.weight}%</span></span><b style={{ color: scoreColor(r.parts[p.key]) }}>{Math.round(r.parts[p.key])}</b></div>
              <div className="muted">{p.how}</div>
            </div>
          ))}
          {r.trades < 20 && <p className="muted" style={{ marginTop: 8 }}>Based on {r.trades} trade{r.trades === 1 ? '' : 's'} — it settles down after 20 or more.</p>}
        </div>
      )}
    </Popover>
  );
}

/** KPI-card size: the score, a small radar and the bar — fits next to Total P&L, Win Rate … */
function RoninCard({ r }) {
  const [ref, { w: mw, h: mh }] = useSize();
  const size = Math.max(56, Math.min(130, mh || 90, (mw || 200) * 0.45));
  const c = size / 2, R = c - 4;
  const ang = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / RONIN_PARTS.length;
  const poly = (k) => RONIN_PARTS.map((p, i) => `${c + Math.cos(ang(i)) * R * (typeof k === 'function' ? k(p) : k)},${c + Math.sin(ang(i)) * R * (typeof k === 'function' ? k(p) : k)}`).join(' ');
  const weakest = [...RONIN_PARTS].sort((a, b) => r.parts[a.key] - r.parts[b.key])[0];
  return (
    <div className={`kpi wkpi ronin-kpi ${r.score >= 50 ? 'posc' : 'negc'}`}>
      <div className="kpi-head"><span>Ronin Score</span><HowItWorks r={r} /></div>
      <div ref={ref} className="ronin-kpi-mid">
        <div className="col" style={{ minWidth: 0 }}>
          <div className="kpi-val" style={{ margin: 0, color: scoreColor(r.score) }}>{r.trades ? r.score.toFixed(1) : '—'}</div>
          <div className="ronin-track ronin-track-sm"><i style={{ left: `${Math.max(0, Math.min(100, r.score))}%` }} /></div>
        </div>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="ronin-mini" role="img" aria-label={RONIN_PARTS.map((p) => `${p.label} ${Math.round(r.parts[p.key])}`).join(', ')}>
          {[0.5, 1].map((k) => <polygon key={k} points={poly(k)} className="ronin-ring" />)}
          <polygon points={poly((p) => r.parts[p.key] / 100)} className="ronin-area" />
          {RONIN_PARTS.map((p, i) => <circle key={p.key} cx={c + Math.cos(ang(i)) * R * (r.parts[p.key] / 100)} cy={c + Math.sin(ang(i)) * R * (r.parts[p.key] / 100)} r="2.5" className="ronin-dot"><title>{`${p.label}: ${Math.round(r.parts[p.key])}/100`}</title></circle>)}
        </svg>
      </div>
      <div className="kpi-foot">{r.trades ? <>Weakest: <span style={{ color: scoreColor(r.parts[weakest.key]) }}>{weakest.label}</span> · {Math.round(r.parts[weakest.key])}/100</> : 'Out of 100'}</div>
    </div>
  );
}

function RoninFull({ r }) {
  const [ref, { w, h }] = useSize();
  const [hover, setHover] = useState(null);
  const SW = Math.max(160, w || 300), SH = Math.max(140, h || 260);
  const cx = SW / 2, cy = SH / 2, R = Math.max(30, Math.min(SW / 2 - 104, SH / 2 - 24));
  const pts = RONIN_PARTS.map((p, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / RONIN_PARTS.length;
    const k = r.parts[p.key] / 100;
    return { ...p, a, x: cx + Math.cos(a) * R * k, y: cy + Math.sin(a) * R * k, lx: cx + Math.cos(a) * (R + 16), ly: cy + Math.sin(a) * (R + 16) };
  });
  const ring = (k) => RONIN_PARTS.map((_, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / RONIN_PARTS.length; return `${cx + Math.cos(a) * R * k},${cy + Math.sin(a) * R * k}`; }).join(' ');
  const hp = hover && pts.find((p) => p.key === hover);
  return (
    <div className="panel wpanel ronin">
      <div className="panel-head">
        <div className="card-title truncate">Ronin Score</div>
        <HowItWorks r={r} />
      </div>
      <div className="wbody ronin-body">
        <div ref={ref} className="ronin-radar">
          {w > 0 && (
            <svg width={SW} height={SH} viewBox={`0 0 ${SW} ${SH}`} role="img" aria-label={`Ronin Score radar: ${pts.map((p) => `${p.label} ${Math.round(r.parts[p.key])}`).join(', ')}`}>
              {[0.2, 0.4, 0.6, 0.8, 1].map((k) => <polygon key={k} points={ring(k)} className="ronin-ring" />)}
              {pts.map((p) => <line key={p.key} x1={cx} y1={cy} x2={cx + Math.cos(p.a) * R} y2={cy + Math.sin(p.a) * R} className="ronin-spoke" />)}
              <polygon points={pts.map((p) => `${p.x},${p.y}`).join(' ')} className="ronin-area" />
              {pts.map((p) => (
                <g key={p.key} onMouseEnter={() => setHover(p.key)} onMouseLeave={() => setHover(null)} style={{ cursor: 'default' }}>
                  <circle cx={p.x} cy={p.y} r={hover === p.key ? 5.5 : 4} className="ronin-dot" />
                  <circle cx={p.x} cy={p.y} r={12} fill="transparent" />
                  <text x={p.lx} y={p.ly} className={`ronin-label ${hover === p.key ? 'on' : ''}`} textAnchor={Math.abs(Math.cos(p.a)) < 0.2 ? 'middle' : Math.cos(p.a) > 0 ? 'start' : 'end'} dominantBaseline={Math.sin(p.a) < -0.5 ? 'auto' : Math.sin(p.a) > 0.5 ? 'hanging' : 'middle'}>{p.label}</text>
                </g>
              ))}
            </svg>
          )}
          {hp && <div className="ronin-tip"><b>{hp.label}</b> {fmtValue(hp.key, r.values[hp.key], r)} <span style={{ color: scoreColor(r.parts[hp.key]) }}>· {Math.round(r.parts[hp.key])}/100</span></div>}
        </div>
        <div className="ronin-foot">
          <div className="ronin-total">
            <span className="muted">Your Ronin Score</span>
            <b style={{ color: scoreColor(r.score) }}>{r.trades ? r.score.toFixed(1) : '—'}</b>
          </div>
          <div className="ronin-bar">
            <div className="ronin-track"><i style={{ left: `${Math.max(0, Math.min(100, r.score))}%` }} /></div>
            <div className="ronin-ticks">{[0, 20, 40, 60, 80, 100].map((x) => <span key={x}>{x}</span>)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
