// Tests for playback from server recordings, phase 3 Task 2:
//   rec-index.mjs   at / next / prev / first / timeline / byPath / segments (none of them scans a
//                   camera's whole history), and the open segments kept in memory
//                   (noteOpen / noteClosed / dropOpen / openOf)
//   segment-writer  'open' event once both files exist; recorder.mjs sends {t:'segopen'};
//                   nvrs.mjs: segopen -> index.noteOpen, segment -> addSegment + noteClosed
//   rec-access.mjs  canPlayServer (admins only for now)
//   rec-api.mjs     timelineApi (GET /api/playback/timeline): the database only, never the NVR
//   playback.mjs    clock() gains skewMs; lastClock()
// Temp dirs, fake NVR objects, the fake SDK and *.invalid hosts only: nothing reaches an NVR.
// Run:  node cctv/test/rec-timeline.test.mjs
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}\n`)
}
const until = async (pred, ms = 8000) => {
  const t = Date.now()
  while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50))
  return pred()
}
const J = (v) => JSON.stringify(v)
/** A module, or {} with a FAIL when it cannot be loaded (so a missing file still reports the rest). */
const load = async (path) => {
  try {
    return await import(path)
  } catch (e) {
    check(`load ${path}`, false, e.message)
    return {}
  }
}

const data = mkdtempSync(join(tmpdir(), 'rec-tl-'))
process.env.DATA_DIR = data
writeFileSync(join(data, 'nvrs.json'), J({ nvrs: [{ id: 'w1', site: 'T', name: 'W1', host: 'w1.invalid', port: 6036, user: 'u', password: 'p' }] }))
process.env.CCTV_WORKER_FAKE_SDK = '1'

const { openRecIndex, OPEN_MAX_MS } = await load('../rec-index.mjs')
const { SegmentWriter, segmentPath } = await load('../segment-writer.mjs')
const { Recorder } = await load('../recorder.mjs')
const { canPlayServer } = await load('../rec-access.mjs')
const { timelineApi } = await load('../rec-api.mjs')
const pb = await load('../playback.mjs')

const M = 60_000
const H = 60 * M
const T0 = Date.UTC(2026, 8, 24, 10, 0, 0)
const seg = (nvr, ch, name, startMs, endMs, ext = 'h264') => ({ nvr, ch, path: `/r/${nvr}/${ch}/2026-09-24/10/${name}.${ext}`, startMs, endMs, bytes: 1000, keyframes: 30, loc: 'L1' })
const pathOf = (s) => s?.path ?? null

// ---- index lookups on a temp DB
const idx = openRecIndex(join(data, 'tl.db'))
// camera n1/3: three contiguous 1-minute files (40 ms apart), then one after a 5-minute gap (H.265)
const a = seg('n1', 3, '10-00', T0, T0 + M - 40)
const b = seg('n1', 3, '10-01', T0 + M, T0 + 2 * M - 40)
const c = seg('n1', 3, '10-02', T0 + 2 * M, T0 + 3 * M - 40)
const d = seg('n1', 3, '10-08', T0 + 8 * M, T0 + 9 * M - 40, 'h265')
for (const s of [c, a, d, b]) idx.addSegment(s) // the order rows arrive in does not matter
// other cameras and NVRs must not leak in
idx.addSegment(seg('n1', 4, '10-00', T0, T0 + M))
idx.addSegment(seg('n2', 3, '10-00', T0 - M, T0 + 20 * M))
{
  check('at: t equal to a start', pathOf(idx.at('n1', 3, T0)) === a.path, pathOf(idx.at('n1', 3, T0)))
  check('at: t equal to an end', pathOf(idx.at('n1', 3, T0 + M - 40)) === a.path)
  check('at: inside a segment', pathOf(idx.at('n1', 3, T0 + 90_000)) === b.path)
  check('at: the 40 ms seam between two files: no match', idx.at('n1', 3, T0 + M - 20) === null, J(idx.at('n1', 3, T0 + M - 20)))
  check('at: inside a gap, before the first and after the last: no match', idx.at('n1', 3, T0 + 5 * M) === null && idx.at('n1', 3, T0 - 1) === null && idx.at('n1', 3, T0 + 20 * M) === null)
  check('at: only that camera', pathOf(idx.at('n1', 4, T0 + 30_000)) === '/r/n1/4/2026-09-24/10/10-00.h264' && idx.at('n1', 5, T0 + 30_000) === null)
  const row = idx.at('n1', 3, T0 + 10)
  // source and filledMs come from gap backfill; an ordinary recording carries neither.
  check('at: the segment fields, not open', J(row) === J({ nvr: 'n1', ch: 3, path: a.path, startMs: a.startMs, endMs: a.endMs, bytes: 1000, keyframes: 30, loc: 'L1', source: null, filledMs: null }), J(row))
  check('next: after a segment start', pathOf(idx.next('n1', 3, a.startMs)) === b.path && pathOf(idx.next('n1', 3, c.startMs)) === d.path)
  check('next: from a time that is not a start', pathOf(idx.next('n1', 3, T0 + 30_000)) === b.path && pathOf(idx.next('n1', 3, T0 - 1)) === a.path)
  check('next: none after the last', idx.next('n1', 3, d.startMs) === null)
  check('prev: before a segment start', pathOf(idx.prev('n1', 3, b.startMs)) === a.path && pathOf(idx.prev('n1', 3, d.startMs)) === c.path)
  check('prev: none before the first; the last from far ahead', idx.prev('n1', 3, a.startMs) === null && pathOf(idx.prev('n1', 3, T0 + 100 * M)) === d.path)
  check('first: the oldest segment', pathOf(idx.first('n1', 3)) === a.path && idx.first('n9', 0) === null)
  // a restart in the same minute: 10-00.h264 then 10-00-2.h264 (by name "-2" sorts first; by time it is second)
  const e = seg('n1', 5, '10-00', T0, T0 + 20_000)
  const f = seg('n1', 5, '10-00-2', T0 + 30_000, T0 + M + 2000)
  idx.addSegment(f)
  idx.addSegment(e)
  check('-2 suffix file: ordered by start_ms (first, next, prev)', pathOf(idx.first('n1', 5)) === e.path && pathOf(idx.next('n1', 5, e.startMs)) === f.path && pathOf(idx.prev('n1', 5, f.startMs)) === e.path)
  check('-2 suffix file: at() finds each', pathOf(idx.at('n1', 5, T0 + 10_000)) === e.path && pathOf(idx.at('n1', 5, T0 + 40_000)) === f.path && idx.at('n1', 5, T0 + 25_000) === null)
}

// ---- byPath and segments (one camera's rows by path / overlapping a range)
{
  check('byPath: a segment by its path: the same fields as at()', J(idx.byPath?.(b.path)) === J(idx.at('n1', 3, T0 + 90_000)), J(idx.byPath?.(b.path)))
  check('byPath: an unknown path: null', idx.byPath?.('/r/n1/3/2026-09-24/10/10-05.h264') === null)
  const paths = (rs) => rs.map((r) => r.path).join()
  check('segments: the rows overlapping [from, to], oldest first; ends and starts inclusive', paths(idx.segments('n1', 3, T0 + 30_000, T0 + 2 * M)) === [a, b, c].map((s) => s.path).join() && paths(idx.segments('n1', 3, T0 + M - 40, T0 + M - 40)) === a.path, paths(idx.segments('n1', 3, T0 + 30_000, T0 + 2 * M)))
  check('segments: the 40 ms seam and a gap: none; the whole camera: all four', idx.segments('n1', 3, T0 + M - 20, T0 + M - 20).length === 0 && idx.segments('n1', 3, T0 + 5 * M, T0 + 6 * M).length === 0 && idx.segments('n1', 3, 0, T0 + H).length === 4)
}

// ---- timeline
{
  idx.addGap({ nvr: 'n1', ch: 3, fromMs: c.endMs, toMs: d.startMs, reason: 'no video from the NVR' })
  idx.addGap({ nvr: 'n1', ch: 3, fromMs: T0 - 30 * M, toMs: T0 - 29 * M, reason: 'location not writable: /x' })
  idx.addGap({ nvr: 'n1', ch: 4, fromMs: T0 + 3 * M, toMs: T0 + 4 * M, reason: 'another camera' })
  idx.addGap({ nvr: 'n1', ch: 3, fromMs: T0 + 5 * H, toMs: T0 + 6 * H, reason: 'outside the window' })
  const tl = idx.timeline('n1', 3, T0 - H, T0 + H, T0 + H)
  check('timeline: three contiguous segments + one after a 5-minute gap = 2 ranges', J(tl.ranges) === J([[a.startMs, c.endMs], [d.startMs, d.endMs]]), J(tl.ranges))
  check('timeline: gap rows with their reasons (that camera, that window)', J(tl.gaps) === J([[T0 - 30 * M, T0 - 29 * M, 'location not writable: /x'], [c.endMs, d.startMs, 'no video from the NVR']]), J(tl.gaps))
  check('timeline: codec from the newest segment\'s extension', tl.codec === 'h265', tl.codec)
  const clipped = idx.timeline('n1', 3, T0 + 30_000, T0 + 8 * M + 30_000, T0 + H)
  check('timeline: ranges clipped to the window', J(clipped.ranges) === J([[T0 + 30_000, c.endMs], [d.startMs, T0 + 8 * M + 30_000]]), J(clipped.ranges))
  check('timeline: codec of the newest segment in the window', idx.timeline('n1', 3, T0, T0 + 3 * M, T0 + H).codec === 'h264')
  const none = idx.timeline('n1', 3, T0 + 4 * H, T0 + 5 * H - 1, T0 + 6 * H)
  check('timeline: nothing in the window: no ranges; codec from the camera\'s newest segment', none.ranges.length === 0 && none.codec === 'h265', J(none))
  check('timeline: a camera with nothing: no ranges, codec null', J(idx.timeline('n9', 0, T0, T0 + H, T0 + H)) === J({ ranges: [], gaps: [], codec: null }))
  // joined within 2000 ms, not beyond
  idx.addSegment(seg('n1', 6, '10-00', T0, T0 + 10_000))
  idx.addSegment(seg('n1', 6, '10-00-2', T0 + 12_000, T0 + 20_000))
  idx.addSegment(seg('n1', 6, '10-00-3', T0 + 22_500, T0 + 30_000))
  check('timeline: segments 2000 ms apart are one range, 2500 ms apart are two', J(idx.timeline('n1', 6, T0 - M, T0 + M, T0 + H).ranges) === J([[T0, T0 + 20_000], [T0 + 22_500, T0 + 30_000]]), J(idx.timeline('n1', 6, T0 - M, T0 + M, T0 + H).ranges))
  // a long history: the day's request stays quick
  const many = openRecIndex(join(data, 'many.db'))
  const DAY0 = Date.UTC(2026, 7, 1)
  for (let i = 0; i < 30 * 1440; i++) many.addSegment({ nvr: 'm', ch: 0, path: `/m/${i}.h264`, startMs: DAY0 + i * M, endMs: DAY0 + (i + 1) * M - 40, bytes: 1, keyframes: 1, loc: 'L' })
  const day = DAY0 + 29 * 1440 * M
  const after = DAY0 + 30 * 1440 * M + 10 * M // 10 minutes after the newest file: a gap with 30 days of rows before it
  const t1 = performance.now()
  const big = many.timeline('m', 0, day, day + 1440 * M, day + 2000 * M)
  const inGap = [...Array(50)].map(() => many.at('m', 0, after))
  const took = performance.now() - t1
  check('timeline: 30 days of 1-minute files: the last day is one range; it and 50 lookups in a gap take under 100 ms', big.ranges.length === 1 && inGap.every((x) => x === null) && took < 100, `${took.toFixed(1)} ms`)
  // the newest file by its path (playback, once the file it follows is closed) and by a time range: never a scan
  // of the camera's whole history (the main process's event loop)
  const newestPath = `/m/${30 * 1440 - 1}.h264`
  const newestStart = DAY0 + (30 * 1440 - 1) * M
  const t2 = performance.now()
  const byPath = typeof many.byPath === 'function' ? [...Array(50)].map(() => many.byPath(newestPath)) : []
  const tookPath = performance.now() - t2
  const t3 = performance.now()
  const ranged = [...Array(50)].map(() => many.segments('m', 0, newestStart, newestStart))
  const tookRange = performance.now() - t3
  check('byPath: 30 days of 1-minute files: 50 lookups of the newest file take under 50 ms', byPath.length === 50 && byPath.every((r) => r?.path === newestPath && r.startMs === newestStart) && tookPath < 50, `${byPath.length ? tookPath.toFixed(1) : '-'} ms`)
  check('segments(t, t): 30 days of 1-minute files: 50 lookups at the newest file take under 50 ms (bounded like at())', ranged.every((rs) => rs.length === 1 && rs[0].path === newestPath) && tookRange < 50, `${tookRange.toFixed(1)} ms`)
  many.close()
}

// ---- open segments (in memory only)
{
  const openPath = '/r/n1/3/2026-09-24/10/10-09.h265'
  const openStart = d.endMs + 40
  check('openOf: nothing open yet', idx.openOf('n1', 3) === null)
  idx.noteOpen({ nvr: 'n1', ch: 3, path: openPath, startMs: openStart, loc: 'L1' })
  check('noteOpen -> openOf', idx.openOf('n1', 3)?.path === openPath && idx.openOf('n1', 3)?.startMs === openStart, J(idx.openOf('n1', 3)))
  const o = idx.at('n1', 3, openStart + 5000)
  check('at(t >= open start): the open segment, open:true, no end yet', o?.path === openPath && o.open === true && o.startMs === openStart && o.endMs === null && o.loc === 'L1' && o.nvr === 'n1' && o.ch === 3, J(o))
  check('at: an indexed row still wins before the open segment', idx.at('n1', 3, d.endMs)?.path === d.path)
  check('at: before the open segment (in a gap): no match', idx.at('n1', 3, T0 + 5 * M) === null)
  check('next: the open segment after the newest row', idx.next('n1', 3, d.startMs)?.path === openPath && idx.next('n1', 3, d.startMs)?.open === true)
  check('prev: the newest row before the open segment', idx.prev('n1', 3, openStart)?.path === d.path)
  const now = openStart + 30_000
  const tl = idx.timeline('n1', 3, T0 - H, T0 + H, now)
  check('timeline: the open segment extends the last range to now', J(tl.ranges) === J([[a.startMs, c.endMs], [d.startMs, now]]), J(tl.ranges))
  check('timeline: ... clipped to the window', idx.timeline('n1', 3, T0, openStart + 10_000, now).ranges.at(-1)[1] === openStart + 10_000)
  check('timeline: the open segment is the newest for the codec', idx.timeline('n1', 3, openStart, openStart + 10_000, now).codec === 'h265')
  // an older file's segopen arriving late (a location switch) does not replace the newer one
  idx.noteOpen({ nvr: 'n1', ch: 3, path: '/r/n1/3/old.h264', startMs: openStart - 1000, loc: 'L2' })
  check('noteOpen: an older file does not replace the newer open one', idx.openOf('n1', 3)?.path === openPath)
  idx.noteClosed('/r/n1/3/old.h264')
  check('noteClosed of another path leaves the open one', idx.openOf('n1', 3)?.path === openPath)
  // the matching segment (nvrs.mjs: addSegment + noteClosed) clears it
  idx.addSegment({ nvr: 'n1', ch: 3, path: openPath, startMs: openStart, endMs: openStart + 59_000, bytes: 5, keyframes: 30, loc: 'L1' })
  idx.noteClosed(openPath)
  check('the matching segment clears it: openOf null, at() gives the row', idx.openOf('n1', 3) === null && idx.at('n1', 3, openStart + 5000)?.open === undefined && idx.at('n1', 3, openStart + 5000)?.endMs === openStart + 59_000)
  // dropOpen: only that NVR
  idx.noteOpen({ nvr: 'w1', ch: 0, path: '/w1/0/a.h264', startMs: T0, loc: 'L1' })
  idx.noteOpen({ nvr: 'w1', ch: 1, path: '/w1/1/a.h264', startMs: T0, loc: 'L1' })
  idx.noteOpen({ nvr: 'w2', ch: 0, path: '/w2/0/a.h264', startMs: T0, loc: 'L1' })
  idx.dropOpen('w1')
  check("dropOpen('w1') clears only that NVR's entries", idx.openOf('w1', 0) === null && idx.openOf('w1', 1) === null && idx.openOf('w2', 0)?.path === '/w2/0/a.h264')
  check('first: a camera with only an open segment', idx.first('w2', 0)?.path === '/w2/0/a.h264' && idx.first('w2', 0)?.open === true)
  check('timeline: a camera with only an open segment', J(idx.timeline('w2', 0, T0 - M, T0 + M, T0 + 20_000).ranges) === J([[T0, T0 + 20_000]]))
  // a file left open that no longer grows (writer failed, NVR offline): it counts only OPEN_MAX_MS
  const stale = idx.timeline('w2', 0, T0 - M, T0 + 2 * H, T0 + H)
  check('timeline: an open segment older than OPEN_MAX_MS is not stretched to now', typeof OPEN_MAX_MS === 'number' && OPEN_MAX_MS >= 2 * M && J(stale.ranges) === J([[T0, T0 + OPEN_MAX_MS]]), J(stale.ranges))
  check('at: ... nor found far past its start', idx.at('w2', 0, T0 + H) === null && idx.at('w2', 0, T0 + 10_000)?.open === true)
  idx.dropOpen('w2')
  idx.close()
}

// ---- segment-writer 'open' event
{
  const root = mkdtempSync(join(tmpdir(), 'tl-w-'))
  const w = new SegmentWriter({ root, nvrId: 'n1', ch: 0, codec: 'h264' })
  const opens = []
  w.on('open', (o) => opens.push({ ...o, files: existsSync(o.path) && existsSync(`${o.path}.idx`) }))
  const t = Date.UTC(2026, 8, 24, 11, 0, 5)
  w.write(Buffer.from([0, 0, 0, 1, 0x65, 1]), { isKey: true, ts: t })
  check("writer: 'open' is not emitted synchronously (the files do not exist yet)", opens.length === 0)
  await w.drained()
  check("writer: 'open' with the real path and the start once both files exist", opens.length === 1 && opens[0].path === segmentPath(root, 'n1', 0, t, 'h264') && opens[0].startMs === t && opens[0].files === true, J(opens))
  check("writer: 'open' carries only path and startMs", J(Object.keys(opens[0] ?? {}).sort()) === J(['files', 'path', 'startMs']))
  const s1 = await w.close()
  w.write(Buffer.from([0, 0, 0, 1, 0x65, 2]), { isKey: true, ts: t + 500 })
  const s2 = await w.close()
  check("writer: same minute again: 'open' names the -2 file, as the segment does", opens.length === 2 && /11-00-2\.h264$/.test(opens[1].path) && opens[1].path === s2?.path && s1?.path === opens[0].path, J(opens.map((x) => x.path)))
  // a slow open: nothing until both files are created
  let release
  const gate = new Promise((r) => (release = r))
  const slowFs = { mkdir: (p, o) => fsp.mkdir(p, o), open: async (p, fl) => (await gate, fsp.open(p, fl)) }
  const ws = new SegmentWriter({ root: mkdtempSync(join(tmpdir(), 'tl-ws-')), nvrId: 'n1', ch: 1, fs: slowFs })
  const slowOpens = []
  ws.on('open', (o) => slowOpens.push(o))
  ws.write(Buffer.from([0, 0, 0, 1, 0x65]), { isKey: true, ts: t })
  await new Promise((r) => setTimeout(r, 30))
  check("writer: slow disk: no 'open' while the file is still being created", slowOpens.length === 0)
  release()
  await ws.drained()
  check("writer: slow disk: 'open' once it is", slowOpens.length === 1)
  await ws.close()
  // mkdir fails (the root is a file): 'error', no 'open'
  const blockedRoot = join(mkdtempSync(join(tmpdir(), 'tl-wf-')), 'ro')
  writeFileSync(blockedRoot, 'not a folder')
  const wf = new SegmentWriter({ root: blockedRoot, nvrId: 'n1', ch: 2 })
  const fOpens = []
  const fErrs = []
  wf.on('open', (o) => fOpens.push(o))
  wf.on('error', (e) => fErrs.push(e))
  wf.write(Buffer.from([0, 0, 0, 1, 0x65]), { isKey: true, ts: t })
  await wf.drained()
  check("writer: mkdir fails: 'error' and no 'open'", fOpens.length === 0 && fErrs.length === 1, `${fOpens.length} opens, ${fErrs.length} errors`)
  // the .idx cannot be created: no 'open' either
  const noIdxFs = { mkdir: (p, o) => fsp.mkdir(p, o), open: async (p, fl) => { if (p.endsWith('.idx')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fsp.open(p, fl) } }
  const wi = new SegmentWriter({ root: mkdtempSync(join(tmpdir(), 'tl-wi-')), nvrId: 'n1', ch: 3, fs: noIdxFs })
  const iOpens = []
  wi.on('open', (o) => iOpens.push(o))
  wi.on('error', () => {})
  wi.write(Buffer.from([0, 0, 0, 1, 0x65]), { isKey: true, ts: t })
  await wi.drained()
  check("writer: the .idx cannot be created: no 'open'", iOpens.length === 0)
  // a throwing 'open' listener does not break the writer
  const wt = new SegmentWriter({ root: mkdtempSync(join(tmpdir(), 'tl-wt-')), nvrId: 'n1', ch: 4 })
  const warn = console.warn
  console.warn = () => {}
  wt.on('open', () => { throw new Error('listener bug') })
  wt.write(Buffer.from([0, 0, 0, 1, 0x65]), { isKey: true, ts: t })
  wt.write(Buffer.from([0, 0, 0, 1, 0x41]), { isKey: false, ts: t + 40 })
  const st = await wt.close()
  console.warn = warn
  check("writer: a throwing 'open' listener does not stop the file", st?.bytes === 10, J(st))
}

// ---- recorder: {t:'segopen'}
{
  const fakeStream = () => ({ clients: new Set(), add(x) { this.clients.add(x) }, remove(x) { this.clients.delete(x) } })
  const wire = (isKey, codec, payload) => {
    const buf = Buffer.alloc(16 + payload.length)
    buf[0] = isKey ? 1 : 0
    buf[1] = codec
    payload.copy(buf, 16)
    return buf
  }
  const streams = new Map()
  const sent = []
  let now = Date.UTC(2026, 8, 24, 12, 0, 57)
  const rec = new Recorder({ nvrId: 'n1', getStream: (ch) => streams.get(ch) ?? streams.set(ch, fakeStream()).get(ch), online: () => true, channels: () => [0, 1], send: (m) => sent.push(m), now: () => now, writerOpts: { rollOffsetMs: 0 } }) // (roll at the minute; staggering: segment-rollover.test.mjs)
  const path = mkdtempSync(join(tmpdir(), 'tl-rec-'))
  writeFileSync(join(path, '.cctv-recordings'), J({ id: 'LR' }))
  const L = { id: 'LR', path, type: 'usb', role: 'main', limitGB: null }
  const DEFAULTS = { mode: 'off', fullDays: 30, after: 'timelapse', timelapseS: 10, retentionDays: 183, preS: 10, postS: 20 }
  rec.apply({ recording: { defaults: DEFAULTS, cameras: { 'n1/1': { mode: 'continuous' } } }, locations: [L] })
  const tap = [...streams.get(1).clients][0]
  const t0 = now
  tap.send(wire(true, 0, Buffer.from([0, 0, 0, 1, 0x65, 1])))
  await rec.idle()
  const so = sent.filter((m) => m.t === 'segopen')
  check("recorder: sends {t:'segopen', nvr, ch, path, startMs, loc} once the file is created", so.length === 1 && J(so[0]) === J({ t: 'segopen', nvr: 'n1', ch: 1, path: segmentPath(path, 'n1', 1, t0, 'h264'), startMs: t0, loc: 'LR' }) && existsSync(so[0].path), J(so))
  for (let i = 1; i <= 5; i++) {
    now += 1000
    tap.send(wire(i % 2 === 0, 0, Buffer.from([0, 0, 0, 1, i % 2 === 0 ? 0x65 : 0x41, i])))
    await rec.idle()
  }
  const order = sent.filter((m) => m.t === 'segopen' || m.t === 'segment').map((m) => `${m.t}:${m.path.slice(-10)}`)
  check('recorder: at a rollover, the old file\'s segment comes before the new file\'s segopen', order.length === 3 && order[1].startsWith('segment:') && order[2].startsWith('segopen:') && order[2] !== `segopen:${so[0].path.slice(-10)}`, J(order))
  await rec.stop()
}

// ---- rec-access
{
  check('canPlayServer: admin', canPlayServer?.({ user: 'a', admin: true }, 'n1', 0) === true)
  check('canPlayServer: not for a viewer, null or undefined', canPlayServer?.({ user: 'v', admin: false }, 'n1', 0) === false && canPlayServer?.(null, 'n1', 0) === false && canPlayServer?.(undefined, 'n1', 0) === false)
}

// ---- timelineApi (never calls the NVR)
{
  const ti = openRecIndex(join(data, 'api.db'))
  ti.addSegment(seg('n1', 2, '10-00', T0, T0 + M - 40))
  ti.addSegment(seg('n1', 2, '10-01', T0 + M, T0 + 2 * M - 40))
  ti.addSegment(seg('n1', 2, '10-05', T0 + 5 * M, T0 + 6 * M - 40))
  ti.addGap({ nvr: 'n1', ch: 2, fromMs: T0 + 2 * M - 40, toMs: T0 + 5 * M, reason: 'no video from the NVR' })
  let calls = 0
  const fakeNvr = (over = {}) => ({
    id: 'n1',
    name: 'N1',
    online: true,
    degraded: false,
    playback: {
      clock: () => { calls++; throw new Error('the NVR must not be called') },
      recordings: () => { calls++; throw new Error('the NVR must not be called') },
      recordDates: () => { calls++; throw new Error('the NVR must not be called') },
      lastClock: () => ({ tzOffsetMs: -4 * H, skewMs: 220_000, at: Date.now() - 5000 })
    },
    ...over
  })
  const admin = { user: 'boss', admin: true }
  const viewer = { user: 'guard', admin: false }
  const q = (s) => new URLSearchParams(s)
  const api = (params, over = {}) => timelineApi?.({ nvr: fakeNvr(), params: q(params), who: admin, index: ti, now: T0 + H, ...over }) ?? [0, {}]
  const win = `ch=2&from=${T0 - M}&to=${T0 + H}`
  check('timelineApi: unknown NVR -> 404', api(win, { nvr: undefined })[0] === 404)
  const bad = ['from=1&to=2', 'ch=x&from=1&to=2', 'ch=-1&from=1&to=2', 'ch=2&to=2', 'ch=2&from=1', 'ch=2&from=a&to=2', `ch=2&from=${T0}&to=${T0}`, `ch=2&from=${T0}&to=${T0 - 1}`, `ch=2&from=${T0}&to=${T0 + 48 * H + 1}`]
  const codes = bad.map((p) => api(p)[0])
  check('timelineApi: bad ch/from/to, to <= from, over 48 h -> 400', codes.every((s) => s === 400), codes.join())
  check('timelineApi: exactly 48 h is fine', api(`ch=2&from=${T0}&to=${T0 + 48 * H}`)[0] === 200)
  check('timelineApi: index null (flag off) -> available:false', J(api(win, { index: null })) === J([200, { available: false }]))
  check('timelineApi: a viewer -> available:false', J(api(win, { who: viewer })) === J([200, { available: false }]))
  check('timelineApi: no who -> available:false', J(api(win, { who: undefined })) === J([200, { available: false }]))
  check('timelineApi: a camera without segments -> available:false', J(api(`ch=7&from=${T0}&to=${T0 + H}`)) === J([200, { available: false }]))
  const [st, body] = api(win)
  check('timelineApi: admin gets now, tzOffsetMs, skewMs, firstMs, codec, ranges, gaps', st === 200 && J(body) === J({ available: true, now: T0 + H, tzOffsetMs: -4 * H, skewMs: 220_000, firstMs: T0, codec: 'h264', ranges: [[T0, T0 + 2 * M - 40], [T0 + 5 * M, T0 + 6 * M - 40]], gaps: [[T0 + 2 * M - 40, T0 + 5 * M, 'no video from the NVR']] }), J(body))
  const [, noClock] = api(win, { nvr: fakeNvr({ playback: { ...fakeNvr().playback, lastClock: () => null } }) })
  check('timelineApi: NVR clock never read: tzOffsetMs null, skewMs 0', noClock.tzOffsetMs === null && noClock.skewMs === 0, J(noClock))
  const [offSt, offBody] = api(win, { nvr: fakeNvr({ online: false, degraded: true }) })
  check('timelineApi: offline NVR: still 200 with the ranges', offSt === 200 && offBody.available === true && offBody.ranges.length === 2, `${offSt} ${J(offBody)}`)
  check('timelineApi: the NVR was never called', calls === 0, `${calls} calls`)
  ti.noteOpen({ nvr: 'n1', ch: 2, path: '/r/n1/2/2026-09-24/10/10-06.h264', startMs: T0 + 6 * M, loc: 'L1' })
  const [, withOpen] = api(`ch=2&from=${T0}&to=${T0 + H}`, { now: T0 + 6 * M + 30_000 })
  check('timelineApi: the open segment reaches now', withOpen.ranges.at(-1)?.[1] === T0 + 6 * M + 30_000 && withOpen.now === T0 + 6 * M + 30_000, J(withOpen.ranges))
  ti.close()
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const route = src.indexOf("'/api/playback/timeline'")
  const generic = src.indexOf("pathname.startsWith('/api/playback/')")
  check('server.mjs: the timeline route comes before the generic /api/playback/ branch', route > 0 && generic > 0 && route < generic && /timelineApi\(/.test(src))
}

// ---- playback.mjs clock(): skewMs, lastClock()
{
  const { createPlayback, playbackApi, toDD } = pb
  /** A fake NVR whose lane answers GetDeviceTime with a local wall clock `offset` ms from ours. */
  const clockNvr = (offset) => {
    const nvr = { id: `ck${offset}`, name: 'CK', userId: 7, online: true, degraded: false, jobs: 0 }
    nvr.lane = { run: async () => (nvr.jobs++, typeof offset === 'number' ? toDD(Date.now() + offset) : offset) }
    nvr.playback = createPlayback(nvr)
    return nvr
  }
  const tz = -4 * H
  const fast = clockNvr(tz + 220_000) // nvr1: about 3 min 40 s fast
  check('lastClock(): null before any clock read', fast.playback.lastClock?.() === null)
  const c1 = await fast.playback.clock()
  check('clock(): tzOffsetMs as before and skewMs = NVR clock - server clock', c1.tzOffsetMs === tz && c1.skewMs > 218_900 && c1.skewMs <= 220_000 && Math.abs(c1.now - Date.now() - c1.skewMs) < 100, J(c1))
  const lc = fast.playback.lastClock?.()
  check('lastClock(): { tzOffsetMs, skewMs, at } after a call', lc?.tzOffsetMs === tz && lc.skewMs === c1.skewMs && Math.abs(lc.at - Date.now()) < 1000 && J(Object.keys(lc).sort()) === J(['at', 'skewMs', 'tzOffsetMs']), J(lc))
  const slow = await clockNvr(tz - 220_000).playback.clock()
  check('clock(): a slow NVR clock gives a negative skew', slow.tzOffsetMs === tz && slow.skewMs < -219_000 && slow.skewMs >= -221_100, J(slow))
  const five = await clockNvr(5000).playback.clock()
  check('clock(): 5 s is kept', five.tzOffsetMs === 0 && five.skewMs > 3900 && five.skewMs <= 5000, J(five))
  const small = [await clockNvr(tz + 1000).playback.clock(), await clockNvr(-500).playback.clock(), await clockNvr(0).playback.clock()]
  check('clock(): under 2 s (DD_TIME has 1 s steps) -> skewMs 0', small.every((x) => x.skewMs === 0), J(small))
  const failing = clockNvr(false)
  const err = await failing.playback.clock().catch((e) => e)
  check('clock(): a failed read throws and leaves lastClock() null', err instanceof Error && /GetDeviceTime failed/.test(err.message) && failing.playback.lastClock() === null, err?.message)
  const [s, nowBody] = await playbackApi(clockNvr(tz + 220_000), '/api/playback/now', new URLSearchParams())
  check('/api/playback/now carries skewMs too', s === 200 && typeof nowBody.now === 'number' && nowBody.tzOffsetMs === tz && nowBody.skewMs > 218_900, J(nowBody))
}

// ---- the app: nvrs.mjs (CCTV_LIVE_WORKER=on) keeps the open segment from the worker's segopen
{
  const path = mkdtempSync(join(tmpdir(), 'tl-app-'))
  writeFileSync(join(path, '.cctv-recordings'), J({ id: 'LA', created: new Date().toISOString() }))
  const L = { id: 'LA', path, type: 'usb', role: 'main', limitGB: null }
  const DEFAULTS = { mode: 'off', fullDays: 30, after: 'timelapse', timelapseS: 10, retentionDays: 183, preS: 10, postS: 20 }
  writeFileSync(join(data, 'settings.json'), J({ recording: { defaults: DEFAULTS, cameras: { 'w1/2': { mode: 'continuous' } } }, storage: { locations: [L], lowFreePct: 15, floorFreePct: 5 } }))
  process.env.CCTV_LIVE_WORKER = 'on'
  await import('./fake-sdk.mjs')
  const { startNvrs, stopNvrs, recIndex } = await import('../nvrs.mjs')
  const { saveSettings } = await import('../settings.mjs')
  const realLog = console.log
  console.log = () => {}
  const realWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => (/^(PASS|FAIL|SKIP|\n)/.test(String(chunk)) ? realWrite(chunk, ...rest) : true)
  startNvrs()
  check('app: the worker\'s segopen reaches the index (openOf)', await until(() => recIndex()?.openOf('w1', 2) != null, 10_000))
  const open = recIndex()?.openOf('w1', 2)
  check('app: the open entry names the file being written on the location', open && open.path.startsWith(path) && existsSync(open.path) && open.loc === 'LA' && !recIndex().has(open.path), J(open))
  const at = recIndex()?.at('w1', 2, Date.now())
  check('app: at(now) gives the open segment', at?.open === true && at.path.startsWith(path), J(at))
  const tl = recIndex()?.timeline('w1', 2, Date.now() - M, Date.now() + 1000, Date.now())
  check('app: the timeline shows the open segment up to now', tl?.ranges.length === 1 && tl.codec === 'h264', J(tl))
  const last = recIndex()?.openOf('w1', 2)?.path
  saveSettings({ recording: { cameras: { 'w1/2': { mode: 'off' } } } }, 'test')
  check('app: recording off: the segment is indexed and the open entry cleared', await until(() => recIndex()?.openOf('w1', 2) === null && recIndex().has(last), 10_000), J(recIndex()?.openOf('w1', 2)))
  await stopNvrs()
  process.stdout.write = realWrite
  console.log = realLog
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
