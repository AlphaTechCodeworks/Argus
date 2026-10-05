// Multi-camera playback without a screen: the camera list and its search, the fixed 2x2 / 3x3 grids
// and which cameras are on the page now, the saved views a user keeps, which timeline lanes to draw,
// what a view exports, and — the part that matters most on a real site — the rule that decides when a
// tile is allowed to open a stream and when it must stop.
//
// No DOM and nothing imported from node, so the same rules run in the browser (public/wall.js) and on
// the server (views.mjs), exactly as bookmarks-view.js is shared with bookmarks.mjs. A view the page
// accepts and the server refuses, or the other way round, is a bug nobody can explain from either end.
//
// Times are absolute milliseconds, the same base as pb-view.js, pb-sources.js and wall-clock.js.
// Tested offline: test/grid-view.test.mjs.
//
// ---- why the opening rules are here and not sprinkled through the page -------------------------
//
// An NVR shares one fixed bandwidth budget between recording to its own disk and serving streams to
// us. On 2026-09-25 nvr-2 was at 128 Mb of its 192 Mb budget and simply refusing new streams, and
// eleven of its cameras had recorded nothing at all as a result (see stream-choice.mjs). A 3x3 grid
// of playback streams is nine more requests against that same budget, all at once, every time
// somebody seeks. Opened carelessly this page could take a site off the air — not just make itself
// slow. So the arithmetic that paces the opening, stops streams nobody is looking at, and backs off
// after a refusal lives in one pure module where it can be read and tested, rather than in event
// handlers where nobody would ever find it.

/** A camera key, "<nvr id>/<channel>" — the same rule as wall-clock.js and user-prefs.mjs. */
export const KEY_RE = /^[A-Za-z0-9._-]{1,64}\/\d{1,4}$/

/** The grids offered on the Wall. 'auto' is the old behaviour: as many columns as fit the space.
 *  The rest are NxN; slotsOf/colsOf read the number off the name, so adding one needs no other change. */
export const LAYOUTS = Object.freeze(['auto', '2x2', '3x3', '4x4', '5x5', '6x6', '8x8', '10x10', '12x12'])

/** The live grid's own layout ids (viewer.js): square grids and the "featured" big-tile arrangements.
 *  A view saved on the live page carries one of these; checkView accepts them so the same saved-views
 *  store serves both pages. The Wall falls back to a fitting grid for an id it does not draw. */
export const LIVE_LAYOUTS = Object.freeze(['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g8', 'g10', 'g12', '1+5', '1+7', '1+12', '2+8'])

/** The most cameras one saved view may hold. Enough to fill the largest grid (12x12 = 144). */
export const MAX_VIEW_CAMERAS = 144
/** A view's name is a line in a menu, not a paragraph. */
export const MAX_VIEW_NAME = 60
/** Enough views for a working site; a guard against a runaway client filling the preferences file. */
export const MAX_VIEWS = 50

/** export-job.mjs refuses more than this in one job, so the page must not offer more. */
export const MAX_EXPORT_CLIPS = 32

/**
 * How long the page waits between opening one tile's stream and the next. Nine streams asked for in
 * the same tick is exactly the burst an NVR at its ceiling refuses, and a refused stream is not a
 * slow tile, it is a black one. Spacing them lets the earlier tiles' bitrate be measured by the NVR
 * before the later ones are asked for, and lets a viewer who is only glancing at the grid move on
 * before the whole of it has been opened at all.
 */
export const OPEN_STAGGER_MS = 700

/** How many tiles may be waiting for their first picture at once. One at a time, deliberately. */
export const MAX_OPENING = 1

/** The first wait after a refusal, doubling each time. */
export const BACKOFF_BASE_MS = 5000
/**
 * The longest wait after repeated refusals. Five minutes, matching the recorder's own backoff: an
 * NVR that has said no four times running is full, and asking it again every few seconds is how the
 * page turns one person's grid into everybody's missing footage.
 */
export const BACKOFF_MAX_MS = 5 * 60_000

const num = (x, fallback = 0) => (Number.isFinite(x) ? Number(x) : fallback)
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

// ---- the camera list -------------------------------------------------------------------------

/**
 * The cameras matching what someone typed. Every word must match somewhere in the camera's name, its
 * NVR's name, its site or its channel number — so "yard 3" finds channel 3 in the yard, and the order
 * of the words does not matter, because nobody remembers which way round a list was written.
 *
 * Channel numbers are matched as the viewer sees them (1-based, the way every page labels them) as
 * well as the stored 0-based number, since a search for "1" that skipped the camera labelled 1 would
 * simply look broken.
 *
 * @param {Array<{nvr?:string, ch?:number, name?:string, nvrName?:string, site?:string}>} cameras
 * @param {string} query
 */
export function searchCameras(cameras, query) {
  const words = oneLine(query).toLowerCase().split(' ').filter(Boolean)
  const list = (cameras ?? []).filter(Boolean)
  if (words.length === 0) return list
  return list.filter((c) => {
    const hay = [c.name, c.nvrName, c.site, c.nvr, String(num(c.ch, 0) + 1), String(num(c.ch, 0))]
      .map((x) => String(x ?? '').toLowerCase())
      .join(' ')
    return words.every((w) => hay.includes(w))
  })
}

/** Cameras grouped for a picker: "<site> · <NVR>" in the order they first appear. */
export function groupCameras(cameras) {
  const out = new Map()
  for (const c of (cameras ?? []).filter(Boolean)) {
    const label = [c.site, c.nvrName ?? c.nvr].filter(Boolean).join(' · ') || 'Cameras'
    if (!out.has(label)) out.set(label, [])
    out.get(label).push(c)
  }
  return [...out].map(([label, list]) => ({ label, cameras: list }))
}

// ---- the grid --------------------------------------------------------------------------------

/** How many tiles a layout shows at once; 0 for 'auto', which shows everything chosen. */
export function slotsOf(layout) {
  const m = /^(\d+)x(\d+)$/.exec(String(layout))
  if (m) return Number(m[1]) * Number(m[2])
  return 0
}

/** The column count for a layout, for the CSS variable the grid is drawn with. */
export function colsOf(layout, count) {
  const m = /^(\d+)x(\d+)$/.exec(String(layout))
  if (m) return Number(m[1])
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, num(count, 1)))))
}

/**
 * Which cameras are actually on screen, and how many pages the choice makes at this layout.
 *
 * Paging rather than shrinking is the whole bandwidth argument in one function: a 2x2 view of twelve
 * cameras streams four, not twelve. The page number is clamped instead of wrapping, so removing a
 * camera cannot leave somebody staring at an empty page they did not ask for.
 *
 * @returns {{ keys: string[], page: number, pages: number, slots: number }}
 */
export function pageOf(keys, layout, page = 0) {
  const all = (keys ?? []).filter((k) => typeof k === 'string')
  const slots = slotsOf(layout)
  if (slots === 0) return { keys: all, page: 0, pages: 1, slots: all.length }
  const pages = Math.max(1, Math.ceil(all.length / slots))
  const p = Math.min(Math.max(0, Math.floor(num(page, 0))), pages - 1)
  return { keys: all.slice(p * slots, p * slots + slots), page: p, pages, slots }
}

/** A sensible layout for a number of cameras, for a view saved before layouts existed. */
export function layoutFor(count) {
  const n = Math.max(0, Math.floor(num(count, 0)))
  if (n <= 4) return '2x2'
  if (n <= 9) return '3x3'
  if (n <= 16) return '4x4'
  if (n <= 25) return '5x5'
  if (n <= 36) return '6x6'
  if (n <= 64) return '8x8'
  if (n <= 100) return '10x10'
  return '12x12'
}

// ---- saved views -----------------------------------------------------------------------------

/**
 * A saved view, checked and tidied. Shared with the server so a name the page trims is the name the
 * server stores. The id is made by the caller (the page) and kept as given when it is well formed,
 * so a view edited on one screen stays the same view on another rather than becoming a second copy.
 *
 * @returns {{ ok: boolean, error: string|null,
 *             value: { id: string, name: string, cameras: string[], layout: string }|null }}
 */
export function checkView(raw, { known = null } = {}) {
  const bad = (error) => ({ ok: false, error, value: null })
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad('A view must be an object')
  const name = oneLine(raw.name)
  if (!name) return bad('A view needs a name')
  if (name.length > MAX_VIEW_NAME) return bad(`A view's name is at most ${MAX_VIEW_NAME} characters`)
  if (!Array.isArray(raw.cameras)) return bad('A view needs a list of cameras')
  const seen = new Set()
  const cameras = []
  for (const k of raw.cameras) {
    if (typeof k !== 'string' || !KEY_RE.test(k)) return bad(`"${String(k).slice(0, 40)}" is not a camera key ("<nvr>/<channel>")`)
    // A camera that no longer exists is dropped rather than refused: an NVR being removed must not
    // make every view that mentioned it unsaveable.
    if (known && !known.has(k)) continue
    if (seen.has(k)) continue
    seen.add(k)
    cameras.push(k)
  }
  if (cameras.length === 0) return bad('A view needs at least one camera')
  if (cameras.length > MAX_VIEW_CAMERAS) return bad(`A view holds at most ${MAX_VIEW_CAMERAS} cameras`)
  const layout = LAYOUTS.includes(raw.layout) || LIVE_LAYOUTS.includes(raw.layout) ? raw.layout : layoutFor(cameras.length)
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : null
  if (!id) return bad('A view needs an id')
  return { ok: true, error: null, value: { id, name, cameras, layout } }
}

/**
 * A whole list of views made safe: the bad ones dropped rather than the whole save refused, each id
 * once (a later duplicate wins, which is what an edit looks like), at most MAX_VIEWS.
 * @returns {{ views: Array, dropped: number }}
 */
export function normaliseViews(list, { known = null } = {}) {
  const byId = new Map()
  let dropped = 0
  for (const raw of Array.isArray(list) ? list : []) {
    const { ok, value } = checkView(raw, { known })
    if (!ok) {
      dropped++
      continue
    }
    byId.set(value.id, value)
  }
  const views = [...byId.values()]
  if (views.length > MAX_VIEWS) dropped += views.length - MAX_VIEWS
  return { views: views.slice(0, MAX_VIEWS), dropped }
}

/**
 * The stored shape of a user's views, versioned the way user-prefs.mjs versions the live grid's
 * order: the version counts the saves, and a save made on an older version is refused rather than
 * allowed to wipe one made on another screen.
 * @returns {{ saved: boolean, views: Array, version: number }}
 */
export function applyViews(current, change, { known = null } = {}) {
  const now = {
    views: normaliseViews(current?.views, { known }).views,
    version: Number.isSafeInteger(current?.version) && current.version >= 0 ? current.version : 0
  }
  if (!Number.isSafeInteger(change?.version) || change.version !== now.version) return { saved: false, ...now }
  return { saved: true, views: normaliseViews(change.views, { known }).views, version: now.version + 1 }
}

// ---- the timeline lanes ----------------------------------------------------------------------

/**
 * Which cameras get a lane on the timeline. Two honest answers to two different questions:
 *   'one' — "what has THIS camera got?", the single-camera playback page's lane, for the tile
 *           somebody is working on;
 *   'all' — "what has anything in this view got?", so a gap that is only on one camera stands out
 *           against the rest, which is how you tell "nothing happened" from "that camera was down".
 *
 * 'all' is limited to the cameras actually on the page, not everything in the view: a lane for a
 * camera on another page would be a promise the grid is not keeping.
 *
 * @param {'one'|'all'} mode
 * @param {Array<{key:string}>} onScreen the tiles on this page, in order
 * @param {string|null} focusKey the tile the toolbar is on, for 'one'
 */
export function laneSet(mode, onScreen, focusKey = null) {
  const tiles = (onScreen ?? []).filter((t) => t && typeof t.key === 'string')
  if (mode !== 'one') return tiles
  const one = tiles.find((t) => t.key === focusKey) ?? tiles[0]
  return one ? [one] : []
}

// ---- exporting a whole view ------------------------------------------------------------------

/**
 * The clips for POST /api/exports covering every camera in a view over one stretch — the same body
 * shape the single-camera playback page sends, because there is one export path and this is it
 * (export-api.mjs / export-job.mjs). The server refuses more than MAX_EXPORT_CLIPS, so a view larger
 * than that is cut here and the caller says so, rather than the whole export failing at the end.
 * @returns {{ clips: Array<{nvr:string, ch:number, fromMs:number, toMs:number}>, dropped: number, error: string|null }}
 */
export function exportClipsFor(keys, fromMs, toMs) {
  const from = Math.round(num(fromMs, NaN))
  const to = Math.round(num(toMs, NaN))
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return { clips: [], dropped: 0, error: 'Choose a stretch of time to export first.' }
  }
  const clips = []
  for (const k of keys ?? []) {
    if (typeof k !== 'string' || !KEY_RE.test(k)) continue
    const cut = k.lastIndexOf('/')
    clips.push({ nvr: k.slice(0, cut), ch: Number(k.slice(cut + 1)), fromMs: from, toMs: to })
  }
  if (clips.length === 0) return { clips: [], dropped: 0, error: 'There are no cameras in this view to export.' }
  const dropped = Math.max(0, clips.length - MAX_EXPORT_CLIPS)
  return { clips: clips.slice(0, MAX_EXPORT_CLIPS), dropped, error: null }
}

// ---- opening streams gently ------------------------------------------------------------------

/**
 * How long a tile waits before asking again after the NVR refused it. Doubling, capped, and never
 * zero: the failure this guards against is a loop of requests against an NVR that is already full,
 * which costs that NVR the bandwidth it needs to record and costs a site its footage.
 */
export function backoffMs(refusals, { base = BACKOFF_BASE_MS, max = BACKOFF_MAX_MS } = {}) {
  const n = Math.max(0, Math.floor(num(refusals, 0)))
  if (n === 0) return 0
  return Math.min(max, base * 2 ** (n - 1))
}

/** A tile's stream state after the NVR refused it: one more refusal, and told when it may try again. */
export function afterRefusal(s = {}, nowMs, opts) {
  const refusals = Math.max(0, Math.floor(num(s.refusals, 0))) + 1
  return { ...s, refusals, blockedUntil: num(nowMs, 0) + backoffMs(refusals, opts) }
}

/** A tile's stream state once pictures are arriving: refusals only mean anything in a row. */
export function afterVideo(s = {}) {
  return { ...s, refusals: 0, blockedUntil: 0 }
}

/** Whether a tile is allowed to ask for a stream at all yet. */
export function mayOpen(s = {}, nowMs) {
  return num(nowMs, 0) >= num(s.blockedUntil, 0)
}

/**
 * What the grid should do this tick: which tiles to stop, and the one tile (at most) to open.
 *
 * Opening is deliberately one tile at a time and no faster than OPEN_STAGGER_MS, so a 3x3 grid comes
 * up over about six seconds instead of firing nine simultaneous requests at NVRs that share one
 * bandwidth budget with their own recording. Stopping comes first and is never rate limited: a tile
 * that is off the page, behind a maximised tile or has nothing to show at this moment gives its
 * bandwidth back immediately, because that is bandwidth the NVR can spend on recording.
 *
 * @param {Array<{key:string, wants:boolean, streaming:boolean, opening:boolean, blockedUntil?:number}>} tiles
 *        `wants` is the page's answer to "should this tile be streaming at all" — on screen, not
 *        hidden behind a maximised tile, and with footage at this moment.
 * @param {number} nowMs
 * @param {{ lastOpenAt?: number, staggerMs?: number, maxOpening?: number }} o
 * @returns {{ close: string[], open: string|null, waiting: number }}
 */
export function openPlan(tiles, nowMs, { lastOpenAt = -Infinity, staggerMs = OPEN_STAGGER_MS, maxOpening = MAX_OPENING } = {}) {
  const list = (tiles ?? []).filter((t) => t && typeof t.key === 'string')
  const now = num(nowMs, 0)
  const close = list.filter((t) => !t.wants && (t.streaming || t.opening)).map((t) => t.key)
  const opening = list.filter((t) => t.wants && t.opening).length
  const wanted = list.filter((t) => t.wants && !t.streaming && !t.opening)
  const ready = wanted.filter((t) => mayOpen(t, now))
  // The count reported is every tile still to come, including ones serving out a backoff, because
  // "3 cameras waiting" is what the viewer needs to know; which of them is merely next is not.
  const waiting = wanted.length
  if (opening >= Math.max(1, maxOpening)) return { close, open: null, waiting }
  if (now - num(lastOpenAt, -Infinity) < Math.max(0, staggerMs)) return { close, open: null, waiting }
  return { close, open: ready[0]?.key ?? null, waiting }
}

/**
 * What to say about a grid that is still coming up, or that an NVR has refused. Said out loud
 * because the alternative is a viewer watching black squares and concluding the cameras are broken —
 * and then asking for more streams, which is the last thing a full NVR needs.
 */
export function openNote({ waiting = 0, refused = 0 } = {}) {
  if (refused > 0) {
    return {
      level: 'over',
      text: `${refused} ${refused === 1 ? 'camera was' : 'cameras were'} refused: the NVR has no bandwidth left for another playback. Waiting before asking again — show fewer cameras, or use HD (the server's own recordings), which asks the NVR for nothing.`
    }
  }
  if (waiting > 0) return { level: 'heavy', text: `Opening the cameras one at a time so the NVRs are not flooded — ${waiting} to go.` }
  return { level: 'ok', text: '' }
}
