// What this device has been seen to manage, layout by layout.
//
// No fixed limits: whether a layout suits a screen is decided by what that screen measured
// (the owner's rule, 2026-10-09). The Live page records, for each number of cameras it has played
// at once, the share of arriving frames it drew (viewer.js updateWallHealth), and this keeps that as
// the device's profile: in this browser's storage, since it describes this browser on this machine.
// The layout picker shows it, and choosing a layout this device handled badly says so. It never
// stops anyone: an existing wall is never taken away, and the administrator's tolerance decides.
//
// Pure apart from the storage it is handed.

export const PROFILE_KEY = 'argus.wallProfile'
/** The owner's defaults: up to 20% of frames dropped is acceptable, over 30% is not. */
export const TOLERANCE = Object.freeze({ okShare: 0.8, poorShare: 0.7 })
export const MIN_SECONDS = 30 // a layout is judged only once it has been watched this long
const WEIGHT = 0.05 // each second moves the kept figure a twentieth of the way to the new one
const MAX_LAYOUTS = 40
const APP_KEYS = ['userAgent'] // what the profile was measured on: a different browser version starts again

/** 'ok' | 'warn' | 'bad' for a share of frames drawn, against a tolerance. */
export const statusOf = (share, tol = TOLERANCE) => (share >= tol.okShare ? 'ok' : share >= tol.poorShare ? 'warn' : 'bad')

const blank = (app) => ({ v: 1, app, layouts: {} })

/** The profile kept in `storage`, or an empty one (nothing kept, unreadable, or measured on another browser version). */
export function readProfile(storage, nav = globalThis.navigator) {
  const app = APP_KEYS.map((k) => String(nav?.[k] ?? '')).join('|')
  try {
    const p = JSON.parse(storage?.getItem(PROFILE_KEY) ?? 'null')
    if (p?.v === 1 && p.app === app && p.layouts && typeof p.layouts === 'object') return p
  } catch {}
  return blank(app)
}

export function saveProfile(storage, profile) {
  try {
    storage?.setItem(PROFILE_KEY, JSON.stringify(profile))
  } catch {}
}

/**
 * One more second of a layout of `tiles` cameras, of which `share` of the arriving frames were drawn.
 * thinned: some tiles were being shown from their keyframes alone (wall-thin.js): the device could
 * not play this layout in full, whatever share the full-rate tiles reached.
 */
export function noteSecond(profile, tiles, share, { now = Date.now(), thinned = false } = {}) {
  if (!(tiles > 0) || !Number.isFinite(share)) return profile
  const was = profile.layouts[tiles]
  const s = Math.min(1, Math.max(0, share))
  const entry = was
    ? { share: was.share + WEIGHT * (s - was.share), seconds: was.seconds + 1, at: now, thinned: thinned ? now : was.thinned ?? 0 }
    : { share: s, seconds: 1, at: now, thinned: thinned ? now : 0 }
  const layouts = { ...profile.layouts, [tiles]: entry }
  const keys = Object.keys(layouts)
  if (keys.length > MAX_LAYOUTS) delete layouts[keys.sort((a, b) => layouts[a].at - layouts[b].at)[0]]
  return { ...profile, layouts }
}

const CAPACITY_DAYS = 7

/** The frames a second this device was last seen to manage on a wall it could not play in full (wall-thin.js). */
export function noteCapacity(profile, budget, now = Date.now()) {
  if (!(budget > 0) || !Number.isFinite(budget)) return profile
  return { ...profile, capacity: { budget: Math.round(budget), at: now } }
}

/** That figure, while it is fresh enough to start a wall from; else null. */
export function knownCapacity(profile, now = Date.now()) {
  const c = profile?.capacity
  return c && c.budget > 0 && now - c.at < CAPACITY_DAYS * 86_400_000 ? c.budget : null
}

/**
 * What to say about a layout of `tiles` cameras on this device, or null when it has not been
 * watched long enough to say anything.
 * @returns {{ status: 'ok' | 'warn' | 'bad', pct: number, thinned: boolean, short: string, long: string } | null}
 */
export function layoutNote(profile, tiles, { tol = TOLERANCE, now = Date.now() } = {}) {
  const e = profile?.layouts?.[tiles]
  if (!e || e.seconds < MIN_SECONDS) return null
  const thinned = e.thinned > 0 && now - e.thinned < 7 * 86_400_000 // (seen in the last week)
  const measured = statusOf(e.share, tol)
  const status = thinned && measured === 'ok' ? 'warn' : measured
  const pct = Math.round(e.share * 100)
  const short = thinned ? 'part at full rate' : `${pct}% shown`
  const long = thinned
    ? `This screen could not play all ${tiles} cameras in full last time: the busiest played every frame and the rest showed a picture every few seconds.`
    : status === 'ok'
      ? `This screen drew ${pct}% of the frames for ${tiles} cameras.`
      : `Performance is below recommended levels: this screen drew ${pct}% of the frames for ${tiles} cameras. A smaller layout will be smoother.`
  return { status, pct, thinned, short, long }
}
