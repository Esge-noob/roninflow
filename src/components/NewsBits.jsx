// Small pieces shared by the News pages and the top-bar alert pill.
import { useState } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import { NEWS_MARKETS, chainFor, DRIVERS } from '../lib/newsRules';
import { fmtTime12, wallClock } from '../lib/stats';

const DOLLARS = new Set(['CL', 'NG', 'GC', 'SI', 'HG', 'BTC']);
/** "Gold ▼ $12.40" / "S&P ▲ 6.25" */
export function fmtMove(market, chg) {
  if (chg == null || !Number.isFinite(chg)) return '';
  const m = NEWS_MARKETS[market];
  const a = Math.abs(chg);
  const cls = m?.cls;
  const dp = cls === 'fx' ? 4 : cls === 'yen' ? 6 : market === 'NG' || market === 'HG' ? 3 : 2;
  return `${m?.short || market} ${chg > 0 ? '▲' : chg < 0 ? '▼' : '•'} ${DOLLARS.has(market) ? '$' : ''}${a.toFixed(dp)}`;
}
export const sideOf = (x, market) => (x?.impacts?.[market] > 0 ? 'helps' : x?.impacts?.[market] < 0 ? 'hurts' : 'neutral');
export const timeOf = (t) => fmtTime12(wallClock(new Date(t)));
export function ago(t, now = Date.now()) {
  const m = Math.round((now - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
export const SRC = { truth: 'Truth Social', investinglive: 'investingLive', fxstreet: 'FXStreet', investing: 'Investing.com', cnbc: 'CNBC', 'cnbc-economy': 'CNBC', marketwatch: 'MarketWatch', 'fed-press': 'Federal Reserve', 'fed-speeches': 'Federal Reserve', bls: 'BLS', whitehouse: 'White House', calendar: 'Calendar', finnhub: 'Finnhub' };

/** The steps from a headline to a market: Hawkish → Rates stay high → … → Gold ▼ */
export function Chain({ driver, market, quote, onClose, explain }) {
  const steps = chainFor(driver, market);
  const [ai, setAi] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!steps.length) return <div className="nw-chain muted">{DRIVERS[driver]?.label || 'This line'} doesn’t usually move {NEWS_MARKETS[market]?.short || market} much.</div>;
  const last = steps[steps.length - 1];
  return (
    <div className="nw-chain">
      {quote && <div className="nw-quote">“{quote}”{onClose && <button className="icon-btn" onClick={onClose} title="Close">✕</button>}</div>}
      <div className="nw-steps">
        {steps.map((s, i) => (
          <span key={i} className="nw-step-wrap">
            {i > 0 && <ArrowRight size={13} className="muted" />}
            <span className={`nw-step ${i === 0 ? 'first' : ''} ${i === steps.length - 1 ? (last.endsWith('▲') ? 'up' : 'down') : ''}`}>{s}</span>
          </span>
        ))}
      </div>
      {explain && (ai ? <div className="nw-ai">{ai}</div> : (
        <button className="btn sm ghost" disabled={busy} onClick={async () => { setBusy(true); try { setAi((await explain()) || 'No answer from the AI.'); } finally { setBusy(false); } }}><Sparkles size={13} /> {busy ? 'Asking…' : 'Explain with AI'}</button>
      ))}
    </div>
  );
}
