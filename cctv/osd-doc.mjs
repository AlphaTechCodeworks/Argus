// The OSD documents and the rules about them, with nothing that touches the NVR.
//
// Split out of osd.mjs for the reason that keeps proving itself in this codebase: that module
// reaches the NVR through nvr-xml.mjs, which loads the Linux SDK, so nothing in it can be run on a
// development PC. The clock sync sent a malformed request for weeks precisely because the code
// that built it could not be tested. Document building and validation are the parts most worth
// testing here -- a write that drops a field wipes it on a real camera, for ever.
import { XML_HEADER, esc, kid, parseXml } from './xml.mjs'

/** Carries an HTTP status so the route can answer properly, without dragging in nvr-xml.mjs. */
export class OsdError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
const HttpError = OsdError

/** The channel-addressing shape the picture settings already use successfully on these NVRs. */
export const osdRequest = (chlId) => `${XML_HEADER}<condition><chlId>${esc(chlId)}</chlId></condition></request>`

/**
 * Request shapes to try, in order, when we do not yet know which one this firmware wants.
 * Read-only: every one of these is a query, and none of them changes anything.
 */
export function probeShapes(chlId) {
  const cond = `<condition><chlId>${esc(chlId)}</chlId></condition>`
  // Second round, after the first told us something useful. Naming the channel six different ways
  // changed nothing: solus answered every one of them with 536870923, which is the same code
  // queryDiskSmartInfo gives when it has not been told what to fetch. nvr1 answered a different
  // code again (536871059) to all six, so that firmware does not support the command at all --
  // one probe, two quite different conclusions, which is why it was worth running on both.
  //
  // So the missing piece is probably not the channel but the fields. queryNodeEncodeInfo, which
  // works on these NVRs every day, asks with a <requireField> block and no condition at all. These
  // shapes copy that, starting with the field names that command already uses successfully, then
  // trying the ones an OSD would plausibly carry.
  return [
    ['requireField, no condition, names that already work elsewhere', `${XML_HEADER}<requireField><name/><chlType/></requireField></request>`],
    ['requireField + condition, same names', `${XML_HEADER}${cond}<requireField><name/><chlType/></requireField></request>`],
    ['requireField: name only', `${XML_HEADER}<requireField><name/></requireField></request>`],
    ['requireField: osd', `${XML_HEADER}<requireField><osd/></requireField></request>`],
    ['requireField: switch and position', `${XML_HEADER}<requireField><switch/><X/><Y/></requireField></request>`],
    ['requireField: displayInfo', `${XML_HEADER}<requireField><displayInfo/><name/></requireField></request>`],
    ['condition/chlId alone (round one, kept so the two runs can be compared)', osdRequest(chlId)],
    ['no body at all', `${XML_HEADER}</request>`]
  ]
}

const text = (n) => (n?.text ?? '').trim()
const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const n = Number(String(v).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** The <response>, or a thrown error when the answer is not one at all. */
function answerOf(xml) {
  const response = kid(parseXml(xml), 'response')
  if (!response) throw new HttpError(502, 'the NVR did not answer with a response document')
  return { response, status: text(kid(response, 'status')), errorCode: text(kid(response, 'errorCode')) }
}

/** Every element of that name anywhere in the tree: firmware nests these differently. */
function findAll(node, name, out = []) {
  for (const c of node.children ?? []) {
    if (c.name === name) out.push(c)
    findAll(c, name, out)
  }
  return out
}

/**
 * What a camera is showing. Deliberately forgiving about field names, and honest about what it
 * could not find: a position we did not read comes back null and is shown as "not available",
 * never as 0,0 -- which would look like a real corner of the picture.
 * @returns {{ ok: boolean, errorCode: string, osd: object|null }}
 */
export function parseOsd(xml) {
  const { response, status, errorCode } = answerOf(xml)
  if (status && status !== 'success') return { ok: false, errorCode: errorCode || status, osd: null }
  const c = kid(response, 'content') ?? response
  const first = (names) => {
    for (const n of names) {
      const hit = findAll(c, n)[0]
      if (hit && text(hit) !== '') return text(hit)
    }
    return null
  }
  // The position may be a pair of numbers, or an X and Y under a point/position element.
  const point = findAll(c, 'position')[0] ?? findAll(c, 'point')[0] ?? c
  const onOff = (v) => (v === null ? null : /^(true|1|on|yes)$/i.test(v))
  return {
    ok: true,
    errorCode: '',
    osd: {
      name: first(['name', 'osdName', 'chlName', 'displayName']),
      showName: onOff(first(['nameSwitch', 'showName', 'displayNameSwitch', 'chlNameSwitch'])),
      showTime: onOff(first(['timeSwitch', 'showTime', 'displayTimeSwitch', 'dateSwitch'])),
      x: num(text(kid(point, 'X')) || text(kid(point, 'x')) || first(['posX', 'xCoordinate'])),
      y: num(text(kid(point, 'Y')) || text(kid(point, 'y')) || first(['posY', 'yCoordinate'])),
      dateFormat: first(['dateFormat']),
      timeFormat: first(['timeFormat'])
    }
  }
}

/** What a change may set, and what each one has to look like. */
export function checkWanted(want) {
  const out = {}
  if (want.name !== undefined) {
    const n = String(want.name)
    // Burnt into every frame from here on, so a name that would be cut off or would carry markup
    // into the picture is refused rather than trimmed silently.
    if (!n.trim()) throw new HttpError(400, 'the camera name cannot be empty')
    if (n.length > 32) throw new HttpError(400, 'the camera name must be 32 characters or fewer')
    if (/[<>&]/.test(n)) throw new HttpError(400, 'the camera name cannot contain < > or &')
    out.name = n
  }
  if (want.showName !== undefined) out.showName = want.showName === true
  if (want.showTime !== undefined) out.showTime = want.showTime === true
  for (const k of ['x', 'y']) {
    if (want[k] === undefined) continue
    const v = Number(want[k])
    // These NVRs place the overlay on a 0-9999 grid across the picture, not in pixels, so the
    // same position holds when the resolution changes.
    if (!Number.isFinite(v) || v < 0 || v > 9999) throw new HttpError(400, `${k} must be between 0 and 9999`)
    out[k] = Math.round(v)
  }
  if (!Object.keys(out).length) throw new HttpError(400, 'nothing to change')
  return out
}

/**
 * The document to send: everything read back as it was, with only what was asked for changed.
 * Built from the raw answer rather than from the parsed view, because anything this module did not
 * understand still has to go back untouched -- these NVRs replace the whole block.
 */
export function buildEdit(rawXml, chlId, wanted) {
  const inner = /<content[^>]*>([\s\S]*)<\/content>/i.exec(rawXml)?.[1]
  if (!inner) throw new HttpError(502, 'the NVR\'s answer had no content to build on; nothing was changed')
  let out = inner
  const swap = (tag, value) => {
    const re = new RegExp(`(<${tag}(?:\\s[^>]*)?>)(?:<!\\[CDATA\\[)?[^<]*(?:\\]\\]>)?(</${tag}>)`, 'i')
    if (re.test(out)) out = out.replace(re, `$1${value}$2`)
  }
  if (wanted.name !== undefined) for (const t of ['name', 'osdName', 'chlName']) swap(t, `<![CDATA[${esc(wanted.name)}]]>`)
  if (wanted.showName !== undefined) for (const t of ['nameSwitch', 'showName', 'chlNameSwitch']) swap(t, wanted.showName ? 'true' : 'false')
  if (wanted.showTime !== undefined) for (const t of ['timeSwitch', 'showTime', 'dateSwitch']) swap(t, wanted.showTime ? 'true' : 'false')
  if (wanted.x !== undefined) { swap('X', String(wanted.x)); swap('x', String(wanted.x)) }
  if (wanted.y !== undefined) { swap('Y', String(wanted.y)); swap('y', String(wanted.y)) }
  return `${XML_HEADER}<content>${out}</content></request>`
}

