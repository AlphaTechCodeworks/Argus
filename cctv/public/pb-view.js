// The playback page's view window (no DOM): which part of the day the timeline is showing, and where
// things sit inside it. Split out from playback.js, like pb-sources.js, because this is the maths that
// used to be tangled with canvas drawing and so could only be tried in a browser. Tested offline:
// test/pb-view.test.mjs.
//
// Times are absolute milliseconds throughout, the same base as state.view and pb-sources.js, so no
// call site has to convert. Wall-clock times come from an explicit time-zone offset (the NVR's
// tzOffsetMs, local - UTC) rather than the machine's own, because the viewer may be nowhere near the
// camera and the day shown is the camera's day, not the browser's.
//
// Every function is pure: it takes a view and returns a new one, never touching the one it was given,
// so callers can hold on to the old window (undo, a dragged overview strip) without copying. All the
// clamping lives in makeView, so there is exactly one definition of "a valid window" and zoomAt,
// panBy and follow cannot drift from it; they work out what they want and hand it back through
// makeView. That is what stops the arithmetic running off the end of the day at midnight, which is
// where the naive version went out of range.

export const DAY_MS = 86_400_000

const S = 1000
/** The seconds between labels we are willing to use: familiar clock divisions, coarsest last. */
const TICK_LADDER = Object.freeze([1, 5, 10, 30, 60, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200].map((s) => s * S))
/** At most this many labels across the timeline, or they collide at phone widths. */
const MAX_TICKS = 8
/** A box narrower than this is still drawn this wide: a one-second gap has to stay clickable. */
const MIN_BOX_PCT = 0.1
/**
 * The most boxes the page draws in one lane (playback.js fillLane): every box is an element, so a
 * day of one-second motion events would otherwise be tens of thousands of them. laneBoxes merges
 * boxes that meet on screen, so this is only reached by thousands of stretches genuinely apart; at
 * 400 a busy camera's lane stopped hours before the end of its day, and none of its holes were drawn.
 */
export const MAX_BOXES = 3000
/** Boxes this close (in % of the track) count as touching: float rounding, not a real space between them. */
const TOUCH_PCT = 1e-9

const num = (x, fallback) => (Number.isFinite(x) ? Number(x) : fallback)
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)
/** A range's kind, as laneBoxes reads it: pb-sources stretches say src, the page's own lists kind. */
const kindOf = (r) => r?.kind ?? r?.src ?? null

/**
 * A valid window on the day: the span within its limits and never longer than the day itself, and the
 * window wholly inside the day. Accepts a view back (it is idempotent), so the other functions can
 * change one field and re-clamp.
 * @param {{ spanMs?: number, startMs?: number, minSpanMs?: number, maxSpanMs?: number,
 *           dayStartMs?: number, dayEndMs?: number }} o
 * @returns {{ spanMs: number, startMs: number, endMs: number, minSpanMs: number, maxSpanMs: number,
 *            dayStartMs: number, dayEndMs: number }}
 */
export function makeView({ spanMs, startMs, minSpanMs, maxSpanMs, dayStartMs, dayEndMs } = {}) {
  const dayStart = num(dayStartMs, num(startMs, 0))
  const dayEnd = Math.max(num(dayEndMs, dayStart + DAY_MS), dayStart + S)
  const dayLen = dayEnd - dayStart
  // A span wider than the day is meaningless however wide maxSpanMs says it may be.
  const min = clamp(num(minSpanMs, S), S, dayLen)
  const max = clamp(num(maxSpanMs, dayLen), min, dayLen)
  const span = clamp(num(spanMs, max), min, max)
  const start = clamp(num(startMs, dayStart), dayStart, dayEnd - span)
  return { spanMs: span, startMs: start, endMs: start + span, minSpanMs: min, maxSpanMs: max, dayStartMs: dayStart, dayEndMs: dayEnd }
}

/**
 * Zoom by `factor` (below 1 zooms in) about `atMs`, keeping that moment under the same pixel — the
 * fraction of the way across the window it sits at is preserved. At the edges of the day the window
 * cannot move far enough to hold it exactly, and makeView wins: a valid window matters more than a
 * pixel. A pointer outside the window (a stale one during a wheel burst) is treated as the nearest
 * edge rather than flung off the day.
 */
export function zoomAt(view, factor, atMs) {
  const v = makeView(view)
  const f = num(factor, 1)
  if (f <= 0) return v
  const span = clamp(v.spanMs * f, v.minSpanMs, v.maxSpanMs)
  const at = clamp(num(atMs, v.startMs + v.spanMs / 2), v.startMs, v.endMs)
  const frac = (at - v.startMs) / v.spanMs
  return makeView({ ...v, spanMs: span, startMs: at - frac * span })
}

/** Move the window by a fraction of its own span (positive is later), clamped to the day. */
export function panBy(view, deltaFraction) {
  const v = makeView(view)
  return makeView({ ...v, startMs: v.startMs + num(deltaFraction, 0) * v.spanMs })
}

/**
 * Keep the playhead in sight while it plays: the same view back (the very same object, so callers can
 * skip a redraw) while it is within the first `edge` of the window, and a window centred on it once it
 * has run past that — or is behind the window, after a seek backwards.
 */
export function follow(view, atMs, { edge = 0.9 } = {}) {
  const at = num(atMs, null)
  if (at === null) return view
  const v = makeView(view)
  const frac = (at - v.startMs) / v.spanMs
  if (frac >= 0 && frac <= edge) return view
  return makeView({ ...v, startMs: at - v.spanMs / 2 })
}

/**
 * The milliseconds between labels: the finest rung of the ladder giving at most MAX_TICKS labels.
 * A window holding n whole steps shows n + 1 marks once both ends land on one, so the test is against
 * MAX_TICKS - 1 steps; counting steps instead is how a ladder ends up one label too crowded.
 */
export function tickStep(spanMs, maxTicks = MAX_TICKS) {
  const span = Math.max(num(spanMs, DAY_MS), 1)
  const limit = clamp(Math.floor(num(maxTicks, MAX_TICKS)), 2, MAX_TICKS)
  return TICK_LADDER.find((step) => span / step <= limit - 1) ?? TICK_LADDER.at(-1)
}

/**
 * The labelled marks across the window, `[{ ms, label }]`, every one inside it. Marks land on local
 * clock boundaries (the offset is applied before rounding to the step), so a five-minute step reads
 * :00 :05 :10 rather than five minutes after whatever the window happens to start at.
 * The label carries seconds only when the step is under a minute; above that, consecutive labels would
 * otherwise read the same minute twice.
 */
export function ticks(view, tzOffsetMs = 0, maxTicks = MAX_TICKS) {
  const v = makeView(view)
  const tz = num(tzOffsetMs, 0)
  const step = tickStep(v.spanMs, maxTicks)
  const out = []
  const first = Math.ceil((v.startMs + tz) / step) * step - tz
  for (let t = first; t <= v.endMs; t += step) {
    const clock = fmtClock(t, { tzOffsetMs: tz })
    out.push({ ms: t, label: step < 60 * S ? clock : clock.slice(0, 5) })
  }
  return out
}

const pad = (n, w = 2) => String(n).padStart(w, '0')

/**
 * An absolute timestamp as a local wall clock, "09:34:48", or "09:34:48.199" with { ms: true }.
 * Read with getUTC* after adding the offset, the same trick playback.js uses, so the browser's own
 * zone never gets a say. Anything that is not a finite time reads as midnight rather than NaN:NaN.
 */
export function fmtClock(ms, { ms: showMillis = false, tzOffsetMs = 0 } = {}) {
  const t = Number.isFinite(ms) ? Math.floor(ms + num(tzOffsetMs, 0)) : 0
  const d = new Date(t)
  const clock = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  return showMillis ? `${clock}.${pad(d.getUTCMilliseconds(), 3)}` : clock
}

/**
 * The recorded stretches as boxes across the window: `[{ leftPct, widthPct, kind, from, to }]`, clipped
 * to the view, with anything wholly outside dropped. Percentages, not pixels, so a resize needs no
 * recalculation. Ranges may be given as { from, to, kind } or as pb-sources stretches { s, e, src }.
 * `from`/`to` are the clipped times, which is what a click on the box should seek to — note that a box
 * widened to MIN_BOX_PCT is wider than the time it stands for, so seeking must use these and never the
 * box's own edges. A folded box (below) stands for many ranges, so a click on one goes through
 * boxSeekMs, which picks the range under the pointer rather than playing the first.
 *
 * A box that touches or overlaps the last box of its own kind on screen (after the widening) is
 * folded into it: `from`/`to` then run from the first one's start to the last one's end, and `n` says
 * how many ranges it stands for. The picture is the same — they were painted over each other anyway —
 * but a day of 2,000 three-second holes is a few hundred boxes instead of 2,000, which is what keeps a
 * busy lane under MAX_BOXES all the way to midnight. The merge is keyed by kind, so the NVR-only
 * slivers the page draws between server boxes do not keep those server boxes apart, and a kind is
 * never folded into another: a gap stays a gap however closely it is hemmed in by recordings.
 */
export function laneBoxes(view, ranges) {
  const v = makeView(view)
  const out = []
  const lastOf = new Map() // kind -> the newest box of that kind, the one a touching box joins
  for (const r of ranges ?? []) {
    const from = num(r?.from ?? r?.s, null)
    const to = num(r?.to ?? r?.e, null)
    if (from === null || to === null || to <= from) continue
    const a = Math.max(from, v.startMs)
    const b = Math.min(to, v.endMs)
    if (b <= a) continue
    const widthPct = Math.max(((b - a) / v.spanMs) * 100, MIN_BOX_PCT)
    // A widened sliver near the right edge would otherwise hang over the end of the track.
    const leftPct = Math.min(((a - v.startMs) / v.spanMs) * 100, 100 - widthPct)
    const kind = kindOf(r)
    const prev = lastOf.get(kind)
    if (prev && leftPct <= prev.leftPct + prev.widthPct + TOUCH_PCT && leftPct + widthPct >= prev.leftPct - TOUCH_PCT) {
      // min/max rather than "extend to the right": a list out of time order merges the same way
      const right = Math.max(prev.leftPct + prev.widthPct, leftPct + widthPct)
      prev.leftPct = Math.min(prev.leftPct, leftPct)
      prev.widthPct = right - prev.leftPct
      prev.from = Math.min(prev.from, a)
      prev.to = Math.max(prev.to, b)
      prev.n++
      continue
    }
    const box = { leftPct, widthPct, kind, from: a, to: b, n: 1 }
    out.push(box)
    lastOf.set(kind, box)
  }
  return out
}

/**
 * Where a click on a lane box plays from: the start of the latest of its ranges that started by the
 * time under the pointer. A folded box's `from` is only its first range's start, and at the day view
 * motion a minute apart folds into one box an hour long, so playing `from` would start a click near
 * its end an hour early. Before the fold each range had its own box, each drawn over the one before,
 * so the box on top under the pointer was this same range: a click still lands on the event it is
 * on, from its beginning, rather than somewhere in the minute after it ended.
 *
 * `ranges` is the list the box was made from. Only ranges of the box's own kind starting inside it
 * count, so an event in another box, or a hit handed in with the events, is never picked; a click
 * left of them all (a box pulled in at the right edge) plays the box's first. Starts are clipped to
 * the box as laneBoxes clipped them, so an event already running when the view starts plays from
 * the view's edge, as its box says.
 * @param {{ from: number, to: number, kind?: string|null }} box one of laneBoxes' boxes
 * @param {number} atMs the time under the pointer
 * @param {Array<{from?: number, to?: number, s?: number, e?: number, kind?: string, src?: string}>} ranges
 * @returns {number}
 */
export function boxSeekMs(box, atMs, ranges) {
  const from = num(box?.from, null)
  const to = num(box?.to, from)
  if (from === null) return num(atMs, null)
  const t = num(atMs, from)
  const kind = box.kind ?? null
  let best = from
  for (const r of ranges ?? []) {
    if (kindOf(r) !== kind) continue
    const s = num(r?.from ?? r?.s, null)
    const e = num(r?.to ?? r?.e, null)
    // the same ranges laneBoxes would have drawn: no reversed or zero-length ones
    if (s === null || e === null || e <= s) continue
    if (s > best && s <= t && s <= to) best = s
  }
  return best
}

/** A span as something to put on a button: "1 h", "48 min", "30 s". */
export function spanLabel(spanMs) {
  const span = Math.max(num(spanMs, 0), 0)
  const trim = (n) => String(Math.round(n * 10) / 10)
  if (span >= 3600 * S) return `${trim(span / (3600 * S))} h`
  if (span >= 60 * S) return `${trim(span / (60 * S))} min`
  return `${trim(span / S)} s`
}
