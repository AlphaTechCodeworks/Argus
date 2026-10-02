// Tests for osd-geom.js: the maths and rules of placing a camera's two burnt-in OSD overlays.
//   node cctv/test/osd-geom.test.mjs
//
// Pure, no DOM, so it runs here exactly as it does in the browser. The point worth testing hard:
// what a Save sends (only the fields that changed, block by block) and that a bad name or an
// off-grid position is caught before it reaches a camera -- the OSD is burnt into every recording
// for ever. changedFields()'s output is the exact POST body osd.mjs takes.
import {
  CORNERS, OSD_MAX, changeCount, changeSummary, changedFields, clamp, draftOf,
  nameError, nearestCorner, overlayHasPosition, overlayMoved, saveLabel, toFrac, toUnits
} from '../public/osd-geom.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

// the shape parseOsd produces (osd-doc.mjs), as the panel receives it
const CAM = {
  chlId: '{x}', grid: { min: 0, max: 10000 },
  name: { show: true, x: 75, y: 100, text: 'Gate' },
  time: { show: true, x: 6600, y: 100, dateFormat: 'day-month-year', timeFormat: '24' },
  types: { dateFormat: ['year-month-day', 'month-day-year', 'day-month-year'], timeFormat: ['12', '24'] }
}

// ---- coordinate mapping ------------------------------------------------------------------------
{
  check('a fraction maps to a whole unit on the 0..10000 grid', toUnits(0.5) === 5000 && toUnits(1) === OSD_MAX && toUnits(0) === 0, String(toUnits(0.5)))
  check('a drag past the edge is held to the grid', toUnits(1.4) === OSD_MAX && toUnits(-0.2) === 0)
  check('a unit maps back to a fraction', toFrac(5000) === 0.5 && toFrac(0) === 0 && toFrac(OSD_MAX) === 1)
  check('an off-grid or junk unit is held to the picture', toFrac(20000) === 1 && toFrac(-5) === 0 && toFrac('x') === 0)
  check('clamp holds a value to its range', clamp(12, 0, 9) === 9 && clamp(-1, 0, 9) === 0 && clamp(5, 0, 9) === 5)
}

// ---- which overlay has a position --------------------------------------------------------------
{
  check('an overlay with X/Y has a position', overlayHasPosition({ x: 100, y: 200 }) === true)
  check('an overlay with no position does not (never treated as 0,0)', overlayHasPosition({ x: null, y: null }) === false && overlayHasPosition({}) === false)
}

// ---- the name rule (mirrors the server) --------------------------------------------------------
{
  check('a sensible name is fine', nameError('Main Gate') === null)
  check('an empty or blank name is refused', /empty/.test(nameError('')) && /empty/.test(nameError('   ')))
  check('a name over 32 characters is refused', /32 characters/.test(nameError('x'.repeat(33))))
  check('markup in a name is refused', /cannot contain/.test(nameError('Gate <b>')) && /cannot contain/.test(nameError('A & B')))
}

// ---- the draft ---------------------------------------------------------------------------------
{
  const d = draftOf(CAM)
  check('a draft copies both overlays', d.name.text === 'Gate' && d.name.x === 75 && d.time.show === true && d.time.timeFormat === '24', JSON.stringify(d))
  const n = draftOf({ name: { text: null, show: null, x: null, y: null }, time: { show: null, x: null, y: null } })
  check('nulls become an empty name, off switches and no position', n.name.text === '' && n.name.show === false && n.name.x === null && n.time.show === false, JSON.stringify(n))
  check('a draft rounds a fractional position', draftOf({ name: { x: 75.6, y: 100.2 } }).name.x === 76)
}

// ---- what a Save sends (only what changed, per block) ------------------------------------------
{
  check('no change sends nothing', JSON.stringify(changedFields(CAM, draftOf(CAM))) === '{}')
  const d1 = draftOf(CAM); d1.name.text = 'North Gate'
  check('only the changed name text is sent, in the name block', JSON.stringify(changedFields(CAM, d1)) === '{"name":{"text":"North Gate"}}')
  const d2 = draftOf(CAM); d2.time.show = false; d2.time.timeFormat = '12'
  check('a clock switch and format go in the time block', JSON.stringify(changedFields(CAM, d2)) === '{"time":{"show":false,"timeFormat":"12"}}')
  const d3 = draftOf(CAM); d3.name.x = 1200.6; d3.time.y = 300
  const ch3 = changedFields(CAM, d3)
  check('each overlay moves independently, rounded and clamped', ch3.name.x === 1201 && ch3.time.y === 300 && !('y' in ch3.name) && !('x' in ch3.time), JSON.stringify(ch3))
  const d4 = draftOf(CAM); d4.name.x = 999999
  check('an off-grid position is clamped into the grid', changedFields(CAM, d4).name.x === OSD_MAX)
  const d5 = draftOf(CAM); d5.name.text = '  '
  check('an invalid name is not sent', !('name' in changedFields(CAM, d5)) || !('text' in (changedFields(CAM, d5).name ?? {})))
  // a position where there was none (e.g. a corner button) counts as a change
  const none = { name: { show: true, x: null, y: null, text: 'G' }, time: { show: true, x: null, y: null } }
  const dn = draftOf(none); dn.time.x = 200; dn.time.y = 200
  check('setting a position where there was none is a change', changedFields(none, dn).time.x === 200)
  const d6 = draftOf(CAM); d6.name.text = 'A'; d6.time.show = false
  check('changeCount counts across both overlays', changeCount(CAM, d6) === 2)
}

// ---- the words for the dialog ------------------------------------------------------------------
{
  const d = draftOf(CAM); d.name.text = 'North Gate'; d.time.show = false
  const lines = changeSummary(CAM, d)
  check('the summary names the name-text change with before and after', lines.some((l) => l.includes('Gate') && l.includes('North Gate')), JSON.stringify(lines))
  check('the summary names the clock going off', lines.some((l) => /Show clock: on → off/.test(l)), JSON.stringify(lines))
  check('nothing changed is an empty summary', changeSummary(CAM, draftOf(CAM)).length === 0)
  const dm = draftOf(CAM); dm.name.x = 1000; dm.name.y = 1000
  check('a moved name position is named', changeSummary(CAM, dm).some((l) => /Name position:/.test(l)), JSON.stringify(changeSummary(CAM, dm)))
  const df = draftOf(CAM); df.time.dateFormat = 'month-day-year'
  check('a format change is named', changeSummary(CAM, df).some((l) => /Date format:/.test(l)))
  check('overlayMoved is true only when an axis differs', overlayMoved(CAM.name, { ...draftOf(CAM).name, x: 76 }) === true && overlayMoved(CAM.name, draftOf(CAM).name) === false)
  check('saveLabel counts', saveLabel(0) === 'Save' && saveLabel(1) === 'Save 1 change' && saveLabel(3) === 'Save 3 changes')
}

// ---- preset corners ----------------------------------------------------------------------------
{
  check('there are four corners inside the grid', CORNERS.length === 4 && CORNERS.every((c) => c.x >= 0 && c.x <= OSD_MAX && c.y >= 0 && c.y <= OSD_MAX))
  check('top is small Y, bottom is large Y (Y down)', CORNERS.find((c) => c.id === 'top-left').y < CORNERS.find((c) => c.id === 'bottom-left').y)
  check('the nearest corner to the top-left area is top-left', nearestCorner(300, 300) === 'top-left')
  check('the nearest corner to the bottom-right area is bottom-right', nearestCorner(9000, 9000) === 'bottom-right')
  check('no position has no nearest corner', nearestCorner(null, null) === null)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
