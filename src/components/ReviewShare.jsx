// "Share reviews" toggle: copy trade reviews (notes, tags, strategy, blockers, rating, screenshots, reviewed)
// onto the same trade on other accounts — so a breached account's journal isn't lost.
import { useMemo } from 'react';
import { Check, ChevronDown, Link2 } from 'lucide-react';
import { useStore } from '../store/store';
import { Popover, Seg, useToast } from './ui';
import { backfillReviews, LINK_TOLERANCE } from '../lib/linkedTrades';

export function useReviewSync() {
  const { state } = useStore();
  const s = state.settings.reviewSync;
  return s && s.mode && s.mode !== 'off' ? s : { mode: 'off', accounts: s?.accounts || [] };
}

export default function ReviewShare() {
  const { state, setSetting, backfillReviews: runBackfill } = useStore();
  const toast = useToast();
  const sync = useReviewSync();
  const set = (patch) => setSetting('reviewSync', { ...sync, ...patch });
  const label = sync.mode === 'all' ? 'All accounts' : sync.mode === 'selected' ? `${sync.accounts.length} account${sync.accounts.length === 1 ? '' : 's'}` : 'Off';
  // how many trades the backfill would add something to
  const preview = useMemo(() => (sync.mode === 'off' ? { changed: 0, fields: {} } : backfillReviews(state.trades, state.accounts, sync)), [state.trades, state.accounts, sync]);
  const pending = preview.changed;
  const NAMES = { notes: 'notes', tags: 'tags', strategyId: 'strategy', blockers: 'edge blockers', rating: 'rating', screenshots: 'screenshots', reviewed: 'reviewed' };
  const what = Object.entries(preview.fields).map(([k, n]) => `${NAMES[k]} on ${n}`).join(' · ');
  const toggleAcct = (id) => set({ accounts: sync.accounts.includes(id) ? sync.accounts.filter((x) => x !== id) : [...sync.accounts, id] });
  return (
    <Popover
      align="right"
      width={380}
      className="rshare-pop"
      trigger={({ toggle }) => (
        <button className={`btn rshare-btn ${sync.mode !== 'off' ? 'on' : ''}`} onClick={toggle} title="Share trade reviews with the same trade on other accounts">
          <Link2 size={14} /> <span className="hide-m">Share reviews:</span> <b>{label}</b> <ChevronDown size={13} className="muted" />
        </button>
      )}
    >
      {() => (
        <div className="rshare">
          <div className="rshare-h"><b>Share trade reviews across accounts</b></div>
          <p className="muted">When you copy-trade, each trade exists on several accounts. With sharing on, the notes, tags, strategy, edge blockers, rating, screenshots and “reviewed” you add to one copy are saved on the others too — so if the account you journal on is breached, your reviews live on.</p>
          <Seg value={sync.mode} onChange={(mode) => set({ mode })} options={[{ value: 'off', label: 'This account only' }, { value: 'all', label: 'All accounts' }, { value: 'selected', label: 'Selected' }]} />
          {sync.mode === 'selected' && (
            <div className="rshare-accts">
              {state.accounts.map((a) => (
                <label key={a.id} className="rshare-acct">
                  <input type="checkbox" className="cbx" checked={sync.accounts.includes(a.id)} onChange={() => toggleAcct(a.id)} />
                  <span className="grow truncate">{a.name || a.id}</span>
                  {a.status && a.status !== 'Active' && <span className={`badge ${a.status === 'Breached' ? 'neg' : 'neutral'}`}>{a.status}</span>}
                </label>
              ))}
              {!state.accounts.length && <div className="muted" style={{ fontSize: 12.5 }}>No accounts yet.</div>}
              <div className="muted" style={{ fontSize: 12 }}>Reviews are shared between the accounts ticked here.</div>
            </div>
          )}
          {sync.mode !== 'off' && (
            <div className="rshare-back">
              <div>
                <b>{pending ? `${pending} trade${pending === 1 ? '' : 's'}` : 'Nothing'}</b> <span className="muted">{pending ? 'on other accounts can get the reviews you’ve already written.' : 'to copy — your existing reviews are already shared.'}</span>
              </div>
              {pending > 0 && <div className="rshare-what">{what}</div>}
              <button className="btn sm white" disabled={!pending} onClick={() => { runBackfill(); toast(`Copied reviews to ${pending} linked trade${pending === 1 ? '' : 's'}`); }}><Check size={13} /> Copy existing reviews now</button>
              <div className="muted" style={{ fontSize: 11.5 }}>Only fills what’s missing — notes and ratings already on a copy are kept; tags and screenshots are merged.</div>
            </div>
          )}
          <div className="muted rshare-foot">Trades are matched by contract (MESZ6 = MES), direction, and entries within {LINK_TOLERANCE} seconds; size can differ. New edits are copied as you make them.</div>
        </div>
      )}
    </Popover>
  );
}
