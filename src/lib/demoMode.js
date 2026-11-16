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
    if (url.startsWith('/api/candles')) return reply(404, { error: 'Not available in the demo.' });
    return reply(404, { error: 'Not available in the demo — this needs RoninFlow running on your computer.' });
  };
}
