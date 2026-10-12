// Four of a camera's own detections, as the NVR's web client reads and writes them:
//   motion     queryMotion / editMotion         (ChlCfg/motion.js + AlarmCfg/motionAlarmCfg.js)
//   perimeter  queryPerimeter / editPerimeter   "Sterile area" (AlarmCfg/peaAlarmCfg.js)
//   osc        queryOsc / editOsc               "Item monitoring": left behind / taken (oscAlarmCfg.js)
//   avd        queryAvd / editAvd               "Fault": scene change, blur, colour cast (avdAlarmCfg.js)
// For each: the question to ask, reading the answer into a plain model, checking an admin's change,
// building the edit document, and comparing what the camera reports afterwards.
//
// Pure on purpose: it imports only xml.mjs, never nvr-xml.mjs (which loads the native SDK), so the
// offline tests run on the Windows PC. camera-cfg.mjs does the sending, the lock and the change log.
//
// Why every edit is built from the whole answer: these commands replace the camera's whole block,
// and the web client always sends all of it. So every value goes back exactly as read except what
// the admin changed, in the web client's own element order and spelling. The spelling matters and
// is not ours to tidy:
//   - answers say uint="s" on the hold time, every edit says unit="s";
//   - editOsc's zone list is type="lis" (the web client's typo, which the firmware accepts);
//   - <sysAudio id='…'> is written with single quotes; names in lists go in CDATA;
//   - editPerimeter writes saveSourcePicture before saveTargetPicture (the reverse of the answer);
//   - the smart-event trigger never carries the sysRec/alarmOut/preset switches, sysSnap,
//     popMsgSwitch or the manual switches; editMotion's trigger carries the switches and sysSnap.
// Deliberate differences from the web client, each the cautious side of something it does blindly:
//   - a class of the person/vehicle filter is sent exactly when the answer had it (the web client
//     invents car and person, and drops motor by a flag we cannot read);
//   - triggerAudio / triggerWhiteLight are never sent (the web client leaves them out too unless
//     the camera has a siren or a light; none of these do), and a camera that reports either one on
//     is refused outright, as tripwire-xml.mjs does;
//   - a missing sysAudio is the null id ("none"), never the text "undefined".
//
// Anything in an answer that cannot be read exactly (an on/off that is neither true nor false, a
// filter class we do not know) makes the parse throw: a value we guessed would be written back.
import { XML_HEADER, esc, kid, kids, parseXml } from './xml.mjs'

export const KINDS = ['motion', 'perimeter', 'osc', 'avd']
export const COMMANDS = {
  motion: { query: 'queryMotion', edit: 'editMotion' },
  perimeter: { query: 'queryPerimeter', edit: 'editPerimeter' },
  osc: { query: 'queryOsc', edit: 'editOsc' },
  avd: { query: 'queryAvd', edit: 'editAvd' }
}
/** What each one is called on the page. */
export const KIND_WORDS = { motion: 'Motion', perimeter: 'Sterile area', osc: 'Item monitoring', avd: 'Fault' }
/** The two halves of editMotion: the web client's two pages each send only their own. */
export const MOTION_PARTS = ['param', 'trigger']
/** A zone is empty or has at least this many corners (the web client's rule; the NVR's 536871053). */
export const MIN_ZONE_POINTS = 4

export const UNITS = 10000 // coordinates are 0..10000 of the picture's width and height, origin top-left
export const NULL_GUID = '{00000000-0000-0000-0000-000000000000}'
const GUID = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/
const CLASSES = ['car', 'person', 'motor'] // the web client's order inside <objectFilter>
const CLASS_PARTS = ['switch', 'sensitivity', 'minDetectTarget', 'maxDetectTarget']
const CLASS_WORDS = { car: 'Car', person: 'Person', motor: 'Motorbike' }
const AVD_SWITCHES = ['sceneChange', 'clarityAbnormal', 'colorAbnormal'] // <sceneChangeSwitch> ...
const AVD_WORDS = { sceneChange: 'Scene change', clarityAbnormal: 'Blurred picture', colorAbnormal: 'Colour cast' }
const OSC_NAME_MAX = 15 // hard-coded in the web client's editOsc, as is the 6 below
const OSC_POINTS_MAX = 6
/** What the page's "When it triggers" boxes are called here. */
const TRIGGER_KEYS = ['record', 'snapshot', 'push', 'buzzer', 'popVideo', 'email']
const TRIGGER_WORDS = { record: 'Record', snapshot: 'Snapshot', push: 'Push message to phones', buzzer: 'Buzzer on the recorder', popVideo: 'Pop-up video', email: 'Email' }
// The detections a camera lists in <mutexList>, in words an admin knows.
const MUTEX_WORDS = {
  perimeter: 'sterile area', pea: 'sterile area', osc: 'item monitoring', cdd: 'crowd density', cpc: 'people counting',
  ipd: 'people intrusion', tripwire: 'line crossing', vfd: 'face detection', avd: 'fault detection',
  vehicle: 'number plate detection', aoientry: 'area entry', aoileave: 'area exit', loitering: 'loitering'
}

const text = (n) => (n?.text ?? '').trim()
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const sameId = (a, b) => String(a).toUpperCase() === String(b).toUpperCase()
const kindOk = (kind) => {
  if (!KINDS.includes(kind)) throw new Error(`Unknown kind of setting: ${kind}`)
}

// ---- the write gate ------------------------------------------------------------------------------

/**
 * Which edits have been proven on a real recorder. Nothing else is ever sent: an edit that has
 * never been tried may be refused, may be half applied, or may hang the recorder.
 * All five were proven on 2026-10-12 on Value4U camera 2 (an AI model on an NVR-63432): each was changed,
 * read back and put back with nothing else moving (hold time, a trigger switch, zones drawn and cleared,
 * on and off, sensitivity, the item-monitoring type). Other camera models have not been tried.
 */
export const PROVEN = { 'motion:param': true, 'motion:trigger': true, perimeter: true, osc: true, avd: true }
export const NOT_PROVEN = 'Saving this is not switched on yet: it has not been proven on a real recorder.'

/** The PROVEN key of a write: 'motion:param', 'motion:trigger', or the kind. */
export const gateKey = (kind, part = null) => (kind === 'motion' ? `motion:${part}` : kind)

/**
 * Whether a write may go out. env: the value of CCTV_CAMERA_CFG_WRITES, a comma list of PROVEN's
 * keys to switch on as well, `all` for every one, or `off` for none at all (not even the proven).
 * @returns {{ key: string, allowed: boolean, why: string | null }}
 */
export function writeGate(kind, part = null, env = '') {
  const key = gateKey(kind, part)
  const words = String(env ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const known = Object.hasOwn(PROVEN, key)
  const allowed = known && !words.includes('off') && (PROVEN[key] === true || words.includes('all') || words.includes(key.toLowerCase()))
  return { key, allowed, why: allowed ? null : NOT_PROVEN }
}

// ---- the questions -------------------------------------------------------------------------------

/**
 * The query document, as the web client's page sends it. Motion has two pages and so two questions:
 * part 'param' (the detection itself) or 'trigger' (what it sets off); the others ask for both at once.
 */
export function queryBody(kind, chlId, part = null) {
  kindOk(kind)
  if (kind === 'motion' && !MOTION_PARTS.includes(part)) throw new Error('queryMotion is asked for its param or its trigger half')
  const fields = kind === 'motion' ? `<${part}/>` : '<param/><trigger/>'
  return `${XML_HEADER}<condition><chlId>${esc(chlId)}</chlId></condition><requireField>${fields}</requireField></request>`
}

// ---- reading -------------------------------------------------------------------------------------

/** The <response> of an answer that says success; anything else throws with the NVR's reason. */
function answerOf(xml, cmd) {
  const response = kid(parseXml(String(xml ?? '')), 'response')
  if (!response) throw new Error(`${cmd}: bad answer from the NVR (no <response>)`)
  const status = text(kid(response, 'status'))
  if (status !== 'success') {
    const code = text(kid(response, 'errorCode'))
    throw new Error(`${cmd}: the NVR refused (${code || status || 'no status'})`)
  }
  return response
}

/** Readers that name the command in what they throw. */
function readers(cmd) {
  const boolOf = (node, what) => {
    const t = text(node)
    if (t === 'true') return true
    if (t === 'false') return false
    throw new Error(`${cmd}: ${what} is "${t}", not true or false`)
  }
  const intOf = (node, what) => {
    const t = text(node)
    if (!/^-?\d+$/.test(t)) throw new Error(`${cmd}: ${what} is "${t}", not a whole number`)
    return Number(t)
  }
  /** A numeric attribute, or null when the answer has none. */
  const attrInt = (node, name) => (/^-?\d+$/.test(String(node?.attrs[name] ?? '').trim()) ? Number(node.attrs[name]) : null)
  const idOf = (node, what) => {
    const id = node?.attrs.id
    if (!id) throw new Error(`${cmd}: ${what} has no id`)
    return id
  }
  return { boolOf, intOf, attrInt, idOf }
}

// The web client reads the trigger switches as `"true" == text` (a missing one is false) and sends
// them back that way; mirrored here because these are exactly the switches it sends.
const flag = (node) => text(node) === 'true'
// Answer-only switches are compared on read-back, never sent: null when the answer has none.
const flagOrNull = (node) => (node ? text(node) === 'true' : null)

/** The hold time and its choices. As the web client: the camera's own value is always a choice. */
function holdOf(param, name, r) {
  const node = kid(param, name)
  const note = kid(param, 'holdTimeNote')
  const choices = text(note).split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number)
  // no list: the web client's page greys the hold time out and sends it back empty
  if (!choices.length) return { holdTime: /^\d+$/.test(text(node)) ? Number(text(node)) : null, holdChoices: [] }
  const holdTime = r.intOf(node, name)
  if (!choices.includes(holdTime)) choices.push(holdTime)
  choices.sort((a, b) => a - b)
  return { holdTime, holdChoices: choices }
}

const chanList = (node, list, r, what) => kids(kid(node, list), 'item').map((it) => ({ id: r.idOf(it, what), name: text(it) }))
const presetList = (trig) => kids(kid(kid(trig, 'preset'), 'presets'), 'item').map((it) => ({
  index: text(kid(it, 'index')), name: text(kid(it, 'name')), chlId: kid(it, 'chl')?.attrs.id ?? '', chlName: text(kid(it, 'chl'))
}))

/** The trigger block perimeter, osc and avd share (and line crossing: tripwire-xml.mjs). */
function smartTrigger(trig, r) {
  const sysSnap = kid(trig, 'sysSnap')
  return {
    rec: chanList(kid(trig, 'sysRec'), 'chls', r, 'a recorded camera'),
    alarmOuts: chanList(kid(trig, 'alarmOut'), 'alarmOuts', r, 'an alarm output'),
    presets: presetList(trig),
    snap: flag(kid(trig, 'snapSwitch')),
    msgPush: flag(kid(trig, 'msgPushSwitch')),
    buzzer: flag(kid(trig, 'buzzerSwitch')),
    popVideo: flag(kid(trig, 'popVideoSwitch')),
    email: flag(kid(trig, 'emailSwitch')),
    sysAudio: kid(trig, 'sysAudio')?.attrs.id || NULL_GUID,
    // answer-only (never sent; compared on read-back)
    recOn: flagOrNull(kid(kid(trig, 'sysRec'), 'switch')),
    alarmOutOn: flagOrNull(kid(kid(trig, 'alarmOut'), 'switch')),
    presetOn: flagOrNull(kid(kid(trig, 'preset'), 'switch')),
    sysSnap: sysSnap ? { on: flag(kid(sysSnap, 'switch')), chls: kids(kid(sysSnap, 'chls'), 'item').map((it) => it.attrs.id ?? '') } : null,
    popMsg: flagOrNull(kid(trig, 'popMsgSwitch')),
    manualAudio: flagOrNull(kid(trig, 'manualAudioSwitch')),
    manualLight: flagOrNull(kid(trig, 'manualLightSwitch'))
  }
}

/** Motion's own trigger block: it has the switches and sysSnap, and keeps its schedule in here. */
function motionTrigger(trig, r) {
  return {
    // '' is the web client's "no schedule" for motion (not the null id the smart events use)
    schedule: kid(kid(trig, 'triggerSchedule'), 'schedule')?.attrs.id ?? '',
    recOn: flag(kid(kid(trig, 'sysRec'), 'switch')),
    rec: chanList(kid(trig, 'sysRec'), 'chls', r, 'a recorded camera'),
    snapOn: flag(kid(kid(trig, 'sysSnap'), 'switch')),
    snapChls: chanList(kid(trig, 'sysSnap'), 'chls', r, 'a snapshot camera'),
    alarmOutOn: flag(kid(kid(trig, 'alarmOut'), 'switch')),
    alarmOuts: chanList(kid(trig, 'alarmOut'), 'alarmOuts', r, 'an alarm output'),
    presetOn: flag(kid(kid(trig, 'preset'), 'switch')),
    presets: presetList(trig),
    msgPush: flag(kid(trig, 'msgPushSwitch')),
    buzzer: flag(kid(trig, 'buzzerSwitch')),
    popVideo: flag(kid(trig, 'popVideoSwitch')),
    popMsg: flag(kid(trig, 'popMsgSwitch')),
    email: flag(kid(trig, 'emailSwitch')),
    sysAudio: kid(trig, 'sysAudio')?.attrs.id || NULL_GUID
  }
}

/** The zones of a <boundary>: [{ points, maxPoints, name? }]. */
function zonesOf(boundary, r, cmd) {
  const items = kids(boundary, 'item')
  if (!items.length) throw new Error(`${cmd}: the answer has no zone slots`)
  if (boundary.attrs.count !== undefined && Number(boundary.attrs.count) !== items.length) {
    throw new Error(`${cmd}: the zone list says count="${boundary.attrs.count}" but has ${items.length} slots`)
  }
  return items.map((it, i) => {
    const list = kid(it, 'point')
    const name = kid(it, 'name')
    return {
      ...(name ? { name: name.text } : {}),
      points: kids(list, 'item').map((p, j) => ({ x: r.intOf(kid(p, 'X'), `zone ${i + 1} point ${j + 1} X`), y: r.intOf(kid(p, 'Y'), `zone ${i + 1} point ${j + 1} Y`) })),
      maxPoints: r.attrInt(list, 'maxCount')
    }
  })
}

// mutexListEx is the other half of a dual-lens (thermal) camera; the web client warns about both.
const mutexOf = (param) => [...kids(kid(param, 'mutexList'), 'item'), ...kids(kid(param, 'mutexListEx'), 'item')]
  .map((it) => ({ object: text(kid(it, 'object')), on: text(kid(it, 'status')) === 'true' }))

// Anything but "false" counts as on: the safe reading for a switch that decides a refusal.
const onUnlessFalse = (node) => (node ? text(node) !== 'false' : false)

function parseMotion(chl, r) {
  const param = kid(chl, 'param')
  const trig = kid(chl, 'trigger')
  if (!param && !trig) throw new Error('queryMotion: the answer has no motion settings (param/trigger) for this camera')
  const m = { param: null, trigger: trig ? motionTrigger(trig, r) : null }
  if (!param) return m
  const sens = kid(param, 'sensitivity')
  const area = kid(param, 'area')
  const rows = kids(area, 'item').map((it) => text(it))
  const cols = r.attrInt(kid(area, 'itemType'), 'maxLen')
  const count = r.attrInt(area, 'count')
  // The mask goes back exactly as read. One that is not the grid it says it is cannot be: it is
  // kept as null, and the param half is then not written at all (validate, buildEdit).
  const areaOk = area && count === rows.length && rows.length > 0 && cols > 0 && rows.every((row) => row.length === cols && /^[01]+$/.test(row))
  const filter = kid(param, 'objectFilter')
  const classes = {}
  for (const c of filter?.children ?? []) {
    if (!['car', 'person'].includes(c.name) || Object.hasOwn(classes, c.name)) throw new Error(`queryMotion: the object filter has <${c.name}>, which Argus does not know; change it on the NVR`)
    classes[c.name] = r.boolOf(kid(c, 'switch'), `${c.name} switch`)
  }
  m.param = {
    enabled: r.boolOf(kid(param, 'switch'), 'switch'),
    sensitivity: r.intOf(sens, 'sensitivity'),
    sensMin: r.attrInt(sens, 'min'),
    sensMax: r.attrInt(sens, 'max'),
    ...holdOf(param, 'holdTime', r),
    area: areaOk ? { rows } : null,
    // person/vehicle switches, sent back as read (not offered on the page)
    objectFilter: Object.keys(classes).length ? classes : null,
    triggerAudio: flagOrNull(kid(param, 'triggerAudio')) // answer-only
  }
  return m
}

const sizeOf = (node, r, what) => ({ width: r.intOf(kid(node, 'width'), `${what} width`), height: r.intOf(kid(node, 'height'), `${what} height`) })

/** One class of the person/vehicle filter: { on, sensitivity, sensMin, sensMax, min?, max? }. */
function classOf(node, r, cmd) {
  const name = node.name
  for (const c of node.children) {
    if (!CLASS_PARTS.includes(c.name)) throw new Error(`${cmd}: the ${name} filter has <${c.name}>, which Argus does not know; change it on the NVR`)
  }
  const min = kid(node, 'minDetectTarget')
  const max = kid(node, 'maxDetectTarget')
  // The web client sends both sizes whenever the minimum is there, and invents zeros for a missing
  // maximum. That shape is refused rather than copied.
  if (!min !== !max) throw new Error(`${cmd}: the ${name} filter has only one of its minimum/maximum sizes`)
  const sens = kid(node, 'sensitivity')
  return {
    on: r.boolOf(kid(node, 'switch'), `${name} switch`),
    sensitivity: r.intOf(sens, `${name} sensitivity`),
    sensMin: r.attrInt(sens, 'min'),
    sensMax: r.attrInt(sens, 'max'),
    ...(min ? { min: sizeOf(min, r, `${name} minimum size`), max: sizeOf(max, r, `${name} maximum size`) } : {})
  }
}

function parsePerimeter(chl, r) {
  const cmd = 'queryPerimeter'
  const param = kid(chl, 'param')
  const trig = kid(chl, 'trigger')
  if (!param || !trig) throw new Error(`${cmd}: the answer has no sterile-area settings (param/trigger) for this camera`)
  const boundary = kid(param, 'boundary')
  const objectFilter = kid(param, 'objectFilter')
  let filter = null
  if (objectFilter?.children.length) {
    filter = {}
    for (const c of objectFilter.children) {
      if (!CLASSES.includes(c.name) || filter[c.name]) throw new Error(`${cmd}: the object filter has <${c.name}>, which Argus does not know; change it on the NVR`)
      filter[c.name] = classOf(c, r, cmd)
    }
  }
  const target = kid(param, 'saveTargetPicture')
  const source = kid(param, 'saveSourcePicture')
  if (!target !== !source) throw new Error(`${cmd}: the answer has only one of saveTargetPicture/saveSourcePicture`)
  const single = kid(param, 'sensitivity')
  return {
    // As the web client does: no schedule on the camera means the null schedule.
    scheduleGuid: chl.attrs.scheduleGuid || NULL_GUID,
    enabled: r.boolOf(kid(param, 'switch'), 'switch'),
    ...holdOf(param, 'alarmHoldTime', r),
    zones: zonesOf(boundary, r, cmd),
    maxZones: r.attrInt(boundary, 'maxCount'),
    // "1": the camera's zones are rectangles, which this page does not draw
    regulation: boundary.attrs.regulation ?? '',
    // the one sensitivity of a model without a filter: sent back as read (its range is not in the answer)
    sensitivity: single ? r.intOf(single, 'sensitivity') : null,
    filter,
    mutex: mutexOf(param),
    triggerAudio: onUnlessFalse(kid(param, 'triggerAudio')),
    triggerWhiteLight: onUnlessFalse(kid(param, 'triggerWhiteLight')),
    saveTargetPicture: target ? r.boolOf(target, 'saveTargetPicture') : null,
    saveSourcePicture: source ? r.boolOf(source, 'saveSourcePicture') : null,
    autoTrack: text(kid(param, 'autoTrack')) || null,
    trigger: smartTrigger(trig, r)
  }
}

function parseOsc(chl, r, response) {
  const cmd = 'queryOsc'
  const param = kid(chl, 'param')
  const trig = kid(chl, 'trigger')
  if (!param || !trig) throw new Error(`${cmd}: the answer has no item-monitoring settings (param/trigger) for this camera`)
  const boundary = kid(param, 'boundary')
  const oscType = text(kid(param, 'oscType'))
  if (!oscType) throw new Error(`${cmd}: the answer does not say what is watched for (oscType)`)
  // The firmware's own list; just the camera's value if an answer ever leaves it out.
  const listed = kids(response, 'types').flatMap((t) => kids(kid(t, 'oscType'), 'enum')).map(text).filter(Boolean)
  const zones = zonesOf(boundary, r, cmd)
  for (const [i, z] of zones.entries()) if (z.name === undefined) throw new Error(`${cmd}: zone ${i + 1} has no name element`)
  return {
    scheduleGuid: chl.attrs.scheduleGuid || NULL_GUID,
    enabled: r.boolOf(kid(param, 'switch'), 'switch'),
    ...holdOf(param, 'holdTime', r),
    oscType,
    oscTypes: listed.includes(oscType) ? listed : [...listed, oscType],
    zones,
    maxZones: r.attrInt(boundary, 'maxCount'),
    regulation: boundary.attrs.regulation ?? '',
    mutex: mutexOf(param),
    trigger: smartTrigger(trig, r)
  }
}

function parseAvd(chl, r) {
  const cmd = 'queryAvd'
  const param = kid(chl, 'param')
  const trig = kid(chl, 'trigger')
  if (!param || !trig) throw new Error(`${cmd}: the answer has no fault settings (param/trigger) for this camera`)
  const sens = kid(param, 'sensitivity')
  const switches = {}
  // absent or empty: the camera lacks that check, and the web client then does not send it
  for (const k of AVD_SWITCHES) {
    const node = kid(param, `${k}Switch`)
    switches[k] = node && text(node) !== '' ? r.boolOf(node, `${k}Switch`) : null
  }
  return {
    switches,
    sensitivity: r.intOf(sens, 'sensitivity'),
    // the web client's slider is fixed at 1-100; the answer's own range wins when it gives one
    sensMin: r.attrInt(sens, 'min') ?? 1,
    sensMax: r.attrInt(sens, 'max') ?? 100,
    ...holdOf(param, 'holdTime', r),
    mutex: mutexOf(param),
    triggerAudio: flagOrNull(kid(param, 'triggerAudio')), // answer-only
    trigger: smartTrigger(trig, r)
  }
}

/**
 * One camera's settings of this kind from its query answer: a plain model that carries everything
 * the edit needs, shown on the page or not. name: the camera's name, written beside its id when a
 * change links the camera to its own recording. Throws Error('<reason>') for a refusal or anything
 * it cannot read exactly.
 * A motion model is { kind, chlId, name, param, trigger }, either half null when not asked for.
 */
export function parse(kind, xml, { name = '' } = {}) {
  kindOk(kind)
  const cmd = COMMANDS[kind].query
  const response = answerOf(xml, cmd)
  const chl = kid(kid(response, 'content'), 'chl')
  if (!chl?.attrs.id) throw new Error(`${cmd}: the answer names no camera`)
  const r = readers(cmd)
  const body = kind === 'motion' ? parseMotion(chl, r) : kind === 'perimeter' ? parsePerimeter(chl, r) : kind === 'osc' ? parseOsc(chl, r, response) : parseAvd(chl, r)
  return { kind, chlId: chl.attrs.id, name: String(name ?? ''), ...body }
}

/** A motion model from its two answers (either may be the whole thing): the halves of both. */
export function mergeMotion(a, b) {
  if (!sameId(a.chlId, b.chlId)) throw new Error('queryMotion: the two halves are for different cameras')
  return { ...a, param: a.param ?? b.param, trigger: a.trigger ?? b.trigger }
}

/**
 * Which cameras have which of these detections, from queryNodeList (requireField supportPea,
 * supportOsc, supportAvd: tripwire.mjs asks for them already): chlId -> { pea, osc, avd }.
 */
export function parseDetections(xml) {
  const response = answerOf(xml, 'queryNodeList')
  const out = new Map()
  for (const it of kids(kid(response, 'content'), 'item')) {
    if (!it.attrs.id) continue
    const has = (name) => text(kid(it, name)) === 'true'
    out.set(it.attrs.id, { pea: has('supportPea'), osc: has('supportOsc'), avd: has('supportAvd') })
  }
  return out
}

// ---- what the page is given ----------------------------------------------------------------------

const zoneMax = (kind, z) => (kind === 'osc' ? Math.min(z.maxPoints ?? OSC_POINTS_MAX, OSC_POINTS_MAX) : z.maxPoints ?? OSC_POINTS_MAX)

/** Why no change at all can be made to this camera's settings of this kind, or null. */
function blockedOf(kind, model) {
  if (kind === 'perimeter' && (model.triggerAudio || model.triggerWhiteLight)) {
    return 'The camera\'s sound/white-light trigger is on; set it off on the recorder first — the floodlight is worked by hand only'
  }
  return null
}

const conflictsOf = (model) => [...new Set((model.mutex ?? []).filter((m) => m.on).map((m) => MUTEX_WORDS[m.object] ?? m.object))]

function triggerView(kind, t) {
  if (!t) return null
  return kind === 'motion'
    ? { record: t.recOn, snapshot: t.snapOn, push: t.msgPush, buzzer: t.buzzer, popVideo: t.popVideo, email: t.email }
    // a smart event has no record switch of its own: it records the cameras in its list
    : { record: t.rec.length > 0, snapshot: t.snap, push: t.msgPush, buzzer: t.buzzer, popVideo: t.popVideo, email: t.email }
}

/**
 * The settings as the page shows them, and as a change names them: only what an admin can read in
 * plain words. Nothing here is written back; the edit is always built from the model.
 */
export function viewOf(kind, model) {
  kindOk(kind)
  const v = { blocked: blockedOf(kind, model), conflicts: conflictsOf(model) }
  const zones = () => {
    v.zones = model.zones.map((z) => ({ ...(kind === 'osc' ? { name: z.name } : {}), points: z.points.map((p) => ({ x: p.x, y: p.y })) }))
    v.minPoints = MIN_ZONE_POINTS
    v.maxPoints = Math.min(...model.zones.map((z) => zoneMax(kind, z)))
    v.zonesEditable = model.regulation !== '1'
  }
  if (kind === 'motion') {
    const p = model.param
    if (p) {
      Object.assign(v, { enabled: p.enabled, holdTime: p.holdTime, holdChoices: p.holdChoices })
      v.sensitivity = p.sensMin !== null && p.sensMax !== null ? { value: p.sensitivity, min: p.sensMin, max: p.sensMax } : null
      // the mask's rows are not shown: which corner row 0 is has not been checked on a camera.
      // Whole picture / nothing needs no orientation.
      v.area = !p.area ? null : p.area.rows.every((row) => !row.includes('0')) ? 'all' : p.area.rows.every((row) => !row.includes('1')) ? 'none' : 'some'
    }
    if (model.trigger) Object.assign(v, { schedule: model.trigger.schedule, noSchedule: '', trigger: triggerView(kind, model.trigger) })
    return v
  }
  if (kind === 'avd') {
    v.switches = Object.fromEntries(AVD_SWITCHES.filter((k) => model.switches[k] !== null).map((k) => [k, model.switches[k]]))
    v.sensitivity = { value: model.sensitivity, min: model.sensMin, max: model.sensMax }
  } else {
    Object.assign(v, { enabled: model.enabled, schedule: model.scheduleGuid, noSchedule: NULL_GUID })
    zones()
  }
  Object.assign(v, { holdTime: model.holdTime, holdChoices: model.holdChoices })
  if (kind === 'perimeter') {
    v.filter = model.filter
      ? Object.fromEntries(CLASSES.filter((k) => model.filter[k]).map((k) => [k, { on: model.filter[k].on, sensitivity: model.filter[k].sensitivity, min: model.filter[k].sensMin ?? 1, max: model.filter[k].sensMax ?? 100 }]))
      : null
  }
  if (kind === 'osc') Object.assign(v, { oscType: model.oscType, oscTypes: model.oscTypes })
  v.trigger = triggerView(kind, model.trigger)
  return v
}

// ---- a change ------------------------------------------------------------------------------------

/** The keys a change may carry, by kind (and by half for motion). */
const CHANGE_KEYS = {
  'motion:param': ['enabled', 'sensitivity', 'holdTime'],
  'motion:trigger': ['schedule', 'trigger'],
  perimeter: ['enabled', 'holdTime', 'schedule', 'zones', 'filter', 'trigger'],
  osc: ['enabled', 'holdTime', 'schedule', 'oscType', 'zones', 'trigger'],
  avd: ['switches', 'sensitivity', 'holdTime', 'trigger']
}

/**
 * Which half of motion a change belongs to, from its keys: 'param' or 'trigger'. The two are
 * separate writes (as the web client's two pages are), so a change that names both is refused.
 */
export function motionPartOf(change) {
  const keys = isObj(change) ? Object.keys(change) : []
  const inParam = keys.some((k) => CHANGE_KEYS['motion:param'].includes(k))
  const inTrigger = keys.some((k) => CHANGE_KEYS['motion:trigger'].includes(k))
  if (inParam && inTrigger) throw new Error('Motion\'s detection settings and what it triggers are saved separately: send one, then the other')
  return inTrigger ? 'trigger' : 'param'
}

/** This camera as an entry of a "which cameras" list. */
const self = (model) => ({ id: model.chlId, name: model.name })

/**
 * The model with `change` applied: a deep copy, `model` is untouched. Only what the change names
 * moves. Meant to run after validate; a change that does not fit this camera at all throws.
 */
export function applyChange(kind, model, change) {
  kindOk(kind)
  const next = structuredClone(model)
  const c = isObj(change) ? change : {}
  const p = kind === 'motion' ? next.param : next
  const t = next.trigger
  const needs = (half, what) => { if (!half) throw new Error(`The camera's ${what} were not read`) }
  if ('enabled' in c) { needs(p, 'detection settings'); p.enabled = c.enabled }
  if ('holdTime' in c) { needs(p, 'detection settings'); p.holdTime = c.holdTime }
  if ('sensitivity' in c) { needs(p, 'detection settings'); p.sensitivity = c.sensitivity }
  if ('schedule' in c) {
    if (kind === 'motion') { needs(t, 'trigger settings'); t.schedule = c.schedule } else next.scheduleGuid = c.schedule
  }
  if ('oscType' in c) next.oscType = c.oscType
  if ('switches' in c) for (const [k, v] of Object.entries(c.switches)) next.switches[k] = v
  if ('zones' in c) {
    if (!Array.isArray(c.zones) || c.zones.length !== model.zones.length) throw new Error(`The change must list all ${model.zones.length} zones`)
    next.zones = next.zones.map((old, i) => ({ ...old, points: c.zones[i].map((q) => ({ x: q.x, y: q.y })) }))
  }
  if ('filter' in c) {
    if (!next.filter) throw new Error('This camera has no person/vehicle filter')
    for (const [k, v] of Object.entries(c.filter)) {
      if (!Object.hasOwn(next.filter, k)) throw new Error(`This camera's filter has no ${k} class`)
      if ('on' in v) next.filter[k].on = v.on
      if ('sensitivity' in v) next.filter[k].sensitivity = v.sensitivity
    }
  }
  if ('trigger' in c) {
    needs(t, 'trigger settings')
    const g = c.trigger
    if (kind === 'motion') {
      // a switch that goes on with nobody in its list means this camera, as the NVR's own default is
      if ('record' in g) { t.recOn = g.record; if (g.record && !t.rec.length) t.rec = [self(model)] }
      if ('snapshot' in g) { t.snapOn = g.snapshot; if (g.snapshot && !t.snapChls.length) t.snapChls = [self(model)] }
    } else {
      // "Record" for a smart event is its list of cameras: off empties it, on puts this camera in
      if ('record' in g && g.record !== t.rec.length > 0) t.rec = g.record ? [self(model)] : []
      if ('snapshot' in g) t.snap = g.snapshot
    }
    if ('push' in g) t.msgPush = g.push
    if ('buzzer' in g) t.buzzer = g.buzzer
    if ('popVideo' in g) t.popVideo = g.popVideo
    if ('email' in g) t.email = g.email
  }
  return next
}

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
const within = (a, b, p) => Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y)
/** Whether segments ab and cd touch or cross. */
function segmentsMeet(a, b, c, d) {
  const d1 = cross(a, b, c)
  const d2 = cross(a, b, d)
  const d3 = cross(c, d, a)
  const d4 = cross(c, d, b)
  if (d1 * d2 < 0 && d3 * d4 < 0) return true
  return (d1 === 0 && within(a, b, c)) || (d2 === 0 && within(a, b, d)) || (d3 === 0 && within(c, d, a)) || (d4 === 0 && within(c, d, b))
}

/**
 * Whether a closed shape crosses itself (two sides that are not neighbours meet), or has no area
 * at all. The web client refuses such a zone ("cannot be closed"); so does this.
 */
export function selfCrossing(points) {
  const n = points.length
  if (n < 3) return false
  let area = 0
  for (let i = 0; i < n; i++) area += points[i].x * points[(i + 1) % n].y - points[(i + 1) % n].x * points[i].y
  if (area === 0) return true
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue // neighbours share a corner
      if (segmentsMeet(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return true
    }
  }
  return false
}

function zonesProblem(kind, model, zones) {
  if (model.regulation === '1') return 'This camera\'s zones are rectangles; set them on the recorder'
  const n = model.zones.length
  if (!Array.isArray(zones) || zones.length !== n) return `The change must list all ${n} zone${n === 1 ? '' : 's'} (an empty zone is an empty list)`
  for (const [i, z] of zones.entries()) {
    const slot = `Zone ${i + 1}`
    const max = zoneMax(kind, model.zones[i])
    if (!Array.isArray(z)) return `${slot} must be a list of points`
    if (z.length === 0) continue
    if (z.length < MIN_ZONE_POINTS) return `${slot} needs at least ${MIN_ZONE_POINTS} corners (or none at all)`
    if (z.length > max) return `${slot} can have at most ${max} corners on this camera`
    for (const q of z) {
      if (!isObj(q) || Object.keys(q).length !== 2 || !Object.hasOwn(q, 'x') || !Object.hasOwn(q, 'y')) return `${slot}: every point must be { x, y }`
      if (![q.x, q.y].every((v) => Number.isInteger(v) && v >= 0 && v <= UNITS)) return `${slot}: points must be whole numbers from 0 to ${UNITS}`
    }
    if (selfCrossing(z)) return `${slot} crosses itself; draw it so its sides do not cross`
  }
  return null
}

const rangeProblem = (v, min, max, what) => (Number.isInteger(v) && v >= min && v <= max ? null : `${what} must be a whole number from ${min} to ${max}`)

function filterProblem(model, f) {
  if (!model.filter) return 'This camera has no person/vehicle filter'
  if (!isObj(f)) return 'filter must be an object'
  for (const [k, v] of Object.entries(f)) {
    if (!Object.hasOwn(model.filter, k)) return `This camera's filter has no ${k} class`
    const word = CLASS_WORDS[k] ?? k
    if (!isObj(v)) return `${word} must be { on, sensitivity }`
    const odd = Object.keys(v).filter((x) => x !== 'on' && x !== 'sensitivity')
    if (odd.length) return `${word}: unknown setting ${odd.join(', ')}`
    if ('on' in v && typeof v.on !== 'boolean') return `${word}: on must be true or false`
    if ('sensitivity' in v) {
      const why = rangeProblem(v.sensitivity, model.filter[k].sensMin ?? 1, model.filter[k].sensMax ?? 100, `${word} sensitivity`)
      if (why) return why
    }
  }
  return null
}

function boolsProblem(obj, allowed, words, what) {
  if (!isObj(obj)) return `${what} must be an object`
  for (const [k, v] of Object.entries(obj)) {
    if (!allowed.includes(k)) return `${what}: this camera has no "${k}"`
    if (typeof v !== 'boolean') return `${words[k] ?? k} must be true or false`
  }
  return null
}

/**
 * Throws Error('<reason>') unless `change` may be sent to this camera: only settings this route
 * changes, every value among the camera's or the NVR's own choices, and something actually changed.
 * part: 'param' or 'trigger' (motion only). schedules (the NVR's list, [{ id, name }]) is checked
 * when the change names one.
 */
export function validate(kind, model, change, { part = null, schedules = [] } = {}) {
  kindOk(kind)
  const refuse = (why) => { throw new Error(why) }
  const blocked = blockedOf(kind, model)
  if (blocked) refuse(blocked)
  if (!isObj(change)) refuse('The change must be an object')
  if (kind === 'motion' && !MOTION_PARTS.includes(part)) refuse('A motion change is for its param or its trigger half')
  const allowed = CHANGE_KEYS[gateKey(kind, part)]
  const unknown = Object.keys(change).filter((k) => !allowed.includes(k))
  if (unknown.length) refuse(`Unknown setting${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`)
  const p = kind === 'motion' ? model.param : model
  const t = model.trigger
  if (kind === 'motion' && part === 'param') {
    if (!p) refuse('The camera\'s motion settings were not read')
    // these two go back as read; without them the document the web client sends cannot be built
    if (!p.area) refuse('The camera\'s detection area could not be read exactly, so its motion settings are not changed from here; use the recorder')
    if (p.sensMin === null || p.sensMax === null) refuse('The camera did not give its sensitivity range, so its motion settings are not changed from here; use the recorder')
  }
  if (kind === 'motion' && part === 'trigger' && !t) refuse('The camera\'s motion trigger settings were not read')

  if ('enabled' in change && typeof change.enabled !== 'boolean') refuse('enabled must be true or false')
  if ('holdTime' in change) {
    if (!p.holdChoices.length) refuse('This camera does not let its hold time be chosen')
    if (!p.holdChoices.includes(change.holdTime)) refuse(`Hold time must be one the camera offers (${p.holdChoices.join(', ')} s)`)
  }
  if ('sensitivity' in change) {
    const why = rangeProblem(change.sensitivity, p.sensMin, p.sensMax, 'Sensitivity')
    if (why) refuse(why)
  }
  if ('schedule' in change) {
    const g = change.schedule
    const none = kind === 'motion' ? '' : NULL_GUID
    if (typeof g !== 'string') refuse('schedule must be a schedule id')
    if (g !== none) {
      if (!GUID.test(g)) refuse('schedule must be a schedule id like {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}')
      if (!schedules.some((s) => s.id === g)) refuse('That schedule is not one of the recorder\'s schedules')
    }
  }
  if ('oscType' in change && !model.oscTypes.includes(change.oscType)) refuse(`What to watch for must be one of ${model.oscTypes.join(', ')}`)
  if ('switches' in change) {
    const why = boolsProblem(change.switches, AVD_SWITCHES.filter((k) => model.switches[k] !== null), AVD_WORDS, 'switches')
    if (why) refuse(why)
  }
  if ('zones' in change) {
    const why = zonesProblem(kind, model, change.zones)
    if (why) refuse(why)
  }
  if ('filter' in change) {
    const why = filterProblem(model, change.filter)
    if (why) refuse(why)
  }
  if ('trigger' in change) {
    const why = boolsProblem(change.trigger, TRIGGER_KEYS, TRIGGER_WORDS, 'trigger')
    if (why) refuse(why)
  }

  const next = applyChange(kind, model, change)
  // NVR relay outputs are never switched on from here: with one linked to this detection,
  // switching it on would work the relay every time it fires (tripwire-xml.mjs has the same rule)
  if (kind !== 'motion' && t.alarmOuts.length > 0) {
    const on = (m) => (kind === 'avd' ? AVD_SWITCHES.some((k) => m.switches[k] === true) : m.enabled)
    if (on(next) && !on(model)) refuse('This detection has a recorder alarm output (relay) linked; take it out on the recorder first — the floodlight is worked by hand only')
  }
  const before = flatten(kind, model)
  const after = flatten(kind, next)
  if ([...new Set([...Object.keys(before), ...Object.keys(after)])].every((k) => before[k] === after[k])) refuse('Nothing to change: the camera already has these settings')
}

// ---- the edit documents --------------------------------------------------------------------------

const cdata = (v) => `<![CDATA[${String(v).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`

/** Writers that name the command in what they throw: a value that is not exactly right is never sent. */
function writers(cmd) {
  const bool = (v, what) => {
    if (typeof v !== 'boolean') throw new Error(`${cmd}: ${what} is ${JSON.stringify(v)}, not true or false`)
    return String(v)
  }
  const whole = (v, what, lo = 0, hi = Number.MAX_SAFE_INTEGER) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${cmd}: ${what} is ${JSON.stringify(v)}, not a whole number from ${lo} to ${hi}`)
    return String(v)
  }
  const guid = (v, what) => {
    if (typeof v !== 'string' || !GUID.test(v)) throw new Error(`${cmd}: ${what} is ${JSON.stringify(v)}, not an id`)
    return v
  }
  return { bool, whole, guid }
}

const chanItems = (list) => list.map((c) => `<item id="${esc(c.id)}">${cdata(c.name)}</item>`).join('')
// as the web client: a preset without an index is not sent
const presetItems = (list) => list.filter((p) => p.index)
  .map((p) => `<item><index>${esc(p.index)}</index><name>${cdata(p.name)}</name><chl id="${esc(p.chlId)}">${cdata(p.chlName)}</chl></item>`).join('')

/** The nine elements perimeter, osc and avd send as <trigger>, in the web client's order. */
function smartTriggerXml(t, w) {
  return `<trigger><sysRec><chls type="list">${chanItems(t.rec)}</chls></sysRec>` +
    `<alarmOut><alarmOuts type="list">${chanItems(t.alarmOuts)}</alarmOuts></alarmOut>` +
    `<preset><presets type="list">${presetItems(t.presets)}</presets></preset>` +
    `<snapSwitch>${w.bool(t.snap, 'snapSwitch')}</snapSwitch><msgPushSwitch>${w.bool(t.msgPush, 'msgPushSwitch')}</msgPushSwitch>` +
    `<buzzerSwitch>${w.bool(t.buzzer, 'buzzerSwitch')}</buzzerSwitch><popVideoSwitch>${w.bool(t.popVideo, 'popVideoSwitch')}</popVideoSwitch>` +
    `<emailSwitch>${w.bool(t.email, 'emailSwitch')}</emailSwitch><sysAudio id='${w.guid(t.sysAudio, 'sysAudio')}'></sysAudio></trigger>`
}

const pointsXml = (z, i, w) => z.points
  .map((p, j) => `<item><X>${w.whole(p.x, `zone ${i + 1} point ${j + 1} x`, 0, UNITS)}</X><Y>${w.whole(p.y, `zone ${i + 1} point ${j + 1} y`, 0, UNITS)}</Y></item>`).join('')

const holdXml = (name, v, w) => `<${name} unit="s">${v === null ? '' : w.whole(v, 'hold time', 1)}</${name}>`

/** editMotion, the detection half (motion.js): <param> only, the area mask exactly as read. */
function motionParamXml(m, w) {
  const p = m.param
  if (!p) throw new Error('editMotion: the camera\'s motion settings were not read')
  if (!p.area) throw new Error('editMotion: the detection area could not be read exactly, so it cannot be sent back')
  if (p.sensMin === null || p.sensMax === null) throw new Error('editMotion: the camera did not give its sensitivity range')
  let x = `<param><switch>${w.bool(p.enabled, 'switch')}</switch>`
  if (p.objectFilter) {
    x += '<objectFilter>'
    // the web client's order (the answer's is person then car)
    for (const k of ['car', 'person']) if (Object.hasOwn(p.objectFilter, k)) x += `<${k}><switch>${w.bool(p.objectFilter[k], `${k} switch`)}</switch></${k}>`
    x += '</objectFilter>'
  }
  x += `<sensitivity min="${p.sensMin}" max="${p.sensMax}">${w.whole(p.sensitivity, 'sensitivity', p.sensMin, p.sensMax)}</sensitivity>`
  x += holdXml('holdTime', p.holdTime, w)
  const cols = p.area.rows[0].length
  x += `<area type="list" count="${p.area.rows.length}"><itemType minLen="${cols}" maxLen="${cols}"/>`
  for (const row of p.area.rows) {
    if (row.length !== cols || !/^[01]+$/.test(row)) throw new Error('editMotion: the detection area is not the grid the camera gave')
    x += `<item>${row}</item>`
  }
  return `${x}</area></param>`
}

/** editMotion, the linkage half (motionAlarmCfg.js): <trigger> only, with its switches and sysSnap. */
function motionTriggerXml(m, w) {
  const t = m.trigger
  if (!t) throw new Error('editMotion: the camera\'s motion trigger settings were not read')
  // as the web client: a list whose switch is off is sent empty
  const on = (flagOn, items) => (flagOn ? items : '')
  if (t.schedule !== '') w.guid(t.schedule, 'schedule')
  return `<trigger><sysRec><switch>${w.bool(t.recOn, 'sysRec switch')}</switch><chls type="list">${on(t.recOn, chanItems(t.rec))}</chls></sysRec>` +
    `<alarmOut><switch>${w.bool(t.alarmOutOn, 'alarmOut switch')}</switch><alarmOuts type="list">${on(t.alarmOutOn, chanItems(t.alarmOuts))}</alarmOuts></alarmOut>` +
    `<preset><switch>${w.bool(t.presetOn, 'preset switch')}</switch><presets type="list">${on(t.presetOn, presetItems(t.presets))}</presets></preset>` +
    `<sysSnap><switch>${w.bool(t.snapOn, 'sysSnap switch')}</switch><chls type="list">${on(t.snapOn, chanItems(t.snapChls))}</chls></sysSnap>` +
    `<buzzerSwitch>${w.bool(t.buzzer, 'buzzerSwitch')}</buzzerSwitch><msgPushSwitch>${w.bool(t.msgPush, 'msgPushSwitch')}</msgPushSwitch>` +
    `<sysAudio id='${w.guid(t.sysAudio, 'sysAudio')}'></sysAudio>` +
    `<triggerSchedule><switch>${t.schedule ? 'true' : 'false'}</switch><schedule id="${esc(t.schedule)}"></schedule></triggerSchedule>` +
    `<popVideoSwitch>${w.bool(t.popVideo, 'popVideoSwitch')}</popVideoSwitch><popMsgSwitch>${w.bool(t.popMsg, 'popMsgSwitch')}</popMsgSwitch>` +
    `<emailSwitch>${w.bool(t.email, 'emailSwitch')}</emailSwitch></trigger>`
}

function perimeterXml(m, w) {
  if (m.triggerAudio || m.triggerWhiteLight) throw new Error('editPerimeter: refusing to write, the camera\'s sound/white-light trigger is on')
  const size = (tag, s, what) => `<${tag}><width>${w.whole(s.width, `${what} width`, 0, UNITS)}</width><height>${w.whole(s.height, `${what} height`, 0, UNITS)}</height></${tag}>`
  let x = `<param><switch>${w.bool(m.enabled, 'switch')}</switch>${holdXml('alarmHoldTime', m.holdTime, w)}`
  x += `<boundary type="list" count="${m.zones.length}"><itemType><point type="list"/></itemType>`
  for (const [i, z] of m.zones.entries()) {
    x += `<item><point type="list" maxCount="${w.whole(z.maxPoints, `zone ${i + 1} maxCount`, 1)}" count="${z.points.length}">${pointsXml(z, i, w)}</point></item>`
  }
  x += '</boundary>'
  // source first, target second: the web client's order here, the reverse of line crossing's
  if (m.saveSourcePicture !== null) {
    x += `<saveSourcePicture>${w.bool(m.saveSourcePicture, 'saveSourcePicture')}</saveSourcePicture><saveTargetPicture>${w.bool(m.saveTargetPicture, 'saveTargetPicture')}</saveTargetPicture>`
  }
  if (m.autoTrack) x += `<autoTrack>${esc(m.autoTrack)}</autoTrack>`
  if (m.sensitivity !== null) x += `<sensitivity>${w.whole(m.sensitivity, 'sensitivity', 0, 100)}</sensitivity>`
  if (m.filter) {
    x += '<objectFilter>'
    for (const k of CLASSES) {
      const c = m.filter[k]
      if (!c) continue // exactly the classes that were read
      x += `<${k}><switch>${w.bool(c.on, `${k} switch`)}</switch><sensitivity>${w.whole(c.sensitivity, `${k} sensitivity`, 0, 100)}</sensitivity>`
      if (c.min) x += size('minDetectTarget', c.min, `${k} minimum`) + size('maxDetectTarget', c.max, `${k} maximum`)
      x += `</${k}>`
    }
    x += '</objectFilter>'
  }
  return `${x}</param>${smartTriggerXml(m.trigger, w)}`
}

function oscXml(m, w) {
  // "lis" is the web client's own spelling of this one attribute, and what the firmware is known to take
  let x = `<param><switch>${w.bool(m.enabled, 'switch')}</switch>${holdXml('holdTime', m.holdTime, w)}<oscType>${esc(m.oscType)}</oscType>`
  x += `<boundary type="lis" count="${m.zones.length}"><itemType><point type="list"/></itemType>`
  for (const [i, z] of m.zones.entries()) {
    if (z.points.length > OSC_POINTS_MAX) throw new Error(`editOsc: zone ${i + 1} has more than ${OSC_POINTS_MAX} points`)
    x += `<item><name maxLen="${OSC_NAME_MAX}">${cdata(z.name)}</name><point type="list" maxCount="${OSC_POINTS_MAX}" count="${z.points.length}">${pointsXml(z, i, w)}</point></item>`
  }
  return `${x}</boundary></param>${smartTriggerXml(m.trigger, w)}`
}

function avdXml(m, w) {
  let x = `<param>${holdXml('holdTime', m.holdTime, w)}<sensitivity>${w.whole(m.sensitivity, 'sensitivity', m.sensMin, m.sensMax)}</sensitivity>`
  // each check only when the answer had it
  for (const k of AVD_SWITCHES) if (m.switches[k] !== null) x += `<${k}Switch>${w.bool(m.switches[k], `${k}Switch`)}</${k}Switch>`
  return `${x}</param>${smartTriggerXml(m.trigger, w)}`
}

/**
 * The edit document for the model that was just read with `change` applied, element for element
 * as the web client builds it. part: 'param' or 'trigger' (motion only: its two halves are two
 * writes). Throws rather than send a value that is not exactly right.
 */
export function buildEdit(kind, model, change = {}, part = null) {
  kindOk(kind)
  const cmd = COMMANDS[kind].edit
  const w = writers(cmd)
  const m = applyChange(kind, model, change)
  const id = esc(w.guid(m.chlId, 'the camera id'))
  let chl
  if (kind === 'motion') {
    if (!MOTION_PARTS.includes(part)) throw new Error('editMotion is sent for its param or its trigger half')
    chl = `<chl id="${id}">${part === 'param' ? motionParamXml(m, w) : motionTriggerXml(m, w)}</chl>`
  } else if (kind === 'avd') {
    chl = `<chl id="${id}">${avdXml(m, w)}</chl>` // no schedule: the three switches are the feature
  } else {
    chl = `<chl id="${id}" scheduleGuid="${esc(w.guid(m.scheduleGuid, 'the schedule'))}">${kind === 'perimeter' ? perimeterXml(m, w) : oscXml(m, w)}</chl>`
  }
  return `${XML_HEADER}<content>${chl}</content></request>`
}

// ---- read-back -----------------------------------------------------------------------------------

/**
 * Every field of the model as key -> string, sent or answer-only, for comparing two reads.
 * A field the answer does not have is left out.
 */
export function flatten(kind, model) {
  kindOk(kind)
  const out = {}
  const put = (k, v) => { if (v !== null && v !== undefined) out[k] = String(v) }
  const ids = (list) => list.map((c) => c.id).join(',')
  if (kind === 'motion') {
    const p = model.param
    if (p) {
      put('enabled', p.enabled)
      put('sensitivity', p.sensitivity)
      put('holdTime', p.holdTime)
      put('area', p.area?.rows.join('/'))
      for (const [k, v] of Object.entries(p.objectFilter ?? {})) put(`filter.${k}.on`, v)
      put('triggerAudio', p.triggerAudio)
    }
    const t = model.trigger
    if (t) {
      put('schedule', t.schedule)
      put('trigger.record', t.recOn)
      put('trigger.rec', ids(t.rec))
      put('trigger.snapshot', t.snapOn)
      put('trigger.snapChls', ids(t.snapChls))
      put('trigger.alarmOutOn', t.alarmOutOn)
      put('trigger.alarmOuts', ids(t.alarmOuts))
      put('trigger.presetOn', t.presetOn)
      put('trigger.presets', t.presets.map((x) => `${x.chlId}:${x.index}`).join(','))
      put('trigger.push', t.msgPush)
      put('trigger.buzzer', t.buzzer)
      put('trigger.popVideo', t.popVideo)
      put('trigger.popMsg', t.popMsg)
      put('trigger.email', t.email)
      put('trigger.sysAudio', t.sysAudio)
    }
    return out
  }
  if (kind === 'avd') {
    for (const k of AVD_SWITCHES) put(`switches.${k}`, model.switches[k])
    put('triggerAudio', model.triggerAudio)
  } else {
    put('enabled', model.enabled)
    put('schedule', model.scheduleGuid)
    model.zones.forEach((z, i) => {
      put(`zone.${i}`, z.points.map((p) => `${p.x},${p.y}`).join(' '))
      put(`zone.${i}.name`, z.name)
    })
  }
  put('holdTime', model.holdTime)
  put('sensitivity', model.sensitivity)
  put('oscType', model.oscType)
  if (kind === 'perimeter') {
    for (const k of CLASSES) {
      const c = model.filter?.[k]
      if (!c) continue
      put(`filter.${k}.on`, c.on)
      put(`filter.${k}.sensitivity`, c.sensitivity)
      if (c.min) put(`filter.${k}.min`, `${c.min.width}x${c.min.height}`)
      if (c.max) put(`filter.${k}.max`, `${c.max.width}x${c.max.height}`)
    }
    put('triggerAudio', model.triggerAudio)
    put('triggerWhiteLight', model.triggerWhiteLight)
    put('saveTargetPicture', model.saveTargetPicture)
    put('saveSourcePicture', model.saveSourcePicture)
    put('autoTrack', model.autoTrack)
  }
  // A detection named twice (mutexList and mutexListEx) gets ".2" so neither hides the other.
  const seen = new Map()
  for (const m of model.mutex ?? []) {
    const n = (seen.get(m.object) ?? 0) + 1
    seen.set(m.object, n)
    put(`mutex.${m.object}${n > 1 ? `.${n}` : ''}`, m.on)
  }
  const t = model.trigger
  put('trigger.record', t.rec.length > 0)
  put('trigger.rec', ids(t.rec))
  put('trigger.alarmOuts', ids(t.alarmOuts))
  put('trigger.presets', t.presets.map((x) => `${x.chlId}:${x.index}`).join(','))
  put('trigger.snapshot', t.snap)
  put('trigger.push', t.msgPush)
  put('trigger.buzzer', t.buzzer)
  put('trigger.popVideo', t.popVideo)
  put('trigger.email', t.email)
  put('trigger.sysAudio', t.sysAudio)
  put('trigger.recOn', t.recOn)
  put('trigger.alarmOutOn', t.alarmOutOn)
  put('trigger.presetOn', t.presetOn)
  put('trigger.sysSnap', t.sysSnap && `${t.sysSnap.on}${t.sysSnap.chls.length ? ` ${t.sysSnap.chls.join(',')}` : ''}`)
  put('trigger.popMsg', t.popMsg)
  put('trigger.manualAudio', t.manualAudio)
  put('trigger.manualLight', t.manualLight)
  return out
}

/** A flatten() key in words for the page. */
export function fieldLabel(key) {
  const fixed = {
    enabled: 'On/off', holdTime: 'Hold the alarm for', sensitivity: 'Sensitivity', schedule: 'Schedule', oscType: 'What to watch for',
    'trigger.rec': 'Cameras recorded', 'trigger.snapChls': 'Cameras that take a snapshot'
  }
  if (fixed[key]) return fixed[key]
  let m
  if ((m = /^zone\.(\d+)$/.exec(key))) return `Zone ${Number(m[1]) + 1}`
  if ((m = /^filter\.(\w+)\.(on|sensitivity)$/.exec(key))) return `${CLASS_WORDS[m[1]] ?? m[1]} ${m[2] === 'on' ? 'detection' : 'sensitivity'}`
  if ((m = /^switches\.(\w+)$/.exec(key))) return AVD_WORDS[m[1]] ?? m[1]
  if ((m = /^trigger\.(\w+)$/.exec(key))) return TRIGGER_WORDS[m[1]] ?? key
  return key
}

/**
 * What the camera did with a change. `before`: the read the change was built on; `asked`:
 * applyChange(before, change); `after`: the read-back (for motion, of the half that was written).
 * differences: every field the change moved that the read-back does not show as asked.
 * sideEffects: every other field that differs between before and after.
 */
export function compareReadBack(kind, before, asked, after) {
  const b = flatten(kind, before)
  const a = flatten(kind, asked)
  const r = flatten(kind, after)
  const val = (m, k) => (Object.hasOwn(m, k) ? m[k] : null)
  // a motion read-back holds only the half that was written: the other half's keys are not compared
  const keys = kind === 'motion' ? Object.keys(r) : [...new Set([...Object.keys(b), ...Object.keys(a), ...Object.keys(r)])]
  const changed = []
  const differences = []
  const sideEffects = []
  for (const k of keys) {
    if (val(a, k) !== val(b, k)) {
      changed.push(k)
      if (val(r, k) !== val(a, k)) differences.push({ key: k, label: fieldLabel(k), wanted: val(a, k), got: val(r, k) })
    } else if (val(r, k) !== val(b, k)) {
      sideEffects.push({ key: k, label: fieldLabel(k), from: val(b, k), to: val(r, k) })
    }
  }
  return { changed, differences, sideEffects }
}
