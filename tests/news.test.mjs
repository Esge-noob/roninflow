import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFeed, createNewsHandler } from '../news.js';
import { classify, impactsFor, chainFor, newsMarketOf } from '../src/lib/newsRules.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tj-news-'));
const NOW = Date.parse('2026-11-18T19:30:00Z'); // 2:30 PM New York
const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map((i) => `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link><pubDate>${new Date(i.t).toUTCString()}</pubDate><description>&lt;p&gt;${i.summary || ''}&lt;/p&gt;</description></item>`).join('')}</channel></rss>`;

test('feeds: RSS and Atom, entities, CDATA and HTML stripped', () => {
  const a = parseFeed(rss([{ title: 'Fed holds rates &amp; signals patience', link: 'https://x/1', t: NOW, summary: 'Powell <b>speaks</b>' }]));
  assert.equal(a[0].title, 'Fed holds rates & signals patience');
  assert.equal(a[0].summary, 'Powell speaks');
  assert.equal(a[0].t, Math.floor(NOW / 1000) * 1000);
  const b = parseFeed('<feed><entry><title>Gold jumps</title><link href="https://y/2"/><updated>2026-11-18T19:00:00Z</updated><summary>Safe-haven buying</summary></entry></feed>');
  assert.deepEqual([b[0].title, b[0].link, b[0].summary], ['Gold jumps', 'https://y/2', 'Safe-haven buying']);
});

test('rules: story, tone, importance and how each market usually moves', () => {
  const h = classify('Nearly half of Fed policymakers see 2026 rate hike');
  assert.deepEqual([h.story, h.driver, h.importance], ['fed', 'hawkish', 2]);
  assert.deepEqual(impactsFor(h, ['ES', 'GC', 'CL']), { ES: -1, GC: -1 });
  assert.equal(classify('Fed holds rates, target range 3.50% to 3.75%').driver, null, 'as expected: not hawkish');
  assert.equal(classify('Fed holds rates, target range 3.50% to 3.75%').importance, 3);
  assert.equal(classify('Fed decision due at 14:00 ET').importance, 1, 'a notice');
  const i = classify('Iran says Hormuz shipping will return to normal');
  assert.deepEqual([i.story, i.driver], ['iran', 'deescalation']);
  assert.deepEqual(impactsFor(i, ['CL', 'GC', 'ES']), { CL: -1, GC: -1, ES: 1 });
  assert.equal(classify('US consumer prices rise 0.4% on the month, above the 0.3% forecast').driver, 'hotInflation');
  assert.equal(classify('Initial jobless claims 250K vs 220K est.').driver, 'weakData', 'claims: higher is weaker');
  assert.equal(classify('Trump threatens 50% tariffs on EU goods').driver, 'tariffsUp');
  assert.equal(classify('US and China agree to pause tariffs for 90 days').driver, 'tariffsDown');
  const e = classify('ECB Lagarde: no rush to cut rates further');
  assert.deepEqual([e.driver, e.ccy], ['hawkish', 'EUR']);
  assert.deepEqual(impactsFor(e, ['6E', 'ES', 'GC']), { '6E': 1 }, 'another central bank moves its own currency');
  assert.equal(chainFor('hawkish', 'GC').join(' → '), 'Hawkish → Rates stay high → Bonds pay more → Gold pays nothing → Sell gold, buy yield → Gold ▼');
  assert.equal(chainFor('deescalation', 'CL').at(-1), 'Oil ▼');
  assert.deepEqual(['MESZ6', 'MGC', 'MNQ 12-26', 'ZC'].map(newsMarketOf), ['ES', 'GC', 'NQ', null]);
});

function setup({ trades = [], feeds = {}, bars = {}, events = [], settings = {}, ai = null } = {}) {
  const dir = tmp();
  let clock = NOW;
  const vault = new Map();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (ai && /anthropic|openai|generativelanguage|11434/.test(url)) return { ok: true, status: 200, json: async () => ai(JSON.parse(opts.body)), text: async () => '' };
    const f = Object.entries(feeds).find(([k]) => url.includes(k));
    if (!f) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => (typeof f[1] === 'function' ? f[1]() : f[1]) };
  };
  const candles = { get: async (sym, date) => ({ interval: '1m', candles: (bars[sym] || []).filter((r) => new Date(r[0] * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === date) }) };
  const macro = { events: async () => events };
  const h = createNewsHandler(dir, { fetchImpl, now: () => clock, readTrades: () => trades, readSettings: () => settings, candles, macro, vault: { get: (k) => vault.get(k), set: (k, v) => vault.set(k, v) } });
  return { h, dir, calls, setClock: (t) => { clock = t; }, vault };
}
const res = () => { const r = { headers: {}, setHeader: (k, v) => { r.headers[k] = v; }, end: (b) => { r.body = JSON.parse(String(b)); } }; return r; };
const req = (url, method = 'GET', body) => ({ url, method, on(ev, cb) { if (ev === 'data' && body) cb(JSON.stringify(body)); if (ev === 'end') cb(); } });
const call = async (h, url, method, body) => { const r = res(); await h(req(url, method, body), r); return r.body; };
// 1-minute gold bars: flat at 4300, then -$12 from 2:00 PM
const goldBars = () => { const out = []; const t0 = Date.parse('2026-11-18T18:00:00Z') / 1000; for (let i = 0; i < 120; i++) { const p = i < 60 ? 4300 : 4288; out.push([t0 + i * 60, p, p, p, p, 10]); } return out; };

test('the flow: followed markets from your trades, repeats folded, a line that says the opposite', async () => {
  const t = NOW - 10 * 60e3;
  const { h } = setup({
    trades: [{ symbol: 'MGCZ6', entry: '2026-11-10T06:40:00' }, { symbol: 'MES', entry: '2026-11-12T07:00:00' }],
    feeds: {
      fxstreet: rss([{ title: 'Trump: sanctions on Iran will be raised, new strikes possible', link: 'a', t: t - 3600e3 }, { title: 'Nearly half of Fed policymakers see 2026 rate hike', link: 'b', t }]),
      investinglive: rss([{ title: 'Nearly half of Fed policymakers see a 2026 rate hike', link: 'c', t: t + 20e3 }, { title: 'Iran says Hormuz shipping will return to normal', link: 'd', t: t + 60e3 }]),
    },
  });
  await h.tick();
  const f = await call(h, '/api/macro/news/flow');
  assert.deepEqual(f.markets.sort(), ['ES', 'GC'], 'what you trade (micros count as the full-size market)');
  const fed = f.items.filter((x) => /Fed policymakers/.test(x.title));
  assert.equal(fed.length, 2);
  assert.ok(fed.some((x) => x.repeatOf), 'the second copy folds under the first');
  const calm = f.items.find((x) => /return to normal/.test(x.title));
  assert.equal(calm.driver, 'deescalation');
  assert.ok(calm.opposite, 'says the opposite of the earlier Iran line');
  assert.ok(f.stories.some((s) => s.key === 'iran') && f.stories.some((s) => s.key === 'fed'));
  // add a market by hand
  const c = await call(h, '/api/macro/news/config', 'POST', { extraMarkets: ['CL'] });
  assert.deepEqual(c.markets.sort(), ['CL', 'ES', 'GC']);
  assert.deepEqual(c.traded.sort(), ['ES', 'GC']);
});

test('agents: built-in alerts, your position, a move threshold; the move after each line; alerts read', async () => {
  const t = Date.parse('2026-11-18T19:00:00Z'); // 2:00 PM New York
  const { h, setClock } = setup({
    trades: [{ symbol: 'MGC', entry: '2026-11-17T06:40:00' }],
    bars: { GC: goldBars() },
    feeds: { fxstreet: () => rss([{ title: 'Fed policymakers see rate hike in 2026, inflation remains elevated', link: 'f1', t }]) },
  });
  setClock(t + 30e3);
  await call(h, '/api/macro/news/agents', 'POST', { action: 'add', agent: { text: "I'm long gold. Tell me if anything goes against it." } });
  await call(h, '/api/macro/news/agents', 'POST', { action: 'add', agent: { text: 'Anything that moves gold more than $10' } });
  const ag = await call(h, '/api/macro/news/agents');
  assert.ok(ag.agents.some((a) => a.id === 'm:GC'), 'an agent for each market you trade');
  assert.deepEqual(ag.agents.filter((a) => a.custom).map((a) => a.rule.kind), ['position', 'move']);
  await h.tick();
  let al = await call(h, '/api/macro/news/alerts');
  assert.equal(al.unread, 1, 'one alert per line, however many agents matched');
  const a = al.alerts[0];
  assert.ok(a.agents.includes('Fed') && a.agents.includes('Your agent') && a.agents.includes('Gold'));
  assert.equal(a.side, 'hurts'); assert.equal(a.market, 'GC');
  // 15 minutes later: the move after the line (and the "more than $10" agent fires)
  setClock(t + 16 * 60e3);
  await h.reactions();
  const f = await call(h, '/api/macro/news/flow');
  assert.deepEqual(f.items[0].move.GC, { p0: 4288, chg: 0 }, 'already down at the line, flat after');
  al = await call(h, '/api/macro/news/alerts');
  await call(h, '/api/macro/news/alerts/read', 'POST', {});
  assert.equal((await call(h, '/api/macro/news/alerts')).unread, 0);
});

test('your calendar’s releases become headlines with their surprise; similar earlier lines with the move after', async () => {
  const t = Date.parse('2026-11-18T18:00:00Z'), t2 = t + 3 * 3600e3;
  const { h, setClock } = setup({
    trades: [{ symbol: 'GC', entry: '2026-11-17T06:40:00' }],
    bars: { GC: goldBars() },
    events: [{ ccy: 'USD', title: 'CPI m/m', t: new Date(t).toISOString(), impact: 'high', actual: '0.4%', forecast: '0.3%', previous: '0.2%' }, { ccy: 'USD', title: 'Retail Sales m/m', t: new Date(t + 3600e3).toISOString(), impact: 'medium', actual: '', forecast: '0.5%' }],
  });
  setClock(t2);
  await h.tick();
  const f = await call(h, '/api/macro/news/flow');
  const cpi = f.items.find((x) => x.src === 'calendar');
  assert.equal(cpi.title, 'USD CPI m/m: 0.4% vs 0.3% forecast (prior 0.2%)');
  assert.deepEqual([cpi.driver, cpi.importance, cpi.impacts.GC], ['hotInflation', 3, -1]);
  assert.equal(f.items.filter((x) => x.src === 'calendar').length, 1, 'not before the actual is out');
  // a later hot print finds this one as similar news, with gold's move after it
  h.ingest({ title: 'US PPI 0.5% vs 0.2% expected', t: t2 - 60e3, link: 'p' }, 'fxstreet');
  const later = (await call(h, '/api/macro/news/flow')).items.find((x) => /PPI/.test(x.title));
  await h.reactions();
  const sim = await call(h, `/api/macro/news/similar?id=${later.id}&market=GC`);
  assert.equal(sim.items[0].id, cpi.id);
});

test('heat map: stories, the Fed and data coloured for your market; price trend', async () => {
  const t = Date.parse('2026-11-18T19:00:00Z');
  const { h, setClock } = setup({ trades: [{ symbol: 'GC', entry: '2026-11-17T06:40:00' }], bars: { GC: goldBars() } });
  setClock(t + 50 * 60e3);
  await call(h, '/api/macro/news/config', 'POST', { yahoo: false });
  h.ingest({ title: 'Waller: a December cut is on the table', t: t + 60e3, link: '1' }, 'fxstreet');
  h.ingest({ title: 'Israel launches airstrikes on targets in Lebanon', t: t + 120e3, link: '2' }, 'fxstreet');
  const m = await call(h, '/api/macro/news/heatmap?market=GC');
  const fed = m.tiles.find((x) => x.group === 'Fed');
  assert.equal(fed.title, 'Dovish Fed comments'); assert.ok(fed.v > 0, 'dovish helps gold');
  assert.ok(m.tiles.find((x) => x.group === 'Stories' && x.story === 'middle-east').v > 0, 'war risk helps gold');
  assert.ok(m.bias > 0);
  assert.equal(m.trend.length, 3);
  assert.ok(m.items[fed.ids[0]], 'tap a tile: the headlines behind it');
});

test('optional AI: important lines read by your coach’s model; sentence agents answered by it', async () => {
  const seen = [];
  const ai = (body) => {
    seen.push(body);
    const q = body.messages.at(-1).content;
    if (/trader asked/.test(body.system)) return { content: [{ type: 'text', text: '[{"i":1,"match":true,"why":"Tariffs hit chip makers you hold."}]' }] };
    return { content: [{ type: 'text', text: `[{"i":1,"driver":"tariffsUp","importance":3,"story":"Chip tariffs","ccy":"USD"}]${q ? '' : ''}` }] };
  };
  const { h, vault } = setup({ trades: [{ symbol: 'NQ', entry: '2026-11-17T06:40:00' }], settings: { coach: { provider: 'anthropic', providers: { anthropic: { apiKey: '__vault__', model: 'claude-haiku-5-5' } } } }, ai });
  vault.set('ai:anthropic', 'sk-test');
  await call(h, '/api/macro/news/config', 'POST', { ai: { on: true, perHour: 10 } });
  await call(h, '/api/macro/news/agents', 'POST', { action: 'add', agent: { text: 'Anything about semiconductors that could hurt my Nasdaq position' } });
  h.ingest({ title: 'White House weighs broad semiconductor levies', t: NOW - 60e3, link: 's' }, 'cnbc');
  // the line has no rule match ("levies"), so importance 1 — the sentence agent still asks the AI (it mentions semiconductors)
  await h.tick();
  const f = await call(h, '/api/macro/news/flow');
  const x = f.items.find((y) => /semiconductor/.test(y.title));
  assert.equal(seen[0].system.includes('trader asked') || seen.some((b) => b.system.includes('trader asked')), true);
  const al = await call(h, '/api/macro/news/alerts');
  assert.equal(al.alerts[0].why, 'Tariffs hit chip makers you hold.');
  assert.ok(x);
  assert.equal(seen[0].messages ? true : false, true);
});
