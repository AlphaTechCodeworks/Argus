// Line-crossing settings (tripwire-xml.mjs): reading the camera's answers, checking a change,
// building the editTripwire document and comparing the read-back. Pure: nothing is sent anywhere
// and the native SDK is never loaded, so this runs on the Windows PC as well as on the server.
//   node cctv/test/tripwire-xml.test.mjs
//
// The fixtures in test/fixtures/lines are nvr-2's own answers to read-only queries (2026-09-27):
// ch1 IP6196W (car/person/motor filter with min/max sizes), ch3 IP619E5W "Maingate Roadway" (no
// filter at all), ch4 CAM-IP6196G (filter without sizes). The expected edit documents below are
// written out by hand from the NVR web client's own getSaveData (tripwireAlarmCfg.js), not from
// this module's output, so a change in element order or names fails here before it reaches a camera.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { XML_HEADER } from '../xml.mjs'
import { DIRECTIONS, HOLD_MIN_SAFE_S, MIN_LINE_FRACTION, applyChange, buildEditTripwire, checkChange, compareReadBack, flatten, parseSchedules, parseSupport, parseTripwire } from '../tripwire-xml.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const throws = (fn, re) => { try { fn() } catch (e) { return re.test(e.message) } return false }
// '' when equal, else where the two documents part (a whole document is too long for a FAIL line)
const diff = (got, want) => {
  if (got === want) return ''
  let i = 0
  while (got[i] === want[i]) i++
  return `differ at ${i}: got ...${got.slice(i, i + 80)} | want ...${want.slice(i, i + 80)}`
}
/** A check that `doc` contains `part`, printing the document only when it does not. */
const checkIn = (n, doc, part) => check(n, doc.includes(part), doc.includes(part) ? '' : doc)

const dir = join(import.meta.dirname, 'fixtures', 'lines')
const fixture = (name) => readFileSync(join(dir, name), 'utf8')
const CH1 = fixture('tripwire-ch1.xml')
const CH3 = fixture('tripwire-ch3.xml')
const CH4 = fixture('tripwire-ch4.xml')
const NODES = fixture('nodelist.xml')
const SCHEDULES = fixture('schedulelist.xml')

const ID1 = '{00000001-0000-0000-0000-000000000000}'
const ID3 = '{00000003-0000-0000-0000-000000000000}'
const ID4 = '{00000004-0000-0000-0000-000000000000}'
const S247 = '{ED0F2AE8-6E54-4D89-BE10-E85445FAC8FB}'
const S245 = '{BD47C3AC-7BF3-4AAF-A84E-494855859247}'
const NULL_GUID = '{00000000-0000-0000-0000-000000000000}'

// ---- editing a fixture's text, for answers the NVR has not given us yet ------------------------
const setSwitch = (xml, on) => xml.replace(/<switch>false<\/switch>(\s*<holdTimeNote>)/, `<switch>${on}</switch>$1`)
const setMutex = (xml, object, on) => xml.replace(new RegExp(`(<object type="mutexObjectType">${object}</object>\\s*<status type="boolean">)false`), `$1${on}`)
const setFirstLine = (xml, direction, s, e) => xml.replace(
  /<direction type="direction">rightortop<\/direction>\s*<startPoint>\s*<X>0<\/X>\s*<Y>0<\/Y>\s*<\/startPoint>\s*<endPoint>\s*<X>0<\/X>\s*<Y>0<\/Y>\s*<\/endPoint>/,
  `<direction type="direction">${direction}</direction><startPoint><X>${s.x}</X><Y>${s.y}</Y></startPoint><endPoint><X>${e.x}</X><Y>${e.y}</Y></endPoint>`)

// A change as the Lines panel sends it: all four slots, cleared ones all zeros.
const CLEAR = { direction: 'rightortop', start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }
const ROAD = { direction: 'none', start: { x: 1000, y: 5000 }, end: { x: 9000, y: 5200 } }
const lines = (...set) => [0, 1, 2, 3].map((i) => set[i] ?? CLEAR)

// ---- constants ---------------------------------------------------------------------------------
check('directions in the firmware spelling (A->B, A<-B, both)', same(DIRECTIONS, ['rightortop', 'leftorbotton', 'none']))
check('the safe hold time is 10 s', HOLD_MIN_SAFE_S === 10)
check('a line must be at least 5% of the picture', MIN_LINE_FRACTION === 0.05)

// ---- reading: IP6196W, filter with sizes (ch1) -------------------------------------------------
const c1 = parseTripwire(CH1)
check('ch1: camera and schedule ids', c1.chlId === ID1 && c1.scheduleGuid === S247, `${c1.chlId} ${c1.scheduleGuid}`)
check('ch1: off, hold 3 s, the camera\'s hold choices', c1.enabled === false && c1.holdTime === 3 && same(c1.holdChoices, [3, 5, 10, 20, 30, 60, 120]), JSON.stringify([c1.enabled, c1.holdTime, c1.holdChoices]))
check('ch1: an object filter with car, person and motor', c1.filter?.kind === 'objects' && same(Object.keys(c1.filter.classes).sort(), ['car', 'motor', 'person']))
check('ch1: each class on, sensitivity 50, min 100x100, max 9000x9000',
  ['car', 'person', 'motor'].every((k) => same(c1.filter.classes[k], { on: true, sensitivity: 50, min: { width: 100, height: 100 }, max: { width: 9000, height: 9000 } })),
  JSON.stringify(c1.filter.classes.person))
check('ch1: four empty slots, direction A->B, per-line sensitivity 0',
  c1.lines.length === 4 && c1.lines.every((l) => same(l, { direction: 'rightortop', start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, sensitivity: 0 })), JSON.stringify(c1.lines[0]))
check('ch1: directions from <types>', same(c1.directions, ['none', 'rightortop', 'leftorbotton']), JSON.stringify(c1.directions))
check('ch1: no mutex list, audio and white light off', same(c1.mutex, []) && c1.triggerAudio === false && c1.triggerWhiteLight === false)
check('ch1: target/source pictures read (false), no auto-track', c1.saveTargetPicture === false && c1.saveSourcePicture === false && c1.autoTrack === null)
check('ch1: trigger as sent by the web client', same(
  { rec: c1.trigger.rec, alarmOuts: c1.trigger.alarmOuts, presets: c1.trigger.presets, snap: c1.trigger.snap, msgPush: c1.trigger.msgPush, buzzer: c1.trigger.buzzer, popVideo: c1.trigger.popVideo, email: c1.trigger.email, sysAudio: c1.trigger.sysAudio },
  { rec: [{ id: ID1, name: 'JP Wharf South' }], alarmOuts: [], presets: [], snap: false, msgPush: true, buzzer: false, popVideo: false, email: false, sysAudio: NULL_GUID }), JSON.stringify(c1.trigger))
check('ch1: answer-only trigger fields kept for the read-back', same(
  { recOn: c1.trigger.recOn, sysSnap: c1.trigger.sysSnap, popMsg: c1.trigger.popMsg, manualAudio: c1.trigger.manualAudio, manualLight: c1.trigger.manualLight, alarmOutOn: c1.trigger.alarmOutOn, presetOn: c1.trigger.presetOn },
  { recOn: true, sysSnap: { on: false, chls: [] }, popMsg: false, manualAudio: false, manualLight: false, alarmOutOn: false, presetOn: false }))

// ---- reading: IP619E5W, no filter (ch3, the live-test camera) ----------------------------------
const c3 = parseTripwire(CH3)
check('ch3: Maingate Roadway, off, hold 20 s', c3.chlId === ID3 && c3.enabled === false && c3.holdTime === 20)
check('ch3: no filter at all', c3.filter === null)
check('ch3: no per-line sensitivity (null, not 0)', c3.lines.length === 4 && c3.lines.every((l) => l.sensitivity === null))
check('ch3: mutex list perimeter and osc, both off', same(c3.mutex, [{ object: 'perimeter', on: false }, { object: 'osc', on: false }]), JSON.stringify(c3.mutex))
check('ch3: no target/source picture fields (null)', c3.saveTargetPicture === null && c3.saveSourcePicture === null)
check('ch3: records its own channel', same(c3.trigger.rec, [{ id: ID3, name: 'Maingate Roadway' }]))

// ---- reading: CAM-IP6196G, filter without sizes (ch4) ------------------------------------------
const c4 = parseTripwire(CH4)
check('ch4: object filter, no min/max sizes', c4.filter?.kind === 'objects' && ['car', 'person', 'motor'].every((k) => same(c4.filter.classes[k], { on: true, sensitivity: 50 })), JSON.stringify(c4.filter))
check('ch4: mutex perimeter and osc', same(c4.mutex.map((m) => m.object), ['perimeter', 'osc']))
check('ch4: per-line sensitivity 0', c4.lines.every((l) => l.sensitivity === 0))
{
  // a dual-lens camera also lists its thermal half's detections in <mutexListEx>; the web client warns about both
  const dual = parseTripwire(CH3.replace('</mutexList>', '</mutexList><mutexListEx type="list"><item><object type="mutexObjectType">osc</object><status type="boolean">true</status></item></mutexListEx>'))
  check('mutexListEx items join the mutex list', same(dual.mutex, [{ object: 'perimeter', on: false }, { object: 'osc', on: false }, { object: 'osc', on: true }]), JSON.stringify(dual.mutex))
  check('... and a detection named twice is flattened twice, not hidden', flatten(dual)['mutex.osc'] === 'false' && flatten(dual)['mutex.osc.2'] === 'true')
}

// ---- reading: what is refused rather than guessed ----------------------------------------------
check('an NVR refusal throws with its code', throws(() => parseTripwire('<?xml version="1.0"?><response><status>fail</status><errorCode>536870947</errorCode></response>'), /536870947/))
check('not XML at all throws', throws(() => parseTripwire('<response><status>success'), /not closed|bad answer/))
check('an answer without a camera throws', throws(() => parseTripwire('<response><status>success</status><content></content></response>'), /no camera/))
check('an on/off that is neither true nor false throws', throws(() => parseTripwire(CH3.replace(/<switch>false<\/switch>(\s*<holdTimeNote>)/, '<switch>maybe</switch>$1')), /switch.*maybe/))
check('a hold time that is not a whole number throws', throws(() => parseTripwire(CH3.replace('<alarmHoldTime uint="s">20</alarmHoldTime>', '<alarmHoldTime uint="s">2.5</alarmHoldTime>')), /alarmHoldTime/))
check('a filter class Argus does not know throws (it would be dropped on write)', throws(() => parseTripwire(CH4.replace('<motor>', '<animal>').replace('</motor>', '</animal>')), /animal/))
check('a slot count that does not match the slots throws', throws(() => parseTripwire(CH3.replace('count="4"', 'count="3"')), /count/))
check('a min size without a max throws (the web client would invent zeros)', throws(() => parseTripwire(CH1.replace(/<maxDetectTarget>[\s\S]*?<\/maxDetectTarget>/, '')), /minimum\/maximum/))
check('a single sensitivity and an object filter together throws', throws(() => parseTripwire(CH4.replace('<objectFilter>', '<sensitivity>40</sensitivity><objectFilter>')), /both/))
{
  const single = parseTripwire(CH3.replace('<alarmHoldTime uint="s">20</alarmHoldTime>', '<alarmHoldTime uint="s">20</alarmHoldTime><sensitivity>40</sensitivity>'))
  check('a single <sensitivity> under <param> is a single filter', same(single.filter, { kind: 'single', sensitivity: 40 }), JSON.stringify(single.filter))
}
{
  const odd = parseTripwire(CH3.replace('<alarmHoldTime uint="s">20</alarmHoldTime>', '<alarmHoldTime uint="s">15</alarmHoldTime>'))
  check('a hold time outside the note is added to the choices (as the web client does)', same(odd.holdChoices, [3, 5, 10, 15, 20, 30, 60, 120]))
}
{
  const noSchedule = parseTripwire(CH3.replace(` scheduleGuid="${S247}"`, ''))
  check('no scheduleGuid on the camera: the null schedule (as the web client does)', noSchedule.scheduleGuid === NULL_GUID)
}
{
  const loud = parseTripwire(CH3.replace('<triggerAudio>false</triggerAudio>', '<triggerAudio>true</triggerAudio>'))
  const light = parseTripwire(CH3.replace('<triggerWhiteLight>false</triggerWhiteLight>', '<triggerWhiteLight>1</triggerWhiteLight>'))
  check('sound trigger on is read as on', loud.triggerAudio === true && loud.triggerWhiteLight === false)
  check('a white-light value that is not "false" counts as on (the safe reading)', light.triggerWhiteLight === true)
}

// ---- which cameras can have lines, and the schedules -------------------------------------------
{
  const s = parseSupport(NODES)
  check('queryNodeList: all 25 cameras', s.size === 25, String(s.size))
  check('queryNodeList: Maingate Roadway supports tripwire and pea', same(s.get(ID3), { tripwire: true, pea: true }), JSON.stringify(s.get(ID3)))
  check('queryNodeList: hex channel ids as the NVR writes them', s.has('{0000000A-0000-0000-0000-000000000000}'))
  const off = parseSupport(NODES.replace(/(<item id="\{00000004[^"]*">[\s\S]*?<supportTripwire>)true/, '$1false'))
  check('queryNodeList: a camera that says false is not supported', off.get(ID4).tripwire === false && off.get(ID3).tripwire === true)
  check('queryNodeList: a refusal throws', throws(() => parseSupport('<response><status>fail</status></response>'), /queryNodeList/))
}
check('queryScheduleList: the three schedules with their names', same(parseSchedules(SCHEDULES), [
  { id: S247, name: '24x7' }, { id: S245, name: '24x5' }, { id: '{5511AE78-D495-4340-AF26-05DFEFC7A94A}', name: '24x2' }
]), JSON.stringify(parseSchedules(SCHEDULES)))

// ---- the edit document, exactly as the web client builds it ------------------------------------
// Whitespace the web client happens to put between some elements (' <item', '<preset> <presets')
// is left out, and sysAudio's id is in double quotes: the same XML, element for element.
const EMPTY_ITEM = '<item><direction type="direction">rightortop</direction><startPoint><X>0</X><Y>0</Y></startPoint><endPoint><X>0</X><Y>0</Y></endPoint></item>'
const LINE_EMPTY = `<line type="list" count="4"><itemType><direction type="direction"/></itemType>${EMPTY_ITEM.repeat(4)}</line>`
const TRIGGER = (id, name) => `<trigger><sysRec><chls type="list"><item id="${id}"><![CDATA[${name}]]></item></chls></sysRec>` +
  '<alarmOut><alarmOuts type="list"></alarmOuts></alarmOut><preset><presets type="list"></presets></preset>' +
  '<snapSwitch>false</snapSwitch><msgPushSwitch>true</msgPushSwitch><buzzerSwitch>false</buzzerSwitch><popVideoSwitch>false</popVideoSwitch><emailSwitch>false</emailSwitch>' +
  `<sysAudio id="${NULL_GUID}"></sysAudio></trigger>`
const SIZES = '<minDetectTarget><width>100</width><height>100</height></minDetectTarget><maxDetectTarget><width>9000</width><height>9000</height></maxDetectTarget>'
const WANT_CH1 = `${XML_HEADER}<content><chl id="${ID1}" scheduleGuid="${S247}"><param><switch>false</switch><alarmHoldTime unit="s">3</alarmHoldTime>` +
  `<objectFilter><car><switch>true</switch><sensitivity>50</sensitivity>${SIZES}</car><person><switch>true</switch><sensitivity>50</sensitivity>${SIZES}</person><motor><switch>true</switch><sensitivity>50</sensitivity>${SIZES}</motor></objectFilter>` +
  `${LINE_EMPTY}<saveTargetPicture>false</saveTargetPicture><saveSourcePicture>false</saveSourcePicture></param>${TRIGGER(ID1, 'JP Wharf South')}</chl></content></request>`
const WANT_CH3 = `${XML_HEADER}<content><chl id="${ID3}" scheduleGuid="${S247}"><param><switch>false</switch><alarmHoldTime unit="s">20</alarmHoldTime>` +
  `${LINE_EMPTY}</param>${TRIGGER(ID3, 'Maingate Roadway')}</chl></content></request>`
const WANT_CH4 = `${XML_HEADER}<content><chl id="${ID4}" scheduleGuid="${S247}"><param><switch>false</switch><alarmHoldTime unit="s">3</alarmHoldTime>` +
  '<objectFilter><car><switch>true</switch><sensitivity>50</sensitivity></car><person><switch>true</switch><sensitivity>50</sensitivity></person><motor><switch>true</switch><sensitivity>50</sensitivity></motor></objectFilter>' +
  `${LINE_EMPTY}<saveTargetPicture>false</saveTargetPicture><saveSourcePicture>false</saveSourcePicture></param>${TRIGGER(ID4, 'Bond SE')}</chl></content></request>`
{
  const b1 = buildEditTripwire(c1)
  const b3 = buildEditTripwire(c3)
  const b4 = buildEditTripwire(c4)
  check('ch1 as read: the web client\'s document, element for element', b1 === WANT_CH1, diff(b1, WANT_CH1))
  check('ch3 as read: the web client\'s document (no filter, no picture fields)', b3 === WANT_CH3, diff(b3, WANT_CH3))
  check('ch4 as read: the web client\'s document (filter without sizes)', b4 === WANT_CH4, diff(b4, WANT_CH4))
  check('never sends triggerAudio or triggerWhiteLight', [b1, b3, b4].every((b) => !/triggerAudio|triggerWhiteLight/.test(b)))
  check('never sends the per-line sensitivity', [b1, b3, b4].every((b) => !/sensitivity/.test(b.slice(b.indexOf('<line '), b.indexOf('</line>')))))
  check('never sends the answer-only trigger switches', [b1, b3, b4].every((b) => !/sysSnap|popMsgSwitch|manualAudioSwitch|manualLightSwitch|<switch>true<\/switch><chls/.test(b)))
}
{
  const next = applyChange(c3, { enabled: true, holdTime: 10, lines: lines(ROAD) })
  const want = WANT_CH3
    .replace('<switch>false</switch><alarmHoldTime unit="s">20</alarmHoldTime>', '<switch>true</switch><alarmHoldTime unit="s">10</alarmHoldTime>')
    .replace(EMPTY_ITEM, '<item><direction type="direction">none</direction><startPoint><X>1000</X><Y>5000</Y></startPoint><endPoint><X>9000</X><Y>5200</Y></endPoint></item>')
  check('the live-test change on ch3: only the changed values differ', buildEditTripwire(next) === want, diff(buildEditTripwire(next), want))
}
{
  const next = applyChange(c1, { filter: { person: { sensitivity: 70 }, car: { on: false } } })
  const b = buildEditTripwire(next)
  checkIn('a filter change: person sensitivity and car switch, sizes kept', b,
    `<car><switch>false</switch><sensitivity>50</sensitivity>${SIZES}</car><person><switch>true</switch><sensitivity>70</sensitivity>${SIZES}</person>`)
}
{
  const single = parseTripwire(CH3.replace('<alarmHoldTime uint="s">20</alarmHoldTime>', '<alarmHoldTime uint="s">20</alarmHoldTime><sensitivity>40</sensitivity>'))
  const b = buildEditTripwire(applyChange(single, { filter: { sensitivity: 60 } }))
  checkIn('a single sensitivity goes right after the hold time', b, '<alarmHoldTime unit="s">20</alarmHoldTime><sensitivity>60</sensitivity><line type="list"')
}
{
  const withAuto = parseTripwire(CH1.replace('<saveTargetPicture>', '<autoTrack>false</autoTrack><saveTargetPicture>'))
  const b = buildEditTripwire(withAuto)
  checkIn('autoTrack is echoed after the filter, before the lines', b, '</objectFilter><autoTrack>false</autoTrack><line type="list"')
}
{
  const odd = structuredClone(c3)
  odd.trigger.rec = [{ id: 'a"b', name: 'Gate ]]> & <Road>' }]
  odd.trigger.presets = [{ index: '', name: 'skip me', chlId: ID3, chlName: 'x' }, { index: '2', name: 'Gate', chlId: ID3, chlName: 'Maingate Roadway' }]
  odd.trigger.alarmOuts = [{ id: '{AAAAAAAA-0000-0000-0000-000000000001}', name: 'Relay 1' }]
  const b = buildEditTripwire(odd)
  checkIn('names go in CDATA, a "]]>" inside one split safely', b, '<item id="a&quot;b"><![CDATA[Gate ]]]]><![CDATA[> & <Road>]]></item>')
  check('a preset without an index is skipped', !b.includes('skip me'))
  checkIn('a preset with an index is sent in the web client\'s shape', b,
    `<presets type="list"><item><index>2</index><name><![CDATA[Gate]]></name><chl id="${ID3}"><![CDATA[Maingate Roadway]]></chl></item></presets>`)
  checkIn('alarm outputs the camera already has are echoed, not added to', b, '<alarmOuts type="list"><item id="{AAAAAAAA-0000-0000-0000-000000000001}"><![CDATA[Relay 1]]></item></alarmOuts>')
}
{
  const frac = applyChange(c3, { lines: lines({ direction: 'none', start: { x: 1000.5, y: 5000 }, end: { x: 9000, y: 5000 } }) })
  check('a fractional coordinate is never sent (the build throws)', throws(() => buildEditTripwire(frac), /whole number/))
  const big = applyChange(c3, { lines: lines({ direction: 'none', start: { x: 1000, y: 5000 }, end: { x: 10001, y: 5000 } }) })
  check('a coordinate past 10000 is never sent (the build throws)', throws(() => buildEditTripwire(big), /0 to 10000/))
  const loud = structuredClone(c3)
  loud.triggerAudio = true
  check('a camera with its sound trigger on is never written (the build throws)', throws(() => buildEditTripwire(loud), /sound\/white-light/))
}

// ---- applyChange -------------------------------------------------------------------------------
{
  const before = JSON.stringify(c1)
  const next = applyChange(c1, { enabled: true, holdTime: 10, scheduleGuid: S245, lines: lines(ROAD), filter: { motor: { on: false, sensitivity: 20 } } })
  check('applyChange leaves the read untouched', JSON.stringify(c1) === before)
  check('applyChange sets what was asked', next.enabled === true && next.holdTime === 10 && next.scheduleGuid === S245 && same(next.lines[0].start, ROAD.start) && next.lines[0].direction === 'none')
  check('applyChange keeps the per-line sensitivity the camera reported', next.lines.every((l) => l.sensitivity === 0))
  check('applyChange changes one class and keeps its sizes', same(next.filter.classes.motor, { on: false, sensitivity: 20, min: { width: 100, height: 100 }, max: { width: 9000, height: 9000 } }) && same(next.filter.classes.car, c1.filter.classes.car))
  check('applyChange shares no objects with the read', next.trigger !== c1.trigger && next.lines[1] !== c1.lines[1] && next.filter.classes.car !== c1.filter.classes.car)
}

// ---- checkChange: refusals ---------------------------------------------------------------------
const refused = (cfg, change, re, opts) => { const r = checkChange(cfg, change, opts); return typeof r.refuse === 'string' && re.test(r.refuse) && r.warnings.length === 0 }
const accepted = (cfg, change, opts) => checkChange(cfg, change, opts).refuse === null
check('refused: not an object', refused(c3, null, /object/) && refused(c3, [], /object/))
check('refused: an unknown setting', refused(c3, { enabled: true, colour: 'red' }, /colour/))
check('refused: enabled that is not true/false', refused(c3, { enabled: 'yes' }, /true or false/))
check('refused: three slots for a four-slot camera', refused(c3, { lines: lines(ROAD).slice(0, 3) }, /all 4/))
check('refused: a slot with an unknown field', refused(c3, { lines: lines({ ...ROAD, colour: 1 }) }, /colour/))
check('refused: a fractional coordinate', refused(c3, { lines: lines({ ...ROAD, start: { x: 1000.5, y: 5000 } }) }, /whole numbers from 0 to 10000/))
check('refused: a coordinate past 10000 or below 0', refused(c3, { lines: lines({ ...ROAD, end: { x: 10001, y: 5000 } }) }, /0 to 10000/) && refused(c3, { lines: lines({ ...ROAD, start: { x: -1, y: 5000 } }) }, /0 to 10000/))
check('refused: a coordinate as text', refused(c3, { lines: lines({ ...ROAD, start: { x: '1000', y: 5000 } }) }, /whole numbers/))
check('refused: a point without x/y', refused(c3, { lines: lines({ ...ROAD, end: { x: 9000 } }) }, /\{ x, y \}/))
check('refused: start = end', refused(c3, { lines: lines({ direction: 'none', start: { x: 2000, y: 2000 }, end: { x: 2000, y: 2000 } }) }, /same point/))
check('refused: a line under 5% of the picture (424 units)', refused(c3, { lines: lines({ direction: 'none', start: { x: 1000, y: 1000 }, end: { x: 1300, y: 1300 } }) }, /shorter than 5%/))
check('accepted: a line of exactly 5% (500 units)', accepted(c3, { lines: lines({ direction: 'none', start: { x: 1000, y: 1000 }, end: { x: 1500, y: 1000 } }) }))
check('accepted: a line from the corner (only all four zeros is a cleared slot)', accepted(c3, { lines: lines({ direction: 'none', start: { x: 0, y: 0 }, end: { x: 5000, y: 5000 } }) }))
check('refused: a direction the camera does not list', refused(c3, { lines: lines({ ...ROAD, direction: 'up' }) }, /direction/))
check('accepted: every direction the camera lists', ['none', 'rightortop', 'leftorbotton'].every((d) => accepted(c3, { lines: lines({ ...ROAD, direction: d }) })))
check('refused: a hold time the camera does not offer', refused(c3, { holdTime: 7 }, /3, 5, 10/) && refused(c3, { holdTime: '10' }, /Hold time/))
check('refused: a schedule the NVR does not have', refused(c3, { scheduleGuid: '{11111111-1111-1111-1111-111111111111}' }, /schedule/, { schedules: parseSchedules(SCHEDULES) }))
check('refused: a schedule id that is not an id', refused(c3, { scheduleGuid: '24x5' }, /schedule id/))
check('accepted: one of the NVR\'s schedules', accepted(c3, { scheduleGuid: S245 }, { schedules: parseSchedules(SCHEDULES) }))
check('refused: a filter on a camera without one', refused(c3, { filter: { person: { on: false } } }, /no person\/vehicle filter/))
check('refused: a filter class the camera does not have', refused(c4, { filter: { animal: { on: true } } }, /animal/))
check('refused: an inherited name is not a class', refused(c4, { filter: { constructor: { on: true } } }, /constructor/) && refused(c4, { filter: JSON.parse('{ "__proto__": { "on": true } }') }, /__proto__/))
check('refused: sensitivity outside 1..100 or fractional', refused(c4, { filter: { person: { sensitivity: 0 } } }, /1 to 100/) && refused(c4, { filter: { person: { sensitivity: 101 } } }, /1 to 100/) && refused(c4, { filter: { person: { sensitivity: 50.5 } } }, /1 to 100/))
check('accepted: sensitivity 1 and 100', accepted(c4, { filter: { person: { sensitivity: 1 } } }) && accepted(c4, { filter: { car: { sensitivity: 100 } } }))
check('refused: a class switch that is not true/false', refused(c4, { filter: { person: { on: 1 } } }, /true or false/))
{
  const single = parseTripwire(CH3.replace('<alarmHoldTime uint="s">20</alarmHoldTime>', '<alarmHoldTime uint="s">20</alarmHoldTime><sensitivity>40</sensitivity>'))
  check('single filter: { sensitivity } only', accepted(single, { filter: { sensitivity: 60 } }) && refused(single, { filter: { person: { on: true } } }, /one sensitivity/))
}
check('refused: nothing changes', refused(c3, {}, /Nothing to change/) && refused(c3, { enabled: false, holdTime: 20 }, /Nothing to change/) && refused(c3, { lines: lines() }, /Nothing to change/))
{
  const loud = parseTripwire(CH3.replace('<triggerAudio>false</triggerAudio>', '<triggerAudio>true</triggerAudio>'))
  const light = parseTripwire(CH1.replace('<triggerWhiteLight>false</triggerWhiteLight>', '<triggerWhiteLight>true</triggerWhiteLight>'))
  check('refused: the camera\'s sound trigger is on', refused(loud, { enabled: true, lines: lines(ROAD) }, /sound\/white-light trigger is on.*by hand only/))
  check('refused: the camera\'s white-light trigger is on (even for a harmless change)', refused(light, { holdTime: 10 }, /floodlight is worked by hand only/))
}
check('refused: switching on with an NVR relay linked', refused({ ...c3, trigger: { ...c3.trigger, alarmOuts: [{ id: '{AAAAAAAA-0000-0000-0000-000000000001}', name: 'Relay 1' }] } }, { enabled: true, lines: lines(ROAD) }, /alarm output/))

// ---- checkChange: warnings that need acknowledging ---------------------------------------------
const keys = (r) => r.warnings.map((w) => w.key)
{
  const r = checkChange(c3, { enabled: true, holdTime: 10, lines: lines(ROAD) })
  check('ch3 turned on with a line and 10 s: only the no-filter warning', r.refuse === null && same(keys(r), ['no-filter']), JSON.stringify(r))
  check('every warning has words', r.warnings.every((w) => typeof w.text === 'string' && w.text.length > 20))
}
{
  const busy = parseTripwire(setMutex(CH3, 'perimeter', true))
  const r = checkChange(busy, { enabled: true, holdTime: 10, lines: lines(ROAD) })
  check('turning on while a mutex detection is on: mutex warning naming it', same(keys(r), ['mutex', 'no-filter']) && /intrusion/i.test(r.warnings[0].text), JSON.stringify(r.warnings))
}
{
  const r = checkChange(c1, { enabled: true, lines: lines(ROAD) })
  check('ch1 turned on at its 3 s hold: short-hold, and no no-filter (it has one)', same(keys(r), ['short-hold']) && r.warnings[0].text.includes('3 s'), JSON.stringify(r.warnings))
}
{
  const r = checkChange(c3, { enabled: true, holdTime: 10 })
  check('turned on with no line set: no-lines', same(keys(r), ['no-filter', 'no-lines']), JSON.stringify(keys(r)))
}
{
  const on = parseTripwire(setMutex(setFirstLine(setSwitch(CH3, true), 'none', ROAD.start, ROAD.end), 'osc', true))
  const r = checkChange(on, { lines: lines({ ...ROAD, direction: 'rightortop' }) })
  check('already on: moving a line does not repeat the turning-on warnings', r.refuse === null && same(keys(r), []), JSON.stringify(r))
  const r2 = checkChange(on, { holdTime: 5 })
  check('already on: a hold time under 10 s still warns', same(keys(r2), ['short-hold']))
}
check('off and staying off: a short hold is not warned', same(keys(checkChange(c3, { holdTime: 5 })), []))

// ---- flatten -----------------------------------------------------------------------------------
{
  const f1 = flatten(c1)
  const f3 = flatten(c3)
  check('flatten: the keys the contract names', ['enabled', 'holdTime', 'schedule', 'line.0.direction', 'line.0.start', 'line.0.end', 'filter.person.on', 'filter.person.sensitivity', 'trigger.msgPush', 'trigger.sysSnap'].every((k) => k in f1), Object.keys(f1).join(' '))
  check('flatten: strings only', Object.values(f1).every((v) => typeof v === 'string'))
  check('flatten: values', f1.enabled === 'false' && f1.holdTime === '3' && f1.schedule === S247 && f1['line.0.start'] === '0,0' && f1['filter.car.min'] === '100x100' && f1['trigger.rec'] === ID1 && f1['trigger.sysSnap'] === 'false')
  check('flatten: answer-only fields are there to compare', ['line.0.sensitivity', 'trigger.popMsg', 'trigger.manualAudio', 'trigger.manualLight', 'trigger.recOn', 'trigger.alarmOutOn', 'triggerAudio', 'triggerWhiteLight'].every((k) => k in f1))
  check('flatten: ch3 has no filter keys and no per-line sensitivity', !Object.keys(f3).some((k) => k.startsWith('filter.')) && !('line.0.sensitivity' in f3))
  check('flatten: mutex detections by name', f3['mutex.perimeter'] === 'false' && f3['mutex.osc'] === 'false')
}

// ---- compareReadBack ---------------------------------------------------------------------------
{
  const change = { enabled: true, holdTime: 10, lines: lines(ROAD) }
  const asked = applyChange(c3, change)
  // what the camera might answer: on and the line stored, the hold time NOT taken, and two things
  // nobody asked for (the pop-up message switch, and the osc detection switched on)
  const afterXml = setMutex(setFirstLine(setSwitch(CH3, true), 'none', ROAD.start, ROAD.end), 'osc', true)
    .replace('<popMsgSwitch>false</popMsgSwitch>', '<popMsgSwitch>true</popMsgSwitch>')
  const r = compareReadBack(c3, asked, parseTripwire(afterXml))
  const byKey = Object.fromEntries(r.fields.map((f) => [f.key, f]))
  check('read-back: exactly the asked fields are listed', same(Object.keys(byKey).sort(), ['enabled', 'holdTime', 'line.0.direction', 'line.0.end', 'line.0.start']), Object.keys(byKey).join(' '))
  check('read-back: on and the line are "as asked"', ['enabled', 'line.0.direction', 'line.0.start', 'line.0.end'].every((k) => byKey[k].status === 'as asked'))
  check('read-back: the hold time the camera kept is "not applied" with want/got', same(byKey.holdTime, { key: 'holdTime', want: '10', got: '20', status: 'not applied' }), JSON.stringify(byKey.holdTime))
  check('read-back: unasked differences are side effects', same(r.sideEffects, [{ key: 'mutex.osc', from: 'false', to: 'true' }, { key: 'trigger.popMsg', from: 'false', to: 'true' }]), JSON.stringify(r.sideEffects))
}
{
  const asked = applyChange(c1, { enabled: true, holdTime: 10 })
  const r = compareReadBack(c1, asked, asked)
  check('read-back: a camera that took everything has no side effects', r.fields.length === 2 && r.fields.every((f) => f.status === 'as asked') && r.sideEffects.length === 0, JSON.stringify(r))
  const gone = structuredClone(asked)
  gone.trigger.sysSnap = null
  const r2 = compareReadBack(c1, asked, gone)
  check('read-back: a field that disappeared is a side effect to null', same(r2.sideEffects, [{ key: 'trigger.sysSnap', from: 'false', to: null }]), JSON.stringify(r2.sideEffects))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
