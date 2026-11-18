// Macro → News Flow: live headlines sorted into the stories moving your markets — each line's tone, how that kind of
// news usually moves your market (tap the coloured word for the steps), what it actually did in the 15 minutes after,
// and earlier lines like it. Data: news.js on the journal's server.
import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, History, ChevronDown, ChevronRight } from 'lucide-react';
import MacroSwitch from '../components/MacroSwitch';
import { Modal, ModalHead } from '../components/ui';
import { useStore } from '../store/store';
import { useMacro } from '../lib/macro';
import { NEWS_MARKETS, DRIVERS } from '../lib/newsRules';
import { Chain, fmtMove, sideOf, timeOf, ago, SRC } from '../components/NewsBits';
import { fmtDate } from '../lib/stats';

const TABS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'top', label: 'Top', test: (x) => x.importance >= 2 },
  { id: 'fed', label: 'Fed', test: (x) => x.cats.includes('fed') || x.cats.includes('cb') },
  { id: 'data', label: 'Data', test: (x) => x.cats.includes('data') || x.src === 'calendar' },
  { id: 'wars', label: 'Wars', test: (x) => x.cats.includes('wars') },
  { id: 'trump', label: 'Trump', test: (x) => x.cats.includes('trump') },
  { id: 'trade', label: 'Trade', test: (x) => x.cats.includes('trade') },
  { id: 'energy', label: 'Energy', test: (x) => x.cats.includes('energy') },
];

function Similar({ item, market, onClose }) {
  const { data, loading } = useMacro(`/api/macro/news/similar?id=${item.id}&market=${market}`);
  const list = data?.items || [];
  const m = NEWS_MARKETS[market];
  return (
    <Modal open onClose={onClose} width={620}>
      <ModalHead title="Similar news" onClose={onClose} />
      <div className="nw-sim">
        <div className="muted" style={{ fontSize: 13 }}>Earlier lines with the same story and tone, and how {m.short} moved in the 15 minutes after.</div>
        <div className="nw-sim-this"><span className="muted">This news</span> <b>{item.title}</b></div>
        {loading && !data ? <div className="muted">Looking…</div> : !list.length ? <div className="muted" style={{ padding: '14px 0' }}>Nothing like it yet. News Flow keeps 90 days of headlines, so this fills in as the journal reads more.</div> : (
          <>
            {list.map((y) => (
              <div key={y.id} className="nw-sim-row">
                <span className="nw-t">{fmtDate(new Date(y.t).toISOString().slice(0, 10))} · {timeOf(y.t)}</span>
                <span className="grow">{y.title}</span>
                <b className={y.move?.chg > 0 ? 'pos' : y.move?.chg < 0 ? 'neg' : 'muted'}>{y.move ? fmtMove(market, y.move.chg) : '—'}</b>
              </div>
            ))}
            {(data.up + data.down + data.flat) > 0 && <div className="nw-sim-sum">{m.short} rose after {data.up} of {data.up + data.down + data.flat} and fell after {data.down}.</div>}
          </>
        )}
      </div>
    </Modal>
  );
}

function Line({ x, kids, market, cfg, onSimilar, byId }) {
  const [open, setOpen] = useState(false);
  const [chain, setChain] = useState(false);
  const side = sideOf(x, market);
  const mv = x.move?.[market];
  const m = NEWS_MARKETS[market];
  const opp = x.opposite && byId[x.opposite.id];
  const explain = cfg?.ai?.on ? async () => (await fetch('/api/macro/news/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: x.id, market, ai: true }) }).then((r) => r.json())).text : null;
  return (
    <div className={`nw-line imp${x.importance}`}>
      <div className="nw-when"><b>{timeOf(x.t)}</b><small>{SRC[x.src] || x.src}</small></div>
      <div className="nw-body">
        <div className="nw-title">{x.title}</div>
        <div className="nw-meta">
          {x.story !== 'other' && <span className="nw-story">{x.storyTitle}</span>}
          {x.driver && <button className={`nw-tone ${side}`} onClick={() => setChain((c) => !c)} title="How this moves your market">· {DRIVERS[x.driver].label}</button>}
          {x.impacts?.[market] ? <span className={`nw-moves ${side}`}>{side === 'helps' ? 'Helps' : 'Hurts'} {m.short}</span> : null}
          {mv && <span className={`nw-react ${mv.chg > 0 ? 'pos' : mv.chg < 0 ? 'neg' : 'muted'}`}>{fmtMove(market, mv.chg)} <span className="muted">· 15m</span></span>}
          {x.by === 'ai' && <span className="nw-ai-tag" title="Read by your Trading Coach’s AI">AI</span>}
          <span className="grow" />
          {x.driver && <button className="nw-link" onClick={() => onSimilar(x)}><History size={13} /> Similar news</button>}
          {x.link && <a className="nw-link" href={x.link} target="_blank" rel="noreferrer">Source</a>}
        </div>
        {opp && <div className="nw-opp">Says the opposite of the {timeOf(opp.t)} line: <span className="muted">{opp.title}</span></div>}
        {chain && x.driver && <Chain driver={x.driver} market={market} onClose={() => setChain(false)} explain={explain} />}
        {kids.length > 0 && (
          <>
            <button className="nw-more" onClick={() => setOpen((o) => !o)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {kids.length} more</button>
            {open && kids.map((k) => <div key={k.id} className="nw-kid"><span className="nw-t">{timeOf(k.t)}</span> {k.title} <span className="muted">· {SRC[k.src] || k.src}{k.repeatOf ? ' (same line)' : ''}</span></div>)}
          </>
        )}
      </div>
    </div>
  );
}

export default function NewsFlow() {
  const { state, setSetting } = useStore();
  const s = state.settings;
  const [tab, setTab] = useState('all');
  const [story, setStory] = useState(null);
  const [similar, setSimilar] = useState(null);
  const [cfg, setCfg] = useState(null);
  const { data, error, loading, reload } = useMacro('/api/macro/news/flow?hours=24', { poll: 60e3 });
  useEffect(() => { fetch('/api/macro/news/config').then((r) => r.json()).then(setCfg).catch(() => {}); }, []);
  const markets = data?.markets || [];
  const market = markets.includes(s.newsMarket) ? s.newsMarket : markets[0] || 'ES';
  const items = data?.items || [];
  const byId = useMemo(() => Object.fromEntries(items.map((x) => [x.id, x])), [items]);
  const { top, kids } = useMemo(() => {
    const k = {};
    for (const x of items) { const p = x.under || x.repeatOf; if (p && byId[p]) (k[p] ||= []).push(x); }
    const t = TABS.find((y) => y.id === tab) || TABS[0];
    return { top: items.filter((x) => !(x.under && byId[x.under]) && !(x.repeatOf && byId[x.repeatOf]) && t.test(x) && (!story || x.story === story)), kids: k };
  }, [items, byId, tab, story]);
  const stories = (data?.stories || []).slice(0, 12);

  return (
    <div className="page nw-page">
      <div className="row gap12 wrap" style={{ alignItems: 'flex-end', marginBottom: 14 }}>
        <div className="grow">
          <MacroSwitch current="news" />
          <div className="muted" style={{ fontSize: 13.5 }}>Live headlines sorted into the stories moving your markets, and what each line means for them.</div>
        </div>
      </div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <div className="row gap6 wrap">{TABS.map((t) => <button key={t.id} className={`chip ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>
        <div className="grow" />
        <span className="muted" style={{ fontSize: 12.5 }}>Traced to</span>
        <div className="row gap6 wrap">{markets.map((m) => <button key={m} className={`chip ${market === m ? 'on' : ''}`} onClick={() => setSetting('newsMarket', m)} title={NEWS_MARKETS[m]?.label}>{m}</button>)}</div>
        <button className="icon-btn" onClick={() => reload(true)} title="Refresh"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
      </div>
      {error && <div className="ec-warn">{error}</div>}
      <div className="nw-grid">
        <div className="card nw-list">
          {loading && !data ? <div className="ec-empty">Loading the news…</div> : !top.length ? (
            <div className="ec-empty">{items.length ? 'No lines in this view.' : 'No headlines yet. The journal checks its news feeds every minute or two — the first ones arrive shortly after it starts.'}</div>
          ) : top.map((x) => <Line key={x.id} x={x} kids={kids[x.id] || []} market={market} cfg={cfg} onSimilar={setSimilar} byId={byId} />)}
        </div>
        <div className="nw-side">
          <div className="card card-pad">
            <div className="nw-side-h">Stories · 24h</div>
            {story && <button className="chip sm on" onClick={() => setStory(null)} style={{ marginBottom: 8 }}>Showing one story ✕</button>}
            {!stories.length && <div className="muted" style={{ fontSize: 13 }}>None yet.</div>}
            {stories.map((st) => (
              <button key={st.key} className={`nw-st ${story === st.key ? 'on' : ''}`} onClick={() => setStory(story === st.key ? null : st.key)}>
                <span className="grow"><b>{st.title}</b><small>{st.n} line{st.n === 1 ? '' : 's'} · {ago(st.last)}</small></span>
                {st.driver && <span className={`nw-tone ${sideOf({ impacts: { [market]: (DRIVERS[st.driver]?.fx[NEWS_MARKETS[market]?.cls]) || 0 } }, market)}`}>{st.tone}</span>}
              </button>
            ))}
          </div>
          <div className="card card-pad nw-help muted">
            Tap a <b>coloured word</b> to see how that kind of news usually moves {NEWS_MARKETS[market]?.short} — <span className="pos">green</span> helps it, <span className="neg">red</span> hurts it. The move after each line is measured from your platform’s prices (or Yahoo’s).
            {cfg?.ai && !cfg.ai.on && <> Lines are read by built-in rules; switch on AI on the <a href="#/macro/agents">News Agents</a> page for a smarter read.</>}
          </div>
        </div>
      </div>
      {similar && <Similar item={similar} market={market} onClose={() => setSimilar(null)} />}
    </div>
  );
}
