// Tests for the recordings-index lookups that run for every camera on a timer (rec-index.mjs):
// lastSegmentEnd()/lastEnds() (the Health snapshot, every 30 s and on every /api/health), olderThan()
// (housekeeping and thinning, every 5 min) and cameras() (both). Each used to read every row of a
// camera, or of the whole index, on the thread that paces playback: on the site's 3-day index that
// was 640 ms per snapshot for lastEnds alone, and every playback stalled for it.
//
// The rewrites must give exactly the answers the old queries gave, so each is compared here with
// the old SQL, run on a second connection to the same file, over rows made to break them:
// overlapping files, files longer than MAX_SEGMENT_MS, files that end before they start, empty
// cameras. And each rewritten statement must be an index search, never a scan of every row.
// Run: node cctv/test/rec-index-scans.test.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as recIndex from '../rec-index.mjs'

const { CAMERA_SQL, LOCATION_SQL, MAX_SEGMENT_MS, openRecIndex } = recIndex
// (the gap and scan statements of 2026-09-30: empty here before they exist, so the checks fail rather than the load)
const { GAP_SQL = {}, SCAN_SQL = {}, LONG_GAP_MS = 3_600_000 } = recIndex

let failures = 0
const J = (v) => JSON.stringify(v)
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const M = MAX_SEGMENT_MS
const MIN = 60_000
const T0 = Date.UTC(2026, 8, 25, 0, 0, 0)

// a small seeded generator, so a failure can be run again
let seed = 20260928
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (a, b) => a + Math.floor(rand() * (b - a + 1))

// every database lives in one folder, removed on the way out: the big one is about 24 MB
const ROOT = mkdtempSync(join(tmpdir(), 'cctv-rix-'))
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }) } catch {} })
const file = join(ROOT, 'recordings.db')
const index = openRecIndex(file)
let n = 0
const seg = (nvr, ch, startMs, endMs) => index.addSegment({ nvr, ch, path: `/rec/${nvr}/${ch}/${++n}.h264`, startMs, endMs, bytes: 1000, keyframes: 1, loc: 'L1' })
/** One camera's minute files from startMs, `count` of them, each ending where the next starts. */
const minutes = (nvr, ch, startMs, count) => {
  for (let i = 0; i < count; i++) seg(nvr, ch, startMs + i * MIN, startMs + (i + 1) * MIN)
}

// ---- the cameras ---------------------------------------------------------------------------------
const cams = []
// plain minute files, some twice (a location switch leaves two files for one minute), some sharing a start
cams.push(['n1', 0])
minutes('n1', 0, T0, 300)
for (let i = 0; i < 300; i += 10) seg('n1', 0, T0 + i * MIN + 5000, T0 + i * MIN + 90_000)
seg('n1', 0, T0 + 299 * MIN, T0 + 299 * MIN + 30_000) // same start as the newest file, ends sooner

// a file three and a half hours long (no keyframe for that long), started well before the newest
// file and ending after it: only the long file knows the camera's real end
cams.push(['n1', 1])
minutes('n1', 1, T0, 600)
seg('n1', 1, T0 + 400 * MIN, T0 + 610 * MIN)

// the newest file ends before it starts (a clock stepped back), and the file that really ends last
// started over an hour before it: the one case the window and the long files together cannot answer
cams.push(['n1', 2])
seg('n1', 2, T0, T0 + 59 * MIN)
seg('n1', 2, T0 + 2 * 60 * MIN, T0 + 2 * 60 * MIN - 3 * 60 * MIN)

// on the edges of MAX_SEGMENT_MS: a file exactly that long (not a long file) starting on the edge of
// the newest file's window, one a millisecond longer (a long file), and a long one that ends last
cams.push(['n2', 0])
minutes('n2', 0, T0, 200)
seg('n2', 0, T0 + 199 * MIN - M, T0 + 199 * MIN)
seg('n2', 0, T0 + 20 * MIN, T0 + 20 * MIN + M + 1)
seg('n2', 0, T0 + 90 * MIN - 1, T0 + 270 * MIN)

// no footage at all, only a gap row
cams.push(['n2', 1])
index.addGap({ nvr: 'n2', ch: 1, fromMs: T0, toMs: T0 + MIN, reason: 'test' })

// one file
cams.push(['n2', 2])
seg('n2', 2, T0 + 5 * MIN, T0 + 6 * MIN)

// random cameras: mostly minute files, some empty, some long, some that end before they start,
// in no particular order of insertion
for (let c = 0; c < 6; c++) {
  const nvr = c % 2 ? 'r-b' : 'r-a'
  const ch = 10 + c
  cams.push([nvr, ch])
  for (let i = 0; i < 400; i++) {
    const s = T0 + between(0, 3 * 24 * 60) * MIN + between(0, 59_999)
    const r = rand()
    const len = r < 0.9 ? between(30_000, 90_000) : r < 0.95 ? 0 : r < 0.98 ? between(M - 1000, 5 * M) : -between(1, 120) * MIN
    seg(nvr, ch, s, s + len)
  }
}
// camera names and numbers that sort in awkward ways, for cameras()
for (const [nvr, ch] of [['n10', 3], ['a b', 0], ['', 7], ['n1', 32], ['n1', 31]]) {
  cams.push([nvr, ch])
  seg(nvr, ch, T0, T0 + MIN)
}

// ---- the old queries, on their own connection ---------------------------------------------------
const old = new DatabaseSync(file)
const oldLastEnd = old.prepare('SELECT MAX(end_ms) AS e FROM segments WHERE nvr = ? AND ch = ?')
const oldLastEndBefore = old.prepare('SELECT MAX(end_ms) AS e FROM segments WHERE nvr = ? AND ch = ? AND start_ms < ?')
const oldOlderThan = old.prepare('SELECT path FROM segments WHERE nvr = ? AND ch = ? AND end_ms < ? ORDER BY start_ms LIMIT ?')
const oldCameras = old.prepare('SELECT DISTINCT nvr, ch FROM segments ORDER BY nvr, ch')
const startsOf = old.prepare('SELECT start_ms AS s, end_ms AS e FROM segments WHERE nvr = ? AND ch = ? ORDER BY start_ms')

// ---- lastSegmentEnd / lastEnds -------------------------------------------------------------------
{
  const bad = []
  let asked = 0
  for (const [nvr, ch] of cams) {
    const want = oldLastEnd.get(nvr, ch).e ?? null
    const got = index.lastSegmentEnd(nvr, ch)
    asked++
    if (got !== want) bad.push(`${nvr}/${ch}: ${got} vs ${want}`)
    if (index.lastEnds(nvr, ch).segEnd !== want) bad.push(`${nvr}/${ch} lastEnds: ${index.lastEnds(nvr, ch).segEnd} vs ${want}`)
    // bounded: every start (the bound is strict), either side of it, and random times
    const rows = startsOf.all(nvr, ch)
    const bounds = [T0 - 1, T0 + 10 * 24 * 60 * MIN]
    for (const r of rows) bounds.push(r.s, r.s + 1, r.s - 1, r.e)
    for (let i = 0; i < 40; i++) bounds.push(T0 + between(-60, 4 * 24 * 60) * MIN + between(0, 59_999))
    for (const b of bounds) {
      const w = oldLastEndBefore.get(nvr, ch, b).e ?? null
      asked++
      const g1 = index.lastSegmentEnd(nvr, ch, b)
      const g2 = index.lastEnds(nvr, ch, b).segEnd
      if (g1 !== w || g2 !== w) bad.push(`${nvr}/${ch} before ${b}: ${g1}/${g2} vs ${w}`)
    }
  }
  check('lastSegmentEnd and lastEnds give what MAX(end_ms) over every row gave', bad.length === 0, bad.length ? `${bad.length} of ${asked} differ: ${bad.slice(0, 4).join('; ')}` : `${asked} lookups on ${cams.length} cameras`)
  check('the long file is the answer where it ends last', index.lastSegmentEnd('n1', 1) === oldLastEnd.get('n1', 1).e && index.lastSegmentEnd('n1', 1) > T0 + 600 * MIN)
  check('a newest file that ends before it starts still gives the real end', index.lastSegmentEnd('n1', 2) === T0 + 59 * MIN, String(index.lastSegmentEnd('n1', 2)))
  check('a camera without footage has no end', index.lastSegmentEnd('n2', 1) === null && index.lastEnds('n2', 1).segEnd === null && index.lastEnds('n2', 1).gapEnd === T0 + MIN)
  check('before its first file, a camera has no end', index.lastSegmentEnd('n1', 0, T0) === null)
}

// ---- olderThan ----------------------------------------------------------------------------------
{
  const bad = []
  let asked = 0
  for (const [nvr, ch] of cams) {
    const rows = startsOf.all(nvr, ch)
    const backwards = rows.some((r) => r.e < r.s)
    const rowOf = new Map(old.prepare('SELECT path, start_ms AS s, end_ms AS e FROM segments WHERE nvr = ? AND ch = ?').all(nvr, ch).map((r) => [r.path, r]))
    const cutoffs = [T0 - 1, T0 + 10 * 24 * 60 * MIN]
    for (let i = 0; i < 30; i++) cutoffs.push(T0 + between(0, 4 * 24 * 60) * MIN + between(0, 59_999))
    for (const r of rows.slice(0, 20)) cutoffs.push(r.e, r.e + 1)
    for (const cut of cutoffs) {
      for (const limit of [1, 7, 100_000]) {
        asked++
        const want = oldOlderThan.all(nvr, ch, cut, limit).map((r) => r.path)
        const got = index.olderThan(nvr, ch, cut, limit).map((r) => r.path)
        if (!backwards) {
          if (got.join() !== want.join()) bad.push(`${nvr}/${ch} cut ${cut} limit ${limit}: ${got.length} vs ${want.length}`)
          continue
        }
        // A file that ends before it starts is left until its start is past the cutoff too: the new
        // query only ever returns less (keeps footage longer), never more, and nothing else differs.
        const extra = got.filter((p) => !want.includes(p))
        const missing = want.filter((p) => !got.includes(p)).map((p) => rowOf.get(p))
        if (extra.length || missing.some((r) => !(r.e < r.s && r.s >= cut))) bad.push(`${nvr}/${ch} cut ${cut} limit ${limit}: extra ${extra.length}, missing ${missing.length}`)
      }
    }
  }
  check('olderThan gives what it gave before (files that end before they start: never more)', bad.length === 0, bad.length ? `${bad.length} of ${asked} differ: ${bad.slice(0, 4).join('; ')}` : `${asked} lookups`)
  // from a start time on (runRetention's walk after a bookmarked stretch, 2026-09-29): exactly the rows
  // of the whole answer that start at or after it
  const bad2 = []
  for (const [nvr, ch] of cams) {
    const cut = T0 + 3 * 24 * 60 * MIN
    const all = index.olderThan(nvr, ch, cut, 100_000)
    for (const from of [T0 - 1, T0 + 100 * MIN, T0 + 100 * MIN + 1, T0 + 2 * 24 * 60 * MIN, cut + 1]) {
      const want = all.filter((r) => r.startMs >= from).slice(0, 9).map((r) => r.path).join()
      const got = index.olderThan(nvr, ch, cut, 9, from).map((r) => r.path).join()
      if (got !== want) bad2.push(`${nvr}/${ch} from ${from}`)
    }
  }
  check('olderThan from a start time on: the same rows, those starting at or after it', bad2.length === 0, bad2.slice(0, 4).join('; '))
}

// ---- cameras --------------------------------------------------------------------------------------
{
  const want = oldCameras.all().map((r) => `${r.nvr}/${r.ch}`)
  const got = index.cameras().map((r) => `${r.nvr}/${r.ch}`)
  check('cameras() lists the same cameras in the same order as SELECT DISTINCT', got.join('|') === want.join('|'), `${got.length} vs ${want.length}: ${got.slice(0, 6).join('|')}`)
  check('cameras() rows are plain { nvr, ch }', index.cameras().every((r) => Object.keys(r).join() === 'nvr,ch' && typeof r.ch === 'number'))
  const empty = openRecIndex(join(ROOT, 'empty.db'))
  check('cameras() of an empty index is empty', empty.cameras().length === 0)
  check('lastSegmentEnd of an empty index is null', empty.lastSegmentEnd('x', 0) === null && empty.lastSegmentEnd('x', 0, T0) === null)
  empty.close()
}

// ---- one storage location: locationUse() and oldest(n, { loc }) --------------------------------------
// locationUse('ram-spool') runs every 30 s on the main thread (nvrs.mjs watchSpool, ram-spool.mjs), and
// read every row of the index to find the spool's few (or none): 40 ms on production's 377,000 rows.
// The old answers come from the same SQL with the new index kept out of it (NOT INDEXED: the full scan
// it was). Everything above is on L1; here an overflow drive, the RAM spool and rows with no location.
{
  const add = (loc, i, bytes) => index.addSegment({ nvr: 'n9', ch: i % 3, path: `/rec/${loc}/${i}.h264`, startMs: T0 + between(0, 3 * 24 * 60) * MIN, endMs: T0 + 4 * 24 * 60 * MIN, bytes, keyframes: 1, loc })
  for (let i = 0; i < 300; i++) add('L2', i, between(1, 5_000_000))
  for (let i = 0; i < 40; i++) add('ram-spool', i, between(100_000, 900_000))
  for (let i = 0; i < 3; i++) add(null, i, 7)
  const oldUse = old.prepare('SELECT COALESCE(SUM(bytes), 0) AS b, COUNT(*) AS n FROM segments NOT INDEXED WHERE loc = ?')
  const oldOldest = old.prepare('SELECT path FROM segments NOT INDEXED WHERE loc = ? ORDER BY start_ms, rowid LIMIT ?')
  const bad = []
  for (const loc of ['L1', 'L2', 'ram-spool', 'nowhere', 'null']) {
    const want = oldUse.get(loc)
    const got = index.locationUse(loc)
    if (got.bytes !== Number(want.b) || got.segments !== Number(want.n)) bad.push(`${loc}: ${J(got)} vs ${want.b}/${want.n}`)
    for (const limit of [1, 50, 100_000]) {
      const w = oldOldest.all(loc, limit).map((r) => r.path)
      const g = index.oldest(limit, { loc }).map((r) => r.path)
      if (g.join() !== w.join()) bad.push(`${loc} oldest ${limit}: ${g.length} vs ${w.length}`)
    }
  }
  check('locationUse and oldest on one location give what reading every row gave', bad.length === 0, bad.join('; ') || `L1 ${index.locationUse('L1').segments}, L2 ${index.locationUse('L2').segments}, spool ${index.locationUse('ram-spool').segments} rows`)
  check('... the spool\'s bytes, and none for a location without rows', index.locationUse('ram-spool').segments === 40 && index.locationUse('nowhere').bytes === 0 && index.locationUse('nowhere').segments === 0)

  // plans: both a search of segments_loc, oldest on one location in start_ms order (an index on loc
  // alone, or on (loc, bytes), made the main drive's oldest(50) sort its 377,000 rows: 0.3-1.3 s here)
  const planOf = (sql, ...p) => old.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p).map((r) => r.detail).join(' | ')
  const oldest = planOf(LOCATION_SQL.oldestAt, 'L1', -1e15, 50)
  check('oldest on one location is a search of segments_loc in start_ms order (no sort)', /^SEARCH segments USING INDEX segments_loc \(loc=\? AND start_ms>\?\)$/.test(oldest), oldest)
  const ofCam = planOf(LOCATION_SQL.oldestOf, 'n1', 0, 'L1', -1e15, 50)
  check('one camera\'s oldest on one location still searches segments_cam, with no sort', /^SEARCH segments USING INDEX segments_cam \(nvr=\? AND ch=\? AND start_ms>\?\)$/.test(ofCam), ofCam)
}

// ---- what the deletion jobs walk (housekeeping.mjs, thinning.mjs runRetention; perf report Task 3) --------
// A location's bytes are what its space limit is enforced against, every 5 minutes, and what the Storage
// page shows. SUM(bytes) over the main drive's rows reads every one of them however it is indexed: 102 ms
// for 440,000 synthetic rows on the development PC, and the index grows to about 3.7 million rows at 30
// days (perf report 1). So a table of totals per location is kept by triggers, and locationUse() reads
// one row of it. Here it must always say what reading every row says, whatever changes the rows.
{
  const oldUse = old.prepare('SELECT COALESCE(SUM(bytes), 0) AS b, COUNT(*) AS n FROM segments NOT INDEXED WHERE loc = ?')
  const same = () => {
    const bad = []
    for (const loc of ['L1', 'L2', 'L3', 'ram-spool', 'nowhere']) {
      const w = oldUse.get(loc)
      const g = index.locationUse(loc)
      if (g.bytes !== Number(w.b) || g.segments !== Number(w.n)) bad.push(`${loc}: ${J(g)} vs ${w.b}/${w.n}`)
    }
    return bad
  }
  const p = (i) => `/rec/L2/${i}.h264`
  index.addSegment({ nvr: 'n9', ch: 0, path: p(5), startMs: T0, endMs: T0 + MIN, bytes: 123, keyframes: 1, loc: 'L2' }) // the same file again, now thinner (a time-lapse rewrite)
  const again = same()
  index.moveSegment(p(6), '/rec/L3/6.h264', 'L3') // ram-spool.mjs moving a file to a drive
  index.remove(p(7))
  index.removeMany([p(8), p(9), p(10), '/rec/not-a-row.h264'])
  const later = same()
  const raw = new DatabaseSync(file) // a row written by another connection counts as well (the triggers are in the file)
  raw.prepare("INSERT INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc) VALUES ('/rec/L3/x.h264', 'n9', 1, 1, 2, 77, 1, 'L3')").run()
  const other = same()
  // ... and a file written again by another connection with SQLite's defaults (older code of ours, the
  // sqlite3 tool): its REPLACE took the old row off without telling the triggers, which counted the file
  // twice, and the space limit would have deleted for it (review of p2-delete, 2026-09-29)
  raw.prepare("INSERT OR REPLACE INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc) VALUES ('/rec/L3/x.h264', 'n9', 1, 1, 2, 10, 1, 'L3')").run()
  raw.prepare("INSERT OR REPLACE INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc) VALUES ('/rec/L3/x.h264', 'n9', 1, 1, 2, 10, 1, 'L2')").run()
  const replaced = same()
  raw.prepare("INSERT OR REPLACE INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc) VALUES ('/rec/L3/x.h264', 'n9', 1, 1, 2, 10, 1, 'L3')").run()
  raw.close()
  check('locationUse is always what reading every row says: after a file written again, moved, removed, removed in a batch, and a row from another connection', again.length === 0 && later.length === 0 && other.length === 0 && same().length === 0, [...again, ...later, ...other, ...same()].join('; ') || J(index.locationUse('L3')))
  check('... and a file written again (REPLACE) by a connection with SQLite\'s defaults, its size or its location changed: counted once', replaced.length === 0 && same().length === 0, [...replaced, ...same()].join('; '))
  // ... and so does this code's own REPLACE, the triggers having been made for either setting
  index.addSegment({ nvr: 'n9', ch: 1, path: '/rec/L3/x.h264', startMs: 1, endMs: 2, bytes: 11, keyframes: 1, loc: 'L3' })
  check('... and again through the index', same().length === 0 && index.byPath('/rec/L3/x.h264').bytes === 11, same().join('; '))
  check('... a file written again counts once, with its new size', index.locationUse('L2').segments === 300 - 5 && index.byPath(p(5)).bytes === 123, J(index.locationUse('L2')))
  const planOf = (sql, ...params) => old.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(' | ')
  const use = planOf(LOCATION_SQL.locBytes, 'L1')
  check('locationUse reads one row of the totals, never the segments', /^SEARCH loc_totals USING INDEX sqlite_autoindex_loc_totals_1 \(loc=\?\)$/.test(use), use)

  // removeMany: one transaction for a batch the share helper confirmed
  const before = index.locationUse('L1').segments
  const gone = index.oldest(4, { loc: 'L1' }).map((r) => r.path)
  index.removeMany(gone)
  check('removeMany removes exactly those rows', index.locationUse('L1').segments === before - 4 && gone.every((x) => index.byPath(x) === null), J(index.locationUse('L1')))
  index.removeMany([])

  // each camera's oldest rows on one location in one statement (the deletion jobs' first look), the same
  // rows as asking each camera in turn (oldestOf); and oldestOf / oldest from a start time on (their next look)
  const every = [...cams, ['n9', 0], ['n9', 1], ['n9', 2], ['nobody', 4]]
  const wantOf = (loc, limit, fromMs = -1e15) => every.map(([nvr, ch]) => index.oldestOf(nvr, ch, loc, limit, fromMs).map((r) => r.path).join(','))
  const bad = []
  for (const loc of ['L1', 'L2', 'nowhere']) {
    for (const limit of [1, 3, 50]) {
      const rows = index.oldestPerCamera(loc, every.map(([nvr, ch]) => ({ nvr, ch })), limit)
      const got = every.map(([nvr, ch]) => rows.filter((r) => r.nvr === nvr && r.ch === ch).map((r) => r.path).join(','))
      const want = wantOf(loc, limit)
      for (let i = 0; i < every.length; i++) if (got[i] !== want[i]) bad.push(`${loc} ${every[i].join('/')} limit ${limit}: ${got[i].split(',').length} vs ${want[i].split(',').length}`)
    }
  }
  check('oldestPerCamera gives each camera\'s oldest rows on a location, as oldestOf does camera by camera', bad.length === 0, bad.slice(0, 4).join('; ') || `${every.length} cameras`)
  const oldOf = old.prepare('SELECT path FROM segments NOT INDEXED WHERE nvr = ? AND ch = ? AND loc = ? AND start_ms >= ? ORDER BY start_ms, rowid LIMIT ?')
  const oldAt = old.prepare('SELECT path FROM segments NOT INDEXED WHERE loc = ? AND start_ms >= ? ORDER BY start_ms, rowid LIMIT ?')
  const bad2 = []
  for (const [nvr, ch] of every) {
    for (const from of [T0 - 1, T0 + 100 * MIN, T0 + 100 * MIN + 1, T0 + 2 * 24 * 60 * MIN]) {
      if (index.oldestOf(nvr, ch, 'L1', 7, from).map((r) => r.path).join() !== oldOf.all(nvr, ch, 'L1', from, 7).map((r) => r.path).join()) bad2.push(`${nvr}/${ch} from ${from}`)
    }
  }
  for (const from of [T0 - 1, T0 + 100 * MIN, T0 + 3 * 24 * 60 * MIN]) {
    if (index.oldest(20, { loc: 'L1', fromMs: from }).map((r) => r.path).join() !== oldAt.all('L1', from, 20).map((r) => r.path).join()) bad2.push(`oldest from ${from}`)
  }
  check('oldestOf and oldest from a start time on: the rows starting at or after it, oldest first', bad2.length === 0, bad2.slice(0, 4).join('; '))
  // ... and from a start time on (the deletion jobs' first look past the bookmarked stretches at the oldest end)
  const badFrom = []
  for (const from of [T0 - 1, T0 + 100 * MIN, T0 + 100 * MIN + 1, T0 + 2 * 24 * 60 * MIN]) {
    const rows = index.oldestPerCamera('L1', every.map(([nvr, ch]) => ({ nvr, ch })), 5, from)
    const got = every.map(([nvr, ch]) => rows.filter((r) => r.nvr === nvr && r.ch === ch).map((r) => r.path).join(','))
    const want = wantOf('L1', 5, from)
    for (let i = 0; i < every.length; i++) if (got[i] !== want[i]) badFrom.push(`${every[i].join('/')} from ${from}`)
  }
  check('oldestPerCamera from a start time on: as oldestOf from it, camera by camera', badFrom.length === 0, badFrom.slice(0, 4).join('; '))
  const perCam = planOf(LOCATION_SQL.oldestPerCamera, '[["n1",0]]', 'L1', -1e15, 8)
  check('oldestPerCamera searches segments_cam once per camera it is given, never a scan of the segments', /SEARCH segments USING INDEX segments_cam \(nvr=\? AND ch=\?/.test(perCam) && !/SCAN segments/.test(perCam), perCam)
  const at = planOf(LOCATION_SQL.oldestAt, 'L1', -1e15, 50)
  check('oldest on one location from a start time: segments_loc, in start_ms order', /^SEARCH segments USING INDEX segments_loc \(loc=\? AND start_ms>\?\)$/.test(at), at)
}

// ---- an index written before segments_loc gains it when it is opened ----------------------------------
{
  const f = join(ROOT, 'before-loc.db')
  const pre = new DatabaseSync(f)
  pre.exec(`CREATE TABLE segments (path TEXT PRIMARY KEY, nvr TEXT NOT NULL, ch INTEGER NOT NULL, start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL, bytes INTEGER NOT NULL, keyframes INTEGER NOT NULL, loc TEXT);
    CREATE INDEX segments_cam ON segments (nvr, ch, start_ms);`)
  pre.prepare("INSERT INTO segments VALUES ('/a/1.h264', 'a', 0, 1000, 61000, 500, 1, 'ram-spool'), ('/a/2.h264', 'a', 0, 61000, 121000, 700, 1, 'L1')").run()
  pre.close()
  const ix = openRecIndex(f)
  const raw = new DatabaseSync(f)
  const have = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'segments_loc'").get()
  raw.close()
  check('an existing index gains segments_loc (loc, start_ms) at open, rows kept', /\(loc, start_ms\)/.test(have?.sql ?? '') && J(ix.locationUse('ram-spool')) === J({ bytes: 500, segments: 1 }) && ix.locationUse('L1').bytes === 700, have?.sql ?? 'no segments_loc')
  ix.close()
}

// ---- time-lapse thinning's rows (thinning.mjs; perf report Task 4 and its check verify-1, 2026-09-29) ------
// A rewritten file kept its row as it was: olderThan() gave the same oldest 500 of a camera every run,
// the job re-read all of them ("already thin") and never got past them. Now a row carries `thinned`
// (null: full video not looked at yet; THIN.timelapse; THIN.kept: looked at and left as it was), and
// the job walks only the rows still null, through a partial index that holds nothing else. Its key is
// time first (start_ms, nvr, ch): the deletion jobs take the oldest files of every camera together, and a
// camera-first key spread each batch of 100 over 87 index pages (1,350 WAL pages for 470 files instead of
// 931: a checkpoint on the main thread in every such run); time-first adds about 15.
{
  const { THIN, THIN_SQL } = await import('../rec-index.mjs')
  const f = join(ROOT, 'thin.db')
  const ix = openRecIndex(f)
  const raw = new DatabaseSync(f)
  const add = (ch, i, extra = {}) => ix.addSegment({ nvr: 't1', ch, path: `/rec/t1/${ch}/${i}.h265`, startMs: T0 + i * MIN, endMs: T0 + i * MIN + 59_000, bytes: 12_000_000, keyframes: 30, loc: 'L1', ...extra })
  for (let i = 0; i < 20; i++) add(0, i)
  for (let i = 0; i < 20; i++) add(1, i, { loc: i < 5 ? 'L2' : 'L1' })
  check('a new row is full video, not looked at yet (thinned null)', ix.thinRow('/rec/t1/0/0.h265').thinned === null, J(ix.thinRow('/rec/t1/0/0.h265')))
  check('... playback\'s rows keep the shape they had (the mark only in thinRow and the walk)', !('thinned' in ix.byPath('/rec/t1/0/0.h265')) && !('thinned' in ix.at('t1', 0, T0 + 1000)) && J(Object.keys(ix.thinRow('/rec/t1/0/0.h265'))) === J([...Object.keys(ix.byPath('/rec/t1/0/0.h265')), 'thinned']), J(ix.byPath('/rec/t1/0/0.h265')))
  check('THIN names the two marks', THIN.timelapse === 1 && THIN.kept === 2)

  // thinning: the swap's index half, with the rewrite in flight kept in its own table
  const before = ix.locationUse('L1').bytes
  ix.thinBegin([{ path: '/rec/t1/0/0.h265', loc: 'L1', bytes: 12_000_000, keyframes: 30 }, { path: '/rec/t1/0/1.h265', loc: 'L1', bytes: 12_000_000, keyframes: 30 }], T0)
  ix.thinBegin({ path: '/rec/t1/0/9.h265', loc: 'L1', bytes: 12_000_000, keyframes: 30 }, T0 + 1)
  check('rewrites begun (a few at once, or one) are in flight, with what each file was', J(ix.thinInflight().map((r) => [r.path, r.wasBytes, r.wasKeyframes])) === J([['/rec/t1/0/0.h265', 12_000_000, 30], ['/rec/t1/0/1.h265', 12_000_000, 30], ['/rec/t1/0/9.h265', 12_000_000, 30]]), J(ix.thinInflight()))
  ix.thinSwapped('/rec/t1/0/0.h265', { bytes: 1_300_000, keyframes: 6 })
  const row = ix.thinRow('/rec/t1/0/0.h265')
  check('swapped: the row says time-lapse, with the new size and keyframes', row.thinned === THIN.timelapse && row.bytes === 1_300_000 && row.keyframes === 6 && row.startMs === T0, J(row))
  check('... the location\'s total follows the new size (the triggers)', ix.locationUse('L1').bytes === before - 10_700_000, J(ix.locationUse('L1')))
  ix.thinEnd(['/rec/t1/0/0.h265', '/rec/t1/0/9.h265'])
  check('rewrites ended (a few at once, or one) are no longer in flight', J(ix.thinInflight().map((r) => r.path)) === J(['/rec/t1/0/1.h265']))
  ix.setThin('/rec/t1/0/1.h265', null, { bytes: 12_000_000, keyframes: 30 })
  ix.thinEnd('/rec/t1/0/1.h265')
  ix.setThin('/rec/t1/0/2.h265', THIN.kept)
  check('setThin: a row marked as left as it was keeps its size; null puts a row back as full video', ix.thinRow('/rec/t1/0/2.h265').thinned === THIN.kept && ix.thinRow('/rec/t1/0/2.h265').bytes === 12_000_000 && ix.thinRow('/rec/t1/0/1.h265').thinned === null)
  check('... a row written again (the recorder, backfill) is full video again unless it says otherwise', (add(0, 2), ix.thinRow('/rec/t1/0/2.h265').thinned === null) && (add(0, 2, { thinned: THIN.kept }), ix.thinRow('/rec/t1/0/2.h265').thinned === THIN.kept))

  // the walk: only rows still full video, older than the cutoff, from a start time on
  const cutoff = T0 + 10 * MIN
  const cam0 = [{ nvr: 't1', ch: 0 }]
  const walk = ix.fullOlderThan(cam0, cutoff, 100).map((r) => Number(r.path.match(/(\d+)\.h265$/)[1]))
  check('fullOlderThan: the cameras\' full-video rows that ended before the cutoff, oldest first, none thinned or kept', J(walk) === J([1, 3, 4, 5, 6, 7, 8, 9]), J(walk))
  check('... from a start time on, and at most `limit`', J(ix.fullOlderThan(cam0, cutoff, 3, T0 + 4 * MIN).map((r) => r.startMs)) === J([T0 + 4 * MIN, T0 + 5 * MIN, T0 + 6 * MIN]))
  const two = ix.fullOlderThan([{ nvr: 't1', ch: 0 }, { nvr: 't1', ch: 1 }], cutoff, 4).map((r) => [r.ch, r.startMs - T0])
  check('... several cameras at once, in start order, only those asked for', J(two) === J([[1, 0], [0, MIN], [1, MIN], [1, 2 * MIN]]) && ix.fullOlderThan([{ nvr: 't9', ch: 0 }], cutoff, 4).length === 0, J(two))
  check('firstFull: where the cameras\' next full-video row starts, or null', ix.firstFull(cam0, T0 + 2 * MIN, cutoff) === T0 + 3 * MIN && ix.firstFull(cam0, T0 + 20 * MIN, T0 + 30 * MIN) === null, String(ix.firstFull(cam0, T0 + 2 * MIN, cutoff)))

  // the dry run's figures: one aggregate per stretch between bookmarks, by camera and location
  const sum = ix.fullSummary([{ nvr: 't1', ch: 1 }], { fromMs: T0, toMs: cutoff, endBefore: cutoff, stepMs: 10_000 })
  const byLoc = Object.fromEntries(sum.map((r) => [r.loc, r]))
  // each file is 59 s with 30 keyframes: one kept per 10 s is 5.9 of 30, so 12 MB counts as 2.36 MB
  check('fullSummary: files and bytes per location, and the bytes weighted by the share of keyframes kept', byLoc.L1?.files === 5 && byLoc.L2?.files === 5 && byLoc.L1.bytes === 60_000_000 && Math.abs(byLoc.L1.weighted - 5 * 12_000_000 * (5.9 / 30)) < 1 && byLoc.L2.firstMs === T0, J(sum))
  check('... a file shorter than one interval still keeps one keyframe; one with fewer keyframes keeps them all', (() => {
    add(2, 0, { endMs: T0 + 2000, keyframes: 1, bytes: 1000 })
    add(2, 1, { keyframes: 3, bytes: 3000 })
    const s = ix.fullSummary([{ nvr: 't1', ch: 2 }], { fromMs: T0, toMs: cutoff, endBefore: cutoff, stepMs: 10_000 })[0]
    return s.files === 2 && Math.abs(s.weighted - 4000) < 1e-6
  })(), J(ix.fullSummary([{ nvr: 't1', ch: 2 }], { fromMs: T0, toMs: cutoff, endBefore: cutoff, stepMs: 10_000 })))
  const both = ix.fullSummary([{ nvr: 't1', ch: 1 }, { nvr: 't1', ch: 2 }], { fromMs: T0, toMs: cutoff, endBefore: cutoff, stepMs: 10_000 }).map((r) => [r.nvr, r.ch, r.loc, r.files])
  check('... per camera and location, several cameras at once', J(both.sort()) === J([['t1', 1, 'L1', 5], ['t1', 1, 'L2', 5], ['t1', 2, 'L1', 2]]), J(both))
  // (the file already rewritten, 1.3 MB of its 12, is not what arrived: audit of 2026-10-07)
  check('startedBetween: the full video that started in a window, every camera; a file already time-lapse is left out', J(ix.startedBetween(T0, T0 + 2 * MIN)) === J({ files: 5, bytes: 12_000_000 * 3 + 1000 + 3000 }), J(ix.startedBetween(T0, T0 + 2 * MIN)))
  // one camera's sums from its own rows (a camera with bookmarks of its own: thinning.mjs backlogOf, 2026-09-30)
  const of1 = ix.fullSummaryOf({ nvr: 't1', ch: 1 }, { fromMs: T0, toMs: cutoff, endBefore: cutoff, stepMs: 10_000 })
  check('fullSummaryOf: one camera\'s figures, the same as fullSummary\'s for it', J(of1.map((r) => [r.nvr, r.ch, r.loc, r.files, r.bytes, Math.round(r.weighted), r.firstMs]).sort()) === J(sum.map((r) => [r.nvr, r.ch, r.loc, r.files, r.bytes, Math.round(r.weighted), r.firstMs]).sort()), J({ of1, sum }))
  check('... full video only, starting in the window and ending before the bound', ix.fullSummaryOf({ nvr: 't1', ch: 0 }, { fromMs: T0, toMs: cutoff, endBefore: T0 + 5 * MIN, stepMs: 10_000 })[0]?.files === 3, J(ix.fullSummaryOf({ nvr: 't1', ch: 0 }, { fromMs: T0, toMs: cutoff, endBefore: T0 + 5 * MIN, stepMs: 10_000 })))

  const planOf = (sql, ...p) => raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p).map((r) => r.detail).join(' | ')
  const keys = JSON.stringify(['t1/0'])
  const w = planOf(THIN_SQL.fullOlderThan, -1e15, cutoff, cutoff, keys, 50)
  check('fullOlderThan searches the partial index of full-video rows, bounded by start_ms, in its order (no sort)', /^SEARCH segments USING INDEX segments_full \(start_ms>\? AND start_ms<\?\)/.test(w) && !/TEMP B-TREE|SCAN segments/.test(w), w)
  const ff = planOf(THIN_SQL.firstFull, -1e15, cutoff, keys)
  check('firstFull too', /^SEARCH segments USING INDEX segments_full \(start_ms>\? AND start_ms<\?\)/.test(ff) && !/TEMP B-TREE|SCAN segments/.test(ff), ff)
  const s = planOf(THIN_SQL.fullSummary, 10_000, -1e15, cutoff, cutoff, keys)
  check('fullSummary searches it too', /SEARCH segments USING INDEX segments_full \(start_ms>\? AND start_ms<\?\)/.test(s) && !/SCAN segments/.test(s), s)
  const so = planOf(THIN_SQL.fullSummaryOf, 10_000, 't1', 1, -1e15, cutoff, cutoff)
  check('fullSummaryOf reads one camera\'s rows only (segments_cam, camera and start bounded)', /SEARCH segments USING INDEX segments_cam \(nvr=\? AND ch=\? AND start_ms>\? AND start_ms<\?\)/.test(so) && !/SCAN segments/.test(so), so)
  const b = planOf(THIN_SQL.startedBetween, T0, cutoff)
  check('startedBetween searches the partial index of full-video rows, bounded on both sides', /^SEARCH segments USING INDEX segments_full \(start_ms>\? AND start_ms<\?\)$/.test(b), b)
  raw.close()
  ix.close()
}
// the thinning index costs the deletion jobs next to nothing: the oldest files of 87 cameras, deleted 100 a
// transaction as housekeeping does, write about as many WAL pages as the same files once rewritten (which
// are not in it). A camera-first key wrote 87 more pages a batch.
{
  const frames = (thinned) => {
    const f = join(ROOT, `thin-wal-${thinned}.db`)
    const ix = openRecIndex(f)
    const raw = new DatabaseSync(f)
    raw.exec('BEGIN')
    const ins = raw.prepare('INSERT INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc, thinned) VALUES (?, ?, ?, ?, ?, 1000, 30, ?, ?)')
    for (let k = 0; k < 60; k++) for (let c = 0; c < 87; c++) ins.run(`/rec/nvr-${c % 4}/${c}/${k}.h265`, `nvr-${c % 4}`, c, T0 + k * MIN, T0 + k * MIN + 59_000, 'L1', thinned ? 1 : null)
    raw.exec('COMMIT')
    raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    const oldest = ix.oldest(261, { loc: 'L1' }).map((r) => r.path)
    for (let i = 0; i < oldest.length; i += 100) ix.removeMany(oldest.slice(i, i + 100))
    const n = raw.prepare('PRAGMA wal_checkpoint(PASSIVE)').get().log
    raw.close()
    ix.close()
    return n
  }
  const full = frames(false)
  const thin = frames(true)
  check('deleting the oldest full-video files writes about as many WAL pages as deleting rewritten ones (time-first key)', full <= thin * 1.1 + 10, `${full} vs ${thin} pages for 261 files in 3 transactions`)
}
// ---- days kept against the target (retention-target.mjs, 2026-09-30, p4-target) ------------------------
// What every camera recorded on each location in a window (the daily volume), a row window's end on
// segments_start, the time-lapse rows' edges and a sample of them through a partial index that holds one
// time-lapse file per camera and hour (so converting a file writes an index page 1 time in 60, not every
// time: thinning's WAL budget), and the first full-video row after a time on one location.
{
  const { THIN, TARGET_SQL } = await import('../rec-index.mjs')
  const f = join(ROOT, 'target.db')
  const ix = openRecIndex(f)
  const raw = new DatabaseSync(f)
  const add = (ch, i, extra = {}) => ix.addSegment({ nvr: 'd1', ch, path: `/rec/d1/${ch}/${i}.h265`, startMs: T0 + i * MIN, endMs: T0 + i * MIN + 59_000, bytes: 12_000_000, keyframes: 30, loc: 'L1', ...extra })
  // three hours of two cameras on L1, the second camera's first hour on L2; a third camera with no location
  for (let i = 0; i < 180; i++) add(0, i)
  for (let i = 0; i < 180; i++) add(1, i, { loc: i < 60 ? 'L2' : 'L1' })
  for (let i = 0; i < 10; i++) add(2, i, { loc: null, bytes: 1000 })
  const use = ix.dayUse(T0, T0 + 3 * 60 * MIN, 10_000)
  const by = Object.fromEntries(use.map((r) => [`${r.loc}|${r.ch}`, r]))
  check('dayUse: files, bytes and footage time per location and camera; a row with no location counts under \'\'', J(Object.keys(by).sort()) === J(['L1|0', 'L1|1', 'L2|1', '|2']) && by['L1|0'].files === 180 && by['L1|0'].bytes === 180 * 12_000_000 && by['L1|0'].ms === 180 * 59_000 && by['L2|1'].files === 60 && by['|2'].bytes === 10_000, J(use.map((r) => [r.loc, r.ch, r.files])))
  check('... and the bytes weighted by the share of keyframes one per interval keeps (as thinning\'s fullSummary)', Math.abs(by['L1|0'].weighted - 180 * 12_000_000 * (5.9 / 30)) < 1, String(by['L1|0'].weighted))
  check('... only the rows that start in the window', ix.dayUse(T0 + 60 * MIN, T0 + 61 * MIN, 10_000).reduce((a, r) => a + r.files, 0) === 2)
  check('... all of them full video: the full-video bytes and footage time are the same', by['L1|0'].fullBytes === by['L1|0'].bytes && by['L1|0'].fullMs === by['L1|0'].ms, J(by['L1|0']))
  check('startNth: where the n-th row from a time starts (any camera, any location); past the last, null', ix.startNth(T0, 0) === T0 && ix.startNth(T0, 3) === T0 + MIN && ix.startNth(T0 + 179 * MIN, 1) === T0 + 179 * MIN && ix.startNth(T0 + 179 * MIN, 2) === null, J([ix.startNth(T0, 3), ix.startNth(T0 + 179 * MIN, 2)]))

  // time-lapse: camera 0's first two hours rewritten; the edges and the sample see the file of each hour's first minute
  check('no time-lapse yet: no edges, an empty sample', ix.timelapseEdges('L1') === null && ix.timelapseSample('L1', T0, T0 + 3 * 60 * MIN).length === 0)
  for (let i = 0; i < 120; i++) ix.thinSwapped(`/rec/d1/0/${i}.h265`, { bytes: 1_000_000, keyframes: 6 })
  const edges = ix.timelapseEdges('L1')
  check('timelapseEdges: the oldest and newest time-lapse file of the hours\' first minutes (to the hour)', J(edges) === J({ oldestMs: T0, newestMs: T0 + 60 * MIN }) && ix.timelapseEdges('L2') === null, J(edges))
  const sample = ix.timelapseSample('L1', T0, T0 + 3 * 60 * MIN)
  check('timelapseSample: one file an hour per camera, with its bytes and footage time', J(sample) === J([{ nvr: 'd1', ch: 0, files: 2, bytes: 2_000_000, ms: 2 * 59_000 }]), J(sample))
  // the full-video sums leave the rewritten files out; the files, bytes and footage time count every row
  // (retention-target.mjs scales the full video's bytes to the whole footage time: audit of 2026-10-07, M12)
  const mixed = ix.dayUse(T0, T0 + 3 * 60 * MIN, 10_000).find((r) => r.loc === 'L1' && r.ch === 0)
  check('dayUse: a camera\'s files rewritten to time-lapse are in files, bytes and ms, and not in fullBytes, fullMs or weighted', mixed.files === 180 && mixed.bytes === 120 * 1_000_000 + 60 * 12_000_000 && mixed.ms === 180 * 59_000 && mixed.fullBytes === 60 * 12_000_000 && mixed.fullMs === 60 * 59_000 && Math.abs(mixed.weighted - 60 * 12_000_000 * (5.9 / 30)) < 1, J(mixed))
  ix.setThin('/rec/d1/0/0.h265', THIN.kept)
  check('... a file left as it was (THIN.kept) is not time-lapse', J(ix.timelapseEdges('L1')) === J({ oldestMs: T0 + 60 * MIN, newestMs: T0 + 60 * MIN }))
  const next = ix.fullNext('L1', T0 + 60 * MIN, 1000)
  check('fullNext: the first full-video row after a time on one location, within a window of rows', next.s === T0 + 60 * MIN && next.n > 0, J(next))
  const past = ix.fullNext('L1', T0 + 30 * MIN, 20)
  check('... none in the window: null, with the last start looked at, for the next window', past.s === null && past.n === 20 && past.last === T0 + 49 * MIN, J(past))
  const done = ix.fullNext('L2', T0 + 60 * MIN, 1000)
  check('... past the location\'s last row: fewer rows than asked', done.s === null && done.n === 0, J(done))

  const planOf = (sql, ...p) => raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p).map((r) => r.detail).join(' | ')
  const d = planOf(TARGET_SQL.dayUse, 10_000, T0, T0 + MIN)
  check('dayUse searches segments_start, bounded on both sides', /^SEARCH segments USING INDEX segments_start \(start_ms>\? AND start_ms<\?\)/.test(d) && !/SCAN segments/.test(d), d)
  const n = planOf(TARGET_SQL.startNth, T0, 5000)
  check('startNth counts on segments_start alone (no row read)', /^SEARCH segments USING COVERING INDEX segments_start \(start_ms>\?\)$/.test(n), n)
  const eo = planOf(TARGET_SQL.tlOldest, 'L1')
  const en = planOf(TARGET_SQL.tlNewest, 'L1')
  check('the time-lapse edges: one entry of the sampled partial index each (no row read)', /^SEARCH segments USING COVERING INDEX segments_tl \(loc=\?\)$/.test(eo) && /^SEARCH segments USING COVERING INDEX segments_tl \(loc=\?\)$/.test(en), `${eo} ;; ${en}`)
  const sp = planOf(TARGET_SQL.tlSample, 'L1', T0, T0 + MIN)
  check('the sample searches it, bounded by start_ms', /^SEARCH segments USING INDEX segments_tl \(loc=\? AND start_ms>\? AND start_ms<\?\)/.test(sp) && !/SCAN segments/.test(sp), sp)
  const fn = planOf(TARGET_SQL.fullNext, 'L1', T0, 1000)
  check('fullNext walks segments_loc from the time, a window of rows at most', /SEARCH segments USING INDEX segments_loc \(loc=\? AND start_ms>\?\)/.test(fn) && !/SCAN segments /.test(fn), fn)
  const tlIdx = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'segments_tl'").get()?.sql ?? ''
  check('segments_tl holds time-lapse rows of the first minute of each hour only', /WHERE thinned = 1 AND start_ms % 3600000 < 60000/.test(tlIdx), tlIdx)
  raw.close()
  ix.close()
}
// converting a file writes an index page for segments_tl only when the file starts in its hour's first minute:
// the same swaps (one commit a file, as thinning makes them) on an index with and without it differ by under
// 0.1 WAL page a file (thinning.test.mjs holds the job to 4 pages a file)
{
  const pages = (withTl) => {
    const f = join(ROOT, `tl-wal-${withTl}.db`)
    // (SQLite's own checkpoints off: each would empty the log in the middle of the count)
    const ix = openRecIndex(f, { walAutocheckpoint: 0 })
    const raw = new DatabaseSync(f)
    if (!withTl) raw.exec('DROP INDEX segments_tl')
    raw.exec('BEGIN')
    const ins = raw.prepare('INSERT INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc) VALUES (?, ?, ?, ?, ?, 12000000, 30, ?)')
    for (let k = 0; k < 120; k++) for (let c = 0; c < 87; c++) ins.run(`/rec/nvr-${c % 4}/${c}/${k}.h265`, `nvr-${c % 4}`, c, T0 + k * MIN, T0 + k * MIN + 59_000, 'L1')
    raw.exec('COMMIT')
    raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    let n = 0
    for (let k = 0; k < 120; k++) for (let c = 0; c < 87; c += 3) (ix.thinSwapped(`/rec/nvr-${c % 4}/${c}/${k}.h265`, { bytes: 1_300_000, keyframes: 6 }), n++)
    const log = raw.prepare('PRAGMA wal_checkpoint(PASSIVE)').get().log
    raw.close()
    ix.close()
    return { log, n }
  }
  const a = pages(false)
  const b = pages(true)
  check('segments_tl costs thinning under 0.1 WAL page a converted file (one index page 1 file in 60)', (b.log - a.log) / b.n < 0.1, `${a.log} pages without it, ${b.log} with it, for ${b.n} files swapped one commit each: ${((b.log - a.log) / b.n).toFixed(3)} a file more`)
}
// an index written before `thinned` gains the column, its partial index and the in-flight table at open
{
  const f = join(ROOT, 'before-thin.db')
  const pre = new DatabaseSync(f)
  pre.exec(`CREATE TABLE segments (path TEXT PRIMARY KEY, nvr TEXT NOT NULL, ch INTEGER NOT NULL, start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL, bytes INTEGER NOT NULL, keyframes INTEGER NOT NULL, loc TEXT);
    CREATE INDEX segments_cam ON segments (nvr, ch, start_ms);`)
  pre.prepare("INSERT INTO segments VALUES ('/a/1.h264', 'a', 0, 1000, 61000, 500, 30, 'L1'), ('/a/2.h264', 'a', 0, 61000, 121000, 700, 30, 'L1')").run()
  pre.close()
  const ix = openRecIndex(f)
  const raw = new DatabaseSync(f)
  const idx = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'segments_full'").get()
  const tab = raw.prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'thin_inflight'").get()
  raw.close()
  check('an existing index gains thinned, segments_full (full-video rows only) and thin_inflight at open; its rows are full video', /WHERE thinned IS NULL/.test(idx?.sql ?? '') && tab?.one === 1 && ix.fullOlderThan([{ nvr: 'a', ch: 0 }], 200_000, 10).length === 2 && ix.thinRow('/a/1.h264').thinned === null, idx?.sql ?? 'no segments_full')
  ix.close()
}

// ---- the gap rows and the footage the backfill scan and the recovery read (2026-09-30) ----------------
// gaps() and lastEnds()'s gap end walk every gap row the camera has whose from_ms is before the bound
// (gaps_cam is on from_ms, and a row's end says nothing about its start), and gap rows are kept 183 days:
// nvr-2/0 alone writes about 5,000 a day. The backfill scan asked for them every tick and the recovery
// asks for 26 cameras' after every worker restart (perf report R5, R8; R11: 808 ms for lastEnds on 87
// cameras at 31 days). gapsNear() and the new lastEnds() walk only the rows that started within
// LONG_GAP_MS before the window, and the few longer rows through gaps_long. scanSpans() is every file
// overlapping a window, long files included (segments() leaves out a file over MAX_SEGMENT_MS that
// started before the window: harmless for playback, a false hole for the scan). All must give exactly
// what reading every row gives.
{
  const G = LONG_GAP_MS
  const gcams = []
  let gn = 0
  const gapRow = (nvr, ch, fromMs, toMs) => {
    index.addGap({ nvr, ch, fromMs, toMs, reason: `r${++gn % 5}` })
    return { fromMs, toMs }
  }
  // mostly short rows, some long (hours to days), some exactly LONG_GAP_MS and one ms over, some that end
  // before they start, some of no length, some starting at the same time
  for (let c = 0; c < 6; c++) {
    const nvr = c % 2 ? 'g-b' : 'g-a'
    const ch = c
    gcams.push([nvr, ch])
    for (let i = 0; i < 500; i++) {
      const s = T0 + between(0, 4 * 24 * 60) * MIN + between(0, 59_999)
      const r = rand()
      const len = r < 0.8 ? between(1000, 50 * MIN) : r < 0.86 ? between(2 * 60, 3 * 24 * 60) * MIN : r < 0.89 ? G : r < 0.92 ? G + 1 : r < 0.95 ? -between(1, 3 * 60) * MIN : r < 0.97 ? 0 : G - 1
      gapRow(nvr, ch, s, s + len)
      if (rand() < 0.03) gapRow(nvr, ch, s, s + between(1000, 5 * MIN))
    }
  }
  // the newest row ends before it starts, and an older short one ends last: the case the bound cannot answer
  gcams.push(['g-c', 0])
  gapRow('g-c', 0, T0, T0 + 50 * MIN)
  gapRow('g-c', 0, T0 + 30 * MIN, T0 + 30 * MIN - 2 * 60 * MIN)
  // footage with long files for scanSpans: files of 1-3 h among minute files, one of 2 days
  gcams.push(['g-d', 0])
  minutes('g-d', 0, T0, 3 * 24 * 60)
  for (let i = 0; i < 40; i++) {
    const s = T0 + between(0, 3 * 24 * 60) * MIN
    seg('g-d', 0, s, s + between(M + 1, 3 * M))
  }
  seg('g-d', 0, T0 + 10 * MIN, T0 + 2 * 24 * 60 * MIN)
  const oldGaps = old.prepare('SELECT nvr, ch, from_ms AS fromMs, to_ms AS toMs, reason FROM gaps WHERE nvr = ? AND ch = ? AND to_ms >= ? AND from_ms <= ? ORDER BY from_ms, id')
  const oldGapEnd = old.prepare('SELECT MAX(to_ms) AS e FROM gaps WHERE nvr = ? AND ch = ? AND from_ms < ?')
  const allSpans = old.prepare('SELECT start_ms AS s, end_ms AS e FROM segments NOT INDEXED WHERE nvr = ? AND ch = ? AND end_ms >= ? AND start_ms <= ? ORDER BY start_ms, end_ms')
  const firstAfter = old.prepare('SELECT start_ms AS s, end_ms AS e FROM segments NOT INDEXED WHERE nvr = ? AND ch = ? AND start_ms > ? AND start_ms <= ? ORDER BY start_ms LIMIT 1')
  const strip = (r) => J({ nvr: r.nvr, ch: r.ch, fromMs: r.fromMs, toMs: r.toMs, reason: r.reason })
  const bad = []
  let asked = 0
  for (const [nvr, ch] of [...gcams, ...cams]) {
    const windows = [[T0 - 10 * 24 * 60 * MIN, T0 + 10 * 24 * 60 * MIN]]
    for (let i = 0; i < 40; i++) {
      const a = T0 + between(-60, 4 * 24 * 60) * MIN + between(0, 59_999)
      windows.push([a, a + [0, 1, MIN, 6 * 60 * MIN, G, G + 1][i % 6] + between(0, 5000)])
    }
    for (const [a, b] of windows) {
      asked++
      const want = oldGaps.all(nvr, ch, a, b).map(strip).join()
      const got = typeof index.gapsNear === 'function' ? index.gapsNear(nvr, ch, a, b).map(strip).join() : null
      if (got !== want) bad.push(`gapsNear ${nvr}/${ch} [${a}, ${b}]`)
      const ws = allSpans.all(nvr, ch, a, b).map((r) => `${r.s}-${r.e}`).sort().join()
      const gs = typeof index.scanSpans === 'function' ? index.scanSpans(nvr, ch, a, b).map((r) => `${r.startMs}-${r.endMs}`).sort().join() : null
      if (gs !== ws) bad.push(`scanSpans ${nvr}/${ch} [${a}, ${b}]`)
      const wa = firstAfter.get(nvr, ch, b, b + 3 * 24 * 60 * MIN)
      const ga = typeof index.scanSpanAfter === 'function' ? index.scanSpanAfter(nvr, ch, b, b + 3 * 24 * 60 * MIN) : undefined
      if (J(ga ? [ga.startMs, ga.endMs] : ga) !== J(wa ? [wa.s, wa.e] : null)) bad.push(`scanSpanAfter ${nvr}/${ch} ${b}`)
      for (const bound of [a, b]) {
        asked++
        const w = oldGapEnd.get(nvr, ch, bound).e ?? null
        const g = index.lastEnds(nvr, ch, bound).gapEnd
        if (g !== w) bad.push(`lastEnds gapEnd ${nvr}/${ch} before ${bound}: ${g} vs ${w}`)
      }
    }
  }
  check('gapsNear, scanSpans and lastEnds\'s gap end give what reading every row gives (long rows, rows that end before they start, the same start twice)', bad.length === 0, bad.length ? `${bad.length} of ${asked} differ: ${bad.slice(0, 4).join('; ')}` : `${asked} lookups on ${gcams.length + cams.length} cameras`)
  check('... a newest gap row that ends before it starts still gives the real end', index.lastEnds('g-c', 0, T0 + 60 * MIN).gapEnd === T0 + 50 * MIN, String(index.lastEnds('g-c', 0, T0 + 60 * MIN).gapEnd))
  check('... scanSpans has the long file the window does not reach the start of', (index.scanSpans?.('g-d', 0, T0 + 30 * 60 * MIN, T0 + 30 * 60 * MIN + MIN) ?? []).some((r) => r.startMs === T0 + 10 * MIN))

  const planOf = (sql, ...p) => {
    try {
      return old.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p).map((r) => r.detail).join(' | ')
    } catch (e) {
      return `(no plan: ${e.message})`
    }
  }
  const near = planOf(GAP_SQL.near, 'g-a', 0, T0, T0, T0, 'g-a', 0, T0, T0)
  check('gapsNear: a search of gaps_cam bounded on from_ms, and one of gaps_long (no scan of every row)', /SEARCH gaps USING INDEX gaps_cam \(nvr=\? AND ch=\? AND from_ms>\? AND from_ms<\?\)/.test(near) && /SEARCH gaps USING INDEX gaps_long \(nvr=\? AND ch=\? AND to_ms>\?\)/.test(near) && !/SCAN gaps/.test(near), near)
  const since = planOf(GAP_SQL.endSince, 'g-a', 0, T0, T0)
  const fromBefore = planOf(GAP_SQL.fromBefore, 'g-a', 0, T0)
  const longEnd = planOf(GAP_SQL.longEnd, 'g-a', 0, T0)
  check('lastEnds\'s gap end: gaps_cam bounded on both sides, and gaps_long', /gaps_cam \(nvr=\? AND ch=\? AND from_ms>\? AND from_ms<\?\)/.test(since) && /gaps_cam \(nvr=\? AND ch=\? AND from_ms<\?\)/.test(fromBefore) && /INDEX gaps_long \(nvr=\? AND ch=\?\)/.test(longEnd), `${since} ;; ${fromBefore} ;; ${longEnd}`)
  const spans = planOf(SCAN_SQL.spans, 'g-d', 0, T0, T0, T0, 'g-d', 0, T0, T0)
  const after = planOf(SCAN_SQL.after, 'g-d', 0, T0, T0)
  check('scanSpans: segments_cam bounded on start_ms, and segments_long; the file after: one search', /segments_cam \(nvr=\? AND ch=\? AND start_ms>\? AND start_ms<\?\)/.test(spans) && /INDEX segments_long \(nvr=\? AND ch=\? AND end_ms>\?\)/.test(spans) && !/SCAN segments/.test(spans) && /segments_cam \(nvr=\? AND ch=\? AND start_ms>\? AND start_ms<\?\)/.test(after), `${spans} ;; ${after}`)
}

// ---- every rewritten statement searches an index, bounded where a bound is the point ---------------
// (The old statements were searches too -- "segments_cam (nvr=? AND ch=?)" -- which is exactly how
// they came to read every row of a camera: the plan must show the bound on start_ms, and the
// timing below shows the work.)
{
  const want = {
    newestStart: /segments_cam \(nvr=\? AND ch=\? AND start_ms<\?\)/,
    endSince: /segments_cam \(nvr=\? AND ch=\? AND start_ms>\? AND start_ms<\?\)/,
    longEnd: /INDEX segments_long \(nvr=\? AND ch=\?\)/,
    olderThan: /segments_cam \(nvr=\? AND ch=\? AND start_ms>\? AND start_ms<\?\)/,
    firstNvr: /COVERING INDEX segments_cam/,
    nextNvr: /segments_cam \(nvr>\?\)/,
    firstCh: /segments_cam \(nvr=\?\)/,
    nextCh: /segments_cam \(nvr=\? AND ch>\?\)/
  }
  const bad = []
  for (const [name, sql] of Object.entries(CAMERA_SQL)) {
    const params = (sql.match(/\?/g) ?? []).map(() => 1)
    const plan = old.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail)
    if (plan.length !== 1 || /^SCAN /.test(plan[0]) || !want[name]?.test(plan[0])) bad.push(`${name}: ${plan.join(' | ')}`)
  }
  check('each per-camera timer statement is the index search it is meant to be', bad.length === 0 && Object.keys(CAMERA_SQL).length === Object.keys(want).length, bad.join(' ;; ') || Object.keys(CAMERA_SQL).join(', '))
}

old.close()
index.close()

// ---- and none of them grows with the camera's history ---------------------------------------------
// Two cameras with 100,000 minute files each (70 days; the site keeps 183). The old statements read
// every row of the camera (or of the index) each time; the new ones must be at least ten times
// quicker. The real margin is a few hundred times, so a busy machine does not make this flaky.
{
  const big = join(ROOT, 'big.db')
  const ix = openRecIndex(big)
  const raw = new DatabaseSync(big)
  const ins = raw.prepare('INSERT INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc) VALUES (?, ?, ?, ?, ?, 1000, 1, ?)')
  raw.exec('BEGIN')
  for (const ch of [0, 1]) for (let i = 0; i < 100_000; i++) ins.run(`/big/${ch}/${i}.h264`, 'big', ch, T0 + i * MIN, T0 + (i + 1) * MIN, 'L1')
  raw.exec('COMMIT')
  const time = (fn) => {
    fn()
    const a = performance.now()
    for (let i = 0; i < 10; i++) fn()
    return (performance.now() - a) / 10
  }
  const lastEnd = raw.prepare('SELECT MAX(end_ms) AS e FROM segments WHERE nvr = ? AND ch = ?')
  const lastEndBefore = raw.prepare('SELECT MAX(end_ms) AS e FROM segments WHERE nvr = ? AND ch = ? AND start_ms < ?')
  const olderThan = raw.prepare('SELECT path FROM segments WHERE nvr = ? AND ch = ? AND end_ms < ? ORDER BY start_ms LIMIT ?')
  const distinct = raw.prepare('SELECT DISTINCT nvr, ch FROM segments ORDER BY nvr, ch')
  const locUse = raw.prepare('SELECT COALESCE(SUM(bytes), 0) AS b, COUNT(*) AS n FROM segments NOT INDEXED WHERE loc = ?')
  const pairs = [
    ['lastSegmentEnd', () => lastEnd.get('big', 0), () => ix.lastSegmentEnd('big', 0)],
    ['lastSegmentEnd before a time', () => lastEndBefore.get('big', 0, T0 + 99_000 * MIN), () => ix.lastSegmentEnd('big', 0, T0 + 99_000 * MIN)],
    ['olderThan with nothing that old', () => olderThan.all('big', 0, T0, 200), () => ix.olderThan('big', 0, T0, 200)],
    ['cameras', () => distinct.all(), () => ix.cameras()],
    ['locationUse of an empty RAM spool', () => locUse.get('ram-spool'), () => ix.locationUse('ram-spool')],
    ['locationUse of the drive holding every row', () => locUse.get('L1'), () => ix.locationUse('L1')]
  ]
  for (const [name, before, after] of pairs) {
    const b = time(before)
    const a = time(after)
    check(`${name}: at least 10x quicker than reading every row`, a * 10 < b, `${a.toFixed(3)} ms vs ${b.toFixed(3)} ms`)
  }
  check('... and the same answers there too', ix.lastSegmentEnd('big', 0) === T0 + 100_000 * MIN && ix.olderThan('big', 0, T0, 200).length === 0 && ix.cameras().length === 2 && J(ix.locationUse('L1')) === J({ bytes: 200_000_000, segments: 200_000 }))
  // 99,990 of each camera's files already rewritten: the walk for the next ones to rewrite does not pass
  // them (olderThan + a filter, which is what the job did, reads every one of them first)
  const cams2 = [{ nvr: 'big', ch: 0 }, { nvr: 'big', ch: 1 }]
  raw.exec('BEGIN')
  raw.prepare('UPDATE segments SET thinned = 1 WHERE nvr = ? AND start_ms < ?').run('big', T0 + 99_990 * MIN)
  raw.exec('COMMIT')
  const filtered = raw.prepare('SELECT path FROM segments INDEXED BY segments_cam WHERE nvr = ? AND ch = ? AND start_ms < ? AND end_ms < ? AND thinned IS NULL ORDER BY start_ms LIMIT ?')
  const cut = T0 + 100_001 * MIN
  const b = time(() => (filtered.all('big', 0, cut, cut, 5), filtered.all('big', 1, cut, cut, 5)))
  const a = time(() => ix.fullOlderThan(cams2, cut, 10))
  check('fullOlderThan past 199,980 rewritten files: at least 10x quicker than filtering them', a * 10 < b && ix.fullOlderThan(cams2, cut, 10)[0]?.startMs === T0 + 99_990 * MIN, `${a.toFixed(3)} ms vs ${b.toFixed(3)} ms`)
  // a camera never rewritten (not set to time-lapse) among them: each walk passes its old rows, on the
  // index's own columns (0.3-0.4 us a row on the development PC; about 11 ms a walk for a camera kept 30
  // days as full video with 7 full-video days elsewhere). A guard, not a race: under 1 us a row.
  raw.prepare('UPDATE segments SET thinned = NULL WHERE nvr = ? AND ch = ?').run('big', 0)
  const a1 = time(() => ix.fullOlderThan([{ nvr: 'big', ch: 1 }], cut, 5))
  check('... and past a camera never rewritten (99,990 of its rows first): under 1 us a row passed', a1 < 99_990 / 1000 && ix.fullOlderThan([{ nvr: 'big', ch: 1 }], cut, 5)[0]?.startMs === T0 + 99_990 * MIN, `${a1.toFixed(1)} ms, ${((a1 / 99_990) * 1000).toFixed(2)} us a row`)
  // nvr-2/0's gap rows at 40 days (about 5,000 a day, kept 183 days), and one long row among them: the
  // gap rows of an hour, and the camera's last gap end, do not read the camera's history
  const insGap = raw.prepare('INSERT INTO gaps (nvr, ch, from_ms, to_ms, reason) VALUES (?, ?, ?, ?, ?)')
  raw.exec('BEGIN')
  for (let i = 0; i < 200_000; i++) insGap.run('big', 0, T0 + i * 17_280, T0 + i * 17_280 + 5000, 'no video from the NVR')
  insGap.run('big', 0, T0 + 5 * MIN, T0 + 2 * 24 * 60 * MIN, 'camera offline')
  raw.exec('COMMIT')
  const gapsOld = raw.prepare('SELECT nvr, ch, from_ms AS fromMs, to_ms AS toMs, reason FROM gaps WHERE nvr = ? AND ch = ? AND to_ms >= ? AND from_ms <= ? ORDER BY from_ms')
  const gapEndOld = raw.prepare('SELECT MAX(to_ms) AS e FROM gaps WHERE nvr = ? AND ch = ? AND from_ms < ?')
  const at = T0 + 38 * 24 * 60 * MIN
  const g0 = time(() => gapsOld.all('big', 0, at, at + 60 * MIN))
  const g1 = time(() => ix.gapsNear?.('big', 0, at, at + 60 * MIN))
  check('gapsNear for an hour, among 200,000 gap rows (40 days of nvr-2/0\'s): at least 10x quicker than the old walk', g1 * 10 < g0 && J(ix.gapsNear?.('big', 0, at, at + 60 * MIN).map((r) => r.fromMs)) === J(gapsOld.all('big', 0, at, at + 60 * MIN).map((r) => r.fromMs)), `${g1.toFixed(3)} ms vs ${g0.toFixed(3)} ms`)
  const e0 = time(() => gapEndOld.get('big', 0, at))
  const e1 = time(() => ix.lastEnds('big', 0, at))
  check('lastEnds among them (the downtime rows after a worker restart): at least 10x quicker, the same end', e1 * 10 < e0 && ix.lastEnds('big', 0, at).gapEnd === gapEndOld.get('big', 0, at).e, `${e1.toFixed(3)} ms vs ${e0.toFixed(3)} ms`)
  raw.close()
  ix.close()
}
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
