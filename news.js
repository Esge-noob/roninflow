// News for the Macro → News Flow, Heat Map and News Agents pages, and the alert pill in the top bar.
//
// Reads free headline feeds around the clock (plus your economic calendar's releases), sorts each line into a story,
// reads its tone and how that kind of news usually moves each market (src/lib/newsRules.js — built-in rules, or your
// Trading Coach's AI if you switch it on), measures how your markets actually moved in the 15 minutes after, and
// runs your News Agents: when a line matters to one of them, an alert lands in the top-bar pill.
//
//   GET  /api/macro/news/config                 · POST /api/macro/news/config { sources?, custom?, extraMarkets?, ai?, yahoo?, finnhubKey? }
//   GET  /api/macro/news/flow?hours=24          → { items, stories, markets }
//   GET  /api/macro/news/similar?id=&market=    → { items }   earlier lines with the same story and tone, and what the market did next
//   GET  /api/macro/news/heatmap?market=ES      → { tiles, bias, trend }
//   GET  /api/macro/news/agents                 · POST /api/macro/news/agents { action, agent }
//   GET  /api/macro/news/alerts                 · POST /api/macro/news/alerts/read { ids? } · POST …/alerts/dismiss { ids? }
//   POST /api/macro/news/explain { id, market } → { chain, text? }
//
// Kept in data/news/: one file of headlines per New York day (90 days), alerts, and settings.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { classify, impactsFor, chainFor, similarity, newsMarketOf, NEWS_MARKETS, DRIVERS, OPPOSITE, dataDriver, words } from './src/lib/newsRules.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const KEEP_DAYS = 90;

/** Free feeds. every = seconds between checks. */
export const FEEDS = [
  { id: 'truth', label: 'Trump on Truth Social (trumpstruth.org)', url: 'https://www.trumpstruth.org/feed', every: 90 },
  { id: 'investinglive', label: 'investingLive (ForexLive)', url: 'https://investinglive.com/feed', every: 90 },
  { id: 'fxstreet', label: 'FXStreet news', url: 'https://www.fxstreet.com/rss/news', every: 120 },
  { id: 'investing', label: 'Investing.com forex news', url: 'https://www.investing.com/rss/news_1.rss', every: 180 },
  { id: 'cnbc', label: 'CNBC top news', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', every: 180 },
  { id: 'cnbc-economy', label: 'CNBC economy', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', every: 300 },
  { id: 'marketwatch', label: 'MarketWatch top stories', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', every: 180 },
  { id: 'fed-press', label: 'Federal Reserve press releases', url: 'https://www.federalreserve.gov/feeds/press_all.xml', every: 300 },
  { id: 'fed-speeches', label: 'Federal Reserve speeches', url: 'https://www.federalreserve.gov/feeds/speeches.xml', every: 600 },
  { id: 'bls', label: 'BLS data releases', url: 'https://www.bls.gov/feed/bls_latest.rss', every: 300 },
  { id: 'whitehouse', label: 'White House presidential actions', url: 'https://www.whitehouse.gov/presidential-actions/feed/', every: 600 },
];

/** Agents that come set up (each can be switched off). Market agents are added for every market you follow. */
export const BUILTIN_AGENTS = [
  { id: 'fed', label: 'Fed', desc: 'Every Fed speaker and decision, read as hawkish or dovish.' },
  { id: 'data', label: 'Data', desc: 'Every release against its forecast.' },
  { id: 'trump', label: 'Trump', desc: 'What Trump says and signs that can move markets.' },
  { id: 'geo', label: 'Geopolitics', desc: 'Wars, sanctions and shipping lanes.' },
];

// ---------- feeds ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const unent = (s) => String(s || '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
const clean = (s) => unent(String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (block, names) => { for (const n of names) { const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i').exec(block); if (m) return m[1]; } return ''; };
const linkOf = (block) => { const m = /<link[^>]*href="([^"]+)"/i.exec(block); return m ? unent(m[1]) : clean(tag(block, ['link', 'guid'])); };
/** RSS or Atom → [{ title, summary, link, t }] */
export function parseFeed(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const b = m[0];
    const title = clean(tag(b, ['title']));
    const t = Date.parse(clean(tag(b, ['pubDate', 'published', 'updated', 'dc:date', 'a10:updated'])));
    let summary = clean(tag(b, ['description', 'summary', 'content:encoded', 'content']));
    if (summary.length > 280) summary = `${summary.slice(0, 277)}…`;
    if (!title && !summary) continue;
    out.push({ title: title || summary.slice(0, 160), summary: summary && summary !== title ? summary : '', link: linkOf(b), t: Number.isFinite(t) ? t : null });
  }
  return out;
}

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 14);
const nyDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export function createNewsHandler(dataDir, { log = () => {}, vault = null, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), readTrades = () => [], readConnTrades = () => [], readSettings = () => ({}), candles = null, macro = null } = {}) {
  const dir = path.join(dataDir, 'news');
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
  const cfgFile = path.join(dir, 'config.json');
  let cfg = { sources: {}, custom: [], extraMarkets: [], ai: { on: false, perHour: 40 }, yahoo: true, agents: { off: [], custom: [] }, ...readJson(cfgFile, {}) };
  cfg.agents = { off: [], custom: [], ...(cfg.agents || {}) };
  const saveCfg = () => writeJson(cfgFile, cfg);
  const status = {}; // feed id → { at, ok, n, error }
  const dayFile = (d) => path.join(dir, 'items', `${d}.json`);
  const days = new Map(); // date → items (loaded on demand)
  const dayItems = (d) => { if (!days.has(d)) days.set(d, readJson(dayFile(d), [])); return days.get(d); };
  const dirty = new Set();
  const flush = () => { for (const d of dirty) { try { writeJson(dayFile(d), dayItems(d)); } catch (e) { log('[news] save', e.message); } } dirty.clear(); };
  const recent = (ms) => { // items newer than ms ago (today and the days before as needed)
    const out = [];
    const since = now() - ms;
    for (let t = now(); t >= since - DAY; t -= DAY) out.push(...dayItems(nyDate(t)).filter((x) => x.t >= since));
    return out.sort((a, b) => b.t - a.t);
  };
  const byId = (id) => { for (let t = now(), i = 0; i < 4; i++, t -= DAY) { const x = dayItems(nyDate(t)).find((y) => y.id === id); if (x) return x; } return null; };
  const alertsFile = path.join(dir, 'alerts.json');
  let alerts = readJson(alertsFile, []);
  const saveAlerts = () => { alerts = alerts.slice(-500); writeJson(alertsFile, alerts); };

  // ---------- markets you follow: everything you trade (last 120 days), plus any you add ----------
  let followCache = null;
  function followed() {
    if (followCache && now() - followCache.at < 5 * MIN) return followCache.list;
    const since = new Date(now() - 120 * DAY).toISOString().slice(0, 10);
    const set = new Set();
    try { for (const t of readTrades() || []) if (t?.symbol && !t.deleted && String(t.entry || '') >= since) { const m = newsMarketOf(t.symbol); if (m) set.add(m); } } catch { /* journal not ready */ }
    try { for (const t of readConnTrades() || []) { const m = newsMarketOf(t?.symbol); if (m) set.add(m); } } catch { /* */ }
    const traded = [...set];
    for (const m of cfg.extraMarkets || []) if (NEWS_MARKETS[m]) set.add(m);
    if (!set.size) ['ES', 'NQ', 'GC', 'CL'].forEach((m) => set.add(m));
    followCache = { at: now(), list: [...set], traded };
    return followCache.list;
  }

  // ---------- reading feeds ----------
  async function get(url, { timeout = 20000, json = false, headers = {} } = {}) {
    const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*', ...headers }, signal: AbortSignal.timeout(timeout) });
    const text = await r.text();
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return json ? JSON.parse(text) : text;
  }
  const feeds = () => [
    ...FEEDS.filter((f) => cfg.sources?.[f.id] !== false),
    ...(cfg.custom || []).filter((f) => f.on !== false && /^https?:\/\//.test(f.url)).map((f) => ({ ...f, every: 180 })),
  ];
  const seen = new Set();
  for (let t = now(), i = 0; i < 3; i++, t -= DAY) for (const x of dayItems(nyDate(t))) seen.add(x.id);

  function ingest(raw, src, { quiet = false } = {}) {
    const t = Math.min(raw.t || now(), now());
    if (t < now() - 3 * DAY) return null;
    const id = raw.id || hash(`${src}|${raw.link || raw.title}`);
    if (seen.has(id)) return null;
    seen.add(id);
    const text = `${raw.title} ${raw.summary || ''}`.slice(0, 600);
    const c = raw.c || classify(text, { src });
    const item = {
      id, t, src, title: raw.title, summary: raw.summary || '', link: raw.link || '',
      cats: c.cats, story: c.story, storyTitle: c.storyTitle, driver: c.driver, importance: c.importance, ccy: c.ccy, filler: !!c.filler,
      impacts: impactsFor(c, Object.keys(NEWS_MARKETS)), data: raw.data || null, by: 'rules',
    };
    // the same line from another feed (or a repeat) folds under the first one
    const dup = recent(3 * HOUR).find((x) => !x.repeatOf && x.id !== id && Math.abs(x.t - t) < 3 * HOUR && similarity(x.title, item.title) >= 0.75);
    if (dup) item.repeatOf = dup.id;
    const d = nyDate(t);
    dayItems(d).push(item);
    dirty.add(d);
    if (!quiet && !item.repeatOf && t > now() - 30 * MIN) { runAgents(item); if (cfg.ai?.on && item.importance >= 2) aiQueue.push(item.id); }
    return item;
  }

  async function pollFeed(f) {
    const st = status[f.id] || (status[f.id] = {});
    st.at = now();
    try {
      const xml = await get(f.url);
      const list = parseFeed(xml);
      const first = !st.ok && !st.n; // the first read after starting: older lines are history, not alerts
      let n = 0;
      for (const r of list) if (ingest(r, f.id, { quiet: first && r.t && r.t < now() - 10 * MIN })) n++;
      Object.assign(st, { ok: true, error: null, n: (st.n || 0) + n, last: list.length });
    } catch (e) {
      Object.assign(st, { ok: false, error: e.status === 403 || e.status === 401 ? 'The site refused (blocked or needs a login)' : e.message });
    }
  }
  async function pollKeyed() {
    const fk = vault?.get('news:finnhub');
    if (fk && cfg.sources?.finnhub !== false) {
      const st = status.finnhub || (status.finnhub = {});
      if (!st.at || now() - st.at > 120e3) {
        st.at = now();
        try {
          const j = await get(`https://finnhub.io/api/v1/news?category=general&token=${encodeURIComponent(fk)}`, { json: true });
          let n = 0;
          for (const x of j || []) if (ingest({ title: x.headline, summary: x.summary, link: x.url, t: (x.datetime || 0) * 1000, id: `fh${x.id}` }, 'finnhub', { quiet: !st.ok })) n++;
          Object.assign(st, { ok: true, error: null, n: (st.n || 0) + n });
        } catch (e) { Object.assign(st, { ok: false, error: e.message }); }
      }
    }
  }
  // your calendar's releases, as headlines with their surprise
  async function pollCalendar() {
    if (!macro?.events) return;
    const st = status.calendar || (status.calendar = {});
    if (st.at && now() - st.at < 90e3) return;
    st.at = now();
    try {
      const today = nyDate(now()), y = nyDate(now() - DAY);
      const evs = await macro.events(y, today);
      const ccys = new Set(['USD', ...followed().map((m) => NEWS_MARKETS[m]?.ccy).filter(Boolean)]);
      let n = 0;
      for (const e of evs) {
        if (!e.actual || e.holiday || !['high', 'medium'].includes(e.impact) || !ccys.has(e.ccy)) continue;
        const t = Date.parse(e.t);
        if (!Number.isFinite(t) || t > now() || t < now() - DAY) continue;
        const pv = (v) => { const m = String(v ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
        const a = pv(e.actual), f = pv(e.forecast);
        const driver = f != null ? dataDriver(e.title, a, f) : null;
        const title = `${e.ccy} ${e.title}: ${e.actual}${e.forecast ? ` vs ${e.forecast} forecast` : ''}${e.previous ? ` (prior ${e.previous})` : ''}`;
        const c = classify(title, { src: 'calendar' });
        if (driver) { c.driver = driver; c.tone = DRIVERS[driver].label; }
        c.ccy = e.ccy;
        c.importance = e.impact === 'high' ? (driver ? 3 : 2) : (driver ? 2 : 1);
        if (ingest({ id: `cal-${hash(`${e.ccy}|${e.title}|${e.t}`)}`, title, t, c, data: { actual: e.actual, forecast: e.forecast || null, previous: e.previous || null, impact: e.impact } }, 'calendar', { quiet: !st.ok && t < now() - 10 * MIN })) n++;
      }
      Object.assign(st, { ok: true, error: null, n: (st.n || 0) + n });
    } catch (e) { Object.assign(st, { ok: false, error: e.message }); }
  }

  // ---------- prices: your platform's bars (through the journal), else Yahoo's free 1-minute bars ----------
  const pxCache = new Map();
  async function bars(market, date) { // 1-minute rows [t(s), o, h, l, c, v] for one New York day
    const k = `${market}|${date}`, c = pxCache.get(k);
    if (c && now() - c.at < (date === nyDate(now()) ? 90e3 : 30 * MIN)) return c.rows;
    let rows = [];
    try {
      const rec = await candles?.get?.(market, date, 'America/New_York', { noPaid: true });
      if (rec?.candles?.length && /^1m$/.test(rec.interval || '')) rows = rec.candles;
    } catch { /* none */ }
    if (!rows.length && cfg.yahoo !== false && NEWS_MARKETS[market]?.yahoo) {
      try { rows = (await yahoo(NEWS_MARKETS[market].yahoo, '1m', '5d')).filter((r) => nyDate(r[0] * 1000) === date); } catch { /* none */ }
    }
    pxCache.set(k, { at: now(), rows });
    if (pxCache.size > 200) pxCache.delete(pxCache.keys().next().value);
    return rows;
  }
  const yCache = new Map();
  async function yahoo(sym, interval, range) {
    const k = `${sym}|${interval}|${range}`, c = yCache.get(k);
    if (c && now() - c.at < 60e3) return c.rows;
    const j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`, { json: true });
    const r = j?.chart?.result?.[0];
    const q = r?.indicators?.quote?.[0] || {};
    const rows = (r?.timestamp || []).map((t, i) => [t, q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i], q.volume?.[i] || 0]).filter((x) => x[4] != null);
    yCache.set(k, { at: now(), rows });
    return rows;
  }
  async function priceAt(market, ms) { // the close of the last bar at or before ms (within 10 minutes)
    const rows = await bars(market, nyDate(ms));
    let best = null;
    for (const r of rows) { if (r[0] * 1000 <= ms) best = r; else break; }
    return best && ms - best[0] * 1000 <= 10 * MIN ? best[4] : null;
  }
  // how each market moved in the 15 minutes after each line (filled in once the 15 minutes have passed)
  async function reactions() {
    const mk = followed();
    const list = recent(2 * DAY).filter((x) => !x.repeatOf && x.importance >= 1 && x.t + 15 * MIN <= now());
    let changed = false;
    for (const x of list) {
      x.move ||= {};
      for (const m of mk) {
        if (x.move[m] !== undefined) continue;
        const a = await priceAt(m, x.t), b = await priceAt(m, x.t + 15 * MIN);
        if (a == null || b == null) { if (now() - x.t > 6 * HOUR) x.move[m] = null; continue; }
        x.move[m] = { p0: a, chg: Math.round((b - a) * 10000) / 10000 };
        changed = true;
        dirty.add(nyDate(x.t));
        moveAgents(x, m);
      }
    }
    if (changed) flush();
    // alerts: the move after each one
    let ach = false;
    for (const a of alerts) {
      if (a.move !== undefined || now() - a.t < 15 * MIN || now() - a.t > DAY || !a.market) continue;
      const b = await priceAt(a.market, a.t + 15 * MIN);
      if (b != null && a.price != null) { a.move = Math.round((b - a.price) * 10000) / 10000; ach = true; } else if (now() - a.t > 6 * HOUR) { a.move = null; ach = true; }
    }
    if (ach) saveAlerts();
  }

  // ---------- agents ----------
  const MARKET_WORDS = { ES: /\b(es|s&p|spx|spy|s&p 500|sp500|e-?mini)\b/i, NQ: /\b(nq|nasdaq|ndx|qqq|tech)\b/i, YM: /\b(ym|dow)\b/i, RTY: /\b(rty|russell|small caps?)\b/i, CL: /\b(cl|oil|crude|wti)\b/i, NG: /\b(ng|natural gas|nat gas)\b/i, GC: /\b(gc|gold)\b/i, SI: /\b(si|silver)\b/i, HG: /\b(hg|copper)\b/i, ZN: /\b(zn|10-?year|ten-?year|notes?|treasur(y|ies))\b/i, ZB: /\b(zb|bonds?|30-?year)\b/i, '6E': /\b(6e|euro|eur)\b/i, '6B': /\b(6b|pound|sterling|gbp)\b/i, '6J': /\b(6j|yen|jpy)\b/i, '6A': /\b(6a|aussie|aud)\b/i, '6C': /\b(6c|loonie|cad)\b/i, BTC: /\b(btc|bitcoin|crypto)\b/i };
  /** A sentence → what the agent watches (rules; with AI on, the sentence itself is also read by the AI). */
  function parseAgent(text) {
    const t = String(text || '');
    const market = Object.keys(MARKET_WORDS).find((m) => MARKET_WORDS[m].test(t)) || null;
    const pos = /\b(long|bought|buying|holding)\b/i.test(t) ? 1 : /\b(short|sold|selling)\b/i.test(t) ? -1 : 0;
    const mv = /\b(more than|over|at least|by|>)\s*\$?\s*(\d+(?:\.\d+)?)\s*(%|percent|points?|pts|ticks?|dollars?|\$)?/i.exec(t);
    if (market && mv && /\b(move|moves|drop|drops|fall|falls|rise|rises|jump|jumps|spike|spikes|swing)/i.test(t)) return { kind: 'move', market, threshold: Number(mv[2]), pct: /%|percent/i.test(mv[3] || '') };
    if (market && pos) return { kind: 'position', market, side: pos, both: /\b(any|for or against|either way|both)\b/i.test(t) };
    const keys = words(t).filter((w) => w.length >= 4 && !/^(tell|anything|something|news|headline|headlines|when|that|what|about|goes|against|watch|alert|ping|says|said|could|would|should|might|hurt|help|helps|hurts|position|trade|trades|market|markets|mine|they|them|this|those|these|every|story|stories|move|moves)$/.test(w));
    return { kind: 'keywords', market, keys: keys.slice(0, 8) };
  }
  function agentsList() {
    const mk = followed();
    const off = new Set(cfg.agents.off || []);
    return [
      ...BUILTIN_AGENTS.map((a) => ({ ...a, builtin: true, on: !off.has(a.id) })),
      ...mk.map((m) => ({ id: `m:${m}`, label: NEWS_MARKETS[m].label, desc: `Every story that moves ${NEWS_MARKETS[m].short}.`, builtin: true, market: m, on: !off.has(`m:${m}`) })),
      ...(cfg.agents.custom || []).map((a) => ({ ...a, label: a.label || 'Your agent', desc: a.text, custom: true, rule: parseAgent(a.text) })),
    ];
  }
  const sideFor = (x, m) => (x.impacts?.[m] > 0 ? 'helps' : x.impacts?.[m] < 0 ? 'hurts' : 'note');
  function matchBuiltin(a, x) {
    if (x.importance < 2 || x.filler) return null;
    if (a.id === 'fed' && x.cats.includes('fed')) return x.driver ? `${DRIVERS[x.driver].label} Fed` : 'Fed';
    if (a.id === 'data' && (x.src === 'calendar' || x.cats.includes('data')) && x.driver) return DRIVERS[x.driver].label;
    if (a.id === 'trump' && x.cats.includes('trump') && (x.driver || x.importance >= 3)) return x.driver ? `Trump · ${DRIVERS[x.driver].label}` : 'Trump';
    if (a.id === 'geo' && x.cats.includes('wars') && x.driver) return DRIVERS[x.driver].label;
    if (a.market && x.impacts?.[a.market]) return `${x.impacts[a.market] > 0 ? 'Helps' : 'Hurts'} ${NEWS_MARKETS[a.market].short}`;
    return null;
  }
  function matchCustom(a, x) {
    const r = a.rule;
    if (!r || x.filler) return null;
    if (r.kind === 'position') {
      const v = x.impacts?.[r.market];
      if (!v || x.importance < 2) return null;
      if (!r.both && v === r.side) return null;
      return v === r.side ? `In favor of your ${r.side > 0 ? 'long' : 'short'}` : `Against your ${r.side > 0 ? 'long' : 'short'}`;
    }
    if (r.kind === 'keywords' && r.keys?.length) {
      const hit = keyHits(r, x);
      return hit.length && (hit.length >= Math.min(2, r.keys.length) || x.importance >= 2) ? `Mentions ${hit.slice(0, 3).join(', ')}` : null;
    }
    return null;
  }
  const stem = (w) => w.slice(0, 6); // "semiconductors" ~ "semiconductor"
  function keyHits(r, x) {
    const w = new Set(words(`${x.title} ${x.summary}`).map(stem));
    return (r.keys || []).filter((k) => w.has(stem(k)));
  }
  function alertFor(x, hits) {
    const mk = followed();
    const market = hits.find((h) => h.market)?.market || mk.find((m) => x.impacts?.[m]) || null;
    const a = { id: hash(`${x.id}|${hits.map((h) => h.agent).join(',')}|${now()}`), t: now(), at: x.t, itemId: x.id, title: x.title, src: x.src, agents: hits.map((h) => h.label), why: hits.map((h) => h.why).filter(Boolean)[0] || '', side: market ? sideFor(x, market) : 'note', market, read: false };
    return a;
  }
  async function pushAlert(a) {
    if (alerts.some((b) => b.itemId === a.itemId && !b.kind)) return; // one alert per line
    if (a.market) a.price = await priceAt(a.market, now()).catch(() => null);
    alerts.push(a);
    saveAlerts();
  }
  function runAgents(x) {
    const hits = [];
    for (const a of agentsList()) {
      if (!a.on && !a.custom) continue;
      if (a.custom && a.on === false) continue;
      if (a.custom && a.rule?.kind === 'move') continue; // checked once the 15-minute move is known
      const why = a.custom ? (cfg.ai?.on && a.rule?.kind === 'keywords' ? null : matchCustom(a, x)) : matchBuiltin(a, x);
      if (why) hits.push({ agent: a.id, label: a.label, why, market: a.market || a.rule?.market || null });
      if (a.custom && cfg.ai?.on && a.on !== false && a.rule?.kind !== 'move' && (x.importance >= 2 || (a.rule?.kind === 'keywords' && keyHits(a.rule, x).length))) aiAgentQueue.push({ agentId: a.id, itemId: x.id });
    }
    if (hits.length) pushAlert(alertFor(x, hits)).catch(() => {});
  }
  function moveAgents(x, m) {
    for (const a of agentsList()) {
      if (!a.custom || a.on === false || a.rule?.kind !== 'move' || a.rule.market !== m) continue;
      const mv = x.move?.[m];
      if (!mv) continue;
      const size = a.rule.pct ? Math.abs(mv.chg / mv.p0) * 100 : Math.abs(mv.chg);
      if (size < a.rule.threshold) continue;
      const al = alertFor(x, [{ agent: a.id, label: a.label, why: `${NEWS_MARKETS[m].short} moved ${mv.chg > 0 ? '+' : ''}${a.rule.pct ? `${((mv.chg / mv.p0) * 100).toFixed(2)}%` : mv.chg} in the 15 minutes after`, market: m }]);
      al.kind = 'move'; al.side = mv.chg > 0 ? 'helps' : 'hurts'; al.price = mv.p0; al.move = mv.chg;
      alerts.push(al); saveAlerts();
    }
  }

  // ---------- optional AI (your Trading Coach's provider) ----------
  const aiQueue = [], aiAgentQueue = [];
  const aiCalls = [];
  function aiCfg() {
    const coach = readSettings()?.coach || {};
    const id = coach.provider;
    if (!id || id === 'local') return null;
    const c = coach.providers?.[id] || {};
    const defaults = { anthropic: ['https://api.anthropic.com', 'claude-haiku-5-5'], openai: ['https://api.openai.com/v1', 'gpt-4.1-mini'], google: ['https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-flash'], ollama: ['http://localhost:11434', 'llama3.1'], ollamaCloud: ['https://ollama.com', 'gpt-oss:120b'] }[id];
    if (!defaults) return null;
    const key = c.apiKey === '__vault__' ? vault?.get(`ai:${id}`) : c.apiKey;
    return { id, key: key || '', base: String(c.base || defaults[0]).replace(/\/+$/, ''), model: c.model || defaults[1] };
  }
  async function aiChat(system, user, maxTokens = 900) {
    const c = aiCfg();
    if (!c) throw new Error('No AI provider is set up in the Trading Coach');
    const cutoff = now() - HOUR;
    while (aiCalls.length && aiCalls[0] < cutoff) aiCalls.shift();
    if (aiCalls.length >= (cfg.ai?.perHour || 40)) throw new Error('AI limit for this hour reached');
    aiCalls.push(now());
    const post = async (url, body, headers) => {
      const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      return j;
    };
    if (c.id === 'anthropic') { const j = await post(`${c.base}/v1/messages`, { model: c.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }, { 'x-api-key': c.key, 'anthropic-version': '2023-06-01' }); return (j.content || []).filter((p) => p.type === 'text').map((p) => p.text).join(''); }
    if (c.id === 'openai') { const j = await post(`${c.base}/chat/completions`, { model: c.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, c.key ? { Authorization: `Bearer ${c.key}` } : {}); return j.choices?.[0]?.message?.content || ''; }
    if (c.id === 'google') { const j = await post(`${c.base}/models/${encodeURIComponent(c.model)}:generateContent`, { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }] }, { 'x-goog-api-key': c.key }); return (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join(''); }
    const j = await post(`${c.base}/api/chat`, { model: c.model, stream: false, think: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, c.key ? { Authorization: `Bearer ${c.key}` } : {});
    return j.message?.content || '';
  }
  const jsonIn = (s) => { const m = /\[[\s\S]*\]|\{[\s\S]*\}/.exec(String(s || '')); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } };
  async function aiRound() {
    if (!cfg.ai?.on) { aiQueue.length = 0; aiAgentQueue.length = 0; return; }
    // read the important lines (up to 8 at a time)
    const ids = aiQueue.splice(0, 8);
    const items = ids.map(byId).filter(Boolean);
    if (items.length) {
      try {
        const sys = `You read market headlines for a futures trader. For each numbered headline return a JSON array of objects {"i": number, "driver": one of ${JSON.stringify(Object.keys(DRIVERS))} or null, "importance": 1-3 (3 = moves markets now), "story": 2-4 word story name, "ccy": the country's currency if it is about a non-US central bank or data, else "USD"}. Only the JSON array.`;
        const out = jsonIn(await aiChat(sys, items.map((x, i) => `${i + 1}. ${x.title}${x.summary ? ` — ${x.summary.slice(0, 200)}` : ''}`).join('\n')));
        for (const r of Array.isArray(out) ? out : []) {
          const x = items[(r.i || 0) - 1];
          if (!x) continue;
          if (r.driver === null || DRIVERS[r.driver]) x.driver = r.driver || null;
          if ([1, 2, 3].includes(r.importance)) x.importance = r.importance;
          if (typeof r.story === 'string' && r.story.length < 40) x.storyTitle = r.story;
          if (typeof r.ccy === 'string') x.ccy = r.ccy.toUpperCase();
          x.impacts = impactsFor({ driver: x.driver, ccy: x.ccy }, Object.keys(NEWS_MARKETS));
          x.by = 'ai';
          dirty.add(nyDate(x.t));
        }
        flush();
      } catch (e) { log('[news] AI', e.message); }
    }
    // sentence agents: does this line matter to "<your sentence>"?
    const jobs = aiAgentQueue.splice(0, 10);
    const byAgent = new Map();
    for (const j of jobs) { if (!byAgent.has(j.agentId)) byAgent.set(j.agentId, []); byAgent.get(j.agentId).push(j.itemId); }
    for (const [agentId, itemIds] of byAgent) {
      const a = agentsList().find((x) => x.id === agentId);
      const xs = itemIds.map(byId).filter(Boolean);
      if (!a || !xs.length) continue;
      try {
        const sys = 'You watch market headlines for a futures trader. The trader asked: "' + String(a.text).slice(0, 300) + '". For each numbered headline decide if it matters to that request. Return a JSON array of {"i": number, "match": true|false, "why": one short sentence a trader would read in an alert}. Only the JSON array.';
        const out = jsonIn(await aiChat(sys, xs.map((x, i) => `${i + 1}. ${x.title}`).join('\n'), 600));
        for (const r of Array.isArray(out) ? out : []) {
          const x = xs[(r.i || 0) - 1];
          if (x && r.match) await pushAlert(alertFor(x, [{ agent: a.id, label: a.label, why: String(r.why || '').slice(0, 160), market: a.rule?.market || null }]));
        }
      } catch (e) { log('[news] AI agent', e.message); }
    }
  }

  // ---------- views ----------
  function stories(hours = 24) {
    const list = recent(hours * HOUR).filter((x) => !x.repeatOf && x.story !== 'other');
    const by = new Map();
    for (const x of list) {
      const s = by.get(x.story) || { key: x.story, title: x.storyTitle, n: 0, first: x.t, last: x.t, top: null, drivers: {} };
      s.n++; s.first = Math.min(s.first, x.t); s.last = Math.max(s.last, x.t);
      if (!s.top || x.importance > s.top.importance || (x.importance === s.top.importance && x.t > s.top.t)) s.top = x;
      if (x.driver) s.drivers[x.driver] = (s.drivers[x.driver] || 0) + x.importance * Math.exp(-(now() - x.t) / (6 * HOUR));
      by.set(x.story, s);
    }
    return [...by.values()].map((s) => {
      const driver = Object.entries(s.drivers).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      return { key: s.key, title: s.title, n: s.n, first: s.first, last: s.last, driver, tone: driver ? DRIVERS[driver].label : null, top: s.top && { id: s.top.id, title: s.top.title, t: s.top.t } };
    }).sort((a, b) => b.last - a.last);
  }
  function flow(hours = 24) {
    const list = recent(Math.min(72, hours) * HOUR).slice(0, 600);
    // routine lines right after a key line in the same story fold under it
    const keys = list.filter((x) => x.importance >= 2 && !x.repeatOf);
    for (const x of list) {
      if (x.importance >= 2 || x.repeatOf) continue;
      const k = keys.find((y) => y.story === x.story && x.t >= y.t - 2 * MIN && x.t - y.t < 20 * MIN && y.id !== x.id);
      if (k) x.under = k.id; else delete x.under;
    }
    // a line that says the opposite of an earlier line in the same story (within 12 hours)
    for (const x of list) {
      delete x.opposite;
      if (!x.driver || !OPPOSITE[x.driver] || x.repeatOf) continue;
      const prev = list.find((y) => y.story === x.story && y.driver === OPPOSITE[x.driver] && y.t < x.t && x.t - y.t < 12 * HOUR && !y.repeatOf);
      if (prev) x.opposite = { id: prev.id, t: prev.t };
    }
    return { items: list, stories: stories(hours), markets: followed(), traded: followCache?.traded || [] };
  }
  function similar(id, market) {
    const x = byId(id);
    if (!x) return { items: [] };
    const out = [];
    for (let i = 0; i < KEEP_DAYS && out.length < 40; i++) {
      for (const y of dayItems(nyDate(now() - i * DAY))) {
        if (y.id === x.id || y.repeatOf || y.t >= x.t) continue;
        const sameTone = x.driver && y.driver === x.driver;
        const sameStory = y.story === x.story;
        if (!(sameTone && (sameStory || y.cats.some((c) => x.cats.includes(c))))) continue;
        out.push({ id: y.id, t: y.t, title: y.title, story: y.storyTitle, driver: y.driver, move: y.move?.[market] ?? null, sameStory });
      }
    }
    out.sort((a, b) => (b.sameStory - a.sameStory) || (b.t - a.t));
    const items = out.slice(0, 8);
    const moved = items.filter((y) => y.move);
    return { items, up: moved.filter((y) => y.move.chg > 0).length, down: moved.filter((y) => y.move.chg < 0).length, flat: moved.filter((y) => y.move.chg === 0).length };
  }

  // the heat map: every macro driver for one market, coloured by whether it helps or hurts
  async function heatmap(market) {
    const m = NEWS_MARKETS[market] ? market : followed()[0];
    const tiles = [];
    const age = (t) => now() - t;
    const tile = (group, title, v, t, sub, ids = [], extra = {}) => tiles.push({ group, title, v: Math.max(-1, Math.min(1, v)), t, sub, ids, ...extra });
    // stories in the news
    for (const s of stories(24).slice(0, 8)) {
      const items = recent(24 * HOUR).filter((x) => x.story === s.key && !x.repeatOf);
      let v = 0, w = 0;
      for (const x of items) { const k = x.importance * Math.exp(-age(x.t) / (6 * HOUR)); v += (x.impacts?.[m] || 0) * k; w += k; }
      if (!w || !v) continue;
      tile('Stories', s.title, v / w, s.last, `${s.tone ? `${s.tone} · ` : ''}in the news for ${Math.max(1, Math.round((s.last - s.first) / HOUR))}h`, items.slice(0, 6).map((x) => x.id), { story: s.key });
    }
    // the Fed
    const fed = recent(12 * HOUR).filter((x) => x.cats.includes('fed') && x.driver && !x.repeatOf);
    if (fed.length) {
      const v = fed.reduce((a, x) => a + (x.impacts?.[m] || 0) * x.importance, 0) / fed.reduce((a, x) => a + x.importance, 0);
      const hawk = fed.filter((x) => ['hawkish'].includes(x.driver)).length, dove = fed.filter((x) => x.driver === 'dovish').length;
      tile('Fed', hawk >= dove ? 'Hawkish Fed comments' : 'Dovish Fed comments', v, fed[0].t, `${fed.length} comment${fed.length === 1 ? '' : 's'} in 12h`, fed.slice(0, 6).map((x) => x.id));
    }
    // data: the latest surprise of each kind this week
    const data = recent(7 * DAY).filter((x) => (x.src === 'calendar' || x.cats.includes('data')) && x.driver && !x.repeatOf);
    const kinds = [['Inflation', /hotInflation|coolInflation/], ['Jobs', null, /payroll|jobs|employment|jobless|claims|unemploy|adp|jolts/i], ['Growth', null, /gdp|retail|ism|pmi|industrial|durable|confidence|sentiment|housing/i]];
    for (const [name, drv, txt] of kinds) {
      const x = data.find((y) => (drv ? drv.test(y.driver) : txt.test(y.title)) && (drv || /strongData|weakData/.test(y.driver)));
      if (!x) continue;
      const label = { hotInflation: 'Hot inflation data', coolInflation: 'Cool inflation data', strongData: `Strong ${name.toLowerCase()} data`, weakData: `Weak ${name.toLowerCase()} data` }[x.driver];
      tile('Data', label, (x.impacts?.[m] || 0) * Math.max(0.4, Math.exp(-age(x.t) / (3 * DAY))), x.t, x.title.replace(/^USD /, ''), [x.id]);
    }
    // rates, the dollar and linked markets (free Yahoo prices)
    let trend = null;
    if (cfg.yahoo !== false) {
      const chg = async (sym, back) => { const r = await yahoo(sym, '5m', '5d'); if (r.length < 3) return null; const last = r[r.length - 1]; const ref = r.find((x) => x[0] >= last[0] - back / 1000) || r[0]; return { last: last[4], chg: last[4] - ref[4], t: last[0] * 1000 }; };
      const lk = [
        ['Rates and USD', 'DX-Y.NYB', 'USD', 'usd', 0.15], ['Rates and USD', '2YY=F', '2-year yield', 'yields', 0.02], ['Rates and USD', '^TNX', '10-year yield', 'yields', 0.02],
        ['Linked markets', 'CL=F', 'Oil', 'oil', 0.4], ['Linked markets', 'GC=F', 'Gold', 'gold', 8], ['Linked markets', '^VIX', 'VIX', 'vix', 0.6],
      ];
      for (const [group, sym, name, kind, unit] of lk) {
        if ((kind === 'oil' && NEWS_MARKETS[m].cls === 'oil') || (kind === 'gold' && m === 'GC')) continue;
        try {
          const c = await chg(sym, 2 * HOUR);
          if (!c || !Number.isFinite(c.chg)) continue;
          const up = c.chg > 0, size = Math.min(1, Math.abs(c.chg) / unit);
          const drv = kind === 'usd' ? (up ? 'usdUp' : 'usdDown') : kind === 'yields' ? (up ? 'yieldsUp' : 'yieldsDown') : kind === 'vix' ? (up ? 'riskOff' : 'riskOn') : null;
          let v = drv ? impactsFor({ driver: drv, ccy: 'USD' }, [m])[m] || 0 : 0;
          if (kind === 'oil') v = NEWS_MARKETS[m].cls === 'equity' ? (up ? -0.5 : 0.5) : NEWS_MARKETS[m].cls === 'gold' ? (up ? 0.3 : -0.3) : 0;
          if (kind === 'gold') v = NEWS_MARKETS[m].cls === 'equity' ? (up ? -0.3 : 0.3) : NEWS_MARKETS[m].cls === 'fx' ? (up ? 0.3 : -0.3) : 0;
          const verb = kind === 'usd' ? (up ? 'Dollar bought' : 'Dollar sold') : kind === 'vix' ? (up ? 'Fear rising' : 'Fear easing') : `${name} ${up ? 'up' : 'down'}`;
          tile(group, kind === 'usd' || kind === 'vix' ? name : name, v * Math.max(0.25, size), c.t, `${verb} · ${c.chg > 0 ? '+' : ''}${Math.abs(c.chg) < 1 ? c.chg.toFixed(3) : c.chg.toFixed(2)} in 2h`, [], { price: c.last });
        } catch { /* skip */ }
      }
    }
    // price trend of the market itself: 5 minutes, 1 hour, 4 hours
    try {
      const today = await bars(m, nyDate(now()));
      const prev = await bars(m, nyDate(now() - DAY));
      const rows = [...prev, ...today];
      if (rows.length > 30) {
        const last = rows[rows.length - 1];
        const back = (min) => { const t = last[0] - min * 60; let r = rows[0]; for (const x of rows) { if (x[0] <= t) r = x; else break; } return last[4] - r[4]; };
        trend = [['5m', back(30)], ['1h', back(6 * 60)], ['4h', back(24 * 60)]].map(([tf, d]) => ({ tf, dir: d > 0 ? 1 : d < 0 ? -1 : 0, chg: d }));
      }
    } catch { /* none */ }
    const news = tiles.filter((x) => ['Stories', 'Fed', 'Data'].includes(x.group));
    const W = (x) => (x.group === 'Stories' ? 1.2 : x.group === 'Fed' ? 1.5 : x.group === 'Data' ? 1 : 0.6) * Math.max(0.3, Math.exp(-age(x.t) / DAY));
    const all = tiles.filter((x) => x.v);
    const bias = all.length ? all.reduce((a, x) => a + x.v * W(x), 0) / all.reduce((a, x) => a + W(x), 0) : 0;
    const agree = trend ? trend.filter((x) => Math.sign(x.dir) === Math.sign(bias) && bias !== 0).length : null;
    return { market: m, label: NEWS_MARKETS[m].label, bias, tiles, trend, agree, newsCount: news.length, markets: followed(), items: Object.fromEntries([...new Set(tiles.flatMap((x) => x.ids))].map((id) => [id, byId(id)]).filter(([, x]) => x).map(([id, x]) => [id, { id, t: x.t, title: x.title, driver: x.driver, impacts: x.impacts }])) };
  }

  // ---------- loop ----------
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const f of feeds()) { const st = status[f.id]; if (!st?.at || now() - st.at >= f.every * 1000) await pollFeed(f); }
      await pollKeyed();
      await pollCalendar();
      flush();
      await aiRound();
      await reactions();
    } catch (e) { log('[news]', e.message); } finally { running = false; }
  }
  function prune() { // keep 90 days of headlines
    try {
      const keep = nyDate(now() - KEEP_DAYS * DAY);
      for (const f of fs.readdirSync(path.join(dir, 'items'))) if (f.slice(0, 10) < keep) fs.rmSync(path.join(dir, 'items', f), { force: true });
    } catch { /* none yet */ }
    for (const d of days.keys()) if (d < nyDate(now() - 5 * DAY)) days.delete(d);
  }

  // ---------- HTTP ----------
  const send = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };
  const body = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 2e4) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } }); });
  const configView = () => ({
    sources: [...FEEDS.map((f) => ({ id: f.id, label: f.label, on: cfg.sources?.[f.id] !== false, status: status[f.id] || null })),
      { id: 'calendar', label: 'Your economic calendar (releases vs forecast)', on: true, fixed: true, status: status.calendar || null },
      { id: 'finnhub', label: 'Finnhub general news (free key)', on: cfg.sources?.finnhub !== false && !!vault?.get('news:finnhub'), keyed: true, hasKey: !!vault?.get('news:finnhub'), status: status.finnhub || null }],
    custom: (cfg.custom || []).map((f) => ({ ...f, status: status[f.id] || null })),
    markets: followed(), traded: followCache?.traded || [], extraMarkets: cfg.extraMarkets || [], all: Object.entries(NEWS_MARKETS).map(([k, v]) => ({ key: k, label: v.label })),
    ai: { on: !!cfg.ai?.on, perHour: cfg.ai?.perHour || 40, provider: aiCfg()?.id || null, usedThisHour: aiCalls.filter((t) => t > now() - HOUR).length },
    yahoo: cfg.yahoo !== false,
  });

  const handler = async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const route = u.pathname.replace(/^\/api\/macro\/news/, '') || '/';
    const q = (k) => u.searchParams.get(k);
    try {
      if (req.method === 'GET' && route === '/config') return send(res, 200, configView());
      if (req.method === 'POST' && route === '/config') {
        const b = await body(req);
        if (b.sources && typeof b.sources === 'object') for (const [k, v] of Object.entries(b.sources)) if (typeof v === 'boolean') cfg.sources[k] = v;
        if (Array.isArray(b.custom)) cfg.custom = b.custom.filter((f) => /^https?:\/\/\S+$/.test(f?.url || '')).slice(0, 20).map((f) => ({ id: f.id || `c-${hash(f.url)}`, label: String(f.label || new URL(f.url).hostname).slice(0, 60), url: f.url, on: f.on !== false }));
        if (Array.isArray(b.extraMarkets)) cfg.extraMarkets = b.extraMarkets.filter((m) => NEWS_MARKETS[m]);
        if (b.ai && typeof b.ai === 'object') cfg.ai = { on: !!b.ai.on, perHour: Math.max(5, Math.min(500, Number(b.ai.perHour) || cfg.ai?.perHour || 40)) };
        if (typeof b.yahoo === 'boolean') cfg.yahoo = b.yahoo;
        if (typeof b.finnhubKey === 'string' && vault) vault.set('news:finnhub', b.finnhubKey.trim() || null);
        followCache = null;
        saveCfg();
        return send(res, 200, configView());
      }
      if (req.method === 'GET' && route === '/flow') return send(res, 200, flow(Number(q('hours')) || 24));
      if (req.method === 'GET' && route === '/similar') return send(res, 200, similar(q('id'), q('market') || followed()[0]));
      if (req.method === 'GET' && route === '/heatmap') return send(res, 200, await heatmap(String(q('market') || '').toUpperCase()));
      if (req.method === 'GET' && route === '/agents') return send(res, 200, { agents: agentsList(), markets: followed(), ai: !!cfg.ai?.on && !!aiCfg() });
      if (req.method === 'POST' && route === '/agents') {
        const b = await body(req);
        const a = b.agent || {};
        if (b.action === 'toggle' && a.id) {
          const c = cfg.agents.custom.find((x) => x.id === a.id);
          if (c) c.on = !!a.on;
          else { const off = new Set(cfg.agents.off); if (a.on) off.delete(a.id); else off.add(a.id); cfg.agents.off = [...off]; }
        } else if (b.action === 'add' && typeof a.text === 'string' && a.text.trim()) {
          if (cfg.agents.custom.length >= 20) return send(res, 400, { error: 'Up to 20 of your own agents' });
          cfg.agents.custom.push({ id: `c-${hash(a.text + now())}`, label: String(a.label || '').slice(0, 40) || 'Your agent', text: a.text.trim().slice(0, 300), on: true });
        } else if (b.action === 'update' && a.id) {
          const c = cfg.agents.custom.find((x) => x.id === a.id);
          if (c && typeof a.text === 'string') c.text = a.text.trim().slice(0, 300);
          if (c && typeof a.label === 'string') c.label = a.label.slice(0, 40);
        } else if (b.action === 'delete' && a.id) cfg.agents.custom = cfg.agents.custom.filter((x) => x.id !== a.id);
        saveCfg();
        return send(res, 200, { agents: agentsList(), markets: followed(), ai: !!cfg.ai?.on && !!aiCfg() });
      }
      if (req.method === 'GET' && route === '/alerts') return send(res, 200, { alerts: alerts.slice(-100).reverse(), unread: alerts.filter((a) => !a.read).length });
      if (req.method === 'POST' && route === '/alerts/dismiss') { // gone from the top-bar pill (still listed on the Agents page)
        const b = await body(req);
        const ids = Array.isArray(b.ids) ? new Set(b.ids) : null;
        for (const a of alerts) if (!ids || ids.has(a.id)) { a.dismissed = true; a.read = true; }
        saveAlerts();
        return send(res, 200, { ok: true, unread: alerts.filter((a) => !a.read).length });
      }
      if (req.method === 'POST' && route === '/alerts/read') {
        const b = await body(req);
        const ids = Array.isArray(b.ids) ? new Set(b.ids) : null;
        for (const a of alerts) if (!ids || ids.has(a.id)) a.read = true;
        saveAlerts();
        return send(res, 200, { ok: true, unread: alerts.filter((a) => !a.read).length });
      }
      if (req.method === 'POST' && route === '/explain') {
        const b = await body(req);
        const x = byId(b.id);
        if (!x) return send(res, 404, { error: 'not found' });
        const market = NEWS_MARKETS[b.market] ? b.market : followed()[0];
        const chain = x.driver ? chainFor(x.driver, market) : [];
        let text = null;
        if (b.ai && cfg.ai?.on) {
          try { text = await aiChat('Explain in 2–3 short sentences, for a futures trader, how this headline usually moves the given market and why. Plain English, no advice.', `Headline: ${x.title}\nMarket: ${NEWS_MARKETS[market].label}`, 300); } catch (e) { text = null; }
        }
        return send(res, 200, { chain, text });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      log('[news]', e.message);
      return send(res, 502, { error: e.message });
    }
  };
  handler.tick = tick;
  handler.ingest = ingest;
  handler.flow = flow;
  handler.heatmap = heatmap;
  handler.similar = similar;
  handler.parseAgent = parseAgent;
  handler.alerts = () => alerts;
  handler.reactions = reactions;
  handler.start = () => {
    setTimeout(tick, 5000).unref?.();
    setInterval(tick, 30e3).unref?.();
    setInterval(prune, 6 * HOUR).unref?.();
  };
  return handler;
}
