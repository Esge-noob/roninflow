// Macro → Heat Map: every macro driver for one market on one screen — the stories in the news, the Fed, the data,
// rates and the dollar, linked markets — green where it helps the market, red where it hurts, and whether price has
// joined the news yet. Tap a tile for the headlines behind it.
import { useState } from 'react';
import { RefreshCw, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import MacroSwitch from '../components/MacroSwitch';
import { Modal, ModalHead } from '../components/ui';
import { useStore } from '../store/store';
import { useMacro } from '../lib/macro';
import { NEWS_MARKETS, DRIVERS } from '../lib/newsRules';
import { Chain, ago, timeOf, sideOf } from '../components/NewsBits';

const GROUPS = ['Stories', 'Fed', 'Data', 'Rates and USD', 'Linked markets'];
const bg = (v) => {
  const a = Math.min(0.55, 0.1 + Math.abs(v) * 0.45);
  return v > 0.05 ? `color-mix(in srgb, var(--pos) ${Math.round(a * 100)}%, var(--card))` : v < -0.05 ? `color-mix(in srgb, var(--neg) ${Math.round(a * 100)}%, var(--card))` : 'var(--card-3)';
};

export default function NewsHeatmap() {
  const { state, setSetting } = useStore();
  const s = state.settings;
  const [open, setOpen] = useState(null);
  const pick = s.newsMarket || '';
  const { data, error, loading, reload } = useMacro(`/api/macro/news/heatmap?market=${pick}`, { poll: 60e3 });
  const market = data?.market || pick || 'ES';
  const m = NEWS_MARKETS[market];
  const tiles = data?.tiles || [];
  const bias = data?.bias || 0;
  const verdict = bias > 0.12 ? 'helps' : bias < -0.12 ? 'hurts' : 'mixed';

  return (
    <div className="page hm-page">
      <div className="row gap12 wrap" style={{ alignItems: 'flex-end', marginBottom: 14 }}>
        <div className="grow">
          <MacroSwitch current="heatmap" />
          <div className="muted" style={{ fontSize: 13.5 }}>Every macro driver on one screen, so you see the mood flip the moment news hits.</div>
        </div>
      </div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <div className="row gap6 wrap">{(data?.markets || []).map((k) => <button key={k} className={`chip ${market === k ? 'on' : ''}`} onClick={() => setSetting('newsMarket', k)}>{k} <span className="muted">{NEWS_MARKETS[k]?.short}</span></button>)}</div>
        <div className="grow" />
        <button className="icon-btn" onClick={() => reload(true)} title="Refresh"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
      </div>
      {error && <div className="ec-warn">{error}</div>}
      {loading && !data ? <div className="ec-empty">Loading…</div> : !data ? null : (
        <>
          <div className={`hm-banner ${verdict}`}>
            <span className="hm-v">{verdict === 'helps' ? '▲' : verdict === 'hurts' ? '▼' : '•'} News {verdict === 'mixed' ? 'is mixed for' : verdict} {m?.label}</span>
            {data.trend && (
              <span className="hm-trend">
                {data.trend.slice().reverse().map((t) => <span key={t.tf} className={`hm-tf ${t.dir > 0 ? 'pos' : t.dir < 0 ? 'neg' : ''}`}>{t.dir > 0 ? <TrendingUp size={14} /> : t.dir < 0 ? <TrendingDown size={14} /> : <Minus size={14} />} {t.tf}</span>)}
                {verdict !== 'mixed' && <span className="muted">· {data.agree} of 3 agree{data.agree === 0 ? ' — price hasn’t joined the news' : data.agree === 3 ? ' — price is with the news' : ''}</span>}
              </span>
            )}
          </div>
          {!tiles.length && <div className="ec-empty">Nothing in the news for {m?.short} yet today.</div>}
          <div className="hm-groups">
            {GROUPS.map((g) => {
              const list = tiles.filter((t) => t.group === g);
              if (!list.length) return null;
              return (
                <div key={g} className="hm-group">
                  <div className="hm-gh">{g}</div>
                  <div className="hm-tiles">
                    {list.map((t, i) => (
                      <button key={i} className="hm-tile" style={{ background: bg(t.v) }} onClick={() => setOpen(t)} disabled={!t.ids?.length && !t.sub}>
                        <span className="hm-age">{ago(t.t)}</span>
                        <b>{t.title}</b>
                        <small>{t.sub}</small>
                        <span className={`hm-eff ${t.v > 0.05 ? 'pos' : t.v < -0.05 ? 'neg' : 'muted'}`}>{t.v > 0.05 ? `▲ Helps ${m.short}` : t.v < -0.05 ? `▼ Hurts ${m.short}` : 'Little effect'}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {open && (
        <Modal open onClose={() => setOpen(null)} width={600}>
          <ModalHead title={open.title} sub={`${open.group} · ${ago(open.t)} · ${open.v > 0.05 ? `helps ${m.short}` : open.v < -0.05 ? `hurts ${m.short}` : 'little effect'}`} onClose={() => setOpen(null)} />
          <div className="hm-detail">
            {open.sub && <div className="muted" style={{ marginBottom: 10 }}>{open.sub}</div>}
            {(open.ids || []).map((id) => data.items?.[id]).filter(Boolean).map((x) => (
              <div key={x.id} className="hm-line">
                <div className="row gap8"><span className="nw-t">{timeOf(x.t)}</span><span className="grow">{x.title}</span>{x.driver && <span className={`nw-tone ${sideOf(x, market)}`}>{DRIVERS[x.driver].label}</span>}</div>
                {x.driver && <Chain driver={x.driver} market={market} />}
              </div>
            ))}
            {!open.ids?.length && <div className="muted" style={{ fontSize: 13 }}>From the market’s own prices (Yahoo’s free quotes).</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}
