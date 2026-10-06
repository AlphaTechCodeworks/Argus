// Crash-recovery logic of rec-recover.mjs, without a share helper or the SDK: recoverOrphans() over an
// injected `call` (readdir/segInfo), recoverySince()'s per-camera lower bound, and downtimeGaps(). The
// existing rec-recover.test.mjs also drives housekeeping, which pulls in the native SDK and cannot run
// off Linux; these exercise the recovery logic on its own, with the race guard (a file the NEW worker
// may still be writing is left alone) and the scan-bounding checked directly.
// Run: node cctv/test/rec-recover-logic.test.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { downtimeGaps, RECENT_MARGIN_MS, recoverOrphans, recoverySince } from '../rec-recover.mjs'
import { openRecIndex } from '../rec-index.mjs'

let failures = 0
const J = (v) => JSON.stringify(v)
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}

const MAX_SPAN_MS = 5 * 60_000
const dir = mkdtempSync(join(tmpdir(), 'rec-recover-'))
const loc = { id: 'L1', path: join(dir, 'store') }
const nvr = 'n1'
const fpath = (ch, day, hour, name) => join(loc.path, nvr, String(ch), day, hour, name)

// a fake share `call`: readdir and segInfo served from an in-memory set of files (no real I/O)
function fakeCall(files) {
  const kids = new Map()
  const put = (d, name, isDir) => {
    if (!kids.has(d)) kids.set(d, new Map())
    const m = kids.get(d)
    if (!m.has(name) || isDir) m.set(name, isDir)
  }
  for (const f of files) {
    let cur = f.path
    let isDir = false
    for (let parent = dirname(cur); parent !== cur; cur = parent, parent = dirname(cur), isDir = true) put(parent, basename(cur), isDir)
  }
  const info = new Map(files.map((f) => [f.path, { isFile: true, mtimeMs: f.mtimeMs, size: f.size ?? 1, keyframes: f.keyframes ?? 1, firstKeyMs: f.firstKeyMs, lastKeyMs: f.lastKeyMs }]))
  return async (op, args) => {
    if (op === 'readdir') return args.dirs.map((d) => ({ dir: d, entries: kids.has(d) ? [...kids.get(d)].map(([name, isDir]) => ({ name, dir: isDir })) : undefined }))
    if (op === 'segInfo') return args.paths.map((p) => info.get(p) ?? { error: 'ENOENT' })
    throw new Error(`unexpected op ${op}`)
  }
}

// ---- recoverOrphans: index orphan files, honour the race guard and the already-indexed skip
{
  const idx = openRecIndex(join(dir, 'recover.db'))
  const beforeMs = Date.UTC(2026, 8, 26, 14, 0, 0) // when the new worker started
  const day = '2026-09-26'
  const A = fpath(0, day, '13', '13-05.h264') // a real orphan: closed just before the crash, never indexed
  const B = fpath(0, day, '13', '13-20.h264') // changed AFTER the worker started: the new worker may be writing it
  const C = fpath(0, day, '13', '13-40.h264') // already indexed
  const D = fpath(0, day, '13', '13-50.h265') // no .idx keys read: start from the file-name minute
  idx.addSegment({ nvr, ch: 0, path: C, startMs: Date.UTC(2026, 8, 26, 13, 40, 0), endMs: Date.UTC(2026, 8, 26, 13, 41, 0), bytes: 9, keyframes: 3, loc: loc.id })
  const files = [
    { path: A, mtimeMs: Date.UTC(2026, 8, 26, 13, 7, 0), size: 500, keyframes: 4, firstKeyMs: Date.UTC(2026, 8, 26, 13, 5, 2), lastKeyMs: Date.UTC(2026, 8, 26, 13, 6, 30) },
    { path: `${A}.idx`, mtimeMs: Date.UTC(2026, 8, 26, 13, 7, 0) }, // a .idx never matches a segment name: ignored
    { path: B, mtimeMs: Date.UTC(2026, 8, 26, 14, 0, 5), size: 200, keyframes: 1, firstKeyMs: Date.UTC(2026, 8, 26, 13, 20, 0) },
    { path: C, mtimeMs: Date.UTC(2026, 8, 26, 13, 41, 0), size: 9, keyframes: 3, firstKeyMs: Date.UTC(2026, 8, 26, 13, 40, 0) },
    { path: D, mtimeMs: Date.UTC(2026, 8, 26, 13, 52, 0), size: 70, keyframes: 2 }
  ]
  const added = await recoverOrphans({ index: idx, loc, nvrId: nvr, beforeMs, since: null, call: fakeCall(files) })
  const byPath = Object.fromEntries(added.map((s) => [s.path, s]))

  check('the orphan is indexed', Boolean(byPath[A]) && idx.has(A), J(added.map((s) => s.path)))
  check('its start is the first keyframe, its end the last frame (mtime), clamped to <= start + 5 min', byPath[A]?.startMs === Date.UTC(2026, 8, 26, 13, 5, 2) && byPath[A]?.endMs === Date.UTC(2026, 8, 26, 13, 7, 0), J(byPath[A]))
  check('the race guard: a file changed after the new worker started is left alone', !byPath[B] && !idx.has(B), J(byPath[B]))
  check('an already-indexed file is not re-added', !byPath[C] && idx.has(C))
  check('a file with no .idx keys starts at its file-name minute', byPath[D]?.startMs === Date.UTC(2026, 8, 26, 13, 50, 0), J(byPath[D]))
  check('the .idx file is never taken for a segment', !added.some((s) => s.path.endsWith('.idx')))

  // an end clamped UP to the last keyframe when the file kept growing past start + 5 min
  const E = fpath(1, day, '12', '12-00.h264')
  const longAdded = await recoverOrphans({
    index: idx, loc, nvrId: nvr, beforeMs, since: null,
    call: fakeCall([{ path: E, mtimeMs: Date.UTC(2026, 8, 26, 13, 59, 0), size: 10, keyframes: 90, firstKeyMs: Date.UTC(2026, 8, 26, 12, 0, 0), lastKeyMs: Date.UTC(2026, 8, 26, 12, 40, 0) }])
  })
  check('a file longer than 5 min: end is its last keyframe, not start + 5 min', longAdded[0]?.endMs === Date.UTC(2026, 8, 26, 12, 40, 0), J(longAdded[0]))
  idx.close()
}

// ---- recoverySince: the earliest a left-behind file can have started, per camera
{
  const idx = openRecIndex(join(dir, 'since.db'))
  const beforeMs = Date.UTC(2026, 8, 26, 14, 0, 0)
  const newest = Date.UTC(2026, 8, 26, 13, 30, 0) // this camera's newest indexed start before the crash
  idx.addSegment({ nvr, ch: 0, path: fpath(0, '2026-09-26', '13', '13-30.h264'), startMs: newest, endMs: newest + 60_000, bytes: 1, keyframes: 1, loc: loc.id })
  const lastScan = Date.UTC(2026, 8, 26, 10, 0, 0) // the location's last good scan, earlier still

  const since = recoverySince({ index: idx, nvrId: nvr, beforeMs, opens: [], lastScanMs: lastScan, missed: false })
  check('bound is the newest indexed start less the margin (a switch can open a file a little before it)', since(0) === newest - RECENT_MARGIN_MS, `${since(0)} vs ${newest - RECENT_MARGIN_MS}`)
  check('a camera with no footage and nothing but the scan: the scan time less the margin', since(5) === lastScan - RECENT_MARGIN_MS, `${since(5)}`)

  // an open file the dead worker announced, older than the newest row: it bounds instead
  const opened = Date.UTC(2026, 8, 26, 13, 0, 0)
  const sinceOpen = recoverySince({ index: idx, nvrId: nvr, beforeMs, opens: [{ ch: 0, startMs: opened }], lastScanMs: lastScan, missed: false })
  check('an announced-open file earlier than the newest row pulls the bound back to it', sinceOpen(0) === opened - RECENT_MARGIN_MS, `${sinceOpen(0)}`)

  // missed: the last scan was not the dead worker's start, so the index since says nothing — only the scan bounds
  const sinceMissed = recoverySince({ index: idx, nvrId: nvr, beforeMs, opens: [], lastScanMs: lastScan, missed: true })
  check('a missed scan: only the last-scan time bounds, not what has been indexed since', sinceMissed(0) === lastScan - RECENT_MARGIN_MS, `${sinceMissed(0)}`)

  const sinceNone = recoverySince({ index: idx, nvrId: nvr, beforeMs, opens: [], lastScanMs: null, missed: false })
  check('a camera with no footage, no open file and no scan: no bound (its whole tree is listed)', sinceNone(9) === null, `${sinceNone(9)}`)
  idx.close()
}

// ---- downtimeGaps: a gap row per recording camera from its newest end to atMs
{
  const idx = openRecIndex(join(dir, 'downtime.db'))
  const T = Date.UTC(2026, 8, 26, 13, 0, 0)
  const end0 = T + 60_000
  idx.addSegment({ nvr, ch: 0, path: fpath(0, '2026-09-26', '13', '13-00.h264'), startMs: T, endMs: end0, bytes: 1, keyframes: 1, loc: loc.id })
  idx.addSegment({ nvr, ch: 2, path: fpath(2, '2026-09-26', '13', '13-00.h264'), startMs: T, endMs: end0, bytes: 1, keyframes: 1, loc: loc.id })
  // ch 3 also has a row the NEW worker wrote, starting after the service came back: it is not downtime
  const atMs = end0 + 10_000
  idx.addSegment({ nvr, ch: 3, path: fpath(3, '2026-09-26', '13', '13-00.h264'), startMs: T, endMs: end0, bytes: 1, keyframes: 1, loc: loc.id })
  idx.addSegment({ nvr, ch: 3, path: fpath(3, '2026-09-26', '13', '13-05.h264'), startMs: atMs + 5000, endMs: atMs + 65_000, bytes: 1, keyframes: 1, loc: loc.id })

  const g = downtimeGaps({ index: idx, nvrId: nvr, channels: [0, 1, 3], atMs, reason: 'service restart' })
  const byCh = Object.fromEntries(g.map((r) => [r.ch, r]))
  check('a gap from the newest end to atMs for a recording camera', byCh[0]?.fromMs === end0 && byCh[0]?.toMs === atMs && byCh[0]?.reason === 'service restart', J(byCh[0]))
  check('a camera with no footage gets none', !byCh[1] && !g.some((r) => r.ch === 1))
  check("the new worker's own later row is not counted: the gap ends the downtime, from the old end", byCh[3]?.fromMs === end0 && byCh[3]?.toMs === atMs, J(byCh[3]))

  // a hole shorter than 3 s is not worth a row
  const small = downtimeGaps({ index: idx, nvrId: nvr, channels: [2], atMs: end0 + 1000, reason: 'blip' })
  check('a hole under 3 s: no row', small.length === 0, J(small))
  idx.close()
}

rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
