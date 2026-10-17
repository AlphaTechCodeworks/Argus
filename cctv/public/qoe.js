// The experience score: one number, 0 to 1, for how well a viewer was served.
//
// Six parts, weighted as the owner set them (2026-10-08):
//   smoothness 35 %   pictures arriving at the camera's rate, evenly, without freezing
//   startup    25 %   how soon a camera that was opened showed a picture
//   scrubbing  15 %   how soon a seek in a recording showed its picture
//   switching  10 %   how soon a camera stepped to was there at full quality
//   stability  10 %   few reconnects, quality drops and decoder restarts
//   efficiency  5 %   the same job done with less of what is shared
//
// A session is scored only on what happened in it: one with no seek has no scrubbing part, and its
// 15 % is shared among the parts it does have rather than counted as nothing or as perfect. The
// score always says which parts it was made from (`from`), so two scores are compared like for like.
//
// Pure: no page, no clock. The browser scores as it plays (telemetry.js) and the server scores what it
// is sent (telemetry.mjs) with these same functions.

export const WEIGHTS = Object.freeze({ smoothness: 0.35, startup: 0.25, scrubbing: 0.15, switching: 0.1, stability: 0.1, efficiency: 0.05 })
export const PARTS = Object.freeze(Object.keys(WEIGHTS))

export const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

// a grid tile gains nothing above this rate (device.js holds a phone to the same); the camera on
// screen by itself is owed the camera's own rate
export const GRID_FPS = 15
const JITTER_FULL_MS = 80 // unevenness that costs the whole jitter penalty
const JITTER_WEIGHT = 0.3

/**
 * One tile, one second: 1 when it showed the frames it was owed, evenly; 0 while frozen.
 * @param {{ fps: number, fpsSrc: number, jitterMs?: number, stalled?: boolean, role?: 'focus'|'grid' }} s
 *   fps: frames shown in the second; fpsSrc: the rate the camera sends (the most this tile has shown)
 */
export function smoothness({ fps, fpsSrc, jitterMs = 0, stalled = false, role = 'grid' }) {
  if (stalled || !(fps > 0)) return 0
  const owed = role === 'focus' ? fpsSrc : Math.min(fpsSrc, GRID_FPS)
  const rate = owed > 0 ? clamp01(fps / owed) : 1
  return clamp01(rate - JITTER_WEIGHT * clamp01(jitterMs / JITTER_FULL_MS))
}

/** How much of the viewer's eye a tile has: its share of the screen, more when it is the one camera open. */
export function attention({ w = 0, h = 0, role = 'grid', visible = true }) {
  if (!visible || !(w > 0 && h > 0)) return 0
  return Math.pow(w * h, 0.6) * (role === 'focus' ? 3 : 1)
}

// each falls to about a third at its time: 0.8 s to a first picture, 1.2 s to full quality, 0.3 s to a seek
export const startupScore = (ms) => (ms >= 0 ? Math.exp(-ms / 800) : 0)
export const switchScore = (ms) => (ms >= 0 ? Math.exp(-ms / 1200) : 0)
export const scrubScore = (ms) => (ms >= 0 ? Math.exp(-ms / 300) : 0)

/** 1 with no trouble; a reconnect, a drop in quality or a decoder restart a minute brings it to 0. */
export function stability({ reconnects = 0, drops = 0, resets = 0, minutes }) {
  if (!(minutes > 0)) return null
  return clamp01(1 - (reconnects + drops + resets) / minutes)
}

/**
 * The score of a session, or of many pooled, from the mean of each part that has one.
 * @param {Partial<Record<keyof typeof WEIGHTS, number|null>>} parts each 0..1, or null/absent: not seen
 * @returns {{ score: number|null, from: string[], parts: object }} score null when nothing was seen
 */
export function score(parts) {
  const from = PARTS.filter((p) => Number.isFinite(parts?.[p]))
  const weight = from.reduce((a, p) => a + WEIGHTS[p], 0)
  if (!from.length) return { score: null, from, parts: {} }
  const kept = Object.fromEntries(from.map((p) => [p, clamp01(parts[p])]))
  return { score: from.reduce((a, p) => a + WEIGHTS[p] * kept[p], 0) / weight, from, parts: kept }
}

/** A running mean that can be added to and merged: { sum, n }. */
export const mean = { of: (m) => (m && m.n > 0 ? m.sum / m.n : null), add: (m, x, w = 1) => ({ sum: (m?.sum ?? 0) + x * w, n: (m?.n ?? 0) + w }) }
