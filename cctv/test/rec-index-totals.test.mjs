// Tests for the per-location totals the recordings index keeps by trigger (rec-index.mjs loc_totals,
// TOTALS_SCHEMA): locationUse() reads one row instead of SUM(bytes) over a location's rows, and a
// location's space limit is enforced against it every 5 minutes (housekeeping.mjs). The invariant is
// that the totals always equal the truth — SUM(bytes) and COUNT(*) of the rows at that location — no
// matter how a row arrives or leaves.
//
// The case that is easy to get wrong, and was wrong until 2026-09-29: addSegment is INSERT OR REPLACE,
// so re-indexing a file already in the index (a time-lapse rewrite, or any connection re-inserting the
// same path) must count the file ONCE, not add the new row on top of the old. loc_totals_replace takes
// the old row off BEFORE the insert; remove the trigger (as the pre-fix code effectively did) and the
// checks below double-count. The triggers live in the file, so a REPLACE from a second connection (our
// own older code after a roll-back, the sqlite3 tool) must count once too — checked here on a second
// raw connection to the same database.
// Run: node cctv/test/rec-index-totals.test.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openRecIndex } from '../rec-index.mjs'

let failures = 0
const J = (v) => JSON.stringify(v)
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'rec-totals-'))
const file = join(dir, 'rec.db')
const idx = openRecIndex(file)
// a second, raw connection to the same file: both the ground truth and a stand-in for any other
// connection that writes rows (default pragmas, as a tool or rolled-back code would have)
const db2 = new DatabaseSync(file)
const sumRows = db2.prepare("SELECT IFNULL(SUM(bytes), 0) AS bytes, COUNT(*) AS segments FROM segments WHERE IFNULL(loc, '') = ?")
/** The truth for a location, straight from its rows (what loc_totals must always equal). */
const truth = (loc) => {
  const r = sumRows.get(loc)
  return { bytes: Number(r.bytes), segments: Number(r.segments) }
}
const agrees = (loc) => J(idx.locationUse(loc)) === J(truth(loc))
const seg = (path, loc, bytes, { startMs = Date.UTC(2026, 8, 25, 10, 0, 0), endMs = startMs + 60_000 } = {}) => ({
  nvr: 'n1', ch: 3, path, startMs, endMs, bytes, keyframes: 30, loc
})

// ---- a fresh file counts once
{
  idx.addSegment(seg('/r/a.h264', 'L1', 100))
  check('one file: locationUse equals the rows and is right', agrees('L1') && J(idx.locationUse('L1')) === J({ bytes: 100, segments: 1 }), J(idx.locationUse('L1')))
}

// ---- re-indexing the same path (a time-lapse rewrite) counts ONCE, not on top of the old row
{
  idx.addSegment(seg('/r/a.h264', 'L1', 250)) // same path, new size
  check('REPLACE same path: bytes updated, still one segment (not 350 / 2)', J(idx.locationUse('L1')) === J({ bytes: 250, segments: 1 }), J(idx.locationUse('L1')))
  check('REPLACE same path: totals still equal the rows', agrees('L1'))
}

// ---- a REPLACE that moves the file to another location drains the old, fills the new
{
  idx.addSegment(seg('/r/a.h264', 'L2', 250)) // same path, different loc
  check('REPLACE to another loc: old location emptied', J(idx.locationUse('L1')) === J({ bytes: 0, segments: 0 }), J(idx.locationUse('L1')))
  check('REPLACE to another loc: new location holds it once', J(idx.locationUse('L2')) === J({ bytes: 250, segments: 1 }), J(idx.locationUse('L2')))
  check('REPLACE to another loc: both totals equal the rows', agrees('L1') && agrees('L2'))
  idx.addSegment(seg('/r/a.h264', 'L1', 100)) // move it back for the rest of the file
}

// ---- a REPLACE from a SECOND connection (recursive_triggers off by default) must count once too
{
  const add2 = db2.prepare('INSERT OR REPLACE INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc, source, filled_ms, thinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const s = seg('/r/a.h264', 'L1', 400)
  add2.run(s.path, s.nvr, s.ch, s.startMs, s.endMs, s.bytes, s.keyframes, s.loc, null, null, null)
  check('REPLACE from another connection: counted once, not twice', J(idx.locationUse('L1')) === J({ bytes: 400, segments: 1 }), J(idx.locationUse('L1')))
  check('REPLACE from another connection: totals equal the rows', agrees('L1'))
}

// ---- a second, distinct file adds; deleting a file subtracts; a row with no location counts under ''
{
  idx.addSegment(seg('/r/b.h264', 'L1', 50))
  check('a second file on L1: both files counted', J(idx.locationUse('L1')) === J({ bytes: 450, segments: 2 }) && agrees('L1'), J(idx.locationUse('L1')))
  idx.addSegment(seg('/r/c.h264', null, 70)) // no location
  check("a row with no location counts under ''", J(idx.locationUse('')) === J({ bytes: 70, segments: 1 }) && agrees(''), J(idx.locationUse('')))
  idx.remove('/r/a.h264')
  check('removing a file subtracts it once', J(idx.locationUse('L1')) === J({ bytes: 50, segments: 1 }) && agrees('L1'), J(idx.locationUse('L1')))
  idx.removeMany(['/r/b.h264', '/r/c.h264'])
  check('removeMany clears both locations to the rows', J(idx.locationUse('L1')) === J({ bytes: 0, segments: 0 }) && agrees('L1') && agrees(''), `${J(idx.locationUse('L1'))} ${J(idx.locationUse(''))}`)
}

db2.close()
idx.close()
rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
