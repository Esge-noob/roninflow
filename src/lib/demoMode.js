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
    if (url.startsWith('/api/candles/history')) {
      // a made-up history going back to Jan 2025 (RoninFlow downloads yours from your platform add-on)
      const q = new URL(url, 'http://demo').searchParams;
      const y = new Date(Date.now() - 86400e3);
      const last = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
      if (url.startsWith('/api/candles/history/bars')) return import('./demoCandles').then(({ demoHistory }) => reply(200, demoHistory(q.get('symbol'), q.get('from') < '2025-01-01' ? '2025-01-01' : q.get('from'), q.get('to') > last ? last : q.get('to'))));
      return reply(200, { job: { status: 'done', reason: 'demo', oldest: '2025-01-06', done: 98, bars: 0 }, coverage: { days: 480, first: '2025-01-01', last }, contract: { source: 'demo', c: q.get('symbol') } });
    }
    if (url.startsWith('/api/candles')) return reply(404, { error: 'Not available in the demo.' });
    return reply(404, { error: 'Not available in the demo — this needs RoninFlow running on your computer.' });
  };
}
