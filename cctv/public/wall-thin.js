// A wall the device cannot decode in full: which tiles keep every frame.
//
// The viewing PC decodes about 720 frames a second in all (2026-10-09). A 10 x 10 wall asks for
// about 2,200: every tile's decoder fell seconds behind and each drew under two frames a second,
// late. Nothing the page does raises what the device can decode, so the frames it can decode are
// spent where something is happening: the busiest tiles (by the bits their cameras are sending,
// which is what motion costs an encoder) keep every frame, and the rest are shown from their
// keyframes alone, a current picture every keyframe interval, until the device has room again.
//
// Pure: the page hands in what it measured and applies what comes back (viewer.js updateWallThin).
// Nothing here is used below THIN_MIN_TILES, or on a device that keeps up.

export const THIN_MIN_TILES = 25 // smaller grids are left alone whatever they measure
export const THIN_MAX_KEY_MS = 4000 // a camera whose keyframes are further apart is never thinned: it would look frozen
export const THIN_SETTLE_MS = 6000 // a tile counts towards "keeping up" only once it has played at full rate this long
const FALLING_BEHIND = 0.92 // decoded under this share of what the full-rate tiles were fed, or ...
const HELD_TOO_LONG_MS = 1000 // ... frames kept in the decoders this long: the device is not keeping up
const BEHIND_READINGS = 2 // ... on this many readings running (one may be a link's hiccup)
const CUT = 0.8 // then: full rate for what was really decoded, less a fifth
const RAISE = 1.15 // room again for STEADY_MS: 15% more
const STEADY_MS = 20_000
const SETTLE_MS = 6000 // after a change, this long before the next (the decoders need it to catch up)
const MIN_BUDGET = 60 // frames a second: never fewer full-rate frames than a few tiles' worth
const KEEP_BONUS = 1.25 // a tile already at full rate ranks this much higher: no flapping between near equals
const RAISE_FAILED_MS = 40_000 // behind again this soon after a raise: that budget was too much, ...
const CEILING_MS = 5 * 60_000 // ... and is not tried again for this long (no sawtooth at the device's limit)

/** Where the controller starts: no limit. */
export const thinStart = () => ({ budget: Infinity, changedAt: -Infinity, okSince: null, behind: 0, raisedAt: -Infinity, ceiling: Infinity, ceilingAt: -Infinity })

/**
 * The frame budget after one more reading.
 * @param {ReturnType<typeof thinStart>} s
 * @param {{ now: number, fed: number, decoded: number, heldMs: number, all: number }} m frames a
 *   second: fed to and decoded by the tiles settled at full rate; heldMs: how long their decoders
 *   keep a frame (not the worst one: a figure a fifth of them reach); all: arriving for every tile
 */
export function nextBudget(s, m) {
  const isBehind = m.fed > 0 && (m.decoded < FALLING_BEHIND * m.fed || m.heldMs > HELD_TOO_LONG_MS)
  const behind = isBehind ? s.behind + 1 : 0
  if (m.now - s.changedAt < SETTLE_MS) return { ...s, behind: 0 } // (settling: neither counted against it nor for it)
  if (behind >= BEHIND_READINGS) {
    const failed = Number.isFinite(s.budget) && m.now - s.raisedAt < RAISE_FAILED_MS
    return {
      ...s,
      budget: Math.max(MIN_BUDGET, Math.floor(Math.min(s.budget, m.decoded) * CUT)),
      changedAt: m.now,
      okSince: null,
      behind: 0,
      ceiling: failed ? s.budget : s.ceiling,
      ceilingAt: failed ? m.now : s.ceilingAt
    }
  }
  if (isBehind) return { ...s, behind } // one reading: the next one decides
  const okSince = s.okSince ?? m.now
  if (Number.isFinite(s.budget) && m.now - okSince >= STEADY_MS) {
    let raised = Math.ceil(s.budget * RAISE)
    if (m.now - s.ceilingAt < CEILING_MS && raised >= s.ceiling) raised = Math.floor(s.ceiling * 0.95)
    if (raised <= s.budget) return { ...s, okSince, behind: 0 } // (at what this device was last seen to manage)
    return { ...s, budget: raised >= m.all ? Infinity : raised, changedAt: m.now, okSince: m.now, behind: 0, raisedAt: m.now }
  }
  return { ...s, okSince, behind: 0 }
}

/**
 * The tiles that keep every frame under a budget: the busiest first.
 * @param {{ key: string, fps: number, kbps: number, full: boolean }[]} tiles fps: frames a second
 *   arriving for it; kbps: what its camera sends; full: at full rate now
 * @returns {Set<string>} keys at full rate (every key when the budget is unlimited)
 */
export function fullRateTiles(tiles, budget) {
  if (budget === Infinity) return new Set(tiles.map((t) => t.key))
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
