// Tests for crash recovery (rec-recover.mjs): segment files left open by a dead worker get an
// index row, so housekeeping can delete them. Temp dirs only.  node cctv/test/rec-recover.test.mjs
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const data = mkdtempSync(join(tmpdir(), 'cctv-recover-'))
process.env.DATA_DIR = data
const { recoverOrphans } = await import('../rec-recover.mjs')
const { openRecIndex } = await import('../rec-index.mjs')
const { segmentPath, SegmentWriter } = await import('../segment-writer.mjs')
const { runHousekeeping } = await import('../housekeeping.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const root = mkdtempSync(join(tmpdir(), 'rec-loc-'))
writeFileSync(join(root, '.cctv-recordings'), '{"id":"L1"}') // housekeeping only touches a location with its marker
const loc = { id: 'L1', path: root, type: 'usb', role: 'main', limitGB: null }
const index = openRecIndex(join(data, 'recordings.db'))
const idxRows = (rows) => {
  const b = Buffer.alloc(rows.length * 16)
  rows.forEach(([off, ts], i) => { b.writeBigUInt64LE(BigInt(off), i * 16); b.writeBigInt64LE(BigInt(ts), i * 16 + 8) })
  return b
}
const put = (path, bytes, mtimeMs, idx) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes, 1))
  if (idx) writeFileSync(`${path}.idx`, idx)
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
}

const start = Date.UTC(2026, 7, 1, 9, 30, 0) // two months ago (older than a 30-day retention)
const workerStart = Date.now()
// 1. a normal, indexed segment
const indexed = segmentPath(root, 'n1', 3, start, 'h265')
put(indexed, 100, start + 60_000, idxRows([[0, start]]))
index.addSegment({ nvr: 'n1', ch: 3, path: indexed, startMs: start, endMs: start + 59_000, bytes: 100, keyframes: 1, loc: 'L1' })
// 2. left open by a crash: .idx with 3 keyframes, last write 42 s after its first frame
const t2 = start + 60_000 + 2000
const crashed = segmentPath(root, 'n1', 3, t2, 'h265')
put(crashed, 5000, t2 + 42_000, idxRows([[0, t2], [1500, t2 + 20_000], [3000, t2 + 40_000]]))
// 3. crashed between the two opens: no .idx; the name gives the start
const t3 = Date.UTC(2026, 7, 1, 9, 45, 0)
const noIdx = segmentPath(root, 'n1', 0, t3 + 7000, 'h264')
put(noIdx, 0, t3 + 7000)
// 4. a suffixed file ("same minute again") also left open
const suffixed = segmentPath(root, 'n1', 3, t2, 'h265').replace(/\.h265$/, '-2.h265')
put(suffixed, 10, t2 + 5000, idxRows([[0, t2 + 1000]]))
// 5. an .idx whose last row is a torn (partial) write, a row past the file end is ignored
const t5 = Date.UTC(2026, 7, 1, 10, 5, 0)
const torn = segmentPath(root, 'n1', 7, t5, 'h264')
put(torn, 200, t5 + 30_000, Buffer.concat([idxRows([[0, t5], [150, t5 + 10_000], [900, t5 + 20_000]]), Buffer.alloc(7)]))
// 6. written after the new worker started (maybe the new worker's own file): left alone
const fresh = segmentPath(root, 'n1', 3, Date.now(), 'h265')
put(fresh, 10, workerStart + 5000, idxRows([[0, Date.now()]]))
// 7. not a segment / another NVR's folder / junk names: left alone
put(join(root, 'n1', '3', '2026-08-01', '09', 'notes.txt'), 3, start)
put(join(root, 'n1', '3', '2026-08-01', '09', '10-00.h264'), 3, start) // hour in the name does not match the folder
const other = segmentPath(root, 'n2', 0, start, 'h264')
put(other, 10, start + 1000)

const added = await recoverOrphans({ index, loc, nvrId: 'n1', beforeMs: workerStart })
const by = (p) => added.find((a) => a.path === p)
check('recovers exactly the orphaned segment files of this NVR', added.length === 4 && by(crashed) && by(noIdx) && by(suffixed) && by(torn), added.map((a) => a.path.slice(root.length)).join(' '))
check('the indexed file is not touched again', !by(indexed) && index.segments('n1', 3, 0, 1e15).filter((s) => s.path === indexed).length === 1)
check('files newer than the worker start are left alone', !by(fresh) && !index.has(fresh))
check('other NVRs and junk names are left alone', !index.has(other) && added.every((a) => /\.(h264|h265)$/.test(a.path)))
const c = by(crashed)
check('crashed file: start from the first .idx row, end from its last write, bytes kept', c && c.startMs === t2 && c.endMs === t2 + 42_000 && c.bytes === 5000 && c.keyframes === 3 && c.ch === 3 && c.nvr === 'n1' && c.loc === 'L1', JSON.stringify(c))
const n = by(noIdx)
check('no .idx: start from the file name, 0 keyframes, end = last write', n && n.startMs === t3 && n.endMs === t3 + 7000 && n.keyframes === 0 && n.bytes === 0 && n.ch === 0, JSON.stringify(n))
const t = by(torn)
check('torn .idx: partial row ignored, rows past the end ignored', t && t.keyframes === 2 && t.startMs === t5 && t.endMs === t5 + 30_000, JSON.stringify(t))
check('rows land in the index', index.has(crashed) && index.has(noIdx) && index.has(suffixed) && index.has(torn))
const again = await recoverOrphans({ index, loc, nvrId: 'n1', beforeMs: workerStart })
check('a second scan finds nothing new', again.length === 0)
check('a missing location folder is no error', (await recoverOrphans({ index, loc: { id: 'X', path: join(root, 'nope') }, nvrId: 'n1', beforeMs: workerStart })).length === 0)

// a file left by a real SegmentWriter that never closed it (the worker was killed)
{
  const w = new SegmentWriter({ root, nvrId: 'n1', ch: 9, codec: 'h264' })
  const t0 = Date.UTC(2026, 7, 2, 8, 0, 3)
  w.write(Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]), { isKey: true, ts: t0 })
  w.write(Buffer.from([0, 0, 0, 1, 0x41, 4]), { isKey: false, ts: t0 + 40 })
  w.write(Buffer.from([0, 0, 0, 1, 0x65, 5]), { isKey: true, ts: t0 + 2000 })
  await w.drained() // written, never closed
  const got = await recoverOrphans({ index, loc, nvrId: 'n1', beforeMs: Date.now() + 1000 })
  check('an unclosed SegmentWriter file: recovered with its keyframes and bytes', got.length === 1 && got[0].startMs === t0 && got[0].keyframes === 2 && got[0].bytes === 20 && got[0].endMs >= t0 + 2000, JSON.stringify(got))
}

// housekeeping can now delete them (retention 30 days: everything above is older)
const settings = {
  recording: { defaults: { mode: 'continuous', fullDays: 7, retentionDays: 30 }, cameras: {} },
  storage: { locations: [loc], lowFreePct: 15, floorFreePct: 5 }
}
const hk = await runHousekeeping({ index, settings, freeOf: () => ({ freeBytes: 90, totalBytes: 100 }) })
check('housekeeping deletes the recovered files and their .idx', [crashed, noIdx, suffixed, torn].every((p) => !existsSync(p) && !existsSync(`${p}.idx`)) && hk.deleted.length >= 5, JSON.stringify(hk.deleted.map((d) => d.path.slice(root.length))))
check('housekeeping leaves the fresh file (not indexed, newer)', existsSync(fresh))
// ---- a 'service down' gap row at startup, from each recording camera's last segment (or gap) to now
{
  const { downtimeGaps } = await import('../rec-recover.mjs')
  const ix = openRecIndex(join(data, 'downtime.db'))
  const T = Date.UTC(2026, 8, 24, 18, 0, 0)
  const seg = (ch, s, e) => ix.addSegment({ nvr: 'd1', ch, path: `/x/d1/${ch}/${s}.h264`, startMs: s, endMs: e, bytes: 1, keyframes: 1, loc: 'L1' })
  seg(1, T, T + 60_000)
  seg(1, T + 60_000, T + 119_500)
  seg(2, T, T + 59_000)
  ix.addGap({ nvr: 'd1', ch: 2, fromMs: T + 59_000, toMs: T + 100_000, reason: 'no video from the NVR' })
  seg(3, T, T + 59_000)
  seg(4, T, T + 298_500) // down for 1.5 s only
  const at = T + 300_000
  const added = downtimeGaps({ index: ix, nvrId: 'd1', channels: [1, 2, 4, 5], atMs: at, reason: 'service down' })
  const g = (ch) => ix.gaps('d1', ch, 0, 1e15)
  check('downtime: a gap row from the last segment\'s end to startup', g(1).length === 1 && g(1)[0].fromMs === T + 119_500 && g(1)[0].toMs === at && g(1)[0].reason === 'service down', JSON.stringify(g(1)))
  check('downtime: starts after the camera\'s last gap row when that is later', g(2).length === 2 && g(2)[1].fromMs === T + 100_000 && g(2)[1].toMs === at, JSON.stringify(g(2)))
  check('downtime: only cameras that record now; none under 3 s; none without footage', g(3).length === 0 && g(4).length === 0 && g(5).length === 0 && added.length === 2, JSON.stringify(added))
  downtimeGaps({ index: ix, nvrId: 'd1', channels: [1, 2], atMs: at + 1000, reason: 'service down' })
  check('downtime: a second start soon after adds nothing (the rows already reach it)', g(1).length === 1 && g(2).length === 2)
  // a worker restart: the new worker's first rows reach the index before the recovery scan is done
  // (its 'recording starting after a restart' row, even a first segment); they are none of the downtime
  {
    const U = T + 3_600_000
    seg(6, U, U + 60_000)
    seg(7, U, U + 60_000)
    const spawned = U + 110_000
    ix.addGap({ nvr: 'd1', ch: 6, fromMs: spawned + 400, toMs: spawned + 9000, reason: 'recording starting after a restart' })
    seg(6, spawned + 9000, spawned + 60_000)
    const got = downtimeGaps({ index: ix, nvrId: 'd1', channels: [6, 7], atMs: spawned, reason: 'recording worker restarted' })
    const down = (ch) => g(ch).filter((r) => r.reason === 'recording worker restarted')
    check('downtime: rows the new worker wrote first do not hide the downtime row', down(6).length === 1 && down(6)[0].fromMs === U + 60_000 && down(6)[0].toMs === spawned, JSON.stringify(g(6)))
    check('downtime: ... the same row as for a camera the new worker has not written yet', down(7).length === 1 && down(7)[0].fromMs === U + 60_000 && got.length === 2, JSON.stringify(got))
    check('index: lastEnds without a bound still gives the newest rows', ix.lastEnds('d1', 6).segEnd === spawned + 60_000 && ix.lastEnds('d1', 6).gapEnd === spawned + 9000)
  }
  ix.close()
}
index.close()

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
