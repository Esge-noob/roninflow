// Macro → News Agents: switch on the agents that come set up, or tell one your trade in plain words. They read every
// headline on your computer, day and night, and alert you in the top bar only when one matters. Also: which markets
// the news follows, the news sources, and the optional AI.
import { useEffect, useState } from 'react';
import { Plus, Trash2, Bot, Sparkles, Rss, Radio } from 'lucide-react';
import MacroSwitch from '../components/MacroSwitch';
import { Switch } from '../components/ui';
import { useMacro } from '../lib/macro';
import { NEWS_MARKETS } from '../lib/newsRules';
import { fmtMove, ago, timeOf, SRC } from '../components/NewsBits';
import { IS_DEMO } from '../lib/demoMode';

const post = (path, body) => fetch(`/api/macro/news/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Couldn’t save'); return j; });
const ruleText = (r) => {
  if (!r) return '';
  const m = r.market && NEWS_MARKETS[r.market]?.short;
  if (r.kind === 'position') return `Watches ${m} headlines ${r.both ? 'for or against' : 'against'} your ${r.side > 0 ? 'long' : 'short'}.`;
  if (r.kind === 'move') return `Alerts when ${m} moves more than ${r.pct ? `${r.threshold}%` : r.threshold} in the 15 minutes after a headline.`;
  return r.keys?.length ? `Watches headlines mentioning ${r.keys.slice(0, 5).join(', ')}.` : 'Needs AI switched on to understand this one.';
};

export default function NewsAgents() {
  const { data, reload } = useMacro('/api/macro/news/agents');
  const { data: al, reload: reloadAlerts } = useMacro('/api/macro/news/alerts', { poll: 30e3 });
  const [cfg, setCfg] = useState(null);
  const [text, setText] = useState('');
  const [feed, setFeed] = useState('');
  const [fhKey, setFhKey] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetch('/api/macro/news/config').then((r) => r.json()).then(setCfg).catch(() => {}); }, []);
  const save = async (patch) => { setBusy(true); setErr(''); try { setCfg(await post('config', patch)); reload(true); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const agent = async (action, a) => { setBusy(true); setErr(''); try { await post('agents', { action, agent: a }); await reload(true); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const agents = data?.agents || [];
  const builtin = agents.filter((a) => a.builtin), mine = agents.filter((a) => a.custom);
  const onCount = agents.filter((a) => a.on !== false).length;
  const alerts = al?.alerts || [];

  return (
    <div className="page na-page">
      <div className="row gap12 wrap" style={{ alignItems: 'flex-end', marginBottom: 14 }}>
        <div className="grow">
          <MacroSwitch current="agents" />
          <div className="muted" style={{ fontSize: 13.5 }}>They read every headline, day and night, and alert you in the top bar only when one matters.</div>
        </div>
      </div>
      {err && <div className="ec-warn">{err}</div>}
      <div className="na-grid">
        <div className="col gap12">
          <div className="card card-pad">
            <div className="na-h"><Bot size={16} /> Your agents <span className="muted">{onCount} on</span></div>
            <form className="na-add" onSubmit={(e) => { e.preventDefault(); if (text.trim()) agent('add', { text }).then(() => setText('')); }}>
              <input className="input grow" placeholder="Tell it your trade — e.g. “I’m long gold. Tell me if anything goes against it.”" value={text} onChange={(e) => setText(e.target.value)} maxLength={300} />
              <button className="btn sm primary" disabled={busy || !text.trim()}><Plus size={14} /> Add</button>
            </form>
            <div className="muted na-hint">Or a condition: “Anything that moves oil more than $1”, “Semiconductor tariffs”. {data?.ai ? 'Your Trading Coach’s AI reads your sentences.' : 'Built-in rules understand positions, price moves and keywords; switch on AI below for anything else.'}</div>
            {mine.map((a) => (
              <div key={a.id} className="na-agent mine">
                <Switch on={a.on !== false} onChange={(v) => agent('toggle', { id: a.id, on: v })} />
                <span className="grow"><b>“{a.text}”</b><small>{ruleText(a.rule)}</small></span>
                <button className="icon-btn" title="Delete" onClick={() => agent('delete', { id: a.id })}><Trash2 size={14} /></button>
              </div>
            ))}
            <div className="na-sub">Set up for you</div>
            {builtin.map((a) => (
              <div key={a.id} className="na-agent">
                <Switch on={a.on} onChange={(v) => agent('toggle', { id: a.id, on: v })} />
                <span className="grow"><b>{a.label}{a.market ? <span className="muted"> · {a.market}</span> : ''}</b><small>{a.desc}</small></span>
              </div>
            ))}
          </div>

          <div className="card card-pad">
            <div className="na-h"><Radio size={16} /> Markets the news follows</div>
            <div className="muted na-hint">Everything you’ve traded in the last 120 days{cfg?.traded?.length ? ` (${cfg.traded.join(', ')})` : ''}, plus any you add.</div>
            <div className="row gap6 wrap">
              {(cfg?.all || []).map((x) => {
                const traded = cfg.traded.includes(x.key), extra = cfg.extraMarkets.includes(x.key);
                return <button key={x.key} className={`chip ${traded || extra ? 'on' : ''}`} disabled={busy || traded} title={traded ? 'You trade this' : x.label} onClick={() => save({ extraMarkets: extra ? cfg.extraMarkets.filter((k) => k !== x.key) : [...cfg.extraMarkets, x.key] })}>{x.key} <span className="muted">{x.label}</span></button>;
              })}
            </div>
          </div>

          <div className="card card-pad">
            <div className="na-h"><Sparkles size={16} /> AI</div>
            <label className="row gap8"><Switch on={!!cfg?.ai?.on} disabled={busy || IS_DEMO} onChange={(v) => save({ ai: { ...cfg.ai, on: v } })} /> <span>Let your Trading Coach’s AI read the important headlines and your sentence agents</span></label>
            <div className="muted na-hint">
              {cfg?.ai?.provider ? <>Uses your Trading Coach’s provider ({cfg.ai.provider}). </> : <>Set up an AI provider in the Trading Coach first. </>}
              Built-in rules read every line for free either way; the AI only sees lines that matter (and lines your sentence agents might care about), up to
              <input className="input na-num" type="number" min={5} max={500} value={cfg?.ai?.perHour || 40} disabled={busy || IS_DEMO} onChange={(e) => setCfg((c) => ({ ...c, ai: { ...c.ai, perHour: e.target.value } }))} onBlur={() => save({ ai: { ...cfg.ai, perHour: Number(cfg.ai.perHour) } })} /> requests an hour{cfg?.ai?.on ? ` (${cfg.ai.usedThisHour} this hour)` : ''}.
            </div>
          </div>
        </div>

        <div className="col gap12">
          <div className="card card-pad">
            <div className="na-h">Recent alerts {al?.unread ? <span className="badge neg-soft">{al.unread} new</span> : null}<span className="grow" />{al?.unread ? <button className="btn sm ghost" onClick={() => post('alerts/read', {}).then(() => reloadAlerts(true))}>Mark all read</button> : null}</div>
            {!alerts.length && <div className="muted" style={{ fontSize: 13 }}>No alerts yet. Your agents are reading.</div>}
            {alerts.slice(0, 30).map((a) => (
              <div key={a.id} className={`na-alert ${a.read ? '' : 'new'} ${a.side}`}>
                <div className="row gap8"><span className="nw-t">{timeOf(a.t)}</span><b className="grow">{a.agents.join(' · ')}</b><span className="muted">{ago(a.t)}</span></div>
                <div className="na-alert-why"><span className={`nw-tone ${a.side}`}>{a.why}</span> {a.title}</div>
                {a.market && <div className="muted" style={{ fontSize: 12 }}>{NEWS_MARKETS[a.market]?.short} {a.price != null ? `${a.price} when it hit` : ''}{a.move != null ? ` · ${fmtMove(a.market, a.move)} in the 15 min after` : ''}</div>}
              </div>
            ))}
          </div>

          <div className="card card-pad">
            <div className="na-h"><Rss size={16} /> News sources</div>
            <div className="muted na-hint">Free feeds, checked every one to ten minutes{cfg?.demo ? ' (sample counts in the demo)' : ''}. Free feeds run seconds to minutes behind paid squawk services.</div>
            {(cfg?.sources || []).map((src) => (
              <div key={src.id} className="na-src">
                <Switch on={src.on} disabled={busy || src.fixed || (src.keyed && !src.hasKey)} onChange={(v) => save({ sources: { [src.id]: v } })} />
                <span className="grow">{src.label}<small className={src.status?.ok === false ? 'neg' : 'muted'}>{src.status ? (src.status.ok ? `OK · ${src.status.n || 0} headlines since start` : src.status.error) : src.keyed && !src.hasKey ? 'Add a key below' : 'Not checked yet'}</small></span>
              </div>
            ))}
            {(cfg?.custom || []).map((f) => (
              <div key={f.id} className="na-src">
                <Switch on={f.on !== false} onChange={(v) => save({ custom: cfg.custom.map((x) => (x.id === f.id ? { ...x, on: v } : x)) })} />
                <span className="grow">{f.label}<small className={f.status?.ok === false ? 'neg' : 'muted'}>{f.url}{f.status?.error ? ` — ${f.status.error}` : ''}</small></span>
                <button className="icon-btn" onClick={() => save({ custom: cfg.custom.filter((x) => x.id !== f.id) })}><Trash2 size={14} /></button>
              </div>
            ))}
            <form className="na-add" onSubmit={(e) => { e.preventDefault(); if (/^https?:\/\//.test(feed)) save({ custom: [...(cfg.custom || []), { url: feed.trim() }] }).then(() => setFeed('')); }}>
              <input className="input grow" placeholder="Add an RSS feed (https://…)" value={feed} onChange={(e) => setFeed(e.target.value)} disabled={IS_DEMO} />
              <button className="btn sm" disabled={busy || !/^https?:\/\//.test(feed)}>Add</button>
            </form>
            <form className="na-add" onSubmit={(e) => { e.preventDefault(); save({ finnhubKey: fhKey }).then(() => setFhKey('')); }}>
              <input className="input grow" type="password" placeholder={cfg?.sources?.find((x) => x.id === 'finnhub')?.hasKey ? 'Finnhub key saved — paste a new one to replace it' : 'Finnhub API key (free at finnhub.io)'} value={fhKey} onChange={(e) => setFhKey(e.target.value)} disabled={IS_DEMO} />
              <button className="btn sm" disabled={busy || !fhKey.trim()}>Save</button>
            </form>
            <label className="row gap8" style={{ marginTop: 10 }}><Switch on={cfg?.yahoo !== false} disabled={busy || IS_DEMO} onChange={(v) => save({ yahoo: v })} /> <span>Use Yahoo’s free prices for the heat map’s rates, dollar and linked markets, and for markets your platform doesn’t send</span></label>
          </div>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>Agents don’t trade for you — they read the news and tell you when it matters. Sources: {Object.values(SRC).filter((v, i, a) => a.indexOf(v) === i).join(', ')}.</div>
    </div>
  );
}
