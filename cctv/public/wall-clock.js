// The camera wall's pure logic (no DOM): the one clock every tile follows, the conversion between
// server time and each NVR's own clock, when a tile has drifted far enough to be put back, the grid
// layout, what a tile can honestly say at a moment, and how many tiles this PC will stand.
// Tested offline: test/wall-clock.test.mjs.
//
// Time base: server time throughout, exactly as pb-sources.js defines it. Each NVR's clock differs
// by skewMs (NVR clock - server clock; nvr1 runs about 220 s fast), so a tile played from the NVR's
// own playback session is asked for serverMs + skewMs and reports back positions that must have the
// skew taken off again before they are compared with anything. Getting that wrong is the whole risk
// of this page: two tiles would sit side by side, both labelled 14:00, showing moments 220 s apart.
// That is worse than not building the wall at all, so every crossing of the boundary goes through
// cameraTime()/serverTime() and nothing else.
import { laneBoxes } from './pb-view.js'

/** A camera key, "<nvr id>/<channel>" — the same rule as user-prefs.mjs and grid-order.js. */
export const KEY_RE = /^[A-Za-z0-9._-]{1,64}\/\d{1,4}$/

/**
 * The most tiles the page will put up at all. Not a performance figure — it is the point past which
 * the wall stops being readable on a screen, whatever the PC can decode.
 */
export const MAX_TILES = 16

/**
 * What a decent office PC manages, from the plan: about 4 main-stream (HD) tiles or 9 sub-stream
 * (SD) ones. These are honest guesses, not measurements, and the page says so.
 */
export const BUDGET = Object.freeze({ hd: 4, sd: 9 })

/** A tile more than this far from the shared clock is put back rather than left to drift. */
export const RESYNC_MS = 1500

// ---- the two clocks -------------------------------------------------------------------------

/** A server-time moment as the NVR's own clock reads it (what its playback session must be asked for). */
export function cameraTime(serverMs, skewMs = 0) {
  if (!Number.isFinite(serverMs)) return null
  return serverMs + (Number.isFinite(skewMs) ? skewMs : 0)
}

/** A moment reported by an NVR playback session, back in server time (what the page may show). */
export function serverTime(cameraMs, skewMs = 0) {
  if (!Number.isFinite(cameraMs)) return null
  return cameraMs - (Number.isFinite(skewMs) ? skewMs : 0)
}

/**
 * Whether a tile has drifted far enough from the shared clock to be seeked back. `tileServerMs` is
 * the tile's position already converted to server time (serverTime above) — a tile with no picture
 * yet (null) is left alone, because seeking it again would only restart the wait.
 *
 * The tolerance is footage, and footage goes by `speed` times as fast as the wall's timer: at 8x a
 * tile 1.5 s of footage out is under 200 ms of real time out, which is no more than the buffer every
 * tile plays through. So the tolerance grows with the speed (never below the 1x figure); a fixed one
 * had every tile seeked back about every 3 s at 4x and above.
 */
export function needsResync(tileServerMs, clockMs, { tolMs = RESYNC_MS, speed = 1 } = {}) {
  if (!Number.isFinite(tileServerMs) || !Number.isFinite(clockMs)) return false
  const rate = Number.isFinite(speed) ? Math.max(1, Math.abs(speed)) : 1
  return Math.abs(tileServerMs - clockMs) > Math.max(0, tolMs) * rate
}

/**
 * The clock every tile follows. It is the wall's only source of "now": tiles never advance time of
 * their own accord, they are told where to be. Held apart from the DOM so that the arithmetic that
 * keeps eight cameras together can be tested without a browser.
 *
 * `now` is injected (performance.now() in the page) so the tests can step time by hand. Elapsed real
 * time is multiplied by the speed, so 4x moves the wall four times as fast; a negative speed is
 * allowed only when every tile can reverse, which the page decides (see wallMode).
 */
export class WallClock {
  constructor({ atMs = 0, speed = 1, playing = false, now = () => 0 } = {}) {
    this.atMs = Number(atMs) || 0
    this.speed = Number(speed) || 1
    this.playing = Boolean(playing)
    this.now = now
    this.last = this.now()
  }

  /** Moves the clock on by the real time since the last tick. Returns the new moment. */
  tick() {
    const t = this.now()
    const dt = Math.max(0, t - this.last)
    this.last = t
    if (this.playing) this.atMs += dt * this.speed
    return this.atMs
  }

  /** Jump to a moment. The tick is reset too, so the jump does not also collect the time waited. */
  seek(ms) {
    if (Number.isFinite(ms)) this.atMs = ms
    this.last = this.now()
    return this.atMs
  }

  setSpeed(speed) {
    this.tick() // bank the time run at the old speed before changing it
    if (Number.isFinite(speed) && speed !== 0) this.speed = speed
    return this.speed
  }

  play() {
    this.last = this.now()
    this.playing = true
  }

  pause() {
    this.tick() // the time since the last tick was really played; keep it
    this.playing = false
  }
}

// ---- what the wall as a whole can do --------------------------------------------------------

/**
 * The transport mode the whole wall is limited to. One tile playing from an NVR session holds the
 * wall to what that session accepts (1-8x forward), because the alternative — each tile at its own
 * speed — is not a wall of one moment any more.
 * @param {Array<{mode?: string}>} tiles
 */
export function wallMode(tiles) {
  return (tiles ?? []).some((t) => t?.mode !== 'server') ? 'nvr' : 'server'
}

// ---- the grid -------------------------------------------------------------------------------

/**
 * How to lay `count` tiles out in a box: the column count that makes each picture biggest once the
 * camera's aspect ratio is honoured. Chosen rather than a fixed square grid because a wide screen
 * with 3 cameras wants one row, and the same 3 on a phone want one column.
 * @returns {{ cols: number, rows: number, tileW: number, tileH: number }}
 */
export function gridLayout(count, { width = 1600, height = 900, aspect = 16 / 9, gap = 4 } = {}) {
  const n = Math.max(0, Math.floor(count) || 0)
  if (n === 0) return { cols: 0, rows: 0, tileW: 0, tileH: 0 }
  let best = null
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const cellW = (width - gap * (cols - 1)) / cols
    const cellH = (height - gap * (rows - 1)) / rows
    if (cellW <= 0 || cellH <= 0) continue
    // the picture inside the cell keeps its shape, so the smaller of the two limits wins
    const w = Math.min(cellW, cellH * aspect)
    const h = w / aspect
    if (!best || w * h > best.tileW * best.tileH) best = { cols, rows, tileW: w, tileH: h }
  }
  return best ?? { cols: n, rows: 1, tileW: 0, tileH: 0 }
}

/**
 * What to tell the viewer about asking this PC for this many tiles at this quality. Said plainly and
 * up front: the alternative is letting the page grind and leaving them to guess why.
 * @returns {{ level: 'ok'|'heavy'|'over', text: string }}
 */
export function loadWarning(count, quality = 'sd') {
  const n = Math.max(0, Math.floor(count) || 0)
  const sd = quality !== 'hd'
  const budget = sd ? BUDGET.sd : BUDGET.hd
  const kind = sd ? 'sub-stream (SD)' : 'main-stream (HD)'
  if (n === 0) return { level: 'ok', text: 'Choose the cameras to put on the wall.' }
  if (n <= budget) return { level: 'ok', text: `${n} ${kind} ${n === 1 ? 'tile' : 'tiles'}. A decent PC manages about ${budget}.` }
  if (n <= budget * 2) {
    return {
      level: 'heavy',
      text: `${n} ${kind} tiles is more than the roughly ${budget} a decent PC decodes. Expect jerky pictures and tiles that fall behind and are put back. ${sd ? '' : 'Switching to sub-streams would help most.'}`.trim()
    }
  }
  return {
    level: 'over',
    text: `${n} ${kind} tiles is far past what this PC will decode (about ${budget}). The pictures will stutter and the wall will spend its time catching up. Take some cameras off, ${sd ? 'or watch a shorter list' : 'or switch to sub-streams'}.`
  }
}

// ---- a tile at a moment ----------------------------------------------------------------------

/** Whether any stretch [{s, e}] covers t. */
export function coversAt(stretches, t) {
  if (!Number.isFinite(t)) return false
  return (stretches ?? []).some((x) => x?.s <= t && t < x?.e)
}

/** How many of the cameras have footage at t — the "3 of 8 cameras" line above the wall. */
export function coverageAt(cameras, t) {
  const list = cameras ?? []
  return { with: list.filter((c) => coversAt(c?.stretches, t)).length, total: list.length }
}

/**
 * What a tile can honestly say at this moment. A camera with nothing recorded says so; it never sits
 * there black, because black is indistinguishable from a camera that is broken, or from one that saw
 * nothing happen — and on an investigation those are very different answers.
 * @param {{ available?: boolean, codec?: string, h265?: boolean, stretches?: Array, atMs?: number,
 *           undecodable?: boolean, error?: string|null }} o
 * @returns {{ kind: 'playing'|'no-footage'|'undecodable'|'unavailable'|'error', text: string }}
 */
export function tileState({ available = true, codec = 'h264', h265 = true, stretches = [], atMs = null, undecodable = false, error = null } = {}) {
  if (error) return { kind: 'error', text: error }
  // Only when playing it actually failed: the server converts H.265 for a browser that cannot play
  // it (NVR sub-streams and server recordings alike), so a codec known in advance is no reason to
  // give up before trying -- the wall used to refuse every H.265 camera on such a laptop.
  if (undecodable) {
    return { kind: 'undecodable', text: 'H.265 — this PC cannot decode it. Set this camera to H.264, or open it on a PC that can.' }
  }
  if (!available) return { kind: 'unavailable', text: 'No recordings of this camera on the server.' }
  if (!coversAt(stretches, atMs)) return { kind: 'no-footage', text: 'Nothing recorded at this moment.' }
  return { kind: 'playing', text: '' }
}

/**
 * A lane per camera for the timeline: the same boxes pb-view.js draws for the playback page, one row
 * each, so the gaps line up vertically and you can see at a glance which cameras were recording.
 * @returns {Array<{ key: string, name: string, boxes: Array }>}
 */
export function laneRows(view, cameras) {
  return (cameras ?? []).map((c) => ({
    key: c?.key ?? '',
    name: c?.name ?? c?.key ?? '',
    boxes: laneBoxes(view, c?.stretches ?? [])
  }))
}

// ---- which cameras are on the wall ------------------------------------------------------------

/**
 * A saved camera choice made safe: only well-formed keys, each once, in order, at most MAX_TILES.
 * `known` (when given) drops cameras that no longer exist, so a deleted NVR cannot leave a tile
 * that can never load.
 */
export function normaliseChoice(keys, { known = null, max = MAX_TILES } = {}) {
  const seen = new Set()
  const out = []
  for (const k of Array.isArray(keys) ? keys : []) {
    if (typeof k !== 'string' || !KEY_RE.test(k) || seen.has(k)) continue
    if (known && !known.has(k)) continue
    seen.add(k)
    out.push(k)
    if (out.length >= Math.max(1, max)) break
  }
  return out
}

/**
 * The stored shape of the choice, versioned the way user-prefs.mjs versions the live grid's order:
 * the version counts the saves, and a save made on an older version is refused rather than allowed
 * to wipe one made on another screen. Kept as a pure function so the store behind it can move from
 * the browser to the server later without the page changing.
 * @returns {{ saved: boolean, cameras: string[], version: number }}
 */
export function applyChoice(current, change) {
  const now = { cameras: normaliseChoice(current?.cameras), version: Number.isSafeInteger(current?.version) && current.version >= 0 ? current.version : 0 }
  if (!Number.isSafeInteger(change?.version) || change.version !== now.version) return { saved: false, ...now }
  return { saved: true, cameras: normaliseChoice(change.cameras), version: now.version + 1 }
}
