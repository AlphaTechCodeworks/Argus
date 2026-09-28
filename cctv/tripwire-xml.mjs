// A camera's own line-crossing ("tripwire") detection, as the NVR's web client reads and writes it:
// reading the queryTripwire / queryNodeList / queryScheduleList answers, checking an admin's change,
// building the editTripwire document, and comparing what the camera reports afterwards.
//
// Pure on purpose: it imports only xml.mjs, never nvr-xml.mjs (which loads the native SDK), so the
// offline tests run on the Windows PC. tripwire.mjs does the sending, the lock and the change log.
//
// Why the edit is built from the whole answer: editTripwire replaces the camera's whole block, and
// the web client (tripwireAlarmCfg.js getSaveData) always sends all of it. Anything left out may be
// reset, so every value goes back exactly as read except what the admin changed, in the web
// client's own element order and names. Two deliberate differences:
//   - triggerAudio / triggerWhiteLight are never sent. The web client leaves them out too unless the
//     camera has a siren or a white light (none of these do), and on this site the floodlight is
//     worked by hand only. A camera that reports either one on is refused outright, so leaving them
//     out can never be what switches one on or off.
//   - Fields the answer carries but the web client never sends (the sysRec/alarmOut/preset
//     switches, sysSnap, popMsgSwitch, manualAudio/LightSwitch, per-line sensitivity) are kept only
//     so the read-back can list any of them that moved as a side effect.
//
// Anything in an answer that cannot be read exactly (an on/off that is neither true nor false, a
// filter class we do not know) makes the parse throw: a value we guessed would be written back.
import { XML_HEADER, esc, kid, kids, parseXml } from './xml.mjs'

/** Line directions in the firmware's own spelling ("botton" is theirs): A->B, A<-B, both ways. */
export const DIRECTIONS = ['rightortop', 'leftorbotton', 'none']
/** A hold time under this could let a crossing start and end between two 5 s alarm checks. */
export const HOLD_MIN_SAFE_S = 10
/** A line shorter than this share of the picture is refused: too short to mean anything. */
export const MIN_LINE_FRACTION = 0.05

const UNITS = 10000 // coordinates are 0..10000 of the picture's width and height, origin top-left
const MIN_LINE_UNITS = MIN_LINE_FRACTION * UNITS
const NULL_GUID = '{00000000-0000-0000-0000-000000000000}'
const GUID = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/
const CLASSES = ['car', 'person', 'motor'] // the web client's order inside <objectFilter>
const CLASS_PARTS = ['switch', 'sensitivity', 'minDetectTarget', 'maxDetectTarget']
const CHANGE_KEYS = ['enabled', 'holdTime', 'scheduleGuid', 'lines', 'filter']
const LINE_KEYS = ['direction', 'start', 'end']
const CLASS_WORDS = { car: 'Car', person: 'Person', motor: 'Motorbike' }
// The detections a camera lists in <mutexList>, in words an admin knows.
const MUTEX_WORDS = {
  perimeter: 'intrusion zones', pea: 'intrusion zones', osc: 'abandoned/missing object detection', cdd: 'crowd density',
  cpc: 'people counting', ipd: 'people intrusion', tripwire: 'line crossing', vfd: 'face detection',
  avd: 'video exception detection', vehicle: 'number plate detection', aoientry: 'area entry', aoileave: 'area exit'
}

const text = (n) => (n?.text ?? '').trim()
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const isUnit = (v) => Number.isInteger(v) && v >= 0 && v <= UNITS
const isCleared = (l) => l.start.x === 0 && l.start.y === 0 && l.end.x === 0 && l.end.y === 0
const lengthOf = (l) => Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y)

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

/** "true" or "false" and nothing else: this value is written back, so it must be read exactly. */
function boolOf(node, what) {
  const t = text(node)
  if (t === 'true') return true
  if (t === 'false') return false
  throw new Error(`queryTripwire: ${what} is "${t}", not true or false`)
}

/** A whole number or the parse fails, for the same reason. */
function intOf(node, what) {
  const t = text(node)
  if (!/^-?\d+$/.test(t)) throw new Error(`queryTripwire: ${what} is "${t}", not a whole number`)
  return Number(t)
}

// The web client reads the trigger switches as `"true" == text` (a missing one is false) and sends
// them back that way; mirrored here because these are exactly the switches it sends.
const flag = (node) => text(node) === 'true'
// Answer-only switches are compared on read-back, never sent: null when the answer has none.
const flagOrNull = (node) => (node ? text(node) === 'true' : null)

function idOf(node, what) {
  const id = node?.attrs.id
  if (!id) throw new Error(`queryTripwire: ${what} has no id`)
  return id
}

const pointOf = (node, what) => ({ x: intOf(kid(node, 'X'), `${what} X`), y: intOf(kid(node, 'Y'), `${what} Y`) })
const sizeOf = (node, what) => ({ width: intOf(kid(node, 'width'), `${what} width`), height: intOf(kid(node, 'height'), `${what} height`) })

/** One class of the person/vehicle filter: { on, sensitivity, min?, max? }. */
function classOf(node) {
  const name = node.name
  for (const c of node.children) {
    if (!CLASS_PARTS.includes(c.name)) throw new Error(`queryTripwire: the ${name} filter has <${c.name}>, which Argus does not know; change it on the NVR`)
  }
  const min = kid(node, 'minDetectTarget')
  const max = kid(node, 'maxDetectTarget')
  // The web client sends both sizes whenever the minimum is there, and invents zeros for a missing
  // maximum. That shape is refused rather than copied.
  if (!min !== !max) throw new Error(`queryTripwire: the ${name} filter has only one of its minimum/maximum sizes`)
  return {
    on: boolOf(kid(node, 'switch'), `${name} switch`),
    sensitivity: intOf(kid(node, 'sensitivity'), `${name} sensitivity`),
    ...(min ? { min: sizeOf(min, `${name} minimum size`), max: sizeOf(max, `${name} maximum size`) } : {})
  }
}

/**
 * One camera's line-crossing settings from its queryTripwire answer (requireField param + trigger).
 * Throws Error('<reason>') for a refusal or anything it cannot read exactly.
 */
export function parseTripwire(xml) {
  const response = answerOf(xml, 'queryTripwire')
  const chl = kid(kid(response, 'content'), 'chl')
  if (!chl?.attrs.id) throw new Error('queryTripwire: the answer names no camera')
  const param = kid(chl, 'param')
  const trig = kid(chl, 'trigger')
  if (!param || !trig) throw new Error('queryTripwire: the answer has no line-crossing settings (param/trigger) for this camera')

  const holdTime = intOf(kid(param, 'alarmHoldTime'), 'alarmHoldTime')
  const holdChoices = text(kid(param, 'holdTimeNote')).split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number)
  // As the web client does: the camera's own value is always one of the choices.
  if (!holdChoices.includes(holdTime)) holdChoices.push(holdTime)
  holdChoices.sort((a, b) => a - b)

  const objectFilter = kid(param, 'objectFilter')
  const single = kid(param, 'sensitivity')
  let filter = null
  if (objectFilter?.children.length) {
    if (single) throw new Error('queryTripwire: the answer has both a single sensitivity and a person/vehicle filter, a shape Argus does not know')
    const classes = {}
    for (const c of objectFilter.children) {
      if (!CLASSES.includes(c.name) || classes[c.name]) throw new Error(`queryTripwire: the object filter has <${c.name}>, which Argus does not know; change it on the NVR`)
      classes[c.name] = classOf(c)
    }
    filter = { kind: 'objects', classes }
  } else if (single) {
    filter = { kind: 'single', sensitivity: intOf(single, 'sensitivity') }
  }

  const lineList = kid(param, 'line')
  const items = kids(lineList, 'item')
  if (!items.length) throw new Error('queryTripwire: the answer has no line slots')
  if (lineList.attrs.count !== undefined && Number(lineList.attrs.count) !== items.length) {
    throw new Error(`queryTripwire: the line list says count="${lineList.attrs.count}" but has ${items.length} slots`)
  }
  const lines = items.map((it, i) => ({
    direction: text(kid(it, 'direction')),
    start: pointOf(kid(it, 'startPoint'), `line ${i + 1} start`),
    end: pointOf(kid(it, 'endPoint'), `line ${i + 1} end`),
    sensitivity: kid(it, 'sensitivity') ? intOf(kid(it, 'sensitivity'), `line ${i + 1} sensitivity`) : null
  }))

  // The firmware's own list; the three known spellings if an answer ever leaves it out.
  const listed = kids(response, 'types').flatMap((t) => kids(kid(t, 'direction'), 'enum')).map(text).filter(Boolean)
  const directions = listed.length ? listed : [...DIRECTIONS]

  // mutexListEx is the other half of a dual-lens (thermal) camera; the web client warns about both.
  const mutex = [...kids(kid(param, 'mutexList'), 'item'), ...kids(kid(param, 'mutexListEx'), 'item')]
    .map((it) => ({ object: text(kid(it, 'object')), on: text(kid(it, 'status')) === 'true' }))

  // Anything but "false" counts as on: the safe reading for a switch that decides a refusal.
  const onUnlessFalse = (node) => (node ? text(node) !== 'false' : false)

  const target = kid(param, 'saveTargetPicture')
  const source = kid(param, 'saveSourcePicture')
  if (!target !== !source) throw new Error('queryTripwire: the answer has only one of saveTargetPicture/saveSourcePicture')

  const listIn = (parent, list) => kids(kid(kid(trig, parent), list), 'item')
  const sysSnap = kid(trig, 'sysSnap')
  const trigger = {
    rec: listIn('sysRec', 'chls').map((it) => ({ id: idOf(it, 'a recorded camera'), name: text(it) })),
    alarmOuts: listIn('alarmOut', 'alarmOuts').map((it) => ({ id: idOf(it, 'an alarm output'), name: text(it) })),
    presets: listIn('preset', 'presets').map((it) => ({
      index: text(kid(it, 'index')), name: text(kid(it, 'name')), chlId: kid(it, 'chl')?.attrs.id ?? '', chlName: text(kid(it, 'chl'))
    })),
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

  return {
    chlId: chl.attrs.id,
    // As the web client does: no schedule on the camera means the null schedule.
    scheduleGuid: chl.attrs.scheduleGuid || NULL_GUID,
    enabled: boolOf(kid(param, 'switch'), 'switch'),
    holdTime,
    holdChoices,
    filter,
    lines,
    directions,
    mutex,
    triggerAudio: onUnlessFalse(kid(param, 'triggerAudio')),
    triggerWhiteLight: onUnlessFalse(kid(param, 'triggerWhiteLight')),
    saveTargetPicture: target ? boolOf(target, 'saveTargetPicture') : null,
    saveSourcePicture: source ? boolOf(source, 'saveSourcePicture') : null,
    autoTrack: text(kid(param, 'autoTrack')) || null,
    trigger
  }
}

/** Which cameras can have lines, from queryNodeList (requireField supportTripwire, supportPea). */
export function parseSupport(xml) {
  const response = answerOf(xml, 'queryNodeList')
  const out = new Map()
  for (const it of kids(kid(response, 'content'), 'item')) {
    if (!it.attrs.id) continue
    out.set(it.attrs.id, { tripwire: text(kid(it, 'supportTripwire')) === 'true', pea: text(kid(it, 'supportPea')) === 'true' })
  }
  return out
}

/** The NVR's schedules, from queryScheduleList: [{ id, name }]. */
export function parseSchedules(xml) {
  const response = answerOf(xml, 'queryScheduleList')
  return kids(kid(response, 'content'), 'item').filter((it) => it.attrs.id).map((it) => ({ id: it.attrs.id, name: text(it) }))
}

/**
 * The settings with `change` applied: a deep copy, `cfg` is untouched. Only what the change names
 * moves; a line keeps the per-line sensitivity the camera reported, a filter class keeps its sizes.
 * Meant to run after checkChange; a change that does not fit this camera at all throws.
 */
export function applyChange(cfg, change) {
  const next = structuredClone(cfg)
  const c = isObj(change) ? change : {}
  if ('enabled' in c) next.enabled = c.enabled
  if ('holdTime' in c) next.holdTime = c.holdTime
  if ('scheduleGuid' in c) next.scheduleGuid = c.scheduleGuid
  if ('lines' in c) {
    if (!Array.isArray(c.lines) || c.lines.length !== cfg.lines.length) throw new Error(`The change must list all ${cfg.lines.length} line slots`)
    next.lines = next.lines.map((old, i) => ({
      ...old,
      direction: c.lines[i].direction,
      start: { x: c.lines[i].start.x, y: c.lines[i].start.y },
      end: { x: c.lines[i].end.x, y: c.lines[i].end.y }
    }))
  }
  if ('filter' in c) {
    if (!next.filter) throw new Error('This camera has no person/vehicle filter')
    if (next.filter.kind === 'single') {
      next.filter.sensitivity = c.filter.sensitivity
    } else {
      for (const [k, v] of Object.entries(c.filter)) {
        if (!Object.hasOwn(next.filter.classes, k)) throw new Error(`This camera's filter has no ${k} class`)
        if ('on' in v) next.filter.classes[k].on = v.on
        if ('sensitivity' in v) next.filter.classes[k].sensitivity = v.sensitivity
      }
    }
  }
  return next
}

const sensitivityProblem = (v, what) => (Number.isInteger(v) && v >= 1 && v <= 100 ? null : `${what} must be a whole number from 1 to 100`)

function linesProblem(cfg, lines) {
  const n = cfg.lines.length
  if (!Array.isArray(lines) || lines.length !== n) return `The change must list all ${n} line slots (a cleared slot is all zeros)`
  for (const [i, l] of lines.entries()) {
    const slot = `Line ${i + 1}`
    if (!isObj(l)) return `${slot} must be { direction, start, end }`
    const odd = Object.keys(l).filter((k) => !LINE_KEYS.includes(k))
    if (odd.length) return `${slot}: unknown setting ${odd.join(', ')}`
    if (!cfg.directions.includes(l.direction)) return `${slot}: direction must be one of ${cfg.directions.join(', ')}`
    for (const end of ['start', 'end']) {
      const p = l[end]
      if (!isObj(p) || Object.keys(p).length !== 2 || !Object.hasOwn(p, 'x') || !Object.hasOwn(p, 'y')) return `${slot}: ${end} must be { x, y }`
      if (!isUnit(p.x) || !isUnit(p.y)) return `${slot}: ${end} must be whole numbers from 0 to ${UNITS}`
    }
    if (isCleared(l)) continue
    if (l.start.x === l.end.x && l.start.y === l.end.y) return `${slot} starts and ends at the same point`
    if (lengthOf(l) < MIN_LINE_UNITS) return `${slot} is shorter than ${MIN_LINE_FRACTION * 100}% of the picture; draw it longer`
  }
  return null
}

function filterProblem(cfg, f) {
  if (!cfg.filter) return 'This camera has no person/vehicle filter: anything that crosses a line counts'
  if (!isObj(f)) return 'filter must be an object'
  if (cfg.filter.kind === 'single') {
    if (Object.keys(f).length !== 1 || !Object.hasOwn(f, 'sensitivity')) return 'This camera has one sensitivity: filter must be { sensitivity }'
    return sensitivityProblem(f.sensitivity, 'Sensitivity')
  }
  for (const [k, v] of Object.entries(f)) {
    if (!Object.hasOwn(cfg.filter.classes, k)) return `This camera's filter has no ${k} class`
    const word = CLASS_WORDS[k] ?? k
    if (!isObj(v)) return `${word} must be { on, sensitivity }`
    const odd = Object.keys(v).filter((x) => x !== 'on' && x !== 'sensitivity')
    if (odd.length) return `${word}: unknown setting ${odd.join(', ')}`
    if ('on' in v && typeof v.on !== 'boolean') return `${word}: on must be true or false`
    if ('sensitivity' in v) {
      const why = sensitivityProblem(v.sensitivity, `${word} sensitivity`)
      if (why) return why
    }
  }
  return null
}

function warningsFor(cfg, next) {
  const out = []
  const turningOn = next.enabled && !cfg.enabled
  const busy = [...new Set(cfg.mutex.filter((m) => m.on).map((m) => MUTEX_WORDS[m.object] ?? m.object))]
  if (turningOn && busy.length) {
    out.push({ key: 'mutex', text: `Turning line crossing on may switch off ${busy.join(', ')} on this camera: it cannot run them together.` })
  }
  if (turningOn && next.filter === null) {
    out.push({ key: 'no-filter', text: 'This camera has no person/vehicle filter: anything that crosses a line counts, including water, boats, shadows and headlights.' })
  }
  if (next.enabled && next.holdTime < HOLD_MIN_SAFE_S) {
    out.push({ key: 'short-hold', text: `A hold time of ${next.holdTime} s is under ${HOLD_MIN_SAFE_S} s: a crossing could start and end between two alarm checks (every 5 s) and be missed.` })
  }
  if (next.enabled && next.lines.every(isCleared)) {
    out.push({ key: 'no-lines', text: 'Line crossing would be on with no line drawn: it cannot detect anything until a line is set.' })
  }
  // 'None' in the NVR's web client: the camera then detects at no time at all
  if (next.enabled && String(next.scheduleGuid).toUpperCase() === NULL_GUID) {
    out.push({ key: 'no-schedule', text: 'Line crossing would be on with no schedule (None): the camera would never detect anything. Choose a schedule such as 24x7.' })
  }
  return out
}

/**
 * Whether `change` may be sent to this camera: { refuse: string|null, warnings: [{ key, text }] }.
 * A refusal is final (nothing is sent); warnings need the admin's acknowledgement.
 * `schedules` (from parseSchedules) is checked when given.
 */
export function checkChange(cfg, change, { schedules = [] } = {}) {
  const refuse = (why) => ({ refuse: why, warnings: [] })
  // First, whatever the change: this site's floodlight and sirens are worked by hand only, and a
  // write that leaves these fields out could not be trusted to leave them as they are.
  if (cfg.triggerAudio || cfg.triggerWhiteLight) {
    return refuse('The camera\'s sound/white-light trigger is on; set it off on the NVR first — the floodlight is worked by hand only')
  }
  if (!isObj(change)) return refuse('The change must be an object')
  const unknown = Object.keys(change).filter((k) => !CHANGE_KEYS.includes(k))
  if (unknown.length) return refuse(`Unknown setting${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`)
  if ('enabled' in change && typeof change.enabled !== 'boolean') return refuse('enabled must be true or false')
  if ('holdTime' in change && !cfg.holdChoices.includes(change.holdTime)) {
    return refuse(`Hold time must be one the camera offers (${cfg.holdChoices.join(', ')} s)`)
  }
  if ('scheduleGuid' in change) {
    const g = change.scheduleGuid
    if (typeof g !== 'string' || !GUID.test(g)) return refuse('scheduleGuid must be a schedule id like {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}')
    // the null GUID ('None') is never in the NVR's list, but a camera can have it: an Undo must be able to put it back
    if (schedules.length && g.toUpperCase() !== NULL_GUID && !schedules.some((s) => s.id === g)) return refuse('That schedule is not one of the NVR\'s schedules')
  }
  if ('lines' in change) {
    const why = linesProblem(cfg, change.lines)
    if (why) return refuse(why)
  }
  if ('filter' in change) {
    const why = filterProblem(cfg, change.filter)
    if (why) return refuse(why)
  }
  const next = applyChange(cfg, change)
  // NVR relay outputs are never switched on from here: with one linked to this camera's line
  // crossing, switching the detection on would work the relay at every crossing
  if (next.enabled && cfg.trigger.alarmOuts.length > 0) {
    return refuse('The camera\'s line crossing has an NVR alarm output (relay) linked; take it out on the NVR first — the floodlight is worked by hand only')
  }
  const before = flatten(cfg)
  const after = flatten(next)
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  if ([...keys].every((k) => before[k] === after[k])) return refuse('Nothing to change: the camera already has these settings')
  return { refuse: null, warnings: warningsFor(cfg, next) }
}

// ---- the edit document -------------------------------------------------------------------------

const cdata = (v) => `<![CDATA[${String(v).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`

/**
 * The editTripwire document for these settings, element for element as the web client's
 * getSaveData builds it. Throws rather than send a value that is not exactly right: a coordinate
 * that is not a whole number 0..10000, an on/off that is not a boolean, or a camera whose sound or
 * white-light trigger is on.
 */
export function buildEditTripwire(cfg) {
  if (cfg.triggerAudio || cfg.triggerWhiteLight) throw new Error('editTripwire: refusing to write, the camera\'s sound/white-light trigger is on')
  const bool = (v, what) => {
    if (typeof v !== 'boolean') throw new Error(`editTripwire: ${what} is ${JSON.stringify(v)}, not true or false`)
    return String(v)
  }
  const whole = (v, what, lo = 0, hi = Number.MAX_SAFE_INTEGER) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`editTripwire: ${what} is ${JSON.stringify(v)}, not a whole number from ${lo} to ${hi}`)
    return String(v)
  }
  const size = (tag, s, what) => `<${tag}><width>${whole(s.width, `${what} width`, 0, UNITS)}</width><height>${whole(s.height, `${what} height`, 0, UNITS)}</height></${tag}>`

  // Sensitivities are only held to 0..100 here: a value the camera reported goes back as read, and
  // checkChange already holds a new one to 1..100.
  let x = `${XML_HEADER}<content><chl id="${esc(cfg.chlId)}" scheduleGuid="${esc(cfg.scheduleGuid)}">`
  x += `<param><switch>${bool(cfg.enabled, 'switch')}</switch><alarmHoldTime unit="s">${whole(cfg.holdTime, 'hold time', 1)}</alarmHoldTime>`
  if (cfg.filter?.kind === 'single') x += `<sensitivity>${whole(cfg.filter.sensitivity, 'sensitivity', 0, 100)}</sensitivity>`
  if (cfg.filter?.kind === 'objects') {
    x += '<objectFilter>'
    for (const k of CLASSES) {
      const c = cfg.filter.classes[k]
      if (!c) continue
      x += `<${k}><switch>${bool(c.on, `${k} switch`)}</switch><sensitivity>${whole(c.sensitivity, `${k} sensitivity`, 0, 100)}</sensitivity>`
      if (c.min) x += size('minDetectTarget', c.min, `${k} minimum`) + size('maxDetectTarget', c.max, `${k} maximum`)
      x += `</${k}>`
    }
    x += '</objectFilter>'
  }
  if (cfg.autoTrack) x += `<autoTrack>${esc(cfg.autoTrack)}</autoTrack>`
  x += `<line type="list" count="${cfg.lines.length}"><itemType><direction type="direction"/></itemType>`
  for (const [i, l] of cfg.lines.entries()) {
    const at = (p, which) => `<X>${whole(p.x, `line ${i + 1} ${which} x`, 0, UNITS)}</X><Y>${whole(p.y, `line ${i + 1} ${which} y`, 0, UNITS)}</Y>`
    x += `<item><direction type="direction">${esc(l.direction)}</direction><startPoint>${at(l.start, 'start')}</startPoint><endPoint>${at(l.end, 'end')}</endPoint></item>`
  }
  x += '</line>'
  if (cfg.saveTargetPicture !== null) {
    x += `<saveTargetPicture>${bool(cfg.saveTargetPicture, 'saveTargetPicture')}</saveTargetPicture><saveSourcePicture>${bool(cfg.saveSourcePicture, 'saveSourcePicture')}</saveSourcePicture>`
  }
  x += '</param>'

  const t = cfg.trigger
  x += '<trigger><sysRec><chls type="list">'
  for (const r of t.rec) x += `<item id="${esc(r.id)}">${cdata(r.name)}</item>`
  x += '</chls></sysRec><alarmOut><alarmOuts type="list">'
  for (const a of t.alarmOuts) x += `<item id="${esc(a.id)}">${cdata(a.name)}</item>`
  x += '</alarmOuts></alarmOut><preset><presets type="list">'
  // as the web client: a preset without an index is not sent
  for (const p of t.presets) {
    if (p.index) x += `<item><index>${esc(p.index)}</index><name>${cdata(p.name)}</name><chl id="${esc(p.chlId)}">${cdata(p.chlName)}</chl></item>`
  }
  x += `</presets></preset><snapSwitch>${bool(t.snap, 'snapSwitch')}</snapSwitch><msgPushSwitch>${bool(t.msgPush, 'msgPushSwitch')}</msgPushSwitch>`
  x += `<buzzerSwitch>${bool(t.buzzer, 'buzzerSwitch')}</buzzerSwitch><popVideoSwitch>${bool(t.popVideo, 'popVideoSwitch')}</popVideoSwitch>`
  x += `<emailSwitch>${bool(t.email, 'emailSwitch')}</emailSwitch><sysAudio id="${esc(t.sysAudio)}"></sysAudio></trigger>`
  return `${x}</chl></content></request>`
}

// ---- read-back ---------------------------------------------------------------------------------

/**
 * Every field of the settings as key -> string, sent or answer-only, for comparing two reads.
 * A field the answer does not have is left out (compareReadBack reports it as null).
 */
export function flatten(cfg) {
  const out = {}
  const put = (k, v) => { if (v !== null && v !== undefined) out[k] = String(v) }
  put('enabled', cfg.enabled)
  put('holdTime', cfg.holdTime)
  put('schedule', cfg.scheduleGuid)
  if (cfg.filter?.kind === 'single') put('filter.sensitivity', cfg.filter.sensitivity)
  if (cfg.filter?.kind === 'objects') {
    for (const k of CLASSES) {
      const c = cfg.filter.classes[k]
      if (!c) continue
      put(`filter.${k}.on`, c.on)
      put(`filter.${k}.sensitivity`, c.sensitivity)
      if (c.min) put(`filter.${k}.min`, `${c.min.width}x${c.min.height}`)
      if (c.max) put(`filter.${k}.max`, `${c.max.width}x${c.max.height}`)
    }
  }
  cfg.lines.forEach((l, i) => {
    put(`line.${i}.direction`, l.direction)
    put(`line.${i}.start`, `${l.start.x},${l.start.y}`)
    put(`line.${i}.end`, `${l.end.x},${l.end.y}`)
    put(`line.${i}.sensitivity`, l.sensitivity)
  })
  // A detection named twice (mutexList and mutexListEx) gets ".2" so neither hides the other.
  const seen = new Map()
  for (const m of cfg.mutex) {
    const n = (seen.get(m.object) ?? 0) + 1
    seen.set(m.object, n)
    put(`mutex.${m.object}${n > 1 ? `.${n}` : ''}`, m.on)
  }
  put('triggerAudio', cfg.triggerAudio)
  put('triggerWhiteLight', cfg.triggerWhiteLight)
  put('saveTargetPicture', cfg.saveTargetPicture)
  put('saveSourcePicture', cfg.saveSourcePicture)
  put('autoTrack', cfg.autoTrack)
  const t = cfg.trigger
  put('trigger.rec', t.rec.map((r) => r.id).join(','))
  put('trigger.alarmOuts', t.alarmOuts.map((a) => a.id).join(','))
  put('trigger.presets', t.presets.map((p) => `${p.chlId}:${p.index}`).join(','))
  put('trigger.snap', t.snap)
  put('trigger.msgPush', t.msgPush)
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

/**
 * What the camera did with a change. `before`: the read the change was built on; `asked`:
 * applyChange(before, change); `after`: the read-back.
 * fields: every key the change moved, 'as asked' when the read-back has the asked value.
 * sideEffects: every other key that differs between before and after.
 */
export function compareReadBack(before, asked, after) {
  const b = flatten(before)
  const a = flatten(asked)
  const r = flatten(after)
  const val = (m, k) => (Object.hasOwn(m, k) ? m[k] : null)
  const fields = []
  const sideEffects = []
  for (const k of new Set([...Object.keys(b), ...Object.keys(a), ...Object.keys(r)])) {
    if (val(a, k) !== val(b, k)) {
      fields.push({ key: k, want: val(a, k), got: val(r, k), status: val(r, k) === val(a, k) ? 'as asked' : 'not applied' })
    } else if (val(r, k) !== val(b, k)) {
      sideEffects.push({ key: k, from: val(b, k), to: val(r, k) })
    }
  }
  return { fields, sideEffects }
}
