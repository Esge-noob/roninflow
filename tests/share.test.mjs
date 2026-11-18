import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeState, periodStart, createShareStore, isLive, tokenOk, isShareAsset, buildSnapshot, chartAllowed, embedCharts, embedTicks, sendShareChart } from '../share.js';
import zlib from 'node:zlib';
import { createCandleHandler } from '../candles.js';

const journal = () => ({
  version: 1,
  user: { name: 'Corey Heyman', handle: 'corey', email: 'me@example.com' },
  accounts: [
    { id: 'IQCFEV50K-200865', name: 'IQCFEV50K-200865', broker: 'ATAS', cost: 149, fees: 80, purchasedAt: '2026-10-01', initial: 50000, profitTarget: 3000, maxDrawdown: 2000, ddType: 'eod', status: 'Active', autoSync: true, login: 'secret-login' },
    { id: 'APEX-99887766', name: 'My Apex', initial: 100000, maxDrawdown: 3000, status: 'Breached' },
  ],
  trades: [
    { id: 't1', accountId: 'IQCFEV50K-200865', symbol: 'MESZ6', direction: 'Long', entry: '2026-11-03T09:31:00', exit: '2026-11-03T09:40:00', qty: 2, entryPrice: 6000, exitPrice: 6005, fees: 2, pnl: 48, notes: 'A+ setup', tags: ['ORB'], rating: 5, reviewed: true, atasId: 'ord-123', atasIds: ['ord-123'], source: 'atas', fills: [{ time: '2026-11-03T09:31:00', price: 6000, qty: 2, side: 'Buy', orderId: 'X1', account: 'IQCFEV50K-200865' }] },
    { id: 't2', accountId: 'APEX-99887766', symbol: 'MNQZ6', direction: 'Short', entry: '2026-10-20T10:00:00', exit: '2026-10-20T10:05:00', qty: 1, pnl: -30 },
    { id: 't3', accountId: 'IQCFEV50K-200865', symbol: 'MESZ6', direction: 'Long', entry: '2026-11-10T09:31:00', exit: '2026-11-10T09:40:00', qty: 1, pnl: 20 },
  ],
  payouts: [{ amount: 1500 }],
  notebook: { notes: [{ title: 'private' }] },
  chats: [{ m: 'hi' }],
  notifications: [{ x: 1 }],
  templates: [{ y: 1 }],
  diary: { '2026-11-03': { notes: 'calm day' }, '2026-11-10': { notes: 'later' } },
  reviews: { 'weekly:2026-11-02': { answers: { a: 'ok' } }, 'monthly:2026-10': { answers: {} }, 'weekly:2026-11-09': { answers: {} } },
  coachReviews: { 'weekly:2026-11-02': { text: 'coach' }, 'day:2026-11-10': { text: 'x' } },
  tags: ['ORB'],
  strategies: [{ id: 's1', name: 'ORB' }],
  settings: { account: 'IQCFEV50K-200865', theme: 'dark', currency: 'USD', sync: { token: 'abc', accounts: { 'IQCFEV50K-200865': { balance: 51000 } } }, coach: { apiKey: 'sk-secret' }, riskByAccount: { 'IQCFEV50K-200865': { profile: 'p1' }, gone: { x: 1 } }, reviewSync: { mode: 'all' }, privacy: false, dashLayouts: { 'My Dashboard': [] } },
});

test('account numbers and personal details never leave the journal', () => {
  const out = sanitizeState(journal());
  const text = JSON.stringify(out);
  for (const secret of ['IQCFEV50K-200865', 'APEX-99887766', 'My Apex', 'me@example.com', 'Heyman', 'secret-login', 'sk-secret', 'ord-123', 'X1', '"abc"', 'private', 'ATAS']) assert.ok(!text.includes(secret), `leaked ${secret}`);
  assert.deepEqual(out.accounts.map((a) => [a.id, a.name]), [['Account 1', 'Account 1'], ['Account 2', 'Account 2']]);
  assert.deepEqual(out.trades.map((t) => t.accountId), ['Account 1', 'Account 2', 'Account 1']);
  assert.equal(out.settings.account, 'Account 1');
  assert.deepEqual(Object.keys(out.settings.riskByAccount), ['Account 1']);
  assert.equal(out.user.name, 'Corey');
  for (const k of ['payouts']) assert.deepEqual(out[k], []);
  for (const k of ['notebook', 'chats', 'notifications', 'templates']) assert.equal(out[k], undefined);
  for (const k of ['sync', 'coach', 'reviewSync']) assert.equal(out.settings[k], undefined);
  assert.equal(out.accounts[0].cost, undefined);
  assert.equal(out.accounts[0].maxDrawdown, 2000); // the account's size and limits are kept
});

test('the journal itself is kept: trades, reviews, diary, strategies', () => {
  const out = sanitizeState(journal());
  const t1 = out.trades[0];
  assert.deepEqual([t1.symbol, t1.pnl, t1.notes, t1.tags, t1.rating, t1.reviewed], ['MESZ6', 48, 'A+ setup', ['ORB'], 5, true]);
  assert.deepEqual(t1.fills, [{ time: '2026-11-03T09:31:00', price: 6000, qty: 2, side: 'Buy' }]);
  assert.equal(out.diary['2026-11-03'].notes, 'calm day');
  assert.equal(out.reviews['weekly:2026-11-02'].answers.a, 'ok');
  assert.equal(out.strategies[0].name, 'ORB');
  assert.equal(out.settings.setupDone, true);
  assert.equal(out.settings.privacy, false);
  assert.equal(sanitizeState(journal(), undefined, { hideMoney: true }).settings.privacy, true);
});

test('a page with dates only carries those dates', () => {
  const out = sanitizeState(journal(), { kind: 'page', route: 'review/weekly/2026-11-02', from: '2026-10-26', to: '2026-11-08' });
  assert.deepEqual(out.trades.map((t) => t.id), ['t1']);
  assert.deepEqual(Object.keys(out.diary), ['2026-11-03']);
  assert.deepEqual(Object.keys(out.reviews), ['weekly:2026-11-02']);
  assert.deepEqual(Object.keys(out.coachReviews), ['weekly:2026-11-02']);
  // pages without dates keep the whole journal (still sanitized)
  assert.equal(sanitizeState(journal(), { kind: 'page', route: 'dashboard' }).trades.length, 3);
});

test('review keys → start dates', () => {
  assert.equal(periodStart('weekly:2026-11-02'), '2026-11-02');
  assert.equal(periodStart('day:2026-11-05'), '2026-11-05');
  assert.equal(periodStart('monthly:2026-10'), '2026-10-01');
  assert.equal(periodStart('quarterly:2026-Q4'), '2026-10-01');
  assert.equal(periodStart('yearly:2026'), '2026-01-01');
  assert.equal(periodStart('nonsense'), null);
});

test('links: create, expire, revoke, count views', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-share-'));
  const store = createShareStore(dir);
  const a = store.create({ scope: { kind: 'page', route: '#/review/weekly/2026-11-02', label: 'Week of Nov 2', from: '2026-10-26', to: '2026-11-08' }, expiresInDays: 7, hideMoney: true });
  assert.ok(tokenOk(a.token) && a.token.length >= 24);
  assert.equal(a.scope.route, 'review/weekly/2026-11-02');
  assert.ok(isLive(a));
  assert.ok(!isLive(a, Date.now() + 8 * 86400000)); // expired after 7 days
  const b = store.create({ scope: { kind: 'all' } });
  assert.equal(b.expiresAt, null);
  assert.equal(store.create({ scope: { kind: 'page', route: '<script>', from: 'x' } }).scope.route, ''); // junk is cleaned
  store.viewed(b.token); store.viewed(b.token);
  assert.equal(store.get(b.token).views, 2);
  assert.ok(store.revoke(b.token));
  assert.ok(!isLive(store.get(b.token)));
  assert.ok(store.remove(a.token));
  assert.equal(store.get(a.token), null);
  assert.ok(!tokenOk('../../etc') && !tokenOk('short'));
});

test('only the app’s files are public alongside a link', () => {
  for (const u of ['/assets/app-X1.js', '/assets/app-X1.css', '/favicon.svg', '/icons/favicon-64.png']) assert.ok(isShareAsset(u), u);
  for (const u of ['/api/data/state', '/index.html', '/assets/../journal.json', '/api/shares', '/sw.js']) assert.ok(!isShareAsset(u), u);
});

test('snapshot: one file with the app inlined and the view-only journal embedded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-dist-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><head><link rel="icon" href="/favicon.svg" /><title>RoninFlow</title><link rel="stylesheet" crossorigin href="/assets/a.css"></head><body><div id="root"></div><script type="module" crossorigin src="/assets/a.js"></script></body></html>');
  fs.writeFileSync(path.join(dir, 'assets', 'a.css'), 'body{color:red}');
  fs.writeFileSync(path.join(dir, 'assets', 'a.js'), 'console.log("</script>")');
  const html = buildSnapshot(dir, { trades: [{ notes: '</script><b>x' }] }, { label: 'Week <1>' });
  assert.ok(html.includes('<style>body{color:red}</style>'));
  assert.ok(!html.includes('src="/assets/a.js"') && !html.includes('/favicon.svg'));
  assert.equal((html.match(/<\/script>/g) || []).length, 2); // only the two real closing tags
  assert.ok(html.includes('window.__RF_SNAPSHOT__='));
  assert.ok(html.includes('<title>Week 1 · RoninFlow (view only)</title>'));
});

test('execution charts: a share loads prices only for its own symbols, around its trade days, never from a paid source', async () => {
  const data = { trades: [{ symbol: 'MESZ6', entry: '2026-11-13T06:45:00' }, { symbol: 'MNQZ6', entry: '2026-11-10T07:00:00' }] };
  assert.ok(chartAllowed(data, 'MESZ6', '2026-11-13'));
  assert.ok(chartAllowed(data, 'MESZ6', '2026-11-14'), 'a day after, for time zones');
  assert.ok(chartAllowed(data, 'MESZ6', '2026-10-09'), 'the 1d view reads 35 days back');
  assert.ok(!chartAllowed(data, 'MESZ6', '2026-11-16'));
  assert.ok(!chartAllowed(data, 'MESZ6', '2026-09-01'));
  assert.ok(!chartAllowed(data, 'ESZ6', '2026-11-13'), 'a symbol the share doesn’t show');
  assert.ok(!chartAllowed(data, 'MESZ6', '../x'));

  const asked = [];
  const candles = {
    get: async (symbol, date, tz, opts) => { asked.push([symbol, date, opts]); return { symbol, date, interval: '1m', source: 'x', candles: [[1, 2, 3, 1, 2, 5]] }; },
    lib: async () => Buffer.from('lib'),
  };
  const res = () => { const r = { headers: {}, setHeader: (k, v) => { r.headers[k] = v; }, end: (b) => { r.body = String(b); } }; return r; };
  const ok = res();
  await sendShareChart(ok, candles, data, 'candles', '/api/share/t/candles?symbol=MESZ6&date=2026-11-13&tz=America%2FLos_Angeles');
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).candles.length, 1);
  assert.deepEqual(asked[0][2], { noPaid: true });
  const no = res();
  await sendShareChart(no, candles, data, 'candles', '/api/share/t/candles?symbol=ESZ6&date=2026-11-13&tz=UTC');
  assert.equal(no.statusCode, 404);
  assert.equal(asked.length, 1, 'refused before looking anything up');

  // a snapshot: every trade day; a short page also carries the days before for the 1h / 4h / 1d views
  asked.length = 0;
  const all = await embedCharts(candles, data, { kind: 'all' }, 'America/Los_Angeles');
  assert.deepEqual(Object.keys(all).sort(), ['MESZ6|2026-11-13', 'MNQZ6|2026-11-10']);
  const day = await embedCharts(candles, { trades: [data.trades[0]] }, { kind: 'page', from: '2026-11-13', to: '2026-11-13' }, 'America/Los_Angeles');
  assert.ok(Object.keys(day).length > 25 && day['MESZ6|2026-11-12'] && !day['MESZ6|2026-11-07'], 'weekdays and Sundays before, no Saturdays');
  const tight = await embedCharts(candles, data, { kind: 'all' }, 'UTC', 150);
  assert.equal(Object.keys(tight).length, 1, 'stays within the size budget, newest first');
  assert.ok(tight['MESZ6|2026-11-13']);
});

test('replays in shared views: saved ticks only, for the shared trade days; a snapshot carries them gzipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tj-sh-'));
  fs.writeFileSync(path.join(dir, 'price-source.json'), JSON.stringify({ autoTicks: false }));
  const candles = createCandleHandler(dir, { readTrades: () => [], readConnTrades: () => [], dropDirs: () => [] });
  const H = Date.parse('2026-11-13T14:00:00Z') / 1000;
  candles.ticks.store({ source: 'atas', symbol: 'ES', from: H, to: H + 3600, ticks: [[(H + 10) * 1000, 6000, 1, 1], [(H + 20) * 1000, 6000.25, 2, -1]] });
  const data = { trades: [{ symbol: 'MESZ6', entry: '2026-11-13T06:45:00' }] };
  const res = () => { const r = { headers: {}, setHeader: (k, v) => { r.headers[k] = v; }, end: (b) => { r.body = String(b); } }; return r; };
  // the trade's hour: saved (an ES chart's ticks serve MES); the next hour: none, and nothing is asked of a platform
  const ok = res();
  await sendShareChart(ok, candles, data, 'ticks', `/api/share/t/ticks?symbol=MESZ6&from=${H}&to=${H + 7200}`);
  const j = JSON.parse(ok.body);
  assert.equal(ok.statusCode, 200);
  assert.equal(j.ticks.length, 2);
  assert.deepEqual(j.hours, { have: [H], pending: [], none: [H + 3600] });
  assert.equal(j.canFetch, false);
  // another symbol, or a day the share doesn't cover: refused
  const no1 = res(); await sendShareChart(no1, candles, data, 'ticks', `/api/share/t/ticks?symbol=NQZ6&from=${H}&to=${H + 3600}`);
  const no2 = res(); await sendShareChart(no2, candles, data, 'ticks', `/api/share/t/ticks?symbol=MESZ6&from=${H + 10 * 86400}&to=${H + 10 * 86400 + 3600}`);
  assert.deepEqual([no1.statusCode, no2.statusCode], [404, 404]);
  // a snapshot: the saved hours of each trade day, gzipped + base64
  const emb = embedTicks(candles, data, 'America/Los_Angeles');
  assert.deepEqual(Object.keys(emb), [`MESZ6|${H}`]);
  assert.equal(JSON.parse(zlib.gunzipSync(Buffer.from(emb[`MESZ6|${H}`], 'base64'))).length, 2);
  assert.deepEqual(embedTicks(candles, data, 'UTC', 10), {}, 'within the size budget');
});
