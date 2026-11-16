// The frame around a shared, view-only journal: who shared it and what it covers, the pages it includes,
// and nothing that edits, syncs or reaches the owner's computer.
import { useEffect, useRef, useState } from 'react';
import { Book, ClipboardCheck, Eye, EyeOff, FileText, LayoutDashboard, Link2Off, ShieldCheck, Target, Users } from 'lucide-react';
import { useStore, navigate } from '../store/store';
import { useToast } from './ui';
import { VIEW_ONLY_EVENT, VIEWER_SECTIONS, SNAPSHOT } from '../lib/shareMode';
import { REPO_URL } from '../lib/demoMode';
import { DayPopupContext, ReviewPopupContext } from '../lib/dayPopup';
import { DiaryDayModal } from '../views/Diary';
import { ReviewPopup } from '../views/Review';
import { fmtDate } from '../lib/stats';

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'journal', label: 'Trades', icon: FileText, path: 'journal/database' },
  { id: 'diary', label: 'Diary', icon: Book },
  { id: 'review', label: 'Review', icon: ClipboardCheck, path: 'review/weekly' },
  { id: 'strategy', label: 'Strategy', icon: Target },
  { id: 'risk', label: 'Risk', icon: ShieldCheck },
  { id: 'accounts', label: 'Accounts', icon: Users },
];

export default function ViewerLayout({ route, children }) {
  const { state, storage, setSetting } = useStore();
  const toast = useToast();
  const share = storage.share;
  const scope = share?.scope || { kind: 'all' };
  const home = scope.kind === 'page' && scope.route ? scope.route : 'dashboard';
  const path = route.join('/');
  const [dayPopup, setDayPopup] = useState(null);
  const [reviewPopup, setReviewPopup] = useState(null);
  const contentRef = useRef(null);

  // the first change a viewer tries says why nothing happened
  useEffect(() => {
    const h = () => toast('This is a view-only journal — changes aren’t saved');
    window.addEventListener(VIEW_ONLY_EVENT, h);
    return () => window.removeEventListener(VIEW_ONLY_EVENT, h);
  }, [toast]);
  // a page link stays on its page; a journal link only shows the shared pages
  useEffect(() => {
    if (!share) return;
    if (scope.kind === 'page') { if (!path.startsWith(home)) navigate(home); } else if (!VIEWER_SECTIONS.has(route[0])) navigate('dashboard');
  }, [share, scope.kind, path, home, route]);
  useEffect(() => { setDayPopup(null); setReviewPopup(null); contentRef.current?.scrollTo(0, 0); window.scrollTo(0, 0); }, [path]);
  // text boxes show what was written but can't be typed in
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return undefined;
    const lock = () => el.ownerDocument.querySelectorAll('textarea:not([readonly])').forEach((t) => { t.readOnly = true; });
    lock();
    const mo = new MutationObserver(lock);
    mo.observe(el.ownerDocument.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [share]);

  if (storage.shareError) {
    const msg = { revoked: 'The owner has turned this link off.', expired: 'This link has expired.', offline: 'The journal couldn’t be reached. The computer it runs on may be off — try again later.' }[storage.shareError] || 'This link doesn’t exist, or has been removed.';
    return (
      <div className="viewer-msg">
        <Link2Off size={28} />
        <h1>This shared journal isn’t available</h1>
        <p>{msg}</p>
        <a className="muted" href={REPO_URL} target="_blank" rel="noreferrer">RoninFlow — the free, self-hosted trading journal</a>
      </div>
    );
  }
  if (!share) return <div className="viewer-msg"><div className="viewer-spin" /><p>Loading the shared journal…</p></div>;

  const by = share.sharedBy || state.user?.name;
  const title = scope.kind === 'page' ? scope.label || 'Shared page' : 'Trading journal';
  const priv = state.settings.privacy;
  return (
    <div className="app viewer">
      <main className="main">
        <header className="viewer-top">
          <div className="viewer-id">
            <span className="wordmark">RoninFlow</span>
            <span className="viewer-badge"><Eye size={12} /> View only</span>
            <div className="viewer-title"><b>{title}</b>{by ? <span className="muted"> · shared by {by}</span> : null}{SNAPSHOT ? <span className="muted"> · snapshot from {fmtDate(share.createdAt || new Date().toISOString())}</span> : null}</div>
          </div>
          <div className="row gap8">
            {share.hideMoney
              ? <span className="viewer-note" title="The owner shared this with dollar amounts hidden"><EyeOff size={13} /> Amounts hidden</span>
              : <button className="btn sm" onClick={() => setSetting('privacy', !priv)} title="Hide or show dollar amounts on your screen">{priv ? <Eye size={14} /> : <EyeOff size={14} />} {priv ? 'Show $' : 'Hide $'}</button>}
          </div>
        </header>
        {scope.kind === 'all' && (
          <nav className="viewer-nav" aria-label="Shared pages">
            {NAV.map((n) => <a key={n.id} href={`#/${n.path || n.id}`} className={route[0] === n.id ? 'on' : ''}><n.icon size={15} /> {n.label}</a>)}
          </nav>
        )}
        <DayPopupContext.Provider value={setDayPopup}>
          <ReviewPopupContext.Provider value={setReviewPopup}>
            <div className="content viewer-content" ref={contentRef}>{children}</div>
          </ReviewPopupContext.Provider>
        </DayPopupContext.Provider>
        <footer className="viewer-foot">Shared from <a href={REPO_URL} target="_blank" rel="noreferrer">RoninFlow</a>, a free, self-hosted trading journal. Account numbers are hidden; nothing here can be changed.</footer>
      </main>
      {dayPopup && <DiaryDayModal date={dayPopup} onClose={() => setDayPopup(null)} />}
      {reviewPopup && <ReviewPopup period={reviewPopup} onClose={() => setReviewPopup(null)} />}
    </div>
  );
}
