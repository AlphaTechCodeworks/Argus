// Camera picture settings: brightness, contrast, colour, sharpness, WDR, exposure, gain,
// shutter, day/night, infrared, night light and the like. Admins see them and change them
// from the full-size view. The camera does the image processing; only its setting changes.
// Nothing here depends on the camera model: every camera lists the settings it has (with
// min, max, default and its own choice labels), so cameras added later work the same way,
// and a camera without a setting simply doesn't show it.
//
// Protocol: the NVR web client's Image page (js/app/ChlCfg/displaySet.js, "ds:N" = line N of
// the beautified copy in the research folder):
//   read  queryChlVideoParam  <condition><chlId>{id}</chlId>[<cfgFile>day</cfgFile>]<scheduleInfo/></condition>
//   write editChlVideoParam   <content><chl id="{id}"><rebootPrompt>true</rebootPrompt>[<cfgFile>] groups</chl></content>
// Cameras with day/night profiles (cfgFile: normal, day, night) keep separate settings for
// each; the answer to an unconditioned read names the profile the camera says it is using.
//
// Safety, in the order a change goes:
// - one change per NVR at a time (withNvrLock), and every XML call queued per NVR (nvr-xml.mjs);
// - the camera is read again first; if any value the admin saw has changed since, nothing is
//   sent (409 stale);
// - only settings in FIELDS can be changed, never ones that restart the camera by themselves
//   (rotation, mains frequency, HFR); refusals for combinations the NVR's page never sends;
// - changes that can pause recording, restart the camera, switch the night light, turn the
//   picture over or change a profile the camera isn't using need an acknowledgement tied to
//   the exact change (409 needsAck + ackToken);
// - the change is logged (with every setting before it) BEFORE anything is sent;
// - basic settings (brightness, contrast, hue, saturation) and advanced groups go as two
//   requests, basic first, as the NVR's page does; only groups with a change, each complete,
//   every other value exactly as just read; rebootPrompt stays true, so a change the NVR
//   says needs a restart is not made; nothing is ever resent automatically;
// - every setting is read back, and settings that changed without being asked for are
//   reported as side effects (and put back by Undo where they can be, in the page's order:
//   the night light before the white-light settings it decides);
// - a schedule switch (and its Undo) is judged like a change to the profile(s) the camera then
//   uses, with the Day/Night set-up's refusals (HWDR, Day and Night differing in what can pause
//   recording or restart the camera, settings this app can't write).
//
//   GET  /api/admin/nvrs/:id/channels/:ch/image[?profile=day]   (ch: 0-based, as in /api/cameras)
//   POST /api/admin/nvrs/:id/channels/:ch/image
//        { device, profile?, changes: { contrast: 55 }, seen: { contrast: 50 }, origin?: 'auto', retryOf?, ack?, ackToken?, confirm: true }
//        { device, profile?, undo: true, seq, ack?, ackToken?, confirm: true }
//        { device, profile?, restartFor: seq, group, ack: ['restart-confirmed', ...], ackToken, confirm: true }
//     -> { settings, result }
//   GET  /api/admin/nvrs/:id/channels/:ch/image/profiles     -> { plan }   (Day/Night set-up, read only)
//   POST /api/admin/nvrs/:id/channels/:ch/image/profiles     { device, action: 'split', ack, ackToken, confirm: true }
//   POST /api/admin/nvrs/:id/channels/:ch/image/schedule     { device, program, dayTime?, nightTime?, seen: { program }, ack, ackToken, confirm: true }
//                                                            { device, undo: true, seq, ack?, ackToken?, confirm: true }
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DATA_DIR } from './auth.mjs'
import { activeVerified, cameraNotes, noteSeen } from './camera-notes.mjs'
import {
  HttpError,
  XML_HEADER,
  cameraOf,
  chlIdOf,
  deviceOf,
  errorAnswer,
  esc,
  isPlainObject,
  kid,
  kids,
  leafMap,
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

const QUERY_URL = 'queryChlVideoParam'
const EDIT_URL = 'editChlVideoParam' // writes: only for an admin's confirmed change
const LOG_FILE = join(DATA_DIR, 'image-changes.log')
const MAX_CHANGES = 40
/** Waits (ms). Tests shorten them. */
export const TIMING = {
  verifyMs: [1500, 3000, 6000], // read back this long after the change, until it shows
  pollEveryMs: 10_000, // after a change that may restart the camera: read every 10 s ...
  pollMaxMs: 180_000, // ... for up to 3 minutes
  restartWindowMs: 10 * 60_000 // "Restart camera to apply" is offered this long after the refusal
}

// ---- the settings --------------------------------------------------------------------------

const BASIC = new Set(['bright', 'contrast', 'hue', 'saturation']) // the NVR's page sends these four together, on their own (ds:756)
const IRCUT = new Set(['IRCutMode', 'IRCutDayTime', 'IRCutNightTime', 'IRCutConvSen']) // sent together (setAZData, ds:787)
const SECTIONS = ['Picture', 'Light', 'Exposure', 'Night', 'Colour', 'Orientation']
const PROFILE_NAMES = { normal: 'Normal', day: 'Day', night: 'Night' }
const on = (path) => ({ path, eq: true })

/**
 * The settings that can be changed. A camera shows the ones it reports.
 *   kind: 'index' (an integer choosing from a <types> list of labels, e.g. shutter 4 = "1/30"),
 *         'usec' (microseconds, offered as the camera's "1/60"-style labels), 'time' ("hh:mm");
 *         otherwise worked out from the value: select (options), switch (true/false), range.
 *   options: the <types> list holding a choice's values or labels (else the element's type
 *         attribute names it); fallback: the page's own list when the camera sends none.
 *   needs: the setting only matters (and can only be changed on its own) while another has a
 *         value: { path, eq | ne, label? } (label: compare an index setting's label).
 *   defaults: part of the Defaults button (picture and colour only; never exposure, night
 *         light, backlight/WDR or orientation).
 */
const FIELDS = [
  { path: 'bright', label: 'Brightness', section: 'Picture', defaults: true },
  { path: 'contrast', label: 'Contrast', section: 'Picture', defaults: true },
  { path: 'saturation', label: 'Saturation', section: 'Picture', defaults: true },
  { path: 'hue', label: 'Hue', section: 'Picture', defaults: true },
  { path: 'sharpen.switch', label: 'Sharpening', section: 'Picture', defaults: true },
  { path: 'sharpen.value', label: 'Sharpening level', section: 'Picture', needs: on('sharpen.switch'), defaults: true },
  { path: 'denoise.switch', label: 'Noise reduction (fixed level)', section: 'Picture', defaults: true },
  { path: 'denoise.value', label: 'Noise reduction level', section: 'Picture', needs: on('denoise.switch'), defaults: true },
  { path: 'fogReduction.switch', label: 'Defog', section: 'Light', defaults: true },
  { path: 'fogReduction.value', label: 'Defog level', section: 'Light', needs: on('fogReduction.switch'), defaults: true },
  { path: 'WDR.switch', label: 'WDR', section: 'Light' },
  { path: 'WDR.value', label: 'WDR level', section: 'Light', needs: on('WDR.switch') },
  { path: 'backlightCompensation.mode', label: 'Backlight', section: 'Light', options: 'BLCMode' },
  { path: 'backlightCompensation.HWDRLevel', label: 'HWDR level', section: 'Light', options: 'HWDRLevel', needs: { path: 'backlightCompensation.mode', eq: 'HWDR' } },
  // the NVR's page locks anti-flicker while HWDR is on (ds:612, 657)
  { path: 'antiflicker', label: 'Anti-flicker', section: 'Light', options: 'antiflickerMode', needs: { path: 'backlightCompensation.mode', ne: 'HWDR' } },
  { path: 'autoExposureMode.mode', label: 'Exposure', section: 'Exposure', options: 'autoExposureMode' },
  { path: 'autoExposureMode.value', label: 'Exposure time', section: 'Exposure', kind: 'usec', options: 'autoExposureValue', needs: { path: 'autoExposureMode.mode', eq: 'manual' } },
  { path: 'gain.mode', label: 'Gain mode', section: 'Exposure', kind: 'index', options: 'gainMode' },
  { path: 'gain.AGC', label: 'Gain limit', section: 'Exposure', needs: { path: 'gain.mode', eq: 'auto', label: true } },
  { path: 'gain.value', label: 'Gain', section: 'Exposure', needs: { path: 'gain.mode', eq: 'manual', label: true } },
  { path: 'shutter.mode', label: 'Shutter mode', section: 'Exposure', kind: 'index', options: 'shutterMode' },
  { path: 'shutter.upLimit', label: 'Slowest shutter', section: 'Exposure', kind: 'index', options: 'shutterValue', needs: { path: 'shutter.mode', ne: 'manual', label: true } },
  { path: 'shutter.lowLimit', label: 'Fastest shutter', section: 'Exposure', kind: 'index', options: 'shutterValue', needs: { path: 'shutter.mode', ne: 'manual', label: true } },
  { path: 'shutter.value', label: 'Shutter', section: 'Exposure', kind: 'index', options: 'shutterValue', needs: { path: 'shutter.mode', ne: 'auto', label: true } },
  { path: 'IRCutMode', label: 'Day/night switch', section: 'Night', options: 'IRCutMode', fallback: ['auto', 'day', 'night', 'time'] },
  { path: 'IRCutDayTime', label: 'Day from', section: 'Night', kind: 'time', needs: { path: 'IRCutMode', eq: 'time' } },
  { path: 'IRCutNightTime', label: 'Night from', section: 'Night', kind: 'time', needs: { path: 'IRCutMode', eq: 'time' } },
  { path: 'IRCutConvSen', label: 'Day/night sensitivity', section: 'Night', options: 'IRCutConvSen', needs: { path: 'IRCutMode', eq: 'auto' } },
  { path: 'IRCutDelayTime', label: 'Day/night delay (s)', section: 'Night', needs: { path: 'IRCutMode', eq: 'auto' } },
  { path: 'InfraredMode', label: 'Infrared light', section: 'Night', options: 'InfraredMode' },
  { path: 'smartIR.switch', label: 'Smart IR', section: 'Night' },
  { path: 'smartIR.level', label: 'Smart IR level', section: 'Night', needs: on('smartIR.switch') },
  { path: 'smartIr.mode', label: 'Smart IR', section: 'Night', options: 'smartIrMode' },
  { path: 'smartIr.lightLevel_1', label: 'Smart IR level', section: 'Night', needs: { path: 'smartIr.mode', eq: 'manual' } },
  { path: 'illumination.illuminationMode', label: 'Night light', section: 'Night', options: 'illuminationMode' },
  { path: 'Whitelight.WhitelightMode', label: 'White light', section: 'Night', options: 'WhitelightMode', fallback: ['off', 'manual', 'auto'] },
  { path: 'Whitelight.WhitelightStrength', label: 'White light strength', section: 'Night', needs: { path: 'Whitelight.WhitelightMode', eq: 'manual' } },
  { path: 'Whitelight.WhitelightOnTime', label: 'White light on at', section: 'Night', kind: 'time', needs: { path: 'Whitelight.WhitelightMode', eq: 'manual' } },
  { path: 'Whitelight.WhitelightOffTime', label: 'White light off at', section: 'Night', kind: 'time', needs: { path: 'Whitelight.WhitelightMode', eq: 'manual' } },
  { path: 'ImageOverExposure.ImageOverExposureMode', label: 'Over-exposure control', section: 'Night', options: 'ImageOverExposureMode' },
  { path: 'whiteBalance.mode', label: 'White balance', section: 'Colour', options: 'whiteBalance', defaults: true },
  { path: 'whiteBalance.red', label: 'Red gain', section: 'Colour', needs: { path: 'whiteBalance.mode', eq: 'manual' } },
  { path: 'whiteBalance.blue', label: 'Blue gain', section: 'Colour', needs: { path: 'whiteBalance.mode', eq: 'manual' } },
  { path: 'mirrorSwitch', label: 'Mirror', section: 'Orientation' },
  { path: 'flipSwitch', label: 'Flip', section: 'Orientation' }
]

/** The request group a setting goes in: the basic four together, the day/night switch together, else its element. */
const groupOf = (path) => (BASIC.has(path) ? 'basic' : IRCUT.has(path) ? 'ircut' : path.split('.')[0])
/** Which of the page's two requests a group goes in (they are never mixed, ds:756-758 vs 777-805). */
const partOf = (group) => (group === 'basic' ? 'basic' : 'advanced')
const PARTS = ['basic', 'advanced']
const GROUP_LABELS = {
  basic: 'Brightness, contrast, hue and saturation',
  ircut: 'Day/night switch',
  backlightCompensation: 'Backlight',
  autoExposureMode: 'Exposure mode',
  gain: 'Gain',
  shutter: 'Shutter',
  smartIR: 'Smart IR',
  smartIr: 'Smart IR',
  Whitelight: 'White light',
  illumination: 'Night light'
}
const groupLabel = (g, s) => GROUP_LABELS[g] ?? s?.fields.find((f) => groupOf(f.path) === g)?.label ?? g

// The attributes the NVR's page itself writes on these elements (ds:789, 796)
const PAGE_ATTRS = {
  'smartIR.switch': 'type="boolean" default="false"',
  'Whitelight.WhitelightMode': 'type="WhitelightMode" default="off"',
  'Whitelight.WhitelightStrength': 'type="uint32" min="1" max="100" default="50"',
  'Whitelight.WhitelightOnTime': 'type="string" default="00:00"',
  'Whitelight.WhitelightOffTime': 'type="string" default="23:59"'
}

// What the NVR names in <rebootParam> when a change would restart the camera (the page's
// J map, ds:1319-1320) -> our groups. Matched without case.
const REBOOT_KEYS = {
  sharpen: ['sharpen'],
  denoise: ['denoise'],
  backlightcompensation: ['backlightCompensation'],
  whitebalance: ['whiteBalance'],
  antiflicker: ['antiflicker'],
  autoexposuremode: ['autoExposureMode'],
  gain: ['gain'],
  imagerotate: ['imageRotate'],
  mirrorswitch: ['mirrorSwitch'],
  flipswitch: ['flipSwitch'],
  hfr: ['HFR'],
  ircutmode: ['ircut'],
  smartir: ['smartIr', 'smartIR'],
  shutter: ['shutter'],
  infraredmode: ['InfraredMode'],
  whitelight: ['Whitelight']
}
/** { groups, unknown } named by a rebootParam answer. */
function decodeReboot(text) {
  const groups = new Set()
  const unknown = []
  for (const k of String(text ?? '').split(/[,;\s]+/).filter(Boolean)) {
    const g = REBOOT_KEYS[k.toLowerCase()]
    if (g) g.forEach((x) => groups.add(x))
    else unknown.push(k)
  }
  return { groups: [...groups], unknown }
}

const same = (a, b) => String(a) === String(b)
const fieldOf = (s, path) => s.fields.find((f) => f.path === path)
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const isInt = (v) => /^-?\d+$/.test(v ?? '')

// ---- NVR answers -----------------------------------------------------------------------

/** "1/60" -> 60, "1" -> 1 (exposure labels, as the page reads them, ds:669-672) */
const denominator = (label) => (label === '1' ? 1 : parseInt(String(label).split('/')[1], 10))

function parseField(f, chl, types) {
  const n = f.path.split('.').reduce((node, name) => kid(node, name), chl)
  if (!n || n.children.length) return null
  if (n.attrs.switchEnabled === 'false') return null // the camera greys it out (ds: sharpenSwitchEnable)
  const raw = n.text.trim()
  const def = n.attrs.default
  const listOf = () => types[f.options] ?? types[n.attrs.type] ?? f.fallback ?? []
  let field
  if (f.kind === 'index') {
    const labels = types[f.options] ?? types[n.attrs.type] ?? []
    if (!isInt(raw) || Number(raw) < 0 || Number(raw) >= labels.length) return null
    const value = Number(raw)
    field = { kind: 'index', labels, value, shown: labels[value], default: isInt(def) && Number(def) >= 0 && Number(def) < labels.length ? Number(def) : null }
  } else if (f.kind === 'usec') {
    const labels = types[f.options] ?? []
    const max = Number(n.attrs.max)
    if (!isInt(raw) || !Number.isFinite(max) || max <= 0 || labels.length === 0) return null
    const options = labels.map((label) => ({ label, us: Math.floor(max / denominator(label)) })).filter((o) => Number.isFinite(o.us))
    const value = Number(raw)
    // a value the camera holds that is not one of its own choices (JPB DOOR 40000 = 1/25) stays selectable
    if (!options.some((o) => o.us === value)) options.push({ label: `1/${Math.round(1e6 / value)} (set on the camera)`, us: value, camera: true })
    const d = isInt(def) && options.some((o) => o.us === Number(def)) ? Number(def) : null
    field = { kind: 'usec', options, value, shown: options.find((o) => o.us === value).label, default: d, min: Number(n.attrs.min) || 0, max }
  } else if (f.kind === 'time') {
    if (!TIME_RE.test(raw)) return null
    field = { kind: 'time', value: raw, default: TIME_RE.test(def ?? '') ? def : null }
  } else if (f.options || f.fallback) {
    const options = listOf()
    if (!options.includes(raw)) return null
    field = { kind: 'select', options, value: raw, default: options.includes(def) ? def : null }
  } else if (raw === 'true' || raw === 'false') {
    field = { kind: 'switch', value: raw === 'true', default: def === 'true' ? true : def === 'false' ? false : null }
  } else if (isInt(raw) && isInt(n.attrs.min) && isInt(n.attrs.max)) {
    const [min, max, value] = [Number(n.attrs.min), Number(n.attrs.max), Number(raw)]
    // out of range (e.g. hue -1): the camera doesn't really have this setting
    if (min >= max || value < min || value > max) return null
    const d = Number(def)
    field = { kind: 'range', min, max, value, default: def !== undefined && Number.isInteger(d) && d >= min && d <= max ? d : null }
  } else return null
  const group = groupOf(f.path)
  return { path: f.path, label: f.label, section: f.section, group, part: partOf(group), ...field, ...(f.needs ? { needs: f.needs } : {}) }
}

/** One camera's settings from a queryChlVideoParam answer. */
function parseSettings(xml, chlId) {
  const { response, status, errorCode } = parseAnswer(xml)
  if (status !== 'success') return { ok: false, status, errorCode }
  const chl = kid(kid(response, 'content'), 'chl')
  if (!chl || String(chl.attrs.id).toUpperCase() !== chlId.toUpperCase()) return { ok: false, status: 'fail', errorCode: 'no settings for this camera' }
  const types = {}
  for (const t of kid(response, 'types')?.children ?? []) types[t.name] = kids(t, 'enum').map((e) => e.text.trim())
  const fields = FIELDS.map((f) => parseField(f, chl, types)).filter(Boolean)
  const sched = kid(chl, 'scheduleInfo')
  const text = (node, name) => kid(node, name)?.text.trim() || null
  const leaves = leafMap(chl)
  return {
    ok: true,
    chl,
    fields,
    leaves,
    profile: text(chl, 'cfgFile'),
    profiles: types.configFileType ?? [],
    schedule: sched
      ? {
          program: text(sched, 'program'),
          programs: kids(kid(kid(sched, 'types'), 'progType'), 'enum').map((e) => e.text.trim()),
          dayTime: text(sched, 'dayTime'),
          nightTime: text(sched, 'nightTime')
        }
      : null,
    // shown, never written: they restart the camera or need the mains frequency
    info: { frequency: leaves.get('frequency') ?? null, imageRotate: leaves.get('imageRotate') ?? null, hwdr: leaves.get('backlightCompensation.mode') === 'HWDR' }
  }
}

const OFFLINE_CODES = new Set(['536870935', '536870962']) // what the NVR's page reads as "camera offline"
const whyRefused = (s) =>
  OFFLINE_CODES.has(s.errorCode) ? 'the camera is offline or does not let the NVR read its picture settings' : `the NVR refused (${s.errorCode || s.status || 'no status'})`

async function readSettings(nvr, chlId, profile, gen) {
  const cond = `<chlId>${esc(chlId)}</chlId>${profile ? `<cfgFile>${esc(profile)}</cfgFile>` : ''}<scheduleInfo></scheduleInfo>`
  const s = parseSettings(await transparent(nvr, QUERY_URL, `${XML_HEADER}<condition>${cond}</condition></request>`, 'picture settings', { gen }), chlId)
  if (!s.ok) throw new HttpError(502, `Could not read the picture settings: ${whyRefused(s)}`)
  if (profile && s.profile !== profile) throw new HttpError(400, `This camera has no "${profile}" profile`)
  return s
}

/** A setting's value from its text in the XML. */
const typedValue = (f, text) => (f.kind === 'switch' ? text === 'true' : ['range', 'index', 'usec'].includes(f.kind) ? Number(text) : text)
/** How a value reads to a person. */
function shownValue(f, v) {
  if (!f) return String(v)
  if (f.kind === 'switch') return v === true || v === 'true' ? 'on' : 'off'
  if (f.kind === 'index') return f.labels[Number(v)] ?? String(v)
  if (f.kind === 'usec') return f.options.find((o) => o.us === Number(v))?.label ?? `${v} µs`
  return String(v)
}

// ---- documents sent -------------------------------------------------------------------------

/**
 * The editChlVideoParam document for one part ('basic' or 'advanced'): only that part's
 * groups with a change, each complete, every value not being changed exactly as read.
 * `changes` must already be checked (checkChanges).
 */
function buildEdit(chlId, s, changes, part, { rebootPrompt = true } = {}) {
  if (!PARTS.includes(part)) throw new Error(`refused to send: unknown part ${part}`)
  const groups = new Set(Object.keys(changes).map(groupOf).filter((g) => partOf(g) === part))
  const val = (path, node) => (path in changes ? String(changes[path]) : node.text.trim())
  const leaf = (path, node) => `<${node.name}${PAGE_ATTRS[path] ? ` ${PAGE_ATTRS[path]}` : ''}>${esc(val(path, node))}</${node.name}>`
  let body = ''
  for (const c of s.chl.children) {
    if (!groups.has(groupOf(c.name))) continue
    if (c.children.length === 0) body += leaf(c.name, c)
    else {
      if (c.children.some((k) => k.children.length)) throw new Error(`refused to send: ${c.name} holds nested settings`)
      body += `<${c.name}>${c.children.map((k) => leaf(`${c.name}.${k.name}`, k)).join('')}</${c.name}>`
    }
  }
  if (!body) throw new Error(`refused to send: no ${part} settings to change`)
  const cfg = s.profile ? `<cfgFile>${esc(s.profile)}</cfgFile>` : ''
  return `${XML_HEADER}<content><chl id="${esc(chlId)}"><rebootPrompt>${rebootPrompt ? 'true' : 'false'}</rebootPrompt>${cfg}${body}</chl></content></request>`
}

/**
 * The schedule on its own (the page sends it with every advanced group, ds:237: unverified alone,
 * see the live-test list). cfgFile: for a fixed program (normal, day, night) the page sends that
 * program's profile (ds:229-236); for auto and time the profile shown.
 */
function buildSchedule(chlId, cfgFile, { program, dayTime, nightTime }) {
  return (
    `${XML_HEADER}<content><chl id="${esc(chlId)}"><rebootPrompt>true</rebootPrompt>${cfgFile ? `<cfgFile>${esc(cfgFile)}</cfgFile>` : ''}` +
    `<scheduleInfo><program>${esc(program)}</program><dayTime>${esc(dayTime)}</dayTime><nightTime>${esc(nightTime)}</nightTime></scheduleInfo></chl></content></request>`
  )
}

// ---- checks -------------------------------------------------------------------------------------

/** Does the controller of a dependent setting have the value it needs? after: values about to be set. */
function satisfied(s, need, after = {}) {
  const c = fieldOf(s, need.path)
  if (!c) return true // the camera reports no controller: nothing to depend on
  const v = need.path in after ? after[need.path] : c.value
  const shown = need.label && c.kind === 'index' ? c.labels[Number(v)] : v
  return 'eq' in need ? same(shown, need.eq) : !same(shown, need.ne)
}
const describeNeed = (s, need) => `${fieldOf(s, need.path)?.label ?? need.path} is ${'eq' in need ? shownNeed(need.eq) : `not ${shownNeed(need.ne)}`}`
const shownNeed = (v) => (v === true ? 'on' : v === false ? 'off' : String(v))

function checkValue(f, v) {
  const bad = (why) => {
    throw new HttpError(400, `${f.label} ${why}`)
  }
  if (f.kind === 'range' && !(Number.isInteger(v) && v >= f.min && v <= f.max)) bad(`must be a whole number from ${f.min} to ${f.max}`)
  if (f.kind === 'switch' && typeof v !== 'boolean') bad('must be on or off')
  if (f.kind === 'select' && !f.options.includes(v)) bad(`: "${v}" is not one of the camera's choices`)
  if (f.kind === 'index' && !(Number.isInteger(v) && v >= 0 && v < f.labels.length)) bad(`must be one of the camera's choices (0 to ${f.labels.length - 1})`)
  if (f.kind === 'usec' && !(Number.isInteger(v) && f.options.some((o) => o.us === v))) bad("must be one of the camera's exposure times")
  if (f.kind === 'time' && !(typeof v === 'string' && TIME_RE.test(v))) bad('must be a time hh:mm')
}

const EXPOSURE_FAMILY = /^(gain|shutter|autoExposureMode|smartIR|smartIr)\./
const NEEDS_EXEMPT = new Set(['undo', 'split', 'change-restart']) // they put back values the camera already had, or already checked

/**
 * Checks requested values against what the camera reports and returns only real changes.
 * Refuses combinations the NVR's page never sends. action: 'change' | 'undo' | 'split' |
 * 'change-restart'. other: the opposite profile, read fresh, for cameras that switch
 * between Day and Night by themselves.
 */
function checkChanges(s, changes, { action = 'change', other = null } = {}) {
  if (!isPlainObject(changes)) throw new HttpError(400, 'changes must be an object')
  const entries = Object.entries(changes)
  if (entries.length === 0) throw new HttpError(400, 'Nothing to change')
  if (entries.length > MAX_CHANGES) throw new HttpError(400, 'Too many changes at once')
  const out = {}
  for (const [path, v] of entries) {
    const f = fieldOf(s, path)
    if (!f) throw new HttpError(400, `This camera has no setting "${path}" that can be changed here`)
    checkValue(f, v)
    if (!same(f.value, v)) out[path] = v
  }
  const label = (p) => fieldOf(s, p)?.label ?? p
  const after = (p) => (p in out ? out[p] : fieldOf(s, p)?.value)
  // 1. a dependent setting on its own while its controller stays at a value it doesn't work with
  if (!NEEDS_EXEMPT.has(action)) {
    for (const p of Object.keys(out)) {
      const need = fieldOf(s, p).needs
      if (!need || need.path in out || satisfied(s, need)) continue
      throw new HttpError(400, `${label(p)} can only be changed while ${describeNeed(s, need)}`)
    }
  }
  // 2. the page locks anti-flicker while HWDR is on (ds:612, 657). Judged on the state after the
  //    change: turning HWDR off unlocks it, and the page then saves both in one request
  if ('antiflicker' in out && after('backlightCompensation.mode') === 'HWDR') {
    throw new HttpError(400, 'Anti-flicker cannot be changed while Backlight is HWDR (the NVR locks it)')
  }
  // 3. slowest shutter no faster than the fastest (ds:732-745)
  if (('shutter.upLimit' in out || 'shutter.lowLimit' in out) && fieldOf(s, 'shutter.upLimit') && fieldOf(s, 'shutter.lowLimit') && after('shutter.upLimit') > after('shutter.lowLimit')) {
    throw new HttpError(400, 'The slowest shutter must not be faster than the fastest')
  }
  // 4. white light on and off at the same time (compareTime, ds:746-755)
  if (('Whitelight.WhitelightOnTime' in out || 'Whitelight.WhitelightOffTime' in out) && same(after('Whitelight.WhitelightOnTime'), after('Whitelight.WhitelightOffTime'))) {
    throw new HttpError(400, 'The white light must not switch on and off at the same time')
  }
  // 5. the night light decides which white-light settings exist (the page reads again after it, ds:439, 803-805)
  if (Object.keys(out).some((p) => p.startsWith('illumination.')) && Object.keys(out).some((p) => /^(Whitelight|ImageOverExposure)\./.test(p))) {
    throw new HttpError(400, 'Change the night light on its own first: it decides which white-light settings the camera offers')
  }
  // 6. cameras that switch between Day and Night by themselves: never make the two differ in
  //    what can pause recording or restart the camera, or it would happen at every switch
  if (other && ['auto', 'time'].includes(s.schedule?.program) && ['day', 'night'].includes(s.profile)) {
    const o = (p) => fieldOf(other, p)?.value
    const hwdr = after('backlightCompensation.mode') === 'HWDR' || o('backlightCompensation.mode') === 'HWDR'
    const watched = (p) => p === 'backlightCompensation.mode' || p === 'WDR.switch' || (hwdr && (p === 'backlightCompensation.HWDRLevel' || EXPOSURE_FAMILY.test(p)))
    const differs = Object.keys(out).filter((p) => watched(p) && fieldOf(other, p) && !same(out[p], o(p)))
    if (differs.length) {
      throw new HttpError(
        400,
        `Day and Night would differ in ${differs.map(label).join(', ')}; the camera switches between them by itself, which may pause recording or restart it at every switch.`
      )
    }
  }
  return out
}

/**
 * Settings the NVR's page changes together: a new exposure mode sets the gain mode to match
 * (manual exposure -> manual gain, else auto; ds:663-668).
 * @returns {{ diff: object, implied: { path: string, to: any, because: string }[], couples: string[][] }}
 */
function expandChanges(s, diff, { action = 'change' } = {}) {
  const implied = []
  const couples = []
  const gm = fieldOf(s, 'gain.mode')
  if ('autoExposureMode.mode' in diff && gm) {
    const want = diff['autoExposureMode.mode'] === 'manual' ? 'manual' : 'auto'
    let idx = gm.labels.indexOf(want)
    if (idx < 0) idx = want === 'manual' ? 1 : 0 // the page's own values
    if (idx >= gm.labels.length) throw new HttpError(400, `This camera has no ${want} gain mode to go with ${want} exposure`)
    couples.push(['autoExposureMode', 'gain'])
    if ('gain.mode' in diff) {
      if (!same(diff['gain.mode'], idx) && !NEEDS_EXEMPT.has(action)) {
        throw new HttpError(400, `Gain mode follows the exposure mode on this camera (${want} exposure: ${gm.labels[idx]} gain)`)
      }
    } else if (!same(gm.value, idx)) implied.push({ path: 'gain.mode', to: idx, because: 'autoExposureMode.mode' })
  }
  const full = { ...diff }
  for (const i of implied) full[i.path] = i.to
  return { diff: full, implied, couples }
}

const IMPACT_TEXT = {
  'recording-gap': 'Recording stops for a few seconds while WDR switches, and some models restart. With HWDR on, some cameras allow a lower frame rate.',
  restart: 'TVT: with HWDR on, some cameras restart after exposure, shutter, gain or smart IR changes, and turn HWDR off. Offline about 1-2 min, a gap in recording.',
  'night-light': 'This changes the night light. A white floodlight lights the scene (and anyone nearby) all night; infrared is invisible but gives a black-and-white picture.',
  orientation: 'The picture turns over: privacy masks and detection zones may no longer line up.'
}
/** When each confirmation is asked for, for the panel's own predictions (the server decides). */
const IMPACT_RULES = [
  { key: 'recording-gap', paths: ['backlightCompensation.mode', 'WDR.switch', 'backlightCompensation.HWDRLevel'], when: 'Backlight changes to or from HWDR; WDR is switched; HWDR level changes while HWDR is on after the change', text: IMPACT_TEXT['recording-gap'] },
  { key: 'restart', prefixes: ['gain.', 'shutter.', 'autoExposureMode.', 'smartIR.', 'smartIr.'], hwdrAfter: true, when: 'HWDR is on after the change and gain, shutter, exposure or smart IR changes', text: IMPACT_TEXT.restart },
  { key: 'night-light', prefixes: ['illumination.', 'Whitelight.'], when: 'the night light or white light changes', text: IMPACT_TEXT['night-light'] },
  { key: 'orientation', paths: ['mirrorSwitch', 'flipSwitch'], when: 'mirror or flip changes', text: IMPACT_TEXT.orientation },
  { key: 'other-profile', when: 'the profile changed is not the one the camera reports as in use', text: 'The camera is using another profile now; this shows only when it switches.' }
]

/** What a change will do beyond the picture, judged on the state AFTER it. */
function impacts(s, diff, active) {
  const cur = (p) => fieldOf(s, p)?.value
  const after = (p) => (p in diff ? diff[p] : cur(p))
  const hwdrBefore = cur('backlightCompensation.mode') === 'HWDR'
  const hwdrAfter = after('backlightCompensation.mode') === 'HWDR'
  const paths = Object.keys(diff)
  const out = []
  const add = (key, list, text = IMPACT_TEXT[key]) => list.length && out.push({ key, text, paths: list })
  add('recording-gap', paths.filter((p) => (p === 'backlightCompensation.mode' && hwdrBefore !== hwdrAfter) || p === 'WDR.switch' || (p === 'backlightCompensation.HWDRLevel' && hwdrAfter)))
  add('restart', hwdrAfter ? paths.filter((p) => EXPOSURE_FAMILY.test(p)) : [])
  add('night-light', paths.filter((p) => /^(illumination|Whitelight)\./.test(p)))
  add('orientation', paths.filter((p) => p === 'mirrorSwitch' || p === 'flipSwitch'))
  if (s.profile && active && s.profile !== active) {
    const name = (p) => PROFILE_NAMES[p] ?? p
    add('other-profile', paths, `The camera is using its ${name(active)} profile now; this changes ${name(s.profile)}, which shows only when the camera switches to it.`)
  }
  return out
}

/** One entry per confirmation key (their paths joined), in the order first asked. */
function mergeImpacts(list) {
  const out = new Map()
  for (const i of list) {
    const m = out.get(i.key)
    if (m) m.paths = [...new Set([...m.paths, ...i.paths])]
    else out.set(i.key, { ...i, paths: [...i.paths] })
  }
  return [...out.values()]
}

/** The settings as they will be once `values` are applied (for judging a second request). */
const withValues = (s, values) => ({ ...s, fields: s.fields.map((f) => (f.path in values ? { ...f, value: values[f.path] } : f)) })

const sortObj = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
/** A short hash tying a confirmation to exactly what was shown. */
const tokenOf = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)

/** Refuses (409 needsAck) unless every impact is acknowledged with the matching token. */
function requireAck(list, token, body, extra = {}) {
  if (list.length === 0) return
  const ack = Array.isArray(body?.ack) ? body.ack : []
  if (body?.ackToken === token && list.every((i) => ack.includes(i.key))) return
  throw new HttpError(409, 'This change needs your confirmation', { needsAck: list.map(({ key, text, paths }) => ({ key, text, paths })), ackToken: token, ...extra })
}

/** Paths whose value now differs from what the admin saw: [{ path, label, now, shown }]. */
function staleOf(s, changes, seen) {
  if (!isPlainObject(seen)) throw new HttpError(400, 'seen must list the value shown for each change')
  const stale = []
  for (const p of Object.keys(changes)) {
    if (!(p in seen)) throw new HttpError(400, `seen has no value for ${p}`)
    const f = fieldOf(s, p)
    if (f && !same(f.value, seen[p])) stale.push({ path: p, label: f.label, now: f.value, shown: shownValue(f, f.value) })
  }
  return stale
}

/** The Defaults button's changes: picture and colour settings back to the camera's own defaults. */
function defaultsOf(s) {
  const out = {}
  for (const def of FIELDS.filter((x) => x.defaults)) {
    const f = fieldOf(s, def.path)
    if (!f || !['range', 'switch', 'select'].includes(f.kind) || f.default === null || f.default === undefined) continue
    if (!same(f.value, f.default)) out[f.path] = f.default
  }
  // a dependent value only when its controller ends up with a value it works with, or changes too
  for (const p of Object.keys(out)) {
    const need = fieldOf(s, p).needs
    if (need && !(need.path in out) && !satisfied(s, need, out)) delete out[p]
  }
  return out
}

// ---- change log (and Undo) ----------------------------------------------------------------
//
// Write-ahead: a "change" line (every setting before, and what is sent) is written BEFORE the
// edit goes out, a "result" line (what the camera then reports) after. If the first write
// fails, nothing is sent. Lines are tied to the device (host:port), channel and profile.

const readLog = () => readLogCached(LOG_FILE).filter((e) => typeof e.seq === 'string')
function writeLog(entry) {
  mkdirSync(dirname(LOG_FILE), { recursive: true })
  appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
}
const logKey = (e) => `${e.device}|${e.chl}|${e.profile ?? ''}`
const UNDOABLE = new Set(['change', 'split', 'change-restart'])
const NOTHING_APPLIED = new Set(['failed', 'restart-needed'])

/**
 * The newest change this app made to this camera and profile that is not undone yet, if the
 * camera still has exactly the values it reported right after it (side effects included; if
 * that read-back is missing, the values sent). A change that applied nothing is passed over,
 * unless the camera changed something else with it (a restart that turned HWDR off while the
 * gain limit was kept): then Undo puts back just those side effects (sideOnly).
 * @returns {{ entry: object, result: object | null, sideOnly: boolean } | null}
 */
function undoable(log, device, chlId, s) {
  const mine = log.filter((e) => e.kind === 'change' && e.device === device && e.chl === chlId && (e.profile ?? null) === (s.profile ?? null))
  // result lines carry only the seq of their change
  const results = new Map(log.filter((e) => e.kind === 'result').map((e) => [e.seq, e]))
  const undone = new Set(mine.filter((e) => e.action === 'undo' && ['done', 'partial'].includes(results.get(e.seq)?.result)).map((e) => e.undoes))
  for (const e of mine.filter((x) => UNDOABLE.has(x.action)).reverse()) {
    if (undone.has(e.seq)) continue
    const r = results.get(e.seq) ?? null
    const effects = Object.entries(r?.sideEffects ?? {})
    const sideOnly = NOTHING_APPLIED.has(r?.result)
    if (sideOnly && effects.length === 0) continue // nothing was applied, and nothing changed with it
    const expected = sideOnly ? {} : { ...(r?.after ?? e.to) }
    for (const [p, v] of effects) expected[p] = v[1]
    const now = (p) => (s.leaves ? s.leaves.get(p) : fieldOf(s, p)?.value)
    const matches = Object.entries(expected).every(([p, v]) => v === null || v === undefined || (now(p) !== undefined && same(now(p), v)))
    return matches && e.from ? { entry: e, result: r, sideOnly } : null
  }
  return null
}

/**
 * What Undo would send: the logged values before (unless nothing of the change was applied),
 * plus the side effects that can be put back. Not: settings this app can't write, values the
 * camera no longer offers, and anti-flicker while HWDR stays on (the NVR locks it).
 */
function undoTarget(last, s) {
  const target = last.sideOnly ? {} : { ...last.entry.from }
  const cannot = []
  for (const [p, [before]] of Object.entries(last.result?.sideEffects ?? {})) {
    const f = fieldOf(s, p)
    let v = null
    if (f && before !== null && before !== undefined) {
      v = typedValue(f, before)
      try {
        checkValue(f, v)
      } catch {
        v = null
      }
    }
    if (v === null) cannot.push(p)
    else target[p] = v
  }
  const after = (p) => (p in target ? target[p] : fieldOf(s, p)?.value)
  if ('antiflicker' in target && !same(fieldOf(s, 'antiflicker')?.value, target.antiflicker) && after('backlightCompensation.mode') === 'HWDR') {
    delete target.antiflicker
    cannot.push('antiflicker')
  }
  return { target, cannot }
}

/**
 * Undo in the order the NVR's page makes such changes: the night light first, on its own (it
 * decides which white-light settings the camera offers, ds:439, 803-805), then the white-light
 * and over-exposure settings after its read-back. One step otherwise.
 */
function undoSteps(s, target) {
  const diff = Object.fromEntries(Object.entries(target).filter(([p, v]) => !same(fieldOf(s, p)?.value, v)))
  const later = Object.keys(diff).filter((p) => /^(Whitelight|ImageOverExposure)\./.test(p))
  if (!Object.keys(diff).some((p) => p.startsWith('illumination.')) || later.length === 0) return [target]
  return [Object.fromEntries(Object.entries(target).filter(([p]) => !later.includes(p))), Object.fromEntries(later.map((p) => [p, diff[p]]))]
}

function undoView(last, s) {
  const label = (p) => fieldOf(s, p)?.label ?? p
  const { cannot } = undoTarget(last, s)
  const effects = Object.entries(last.result?.sideEffects ?? {})
  return {
    seq: last.entry.seq,
    at: last.entry.at,
    by: last.entry.user,
    action: last.entry.action,
    // sideOnly: nothing of the change itself was applied; Undo puts back what the camera changed with it
    sideOnly: Boolean(last.sideOnly),
    puts: last.sideOnly
      ? effects.filter(([p]) => !cannot.includes(p)).map(([p, [before]]) => `${label(p)} ${shownValue(fieldOf(s, p), before)}`).join(', ')
      : Object.entries(last.entry.from).map(([p, v]) => `${label(p)} ${shownValue(fieldOf(s, p), v)}`).join(', '),
    sideEffects: effects.map(([p, [before, after]]) => ({ path: p, label: label(p), to: before, now: after, writable: !cannot.includes(p) })),
    cannot: cannot.map(label) // "cannot be put back from here"
  }
}

/** Groups a recent change was refused for because they need a restart, still unchanged since. */
function restartOffers(log, device, chlId, s, now = Date.now()) {
  const out = []
  for (const r of log.filter((e) => e.kind === 'result' && Array.isArray(e.restartNeeded) && e.restartNeeded.length)) {
    if (now - Date.parse(r.at) > TIMING.restartWindowMs) continue
    const c = log.find((e) => e.kind === 'change' && e.seq === r.seq)
    if (!c || c.device !== device || c.chl !== chlId || (c.profile ?? null) !== (s.profile ?? null)) continue
    for (const group of r.restartNeeded) {
      const paths = restartPaths(c, group)
      if (paths.length === 0 || restartedAlready(log, r.seq, group)) continue
      if (!paths.every((p) => same(fieldOf(s, p)?.value, c.from[p]))) continue
      out.push({ seq: r.seq, group, label: groupLabel(group, s), at: r.at, changes: paths.map((p) => ({ path: p, label: fieldOf(s, p)?.label ?? p, from: c.from[p], to: c.to[p] })) })
    }
  }
  return out
}
/** The paths a restart for `group` sends: the group's, and its coupled group's (exposure with gain). */
function restartPaths(c, group) {
  const groups = new Set([group])
  for (const [a, b] of c.couples ?? []) {
    if (groups.has(a)) groups.add(b)
    if (groups.has(b)) groups.add(a)
  }
  return Object.keys(c.to ?? {}).filter((p) => groups.has(groupOf(p)))
}
const restartedAlready = (log, seq, group) =>
  log.some((e) => e.kind === 'change' && e.action === 'change-restart' && e.restartFor === seq && e.group === group && !NOTHING_APPLIED.has(log.find((r) => r.kind === 'result' && r.seq === e.seq)?.result))

// ---- a change -------------------------------------------------------------------------------

/** Reads until the sent values show (normal changes), or polls through a camera restart. */
async function readBack(ctx, s, diff, { poll, lock }) {
  const { nvr, chlId, gen } = ctx
  const shows = (x) => Object.entries(diff).every(([p, v]) => same(fieldOf(x, p)?.value, v))
  const read = async () => {
    const x = await readSettings(nvr, chlId, s.profile, gen)
    x.schedule ??= s.schedule
    return x
  }
  return readUntil(nvr, gen, read, shows, { poll, lock })
}

/**
 * Reads until shows(settings): at 1.5, 3 and 6 s; or, when the change may restart the camera
 * (poll), every 10 s for up to 3 minutes. Returns the last good read (null if none).
 */
async function readUntil(nvr, gen, read, shows, { poll = false, lock = null } = {}) {
  if (!poll) {
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
  // a camera that restarts goes offline: keep reading; stop at the first read that shows the
  // change after it was back; a camera that doesn't restart is read until the time is up
  if (lock) lock.note = 'waiting up to 3 minutes in case the camera restarts'
  const until = Date.now() + TIMING.pollMaxMs
  let last = null
  let failed = false
  while (Date.now() < until) {
    await sleep(TIMING.pollEveryMs)
    try {
      const x = await read()
      last = x
      if (failed && shows(x)) return x
    } catch {
      if (nvr.gen !== gen || !nvr.online) break
      failed = true
      last = null // offline since the last good read: that one is out of date
    }
  }
  return last
}

/**
 * Checks, logs, sends and reads back one change to one profile.
 * @param ctx { nvr, ch, chlId, name, gen, user, device, active }
 * @param target { path: value }
 * @param opts { s, action, undoes?, retryOf?, restartFor?, group?, seen?, other?, body?, preAcked?, rebootPrompt?, extraImpacts?, tokenExtra?, poll?, lock? }
 *   extraImpacts: confirmations asked together with this change's own (the restart path; an
 *   Undo's second step); tokenExtra: more that the confirmation is tied to (that second step)
 * @returns {Promise<{ settings, result }>}
 */
async function change(ctx, target, opts) {
  const { nvr, chlId, gen, user, device } = ctx
  const { s, action } = opts
  if (opts.seen !== undefined) {
    const stale = staleOf(s, target, opts.seen)
    if (stale.length) {
      throw new HttpError(409, `The camera's settings changed since you looked (${stale.map((x) => `${x.label} is now ${x.shown}`).join(', ')}); nothing was sent`, {
        stale: stale.map(({ path, label, now, shown }) => ({ path, label, now, shown })),
        settings: view(ctx, s)
      })
    }
  }
  const asked = checkChanges(s, target, { action, other: opts.other ?? null })
  if (Object.keys(asked).length === 0) {
    return { settings: s, result: { status: 'done', message: 'Nothing to change: the camera already has these values', groups: [], paths: {}, sideEffects: {}, restartNeeded: [], remaining: {} } }
  }
  const { diff, implied, couples } = expandChanges(s, asked, { action })
  const list = mergeImpacts([...(opts.extraImpacts ?? []), ...impacts(s, diff, ctx.active)])
  const token = tokenOf([device, chlId, s.profile ?? null, action, opts.restartFor ?? null, sortObj(diff), implied, list.map((i) => [i.key, i.text]), sortObj(opts.seen), opts.tokenExtra ?? null])
  if (!opts.preAcked) requireAck(list, token, opts.body)
  // every part's document first: one that can't be built means nothing is sent at all
  const docs = PARTS.map((part) => {
    const pd = Object.fromEntries(Object.entries(diff).filter(([p]) => partOf(groupOf(p)) === part))
    return Object.keys(pd).length ? { part, pd, xml: buildEdit(chlId, s, pd, part, { rebootPrompt: opts.rebootPrompt !== false }) } : null
  }).filter(Boolean)
  if (nvr.degraded || nvr.gen !== gen) throw new HttpError(409, `${nvr.name} is busy or reconnected; nothing was sent`)
  const seq = newSeq()
  const from = Object.fromEntries(Object.keys(diff).map((p) => [p, fieldOf(s, p).value]))
  const ack = list.map((i) => i.key)
  // write-ahead: if the "before" can't be recorded, nothing is sent
  writeLog({
    kind: 'change', seq, at: new Date().toISOString(), user, nvr: nvr.id, device, nvrName: nvr.name, chl: chlId, ch: ctx.ch + 1, name: ctx.name,
    profile: s.profile, active: ctx.active ?? null, action, undoes: opts.undoes, retryOf: opts.retryOf, restartFor: opts.restartFor, group: opts.group,
    from, to: diff, implied, couples, parts: docs.map((d) => d.part), ack, ackToken: token, rebootPrompt: opts.rebootPrompt !== false,
    before: Object.fromEntries(s.leaves)
  })
  console.log(`[imaging] ${nvr.id} ch${ctx.ch + 1} "${ctx.name}"${s.profile ? ` (${s.profile})` : ''}: ${Object.entries(diff).map(([p, v]) => `${p} ${from[p]} -> ${v}`).join(', ')} (${action}, by ${user})`)

  // send the parts in order (basic, then advanced); after one that is not accepted, nothing more
  const sent = [] // { part, answer, errorCode, reboot }
  let stopped = false
  let timedOut = false
  for (const d of docs) {
    if (stopped) {
      sent.push({ part: d.part, answer: 'not sent' })
      continue
    }
    let a
    try {
      a = parseAnswer(await transparent(nvr, EDIT_URL, d.xml, `picture change (${d.part})`, { gen }))
    } catch (e) {
      timedOut ||= e?.name === 'SdkTimeout'
      a = { status: e?.name === 'SdkTimeout' ? 'no answer in time' : 'error', errorCode: e.message, reboot: '' }
    }
    sent.push({ part: d.part, answer: a.status, errorCode: a.errorCode || undefined, reboot: a.reboot || undefined })
    if (a.status !== 'success') stopped = true
  }
  // a change that timed out may still be applied later: let it finish before checking
  if (timedOut) await settled(nvr)
  const anySuccess = sent.some((p) => p.answer === 'success')
  const poll = opts.poll || (anySuccess && ack.some((k) => k === 'restart' || k === 'recording-gap'))
  let now = null
  if (anySuccess || timedOut) now = await readBack(ctx, s, diff, { poll, lock: opts.lock })
  else {
    // refused: one read is enough to see what (if anything) changed
    await sleep(TIMING.verifyMs[0])
    now = await readSettings(nvr, chlId, s.profile, gen).catch(() => null)
    if (now) now.schedule ??= s.schedule
  }

  // what happened, setting by setting
  const byPart = new Map(sent.map((p) => [p.part, p]))
  const reboot = sent.find((p) => p.reboot)
  const flagged = reboot ? decodeReboot(reboot.reboot) : { groups: [], unknown: [] }
  const inDiff = new Set(Object.keys(diff).map(groupOf))
  const restartNeeded = flagged.groups.filter((g) => inDiff.has(g))
  const status = {}
  for (const p of Object.keys(diff)) {
    const ps = byPart.get(partOf(groupOf(p)))
    const shows = now && same(fieldOf(now, p)?.value, diff[p])
    status[p] =
      !ps || ps.answer === 'not sent' ? 'not-sent'
        : shows ? 'done'
          : ps.reboot ? (restartNeeded.includes(groupOf(p)) ? 'restart-needed' : 'refused')
            : !now ? 'unknown'
              : ps.answer === 'success' ? 'kept' : 'refused'
  }
  const values = Object.values(status)
  const result = values.every((x) => x === 'done') ? 'done'
    : values.some((x) => x === 'done') ? 'partial'
      : values.some((x) => x === 'unknown') ? 'unknown'
        : restartNeeded.length ? 'restart-needed' : 'failed'
  // settings that changed without being asked for
  const sideEffects = {}
  if (now) {
    const wanted = new Set(Object.keys(diff))
    for (const p of new Set([...s.leaves.keys(), ...now.leaves.keys()])) {
      if (wanted.has(p) || p.startsWith('scheduleInfo.')) continue
      const [b, a] = [s.leaves.get(p) ?? null, now.leaves.get(p) ?? null]
      if (b !== a) sideEffects[p] = [b, a]
    }
  }
  // after a restart refusal: what could go without it (never the flagged group's partner),
  // offered as a separate click; a retry that is refused again offers nothing more
  let remaining = {}
  if (reboot && !opts.retryOf && action === 'change') {
    const drop = new Set(restartNeeded)
    for (const [a, b] of couples) {
      if (drop.has(a)) drop.add(b)
      if (drop.has(b)) drop.add(a)
    }
    const impliedPaths = new Set(implied.map((i) => i.path))
    remaining = Object.fromEntries(Object.entries(diff).filter(([p]) => ['refused', 'not-sent'].includes(status[p]) && !drop.has(groupOf(p)) && !impliedPaths.has(p)))
  }
  const after = now ? Object.fromEntries(Object.keys(diff).map((p) => [p, fieldOf(now, p)?.value ?? null])) : null
  try {
    writeLog({ kind: 'result', seq, at: new Date().toISOString(), result, parts: sent, after, paths: status, sideEffects, restartNeeded, rebootRaw: reboot?.reboot, remaining })
    rotateLog(LOG_FILE, { keyOf: logKey })
  } catch (e) {
    console.warn(`[imaging] result not logged: ${e.message}`)
  }

  const label = (p) => fieldOf(s, p)?.label ?? p
  const groups = [...new Set(Object.keys(diff).map(groupOf))].map((g) => {
    const ps = Object.keys(diff).filter((p) => groupOf(p) === g)
    const st = ps.map((p) => status[p])
    return { group: g, label: groupLabel(g, s), paths: ps, status: st.every((x) => x === st[0]) ? st[0] : 'partial' }
  })
  const n = Object.keys(remaining).length
  const effects = Object.entries(sideEffects).map(([p, [b, a]]) => `${label(p)} ${shownValue(fieldOf(s, p), b ?? '(none)')} → ${shownValue(fieldOf(s, p), a ?? '(none)')}`)
  const done = action === 'undo' ? 'Undone' : action === 'change-restart' ? 'Applied (with the camera restart)' : 'Applied'
  const refusal = sent.find((p) => p.answer !== 'success' && p.answer !== 'not sent')
  let message =
    result === 'done' ? done
      : result === 'unknown' ? 'Sent, but the settings could not be read back. Check the picture, then reopen this panel.'
        : reboot
          ? restartNeeded.length
            ? `${restartNeeded.map((g) => groupLabel(g, s)).join(' and ')} need${restartNeeded.length === 1 ? 's' : ''} a camera restart; nothing in that part was changed.${n ? ` ${n} other change${n === 1 ? '' : 's'} can be applied without it.` : ''}`
            : `The NVR says this change restarts the camera ("${reboot.reboot}"), which this app does not recognise; nothing in that part was changed.`
          : result === 'partial' ? `Partly applied; the camera kept: ${Object.keys(diff).filter((p) => status[p] !== 'done').map(label).join(', ')}`
            : sent.some((p) => p.answer === 'success') ? 'The NVR accepted it, but the camera kept its settings'
              : `Not changed: ${whyRefused({ status: refusal?.answer, errorCode: refusal?.errorCode ?? '' })}`
  if (effects.length) message += `${/[.!]$/.test(message) ? '' : '.'} The camera also changed: ${effects.join(', ')}.`
  return { settings: now ?? s, result: { seq, status: result, message, groups, paths: status, sideEffects, restartNeeded, remaining, retryOf: opts.retryOf ?? null } }
}

// ---- API ------------------------------------------------------------------------------------

function view(ctx, s, log = readLog()) {
  const { nvr, ch, chlId, device } = ctx
  const program = s.schedule?.program ?? null
  const last = undoable(log, device, chlId, s)
  // a change that applied nothing, whose side effects can't be put back from here: nothing to offer
  const undo = last && (!last.sideOnly || Object.keys(undoTarget(last, s).target).length) ? undoView(last, s) : null
  return {
    nvr: { id: nvr.id, name: nvr.name, device },
    camera: { ch, name: ctx.name },
    profile: s.profile,
    profiles: s.profiles,
    active: ctx.active ?? s.profile,
    activeVerified: activeVerified(device, chlId, program),
    schedule: s.schedule,
    info: s.info,
    location: cameraNotes(device, chlId).location,
    sections: SECTIONS,
    fields: s.fields,
    needs: Object.fromEntries(s.fields.filter((f) => f.needs).map((f) => [f.path, f.needs])),
    defaults: defaultsOf(s),
    undo,
    restart: restartOffers(log, device, chlId, s),
    scheduleUndo: scheduleUndoView(log, device, chlId, s),
    impactRules: IMPACT_RULES
  }
}

/** The opposite profile, read fresh, when the camera switches between Day and Night by itself. */
async function otherProfile(ctx, s) {
  if (!['auto', 'time'].includes(s.schedule?.program) || !['day', 'night'].includes(s.profile)) return null
  return readSettings(ctx.nvr, ctx.chlId, s.profile === 'day' ? 'night' : 'day', ctx.gen)
}

async function changeFromBody(ctx, s, body, lock) {
  if (body.retryOf !== undefined) {
    // "Apply the other N changes" after a restart refusal: only those, and only once
    if (typeof body.retryOf !== 'string') throw new HttpError(400, 'retryOf must be the seq of the refused change')
    const log = readLog()
    const c = log.find((e) => e.kind === 'change' && e.seq === body.retryOf)
    const r = log.find((e) => e.kind === 'result' && e.seq === body.retryOf)
    if (!c || !r || c.device !== ctx.device || c.chl !== ctx.chlId || (c.profile ?? null) !== (s.profile ?? null)) throw new HttpError(409, 'That change is not in the log for this camera; reopen the panel')
    if (log.some((e) => e.kind === 'change' && e.retryOf === body.retryOf)) throw new HttpError(409, 'The other changes were already applied once; reopen the panel')
    const rem = r.remaining ?? {}
    if (!isPlainObject(body.changes) || !Object.entries(body.changes).every(([p, v]) => p in rem && same(rem[p], v))) {
      throw new HttpError(409, 'These are not the changes that were left over; reopen the panel')
    }
  }
  return change(ctx, body.changes, { s, action: 'change', retryOf: body.retryOf, seen: body.seen ?? null, other: await otherProfile(ctx, s), body, lock })
}

async function undo(ctx, s, body, lock) {
  if (typeof body.seq !== 'string') throw new HttpError(400, 'Undo needs the seq of the change shown')
  const last = undoable(readLog(), ctx.device, ctx.chlId, s)
  if (!last) throw new HttpError(409, 'Nothing to undo: the last change was undone already, or the settings were changed since; reopen the panel')
  if (last.entry.seq !== body.seq) throw new HttpError(409, 'Someone changed this camera since; reopen the panel')
  const { target } = undoTarget(last, s)
  if (Object.keys(target).length === 0) throw new HttpError(409, 'Nothing to undo: what the camera changed cannot be put back from here; reopen the panel')
  const other = await otherProfile(ctx, s)
  const undoes = last.entry.seq
  const [first, second] = undoSteps(s, target)
  if (!second) return change(ctx, first, { s, action: 'undo', undoes, other, body, lock })
  // two requests, one confirmation: the second step's own confirmations (judged on the state
  // after the first) are asked for with the first, and its values are part of the token
  const later = impacts(withValues(s, first), second, ctx.active)
  const r1 = await change(ctx, first, { s, action: 'undo', undoes, other, body, lock, extraImpacts: later, tokenExtra: sortObj(second) })
  const labels = (o) => Object.keys(o).map((p) => fieldOf(s, p)?.label ?? p).join(', ')
  const notDone = (why) => ({ ...r1, result: { ...r1.result, message: `${r1.result.message}${/[.!]$/.test(r1.result.message) ? '' : '.'} ${labels(second)} ${why}` } })
  if (r1.result.status !== 'done' || !r1.settings?.leaves) return notDone('not put back: it goes after the night light, which did not change back.')
  const s2 = r1.settings
  s2.schedule ??= s.schedule
  // the camera may have put them back itself with the night light, or no longer offer them
  const rest = Object.fromEntries(Object.entries(second).filter(([p, v]) => fieldOf(s2, p) && !same(fieldOf(s2, p).value, v)))
  if (Object.keys(rest).length === 0) return r1
  let r2
  try {
    r2 = await change(ctx, rest, { s: s2, action: 'undo', undoes, other, body, lock, preAcked: true })
  } catch (e) {
    if (!(e instanceof HttpError)) throw e
    return notDone(`not put back (${e.message}).`) // refused before anything of it was sent
  }
  return joinUndo(r1, r2, s)
}

/** One answer for an Undo made in two requests. */
function joinUndo(r1, r2, s) {
  const [a, b] = [r1.result, r2.result]
  const paths = { ...a.paths, ...b.paths }
  const values = Object.values(paths)
  const status = values.every((x) => x === 'done') ? 'done' : values.some((x) => x === 'done') ? 'partial' : b.status
  const sideEffects = { ...Object.fromEntries(Object.entries(a.sideEffects).filter(([p]) => !(p in b.paths))), ...b.sideEffects }
  const effects = Object.entries(sideEffects).map(([p, [x, y]]) => `${fieldOf(s, p)?.label ?? p} ${shownValue(fieldOf(s, p), x ?? '(none)')} → ${shownValue(fieldOf(s, p), y ?? '(none)')}`)
  const message = status === 'done'
    ? `Undone in two steps (the night light first, then the white light, as the NVR's page does).${effects.length ? ` The camera also changed: ${effects.join(', ')}.` : ''}`
    : `${a.message}${/[.!]$/.test(a.message) ? '' : '.'} Then: ${b.message}`
  return {
    settings: r2.settings,
    result: { seq: a.seq, status, message, groups: [...a.groups, ...b.groups], paths, sideEffects, restartNeeded: [...a.restartNeeded, ...b.restartNeeded], remaining: {}, retryOf: null, steps: [a.seq, b.seq] }
  }
}

/** "Restart camera to apply X": only a logged restart-needed group, unchanged since, never from ticks. */
async function restartFor(ctx, s, body, lock) {
  const log = readLog()
  const seq = body.restartFor
  const group = body.group
  if (typeof seq !== 'string' || typeof group !== 'string') throw new HttpError(400, 'restartFor and group are needed')
  const offer = restartOffers(log, ctx.device, ctx.chlId, s).find((o) => o.seq === seq && o.group === group)
  if (!offer) {
    const c = log.find((e) => e.kind === 'change' && e.seq === seq)
    const changedSince = c && restartPaths(c, group).some((p) => !same(fieldOf(s, p)?.value, c.from[p]))
    throw new HttpError(409, changedSince ? 'That setting was changed since; reopen the panel' : 'No restart is waiting for this change (it expires after 10 minutes, or was done already); apply the change again')
  }
  const c = log.find((e) => e.kind === 'change' && e.seq === seq)
  const target = Object.fromEntries(restartPaths(c, group).map((p) => [p, c.to[p]]))
  const extra = [{ key: 'restart-confirmed', text: `The camera restarts to apply ${offer.label}: offline about 1-2 minutes, and a gap in recording.`, paths: Object.keys(target) }]
  // the profile-difference rule holds here too: a restart must not leave Day and Night differing
  return change(ctx, target, { s, action: 'change-restart', restartFor: seq, group, rebootPrompt: false, extraImpacts: extra, poll: true, other: await otherProfile(ctx, s), body, lock })
}

// ---- schedule and the Day/Night set-up -----------------------------------------------------

const SCHEDULE_ACTIONS = new Set(['schedule', 'split-schedule'])
function scheduleText({ program, dayTime, nightTime }) {
  if (program === 'auto') return 'The camera then chooses Day or Night by the light, by itself. Under floodlights a camera may stay on Day all night. Changes then apply only to the profile it is using.'
  if (program === 'time') return `The camera then uses Day from ${dayTime} and Night from ${nightTime}, by itself.`
  if (program === 'normal') return 'The camera then always uses its Normal profile.'
  return `The camera then always uses its ${PROFILE_NAMES[program] ?? program} profile.`
}

function scheduleUndoable(log, device, chlId, cur) {
  const mine = log.filter((e) => e.kind === 'change' && e.device === device && e.chl === chlId && e.what === 'schedule')
  const results = new Map(log.filter((e) => e.kind === 'result').map((e) => [e.seq, e]))
  const undone = new Set(mine.filter((e) => e.action === 'schedule-undo' && results.get(e.seq)?.result === 'done').map((e) => e.undoes))
  const last = mine.filter((e) => SCHEDULE_ACTIONS.has(e.action) && !undone.has(e.seq) && results.get(e.seq)?.result === 'done').at(-1)
  const sched = cur.schedule
  if (!last || !sched) return null
  return ['program', 'dayTime', 'nightTime'].every((k) => same(sched[k], last.to[k])) ? last : null
}
function scheduleUndoView(log, device, chlId, s) {
  const last = s.schedule ? scheduleUndoable(log, device, chlId, s) : null
  return last ? { seq: last.seq, at: last.at, by: last.user, puts: `program ${last.from.program}` } : null
}

/**
 * What a schedule switch does (reads only): the camera then applies the profile(s) of the new
 * program, so this is judged like a change from the profile it uses now. Refused, as the
 * Day/Night set-up refuses it: switching by itself (auto, time) with HWDR on in a profile, or
 * with Day and Night differing in what can pause recording or restart the camera (the
 * profile-difference rule, C1-6); and any switch to a profile that differs in a setting this
 * app can't change (rotation, mains frequency, HFR). The other differences are listed in the
 * 'schedule' confirmation, and their own confirmations (restart, recording gap, night light,
 * orientation) are asked for too, all tied to one token.
 * @returns {Promise<{ reasons: string[], impacts: object[], poll: boolean }>}
 */
async function schedulePlan(ctx, cur, next) {
  const { nvr, chlId, gen } = ctx
  checkSchedule(cur.schedule, next)
  if (!cur.profile || !['normal', 'day', 'night'].every((p) => cur.profiles.includes(p))) throw new HttpError(400, 'This camera has no Day and Night profiles')
  const uses = ['auto', 'time'].includes(next.program) ? ['day', 'night'] : [next.program]
  if (!uses.every((p) => cur.profiles.includes(p))) throw new HttpError(400, `This camera has no "${next.program}" profile`)
  const read = async (p) => {
    const x = p === cur.profile ? cur : await readSettings(nvr, chlId, p, gen)
    x.schedule ??= cur.schedule
    return x
  }
  const targets = []
  for (const p of uses) targets.push([p, await read(p)])
  const name = (p) => PROFILE_NAMES[p] ?? p
  const reasons = []
  if (uses.length === 2) {
    if ([cur, ...targets.map(([, x]) => x)].some((x) => x.info.hwdr)) {
      reasons.push('HWDR is on: switching between Day and Night by itself, the camera could pause recording or restart at every switch (not offered on HWDR cameras)')
    }
    const [[, d], [, n]] = targets
    const hwdr = d.info.hwdr || n.info.hwdr
    const watched = (p) => p === 'backlightCompensation.mode' || p === 'WDR.switch' || (hwdr && (p === 'backlightCompensation.HWDRLevel' || EXPOSURE_FAMILY.test(p)))
    const differs = d.fields.filter((f) => watched(f.path) && fieldOf(n, f.path) && !same(f.value, fieldOf(n, f.path).value)).map((f) => f.label)
    if (differs.length) reasons.push(`Day and Night differ in ${differs.join(', ')}; the camera would switch between them by itself, which may pause recording or restart it at every switch`)
  }
  // from the profile in use now to each profile the camera will use
  const found = []
  const lines = []
  for (const [p, x] of targets) {
    if (p === cur.profile) continue
    const diff = {}
    const fixed = []
    for (const path of new Set([...cur.leaves.keys(), ...x.leaves.keys()])) {
      if (path.startsWith('scheduleInfo.')) continue
      const [a, b] = [cur.leaves.get(path) ?? null, x.leaves.get(path) ?? null]
      if (a === b) continue
      const f = fieldOf(x, path) ?? fieldOf(cur, path)
      if (!f || b === null) {
        fixed.push(f?.label ?? path)
        continue
      }
      diff[path] = typedValue(f, b)
      lines.push(`${name(p)}: ${f.label} ${a === null ? '(none)' : shownValue(fieldOf(cur, path) ?? f, typedValue(f, a))} → ${shownValue(f, diff[path])}`)
    }
    if (fixed.length) reasons.push(`${name(p)} differs from ${name(cur.profile)} (in use now) in ${fixed.join(', ')}, which this app does not change and which can restart the camera; change the schedule on the NVR`)
    found.push(...impacts(cur, diff, null))
  }
  const text = `${scheduleText(next)}${lines.length ? ` The camera then uses these values instead of ${name(cur.profile)}'s: ${lines.slice(0, 16).join('; ')}${lines.length > 16 ? `; and ${lines.length - 16} more` : ''}.` : ''}`
  const list = mergeImpacts([{ key: 'schedule', text, paths: ['scheduleInfo.program'] }, ...found])
  return { reasons, impacts: list, poll: list.some((i) => i.key === 'restart' || i.key === 'recording-gap') }
}

/** Checks a schedule to be written: one of the camera's programs, times hh:mm, day before night. */
function checkSchedule(sched, next) {
  if (!sched) throw new HttpError(400, 'This camera has no Day/Night schedule')
  if (!sched.programs.includes(next.program)) throw new HttpError(400, `"${next.program}" is not one of the camera's schedule choices`)
  if (!TIME_RE.test(next.dayTime ?? '') || !TIME_RE.test(next.nightTime ?? '')) throw new HttpError(400, 'Day and night times must be hh:mm')
  if (next.program === 'time' && !(next.dayTime < next.nightTime)) throw new HttpError(400, 'Day must start before night')
}

/**
 * Writes the schedule (program, day and night times), logged and read back (through a possible
 * camera restart when poll: the profile it switches to may restart it).
 */
async function writeSchedule(ctx, cur, next, { action, undoes, lock, poll = false, ack = [] }) {
  const { nvr, chlId, gen, device, user } = ctx
  const sched = cur.schedule
  checkSchedule(sched, next)
  const from = { program: sched.program, dayTime: sched.dayTime, nightTime: sched.nightTime }
  if (['program', 'dayTime', 'nightTime'].every((k) => same(from[k], next[k]))) return { settings: cur, result: { status: 'done', message: 'Nothing to change' } }
  if (nvr.degraded || nvr.gen !== gen) throw new HttpError(409, `${nvr.name} is busy or reconnected; nothing was sent`)
  // a fixed program is written with its own profile, as the page does (ds:229-236)
  const cfgFile = cur.profiles.includes(next.program) ? next.program : cur.profile
  const seq = newSeq()
  writeLog({ kind: 'change', seq, at: new Date().toISOString(), user, nvr: nvr.id, device, nvrName: nvr.name, chl: chlId, ch: ctx.ch + 1, name: ctx.name, profile: null, what: 'schedule', action, undoes, from, to: next, cfgFile, active: cur.profile, ack })
  console.log(`[imaging] ${nvr.id} ch${ctx.ch + 1} "${ctx.name}": schedule ${from.program} -> ${next.program} (${action}, by ${user})`)
  let a
  try {
    a = parseAnswer(await transparent(nvr, EDIT_URL, buildSchedule(chlId, cfgFile, next), 'picture schedule', { gen }))
  } catch (e) {
    a = { status: e?.name === 'SdkTimeout' ? 'no answer in time' : 'error', errorCode: e.message, reboot: '' }
    if (e?.name === 'SdkTimeout') await settled(nvr)
  }
  const matches = (x) => Boolean(x?.schedule) && ['program', 'dayTime', 'nightTime'].every((k) => same(x.schedule[k], next[k]))
  const accepted = a.status === 'success'
  const now = accepted || a.status === 'no answer in time'
    ? await readUntil(nvr, gen, () => readSettings(nvr, chlId, null, gen), matches, { poll, lock })
    : await sleep(TIMING.verifyMs[0]).then(() => readSettings(nvr, chlId, null, gen).catch(() => null))
  const shows = matches(now)
  const result = shows ? 'done' : now ? 'failed' : 'unknown'
  try {
    writeLog({ kind: 'result', seq, at: new Date().toISOString(), result, parts: [{ part: 'schedule', answer: a.status, errorCode: a.errorCode || undefined, reboot: a.reboot || undefined }], after: now?.schedule ?? null })
    rotateLog(LOG_FILE, { keyOf: logKey })
  } catch (e) {
    console.warn(`[imaging] schedule result not logged: ${e.message}`)
  }
  const message = shows ? (action === 'schedule-undo' ? 'Undone' : 'Applied') : now ? (a.status === 'success' ? 'The NVR accepted it, but the camera kept its schedule' : `Not changed: ${whyRefused(a)}`) : 'Sent, but the schedule could not be read back; reopen this panel.'
  return { settings: now ?? cur, result: { seq, status: result, message } }
}

/**
 * Day/Night set-up (read only): copy Normal into Day and Night, then let the camera switch by
 * the light. Offered only where it really separates night from day and is safe.
 */
async function splitPlan(ctx) {
  const { nvr, chlId, gen, device } = ctx
  const cur = await readSettings(nvr, chlId, null, gen)
  ctx.active = cur.profile
  const no = (reason) => ({ offerable: false, reasons: [reason], program: cur.schedule?.program ?? null })
  if (!['normal', 'day', 'night'].every((p) => cur.profiles.includes(p))) return no('This camera has no Day and Night profiles')
  if (!cur.schedule) return no('This camera reports no Day/Night schedule')
  const read = async (p) => {
    const x = p === cur.profile ? cur : await readSettings(nvr, chlId, p, gen)
    x.schedule ??= cur.schedule
    return x
  }
  const normal = await read('normal')
  const day = await read('day')
  const night = await read('night')
  const reasons = []
  const { program, programs } = cur.schedule
  if (program !== 'normal') reasons.push(`The camera already switches profiles by itself (${program})`)
  if (!programs.includes('auto')) reasons.push('The camera cannot switch profiles by the light')
  if ([normal, day, night].some((x) => x.info.hwdr)) reasons.push('HWDR is on: with separate profiles the camera could pause recording or restart at every day/night switch (not offered on HWDR cameras)')
  if (!cameraNotes(device, chlId).monoNightAt) {
    reasons.push('Under floodlights this camera stays in colour at night, so it would stay on the Day profile; separate profiles would not separate night from day. (It has not been measured in black-and-white at night yet.)')
  }
  // every leaf, not only the settings shown: a difference that can't be written would stay
  const diffOf = (target) => {
    const out = []
    for (const p of new Set([...normal.leaves.keys(), ...target.leaves.keys()])) {
      if (p.startsWith('scheduleInfo.')) continue
      const [from, to] = [target.leaves.get(p) ?? null, normal.leaves.get(p) ?? null]
      if (from === to) continue
      const f = fieldOf(target, p)
      out.push({ path: p, label: f?.label ?? p, from, to, writable: Boolean(f && to !== null) })
    }
    return out
  }
  const dayDiff = diffOf(day)
  const nightDiff = diffOf(night)
  const fixed = [...new Set([...dayDiff, ...nightDiff].filter((d) => !d.writable).map((d) => d.label))]
  if (fixed.length) reasons.push(`${fixed.join(', ')} differ${fixed.length === 1 ? 's' : ''} between the profiles and cannot be copied from here`)
  const targetOf = (x, list) => Object.fromEntries(list.filter((d) => d.writable).map((d) => [d.path, typedValue(fieldOf(x, d.path), d.to)]))
  const targets = { day: targetOf(day, dayDiff), night: targetOf(night, nightDiff) }
  // what it will do: each copy's own impacts, and the switch to automatic
  const merged = new Map()
  for (const [x, t] of [[day, targets.day], [night, targets.night]]) {
    for (const i of impacts(x, t, cur.profile)) {
      const m = merged.get(i.key)
      if (m) m.paths = [...new Set([...m.paths, ...i.paths])]
      else merged.set(i.key, { ...i, text: i.key === 'other-profile' ? 'The camera uses Normal until the switch to automatic at the end; the copies show only then.' : i.text })
    }
  }
  merged.set('schedule', { key: 'schedule', text: scheduleText({ program: 'auto' }), paths: ['scheduleInfo.program'] })
  const list = [...merged.values()]
  const ackToken = tokenOf([device, chlId, 'split', sortObj(targets.day), sortObj(targets.night), list.map((i) => [i.key, i.text])])
  return {
    offerable: reasons.length === 0,
    reasons,
    program,
    programs,
    day: dayDiff,
    night: nightDiff,
    targets,
    impacts: list,
    ackToken,
    cur,
    normal
  }
}
const planView = ({ cur, normal, targets, ...rest }) => rest

async function handleProfiles(method, ctx, readJson) {
  if (method === 'GET') return [200, { plan: planView(await splitPlan(ctx)) }]
  if (method !== 'POST') return [405, { error: 'Method not allowed' }]
  const body = await readBody(readJson, ctx)
  if (body.action !== 'split') throw new HttpError(400, 'action must be "split"')
  return withNvrLock(ctx.nvr, 'A Day/Night set-up', async (lock) => {
    // the plan again from fresh reads: the confirmation must be for exactly this
    const plan = await splitPlan(ctx)
    if (!plan.offerable) throw new HttpError(409, `Not offered: ${plan.reasons.join('; ')}`, { plan: planView(plan) })
    requireAck(plan.impacts, plan.ackToken, body, { plan: planView(plan) })
    const steps = []
    const stop = (message) => [200, { plan: planView(plan), result: { status: 'stopped', message: `${message} The camera stays on its Normal profile.`, steps } }]
    for (const which of ['day', 'night']) {
      const target = plan.targets[which]
      if (Object.keys(target).length === 0) {
        steps.push({ profile: which, status: 'done', message: 'Already the same as Normal' })
        continue
      }
      const s = await readSettings(ctx.nvr, ctx.chlId, which, ctx.gen)
      s.schedule ??= plan.cur.schedule
      const r = await change(ctx, target, { s, action: 'split', preAcked: true, lock })
      steps.push({ profile: which, ...r.result })
      if (r.result.status !== 'done') return stop(`Copying Normal into ${PROFILE_NAMES[which]}: ${r.result.message}.`)
    }
    // switch only when both copies really equal Normal, every leaf
    const normal = await readSettings(ctx.nvr, ctx.chlId, 'normal', ctx.gen)
    for (const which of ['day', 'night']) {
      const x = await readSettings(ctx.nvr, ctx.chlId, which, ctx.gen)
      const differ = [...new Set([...normal.leaves.keys(), ...x.leaves.keys()])].filter((p) => !p.startsWith('scheduleInfo.') && normal.leaves.get(p) !== x.leaves.get(p))
      if (differ.length) return stop(`${PROFILE_NAMES[which]} still differs from Normal in ${differ.join(', ')}.`)
    }
    const sched = plan.cur.schedule
    const r = await writeSchedule(ctx, plan.cur, { program: 'auto', dayTime: sched.dayTime, nightTime: sched.nightTime }, { action: 'split-schedule', lock })
    steps.push({ profile: null, what: 'schedule', ...r.result })
    if (r.result.status !== 'done') return stop(`Switching to automatic: ${r.result.message}.`)
    return [200, { plan: planView(plan), result: { status: 'done', message: 'Day and Night now start as copies of Normal, and the camera switches between them by the light.', steps } }]
  })
}

async function handleSchedule(method, ctx, readJson) {
  if (method !== 'POST') return [405, { error: 'Method not allowed' }]
  const body = await readBody(readJson, ctx)
  return withNvrLock(ctx.nvr, 'A schedule change', async (lock) => {
    const cur = await readSettings(ctx.nvr, ctx.chlId, null, ctx.gen)
    ctx.active = cur.profile
    if (!cur.schedule) throw new HttpError(400, 'This camera has no Day/Night schedule')
    const log = readLog()
    let next
    let undoes
    if (body.undo === true) {
      const last = scheduleUndoable(log, ctx.device, ctx.chlId, cur)
      if (!last || last.seq !== body.seq) throw new HttpError(409, 'Someone changed this camera\'s schedule since; reopen the panel')
      next = last.from
      undoes = last.seq
    } else {
      if (typeof body.program !== 'string') throw new HttpError(400, 'program is needed')
      if (!isPlainObject(body.seen) || !same(body.seen.program, cur.schedule.program)) {
        throw new HttpError(409, `The camera's schedule changed since you looked (now ${cur.schedule.program}); nothing was sent`, { stale: [{ path: 'scheduleInfo.program', now: cur.schedule.program }], settings: view(ctx, cur, log) })
      }
      next = { program: body.program, dayTime: body.dayTime ?? cur.schedule.dayTime, nightTime: body.nightTime ?? cur.schedule.nightTime }
    }
    // the same guards for an Undo: putting back "auto" is a switch to automatic like any other
    const plan = await schedulePlan(ctx, cur, next)
    if (plan.reasons.length) throw new HttpError(400, `Refused: ${plan.reasons.join('; ')}.`)
    requireAck(plan.impacts, tokenOf([ctx.device, ctx.chlId, 'schedule', sortObj(cur.schedule), sortObj(next), plan.impacts.map((i) => [i.key, i.text, i.paths])]), body)
    const r = await writeSchedule(ctx, cur, next, { action: body.undo === true ? 'schedule-undo' : 'schedule', undoes, lock, poll: plan.poll, ack: plan.impacts.map((i) => i.key) })
    return [200, { settings: view(ctx, r.settings), result: r.result }]
  })
}

/** The request body: a JSON object with confirm: true, for this NVR. */
async function readBody(readJson, ctx) {
  const body = await readJson()
  if (!isPlainObject(body)) throw new HttpError(400, 'The request must be a JSON object')
  if (body.confirm !== true) throw new HttpError(400, 'Changes need confirm: true')
  if (body.device !== ctx.device) throw new HttpError(409, 'These settings are out of date (the NVR or its address changed). Close the panel and open it again.')
  return body
}

/**
 * @param {string} method
 * @param {string} nvrId
 * @param {number} ch  0-based
 * @param {URLSearchParams} params
 * @param {() => Promise<any>} readJson
 * @param {string} user  the admin, for the change log
 * @param {'' | 'profiles' | 'schedule'} sub  /image, /image/profiles or /image/schedule
 * @returns {Promise<[number, any]>}
 */
export async function handleImaging(method, nvrId, ch, params, readJson, user, sub = '') {
  try {
    const { nvr, chlId, name } = cameraOf(nvrs, nvrId, ch)
    requireOnline(nvr)
    const ctx = { nvr, ch, chlId, name, gen: nvr.gen, user, device: deviceOf(nvr), active: null }
    if (sub === 'profiles') return await handleProfiles(method, ctx, readJson)
    if (sub === 'schedule') return await handleSchedule(method, ctx, readJson)
    if (method === 'GET') {
      const profile = params.get('profile') || null
      if (profile && !/^[A-Za-z]{1,16}$/.test(profile)) throw new HttpError(400, 'Bad profile')
      // the unconditioned read names the profile in use; another profile is read as well
      const cur = await readSettings(nvr, chlId, null, ctx.gen)
      ctx.active = cur.profile
      noteSeen(ctx.device, chlId, cur.profile, cur.schedule?.program)
      let s = cur
      if (profile && profile !== cur.profile) {
        s = await readSettings(nvr, chlId, profile, ctx.gen)
        s.schedule ??= cur.schedule
      }
      return [200, { settings: view(ctx, s) }]
    }
    if (method !== 'POST') return [405, { error: 'Method not allowed' }]
    const body = await readBody(readJson, ctx)
    const profile = body.profile ?? null
    if (profile !== null && !(typeof profile === 'string' && /^[A-Za-z]{1,16}$/.test(profile))) throw new HttpError(400, 'Bad profile')
    return await withNvrLock(nvr, 'A picture change', async (lock) => {
      // read again right before changing: never act on stale settings
      const cur = await readSettings(nvr, chlId, null, ctx.gen)
      ctx.active = cur.profile
      noteSeen(ctx.device, chlId, cur.profile, cur.schedule?.program)
      if (body.origin === 'auto' && profile && cur.profile && profile !== cur.profile) {
        const name = PROFILE_NAMES[cur.profile] ?? cur.profile
        throw new HttpError(409, `The camera switched to ${name} since you measured; measure again`, { active: cur.profile })
      }
      let s = cur
      if (profile && profile !== cur.profile) {
        s = await readSettings(nvr, chlId, profile, ctx.gen)
        s.schedule ??= cur.schedule
      }
      const r = body.restartFor !== undefined ? await restartFor(ctx, s, body, lock) : body.undo === true ? await undo(ctx, s, body, lock) : await changeFromBody(ctx, s, body, lock)
      return [200, { settings: view(ctx, r.settings ?? s), result: r.result }]
    })
  } catch (e) {
    return errorAnswer(e)
  }
}

// for the offline tests (cctv/test/imaging.test.mjs)
export const _test = {
  parseSettings,
  buildEdit,
  buildSchedule,
  checkChanges,
  expandChanges,
  impacts,
  defaultsOf,
  decodeReboot,
  undoable,
  undoTarget,
  staleOf,
  groupOf,
  partOf,
  chlIdOf,
  FIELDS,
  LOG_FILE,
  TIMING
}
