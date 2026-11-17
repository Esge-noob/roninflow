// Price candles for the execution chart in the daily diary.
//   GET  /api/candles?symbol=MES&date=2026-11-09&tz=America/Los_Angeles
//        → { symbol, interval, source, candles: [[t, o, h, l, c, v], …] }   (t = unix seconds, UTC)
//   POST /api/candles/ingest  { symbol, bars: [[t, o, h, l, c, v], …], from?, to? }  ← platform add-ons (token unless from this PC)
//        from/to (unix seconds) = the range the add-on asked its platform for, so that range isn't asked for again
//   GET  /api/candles/wanted?source=ninjatrader[&format=lines]  ← add-ons: trade days still missing 1-minute bars
//        → { items: [{ symbol, contract, from, to }] }  or lines "symbol|contract|from|to" (newest day first)
//        MetaTrader and Sierra Chart can't make web requests: the same list is written to price-wanted.txt in their
//        drop folders, and they drop bars back as <name>.bars.jsonl (one ingest body per line).
//   GET  /api/candles?…&want=1 (a backtest) also asks the add-ons for that day when no 1-minute bars are saved for it:
//        it goes to the top of /api/candles/wanted for an hour or until an add-on answers (price-requested.json).
//   GET  /api/candles/config  · POST /api/candles/config { yahoo, addon?, addonSource?, useDatabento?, usePolygon?, databentoKey?, polygonKey? }
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
import zlib from 'node:zlib';
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

// Which contract month is the front (most traded) one on a date, by the exchange's usual roll:
//   equity index (ES, NQ, YM, RTY + micros): Mar / Jun / Sep / Dec, rolled 8 days before the 3rd Friday
//   crude / natural gas: every month, rolled around the 19th (crude) / 24th (gas) of the month before delivery
//   gold: Feb / Apr / Jun / Aug / Oct / Dec · silver & copper: Mar / May / Jul / Sep / Dec — rolled around the 25th
//   of the month before. Treasuries: Mar / Jun / Sep / Dec, rolled at the end of the month before.
// Anything else isn't worked out (the contract you last traded is used for ~25 days either side).
const ROLL = {
  quarterlyIndex: { months: [3, 6, 9, 12], roll: (y, m) => { const first = new Date(Date.UTC(y, m - 1, 1)); return new Date(Date.UTC(y, m - 1, 1 + ((5 - first.getUTCDay() + 7) % 7) + 14 - 8)); } },
  crude: { months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], roll: (y, m) => new Date(Date.UTC(y, m - 2, 19)) },
  gas: { months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], roll: (y, m) => new Date(Date.UTC(y, m - 2, 24)) },
  gold: { months: [2, 4, 6, 8, 10, 12], roll: (y, m) => new Date(Date.UTC(y, m - 2, 25)) },
  silver: { months: [3, 5, 7, 9, 12], roll: (y, m) => new Date(Date.UTC(y, m - 2, 25)) },
  bonds: { months: [3, 6, 9, 12], roll: (y, m) => new Date(Date.UTC(y, m - 1, 0)) },
};
const ROLL_OF = {
  ES: 'quarterlyIndex', MES: 'quarterlyIndex', NQ: 'quarterlyIndex', MNQ: 'quarterlyIndex', YM: 'quarterlyIndex', MYM: 'quarterlyIndex', RTY: 'quarterlyIndex', M2K: 'quarterlyIndex',
  CL: 'crude', MCL: 'crude', QM: 'crude', NG: 'gas', QG: 'gas', GC: 'gold', MGC: 'gold', SI: 'silver', SIL: 'silver', HG: 'silver',
  ZB: 'bonds', ZN: 'bonds', ZF: 'bonds', ZT: 'bonds', UB: 'bonds',
};
const MONTH_CODES = 'FGHJKMNQUVXZ';
const p2 = (n) => String(n).padStart(2, '0');
/** { y, m } of the front contract on `date` (YYYY-MM-DD), or null when the root's roll isn't known. */
export function frontMonth(root, date) {
  const rule = ROLL[ROLL_OF[root]];
  if (!rule) return null;
  let [y, m] = date.split('-').map(Number);
  for (let k = 0; k < 30; k++) {
    if (rule.months.includes(m) && date < rule.roll(y, m).toISOString().slice(0, 10)) return { y, m };
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return null;
}
export const frontQuarter = (date) => frontMonth('ES', date);
/** { y, m } of a contract name: "MESZ6", "MESZ26", "MES Z26", "MES 12-26", "MESZ2026", "MESZ6@CME"… (null if unknown). */
export function contractMonth(root, name) {
  const u = String(name || '').toUpperCase().trim();
  const rest = u.startsWith(root) ? u.slice(root.length).trim() : u;
  const near = (yy, digits) => { const now = new Date().getUTCFullYear(); if (digits >= 4) return yy; const base = digits === 1 ? 10 : 100; let y = now - (now % base) + yy; if (y > now + 5) y -= base; if (y < now - base + 5) y += base; return y; };
  let m = rest.match(/^(\d{1,2})[-/](\d{2,4})/);
  if (m) return { m: Number(m[1]), y: near(Number(m[2]), m[2].length) };
  m = rest.match(/^([FGHJKMNQUVXZ])\s?(\d{1,4})/);
  if (m) return { m: MONTH_CODES.indexOf(m[1]) + 1, y: near(Number(m[2]), m[2].length) };
  return null;
}
/** `contract` (as your platform names it, last traded on `seen`) moved to the contract that was front month on `date`.
 *  Returns null when that can't be worked out and `date` is more than ~25 days from `seen`. */
export function contractFor(contract, root, date, seen = date) {
  const near = Math.abs(Date.parse(date) - Date.parse(seen)) <= 25 * 86400e3 ? contract : null;
  const f = frontMonth(root, date);
  if (!f) return near;
  const { y, m } = f;
  const ntRe = new RegExp(`^(${root}\\s+)\\d{2}-\\d{2}(.*)$`); // "MNQ 12-25" (NinjaTrader)
  if (ntRe.test(contract)) return contract.replace(ntRe, (_, a, rest) => `${a}${p2(m)}-${p2(y % 100)}${rest}`);
  const cmeRe = new RegExp(`^(${root})[FGHJKMNQUVXZ](\\d{1,4})(.*)$`); // "MNQZ25", "MNQZ5", "MNQZ25.CME"…
  if (cmeRe.test(contract)) return contract.replace(cmeRe, (_, a, yy, rest) => `${a}${MONTH_CODES[m - 1]}${yy.length === 1 ? y % 10 : yy.length === 2 ? p2(y % 100) : y}${rest}`);
  return near;
}

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

  // ---------- bars from platform add-ons: data/bars/<platform>/<ROOT>/<UTC date>.json  { "<t>": [t,o,h,l,c,v] } ----------
  // Bars saved before they were kept per platform are in data/bars/_earlier/<ROOT>; they back up whichever platform is used.
  const EARLIER = '_earlier';
  const srcId = (s) => String(s || 'other').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'other';
  (function moveEarlier() {
    let names;
    try { names = fs.readdirSync(barsDir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (!e.isDirectory() || e.name === EARLIER || e.name === e.name.toLowerCase()) continue; // platform folders are lower case, roots aren't
      try { fs.mkdirSync(path.join(barsDir, EARLIER), { recursive: true }); fs.renameSync(path.join(barsDir, e.name), path.join(barsDir, EARLIER, e.name)); } catch (err) { log('[candles] could not move saved bars', e.name, err.message); }
    }
  })();
  const barFile = (source, root, t) => path.join(barsDir, source, root.replace(/[^\w.-]/g, '_'), `${new Date(t * 1000).toISOString().slice(0, 10)}.json`);
  function storeBars(symbol, bars, source) {
    const root = rootOf(symbol);
    const src = srcId(source);
    const byFile = new Map();
    for (const b of bars) {
      const t = Math.floor(Number(Array.isArray(b) ? b[0] : (b.time ?? b.t)));
      const row = Array.isArray(b) ? b.slice(0, 6).map(Number) : [t, +b.open, +b.high, +b.low, +b.close, +(b.volume || 0)];
      row[0] = t > 1e12 ? Math.floor(t / 1000) : t;
      if (!Number.isFinite(row[0]) || row.slice(1, 5).some((v) => !Number.isFinite(v))) continue;
      const f = barFile(src, root, row[0]);
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
  const listDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
  /** Platforms that have sent bars, with how many symbols each. */
  const addonSources = () => listDir(barsDir).filter((n) => n !== EARLIER && !n.endsWith('-roll') && !n.startsWith('h_')).map((id) => ({ id, symbols: listDir(path.join(barsDir, id)).length }));
  function barsFrom(source, symbol, from, to) {
    const out = [];
    // a micro trades at the same price as its full-size contract, so either chart's bars will do (MES ↔ ES …)
    for (const root of [rootOf(symbol), ...(TWIN[rootOf(symbol)] ? [TWIN[rootOf(symbol)]] : [])]) {
      for (let t = from - (from % DAY); t <= to; t += DAY) {
        const cur = readCache(barFile(source, root, t));
        if (cur) for (const r of Object.values(cur)) if (r[0] >= from && r[0] < to) out.push(r);
      }
      if (out.length) break;
    }
    return out;
  }
  /** Bars from the platform chosen in Settings → Price data ("any" = the platform with the most for that day). */
  function addonBars(symbol, from, to) {
    const pick = cfg.addonSource && cfg.addonSource !== 'any' ? cfg.addonSource : null;
    let out = [];
    for (const src of pick ? [pick] : addonSources().map((x) => x.id)) {
      const got = barsFrom(src, symbol, from, to);
      if (got.length > out.length) out = got;
    }
    if (out.length < 5) { const old = barsFrom(EARLIER, symbol, from, to); if (old.length > out.length) out = old; }
    if (out.length < 5) { for (const c of histContracts(rootOf(symbol))) { const got = barsFrom(c.dir, symbol, from, to); if (got.length > out.length) out = got; } } // downloaded history (backtests)
    out.sort((a, b) => a[0] - b[0]);
    // bar size from the data (an add-on on a 1-minute chart sends 1-minute bars)
    const step = out.length > 2 ? Math.min(...out.slice(1, 50).map((r, i) => r[0] - out[i][0]).filter((d) => d > 0)) : 60;
    return { candles: out, interval: step >= 3600 ? `${Math.round(step / 3600)}h` : `${Math.max(1, Math.round(step / 60))}m` };
  }

  // ---------- which trade days the add-ons should still fetch bars for ----------
  // price-covered.json: { "<platform>|<ROOT>": [[from, to], …] } — time ranges (unix seconds) add-ons already sent bars for. A range
  // an add-on asked its platform for counts even when the platform had nothing, so it isn't asked for again.
  const coverFile = path.join(dataDir, 'price-covered.json');
  let covered = {};
  try { covered = JSON.parse(fs.readFileSync(coverFile, 'utf8')) || {}; } catch { /* first run */ }
  const WANT_DAYS = 45;
  const localDate = (unix, tz) => new Date(unix * 1000).toLocaleDateString('en-CA', { timeZone: tz });
  for (const k of Object.keys(covered)) if (!k.includes('|')) delete covered[k]; // from before bars were kept per platform
  function markCovered(source, symbol, from, to) {
    from = Math.floor(Number(from)); to = Math.floor(Number(to));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    const root = `${srcId(source)}|${rootOf(symbol)}`;
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
    if (cfg.addonSource && cfg.addonSource !== 'any' && cfg.addonSource !== source) return []; // bars come from another platform
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
    const items = requestedItems(source, now); // a backtest is waiting on these
    for (const [key, d] of [...days].sort((a, b) => (a[1].date < b[1].date ? 1 : -1))) {
      const { from, to } = dayWindow(d.date, tz);
      if (from > now) continue;
      const end = Math.min(to, now);
      const have = coveredTo(`${source}|${rootOf(d.symbol)}`, from);
      if (have >= end - (end === now ? 90 : 0)) continue;              // today: refreshed every ~minute and a half
      if (!have) {                                                      // another add-on (ATAS on a chart) may have sent them
        const ab = addonBars(d.symbol, from, end);
        if (ab.interval === '1m' && ab.candles.length >= 200 && ab.candles[ab.candles.length - 1][0] >= end - 300) continue;
      }
      items.push({ symbol: d.symbol, contract: d.contract, from: have > from ? Math.max(from, have - 600) : from, to: end });
      if (items.length >= limit) break;
    }
    if (items.length < limit) items.push(...historyItems(source, now).slice(0, limit - items.length)); // history downloads come last
    wantCache.set(ck, { at: now, items });
    return items;
  }
  // ---------- days a backtest asked for (any date, not just days you traded) ----------
  const reqFile = path.join(dataDir, 'price-requested.json');
  let requested = {};
  try { requested = JSON.parse(fs.readFileSync(reqFile, 'utf8')) || {}; } catch { /* none yet */ }
  const saveRequested = () => { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(reqFile, JSON.stringify(requested)); } catch (e) { log('[candles] could not save price-requested.json', e.message); } };
  function requestDay(symbol, date, tz) {
    const key = `${rootOf(symbol)}|${date}`;
    if (requested[key] && Date.now() - requested[key].at < 10 * 60e3) return;
    requested[key] = { symbol: rootOf(symbol), date, tz, at: Date.now() };
    saveRequested();
    wantCache.clear();
    if (!dropDirs) setTimeout(writeWantedFiles, 500).unref?.();
  }
  /** The contract an add-on should ask its platform for on `date`, from the newest contract of that root it has traded. */
  function contractOn(source, root, date) {
    let best = null;
    const see = (t, d) => { if (t?.contract && rootOf(t.symbol || t.contract) === root && String(t.source || '').toLowerCase() === source && (!best || d > best.d)) best = { c: String(t.contract), d }; };
    try { for (const t of (readTrades?.() || [])) if (t?.entry) see(t, String(t.entry).slice(0, 10)); } catch { /* */ }
    try { for (const t of (readConnTrades?.() || [])) if (t?.entry) see(t, String(t.entry).slice(0, 10)); } catch { /* */ }
    if (!best) return null;
    return contractFor(best.c, root, date, best.d);
  }
  function requestedItems(source, now) {
    const out = [];
    let changed = false;
    for (const [key, r] of Object.entries(requested)) {
      if (Date.now() - r.at > 3600e3) { delete requested[key]; changed = true; continue; }
      const contract = contractOn(source, r.symbol, r.date);
      if (!contract) continue;
      const { from, to } = dayWindow(r.date, validTz(r.tz) ? r.tz : Intl.DateTimeFormat().resolvedOptions().timeZone);
      if (from > now) continue;
      const end = Math.min(to, now);
      if (coveredTo(`${source}|${r.symbol}`, from) >= end) continue;
      out.push({ symbol: r.symbol, contract, from, to: end });
    }
    if (changed) saveRequested();
    return out;
  }
  // ---------- history downloads (automated backtests): as far back as your platform's data goes ----------
  // One job per market. Weeks are asked for newest first through the wanted list (the add-ons' usual loop); each week
  // uses the contract that was front month then. On a roll day the old contract's bars are fetched too, so the
  // continuous series can be back-adjusted. Four empty weeks in a row = the start of your platform's history.
  const jobsFile = path.join(dataDir, 'history-jobs.json');
  let jobs = {};
  try { jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8')) || {}; } catch { /* none yet */ }
  const saveJobs = () => { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(jobsFile, JSON.stringify(jobs)); } catch (e) { log('[candles] could not save history-jobs.json', e.message); } };
  const isoDay = (d) => d.toISOString().slice(0, 10);
  const addDays = (date, n) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
  const mondayOf = (date) => { const d = new Date(`${date}T12:00:00Z`); return addDays(date, -((d.getUTCDay() + 6) % 7)); };
  const prevWeekday = (date) => { let d = addDays(date, -1); while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = addDays(d, -1); return d; };
  /** Newest trade of this market that carries a platform contract name: { source, c, d } */
  function latestContract(root, prefer) {
    let best = null;
    const see = (t, d) => {
      if (!t?.contract || rootOf(t.symbol || t.contract) !== root || !t.source) return;
      const src = String(t.source).toLowerCase();
      if (prefer && prefer !== 'any' && src !== prefer) return;
      if (!best || d > best.d) best = { source: src, c: String(t.contract), d };
    };
    try { for (const t of (readTrades?.() || [])) if (t?.entry) see(t, String(t.entry).slice(0, 10)); } catch { /* */ }
    try { for (const t of (readConnTrades?.() || [])) if (t?.entry) see(t, String(t.entry).slice(0, 10)); } catch { /* */ }
    return best;
  }
  const storedBars = (source, root, from, to) => barsFrom(source, root, from, to).length;
  /** Queue the next week(s) of a job until a few items are waiting. */
  function fillJob(job) {
    let guard = 0;
    while (job.status === 'running' && job.pending.filter((i) => !i.roll).length < 6 && guard++ < 12) {
      const week = job.next;
      if (week < addDays(job.started.slice(0, 10), -366 * 20)) { job.status = 'done'; job.reason = 'limit'; break; }
      const days = [0, 1, 2, 3, 4].map((k) => addDays(week, k)).filter((d) => d <= isoDay(new Date()));
      const items = [];
      for (const d of days) {
        const c = contractFor(job.contract, job.root, d, job.seen);
        if (!c) { job.status = 'done'; job.reason = 'contract'; break; }
        const last = items[items.length - 1];
        if (last && last.contract === c) last.days.push(d);
        else items.push({ contract: c, days: [d] });
        const pd = prevWeekday(d);
        const pc = contractFor(job.contract, job.root, pd, job.seen);
        if (pc && pc !== c) { // roll day: the old contract's bars too, for back-adjusting
          const w = dayWindow(d, job.tz);
          if (!job.rolls.some((r) => r.date === d)) job.rolls.push({ date: d, from: w.from, to: w.to, old: pc, new: c });
          if (!storedBars(`${job.source}-roll`, job.root, w.from, w.to)) job.pending.push({ symbol: `${job.root}~roll`, contract: pc, from: w.from, to: w.to, week, roll: true, tries: 0 });
        }
      }
      if (job.status !== 'running') break;
      let need = 0, have = 0;
      for (const it of items) {
        const from = dayWindow(it.days[0], job.tz).from, to = Math.min(dayWindow(it.days[it.days.length - 1], job.tz).to, Math.floor(Date.now() / 1000));
        if (to <= from) continue;
        if (coveredTo(`${job.source}|${job.root}`, from) >= to || storedBars(job.source, job.root, from, to) > 200 * it.days.length) { have += 1; continue; }
        job.pending.push({ symbol: job.root, contract: it.contract, from, to, week, roll: false, tries: 0 });
        need += 1;
      }
      job.weeks[week] = { left: need, bars: have ? 1 : 0 };
      if (!need) finishWeek(job, week);
      job.next = addDays(week, -7);
    }
  }
  function finishWeek(job, week) {
    const w = job.weeks[week];
    if (!w) return;
    if (w.bars > 0) { job.empty = 0; if (!job.oldest || week < job.oldest) job.oldest = week; }
    else job.empty += 1;
    job.done += 1;
    delete job.weeks[week];
    if (job.empty >= 4 && job.status === 'running') { job.status = 'done'; job.reason = 'start'; job.pending = []; }
  }
  function historyItems(source, now) {
    const out = [];
    let changed = false;
    for (const job of Object.values(jobs)) {
      if (job.status !== 'running' || job.source !== source) continue;
      fillJob(job);
      for (const it of job.pending) {
        if (now - (it.at || 0) > 50) { it.at = now; it.tries += 1; changed = true; }
        if (it.tries > 6) continue; // the platform keeps failing on this one — skipped below
        out.push({ symbol: it.symbol, contract: it.contract, from: it.from, to: it.to });
        if (out.length >= 6) break;
      }
      const stuck = job.pending.filter((i) => i.tries > 6);
      if (stuck.length) {
        job.pending = job.pending.filter((i) => i.tries <= 6);
        for (const it of stuck) { if (!it.roll && job.weeks[it.week]) { job.weeks[it.week].left -= 1; if (job.weeks[it.week].left <= 0) finishWeek(job, it.week); } }
        job.failed = (job.failed || 0) + stuck.length;
      }
    }
    if (changed) saveJobs();
    return out;
  }
  function historyIngest(source, symbol, from, to, n) {
    const roll = String(symbol).endsWith('~roll');
    const root = rootOf(String(symbol).replace(/~roll$/, ''));
    const job = jobs[root];
    if (!job || job.source !== srcId(source)) return;
    let hit = false;
    job.pending = job.pending.filter((it) => {
      if (it.roll !== roll || !(Number(from) <= it.from + 60 && Number(to) >= it.to - 60)) return true;
      hit = true;
      if (!roll && job.weeks[it.week]) {
        const w = job.weeks[it.week];
        w.left -= 1; w.bars += n;
        if (w.left <= 0) finishWeek(job, it.week);
      }
      return false;
    });
    if (hit) { job.bars += n; job.updated = new Date().toISOString(); saveJobs(); wantCache.clear(); }
  }
  function startHistory(symbol, tz) {
    const root = rootOf(symbol);
    const pick = cfg.addonSource && cfg.addonSource !== 'any' ? cfg.addonSource : null;
    const lc = latestContract(root, pick) || (pick ? null : latestContract(root));
    // ATAS can't fetch history on request — its Journal Sync indicator sends whole charts instead (chart mode)
    const atasOnly = !lc && (pick === 'atas' || (!pick && (addonSources().some((x) => x.id === 'atas') || (readTrades?.() || []).some((t) => String(t?.source).toLowerCase() === 'atas'))));
    if (atasOnly) {
      const old = jobs[root];
      jobs[root] = { root, source: 'atas', mode: 'chart', status: 'running', reason: null, started: new Date().toISOString(), updated: new Date().toISOString(), pending: [], weeks: {}, rolls: old?.rolls || [], empty: 0, done: 0, bars: old?.bars || 0, failed: 0, oldest: old?.oldest || null, charts: old?.charts || {}, seen: {} };
      saveJobs();
      return jobs[root];
    }
    if (!lc) throw Object.assign(new Error(`RoninFlow learns your platform’s name for ${root} contracts from a trade its add-on synced. Take one ${root} trade (sim is fine) with the add-on running, then try again.`), { code: 'NO_CONTRACT' });
    if (cfg.addon === false) throw Object.assign(new Error('Price data from your platform add-on is switched off — turn it on in Settings → Price data.'), { code: 'ADDON_OFF' });
    const old = jobs[root];
    jobs[root] = {
      root, source: lc.source, contract: lc.c, seen: lc.d, tz: validTz(tz) ? tz : Intl.DateTimeFormat().resolvedOptions().timeZone,
      status: 'running', reason: null, next: mondayOf(isoDay(new Date())), started: new Date().toISOString(), updated: new Date().toISOString(),
      pending: [], weeks: {}, rolls: old?.rolls || [], empty: 0, done: 0, bars: 0, failed: 0, oldest: null,
    };
    fillJob(jobs[root]);
    saveJobs();
    wantCache.clear();
    if (!dropDirs) setTimeout(writeWantedFiles, 300).unref?.();
    return jobs[root];
  }
  /** Contracts of a market whose full chart history an add-on sent: [{ dir, name, y, m }] (y/m null when unknown). */
  function histContracts(root) {
    const out = [];
    for (const dir of listDir(barsDir).filter((n) => n.startsWith('h_'))) {
      // a micro and its full-size contract trade at the same price: an ES chart's history serves MES backtests
      const sub = [root, TWIN[root]].find((r) => r && fs.existsSync(path.join(barsDir, dir, r.replace(/[^\w.-]/g, '_'))));
      if (!sub) continue;
      const name = dir.slice(2).toUpperCase();
      out.push({ dir, sub, name, ...(contractMonth(sub, name) || { y: null, m: null }) });
    }
    return out.sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.m ?? 0) - (b.m ?? 0));
  }
  /** Chart-history mode (ATAS): the add-on sends whole charts; this says whether a job wants them. */
  /** A chart-mode history job for this chart's market: its own, or its micro / full-size twin's (an ES chart serves MES). */
  const chartJob = (root) => (jobs[root]?.mode === 'chart' ? jobs[root] : TWIN[root] && jobs[TWIN[root]]?.mode === 'chart' ? jobs[TWIN[root]] : jobs[root]);
  function chartWant(source, symbol) {
    const root = rootOf(symbol);
    const job = chartJob(root);
    if (!job || job.mode !== 'chart' || job.status !== 'running' || job.source !== srcId(source)) return { want: false };
    job.seen = job.seen || {};
    job.seen[String(symbol).slice(0, 40)] = new Date().toISOString();
    job.updated = new Date().toISOString();
    saveJobs();
    return { want: true };
  }
  function chartDone(body) {
    const root = rootOf(body.symbol);
    const job = chartJob(root);
    if (!job || job.mode !== 'chart') return;
    job.charts = job.charts || {};
    job.charts[String(body.symbol).slice(0, 40)] = { first: Number(body.first) || null, last: Number(body.last) || null, count: Number(body.count) || 0, oneMinute: body.oneMinute !== false, at: new Date().toISOString() };
    job.bars = Object.values(job.charts).reduce((a, c) => a + c.count, 0);
    const firsts = Object.values(job.charts).filter((c) => c.count && c.first).map((c) => c.first);
    if (firsts.length) job.oldest = new Date(Math.min(...firsts) * 1000).toISOString().slice(0, 10);
    job.updated = new Date().toISOString();
    saveJobs();
  }

  /** Days (UTC file dates) with saved 1-minute bars for a market, all platforms. */
  function coverage(root) {
    const days = new Set();
    for (const src of [...addonSources().map((x) => x.id), EARLIER, ...histContracts(root).map((c) => c.dir)]) {
      for (const r of [root, TWIN[root]].filter(Boolean)) {
        try { for (const f of fs.readdirSync(path.join(barsDir, src, r.replace(/[^\w.-]/g, '_')))) if (f.endsWith('.json')) days.add(f.slice(0, 10)); } catch { /* none */ }
      }
    }
    const list = [...days].sort();
    return { days: list.length, first: list[0] || null, last: list[list.length - 1] || null, list };
  }
  const jobView = (job) => job && ({ ...job, pending: job.pending.length, weeks: undefined, waiting: job.pending.length });
  /** One continuous 1-minute series for a market and date range, back-adjusted at contract rolls when we have the bars. */
  function continuous(root, fromDate, toDate, adjust = true) {
    const from = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000) - DAY, to = Math.floor(Date.parse(`${toDate}T00:00:00Z`) / 1000) + 2 * DAY;
    const sources = [...addonSources().map((x) => x.id), EARLIER];
    const byT = new Map();
    for (let t = from - (from % DAY); t <= to; t += DAY) {
      let best = null;
      for (const r of [root, TWIN[root]].filter(Boolean)) { // the micro's own bars, else its full-size twin's (same prices)
        for (const src of sources) {
          const cur = readCache(barFile(src, r, t));
          if (cur && (!best || Object.keys(cur).length > Object.keys(best).length)) best = cur;
        }
        if (best) break;
      }
      if (best) for (const r of Object.values(best)) if (r[0] >= from && r[0] < to) byT.set(r[0], r);
    }
    let rows = [...byT.values()].sort((a, b) => a[0] - b[0]);
    const rolls = [];
    const job = jobs[root];
    const hist = histContracts(root);
    if (hist.length) {
      // charts of one contract each (ATAS): every day uses the contract that was front month then, older contracts are
      // shifted by the price gap where they overlap on the switch day (back-adjusted), and days no chart covers come
      // from the live data above
      const days = new Map(); // UTC day start → { contract → rows }
      for (const c of hist) {
        for (let t = from - (from % DAY); t <= to; t += DAY) {
          const cur = readCache(barFile(c.dir, c.sub, t));
          if (cur) { const m = days.get(t) || new Map(); m.set(c.name, Object.values(cur).filter((r) => r[0] >= from && r[0] < to)); days.set(t, m); }
        }
      }
      const byName = new Map(hist.map((c) => [c.name, c]));
      const pickFor = (t, m) => {
        const day = new Date(t * 1000 + 12 * 3600e3).toISOString().slice(0, 10);
        const f = frontMonth(root, day);
        const names = [...m.keys()].filter((n) => m.get(n).length);
        const front = f && names.find((n) => byName.get(n)?.y === f.y && byName.get(n)?.m === f.m);
        if (front) return front;
        // unknown roll: the contract with the most bars that day
        return names.sort((a, b) => m.get(b).length - m.get(a).length)[0];
      };
      const chosen = [...days.keys()].sort((a, b) => a - b).map((t) => ({ t, name: pickFor(t, days.get(t)) })).filter((x) => x.name);
      // gaps where the contract changes, newest first
      const shift = new Map(); // day start → price shift for that day's bars
      let cum = 0;
      for (let k = chosen.length - 1; k >= 0; k--) {
        shift.set(chosen[k].t, cum);
        const prev = chosen[k - 1];
        if (prev && prev.name !== chosen[k].name) {
          const newer = days.get(chosen[k].t), older = days.get(prev.t);
          // overlap: both contracts on the newer day, else on the older day
          let diffs = [];
          for (const m of [newer, older]) {
            const a = m.get(chosen[k].name) || [], b = new Map((m.get(prev.name) || []).map((r) => [r[0], r[4]]));
            diffs = a.filter((r) => b.has(r[0])).map((r) => r[4] - b.get(r[0]));
            if (diffs.length) break;
          }
          diffs.sort((x, y) => x - y);
          const adj = diffs.length ? diffs[Math.floor(diffs.length / 2)] : null;
          rolls.push({ date: new Date(chosen[k].t * 1000).toISOString().slice(0, 10), t: chosen[k].t, adj, from: prev.name, to: chosen[k].name });
          if (adjust && adj != null) cum += adj;
        }
      }
      const histT = new Set(chosen.map((x) => x.t));
      const out = new Map();
      for (const r of rows) if (!histT.has(r[0] - (r[0] % DAY))) out.set(r[0], r); // live data for days no chart covers
      for (const { t, name } of chosen) {
        const d = shift.get(t) || 0;
        for (const r of days.get(t).get(name)) out.set(r[0], d ? [r[0], r[1] + d, r[2] + d, r[3] + d, r[4] + d, r[5]] : r);
      }
      rows = [...out.values()].sort((a, b) => a[0] - b[0]);
    } else if (adjust && job?.rolls?.length && rows.length) {
      for (const r of [...job.rolls].sort((a, b) => b.date.localeCompare(a.date))) {
        const old = barsFrom(`${job.source}-roll`, root, r.from, r.to);
        if (!old.length) { rolls.push({ date: r.date, t: r.from, adj: null }); continue; }
        const oldBy = new Map(old.map((x) => [x[0], x[4]]));
        const diffs = rows.filter((x) => x[0] >= r.from && x[0] < r.to && oldBy.has(x[0])).map((x) => x[4] - oldBy.get(x[0])).sort((a, b) => a - b);
        rolls.push({ date: r.date, t: r.from, adj: diffs.length ? diffs[Math.floor(diffs.length / 2)] : null });
      }
      // newest roll first: every bar before a roll moves by that roll's gap (and all the later ones)
      let cum = 0, k = rows.length - 1;
      for (const r of rolls) {
        for (; k >= 0 && rows[k][0] >= r.t; k--) if (cum) rows[k] = [rows[k][0], rows[k][1] + cum, rows[k][2] + cum, rows[k][3] + cum, rows[k][4] + cum, rows[k][5]];
        if (r.adj != null) cum += r.adj;
      }
      if (cum) for (; k >= 0; k--) rows[k] = [rows[k][0], rows[k][1] + cum, rows[k][2] + cum, rows[k][3] + cum, rows[k][4] + cum, rows[k][5]];
    }
    const lo = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000) - DAY, hi = to;
    const keep = rows.filter((r) => r[0] >= lo && r[0] < hi);
    const col = (i) => keep.map((r) => (i === 0 || i === 5 ? r[i] : Math.round(r[i] * 1e6) / 1e6));
    return { symbol: root, n: keep.length, t: col(0), o: col(1), h: col(2), l: col(3), c: col(4), v: col(5), rolls: rolls.reverse() };
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
      const source = g.source || body.source;
      if (String(g.symbol).endsWith('~roll')) { // an old contract's bars on a roll day (history download)
        const got = Array.isArray(g.bars) ? storeBars(g.symbol.replace(/~roll$/, ''), g.bars, `${srcId(source)}-roll`) : 0;
        n += got;
        if (g.from !== undefined && g.to !== undefined) historyIngest(source, g.symbol, g.from, g.to, got);
        continue;
      }
      if (g.history || body.history) { // a chart's full history (ATAS), kept per contract for the continuous series
        n += Array.isArray(g.bars) ? storeBars(g.symbol, g.bars, `h_${srcId(g.symbol)}`) : 0;
        continue;
      }
      const got = Array.isArray(g.bars) ? storeBars(g.symbol, g.bars, source) : 0;
      n += got;
      if (g.from !== undefined && g.to !== undefined) {
        historyIngest(source, g.symbol, g.from, g.to, got);
        markCovered(source, g.symbol, g.from, g.to);
        let changed = false;
        for (const [key, r] of Object.entries(requested)) {
          if (r.symbol !== rootOf(g.symbol)) continue;
          const w = dayWindow(r.date, validTz(r.tz) ? r.tz : Intl.DateTimeFormat().resolvedOptions().timeZone);
          if (Number(g.from) < w.to && Number(g.to) > w.from) { delete requested[key]; changed = true; }
        }
        if (changed) saveRequested();
      }
    }
    return n;
  }
  const libFile = path.join(dataDir, 'vendor', `lightweight-charts-${LIB_VERSION}.js`);
  const inflight = new Map();

  const cachePath = (ysym, date) => path.join(cacheDir, ysym.replace(/[^\w=.-]/g, '_'), `${date}.json`);
  const readCache = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

  /** Candles for one symbol and diary day, from the cache when it's final. */
  async function get(symbol, date, tz, { force, noPaid } = {}) { // noPaid: skip Databento / Polygon (a shared view's visitor shouldn't run up your bill)
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
      // saved coarser bars (Yahoo's hourly ones for an older day) give way to 1-minute bars from your platform,
      // e.g. once its history has been downloaded for backtests
      if (cached.interval !== '1m' && cfg.addon !== false) {
        const ab = addonBars(symbol, from, Math.min(to, now));
        if (ab.candles.length >= 5 && ab.interval === '1m') return { symbol: rootOf(symbol), ysym, date, tz, from, to, interval: '1m', source: 'Your platform (add-on)', fetchedAt: now, final: false, candles: ab.candles };
      }
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
      const dbKey = cfg.useDatabento === false || noPaid ? null : keyOf('databento');
      if (dbKey && isFutures(symbol)) {
        try {
          const candles = await databento(dbKey, rootOf(symbol), from, end);
          if (candles.length) return save({ symbol: rootOf(symbol), ysym, date, tz, from, to, interval: '1m', source: 'Databento (CME, front month)', fetchedAt: now, final: ageDays > 0.05, candles });
        } catch (e) { lastErr = e; }
      }
      // 3. Polygon (stocks, crypto, forex)
      const pgKey = cfg.usePolygon === false || noPaid ? null : keyOf('polygon');
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
    const recent = new Map(); // root → a symbol you traded in the last 90 days
    for (const t of trades) {
      if (!t?.entry || !t.symbol) continue;
      const date = String(t.entry).slice(0, 10);
      const { from } = dayWindow(date, tz);
      if ((now - from) / DAY <= 90) recent.set(rootOf(t.symbol), t.symbol);
      if ((now - from) / DAY > 28.5) continue;
      want.add(`${yahooSymbol(t.symbol)}|${t.symbol}|${date}`);
    }
    // every weekday of the last four weeks for the markets you trade, not just the days you traded: replay and
    // backtest sessions on older days get 1-minute bars once Yahoo only has hourly ones left
    for (const symbol of recent.values()) {
      for (let i = 1; i <= 28; i++) {
        const x = new Date(now * 1000 - i * DAY * 1000);
        if (x.getDay() === 0 || x.getDay() === 6) continue;
        const date = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
        want.add(`${yahooSymbol(symbol)}|${symbol}|${date}`);
      }
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
      if (u.pathname === '/api/candles/history/chart') { // the ATAS indicator: "do you want my chart's history?" / "sent it"
        if (req.method === 'POST') {
          if (tokenOk && !tokenOk(req)) return send(res, 401, { error: 'Missing or wrong token (Connections → Webhook / API).' });
          const body = await new Promise((resolve, reject) => { let t = ''; req.setEncoding('utf8'); req.on('data', (c) => { t += c; if (t.length > 1e5) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(t || '{}')); } catch (e) { reject(e); } }); req.on('error', reject); });
          chartDone(body);
          return send(res, 200, { ok: true });
        }
        return send(res, 200, chartWant(u.searchParams.get('source') || 'atas', u.searchParams.get('symbol') || ''));
      }
      if (u.pathname === '/api/candles/history' || u.pathname === '/api/candles/history/bars') {
        const root = rootOf(u.searchParams.get('symbol') || '');
        if (!root) return send(res, 400, { error: 'symbol needed' });
        if (u.pathname === '/api/candles/history/bars') {
          const from = u.searchParams.get('from'), to = u.searchParams.get('to');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return send(res, 400, { error: 'from and to (YYYY-MM-DD) needed' });
          const body = JSON.stringify(continuous(root, from, to, u.searchParams.get('adjust') !== '0'));
          res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
          if (/\bgzip\b/.test(req.headers?.['accept-encoding'] || '')) { res.setHeader('Content-Encoding', 'gzip'); return res.end(zlib.gzipSync(body)); }
          return res.end(body);
        }
        if (req.method === 'POST') {
          const action = u.searchParams.get('action');
          if (action === 'start') { try { startHistory(root, u.searchParams.get('tz')); } catch (e) { return send(res, 400, { error: e.message, code: e.code }); } }
          if (action === 'stop' && jobs[root]) { jobs[root].status = 'stopped'; jobs[root].pending = []; saveJobs(); wantCache.clear(); }
        }
        const job = jobs[root];
        if (job?.status === 'running' && Date.now() - Date.parse(job.updated) > 15 * 60e3) job.stale = true; else if (job) job.stale = false;
        const cov = coverage(root);
        return send(res, 200, { job: jobView(job), coverage: { days: cov.days, first: cov.first, last: cov.last }, contract: latestContract(root) });
      }
      if (u.pathname === '/api/candles/config') {
        if (req.method === 'POST') {
          const b = await new Promise((resolve, reject) => { let t = ''; req.setEncoding('utf8'); req.on('data', (c) => { t += c; }); req.on('end', () => { try { resolve(JSON.parse(t || '{}')); } catch (e) { reject(e); } }); req.on('error', reject); });
          cfg = { ...cfg, yahoo: !!b.yahoo, decided: true };
          for (const k of ['addon', 'useDatabento', 'usePolygon']) if (typeof b[k] === 'boolean') cfg[k] = b[k];
          if (typeof b.addonSource === 'string') cfg.addonSource = b.addonSource === 'any' ? 'any' : srcId(b.addonSource);
          wantCache.clear();
          for (const k of ['databento', 'polygon']) if (typeof b[`${k}Key`] === 'string' && b[`${k}Key`] !== '••••••••') vault?.set(`price:${k}`, b[`${k}Key`].trim());
          fs.mkdirSync(dataDir, { recursive: true });
          fs.writeFileSync(cfgFile, JSON.stringify(cfg));
        }
        const sources = addonSources();
        const roots = [...new Set(sources.flatMap((x) => listDir(path.join(barsDir, x.id))))];
        return send(res, 200, {
          yahoo: !!cfg.yahoo, addon: cfg.addon !== false, addonSource: cfg.addonSource || 'any', addonSources: sources, addonSymbols: roots,
          useDatabento: cfg.useDatabento !== false, usePolygon: cfg.usePolygon !== false,
          decided: !!cfg.decided, databento: !!keyOf('databento'), polygon: !!keyOf('polygon'), vault: !!vault,
        });
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
      const want = u.searchParams.get('want') === '1' && cfg.addon !== false;
      let rec;
      try { rec = await get(symbol, date, tz, { force: u.searchParams.get('refresh') === '1' }); } catch (e) { if (want) requestDay(symbol, date, tz); throw e; }
      if (want && !(rec.interval === '1m' && rec.candles?.length >= 200 && /add-on|Databento|Polygon/.test(rec.source || ''))) requestDay(symbol, date, tz);
      return send(res, 200, rec);
    } catch (e) {
      return send(res, e.code === 'NO_SOURCE' ? 424 : 502, { error: e.message || 'Couldn’t load prices', code: e.code });
    }
  };
  handler.ingestBars = ingestBars;
  handler.get = get; // shared views and snapshots (share.js)
  handler.lib = lib;
  handler.wanted = wanted;
  handler.history = { start: startHistory, continuous, jobs: () => jobs, coverage, chartWant, chartDone };
  handler.writeWantedFiles = writeWantedFiles;
  return handler;
}
