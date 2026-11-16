// The full-screen chart: a day's candles with your executions, drawing tools (lines, rays, rectangles, Fibonacci,
// measure, long/short positions, brush, text), indicators (EMA, SMA, VWAP, Bollinger, volume, RSI, MACD) and a
// bar-by-bar replay. Built on TradingView Lightweight Charts™; the drawings are our own layer on top of it and are
// saved per instrument, so they show on every day of that market.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  MousePointer2, Slash, MoveUpRight, Minus, ChevronsRight, SeparatorVertical, Square, AlignVerticalSpaceAround, Ruler,
  CircleArrowUp, CircleArrowDown, Brush, Type, Magnet, Eye, EyeOff, Trash2, Undo2, Camera, Maximize, Maximize2, Minimize, X,
  Play, Pause, StepForward, StepBack, SkipBack, SkipForward, History, Layers, Check, ChevronDown, RefreshCw, Crosshair,
} from 'lucide-react';
import { useStore } from '../store/store';
import { IS_VIEWER } from '../lib/shareMode';
import { fmtMoney, fmtTime12, fmtDate } from '../lib/stats';
import { Popover } from './ui';
import { ivSec, TIMEFRAMES, SPAN_DAYS, tfLabel, barTime, aggregate, sessionStart, fromLocal, toLocal } from '../lib/bars';
import { sma, ema, vwap, bollinger, rsi, macd } from '../lib/indicators';
import { loadLib, chartColors, buildExecutions, TICKS, rootOf, decimals, alpha } from './ExecChart';

const TOOLS = [
  [{ id: 'cursor', icon: MousePointer2, label: 'Cursor', key: 'Esc' }],
  [
    { id: 'trend', icon: Slash, label: 'Trend line', key: 'Alt+T' },
    { id: 'ray', icon: MoveUpRight, label: 'Ray' },
    { id: 'hline', icon: Minus, label: 'Horizontal line', key: 'Alt+H' },
    { id: 'hray', icon: ChevronsRight, label: 'Horizontal ray' },
    { id: 'vline', icon: SeparatorVertical, label: 'Vertical line', key: 'Alt+V' },
  ],
  [
    { id: 'rect', icon: Square, label: 'Rectangle', key: 'Alt+R' },
    { id: 'fib', icon: AlignVerticalSpaceAround, label: 'Fib retracement', key: 'Alt+F' },
    { id: 'measure', icon: Ruler, label: 'Measure', key: 'Alt+M' },
  ],
  [
    { id: 'long', icon: CircleArrowUp, label: 'Long position' },
    { id: 'short', icon: CircleArrowDown, label: 'Short position' },
  ],
  [
    { id: 'brush', icon: Brush, label: 'Brush' },
    { id: 'text', icon: Type, label: 'Text' },
  ],
];
const TOOL_BY_ID = Object.fromEntries(TOOLS.flat().map((t) => [t.id, t]));
const ONE_POINT = new Set(['hline', 'hray', 'vline', 'text']);
const KEYS = { t: 'trend', h: 'hline', v: 'vline', r: 'rect', f: 'fib', m: 'measure' };
const SWATCHES = ['#4da3e5', '#2bc48a', '#e5484d', '#e8b043', '#a78bfa', '#f472b6', '#e5e7eb', '#94a3b8'];
const DEFAULT_COLOR = { trend: '#4da3e5', ray: '#4da3e5', hline: '#e8b043', hray: '#e8b043', vline: '#94a3b8', rect: '#a78bfa', fib: '#e8b043', measure: '#4da3e5', long: '#2bc48a', short: '#e5484d', brush: '#f472b6', text: '#e5e7eb' };
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const SPEEDS = [1, 2, 5, 10, 30, 60];

const DEFAULT_IND = {
  ema1: { on: true, n: 9 }, ema2: { on: true, n: 21 }, sma: { on: false, n: 50 }, vwap: { on: true },
  bb: { on: false, n: 20, k: 2 }, volume: { on: true }, rsi: { on: false, n: 14 }, macd: { on: false },
};
const IND_INFO = [
  ['ema1', 'EMA', '#f5a623', 'n'], ['ema2', 'EMA', '#4da3e5', 'n'], ['sma', 'SMA', '#c084fc', 'n'], ['vwap', 'VWAP', '#e5e7eb'],
  ['bb', 'Bollinger Bands', '#64748b', 'n'], ['volume', 'Volume'], ['rsi', 'RSI', '#a78bfa', 'n'], ['macd', 'MACD (12, 26, 9)'],
];

const uid = () => Math.random().toString(36).slice(2, 10);
const dist = (x1, y1, x2, y2) => Math.hypot(x1 - x2, y1 - y2);
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l = dx * dx + dy * dy;
  const k = l ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l)) : 0;
  return dist(px, py, x1 + k * dx, y1 + k * dy);
}
/** where the line through a→b leaves the pane, going past b */
function rayEnd(x1, y1, x2, y2, w, h) {
  const dx = x2 - x1, dy = y2 - y1;
  if (!dx && !dy) return [x2, y2];
  let k = Infinity;
  if (dx > 0) k = Math.min(k, (w - x1) / dx); else if (dx < 0) k = Math.min(k, -x1 / dx);
  if (dy > 0) k = Math.min(k, (h - y1) / dy); else if (dy < 0) k = Math.min(k, -y1 / dy);
  if (!Number.isFinite(k)) k = 1;
  return [x1 + dx * Math.max(k, 1), y1 + dy * Math.max(k, 1)];
}

/** Pixel positions of a drawing's handles. */
function handles(d, v) {
  const P = d.p.map((q) => ({ x: v.toX(q.t), y: v.toY(q.p) }));
  switch (d.type) {
    case 'hline': return [{ i: 0, x: 40, y: P[0].y }];
    case 'vline': return [{ i: 0, x: P[0].x, y: v.h / 2 }];
    case 'hray': case 'text': return [{ i: 0, ...P[0] }];
    case 'brush': return [];
    case 'long': case 'short': return [{ i: 0, ...P[0] }, { i: 1, x: P[1].x, y: P[1].y }, { i: 2, x: P[1].x, y: P[2].y }];
    default: return P.map((q, i) => ({ i, ...q }));
  }
}

/** What part of the drawing is under (x, y): a handle index, 'body' or null. */
function hitDrawing(d, v, x, y) {
  for (const hd of handles(d, v)) if (dist(x, y, hd.x, hd.y) < 8) return hd.i;
  const P = d.p.map((q) => ({ x: v.toX(q.t), y: v.toY(q.p) }));
  const near = 6;
  const inBox = (a, b) => x >= Math.min(a.x, b.x) - 2 && x <= Math.max(a.x, b.x) + 2 && y >= Math.min(a.y, b.y) - 2 && y <= Math.max(a.y, b.y) + 2;
  switch (d.type) {
    case 'trend': return segDist(x, y, P[0].x, P[0].y, P[1].x, P[1].y) < near ? 'body' : null;
    case 'ray': { const [ex, ey] = rayEnd(P[0].x, P[0].y, P[1].x, P[1].y, v.w, v.h); return segDist(x, y, P[0].x, P[0].y, ex, ey) < near ? 'body' : null; }
    case 'hline': return Math.abs(y - P[0].y) < near ? 'body' : null;
    case 'hray': return x >= P[0].x - near && Math.abs(y - P[0].y) < near ? 'body' : null;
    case 'vline': return Math.abs(x - P[0].x) < near ? 'body' : null;
    case 'rect': case 'measure': case 'fib': return inBox(P[0], P[1]) ? 'body' : null;
    case 'long': case 'short': return x >= Math.min(P[0].x, P[1].x) && x <= Math.max(P[0].x, P[1].x) && y >= Math.min(P[1].y, P[2].y) && y <= Math.max(P[1].y, P[2].y) ? 'body' : null;
    case 'brush': for (let i = 1; i < P.length; i++) if (segDist(x, y, P[i - 1].x, P[i - 1].y, P[i].x, P[i].y) < near) return 'body'; return null;
    case 'text': { const w = Math.max(30, (d.text || '').length * 7.2 + 12); return x >= P[0].x - 4 && x <= P[0].x + w && y >= P[0].y - 16 && y <= P[0].y + 6 ? 'body' : null; }
    default: return null;
  }
}

function label(ctx, text, x, y, bg, fg = '#fff', align = 'left') {
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  const w = ctx.measureText(text).width + 10;
  const lx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  ctx.fillStyle = bg;
  ctx.fillRect(lx, y - 9, w, 18);
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, lx + 5, y);
}

/** Draws one drawing on the overlay canvas. */
function paint(ctx, d, v, selected, fmtP, tick, iv) {
  const P = d.p.map((q) => ({ x: v.toX(q.t), y: v.toY(q.p) }));
  if (P.some((q) => q.x == null || q.y == null || !Number.isFinite(q.x) || !Number.isFinite(q.y))) return;
  const col = d.color || DEFAULT_COLOR[d.type];
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = (d.width || 1.5) + (selected ? 0.5 : 0);
  ctx.setLineDash([]);
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
  switch (d.type) {
    case 'trend': line(P[0].x, P[0].y, P[1].x, P[1].y); break;
    case 'ray': { const [ex, ey] = rayEnd(P[0].x, P[0].y, P[1].x, P[1].y, v.w, v.h); line(P[0].x, P[0].y, ex, ey); break; }
    case 'hline': line(0, P[0].y, v.w, P[0].y); label(ctx, fmtP(d.p[0].p), v.w - 2, P[0].y, col, '#000', 'right'); break;
    case 'hray': line(P[0].x, P[0].y, v.w, P[0].y); label(ctx, fmtP(d.p[0].p), v.w - 2, P[0].y, col, '#000', 'right'); break;
    case 'vline': line(P[0].x, 0, P[0].x, v.h); break;
    case 'rect': {
      ctx.fillStyle = alpha(col, 0.14);
      ctx.fillRect(Math.min(P[0].x, P[1].x), Math.min(P[0].y, P[1].y), Math.abs(P[1].x - P[0].x), Math.abs(P[1].y - P[0].y));
      ctx.strokeRect(Math.min(P[0].x, P[1].x), Math.min(P[0].y, P[1].y), Math.abs(P[1].x - P[0].x), Math.abs(P[1].y - P[0].y));
      break;
    }
    case 'fib': {
      const x1 = Math.min(P[0].x, P[1].x), x2 = Math.max(P[0].x, P[1].x);
      const lv = FIB.map((l) => { const price = d.p[1].p + (d.p[0].p - d.p[1].p) * l; return { l, price, y: v.toY(price) }; });
      for (let i = 1; i < lv.length; i++) { ctx.fillStyle = alpha(col, i % 2 ? 0.07 : 0.12); ctx.fillRect(x1, lv[i - 1].y, x2 - x1, lv[i].y - lv[i - 1].y); }
      for (const q of lv) {
        ctx.strokeStyle = q.l === 0.5 || q.l === 0.618 ? col : alpha(col, 0.75);
        line(x1, q.y, x2, q.y);
        ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = col; ctx.textBaseline = 'bottom';
        ctx.fillText(`${q.l} (${fmtP(q.price)})`, x1 + 4, q.y - 2);
      }
      ctx.setLineDash([4, 4]); ctx.strokeStyle = alpha(col, 0.6); line(P[0].x, P[0].y, P[1].x, P[1].y); ctx.setLineDash([]);
      break;
    }
    case 'measure': {
      const up = d.p[1].p >= d.p[0].p;
      const c2 = up ? '#4da3e5' : '#e5484d';
      ctx.fillStyle = alpha(c2, 0.16);
      ctx.fillRect(Math.min(P[0].x, P[1].x), Math.min(P[0].y, P[1].y), Math.abs(P[1].x - P[0].x), Math.abs(P[1].y - P[0].y));
      ctx.strokeStyle = c2; ctx.lineWidth = 1;
      line((P[0].x + P[1].x) / 2, P[0].y, (P[0].x + P[1].x) / 2, P[1].y);
      line(P[0].x, (P[0].y + P[1].y) / 2, P[1].x, (P[0].y + P[1].y) / 2);
      const dp = d.p[1].p - d.p[0].p;
      const bars = Math.round(Math.abs(d.p[1].t - d.p[0].t) / iv);
      const mins = Math.round(Math.abs(d.p[1].t - d.p[0].t) / 60);
      const dur = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
      const txt = `${dp >= 0 ? '+' : ''}${fmtP(dp)}${tick ? ` (${Math.round(dp / tick)} ticks)` : ''} ${((dp / d.p[0].p) * 100).toFixed(2)}% · ${bars} bars, ${dur}`;
      label(ctx, txt, (P[0].x + P[1].x) / 2, up ? Math.min(P[0].y, P[1].y) - 14 : Math.max(P[0].y, P[1].y) + 14, c2, '#fff', 'center');
      break;
    }
    case 'long': case 'short': {
      const x1 = Math.min(P[0].x, P[1].x), x2 = Math.max(P[0].x, P[1].x);
      const entry = d.p[0].p, stop = d.p[1].p, target = d.p[2].p;
      ctx.fillStyle = alpha('#2bc48a', 0.18); ctx.fillRect(x1, Math.min(P[0].y, P[2].y), x2 - x1, Math.abs(P[2].y - P[0].y));
      ctx.fillStyle = alpha('#e5484d', 0.18); ctx.fillRect(x1, Math.min(P[0].y, P[1].y), x2 - x1, Math.abs(P[1].y - P[0].y));
      ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1; line(x1, P[0].y, x2, P[0].y);
      const risk = Math.abs(entry - stop), reward = Math.abs(target - entry);
      const tk = (x) => (tick ? ` · ${Math.round(x / tick)} ticks` : '');
      label(ctx, `Target ${fmtP(target)}${tk(reward)}`, x1, P[2].y + (P[2].y < P[0].y ? -11 : 11), '#1aa87f');
      label(ctx, `Stop ${fmtP(stop)}${tk(risk)}`, x1, P[1].y + (P[1].y > P[0].y ? 11 : -11), '#c53b40');
      label(ctx, `${d.type === 'long' ? 'Long' : 'Short'} ${fmtP(entry)} · R:R ${risk ? (reward / risk).toFixed(2) : '—'}`, x1, P[0].y, '#3f3f46');
      break;
    }
    case 'brush': {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      P.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.stroke();
      break;
    }
    case 'text': {
      ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = col;
      ctx.fillText(d.text || '', P[0].x, P[0].y);
      break;
    }
    default:
  }
  if (selected) {
    for (const hd of handles(d, v)) {
      ctx.beginPath(); ctx.arc(hd.x, hd.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#0a0a0a'; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = col; ctx.stroke();
    }
  }
}

/** Puts new data on a series, using update() when only the last bar changed or one was added (replay). */
function feed(series, data) {
  const n = series.__n || 0;
  const last = series.__last;
  if (n && data.length && ((data.length === n && data[n - 1].time === last) || (data.length === n + 1 && data[n - 1]?.time === last))) series.update(data[data.length - 1]);
  else series.setData(data);
  series.__n = data.length;
  series.__last = data.length ? data[data.length - 1].time : undefined;
}

export default function ChartStudio({ date, trades, initialSym, onClose, onOpenTrade }) {
  const { state, setSetting } = useStore();
  const symbols = useMemo(() => {
    const n = new Map();
    for (const t of trades) n.set(t.symbol, (n.get(t.symbol) || 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([s, c]) => ({ s, c }));
  }, [trades]);
  const [sym, setSym] = useState(initialSym && symbols.some((x) => x.s === initialSym) ? initialSym : symbols[0]?.s);
  const studio = state.settings.studio || {};
  const setStudio = (patch) => setSetting('studio', { ...(state.settings.studio || {}), ...patch });
  const tf = TIMEFRAMES.includes(studio.tf) ? studio.tf : TIMEFRAMES.includes(state.settings.execTf) ? state.settings.execTf : '1m';
  const ind = useMemo(() => { const o = {}; for (const k of Object.keys(DEFAULT_IND)) o[k] = { ...DEFAULT_IND[k], ...(studio.ind?.[k] || {}) }; return o; }, [studio.ind]);
  const indKey = JSON.stringify(ind);
  const magnet = !!studio.magnet;
  const showExec = studio.exec !== false;
  const span = Math.max(1, SPAN_DAYS[tf] || 0);
  const root = rootOf(sym);
  const tick = TICKS[root];
  const prec = tick ? decimals(tick) : 2;
  const fmtP = useCallback((v) => Number(v).toFixed(prec), [prec]);
  const themeKey = `${state.settings.themeId}|${state.settings.theme}|${JSON.stringify(state.settings.customThemes || [])}|${JSON.stringify(state.settings.chartColors || {})}`;

  // ---------------------------------------------------------------- data
  const [rec, setRec] = useState({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!sym) return undefined;
    let alive = true;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const get = (d, refresh) => fetch(`/api/candles?symbol=${encodeURIComponent(sym)}&date=${d}&tz=${encodeURIComponent(tz)}${refresh ? '&refresh=1' : ''}`)
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Error ${r.status}`); return j; });
    const extraDays = [];
    for (let i = 1; i <= span; i++) { const x = new Date(`${date}T12:00:00`); x.setDate(x.getDate() - i); if (x.getDay() !== 6) extraDays.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`); }
    setRec({ status: 'loading' });
    Promise.all([get(date, nonce > 0), Promise.all(extraDays.map((d) => get(d).then((j) => j.candles || []).catch(() => [])))])
      .then(([j, more]) => {
        if (!alive) return;
        const byT = new Map();
        for (const c of [...more.flat(), ...(j.candles || [])]) byT.set(c[0], c);
        setRec({ status: 'ok', ...j, candles: [...byT.values()].sort((x, y) => x[0] - y[0]), key: `${sym}|${date}|${span}` });
      })
      .catch((e) => alive && setRec({ status: 'error', error: e.message }));
    return () => { alive = false; };
  }, [sym, date, span, nonce]);
  const rows = rec.status === 'ok' ? rec.candles || [] : [];
  const srcIv = ivSec(rec.interval || '1m');
  const iv = Math.max(ivSec(tf), srcIv);
  const symTrades = useMemo(() => trades.filter((t) => t.symbol === sym), [trades, sym]);

  // ---------------------------------------------------------------- drawings (saved per instrument)
  const saved = state.settings.chartDrawings?.[root];
  const [drawings, setDrawings] = useState(() => saved || []);
  const drawingsRef = useRef(drawings);
  drawingsRef.current = drawings;
  const loadedRoot = useRef(root);
  useEffect(() => { if (loadedRoot.current !== root) { loadedRoot.current = root; setDrawings(state.settings.chartDrawings?.[root] || []); history.current = []; } }, [root]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveTimer = useRef(null);
  useEffect(() => {
    if (IS_VIEWER) return undefined; // a shared journal can be drawn on, but nothing is saved
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const all = state.settings.chartDrawings || {};
      if (JSON.stringify(all[loadedRoot.current] || []) === JSON.stringify(drawings)) return;
      setSetting('chartDrawings', { ...all, [loadedRoot.current]: drawings });
    }, 600);
    return () => clearTimeout(saveTimer.current);
  }, [drawings]); // eslint-disable-line react-hooks/exhaustive-deps
  const history = useRef([]);
  const commit = (next) => { history.current = [...history.current.slice(-49), drawingsRef.current]; drawingsRef.current = next; setDrawings(next); };
  const undo = () => { const prev = history.current.pop(); if (prev) { drawingsRef.current = prev; setDrawings(prev); setSel(null); } };

  const [tool, setToolState] = useState('cursor');
  const toolRef = useRef(tool);
  const setTool = (t) => { toolRef.current = t; setToolState(t); draft.current = null; };
  const [sel, setSelState] = useState(null);
  const selRef = useRef(sel);
  const setSel = (id) => { selRef.current = id; setSelState(id); };
  const [hidden, setHidden] = useState(false);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const [editing, setEditing] = useState(null); // { id, x, y, text }
  const draft = useRef(null); // drawing being created
  const drag = useRef(null); // { id, part, x0, y0, orig }
  const magnetRef = useRef(magnet);
  magnetRef.current = magnet;

  // ---------------------------------------------------------------- replay
  const [replay, setReplay] = useState({ mode: 'off', idx: 0, playing: false, speed: 5 });
  const replayRef = useRef(replay);
  replayRef.current = replay;
  const hoverX = useRef(null);

  // ---------------------------------------------------------------- chart
  const stage = useRef(null);
  const box = useRef(null);
  const overlay = useRef(null);
  const legend = useRef(null);
  const tipRef = useRef(null);
  const api = useRef({});
  const openRef = useRef(onOpenTrade);
  openRef.current = onOpenTrade;

  const view = () => {
    const a = api.current;
    if (!a.chart || !a.bars?.length) return null;
    const ts = a.chart.timeScale();
    const T = a.barTimes, n = T.length;
    const toLogical = (t) => {
      if (t <= T[0]) return (t - T[0]) / a.iv;
      if (t >= T[n - 1]) return n - 1 + (t - T[n - 1]) / a.iv;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
      return lo + (t - T[lo]) / (T[hi] - T[lo]);
    };
    const fromLogical = (l) => {
      if (l <= 0) return T[0] + l * a.iv;
      if (l >= n - 1) return T[n - 1] + (l - (n - 1)) * a.iv;
      const i = Math.floor(l);
      return T[i] + (l - i) * (T[i + 1] - T[i]);
    };
    let h = 0;
    try { h = a.chart.paneSize(0).height; } catch { h = (box.current?.clientHeight || 0) - ts.height(); }
    return {
      w: ts.width(), h,
      toX: (t) => ts.logicalToCoordinate(toLogical(t)),
      toY: (p) => a.series.priceToCoordinate(p),
      fromX: (x) => fromLogical(ts.coordinateToLogical(x)),
      fromY: (y) => a.series.coordinateToPrice(y),
      snap: (x, y) => { // magnet: the nearest open/high/low/close of the bar under the pointer
        const l = Math.round(ts.coordinateToLogical(x));
        const b = a.bars[Math.max(0, Math.min(n - 1, l))];
        const pr = [b.open, b.high, b.low, b.close].sort((p1, p2) => Math.abs(a.series.priceToCoordinate(p1) - y) - Math.abs(a.series.priceToCoordinate(p2) - y))[0];
        return { t: b.time, p: pr };
      },
    };
  };

  // build the chart
  useEffect(() => {
    if (rec.status !== 'ok' || !rows.length || !box.current || rec.key !== `${sym}|${date}|${span}`) return undefined;
    let cancelled = false;
    let chart;
    loadLib().then((LW) => {
      if (cancelled || !box.current) return;
      const c = chartColors(state.settings.chartColors);
      chart = LW.createChart(box.current, {
        autoSize: true,
        layout: { background: { type: 'solid', color: c.bg }, textColor: c.text, fontFamily: c.font, fontSize: 11, attributionLogo: true, panes: { separatorColor: c.border } },
        grid: { vertLines: { color: alpha(c.border, 0.5) }, horzLines: { color: alpha(c.border, 0.5) } },
        rightPriceScale: { borderColor: c.border, scaleMargins: { top: 0.08, bottom: ind.volume.on ? 0.18 : 0.08 } },
        timeScale: { borderColor: c.border, timeVisible: iv < 86400, secondsVisible: false, rightOffset: 8, barSpacing: 7, shiftVisibleRangeOnNewBar: true },
        crosshair: { mode: 0 },
      });
      const series = chart.addSeries(LW.CandlestickSeries, {
        upColor: c.up, downColor: c.down, wickUpColor: c.wickUp, wickDownColor: c.wickDown, borderUpColor: c.wickUp, borderDownColor: c.wickDown, borderVisible: c.wickUp !== c.up || c.wickDown !== c.down,
        priceFormat: { type: 'price', precision: prec, minMove: tick || 0.01 }, priceLineVisible: true,
      });
      const line = (color, pane = 0, extra = {}) => chart.addSeries(LW.LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra }, pane);
      const inds = [];
      const sess = (b) => sessionStart(fromLocal(b.time));
      if (ind.ema1.on) inds.push({ s: line('#f5a623'), f: (b) => ema(b, ind.ema1.n) });
      if (ind.ema2.on) inds.push({ s: line('#4da3e5'), f: (b) => ema(b, ind.ema2.n) });
      if (ind.sma.on) inds.push({ s: line('#c084fc'), f: (b) => sma(b, ind.sma.n) });
      if (ind.vwap.on && iv < 86400) inds.push({ s: line('#e5e7eb', 0, { lineWidth: 2, lineStyle: 2 }), f: (b) => vwap(b, sess) });
      if (ind.bb.on) {
        let cache = null;
        const bb = (b) => { if (cache?.b !== b) cache = { b, v: bollinger(b, ind.bb.n, ind.bb.k) }; return cache.v; };
        inds.push({ s: line(alpha('#94a3b8', 0.9)), f: (b) => bb(b).upper }, { s: line(alpha('#94a3b8', 0.6), 0, { lineStyle: 2 }), f: (b) => bb(b).mid }, { s: line(alpha('#94a3b8', 0.9)), f: (b) => bb(b).lower });
      }
      if (ind.volume.on) {
        const vol = chart.addSeries(LW.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
        chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
        inds.push({ s: vol, f: (b) => b.map((x) => ({ time: x.time, value: x.volume, color: alpha(x.close >= x.open ? c.up : c.down, 0.45) })) });
      }
      let pane = 1;
      if (ind.rsi.on) {
        const s = line('#a78bfa', pane, { lastValueVisible: true, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } });
        s.createPriceLine({ price: 70, color: alpha(c.text, 0.5), lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
        s.createPriceLine({ price: 30, color: alpha(c.text, 0.5), lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
        inds.push({ s, f: (b) => rsi(b, ind.rsi.n) });
        pane += 1;
      }
      if (ind.macd.on) {
        let cache = null;
        const m = (b) => { if (cache?.b !== b) cache = { b, v: macd(b) }; return cache.v; };
        const hist = chart.addSeries(LW.HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
        inds.push(
          { s: hist, f: (b) => m(b).hist.map((p) => ({ ...p, color: alpha(p.value >= 0 ? c.up : c.down, 0.55) })) },
          { s: line('#4da3e5', pane), f: (b) => m(b).line },
          { s: line('#f59e0b', pane), f: (b) => m(b).signal },
        );
        pane += 1;
      }
      // RSI / MACD panes: a fixed share of the height. A height change lands on the next frame and takes room from
      // the other panes, so each pane is set in its own step, a few rounds, until they settle.
      const sizePanes = (step = 0) => {
        if (cancelled) return;
        try {
          const ps = chart.panes();
          if (ps.length < 2 || step > ps.length * 4) return;
          const total = ps.reduce((sum, p) => sum + p.getHeight(), 0);
          const k = Math.max(80, Math.round(total * 0.15));
          const want = (i) => (i ? k : total - k * (ps.length - 1));
          if (ps.every((p, i) => Math.abs(p.getHeight() - want(i)) <= 2)) return;
          const i = step % ps.length;
          ps[i].setHeight(want(i));
          setTimeout(() => sizePanes(step + 1), 20);
        } catch { /* older library */ }
      };
      setTimeout(() => sizePanes(), 30);
      const markers = LW.createSeriesMarkers(series, []);
      // the entry → exit lines (one series per trade, filled as the replay reaches the exit)
      const toBar = (u) => barTime(u, iv);
      const allEx = buildExecutions(symTrades, aggregate(rows, iv).map((x) => x.time), toBar);
      const lines = new Map(allEx.lines.map((ln) => [ln.id, line(alpha(ln.pnl >= 0 ? c.win : c.loss, 0.85), 0, { lineStyle: 2, pointMarkersVisible: false })]));
      api.current = { chart, series, inds, markers, lines, iv, toBar, c, bars: [], barTimes: [], allEx };
      render();
      const fit = () => {
        const a = api.current;
        if (replayRef.current.mode === 'on') return;
        if (!Number.isFinite(allEx.first)) { chart.timeScale().fitContent(); return; }
        const pad = Math.max(45 * 60, (allEx.last - allEx.first) * 0.25, iv * 25);
        try { chart.timeScale().setVisibleRange({ from: Math.max(a.barTimes[0], allEx.first - pad), to: Math.min(a.barTimes[a.barTimes.length - 1] + iv * 5, allEx.last + pad) }); } catch { chart.timeScale().fitContent(); }
      };
      api.current.fit = fit;
      requestAnimationFrame(() => !cancelled && (replayRef.current.mode === 'on' ? focusReplay() : fit()));

      // OHLC readout, execution tips and clicks
      const showOhlc = (d) => {
        if (!legend.current) return;
        if (!d) { legend.current.textContent = ''; return; }
        const chg = d.close - d.open;
        legend.current.innerHTML = `O <b>${fmtP(d.open)}</b> H <b>${fmtP(d.high)}</b> L <b>${fmtP(d.low)}</b> C <b style="color:${chg >= 0 ? c.up : c.down}">${fmtP(d.close)}</b> <span style="color:${chg >= 0 ? c.up : c.down}">${chg >= 0 ? '+' : ''}${fmtP(chg)}</span>`;
      };
      api.current.showOhlc = showOhlc;
      const byId = new Map(symTrades.map((t) => [t.id, t]));
      const hitExec = (pt) => {
        if (!pt || !api.current.shownMarkers) return null;
        let best = null, bestD = 14;
        for (const m of api.current.shownMarkers) {
          const x = chart.timeScale().timeToCoordinate(m.time);
          const y0 = series.priceToCoordinate(m.price);
          if (x == null || y0 == null) continue;
          const y = y0 + (m.side === 'buy' ? 9 : -9);
          const dd = Math.hypot(pt.x - x, pt.y - y);
          if (dd < bestD) { bestD = dd; best = { m, x, y }; }
        }
        return best;
      };
      const tip = (h) => {
        const el = tipRef.current;
        if (!el) return;
        if (!h || toolRef.current !== 'cursor') { el.style.display = 'none'; return; }
        const t = byId.get(h.m.ids[0]);
        if (!t) return;
        const priv = state.settings.privacy;
        el.innerHTML = `<b>${h.m.side === 'buy' ? 'Buy' : 'Sell'} ${h.m.qty} @ ${fmtP(h.m.price)}</b><span>${t.direction} ${t.symbol} · ${fmtTime12(t.entry)} → ${fmtTime12(t.exit)}</span><span><em style="color:${t.pnl >= 0 ? c.win : c.loss}">${priv ? '•••' : fmtMoney(t.pnl, { sign: true })}</em></span>${openRef.current ? '<small>Click to review</small>' : ''}`;
        el.style.display = 'block';
        el.style.left = `${Math.min(Math.max(8, h.x + 12), box.current.clientWidth - 210)}px`;
        el.style.top = `${Math.max(8, h.y + (h.m.side === 'buy' ? 12 : -80))}px`;
      };
      chart.subscribeCrosshairMove((p) => {
        showOhlc(p?.seriesData?.get(series) || api.current.bars[api.current.bars.length - 1]);
        tip(hitExec(p?.point));
      });
      chart.subscribeClick((p) => {
        if (toolRef.current !== 'cursor' || drag.current) return;
        const h = hitExec(p?.point);
        const t = h && byId.get(h.m.ids[0]);
        if (t && openRef.current) openRef.current(t);
      });
    }).catch((e) => !cancelled && setRec({ status: 'error', error: e.message }));
    return () => { cancelled = true; if (chart) chart.remove(); api.current = {}; };
  }, [rec, themeKey, tf, indKey, sym, showExec]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Puts the candles (up to the replay position), indicators and executions on the chart. */
  function render() {
    const a = api.current;
    if (!a.chart || !rows.length) return;
    const r = replayRef.current;
    const end = r.mode === 'on' ? Math.min(r.idx, rows.length - 1) : rows.length - 1;
    const vis = r.mode === 'on' ? rows.slice(0, end + 1) : rows;
    const bars = aggregate(vis, a.iv);
    feed(a.series, bars);
    for (const x of a.inds) feed(x.s, x.f(bars));
    a.bars = bars;
    a.barTimes = bars.map((b) => b.time);
    const until = r.mode === 'on' ? rows[end][0] + srcIv - 1 : Infinity;
    const ex = showExec ? buildExecutions(symTrades, a.barTimes, a.toBar, until) : { markers: [], lines: [] };
    a.shownMarkers = ex.markers;
    a.markers.setMarkers(ex.markers.map((m) => ({ time: m.time, position: m.side === 'buy' ? 'atPriceBottom' : 'atPriceTop', price: m.price, shape: m.side === 'buy' ? 'arrowUp' : 'arrowDown', color: m.side === 'buy' ? a.c.buy : a.c.sell, text: m.qty > 1 ? String(m.qty) : '', size: 1 })));
    const shown = new Map(ex.lines.map((ln) => [ln.id, ln.points]));
    for (const [id, s] of a.lines) { const pts = shown.get(id) || []; if ((s.__n || 0) !== pts.length) { s.setData(pts); s.__n = pts.length; } }
    a.showOhlc?.(bars[bars.length - 1]);
  }
  const renderRef = useRef(render);
  renderRef.current = render;
  useEffect(() => { renderRef.current(); }, [replay.idx, replay.mode]);

  function focusReplay() {
    const a = api.current;
    if (!a.chart) return;
    const n = a.bars.length;
    try { a.chart.timeScale().setVisibleLogicalRange({ from: n - 90, to: n + 25 }); } catch { /* */ }
  }

  // ---------------------------------------------------------------- overlay: drawings, the replay start line
  useEffect(() => {
    let raf;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const cv = overlay.current;
      const v = view();
      if (!cv) return;
      const dpr = window.devicePixelRatio || 1;
      const W = box.current?.clientWidth || 0, H = box.current?.clientHeight || 0;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!v) return;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, v.w, v.h); ctx.clip();
      if (!hiddenRef.current) for (const d of drawingsRef.current) paint(ctx, d, v, d.id === selRef.current, fmtP, tick, api.current.iv);
      if (draft.current) paint(ctx, draft.current, v, true, fmtP, tick, api.current.iv);
      if (replayRef.current.mode === 'pick' && hoverX.current != null) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(hoverX.current, 0, v.w - hoverX.current, v.h);
        ctx.strokeStyle = '#4da3e5'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(hoverX.current, 0); ctx.lineTo(hoverX.current, v.h); ctx.stroke();
      }
      ctx.restore();
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [fmtP, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- pointer: drawing, selecting, dragging
  useEffect(() => {
    const el = stage.current;
    if (!el) return undefined;
    let handling = false;
    const local = (e) => { const r = box.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const pt = (v, x, y, e) => ((magnetRef.current || e?.ctrlKey || e?.metaKey) ? v.snap(x, y) : { t: v.fromX(x), p: v.fromY(y) });
    const block = (e) => { if (handling) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); } };
    const finishDraft = () => {
      const d = draft.current;
      draft.current = null;
      if (!d) return;
      if (d.type === 'brush' && d.p.length < 2) return;
      if (d.type === 'text') { const v = view(); setEditing({ id: d.id, x: v.toX(d.p[0].t), y: v.toY(d.p[0].p), text: '', fresh: d }); return; }
      commit([...drawingsRef.current, d]);
      setSel(d.id);
      setTool('cursor');
    };
    const down = (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!box.current?.contains(e.target) && e.target !== overlay.current) return;
      const v = view();
      if (!v) return;
      const { x, y } = local(e);
      if (x < 0 || y < 0 || x > v.w || y > v.h) return; // price / time scales: the chart handles those
      const r = replayRef.current;
      if (r.mode === 'pick') {
        handling = true; block(e);
        const t = v.fromX(x);
        let idx = rows.findIndex((row) => barTime(row[0], srcIv) > t) - 1;
        if (idx < 0) idx = rows.length - 1;
        setReplay((s) => ({ ...s, mode: 'on', idx: Math.max(0, idx), playing: false }));
        requestAnimationFrame(() => requestAnimationFrame(focusReplay));
        return;
      }
      const t = toolRef.current;
      if (t !== 'cursor') {
        handling = true; block(e);
        const q = pt(v, x, y, e);
        if (draft.current?.placing) { draft.current.p[1] = q; if (draft.current.type === 'long' || draft.current.type === 'short') draft.current.p[2] = { t: q.t, p: draft.current.p[0].p + (draft.current.p[0].p - q.p) * 2 }; finishDraft(); return; }
        const d = { id: uid(), type: t, color: DEFAULT_COLOR[t], width: t === 'brush' ? 2 : 1.5, p: ONE_POINT.has(t) ? [q] : t === 'brush' ? [q] : [q, { ...q }] };
        if (t === 'long' || t === 'short') {
          const step = (tick || Math.abs(q.p) * 0.0005) * 20;
          const stop = t === 'long' ? q.p - step : q.p + step;
          d.p = [q, { t: q.t + api.current.iv * 15, p: stop }, { t: q.t + api.current.iv * 15, p: q.p + (q.p - stop) * 2 }];
        }
        draft.current = d;
        drag.current = { create: true, x0: x, y0: y };
        if (ONE_POINT.has(t)) { drag.current = null; finishDraft(); }
        return;
      }
      if (!hiddenRef.current) {
        const list = drawingsRef.current;
        for (let i = list.length - 1; i >= 0; i--) {
          const part = hitDrawing(list[i], v, x, y);
          if (part !== null) {
            handling = true; block(e);
            setSel(list[i].id);
            drag.current = { id: list[i].id, part, x0: x, y0: y, orig: list[i], before: list, moved: false };
            if (e.detail === 2 && list[i].type === 'text') setEditing({ id: list[i].id, x: v.toX(list[i].p[0].t), y: v.toY(list[i].p[0].p), text: list[i].text || '' });
            return;
          }
        }
      }
      if (selRef.current) setSel(null);
    };
    const move = (e) => {
      const v = view();
      if (!v || !box.current) return;
      const { x, y } = local(e);
      if (replayRef.current.mode === 'pick') { hoverX.current = x >= 0 && x <= v.w ? x : null; el.style.cursor = 'col-resize'; return; }
      const d = draft.current;
      if (d && (drag.current?.create || d.placing)) {
        const q = pt(v, x, y, e);
        if (d.type === 'brush') { if (drag.current) d.p.push(q); return; }
        if (d.type === 'long' || d.type === 'short') {
          d.p[1] = { t: Math.max(q.t, d.p[0].t + api.current.iv * 3), p: q.p };
          d.p[2] = { t: d.p[1].t, p: d.p[0].p + (d.p[0].p - q.p) * 2 };
        } else d.p[1] = q;
        return;
      }
      const g = drag.current;
      if (g && g.id) {
        if (!g.moved && dist(x, y, g.x0, g.y0) < 3) return;
        g.moved = true;
        const o = g.orig;
        let p = o.p.map((q) => ({ ...q }));
        if (g.part === 'body') {
          const dt = v.fromX(x) - v.fromX(g.x0), dp = v.fromY(y) - v.fromY(g.y0);
          p = p.map((q) => ({ t: q.t + dt, p: q.p + dp }));
        } else {
          const q = pt(v, x, y, e);
          if (o.type === 'long' || o.type === 'short') {
            if (g.part === 0) p[0] = { t: q.t, p: q.p };
            else if (g.part === 1) { p[1] = { t: Math.max(q.t, p[0].t + api.current.iv), p: q.p }; p[2] = { ...p[2], t: p[1].t }; }
            else { p[2] = { t: Math.max(q.t, p[0].t + api.current.iv), p: q.p }; p[1] = { ...p[1], t: p[2].t }; }
          } else p[g.part] = q;
        }
        drawingsRef.current = drawingsRef.current.map((x2) => (x2.id === o.id ? { ...o, p } : x2));
        return;
      }
      // hover: show what's clickable
      if (toolRef.current !== 'cursor') { el.style.cursor = 'crosshair'; return; }
      let over = null;
      if (!hiddenRef.current && x >= 0 && y >= 0 && x <= v.w && y <= v.h) for (const dd of drawingsRef.current) { const part = hitDrawing(dd, v, x, y); if (part !== null) { over = part; break; } }
      el.style.cursor = over === null ? '' : over === 'body' ? 'move' : 'grab';
    };
    const up = () => {
      const g = drag.current;
      if (g?.create) {
        drag.current = null;
        const d = draft.current;
        if (!d) return;
        const v = view();
        const moved = d.type === 'brush' || (v && d.p[1] && dist(v.toX(d.p[0].t), v.toY(d.p[0].p), v.toX(d.p[1].t), v.toY(d.p[1].p)) > 5);
        if (moved) finishDraft(); else d.placing = true; // click, move, click
      } else if (g?.id) {
        drag.current = null;
        if (g.moved) { history.current = [...history.current.slice(-49), g.before]; setDrawings(drawingsRef.current); }
      }
      setTimeout(() => { handling = false; }, 0);
    };
    el.addEventListener('pointerdown', down, true);
    el.addEventListener('mousedown', block, true);
    el.addEventListener('touchstart', block, { capture: true, passive: false });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      el.removeEventListener('pointerdown', down, true);
      el.removeEventListener('mousedown', block, true);
      el.removeEventListener('touchstart', block, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [rows, srcIv, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- replay playback
  useEffect(() => {
    if (replay.mode !== 'on' || !replay.playing) return undefined;
    const id = setInterval(() => {
      setReplay((s) => (s.idx >= rows.length - 1 ? { ...s, playing: false } : { ...s, idx: s.idx + 1 }));
    }, 1000 / replay.speed);
    return () => clearInterval(id);
  }, [replay.mode, replay.playing, replay.speed, rows.length]);
  const execTimes = useMemo(() => {
    const ts = [];
    for (const t of symTrades) for (const f of (t.fills?.length ? t.fills : [t])) for (const iso of [f.entry, f.exit]) if (iso) ts.push(Math.floor(new Date(iso).getTime() / 1000));
    return ts.sort((x, y) => x - y);
  }, [symTrades]);
  const startReplay = (where) => {
    if (!rows.length) return;
    if (where === 'pick') { setReplay((s) => ({ ...s, mode: 'pick', playing: false })); setTool('cursor'); setSel(null); return; }
    const first = execTimes[0];
    let idx = 0;
    if (where === 'trade' && first) { idx = rows.findIndex((r) => r[0] >= first - 30 * 60); if (idx < 0) idx = 0; }
    setReplay((s) => ({ ...s, mode: 'on', idx, playing: false }));
    requestAnimationFrame(() => requestAnimationFrame(focusReplay));
  };
  const stopReplay = () => { setReplay((s) => ({ ...s, mode: 'off', playing: false })); requestAnimationFrame(() => requestAnimationFrame(() => api.current.fit?.())); };
  const stepTo = (idx) => setReplay((s) => ({ ...s, idx: Math.max(0, Math.min(rows.length - 1, idx)), playing: false }));
  const nextExec = () => {
    const now = rows[replay.idx]?.[0] ?? 0;
    const t = execTimes.find((x) => x > now + srcIv - 1);
    if (t == null) return;
    const idx = rows.findIndex((r) => r[0] + srcIv > t);
    stepTo(idx < 0 ? rows.length - 1 : idx);
  };
  const replayUntil = replay.mode === 'on' && rows[replay.idx] ? rows[replay.idx][0] + srcIv - 1 : Infinity;
  const replayDone = symTrades.filter((t) => t.exit && Math.floor(new Date(t.exit).getTime() / 1000) <= replayUntil);
  const replayPnl = replayDone.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const openPos = replay.mode === 'on' ? symTrades.find((t) => Math.floor(new Date(t.entry).getTime() / 1000) <= replayUntil && !(Math.floor(new Date(t.exit).getTime() / 1000) <= replayUntil)) : null;

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const key = (e) => {
      if (/input|textarea|select/i.test(e.target?.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selRef.current) { e.preventDefault(); commit(drawingsRef.current.filter((d) => d.id !== selRef.current)); setSel(null); return; }
      if (e.altKey && KEYS[e.key.toLowerCase()]) { e.preventDefault(); setTool(KEYS[e.key.toLowerCase()]); return; }
      if (replayRef.current.mode === 'on') {
        if (e.key === ' ') { e.preventDefault(); setReplay((s) => ({ ...s, playing: !s.playing })); return; }
        if (e.key === 'ArrowRight' && e.shiftKey) { e.preventDefault(); setReplay((s) => ({ ...s, idx: Math.min(rows.length - 1, s.idx + 1), playing: false })); return; }
        if (e.key === 'ArrowLeft' && e.shiftKey) { e.preventDefault(); setReplay((s) => ({ ...s, idx: Math.max(0, s.idx - 1), playing: false })); return; }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (draft.current || toolRef.current !== 'cursor') setTool('cursor');
        else if (selRef.current) setSel(null);
        else if (replayRef.current.mode === 'pick') setReplay((s) => ({ ...s, mode: 'off' }));
        else if (document.fullscreenElement) document.exitFullscreen?.();
        else onClose();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- full screen, screenshot
  const [isFull, setIsFull] = useState(false);
  useEffect(() => { const h = () => setIsFull(!!document.fullscreenElement); document.addEventListener('fullscreenchange', h); return () => document.removeEventListener('fullscreenchange', h); }, []);
  const toggleFull = () => { if (document.fullscreenElement) document.exitFullscreen?.(); else stage.current?.closest('.studio')?.requestFullscreen?.().catch(() => {}); };
  const screenshot = () => {
    const a = api.current;
    if (!a.chart) return;
    const shot = a.chart.takeScreenshot();
    const ctx = shot.getContext('2d');
    if (overlay.current) ctx.drawImage(overlay.current, 0, 0, shot.width, shot.height);
    const link = document.createElement('a');
    link.download = `${sym}-${date}-${tf}.png`;
    link.href = shot.toDataURL('image/png');
    link.click();
  };

  const selected = drawings.find((d) => d.id === sel);
  const setSelected = (patch) => commit(drawings.map((d) => (d.id === sel ? { ...d, ...patch } : d)));
  const commitText = (text) => {
    const e = editing;
    setEditing(null);
    if (!e) return;
    if (e.fresh) { if (text.trim()) { commit([...drawingsRef.current, { ...e.fresh, text: text.trim() }]); setSel(e.fresh.id); } setTool('cursor'); return; }
    if (!text.trim()) commit(drawingsRef.current.filter((d) => d.id !== e.id));
    else commit(drawingsRef.current.map((d) => (d.id === e.id ? { ...d, text: text.trim() } : d)));
  };
  const setInd = (k, patch) => setStudio({ ind: { ...(studio.ind || {}), [k]: { ...ind[k], ...patch } } });

  return createPortal(
    <div className="studio" role="dialog" aria-label={`${sym} chart`}>
      <div className="studio-top">
        <div className="row gap6 studio-syms">
          {symbols.map(({ s, c }) => <button key={s} className={`chip ${s === sym ? 'on' : ''}`} onClick={() => { setSym(s); setReplay((r) => ({ ...r, mode: 'off', playing: false })); setSel(null); }}>{s} <span className="muted" style={{ marginLeft: 4 }}>{c}</span></button>)}
        </div>
        <span className="muted studio-date">{fmtDate(date)}</span>
        <div className="grow" />
        <Popover align="right" width={140} trigger={({ toggle, open }) => <button className={`btn sm ${open ? 'on' : ''}`} onClick={toggle} title="Timeframe">{ivSec(tf) < srcIv ? tfLabel(rec.interval) : tf} <ChevronDown size={12} /></button>}>
          {(close) => TIMEFRAMES.map((x) => <button key={x} className={`pop-item ${x === tf ? 'on' : ''}`} disabled={ivSec(x) < srcIv} onClick={() => { setStudio({ tf: x }); close(); }}><span className="grow">{x}</span>{x === tf && <Check size={13} className="accent" />}</button>)}
        </Popover>
        <Popover align="right" width={290} trigger={({ toggle, open }) => <button className={`btn sm ${open ? 'on' : ''}`} onClick={toggle}><Layers size={14} /> <span className="hide-m">Indicators</span></button>}>
          {() => (
            <div className="studio-inds">
              {IND_INFO.map(([k, name, color, param]) => (
                <label key={k} className="studio-ind">
                  <input type="checkbox" className="cbx" checked={ind[k].on} onChange={(e) => setInd(k, { on: e.target.checked })} />
                  {color && <i style={{ background: color }} />}
                  <span className="grow">{name}</span>
                  {param && <input type="number" className="input" min={2} max={400} value={ind[k].n} onChange={(e) => setInd(k, { n: Math.max(2, Math.min(400, Number(e.target.value) || DEFAULT_IND[k].n)) })} title="Length" />}
                </label>
              ))}
            </div>
          )}
        </Popover>
        <button className={`btn sm ${showExec ? 'on' : ''}`} onClick={() => setStudio({ exec: !showExec })} title="Show your executions"><Crosshair size={14} /> <span className="hide-m">Executions</span></button>
        {replay.mode === 'off'
          ? (
            <Popover align="right" width={240} trigger={({ toggle }) => <button className="btn sm" onClick={toggle} title="Replay the day bar by bar"><History size={14} /> <span className="hide-m">Replay</span></button>}>
              {(close) => (
                <>
                  <button className="pop-item" onClick={() => { startReplay('pick'); close(); }}>Select a start point on the chart</button>
                  {execTimes.length > 0 && <button className="pop-item" onClick={() => { startReplay('trade'); close(); }}>30 minutes before your first trade</button>}
                  <button className="pop-item" onClick={() => { startReplay('start'); close(); }}>From the first bar</button>
                </>
              )}
            </Popover>
          )
          : <button className="btn sm on" onClick={stopReplay}><History size={14} /> Exit replay</button>}
        <button className="icon-btn" onClick={() => api.current.fit?.()} title="Fit your executions"><Maximize2 size={15} /></button>
        <button className="icon-btn" onClick={screenshot} title="Save a picture of the chart"><Camera size={15} /></button>
        <button className="icon-btn" onClick={toggleFull} title={isFull ? 'Exit full screen' : 'Full screen'}>{isFull ? <Minimize size={15} /> : <Maximize size={15} />}</button>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)"><X size={16} /></button>
      </div>

      <div className="studio-main">
        <div className="studio-tools" role="toolbar" aria-label="Drawing tools">
          {TOOLS.map((group, gi) => (
            <div key={gi} className="studio-group">
              {group.map((t) => <button key={t.id} className={`studio-tool ${tool === t.id ? 'on' : ''}`} title={`${t.label}${t.key ? ` (${t.key})` : ''}`} aria-label={t.label} onClick={() => setTool(t.id)}><t.icon size={17} /></button>)}
            </div>
          ))}
          <div className="studio-group">
            <button className={`studio-tool ${magnet ? 'on' : ''}`} title="Magnet: snap to open / high / low / close (or hold Ctrl)" onClick={() => setStudio({ magnet: !magnet })}><Magnet size={17} /></button>
            <button className="studio-tool" title={hidden ? 'Show drawings' : 'Hide drawings'} onClick={() => setHidden((h) => !h)}>{hidden ? <EyeOff size={17} /> : <Eye size={17} />}</button>
            <button className="studio-tool" title="Undo (Ctrl+Z)" disabled={!history.current.length} onClick={undo}><Undo2 size={17} /></button>
            <button className="studio-tool" title={`Remove all ${root} drawings`} disabled={!drawings.length} onClick={() => { commit([]); setSel(null); }}><Trash2 size={17} /></button>
          </div>
        </div>

        <div ref={stage} className={`studio-stage ${tool !== 'cursor' || replay.mode === 'pick' ? 'drawing' : ''}`}>
          <div className="ec-legend studio-legend">
            <span className="ec-sym">{sym} · {ivSec(tf) < srcIv ? tfLabel(rec.interval) : tf}</span>
            <span ref={legend} />
          </div>
          <div className="studio-indlegend">
            {IND_INFO.filter(([k, , color]) => ind[k].on && color && !(k === 'vwap' && iv >= 86400)).map(([k, name, color]) => <span key={k}><i style={{ background: color }} />{name}{IND_INFO.find((x) => x[0] === k)[3] ? ` ${ind[k].n}` : ''}</span>)}
          </div>
          <div ref={box} className="studio-canvas" />
          <canvas ref={overlay} className="studio-overlay" />
          <div ref={tipRef} className="ec-tip" />
          {selected && (
            <div className="studio-edit" onPointerDown={(e) => e.stopPropagation()}>
              {SWATCHES.map((c) => <button key={c} className={`studio-sw ${selected.color === c ? 'on' : ''}`} style={{ background: c }} title="Colour" onClick={() => setSelected({ color: c })} />)}
              <span className="studio-sep" />
              {[1, 1.5, 2.5].map((w) => <button key={w} className={`studio-w ${(selected.width || 1.5) === w ? 'on' : ''}`} title={`Line ${w}px`} onClick={() => setSelected({ width: w })}><i style={{ height: w + 0.5 }} /></button>)}
              <span className="studio-sep" />
              <button className="icon-btn" title="Delete (Del)" onClick={() => { commit(drawings.filter((d) => d.id !== sel)); setSel(null); }}><Trash2 size={14} /></button>
            </div>
          )}
          {editing && (
            <input
              className="studio-text" autoFocus defaultValue={editing.text} placeholder="Type a note, Enter to save"
              style={{ left: Math.max(4, editing.x), top: Math.max(4, editing.y - 22) }}
              onKeyDown={(e) => { if (e.key === 'Enter') commitText(e.currentTarget.value); if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); if (editing.fresh) setTool('cursor'); } }}
              onBlur={(e) => commitText(e.currentTarget.value)}
            />
          )}
          {replay.mode === 'pick' && <div className="studio-hint">Click on the chart where the replay should start <button className="btn xs" onClick={() => setReplay((s) => ({ ...s, mode: 'off' }))}>Cancel</button></div>}
          {tool !== 'cursor' && !replay.mode.startsWith('p') && <div className="studio-hint subtle">{TOOL_BY_ID[tool].label}: {ONE_POINT.has(tool) ? 'click to place' : tool === 'brush' ? 'drag to draw' : 'drag, or click two points'} · Esc to cancel</div>}
          {rec.status === 'loading' && <div className="ec-msg muted">Loading {sym} candles…</div>}
          {rec.status === 'error' && (
            <div className="ec-msg">
              <div style={{ color: 'var(--fg)', fontWeight: 500 }}>Couldn’t load {sym} prices</div>
              <div className="muted" style={{ fontSize: 12.5, maxWidth: 360 }}>{rec.error}</div>
              <button className="btn" style={{ marginTop: 6 }} onClick={() => setNonce((n) => n + 1)}><RefreshCw size={14} /> Try again</button>
            </div>
          )}
          {rec.status === 'ok' && !rows.length && <div className="ec-msg muted">No {sym} prices for this day.</div>}
        </div>
      </div>

      {replay.mode === 'on' && (
        <div className="studio-replay">
          <div className="row gap4">
            <button className="icon-btn" title="Back to the start" onClick={() => stepTo(0)}><SkipBack size={15} /></button>
            <button className="icon-btn" title="One bar back (Shift+←)" onClick={() => stepTo(replay.idx - 1)}><StepBack size={15} /></button>
            <button className="btn sm white studio-play" title="Play / pause (Space)" onClick={() => setReplay((s) => ({ ...s, playing: !s.playing && s.idx < rows.length - 1 }))}>{replay.playing ? <Pause size={15} /> : <Play size={15} />}</button>
            <button className="icon-btn" title="One bar forward (Shift+→)" onClick={() => stepTo(replay.idx + 1)}><StepForward size={15} /></button>
            <button className="icon-btn" title="Jump to your next execution" disabled={!execTimes.some((t) => t > replayUntil)} onClick={nextExec}><SkipForward size={15} /></button>
          </div>
          <div className="row gap4 studio-speed">
            {SPEEDS.map((x) => <button key={x} className={`chip ${replay.speed === x ? 'on' : ''}`} onClick={() => setReplay((s) => ({ ...s, speed: x }))} title={`${x} bar${x === 1 ? '' : 's'} a second`}>{x}×</button>)}
          </div>
          <input className="studio-scrub" type="range" min={0} max={Math.max(0, rows.length - 1)} value={replay.idx} onChange={(e) => stepTo(Number(e.target.value))} aria-label="Replay position" />
          <div className="studio-clock">
            <b>{rows[replay.idx] ? fmtTime12(new Date(rows[replay.idx][0] * 1000).toISOString()) : ''}</b>
            {openPos && <span className="muted"> · in a {openPos.direction.toLowerCase()} {openPos.qty > 1 ? `×${openPos.qty} ` : ''}from {fmtP(openPos.entryPrice)}</span>}
            <span className="muted"> · {replayDone.length} closed </span>
            <span className={replayPnl >= 0 ? 'pos' : 'neg'}>{state.settings.privacy ? '•••' : fmtMoney(replayPnl, { sign: true })}</span>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

