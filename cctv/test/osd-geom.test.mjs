// Tests for osd-geom.js: the maths and rules of placing a camera's burnt-in OSD.
//   node cctv/test/osd-geom.test.mjs
//
// Pure, no DOM, so it runs here exactly as it does in the browser. The point worth testing hard:
// what a Save sends (only the fields that changed) and that a bad name or an off-grid position is
// caught before it reaches a camera, because the OSD is burnt into every recording for ever.
import {
  CORNERS, OSD_MAX, changeCount, changeSummary, changedFields, clamp, draftOf,
  hasFreePosition, nameError, nearestCorner, positionMoved, saveLabel, toFrac, toUnits
} from '../public/osd-geom.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

// ---- coordinate mapping ------------------------------------------------------------------------
{
  check('a fraction maps to a whole unit on the 0..9999 grid', toUnits(0.5) === 5000 && toUnits(1) === OSD_MAX && toUnits(0) === 0, String(toUnits(0.5)))
  check('a drag past the edge is held to the grid', toUnits(1.4) === OSD_MAX && toUnits(-0.2) === 0)
  check('a unit maps back to a fraction', Math.abs(toFrac(5000) - 0.5000500) < 1e-6 && toFrac(0) === 0 && toFrac(OSD_MAX) === 1)
  check('an off-grid or junk unit is held to the picture', toFrac(20000) === 1 && toFrac(-5) === 0 && toFrac('x') === 0)
  check('clamp holds a value to its range', clamp(12, 0, 9) === 9 && clamp(-1, 0, 9) === 0 && clamp(5, 0, 9) === 5)
}

// ---- free position vs none ---------------------------------------------------------------------
{
  check('a camera with X/Y has a free position', hasFreePosition({ x: 100, y: 200 }) === true)
  check('a camera with no position does not (never treated as 0,0)', hasFreePosition({ x: null, y: null }) === false && hasFreePosition({}) === false)
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
  const d = draftOf({ name: 'Yard', showName: true, showTime: false, x: 500.4, y: 9200.8 })
  check('a draft copies the reading and rounds the position', d.name === 'Yard' && d.showName === true && d.showTime === false && d.x === 500 && d.y === 9201, JSON.stringify(d))
  const n = draftOf({ name: null, showName: null, showTime: null, x: null, y: null })
  check('nulls become an empty name, off switches and no position', n.name === '' && n.showName === false && n.showTime === false && n.x === null && n.y === null, JSON.stringify(n))
}

// ---- what a Save sends (only what changed) -----------------------------------------------------
{
  const osd = { name: 'Gate', showName: true, showTime: true, x: 500, y: 9200 }
  check('no change sends nothing', JSON.stringify(changedFields(osd, draftOf(osd))) === '{}')
  check('only the name that changed is sent', JSON.stringify(changedFields(osd, { ...draftOf(osd), name: 'North Gate' })) === '{"name":"North Gate"}')
  check('a switch flip is sent as a boolean', changedFields(osd, { ...draftOf(osd), showTime: false }).showTime === false)
  const moved = changedFields(osd, { ...draftOf(osd), x: 1200.6, y: 300 })
  check('a moved position is sent rounded and clamped', moved.x === 1201 && moved.y === 300 && !('name' in moved), JSON.stringify(moved))
  check('an off-grid position is clamped into the grid', changedFields(osd, { ...draftOf(osd), x: 999999 }).x === OSD_MAX)
  // A name that would be refused by the server is never sent; the panel disables Save instead.
  check('an invalid name is not sent', !('name' in changedFields(osd, { ...draftOf(osd), name: '  ' })))
  // A position the camera did not have, now set (e.g. from a corner button), counts as a change.
  const none = { name: 'Gate', showName: true, showTime: true, x: null, y: null }
  check('setting a position where there was none is a change', changedFields(none, { ...draftOf(none), x: 200, y: 200 }).x === 200)
  check('changeCount counts the changed fields', changeCount(osd, { ...draftOf(osd), name: 'A', showTime: false }) === 2)
}

// ---- the words for the dialog ------------------------------------------------------------------
{
  const osd = { name: 'Gate', showName: true, showTime: true, x: 500, y: 9200 }
  const lines = changeSummary(osd, { name: 'North Gate', showName: true, showTime: false, x: 500, y: 9200 })
  check('the summary names the name change with before and after', lines.some((l) => l.includes('Gate') && l.includes('North Gate')), JSON.stringify(lines))
  check('the summary names a switch going off', lines.some((l) => /Show time: on → off/.test(l)), JSON.stringify(lines))
  check('nothing changed is an empty summary', changeSummary(osd, draftOf(osd)).length === 0)
  const pos = changeSummary(osd, { ...draftOf(osd), x: 1000, y: 1000 })
  check('a moved position is named', pos.some((l) => /Position:/.test(l)), JSON.stringify(pos))
  const fromNone = changeSummary({ name: 'G', showName: true, showTime: true, x: null, y: null }, { name: 'G', showName: true, showTime: true, x: 200, y: 200 })
  check('a position set from none says "not set"', fromNone.some((l) => /not set → 200,200/.test(l)), JSON.stringify(fromNone))
  check('positionMoved is true only when an axis differs', positionMoved(osd, { ...draftOf(osd), x: 501 }) === true && positionMoved(osd, draftOf(osd)) === false)
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
