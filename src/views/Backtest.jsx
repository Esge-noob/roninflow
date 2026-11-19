// Backtesting: replay any day bar by bar and trade it (sessions with their own trades and stats, kept apart from
// your journal), and what-if tests that re-run your real trades under rules you'd like to follow.
import { lazy, Suspense, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { FlaskConical, Plus, ArrowLeft, Play, Pencil, Trash, CalendarDays, RotateCcw, ChevronDown, ChevronUp, Info } from 'lucide-react';
import { useStore, navigate, useAccountTrades } from '../store/store';
import { Seg, Modal, ModalHead, Money, Confirm, AccountPicker, useToast } from '../components/ui';
import { PnlChart } from '../components/Charts';
import { GroupStats } from './Review';
import { summarize, equityCurve, fmtDate, fmtTime12, pfText, maxDrawdown, keyOf, fmtMoney, uid } from '../lib/stats';
import { roninScore } from '../lib/roninScore';
import { tradeBlockers } from '../lib/playbook';
import { AutoList, AutoEditor } from './AutoBacktest';
import { pointValueOf, rootOf, nextWeekday, nyOpenLocal, sessionDays, runWhatIf, activeRules, RULE_LABEL, WHATIF_DEFAULT } from '../lib/backtest';

const ChartStudio = lazy(() => import('../components/ChartStudio'));
const COMMON = ['MES', 'ES', 'MNQ', 'NQ', 'MYM', 'YM', 'M2K', 'RTY', 'MCL', 'CL', 'MGC', 'GC'];
const curveData = (trades) => [{ label: '', y: 0 }, ...equityCurve(trades).map((c) => ({ label: '', y: c.y }))];
const today = () => keyOf(new Date());

export default function Backtest({ sub, id }) {
  if (sub === 'auto' && id) return <AutoEditor id={id} />;
  if (sub && sub !== 'whatif' && sub !== 'auto') return <SessionDetail id={sub} />;
  const tab = sub === 'whatif' ? 'whatif' : sub === 'auto' ? 'auto' : 'sessions';
  return (
    <div className="page">
      <div className="row page-head-row" style={{ marginBottom: 18 }}>
        <div className="page-title" style={{ margin: 0 }}>Backtesting</div>
        <div className="grow" />
        <Seg value={tab} onChange={(t) => navigate(t === 'sessions' ? 'backtest' : `backtest/${t}`)} options={[{ value: 'sessions', label: 'Replay' }, { value: 'whatif', label: 'What-if' }, { value: 'auto', label: 'Automated' }]} />
      </div>
      {tab === 'whatif' ? <WhatIf /> : tab === 'auto' ? <AutoList /> : <Sessions />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- sessions

function Sessions() {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  const list = state.backtests || [];
  return (
    <div className="col gap16">
      <div className="toolbar">
        <div className="muted" style={{ fontSize: 13 }}>Replay any day bar by bar and trade it. Backtest trades stay here — they never count in your journal.</div>
        <div className="grow" />
        <button className="btn white" onClick={() => setOpen(true)}>New session <Plus size={16} /></button>
      </div>
      {list.length === 0 ? (
        <div className="empty panel" style={{ minHeight: '46vh' }}>
          <FlaskConical size={34} className="muted2" />
          <div style={{ color: 'var(--fg)', fontSize: 17, fontWeight: 500 }}>No backtest sessions yet</div>
          <div className="muted" style={{ maxWidth: 460, textAlign: 'center', fontSize: 13.5 }}>Pick a market and a day to start from. The chart replays it bar by bar; buy, sell, set a stop and target, then step forward and see how it plays out. Each session keeps its own trades and stats.</div>
          <button className="btn" onClick={() => setOpen(true)}>Start your first session</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 18 }}>
          {[...list].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt))).map((s) => <SessionCard key={s.id} s={s} />)}
        </div>
      )}
      {open && <SessionForm onClose={() => setOpen(false)} />}
    </div>
  );
}

function SessionCard({ s }) {
  const { state } = useStore();
  const st = summarize(s.trades || []);
  const strat = state.strategies.find((x) => x.id === s.strategyId);
  return (
    <div className="strat-card" onClick={() => navigate(`backtest/${s.id}`)}>
      <div className="row between gap8"><b style={{ fontWeight: 600, fontSize: 16 }}>{s.name}</b><span className="badge neutral">{s.symbol}</span></div>
      <div className="muted" style={{ fontSize: 12.5 }}>{strat ? `${strat.name} · ` : ''}{sessionDays(s).length} day{sessionDays(s).length === 1 ? '' : 's'} · up to {fmtDate(s.date)}</div>
      {st.count ? <div className="strat-curve"><PnlChart data={curveData(s.trades)} height={70} compact /></div> : <div className="strat-curve empty">No trades yet</div>}
      <div className="row gap24" style={{ fontSize: 13 }}>
        <div><div className="muted">Net P&L</div>{st.count ? <Money v={st.net} colored /> : '—'}</div>
        <div><div className="muted">Win rate</div>{st.count ? `${Math.round(st.winRate)}%` : '—'}</div>
        <div><div className="muted">Trades</div>{st.count}</div>
        <div><div className="muted">PF</div>{st.count ? pfText(st.profitFactor) : '—'}</div>
      </div>
    </div>
  );
}

/** New session, or edit one (`session`). */
function SessionForm({ session, onClose }) {
  const { state, setBacktests } = useStore();
  const symbols = useMemo(() => [...new Set([...state.trades.map((t) => rootOf(t.symbol)), ...COMMON])], [state.trades]);
  const feeFor = (sym) => { // your average commission per contract on that market, from your real trades
    const mine = state.trades.filter((t) => rootOf(t.symbol) === rootOf(sym) && Number(t.qty) > 0 && Number(t.fees) > 0);
    const q = mine.reduce((s, t) => s + Number(t.qty), 0);
    return q ? Math.round((mine.reduce((s, t) => s + Number(t.fees), 0) / q) * 100) / 100 : 0;
  };
  const first = session?.symbol || symbols[0] || 'MES';
  const start = session?.date || nextWeekday(today(), -1);
  const [f, setF] = useState(() => session ? { ...session } : {
    name: '', symbol: first, date: start, startTime: nyOpenLocal(start), pv: pointValueOf(first), fee: feeFor(first), strategyId: '', balance: 50000,
  });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const setSym = (v) => setF((x) => ({ ...x, symbol: v.toUpperCase(), pv: pointValueOf(v), fee: feeFor(v) }));
  const save = () => {
    const clean = { ...f, symbol: rootOf(f.symbol) || 'MES', name: f.name.trim() || `${rootOf(f.symbol)} backtest`, pv: Number(f.pv) || 1, fee: Number(f.fee) || 0, balance: Number(f.balance) || 50000, updatedAt: new Date().toISOString() };
    if (session) setBacktests((l) => l.map((x) => (x.id === session.id ? { ...x, ...clean } : x)));
    else {
      const id = uid('bt');
      setBacktests((l) => [...l, { ...clean, id, trades: [], days: [], createdAt: new Date().toISOString() }]);
      navigate(`backtest/${id}?play=1`);
    }
    onClose();
  };
  return createPortal(
    <Modal open onClose={onClose} width={620}>
      <ModalHead title={session ? 'Edit session' : 'New backtest session'} sub="Trades you take in it are simulated and stay in this session" onClose={onClose} />
      <div className="modal-body form-grid">
        <div className="field full"><label className="label">Name</label><input className="input" placeholder={`${rootOf(f.symbol) || 'MES'} backtest`} value={f.name} onChange={set('name')} autoFocus /></div>
        <div className="field">
          <label className="label">Market</label>
          <input className="input" list="bt-symbols" value={f.symbol} onChange={(e) => setSym(e.target.value)} disabled={!!session?.trades?.length} title={session?.trades?.length ? 'A session with trades keeps its market' : ''} />
          <datalist id="bt-symbols">{symbols.map((x) => <option key={x} value={x} />)}</datalist>
        </div>
        <div className="field"><label className="label">{session ? 'Current day' : 'Start on'}</label><input className="input" type="date" max={today()} value={f.date} onChange={(e) => setF((x) => ({ ...x, date: e.target.value, startTime: x.startTime || nyOpenLocal(e.target.value) }))} /></div>
        <div className="field"><label className="label">Each day starts at</label><input className="input" type="time" value={f.startTime} onChange={set('startTime')} /><span className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>Your time. The chart shows the bars before it, then you step forward.</span></div>
        <div className="field"><label className="label">Strategy you’re testing</label>
          <select className="select" value={f.strategyId || ''} onChange={set('strategyId')}>
            <option value="">None</option>
            {state.strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="field"><label className="label">$ per point, per contract</label><input className="input" type="number" min="0" step="any" value={f.pv} onChange={set('pv')} /></div>
        <div className="field"><label className="label">Commission per contract (round trip)</label><input className="input" type="number" min="0" step="0.01" value={f.fee} onChange={set('fee')} /></div>
        <div className="field"><label className="label">Starting balance</label><input className="input" type="number" min="0" step="100" value={f.balance} onChange={set('balance')} /><span className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>For drawdown and the Ronin Score.</span></div>
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn white" onClick={save}>{session ? 'Save' : <>Start <Play size={14} /></>}</button>
      </div>
    </Modal>,
    document.body,
  );
}

function SessionDetail({ id }) {
  const { state, setBacktests } = useStore();
  const toast = useToast();
  const s = (state.backtests || []).find((x) => x.id === id);
  const [playing, setPlaying] = useState(() => (window.location.hash.split('?')[1] || '').includes('play=1'));
  const [edit, setEdit] = useState(false);
  const [del, setDel] = useState(false);
  const [pick, setPick] = useState(false);
  if (!s) return <div className="page empty">Backtest session not found. <a href="#/backtest" className="accent">Back to backtesting</a></div>;
  const trades = s.trades || [];
  const patch = (p) => setBacktests((l) => l.map((x) => (x.id === id ? { ...x, ...p, updatedAt: new Date().toISOString() } : x)));
  const strat = state.strategies.find((x) => x.id === s.strategyId);
  const live = strat ? state.trades.filter((t) => t.strategyId === strat.id) : [];
  const play = (date) => { if (date && date !== s.date) patch({ date }); setPlaying(true); try { window.history.replaceState(null, '', `#/backtest/${id}`); } catch { /* */ } };
  const dayTrades = trades.filter((t) => String(t.entry).slice(0, 10) === s.date);
  const r = trades.length ? roninScore(trades, Number(s.balance) || 50000) : null;
  return (
    <div className="page">
      <div className="row gap12 wrap" style={{ marginBottom: 18 }}>
        <button className="btn sm" onClick={() => navigate('backtest')}><ArrowLeft size={15} /> Sessions</button>
        <div className="grow" />
        <button className="btn sm" onClick={() => setEdit(true)}><Pencil size={14} /> Edit</button>
        <button className="btn sm danger" onClick={() => setDel(true)}><Trash size={14} /> Delete</button>
      </div>
      <div className="row gap12 wrap" style={{ marginBottom: 6 }}>
        <div className="page-title" style={{ margin: 0 }}>{s.name}</div>
        <span className="badge neutral">{s.symbol}</span>
        {strat && <span className="badge neutral">{strat.name}</span>}
      </div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 18 }}>{sessionDays(s).length} day{sessionDays(s).length === 1 ? '' : 's'} replayed · ${s.pv}/point · {fmtMoney(s.fee || 0)} per contract{r ? ` · Ronin Score ${r.score.toFixed(1)}` : ''}</div>
      <div className="panel bt-continue">
        <div className="col gap4 grow">
          <b>Next up: {fmtDate(s.date)}</b>
          <span className="muted" style={{ fontSize: 13 }}>{dayTrades.length ? `${dayTrades.length} trade${dayTrades.length === 1 ? '' : 's'} already taken that day.` : `Starts at ${s.startTime || nyOpenLocal(s.date)} your time.`} Keys while replaying: → next bar · Space play · B buy · S sell · X close.</span>
        </div>
        <div className="row gap8 wrap">
          {pick ? (
            <input className="input" type="date" max={today()} defaultValue={s.date} autoFocus onChange={(e) => { if (e.target.value) { setPick(false); play(e.target.value); } }} onBlur={() => setPick(false)} />
          ) : <button className="btn" onClick={() => setPick(true)}><CalendarDays size={14} /> Pick a day</button>}
          <button className="btn white" onClick={() => play()}><Play size={14} /> {trades.length || (s.days || []).length ? 'Continue' : 'Start'}</button>
        </div>
      </div>
      <div className="col gap16" style={{ margin: '22px 0' }}>
        <GroupStats trades={trades} empty="No trades yet — press Start, step through the day and use Buy / Sell under the chart." />
      </div>
      {strat && trades.length > 0 && <Compare bt={trades} live={live} name={strat.name} />}
      {trades.length > 0 && (
        <div className="panel" style={{ marginTop: 22 }}>
          <div className="panel-head"><div className="card-title">Trades</div><span className="muted" style={{ fontSize: 12.5 }}>Click a day to replay it again</span></div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr>{['Day', 'Time', 'Side', 'Qty', 'Entry', 'Exit', 'P&L', ''].map((h) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {[...trades].sort((a, b) => String(b.entry).localeCompare(String(a.entry))).map((t) => (
                  <tr key={t.id} onClick={() => play(String(t.entry).slice(0, 10))}>
                    <td>{fmtDate(t.entry)}</td><td className="muted">{fmtTime12(t.entry)} → {fmtTime12(t.exit)}</td>
                    <td className={t.direction === 'Long' ? 'pos' : 'neg'}>{t.direction}</td><td>{t.qty}</td><td>{t.entryPrice}</td><td>{t.exitPrice}</td>
                    <td><Money v={t.pnl} colored /></td>
                    <td><button className="icon-btn" title="Delete this trade" onClick={(e) => { e.stopPropagation(); patch({ trades: trades.filter((x) => x.id !== t.id) }); toast('Trade deleted'); }}><Trash size={14} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {playing && (
        <Suspense fallback={null}>
          <ChartStudio
            date={s.date}
            trades={dayTrades}
            backtest={{
              symbol: s.symbol, pv: Number(s.pv) || 1, fee: Number(s.fee) || 0, startTime: s.startTime || nyOpenLocal(s.date), strategyId: s.strategyId || null, label: s.name,
              onTrade: (t) => setBacktests((l) => l.map((x) => (x.id === id ? { ...x, trades: [...(x.trades || []), { ...t, backtestId: id }], days: [...new Set([...(x.days || []), String(t.entry).slice(0, 10)])], updatedAt: new Date().toISOString() } : x))),
              onDay: (d) => setBacktests((l) => l.map((x) => (x.id === id ? { ...x, date: d > today() ? x.date : d, days: [...new Set([...(x.days || []), x.date])], updatedAt: new Date().toISOString() } : x))),
            }}
            onClose={() => setPlaying(false)}
          />
        </Suspense>
      )}
      {edit && <SessionForm session={s} onClose={() => setEdit(false)} />}
      <Confirm open={del} title="Delete this session?" body={`${s.name} and its ${trades.length} trade${trades.length === 1 ? '' : 's'} will be removed. Your journal isn’t affected.`} onCancel={() => setDel(false)} onConfirm={() => { setBacktests((l) => l.filter((x) => x.id !== id)); navigate('backtest'); }} />
    </div>
  );
}

/** Backtest vs how the same strategy is going in your journal. */
function Compare({ bt, live, name }) {
  const a = summarize(bt), b = summarize(live);
  const row = (label, f, money) => (
    <tr key={label}><td className="muted">{label}</td><td>{money ? <Money v={f(a)} colored /> : f(a)}</td><td>{live.length ? (money ? <Money v={f(b)} colored /> : f(b)) : '—'}</td></tr>
  );
  return (
    <div className="panel">
      <div className="panel-head"><div className="card-title">Backtest vs live · {name}</div><span className="muted" style={{ fontSize: 12.5 }}>Live = your journal’s trades tagged with this strategy</span></div>
      <div className="tbl-wrap">
        <table className="tbl bt-compare">
          <thead><tr><th /><th>Backtest</th><th>Live</th></tr></thead>
          <tbody>
            {row('Trades', (s) => s.count)}
            {row('Win rate', (s) => (s.decided ? `${Math.round(s.winRate)}%` : '—'))}
            {row('Profit factor', (s) => (s.decided ? pfText(s.profitFactor) : '—'))}
            {row('Average win', (s) => s.avgWin || 0, true)}
            {row('Average loss', (s) => -Math.abs(s.avgLoss || 0), true)}
            {row('EV per trade', (s) => s.avgTrade, true)}
            {row('Net P&L', (s) => s.net, true)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- what-if

const PERIODS = [{ value: 30, label: '30 days' }, { value: 90, label: '90 days' }, { value: 365, label: '1 year' }, { value: 100000, label: 'All time' }];
const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];

function WhatIf() {
  const { state, setSetting } = useStore();
  const all = useAccountTrades();
  const rules = { ...WHATIF_DEFAULT, ...(state.settings.whatIf || {}) };
  const setRules = (p) => setSetting('whatIf', { ...rules, ...p });
  const [period, setPeriod] = useState(90);
  const [showRemoved, setShowRemoved] = useState(false);
  const trades = useMemo(() => { const from = period >= 100000 ? '' : keyOf(new Date(Date.now() - period * 86400e3)); return all.filter((t) => String(t.entry).slice(0, 10) >= from); }, [all, period]);
  const res = useMemo(() => runWhatIf(trades, rules, { blockersOf: tradeBlockers }), [trades, JSON.stringify(rules)]); // eslint-disable-line react-hooks/exhaustive-deps
  const on = activeRules(rules);
  const acct = state.accounts.find((a) => a.id === state.settings.account);
  const initial = Number(acct?.initial) || state.accounts.filter((a) => all.some((t) => t.accountId === a.id)).reduce((sum, x) => sum + (Number(x.initial) || 0), 0) || 50000;
  const A = summarize(trades), B = summarize(res.kept);
  const ddA = maxDrawdown(trades), ddB = maxDrawdown(res.kept);
  const rA = roninScore(trades, initial), rB = roninScore(res.kept, initial);
  const symbols = useMemo(() => [...new Set(trades.map((t) => rootOf(t.symbol)))].sort(), [trades]);
  const tags = useMemo(() => [...new Set(trades.flatMap((t) => t.tags || []))].sort(), [trades]);
  const strategies = useMemo(() => [...state.strategies.filter((s) => trades.some((t) => t.strategyId === s.id)).map((s) => [s.id, s.name]), ...(trades.some((t) => !t.strategyId || !state.strategies.some((s) => s.id === t.strategyId)) ? [['__none', 'No strategy']] : [])], [trades, state.strategies]);
  const toggle = (k, v) => setRules({ [k]: (rules[k] || []).includes(v) ? rules[k].filter((x) => x !== v) : [...(rules[k] || []), v] });
  const numIn = (k, ph, prefix) => (
    <span className="wi-num">{prefix && <i>{prefix}</i>}<input className="input" type="number" min="0" placeholder={ph} value={rules[k]} onChange={(e) => setRules({ [k]: e.target.value })} /></span>
  );
  const metric = (label, a, b, fmt, better = 'up') => {
    const d = b - a;
    const good = better === 'up' ? d > 0 : better === 'down' ? d < 0 : null;
    return (
      <div className="wi-metric" key={label}>
        <div className="muted">{label}</div>
        <div className="wi-vals"><span className="muted wi-was">{fmt(a)}</span><span>→</span><b>{fmt(b)}</b></div>
        {Math.abs(d) > 1e-9 && <div className={`wi-delta ${good === null ? 'muted' : good ? 'pos' : 'neg'}`}>{fmt(d, true)}</div>}
      </div>
    );
  };
  const m$ = (v, delta) => (state.settings.privacy ? '•••' : fmtMoney(v, { sign: delta }));
  return (
    <div className="col gap16">
      <div className="toolbar">
        <AccountPicker compact />
        <Seg value={period} onChange={setPeriod} options={PERIODS} />
        <div className="grow" />
        {on.length > 0 && <button className="btn" onClick={() => setSetting('whatIf', WHATIF_DEFAULT)}><RotateCcw size={14} /> Clear rules</button>}
      </div>
      <div className="wi-grid">
        <div className="panel wi-rules">
          <div className="card-title" style={{ marginBottom: 4 }}>Rules</div>
          <p className="muted" style={{ fontSize: 12.5, margin: '0 0 14px' }}>Your real trades, re-run as if you’d followed these. Nothing in your journal changes.</p>
          <div className="wi-sec">When you trade</div>
          <div className="row gap6 wrap">{DAYS.map(([d, l]) => <button key={d} className={`chip ${rules.days.includes(d) ? 'on' : ''}`} onClick={() => toggle('days', d)}>{l}</button>)}</div>
          <div className="wi-line row gap8"><span className="grow">Only trades taken between</span>{(rules.from || rules.to) && <button className="btn xs ghost" onClick={() => setRules({ from: '', to: '' })}>Any time</button>}</div>
          <div className="row gap8 wi-line wi-times"><input className="input wi-time" type="time" value={rules.from} onChange={(e) => setRules({ from: e.target.value })} aria-label="From" /><span className="muted">–</span><input className="input wi-time" type="time" value={rules.to} onChange={(e) => setRules({ to: e.target.value })} aria-label="Until" /></div>
          <div className="wi-line"><Seg value={rules.side} onChange={(v) => setRules({ side: v })} options={[{ value: 'both', label: 'Both sides' }, { value: 'long', label: 'Longs' }, { value: 'short', label: 'Shorts' }]} /></div>
          <div className="wi-sec">Each day</div>
          <div className="wi-line row gap8"><span className="grow">Max trades a day</span>{numIn('maxTrades', '—')}</div>
          <div className="wi-line row gap8"><span className="grow">Stop after this many losing trades</span>{numIn('maxLosses', '—')}</div>
          <div className="wi-line row gap8"><span className="grow">Daily loss limit</span>{numIn('dayLoss', '—', '$')}</div>
          <div className="wi-line row gap8"><span className="grow">Daily profit target (stop when reached)</span>{numIn('dayTarget', '—', '$')}</div>
          <div className="wi-sec">Each trade</div>
          <div className="wi-line row gap8"><span className="grow" title="Every loss bigger than this is cut to this amount — as if a hard stop had filled exactly there">Max loss per trade <Info size={12} className="muted" /></span>{numIn('tradeLoss', '—', '$')}</div>
          <div className="wi-sec">Skip</div>
          {strategies.length > 0 && <div className="row gap6 wrap wi-line">{strategies.map(([sid, n]) => <button key={sid} className={`chip ${rules.skipStrategies.includes(sid) ? 'on neg-chip' : ''}`} onClick={() => toggle('skipStrategies', sid)}>{n}</button>)}</div>}
          {symbols.length > 1 && <div className="row gap6 wrap wi-line">{symbols.map((x) => <button key={x} className={`chip ${rules.skipSymbols.includes(x) ? 'on neg-chip' : ''}`} onClick={() => toggle('skipSymbols', x)}>{x}</button>)}</div>}
          {tags.length > 0 && <div className="row gap6 wrap wi-line">{tags.map((x) => <button key={x} className={`chip ${rules.skipTags.includes(x) ? 'on neg-chip' : ''}`} onClick={() => toggle('skipTags', x)}>#{x}</button>)}</div>}
          <label className="row gap8 wi-line" style={{ cursor: 'pointer' }}><input type="checkbox" className="cbx" checked={!!rules.skipBlockers} onChange={(e) => setRules({ skipBlockers: e.target.checked })} /> Trades flagged with an edge blocker</label>
        </div>

        <div className="col gap16" style={{ minWidth: 0 }}>
          {!trades.length ? <div className="panel empty" style={{ minHeight: 240 }}>No trades in this period for this account.</div> : (
            <>
              <div className="panel">
                <div className="panel-head"><div className="card-title">{on.length ? 'With your rules' : 'Pick a rule to see what changes'}</div><span className="muted" style={{ fontSize: 12.5 }}>{trades.length} real trade{trades.length === 1 ? '' : 's'} · {PERIODS.find((p) => p.value === period).label.toLowerCase()}</span></div>
                <div className="wi-metrics">
                  {metric('Net P&L', A.net, B.net, m$)}
                  {metric('Trades', A.count, B.count, (v, d) => `${d && v > 0 ? '+' : ''}${Math.round(v)}`, 'none')}
                  {metric('Win rate', A.winRate, B.winRate, (v, d) => `${d && v > 0 ? '+' : ''}${v.toFixed(1)}%`)}
                  {metric('Profit factor', Math.min(A.profitFactor, 99), Math.min(B.profitFactor, 99), (v, d) => `${d && v > 0 ? '+' : ''}${v.toFixed(2)}`)}
                  {metric('Avg trade', A.count ? A.net / A.count : 0, B.count ? B.net / B.count : 0, m$)}
                  {metric('Max drawdown', ddA, ddB, m$, 'down')}
                  {metric('Ronin Score', rA.score, rB.score, (v, d) => `${d && v > 0 ? '+' : ''}${v.toFixed(1)}`)}
                </div>
              </div>
              <div className="panel">
                <div className="panel-head"><div className="card-title">Equity curve</div><span className="wi-legend"><i className="was" /> Actual <i /> What-if</span></div>
                <DualCurve a={trades} b={res.kept} privacy={state.settings.privacy} />
              </div>
              {on.length > 0 && (
                <div className="panel">
                  <div className="panel-head"><div className="card-title">What each rule changed</div></div>
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead><tr><th>Rule</th><th>Trades</th><th>What they made</th><th>Effect</th></tr></thead>
                      <tbody>
                        {Object.entries(res.byRule).map(([k, v]) => (
                          <tr key={k}>
                            <td>{RULE_LABEL[k]}</td>
                            <td>{v.count} {k === 'tradeLoss' ? 'capped' : 'skipped'}</td>
                            <td>{k === 'tradeLoss' ? '—' : <Money v={v.pnl} colored />}</td>
                            <td><Money v={k === 'tradeLoss' ? v.saved : -v.pnl} colored sign /></td>
                          </tr>
                        ))}
                        {!Object.keys(res.byRule).length && <tr><td colSpan={4} className="muted">These rules wouldn’t have changed any trade in this period.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  {res.removed.length > 0 && (
                    <>
                      <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={() => setShowRemoved((x) => !x)}>{showRemoved ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {showRemoved ? 'Hide' : 'Show'} the {res.removed.length} skipped trade{res.removed.length === 1 ? '' : 's'}</button>
                      {showRemoved && (
                        <div className="tbl-wrap" style={{ marginTop: 8, maxHeight: 360, overflow: 'auto' }}>
                          <table className="tbl">
                            <thead><tr><th>Day</th><th>Time</th><th>Symbol</th><th>Side</th><th>P&L</th><th>Why</th></tr></thead>
                            <tbody>
                              {[...res.removed].sort((x, y) => String(y.trade.entry).localeCompare(String(x.trade.entry))).slice(0, 300).map(({ trade: t, rule }) => (
                                <tr key={t.id} onClick={() => navigate(`diary/${String(t.entry).slice(0, 10)}`)}>
                                  <td>{fmtDate(t.entry)}</td><td className="muted">{fmtTime12(t.entry)}</td><td>{t.symbol}</td><td>{t.direction}</td><td><Money v={t.pnl} colored /></td><td className="muted">{RULE_LABEL[rule]}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}
                  <p className="muted" style={{ fontSize: 12, margin: '12px 0 0' }}>Daily rules act in time order on each day: the trade that reaches a limit still counts, the ones after it are skipped. It can’t know whether a skipped trade changed how you traded the rest of the day.</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Actual vs what-if equity, both on one time axis (trade by trade, in order). */
function DualCurve({ a, b, privacy }) {
  const W = 800, H = 240, P = { l: 58, r: 12, t: 12, b: 24 };
  const order = [...a].sort((x, y) => String(x.entry).localeCompare(String(y.entry)));
  const keptPnl = new Map(b.map((t) => [t.id, t.pnl]));
  let ca = 0, cb = 0;
  const pts = [{ a: 0, b: 0 }, ...order.map((t) => { ca += t.pnl; if (keptPnl.has(t.id)) cb += keptPnl.get(t.id); return { a: ca, b: cb, d: String(t.entry).slice(0, 10) }; })];
  const lo = Math.min(0, ...pts.map((p) => Math.min(p.a, p.b))), hi = Math.max(0, ...pts.map((p) => Math.max(p.a, p.b)));
  const span = hi - lo || 1;
  const x = (i) => P.l + (i / Math.max(1, pts.length - 1)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - lo) / span) * (H - P.t - P.b);
  const path = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
  const ticks = [lo, lo + span / 2, hi];
  return (
    <svg className="wi-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Actual and what-if equity curves">
      {ticks.map((v) => <g key={v}><line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} className="wi-grid-line" /><text x={P.l - 6} y={y(v) + 4} textAnchor="end" className="wi-tick">{privacy ? '•••' : fmtMoney(v, { dp: 0 })}</text></g>)}
      <line x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} className="wi-zero" />
      <path d={path('a')} className="wi-line-was" />
      <path d={path('b')} className="wi-line-now" />
      {pts.length > 2 && <><text x={P.l} y={H - 6} className="wi-tick">{fmtDate(pts[1].d)}</text><text x={W - P.r} y={H - 6} textAnchor="end" className="wi-tick">{fmtDate(pts[pts.length - 1].d)}</text></>}
    </svg>
  );
}
