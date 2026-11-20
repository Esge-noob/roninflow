import { useState } from 'react';
import { Check, Eye, EyeOff, RefreshCw, TriangleExclamationPoint as TriangleAlert, ExternalLink, Cpu, Cloud, Sparkles, Zap, Bot, Server, Plus, Trash, Minus, Square } from 'lucide-react';
import { Modal, ModalHead, Switch } from './ui';
import { PROVIDERS, providerConfig, testConnection, THINKING, VAULT, vaultKeys } from '../lib/ai';
import { describeColor, parseColorCode } from '../lib/coach';
import { uid } from '../lib/stats';

const ICONS = { local: Cpu, anthropic: Sparkles, openai: Zap, google: Bot, ollama: Server, ollamaCloud: Cloud };

const DEFAULT_LINE_COLORS = ['#f5c542', '#38bdf8', '#ef4444', '#2bc48a', '#a855f7', '#f97316', '#ffffff'];
const DEFAULT_ZONE_COLORS = ['#2bc48a', '#ef4444', '#38bdf8', '#f5c542', '#a855f7'];
const LINE_STYLES = [
  { value: 'solid', label: 'Solid line' },
  { value: 'dotted', label: 'Dotted line' },
  { value: 'dashed', label: 'Dashed line' },
];

function LegendPreview({ item }) {
  const color = item.color || '#f5c542';
  if (item.kind === 'zone') {
    return (
      <div className="cl-preview" title="Zone preview">
        <span className="cl-zone" style={{ background: `color-mix(in srgb, ${color} 28%, transparent)`, borderColor: color }} />
      </div>
    );
  }
  const style = item.lineStyle === 'dotted' ? 'dotted' : item.lineStyle === 'dashed' ? 'dashed' : 'solid';
  return (
    <div className="cl-preview" title={`${style} line preview`}>
      <span className="cl-line" style={{ borderTopStyle: style, borderTopColor: color }} />
    </div>
  );
}

function ColorCodeInput({ value, onChange }) {
  const hex = parseColorCode(value) || '#f5c542';
  const [draft, setDraft] = useState(hex.toUpperCase());
  const [focused, setFocused] = useState(false);
  const shown = focused ? draft : hex.toUpperCase();

  return (
    <div className="cl-color">
      <input
        type="color"
        value={hex}
        title="Pick color"
        aria-label="Pick color"
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next.toUpperCase());
          onChange(next);
        }}
      />
      <input
        type="text"
        className="cl-hex-input"
        value={shown}
        spellCheck={false}
        placeholder="#RRGGBB"
        aria-label="Color code"
        title="Type or paste a color code (#RRGGBB, #AARRGGBB like #FF00FF00, #RGB, or rgb())"
        onFocus={(e) => {
          setFocused(true);
          setDraft(hex.toUpperCase());
          e.target.select();
        }}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const parsed = parseColorCode(raw);
          if (parsed) onChange(parsed);
        }}
        onBlur={() => {
          const parsed = parseColorCode(draft);
          if (parsed) onChange(parsed);
          setDraft((parsed || hex).toUpperCase());
          setFocused(false);
        }}
      />
    </div>
  );
}

export default function CoachSettings({ open, initialTab = 'ai', onClose, coach, save, name: initialName }) {
  const [c, setC] = useState(coach);
  const [name, setName] = useState(initialName);
  const [sel, setSel] = useState(coach.provider || 'local');
  const [tab, setTab] = useState(initialTab);
  const [show, setShow] = useState(false);
  const [models, setModels] = useState({});
  const [test, setTest] = useState({});
  const [busy, setBusy] = useState(false);
  const [was, setWas] = useState(open);
  if (open !== was) {
    setWas(open);
    if (open) {
      setC({ providers: {}, chartLegend: [], chartNotes: '', includeStrategyMedia: true, ...coach });
      setName(initialName);
      setSel(coach.provider || 'local');
      setTab(initialTab || 'ai');
      setTest({});
      setShow(false);
    }
  }

  const P = PROVIDERS[sel];
  const cfg = providerConfig(c, sel);
  const setP = (patch) => setC((x) => ({ ...x, providers: { ...(x.providers || {}), [sel]: { ...(x.providers?.[sel] || {}), ...patch } } }));
  const legend = c.chartLegend || [];
  const addLegend = (kind) => {
    const palette = kind === 'zone' ? DEFAULT_ZONE_COLORS : DEFAULT_LINE_COLORS;
    const color = palette[legend.filter((x) => x.kind === kind).length % palette.length];
    const item = {
      id: uid('cl'),
      kind,
      lineStyle: 'solid',
      color,
      colorName: describeColor(color),
      label: '',
      meaning: '',
    };
    setC((x) => ({ ...x, chartLegend: [...(x.chartLegend || []), item] }));
  };
  const updLegend = (id, patch) => setC((x) => ({
    ...x,
    chartLegend: (x.chartLegend || []).map((item) => (item.id === id ? { ...item, ...patch } : item)),
  }));
  const delLegend = (id) => setC((x) => ({
    ...x,
    chartLegend: (x.chartLegend || []).filter((item) => item.id !== id),
  }));

  const run = async () => {
    setBusy(true);
    setTest((t) => ({ ...t, [sel]: { pending: true } }));
    try {
      const r = await testConnection(sel, cfg);
      setModels((m) => ({ ...m, [sel]: r.models }));
      setTest((t) => ({ ...t, [sel]: { ok: true, ...r } }));
      if (!cfg.model && r.models[0]) setP({ model: r.models[0] });
    } catch (e) {
      setTest((t) => ({ ...t, [sel]: { ok: false, error: e.message } }));
    }
    setBusy(false);
  };
  const tr = test[sel];
  const list = models[sel] || [];
  const activeLegendCount = legend.filter((x) => (x.label || x.meaning || '').trim()).length;

  return (
    <Modal open={open} onClose={onClose} width={920}>
      <ModalHead title="Customization Settings" sub="Configure your AI provider, coaching style, and how the Coach reads your chart lines and zones" onClose={onClose} />
      <div className="row gap6 wrap" style={{ padding: '4px 24px 0' }}>
        <button type="button" className={`chip ${tab === 'ai' ? 'on' : ''}`} style={{ padding: '6px 13px' }} onClick={() => setTab('ai')}>AI & Behavior</button>
        <button type="button" className={`chip ${tab === 'legend' ? 'on' : ''}`} style={{ padding: '6px 13px' }} onClick={() => setTab('legend')}>
          Chart Legend{activeLegendCount > 0 ? ` (${activeLegendCount})` : ''}
        </button>
      </div>

      <div className="modal-body col gap16">
        {tab === 'ai' ? (
          <>
            <div>
              <div className="label">AI provider</div>
              <div className="prov-grid">
                {Object.entries(PROVIDERS).map(([id, p]) => {
                  const Icon = ICONS[id];
                  const configured = !!c.providers?.[id]?.apiKey;
                  return (
                    <button key={id} className={`prov ${sel === id ? 'on' : ''}`} onClick={() => setSel(id)}>
                      <div className="row gap8"><Icon size={16} /><b>{p.label}</b></div>
                      <div className="row gap6" style={{ fontSize: 11.5, marginTop: 6 }}>
                        {c.provider === id ? <span className="badge pos" style={{ padding: '1px 6px' }}>Active</span>
                          : id === 'local' ? <span className="muted">Offline · free</span>
                            : id === 'ollama' ? <span className="muted">No key needed</span>
                              : configured ? <span className="muted">Key saved</span> : <span className="muted">Needs API key</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="panel col gap12" style={{ padding: 16 }}>
              <div className="row between">
                <div className="row gap8" style={{ fontWeight: 600 }}>{(() => { const I = ICONS[sel]; return <I size={16} />; })()} {P.label}</div>
                {sel !== 'local' && P.keyUrl && <a className="row gap6 muted" style={{ fontSize: 12.5 }} href={P.keyUrl} target="_blank" rel="noreferrer">{sel === 'ollama' ? 'Download Ollama' : 'Get an API key'} <ExternalLink size={12} /></a>}
              </div>
              <div className="muted" style={{ fontSize: 13 }}>{P.desc}</div>

              {sel !== 'local' && (
                <div className="form-grid">
                  {(P.needsKey || sel === 'openai') && (
                    <div className="field full">
                      <label className="label">API key{sel === 'openai' && ' (leave empty for local OpenAI-compatible servers)'}</label>
                      <div className="row gap8">
                        <input className="input" type={show ? 'text' : 'password'} autoComplete="off" placeholder={c.providers?.[sel]?.apiKey === VAULT ? 'Saved securely on the server — type to replace' : { anthropic: 'sk-ant-…', openai: 'sk-…', google: 'AIza…', ollamaCloud: 'ollama.com API key' }[sel]} value={c.providers?.[sel]?.apiKey === VAULT ? '' : c.providers?.[sel]?.apiKey || ''} onChange={(e) => setP({ apiKey: e.target.value.trim() || (c.providers?.[sel]?.apiKey === VAULT ? VAULT : '') })} />
                        <button className="btn" style={{ width: 40, padding: 0 }} onClick={() => setShow((s) => !s)} title={show ? 'Hide' : 'Show'}>{show ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                      </div>
                    </div>
                  )}
                  <div className="field">
                    <label className="label">{sel === 'ollama' ? 'Ollama address' : 'Base URL'}</label>
                    <input className="input" value={c.providers?.[sel]?.base ?? ''} placeholder={P.base} onChange={(e) => setP({ base: e.target.value.trim() })} />
                  </div>
                  <div className="field">
                    <label className="label">Model</label>
                    <div className="row gap8">
                      <input className="input" list={`models-${sel}`} placeholder={P.model} value={c.providers?.[sel]?.model ?? ''} onChange={(e) => setP({ model: e.target.value.trim() })} />
                      <datalist id={`models-${sel}`}>{list.map((m) => <option key={m} value={m} />)}</datalist>
                      {list.length > 0 && (
                        <select className="select" style={{ width: 44, padding: '0 0 0 8px', backgroundPosition: 'right 10px center' }} value="" onChange={(e) => e.target.value && setP({ model: e.target.value })} title="Pick from available models">
                          <option value="" />
                          {list.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {sel !== 'local' && (
                <div className="row gap12 wrap">
                  <button className="btn sm" onClick={run} disabled={busy || (P.needsKey && !c.providers?.[sel]?.apiKey)}>
                    <RefreshCw size={13} className={busy ? 'spin' : ''} /> Test connection & load models
                  </button>
                  {tr?.ok && <span className="badge pos-soft"><Check size={12} /> Connected · {tr.models.length} models · {tr.ms} ms</span>}
                  {tr?.ok && cfg.model && !tr.modelFound && <span className="badge neutral" style={{ whiteSpace: 'normal' }}>Model “{cfg.model}” not in the list — pick one from the menu</span>}
                  {tr && tr.ok === false && <span className="badge neg-soft" style={{ whiteSpace: 'normal', lineHeight: 1.45 }}><TriangleAlert size={12} /> {tr.error}</span>}
                </div>
              )}
              {sel === 'ollama' && (
                <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                  Install Ollama, then pull a model in a terminal, e.g. <code>ollama pull llama3.1</code> (or <code>qwen2.5</code>, <code>gemma3</code>; use a vision model such as <code>llava</code> for chart screenshots). Requests go from the journal's dev server straight to Ollama, so nothing leaves your computer. To reach Ollama on another machine, set the address (e.g. <code>http://192.168.1.20:11434</code>) and start Ollama there with <code>OLLAMA_HOST=0.0.0.0</code>.
                </div>
              )}
              {sel !== 'local' && sel !== 'ollama' && (
                <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                  Your key is stored only in this browser. When you ask a question, a summary of the selected account's trades, sessions, strategy rules and diary notes is sent to {P.label} along with your message.
                </div>
              )}

              <div className="row gap12">
                {c.provider === sel ? (
                  <span className="badge pos"><Check size={12} /> {P.label} is powering the Coach</span>
                ) : (
                  <button className="btn sm white" onClick={() => setC((x) => ({ ...x, provider: sel }))} disabled={P.needsKey && !c.providers?.[sel]?.apiKey}>Use {P.label}</button>
                )}
              </div>
            </div>

            {c.provider && c.provider !== 'local' && (
              <div className="field" style={{ marginBottom: 4 }}>
                <label className="label">Thinking</label>
                <div className="row gap8 wrap">
                  {THINKING.map((t) => (
                    <button key={t.value} className={`chip ${(c.thinking || 'standard') === t.value ? 'on' : ''}`} style={{ padding: '7px 14px' }} onClick={() => setC({ ...c, thinking: t.value })}>
                      {(c.thinking || 'standard') === t.value && <Check size={13} />} {t.label}
                    </button>
                  ))}
                </div>
                <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
                  {THINKING.find((t) => t.value === (c.thinking || 'standard')).desc} Uses the model's reasoning mode where it has one (Gemini 2.5/3, Claude, OpenAI o-series/GPT-5, Ollama thinking models like gpt-oss, qwen3, deepseek-r1); other models answer normally.
                </div>
              </div>
            )}
            <div className="form-grid">
              <div className="field"><label className="label">Your name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div className="field">
                <label className="label">Tone</label>
                <select className="select" value={c.tone} onChange={(e) => setC({ ...c, tone: e.target.value })}>
                  {['Direct', 'Encouraging', 'Analytical', 'Tough love'].map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div className="field"><label className="label">Request limit</label><input className="input" type="number" value={c.requestsLimit} onChange={(e) => setC({ ...c, requestsLimit: Number(e.target.value) || 0 })} /></div>
              <div className="field">
                <label className="label">Requests used</label>
                <div className="row gap8"><input className="input" readOnly value={c.requestsUsed} /><button className="btn" onClick={() => setC({ ...c, requestsUsed: 0 })}>Reset</button></div>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.55 }}>
              Teach the AI Coach what every colored line and shaded zone on your chart screenshots represents. This legend is automatically included when analyzing screenshots so the Coach reads your levels, zones, and indicators — not just candlesticks.
            </div>

            <div className="panel col gap10" style={{ padding: 14 }}>
              <div className="row between wrap gap12">
                <div className="col gap4">
                  <b style={{ fontWeight: 600, fontSize: 13.5 }}>Attach strategy reference screenshots</b>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    When analyzing a chart linked to a strategy (from a trade or Coach Context), automatically include up to 3 example screenshots from that Strategy so the Coach can compare your entry against your ideal setup.
                  </span>
                </div>
                <Switch on={c.includeStrategyMedia !== false} onChange={(v) => setC((x) => ({ ...x, includeStrategyMedia: v }))} />
              </div>
            </div>

            <div className="col gap10">
              <div className="row between wrap gap8">
                <div className="label" style={{ margin: 0 }}>Lines & zones</div>
                <div className="row gap8">
                  <button type="button" className="btn sm" onClick={() => addLegend('line')}><Minus size={14} /> Add line</button>
                  <button type="button" className="btn sm" onClick={() => addLegend('zone')}><Square size={13} /> Add zone</button>
                </div>
              </div>

              {legend.length === 0 ? (
                <div className="panel col gap8" style={{ padding: '22px 18px', alignItems: 'center', textAlign: 'center' }}>
                  <div style={{ fontWeight: 500, fontSize: 14 }}>No chart lines or zones defined yet</div>
                  <div className="muted" style={{ fontSize: 12.5, maxWidth: 460 }}>
                    Add your chart levels (e.g. Yellow dotted line = Overnight High/Low, Blue solid line = VWAP, Green zone = 5m Demand / FVG) so the Coach knows what to look for.
                  </div>
                  <div className="row gap8" style={{ marginTop: 4 }}>
                    <button type="button" className="btn sm white" onClick={() => addLegend('line')}><Plus size={14} /> Add line</button>
                    <button type="button" className="btn sm" onClick={() => addLegend('zone')}><Plus size={14} /> Add zone</button>
                  </div>
                </div>
              ) : (
                <div className="col gap8">
                  {legend.map((item) => {
                    const isZone = item.kind === 'zone';
                    return (
                      <div key={item.id} className="panel cl-row">
                        <div className="cl-top">
                          <LegendPreview item={item} />
                          <select
                            className="select cl-kind"
                            value={isZone ? 'zone' : 'line'}
                            onChange={(e) => updLegend(item.id, { kind: e.target.value })}
                            aria-label="Element type"
                          >
                            <option value="line">Line</option>
                            <option value="zone">Zone</option>
                          </select>
                          {!isZone ? (
                            <select
                              className="select cl-style"
                              value={item.lineStyle || 'solid'}
                              onChange={(e) => updLegend(item.id, { lineStyle: e.target.value })}
                              aria-label="Line style"
                            >
                              {LINE_STYLES.map((st) => <option key={st.value} value={st.value}>{st.label}</option>)}
                            </select>
                          ) : (
                            <div className="cl-style-tag muted">Shaded area</div>
                          )}
                          <ColorCodeInput
                            value={item.color || '#f5c542'}
                            onChange={(nextHex) => {
                              const prevAuto = describeColor(item.color);
                              const keepCustom = item.colorName && item.colorName !== prevAuto;
                              updLegend(item.id, { color: nextHex, ...(keepCustom ? {} : { colorName: describeColor(nextHex) }) });
                            }}
                          />
                          <input
                            className="input cl-cname"
                            value={item.colorName || ''}
                            onChange={(e) => updLegend(item.id, { colorName: e.target.value })}
                            placeholder="Color name (e.g. Yellow)"
                            title="Color label shown to the AI alongside the hex code"
                          />
                          <button type="button" className="icon-btn" title="Remove" onClick={() => delLegend(item.id)}><Trash size={14} /></button>
                        </div>
                        <div className="cl-bottom">
                          <input
                            className="input"
                            value={item.label || ''}
                            onChange={(e) => updLegend(item.id, { label: e.target.value })}
                            placeholder={isZone ? 'What this zone represents (e.g. 5m Fair Value Gap / Demand zone)' : 'What this line represents (e.g. VWAP, Previous Day High/Low, EMA 20)'}
                          />
                          <input
                            className="input"
                            value={item.meaning || ''}
                            onChange={(e) => updLegend(item.id, { meaning: e.target.value })}
                            placeholder="Optional: how you trade it (e.g. look for rejection or reclaim + retest)"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="field">
              <label className="label">General chart & execution markup notes <span className="muted">(optional)</span></label>
              <textarea
                className="textarea"
                style={{ minHeight: 72 }}
                value={c.chartNotes || ''}
                onChange={(e) => setC((x) => ({ ...x, chartNotes: e.target.value }))}
                placeholder="e.g. Green/red triangles mark my long/short entries, dashed white line connects entry to exit, right panel is volume profile, candles are 1m/5m..."
              />
            </div>
          </>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn white" onClick={async () => { save(await vaultKeys(c), name); onClose(); }}><Check size={15} /> Save</button>
      </div>
    </Modal>
  );
}
