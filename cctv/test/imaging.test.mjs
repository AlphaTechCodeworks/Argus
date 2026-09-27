// Offline tests for camera picture settings (no NVR, nothing sent anywhere). Uses answers
// saved from the real cameras (test/fixtures/imaging, copied from the camera inventory) and
// the NVR web page's own request format. The second half replaces the SDK call with a stub
// that plays the camera (nvr-xml.mjs _test.setCall), to test the whole change flow.
//   node cctv/test/imaging.test.mjs [fixtures folder]
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-imaging-test-'))
const { _test, handleImaging } = await import('../imaging.mjs')
const xmlMod = await import('../nvr-xml.mjs')
const { nvrs } = await import('../nvrs.mjs')
const { Lane } = await import('../lanes.mjs')
const { sdkCallT } = await import('../sdk.mjs')
const { handleCameraNotes } = await import('../camera-notes.mjs')

const { parseSettings, buildEdit, buildSchedule, checkChanges, expandChanges, impacts, defaultsOf, decodeReboot, undoable, chlIdOf, FIELDS, TIMING } = _test
const { parseXml, kid, leafMap, transparent, xmlSettled } = xmlMod
const dir = process.argv[2] ?? join(import.meta.dirname, 'fixtures', 'imaging')
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const refuses = (fn, pattern) => {
  try {
    fn()
    return false
  } catch (e) {
    return e.status === 400 && pattern.test(e.message)
  }
}
const read = (nvr, file) => readFileSync(join(dir, nvr, `${file}.xml`), 'utf8')
/** nvr1/image-0000000E -> settings for channel 0x0E (0-based ch 13) */
const load = (nvr, file) => parseSettings(read(nvr, file), `{${file.slice(6, 14)}-0000-0000-0000-000000000000}`)
const paths = (s) => s.fields.map((f) => f.path).join(',')
const g = (s, p) => s.fields.find((f) => f.path === p)
const HEAD = '<?xml version="1.0" encoding="utf-8" ?><request version="1.0" systemType="NVMS-9000" clientType="WEB">'

check('channel ids: 0-based channel + 1, in hex', chlIdOf(16) === '{00000011-0000-0000-0000-000000000000}' && chlIdOf(30) === '{0000001F-0000-0000-0000-000000000000}')

const cranes = load('nvr1', 'image-00000011') // non-TVT camera: few settings, no profiles
const gate = load('nvr1', 'image-0000000E') // TVT 4K: day/night profiles, program auto, reports Day
const gateNight = load('nvr1', 'image-0000000E-night')
const gateNormal = load('nvr1', 'image-0000000E-normal')
const cage = load('nvr1', 'image-0000001F') // Dahua
const pwExit = load('nvr1', 'image-00000002') // IP6196W: shutter value 5, default 4
const roadway = load('nvr1', 'image-0000001A') // IP619E5W: exposure mode, IR cut, smart IR
const truck = load('nvr1', 'image-0000001B') // ONVIF: sharpening 224 (default 127)
const wharf = load('nvr-2', 'image-00000001')
const jpBond = load('nvr-2', 'image-00000002')
const maingate = load('nvr-2', 'image-00000003') // IP619E5W
const bondSE = load('nvr-2', 'image-00000004') // white light
const lockers = load('nvr-2', 'image-00000014') // HWDR
const omar = load('nvr-2', 'image-00000017') // HWDR, slowest shutter 1/4
const jpb = load('nvr-2', 'image-00000018') // IP679E5W
const jpbDay = load('nvr-2', 'image-00000018-day') // exposure time 40000, not one of its choices
const all = [cranes, gate, gateNight, gateNormal, cage, pwExit, roadway, truck, wharf, jpBond, maingate, bondSE, lockers, omar, jpb, jpbDay]
check('parses every saved answer', all.every((s) => s.ok))

// ---- what is shown ------------------------------------------------------------------------
check('CGI cranes: only what it reports (hue -1 = not supported, left out)', paths(cranes) === 'bright,contrast,saturation,sharpen.switch,sharpen.value', paths(cranes))
check('CGI cranes: no profiles, no schedule', cranes.profile === null && cranes.profiles.length === 0 && cranes.schedule === null)
check('LCL Cage: ranges start at 1 as reported', paths(cage) === 'bright,contrast,saturation' && cage.fields[0].min === 1)
check('never shown: rotation, mains frequency, HFR, zoom', all.every((s) => !s.fields.some((f) => /imageRotate|frequency|HFR|dZoom|antiShake|imageShift|cfgFile|scheduleInfo/.test(f.path))))
check('nothing that restarts the camera by itself is in FIELDS', !FIELDS.some((f) => /imageRotate|frequency|HFR|cfgFile|scheduleInfo|corridor/i.test(f.path)))
check('North Gate: sharpening 199 (default 128, 0-255)', g(gate, 'sharpen.value').value === 199 && g(gate, 'sharpen.value').default === 128 && g(gate, 'sharpen.value').max === 255)
check('North Gate: choices come from the camera', g(gate, 'backlightCompensation.mode').options.join() === 'OFF,HWDR,HLC,BLC' && g(gate, 'whiteBalance.mode').options.join() === 'auto,indoor,outdoor,manual')
check('North Gate: reports Day, program auto, three profiles', gate.profile === 'day' && gate.profiles.join() === 'normal,day,night' && gate.schedule.program === 'auto' && gate.schedule.programs.join() === 'normal,time,auto')
check('JPB DOOR: its schedule offers day and night too', jpb.schedule.programs.join() === 'normal,day,night,time,auto')
check('info: mains frequency and corridor mode shown, HWDR flag', pwExit.info.frequency === '60HZ' && pwExit.info.imageRotate === '0' && !pwExit.info.hwdr && omar.info.hwdr && lockers.info.hwdr)
check('switches are booleans', g(gate, 'mirrorSwitch').value === false && g(gate, 'sharpen.switch').value === true && g(gate, 'sharpen.switch').default === false)
check('leaves: every setting under <chl>, no cfgFile, no schedule choices', gate.leaves.get('sharpen.value') === '199' && gate.leaves.get('frequency') === '60HZ' && !gate.leaves.has('cfgFile') && gate.leaves.get('scheduleInfo.program') === 'auto' && ![...gate.leaves.keys()].some((k) => k.startsWith('scheduleInfo.types')))

// kinds
const up = g(omar, 'shutter.upLimit')
check('index: Omar River slowest shutter 0 = "1/4"; 1/15 = 3, 1/30 = 4', up.kind === 'index' && up.value === 0 && up.shown === '1/4' && up.labels.indexOf('1/15') === 3 && up.labels.indexOf('1/30') === 4)
check('index: gain mode 0 = "auto" (the NVR sends the number)', g(pwExit, 'gain.mode').kind === 'index' && g(pwExit, 'gain.mode').shown === 'auto' && g(maingate, 'gain.mode').labels.join() === 'auto,manual')
check('index: shutter value 5 on the IP6196W, default 4', g(pwExit, 'shutter.value').value === 5 && g(pwExit, 'shutter.value').default === 4)
check('time: day/night switch "Day from" 07:00', g(roadway, 'IRCutDayTime').kind === 'time' && g(roadway, 'IRCutDayTime').value === '07:00' && g(roadway, 'IRCutNightTime').value === '19:00')
const ae = g(maingate, 'autoExposureMode.value')
check('usec: 16666 = "1/60", choices as the page computes them', ae.kind === 'usec' && ae.shown === '1/60' && ae.options.find((o) => o.label === '1/30').us === 33333 && ae.default === 33333)
const aeDay = g(jpbDay, 'autoExposureMode.value')
check('usec: JPB DOOR 40000 kept as "1/25 (set on the camera)"', aeDay.value === 40000 && aeDay.shown === '1/25 (set on the camera)' && aeDay.options.some((o) => o.camera && o.us === 40000))
check('white light: the page\'s own choices when the camera sends none', g(bondSE, 'Whitelight.WhitelightMode').options.join() === 'off,manual,auto' && g(bondSE, 'Whitelight.WhitelightStrength').kind === 'range' && g(bondSE, 'Whitelight.WhitelightOnTime').kind === 'time')
check('smart IR: switch and level', g(maingate, 'smartIR.switch').kind === 'switch' && g(maingate, 'smartIR.level').max === 2)
check('switchEnabled="false" is not offered', (() => {
  const x = read('nvr1', 'image-00000002').replace('<switch type="boolean" default="false">false</switch>', '<switch type="boolean" default="false" switchEnabled="false">false</switch>')
  const s = parseSettings(x, '{00000002-0000-0000-0000-000000000000}')
  return !g(s, 'sharpen.switch') && g(s, 'sharpen.value')
})())

// ---- documents -------------------------------------------------------------------------------
const one = (s, ch, changes, part) => buildEdit(chlIdOf(ch), s, checkChanges(s, changes), part)
check(
  'contrast on CGI cranes: the NVR page\'s own basic save (hue -1 echoed, as the page does)',
  one(cranes, 16, { contrast: 55 }, 'basic') ===
    `${HEAD}<content><chl id="{00000011-0000-0000-0000-000000000000}"><rebootPrompt>true</rebootPrompt><bright>50</bright><contrast>55</contrast><hue>-1</hue><saturation>50</saturation></chl></content></request>`
)
check(
  'sharpening on North Gate: that group only, with the profile',
  one(gate, 13, { 'sharpen.value': 150 }, 'advanced') ===
    `${HEAD}<content><chl id="{0000000E-0000-0000-0000-000000000000}"><rebootPrompt>true</rebootPrompt><cfgFile>day</cfgFile><sharpen><switch>true</switch><value>150</value></sharpen></chl></content></request>`
)
const wb = one(gate, 13, { 'whiteBalance.mode': 'manual', 'whiteBalance.red': 44 }, 'advanced')
check('white balance: the whole group, other values as read', wb.includes('<whiteBalance><mode>manual</mode><red>44</red><blue>50</blue></whiteBalance>') && !wb.includes('<bright>') && !wb.includes('<sharpen>'), wb)
const mixed = checkChanges(gate, { bright: 60, 'denoise.switch': true })
const basicDoc = buildEdit(chlIdOf(13), gate, mixed, 'basic')
const advDoc = buildEdit(chlIdOf(13), gate, mixed, 'advanced')
check('basic and advanced never in one document', basicDoc.includes('<bright>60</bright>') && !basicDoc.includes('<denoise>') && advDoc.includes('<denoise><switch>true</switch><value>128</value></denoise>') && !advDoc.includes('<bright>') && !advDoc.includes('<WDR>') && !advDoc.includes('<gain>'))
check('a part with nothing to change is refused, not sent empty', (() => {
  try {
    buildEdit(chlIdOf(13), gate, { bright: 60 }, 'advanced')
    return false
  } catch (e) {
    return /no advanced settings/.test(e.message)
  }
})())
const ircut = one(roadway, 25, { IRCutMode: 'time' }, 'advanced')
check('day/night switch: all four sent together, the delay not', ircut.includes('<IRCutMode>time</IRCutMode><IRCutDayTime>07:00</IRCutDayTime><IRCutNightTime>19:00</IRCutNightTime><IRCutConvSen>mid</IRCutConvSen>') && !ircut.includes('IRCutDelayTime'), ircut)
const exp = expandChanges(maingate, checkChanges(maingate, { 'autoExposureMode.mode': 'manual' }))
const expDoc = buildEdit(chlIdOf(2), maingate, exp.diff, 'advanced')
check('manual exposure brings manual gain (the page couples them)', exp.implied.length === 1 && exp.implied[0].path === 'gain.mode' && exp.implied[0].to === 1 && exp.couples[0].join() === 'autoExposureMode,gain')
check('...and both groups go out together', expDoc.includes('<autoExposureMode><mode>manual</mode><value>16666</value></autoExposureMode>') && expDoc.includes('<gain><mode>1</mode><value>15</value><AGC>50</AGC></gain>'), expDoc)
check('gain mode that contradicts the exposure mode is refused', refuses(() => expandChanges(maingate, { 'autoExposureMode.mode': 'manual', 'gain.mode': 0 }), /follows the exposure mode/))
check('shutter: index values, the page\'s element order', one(omar, 22, { 'shutter.upLimit': 4 }, 'advanced').includes('<shutter><mode>0</mode><value>5</value><upLimit>4</upLimit></shutter>'))
check('smart IR: sent with the attributes the page writes', one(maingate, 2, { 'smartIR.switch': true }, 'advanced').includes('<smartIR><switch type="boolean" default="false">true</switch><level>1</level></smartIR>'))
check('white light: the page\'s attributes', one(bondSE, 3, { 'Whitelight.WhitelightMode': 'manual' }, 'advanced').includes('<Whitelight><WhitelightMode type="WhitelightMode" default="off">manual</WhitelightMode><WhitelightStrength type="uint32" min="1" max="100" default="50">50</WhitelightStrength><WhitelightOnTime type="string" default="00:00">00:00</WhitelightOnTime><WhitelightOffTime type="string" default="23:59">23:59</WhitelightOffTime></Whitelight>'))
check('restart path: rebootPrompt false only when asked', buildEdit(chlIdOf(1), pwExit, { 'sharpen.switch': true }, 'advanced', { rebootPrompt: false }).includes('<rebootPrompt>false</rebootPrompt>'))
check(
  'schedule writer',
  buildSchedule('{00000002-0000-0000-0000-000000000000}', 'normal', { program: 'auto', dayTime: '00:00', nightTime: '23:59' }) ===
    `${HEAD}<content><chl id="{00000002-0000-0000-0000-000000000000}"><rebootPrompt>true</rebootPrompt><cfgFile>normal</cfgFile><scheduleInfo><program>auto</program><dayTime>00:00</dayTime><nightTime>23:59</nightTime></scheduleInfo></chl></content></request>`
)

// ---- checks ------------------------------------------------------------------------------------
check('refuses a value out of range', refuses(() => checkChanges(gate, { contrast: 101 }), /0 to 100/))
check('refuses a number sent as text', refuses(() => checkChanges(gate, { contrast: '55' }), /whole number/))
check('refuses a fraction', refuses(() => checkChanges(gate, { contrast: 55.5 }), /whole number/))
check('refuses a switch that is not true/false', refuses(() => checkChanges(gate, { mirrorSwitch: 'yes' }), /on or off/))
check('refuses a choice the camera does not offer', refuses(() => checkChanges(gate, { 'whiteBalance.mode': 'lamp' }), /choices/))
check('refuses an index past the camera\'s list', refuses(() => checkChanges(omar, { 'shutter.upLimit': 19 }), /choices/))
check('refuses an exposure time not in the list', refuses(() => checkChanges(maingate, { 'autoExposureMode.mode': 'manual', 'autoExposureMode.value': 20000 }), /exposure times/))
check('refuses a time that is not hh:mm', refuses(() => checkChanges(roadway, { IRCutMode: 'time', IRCutDayTime: '7:00' }), /hh:mm/))
check('refuses settings the camera does not have', refuses(() => checkChanges(cranes, { 'WDR.switch': true }), /no setting/))
check('refuses settings not in the list (rotation)', refuses(() => checkChanges(gate, { imageRotate: 90 }), /no setting/))
check('refuses markup in a choice', refuses(() => checkChanges(gate, { antiflicker: '</antiflicker><imageRotate>90' }), /choices/))
check('refuses an empty change', refuses(() => checkChanges(gate, {}), /Nothing/))
check('drops values that are already set', Object.keys(checkChanges(gate, { contrast: 50, bright: 51 })).join() === 'bright')
check('refuses a group holding nested settings', (() => {
  const s = { ...gate, chl: { ...gate.chl, children: [{ name: 'sharpen', attrs: {}, text: '', children: [{ name: 'value', attrs: {}, text: '1', children: [{ name: 'x', attrs: {}, text: '', children: [] }] }] }] } }
  try {
    buildEdit(chlIdOf(13), s, { 'sharpen.value': 2 }, 'advanced')
    return false
  } catch (e) {
    return /nested/.test(e.message)
  }
})())
// dependent settings
check('needs: switch turned on together with its level is allowed', Object.keys(checkChanges(pwExit, { 'sharpen.switch': true, 'sharpen.value': 150 })).length === 2)
check('needs: a level alone while its switch is off is refused', refuses(() => checkChanges(pwExit, { 'sharpen.value': 150 }), /only be changed while Sharpening is on/))
check('needs: Undo and Split put back values the camera had: allowed', Object.keys(checkChanges(pwExit, { 'sharpen.value': 150 }, { action: 'undo' })).length === 1 && Object.keys(checkChanges(pwExit, { 'sharpen.value': 150 }, { action: 'split' })).length === 1)
check('needs: North Gate Normal copied into Day (true/199 -> false/123) is allowed', Object.keys(checkChanges(gate, { 'sharpen.switch': g(gateNormal, 'sharpen.switch').value, 'sharpen.value': g(gateNormal, 'sharpen.value').value })).length === 2)
check('needs: gain limit only in auto gain; gain only in manual', Object.keys(checkChanges(pwExit, { 'gain.AGC': 40 })).length === 1 && refuses(() => checkChanges(maingate, { 'gain.value': 40 }), /Gain mode is manual/))
check('needs: shutter value only outside auto shutter', refuses(() => checkChanges(pwExit, { 'shutter.value': 4 }), /Shutter mode is not auto/))
check('anti-flicker locked while HWDR is on, or turned on', refuses(() => checkChanges(lockers, { antiflicker: '60HZ' }), /HWDR/) && refuses(() => checkChanges(pwExit, { antiflicker: '60HZ', 'backlightCompensation.mode': 'HWDR' }), /HWDR/))
check('slowest shutter faster than the fastest is refused', (() => {
  const x = read('nvr-2', 'image-00000017').replace('<upLimit type="shutterValue" default="4">0</upLimit>', '<upLimit type="shutterValue" default="4">0</upLimit><lowLimit type="shutterValue" default="10">6</lowLimit>')
  const s = parseSettings(x, '{00000017-0000-0000-0000-000000000000}')
  return refuses(() => checkChanges(s, { 'shutter.upLimit': 8 }), /slowest shutter/) && Object.keys(checkChanges(s, { 'shutter.upLimit': 4 })).length === 1
})())
check('white light on and off at the same time is refused', refuses(() => checkChanges(bondSE, { 'Whitelight.WhitelightMode': 'manual', 'Whitelight.WhitelightOffTime': '00:00' }), /same time/))
check('night light together with white light is refused', refuses(() => checkChanges(bondSE, { 'illumination.illuminationMode': 'smart', 'Whitelight.WhitelightMode': 'off' }), /night light on its own/))
check('profile difference: program auto + Backlight differing from Night is refused', refuses(() => checkChanges(gate, { 'backlightCompensation.mode': 'HLC' }, { other: gateNight }), /Day and Night would differ in Backlight/))
check('profile difference: a change both share is allowed', Object.keys(checkChanges(gate, { bright: 55 }, { other: gateNight })).length === 1)
check('profile difference: with HWDR on, gain may not differ either', (() => {
  const hw = parseSettings(read('nvr1', 'image-0000000E').replace('<mode default="OFF">OFF</mode>', '<mode default="OFF">HWDR</mode>'), '{0000000E-0000-0000-0000-000000000000}')
  return refuses(() => checkChanges(hw, { 'gain.AGC': 40 }, { other: gateNight }), /Gain limit/)
})())
check('profile difference: not on cameras that always use one profile', Object.keys(checkChanges(pwExit, { 'backlightCompensation.mode': 'HLC' }, { other: load('nvr1', 'image-00000002-night') })).length === 1)

// Defaults
const d = (s) => defaultsOf(s)
check('Defaults: IP6196W shutter value (5, default 4) is left alone', !('shutter.value' in d(pwExit)))
check('Defaults: IP619E5W gain (15, default 50) is left alone', !('gain.value' in d(roadway)) && !('autoExposureMode.value' in d(maingate)))
check('Defaults: North Gate sharpening back to off/128, as a pair', d(gate)['sharpen.switch'] === false && d(gate)['sharpen.value'] === 128)
check('Defaults: Lockers\' HWDR untouched; Bond SE\'s night light untouched', !Object.keys(d(lockers)).some((p) => p.startsWith('backlightCompensation')) && !Object.keys(d(bondSE)).some((p) => /illumination|Whitelight/.test(p)))
check('Defaults: Omar River picture and white balance only', Object.keys(d(omar)).sort().join() === 'bright,contrast,whiteBalance.mode', Object.keys(d(omar)).join())
check('Defaults: JP Bond\'s level 235 with the switch off stays (info only)', !('denoise.value' in d(jpBond)))
check('Defaults: JPB DOOR brightness to its own default 25', d(jpb).bright === 25)
check('Defaults: truckview sharpening to its default 127 (switch default on)', d(truck)['sharpen.value'] === 127 && !('sharpen.switch' in d(truck)))
check('Defaults: every camera\'s set passes the checks', all.every((s) => {
  try {
    return Object.keys(d(s)).length === 0 || Object.keys(checkChanges(s, d(s))).length === Object.keys(d(s)).length
  } catch (e) {
    console.log(`   ${s.chl.attrs.id} ${s.profile}: ${e.message}`)
    return false
  }
}))

// impacts (judged on the state after the change)
const keys = (s, diff, active) => impacts(s, diff, active).map((i) => i.key).join()
check('impacts: HWDR camera + gain -> restart', keys(omar, { 'gain.AGC': 40 }) === 'restart')
check('impacts: OFF -> HWDR -> recording gap', keys(pwExit, { 'backlightCompensation.mode': 'HWDR' }) === 'recording-gap')
check('impacts: HWDR level while HWDR -> recording gap', keys(lockers, { 'backlightCompensation.HWDRLevel': 'high' }) === 'recording-gap')
check('impacts: OFF -> HWDR + gain -> both', keys(pwExit, { 'backlightCompensation.mode': 'HWDR', 'gain.AGC': 40 }) === 'recording-gap,restart')
check('impacts: HWDR -> OFF + gain -> recording gap only (no HWDR after)', keys(omar, { 'backlightCompensation.mode': 'OFF', 'gain.AGC': 40 }) === 'recording-gap')
check('impacts: night light, orientation', keys(bondSE, { 'illumination.illuminationMode': 'smart' }) === 'night-light' && keys(pwExit, { flipSwitch: true }) === 'orientation')
check('impacts: another profile than the one in use', keys(gateNight, { bright: 55 }, 'day') === 'other-profile' && keys(gate, { bright: 55 }, 'day') === '')
check('impacts: picture changes need nothing', keys(pwExit, { bright: 55, 'sharpen.switch': true }) === '')

// rebootParam
const dec = (t) => decodeReboot(t)
check('rebootParam: the page\'s names map to groups', dec('backlightCompensation').groups.join() === 'backlightCompensation' && dec('IRCutMode').groups.join() === 'ircut' && dec('whiteLight').groups.join() === 'Whitelight' && dec('antiFlicker').groups.join() === 'antiflicker')
check('rebootParam: smartIr covers both spellings; lists and case', dec('smartIr').groups.join() === 'smartIr,smartIR' && dec('GAIN, shutter;autoExposureMode').groups.join() === 'gain,shutter,autoExposureMode')
check('rebootParam: unknown names are reported raw', dec('fooBar').groups.length === 0 && dec('fooBar').unknown.join() === 'fooBar')

// Undo steps back through this app's changes, only while nothing else changed them
{
  const dev = '192.168.0.228:6036'
  const chl = chlIdOf(13)
  const at = (contrast) => ({ ...gate, leaves: new Map([...gate.leaves, ['contrast', String(contrast)]]) })
  const c = (seq, from, to, extra = {}) => ({ kind: 'change', seq, device: dev, chl, profile: 'day', action: 'change', from: { contrast: from }, to: { contrast: to }, ...extra })
  const r = (seq, result, after, extra = {}) => ({ kind: 'result', seq, result, after: after === undefined ? undefined : { contrast: after }, ...extra })
  const log = [c('a', 50, 55), r('a', 'done', 55), c('b', 55, 60), r('b', 'done', 60)]
  check('undo: the newest change', undoable(log, dev, chl, at(60))?.entry.seq === 'b')
  check('undo: not if changed since (on the NVR or elsewhere)', undoable(log, dev, chl, at(58)) === null)
  const log2 = [...log, { ...c('u1', 60, 55), action: 'undo', undoes: 'b' }, r('u1', 'done', 55)]
  check('undo: then the one before', undoable(log2, dev, chl, at(55))?.entry.seq === 'a')
  const log3 = [...log2, { ...c('u2', 55, 50), action: 'undo', undoes: 'a' }, r('u2', 'done', 50)]
  check('undo: nothing left', undoable(log3, dev, chl, at(50)) === null)
  check('undo: a failed change is passed over', undoable([...log, c('f', 60, 70), r('f', 'failed', 60)], dev, chl, at(60))?.entry.seq === 'b')
  check('undo: a change refused for a restart is passed over', undoable([...log, c('f', 60, 70), r('f', 'restart-needed', 60)], dev, chl, at(60))?.entry.seq === 'b')
  check('undo: an undo that failed does not count', undoable([...log, { ...c('u', 60, 55), action: 'undo', undoes: 'b' }, r('u', 'failed', 60)], dev, chl, at(60))?.entry.seq === 'b')
  check('undo: no read-back uses what was sent', undoable([c('n', 50, 57)], dev, chl, at(57))?.entry.seq === 'n')
  check('undo: other profiles, cameras and devices are separate', undoable(log, dev, chl, { ...at(60), profile: 'night' }) === null && undoable(log, dev, chlIdOf(1), at(60)) === null && undoable(log, '192.168.0.226:6036', chl, at(60)) === null)
  const se = [c('s', 50, 55), r('s', 'done', 55, { sideEffects: { 'backlightCompensation.mode': ['OFF', 'HLC'] } })]
  const withSe = { ...at(55), leaves: new Map([...at(55).leaves, ['backlightCompensation.mode', 'HLC']]) }
  check('undo: side effects must still be as the read-back found them', undoable(se, dev, chl, withSe)?.entry.seq === 's' && undoable(se, dev, chl, at(55)) === null)
  check('undo: side effects that can be written are put back', _test.undoTarget(undoable(se, dev, chl, withSe), withSe).target['backlightCompensation.mode'] === 'OFF')
}

// ---- change logs and the change lock ----------------------------------------------------------
{
  const { rotateLog, readLogCached, withNvrLock } = xmlMod
  const f = join(process.env.DATA_DIR, 'rotate.log')
  const lines = []
  for (let i = 0; i < 30; i++) lines.push({ kind: 'change', seq: `a${i}`, device: 'd', chl: i < 25 ? 'x' : 'y', profile: null }, { kind: 'result', seq: `a${i}` })
  writeFileSync(f, `${lines.map((l) => JSON.stringify(l)).join('\n')}\nnot json\n`)
  check('readLogCached: parsed lines, bad ones skipped', readLogCached(f).length === 60 && readLogCached(f) === readLogCached(f))
  const rotated = rotateLog(f, { keyOf: (e) => e.chl, maxBytes: 1000, keepLines: 4, keepPairs: 2 })
  const kept = readLogCached(f).map((e) => e.seq)
  const { statSync, appendFileSync } = await import('node:fs')
  check('rotateLog: the last change/result pairs of each camera, then the newest lines, within half the limit', rotated && ['a23', 'a24', 'a28', 'a29'].every((s) => kept.filter((k) => k === s).length === 2) && kept.at(-1) === 'a29' && statSync(f).size <= 500, `${kept.join()} (${statSync(f).size} B)`)
  check('rotateLog: small logs are left alone', rotateLog(f) === false)
  // real line sizes: a change line carries every setting before it (~0.7 kB)
  const big = join(process.env.DATA_DIR, 'rotate-big.log')
  const before = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`group${i}.leaf${i}`, String(100 + i)]))
  const pair = (i) => `${JSON.stringify({ kind: 'change', seq: `s${i}`, device: 'd', chl: `c${i % 9}`, profile: 'normal', action: 'change', from: { contrast: 50 }, to: { contrast: 55 }, before })}\n${JSON.stringify({ kind: 'result', seq: `s${i}`, result: 'done', after: { contrast: 55 } })}\n`
  writeFileSync(big, '')
  let count = 0
  while (statSync(big).size <= 1024 * 1024) appendFileSync(big, pair(count++))
  const r1 = rotateLog(big, { keyOf: (e) => e.chl })
  const s1 = statSync(big).size
  appendFileSync(big, pair(count++))
  const r2 = rotateLog(big, { keyOf: (e) => e.chl })
  check('rotateLog: a rotated log ends well under 1 MB, so the next change does not rewrite it again', r1 && s1 <= 512 * 1024 && r2 === false, `rotation 1: ${r1}, ${(s1 / 1048576).toFixed(2)} MB; then rotated again: ${r2}`)
  check('  ... and every camera keeps its last 20 changes', ['c0', 'c8'].every((c) => readLogCached(big).filter((e) => e.kind === 'change' && e.chl === c).length >= 20))
  const n = { id: 'lock-test' }
  await withNvrLock(n, 'A test', async () => {
    throw new Error('boom')
  }).catch(() => {})
  let ran = false
  await withNvrLock(n, 'Another test', () => (ran = true))
  check('withNvrLock: released after a failure', ran)
}

// ---- the whole flow, with a stub for the SDK call ---------------------------------------------

TIMING.verifyMs = [5, 10, 20]
TIMING.pollEveryMs = 5
TIMING.pollMaxMs = 60
// the process-wide spacing of XML calls (250 ms; nvr-xml.test.mjs) shortened with the rest: a 60 ms
// restart poll would otherwise have room for one read
xmlMod._test.setGap(0)

const escT = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const escA = (v) => escT(v).replace(/"/g, '&quot;')
const ser = (n) => {
  const a = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escA(v)}"`).join('')
  return n.children.length ? `<${n.name}${a}>${n.children.map(ser).join('')}</${n.name}>` : `<${n.name}${a}>${escT(n.text.trim())}</${n.name}>`
}
const OK = '<?xml version="1.0" encoding="UTF-8"?><response><status>success</status></response>'
const REFUSE = (code) => `<?xml version="1.0" encoding="UTF-8"?><response><status>fail</status><errorCode>${code}</errorCode></response>`
const REBOOT = (param) => `<?xml version="1.0" encoding="UTF-8"?><response><status>fail</status><rebootParam>${param}</rebootParam></response>`
const OFFLINE = REFUSE('536870962')

/** Plays one camera: answers reads from its saved profiles and applies edits to them. */
class Camera {
  constructor(docs, active) {
    this.docs = Object.fromEntries(Object.entries(docs).map(([p, x]) => [p, kid(parseXml(x), 'response')]))
    this.active = active
    this.edits = []
    this.onEdit = null
    this.pending = [] // edits the camera applies only after some more reads
    this.offlineReads = 0
    this.reads = 0
  }
  node(profile, path) {
    let n = kid(kid(this.docs[profile], 'content'), 'chl')
    for (const k of path.split('.')) n = kid(n, k)
    return n
  }
  get(profile, path) {
    return this.node(profile, path)?.text.trim()
  }
  set(profile, path, v) {
    this.node(profile, path).text = String(v)
  }
  apply(profile, leaves) {
    for (const [p, v] of leaves) {
      if (p === 'rebootPrompt') continue
      if (p.startsWith('scheduleInfo.')) {
        for (const doc of Object.keys(this.docs)) if (this.node(doc, p)) this.set(doc, p, v)
      } else this.set(profile, p, v)
    }
  }
  answer(url, xml) {
    const chl = kid(kid(kid(parseXml(xml), 'request'), 'content'), 'chl')
    if (url === 'queryChlVideoParam') {
      this.reads++
      for (const p of this.pending) if (--p.left === 0) this.apply(p.profile, p.leaves)
      this.pending = this.pending.filter((p) => p.left > 0)
      if (this.offlineReads > 0) {
        this.offlineReads--
        return OFFLINE
      }
      const cfg = /<cfgFile>(\w+)<\/cfgFile>/.exec(xml)?.[1] ?? this.active
      return `<?xml version="1.0" encoding="UTF-8"?>${ser(this.docs[cfg])}`
    }
    if (url === 'editChlVideoParam') {
      const profile = kid(chl, 'cfgFile')?.text.trim() ?? this.active
      const leaves = leafMap(chl)
      const e = { xml, profile, rebootPrompt: kid(chl, 'rebootPrompt')?.text.trim(), leaves, groups: chl.children.map((c) => c.name).filter((n) => n !== 'rebootPrompt' && n !== 'cfgFile') }
      this.edits.push(e)
      const r = this.onEdit?.(e, this)
      if (typeof r === 'string') return r
      if (r?.delay) this.pending.push({ profile, leaves, left: r.delay })
      else this.apply(profile, leaves)
      r?.then?.(this)
      return OK
    }
    return REFUSE('unknown command')
  }
}

const calls = []
const cams = new Map() // "nvr|chlId" -> Camera
let stubBusy = null // (opts) => promise: holds a call "inside the SDK"
xmlMod._test.setCall(async (opts, userId, sendXml, url, out, outSize, len) => {
  calls.push({ nvr: opts.nvr, url, xml: sendXml, userId })
  if (stubBusy) await stubBusy(opts)
  const chlId = /\{[0-9A-F]{8}-0000-0000-0000-000000000000\}/i.exec(sendXml)?.[0]?.toUpperCase()
  const cam = cams.get(`${opts.nvr}|${chlId}`)
  const b = Buffer.from(cam ? cam.answer(url, sendXml) : REFUSE('no such camera'))
  b.copy(out)
  len.writeUInt32LE(Math.min(b.length, outSize))
  return true
})

const fakeNvr = (id, host, channels) => ({
  id,
  name: `NVR ${id}`,
  site: 'Test site',
  cfg: { host, port: 6036 },
  status: 'online',
  get online() {
    return this.status === 'online'
  },
  degraded: false,
  userId: 7,
  gen: 1,
  stopped: false,
  lane: new Lane(id, 2),
  channels: channels.map(([ch, name]) => ({ ch, name, online: true }))
})
const n1 = fakeNvr('t1', '192.168.9.1', [[1, 'PW Exit'], [13, 'North Gate']])
const n2 = fakeNvr('t2', '192.168.9.2', [[2, 'Maingate Roadway'], [19, 'Lockers'], [22, 'Omar River']])
nvrs.set(n1.id, n1)
nvrs.set(n2.id, n2)
const docsOf = (nvr, hex, profiles) => Object.fromEntries(profiles.map(([p, suffix]) => [p, read(nvr, `image-${hex}${suffix}`)]))
const addCam = (nvr, hex, docs, active) => {
  const cam = new Camera(docs, active)
  cams.set(`${nvr.id}|{${hex}-0000-0000-0000-000000000000}`, cam)
  return cam
}
const camPW = () => addCam(n1, '00000002', docsOf('nvr1', '00000002', [['normal', ''], ['day', '-day'], ['night', '-night']]), 'normal')
const camGate = () => addCam(n1, '0000000E', docsOf('nvr1', '0000000E', [['day', ''], ['night', '-night'], ['normal', '-normal']]), 'day')
const camMain = () => addCam(n2, '00000003', docsOf('nvr-2', '00000003', [['normal', '']]), 'normal')
const camOmar = () => addCam(n2, '00000017', docsOf('nvr-2', '00000017', [['normal', ''], ['day', '-day'], ['night', '-night']]), 'normal')

const DEV1 = '192.168.9.1:6036'
const DEV2 = '192.168.9.2:6036'
const post = (nvr, ch, body, sub = '') => handleImaging('POST', nvr.id, ch, new URLSearchParams(), async () => body, 'tester', sub)
const get = (nvr, ch, q = '', sub = '') => handleImaging('GET', nvr.id, ch, new URLSearchParams(q), async () => ({}), 'tester', sub)
const edits = (cam) => cam.edits.length

// GET: the view
{
  let cam = camPW()
  const [st, body] = await get(n1, 1)
  const v = body.settings
  check('GET: settings with active profile, needs, defaults and rules', st === 200 && v.active === 'normal' && v.activeVerified === true && v.needs['sharpen.value'].path === 'sharpen.switch' && Object.keys(v.defaults).length === 0 && v.impactRules.some((r) => r.key === 'restart'), JSON.stringify(body).slice(0, 200))
  check('GET: no writes', edits(cam) === 0)
  cam = camGate()
  const [, gb] = await get(n1, 13, 'profile=night')
  check('GET another profile: reads the one in use first; Night shown, Day active, not yet verified', gb.settings.profile === 'night' && gb.settings.active === 'day' && gb.settings.activeVerified === false && gb.settings.schedule.program === 'auto')
}

// two parts, in order; stale; null body
{
  const cam = camPW()
  const changes = { bright: 60, 'sharpen.switch': true, 'sharpen.value': 150 }
  const seen = { bright: 50, 'sharpen.switch': false, 'sharpen.value': 128 }
  const [st, body] = await post(n1, 1, { device: DEV1, changes, seen, confirm: true })
  check('apply: basic first, then advanced, each on its own', st === 200 && cam.edits.length === 2 && cam.edits[0].groups.join() === 'bright,contrast,hue,saturation' && cam.edits[1].groups.join() === 'sharpen', `${st} ${JSON.stringify(body.result ?? body)}`)
  check('apply: read back, done', body.result?.status === 'done' && body.result.paths.bright === 'done' && body.settings.fields.find((f) => f.path === 'bright').value === 60)
  check('apply: undo offered with its seq', typeof body.settings.undo?.seq === 'string' && body.settings.undo.seq === body.result.seq)
  const [st2, b2] = await post(n1, 1, { device: DEV1, changes: { contrast: 55 }, seen: { contrast: 40 }, confirm: true })
  check('stale: a value that changed since it was shown -> 409, nothing sent', st2 === 409 && b2.stale?.[0]?.path === 'contrast' && b2.stale[0].now === 50 && b2.settings && cam.edits.length === 2)
  const [st3] = await post(n1, 1, { device: DEV1, changes: { contrast: 55 }, confirm: true })
  check('seen is required for a change', st3 === 400)
  const [st4, b4] = await handleImaging('POST', n1.id, 1, new URLSearchParams(), async () => null, 'tester')
  check('a JSON null body is a 400, not a crash', st4 === 400 && /JSON object/.test(b4.error))
  const [st5] = await post(n1, 1, { device: '10.0.0.1:6036', changes: { contrast: 55 }, seen: { contrast: 50 }, confirm: true })
  check('another device address -> 409', st5 === 409)
  const [st6, b6] = await post(n1, 1, { device: DEV1, undo: true, seq: 'not-it', confirm: true })
  check('undo with another seq -> 409 "someone changed this camera since"', st6 === 409 && /Someone changed/.test(b6.error))
  const [st7, b7] = await post(n1, 1, { device: DEV1, undo: true, seq: body.result.seq, confirm: true })
  check('undo by seq: back to 50 and off/128', st7 === 200 && b7.result.status === 'done' && cam.get('normal', 'bright') === '50' && cam.get('normal', 'sharpen.switch') === 'false' && cam.get('normal', 'sharpen.value') === '128', JSON.stringify(b7.result))
}
{
  const cam = camPW()
  cam.onEdit = (e) => (e.groups[0] === 'bright' ? REFUSE('536870947') : undefined)
  const [, body] = await post(n1, 1, { device: DEV1, changes: { bright: 60, 'sharpen.switch': true }, seen: { bright: 50, 'sharpen.switch': false }, confirm: true })
  check('a refused first part: the second is not sent', cam.edits.length === 1 && body.result.paths.bright === 'refused' && body.result.paths['sharpen.switch'] === 'not-sent' && body.result.status === 'failed' && /536870947/.test(body.result.message), JSON.stringify(body.result))
}

// acknowledgements tied to the change
{
  const cam = camPW()
  const [st, b] = await post(n1, 1, { device: DEV1, changes: { mirrorSwitch: true }, seen: { mirrorSwitch: false }, confirm: true })
  check('orientation needs an acknowledgement: 409 needsAck + token, nothing sent', st === 409 && b.needsAck?.[0]?.key === 'orientation' && typeof b.ackToken === 'string' && cam.edits.length === 0)
  const [st2, b2] = await post(n1, 1, { device: DEV1, changes: { mirrorSwitch: true, flipSwitch: true }, seen: { mirrorSwitch: false, flipSwitch: false }, ack: ['orientation'], ackToken: b.ackToken, confirm: true })
  check('ackToken: an old token for a different change -> 409 again, new token', st2 === 409 && b2.ackToken !== b.ackToken && cam.edits.length === 0)
  const [st3] = await post(n1, 1, { device: DEV1, changes: { mirrorSwitch: true }, seen: { mirrorSwitch: false }, ack: [], ackToken: b.ackToken, confirm: true })
  check('ackToken without the key -> 409', st3 === 409 && cam.edits.length === 0)
  const [st4, b4] = await post(n1, 1, { device: DEV1, changes: { mirrorSwitch: true }, seen: { mirrorSwitch: false }, ack: ['orientation'], ackToken: b.ackToken, confirm: true })
  check('acknowledged with the matching token: sent', st4 === 200 && b4.result.status === 'done' && cam.edits.length === 1)
}

// restart refusal: no resend, the partner group stays with the flagged one
{
  const cam = camMain()
  cam.onEdit = (e) => (e.groups.includes('autoExposureMode') ? REBOOT('autoExposureMode') : undefined)
  const changes = { bright: 55, 'autoExposureMode.mode': 'manual', 'smartIR.switch': true }
  const seen = { bright: 50, 'autoExposureMode.mode': 'auto', 'smartIR.switch': false }
  const [st, b] = await post(n2, 2, { device: DEV2, changes, seen, confirm: true })
  const r = b.result
  check('rebootParam: that part applies nothing, the other part does', st === 200 && r.paths.bright === 'done' && r.paths['autoExposureMode.mode'] === 'restart-needed' && r.paths['smartIR.switch'] === 'refused', JSON.stringify(r))
  check('rebootParam: remaining leaves out the group and its partner (gain mode)', JSON.stringify(r.remaining) === '{"smartIR.switch":true}' && r.restartNeeded.join() === 'autoExposureMode')
  check('rebootParam: nothing resent automatically', cam.edits.length === 2)
  check('rebootParam: the message says what can go without it', /Exposure mode needs a camera restart; nothing in that part was changed\. 1 other change can be applied without it/.test(r.message), r.message)
  cam.onEdit = (e) => (e.groups.includes('smartIR') ? REBOOT('smartIr') : undefined)
  const [st2, b2] = await post(n2, 2, { device: DEV2, changes: r.remaining, seen: { 'smartIR.switch': false }, retryOf: r.seq, confirm: true })
  check('"Apply the other changes": refused again -> reported, nothing more offered', st2 === 200 && b2.result.restartNeeded.join() === 'smartIR' && Object.keys(b2.result.remaining).length === 0 && cam.edits.length === 3, JSON.stringify(b2.result))
  const [st3] = await post(n2, 2, { device: DEV2, changes: r.remaining, seen: { 'smartIR.switch': false }, retryOf: r.seq, confirm: true })
  check('"Apply the other changes" only once per refusal', st3 === 409 && cam.edits.length === 3)
  const [st4] = await post(n2, 2, { device: DEV2, changes: { 'smartIR.switch': true, contrast: 60 }, seen: { 'smartIR.switch': false, contrast: 50 }, retryOf: b2.result.seq, confirm: true })
  check('a retry may carry only the changes left over', st4 === 409 && cam.edits.length === 3)
}

// origin 'auto': the camera switched profile since the measurement
{
  const cam = camGate()
  const [st, b] = await post(n1, 13, { device: DEV1, profile: 'night', origin: 'auto', changes: { bright: 55 }, seen: { bright: 50 }, confirm: true })
  check('origin auto: the camera reports another profile -> 409 measure again', st === 409 && /switched to Day since you measured/.test(b.error) && cam.edits.length === 0)
  const [st2, b2] = await post(n1, 13, { device: DEV1, profile: 'day', changes: { 'backlightCompensation.mode': 'HLC' }, seen: { 'backlightCompensation.mode': 'OFF' }, confirm: true })
  check('program auto: Day made to differ from Night in Backlight -> refused (Night read fresh)', st2 === 400 && /Day and Night would differ/.test(b2.error) && cam.edits.length === 0)
  const [st3, b3] = await post(n1, 13, { device: DEV1, profile: 'night', changes: { bright: 55 }, seen: { bright: 50 }, confirm: true })
  check('writing the profile not in use needs "other-profile"', st3 === 409 && b3.needsAck.map((x) => x.key).join() === 'other-profile')
}

// late read-back; side effects; Undo puts them back
{
  const cam = camPW()
  cam.onEdit = () => ({ delay: 2 })
  const [, b] = await post(n1, 1, { device: DEV1, changes: { contrast: 57 }, seen: { contrast: 50 }, confirm: true })
  check('late read-back: the change shows on a later read -> done', b.result.status === 'done' && cam.reads >= 3, `${b.result.status} after ${cam.reads} reads`)
}
{
  const cam = camOmar()
  cam.onEdit = (e) => ({ then: (c) => e.groups.includes('gain') && c.set(e.profile, 'backlightCompensation.mode', 'OFF') })
  const [st, b] = await post(n2, 22, { device: DEV2, changes: { 'gain.AGC': 40 }, seen: { 'gain.AGC': 50 }, confirm: true })
  check('HWDR camera + gain: restart acknowledgement asked for', st === 409 && b.needsAck.map((x) => x.key).join() === 'restart')
  cam.offlineReads = 0
  const t0 = Date.now()
  const [st2, b2] = await post(n2, 22, { device: DEV2, changes: { 'gain.AGC': 40 }, seen: { 'gain.AGC': 50 }, ack: ['restart'], ackToken: b.ackToken, confirm: true })
  check('side effect found by the full read-back: HWDR on -> off', st2 === 200 && JSON.stringify(b2.result.sideEffects) === '{"backlightCompensation.mode":["HWDR","OFF"]}' && /The camera also changed: Backlight HWDR → OFF/.test(b2.result.message), JSON.stringify(b2.result))
  check('restart-class change: read back by polling (10 s x 180 s, shortened here)', Date.now() - t0 >= TIMING.pollMaxMs - 10)
  const u = b2.settings.undo
  check('undo view names the side effect and that it can be put back', u?.sideEffects?.[0]?.path === 'backlightCompensation.mode' && u.sideEffects[0].to === 'HWDR' && u.sideEffects[0].writable === true)
  cam.onEdit = null
  const [st3, b3] = await post(n2, 22, { device: DEV2, undo: true, seq: u.seq, confirm: true })
  check('undo with the side effect: same acknowledgements apply (HWDR back on + gain)', st3 === 409 && b3.needsAck.map((x) => x.key).join() === 'recording-gap,restart')
  const [st4, b4] = await post(n2, 22, { device: DEV2, undo: true, seq: u.seq, ack: ['recording-gap', 'restart'], ackToken: b3.ackToken, confirm: true })
  const last = cam.edits.at(-1)
  check('undo sends the gain back and HWDR on again', st4 === 200 && b4.result.status === 'done' && last.leaves.get('gain.AGC') === '50' && last.leaves.get('backlightCompensation.mode') === 'HWDR' && cam.get('normal', 'backlightCompensation.mode') === 'HWDR', JSON.stringify(b4.result))
}
{
  // a camera that really restarts: reads fail for a while, then show the change
  const cam = camOmar()
  cam.onEdit = () => ({ then: (c) => (c.offlineReads = 3) })
  const [, b] = await post(n2, 22, { device: DEV2, changes: { 'gain.AGC': 45 }, seen: { 'gain.AGC': 50 }, confirm: true })
  const [st, b2] = await post(n2, 22, { device: DEV2, changes: { 'gain.AGC': 45 }, seen: { 'gain.AGC': 50 }, ack: ['restart'], ackToken: b.ackToken, confirm: true })
  check('restart poll: offline reads are expected; done once it is back', st === 200 && b2.result.status === 'done', JSON.stringify(b2.result))
}

// "Restart camera to apply X": only a logged group, logged values, unchanged since, rebootPrompt false
{
  const cam = camPW()
  cam.onEdit = (e) => (e.rebootPrompt === 'true' && e.groups.includes('sharpen') ? REBOOT('sharpen') : undefined)
  const [, b] = await post(n1, 1, { device: DEV1, changes: { 'sharpen.switch': true, 'sharpen.value': 150 }, seen: { 'sharpen.switch': false, 'sharpen.value': 128 }, confirm: true })
  check('restart needed: offered in the view', b.result.restartNeeded.join() === 'sharpen' && b.settings.restart?.[0]?.group === 'sharpen' && b.settings.restart[0].seq === b.result.seq, JSON.stringify(b.settings.restart))
  const seq = b.result.seq
  const [st, b1] = await post(n1, 1, { device: DEV1, restartFor: seq, group: 'sharpen', confirm: true })
  check('restart: needs "restart-confirmed" and its token', st === 409 && b1.needsAck.map((x) => x.key).includes('restart-confirmed') && cam.edits.length === 1)
  const [st2] = await post(n1, 1, { device: DEV1, restartFor: seq, group: 'sharpen', ack: ['restart-confirmed'], ackToken: 'wrong', confirm: true })
  check('restart: a wrong token -> 409', st2 === 409 && cam.edits.length === 1)
  const [st3, b3] = await post(n1, 1, { device: DEV1, restartFor: seq, group: 'sharpen', ack: ['restart-confirmed'], ackToken: b1.ackToken, confirm: true })
  const e = cam.edits.at(-1)
  check('restart: the logged values, that group only, rebootPrompt false', st3 === 200 && cam.edits.length === 2 && e.rebootPrompt === 'false' && e.groups.join() === 'sharpen' && e.leaves.get('sharpen.value') === '150' && b3.result.status === 'done', JSON.stringify(b3.result))
  const [st4] = await post(n1, 1, { device: DEV1, restartFor: seq, group: 'sharpen', ack: ['restart-confirmed'], ackToken: b1.ackToken, confirm: true })
  check('restart: only once', st4 === 409 && cam.edits.length === 2)
}
{
  const cam = camPW()
  cam.onEdit = (e) => (e.rebootPrompt === 'true' && e.groups.includes('sharpen') ? REBOOT('sharpen') : undefined)
  const [, b] = await post(n1, 1, { device: DEV1, changes: { 'sharpen.switch': true, 'sharpen.value': 140 }, seen: { 'sharpen.switch': false, 'sharpen.value': 128 }, confirm: true })
  cam.set('normal', 'sharpen.value', '133') // someone changed it on the NVR meanwhile
  const [st, b2] = await post(n1, 1, { device: DEV1, restartFor: b.result.seq, group: 'sharpen', ack: ['restart-confirmed'], ackToken: 'x', confirm: true })
  check('restart: refused if the group changed since', st === 409 && /changed since/.test(b2.error) && cam.edits.length === 1)
}

// the change lock: one change per NVR
{
  const cam = camPW()
  cam.onEdit = () => ({ delay: 3 })
  const first = post(n1, 1, { device: DEV1, changes: { contrast: 61 }, seen: { contrast: 50 }, confirm: true })
  await sleep(0)
  const [st, b] = await post(n1, 1, { device: DEV1, changes: { contrast: 62 }, seen: { contrast: 50 }, confirm: true })
  check('a second change on the same NVR meanwhile -> 409 with who holds it', st === 409 && /A picture change is running on this NVR \(since \d\d:\d\d/.test(b.error), b.error)
  await first
}

// Day/Night set-up
{
  let cam = camOmar()
  const [, p] = await get(n2, 22, '', 'profiles')
  check('set-up: not offered on HWDR cameras', p.plan.offerable === false && p.plan.reasons.some((r) => /HWDR/.test(r)))
  check('set-up: every leaf compared (Omar River: brightness, contrast, white balance, slowest shutter)', ['bright', 'contrast', 'whiteBalance.mode', 'shutter.upLimit'].every((x) => p.plan.day.some((dd) => dd.path === x)))
  cam = camPW()
  const [, p2] = await get(n1, 1, '', 'profiles')
  check('set-up: not offered before the camera was measured black-and-white at night', p2.plan.offerable === false && p2.plan.reasons.length === 1 && /floodlights/.test(p2.plan.reasons[0]))
  const [fs] = await handleCameraNotes('figures', 'POST', n1.id, 1, async () => ({ device: DEV1, period: 'night', profile: 'normal', stream: 'main', width: 3200, height: 1800, figures: { mono: true, mean: 70 } }), 'tester')
  const [, p3] = await get(n1, 1, '', 'profiles')
  check('set-up: offered after a night measurement in infrared; nothing to copy', fs === 200 && p3.plan.offerable === true && p3.plan.day.length === 0 && p3.plan.impacts.some((i) => i.key === 'schedule'), JSON.stringify(p3.plan.reasons))
  cam.set('day', 'frequency', '50HZ')
  const [, p4] = await get(n1, 1, '', 'profiles')
  check('set-up: refused when a setting that cannot be written differs', p4.plan.offerable === false && p4.plan.reasons.some((r) => /frequency/.test(r)))
  cam.set('day', 'frequency', '60HZ')
  cam.set('day', 'bright', '40')
  const [, p5] = await get(n1, 1, '', 'profiles')
  const [st6, b6] = await post(n1, 1, { device: DEV1, action: 'split', confirm: true }, 'profiles')
  check('set-up: needs its acknowledgement', st6 === 409 && b6.needsAck.some((x) => x.key === 'schedule') && cam.edits.length === 0)
  cam.onEdit = (e) => (e.profile === 'day' && e.leaves.has('bright') ? { delay: 1000 } : undefined) // the camera keeps its Day brightness
  const [st7, b7] = await post(n1, 1, { device: DEV1, action: 'split', ack: p5.plan.impacts.map((i) => i.key), ackToken: p5.plan.ackToken, confirm: true }, 'profiles')
  check('set-up: a copy that did not take -> stopped, program stays normal', st7 === 200 && b7.result.status === 'stopped' && cam.get('normal', 'scheduleInfo.program') === 'normal' && !cam.edits.some((e) => e.leaves.has('scheduleInfo.program')), JSON.stringify(b7.result).slice(0, 300))
  cam.onEdit = null
  cam.pending = []
  const [, p8] = await get(n1, 1, '', 'profiles')
  const [st8, b8] = await post(n1, 1, { device: DEV1, action: 'split', ack: p8.plan.impacts.map((i) => i.key), ackToken: p8.plan.ackToken, confirm: true }, 'profiles')
  const sched = cam.edits.at(-1)
  check('set-up: Day copied from Normal, verified, then program auto', st8 === 200 && b8.result.status === 'done' && cam.get('day', 'bright') === '50' && sched.leaves.get('scheduleInfo.program') === 'auto' && cam.get('normal', 'scheduleInfo.program') === 'auto', JSON.stringify(b8.result).slice(0, 300))
  check('set-up: the Day copy and the schedule went as separate writes; Normal never written', cam.edits.filter((e) => e.profile === 'normal' && !e.leaves.has('scheduleInfo.program')).length === 0)
  const [, g9] = await get(n1, 1)
  const [st10, b10] = await post(n1, 1, { device: DEV1, undo: true, seq: g9.settings.scheduleUndo?.seq, confirm: true }, 'schedule')
  const [st11, b11] = await post(n1, 1, { device: DEV1, undo: true, seq: g9.settings.scheduleUndo?.seq, ack: ['schedule'], ackToken: b10.ackToken, confirm: true }, 'schedule')
  check('schedule undo: back to normal, with its acknowledgement', st10 === 409 && st11 === 200 && b11.result.status === 'done' && cam.get('normal', 'scheduleInfo.program') === 'normal', JSON.stringify(b11.result))
  const [st12] = await handleImaging('GET', n1.id, 1, new URLSearchParams(), async () => ({}), 'tester', 'schedule')
  check('schedule: GET is not allowed (405)', st12 === 405)
  const [st13, b13] = await post(n1, 1, { device: DEV1, program: 'time', dayTime: '07:00', nightTime: '19:00', seen: { program: 'auto' }, confirm: true }, 'schedule')
  check('schedule: stale program -> 409', st13 === 409 && b13.stale?.[0]?.now === 'normal')
}

/** POST, and if the server asks for confirmations, confirm exactly those (as the panel's dialog does). */
const postAcked = async (nvr, ch, body, sub = '') => {
  let [st, b] = await post(nvr, ch, body, sub)
  if (st === 409 && Array.isArray(b.needsAck)) [st, b] = await post(nvr, ch, { ...body, ack: b.needsAck.map((x) => x.key), ackToken: b.ackToken }, sub)
  return [st, b]
}

// the schedule route has the Day/Night set-up's guards (review: it used to skip them)
{
  // Day given HWDR on its own while the program is normal (allowed), then "auto": refused,
  // or Day and Night would differ in HWDR and recording would pause at every switch
  const cam = camPW()
  const [s1, b1] = await postAcked(n1, 1, { device: DEV1, profile: 'day', changes: { 'backlightCompensation.mode': 'HWDR' }, seen: { 'backlightCompensation.mode': 'OFF' }, confirm: true })
  const edits0 = cam.edits.length
  const [s2, b2] = await postAcked(n1, 1, { device: DEV1, program: 'auto', seen: { program: 'normal' }, confirm: true }, 'schedule')
  check('schedule auto: refused while Day has HWDR and differs from Night in Backlight; nothing sent', s1 === 200 && s2 === 400 && /HWDR is on/.test(b2.error) && /Day and Night differ in Backlight/.test(b2.error) && cam.edits.length === edits0 && cam.get('normal', 'scheduleInfo.program') === 'normal', `${s2} ${b2.error}`)
  const [s3, b3] = await postAcked(n1, 1, { device: DEV1, program: 'time', dayTime: '07:00', nightTime: '19:00', seen: { program: 'normal' }, confirm: true }, 'schedule')
  check('  "time" the same', s3 === 400 && /HWDR/.test(b3.error) && cam.edits.length === edits0)
}
{
  const cam = camOmar()
  const [s1, b1] = await postAcked(n2, 22, { device: DEV2, program: 'auto', seen: { program: 'normal' }, confirm: true }, 'schedule')
  check('schedule auto on an HWDR camera (Omar River): refused, as the set-up is', s1 === 400 && /HWDR is on/.test(b1.error) && cam.edits.length === 0, `${s1} ${b1.error}`)
}
{
  // the switch applies the other profile's values: listed in the confirmation, with their own confirmations
  const cam = camPW()
  for (const p of ['day', 'night']) {
    cam.set(p, 'illumination.illuminationMode', 'irLight')
    cam.set(p, 'bright', '44')
  }
  const [s1, b1] = await post(n1, 1, { device: DEV1, program: 'auto', seen: { program: 'normal' }, confirm: true }, 'schedule')
  const keysAsked = (b1.needsAck ?? []).map((x) => x.key).join()
  const sched = b1.needsAck?.find((x) => x.key === 'schedule')?.text ?? ''
  check('schedule auto: the values the camera then uses are listed, with the night light\'s own confirmation', s1 === 409 && keysAsked === 'schedule,night-light' && /Day: Brightness 50 → 44/.test(sched) && /Night: Night light smart → irLight/.test(sched) && cam.edits.length === 0, `${keysAsked} | ${sched || b1.error}`)
  const [s2] = await post(n1, 1, { device: DEV1, program: 'auto', seen: { program: 'normal' }, ack: ['schedule'], ackToken: b1.ackToken, confirm: true }, 'schedule')
  check('  every key must be acknowledged', s2 === 409 && cam.edits.length === 0)
  const [s3, b3] = await post(n1, 1, { device: DEV1, program: 'auto', seen: { program: 'normal' }, ack: ['schedule', 'night-light'], ackToken: b1.ackToken, confirm: true }, 'schedule')
  check('  then sent, program auto', s3 === 200 && b3.result.status === 'done' && cam.get('normal', 'scheduleInfo.program') === 'auto', JSON.stringify(b3.result ?? b3))
  const [, g] = await get(n1, 1)
  const [s4, b4] = await post(n1, 1, { device: DEV1, undo: true, seq: g.settings.scheduleUndo?.seq, confirm: true }, 'schedule')
  check('schedule undo goes through the same plan (back to Normal: its own confirmation)', s4 === 409 && b4.needsAck.map((x) => x.key).includes('schedule'))
  const [, b5] = await postAcked(n1, 1, { device: DEV1, undo: true, seq: g.settings.scheduleUndo?.seq, confirm: true }, 'schedule')
  check('  undo done', b5.result?.status === 'done' && cam.get('normal', 'scheduleInfo.program') === 'normal', JSON.stringify(b5.result ?? b5))
}
{
  // North Gate on program auto, reporting Day: switched to "normal", the document names the normal
  // profile, as the NVR's page does for a fixed program (ds:229-236)
  const cam = camGate()
  const [s1, b1] = await postAcked(n1, 13, { device: DEV1, program: 'normal', seen: { program: 'auto' }, confirm: true }, 'schedule')
  const doc = cam.edits.at(-1)?.xml ?? ''
  check('schedule "normal": cfgFile normal in the document (not the Day profile in use)', s1 === 200 && /<cfgFile>normal<\/cfgFile><scheduleInfo><program>normal<\/program>/.test(doc), `${s1} ${/<cfgFile>\w+<\/cfgFile>/.exec(doc)?.[0]} ${b1.error ?? ''}`)
  // and putting "auto" back (schedule Undo) is judged like any switch to automatic: Night given
  // HWDR meanwhile -> refused
  cam.set('night', 'backlightCompensation.mode', 'HWDR')
  const [, g] = await get(n1, 13)
  const [s2, b2] = await postAcked(n1, 13, { device: DEV1, undo: true, seq: g.settings.scheduleUndo?.seq, confirm: true }, 'schedule')
  check('  schedule Undo back to "auto" with HWDR on Night meanwhile: refused', typeof g.settings.scheduleUndo?.seq === 'string' && s2 === 400 && /HWDR is on/.test(b2.error), `${s2} ${b2.error}`)
}

// Undo that has to put back a side effect the one-request rules would refuse together (review)
{
  // HWDR on; the camera turns anti-flicker off under HWDR (the NVR page locks it)
  const cam = camPW()
  cam.set('normal', 'antiflicker', '60HZ')
  cam.onEdit = (e) => ({ then: (c) => e.groups.includes('backlightCompensation') && c.set(e.profile, 'antiflicker', 'OFF') })
  const [s1, b1] = await postAcked(n1, 1, { device: DEV1, changes: { 'backlightCompensation.mode': 'HWDR' }, seen: { 'backlightCompensation.mode': 'OFF' }, confirm: true })
  const u = b1.settings?.undo
  check('HWDR on, anti-flicker 60HZ -> OFF as a side effect: shown writable in Undo', s1 === 200 && JSON.stringify(b1.result.sideEffects) === '{"antiflicker":["60HZ","OFF"]}' && u?.sideEffects?.[0]?.writable === true, JSON.stringify(b1.result?.sideEffects))
  cam.onEdit = null
  const [s2, b2] = await postAcked(n1, 1, { device: DEV1, undo: true, seq: u?.seq, confirm: true })
  const last = cam.edits.at(-1)
  check('  Undo: HWDR off and anti-flicker back in one request (anti-flicker judged on the state after)', s2 === 200 && b2.result.status === 'done' && cam.get('normal', 'backlightCompensation.mode') === 'OFF' && cam.get('normal', 'antiflicker') === '60HZ' && last.leaves.get('antiflicker') === '60HZ', `${s2} ${b2.error ?? b2.result?.message}`)
}
{
  // Bond SE: night light white light -> smart; the camera changes its white-light mode with it
  const n3 = fakeNvr('t3', '192.168.9.3', [[3, 'Bond SE']])
  nvrs.set(n3.id, n3)
  const cam = addCam(n3, '00000004', docsOf('nvr-2', '00000004', [['normal', '']]), 'normal')
  cam.onEdit = (e) => ({ then: (c) => e.groups.includes('illumination') && c.set(e.profile, 'Whitelight.WhitelightMode', 'off') })
  const [s1, b1] = await postAcked(n3, 3, { device: '192.168.9.3:6036', changes: { 'illumination.illuminationMode': 'smart' }, seen: { 'illumination.illuminationMode': 'whiteLight' }, confirm: true })
  const u = b1.settings?.undo
  check('night light -> smart, white light auto -> off as a side effect', s1 === 200 && b1.result.sideEffects?.['Whitelight.WhitelightMode']?.join() === 'auto,off' && u?.sideEffects?.[0]?.writable === true, JSON.stringify(b1.result?.sideEffects ?? b1.error))
  cam.onEdit = null
  const edits0 = cam.edits.length
  const [s2, b2] = await post(n3, 3, { device: '192.168.9.3:6036', undo: true, seq: u?.seq, confirm: true })
  check('  Undo asks one confirmation for both steps (night light)', s2 === 409 && b2.needsAck.map((x) => x.key).join() === 'night-light' && cam.edits.length === edits0)
  const [s3, b3] = await post(n3, 3, { device: '192.168.9.3:6036', undo: true, seq: u?.seq, ack: ['night-light'], ackToken: b2.ackToken, confirm: true })
  const [e1, e2] = cam.edits.slice(edits0)
  check('  then two requests: the night light first, on its own; the white light after its read-back', s3 === 200 && cam.edits.length === edits0 + 2 && e1.groups.join() === 'illumination' && e2.groups.join() === 'Whitelight' && e2.leaves.get('Whitelight.WhitelightMode') === 'auto', cam.edits.slice(edits0).map((e) => e.groups.join('+')).join(' | '))
  check('  both undone, one answer', b3.result.status === 'done' && cam.get('normal', 'illumination.illuminationMode') === 'whiteLight' && cam.get('normal', 'Whitelight.WhitelightMode') === 'auto' && b3.settings.undo === null, JSON.stringify(b3.result))
}
{
  // a change that applied nothing but changed something else: the camera restarts, keeps its gain
  // limit and comes back with HWDR off. Undo puts back just that side effect
  const cam = camOmar()
  cam.onEdit = (e, c) => {
    if (!e.groups.includes('gain')) return undefined
    c.set(e.profile, 'backlightCompensation.mode', 'OFF')
    return OK
  }
  const [s1, b1] = await postAcked(n2, 22, { device: DEV2, changes: { 'gain.AGC': 40 }, seen: { 'gain.AGC': 50 }, confirm: true })
  const u = b1.settings?.undo
  check('failed change with a side effect (HWDR turned off): Undo offered for the side effect only', s1 === 200 && b1.result.status === 'failed' && u?.sideOnly === true && /Backlight HWDR/.test(u.puts) && u.sideEffects[0].path === 'backlightCompensation.mode', JSON.stringify(u))
  cam.onEdit = null
  const [s2, b2] = await postAcked(n2, 22, { device: DEV2, undo: true, seq: u?.seq, confirm: true })
  const last = cam.edits.at(-1)
  check('  Undo sends HWDR back on only (the kept gain limit is not sent)', s2 === 200 && b2.result.status === 'done' && last.groups.join() === 'backlightCompensation' && cam.get('normal', 'backlightCompensation.mode') === 'HWDR', `${s2} ${b2.error ?? JSON.stringify(b2.result)}`)
}
{
  // the restart path keeps the profile-difference rule: Night changed since the refusal
  const cam = camGate()
  cam.set('night', 'backlightCompensation.mode', 'HLC')
  cam.onEdit = (e) => (e.rebootPrompt === 'true' && e.groups.includes('backlightCompensation') ? REBOOT('backlightCompensation') : undefined)
  const [, b] = await post(n1, 13, { device: DEV1, profile: 'day', changes: { 'backlightCompensation.mode': 'HLC' }, seen: { 'backlightCompensation.mode': 'OFF' }, confirm: true })
  cam.set('night', 'backlightCompensation.mode', 'OFF')
  const edits0 = cam.edits.length
  const [st, b2] = await post(n1, 13, { device: DEV1, profile: 'day', restartFor: b.result?.seq, group: 'backlightCompensation', ack: ['restart-confirmed'], ackToken: 'x', confirm: true })
  check('restart path: refused when it would make Day and Night differ (Night read fresh)', b.result?.restartNeeded?.join() === 'backlightCompensation' && st === 400 && /Day and Night would differ in Backlight/.test(b2.error) && cam.edits.length === edits0, `${st} ${b2.error}`)
}

// ---- the XML queue ------------------------------------------------------------------------------
{
  const q = fakeNvr('tq', '192.168.9.9', [[0, 'A']])
  let release
  const hold = new Promise((r) => (release = r))
  stubBusy = async (opts) => {
    if (opts.nvr === 'tq' && opts.tag === 'first') await hold
  }
  const before = calls.length
  const a = transparent(q, 'queryChlVideoParam', '<x/>', 'first')
  const b = transparent(q, 'queryChlVideoParam', '<x/>', 'second').catch((e) => e)
  await sleep(20)
  q.gen = 2 // a relogin while the first call is inside the SDK
  release()
  await a.catch(() => {})
  const err = await b
  check('XML queue: a call queued behind one inside the SDK is refused after a relogin, nothing sent', err instanceof Error && /reconnected; nothing was sent/.test(err.message) && calls.length - before === 1, err?.message)
  stubBusy = null
  // after a time-out the queue waits for the native call to really return (onLate), not for the time limit
  const fake = (ms) => ({ async: (...args) => setTimeout(() => args.at(-1)(null, true), ms) })
  xmlMod._test.setCall((opts, ...args) => sdkCallT({ ...opts, timeoutMs: 60 }, opts.tag === 'slow' ? fake(400) : fake(5), ...args))
  const t0 = Date.now()
  const slow = transparent(q, 'x', '<x/>', 'slow', { gen: 2 }).catch((e) => e)
  let startedAt = 0
  const next = transparent(q, 'x', '<x/>', 'next', { gen: 2 }).then(() => (startedAt = Date.now())).catch((e) => e)
  const e1 = await slow
  check('XML queue: the slow call times out', e1?.name === 'SdkTimeout')
  check('XML queue: settled is false while it is still inside the SDK', (await xmlSettled(q, 50)) === false)
  await next
  check('XML queue: the next call starts only once the slow one has returned (onLate)', startedAt - t0 >= 380, `${startedAt - t0} ms`)
  check('XML queue: settled afterwards', (await xmlSettled(q, 1000)) === true)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
