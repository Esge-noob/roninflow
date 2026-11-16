// View-only sharing: links anyone can open (/s/<token>) and single-file snapshots.
//
// Nothing private leaves the journal: shared data is built from an allow-list (new fields stay private by default),
// account numbers become "Account 1, 2…", and payouts, notebook, AI chats, connections and personal details are left
// out. A link can cover the whole journal or one page; a page with its own dates (a review, a diary day) only
// carries the data for those dates. Links can expire and be revoked; views are counted.
//
// Public visitors arrive through Tailscale Funnel (marked with the Tailscale-Funnel-Request header) or any other
// public route (Cloudflare Tunnel…). Funnel visitors may only reach share routes — everything else is refused.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

// ---------- what a shared journal may contain ----------
const TOP = ['version', 'trades', 'accounts', 'strategies', 'diary', 'reviews', 'coachReviews', 'tags', 'settings'];
const TRADE = ['id', 'accountId', 'symbol', 'direction', 'entry', 'exit', 'qty', 'entryPrice', 'exitPrice', 'fees', 'pnl', 'manualPnl', 'tags', 'strategyId', 'notes', 'rating', 'reviewed', 'screenshots', 'blockers', 'fills'];
const ACCOUNT = ['initial', 'profitTarget', 'maxDrawdown', 'ddType', 'ddLock', 'dailyLossLimit', 'market', 'phase', 'plan', 'status', 'createdAt'];
const SETTINGS = ['acctLimits', 'currency', 'dashLayouts', 'dashboardWidgets', 'dashView', 'diaryChart', 'ecView', 'execTf', 'hideBreached', 'playbook', 'privacy', 'reviewChart', 'risk', 'riskProfiles', 'theme', 'migrations', 'timeZone', 'homeTimeZone'];
const FILL = ['time', 'price', 'qty', 'side', 'type'];

const pick = (o, keys) => { const out = {}; for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k]; return out; };
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Start date (YYYY-MM-DD) of a review / coach-review key: weekly:2026-11-02, monthly:2026-10, quarterly:2026-Q4, yearly:2026, day:2026-11-05. */
export function periodStart(key) {
  const [, id = ''] = String(key).split(':');
  let m;
  if ((m = id.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return id;
  if ((m = id.match(/^(\d{4})-Q([1-4])$/))) return `${m[1]}-${String((m[2] - 1) * 3 + 1).padStart(2, '0')}-01`;
  if ((m = id.match(/^(\d{4})-(\d{2})$/))) return `${id}-01`;
  if ((m = id.match(/^(\d{4})$/))) return `${id}-01-01`;
  return null;
}

const addDays = (key, n) => { const d = new Date(`${key}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/**
 * The view-only copy of a journal.
 *   scope: { kind: 'all' } | { kind: 'page', route, label, from?, to? }  (from/to: YYYY-MM-DD, for pages with dates)
 *   opts:  { hideMoney }  — show the journal with dollar amounts hidden
 */
export function sanitizeState(state, scope = { kind: 'all' }, opts = {}) {
  const s = state || {};
  // account numbers → Account 1, 2, … (same order as the journal)
  const alias = new Map((s.accounts || []).map((a, i) => [a.id, `Account ${i + 1}`]));
  const mapId = (id) => alias.get(id) || (id === 'all' ? 'all' : 'Account');
  const out = {};
  for (const k of TOP) if (s[k] !== undefined) out[k] = clone(s[k]);
  out.accounts = (s.accounts || []).map((a) => ({ ...pick(a, ACCOUNT), id: alias.get(a.id), name: alias.get(a.id) }));
  out.trades = (s.trades || []).map((t) => ({ ...pick(t, TRADE), accountId: mapId(t.accountId), fills: Array.isArray(t.fills) ? t.fills.map((f) => pick(f, FILL)) : undefined }));
  const st = s.settings || {};
  out.settings = {
    ...pick(clone(st), SETTINGS),
    account: st.account && st.account !== 'all' ? mapId(st.account) : 'all',
    riskByAccount: st.riskByAccount ? Object.fromEntries(Object.entries(st.riskByAccount).filter(([id]) => alias.has(id)).map(([id, v]) => [alias.get(id), clone(v)])) : undefined,
    setupDone: true, // never show the first-run setup to a viewer
    privacy: !!(opts.hideMoney || st.privacy),
  };
  out.user = { name: s.user?.name ? String(s.user.name).split(/\s+/)[0] : '' }; // first name only, for "Shared by …"
  out.payouts = [];
  // a page with its own dates only carries those dates (a day either side for trades, for time zones)
  if (scope.kind === 'page' && scope.from && scope.to) {
    const lo = scope.from, hi = scope.to, tlo = addDays(lo, -1), thi = addDays(hi, 1);
    const day = (iso) => String(iso || '').slice(0, 10);
    out.trades = out.trades.filter((t) => day(t.entry) >= tlo && day(t.entry) <= thi);
    out.diary = Object.fromEntries(Object.entries(out.diary || {}).filter(([d]) => d >= lo && d <= hi));
    const inPeriod = ([k]) => { const p = periodStart(k); return p && p >= lo && p <= hi; };
    out.reviews = Object.fromEntries(Object.entries(out.reviews || {}).filter(inPeriod));
    out.coachReviews = Object.fromEntries(Object.entries(out.coachReviews || {}).filter(inPeriod));
  }
  return out;
}

// ---------- links ----------
const ROUTE_RE = /^[\w\-/.:]{0,120}$/;
const cleanScope = (sc) => {
  if (!sc || sc.kind !== 'page') return { kind: 'all' };
  const route = String(sc.route || '').replace(/^#?\/?/, '');
  const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  return { kind: 'page', route: ROUTE_RE.test(route) ? route : '', label: String(sc.label || '').slice(0, 80), from: date(sc.from), to: date(sc.to) };
};
export const tokenOk = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(t);
export const isLive = (link, now = Date.now()) => !!link && !link.revoked && (!link.expiresAt || Date.parse(link.expiresAt) > now);

export function createShareStore(dataDir) {
  const file = path.join(dataDir, 'shares.json');
  const read = () => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.links) ? j : { links: [] }; } catch { return { links: [] }; } };
  const write = (j) => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(j, null, 2)); fs.renameSync(`${file}.tmp`, file); };
  return {
    list: () => read().links,
    get: (token) => read().links.find((l) => l.token === token) || null,
    create({ scope, label, expiresInDays, hideMoney }) {
      const j = read();
      const days = Number(expiresInDays) || 0;
      const link = {
        token: crypto.randomBytes(18).toString('base64url'),
        scope: cleanScope(scope),
        label: String(label || '').slice(0, 80),
        hideMoney: !!hideMoney,
        createdAt: new Date().toISOString(),
        expiresAt: days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null,
        revoked: false, views: 0, lastViewAt: null,
      };
      j.links.unshift(link);
      write(j);
      return link;
    },
    revoke(token) { const j = read(); const l = j.links.find((x) => x.token === token); if (!l) return false; l.revoked = true; write(j); return true; },
    remove(token) { const j = read(); const n = j.links.length; j.links = j.links.filter((x) => x.token !== token); write(j); return j.links.length < n; },
    viewed(token) { const j = read(); const l = j.links.find((x) => x.token === token); if (l) { l.views = (l.views || 0) + 1; l.lastViewAt = new Date().toISOString(); write(j); } },
  };
}

// ---------- Tailscale Funnel (public HTTPS from this PC) ----------
const TS_BINS = process.platform === 'win32'
  ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe']
  : ['tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
const tsRun = (args, timeout = 6000) => new Promise((resolve) => {
  const tryBin = (i) => {
    if (i >= TS_BINS.length) return resolve({ missing: true });
    execFile(TS_BINS[i], args, { timeout, windowsHide: true }, (err, out, errOut) => (err && err.code === 'ENOENT' ? tryBin(i + 1) : resolve({ ok: !err, out: String(out || ''), err: String(errOut || err?.message || '') })));
  };
  tryBin(0);
});

/** { installed, dns, url, funnel } — funnel: public HTTPS is on for this PC's address and points at this server. */
export async function funnelInfo(port) {
  const st = await tsRun(['status', '--json']);
  if (st.missing || !st.ok) return { installed: !st.missing, running: false };
  let dns = null;
  try { dns = JSON.parse(st.out).Self?.DNSName?.replace(/\.$/, '') || null; } catch { /* not signed in */ }
  if (!dns) return { installed: true, running: false };
  let funnel = false;
  const fs1 = await tsRun(['funnel', 'status', '--json']);
  try {
    const j = JSON.parse(fs1.out || '{}');
    const allow = Object.entries(j.AllowFunnel || {}).some(([hp, on]) => on && hp.startsWith(dns));
    funnel = allow && JSON.stringify(j.Web || {}).includes(`:${port}`);
  } catch { /* older Tailscale */ }
  return { installed: true, running: true, dns, url: `https://${dns}`, funnel };
}

/** Turn on public HTTPS (Funnel) for this server. Returns { ok, message, enableUrl? }. */
export async function enableFunnel(port) {
  const r = await tsRun(['funnel', '--bg', String(port)], 25000);
  if (r.missing) return { ok: false, message: 'Tailscale isn’t installed on this computer.' };
  const text = `${r.out}\n${r.err}`;
  const enableUrl = (text.match(/https:\/\/login\.tailscale\.com\/\S+/) || [])[0];
  if (enableUrl) return { ok: false, enableUrl, message: 'Funnel needs to be allowed for your tailnet first — open the link, approve, then press “Turn on” again.' };
  return r.ok ? { ok: true, message: 'Public sharing is on.' } : { ok: false, message: text.trim().split('\n').slice(-3).join(' ') || 'Tailscale couldn’t turn on Funnel.' };
}

// ---------- snapshot file ----------
const scriptSafe = (json) => json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** One self-contained HTML file: the app (styles + code inlined) with the view-only journal embedded. */
export function buildSnapshot(distDir, data, meta) {
  let html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  // icons / manifest point at the server — drop them in a file
  html = html.replace(/\s*<link rel="(icon|manifest|apple-touch-icon)"[^>]*>/g, '');
  html = html.replace(/<link rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"[^>]*>/g, (m, href) => `<style>${fs.readFileSync(path.join(distDir, href), 'utf8')}</style>`);
  const boot = `<script>window.__RF_SNAPSHOT__=${scriptSafe(JSON.stringify({ meta, state: data }))};</script>`;
  html = html.replace(/<script type="module"[^>]*src="(\/assets\/[^"]+\.js)"[^>]*><\/script>/g, (m, src) => `${boot}\n<script type="module">${fs.readFileSync(path.join(distDir, src), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`);
  return html.replace('<title>RoninFlow</title>', `<title>${String(meta.label || 'Journal').replace(/[<>&]/g, '')} · RoninFlow (view only)</title>`);
}

// ---------- screenshots (diary images live in data/images, referenced by id) ----------
const IMG_ID = /img_[a-z0-9_]{4,60}/gi;
const IMG_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
/** Image ids a view-only journal refers to — the only ones its link may serve. */
export const imageIds = (data) => new Set((JSON.stringify(data).match(IMG_ID) || []));
const imageFile = (imgDir, id) => { for (const ext of Object.keys(IMG_EXT)) { const f = path.join(imgDir, id + ext); if (fs.existsSync(f)) return f; } return null; };
/** Send one image of a shared journal (404 unless that journal refers to it). */
export function sendShareImage(res, imgDir, data, id) {
  if (!/^img_[a-z0-9_]{4,60}$/i.test(id) || !imageIds(data).has(id)) { res.statusCode = 404; return res.end(); }
  const f = imageFile(imgDir, id);
  if (!f) { res.statusCode = 404; return res.end(); }
  res.statusCode = 200;
  res.setHeader('Content-Type', IMG_EXT[path.extname(f)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Robots-Tag', 'noindex');
  return fs.createReadStream(f).pipe(res);
}
/** Images embedded in a snapshot file as data URLs (up to `budget` bytes in all). */
export function embedImages(imgDir, data, budget = 40e6) {
  const out = {}; let used = 0;
  for (const id of imageIds(data)) {
    const f = imageFile(imgDir, id);
    if (!f) continue;
    const size = fs.statSync(f).size;
    if (used + size > budget) continue;
    used += size;
    out[id] = `data:${IMG_EXT[path.extname(f)]};base64,${fs.readFileSync(f).toString('base64')}`;
  }
  return out;
}

// ---------- HTTP ----------
const send = (res, code, obj, headers = {}) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(obj === undefined ? '' : JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });

/** Files the shared page needs to load (the app's code and styles, fonts, icons). */
export const isShareAsset = (url) => /^\/(assets\/[\w.-]+|favicon\.svg|icons\/[\w.-]+\.png)(\?.*)?$/.test(url);

export function createShareHandler({ dataDir, distDir, port, readState }) {
  const store = createShareStore(dataDir);
  const meta = (link, extra = {}) => ({ token: link?.token, scope: link?.scope || { kind: 'all' }, label: link?.label || '', hideMoney: !!link?.hideMoney, createdAt: link?.createdAt || new Date().toISOString(), ...extra });

  const imgDir = path.join(dataDir, 'images');
  /** Public: the shared view's data (…/state) and its screenshots (…/image/<id>). */
  async function publicApi(req, res) {
    const [, , , token, what, id] = req.url.split('?')[0].split('/');
    const link = tokenOk(token) ? store.get(token) : null;
    if (!isLive(link)) return send(res, 404, { error: link?.revoked ? 'revoked' : link ? 'expired' : 'not_found' });
    if (what === 'image') return sendShareImage(res, imgDir, sanitizeState(readState(), link.scope, { hideMoney: link.hideMoney }), id);
    store.viewed(token);
    const by = readState()?.user?.name;
    return send(res, 200, { meta: meta(link, { sharedBy: by ? String(by).split(/\s+/)[0] : '' }), state: sanitizeState(readState(), link.scope, { hideMoney: link.hideMoney }) }, { 'X-Robots-Tag': 'noindex' });
  }

  /** Signed-in owner: manage links, Funnel, snapshots. */
  async function api(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean); // api, shares, …
    try {
      if (req.method === 'GET' && parts.length === 2) return send(res, 200, { links: store.list(), funnel: await funnelInfo(port) });
      if (req.method === 'POST' && parts.length === 2) { const b = await readBody(req); return send(res, 200, { link: store.create(b) }); }
      if (req.method === 'POST' && parts[2] === 'funnel') return send(res, 200, await enableFunnel(port));
      if (req.method === 'POST' && parts[2] === 'snapshot') {
        const b = await readBody(req);
        const scope = cleanScope(b.scope);
        const by = readState()?.user?.name;
        const data = sanitizeState(readState(), scope, { hideMoney: !!b.hideMoney });
        const html = buildSnapshot(distDir, data, meta(null, { scope, label: String(b.label || '').slice(0, 80), hideMoney: !!b.hideMoney, snapshot: true, sharedBy: by ? String(by).split(/\s+/)[0] : '', images: embedImages(imgDir, data) }));
        const name = `roninflow-${(scope.kind === 'page' ? scope.label || 'page' : 'journal').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${new Date().toISOString().slice(0, 10)}.html`;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.end(html);
      }
      if (req.method === 'DELETE' && parts[2] && tokenOk(parts[2])) return send(res, 200, { ok: url.searchParams.get('forget') ? store.remove(parts[2]) : store.revoke(parts[2]) });
      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      return send(res, 500, { error: String(e?.message || e) });
    }
  }
  return { api, publicApi, store };
}
