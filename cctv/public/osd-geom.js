// The maths and rules of placing a camera's burnt-in OSD (osd-panel.js): the camera's own
// position grid, which fields a Save would change, the words for the confirm dialog, and the name
// rule checked here as well so a bad name is caught before it reaches the camera. Pure (no DOM),
// so the node tests (test/osd-geom.test.mjs) run it exactly as the browser does.
//
// The camera carries TWO independently placed overlays (osd-doc.mjs): the clock (time) and the
// channel name (chlName), each with its own on/off switch and X/Y position. Position is the
// camera's own whole numbers 0..10000 across the picture's width and down its height, origin
// top-left, Y down (the camera reports min/max on every X/Y; osd-doc.mjs enforces the same range
// on the server). It is NOT pixels, so the same spot holds when the resolution changes.
//
// The server writes only the fields that changed, block by block, and reads them back; this module
// decides which those are and mirrors osd-doc.mjs's name rule, so the panel never sends what the
// server would refuse. changedFields()'s output is exactly the POST body shape osd.mjs takes.

export const OSD_MIN = 0
export const OSD_MAX = 10000
/** The longest a name may be (osd-doc.mjs), so it fits the picture. */
export const NAME_MAX = 32
/** The two overlays, as the model and the POST body name them. */
export const OVERLAYS = ['name', 'time']

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** A fraction of the picture (0..1, a drag past the edge stops at it) as a whole camera unit. */
export function toUnits(frac, max = OSD_MAX) {
  const f = Number(frac)
  if (!Number.isFinite(f)) return 0
  return Math.round(clamp(f, 0, 1) * max)
}

/** A camera unit as a fraction of the picture (held to 0..1 so a stray value never draws off-picture). */
export function toFrac(units, max = OSD_MAX) {
  const n = Number(units)
  if (!Number.isFinite(n)) return 0
  return clamp(n, 0, max) / max
}

/** Whether an overlay (name or time) has a position to drag: both X and Y read as numbers. */
export const overlayHasPosition = (block) => Number.isFinite(block?.x) && Number.isFinite(block?.y)

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

const round = (v) => (Number.isFinite(v) ? Math.round(v) : null)

/** A draft the panel keeps while the admin works (a copy: the camera's reading is untouched). */
export function draftOf(osd) {
  const t = osd?.time ?? {}
  const n = osd?.name ?? {}
  return {
    name: { show: n.show === true, x: round(n.x), y: round(n.y), text: n.text ?? '' },
    time: { show: t.show === true, x: round(t.x), y: round(t.y), dateFormat: t.dateFormat ?? null, timeFormat: t.timeFormat ?? null }
  }
}

/** Whether an overlay was moved (either axis differs by a whole unit from the camera's reading). */
export function overlayMoved(block, draftBlock) {
  if (!Number.isFinite(draftBlock?.x) || !Number.isFinite(draftBlock?.y)) return false
  return round(draftBlock.x) !== round(block?.x) || round(draftBlock.y) !== round(block?.y)
}

/**
 * What a Save would send: only the fields that differ from the camera's reading, in the shape the
 * POST route takes ({ name?: { text?, show?, x?, y? }, time?: { show?, x?, y?, dateFormat?,
 * timeFormat? } }). A block with no change is left out entirely; {} when nothing changed. A name
 * that fails nameError is left out (the panel disables Save then), never sent to be refused.
 */
export function changedFields(osd, draft) {
  const out = {}
  const n = {}
  const on = osd?.name ?? {}
  if (String(draft.name.text) !== String(on.text ?? '') && !nameError(draft.name.text)) n.text = String(draft.name.text)
  if ((draft.name.show === true) !== (on.show === true)) n.show = draft.name.show === true
  if (Number.isFinite(draft.name.x) && round(draft.name.x) !== round(on.x)) n.x = clamp(round(draft.name.x), OSD_MIN, OSD_MAX)
  if (Number.isFinite(draft.name.y) && round(draft.name.y) !== round(on.y)) n.y = clamp(round(draft.name.y), OSD_MIN, OSD_MAX)
  if (Object.keys(n).length) out.name = n

  const tm = {}
  const ot = osd?.time ?? {}
  if ((draft.time.show === true) !== (ot.show === true)) tm.show = draft.time.show === true
  if (Number.isFinite(draft.time.x) && round(draft.time.x) !== round(ot.x)) tm.x = clamp(round(draft.time.x), OSD_MIN, OSD_MAX)
  if (Number.isFinite(draft.time.y) && round(draft.time.y) !== round(ot.y)) tm.y = clamp(round(draft.time.y), OSD_MIN, OSD_MAX)
  if (draft.time.dateFormat != null && draft.time.dateFormat !== ot.dateFormat) tm.dateFormat = draft.time.dateFormat
  if (draft.time.timeFormat != null && draft.time.timeFormat !== ot.timeFormat) tm.timeFormat = draft.time.timeFormat
  if (Object.keys(tm).length) out.time = tm
  return out
}

/**
 * The fields of `want` ({ name?: {...}, time?: {...} }) that the camera, as read back, does not
 * have. Asked of the values from before a Save it gives the fields that really changed (what an
 * Undo has to put back); asked of an Undo's own values, the ones still to put back. A camera that
 * could not be read back holds nothing as far as anyone knows, so every field is returned.
 */
export function fieldsNotHeld(want, after) {
  const out = {}
  for (const [block, fields] of Object.entries(want ?? {})) {
    const o = {}
    for (const [k, v] of Object.entries(fields)) if (after?.[block]?.[k] !== v) o[k] = v
    if (Object.keys(o).length) out[block] = o
  }
  return out
}

/** How many fields a Save would change, across both overlays. */
export function changeCount(osd, draft) {
  const ch = changedFields(osd, draft)
  return Object.values(ch).reduce((s, b) => s + Object.keys(b).length, 0)
}

/**
 * What a Save would change, one line each in plain words: the Save button counts them, the
 * confirmation dialog lists them (it is burnt into every recording from now on). [] when nothing
 * changed.
 */
export function changeSummary(osd, draft) {
  const out = []
  const onOff = (v) => (v ? 'on' : 'off')
  const ch = changedFields(osd, draft)
  if (ch.name) {
    const o = osd?.name ?? {}
    if ('text' in ch.name) out.push(`Name text: ${o.text ? `"${o.text}"` : '(none)'} → "${ch.name.text}"`)
    if ('show' in ch.name) out.push(`Show name: ${onOff(o.show)} → ${onOff(ch.name.show)}`)
    if ('x' in ch.name || 'y' in ch.name) out.push(`Name position: ${posText(o)} → ${ch.name.x ?? o.x},${ch.name.y ?? o.y}`)
  }
  if (ch.time) {
    const o = osd?.time ?? {}
    if ('show' in ch.time) out.push(`Show clock: ${onOff(o.show)} → ${onOff(ch.time.show)}`)
    if ('x' in ch.time || 'y' in ch.time) out.push(`Clock position: ${posText(o)} → ${ch.time.x ?? o.x},${ch.time.y ?? o.y}`)
    if ('dateFormat' in ch.time) out.push(`Date format: ${o.dateFormat ?? '(none)'} → ${ch.time.dateFormat}`)
    if ('timeFormat' in ch.time) out.push(`Clock: ${o.timeFormat ?? '(none)'}-hour → ${ch.time.timeFormat}-hour`)
  }
  return out
}

const posText = (block) => (overlayHasPosition(block) ? `${block.x},${block.y}` : 'not set')

/** "Save", "Save 1 change", "Save 3 changes". */
export const saveLabel = (n) => (n ? `Save ${n} change${n === 1 ? '' : 's'}` : 'Save')

/** How far in from each edge a preset corner sits (units), so the text is not clipped at the edge. */
export const CORNER_INSET = 200
/** The preset corners, for quick placement. Y down, so "top" is the small Y. */
export const CORNERS = [
  { id: 'top-left', label: 'Top left', x: CORNER_INSET, y: CORNER_INSET },
  { id: 'top-right', label: 'Top right', x: OSD_MAX - CORNER_INSET, y: CORNER_INSET },
  { id: 'bottom-left', label: 'Bottom left', x: CORNER_INSET, y: OSD_MAX - CORNER_INSET },
  { id: 'bottom-right', label: 'Bottom right', x: OSD_MAX - CORNER_INSET, y: OSD_MAX - CORNER_INSET }
]

/** Which preset corner a position sits nearest, for highlighting; null when there is no position. */
export function nearestCorner(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  let best = null
  for (const c of CORNERS) {
    const d = Math.hypot(c.x - x, c.y - y)
    if (!best || d < best.d) best = { id: c.id, d }
  }
  return best?.id ?? null
}
