// Runs the backtest engine in a background thread (a Web Worker made from the engine's own source), so long sweeps
// never freeze the page. Falls back to the page itself if workers aren't available.
import { makeEngine } from './autobt';

let worker = null;
let local = null;
let seq = 0;
let loadedKey = null;
const waiting = new Map();

function boot() {
  if (worker || local) return;
  try {
    const src = `const E = (${makeEngine.toString()})();
let D = null;
onmessage = (e) => {
  const { id, method, args } = e.data;
  try {
    if (method === 'load') { D = args[0]; postMessage({ id, result: { n: D.t.length } }); return; }
    if (!D) throw new Error('No price data loaded');
    const progress = (p) => postMessage({ id, progress: p });
    let result;
    if (method === 'analyze') result = E.analyze(D, ...args);
    else if (method === 'sweep') result = E.sweep(D, args[0], args[1], args[2], args[3], { ...(args[4] || {}), onProgress: progress });
    else if (method === 'walkForward') result = E.walkForward(D, args[0], args[1], args[2], args[3], { ...(args[4] || {}), onProgress: progress });
    else if (method === 'run') result = E.run(D, ...args);
    else throw new Error('Unknown method ' + method);
    postMessage({ id, result });
  } catch (err) { postMessage({ id, error: err && err.message ? err.message : String(err) }); }
};`;
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = (e) => {
      const { id, result, error, progress } = e.data;
      const w = waiting.get(id);
      if (!w) return;
      if (progress !== undefined) { w.onProgress?.(progress); return; }
      waiting.delete(id);
      if (error) w.reject(new Error(error)); else w.resolve(result);
    };
    worker.onerror = (e) => { for (const w of waiting.values()) w.reject(new Error(e.message || 'Backtest worker failed')); waiting.clear(); };
  } catch {
    worker = null;
    local = { E: makeEngine(), D: null };
  }
}

function call(method, args, onProgress) {
  boot();
  if (local) {
    return new Promise((resolve, reject) => setTimeout(() => {
      try {
        if (method === 'load') { local.D = args[0]; resolve({ n: args[0].t.length }); return; }
        const E = local.E, D = local.D;
        if (method === 'analyze') resolve(E.analyze(D, ...args));
        else if (method === 'sweep') resolve(E.sweep(D, args[0], args[1], args[2], args[3], { ...(args[4] || {}), onProgress }));
        else if (method === 'walkForward') resolve(E.walkForward(D, args[0], args[1], args[2], args[3], { ...(args[4] || {}), onProgress }));
        else resolve(E.run(D, ...args));
      } catch (e) { reject(e); }
    }, 0));
  }
  const id = ++seq;
  return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject, onProgress }); worker.postMessage({ id, method, args }); });
}

/** Load a price series into the engine (once per series). */
export async function loadSeries(key, data) {
  if (loadedKey === key) return;
  await call('load', [data]);
  loadedKey = key;
}
export const engine = {
  analyze: (spec, P, opts) => call('analyze', [spec, P, opts]),
  sweep: (spec, base, grid, range, opts, onProgress) => call('sweep', [spec, base, grid, range, opts], onProgress),
  walkForward: (spec, base, grid, range, opts, onProgress) => call('walkForward', [spec, base, grid, range, opts], onProgress),
};
/** Stop whatever is running (a runaway code strategy, a huge sweep). The next call starts a fresh worker. */
export function stopEngine() {
  if (worker) { worker.terminate(); worker = null; }
  loadedKey = null;
  for (const w of waiting.values()) w.reject(new Error('Stopped'));
  waiting.clear();
}
