// Bookmarks without a screen: what counts as a valid bookmark, where its diamond sits on the
// timeline, and which bookmarks a filter keeps. No DOM here and nothing imported from node, so the
// same rules run in the browser and in the server's bookmarks.mjs — the page can refuse a bad
// bookmark before it is sent, and the server refuses the same one again for a client that did not.
// One set of rules in one place is the point: a title limit that disagrees between the two ends is
// how a form ends up silently truncating what someone typed.
//
// Times are absolute milliseconds, the same base as pb-view.js and pb-sources.js.
// Tested offline: test/bookmarks.test.mjs.

/** A bookmark's title is a line in a list, not a paragraph. */
export const MAX_TITLE = 120
export const MAX_DESCRIPTION = 2000
/** More cameras than anyone points at one incident; a guard against a runaway client. */
export const MAX_CAMERAS = 16
/**
 * Longer than this is not a bookmark, it is a day's footage, and marking a day protects it from
 * housekeeping for ever. Someone who really wants that makes several bookmarks and means it.
 */
export const MAX_BOOKMARK_MS = 24 * 3600_000
/** Before this there were no recordings, so a time here is a broken clock or a bad client. */
export const EARLIEST_MS = Date.parse('2000-01-01T00:00:00Z')
/** A camera clock may run a little fast; further ahead than this is not a real moment. */
export const FUTURE_SLACK_MS = 24 * 3600_000
/** The stretch kept around a bookmark when housekeeping decides what it may delete. */
export const DEFAULT_MARGIN_MS = 60_000
/** "<nvr>/<channel>", the camera key used everywhere else in the app. */
export const CAMERA_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/\d{1,4}$/

/** The fields a client may set. Anything else in a body is a mistake worth saying out loud. */
export const EDITABLE_FIELDS = Object.freeze(['cameras', 'startMs', 'endMs', 'title', 'description'])

const isInt = (x) => Number.isFinite(x) && Number.isSafeInteger(Math.round(x))
const bad = (error) => ({ ok: false, error, value: null })
/** A title is one line; a stray newline from a paste would break the list row it lands in. */
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim()
/** A description keeps its paragraphs but not its stray carriage returns or its trailing blank lines. */
const manyLines = (s) => String(s).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()

/**
 * A whole bookmark, checked and tidied.
 *
 * `now` is passed in rather than read from the clock so the same input always gives the same
 * answer in a test. The user is never taken from here: the server puts the signed-in name on,
 * because a client that could choose it could write a bookmark in someone else's name.
 *
 * @param {object} raw  { cameras, startMs, endMs, title, description }
 * @returns {{ ok: boolean, error: string|null,
 *             value: { cameras: string[], startMs: number, endMs: number, title: string, description: string }|null }}
 */
export function checkBookmark(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('A bookmark must be a JSON object')

  const list = raw.cameras
  if (!Array.isArray(list) || list.length === 0) return bad('A bookmark must name at least one camera')
  if (list.length > MAX_CAMERAS) return bad(`A bookmark can name at most ${MAX_CAMERAS} cameras`)
  const cameras = []
  for (const key of list) {
    if (typeof key !== 'string' || !CAMERA_KEY_RE.test(key)) return bad(`"${String(key).slice(0, 40)}" is not a camera ("<nvr>/<channel>")`)
    if (!cameras.includes(key)) cameras.push(key)
  }
  cameras.sort()

  const startMs = Number(raw.startMs)
  const endMs = Number(raw.endMs)
  if (!isInt(startMs) || !isInt(endMs)) return bad('The start and end must be times in milliseconds')
  const start = Math.round(startMs)
  const end = Math.round(endMs)
  if (end < start) return bad('The end of a bookmark cannot be before its start')
  if (end - start > MAX_BOOKMARK_MS) return bad(`A bookmark cannot be longer than ${MAX_BOOKMARK_MS / 3600_000} hours`)
  if (start < EARLIEST_MS) return bad('That start time is before any recording exists')
  if (end > now + FUTURE_SLACK_MS) return bad('A bookmark cannot be in the future')

  const title = oneLine(raw.title ?? '')
  if (!title) return bad('A bookmark needs a title')
  if (title.length > MAX_TITLE) return bad(`The title can be at most ${MAX_TITLE} characters`)

  const description = raw.description === undefined || raw.description === null ? '' : raw.description
  if (typeof description !== 'string') return bad('The description must be text')
  const notes = manyLines(description)
  if (notes.length > MAX_DESCRIPTION) return bad(`The description can be at most ${MAX_DESCRIPTION} characters`)

  return { ok: true, error: null, value: { cameras, startMs: start, endMs: end, title, description: notes } }
}

/**
 * The fields of a change, checked for shape only: an empty change and an unknown field are both
 * mistakes worth naming, and the result is merged onto the stored bookmark and checked in full
 * before anything is saved. Doing it the other way round — validating the change on its own — cannot
 * see that moving only the start put it after the end.
 * @returns {{ ok: boolean, error: string|null, value: object|null }}
 */
export function checkPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('A change must be a JSON object')
  const keys = Object.keys(raw)
  const unknown = keys.find((k) => !EDITABLE_FIELDS.includes(k))
  if (unknown !== undefined) return bad(`"${unknown.slice(0, 40)}" cannot be changed (only ${EDITABLE_FIELDS.join(', ')})`)
  if (keys.length === 0) return bad('Nothing to change')
  return { ok: true, error: null, value: Object.fromEntries(keys.map((k) => [k, raw[k]])) }
}

/**
 * May this person edit or delete this bookmark? Admins may touch any; everyone else only their own.
 * The page uses this to decide which buttons to draw, and the server decides again for itself —
 * a hidden button is a courtesy, not a permission.
 */
export function canEdit(bookmark, { user = null, admin = false } = {}) {
  if (admin) return true
  return Boolean(user) && bookmark?.user === user
}

/**
 * The bookmarks a filter keeps, newest-first order left to the caller.
 * `text` matches the title, the description or the user, case-insensitively; `from`/`to` keep the
 * bookmarks overlapping that stretch (not only those wholly inside it, or a search for an hour
 * would lose the bookmark that straddles it); `camera` keeps those naming that camera.
 */
export function filterBookmarks(list, { text = '', fromMs = null, toMs = null, camera = null } = {}) {
  const needle = String(text ?? '').trim().toLowerCase()
  const from = Number.isFinite(fromMs) ? Number(fromMs) : null
  const to = Number.isFinite(toMs) ? Number(toMs) : null
  return (list ?? []).filter((b) => {
    if (!b) return false
    if (from !== null && b.endMs < from) return false
    if (to !== null && b.startMs > to) return false
    if (camera && !(b.cameras ?? []).includes(camera)) return false
    if (needle) {
      const hay = `${b.title ?? ''}\n${b.description ?? ''}\n${b.user ?? ''}`.toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })
}

/** Oldest first, and by id when two start at the same millisecond, so a redraw never reshuffles. */
export function sortBookmarks(list) {
  return [...(list ?? [])].sort((a, b) => a.startMs - b.startMs || (a.id ?? 0) - (b.id ?? 0))
}

/**
 * Where each bookmark's diamond goes on the timeline: `[{ id, ms, leftPct, widthPct, endPct, title }]`,
 * left to right, with anything wholly outside the window dropped so nothing off-screen is drawn.
 *
 * The diamond marks the START, clamped into the window so a bookmark running in from before the
 * left edge still shows a mark you can click; `ms` is the bookmark's true start, which is what a
 * click should seek to, and it can therefore be outside the window — a caller that seeks to the
 * mark's position instead of to `ms` lands in the wrong place.
 *
 * `widthPct` is the clipped stretch, for a faint band behind the diamond. A bookmark of a single
 * moment has no width at all, so it is zero and the band is simply not drawn.
 *
 * @param {{ startMs: number, spanMs: number }} view  a window from pb-view.js makeView
 */
export function bookmarkMarkers(view, bookmarks) {
  const start = Number(view?.startMs)
  const span = Number(view?.spanMs)
  if (!Number.isFinite(start) || !Number.isFinite(span) || span <= 0) return []
  const end = start + span
  const pct = (t) => ((t - start) / span) * 100
  const out = []
  for (const b of sortBookmarks(bookmarks)) {
    const s = Number(b?.startMs)
    const e = Number(b?.endMs)
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue
    if (e < start || s > end) continue
    const left = Math.min(Math.max(pct(s), 0), 100)
    const right = Math.min(Math.max(pct(e), 0), 100)
    out.push({ id: b.id ?? null, ms: s, endMs: e, leftPct: left, endPct: right, widthPct: Math.max(0, right - left), title: b.title ?? '', user: b.user ?? null })
  }
  return out
}

/**
 * Stretches merged into the fewest that cover the same time, each grown by `marginMs` at both ends
 * first. This is what protects footage: a bookmark of the moment itself is no use if housekeeping
 * deletes the minute leading up to it, which is usually the minute that explains it.
 *
 * Pure, and separate from the database lookup in bookmarks.mjs, so the merging can be tried on
 * awkward input — touching ranges, one inside another, ranges out of order — without a DB at all.
 *
 * @param {Array<{ startMs: number, endMs: number }>} ranges
 * @returns {Array<[number, number]>} oldest first, none overlapping another
 */
export function mergeProtected(ranges, marginMs = DEFAULT_MARGIN_MS) {
  const margin = Number.isFinite(marginMs) && marginMs > 0 ? Math.round(marginMs) : 0
  const spans = []
  for (const r of ranges ?? []) {
    const s = Number(r?.startMs)
    const e = Number(r?.endMs)
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue
    spans.push([Math.round(Math.min(s, e)) - margin, Math.round(Math.max(s, e)) + margin])
  }
  spans.sort((a, b) => a[0] - b[0])
  const out = []
  for (const [s, e] of spans) {
    const last = out.at(-1)
    // touching counts as overlapping: two ranges that meet exactly are one stretch, not two
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/** Does [fromMs, toMs] touch any of these protected stretches? (Housekeeping: "may I delete this file?") */
export function isProtected(protectedRangesList, fromMs, toMs) {
  const from = Number(fromMs)
  const to = Number(toMs)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false
  return (protectedRangesList ?? []).some(([s, e]) => to >= s && from <= e)
}

/** How long a bookmark runs, for the list: "a moment", "45 s", "12 min", "2 h 5 min". */
export function spanText(startMs, endMs) {
  const ms = Number(endMs) - Number(startMs)
  if (!Number.isFinite(ms) || ms <= 0) return 'a moment'
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs} s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min`
  return `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}`
}
