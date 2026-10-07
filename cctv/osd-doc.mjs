// The OSD documents and the rules about them, with nothing that touches the NVR.
//
// Split out of osd.mjs for the reason that keeps proving itself in this codebase: that module
// reaches the NVR through nvr-xml.mjs, which loads the Linux SDK, so nothing in it can be run on a
// development PC. The clock sync sent a malformed request for weeks precisely because the code
// that built it could not be tested. Document building and validation are the parts most worth
// testing here -- a write that drops a field wipes it on a real camera, for ever.
//
// THE REAL SHAPE (confirmed read-only on nvr-2 ch0 via the "requireField + condition" query):
// queryIPChlORChlOSD answers with a <types> list of the allowed date/time formats and a
// <content><chl id="..."> holding TWO independently placed overlays, each with its own on/off
// switch and X/Y on a 0..10000 grid (min/max carried on the X/Y elements):
//   <time>    <switch/> <X/> <Y/> <dateFormat/> <timeFormat/> </time>
//   <chlName> <switch/> <X/> <Y/> <name/> </chlName>
// so the model is two overlays, not the one name+position the first draft assumed. The builder
// edits each block in place and echoes everything else untouched, because these NVRs REPLACE the
// whole block rather than merging into it -- anything left out is wiped.
import { XML_HEADER, esc, kid, kids, parseXml } from './xml.mjs'

/** Carries an HTTP status so the route can answer properly, without dragging in nvr-xml.mjs. */
export class OsdError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
const HttpError = OsdError

/** The grid the overlays sit on: the camera reports min="0" max="10000" on every X/Y. */
export const GRID_MIN = 0
export const GRID_MAX = 10000
/** The longest a name may be, so it fits the picture. */
export const NAME_MAX = 32

/** The condition the picture settings and this read both use: name the channel. */
const condition = (chlId) => `<condition><chlId>${esc(chlId)}</chlId></condition>`
/**
 * The query shape the NVR actually accepts (confirmed): the channel named in a <condition>, plus a
 * <requireField> block (queryNodeEncodeInfo's shape, which works on these NVRs every day). The
 * channel-only shape the first draft used was refused.
 */
export const osdRequest = (chlId) => `${XML_HEADER}${condition(chlId)}<requireField><name/><chlType/></requireField></request>`

/**
 * Request shapes to try, in order, when confirming which one a firmware wants. Read-only: every
 * one is a query and none changes anything. The working shape (requireField + condition) is kept
 * first now that it is known.
 */
export function probeShapes(chlId) {
  const cond = condition(chlId)
  return [
    ['requireField + condition (the confirmed working shape)', osdRequest(chlId)],
    ['requireField, no condition', `${XML_HEADER}<requireField><name/><chlType/></requireField></request>`],
    ['condition/chlId alone (the first-draft shape, refused)', `${XML_HEADER}${cond}</request>`],
    ['no body at all', `${XML_HEADER}</request>`]
  ]
}

const text = (n) => (n?.text ?? '').trim()
const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const n = Number(String(v).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : null
}
const onOff = (v) => (v === null || v === '' ? null : /^(true|1|on|yes)$/i.test(v))

/** The <response>, or a thrown error when the answer is not one at all. */
function answerOf(xml) {
  const response = kid(parseXml(xml), 'response')
  if (!response) throw new HttpError(502, 'the NVR did not answer with a response document')
  return { response, status: text(kid(response, 'status')), errorCode: text(kid(response, 'errorCode')) }
}

/** Every element of that name anywhere in the tree (firmware nests these differently). */
function findAll(node, name, out = []) {
  for (const c of node.children ?? []) {
    if (c.name === name) out.push(c)
    findAll(c, name, out)
  }
  return out
}

/** One overlay block's state (time or chlName). Missing parts are null, never invented as 0/false. */
function parseBlock(b) {
  if (!b) return { show: null, x: null, y: null }
  return { show: onOff(text(kid(b, 'switch'))), x: num(text(kid(b, 'X')) || text(kid(b, 'x'))), y: num(text(kid(b, 'Y')) || text(kid(b, 'y'))) }
}

/**
 * What a camera is showing, as the two-overlay model. Forgiving about where things sit and honest
 * about what it could not find: a position it did not read is null (shown as "not available"),
 * never 0,0 -- which would look like a real corner of the picture.
 * @returns {{ ok: boolean, errorCode: string, osd: object|null }}
 */
export function parseOsd(xml) {
  const { response, status, errorCode } = answerOf(xml)
  if (status && status !== 'success') return { ok: false, errorCode: errorCode || status, osd: null }
  const content = kid(response, 'content') ?? response
  const chl = kid(content, 'chl') ?? findAll(content, 'chl')[0] ?? content
  const timeB = kid(chl, 'time') ?? findAll(chl, 'time')[0]
  const nameB = kid(chl, 'chlName') ?? findAll(chl, 'chlName')[0]

  const time = parseBlock(timeB)
  time.dateFormat = text(kid(timeB, 'dateFormat')) || null
  time.timeFormat = text(kid(timeB, 'timeFormat')) || null

  const name = parseBlock(nameB)
  // the displayed name: the first <name> under chlName (some firmware carries more than one line;
  // the extras are left untouched by the builder, so a write never drops them)
  const nameEl = kid(nameB, 'name') ?? (nameB ? findAll(nameB, 'name')[0] : null)
  name.text = nameEl ? (nameEl.text ?? '').trim() || null : null

  // the grid's bounds, from the min/max the camera carries on X/Y (default to the known 0..10000)
  const gx = kid(timeB, 'X') ?? kid(nameB, 'X') ?? findAll(chl, 'X')[0]
  const grid = { min: num(gx?.attrs?.min) ?? GRID_MIN, max: num(gx?.attrs?.max) ?? GRID_MAX }

  const t = kid(response, 'types')
  const enums = (n) => kids(kid(t, n), 'enum').map(text).filter(Boolean)
  const types = { dateFormat: enums('dateFormat'), timeFormat: enums('timeFormat') }

  return { ok: true, errorCode: '', osd: { chlId: chl?.attrs?.id ?? null, grid, time, name, types } }
}

/** A position on the grid, rounded and held to its bounds; throws when it is not a number. */
function checkPos(axis, v, grid) {
  const n = Number(v)
  const max = grid?.max ?? GRID_MAX
  const min = grid?.min ?? GRID_MIN
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${axis} must be between ${min} and ${max}`)
  return Math.round(n)
}

/**
 * What a change may set, and what each one has to look like. The change is the two-overlay shape:
 *   { name?: { text?, show?, x?, y? }, time?: { show?, x?, y?, dateFormat?, timeFormat? } }
 * Only the sub-fields given are returned, validated. `osd` (the camera's current reading) is
 * optional: when given, its grid bounds the positions and its <types> list bounds the formats.
 */
export function checkWanted(want, osd = null) {
  const grid = osd?.grid ?? { min: GRID_MIN, max: GRID_MAX }
  const out = {}
  if (want?.name && typeof want.name === 'object') {
    const n = {}
    if (want.name.text !== undefined) {
      const s = String(want.name.text)
      // Burnt into every frame from here on, so a name that would be cut off or carry markup into
      // the picture is refused rather than trimmed silently.
      if (!s.trim()) throw new HttpError(400, 'the camera name cannot be empty')
      if (s.length > NAME_MAX) throw new HttpError(400, `the camera name must be ${NAME_MAX} characters or fewer`)
      if (/[<>&]/.test(s)) throw new HttpError(400, 'the camera name cannot contain < > or &')
      n.text = s
    }
    if (want.name.show !== undefined) n.show = want.name.show === true
    if (want.name.x !== undefined) n.x = checkPos('x', want.name.x, grid)
    if (want.name.y !== undefined) n.y = checkPos('y', want.name.y, grid)
    if (Object.keys(n).length) out.name = n
  }
  if (want?.time && typeof want.time === 'object') {
    const tm = {}
    if (want.time.show !== undefined) tm.show = want.time.show === true
    if (want.time.x !== undefined) tm.x = checkPos('x', want.time.x, grid)
    if (want.time.y !== undefined) tm.y = checkPos('y', want.time.y, grid)
    for (const f of ['dateFormat', 'timeFormat']) {
      if (want.time[f] === undefined) continue
      const v = String(want.time[f])
      const allowed = osd?.types?.[f]
      // only check against the list when the camera told us one; an empty list is "not known"
      if (Array.isArray(allowed) && allowed.length && !allowed.includes(v)) throw new HttpError(400, `${f} must be one of: ${allowed.join(', ')}`)
      tm[f] = v
    }
    if (Object.keys(tm).length) out.time = tm
  }
  if (!Object.keys(out).length) throw new HttpError(400, 'nothing to change')
  return out
}

/** Within one block's XML, replace an element's inner text, keeping its tag and attributes. */
function swapIn(xml, tag, value) {
  const re = new RegExp(`(<${tag}(?:\\s[^>]*)?>)(?:<!\\[CDATA\\[)?[\\s\\S]*?(?:\\]\\]>)?(</${tag}>)`, 'i')
  // (a function, not a string: in a replacement string "$1", "$&" and "$$" in a camera's name are
  // taken as patterns, and "Lot $1" went to the NVR with the element's opening tag where "$1" was)
  return re.test(xml) ? xml.replace(re, (_m, open, close) => `${open}${value}${close}`) : xml
}

/** Apply a block's wanted fields to that block's XML substring. */
function editBlock(blockXml, wanted, { nameText = false } = {}) {
  let out = blockXml
  if (wanted.show !== undefined) out = swapIn(out, 'switch', wanted.show ? 'true' : 'false')
  if (wanted.x !== undefined) { out = swapIn(out, 'X', String(wanted.x)); out = swapIn(out, 'x', String(wanted.x)) }
  if (wanted.y !== undefined) { out = swapIn(out, 'Y', String(wanted.y)); out = swapIn(out, 'y', String(wanted.y)) }
  if (wanted.dateFormat !== undefined) out = swapIn(out, 'dateFormat', esc(wanted.dateFormat))
  if (wanted.timeFormat !== undefined) out = swapIn(out, 'timeFormat', esc(wanted.timeFormat))
  // the name: replace only the FIRST <name> (the displayed line), leaving any further lines alone
  if (nameText && wanted.text !== undefined) out = swapIn(out, 'name', esc(wanted.text))
  return out
}

/**
 * The document to send: everything read back as it was, with only what was asked for changed,
 * each field inside its own block. Built from the raw answer rather than the parsed view, because
 * anything this module did not understand still has to go back untouched -- these NVRs replace the
 * whole block.
 */
export function buildEdit(rawXml, wanted) {
  const inner = /<content[^>]*>([\s\S]*)<\/content>/i.exec(rawXml)?.[1]
  if (!inner) throw new HttpError(502, 'the NVR\'s answer had no content to build on; nothing was changed')
  let out = inner
  const editOne = (tag, w, opts) => {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'i')
    const m = re.exec(out)
    if (!m) return // the block is not there: nothing to change in it
    out = out.slice(0, m.index) + editBlock(m[0], w, opts) + out.slice(m.index + m[0].length)
  }
  if (wanted.time) editOne('time', wanted.time)
  if (wanted.name) editOne('chlName', wanted.name, { nameText: true })
  return `${XML_HEADER}<content>${out}</content></request>`
}

/** The read-back check: does the camera now report every field the change asked for? */
export function allApplied(wanted, after) {
  if (!after) return false
  for (const block of ['time', 'name']) {
    const w = wanted[block]
    if (!w) continue
    const got = after[block]
    if (!got) return false
    for (const [k, v] of Object.entries(w)) if (got[k] !== v) return false
  }
  return true
}
