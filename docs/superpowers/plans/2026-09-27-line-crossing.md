# Line Crossing in Argus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin draws line-crossing lines on a camera in Argus; Argus writes them into the camera's own detection through the NVR, and each crossing becomes an event within seconds with a phone alert (ntfy), kept footage and a snapshot.

**Architecture:** A pure XML module (tripwire-xml.mjs) reads and builds the NVR's queryTripwire/editTripwire documents exactly as the NVR's own web client does; a route (tripwire.mjs) wraps it in the app's safe-change flow (confirm, acknowledge, write-ahead log, read-back, undo). An alarm watcher polls queryAlarmStatus every 5 s on NVRs with lines and files line-crossing events; line-actions.mjs turns each into an alarm-rule notification, an automatic bookmark and a snapshot taken from Argus's own recording (event-snapshot.mjs). The browser gets a Lines panel in the full-size Live view and snapshot thumbnails on the Alarms page.

**Tech Stack:** Node ESM (.mjs), node:sqlite (events DB), the TVT SDK's TransparentConfig XML channel (nvr-xml.mjs transparent), ffmpeg (snapshots), plain browser JS modules and canvas.

**Spec:** docs/superpowers/specs/2026-09-27-line-crossing-design.md

## Global Constraints

- Only admins change camera settings; every write is confirmed, logged before sending, read back field by field and undoable (newest change only).
- The camera's audio/white-light triggers and NVR relay outputs are never switched on (the floodlight is worked by hand only): refuse, do not send.
- The edit body mirrors the NVR web client's getSaveData (tripwireAlarmCfg.js) element order and names; coordinates are integers 0-10000; triggerAudio/triggerWhiteLight are never sent.
- The alarm watcher is read-only: one queryAlarmStatus per NVR per 5 s, only on NVRs with at least one camera in lines-on.json.
- No site pictures are uploaded to ntfy; alerts carry a link (publicUrl setting, default https://cctv.jfl.gripe).
- Pure modules never import sdk.mjs (koffi is blocked on the Windows PC); SDK/ffmpeg tests run on the server copy (Task 8 Step 1).
- Plain ESM .mjs, no semicolons, 2-space indent, comments that explain why, no new npm dependencies.
- Never touch the test server 192.168.3.147; never print NVR credentials; no load tests on production.
- Commit messages end with: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Where a task's "Cross-task corrections" block differs from its steps, the correction wins.
- Interface contract (names/signatures every task uses): the appendix at the end of this plan.

---

### Task 1: Tripwire XML module (`cctv/tripwire-xml.mjs`): parse, check, build and compare

> **Cross-task corrections (binding - apply these where the steps below differ):**
>
> 1. The spec's Safety section says 'The camera's audio/white-light triggers and NVR relay outputs are never switched on (floodlight by hand only)'. checkChange refuses only triggerAudio/triggerWhiteLight. buildEditTripwire echoes trigger.alarmOuts as read, so for a camera whose line-crossing trigger already links an NVR relay (e.g. a floodlight relay), Argus switching detection on would work that relay at every crossing. The read-back only reports alarmOutOn as a side effect after the fact. The fixtures all have empty alarmOuts, so no test covers this.
>
>    **Fix:** In Task 1 Step 4 checkChange, right after `const next = applyChange(cfg, change)`, add:
> ```js
>   // NVR relay outputs are never switched on from here: with one linked to this camera's line
>   // crossing, switching the detection on would work the relay at every crossing
>   if (next.enabled && cfg.trigger.alarmOuts.length > 0) {
>     return refuse('The camera\'s line crossing has an NVR alarm output (relay) linked; take it out on the NVR first — the floodlight is worked by hand only')
>   }
> ```
> In Step 2, after the white-light refusal checks, add:
> ```js
>   check('refused: switching on with an NVR relay linked', refused({ ...c3, trigger: { ...c3.trigger, alarmOuts: [{ id: '{AAAAAAAA-0000-0000-0000-000000000001}', name: 'Relay 1' }] } }, { enabled: true, lines: lines(ROAD) }, /alarm output/))
> ```
> Update the counts to 116 checks / 116 PASS in Files and Step 5. Optionally mirror it in Task 7's blockedText.


**Files:**
- Create: `cctv/test/fixtures/lines/` holding the 9 files captured from nvr-2, copied under the same names: `tripwire-ch1.xml`, `tripwire-ch3.xml`, `tripwire-ch4.xml`, `nodelist.xml`, `schedulelist.xml`, `alarmstatus.xml`, `systemcaps.xml`, `perimeter-ch1.xml`, `airesource.xml`. This task reads 5 of them. Tasks 2 and 4 read the others.
- Create: `cctv/tripwire-xml.mjs` (523 lines, pure: it imports only `./xml.mjs`)
- Create: `cctv/test/tripwire-xml.test.mjs` (339 lines, 115 checks)
- Test: `node cctv/test/tripwire-xml.test.mjs`. **Runs locally** on the Windows PC from the repo root. It does not use the SDK, koffi or ffmpeg.

**Interfaces:**

*Consumes* (existing code, checked against the file):
- `cctv/xml.mjs`. This file is pure and imports nothing. It provides:
  - `XML_HEADER = '<?xml version="1.0" encoding="utf-8" ?><request version="1.0" systemType="NVMS-9000" clientType="WEB">'`
  - `esc(v)`, which escapes `&`, `"` and `<`
  - `parseXml(xml) -> { name, attrs, children, text }`, which throws `bad answer from the NVR (...)`
  - `kid(n, name)` and `kids(n, name)`
- `cctv/nvr-xml.mjs` is **not** imported. It imports `./sdk.mjs` (nvr-xml.mjs:8), so its `parseAnswer` cannot be used. The module has its own small `answerOf(xml, cmd)` instead.

*Produces* (the contract's names and signatures, exactly):
```
export const DIRECTIONS = ['rightortop', 'leftorbotton', 'none']
export const HOLD_MIN_SAFE_S = 10
export const MIN_LINE_FRACTION = 0.05                     // 500 of 10000 units
export function parseTripwire(xml) -> cfg                 // throws Error('queryTripwire: <reason>')
export function parseSupport(xml) -> Map<chlId, { tripwire: boolean, pea: boolean }>   // throws Error('queryNodeList: ...')
export function parseSchedules(xml) -> [{ id, name }]     // throws Error('queryScheduleList: ...')
export function applyChange(cfg, change) -> next cfg      // deep copy; throws on a change that cannot fit the camera (run checkChange first)
export function checkChange(cfg, change, { schedules = [] } = {}) -> { refuse: string|null, warnings: [{ key, text }] }
export function buildEditTripwire(cfg) -> xml string      // throws rather than send a non-integer/out-of-range value, or if triggerAudio/triggerWhiteLight is on
export function flatten(cfg) -> Record<string, string>
export function compareReadBack(before, asked, after) -> { fields: [{ key, want, got, status: 'as asked'|'not applied' }], sideEffects: [{ key, from, to }] }
```
The `cfg` shape matches the contract. Three things go beyond it, and each is additive:
1. `trigger` also has `alarmOutOn: boolean|null` and `presetOn: boolean|null`. These are answer-only, never sent, and compared on read-back. They mean a relay output being switched on shows up as a side effect.
2. `mutex` holds the `<mutexList>` items followed by any `<mutexListEx>` items (the thermal half of a dual-lens camera). The web client warns about both lists.
3. `flatten` numbers a repeated mutex object: `mutex.osc`, `mutex.osc.2`.

`flatten` keys: `enabled`, `holdTime`, `schedule`, then either `filter.sensitivity` or `filter.<car|person|motor>.{on,sensitivity,min,max}`, then `line.N.{direction,start,end,sensitivity}`, `mutex.<object>`, `triggerAudio`, `triggerWhiteLight`, `saveTargetPicture`, `saveSourcePicture`, `autoTrack`, and `trigger.{rec,alarmOuts,presets,snap,msgPush,buzzer,popVideo,email,sysAudio,recOn,alarmOutOn,presetOn,sysSnap,popMsg,manualAudio,manualLight}`. Values are strings: points are `'x,y'` and sizes are `'WxH'`. A field the answer lacks is left out, and `compareReadBack` reports it as `null`.

Warning keys: `mutex` (turning on while a mutex detection is on), `no-filter` (turning on with `filter === null`), `short-hold` (the result is on and hold < 10 s), `no-lines` (the result is on and all slots are cleared). A change that moves nothing is refused with `Nothing to change: the camera already has these settings`.

How the edit body differs from the web client's `getSaveData`, all on purpose:
- Elements and their order are the same. The web client's stray whitespace (`' <item'`, `'<preset> <presets'`) is dropped.
- `sysAudio id` uses double quotes. This is the same XML.
- `triggerAudio`, `triggerWhiteLight` and the per-line `<sensitivity>` are never sent.
- `<motor>` is sent whenever the answer has one. The web client leaves it out only on thermal channels (`accessType "1"`).

---

- [ ] **Step 1: Copy the fixtures into the repo**

From the repo root `C:\Users\mike\Downloads\websdk3.2\TVT-CCTV` (Git Bash):
```bash
mkdir -p cctv/test/fixtures/lines
cp /c/Users/mike/AppData/Local/Temp/claude/C--Users-mike-Downloads-websdk3-2/224c4b4b-edba-4a0e-b617-76eab964a246/scratchpad/lcprobe/*.xml cctv/test/fixtures/lines/
ls cctv/test/fixtures/lines | wc -l
```
Or in PowerShell:
```powershell
New-Item -ItemType Directory -Force cctv\test\fixtures\lines
Copy-Item "C:\Users\mike\AppData\Local\Temp\claude\C--Users-mike-Downloads-websdk3-2\224c4b4b-edba-4a0e-b617-76eab964a246\scratchpad\lcprobe\*.xml" cctv\test\fixtures\lines\
(Get-ChildItem cctv\test\fixtures\lines).Count
```
Expected: `9`. The files are: airesource.xml, alarmstatus.xml, nodelist.xml, perimeter-ch1.xml, schedulelist.xml, systemcaps.xml, tripwire-ch1.xml, tripwire-ch3.xml, tripwire-ch4.xml.

- [ ] **Step 2: Write the failing test `cctv/test/tripwire-xml.test.mjs`**

```js
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
```

- [ ] **Step 3: Run the test and confirm it fails**

Run from the repo root (locally): `node cctv/test/tripwire-xml.test.mjs`

Expected: FAIL, exit code 1, with
`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...\cctv\tripwire-xml.mjs' imported from ...\cctv\test\tripwire-xml.test.mjs`

- [ ] **Step 4: Write `cctv/tripwire-xml.mjs`**

```js
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
    if (schedules.length && !schedules.some((s) => s.id === g)) return refuse('That schedule is not one of the NVR\'s schedules')
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
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run from the repo root (locally):
```bash
node --check cctv/tripwire-xml.mjs
node cctv/test/tripwire-xml.test.mjs
grep -n "^import" cctv/tripwire-xml.mjs
```
Expected:
- `node --check` prints nothing.
- The test prints 115 `PASS` lines and no `FAIL`, ends with `all passed`, and exits 0.
- The import check shows a single line, `import { XML_HEADER, esc, kid, kids, parseXml } from './xml.mjs'`. That confirms there is no `sdk.mjs` or `nvr-xml.mjs` import, so the module stays pure.

This run has already been done against a scratch copy of this exact code and these fixtures: 115/115 PASS. Four hand-made mutations each made the suite fail:
- a trigger element out of order: 4 FAILED
- the audio/white-light refusal removed: 2 FAILED
- the short-hold warning removed: 2 FAILED
- side effects dropped from the read-back: 2 FAILED

- [ ] **Step 6: Commit**

```bash
git add cctv/tripwire-xml.mjs cctv/test/tripwire-xml.test.mjs cctv/test/fixtures/lines
git commit -F - <<'EOF'
Line crossing: read, check, build and compare a camera's tripwire settings

cctv/tripwire-xml.mjs (pure, imports only xml.mjs): parseTripwire / parseSupport /
parseSchedules for the queryTripwire, queryNodeList and queryScheduleList answers;
applyChange and checkChange (refusals: unknown keys, slot count, non-integer or
out-of-range coordinates, lines under 5% of the picture, unknown direction, hold time
or schedule, filter class or sensitivity, and any camera whose sound/white-light
trigger is on; warnings: mutex, no-filter, short-hold, no-lines); buildEditTripwire
in the web client's getSaveData element order, never sending triggerAudio or
triggerWhiteLight; flatten and compareReadBack for field-by-field read-back with
side effects. Fixtures are nvr-2's own read-only answers (2026-09-27).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Line-crossing settings route (`cctv/tripwire.mjs`) and its server wiring

> **Cross-task corrections (binding - apply these where the steps below differ):**
>
> 1. The drafting note at the end of Task 2 says 'Not verified: the route test has not run ... against Task 1's actual tripwire-xml.mjs'. I ran it in a scratch copy (plan-scratch harness with SDK stubs) with Task 1's drafted tripwire-xml.mjs: it prints 'all passed'. The note overstates the risk and may prompt needless rework.
>
>    **Fix:** Replace the last bullet of the Task 2 drafting notes with: "Verified: with SDK/nvrs/settings stubbed, the route test also passes against Task 1's drafted tripwire-xml.mjs (all passed). It has not yet run against the real SDK modules; that is Step 6 on the server copy."


**Files:**
- Create: `cctv/tripwire.mjs`
- Create: `cctv/test/tripwire-route.test.mjs`
- Modify: `cctv/server.mjs`. Four edits:
  - route list in the header comment, after line 27
  - import, after line 73
  - `CAMERA_METHODS` / `CAMERA_ROUTE`, lines 449-459
  - camera-route dispatch, lines 748-754
- Test: `cctv/test/tripwire-route.test.mjs`. **Server copy only.** It imports `tripwire.mjs`, which imports `nvr-xml.mjs`, which loads `sdk.mjs` and koffi. Koffi cannot load on the Windows PC. Local checks for this task are `node --check` plus three existing tests that read `server.mjs` as text (Step 5).

**Interfaces:**

Consumes, from Task 1 (`cctv/tripwire-xml.mjs`, pure):
- `parseTripwire(xml) -> cfg` (throws `Error(reason)`)
- `parseSupport(xml) -> Map<chlId, { tripwire, pea }>`
- `parseSchedules(xml) -> [{ id, name }]`
- `applyChange(cfg, change) -> cfg`
- `checkChange(cfg, change, { schedules } = {}) -> { refuse, warnings: [{ key, text }] }`
- `buildEditTripwire(cfg) -> xml`
- `flatten(cfg) -> Record<string, string>`
- `compareReadBack(before, asked, after) -> { fields: [{ key, want, got, status }], sideEffects: [{ key, from, to }] }`

Also from Task 1, these fixtures in `cctv/test/fixtures/lines/`: `tripwire-ch1.xml`, `tripwire-ch3.xml`, `nodelist.xml`, `schedulelist.xml`.

The test relies on these contract semantics of `checkChange`:
- Switching on `tripwire-ch3.xml` (filter `null`, hold time 20, no mutex on) with one set line gives exactly `['no-filter']`.
- A white-light trigger that is on makes the refusal text contain "hand only".
- A `scheduleGuid` is only checked against the list when `{ schedules }` is passed. This route passes the list, read fresh, only when the change names a schedule; otherwise it passes `{}`.

Consumes, from existing code (checked in the files):
- `cctv/nvr-xml.mjs`:
  - `HttpError(status, message, extra?)`, `XML_HEADER`, `esc(v)`
  - `cameraOf(nvrs, nvrId, ch) -> { nvr, chlId, name }`
  - `requireOnline(nvr)`
  - `deviceOf(nvr) -> 'sn:…' | 'host:port'`
  - `errorAnswer(e) -> [status, { error, ...extra }]`
  - `isPlainObject(v)`, `newSeq()`
  - `parseAnswer(xml) -> { response, status, errorCode, reboot }`
  - `readLogCached(file) -> object[]`
  - `rotateLog(file, { keyOf })`
  - `settled(nvr, maxMs?)`
  - `transparent(nvr, url, xml, tag, { gen, outBytes }) -> Promise<string>`
  - `withNvrLock(nvr, what, fn)`: throws 409 synchronously while the lock is held.
- `cctv/auth.mjs`: `DATA_DIR`.
- `cctv/nvrs.mjs`: `nvrs` (a Map from id to nvr).
- `cctv/settings.mjs`: `getSettings()`, read as `.alerts.ntfy.topic` (`''` when unset).
- `cctv/xml.mjs`, test only: `XML_HEADER`, `kid`, `parseXml`.

Produces, from `cctv/tripwire.mjs`:
- `export const LINES_LOG = join(DATA_DIR, 'tripwire-changes.log')`
- `export const LINES_ON_FILE = join(DATA_DIR, 'lines-on.json')`, holding `{ "<nvrId>/<ch>": true }` with **ch 0-based**. This is the same ch as the routes, `/api/cameras` and Task 4's `parseAlarmStatus`.
- `export function linesOn() -> Set<'<nvrId>/<ch>'>`: a cached read that returns a copy on every call.
- `export function noteLinesOn(nvrId, ch, on) -> void`: writes through at once (temp file + rename); a failed write is retried on the next call.
- `export async function handleLines(method, nvrId, ch, params, readJson, user, deps = {}) -> [status, body]`
  - `deps = { nvrs?: Map, transparent?: (nvr, url, xml, tag, opts) => Promise<string>, getSettings?: () => settings }` is for tests. `server.mjs` passes nothing.
  - The defaults are resolved on each call, not at import. This keeps a future `nvrs.mjs` import of `linesOn` (Task 4 wiring) safe from the import cycle.
- `export const TIMING = { verifyMs: [1500, 3000, 6000], supportMs: 600000 }`. Tests shorten it.

Answers from the route:
- GET: `[200, { lines: { supported, cfg, schedules, device, seen, undo: { seq, at, by } | null, ntfy: { topicSet } } }]`
  - `cfg` is Task 1's `parseTripwire` object, unchanged.
  - `seen` is a 16-hex string.
  - An unsupported camera gets `supported: false, cfg: null, schedules: [], seen: null, undo: null`.
- POST change `{ device, seen, change, ack?, ackToken?, confirm: true }` and POST undo `{ device, undo: true, seq, ack?, ackToken?, confirm: true }` both answer `[200, { lines: view, result }]`.
  - `result = { seq, status: 'done'|'partial'|'failed'|'unknown', message, answer, fields, sideEffects, warningsAcked: string[] }`.
  - `fields`, `sideEffects` and `warningsAcked` are the contract's. `seq`, `status`, `message` and `answer` are additions for the panel's result line.
  - When `status === 'unknown'` (no read-back), `fields` and `sideEffects` are `[]`.
- 409 `{ error, stale: true }` when the camera changed since `seen`.
- 409 `{ error, needsAck: [{ key, text }], ackToken }` when a warning has not been acknowledged.
- 400 `Refused: … Nothing was sent.` for a `checkChange` refusal.
- 409 when another change holds the NVR lock, the NVR is offline or recovering, or the device does not match.

Log lines in `LINES_LOG`, one JSON object per line:
- change line: `{ kind: 'change', seq, at, user, nvr, device, nvrName, chl, ch (1-based, as imaging/streams), name, action: 'change'|'undo', undoes?, change, undo, to, ack, ackToken, before }`
- result line: `{ kind: 'result', seq, at, result, answer, errorCode?, after, fields, sideEffects }`

Route: `GET|POST /api/admin/nvrs/:id/channels/:ch/lines`, inside `server.mjs`'s `/api/admin` block (admins only, same-origin JSON for POST).

- [ ] **Step 1: Write the failing test `cctv/test/tripwire-route.test.mjs`**

```js
// The line-crossing route (tripwire.mjs): the whole safe-change flow -- support, read, stale check,
// refusals, acknowledgements, write-ahead log, send, read-back, side effects, Undo, the NVR lock --
// against a fake NVR that answers from the answers captured from nvr-2 (test/fixtures/lines) and
// records every body sent. Nothing reaches a real NVR: handleLines gets its NVR list, its XML call
// and its settings through `deps`. tripwire.mjs imports nvr-xml.mjs and so loads the native SDK:
// this runs on the server copy, not on the Windows PC.
//   node cctv/test/tripwire-route.test.mjs [fixtures folder]
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-tripwire-test-'))
// a lines-on file left by an earlier run, with one entry that is not `true`: only the good one counts
writeFileSync(join(process.env.DATA_DIR, 'lines-on.json'), JSON.stringify({ 'old/4': true, 'old/5': 'yes' }))
const { LINES_LOG, LINES_ON_FILE, TIMING, handleLines, linesOn, noteLinesOn } = await import('../tripwire.mjs')
const { XML_HEADER, kid, parseXml } = await import('../xml.mjs')

const dir = process.argv[2] ?? join(import.meta.dirname, 'fixtures', 'lines')
let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const fixture = (f) => readFileSync(join(dir, f), 'utf8')
const logLines = () => (existsSync(LINES_LOG) ? readFileSync(LINES_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const savedOn = () => JSON.parse(readFileSync(LINES_ON_FILE, 'utf8'))

// ---- which cameras have line crossing on -------------------------------------------------------
check('linesOn: read once from the file, only entries that are true', [...linesOn()].join() === 'old/4', [...linesOn()].join())
noteLinesOn('old', 4, false)
check('noteLinesOn off: gone from memory and from the file', !linesOn().has('old/4') && JSON.stringify(savedOn()) === '{}')
noteLinesOn('x', 1, true)
check('noteLinesOn on: in memory and saved as { "<nvr>/<ch>": true }', linesOn().has('x/1') && JSON.stringify(savedOn()) === '{"x/1":true}')
const copy = linesOn()
copy.add('y/2')
check('linesOn hands out a copy', !linesOn().has('y/2'))
noteLinesOn('x', 1, false)

// ---- a fake NVR ----------------------------------------------------------------------------------
TIMING.verifyMs = [5, 10, 20]

const escT = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const escA = (v) => escT(v).replace(/"/g, '&quot;')
const ser = (n) => {
  const a = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escA(v)}"`).join('')
  return n.children.length ? `<${n.name}${a}>${n.children.map(ser).join('')}</${n.name}>` : `<${n.name}${a}>${escT(n.text.trim())}</${n.name}>`
}
const OK = '<?xml version="1.0" encoding="UTF-8"?><response><status>success</status></response>'
const REFUSE = (code) => `<?xml version="1.0" encoding="UTF-8"?><response><status>fail</status><errorCode>${code}</errorCode></response>`
const TIMEOUT = Symbol('timeout')

/** Copies every leaf of `src` onto the element of the same name and place in `dst` (a camera ignores what it lacks). */
function copyLeaves(dst, src) {
  const seen = new Map()
  for (const c of src.children) {
    const n = (seen.get(c.name) ?? 0) + 1
    seen.set(c.name, n)
    const d = dst.children.filter((x) => x.name === c.name)[n - 1]
    if (!d) continue
    if (c.children.length) copyLeaves(d, c)
    else if (!d.children.length) d.text = c.text
  }
}

/** Plays one camera: answers queryTripwire from its saved answer and applies editTripwire to it. */
class Camera {
  constructor(xml) {
    this.doc = kid(parseXml(xml), 'response')
    this.edits = [] // { xml, sent } in order
    this.onEdit = null // (edit, cam) => an answer string | { ignore } | { delay: reads } | { timeout } | { then(cam) } | undefined
    this.pending = [] // edits applied only after some more reads
    this.reads = 0
    this.readsAtEdit = 0
    this.offline = false
    this.logAtEdit = null // the last log line when the edit arrived (write-ahead check)
  }
  get chl() {
    return kid(kid(this.doc, 'content'), 'chl')
  }
  node(path) {
    let n = this.chl
    for (const k of path.split('.')) n = kid(n, k)
    return n
  }
  get(path) {
    return this.node(path)?.text.trim()
  }
  set(path, v) {
    this.node(path).text = String(v)
  }
  read() {
    this.reads++
    for (const p of this.pending) if (--p.left === 0) this.apply(p.sent)
    this.pending = this.pending.filter((p) => p.left > 0)
    if (this.offline) return REFUSE('536870962')
    return `<?xml version="1.0" encoding="UTF-8"?>${ser(this.doc)}`
  }
  apply(sent) {
    if (sent.attrs.scheduleGuid) this.chl.attrs.scheduleGuid = sent.attrs.scheduleGuid
    copyLeaves(this.chl, sent)
  }
  edit(xml) {
    const sent = kid(kid(kid(parseXml(xml), 'request'), 'content'), 'chl')
    this.edits.push({ xml, sent })
    this.readsAtEdit = this.reads
    const r = this.onEdit?.({ xml, sent }, this)
    if (typeof r === 'string') return r
    if (r?.delay) this.pending.push({ sent, left: r.delay })
    else if (!r?.ignore) this.apply(sent)
    r?.then?.(this)
    return r?.timeout ? TIMEOUT : OK
  }
}

const sent = [] // every call: { nvr, url, xml, tag, gen }
const urls = new Set()
const cams = new Map() // "nvrId|chlId" -> Camera
const nodeLists = new Map() // nvr id -> its queryNodeList answer
let hold = null // while set, an edit waits here "inside the NVR" (the lock test)
let arrived = () => {}
let degradeOnRead = null // this NVR goes into recovery right after its next line-crossing read
const fakeTransparent = async (nvr, url, xml, tag, opts = {}) => {
  sent.push({ nvr: nvr.id, url, xml, tag, gen: opts.gen })
  urls.add(url)
  if (url === 'queryNodeList') return nodeLists.get(nvr.id)
  if (url === 'queryScheduleList') return fixture('schedulelist.xml')
  const chlId = /\{[0-9A-F]{8}-0000-0000-0000-000000000000\}/i.exec(xml)?.[0]?.toUpperCase()
  const cam = cams.get(`${nvr.id}|${chlId}`)
  if (!cam) return REFUSE('536870943')
  if (url === 'queryTripwire') {
    const answer = cam.read()
    if (degradeOnRead === nvr) nvr.degraded = true
    return answer
  }
  if (url === 'editTripwire') {
    cam.logAtEdit = logLines().at(-1) ?? null
    arrived()
    if (hold) await hold
    const r = cam.edit(xml)
    if (r === TIMEOUT) throw Object.assign(new Error('NET_SDK_TransparentConfig took longer than 20000 ms'), { name: 'SdkTimeout' })
    return r
  }
  return REFUSE('unknown command')
}

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
  channels: channels.map(([ch, name]) => ({ ch, name, online: true }))
})
const n2 = fakeNvr('t2', '192.168.9.2', [[0, 'JP Wharf South'], [2, 'Maingate Roadway'], [3, 'Bond SE']])
const nx = fakeNvr('tx', '192.168.9.3', [[2, 'Maingate Roadway']]) // an NVR whose cameras have no line crossing
nodeLists.set(n2.id, fixture('nodelist.xml'))
nodeLists.set(nx.id, fixture('nodelist.xml').replace(/<supportTripwire>true<\/supportTripwire>/g, '<supportTripwire>false</supportTripwire>'))
let settingsNow = { alerts: { ntfy: { url: 'https://ntfy.sh', topic: '' } } }
const deps = { nvrs: new Map([[n2.id, n2], [nx.id, nx]]), transparent: fakeTransparent, getSettings: () => settingsNow }
const DEV = '192.168.9.2:6036'
const get = (nvr, ch) => handleLines('GET', nvr.id, ch, new URLSearchParams(), async () => ({}), 'tester', deps)
const post = (nvr, ch, body) => handleLines('POST', nvr.id, ch, new URLSearchParams(), async () => body, 'tester', deps)
/** Posts; if the answer asks for acknowledgements, acknowledges them all with its token and posts again. */
async function postAcked(nvr, ch, body) {
  const [st, b] = await post(nvr, ch, body)
  if (st !== 409 || !b.needsAck) return [st, b]
  return post(nvr, ch, { ...body, ack: b.needsAck.map((w) => w.key), ackToken: b.ackToken })
}
const addCam = (nvr, file) => {
  const cam = new Camera(fixture(file))
  cams.set(`${nvr.id}|${cam.chl.attrs.id.toUpperCase()}`, cam)
  return cam
}
const CLEAR = { direction: 'rightortop', start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }
const ACROSS = { direction: 'rightortop', start: { x: 2000, y: 5000 }, end: { x: 8000, y: 5000 } }
const lines = (...set) => [0, 1, 2, 3].map((i) => set[i] ?? CLEAR)
const MAINGATE = '{00000003-0000-0000-0000-000000000000}'

// ---- GET ----------------------------------------------------------------------------------------
{
  const cam = addCam(n2, 'tripwire-ch3.xml') // IP619E5W: no person/vehicle filter
  const [st, b] = await get(n2, 2)
  const v = b.lines
  check('GET: the camera\'s settings, 4 slots, off', st === 200 && v?.supported === true && v.cfg.enabled === false && v.cfg.lines.length === 4 && v.cfg.chlId === MAINGATE, JSON.stringify(b).slice(0, 300))
  check('GET: the NVR\'s schedules, the device, a seen token, nothing to undo, no ntfy topic', v.schedules.map((s) => s.name).join() === '24x7,24x5,24x2' && v.device === DEV && typeof v.seen === 'string' && v.seen.length > 0 && v.undo === null && v.ntfy.topicSet === false)
  check('GET: only reads (queryNodeList, queryTripwire, queryScheduleList), nothing edited', ['queryNodeList', 'queryTripwire', 'queryScheduleList'].every((u) => sent.some((s) => s.url === u)) && sent.every((s) => s.url.startsWith('query')) && cam.edits.length === 0)
  check('GET: the read asks for this camera\'s param and trigger', sent.find((s) => s.url === 'queryTripwire').xml === `${XML_HEADER}<condition><chlId>${MAINGATE}</chlId></condition><requireField><param/><trigger/></requireField></request>`)
  check('GET: the support read is the web client\'s own request, with supportTripwire', /<nodeType type="nodeType">chls<\/nodeType>/.test(sent[0].xml) && /<supportTripwire\/>/.test(sent[0].xml) && sent[0].xml.startsWith(XML_HEADER))
  check('GET: every call carries the session it was made on', sent.every((s) => s.gen === 1))
  const n = sent.filter((s) => s.url === 'queryNodeList').length
  await get(n2, 2)
  check('support is cached per NVR: no second queryNodeList within 10 minutes', sent.filter((s) => s.url === 'queryNodeList').length === n)
  TIMING.supportMs = 0
  await get(n2, 2)
  check('... and asked again once the cache is older than TIMING.supportMs', sent.filter((s) => s.url === 'queryNodeList').length === n + 1)
  TIMING.supportMs = 10 * 60_000
  settingsNow = { alerts: { ntfy: { url: 'https://ntfy.sh', topic: 'argus-abcdefghij0123456789' } } }
  const [, b2] = await get(n2, 2)
  check('GET: ntfy.topicSet follows the settings', b2.lines.ntfy.topicSet === true)
  settingsNow = { alerts: { ntfy: { url: 'https://ntfy.sh', topic: '' } } }
  check('GET: a camera read as off is not in lines-on', !linesOn().has('t2/2'))
}

// ---- no line crossing on this camera --------------------------------------------------------------
{
  sent.length = 0
  addCam(nx, 'tripwire-ch3.xml')
  const [st, b] = await get(nx, 2)
  check('a camera the NVR says has no line crossing: supported false, its settings not read', st === 200 && b.lines.supported === false && b.lines.cfg === null && b.lines.seen === null && !sent.some((s) => s.url === 'queryTripwire'), JSON.stringify(b))
  const [st2, b2] = await post(nx, 2, { device: '192.168.9.3:6036', seen: 'x', change: { enabled: true }, confirm: true })
  check('... and a change to it is refused, nothing sent', st2 === 400 && /no line-crossing detection/.test(b2.error) && !sent.some((s) => s.url === 'editTripwire'), b2.error)
}

// ---- the route's own checks ----------------------------------------------------------------------
{
  const [s1] = await handleLines('GET', 'nope', 2, new URLSearchParams(), async () => ({}), 'tester', deps)
  const [s2] = await get(n2, 9)
  check('unknown NVR or camera: 404', s1 === 404 && s2 === 404)
  n2.status = 'offline'
  const [s3] = await get(n2, 2)
  n2.status = 'online'
  check('NVR offline: 409', s3 === 409)
  const [s4] = await handleLines('DELETE', n2.id, 2, new URLSearchParams(), async () => ({}), 'tester', deps)
  check('other methods: 405', s4 === 405)
  const [s5, b5] = await handleLines('POST', n2.id, 2, new URLSearchParams(), async () => null, 'tester', deps)
  check('a JSON null body: 400, not a crash', s5 === 400 && /JSON object/.test(b5.error))
  const [s6] = await post(n2, 2, { device: DEV, seen: 'x', change: { enabled: true } })
  check('without confirm: true -> 400', s6 === 400)
  const [s7] = await post(n2, 2, { device: '10.0.0.1:6036', seen: 'x', change: { enabled: true }, confirm: true })
  check('another device address -> 409', s7 === 409)
}

// ---- a line, acknowledged, logged first, read back, undone -----------------------------------------
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  const [, g] = await get(n2, 2)
  const seen = g.lines.seen
  const change = { enabled: true, lines: lines(ACROSS) }
  const [st, b] = await post(n2, 2, { device: DEV, seen: 'not-it', change, confirm: true })
  check('stale: seen from another state -> 409 stale, nothing sent', st === 409 && b.stale === true && cam.edits.length === 0, JSON.stringify(b))
  const [s1, b1] = await post(n2, 2, { device: DEV, seen, change, confirm: true })
  check('switching on a camera with no person/vehicle filter needs an acknowledgement: 409 needsAck + token, nothing sent', s1 === 409 && b1.needsAck?.map((w) => w.key).join() === 'no-filter' && typeof b1.needsAck[0].text === 'string' && typeof b1.ackToken === 'string' && cam.edits.length === 0, JSON.stringify(b1))
  check('nothing logged before the acknowledgement', !existsSync(LINES_LOG))
  const other = { enabled: true, lines: lines({ ...ACROSS, end: { x: 8000, y: 6000 } }) }
  const [s2, b2] = await post(n2, 2, { device: DEV, seen, change: other, ack: ['no-filter'], ackToken: b1.ackToken, confirm: true })
  check('the token is tied to the exact change: another line -> 409 again with a new token', s2 === 409 && b2.ackToken !== b1.ackToken && cam.edits.length === 0)
  const [s3] = await post(n2, 2, { device: DEV, seen, change, ack: [], ackToken: b1.ackToken, confirm: true })
  check('the token without the key -> 409', s3 === 409 && cam.edits.length === 0)
  const [s4, b4] = await post(n2, 2, { device: DEV, seen, change, ack: ['no-filter'], ackToken: b1.ackToken, confirm: true })
  const r = b4.result
  check('acknowledged: 200, one edit, read back, every changed field as asked, no side effects', s4 === 200 && cam.edits.length === 1 && r?.status === 'done' && r.message === 'Applied' && r.fields.length > 0 && r.fields.every((f) => f.status === 'as asked') && r.sideEffects.length === 0, JSON.stringify(b4).slice(0, 400))
  check('result: the acknowledged warnings', JSON.stringify(r.warningsAcked) === '["no-filter"]')
  check('result: the switch and line 1 are among the fields', ['enabled', 'line.0.start', 'line.0.end'].every((k) => r.fields.some((f) => f.key === k)), r.fields.map((f) => f.key).join())
  const body = cam.edits[0].xml
  check('the edit: the NVMS-9000 request for this camera and its schedule, switched on, the line, </request>', body.startsWith(`${XML_HEADER}<content><chl id="${MAINGATE}" scheduleGuid="{ED0F2AE8-6E54-4D89-BE10-E85445FAC8FB}">`) && body.endsWith('</request>') && body.includes('<switch>true</switch>') && body.includes('<startPoint><X>2000</X><Y>5000</Y></startPoint><endPoint><X>8000</X><Y>5000</Y></endPoint>'), body)
  check('the edit never carries the sound or white-light trigger', !/triggerAudio|triggerWhiteLight/.test(body))
  check('the camera now has it', cam.get('param.switch') === 'true')
  check('write-ahead: the change line was in the log before the edit went out, with the full before-state', cam.logAtEdit?.kind === 'change' && cam.logAtEdit.seq === r.seq && cam.logAtEdit.before?.enabled === false && cam.logAtEdit.before.lines.length === 4 && cam.logAtEdit.user === 'tester' && cam.logAtEdit.undo?.enabled === false)
  const log = logLines()
  check('the log: change then result, same seq, done, the acknowledgement kept', log.length === 2 && log[0].kind === 'change' && log[1].kind === 'result' && log[1].seq === r.seq && log[1].result === 'done' && log[0].ack.join() === 'no-filter' && log[0].ch === 3)
  check('the view is the camera as read back, with Undo for this change', b4.lines.cfg.enabled === true && b4.lines.undo?.seq === r.seq && b4.lines.undo.by === 'tester' && b4.lines.seen !== seen)
  check('lines-on: the camera is remembered, and saved', linesOn().has('t2/2') && savedOn()['t2/2'] === true)
  const [s5, b5] = await post(n2, 2, { device: DEV, undo: true, seq: 'not-it', confirm: true })
  check('undo with another seq -> 409, nothing sent', s5 === 409 && /Someone changed/.test(b5.error) && cam.edits.length === 1)
  const [s6, b6] = await postAcked(n2, 2, { device: DEV, undo: true, seq: r.seq, confirm: true })
  check('undo: off again, the slot cleared', s6 === 200 && b6.result?.status === 'done' && b6.result.message === 'Undone' && cam.get('param.switch') === 'false' && cam.edits.length === 2 && !cam.edits[1].xml.includes('<X>2000</X>'), JSON.stringify(b6.result ?? b6))
  check('undo: nothing more to undo, and lines-on forgets the camera', b6.lines.undo === null && !linesOn().has('t2/2') && !('t2/2' in savedOn()))
  const [s7] = await post(n2, 2, { device: DEV, undo: true, seq: r.seq, confirm: true })
  check('undo only once', s7 === 409 && cam.edits.length === 2)
  // someone draws the very same line again on the NVR's own page: that change was undone, and stays undone
  cam.set('param.switch', 'true')
  cam.set('param.line.item.startPoint.X', '2000')
  cam.set('param.line.item.startPoint.Y', '5000')
  cam.set('param.line.item.endPoint.X', '8000')
  cam.set('param.line.item.endPoint.Y', '5000')
  const [, g2] = await get(n2, 2)
  check('an undone change is never offered again, even when the camera shows what it left', g2.lines.cfg.enabled === true && g2.lines.undo === null)
}

// ---- Undo only while the camera shows what the change left ------------------------------------------
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  const [, g] = await get(n2, 2)
  const [st, b] = await postAcked(n2, 2, { device: DEV, seen: g.lines.seen, change: { enabled: true, lines: lines(ACROSS) }, confirm: true })
  check('(set-up) applied', st === 200 && b.result?.status === 'done', JSON.stringify(b))
  cam.set('param.alarmHoldTime', '30') // someone changes it on the NVR's own page
  const [, g2] = await get(n2, 2)
  check('Undo is no longer offered once the camera differs from what the change left', g2.lines.undo === null)
  const [s2] = await post(n2, 2, { device: DEV, undo: true, seq: b.result.seq, confirm: true })
  check('... and refused if asked for anyway, nothing sent', s2 === 409 && cam.edits.length === 1)
}

// ---- refusals and the other acknowledgements ---------------------------------------------------------
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  const [, g] = await get(n2, 2)
  const seen = g.lines.seen
  const before = logLines().length
  const [s1, b1] = await post(n2, 2, { device: DEV, seen, change: { enabled: true, lines: lines({ ...ACROSS, end: { x: 2300, y: 5000 } }) }, confirm: true })
  check('refused: a line shorter than 5% of the picture; nothing sent or logged', s1 === 400 && /^Refused: .*Nothing was sent\.$/.test(b1.error) && cam.edits.length === 0 && logLines().length === before, b1.error)
  const [s2, b2] = await post(n2, 2, { device: DEV, seen, change: { holdTime: 7 }, confirm: true })
  check('refused: a hold time not among the camera\'s choices', s2 === 400 && cam.edits.length === 0, b2.error)
  sent.length = 0
  const [s3, b3] = await post(n2, 2, { device: DEV, seen, change: { scheduleGuid: '{00000000-1111-2222-3333-444444444444}' }, confirm: true })
  check('refused: a schedule the NVR does not have (its list read fresh for the check)', s3 === 400 && cam.edits.length === 0 && sent.some((s) => s.url === 'queryScheduleList'), b3.error)
  const [s4, b4] = await post(n2, 2, { device: DEV, seen, change: { colour: 'red' }, confirm: true })
  check('refused: a setting this route does not change', s4 === 400 && cam.edits.length === 0, b4.error)
  const [s5] = await post(n2, 2, { device: DEV, seen, change: 'on', confirm: true })
  check('change must be an object', s5 === 400)
  const [s6, b6] = await post(n2, 2, { device: DEV, seen, change: { enabled: true, holdTime: 5, lines: lines(ACROSS) }, confirm: true })
  check('a hold time under 10 s while on: the short-hold acknowledgement', s6 === 409 && b6.needsAck.map((w) => w.key).includes('short-hold') && cam.edits.length === 0, JSON.stringify(b6))
  const [s7, b7] = await post(n2, 2, { device: DEV, seen, change: { enabled: true }, confirm: true })
  check('switched on with no line set: the no-lines acknowledgement', s7 === 409 && b7.needsAck.map((w) => w.key).includes('no-lines') && cam.edits.length === 0, JSON.stringify(b7))
  const [s8, b8] = await post(n2, 2, { device: DEV, seen, change: { scheduleGuid: '{BD47C3AC-7BF3-4AAF-A84E-494855859247}' }, confirm: true })
  check('a schedule from the NVR\'s list: sent as chl@scheduleGuid, read back as asked', s8 === 200 && b8.result?.status === 'done' && cam.edits.at(-1)?.xml.includes('scheduleGuid="{BD47C3AC-7BF3-4AAF-A84E-494855859247}"') && cam.chl.attrs.scheduleGuid === '{BD47C3AC-7BF3-4AAF-A84E-494855859247}', JSON.stringify(b8.result ?? b8))
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.set('param.mutexList.item.status', 'true') // intrusion (perimeter) is on
  const [, g] = await get(n2, 2)
  const [s1, b1] = await post(n2, 2, { device: DEV, seen: g.lines.seen, change: { enabled: true, lines: lines(ACROSS) }, confirm: true })
  check('switching on while a detection that cannot run beside it is on: the mutex acknowledgement', s1 === 409 && b1.needsAck.map((w) => w.key).includes('mutex') && cam.edits.length === 0, JSON.stringify(b1))
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.set('param.triggerWhiteLight', 'true') // someone set it on the NVR
  const [, g] = await get(n2, 2)
  const [s1, b1] = await postAcked(n2, 2, { device: DEV, seen: g.lines.seen, change: { enabled: true, lines: lines(ACROSS) }, confirm: true })
  check('the camera\'s white-light trigger is on: the change is refused, nothing sent (floodlight by hand only)', s1 === 400 && /hand only/.test(b1.error) && cam.edits.length === 0, b1.error)
}

// ---- what the camera did with it ------------------------------------------------------------------
const enableAcross = async () => {
  const [, g] = await get(n2, 2)
  return postAcked(n2, 2, { device: DEV, seen: g.lines.seen, change: { enabled: true, lines: lines(ACROSS) }, confirm: true })
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.onEdit = () => ({ ignore: true }) // the NVR says yes, the camera keeps its settings
  const [st, b] = await enableAcross()
  check('accepted but not applied: every field "not applied", failed, said so', st === 200 && b.result.status === 'failed' && b.result.fields.every((f) => f.status === 'not applied') && /kept its line settings/.test(b.result.message), JSON.stringify(b.result))
  check('... read back three times (1.5, 3, 6 s; shortened here), never sent again', cam.edits.length === 1 && cam.reads - cam.readsAtEdit === 3, `${cam.reads - cam.readsAtEdit} reads`)
  check('... nothing to undo, and lines-on stays off', b.lines.undo === null && !linesOn().has('t2/2'))
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.onEdit = () => REFUSE('536870947')
  const [st, b] = await enableAcross()
  check('refused by the NVR: failed with its error code, read back once', st === 200 && b.result.status === 'failed' && /refused \(536870947\)/.test(b.result.message) && cam.reads - cam.readsAtEdit === 1, JSON.stringify(b.result))
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.onEdit = () => ({ then: (c) => c.set('trigger.msgPushSwitch', 'false') })
  const [st, b] = await enableAcross()
  const fx = b.result?.sideEffects?.find((s) => s.key === 'trigger.msgPush')
  check('a side effect found by the full read-back: push messages on -> off, reported', st === 200 && b.result.status === 'done' && fx?.from === 'true' && fx?.to === 'false' && /The camera also changed: trigger\.msgPush true → false/.test(b.result.message), JSON.stringify(b.result))
  check('... and in the result line of the log', logLines().at(-1).sideEffects?.some((s) => s.key === 'trigger.msgPush'))
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.onEdit = () => ({ delay: 2 })
  const [st, b] = await enableAcross()
  check('late: shows on the second read-back -> done, no third read', st === 200 && b.result.status === 'done' && cam.reads - cam.readsAtEdit === 2, `${b.result?.status} after ${cam.reads - cam.readsAtEdit} reads`)
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.onEdit = () => ({ timeout: true, delay: 2 }) // the SDK gives up waiting; the camera applies it a little later
  const [st, b] = await enableAcross()
  check('no answer in time, applied later: read back until it shows -> done', st === 200 && b.result.status === 'done' && b.result.answer === 'no answer in time' && cam.reads - cam.readsAtEdit === 2, JSON.stringify(b.result))
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.onEdit = () => ({ ignore: true, then: (c) => (c.offline = true) }) // gone right after the edit
  const [st, b] = await enableAcross()
  check('no read-back at all: unknown, said so, nothing to undo', st === 200 && b.result.status === 'unknown' && /could not be read back/.test(b.result.message) && b.lines.undo === null && logLines().at(-1).result === 'unknown', JSON.stringify(b.result))
}

// ---- answers that must not be acted on ----------------------------------------------------------------
{
  cams.set(`${n2.id}|{00000004-0000-0000-0000-000000000000}`, new Camera(fixture('tripwire-ch3.xml'))) // Bond SE answered with Maingate's settings
  const [st, b] = await get(n2, 3)
  check('an answer for another camera: 502, never shown or used', st === 502 && /another camera/.test(b.error), JSON.stringify(b))
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  const [, g] = await get(n2, 2)
  const logged = logLines().length
  degradeOnRead = n2 // the NVR goes into recovery right after the fresh read
  const [st, b] = await post(n2, 2, { device: DEV, seen: g.lines.seen, change: { scheduleGuid: '{BD47C3AC-7BF3-4AAF-A84E-494855859247}' }, confirm: true })
  degradeOnRead = null
  n2.degraded = false
  check('the NVR busy or reconnected after the fresh read: 409, nothing sent or logged', st === 409 && /nothing was sent/.test(b.error) && cam.edits.length === 0 && logLines().length === logged, JSON.stringify(b))
}

// ---- one change per NVR ---------------------------------------------------------------------------
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  let release
  hold = new Promise((r) => (release = r))
  const inside = new Promise((r) => (arrived = r))
  const first = enableAcross()
  await inside
  const [s2, b2] = await post(n2, 3, { device: DEV, seen: 'x', change: { enabled: true }, confirm: true })
  check('a second change on the same NVR while one is inside it -> 409, says what is running', s2 === 409 && /A line-crossing change is running on this NVR/.test(b2.error), b2.error)
  release()
  hold = null
  arrived = () => {}
  const [s1, b1] = await first
  check('... and the first one finishes', s1 === 200 && b1.result.status === 'done' && cam.edits.length === 1)
}

// ---- a camera with the person/vehicle filter (IP6196W) -----------------------------------------------
{
  const cam = addCam(n2, 'tripwire-ch1.xml')
  const [, g] = await get(n2, 0)
  check('IP6196W: the car/person/motor filter as the camera reports it', g.lines.cfg.filter?.kind === 'objects' && ['car', 'person', 'motor'].every((c) => g.lines.cfg.filter.classes[c]?.on === true), JSON.stringify(g.lines.cfg.filter))
  const [st, b] = await postAcked(n2, 0, { device: DEV, seen: g.lines.seen, change: { filter: { car: { on: false, sensitivity: 50 }, person: { on: true, sensitivity: 70 } } }, confirm: true })
  check('a filter change: sent, read back as asked', st === 200 && b.result?.status === 'done' && cam.get('param.objectFilter.car.switch') === 'false' && cam.get('param.objectFilter.person.sensitivity') === '70', JSON.stringify(b.result ?? b))
  check('... the size boxes echoed as read', cam.edits[0].xml.includes('<minDetectTarget><width>100</width><height>100</height></minDetectTarget>'))
  const [, other] = await get(n2, 2)
  check('Undo is per camera: this change is not offered on Maingate Roadway', b.lines.undo?.seq === b.result.seq && other.lines.undo?.seq !== b.result.seq)
}

// ---- server.mjs wiring (it loads the SDK, so it is read as text) ----------------------------------------
{
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  check('server.mjs imports handleLines', /import \{ handleLines \} from '\.\/tripwire\.mjs'/.test(src))
  check('server.mjs: /lines is a camera route taking GET and POST', src.includes("lines: ['GET', 'POST']") && src.includes('|stream\\/estimate|notes|figures|lines)$/'))
  const at = src.indexOf('await handleLines(req.method, id, ch, url.searchParams, readJson, user)')
  check('server.mjs dispatches it inside the admin block (admins only, same-origin JSON)', at > 0 && at > src.indexOf("if (pathname.startsWith('/api/admin/'))"))
}

check('every command sent in this whole test was a query or editTripwire', [...urls].every((u) => /^query/.test(u) || u === 'editTripwire'), [...urls].join())

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Check the test locally, then run it on the server copy (expected FAIL)**

Locally, from the repo root:
```
node --check cctv/test/tripwire-route.test.mjs
```
Expected: no output, exit 0. Do not run the test itself on the Windows PC; it loads the SDK.

Then run on the server copy (see Task 8 Step 1):
```
node cctv/test/tripwire-route.test.mjs
```
Expected: FAIL, exit 1, with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/cctv/tripwire.mjs' imported from …/cctv/test/tripwire-route.test.mjs`.

- [ ] **Step 3: Write `cctv/tripwire.mjs`**

```js
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
//   detection that cannot run beside this one, no person/vehicle filter, a short hold time, no line;
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
  if (after) noteLinesOn(nvr.id, ctx.ch, after.enabled)
  try {
    writeLog({ kind: 'result', seq, at: new Date().toISOString(), result: status, answer: a.status, errorCode: a.errorCode || undefined, after: after ? flatten(after) : null, fields, sideEffects })
    rotateLog(LINES_LOG, { keyOf: logKey })
  } catch (e) {
    console.warn(`[tripwire] result not logged: ${e.message}`)
  }
  const kept = fields.filter((f) => f.status !== 'as asked').map((f) => f.key)
  let message =
    status === 'done' ? (action === 'undo' ? 'Undone' : 'Applied')
      : status === 'unknown' ? 'Sent, but the camera\'s line settings could not be read back; reopen this panel.'
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
 *   same arguments) and the settings (default settings.mjs getSettings). server.mjs passes none.
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
      // the change is made and logged by now: a failed list of schedules must not hide its result
      const schedules = await readSchedules(ctx).catch(() => [])
      return [200, { lines: view(ctx, true, r.after ?? cfg, schedules), result: r.result }]
    })
  } catch (e) {
    return errorAnswer(e)
  }
}
```

- [ ] **Step 4: Wire the route into `cctv/server.mjs` (four edits, each anchor occurs exactly once)**

Edit 1, the route list in the header comment (line 27). Find:
```
//     .../stream, .../stream/estimate -> main (recording) stream, see streams.mjs
```
Replace with:
```
//     .../stream, .../stream/estimate -> main (recording) stream, see streams.mjs
//     .../lines -> line-crossing lines the camera detects on, see tripwire.mjs
```

Edit 2, the import (line 73). Find:
```
import { handleStreams } from './streams.mjs'
```
Replace with:
```
import { handleStreams } from './streams.mjs'
import { handleLines } from './tripwire.mjs'
```

Edit 3, the camera routes and their methods (lines 456-459). Find:
```
  notes: ['GET', 'POST'],
  figures: ['GET', 'POST']
}
const CAMERA_ROUTE = /^\/api\/admin\/nvrs\/([^/]+)\/channels\/(\d{1,3})\/(image|image\/profiles|image\/schedule|lens|stream|stream\/estimate|notes|figures)$/
```
Replace with:
```
  notes: ['GET', 'POST'],
  figures: ['GET', 'POST'],
  lines: ['GET', 'POST'] // read / change, undo
}
const CAMERA_ROUTE = /^\/api\/admin\/nvrs\/([^/]+)\/channels\/(\d{1,3})\/(image|image\/profiles|image\/schedule|lens|stream|stream\/estimate|notes|figures|lines)$/
```

Edit 4, the dispatch inside the `/api/admin` block, next to `/image` and `/stream` (lines 753-754). Find:
```
            ? await handleStreams(what === 'stream' ? 'stream' : 'estimate', req.method, id, ch, url.searchParams, readJson, user)
            : await handleCameraNotes(what, req.method, id, ch, readJson, user)
```
Replace with:
```
            ? await handleStreams(what === 'stream' ? 'stream' : 'estimate', req.method, id, ch, url.searchParams, readJson, user)
            : what === 'lines'
              ? await handleLines(req.method, id, ch, url.searchParams, readJson, user)
              : await handleCameraNotes(what, req.method, id, ch, readJson, user)
```

With this, POST goes through the block's existing same-origin and `application/json` checks, and `/api/admin/*` is admins only. `readJson` is the block's existing `readJsonObject(req, 8192)`.

- [ ] **Step 5: Local checks (Windows PC, repo root)**

```
node --check cctv/tripwire.mjs
node --check cctv/server.mjs
node cctv/test/nvr-netstatus.test.mjs
node cctv/test/camera-links.test.mjs
node cctv/test/live-mux-server.test.mjs
```
Expected:
- The two `--check` commands print nothing and exit 0.
- The three tests end with `all passed` and exit 0. They are pure and read `server.mjs` as text, so they confirm the edits left the other wiring alone.

- [ ] **Step 6: Run the tests on the server copy (expected PASS)**

Run on the server copy (see Task 8 Step 1):
```
node cctv/test/tripwire-route.test.mjs
node cctv/test/imaging.test.mjs
node cctv/test/streams.test.mjs
```
Expected:
- `tripwire-route.test.mjs`: every line `PASS`, ends `all passed`, exit 0. The only other output is the `[tripwire] t2 ch3 "Maingate Roadway": … (change, by tester)` log lines.
- `imaging.test.mjs` and `streams.test.mjs`: still `all passed`. They share nvr-xml.mjs's per-NVR change lock with this route.

- [ ] **Step 7: Commit**

```
git add cctv/tripwire.mjs cctv/test/tripwire-route.test.mjs cctv/server.mjs
git commit -m "Lines route: a camera's line-crossing settings, changed and undone through the NVR" -m "GET/POST /api/admin/nvrs/:id/channels/:ch/lines (cctv/tripwire.mjs), the safe-change flow of the Picture and Stream panels: support from queryNodeList cached 10 min, stale check, refusals, acknowledgements tied to the exact change, write-ahead log, read-back of every field with side effects, Undo of the newest change only while the camera still shows it. lines-on.json remembers which cameras have line crossing on, for the alarm watcher." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

<!-- Drafting notes (not plan steps):
  - Checked locally in C:\Users\mike\AppData\Local\Temp\claude\C--Users-mike-Downloads-websdk3-2\224c4b4b-edba-4a0e-b617-76eab964a246\scratchpad\plan-scratch\ with nvr-xml.mjs's SDK import stubbed, nvrs/settings stubbed, and a contract-following stand-in for Task 1's tripwire-xml.mjs: the route test ends "all passed".
  - mutate.mjs there breaks tripwire.mjs 14 ways (no ack check, no stale check, write-ahead after the send, no undone set, no read-back after a timeout, no gen/degraded guard, no chlId check, and others); the test catches every one.
  - patch-server.mjs applied the four server.mjs edits against a copy of the real file (each anchor found exactly once). The three local text-reading tests pass on the patched copy.
  - Not verified: the route test has not run against the real SDK modules or against Task 1's actual tripwire-xml.mjs. It relies on the contract semantics listed under Interfaces (Consumes). -->

---

### Task 3: Event kind `line-crossing`: record bits 0x80/0x400 and a 30 s fold in addEvent

> **Cross-task corrections (binding - apply these where the steps below differ):**
>
> 1. Step 3 expects alarms.test.mjs to end with `13 FAILED` before the change. Counting the new checks against the unchanged modules gives 14:
> - 'a rule may name line crossings'
> - 'and the kind gets a label'
> - '... naming a crossing as one'
> - 'a subtype is shown beside it'
> - the 10 fold checks: window 30 s, folded in, moves the end, keeping start, exactly 30 s, never pulls back, joins the nearer, end grows, two not five, acknowledged still takes its recording
> The other new checks (Edit 3's rule-matching ones, Edit 6, and the non-fold checks in Edit 9) pass even before the change.
>
>    **Fix:** In Task 3 Step 3, replace "`alarms.test.mjs` ends with `13 FAILED`" with "`alarms.test.mjs` ends with `14 FAILED`". Also change "alarms.test.mjs 13 FAILED" under 'Both test files run locally' to "14 FAILED". Or re-run the pre-change test on the scratch copy and state the observed number.


**Files:**
- Modify: `cctv/public/alarms-view.js`, the `EVENT_KINDS` entry at line 33.
- Modify: `cctv/event-rules.mjs`:
  - `FROM` at line 32.
  - `RECORD_TYPE_BITS` at lines 73 and 76.
  - `MODE_TYPES` at lines 319–323.
- Modify: `cctv/events-db.mjs`:
  - constants at lines 21–22.
  - the `find` prepared statement at line 46.
  - the events section and the start of `addEvent` at lines 123–133.
- Test (modify): `cctv/test/events.test.mjs` at lines 16–20, 47–48, 63, 127–130, plus a new block before line 357.
- Test (modify): `cctv/test/alarms.test.mjs` at lines 22–26, 55, 67, 128–130, 141, 162, 315, 319, plus a new block before line 340.

**Both test files run locally** with `node cctv/test/<x>.test.mjs` from the repo root:
- `node:sqlite` is built into Node 22.5 and later. This PC has v24.19.0.
- Neither file loads the SDK. `events.mjs` imports `nvr-xml.mjs` only lazily, inside `sdkQuery`.
- Checked on a scratch copy of `cctv/`: before the change, `events.test.mjs` reports 12 FAILED and `alarms.test.mjs` 13 FAILED. After it, both print `all passed` and exit 0.
- No other test file imports `event-rules.mjs`, `events-db.mjs` or `alarms-view.js`.

**Interfaces:**
- **Consumes (existing code, read and checked):**
  - `cctv/events-db.mjs:130`: `export function addEvent(e, nowMs = Date.now()) -> { event: object, isNew: boolean }`. The `e` fields are `{ nvr, ch, type, subtype?, startMs, endMs?, source?, detail?, priority?, ruleId?, ruleName? }`.
  - The prepared statements `add` (INSERT OR IGNORE), `find`, `byId`, and `extend`. `extend` is `UPDATE events SET end_ms = ? WHERE id = ? AND (end_ms IS NULL OR end_ms < ?)`.
  - `plain(row)`.
  - The schema in `rec-index.mjs:93`: `UNIQUE (nvr, ch, type, subtype, start_ms)` and index `events_cam (nvr, ch, start_ms)`.
  - `cctv/events.mjs:386` and `:463`: the intake calls `store.addEvent(e, nowMs)` and calls `onEvent(event)` (the rules and notifier) only when `isNew && event`.
  - `cctv/event-rules.mjs`: `typesFromRecordBits(bits) -> [{ type, subtype }]`, `checkRule(raw)`, `ruleMatches(rule, event)`, `applyRules(rules, event)`, `labelOf(type)`, `eventsForMode(events, mode)`.
- **Produces (other tasks rely on these):**
  - `cctv/public/alarms-view.js` `EVENT_KINDS` gets `{ type: 'line-crossing', label: 'Line crossing', confirmed: true }`, placed after `'ai'`.
    - As a result, `labelOf('line-crossing') === 'Line crossing'`.
    - `TYPE_NAMES` and `CONFIRMED_TYPES` include `'line-crossing'`.
    - `checkRule({ ..., types: ['line-crossing'] })` is accepted. Task 5 `setLineAlert` needs this.
  - `cctv/event-rules.mjs` `RECORD_TYPE_BITS`:
    - `{ bit: 0x0080, type: 'line-crossing', subtype: 'line crossed' }`
    - `{ bit: 0x0400, type: 'line-crossing', subtype: 'tripwire' }`
    - `FROM['line-crossing'] = 'the camera’s own line-crossing detection (NVR alarm status; recordings 0x80/0x400)'`
  - `cctv/event-rules.mjs` `MODE_TYPES.ai` and `MODE_TYPES['ai-or-motion']` now include `'line-crossing'`. This keeps recording behaviour the same: those bits used to be `'ai'`.
  - `cctv/events-db.mjs`: `export const MERGE_MS = 30_000`.
  - `cctv/events-db.mjs` `addEvent(e, nowMs = Date.now()) -> { event, isNew }`. The signature and return shape are unchanged.
    - **The fold:** an event with `type === 'line-crossing'` is folded into the `'line-crossing'` event of the same `nvr`/`ch` (any subtype) whose `startMs` is nearest its own, when `|e.startMs - existing.startMs| <= MERGE_MS`. The boundary counts. On a tie, the earlier start wins, then the lower id.
    - **What changes on a fold:** only `end_ms` changes, to `max(existing end or start, incoming end or start)`. The row's start, subtype, source, detail, priority and acknowledgement are kept. An acknowledged event folds too.
    - **What a fold returns:** `{ event: <that row, re-read>, isNew: false }`. This is the same answer as an exact repeat, so the intake never sends a folded crossing to the rules or notifier a second time.
    - **For Task 4:** a caller that wants to know whether the end moved compares `event.endMs` before and after. The return value alone does not say.
    - **Unchanged:** every other type works exactly as before.
  - **Why "within 30 s" is measured between starts, not from the existing event's end:** each event then covers at most 30 s of crossings. If it were measured from the end, a busy road with a car every 20 s would become one endless event with a single alert and a single snapshot.

---

- [ ] **Step 1: Update and add tests in `cctv/test/events.test.mjs`**

Edit 1 (lines 16–20, the import). Find:

```js
const {
  CONTINUOUS_BITS, EVENT_TYPES, MODE_TYPES, TYPE_NAMES,
  eventWindow, eventsForMode, inSchedule, inWindows, isEventMode,
  recordWindows, shouldRecord, typesFromRecordBits
} = await import('../event-rules.mjs')
```

Replace with:

```js
const {
  CONTINUOUS_BITS, EVENT_TYPES, MODE_TYPES, RECORD_TYPE_BITS, TYPE_NAMES,
  eventWindow, eventsForMode, inSchedule, inWindows, isEventMode,
  recordWindows, shouldRecord, typesFromRecordBits
} = await import('../event-rules.mjs')
```

Edit 2 (lines 47–48; the old check only asserted the `tripwire` subtype, not the kind). Find:

```js
  const two = typesFromRecordBits(0x4 | 0x400)
  check('one file can carry two reasons', two.length === 2 && two.some((t) => t.type === 'motion') && two.some((t) => t.subtype === 'tripwire'), JSON.stringify(two))
```

Replace with:

```js
  const two = typesFromRecordBits(0x4 | 0x400)
  check('one file can carry two reasons', two.length === 2 && two.some((t) => t.type === 'motion') && two.some((t) => t.type === 'line-crossing' && t.subtype === 'tripwire'), JSON.stringify(two))
  // The camera's own line-crossing detection is a kind of its own, so a rule can ask for exactly
  // that; the NVR's other intelligent bits stay 'ai'.
  const tripwire = typesFromRecordBits(0x400)
  check('0x400 is a line crossing (tripwire)', tripwire.length === 1 && tripwire[0].type === 'line-crossing' && tripwire[0].subtype === 'tripwire', JSON.stringify(tripwire))
  const crossed = typesFromRecordBits(0x80)
  check('0x80 is a line crossing (line crossed)', crossed.length === 1 && crossed[0].type === 'line-crossing' && crossed[0].subtype === 'line crossed', JSON.stringify(crossed))
  const bothLines = typesFromRecordBits(0x2 | 0x80 | 0x400)
  check('both line bits in one file give two line-crossing rows', bothLines.length === 2 && bothLines.every((t) => t.type === 'line-crossing'), JSON.stringify(bothLines))
  check('area entered (0x800) is still smart detection', typesFromRecordBits(0x800)[0].type === 'ai' && typesFromRecordBits(0x800)[0].subtype === 'area entered')
  check('no smart-detection bit is left with a line subtype', RECORD_TYPE_BITS.every((r) => r.type !== 'ai' || !/line|tripwire/.test(r.subtype)))
```

Edit 3 (line 63). Find:

```js
  check('motion is confirmed', EVENT_TYPES.find((t) => t.type === 'motion')?.confirmed === true)
```

Replace with:

```js
  check('motion is confirmed', EVENT_TYPES.find((t) => t.type === 'motion')?.confirmed === true)
  const line = EVENT_TYPES.find((t) => t.type === 'line-crossing')
  check('line-crossing is a confirmed kind with words for people', line?.confirmed === true && line.label === 'Line crossing', JSON.stringify(line))
  check('... and says where it comes from', /line-crossing/.test(line?.from ?? '') && /0x80/.test(line?.from ?? '') && /0x400/.test(line?.from ?? ''), line?.from)
```

Edit 4 (lines 127–130). Find:

```js
  const mixed = [{ type: 'motion' }, { type: 'ai' }, { type: 'face' }, { type: 'camera-offline' }, { type: 'pos' }]
  check('motion mode takes motion only', eventsForMode(mixed, 'motion').length === 1)
  check('ai mode takes the smart ones', eventsForMode(mixed, 'ai').length === 2, JSON.stringify(eventsForMode(mixed, 'ai')))
  check('ai-or-motion takes all three', eventsForMode(mixed, 'ai-or-motion').length === 3)
```

Replace with:

```js
  const mixed = [{ type: 'motion' }, { type: 'ai' }, { type: 'line-crossing' }, { type: 'face' }, { type: 'camera-offline' }, { type: 'pos' }]
  check('motion mode takes motion only', eventsForMode(mixed, 'motion').length === 1)
  // A crossing was an 'ai' event until it got a kind of its own; the ai modes still record for it.
  check('ai mode takes the smart ones, line crossings included', eventsForMode(mixed, 'ai').length === 3 && eventsForMode(mixed, 'ai').some((e) => e.type === 'line-crossing'), JSON.stringify(eventsForMode(mixed, 'ai')))
  check('ai-or-motion takes all four', eventsForMode(mixed, 'ai-or-motion').length === 4)
```

Edit 5 (a new block before line 357). Find:

```js
// --- the read-only command probe ------------------------------------------------------------------------
```

Replace with:

```js
// --- one crossing, two sources ------------------------------------------------------------------------------
//
// The alarm watcher files a crossing within seconds. Minutes later this intake finds the NVR's
// recording of the same crossing: a few seconds earlier (pre-record), with both line bits. That must
// stay one event, and must not reach the rules (and the phone) a second time. Real store, temp file.
{
  const { addEvent, closeEvents, eventsOfCamera, lastEventMs } = await import('../events-db.mjs')
  const at = T0 + 30 * MIN
  const first = addEvent({ nvr: 'lc1', ch: 2, type: 'line-crossing', subtype: 'tripwire', startMs: at, source: 'alarm-status' }, at)
  check('the alarm watcher’s crossing is stored', first.isNew && first.event.id > 0)
  const seen = []
  const intake = makeEventIntake({
    listNvrs: () => [{ id: 'lc1', name: 'LC', online: true }],
    camerasOf: () => [{ ch: 2 }],
    recordings: async () => ({ events: [[at - 5 * S, at + 40 * S, 0x2 | 0x80 | 0x400]] }),
    onEvent: (e) => seen.push(e),
    now: () => at + 3 * MIN,
    log: () => {},
    store: { addEvent, lastEventMs }
  })
  const r = await intake.tick()
  check('the recording of the same crossing is not a new event', r?.stored === 0 && seen.length === 0, JSON.stringify({ r, seen: seen.length }))
  const rows = eventsOfCamera('lc1', 2, at - MIN, at + MIN)
  check('... the camera still has one row', rows.length === 1, JSON.stringify(rows.map((x) => `${x.type}/${x.subtype}@${x.startMs - at}`)))
  check('... with the alarm’s start and the recording’s end', rows[0]?.startMs === at && rows[0]?.endMs === at + 40 * S, JSON.stringify(rows[0]))
  closeEvents()
}

// --- the read-only command probe ------------------------------------------------------------------------
```

- [ ] **Step 2: Update and add tests in `cctv/test/alarms.test.mjs`**

Edit 1 (lines 22–26, the import). Find:

```js
const {
  acknowledge, addEvent, classify, closeEvents, createRule, deleteRule, eventsOfCamera,
  forgetEventsBefore, getEvent, lastEventMs, listEvents, listRules, unackedEvents,
  unacknowledge, updateRule
} = await import('../events-db.mjs')
```

Replace with:

```js
const {
  MERGE_MS, acknowledge, addEvent, classify, closeEvents, createRule, deleteRule, eventsOfCamera,
  forgetEventsBefore, getEvent, lastEventMs, listEvents, listRules, unackedEvents,
  unacknowledge, updateRule
} = await import('../events-db.mjs')
```

Edit 2 (line 55). Find:

```js
  check('an unconfirmed kind may still be written into a rule', checkRule({ name: 'x', types: ['ai-person'] }).ok)
```

Replace with:

```js
  check('an unconfirmed kind may still be written into a rule', checkRule({ name: 'x', types: ['ai-person'] }).ok)
  check('a rule may name line crossings', checkRule({ name: 'Line crossing', types: ['line-crossing'], priority: 'high', notify: true, minGapS: 30 }).ok)
```

Edit 3 (line 67). Find:

```js
  check('another kind does not', !ruleMatches({ ...all, types: ['ai'] }, ev))
```

Replace with:

```js
  check('another kind does not', !ruleMatches({ ...all, types: ['ai'] }, ev))
  const crossing = { nvr: 'nvr2', ch: 2, type: 'line-crossing', subtype: 'tripwire', startMs: T0 }
  check('a line-crossing rule matches a crossing', ruleMatches({ ...all, types: ['line-crossing'] }, crossing))
  check('... on its own cameras only', !ruleMatches({ ...all, cameras: ['nvr2/3'], types: ['line-crossing'] }, crossing))
  check('... and not motion', !ruleMatches({ ...all, types: ['line-crossing'] }, ev))
  check('a smart-detection rule no longer catches a crossing', !ruleMatches({ ...all, types: ['ai'] }, crossing))
  const told = applyRules([{ ...all, id: 9, types: ['line-crossing'], priority: 'high', notify: true }], crossing)
  check('a crossing under a notifying line rule is high and tells someone', told.priority === 'high' && told.notify === true, JSON.stringify(told))
```

Edit 4 (lines 128–130; the sample tripwire event was `'ai'`). Find:

```js
  const named = nameCameras([{ nvr: 'n', ch: 1, type: 'ai', subtype: 'tripwire', startMs: T0, endMs: T0 + 5 * S }], [{ nvr: 'n', ch: 1, name: 'Yard' }])
  check('a camera gets its name', named[0].camera === 'Yard')
  check('and the kind gets a label', named[0].typeLabel === labelOf('ai'))
```

Replace with:

```js
  const named = nameCameras([{ nvr: 'n', ch: 1, type: 'line-crossing', subtype: 'tripwire', startMs: T0, endMs: T0 + 5 * S }], [{ nvr: 'n', ch: 1, name: 'Yard' }])
  check('a camera gets its name', named[0].camera === 'Yard')
  check('and the kind gets a label', named[0].typeLabel === labelOf('line-crossing') && named[0].typeLabel === 'Line crossing', named[0].typeLabel)
```

Edit 5 (line 141). Find:

```js
  check('its title says what and where', /Yard/.test(msg.title), msg.title)
```

Replace with:

```js
  check('its title says what and where', /Yard/.test(msg.title), msg.title)
  check('... naming a crossing as one', /^Line crossing \(tripwire\)/.test(msg.title), msg.title)
```

Edit 6 (line 162). Find:

```js
  check('a different kind at the same moment is its own event', addEvent({ ...e, type: 'ai', subtype: 'tripwire' }, T0).isNew)
```

Replace with:

```js
  // (a line crossing folds only into another line crossing, never into this motion event)
  check('a different kind at the same moment is its own event', addEvent({ ...e, type: 'line-crossing', subtype: 'tripwire' }, T0).isNew)
```

Edit 7 (line 315). Find:

```js
    { id: 2, camera: 'Yard', type: 'ai', subtype: 'tripwire', priority: 'low', startMs: T0 - MIN, endMs: null, ackMs: T0, ackUser: 'bob', ackNote: 'fox' }
```

Replace with:

```js
    { id: 2, camera: 'Yard', type: 'line-crossing', subtype: 'tripwire', priority: 'low', startMs: T0 - MIN, endMs: null, ackMs: T0, ackUser: 'bob', ackNote: 'fox' }
```

Edit 8 (line 319). Find:

```js
  check('a subtype is shown beside it', /tripwire/.test(rows[1].what), rows[1].what)
```

Replace with:

```js
  check('a subtype is shown beside it', rows[1].what === 'Line crossing (tripwire)', rows[1].what)
```

Edit 9 (lines 340–341). This goes last so it cannot change any earlier count. Find:

```js
closeEvents()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
```

Replace with:

```js
// --- line crossings fold together --------------------------------------------------------------------------
//
// One crossing reaches the store twice: the alarm watcher files it within seconds, and the recording
// list finds the NVR's recording of it minutes later, a few seconds earlier (pre-record) and often
// with both line bits. Somebody walking along a line also crosses it several times in a few seconds.
// A line crossing starting within 30 s of another on the same camera is folded into it; nothing else
// ever is.
{
  check('the fold window is 30 s', MERGE_MS === 30_000, String(MERGE_MS))
  const B = T0 + 500 * MIN
  const lc = (o) => ({ nvr: 'nvr5', ch: 2, type: 'line-crossing', subtype: 'tripwire', source: 'alarm-status', ...o })

  const a = addEvent(lc({ startMs: B }), B)
  check('a first crossing is a new event', a.isNew && a.event.type === 'line-crossing')
  const same = addEvent(lc({ startMs: B }), B + 5 * S)
  check('the same alarm seen again is still one row, with no end made up', !same.isNew && same.event.id === a.event.id && same.event.endMs === null, JSON.stringify(same.event))
  const rec = addEvent(lc({ subtype: 'line crossed', source: 'nvr-recordings', startMs: B - 5 * S, endMs: B + 40 * S }), B + 3 * MIN)
  check('its recording, 5 s earlier and with the other line bit, is folded in', !rec.isNew && rec.event.id === a.event.id, JSON.stringify(rec.event))
  check('... and moves the end out to the recording’s', rec.event.endMs === B + 40 * S, `${rec.event.endMs - B}`)
  check('... keeping the first sighting’s start, subtype and source', rec.event.startMs === B && rec.event.subtype === 'tripwire' && rec.event.source === 'alarm-status', JSON.stringify(rec.event))
  const edge = addEvent(lc({ startMs: B + 30 * S }), B + 4 * MIN)
  check('a crossing exactly 30 s later is still folded in', !edge.isNew && edge.event.id === a.event.id)
  check('... and never pulls the end back', edge.event.endMs === B + 40 * S, `${edge.event.endMs - B}`)

  const later = addEvent(lc({ startMs: B + 31 * S }), B + 4 * MIN)
  check('31 s later is a new event', later.isNew && later.event.id !== a.event.id)
  const between = addEvent(lc({ startMs: B + 45 * S }), B + 4 * MIN)
  check('a crossing near two events joins the nearer one', !between.isNew && between.event.id === later.event.id)
  check('... whose end grows to it', between.event.endMs === B + 45 * S, `${between.event.endMs - B}`)
  check('the camera holds two crossing events, not five', eventsOfCamera('nvr5', 2, B - MIN, B + MIN).length === 2)

  // Somebody already looked at it: its recording turning up later must not make a fresh alarm.
  acknowledge(a.event.id, 'bob', 'a walker', B + 5 * MIN)
  const afterAck = addEvent(lc({ subtype: 'line crossed', source: 'nvr-recordings', startMs: B + 2 * S, endMs: B + 50 * S }), B + 6 * MIN)
  check('an acknowledged crossing still takes its recording', !afterAck.isNew && afterAck.event.id === a.event.id && afterAck.event.ackNote === 'a walker' && afterAck.event.endMs === B + 50 * S)

  // Nothing else folds: other kinds, other cameras, other NVRs.
  const m1 = addEvent({ nvr: 'nvr5', ch: 2, type: 'motion', startMs: B + 2 * S, source: 'x' }, B + 6 * MIN)
  const m2 = addEvent({ nvr: 'nvr5', ch: 2, type: 'motion', startMs: B + 4 * S, source: 'x' }, B + 6 * MIN)
  check('motion beside a crossing is its own event', m1.isNew)
  check('motion never folds into motion', m2.isNew && m2.event.id !== m1.event.id)
  const mot = addEvent({ nvr: 'nvr5', ch: 3, type: 'motion', startMs: B, source: 'x' }, B + 6 * MIN)
  const lone = addEvent(lc({ ch: 3, startMs: B + 5 * S }), B + 6 * MIN)
  check('a crossing beside only a motion event is its own event', lone.isNew && lone.event.id !== mot.event.id)
  check('... and the motion event is left alone', getEvent(mot.event.id).endMs === null && getEvent(mot.event.id).type === 'motion')
  check('a crossing on another camera is its own event', addEvent(lc({ ch: 4, startMs: B + S }), B + 6 * MIN).isNew)
  check('... and on another NVR', addEvent(lc({ nvr: 'nvr6', startMs: B + S }), B + 6 * MIN).isNew)
}

closeEvents()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
```

- [ ] **Step 3: Run both tests (they run locally) and confirm they fail**

From the repo root:

```
node cctv/test/events.test.mjs
node cctv/test/alarms.test.mjs
```

Expected: each exits 1.
- `events.test.mjs` ends with `12 FAILED`. Among them:
  - `FAIL  0x400 is a line crossing (tripwire)  ([{"type":"ai","subtype":"tripwire"}])`
  - `FAIL  line-crossing is a confirmed kind with words for people`
  - `FAIL  ai-or-motion takes all four`
  - `FAIL  the recording of the same crossing is not a new event  ({"r":{"nvr":"lc1","ch":2,"stored":2},"seen":2})`
- `alarms.test.mjs` ends with `13 FAILED`. Among them:
  - `FAIL  a rule may name line crossings`
  - `FAIL  and the kind gets a label  (line-crossing)`
  - `FAIL  the fold window is 30 s  (undefined)`
  - `FAIL  its recording, 5 s earlier and with the other line bit, is folded in`
  - `FAIL  a crossing exactly 30 s later is still folded in`

- [ ] **Step 4: Add the kind in `cctv/public/alarms-view.js`**

Line 33. Find:

```js
  { type: 'ai', label: 'Smart detection', confirmed: true },
```

Replace with:

```js
  { type: 'ai', label: 'Smart detection', confirmed: true },
  // The camera's own line-crossing detection. A kind of its own rather than one more 'ai' subtype,
  // so the "Line crossing" alarm rule can ask for exactly this and nothing else the camera's AI does.
  { type: 'line-crossing', label: 'Line crossing', confirmed: true },
```

- [ ] **Step 5: Remap the bits, add `FROM`, and keep the ai recording modes in `cctv/event-rules.mjs`**

Edit 1 (line 32). Find:

```js
  ai: 'the NVR’s intelligent recordings (tripwire, intrusion, object, exception)',
```

Replace with:

```js
  ai: 'the NVR’s intelligent recordings (area entered, object left or taken, exception, overspeed, behaviour)',
  'line-crossing': 'the camera’s own line-crossing detection (NVR alarm status; recordings 0x80/0x400)',
```

Edit 2 (line 73). Find:

```js
  { bit: 0x0080, type: 'ai', subtype: 'line crossed' },
```

Replace with:

```js
  // The two line bits are the camera's own line-crossing detection, which has a kind of its own:
  // the alarm watcher (alarm-watch.mjs) files the same crossings under it within seconds, and
  // events-db.mjs folds the recording's rows into that event (MERGE_MS).
  { bit: 0x0080, type: 'line-crossing', subtype: 'line crossed' },
```

Edit 3 (line 76). Find:

```js
  { bit: 0x0400, type: 'ai', subtype: 'tripwire' },
```

Replace with:

```js
  { bit: 0x0400, type: 'line-crossing', subtype: 'tripwire' },
```

Edit 4 (lines 320–322, inside `MODE_TYPES`). Find:

```js
  motion: ['motion'],
  ai: ['ai', 'face'],
  'ai-or-motion': ['ai', 'face', 'motion']
```

Replace with:

```js
  motion: ['motion'],
  // A line crossing was an 'ai' event until it got a kind of its own; a camera that records on
  // smart detections must still open a window when something crosses its line.
  ai: ['ai', 'line-crossing', 'face'],
  'ai-or-motion': ['ai', 'line-crossing', 'face', 'motion']
```

- [ ] **Step 6: Add the 30 s fold to `cctv/events-db.mjs`**

Edit 1 (lines 21–22). Find:

```js
/** One page of results. A guard against a runaway query, not a paging scheme. */
export const MAX_RESULTS = 1000
```

Replace with:

```js
/** One page of results. A guard against a runaway query, not a paging scheme. */
export const MAX_RESULTS = 1000
/**
 * Line crossings on one camera starting closer together than this are one event. One crossing
 * reaches us twice: the alarm watcher (alarm-watch.mjs) sees the camera's alarm within seconds, and
 * the recording-list intake (events.mjs) finds the NVR's recording of it minutes later, starting a
 * few seconds earlier because of the NVR's pre-record and often carrying both line bits (0x80 and
 * 0x400). Somebody walking along a line also crosses it several times in a few seconds. Folding
 * these keeps one row, one phone alert and one snapshot per crossing instead of three or four.
 */
export const MERGE_MS = 30_000
/** The only kind that is folded; every other kind keeps one row per thing the NVR reported. */
const MERGED_TYPE = 'line-crossing'
```

Edit 2 (line 46, inside `open()`'s `q = { ... }`). Find:

```js
    find: db.prepare(`SELECT ${EV_COLS} FROM events WHERE nvr = ? AND ch = ? AND type = ? AND subtype = ? AND start_ms = ?`),
```

Replace with:

```js
    find: db.prepare(`SELECT ${EV_COLS} FROM events WHERE nvr = ? AND ch = ? AND type = ? AND subtype = ? AND start_ms = ?`),
    // The event of one kind on one camera whose start is nearest a given time, inside a window
    // (addEvent's folding of line crossings). Any subtype: the two line bits are the same crossing.
    // Served by events_cam (nvr, ch, start_ms).
    nearest: db.prepare(`SELECT ${EV_COLS} FROM events WHERE nvr = ? AND ch = ? AND type = ? AND start_ms >= ? AND start_ms <= ?
      ORDER BY ABS(start_ms - ?), start_ms, id LIMIT 1`),
```

Edit 3 (lines 123–134, the section header up to the first statement of `addEvent`). Find:

```js
// ---- events ------------------------------------------------------------------------------------

/**
 * Records one event, or returns the row already there.
 * @param {{nvr, ch, type, subtype?, startMs, endMs?, source?, detail?, priority?, ruleId?, ruleName?}} e
 * @returns {{ event: object, isNew: boolean }}
 */
export function addEvent(e, nowMs = Date.now()) {
  const s = open()
  const subtype = String(e.subtype ?? '')
  const start = Math.round(Number(e.startMs))
  const res = s.add.run(
```

Replace with:

```js
// ---- events ------------------------------------------------------------------------------------

/**
 * Folds a line crossing into the line-crossing event of the same camera whose start is nearest its
 * own, if that is within MERGE_MS either side. Returns what addEvent returns, or null when there is
 * none and the crossing is stored as a row of its own.
 *
 * An acknowledged event takes its later sightings too. The usual case is the recording list finding,
 * minutes later, a crossing somebody has already looked at; storing that as a fresh alarm would ring
 * the phone again for something already dealt with.
 */
function foldCrossing(s, e, start) {
  const near = plain(s.nearest.get(String(e.nvr), Number(e.ch), MERGED_TYPE, start - MERGE_MS, start + MERGE_MS, start))
  if (!near) return null
  // null and undefined mean "no end yet": Number(null) is 0, which is 1970 rather than an end
  const endIn = e.endMs === null || e.endMs === undefined ? NaN : Number(e.endMs)
  const reach = Math.round(Math.max(start, Number.isFinite(endIn) ? endIn : start))
  const held = Math.max(near.startMs, Number.isFinite(near.endMs) ? near.endMs : near.startMs)
  // Only the end moves. The start is the row's identity (the unique key) and the moment the snapshot
  // and the bookmark are taken around; it is usually the alarm's own time, which is nearer the
  // crossing than the recording's pre-record start.
  if (reach > held) s.extend.run(reach, near.id, reach)
  return { event: plain(s.byId.get(near.id)), isNew: false }
}

/**
 * Records one event, or returns the row already there.
 * A line crossing within MERGE_MS of another on the same camera is folded into that one instead (its
 * end moved out, isNew false), so every caller treats it like an event it already had.
 * @param {{nvr, ch, type, subtype?, startMs, endMs?, source?, detail?, priority?, ruleId?, ruleName?}} e
 * @returns {{ event: object, isNew: boolean }}
 */
export function addEvent(e, nowMs = Date.now()) {
  const s = open()
  const subtype = String(e.subtype ?? '')
  const start = Math.round(Number(e.startMs))
  if (String(e.type) === MERGED_TYPE && Number.isFinite(start)) {
    const folded = foldCrossing(s, e, start)
    if (folded) return folded
  }
  const res = s.add.run(
```

The rest of `addEvent` stays as it is: the INSERT OR IGNORE, the `find`, the same-key extend and the return.

A repeat of the exact same crossing (same key) is now caught by the fold at distance 0. The result is the same as before: `{ event: <row>, isNew: false }`, and no end is invented when none was given.

- [ ] **Step 7: Run both tests again (locally) and confirm they pass**

From the repo root:

```
node cctv/test/events.test.mjs
node cctv/test/alarms.test.mjs
```

Expected: both end with `all passed` and exit 0. There are no `FAIL` lines; `events.test.mjs` prints 187 `PASS` lines.

- [ ] **Step 8: Commit**

```
git add cctv/public/alarms-view.js cctv/event-rules.mjs cctv/events-db.mjs cctv/test/events.test.mjs cctv/test/alarms.test.mjs
git commit -m "line-crossing: own event kind, record bits 0x80/0x400, 30 s fold in addEvent" -m "Adds the 'line-crossing' kind (confirmed) to alarms-view.js EVENT_KINDS and maps the NVR's line bits 0x80 ('line crossed') and 0x400 ('tripwire') to it instead of 'ai'; the ai recording modes keep recording for crossings. events-db addEvent folds a line crossing into the same camera's line-crossing event whose start is within MERGE_MS (30 s), extending its end, so the alarm watcher's event and the NVR recording of the same crossing stay one row and one alert. Other kinds never fold." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Alarm watch: line crossings from the NVR's live alarm list

> **Cross-task corrections (binding - apply these where the steps below differ):**
>
> 1. Step 8 builds Task 6's readerFor as an UNOPENED SegmentReader. rec-reader.mjs SegmentReader only reads its .idx in open(); before that, times=[] and fh=null. Task 6's findKeyframe calls keyAtOrAfter(r.times, t), which gives -1 on every look, so takeSnapshot never finds a keyframe: it waits 3 min on an open file, or answers 'none' on a closed one. No snapshot is ever taken. Task 6's own notes and Task 5 both expect `takeSnapshot(e, { index: recIndex() })`, which uses Task 6's default readerFor (openReader, which calls .open()).
>
>    **Fix:** In Task 4 Step 8, remove `, { SegmentReader }` from the destructuring and `, import('./rec-reader.mjs')` from the Promise.all. Replace the snapshot helper body with:
> ```js
>   // readerFor is left to event-snapshot.mjs: its default opens the reader (SegmentReader.open()), which
>   // reads the .idx; an unopened reader has no keyframe times and no picture would ever be taken
>   const snapshot = (event) => {
>     const index = recIndex()
>     // no recordings index here (no live worker, or it could not be opened): nothing to take a picture from
>     return index ? takeSnapshot(event, { index }) : Promise.resolve(null)
>   }
> ```
> In Task 4 Interfaces > Consumes, delete the `cctv/rec-reader.mjs` bullet. Change the Task 6 bullet to: "Task 6: `takeSnapshot(event, { index }) -> Promise<path|null>` from `cctv/event-snapshot.mjs`; readerFor is left to its default, which opens a SegmentReader." In "Notes for the plan assembler", delete the sentence "It builds Task 6's `readerFor(seg)` as a new, unopened `SegmentReader`...".
>
> 2. Step 8 calls `onLineCrossing(event, { bookmark: bookmarks, snapshot })` with `bookmark` set to the bookmarks.mjs module namespace. Task 5's onLineCrossing expects `bookmark` to be a function `(event, opts) => Promise<{ ok, bookmark, merged }>` (default autoBookmark) and calls `bookmark(event, { nameOf, log })`. That throws `TypeError: bookmark is not a function` on every crossing, which is only logged ('[lines] ...: bookmark failed'), so no automatic bookmark is ever made. Task 5 documents the call site as `onLineCrossing(row, { snapshot, nameOf })`. `nameOf` is also not passed, so bookmark titles read 'Line crossing — nvr-2/2' rather than the camera's name.
>
>    **Fix:** In Task 4 Step 8, remove `bookmarks, ` from the destructuring and `import('./bookmarks.mjs'), ` from the Promise.all. After the snapshot helper, add:
> ```js
>   const nameOf = (key) => allCameras().find((c) => `${c.nvr}/${c.ch}` === key)?.name ?? key
> ```
> Change the call to:
> ```js
>           void onLineCrossing(event, { snapshot, nameOf }).catch((e) => console.warn(`[lines] ${e.message}`))
> ```
> (bookmark is left to its default autoBookmark, which loads bookmarks.mjs itself). In Interfaces > Consumes, delete the `cctv/bookmarks.mjs` bullet. Change the Task 5 bullet to: "This task passes `{ snapshot, nameOf }`; `bookmark` is left to its default `autoBookmark`." In the assembler notes, replace "Step 8 passes `bookmark` as the `bookmarks.mjs` namespace and" with "Step 8 passes `nameOf` and".
>
> 3. Task 5 documents onLineCrossing as 'called for a new event and again each time the same event grows'. Its autoBookmark stretches the bookmark to the event's end + 60 s. But Task 4's crossingHandler returns null for `again` ticks and for a same-start row without calling anything, so the bookmark never follows a long alarm. If the NVR keeps one tripwire alarm listed for minutes (repeated crossings), the event's end grows every 5 s but the footage after start+60 s is never bookmarked (not protected from thinning).
>
>    **Fix:** In Task 4 Step 3, replace crossingHandler with:
> ```js
> export function crossingHandler({ addEvent, handle, grew = null, now = Date.now }) {
>   return (e) => {
>     const { again, ...row } = e
>     const { event, isNew } = addEvent({ ...row, detail: CROSSING_DETAIL }, now())
>     if (!event) return null
>     // the same alarm still listed (or already stored): its end has moved on, so its bookmark may grow
>     if (again || (!isNew && event.startMs === row.startMs)) {
>       grew?.(event)
>       return null
>     }
>     handle(event)
>     return event
>   }
> }
> ```
> Add `@param` text for `grew` ("called with the stored row when a known alarm is seen again; not for the rules or the notifier"). In Step 8, pass `grew: (event) => void onLineCrossing(event, { snapshot, nameOf }).catch((e) => console.warn(`[lines] ${e.message}`)),` beside `addEvent` in the crossingHandler call. The existing crossingHandler checks are unchanged, because `grew` defaults to null.
>
> 4. Step 4 expects '43 `PASS` lines', but the drafted alarm-watch.test.mjs has 39 check() calls. Running the drafter's scratch copy (plan-scratch/t4) prints 39 PASS and 'all passed'.
>
>    **Fix:** In Task 4 Step 4, replace "Expected: 43 `PASS` lines, no `FAIL`" with "Expected: 39 `PASS` lines, no `FAIL`".
>
> 5. Spec gap: line-crossing events first filed by the recording-list intake (record bits 0x80/0x400) go through nvrs.mjs startEvents onEvent, which only calls notifier.handle, so they get no automatic bookmark and no snapshot.
>
>    **Fix:** In Step 8, have the intake onEvent in nvrs.mjs startEvents also call `onLineCrossing(event, { snapshot, nameOf })` for events whose type is line-crossing (onLineCrossing ignores other types), loaded non-fatally the same way as startLineWatch (a failed import logs one warning and the intake carries on). Add a check to the Step 8 source-shape test that the intake onEvent calls onLineCrossing.


**Files:**
- Create: `cctv/alarm-watch.mjs` (pure: it imports only `xml.mjs` and `nvr-log.mjs`, never `sdk.mjs` or `nvr-xml.mjs`)
- Create: `cctv/test/alarm-watch.test.mjs`
- Modify: `cctv/nvrs.mjs`, in three places:
  - line 23: the `nvr-xml.mjs` import
  - lines 1057-1068: after the `makeEventIntake({...})` call in `startEvents()`
  - line 1097: a new function just before `export const startNvrs = () => {`
  - This file is checked out with CRLF line endings. Match the anchor text, not the line endings.
- Test: `cctv/test/alarm-watch.test.mjs` runs **locally** (`node cctv/test/alarm-watch.test.mjs` from the repo root). It reads `cctv/test/fixtures/lines/alarmstatus.xml`, which Task 1 copies there.
- `cctv/nvrs.mjs` loads koffi/SDK, so it can only be syntax-checked locally (`node --check`). The running wiring must be checked on the server: see Task 8 Step 1.

**Interfaces:**

Consumes (existing code, checked in the files):
- `cctv/xml.mjs`:
  - `parseXml(xml) -> { name, attrs, children, text }`
  - `kid(node, name)`
  - `kids(node, name) -> []`
  - `XML_HEADER` (also re-exported by `nvr-xml.mjs`)
- `cctv/nvr-log.mjs` (pure, imports only `xml.mjs`):
  - `chOfGuid(id) -> number|null`. This is `nvr-xml.mjs` `chlIdOf` in reverse: `{0000001E-…}` gives 29.
  - `parseUtcText('YYYY-MM-DD HH:MM:SS') -> ms (UTC) | null`
- `cctv/nvr-xml.mjs` (only in `nvrs.mjs`): `transparent(nvr, url, xml, tag, { gen, outBytes } = {}) -> Promise<string>`
- `cctv/events-db.mjs`: `addEvent(e, nowMs = Date.now()) -> { event, isNew }`. After Task 3, a line-crossing that starts within 30 s of that camera's previous line-crossing returns the earlier row, extended, with `isNew: false`.
- `cctv/alarms.mjs`: `makeAlarmNotifier(...)` returns `{ handle(event) -> Promise<row> }`. This is the `notifier` already built in `startEvents()`. It never sends one event twice (`notifiedMs`).
- `cctv/sdk.mjs`: `lateCalls()` (already imported in `nvrs.mjs`).
- `cctv/nvrs.mjs`:
  - `recIndex() -> index | null`
  - the `nvrs` Map
  - Nvr fields `id`, `name`, `online`, `degraded`, `stopped`
- `cctv/bookmarks.mjs`: the module namespace (`createBookmark`, `updateBookmark`, `listBookmarks`), passed whole as Task 5's `bookmark` dependency.
- `cctv/rec-reader.mjs`: `new SegmentReader({ path, endMs = null, growing = false })`, built from an index segment `{ path, endMs, open }` the same way `rec-playback.mjs` builds it.
- Task 2: `linesOn() -> Set<'<nvrId>/<ch>'>` from `cctv/tripwire.mjs`.
- Task 5: `onLineCrossing(event, { bookmark, snapshot }) -> Promise<void>` from `cctv/line-actions.mjs`. This task passes:
  - `bookmark` = the `bookmarks.mjs` namespace
  - `snapshot` = `(event) => Promise<string|null>`
- Task 6: `takeSnapshot(event, { index, readerFor }) -> Promise<path|null>` from `cctv/event-snapshot.mjs`. `readerFor(seg)` returns a new SegmentReader that has not been opened yet.

Produces (contract names, plus the optional additions noted):
- `export const WATCH_EVERY_MS = 5000`
- `export const FAIL_LOG_MS = 600_000`
- `export const SOURCE_ALARM_STATUS = 'alarm-status'`
- `export function parseAlarmStatus(xml) -> [{ kind, chlId, ch, startMs }]`
  - Reads `content>intelligents>item` only.
  - Throws on a missing document or a non-`success` status.
- `export function startAlarmWatch({ nvrs, linesOn, query, onCrossing, everyMs = WATCH_EVERY_MS, log = console.log, now = Date.now, sdkBusy = () => false }) -> { stop(), tick() -> Promise<string[] asked nvr ids> }`
  - `now` and `sdkBusy` are optional additions to the contract.
  - `onCrossing` receives the contract's event plus two fields: `{ nvr, ch, type: 'line-crossing', subtype: 'tripwire', startMs, endMs, source: 'alarm-status', again }`.
- `export function crossingHandler({ addEvent, handle, now = Date.now }) -> (e) => event|null`
  - This is the "if new or extended" decision, written as a pure function so it can be tested.
- Stored row: `{ nvr, ch, type: 'line-crossing', subtype: 'tripwire', startMs, endMs, source: 'alarm-status', detail }`.

Order note: `startLineWatch` in `nvrs.mjs` loads `tripwire.mjs` (Task 2), `line-actions.mjs` (Task 5) and `event-snapshot.mjs` (Task 6) with dynamic imports, and a failure there is only logged. Committing this task before Tasks 5 and 6 exist is therefore harmless: until then the server logs one `[alarm-watch] not started: Cannot find module …` line at start and runs as before.

- [ ] **Step 1: Write the failing test**

Create `cctv/test/alarm-watch.test.mjs`:

```js
// The cameras' own line-crossing alarms, read from each NVR's live alarm list (alarm-watch.mjs):
// parsing queryAlarmStatus (the answer captured from nvr-2 on 2026-09-27, which lists nine motion
// alarms and no AI alarm, plus AI items written here in the shape nvr-2's web client reads them), the
// watcher's manners (which NVRs it asks, never two queries at once to one NVR, a failing NVR logged
// once per 10 min) and what the server does with each report (crossingHandler).
// Pure: fake NVRs, a fake query, a fake clock and a fake store; no SDK, no network.
//   node cctv/test/alarm-watch.test.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAIL_LOG_MS, SOURCE_ALARM_STATUS, WATCH_EVERY_MS, crossingHandler, parseAlarmStatus, startAlarmWatch } from '../alarm-watch.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const sameFields = (got, want) => Boolean(got) && Object.keys(got).length === Object.keys(want).length && Object.keys(want).every((k) => got[k] === want[k])
const settle = () => new Promise((r) => setImmediate(r))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const captured = readFileSync(join(import.meta.dirname, 'fixtures', 'lines', 'alarmstatus.xml'), 'utf8')
const guid = (ch) => `{${(ch + 1).toString(16).toUpperCase().padStart(8, '0')}-0000-0000-0000-000000000000}`
// One active AI alarm, with the elements nvr-2's web client reads (viewAlarmStatus.js). Its recorded
// channel is another camera on purpose: the camera that alarmed is sourceChl, never a recorded one.
const aiItem = (type, ch, time, name = `Camera ${ch + 1}`) =>
  `<item><sourceChl id="${guid(ch)}">${name}</sourceChl><triggerRecChls type="list"><itemType></itemType>` +
  `<item id="${guid(ch + 5)}">Another camera</item></triggerRecChls><intelligentType>${type}</intelligentType>` +
  `<alarmTime>${time}</alarmTime><triggerAlarmOutNames></triggerAlarmOutNames><buzzerSwitch>false</buzzerSwitch>` +
  `<popMsgSwitch>false</popMsgSwitch><triggerPresetNames></triggerPresetNames><ftpRecSwitch>false</ftpRecSwitch>` +
  `<snapSwitch>false</snapSwitch><ftpSnapSwitch>false</ftpSnapSwitch><popVideoSwitch>false</popVideoSwitch>` +
  `<emailSwitch>false</emailSwitch></item>`
const LIST_OPEN = '<intelligents type="list">'
const withAi = (...items) => captured.replace(LIST_OPEN, LIST_OPEN + items.join(''))

// ---- parsing -------------------------------------------------------------------------------------

check('the captured answer has the AI list and nine motion alarms (one on Maingate Roadway)',
  captured.includes(LIST_OPEN) && captured.split('<sourceChl ').length - 1 === 9 && captured.includes('<sourceChl id="{00000003-0000-0000-0000-000000000000}">Maingate Roadway'))
check('motion alarms are not AI alarms: the captured answer gives none', parseAlarmStatus(captured).length === 0)

const START = Date.UTC(2026, 8, 28, 0, 7, 30) // 2026-09-28 00:07:30 UTC
const TRIP = aiItem('tripwire', 2, '2026-09-28 00:07:30', 'Maingate Roadway')
{
  const got = parseAlarmStatus(withAi(TRIP, aiItem('pea', 29, '2026-09-28 00:05:00', 'JP Wharf North')))
  check('each AI alarm is read: kind, camera id, 0-based channel, start',
    got.length === 2 && sameFields(got[0], { kind: 'tripwire', chlId: '{00000003-0000-0000-0000-000000000000}', ch: 2, startMs: START }), JSON.stringify(got))
  check('... channel ids in hex: {0000001E-...} is channel index 29', sameFields(got[1], { kind: 'pea', chlId: '{0000001E-0000-0000-0000-000000000000}', ch: 29, startMs: Date.UTC(2026, 8, 28, 0, 5, 0) }), JSON.stringify(got[1]))
  check('alarmTime is UTC, whatever this machine’s time zone', new Date(got[0].startMs).toISOString() === '2026-09-28T00:07:30.000Z')
}
{
  const noCamera = aiItem('tripwire', 2, '2026-09-28 00:07:30').replace(`<sourceChl id="${guid(2)}">`, '<sourceChl id="">')
  const noTime = aiItem('tripwire', 3, 'soon')
  const noKind = aiItem('', 4, '2026-09-28 00:07:30')
  const got = parseAlarmStatus(withAi(noCamera, noTime, noKind, aiItem('tripwire', 5, '2026-09-28 00:07:31')))
  check('an item whose camera, time or kind cannot be read is left out, not guessed', got.length === 1 && got[0].ch === 5, JSON.stringify(got))
}
{
  let why = ''
  try {
    parseAlarmStatus('<?xml version="1.0" encoding="UTF-8"?><response><status>fail</status><errorCode>536870947</errorCode></response>')
  } catch (e) {
    why = e.message
  }
  check('a refusal is an error, with its code', /refused queryAlarmStatus \(fail, code 536870947\)/.test(why), why)
  let empty = ''
  try {
    parseAlarmStatus('')
  } catch (e) {
    empty = e.message
  }
  check('... and so is an empty answer', /did not answer with a document/.test(empty), empty)
}

// ---- the watcher ---------------------------------------------------------------------------------

let t = START + 2000
const now = () => t

/** A watcher whose timer never fires during the test (the test calls tick itself). */
function watcher({ nvrList, lines, answer, ...more }) {
  const calls = []
  const crossings = []
  const logs = []
  const w = startAlarmWatch({
    nvrs: () => nvrList,
    linesOn: () => new Set(lines),
    query: async (nvr) => {
      calls.push(nvr.id)
      return typeof answer === 'function' ? answer(nvr) : answer
    },
    onCrossing: (e) => crossings.push(e),
    everyMs: 3_600_000,
    log: (l) => logs.push(l),
    now,
    ...more
  })
  return { w, calls, crossings, logs }
}

{
  const nvrList = [
    { id: 'nvr-2', name: 'NVR 2', online: true },
    { id: 'nvr-1', name: 'NVR 1', online: true }, // only a malformed key: no lines
    { id: 'nvr-3', name: 'NVR 3', online: false }, // lines, offline
    { id: 'nvr-4', name: 'NVR 4', online: true, degraded: true }, // lines, recovering
    { id: 'nvr-7', name: 'NVR 7', online: true } // no lines at all
  ]
  const answer = withAi(TRIP, aiItem('pea', 2, '2026-09-28 00:07:31'), aiItem('tripwire', 29, '2026-09-28 00:07:20'))
  const { w, calls, crossings } = watcher({ nvrList, lines: ['nvr-2/2', 'nvr-3/0', 'nvr-4/1', 'nvr-1/x', 'junk', '/4'], answer })
  const asked = await w.tick()
  check('only online, not recovering NVRs with a camera with lines on are asked', JSON.stringify(calls) === '["nvr-2"]' && JSON.stringify(asked) === '["nvr-2"]', JSON.stringify(calls))
  check('a tripwire alarm on a camera with lines is reported as a line crossing (UTC start, 0-based channel)',
    crossings.length === 1 && sameFields(crossings[0], { nvr: 'nvr-2', ch: 2, type: 'line-crossing', subtype: 'tripwire', startMs: START, endMs: START, source: SOURCE_ALARM_STATUS, again: false }), JSON.stringify(crossings))
  check('... not a pea alarm on that camera, nor a tripwire alarm on a camera without lines, nor any motion alarm', crossings.every((c) => c.ch === 2 && c.subtype === 'tripwire'))
  t += WATCH_EVERY_MS
  await w.tick()
  check('listed again next tick: the same alarm (again), its end moved on by this server’s clock',
    crossings.length === 2 && crossings[1].again === true && crossings[1].startMs === START && crossings[1].endMs === START + WATCH_EVERY_MS, JSON.stringify(crossings[1]))
  w.stop()
}

{
  let answer = captured
  const { w, crossings } = watcher({ nvrList: [{ id: 'nvr-2', online: true }], lines: ['nvr-2/2'], answer: () => answer })
  await w.tick()
  check('Maingate Roadway’s motion alarm is not a crossing', crossings.length === 0)
  answer = withAi(TRIP, TRIP)
  await w.tick()
  check('an alarm listed twice in one answer is one crossing', crossings.length === 1 && crossings[0].again === false)
  answer = captured
  t += WATCH_EVERY_MS
  await w.tick()
  answer = withAi(aiItem('tripwire', 2, '2026-09-28 00:08:10'))
  t += WATCH_EVERY_MS
  await w.tick()
  check('after the alarm ends, the next one is new', crossings.length === 2 && crossings[1].again === false && crossings[1].startMs === Date.UTC(2026, 8, 28, 0, 8, 10))
  w.stop()
}

{
  // nvr-2's first answer is held back; nvr-5 answers at once
  let release = null
  const calls = []
  const w = startAlarmWatch({
    nvrs: () => [{ id: 'nvr-2', online: true }, { id: 'nvr-5', online: true }],
    linesOn: () => new Set(['nvr-2/2', 'nvr-5/0']),
    query: (nvr) => {
      calls.push(nvr.id)
      return nvr.id === 'nvr-2' && !release ? new Promise((r) => (release = r)) : Promise.resolve(captured)
    },
    onCrossing: () => {},
    everyMs: 3_600_000,
    log: () => {},
    now
  })
  const first = w.tick()
  await settle()
  await w.tick()
  await w.tick()
  const n = (id) => calls.filter((c) => c === id).length
  check('an NVR whose last query has not come back is not asked again', n('nvr-2') === 1, JSON.stringify(calls))
  check('... while the other NVR is asked every tick', n('nvr-5') === 3, JSON.stringify(calls))
  release(withAi(TRIP))
  await first
  await w.tick()
  check('once it has answered it is asked again', n('nvr-2') === 2, JSON.stringify(calls))
  w.stop()
}

{
  let fail = false
  const { w, calls, crossings, logs } = watcher({
    nvrList: [{ id: 'nvr-2', online: true }, { id: 'nvr-6', online: true }],
    lines: ['nvr-2/2', 'nvr-6/0'],
    answer: (nvr) => {
      if (fail && nvr.id === 'nvr-2') throw new Error('Too many NVR settings requests at once (10 waiting); nothing was sent. Try again shortly')
      return withAi(TRIP)
    }
  })
  await w.tick()
  check('before the failure: one crossing', crossings.length === 1 && crossings[0].again === false)
  fail = true
  const t0 = t
  await w.tick()
  const mine = () => logs.filter((l) => l.includes('nvr-2'))
  check('a failed query is logged, naming the NVR and the reason', mine().length === 1 && mine()[0].includes('Too many NVR settings requests'), JSON.stringify(logs))
  for (let i = 0; i < 20; i++) {
    t += WATCH_EVERY_MS
    await w.tick()
  }
  check('... not again for the next 20 failing ticks', mine().length === 1, JSON.stringify(logs))
  check('... which were still tried (a failure only skips that tick)', calls.filter((c) => c === 'nvr-2').length === 22)
  check('... and the other NVR was not held up', calls.filter((c) => c === 'nvr-6').length === 22 && logs.every((l) => !l.includes('nvr-6')))
  t = t0 + FAIL_LOG_MS
  await w.tick()
  check('... logged again once FAIL_LOG_MS (10 min) has passed', mine().length === 2 && FAIL_LOG_MS === 600_000)
  fail = false
  t += WATCH_EVERY_MS
  await w.tick()
  check('answering again is logged once', mine().length === 3 && /answers again \(after 22 failed reads\)/.test(mine()[2]), mine()[2])
  check('an alarm listed across the failure is still the same alarm, not a new one', crossings.length === 2 && crossings[1].again === true && crossings[1].startMs === START)
  fail = true
  t += WATCH_EVERY_MS
  await w.tick()
  fail = false
  t += WATCH_EVERY_MS
  await w.tick()
  check('a failure soon after is not logged (nor its recovery): the 10 min apply per NVR, not per failure', mine().length === 3, JSON.stringify(mine()))
  w.stop()
}

{
  let busy = true
  const { w, calls } = watcher({ nvrList: [{ id: 'nvr-2', online: true }], lines: ['nvr-2/2'], answer: withAi(TRIP), sdkBusy: () => busy })
  await w.tick()
  check('nobody is asked while an SDK call is overdue', calls.length === 0)
  busy = false
  await w.tick()
  check('... and asked again once it is not', calls.length === 1)
  w.stop()
}

{
  const { w, crossings, logs } = watcher({
    nvrList: [{ id: 'nvr-2', online: true }],
    lines: ['nvr-2/2', 'nvr-2/3'],
    answer: withAi(TRIP, aiItem('tripwire', 3, '2026-09-28 00:07:31')),
    onCrossing: (e) => {
      if (e.ch === 2) throw new Error('database is locked')
      crossings.push(e)
    }
  })
  await w.tick()
  check('a crossing that cannot be filed is logged and the others still are', crossings.length === 1 && crossings[0].ch === 3 && logs.some((l) => l.includes('nvr-2/2') && l.includes('database is locked')), JSON.stringify(logs))
  w.stop()
}

{
  let release = null
  const calls = []
  const crossings = []
  const w = startAlarmWatch({
    nvrs: () => [{ id: 'nvr-2', online: true }],
    linesOn: () => new Set(['nvr-2/2']),
    query: (nvr) => {
      calls.push(nvr.id)
      return new Promise((r) => (release = r))
    },
    onCrossing: (e) => crossings.push(e),
    everyMs: 3_600_000,
    log: () => {},
    now
  })
  const pending = w.tick()
  w.stop()
  release(withAi(TRIP))
  await pending
  check('an answer that comes back after stop() is dropped', crossings.length === 0)
  await w.tick()
  check('... and a stopped watcher asks nothing', calls.length === 1)
}

{
  const calls = []
  const w = startAlarmWatch({
    nvrs: () => [{ id: 'nvr-2', online: true }],
    linesOn: () => new Set(['nvr-2/2']),
    query: async (nvr) => {
      calls.push(nvr.id)
      return captured
    },
    onCrossing: () => {},
    everyMs: 20,
    log: () => {}
  })
  await wait(200)
  const seen = calls.length
  w.stop()
  await wait(80)
  check('the timer ticks on its own every everyMs, and stop() ends it', seen >= 2 && calls.length === seen, `${seen} then ${calls.length}`)
}

// ---- what the server does with a report ------------------------------------------------------------

{
  const stored = []
  const handled = []
  let answer = null
  const store = {
    addEvent: (row, nowMs) => {
      stored.push({ row, nowMs })
      return answer(row)
    }
  }
  const onCrossing = crossingHandler({ ...store, handle: (ev) => handled.push(ev), now: () => 1234 })
  const report = { nvr: 'nvr-2', ch: 2, type: 'line-crossing', subtype: 'tripwire', startMs: START, endMs: START, source: SOURCE_ALARM_STATUS, again: false }

  answer = (row) => ({ event: { id: 7, ...row }, isNew: true })
  check('a new crossing is stored and handled', onCrossing(report)?.id === 7 && handled.length === 1 && handled[0].id === 7)
  check('... stored without the watcher’s again flag, with a detail, at the given time',
    !('again' in stored[0].row) && /line-crossing alarm/.test(stored[0].row.detail) && stored[0].nowMs === 1234 && stored[0].row.endMs === START)

  answer = (row) => ({ event: { id: 7, ...row, startMs: START - 20_000 }, isNew: false })
  check('merged into the camera’s previous crossing (a row with another start): handled again', onCrossing({ ...report, startMs: START + 20_000, endMs: START + 20_000 })?.id === 7 && handled.length === 2)

  answer = (row) => ({ event: { id: 7, ...row }, isNew: false })
  check('the same alarm on a later tick: stored (its end moves on) and not handled', onCrossing({ ...report, endMs: START + 5000, again: true }) === null && handled.length === 2 && stored.at(-1).row.endMs === START + 5000)
  check('a row already there with this very start (a restart while it was listed): not handled', onCrossing(report) === null && handled.length === 2)

  answer = () => ({ event: null, isNew: false })
  check('nothing stored: nothing handled', onCrossing(report) === null && handled.length === 2)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
```

- [ ] **Step 2: Run the test and confirm it fails**

Run locally from the repo root: `node cctv/test/alarm-watch.test.mjs`

Expected: FAIL with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…\cctv\alarm-watch.mjs' imported from …\cctv\test\alarm-watch.test.mjs`, exit code 1.

- [ ] **Step 3: Write `cctv/alarm-watch.mjs`**

```js
// The cameras' own line-crossing alarms, seen within seconds.
//
// The recorded-file intake (events.mjs) finds a crossing only when it next reads that camera's file
// list: a median of 101 s on nvr1 and 1,218 s on value4u over the week to 2026-09-27. The NVR's live
// alarm list is much quicker. queryAlarmStatus, the command behind its web client's alarm status page,
// answers for every camera on the NVR in one small read (about 0.1 s): each AI alarm active right now
// is an item under content>intelligents with intelligentType (tripwire, pea, osc ...), sourceChl@id
// and alarmTime ("YYYY-MM-DD HH:MM:SS" in UTC, as the web client reads it). alarmTime is when the
// alarm started and stays put while it is active: nvr-2's answer of 2026-09-27 still listed a motion
// alarm 40 minutes after its alarmTime. Motion alarms are listed the same way under content>motions
// and are not used here: the recorded-file intake already covers motion.
//
// So every WATCH_EVERY_MS the watcher asks each online NVR that has at least one camera with lines
// switched on (tripwire.mjs keeps that list in lines-on.json) and hands each tripwire alarm on those
// cameras to onCrossing. It only reads, and only through the caller's `query` (nvr-xml.mjs transparent
// on the server), so the XML queue, the read breaker and the busy refusals all apply; a refusal only
// skips that NVR for that tick.
//
// Everything it touches is passed in (the NVR list, the lines list, the query, the clock), and it
// does not import nvr-xml.mjs, which loads the native SDK: the tests run on a PC without it.
import { chOfGuid, parseUtcText } from './nvr-log.mjs'
import { kid, kids, parseXml } from './xml.mjs'

export const WATCH_EVERY_MS = 5000
/** A failing NVR is logged at most this often: the watcher asks it every 5 s. */
export const FAIL_LOG_MS = 10 * 60_000
/** How an event found by the watcher says where it came from (events-db `source`). */
export const SOURCE_ALARM_STATUS = 'alarm-status'
const CROSSING_DETAIL = 'the camera’s own line-crossing alarm, read from the NVR’s live alarm list'

/**
 * The active AI alarms in a queryAlarmStatus answer, one per content>intelligents>item. An item whose
 * camera or time cannot be read is left out rather than guessed at. Motions and every other list in
 * the answer are ignored. Throws if the answer is not a document or the NVR refused the command.
 * @returns {Array<{ kind: string, chlId: string, ch: number, startMs: number }>}
 */
export function parseAlarmStatus(xml) {
  const response = kid(parseXml(String(xml ?? '')), 'response')
  if (!response) throw new Error('the NVR did not answer with a document')
  const status = (kid(response, 'status')?.text ?? '').trim()
  if (status && status !== 'success') throw new Error(`the NVR refused queryAlarmStatus (${status}, code ${(kid(response, 'errorCode')?.text ?? '').trim()})`)
  const out = []
  // direct children only: each item also lists its recorded channels as nested <item>s, and the list
  // starts with an <itemType> describing the enum
  for (const item of kids(kid(kid(response, 'content'), 'intelligents'), 'item')) {
    const chlId = String(kid(item, 'sourceChl')?.attrs?.id ?? '').trim()
    const ch = chOfGuid(chlId)
    const startMs = parseUtcText(kid(item, 'alarmTime')?.text ?? '')
    const kind = (kid(item, 'intelligentType')?.text ?? '').trim()
    if (!kind || !Number.isInteger(ch) || ch < 0 || startMs === null) continue
    out.push({ kind, chlId, ch, startMs })
  }
  return out
}

/** '<nvr id>/<ch>' keys (tripwire.mjs linesOn) -> Map of nvr id -> Set of 0-based channels. */
function camerasByNvr(keys) {
  const out = new Map()
  for (const key of keys ?? []) {
    const k = String(key)
    const at = k.lastIndexOf('/')
    const tail = k.slice(at + 1)
    const ch = Number(tail)
    if (at <= 0 || tail === '' || !Number.isInteger(ch) || ch < 0) continue
    const id = k.slice(0, at)
    if (!out.has(id)) out.set(id, new Set())
    out.get(id).add(ch)
  }
  return out
}

/**
 * Starts the watcher. Each tick asks every online, not recovering NVR with a camera in linesOn()
 * once, never while that NVR's previous query is still out, and reports each tripwire alarm on a
 * camera with lines on:
 *   onCrossing({ nvr, ch, type: 'line-crossing', subtype: 'tripwire', startMs, endMs, source: 'alarm-status', again })
 * again is false the first time an alarm (camera + start) is seen and true on each later tick while
 * the NVR still lists it; endMs is then startMs plus how long we have seen it, measured on this
 * server's clock so an NVR clock that is off cannot give an end before the start. A failed query is
 * logged at most once per NVR per FAIL_LOG_MS and skipped; what was seen before it is kept, so an
 * alarm that outlasts a failure is not reported as new afterwards.
 *
 * @param {object} deps
 * @param {() => Iterable<object>} deps.nvrs         the NVRs (nvrs.mjs Nvr: id, name, online, degraded, stopped)
 * @param {() => Set<string>} deps.linesOn           '<nvr id>/<ch>' of every camera with lines switched on
 * @param {(nvr: object) => Promise<string>} deps.query  the queryAlarmStatus answer
 * @param {(e: object) => void} deps.onCrossing
 * @param {number} [deps.everyMs]
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now]                  the clock (tests)
 * @param {() => boolean} [deps.sdkBusy]             true while any SDK call is overdue: nobody is asked
 * @returns {{ stop: () => void, tick: () => Promise<string[]> }} tick resolves to the ids of the NVRs it asked
 */
export function startAlarmWatch({ nvrs, linesOn, query, onCrossing, everyMs = WATCH_EVERY_MS, log = console.log, now = Date.now, sdkBusy = () => false }) {
  /** nvr id -> { busy, seen: Map('<ch>/<startMs>' -> first seen ms), fails, loggedAt, told } */
  const state = new Map()
  let stopped = false
  let listLoggedAt = -Infinity

  const stateOf = (id) => {
    let s = state.get(id)
    if (!s) state.set(id, (s = { busy: false, seen: new Map(), fails: 0, loggedAt: -Infinity, told: false }))
    return s
  }

  /** One NVR: one query, then each tripwire alarm on a camera with lines on. Never throws. */
  async function watchOne(nvr, cams) {
    const s = stateOf(nvr.id)
    s.busy = true
    try {
      let items
      try {
        items = parseAlarmStatus(await query(nvr))
      } catch (e) {
        s.fails++
        const nowMs = now()
        if (nowMs - s.loggedAt >= FAIL_LOG_MS) {
          s.loggedAt = nowMs
          s.told = true
          log(`[alarm-watch] ${nvr.id}: could not read the alarm list (${String(e?.message ?? e).slice(0, 120)}); until it answers, line crossings there are only found by the slower recorded-file intake (logged at most every ${FAIL_LOG_MS / 60_000} min)`)
        }
        return
      }
      if (stopped) return
      if (s.told) log(`[alarm-watch] ${nvr.id}: the alarm list answers again (after ${s.fails} failed ${s.fails === 1 ? 'read' : 'reads'})`)
      s.fails = 0
      s.told = false
      const nowMs = now()
      const seen = new Map()
      for (const it of items) {
        if (it.kind !== 'tripwire' || !cams.has(it.ch)) continue
        const key = `${it.ch}/${it.startMs}`
        if (seen.has(key)) continue // listed twice in one answer: still one alarm
        const first = s.seen.get(key)
        seen.set(key, first ?? nowMs)
        try {
          onCrossing({
            nvr: nvr.id,
            ch: it.ch,
            type: 'line-crossing',
            subtype: 'tripwire',
            startMs: it.startMs,
            endMs: it.startMs + (first === undefined ? 0 : Math.max(0, nowMs - first)),
            source: SOURCE_ALARM_STATUS,
            again: first !== undefined
          })
        } catch (e) {
          log(`[alarm-watch] ${nvr.id}/${it.ch}: a crossing could not be filed: ${e?.message ?? e}`)
        }
      }
      // alarms no longer listed are forgotten: if the same camera and start ever came back it would be news
      s.seen = seen
    } finally {
      s.busy = false
    }
  }

  async function tick() {
    if (stopped) return []
    let busy = false
    try {
      busy = Boolean(sdkBusy())
    } catch {}
    // the SDK runs one call at a time for every NVR: a question now would only queue behind the overdue one
    if (busy) return []
    let cams
    try {
      cams = camerasByNvr(linesOn())
    } catch (e) {
      const nowMs = now()
      if (nowMs - listLoggedAt >= FAIL_LOG_MS) {
        listLoggedAt = nowMs
        log(`[alarm-watch] the list of cameras with lines could not be read: ${e?.message ?? e}`)
      }
      return []
    }
    const asked = []
    const runs = []
    const listed = new Set()
    for (const nvr of nvrs()) {
      listed.add(nvr.id)
      const mine = cams.get(nvr.id)
      if (!mine || !nvr.online || nvr.degraded || nvr.stopped) continue
      // its last query has not come back yet: never two at once to one NVR
      if (stateOf(nvr.id).busy) continue
      asked.push(nvr.id)
      runs.push(watchOne(nvr, mine))
    }
    // NVRs removed from the list take their memory with them
    for (const [id, s] of state) if (!listed.has(id) && !s.busy) state.delete(id)
    await Promise.all(runs)
    return asked
  }

  const timer = setInterval(() => {
    tick().catch((e) => log(`[alarm-watch] ${e?.message ?? e}`))
  }, everyMs)
  timer.unref?.()

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    tick
  }
}

/**
 * What the server does with one report from the watcher (nvrs.mjs passes the result as onCrossing):
 * store it with events-db addEvent, then call handle(event) only for a crossing not handled before.
 *   - a new row: handled.
 *   - not new, and the row returned starts at another time: events-db merged this crossing into the
 *     camera's previous line-crossing event (within 30 s) and extended it: handled again, so the
 *     rules see it and its bookmark grows (the notifier itself never sends one event twice).
 *   - the same alarm seen on a later tick (again), or a row already there with this very start (the
 *     server restarted while the alarm was still listed): addEvent has moved its end on; nothing else.
 * @param {{ addEvent: Function, handle: (event: object) => void, now?: () => number }} deps
 * @returns {(e: object) => object|null} the event handed to handle, or null
 */
export function crossingHandler({ addEvent, handle, now = Date.now }) {
  return (e) => {
    const { again, ...row } = e
    const { event, isNew } = addEvent({ ...row, detail: CROSSING_DETAIL }, now())
    if (!event || again) return null
    if (!isNew && event.startMs === row.startMs) return null
    handle(event)
    return event
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run locally from the repo root: `node cctv/test/alarm-watch.test.mjs`

Expected: 43 `PASS` lines, no `FAIL`, last line `all passed`, exit code 0, in about 0.3 s.

The UTC checks compare against `Date.UTC`, so they hold in any time zone. The development PC is UTC-4, so a parse in local time would fail them there.

- [ ] **Step 5: Commit the module and its test**

```bash
git add cctv/alarm-watch.mjs cctv/test/alarm-watch.test.mjs
git commit -m "Alarm watch: the cameras' line-crossing alarms from the NVR's live alarm list, every 5 s" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Import `transparent` and `XML_HEADER` in `cctv/nvrs.mjs` (line 23)**

Find:
```js
import { xmlSettled } from './nvr-xml.mjs'
```
Replace with:
```js
import { XML_HEADER, transparent, xmlSettled } from './nvr-xml.mjs'
```

- [ ] **Step 7: Start the watcher from `startEvents()` in `cctv/nvrs.mjs` (after the `makeEventIntake` call, lines 1064-1068)**

Find:
```js
    sdkBusy: () => lateCalls() > 0
  })

  const every = (ms, fn) => {
```
Replace with:
```js
    sdkBusy: () => lateCalls() > 0
  })

  // Line crossings within seconds. Started on its own and never fatal: if the watcher or a module it
  // needs cannot load, the recorded-file intake above still finds the crossings, only later.
  startLineWatch(notifier).catch((e) => console.warn(`[alarm-watch] not started: ${e.message}`))

  const every = (ms, fn) => {
```

- [ ] **Step 8: Add `startLineWatch` to `cctv/nvrs.mjs` (just before `startNvrs`, line 1097)**

Find:
```js
export const startNvrs = () => {
```
Replace with:
```js
// ---- line crossings (alarm-watch.mjs) --------------------------------------------------------------
//
// The cameras' own line-crossing alarms, read from each NVR's live alarm list every 5 s, and only on
// NVRs where an admin has switched lines on (tripwire.mjs lines-on.json). A new crossing is stored like
// any other event, goes through the same rules and notifier as the recorded-file intake's new events
// (onEvent above), and then gets its automatic bookmark and snapshot (line-actions.mjs).
async function startLineWatch(notifier) {
  const [{ crossingHandler, startAlarmWatch }, { linesOn }, { onLineCrossing }, { takeSnapshot }, bookmarks, { addEvent }, { SegmentReader }] = await Promise.all([
    import('./alarm-watch.mjs'), import('./tripwire.mjs'), import('./line-actions.mjs'), import('./event-snapshot.mjs'),
    import('./bookmarks.mjs'), import('./events-db.mjs'), import('./rec-reader.mjs')
  ])
  const snapshot = (event) => {
    const index = recIndex()
    // no recordings index here (no live worker, or it could not be opened): nothing to take a picture from
    if (!index) return Promise.resolve(null)
    return takeSnapshot(event, { index, readerFor: (seg) => new SegmentReader({ path: seg.path, endMs: seg.endMs ?? null, growing: Boolean(seg.open) }) })
  }
  startAlarmWatch({
    nvrs: () => nvrs.values(),
    linesOn,
    // a read with nothing to say: the XML queue, the read breaker and the busy refusals all apply to it
    query: (nvr) => transparent(nvr, 'queryAlarmStatus', `${XML_HEADER}</request>`, 'alarm watch'),
    onCrossing: crossingHandler({
      addEvent,
      handle: (event) => {
        void notifier.handle(event).catch((e) => console.warn(`[alarms] ${e.message}`))
        void onLineCrossing(event, { bookmark: bookmarks, snapshot }).catch((e) => console.warn(`[lines] ${e.message}`))
      }
    }),
    log: console.warn,
    // any overdue call, for any NVR: a question now would only queue behind it (as for the intake)
    sdkBusy: () => lateCalls() > 0
  })
}

export const startNvrs = () => {
```

- [ ] **Step 9: Syntax-check `nvrs.mjs` locally**

Run from the repo root: `node --check cctv/nvrs.mjs`

Expected: no output, exit code 0. `--check` only parses the file, so it runs on the PC even though koffi cannot load there.

Also run `node cctv/test/alarm-watch.test.mjs` again. Expected: `all passed`.

- [ ] **Step 10: Check the wiring on the server**

The wiring loads the SDK, so it can only run on the server copy: see Task 8 Step 1. There, the server's start-up log must have no `[alarm-watch] not started` line (Tasks 2, 5 and 6 are in place by then).

Task 8's live test then confirms the rest: a test walk on Maingate Roadway (nvr-2, channel index 2) gives, within seconds, an event with `type 'line-crossing'`, `subtype 'tripwire'` and `source 'alarm-status'`.

- [ ] **Step 11: Commit the wiring**

```bash
git add cctv/nvrs.mjs
git commit -m "Events: start the line-crossing alarm watch beside the intake; new crossings get the rules, notifier, bookmark and snapshot" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Notes for the plan assembler:**
- **Additions to the contract.** `startAlarmWatch` also takes `now` and `sdkBusy`, both optional. The `onCrossing` event also carries `endMs` and `again`. Without them the wiring could not tell a newly merged crossing from the same active alarm seen again 5 s later, and would re-handle it every tick. `crossingHandler` is exported so the "new or extended" decision is tested locally.
- **Deps passed to Task 5 are a guess until Task 5 is written.** Step 8 passes `bookmark` as the `bookmarks.mjs` namespace and `snapshot` as `(event) => Promise<path|null>`. It builds Task 6's `readerFor(seg)` as a new, unopened `SegmentReader`, the way `rec-playback.mjs` builds it. If Tasks 5 or 6 settle on other shapes, only the `snapshot` function and the `handle` body in Step 8 change.
- **Scratch copy.** The code was checked locally: it passes, and `nvrs.mjs` passes `node --check` with the three edits applied. The copies are in `C:\Users\mike\AppData\Local\Temp\claude\C--Users-mike-Downloads-websdk3-2\224c4b4b-edba-4a0e-b617-76eab964a246\scratchpad\plan-scratch\t4\` (`cctv\alarm-watch.mjs`, `cctv\test\alarm-watch.test.mjs`, `cctv\nvrs.mjs`).

---

### Task 5: What a line crossing does: alarm rule, ntfy topic, automatic bookmark, event link (`cctv/line-actions.mjs`)

> **Cross-task corrections (binding - apply these where the steps below differ):**
>
> 1. Step 9 adds `const { eventLink } = await import('./line-actions.mjs')` at the top of nvrs.mjs startEvents(), before makeEventIntake. line-actions.mjs statically imports settings.mjs, events-db.mjs, event-rules.mjs, audit.mjs and nvr-xml.mjs. If that import fails for any reason, startEvents rejects ('[events] intake not started') and the existing recording-list intake and every alarm alert stop, only to get a link line. Task 4 deliberately made its own wiring non-fatal.
>
>    **Fix:** In Task 5 Step 9, replace
> ```js
>   const { eventLink } = await import('./line-actions.mjs')
> ```
> with
> ```js
>   // never fatal: without line-actions.mjs the alerts still go, only without the link
>   const eventLink = await import('./line-actions.mjs').then((m) => m.eventLink, (e) => {
>     console.warn(`[alarms] alerts go without a link to the event: ${e.message}`)
>     return () => ''
>   })
> ```


**Files:**
- Create: `cctv/line-actions.mjs`
- Create: `cctv/test/line-actions.test.mjs`
- Modify: `cctv/settings.mjs`. Add the `publicUrl` setting: header comment line 8, `DEFAULTS` lines 41-42, validators after `oneOf` lines 87-90, `validate()` line 155, `fromFile()` line 203, `saveSettings()` line 357. This file has **CRLF** line endings in this checkout, so keep them CRLF.
- Modify: `cctv/event-rules.mjs` lines 383-394. `alarmMessage` gets the `link` and `tzOffsetMin` options.
- Modify: `cctv/alarms.mjs` lines 98-100 and 116-119. `makeAlarmNotifier` gets a `linkOf` dependency.
- Modify: `cctv/server.mjs`: header comment line 34, import line 118, and the route `POST /api/admin/lines/alert` before line 769.
- Modify: `cctv/nvrs.mjs` line 1055. Pass `linkOf` to the notifier. This file also has **CRLF** line endings.
- Test: `cctv/test/line-actions.test.mjs` (new, server copy only). `cctv/test/alarms.test.mjs` gets two additions after line 144 and after line 249; this test runs locally.
- No change to `cctv/bookmarks.mjs`. `updateBookmark(id, { startMs, endMs }, { user: 'system', admin: true }, { now })` can already move a bookmark's ends. It re-checks the whole bookmark, including the 24 h limit (`MAX_BOOKMARK_MS`), so no `updateBookmarkRange` is needed.

**Where the tests run:**
- `cctv/test/alarms.test.mjs` runs locally (`node cctv/test/alarms.test.mjs` from the repo root). It loads only `events-db.mjs`, `event-rules.mjs` and `alarms.mjs`, none of which load the SDK.
- `cctv/test/line-actions.test.mjs` and `cctv/test/settings.test.mjs` run on the server only. `settings.mjs` imports `nvr-xml.mjs`, which imports `sdk.mjs` and loads koffi. For these, run on the server copy: see Task 8 Step 1.
- For the same reason `alarms.mjs` must **not** import `line-actions.mjs`. The link comes in through the `linkOf` dependency, which `nvrs.mjs` passes.

**Interfaces:**

Consumes (existing code, checked in the files):
- `events-db.mjs`:
  - `listRules() -> rule[]`. A rule has `{ id, name, enabled, cameras, types, schedule, priority, notify, minGapS, user, createdMs, updatedMs }`.
  - `createRule(raw, user, nowMs) -> { ok: true, rule } | { ok: false, error }`
  - `updateRule(id, patch, nowMs) -> { ok: true, rule } | { ok: false, status, error }`. The patch is merged onto the stored rule and the whole rule is checked again.
  - `addEvent(e, nowMs) -> { event, isNew }` (test only).
- `event-rules.mjs`:
  - `cameraKey(nvr, ch) -> '<nvr>/<ch>'`
  - `eventWindow(event, { preS, postS }) -> [fromMs, toMs] | null`
  - `applyRules(rules, event, { tzOffsetMin }) -> { priority, notify, rule, matched }` (test)
  - `checkRule`: an empty `cameras` list means every camera.
- `bookmarks.mjs`:
  - `listBookmarks({ camera, fromMs, toMs }) -> bookmark[]`: overlapping ones, ends included, newest first.
  - `createBookmark(raw, user, { now }) -> { ok, bookmark } | { ok: false, error }`
  - `updateBookmark(id, patch, who, { now }) -> { ok, bookmark } | { ok: false, status, error }`
  - `getBookmark(id)`, `protectedRanges(fromMs, toMs)`, `closeBookmarks()` (test)
- `settings.mjs`:
  - `getSettings()` returns a deep copy.
  - `saveSettings(patch, user)` logs and audits the changed top-level keys only, never values.
  - `SETTINGS_FILE` (test).
- `nvr-xml.mjs`: `HttpError(status, message)`, `errorAnswer(e) -> [status, body]`.
- `audit.mjs`: `audit(dataDir, { user, action, target, detail })`. `auth.mjs`: `DATA_DIR`.
- **Task 3:** `{ type: 'line-crossing', label: 'Line crossing', confirmed: true }` in `public/alarms-view.js` `EVENT_KINDS`. Without it, `checkRule` refuses the rule ("line-crossing is not an event kind this app knows").
- **Task 6, at the call site only:** `takeSnapshot(event, { index, readerFor, ... }) -> Promise<path|null>`, bound into `snapshot`.

Produces:

`cctv/line-actions.mjs`:
- `LINE_RULE_NAME = 'Line crossing'`, `LINE_TYPE = 'line-crossing'`, `RULE_PRIORITY = 'high'`, `RULE_MIN_GAP_S = 30`, `BOOKMARK_PRE_S = 30`, `BOOKMARK_POST_S = 60`, `AUTO_USER = 'system'`, `TOPIC_PREFIX = 'argus-'`, `TOPIC_RANDOM_CHARS = 20`.
- `lineRuleCameras() -> string[]`: the rule's cameras while the rule is enabled, else `[]`. Task 2 and Task 7 can use `lineRuleCameras().includes('<nvr>/<ch>')` as the "Alert my phone" switch state.
- `setLineAlert(cameraKey, on, user, { now } = {}) -> rule | null`:
  - Creates or updates the rule. Its cameras gain or lose `cameraKey`.
  - Switching on sets `enabled: true, notify: true`.
  - Switching off disables the rule when its last camera leaves, and never turns a rule on.
  - Returns `null` only for `on === false` when no rule exists.
  - Throws `HttpError` 400 for a bad key and 500 when the rule cannot be saved.
- `newTopic() -> 'argus-' + 20 of [a-z0-9]` (uses `crypto.randomInt`).
- `ensureNtfyTopic(user = 'system') -> { topic, created }`. It only creates a topic when `alerts.ntfy.topic` is empty and never logs it.
- `eventLink(eventId) -> '${publicUrl}/alarms.html#event=${id}'`. Returns `''` when `publicUrl` is `''` or the id is not a positive integer.
- `autoBookmark(event, { store?, nameOf?, now?, log? }) -> Promise<{ ok: true, bookmark, merged } | { ok: false, error }>`.
- `onLineCrossing(event, { bookmark = autoBookmark, snapshot = null, nameOf = null, log = console.log } = {}) -> Promise<{ bookmark, snapshot }>`:
  - `event` is the stored events-db row (`addEvent(...).event`, with `id`). Events of other types are ignored.
  - The bookmark is made every call; the merge makes repeats cheap.
  - `snapshot(event)` is started at most once per event id and not awaited. The returned promise is for tests.
  - The call site (Task 4's `onCrossing` in `nvrs.mjs` startEvents, for a new or extended row) is `void onLineCrossing(row, { snapshot: (e) => takeSnapshot(e, {...}), nameOf })`. Leaving `snapshot` out means no snapshot is taken.
- `handleLineAlert(method, readJson, user, { knownCamera } = {}) -> Promise<[status, body]>`:
  - POST `{ nvr: string, ch: 0-based int, on: boolean }` answers 200 `{ rule, ntfy: { topic, created, url } }`.
  - Errors: 400 for a bad body or bad JSON, 404 for an unknown camera, 405 for a method other than POST.

`cctv/settings.mjs`: top-level `publicUrl`:
- Default `'https://cctv.jfl.gripe'`.
- Must be an http(s) address with no user name, password, `?` or `#`. A trailing slash is dropped. `''` is allowed and means no link.

`cctv/event-rules.mjs`: `alarmMessage(alarm, { ruleName = '', link = '', tzOffsetMin = null } = {})`. The detail becomes `"at HH:MM:SS (site clock) · <detail> · rule: <name>"`, then `"\n<link>"` when a link is given.

`cctv/alarms.mjs`: `makeAlarmNotifier({ sender, rules, tzOffsetMin, nameOf, linkOf = () => '', now, log })`.

Route: `POST /api/admin/lines/alert` inside the `/api/admin/` block of `server.mjs`, so the existing admin, same-origin and JSON checks apply.

Behaviour to know: once a topic exists, health alerts also go to it. They use the same `alert-send.mjs` sender, which checks `alerts.ntfy.topic`.

---

- [ ] **Step 1: Write the failing test `cctv/test/line-actions.test.mjs`**

Create the file with exactly:

```js
// Offline tests for what a line crossing does (line-actions.mjs): the "Line crossing" alarm rule
// switched per camera, the ntfy topic made once and never logged, the automatic bookmark and its
// merging, the link in the message and the publicUrl setting behind it, and the
// POST /api/admin/lines/alert route. Temp data folder only; no NVR, nothing is sent anywhere.
// settings.mjs loads the SDK (through nvr-xml.mjs), so this runs on the server copy.
//   node cctv/test/line-actions.test.mjs
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-line-actions-test-'))
const DATA = process.env.DATA_DIR
writeFileSync(join(DATA, 'users.json'), JSON.stringify({ alice: { hash: 'x', role: 'admin' }, bob: { hash: 'x', role: 'viewer' } }))

const {
  AUTO_USER, BOOKMARK_POST_S, BOOKMARK_PRE_S, LINE_RULE_NAME, LINE_TYPE, RULE_MIN_GAP_S, RULE_PRIORITY,
  autoBookmark, ensureNtfyTopic, eventLink, handleLineAlert, lineRuleCameras, newTopic, onLineCrossing, setLineAlert
} = await import('../line-actions.mjs')
const { addEvent, closeEvents, listRules, updateRule } = await import('../events-db.mjs')
const { applyRules } = await import('../event-rules.mjs')
const { SETTINGS_FILE, getSettings, saveSettings } = await import('../settings.mjs')
const { CLIP_POST_S, CLIP_PRE_S, makeAlarmNotifier } = await import('../alarms.mjs')
const bookmarks = await import('../bookmarks.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const S = 1000
const MIN = 60 * S
const T = Date.parse('2026-09-27T14:00:00Z')
const json = (o) => async () => o
const statusOf = (fn) => {
  try {
    fn()
    return null
  } catch (e) {
    return e.status ?? e.message
  }
}
const crossing = (nvr, ch, startMs, extra = {}) => ({ nvr, ch, type: LINE_TYPE, subtype: 'tripwire', startMs, ...extra })
const rulesNamed = () => listRules().filter((r) => r.name === LINE_RULE_NAME)

// Everything printed while `fn` runs, so a secret can be looked for in it afterwards.
const said = []
const listen = async (fn) => {
  const saved = {}
  for (const m of ['log', 'warn', 'error', 'info']) {
    saved[m] = console[m]
    console[m] = (...a) => {
      said.push(a.map(String).join(' '))
      saved[m](...a)
    }
  }
  try {
    return await fn()
  } finally {
    Object.assign(console, saved)
  }
}
/** Every file in the data folder except settings.json that contains `text` (the database included). */
const filesWith = (text) => readdirSync(DATA)
  .filter((f) => f !== 'settings.json' && !f.startsWith('settings.json.tmp') && statSync(join(DATA, f)).isFile())
  .filter((f) => readFileSync(join(DATA, f)).includes(text))

// ---- the alarm rule ------------------------------------------------------------------------------
{
  check('no rule yet: no camera alerts', lineRuleCameras().length === 0)
  check('switching a camera off with no rule makes no rule', setLineAlert('nvr-2/2', false, 'alice') === null && rulesNamed().length === 0)

  const made = setLineAlert('nvr-2/2', true, 'alice', { now: T })
  check('switching the first camera on makes the rule', made?.name === LINE_RULE_NAME && rulesNamed().length === 1, JSON.stringify(made))
  check('  for line crossings only', made.types.length === 1 && made.types[0] === LINE_TYPE)
  check('  notifying, high priority, 30 s quiet gap, any time of day',
    made.notify === true && made.priority === RULE_PRIORITY && RULE_PRIORITY === 'high' && made.minGapS === RULE_MIN_GAP_S && RULE_MIN_GAP_S === 30 && made.schedule.length === 0)
  check('  enabled, for that camera alone, made by who asked', made.enabled === true && made.cameras.join() === 'nvr-2/2' && made.user === 'alice')
  check('the camera is listed as alerting', lineRuleCameras().join() === 'nvr-2/2')
  check('a crossing on it notifies', applyRules(listRules(), crossing('nvr-2', 2, T)).notify === true)
  check('  at high priority', applyRules(listRules(), crossing('nvr-2', 2, T)).priority === 'high')
  check('a crossing on another camera does not', applyRules(listRules(), crossing('nvr-2', 3, T)).notify === false)
  check('motion on the same camera does not', applyRules(listRules(), { nvr: 'nvr-2', ch: 2, type: 'motion', startMs: T }).notify === false)

  const again = setLineAlert('nvr-2/2', true, 'alice', { now: T })
  check('switching the same camera on twice lists it once', again.cameras.join() === 'nvr-2/2' && rulesNamed().length === 1)
  const two = setLineAlert('nvr-2/5', true, 'bob', { now: T })
  check('a second camera joins the same rule', two.id === made.id && two.cameras.join() === 'nvr-2/2,nvr-2/5' && rulesNamed().length === 1, two.cameras.join())
  const one = setLineAlert('nvr-2/2', false, 'alice', { now: T })
  check('switching one off leaves the other, still enabled', one.cameras.join() === 'nvr-2/5' && one.enabled === true)

  // An empty camera list means every camera to the rules: an enabled empty rule would alert on all.
  const none = setLineAlert('nvr-2/5', false, 'alice', { now: T })
  check('switching the last camera off disables the rule', none.enabled === false && none.cameras.length === 0 && none.id === made.id)
  check('  so a crossing on any camera notifies nobody', applyRules(listRules(), crossing('nvr1', 7, T)).notify === false)
  check('  and no camera is listed', lineRuleCameras().length === 0)
  const back = setLineAlert('nvr-2/2', true, 'alice', { now: T })
  check('switching one on again re-enables the same rule', back.id === made.id && back.enabled === true && back.cameras.join() === 'nvr-2/2')

  // what an admin changed on the Alarms page is theirs to keep
  updateRule(made.id, { priority: 'critical', minGapS: 120 }, T)
  const kept = setLineAlert('nvr-2/4', true, 'alice', { now: T })
  check('an admin’s own priority and quiet gap survive a camera being added', kept.priority === 'critical' && kept.minGapS === 120)
  updateRule(made.id, { enabled: false }, T)
  check('a rule an admin switched off lists no camera', lineRuleCameras().length === 0)
  const stillOff = setLineAlert('nvr-2/4', false, 'alice', { now: T })
  check('  and taking a camera out does not switch it back on', stillOff.enabled === false && stillOff.cameras.join() === 'nvr-2/2')
  const onAgain = setLineAlert('nvr-2/4', true, 'alice', { now: T })
  check('  switching a camera on does, notify included', onAgain.enabled === true && onAgain.notify === true && lineRuleCameras().join() === 'nvr-2/2,nvr-2/4')
  updateRule(made.id, { priority: 'high', minGapS: 30 }, T)

  check('a camera that is not "<nvr>/<ch>" is refused (400)', statusOf(() => setLineAlert('nvr-2', true, 'alice')) === 400)
  check('  nor a channel that is not a number', statusOf(() => setLineAlert('nvr-2/two', true, 'alice')) === 400)
}

// ---- the ntfy topic ------------------------------------------------------------------------------
{
  const t = newTopic()
  check('a topic is "argus-" and 20 lower-case letters and digits', /^argus-[a-z0-9]{20}$/.test(t), t.length)
  check('  which the topic setting accepts (8 to 64 of A-Z a-z 0-9 - _)', /^[A-Za-z0-9_-]{8,64}$/.test(t))
  const many = new Set(Array.from({ length: 2000 }, () => newTopic()))
  check('  and is different every time', many.size === 2000)

  check('no topic to begin with', getSettings().alerts.ntfy.topic === '')
  const first = await listen(() => ensureNtfyTopic('alice'))
  check('with none set, one is made', first.created === true && /^argus-[a-z0-9]{20}$/.test(first.topic))
  check('  and saved in the settings', getSettings().alerts.ntfy.topic === first.topic)
  const second = await listen(() => ensureNtfyTopic('alice'))
  check('with one set, it is kept', second.created === false && second.topic === first.topic)
  check('the topic was not printed', !said.some((l) => l.includes(first.topic)), said.join(' | '))
  check('  nor written anywhere but settings.json (audit trail, database)', filesWith(first.topic).length === 0, filesWith(first.topic).join())
  check('  but the settings change itself was audited', readFileSync(join(DATA, 'audit.jsonl'), 'utf8').includes('"settings-change"'))

  saveSettings({ alerts: { ntfy: { topic: 'owners-own-topic-2024' } } }, 'alice')
  const own = ensureNtfyTopic('alice')
  check('a topic the owner chose is never replaced', own.created === false && own.topic === 'owners-own-topic-2024' && getSettings().alerts.ntfy.topic === 'owners-own-topic-2024')
  saveSettings({ alerts: { ntfy: { topic: '' } } }, 'alice')
}

// ---- the link and the publicUrl setting --------------------------------------------------------------
{
  check('publicUrl defaults to the site’s address', getSettings().publicUrl === 'https://cctv.jfl.gripe')
  check('an event’s link opens the Alarms page at it', eventLink(12) === 'https://cctv.jfl.gripe/alarms.html#event=12', eventLink(12))
  check('  an id given as text works the same', eventLink('12') === 'https://cctv.jfl.gripe/alarms.html#event=12')
  check('  something that is not an event id gives no link', [0, -1, 1.5, 'x', null, undefined].every((v) => eventLink(v) === ''))

  saveSettings({ publicUrl: 'https://example.org/argus/' }, 'alice')
  check('a trailing slash is dropped when saved', getSettings().publicUrl === 'https://example.org/argus')
  check('  and a path is kept in the link', eventLink(5) === 'https://example.org/argus/alarms.html#event=5', eventLink(5))
  const refused = (v) => statusOf(() => saveSettings({ publicUrl: v }, 'alice')) === 400
  check('not an address: refused', refused('not an address'))
  check('not http(s): refused', refused('ftp://example.org') && refused('javascript:alert(1)'))
  check('a user name or password in it: refused', refused('https://u:p@example.org'))
  check('a ? or #: refused (the link is made by adding to it)', refused('https://example.org/?a=1') && refused('https://example.org/#top'))
  check('not text: refused', refused(42) && refused(null))
  check('too long: refused', refused(`https://example.org/${'a'.repeat(200)}`))
  check('  and a refused value changes nothing', getSettings().publicUrl === 'https://example.org/argus')
  saveSettings({ publicUrl: '' }, 'alice')
  check('empty is allowed and means no link', getSettings().publicUrl === '' && eventLink(5) === '')

  // a bad value put in the file by hand costs that value only
  const j = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
  writeFileSync(SETTINGS_FILE, JSON.stringify({ ...j, publicUrl: 'javascript:alert(1)', thumbnails: '1m' }))
  const s = getSettings()
  check('a bad publicUrl in the file falls back to the default', s.publicUrl === 'https://cctv.jfl.gripe' && s.thumbnails === '1m', s.publicUrl)
  saveSettings({ publicUrl: 'https://cctv.jfl.gripe', thumbnails: 'off' }, 'alice')
}

// ---- the route -------------------------------------------------------------------------------------
{
  check('the topic is empty again before the route is tried', getSettings().alerts.ntfy.topic === '')
  const known = (nvr, ch) => nvr === 'nvr-2' && ch >= 0 && ch < 32
  const post = (body) => handleLineAlert('POST', json(body), 'alice', { knownCamera: known })

  check('GET is not allowed', (await handleLineAlert('GET', json({}), 'alice'))[0] === 405)
  check('no NVR: 400', (await post({ ch: 2, on: true }))[0] === 400)
  check('a channel below 0: 400', (await post({ nvr: 'nvr-2', ch: -1, on: true }))[0] === 400)
  check('a channel as text: 400', (await post({ nvr: 'nvr-2', ch: '2', on: true }))[0] === 400)
  check('"on" that is not true or false: 400', (await post({ nvr: 'nvr-2', ch: 2, on: 'yes' }))[0] === 400)
  check('a camera the server does not have: 404', (await post({ nvr: 'nvr-9', ch: 2, on: true }))[0] === 404)
  check('bad JSON: 400', (await handleLineAlert('POST', async () => { throw new SyntaxError('bad') }, 'alice'))[0] === 400)
  check('nothing refused made a topic', getSettings().alerts.ntfy.topic === '')

  said.length = 0
  const [st, body] = await listen(() => post({ nvr: 'nvr-2', ch: 6, on: true }))
  check('switching a camera on answers 200', st === 200, JSON.stringify(body))
  check('  with the rule, the camera in it', body.rule?.name === LINE_RULE_NAME && body.rule.cameras.includes('nvr-2/6') && body.rule.enabled === true)
  check('  and the new topic, for the panel to show how to subscribe', body.ntfy?.created === true && /^argus-[a-z0-9]{20}$/.test(body.ntfy.topic) && body.ntfy.url === 'https://ntfy.sh', JSON.stringify(body.ntfy))
  check('  the topic is in the settings', getSettings().alerts.ntfy.topic === body.ntfy.topic)
  check('  and was not printed', !said.some((l) => l.includes(body.ntfy.topic)), said.join(' | '))
  check('  nor written to the audit trail or the database', filesWith(body.ntfy.topic).length === 0, filesWith(body.ntfy.topic).join())
  const auditRows = readFileSync(join(DATA, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  check('  the switch is audited: who, which camera, on', auditRows.some((r) => r.user === 'alice' && r.target === 'nvr-2/6' && r.detail === 'line-crossing phone alert on'))

  const [, body2] = await post({ nvr: 'nvr-2', ch: 7, on: true })
  check('a second camera: the same topic, not made again', body2.ntfy.created === false && body2.ntfy.topic === body.ntfy.topic && body2.rule.cameras.includes('nvr-2/7'))
  const [st3, body3] = await post({ nvr: 'nvr-2', ch: 6, on: false })
  check('switching off takes the camera out', st3 === 200 && !body3.rule.cameras.includes('nvr-2/6') && body3.rule.cameras.includes('nvr-2/7'))
  check('  and leaves the topic alone', body3.ntfy.created === false && getSettings().alerts.ntfy.topic === body.ntfy.topic)
}

// ---- footage kept: the automatic bookmark ---------------------------------------------------------
{
  check('the stretch is the same as a hand-made alarm bookmark', BOOKMARK_PRE_S === CLIP_PRE_S && BOOKMARK_POST_S === CLIP_POST_S && BOOKMARK_PRE_S === 30 && BOOKMARK_POST_S === 60)
  const now = T + 5 * MIN
  const nameOf = (key) => ({ 'nvr-2/2': 'Maingate Roadway' })[key] ?? key
  const opts = { store: bookmarks, nameOf, now, log: () => {} }

  const first = await autoBookmark(crossing('nvr-2', 2, T), opts)
  check('a crossing is bookmarked', first.ok && first.merged === false, JSON.stringify(first))
  check('  30 s before to 60 s after', first.bookmark.startMs === T - 30 * S && first.bookmark.endMs === T + 60 * S)
  check('  of that camera alone, filed under "system"', first.bookmark.cameras.join() === 'nvr-2/2' && first.bookmark.user === AUTO_USER && AUTO_USER === 'system')
  check('  named after the camera', first.bookmark.title === 'Line crossing — Maingate Roadway', first.bookmark.title)
  check('  and kept from housekeeping', bookmarks.protectedRanges(T - MIN, T + MIN).some(([a, b]) => a <= T - 30 * S && b >= T + 60 * S))

  const later = await autoBookmark(crossing('nvr-2', 2, T + 40 * S), opts)
  check('a crossing whose stretch overlaps stretches the same bookmark', later.ok && later.merged === true && later.bookmark.id === first.bookmark.id)
  check('  to cover both', later.bookmark.startMs === T - 30 * S && later.bookmark.endMs === T + 100 * S, `${later.bookmark.startMs - T} ${later.bookmark.endMs - T}`)
  const same = await autoBookmark(crossing('nvr-2', 2, T + 40 * S), opts)
  check('the same crossing seen again changes nothing', same.merged === true && same.bookmark.id === first.bookmark.id && same.bookmark.endMs === T + 100 * S)
  const grown = await autoBookmark(crossing('nvr-2', 2, T + 40 * S, { endMs: T + 70 * S }), opts)
  check('a crossing that grew (an end time) stretches it past its end', grown.bookmark.id === first.bookmark.id && grown.bookmark.endMs === T + 130 * S)
  const apart = await autoBookmark(crossing('nvr-2', 2, T + 10 * MIN), opts)
  check('a crossing long after gets a bookmark of its own', apart.ok && apart.merged === false && apart.bookmark.id !== first.bookmark.id)
  check('  and the first one is untouched', bookmarks.getBookmark(first.bookmark.id).endMs === T + 130 * S)
  const other = await autoBookmark(crossing('nvr-2', 3, T), opts)
  check('another camera at the same moment gets its own', other.ok && other.merged === false && other.bookmark.cameras.join() === 'nvr-2/3' && other.bookmark.title === 'Line crossing — nvr-2/3')

  // somebody's own bookmark is theirs: never stretched by a crossing
  const hers = bookmarks.createBookmark({ cameras: ['nvr-2/9'], startMs: T, endMs: T + MIN, title: 'Van at the gate' }, 'alice', { now })
  const nearHers = await autoBookmark(crossing('nvr-2', 9, T + 20 * S), opts)
  check('a person’s bookmark on that camera is not stretched', nearHers.merged === false && nearHers.bookmark.id !== hers.bookmark.id && bookmarks.getBookmark(hers.bookmark.id).endMs === T + MIN)

  // a stretch past the 24 hours a bookmark may cover starts a new one instead
  const long = bookmarks.createBookmark({ cameras: ['nvr-2/11'], startMs: T - 24 * 3600 * S + 45 * S, endMs: T + 30 * S, title: 'Line crossing — nvr-2/11' }, AUTO_USER, { now })
  check('(a nearly 24-hour automatic bookmark to stretch)', long.ok, long.error)
  const past = await autoBookmark(crossing('nvr-2', 11, T), opts)
  check('stretching past 24 hours starts a new bookmark', past.ok && past.merged === false && past.bookmark.id !== long.bookmark.id && past.bookmark.startMs === T - 30 * S)
  check('  and leaves the long one as it was', bookmarks.getBookmark(long.bookmark.id).endMs === T + 30 * S)

  const noStart = await autoBookmark({ nvr: 'nvr-2', ch: 2, type: LINE_TYPE }, opts)
  check('an event with no start time is not bookmarked', noStart.ok === false)
}

// ---- one crossing ------------------------------------------------------------------------------------
{
  const calls = { bookmark: [], snapshot: [] }
  const logs = []
  const deps = {
    bookmark: async (e, o) => {
      calls.bookmark.push({ e, o })
      return { ok: true, bookmark: { id: 1 }, merged: false }
    },
    snapshot: async (e) => {
      calls.snapshot.push(e)
      return `/data/event-snaps/${e.id}.jpg`
    },
    nameOf: (key) => key,
    log: (l) => logs.push(l)
  }
  const ev = { id: 501, ...crossing('nvr-2', 2, T) }

  const ignored = await onLineCrossing({ id: 500, nvr: 'nvr-2', ch: 2, type: 'motion', startMs: T }, deps)
  check('an event of another kind is ignored', ignored.bookmark === null && ignored.snapshot === null && calls.bookmark.length === 0 && calls.snapshot.length === 0)
  check('  and so is nothing at all', (await onLineCrossing(null, deps)).bookmark === null)

  const r1 = await onLineCrossing(ev, deps)
  check('a crossing is bookmarked', calls.bookmark.length === 1 && calls.bookmark[0].e === ev && calls.bookmark[0].o.nameOf === deps.nameOf && r1.bookmark?.ok === true)
  check('  and its snapshot is taken', (await r1.snapshot) === '/data/event-snaps/501.jpg' && calls.snapshot.length === 1 && calls.snapshot[0] === ev)
  const r2 = await onLineCrossing({ ...ev, endMs: T + 20 * S }, deps)
  check('the same event again (it grew) is bookmarked again, for the merge', calls.bookmark.length === 2)
  check('  but its snapshot is not taken twice', r2.snapshot === null && calls.snapshot.length === 1)

  const failing = {
    ...deps,
    bookmark: async () => { throw new Error('database locked') },
    snapshot: async () => { throw new Error('ffmpeg missing') }
  }
  const r3 = await onLineCrossing({ id: 502, ...crossing('nvr-2', 2, T + MIN) }, failing)
  check('a bookmark that fails does not stop the snapshot', r3.bookmark === null && r3.snapshot !== null)
  check('  a snapshot that fails comes back empty, not thrown', (await r3.snapshot) === null)
  check('  and both are logged', logs.some((l) => /database locked/.test(l)) && logs.some((l) => /ffmpeg missing/.test(l)), logs.join(' | '))
  const refused = await onLineCrossing({ id: 503, ...crossing('nvr-2', 2, T) }, { ...deps, bookmark: async () => ({ ok: false, error: 'no store' }) })
  check('a bookmark refused is logged too', refused.bookmark?.ok === false && logs.some((l) => /no store/.test(l)))
  check('no snapshot function: no snapshot', (await onLineCrossing({ id: 504, ...crossing('nvr-2', 2, T) }, { bookmark: deps.bookmark, log: () => {} })).snapshot === null)

  // with nothing injected: the real automatic bookmark
  const near = Date.now() - MIN
  await onLineCrossing({ id: 505, ...crossing('nvr-2', 20, near) }, { log: () => {} })
  const made = bookmarks.listBookmarks({ camera: 'nvr-2/20' })
  check('by default a crossing makes the real automatic bookmark', made.length === 1 && made[0].user === AUTO_USER && made[0].startMs === near - 30 * S, JSON.stringify(made))
}

// ---- the alert, end to end through the rule -------------------------------------------------------
{
  setLineAlert('nvr-2/2', true, 'alice')
  const sent = []
  const notifier = makeAlarmNotifier({
    sender: { deliver: async (alerts, kind) => sent.push({ alerts, kind }) },
    tzOffsetMin: () => -240,
    nameOf: (key) => (key === 'nvr-2/2' ? 'Maingate Roadway' : key),
    linkOf: (row) => eventLink(row.id),
    log: () => {}
  })
  const at = Date.now() - 5 * S
  const { event } = addEvent({ ...crossing('nvr-2', 2, at), source: 'alarm-status' }, at)
  await notifier.handle(event)
  await new Promise((r) => setImmediate(r))
  const msg = sent[0]?.alerts[0]
  check('a crossing on a switched-on camera sends an alert', sent.length === 1 && sent[0].kind === 'opened', JSON.stringify(sent))
  check('  titled with what and the camera’s name', msg?.title === 'Line crossing (tripwire) — Maingate Roadway', msg?.title)
  check('  with the site time and the rule', msg?.detail.startsWith(`at ${new Date(at - 240 * MIN).toISOString().slice(11, 19)} · rule: ${LINE_RULE_NAME}`), msg?.detail)
  check('  and the link to the event on its own line', msg?.detail.split('\n')[1] === `https://cctv.jfl.gripe/alarms.html#event=${event.id}`, msg?.detail)
  check('  at high urgency', msg?.severity === 'high')
  const { event: soon } = addEvent({ ...crossing('nvr-2', 2, at + 10 * S), source: 'alarm-status' }, at + 10 * S)
  await notifier.handle(soon)
  await new Promise((r) => setImmediate(r))
  check('a second crossing inside 30 s is kept but not sent', sent.length === 1)
}

closeEvents()
bookmarks.closeBookmarks()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
```

- [ ] **Step 2: Add the failing message checks to `cctv/test/alarms.test.mjs`**

Edit 1. Find (line 144):

```js
  check('a low one is not', alarmMessage({ ...named[0], priority: 'low' }).severity === 'medium')
```

Replace with:

```js
  check('a low one is not', alarmMessage({ ...named[0], priority: 'low' }).severity === 'medium')
  // the phone alert for a line crossing: when on the site's clock, and a link back to the event
  const linked = alarmMessage(named[0], { ruleName: 'Yard at night', link: 'https://cctv.example/alarms.html#event=42', tzOffsetMin: -240 })
  check('with the site offset the detail starts with the site time', linked.detail.startsWith('at 05:00:00 · '), linked.detail)
  check('  and the link is a line of its own, last', linked.detail.split('\n').length === 2 && linked.detail.split('\n')[1] === 'https://cctv.example/alarms.html#event=42', linked.detail)
  check('  an offset of 0 is still an offset (UTC site)', alarmMessage(named[0], { tzOffsetMin: 0 }).detail === 'at 09:00:00', alarmMessage(named[0], { tzOffsetMin: 0 }).detail)
  check('without them the detail is as before', msg.detail === 'rule: Yard at night' && !msg.detail.includes('\n'), msg.detail)
```

Edit 2. Find (line 249, the last check of the notifier block):

```js
  check('because the row remembers it was sent', sameAgain.notifiedMs > 0)
```

Replace with:

```js
  check('because the row remembers it was sent', sameAgain.notifiedMs > 0)

  // the link and the site's time reach what the sender is given
  const got = []
  const toSender = { deliver: async (alerts) => got.push(alerts[0]) }
  const linking = makeAlarmNotifier({ sender: toSender, rules: () => rules, now: () => now, tzOffsetMin: () => -240, linkOf: (row) => `https://cctv.example/alarms.html#event=${row.id}`, log: () => {} })
  now += 10 * MIN
  const four = addEvent({ nvr: 'nvr1', ch: 0, type: 'motion', startMs: now, source: 'x' }, now).event
  await linking.handle(four)
  await new Promise((r) => setImmediate(r))
  check('the message carries the link to the event', got.length === 1 && got[0].detail.endsWith(`\nhttps://cctv.example/alarms.html#event=${four.id}`), JSON.stringify(got))
  check('  and when it happened on the site clock', got[0]?.detail.startsWith(`at ${new Date(now - 240 * MIN).toISOString().slice(11, 19)} · `), got[0]?.detail)
  const broken = makeAlarmNotifier({ sender: toSender, rules: () => rules, now: () => now, linkOf: () => { throw new Error('settings unreadable') }, log: () => {} })
  now += 10 * MIN
  const five = addEvent({ nvr: 'nvr1', ch: 0, type: 'motion', startMs: now, source: 'x' }, now).event
  await broken.handle(five)
  await new Promise((r) => setImmediate(r))
  check('a link that cannot be made costs the link, not the alert', got.length === 2 && !got[1].detail.includes('\n'), JSON.stringify(got[1]))
```

- [ ] **Step 3: Run the tests and see them fail**

Locally, from the repo root:

```
node cctv/test/alarms.test.mjs
```

Expected: FAIL, exit code 1, ending in `5 FAILED`. The failing checks are:
- `with the site offset the detail starts with the site time  (rule: Yard at night)`
- `  and the link is a line of its own, last`
- `  an offset of 0 is still an offset (UTC site)`
- `the message carries the link to the event`
- `  and when it happened on the site clock`

On the server, run `node cctv/test/line-actions.test.mjs` on the server copy: see Task 8 Step 1. Expected: FAIL with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../cctv/line-actions.mjs'`.

- [ ] **Step 4: Add the `publicUrl` setting to `cctv/settings.mjs`**

This file is CRLF. Keep CRLF line endings in every replacement. There are six edits.

Edit 1. Find (header, line 8):

```js
//     thumbnails: 'off' | '1m' | '5m',
```

Replace with:

```js
//     thumbnails: 'off' | '1m' | '5m',
//     publicUrl: 'https://cctv.jfl.gripe',  // where Argus is reached from outside: the phone alert's
//                                           // link to an event (line-actions.mjs eventLink); '' = none
```

Edit 2. Find (DEFAULTS, lines 41-42):

```js
  thumbnails: 'off',
  storage: { locations: [], netshares: [], lowFreePct: 15, floorFreePct: 5 },
```

Replace with:

```js
  thumbnails: 'off',
  // The address people reach Argus at from outside the site, without a trailing slash. A phone
  // alert links to its event there (line-actions.mjs eventLink); '' leaves the link out.
  publicUrl: 'https://cctv.jfl.gripe',
  storage: { locations: [], netshares: [], lowFreePct: 15, floorFreePct: 5 },
```

Edit 3. Find (lines 87-90):

```js
const oneOf = (name, list) => (v) => {
  if (!list.includes(v)) throw new HttpError(400, `${name} must be one of: ${list.join(', ')}`)
  return v
}
```

Replace with:

```js
const oneOf = (name, list) => (v) => {
  if (!list.includes(v)) throw new HttpError(400, `${name} must be one of: ${list.join(', ')}`)
  return v
}
/**
 * publicUrl: an http(s) address with no user name, password, ? or #, because a link is made by
 * adding "/alarms.html#event=<id>" to it; a trailing slash is dropped for the same reason. '' is
 * allowed and means "no link in messages".
 */
const publicUrl = (v) => {
  const s = str('publicUrl', 200)(v).trim().replace(/\/+$/, '')
  if (!s) return ''
  let u
  try {
    u = new URL(s)
  } catch {
    throw new HttpError(400, 'publicUrl is not an address')
  }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'publicUrl must start with https:// or http://')
  if (u.username || u.password || /[?#]/.test(s)) throw new HttpError(400, 'publicUrl must be a plain address (no user name, password, ? or #)')
  return s
}
```

Edit 4. Find (in `validate()`, line 155):

```js
  oneOf('thumbnails', THUMBNAILS)(s.thumbnails)
```

Replace with:

```js
  oneOf('thumbnails', THUMBNAILS)(s.thumbnails)
  // (fromFile checks one camera at a time with a partial settings object that has no publicUrl)
  if ('publicUrl' in s) publicUrl(s.publicUrl)
```

Edit 5. Find (in `fromFile()`, line 203):

```js
  tryPart(() => (s.thumbnails = oneOf('', THUMBNAILS)(j.thumbnails)))
```

Replace with:

```js
  tryPart(() => (s.thumbnails = oneOf('', THUMBNAILS)(j.thumbnails)))
  tryPart(() => (s.publicUrl = publicUrl(j.publicUrl)))
```

Edit 6. Find (in `saveSettings()`, line 357):

```js
  if ('thumbnails' in patch) next.thumbnails = patch.thumbnails
```

Replace with:

```js
  if ('thumbnails' in patch) next.thumbnails = patch.thumbnails
  if ('publicUrl' in patch) next.publicUrl = publicUrl(patch.publicUrl)
```

`saveSettings`'s `knownKeys(patch, Object.keys(DEFAULTS), '')` accepts `publicUrl` from here on with no further change. `settings.test.mjs`'s "DEFAULTS exported and equal to the defaults" still holds.

- [ ] **Step 5: Give `alarmMessage` the site time and the link (`cctv/event-rules.mjs`)**

Find (lines 383-394):

```js
/**
 * One line of text for a notification, reusing the phase 1 delivery shape ({ key, kind, title,
 * detail, severity }) so alert-send.mjs needs no changes at all.
 */
export function alarmMessage(alarm, { ruleName = '' } = {}) {
  const where = alarm.camera || cameraKey(alarm.nvr, alarm.ch)
  const what = alarm.subtype ? `${labelOf(alarm.type)} (${alarm.subtype})` : labelOf(alarm.type)
  return {
    key: `alarm/${alarm.id ?? `${alarm.nvr}/${alarm.ch}/${alarm.startMs}`}`,
    kind: 'alarm',
    title: `${what} — ${where}`,
    detail: [alarm.detail, ruleName ? `rule: ${ruleName}` : ''].filter(Boolean).join(' · '),
```

Replace with:

```js
/** "HH:MM:SS" on the site's clock (tzOffsetMin: minutes to add to UTC, site-time.mjs). */
const siteClock = (ms, tzOffsetMin) => new Date(ms + tzOffsetMin * 60_000).toISOString().slice(11, 19)

/**
 * One line of text for a notification, reusing the phase 1 delivery shape ({ key, kind, title,
 * detail, severity }) so alert-send.mjs needs no changes at all.
 *
 * With `tzOffsetMin` the detail starts with when it happened on the site's clock: the sender
 * stamps each line with the server's own clock, which runs on UTC, and an alarm read late from an
 * NVR happened before it was sent. `link` (line-actions.mjs eventLink) goes on a line of its own,
 * so a phone shows it as a link to the event in Argus.
 */
export function alarmMessage(alarm, { ruleName = '', link = '', tzOffsetMin = null } = {}) {
  const where = alarm.camera || cameraKey(alarm.nvr, alarm.ch)
  const what = alarm.subtype ? `${labelOf(alarm.type)} (${alarm.subtype})` : labelOf(alarm.type)
  const start = Number(alarm.startMs)
  const when = Number.isFinite(tzOffsetMin) && Number.isFinite(start) ? `at ${siteClock(start, tzOffsetMin)}` : ''
  const text = [when, alarm.detail, ruleName ? `rule: ${ruleName}` : ''].filter(Boolean).join(' · ')
  return {
    key: `alarm/${alarm.id ?? `${alarm.nvr}/${alarm.ch}/${alarm.startMs}`}`,
    kind: 'alarm',
    title: `${what} — ${where}`,
    detail: [text, link].filter(Boolean).join('\n'),
```

The `severity` line and the closing lines after it stay as they are.

- [ ] **Step 6: Pass the link through the notifier (`cctv/alarms.mjs`)**

Edit 1. Find (lines 98-100):

```js
 * @param {(key: string) => string} [deps.nameOf]
 */
export function makeAlarmNotifier({ sender, rules = listRules, tzOffsetMin = () => 0, nameOf = null, now = Date.now, log = console.log }) {
```

Replace with:

```js
 * @param {(key: string) => string} [deps.nameOf]
 * @param {(row: object) => string} [deps.linkOf]  the event's address in Argus for the message
 *   (line-actions.mjs eventLink, passed in by nvrs.mjs: importing it here would load settings.mjs
 *   and with it the SDK, and this module's tests run without one); '' leaves the link out
 */
export function makeAlarmNotifier({ sender, rules = listRules, tzOffsetMin = () => 0, nameOf = null, linkOf = () => '', now = Date.now, log = console.log }) {
```

Edit 2. Find (lines 116-119):

```js
      const named = nameOf ? { ...row, camera: nameOf(cameraKey(row.nvr, row.ch)) } : row
      // Fire and forget, like the health alerts: delivery has its own retries and a slow mail
      // server must never hold up the poll that found the event.
      void Promise.resolve(sender.deliver([alarmMessage(named, { ruleName: verdict.rule?.name ?? '' })], 'opened'))
```

Replace with:

```js
      const named = nameOf ? { ...row, camera: nameOf(cameraKey(row.nvr, row.ch)) } : row
      // A link that cannot be made (settings unreadable) costs the link, never the alert.
      let link = ''
      try {
        link = String(linkOf(row) ?? '')
      } catch (e) {
        log(`[alarms] no link for alarm ${row.id}: ${e?.message ?? e}`)
      }
      // Fire and forget, like the health alerts: delivery has its own retries and a slow mail
      // server must never hold up the poll that found the event.
      void Promise.resolve(sender.deliver([alarmMessage(named, { ruleName: verdict.rule?.name ?? '', link, tzOffsetMin: tzOffsetMin() })], 'opened'))
```

- [ ] **Step 7: Create `cctv/line-actions.mjs`**

```js
// What a line crossing does once it is an event: the phone alert, the footage kept around it and
// the snapshot of what crossed. The camera does the detecting (tripwire.mjs sets its lines) and
// alarm-watch.mjs turns its alarm into an event within seconds; everything after that is here.
//
// - Phone alert: one alarm rule, "Line crossing" (type line-crossing, notify on, priority high,
//   30 s quiet gap per camera), whose cameras are the ones switched on in the Lines panel. It is an
//   ordinary rule in events-db.mjs, so the Alarms page shows it and alarms.mjs sends it; nothing
//   here sends anything itself.
// - The ntfy topic: made the first time a camera is switched on, when there is none yet. It is a
//   secret (anyone who knows it can push to the owner's phone), so it is random, never logged, and
//   saved only in settings.json (settings.mjs logs and audits which settings changed, never values).
// - Footage kept: a bookmark from 30 s before to 60 s after each crossing, filed under "system".
//   Bookmarked stretches are never thinned or deleted by housekeeping. A crossing whose stretch
//   overlaps the camera's previous automatic bookmark stretches that one instead of adding another,
//   so a busy afternoon is one bookmark, not two hundred.
// - Snapshot: handed to event-snapshot.mjs (injected by the caller), once per event.
//
//   POST /api/admin/lines/alert { nvr, ch, on }   (admins; ch 0-based, as in /api/cameras)
//        -> { rule, ntfy: { topic, created, url } }
import { randomInt } from 'node:crypto'
import { DATA_DIR } from './auth.mjs'
import { audit } from './audit.mjs'
import { createRule, listRules, updateRule } from './events-db.mjs'
import { cameraKey, eventWindow } from './event-rules.mjs'
import { HttpError, errorAnswer } from './nvr-xml.mjs'
import { getSettings, saveSettings } from './settings.mjs'

export const LINE_RULE_NAME = 'Line crossing'
/** The event kind a crossing is filed as (public/alarms-view.js EVENT_KINDS). */
export const LINE_TYPE = 'line-crossing'
export const RULE_PRIORITY = 'high'
/** One message per camera per 30 s: a lorry and its trailer are one alert, not two. */
export const RULE_MIN_GAP_S = 30
/** The same stretch a hand-made alarm bookmark covers (alarms.mjs CLIP_PRE_S / CLIP_POST_S). */
export const BOOKMARK_PRE_S = 30
export const BOOKMARK_POST_S = 60
/** Who automatic bookmarks are filed under: no person made them, so only an admin may change them. */
export const AUTO_USER = 'system'
export const TOPIC_PREFIX = 'argus-'
export const TOPIC_RANDOM_CHARS = 20
const TOPIC_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const CAMERA_KEY = /^[A-Za-z0-9._-]{1,64}\/\d{1,3}$/
const NVR_ID = /^[A-Za-z0-9._-]{1,64}$/
/** Snapshots already started, by event id: the alarm is seen again every 5 s while it lasts. */
const SNAPPED_MAX = 1000
const snapped = new Set()

// ---- the alarm rule ------------------------------------------------------------------------------

/** The "Line crossing" rule, or null. Found by name: it is an ordinary rule an admin can also see. */
function lineRule() {
  return listRules().find((r) => r.name === LINE_RULE_NAME) ?? null
}

/**
 * The cameras whose crossings alert a phone: the rule's cameras while the rule is enabled, else
 * none. A rule an admin switched off on the Alarms page alerts nobody, so it lists nobody.
 */
export function lineRuleCameras() {
  const rule = lineRule()
  return rule && rule.enabled ? [...rule.cameras] : []
}

/**
 * Puts a camera into the "Line crossing" rule, or takes it out; makes the rule the first time.
 *
 * The rule is switched off when its last camera leaves, and that is not tidiness: an empty camera
 * list means "every camera" to the rules (event-rules.mjs ruleMatches), so an enabled rule with no
 * cameras would alert on every camera's crossings. Adding a camera switches it back on, with
 * notify on, because that is what the switch in the Lines panel says it does.
 *
 * @param {string} key   "<nvr>/<ch>", ch 0-based
 * @param {boolean} on
 * @param {string} user  who asked (the rule's creator when it is made)
 * @returns {object|null} the rule as stored; null when asked to remove a camera and there is no rule
 * @throws {HttpError} 400 for a bad camera key, 500 when the rule cannot be saved
 */
export function setLineAlert(key, on, user, { now = Date.now() } = {}) {
  if (typeof key !== 'string' || !CAMERA_KEY.test(key)) throw new HttpError(400, 'camera must look like "<nvr>/<channel>"')
  const current = lineRule()
  if (!current) {
    if (!on) return null
    const made = createRule({
      name: LINE_RULE_NAME,
      enabled: true,
      cameras: [key],
      types: [LINE_TYPE],
      schedule: [],
      priority: RULE_PRIORITY,
      notify: true,
      minGapS: RULE_MIN_GAP_S
    }, user, now)
    if (!made.ok) throw new HttpError(500, `the "${LINE_RULE_NAME}" alarm rule could not be made: ${made.error}`)
    return made.rule
  }
  const cameras = on ? [...new Set([...current.cameras, key])] : current.cameras.filter((c) => c !== key)
  // Taking a camera out never switches a rule on: one an admin switched off stays off.
  const patch = on ? { cameras, enabled: true, notify: true } : { cameras, enabled: cameras.length > 0 && current.enabled }
  const res = updateRule(current.id, patch, now)
  if (!res.ok) throw new HttpError(500, `the "${LINE_RULE_NAME}" alarm rule could not be changed: ${res.error}`)
  return res.rule
}

// ---- the ntfy topic ------------------------------------------------------------------------------

/** 'argus-' and 20 random letters and digits (about 103 bits): not guessable, still typeable. */
export function newTopic() {
  let s = TOPIC_PREFIX
  for (let i = 0; i < TOPIC_RANDOM_CHARS; i++) s += TOPIC_ALPHABET[randomInt(TOPIC_ALPHABET.length)]
  return s
}

/**
 * The ntfy topic phone alerts go to, made and saved when there is none yet. An existing topic is
 * never replaced: the owner's phone is subscribed to it. Nothing here logs the topic; the settings
 * log and audit line name the part of the settings that changed ("alerts"), not its value.
 * From the moment a topic exists, the health alerts go to it too (the same alert-send.mjs sender).
 * @returns {{ topic: string, created: boolean }}
 */
export function ensureNtfyTopic(user = AUTO_USER) {
  const current = getSettings().alerts?.ntfy?.topic ?? ''
  if (current) return { topic: current, created: false }
  const topic = newTopic()
  saveSettings({ alerts: { ntfy: { topic } } }, user)
  return { topic, created: true }
}

// ---- the link in the message ---------------------------------------------------------------------

/**
 * Where an event opens in Argus from a phone: the Alarms page scrolled to it. '' when the
 * publicUrl setting is empty or the id is not an event id, and the message then has no link.
 */
export function eventLink(eventId) {
  const base = getSettings().publicUrl ?? ''
  const id = Number(eventId)
  if (!base || !Number.isSafeInteger(id) || id <= 0) return ''
  return `${base}/alarms.html#event=${id}`
}

// ---- footage kept --------------------------------------------------------------------------------

let bookmarksModule = null
/**
 * bookmarks.mjs, loaded on first use and defensively, as alarms.mjs does: a server that cannot open
 * the bookmarks table loses the automatic bookmark, not the alert.
 */
async function bookmarkStore(log) {
  try {
    bookmarksModule ??= await import('./bookmarks.mjs')
    return bookmarksModule
  } catch (e) {
    log(`[lines] bookmarks are not available: ${e?.message ?? e}`)
    return null
  }
}

/** One of ours: filed by "system", of this camera alone, and titled as a line crossing. */
const isAuto = (b, key) => b.user === AUTO_USER && b.cameras.length === 1 && b.cameras[0] === key && String(b.title).startsWith(LINE_RULE_NAME)

/**
 * Keeps the footage around one crossing: 30 s before to 60 s after (the event's end, when it has
 * one). If the camera's newest automatic bookmark overlaps that stretch, it is stretched to cover
 * both; otherwise a new one is made. A merged stretch that would pass the 24 hours a bookmark may
 * cover (bookmarks-view.js MAX_BOOKMARK_MS) is refused by updateBookmark, and a new one starts.
 *
 * @param {{nvr: string, ch: number, startMs: number, endMs?: number|null, camera?: string}} event
 * @param {{ store?: object, nameOf?: (key: string) => string, now?: number, log?: Function }} [opts]
 *   store: bookmarks.mjs or a stand-in with listBookmarks, createBookmark and updateBookmark
 * @returns {Promise<{ ok: true, bookmark: object, merged: boolean } | { ok: false, error: string }>}
 */
export async function autoBookmark(event, { store = null, nameOf = null, now = Date.now(), log = console.log } = {}) {
  const win = eventWindow(event, { preS: BOOKMARK_PRE_S, postS: BOOKMARK_POST_S })
  if (!win) return { ok: false, error: 'the event has no start time' }
  const s = store ?? await bookmarkStore(log)
  if (!s) return { ok: false, error: 'bookmarks are not available on this server' }
  const key = cameraKey(event.nvr, event.ch)
  const [from, to] = win.map(Math.round)
  // listBookmarks is newest first and returns those overlapping [from, to], ends included
  const prev = s.listBookmarks({ camera: key, fromMs: from, toMs: to }).find((b) => isAuto(b, key))
  if (prev) {
    const startMs = Math.min(prev.startMs, from)
    const endMs = Math.max(prev.endMs, to)
    if (startMs === prev.startMs && endMs === prev.endMs) return { ok: true, bookmark: prev, merged: true }
    const res = s.updateBookmark(prev.id, { startMs, endMs }, { user: AUTO_USER, admin: true }, { now })
    if (res.ok) return { ok: true, bookmark: res.bookmark, merged: true }
    log(`[lines] bookmark ${prev.id} not stretched (${res.error}); starting a new one`)
  }
  const name = (nameOf ? nameOf(key) : null) || event.camera || key
  const res = s.createBookmark({
    cameras: [key],
    startMs: from,
    endMs: to,
    title: `${LINE_RULE_NAME} — ${name}`.slice(0, 120),
    description: 'Kept automatically around line crossings on this camera; later crossings stretch it.'
  }, AUTO_USER, { now })
  return res.ok ? { ok: true, bookmark: res.bookmark, merged: false } : { ok: false, error: res.error }
}

// ---- one crossing --------------------------------------------------------------------------------

/**
 * Everything a line-crossing event sets off after it is stored: the bookmark now, the snapshot in
 * the background (it waits up to 3 minutes for the recording). Called for a new event and again
 * each time the same event grows; the bookmark merge and the per-event snapshot memory make the
 * repeats cheap. Events of any other kind are ignored, so a caller may pass every event.
 *
 * @param {object} event  the stored events-db row (addEvent(...).event: id, nvr, ch, type, startMs, endMs)
 * @param {object} [deps]
 * @param {(event: object, opts: object) => Promise<object>} [deps.bookmark]  default autoBookmark
 * @param {((event: object) => Promise<string|null>) | null} [deps.snapshot]  event-snapshot.mjs
 *   takeSnapshot bound to the recordings index; null: no snapshot
 * @param {(key: string) => string} [deps.nameOf]  camera names for the bookmark's title
 * @returns {Promise<{ bookmark: object|null, snapshot: Promise<string|null>|null }>} (callers may
 *   ignore it; the tests read it)
 */
export async function onLineCrossing(event, { bookmark = autoBookmark, snapshot = null, nameOf = null, log = console.log } = {}) {
  if (!event || event.type !== LINE_TYPE) return { bookmark: null, snapshot: null }
  const key = cameraKey(event.nvr, event.ch)
  let marked = null
  try {
    marked = await bookmark(event, { nameOf, log })
    if (marked && !marked.ok) log(`[lines] ${key}: no bookmark (${marked.error})`)
  } catch (e) {
    log(`[lines] ${key}: bookmark failed: ${e?.message ?? e}`)
  }
  let snap = null
  const id = Number(event.id)
  if (typeof snapshot === 'function' && Number.isSafeInteger(id) && id > 0 && !snapped.has(id)) {
    snapped.add(id)
    // a Set keeps insertion order, so the first one is the oldest
    if (snapped.size > SNAPPED_MAX) snapped.delete(snapped.values().next().value)
    snap = Promise.resolve()
      .then(() => snapshot(event))
      .catch((e) => {
        log(`[lines] ${key}: snapshot of event ${id} failed: ${e?.message ?? e}`)
        return null
      })
  }
  return { bookmark: marked, snapshot: snap }
}

// ---- the route -----------------------------------------------------------------------------------

/**
 * POST /api/admin/lines/alert { nvr, ch, on } — the Lines panel's "Alert my phone for this camera".
 * server.mjs has already checked admin, same origin and JSON. Switching on makes the ntfy topic
 * first (when there is none), so the rule never alerts into a topic that does not exist yet.
 *
 * @param {string} method
 * @param {() => Promise<object>} readJson
 * @param {string} user
 * @param {{ knownCamera?: (nvr: string, ch: number) => boolean }} [deps]
 * @returns {Promise<[number, object]>}
 */
export async function handleLineAlert(method, readJson, user, { knownCamera = () => true } = {}) {
  if (method !== 'POST') return [405, { error: 'Method not allowed' }]
  try {
    const body = await readJson()
    const { nvr, ch, on } = body ?? {}
    if (typeof nvr !== 'string' || !NVR_ID.test(nvr)) throw new HttpError(400, 'nvr must be an NVR id')
    if (!Number.isInteger(ch) || ch < 0 || ch > 255) throw new HttpError(400, 'ch must be a channel number from 0')
    if (typeof on !== 'boolean') throw new HttpError(400, 'on must be true or false')
    if (!knownCamera(nvr, ch)) throw new HttpError(404, 'No such camera on this NVR')
    const key = cameraKey(nvr, ch)
    const ntfy = on ? ensureNtfyTopic(user) : { topic: getSettings().alerts?.ntfy?.topic ?? '', created: false }
    const rule = setLineAlert(key, on, user)
    // the change to who gets alerted is a settings change as far as the audit trail is concerned
    audit(DATA_DIR, { user, action: 'settings-change', target: key, detail: `line-crossing phone alert ${on ? 'on' : 'off'}` })
    console.log(`[lines] ${key}: phone alert ${on ? 'on' : 'off'} (by ${user})${ntfy.created ? '; an ntfy topic was made' : ''}`)
    return [200, { rule, ntfy: { ...ntfy, url: getSettings().alerts?.ntfy?.url || 'https://ntfy.sh' } }]
  } catch (e) {
    return errorAnswer(e)
  }
}
```

- [ ] **Step 8: Add the route `POST /api/admin/lines/alert` to `cctv/server.mjs`**

Edit 1. Find (header, line 34):

```js
//   POST /api/admin/alerts/test { method: 'ntfy'|'email' } -> sends a test message (admins)
```

Replace with:

```js
//   POST /api/admin/alerts/test { method: 'ntfy'|'email' } -> sends a test message (admins)
//   POST /api/admin/lines/alert { nvr, ch, on } -> a camera's line-crossing phone alert on or off
//                                 (admins): the "Line crossing" alarm rule, see line-actions.mjs
```

Edit 2. Find (line 118):

```js
import { handleAlarms } from './alarms.mjs'
```

Replace with:

```js
import { handleAlarms } from './alarms.mjs'
import { handleLineAlert } from './line-actions.mjs'
```

Edit 3. Find (line 769, inside the `/api/admin/` block, after the same-origin and JSON checks):

```js
    if (pathname === '/api/admin/alerts/test' && req.method === 'POST') {
```

Replace with:

```js
    // The Lines panel's "Alert my phone for this camera": the camera joins or leaves the "Line
    // crossing" alarm rule, and the ntfy topic is made the first time one is switched on.
    if (pathname === '/api/admin/lines/alert') {
      const known = (id, ch) => Boolean(nvrs.get(id)?.channels.some((c) => c.ch === ch && c.configured !== false))
      const [status, body] = await handleLineAlert(req.method, () => readJsonObject(req, 1024), user, { knownCamera: known })
      return sendJson(res, status, body, status === 405 ? { allow: 'POST' } : {})
    }
    if (pathname === '/api/admin/alerts/test' && req.method === 'POST') {
```

- [ ] **Step 9: Give the notifier the event link (`cctv/nvrs.mjs`)**

This file is CRLF. Keep CRLF. Task 4 may already have edited `startEvents()` around this line. If so, leave its lines alone and change only this `makeAlarmNotifier` call.

Find (line 1055):

```js
  const notifier = makeAlarmNotifier({ sender, tzOffsetMin: () => siteOffsetMin(), nameOf: (key) => allCameras().find((c) => `${c.nvr}/${c.ch}` === key)?.name ?? key })
```

Replace with:

```js
  // the alert's link back to the event in Argus (settings publicUrl): passed in rather than
  // imported by alarms.mjs, whose tests run without the SDK that settings.mjs loads
  const { eventLink } = await import('./line-actions.mjs')
  const notifier = makeAlarmNotifier({
    sender,
    tzOffsetMin: () => siteOffsetMin(),
    nameOf: (key) => allCameras().find((c) => `${c.nvr}/${c.ch}` === key)?.name ?? key,
    linkOf: (row) => eventLink(row.id)
  })
```

- [ ] **Step 10: Run the tests and see them pass**

Locally, from the repo root:

```
node cctv/test/alarms.test.mjs
node --check cctv/server.mjs
node --check cctv/nvrs.mjs
```

Expected:
- `alarms.test.mjs` ends in `all passed` with exit code 0.
- Both `--check` runs print nothing and exit 0. That is a syntax check only; the server cannot start on this PC.

On the server (run on the server copy: see Task 8 Step 1):

```
node cctv/test/line-actions.test.mjs
node cctv/test/settings.test.mjs
node cctv/test/alarms.test.mjs
```

Expected: each ends in `all passed` with exit code 0. `line-actions.test.mjs` runs about 105 checks. Between the PASS lines it prints `[settings] saved by alice: ...` and `[lines] nvr-2/6: phone alert on (by alice); an ntfy topic was made`. None of those lines contains a topic.

- [ ] **Step 11: Commit**

```
git add cctv/line-actions.mjs cctv/test/line-actions.test.mjs cctv/settings.mjs cctv/event-rules.mjs cctv/alarms.mjs cctv/test/alarms.test.mjs cctv/server.mjs cctv/nvrs.mjs
git commit -F - <<'EOF'
lines: phone alert rule, ntfy topic, automatic bookmark and event link

line-actions.mjs: the "Line crossing" alarm rule switched per camera (disabled
when its last camera leaves, since an empty camera list means all cameras), the
ntfy topic made once when empty and never logged, a bookmark 30 s before to
60 s after each crossing that stretches the camera's previous automatic one when
they overlap, the snapshot started once per event, and
POST /api/admin/lines/alert. settings.mjs: publicUrl (default
https://cctv.jfl.gripe). alarmMessage: the site time and a link line;
makeAlarmNotifier takes linkOf, which nvrs.mjs fills with eventLink.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Event snapshots (`cctv/event-snapshot.mjs`) and `GET /api/events/:id/snapshot`

**Files:**
- Create: `cctv/event-snapshot.mjs`. Pure: it imports no `sdk.mjs` and uses ffmpeg only through `spawn`.
- Create: `cctv/test/event-snapshot.test.mjs`. It runs locally on the PC.
- Create: `cctv/test/event-snapshot-ffmpeg.test.mjs`. It runs on the server only, because it needs the real ffmpeg.
- Modify: `cctv/server.mjs`, in four places:
  - line 43, the route list in the header comment;
  - line 117, the imports;
  - lines 181-185, the 5-minute housekeeping chain;
  - just before line 574, the new route, placed before `handleEvents`.
  All four anchors lie outside the `/api/admin` block that Tasks 2 and 5 edit.
- Test commands:
  - Local, from the repo root: `node cctv/test/event-snapshot.test.mjs`. Expect 51 PASS.
  - Server: `node cctv/test/event-snapshot-ffmpeg.test.mjs`. Expect 7 PASS, or 6 PASS and 1 SKIP.

**Interfaces:**

Consumes (existing code, read and checked):
- `DATA_DIR`: `cctv/auth.mjs:12`.
- `getEvent(id) -> row | null`: `cctv/events-db.mjs:155`.
  - The row is `{ id, nvr, ch, type, subtype, startMs, endMs, source, detail, priority, ruleId, ruleName, notifiedMs, ackMs, ackUser, ackNote, seenMs }`.
- The recordings index from `openRecIndex` in `cctv/rec-index.mjs`, reached through `nvrs.mjs recIndex()` at line 801:
  - `at(nvr, ch, t) -> seg | null` (line 266). The file still being written comes back as `{ ..., endMs: null, open: true }`.
  - `next(nvr, ch, afterStartMs) -> seg | null` (line 273).
  - `seg = { nvr, ch, path, startMs, endMs, bytes, keyframes, loc, open? }`.
- `cctv/rec-reader.mjs`:
  - `new SegmentReader({ path, endMs, growing }).open() -> Promise<reader>` (lines 268-308).
  - `reader.times: number[]`.
  - `reader.keyframe(k) -> Promise<{ buf, ts } | null>` (line 350). It returns null for the newest keyframe of a growing file until that keyframe is complete.
  - `reader.close() -> Promise<void>`.
  - `keyAtOrAfter(rowsOrTimes, t) -> k | -1` (line 148).
  - `codecOfPath(path) -> 0 | 1` (line 73).
  - `CODEC` (line 28).
- `niceWrap(bin, args, { platform, hasNice, hasIonice }) -> { bin, args }`: `cctv/transcode.mjs:166`. On Linux it wraps the command as `ionice -c 3 nice -n 10 ...`.
- `can(who, action, { nvr, ch }) -> boolean`: `cctv/rights.mjs:272`.
  - The snapshot route accepts either `'playback-server'` or `'playback-nvr'`, the same rule as the `/playback` socket (`server.mjs:919`).
- `securityHeaders() -> object`: `cctv/security.mjs:26`.
- From `server.mjs`: `who = { user, admin }` (line 564), `pathname`, `req` and `res` inside `handleRequest`.

Produces:
```
export const SNAP_DIR = join(DATA_DIR, 'event-snaps')
export const SNAP_WAIT_MS = 3 * 60_000
export const SNAP_POLL_MS = 5000          // extra (tests)
export const SNAP_AFTER_MS = 1000         // extra: the picture is of startMs + 1 s
export const SNAP_LATE_MS = 15_000        // extra: a keyframe later than this after that moment -> no picture
export const SNAP_FFMPEG_MS = 20_000      // extra: ffmpeg is killed after this
export function snapPath(eventId) -> string                  // SNAP_DIR/<id>.jpg; throws for anything but a positive integer
export function snapArgs(codec) -> string[]                  // extra: the ffmpeg arguments
export async function takeSnapshot(event, { index, readerFor, ffmpeg = 'ffmpeg', now, wait,
                                            spawn?, platform?, timeoutMs?, log? }) -> Promise<string|null>   // never rejects
export async function handleSnapshot(req, res, eventId, who) -> Promise<void>   // 200 image/jpeg | 404 JSON | 405
export function forgetSnapshots(eventIds) -> void
export async function sweepSnapshots({ exists?, now? } = {}) -> Promise<{ removed: number }>   // extra, never rejects
```
- Route: `GET /api/events/:id/snapshot`.
  - Not admin-only; the rights check happens inside the handler.
  - Missing, forbidden and not-yet-taken all answer with the same 404, sent with `cache-control: no-store`.

Notes for the other tasks:
- **Wiring takeSnapshot:** this task does not call `takeSnapshot` itself.
  - The Task 4 wiring in `cctv/nvrs.mjs` `startEvents()` passes Task 5's `onLineCrossing` `snapshot: (e) => takeSnapshot(e, { index: recIndex() })`, where `e` is the events-db row (`addEvent(...).event`).
  - It is fire-and-forget. It never rejects, and repeated calls for the same event share one picture.
- **Removing pictures:** `events-db forgetEventsBefore` has **no production caller**. A grep finds it only at `cctv/test/alarms.test.mjs:188`, so today events are never removed and there is no call site to hook into.
  - Instead, pictures are removed by `sweepSnapshots()` in the 5-minute housekeeping chain. It deletes any `<id>.jpg` whose event row is gone, whatever removed the row.
  - `events-db.mjs` is not touched here; Task 3 edits `addEvent` in it.
- **ffmpeg arguments:** the contract's `-f image2 pipe:1` is written as `-f image2pipe -c:v mjpeg pipe:1`. That is the pipe form of the image2 muxer and gives the same single JPEG.

- [ ] **Step 1: Write the failing local test `cctv/test/event-snapshot.test.mjs`**

```js
// Event pictures (event-snapshot.mjs): the file names, ffmpeg's arguments, the wait for the recording
// to reach the event (a fake index and clock), the keyframe read from real segment files through
// rec-reader.mjs (closed and still being written), ffmpeg one at a time and its failures, the route's
// rights, and pictures going with their events. ffmpeg is a fake here (it is on the server only);
// event-snapshot-ffmpeg.test.mjs runs the real one there.
//
// Temp data folder only; no NVR, no SDK, no ffmpeg.
//   node cctv/test/event-snapshot.test.mjs
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-snap-test-'))
writeFileSync(join(process.env.DATA_DIR, 'users.json'), JSON.stringify({ alice: { hash: 'x', role: 'admin' }, bob: { hash: 'x', role: 'viewer' } }))
// bob may watch live only; carol may play nvr1/3 back from the server; dave may play all of nvr1 back from the NVR
writeFileSync(join(process.env.DATA_DIR, 'rights.json'), JSON.stringify({
  version: 1,
  users: {
    bob: { grants: { live: ['*'] } },
    carol: { grants: { 'playback-server': ['nvr1/3'] } },
    dave: { grants: { 'playback-nvr': ['nvr1'] } }
  }
}))

const {
  SNAP_AFTER_MS, SNAP_DIR, SNAP_LATE_MS, SNAP_POLL_MS, SNAP_WAIT_MS,
  forgetSnapshots, handleSnapshot, snapArgs, snapPath, sweepSnapshots, takeSnapshot
} = await import('../event-snapshot.mjs')
const { addEvent, closeEvents } = await import('../events-db.mjs')
const { CODEC } = await import('../rec-reader.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 27, 14, 0, 0)
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])])

// ---- names and arguments ------------------------------------------------------------------------
{
  check('SNAP_DIR is event-snaps in the data folder', SNAP_DIR === join(process.env.DATA_DIR, 'event-snaps'), SNAP_DIR)
  check('snapPath: <id>.jpg in SNAP_DIR (a numeric string too)', snapPath(12) === join(SNAP_DIR, '12.jpg') && snapPath('12') === join(SNAP_DIR, '12.jpg'))
  const throws = (v) => { try { snapPath(v); return false } catch { return true } }
  check('snapPath: anything but a positive whole number is refused (never a path from outside)', ['../x', '1/2', 1.5, -3, 0, '', null, undefined, NaN].every(throws))
  check('the wait is 3 minutes, looking every 5 s', SNAP_WAIT_MS === 180_000 && SNAP_POLL_MS === 5000 && SNAP_AFTER_MS === 1000)
  const a = snapArgs(CODEC.h264).join(' ')
  check('snapArgs H.264: raw h264 on stdin, one frame, one JPEG on stdout',
    a.includes('-f h264 -i pipe:0') && a.includes('-frames:v 1') && a.includes('-q:v 4') && a.endsWith('-f image2pipe -c:v mjpeg pipe:1'), a)
  check('  scaled to at most 1280 wide, height even (quoted for the filter parser, no shell)', snapArgs(CODEC.h264).includes("scale='min(1280,iw)':-2"))
  check('snapArgs H.265: hevc on stdin', snapArgs(CODEC.h265).join(' ').includes('-f hevc -i pipe:0'))
}

// ---- a fake ffmpeg --------------------------------------------------------------------------------
// how: 'ok' writes a JPEG, 'junk' writes something else, 'fail' exits 1 with a message, 'hang' never
// ends, 'enoent' is not installed. It counts how many run at once.
const procs = []
let running = 0
let most = 0
class FakeProc extends EventEmitter {
  constructor(bin, args, how) {
    super()
    Object.assign(this, { bin, args, how, killed: [], input: null })
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    running++
    most = Math.max(most, running)
    this.stdin = Object.assign(new EventEmitter(), {
      end: (buf) => {
        this.input = Buffer.from(buf)
        if (how === 'hang') return
        setImmediate(() => {
          if (how === 'enoent') {
            running--
            this.emit('error', Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' }))
            return
          }
          if (how === 'ok') this.stdout.emit('data', JPEG)
          if (how === 'junk') this.stdout.emit('data', Buffer.from('not a picture'))
          if (how === 'fail') this.stderr.emit('data', Buffer.from('Invalid data found when processing input\n'))
          running--
          this.emit('close', how === 'fail' ? 1 : 0)
        })
      }
    })
  }
  kill(sig) {
    this.killed.push(sig)
    running--
    this.emit('close', null)
  }
}
const spawnAs = (how) => (bin, args) => {
  const p = new FakeProc(bin, args, how)
  procs.push(p)
  return p
}

// A camera's recordings as the index reports them: files [{ path, startMs, endMs, open? }] (the test
// may change them between looks), like rec-index.mjs at() and next()
const fakeIndex = (files) => ({
  at: (nvr, ch, t) => [...files].reverse().find((s) => t >= s.startMs && (s.open ? t <= s.startMs + 180_000 : t <= s.endMs)) ?? null,
  next: (nvr, ch, after) => files.find((s) => s.startMs > after) ?? null
})

/** Everything takeSnapshot is given, fake: readers { path: { times, keys: { k: Buffer } } }. */
function rig({ files = [], readers = {}, how = 'ok', onWait = () => {}, ...rest } = {}) {
  const r = { files, readers, waits: [], logs: [], opened: [], closed: 0, clock: T0 + 5000 }
  r.deps = {
    index: fakeIndex(files),
    readerFor: async (seg) => {
      r.opened.push(seg.path)
      const x = r.readers[seg.path]
      if (!x) throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
      return { times: x.times, keyframe: async (k) => (x.keys[k] ? { buf: x.keys[k], ts: x.times[k] } : null), close: async () => { r.closed++ } }
    },
    now: () => r.clock,
    wait: async (ms) => {
      r.waits.push(ms)
      r.clock += ms
      onWait(r)
    },
    spawn: spawnAs(how),
    platform: 'linux',
    log: (l) => r.logs.push(l),
    ...rest
  }
  return r
}
let nextId = 100
const ev = (o = {}) => ({ id: nextId++, nvr: 'nvr1', ch: 3, startMs: T0, seenMs: Date.now() - 60_000, ...o })
const noTmp = () => !existsSync(SNAP_DIR) || readdirSync(SNAP_DIR).every((n) => !n.endsWith('.tmp'))

// ---- the recording is there already ---------------------------------------------------------------
{
  const K = Buffer.from('key at T0+2s')
  const r = rig({
    files: [{ path: '/r/nvr1/3/14-00.h264', startMs: T0 - 20_000, endMs: T0 + 40_000 }],
    readers: { '/r/nvr1/3/14-00.h264': { times: [T0 - 20_000, T0 - 18_000, T0 + 2000, T0 + 4000], keys: { 2: K, 3: Buffer.from('later') } } }
  })
  const e = ev()
  const got = await takeSnapshot(e, r.deps)
  const p = procs.at(-1)
  check('footage on disk already: the picture is taken at once, without waiting', got === snapPath(e.id) && r.waits.length === 0, `${got} waits ${r.waits.length}`)
  check('  the first keyframe at or after start + 1 s went to ffmpeg, and only it', p.input.equals(K))
  check('  ffmpeg behind ionice and nice, with the snapshot arguments (h264 from the file name)',
    p.bin === 'ionice' && p.args.join(' ').startsWith('-c 3 nice -n 10 ffmpeg -hide_banner') && p.args.join(' ').includes('-f h264 -i pipe:0'), `${p.bin} ${p.args.join(' ')}`)
  check('  the JPEG is SNAP_DIR/<id>.jpg, no temp file left', readFileSync(got).equals(JPEG) && noTmp())
  check('  the reader was closed', r.closed === 1 && r.opened.length === 1)
  check('  one line in the log says it was taken and when', r.logs.length === 1 && /taken 2\.0 s after the start/.test(r.logs[0]), r.logs.join(' | '))
  const again = rig()
  const before = procs.length
  check('asked again for the same event: the picture there is returned, no ffmpeg, no index', (await takeSnapshot(e, again.deps)) === got && procs.length === before && again.opened.length === 0)
  const retake = rig({ files: r.files, readers: r.readers })
  const n = procs.length
  check('a picture older than the event row (an id used again) is taken afresh', (await takeSnapshot({ ...e, seenMs: Date.now() + 60_000 }, retake.deps)) === got && procs.length === n + 1)
}

// ---- waiting for the file being written -------------------------------------------------------------
{
  const K = Buffer.from('key written late')
  const path = '/r/nvr1/3/14-00.h264'
  const r = rig({
    files: [{ path, startMs: T0 - 10_000, endMs: null, open: true }],
    readers: { [path]: { times: [T0 - 10_000, T0 - 8000], keys: {} } },
    onWait: (x) => {
      if (x.waits.length === 2) x.readers[path].times.push(T0 + 2000) // its keyframe has started arriving
      if (x.waits.length === 3) x.readers[path].keys[2] = K // and is complete
    }
  })
  const e = ev()
  const got = await takeSnapshot(e, r.deps)
  check('open file: waits (5 s each) until the keyframe after the event is on disk and complete',
    got === snapPath(e.id) && r.waits.join() === '5000,5000,5000' && procs.at(-1).input.equals(K), `waits ${r.waits.join()}`)
  check('  a fresh reader each look, each one closed', r.opened.length === 4 && r.closed === 4)
}

// ---- never recorded -----------------------------------------------------------------------------------
{
  const r = rig()
  const n = procs.length
  const e = ev()
  const got = await takeSnapshot(e, r.deps)
  check('no recording ever: gives up after SNAP_WAIT_MS (36 looks 5 s apart), no ffmpeg',
    got === null && r.waits.length === SNAP_WAIT_MS / SNAP_POLL_MS && procs.length === n, `waits ${r.waits.length}`)
  check('  and says why, once', r.logs.length === 1 && /not taken, the recording has not reached it yet after 3 minutes/.test(r.logs[0]), r.logs.join(' | '))
  check('  no file', !existsSync(snapPath(e.id)))
}

// ---- the keyframe in the next file --------------------------------------------------------------------
{
  const K = Buffer.from('first key of the next file')
  const r = rig({
    files: [
      { path: '/r/a.h264', startMs: T0 - 50_000, endMs: T0 + 1500 },
      { path: '/r/b.h264', startMs: T0 + 1800, endMs: T0 + 61_000 }
    ],
    readers: {
      '/r/a.h264': { times: [T0 - 50_000, T0 - 2000], keys: { 0: Buffer.from('x'), 1: Buffer.from('y') } },
      '/r/b.h264': { times: [T0 + 1800, T0 + 3800], keys: { 0: K } }
    }
  })
  const got = await takeSnapshot(ev(), r.deps)
  check('no keyframe after the moment in its file: the next file\'s first keyframe', got !== null && procs.at(-1).input.equals(K) && r.opened.join() === '/r/a.h264,/r/b.h264', r.opened.join())
}
{
  const K = Buffer.from('b0')
  const r = rig({
    files: [{ path: '/r/a.h264', startMs: T0 - 50_000, endMs: T0 + 500 }, { path: '/r/b.h264', startMs: T0 + 1200, endMs: T0 + 61_000 }],
    readers: { '/r/b.h264': { times: [T0 + 1200], keys: { 0: K } } }
  })
  const got = await takeSnapshot(ev(), r.deps)
  check('the moment between two files: the next file\'s first keyframe', got !== null && procs.at(-1).input.equals(K) && r.opened.join() === '/r/b.h264', r.opened.join())
}
{
  const r = rig({ files: [{ path: '/r/b.h264', startMs: T0 + 60_000, endMs: T0 + 120_000 }] })
  const got = await takeSnapshot(ev(), r.deps)
  check('a gap: the next footage starts a minute later, so no picture and no waiting',
    got === null && r.waits.length === 0 && r.opened.length === 0 && /nothing was recorded from .* until 59 s later/.test(r.logs[0] ?? ''), r.logs.join(' | '))
}
{
  const r = rig({ files: [{ path: '/r/a.h264', startMs: T0 - 10_000, endMs: T0 + 50_000 }], readers: { '/r/a.h264': { times: [T0 - 10_000, T0 + 1000 + SNAP_LATE_MS + 1000], keys: { 1: Buffer.from('z') } } } })
  const got = await takeSnapshot(ev(), r.deps)
  check('a keyframe more than SNAP_LATE_MS after the moment is not used', got === null && r.waits.length === 0 && /first keyframe after .* came 16 s later/.test(r.logs[0] ?? ''), r.logs.join(' | '))
}
{
  // the RAM spool moved the file to a drive between two looks: the index has the new path next time
  const K = Buffer.from('moved')
  const r = rig({
    files: [{ path: '/ram/a.h264', startMs: T0 - 10_000, endMs: T0 + 50_000 }],
    readers: { '/disk/a.h264': { times: [T0 - 10_000, T0 + 2000], keys: { 1: K } } },
    onWait: (x) => { x.files[0].path = '/disk/a.h264' }
  })
  const got = await takeSnapshot(ev(), r.deps)
  check('a file that cannot be opened is looked for again, and found at its new place', got !== null && r.waits.length === 1 && procs.at(-1).input.equals(K))
}
{
  const r = rig({ files: [{ path: '/r/nvr1/3/14-00.h265', startMs: T0 - 10_000, endMs: T0 + 50_000 }], readers: { '/r/nvr1/3/14-00.h265': { times: [T0 + 2000], keys: { 0: Buffer.from('hevc key') } } } })
  await takeSnapshot(ev(), r.deps)
  check('an .h265 file goes to ffmpeg as hevc', procs.at(-1).args.join(' ').includes('-f hevc -i pipe:0'))
}

// ---- ffmpeg's failures --------------------------------------------------------------------------------
const oneFile = () => ({ files: [{ path: '/r/a.h264', startMs: T0 - 10_000, endMs: T0 + 50_000 }], readers: { '/r/a.h264': { times: [T0 + 2000], keys: { 0: Buffer.from('k') } } } })
for (const [how, want, extra] of [
  ['fail', /ffmpeg exited with 1: Invalid data found/, {}],
  ['junk', /ffmpeg gave no JPEG/, {}],
  ['enoent', /ionice is not installed/, {}],
  ['hang', /ffmpeg did not finish within 0\.03 s/, { timeoutMs: 30 }]
]) {
  const r = rig({ ...oneFile(), how, ...extra })
  const e = ev()
  const got = await takeSnapshot(e, r.deps)
  check(`ffmpeg ${how}: no picture, the reason logged once, no file and no temp file`,
    got === null && r.logs.length === 1 && want.test(r.logs[0]) && !existsSync(snapPath(e.id)) && noTmp(), r.logs.join(' | '))
  if (how === 'hang') check('  a hung ffmpeg is killed', procs.at(-1).killed.join() === 'SIGKILL')
}

// ---- once per event, one ffmpeg at a time ---------------------------------------------------------------
{
  const r = rig(oneFile())
  const e = ev()
  const n = procs.length
  const [a, b] = await Promise.all([takeSnapshot(e, r.deps), takeSnapshot(e, r.deps)])
  check('the same event twice at once: one picture taken, both get it', a === snapPath(e.id) && b === a && procs.length === n + 1)
  most = 0
  const got = await Promise.all([ev(), ev(), ev()].map((x) => takeSnapshot(x, rig(oneFile()).deps)))
  check('three events at once: three pictures, ffmpeg never more than one at a time', got.every(Boolean) && most === 1, `most ${most}`)
}
{
  const logs = []
  check('no index (no server recording): null, said once', (await takeSnapshot(ev(), { index: null, log: (l) => logs.push(l) })) === null && /keeps no recordings/.test(logs[0] ?? ''))
  check('an event without an id: null', (await takeSnapshot({ nvr: 'nvr1', ch: 3, startMs: T0 }, { index: fakeIndex([]), log: () => {} })) === null)
}

// ---- real segment files through rec-reader.mjs -----------------------------------------------------------
// Synthetic H.264 as the recorder writes it: GOPs of SPS+PPS+IDR then 9 P frames, one .idx row
// [uint64 LE offset, int64 LE ms] per keyframe. Fill bytes are never zero, so no false start codes.
{
  const nal = (hdr, fill, len) => Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(hdr), Buffer.alloc(len, fill)])
  const keyAU = (fill) => Buffer.concat([nal([0x67, 0x64], fill, 12), nal([0x68], fill, 4), nal([0x65, 0x88], fill, 600)])
  const pAU = (fill) => nal([0x41, 0x9a], fill, 200)
  const dir = join(process.env.DATA_DIR, 'rec', 'nvr1', '3', '2026-09-27', '14')
  mkdirSync(dir, { recursive: true })
  /** Writes GOPs 0..n-1 (keys 1 s apart from T0); returns the file's bytes and its .idx rows. */
  const gops = (n) => {
    const parts = []
    const rows = []
    let at = 0
    for (let g = 0; g < n; g++) {
      const au = [keyAU(0x51 + g), ...Array.from({ length: 9 }, () => pAU(0x61 + g))]
      rows.push({ offset: at, tsMs: T0 + g * 1000 })
      for (const b of au) at += b.length
      parts.push(...au)
    }
    return { buf: Buffer.concat(parts), rows }
  }
  const idxOf = (rows) => {
    const b = Buffer.alloc(16 * rows.length)
    rows.forEach((r, i) => {
      b.writeBigUInt64LE(BigInt(r.offset), i * 16)
      b.writeBigInt64LE(BigInt(r.tsMs), i * 16 + 8)
    })
    return b
  }

  const closed = join(dir, '14-00.h264')
  const c = gops(4)
  writeFileSync(closed, c.buf)
  writeFileSync(`${closed}.idx`, idxOf(c.rows))
  const r1 = rig({ files: [{ path: closed, startMs: T0, endMs: T0 + 3900 }] })
  delete r1.deps.readerFor // the real one: rec-reader.mjs SegmentReader
  const got = await takeSnapshot(ev({ startMs: T0 + 500 }), r1.deps)
  check('a closed segment file: the keyframe at or after start + 1 s is GOP 2\'s SPS+PPS+IDR, exactly',
    got !== null && procs.at(-1).input.equals(keyAU(0x53)), `${procs.at(-1).input.length} bytes`)

  // a file still being written: key 3's row is there but only half of its bytes
  const growing = join(dir, '14-01.h264')
  const g = gops(4)
  const key3 = g.rows[3].offset
  writeFileSync(growing, g.buf.subarray(0, key3 + 300))
  writeFileSync(`${growing}.idx`, idxOf(g.rows))
  const r2 = rig({
    files: [{ path: growing, startMs: T0, endMs: null, open: true }],
    // then the rest of key 3 and the first P frame after it arrive
    onWait: (x) => { if (x.waits.length === 1) appendFileSync(growing, g.buf.subarray(key3 + 300, key3 + keyAU(0x54).length + pAU(0x64).length)) }
  })
  delete r2.deps.readerFor
  const got2 = await takeSnapshot(ev({ startMs: T0 + 1500 }), r2.deps)
  check('a growing file: waits while the keyframe is half written, then sends it whole',
    got2 !== null && r2.waits.length === 1 && procs.at(-1).input.equals(keyAU(0x54)), `waits ${r2.waits.length}, ${procs.at(-1).input.length} bytes, logs ${r2.logs.join(' | ')}`)
}

// ---- the route --------------------------------------------------------------------------------------------
const fakeRes = () => ({
  status: 0, headers: {}, body: null,
  writeHead(s, h) { this.status = s; this.headers = h; return this },
  end(b) { this.body = b }
})
const call = async (id, who, method = 'GET') => {
  const res = fakeRes()
  await handleSnapshot({ method }, res, id, who)
  return res
}
const alice = { user: 'alice', admin: true }
const bob = { user: 'bob', admin: false }
const carol = { user: 'carol', admin: false }
const dave = { user: 'dave', admin: false }
const { event: shown } = addEvent({ nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0, source: 'test' })
const { event: other } = addEvent({ nvr: 'nvr2', ch: 0, type: 'motion', startMs: T0, source: 'test' })
const { event: bare } = addEvent({ nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0 + 60_000, source: 'test' })
mkdirSync(SNAP_DIR, { recursive: true })
writeFileSync(snapPath(shown.id), JPEG)
writeFileSync(snapPath(other.id), JPEG)
{
  const a = await call(shown.id, alice)
  check('an admin gets the JPEG', a.status === 200 && a.headers['content-type'] === 'image/jpeg' && Buffer.from(a.body).equals(JPEG) && a.headers['content-length'] === String(JPEG.length))
  check('  with the security headers, cached privately', a.headers['x-content-type-options'] === 'nosniff' && /^private/.test(a.headers['cache-control']))
  check('server playback of that camera is enough', (await call(shown.id, carol)).status === 200)
  check('  but not for another camera', (await call(other.id, carol)).status === 404)
  check('NVR playback of the whole NVR is enough too', (await call(String(shown.id), dave)).status === 200)
  const b = await call(shown.id, bob)
  check('live only: 404, the same as no event at all', b.status === 404 && JSON.parse(b.body).error === 'No picture for that event')
  check('no such event, or no id: 404', (await call(999999, alice)).status === 404 && (await call('abc', alice)).status === 404 && (await call(0, alice)).status === 404)
  const n = await call(bare.id, alice)
  check('an event whose picture is not there (yet): 404, never cached', n.status === 404 && n.headers['cache-control'] === 'no-store')
  const p = await call(shown.id, alice, 'POST')
  check('anything but GET: 405', p.status === 405 && p.headers.allow === 'GET')
}

// ---- pictures go with their events ---------------------------------------------------------------------
{
  forgetSnapshots([shown.id, 'x', -1, null])
  check('forgetSnapshots removes the pictures named, skipping what is not an id', !existsSync(snapPath(shown.id)) && existsSync(snapPath(other.id)))
  forgetSnapshots([shown.id])
  check('  a picture already gone is fine', true)

  writeFileSync(snapPath(424242), JPEG) // an event that is no longer in the database
  const stale = join(SNAP_DIR, '77.jpg.123.tmp')
  const fresh = join(SNAP_DIR, '78.jpg.123.tmp')
  writeFileSync(stale, 'x')
  writeFileSync(fresh, 'x')
  const old = new Date(Date.now() - 2 * 3_600_000)
  utimesSync(stale, old, old)
  writeFileSync(join(SNAP_DIR, 'readme.txt'), 'not a picture')
  const { removed } = await sweepSnapshots()
  check('sweepSnapshots: a picture whose event is gone is removed, one whose event is there stays',
    !existsSync(snapPath(424242)) && existsSync(snapPath(other.id)) && removed >= 1, `removed ${removed}`)
  check('  an old temp file is removed, a fresh one (a write in progress) stays, other files stay', !existsSync(stale) && existsSync(fresh) && existsSync(join(SNAP_DIR, 'readme.txt')))
  const kept = await sweepSnapshots({ exists: () => { throw new Error('database locked') } })
  check('  events that cannot be read: nothing removed, nothing thrown', kept.removed === 0 && existsSync(snapPath(other.id)))
}

closeEvents()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run the test and see it fail (local)**

Run from the repo root: `node cctv/test/event-snapshot.test.mjs`

Expected: FAIL. It stops with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...cctv/event-snapshot.mjs' imported from ...cctv/test/event-snapshot.test.mjs` and exits with code 1.

- [ ] **Step 3: Write `cctv/event-snapshot.mjs`**

```js
// A picture for an event: one JPEG made from the server's own recording just after the event
// started, kept beside the event and shown on the Alarms page and at an alert's link.
//
// Why from our recording rather than from the camera or the NVR: it works on every camera type (the
// camera's own "target picture" exists only on some AI models), it asks nothing of the NVR (nvr-2 is
// at its bandwidth ceiling), and it is the footage an export would give, so the picture and the
// evidence cannot disagree.
//
// How: the recorder writes each camera in one-minute files, and a file is indexed only once it
// closes, so a crossing seen within seconds (alarm-watch.mjs) is rarely in a closed file yet.
// takeSnapshot therefore waits: every SNAP_POLL_MS it asks the index for the footage at the event
// start + 1 s (the file being written counts: rec-index.mjs at() and next() return it), and as soon
// as the first keyframe at or after that moment is on disk it hands that one keyframe to ffmpeg,
// which makes a JPEG at most 1280 wide. A keyframe decodes on its own (it carries its parameter
// sets; the export stills in export-job.mjs rely on the same), so no other frame is read. After
// SNAP_WAIT_MS it gives up and logs why. A keyframe more than SNAP_LATE_MS after that moment would
// show something else (a gap, a stalled camera), so there is no picture rather than a wrong one.
//
// ffmpeg runs one at a time and at low priority (transcode.mjs niceWrap): a burst of crossings must
// not take the cores the recorder needs. Files: DATA_DIR/event-snaps/<event id>.jpg, written under a
// temp name and renamed, so a half-written picture is never served. A picture goes when its event
// goes (sweepSnapshots, from the server's 5-minute housekeeping).
//
//   GET /api/events/:id/snapshot -> the JPEG, for a user who may play that camera back (rights.mjs)
//
// Nothing here imports sdk.mjs: the tests run on any machine (ffmpeg's own part on the server).
import { spawn as nodeSpawn } from 'node:child_process'
import { rmSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DATA_DIR } from './auth.mjs'
import { getEvent } from './events-db.mjs'
import { CODEC, SegmentReader, codecOfPath, keyAtOrAfter } from './rec-reader.mjs'
import { can } from './rights.mjs'
import { securityHeaders } from './security.mjs'
import { niceWrap } from './transcode.mjs'

export const SNAP_DIR = join(DATA_DIR, 'event-snaps')
/** How long a picture waits for the recording to reach the event (the open file closes every minute). */
export const SNAP_WAIT_MS = 3 * 60_000
/** How often it looks again meanwhile. */
export const SNAP_POLL_MS = 5000
/** The picture is of this long after the start: the start is the alarm's first second, and what crossed is in the picture a second later. */
export const SNAP_AFTER_MS = 1000
/** A keyframe further than this past that moment shows something else (a gap, a stalled camera): no picture then. */
export const SNAP_LATE_MS = 15_000
/** One keyframe decodes in well under a second; an ffmpeg still running after this is killed. */
export const SNAP_FFMPEG_MS = 20_000
/** Far more than one JPEG of at most 1280 wide: an ffmpeg writing this much is not doing what it was asked. */
const MAX_JPEG_BYTES = 8 * 1024 * 1024
/** A temp file this old was left by a crash mid-write (a finished write renames it at once). */
const STALE_TMP_MS = 60 * 60_000
const SECURITY_HEADERS = securityHeaders()

const isEventId = (id) => Number.isSafeInteger(id) && id > 0
const stamp = (ms) => new Date(ms).toISOString()

/** The picture file of one event. Throws for anything but a positive whole number, so no request text ever becomes a path. */
export function snapPath(eventId) {
  const id = Number(eventId)
  if (!isEventId(id)) throw new Error(`not an event id: ${eventId}`)
  return join(SNAP_DIR, `${id}.jpg`)
}

/**
 * ffmpeg's arguments: one keyframe in on stdin (raw Annex B), one JPEG out on stdout, scaled down to
 * 1280 wide when the picture is wider (the height follows and is kept even; a smaller picture is
 * not enlarged). -q:v 4 is a clear picture at a modest size (export stills use 2, near lossless).
 * @param {0|1} codec CODEC.h264 / CODEC.h265
 */
export function snapArgs(codec) {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', codec === CODEC.h265 ? 'hevc' : 'h264', '-i', 'pipe:0',
    '-frames:v', '1',
    // the quotes are for ffmpeg's filter parser (the comma inside min() would split the filter), not
    // for a shell: there is none
    '-vf', "scale='min(1280,iw)':-2",
    '-q:v', '4',
    // image2pipe: the image2 muxer's form for a pipe, one JPEG and no file name pattern
    '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'
  ]
}

const isJpeg = (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9

/** One keyframe through ffmpeg: resolves the JPEG bytes, rejects with why not. */
function toJpeg(keyBuf, codec, { ffmpeg, spawn, platform, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const { bin, args } = niceWrap(ffmpeg, snapArgs(codec), { platform, hasIonice: platform === 'linux' })
    let proc
    try {
      proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      reject(e)
      return
    }
    const out = []
    let bytes = 0
    let err = ''
    let settled = false
    const settle = (e, buf) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (e) reject(e)
      else resolve(buf)
    }
    const kill = () => {
      try {
        proc.kill('SIGKILL')
      } catch {}
    }
    // settled first, then killed: the kill's own 'close' must not replace the reason
    const timer = setTimeout(() => {
      settle(new Error(`ffmpeg did not finish within ${timeoutMs / 1000} s`))
      kill()
    }, timeoutMs)
    proc.stdout.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_JPEG_BYTES) {
        settle(new Error('ffmpeg wrote far more than one picture'))
        kill()
        return
      }
      out.push(chunk)
    })
    proc.stderr?.on('data', (chunk) => {
      err = (err + String(chunk)).slice(-300)
    })
    proc.on('error', (e) => settle(e.code === 'ENOENT' ? new Error(`${bin} is not installed (deploy/install-ubuntu.sh installs ffmpeg)`) : e))
    proc.on('close', (code) => {
      const buf = Buffer.concat(out)
      if (code !== 0) settle(new Error(`ffmpeg exited with ${code}${err.trim() ? `: ${err.trim()}` : ''}`))
      else if (!isJpeg(buf)) settle(new Error('ffmpeg gave no JPEG'))
      else settle(null, buf)
    })
    // an ffmpeg that quits early gives EPIPE here; its exit code says why
    proc.stdin.on('error', () => {})
    proc.stdin.end(keyBuf)
  })
}

// ffmpeg one at a time: a burst of crossings takes turns rather than starting a process each
let turn = Promise.resolve()
function oneAtATime(fn) {
  const run = turn.then(fn)
  turn = run.catch(() => {})
  return run
}

/** A reader for one index row; the file being written is read as growing (rec-reader.mjs). */
const openReader = (seg) => new SegmentReader({ path: seg.path, endMs: seg.endMs ?? null, growing: Boolean(seg.open) }).open()

/**
 * The first keyframe at or after t: { key: { buf, ts, codec } }, { wait: why } (not on disk yet: look
 * again later) or { none: why } (there will never be one close enough).
 */
async function findKeyframe(index, nvr, ch, t, readerFor) {
  let seg = index.at(nvr, ch, t)
  if (!seg) {
    // t is in no file: not recorded yet, or in a gap (then a file after it exists already)
    seg = index.next(nvr, ch, t)
    if (!seg) return { wait: 'the recording has not reached it yet' }
  }
  // t's own file, then the next one (the keyframe after t may start the next file)
  for (let files = 0; files < 2; files++) {
    if (seg.startMs - t > SNAP_LATE_MS) return { none: `nothing was recorded from ${stamp(t)} until ${Math.round((seg.startMs - t) / 1000)} s later` }
    let r
    try {
      r = await readerFor(seg)
    } catch (e) {
      // a file moved from the RAM spool to a drive (the index has its new place next time), or removed
      return { wait: `${seg.path} could not be read (${e.code ?? e.message})` }
    }
    try {
      const k = keyAtOrAfter(r.times, t)
      if (k >= 0) {
        if (r.times[k] - t > SNAP_LATE_MS) return { none: `the first keyframe after ${stamp(t)} came ${Math.round((r.times[k] - t) / 1000)} s later` }
        const kf = await r.keyframe(k)
        // (copied: the reader's buffer is not ours to keep)
        if (kf) return { key: { buf: Buffer.from(kf.buf), ts: kf.ts, codec: codecOfPath(seg.path) } }
        if (seg.open) return { wait: 'its keyframe is still being written' }
        return { none: `the keyframe at ${stamp(r.times[k])} could not be read` }
      }
      if (seg.open) return { wait: 'no keyframe after it has been recorded yet' }
    } finally {
      await r.close?.()
    }
    const after = index.next(nvr, ch, seg.startMs)
    if (!after) return { wait: 'the next file has not been started yet' }
    seg = after
  }
  return { none: `no keyframe after ${stamp(t)} in the two files that follow it` }
}

async function snap(event, id, file, o) {
  const label = `${event.nvr}/${event.ch} event ${id}`
  if (!o.index) {
    o.log(`[snapshot] ${label}: not taken, this server keeps no recordings of its own`)
    return null
  }
  const t = Number(event.startMs) + SNAP_AFTER_MS
  if (!Number.isFinite(t)) {
    o.log(`[snapshot] ${label}: not taken, the event has no start time`)
    return null
  }
  const until = o.now() + SNAP_WAIT_MS
  let why = ''
  for (;;) {
    const found = await findKeyframe(o.index, String(event.nvr), Number(event.ch), t, o.readerFor)
    if (found.key) {
      const jpeg = await oneAtATime(() => toJpeg(found.key.buf, found.key.codec, o))
      await mkdir(SNAP_DIR, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      try {
        await writeFile(tmp, jpeg)
        await rename(tmp, file)
      } finally {
        await rm(tmp, { force: true })
      }
      o.log(`[snapshot] ${label}: taken ${((found.key.ts - t + SNAP_AFTER_MS) / 1000).toFixed(1)} s after the start (${jpeg.length} bytes)`)
      return file
    }
    if (found.none) {
      o.log(`[snapshot] ${label}: not taken, ${found.none}`)
      return null
    }
    why = found.wait
    if (o.now() >= until) break
    await o.wait(SNAP_POLL_MS)
  }
  o.log(`[snapshot] ${label}: not taken, ${why} after ${SNAP_WAIT_MS / 60_000} minutes`)
  return null
}

const inFlight = new Map() // event id -> its picture being taken (a crossing that lasts is reported again)

/**
 * Takes an event's picture from the server's recording (see the top). Never throws: every failure is
 * logged once and resolves null. Called again for the same event (a crossing is reported again while
 * it lasts), it joins the picture being taken or returns the one already there.
 * @param {{ id: number, nvr: string, ch: number, startMs: number, seenMs?: number }} event an events-db row
 * @param {{ index: object|null, readerFor?: (seg: object) => Promise<object>, ffmpeg?: string,
 *           now?: () => number, wait?: (ms: number) => Promise<void>, spawn?: Function,
 *           platform?: string, timeoutMs?: number, log?: (line: string) => void }} deps
 *   index: nvrs.mjs recIndex() (null without server recording); readerFor(seg): an opened reader
 *   ({ times, keyframe(k), close() }, default rec-reader.mjs SegmentReader); ffmpeg: the binary;
 *   now/wait: the clock and the pause between looks; spawn/platform/timeoutMs: for the tests
 * @returns {Promise<string|null>} the JPEG's path, or null
 */
export async function takeSnapshot(event, { index, readerFor = openReader, ffmpeg = 'ffmpeg', now = Date.now, wait = (ms) => sleep(ms, undefined, { ref: false }), spawn = nodeSpawn, platform = process.platform, timeoutMs = SNAP_FFMPEG_MS, log = console.log } = {}) {
  const id = Number(event?.id)
  if (!isEventId(id)) {
    log('[snapshot] not taken: the event has no id')
    return null
  }
  const file = snapPath(id)
  // already taken; a file older than the event's row belonged to an earlier event with the same id
  // (SQLite can hand out the id of a deleted newest row again) and is taken afresh
  let st = null
  try {
    st = statSync(file, { throwIfNoEntry: false })
  } catch {} // unreadable: taken again, and writing it will say what is wrong
  if (st && !(st.mtimeMs < Number(event.seenMs))) return file
  if (inFlight.has(id)) return inFlight.get(id)
  const job = snap(event, id, file, { index, readerFor, ffmpeg, now, wait, spawn, platform, timeoutMs, log })
    .catch((e) => {
      log(`[snapshot] ${event.nvr}/${event.ch} event ${id}: not taken, ${e.message}`)
      return null
    })
    .finally(() => inFlight.delete(id))
  inFlight.set(id, job)
  return job
}

/**
 * GET /api/events/:id/snapshot: the event's picture, for someone who may play that camera back (from
 * the server or the NVR: the same rule as the /playback socket). Everything else is a bare 404, an
 * event on a camera the user may not see included: that it exists is not theirs to know either.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {number|string} eventId from the URL
 * @param {{ user: string, admin: boolean }} who from the session (server.mjs), never from the request
 */
export async function handleSnapshot(req, res, eventId, who) {
  const answer = (status, body, headers) => {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers })
    res.end(body)
  }
  if (req.method !== 'GET') return answer(405, JSON.stringify({ error: 'Method not allowed' }), { 'content-type': 'application/json', allow: 'GET' })
  // no-store: the picture of a crossing seen seconds ago is usually still being taken
  const missing = () => answer(404, JSON.stringify({ error: 'No picture for that event' }), { 'content-type': 'application/json', 'cache-control': 'no-store' })
  const id = Number(eventId)
  if (!isEventId(id)) return missing()
  const ev = getEvent(id)
  const cam = ev ? { nvr: ev.nvr, ch: ev.ch } : null
  if (!cam || !(can(who, 'playback-server', cam) || can(who, 'playback-nvr', cam))) return missing()
  let jpeg
  try {
    jpeg = await readFile(snapPath(id))
  } catch {
    return missing() // not taken (yet, or at all)
  }
  // private: the next user of this browser may not be allowed this camera
  answer(200, jpeg, { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length), 'cache-control': 'private, max-age=300' })
}

/** Removes these events' pictures. Anything that is not an event id is skipped; a missing picture is fine. */
export function forgetSnapshots(eventIds) {
  for (const raw of eventIds ?? []) {
    const id = Number(raw)
    if (!isEventId(id)) continue
    try {
      rmSync(snapPath(id), { force: true })
    } catch (e) {
      console.warn(`[snapshot] could not remove the picture of event ${id}: ${e.message}`)
    }
  }
}

/**
 * Removes every picture whose event is gone, and temp files a crash left behind. Events go by
 * events-db forgetEventsBefore (acknowledged ones stay, and so do their pictures); this looks at
 * the pictures instead of being told which rows went, so a picture never outlives its event,
 * whatever removed the row. One indexed lookup per picture. Never throws: it runs in the server's
 * housekeeping chain, and a failure must not stop the jobs after it.
 * @param {{ exists?: (id: number) => boolean, now?: () => number }} [o]
 * @returns {Promise<{ removed: number }>}
 */
export async function sweepSnapshots({ exists = (id) => getEvent(id) !== null, now = Date.now } = {}) {
  let names
  try {
    names = await readdir(SNAP_DIR)
  } catch {
    return { removed: 0 } // no picture taken yet
  }
  const gone = []
  for (const name of names) {
    const m = /^(\d{1,15})\.jpg$/.exec(name)
    if (m) {
      try {
        if (!exists(Number(m[1]))) gone.push(Number(m[1]))
      } catch (e) {
        // the events could not be read: nothing is removed on a guess
        console.warn(`[snapshot] sweep stopped: ${e.message}`)
        return { removed: 0 }
      }
    } else if (name.endsWith('.tmp')) {
      try {
        const p = join(SNAP_DIR, name)
        if (now() - (await stat(p)).mtimeMs > STALE_TMP_MS) await rm(p, { force: true })
      } catch {}
    }
  }
  forgetSnapshots(gone)
  if (gone.length) console.log(`[snapshot] removed ${gone.length} picture(s) of events that are gone`)
  return { removed: gone.length }
}
```

- [ ] **Step 4: Run the local test and see it pass**

Run from the repo root: `node cctv/test/event-snapshot.test.mjs`

Expected:
- 51 lines starting `PASS`, and no `FAIL`.
- Two log lines printed along the way: `[snapshot] removed N picture(s) of events that are gone` and `[snapshot] sweep stopped: database locked`.
- The last line is `all passed`, with exit code 0.

- [ ] **Step 5: Wire `cctv/server.mjs` (four edits)**

Edit 1, the route list in the header comment (line 43). Find:
```js
//   WS   /motion?nvr=ID&...    -> motion search inside a box, see motion.mjs
```
Replace with:
```js
//   WS   /motion?nvr=ID&...    -> motion search inside a box, see motion.mjs
//   GET  /api/events/:id/snapshot -> an event's picture (JPEG), for users who may play that
//                                 camera back, see event-snapshot.mjs
```

Edit 2, the imports (line 117). Find:
```js
import { handleEvents } from './events.mjs'
```
Replace with:
```js
import { handleEvents } from './events.mjs'
import { handleSnapshot, sweepSnapshots } from './event-snapshot.mjs'
```

Edit 3, the 5-minute housekeeping chain inside `if (LIVE_WORKER)` (lines 181-185). Find:
```js
      .then(() => thinAndRetain())
      .catch((e) => console.warn(`[housekeeping] failed: ${e.message}`))
```
Replace with:
```js
      .then(() => thinAndRetain())
      // pictures of events that are gone (event-snapshot.mjs; it never throws)
      .then(() => sweepSnapshots())
      .catch((e) => console.warn(`[housekeeping] failed: ${e.message}`))
```

Edit 4, the route. It goes after the session check and `who`, before `handleEvents` (currently line 574). Find:
```js
  // alarms and events of cameras this user may not see stay out of their lists (rights.mjs): watching
```
Replace with:
```js
  // An event's picture (event-snapshot.mjs): a JPEG, not JSON, so it is answered here, before the JSON
  // routes; who may see it is decided inside (a playback right for that camera)
  const snapRoute = /^\/api\/events\/(\d{1,15})\/snapshot$/.exec(pathname)
  if (snapRoute) return handleSnapshot(req, res, snapRoute[1], who)
  // alarms and events of cameras this user may not see stay out of their lists (rights.mjs): watching
```

- [ ] **Step 6: Syntax-check `server.mjs` (local)**

Run from the repo root: `node --check cctv/server.mjs`

Expected: no output and exit code 0. `server.mjs` itself cannot be loaded on the PC because it imports `sdk.mjs`, which needs koffi. The route runs for real in the live test in Task 8.

- [ ] **Step 7: Write the server-only ffmpeg test `cctv/test/event-snapshot-ffmpeg.test.mjs`**

```js
// The real ffmpeg behind event pictures (event-snapshot.mjs). ffmpeg is installed on the server
// only, so this runs there: video made by ffmpeg itself (its test pattern) goes through takeSnapshot
// and must come back as a JPEG of the right size. One keyframe through a fake reader, H.264 and
// (when this ffmpeg has libx265) H.265; and a 1080p H.264 segment file with its .idx, read by
// rec-reader.mjs, which also proves the scale filter's quoting (1920 wide comes back 1280 x 720).
// ffmpeg runs behind ionice and nice here exactly as in the service.
//   node cctv/test/event-snapshot-ffmpeg.test.mjs        (on the server copy)
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-snap-ffmpeg-test-'))
const { snapPath, takeSnapshot } = await import('../event-snapshot.mjs')
const { CODEC, splitUnits } = await import('../rec-reader.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 27, 14, 0, 0)

/** Raw Annex B from ffmpeg's test pattern: 10 fps, a keyframe every `gop` frames exactly, no B-frames. */
function testVideo({ size, codec = 'h264', frames = 1, gop = 10 }) {
  const enc = codec === 'h265'
    ? ['-c:v', 'libx265', '-x265-params', `log-level=error:keyint=${gop}:min-keyint=${gop}:scenecut=0:open-gop=0`]
    : ['-c:v', 'libx264', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0']
  return execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=10`,
    '-frames:v', String(frames), ...enc, '-bf', '0', '-pix_fmt', 'yuv420p',
    '-f', codec === 'h265' ? 'hevc' : 'h264', 'pipe:1'
  ], { maxBuffer: 64 * 1024 * 1024 })
}

/** Width and height from a JPEG's frame header (SOF0-SOF15, not DHT/JPG/DAC), or null. */
function jpegSize(b) {
  if (!(b[0] === 0xff && b[1] === 0xd8)) return null
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return null
    const m = b[i + 1]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)}`
    i += 2 + b.readUInt16BE(i + 2)
  }
  return null
}

const logs = []
/** One file whose only keyframe is buf, 2 s after the event: nothing to wait for. */
const oneKey = (buf, path) => ({
  index: { at: () => ({ path, startMs: T0, endMs: T0 + 60_000 }), next: () => null },
  readerFor: async () => ({ times: [T0 + 2000], keyframe: async () => ({ buf, ts: T0 + 2000 }), close: async () => {} }),
  wait: async () => { throw new Error('nothing should wait: the recording is there') },
  log: (l) => logs.push(l)
})

// ---- one keyframe, H.264 ----------------------------------------------------------------------------
{
  const key = testVideo({ size: '320x240' })
  const got = await takeSnapshot({ id: 1, nvr: 'nvr1', ch: 0, startMs: T0 }, oneKey(key, '/x/nvr1/0/14-00.h264'))
  const size = got ? jpegSize(readFileSync(got)) : null
  check('an H.264 keyframe from ffmpeg becomes a JPEG', got === snapPath(1), logs.join(' | '))
  check('  320x240 stays 320x240 (a smaller picture is not enlarged)', size === '320x240', size)
}

// ---- one keyframe, H.265 (when this ffmpeg can make one) ------------------------------------------
{
  const encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString()
  if (!encoders.includes('libx265')) {
    console.log('SKIP  H.265: this ffmpeg has no libx265 to make a test picture with')
  } else {
    const key = testVideo({ size: '640x360', codec: 'h265' })
    const got = await takeSnapshot({ id: 2, nvr: 'nvr1', ch: 0, startMs: T0 }, oneKey(key, '/x/nvr1/0/14-00.h265'))
    const size = got ? jpegSize(readFileSync(got)) : null
    check('an H.265 keyframe (an .h265 file, fed as hevc) becomes a 640x360 JPEG', got === snapPath(2) && size === '640x360', `${size} ${logs.join(' | ')}`)
  }
}

// ---- a 1080p segment file read by rec-reader.mjs ----------------------------------------------------
{
  const video = testVideo({ size: '1920x1080', frames: 30, gop: 10 })
  const keys = splitUnits(video, CODEC.h264).units.filter((u) => u.isKey)
  check('the test segment has 3 keyframes, 1 s apart', keys.length === 3, `${keys.length}`)
  const dir = join(process.env.DATA_DIR, 'rec', 'nvr1', '0', '2026-09-27', '14')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, '14-00.h264')
  writeFileSync(path, video)
  // the recorder's .idx: one 16-byte row per keyframe [uint64 LE offset, int64 LE ms]
  const idx = Buffer.alloc(16 * keys.length)
  keys.forEach((u, g) => {
    idx.writeBigUInt64LE(BigInt(u.start), g * 16)
    idx.writeBigInt64LE(BigInt(T0 + g * 1000), g * 16 + 8)
  })
  writeFileSync(`${path}.idx`, idx)
  const deps = {
    index: { at: () => ({ path, startMs: T0, endMs: T0 + 2900 }), next: () => null },
    wait: async () => { throw new Error('nothing should wait: the recording is there') },
    log: (l) => logs.push(l)
  }
  const got = await takeSnapshot({ id: 3, nvr: 'nvr1', ch: 0, startMs: T0 + 500 }, deps)
  const size = got ? jpegSize(readFileSync(got)) : null
  check('a segment file: the keyframe after start + 1 s becomes a JPEG', got === snapPath(3), logs.join(' | '))
  check('  1920x1080 comes back 1280x720 (the scale filter works as quoted)', size === '1280x720', size)
  check('  taken from the keyframe 2 s in (start + 1.5 s)', logs.some((l) => /event 3: taken 1\.5 s after the start/.test(l)), logs.join(' | '))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 8: Run the ffmpeg test on the server copy**

Run on the server copy: see Task 8 Step 1. The command is `node cctv/test/event-snapshot-ffmpeg.test.mjs`. It cannot run on the PC, which has no ffmpeg.

Expected:
- 7 `PASS` lines, or 6 `PASS` lines and `SKIP  H.265: ...` if the server's ffmpeg has no libx265.
- The last line is `all passed`, with exit code 0.
- If the size check fails with anything other than `1280x720`, the `scale='min(1280,iw)':-2` quoting in `snapArgs` is wrong. Fix it there, then rerun both tests.

- [ ] **Step 9: Commit**

```bash
git add cctv/event-snapshot.mjs cctv/server.mjs cctv/test/event-snapshot.test.mjs cctv/test/event-snapshot-ffmpeg.test.mjs
git commit -F - <<'EOF'
Event snapshots: a JPEG per event from the server's own recording

takeSnapshot waits (up to 3 min, looking every 5 s) until the recording holds
the event start + 1 s, sends the first keyframe at or after it through ffmpeg
(one at a time, behind ionice/nice) and keeps DATA_DIR/event-snaps/<id>.jpg.
GET /api/events/:id/snapshot serves it to users with a playback right for the
camera (a bare 404 otherwise). forgetEventsBefore has no caller yet, so the
5-minute housekeeping sweeps away pictures whose event row is gone.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Lines panel for drawing lines, settings, Save/Undo and phone alert, plus the Lines button on Live

> **Cross-task corrections (binding - apply these where the steps below differ):**
>
> 1. showResult builds the status only from resultView(fields). It ignores Task 2's `result.message`, which carries the NVR's refusal code ('Not changed: the NVR refused (536870947)'), 'the NVR did not answer in time' and the SDK error text. When the NVR refuses or the send throws, the panel shows only 'Not saved: the camera kept its settings.' and the admin never sees why.
>
>    **Fix:** In Task 7 Step 8 showResult, after `el('p', {}, v.headline),` insert:
> ```js
>       result?.message && v.status !== 'done' ? el('p', { className: 'ln-note' }, result.message) : '',
> ```


**Files:**
- Create: `cctv/public/lines-geom.js`. Pure geometry: camera units, A/B sides, the direction arrow, and what a press on the picture picks up.
- Create: `cctv/public/lines-panel.js`. Contains `LinesPanel` and the pure helpers the tests use.
- Modify: `cctv/public/viewer.js`. Line numbers are from the current file:
  - line 7: import
  - lines 78-84: after the `imagePanel` block
  - line 173: render keep list
  - lines 593-601: Picture click and the new Lines button
  - lines 607-609: click on the full-size view
  - line 614: attachZoom
  - lines 635-636: re-append on rebuild
  - line 657: closeSingle
  - line 781: relayout
  - line 925: Escape
  - line 1088: stepCamera
  - line 1117: flick handler
- Modify: `cctv/public/style.css`. New block after lines 863-865, the `@media (max-width: 600px) { .img-panel … }` rule that ends the Picture panel styles.
- Test: `cctv/test/lines-geom.test.mjs` (new) and `cctv/test/lines-panel.test.mjs` (new). Both are pure and run locally.
- Needs from Task 1: `cctv/tripwire-xml.mjs` and `cctv/test/fixtures/lines/*.xml`. `lines-panel.test.mjs` reads them to check that the panel's change passes the server's own `checkChange`.
- In this Windows checkout, `viewer.js` and `style.css` have CRLF line endings in the working tree (git stores LF). Match the anchors line by line (the Edit tool does this) and do not change line endings.

**Interfaces:**

Consumes, all read from the code:
- `cctv/public/colour-check-ui.js`:
  - `pictureRect(box, iw, ih, fit = 'contain', position = [0.5, 0.5]) -> { left, top, width, height } | null`
  - `objectPosition(css) -> [fx, fy]`
  - `clientToPicture(x, y, pic) -> [u, v]`
  - `overlayBox(pic, hostBox, dpr) -> { left, top, width, height, backingWidth, backingHeight }`
  - `pictureToOverlay([u, v], ov) -> [x, y]`
  - `loupeSpot(x, y, R, off, [W, H], avoid) -> [cx, cy]`
- `cctv/public/pinch-zoom.js`: `attachZoom(el, { apply, rect?, max?, busy? }) -> { reset(), zoom, reapply() }`. While `busy()` is true, all gestures are ignored.
- `cctv/public/image-panel.js` `ImagePanel`: `.key`, `.el`, `.open(cam, { opener })`, `.close()`, `.requestClose() -> boolean`, `.confirmDiscard() -> boolean`. The CSS classes `.img-panel`, `.ip-head`, `.ip-close`, `.ip-cam`, `.ip-switch`, `.ip-result.ip-<status>`, `.ip-status`, `.ip-error`, `.ip-undo`, `.ip-undo-note`, `.ip-actions`, `.ip-apply`, `.ip-revert`, `.ip-dialog`, `.ip-dialog-buttons`, `.ip-go` and `.ip-acks` are reused so the panel looks like Picture.
- `cctv/public/viewer.js`: `shownPlayer() -> { player, stream, remote } | null`, `player.canvas` (player.js:129), `camKey(cam)`, `overlayZoom`, `grid`.
- Task 2:
  - `GET /api/admin/nvrs/:id/channels/:ch/lines -> 200 { lines: { supported, cfg, schedules: [{ id, name }], device, seen, undo: { seq, at, by } | null, ntfy: { topicSet } } }`
  - `POST` the same URL with `{ device, seen, change, ack?, ackToken?, confirm: true }` or `{ device, undo: true, seq, ack?, ackToken?, confirm: true }`. Answers:
    - `200 { lines, result: { fields: [{ key, want, got, status }], sideEffects: [{ key, from, to }], warningsAcked } }`
    - `409 { error, stale: true }`
    - `409 { error, needsAck: [{ key, text }], ackToken }`
  - `cfg` is Task 1's `parseTripwire` shape.
- Task 5: `POST /api/admin/lines/alert { nvr, ch, on } -> { rule, ntfy: { topic, created } }`. An `ntfy.url` is used when present. The rule is named `'Line crossing'`.
- Existing: `GET /api/alarms/rules -> { rules, admin }` (alarms.mjs:199). A rule is `{ name, enabled, notify, cameras: ['<nvr>/<ch>'] }` (events-db.mjs `toRule`; event-rules.mjs `cameraKey`).
- Tests only, from Task 1 `cctv/tripwire-xml.mjs`: `parseTripwire`, `parseSchedules`, `checkChange`, `applyChange`, `compareReadBack`.

Produces:
- `cctv/public/lines-geom.js`:
  - `UNITS`, `DIRECTIONS` (`['rightortop','leftorbotton','none']`), `MIN_LINE_UNITS` (500)
  - `toUnits(frac) -> int 0..10000`, `toFrac(units)`, `lineLength(a, b)`, `isSet(line)`
  - `sideOf(p, a, b) -> 'A'|'B'`
  - `arrowFor(line) -> { mid, dir, both, toA } | null`
  - `nextDirection(d, allowed = DIRECTIONS)`
  - `hitTest(point, lines, radius) -> { slot, end: 'start'|'end'|'arrow' } | null`
  - `slotForNewLine(lines, selected) -> index | -1`
  - This is the contract's set with two additions. `arrowFor` also returns `both` (true for `'none'`) and `toA`. `hitTest`'s third argument (the contract's `radiusUnits`) is in the same coordinate space as the points. The panel passes screen pixels, because camera units are not square on screen.
- `cctv/public/lines-panel.js`:
  - `export class LinesPanel { constructor(host, cam, { liveEl, opener?, onClose? }); open(); close(); requestClose() -> boolean; confirmDiscard(n?) -> boolean; get key; isOpen; el }`
  - Pure exports: `LINE_RULE_NAME`, `ALERT_URL`, `DIRECTION_WORDS`, `CLASS_WORDS`, `draftOf`, `changeOf`, `slotText`, `changeLines`, `saveLabel`, `scheduleChoices`, `mutexOn`, `blockedText`, `undoText`, `fieldLabel`, `valueText`, `resultView`, `alertOn`, `autoAlert`, `alertNote`, `ntfyHelp`.
- `viewer.js`: a **Lines** button beside **Picture** for admins. It is shown only when `GET …/lines` says `supported`, and that is asked once per camera while the page is open. Pinch-zoom is paused while the panel is open, and the two panels are never open at the same time.

- [ ] **Step 1: Write the failing geometry test**

Create `cctv/test/lines-geom.test.mjs`:

```js
// The line maths of the Lines panel (public/lines-geom.js): the camera's 0..10000 coordinates, which
// side of a line is A, the direction arrow, the order a tap on it goes through, and what a press on
// the picture picks up. No DOM.
//   node cctv/test/lines-geom.test.mjs
import { DIRECTIONS, MIN_LINE_UNITS, UNITS, arrowFor, hitTest, isSet, lineLength, nextDirection, sideOf, slotForNewLine, toFrac, toUnits } from '../public/lines-geom.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const near = (a, b, tol = 1e-9) => Number.isFinite(a) && Math.abs(a - b) <= tol
const show = (x) => JSON.stringify(x)
const P = (x, y) => ({ x, y })
const L = (direction, sx, sy, ex, ey) => ({ direction, start: P(sx, sy), end: P(ex, ey) })

// ---- the camera's coordinates -------------------------------------------------------------------
check('toUnits: fractions to whole camera units, both edges included', toUnits(0) === 0 && toUnits(1) === 10000 && toUnits(0.5) === 5000 && toUnits(0.1234) === 1234, show([toUnits(0.1234)]))
check('  always a whole number (the camera takes integers only)', toUnits(1 / 3) === 3333 && toUnits(2 / 3) === 6667)
check('  a drag past the edge stops at it', toUnits(-0.2) === 0 && toUnits(1.3) === 10000)
check('  not a number: 0', toUnits(Number.NaN) === 0 && toUnits(undefined) === 0)
check('toFrac: back to a fraction of the picture', toFrac(2500) === 0.25 && toFrac(UNITS) === 1 && toFrac(0) === 0)
check('lineLength: straight distance', lineLength(P(0, 0), P(300, 400)) === 500)
check('MIN_LINE_UNITS is 5% of the picture (the server refuses shorter: tripwire-xml.mjs MIN_LINE_FRACTION)', MIN_LINE_UNITS === 0.05 * UNITS)
check('isSet: all four zero is an unset slot; a line from the corner is set', !isSet(L('rightortop', 0, 0, 0, 0)) && isSet(L('none', 0, 0, 600, 0)) && !isSet(null))

// ---- A and B: A is on the left of start -> end as seen on screen (Y down) ---------------------------
{
  const a = P(1000, 5000)
  const b = P(9000, 5000) // across the middle, drawn left to right
  check('drawn left to right: above the line is A, below it is B', sideOf(P(5000, 1000), a, b) === 'A' && sideOf(P(5000, 9000), a, b) === 'B')
  check('  the same line drawn right to left: the sides swap', sideOf(P(5000, 1000), b, a) === 'B' && sideOf(P(5000, 9000), b, a) === 'A')
  check('drawn top to bottom: A is the screen\'s right (the left of someone walking down it)', sideOf(P(9000, 5000), P(5000, 1000), P(5000, 9000)) === 'A' && sideOf(P(1000, 5000), P(5000, 1000), P(5000, 9000)) === 'B')
  check('a point on the line counts as A', sideOf(P(5000, 5000), a, b) === 'A')
  // camera units -> a 1920 x 1080 picture on screen: x and y are stretched by different amounts
  const toScreen = (p) => P(p.x * 0.192, p.y * 0.108)
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) % 10001
  let same = true
  for (let i = 0; i < 200; i++) {
    const [p, s, e] = [P(rnd(), rnd()), P(rnd(), rnd()), P(rnd(), rnd())]
    if (sideOf(p, s, e) !== sideOf(toScreen(p), toScreen(s), toScreen(e))) same = false
  }
  check('stretching the picture to the screen never moves a point to the other side (200 random cases)', same)
}

// ---- the arrow -------------------------------------------------------------------------------------
{
  const a = P(0, 0)
  const b = P(100, 0)
  const ab = arrowFor(L('rightortop', 0, 0, 100, 0))
  check('arrowFor: at the middle of the line', ab.mid.x === 50 && ab.mid.y === 0, show(ab))
  check('  A -> B (rightortop): from A (above) to B (below), one head', near(ab.dir.x, 0) && near(ab.dir.y, 1) && ab.both === false, show(ab))
  check('  toA points into side A (where the "A" label goes)', sideOf(P(ab.mid.x + ab.toA.x, ab.mid.y + ab.toA.y), a, b) === 'A' && near(ab.toA.y, -1))
  const ba = arrowFor(L('leftorbotton', 0, 0, 100, 0))
  check('  B -> A (leftorbotton): the other way', near(ba.dir.y, -1) && ba.both === false)
  const both = arrowFor(L('none', 0, 0, 100, 0))
  check('  both ways (none): the A -> B normal, with a head at each end', both.both === true && near(both.dir.y, 1))
  const d = arrowFor(L('rightortop', 0, 0, 300, 400))
  const tail = P(d.mid.x - d.dir.x * 20, d.mid.y - d.dir.y * 20)
  const head = P(d.mid.x + d.dir.x * 20, d.mid.y + d.dir.y * 20)
  check('  a unit vector at a right angle to the line', near(Math.hypot(d.dir.x, d.dir.y), 1) && near(d.dir.x * 300 + d.dir.y * 400, 0), show(d.dir))
  check('  it crosses from A to B: tail on A, head on B', sideOf(tail, P(0, 0), P(300, 400)) === 'A' && sideOf(head, P(0, 0), P(300, 400)) === 'B')
  const back = arrowFor(L('leftorbotton', 0, 0, 300, 400))
  const backHead = P(back.mid.x + back.dir.x * 20, back.mid.y + back.dir.y * 20)
  check('  B -> A: its head is on A', sideOf(backHead, P(0, 0), P(300, 400)) === 'A')
  check('  a line of no length has no arrow', arrowFor(L('none', 5, 5, 5, 5)) === null)
}

// ---- turning a line's direction ------------------------------------------------------------------------
check('DIRECTIONS in the order a tap goes through them', show(DIRECTIONS) === '["rightortop","leftorbotton","none"]')
check('nextDirection: A -> B, B -> A, both, and round again', nextDirection('rightortop') === 'leftorbotton' && nextDirection('leftorbotton') === 'none' && nextDirection('none') === 'rightortop')
check('  only the directions the camera lists (in any order it lists them)', nextDirection('rightortop', ['none', 'rightortop']) === 'none' && nextDirection('none', ['none', 'rightortop']) === 'rightortop' && nextDirection('rightortop', ['none', 'rightortop', 'leftorbotton']) === 'leftorbotton')
check('  one it does not know starts the cycle', nextDirection('sideways') === 'rightortop')
check('  a camera that lists none: unchanged', nextDirection('none', []) === 'none')

// ---- what a press picks up ----------------------------------------------------------------------------------
{
  const lines = [
    L('rightortop', 100, 100, 500, 100),
    L('none', 0, 0, 0, 0), // unset
    L('leftorbotton', 100, 300, 100, 700),
    L('rightortop', 0, 0, 0, 0) // unset
  ]
  check('hitTest: an end within reach', show(hitTest(P(104, 97), lines, 10)) === '{"slot":0,"end":"start"}')
  check('  the other end', show(hitTest(P(500, 108), lines, 10)) === '{"slot":0,"end":"end"}')
  check('  the middle is the arrow (a tap turns the direction)', show(hitTest(P(300, 105), lines, 10)) === '{"slot":0,"end":"arrow"}')
  check('  another slot\'s end', show(hitTest(P(100, 695), lines, 10)) === '{"slot":2,"end":"end"}')
  check('  on a line but away from its ends and middle: nothing (a press there draws a new line)', hitTest(P(200, 100), lines, 10) === null)
  check('  unset slots are never picked, even at 0,0', hitTest(P(0, 0), lines, 10) === null)
  const short = [L('rightortop', 1000, 1000, 1016, 1000)]
  check('  the nearest wins (the arrow of a short line)', show(hitTest(P(1007, 1000), short, 10)) === '{"slot":0,"end":"arrow"}')
  check('  ...or its end', show(hitTest(P(1002, 1000), short, 10)) === '{"slot":0,"end":"start"}')
  check('  at the same distance an end beats the arrow', show(hitTest(P(1004, 1000), short, 10)) === '{"slot":0,"end":"start"}')
  check('  a finger reaches further than a mouse', hitTest(P(118, 100), lines, 10) === null && show(hitTest(P(118, 100), lines, 22)) === '{"slot":0,"end":"start"}')

  check('slotForNewLine: the selected slot when it is empty', slotForNewLine(lines, 3) === 3)
  check('  else the first empty one', slotForNewLine(lines, 0) === 1 && slotForNewLine(lines, 2) === 1)
  check('  all four drawn: -1', slotForNewLine([lines[0], lines[0], lines[2], lines[2]], 0) === -1)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run it and see it fail (locally)**

Run from the repo root: `node cctv/test/lines-geom.test.mjs`
Expected: it fails with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…\cctv\public\lines-geom.js'` and exit code 1.

- [ ] **Step 3: Write `cctv/public/lines-geom.js`**

```js
// The maths of drawing line-crossing lines on a camera's picture (lines-panel.js): the camera's own
// coordinates, which side of a line is A and which is B, the arrow that shows which way a crossing
// counts, and what a press on the picture picks up. Pure (no DOM), so the node tests
// (test/lines-geom.test.mjs) run it exactly as the browser does.
//
// Coordinates are the camera's: whole numbers 0..10000 across the picture's width and down its
// height, origin top-left, Y down (queryTripwire/editTripwire, tripwire-xml.mjs). A slot whose four
// numbers are all 0 has no line. The picture is not square, so what needs true angles or distances
// on screen (the arrow, what a finger can reach) is worked out in screen pixels: sideOf, arrowFor,
// lineLength and hitTest take points in any one space, and the panel gives them screen pixels where
// the shape matters.
//
// Directions, in the firmware's spelling ("botton" is theirs): 'rightortop' counts crossings from A
// to B, 'leftorbotton' from B to A, 'none' both ways. A is the side on the LEFT of the line as drawn,
// start -> end, on screen (the NVR's web client labels it so; the first test walk confirms it on the
// real camera).

export const UNITS = 10000
/** The order a tap on a line's arrow goes through: A -> B, B -> A, both ways. */
export const DIRECTIONS = ['rightortop', 'leftorbotton', 'none']
/**
 * The shortest line the server accepts: tripwire-xml.mjs MIN_LINE_FRACTION (5%) of UNITS, measured
 * the same way (straight distance in camera units). Checked here as well, so a stray tap is dropped
 * at once instead of being refused on Save.
 */
export const MIN_LINE_UNITS = 500

/** A fraction of the picture (held to 0..1: a drag past the edge stops at it) as a whole camera unit. */
export function toUnits(frac) {
  const f = Number(frac)
  if (!Number.isFinite(f)) return 0
  return Math.round(Math.min(1, Math.max(0, f)) * UNITS)
}

/** A camera coordinate as a fraction of the picture. */
export const toFrac = (units) => Number(units) / UNITS

/** Straight distance between two points, in whatever units they are given in. */
export const lineLength = (a, b) => Math.hypot(b.x - a.x, b.y - a.y)

/** A slot with a line in it (an unset slot has all four coordinates 0). */
export const isSet = (line) => Boolean(line) && !(line.start.x === 0 && line.start.y === 0 && line.end.x === 0 && line.end.y === 0)

/**
 * Which side of the line a -> b the point p is on: 'A' on its left as seen on screen (Y down), 'B'
 * on its right; a point exactly on the line counts as A. Any one coordinate space will do:
 * stretching the picture wider or taller never moves a point to the other side.
 */
export function sideOf(p, a, b) {
  // with Y down, the left of (dx, dy) is (dy, -dx): for a line drawn to the right it points up
  const dx = b.x - a.x
  const dy = b.y - a.y
  return (p.x - a.x) * dy - (p.y - a.y) * dx >= 0 ? 'A' : 'B'
}

/**
 * Where a line's direction arrow goes: across the line at its middle. dir is the unit normal the
 * arrow points along: A -> B for 'rightortop', B -> A for 'leftorbotton', and for 'none' the A -> B
 * one with both: true (a head at each end). toA is the unit normal into side A (where the "A" label
 * goes). Give screen pixels for a true right angle. null for a line of no length.
 */
export function arrowFor(line) {
  const a = line.start
  const b = line.end
  const len = lineLength(a, b)
  if (!(len > 0)) return null
  const toA = { x: (b.y - a.y) / len, y: -(b.x - a.x) / len }
  const toB = { x: -toA.x, y: -toA.y }
  return {
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    dir: line.direction === 'leftorbotton' ? toA : toB,
    both: line.direction === 'none',
    toA
  }
}

/**
 * The direction a tap on the arrow turns a line to: A -> B, then B -> A, then both, then round again.
 * allowed: the camera's own list (queryTripwire <types><direction>); one it does not know starts the
 * cycle.
 */
export function nextDirection(d, allowed = DIRECTIONS) {
  const order = DIRECTIONS.filter((x) => allowed.includes(x))
  if (!order.length) return d
  return order[(order.indexOf(d) + 1) % order.length]
}

/**
 * What a press at `point` picks up among `lines` (the slots in order; unset ones are skipped): an end
 * of a line to drag ('start' | 'end'), or the arrow at its middle to turn its direction ('arrow').
 * The nearest within `radius` wins; at the same distance an end beats the arrow, and a lower slot a
 * higher one. null: nothing there (a press on empty picture draws a new line). point, lines and
 * radius in one space (the panel uses screen pixels, so a finger reaches as far across as down).
 */
export function hitTest(point, lines, radius) {
  let best = null
  lines.forEach((l, slot) => {
    if (!isSet(l)) return
    const mid = { x: (l.start.x + l.end.x) / 2, y: (l.start.y + l.end.y) / 2 }
    for (const [end, q] of [['start', l.start], ['end', l.end], ['arrow', mid]]) {
      const d = lineLength(point, q)
      if (d <= radius && (!best || d < best.d)) best = { slot, end, d }
    }
  })
  return best && { slot: best.slot, end: best.end }
}

/** Where a newly drawn line goes: the selected slot when it is empty, else the first empty one; -1 when all are drawn. */
export function slotForNewLine(lines, selected = 0) {
  if (lines[selected] && !isSet(lines[selected])) return selected
  return lines.findIndex((l) => !isSet(l))
}
```

- [ ] **Step 4: Run it and see it pass (locally)**

Run: `node cctv/test/lines-geom.test.mjs`
Expected: 40 `PASS` lines, then `all passed`, exit code 0.

- [ ] **Step 5: Commit the geometry**

```bash
git add cctv/public/lines-geom.js cctv/test/lines-geom.test.mjs
git commit -m "$(cat <<'EOF'
Lines: the maths for drawing line-crossing lines on a camera's picture

Camera units 0..10000, which side of a line is A, the direction arrow, the
tap order A->B / B->A / both, and what a press on the picture picks up.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Write the failing panel test**

This needs Task 1's `cctv/tripwire-xml.mjs` and `cctv/test/fixtures/lines/`. Create `cctv/test/lines-panel.test.mjs`:

```js
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
  const drawing = src.slice(src.indexOf('  onPointerDown('), src.indexOf('  /** The lines as they will be saved'))
  check('  drawing only changes what is shown (no request from a pointer)', drawing.length > 0 && !/api\(|this\.post\(|this\.send\(|this\.setAlert\(/.test(drawing))
  check('  the camera\'s sound and white light are never among what the panel sends', !/triggerAudio|triggerWhiteLight/.test(src.slice(src.indexOf('export function changeOf'), src.indexOf('/** A schedule\'s name'))))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 7: Run it and see it fail (locally)**

Run: `node cctv/test/lines-panel.test.mjs`
Expected: it fails with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…\cctv\public\lines-panel.js'` and exit code 1.

- [ ] **Step 8: Write `cctv/public/lines-panel.js`**

```js
// Line crossing for one camera (admins), over the full-size Live view: up to four lines drawn on the
// live picture for the camera's OWN line-crossing detection, and its settings (on/off, the
// person/vehicle filter the camera has, hold time, schedule). The camera does the detecting; the
// server writes the lines into it through the NVR (tripwire.mjs) and turns what it reports into
// events within seconds (alarm-watch.mjs).
//
// Nothing reaches the camera without a click on Save or Undo. The server reads the camera again
// first and refuses if anything changed since this panel was filled (409 stale), asks for the
// admin's acknowledgement of its warnings (409 needsAck + ackToken, shown here as the Picture
// panel's dialog), logs the change before sending it and reads it back field by field. The result
// is listed here and the lines are redrawn from what the camera then reports. "Alert my phone for
// this camera" changes only Argus's own "Line crossing" alarm rule (line-actions.mjs), never the
// camera; it is on by default: a Save that switches a camera's line crossing on adds the camera to
// the rule unless the admin has switched the alert off here.
//
// The drawing canvas lies exactly over the picture (colour-check-ui.js's tested maths: pictureRect,
// overlayBox, clientToPicture, pictureToOverlay); the line maths is lines-geom.js. viewer.js pauses
// pinch-zoom while the panel is open (a drag here draws).
//
// The pure parts (the change to send, the texts, the result view, the alert state) are exported
// for node tests (test/lines-panel.test.mjs); the DOM is only touched inside the LinesPanel class.
import { clientToPicture, loupeSpot, objectPosition, overlayBox, pictureRect, pictureToOverlay } from './colour-check-ui.js'
import { MIN_LINE_UNITS, arrowFor, hitTest, isSet, lineLength, nextDirection, slotForNewLine, toFrac, toUnits } from './lines-geom.js'

/** The alarm rule the phone alerts go through (line-actions.mjs LINE_RULE_NAME; that server module is not loaded here). */
export const LINE_RULE_NAME = 'Line crossing'
export const ALERT_URL = '/api/admin/lines/alert'
export const DIRECTION_WORDS = { rightortop: 'A → B', leftorbotton: 'B → A', none: 'A ↔ B' }
/** The filter's classes as the camera names them, in the order the panel shows them. */
export const CLASS_WORDS = { person: 'Person', car: 'Car', motor: 'Motorbike' }
const CLASS_ORDER = ['person', 'car', 'motor']
// The detections a camera lists in <mutexList> (tripwire-xml.mjs uses the same words in its warning).
const MUTEX_WORDS = {
  perimeter: 'intrusion zones', pea: 'intrusion zones', osc: 'abandoned/missing object detection', cdd: 'crowd density',
  cpc: 'people counting', ipd: 'people intrusion', tripwire: 'line crossing', vfd: 'face detection',
  avd: 'video exception detection', vehicle: 'number plate detection', aoientry: 'area entry', aoileave: 'area exit'
}
const FIELD_WORDS = {
  enabled: 'Line crossing', holdTime: 'Hold time', schedule: 'Schedule', 'filter.sensitivity': 'Sensitivity',
  triggerAudio: 'Camera sound trigger', triggerWhiteLight: 'Camera white-light trigger', saveTargetPicture: 'Save target picture',
  saveSourcePicture: 'Save source picture', autoTrack: 'Auto tracking'
}
const TRIGGER_WORDS = {
  rec: 'record cameras', alarmOuts: 'alarm outputs', presets: 'PTZ presets', snap: 'snapshot', msgPush: 'push message', buzzer: 'buzzer',
  popVideo: 'pop-up video', email: 'email', sysAudio: 'sound', recOn: 'record', alarmOutOn: 'alarm output', presetOn: 'PTZ preset',
  sysSnap: 'NVR snapshot', popMsg: 'pop-up message', manualAudio: 'manual sound', manualLight: 'manual light'
}
const ACK_WORDS = { mutex: 'a detection that cannot run beside it', 'no-filter': 'no person/vehicle filter', 'short-hold': 'a short hold time', 'no-lines': 'no line drawn' }
const HEADLINES = {
  done: 'Saved: the camera reports every change as asked.',
  partial: 'Partly saved: the camera kept some of it (below).',
  failed: 'Not saved: the camera kept its settings.',
  unknown: 'Sent, but the camera could not be read back: reopen this panel to see what it has.'
}
// Each slot's own colour, on the picture and beside its row: bright on any video, told apart at a glance.
const SLOT_COLOURS = ['#ffd23f', '#3fd0ff', '#ff6bd6', '#7dff6b']
const MOVE_PX = 4 // a press that moved less than this is a tap (on the arrow: turn the line)
const REACH_PX = { touch: 22, pen: 12, mouse: 10 } // how far from an end or the arrow a press still picks it up

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const copyLine = (l) => ({ direction: l.direction, start: { x: l.start.x, y: l.start.y }, end: { x: l.end.x, y: l.end.y } })
const sameLine = (a, b) => Boolean(a && b) && a.direction === b.direction && a.start.x === b.start.x && a.start.y === b.start.y && a.end.x === b.end.x && a.end.y === b.end.y

// ---- pure helpers (node-testable) -------------------------------------------------------------

/**
 * What the admin can change, as the panel keeps it while they work (a copy: cfg is untouched).
 * filter: null (none), { sensitivity } (one for everything) or { person: { on, sensitivity }, ... }.
 */
export function draftOf(cfg) {
  let filter = null
  if (cfg.filter?.kind === 'single') filter = { sensitivity: cfg.filter.sensitivity }
  if (cfg.filter?.kind === 'objects') filter = Object.fromEntries(Object.entries(cfg.filter.classes).map(([k, c]) => [k, { on: c.on, sensitivity: c.sensitivity }]))
  return { enabled: cfg.enabled, holdTime: cfg.holdTime, scheduleGuid: cfg.scheduleGuid, lines: cfg.lines.map(copyLine), filter }
}

/**
 * The change to send (POST .../lines `change`, tripwire-xml.mjs applyChange's shape): only what
 * differs from the camera's settings. The lines go as all four slots when any one differs (the
 * server takes the whole list; a cleared slot is all zeros and keeps its direction); the filter as
 * only the classes and values that changed. {} when nothing did.
 */
export function changeOf(cfg, draft) {
  const out = {}
  if (draft.enabled !== cfg.enabled) out.enabled = draft.enabled
  if (draft.holdTime !== cfg.holdTime) out.holdTime = draft.holdTime
  if (draft.scheduleGuid !== cfg.scheduleGuid) out.scheduleGuid = draft.scheduleGuid
  if (draft.lines.some((l, i) => !sameLine(l, cfg.lines[i]))) out.lines = draft.lines.map(copyLine)
  if (cfg.filter?.kind === 'single' && draft.filter.sensitivity !== cfg.filter.sensitivity) out.filter = { sensitivity: draft.filter.sensitivity }
  if (cfg.filter?.kind === 'objects') {
    const f = {}
    for (const [k, c] of Object.entries(cfg.filter.classes)) {
      const d = draft.filter[k]
      const one = {}
      if (d.on !== c.on) one.on = d.on
      if (d.sensitivity !== c.sensitivity) one.sensitivity = d.sensitivity
      if (Object.keys(one).length) f[k] = one
    }
    if (Object.keys(f).length) out.filter = f
  }
  return out
}

/** A schedule's name from the NVR's list, or its id when the list does not have it. */
const scheduleName = (id, schedules = []) => schedules.find((s) => s.id === id)?.name ?? id

/** What one slot shows beside its number: its state and whether it is saved. */
export function slotText(line, saved) {
  if (sameLine(line, saved)) return isSet(line) ? 'drawn' : 'not drawn'
  if (!isSet(line)) return 'cleared, not saved'
  if (!isSet(saved)) return 'new, not saved'
  const moved = line.start.x !== saved.start.x || line.start.y !== saved.start.y || line.end.x !== saved.end.x || line.end.y !== saved.end.y
  return moved ? 'moved, not saved' : 'turned, not saved'
}

/**
 * What a Save would change, one line each, in plain words: the Save button counts them, the
 * confirmation dialog lists them. [] when nothing changed.
 */
export function changeLines(cfg, draft, schedules = []) {
  const out = []
  const onOff = (v) => (v ? 'on' : 'off')
  if (draft.enabled !== cfg.enabled) out.push(`Line crossing: ${onOff(cfg.enabled)} → ${onOff(draft.enabled)}`)
  draft.lines.forEach((l, i) => {
    const was = cfg.lines[i]
    if (sameLine(l, was)) return
    const name = `Line ${i + 1}`
    if (!isSet(l)) out.push(`${name}: cleared`)
    else if (!isSet(was)) out.push(`${name}: new line (${DIRECTION_WORDS[l.direction] ?? l.direction})`)
    else {
      const moved = l.start.x !== was.start.x || l.start.y !== was.start.y || l.end.x !== was.end.x || l.end.y !== was.end.y
      const turned = l.direction !== was.direction
      out.push(`${name}: ${[moved ? 'moved' : '', turned ? `direction now ${DIRECTION_WORDS[l.direction] ?? l.direction}` : ''].filter(Boolean).join(', ')}`)
    }
  })
  if (cfg.filter?.kind === 'single' && draft.filter.sensitivity !== cfg.filter.sensitivity) out.push(`Sensitivity: ${cfg.filter.sensitivity} → ${draft.filter.sensitivity}`)
  if (cfg.filter?.kind === 'objects') {
    for (const k of CLASS_ORDER) {
      const c = cfg.filter.classes[k]
      const d = draft.filter[k]
      if (!c || !d) continue
      if (d.on !== c.on) out.push(`${CLASS_WORDS[k]}: ${onOff(c.on)} → ${onOff(d.on)}`)
      if (d.sensitivity !== c.sensitivity) out.push(`${CLASS_WORDS[k]} sensitivity: ${c.sensitivity} → ${d.sensitivity}`)
    }
  }
  if (draft.holdTime !== cfg.holdTime) out.push(`Hold time: ${cfg.holdTime} s → ${draft.holdTime} s`)
  if (draft.scheduleGuid !== cfg.scheduleGuid) out.push(`Schedule: ${scheduleName(cfg.scheduleGuid, schedules)} → ${scheduleName(draft.scheduleGuid, schedules)}`)
  return out
}

/** "Save", "Save 1 change", "Save 3 changes". */
export const saveLabel = (n) => (n ? `Save ${plural(n, 'change')}` : 'Save')

/**
 * The schedule choices: the NVR's list, with the camera's own first-hand value added when the
 * list does not have it (or could not be read), so the select never shows something else.
 */
export function scheduleChoices(cfg, schedules = []) {
  const list = schedules.map((s) => ({ id: s.id, name: s.name }))
  if (!list.some((s) => s.id === cfg.scheduleGuid)) list.unshift({ id: cfg.scheduleGuid, name: schedules.length ? 'the camera\'s current schedule (not in the NVR\'s list)' : 'the camera\'s current schedule' })
  return list
}

/** The detections that cannot run beside line crossing and are on now, in words. */
export function mutexOn(cfg) {
  return [...new Set((cfg?.mutex ?? []).filter((m) => m.on).map((m) => MUTEX_WORDS[m.object] ?? m.object))]
}

/**
 * Why nothing may be changed on this camera from here, or null: its own sound or white-light
 * trigger is on (the server refuses every change then; the floodlight is worked by hand only).
 */
export function blockedText(cfg) {
  if (!cfg?.triggerAudio && !cfg?.triggerWhiteLight) return null
  const what = [cfg.triggerAudio ? 'sound' : '', cfg.triggerWhiteLight ? 'white-light' : ''].filter(Boolean).join(' and ')
  return `This camera's ${what} trigger is on for line crossing. Nothing can be changed here until it is set off on the NVR itself: the floodlight and sirens are worked by hand only.`
}

/** What Undo puts back, and when and by whom the change it undoes was made. */
export function undoText(undo) {
  if (!undo) return null
  const at = new Date(undo.at)
  return `Undo puts back the line settings from before the last change (made ${Number.isFinite(at.getTime()) ? at.toLocaleString() : undo.at} by ${undo.by}).`
}

/** A read-back field's name ('line.0.start' -> 'Line 1 start'). */
export function fieldLabel(key) {
  const line = /^line\.(\d+)\.(\w+)$/.exec(key)
  if (line) return `Line ${Number(line[1]) + 1} ${line[2]}`
  const cls = /^filter\.(\w+)\.(on|sensitivity|min|max)$/.exec(key)
  if (cls) return `${CLASS_WORDS[cls[1]] ?? cls[1]}${{ on: '', sensitivity: ' sensitivity', min: ' smallest size', max: ' largest size' }[cls[2]]}`
  const mutex = /^mutex\.(\w+?)(?:\.\d+)?$/.exec(key)
  if (mutex) return `${MUTEX_WORDS[mutex[1]] ?? mutex[1]} (cannot run beside line crossing)`
  const trig = /^trigger\.(\w+)$/.exec(key)
  if (trig) return `NVR action: ${TRIGGER_WORDS[trig[1]] ?? trig[1]}`
  return FIELD_WORDS[key] ?? key
}

/** A read-back value as the admin reads it (flatten()'s strings: 'true', '20', '1200,3400', a schedule id). */
export function valueText(key, v, schedules = []) {
  if (v === null || v === undefined) return '(none)'
  if (v === 'true' || v === 'false') return v === 'true' ? 'on' : 'off'
  if (/\.direction$/.test(key)) return DIRECTION_WORDS[v] ?? String(v)
  if (key === 'holdTime') return `${v} s`
  if (key === 'schedule') return scheduleName(v, schedules)
  return String(v)
}

/**
 * The result of a Save or Undo (POST .../lines `result`: compareReadBack's fields and
 * sideEffects, and the warnings acknowledged): a headline, each changed field as asked or not,
 * and what else the camera changed by itself.
 */
export function resultView(result, schedules = []) {
  const fields = (result?.fields ?? []).map((f) => {
    const ok = f.status === 'as asked'
    const name = fieldLabel(f.key)
    return {
      ok,
      text: ok ? `${name}: ${valueText(f.key, f.got, schedules)} (as asked)` : `${name}: not applied (asked ${valueText(f.key, f.want, schedules)}, the camera has ${valueText(f.key, f.got, schedules)})`
    }
  })
  const sideEffects = (result?.sideEffects ?? []).map((s) => `${fieldLabel(s.key)}: ${valueText(s.key, s.from, schedules)} → ${valueText(s.key, s.to, schedules)}`)
  const good = fields.filter((f) => f.ok).length
  const status = fields.length === 0 ? 'unknown' : good === fields.length ? 'done' : good > 0 ? 'partial' : 'failed'
  const acked = (result?.warningsAcked ?? []).map((k) => ACK_WORDS[k] ?? k)
  return { status, headline: HEADLINES[status], fields, sideEffects, acked }
}

/** Is this camera in the "Line crossing" alarm rule, switched on and notifying? rules: GET /api/alarms/rules. */
export function alertOn(rules, key) {
  const rule = (rules ?? []).find((r) => r?.name === LINE_RULE_NAME)
  return Boolean(rule && rule.enabled && rule.notify && Array.isArray(rule.cameras) && rule.cameras.includes(key))
}

/**
 * "Alert my phone" is on by default: after a Save that switched the camera's line crossing on,
 * the camera joins the rule when it is not in it yet and the admin has not touched the switch in
 * this panel. alert: { on: true | false | null | undefined (not known), touched }.
 */
export function autoAlert(before, after, alert) {
  return alert?.on === false && !alert.touched && Boolean(after?.enabled) && !before?.enabled
}

/**
 * The words under the alert switch. on: undefined while the rules are being read, null when they
 * could not be. topicSet: settings has an ntfy topic (GET .../lines ntfy.topicSet).
 */
export function alertNote(on, enabled, topicSet) {
  if (on === undefined) return ''
  if (on === null) return 'Whether this camera alerts your phone could not be read.'
  if (on && topicSet) return 'A crossing sends an alert to the ntfy topic in Settings (Alerts), with a link to the event.'
  if (on) return 'On, but no ntfy topic is set: switch this off and on again to make one, or set one in Settings (Alerts).'
  if (!enabled) return 'Off. It switches on by itself when you save lines with line crossing on, unless you switch it off here first.'
  return 'Off: crossings on this camera show on the Alarms page only.'
}

/**
 * How to get the alerts on a phone, from POST /api/admin/lines/alert's ntfy ({ topic, created,
 * url? }), or null when there is no topic.
 */
export function ntfyHelp(ntfy) {
  if (!ntfy?.topic) return null
  const url = String(ntfy.url ?? '').replace(/\/+$/, '')
  const server = url && url !== 'https://ntfy.sh' ? url : null
  return {
    lead: ntfy.created ? 'A private ntfy topic was made for Argus\'s phone alerts:' : 'Phone alerts go to this ntfy topic:',
    topic: ntfy.topic,
    steps: [
      'On your phone, install the free ntfy app (Android or iPhone).',
      `Tap +, and subscribe to the topic above${server ? `, with "Use another server" set to ${server}` : ''}.`,
      'Keep the topic name private: anyone who knows it can read these alerts and send you messages.'
    ]
  }
}

// ---- the DOM ------------------------------------------------------------------------------------

/** A small DOM builder: el('p', { className: 'x' }, 'text', child). */
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'dataset') Object.assign(n.dataset, v)
    else if (k.startsWith('aria-') || k === 'role' || k === 'for') n.setAttribute(k, v === true ? 'true' : String(v))
    else n[k] = v
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false && c !== '') n.append(c)
  return n
}

async function api(method, url, body) {
  const res = await fetch(url, method === 'GET' ? { cache: 'no-store' } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}
const errorOf = (r) => new Error(r.data?.error || `HTTP ${r.status}`)

/** A line (or an arrow shaft) with a dark edge, so it shows on any picture. */
function stroke(g, pts, colour, width, dash = []) {
  g.beginPath()
  g.moveTo(pts[0][0], pts[0][1])
  for (const p of pts.slice(1)) g.lineTo(p[0], p[1])
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.setLineDash([])
  g.strokeStyle = 'rgba(0,0,0,0.7)'
  g.lineWidth = width + 2
  g.stroke()
  g.setLineDash(dash)
  g.strokeStyle = colour
  g.lineWidth = width
  g.stroke()
  g.setLineDash([])
}

function dot(g, [x, y], r, colour) {
  g.beginPath()
  g.arc(x, y, r, 0, 2 * Math.PI)
  g.fillStyle = colour
  g.fill()
  g.lineWidth = Math.max(1, r / 3)
  g.strokeStyle = 'rgba(0,0,0,0.8)'
  g.stroke()
}

/** An arrow head at `tip`, pointing along the unit vector d. */
function head(g, tip, d, size, colour) {
  const back = [tip[0] - d.x * size, tip[1] - d.y * size]
  const side = [-d.y * size * 0.6, d.x * size * 0.6]
  g.beginPath()
  g.moveTo(tip[0], tip[1])
  g.lineTo(back[0] + side[0], back[1] + side[1])
  g.lineTo(back[0] - side[0], back[1] - side[1])
  g.closePath()
  g.fillStyle = colour
  g.fill()
  g.lineWidth = 1
  g.strokeStyle = 'rgba(0,0,0,0.8)'
  g.stroke()
}

function label(g, text, x, y, size) {
  g.font = `600 ${size}px system-ui, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.lineWidth = Math.max(2, size / 4)
  g.strokeStyle = 'rgba(0,0,0,0.85)'
  g.strokeText(text, x, y)
  g.fillStyle = '#fff'
  g.fillText(text, x, y)
}

let idSeq = 0

export class LinesPanel {
  /**
   * @param {HTMLElement} host where the panel goes (the Live grid, beside the full-size view)
   * @param {{ nvr: string, ch: number, name: string }} cam the camera (ch 0-based, as /api/cameras)
   * @param {{ liveEl: HTMLElement | (() => HTMLElement | null), opener?: HTMLElement | null, onClose?: () => void }} opts
   *   liveEl: the element the live picture is drawn in (the player's canvas), or a function giving
   *   the current one: the view swaps the sub stream's canvas for the main stream's and rebuilds its
   *   tile now and then, and the drawing follows it into the tile that holds it. opener: focused
   *   again on close. onClose: after the panel closed.
   */
  constructor(host, cam, { liveEl, opener = null, onClose = null } = {}) {
    this.host = host
    this.cam = cam
    this.liveEl = liveEl
    this.opener = opener
    this.onClose = onClose
    this.view = null // GET .../lines: { supported, cfg, schedules, device, seen, undo, ntfy }
    this.draft = null // draftOf(view.cfg), as the admin changes it
    this.blocked = null // blockedText(view.cfg)
    this.selected = 0 // the slot a new line goes into first
    this.drag = null // a press on the picture: { id, type, slot, end, from, before, moved, x, y }
    this.busy = false
    this.sending = 0 // camera writes on their way
    this.session = 0 // bumped on close: late answers for a closed panel are ignored
    this.loadSeq = 0
    this.isOpen = false
    this.folded = false
    this.alert = { on: undefined, touched: false, busy: false } // on: the camera is in the "Line crossing" rule (undefined: not read yet, null: could not be)
    this.ov = null
    this.layoutKey = ''
    this.onResize = () => this.layout()
    this.build()
  }

  get key() {
    return `${this.cam.nvr}/${this.cam.ch}`
  }

  /** Unsaved changes (lines and settings). */
  get dirty() {
    return this.view?.cfg && this.draft ? changeLines(this.view.cfg, this.draft).length : 0
  }

  url() {
    return `/api/admin/nvrs/${encodeURIComponent(this.cam.nvr)}/channels/${this.cam.ch}/lines`
  }

  build() {
    this.el = el('aside', { className: 'img-panel lines-panel', 'aria-label': 'Line crossing' })
    this.el.innerHTML = `
      <div class="ip-head"><h2 tabindex="-1">Lines <span class="ip-cam"></span></h2><span class="ln-head-buttons"><button type="button" class="ln-fold" aria-expanded="true" title="Fold the panel away to draw on the whole picture">Hide</button><button type="button" class="ip-close" aria-label="Close line crossing">×</button></span></div>
      <p class="ln-help">Drag on the picture to draw a line. Drag an end to move it; tap the arrow in its middle to change which way a crossing counts. A is the side on the left of the line as drawn.</p>
      <p class="ln-warn" hidden></p>
      <ol class="ln-slots"></ol>
      <div class="ln-settings"></div>
      <section class="ln-box ln-alert" aria-label="Phone alerts" hidden>
        <label class="ip-switch"><input type="checkbox" class="ln-alert-on" /> Alert my phone for this camera</label>
        <p class="ln-note ln-alert-note"></p>
        <div class="ln-ntfy" hidden></div>
      </section>
      <div class="ip-result ln-result" hidden></div>
      <p class="ip-error" role="alert"></p>
      <p class="ip-status" role="status"></p>
      <p class="ip-undo-note" hidden></p>
      <div class="ip-actions">
        <button type="button" class="ip-undo" hidden>Undo last change</button>
        <button type="button" class="ip-revert">Revert</button>
        <button type="button" class="ip-apply ln-save">Save</button>
      </div>
      <dialog class="ip-dialog"></dialog>`
    const $ = (s) => this.el.querySelector(s)
    this.$ = $
    $('.ip-cam').textContent = `· ${this.cam.ch + 1} ${this.cam.name ?? ''}`
    $('.ip-close').addEventListener('click', () => this.requestClose())
    $('.ln-fold').addEventListener('click', () => this.fold())
    $('.ln-save').addEventListener('click', () => this.save())
    $('.ip-undo').addEventListener('click', () => this.undo())
    $('.ip-revert').addEventListener('click', () => this.revert())
    $('.ln-alert-on').addEventListener('change', (e) => {
      this.alert.touched = true
      this.setAlert(e.target.checked)
    })
    // over the picture: a canvas exactly on it, a shield under it that catches taps on the bars
    // beside it (the full-size view closes on a tap), and the magnifier shown while dragging
    this.shield = el('div', { className: 'ln-shield' })
    this.canvas = el('canvas', { className: 'ln-overlay', hidden: true, 'aria-label': 'The camera picture: drag on it to draw a line' })
    this.ctx = this.canvas.getContext('2d')
    this.loupe = el('canvas', { className: 'ln-loupe', hidden: true, 'aria-hidden': 'true' })
    // the full-size view closes on a click and has keyboard shortcuts: not from in here
    for (const n of [this.el, this.shield, this.canvas]) {
      n.addEventListener('click', (e) => e.stopPropagation())
      n.addEventListener('dblclick', (e) => e.stopPropagation())
    }
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape' && !$('.ip-dialog').open) this.requestClose()
    })
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e))
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e))
    this.canvas.addEventListener('pointercancel', (e) => this.onPointerCancel(e))
  }

  open() {
    if (this.isOpen || typeof document === 'undefined') return
    this.isOpen = true
    this.session++
    this.host.append(this.el)
    window.addEventListener('resize', this.onResize)
    // the video's canvas is resized and swapped (sub -> main stream) without telling anyone
    this.layoutTimer = setInterval(() => this.layout(), 400)
    this.layout()
    this.load({ first: true })
    this.loadAlert()
  }

  /** Closes, asking first when changes are unsaved. Returns whether it closed. */
  requestClose() {
    if (!this.confirmDiscard()) return false
    this.close()
    return true
  }

  /**
   * "Discard N unsaved changes?" when there are any; true = go ahead. While a change is being sent
   * it says that instead: the server finishes it either way, but its result would not be shown.
   */
  confirmDiscard(n = this.dirty) {
    if (this.sending > 0) return window.confirm('A change is being saved to the camera. If you leave now its result will not be shown here; the change goes ahead, and Undo stays available when you reopen the panel. Leave anyway?')
    return n === 0 || window.confirm(`Discard ${plural(n, 'unsaved change')}?`)
  }

  close() {
    if (!this.isOpen) return
    this.isOpen = false
    this.session++
    this.loadSeq++
    clearInterval(this.layoutTimer)
    window.removeEventListener('resize', this.onResize)
    const d = this.$('.ip-dialog')
    if (d.open) d.close()
    for (const n of [this.el, this.shield, this.canvas, this.loupe]) n.remove()
    this.drag = null
    this.busy = false
    this.sending = 0
    if (this.opener?.isConnected) this.opener.focus()
    this.onClose?.()
  }

  fold(on = !this.folded) {
    this.folded = on
    this.el.classList.toggle('ln-folded', on)
    const b = this.$('.ln-fold')
    b.textContent = on ? 'Show' : 'Hide'
    b.setAttribute('aria-expanded', String(!on))
  }

  status(text, { error = false } = {}) {
    this.$('.ip-status').textContent = error ? '' : text
    this.$('.ip-error').textContent = error ? text : ''
  }

  // ---- reading -------------------------------------------------------------------------------------

  async load({ first = false } = {}) {
    const seq = ++this.loadSeq
    this.busy = true
    this.update()
    this.status('Reading the camera\'s line settings…')
    try {
      const r = await api('GET', this.url())
      if (seq !== this.loadSeq) return
      if (!r.ok) throw errorOf(r)
      this.show(r.data.lines)
      this.status('')
      if (first) this.$('.ip-head h2').focus()
    } catch (e) {
      if (seq === this.loadSeq) this.status(e.message, { error: true })
    } finally {
      if (seq === this.loadSeq) {
        this.busy = false
        this.update()
      }
    }
  }

  /** Whether the camera is in the "Line crossing" alarm rule (the alert switch). */
  async loadAlert() {
    const session = this.session
    const r = await api('GET', '/api/alarms/rules').catch(() => null)
    if (session !== this.session) return
    this.alert.on = r?.ok ? alertOn(r.data?.rules, this.key) : null
    this.updateAlert()
  }

  /** A fresh view from the server (GET, or the read-back after a Save or Undo): everything is redrawn from it. */
  show(view) {
    this.view = view ?? null
    const cfg = view?.supported ? view.cfg : null
    this.draft = cfg ? draftOf(cfg) : null
    this.blocked = cfg ? blockedText(cfg) : null
    const warn = this.$('.ln-warn')
    warn.hidden = !this.blocked
    warn.textContent = this.blocked ?? ''
    this.$('.ln-help').hidden = !cfg
    this.$('.ln-alert').hidden = !cfg
    if (!cfg) {
      this.slotRows = []
      this.controls = []
      this.$('.ln-slots').replaceChildren()
      this.$('.ln-settings').replaceChildren(el('p', { className: 'ln-note' }, 'The NVR says this camera has no line-crossing detection of its own.'))
    } else {
      if (!(this.selected < cfg.lines.length)) this.selected = 0
      this.renderSlots()
      this.renderSettings()
    }
    this.updateAlert()
    this.update()
    this.draw()
  }

  renderSlots() {
    this.slotRows = this.draft.lines.map((_, i) => {
      const swatch = el('span', { className: 'ln-swatch', 'aria-hidden': 'true' })
      swatch.style.background = SLOT_COLOURS[i % SLOT_COLOURS.length]
      const pick = el('button', { type: 'button', className: 'ln-pick', title: 'The line a new drag draws, when it is not drawn yet' }, swatch, `Line ${i + 1}`)
      const state = el('span', { className: 'ln-state' })
      const dir = el('button', { type: 'button', className: 'ln-dir', title: 'Which way a crossing counts: A → B, B → A, or both. Click to change.' })
      const clear = el('button', { type: 'button', className: 'ln-clear' }, 'Clear')
      pick.addEventListener('click', () => {
        this.selected = i
        this.update()
        this.draw()
      })
      dir.addEventListener('click', () => this.turn(i))
      clear.addEventListener('click', () => this.clearSlot(i))
      return { row: el('li', { className: 'ln-slot' }, pick, state, dir, clear), pick, state, dir, clear }
    })
    this.$('.ln-slots').replaceChildren(...this.slotRows.map((r) => r.row))
  }

  renderSettings() {
    const cfg = this.view.cfg
    const rows = []
    const on = el('input', { type: 'checkbox', className: 'ln-enabled' })
    on.addEventListener('change', () => this.edit(() => (this.draft.enabled = on.checked)))
    rows.push(el('label', { className: 'ip-switch' }, on, 'Line crossing on'))
    this.controls = [{ input: on, value: () => this.draft.enabled }]
    if (cfg.filter === null) {
      rows.push(el('p', { className: 'ln-note' }, 'This camera has no person/vehicle filter: anything that crosses a line counts, including water, boats, shadows and headlights.'))
    } else if (cfg.filter.kind === 'single') {
      rows.push(this.rangeRow('Sensitivity', () => this.draft.filter.sensitivity, (v) => (this.draft.filter.sensitivity = v)))
    } else {
      for (const k of CLASS_ORDER.filter((c) => c in cfg.filter.classes)) {
        const box = el('input', { type: 'checkbox' })
        box.addEventListener('change', () => this.edit(() => (this.draft.filter[k].on = box.checked)))
        this.controls.push({ input: box, value: () => this.draft.filter[k].on })
        rows.push(el('label', { className: 'ip-switch' }, box, `${CLASS_WORDS[k]} crossing counts`))
        rows.push(this.rangeRow(`${CLASS_WORDS[k]} sensitivity`, () => this.draft.filter[k].sensitivity, (v) => (this.draft.filter[k].sensitivity = v), () => this.draft.filter[k].on))
      }
    }
    const hold = el('select', {}, ...cfg.holdChoices.map((s) => new Option(`${s} s`, String(s))))
    hold.addEventListener('change', () => this.edit(() => (this.draft.holdTime = Number(hold.value))))
    this.controls.push({ input: hold, value: () => String(this.draft.holdTime) })
    rows.push(el('label', { className: 'ln-row', title: 'How long an alarm stays on after a crossing. Under 10 s a crossing could fall between two of Argus\'s checks (every 5 s).' }, 'Hold time', hold))
    const choices = scheduleChoices(cfg, this.view.schedules ?? [])
    const sched = el('select', {}, ...choices.map((s) => new Option(s.name, s.id)))
    sched.addEventListener('change', () => this.edit(() => (this.draft.scheduleGuid = sched.value)))
    // one choice (the NVR's list could not be read): shown, not changeable
    this.controls.push({ input: sched, value: () => this.draft.scheduleGuid, fixed: choices.length < 2 })
    rows.push(el('label', { className: 'ln-row', title: 'When the camera detects. The schedules themselves are the NVR\'s, edited there.' }, 'Schedule', sched))
    const busyWith = mutexOn(cfg)
    if (busyWith.length) rows.push(el('p', { className: 'ln-note' }, `This camera cannot run line crossing beside ${busyWith.join(', ')}, which ${busyWith.length === 1 ? 'is' : 'are'} on: switching line crossing on may switch ${busyWith.length === 1 ? 'it' : 'them'} off.`))
    this.$('.ln-settings').replaceChildren(el('section', { className: 'ln-box', 'aria-label': 'Detection settings' }, ...rows))
  }

  /** A 1-100 sensitivity: a slider and its number. on(): whether it matters now (its class counts). */
  rangeRow(name, get, set, on = () => true) {
    const range = el('input', { type: 'range', min: 1, max: 100, step: 1 })
    const num = el('input', { type: 'number', min: 1, max: 100, step: 1, className: 'ip-num', 'aria-label': name })
    const put = (v) => {
      const n = Math.round(Number(v))
      if (Number.isInteger(n) && n >= 1 && n <= 100) this.edit(() => set(n))
    }
    range.addEventListener('input', () => put(range.value))
    num.addEventListener('change', () => put(num.value))
    this.controls.push({ input: range, value: () => String(get()), on }, { input: num, value: () => String(get()), on })
    return el('label', { className: 'ln-range' }, el('span', {}, name), num, range)
  }

  /** A change to the draft from a control: the rest of the panel follows it. */
  edit(fn) {
    if (!this.draft || this.busy || this.blocked) return this.update()
    fn()
    this.update()
    this.draw()
  }

  turn(i) {
    if (!this.draft || this.busy || this.blocked || !isSet(this.draft.lines[i])) return
    this.draft.lines[i].direction = nextDirection(this.draft.lines[i].direction, this.view.cfg.directions)
    this.selected = i
    this.update()
    this.draw()
  }

  clearSlot(i) {
    if (!this.draft || this.busy || this.blocked) return
    const l = this.draft.lines[i]
    // a cleared slot keeps its direction: the camera wants one for every slot
    l.start = { x: 0, y: 0 }
    l.end = { x: 0, y: 0 }
    this.selected = i
    this.update()
    this.draw()
  }

  revert() {
    if (!this.view?.cfg || this.busy) return
    this.draft = draftOf(this.view.cfg)
    this.status('')
    this.update()
    this.draw()
  }

  /** Brings the controls in line with the draft, the unsaved changes and whether a request runs. */
  update() {
    const cfg = this.view?.supported ? this.view.cfg : null
    const locked = this.busy || Boolean(this.blocked) || !cfg
    for (const c of this.controls ?? []) {
      const v = c.value()
      if (c.input.type === 'checkbox') c.input.checked = v === true
      else if (document.activeElement !== c.input) c.input.value = String(v)
      c.input.disabled = locked || c.fixed === true || (c.on ? !c.on() : false)
    }
    for (const [i, { row, pick, state, dir, clear }] of (this.slotRows ?? []).entries()) {
      const l = this.draft.lines[i]
      row.classList.toggle('ln-current', i === this.selected)
      row.classList.toggle('ln-changed', !sameLine(l, cfg.lines[i]))
      pick.setAttribute('aria-pressed', String(i === this.selected))
      pick.disabled = locked
      state.textContent = slotText(l, cfg.lines[i])
      dir.textContent = DIRECTION_WORDS[l.direction] ?? l.direction
      dir.disabled = locked || !isSet(l)
      clear.disabled = locked || !isSet(l)
    }
    const n = this.dirty
    const save = this.$('.ln-save')
    save.textContent = saveLabel(n)
    save.disabled = locked || n === 0
    this.$('.ip-revert').disabled = this.busy || n === 0
    const undo = this.$('.ip-undo')
    const u = this.view?.undo ?? null
    undo.hidden = !u
    undo.disabled = locked
    const note = this.$('.ip-undo-note')
    note.hidden = !u
    note.textContent = u ? undoText(u) : ''
    this.canvas.classList.toggle('ln-locked', locked)
  }

  updateAlert() {
    const box = this.$('.ln-alert-on')
    box.checked = this.alert.on === true
    box.indeterminate = this.alert.on === null || this.alert.on === undefined
    box.disabled = this.alert.busy || !this.view?.supported
    this.$('.ln-alert-note').textContent = this.view?.supported ? alertNote(this.alert.on, this.view.cfg.enabled, Boolean(this.view.ntfy?.topicSet)) : ''
  }

  // ---- the drawing ----------------------------------------------------------------------------------

  videoEl() {
    try {
      return (typeof this.liveEl === 'function' ? this.liveEl() : this.liveEl) ?? null
    } catch {
      return null
    }
  }

  /** Puts the canvas exactly over the picture (letterboxing and devicePixelRatio accounted for), in whichever tile holds it now. */
  layout() {
    if (!this.isOpen) return
    const video = this.videoEl()
    const tile = video?.isConnected ? video.closest('.tile') : null
    if (!tile) {
      // no picture yet, or the view is being rebuilt: nothing to draw on until it is back
      if (this.layoutKey !== 'gone') {
        this.layoutKey = 'gone'
        this.ov = null
        this.canvas.hidden = true
        this.hideLoupe()
      }
      return
    }
    if (this.canvas.parentNode !== tile) {
      tile.append(this.shield, this.canvas, this.loupe)
      this.layoutKey = ''
    }
    const hr = tile.getBoundingClientRect()
    const hostBox = { left: hr.left + tile.clientLeft, top: hr.top + tile.clientTop, width: tile.clientWidth, height: tile.clientHeight }
    const [iw, ih] = video instanceof HTMLVideoElement ? [video.videoWidth, video.videoHeight] : [video.width, video.height]
    const cs = getComputedStyle(video)
    const r = video.getBoundingClientRect()
    const px = (v) => parseFloat(v) || 0
    const box = {
      left: r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft),
      top: r.top + px(cs.borderTopWidth) + px(cs.paddingTop),
      width: r.width - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(cs.paddingLeft) - px(cs.paddingRight),
      height: r.height - px(cs.borderTopWidth) - px(cs.borderBottomWidth) - px(cs.paddingTop) - px(cs.paddingBottom)
    }
    const pic = pictureRect(box, iw, ih, cs.objectFit || 'fill', objectPosition(cs.objectPosition))
    const dpr = window.devicePixelRatio || 1
    const key = pic ? [pic.left, pic.top, pic.width, pic.height, hostBox.left, hostBox.top, hostBox.width, hostBox.height, dpr].map((x) => x.toFixed(1)).join() : 'none'
    if (key === this.layoutKey) return
    this.layoutKey = key
    this.hostSize = [hostBox.width, hostBox.height]
    if (!pic) {
      this.ov = null
      this.canvas.hidden = true
      return
    }
    const ov = overlayBox(pic, hostBox, dpr)
    Object.assign(this.canvas.style, { left: `${ov.left}px`, top: `${ov.top}px`, width: `${ov.width}px`, height: `${ov.height}px` })
    if (this.canvas.width !== ov.backingWidth) this.canvas.width = ov.backingWidth
    if (this.canvas.height !== ov.backingHeight) this.canvas.height = ov.backingHeight
    this.canvas.hidden = false
    this.ov = ov
    this.draw()
  }

  /** Where a pointer is on the picture, in the camera's units (held to the picture's edges). */
  unitsAt(e, r = this.canvas.getBoundingClientRect()) {
    if (!(r.width > 0 && r.height > 0)) return null
    const [u, v] = clientToPicture(e.clientX, e.clientY, r)
    return { x: toUnits(u), y: toUnits(v) }
  }

  /** The draft's lines in the canvas's CSS pixels: true distances on screen, for what a press reaches. */
  linesPx(r) {
    const at = (p) => ({ x: toFrac(p.x) * r.width, y: toFrac(p.y) * r.height })
    return this.draft.lines.map((l) => ({ direction: l.direction, start: at(l.start), end: at(l.end) }))
  }

  onPointerDown(e) {
    if (!e.isPrimary || e.button !== 0 || !this.ov || !this.draft || this.busy || this.blocked) return
    const r = this.canvas.getBoundingClientRect()
    const at = this.unitsAt(e, r)
    if (!at) return
    e.preventDefault()
    e.stopPropagation()
    const hit = hitTest({ x: e.clientX - r.left, y: e.clientY - r.top }, this.linesPx(r), REACH_PX[e.pointerType] ?? REACH_PX.mouse)
    let slot
    let end
    if (hit) ({ slot, end } = hit)
    else {
      slot = slotForNewLine(this.draft.lines, this.selected)
      end = 'new'
      if (slot < 0) return this.status('All four lines are drawn: clear one to draw another, or drag an end to move it.')
    }
    this.drag = { id: e.pointerId, type: e.pointerType, slot, end, from: at, before: copyLine(this.draft.lines[slot]), moved: false, x: e.clientX, y: e.clientY }
    this.selected = slot
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {}
    this.update()
    this.draw()
  }

  onPointerMove(e) {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < MOVE_PX) return
    d.moved = true
    if (d.end === 'arrow') return // a drag that started on the arrow moves nothing
    const at = this.unitsAt(e)
    if (!at) return
    const l = this.draft.lines[d.slot]
    if (d.end === 'new') {
      l.start = { ...d.from }
      l.end = at
    } else l[d.end] = at
    this.draw()
    this.drawLoupe(at)
  }

  onPointerUp(e) {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    this.drag = null
    this.hideLoupe()
    const l = this.draft.lines[d.slot]
    if (d.end === 'arrow') {
      if (!d.moved) this.turn(d.slot)
      return
    }
    if (d.moved && lineLength(l.start, l.end) < MIN_LINE_UNITS) {
      Object.assign(l, copyLine(d.before))
      this.status('Too short: a line must be at least 5% of the picture long. Drag further.', { error: true })
    } else if (d.moved) this.status('')
    this.update()
    this.draw()
  }

  onPointerCancel(e) {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    this.drag = null
    this.hideLoupe()
    Object.assign(this.draft.lines[d.slot], copyLine(d.before))
    this.update()
    this.draw()
  }

  /** The lines as they will be saved: numbered, coloured, an arrow across each with its A and B sides; unsaved ones dashed. */
  draw() {
    const g = this.ctx
    const ov = this.ov
    if (!g || !ov) return
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, ov.backingWidth, ov.backingHeight)
    if (!this.draft) return
    const k = ov.backingWidth / Math.max(1, ov.width) // backing pixels per CSS pixel (devicePixelRatio)
    const saved = this.view.cfg.lines
    this.draft.lines.forEach((l, i) => {
      if (!isSet(l)) return
      const a = pictureToOverlay([toFrac(l.start.x), toFrac(l.start.y)], ov)
      const b = pictureToOverlay([toFrac(l.end.x), toFrac(l.end.y)], ov)
      const colour = SLOT_COLOURS[i % SLOT_COLOURS.length]
      const current = i === this.selected
      stroke(g, [a, b], colour, (current ? 3 : 2) * k, sameLine(l, saved[i]) ? [] : [8 * k, 5 * k])
      dot(g, a, (current ? 6 : 5) * k, colour)
      dot(g, b, (current ? 6 : 5) * k, colour)
      const arrow = arrowFor({ direction: l.direction, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] } })
      if (!arrow) return
      const { mid, dir, both, toA } = arrow
      // the slot's number just before the start, along the line
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      label(g, String(i + 1), a[0] - ((b[0] - a[0]) / len) * 14 * k, a[1] - ((b[1] - a[1]) / len) * 14 * k, 13 * k)
      const shaft = 22 * k
      const tail = [mid.x - dir.x * shaft, mid.y - dir.y * shaft]
      const tip = [mid.x + dir.x * shaft, mid.y + dir.y * shaft]
      stroke(g, [tail, tip], colour, 2 * k)
      head(g, tip, dir, 9 * k, colour)
      if (both) head(g, tail, { x: -dir.x, y: -dir.y }, 9 * k, colour)
      const off = shaft + 12 * k
      label(g, 'A', mid.x + toA.x * off, mid.y + toA.y * off, 14 * k)
      label(g, 'B', mid.x - toA.x * off, mid.y - toA.y * off, 14 * k)
    })
  }

  /** A magnifier near the end being placed, showing the picture there (a fingertip hides it). */
  drawLoupe(at) {
    const video = this.videoEl()
    const ov = this.ov
    if (!video || !ov || !this.hostSize) return this.hideLoupe()
    const [iw, ih] = video instanceof HTMLVideoElement ? [video.videoWidth, video.videoHeight] : [video.width, video.height]
    if (!iw || !ih) return this.hideLoupe()
    const R = Math.round(Math.min(56, (Math.min(...this.hostSize) - 16) / 2))
    if (R < 20) return this.hideLoupe()
    const zoom = 3
    const dpr = window.devicePixelRatio || 1
    const c = this.loupe
    const size = Math.round(2 * R * dpr)
    if (c.width !== size) c.width = c.height = size
    c.style.width = c.style.height = `${2 * R}px`
    const u = toFrac(at.x)
    const v = toFrac(at.y)
    const x = ov.left + u * ov.width
    const y = ov.top + v * ov.height
    const off = R + (this.drag?.type === 'touch' ? 36 : 20)
    const [lx, ly] = loupeSpot(x, y, R, off, this.hostSize, this.panelBox())
    c.style.left = `${lx - R}px`
    c.style.top = `${ly - R}px`
    const g = c.getContext('2d')
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.fillStyle = '#000'
    g.fillRect(0, 0, size, size)
    const span = (2 * R) / zoom // CSS px of picture shown across the magnifier
    const sw = (span / ov.width) * iw
    const sh = (span / ov.height) * ih
    try {
      g.drawImage(video, u * iw - sw / 2, v * ih - sh / 2, sw, sh, 0, 0, size, size)
    } catch {}
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    stroke(g, [[R - 12, R], [R + 12, R]], '#fff', 1.5)
    stroke(g, [[R, R - 12], [R, R + 12]], '#fff', 1.5)
    c.hidden = false
  }

  hideLoupe() {
    this.loupe.hidden = true
  }

  /** The panel's box inside the tile (the magnifier keeps clear of it), or null when folded or elsewhere. */
  panelBox() {
    const tile = this.canvas.parentNode
    if (this.folded || !tile?.getBoundingClientRect || !this.el.isConnected) return null
    const p = this.el.getBoundingClientRect()
    const h = tile.getBoundingClientRect()
    return p.width ? { left: p.left - h.left - tile.clientLeft, top: p.top - h.top - tile.clientTop, width: p.width, height: p.height } : null
  }

  // ---- dialogs and sending ------------------------------------------------------------------------------

  /** The Picture panel's modal dialog: title, lead, a list, and the action. Resolves true on the action. */
  dialog({ title, lead = '', items = [], action = 'Save anyway' }) {
    const d = this.$('.ip-dialog')
    const back = document.activeElement
    const tid = `ln-d-${++idSeq}`
    d.setAttribute('aria-labelledby', tid)
    const ok = el('button', { type: 'button', className: 'ip-go' }, action)
    const cancel = el('button', { type: 'button' }, 'Cancel')
    d.replaceChildren(
      el('h3', { id: tid }, title),
      lead ? el('p', {}, lead) : '',
      items.length ? el('ul', { className: 'ip-acks' }, items.map((t) => el('li', {}, t))) : '',
      el('div', { className: 'ip-dialog-buttons' }, cancel, ok)
    )
    return new Promise((resolve) => {
      let settled = false
      const done = (v) => {
        if (settled) return
        settled = true
        if (d.open) d.close()
        if (back?.isConnected) back.focus()
        resolve(v)
      }
      ok.addEventListener('click', () => done(true))
      cancel.addEventListener('click', () => done(false))
      d.addEventListener('cancel', (e) => {
        e.preventDefault()
        done(false)
      }, { once: true })
      // closed any other way (the panel closing under it): the same as Cancel, so nothing waits for ever
      d.addEventListener('close', () => done(false), { once: true })
      d.showModal()
      cancel.focus()
    })
  }

  /**
   * POST .../lines with the server's confirmations: a 409 needsAck is shown as a dialog and the same
   * body is sent again with the acknowledgement keys and the token that ties them to this exact change.
   */
  async post(body, { lead = '' } = {}) {
    const send = async (b) => {
      const session = this.session
      this.sending++
      try {
        return await api('POST', this.url(), b)
      } finally {
        if (session === this.session) this.sending--
      }
    }
    let r = await send(body)
    for (let round = 0; round < 2 && r.status === 409 && Array.isArray(r.data?.needsAck); round++) {
      const list = r.data.needsAck
      const ok = await this.dialog({ title: 'This change needs your confirmation', lead, items: list.map((i) => i.text), action: 'Save anyway' })
      if (!ok) return { cancelled: true }
      r = await send({ ...body, ack: list.map((i) => i.key), ackToken: r.data.ackToken })
    }
    return r
  }

  async save() {
    const cfg = this.view?.cfg
    if (!cfg || this.busy || this.blocked) return
    const change = changeOf(cfg, this.draft)
    if (Object.keys(change).length === 0) return
    await this.send({ device: this.view.device, seen: this.view.seen, change, confirm: true }, { verb: 'Saving', lines: changeLines(cfg, this.draft, this.view.schedules ?? []) })
  }

  async undo() {
    const v = this.view
    if (!v?.undo || this.busy || this.blocked) return
    // Undo shows the camera's settings afterwards: lines drawn but not saved would go
    if (!this.confirmDiscard()) return
    await this.send({ device: v.device, undo: true, seq: v.undo.seq, confirm: true }, { verb: 'Undoing', lines: [undoText(v.undo)] })
  }

  /** Sends a Save or an Undo, then shows the camera as read back and what happened to each field. */
  async send(body, { verb, lines = [] }) {
    const session = this.session
    const before = this.view.cfg
    this.busy = true
    this.update()
    this.$('.ln-result').hidden = true
    this.status(`${verb}… the camera is read back afterwards (up to 6 s)`)
    let r
    try {
      r = await this.post(body, { lead: lines.length ? `It sends: ${lines.join('; ')}.` : '' })
    } catch (e) {
      if (session === this.session) {
        this.busy = false
        this.update()
        this.status(`Could not reach the server (${e.message}); reopen the panel to see what the camera has.`, { error: true })
      }
      return
    }
    if (session !== this.session) return
    this.busy = false
    if (r.cancelled) {
      this.update()
      this.status('Nothing was sent.')
      return
    }
    const data = r.data ?? {}
    if (!r.ok) {
      if (r.status === 409 && data.stale) {
        // what the admin changed was drawn on settings that are no longer the camera's: shown afresh
        await this.load()
        if (session === this.session) this.status('The camera\'s line settings were changed elsewhere since this panel read them, so nothing was sent. They are shown again now; your unsaved changes were dropped: draw them again.', { error: true })
        return
      }
      this.update()
      this.status(data.error || `HTTP ${r.status}`, { error: true })
      return
    }
    this.show(data.lines)
    this.showResult(data.result)
    this.status('')
    if (autoAlert(before, data.lines?.cfg, this.alert)) await this.setAlert(true, { auto: true })
  }

  showResult(result) {
    const v = resultView(result, this.view?.schedules ?? [])
    const box = this.$('.ln-result')
    box.className = `ip-result ln-result ip-${v.status}`
    box.replaceChildren(
      el('p', {}, v.headline),
      v.fields.length ? el('ul', {}, v.fields.map((f) => el('li', { className: f.ok ? 'ln-ok' : 'ln-no' }, f.text))) : '',
      v.sideEffects.length ? el('p', { className: 'ln-no' }, 'The camera also changed by itself:') : '',
      v.sideEffects.length ? el('ul', {}, v.sideEffects.map((t) => el('li', {}, t))) : '',
      v.acked.length ? el('p', { className: 'ln-note' }, `You confirmed: ${v.acked.join(', ')}.`) : ''
    )
    box.hidden = false
  }

  // ---- phone alerts (Argus's alarm rule, not the camera) ---------------------------------------------

  /** Adds this camera to the "Line crossing" alarm rule, or takes it out. auto: the default after a Save that switched it on. */
  async setAlert(on, { auto = false } = {}) {
    const session = this.session
    this.alert.busy = true
    this.updateAlert()
    let r
    try {
      r = await api('POST', ALERT_URL, { nvr: this.cam.nvr, ch: this.cam.ch, on })
    } catch (e) {
      r = { ok: false, status: 0, data: { error: e.message } }
    }
    if (session !== this.session) return
    this.alert.busy = false
    if (!r.ok) {
      this.updateAlert()
      this.status(`Phone alert not changed: ${r.data?.error || `HTTP ${r.status}`}`, { error: true })
      return
    }
    this.alert.on = alertOn([r.data.rule], this.key)
    if (this.view?.ntfy && r.data.ntfy?.topic) this.view.ntfy.topicSet = true
    this.updateAlert()
    this.showNtfy(this.alert.on ? r.data.ntfy : null, { auto })
  }

  showNtfy(ntfy, { auto = false } = {}) {
    const box = this.$('.ln-ntfy')
    const help = ntfyHelp(ntfy)
    box.replaceChildren(
      auto && this.alert.on ? el('p', {}, 'Phone alerts are now on for this camera (the default). Switch them off above if you do not want them.') : '',
      help ? el('p', {}, help.lead) : '',
      help ? el('p', { className: 'ln-topic' }, el('code', {}, help.topic)) : '',
      help ? el('ol', {}, help.steps.map((t) => el('li', {}, t))) : ''
    )
    box.hidden = box.childElementCount === 0
  }
}
```

- [ ] **Step 9: Run it and see it pass (locally)**

Run: `node cctv/test/lines-panel.test.mjs`
Expected: 52 `PASS` lines, then `all passed`, exit code 0.

- [ ] **Step 10: Add the styles to `cctv/public/style.css`**

The rules use only existing tokens: `--muted`, `--text`, `--accent`, `--border`, `--ok`, `--warn`, `--warn-soft`, `--surface-2`, `--video-bg`, `--r-sm`, `--r-md` and `--gap`. Canvas colours are drawn from JS, as in colour-check-ui.js.

Find this text; it is unique and ends the Picture panel block:

```css
@media (max-width: 600px) {
  .img-panel { top: auto; left: 8px; right: 8px; width: auto; height: 62%; }
}
```

Replace it with:

```css
@media (max-width: 600px) {
  .img-panel { top: auto; left: 8px; right: 8px; width: auto; height: 62%; }
}

/* ---- line crossing (admins): lines-panel.js, over the full-size view ---- */
/* the panel is the Picture panel's box (.img-panel); Hide folds it to its title bar so the whole
   picture can be drawn on */
.lines-panel.ln-folded { bottom: auto; height: auto; }
@media (max-width: 600px) {
  .lines-panel.ln-folded { top: auto; bottom: calc(var(--gap) + 8px); }
}
.lines-panel.ln-folded > :not(.ip-head, dialog) { display: none !important; }
.ln-head-buttons { display: flex; align-items: center; gap: 6px; flex: none; }
.ln-fold { padding: 2px 9px; font-size: 12px; }
.ln-help, .ln-note { margin: 0; color: var(--muted); font-size: 12px; }
.ln-warn { margin: 0; padding: 6px 8px; border-radius: var(--r-sm); background: var(--warn-soft); color: var(--text); font-size: 12px; }
.ln-slots { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.ln-slot { display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: 6px; font-size: 12.5px; }
.ln-slot button { padding: 3px 8px; font-size: 12px; }
.ln-pick { display: flex; align-items: center; gap: 6px; }
.ln-current .ln-pick { border-color: var(--accent); font-weight: 600; }
.ln-swatch { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.ln-state { color: var(--muted); font-size: 12px; }
.ln-changed .ln-state { color: var(--accent); }
.ln-dir { min-width: 58px; }
.ln-box { padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--r-md); display: flex; flex-direction: column; gap: 8px; }
.ln-row { flex-direction: row; justify-content: space-between; font-size: 12.5px; }
.ln-range { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 3px 8px; color: var(--text); font-size: 12.5px; }
.ln-range input[type="range"] { grid-column: 1 / span 2; width: 100%; accent-color: var(--accent); }
.ln-range input[type="number"] { width: 64px; }
.ln-range:has(input:disabled) { opacity: 0.45; }
.ln-result ul { list-style: none; padding-left: 0; }
.ln-ok { color: var(--ok); }
.ln-no { color: var(--warn); }
.ln-ntfy { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.ln-ntfy p, .ln-ntfy ol { margin: 0; }
.ln-ntfy ol { padding-left: 18px; }
.ln-topic code { user-select: all; padding: 2px 6px; border-radius: var(--r-sm); background: var(--surface-2); color: var(--text); }
/* over the picture. The full-size view's own canvas rules (raised a layer, moved by the zoom, sized
   to the tile) must not reach these: the drawing sits exactly on the picture, placed by the script */
.tile.single-overlay > .ln-shield { position: absolute; inset: 0; z-index: 3; }
.tile.single-overlay canvas.ln-overlay { position: absolute; z-index: 3; display: block; transform: none; object-fit: fill; touch-action: none; cursor: crosshair; }
.tile.single-overlay canvas.ln-overlay.ln-locked { cursor: default; }
.tile.single-overlay canvas.ln-loupe { position: absolute; z-index: 5; display: block; transform: none; object-fit: fill; border-radius: 50%; border: 2px solid var(--accent); background: var(--video-bg); pointer-events: none; }
.tile.single-overlay canvas.ln-overlay[hidden], .tile.single-overlay canvas.ln-loupe[hidden] { display: none; }
/* a phone's full-size camera covers the grid (z-index 91): the panel goes above it */
body.phone-full #grid > .lines-panel { z-index: 92; }
```

Why some of these rules exist:
- `.tile.single-overlay canvas.ln-*` has specificity (0,3,1). That beats `.single-overlay canvas` (position relative, z-index 1), `.single-overlay canvas:not(.osd)` (the zoom transform) and `.tile canvas` (100% size, object-fit).
- The shield (z 3) sits under `.single-overlay > .label` (z 4, pointer-events only on its links). The name-bar buttons and the ‹ › arrows (z 5/6) stay usable.
- A folded panel still shows its `<dialog>`, so a confirmation that arrives after Hide cannot leave an invisible modal.

- [ ] **Step 11: Wire the Lines button into `cctv/public/viewer.js`**

Make each edit with the exact anchor below. Every anchor appears exactly once in the current file.

11a. Import. Find line 7:

```js
import { ImagePanel } from './image-panel.js'
```

Replace with:

```js
import { ImagePanel } from './image-panel.js'
import { LinesPanel } from './lines-panel.js'
```

11b. Panel state and the support check. Find lines 78-84:

```js
const imagePanel = new ImagePanel({
  getPlayer: shownPlayer,
  waitForMain,
  onClose: () => {
    for (const b of grid.querySelectorAll('button.pic-toggle')) b.setAttribute('aria-expanded', 'false')
  }
})
```

Replace with:

```js
const imagePanel = new ImagePanel({
  getPlayer: shownPlayer,
  waitForMain,
  onClose: () => {
    for (const b of grid.querySelectorAll('button.pic-toggle')) b.setAttribute('aria-expanded', 'false')
  }
})

// line crossing (admins): lines drawn on the camera shown full-size, for the camera's own detection
// (lines-panel.js). One panel at a time with Picture: both sit over the right of the picture.
let linesPanel = null // the open Lines panel, or null
const linesSupport = new Map() // camKey -> Promise<true | false | null>: asked once per camera while this page is open
/**
 * Whether the camera has line-crossing detection of its own (GET .../lines: the NVR's own answer).
 * null when it could not be asked (camera offline, NVR busy): asked again the next time the view opens.
 */
function linesSupported(cam) {
  const k = camKey(cam)
  if (!linesSupport.has(k)) {
    const ask = fetch(`/api/admin/nvrs/${encodeURIComponent(cam.nvr)}/channels/${cam.ch}/lines`, { cache: 'no-store' })
      .then(async (res) => (res.ok ? (await res.json())?.lines?.supported === true : null))
      .catch(() => null)
      .then((ok) => {
        if (ok === null) linesSupport.delete(k)
        return ok
      })
    linesSupport.set(k, ask)
  }
  return linesSupport.get(k)
}
/** The Lines panel may go (it asks first when lines are drawn but not saved). */
const linesDiscard = () => !linesPanel || linesPanel.confirmDiscard()
```

11c. The render keeps the panel in place. Find line 173:

```js
  const kept = keep ? [overlay, imagePanel.el].filter((n) => n.parentNode === grid) : []
```

Replace with:

```js
  const kept = keep ? [overlay, imagePanel.el, linesPanel?.el].filter((n) => n?.parentNode === grid) : []
```

11d. Picture closes Lines first. Find this block in `openSingle`, lines 593-597:

```js
      if (imagePanel.key === single) {
        imagePanel.requestClose()
        return
      }
      imagePanel.open(cam, { opener: pic })
```

Replace with:

```js
      if (imagePanel.key === single) {
        imagePanel.requestClose()
        return
      }
      // one panel at a time: the Lines panel goes first (asking when lines are unsaved)
      if (linesPanel && !linesPanel.requestClose()) return
      imagePanel.open(cam, { opener: pic })
```

11e. The Lines button, beside Picture. Find lines 599-602:

```js
      grid.append(imagePanel.el)
    })
    links.append(pic)
  }
```

Replace with:

```js
      grid.append(imagePanel.el)
    })
    links.append(pic)
    // Lines: only for a camera whose NVR says it has line crossing of its own (hidden until then)
    const lines = document.createElement('button')
    lines.type = 'button'
    lines.className = 'pb-link lines-toggle'
    lines.textContent = 'Lines'
    lines.title = 'Line crossing: draw lines for the camera\'s own detection'
    lines.hidden = true
    lines.setAttribute('aria-expanded', String(linesPanel?.key === single))
    lines.addEventListener('click', (e) => {
      e.stopPropagation()
      if (linesPanel?.key === single) {
        linesPanel.requestClose()
        return
      }
      // one panel at a time: the Picture panel goes first (asking when changes are unsent)
      if (!imagePanel.confirmDiscard()) return
      imagePanel.close()
      overlayZoom?.reset() // the lines are drawn on the whole picture
      linesPanel = new LinesPanel(grid, cam, {
        liveEl: () => shownPlayer()?.player?.canvas ?? null,
        opener: lines,
        onClose: () => {
          linesPanel = null
          for (const b of grid.querySelectorAll('button.lines-toggle')) b.setAttribute('aria-expanded', 'false')
        }
      })
      linesPanel.open()
      lines.setAttribute('aria-expanded', 'true')
    })
    links.append(lines)
    linesSupported(cam).then((ok) => {
      if (ok) lines.hidden = false
    })
  }
```

11f. A tap on the view asks about unsaved lines too. Find lines 607-609:

```js
  overlay.addEventListener('click', () => {
    if (imagePanel.confirmDiscard()) closeSingle()
  })
```

Replace with:

```js
  overlay.addEventListener('click', () => {
    if (imagePanel.confirmDiscard() && linesDiscard()) closeSingle()
  })
```

11g. Pinch-zoom is paused while drawing. Find lines 614-615:

```js
  overlayZoom = attachZoom(view, {
    apply: (z, x, y) => {
```

Replace with:

```js
  overlayZoom = attachZoom(view, {
    // paused while the Lines panel is open: a drag there draws a line, and lines need the whole picture
    busy: () => Boolean(linesPanel),
    apply: (z, x, y) => {
```

11h. A rebuilt view keeps the panel for the same camera and closes it for another. Find lines 635-636:

```js
  if (imagePanel.key === single) grid.append(imagePanel.el)
  else imagePanel.close()
```

Replace with:

```js
  if (imagePanel.key === single) grid.append(imagePanel.el)
  else imagePanel.close()
  // the Lines panel likewise; its drawing follows the camera's picture into the rebuilt view
  if (linesPanel?.key === single) grid.append(linesPanel.el)
  else linesPanel?.close()
```

11i. Back to the grid. Find lines 655-657 in `closeSingle`:

```js
  stopAhead()
  leavePhoneFull()
  imagePanel.close()
```

Replace with:

```js
  stopAhead()
  leavePhoneFull()
  imagePanel.close()
  linesPanel?.close()
```

11j. Relayout keeps the panel in place. Find line 781:

```js
  const before = [overlay, imagePanel.el].find((n) => n?.parentNode === grid) ?? null
```

Replace with:

```js
  const before = [overlay, imagePanel.el, linesPanel?.el].find((n) => n?.parentNode === grid) ?? null
```

11k. Escape closes the Lines panel first. Find lines 924-925:

```js
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && single !== null && !document.fullscreenElement && imagePanel.confirmDiscard()) closeSingle()
```

Replace with:

```js
document.addEventListener('keydown', (e) => {
  // Escape closes the Lines panel first (it lies over the picture), then the full-size view
  if (e.key === 'Escape' && linesPanel) {
    linesPanel.requestClose()
    return
  }
  if (e.key === 'Escape' && single !== null && !document.fullscreenElement && imagePanel.confirmDiscard()) closeSingle()
```

11l. ‹ › and ← → ask about unsaved lines. Find line 1088 in `stepCamera`:

```js
  if (imagePanel.confirmDiscard()) openSingle(next)
```

Replace with:

```js
  if (imagePanel.confirmDiscard() && linesDiscard()) openSingle(next)
```

11m. On a phone, a flick while drawing draws a line and does not change camera. Find lines 1116-1117:

```js
  document.addEventListener('touchstart', (e) => {
    if (!document.body.classList.contains('phone-full') || e.touches.length !== 1) return (t0 = null)
```

Replace with:

```js
  document.addEventListener('touchstart', (e) => {
    if (!document.body.classList.contains('phone-full') || e.touches.length !== 1) return (t0 = null)
    if (linesPanel) return (t0 = null) // drawing lines: a flick draws, it does not change camera
```

- [ ] **Step 12: Run the new tests and the ones that read these files (all locally)**

Run from the repo root in bash:

```bash
for t in lines-geom lines-panel css-tokens image-panel colour-check-ui pinch-zoom grid-diff grid-order grid-drag osd-overlay page-tabs pages-shell bookmarks camera-links static-files; do node cctv/test/$t.test.mjs > /dev/null || echo "FAIL $t"; done; node --check cctv/public/viewer.js && echo "viewer.js parses"
```

Expected: no `FAIL` lines, then `viewer.js parses`.
- None of these tests import `sdk.mjs` or need ffmpeg.
- `grid-diff`, `grid-order` and `osd-overlay` scan `viewer.js`. `css-tokens`, `bookmarks`, `camera-links`, `grid-drag` and `page-tabs` read the CSS.
- The panel against a real camera in a browser is part of Task 8's live test (run on the server copy: see Task 8 Step 1). There, the Lines button appears on Maingate Roadway, a line is drawn and saved, the confirmation dialog shows the "no person/vehicle filter" warning, and the result is listed field by field.

- [ ] **Step 13: Commit**

```bash
git add cctv/public/lines-panel.js cctv/test/lines-panel.test.mjs cctv/public/viewer.js cctv/public/style.css
git commit -m "$(cat <<'EOF'
Lines panel: draw line-crossing lines on Live for the camera's own detection

Admins get a Lines button beside Picture on the full-size view, shown when
the NVR says the camera has line crossing. Four slots, drag to draw or move,
tap the arrow to turn A->B / B->A / both, a magnifier while dragging, and the
settings the camera has (on/off, person/vehicle filter, hold time, schedule).
Save and Undo go through the server's stale check and the Picture panel's
acknowledgement dialog; the result is listed field by field and the lines are
redrawn from the read-back. "Alert my phone for this camera" (on by default)
changes only the "Line crossing" alarm rule and shows how to subscribe to the
ntfy topic. Pinch-zoom is paused while the panel is open.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Alarms page (line-crossing pictures, `#event=<id>`), docs, full test run, deploy and the live test on Maingate Roadway

> **Cross-task corrections (binding - apply these where the steps below differ):**
>
> 1. Files and Step 11 say alarms.test.mjs 'reaches sdk.mjs through alarms.mjs → events.mjs, so run it on the server copy'. That is wrong: alarms.mjs imports events.mjs only dynamically (`sourceReport`), and events.mjs loads nvr-xml.mjs only inside sdkQuery. `node cctv/test/alarms.test.mjs` passes on this PC today, and Tasks 3 and 5 run it locally. The contradiction could make the executor skip the local run.
>
>    **Fix:** In Task 8 Files, replace "`cctv/test/alarms.test.mjs` is not changed but also covers `alarmRows`. It reaches sdk.mjs through alarms.mjs → events.mjs, so run it on the server copy: see Task 8 Step 1." with "`cctv/test/alarms.test.mjs` is not changed but also covers `alarmRows`; it runs locally (`node cctv/test/alarms.test.mjs`)." In Step 11, change the heading to "The Alarms suites (local, then on the server copy)" and add first: "Locally: `node cctv/test/alarms.test.mjs && node cctv/test/alarms-view.test.mjs`; expected: both `all passed`."


**Files:**
- Create: `cctv/test/alarms-view.test.mjs`
- Modify: `cctv/public/alarms-view.js`. There are three places: a new block before the `alarmRows` doc comment (line 73, or 76 once Task 3's `EVENT_KINDS` line is in); the object that `alarmRows` returns (`nvr: a.nvr, ch: a.ch`, lines 94-95 or 97-98); and the end of the file after `priorityClass` (line 124 or 127).
- Modify: `cctv/public/alarms.js`. The places are the import (line 9), the module state (line 18), `loadAlarms` (lines 52-55), `paintAlarms` (lines 67-102), the lines after the `link` helper (line 118), `start` (lines 277-279) and the lines after the logout handler (line 286).
- Modify: `cctv/public/style.css`, after line 1220 (`.al-when small …`).
- Modify: `cctv/public/login.js`, lines 15-18.
- Modify: `CHANGELOG.md`, under `[Unreleased]` > `### Added` (line 14).
- Test: `cctv/test/alarms-view.test.mjs` runs locally (`node cctv/test/alarms-view.test.mjs`). `cctv/test/alarms.test.mjs` is not changed but also covers `alarmRows`. It reaches sdk.mjs through alarms.mjs → events.mjs, so run it on the server copy: see Task 8 Step 1.
- Scratch files, never in the repo. They go in the session scratchpad `C:\Users\mike\AppData\Local\Temp\claude\C--Users-mike-Downloads-websdk3-2\224c4b4b-edba-4a0e-b617-76eab964a246\scratchpad\` (called `$S` below): `run-tests.sh`, `alarms-fake.mjs` and `lines-live.mjs`.

**Interfaces:**
- Consumes:
  - Task 3: the `EVENT_KINDS` entry `{ type: 'line-crossing', label: 'Line crossing', confirmed: true }`, so `labelOf('line-crossing') === 'Line crossing'`.
  - Task 5:
    - `eventLink(eventId) -> \`${publicUrl}/alarms.html#event=${eventId}\``
    - `POST /api/admin/lines/alert { nvr, ch, on } -> { rule, ntfy: { topic, created } }`
    - the rule named `LINE_RULE_NAME = 'Line crossing'`
    - the automatic bookmark: user `'system'`, from 30 s before to 60 s after.
  - Task 6:
    - `GET /api/events/:id/snapshot` → 200 `image/jpeg` (`cache-control: private, max-age=300`), or 404 when there is no picture or the viewer has no playback right
    - `SNAP_WAIT_MS = 3 * 60_000`
    - the file `DATA_DIR/event-snaps/<id>.jpg`
    - the log line `[snapshot] <nvr>/<ch> event <id>: taken …`
  - Task 2:
    - `GET /api/admin/nvrs/:id/channels/:ch/lines -> { lines: { supported, cfg, schedules, device, seen, undo: {seq, at, by}|null, ntfy: { topicSet } } }`
    - `POST` to the same path with `{ device, seen, change, ack?, ackToken?, confirm: true }`, or with `{ device, undo: true, seq, ack?, ackToken?, confirm: true }` → `{ lines, result: { fields, sideEffects, warningsAcked } }`
    - 409 `{ error, needsAck: [{ key, text }], ackToken }` and 409 `{ error, stale: true }`
    - `DATA_DIR/lines-on.json` and `DATA_DIR/tripwire-changes.log`.
  - Task 4: the alarm watch reads every 5 s and files events `{ type: 'line-crossing', subtype: 'tripwire', source: 'alarm-status' }`.
  - Existing code:
    - `alarmRows(alarms, { now = Date.now() } = {}) -> row[]` (alarms-view.js:77), `filterSummary(summary, filters)`, `labelOf(type)`
    - `GET /api/alarms?from=&types=&cameras=`. Each row has the events-db `EV_COLS` fields (`id, nvr, ch, type, subtype, startMs, endMs, source, detail, priority, ruleId, ruleName, notifiedMs, ackMs, ackUser, ackNote, seenMs`) plus `camera`.
    - `GET /api/bookmarks?camera=&from=` → `{ bookmarks: [{ id, cameras, startMs, endMs, title, description, user }] }`
    - `auth.mjs` `createSession(user) -> token` and `loadUsers()`, with the cookie `cctv_session`
    - page-tabs.js shows the first tab for a `#…` it does not know.
- Produces:
  - `cctv/public/alarms-view.js`:
    - `export const SNAPSHOT_KINDS = Object.freeze(['line-crossing'])`
    - `export const SNAPSHOT_SETTLE_MS = 5 * 60_000`
    - `export function snapshotUrl(event) -> string | null`
    - `export const snapshotMayArrive = (startMs, now = Date.now()) -> boolean`
    - `export function eventFromHash(hash) -> number | null`
    - `export function linkedEventNote(id, rows) -> string`
    - every `alarmRows` row gains `snapshot: string | null`.
  - `/alarms.html#event=<id>` lists every alarm, acknowledged ones too. It scrolls to that row once, marks it (`tr.al-target`) and focuses it. Line-crossing rows show an `a.al-snap > img` thumbnail.
  - Step 1 below is the private server copy that earlier tasks refer to as "run on the server copy: see Task 8 Step 1".

- [ ] **Step 1: The private server copy (every "run on the server copy" in this plan)**

The production server records the site. The copy runs from `/tmp/lines-test`, with its own empty data folder for each test and at the lowest CPU priority. It never uses `/var/lib/cctv` or the running service.

(a) Write this runner with the Write tool to `$S\run-tests.sh`, once:

```bash
#!/bin/bash
# Runs test files against the private copy in /tmp/lines-test: the ones named, or every
# cctv/test/*.test.mjs. Each gets its own empty data folder (never /var/lib/cctv) and runs at the
# lowest CPU priority, because this machine is recording the site while it runs.
cd /tmp/lines-test || exit 1
export LD_LIBRARY_PATH=/opt/cctv/current/bin/linux
tests=("$@")
[ ${#tests[@]} -gt 0 ] || tests=(cctv/test/*.test.mjs)
bad=0
for f in "${tests[@]}"; do
  d=$(mktemp -d)
  s=$(date +%s)
  DATA_DIR="$d" nice -n 19 timeout 600 node "$f" > /tmp/lines-test/one.out 2>&1
  rc=$?
  fails=$(grep -c '^FAIL' /tmp/lines-test/one.out)
  echo "rc=$rc fails=$fails $(( $(date +%s) - s ))s $f | $(tail -n 1 /tmp/lines-test/one.out | cut -c1-70)"
  if [ "$rc" != 0 ] || [ "$fails" != 0 ]; then
    bad=$((bad + 1))
    grep -E '^FAIL|Error' /tmp/lines-test/one.out | head -n 8 | sed 's/^/    /'
  fi
  rm -rf "$d"
done
echo "DONE: ${#tests[@]} suites, $bad not passing"
```

(b) Copy the working tree. Git's tar is used without gzip, which Windows application control blocks. Link the packages, the SDK, the build and deploy/ from the installed release, then add the runner. Repeat (b) whenever the working tree changes; it replaces the whole copy.

```bash
S=/c/Users/mike/AppData/Local/Temp/claude/C--Users-mike-Downloads-websdk3-2/224c4b4b-edba-4a0e-b617-76eab964a246/scratchpad
cd /c/Users/mike/Downloads/websdk3.2/TVT-CCTV && tar -cf - cctv package.json VERSION | MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'rm -rf /tmp/lines-test && mkdir -p /tmp/lines-test && tar -xf - -C /tmp/lines-test && for d in node_modules bin build deploy; do ln -s /opt/cctv/current/$d /tmp/lines-test/$d; done && echo "copied $(find /tmp/lines-test/cctv -name "*.mjs" | wc -l) modules"'
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'cat > /tmp/lines-test/run-tests.sh' < "$S/run-tests.sh"
git -C /c/Users/mike/Downloads/websdk3.2/TVT-CCTV diff --quiet master -- deploy || echo "deploy/ differs from master: the copy links the INSTALLED deploy/, so also tar deploy and drop it from the ln list"
```

(c) Run named test files. This is what "run on the server copy" means:

```bash
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'bash /tmp/lines-test/run-tests.sh cctv/test/alarms.test.mjs cctv/test/alarms-view.test.mjs' < /dev/null
```

Expected: one line per file, `rc=0 fails=0 …`, then `DONE: N suites, 0 not passing`.

(d) Run every suite. The run is longer than one tool call, so start it in the background and poll:

```bash
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'nohup bash /tmp/lines-test/run-tests.sh > /tmp/lines-test/all.txt 2>&1 < /dev/null &' < /dev/null
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'tail -n 2 /tmp/lines-test/all.txt' < /dev/null
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'grep -v "^rc=0 fails=0" /tmp/lines-test/all.txt' < /dev/null
```

Repeat the second command, about once a minute, until its last line starts with `DONE:`. Then the third command lists what did not pass.

There are two known environmental failures, and nothing else may fail:
- `cctv/test/sps.test.mjs`: `ENOENT … /work/cranes.bin`
- `cctv/test/substreams.test.mjs`: `ENOENT … /work/live-nvr1-queryNetworkNodeEncodeInfo.xml`

Both need `/work` fixtures that are not on this server.

- [ ] **Step 2: Write the failing test `cctv/test/alarms-view.test.mjs`**

```js
// Offline tests for the Alarms page's line-crossing additions in public/alarms-view.js: the picture
// a line-crossing row carries, when a picture that failed to load is worth asking for again, the
// alarm a phone alert's link points at (/alarms.html#event=<id>), and what the page says when that
// alarm is not in the list it is showing.
//
// Pure: no DOM, no database, no SDK, so it runs on Windows with plain node:
//   node cctv/test/alarms-view.test.mjs
import {
  SNAPSHOT_KINDS, SNAPSHOT_SETTLE_MS, alarmRows, eventFromHash, labelOf, linkedEventNote, snapshotMayArrive, snapshotUrl
} from '../public/alarms-view.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 27, 14, 0, 0)
const MIN = 60_000

// --- which rows carry a picture ------------------------------------------------------------------
{
  check('line crossings are the kind that comes with a picture', SNAPSHOT_KINDS.includes('line-crossing'))
  const url = snapshotUrl({ id: 42, type: 'line-crossing' })
  check('a line crossing points at its own picture', url === '/api/events/42/snapshot', url)
  check('motion has none (nothing takes one)', snapshotUrl({ id: 42, type: 'motion' }) === null)
  check('nor does the old smart-detection kind', snapshotUrl({ id: 42, type: 'ai', subtype: 'tripwire' }) === null)
  // the id goes into a URL: only the whole number the database gave is let through
  check('an id that is not a positive whole number gives no address', [0, -1, 1.5, '7', 'x', true, null, undefined].every((id) => snapshotUrl({ id, type: 'line-crossing' }) === null))
  check('nothing at all gives nothing', snapshotUrl(null) === null && snapshotUrl(undefined) === null)

  const rows = alarmRows([
    { id: 9, camera: 'Maingate Roadway', nvr: 'nvr-2', ch: 2, type: 'line-crossing', subtype: 'tripwire', priority: 'high', startMs: T0, endMs: T0 + 10_000, ackMs: null },
    { id: 10, camera: 'Gate', nvr: 'nvr1', ch: 0, type: 'motion', subtype: '', priority: 'low', startMs: T0, endMs: null, ackMs: null }
  ], { now: T0 + MIN })
  check('the row of a line crossing carries its picture', rows[0].snapshot === '/api/events/9/snapshot', rows[0].snapshot)
  check('and says what it was in words', rows[0].what === `${labelOf('line-crossing')} (tripwire)`, rows[0].what)
  check('a motion row carries none', rows[1].snapshot === null)
  check('the rest of the row is as before', rows[0].id === 9 && rows[0].camera === 'Maingate Roadway' && rows[0].lasted === '10 s' && rows[0].needsAck === true && rows[0].nvr === 'nvr-2' && rows[0].ch === 2)
}

// --- a picture that failed to load: ask again, or stop asking --------------------------------------
{
  check('just after the crossing: it may still come', snapshotMayArrive(T0, T0 + 30_000))
  check('three minutes on: still possible (the snapshot waits that long for the recording)', snapshotMayArrive(T0, T0 + 3 * MIN))
  check('past the settle time: not coming', !snapshotMayArrive(T0, T0 + SNAPSHOT_SETTLE_MS))
  check('the settle time is longer than the snapshot\'s own three-minute wait', SNAPSHOT_SETTLE_MS > 3 * MIN)
  check('no start time: never worth asking again', !snapshotMayArrive(null, T0) && !snapshotMayArrive(undefined, T0))
}

// --- the link in a phone alert ---------------------------------------------------------------------
{
  check('#event=<id> names that alarm', eventFromHash('#event=123') === 123)
  check('without the #, too', eventFromHash('event=5') === 5)
  check('beside other things in the address', eventFromHash('#event=77&from=alert') === 77)
  check('a tab name is not an alarm', eventFromHash('#rules') === null && eventFromHash('#list') === null)
  check('an empty address is not an alarm', eventFromHash('') === null && eventFromHash(undefined) === null && eventFromHash(null) === null)
  const junk = ['#event=', '#event=abc', '#event=-4', '#event=1.5', '#event=0', '#event=1e3', '#event=12345678901234567890']
  check('nonsense is not an alarm', junk.every((h) => eventFromHash(h) === null), junk.filter((h) => eventFromHash(h) !== null).join(' '))
}

// --- when the linked alarm is not in the list ------------------------------------------------------
{
  const rows = alarmRows([{ id: 9, camera: 'Maingate Roadway', nvr: 'nvr-2', ch: 2, type: 'line-crossing', subtype: 'tripwire', priority: 'high', startMs: T0, endMs: null, ackMs: null }], { now: T0 })
  check('no link: nothing to say', linkedEventNote(null, rows) === '')
  check('the linked alarm is listed: nothing to say', linkedEventNote(9, rows) === '')
  const note = linkedEventNote(8, rows)
  check('not listed: the page says so and names it', /\b8\b/.test(note) && /not in the list/.test(note), note)
  // never "it does not exist": the list is a window of dates, and the server leaves out the alarms
  // of cameras this viewer may not see (alarms.mjs), so absence here proves neither
  check('and gives the likely reasons instead of claiming it does not exist', /older/.test(note) && /cannot see/.test(note) && !/does not exist/.test(note), note)
  check('an empty or missing list is handled', /not in the list/.test(linkedEventNote(8, [])) && /not in the list/.test(linkedEventNote(8, undefined)))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 3: Run it and see it fail**

Run from the repo root: `node cctv/test/alarms-view.test.mjs`

Expected: exit 1, with
`SyntaxError: The requested module '../public/alarms-view.js' does not provide an export named 'SNAPSHOT_KINDS'`

- [ ] **Step 4: Implement the pure part in `cctv/public/alarms-view.js`**

Edit 1: find

```js
/**
 * One row per alarm, ready to paint.
```

and replace it with

```js
/**
 * The kinds of event that come with a picture of the moment. event-snapshot.mjs takes one for each
 * line crossing from Argus's own recording; nothing takes one for any other kind, so no other row
 * asks the server for one.
 */
export const SNAPSHOT_KINDS = Object.freeze(['line-crossing'])
/**
 * How long after an event starts its picture may still be on its way. The snapshot waits up to
 * three minutes for the recording to cover the moment (event-snapshot.mjs SNAP_WAIT_MS), and the
 * two minutes on top cover the recording's last file being written and ffmpeg. A picture still
 * missing after that is not coming, so the page stops asking for it on every refresh.
 */
export const SNAPSHOT_SETTLE_MS = 5 * 60_000

/** Where an event's picture is served, or null for a kind that never has one. */
export function snapshotUrl(event) {
  const id = event?.id
  // the id goes into a URL: only the whole number the database gave is let through
  if (!SNAPSHOT_KINDS.includes(event?.type) || !Number.isSafeInteger(id) || id <= 0) return null
  return `/api/events/${id}/snapshot`
}

/** Whether a picture that failed to load may still arrive, so the next refresh should ask again. */
export const snapshotMayArrive = (startMs, now = Date.now()) => Number.isFinite(startMs) && now - startMs < SNAPSHOT_SETTLE_MS

/**
 * One row per alarm, ready to paint.
```

Edit 2: find

```js
    nvr: a.nvr,
    ch: a.ch
  }))
}
```

and replace it with

```js
    nvr: a.nvr,
    ch: a.ch,
    // a line crossing's picture (event-snapshot.mjs), or null for kinds that never have one
    snapshot: snapshotUrl(a)
  }))
}
```

Edit 3: find

```js
/** The colour class for a priority, so the list is scannable without reading it. */
export const priorityClass = (p) => `pri-${PRIORITIES.includes(p) ? p : 'low'}`
```

and replace it with

```js
/** The colour class for a priority, so the list is scannable without reading it. */
export const priorityClass = (p) => `pri-${PRIORITIES.includes(p) ? p : 'low'}`

/**
 * The alarm a link points at, or null. A phone alert links to /alarms.html#event=<id>
 * (line-actions.mjs eventLink); anything else after the # (a tab name such as #rules) is not one.
 */
export function eventFromHash(hash) {
  const raw = new URLSearchParams(String(hash ?? '').replace(/^#/, '')).get('event')
  if (!raw || !/^\d{1,15}$/.test(raw)) return null
  const id = Number(raw)
  return id > 0 ? id : null
}

/**
 * What the page says when the alarm a link points at is not in the list it shows, or '' when there
 * is no link or the alarm is there. Never "it does not exist": the list covers a window of dates
 * (the last week unless changed), and the server leaves out the alarms of cameras this viewer may
 * not see (alarms.mjs), so its absence here proves neither.
 */
export function linkedEventNote(id, rows) {
  if (id === null || id === undefined) return ''
  if ((rows ?? []).some((r) => r.id === id)) return ''
  return `The alarm the link points to (number ${id}) is not in the list below: it may be older than the dates shown, or on a camera you cannot see. Widen the dates under More filters to look further back.`
}
```

- [ ] **Step 5: Run the test and see it pass**

Run: `node cctv/test/alarms-view.test.mjs`

Expected: 26 `PASS` lines, then `all passed`, exit 0.

- [ ] **Step 6: Paint the pictures and follow `#event=<id>` in `cctv/public/alarms.js`**

Edit 1: find

```js
import { EVENT_KINDS, PRIORITIES, alarmRows, filterSummary, labelOf, priorityClass, ruleSummary } from './alarms-view.js'
```

and replace it with

```js
import { EVENT_KINDS, PRIORITIES, alarmRows, eventFromHash, filterSummary, labelOf, linkedEventNote, priorityClass, ruleSummary, snapshotMayArrive } from './alarms-view.js'
```

Edit 2: find `let tuner = null` (line 18, including its line end) and replace it with

```js
let tuner = null
// The alarm a link pointed at (a phone alert opens /alarms.html#event=<id>): marked in the list on
// every repaint, scrolled to once per link.
let linked = eventFromHash(location.hash)
let scrolledTo = null
// Line-crossing pictures, kept across the 30 s refresh so the list does not fetch and redraw every
// thumbnail each time; and the alarms whose picture is known not to be coming.
const thumbs = new Map()
const noPicture = new Set()
```

Edit 3: find

```js
  admin = body.admin === true
  say($('summary'), filterSummary(body.summary, { acked: $('filters').elements.acked.value === 'false' }))
  paintAlarms(alarmRows(body.alarms))
  paintSources(body.sources)
}
```

and replace it with

```js
  admin = body.admin === true
  const rows = alarmRows(body.alarms)
  // A linked alarm that is not in this list is explained on the summary line, which is read out as
  // a status: whoever followed the link learns why they are not looking at it.
  say($('summary'), [filterSummary(body.summary, { acked: $('filters').elements.acked.value === 'false' }), linkedEventNote(linked, rows)].filter(Boolean).join(' · '))
  paintAlarms(rows)
  paintSources(body.sources)
  showLinked()
}
```

Edit 4: find

```js
    tr.append(td)
    list.append(tr)
    return
  }
  for (const r of rows) {
    const tr = document.createElement('tr')
    tr.className = `${priorityClass(r.priority)}${r.needsAck ? ' needs-ack' : ''}`
```

and replace it with

```js
    tr.append(td)
    list.append(tr)
    thumbs.clear()
    return
  }
  for (const r of rows) {
    const tr = document.createElement('tr')
    tr.className = `${priorityClass(r.priority)}${r.needsAck ? ' needs-ack' : ''}${r.id === linked ? ' al-target' : ''}`
    tr.dataset.event = String(r.id)
```

Edit 5: find

```js
    tr.append(pri, when, cell(r.camera), cell(r.what), cell(r.lasted), cell(r.ack || (r.needsAck ? 'not yet' : '')))
```

and replace it with

```js
    const what = cell(r.what)
    // a line crossing's picture sits under its name (event-snapshot.mjs takes it from the recording)
    if (r.snapshot && !noPicture.has(r.id)) what.append(thumbFor(r))
    tr.append(pri, when, cell(r.camera), what, cell(r.lasted), cell(r.ack || (r.needsAck ? 'not yet' : '')))
```

Edit 6: find

```js
    actions.append(button('Export', () => exportClip(r)))
    tr.append(actions)
    list.append(tr)
  }
}
```

and replace it with

```js
    actions.append(button('Export', () => exportClip(r)))
    tr.append(actions)
    list.append(tr)
  }
  // pictures of rows that have left the list (acknowledged, filtered out, too old) are let go
  const shown = new Set(rows.map((r) => r.id))
  for (const id of thumbs.keys()) if (!shown.has(id)) thumbs.delete(id)
}
```

Edit 7: find

```js
const link = (text, href) => {
  const a = document.createElement('a')
  a.textContent = text
  a.href = href
  return a
}
```

and replace it with

```js
const link = (text, href) => {
  const a = document.createElement('a')
  a.textContent = text
  a.href = href
  return a
}

/**
 * A line crossing's picture: a thumbnail that opens the full picture in a new tab. Loaded lazily
 * (the browser fetches it only when the row comes near the screen): the list can hold hundreds of
 * rows, and each picture is a file the server reads from disk. The same element is reused on every
 * refresh, so a picture is fetched once rather than every 30 s.
 */
function thumbFor(row) {
  const kept = thumbs.get(row.id)
  if (kept) return kept
  const a = document.createElement('a')
  a.className = 'al-snap'
  a.href = row.snapshot
  a.target = '_blank'
  a.rel = 'noopener'
  a.title = 'Open the picture'
  const img = document.createElement('img')
  // the alarm a link pointed at is looked at straight away: its picture should not wait for a scroll
  img.loading = row.id === linked ? 'eager' : 'lazy'
  img.decoding = 'async'
  img.alt = `${row.what}, ${row.camera}, ${row.when}`
  // No picture: it is taken from the recording up to three minutes after the crossing, or there was
  // no recording to take it from, or this user may not play that camera back. The empty frame goes;
  // the next refresh asks again only while the picture may still be on its way.
  img.addEventListener('error', () => {
    a.remove()
    thumbs.delete(row.id)
    if (!snapshotMayArrive(row.startMs)) noPicture.add(row.id)
  }, { once: true })
  img.src = row.snapshot
  a.append(img)
  thumbs.set(row.id, a)
  return a
}

/**
 * The alarm a link pointed at: brought into view once per link, and given the focus so a keyboard
 * or a screen reader starts there. Later refreshes keep it marked but leave the scrolling to the user.
 */
function showLinked() {
  if (linked === null || scrolledTo === linked) return
  const tr = $('list').querySelector(`tr[data-event="${linked}"]`)
  if (!tr) return
  scrolledTo = linked
  tr.tabIndex = -1
  tr.scrollIntoView({ block: 'center' })
  tr.focus({ preventScroll: true })
}
```

Edit 8: find

```js
  $('tuneCamera').value = ''

  await Promise.all([loadAlarms(), loadRules()])
```

and replace it with

```js
  $('tuneCamera').value = ''

  // A link to one alarm must find it even if someone has acknowledged it already: the list opens on
  // "still needing a look", which would hide exactly the alarm the link was sent about.
  if (linked !== null) $('filters').elements.acked.value = ''
  await Promise.all([loadAlarms(), loadRules()])
```

Edit 9: find

```js
$('logout')?.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {})
  location.href = '/login.html'
})
```

and replace it with

```js
$('logout')?.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {})
  location.href = '/login.html'
})

// A second alert tapped while this page is open changes only what follows the #: follow it here,
// without a reload. A tab link (#rules) is not an alarm and just clears the mark.
addEventListener('hashchange', () => {
  const id = eventFromHash(location.hash)
  if (id === linked) return
  linked = id
  scrolledTo = null
  for (const tr of $('list').querySelectorAll('tr.al-target')) tr.classList.remove('al-target')
  if (id === null) return
  $('filters').elements.acked.value = ''
  loadAlarms()
})
```

- [ ] **Step 7: Styles in `cctv/public/style.css`, using existing tokens only**

Find

```css
.al-when small { display: block; color: var(--text-muted); font-size: 12px; }
```

and replace it with

```css
.al-when small { display: block; color: var(--text-muted); font-size: 12px; }
/* a line crossing's picture under its name (event-snapshot.mjs); it opens full size in a new tab */
.al-snap { display: block; width: 160px; max-width: 100%; aspect-ratio: 16 / 9; margin-top: var(--s1); border-radius: var(--r-sm); overflow: hidden; background: var(--video-bg); }
.al-snap img { display: block; width: 100%; height: 100%; object-fit: cover; }
.al-snap:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
/* a phone has little width to spare for the table: a smaller picture, still enough to tell who crossed */
@media (max-width: 600px) { .al-snap { width: 112px; } }
/* the alarm a link (a phone alert) pointed at: tinted, with the accent bar whether or not it still
   needs a look, so it is found at a glance among the rest */
.al-table tbody tr.al-target { background: var(--accent-soft); }
.al-table tr.al-target td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
.al-table tr.al-target:focus { outline: 2px solid var(--focus); outline-offset: -2px; }
```

The tint is on the `tr` and not on the `td`s because the actions cell is `display: flex` and would stay untinted.

- [ ] **Step 8: Signing in from an alert link lands on the alarm (`cctv/public/login.js`)**

Find

```js
    if (res.ok) {
      location.href = '/'
      return
    }
```

and replace it with

```js
    if (res.ok) {
      // Signed out when a phone alert's link was tapped: the server sent the browser here from
      // /alarms.html#event=<id>, and the browser kept the # across that redirect (the Fetch
      // standard carries a fragment over when the new address has none). Go on to that alarm
      // rather than to the grid.
      location.href = /^#event=\d{1,15}$/.test(location.hash) ? `/alarms.html${location.hash}` : '/'
      return
    }
```

- [ ] **Step 9: Syntax check of the browser files (local)**

Run: `node --check cctv/public/alarms.js && node --check cctv/public/alarms-view.js && node --check cctv/public/login.js && echo ok`

Expected: `ok`.

- [ ] **Step 10: Check the page in the Browser pane against a fake API (nothing real is reached)**

Write this with the Write tool to `$S\alarms-fake.mjs`:

```js
// Not part of the app: serves cctv/public with a made-up /api, to look at the Alarms page's
// line-crossing pictures and #event=<id> in a browser without a server, an NVR or a sign-in.
//   node alarms-fake.mjs <path to cctv/public>      then open http://127.0.0.1:8792/alarms.html#event=9
// Alarm 9: acknowledged, far down the list, has a picture. 10: a crossing 30 s ago whose picture is
// not taken yet (404). 11: has a picture. /api/snaphits counts the picture requests per alarm.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

const PUBLIC = process.argv[2]
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }
const now = Date.now()
const MIN = 60_000
const alarms = []
for (let i = 1; i <= 40; i++) alarms.push({ id: 100 + i, nvr: 'nvr1', ch: i % 8, camera: `Camera ${i % 8}`, type: 'motion', subtype: '', priority: 'low', startMs: now - i * 10 * MIN, endMs: now - i * 10 * MIN + 20_000, ackMs: null })
const crossing = { nvr: 'nvr-2', ch: 2, camera: 'Maingate Roadway', type: 'line-crossing', subtype: 'tripwire', priority: 'high', ruleName: 'Line crossing' }
alarms.push({ ...crossing, id: 9, startMs: now - 500 * MIN, endMs: now - 500 * MIN + 10_000, ackMs: now - 400 * MIN, ackUser: 'mike', ackNote: 'test walk' })
alarms.push({ ...crossing, id: 10, startMs: now - 30_000, endMs: null, ackMs: null })
alarms.push({ ...crossing, id: 11, startMs: now - 20 * MIN, endMs: now - 20 * MIN + 12_000, ackMs: null })
const hits = {}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname
  if (p === '/api/me') return json(res, 200, { user: 'mike', admin: true, build: 'fake' })
  if (p === '/api/cameras') return json(res, 200, [])
  if (p === '/api/alarms/rules') return json(res, 200, { rules: [], admin: true })
  if (p === '/api/snaphits') return json(res, 200, hits)
  if (p === '/api/alarms') {
    const acked = url.searchParams.get('acked')
    const list = alarms.filter((a) => (acked === 'false' ? !a.ackMs : acked === 'true' ? Boolean(a.ackMs) : true)).sort((a, b) => b.startMs - a.startMs)
    return json(res, 200, { alarms: list, summary: { total: list.length, unacked: list.filter((a) => !a.ackMs).length, worst: 'high' }, admin: true, sources: { confirmed: [], notAvailable: [] } })
  }
  const snap = /^\/api\/events\/(\d+)\/snapshot$/.exec(p)
  if (snap) {
    hits[snap[1]] = (hits[snap[1]] ?? 0) + 1
    if (snap[1] === '10') return json(res, 404, { error: 'No picture for that event' })
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=300' })
    return res.end(await readFile(join(PUBLIC, 'icon-512.png')))
  }
  if (p.startsWith('/api/')) return json(res, 404, { error: 'not in the fake' })
  try {
    const file = join(PUBLIC, p === '/' ? 'alarms.html' : p)
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}).listen(8792, '127.0.0.1', () => console.log('http://127.0.0.1:8792/alarms.html#event=9'))
```

1. Start it with the Bash tool, `run_in_background: true`:
   `node "$S/alarms-fake.mjs" "C:/Users/mike/Downloads/websdk3.2/TVT-CCTV/cctv/public"`
2. Open `http://127.0.0.1:8792/alarms.html#event=9` with `preview_start` (`url`) and take a screenshot.
3. Run this with `javascript_tool`:

```js
await new Promise(r => setTimeout(r, 1500));
const pick = () => [...document.querySelectorAll('#list tr')].filter(tr => ['9','10','11'].includes(tr.dataset.event)).map(tr => `${tr.dataset.event}:${tr.classList.contains('al-target') ? 'T' : '-'}:${tr.querySelector('.al-snap') ? 'pic' : 'nopic'}`)
const first = { rows: pick(), focused: document.activeElement?.dataset?.event, acked: document.getElementById('filters').elements.acked.value, hits: await fetch('/api/snaphits').then(r => r.json()) }
document.querySelector('#list tr[data-event="10"]').scrollIntoView(); await new Promise(r => setTimeout(r, 1200));
({ first, after: { rows: pick(), hits: await fetch('/api/snaphits').then(r => r.json()) } })
```

Expected:
- `first.acked === ''`
- `first.focused === '9'`
- `first.rows` contains `9:T:pic`
- `first.hits` is `{ "9": 1 }`: the lazy thumbnails have not loaded yet
- `after.rows` is `["10:-:nopic", "11:-:pic", "9:T:pic"]`: the 404 picture is removed
- `after.hits` is `{ "9": 1, "10": 1, "11": 1 }`

The screenshot shows the Maingate Roadway row tinted across its full width, with its thumbnail under "Line crossing (tripwire)".

4. Set `location.hash = '#event=999'`. The summary ends with "The alarm the link points to (number 999) is not in the list below: …".
5. Set `location.hash = '#rules'`. The Rules tab shows and no row is marked.
6. Stop the server: `PowerShell: $c = Get-NetTCPConnection -LocalPort 8792 -State Listen; Stop-Process -Id $c.OwningProcess -Force -Confirm:$false`

- [ ] **Step 11: The Alarms suites on the server copy**

Run Task 8 Step 1 (b), then (c) with `cctv/test/alarms.test.mjs cctv/test/alarms-view.test.mjs`.

Expected: both `rc=0 fails=0`, then `DONE: 2 suites, 0 not passing`.

- [ ] **Step 12: Commit the Alarms page**

```bash
cd /c/Users/mike/Downloads/websdk3.2/TVT-CCTV
git add cctv/public/alarms-view.js cctv/public/alarms.js cctv/public/style.css cctv/public/login.js cctv/test/alarms-view.test.mjs
git commit -F - <<'EOF'
Alarms page: line-crossing pictures, and #event=<id> opens that alarm

- A line-crossing row shows its picture (GET /api/events/:id/snapshot) under its name, loaded
  lazily and kept across the 30 s refresh; a missing one is asked for again only while it may
  still be being taken (5 min after the crossing).
- /alarms.html#event=<id>, the link in a phone alert, lists acknowledged alarms too, scrolls to
  that row once, marks and focuses it; a link to an alarm not in the list says why it may be
  missing. A second link followed while the page is open is followed too.
- Signing in from such a link goes on to that alarm instead of the grid.
- The pure parts are in alarms-view.js, tested by cctv/test/alarms-view.test.mjs.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 13: Docs, a CHANGELOG entry, and commit**

In `CHANGELOG.md`, find

```
- Multi-camera playback (phase 8) on the Wall page: a searchable camera list, saved views kept with
```

and replace it with

```
- Line crossing: an admin draws up to four lines on a camera's live picture (full-size Live view,
  **Lines**) and Argus writes them into the camera's own line-crossing detection through the NVR
  (`/api/admin/nvrs/:id/channels/:ch/lines`, `cctv/tripwire.mjs`): confirmed, logged before it is
  sent, read back field by field, undoable, and refused while the camera's sound or white-light
  trigger is on. Crossings are read from the NVR's live alarm list every 5 s (`cctv/alarm-watch.mjs`)
  and become "Line crossing" alarms within seconds, each with a phone alert through ntfy for the
  cameras switched on in the panel (the "Line crossing" alarm rule), a bookmark from 30 s before
  to 60 s after, and a picture taken from Argus's own recording (`GET /api/events/:id/snapshot`)
  shown on the Alarms page. The alert's link, `/alarms.html#event=<id>`, opens that alarm.
- Multi-camera playback (phase 8) on the Wall page: a searchable camera list, saved views kept with
```

```bash
cd /c/Users/mike/Downloads/websdk3.2/TVT-CCTV
git add CHANGELOG.md
git commit -F - <<'EOF'
Changelog: line crossing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 14: Full test run, local**

Run from Git Bash, with every task's commits in:

```bash
cd /c/Users/mike/Downloads/websdk3.2/TVT-CCTV
for f in cctv/test/*.test.mjs; do
  d0="$(mktemp -d)"; d="$(cygpath -m "$d0")"
  out="$(DATA_DIR="$d" timeout 300 node "$f" 2>&1)"; rc=$?
  rm -rf "$d0"
  if printf '%s' "$out" | grep -q 'Application Control policy has blocked'; then echo "server-only  $f"
  elif [ "$rc" = 0 ]; then echo "ok           $f"
  else echo "FAIL rc=$rc  $f"; printf '%s\n' "$out" | grep -E '^FAIL|Error' | head -n 5 | sed 's/^/    /'; fi
done
```

Each test gets its own data folder, given as a Windows path so node reads it unchanged. A suite that reaches koffi (sdk.mjs) is blocked on this PC and is reported as `server-only`.

Expected: every suite is `ok` or `server-only`. The only allowed exception is `FAIL rc=1  cctv/test/sps.test.mjs` (`ENOENT … /work/cranes.bin`). Any other FAIL must be fixed before merging (superpowers:systematic-debugging), unless its own output says it needs Linux or ffmpeg and it then passes in Step 15.

- [ ] **Step 15: Full test run on the server copy**

Run Task 8 Step 1 (b), then (d), and poll until `DONE:`.

Expected: `grep -v "^rc=0 fails=0"` shows only:
- `sps.test.mjs` (`ENOENT … /work/cranes.bin`)
- `substreams.test.mjs` (`ENOENT … /work/live-nvr1-queryNetworkNodeEncodeInfo.xml`)
- the `DONE: N suites, 2 not passing` line.

Anything else is fixed, committed, and this step is repeated.

- [ ] **Step 16: Merge and deploy**

```bash
cd /c/Users/mike/Downloads/websdk3.2/TVT-CCTV
git status --short
git -c core.autocrlf=false checkout master
git -c core.autocrlf=false merge --ff-only line-crossing
git diff --quiet ORIG_HEAD HEAD -- package.json && echo "package.json unchanged"
bash deploy/push.sh --linux cctv@192.168.1.232 --code-only
```

- `git status --short` must show nothing but `?? .superpowers/`.
- `core.autocrlf=false` writes the files exactly as committed (LF). This checkout has `core.autocrlf=true`, and CRLF files have made push.sh refuse ("package.json changed") before.
- If `--ff-only` refuses because master moved, run `git checkout line-crossing && git rebase master`, repeat Steps 14-15, then repeat this step.
- The push must end with the installer's output and exit 0. `--code-only` refuses when package.json differs; this branch adds no dependency.

- [ ] **Step 17: After the deploy: running, healthy, and quiet**

```bash
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'cat /opt/cctv/current/RELEASE; systemctl is-active cctv; curl -sk -o /dev/null -w "healthz %{http_code}\n" https://localhost:8443/healthz; sudo journalctl -u cctv --since "-5 min" --no-pager -o cat | grep -iE "\[(alarm-watch|lines|tripwire|snapshot)\]|TypeError|ReferenceError|SyntaxError|Cannot find" | tail -n 20' < /dev/null
```

Expected:
- the new release name, printed by push.sh
- `active`
- `healthz 200`
- no matching journal lines: with no lines on, the watcher asks nothing.

Otherwise roll back with the previous release (`/opt/cctv/releases`, see deploy/install-ubuntu.sh) and debug.

- [ ] **Step 18: The live-test client**

Write this with the Write tool to `$S\lines-live.mjs` (a scratch file, not in the repo), then copy it to the server.

```js
// Live test of line crossing on Maingate Roadway (nvr-2, camera 3 = channel index 2). Runs ON the
// server as root: it signs a session for the first admin in users.json, as the bench scripts do,
// and makes every call through Argus's own HTTP API on https://localhost:8443. Nothing here talks
// to the NVR directly, and only `set`, `undo` and `alert` change anything.
//   sudo env DATA_DIR=/var/lib/cctv /usr/local/bin/node /tmp/lines-live/lines-live.mjs <command>
// commands:
//   view                        the camera's line settings as Argus reads them (GET .../lines)
//   frame                       one picture from the camera's sub-stream -> /tmp/lines-live/frame.jpg
//   set X1 Y1 X2 Y2 [KEYS]      line 1 from (X1,Y1) to (X2,Y2) (0..10000, top left 0,0), both
//                               directions; detection on; hold 10 s. Warnings are acknowledged only
//                               when every one's key is in KEYS (comma-separated); otherwise printed.
//   undo                        put back what the newest change replaced
//   alert on|off                this camera in or out of the "Line crossing" phone alert
//   events SINCE                this camera's line-crossing alarms since SINCE (ISO time)
//   bookmarks SINCE             this camera's bookmarks since SINCE
//   snapshot ID                 the picture of alarm ID -> /tmp/lines-live/event-ID.jpg
// Exit 0 = as expected; 3 = warnings not acknowledged; 4 = the camera did not end up as asked.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createSession, loadUsers } from '/opt/cctv/current/cctv/auth.mjs'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const BASE = 'https://localhost:8443'
const NVR = 'nvr-2'
const CH = 2
const KEY = `${NVR}/${CH}`
const OUT = '/tmp/lines-live'
const LINES = `/api/admin/nvrs/${NVR}/channels/${CH}/lines`
mkdirSync(OUT, { recursive: true })

const admin = Object.entries(loadUsers()).find(([, u]) => u.role === 'admin')?.[0]
if (!admin) {
  console.log('no admin account in users.json')
  process.exit(2)
}
const cookie = `cctv_session=${createSession(admin)}`

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const buf = Buffer.from(await res.arrayBuffer())
  let json = null
  try {
    json = JSON.parse(buf.toString('utf8'))
  } catch {}
  return { status: res.status, type: res.headers.get('content-type') ?? '', json, buf }
}
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '-')
const sinceMs = (arg) => {
  const ms = Date.parse(arg ?? '')
  if (!Number.isFinite(ms)) {
    console.log('give a time, e.g. 2026-09-28T14:05:00Z')
    process.exit(2)
  }
  return ms
}
const isSet = (l) => Boolean(l.start.x || l.start.y || l.end.x || l.end.y)
const lineText = (l, i) => `  line ${i + 1}: ${l.direction} (${l.start.x},${l.start.y}) -> (${l.end.x},${l.end.y})${isSet(l) ? '' : ' [unset]'}`

async function readView() {
  const r = await api('GET', LINES)
  if (r.status !== 200) {
    console.log(`GET lines: ${r.status} ${r.buf.toString('utf8').slice(0, 300)}`)
    process.exit(1)
  }
  return r.json.lines
}

function printResult(result) {
  console.log(`result: ${result.status ?? ''} ${result.message ?? ''}`)
  for (const f of result.fields) console.log(`  ${f.status === 'as asked' ? 'ok ' : 'NO '} ${f.key}: wanted ${f.want}, camera has ${f.got} (${f.status})`)
  for (const s of result.sideEffects) console.log(`  SIDE EFFECT ${s.key}: ${s.from} -> ${s.to}`)
  if (result.warningsAcked?.length) console.log(`  acknowledged: ${result.warningsAcked.join(', ')}`)
  const good = result.fields.length > 0 && result.fields.every((f) => f.status === 'as asked') && result.sideEffects.length === 0
  console.log(good ? 'ALL AS ASKED, NO SIDE EFFECTS' : 'NOT AS ASKED: undo it (node lines-live.mjs undo) and report')
  return good
}

/** POSTs once; on a 409 asking for acknowledgements, once more with them if every key is allowed. */
async function postWithAck(body, allowed) {
  let r = await api('POST', LINES, body)
  if (r.status === 409 && Array.isArray(r.json?.needsAck)) {
    for (const w of r.json.needsAck) console.log(`warning ${w.key}: ${w.text}`)
    const missing = r.json.needsAck.filter((w) => !allowed.includes(w.key))
    if (missing.length) {
      console.log(`not acknowledged: ${missing.map((w) => w.key).join(', ')}. Nothing was sent. Take these to the owner.`)
      process.exit(3)
    }
    r = await api('POST', LINES, { ...body, ack: r.json.needsAck.map((w) => w.key), ackToken: r.json.ackToken })
  }
  if (r.status !== 200) {
    console.log(`POST lines: ${r.status} ${r.buf.toString('utf8').slice(0, 400)}`)
    process.exit(1)
  }
  return r.json
}

const [cmd, ...args] = process.argv.slice(2)

if (cmd === 'view') {
  const cams = await api('GET', '/api/cameras')
  const list = Array.isArray(cams.json) ? cams.json : cams.json?.cameras ?? []
  const cam = list.find((c) => c.nvr === NVR && c.ch === CH)
  console.log(`camera ${KEY}: ${cam?.name ?? '(not listed)'} | ${cam?.model ?? '?'} | ${cam?.online ? 'online' : 'OFFLINE'} | recorded by Argus: ${cam?.recording ?? '?'}`)
  const v = await readView()
  console.log(`supported ${v.supported} | device ${v.device} | undo ${v.undo ? `${v.undo.seq} (${v.undo.at} by ${v.undo.by})` : 'none'} | ntfy topic set ${v.ntfy?.topicSet}`)
  if (!v.cfg) process.exit(v.supported ? 1 : 0)
  const c = v.cfg
  const schedule = v.schedules.find((s) => s.id === c.scheduleGuid)?.name ?? c.scheduleGuid
  console.log(`chlId ${c.chlId} | enabled ${c.enabled} | hold ${c.holdTime} s (choices ${c.holdChoices.join(',')}) | schedule ${schedule}`)
  console.log(`filter ${JSON.stringify(c.filter)} | directions ${c.directions.join(',')}`)
  console.log(`mutex ${c.mutex.map((m) => `${m.object}=${m.on}`).join(' ')} | triggerAudio ${c.triggerAudio} | triggerWhiteLight ${c.triggerWhiteLight}`)
  c.lines.forEach((l, i) => console.log(lineText(l, i)))
  console.log(`trigger ${JSON.stringify(c.trigger)}`)
} else if (cmd === 'frame') {
  // One keyframe of the sub-stream (cheap for the NVR), as the browser gets it: a 16-byte header
  // (byte 0 bit 0 = keyframe, byte 1 = codec, 0 H.264 / 1 H.265), then the Annex B picture.
  const { default: WebSocket } = await import('/opt/cctv/current/node_modules/ws/wrapper.mjs')
  const key = await new Promise((resolve) => {
    const ws = new WebSocket(`wss://localhost:8443/live?nvr=${NVR}&ch=${CH}&stream=1&h265=1`, { headers: { cookie, origin: BASE }, rejectUnauthorized: false })
    const done = (v) => {
      clearTimeout(timer)
      ws.terminate()
      resolve(v)
    }
    const timer = setTimeout(() => done(null), 30_000)
    ws.on('message', (d, binary) => {
      if (binary && d.length > 16 && (d[0] & 1) === 1) done({ codec: d[1] === 1 ? 'hevc' : 'h264', data: Buffer.from(d.subarray(16)) })
    })
    ws.on('error', (e) => {
      console.log(`live: ${e.message}`)
      done(null)
    })
  })
  if (!key) {
    console.log('no keyframe within 30 s')
    process.exit(1)
  }
  writeFileSync(`${OUT}/frame.${key.codec}`, key.data)
  const ff = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', key.codec, '-i', `${OUT}/frame.${key.codec}`, '-frames:v', '1', '-q:v', '3', `${OUT}/frame.jpg`], { encoding: 'utf8' })
  if (ff.status !== 0) {
    console.log(`ffmpeg failed: ${ff.stderr}`)
    process.exit(1)
  }
  console.log(`${OUT}/frame.jpg (${key.codec} keyframe, ${key.data.length} bytes)`)
} else if (cmd === 'set') {
  const [x1, y1, x2, y2] = args.slice(0, 4).map(Number)
  const allowed = (args[4] ?? '').split(',').filter(Boolean)
  if (![x1, y1, x2, y2].every((n) => Number.isInteger(n) && n >= 0 && n <= 10000)) {
    console.log('give four whole numbers 0..10000: X1 Y1 X2 Y2')
    process.exit(2)
  }
  const v = await readView()
  if (!v.supported || !v.cfg) {
    console.log('this camera reports no line-crossing detection')
    process.exit(1)
  }
  // line 1 is the test line; the other slots are sent back exactly as the camera has them
  const lines = v.cfg.lines.map((l, i) => (i === 0 ? { direction: 'none', start: { x: x1, y: y1 }, end: { x: x2, y: y2 } } : { direction: l.direction, start: { ...l.start }, end: { ...l.end } }))
  const change = { enabled: true, holdTime: 10, lines }
  console.log(`asking: ${JSON.stringify(change)}`)
  const answer = await postWithAck({ device: v.device, seen: v.seen, change, confirm: true }, allowed)
  const good = printResult(answer.result)
  answer.lines.cfg.lines.forEach((l, i) => console.log(lineText(l, i)))
  console.log(`enabled ${answer.lines.cfg.enabled} | hold ${answer.lines.cfg.holdTime} s | undo seq ${answer.lines.undo?.seq ?? 'none'}`)
  process.exit(good ? 0 : 4)
} else if (cmd === 'undo') {
  const v = await readView()
  if (!v.undo) {
    console.log('nothing to undo')
    process.exit(1)
  }
  const answer = await postWithAck({ device: v.device, undo: true, seq: v.undo.seq, confirm: true }, ['mutex', 'no-filter', 'short-hold', 'no-lines'])
  process.exit(printResult(answer.result) ? 0 : 4)
} else if (cmd === 'alert') {
  if (!['on', 'off'].includes(args[0])) {
    console.log('alert on|off')
    process.exit(2)
  }
  const r = await api('POST', '/api/admin/lines/alert', { nvr: NVR, ch: CH, on: args[0] === 'on' })
  if (r.status !== 200) {
    console.log(`POST alert: ${r.status} ${r.buf.toString('utf8').slice(0, 300)}`)
    process.exit(1)
  }
  const { rule, ntfy } = r.json
  console.log(`rule "${rule.name}" enabled ${rule.enabled} | cameras ${rule.cameras.join(', ')} | types ${rule.types.join(',')} | priority ${rule.priority} | notify ${rule.notify} | gap ${rule.minGapS} s`)
  // the server the phone subscribes on: only this one field of the settings file is read
  let server = 'https://ntfy.sh'
  try {
    server = JSON.parse(readFileSync(`${process.env.DATA_DIR ?? '/var/lib/cctv'}/settings.json`, 'utf8'))?.alerts?.ntfy?.url || server
  } catch {}
  console.log(`ntfy server ${server} | topic ${ntfy.topic}${ntfy.created ? ' (new: the owner subscribes to it in the ntfy app)' : ''}`)
} else if (cmd === 'events') {
  const from = sinceMs(args[0])
  const r = await api('GET', `/api/alarms?from=${from}&types=line-crossing&cameras=${encodeURIComponent(KEY)}`)
  if (r.status !== 200) {
    console.log(`GET alarms: ${r.status}`)
    process.exit(1)
  }
  if (!r.json.alarms.length) console.log('no line-crossing alarms for this camera since then')
  for (const a of r.json.alarms) {
    const lag = Number.isFinite(a.seenMs) ? `${((a.seenMs - a.startMs) / 1000).toFixed(1)} s` : '?'
    console.log(`id ${a.id} | ${a.subtype} | start ${iso(a.startMs)} | end ${iso(a.endMs)} | seen ${iso(a.seenMs)} (lag ${lag}) | source ${a.source} | ${a.priority} by "${a.ruleName ?? '-'}" | notified ${iso(a.notifiedMs)}`)
  }
} else if (cmd === 'bookmarks') {
  const from = sinceMs(args[0])
  const r = await api('GET', `/api/bookmarks?camera=${encodeURIComponent(KEY)}&from=${from - 120_000}`)
  if (r.status !== 200) {
    console.log(`GET bookmarks: ${r.status}`)
    process.exit(1)
  }
  if (!r.json.bookmarks.length) console.log('no bookmarks for this camera since then')
  for (const b of r.json.bookmarks) console.log(`id ${b.id} | ${iso(b.startMs)} .. ${iso(b.endMs)} | by ${b.user} | ${b.title}`)
} else if (cmd === 'snapshot') {
  const id = Number(args[0])
  if (!Number.isSafeInteger(id) || id <= 0) {
    console.log('snapshot ID')
    process.exit(2)
  }
  const r = await api('GET', `/api/events/${id}/snapshot`)
  if (r.status !== 200) {
    console.log(`GET snapshot: ${r.status} ${r.buf.toString('utf8').slice(0, 200)}`)
    process.exit(1)
  }
  writeFileSync(`${OUT}/event-${id}.jpg`, r.buf)
  console.log(`${OUT}/event-${id}.jpg (${r.type}, ${r.buf.length} bytes)`)
} else {
  console.log('commands: view | frame | set X1 Y1 X2 Y2 [KEYS] | undo | alert on|off | events SINCE | bookmarks SINCE | snapshot ID')
  process.exit(2)
}
process.exit(0)
```

```bash
S=/c/Users/mike/AppData/Local/Temp/claude/C--Users-mike-Downloads-websdk3-2/224c4b4b-edba-4a0e-b617-76eab964a246/scratchpad
node --check "$S/lines-live.mjs" && MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'mkdir -p /tmp/lines-live && cat > /tmp/lines-live/lines-live.mjs' < "$S/lines-live.mjs"
```

- [ ] **Step 19: GET the view of Maingate Roadway**

```bash
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'sudo env DATA_DIR=/var/lib/cctv /usr/local/bin/node /tmp/lines-live/lines-live.mjs view' < /dev/null
```

Expected (the same as fixture `tripwire-ch3.xml`):
- `camera nvr-2/2: Maingate Roadway | IP619E5W-28-S4 | online | recorded by Argus: true`
- `supported true`
- `chlId {00000003-0000-0000-0000-000000000000} | enabled false | hold 20 s (choices 3,5,10,20,30,60,120)`
- `filter null`
- `mutex perimeter=false osc=false | triggerAudio false | triggerWhiteLight false`
- four `[unset]` lines
- trigger `rec` Maingate Roadway, `msgPush` true.

Stop and report to the owner, without writing anything, if any of these holds:
- the camera is not supported
- `triggerAudio` or `triggerWhiteLight` is true (the floodlight is worked by hand only)
- a mutex detection is on
- a line is already set
- the camera is offline.

`recorded by Argus: false` does not stop the test, but it means no snapshot can be taken; say so in the report.

- [ ] **Step 20: Look at the picture and choose the line**

```bash
S=/c/Users/mike/AppData/Local/Temp/claude/C--Users-mike-Downloads-websdk3-2/224c4b4b-edba-4a0e-b617-76eab964a246/scratchpad
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'sudo env DATA_DIR=/var/lib/cctv /usr/local/bin/node /tmp/lines-live/lines-live.mjs frame' < /dev/null
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/scp.exe -o BatchMode=yes cctv@192.168.1.232:/tmp/lines-live/frame.jpg "$(cygpath -m "$S")/maingate-frame.jpg"
```

Open `$S\maingate-frame.jpg` with the Read tool. Choose a line across the roadway, from one edge of the road to the other, at a point where a person walking along it is at least about 1/10 of the picture high. Convert pixels to units: `x = round(px_x / width * 10000)`, `y = round(px_y / height * 10000)`. The line must be at least 2000 units long (the minimum is 500) and its start must differ from its end.

If `frame` fails, use `1000 5000 9000 5000`: across the middle of the picture, both directions.

- [ ] **Step 21: POST one line (enabled, hold 10 s) and check the read-back**

```bash
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'sudo env DATA_DIR=/var/lib/cctv /usr/local/bin/node /tmp/lines-live/lines-live.mjs set X1 Y1 X2 Y2 no-filter' < /dev/null
```

Use the four numbers from Step 20. Only `no-filter` is pre-acknowledged. The owner chose this camera knowing it has no person/vehicle filter (spec, "First live test").

Expected, exit 0:
- `warning no-filter: …`
- a `result:` line
- `ok` for `enabled`, `holdTime`, `line.0.direction`, `line.0.start`, `line.0.end` (all `as asked`)
- `acknowledged: no-filter`
- `ALL AS ASKED, NO SIDE EFFECTS`
- `line 1: none (X1,Y1) -> (X2,Y2)` and three `[unset]` lines
- `enabled true | hold 10 s | undo seq …`

If it exits with a failure:
- Exit 3 (another warning, e.g. `mutex`): nothing was sent. Take the printed text to the owner.
- Exit 4 (not as asked, or a side effect): run the same command with `undo`, expect `ALL AS ASKED`, and report.
- A 409 `stale`: run `view` and repeat.

Then check the files and the watcher:

```bash
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'sudo cat /var/lib/cctv/lines-on.json; echo; sudo tail -n 2 /var/lib/cctv/tripwire-changes.log | cut -c1-240; sleep 20; sudo journalctl -u cctv --since "-1 min" --no-pager -o cat | grep -E "\[alarm-watch\]" || echo "alarm watch: no complaints"' < /dev/null
```

Expected:
- `lines-on.json` contains `"nvr-2/2":true`
- the log holds the change entry (with the full before-state) and a result line
- `alarm watch: no complaints`.

- [ ] **Step 22: Phone alert on for this camera**

```bash
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'sudo env DATA_DIR=/var/lib/cctv /usr/local/bin/node /tmp/lines-live/lines-live.mjs alert on && sudo env DATA_DIR=/var/lib/cctv /usr/local/bin/node /tmp/lines-live/lines-live.mjs view | sed -n 2p' < /dev/null
```

Expected:
- `rule "Line crossing" enabled true | cameras nvr-2/2 | types line-crossing | priority high | notify true | gap 30 s`
- `ntfy server https://ntfy.sh | topic argus-<20 letters and digits> (new: …)`
- the view line ends `ntfy topic set true`.

- [ ] **Step 23: Ask the owner for a test walk**

Send the owner the following (it is their topic, so naming it to them is the point; it goes nowhere else):

"Line crossing is on for Maingate Roadway. There is one line from <where, from the picture>, and a crossing counts in either direction.
1. In the ntfy app, subscribe to topic `<topic>` on `<server>`.
2. Walk once across the roadway through that line, at a normal pace, and tell me roughly when (site time)."

Site time is UTC−4; convert it to UTC for the next steps.

- [ ] **Step 24: The event arrives within seconds (events DB and journal)**

Run this within about 10 s of the owner's time:

```bash
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'sudo env DATA_DIR=/var/lib/cctv /usr/local/bin/node /tmp/lines-live/lines-live.mjs events $(date -u -d "-15 min" +%FT%TZ); sudo journalctl -u cctv --since "-15 min" --no-pager -o cat | grep -E "\[(alarm-watch|lines|snapshot|alarms|alerts|tripwire)\]"' < /dev/null
```

The events come from the events table, read through `GET /api/alarms`.

Expected: at least one row `id N | tripwire | start … | seen … (lag L s) | source alarm-status | high by "Line crossing" | notified …`, with:
- `start` within a few seconds of the owner's time
- lag under 15 s (the 5 s poll plus the NVR)
- `notified` set.

The journal shows no `[alerts] ntfy failed`, no `[lines] … failed` and no `[alarm-watch] nvr-2: could not read`.

If nothing arrives within 30 s:
- the journal's `[alarm-watch]` lines say whether the NVR's list could not be read;
- `view` shows whether the line is still set;
- ask for one more walk, slower, across the middle of the line.

If the lag is negative or over 60 s, compare the owner's time with `seen`: the NVR clock may be off.

- [ ] **Step 25: The ntfy alert**

The owner confirms their phone showed a "Line crossing" alert for Maingate Roadway within seconds of the walk, with the site time and a link. The row from Step 24 has `notified` set, and the journal has no `[alerts] ntfy failed after`.

- [ ] **Step 26: The bookmark**

```bash
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'sudo env DATA_DIR=/var/lib/cctv /usr/local/bin/node /tmp/lines-live/lines-live.mjs bookmarks $(date -u -d "-15 min" +%FT%TZ)' < /dev/null
```

Expected: one bookmark `by system`, from at most `start − 30 s` to at least `start + 60 s` of the event in Step 24. A second crossing within that window stretches it rather than adding another.

- [ ] **Step 27: The snapshot file**

Wait until the journal shows `[snapshot] nvr-2/2 event N: taken …`. That is within 3 minutes of the crossing. Then:

```bash
S=/c/Users/mike/AppData/Local/Temp/claude/C--Users-mike-Downloads-websdk3-2/224c4b4b-edba-4a0e-b617-76eab964a246/scratchpad
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'sudo journalctl -u cctv --since "-15 min" --no-pager -o cat | grep "\[snapshot\]"; sudo ls -l /var/lib/cctv/event-snaps/N.jpg; sudo env DATA_DIR=/var/lib/cctv /usr/local/bin/node /tmp/lines-live/lines-live.mjs snapshot N' < /dev/null
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/scp.exe -o BatchMode=yes cctv@192.168.1.232:/tmp/lines-live/event-N.jpg "$(cygpath -m "$S")/maingate-event-N.jpg"
```

N is the id from Step 24. Expected:
- the `taken … s after the start (… bytes)` line
- the file listed
- `/tmp/lines-live/event-N.jpg (image/jpeg, … bytes)`.

Open the copy with the Read tool: it is the roadway at the moment of the crossing, and the walker should be on or near the line.

- [ ] **Step 28: The link opens the alarm on the Alarms page**

The owner taps the link in the ntfy alert on their phone. The Alarms page opens on that alarm: the row is tinted and focused, and its picture sits under "Line crossing (tripwire)".

If the phone was signed out, sign in; the page then goes straight on to that alarm (Step 8). The same address, `https://cctv.jfl.gripe/alarms.html#event=N`, opened on the PC shows the same thing.

- [ ] **Step 29: No duplicate from the recording-list intake, clean-up, report**

At least 30 minutes after the walk, once the recording-list intake has reached nvr-2/2, run `events` again with the Step 24 command, using a "since" 5 minutes before the walk.

Expected: still one alarm per crossing. The intake's recording (bits 0x80/0x400) extended it instead of adding a second one (Task 3's 30 s merge).

Then clean up:

```bash
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'sudo rm -rf /tmp/lines-live /tmp/lines-test' < /dev/null
```

Report to the owner:
- the release deployed
- the test results: local, and the server copy with only sps/substreams failing
- the line as set, with its coordinates
- every read-back field `as asked` and no side effects
- the event and its lag
- the ntfy alert
- the bookmark
- the snapshot
- the Alarms page link
- anything that did not go as expected.

The line and the phone alert stay on; that is what they are for. Say that the Lines panel's Undo, or its "Alert my phone" switch, turns them off.

---

## Appendix: Interface contract


Spec: C:\Users\mike\Downloads\websdk3.2\TVT-CCTV\docs\superpowers\specs\2026-09-27-line-crossing-design.md
Fixtures (captured from nvr-2, 2026-09-27): C:\Users\mike\AppData\Local\Temp\claude\C--Users-mike-Downloads-websdk3-2\224c4b4b-edba-4a0e-b617-76eab964a246\scratchpad\lcprobe\
  tripwire-ch1.xml (IP6196W: objectFilter with min/max), tripwire-ch3.xml (IP619E5W: no filter),
  tripwire-ch4.xml (CAM-IP6196G: filter without min/max), nodelist.xml, schedulelist.xml, alarmstatus.xml,
  systemcaps.xml, perimeter-ch1.xml, airesource.xml
Web client (reference for the edit body): ...\scratchpad\nvrweb\js\app\AlarmCfg\tripwireAlarmCfg.js, getSaveData at byte ~35310.
Task 1 copies the fixtures to cctv/test/fixtures/lines/ (same file names); later tasks read them from there.

Code style: plain ESM .mjs, no TypeScript, no new npm deps, 2-space indent, no semicolons, comments in
plain English explaining why (match surrounding files). Tests are plain node scripts in cctv/test/*.test.mjs
with `const check = (n, ok, e = '') => {...}` printing PASS/FAIL and exiting 1 on failure (see
cctv/test/sub-cap.test.mjs). Pure modules must not import sdk.mjs (koffi is blocked on the Windows PC);
tests that need the SDK or ffmpeg run on the server only (say so in the step).

## Task 1 — cctv/tripwire-xml.mjs (pure: parse, change, validate, build, compare)
```
export const DIRECTIONS = ['rightortop', 'leftorbotton', 'none']   // A->B, A<-B, both
export const HOLD_MIN_SAFE_S = 10
export const MIN_LINE_FRACTION = 0.05          // a line shorter than 5% of the picture (in 0..10000 units: 500) is refused
export function parseTripwire(xml) -> cfg | throws Error('<reason>')
  cfg = {
    chlId: '{00000003-...}', scheduleGuid: '{...}',
    enabled: boolean, holdTime: number, holdChoices: number[],
    filter: null
          | { kind: 'objects', classes: { car?: Cls, person?: Cls, motor?: Cls } }   // Cls = { on: boolean, sensitivity: number, min?: {width,height}, max?: {width,height} }
          | { kind: 'single', sensitivity: number },
    lines: [{ direction: 'rightortop'|'leftorbotton'|'none', start: {x,y}, end: {x,y}, sensitivity: number|null }],  // length = slot count (4)
    directions: string[],               // from <types><direction>
    mutex: [{ object: string, on: boolean }],
    triggerAudio: boolean, triggerWhiteLight: boolean,
    saveTargetPicture: boolean|null, saveSourcePicture: boolean|null, autoTrack: string|null,
    trigger: { rec: [{ id, name }], alarmOuts: [{ id, name }], presets: [{ index, name, chlId, chlName }],
               snap: boolean, msgPush: boolean, buzzer: boolean, popVideo: boolean, email: boolean, sysAudio: string,
               // answer-only (never sent; compared on read-back):
               recOn: boolean|null, sysSnap: { on: boolean, chls: string[] }|null, popMsg: boolean|null,
               manualAudio: boolean|null, manualLight: boolean|null }
  }
export function parseSupport(xml) -> Map<string chlId, { tripwire: boolean, pea: boolean }>   // queryNodeList
export function parseSchedules(xml) -> [{ id, name }]                                         // queryScheduleList
export function applyChange(cfg, change) -> next cfg (deep copy; cfg untouched)
  change = { enabled?: boolean, holdTime?: number, scheduleGuid?: string,
             lines?: [{ direction, start: {x,y}, end: {x,y} }]   // exactly cfg.lines.length items; a cleared slot is all zeros
             filter?: { car?: { on, sensitivity }, person?: {...}, motor?: {...} } | { sensitivity } }
export function checkChange(cfg, change, { schedules = [] } = {}) -> { refuse: string|null, warnings: [{ key, text }] }
  refuse: unknown keys; wrong slot count; coordinate not an integer 0..10000; a set line shorter than 500 units
          or start = end; direction not in cfg.directions; holdTime not in holdChoices; scheduleGuid not in schedules
          (when schedules given); filter class the camera does not have; sensitivity outside 1..100;
          cfg.triggerAudio or cfg.triggerWhiteLight true ("the camera's sound/white-light trigger is on; set it off
          on the NVR first — the floodlight is worked by hand only"); nothing changes.
  warnings (keys): 'mutex' (turning on while a mutex detection is on), 'no-filter' (enabling on a camera with
          filter === null), 'short-hold' (holdTime < HOLD_MIN_SAFE_S while enabled), 'no-lines' (enabled with no set line)
export function buildEditTripwire(cfg) -> xml string   // EXACTLY the web client's getSaveData element order/names,
  with <?xml ...?><request version="1.0" systemType="NVMS-9000" clientType="WEB"> header and </request> end
  (use nvr-xml.mjs XML_HEADER if it exists; else the literal). Never includes triggerAudio/triggerWhiteLight.
  Integers only for coordinates. Names in trigger items escaped (CDATA as the web client, or esc()).
export function flatten(cfg) -> Record<string, string>   // 'enabled', 'holdTime', 'schedule', 'line.0.direction',
  'line.0.start', 'line.0.end', 'filter.person.on', 'filter.person.sensitivity', ..., 'trigger.msgPush', 'trigger.sysSnap', ...
export function compareReadBack(before, asked, after) -> { fields: [{ key, want, got, status: 'as asked'|'not applied' }],
                                                           sideEffects: [{ key, from, to }] }
  fields = keys where flatten(asked) differs from flatten(before); sideEffects = keys not asked that differ between before and after.

## Task 2 — cctv/tripwire.mjs (server route, safe-change flow) + server.mjs wiring
```
export const LINES_LOG = join(DATA_DIR, 'tripwire-changes.log')
export const LINES_ON_FILE = join(DATA_DIR, 'lines-on.json')      // { "<nvrId>/<ch>": true }
export function linesOn() -> Set<string '<nvrId>/<ch>'>            // cached read of LINES_ON_FILE
export function noteLinesOn(nvrId, ch, on) -> void                // write-through (tmp + rename)
export async function handleLines(method, nvrId, ch, params, readJson, user, deps?) -> [status, body]
  GET  -> [200, { lines: view }]  view = { supported, cfg, schedules, device, seen, undo: {seq, at, by}|null, ntfy: { topicSet: boolean } }
  POST { device, seen, change, ack?, ackToken?, confirm: true }         -> [200, { lines: view, result }]
  POST { device, undo: true, seq, ack?, ackToken?, confirm: true }     -> [200, { lines: view, result }]
  result = { fields, sideEffects, warningsAcked: string[] }  (compareReadBack output)
  409 { error, stale: true } when the camera changed since `seen`; 409 { error, needsAck: [{key,text}], ackToken } when warnings unacked
```
Route: `/api/admin/nvrs/:id/channels/:ch/lines` inside server.mjs's /api/admin block (same-origin + JSON checks, admins only),
exactly like `/image` and `/stream` routes. Uses nvr-xml.mjs helpers (transparent, cameraOf, requireOnline, deviceOf,
withNvrLock, HttpError, errorAnswer, readLogCached, rotateLog, chlIdOf) — the task must read nvr-xml.mjs and imaging.mjs /
streams.mjs to use the real names and copy their seen/ack/ackToken/log/readUntil/undo pattern.

## Task 3 — event kind 'line-crossing'
- cctv/public/alarms-view.js EVENT_KINDS gets `{ type: 'line-crossing', label: 'Line crossing', confirmed: true }` (after 'ai').
- cctv/event-rules.mjs RECORD_TYPE_BITS: 0x0080 -> { type: 'line-crossing', subtype: 'line crossed' }, 0x0400 -> { type: 'line-crossing', subtype: 'tripwire' };
  FROM['line-crossing'] = 'the camera’s own line-crossing detection (NVR alarm status; recordings 0x80/0x400)'.
- cctv/events-db.mjs addEvent: a 'line-crossing' event whose start lies within MERGE_MS = 30_000 of an existing
  'line-crossing' event of the same nvr/ch (any subtype) extends that event (end = max) instead of inserting;
  returns the same shape addEvent returns today ({ isNew, event } — the task must read the real return shape).

## Task 4 — cctv/alarm-watch.mjs
```
export const WATCH_EVERY_MS = 5000
export function parseAlarmStatus(xml) -> [{ kind: 'tripwire'|'pea'|'osc'|..., chlId: string, ch: number (0-based), startMs: number (UTC) }]
   // intelligents items only (motions ignored in this phase); ch from chlId via nvr-xml.mjs chlIdOf inverse (read nvr-xml.mjs)
export function startAlarmWatch({ nvrs: () => Iterable<nvr>, linesOn: () => Set<string>, query: (nvr) => Promise<string xml>,
                                  onCrossing: (e) => void, everyMs = WATCH_EVERY_MS, log = console.log }) -> { stop(), tick() }
   // each tick: for each online nvr with any '<nvr.id>/<ch>' in linesOn(): one query; for each 'tripwire' item whose
   // camera is in linesOn(): onCrossing({ nvr: nvr.id, ch, type: 'line-crossing', subtype: 'tripwire', startMs, source: 'alarm-status' })
   // never overlapping ticks per NVR; a failed query is logged once per NVR per 10 min and skipped.
```
Wiring: where the events intake and alarm notifier are created (cctv/nvrs.mjs ~1043-1080 makeEventIntake/makeAlarmNotifier) —
onCrossing = addEvent then (if new or extended) the same handling the intake does for a new event (notifier.handle) plus Task 5's onLineCrossing.
query(nvr) = transparent(nvr, 'queryAlarmStatus', `${XML_HEADER}</request>` (read the real header helper), 'alarm watch').

## Task 5 — what a crossing does (cctv/line-actions.mjs)
```
export const LINE_RULE_NAME = 'Line crossing'
export function lineRuleCameras() -> string[]                         // cameras in the rule (via events-db listRules/getRule)
export function setLineAlert(cameraKey, on, user) -> rule              // create/update the rule: types ['line-crossing'], notify true,
                                                                      // priority 'high', minGapS 30; cameras = +/- cameraKey; rule disabled when empty
export function ensureNtfyTopic() -> { topic, created: boolean }       // settings.alerts.ntfy.topic; if empty: 'argus-' + 20 random [a-z0-9]
export async function onLineCrossing(event, { bookmark, snapshot }) -> void   // auto-bookmark (30 s before, 60 s after,
   // user 'system', merged: extend the camera's previous automatic bookmark if windows overlap) + schedule snapshot
export function eventLink(eventId) -> string                          // `${publicUrl}/alarms.html#event=${eventId}`
```
- New setting `publicUrl` (default 'https://cctv.jfl.gripe') in cctv/settings.mjs (validated http(s) URL), used by alarmMessage for a link line.
- Task 2's GET view `ntfy.topicSet` reads settings; Task 7's panel calls POST `/api/admin/lines/alert` { nvr, ch, on } -> { rule, ntfy: { topic, created } }
  (route in server.mjs /api/admin block, handled by line-actions.mjs `handleLineAlert(method, readJson, user)`).

## Task 6 — cctv/event-snapshot.mjs
```
export const SNAP_DIR = join(DATA_DIR, 'event-snaps')
export const SNAP_WAIT_MS = 3 * 60_000
export function snapPath(eventId) -> string
export async function takeSnapshot(event, { index, readerFor, ffmpeg = 'ffmpeg', now, wait }) -> path | null
   // waits (poll every 5 s, up to SNAP_WAIT_MS) until the recordings index has a segment of nvr/ch covering startMs + 1000,
   // reads the keyframe at or after it (cctv/rec-reader.mjs SegmentReader / keyAtOrAfter — read the real API),
   // pipes that keyframe access unit to ffmpeg (-f h264|hevc -i pipe:0 -frames:v 1 -vf scale='min(1280,iw)':-2 -q:v 4 -f image2 pipe:1)
   // and writes SNAP_DIR/<eventId>.jpg (tmp + rename). Returns null (logged) if no recording or ffmpeg fails.
export function handleSnapshot(req, res, eventId, who) -> sends image/jpeg or 404; needs the playback right for that camera
export function forgetSnapshots(eventIds) -> void
```
Route GET `/api/events/:id/snapshot` (not admin-only; rights check inside). Removed with events (events-db forgetEventsBefore caller).

## Task 7 — front end
- cctv/public/lines-geom.js (pure, tested): `toUnits(frac) -> int 0..10000`, `toFrac(units)`, `lineLength(a, b)` (units),
  `sideOf(p, a, b) -> 'A'|'B'` (A = left of a->b on screen, Y down), `arrowFor(line) -> { mid, dir: {x,y} }` (unit normal pointing A->B
  for 'rightortop', B->A for 'leftorbotton', both for 'none'), `nextDirection(d)` cycling rightortop -> leftorbotton -> none,
  `hitTest(point, lines, radiusUnits) -> { slot, end: 'start'|'end'|'arrow' } | null`.
- cctv/public/lines-panel.js: `export class LinesPanel { constructor(host, cam, { liveEl }) ; open(); close() }` — overlay canvas,
  4 slots, drag, magnifier optional, settings form, Save through the same confirm/ack dialog pattern as image-panel.js
  (ImagePanel.dialog/post — reuse or mirror), result list, Undo, "Alert my phone for this camera" switch (POST /api/admin/lines/alert),
  ntfy topic shown with subscribe instructions when created.
- cctv/public/viewer.js: a "Lines" button beside "Picture" in the full-size view for admins, shown when GET .../lines says supported;
  pinch-zoom paused while the panel is open (attachZoom busy hook).
- Styles in cctv/public/style.css using existing tokens.

## Task 8 — Alarms page + docs + full test run
- cctv/public/alarms.js/alarms-view.js: line-crossing rows show the snapshot thumbnail (GET /api/events/:id/snapshot, lazy) and
  open at #event=<id> (scroll to and highlight that row).
- Run every cctv/test/*.test.mjs (SDK/ffmpeg ones on the server copy), then deploy + live test steps (Maingate Roadway,
  nvr-2 ch index 2 — chlId {00000003-...}): GET lines, one POST enabling one line (hold 10 s), read-back all 'as asked',
  a test walk, event within seconds, ntfy alert, bookmark, snapshot.
