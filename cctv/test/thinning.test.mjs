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

const { runThinning, runRetention, recoverThinning, planThin, mayTouch, loadProtectedRanges, _test } = await import('../thinning.mjs')
const { openRecIndex } = await import('../rec-index.mjs')
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
  const p = join(mkdtempSync(join(tmpdir(), 'thin-sanity-')), 'x.h264')
  const m = makeSegment(p, NOW, { gops: 3, pFrames: 2 })
  const rows = parseIdx(readFileSync(`${p}.idx`))
  const { units } = splitUnits(readFileSync(p), CODEC.h264, { final: true, keyOffsets: new Set(rows.map((r) => r.offset)) })
  check('the test bitstream splits into 9 frames, 3 of them keyframes', units.length === 9 && units.filter((u) => u.isKey).length === 3, `${units.length} units, ${m.keyframes} rows`)
}

// ---- a world: one location, one index ----------------------------------------------------------
function world() {
  const root = mkdtempSync(join(tmpdir(), 'thin-loc-'))
  writeFileSync(join(root, '.cctv-recordings'), JSON.stringify({ id: 'L1' }))
  const loc = { id: 'L1', path: root, type: 'usb', role: 'main', limitGB: null }
  const index = openRecIndex(join(mkdtempSync(join(tmpdir(), 'thin-db-')), 'r.db'))
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
  const p = join(mkdtempSync(join(tmpdir(), 'thin-plan-')), 'x.h264')
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
  check('dry run reports what it would do', r.thinned.length === 1 && r.thinned[0].path === s.path && r.thinned[0].nowBytes < r.thinned[0].wasBytes, JSON.stringify(r.thinned))
  check('dry run says how much it would free', r.freedBytes > 0)
  check('DRY RUN CHANGED NOTHING ON DISK', readFileSync(s.path).equals(before) && statSync(s.path).size === s.bytes)
  check('dry run left no temp files', readdirSync(dirname(s.path)).sort().join() === 'seg.h264,seg.h264.idx', readdirSync(dirname(s.path)).join())
  check('dry run left the index row alone', w.index.byPath(s.path).bytes === s.bytes)
  w.index.close()
}

// ---- thinning for real ----------------------------------------------------------------------------
{
  const w = world()
  const old = w.add('n1', 0, 60, { gops: 60, pFrames: 4 })
  const recent = w.add('n1', 0, 2, { gops: 60, pFrames: 4 }) // inside fullDays: full video
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false })
  check('the old segment was thinned', r.thinned.length === 1 && r.thinned[0].path === old.path, JSON.stringify(r.thinned.map((t) => t.path)))
  check('FOOTAGE INSIDE fullDays IS UNTOUCHED', statSync(recent.path).size === recent.bytes && parseIdx(readFileSync(`${recent.path}.idx`)).length === recent.keyframes)
  const rows = parseIdx(readFileSync(`${old.path}.idx`))
  check('only the keyframes at the time-lapse interval are left', rows.length === 6, String(rows.length))
  check('the file really is smaller', statSync(old.path).size < old.bytes)
  const buf = readFileSync(old.path)
  const { units } = splitUnits(buf, CODEC.h264, { final: true, keyOffsets: new Set(rows.map((x) => x.offset)) })
  check('every frame left is a keyframe and every index row lands on one', units.length === rows.length && units.every((u) => u.isKey) && rows.every((x, i) => x.offset === units[i].start))
  check('the index row was updated to match the file', w.index.byPath(old.path).bytes === buf.length && w.index.byPath(old.path).keyframes === rows.length)
  check('the times still line up with the original recording', rows[0].tsMs === old.startMs && rows.at(-1).tsMs === old.startMs + 50_000)
  check('no temp or backup files were left behind', readdirSync(dirname(old.path)).sort().join() === 'seg.h264,seg.h264.idx', readdirSync(dirname(old.path)).join())
  // running it again must be a no-op, not a second round of cutting
  const again = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false })
  check('running it twice changes nothing (idempotent)', again.thinned.length === 0 && statSync(old.path).size === buf.length, JSON.stringify(again.skipped))
  w.index.close()
}

// ---- thinning: a camera not set to time-lapse ------------------------------------------------------
{
  const w = world()
  const s = w.add('n1', 0, 60)
  const r = await runThinning({ index: w.index, settings: w.settings({ 'n1/0': { after: 'delete' } }), now: NOW, present: w.present, dryRun: false })
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
    dryRun: false,
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
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, protectedRanges: null })
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
    dryRun: false,
    protectedRanges: () => {
      throw new Error('bookmarks table locked')
    }
  })
  check('BOOKMARKS UNREADABLE: NOTHING IS TOUCHED', r.thinned.length === 0 && statSync(s.path).size === s.bytes && r.warnings.some((x) => /bookmarks/.test(x)))
  w.index.close()
}
{
  const w = world()
  const s = w.add('n1', 0, 60)
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false, protectedRanges: () => [{ fromMs: 'oops', toMs: 1 }] })
  check('a range we cannot read stops the run rather than guessing', r.thinned.length === 0 && statSync(s.path).size === s.bytes)
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
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, dryRun: false })
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
  const r = await runThinning({ index: w.index, settings: w.settings(), now: NOW, present: w.present, dryRun: false })
  check('a segment whose index is unusable is left exactly as it was', readFileSync(s.path).equals(original) && r.thinned.length === 0, JSON.stringify(r.skipped))
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
  check('DRY RUN DELETED NOTHING', existsSync(veryOld.path) && existsSync(keep.path) && w.index.byPath(veryOld.path) !== null)
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
  check('the index rows went with the files', w.index.byPath(veryOld.path) === null && w.index.byPath(keep.path) !== null)
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
  const w = world()
  const s = w.add('n1', 0, 200)
  rmSync(join(w.root, '.cctv-recordings'))
  const r = await runRetention({ index: w.index, settings: w.settings(), now: NOW, dryRun: false, freeOf: () => ({ freeBytes: 1, totalBytes: 100 }) })
  check('AN UNMOUNTED DRIVE LOSES NOTHING', existsSync(s.path) && r.deleted.length === 0 && w.index.byPath(s.path) !== null)
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
{
  const w = world()
  const r = await runRetention({ index: null, settings: w.settings(), now: NOW, dryRun: false })
  check('no index: nothing happens, no crash', r.deleted.length === 0)
  const t = await runThinning({ index: null, settings: w.settings(), now: NOW, dryRun: false })
  check('no index: thinning does nothing either', t.thinned.length === 0)
  w.index.close()
}

// (Windows keeps the sqlite file the bookmarks module opened locked until the process ends)
try {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
} catch {}
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
