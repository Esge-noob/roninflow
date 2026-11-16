// Ronin Score widget: a radar of the six parts and the overall score on a 0–100 bar — the same design at every
// size; at KPI-card size the radar fills the space and its labels show on hover.
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight } from 'lucide-react';
import { Popover, useSize, Modal, ModalHead } from './ui';
import { roninScore, roninInsights, RONIN_PARTS } from '../lib/roninScore';
import { pfText } from '../lib/stats';

const SHORT = { win: 'Win %', pf: 'Profit factor', wl: 'Win/loss', recovery: 'Recovery', dd: 'Drawdown', consistency: 'Consistency' };
const fmtValue = (key, v, r) => {
  if (key === 'win') return `${Math.round(v)}%`;
  if (key === 'pf') return pfText(v);
  if (key === 'wl' || key === 'recovery') return v === Infinity ? '∞' : v.toFixed(2);
  if (key === 'dd') return `${v.toFixed(1)}% of balance`;
  if (key === 'consistency') return r.netUp ? `best day = ${Math.round(v * 100)}% of profit` : `${Math.round(v * 100)}% green days`;
  return String(v);
};
export const scoreColor = (s) => (s >= 70 ? 'var(--pos)' : s >= 45 ? 'var(--warn)' : 'var(--neg)');

export default function RoninScore({ trades, initial }) {
  const r = useMemo(() => { const x = roninScore(trades, initial); x.netUp = trades.reduce((a, t) => a + t.pnl, 0) > 0; return x; }, [trades, initial]);
  const [ref, { w, h }] = useSize();
  const [hover, setHover] = useState(null);
  const [detail, setDetail] = useState(false);
  const small = h > 0 && h < 330; // KPI-card height
  const weakest = r.trades ? [...RONIN_PARTS].sort((a, b) => r.parts[a.key] - r.parts[b.key])[0] : null;
  const hp = hover && RONIN_PARTS.find((p) => p.key === hover);
  return (
    <div className={`panel wpanel ronin ${small ? `small ${r.score >= 50 ? 'posc' : 'negc'}` : ''}`}>
      <div className="panel-head">
        <div className="card-title"><HowItWorks r={r} /></div>
      </div>
      <div ref={ref} className="wbody ronin-body">
        {h > 0 && (
          <>
            <div className="ronin-radar">
              <Radar r={r} hover={hover} setHover={setHover} small={small || w < 360} bare={small} />
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
                {weakest && (
                  <button className="ronin-weak" onClick={() => setDetail(true)} title="What your Ronin Score says about your trading">
                    Weakest: <b style={{ color: scoreColor(r.parts[weakest.key]) }}>{weakest.label}</b> <span className="muted ronin-weak-n">· {Math.round(r.parts[weakest.key])}/100</span> <ChevronRight size={13} />
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      {detail && createPortal(<RoninDetail r={r} onClose={() => setDetail(false)} />, document.body)}
    </div>
  );
}

/** What the score says about these trades: a summary, then each part (weakest first) with the number behind it,
 *  what it means and what to work on. */
function RoninDetail({ r, onClose }) {
  const ins = useMemo(() => roninInsights(r), [r]);
  return (
    <Modal open onClose={onClose} width={640} className="ronin-detail">
      <ModalHead title="What your Ronin Score says" sub={`From ${r.trades} trade${r.trades === 1 ? '' : 's'} over ${r.days} trading day${r.days === 1 ? '' : 's'} in this dashboard’s view`} onClose={onClose} />
      <div className="modal-body col gap16">
        <div className="ronin-d-head">
          <b style={{ color: scoreColor(r.score) }}>{r.score.toFixed(1)}</b>
          <div className="col gap6 grow" style={{ minWidth: 0 }}>
            <div className="ronin-track"><i style={{ left: `${Math.max(0, Math.min(100, r.score))}%` }} /></div>
            <p>{ins.summary}</p>
          </div>
        </div>
        {ins.parts.map((p, i) => (
          <div key={p.key} className={`ronin-d-part ${i === 0 ? 'weakest' : ''}`}>
            <div className="row between gap8">
              <b>{p.label} {i === 0 && <span className="badge neg-soft">Weakest</span>}{i === ins.parts.length - 1 && <span className="badge pos-soft">Strongest</span>}</b>
              <span className="ronin-d-score" style={{ color: scoreColor(p.score) }}>{Math.round(p.score)}<span className="muted">/100</span></span>
            </div>
            <div className="ronin-d-meter"><i style={{ width: `${p.score}%`, background: scoreColor(p.score) }} /></div>
            <div className="ronin-d-value">Your number: <b>{p.value}</b> <span className="muted">· {p.weight}% of the score</span></div>
            <p>{p.meaning}</p>
            {p.score < 70 && <p className="ronin-d-tip"><b>What to work on:</b> {p.tip}</p>}
          </div>
        ))}
        <p className="muted" style={{ fontSize: 12 }}>The score follows the account, date range and filters you have on the dashboard. {r.trades < 20 ? 'With under 20 trades it can swing a lot.' : ''}</p>
      </div>
    </Modal>
  );
}

/** The six-sided radar, sized to its box; labels shorten when it's small, and `bare` leaves them to the hover tip. */
function Radar({ r, hover, setHover, small, bare }) {
  const [ref, { w, h }] = useSize();
  const fs = small ? 10.5 : 12;
  const ang = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / RONIN_PARTS.length;
  // room the labels on each side need (measured), then the biggest radar that leaves it
  const text = (p) => (small ? SHORT[p.key] : p.label);
  const widthOf = useMemo(() => {
    const c = document.createElement('canvas').getContext('2d');
    c.font = `${fs}px ${getComputedStyle(document.body).fontFamily}`;
    return (t) => c.measureText(t).width;
  }, [fs]);
  const sideW = (sign) => Math.max(0, ...RONIN_PARTS.map((p, i) => (Math.cos(ang(i)) * sign > 0.2 ? widthOf(text(p)) : 0))) + 14;
  const lw = bare ? 6 : sideW(-1), rw = bare ? 6 : sideW(1);
  const R = Math.max(16, Math.min((w - lw - rw) / 2, h / 2 - (bare ? 6 : fs + 10)));
  const cx = lw + (w - lw - rw) / 2, cy = h / 2;
  const pts = RONIN_PARTS.map((p, i) => {
    const a = ang(i), k = r.parts[p.key] / 100;
    return { ...p, a, x: cx + Math.cos(a) * R * k, y: cy + Math.sin(a) * R * k, lx: cx + Math.cos(a) * (R + 10), ly: cy + Math.sin(a) * (R + 10) };
  });
  const ring = (k) => RONIN_PARTS.map((_, i) => `${cx + Math.cos(ang(i)) * R * k},${cy + Math.sin(ang(i)) * R * k}`).join(' ');
  return (
    <div ref={ref} className="ronin-svgbox">
      {w > 0 && h > 0 && (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Ronin Score radar: ${pts.map((p) => `${p.label} ${Math.round(r.parts[p.key])}`).join(', ')}`}>
          {[0.2, 0.4, 0.6, 0.8, 1].map((k) => <polygon key={k} points={ring(k)} className="ronin-ring" />)}
          {pts.map((p) => <line key={p.key} x1={cx} y1={cy} x2={cx + Math.cos(p.a) * R} y2={cy + Math.sin(p.a) * R} className={`ronin-spoke ${hover === p.key ? 'on' : ''}`} />)}
          <polygon points={pts.map((p) => `${p.x},${p.y}`).join(' ')} className="ronin-area" />
          {pts.map((p) => (
            <g key={p.key} onMouseEnter={() => setHover(p.key)} onMouseLeave={() => setHover(null)}>
              <circle cx={p.x} cy={p.y} r={hover === p.key ? (small ? 4.5 : 5.5) : small ? 3 : 4} className="ronin-dot" />
              <circle cx={p.x} cy={p.y} r={12} fill="transparent" />
              {bare && <line x1={cx} y1={cy} x2={cx + Math.cos(p.a) * R} y2={cy + Math.sin(p.a) * R} stroke="transparent" strokeWidth={Math.max(16, R * 0.5)} />}
              {!bare && <text x={p.lx} y={p.ly} style={{ fontSize: fs }} className={`ronin-label ${hover === p.key ? 'on' : ''}`} textAnchor={Math.abs(Math.cos(p.a)) < 0.2 ? 'middle' : Math.cos(p.a) > 0 ? 'start' : 'end'} dominantBaseline={Math.sin(p.a) < -0.5 ? 'auto' : Math.sin(p.a) > 0.5 ? 'hanging' : 'middle'}>
                {text(p)}
              </text>}
              {!bare && <title>{`${p.label}: ${Math.round(r.parts[p.key])}/100`}</title>}
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}

function HowItWorks({ r }) {
  return (
    <Popover portal align="left" width={340} trigger={({ toggle, open }) => (
      <span role="button" tabIndex={0} className={`stat-q ${open ? 'on' : ''}`} title="How it's worked out" onClick={toggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>Ronin Score</span>
    )}>
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
