// Price data from every platform add-on: the journal lists the trade days still missing 1-minute bars, add-ons
// fetch them from their platform and send them back (web request, or a .bars.jsonl file for MetaTrader / Sierra Chart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  h.ingestBars({ symbol: past.symbol, from: past.from, to: past.to, bars: [] });
  h.ingestBars({ symbol: today.symbol, from: today.from, to: now - 30, bars: bars(today.from, 50) });
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
  h.ingestBars({ symbol: 'MNQZ6', bars: bars(w.from, Math.floor((w.to - w.from) / 60)) }); // ATAS on a 1-minute chart (no from/to)
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
  const files = fs.readdirSync(path.join(dir, 'bars'));
  assert.deepEqual(files, ['EURUSD']);
});
