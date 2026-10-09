// A wall the device cannot decode in full: which tiles keep every frame.
//
// The viewing PC decodes about 720 frames a second in all (2026-10-09). A 10 x 10 wall asks for
// about 2,200: every tile's decoder fell seconds behind and each drew under two frames a second,
// late. Nothing the page does raises what the device can decode, so the frames it can decode are
// spent where something is happening: the busiest tiles (by the bits their cameras are sending,
// which is what motion costs an encoder) keep every frame, and the rest are shown from their
// keyframes alone, a current picture every keyframe interval, until the device has room again.
//
// Pure: the page hands in what it measured and applies what comes back (viewer.js). Nothing here
// is used below THIN_MIN_TILES, or on a device that keeps up.

export const THIN_MIN_TILES = 25 // smaller grids are left alone whatever they measure
const FALLING_BEHIND = 0.92 // decoded under this share of what the full-rate tiles were fed, or ...
const HELD_TOO_LONG_MS = 1000 // ... a frame kept in the decoder this long: the device is not keeping up
const CUT = 0.8 // then: full rate for what was really decoded, less a fifth
const RAISE = 1.15 // room again for this long: 15% more
const STEADY_MS = 20_000
const SETTLE_MS = 6000 // after a change, this long before the next (the decoders need it to catch up)
const MIN_BUDGET = 60 // frames a second: never fewer full-rate frames than a few tiles' worth
const KEEP_BONUS = 1.25 // a tile already at full rate ranks this much higher: no flapping between near equals

/** Where the controller starts: no limit. */
export const thinStart = () => ({ budget: Infinity, changedAt: -Infinity, okSince: null })

/**
 * The frame budget after one more reading.
 * @param {{ budget: number, changedAt: number, okSince: number | null }} s
 * @param {{ now: number, fed: number, decoded: number, heldMs: number, all: number }} m per second:
 *   fed and decoded over the tiles at full rate, the longest a frame was held in a decoder, and all:
 *   every frame arriving for every tile (what no limit would mean)
 */
export function nextBudget(s, m) {
  const behind = m.fed > 0 && (m.decoded < FALLING_BEHIND * m.fed || m.heldMs > HELD_TOO_LONG_MS)
  if (m.now - s.changedAt < SETTLE_MS) return { ...s, okSince: behind ? null : (s.okSince ?? m.now) }
  if (behind) {
    const budget = Math.max(MIN_BUDGET, Math.floor(Math.min(s.budget, m.decoded) * CUT))
    return { budget, changedAt: m.now, okSince: null }
  }
  const okSince = s.okSince ?? m.now
  if (Number.isFinite(s.budget) && m.now - okSince >= STEADY_MS) {
    const raised = Math.ceil(s.budget * RAISE)
    return { budget: raised >= m.all ? Infinity : raised, changedAt: m.now, okSince: m.now }
  }
  return { ...s, okSince }
}

/**
 * The tiles that keep every frame under a budget: the busiest first.
 * @param {{ key: string, fps: number, kbps: number, full: boolean }[]} tiles fps: frames a second
 *   arriving for it; full: at full rate now
 * @returns {Set<string>} keys at full rate (every key when the budget is unlimited)
 */
export function fullRateTiles(tiles, budget) {
  if (!Number.isFinite(budget)) return new Set(tiles.map((t) => t.key))
  const ranked = [...tiles].sort((a, b) => b.kbps * (b.full ? KEEP_BONUS : 1) - a.kbps * (a.full ? KEEP_BONUS : 1) || (a.key < b.key ? -1 : 1))
  const out = new Set()
  let spent = 0
  for (const t of ranked) {
    const cost = Math.max(1, t.fps)
    if (spent + cost > budget) continue
    spent += cost
    out.add(t.key)
  }
  return out
}
