// Price data from every platform add-on: the journal lists the trade days still missing 1-minute bars, add-ons
// fetch them from their platform and send them back (web request, or a .bars.jsonl file for MetaTrader / Sierra Chart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import os from 'node:os';
import path from 'node:path';
import { createCandleHandler, dayWindow } from '../candles.js';
import { createDropWatcher } from '../connect-apis.js';

const TZ = 'America/Los_Angeles';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tj-pw-'));
const bars = (from, n) => Array.from({ length: n }, (_, i) => [from + i * 60, 100, 101, 99, 100.5, 10]);

function setup({ trades = [], conn = [] } = {}) {
  const dir = tmp();
  const drop = path.join(dir, 'mt');
  fs.mkdirSync(drop);
  const h = createCandleHandler(dir, { readTrades: () => trades, readConnTrades: () => conn, dropDirs: () => [[drop, 'metatrader'], [path.join(dir, 'missing'), 'sierrachart']] });
  return { dir, drop, h };
}

test('lists trade days of that add-on still missing bars, newest first', () => {
  const now = Math.floor(Date.parse('2026-11-16T20:00:00Z') / 1000); // noon in LA
  const { h } = setup({
    trades: [
      { symbol: 'MNQ', contract: 'MNQ 12-26', source: 'ninjatrader', entry: '2026-11-13T06:40:00' },
      { symbol: 'MNQ', contract: 'MNQ 12-26', source: 'ninjatrader', entry: '2026-11-13T07:10:00' }, // same day: listed once
      { symbol: 'MES', contract: 'MESZ6', source: 'atas', entry: '2026-11-13T06:40:00' },              // another platform
      { symbol: 'ES', entry: '2026-11-12T06:40:00' },                                                  // a file import: no contract
      { symbol: 'NQ', contract: 'NQ 12-26', source: 'ninjatrader', entry: '2026-08-01T06:40:00' },     // too old
    ],
    conn: [{ symbol: 'MNQ', contract: 'MNQ 12-26', source: 'ninjatrader', entry: '2026-11-16T15:30:00.000Z' }], // today, only in the inbox so far
  });
  const items = h.wanted('ninjatrader', { tz: TZ, now });
  assert.deepEqual(items.map((i) => [i.symbol, i.contract]), [['MNQ', 'MNQ 12-26'], ['MNQ', 'MNQ 12-26']]);
  const today = dayWindow('2026-11-16', TZ);
  assert.equal(items[0].from, today.from);
  assert.equal(items[0].to, now, 'today runs up to now');
  assert.equal(items[1].to, dayWindow('2026-11-13', TZ).to);
  assert.deepEqual(h.wanted('quantower', { tz: TZ, now }), []);
});

test('a range an add-on sent is not asked for again; today is refreshed from where it got to', () => {
  const now = Math.floor(Date.parse('2026-11-16T20:00:00Z') / 1000);
  const { h } = setup({ trades: [
    { symbol: 'MNQ', contract: 'MNQ 12-26', source: 'ninjatrader', entry: '2026-11-13T06:40:00' },
    { symbol: 'MNQ', contract: 'MNQ 12-26', source: 'ninjatrader', entry: '2026-11-16T06:40:00' },
  ] });
  const [today, past] = h.wanted('ninjatrader', { tz: TZ, now });
  // the platform had nothing for the past day — still counts as done
  h.ingestBars({ source: 'ninjatrader', symbol: past.symbol, from: past.from, to: past.to, bars: [] });
  h.ingestBars({ source: 'ninjatrader', symbol: today.symbol, from: today.from, to: now - 30, bars: bars(today.from, 50) });
  assert.deepEqual(h.wanted('ninjatrader', { tz: TZ, now }), [], 'nothing right after');
  const later = h.wanted('ninjatrader', { tz: TZ, now: now + 300 });
  assert.equal(later.length, 1);
  assert.equal(later[0].from, now - 30 - 600, 'refresh starts a little before the last bar it has');
  assert.equal(later[0].to, now + 300);
});

test('days another add-on already sent 1-minute bars for are skipped', () => {
  const now = Math.floor(Date.parse('2026-11-16T20:00:00Z') / 1000);
  const { h } = setup({ trades: [{ symbol: 'MNQ', contract: 'MNQ 12-26', source: 'ninjatrader', entry: '2026-11-13T06:40:00' }] });
  const w = dayWindow('2026-11-13', TZ);
  h.ingestBars({ source: 'atas', symbol: 'MNQZ6', bars: bars(w.from, Math.floor((w.to - w.from) / 60)) }); // ATAS on a 1-minute chart (no from/to)
  assert.deepEqual(h.wanted('ninjatrader', { tz: TZ, now }), []);
});

test('the list is written for MetaTrader as lines, only in folders that exist', () => {
  const { dir, drop, h } = setup({ trades: [{ symbol: 'EURUSD', contract: 'EURUSD.m', source: 'metatrader', entry: '2026-11-13T06:40:00' }] });
  h.writeWantedFiles();
  const text = fs.readFileSync(path.join(drop, 'price-wanted.txt'), 'utf8');
  const [line] = text.trim().split('\n');
  const [sym, contract, from, to] = line.split('|');
  assert.equal(sym, 'EURUSD');
  assert.equal(contract, 'EURUSD.m');
  assert.ok(Number(from) > 0 && Number(to) > Number(from));
  assert.ok(!fs.existsSync(path.join(dir, 'missing')));
});

test('bars dropped as a .bars.jsonl file reach the price data and the file is cleaned up', () => {
  const { dir, h } = setup();
  const drop = path.join(dir, 'drop');
  fs.mkdirSync(drop);
  const file = path.join(drop, 'mt5-123.bars.jsonl');
  const from = Math.floor(Date.parse('2026-11-13T14:00:00Z') / 1000);
  fs.writeFileSync(file, JSON.stringify({ symbol: 'EURUSD', from, to: from + 3600, bars: bars(from, 60) }) + '\n' + '{"symbol":"EURUSD","bars":[[1');
  let got = 0;
  const scan = createDropWatcher({ ingest: () => ({}), setHeartbeat: () => {}, log: () => {}, offsets: {}, dirs: () => [[drop, 0]], onBars: (b) => { const n = h.ingestBars(b); got += n; return n; } });
  scan();
  assert.equal(got, 60, 'complete line read, half-written one left for later');
  const old = (Date.now() - 60000) / 1000;
  fs.utimesSync(file, old, old);
  scan();
  assert.ok(fs.existsSync(file), 'kept while a line is unfinished');
  fs.writeFileSync(file, '');
  fs.utimesSync(file, old, old);
  scan();
  assert.ok(!fs.existsSync(file), 'removed once fully read and quiet');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'bars')), ['other']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'bars', 'other')), ['EURUSD']);
});

test('switching add-on price data off stops the list and the charts using it', async () => {
  const now = Math.floor(Date.now() / 1000);
  const date = new Date((now - 3 * 86400) * 1000).toLocaleDateString('en-CA');
  const { h } = setup({ trades: [{ symbol: 'MNQ', contract: 'MNQ 12-26', source: 'ninjatrader', entry: `${date}T06:40:00` }] });
  const call = (method, url, body) => new Promise((resolve) => {
    const { Readable } = require('node:stream');
    const req = Readable.from(body ? [JSON.stringify(body)] : []);
    Object.assign(req, { method, url, headers: {}, setEncoding() {} });
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(t) { resolve({ status: this.statusCode, body: JSON.parse(t) }); } };
    h(req, res);
  });
  const w = dayWindow(date, Intl.DateTimeFormat().resolvedOptions().timeZone);
  h.ingestBars({ source: 'ninjatrader', symbol: 'MNQ', bars: bars(w.from + 15 * 3600, 30) });
  assert.equal((await call('GET', '/api/candles/config')).body.addon, true, 'on by default');
  assert.equal((await call('GET', `/api/candles?symbol=MNQ&date=${date}`)).body.source, 'Your platform (add-on)');
  assert.equal((await call('POST', '/api/candles/config', { yahoo: false, addon: false })).body.addon, false);
  assert.deepEqual(h.wanted('ninjatrader'), []);
  assert.equal((await call('GET', `/api/candles?symbol=MNQ&date=${date}`)).status, 424, 'no other source set up');
  assert.equal((await call('POST', '/api/candles/config', { yahoo: false })).body.addon, false, 'kept when other settings are saved');
  await call('POST', '/api/candles/config', { yahoo: false, addon: true });
  assert.equal(h.wanted('ninjatrader').length, 1);
});

function caller(h) {
  return (method, url, body) => new Promise((resolve) => {
    const { Readable } = require('node:stream');
    const req = Readable.from(body ? [JSON.stringify(body)] : []);
    Object.assign(req, { method, url, headers: {}, setEncoding() {} });
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(t) { resolve({ status: this.statusCode, body: JSON.parse(t) }); } };
    h(req, res);
  });
}

test('choosing one platform: charts use its bars, only its add-on fetches, earlier bars still back it up', async () => {
  const now = Math.floor(Date.now() / 1000);
  const date = new Date((now - 3 * 86400) * 1000).toLocaleDateString('en-CA');
  const date2 = new Date((now - 4 * 86400) * 1000).toLocaleDateString('en-CA');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dir = tmp();
  // bars saved before they were kept per platform (data/bars/<ROOT>/…)
  const w2 = dayWindow(date2, tz);
  const old = path.join(dir, 'bars', 'MNQ');
  fs.mkdirSync(old, { recursive: true });
  const day2 = new Date((w2.from + 16 * 3600) * 1000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(old, `${day2}.json`), JSON.stringify(Object.fromEntries(bars(w2.from + 16 * 3600, 20).map((b) => [b[0], b]))));
  fs.writeFileSync(path.join(dir, 'price-covered.json'), JSON.stringify({ MNQ: [[1, 2]] }));
  const trades = [
    { symbol: 'MNQ', contract: 'MNQ 12-26', source: 'ninjatrader', entry: `${date}T06:40:00` },
    { symbol: 'MNQ', contract: 'MNQZ6', source: 'quantower', entry: `${date}T06:40:00` },
  ];
  const h = createCandleHandler(dir, { readTrades: () => trades, dropDirs: () => [] });
  const call = caller(h);
  assert.ok(fs.existsSync(path.join(dir, 'bars', '_earlier', 'MNQ')), 'earlier bars moved aside');
  const w = dayWindow(date, tz);
  h.ingestBars({ source: 'ninjatrader', symbol: 'MNQ', bars: bars(w.from + 15 * 3600, 30).map((b) => [b[0], 10, 11, 9, 10, 1]) });
  h.ingestBars({ source: 'quantower', symbol: 'MNQ', bars: bars(w.from + 15 * 3600, 60).map((b) => [b[0], 20, 21, 19, 20, 1]) });
  let cfg = (await call('GET', '/api/candles/config')).body;
  assert.equal(cfg.addonSource, 'any');
  assert.deepEqual(cfg.addonSources.map((x) => x.id).sort(), ['ninjatrader', 'quantower']);
  let c = (await call('GET', `/api/candles?symbol=MNQ&date=${date}`)).body;
  assert.equal(c.candles[0][1], 20, 'any: the platform with the most bars');
  assert.equal(h.wanted('ninjatrader', { tz }).length + h.wanted('quantower', { tz }).length, 2);
  cfg = (await call('POST', '/api/candles/config', { yahoo: false, addonSource: 'ninjatrader' })).body;
  assert.equal(cfg.addonSource, 'ninjatrader');
  c = (await call('GET', `/api/candles?symbol=MNQ&date=${date}`)).body;
  assert.equal(c.candles[0][1], 10, 'the chosen platform');
  assert.deepEqual(h.wanted('quantower', { tz }), [], 'the other platform stops fetching');
  assert.equal(h.wanted('ninjatrader', { tz }).length, 1);
  c = (await call('GET', `/api/candles?symbol=MNQ&date=${date2}`)).body;
  assert.equal(c.candles.length, 20, 'a day only in the earlier bars still shows');
});

test('Databento and Polygon can be switched off without removing the key', async () => {
  const h = createCandleHandler(tmp(), { dropDirs: () => [] });
  const call = caller(h);
  const cfg = (await call('GET', '/api/candles/config')).body;
  assert.equal(cfg.useDatabento, true);
  assert.equal(cfg.usePolygon, true);
  const off = (await call('POST', '/api/candles/config', { yahoo: false, useDatabento: false, usePolygon: false })).body;
  assert.equal(off.useDatabento, false);
  assert.equal(off.usePolygon, false);
  assert.equal((await call('POST', '/api/candles/config', { yahoo: true })).body.useDatabento, false, 'kept when other settings change');
});

test('a backtest can ask the add-ons for any day: the front-month contract goes to the top of the list until answered', async () => {
  const now = Math.floor(Date.parse('2026-11-16T20:00:00Z') / 1000);
  const { h } = setup({ trades: [{ symbol: 'MNQ', contract: 'MNQ 12-26', source: 'ninjatrader', entry: '2026-11-13T06:40:00' }] });
  const call = (url) => new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { resolve({ status: this.statusCode, body: JSON.parse(b || '{}') }); } };
    h({ method: 'GET', url, headers: {} }, res);
  });
  const r = await call(`/api/candles?symbol=MNQ&date=2026-05-04&tz=${encodeURIComponent(TZ)}&want=1`);
  assert.equal(r.status, 424, 'no price source set up in this test');
  const items = h.wanted('ninjatrader', { tz: TZ, now });
  assert.equal(items[0].contract, 'MNQ 06-26', 'the June contract was front month in early May');
  assert.equal(items[0].from, dayWindow('2026-05-04', TZ).from);
  assert.equal(items.length, 2, 'then the trade day');
  assert.deepEqual(h.wanted('quantower', { tz: TZ, now }), [], 'an add-on that never traded MNQ has no contract to ask for');
  h.ingestBars({ source: 'ninjatrader', symbol: 'MNQ', from: items[0].from, to: items[0].to, bars: [] });
  assert.equal(h.wanted('ninjatrader', { tz: TZ, now }).length, 1, 'answered (even with nothing): no longer asked for');
});

test('history download: weeks newest first with the right contracts, roll days twice, stops at the start of the data, back-adjusted series', () => {
  const { h } = setup({ trades: [{ symbol: 'MNQ', contract: 'MNQ 12-26', source: 'ninjatrader', entry: '2026-11-13T06:40:00' }] });
  const job = h.history.start('MNQ', TZ);
  assert.equal(job.source, 'ninjatrader');
  const cutoff = Date.parse('2026-08-01T00:00:00Z') / 1000; // pretend the platform has data from August on
  const seen = new Set();
  let rounds = 0;
  for (; rounds < 200 && h.history.jobs().MNQ.status === 'running'; rounds++) {
    const items = h.wanted('ninjatrader', { tz: TZ });
    if (!items.length) break;
    for (const it of items) {
      seen.add(`${it.symbol}|${it.contract}`);
      const roll = it.symbol.endsWith('~roll');
      const price = roll ? 90 : 100;
      const n = it.from >= cutoff ? 50 : 0;
      h.ingestBars({ source: 'ninjatrader', symbol: it.symbol, from: it.from, to: it.to, bars: Array.from({ length: n }, (_, i) => [it.from + 3600 + i * 60, price, price + 1, price - 1, price, 5]) });
    }
  }
  const j = h.history.jobs().MNQ;
  assert.equal(j.status, 'done');
  assert.equal(j.reason, 'start');
  assert.ok(j.oldest >= '2026-07-27' && j.oldest <= '2026-08-03', `oldest week ${j.oldest}`);
  assert.ok(seen.has('MNQ|MNQ 12-26') && seen.has('MNQ|MNQ 09-26'), 'December, then September before the Sep 10 roll');
  assert.ok(seen.has('MNQ~roll|MNQ 09-26'), 'the old contract on the roll day');
  assert.ok(j.rolls.some((r) => r.date === '2026-09-10'));
  const s = h.history.continuous('MNQ', '2026-09-01', '2026-09-20');
  const before = s.t.findIndex((t) => t >= j.rolls.find((r) => r.date === '2026-09-10').from);
  assert.equal(s.c[0], 110, 'bars before the roll move up by the gap (100 − 90)');
  assert.equal(s.c[before], 100, 'the new contract is unchanged');
  assert.deepEqual(s.rolls.map((r) => [r.date, r.adj]), [['2026-09-10', 10]]);
  assert.equal(h.history.continuous('MNQ', '2026-09-01', '2026-09-20', false).c[0], 100);
});

test('ATAS chart history: whole charts per contract, stitched at the roll and back-adjusted', async () => {
  const { h } = setup({ trades: [{ symbol: 'MES', source: 'atas', entry: '2026-11-13T06:40:00' }] });
  const job = h.history.start('MES', TZ);
  assert.equal(job.mode, 'chart');
  const day = (iso) => Date.parse(`${iso}T15:00:00Z`) / 1000;
  const bars = (fromIso, toIso, price) => {
    const out = [];
    for (let t = day(fromIso); t <= day(toIso); t += 86400) for (let k = 0; k < 30; k++) out.push([t + k * 60, price, price + 1, price - 1, price, 1]);
    return out;
  };
  h.ingestBars({ source: 'atas', symbol: 'MESU6', history: true, bars: bars('2026-08-01', '2026-09-15', 6000) });
  h.ingestBars({ source: 'atas', symbol: 'MESZ6', history: true, bars: bars('2026-08-20', '2026-10-01', 6020) });
  const s = h.history.continuous('MES', '2026-08-03', '2026-09-30');
  const at = (iso) => s.c[s.t.findIndex((t) => t >= day(iso))];
  assert.equal(at('2026-08-05'), 6020, 'September contract shifted up by the 20-point gap');
  assert.equal(at('2026-09-09'), 6020, 'still September (rolls on the 10th), shifted');
  assert.equal(at('2026-09-11'), 6020, 'December, unshifted');
  assert.deepEqual(s.rolls.map((r) => [r.from, r.to, r.adj]), [['MESU6', 'MESZ6', 20]]);
  assert.equal(h.history.continuous('MES', '2026-08-03', '2026-09-30', false).c[0], 6000);
});

test('a day saved with Yahoo’s hourly bars switches to 1-minute bars once the platform’s history has them', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'price-source.json'), JSON.stringify({ yahoo: true, decided: true })); // Yahoo switched on
  const h = createCandleHandler(dir, { readTrades: () => [] });
  const date = '2026-09-17';
  const { from, to } = dayWindow(date, TZ);
  const hourly = Array.from({ length: 20 }, (_, i) => [from + i * 3600, 6000, 6001, 5999, 6000, 5]);
  fs.mkdirSync(path.join(dir, 'candles', 'MES=F'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'candles', 'MES=F', `${date}.json`), JSON.stringify({ symbol: 'MES', date, tz: TZ, from, to, interval: '60m', source: 'Yahoo Finance (continuous contract)', fetchedAt: to + 86400, final: true, candles: hourly }));
  // with no other data, the saved hourly day is what the chart gets
  assert.equal((await h.get('MES', date, TZ)).interval, '60m');
  // the ATAS history download brings the September contract's 1-minute chart
  h.ingestBars({ source: 'atas', symbol: 'MESU6', history: true, bars: bars(from + 3600, 300) });
  const rec = await h.get('MES', date, TZ);
  assert.equal(rec.interval, '1m');
  assert.equal(rec.candles.length, 300);
  assert.match(rec.source, /add-on/);
});

test('ATAS chart history: a full-size chart (ES) feeds a micro’s download (MES) — same prices', () => {
  const { h } = setup({ trades: [{ symbol: 'MES', source: 'atas', entry: '2026-11-13T06:40:00' }] });
  h.history.start('MES', TZ);
  assert.deepEqual(h.history.chartWant('atas', 'ESZ6'), { want: true }, 'the ES chart is asked for its history');
  assert.deepEqual(h.history.chartWant('atas', 'NQZ6'), { want: false }, 'another market isn’t');
  const day = (iso) => Date.parse(`${iso}T15:00:00Z`) / 1000;
  const out = [];
  for (let t = day('2026-06-01'); t <= day('2026-07-01'); t += 86400) for (let k = 0; k < 30; k++) out.push([t + k * 60, 6000, 6001, 5999, 6000, 1]);
  h.ingestBars({ source: 'atas', symbol: 'ESU6', history: true, bars: out });
  h.history.chartDone({ symbol: 'ESU6', first: out[0][0], last: out.at(-1)[0], count: out.length });
  assert.equal(h.history.jobs().MES.oldest, '2026-06-01');
  assert.equal(h.history.coverage('MES').first, '2026-06-01');
  const s = h.history.continuous('MES', '2026-06-02', '2026-06-30');
  assert.ok(s.t.length > 500 && s.c[0] === 6000);
});

test('a backtest on the full-size contract asks the platform you trade the micro on (and says what to do when nothing has arrived)', async () => {
  const now = Math.floor(Date.parse('2026-11-16T20:00:00Z') / 1000);
  const { dir, h } = setup({ trades: [{ symbol: 'MNQ', contract: 'MNQ 12-26', source: 'ninjatrader', entry: '2026-11-13T06:40:00' }] });
  // NinjaTrader has sent bars before, so it counts as a connected platform
  h.ingestBars({ source: 'ninjatrader', symbol: 'MNQ', bars: bars(Date.parse('2026-11-13T15:00:00Z') / 1000, 10) });
  const call = (url) => new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { resolve({ status: this.statusCode, body: JSON.parse(b || '{}') }); } };
    h({ method: 'GET', url, headers: {} }, res);
  });
  const r = await call(`/api/candles?symbol=NQ&date=2026-05-04&tz=${encodeURIComponent(TZ)}&want=1`);
  assert.equal(r.status, 424);
  assert.equal(r.body.code, 'NO_DATA', 'not “no price source” — NinjaTrader is connected');
  assert.match(r.body.error, /NinjaTrader can fetch them/);
  const items = h.wanted('ninjatrader', { tz: TZ, now });
  assert.equal(items[0].contract, 'NQ 06-26', 'named like your MNQ contracts, for NQ');
  // ATAS can't fetch on request: the message says how to get the day instead
  h.ingestBars({ source: 'atas', symbol: 'ES', bars: bars(Date.parse('2026-11-13T15:00:00Z') / 1000, 10) });
  const a = await call(`/api/candles?symbol=MES&date=2026-05-04&tz=${encodeURIComponent(TZ)}`);
  assert.match(a.body.error, /ATAS can’t fetch a day on request/);
  assert.match(a.body.error, /MES \(or ES\)/);
  void dir;
});

test('ticks: a replay asks ATAS for an hour, the indicator sends it (in parts), the hour is kept and not asked again', async () => {
  const { h } = setup({ trades: [{ symbol: 'MES', source: 'atas', entry: '2026-11-13T06:40:00' }] });
  h.ingestBars({ source: 'atas', symbol: 'ES', bars: bars(Date.parse('2026-11-13T15:00:00Z') / 1000, 10) }); // ATAS is connected
  const H = Date.parse('2026-11-13T15:00:00Z') / 1000;
  let r = await h.ticks.get('MES', H + 600, H + 1800);
  assert.deepEqual(r.hours.pending, [H], 'waiting for ATAS');
  assert.equal(r.canFetch, true);
  assert.deepEqual(h.ticks.ask('atas', 'NQZ6'), { want: false }, 'not an NQ chart’s job');
  assert.deepEqual(h.ticks.ask('atas', 'ESZ6'), { want: true, from: H, to: H + 3600 }, 'an ES chart answers for MES');
  assert.deepEqual(h.ticks.ask('atas', 'ESZ6'), { want: false }, 'asked once, then given two minutes');
  const ms = (s) => (H + s) * 1000;
  h.ticks.store({ source: 'atas', symbol: 'ESZ6', from: H, to: H + 3600, part: 0, last: false, ticks: [[ms(700), 6000, 1, 1], [ms(650), 5999.75, 2, -1]] });
  h.ticks.store({ source: 'atas', symbol: 'ESZ6', from: H, to: H + 3600, part: 1, last: true, ticks: [[ms(900), 6000.25, 3, 1], [ms(4000), 1, 1, 1]] });
  r = await h.ticks.get('MES', H + 600, H + 1800);
  assert.deepEqual(r.hours.have, [H]);
  assert.deepEqual(r.sources, ['atas']);
  assert.deepEqual(r.ticks.map((t) => t[1]), [5999.75, 6000, 6000.25], 'in time order, only that hour, only the window');
  // sent again from the start: replaced, not doubled
  h.ticks.store({ source: 'atas', symbol: 'ESZ6', from: H, to: H + 3600, part: 0, last: true, ticks: [[ms(700), 6000, 1, 1]] });
  assert.equal((await h.ticks.get('MES', H, H + 3600)).ticks.length, 1);
  // nothing that can provide ticks: says so
  const other = setup({ trades: [] });
  const n = await other.h.ticks.get('MES', H, H + 3600);
  assert.deepEqual([n.hours.none, n.canFetch], [[H], false]);
});

test('ticks for every add-on: the newest replay request first; NinjaTrader gets a list; MetaTrader a file once it can', async () => {
  const { dir, drop, h } = setup({ trades: [{ symbol: 'MNQ', contract: 'MNQ 12-26', source: 'ninjatrader', entry: '2026-11-13T06:40:00' }, { symbol: 'MNQ', contract: 'MNQZ26', source: 'metatrader', entry: '2026-11-13T06:40:00' }] });
  const H1 = Date.parse('2026-10-16T14:00:00Z') / 1000, H2 = Date.parse('2026-11-12T14:00:00Z') / 1000;
  // nobody can send ticks yet
  assert.deepEqual((await h.ticks.get('MNQ', H1, H1 + 3600)).hours.none, [H1]);
  // the NinjaTrader add-on asks for the tick list → it can; a replay on Oct 16, then the date changes to Nov 12
  assert.deepEqual(h.ticks.wanted('ninjatrader'), []);
  assert.deepEqual((await h.ticks.get('MNQ', H1, H1 + 3600)).hours.pending, [H1]);
  await new Promise((r) => setTimeout(r, 20));
  const later = await h.ticks.get('MNQ', H2, H2 + 3600);
  assert.equal(later.from, 'ninjatrader');
  const items = h.ticks.wanted('ninjatrader');
  assert.deepEqual(items.map((i) => [i.contract, i.from]), [['MNQ 12-26', H2], ['MNQ 12-26', H1]], 'the day you’re on first');
  assert.deepEqual(h.ticks.wanted('ninjatrader'), [], 'handed out once every two minutes');
  // its answer arrives like ATAS's
  h.ticks.store({ source: 'ninjatrader', symbol: 'MNQ', from: H2, to: H2 + 3600, ticks: [[(H2 + 5) * 1000, 21000, 1, 0]] });
  assert.equal((await h.ticks.get('MNQ', H2, H2 + 3600)).ticks.length, 1);
  // MetaTrader: a ticks-wanted.txt only once its EA keeps a .tickcap file
  h.writeWantedFiles();
  assert.ok(!fs.existsSync(path.join(drop, 'ticks-wanted.txt')));
  fs.writeFileSync(path.join(drop, 'mt5-1.tickcap'), String(Date.now()));
  await h.ticks.get('MNQ', H1, H1 + 3600); // still waiting for Oct 16
  h.writeWantedFiles();
  assert.match(fs.readFileSync(path.join(drop, 'ticks-wanted.txt'), 'utf8'), /^MNQ\|MNQZ26\|\d+\|\d+/);
  void dir;
});
