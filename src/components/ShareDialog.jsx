// Share the journal (or the page you're on) as a view-only link anyone can open, or as a snapshot file.
// Links are served from this computer through Tailscale Funnel (or your own public address); snapshots are one
// HTML file that opens anywhere. Either way account numbers are hidden and nothing can be changed.
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Download, ExternalLink, Globe, Link2, Share2, Trash, X } from 'lucide-react';
import { useStore } from '../store/store';
import { Modal, ModalHead, Seg, useToast } from './ui';
import { periodFromId, shiftPeriod, REVIEW_TYPES } from '../lib/reviews';
import { fmtDate } from '../lib/stats';
import { IS_DEMO } from '../lib/demoMode';

/** What "this page" means for a route: { label, from?, to? } or null when the page can't be shared on its own. */
export function pageScope(route, state) {
  const [section, sub, id] = route;
  switch (section) {
    case 'dashboard': case undefined: case '': return { route: 'dashboard', label: `Dashboard${state.settings.dashView && state.settings.dashView !== 'My Dashboard' ? ` · ${state.settings.dashView}` : ''}` };
    case 'review': {
      const type = sub || 'weekly';
      const p = periodFromId(type, id); // no id: the current period
      // the review compares with the period before it, so that comes along too
      return { route: `review/${type}/${p.id}`, label: `${REVIEW_TYPES.find((t) => t.id === type)?.label} review · ${p.label}`, from: shiftPeriod(p, -1).from, to: p.to };
    }
    case 'diary': return sub ? { route: `diary/${sub}`, label: `Diary · ${fmtDate(sub)}`, from: sub, to: sub } : { route: 'diary', label: 'Daily diary' };
    case 'journal': return { route: 'journal/database', label: 'Trades' };
    case 'strategy': return { route: sub ? `strategy/${sub}` : 'strategy', label: 'Strategy' };
    case 'risk': return { route: 'risk', label: 'Risk management' };
    case 'accounts': return { route: 'accounts', label: 'Accounts' };
    default: return null; // coach, macro, payouts, connections… aren't part of a shared journal
  }
}

const EXPIRY = [{ value: 0, label: 'Never' }, { value: 1, label: '1 day' }, { value: 7, label: '7 days' }, { value: 30, label: '30 days' }];
const scopeText = (l) => (l.scope?.kind === 'page' ? l.scope.label || 'A page' : 'Whole journal');

export function ShareButton({ route }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn sm share-btn" onClick={() => setOpen(true)} title="Share a view-only link or snapshot of your journal"><Share2 size={14} /> <span className="hide-m">Share</span></button>
      {open && <ShareDialog route={route} onClose={() => setOpen(false)} />}
    </>
  );
}

function CopyField({ text }) {
  const [done, setDone] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => {}); };
  return (
    <div className="share-copy">
      <input className="input" readOnly value={text} onFocus={(e) => e.target.select()} aria-label="Share link" />
      <button className="btn sm white" onClick={copy}>{done ? <Check size={14} /> : <Copy size={14} />} {done ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

export default function ShareDialog({ route, onClose }) {
  const { state, storage, setSetting } = useStore();
  const toast = useToast();
  const page = pageScope(route, state);
  const [what, setWhat] = useState(page ? 'page' : 'all');
  const [expires, setExpires] = useState(7);
  const [hideMoney, setHideMoney] = useState(false);
  const [withTicks, setWithTicks] = useState(true);
  const [info, setInfo] = useState(null); // { links, funnel }
  const [busy, setBusy] = useState('');
  const [made, setMade] = useState(null);
  const [funnelMsg, setFunnelMsg] = useState(null);
  const custom = state.settings.shareBase || '';
  const server = storage.mode === 'server';

  const refresh = useCallback(() => fetch('/api/shares', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then(setInfo).catch(() => setInfo(null)), []);
  useEffect(() => { if (server) refresh(); }, [server, refresh]);

  const funnel = info?.funnel;
  // where links point: your own address, else this PC's public Tailscale address, else here (this network only)
  const base = (custom || (funnel?.funnel ? funnel.url : '') || window.location.origin).replace(/\/+$/, '');
  const publicOk = !!custom || !!funnel?.funnel;
  const scope = what === 'page' && page ? { kind: 'page', ...page } : { kind: 'all' };
  const label = scope.kind === 'page' ? page.label : 'Whole journal';

  const create = async () => {
    setBusy('link');
    try {
      const r = await fetch('/api/shares', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope, label, expiresInDays: expires, hideMoney }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Couldn’t make the link');
      setMade(j.link);
      refresh();
    } catch (e) { toast(e.message); }
    setBusy('');
  };
  const snapshot = async () => {
    setBusy('snap');
    if (IS_DEMO) { // no server on the demo site: the file is put together in this browser
      try {
        const { demoSnapshot } = await import('../lib/demoSnapshot');
        const { html, name } = await demoSnapshot(state, scope, label, hideMoney, withTicks);
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        const a = Object.assign(document.createElement('a'), { href: url, download: name });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast('Snapshot downloaded — open it in any browser');
      } catch (e) { toast(e.message); }
      setBusy('');
      return;
    }
    try {
      const r = await fetch('/api/shares/snapshot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope, label, hideMoney, ticks: withTicks, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
      if (!r.ok) throw new Error('Couldn’t build the snapshot');
      const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'roninflow-snapshot.html';
      const url = URL.createObjectURL(await r.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('Snapshot downloaded — send the file to anyone');
    } catch (e) { toast(e.message); }
    setBusy('');
  };
  const turnOnFunnel = async () => {
    setBusy('funnel'); setFunnelMsg(null);
    try { const j = await (await fetch('/api/shares/funnel', { method: 'POST' })).json(); setFunnelMsg(j); await refresh(); } catch { setFunnelMsg({ ok: false, message: 'Couldn’t reach Tailscale.' }); }
    setBusy('');
  };
  const revoke = async (token, forget = false) => { await fetch(`/api/shares/${token}${forget ? '?forget=1' : ''}`, { method: 'DELETE' }); if (made?.token === token) setMade(null); refresh(); };

  const links = info?.links || [];
  const live = links.filter((l) => !l.revoked && (!l.expiresAt || Date.parse(l.expiresAt) > Date.now()));
  const old = links.filter((l) => !live.includes(l));

  return (
    <Modal open onClose={onClose} width={640}>
      <ModalHead title="Share your journal" sub="A view-only link or file — account numbers are hidden and nothing can be changed" onClose={onClose} />
      <div className="modal-body share-body">
        {!server && !IS_DEMO && <div className="share-warn">Sharing needs RoninFlow running on your computer (the app, Docker or a home server).</div>}
        {IS_DEMO && <div className="share-warn">In the demo you can download a snapshot file. Live links are served by RoninFlow on your computer (or home server), so they aren’t available here.</div>}

        <div className="field"><label className="label">What to share</label>
          <div className="share-what">
            <label className={`share-opt ${what === 'page' ? 'on' : ''} ${page ? '' : 'off'}`}>
              <input type="radio" name="share-what" checked={what === 'page'} disabled={!page} onChange={() => setWhat('page')} />
              <span><b>This page</b><em>{page ? page.label : 'This page can’t be shared on its own'}{page?.from ? ' — only these dates are included' : ''}</em></span>
            </label>
            <label className={`share-opt ${what === 'all' ? 'on' : ''}`}>
              <input type="radio" name="share-what" checked={what === 'all'} onChange={() => setWhat('all')} />
              <span><b>Whole journal</b><em>Dashboard, trades, diary, reviews, strategy, risk and accounts</em></span>
            </label>
          </div>
        </div>
        <div className="share-row">
          <div className="field"><label className="label">Link expires</label><Seg value={expires} onChange={setExpires} options={EXPIRY} /></div>
          <label className="share-check"><input type="checkbox" className="cbx" checked={hideMoney} onChange={(e) => setHideMoney(e.target.checked)} /> Hide dollar amounts</label>
        </div>
        <div className="share-note">Left out of every share: account numbers (shown as “Account 1, 2…”), broker details, account costs, payouts, your notebook, AI chats, connections and your email.</div>

        <section className="share-sec">
          <div className="share-sec-h"><Link2 size={15} /> <b>Live link</b><span className="muted">— always up to date; works while this computer (or your home server) is on. Charts open full screen, with replay — tick by tick where your ticks are saved</span></div>
          {server && !info && <div className="muted" style={{ fontSize: 12.5 }}>Checking…</div>}
          {info && !publicOk && (
            <div className="share-funnel">
              {funnel?.running
                ? <>
                  <div><b>Turn on public sharing</b> <span className="muted">— Tailscale Funnel gives this computer a public HTTPS address ({funnel.dns}). Only share links can be opened through it; the rest of your journal still needs your password.</span></div>
                  <button className="btn sm white" disabled={busy === 'funnel'} onClick={turnOnFunnel}><Globe size={14} /> {busy === 'funnel' ? 'Turning on…' : 'Turn on'}</button>
                  {funnelMsg && <div className={funnelMsg.ok ? 'pos' : 'warn'} style={{ fontSize: 12.5 }}>{funnelMsg.message}{funnelMsg.enableUrl && <> <a href={funnelMsg.enableUrl} target="_blank" rel="noreferrer">Allow Funnel <ExternalLink size={11} /></a></>}</div>}
                </>
                : <div><b>To share with anyone</b> <span className="muted">— install <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">Tailscale</a> (free) on this computer and sign in, then come back here and turn on public sharing. Or put your own public address below (e.g. a Cloudflare Tunnel).</span></div>}
              <div className="muted" style={{ fontSize: 12 }}>Until then, links only open on your own network. A snapshot file works anywhere.</div>
            </div>
          )}
          <details className="share-custom" open={!!custom}>
            <summary>Use my own public address</summary>
            <input className="input" placeholder="https://journal.example.com" defaultValue={custom} onBlur={(e) => setSetting('shareBase', e.target.value.trim().replace(/\/+$/, '') || null)} aria-label="Public address" />
            <span className="muted" style={{ fontSize: 12 }}>For a Cloudflare Tunnel or reverse proxy pointing at RoninFlow. Share links work through it without a password; everything else still asks for one.</span>
          </details>
          <button className="btn white" disabled={!server || busy === 'link'} onClick={create}><Link2 size={14} /> {busy === 'link' ? 'Making link…' : `Make a link to ${scope.kind === 'page' ? 'this page' : 'the whole journal'}`}</button>
          {made && (
            <div className="share-made">
              <CopyField text={`${base}/s/${made.token}`} />
              <div className="muted" style={{ fontSize: 12 }}>{scopeText(made)} · {made.expiresAt ? `expires ${fmtDate(made.expiresAt)}` : 'never expires'}{made.hideMoney ? ' · amounts hidden' : ''}{!publicOk ? ' · opens on your network only' : ''}</div>
            </div>
          )}
        </section>

        <section className="share-sec">
          <div className="share-sec-h"><Download size={15} /> <b>Snapshot file</b><span className="muted">— one file that opens in any browser, even when this computer is off; frozen as it is now, execution charts included (full screen and replay too)</span></div>
          <label className="share-check"><input type="checkbox" className="cbx" checked={withTicks} onChange={(e) => setWithTicks(e.target.checked)} /> Include saved tick data, so replays go tick by tick <span className="muted">(about 0.5–1 MB per hour of ticks)</span></label>
          <button className="btn" disabled={(!server && !IS_DEMO) || busy === 'snap'} onClick={snapshot}><Download size={14} /> {busy === 'snap' ? 'Building…' : `Download ${scope.kind === 'page' ? 'this page' : 'the whole journal'} as a file`}</button>
        </section>

        {links.length > 0 && (
          <section className="share-sec">
            <div className="share-sec-h"><b>Your links</b><span className="muted">— turn one off and it stops working straight away</span></div>
            <div className="share-list">
              {live.map((l) => (
                <div key={l.token} className="share-item">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="truncate"><b>{scopeText(l)}</b></div>
                    <div className="muted" style={{ fontSize: 12 }}>Made {fmtDate(l.createdAt)} · {l.expiresAt ? `expires ${fmtDate(l.expiresAt)}` : 'no expiry'} · {l.views || 0} view{l.views === 1 ? '' : 's'}{l.hideMoney ? ' · amounts hidden' : ''}</div>
                  </div>
                  <button className="btn xs" onClick={() => { navigator.clipboard?.writeText(`${base}/s/${l.token}`); toast('Link copied'); }}><Copy size={12} /> Copy</button>
                  <button className="btn xs danger-ghost" onClick={() => revoke(l.token)}><X size={12} /> Turn off</button>
                </div>
              ))}
              {old.map((l) => (
                <div key={l.token} className="share-item off">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="truncate">{scopeText(l)}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{l.revoked ? 'Turned off' : 'Expired'} · {l.views || 0} view{l.views === 1 ? '' : 's'}</div>
                  </div>
                  <button className="icon-btn" onClick={() => revoke(l.token, true)} title="Remove from the list"><Trash size={13} /></button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}
