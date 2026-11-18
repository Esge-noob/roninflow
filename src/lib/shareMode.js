// View-only shared journals: opened from a share link (/s/<token>) or a snapshot file (data embedded in the page).
// The app runs read-only: nothing is saved — not to the server, not to this browser — and only the shared data is
// ever loaded. Server features (sync, AI, macro data) aren't available in a shared view. Execution charts are — full
// screen and replay too: a link loads prices (and saved ticks) for its own trades' days from the owner's computer, and
// a snapshot file carries them inside.

const SHARE_RE = /^\/s\/([A-Za-z0-9_-]{20,64})\/?$/;
export const SHARE_TOKEN = (() => { try { return window.location.pathname.match(SHARE_RE)?.[1] || null; } catch { return null; } })();
export const SNAPSHOT = (() => { try { return window.__RF_SNAPSHOT__ || null; } catch { return null; } })();
export const IS_VIEWER = !!(SHARE_TOKEN || SNAPSHOT);

/** Settings a viewer may change for themselves (not saved): how things are shown, never what's in the journal. */
export const VIEW_PREFS = new Set(['account', 'dashView', 'reviewChart', 'execTf', 'ecView', 'diaryChart', 'acctLimits', 'hideBreached', 'sidebarCollapsed', 'theme', 'privacy']);

/** Pages a shared journal shows (the rest need the owner's computer, or are private). */
export const VIEWER_SECTIONS = new Set(['dashboard', 'journal', 'diary', 'review', 'strategy', 'risk', 'accounts']);

/** Where a shared view's data comes from. */
export const shareStateUrl = () => `/api/share/${SHARE_TOKEN}/state`;
/** The chart library in a shared view: from the link's computer, or inside the snapshot file (null: not included). */
export const shareChartLib = () => (SNAPSHOT ? (SNAPSHOT.meta?.chartLib ? { code: SNAPSHOT.meta.chartLib } : null) : { src: `/api/share/${SHARE_TOKEN}/lib` });
export const shareImageUrl = (id) => (SNAPSHOT ? SNAPSHOT.meta?.images?.[id] || null : `/api/share/${SHARE_TOKEN}/image/${id}`);

/** In a shared view, answer every other server call here, so nothing private is ever asked for. */
export function installViewerFetch() {
  if (!IS_VIEWER || window.__viewerFetch) return;
  window.__viewerFetch = true;
  const real = window.fetch.bind(window);
  const reply = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.startsWith('/api/')) return real(input, init);
    if (SHARE_TOKEN && url.startsWith(`/api/share/${SHARE_TOKEN}/`) && (!init?.method || init.method === 'GET')) return real(input, init);
    if (url.startsWith('/api/candles?')) {
      if (SHARE_TOKEN) return real(`/api/share/${SHARE_TOKEN}/candles?${url.split('?')[1]}`);
      const q = new URLSearchParams(url.split('?')[1]);
      const rec = SNAPSHOT?.meta?.charts?.[`${q.get('symbol')}|${q.get('date')}`];
      return rec ? reply(200, rec) : reply(404, { error: 'This day’s prices aren’t in the snapshot.' });
    }
    if (url.startsWith('/api/candles/ticks?')) { // tick replay: the link's computer has them saved, a file carries them
      if (SHARE_TOKEN) return real(`/api/share/${SHARE_TOKEN}/ticks?${url.split('?')[1]}`);
      const q = new URLSearchParams(url.split('?')[1]);
      return snapshotTicks(q.get('symbol') || '', Math.floor(Number(q.get('from'))), Math.floor(Number(q.get('to')))).then((j) => reply(200, j));
    }
    if (url.startsWith('/api/candles')) return reply(404, { error: 'Not available in a shared journal.' });
    return reply(404, { error: 'Not available in a shared journal.' });
  };
}

/** Ticks inside a snapshot file ("SYMBOL|hour" → gzipped JSON, base64), answered the way the journal would. */
const tickCache = new Map();
async function snapshotHour(key) {
  if (!tickCache.has(key)) {
    tickCache.set(key, (async () => {
      const b64 = SNAPSHOT?.meta?.ticks?.[key];
      if (!b64 || typeof DecompressionStream === 'undefined') return null;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      return JSON.parse(text);
    })().catch(() => null));
  }
  return tickCache.get(key);
}
export async function snapshotTicks(symbol, from, to) {
  const have = [], none = [], ticks = [];
  if (Number.isFinite(from) && Number.isFinite(to)) {
    for (let h = from - (from % 3600); h < Math.min(to, from + 3 * 3600); h += 3600) {
      const list = await snapshotHour(`${symbol}|${h}`);
      if (!list) { none.push(h); continue; }
      have.push(h);
      for (const t of list) if (t[0] >= from * 1000 && t[0] < to * 1000) ticks.push(t);
    }
  }
  return { ticks, hours: { have, pending: [], none }, sources: have.length ? ['snapshot'] : [], canFetch: false, from: null };
}

/** A shared view tells the page it can't save: the first attempt shows a notice. */
export const VIEW_ONLY_EVENT = 'rf-view-only';
let lastNotice = 0;
export function notifyViewOnly() {
  if (Date.now() - lastNotice < 4000) return;
  lastNotice = Date.now();
  window.dispatchEvent(new CustomEvent(VIEW_ONLY_EVENT));
}
