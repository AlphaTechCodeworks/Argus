// The playback bar's own rules (no DOM): where "previous" and "next" go, where the first and the
// newest recording are, how the speed slider maps onto the speeds a source can really play, what the
// pill on the playhead reads, how the span of the timeline is said in words, and the link the
// Playback | Live switch follows. Shared by the single-camera page (playback.js) and Many cameras
// (wall.js), and read by the Live page (viewer.js) for the link. Tested offline:
// test/pb-bar.test.mjs.
//
// Times are absolute milliseconds, the same base as pb-view.js and pb-sources.js. A list of recorded
// stretches may be given as [[start, end]] (the NVR's ranges), as { s, e } (pb-sources stretches) or
// as { from, to } / { start, end }; marks the same, or as bare times.
import { fmtClock } from './pb-view.js'

const S = 1000

/**
 * How close to a mark the playhead may be and still count as "on it". Without this, Previous pressed
 * on a mark that has played for a second goes back to that same mark, for ever.
 */
export const SEQUENCE_TOLERANCE_MS = 2000

/** Stretches closer together than this are one stretch: a file roll-over is not a new recording. */
export const JOIN_MS = 2000

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const startOf = (r) => (Array.isArray(r) ? num(r[0]) : typeof r === 'number' ? num(r) : num(r?.s ?? r?.from ?? r?.start))
const endOf = (r) => (Array.isArray(r) ? num(r[1]) : typeof r === 'number' ? num(r) : num(r?.e ?? r?.to ?? r?.end))

/**
 * The recorded stretches in time order, with those that touch or nearly touch joined: `[{ s, e }]`.
 * The page's own list is cut wherever the source changes (the server's footage, then a stretch only
 * the NVR has) or a file ends, and none of those is the start of anything a viewer would call a
 * recording. Reversed and empty stretches are dropped.
 */
export function recordedSpans(spans, { joinMs = JOIN_MS } = {}) {
  const list = []
  for (const r of spans ?? []) {
    const s = startOf(r)
    const e = endOf(r)
    if (s === null || e === null || e <= s) continue
    list.push({ s, e })
  }
  list.sort((a, b) => a.s - b.s)
  const out = []
  for (const r of list) {
    const last = out.at(-1)
    if (last && r.s <= last.e + joinMs) last.e = Math.max(last.e, r.e)
    else out.push({ ...r })
  }
  return out
}

/** Where each recorded stretch begins (after joining, recordedSpans), earliest first. */
export function spanStarts(spans, opts) {
  return recordedSpans(spans, opts).map((r) => r.s)
}

/**
 * Every moment Previous and Next stop at: the start of each recorded stretch and the start of each
 * mark (motion, an alarm, a search hit), earliest first, each once.
 */
export function sequenceStarts(spans, marks) {
  const all = spanStarts(spans)
  for (const m of marks ?? []) {
    const s = startOf(m)
    if (s !== null) all.push(s)
  }
  all.sort((a, b) => a - b)
  return all.filter((t, i) => i === 0 || t !== all[i - 1])
}

/**
 * Where Previous (direction -1) or Next (+1) goes from `atMs`: the nearest start before or after
 * the playhead, or null when there is none that way (the first one going back, the last going on),
 * so the page can say so instead of jumping somewhere unasked.
 *
 * A start within `toleranceMs` of the playhead is the one it is on, and is passed over: Previous
 * pressed twice walks back two, and Next never lands on the mark it is standing on. While footage
 * plays the page widens the tolerance by the speed, since the playhead has moved on that much more
 * by the second press.
 */
export function sequenceTarget({ spans, marks, atMs, direction, toleranceMs = SEQUENCE_TOLERANCE_MS } = {}) {
  const at = num(atMs)
  if (at === null) return null
  const tol = Math.max(0, num(toleranceMs) ?? SEQUENCE_TOLERANCE_MS)
  const starts = sequenceStarts(spans, marks)
  if (direction < 0) return starts.filter((t) => t < at - tol).at(-1) ?? null
  return starts.find((t) => t > at + tol) ?? null
}

/** The start of the first recording in the list, or null when nothing is recorded. */
export function recordingStart(spans) {
  return recordedSpans(spans)[0]?.s ?? null
}

/**
 * Where "jump to the end" plays from: `backMs` before the end of the newest recording, so there is
 * something to watch rather than the last frame and a stop, and never before that recording began.
 * Null when nothing is recorded.
 */
export function recordingEnd(spans, { backMs = 10 * S } = {}) {
  const last = recordedSpans(spans).at(-1)
  if (!last) return null
  return Math.max(last.s, last.e - Math.max(0, num(backMs) ?? 0))
}

// ---- the speed slider -------------------------------------------------------------------------

/**
 * The slider's stops, slowest first: the forward speeds the source allows (pb-transport.js
 * allowedSpeeds), which are exactly the ones the old Speed button stepped through. The slider only
 * sets how fast; which way is the two play buttons' business.
 */
export function sliderSpeeds(allowed) {
  return [...new Set((allowed ?? []).filter((s) => Number.isFinite(s) && s >= 1))].sort((a, b) => a - b)
}

/** Whether the source can play backwards at all (the NVR's own playback cannot). */
export function canReverse(allowed) {
  return (allowed ?? []).some((s) => s < 0)
}

/** The slider stop showing `speed` (either direction): its own, or the nearest one below it. */
export function sliderIndex(speed, allowed) {
  const stops = sliderSpeeds(allowed)
  const mag = Math.abs(Number(speed) || 1)
  let index = 0
  for (let i = 0; i < stops.length; i++) if (stops[i] <= mag) index = i
  return index
}

/**
 * The speed for slider stop `index`, in the direction now playing (-1 backwards). Always one of the
 * allowed speeds: the stop is rounded and kept on the slider, and a backwards speed the source does
 * not have comes back as the forward one.
 */
export function sliderSpeed(index, allowed, direction = 1) {
  const stops = sliderSpeeds(allowed)
  if (stops.length === 0) return 1
  const i = Math.min(stops.length - 1, Math.max(0, Math.round(Number(index) || 0)))
  const mag = stops[i]
  return direction < 0 && (allowed ?? []).includes(-mag) ? -mag : mag
}

/** The speed in words beside the slider: "1×", "4×", and "4× back" in reverse. */
export function speedText(speed) {
  const s = Number(speed) || 1
  return `${Math.abs(s)}×${s < 0 ? ' back' : ''}`
}

// ---- the pill on the playhead -----------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0')

/**
 * What the pill reads: the date and the time under the playhead on the site's own clock,
 * "2026-10-12 09:34:48". Milliseconds only when asked ({ millis: true }) — the page asks only when
 * the time is a frame's own timestamp. Empty when there is no playhead.
 */
export function pillText(ms, { tzOffsetMs = 0, millis = false } = {}) {
  if (num(ms) === null) return ''
  const tz = num(tzOffsetMs) ?? 0
  // (read with getUTC* after adding the offset, as fmtClock does: the browser's zone has no say)
  const d = new Date(Math.floor(ms + tz))
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  return `${date} ${fmtClock(ms, { ms: millis, tzOffsetMs: tz })}`
}

// ---- the span, in words -----------------------------------------------------------------------

/** How much time the timeline shows, in words: "24 hours", "1 hour", "5 minutes", "30 seconds". */
export function spanWords(spanMs) {
  const span = Math.max(num(spanMs) ?? 0, 0)
  const say = (n, unit) => {
    const r = Math.round(n * 10) / 10
    return `${r} ${unit}${r === 1 ? '' : 's'}`
  }
  const tenth = (n) => Math.round(n * 10) / 10
  // (a figure that rounds up to the next unit is said in that unit: "1 hour", never "60 minutes")
  if (span >= 3600 * S || tenth(span / (60 * S)) >= 60) return say(span / (3600 * S), 'hour')
  if (span >= 60 * S || tenth(span / S) >= 60) return say(span / (60 * S), 'minute')
  return say(span / S, 'second')
}

// ---- Playback | Live --------------------------------------------------------------------------

/**
 * The Live page showing what Playback shows: one camera full-size (`nvr` and `ch`), a saved view
 * (`view`, its id) or a set of cameras (`cameras`, "<nvr>/<ch>" keys). With none of them, plain Live.
 */
export function liveHref({ nvr = null, ch = null, view = null, cameras = null } = {}) {
  if (nvr !== null && nvr !== '' && ch !== null && ch !== '') return `/?nvr=${encodeURIComponent(nvr)}&ch=${encodeURIComponent(ch)}`
  if (view) return `/?view=${encodeURIComponent(view)}`
  const keys = (cameras ?? []).filter((k) => typeof k === 'string' && k.includes('/'))
  if (keys.length > 0) return `/?cameras=${keys.map(encodeURIComponent).join(',')}`
  return '/'
}

/**
 * What a link made by liveHref asks the Live page for: `{ camera: { nvr, ch } | null,
 * view: id | null, cameras: [key] | null }`. Anything else in the address is ignored.
 */
export function readLiveLink(search) {
  const p = new URLSearchParams(search ?? '')
  const nvr = p.get('nvr')
  const ch = p.get('ch')
  const keys = (p.get('cameras') ?? '').split(',').map((k) => k.trim()).filter((k) => k.includes('/'))
  return {
    camera: nvr && ch !== null && ch !== '' ? { nvr, ch } : null,
    view: p.get('view') || null,
    cameras: keys.length > 0 ? keys : null
  }
}
