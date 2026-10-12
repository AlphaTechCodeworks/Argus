// A camera's Motion, Sterile area, Item monitoring and Fault settings (camera-cfg-xml.mjs): the
// questions, reading the answers, checking a change, building the edit documents, comparing the
// read-back, and the write gate. Pure: nothing is sent anywhere and the native SDK is never loaded,
// so this runs on the Windows PC as well as on the server.
//   node cctv/test/camera-cfg-xml.test.mjs
//
// The fixtures in test/fixtures/camera-cfg are nvr-2's own answers for channel 1 (IP6196W, read-only
// probe of 2026-10-12). The expected edit documents below are written out by hand from the NVR web
// client's own builders (motion.js, motionAlarmCfg.js, peaAlarmCfg.js, oscAlarmCfg.js,
// avdAlarmCfg.js), not from this module's output, so a change in element order or spelling fails
// here before it reaches a camera. The page's own pure parts (public/camera-cfg-panel.js) are
// checked at the end against the same fixtures.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { XML_HEADER } from '../xml.mjs'
import {
  COMMANDS, KINDS, MIN_ZONE_POINTS, NOT_PROVEN, NULL_GUID, PROVEN, applyChange, buildEdit, compareReadBack, flatten, gateKey, mergeMotion, motionPartOf,
  parse, parseDetections, queryBody, selfCrossing, validate, viewOf, writeGate
} from '../camera-cfg-xml.mjs'
import { changeLines, changeOf, draftOf, motionParts, zoneProblem } from '../public/camera-cfg-panel.js'

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
const checkDoc = (n, got, want) => check(n, got === want, diff(got, want))
/** A check that `doc` contains `part`, printing the document only when it does not. */
const checkIn = (n, doc, part) => check(n, doc.includes(part), doc.includes(part) ? '' : doc)
const checkOut = (n, doc, part) => check(n, !doc.includes(part), doc.includes(part) ? doc : '')

const dir = join(import.meta.dirname, 'fixtures')
const fixture = (name) => readFileSync(join(dir, 'camera-cfg', name), 'utf8')
const XML = { motion: fixture('motion-ch1.xml'), perimeter: fixture('perimeter-ch1.xml'), osc: fixture('osc-ch1.xml'), avd: fixture('avd-ch1.xml') }
const NODES = readFileSync(join(dir, 'lines', 'nodelist.xml'), 'utf8')

const ID1 = '{00000001-0000-0000-0000-000000000000}'
const ID3 = '{00000003-0000-0000-0000-000000000000}'
const S247 = '{ED0F2AE8-6E54-4D89-BE10-E85445FAC8FB}'
const S245 = '{BD47C3AC-7BF3-4AAF-A84E-494855859247}'
const SCHEDULES = [{ id: S247, name: '24x7' }, { id: S245, name: '24x5' }]
const NAME = 'JP Wharf South'
const model = (kind, xml = XML[kind]) => parse(kind, xml, { name: NAME })
const end = '</chl></content></request>'

// ---- the expected documents, by hand from the web client ---------------------------------------
const ME = `<item id="${ID1}"><![CDATA[${NAME}]]></item>`
// the nine elements the smart events send as <trigger>: no switches, no sysSnap, no popMsgSwitch
const TRIGGER = `<trigger><sysRec><chls type="list">${ME}</chls></sysRec><alarmOut><alarmOuts type="list"></alarmOuts></alarmOut><preset><presets type="list"></presets></preset>` +
  '<snapSwitch>false</snapSwitch><msgPushSwitch>true</msgPushSwitch><buzzerSwitch>false</buzzerSwitch><popVideoSwitch>false</popVideoSwitch><emailSwitch>false</emailSwitch>' +
  `<sysAudio id='${NULL_GUID}'></sysAudio></trigger>`
const ROW = '<item>1111111111111111111111</item>'
const WANT_MOTION_PARAM = `${XML_HEADER}<content><chl id="${ID1}"><param><switch>true</switch>` +
  '<objectFilter><car><switch>false</switch></car><person><switch>false</switch></person></objectFilter>' +
  '<sensitivity min="1" max="8">4</sensitivity><holdTime unit="s">20</holdTime>' +
  `<area type="list" count="18"><itemType minLen="22" maxLen="22"/>${ROW.repeat(18)}</area></param>${end}`
const WANT_MOTION_TRIGGER = `${XML_HEADER}<content><chl id="${ID1}"><trigger>` +
  `<sysRec><switch>true</switch><chls type="list">${ME}</chls></sysRec><alarmOut><switch>false</switch><alarmOuts type="list"></alarmOuts></alarmOut>` +
  `<preset><switch>false</switch><presets type="list"></presets></preset><sysSnap><switch>true</switch><chls type="list">${ME}</chls></sysSnap>` +
  `<buzzerSwitch>false</buzzerSwitch><msgPushSwitch>true</msgPushSwitch><sysAudio id='${NULL_GUID}'></sysAudio>` +
  `<triggerSchedule><switch>true</switch><schedule id="${S247}"></schedule></triggerSchedule>` +
  `<popVideoSwitch>false</popVideoSwitch><popMsgSwitch>false</popMsgSwitch><emailSwitch>false</emailSwitch></trigger>${end}`
const CLASS = (k) => `<${k}><switch>true</switch><sensitivity>50</sensitivity><minDetectTarget><width>100</width><height>100</height></minDetectTarget>` +
  `<maxDetectTarget><width>9000</width><height>9000</height></maxDetectTarget></${k}>`
const EMPTY_ZONE = '<item><point type="list" maxCount="6" count="0"></point></item>'
const WANT_PERIMETER = `${XML_HEADER}<content><chl id="${ID1}" scheduleGuid="${S247}"><param><switch>false</switch><alarmHoldTime unit="s">3</alarmHoldTime>` +
  `<boundary type="list" count="4"><itemType><point type="list"/></itemType>${EMPTY_ZONE.repeat(4)}</boundary>` +
  '<saveSourcePicture>false</saveSourcePicture><saveTargetPicture>false</saveTargetPicture>' +
  `<objectFilter>${CLASS('car')}${CLASS('person')}${CLASS('motor')}</objectFilter></param>${TRIGGER}${end}`
const WANT_OSC = `${XML_HEADER}<content><chl id="${ID1}" scheduleGuid="${S247}"><param><switch>false</switch><holdTime unit="s">20</holdTime><oscType>abandum</oscType>` +
  '<boundary type="lis" count="1"><itemType><point type="list"/></itemType>' +
  `<item><name maxLen="15"><![CDATA[]]></name><point type="list" maxCount="6" count="0"></point></item></boundary></param>${TRIGGER}${end}`
const WANT_AVD = `${XML_HEADER}<content><chl id="${ID1}"><param><holdTime unit="s">20</holdTime><sensitivity>51</sensitivity>` +
  `<sceneChangeSwitch>false</sceneChangeSwitch><clarityAbnormalSwitch>false</clarityAbnormalSwitch><colorAbnormalSwitch>false</colorAbnormalSwitch></param>${TRIGGER}${end}`

// ---- the questions -----------------------------------------------------------------------------
{
  const cond = `${XML_HEADER}<condition><chlId>${ID1}</chlId></condition>`
  check('the four kinds, and only the commands of the spec', same(KINDS, ['motion', 'perimeter', 'osc', 'avd']) &&
    same(COMMANDS, { motion: { query: 'queryMotion', edit: 'editMotion' }, perimeter: { query: 'queryPerimeter', edit: 'editPerimeter' }, osc: { query: 'queryOsc', edit: 'editOsc' }, avd: { query: 'queryAvd', edit: 'editAvd' } }))
  checkDoc('queryMotion asks for the param half as the area page does', queryBody('motion', ID1, 'param'), `${cond}<requireField><param/></requireField></request>`)
  checkDoc('queryMotion asks for the trigger half as the linkage page does', queryBody('motion', ID1, 'trigger'), `${cond}<requireField><trigger/></requireField></request>`)
  check('queryMotion without a half is refused', throws(() => queryBody('motion', ID1), /param or its trigger/))
  for (const k of ['perimeter', 'osc', 'avd']) checkDoc(`${COMMANDS[k].query} asks for param and trigger`, queryBody(k, ID1), `${cond}<requireField><param/><trigger/></requireField></request>`)
  check('an unknown kind is refused', throws(() => queryBody('cdd', ID1), /Unknown kind/))
}

// ---- reading -----------------------------------------------------------------------------------
{
  const m = model('motion')
  const p = m.param
  check('motion: camera, switch, sensitivity and its range', m.chlId === ID1 && p.enabled === true && p.sensitivity === 4 && p.sensMin === 1 && p.sensMax === 8)
  check('motion: hold time and the camera\'s own choices', p.holdTime === 20 && same(p.holdChoices, [3, 5, 10, 15, 20, 25, 30, 60, 120, 180]))
  check('motion: the area mask as read, 18 rows of 22', p.area.rows.length === 18 && p.area.rows.every((r) => r === '1'.repeat(22)))
  check('motion: the person/vehicle switches as read', same(p.objectFilter, { person: false, car: false }) && p.triggerAudio === false)
  const t = m.trigger
  check('motion: schedule, record and snapshot switches with their cameras', t.schedule === S247 && t.recOn === true && same(t.rec, [{ id: ID1, name: NAME }]) && t.snapOn === true && same(t.snapChls, [{ id: ID1, name: NAME }]))
  check('motion: the other trigger switches', t.alarmOutOn === false && t.presetOn === false && t.msgPush === true && t.buzzer === false && t.popVideo === false && t.popMsg === false && t.email === false)
  check('motion: no sysAudio in the answer reads as the null id', t.sysAudio === NULL_GUID)
  const v = viewOf('motion', m)
  check('motion: the page\'s view', v.enabled === true && same(v.sensitivity, { value: 4, min: 1, max: 8 }) && v.holdTime === 20 && v.schedule === S247 && v.noSchedule === '' &&
    same(v.trigger, { record: true, snapshot: true, push: true, buzzer: false, popVideo: false, email: false }), JSON.stringify(v))
  check('motion: a mask that arms every cell is "the whole picture" (no orientation needed)', v.area === 'all')
  check('motion: a mask with some cells off is only "some"', viewOf('motion', model('motion', XML.motion.replace('<item>1111', '<item>0111'))).area === 'some')
  // the two halves, as the two questions answer them
  const paramOnly = model('motion', XML.motion.replace(/<trigger>[\s\S]*<\/trigger>/, ''))
  const triggerOnly = model('motion', XML.motion.replace(/<param>[\s\S]*<\/param>/, ''))
  check('motion: an answer with one half reads that half only', paramOnly.trigger === null && paramOnly.param.sensitivity === 4 && triggerOnly.param === null && triggerOnly.trigger.schedule === S247)
  check('motion: the two halves merge into the whole', same(mergeMotion(paramOnly, triggerOnly), m))
  check('motion: a mask that is not the grid it says it is reads as unreadable, not as a guess', model('motion', XML.motion.replace('<item>1111111111111111111111</item>', '<item>111</item>')).param.area === null)
  check('motion: no holdTimeNote means no choices', same(model('motion', XML.motion.replace(/<holdTimeNote>.*<\/holdTimeNote>/, '')).param.holdChoices, []))
}
{
  const m = model('perimeter')
  check('perimeter: schedule, switch, hold time and choices', m.scheduleGuid === S247 && m.enabled === false && m.holdTime === 3 && same(m.holdChoices, [3, 5, 10, 20, 30, 60, 120]))
  check('perimeter: four empty zones of up to six corners', m.zones.length === 4 && m.maxZones === 4 && m.zones.every((z) => z.points.length === 0 && z.maxPoints === 6) && m.regulation === '0')
  check('perimeter: the three filter classes with sizes and ranges', same(Object.keys(m.filter), ['car', 'person', 'motor']) &&
    same(m.filter.person, { on: true, sensitivity: 50, sensMin: 1, sensMax: 100, min: { width: 100, height: 100 }, max: { width: 9000, height: 9000 } }), JSON.stringify(m.filter.person))
  check('perimeter: pictures, sound and light as read', m.saveSourcePicture === false && m.saveTargetPicture === false && m.triggerAudio === false && m.triggerWhiteLight === false && m.autoTrack === null && m.sensitivity === null)
  const t = m.trigger
  check('perimeter: the trigger it sends', same(t.rec, [{ id: ID1, name: NAME }]) && t.alarmOuts.length === 0 && t.presets.length === 0 && !t.snap && t.msgPush && !t.buzzer && !t.popVideo && !t.email && t.sysAudio === NULL_GUID)
  check('perimeter: the answer-only trigger fields are kept for the read-back', t.recOn === true && t.alarmOutOn === false && t.presetOn === false && same(t.sysSnap, { on: false, chls: [] }) && t.popMsg === false && t.manualAudio === false && t.manualLight === false)
  const v = viewOf('perimeter', m)
  check('perimeter: the page\'s view', v.enabled === false && v.schedule === S247 && v.noSchedule === NULL_GUID && v.zones.length === 4 && v.minPoints === 4 && v.maxPoints === 6 && v.zonesEditable === true &&
    same(v.filter.car, { on: true, sensitivity: 50, min: 1, max: 100 }) && same(v.trigger, { record: true, snapshot: false, push: true, buzzer: false, popVideo: false, email: false }) && v.blocked === null, JSON.stringify(v))
  check('perimeter: an unknown filter class is not guessed at', throws(() => model('perimeter', XML.perimeter.replace(/<motor>([\s\S]*)<\/motor>/, '<boat>$1</boat>')), /<boat>/))
  check('perimeter: an on/off that is neither is not guessed at', throws(() => model('perimeter', XML.perimeter.replace('<switch>false</switch>', '<switch>maybe</switch>')), /not true or false/))
}
{
  const m = model('osc')
  check('osc: schedule, switch, hold time, what it watches for', m.scheduleGuid === S247 && m.enabled === false && m.holdTime === 20 && m.oscType === 'abandum' && same(m.oscTypes, ['abandum', 'objstolen']))
  check('osc: one empty, unnamed zone', m.zones.length === 1 && same(m.zones[0], { name: '', points: [], maxPoints: 6 }) && m.maxZones === 1)
  const v = viewOf('osc', m)
  check('osc: the page\'s view', v.oscType === 'abandum' && same(v.oscTypes, ['abandum', 'objstolen']) && same(v.zones, [{ name: '', points: [] }]) && v.maxPoints === 6 && v.filter === undefined)
}
{
  const m = model('avd')
  check('avd: the three checks, sensitivity and its range, hold time', same(m.switches, { sceneChange: false, clarityAbnormal: false, colorAbnormal: false }) && m.sensitivity === 51 && m.sensMin === 1 && m.sensMax === 100 && m.holdTime === 20)
  const v = viewOf('avd', m)
  check('avd: the page\'s view has no master switch and no schedule', !('enabled' in v) && !('schedule' in v) && same(v.switches, { sceneChange: false, clarityAbnormal: false, colorAbnormal: false }) && same(v.sensitivity, { value: 51, min: 1, max: 100 }))
  const noBlur = model('avd', XML.avd.replace(/<clarityAbnormalSwitch>.*<\/clarityAbnormalSwitch>/, ''))
  check('avd: a check the camera lacks is not offered', noBlur.switches.clarityAbnormal === null && !('clarityAbnormal' in viewOf('avd', noBlur).switches))
}
for (const k of KINDS) {
  check(`${k}: a refusal throws with the NVR's code`, throws(() => parse(k, '<response><status>fail</status><errorCode>536870962</errorCode></response>'), /536870962/))
  check(`${k}: an answer that names no camera throws`, throws(() => parse(k, '<response><status>success</status><content></content></response>'), /names no camera/))
}
{
  const d = parseDetections(NODES)
  check('queryNodeList: channel 1 has sterile area, item monitoring and fault', same(d.get(ID1), { pea: true, osc: true, avd: true }), JSON.stringify(d.get(ID1)))
  check('queryNodeList: every camera is listed', d.size >= 3 && d.has(ID3))
  check('queryNodeList: a camera that says false is not supported', parseDetections(NODES.replace('<supportOsc>true', '<supportOsc>false')).get(ID1).osc === false)
}

// ---- the edit documents: unchanged, every value as read ----------------------------------------
checkDoc('editMotion param: the web client\'s document, nothing changed', buildEdit('motion', model('motion'), {}, 'param'), WANT_MOTION_PARAM)
checkDoc('editMotion trigger: the web client\'s document, nothing changed', buildEdit('motion', model('motion'), {}, 'trigger'), WANT_MOTION_TRIGGER)
checkDoc('editPerimeter: the web client\'s document, nothing changed', buildEdit('perimeter', model('perimeter')), WANT_PERIMETER)
checkDoc('editOsc: the web client\'s document, nothing changed', buildEdit('osc', model('osc')), WANT_OSC)
checkDoc('editAvd: the web client\'s document, nothing changed', buildEdit('avd', model('avd')), WANT_AVD)
{
  const docs = {
    'motion param': WANT_MOTION_PARAM, 'motion trigger': WANT_MOTION_TRIGGER,
    perimeter: buildEdit('perimeter', model('perimeter')), osc: buildEdit('osc', model('osc')), avd: buildEdit('avd', model('avd'))
  }
  for (const [n, doc] of Object.entries(docs)) {
    checkOut(`${n}: never the answer's uint="s"`, doc, 'uint=')
    checkOut(`${n}: nothing the web client leaves out (holdTimeNote, mutexList, triggerAudio, triggerWhiteLight, manual switches)`, doc.replace(/holdTimeNote|mutexList|triggerAudio|triggerWhiteLight|manualAudioSwitch|manualLightSwitch/g, '\u0000'), '\u0000')
    if (n !== 'motion param') checkIn(`${n}: sysAudio in single quotes`, doc, `<sysAudio id='${NULL_GUID}'></sysAudio>`)
    if (n !== 'motion param') checkIn(`${n}: names in CDATA`, doc, `<![CDATA[${NAME}]]>`)
    if (n !== 'motion trigger') checkIn(`${n}: unit="s" on the hold time`, doc, ' unit="s">')
  }
  for (const n of ['perimeter', 'osc', 'avd']) {
    checkOut(`${n}: no sysSnap, popMsgSwitch or list switches in a smart-event trigger`, docs[n].slice(docs[n].indexOf('<trigger>')).replace(/sysSnap|popMsgSwitch|<switch>/g, '\u0000'), '\u0000')
  }
  checkOut('motion param: no trigger', docs['motion param'], '<trigger>')
  checkOut('motion trigger: no param', docs['motion trigger'], '<param>')
  checkIn('motion param: car before person (the web client\'s order, not the answer\'s)', docs['motion param'], '<objectFilter><car>')
  checkIn('osc: the zone list is type="lis", the web client\'s own spelling', docs.osc, '<boundary type="lis" count="1">')
  checkOut('osc: and not type="list" there', docs.osc, '<boundary type="list"')
  checkIn('perimeter: source picture before target picture', docs.perimeter, '<saveSourcePicture>false</saveSourcePicture><saveTargetPicture>false</saveTargetPicture>')
  checkOut('perimeter: no per-zone sensitivity, minTime or scale, no maxCount or regulation on the list', docs.perimeter.replace(/minTime|scale|regulation|<boundary[^>]*maxCount/g, '\u0000'), '\u0000')
  checkOut('perimeter: filter sensitivities and sizes carry no attributes', docs.perimeter.replace(/<(sensitivity|width|height) /g, '\u0000'), '\u0000')
  checkOut('avd: no schedule on the camera element', docs.avd, 'scheduleGuid')
  check('avd: hold time, then sensitivity, then the checks', /<param><holdTime unit="s">20<\/holdTime><sensitivity>51<\/sensitivity><sceneChangeSwitch>/.test(docs.avd))
}
// only what the answer had
{
  const noMotor = model('perimeter', XML.perimeter.replace(/<motor>[\s\S]*<\/motor>/, ''))
  const doc = buildEdit('perimeter', noMotor)
  check('perimeter: exactly the filter classes that were read (no motor invented)', !doc.includes('<motor>') && doc.includes('<car>') && doc.includes('<person>'))
  const noCar = buildEdit('perimeter', model('perimeter', XML.perimeter.replace(/<car>[\s\S]*<\/car>/, '')))
  check('perimeter: a filter without car does not get one', !noCar.includes('<car>') && noCar.includes('<objectFilter><person>'))
  const noFilter = buildEdit('perimeter', model('perimeter', XML.perimeter.replace(/<objectFilter>[\s\S]*<\/objectFilter>/, '<sensitivity>40</sensitivity>')))
  check('perimeter: a camera with one sensitivity gets it back, and no filter', noFilter.includes('</saveTargetPicture><sensitivity>40</sensitivity></param>') && !noFilter.includes('objectFilter'))
  const noPics = buildEdit('perimeter', model('perimeter', XML.perimeter.replace(/<saveTargetPicture>.*<\/saveTargetPicture>\s*<saveSourcePicture>.*<\/saveSourcePicture>/, '')))
  check('perimeter: no picture switches when the answer had none', !noPics.includes('Picture'))
  const noBlur = buildEdit('avd', model('avd', XML.avd.replace(/<clarityAbnormalSwitch>.*<\/clarityAbnormalSwitch>/, '')))
  check('avd: a check the answer lacks is not sent', !noBlur.includes('clarityAbnormalSwitch') && noBlur.includes('<sceneChangeSwitch>false</sceneChangeSwitch><colorAbnormalSwitch>'))
  const noSmd = buildEdit('motion', model('motion', XML.motion.replace(/<objectFilter>[\s\S]*<\/objectFilter>/, '')), {}, 'param')
  check('motion: no person/vehicle switches when the answer had none', !noSmd.includes('objectFilter') && noSmd.includes('<switch>true</switch><sensitivity min="1" max="8">'))
  const noNote = buildEdit('motion', model('motion', XML.motion.replace(/<holdTimeNote>.*<\/holdTimeNote>/, '').replace(/<holdTime uint="s">20<\/holdTime>/, '<holdTime uint="s"></holdTime>')), {}, 'param')
  checkIn('motion: a camera with no hold time gets it back empty, as the web client sends it', noNote, '<holdTime unit="s"></holdTime>')
  const preset = XML.osc.replace('<presets type="list"></presets>', `<presets type="list"><item><index>3</index><name>Gate</name><chl id="${ID3}">Maingate</chl></item><item><name>no index</name><chl id="${ID3}">x</chl></item></presets>`)
  const withPreset = buildEdit('osc', model('osc', preset))
  check('a preset goes back with CDATA names, and one without an index is not sent',
    withPreset.includes(`<presets type="list"><item><index>3</index><name><![CDATA[Gate]]></name><chl id="${ID3}"><![CDATA[Maingate]]></chl></item></presets>`), withPreset)
  const off = model('motion', XML.motion.replace('<sysRec>\n\t\t\t\t\t<switch>true', '<sysRec>\n\t\t\t\t\t<switch>false').replace(/<sysRec>\s*<switch>true/, '<sysRec><switch>false'))
  check('motion: a list whose switch is off is sent empty', off.trigger.recOn === false && buildEdit('motion', off, {}, 'trigger').includes('<sysRec><switch>false</switch><chls type="list"></chls></sysRec>'))
  const noSchedule = model('motion', XML.motion.replace(/<triggerSchedule>[\s\S]*<\/triggerSchedule>/, ''))
  checkIn('motion: no schedule is switch false and an empty id', buildEdit('motion', noSchedule, {}, 'trigger'), '<triggerSchedule><switch>false</switch><schedule id=""></schedule></triggerSchedule>')
  check('a name with ]]> in it stays inside its CDATA', buildEdit('avd', parse('avd', XML.avd, { name: NAME }), {}).includes('CDATA[JP Wharf South]]>') &&
    buildEdit('avd', { ...model('avd'), trigger: { ...model('avd').trigger, rec: [{ id: ID1, name: 'a]]>b' }] } }).includes('<![CDATA[a]]]]><![CDATA[>b]]>'))
}

// ---- a change lands in the right element, and nowhere else -------------------------------------
/** The one replacement that turns the unchanged document into the changed one. */
const changed = (n, got, base, from, to) => checkDoc(n, got, base.replace(from, to))
{
  const m = model('motion')
  changed('motion: off', buildEdit('motion', m, { enabled: false }, 'param'), WANT_MOTION_PARAM, '<param><switch>true</switch>', '<param><switch>false</switch>')
  changed('motion: sensitivity', buildEdit('motion', m, { sensitivity: 6 }, 'param'), WANT_MOTION_PARAM, 'max="8">4<', 'max="8">6<')
  changed('motion: hold time', buildEdit('motion', m, { holdTime: 60 }, 'param'), WANT_MOTION_PARAM, '<holdTime unit="s">20<', '<holdTime unit="s">60<')
  changed('motion: push message off', buildEdit('motion', m, { trigger: { push: false } }, 'trigger'), WANT_MOTION_TRIGGER, '<msgPushSwitch>true', '<msgPushSwitch>false')
  changed('motion: buzzer, pop-up video and email on', buildEdit('motion', m, { trigger: { buzzer: true, popVideo: true, email: true } }, 'trigger'),
    WANT_MOTION_TRIGGER.replace('<buzzerSwitch>false', '<buzzerSwitch>true').replace('<popVideoSwitch>false', '<popVideoSwitch>true'), '<emailSwitch>false', '<emailSwitch>true')
  changed('motion: record off empties its list', buildEdit('motion', m, { trigger: { record: false } }, 'trigger'), WANT_MOTION_TRIGGER,
    `<sysRec><switch>true</switch><chls type="list">${ME}</chls>`, '<sysRec><switch>false</switch><chls type="list"></chls>')
  changed('motion: snapshot off empties its list', buildEdit('motion', m, { trigger: { snapshot: false } }, 'trigger'), WANT_MOTION_TRIGGER,
    `<sysSnap><switch>true</switch><chls type="list">${ME}</chls>`, '<sysSnap><switch>false</switch><chls type="list"></chls>')
  changed('motion: another schedule', buildEdit('motion', m, { schedule: S245 }, 'trigger'), WANT_MOTION_TRIGGER, `<schedule id="${S247}">`, `<schedule id="${S245}">`)
  changed('motion: no schedule', buildEdit('motion', m, { schedule: '' }, 'trigger'), WANT_MOTION_TRIGGER, `<switch>true</switch><schedule id="${S247}">`, '<switch>false</switch><schedule id="">')
  const bare = model('motion', XML.motion.replace(/<sysRec>[\s\S]*?<\/sysRec>/, '<sysRec><switch>false</switch><chls type="list"></chls></sysRec>'))
  checkIn('motion: record on with nobody in its list records this camera', buildEdit('motion', bare, { trigger: { record: true } }, 'trigger'), `<sysRec><switch>true</switch><chls type="list">${ME}</chls></sysRec>`)
}
{
  const m = model('perimeter')
  const SQUARE = [{ x: 1000, y: 1000 }, { x: 9000, y: 1000 }, { x: 9000, y: 9000 }, { x: 1000, y: 9000 }]
  const SQUARE_XML = '<item><point type="list" maxCount="6" count="4"><item><X>1000</X><Y>1000</Y></item><item><X>9000</X><Y>1000</Y></item><item><X>9000</X><Y>9000</Y></item><item><X>1000</X><Y>9000</Y></item></point></item>'
  changed('perimeter: on', buildEdit('perimeter', m, { enabled: true }), WANT_PERIMETER, '<param><switch>false', '<param><switch>true')
  changed('perimeter: hold time', buildEdit('perimeter', m, { holdTime: 30 }), WANT_PERIMETER, '<alarmHoldTime unit="s">3<', '<alarmHoldTime unit="s">30<')
  changed('perimeter: schedule', buildEdit('perimeter', m, { schedule: S245 }), WANT_PERIMETER, `scheduleGuid="${S247}"`, `scheduleGuid="${S245}"`)
  changed('perimeter: a zone drawn in the second slot, the others still sent empty', buildEdit('perimeter', m, { zones: [[], SQUARE, [], []] }), WANT_PERIMETER,
    EMPTY_ZONE.repeat(4), `${EMPTY_ZONE}${SQUARE_XML}${EMPTY_ZONE}${EMPTY_ZONE}`)
  changed('perimeter: motorbikes off', buildEdit('perimeter', m, { filter: { motor: { on: false } } }), WANT_PERIMETER, '<motor><switch>true', '<motor><switch>false')
  changed('perimeter: person sensitivity', buildEdit('perimeter', m, { filter: { person: { sensitivity: 80 } } }), WANT_PERIMETER, '<person><switch>true</switch><sensitivity>50', '<person><switch>true</switch><sensitivity>80')
  changed('perimeter: record off empties the list of cameras', buildEdit('perimeter', m, { trigger: { record: false } }), WANT_PERIMETER, `<sysRec><chls type="list">${ME}</chls>`, '<sysRec><chls type="list"></chls>')
  changed('perimeter: snapshot on', buildEdit('perimeter', m, { trigger: { snapshot: true } }), WANT_PERIMETER, '<snapSwitch>false', '<snapSwitch>true')
  changed('perimeter: email on', buildEdit('perimeter', m, { trigger: { email: true } }), WANT_PERIMETER, '<emailSwitch>false', '<emailSwitch>true')
  check('perimeter: the model that was read is not changed by a change', same(m, model('perimeter')))
  const bare = model('perimeter', XML.perimeter.replace(/<sysRec>[\s\S]*?<\/sysRec>/, '<sysRec><switch>false</switch><chls type="list"></chls></sysRec>'))
  checkIn('perimeter: record on with nobody in its list records this camera', buildEdit('perimeter', bare, { trigger: { record: true } }), `<trigger><sysRec><chls type="list">${ME}</chls></sysRec>`)
  check('perimeter: a coordinate that is not a whole number is never sent', throws(() => buildEdit('perimeter', m, { zones: [[{ x: 1.5, y: 0 }, ...SQUARE.slice(1)], [], [], []] }), /whole number/))
  const loud = model('perimeter', XML.perimeter.replace('<triggerWhiteLight>false', '<triggerWhiteLight>true'))
  check('perimeter: a camera whose white-light trigger is on is not written at all', throws(() => buildEdit('perimeter', loud), /white-light/) && throws(() => validate('perimeter', loud, { enabled: true }), /white-light/) && /white-light/.test(viewOf('perimeter', loud).blocked))
}
{
  const m = model('osc')
  const SHAPE = [{ x: 100, y: 100 }, { x: 5000, y: 200 }, { x: 5200, y: 4000 }, { x: 2500, y: 6000 }, { x: 150, y: 4100 }]
  changed('osc: on', buildEdit('osc', m, { enabled: true }), WANT_OSC, '<param><switch>false', '<param><switch>true')
  changed('osc: hold time', buildEdit('osc', m, { holdTime: 120 }), WANT_OSC, '<holdTime unit="s">20<', '<holdTime unit="s">120<')
  changed('osc: watch for items taken', buildEdit('osc', m, { oscType: 'objstolen' }), WANT_OSC, '<oscType>abandum', '<oscType>objstolen')
  changed('osc: no schedule is the null id', buildEdit('osc', m, { schedule: NULL_GUID }), WANT_OSC, `scheduleGuid="${S247}"`, `scheduleGuid="${NULL_GUID}"`)
  changed('osc: the zone drawn', buildEdit('osc', m, { zones: [SHAPE] }), WANT_OSC, 'count="0"></point>',
    `count="5">${SHAPE.map((p) => `<item><X>${p.x}</X><Y>${p.y}</Y></item>`).join('')}</point>`)
  changed('osc: push message off', buildEdit('osc', m, { trigger: { push: false } }), WANT_OSC, '<msgPushSwitch>true', '<msgPushSwitch>false')
  checkIn('osc: a zone\'s name goes back as read, in CDATA', buildEdit('osc', model('osc', XML.osc.replace('<![CDATA[]]>', '<![CDATA[Quay]]>'))), '<name maxLen="15"><![CDATA[Quay]]></name>')
}
{
  const m = model('avd')
  changed('avd: scene change on', buildEdit('avd', m, { switches: { sceneChange: true } }), WANT_AVD, '<sceneChangeSwitch>false', '<sceneChangeSwitch>true')
  changed('avd: blur on', buildEdit('avd', m, { switches: { clarityAbnormal: true } }), WANT_AVD, '<clarityAbnormalSwitch>false', '<clarityAbnormalSwitch>true')
  changed('avd: colour cast on', buildEdit('avd', m, { switches: { colorAbnormal: true } }), WANT_AVD, '<colorAbnormalSwitch>false', '<colorAbnormalSwitch>true')
  changed('avd: sensitivity', buildEdit('avd', m, { sensitivity: 70 }), WANT_AVD, '<sensitivity>51<', '<sensitivity>70<')
  changed('avd: hold time', buildEdit('avd', m, { holdTime: 5 }), WANT_AVD, '<holdTime unit="s">20<', '<holdTime unit="s">5<')
  changed('avd: buzzer on', buildEdit('avd', m, { trigger: { buzzer: true } }), WANT_AVD, '<buzzerSwitch>false', '<buzzerSwitch>true')
}

// ---- refusals ----------------------------------------------------------------------------------
{
  const ok = (kind, change, opts) => { try { validate(kind, model(kind), change, opts) } catch (e) { return e.message } return true }
  const no = (kind, change, re, opts) => throws(() => validate(kind, model(kind), change, opts), re)
  const P = { part: 'param' }
  const T = { part: 'trigger', schedules: SCHEDULES }
  const SQUARE = [{ x: 1000, y: 1000 }, { x: 9000, y: 1000 }, { x: 9000, y: 9000 }, { x: 1000, y: 9000 }]
  const BOWTIE = [{ x: 1000, y: 1000 }, { x: 9000, y: 9000 }, { x: 9000, y: 1000 }, { x: 1000, y: 9000 }]
  const SEVEN = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ x: Math.round(5000 + 4000 * Math.cos(i)), y: Math.round(5000 + 4000 * Math.sin(i)) }))
  check('a zone is empty or has at least four corners', MIN_ZONE_POINTS === 4)
  check('motion: a good param change passes', ok('motion', { sensitivity: 8, holdTime: 3, enabled: false }, P) === true, String(ok('motion', { sensitivity: 8 }, P)))
  check('motion: a good trigger change passes', ok('motion', { schedule: S245, trigger: { email: true } }, T) === true)
  check('motion: sensitivity outside the camera\'s 1-8', no('motion', { sensitivity: 9 }, /1 to 8/, P) && no('motion', { sensitivity: 0 }, /1 to 8/, P) && no('motion', { sensitivity: 2.5 }, /whole number/, P))
  check('motion: a hold time the camera does not offer', no('motion', { holdTime: 45 }, /one the camera offers/, P))
  check('motion: a trigger setting in the param half, and the other way round', no('motion', { trigger: { email: true } }, /Unknown setting/, P) && no('motion', { enabled: false }, /Unknown setting/, T))
  check('motion: the detection area cannot be changed from here', no('motion', { area: ['1'] }, /Unknown setting/, P))
  check('motion: no half named', no('motion', { enabled: false }, /param or its trigger/))
  check('motion: a schedule the recorder does not have', no('motion', { schedule: '{11111111-2222-3333-4444-555555555555}' }, /not one of the recorder/, T) && no('motion', { schedule: 'always' }, /schedule id/, T))
  check('motion: the null id is not motion\'s "none"', no('motion', { schedule: NULL_GUID }, /not one of the recorder/, T))
  check('motion: on/off that is not a boolean', no('motion', { enabled: 'true' }, /true or false/, P) && no('motion', { trigger: { record: 1 } }, /true or false/, T))
  check('motion: an unknown trigger box', no('motion', { trigger: { siren: true } }, /no "siren"/, T))
  check('motion: nothing to change', no('motion', { sensitivity: 4 }, /Nothing to change/, P) && no('motion', { trigger: { push: true } }, /Nothing to change/, T))
  check('motion: a mask that could not be read exactly stops the param half', throws(() => validate('motion', model('motion', XML.motion.replace('<item>1111111111111111111111</item>', '<item>111</item>')), { sensitivity: 5 }, P), /detection area/))
  check('motion: both halves in one change are told apart', motionPartOf({ enabled: true }) === 'param' && motionPartOf({ trigger: { email: true } }) === 'trigger' && throws(() => motionPartOf({ enabled: true, schedule: '' }), /saved separately/))

  const S = { schedules: SCHEDULES }
  check('perimeter: a good change passes', ok('perimeter', { enabled: true, holdTime: 10, schedule: S245, zones: [SQUARE, [], [], []], filter: { car: { on: false, sensitivity: 1 } }, trigger: { snapshot: true } }, S) === true)
  check('perimeter: a zone of three corners', no('perimeter', { zones: [SQUARE.slice(0, 3), [], [], []] }, /at least 4 corners/))
  check('perimeter: a zone of seven corners', no('perimeter', { zones: [SEVEN, [], [], []] }, /at most 6 corners/))
  check('perimeter: a zone that crosses itself', no('perimeter', { zones: [BOWTIE, [], [], []] }, /crosses itself/) && selfCrossing(BOWTIE) && !selfCrossing(SQUARE))
  check('perimeter: a zone with no area', no('perimeter', { zones: [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }], [], [], []] }, /crosses itself/))
  check('perimeter: not every zone listed', no('perimeter', { zones: [SQUARE] }, /all 4 zones/))
  check('perimeter: a point off the picture or not whole', no('perimeter', { zones: [[{ x: 10001, y: 0 }, ...SQUARE.slice(1)], [], [], []] }, /0 to 10000/) && no('perimeter', { zones: [[{ x: 0.5, y: 0 }, ...SQUARE.slice(1)], [], [], []] }, /whole numbers/) &&
    no('perimeter', { zones: [[{ x: 1, y: 1, z: 1 }, ...SQUARE.slice(1)], [], [], []] }, /\{ x, y \}/))
  check('perimeter: a filter class the camera lacks is never added', throws(() => validate('perimeter', model('perimeter', XML.perimeter.replace(/<motor>[\s\S]*<\/motor>/, '')), { filter: { motor: { on: true } } }), /no motor class/))
  check('perimeter: filter sensitivity outside 1-100', no('perimeter', { filter: { car: { sensitivity: 101 } } }, /1 to 100/) && no('perimeter', { filter: { car: { size: 1 } } }, /unknown setting size/))
  check('perimeter: the single sensitivity and the sizes are not changed from here', no('perimeter', { sensitivity: 40 }, /Unknown setting/))
  check('perimeter: a schedule the recorder does not have', no('perimeter', { schedule: '{11111111-2222-3333-4444-555555555555}' }, /not one of the recorder/, S) && ok('perimeter', { schedule: NULL_GUID }, S) === true)
  check('perimeter: rectangle-mode zones are left to the recorder', throws(() => validate('perimeter', model('perimeter', XML.perimeter.replace('regulation="0"', 'regulation="1"')), { zones: [SQUARE, [], [], []] }), /rectangles/))
  const relay = XML.perimeter.replace('<alarmOuts type="list"></alarmOuts>', '<alarmOuts type="list"><item id="{00000001-0000-0000-0000-00000000000A}">Relay 1</item></alarmOuts>')
  check('perimeter: not switched on while a relay is linked', throws(() => validate('perimeter', model('perimeter', relay), { enabled: true }), /relay/) && (() => { try { validate('perimeter', model('perimeter', relay), { holdTime: 10 }) } catch { return false } return true })())
  check('osc: a good change passes', ok('osc', { enabled: true, oscType: 'objstolen', zones: [SQUARE] }) === true)
  check('osc: something the camera cannot watch for', no('osc', { oscType: 'loitering' }, /one of abandum, objstolen/))
  check('osc: no person/vehicle filter', no('osc', { filter: { car: { on: true } } }, /Unknown setting/))
  check('osc: a zone of three corners, or seven', no('osc', { zones: [SQUARE.slice(0, 3)] }, /at least 4/) && no('osc', { zones: [SEVEN] }, /at most 6/))
  check('avd: a good change passes', ok('avd', { switches: { sceneChange: true }, sensitivity: 1, holdTime: 120, trigger: { record: false } }) === true)
  check('avd: no master switch and no schedule', no('avd', { enabled: true }, /Unknown setting/) && no('avd', { schedule: S247 }, /Unknown setting/))
  check('avd: sensitivity outside 1-100', no('avd', { sensitivity: 0 }, /1 to 100/))
  check('avd: a check the camera lacks', throws(() => validate('avd', model('avd', XML.avd.replace(/<clarityAbnormalSwitch>.*<\/clarityAbnormalSwitch>/, '')), { switches: { clarityAbnormal: true } }), /no "clarityAbnormal"/))
  check('a change that is not an object', no('avd', [], /must be an object/) && no('osc', null, /must be an object/))
}

// ---- read-back ---------------------------------------------------------------------------------
{
  const before = model('perimeter')
  const want = { enabled: true, holdTime: 30, trigger: { email: true } }
  const asked = applyChange('perimeter', before, want)
  const all = compareReadBack('perimeter', before, asked, model('perimeter', buildEdit('perimeter', asked).replace(/[\s\S]*/, XML.perimeter.replace('<switch>false</switch>\n\t\t\t\t<holdTimeNote>', '<switch>true</switch><holdTimeNote>').replace('<alarmHoldTime uint="s">3<', '<alarmHoldTime uint="s">30<').replace('<emailSwitch>false', '<emailSwitch>true'))))
  check('read-back: every change as asked', same(all.changed.sort(), ['enabled', 'holdTime', 'trigger.email']) && all.differences.length === 0 && all.sideEffects.length === 0, JSON.stringify(all))
  const kept = compareReadBack('perimeter', before, asked, model('perimeter', XML.perimeter.replace('<alarmHoldTime uint="s">3<', '<alarmHoldTime uint="s">30<').replace('<popMsgSwitch>false', '<popMsgSwitch>true')))
  check('read-back: what the camera kept is listed in words', same(kept.differences.map((d) => [d.key, d.label, d.wanted, d.got]), [['enabled', 'On/off', 'true', 'false'], ['trigger.email', 'Email', 'true', 'false']]), JSON.stringify(kept.differences))
  check('read-back: a field the web client never sends that moved is a side effect', same(kept.sideEffects.map((s) => [s.key, s.from, s.to]), [['trigger.popMsg', 'false', 'true']]), JSON.stringify(kept.sideEffects))
  // motion: only the half that was written is read back
  const m = model('motion', XML.motion.replace(/<trigger>[\s\S]*<\/trigger>/, ''))
  const masked = compareReadBack('motion', m, applyChange('motion', m, { sensitivity: 6 }), model('motion', XML.motion.replace(/<trigger>[\s\S]*<\/trigger>/, '').replace('max="8">4<', 'max="8">6<')))
  check('read-back: motion sensitivity as asked', same(masked.changed, ['sensitivity']) && masked.differences.length === 0 && masked.sideEffects.length === 0, JSON.stringify(masked))
  check('flatten: every setting has a key', Object.keys(flatten('osc', model('osc'))).includes('zone.0.name') && flatten('avd', model('avd'))['switches.sceneChange'] === 'false' && flatten('motion', model('motion')).area.split('/').length === 18)
}

// ---- the write gate ----------------------------------------------------------------------------
{
  check('nothing is proven yet', same(PROVEN, { 'motion:param': false, 'motion:trigger': false, perimeter: false, osc: false, avd: false }))
  check('gate keys', gateKey('motion', 'param') === 'motion:param' && gateKey('motion', 'trigger') === 'motion:trigger' && gateKey('osc') === 'osc')
  check('gate: motion param may not be saved yet', same(writeGate('motion', 'param', ''), { key: 'motion:param', allowed: false, why: NOT_PROVEN }))
  check('gate: nothing else may, with the sentence the page shows', ['perimeter', 'osc', 'avd'].every((k) => same(writeGate(k, null, undefined), { key: k, allowed: false, why: NOT_PROVEN })) &&
    writeGate('motion', 'trigger').allowed === false && NOT_PROVEN === 'Saving this is not switched on yet: it has not been proven on a real recorder.')
  check('gate: the environment switches on what it names, and only that', writeGate('osc', null, 'osc, avd').allowed && writeGate('avd', null, 'osc, avd').allowed && !writeGate('perimeter', null, 'osc, avd').allowed &&
    writeGate('motion', 'trigger', 'motion:trigger').allowed && !writeGate('motion', 'trigger', 'motion').allowed)
  check('gate: all switches every one on', KINDS.filter((k) => k !== 'motion').every((k) => writeGate(k, null, 'ALL').allowed) && writeGate('motion', 'trigger', 'all').allowed)
  check('gate: off switches every one off, the proven too', !writeGate('motion', 'param', 'off').allowed && !writeGate('osc', null, 'all,off').allowed)
  check('gate: motion with no half, or a kind that does not exist, is never allowed', !writeGate('motion', null, 'all').allowed && !writeGate('cdd', null, 'all').allowed && !writeGate('motion', 'area', 'all').allowed)
}

// ---- the page's pure parts (public/camera-cfg-panel.js) ----------------------------------------
{
  const SQUARE = [{ x: 1000, y: 1000 }, { x: 9000, y: 1000 }, { x: 9000, y: 9000 }, { x: 1000, y: 9000 }]
  for (const k of KINDS) {
    const v = viewOf(k, model(k))
    check(`page: an untouched ${k} form has nothing to send`, same(changeOf(v, draftOf(v)), {}))
  }
  const v = viewOf('perimeter', model('perimeter'))
  const d = draftOf(v)
  d.enabled = true
  d.zones[0] = SQUARE
  d.filter.motor.on = false
  d.trigger.email = true
  const change = changeOf(v, d)
  check('page: Save sends only what changed', same(change, { enabled: true, zones: [SQUARE, [], [], []], filter: { motor: { on: false } }, trigger: { email: true } }), JSON.stringify(change))
  check('page: and the server accepts exactly that', (() => { try { validate('perimeter', model('perimeter'), change) } catch { return false } return true })())
  check('page: the change in words, one line per setting', same(changeLines(change, SCHEDULES), ['Detection: on', 'Zones: 1 (4 corners), 2 (none), 3 (none), 4 (none)', 'Detect motorbikes: off', 'Email: on']), JSON.stringify(changeLines(change, SCHEDULES)))
  const mv = viewOf('motion', model('motion'))
  const md = draftOf(mv)
  md.sensitivity = 6
  md.schedule = ''
  md.trigger.buzzer = true
  check('page: a motion change is sent as its two halves, param first', same(motionParts(changeOf(mv, md)), [{ part: 'param', change: { sensitivity: 6 } }, { part: 'trigger', change: { schedule: '', trigger: { buzzer: true } } }]), JSON.stringify(motionParts(changeOf(mv, md))))
  check('page: a zone that cannot be saved says why', zoneProblem([], 4, 6) === '' && zoneProblem(SQUARE, 4, 6) === '' && /at least 4/.test(zoneProblem(SQUARE.slice(0, 2), 4, 6)) &&
    /crosses itself/.test(zoneProblem([SQUARE[0], SQUARE[2], SQUARE[1], SQUARE[3]], 4, 6)))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
