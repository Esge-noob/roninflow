// Made-up news for the public demo: a day of headlines read by the same built-in rules as the real thing, with
// made-up 15-minute moves, a heat map, agents and a couple of alerts. Loaded only on the demo site.
import { classify, impactsFor, chainFor, NEWS_MARKETS, DRIVERS, OPPOSITE } from './newsRules';

const MIN = 60e3, HOUR = 60 * MIN;
const LINES = [ // [minutes ago, source, headline]
  [4, 'investinglive', 'Nearly half of Fed policymakers see a rate hike in 2026'],
  [5, 'investinglive', 'Fed: uncertainty about the outlook remains elevated'],
  [5, 'fxstreet', 'Fed: inflation remains somewhat elevated'],
  [6, 'fed-press', 'Fed holds rates, target range 3.50% to 3.75%'],
  [6, 'cnbc', 'Fed holds rates steady, as expected'],
  [14, 'investinglive', 'Fed decision due at 14:00 ET'],
  [27, 'fxstreet', 'Iran says Hormuz shipping will return to normal'],
  [38, 'investing', 'Brazil real weakens 0.3% vs USD'],
  [45, 'investinglive', 'Iran says US and Iran presidents could sign a deal'],
  [52, 'truth', 'Trump: sanctions on Iran will be raised, new strikes possible if talks fail'],
  [57, 'investinglive', 'Trump: sanctions on Iran will be raised (repeat)'],
  [70, 'marketwatch', 'Dollar slips for a third day as yields ease'],
  [95, 'calendar', 'USD Retail Sales m/m: 0.8% vs 0.4% forecast (prior 0.2%)'],
  [130, 'fxstreet', 'EIA crude inventories fall 4.2M barrels vs -1.1M expected'],
  [170, 'cnbc', 'US and China agree to pause new tariffs for 90 days'],
  [210, 'investinglive', 'Waller: a December cut is on the table'],
  [260, 'calendar', 'USD Initial Jobless Claims: 238K vs 225K forecast (prior 221K)'],
  [300, 'fxstreet', 'Israel launches airstrikes on targets in southern Lebanon'],
  [380, 'investing', 'ECB Lagarde: no rush to cut rates further'],
  [460, 'cnbc', 'Nvidia shares jump 4% ahead of earnings'],
  [520, 'truth', 'Trump threatens 25% tariffs on European cars'],
  [600, 'investinglive', 'Japan finance minister: watching the yen closely'],
  [720, 'marketwatch', 'Stocks rally to record high as tech leads'],
];
const PRICE = { ES: 6050, NQ: 21500, YM: 44800, RTY: 2390, CL: 61.4, NG: 3.1, GC: 4310, SI: 52, HG: 4.9, ZN: 111.5, ZB: 117, '6E': 1.158, '6B': 1.32, '6J': 0.0066, '6A': 0.66, '6C': 0.72, BTC: 98000 };
const SIZE = { ES: 6, NQ: 30, YM: 50, RTY: 4, CL: 0.35, NG: 0.03, GC: 9, SI: 0.25, HG: 0.03, ZN: 0.12, ZB: 0.25, '6E': 0.0012, '6B': 0.0012, '6J': 0.00002, '6A': 0.001, '6C': 0.0008, BTC: 600 };
const rnd = (seed) => { const x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); };

let readAll = 0; // alerts marked read in this browser session
let extra = [];
let custom = [{ id: 'c-demo', label: 'Your agent', text: "I'm long gold. Tell me if anything goes against it.", on: true }];

function items() {
  const now = Date.now();
  const base = Math.floor(now / (10 * MIN)) * 10 * MIN; // lines stay put for ten minutes at a time
  const out = LINES.map(([ago, src, title], i) => {
    const c = classify(title, { src });
    const t = base - ago * MIN;
    const move = {};
    for (const m of Object.keys(NEWS_MARKETS)) {
      if (t + 15 * MIN > now) continue;
      const v = impactsFor(c, [m])[m] || 0;
      const r = rnd(i * 31 + m.length * 7 + m.charCodeAt(0));
      const chg = (v * (0.6 + r * 1.6) * c.importance + (r - 0.5) * 0.6) * SIZE[m];
      move[m] = { p0: PRICE[m], chg: Math.round(chg * 10000) / 10000 };
    }
    return { id: `d${i}`, t, src, title, summary: '', cats: c.cats, story: c.story, storyTitle: c.storyTitle, driver: c.driver, importance: c.importance, ccy: c.ccy, filler: !!c.filler, impacts: impactsFor(c, Object.keys(NEWS_MARKETS)), move, by: 'rules' };
  });
  out[4].repeatOf = 'd3'; out[10].repeatOf = 'd9';
  // fold routine lines under the key line; mark the opposite line
  for (const x of out) {
    if (x.importance < 2 && !x.repeatOf) { const k = out.find((y) => y.importance >= 2 && y.story === x.story && x.t >= y.t - 2 * MIN && x.t - y.t < 20 * MIN && y.id !== x.id); if (k) x.under = k.id; }
    if (x.driver && OPPOSITE[x.driver]) { const p = out.find((y) => y.story === x.story && y.driver === OPPOSITE[x.driver] && y.t < x.t && x.t - y.t < 12 * HOUR); if (p) x.opposite = { id: p.id, t: p.t }; }
  }
  return out;
}
function stories(list) {
  const by = new Map();
  for (const x of list.filter((y) => !y.repeatOf && y.story !== 'other')) {
    const s = by.get(x.story) || { key: x.story, title: x.storyTitle, n: 0, first: x.t, last: x.t, drivers: {}, top: null };
    s.n++; s.first = Math.min(s.first, x.t); s.last = Math.max(s.last, x.t);
    if (x.driver) s.drivers[x.driver] = (s.drivers[x.driver] || 0) + x.importance;
    if (!s.top || x.importance > s.top.importance) s.top = x;
    by.set(x.story, s);
  }
  return [...by.values()].map((s) => { const d = Object.entries(s.drivers).sort((a, b) => b[1] - a[1])[0]?.[0] || null; return { key: s.key, title: s.title, n: s.n, first: s.first, last: s.last, driver: d, tone: d ? DRIVERS[d].label : null, top: { id: s.top.id, title: s.top.title, t: s.top.t } }; }).sort((a, b) => b.last - a.last);
}
function markets() {
  let traded = ['ES', 'NQ', 'GC'];
  try { const t = JSON.parse(localStorage.getItem('roninflow-demo-v1') || '{}').trades || []; const set = new Set(); for (const x of t) { const r = String(x.symbol || '').toUpperCase(); const m = r.startsWith('MES') || r.startsWith('ES') ? 'ES' : r.startsWith('MNQ') || r.startsWith('NQ') ? 'NQ' : r.startsWith('MGC') || r.startsWith('GC') ? 'GC' : r.startsWith('MCL') || r.startsWith('CL') ? 'CL' : null; if (m) set.add(m); } if (set.size) traded = [...set]; } catch { /* default */ }
  return { traded, list: [...new Set([...traded, ...extra])] };
}
function alerts() {
  const list = items();
  const pick = (id, agents, why, market) => { const x = list.find((y) => y.id === id); return { id: `a${id}`, t: x.t + 4000, at: x.t, itemId: id, title: x.title, src: x.src, agents, why, market, side: x.impacts[market] > 0 ? 'helps' : x.impacts[market] < 0 ? 'hurts' : 'note', price: PRICE[market], move: x.move[market]?.chg ?? undefined }; };
  const out = [pick('d0', ['Fed', 'Your agent', 'Gold'], 'Hawkish Fed', 'GC'), pick('d6', ['Geopolitics', 'Gold'], 'Calming down', 'GC'), pick('d9', ['Trump', 'Geopolitics'], 'Trump · Getting worse', 'ES'), pick('d12', ['Data', 'S&P 500'], 'Strong data', 'ES')];
  return out.map((a, i) => ({ ...a, read: a.t <= readAll || i > 1 }));
}
function heatmap(market) {
  const list = items(), now = Date.now();
  const m = NEWS_MARKETS[market] ? market : markets().list[0];
  const tiles = [];
  const tile = (group, title, v, t, sub, ids, extra2 = {}) => tiles.push({ group, title, v: Math.max(-1, Math.min(1, v)), t, sub, ids, ...extra2 });
  for (const s of stories(list).slice(0, 6)) {
    const xs = list.filter((x) => x.story === s.key && !x.repeatOf);
    let v = 0, w = 0;
    for (const x of xs) { const k = x.importance * Math.exp(-(now - x.t) / (6 * HOUR)); v += (x.impacts[m] || 0) * k; w += k; }
    if (v) tile('Stories', s.title, v / w, s.last, `${s.tone ? `${s.tone} · ` : ''}in the news for ${Math.max(1, Math.round((s.last - s.first) / HOUR))}h`, xs.slice(0, 5).map((x) => x.id), { story: s.key });
  }
  const fed = list.filter((x) => x.cats.includes('fed') && x.driver && !x.repeatOf);
  if (fed.length) tile('Fed', fed.filter((x) => x.driver === 'hawkish').length >= fed.filter((x) => x.driver === 'dovish').length ? 'Hawkish Fed comments' : 'Dovish Fed comments', fed.reduce((a, x) => a + (x.impacts[m] || 0) * x.importance, 0) / fed.reduce((a, x) => a + x.importance, 0), fed[0].t, `${fed.length} comments in 12h`, fed.map((x) => x.id));
  for (const id of ['d12', 'd16']) { const x = list.find((y) => y.id === id); tile('Data', x.driver === 'strongData' ? 'Strong growth data' : 'Weak jobs data', (x.impacts[m] || 0) * 0.8, x.t, x.title.replace(/^USD /, ''), [id]); }
  const L = (group, title, v, sub, ago) => tile(group, title, v, now - ago * MIN, sub, []);
  const cls = NEWS_MARKETS[m].cls;
  L('Rates and USD', 'USD', { gold: 0.6, fx: 0.6, yen: 0.6, oil: 0.3, crypto: 0.3 }[cls] || 0.1, 'Dollar sold · -0.180 in 2h', 2);
  L('Rates and USD', '2-year yield', { equity: -0.5, gold: -0.5, bond: -0.5, fx: -0.4 }[cls] || -0.2, '2-year yield up · +0.031 in 2h', 2);
  L('Rates and USD', '10-year yield', { equity: 0.3, gold: 0.3, bond: 0.3 }[cls] || 0.1, '10-year yield down · -0.012 in 2h', 3);
  if (cls !== 'oil') L('Linked markets', 'Oil', cls === 'equity' ? 0.4 : cls === 'gold' ? -0.25 : 0, 'Oil down · -0.62 in 2h', 5);
  if (m !== 'GC') L('Linked markets', 'Gold', cls === 'equity' ? -0.2 : 0.2, 'Gold up · +6.40 in 2h', 5);
  L('Linked markets', 'VIX', cls === 'equity' ? -0.4 : cls === 'gold' ? 0.3 : -0.2, 'Fear rising · +0.70 in 2h', 4);
  const W = (x) => (x.group === 'Stories' ? 1.2 : x.group === 'Fed' ? 1.5 : x.group === 'Data' ? 1 : 0.6);
  const bias = tiles.reduce((a, x) => a + x.v * W(x), 0) / tiles.reduce((a, x) => a + W(x), 0);
  const trend = [['5m', -1], ['1h', 1], ['4h', 1]].map(([tf, dir], i) => ({ tf, dir: m === 'GC' ? -dir : dir, chg: dir * SIZE[m] * (i + 1) }));
  const agree = trend.filter((x) => Math.sign(x.dir) === Math.sign(bias)).length;
  return { market: m, label: NEWS_MARKETS[m].label, bias, tiles, trend, agree, markets: markets().list, items: Object.fromEntries(list.map((x) => [x.id, { id: x.id, t: x.t, title: x.title, driver: x.driver, impacts: x.impacts }])) };
}
function agents() {
  const mk = markets().list;
  return {
    agents: [
      { id: 'fed', label: 'Fed', desc: 'Every Fed speaker and decision, read as hawkish or dovish.', builtin: true, on: true },
      { id: 'data', label: 'Data', desc: 'Every release against its forecast.', builtin: true, on: true },
      { id: 'trump', label: 'Trump', desc: 'What Trump says and signs that can move markets.', builtin: true, on: true },
      { id: 'geo', label: 'Geopolitics', desc: 'Wars, sanctions and shipping lanes.', builtin: true, on: true },
      ...mk.map((m) => ({ id: `m:${m}`, label: NEWS_MARKETS[m].label, desc: `Every story that moves ${NEWS_MARKETS[m].short}.`, builtin: true, market: m, on: true })),
      ...custom.map((a) => ({ ...a, desc: a.text, custom: true, rule: /long|short/i.test(a.text) ? { kind: 'position', market: /gold/i.test(a.text) ? 'GC' : 'ES', side: /long/i.test(a.text) ? 1 : -1 } : { kind: 'keywords', keys: a.text.toLowerCase().split(/\W+/).filter((w) => w.length > 4).slice(0, 5) } })),
    ],
    markets: mk, ai: false,
  };
}
function config() {
  const { traded, list } = markets();
  const st = (n) => ({ at: Date.now() - 40e3, ok: true, n, error: null });
  return {
    sources: [['truth', 'Trump on Truth Social (trumpstruth.org)', 14], ['investinglive', 'investingLive (ForexLive)', 212], ['fxstreet', 'FXStreet news', 96], ['investing', 'Investing.com forex news', 61], ['cnbc', 'CNBC top news', 44], ['cnbc-economy', 'CNBC economy', 19], ['marketwatch', 'MarketWatch top stories', 37], ['fed-press', 'Federal Reserve press releases', 3], ['fed-speeches', 'Federal Reserve speeches', 2], ['bls', 'BLS data releases', 4], ['whitehouse', 'White House presidential actions', 6]].map(([id, label, n]) => ({ id, label, on: true, status: st(n) }))
      .concat([{ id: 'calendar', label: 'Your economic calendar (releases vs forecast)', on: true, fixed: true, status: st(9) }, { id: 'finnhub', label: 'Finnhub general news (free key)', on: false, keyed: true, hasKey: false, status: null }]),
    custom: [], markets: list, traded, extraMarkets: extra, all: Object.entries(NEWS_MARKETS).map(([k, v]) => ({ key: k, label: v.label })),
    ai: { on: false, perHour: 40, provider: null, usedThisHour: 0 }, yahoo: true, demo: true,
  };
}

export function demoNews(url, body) {
  const u = new URL(url, 'http://x');
  const r = u.pathname.replace(/^\/api\/macro\/news/, '');
  if (r === '/flow') { const list = items(); return { items: list, stories: stories(list), markets: markets().list, traded: markets().traded }; }
  if (r === '/heatmap') return heatmap(String(u.searchParams.get('market') || '').toUpperCase());
  if (r === '/similar') {
    const list = items(), x = list.find((y) => y.id === u.searchParams.get('id')), m = u.searchParams.get('market') || 'GC';
    if (!x?.driver) return { items: [] };
    const out = [1, 2, 3, 5, 8].map((d, i) => { const r2 = rnd(d * 13 + i); const v = impactsFor(x, [m])[m] || 0; const chg = (v * (0.3 + r2) + (r2 > 0.8 ? -v * 1.5 : 0)) * SIZE[m] * 2; return { id: `s${i}`, t: x.t - d * 86400e3 - i * 3 * HOUR, title: x.title.replace(/\d+(\.\d+)?%/, () => `${(r2 * 0.5).toFixed(1)}%`), story: x.storyTitle, driver: x.driver, move: { p0: PRICE[m], chg: Math.round(chg * 100) / 100 }, sameStory: true }; });
    return { items: out, up: out.filter((y) => y.move.chg > 0).length, down: out.filter((y) => y.move.chg < 0).length, flat: 0 };
  }
  if (r === '/agents') {
    if (body?.action === 'add' && body.agent?.text) custom.push({ id: `c-${Date.now()}`, label: 'Your agent', text: body.agent.text, on: true });
    if (body?.action === 'delete') custom = custom.filter((a) => a.id !== body.agent?.id);
    if (body?.action === 'toggle') custom = custom.map((a) => (a.id === body.agent?.id ? { ...a, on: body.agent.on } : a));
    return agents();
  }
  if (r === '/alerts') { const a = alerts(); return { alerts: a.slice().reverse().sort((x, y) => y.t - x.t), unread: a.filter((x) => !x.read).length }; }
  if (r === '/alerts/read') { readAll = Date.now(); return { ok: true, unread: 0 }; }
  if (r === '/config') { if (Array.isArray(body?.extraMarkets)) extra = body.extraMarkets; return config(); }
  if (r === '/explain') { const x = items().find((y) => y.id === body?.id); return { chain: x?.driver ? chainFor(x.driver, body.market) : [], text: null }; }
  return {};
}
