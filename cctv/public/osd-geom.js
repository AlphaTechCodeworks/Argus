// The maths and rules of placing a camera's burnt-in OSD (osd-panel.js): the camera's own
// position grid, which fields a Save would change, the words for the confirm dialog, and the
// name rule checked here as well so a bad name is caught before it reaches the camera. Pure (no
// DOM), so the node tests (test/osd-geom.test.mjs) run it exactly as the browser does.
//
// Position is the camera's own: whole numbers 0..9999 across the picture's width and down its
// height, origin top-left, Y down (queryIPChlORChlOSD/editIPChlORChlOSD, osd-doc.mjs, which
// enforces the same 0..9999 on the server). It is NOT pixels, so the same spot holds when the
// resolution changes. A camera may not expose a position at all (parseOsd returns x/y null): then
// there is no free placement and the panel offers preset corners instead.
//
// The server writes only the fields that changed and reads them back; this module decides which
// those are and mirrors osd-doc.mjs checkWanted's name rule, so the panel never sends what the
// server would refuse.

/** The grid the overlay sits on: 0..OSD_MAX in each axis (osd-doc.mjs: 0 <= v <= 9999). */
export const OSD_MAX = 9999
/** The longest a name may be (osd-doc.mjs checkWanted), so it fits the picture. */
export const NAME_MAX = 32

/** Hold v to lo..hi. */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** A fraction of the picture (0..1, a drag past the edge stops at it) as a whole camera unit. */
export function toUnits(frac) {
  const f = Number(frac)
  if (!Number.isFinite(f)) return 0
  return Math.round(clamp(f, 0, 1) * OSD_MAX)
}

/** A camera unit as a fraction of the picture (held to 0..1 so a stray value never draws off-picture). */
export function toFrac(units) {
  const n = Number(units)
  if (!Number.isFinite(n)) return 0
  return clamp(n, 0, OSD_MAX) / OSD_MAX
}

/**
 * Whether the camera exposes a free X/Y position to drag (both read as numbers), rather than only
 * letting the name be shown or hidden. A camera that reports no position has x/y null (parseOsd
 * never invents 0,0), and the panel shows preset corners instead.
 */
export const hasFreePosition = (osd) => Number.isFinite(osd?.x) && Number.isFinite(osd?.y)

/**
 * The name rule, the same one the server applies (osd-doc.mjs checkWanted), checked here so the
 * Save button can refuse a bad name at once with the same words. null when the name is fine.
 */
export function nameError(name) {
  const n = String(name ?? '')
  if (!n.trim()) return 'the camera name cannot be empty'
  if (n.length > NAME_MAX) return `the camera name must be ${NAME_MAX} characters or fewer`
  if (/[<>&]/.test(n)) return 'the camera name cannot contain < > or &'
  return null
}

/** A draft the panel keeps while the admin works (a copy: the camera's reading is untouched). */
export function draftOf(osd) {
  return {
    name: osd?.name ?? '',
    showName: osd?.showName === true,
    showTime: osd?.showTime === true,
    x: Number.isFinite(osd?.x) ? Math.round(osd.x) : null,
    y: Number.isFinite(osd?.y) ? Math.round(osd.y) : null
  }
}

/** Whether the overlay was moved (either axis differs by a whole unit from the camera's reading). */
export function positionMoved(osd, draft) {
  if (!Number.isFinite(draft?.x) || !Number.isFinite(draft?.y)) return false
  return Math.round(draft.x) !== (Number.isFinite(osd?.x) ? Math.round(osd.x) : null) ||
    Math.round(draft.y) !== (Number.isFinite(osd?.y) ? Math.round(osd.y) : null)
}

/**
 * What a Save would send: only the fields that differ from the camera's reading, in the shape the
 * POST route takes ({ name?, showName?, showTime?, x?, y? }). The server writes changed fields
 * only and reads them back; this is the client's matching view. {} when nothing changed. A name
 * that fails nameError is left out (the panel disables Save then), never sent for the server to
 * refuse.
 */
export function changedFields(osd, draft) {
  const out = {}
  if (String(draft.name) !== String(osd?.name ?? '') && !nameError(draft.name)) out.name = String(draft.name)
  if (draft.showName === true !== (osd?.showName === true)) out.showName = draft.showName === true
  if (draft.showTime === true !== (osd?.showTime === true)) out.showTime = draft.showTime === true
  if (Number.isFinite(draft.x) && Math.round(draft.x) !== (Number.isFinite(osd?.x) ? Math.round(osd.x) : null)) out.x = clamp(Math.round(draft.x), 0, OSD_MAX)
  if (Number.isFinite(draft.y) && Math.round(draft.y) !== (Number.isFinite(osd?.y) ? Math.round(osd.y) : null)) out.y = clamp(Math.round(draft.y), 0, OSD_MAX)
  return out
}

/** How many fields a Save would change. */
export const changeCount = (osd, draft) => Object.keys(changedFields(osd, draft)).length

/**
 * What a Save would change, one line each in plain words: the Save button counts them, the
 * confirmation dialog lists them (it is burnt into every recording from now on). [] when nothing
 * changed.
 */
export function changeSummary(osd, draft) {
  const out = []
  const onOff = (v) => (v ? 'on' : 'off')
  const ch = changedFields(osd, draft)
  if ('name' in ch) out.push(`Name: ${osd?.name ? `"${osd.name}"` : '(none)'} → "${ch.name}"`)
  if ('showName' in ch) out.push(`Show name: ${onOff(osd?.showName)} → ${onOff(ch.showName)}`)
  if ('showTime' in ch) out.push(`Show time: ${onOff(osd?.showTime)} → ${onOff(ch.showTime)}`)
  if ('x' in ch || 'y' in ch) {
    const nx = 'x' in ch ? ch.x : osd?.x
    const ny = 'y' in ch ? ch.y : osd?.y
    const was = hasFreePosition(osd) ? `${osd.x},${osd.y}` : 'not set'
    out.push(`Position: ${was} → ${nx},${ny}`)
  }
  return out
}

/** "Save", "Save 1 change", "Save 3 changes". */
export const saveLabel = (n) => (n ? `Save ${n} change${n === 1 ? '' : 's'}` : 'Save')

/** How far in from each edge a preset corner sits (units), so the text is not clipped at the very edge. */
export const CORNER_INSET = 200
/**
 * The preset corners, for a camera that does not expose free X/Y (or for quick placement). Y down,
 * so "top" is the small Y. Values are clamped into the grid.
 */
export const CORNERS = [
  { id: 'top-left', label: 'Top left', x: CORNER_INSET, y: CORNER_INSET },
  { id: 'top-right', label: 'Top right', x: OSD_MAX - CORNER_INSET, y: CORNER_INSET },
  { id: 'bottom-left', label: 'Bottom left', x: CORNER_INSET, y: OSD_MAX - CORNER_INSET },
  { id: 'bottom-right', label: 'Bottom right', x: OSD_MAX - CORNER_INSET, y: OSD_MAX - CORNER_INSET }
]

/**
 * Which preset corner a position sits in, for highlighting the right button: the nearest corner by
 * straight distance, or null when there is no position to compare.
 */
export function nearestCorner(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  let best = null
  for (const c of CORNERS) {
    const d = Math.hypot(c.x - x, c.y - y)
    if (!best || d < best.d) best = { id: c.id, d }
  }
  return best?.id ?? null
}
