// Tests for osd.mjs: reading what a camera burns into its picture, and changing it safely.
//   node cctv/test/osd.test.mjs
//
// Why this is worth testing hard: the OSD is part of the recorded image for ever. It cannot be
// edited out of footage afterwards, and it is the timestamp a person actually reads when they look
// at evidence. A write that wipes a field it did not mean to touch is not recoverable from the
// recordings it has already spoiled.
//
// The shape below is not confirmed against a real NVR yet -- queryIPChlORChlOSD answers with a
// proper <response> so the firmware knows the command, but refuses a bodyless read with errorCode
// 536871059. These fixtures are written in the shape the rest of this dialect uses; the parser is
// deliberately forgiving and reports null rather than guessing, which is what makes that safe.
import { buildEdit, checkWanted, osdRequest, parseOsd, probeShapes } from '../osd-doc.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const refuses = (fn, pattern) => {
  try { fn(); return false } catch (e) { return pattern.test(e.message) }
}

const CHL = '{00000001-0000-0000-0000-000000000000}'
const OK = `<?xml version="1.0" encoding="UTF-8"?><response cmdUrl="queryIPChlORChlOSD"><status>success</status><content><chlId>${CHL}</chlId><name><![CDATA[Main Gate]]></name><nameSwitch>true</nameSwitch><timeSwitch>true</timeSwitch><position><X>500</X><Y>9200</Y></position><dateFormat>day-month-year</dateFormat><timeFormat>24</timeFormat><somethingWeDoNotKnow>keep me</somethingWeDoNotKnow></content></response>`

// ---- reading -----------------------------------------------------------------------------------
{
  const r = parseOsd(OK)
  check('the camera name is read', r.ok && r.osd.name === 'Main Gate', JSON.stringify(r.osd?.name))
  check('the switches are read as booleans, not strings', r.osd.showName === true && r.osd.showTime === true)
  check('the position is read', r.osd.x === 500 && r.osd.y === 9200, `${r.osd.x},${r.osd.y}`)
  check('the formats are read', r.osd.dateFormat === 'day-month-year' && r.osd.timeFormat === '24')
}
{
  // A refusal is a refusal. The important part is that it is not mistaken for "this camera shows
  // nothing", which would invite a write built on an empty picture of the camera.
  const fail = '<?xml version="1.0"?><response cmdUrl="queryIPChlORChlOSD"><status>fail</status><errorCode>536871059</errorCode></response>'
  const r = parseOsd(fail)
  check('a refusal is reported as one, with its code', r.ok === false && r.errorCode === '536871059' && r.osd === null)
}
{
  // Firmware that names things differently, and a position given as flat fields.
  const other = `<?xml version="1.0"?><response><status>success</status><content><osdName>Yard</osdName><showName>1</showName><showTime>off</showTime><posX>10</posX><posY>20</posY></content></response>`
  const r = parseOsd(other)
  check('other field names are still read', r.osd.name === 'Yard' && r.osd.x === 10 && r.osd.y === 20, JSON.stringify(r.osd))
  check('"1" is on and "off" is off', r.osd.showName === true && r.osd.showTime === false)
}
{
  // The rule this whole file exists for: never invent a reading. A position we could not find is
  // null, because 0,0 is a real corner of the picture and would be believed.
  const bare = '<?xml version="1.0"?><response><status>success</status><content><chlId>x</chlId></content></response>'
  const r = parseOsd(bare)
  check('a position that is not there is null, never 0', r.osd.x === null && r.osd.y === null)
  check('a name that is not there is null, never empty text', r.osd.name === null)
  check('a switch that is not there is null, not false', r.osd.showName === null && r.osd.showTime === null)
}

// ---- what a change may be ----------------------------------------------------------------------
{
  check('a sensible change is accepted', JSON.stringify(checkWanted({ name: 'Gate', x: 100, y: 9000 })) === '{"name":"Gate","x":100,"y":9000}')
  check('booleans come through as booleans', checkWanted({ showTime: false }).showTime === false)
  check('a position is rounded to whole units', checkWanted({ x: 12.6 }).x === 13)
  check('refuses an empty name', refuses(() => checkWanted({ name: '   ' }), /cannot be empty/))
  check('refuses a name too long to fit the picture', refuses(() => checkWanted({ name: 'x'.repeat(33) }), /32 characters/))
  // The name is written into XML and then burnt into the picture; neither is a place for markup.
  check('refuses markup smuggled into a name', refuses(() => checkWanted({ name: 'Gate <b>' }), /cannot contain/))
  check('refuses a position off the picture', refuses(() => checkWanted({ x: -1 }), /between 0 and 9999/) && refuses(() => checkWanted({ y: 10000 }), /between 0 and 9999/))
  check('refuses a position that is not a number', refuses(() => checkWanted({ x: 'left' }), /between 0 and 9999/))
  check('refuses a change that changes nothing', refuses(() => checkWanted({}), /nothing to change/))
}

// ---- building the write ------------------------------------------------------------------------
{
  const doc = buildEdit(OK, CHL, { name: 'North Gate', x: 200 })
  check('the new name is in the document', doc.includes('<name><![CDATA[North Gate]]></name>'), doc.slice(0, 200))
  check('the new position is in the document', doc.includes('<X>200</X>'), doc)
  // The whole point: these NVRs replace the block rather than merging into it, so anything left
  // out is wiped. Including the things this module never understood.
  check('what was not asked for is carried through untouched', doc.includes('<Y>9200</Y>') && doc.includes('<timeSwitch>true</timeSwitch>'), doc)
  check('a field this module does not understand survives', doc.includes('<somethingWeDoNotKnow>keep me</somethingWeDoNotKnow>'), doc)
  check('the document opens <request> exactly once', (doc.match(/<request\b/g) ?? []).length === 1 && (doc.match(/<\/request>/g) ?? []).length === 1, doc.slice(0, 120))
  const tags = doc.match(/<\/?[A-Za-z][A-Za-z0-9]*/g) ?? []
  check('and is balanced', tags.reduce((d, t) => d + (t.startsWith('</') ? -1 : 1), 0) === 0)
}
{
  const off = buildEdit(OK, CHL, { showTime: false })
  check('a switch turned off says false, and the name is left alone', off.includes('<timeSwitch>false</timeSwitch>') && off.includes('Main Gate'), off)
  // An answer we cannot build on must stop the write rather than send a document made up from
  // nothing, which is how a camera's settings get wiped.
  check('an answer with no content refuses rather than inventing one',
    refuses(() => buildEdit('<?xml version="1.0"?><response><status>fail</status></response>', CHL, { name: 'x' }), /no content to build on/))
}

// ---- the probe ---------------------------------------------------------------------------------
{
  const shapes = probeShapes(CHL)
  // Round one named the channel six ways and changed nothing, so round two tries naming the
  // fields instead -- copying queryNodeEncodeInfo, which works on these NVRs every day.
  check('the field-naming shape is tried first now', shapes[0][1].includes('<requireField>') && !shapes[0][1].includes('<condition>'), shapes[0][1])
  check('the shape from round one is kept, so the two runs can be compared', shapes.some(([, d]) => d === osdRequest(CHL)))
  check('every shape names the channel or is deliberately bodyless', shapes.every(([, d]) => d.includes(CHL) || d.includes('</request>')))
  // A probe that could write would be a probe nobody should run.
  check('nothing in the probe is a write', shapes.every(([, d]) => !/edit|set|add|del/i.test(d)))
  check('each shape is a whole, single request', shapes.every(([, d]) => (d.match(/<request\b/g) ?? []).length === 1 && d.startsWith('<?xml')))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
