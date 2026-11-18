// Top-bar heads-up for today: the next high-impact release (with a countdown) or a market holiday — and your News
// Agents' alerts: while one is unread the pill pulses with its headline; click it for the alerts and today's events.
// Small and out of the way; the calendar part can be hidden until tomorrow.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, X, Bell, Newspaper } from 'lucide-react';
import { NEWS_MARKETS } from '../lib/newsRules';
import { fmtMove } from './NewsBits';
import { useStore } from '../store/store';
import { Popover } from './ui';
import { useMacro, countdown, FLAGS, surprise } from '../lib/macro';
import { wallClock, fmtTime12 } from '../lib/stats';

const DISMISS = 'rf-news-hidden';
const readHidden = () => { try { return localStorage.getItem(DISMISS); } catch { return null; } };
const HOL = { closed: 'markets closed', early: 'early close', bank: 'banks closed' };

export default function MacroPill() {
  const { state } = useStore();
  const s = state.settings;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(id); }, []);
  const today = wallClock(new Date(now)).slice(0, 10);
  const [hidden, setHidden] = useState(readHidden);
  const off = s.newsPill === false || hidden === today;
  const { data } = useMacro(s.newsPill === false || hidden === today ? null : `/api/macro/calendar?from=${today}&to=${today}${s.ecTradingView === false ? '&tv=0' : ''}`, { poll: 5 * 60e3 });
  // News Agents' alerts
  const [news, setNews] = useState({ alerts: [], unread: 0 });
  const alive = useRef(true);
  const loadNews = useCallback(() => fetch('/api/macro/news/alerts', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && alive.current) setNews({ alerts: j.alerts || [], unread: j.unread || 0 }); }).catch(() => {}), []);
  useEffect(() => {
    alive.current = true;
    if (s.newsPill === false) return undefined;
    loadNews();
    const id = setInterval(loadNews, 30e3);
    return () => { alive.current = false; clearInterval(id); };
  }, [loadNews, s.newsPill]);
  const readAlerts = () => { if (news.unread) fetch('/api/macro/news/alerts/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(() => setNews((n) => ({ alerts: n.alerts.map((a) => ({ ...a, read: true })), unread: 0 }))).catch(() => {}); };
  const recentAlerts = news.alerts.filter((a) => a.t > now - 24 * 3600e3);
  const latest = news.alerts.find((a) => !a.read);

  const ccys = s.ecCcys || [];
  const { majors, holidays } = useMemo(() => {
    const list = (data?.events || []).map((e) => ({ ...e, ms: Date.parse(e.t), clock: wallClock(e.t) }))
      .filter((e) => (!ccys.length || ccys.includes(e.ccy)) && (e.allDay ? e.t.slice(0, 10) : e.clock.slice(0, 10)) === today);
    return {
      majors: list.filter((e) => e.impact === 'high' && !e.allDay).sort((a, b) => a.ms - b.ms),
      // closures first, US first
      holidays: list.filter((e) => e.holiday).sort((a, b) => (a.holiday === 'bank') - (b.holiday === 'bank') || (b.ccy === 'USD') - (a.ccy === 'USD')),
    };
  }, [data, ccys, today]);

  if (s.newsPill === false) return null;
  const next = off ? null : majors.find((e) => e.ms > now - 2 * 60e3);
  // every release at the same minute as the next one ("CPI m/m +2")
  const batch = next ? majors.filter((e) => e.ms === next.ms) : [];
  const soon = next && next.ms - now < 15 * 60e3;
  const hol = off ? null : holidays[0];
  if (!next && !hol && !latest && !recentAlerts.length) return null; // nothing coming up, no news

  const hide = () => { try { localStorage.setItem(DISMISS, today); } catch { /* private window */ } setHidden(today); };
  const label = latest
    ? <><b className="truncate">{latest.title}</b>{news.unread > 1 && <span className="muted"> +{news.unread - 1}</span>}</>
    : next
    ? <><b className="truncate">{next.ccy} {next.title}</b>{batch.length > 1 && <span className="muted"> +{batch.length - 1}</span>}<span className="mp-when">{next.ms <= now ? 'now' : soon ? countdown(next.ms - now) : fmtTime12(next.clock)}</span></>
    : hol ? <b className="truncate">{hol.short} — {HOL[hol.holiday]}</b> : null;

  return (
    <Popover className="mp-wrap" align="right" width={380} trigger={({ toggle, open }) => (
      <button className={`btn sm ghost macro-pill ${latest && !open ? 'alert' : ''} ${latest ? `side-${latest.side}` : ''} ${soon && !latest ? 'soon' : ''} ${!next && !latest ? 'hol' : ''} ${!label ? 'icon-only' : ''}`} onClick={() => { toggle(); readAlerts(); }} title={latest ? 'News alert — click to see it' : 'Today’s market events and news alerts'}>
        {latest || (!next && !hol) ? <Bell size={14} className="mp-bell" /> : <i className={`mp-dot ${next ? 'high' : hol.holiday}`} />}
        {label && <span className="mp-lbl row gap6">{label}</span>}
        {next && hol && !latest && <span className="mp-holmark" title={`${hol.short} — ${HOL[hol.holiday]}`}>{FLAGS[hol.ccy]}</span>}
      </button>
    )}>
      {(close) => (
        <div className="mp-pop">
          {recentAlerts.length > 0 && (
            <>
              <div className="mp-head"><span>News alerts</span><a href="#/macro/agents" className="muted" onClick={close} style={{ fontWeight: 400, fontSize: 12 }}>Agents</a></div>
              {recentAlerts.slice(0, 6).map((a) => (
                <a key={a.id} href="#/macro/news" onClick={close} className={`mp-alert ${a.read ? '' : 'new'} ${a.side}`}>
                  <span className="row gap8"><span className="mp-t">{fmtTime12(wallClock(new Date(a.t)))}</span><b className="grow truncate">{a.agents.join(' · ')}</b>{a.market && <span className="muted">{NEWS_MARKETS[a.market]?.short}</span>}</span>
                  <span className="mp-alert-t"><span className={`nw-tone ${a.side}`}>{a.why}</span> {a.title}</span>
                  {a.move != null && a.market && <span className={`mp-alert-mv ${a.move > 0 ? 'pos' : a.move < 0 ? 'neg' : 'muted'}`}>{fmtMove(a.market, a.move)} in the 15 min after</span>}
                </a>
              ))}
            </>
          )}
          {!off && (majors.length > 0 || holidays.length > 0) && <div className="mp-head"><span>Today</span><button className="icon-btn" title="Hide today’s events until tomorrow" onClick={() => { close(); hide(); }}><X size={14} /></button></div>}
          {!off && holidays.map((h) => (
            <div key={h.id} className="mp-row"><span className={`ec-hol ${h.holiday}`}>{HOL[h.holiday]}</span><span className="grow">{FLAGS[h.ccy]} {h.short}</span></div>
          ))}
          {!off && majors.map((e) => {
            const sp = surprise(e);
            return (
              <div key={e.id} className={`mp-row ${e.ms < now - 2 * 60e3 ? 'past' : ''}`}>
                <span className="mp-t">{fmtTime12(e.clock)}</span>
                <span className="grow truncate" title={e.title}>{FLAGS[e.ccy]} {e.ccy} {e.title}</span>
                <span className={`mp-v ${sp === 'beat' ? 'pos' : sp === 'miss' ? 'neg' : ''}`}>{e.actual || (e.ms > now ? countdown(e.ms - now).replace('in ', '') : e.forecast ? `f ${e.forecast}` : '')}</span>
              </div>
            );
          })}
          {!off && !majors.length && holidays.length > 0 && <div className="mp-row muted">No high-impact releases today.</div>}
          <div className="mp-foot">
            <a href="#/macro/calendar" onClick={close}><CalendarDays size={14} /> Calendar</a>
            <a href="#/macro/news" onClick={close}><Newspaper size={14} /> News Flow</a>
            <span className="muted">{ccys.length ? ccys.join(', ') : 'All currencies'}</span>
          </div>
        </div>
      )}
    </Popover>
  );
}
