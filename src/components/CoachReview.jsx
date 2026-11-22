import { useMemo, useState } from 'react';
import { RefreshCw, MessageCircle, Sparkles, TriangleExclamationPoint as TriangleAlert } from 'lucide-react';
import { useStore, navigate } from '../store/store';
import { CoachLogo } from './Layout';
import { Markdown } from '../views/Coach';
import { buildReviewContext, askReview, localReview } from '../lib/coach';
import { collectPeriodImages, countPeriodImages } from '../lib/askCoach';
import { PROVIDERS, providerConfig } from '../lib/ai';
import { uid, fmtDate, fmtTime12 } from '../lib/stats';
import { IS_VIEWER } from '../lib/shareMode';

/**
 * "Coach Review" panel at the bottom of a diary day or a review page: asks the Trading Coach for a structured
 * review (summary · what went well · what needs work · action items), keeps it, and can continue as a chat.
 * kind: 'day' | 'weekly' | 'monthly' | 'quarterly' | 'yearly'
 */
export default function CoachReview({ reviewKey, kind, label, date, period, trades, prevTrades = [], extra, noun: nounProp, intro, signature }) {
  const { state, saveCoachReview, setSetting, setChats } = useStore();
  const coach = state.settings.coach;
  const saved = state.coachReviews?.[reviewKey];
  const [busy, setBusy] = useState(false);
  const [busyNote, setBusyNote] = useState('');
  const [err, setErr] = useState('');
  const provider = coach.provider || 'local';
  const noun = nounProp || (kind === 'day' ? 'day' : kind.replace('ly', ''));
  const stale = saved && (saved.tradeCount !== trades.length || Math.abs((saved.net ?? 0) - trades.reduce((a, t) => a + t.pnl, 0)) > 0.005 || (signature != null && saved.signature != null && saved.signature !== signature));
  const autoShots = provider !== 'local' && coach.autoLoadScreenshots !== false;
  const shotStats = useMemo(() => countPeriodImages(state, trades, { date, period }), [state, trades, date, period]);
  const context = () => buildReviewContext(state, { kind, label, date, period, trades, prevTrades, extra });

  const generate = async () => {
    if (coach.requestsUsed >= coach.requestsLimit) { setErr('You have used all your coach requests. Raise the limit in the Trading Coach settings.'); return; }
    setBusy(true); setErr('');
    setBusyNote(autoShots && shotStats.total > 0 ? 'Loading attached chart screenshots…' : `Reviewing your ${noun}…`);
    setSetting('coach', (c) => ({ ...c, requestsUsed: c.requestsUsed + 1 }));
    let ctx = context();
    let text, used = provider, chartsIncluded = 0;
    try {
      if (provider !== 'local') {
        let images = [];
        if (autoShots && shotStats.total > 0) {
          const packed = await collectPeriodImages(state, trades, {
            date,
            period,
            maxImages: kind === 'day' ? 12 : 10,
            includeStrategyRefs: coach.includeStrategyMedia !== false,
          });
          images = packed.images;
          chartsIncluded = packed.included;
          if (packed.included > 0) {
            ctx = {
              ...ctx,
              attachedCharts: {
                includedFromPeriod: packed.included,
                totalInPeriod: packed.totalAvailable,
                ...(packed.includedRefs ? { strategyReferenceExamples: packed.includedRefs } : {}),
                ...(packed.truncated ? { note: `Showing ${packed.included} of ${packed.totalAvailable} charts from this period (prioritizing biggest losses, biggest wins, and most recent).` } : {}),
              },
            };
          }
        }
        setBusyNote(chartsIncluded > 0 ? `Reviewing your ${noun} with ${chartsIncluded} chart${chartsIncluded === 1 ? '' : 's'}…` : `Reviewing your ${noun}…`);
        text = await askReview({ provider, cfg: providerConfig(coach, provider), tone: coach.tone, name: state.user.name, context: ctx, images, thinking: coach.thinking || 'standard' });
        if (!text?.trim()) throw new Error('The model returned an empty answer.');
      } else {
        await new Promise((r) => setTimeout(r, 500));
        text = localReview(ctx, trades);
      }
    } catch (e) {
      setErr(`${PROVIDERS[provider]?.label || 'The AI provider'} didn't answer: ${e.message}. Showing a review built from your data instead.`);
      text = localReview(ctx, trades);
      used = 'local';
      chartsIncluded = 0;
    }
    saveCoachReview(reviewKey, { text, createdAt: new Date().toISOString(), provider: used, tradeCount: trades.length, net: trades.reduce((a, t) => a + t.pnl, 0), chartsIncluded, signature });
    setBusy(false);
    setBusyNote('');
  };

  const chatMore = () => {
    const id = uid('chat');
    setChats((c) => [{
      id, title: `Coach review · ${label}`, createdAt: new Date().toISOString(),
      focus: context(), // follow-up questions in this chat get the same detailed data
      reviewScope: { date: date || null, period: period ? { from: period.from, to: period.to } : null },
      messages: [{ role: 'user', content: kind === 'risk' ? `Review my account condition: ${label}.` : `Give me a coach review of ${label}.` }, { role: 'assistant', content: saved.text }],
    }, ...c]);
    navigate(`coach?chat=${id}`);
  };

  if (IS_VIEWER && !saved) return null; // a shared journal shows coach reviews that exist, and can't make new ones
  return (
    <div className="panel coach-review">
      <div className="panel-head wrap">
        <div className="row" style={{ alignItems: 'center', gap: 12 }}>
          <CoachLogo size={28} icon={14} />
          <div>
            <div className="card-title">Coach Review</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              {label}
              {autoShots && shotStats.total > 0 && ` · ${shotStats.total} chart screenshot${shotStats.total === 1 ? '' : 's'} ready`}
            </div>
          </div>
        </div>
        {saved && !busy && <button className="btn xs" data-edit onClick={generate}><RefreshCw size={12} /> Regenerate</button>}
      </div>

      {busy ? (
        <div className="row gap8 cr-busy"><div className="typing"><span /><span /><span /></div><span className="muted" style={{ fontSize: 13 }}>{busyNote || `Reviewing your ${noun}…`}</span></div>
      ) : saved ? (
        <>
          {stale && <div className="cr-note"><TriangleAlert size={13} /> {kind === 'risk' ? 'Your account or trades changed since this review — regenerate for an up-to-date read.' : `Your trades for this ${noun} changed since this review — regenerate to include them.`}</div>}
          <div className="cr-body"><Markdown text={saved.text} /></div>
          <div className="row between wrap gap12 cr-foot">
            <span className="muted" style={{ fontSize: 12 }}>
              {fmtDate(saved.createdAt)} {fmtTime12(saved.createdAt)} · {saved.provider === 'local' ? 'built from your data' : PROVIDERS[saved.provider]?.label || saved.provider}
              {saved.chartsIncluded > 0 && ` · analyzed ${saved.chartsIncluded} chart${saved.chartsIncluded === 1 ? '' : 's'}`}
            </span>
            <button className="btn white" data-edit onClick={chatMore}><MessageCircle size={14} /> Chat more with the coach</button>
          </div>
        </>
      ) : (
        <div className="cr-empty">
          <div className="muted">{intro || `Get a review of this ${noun} from your Trading Coach — what went well, what needs work, and action items for next time.`}</div>
          <button className="btn white" data-edit onClick={generate} disabled={!trades.length}><Sparkles size={14} /> Generate coach review</button>
          {autoShots && shotStats.total > 0 && (
            <div className="muted2" style={{ fontSize: 12 }}>
              Automatically includes {Math.min(shotStats.total, kind === 'day' ? 12 : 10)} of {shotStats.total} attached chart screenshot{shotStats.total === 1 ? '' : 's'} from this {noun}.
            </div>
          )}
          {provider === 'local' && <div className="muted2" style={{ fontSize: 12 }}>No AI provider is set up, so this will be a data-only review. Add one in the Trading Coach settings for a full review.</div>}
        </div>
      )}
      {err && <div className="cr-note" style={{ marginTop: 12 }}><TriangleAlert size={13} /> {err}</div>}
    </div>
  );
}
