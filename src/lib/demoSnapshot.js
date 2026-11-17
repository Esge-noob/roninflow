// Snapshot files on the demo site: the same single-file view-only journal RoninFlow makes, built in the browser
// (the demo has no server). The page, its styles and script are inlined; the made-up prices for the trade days and
// the chart library go along, so the execution charts work in the file too.
import { DEMO_CHART_LIB } from './demoMode';
import { demoCandles } from './demoCandles';

const scriptSafe = (json) => json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const addDays = (key, n) => { const d = new Date(`${key}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`Couldn’t load ${url}`); return r.text(); };

/** scope: { kind: 'all' } | { kind: 'page', route, label, from?, to? } */
export async function demoSnapshot(state, scope, label, hideMoney) {
  const s = JSON.parse(JSON.stringify(state));
  if (scope.kind === 'page' && scope.from && scope.to) { // a page with dates only carries those dates
    const lo = addDays(scope.from, -1), hi = addDays(scope.to, 1);
    s.trades = (s.trades || []).filter((t) => String(t.entry).slice(0, 10) >= lo && String(t.entry).slice(0, 10) <= hi);
    s.diary = Object.fromEntries(Object.entries(s.diary || {}).filter(([d]) => d >= scope.from && d <= scope.to));
  }
  s.payouts = []; s.notebook = undefined; s.coachChats = undefined;
  s.settings = { ...s.settings, privacy: !!(hideMoney || s.settings?.privacy), setupDone: true };
  // the made-up prices for each traded symbol and day
  const charts = {};
  for (const t of s.trades || []) {
    const d = String(t.entry || '').slice(0, 10);
    const k = `${t.symbol}|${d}`;
    if (!t.symbol || !d || charts[k]) continue;
    const candles = demoCandles(s.trades, t.symbol, d);
    if (candles.length) charts[k] = { symbol: t.symbol, date: d, interval: '1m', source: 'Made-up demo prices', final: true, candles };
  }
  let chartLib = null;
  try { chartLib = await get(DEMO_CHART_LIB); } catch { /* offline: the file says charts aren't included */ }
  // the page, with its styles and script inlined
  const base = import.meta.env.BASE_URL || '/';
  let html = await get(base);
  html = html.replace(/\s*<link rel="(icon|manifest|apple-touch-icon|modulepreload)"[^>]*>/g, '');
  for (const m of [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+\.css)"[^>]*>/g)]) { const css = await get(new URL(m[1], location.href).href); html = html.replace(m[0], () => `<style>${css}</style>`); } // a function: no "$&" surprises
  const sm = html.match(/<script type="module"[^>]*src="([^"]+\.js)"[^>]*><\/script>/);
  if (!sm) throw new Error('Couldn’t find the app script');
  const code = (await get(new URL(sm[1], location.href).href)).replace(/<\/script/gi, '<\\/script');
  const meta = { scope, label, hideMoney: !!hideMoney, createdAt: new Date().toISOString(), snapshot: true, sharedBy: 'Demo', images: {}, charts, chartLib };
  const boot = `<script>window.__RF_SNAPSHOT__=${scriptSafe(JSON.stringify({ meta, state: s }))};</script>\n<script type="module">${code}</script>`;
  html = html.replace(sm[0], () => boot);
  html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${String(label || 'Journal').replace(/[<>&]/g, '')} · RoninFlow (view only)</title>`);
  const name = `roninflow-demo-${(scope.kind === 'page' ? label || 'page' : 'journal').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.html`;
  return { html, name };
}
