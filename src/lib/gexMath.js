// GEX math shared by the journal's server (gex.js) and the browser (the demo's sample data).
// Dealers are assumed long the calls customers sell and short the puts customers buy: call gamma +, put gamma −.
export const YEAR_MS = 365 * 864e5;
const MIN_T = 15 * 60e3 / YEAR_MS; // an option expiring now is treated as 15 minutes from expiry
export const nyDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// ---------- option math (Black-Scholes, no rates or dividends: what matters here is the shape by strike) ----------
const SQ2PI = Math.sqrt(2 * Math.PI);
const pdf = (x) => Math.exp(-x * x / 2) / SQ2PI;
const cdf = (x) => { // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
};
/** Per-share Greeks: gamma (per 1 point), vanna (delta per 1.00 of IV), charm (delta per year), delta. */
export function bsGreeks(S, K, T, iv, type) {
  if (!(S > 0 && K > 0 && iv > 0)) return null;
  T = Math.max(T, MIN_T);
  const v = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + iv * iv * T / 2) / v, d2 = d1 - v;
  const n = pdf(d1);
  return { gamma: n / (S * v), vanna: -n * d2 / iv, charm: n * d2 / (2 * T), delta: type === 'C' ? cdf(d1) : cdf(d1) - 1 };
}

/** OCC-style symbol (SPXW261118C06050000) → { root, exp, type, strike } */
export function parseOcc(sym) {
  const m = /^([A-Z.]+?)(\d{6})([CP])(\d{8})$/.exec(String(sym || '').replace(/^O:/, '').replace(/\s+/g, ''));
  if (!m) return null;
  return { root: m[1], exp: `20${m[2].slice(0, 2)}-${m[2].slice(2, 4)}-${m[2].slice(4, 6)}`, type: m[3], strike: Number(m[4]) / 1000 };
}

/** When an expiration's options stop trading: 4:00 PM New York time that day (as epoch ms). */
const expCache = new Map();
export function expiryMs(exp) {
  if (expCache.has(exp)) return expCache.get(exp);
  const v = expiryMsRaw(exp);
  if (expCache.size > 5000) expCache.clear();
  expCache.set(exp, v);
  return v;
}
function expiryMsRaw(exp) {
  const noonUtc = Date.parse(`${exp}T12:00:00Z`);
  const ny = new Date(noonUtc).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit' });
  const offH = 12 - Number(ny); // 4 (EDT) or 5 (EST)
  return Date.parse(`${exp}T16:00:00Z`) + offH * 3600e3;
}

// ---------- the numbers ----------
/**
 * rows: [{ exp, type 'C'|'P', strike, oi, gamma?, iv?, mult? }] (gamma per share per point; worked out from iv if missing)
 * → GEX in dollars per 1% move, by strike; walls; the aggregate profile and where it crosses zero (the gamma flip).
 */
export function computeGex(rows, { spot, now = Date.now(), exps = null, range = 0.06 } = {}) {
  const use = rows.filter((r) => r.oi > 0 && r.strike > 0 && (!exps || exps.includes(r.exp)) && expiryMs(r.exp) > now - 3600e3);
  const by = new Map();
  let total = 0;
  for (const r of use) {
    const T = (expiryMs(r.exp) - now) / YEAR_MS;
    const g = r.gamma > 0 ? r.gamma : bsGreeks(spot, r.strike, T, r.iv, r.type)?.gamma || 0;
    const gex = g * r.oi * (r.mult || 100) * spot * spot * 0.01 * (r.type === 'C' ? 1 : -1);
    const s = by.get(r.strike) || { strike: r.strike, call: 0, put: 0, callOi: 0, putOi: 0 };
    if (r.type === 'C') { s.call += gex; s.callOi += r.oi; } else { s.put += gex; s.putOi += r.oi; }
    by.set(r.strike, s);
    total += gex;
  }
  const strikes = [...by.values()].sort((a, b) => a.strike - b.strike);
  let cum = 0;
  for (const s of strikes) { s.net = s.call + s.put; cum += s.net; s.cum = cum; }
  const near = strikes.filter((s) => Math.abs(s.strike / spot - 1) <= range * 2);
  const pick = (list, f) => list.reduce((a, s) => (a == null || f(s) > f(a) ? s : a), null);
  const callWall = pick(near, (s) => s.call)?.strike ?? null;
  const putWall = pick(near, (s) => -s.put)?.strike ?? null;
  // aggregate profile: total GEX recomputed as if price were each level (Greeks from each option's IV)
  const profile = [];
  const withIv = use.filter((r) => r.iv > 0);
  const steps = 80, lo = spot * (1 - range), hi = spot * (1 + range);
  if (withIv.length) {
    for (let i = 0; i <= steps; i++) {
      const S = lo + (hi - lo) * i / steps;
      let g = 0;
      for (const r of withIv) {
        const bs = bsGreeks(S, r.strike, (expiryMs(r.exp) - now) / YEAR_MS, r.iv, r.type);
        if (bs) g += bs.gamma * r.oi * (r.mult || 100) * S * S * 0.01 * (r.type === 'C' ? 1 : -1);
      }
      profile.push({ price: S, gex: g });
    }
  }
  // the zero crossing nearest the price
  let flip = null;
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1], b = profile[i];
    if ((a.gex <= 0 && b.gex > 0) || (a.gex >= 0 && b.gex < 0)) {
      const x = a.price + (b.price - a.price) * (0 - a.gex) / (b.gex - a.gex);
      if (flip == null || Math.abs(x - spot) < Math.abs(flip - spot)) flip = x;
    }
  }
  const atSpot = profile.length ? profile.reduce((a, p) => (Math.abs(p.price - spot) < Math.abs(a.price - spot) ? p : a)).gex : total;
  return { strikes, total, callWall, putWall, flip, profile, zone: atSpot >= 0 ? 'positive' : 'negative', contracts: use.length };
}

/** Dealer vanna and charm by strike for options dte in [minDte, maxDte]. Vanna: $ delta per vol point; charm: $ delta per day. */
export function computeVannaCharm(rows, { spot, now = Date.now(), minDte = 0, maxDte = 45, range = 0.15 } = {}) {
  const by = new Map();
  for (const r of rows) {
    if (!(r.oi > 0 && r.iv > 0) || Math.abs(r.strike / spot - 1) > range) continue;
    const ms = expiryMs(r.exp) - now, dte = ms / 864e5;
    if (ms < -3600e3 || dte < minDte || dte > maxDte + 1) continue;
    const g = bsGreeks(spot, r.strike, ms / YEAR_MS, r.iv, r.type);
    if (!g) continue;
    const sign = r.type === 'C' ? 1 : -1, n = r.oi * (r.mult || 100);
    const s = by.get(r.strike) || { strike: r.strike, vanna: 0, charm: 0 };
    s.vanna += sign * g.vanna * n * spot * 0.01; // per 1 vol point
    s.charm += sign * g.charm * n * spot / 365; // per day
    by.set(r.strike, s);
  }
  const strikes = [...by.values()].sort((a, b) => a.strike - b.strike);
  const sum = (k) => strikes.reduce((a, s) => a + s[k], 0);
  const top = (k, dir) => strikes.reduce((a, s) => (a == null || dir * s[k] > dir * a[k] ? s : a), null)?.strike ?? null;
  // where cumulative vanna (from the lowest strike up) changes sign nearest the price
  let cum = 0, prev = null, vannaFlip = null;
  for (const s of strikes) {
    cum += s.vanna;
    if (prev != null && Math.sign(prev) !== Math.sign(cum) && (vannaFlip == null || Math.abs(s.strike - spot) < Math.abs(vannaFlip - spot))) vannaFlip = s.strike;
    prev = cum;
  }
  const above = strikes.filter((s) => s.strike > spot).reduce((a, s) => a + Math.abs(s.vanna), 0);
  const below = strikes.filter((s) => s.strike <= spot).reduce((a, s) => a + Math.abs(s.vanna), 0);
  return {
    strikes, vanna: sum('vanna'), charm: sum('charm'), vannaFlip,
    maxVanna: top('vanna', 1), minVanna: top('vanna', -1), maxCharm: top('charm', 1), minCharm: top('charm', -1),
    upDown: below ? above / below : null, minDte, maxDte,
  };
}

