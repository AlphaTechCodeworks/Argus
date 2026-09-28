// The playback page's transport logic (no DOM): how fast and which way time moves. The spring-back
// shuttle's rate and label, what each source is allowed to play, clamping a speed to that, frame
// stepping, when only keyframes are worth fetching and which held-key repeats to ignore. Tested
// offline: test/pb-transport.test.mjs.
//
// The two ladders below mirror SERVER_SPEEDS and NVR_SPEEDS in pb-sources.js. They are repeated
// rather than imported so this module stays free of the rest of the page and its test runs under
// plain node; they must be changed together. The NVR's own playback session accepts 1, 2, 4 and 8
// forward only and refuses anything else, so a speed bound for an NVR leg goes through clampSpeed
// first — sending a speed it will reject is what clampSpeed exists to prevent.

/** Speeds the server's own playback can do (reverse and 8x+ send keyframes only). */
const SERVER_SPEEDS = Object.freeze([-32, -16, -8, -4, -2, -1, 1, 2, 4, 8, 16, 32])

/** Speeds the NVR's playback session accepts. Forward only; anything else is refused. */
const NVR_SPEEDS = Object.freeze([1, 2, 4, 8])

/**
 * The forward speeds the shuttle offers, slowest first. A subset of SERVER_SPEEDS: the shuttle is
 * only ever driven by server playback, and it stops at 16x because 32x skips so much that the
 * picture stops reading as motion.
 */
export const SPEEDS = Object.freeze([1, 2, 4, 8, 16])

/**
 * How far the shuttle must be pushed before it moves at all, as a fraction of its travel. Without
 * it the spring-back centre would never settle on paused, because a thumb rarely lets go at zero.
 */
export const DEAD_ZONE = 0.12

/**
 * The signed speed for a shuttle at `position` (-1…1): 0 inside the dead zone, otherwise a member of
 * SPEEDS with the sign of the position. The travel outside the dead zone is split evenly between the
 * rungs, so the rate never falls as the shuttle is pushed further out.
 */
export function shuttleRate(position, { dead = DEAD_ZONE } = {}) {
  const p = Math.min(1, Math.abs(Number(position) || 0))
  if (p < dead) return 0
  const travel = Math.max(1e-9, 1 - dead)
  const rung = Math.min(SPEEDS.length - 1, Math.floor(((p - dead) / travel) * SPEEDS.length))
  return SPEEDS[rung] * (position < 0 ? -1 : 1)
}

/** What the shuttle reads as: "paused", "> 4x" or "< 2x" with the arrows the mockup uses. */
export function shuttleLabel(rate) {
  if (!rate) return 'paused'
  return `${rate < 0 ? '◀' : '▶'} ${Math.abs(rate)}×`
}

/**
 * The speeds this source can play, slowest (most negative) first. Anything but 'server' is treated
 * as the NVR: the stricter of the two, so an unknown mode can never let a refused speed through.
 */
export function allowedSpeeds(mode) {
  return mode === 'server' ? SERVER_SPEEDS : NVR_SPEEDS
}

/**
 * The nearest speed `mode` allows, and whether it had to change — the page tells the viewer once
 * when it did. Reverse on a source that cannot reverse falls back to ordinary forward play rather
 * than to its fastest reverse, because carrying on forwards is the smaller surprise. Otherwise the
 * speed drops to the allowed rung below it, so the clamp never plays back faster than was asked.
 */
export function clampSpeed(speed, mode) {
  const allowed = allowedSpeeds(mode)
  const wanted = Number(speed) || 0
  if (allowed.includes(wanted)) return { speed: wanted, changed: false }
  const forwardOnly = allowed.every((s) => s > 0)
  if (wanted <= 0 && forwardOnly) return { speed: allowed[0], changed: true }
  if (wanted === 0) return { speed: 1, changed: true }
  const below = allowed.filter((s) => (wanted > 0 ? s > 0 && s <= wanted : s < 0 && s >= wanted))
  const picked = below.length > 0
    ? (wanted > 0 ? Math.max(...below) : Math.min(...below))
    : (wanted > 0 ? Math.min(...allowed.filter((s) => s > 0)) : Math.min(...allowed))
  return { speed: picked, changed: true }
}

/**
 * The second to show after stepping one frame in `direction` (+1 or -1) from currentS. Clamped at
 * the start of the day: stepping back off the beginning would ask for a negative offset.
 */
export function frameStep(currentS, direction, fps) {
  const rate = Number(fps) > 0 ? Number(fps) : 25
  return Math.max(0, currentS + (direction < 0 ? -1 : 1) / rate)
}

/**
 * Whether only keyframes are worth fetching at this rate. Above 8x the decoder cannot keep up with
 * every frame anyway, and reverse has to be assembled backwards from keyframes at any speed.
 */
export function needsKeyframesOnly(rate) {
  return rate < 0 || Math.abs(rate) >= 8
}

/** Keys that seek wherever they land: ±10 s, and with Shift the next or previous event. */
const SEEK_KEYS = new Set(['ArrowLeft', 'ArrowRight'])

/**
 * Whether a keydown is a held seek key's auto-repeat, to be ignored. Each seek can open a playback
 * (an NVR mode reopen, or an NVR leg over a stretch only the NVR has), and a held key repeats about
 * 30 times a second: 17 NVR playbacks in 2.4 s once put an NVR into its 60 s "busy" cool-down. One
 * press is one seek; a throttle would still flood a slow NVR, just more slowly.
 */
export function ignoredRepeat(e) {
  return Boolean(e?.repeat) && SEEK_KEYS.has(e.key)
}
