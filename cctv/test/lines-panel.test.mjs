// Offline tests for the Lines panel's logic (public/lines-panel.js) without a browser: the change it
// sends for what was drawn and set (checked against the server's own rules in tripwire-xml.mjs, on
// the captured answers of three camera models), the texts, the result view, the phone-alert state,
// and a scan of the source that pins down which methods can send a POST (every camera write must
// come from a click on Save or Undo; the alert switch changes only Argus's alarm rule).
//   node cctv/test/lines-panel.test.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  alertNote,
  alertOn,
  autoAlert,
  blockedText,
  changeLines,
  changeOf,
  draftOf,
  fieldLabel,
  mutexOn,
  ntfyHelp,
  resultView,
  saveLabel,
  scheduleChoices,
  slotText,
  undoText,
  unchangedSince,
  valueText
} from '../public/lines-panel.js'
import { applyChange, checkChange, compareReadBack, parseSchedules, parseTripwire } from '../tripwire-xml.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const show = (x) => JSON.stringify(x)
const fixture = (f) => readFileSync(join(import.meta.dirname, 'fixtures', 'lines', f), 'utf8')

// the three models captured from nvr-2: IP6196W (filter with sizes), IP619E5W (no filter), CAM-IP6196G (filter, no sizes)
const ch1 = parseTripwire(fixture('tripwire-ch1.xml'))
const ch3 = parseTripwire(fixture('tripwire-ch3.xml'))
const ch4 = parseTripwire(fixture('tripwire-ch4.xml'))
const schedules = parseSchedules(fixture('schedulelist.xml'))
const S24x5 = schedules.find((s) => s.name === '24x5').id

// ---- the draft and the change it makes ----------------------------------------------------------
{
  const d = draftOf(ch3)
  check('draftOf: a copy (drawing never touches the settings shown)', d.lines !== ch3.lines && d.lines[0].start !== ch3.lines[0].start && show(d.lines[0]) === show({ direction: 'rightortop', start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }))
  check('  no filter on the IP619E5W: null', d.filter === null && d.enabled === false && d.holdTime === 20)
  check('  the IP6196W\'s classes as { on, sensitivity } (sizes are the camera\'s, never shown or sent)', Object.keys(draftOf(ch1).filter).length === 3 && ['car', 'person', 'motor'].every((k) => show(draftOf(ch1).filter[k]) === '{"on":true,"sensitivity":50}'))
  check('changeOf: nothing changed -> {}', show(changeOf(ch3, d)) === '{}' && changeLines(ch3, d).length === 0 && saveLabel(0) === 'Save')

  // the first live test: Maingate Roadway, one line across the road, on, hold 10 s
  d.enabled = true
  d.holdTime = 10
  d.lines[0] = { direction: 'rightortop', start: { x: 1200, y: 6000 }, end: { x: 8800, y: 5400 } }
  const c = changeOf(ch3, d)
  check('changeOf: on, hold time and all four slots (the server takes the whole list)', show(Object.keys(c)) === '["enabled","holdTime","lines"]' && c.lines.length === 4 && show(c.lines[1]) === show({ direction: 'rightortop', start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }), show(c))
  check('  only direction, start and end per slot (the camera\'s per-line sensitivity is not the panel\'s)', c.lines.every((l) => show(Object.keys(l)) === '["direction","start","end"]'))
  const verdict = checkChange(ch3, c, { schedules })
  check('  the server\'s own check takes it (no refusal)', verdict.refuse === null, verdict.refuse)
  check('  with the warnings it will ask about: no filter on this camera', verdict.warnings.map((w) => w.key).join() === 'no-filter', show(verdict.warnings))
  const asked = applyChange(ch3, c)
  check('  and the camera would then have exactly what was drawn', show(asked.lines.map(({ direction, start, end }) => ({ direction, start, end }))) === show(d.lines) && asked.enabled && asked.holdTime === 10)
  check('changeLines: plain words, one per change', show(changeLines(ch3, d, schedules)) === show(['Line crossing: off → on', 'Line 1: new line (A → B)', 'Hold time: 20 s → 10 s']), show(changeLines(ch3, d, schedules)))
  check('saveLabel counts them', saveLabel(3) === 'Save 3 changes' && saveLabel(1) === 'Save 1 change')

  // the same camera once it has that line: moved, turned, a second one cleared
  const had = applyChange(ch3, c)
  const e = draftOf(had)
  e.lines[0].end = { x: 9000, y: 5000 }
  e.lines[0].direction = 'none'
  check('slotText: saved, moved/turned, new, cleared', slotText(had.lines[0], had.lines[0]) === 'drawn' && slotText(e.lines[0], had.lines[0]) === 'moved, not saved' && slotText(had.lines[1], had.lines[1]) === 'not drawn' && slotText(d.lines[0], ch3.lines[0]) === 'new, not saved' && slotText({ ...had.lines[0], direction: 'none' }, had.lines[0]) === 'turned, not saved')
  check('  a line moved and turned', show(changeLines(had, e)) === show(['Line 1: moved, direction now A ↔ B']))
  e.lines[0] = { direction: 'none', start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }
  check('  a cleared slot: all zeros, keeping a direction the camera lists', changeLines(had, e)[0] === 'Line 1: cleared' && checkChange(had, changeOf(had, e)).refuse === null && show(changeOf(had, e).lines[0]) === show({ direction: 'none', start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }))
  check('slotText: cleared', slotText(e.lines[0], had.lines[0]) === 'cleared, not saved')
}

{
  // the person/vehicle filter: only the classes and values that changed
  const d = draftOf(ch1)
  d.filter.car.on = false
  d.filter.person.sensitivity = 70
  const c = changeOf(ch1, d)
  check('changeOf, filter: only what changed, per class', show(Object.keys(c)) === '["filter"]' && Object.keys(c.filter).length === 2 && show(c.filter.car) === '{"on":false}' && show(c.filter.person) === '{"sensitivity":70}', show(c))
  check('  the server takes it, and keeps the classes\' sizes', checkChange(ch1, c).refuse === null && show(applyChange(ch1, c).filter.classes.person.min) === show(ch1.filter.classes.person.min))
  check('  in words, person first', show(changeLines(ch1, d)) === show(['Person sensitivity: 50 → 70', 'Car: on → off']), show(changeLines(ch1, d)))
  const d4 = draftOf(ch4)
  d4.filter.motor.on = false
  d4.scheduleGuid = S24x5
  const c4 = changeOf(ch4, d4)
  check('  CAM-IP6196G (no sizes) and a schedule from the NVR\'s list', show(c4) === show({ scheduleGuid: S24x5, filter: { motor: { on: false } } }) && checkChange(ch4, c4, { schedules }).refuse === null)
  check('  the schedule by its name', changeLines(ch4, d4, schedules).includes('Schedule: 24x7 → 24x5'))
  const single = { ...ch3, filter: { kind: 'single', sensitivity: 40 } }
  const ds = draftOf(single)
  ds.filter.sensitivity = 55
  check('  a camera with one sensitivity: { sensitivity }', show(changeOf(single, ds)) === '{"filter":{"sensitivity":55}}' && changeLines(single, ds)[0] === 'Sensitivity: 40 → 55' && checkChange(single, changeOf(single, ds)).refuse === null)
}

// ---- choices and warnings shown before anything is sent -------------------------------------------------
check('scheduleChoices: the NVR\'s list', show(scheduleChoices(ch3, schedules).map((s) => s.name)) === '["24x7","24x5","24x2"]')
check('  the camera\'s own schedule is added when the list lacks it (or could not be read)', scheduleChoices(ch3, []).length === 1 && scheduleChoices(ch3, [])[0].id === ch3.scheduleGuid && scheduleChoices({ ...ch3, scheduleGuid: '{11111111-2222-3333-4444-555555555555}' }, schedules).length === 4)
check('mutexOn: only the detections that are on, in words', mutexOn(ch3).length === 0 && show(mutexOn({ ...ch3, mutex: [{ object: 'perimeter', on: true }, { object: 'osc', on: false }] })) === '["intrusion zones"]')
check('blockedText: none on the captured cameras', blockedText(ch1) === null && blockedText(ch3) === null && blockedText(ch4) === null)
const blocked = blockedText({ ...ch3, triggerWhiteLight: true })
check('  a white-light trigger that is on blocks every change, and says why', /white-light trigger is on/.test(blocked) && /by hand only/.test(blocked), blocked)
check('  the server refuses the same camera too', /floodlight is worked by hand only/.test(checkChange({ ...ch3, triggerWhiteLight: true }, { enabled: true }).refuse ?? ''))
check('undoText: when and by whom', /^Undo puts back the line settings from before the last change \(made .+ by mike\)\.$/.test(undoText({ seq: 's1', at: '2026-09-27T20:00:00Z', by: 'mike' })) && undoText(null) === null)

// ---- the result, from the read-back ---------------------------------------------------------------------
{
  const before = ch3
  const d = draftOf(ch3)
  d.enabled = true
  d.holdTime = 10
  d.lines[0] = { direction: 'rightortop', start: { x: 1200, y: 6000 }, end: { x: 8800, y: 5400 } }
  const asked = applyChange(before, changeOf(before, d))
  // the camera took the line and the switch, kept its hold time, and switched its push message off by itself
  const after = structuredClone(asked)
  after.holdTime = 20
  after.trigger.msgPush = false
  const { fields, sideEffects } = compareReadBack(before, asked, after)
  const v = resultView({ fields, sideEffects, warningsAcked: ['no-filter'] }, schedules)
  check('resultView: partly saved', v.status === 'partial' && /^Partly saved/.test(v.headline))
  check('  each field in words: as asked, or what was asked and what the camera has', v.fields.some((f) => f.ok && f.text === 'Line crossing: on (as asked)') && v.fields.some((f) => f.ok && f.text.startsWith('Line 1 start: ') && f.text.endsWith(' (as asked)')) && v.fields.some((f) => !f.ok && f.text === 'Hold time: not applied (asked 10 s, the camera has 20 s)'), show(v.fields))
  check('  what the camera changed by itself', show(v.sideEffects) === show(['NVR action: push message: on → off']), show(v.sideEffects))
  check('  the warnings confirmed, in words', show(v.acked) === '["no person/vehicle filter"]')
  const all = resultView(compareReadBack(before, asked, asked), schedules)
  check('  all as asked: saved', all.status === 'done' && all.sideEffects.length === 0 && /^Saved/.test(all.headline))
  check('  not read back: unknown', resultView({ fields: [], sideEffects: [] }).status === 'unknown' && resultView(undefined).status === 'unknown')
  // F10: after a Save that could not be read back the panel reads the camera again; a camera that
  // still has the settings from before did not take the change, and the admin's drawing is kept
  check('unchangedSince: the camera read again still has the settings from before the Save', typeof unchangedSince === 'function' && unchangedSince(before, structuredClone(before)) === true)
  check('  not when it has changed (the Save may have been applied) or could not be read', typeof unchangedSince === 'function' && unchangedSince(before, asked) === false && unchangedSince(before, null) === false)
  check('  nothing applied: not saved', resultView(compareReadBack(before, asked, before)).status === 'failed')
  check('fieldLabel: lines, classes, the NVR\'s actions, detections that cannot run together', fieldLabel('line.3.direction') === 'Line 4 direction' && fieldLabel('filter.motor.on') === 'Motorbike' && fieldLabel('filter.person.max') === 'Person largest size' && fieldLabel('trigger.sysSnap') === 'NVR action: NVR snapshot' && fieldLabel('mutex.perimeter.2') === 'intrusion zones (cannot run beside line crossing)' && fieldLabel('something.new') === 'something.new')
  check('valueText: on/off, directions, seconds, schedule names, none', valueText('enabled', 'true') === 'on' && valueText('line.0.direction', 'leftorbotton') === 'B → A' && valueText('holdTime', '10') === '10 s' && valueText('schedule', S24x5, schedules) === '24x5' && valueText('x', null) === '(none)')
}

// ---- phone alerts -------------------------------------------------------------------------------------
{
  const rule = { id: 4, name: 'Line crossing', enabled: true, notify: true, cameras: ['nvr-2/2'], types: ['line-crossing'] }
  check('alertOn: the camera in the "Line crossing" rule', alertOn([{ name: 'Other', enabled: true, notify: true, cameras: ['nvr-2/2'] }, rule], 'nvr-2/2') && !alertOn([rule], 'nvr-2/3'))
  check('  not when the rule is switched off, does not notify, or is missing', !alertOn([{ ...rule, enabled: false }], 'nvr-2/2') && !alertOn([{ ...rule, notify: false }], 'nvr-2/2') && !alertOn([], 'nvr-2/2') && !alertOn(undefined, 'nvr-2/2'))
  const on = { ...ch3, enabled: true }
  check('autoAlert: on by default after a Save that switched line crossing on', autoAlert(ch3, on, { on: false, touched: false }))
  check('  not when the admin touched the switch, the camera is already in, or it is not known', !autoAlert(ch3, on, { on: false, touched: true }) && !autoAlert(ch3, on, { on: true, touched: false }) && !autoAlert(ch3, on, { on: null, touched: false }) && !autoAlert(ch3, on, { on: undefined, touched: false }))
  check('  not when it was on already, or is still off', !autoAlert(on, on, { on: false, touched: false }) && !autoAlert(ch3, ch3, { on: false, touched: false }))
  check('alertNote: says what the switch means now', /Settings \(Alerts\)/.test(alertNote(true, true, true)) && /no ntfy topic/.test(alertNote(true, true, false)) && /switches on by itself/.test(alertNote(false, false, false)) && /Alarms page only/.test(alertNote(false, true, true)) && /could not be read/.test(alertNote(null, true, true)) && alertNote(undefined, true, true) === '')
  const made = ntfyHelp({ topic: 'argus-abc123def456ghi789jk', created: true })
  check('ntfyHelp: a new topic, how to subscribe, and to keep it private', /was made/.test(made.lead) && made.topic === 'argus-abc123def456ghi789jk' && made.steps.length === 3 && /install the free ntfy app/.test(made.steps[0]) && /private/.test(made.steps[2]) && !/another server/.test(made.steps[1]))
  check('  a server of its own is named', /Use another server" set to https:\/\/ntfy\.example\.org/.test(ntfyHelp({ topic: 't12345678', created: false, url: 'https://ntfy.example.org/' }).steps[1]))
  check('  no topic: nothing to show', ntfyHelp({ topic: '', created: false }) === null && ntfyHelp(null) === null)
}

// ---- no camera write without a click -----------------------------------------------------------------
{
  const src = readFileSync(join(import.meta.dirname, '..', 'public', 'lines-panel.js'), 'utf8').replaceAll('\r\n', '\n') // (a Windows checkout has CRLF)
  const lines = src.split('\n')
  const methodAt = (i) => {
    for (let j = i; j >= 0; j--) {
      const m = /^ {2}(?:async )?([A-Za-z]\w*)\(/.exec(lines[j])
      if (m) return m[1]
    }
    return null
  }
  const callers = (re) => [...new Set(lines.map((l, i) => (re.test(l) ? methodAt(i) : null)).filter(Boolean))].sort().join()
  check('POSTs only from post (the camera, through the server\'s checks) and setAlert (Argus\'s alarm rule)', callers(/api\('POST'/) === 'post,setAlert', callers(/api\('POST'/))
  check('  post only from send, send only from Save and Undo', callers(/this\.post\(/) === 'send' && callers(/this\.send\(/) === 'save,undo', `${callers(/this\.post\(/)} / ${callers(/this\.send\(/)}`)
  check('  Save and Undo are started by a click', /addEventListener\('click', \(\) => this\.save\(\)\)/.test(src) && /addEventListener\('click', \(\) => this\.undo\(\)\)/.test(src))
  check('  the alert: from its switch, and the default after a Save', callers(/this\.setAlert\(/) === 'build,send' && /addEventListener\('change', \(e\) => \{\s*this\.alert\.touched = true\s*this\.setAlert\(e\.target\.checked\)/.test(src))
  const sendBody = src.slice(src.indexOf('  async send('), src.indexOf('  showResult('))
  check('  a Save not read back (lines: null) never shows the settings from before it as saved: the camera is read again, the drawing kept if it did not change',
    /if \(!data\.lines\) \{[\s\S]*?this\.load\(\{ keep: \{ before, draft: this\.draft \} \}\)[\s\S]*?return\s*\}\s*this\.show\(data\.lines\)/.test(sendBody) &&
    /unchangedSince\(keep\.before,/.test(src.slice(src.indexOf('  async load('), src.indexOf('  /** Whether the camera is in the'))))
  const drawing = src.slice(src.indexOf('  onPointerDown('), src.indexOf('  /** The lines as they will be saved'))
  check('  drawing only changes what is shown (no request from a pointer)', drawing.length > 0 && !/api\(|this\.post\(|this\.send\(|this\.setAlert\(/.test(drawing))
  check('  the camera\'s sound and white light are never among what the panel sends', !/triggerAudio|triggerWhiteLight/.test(src.slice(src.indexOf('export function changeOf'), src.indexOf('/** A schedule\'s name'))))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
