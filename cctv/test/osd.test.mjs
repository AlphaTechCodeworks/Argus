// Tests for osd-doc.mjs: reading what a camera burns into its picture, and changing it safely.
//   node cctv/test/osd.test.mjs
//
// Why this is worth testing hard: the OSD is part of the recorded image for ever. It cannot be
// edited out of footage afterwards, and it is the timestamp a person actually reads when they look
// at evidence. A write that wipes a field it did not mean to touch is not recoverable from the
// recordings it has already spoiled.
//
// The REAL_OSD fixture below is the real response read (read-only) from nvr-2 ch0 via the working
// "requireField + condition" query, with the serial and name replaced by placeholders. It pins the
// real two-overlay shape: a <types> list and a <content><chl> holding a <time> overlay and a
// <chlName> overlay, each with its own switch and X/Y on a 0..10000 grid.
import { allApplied, buildEdit, checkWanted, osdRequest, parseOsd, probeShapes } from '../osd-doc.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const refuses = (fn, pattern) => {
  try { fn(); return false } catch (e) { return pattern.test(e.message) }
}

const CHL = '{00000001-0000-0000-0000-000000000000}'
// The real shape (placeholders for the serial and the name; a trailing unknown element and a
// second name line are kept to pin that the builder echoes what it does not touch).
const REAL_OSD = `<?xml version="1.0" encoding="UTF-8"?><response cmdUrl="queryIPChlORChlOSD"><status>success</status><types><dateFormat><enum>year-month-day</enum><enum>month-day-year</enum><enum>day-month-year</enum></dateFormat><timeFormat><enum>12</enum><enum>24</enum></timeFormat></types><content><chl id="${CHL}"><time><switch>true</switch><X min="0" max="10000">6600</X><Y min="0" max="10000">100</Y><dateFormat type="dateFormat">day-month-year</dateFormat><timeFormat type="timeFormat">24</timeFormat></time><chlName><switch>true</switch><X min="0" max="10000">75</X><Y min="0" max="10000">100</Y><name maxLen="63">Example Cam</name><extraLine>keep me</extraLine></chlName></chl></content></response>`

// ---- reading -----------------------------------------------------------------------------------
{
  const r = parseOsd(REAL_OSD)
  check('the response is read as a success', r.ok && r.osd !== null)
  check('the clock overlay is read: switch and position', r.osd.time.show === true && r.osd.time.x === 6600 && r.osd.time.y === 100, JSON.stringify(r.osd.time))
  check('the clock formats are read', r.osd.time.dateFormat === 'day-month-year' && r.osd.time.timeFormat === '24')
  check('the name overlay is read: switch, position and text', r.osd.name.show === true && r.osd.name.x === 75 && r.osd.name.y === 100 && r.osd.name.text === 'Example Cam', JSON.stringify(r.osd.name))
  check('the grid bounds are read from the X/Y min/max', r.osd.grid.min === 0 && r.osd.grid.max === 10000, JSON.stringify(r.osd.grid))
  check('the allowed formats are read from <types>', r.osd.types.dateFormat.includes('day-month-year') && r.osd.types.timeFormat.join() === '12,24', JSON.stringify(r.osd.types))
  check('the channel id is read', r.osd.chlId === CHL, r.osd.chlId)
}
{
  const fail = '<?xml version="1.0"?><response cmdUrl="queryIPChlORChlOSD"><status>fail</status><errorCode>536871059</errorCode></response>'
  const r = parseOsd(fail)
  check('a refusal is reported as one, with its code', r.ok === false && r.errorCode === '536871059' && r.osd === null)
}
{
  // Never invent a reading: a block or position that is not there is null, because 0,0/false would
  // be believed.
  const bare = `<?xml version="1.0"?><response><status>success</status><content><chl id="x"></chl></content></response>`
  const r = parseOsd(bare)
  check('a missing position is null, never 0', r.osd.time.x === null && r.osd.name.y === null)
  check('a missing switch is null, not false', r.osd.time.show === null && r.osd.name.show === null)
  check('a missing name is null, never empty text', r.osd.name.text === null)
}

// ---- what a change may be ----------------------------------------------------------------------
{
  const osd = parseOsd(REAL_OSD).osd
  check('a sensible change to both overlays is accepted',
    JSON.stringify(checkWanted({ name: { text: 'Gate', x: 100 }, time: { show: false } }, osd)) === '{"name":{"text":"Gate","x":100},"time":{"show":false}}')
  check('a position is rounded to a whole unit', checkWanted({ name: { x: 12.6 } }, osd).name.x === 13)
  check('refuses an empty name', refuses(() => checkWanted({ name: { text: '   ' } }, osd), /cannot be empty/))
  check('refuses a name too long to fit', refuses(() => checkWanted({ name: { text: 'x'.repeat(33) } }, osd), /32 characters/))
  check('refuses markup smuggled into a name', refuses(() => checkWanted({ name: { text: 'Gate <b>' } }, osd), /cannot contain/))
  check('refuses a position off the 0..10000 grid', refuses(() => checkWanted({ time: { x: -1 } }, osd), /between 0 and 10000/) && refuses(() => checkWanted({ time: { y: 10001 } }, osd), /between 0 and 10000/))
  check('refuses a position that is not a number', refuses(() => checkWanted({ name: { x: 'left' } }, osd), /between 0 and 10000/))
  check('refuses a date format not in the camera\'s list', refuses(() => checkWanted({ time: { dateFormat: 'martian' } }, osd), /must be one of/))
  check('accepts a date format that is in the list', checkWanted({ time: { dateFormat: 'month-day-year' } }, osd).time.dateFormat === 'month-day-year')
  check('refuses a change that changes nothing', refuses(() => checkWanted({}, osd), /nothing to change/))
  check('an empty block is nothing to change', refuses(() => checkWanted({ name: {}, time: {} }, osd), /nothing to change/))
}

// ---- building the write ------------------------------------------------------------------------
{
  const doc = buildEdit(REAL_OSD, checkWanted({ name: { text: 'North Gate', x: 200 } }, parseOsd(REAL_OSD).osd))
  check('the new name is in the name block', doc.includes('>North Gate</name>'), doc.slice(0, 400))
  check('the name X is changed, keeping its min/max attributes', /<X min="0" max="10000">200<\/X>/.test(doc), doc)
  // The whole point: these NVRs replace the block, so anything left out is wiped.
  check('the clock block is carried through untouched', doc.includes('<X min="0" max="10000">6600</X>') && doc.includes('<dateFormat type="dateFormat">day-month-year</dateFormat>'), doc)
  check('a second name line and unknown elements survive', doc.includes('<extraLine>keep me</extraLine>'), doc)
  check('the document opens <request> exactly once', (doc.match(/<request\b/g) ?? []).length === 1 && (doc.match(/<\/request>/g) ?? []).length === 1)
}
{
  // A name is text, whatever is in it. "$1", "$$" and "$'" mean something to String.replace when
  // the new text is given as a replacement string, and came out as pieces of the document.
  for (const text of ['Lot $1', 'Bay $2', 'Cost $$5', "Till $' $`"]) {
    const doc = buildEdit(REAL_OSD, checkWanted({ name: { text } }, parseOsd(REAL_OSD).osd))
    check(`a name with dollar signs goes out as written: ${text}`, doc.includes(`<name maxLen="63">${text}</name><extraLine>keep me</extraLine>`), doc.slice(doc.indexOf('<chlName>')))
  }
}
{
  // A change to the clock must not touch the name block, and vice versa.
  const doc = buildEdit(REAL_OSD, checkWanted({ time: { show: false, timeFormat: '12' } }, parseOsd(REAL_OSD).osd))
  check('only the clock switch and format change', doc.includes('<switch>false</switch>') && doc.includes('<timeFormat type="timeFormat">12</timeFormat>'), doc)
  check('the name block keeps its switch on and its text', /<chlName>[\s\S]*<switch>true<\/switch>[\s\S]*Example Cam/.test(doc), doc)
  check('an answer with no content refuses rather than inventing one',
    refuses(() => buildEdit('<?xml version="1.0"?><response><status>fail</status></response>', { name: { text: 'x' } }), /no content to build on/))
}

// ---- the read-back check -----------------------------------------------------------------------
{
  const after = parseOsd(REAL_OSD).osd
  check('allApplied is true when the camera reports every asked field', allApplied({ name: { text: 'Example Cam' }, time: { show: true } }, after))
  check('allApplied is false when a field was kept', allApplied({ name: { text: 'Different' } }, after) === false)
  check('allApplied is false with no after at all', allApplied({ time: { show: true } }, null) === false)
}

// ---- the probe ---------------------------------------------------------------------------------
{
  const shapes = probeShapes(CHL)
  check('the confirmed working shape is tried first', shapes[0][1] === osdRequest(CHL) && shapes[0][1].includes('<requireField>') && shapes[0][1].includes('<condition>'), shapes[0][1])
  check('every shape names the channel or is deliberately bodyless', shapes.every(([, d]) => d.includes(CHL) || d.endsWith('</request>')))
  check('nothing in the probe is a write', shapes.every(([, d]) => !/edit|set|add|del/i.test(d)))
  check('each shape is a whole, single request', shapes.every(([, d]) => (d.match(/<request\b/g) ?? []).length === 1 && d.startsWith('<?xml')))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
