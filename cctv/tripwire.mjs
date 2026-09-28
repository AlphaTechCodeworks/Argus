// Line crossing ("tripwire") drawn in Argus and detected by the camera itself. An admin draws up to
// four lines on the live picture; this writes them into the camera's own line-crossing detection
// through the NVR. The camera's AI does the detecting (alarm-watch.mjs turns its alarms into events
// within seconds). Nothing here looks at video.
//
// Protocol: the NVR web client's line-crossing page (js/app/AlarmCfg/tripwireAlarmCfg.js):
//   support  queryNodeList      the web client's own requireField list; <supportTripwire> per channel.
//                               Asked of each NVR at most every 10 minutes: it changes only with the cameras
//   read     queryTripwire      <condition><chlId>{id}</chlId></condition><requireField><param/><trigger/></requireField>
//   write    editTripwire       the whole <chl> block every time, as the page's getSaveData builds it
//                               (tripwire-xml.mjs buildEditTripwire), every value from a fresh read
//                               except what the admin changed
//   choices  queryScheduleList  the NVR's schedules (chl@scheduleGuid names one of them)
// The XML itself (parse, change, check, build, compare) lives in tripwire-xml.mjs, which is pure.
//
// Safety, in the order a change goes (the pattern of imaging.mjs and streams.mjs):
// - admins only, same-origin JSON (server.mjs), confirm: true, and the device the panel was opened on;
// - one change per NVR at a time (withNvrLock), and every XML call queued per NVR (nvr-xml.mjs);
// - the camera is read again first; if anything the admin was shown has changed since, nothing is
//   sent (409 stale: `seen` is a hash of every setting the panel was given);
// - refusals (tripwire-xml.mjs checkChange): settings this route does not change, a line shorter
//   than 5 % of the picture, values not among the camera's or the NVR's choices, and any change at
//   all while the camera's own sound or white-light trigger is on (the floodlight is worked by hand
//   only; those two are never sent);
// - warnings that need an acknowledgement tied to the exact change (409 needsAck + ackToken): a
//   detection that cannot run beside this one, no person/vehicle filter, a short hold time, no line,
//   no schedule (None: the camera would never detect);
// - the change is logged (with every setting before it) BEFORE anything is sent;
// - it is read back at 1.5, 3 and 6 s and every field of the answer is compared, including those
//   the web client never sends: each changed field is "as asked" or "not applied", and any other
//   difference is listed as a side effect;
// - Undo puts back the newest change only, and only while the camera still shows what it left.
//
//   GET  /api/admin/nvrs/:id/channels/:ch/lines   (ch 0-based, as in /api/cameras)
//        -> { lines: { supported, cfg, schedules, device, seen, undo: { seq, at, by } | null, ntfy: { topicSet } } }
//   POST /api/admin/nvrs/:id/channels/:ch/lines
//        { device, seen, change, ack?, ackToken?, confirm: true }
//        { device, undo: true, seq, ack?, ackToken?, confirm: true }
//     -> { lines, result: { seq, status, message, answer, fields, sideEffects, warningsAcked } }
//        lines: null when the camera could not be read back afterwards (status 'unknown')
//        409 { error, stale: true }: the camera changed since `seen`; nothing was sent
//        409 { error, needsAck: [{ key, text }], ackToken }: acknowledge these, then send again
//
// Which cameras have line crossing switched on is kept in LINES_ON_FILE, from every read and every
// write here: the alarm watcher asks only the NVRs that have one.
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DATA_DIR } from './auth.mjs'
import {
  HttpError,
  XML_HEADER,
  cameraOf,
  deviceOf,
  errorAnswer,
  esc,
  isPlainObject,
  newSeq,
  parseAnswer,
  readLogCached,
  requireOnline,
  rotateLog,
  settled,
  transparent,
  withNvrLock
} from './nvr-xml.mjs'
import { nvrs } from './nvrs.mjs'
import { getSettings } from './settings.mjs'
import { applyChange, buildEditTripwire, checkChange, compareReadBack, flatten, parseSchedules, parseSupport, parseTripwire } from './tripwire-xml.mjs'

export const LINES_LOG = join(DATA_DIR, 'tripwire-changes.log')
export const LINES_ON_FILE = join(DATA_DIR, 'lines-on.json') // { "<nvrId>/<ch>": true }, ch 0-based

const QUERY_URL = 'queryTripwire'
const EDIT_URL = 'editTripwire' // writes: only an admin's confirmed change
const NODE_LIST_URL = 'queryNodeList'
const SCHEDULES_URL = 'queryScheduleList'
// The web client's own capability list, exactly as the read-only probe of 2026-09-27 sent it (nvr-2
// answered in 0.16 s, about 1.4 KB per camera). Only supportTripwire is used here; the rest is asked
// for because this is the request the firmware is known to answer.
const SUPPORT_FLAGS = [
  'supportInvokeEventTypeConfig', 'supportTripwire', 'supportPea', 'supportPeaTrigger', 'supportAOIEntry', 'supportAOILeave', 'supportVfd',
  'supportVehiclePlate', 'supportVideoMetadata', 'supportLoitering', 'supportFire', 'supportPassLine', 'supportCpc', 'supportOsc', 'supportCdd',
  'supportASD', 'supportAvd', 'supportTemperature', 'supportPvd', 'supportIpd', 'supportAutoTrack'
]
const NODE_LIST_REQUEST =
  `${XML_HEADER}<types><nodeType><enum>chls</enum><enum>sensors</enum><enum>alarmOuts</enum></nodeType></types>` +
  '<nodeType type="nodeType">chls</nodeType><condition></condition>' +
  `<requireField><name/><chlIndex/><chlType/><ip/>${SUPPORT_FLAGS.map((f) => `<${f}/>`).join('')}<protocolType/><supportAudioAlarmOut/><supportWhiteLightAlarmOut/></requireField></request>`
const NODE_LIST_BYTES = 512 * 1024 // 32 cameras at ~1.4 KB each, with room to spare
const OFFLINE_CODES = new Set(['536870935', '536870962']) // what the NVR's pages read as "camera offline"

/** Waits (ms). Tests shorten them. */
export const TIMING = {
  verifyMs: [1500, 3000, 6000], // read back this long after the change, until it shows
  supportMs: 10 * 60_000 // which cameras have line crossing: asked of an NVR at most this often
}

const sameId = (a, b) => String(a).toUpperCase() === String(b).toUpperCase()
const sortObj = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
/** A short hash tying a confirmation (or a "seen") to exactly what it was given for. */
const tokenOf = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
/** Every setting the panel was shown, as one value: a change is refused once the camera's differs. */
const seenOf = (cfg) => tokenOf(['seen', sortObj(flatten(cfg))])

// ---- cameras with line crossing on ---------------------------------------------------------------
//
// Read from the file once, then kept in memory: the alarm watcher asks every 5 s. Each change is
// written through at once (temp file + rename, never half-written). A write that fails is retried
// on the next note, so the file catches up with memory.

let onSet = null // Set of '<nvrId>/<ch>'
let onDirty = false

function loadOn() {
  if (onSet) return onSet
  onSet = new Set()
  try {
    const saved = JSON.parse(readFileSync(LINES_ON_FILE, 'utf8'))
    if (isPlainObject(saved)) for (const [k, v] of Object.entries(saved)) if (v === true) onSet.add(k)
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[tripwire] ${LINES_ON_FILE} could not be read, starting with no cameras: ${e.message}`)
  }
  return onSet
}

/** Cameras whose line crossing is switched on, as '<nvrId>/<ch>' (ch 0-based). A copy: change it freely. */
export function linesOn() {
  return new Set(loadOn())
}

/** Remembers whether a camera's line crossing is on (from a read or a write), saved at once. */
export function noteLinesOn(nvrId, ch, on) {
  const set = loadOn()
  const key = `${nvrId}/${ch}`
  if (Boolean(on) === set.has(key) && !onDirty) return
  if (on) set.add(key)
  else set.delete(key)
  try {
    mkdirSync(dirname(LINES_ON_FILE), { recursive: true })
    const tmp = `${LINES_ON_FILE}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(Object.fromEntries([...set].sort().map((k) => [k, true])), null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, LINES_ON_FILE)
    onDirty = false
  } catch (e) {
    onDirty = true
    console.warn(`[tripwire] could not save ${LINES_ON_FILE}: ${e.message}`)
  }
}

// ---- NVR reads ------------------------------------------------------------------------------------

const supportCache = new Map() // nvr id -> { at, device, map: chlId -> { tripwire, pea } }

/** Whether the NVR says this camera has line crossing (its channel list, cached per NVR). */
async function supported(ctx) {
  const { nvr, chlId, gen, device, deps } = ctx
  let hit = supportCache.get(nvr.id)
  if (!hit || hit.device !== device || Date.now() - hit.at >= TIMING.supportMs) {
    const xml = await deps.transparent(nvr, NODE_LIST_URL, NODE_LIST_REQUEST, 'line-crossing support', { gen, outBytes: NODE_LIST_BYTES })
    const a = parseAnswer(xml)
    if (a.status !== 'success') throw new HttpError(502, `The NVR refused to list its cameras' detections (${a.errorCode || a.status || 'no status'})`)
    hit = { at: Date.now(), device, map: parseSupport(xml) }
    supportCache.set(nvr.id, hit)
  }
  for (const [id, s] of hit.map) if (sameId(id, chlId)) return s.tripwire === true
  return false
}

/** The camera's line-crossing settings, read now (tripwire-xml.mjs parseTripwire's shape). */
async function readCfg(ctx) {
  const { nvr, chlId, gen, deps } = ctx
  const cond = `<condition><chlId>${esc(chlId)}</chlId></condition><requireField><param/><trigger/></requireField>`
  const xml = await deps.transparent(nvr, QUERY_URL, `${XML_HEADER}${cond}</request>`, 'line-crossing settings', { gen })
  const a = parseAnswer(xml)
  if (a.status !== 'success') {
    const why = OFFLINE_CODES.has(a.errorCode) ? 'the camera is offline or does not let the NVR read them' : `the NVR refused (${a.errorCode || a.status || 'no status'})`
    throw new HttpError(502, `Could not read the line-crossing settings: ${why}`)
  }
  let cfg
  try {
    cfg = parseTripwire(xml)
  } catch (e) {
    throw new HttpError(502, `Could not read the line-crossing settings: ${e.message}`)
  }
  if (!sameId(cfg.chlId, chlId)) throw new HttpError(502, 'The NVR answered with another camera\'s line-crossing settings')
  return cfg
}

/**
 * The NVR's schedules [{ id, name }]. strict: a failure is an error (a change that names a schedule
 * must be checked against the list); otherwise [] (the panel then only shows the one in use).
 */
async function readSchedules(ctx, { strict = false } = {}) {
  const { nvr, gen, deps } = ctx
  try {
    const xml = await deps.transparent(nvr, SCHEDULES_URL, `${XML_HEADER}</request>`, 'schedules', { gen })
    const a = parseAnswer(xml)
    if (a.status !== 'success') throw new HttpError(502, `The NVR refused to list its schedules (${a.errorCode || a.status || 'no status'})`)
    return parseSchedules(xml)
  } catch (e) {
    if (strict || nvr.gen !== gen) throw e
    return []
  }
}

// ---- change log (and Undo) --------------------------------------------------------------------
//
// Write-ahead: a "change" line (every setting before, what was asked and what Undo would send
// back) is written BEFORE the edit goes out, a "result" line (the camera as read back) after. If the
// first write fails, nothing is sent. Lines are tied to the device (NVR address or serial) and camera.

const readLog = () => readLogCached(LINES_LOG).filter((e) => typeof e.seq === 'string')
function writeLog(entry) {
  mkdirSync(dirname(LINES_LOG), { recursive: true })
  appendFileSync(LINES_LOG, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
}
const logKey = (e) => `${e.device}|${e.chl}`
const sameFlat = (a, b) => {
  const keys = Object.keys(a)
  return isPlainObject(b) && keys.length === Object.keys(b).length && keys.every((k) => String(a[k]) === String(b[k]))
}

/** What `cfg` has for the keys of a change, in the change's own form: what Undo sends back. */
function changeFrom(cfg, keys) {
  const out = {}
  for (const k of keys) {
    if (k === 'enabled') out.enabled = cfg.enabled
    else if (k === 'holdTime') out.holdTime = cfg.holdTime
    else if (k === 'scheduleGuid') out.scheduleGuid = cfg.scheduleGuid
    else if (k === 'lines') out.lines = cfg.lines.map((l) => ({ direction: l.direction, start: { x: l.start.x, y: l.start.y }, end: { x: l.end.x, y: l.end.y } }))
    else if (k === 'filter' && cfg.filter?.kind === 'single') out.filter = { sensitivity: cfg.filter.sensitivity }
    else if (k === 'filter' && cfg.filter?.kind === 'objects') {
      out.filter = Object.fromEntries(Object.entries(cfg.filter.classes).map(([c, v]) => [c, { on: v.on, sensitivity: v.sensitivity }]))
    }
  }
  return out
}

/**
 * The newest change this app made to this camera that is not undone yet, if the camera still has
 * exactly what was read back right after it (every field, side effects included). A change that
 * applied nothing, or whose read-back is missing, is not offered: what it left is not known.
 */
function undoable(log, device, chlId, cfg) {
  const mine = log.filter((e) => e.kind === 'change' && e.device === device && sameId(e.chl, chlId))
  // result lines carry only the seq of their change
  const results = new Map(log.filter((e) => e.kind === 'result').map((e) => [e.seq, e]))
  const undone = new Set(mine.filter((e) => e.action === 'undo' && results.get(e.seq)?.result === 'done').map((e) => e.undoes))
  const last = mine.filter((e) => e.action === 'change' && !undone.has(e.seq)).at(-1)
  if (!last) return null
  const r = results.get(last.seq)
  if (!r || !['done', 'partial'].includes(r.result) || !r.after) return null
  return sameFlat(flatten(cfg), r.after) ? last : null
}

// ---- a change -------------------------------------------------------------------------------------

/** Refuses (409 needsAck) unless every warning is acknowledged with the matching token. */
function requireAck(warnings, token, body) {
  if (warnings.length === 0) return
  const ack = Array.isArray(body?.ack) ? body.ack : []
  if (body?.ackToken === token && warnings.every((w) => ack.includes(w.key))) return
  throw new HttpError(409, 'This change needs your confirmation', { needsAck: warnings.map(({ key, text }) => ({ key, text })), ackToken: token })
}

/** Reads at 1.5, 3 and 6 s until shows(settings). Returns the last good read (null if none). */
async function readUntil(nvr, gen, read, shows) {
  let last = null
  let t = 0
  for (const at of TIMING.verifyMs) {
    await sleep(Math.max(0, at - t))
    t = at
    try {
      last = await read()
      if (shows(last)) break
    } catch {
      if (nvr.gen !== gen || !nvr.online) break
    }
  }
  return last
}

/**
 * Checks, logs, sends and reads back one change (or an Undo) to one camera. cfg: read just now,
 * under the NVR's change lock. tokenPart: what the confirmation is tied to besides the change
 * itself (the `seen` of a change, the seq an Undo puts back).
 * @returns {Promise<{ after: object | null, result: object }>}  after: the camera as read back
 */
async function apply(ctx, cfg, change, { action, undoes, body, schedules, tokenPart }) {
  const { nvr, chlId, gen, user, device, deps } = ctx
  const { refuse, warnings } = checkChange(cfg, change, schedules ? { schedules } : {})
  if (refuse) throw new HttpError(400, `Refused: ${refuse}. Nothing was sent.`)
  const next = applyChange(cfg, change)
  const from = flatten(cfg)
  const to = flatten(next)
  const token = tokenOf([device, chlId, 'lines', action, tokenPart, sortObj(to), warnings.map((w) => [w.key, w.text])])
  requireAck(warnings, token, body)
  // the document first: one that can't be built means nothing is logged or sent
  const xml = buildEditTripwire(next)
  if (nvr.degraded || nvr.gen !== gen) throw new HttpError(409, `${nvr.name} is busy or reconnected; nothing was sent`)
  const seq = newSeq()
  const acked = warnings.map((w) => w.key)
  // write-ahead: if the "before" can't be recorded, nothing is sent
  writeLog({
    kind: 'change', seq, at: new Date().toISOString(), user, nvr: nvr.id, device, nvrName: nvr.name, chl: chlId, ch: ctx.ch + 1, name: ctx.name,
    action, undoes, change, undo: changeFrom(cfg, Object.keys(change)), to, ack: acked, ackToken: token, before: cfg
  })
  // lines-on, pessimistically and before the edit goes out: a camera this change may switch on is
  // watched from now, and the read-back below corrects it. If that read fails, or the process stops
  // first, it stays cfg.enabled (noted at the read) || next.enabled: a wrong "on" costs one alarm-list
  // read every 5 s, a wrong "off" loses the alert that should come within seconds.
  if (next.enabled) noteLinesOn(nvr.id, ctx.ch, true)
  const changed = Object.keys(to).filter((k) => to[k] !== from[k])
  console.log(`[tripwire] ${nvr.id} ch${ctx.ch + 1} "${ctx.name}": ${changed.map((k) => `${k} ${from[k] ?? '(none)'} -> ${to[k]}`).join(', ')} (${action}, by ${user})`)

  let a
  let timedOut = false
  try {
    a = parseAnswer(await deps.transparent(nvr, EDIT_URL, xml, 'line-crossing change', { gen }))
  } catch (e) {
    timedOut = e?.name === 'SdkTimeout'
    a = { status: timedOut ? 'no answer in time' : 'error', errorCode: e.message }
  }
  // a change that timed out may still be applied later: let it finish before checking
  if (timedOut) await settled(nvr)
  const read = () => readCfg(ctx)
  const shows = (x) => compareReadBack(cfg, next, x).fields.every((f) => f.status === 'as asked')
  let after
  if (a.status === 'success' || timedOut) after = await readUntil(nvr, gen, read, shows)
  else {
    // refused: one read is enough to see what (if anything) changed
    await sleep(TIMING.verifyMs[0])
    after = await read().catch(() => null)
  }

  // every field, as asked or not, and whatever else moved
  const { fields, sideEffects } = after ? compareReadBack(cfg, next, after) : { fields: [], sideEffects: [] }
  const good = fields.filter((f) => f.status === 'as asked').length
  const status = !after ? 'unknown' : good === fields.length ? 'done' : good > 0 ? 'partial' : 'failed'
  if (after) noteLinesOn(nvr.id, ctx.ch, after.enabled) // (not read back: what was noted before the edit stays)
  try {
    writeLog({ kind: 'result', seq, at: new Date().toISOString(), result: status, answer: a.status, errorCode: a.errorCode || undefined, after: after ? flatten(after) : null, fields, sideEffects })
    rotateLog(LINES_LOG, { keyOf: logKey })
  } catch (e) {
    console.warn(`[tripwire] result not logged: ${e.message}`)
  }
  const kept = fields.filter((f) => f.status !== 'as asked').map((f) => f.key)
  let message =
    status === 'done' ? (action === 'undo' ? 'Undone' : 'Applied')
      : status === 'unknown' ? 'Sent, but the camera\'s line settings could not be read back afterwards: what it has now is not known.'
        : status === 'partial' ? `Partly applied; the camera kept: ${kept.join(', ')}`
          : a.status === 'success' ? 'The NVR accepted it, but the camera kept its line settings'
            : timedOut ? 'Not changed: the NVR did not answer in time'
              : a.status === 'error' ? `Not changed: ${a.errorCode}`
                : `Not changed: the NVR refused (${a.errorCode || a.status || 'no status'})`
  const effects = sideEffects.map((s) => `${s.key} ${s.from ?? '(none)'} → ${s.to ?? '(none)'}`)
  if (effects.length) message += `${/[.!]$/.test(message) ? '' : '.'} The camera also changed: ${effects.join(', ')}.`
  return { after, result: { seq, status, message, answer: a.status, fields, sideEffects, warningsAcked: acked } }
}

async function changeFromBody(ctx, cfg, body) {
  if (typeof body.seen !== 'string') throw new HttpError(400, 'seen must be the value given with the settings shown')
  if (body.seen !== seenOf(cfg)) {
    throw new HttpError(409, 'The camera\'s line settings changed since you looked; nothing was sent. Close the panel and open it again.', { stale: true })
  }
  if (!isPlainObject(body.change)) throw new HttpError(400, 'change must name what to change')
  // a schedule is checked against the NVR's list as it is now
  const schedules = 'scheduleGuid' in body.change ? await readSchedules(ctx, { strict: true }) : null
  return apply(ctx, cfg, body.change, { action: 'change', body, schedules, tokenPart: body.seen })
}

async function undo(ctx, cfg, body) {
  if (typeof body.seq !== 'string') throw new HttpError(400, 'Undo needs the seq of the change shown')
  const last = undoable(readLog(), ctx.device, ctx.chlId, cfg)
  if (!last) throw new HttpError(409, 'Nothing to undo: the last change was undone already, or the camera\'s line settings were changed since; reopen the panel')
  if (last.seq !== body.seq) throw new HttpError(409, 'Someone changed this camera since; reopen the panel')
  if (!isPlainObject(last.undo) || Object.keys(last.undo).length === 0) throw new HttpError(409, 'That change has no record of the settings before it, so it cannot be undone from here')
  const schedules = 'scheduleGuid' in last.undo ? await readSchedules(ctx, { strict: true }) : null
  return apply(ctx, cfg, last.undo, { action: 'undo', undoes: last.seq, body, schedules, tokenPart: last.seq })
}

// ---- API ------------------------------------------------------------------------------------------

function view(ctx, isSupported, cfg, schedules, log = readLog()) {
  const last = cfg ? undoable(log, ctx.device, ctx.chlId, cfg) : null
  return {
    supported: isSupported,
    cfg,
    schedules,
    device: ctx.device,
    seen: cfg ? seenOf(cfg) : null,
    undo: last ? { seq: last.seq, at: last.at, by: last.user } : null,
    // the Lines panel shows how to subscribe once alerts have somewhere to go (line-actions.mjs)
    ntfy: { topicSet: Boolean(ctx.deps.getSettings()?.alerts?.ntfy?.topic) }
  }
}

/**
 * /api/admin/nvrs/:id/channels/:ch/lines.
 * @param {string} method
 * @param {string} nvrId
 * @param {number} ch  0-based
 * @param {URLSearchParams} params  (none are used yet; every camera route takes them)
 * @param {() => Promise<any>} readJson
 * @param {string} user  the admin, for the change log
 * @param {{ nvrs?: Map<string, object>, transparent?: Function, getSettings?: Function }} [deps]
 *   for the tests: the NVR list (default nvrs.mjs's), the XML call (default nvr-xml.mjs transparent,
 *   same arguments) and the settings (default settings.mjs getSettings). server.mjs passes nothing.
 * @returns {Promise<[number, any]>}
 */
export async function handleLines(method, nvrId, ch, params, readJson, user, deps = {}) {
  try {
    // resolved on each call, not when this module loads: nvrs.mjs may import this module (the alarm
    // watcher reads linesOn), and during that import cycle its exports do not exist yet
    const d = { nvrs: deps.nvrs ?? nvrs, transparent: deps.transparent ?? transparent, getSettings: deps.getSettings ?? getSettings }
    const { nvr, chlId, name } = cameraOf(d.nvrs, nvrId, ch)
    requireOnline(nvr)
    const ctx = { nvr, ch, chlId, name, gen: nvr.gen, user, device: deviceOf(nvr), deps: d }
    if (method === 'GET') {
      if (!(await supported(ctx))) return [200, { lines: view(ctx, false, null, []) }]
      const cfg = await readCfg(ctx)
      noteLinesOn(nvr.id, ch, cfg.enabled)
      return [200, { lines: view(ctx, true, cfg, await readSchedules(ctx)) }]
    }
    if (method !== 'POST') return [405, { error: 'Method not allowed' }]
    const body = await readJson()
    if (!isPlainObject(body)) throw new HttpError(400, 'The request must be a JSON object')
    if (body.confirm !== true) throw new HttpError(400, 'Changes need confirm: true')
    if (body.device !== ctx.device) throw new HttpError(409, 'These settings are out of date (the NVR or its address changed). Close the panel and open it again.')
    return await withNvrLock(nvr, 'A line-crossing change', async () => {
      if (!(await supported(ctx))) throw new HttpError(400, 'This camera has no line-crossing detection')
      // read again right before changing: never act on stale settings
      const cfg = await readCfg(ctx)
      noteLinesOn(nvr.id, ch, cfg.enabled)
      const r = body.undo === true ? await undo(ctx, cfg, body) : await changeFromBody(ctx, cfg, body)
      // not read back (status 'unknown'): what the camera has now is not known, and the settings read
      // before the change are not it; answered as lines: null so the panel never shows them as saved
      if (!r.after) return [200, { lines: null, result: r.result }]
      // the change is made and logged by now: a failed list of schedules must not hide its result
      const schedules = await readSchedules(ctx).catch(() => [])
      return [200, { lines: view(ctx, true, r.after, schedules), result: r.result }]
    })
  } catch (e) {
    return errorAnswer(e)
  }
}
