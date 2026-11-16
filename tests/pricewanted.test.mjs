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
