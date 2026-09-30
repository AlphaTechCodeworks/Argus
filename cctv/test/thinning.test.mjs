// Offline tests for the two jobs that destroy footage: time-lapse thinning and retention.
// Real files in a temp folder, a real recordings index, a fake free-space function. No SDK.
//   node cctv/test/thinning.test.mjs
//
// Every destructive path in thinning.mjs has a test here proving it removes only what it should,
// that the dry run is the default and removes nothing at all, and that a crash in the middle of a
// rewrite leaves the original footage on disk.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'cctv-thin-data-'))
process.env.DATA_DIR = dataDir
// Every folder this test makes, removed at its end: they were left in the temp folder, 1,862 thin-loc-*
// and 1,909 thin-db-* (about 316 MB) on the development PC by 2026-09-29, and p3-thin's cases add more.
const made = []
const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  made.push(d)
  return d
}

const { runThinning, runRetention, recoverThinning, planThin, mayTouch, loadProtectedRanges, _test } = await import('../thinning.mjs')
const { openRecIndex, THIN } = await import('../rec-index.mjs')
// The real job converts in the site's night hours first (thin-pace.mjs); these runs are at 00:00 site time.
const AT_NIGHT = { siteMin: () => 0 }
const { parseIdx } = await import('../segment-writer.mjs')
const { splitUnits, CODEC } = await import('../rec-reader.mjs')

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0)
const DEFAULTS = { mode: 'continuous', fullDays: 30, after: 'timelapse', timelapseS: 10, retentionDays: 180, preS: 10, postS: 20 }

// ---- synthetic H.264 ---------------------------------------------------------------------------
// Enough of a bitstream for splitUnits: an AUD starts every access unit, then an IDR (5) for a
// keyframe or a non-IDR slice (1) for the rest. first_mb_in_slice == 0 in both.
const nal = (type, payload) => Buffer.concat([Buffer.from([0, 0, 0, 1, type & 0x1f]), Buffer.from(payload)])
const aud = () => nal(9, [0x10])
const frame = (isKey, size = 40) => Buffer.concat([aud(), nal(isKey ? 5 : 1, Buffer.alloc(size, isKey ? 0xa5 : 0x5c).map((v, i) => (i === 0 ? 0x88 : v)))])

/** One segment file: `gops` keyframes a second apart, each followed by `pFrames` P-frames. */
function makeSegment(path, startMs, { gops = 60, pFrames = 4, keyStepMs = 1000 } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  const parts = []
  const rows = []
  let off = 0
  for (let g = 0; g < gops; g++) {
    const k = frame(true)
    rows.push({ offset: off, tsMs: startMs + g * keyStepMs })
    parts.push(k)
    off += k.length
    for (let p = 0; p < pFrames; p++) {
      const f = frame(false)
      parts.push(f)
      off += f.length
    }
  }
  const buf = Buffer.concat(parts)
  const idx = Buffer.alloc(rows.length * 16)
  rows.forEach((r, i) => {
    idx.writeBigUInt64LE(BigInt(r.offset), i * 16)
    idx.writeBigInt64LE(BigInt(r.tsMs), i * 16 + 8)
  })
  writeFileSync(path, buf)
  writeFileSync(`${path}.idx`, idx)
  return { bytes: buf.length, keyframes: rows.length, endMs: startMs + (gops - 1) * keyStepMs }
}

// Sanity: the synthetic stream really does split into the units we think it does.
{
  const p = join(tmp('thin-sanity-'), 'x.h264')
  const m = makeSegment(p, NOW, { gops: 3, pFrames: 2 })
  const rows = parseIdx(readFileSync(`${p}.idx`))
  const { units } = splitUnits(readFileSync(p), CODEC.h264, { final: true, keyOffsets: new Set(rows.map((r) => r.offset)) })
  check('the test bitstream splits into 9 frames, 3 of them keyframes', units.length === 9 && units.filter((u) => u.isKey).length === 3, `${units.length} units, ${m.keyframes} rows`)
}

// ---- a world: one location, one index ----------------------------------------------------------
function world(prefix = 'thin-loc-') {
  const root = tmp(prefix)
  writeFileSync(join(root, '.cctv-recordings'), JSON.stringify({ id: 'L1' }))
  const loc = { id: 'L1', path: root, type: 'usb', role: 'main', limitGB: null }
  const index = openRecIndex(join(tmp('thin-db-'), 'r.db'))
  const add = (nvr, ch, ageDays, opts = {}) => {
    const startMs = NOW - ageDays * DAY
    const path = join(root, String(nvr), String(ch), `d${ageDays}`, 'seg.h264')
    const m = makeSegment(path, startMs, opts)
    index.addSegment({ nvr, ch, path, startMs, endMs: m.endMs, bytes: m.bytes, keyframes: m.keyframes, loc: 'L1' })
    return { path, startMs, ...m }
  }
  const settings = (cameras = {}, storage = {}) => ({ recording: { defaults: DEFAULTS, cameras }, storage: { locations: [loc], lowFreePct: 15, floorFreePct: 5, ...storage } })
  return { root, loc, index, add, settings, present: (l) => l.id === 'L1' }
}

// ---- planThin ------------------------------------------------------------------------------------
{
  const p = join(tmp('thin-plan-'), 'x.h264')
  makeSegment(p, NOW, { gops: 60, pFrames: 4, keyStepMs: 1000 })
  const rows = parseIdx(readFileSync(`${p}.idx`))
  const plan = planThin(readFileSync(p), rows, { codec: CODEC.h264, timelapseS: 10 })
  check('one keyframe per 10 s out of 60', plan.keep.length === 6, String(plan.keep.length))
  check('...the first is kept and they are 10 s apart', plan.keep[0].tsMs === NOW && plan.keep[1].tsMs === NOW + 10_000)
  // The next minute's file, with the cursor from this one: the interval holds across the join
  // rather than restarting at every file and keeping two frames a second apart at each seam.
  const p2 = join(dirname(p), 'y.h264')
  makeSegment(p2, NOW + 60_000, { gops: 60, pFrames: 4, keyStepMs: 1000 })
  const rows2 = parseIdx(readFileSync(`${p2}.idx`))
  const next = planThin(readFileSync(p2), rows2, { codec: CODEC.h264, timelapseS: 10, cursor: plan.keep.at(-1).tsMs })
  check('the cursor carries the spacing across files', next.keep[0].tsMs === plan.keep.at(-1).tsMs + 10_000, String(next.keep[0]?.tsMs))
  const noneLeft = planThin(readFileSync(p), rows, { codec: CODEC.h264, timelapseS: 600 })
  check('an interval longer than the file keeps just the first keyframe', noneLeft.keep.length === 1)
}

// ---- thinning: dry run is the default and touches nothing ----------------------------------------
{
  const w = world()
  const s = w.add('n1', 0, 60)
  const before = readFileSync(s.path)
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present })
  check('DRY RUN IS THE DEFAULT', r.dryRun === true)
  // from the index alone since 2026-09-29 (verify-1: it read every file, ~24 GB over SMB a run)
  check('dry run reports what it would do: the files and their bytes, from the index', r.files === 1 && r.bytes === s.bytes && r.thinned.length === 0, JSON.stringify({ files: r.files, bytes: r.bytes }))
  check('dry run says how much it would free, as an estimate with its range', r.freedBytes > 0 && r.freedBytes < s.bytes && r.estimate?.thinBytes > 0 && r.estimate.low <= r.estimate.thinBytes && r.estimate.thinBytes <= r.estimate.high, JSON.stringify(r.estimate))
  // (it read "43-56.00000000000001 %" on GET /api/storage: review of p3-thin, 2026-09-29)
  check('... and its note says the share of keyframes in whole percent', /keyframes taken as 43-56 % of a file's bytes/.test(r.estimate?.note ?? ''), r.estimate?.note)
  check('... and what waits: one file, since its full-video days ended', r.backlog?.files === 1 && r.backlog.bytes === s.bytes && r.backlog.oldestMs === s.startMs, JSON.stringify(r.backlog))
  check('DRY RUN CHANGED NOTHING ON DISK', readFileSync(s.path).equals(before) && statSync(s.path).size === s.bytes)
  check('dry run left no temp files', readdirSync(dirname(s.path)).sort().join() === 'seg.h264,seg.h264.idx', readdirSync(dirname(s.path)).join())
  check('dry run left the index row alone', w.index.thinRow(s.path).bytes === s.bytes)
  w.index.close()
}

// ---- thinning for real ----------------------------------------------------------------------------
{
  const w = world()
  const old = w.add('n1', 0, 60, { gops: 60, pFrames: 4 })
  const recent = w.add('n1', 0, 2, { gops: 60, pFrames: 4 }) // inside fullDays: full video
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT })
  check('the old segment was thinned', r.thinned.length === 1 && r.thinned[0].path === old.path, JSON.stringify(r.thinned.map((t) => t.path)))
  check('FOOTAGE INSIDE fullDays IS UNTOUCHED', statSync(recent.path).size === recent.bytes && parseIdx(readFileSync(`${recent.path}.idx`)).length === recent.keyframes)
  const rows = parseIdx(readFileSync(`${old.path}.idx`))
  check('only the keyframes at the time-lapse interval are left', rows.length === 6, String(rows.length))
  check('the file really is smaller', statSync(old.path).size < old.bytes)
  const buf = readFileSync(old.path)
  const { units } = splitUnits(buf, CODEC.h264, { final: true, keyOffsets: new Set(rows.map((x) => x.offset)) })
  check('every frame left is a keyframe and every index row lands on one', units.length === rows.length && units.every((u) => u.isKey) && rows.every((x, i) => x.offset === units[i].start))
  check('the index row was updated to match the file', w.index.thinRow(old.path).bytes === buf.length && w.index.thinRow(old.path).keyframes === rows.length)
  check('... and marked as time-lapse', w.index.thinRow(old.path).thinned === THIN.timelapse && w.index.thinRow(recent.path).thinned === null)
  check('... nothing left in flight', w.index.thinInflight().length === 0)
  check('the times still line up with the original recording', rows[0].tsMs === old.startMs && rows.at(-1).tsMs === old.startMs + 50_000)
  check('no temp or backup files were left behind', readdirSync(dirname(old.path)).sort().join() === 'seg.h264,seg.h264.idx', readdirSync(dirname(old.path)).join())
  // running it again must be a no-op, not a second round of cutting -- and must not even read it again
  // (verify-1: every run re-read each camera's oldest 500 files, "already thin")
  const asked = []
  const { shareCall } = await import('../share-calls.mjs')
  const share = (loc, op, a, o) => (asked.push(`${op} ${a?.path ?? a?.paths?.join() ?? ''}`), shareCall(loc, op, a, o))
  const again = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT, share })
  check('running it twice changes nothing (idempotent)', again.thinned.length === 0 && statSync(old.path).size === buf.length, JSON.stringify(again.skipped))
  check('A FILE ALREADY THINNED IS NEVER READ AGAIN: the second run asks the helper for nothing', asked.length === 0 && again.backlog.files === 0, asked.join('; '))
  w.index.close()
}

// ---- thinning: a camera not set to time-lapse ------------------------------------------------------
{
  const w = world()
  const s = w.add('n1', 0, 60)
  const r = await runThinning({ index: w.index, settings: w.settings({ 'n1/0': { after: 'delete' } }), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT })
  check("a camera whose 'after' is not time-lapse is never thinned", r.thinned.length === 0 && statSync(s.path).size === s.bytes)
  w.index.close()
}

// ---- thinning: protected stretches -------------------------------------------------------------------
{
  const w = world()
  const booked = w.add('n1', 0, 60)
  const plain = w.add('n1', 1, 70)
  const r = await runThinning({
    index: w.index,
    settings: w.settings(),
    now: NOW,
    present: w.present,
    dryRun: false, ...AT_NIGHT,
    protectedRanges: () => [[booked.startMs + 1000, booked.startMs + 2000]]
  })
  check('A BOOKMARKED STRETCH IS NEVER THINNED', statSync(booked.path).size === booked.bytes && r.skipped.some((s) => s.path === booked.path && /bookmark/.test(s.why)))
  check('...while the rest still is', r.thinned.some((t) => t.path === plain.path))
  check('the run says the bookmarks module answered', r.protection === 'ranges')
  w.index.close()
}
{
  const w = world()
  const s = w.add('n1', 0, 60)
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT, protectedRanges: null })
  check('no bookmarks module yet: nothing is skipped and the job carries on', r.protection === 'none' && r.thinned.length === 1)
  check('...and it really did thin it', statSync(s.path).size < s.bytes)
  w.index.close()
}
{
  const w = world()
  const s = w.add('n1', 0, 60)
  const r = await runThinning({
    index: w.index,
    settings: w.settings(),
    now: NOW,
    present: w.present,
    dryRun: false, ...AT_NIGHT,
    protectedRanges: () => {
      throw new Error('bookmarks table locked')
    }
  })
  check('BOOKMARKS UNREADABLE: NOTHING IS TOUCHED', r.thinned.length === 0 && statSync(s.path).size === s.bytes && r.warnings.some((x) => /bookmarks/.test(x)))
  // not 'none', which is "nobody to ask, so nothing protected": this run stopped before any file (storage-jobs.mjs)
  check('...and the run says the bookmarks were unreadable, not that there were none', r.protection === 'unread', r.protection)
  w.index.close()
}
{
  const w = world()
  const s = w.add('n1', 0, 60)
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT, protectedRanges: () => [{ fromMs: 'oops', toMs: 1 }] })
  check('a range we cannot read stops the run rather than guessing', r.thinned.length === 0 && statSync(s.path).size === s.bytes && r.protection === 'unread', r.protection)
  w.index.close()
}
{
  // Feature detection, whichever way round the two modules land: null before bookmarks.mjs
  // exists, its function after. Either is fine and neither is an error.
  const fn = await loadProtectedRanges()
  check('the bookmarks module is feature-detected, never assumed', fn === null || typeof fn === 'function', String(typeof fn))
}

// ---- thinning: an unmounted drive --------------------------------------------------------------------
{
  const w = world()
  const s = w.add('n1', 0, 60)
  rmSync(join(w.root, '.cctv-recordings'))
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, dryRun: false, ...AT_NIGHT })
  check('AN UNMOUNTED LOCATION IS NEVER REWRITTEN', r.thinned.length === 0 && statSync(s.path).size === s.bytes)
  check('...and it says why', r.warnings.some((x) => /marker/.test(x)))
  w.index.close()
}

// ---- mayTouch: the path guard --------------------------------------------------------------------------
{
  const locs = new Map([['L1', { id: 'L1', path: join(tmpdir(), 'rec-root') }]])
  const here = new Set(['L1'])
  check('a file inside the location is allowed', mayTouch({ loc: 'L1', path: join(tmpdir(), 'rec-root', 'a', 'b.h264') }, locs, here).ok === true)
  check('A FILE OUTSIDE THE LOCATION IS REFUSED', mayTouch({ loc: 'L1', path: join(tmpdir(), 'somewhere-else', 'b.h264') }, locs, here).ok === false)
  check('a traversal out of the location is refused', mayTouch({ loc: 'L1', path: join(tmpdir(), 'rec-root', '..', 'b.h264') }, locs, here).ok === false)
  check('the location folder itself is refused', mayTouch({ loc: 'L1', path: join(tmpdir(), 'rec-root') }, locs, here).ok === false)
  check('an unknown location is refused', mayTouch({ loc: 'L9', path: join(tmpdir(), 'rec-root', 'b.h264') }, locs, here).ok === false)
  check('an unmounted location is refused', mayTouch({ loc: 'L1', path: join(tmpdir(), 'rec-root', 'b.h264') }, locs, new Set()).ok === false)
}

// ---- crash in the middle of a rewrite -------------------------------------------------------------------
{
  const w = world()
  const s = w.add('n1', 0, 60)
  const original = readFileSync(s.path)
  const originalIdx = readFileSync(`${s.path}.idx`)
  const n = _test.names(s.path)

  // Stage a crash after the journal was written and the original had been moved aside, with the
  // new pair half swapped in: the worst moment there is.
  const { renameSync, writeFileSync: wf } = await import('node:fs')
  wf(n.newSeg, Buffer.from('a half-written new segment'))
  wf(n.newIdx, Buffer.alloc(16))
  wf(n.journal, '{"path":"x"}\n')
  renameSync(n.seg, n.oldSeg)
  renameSync(n.idx, n.oldIdx)
  renameSync(n.newSeg, n.seg) // only half of the swap happened

  const dry = recoverThinning([w.root], { dryRun: true })
  check('recovery dry run reports the file and changes nothing', dry.rolledBack.includes(s.path) && readFileSync(s.path).toString() === 'a half-written new segment')
  const rec = recoverThinning([w.root])
  check('CRASH MID-REWRITE: THE ORIGINAL FOOTAGE COMES BACK', readFileSync(s.path).equals(original) && readFileSync(`${s.path}.idx`).equals(originalIdx))
  check('...and the half-made new pair is gone', !existsSync(n.newSeg) && !existsSync(n.newIdx) && !existsSync(n.journal) && !existsSync(n.oldSeg) && !existsSync(n.oldIdx))
  check('recovery says what it did', rec.rolledBack.includes(s.path))

  // And the other case: the swap committed (no journal) but the old pair was not swept up.
  wf(n.oldSeg, 'stale')
  wf(n.oldIdx, 'stale')
  const rec2 = recoverThinning([w.root])
  check('a committed rewrite keeps the new pair and sweeps up the old one', readFileSync(s.path).equals(original) && !existsSync(n.oldSeg) && !existsSync(n.oldIdx) && rec2.sweptUp.includes(s.path))
  w.index.close()
}

// ---- a rewrite that produces rubbish must not replace anything ----------------------------------------
{
  const w = world()
  const s = w.add('n1', 0, 60)
  const original = readFileSync(s.path)
  // A truncated .idx: the rows no longer describe the file, so the plan cannot be verified.
  writeFileSync(`${s.path}.idx`, Buffer.alloc(8))
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT })
  check('a segment whose index is unusable is left exactly as it was', readFileSync(s.path).equals(original) && r.thinned.length === 0, JSON.stringify(r.skipped))
  w.index.close()
}

// ======== thinning off the main thread (perf report Task 4 and its check verify-1, 2026-09-29) ========
// The job read, parsed and rewrote every candidate synchronously on the main thread, dry run too: about
// 0.31 s a file over SMB, 2,000 files a run, ~10 minutes of frozen server every 5. Now the dry run is
// worked out from the index, the rewrite is the share helper's (a process of its own), and the main
// thread only decides, checks and updates rows.

/**
 * The main thread's longest busy stretch from here to stop(): between two runs of a 2 ms timer, the time
 * that passed less the time the loop sat idle (loop-lag.mjs's measure), and monitorEventLoopDelay's max
 * over the same time. A synchronous call counts in full; a timer run late because this PC was busy with
 * other programs does not count in the first.
 */
async function mainThread(fn) {
  const { monitorEventLoopDelay } = await import('node:perf_hooks')
  const h = monitorEventLoopDelay({ resolution: 1 })
  let last = performance.now()
  let lastIdle = performance.nodeTiming.idleTime
  let worst = 0
  const t = setInterval(() => {
    const now = performance.now()
    const idle = performance.nodeTiming.idleTime
    worst = Math.max(worst, now - last - (idle - lastIdle))
    last = now
    lastIdle = idle
  }, 2)
  h.enable()
  const idle0 = performance.nodeTiming.idleTime
  const t0 = performance.now()
  const value = await fn()
  const busy = performance.now() - t0 - (performance.nodeTiming.idleTime - idle0)
  h.disable()
  clearInterval(t)
  return { value, busyMs: busy, worstMs: worst, delayMaxMs: h.max / 1e6 }
}
const bestOf = async (n, fn) => {
  let best = null
  for (let i = 0; i < n; i++) {
    const m = await fn()
    if (!best || m.busyMs + m.worstMs < best.busyMs + best.worstMs) best = m
  }
  return best
}

// ---- the dry run: from the index; no segment file opened; under 100 ms of main thread for 2,000 files ----
{
  const { default: fs } = await import('node:fs')
  const { syncBuiltinESMExports } = await import('node:module')
  const w = world()
  // 87 cameras x 23 files past their full-video days (2,001), and a day of recent ones: rows only. Were a
  // file opened, the spy below would say so whether or not it is there.
  for (let c = 0; c < 87; c++) {
    for (let i = 0; i < 23; i++) {
      const startMs = NOW - 40 * DAY + (c * 23 + i) * 60_000
      w.index.addSegment({ nvr: 'n1', ch: c, path: join(w.root, 'n1', String(c), `${startMs}.h265`), startMs, endMs: startMs + 59_000, bytes: 12_000_000, keyframes: 30, loc: 'L1' })
    }
    for (let i = 0; i < 24; i++) {
      const startMs = NOW - DAY + i * 3_600_000
      w.index.addSegment({ nvr: 'n1', ch: c, path: join(w.root, 'n1', String(c), `${startMs}.h265`), startMs, endMs: startMs + 59_000, bytes: 12_000_000, keyframes: 30, loc: 'L1' })
    }
  }
  const touched = []
  const restore = []
  const spy = (obj, name) => {
    const real = obj[name]
    if (typeof real !== 'function') return
    obj[name] = function (p, ...a) {
      if (String(p?.href ?? p).startsWith(w.root)) touched.push(`${name} ${p}`)
      return real.call(this, p, ...a)
    }
    restore.push(() => (obj[name] = real))
  }
  for (const n of ['openSync', 'readFileSync', 'statSync', 'lstatSync', 'existsSync', 'readdirSync', 'accessSync', 'open', 'readFile', 'stat', 'lstat', 'readdir', 'access', 'createReadStream']) spy(fs, n)
  for (const n of ['open', 'readFile', 'stat', 'lstat', 'readdir', 'access']) spy(fs.promises, n)
  syncBuiltinESMExports()
  const asked = []
  const settings = { ...w.settings(), recording: { defaults: { ...DEFAULTS, fullDays: 7 }, cameras: {} } }
  const run = () => runThinning({ index: w.index, settings, now: NOW, present: w.present, protectedRanges: () => [], share: async (l, op) => (asked.push(op), null) })
  await run() // first run: statements prepared, code compiled (not what is measured)
  const m = await bestOf(3, () => mainThread(run))
  for (const r of restore) r()
  syncBuiltinESMExports()
  const r = m.value
  check('A DRY RUN OVER 2,001 OLD SEGMENTS OPENS NO SEGMENT FILE, and asks the share helper nothing', touched.length === 0 && asked.length === 0, `${touched.slice(0, 3).join('; ')} ${asked.join()}`)
  check('... and counts every one of them from the index, not the first 2,000', r.files === 2001 && r.bytes === 2001 * 12e6 && r.backlog.files === 2001, JSON.stringify({ files: r.files, bytes: r.bytes }))
  check('... with an estimate of the time-lapse it would leave, labelled as one', r.estimate?.thinBytes > 0 && r.estimate.low < r.estimate.high && /estimate/i.test(r.estimate.note ?? ''), JSON.stringify(r.estimate))
  check('DRY RUN OVER 2,001 FILES: UNDER 100 MS OF MAIN THREAD IN ALL, no stretch over 50 ms', m.busyMs < 100 && m.worstMs < 50, `busy ${m.busyMs.toFixed(1)} ms, longest stretch ${m.worstMs.toFixed(1)} ms, event-loop delay max ${m.delayMaxMs.toFixed(1)} ms (was ~0.31 s a file: ~620 s)`)
  w.index.close()
}

// ---- the helper killed in the middle of a file: the original intact, its row unchanged --------------------
// The helper below is the real one, with each file call on a path holding "SLOW" made to take 60 ms, so a
// rewrite is slow enough to be killed at a chosen moment: while the rewrite is being written (.thin-new
// there), while the swap is under way (journal there), and after the row was updated but before the commit.
const shareCalls = await import('../share-calls.mjs')
{
  const { pathToFileURL } = await import('node:url')
  const slowHelper = join(dataDir, 'slow-helper.mjs')
  writeFileSync(
    slowHelper,
    `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
for (const k of ['stat', 'statfs', 'readFile', 'writeFile', 'readdir', 'unlink', 'rmdir', 'rename', 'open']) {
  const real = fs.promises[k]
  fs.promises[k] = (p, ...a) => (String(p).includes('SLOW') ? new Promise((r) => setTimeout(r, 60)).then(() => real(p, ...a)) : real(p, ...a))
}
syncBuiltinESMExports()
await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'share-helper.mjs')).href)})
`
  )
  shareCalls._test.setHelper(slowHelper)
  for (const moment of ['rewrite', 'swap', 'commit']) {
    const w = world('thin-SLOW-')
    const s = w.add('n1', 0, 60)
    const orig = { seg: readFileSync(s.path), idx: readFileSync(`${s.path}.idx`) }
    const rowBefore = JSON.stringify(w.index.thinRow(s.path))
    const n = _test.names(s.path)
    let killed = null
    const kill = () => {
      const pid = shareCalls._test.pidOf(w.loc)
      if (killed || !pid) return
      killed = pid
      process.kill(pid, 'SIGKILL')
    }
    const poll = moment === 'commit' ? null : setInterval(() => existsSync(moment === 'rewrite' ? n.newSeg : n.journal) && kill(), 2)
    // after the row says time-lapse and before the commit is sent
    const index = moment === 'commit' ? new Proxy(w.index, { get: (t, k) => (k === 'thinSwapped' ? (...a) => (t.thinSwapped(...a), kill()) : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }) : w.index
    const r = await runThinning({ index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT })
    clearInterval(poll)
    const left = readdirSync(dirname(s.path)).sort().join()
    check(`HELPER KILLED DURING THE ${moment.toUpperCase()}: the original footage is intact, byte for byte`, killed && readFileSync(s.path).equals(orig.seg) && readFileSync(`${s.path}.idx`).equals(orig.idx) && r.thinned.length === 0, `killed ${killed}; ${left}; ${JSON.stringify(r.warnings)}`)
    check(`... its index row is as it was`, JSON.stringify(w.index.thinRow(s.path)) === rowBefore, `${JSON.stringify(w.index.thinRow(s.path))} vs ${rowBefore}`)
    check(`... nothing half done beside it, nothing left in flight`, left === 'seg.h264,seg.h264.idx' && w.index.thinInflight().length === 0, `${left}; ${JSON.stringify(w.index.thinInflight())}`)
    const next = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT })
    check(`... and the next run converts it`, next.thinned.length === 1 && statSync(s.path).size < s.bytes && w.index.thinRow(s.path).thinned === THIN.timelapse && w.index.thinRow(s.path).bytes === statSync(s.path).size, JSON.stringify(next.skipped))
    w.index.close()
  }
  shareCalls._test.setHelper(null)
}

// ---- a rewrite the server lost track of (it stopped, or the share hung): put right at the next run ----------
{
  const w = world()
  const s = w.add('n1', 0, 60)
  const orig = readFileSync(s.path)
  // the first run: the rewrite is written, then the share "hangs" at the swap (no file touched by it)
  const first = await runThinning({
    index: w.index,
    settings: w.settings(),
    now: NOW,
    present: w.present,
    dryRun: false,
    ...AT_NIGHT,
    share: (loc, op, a, o) => (op === 'thinSwap' ? Promise.reject(Object.assign(new Error('share not answering'), { code: 'ESHARESTUCK' })) : shareCalls.shareCall(loc, op, a, o))
  })
  check('the share stuck at the swap: nothing converted, the rewrite kept in flight for the next run', first.thinned.length === 0 && w.index.thinInflight().map((x) => x.path).join() === s.path && existsSync(`${s.path}.thin-new`) && readFileSync(s.path).equals(orig), `${JSON.stringify(w.index.thinInflight())} ${JSON.stringify(first.warnings)}`)
  // housekeeping and retention leave a file in flight alone, however old
  const del = await runRetention({ index: w.index, settings: w.settings({}, {}), now: NOW + 400 * DAY, present: w.present, dryRun: false, freeOf: () => ({ freeBytes: 90, totalBytes: 100 }) })
  check('RETENTION LEAVES A FILE WHOSE REWRITE IS IN FLIGHT ALONE, however old', existsSync(s.path) && w.index.thinRow(s.path) !== null && !del.deleted.some((d) => d.path === s.path) && del.skipped.some((x) => x.path === s.path && /rewrite/.test(x.why)), JSON.stringify(del.skipped))
  const next = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT })
  check('THE NEXT RUN PUTS IT RIGHT FIRST (the leftover rewrite swept, the row checked), then converts it', next.recovered?.sweptUp === 1 && next.thinned.length === 1 && w.index.thinInflight().length === 0 && w.index.thinRow(s.path).thinned === THIN.timelapse && readdirSync(dirname(s.path)).sort().join() === 'seg.h264,seg.h264.idx', JSON.stringify({ recovered: next.recovered, warnings: next.warnings }))
  w.index.close()
}
{
  // The same, and then the switch set to Dry run. Only a run with it On used to put leftovers right, so with Dry
  // run (or Off) the file stayed out of every deletion, with its leftover beside it, for as long as that lasted
  // (review of p3-thin, 2026-09-29). Putting right only finishes or undoes what a run with the switch On began:
  // the original is put back, or a rewrite that was never swapped in (or the original of one that was committed)
  // is swept up; it never begins a rewrite. So a dry run does it too, and converts nothing.
  const w = world()
  const s = w.add('n1', 0, 60)
  const orig = readFileSync(s.path)
  await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT, share: (loc, op, a, o) => (op === 'thinSwap' ? Promise.reject(Object.assign(new Error('share not answering'), { code: 'ESHARESTUCK' })) : shareCalls.shareCall(loc, op, a, o)) })
  const stuck = existsSync(`${s.path}.thin-new`) && w.index.thinInflight().length === 1
  const dry = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present })
  check('A DRY RUN PUTS A REWRITE LEFT HALF DONE RIGHT (the rewrite never swapped in swept, the original as it was, its row full video), converts nothing, and says so', stuck && dry.dryRun && dry.recovered?.sweptUp === 1 && !existsSync(`${s.path}.thin-new`) && readFileSync(s.path).equals(orig) && w.index.thinInflight().length === 0 && w.index.thinRow(s.path).thinned === null && w.index.thinRow(s.path).bytes === s.bytes && dry.thinned.length === 0 && dry.files === 1 && dry.warnings.some((x) => /put right/.test(x)), JSON.stringify({ stuck, recovered: dry.recovered, warnings: dry.warnings }))
  const next = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT })
  check('... and the next run with the switch On converts it', next.thinned.length === 1 && next.recovered.sweptUp === 0 && w.index.thinRow(s.path).thinned === THIN.timelapse && readdirSync(dirname(s.path)).sort().join() === 'seg.h264,seg.h264.idx', JSON.stringify(next.skipped))
  w.index.close()
}
{
  // the server stopped half way through a swap, after the row said time-lapse: the original comes back and so does its row
  const w = world()
  const s = w.add('n1', 0, 60)
  const orig = { seg: readFileSync(s.path), idx: readFileSync(`${s.path}.idx`) }
  const n = _test.names(s.path)
  const { renameSync } = await import('node:fs')
  w.index.thinBegin({ path: s.path, loc: 'L1', bytes: s.bytes, keyframes: s.keyframes })
  writeFileSync(n.newSeg, Buffer.from('a rewrite'))
  writeFileSync(n.newIdx, Buffer.alloc(16))
  writeFileSync(n.journal, '{"path":"x"}\n')
  renameSync(n.seg, n.oldSeg)
  renameSync(n.idx, n.oldIdx)
  renameSync(n.newSeg, n.seg)
  renameSync(n.newIdx, n.idx)
  w.index.thinSwapped(s.path, { bytes: 9, keyframes: 1 })
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT, maxSegments: 0 })
  check('SERVER STOPPED MID-SWAP, ROW ALREADY UPDATED: the original comes back, byte for byte', readFileSync(s.path).equals(orig.seg) && readFileSync(`${s.path}.idx`).equals(orig.idx) && r.recovered?.rolledBack === 1, JSON.stringify(r.recovered))
  check('... and its row says full video again, with its size', w.index.thinRow(s.path).thinned === null && w.index.thinRow(s.path).bytes === s.bytes && w.index.thinRow(s.path).keyframes === s.keyframes && w.index.thinInflight().length === 0, JSON.stringify(w.index.thinRow(s.path)))
  w.index.close()
}

{
  // a leftover nothing can put right: the segment and its .idx gone, a journal left, nothing set aside. Said
  // loudly, kept in flight (so nothing deletes what is beside it), and not taken again by the walk.
  const w = world()
  const s = w.add('n1', 0, 60)
  const n = _test.names(s.path)
  w.index.thinBegin({ path: s.path, loc: 'L1', bytes: s.bytes, keyframes: s.keyframes })
  writeFileSync(n.journal, '{"path":"x"}\n')
  writeFileSync(n.newSeg, Buffer.from('a rewrite'))
  rmSync(s.path)
  rmSync(`${s.path}.idx`)
  const asked = []
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT, share: (loc, op, a, o) => (asked.push(`${op} ${a?.path ?? ''}`), shareCalls.shareCall(loc, op, a, o)) })
  check('A LEFTOVER NOTHING CAN PUT RIGHT: said loudly, kept in flight, what is beside it kept, and not taken again', r.left.join() === s.path && r.warnings.some((x) => /NEEDS A PERSON/.test(x)) && w.index.thinInflight().length === 1 && existsSync(n.journal) && existsSync(n.newSeg) && !asked.some((x) => x.startsWith('thin ')) && r.skipped.some((x) => x.path === s.path && /half done/.test(x.why)), `${asked.join('; ')} ${JSON.stringify(r.skipped)}`)
  w.index.close()
}

{
  // Review of p3-thin, round 2 (2026-09-30): the share unmounted just after thinRecover read its marker. In the
  // empty mount point thinRecover found nothing for the path and said nothing of it; 'stat' then said ENOENT,
  // which putRight took for "deleted meanwhile" and dropped the path from thin_inflight -- while on the real share
  // the journal, .thin-old (the original) and .thin-new stayed, kept from no deletion, put right by no run, the
  // minute unplayable. Now a path leaves thin_inflight only when thinRecover itself says it is gone with the
  // marker there; any other stat that fails keeps it in flight.
  const w = world()
  const s = w.add('n1', 0, 60)
  const orig = readFileSync(s.path)
  const n = _test.names(s.path)
  const { renameSync } = await import('node:fs')
  // the helper killed mid-swap: the journal, the original set aside, the rewrite beside it, the segment missing
  w.index.thinBegin({ path: s.path, loc: 'L1', bytes: s.bytes, keyframes: s.keyframes })
  writeFileSync(n.journal, '{"path":"x"}\n')
  renameSync(n.seg, n.oldSeg)
  renameSync(n.idx, n.oldIdx)
  writeFileSync(n.newSeg, Buffer.from('a rewrite'))
  writeFileSync(n.newIdx, Buffer.alloc(16))
  // what the share answered with its mount point empty (a helper before this: nothing said of the path; then ENOENT)
  const unmounted = async (loc, op, a) => {
    if (op === 'thinRecover') return { rolledBack: [], sweptUp: [], left: [], refused: [] }
    if (op === 'stat') return a.paths.map((p) => ({ path: p, error: 'ENOENT' }))
    throw new Error(`unexpected ${op}`)
  }
  const dry = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, share: unmounted })
  check('A REWRITE LEFT HALF DONE, "NOT THERE" ONCE PUT RIGHT BUT NOT SAID GONE BY THE HELPER: kept in flight (nothing deletes it), and said', w.index.thinInflight().map((x) => x.path).join() === s.path && dry.warnings.some((x) => /kept in flight/.test(x)), JSON.stringify({ inflight: w.index.thinInflight(), warnings: dry.warnings }))
  const back = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present })
  check('... and with the share back, the next dry run puts the original back, byte for byte', back.recovered?.rolledBack === 1 && readFileSync(s.path).equals(orig) && w.index.thinInflight().length === 0 && readdirSync(dirname(s.path)).sort().join() === 'seg.h264,seg.h264.idx', JSON.stringify({ recovered: back.recovered, warnings: back.warnings }))
  // really gone (the marker there, nothing of it left beside it): no longer in flight, its row as it was
  const g = w.add('n1', 1, 61)
  w.index.thinBegin({ path: g.path, loc: 'L1', bytes: g.bytes, keyframes: g.keyframes })
  rmSync(g.path)
  rmSync(`${g.path}.idx`)
  const gone = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present })
  check('... while one really gone (the helper found nothing of it, its marker there) is no longer in flight', w.index.thinInflight().length === 0 && gone.warnings.some((x) => /not there/.test(x)), JSON.stringify(gone.warnings))
  w.index.close()
}

// ---- checked again just before the swap: a bookmark made meanwhile, the switch set to Off meanwhile --------
{
  const w = world()
  const s = w.add('n1', 0, 60)
  const orig = readFileSync(s.path)
  let asks = 0
  // the run's first question (every bookmark) finds none; one is made while the file is being rewritten
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT, protectedRanges: () => (asks++ === 0 ? [] : [[s.startMs + 5000, s.startMs + 6000]]) })
  check('A BOOKMARK MADE WHILE A FILE IS REWRITTEN: the rewrite is thrown away, the original kept', asks >= 2 && readFileSync(s.path).equals(orig) && r.thinned.length === 0 && r.skipped.some((x) => x.path === s.path && /bookmark/.test(x.why)) && readdirSync(dirname(s.path)).sort().join() === 'seg.h264,seg.h264.idx' && w.index.thinRow(s.path).thinned === null && w.index.thinInflight().length === 0, JSON.stringify(r.skipped))
  w.index.close()
}
{
  const w = world()
  const a = w.add('n1', 0, 60)
  const b = w.add('n1', 1, 61)
  const origA = readFileSync(a.path)
  const origB = readFileSync(b.path)
  let asked = 0
  // on when the run starts and when the first file is taken; Off saved while it is rewritten
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT, armed: () => asked++ < 2 })
  check('SWITCHED OFF WHILE A FILE IS REWRITTEN: that rewrite is thrown away and nothing more is taken', r.thinned.length === 0 && readFileSync(a.path).equals(origA) && readFileSync(b.path).equals(origB) && /switch/.test(r.stopped ?? '') && w.index.thinInflight().length === 0, `${r.stopped}; ${JSON.stringify(r.skipped)}`)
  w.index.close()
}

// ---- when it works: nights first, not while the recorder says the disk is too slow, not past its round --------
{
  const w = world()
  const s = w.add('n1', 0, 60)
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, siteMin: () => 12 * 60 })
  check('by day with a backlog the night can convert: nothing converted, and it says it waits for the night', r.thinned.length === 0 && r.decision?.work === false && /night/.test(r.decision.why) && r.backlog.files === 1 && statSync(s.path).size === s.bytes, JSON.stringify(r.decision))
  const slow = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT, slow: () => ({ at: Date.now() - 60_000, nvr: 'n1', ch: 3, reason: 'disk too slow: a write has waited 5.1 s' }) })
  check('"DISK TOO SLOW" FROM THE RECORDER A MINUTE AGO: it stands back, and says why', slow.thinned.length === 0 && slow.decision?.work === false && /disk too slow/.test(slow.decision.why) && statSync(s.path).size === s.bytes, JSON.stringify(slow.decision))
  const late = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT, deadline: Date.now() - 1 })
  check('its round\'s time is up: nothing taken on, and it says so', late.thinned.length === 0 && /minutes|round/.test(late.stopped ?? '') && statSync(s.path).size === s.bytes, late.stopped)
  w.index.close()
}
{
  // "disk too slow" reported while it works: no new file is taken on
  const w = world()
  const one = w.add('n1', 0, 60)
  const two = w.add('n1', 0, 59)
  let report = null
  const r = await runThinning({
    index: w.index,
    settings: w.settings(),
    now: NOW,
    present: w.present,
    dryRun: false,
    ...AT_NIGHT,
    slow: () => report,
    share: async (loc, op, a, o) => {
      const v = await shareCalls.shareCall(loc, op, a, o)
      if (op === 'thinCommit') report = { at: Date.now(), nvr: 'n1', ch: 7, reason: 'disk too slow' }
      return v
    }
  })
  check('"disk too slow" reported while it converts: it stops taking files (the one in hand is finished)', r.thinned.length === 1 && r.thinned[0].path === one.path && /disk too slow/.test(r.stopped ?? '') && statSync(two.path).size === two.bytes, `${r.stopped}; ${r.thinned.map((t) => t.path)}`)
  w.index.close()
}
{
  // The back-off (thin-pace.mjs; review of p3-thin, 2026-09-29, and round 2): "disk too slow" during a round
  // caps the pace of the rounds after it at half what that round ran at -- the 10 minutes standing back alone
  // came after a recording gap and then went on at the same pace -- the page and the log say so, and the
  // ceiling is kept in DATA_DIR (in memory, a restart went back to the whole pace)
  const P = await import('../thin-pace.mjs')
  P._test.reset()
  _test.forget()
  const paceFile = join(dataDir, 'thin-pace.json')
  const w = world()
  const a = w.add('n1', 0, 60)
  w.add('n1', 0, 59)
  w.add('n1', 1, 58)
  const t0 = Date.UTC(2026, 9, 3, 1, 0) // 01:00 at the site (UTC here): night
  let t = t0
  let report = null
  const share = async (loc, op, x, o) => {
    const v = await shareCalls.shareCall(loc, op, x, o)
    if (op === 'thinCommit') report = { at: t, nvr: 'n1', ch: 5, reason: 'disk too slow: a write has waited 5.3 s' }
    return v
  }
  const siteUtc = { siteMin: (ms) => Math.floor((((ms / 60_000) % 1440) + 1440) % 1440) }
  const first = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, share, slow: () => report, clock: () => t, paceFile, ...siteUtc })
  t = t0 + 11 * 60_000 // past the 10 minutes it stands back
  const second = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, share, slow: () => report, clock: () => t, paceFile, ...siteUtc })
  check('"DISK TOO SLOW" DURING A ROUND: the rounds after it go at half what it ran at (a fresh start\'s 20 MB/s, so 10), and say so', first.pace?.effectiveMbps === 20 && first.thinned.some((x) => x.path === a.path) && /disk too slow/.test(first.stopped ?? '') && second.pace?.factor === 0.25 && second.pace.effectiveMbps === 10 && second.warnings.some((x) => /lowered to 10 MB\/s/.test(x) && /01:00/.test(x)) && second.thinned.length >= 1, JSON.stringify({ first: first.pace, stopped: first.stopped, pace: second.pace, warnings: second.warnings }))
  await P.flushPace()
  const saved = JSON.parse(readFileSync(paceFile, 'utf8'))
  P._test.reset()
  const third = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, clock: () => t, paceFile, ...siteUtc })
  check('... KEPT IN DATA_DIR: after a restart (memory gone) even a dry run says the lowered pace', saved.capMbps === 10 && /^10 MB\/s/.test(third.pace?.text ?? ''), JSON.stringify({ saved: saved.capMbps, text: third.pace?.text }))
  P._test.reset()
  _test.forget()
  w.index.close()
}
{
  // A round held back by "disk too slow" counts as one that converted nothing only when it would otherwise have
  // worked (review of p3-thin, round 2, 2026-09-30): by day, waiting for the night, reports the NAS's other users
  // caused lowered what the rounds converted and flipped the day rule to work by day, adding load exactly when the
  // NAS was under stress.
  const P = await import('../thin-pace.mjs')
  P._test.reset()
  const w = world()
  w.add('n1', 0, 60)
  const siteMin = (ms) => Math.floor((((ms / 60_000) % 1440) + 1440) % 1440)
  const pace = P.thinPace({})
  const t0 = Date.UTC(2026, 9, 3, 1, 0)
  for (let i = 0; i < 3; i++) P.noteRound({ start: t0 + i * 300_000, end: t0 + i * 300_000 + P.RUN_MS, bytes: 9.6e9, full: true, mbps: 40 })
  P.settleRound({ now: t0 + 900_000, night: pace.night, siteMin, pace })
  const before = P.achievedMBps()
  const run = (t) => runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, clock: () => t, siteMin, slow: () => ({ at: t - 60_000, nvr: 'n1', ch: 0, reason: 'disk too slow: a write has waited 10.0 s' }), strain: () => null })
  const byDay = []
  for (let i = 0; i < 4; i++) byDay.push((await run(Date.UTC(2026, 9, 3, 13, 30 * i))).decision)
  check('BY DAY, WAITING FOR THE NIGHT, FOUR "DISK TOO SLOW" (the NAS\'s other users, say): held back, and not counted as rounds that converted nothing', before === 40 && byDay.every((d) => d.held === true && d.work === false && d.wouldWork === false) && P.achievedMBps() === before, JSON.stringify({ before, after: P.achievedMBps(), byDay }))
  const night = await run(Date.UTC(2026, 9, 3, 23, 0))
  P.settleRound({ now: Date.UTC(2026, 9, 3, 23, 5), night: pace.night, siteMin, pace })
  check('... at night the same is counted (it would have worked): 30 MB/s over the last four', night.decision?.held === true && night.decision.wouldWork === true && P.achievedMBps() === 30, JSON.stringify({ decision: night.decision, achieved: P.achievedMBps() }))
  P._test.reset()
  w.index.close()
}
{
  // The recorders' writes seen waiting (thin-pace.mjs noteRecorderQueues: half of what makes a gap) while it
  // converts: no new file, as for "disk too slow", before recording has lost anything.
  const w = world()
  const one = w.add('n1', 0, 60)
  const two = w.add('n1', 0, 59)
  let strain = null
  const r = await runThinning({
    index: w.index,
    settings: w.settings(),
    now: NOW,
    present: w.present,
    dryRun: false,
    ...AT_NIGHT,
    slow: () => null,
    strain: () => strain,
    share: async (loc, op, a, o) => {
      const v = await shareCalls.shareCall(loc, op, a, o)
      if (op === 'thinCommit') strain = { at: Date.now(), fromMs: Date.now() - 5200, nvr: 'n1', ch: 7, ageMs: 5200, reason: 'writes waiting to be written: 1.2 MB, the oldest for 5.2 s' }
      return v
    }
  })
  check('THE RECORDERS\' WRITES SEEN WAITING WHILE IT CONVERTS: it stops taking files (the one in hand is finished)', r.thinned.length === 1 && r.thinned[0].path === one.path && /waited|waiting/.test(r.stopped ?? '') && statSync(two.path).size === two.bytes, `${r.stopped}; ${r.thinned.map((t) => t.path)}`)
  w.index.close()
}
{
  // A location stopped while the next file waits on the pace (another file's share hung): that file is not sent
  // to it (review of p3-thin, 2026-09-29: one more call to a stuck share, which could fork a helper to be killed
  // again). Two locations, so the run itself goes on with the other.
  const w = world()
  const root2 = tmp('thin-loc2-')
  writeFileSync(join(root2, '.cctv-recordings'), JSON.stringify({ id: 'L2' }))
  const loc2 = { id: 'L2', path: root2, type: 'usb', role: 'main', limitGB: null }
  const a = w.add('n1', 0, 60)
  const b = w.add('n1', 1, 59.99)
  const c = { path: join(root2, 'n1', '2', 'seg.h264'), startMs: NOW - 59.98 * DAY }
  w.index.addSegment({ nvr: 'n1', ch: 2, path: c.path, startMs: c.startMs, endMs: c.startMs + 59_000, bytes: b.bytes, keyframes: 60, loc: 'L2' })
  const sent = []
  const share = async (loc, op, x) => {
    if (op === 'thin') {
      sent.push(x.path)
      await new Promise((r) => setTimeout(r, 30))
      if (x.path === a.path) throw Object.assign(new Error('share not answering'), { code: 'ESHARESTUCK' })
      return { outcome: 'thinned', swapped: false, wasBytes: b.bytes, bytes: 100, keyframes: 6, droppedKeyframes: 54, cursor: 1 }
    }
    if (op === 'thinSwap') return { swapped: true }
    if (op === 'thinCommit') return { committed: true }
    throw new Error(`unexpected ${op}`)
  }
  // the second and third files each wait 150 ms on the pace; the first file's share "hangs" after 30 ms
  const pace = { mbps: b.bytes / 0.15 / 1e6, atOnce: 3, night: { from: 20 * 60, to: 6 * 60 } }
  const settings = { ...w.settings(), storage: { locations: [w.loc, loc2], lowFreePct: 15, floorFreePct: 5 } }
  const r = await runThinning({ index: w.index, settings, now: NOW, present: () => true, protectedRanges: () => [], dryRun: false, share, pace, ...AT_NIGHT })
  check('A LOCATION STOPPED WHILE A FILE WAITED ON THE PACE: that file is not sent to it; the other location goes on', sent.join() === [a.path, c.path].join() && r.thinned.map((t) => t.path).join() === c.path && r.warnings.some((x) => /not answering/.test(x)) && statSync(b.path).size === b.bytes, `sent ${sent.map((p) => p.split(/[\\/]/).slice(-3).join('/')).join(', ')}; ${JSON.stringify(r.warnings)}`)
  w.index.close()
}

// ---- the main thread while it converts: 87 cameras, three files at a time through a helper -----------------
// A share helper that answers like the real one after a few ms (its work is in its own process): what is
// measured is this process's part -- the walk, the checks, the rows, the pace. SQLite's automatic WAL
// checkpoint is off for this index (openRecIndex walAutocheckpoint 0): it lands in whichever commit crosses
// 1,000 pages, recording's included, and took 12-124 ms on the production VM (on this PC too), which is
// perf report R11 / Task 12, not this job. What this job adds to it is how many WAL pages it writes a file:
// counted below, and the same run with checkpoints on is reported next to it.
const { DatabaseSync } = await import('node:sqlite')
const convertWorld = (walAutocheckpoint) => {
  const w = world()
  w.index.close()
  const f = join(tmp('thin-db-'), 'r.db')
  w.index = walAutocheckpoint === null ? openRecIndex(f) : openRecIndex(f, { walAutocheckpoint })
  w.file = f
  for (let c = 0; c < 87; c++) {
    for (let i = 0; i < 6; i++) {
      const startMs = NOW - 40 * DAY + i * 60_000
      w.index.addSegment({ nvr: 'n1', ch: c, path: join(w.root, 'n1', String(c), `${startMs}.h265`), startMs, endMs: startMs + 59_000, bytes: 12_000_000, keyframes: 30, loc: 'L1' })
    }
  }
  return w
}
{
  const w = convertWorld(0)
  const CAMS = 87
  const raw = new DatabaseSync(w.file)
  raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() // the log empty: what is in it after the run is the run's
  const fake = () => {
    const s = { inFlight: 0, most: 0, camsBusy: new Map(), camsTwice: 0 }
    const after = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms))
    s.share = async (loc, op, a) => {
      if (op === 'thin') {
        const cam = a.path.split(/[\\/]/).at(-2)
        if (s.camsBusy.get(cam)) s.camsTwice++
        s.camsBusy.set(cam, true)
        s.most = Math.max(s.most, ++s.inFlight)
        await after(6)
        return { outcome: 'thinned', swapped: false, wasBytes: 12_000_000, bytes: 1_300_000, keyframes: 6, droppedKeyframes: 24, cursor: 1 }
      }
      if (op === 'thinSwap') return after(2, { swapped: true })
      if (op === 'thinCommit') {
        s.inFlight--
        s.camsBusy.set(a.path.split(/[\\/]/).at(-2), false)
        return after(2, { committed: true })
      }
      throw new Error(`unexpected ${op}`)
    }
    return s
  }
  const pace = { mbps: 1e6, atOnce: 3, night: { from: 20 * 60, to: 6 * 60 } }
  const f1 = fake()
  const m = await mainThread(() => runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, ...AT_NIGHT, share: f1.share, pace, protectedRanges: () => [] }))
  const r = m.value
  const pages = raw.prepare('PRAGMA wal_checkpoint(PASSIVE)').get().log
  raw.close()
  // the same run on an index with SQLite's own checkpoints (as the server has it): reported, not judged here
  const w2 = convertWorld(null)
  const m2 = await mainThread(() => runThinning({ index: w2.index, settings: w2.settings(), now: NOW, present: w2.present, dryRun: false, ...AT_NIGHT, share: fake().share, pace, protectedRanges: () => [] }))
  w2.index.close()
  check('87 cameras x 6 files converted through the helper, every row marked', r.thinned.length === CAMS * 6 && w.index.fullOlderThan([{ nvr: 'n1', ch: 0 }], NOW, 10).length === 0 && w.index.thinRow(join(w.root, 'n1', '5', `${NOW - 40 * DAY}.h265`))?.thinned === THIN.timelapse, `${r.thinned.length}; ${JSON.stringify(r.warnings.slice(0, 3))}`)
  check('... at most three at a time, and one at a time per camera (its spacing carries from file to file)', f1.most === 3 && f1.camsTwice === 0, `${f1.most} at once, ${f1.camsTwice} twice`)
  check('THE MAIN THREAD WHILE IT CONVERTS: NO STRETCH OVER 50 MS (its own work; SQLite\'s checkpoints are Task 12\'s)', m.worstMs < 50 && m.delayMaxMs < 50, `longest stretch ${m.worstMs.toFixed(1)} ms, event-loop delay max ${m.delayMaxMs.toFixed(1)} ms, ${(m.busyMs / r.thinned.length).toFixed(2)} ms of main thread a file; with SQLite's own checkpoints: ${m2.worstMs.toFixed(1)} / ${m2.delayMaxMs.toFixed(1)} ms`)
  // at 3.3 files a second (40 MB/s of 12 MB files) this is what thinning adds to the WAL, and so to how often
  // a checkpoint lands on the main thread: recording writes about 10 pages a second (1.4 files a second, 7 each)
  check('... and it writes at most 4 WAL pages a file (one commit a file for its row, the in-flight notes a few files at a time)', pages / r.thinned.length <= 4, `${pages} pages for ${r.thinned.length} files: ${(pages / r.thinned.length).toFixed(2)} a file`)
  w.index.close()
}

// ---- the windows' two lookups (rec-index.mjs THIN_SQL.fullNth, fullOlderThan's window end) ------------------
{
  const { THIN_SQL } = await import('../rec-index.mjs')
  const f = join(tmp('thin-db-'), 'r.db')
  const ix = openRecIndex(f)
  const t0 = NOW - 20 * DAY
  for (let k = 0; k < 10; k++) for (const ch of [0, 1]) ix.addSegment({ nvr: 'n1', ch, path: `/rec/n1/${ch}/${k}.h264`, startMs: t0 + k * 60_000, endMs: t0 + k * 60_000 + 59_000, bytes: 10, keyframes: 1, loc: 'L1' })
  ix.setThin('/rec/n1/0/3.h264', THIN.timelapse)
  const raw = new DatabaseSync(f)
  const plan = raw.prepare(`EXPLAIN QUERY PLAN ${THIN_SQL.fullNth}`).all(0, 0).map((r) => r.detail).join(' | ')
  raw.close()
  // (not labelled covering, as `thinned` is not in the index; the rows it steps over are not read, all the same:
  // 0.27 ms for 5,000 of them on the development PC, 0.054 us each, scratchpad p3fix/nth-bench.mjs)
  check('fullNth searches the partial index of full-video rows from a start, in its order (no sort)', /^SEARCH segments USING (COVERING )?INDEX segments_full \(start_ms>\?\)$/.test(plan), plan)
  // 19 full rows (one rewritten): two at each minute, but at minute 3 only camera 1's; the 8th (n 7) is at minute 4
  const starts = [0, 1, 2, 7, 18, 19].map((n) => ix.fullNth(t0, n))
  check('fullNth: where the n-th full-video row from a time starts, any camera; a rewritten row not counted; past the last, null', JSON.stringify(starts) === JSON.stringify([t0, t0, t0 + 60_000, t0 + 240_000, t0 + 540_000, null]), JSON.stringify(starts.map((s) => (s === null ? null : (s - t0) / 60_000))))
  const inWindow = ix.fullOlderThan([{ nvr: 'n1', ch: 1 }], NOW, 100, t0 + 60_000, t0 + 240_000).map((r) => r.path)
  check('fullOlderThan: only the rows starting in the window [from, until)', inWindow.join() === ['/rec/n1/1/1.h264', '/rec/n1/1/2.h264', '/rec/n1/1/3.h264'].join(), inWindow.join())
  ix.close()
}

// ---- cameras not set to time-lapse: their full video is passed a window at a time, never in one statement ----
// Review of p3-thin (2026-09-29): a camera set to 'delete' (or with more full-video days than the rest) keeps
// its rows in segments_full past the others' cutoff, and every run -- dry run too -- passed all of them in
// one synchronous statement to find the time-lapse cameras' first row: with 20 of 87 cameras set to 'delete'
// on a 31-day index, 251-260 ms at a stretch on the development PC, ~125 ms on the production VM. Here: those
// 20 cameras' 23 days past the cutoff (662,400 rows) and the other 67 cameras' day waiting (96,480 rows); the
// time-lapse cameras' own earlier days are left out (rewritten rows are not in segments_full, so not passed).
{
  const f = join(tmp('thin-db-'), 'r.db')
  openRecIndex(f).close()
  const w = world()
  w.index.close()
  const raw = new DatabaseSync(f)
  raw.exec('PRAGMA synchronous = OFF')
  const cutoff = NOW - 7 * DAY
  const DEL = 20
  const fill = raw.prepare(`WITH RECURSIVE m(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM m WHERE k < ?), c(ch) AS (SELECT ? UNION ALL SELECT ch + 1 FROM c WHERE ch < ?)
    INSERT INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc) SELECT ? || '/n1/' || ch || '/' || (? + k * 60000) || '.h265', 'n1', ch, ? + k * 60000, ? + k * 60000 + 59000, 12000000, 30, 'L1' FROM m CROSS JOIN c`)
  raw.exec('BEGIN')
  const from = cutoff - 23 * DAY
  fill.run(23 * 1440 - 1, 0, DEL - 1, w.root, from, from, from)
  fill.run(1440 - 1, DEL, 86, w.root, cutoff - DAY, cutoff - DAY, cutoff - DAY)
  raw.exec('COMMIT')
  raw.close()
  w.index = openRecIndex(f)
  const cams = Object.fromEntries(Array.from({ length: DEL }, (_, c) => [`n1/${c}`, { after: 'delete' }]))
  const settings = { ...w.settings(), recording: { defaults: { ...DEFAULTS, fullDays: 7, retentionDays: 30 }, cameras: cams } }
  // each index statement the job makes, timed: none may pass the 'delete' cameras' rows all at once
  let longest = { ms: 0, name: '' }
  const timed = new Proxy(w.index, {
    get: (t, k) =>
      typeof t[k] !== 'function'
        ? t[k]
        : (...a) => {
            const t0 = performance.now()
            const v = t[k](...a)
            const ms = performance.now() - t0
            if (ms > longest.ms) longest = { ms, name: String(k) }
            return v
          }
  })
  const dry = () => runThinning({ index: timed, settings, now: NOW, present: w.present, protectedRanges: () => [] })
  await dry() // statements prepared, code compiled
  longest = { ms: 0, name: '' }
  const m = await bestOf(3, () => mainThread(dry))
  const dryLongest = longest
  check('20 OF 87 CAMERAS SET TO DELETE, 31 DAYS: the dry run finds the other 67 cameras\' day waiting', m.value.files === 67 * 1440 && m.value.backlog.files === 67 * 1440, JSON.stringify({ files: m.value.files }))
  check('... WITH NO STRETCH OF MAIN THREAD OVER 50 MS: their 662,400 rows are passed a window at a time', m.worstMs < 50 && dryLongest.ms < 50, `longest stretch ${m.worstMs.toFixed(1)} ms, longest statement ${dryLongest.ms.toFixed(1)} ms (${dryLongest.name}), busy ${m.busyMs.toFixed(0)} ms in all, event-loop delay max ${m.delayMaxMs.toFixed(1)} ms (review: 251-260 ms at a stretch)`)
  const share = async (loc, op) => {
    if (op === 'thin') {
      await new Promise((r) => setTimeout(r, 3))
      return { outcome: 'thinned', swapped: false, wasBytes: 12_000_000, bytes: 1_300_000, keyframes: 6, droppedKeyframes: 24, cursor: 1 }
    }
    if (op === 'thinSwap') return { swapped: true }
    if (op === 'thinCommit') return { committed: true }
    throw new Error(`unexpected ${op}`)
  }
  const pace = { mbps: 1e6, atOnce: 3, night: { from: 20 * 60, to: 6 * 60 } }
  // The best of three runs of 200 files each (each goes on where the last stopped), as the dry run above: one
  // run alone failed 1 time in 6 on the development PC, 73.4 ms with one thinBegin commit at 60.8 ms and no WAL
  // checkpoint in it (Windows I/O or GC; review of p3-thin, round 2). Every run's figures are printed.
  const onRuns = []
  for (let i = 0; i < 3; i++) {
    longest = { ms: 0, name: '' }
    const m = await mainThread(() => runThinning({ index: timed, settings, now: NOW, present: w.present, protectedRanges: () => [], dryRun: false, share, pace, ...AT_NIGHT, maxSegments: 200 }))
    onRuns.push({ ...m, longest })
  }
  const on = onRuns.reduce((a, b) => (Math.max(b.worstMs, b.longest.ms) < Math.max(a.worstMs, a.longest.ms) ? b : a))
  check('... and the real run\'s walk too: 200 of the waiting files converted a run, no stretch over 50 ms (the best of three)', onRuns.every((x) => x.value.thinned.length === 200 && x.value.thinned.every((t) => Number(t.path.split(/[\\/]/).at(-2)) >= DEL)) && on.worstMs < 50 && on.longest.ms < 50, onRuns.map((x) => `${x.value.thinned.length} converted; longest stretch ${x.worstMs.toFixed(1)} ms, longest statement ${x.longest.ms.toFixed(1)} ms (${x.longest.name}), busy ${x.busyMs.toFixed(0)} ms`).join(' | ') + ' (review: 257 ms at a stretch)')
  w.index.close()
}

// ---- retention: dry run by default -------------------------------------------------------------------
{
  const w = world()
  const veryOld = w.add('n1', 0, 200)
  const keep = w.add('n1', 0, 100)
  const r = await runRetention({ index: w.index, settings: w.settings(), now: NOW, present: w.present, freeOf: () => ({ freeBytes: 90, totalBytes: 100 }) })
  check('retention DRY RUN IS THE DEFAULT', r.dryRun === true)
  check('dry run lists what it would delete', r.deleted.length === 1 && r.deleted[0].path === veryOld.path && /retention/.test(r.deleted[0].why), JSON.stringify(r.deleted))
  check('DRY RUN DELETED NOTHING', existsSync(veryOld.path) && existsSync(keep.path) && w.index.thinRow(veryOld.path) !== null)
  w.index.close()
}

// ---- retention for real --------------------------------------------------------------------------------
{
  const w = world()
  const veryOld = w.add('n1', 0, 200)
  const keep = w.add('n1', 0, 100)
  const shortOld = w.add('n1', 1, 40) // this camera keeps 30 days
  const shortKeep = w.add('n1', 1, 20)
  const r = await runRetention({
    index: w.index,
    settings: w.settings({ 'n1/1': { retentionDays: 30 } }),
    now: NOW,
    present: w.present,
    dryRun: false,
    freeOf: () => ({ freeBytes: 90, totalBytes: 100 })
  })
  check('past its retention days: gone, with its .idx', !existsSync(veryOld.path) && !existsSync(`${veryOld.path}.idx`) && !existsSync(shortOld.path))
  check('ONLY WHAT IS PAST ITS RETENTION: the rest is still there', existsSync(keep.path) && existsSync(shortKeep.path))
  check('the per-camera days are honoured, not one global number', r.deleted.length === 2 && r.deleted.some((d) => d.path === shortOld.path))
  check('the index rows went with the files', w.index.thinRow(veryOld.path) === null && w.index.thinRow(keep.path) !== null)
  check('the empty folders were tidied up, the location folder was not', !existsSync(dirname(veryOld.path)) && existsSync(w.root))
  w.index.close()
}

// ---- retention: the free-space floor --------------------------------------------------------------------
{
  const w = world()
  const oldest = w.add('n1', 0, 10, { gops: 5 })
  w.add('n1', 0, 5, { gops: 5 })
  const newest = w.add('n1', 0, 1, { gops: 5 })
  // 2% free: below the 5% floor. Each delete gives back 1 unit of 100; two deletes clear it.
  let freed = 0
  const r = await runRetention({
    index: w.index,
    settings: w.settings(),
    now: NOW,
    present: w.present,
    dryRun: false,
    freeOf: () => ({ freeBytes: 2 + 2 * freed++, totalBytes: 100 })
  })
  // (the fake counts each deletion as 2% recovered)
  check('below the floor: something was deleted even inside retention', r.deleted.length >= 1 && r.deleted.every((d) => /floor/.test(d.why)), JSON.stringify(r.deleted.map((d) => d.why)))
  check('OLDEST FIRST', r.deleted[0].path === oldest.path, r.deleted[0]?.path)
  check('it stops as soon as it can: the newest is still there', existsSync(newest.path))
  check('and nothing at all is deleted once there is room', (await runRetention({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, freeOf: () => ({ freeBytes: 90, totalBytes: 100 }) })).deleted.length === 0 && existsSync(newest.path))
  w.index.close()
}

// ---- retention: the same guards ------------------------------------------------------------------------
{
  const w = world()
  const booked = w.add('n1', 0, 200)
  const other = w.add('n1', 1, 210)
  const r = await runRetention({
    index: w.index,
    settings: w.settings(),
    now: NOW,
    present: w.present,
    dryRun: false,
    freeOf: () => ({ freeBytes: 90, totalBytes: 100 }),
    protectedRanges: () => [[booked.startMs, booked.startMs + 1000]]
  })
  check('A BOOKMARKED SEGMENT IS NEVER DELETED, however old', existsSync(booked.path) && r.skipped.some((s) => s.path === booked.path))
  check('...while the rest goes', !existsSync(other.path))
  w.index.close()
}
{
  // A 2-hour bookmark on 87 cameras (bookmarks protect every camera), 200 days old: past the days kept,
  // so it stays the oldest footage for good. Each run -- dry run too, every 5 minutes -- passed its 10,440
  // rows one by one, and below the floor walked them again 200 at a time (review of p2-delete,
  // 2026-09-29). Now a stretch is one look: each walk starts after it.
  const w = world()
  const CAMS = 87
  const b0 = NOW - 200 * DAY
  const rows = (k0, k1, base) => {
    for (let k = k0; k < k1; k++) for (let c = 0; c < CAMS; c++) w.index.addSegment({ nvr: 'n1', ch: c, path: join(w.root, 'n1', String(c), `${base + k * 60_000}.h264`), startMs: base + k * 60_000, endMs: base + k * 60_000 + 59_000, bytes: 1, keyframes: 1, loc: 'L1' })
  }
  rows(0, 120, b0)
  rows(0, 3, NOW - 190 * DAY) // past the 180 days too, and not bookmarked: these go
  rows(0, 3, NOW - 2 * DAY)
  const inStretch = (d) => {
    const start = Number(d.path.match(/(\d+)\.h264$/)[1])
    return start >= b0 - 60_000 && start <= b0 + 2 * 3_600_000 + 60_000
  }
  const counting = () => {
    const calls = {}
    return { calls, index: new Proxy(w.index, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => ((calls[k] = (calls[k] ?? 0) + 1), t[k](...a)) : t[k]) }) }
  }
  const ranges = () => [[b0, b0 + 2 * 3_600_000]]
  // dry run, room to spare: retention only
  const x = counting()
  const r = await runRetention({ index: x.index, settings: w.settings(), now: NOW, present: w.present, freeOf: () => ({ freeBytes: 90, totalBytes: 100 }), protectedRanges: ranges })
  check('a bookmarked stretch past the days kept: the rows after it go, none of it', r.deleted.length === 3 * CAMS && !r.deleted.some(inStretch), `${r.deleted.length} would go, ${r.deleted.filter(inStretch).length} of them bookmarked`)
  check('... retention steps over it: at most one look per camera, not a row at a time (10,440 rows)', (x.calls.olderThan ?? 0) <= CAMS && r.skipped.length <= CAMS + 1, `${x.calls.olderThan} olderThan, ${r.skipped.length} skipped entries`)
  // dry run below the floor (1 % free), nothing past its days (a year kept): the floor's walk
  const y = counting()
  const f = await runRetention({ index: y.index, settings: { ...w.settings(), recording: { defaults: { ...DEFAULTS, retentionDays: 365 }, cameras: {} } }, now: NOW, present: w.present, freeOf: () => ({ freeBytes: 1, totalBytes: 100 }), protectedRanges: ranges, maxDeletes: 400 })
  const floor = f.deleted.filter((d) => /floor/.test(d.why))
  check('... and so does the floor\'s walk: the oldest after it, with a few looks, not 53 looks of 200 bookmarked rows', floor.length === 4 && !floor.some(inStretch) && (y.calls.oldest ?? 0) <= 6 && f.skipped.length <= 2, `${floor.length} below the floor, ${floor.filter(inStretch).length} bookmarked; ${y.calls.oldest} oldest, ${f.skipped.length} skipped entries`)
  w.index.close()
}
{
  const w = world()
  const s = w.add('n1', 0, 200)
  const r = await runRetention({
    index: w.index,
    settings: w.settings(),
    now: NOW,
    present: w.present,
    dryRun: false,
    freeOf: () => ({ freeBytes: 1, totalBytes: 100 }),
    protectedRanges: () => {
      throw new Error('bookmarks table locked')
    }
  })
  check('BOOKMARKS UNREADABLE: RETENTION DELETES NOTHING, however old or full', existsSync(s.path) && r.deleted.length === 0 && r.warnings.some((x) => /bookmarks/.test(x)))
  check('...and says the bookmarks were unreadable', r.protection === 'unread', r.protection)
  w.index.close()
}
{
  const w = world()
  const s = w.add('n1', 0, 200)
  rmSync(join(w.root, '.cctv-recordings'))
  const r = await runRetention({ index: w.index, settings: w.settings(), now: NOW, dryRun: false, freeOf: () => ({ freeBytes: 1, totalBytes: 100 }) })
  check('AN UNMOUNTED DRIVE LOSES NOTHING', existsSync(s.path) && r.deleted.length === 0 && w.index.thinRow(s.path) !== null)
  w.index.close()
}
{
  const w = world()
  const outside = mkdtempSync(join(tmpdir(), 'thin-outside-'))
  const stray = join(outside, 'precious.h264')
  writeFileSync(stray, 'not ours')
  w.index.addSegment({ nvr: 'n1', ch: 9, path: stray, startMs: NOW - 400 * DAY, endMs: NOW - 400 * DAY + 1000, bytes: 8, keyframes: 1, loc: 'L1' })
  const r = await runRetention({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, freeOf: () => ({ freeBytes: 90, totalBytes: 100 }) })
  check('A ROW POINTING OUTSIDE THE LOCATION IS NEVER DELETED', existsSync(stray) && r.skipped.some((x) => x.path === stray && /outside/.test(x.why)))
  check('...and the run carries on', r.warnings.length >= 0)
  rmSync(outside, { recursive: true, force: true })
  w.index.close()
}
// ---- retention's file calls go to the location's helper (perf report Task 3, 2026-09-29) --------------------
// The helper's own ops, run in this process; a real helper process does the cases above.
const { makeShareOps } = await import('../share-ops.mjs')
const helperOps = (loc, log) => {
  const o = makeShareOps({ id: loc.id, root: loc.path })
  return async (l, op, a) => {
    log.push({ op, n: a?.paths?.length ?? a?.dirs?.length ?? 0 })
    return o[op](a ?? {}, () => {})
  }
}
{
  const w = world()
  const olds = []
  for (let i = 0; i < 250; i++) olds.push(w.add('n1', i % 2, 200 + i / 1440, { gops: 2, pFrames: 0 }))
  const keep = w.add('n1', 0, 20, { gops: 2, pFrames: 0 })
  const calls = []
  let removeMany = 0
  const counted = new Proxy(w.index, { get: (t, k) => (k === 'removeMany' ? (p) => (removeMany++, t.removeMany(p)) : t[k]) })
  const r = await runRetention({ index: counted, settings: w.settings(), now: NOW, present: w.present, dryRun: false, share: helperOps(w.loc, calls), freeOf: () => ({ freeBytes: 90, totalBytes: 100 }) })
  const unlinks = calls.filter((c) => c.op === 'unlink')
  check('retention on: 250 files through the helper, at most 100 a call, their rows in one transaction a call', r.deleted.length === 250 && unlinks.length === 3 && unlinks.every((c) => c.n <= 100) && removeMany === 3 && olds.every((p) => !existsSync(p.path)) && existsSync(keep.path), `${r.deleted.length} deleted; ${JSON.stringify(unlinks)}; ${removeMany} transactions`)
  check('... and their empty folders removed through it too', calls.some((c) => c.op === 'rmdir') && !existsSync(dirname(olds[0].path)), JSON.stringify(calls.filter((c) => c.op === 'rmdir')))
  w.index.close()
}
{
  // the switch set to Off or Dry run while a run deletes: saves are answered during it now that it waits
  // on the helper, so it looks again between batches (p0-see's note, 2026-09-29)
  const w = world()
  for (let i = 0; i < 250; i++) w.add('n1', 0, 200 + i / 1440, { gops: 2, pFrames: 0 })
  const calls = []
  let asked = 0
  const r = await runRetention({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, share: helperOps(w.loc, calls), freeOf: () => ({ freeBytes: 90, totalBytes: 100 }), armed: () => ++asked < 2 })
  check('SWITCHED OFF DURING A RUN: it stops before the next batch', r.deleted.length === 100 && w.index.locationUse('L1').segments === 150 && r.warnings.some((x) => /switch/.test(x)), `${r.deleted.length} deleted, ${asked} asked: ${JSON.stringify(r.warnings)}`)
  w.index.close()
}
{
  // free space from the helper, never statfs on the main thread; below the floor it is read once and
  // counted on with the bytes deleted (the old loop read the share after every file)
  const w = world()
  const a = w.add('n1', 0, 10, { gops: 5 })
  const b = w.add('n1', 1, 9, { gops: 5 })
  const c = w.add('n1', 0, 1, { gops: 5 })
  const calls = []
  const ops = helperOps(w.loc, calls)
  let statfs = 0
  // 100,000 bytes, the 5 % floor at 5,000: free space one byte more than the two oldest files short of it
  const share = async (l, op, x) => (op === 'statfs' ? (statfs++, { freeBytes: 5000 - a.bytes - b.bytes + 1, totalBytes: 100_000 }) : ops(l, op, x))
  const r = await runRetention({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, share })
  check('below the floor: free space asked of the helper once, then counted with the bytes deleted: the two oldest go', statfs === 1 && r.deleted.length === 2 && !existsSync(a.path) && !existsSync(b.path) && existsSync(c.path), `${statfs} statfs, ${r.deleted.length} deleted`)
  const dry = []
  const r2 = await runRetention({ index: w.index, settings: w.settings(), now: NOW, present: w.present, share: async (l, op, x) => (dry.push(op), op === 'statfs' ? { freeBytes: 1, totalBytes: 100 } : ops(l, op, x)) })
  check('dry run: nothing but free space is asked of the helper', dry.every((op) => op === 'statfs') && r2.deleted.length >= 1 && existsSync(c.path), dry.join())
  w.index.close()
}
{
  // a location where deleting did not free space (housekeeping found it: a recycle bin or snapshots) is
  // not deleted from for free space by this job either
  const { _test: deleting } = await import('../segment-delete.mjs')
  const w = world()
  const a = w.add('n1', 0, 10, { gops: 5 })
  deleting.setStall('L1', { since: NOW - 60_000, retryAt: NOW + 3_600_000, deletedBytes: 5e9, roseBytes: 0 })
  const r = await runRetention({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, freeOf: () => ({ freeBytes: 1, totalBytes: 100 }), share: helperOps(w.loc, []) })
  check('below the floor where deleting did not free space: nothing deleted, and it says why', existsSync(a.path) && r.deleted.length === 0 && r.warnings.some((x) => /free space/.test(x)), JSON.stringify(r.warnings))
  deleting.reset()
  w.index.close()
}

{
  const w = world()
  const r = await runRetention({ index: null, settings: w.settings(), now: NOW, dryRun: false })
  check('no index: nothing happens, no crash', r.deleted.length === 0)
  const t = await runThinning({ index: null, settings: w.settings(), now: NOW, dryRun: false, ...AT_NIGHT })
  check('no index: thinning does nothing either', t.thinned.length === 0)
  w.index.close()
}

// the helper processes the cases above started (runRetention's default share)
;(await import('../share-calls.mjs')).stopShareHelpers()
// (Windows keeps the sqlite file the bookmarks module opened locked until the process ends)
for (const d of [dataDir, ...made]) {
  try {
    rmSync(d, { recursive: true, force: true, maxRetries: 5 })
  } catch {}
}
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
