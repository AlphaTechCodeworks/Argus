// Four of a camera's own detections, set from the camera editor on the Sites page: Motion, Sterile
// area (intrusion), Item monitoring (left behind / taken) and Fault (scene change, blur, colour
// cast). The camera does the detecting; this reads and writes its settings through the NVR, the
// way the NVR's own web client does. Nothing here looks at video.
//
// Protocol (the web client's pages; the XML itself is camera-cfg-xml.mjs, which is pure):
//   motion     queryMotion / editMotion        two questions and two writes, one per half, as its
//                                              two pages do: `param` (the detection) and `trigger`
//                                              (what it sets off)
//   perimeter  queryPerimeter / editPerimeter  the whole <chl> block every time
//   osc        queryOsc / editOsc              the whole <chl> block every time
//   avd        queryAvd / editAvd              the whole <chl> block every time
//   support    queryNodeList                   supportPea / supportOsc / supportAvd per camera, from the
//                                              list tripwire.mjs already reads and caches (motion is
//                                              always offered)
//   choices    queryScheduleList               the NVR's schedules (tripwire.mjs readSchedules)
// No other command is ever sent from here.
//
// The write gate. None of these edits except motion's `param` half has ever been sent to a real
// recorder, and a bad request has hung one. PROVEN (camera-cfg-xml.mjs) names what may go out; a
// POST for anything else is answered 409 before the NVR is asked anything at all, and the page
// shows the form greyed out with the reason. CCTV_CAMERA_CFG_WRITES switches more on for a test:
// a comma list of PROVEN's keys (motion:trigger, perimeter, osc, avd), `all`, or `off` for none.
//
// Safety, in the order a change goes (the pattern of osd.mjs and tripwire.mjs):
// - admins only, same-origin JSON (server.mjs), confirm: true;
// - the write gate;
// - one change per NVR at a time (withNvrLock), and every XML call queued per NVR (nvr-xml.mjs);
// - the camera is read again first, and the edit is built from that read: every value goes back
//   as read except what the admin changed;
// - refusals (camera-cfg-xml.mjs validate): a setting this route does not change, a value not among
//   the camera's or the NVR's choices, a zone with 1-3 corners or one that crosses itself;
// - the change is logged (the settings before, and as asked) BEFORE anything is sent;
// - the edit is sent once. It is never sent again, whatever the answer;
// - it is read back 1.5 s later and the fields that were changed are compared: any the camera
//   does not show as asked come back as `differences`.
//
//   GET  /api/admin/nvrs/:id/channels/:ch/cfg/:kind   (ch 0-based; kind motion|perimeter|osc|avd)
//        -> { kind, supported, model, schedules, writable, why, parts? }
//           model: the settings in the page's words (camera-cfg-xml.mjs viewOf), null if not supported
//           parts: motion only, { param: { writable, why }, trigger: { writable, why } }
//   POST /api/admin/nvrs/:id/channels/:ch/cfg/:kind
//        { confirm: true, part?: 'param' | 'trigger' (motion only), change: { ... } }
//     -> { ok, view, differences, sideEffects, seq }
//        view: the camera as read back (for motion, the half that was written); null if it could
//        not be read back. 409 { error }: saving this is not switched on yet; nothing was sent
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DATA_DIR } from './auth.mjs'
import { COMMANDS, KINDS, KIND_WORDS, MOTION_PARTS, applyChange, buildEdit, compareReadBack, mergeMotion, motionPartOf, parse, queryBody, validate, viewOf, writeGate } from './camera-cfg-xml.mjs'
import { HttpError, cameraOf, deviceOf, errorAnswer, isPlainObject, newSeq, parseAnswer, requireOnline, rotateLog, transparent, withNvrLock } from './nvr-xml.mjs'
import { nvrs } from './nvrs.mjs'
import { detectionsOf, readSchedules } from './tripwire.mjs'
import { xmlDegraded, xmlGen } from './xml-session.mjs'

export const CFG_LOG = join(DATA_DIR, 'camera-cfg-changes.log')

/** Waits (ms). Tests shorten them. */
export const TIMING = { readBackMs: 1500 } // the NVR takes a moment before it reports the new value

// queryNodeList's flag for each kind (motion has none: every camera is offered it)
const SUPPORT_FLAG = { perimeter: 'pea', osc: 'osc', avd: 'avd' }
const OFFLINE_CODES = new Set(['536870935', '536870962']) // what the NVR's pages read as "camera offline"; also its answer for a detection the camera lacks
// refusals the web client has words for
const CODE_WORDS = { 536870953: 'no permission', 536871053: 'a zone needs at least 4 corners' }

const sameId = (a, b) => String(a).toUpperCase() === String(b).toUpperCase()

/** The camera's settings could not be read, for a reason the page shows in place of the form. */
class NotReadable extends Error {}

function writeLog(entry) {
  mkdirSync(dirname(CFG_LOG), { recursive: true })
  appendFileSync(CFG_LOG, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
}

/** One question to the camera, read into a model. part: motion's half. Throws NotReadable for a refusal. */
async function ask(ctx, kind, part, tag) {
  const { nvr, chlId, gen, deps } = ctx
  const cmd = COMMANDS[kind].query
  const xml = await deps.transparent(nvr, cmd, queryBody(kind, chlId, part), tag, { gen })
  const a = parseAnswer(xml)
  if (a.status !== 'success') {
    throw new NotReadable(OFFLINE_CODES.has(a.errorCode)
      ? 'The camera is offline, or does not have this setting.'
      : `The recorder would not give this camera's settings (${a.errorCode || a.status || 'no status'}).`)
  }
  let model
  try {
    model = parse(kind, xml, { name: ctx.name })
  } catch (e) {
    throw new NotReadable(`This camera's settings could not be read exactly, so they are not shown or changed from here (${e.message}).`)
  }
  if (!sameId(model.chlId, chlId)) throw new HttpError(502, 'The NVR answered with another camera\'s settings')
  return model
}

/** The camera's settings of this kind, read now. Motion: `part` alone, or both halves when not given. */
async function readModel(ctx, kind, part = null) {
  const words = KIND_WORDS[kind].toLowerCase()
  if (kind !== 'motion') return ask(ctx, kind, null, `${words} settings`)
  if (part) return ask(ctx, kind, part, `motion ${part}`)
  return mergeMotion(await ask(ctx, kind, 'param', 'motion param'), await ask(ctx, kind, 'trigger', 'motion trigger'))
}

/** Whether the NVR says the camera has this detection. */
async function supported(ctx, kind) {
  const flag = SUPPORT_FLAG[kind]
  return flag ? (await detectionsOf(ctx))[flag] === true : true
}

/** GET: what the page shows. A camera without the detection, or one that will not say, is an answer and not an error. */
async function read(ctx, kind) {
  const env = ctx.deps.env.CCTV_CAMERA_CFG_WRITES
  const gates = kind === 'motion' ? MOTION_PARTS.map((p) => writeGate(kind, p, env)) : [writeGate(kind, null, env)]
  const writable = gates.some((g) => g.allowed)
  const base = { kind, supported: false, model: null, schedules: [], writable, why: writable ? null : gates[0].why }
  if (kind === 'motion') base.parts = Object.fromEntries(MOTION_PARTS.map((p, i) => [p, { writable: gates[i].allowed, why: gates[i].why }]))
  if (!(await supported(ctx, kind))) return { ...base, writable: false, why: `This camera does not have ${KIND_WORDS[kind].toLowerCase()} detection.` }
  let model
  try {
    model = await readModel(ctx, kind)
  } catch (e) {
    if (e instanceof NotReadable) return { ...base, writable: false, why: e.message }
    throw e
  }
  // Fault has no schedule; for the others a list that cannot be read leaves just the one in use
  const schedules = kind === 'avd' ? [] : await readSchedules(ctx)
  return { ...base, supported: true, model: viewOf(kind, model), schedules }
}

/** POST, under the NVR's change lock: read, check, log, send once, read back, compare, log. */
async function change(ctx, kind, part, want) {
  const { nvr, chlId, gen, user, device, deps } = ctx
  const words = KIND_WORDS[kind].toLowerCase()
  if (!(await supported(ctx, kind))) throw new HttpError(400, `This camera does not have ${words} detection`)
  // read again right before changing: never act on stale settings
  let before
  try {
    before = await readModel(ctx, kind, part)
  } catch (e) {
    if (e instanceof NotReadable) throw new HttpError(502, `${e.message} Nothing was changed.`)
    throw e
  }
  // a schedule is checked against the NVR's list as it is now
  const schedules = 'schedule' in want && kind !== 'avd' ? await readSchedules(ctx, { strict: true }) : []
  let xml
  let asked
  try {
    validate(kind, before, want, { part, schedules })
    asked = applyChange(kind, before, want)
    // the document first: one that can't be built means nothing is logged or sent
    xml = buildEdit(kind, before, want, part)
  } catch (e) {
    throw new HttpError(400, `Refused: ${e.message}. Nothing was sent.`)
  }
  if (xmlDegraded(nvr) || xmlGen(nvr) !== gen) throw new HttpError(409, `${nvr.name} is busy or reconnected; nothing was sent`)
  const seq = newSeq()
  const about = { seq, kind, ...(part ? { part } : {}), user, nvr: nvr.id, device, nvrName: nvr.name, chl: chlId, ch: ctx.ch + 1, name: ctx.name }
  // write-ahead: if the "before" can't be recorded, nothing is sent
  writeLog({ line: 'change', at: new Date().toISOString(), ...about, change: want, before: viewOf(kind, before), asked: viewOf(kind, asked) })
  console.log(`[camera-cfg] ${nvr.id} ch${ctx.ch + 1} "${ctx.name}": ${words}${part ? ` (${part})` : ''} ${JSON.stringify(want)} (by ${user})`)
  const result = (entry) => {
    try {
      writeLog({ line: 'result', at: new Date().toISOString(), ...about, ...entry })
      rotateLog(CFG_LOG)
    } catch (e) {
      console.warn(`[camera-cfg] result not logged: ${e.message}`)
    }
  }

  // sent once: whatever comes back, it is not sent again
  let a
  try {
    a = parseAnswer(await deps.transparent(nvr, COMMANDS[kind].edit, xml, `${words} change`, { gen }))
  } catch (e) {
    result({ result: 'no answer', error: e.message, after: null })
    throw new HttpError(502, `The recorder did not answer the change (${e.message}). It was not sent again; what the camera has now is not known. Close this tab and open it again to see.`)
  }
  if (a.status !== 'success') {
    result({ result: 'refused', answer: a.status, errorCode: a.errorCode || undefined, after: null })
    const code = a.errorCode ? `${CODE_WORDS[a.errorCode] ? `${CODE_WORDS[a.errorCode]}, ` : ''}code ${a.errorCode}` : a.status || 'no status'
    throw new HttpError(502, `The recorder refused the change (${code}); nothing was changed`)
  }

  // asked, not assumed: these NVRs will answer "success" and keep what they had
  await sleep(TIMING.readBackMs)
  const after = await readModel(ctx, kind, part).catch(() => null)
  const cmp = after ? compareReadBack(kind, before, asked, after) : { differences: [], sideEffects: [] }
  const ok = Boolean(after) && cmp.differences.length === 0
  result({ result: !after ? 'unknown' : ok ? 'done' : 'not applied', answer: a.status, after: after ? viewOf(kind, after) : null, differences: cmp.differences, sideEffects: cmp.sideEffects })
  return { ok, view: after ? viewOf(kind, after) : null, differences: cmp.differences, sideEffects: cmp.sideEffects, seq }
}

/**
 * /api/admin/nvrs/:id/channels/:ch/cfg/:kind.
 * @param {string} method
 * @param {string} nvrId
 * @param {number} ch  0-based
 * @param {string} kind  motion | perimeter | osc | avd
 * @param {() => Promise<any>} readJson
 * @param {{ user: string, admin: boolean }} who  the admin, for the change log
 * @param {{ nvrs?: Map<string, object>, transparent?: Function, env?: object }} [deps]
 *   for the tests: the NVR list (default nvrs.mjs's), the XML call (default nvr-xml.mjs transparent,
 *   same arguments) and the environment (default process.env). server.mjs passes nothing.
 * @returns {Promise<[number, any]>}
 */
export async function handleCameraCfg(method, nvrId, ch, kind, readJson, who, deps = {}) {
  try {
    if (!who?.admin) return [403, { error: 'Only admins can see or change a camera\'s detection settings' }]
    if (!KINDS.includes(kind)) return [404, { error: 'No such setting' }]
    // resolved on each call, not when this module loads (see tripwire.mjs handleLines)
    const d = { nvrs: deps.nvrs ?? nvrs, transparent: deps.transparent ?? transparent, env: deps.env ?? process.env }
    const { nvr, chlId, name } = cameraOf(d.nvrs, nvrId, ch)
    const ctx = { nvr, ch, chlId, name, gen: xmlGen(nvr), user: who.user, device: deviceOf(nvr), deps: d }
    if (method === 'GET') {
      requireOnline(nvr)
      return [200, await read(ctx, kind)]
    }
    if (method !== 'POST') return [405, { error: 'Method not allowed' }]
    const body = await readJson()
    if (!isPlainObject(body)) throw new HttpError(400, 'The request must be a JSON object')
    if (body.confirm !== true) throw new HttpError(400, 'Changes need confirm: true')
    if (!isPlainObject(body.change)) throw new HttpError(400, 'change must name what to change')
    let part = null
    if (kind === 'motion') {
      try {
        part = body.part ?? motionPartOf(body.change)
      } catch (e) {
        throw new HttpError(400, e.message)
      }
      if (!MOTION_PARTS.includes(part)) throw new HttpError(400, 'part must be param or trigger')
    } else if (body.part !== undefined) throw new HttpError(400, 'part is for motion only')
    // The gate, before the NVR is asked anything at all.
    const gate = writeGate(kind, part, d.env.CCTV_CAMERA_CFG_WRITES)
    if (!gate.allowed) return [409, { error: gate.why }]
    requireOnline(nvr)
    return [200, await withNvrLock(nvr, `A ${KIND_WORDS[kind].toLowerCase()} change`, () => change(ctx, kind, part, body.change))]
  } catch (e) {
    return errorAnswer(e)
  }
}
