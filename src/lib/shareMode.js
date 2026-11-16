// View-only shared journals: opened from a share link (/s/<token>) or a snapshot file (data embedded in the page).
// The app runs read-only: nothing is saved — not to the server, not to this browser — and only the shared data is
// ever loaded. Server features (sync, AI, macro data, execution charts) aren't available in a shared view.

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
    if (url.startsWith('/api/candles')) return reply(424, { error: 'Execution charts aren’t included in shared journals.' });
    return reply(404, { error: 'Not available in a shared journal.' });
  };
}

/** A shared view tells the page it can't save: the first attempt shows a notice. */
export const VIEW_ONLY_EVENT = 'rf-view-only';
let lastNotice = 0;
export function notifyViewOnly() {
  if (Date.now() - lastNotice < 4000) return;
  lastNotice = Date.now();
  window.dispatchEvent(new CustomEvent(VIEW_ONLY_EVENT));
}
