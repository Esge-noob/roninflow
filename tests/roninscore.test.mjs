import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roninScore, RONIN_PARTS } from '../src/lib/roninScore.js';

let n = 0;
const tr = (date, pnl) => ({ id: `t${n++}`, symbol: 'MES', entry: `${date}T07:00:00`, exit: `${date}T07:05:00`, pnl, qty: 1, direction: 'Long' });

test('weights add up to 100', () => {
  assert.equal(RONIN_PARTS.reduce((s, p) => s + p.weight, 0), 100);
});

test('a strong, steady record scores high; a losing one low', () => {
  const good = [];
  for (let d = 1; d <= 20; d++) { const day = `2026-10-${String(d).padStart(2, '0')}`; good.push(tr(day, 300), tr(day, 250), tr(day, -100)); }
  const g = roninScore(good, 50000);
  assert.ok(g.score > 85, `good: ${g.score}`);
  assert.equal(g.parts.pf, 100);
  assert.ok(g.parts.consistency === 100, 'no single day carries the profit');
  const bad = [];
  for (let d = 1; d <= 20; d++) { const day = `2026-10-${String(d).padStart(2, '0')}`; bad.push(tr(day, 100), tr(day, -250), tr(day, -200)); }
  const b = roninScore(bad, 50000);
  assert.ok(b.score < 20, `bad: ${b.score}`);
  assert.equal(b.parts.recovery, 0, 'down overall → no recovery');
  assert.ok(b.parts.dd < 10, `big drawdown: ${b.parts.dd}`);
});

test('one big day makes the record less consistent', () => {
  const t = [tr('2026-10-01', 5000), tr('2026-10-02', 100), tr('2026-10-03', -50), tr('2026-10-04', 100)];
  const r = roninScore(t, 50000);
  assert.ok(r.parts.consistency < 10, `consistency ${r.parts.consistency}`);
  assert.equal(roninScore([], 50000).score, 0);
});

test('insights put the weakest part first and describe it', async () => {
  const { roninInsights } = await import('../src/lib/roninScore.js');
  const t = [tr('2026-10-01', 5000), tr('2026-10-02', 100), tr('2026-10-03', -50), tr('2026-10-04', 100)];
  const ins = roninInsights(roninScore(t, 50000));
  assert.equal(ins.parts[0].key, 'consistency');
  assert.match(ins.parts[0].meaning, /one day/);
  assert.match(ins.summary, /Consistency is holding it back/);
  for (const p of ins.parts) assert.ok(p.value && p.meaning && p.tip, p.key);
});
