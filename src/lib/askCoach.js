// "Ask coach about this chart" + automatic background screenshot collection for Coach Reviews and Coach Chat.
import { navigate } from '../store/store';
import { imageUrl } from './imageStore';
import { fmtDate, fmtMoney, fmtTime12, keyOf, sortByEntry, toDate } from './stats';

let pending = null;
/** The Coach page picks this up once when it opens. */
export const takePendingAsk = () => { const p = pending; pending = null; return p; };

/** Any image src (data:, blob:, /api/data/images/…) → a JPEG/PNG data URL no larger than `max` px on its long side. */
export async function imageToDataUrl(src, max = 1800, quality = 0.9) {
  const blob = await (await fetch(src)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (scale === 1 && blob.size < 3.5e6 && /^image\/(png|jpeg|webp)$/.test(blob.type) && quality >= 0.9) {
    bmp.close?.();
    return await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', quality);
}

/** Open the Trading Coach with this image attached and a question ready to edit. focus = detailed data for follow-ups. */
export async function askCoachAboutImage({ src, text, focus = null, title = null, strategyId = null }) {
  const image = await imageToDataUrl(src);
  pending = { image, text, focus, title, strategyId, at: Date.now() };
  navigate('coach?ask=1');
}

function diaryDatesFor(state, trades, { date, period } = {}) {
  const diary = state.diary || {};
  if (date) return diary[date]?.images?.length ? [date] : [];
  if (period?.from && period?.to) {
    return Object.keys(diary)
      .filter((k) => k >= period.from && k <= period.to && diary[k]?.images?.length)
      .sort((a, b) => b.localeCompare(a));
  }
  const set = new Set();
  for (const t of trades) {
    const k = keyOf(toDate(String(t.entry)));
    if (diary[k]?.images?.length) set.add(k);
  }
  return [...set].sort((a, b) => b.localeCompare(a));
}

/** Fast synchronous count of trade + diary screenshots available in a scope/period. */
export function countPeriodImages(state, trades = [], { date, period } = {}) {
  let tradeShots = 0;
  for (const t of trades) tradeShots += (t.screenshots || []).length;
  let diaryShots = 0;
  for (const d of diaryDatesFor(state, trades, { date, period })) {
    diaryShots += (state.diary?.[d]?.images || []).length;
  }
  return { total: tradeShots + diaryShots, tradeShots, diaryShots };
}

/**
 * Automatically gather and resize screenshots already attached to trades and diary days in the period,
 * plus optional strategy reference screenshots for visual comparison.
 */
export async function collectPeriodImages(
  state,
  trades = [],
  { date = null, period = null, strategyId = null, maxImages = 10, maxPx = 1150, quality = 0.82, includeStrategyRefs = true } = {},
) {
  const stratById = new Map((state.strategies || []).map((s) => [s.id, s]));
  const asc = sortByEntry(trades, 'asc');
  const tradeCands = [];
  for (const t of asc) {
    const shots = t.screenshots || [];
    if (!shots.length) continue;
    const stName = t.strategyId ? stratById.get(t.strategyId)?.name : null;
    shots.forEach((src, i) => {
      const idxTag = shots.length > 1 ? ` (screenshot ${i + 1}/${shots.length})` : '';
      const label = `Trade chart: ${fmtDate(t.entry)} ${fmtTime12(t.entry)} · ${t.symbol} ${t.direction} (${fmtMoney(t.pnl, { sign: true })}${stName ? `, Strategy: ${stName}` : ''})${idxTag}`;
      tradeCands.push({ kind: 'trade', src, label, time: String(t.entry), pnl: Number(t.pnl) || 0, tradeId: t.id });
    });
  }

  const diaryDates = diaryDatesFor(state, trades, { date, period });
  const diaryCands = [];
  for (const d of diaryDates) {
    const imgs = state.diary?.[d]?.images || [];
    imgs.forEach((im, i) => {
      const cap = (im.caption || im.name || `chart ${i + 1}`).trim();
      diaryCands.push({ kind: 'diary', id: im.id, label: `Diary chart: ${fmtDate(d)} · ${cap}`, time: `${d}T23:59:59` });
    });
  }

  const totalAvailable = tradeCands.length + diaryCands.length;
  let picked = [];

  if (totalAvailable <= maxImages) {
    picked = [...tradeCands, ...diaryCands];
  } else {
    // Reserve a couple of slots for diary charts if both exist, then pick a balanced set of trades
    // (biggest losses + biggest wins + most recent) so the Coach sees both leaks and recent executions.
    const diaryCap = diaryCands.length ? Math.min(diaryCands.length, tradeCands.length ? Math.max(2, Math.floor(maxImages * 0.25)) : maxImages) : 0;
    const tradeCap = maxImages - diaryCap;

    const chosenTrades = [];
    const seen = new Set();
    const take = (c) => {
      if (!c || seen.has(c) || chosenTrades.length >= tradeCap) return;
      seen.add(c);
      chosenTrades.push(c);
    };
    if (tradeCands.length <= tradeCap) {
      tradeCands.forEach(take);
    } else {
      // 2 worst losses, 2 biggest wins, then most recent trades
      [...tradeCands].filter((c) => c.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 2).forEach(take);
      [...tradeCands].filter((c) => c.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 2).forEach(take);
      [...tradeCands].reverse().forEach(take);
    }
    const chosenDiary = diaryCands.slice(0, diaryCap);
    picked = [...chosenTrades, ...chosenDiary];
  }

  // Chronological order makes multi-trade / multi-day reviews much easier for the AI to follow.
  picked.sort((a, b) => a.time.localeCompare(b.time));

  const resolved = await Promise.all(
    picked.map(async (item) => {
      try {
        const src = item.kind === 'diary' ? await imageUrl(item.id) : item.src;
        if (!src) return null;
        const dataUrl = await imageToDataUrl(src, maxPx, quality);
        return { dataUrl, label: item.label };
      } catch {
        return null;
      }
    }),
  );
  const images = resolved.filter(Boolean);
  const includedPeriod = images.length;

  // Optionally attach strategy reference screenshots when we loaded at least one chart (or explicit strategy selected)
  let includedRefs = 0;
  if (includeStrategyRefs && images.length > 0) {
    const stratIds = strategyId
      ? [strategyId]
      : [...new Set(asc.map((t) => t.strategyId).filter((id) => id && stratById.get(id)?.media?.length))].slice(0, 2);
    const refCap = strategyId ? 3 : 2;
    const refQueue = [];
    for (const sid of stratIds) {
      const st = stratById.get(sid);
      if (!st?.media?.length) continue;
      st.media.slice(0, strategyId ? 3 : 1).forEach((src, idx) => {
        if (refQueue.length < refCap) refQueue.push({ src, label: `Strategy reference example ${idx + 1} for "${st.name}"` });
      });
    }
    const refResolved = await Promise.all(
      refQueue.map(async (r) => {
        try {
          const dataUrl = await imageToDataUrl(r.src, maxPx, quality);
          return { dataUrl, label: r.label };
        } catch {
          return null;
        }
      }),
    );
    for (const r of refResolved.filter(Boolean)) {
      images.push(r);
      includedRefs++;
    }
  }

  return {
    images,
    totalAvailable,
    included: includedPeriod,
    includedRefs,
    truncated: totalAvailable > includedPeriod,
  };
}
