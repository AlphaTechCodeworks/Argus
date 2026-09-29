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
import { CAMERA_SQL, MAX_SEGMENT_MS, openRecIndex } from '../rec-index.mjs'

let failures = 0
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

// ---- every rewritten statement searches an index, bounded where a bound is the point ---------------
// (The old statements were searches too -- "segments_cam (nvr=? AND ch=?)" -- which is exactly how
// they came to read every row of a camera: the plan must show the bound on start_ms, and the
// timing below shows the work.)
{
  const want = {
    newestStart: /segments_cam \(nvr=\? AND ch=\? AND start_ms<\?\)/,
    endSince: /segments_cam \(nvr=\? AND ch=\? AND start_ms>\? AND start_ms<\?\)/,
    longEnd: /INDEX segments_long \(nvr=\? AND ch=\?\)/,
    olderThan: /segments_cam \(nvr=\? AND ch=\? AND start_ms<\?\)/,
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
  const pairs = [
    ['lastSegmentEnd', () => lastEnd.get('big', 0), () => ix.lastSegmentEnd('big', 0)],
    ['lastSegmentEnd before a time', () => lastEndBefore.get('big', 0, T0 + 99_000 * MIN), () => ix.lastSegmentEnd('big', 0, T0 + 99_000 * MIN)],
    ['olderThan with nothing that old', () => olderThan.all('big', 0, T0, 200), () => ix.olderThan('big', 0, T0, 200)],
    ['cameras', () => distinct.all(), () => ix.cameras()]
  ]
  for (const [name, before, after] of pairs) {
    const b = time(before)
    const a = time(after)
    check(`${name}: at least 10x quicker than reading every row`, a * 10 < b, `${a.toFixed(3)} ms vs ${b.toFixed(3)} ms`)
  }
  check('... and the same answers there too', ix.lastSegmentEnd('big', 0) === T0 + 100_000 * MIN && ix.olderThan('big', 0, T0, 200).length === 0 && ix.cameras().length === 2)
  raw.close()
  ix.close()
}
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
