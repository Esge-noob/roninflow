// The public demo site is the same app built with VITE_DEMO=1: a made-up journal kept only in the visitor's browser,
// with features that need the RoninFlow server (live sync, broker logins, backups, password) explained instead.
export const IS_DEMO = (() => { try { return import.meta.env?.VITE_DEMO === '1'; } catch { return false; } })();
export const REPO_URL = 'https://github.com/coreyheyman/roninflow';
export const DOWNLOAD_URL = `${REPO_URL}/releases/latest`;
/** The chart library for the demo (RoninFlow serves its own copy). */
export const DEMO_CHART_LIB = 'https://cdn.jsdelivr.net/npm/lightweight-charts@5.0.7/dist/lightweight-charts.standalone.production.js';

/** In the demo there is no server: answer its API calls in the browser so nothing waits on the network. */
export function installDemoFetch() {
  if (!IS_DEMO || typeof window === 'undefined' || window.__demoFetch) return;
  window.__demoFetch = true;
  const real = window.fetch.bind(window);
  const reply = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.startsWith('/api/')) return real(input, init);
    if (url.startsWith('/api/candles?')) {
      // made-up candles through the demo trades' prices (RoninFlow itself uses your platform add-on or a data key)
      const q = new URL(url, 'http://demo').searchParams;
      let trades = [];
      try { trades = JSON.parse(localStorage.getItem('roninflow-demo-v1') || '{}').trades || []; } catch { /* nothing saved yet */ }
      return import('./demoCandles').then(({ demoCandles }) => reply(200, { candles: demoCandles(trades, q.get('symbol'), q.get('date')), interval: '1m', source: 'Made-up demo prices' }));
    }
    if (url.startsWith('/api/candles/ticks?')) {
      // made-up ticks inside the demo's made-up bars, so the tick-by-tick replay can be tried
      const q = new URL(url, 'http://demo').searchParams;
      const from = Number(q.get('from')), to = Number(q.get('to'));
      let trades = [];
      try { trades = JSON.parse(localStorage.getItem('roninflow-demo-v1') || '{}').trades || []; } catch { /* nothing saved yet */ }
      return import('./demoCandles').then(({ demoCandles, demoTicks }) => {
        const days = new Set(), have = [];
        for (let h = from - (from % 3600); h < to; h += 3600) { have.push(h); const d = new Date(h * 1000); days.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); }
        const bars = [...days].flatMap((day) => demoCandles(trades, q.get('symbol'), day)).filter((b) => b[0] >= from && b[0] < to).sort((a, b) => a[0] - b[0]);
        return reply(200, { ticks: demoTicks(bars, q.get('symbol')), hours: { have, pending: [], none: [] }, sources: ['demo'], from: 'demo', canFetch: true });
      });
    }
    if (url.startsWith('/api/candles/history')) {
      // a made-up history going back to Jan 2025 (RoninFlow downloads yours from your platform add-on)
      const q = new URL(url, 'http://demo').searchParams;
      const y = new Date(Date.now() - 86400e3);
      const last = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
      if (url.startsWith('/api/candles/history/bars')) return import('./demoCandles').then(({ demoHistory }) => reply(200, demoHistory(q.get('symbol'), q.get('from') < '2025-01-01' ? '2025-01-01' : q.get('from'), q.get('to') > last ? last : q.get('to'))));
      return reply(200, { job: { status: 'done', reason: 'demo', oldest: '2025-01-06', done: 98, bars: 0 }, coverage: { days: 480, first: '2025-01-01', last }, contract: { source: 'demo', c: q.get('symbol') } });
    }
    if (url.startsWith('/api/macro/gex/levels')) { // sample levels around each demo day's prices, a point every half hour of US hours
      const q = new URL(url, 'http://demo').searchParams;
      let trades = [];
      try { trades = JSON.parse(localStorage.getItem('roninflow-demo-v1') || '{}').trades || []; } catch { /* nothing saved yet */ }
      return import('./demoCandles').then(({ demoCandles }) => {
        const fut = q.get('fut'), date = q.get('date');
        const bars = demoCandles(trades, fut, date) || [];
        const start = Date.parse(`${date}T14:30:00Z`), tickOf = { ES: 0.25, MES: 0.25, NQ: 0.25, MNQ: 0.25, RTY: 0.1, M2K: 0.1 }[fut];
        if (!bars.length || !tickOf) return reply(200, { fut, date, levels: [] });
        const at = (ms) => { const b = bars.filter((x) => x[0] * 1000 <= ms).pop() || bars[0]; return b[4]; };
        const open = at(start), step = fut.endsWith('Q') ? 50 : 10;
        const r = (v) => Math.round(v / step) * step;
        const levels = [];
        for (let i = 0; i < 14; i++) {
          const t = start + i * 30 * 60e3, p = at(t), drift = (p - open) * 0.35;
          levels.push({ t, spot: p, callWall: r(open * 1.006 + drift), putWall: r(open * 0.993 + drift), flip: Math.round((open * 1.0008 + drift * 1.4) * 4) / 4, zone: p > open * 1.0008 + drift * 1.4 ? 'positive' : 'negative' });
        }
        return reply(200, { fut, date, levels });
      });
    }
    if (url.startsWith('/api/macro/')) return import('./macroDemo').then(({ demoMacro }) => reply(200, demoMacro(url))); // sample macro data
    if (url.startsWith('/api/candles')) return reply(404, { error: 'Not available in the demo.' });
    return reply(404, { error: 'Not available in the demo — this needs RoninFlow running on your computer.' });
  };
}
