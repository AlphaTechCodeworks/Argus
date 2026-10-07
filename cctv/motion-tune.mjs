// Motion tuning: reading what an NVR thinks "movement" means for one camera, and — only when
// somebody explicitly says so, camera by camera — changing it.
//
// Why this is treated as carefully as the clock: the motion threshold is not our setting. It is the
// owner's NVR, it decides what that NVR records in its motion schedule, and getting it wrong in
// either direction is expensive — too sensitive and a month of disk goes on a spider on the lens,
// too dull and the one night that mattered was never recorded. The whole point of the tuning view
// is to SHOW the current activity against the current threshold so the number is chosen from
// evidence rather than from a shrug. Nothing is written until somebody looks at that and agrees.
//
// The safety pattern is the one nvr-clock.mjs setClock proved:
//   - read the current settings immediately before writing
//   - send everything back exactly as read except the one value being changed: these NVRs replace
//     the whole block, so a partial write silently wipes whatever it does not mention. That is why
//     the edit document is built by substituting one number into the answer we just received,
//     rather than by composing a fresh document out of the fields we happen to know about
//   - one change at a time under the shared per-NVR change lock, so it cannot collide with a
//     picture, stream, lens or clock change
//   - read back and compare, rather than assume
//   - before and after appended to data/motion-changes.log
//   - `confirm: true` required, per camera, every time (checked in events.mjs handleEvents)
//
// If any step cannot be done honestly — the NVR does not report a sensitivity, or reports one we
// cannot locate in its own answer — nothing is sent and the caller is told why. This module never
// writes a value it did not first read back out of the NVR's own document.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { XML_HEADER, esc, kid, kids, parseXml } from './xml.mjs'

const LOG_FILE_NAME = 'motion-changes.log'
const READ_BACK_MS = 1500 // the NVR takes a moment before it reports the new value

/** The command names. Both are in the SDK library's own string table. */
export const QUERY_MOTION = 'queryMotion'
export const EDIT_MOTION = 'editMotion'

/**
 * Names the sensitivity has been seen under across this vendor's firmware and SDK. Forgiving on
 * purpose, the way nvr-disks.mjs is: firmware across these four NVRs is not uniform, and a field
 * that is not there must stay null rather than become a confident zero.
 */
export const SENSITIVITY_NAMES = Object.freeze(['sensitivity', 'level', 'threshold', 'sensitivityLevel'])
/** Names the hold/duration has been seen under, read only so the view can show it. */
export const HOLD_NAMES = Object.freeze(['holdTime', 'alarmHoldTime', 'duration'])

const text = (n) => (n?.text ?? '').trim()
const numOf = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(String(v).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** The first of `names` present on a node, as a child element or an attribute; null if none is. */
export function field(node, names) {
  for (const name of names) {
    const c = kid(node, name)
    if (c && text(c) !== '') return text(c)
    const a = node?.attrs?.[name]
    if (a !== undefined && String(a).trim() !== '') return String(a).trim()
  }
  return null
}

/**
 * The <chl> element for this channel id. Asked for a camera, it answers with that camera's block or
 * with nothing: the first block of an answer that does not hold the camera is another camera's, and
 * was shown as this one's. The one exception is a lone block that names no camera at all, which is
 * the answer to a question that named one (motionRequest). With no id asked for: the only block there
 * is, or the first.
 */
export function channelNode(xml, chlId = null) {
  const response = kid(parseXml(xml), 'response')
  const content = kid(response, 'content')
  if (!content) return null
  const all = [...kids(content, 'chl'), ...kids(content, 'item')]
  const list = all.length ? all : content.children
  if (chlId) {
    const idOf = (c) => String(c.attrs?.id ?? text(kid(c, 'id'))).trim().toUpperCase()
    const hit = list.find((c) => idOf(c) === String(chlId).toUpperCase())
    if (hit) return hit
    return list.length === 1 && idOf(list[0]) === '' ? list[0] : null
  }
  return list.length === 1 ? list[0] : (list[0] ?? null)
}

/**
 * What the NVR says about one camera's motion detection. Every field may be null: an NVR that does
 * not answer this command, or answers something we do not recognise, reports `available: false`
 * with a reason and the page prints "not available". It never reports a reassuring zero.
 */
export function readMotionAnswer(xml, chlId = null) {
  if (!xml || !/<response/i.test(xml)) return { available: false, why: 'the NVR did not answer queryMotion with a document' }
  const status = /<status>\s*([a-z]+)/i.exec(xml)?.[1]?.toLowerCase() ?? ''
  if (status && status !== 'success') {
    const code = /<errorCode>\s*(\d+)/.exec(xml)?.[1]
    return { available: false, why: `the NVR refused queryMotion (${status}${code ? `, code ${code}` : ''})` }
  }
  const chl = channelNode(xml, chlId)
  if (!chl && chlId && channelNode(xml)) return { available: false, why: 'the NVR’s answer did not include this camera, so there is nothing to show or change' }
  if (!chl) return { available: false, why: 'the NVR’s answer had no channel in it' }
  const sensitivity = numOf(field(chl, SENSITIVITY_NAMES))
  if (sensitivity === null) {
    return { available: false, why: 'the NVR did not report a motion sensitivity for this camera, so there is nothing to show or change', raw: xml.replace(/>\s+</g, '><').slice(0, 2000) }
  }
  // The scale is not stated by the firmware. Rather than assume 1-100 (and draw a meter that lies),
  // the range is read if the NVR gives one and reported as unknown if it does not.
  const min = numOf(field(chl, ['min', 'minValue'])) ?? numOf(kid(kid(chl, 'sensitivity'), 'min')?.text)
  const max = numOf(field(chl, ['max', 'maxValue'])) ?? numOf(kid(kid(chl, 'sensitivity'), 'max')?.text)
  return {
    available: true,
    sensitivity,
    min: min ?? null,
    max: max ?? null,
    holdTime: numOf(field(chl, HOLD_NAMES)),
    // The zone map, if the firmware gives one: rows of a coarse grid, 1 where motion is watched.
    area: readArea(chl),
    raw: xml.replace(/>\s+</g, '><').slice(0, 4000)
  }
}

/**
 * The motion zone grid, if the answer carries one. These NVRs describe it as rows of digits, one
 * digit per cell. A shape we do not recognise becomes null, not an empty grid — an empty grid on
 * screen would read as "motion is watched nowhere", which is a different and alarming claim.
 * @returns {{rows: number, cols: number, cells: number[][]} | null}
 */
export function readArea(chl) {
  const area = kid(chl, 'area') ?? kid(chl, 'areaInfo') ?? kid(chl, 'motionArea')
  if (!area) return null
  const lines = kids(area, 'item').map((i) => i.text.trim()).filter(Boolean)
  const source = lines.length ? lines : area.text.trim().split(/[\s,]+/).filter(Boolean)
  if (!source.length) return null
  const cells = source.map((row) => [...row].filter((c) => /[0-9]/.test(c)).map(Number))
  if (!cells.length || !cells[0].length || cells.some((r) => r.length !== cells[0].length)) return null
  return { rows: cells.length, cols: cells[0].length, cells }
}

/**
 * The edit document: the NVR's own answer with exactly one number changed.
 *
 * Built by substitution rather than by composition, because these NVRs replace the whole block and
 * a field we forgot to mention is a field we silently wiped. It refuses unless exactly one element
 * matched — no match means we would be writing something the NVR did not send us, and several
 * matches means we do not know which camera we would be changing.
 *
 * `chlId`: when the answer holds this camera's own <chl id="..."> block, that block alone is edited
 * and sent back. An answer that lists several cameras then changes the one asked for, and the others
 * are not written at all (the block the NVR replaces is the camera's). Without such a block the whole
 * answer is the camera's, as before.
 *
 * @returns {{ ok: true, doc: string, was: string } | { ok: false, error: string }}
 */
export function buildMotionEdit(queryXml, value, chlId = null) {
  const inner = /<content[^>]*>([\s\S]*)<\/content>/i.exec(queryXml)
  if (!inner) return { ok: false, error: 'the NVR’s answer had no <content>, so there is nothing to send back' }
  let scope = inner[1]
  if (chlId) {
    const idOf = (block) => /^<chl\b[^>]*?\sid\s*=\s*["']([^"']*)["']/i.exec(block)?.[1] ?? ''
    const mine = (scope.match(/<chl\b[^>]*>[\s\S]*?<\/chl>/gi) ?? []).filter((b) => idOf(b).toUpperCase() === String(chlId).toUpperCase())
    if (mine.length > 1) return { ok: false, error: 'the NVR’s answer lists this camera more than once' }
    if (mine.length === 1) scope = mine[0]
  }
  const name = SENSITIVITY_NAMES.find((n) => new RegExp(`<${n}(\\s[^>]*)?>`, 'i').test(scope))
  if (!name) return { ok: false, error: 'the NVR’s answer has no sensitivity element to change' }
  const re = new RegExp(`(<${name}(?:\\s[^>]*)?>)([^<]*)(</${name}>)`, 'gi')
  const found = scope.match(re) ?? []
  if (found.length !== 1) {
    return { ok: false, error: `the NVR’s answer has ${found.length} sensitivity elements; only a single, unambiguous one is changed` }
  }
  let was = ''
  const content = scope.replace(re, (_m, open, old, close) => {
    was = old.trim()
    return `${open}${value}${close}`
  })
  return { ok: true, doc: `${XML_HEADER}<content>${content}</content></request>`, was }
}

/**
 * The four things this module needs from nvr-xml.mjs: the error type, the per-NVR change lock, the
 * channel id format and how a device is named in a change log. They are imported through this
 * function, and every entry point takes them as an optional argument, for one reason: nvr-xml.mjs
 * loads the native SDK, which is a Linux .so, and the write path — the part where being wrong costs
 * somebody their motion detection — has to be testable on the Windows machine this was written on.
 * In the server they are the real thing; in the tests they are stubs, and the logic is identical.
 */
const nvrXml = () => import('./nvr-xml.mjs')

/**
 * The request queryMotion is sent. It names the camera the way the picture and OSD reads do
 * (imaging.mjs readSettings, osd-doc.mjs osdRequest): unnamed, the NVR was left to choose whose
 * settings to answer with.
 */
export const motionRequest = (chlId) => `${XML_HEADER}<condition><chlId>${esc(chlId)}</chlId></condition></request>`

/**
 * Reads one camera's motion settings. Never throws for an NVR that simply will not answer: that
 * comes back as `available: false` with a reason, because the tuning view has to be able to say
 * "this NVR does not tell us" instead of showing a made-up slider.
 */
export async function readMotion(nvr, ch, query, deps = null) {
  const { chlIdOf } = deps ?? (await nvrXml())
  const chlId = chlIdOf(Number(ch))
  let xml = ''
  try {
    xml = String((await query(nvr, QUERY_MOTION, motionRequest(chlId), `motion read ch${Number(ch) + 1}`)) ?? '')
  } catch (e) {
    return { nvr: nvr.id, ch: Number(ch), available: false, why: `the NVR could not be asked: ${String(e?.message ?? e).slice(0, 120)}` }
  }
  return { nvr: nvr.id, ch: Number(ch), chlId, ...readMotionAnswer(xml, chlId) }
}

/**
 * Changes one camera's motion sensitivity on the NVR itself.
 *
 * The caller has already checked `confirm: true` (events.mjs). This does the rest of the safety
 * pattern: lock, read, build by substitution, write, wait, read back, compare, log. It throws
 * HttpError for anything it will not do, so the reason reaches the person who asked.
 *
 * @param {object} nvr
 * @param {number} ch
 * @param {{threshold: number, confirm: true}} want
 * @param {string} user
 * @param {Function} query
 */
export async function writeMotionThreshold(nvr, ch, want, user, query, deps = null) {
  const { HttpError, withNvrLock, chlIdOf, deviceOf } = deps ?? (await nvrXml())
  const { DATA_DIR } = await import('./auth.mjs')
  const value = Number(want?.threshold)
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new HttpError(400, 'threshold must be a whole number from 0 to 100')
  }
  const chlId = chlIdOf(Number(ch))

  return withNvrLock(nvr, 'A motion sensitivity change', async () => {
    const beforeXml = String((await query(nvr, QUERY_MOTION, motionRequest(chlId), `motion before ch${Number(ch) + 1}`)) ?? '')
    const before = readMotionAnswer(beforeXml, chlId)
    // Never write blind. If we could not read the current setting we do not know what we would be
    // replacing, and on a box that swallows whole blocks that is how a camera stops detecting.
    if (!before.available) throw new HttpError(502, `${before.why}; nothing was changed`)
    if (before.sensitivity === value) {
      return { changed: false, before, after: before, applied: true, note: 'it is already set to that; nothing was sent' }
    }
    if (before.min !== null && value < before.min) throw new HttpError(400, `this NVR's lowest sensitivity is ${before.min}`)
    if (before.max !== null && value > before.max) throw new HttpError(400, `this NVR's highest sensitivity is ${before.max}`)

    const built = buildMotionEdit(beforeXml, value, chlId)
    if (!built.ok) throw new HttpError(502, `${built.error}; nothing was changed`)

    const reply = String((await query(nvr, EDIT_MOTION, built.doc, `motion write ch${Number(ch) + 1}`)) ?? '')
    if (!/<status>\s*success/i.test(reply)) {
      const code = /<errorCode>\s*(\d+)/.exec(reply)?.[1]
      throw new HttpError(502, `the NVR refused the change${code ? ` (code ${code})` : ''}; nothing was changed`)
    }

    await new Promise((r) => setTimeout(r, READ_BACK_MS))
    const afterXml = String((await query(nvr, QUERY_MOTION, motionRequest(chlId), `motion after ch${Number(ch) + 1}`)) ?? '')
    const after = readMotionAnswer(afterXml, chlId)
    // The NVR can answer "success" and keep its old setting, so the answer is not taken as proof.
    const applied = after.available && after.sensitivity === value

    const row = {
      at: new Date().toISOString(),
      device: deviceOf(nvr),
      nvr: nvr.id,
      ch: Number(ch),
      by: user ?? '?',
      setting: 'motion sensitivity',
      was: before.sensitivity,
      wanted: value,
      got: after.available ? after.sensitivity : null,
      applied
    }
    try {
      appendFileSync(join(DATA_DIR, LOG_FILE_NAME), `${JSON.stringify(row)}\n`, { mode: 0o600 })
    } catch { /* the change is done; failing to log it must not undo it */ }

    return {
      changed: true,
      before,
      after,
      applied,
      logged: row,
      warning: applied ? undefined : 'The NVR accepted the change but still reports its old sensitivity.'
    }
  })
}

/** Where the change log lives, for the page that shows it. */
export const motionLogFile = (dataDir) => join(dataDir, LOG_FILE_NAME)
