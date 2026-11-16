// Price candles for the execution chart in the daily diary.
//   GET  /api/candles?symbol=MES&date=2026-11-09&tz=America/Los_Angeles
//        → { symbol, interval, source, candles: [[t, o, h, l, c, v], …] }   (t = unix seconds, UTC)
//   POST /api/candles/ingest  { symbol, bars: [[t, o, h, l, c, v], …], from?, to? }  ← platform add-ons (token unless from this PC)
//        from/to (unix seconds) = the range the add-on asked its platform for, so that range isn't asked for again
//   GET  /api/candles/wanted?source=ninjatrader[&format=lines]  ← add-ons: trade days still missing 1-minute bars
//        → { items: [{ symbol, contract, from, to }] }  or lines "symbol|contract|from|to" (newest day first)
//        MetaTrader and Sierra Chart can't make web requests: the same list is written to price-wanted.txt in their
//        drop folders, and they drop bars back as <name>.bars.jsonl (one ingest body per line).
//   GET  /api/candles/config  · POST /api/candles/config { yahoo, addon?, databentoKey?, polygonKey? }   (journal only)
//   GET  /api/candles/lib     → TradingView Lightweight Charts (downloaded once, then served from data/vendor)
//
// Where prices come from is up to you (Settings → Price data). In order:
//   1. bars your platform add-on sends — your own data feed, no extra service
//   2. Databento with your own API key (CME futures, 1-minute OHLCV)
//   3. Polygon with your own API key (stocks, crypto, forex)
//   4. Yahoo Finance — off by default: its feed is unofficial and not licensed for this, so only if you opt in
// Every candle set is saved in data/candles/ so a day only has to be fetched once.
import fs from 'node:fs';
import path from 'node:path';
import { metatraderDirs, journalDropDirs } from './connect-apis.js';

const LIB_VERSION = '5.0.7';
const LIB_URLS = [
  `https://cdn.jsdelivr.net/npm/lightweight-charts@${LIB_VERSION}/dist/lightweight-charts.standalone.production.js`,
  `https://unpkg.com/lightweight-charts@${LIB_VERSION}/dist/lightweight-charts.standalone.production.js`,
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const DAY = 86400;
// Coarser fallbacks and how far back Yahoo serves each one (days).
const INTERVALS = [['1m', 29], ['2m', 59], ['5m', 59], ['15m', 59], ['60m', 729]];

// Root symbols we know, longest first so "MES" wins over "ES".
const ROOTS = ['MBT', 'MET', 'MES', 'MNQ', 'MYM', 'M2K', 'MCL', 'MGC', 'SIL', 'M6E', 'M6B', 'M6A', 'RTY', 'BTC', 'ETH', 'ES', 'NQ', 'YM', 'CL', 'GC', 'SI', 'HG', 'NG', 'QM', 'QG', 'ZB', 'ZN', 'ZF', 'ZT', 'UB', 'PL', 'PA', 'HE', 'LE', 'ZC', 'ZS', 'ZW', '6E', '6J', '6B', '6A', '6C', '6S', '6N', '6M'];
export function rootOf(symbol) {
  const s = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return ROOTS.find((r) => s.startsWith(r)) || s.replace(/[FGHJKMNQUVXZ]\d{1,2}$/, '') || s;
}
const MICRO = { MES: 'ES', MNQ: 'NQ', MYM: 'YM', M2K: 'RTY', MCL: 'CL', MGC: 'GC', SIL: 'SI', QM: 'CL', QG: 'NG', M6E: '6E', M6B: '6B', M6A: '6A' };
const TWIN = { ...MICRO, ...Object.fromEntries(Object.entries(MICRO).filter(([k]) => k !== 'QM' && k !== 'QG').map(([m, f]) => [f, m])) };
export const yahooSymbol = (symbol) => `${rootOf(symbol)}=F`;

// ---------- time zones without a library ----------
function tzOffsetMs(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
/** Unix seconds for a wall-clock time in a time zone. */
function zoned(dateStr, h, m, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, m);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz); // settle across a DST change
  return Math.floor(t / 1000);
}
/** A diary day = the previous evening's open (3 PM) through the end of the calendar day, in your time zone. */
export function dayWindow(date, tz) {
  const prev = new Date(Date.UTC(...date.split('-').map((n, i) => (i === 1 ? n - 1 : +n))) - DAY * 1000).toISOString().slice(0, 10);
  return { from: zoned(prev, 15, 0, tz), to: zoned(date, 23, 59, tz) + 60 };
}
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

// ---------- Yahoo ----------
async function yahoo(ysym, interval, from, to) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?interval=${interval}&period1=${from}&period2=${to}&includePrePost=true&events=`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  const err = j?.chart?.error;
  if (!r.ok || err) throw new Error(err?.description || `Yahoo answered ${r.status}`);
  const res = j?.chart?.result?.[0];
  const ts = res?.timestamp || [];
  const q = res?.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if ([o, h, l, c].some((v) => v == null || !Number.isFinite(v))) continue;
    out.push([ts[i], o, h, l, c, q.volume?.[i] || 0]);
  }
  return out;
}

// ---------- Databento (CME Globex, continuous front month) ----------
async function databento(key, root, from, to) {
  const q = new URLSearchParams({ dataset: 'GLBX.MDP3', symbols: `${root}.c.0`, stype_in: 'continuous', schema: 'ohlcv-1m', start: new Date(from * 1000).toISOString(), end: new Date(to * 1000).toISOString(), encoding: 'csv', pretty_px: 'true', pretty_ts: 'true', map_symbols: 'true' });
  const r = await fetch(`https://hist.databento.com/v0/timeseries.get_range?${q}`, { headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` }, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  if (!r.ok) { let msg = text; try { msg = JSON.parse(text).detail || msg; } catch { /* text */ } throw new Error(`Databento: ${String(msg).slice(0, 200)}`); }
  const lines = text.trim().split(/\r?\n/);
  const head = (lines.shift() || '').split(',');
  const col = (n) => head.indexOf(n);
  const [it, io, ih, il, ic, iv] = ['ts_event', 'open', 'high', 'low', 'close', 'volume'].map(col);
  if (it < 0 || ic < 0) throw new Error('Databento: unexpected response');
  return lines.map((l) => l.split(',')).map((c) => [Math.floor(Date.parse(c[it]) / 1000), +c[io], +c[ih], +c[il], +c[ic], +c[iv] || 0]).filter((b) => Number.isFinite(b[0]) && Number.isFinite(b[4]));
}

// ---------- Polygon (stocks, crypto, forex) ----------
export function polygonTicker(symbol) {
  const raw = String(symbol || '').toUpperCase();
  if (/-PERP$/.test(raw)) return `X:${raw.replace(/-PERP$/, '').replace(/^\d+/, '')}USD`;
  const s = raw.replace(/-(SPOT|SWAP)$/, '').replace(/-USDT?-SWAP$/, '');
  const crypto = s.match(/^([A-Z0-9]{2,10}?)[-/]?(USDT|USDC|USD)$/);
  if (crypto) return `X:${crypto[1]}USD`;
  const fx = s.replace('_', '').match(/^(EUR|GBP|AUD|NZD|USD|CAD|CHF|JPY)(EUR|GBP|AUD|NZD|USD|CAD|CHF|JPY)$/);
  if (fx) return `C:${fx[1]}${fx[2]}`;
  return /^[A-Z.]{1,6}$/.test(s) ? s : null;
}
async function polygon(key, ticker, from, to) {
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${from * 1000}/${to * 1000}?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(key)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error(`Polygon: ${j?.error || j?.message || r.status}`);
  return (j.results || []).map((b) => [Math.floor(b.t / 1000), b.o, b.h, b.l, b.c, b.v || 0]);
}

const isFutures = (symbol) => !/(-PERP|-SPOT|-SWAP|USDT|USDC|\/|:)/i.test(String(symbol)) && (ROOTS.includes(rootOf(symbol)) || /^[A-Z0-9]{1,4}[FGHJKMNQUVXZ]\d{1,2}$/.test(String(symbol).toUpperCase()));

export function createCandleHandler(dataDir, { readTrades, readConnTrades, log = () => {}, vault, tokenOk, dropDirs } = {}) {
  const cacheDir = path.join(dataDir, 'candles');
  const barsDir = path.join(dataDir, 'bars');
  const cfgFile = path.join(dataDir, 'price-source.json');
  const readCfg = () => {
    try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* first run */ }
    // journals that already used the Yahoo charts keep them; new ones start with Yahoo off
    return { yahoo: fs.existsSync(cacheDir), decided: false };
  };
  let cfg = readCfg();
  const keyOf = (name) => vault?.get(`price:${name}`) || null;

  // ---------- bars from platform add-ons: data/bars/<ROOT>/<UTC date>.json  { "<t>": [t,o,h,l,c,v] } ----------
  const barFile = (root, t) => path.join(barsDir, root.replace(/[^\w.-]/g, '_'), `${new Date(t * 1000).toISOString().slice(0, 10)}.json`);
  function storeBars(symbol, bars) {
    const root = rootOf(symbol);
    const byFile = new Map();
    for (const b of bars) {
      const t = Math.floor(Number(Array.isArray(b) ? b[0] : (b.time ?? b.t)));
      const row = Array.isArray(b) ? b.slice(0, 6).map(Number) : [t, +b.open, +b.high, +b.low, +b.close, +(b.volume || 0)];
      row[0] = t > 1e12 ? Math.floor(t / 1000) : t;
      if (!Number.isFinite(row[0]) || row.slice(1, 5).some((v) => !Number.isFinite(v))) continue;
      const f = barFile(root, row[0]);
      (byFile.get(f) || byFile.set(f, []).get(f)).push(row);
    }
    let n = 0;
    for (const [f, rows] of byFile) {
      const cur = readCache(f) || {};
      for (const r of rows) { cur[r[0]] = r; n++; }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(cur));
    }
    return n;
  }
  function addonBars(symbol, from, to) {
    const out = [];
    // a micro trades at the same price as its full-size contract, so either chart's bars will do (MES ↔ ES …)
    for (const root of [rootOf(symbol), ...(TWIN[rootOf(symbol)] ? [TWIN[rootOf(symbol)]] : [])]) {
      for (let t = from - (from % DAY); t <= to; t += DAY) {
        const cur = readCache(barFile(root, t));
        if (cur) for (const r of Object.values(cur)) if (r[0] >= from && r[0] < to) out.push(r);
      }
      if (out.length) break;
    }
    out.sort((a, b) => a[0] - b[0]);
    // bar size from the data (an add-on on a 1-minute chart sends 1-minute bars)
    const step = out.length > 2 ? Math.min(...out.slice(1, 50).map((r, i) => r[0] - out[i][0]).filter((d) => d > 0)) : 60;
    return { candles: out, interval: step >= 3600 ? `${Math.round(step / 3600)}h` : `${Math.max(1, Math.round(step / 60))}m` };
  }

  // ---------- which trade days the add-ons should still fetch bars for ----------
  // price-covered.json: { "<ROOT>": [[from, to], …] } — time ranges (unix seconds) add-ons already sent bars for. A range
  // an add-on asked its platform for counts even when the platform had nothing, so it isn't asked for again.
  const coverFile = path.join(dataDir, 'price-covered.json');
  let covered = {};
  try { covered = JSON.parse(fs.readFileSync(coverFile, 'utf8')) || {}; } catch { /* first run */ }
  const WANT_DAYS = 45;
  const localDate = (unix, tz) => new Date(unix * 1000).toLocaleDateString('en-CA', { timeZone: tz });
  function markCovered(symbol, from, to) {
    from = Math.floor(Number(from)); to = Math.floor(Number(to));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    const root = rootOf(symbol);
    const cut = Math.floor(Date.now() / 1000) - (WANT_DAYS + 5) * DAY; // forget what nobody will ask about again
    const list = [...(covered[root] || []), [from, to]].filter((r) => r[1] > cut).sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const r of list) { const last = merged[merged.length - 1]; if (last && r[0] <= last[1] + 60) last[1] = Math.max(last[1], r[1]); else merged.push([r[0], r[1]]); }
    covered[root] = merged;
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(coverFile, JSON.stringify(covered)); } catch (e) { log('[candles] could not save price-covered.json', e.message); }
    wantCache.clear();
  }
  /** How far the covered ranges reach from `from` on (0 = nothing covered at `from`). */
  const coveredTo = (root, from) => (covered[root] || []).find((r) => r[0] <= from + 60 && r[1] > from)?.[1] || 0;
  const wantCache = new Map();
  /** Trade days (newest first) whose 1-minute bars an add-on for `source` should fetch from its platform. */
  function wanted(source, { tz = Intl.DateTimeFormat().resolvedOptions().timeZone, now = Math.floor(Date.now() / 1000), limit = 20 } = {}) {
    if (cfg.addon === false) return []; // add-on price data switched off: nothing to fetch
    const ck = `${source}|${tz}`;
    const hit = wantCache.get(ck);
    if (hit && now - hit.at < 20) return hit.items;
    const since = new Date((now - WANT_DAYS * DAY) * 1000).toLocaleDateString('en-CA', { timeZone: tz });
    const days = new Map(); // ROOT|date → { symbol, contract }
    const add = (t, date) => {
      if (!t?.symbol || !t.contract || String(t.source || '').toLowerCase() !== source || date < since) return;
      const key = `${rootOf(t.symbol)}|${date}`;
      if (!days.has(key)) days.set(key, { symbol: t.symbol, contract: String(t.contract), date });
    };
    try { for (const t of (readTrades?.() || [])) if (t?.entry && !t.deleted) add(t, String(t.entry).slice(0, 10)); } catch { /* journal not readable yet */ }
    try { for (const t of (readConnTrades?.() || [])) { const e = Date.parse(t?.entry); if (Number.isFinite(e)) add(t, localDate(Math.floor(e / 1000), tz)); } } catch { /* inbox not ready */ }
    const items = [];
    for (const [key, d] of [...days].sort((a, b) => (a[1].date < b[1].date ? 1 : -1))) {
      const { from, to } = dayWindow(d.date, tz);
      if (from > now) continue;
      const end = Math.min(to, now);
      const have = coveredTo(rootOf(d.symbol), from);
      if (have >= end - (end === now ? 90 : 0)) continue;              // today: refreshed every ~minute and a half
      if (!have) {                                                      // another add-on (ATAS on a chart) may have sent them
        const ab = addonBars(d.symbol, from, end);
        if (ab.interval === '1m' && ab.candles.length >= 200 && ab.candles[ab.candles.length - 1][0] >= end - 300) continue;
      }
      items.push({ symbol: d.symbol, contract: d.contract, from: have > from ? Math.max(from, have - 600) : from, to: end });
      if (items.length >= limit) break;
    }
    wantCache.set(ck, { at: now, items });
    return items;
  }
  const wantedLines = (items) => items.map((i) => [i.symbol, i.contract, i.from, i.to].map((v) => String(v).replace(/[|\r\n]/g, ' ')).join('|')).join('\n') + (items.length ? '\n' : '');
  // MetaTrader / Sierra Chart: the list goes into their drop folders as price-wanted.txt
  const wantedFiles = dropDirs || (() => [...metatraderDirs().map((d) => [d, 'metatrader']), ...journalDropDirs().map((d) => [d, 'sierrachart'])]);
  const lastWritten = new Map();
  function writeWantedFiles() {
    for (const [dir, source] of wantedFiles()) {
      if (!fs.existsSync(dir)) continue; // that platform's add-on isn't installed on this computer
      const text = wantedLines(wanted(source)).replace(/\n/g, '\r\n'); // Windows line ends: MetaTrader reads lines
      const file = path.join(dir, 'price-wanted.txt');
      if (lastWritten.get(file) === text && fs.existsSync(file)) continue;
      try { fs.writeFileSync(file, text); lastWritten.set(file, text); } catch (e) { log(`[candles] could not write ${file}: ${e.message}`); }
    }
  }
  if (!dropDirs) { setTimeout(writeWantedFiles, 15000).unref?.(); setInterval(writeWantedFiles, 60000).unref?.(); }
  /** One add-on bars message (web request or a line of a .bars.jsonl file). */
  function ingestBars(body) {
    const groups = Array.isArray(body?.series) ? body.series : [body];
    let n = 0;
    for (const g of groups) {
      if (!g?.symbol) continue;
      if (Array.isArray(g.bars)) n += storeBars(g.symbol, g.bars);
      if (g.from !== undefined && g.to !== undefined) markCovered(g.symbol, g.from, g.to);
    }
    return n;
  }
  const libFile = path.join(dataDir, 'vendor', `lightweight-charts-${LIB_VERSION}.js`);
  const inflight = new Map();

  const cachePath = (ysym, date) => path.join(cacheDir, ysym.replace(/[^\w=.-]/g, '_'), `${date}.json`);
  const readCache = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

  /** Candles for one symbol and diary day, from the cache when it's final. */
  async function get(symbol, date, tz, { force } = {}) {
    const ysym = yahooSymbol(symbol);
    const file = cachePath(ysym, date);
    const { from, to } = dayWindow(date, tz);
    const now = Math.floor(Date.now() / 1000);
    const ageDays = (now - to) / DAY;
    // saved Yahoo data is only shown while Yahoo is switched on (older saved days have no source: they're Yahoo too)
    const saved = readCache(file);
    const cached = saved && (cfg.yahoo || (saved.source && !saved.source.startsWith('Yahoo'))) ? saved : null;
    const best = INTERVALS.find(([, max]) => (now - from) / DAY <= max)?.[0] || '60m';
    if (cached && !force) {
      const better = cached.interval !== best && cached.interval !== '1m'; // a finer interval is still available
      if (cached.final && !better) return cached;
      if (!cached.final && now - cached.fetchedAt < 45) return cached; // today: refresh at most every 45s
    }
    const key = file;
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      let lastErr;
      const end = Math.min(to, now);
      const save = (rec) => { if (rec.candles.length) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(rec)); } return rec; };
      // 1. your platform add-on's bars
      const ab = cfg.addon === false ? { candles: [] } : addonBars(symbol, from, end); // switched off in Settings → Price data
      const addonRec = ab.candles.length >= 5 ? { symbol: rootOf(symbol), ysym, date, tz, from, to, interval: ab.interval, source: 'Your platform (add-on)', fetchedAt: now, final: false, candles: ab.candles } : null;
      if (addonRec && ab.interval === '1m') return addonRec; // coarser add-on bars are used if nothing better is set up
      // 2. Databento (futures)
      const dbKey = keyOf('databento');
      if (dbKey && isFutures(symbol)) {
        try {
          const candles = await databento(dbKey, rootOf(symbol), from, end);
          if (candles.length) return save({ symbol: rootOf(symbol), ysym, date, tz, from, to, interval: '1m', source: 'Databento (CME, front month)', fetchedAt: now, final: ageDays > 0.05, candles });
        } catch (e) { lastErr = e; }
      }
      // 3. Polygon (stocks, crypto, forex)
      const pgKey = keyOf('polygon');
      const pt = polygonTicker(symbol);
      if (pgKey && pt && !isFutures(symbol)) {
        try {
          const candles = await polygon(pgKey, pt, from, end);
          if (candles.length) return save({ symbol: rootOf(symbol), ysym: pt, date, tz, from, to, interval: '1m', source: 'Polygon', fetchedAt: now, final: ageDays > 0.05, candles });
        } catch (e) { lastErr = e; }
      }
      // 4. Yahoo, only if you turned it on
      if (!cfg.yahoo) {
        if (addonRec) return addonRec;
        if (cached) return { ...cached, stale: true };
        throw lastErr || Object.assign(new Error('No price source is set up for charts yet — choose one in Settings → Price data.'), { code: 'NO_SOURCE' });
      }
      for (const [interval, max] of INTERVALS) {
        if ((now - from) / DAY > max) continue;
        try {
          const candles = await yahoo(ysym, interval, from, Math.min(to, now));
          if (!candles.length && interval !== '60m') { lastErr = new Error('No candles for that day'); continue; }
          const rec = { symbol: rootOf(symbol), ysym, date, tz, from, to, interval, source: 'Yahoo Finance (continuous contract)', fetchedAt: now, final: ageDays > 0.05, candles };
          if (candles.length) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(rec)); }
          return rec;
        } catch (e) { lastErr = e; }
      }
      if (addonRec) return addonRec;
      if (cached) return { ...cached, stale: true };
      throw lastErr || new Error('No price data for that day');
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  async function lib() {
    if (fs.existsSync(libFile)) return fs.readFileSync(libFile);
    for (const u of LIB_URLS) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 50000) continue;
        fs.mkdirSync(path.dirname(libFile), { recursive: true });
        fs.writeFileSync(libFile, buf);
        return buf;
      } catch { /* next */ }
    }
    throw new Error('Couldn’t download the chart library (no internet?)');
  }

  // ---------- keep 1-minute data for every trade day before Yahoo drops it ----------
  async function backfill() {
    if (!readTrades || !cfg.yahoo) return; // only Yahoo forgets 1-minute data after ~30 days
    let trades;
    try { trades = readTrades() || []; } catch { return; }
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = Date.now() / 1000;
    const want = new Set();
    for (const t of trades) {
      if (!t?.entry || !t.symbol) continue;
      const date = String(t.entry).slice(0, 10);
      const { from } = dayWindow(date, tz);
      if ((now - from) / DAY > 28.5) continue;
      want.add(`${yahooSymbol(t.symbol)}|${t.symbol}|${date}`);
    }
    let n = 0;
    for (const k of want) {
      const [ysym, symbol, date] = k.split('|');
      const c = readCache(cachePath(ysym, date));
      if (c?.final && c.interval === '1m') continue;
      try { await get(symbol, date, tz); n++; } catch { /* try again next round */ }
      await new Promise((r) => setTimeout(r, 1500)); // be gentle with Yahoo
    }
    if (n) log(`[candles] saved 1-minute data for ${n} trading day${n === 1 ? '' : 's'}`);
  }
  setTimeout(backfill, 20000).unref?.();
  setInterval(backfill, 6 * 3600 * 1000).unref?.();

  const send = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };

  const handler = async function candles(req, res) {
    const u = new URL(req.originalUrl || req.url, 'http://x');
    try {
      if (u.pathname === '/api/candles/ingest' && req.method === 'POST') {
        if (tokenOk && !tokenOk(req)) return send(res, 401, { error: 'Missing or wrong token (Connections → Webhook / API).' });
        const body = await new Promise((resolve, reject) => { let t = ''; req.setEncoding('utf8'); req.on('data', (c) => { t += c; if (t.length > 20e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(t || '{}')); } catch (e) { reject(e); } }); req.on('error', reject); });
        return send(res, 200, { ok: true, bars: ingestBars(body) });
      }
      if (u.pathname === '/api/candles/wanted' && req.method === 'GET') {
        if (tokenOk && !tokenOk(req)) return send(res, 401, { error: 'Missing or wrong token (Connections → Webhook / API).' });
        const source = String(u.searchParams.get('source') || '').toLowerCase();
        if (!/^[a-z0-9_-]{2,32}$/.test(source)) return send(res, 400, { error: 'source needed, e.g. ?source=ninjatrader' });
        const items = wanted(source);
        if (u.searchParams.get('format') === 'lines') { res.statusCode = 200; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); return res.end(wantedLines(items)); }
        return send(res, 200, { items });
      }
      if (u.pathname === '/api/candles/config') {
        if (req.method === 'POST') {
          const b = await new Promise((resolve, reject) => { let t = ''; req.setEncoding('utf8'); req.on('data', (c) => { t += c; }); req.on('end', () => { try { resolve(JSON.parse(t || '{}')); } catch (e) { reject(e); } }); req.on('error', reject); });
          cfg = { ...cfg, yahoo: !!b.yahoo, decided: true, ...(typeof b.addon === 'boolean' ? { addon: b.addon } : {}) };
          wantCache.clear();
          for (const k of ['databento', 'polygon']) if (typeof b[`${k}Key`] === 'string' && b[`${k}Key`] !== '••••••••') vault?.set(`price:${k}`, b[`${k}Key`].trim());
          fs.mkdirSync(dataDir, { recursive: true });
          fs.writeFileSync(cfgFile, JSON.stringify(cfg));
        }
        const rootsWithBars = (() => { try { return fs.readdirSync(barsDir); } catch { return []; } })();
        return send(res, 200, { yahoo: !!cfg.yahoo, addon: cfg.addon !== false, decided: !!cfg.decided, databento: !!keyOf('databento'), polygon: !!keyOf('polygon'), addonSymbols: rootsWithBars, vault: !!vault });
      }
      if (u.pathname === '/api/candles/lib') {
        const buf = await lib();
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=604800');
        return res.end(buf);
      }
      const symbol = u.searchParams.get('symbol');
      const date = u.searchParams.get('date');
      const tz = u.searchParams.get('tz') || Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !validTz(tz)) return send(res, 400, { error: 'symbol, date (YYYY-MM-DD) and tz are needed' });
      const rec = await get(symbol, date, tz, { force: u.searchParams.get('refresh') === '1' });
      return send(res, 200, rec);
    } catch (e) {
      return send(res, e.code === 'NO_SOURCE' ? 424 : 502, { error: e.message || 'Couldn’t load prices', code: e.code });
    }
  };
  handler.ingestBars = ingestBars;
  handler.wanted = wanted;
  handler.writeWantedFiles = writeWantedFiles;
  return handler;
}
