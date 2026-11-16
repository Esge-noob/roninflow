// Chart indicators for the full-screen chart: each takes bars ({ time, open, high, low, close, volume }, oldest
// first) and returns points ({ time, value }) — fewer at the start where there isn't enough history yet.

export function sma(bars, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= n) sum -= bars[i - n].close;
    if (i >= n - 1) out.push({ time: bars[i].time, value: sum / n });
  }
  return out;
}

export function ema(bars, n, pick = (b) => b.close) {
  const out = [];
  const k = 2 / (n + 1);
  let prev = null;
  let seed = 0;
  for (let i = 0; i < bars.length; i++) {
    const v = pick(bars[i]);
    if (prev === null) {
      seed += v;
      if (i === n - 1) { prev = seed / n; out.push({ time: bars[i].time, value: prev }); }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out.push({ time: bars[i].time, value: prev });
  }
  return out;
}

/** Volume-weighted average price, restarting each session (`sessionOf(bar)` → a key that changes at the open). */
export function vwap(bars, sessionOf) {
  const out = [];
  let pv = 0, vol = 0, key = null;
  for (const b of bars) {
    const k = sessionOf(b);
    if (k !== key) { key = k; pv = 0; vol = 0; }
    const typical = (b.high + b.low + b.close) / 3;
    const v = b.volume || 0;
    pv += typical * v; vol += v;
    out.push({ time: b.time, value: vol ? pv / vol : typical });
  }
  return out;
}

export function bollinger(bars, n = 20, mult = 2) {
  const mid = [], upper = [], lower = [];
  for (let i = n - 1; i < bars.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += bars[j].close;
    const m = s / n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (bars[j].close - m) ** 2;
    const sd = Math.sqrt(v / n);
    const time = bars[i].time;
    mid.push({ time, value: m }); upper.push({ time, value: m + mult * sd }); lower.push({ time, value: m - mult * sd });
  }
  return { mid, upper, lower };
}

/** Wilder's RSI. */
export function rsi(bars, n = 14) {
  const out = [];
  let gain = 0, loss = 0;
  for (let i = 1; i < bars.length; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    const g = Math.max(0, ch), l = Math.max(0, -ch);
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) { gain /= n; loss /= n; out.push({ time: bars[i].time, value: loss === 0 ? 100 : 100 - 100 / (1 + gain / loss) }); }
      continue;
    }
    gain = (gain * (n - 1) + g) / n;
    loss = (loss * (n - 1) + l) / n;
    out.push({ time: bars[i].time, value: loss === 0 ? 100 : 100 - 100 / (1 + gain / loss) });
  }
  return out;
}

export function macd(bars, fast = 12, slow = 26, signal = 9) {
  const f = new Map(ema(bars, fast).map((p) => [p.time, p.value]));
  const line = ema(bars, slow).map((p) => ({ time: p.time, value: f.get(p.time) - p.value }));
  const sig = ema(line.map((p) => ({ time: p.time, close: p.value })), signal);
  const s = new Map(sig.map((p) => [p.time, p.value]));
  const hist = line.filter((p) => s.has(p.time)).map((p) => ({ time: p.time, value: p.value - s.get(p.time) }));
  return { line, signal: sig, hist };
}
