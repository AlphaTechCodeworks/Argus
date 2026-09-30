// Tests for the share helper: one long-lived process per storage location that makes the file calls
// on it, so that a share whose SMB session has gone stale can hang that process but never the server
// (share-calls.mjs on the server's side, share-helper.mjs + share-ops.mjs in the child).
//   node cctv/test/share-helper.test.mjs
// Why (perf report R6 / Task 2 and its check verify-6, 2026-09-29): the share check forked the whole
// server every 30 s (about 35 ms of blocked main thread each time, measured on production), and the
// low-space deletion and time-lapse jobs (Tasks 3-4) need somewhere other than the main thread to do
// their NAS file work. No SDK: runs on any PC; the one Linux-only case says so and is skipped elsewhere.
import { EventEmitter } from 'node:events'
import { execFile, fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, get } from 'node:http'
import { createConnection, createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { shareCall, SHARE_ANSWER_MS, onShareStuck, shareStuckFor, keepShareHelpers, stopShareHelpers, _test } = await import('../share-calls.mjs')
const { healthOf, MARKER } = await import('../location-health.mjs')
const { planThin, buildThinned, codecOf } = await import('../thin-file.mjs')
const { parseIdx } = await import('../segment-writer.mjs')

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settle = (p) => p.then((v) => ({ v }), (e) => ({ e }))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
async function until(fn, ms = 3000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(20)) if (fn()) return true
  return fn()
}
/**
 * The main thread's longest busy stretch from beat() to the returned stop(): between two runs of a
 * 5 ms timer, the time that passed less the time the loop sat idle waiting for events (as
 * loop-lag.mjs measures a pause). A synchronous call -- a fork, a file call -- counts in full; a timer
 * run late because the PC was busy with other programs does not (this PC ran at 87% CPU while the
 * test was written, and its timers came 30-50 ms apart at random).
 */
function beat() {
  let last = performance.now()
  let lastIdle = performance.nodeTiming.idleTime
  let worst = 0
  const step = () => {
    const now = performance.now()
    const idle = performance.nodeTiming.idleTime
    worst = Math.max(worst, now - last - (idle - lastIdle))
    last = now
    lastIdle = idle
  }
  const t = setInterval(step, 5)
  return () => {
    clearInterval(t)
    step()
    return worst
  }
}
/**
 * The lowest of up to 3 rounds of a timed scenario (fn(round) -> its longest busy stretch), stopping
 * at the first under 50 ms. A synchronous call on the main thread shows in every round; the PC being
 * busy with other programs stretches one now and then (a local web request once read 58 ms here).
 */
async function quietest(fn) {
  const all = []
  for (let round = 0; round < 3; round++) {
    all.push(await fn(round))
    if (all.at(-1) < 50) break
  }
  return { best: Math.min(...all), text: all.map((w) => `${w.toFixed(1)} ms`).join(', ') }
}

const base = mkdtempSync(join(tmpdir(), 'cctv-share-helper-'))
/** A location folder with its marker. */
function location(name, id = `loc-${name}`) {
  const path = join(base, name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, MARKER), JSON.stringify({ id, created: '2026-09-29T00:00:00Z' }))
  return { id, path, type: 'network', role: 'main' }
}

// ---- synthetic H.264, as in thinning.test.mjs -----------------------------------------------------
const nal = (type, payload) => Buffer.concat([Buffer.from([0, 0, 0, 1, type & 0x1f]), Buffer.from(payload)])
const aud = () => nal(9, [0x10])
const frame = (isKey, size = 40) => Buffer.concat([aud(), nal(isKey ? 5 : 1, Buffer.alloc(size, isKey ? 0xa5 : 0x5c).map((v, i) => (i === 0 ? 0x88 : v)))])
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
  return { bytes: buf.length, keyframes: rows.length }
}
const T0 = Date.UTC(2026, 8, 22, 6, 0, 0)

check('the answer time is still 10 s', SHARE_ANSWER_MS === 10_000)
{
  const stop = beat()
  await sleep(30)
  for (const t = performance.now(); performance.now() - t < 100; );
  await sleep(30)
  const worst = stop()
  check('the measure of the main thread sees a 100 ms synchronous block', worst >= 95 && worst < 200, `${worst.toFixed(1)} ms`)
}

// ---- the health check gives exactly what healthOf gives, from another process ---------------------
{
  const good = location('good')
  const h = await shareCall(good, 'probe', { floor: 0 })
  const local = healthOf(good, 0)
  const same = (a, b) => JSON.stringify({ ...a, freeBytes: 0 }) === JSON.stringify({ ...b, freeBytes: 0 })
  check('probe of a healthy share: same as healthOf', same(h, local) && h.ok && h.marker && h.writable && h.totalBytes > 0, JSON.stringify(h))
  check('...answered by a process of its own, not this one', _test.pidOf(good) > 0 && _test.pidOf(good) !== process.pid)
  check('...which left no write-test file behind', readdirSync(good.path).join() === MARKER, readdirSync(good.path).join())
  const cases = [
    ['a folder that is not there', { id: 'loc-gone', path: join(base, 'gone'), type: 'network' }, 0],
    ['a file where the folder should be', (() => {
      writeFileSync(join(base, 'afile'), 'x')
      return { id: 'loc-file', path: join(base, 'afile'), type: 'network' }
    })(), 0],
    ['a folder without its marker (not mounted)', (() => {
      mkdirSync(join(base, 'empty'))
      return { id: 'loc-empty', path: join(base, 'empty'), type: 'network' }
    })(), 0],
    ['a marker of another location', { ...location('other', 'loc-someone-else'), id: 'loc-mine' }, 0],
    ['below the hard floor', good, 101]
  ]
  for (const [what, loc, floor] of cases) {
    const a = await shareCall(loc, 'probe', { floor })
    const b = healthOf(loc, floor)
    check(`probe of ${what}: same as healthOf`, same(a, b) && !a.ok, `${a.reason} | ${b.reason}`)
  }
  const sp = await shareCall(good, 'probe', { floor: 0, speed: true }, { timeoutMs: SHARE_ANSWER_MS * 3 })
  check('probe with the write-speed test: MB/s, and its file removed', sp.ok && sp.writeMBps > 0 && readdirSync(good.path).join() === MARKER, `${sp.writeMBps} ${readdirSync(good.path).join()}`)
}

// ---- one helper per location, kept -------------------------------------------------------------------
{
  let loc
  const busy = await quietest(async (round) => {
    loc = location(`kept-${round}`)
    const forks0 = _test.forks()
    const pids = new Set()
    const stop = beat()
    for (let i = 0; i < 30; i++) {
      await shareCall(loc, 'probe', { floor: 0 })
      pids.add(_test.pidOf(loc))
    }
    const worst = stop()
    check(`30 checks: one process forked, and the same one answered every time (round ${round + 1})`, _test.forks() - forks0 === 1 && pids.size === 1, `${_test.forks() - forks0} forks, ${pids.size} pids`)
    return worst
  })
  check('...the main thread never busy for 50 ms at a stretch (the fork included)', busy.best < 50, busy.text)
  const other = location('kept-other')
  await shareCall(other, 'statfs')
  check('another location gets a process of its own', _test.pidOf(other) !== _test.pidOf(loc))
  const gone = _test.pidOf(other)
  keepShareHelpers([loc, { id: 'no-path' }, null]) // a hand-edited entry without a path is passed over
  check('a location no longer in the list: its helper is stopped', await until(() => !alive(gone)) && _test.pidOf(other) === null && _test.pidOf(loc) > 0)
}

// ---- the file calls ------------------------------------------------------------------------------------
{
  const loc = location('ops', 'L1')
  const seg = join(loc.path, 'n1', '0', '2026-09-22', '06', '00.h264')
  const seg2 = join(loc.path, 'n1', '0', '2026-09-22', '06', '01.h264')
  const other = join(loc.path, 'n1', '1', '2026-09-22', '06', '00.h264')
  makeSegment(seg, T0)
  makeSegment(seg2, T0 + 60_000)
  makeSegment(other, T0)
  const outside = join(base, 'not-ours.h264')
  writeFileSync(outside, 'someone else')
  writeFileSync(`${outside}.idx`, 'someone else')

  const f = await shareCall(loc, 'statfs')
  check('statfs: free and total bytes of the location', f.totalBytes > 0 && f.freeBytes >= 0 && f.freeBytes <= f.totalBytes, JSON.stringify(f))
  const st = await shareCall(loc, 'stat', { paths: [seg, join(loc.path, 'nope')] })
  check('stat: size of each, and the code for one that is not there', st[0].size === readFileSync(seg).length && st[0].isFile === true && st[1].error === 'ENOENT', JSON.stringify(st))
  const ls = await shareCall(loc, 'readdir', { dirs: [dirname(seg), join(loc.path, 'nope')] })
  check('readdir: the names in each folder, files and folders told apart', ls[0].entries.map((e) => e.name).sort().join() === '00.h264,00.h264.idx,01.h264,01.h264.idx' && ls[0].entries.every((e) => e.file && !e.dir) && ls[1].error === 'ENOENT', JSON.stringify(ls))
  const top = await shareCall(loc, 'readdir', { dirs: [loc.path] })
  check('readdir of the location itself is allowed', top[0].entries.some((e) => e.name === 'n1' && e.dir), JSON.stringify(top))

  const refusedStat = await settle(shareCall(loc, 'stat', { paths: [outside] }))
  check('stat outside the location: refused, nothing read', refusedStat.v?.[0]?.error === 'EOUTSIDE', JSON.stringify(refusedStat.v ?? refusedStat.e?.message))

  // segInfo: what crash recovery needs of a file left open (rec-recover.mjs), read by the helper so the
  // server makes no file call on the share after a worker restart (perf report R8, 2026-09-30): its
  // size and last change, and its .idx's keyframes within that size (a row past the end: torn, not counted)
  {
    const lone = join(loc.path, 'n1', '2', '2026-09-22', '06', '07.h264')
    mkdirSync(dirname(lone), { recursive: true })
    writeFileSync(lone, Buffer.alloc(300, 1)) // no .idx: the worker died between the two opens
    const torn = join(loc.path, 'n1', '2', '2026-09-22', '06', '08.h264')
    writeFileSync(torn, Buffer.alloc(200, 1))
    const rows = Buffer.alloc(3 * 16 + 7)
    ;[[0, T0], [150, T0 + 10_000], [900, T0 + 20_000]].forEach(([o, t], i) => (rows.writeBigUInt64LE(BigInt(o), i * 16), rows.writeBigInt64LE(BigInt(t), i * 16 + 8)))
    writeFileSync(`${torn}.idx`, rows)
    const info = await settle(shareCall(loc, 'segInfo', { paths: [seg, lone, torn, join(loc.path, 'nope.h264'), outside] }))
    const [a, b, c, d, e] = info.v ?? []
    const idx = parseIdx(readFileSync(`${seg}.idx`))
    check('segInfo: size and last change of a segment, and its keyframes: how many, the first and the last', a?.size === readFileSync(seg).length && a.isFile === true && a.mtimeMs > 0 && a.keyframes === idx.length && a.firstKeyMs === idx[0].tsMs && a.lastKeyMs === idx.at(-1).tsMs, JSON.stringify(a ?? info.e?.message))
    check('segInfo: no .idx is no keyframes, not an error', b?.size === 300 && b.keyframes === 0 && b.firstKeyMs === null && b.lastKeyMs === null, JSON.stringify(b))
    check('segInfo: a torn last row and a row past the file\'s end are not counted', c?.keyframes === 2 && c.firstKeyMs === T0 && c.lastKeyMs === T0 + 10_000, JSON.stringify(c))
    check('segInfo: a file not there is its code; one outside the location is refused, nothing read', d?.error === 'ENOENT' && e?.error === 'EOUTSIDE', JSON.stringify([d, e]))
    rmSync(join(loc.path, 'n1', '2'), { recursive: true })
  }

  const del = await shareCall(loc, 'unlink', { paths: [seg, join(loc.path, 'n1', '0', 'never-there.h264'), outside, join(loc.path, 'n1', '..', '..', 'not-ours.h264'), join(loc.path, MARKER), loc.path], withIdx: true })
  check('unlink: a segment and its .idx are gone', del[0].ok === true && !existsSync(seg) && !existsSync(`${seg}.idx`), JSON.stringify(del[0]))
  check('unlink: one already gone counts as gone', del[1].ok === true, JSON.stringify(del[1]))
  check('unlink outside the location: refused, the file is still there', del[2].ok === false && del[2].error === 'EOUTSIDE' && existsSync(outside) && existsSync(`${outside}.idx`), JSON.stringify(del[2]))
  check('unlink through "..": refused', del[3].ok === false && del[3].error === 'EOUTSIDE' && existsSync(outside), JSON.stringify(del[3]))
  check('unlink of the marker or the location itself: refused', del[4].ok === false && del[5].ok === false && existsSync(join(loc.path, MARKER)), JSON.stringify(del.slice(4)))
  check('...and the neighbours were not touched', existsSync(seg2) && existsSync(other))

  // rmdir: empty folders upwards, never the location, never a folder with anything in it
  const rm1 = await shareCall(loc, 'rmdir', { dirs: [dirname(seg)] })
  check('rmdir of a folder that still has files: nothing removed', rm1[0].removed.length === 0 && existsSync(dirname(seg)), JSON.stringify(rm1))
  await shareCall(loc, 'unlink', { paths: [seg2], withIdx: true })
  const rm2 = await shareCall(loc, 'rmdir', { dirs: [dirname(seg)] })
  check('rmdir: the empty hour, day and camera folders go, up to a folder with something in it', rm2[0].removed.length === 3 && !existsSync(join(loc.path, 'n1', '0')) && existsSync(dirname(other)), JSON.stringify(rm2))
  const rm3 = await shareCall(loc, 'rmdir', { dirs: [base, loc.path] })
  check('rmdir outside or of the location itself: refused', rm3[0].error === 'EOUTSIDE' && rm3[1].error === 'EOUTSIDE' && existsSync(loc.path), JSON.stringify(rm3))

  // the marker is checked before anything is deleted: an unmounted share's mount point is a folder
  // on the system disk, and nothing there is the share's
  const markerText = readFileSync(join(loc.path, MARKER))
  rmSync(join(loc.path, MARKER))
  const noMarker = await settle(shareCall(loc, 'unlink', { paths: [other], withIdx: true }))
  check('marker gone: deleting refused, nothing touched', noMarker.e?.code === 'EMARKER' && existsSync(other), noMarker.e?.message)
  const noMarkerRm = await settle(shareCall(loc, 'rmdir', { dirs: [dirname(other)] }))
  check('marker gone: rmdir refused', noMarkerRm.e?.code === 'EMARKER')
  writeFileSync(join(loc.path, MARKER), JSON.stringify({ id: 'L2' }))
  const wrong = await settle(shareCall(loc, 'unlink', { paths: [other], withIdx: true }))
  check("another location's marker: deleting refused", wrong.e?.code === 'EMARKER' && existsSync(other))
  writeFileSync(join(loc.path, MARKER), markerText)
  const bad = await settle(shareCall(loc, 'format', {}))
  check('an unknown call: refused by name', bad.e?.code === 'EBADOP', bad.e?.message)
  const badLoc = await settle(shareCall({ id: 'x', path: 'relative/path' }, 'statfs'))
  check('a location without a full path: refused before any process', badLoc.e instanceof TypeError)
}

// ---- "thin this file": the file work of one time-lapse rewrite, journalled like thinning.mjs's ----
{
  const loc = location('thin', 'LT')
  const dir = join(loc.path, 'n1', '0', '2026-09-22', '06')
  const a = join(dir, '00.h264')
  const orig = makeSegment(a, T0)
  const before = readFileSync(a)
  const listing = () => readdirSync(dir).sort().join()

  // what thinning.mjs would build from the same file
  const plan = planThin(before, parseIdx(readFileSync(`${a}.idx`)), { codec: codecOf(a), timelapseS: 10 })
  const want = buildThinned(before, plan.keep)

  const r = await shareCall(loc, 'thin', { path: a, timelapseS: 10, cursor: null, maxBytes: 512 * 1024 * 1024 })
  check('thin: one keyframe per 10 s kept, the file rewritten', r.outcome === 'thinned' && r.keyframes === 6 && r.droppedKeyframes === orig.keyframes - 6 && r.wasBytes === before.length && r.bytes < before.length, JSON.stringify(r))
  check('...byte for byte what thinning.mjs builds', readFileSync(a).equals(want.bytes) && readFileSync(`${a}.idx`).equals(want.idx))
  check('...the cursor for the next file, and the time span', r.cursor === plan.cursor && r.startMs === T0 && r.endMs === T0 + 50_000, JSON.stringify(r))
  check('...swapped, but not committed: the journal and the original are still there', r.swapped === true && listing() === '00.h264,00.h264.idx,00.h264.idx.thin-old,00.h264.thin-journal,00.h264.thin-old', listing())
  check('...the original, intact, beside it', readFileSync(`${a}.thin-old`).equals(before))
  const c = await shareCall(loc, 'thinCommit', { path: a })
  check('thinCommit: journal and original gone, the rewrite stays', c.committed === true && listing() === '00.h264,00.h264.idx' && readFileSync(a).equals(want.bytes), listing())
  const again = await shareCall(loc, 'thin', { path: a, timelapseS: 10, cursor: null, maxBytes: 512 * 1024 * 1024 })
  check('a file already thin: skipped, untouched, and the cursor still given', again.outcome === 'skipped' && again.why === 'already thin' && Number.isFinite(again.cursor) && readFileSync(a).equals(want.bytes) && listing() === '00.h264,00.h264.idx', JSON.stringify(again))

  // two steps: the rewrite ready beside the original, then swapped in only when asked
  const b = join(dir, '01.h264')
  makeSegment(b, T0 + 60_000)
  const bBefore = readFileSync(b)
  const r2 = await shareCall(loc, 'thin', { path: b, timelapseS: 10, cursor: r.cursor, maxBytes: 512 * 1024 * 1024, swap: false })
  check('thin with swap false: the rewrite is written and checked, the original not touched', r2.outcome === 'thinned' && r2.swapped === false && readFileSync(b).equals(bBefore) && existsSync(`${b}.thin-new`) && existsSync(`${b}.idx.thin-new`) && !existsSync(`${b}.thin-journal`), JSON.stringify(r2))
  check('...the cursor carried over from the file before', r2.startMs === r.cursor + 10_000, `${r2.startMs} vs ${r.cursor + 10_000}`)
  const ab = await shareCall(loc, 'thinAbort', { path: b })
  check('thinAbort: the rewrite thrown away, the original as it was', ab.aborted === true && readFileSync(b).equals(bBefore) && !existsSync(`${b}.thin-new`) && !existsSync(`${b}.idx.thin-new`))
  await shareCall(loc, 'thin', { path: b, timelapseS: 10, cursor: r.cursor, maxBytes: 512 * 1024 * 1024, swap: false })
  const sw = await shareCall(loc, 'thinSwap', { path: b })
  check('thinSwap: swapped in, journal kept until the commit', sw.swapped === true && existsSync(`${b}.thin-journal`) && existsSync(`${b}.thin-old`) && !readFileSync(b).equals(bBefore))
  // a second swap while the first is not committed would move the rewrite over the kept original
  writeFileSync(`${b}.thin-new`, 'x')
  writeFileSync(`${b}.idx.thin-new`, 'x')
  const sw2 = await settle(shareCall(loc, 'thinSwap', { path: b }))
  check('thinSwap again before the commit: refused, the original beside it kept', sw2.e?.code === 'EBADARG' && readFileSync(`${b}.thin-old`).equals(bBefore), sw2.e?.message)
  const th2 = await shareCall(loc, 'thin', { path: b, timelapseS: 10, cursor: null, maxBytes: 1e9 })
  check('thin while a rewrite is not committed: skipped', th2.outcome === 'skipped' && /half done/.test(th2.why) && readFileSync(`${b}.thin-old`).equals(bBefore), JSON.stringify(th2))
  // the helper was lost before the commit (killed, or the server restarted): the index row was not
  // updated, so the original must come back
  const rec = await shareCall(loc, 'thinRecover', { paths: [b] })
  check('thinRecover with the journal there: the original put back, the rewrite gone', rec.rolledBack.join() === b && readFileSync(b).equals(bBefore) && listing().split(',').filter((n) => n.startsWith('01')).join() === '01.h264,01.h264.idx', listing())
  // committed but the tidy-up interrupted: litter, swept up
  writeFileSync(`${a}.thin-old`, 'stale')
  const rec2 = await shareCall(loc, 'thinRecover', { paths: [a] })
  check('thinRecover without a journal: leftovers swept up, the file kept', rec2.sweptUp.join() === a && !existsSync(`${a}.thin-old`) && readFileSync(a).equals(want.bytes))

  const big = await shareCall(loc, 'thin', { path: b, timelapseS: 10, cursor: null, maxBytes: 10 })
  check('bigger than maxBytes: skipped, untouched', big.outcome === 'skipped' && /larger than 10 bytes/.test(big.why) && readFileSync(b).equals(bBefore), JSON.stringify(big))
  const gone = await shareCall(loc, 'thin', { path: join(dir, '59.h264'), timelapseS: 10, cursor: null, maxBytes: 1e9 })
  check('a file that is not there: skipped with the reason', gone.outcome === 'skipped' && /cannot read it \(ENOENT\)/.test(gone.why), JSON.stringify(gone))
  const e = join(dir, '02.h264')
  makeSegment(e, T0 + 120_000)
  writeFileSync(`${e}.idx`, Buffer.alloc(0))
  const noRows = await shareCall(loc, 'thin', { path: e, timelapseS: 10, cursor: null, maxBytes: 1e9 })
  check('no index rows: skipped', noRows.outcome === 'skipped' && noRows.why === 'no index rows', JSON.stringify(noRows))
  const out = await settle(shareCall(loc, 'thin', { path: join(base, 'not-ours.h264'), timelapseS: 10, cursor: null, maxBytes: 1e9 }))
  check('thin outside the location: refused', out.e?.code === 'EOUTSIDE' && readFileSync(join(base, 'not-ours.h264'), 'utf8') === 'someone else', out.e?.message)
  rmSync(join(loc.path, MARKER))
  const noMarker = await settle(shareCall(loc, 'thin', { path: b, timelapseS: 10, cursor: null, maxBytes: 1e9 }))
  check('thin with the marker gone: refused, untouched', noMarker.e?.code === 'EMARKER' && readFileSync(b).equals(bBefore))
}
{
  // The share unmounted between the marker read and the file's: its mount point is an empty folder, where
  // the file is "not there". That is EMARKER (the server stops the location and leaves the row as it was),
  // not "cannot read it (ENOENT)", which the server takes for a file really gone and marks for good, so
  // the file would stay full video for ever (review of p3-thin, 2026-09-29). The helper's own ops, in this
  // process: tick() after the marker read is the moment the share goes.
  const { makeShareOps } = await import('../share-ops.mjs')
  const loc = location('thin-unmounted', 'LU')
  const p = join(loc.path, 'n1', '0', '2026-09-22', '06', '00.h264')
  makeSegment(p, T0)
  const ops = makeShareOps({ id: loc.id, root: loc.path })
  const aside = join(base, 'thin-unmounted-away')
  let ticks = 0
  const unmount = () => {
    if (ticks++ === 0) renameSync(loc.path, aside) // the share's files go with it; an empty folder is left
    if (ticks === 1) mkdirSync(loc.path)
  }
  const gone = await settle(ops.thin({ path: p, timelapseS: 10, cursor: null, maxBytes: 1e9, swap: false }, unmount))
  check('THE SHARE UNMOUNTED AFTER THE MARKER READ: the file "not there" is EMARKER, not a file gone for good', gone.e?.code === 'EMARKER', JSON.stringify(gone.v ?? gone.e?.message))
  rmSync(loc.path, { recursive: true, force: true })
  renameSync(aside, loc.path)
  const still = await settle(ops.thin({ path: join(dirname(p), '59.h264'), timelapseS: 10, cursor: null, maxBytes: 1e9, swap: false }, () => {}))
  check('... while with the marker there a file not there is still "cannot read it (ENOENT)"', still.v?.outcome === 'skipped' && /cannot read it \(ENOENT\)/.test(still.v.why), JSON.stringify(still.v ?? still.e?.message))
}
{
  // thinRecover likewise (review of p3-thin, round 2, 2026-09-30). The helper killed mid-swap -- the journal, the
  // original set aside as .thin-old, the rewrite as .thin-new, the segment missing -- then the share unmounted
  // just after thinRecover read its marker: in the empty mount point it found nothing of the path and said
  // nothing of it, and the server, whose stat then said ENOENT, dropped it from thin_inflight as "deleted
  // meanwhile", with the journal, the original and the rewrite still on the share. Now EMARKER, nothing touched.
  const { makeShareOps } = await import('../share-ops.mjs')
  const { thinNames } = await import('../thin-file.mjs')
  const loc = location('recover-unmounted', 'LR')
  const p = join(loc.path, 'n1', '0', '2026-09-22', '06', '00.h264')
  makeSegment(p, T0)
  const orig = { seg: readFileSync(p), idx: readFileSync(`${p}.idx`) }
  const n = thinNames(p)
  writeFileSync(n.journal, '{"path":"x"}\n')
  renameSync(n.seg, n.oldSeg)
  renameSync(n.idx, n.oldIdx)
  writeFileSync(n.newSeg, 'a rewrite')
  writeFileSync(n.newIdx, Buffer.alloc(16))
  const ops = makeShareOps({ id: loc.id, root: loc.path })
  const aside = join(base, 'recover-unmounted-away')
  let ticks = 0
  const unmount = () => {
    if (ticks++ === 0) {
      renameSync(loc.path, aside) // the share's files go with it; an empty folder is left
      mkdirSync(loc.path)
    }
  }
  const r = await settle(ops.thinRecover({ paths: [p] }, unmount))
  check('THINRECOVER WITH THE SHARE UNMOUNTED JUST AFTER ITS MARKER READ: EMARKER, not a path said nothing of', r.e?.code === 'EMARKER', JSON.stringify(r.v ?? r.e?.message))
  rmSync(loc.path, { recursive: true, force: true })
  renameSync(aside, loc.path)
  check('... everything beside it on the share as it was', existsSync(n.journal) && readFileSync(n.oldSeg).equals(orig.seg) && readFileSync(n.oldIdx).equals(orig.idx) && existsSync(n.newSeg) && !existsSync(n.seg))
  const back = await ops.thinRecover({ paths: [p] }, () => {})
  check('... and with the share back, the original put back, byte for byte', back.rolledBack.join() === p && readFileSync(p).equals(orig.seg) && readFileSync(`${p}.idx`).equals(orig.idx) && readdirSync(dirname(p)).sort().join() === '00.h264,00.h264.idx', JSON.stringify(back))
  // gone for good: nothing of it, nor beside it, with the marker there -- said so, for the server to stop keeping it
  const g = join(dirname(p), '01.h264')
  const gone = await ops.thinRecover({ paths: [g] }, () => {})
  check('a path with nothing of it left, the marker there: said gone (the server stops keeping it in flight)', gone.gone?.join() === g && gone.rolledBack.length === 0 && gone.left.length === 0 && gone.sweptUp.length === 0, JSON.stringify(gone))
}

// ---- a swap that did not finish is never committed, and its original never swept up ----------------
// Review of p1-helper (2026-09-29): thinCommit trusted that the swap had finished. After one that
// stopped half way (a rename that failed, or the helper lost just after `seg -> .thin-old`), a
// thinCommit (a caller's bug, or a commit sent again) deleted the journal and then the original, and
// left the rewrite only as .thin-new; the next thinRecover, finding no journal, swept that up too:
// nothing of the footage left. In thinning.mjs the swap and the commit are one synchronous call, so
// this could not happen there; over the helper they are separate calls.
{
  const loc = location('unfinished', 'LU')
  const dir = join(loc.path, 'n1', '0', '2026-09-22', '07')
  const snapshot = () => readdirSync(dir).sort().map((f) => `${f}:${readFileSync(join(dir, f)).toString('base64')}`).join('|')
  const namesOf = (p) => readdirSync(dir).filter((f) => f.startsWith(basename(p))).sort().join()
  let k = 0
  /** A segment with its rewrite written and checked beside it (thin, swap false), not swapped in. */
  async function ready() {
    const p = join(dir, `${String(k).padStart(2, '0')}.h264`)
    makeSegment(p, T0 + 3_600_000 + k++ * 60_000)
    const orig = { seg: readFileSync(p), idx: readFileSync(`${p}.idx`) }
    const r = await shareCall(loc, 'thin', { path: p, timelapseS: 10, cursor: null, maxBytes: 1e9, swap: false })
    if (r.outcome !== 'thinned') throw new Error(`setup: ${JSON.stringify(r)}`)
    return { p, orig, name: basename(p), journal: () => writeFileSync(`${p}.thin-journal`, `${JSON.stringify({ path: p })}\n`) }
  }
  const isOriginal = (s) => readFileSync(s.p).equals(s.orig.seg) && readFileSync(`${s.p}.idx`).equals(s.orig.idx)
  const unfinished = /^EBADARG: the swap did not finish: thinRecover puts the original back/

  {
    // the swap's first steps and no more: the journal, then the original set aside
    const s = await ready()
    s.journal()
    renameSync(s.p, `${s.p}.thin-old`)
    renameSync(`${s.p}.idx`, `${s.p}.idx.thin-old`)
    const snap = snapshot()
    const c = await settle(shareCall(loc, 'thinCommit', { path: s.p }))
    check('thinCommit after a swap that stopped with the original set aside: refused, nothing touched', c.e?.code === 'EBADARG' && unfinished.test(c.e.message) && snapshot() === snap, c.e?.message ?? JSON.stringify(c.v))
    const rb = await shareCall(loc, 'thinRecover', { paths: [s.p] })
    check('...and thinRecover then puts the original back byte for byte, with nothing else left', rb.rolledBack.join() === s.p && isOriginal(s) && namesOf(s.p) === `${s.name},${s.name}.idx`, `${JSON.stringify(rb)} ${namesOf(s.p)}`)
  }
  {
    // stopped one rename short: the rewrite in place, its .idx not yet
    const s = await ready()
    s.journal()
    renameSync(s.p, `${s.p}.thin-old`)
    renameSync(`${s.p}.idx`, `${s.p}.idx.thin-old`)
    renameSync(`${s.p}.thin-new`, s.p)
    const snap = snapshot()
    const c = await settle(shareCall(loc, 'thinCommit', { path: s.p }))
    check('thinCommit after a swap one rename short of the end: refused, nothing touched', c.e?.code === 'EBADARG' && unfinished.test(c.e.message) && snapshot() === snap, c.e?.message ?? JSON.stringify(c.v))
    const rb = await shareCall(loc, 'thinRecover', { paths: [s.p] })
    check('...and thinRecover puts the original back byte for byte', rb.rolledBack.join() === s.p && isOriginal(s) && namesOf(s.p) === `${s.name},${s.name}.idx`, `${JSON.stringify(rb)} ${namesOf(s.p)}`)
  }
  {
    // a roll-back that stopped half way: the original segment back, its .idx still beside it
    const s = await ready()
    s.journal()
    renameSync(s.p, `${s.p}.thin-old`)
    renameSync(`${s.p}.idx`, `${s.p}.idx.thin-old`)
    renameSync(`${s.p}.thin-new`, s.p)
    renameSync(`${s.p}.idx.thin-new`, `${s.p}.idx`)
    renameSync(`${s.p}.thin-old`, s.p)
    const snap = snapshot()
    const c = await settle(shareCall(loc, 'thinCommit', { path: s.p }))
    check('thinCommit during a roll-back that stopped half way: refused, nothing touched', c.e?.code === 'EBADARG' && unfinished.test(c.e.message) && snapshot() === snap, c.e?.message ?? JSON.stringify(c.v))
    const rb = await shareCall(loc, 'thinRecover', { paths: [s.p] })
    check('...and thinRecover finishes the roll-back: the original pair, byte for byte', rb.rolledBack.join() === s.p && isOriginal(s) && namesOf(s.p) === `${s.name},${s.name}.idx`, `${JSON.stringify(rb)} ${namesOf(s.p)}`)
  }
  {
    // nothing swapped at all (thin with swap false, then a commit by mistake)
    const s = await ready()
    const snap = snapshot()
    const c = await settle(shareCall(loc, 'thinCommit', { path: s.p }))
    check('thinCommit with no swap made: refused, the original and the rewrite waiting both untouched', c.e?.code === 'EBADARG' && /no swap waiting to be committed/.test(c.e.message) && snapshot() === snap, c.e?.message ?? JSON.stringify(c.v))
  }
  {
    // a commit sent twice: the second finds nothing to commit and touches nothing
    const s = await ready()
    await shareCall(loc, 'thinSwap', { path: s.p })
    await shareCall(loc, 'thinCommit', { path: s.p })
    const snap = snapshot()
    const c = await settle(shareCall(loc, 'thinCommit', { path: s.p }))
    check('thinCommit sent again after it committed: refused, the rewrite kept as it is', c.e?.code === 'EBADARG' && snapshot() === snap && namesOf(s.p) === `${s.name},${s.name}.idx`, c.e?.message ?? JSON.stringify(c.v))
  }
  {
    // no journal, the segment and its .idx not there, the original beside them: a swap that did not
    // finish and whose journal went (the old thinCommit did exactly this)
    const s = await ready()
    renameSync(s.p, `${s.p}.thin-old`)
    renameSync(`${s.p}.idx`, `${s.p}.idx.thin-old`)
    const rb = await shareCall(loc, 'thinRecover', { paths: [s.p] })
    check('thinRecover with no journal and the original set aside: put back byte for byte, not swept up', rb.rolledBack.join() === s.p && rb.sweptUp.length === 0 && isOriginal(s) && namesOf(s.p) === `${s.name},${s.name}.idx`, `${JSON.stringify(rb)} ${namesOf(s.p)}`)
  }
  {
    // no journal, the segment gone and only its rewrite beside it: that may be all that is left
    const s = await ready()
    rmSync(s.p)
    rmSync(`${s.p}.idx`)
    const snap = snapshot()
    const rb = await shareCall(loc, 'thinRecover', { paths: [s.p] })
    check('thinRecover with the segment gone and only a rewrite beside it: left as it is, and said', rb.left?.join() === s.p && rb.sweptUp.length === 0 && snapshot() === snap, `${JSON.stringify(rb)} ${namesOf(s.p)}`)
  }
  {
    // the same with its journal: nothing to roll back to, so the journal stays too
    const s = await ready()
    s.journal()
    rmSync(s.p)
    rmSync(`${s.p}.idx`)
    const snap = snapshot()
    const rb = await shareCall(loc, 'thinRecover', { paths: [s.p] })
    check('...and with its journal: left as it is, journal and all', rb.left?.join() === s.p && rb.rolledBack.length === 0 && snapshot() === snap, `${JSON.stringify(rb)} ${namesOf(s.p)}`)
  }
}

// ---- a share that stops answering ------------------------------------------------------------------
// The helper below is the real one, with its file calls made to hang on any path holding "HANG" while
// the flag file exists (like a stale SMB session: the call never comes back), or to take 300 ms on a
// path holding "SLOW".
const flag = join(base, 'hang-on')
const hangHelper = join(base, 'hang-helper.mjs')
writeFileSync(
  hangHelper,
  `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const flag = ${JSON.stringify(flag)}
for (const k of ['stat', 'statfs', 'readFile', 'writeFile', 'readdir', 'unlink', 'rmdir', 'rename', 'open']) {
  const real = fs.promises[k]
  fs.promises[k] = (p, ...a) => {
    if (String(p).includes('HANG') && fs.existsSync(flag)) return new Promise(() => {})
    if (String(p).includes('SLOW')) return new Promise((r) => setTimeout(r, 300)).then(() => real(p, ...a))
    return real(p, ...a)
  }
}
syncBuiltinESMExports()
await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'share-helper.mjs')).href)})
`
)
_test.setHelper(hangHelper)
_test.setAnswerMs(1000)
{
  const loc = location('HANG-share')
  const other = location('fine-share')
  await shareCall(loc, 'statfs')
  await shareCall(other, 'statfs')
  const stuckSeen = []
  const off = onShareStuck((l, op) => stuckSeen.push([l.id, op]))

  // a web server in this process, asked while the share hangs
  const web = createServer((req, res) => res.end('ok'))
  await new Promise((r) => web.listen(0, '127.0.0.1', r))
  const ask = () => new Promise((resolve) => {
    const t0 = performance.now()
    get(`http://127.0.0.1:${web.address().port}/`, (res) => {
      res.resume()
      res.on('end', () => resolve(performance.now() - t0))
    }).on('error', () => resolve(Infinity))
  })
  await ask() // the first request loads Node's HTTP client (up to 90 ms on Windows): not what is measured

  const busy = await quietest(async (round) => {
    const oldPid = _test.pidOf(loc)
    stuckSeen.length = 0
    writeFileSync(flag, '1')
    const stop = beat()
    const t0 = Date.now()
    const hung = settle(shareCall(loc, 'stat', { paths: [join(loc.path, 'x')] }))
    const hung2 = settle(shareCall(loc, 'readdir', { dirs: [loc.path] }))
    await sleep(300)
    const webMs = await ask()
    const webAt = Date.now()
    const otherAnswer = await settle(shareCall(other, 'statfs'))
    const [r1, r2] = await Promise.all([hung, hung2])
    const took = Date.now() - t0
    const worst = stop()
    const r = ` (round ${round + 1})`
    check(`a call on a hung share fails as "not answering" within the answer time${r}`, r1.e?.code === 'ESHARESTUCK' && /not answering/.test(r1.e.message) && took >= 1000 && took < 2000, `${r1.e?.code} ${r1.e?.message} after ${took} ms`)
    check(`...and so does every other call in flight on it${r}`, r2.e?.code === 'ESHARESTUCK')
    check(`the server went on answering while the share hung (a web request)${r}`, webMs < 250 && webAt - t0 < 1000, `${webMs.toFixed(1)} ms, ${webAt - t0} ms into the hang`)
    check(`another share went on answering meanwhile${r}`, otherAnswer.v?.totalBytes > 0)
    check(`the hung helper is killed${r}`, await until(() => !alive(oldPid)), `pid ${oldPid}`)
    check(`the stuck call is announced (the share is marked down at once)${r}`, stuckSeen.length === 1 && stuckSeen[0][0] === loc.id && stuckSeen[0][1] === 'stat', JSON.stringify(stuckSeen))
    // the killed helper has exited: the next call starts a new one, which hangs again while the share does
    await until(() => shareStuckFor(loc) === null)
    rmSync(flag)
    const next = await shareCall(loc, 'probe', { floor: 0 })
    check(`the share answers again: a NEW helper answers the next check${r}`, next.ok === true && _test.pidOf(loc) > 0 && _test.pidOf(loc) !== oldPid, `${oldPid} -> ${_test.pidOf(loc)}`)
    return worst
  })
  check('...and while the share hung, the main thread was never busy for 50 ms at a stretch', busy.best < 50, busy.text)
  off()
  web.close()

  // a slow share is not a stuck one: every file call that comes back resets the clock
  const slow = location('SLOW-share')
  const files = []
  for (let i = 0; i < 8; i++) {
    const p = join(slow.path, 'n', `${i}.h264`)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, 'x')
    files.push(p)
  }
  await shareCall(slow, 'statfs') // started, so its start-up is not timed below
  const t1 = Date.now()
  const slowDel = await settle(shareCall(slow, 'unlink', { paths: files }))
  check('8 deletions of 300 ms each (2.4 s) with an answer time of 1 s: not called stuck', slowDel.v?.every((x) => x.ok) && Date.now() - t1 > 2000 && files.every((p) => !existsSync(p)), `${slowDel.e?.message ?? ''} ${Date.now() - t1} ms`)

  // the share goes away in the middle of a batch: its mount point is an empty folder, where every
  // file is "not there". Those must not come back as deleted (the caller would drop their index rows
  // while the files are still on the NAS)
  const kept = join(slow.path, 'n', 'kept.h264')
  writeFileSync(kept, 'x')
  const markerText = readFileSync(join(slow.path, MARKER))
  const batch = settle(shareCall(slow, 'unlink', { paths: [kept, join(slow.path, 'n', 'a.h264'), join(slow.path, 'n', 'b.h264')] }))
  await sleep(450) // the marker check (300 ms) and the first deletion are under way
  rmSync(join(slow.path, MARKER))
  const mid = await batch
  writeFileSync(join(slow.path, MARKER), markerText)
  check('the marker gone during a batch: what was deleted says so', mid.v?.[0]?.ok === true && !existsSync(kept), JSON.stringify(mid.v ?? mid.e?.message))
  check('...and "not there" after that is not taken for deleted', mid.v?.[1]?.ok === false && mid.v[1].error === 'EMARKER' && mid.v?.[2]?.ok === false, JSON.stringify(mid.v))

  // One helper makes every call on its share, so a check that runs out of its whole-check budget on a
  // share that is slow but answering takes a rewrite in flight down with it (review of p1-helper,
  // 2026-09-29): the swap fails as "not answering" though its own calls were answering, and is left
  // wherever the kill found it. thinRecover then puts the original back, byte for byte.
  {
    const p = join(slow.path, 'n1', '0', '2026-09-22', '08', '00.h264')
    makeSegment(p, T0 + 7_200_000)
    const orig = { seg: readFileSync(p), idx: readFileSync(`${p}.idx`) }
    const stuckOps = []
    const offStuck = onShareStuck((l, op) => stuckOps.push(op))
    const made = await settle(shareCall(slow, 'thin', { path: p, timelapseS: 10, cursor: null, maxBytes: 1e9, swap: false }))
    const pid = _test.pidOf(slow)
    const swap = settle(shareCall(slow, 'thinSwap', { path: p }))
    await until(() => existsSync(`${p}.thin-journal`), 5000) // the swap has begun
    const chk = await settle(shareCall(slow, 'probe', { floor: 0 }, { timeoutMs: 400, whole: true }))
    const sw = await swap
    await until(() => shareStuckFor(slow) === null && !alive(pid), 5000)
    const leftAt = readdirSync(dirname(p)).sort().join()
    check('a check out of its time in the middle of a swap: the swap fails with it, as not answering', made.v?.outcome === 'thinned' && chk.e?.code === 'ESHARESTUCK' && sw.e?.code === 'ESHARESTUCK' && stuckOps.join() === 'probe' && /thin-journal/.test(leftAt), `${made.e?.message ?? ''} ${chk.e?.code} / ${sw.e?.code ?? JSON.stringify(sw.v)}; stuck: ${stuckOps}; left: ${leftAt}`)
    const rb = await settle(shareCall(slow, 'thinRecover', { paths: [p] }))
    check('...and thinRecover puts the original back, byte for byte', rb.v?.rolledBack.join() === p && readFileSync(p).equals(orig.seg) && readFileSync(`${p}.idx`).equals(orig.idx) && readdirSync(dirname(p)).sort().join() === '00.h264,00.h264.idx', `${JSON.stringify(rb.v ?? rb.e?.message)}; was ${leftAt}`)
    // every file call of the rewrite reports back: at 300 ms a call and an answer time of 1 s, a whole
    // rewrite, swap and commit are slow, not stuck (before, thinSwap's three checks for files and the
    // journal's open went unreported, and it was called stuck on its own)
    const full = await settle(shareCall(slow, 'thin', { path: p, timelapseS: 10, cursor: null, maxBytes: 1e9 }))
    const com = await settle(shareCall(slow, 'thinCommit', { path: p }))
    check('on a share taking 300 ms a file call: a rewrite, its swap and its commit are not called stuck', full.v?.swapped === true && com.v?.committed === true && stuckOps.join() === 'probe' && readdirSync(dirname(p)).sort().join() === '00.h264,00.h264.idx', `${full.e?.message ?? JSON.stringify(full.v)} ${com.e?.message ?? ''}; stuck: ${stuckOps}`)
    offStuck()
  }
}
_test.setAnswerMs(SHARE_ANSWER_MS)
_test.setHelper(null)

// ---- a helper that cannot be killed (stuck in the kernel on a stale share) -------------------------
// SIGKILL does not end a process inside an uninterruptible SMB call (2026-09-26). A new helper would
// get stuck the same way, one more per timeout: so no call goes to the share, and no new helper is
// started, until the old one has really exited (verify-6 6a).
{
  const kids = []
  _test.setFork(() => {
    const c = new EventEmitter()
    c.pid = 900000 + kids.length
    c.sent = []
    c.signals = []
    c.connected = true
    c.send = (m, cb) => {
      c.sent.push(m)
      cb?.(null)
      return true
    }
    c.kill = (s) => c.signals.push(s)
    c.unref = () => {}
    c.disconnect = () => {}
    kids.push(c)
    return c
  })
  _test.setAnswerMs(300)
  const loc = { id: 'loc-fake', path: join(base, 'fake') }
  const first = settle(shareCall(loc, 'probe', { floor: 0 }))
  const r = await first
  check('no answer: the call fails as not answering, the helper gets SIGKILL', r.e?.code === 'ESHARESTUCK' && kids[0].signals.includes('SIGKILL'), `${r.e?.message} ${kids[0].signals}`)
  await sleep(1100)
  const second = await settle(shareCall(loc, 'probe', { floor: 0 }))
  check('while it has not exited: calls fail at once, "stuck for N s"', second.e?.code === 'ESHARESTUCK' && /^share not answering: a check has been stuck for [1-3] s$/.test(second.e.message), second.e?.message)
  check('...and no second helper is started', kids.length === 1)
  check('shareStuckFor says since when and in what', shareStuckFor(loc)?.op === 'probe' && Date.now() - shareStuckFor(loc).since >= 1000)
  // a late answer from the old one is not taken for anything
  kids[0].emit('message', { n: kids[0].sent[0].n, ok: true, result: { ok: true } })
  kids[0].emit('exit', null, 'SIGKILL')
  const third = shareCall(loc, 'statfs')
  check('once it has exited: the next call starts a new helper', kids.length === 2 && shareStuckFor(loc) === null)
  kids[1].emit('message', { n: kids[1].sent[0].n, progress: true })
  kids[1].emit('message', { n: kids[1].sent[0].n, ok: true, result: { freeBytes: 1, totalBytes: 2 } })
  check('...which answers it', (await third).totalBytes === 2)
  // an answer after progress messages: the clock restarts at each
  const slow = shareCall(loc, 'statfs')
  const n = kids[1].sent.at(-1).n
  for (let i = 0; i < 4; i++) {
    await sleep(200)
    kids[1].emit('message', { n, progress: true })
  }
  kids[1].emit('message', { n, ok: true, result: { freeBytes: 3, totalBytes: 4 } })
  check('progress every 200 ms for 800 ms with an answer time of 300 ms: answered, not stuck', (await settle(slow)).v?.totalBytes === 4)
  // the health check keeps its budget for the whole check, as before the helper: a share that takes
  // 8 s a call is not a healthy one, and the outside watcher goes by this answer
  const t2 = Date.now()
  const whole = shareCall(loc, 'probe', { floor: 0 }, { whole: true }).then((v) => ({ v, at: Date.now() }), (e) => ({ e, at: Date.now() }))
  const nw = kids[1].sent.at(-1).n
  for (let i = 0; i < 3; i++) {
    await sleep(150)
    kids[1].emit('message', { n: nw, progress: true })
  }
  const w = await whole
  check('whole: progress does not restart the clock (the check as a whole gets the answer time)', w.e?.code === 'ESHARESTUCK' && w.at - t2 < 440, `${w.e?.code} after ${w.at - t2} ms`)
  kids[1].emit('exit', null, 'SIGKILL')
  // a helper that ends by itself (a crash, or killed from outside): its calls fail, the next starts anew
  const inFlight = settle(shareCall(loc, 'statfs'))
  check('(a new helper for it)', kids.length === 3)
  kids[2].emit('exit', 1, null)
  const lost = await inFlight
  check('a helper that ends by itself: its calls fail as "stopped", not "not answering"', lost.e?.code === 'ESHAREGONE' && !/not answering/.test(lost.e.message), lost.e?.message)
  const fourth = shareCall(loc, 'statfs')
  check('...and the next call starts a new one', kids.length === 4)
  kids[3].emit('message', { n: kids[3].sent[0].n, ok: true, result: { freeBytes: 5, totalBytes: 6 } })
  check('...which answers', (await fourth).totalBytes === 6)
  // an answer to an op that failed in the helper
  const failing = settle(shareCall(loc, 'stat', { paths: [] }))
  kids[3].emit('message', { n: kids[3].sent.at(-1).n, ok: false, error: { message: 'EMARKER: no', code: 'EMARKER' } })
  const f = await failing
  check("a call the helper refused: rejected with the helper's code", f.e?.code === 'EMARKER' && f.e.message === 'EMARKER: no')
  _test.setFork(null)
  _test.setAnswerMs(SHARE_ANSWER_MS)
  stopShareHelpers()
}

// ---- the helper ends with the server ------------------------------------------------------------------
{
  const loc = location('orphan')
  const parent = join(base, 'parent.mjs')
  writeFileSync(
    parent,
    `const { shareCall, _test } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'share-calls.mjs')).href)})
const loc = ${JSON.stringify({ id: loc.id, path: loc.path })}
await shareCall(loc, 'statfs')
console.log(_test.pidOf(loc))
process.exit(0)
`
  )
  const pid = await new Promise((resolve) => execFile(process.execPath, [parent], (err, out) => resolve(err ? null : Number(String(out).trim()))))
  check('a helper whose server has gone exits too', pid > 0 && (await until(() => !alive(pid), 5000)), `pid ${pid}`)
}

// ---- the helper does not hold the server's NVR connections open (Linux) ------------------------------
// The SDK opens its sockets without close-on-exec, so every child the server forks inherits them, and a
// connection the server closes stays open while the child lives (perf processes.md P3): for a helper
// that lives as long as the server, for good. It closes every TCP/UDP socket it was born with.
if (process.platform === 'linux') {
  const loc = location('fds')
  const srv = createTcpServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const accepted = new Promise((r) => srv.once('connection', r))
  const client = createConnection(srv.address().port, '127.0.0.1')
  await new Promise((r) => client.once('connect', r))
  const peer = await accepted
  const ended = new Promise((r) => peer.once('end', () => r(true)))
  // like an SDK socket: a copy of it is in the child at fd 4
  const child = fork(join(import.meta.dirname, '..', 'share-helper.mjs'), [loc.id, loc.path], { stdio: ['ignore', 'inherit', 'inherit', 'ipc', client] })
  const answered = await new Promise((r) => {
    child.once('message', (m) => r(m.ok === true))
    child.send({ n: 1, op: 'statfs', args: {} })
  })
  client.destroy()
  const gotEnd = await Promise.race([ended, sleep(1500).then(() => false)])
  check('an inherited TCP socket is closed in the helper: the other end sees the close', answered && gotEnd === true)
  child.kill('SIGKILL')
  srv.close()
} else {
  console.log('SKIP  inherited sockets (Linux only)')
}

stopShareHelpers()
await sleep(200)
// a helper just killed can still hold its folder for a moment (Windows): retried, and a leftover
// temp folder is said, not a crash after the last check
try {
  rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
} catch (e) {
  console.warn(`(could not remove ${base}: ${e.code || e.message})`)
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
