// Offline tests for the Picture panel's logic (public/image-panel.js) without a browser: the
// texts it shows, the exact Apply request, the result view with its two follow-ups, the stream
// estimate lines, and a scan of the source that pins down which methods can send a POST (every
// camera write must come from a click: Apply, Undo, the follow-ups, or a box's own button).
//   node cctv/test/image-panel.test.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyBody,
  measuredOrigin,
  applyLabel,
  changeLine,
  defaultsList,
  dirtyCount,
  estimateLines,
  focusLight,
  needMet,
  resultView,
  sameTexts,
  scheduleText,
  seenOf,
  undoText,
  usingText
} from '../public/image-panel.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

// a camera as GET /image shows it (the field shapes imaging.mjs sends)
const fields = [
  { path: 'bright', label: 'Brightness', section: 'Picture', group: 'basic', part: 'basic', kind: 'range', min: 0, max: 100, value: 50, default: 50 },
  { path: 'sharpen.switch', label: 'Sharpening', section: 'Picture', group: 'sharpen', part: 'advanced', kind: 'switch', value: true, default: false },
  { path: 'sharpen.value', label: 'Sharpening level', section: 'Picture', group: 'sharpen', part: 'advanced', kind: 'range', min: 0, max: 255, value: 199, default: 128, needs: { path: 'sharpen.switch', eq: true } },
  { path: 'gain.mode', label: 'Gain mode', section: 'Exposure', group: 'gain', part: 'advanced', kind: 'index', labels: ['auto', 'manual'], value: 0, shown: 'auto', default: 0 },
  { path: 'gain.AGC', label: 'Gain limit', section: 'Exposure', group: 'gain', part: 'advanced', kind: 'range', min: 0, max: 100, value: 50, default: 50, needs: { path: 'gain.mode', eq: 'auto', label: true } },
  { path: 'shutter.upLimit', label: 'Slowest shutter', section: 'Exposure', group: 'shutter', part: 'advanced', kind: 'index', labels: ['1/4', '1/8', '1/12', '1/15', '1/30'], value: 4, shown: '1/30', default: 4 },
  { path: 'autoExposureMode.value', label: 'Exposure time', section: 'Exposure', group: 'autoExposureMode', part: 'advanced', kind: 'usec', options: [{ label: '1/30', us: 33333 }, { label: '1/60', us: 16666 }], value: 16666, shown: '1/60', default: 33333 },
  { path: 'backlightCompensation.mode', label: 'Backlight', section: 'Light', group: 'backlightCompensation', part: 'advanced', kind: 'select', options: ['OFF', 'HWDR', 'HLC', 'BLC'], value: 'HWDR', default: 'OFF' }
]
const settings = {
  nvr: { id: 'nvr1', name: 'NVR 1', device: '192.168.0.228:6036' },
  camera: { ch: 13, name: 'North Gate' },
  profile: 'day',
  profiles: ['normal', 'day', 'night'],
  active: 'day',
  activeVerified: false,
  schedule: { program: 'auto', programs: ['normal', 'time', 'auto'], dayTime: '00:00', nightTime: '23:59' },
  info: { frequency: '60HZ', imageRotate: '0', hwdr: true },
  fields,
  defaults: { 'sharpen.switch': false, 'sharpen.value': 128 },
  undo: { seq: 's1', at: '2026-09-24T01:00:00Z', by: 'admin', action: 'change', puts: 'Sharpening on, Sharpening level 199', sideEffects: [{ path: 'backlightCompensation.mode', label: 'Backlight', to: 'HWDR', now: 'OFF', writable: true }], cannot: ['HFR'] },
  restart: [{ seq: 'r9', group: 'backlightCompensation', label: 'Backlight', at: '2026-09-24T01:02:00Z', changes: [{ path: 'backlightCompensation.mode', label: 'Backlight', from: 'HWDR', to: 'OFF' }] }]
}

// ---- texts -----------------------------------------------------------------------------------------
{
  const notes = { seen: [{ at: new Date(Date.now() - 3600_000).toISOString(), cfgFile: 'day' }] }
  const t = usingText(settings, notes)
  check('Using: "Using: Day profile now", not confirmed: not yet seen on Night, and what it last reported', /^Using: Day profile now\./.test(t) && /not yet seen on Night/.test(t) && /it still reported Day/.test(t), t)
  check('  verified or program normal: no caveat', usingText({ ...settings, activeVerified: true }) === 'Using: Day profile now.')
  check('  another profile shown: said so', /Showing Night: changes here show only when the camera switches to it/.test(usingText({ ...settings, profile: 'night', activeVerified: true })))
  check('  no profiles: nothing', usingText({ ...settings, profile: null }) === null)
  check('schedule text: auto, time (with times), day and night programs', /by the light/.test(scheduleText({ program: 'auto' })) && /Day from 07:00, Night from 19:00/.test(scheduleText({ program: 'time', dayTime: '07:00', nightTime: '19:00' })) && /always uses Day/.test(scheduleText({ program: 'day' })) && /always uses Night/.test(scheduleText({ program: 'night' })))
  check('changeLine: the camera\'s own labels (index and exposure time)', changeLine(fields[5], 4, 3) === 'Slowest shutter 1/30 → 1/15' && changeLine(fields[6], 16666, 33333) === 'Exposure time 1/60 → 1/30' && changeLine(fields[1], true, false) === 'Sharpening on → off')
  const u = undoText(settings.undo)
  check('Undo names the change and its side effects (and what it cannot put back)', /Undo puts back Sharpening on, Sharpening level 199/.test(u) && /Backlight HWDR/.test(u) && /Cannot be put back from here: HFR/.test(u), u)
  const d = defaultsList(settings)
  check('Defaults preview: the server\'s set, as from -> to lines', d.length === 2 && d[0].text === 'Sharpening on → off' && d[1].text === 'Sharpening level 199 → 128')
  const so = undoText({ seq: 's2', at: '2026-09-24T01:00:00Z', by: 'admin', sideOnly: true, puts: 'Backlight HWDR', sideEffects: [{ path: 'backlightCompensation.mode', label: 'Backlight', to: 'HWDR', now: 'OFF', writable: true }], cannot: [] })
  check('Undo of a change that applied nothing but changed something else: says just that', /^Undo puts back what the camera changed by itself when a change was not applied: Backlight HWDR/.test(so) && !/and what the camera also changed/.test(so), so)
}

// ---- Focus now: only in good light, judged again at the click -------------------------------------------
{
  const now = Date.parse('2026-09-24T15:00:00Z')
  const last = (extra = {}) => ({ period: 'day', mono: false, mean: 60, at: now - 60_000, indoor: false, ...extra })
  check('focusLight: by day (the sun now), measured a minute ago -> offered; posts that light', focusLight(last(), { now, period: 'day' }).ok && focusLight(last(), { now, period: 'day' }).light.period === 'day')
  check('  measured by day, but it is dusk now -> not offered', !focusLight(last(), { now, period: 'dusk' }).ok)
  check('  a measurement over 10 minutes old -> not offered, "measure again"', !focusLight(last({ at: now - 11 * 60_000 }), { now, period: 'day' }).ok && /measure again/.test(focusLight(last({ at: now - 11 * 60_000 }), { now, period: 'day' }).why))
  check('  at night: only a lit indoor colour scene (not an outdoor floodlit one)', focusLight(last({ indoor: true, mean: 120 }), { now, period: 'night' }).ok && !focusLight(last({ indoor: false, mean: 120 }), { now, period: 'night' }).ok && !focusLight(last({ indoor: true, mean: 120, mono: true }), { now, period: 'night' }).ok)
  check('  never measured -> not offered', !focusLight(null).ok)
}

// ---- dependent settings -------------------------------------------------------------------------------
{
  const byPath = new Map(fields.map((f) => [f.path, f]))
  const cur = (p) => byPath.get(p).value
  check('needMet: level while sharpening is on', needMet(fields[2].needs, byPath, cur))
  check('  not once the switch is (about to be) off', !needMet(fields[2].needs, byPath, (p) => (p === 'sharpen.switch' ? false : cur(p))))
  check('  an index controller compared by its label (gain mode "auto")', needMet(fields[4].needs, byPath, cur) && !needMet(fields[4].needs, byPath, (p) => (p === 'gain.mode' ? 1 : cur(p))))
  check('  "not" rules and a missing controller', needMet({ path: 'backlightCompensation.mode', ne: 'OFF' }, byPath, cur) && needMet({ path: 'nothing', eq: 1 }, byPath, cur))
}

// ---- the Apply request -----------------------------------------------------------------------------------
{
  const pending = new Map([['sharpen.switch', false], ['sharpen.value', 128], ['shutter.upLimit', 3]])
  const manual = applyBody(settings, pending, new Map([['sharpen.switch', 'defaults'], ['sharpen.value', 'defaults'], ['shutter.upLimit', 'manual']]))
  check('Apply sends exactly the unsent values', JSON.stringify(manual.changes) === JSON.stringify({ 'sharpen.switch': false, 'sharpen.value': 128, 'shutter.upLimit': 3 }))
  check('  with what was seen for every one, exactly as the GET gave it (index as its integer)', JSON.stringify(manual.seen) === JSON.stringify({ 'sharpen.switch': true, 'sharpen.value': 199, 'shutter.upLimit': 4 }))
  check('  device, profile and confirm; no origin for hand-made changes', manual.device === '192.168.0.228:6036' && manual.profile === 'day' && manual.confirm === true && !('origin' in manual) && !('ack' in manual))
  const auto = applyBody(settings, pending, new Map([['sharpen.switch', 'auto'], ['sharpen.value', 'auto']]))
  check('  origin "auto" when any came from Auto adjust (the server then checks the profile in use)', auto.origin === 'auto')
  const colour = applyBody(settings, pending, new Map([['sharpen.switch', 'colour'], ['sharpen.value', 'manual']]))
  check('  and when any came from the colour check: its own origin in the panel, "auto" to the server', colour.origin === 'auto' && measuredOrigin(new Map([['hue', 'colour']])) && !measuredOrigin(new Map([['hue', 'manual'], ['bright', 'defaults']])) && !measuredOrigin(undefined))
  check('seenOf: missing setting -> null (the server refuses it)', seenOf(settings, ['nope']).nope === null)
  check('Apply label: count, and the measurement\'s age after 5 minutes', applyLabel(0) === 'Apply' && applyLabel(3, Date.now() - 60_000) === 'Apply 3 changes' && applyLabel(1, Date.now() - 7 * 60_000) === 'Apply 1 change (measured 7 min ago)')
  check('dirty: unsent values plus ticked Recording-quality suggestions', dirtyCount(pending, 1) === 4 && dirtyCount(new Map(), 0) === 0)
}

// ---- the result view --------------------------------------------------------------------------------------
{
  const refused = {
    seq: 'r9',
    status: 'restart-needed',
    message: 'Backlight needs a camera restart; nothing in that part was changed. 1 other change can be applied without it.',
    groups: [{ group: 'backlightCompensation', label: 'Backlight', paths: ['backlightCompensation.mode'], status: 'restart-needed' }, { group: 'basic', label: 'Brightness, contrast, hue and saturation', paths: ['bright'], status: 'not-sent' }],
    paths: { 'backlightCompensation.mode': 'restart-needed', bright: 'not-sent' },
    sideEffects: { 'gain.mode': ['0', '1'], 'sharpen.switch': ['true', 'false'] },
    restartNeeded: ['backlightCompensation'],
    remaining: { bright: 56 },
    retryOf: null
  }
  const v = resultView(refused, settings)
  check('result: each group with its outcome', v.groups.map((g) => g.text).join(' | ') === 'Backlight: needs a camera restart | Brightness, contrast, hue and saturation: not sent', v.groups.map((g) => g.text).join(' | '))
  check('  side effects in the camera\'s labels ("Gain mode auto → manual")', v.sideEffects.join() === 'Gain mode auto → manual,Sharpening on → off', v.sideEffects.join())
  check('  "Apply the other 1 change" and one "Restart camera to apply Backlight" offer', v.other === 1 && v.offers.length === 1 && v.offers[0].group === 'backlightCompensation')
  check('  after a retry: no further "other changes"', resultView({ ...refused, retryOf: 'r8', seq: 'r10' }, settings).other === 0)
  check('  offers belong to this change only', resultView({ ...refused, seq: 'other' }, settings).offers.length === 0)
  check('  "nothing to change" answers (no seq) show plainly', resultView({ status: 'done', message: 'Nothing to change: the camera already has these values', groups: [], paths: {}, sideEffects: {}, restartNeeded: [], remaining: {} }, settings).other === 0)
}

// ---- stream estimate -------------------------------------------------------------------------------------
{
  const e = {
    from: { enct: 'h265', res: '3840x2160', fps: 20, QoI: 5120, level: 'higher' },
    to: { enct: 'h265', res: '3840x2160', fps: 20, QoI: 6144, level: 'higher' },
    bandwidth: { totalMbps: 320, freeBeforeMbps: 140.5, freeAfterMbps: 139.5 },
    remain: { before: [{ days: 31, group: '1' }], after: [{ days: 28, group: '1' }], error: null, cycle: false, ratio: 0.97 },
    worstCase: { text: 'This camera now sends 4919 of 5120 kbit/s. After the change it may send up to 6144: +1225 kbit/s = +13.2 GB/day.' },
    impacts: [{ key: 'storage', text: 'Recording uses up to 6144 instead of 5120 kbit/s' }]
  }
  const lines = estimateLines(e)
  check('estimate: what changes, the NVR\'s days before -> after, bandwidth and the worst case', lines[0] === 'Bitrate cap (kbit/s): 5120 → 6144' && /31 → 28/.test(lines[1]) && /140.5 → 139.5 Mbit\/s of 320/.test(lines[2]) && /\+13.2 GB\/day/.test(lines[3]), lines.join(' | '))
  const cyc = estimateLines({ ...e, remain: { before: [{ days: 0 }], after: [{ days: 0 }], cycle: true, ratio: 0.97 } })
  check('  cycle recording: the ratio instead of days', cyc.some((l) => /cycle recording/.test(l) && /97%/.test(l)))
  check('sameTexts: the server\'s confirmation equals what the estimate showed (one click covers it)', sameTexts(e.impacts, e.impacts.map((i) => i.text)) && !sameTexts([{ text: 'other' }], ['Recording uses']) && !sameTexts([], []))
}

// ---- no camera write without a click ----------------------------------------------------------------------
{
  const src = readFileSync(join(import.meta.dirname, '..', 'public', 'image-panel.js'), 'utf8')
  const lines = src.split('\n')
  const methodAt = (i) => {
    for (let j = i; j >= 0; j--) {
      const m = /^ {2}(?:async )?([A-Za-z]\w*)\(/.exec(lines[j])
      if (m) return m[1]
    }
    return null
  }
  const posters = new Map()
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/api\('POST', this\.url\('([\w/]+)'\)|this\.post\('([\w/]+)'/g)) {
      const what = m[1] ?? m[2]
      const name = methodAt(i)
      posters.set(`${name}:${what}`, (posters.get(`${name}:${what}`) ?? 0) + 1)
    }
  })
  const expected = ['change:image', 'saveLocation:notes', 'postFigures:figures', 'reviewStream:stream/estimate', 'reviewStream:stream', 'undoStream:stream', 'lensPost:lens', 'split:image/profiles', 'undoSchedule:image/schedule']
  check('POSTs only from these methods (camera writes: change, stream, lens, split, schedule; app data: notes, figures)', [...posters.keys()].sort().join() === [...expected].sort().join(), [...posters.keys()].join())
  const changeCalls = lines.map((l, i) => (/this\.change\(/.test(l) ? methodAt(i) : null)).filter(Boolean)
  check('  a picture change is only sent from Apply, Undo, "Apply the other N" and "Restart camera"', [...new Set(changeCalls)].sort().join() === ['apply', 'applyOther', 'restart', 'undo'].join(), changeCalls.join())
  const clickers = ['apply', 'undo', 'applyOther', 'restart', 'reviewStream', 'undoStream', 'saveLens', 'focusNow', 'split', 'undoSchedule']
  check('  each is started by a click handler', clickers.every((m) => new RegExp(`addEventListener\\('click', \\(\\) => this\\.${m}\\(`).test(src)), clickers.filter((m) => !new RegExp(`addEventListener\\('click', \\(\\) => this\\.${m}\\(`).test(src)).join())
  const auto = src.slice(src.indexOf('  async autoAdjust('), src.indexOf('  /** Two keyframe-aligned sets'))
  check('  Auto adjust itself sends nothing to the camera (reads only)', !/api\('POST'|this\.post\(|this\.change\(/.test(auto))
  check('  suggestions only prefill unsent values (mergePending), never Apply', /mergePending\(this\.pending, this\.origins, items\)/.test(src) && !/report\([^)]*\)[\s\S]{0,40}this\.apply\(/.test(src))
  // the review's texts: no claim the rules can't back
  check('texts: "No suggestions from these rules for this light", never "looks right"', /No suggestions from these rules for this light/.test(src) && !/looks right/.test(src))
  check('switching the profile shown asks before unsent changes go (the select, and "Show <in use>")', (src.match(/confirmDiscard\(this\.pending\.size\)/g) ?? []).length === 2)
  check('closing while a change is on its way says so, instead of "Discard N unsent changes?"', /this\.sending > 0\) return window\.confirm\('A change is being applied/.test(src))
  check('after an applied change the stream meter is marked, and the after-check uses only what came since', /this\.meter\?\.mark\(\)/.test(src) && /streamFigures\(\{ sinceMark: true \}\)/.test(src))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
