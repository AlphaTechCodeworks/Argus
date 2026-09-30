// Tests for the recovery scan after a worker restart (rec-recover.mjs recoverLocation / recoverOrphans;
// perf report R8 / Task 8, 2026-09-30).
//
// Why: after every worker restart (about 12 a day) the main process listed every hour folder that NVR
// has on the NAS, to find the few files the dead worker left without an index row: 17-29 s and about
// 3,000 listings per restart at 4-5 days (15.7-30.3 s by verify-3), growing with the days kept, on the
// main process's own thread pool, and a stale share would hang those threads for good. A worker can
// only have left open the files it had open when it died: they started after the camera's newest
// indexed file (or the file it announced open), and after the dead worker itself started. So after a
// restart only the hour folders from an hour before that are listed, by the location's share helper;
// every folder is listed only at the service's start (and the next time after a scan that failed).
//
//   real files        through the real share helper: the orphans of the crash are found (with and
//                     without .idx, closed but not indexed, a camera with no rows yet), the new
//                     worker's files and other NVRs are left alone, and the test process makes no
//                     file call on the location while it runs; a file the writer gave up on days ago
//                     waits for the full scan, which finds it
//   the listings      a tree of 26 cameras x 8 days: every folder (5,279 listings) at the start,
//                     53 after a restart; the main thread under 50 ms at a time either way
//   the modes         full the first time, recent after; full again after a failed scan; a helper
//                     that stopped is asked once more; the RAM spool is read in this process
//
// Temp folders only, removed at the end. No SDK: runs on any PC.
// Run: node cctv/test/rec-recover-recent.test.mjs
import fs, { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

const DATA = mkdtempSync(join(tmpdir(), 'cctv-recent-'))
process.env.DATA_DIR = join(DATA, 'data')
mkdirSync(process.env.DATA_DIR)

// ---- a watch on this process's file calls, installed before any app module is loaded -------------------
let watching = null // the location's folder, while its file calls are counted
const onLoc = [] // [function, path]
const note = (k, p) => {
  if (!watching || typeof p !== 'string') return
  const r = resolve(p)
  if (r === watching || r.startsWith(watching + sep)) onLoc.push([k, r])
}
const wrap = (obj, k, label) => {
  const real = obj[k]
  const w = function (...a) {
    note(label, a[0])
    return real.apply(this, a)
  }
  for (const key of Reflect.ownKeys(real)) if (!['length', 'name', 'prototype'].includes(key)) Object.defineProperty(w, key, Object.getOwnPropertyDescriptor(real, key))
  obj[k] = w
}
for (const k of Object.keys(fs)) if (typeof fs[k] === 'function' && /^[a-z]/.test(k)) wrap(fs, k, k)
for (const k of Object.keys(fs.promises)) if (typeof fs.promises[k] === 'function') wrap(fs.promises, k, `promises.${k}`)
syncBuiltinESMExports()

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const J = (v) => JSON.stringify(v)
process.on('exit', () => {
  try {
    rmSync(DATA, { recursive: true, force: true })
  } catch {}
})

const rec = await import('../rec-recover.mjs')
const { recoverOrphans, recoverLocation, recoverySince, RECENT_MARGIN_MS } = rec
const { openRecIndex } = await import('../rec-index.mjs')
const { segmentPath } = await import('../segment-writer.mjs')
const { stopShareHelpers, _test: shareTest } = await import('../share-calls.mjs')
const { MARKER } = await import('../location-health.mjs')
if (typeof recoverLocation !== 'function' || typeof recoverySince !== 'function') {
  check('rec-recover.mjs has recoverLocation and recoverySince', false)
  process.exit(1)
}

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const BEFORE = Date.UTC(2026, 8, 30, 10, 30, 0) // the new worker started
const PREV = BEFORE - 5 * HOUR // the dead one had started
const idxRows = (rows) => {
  const b = Buffer.alloc(rows.length * 16)
  rows.forEach(([off, ts], i) => {
    b.writeBigUInt64LE(BigInt(off), i * 16)
    b.writeBigInt64LE(BigInt(ts), i * 16 + 8)
  })
  return b
}
const put = (path, bytes, mtimeMs, idx) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes, 1))
  if (idx) writeFileSync(`${path}.idx`, idx)
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
}
/** The main thread's longest busy stretch from beat() to stop(): between two runs of a 5 ms timer, the time that passed less the loop's idle time. */
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
  return () => (clearInterval(t), step(), worst)
}

// ---- recoverySince: where each camera's files left open can start -------------------------------------
{
  const ix = openRecIndex(join(DATA, 'since.db'))
  const seg = (ch, s) => ix.addSegment({ nvr: 'n1', ch, path: `/x/${ch}/${s}.h264`, startMs: s, endMs: s + 59_000, bytes: 1, keyframes: 1, loc: 'L1' })
  seg(0, BEFORE - 2 * MIN)
  seg(0, BEFORE - MIN)
  seg(0, BEFORE + 30_000) // the new worker's: none of the dead one's
  seg(1, BEFORE - 3 * DAY) // recording was off until shortly before the crash
  seg(4, BEFORE - 2 * MIN)
  const opens = [{ nvr: 'n1', ch: 2, path: '/x/2/open.h264', startMs: BEFORE - 40_000 }, { nvr: 'n1', ch: 4, path: '/x/4/old-open.h264', startMs: BEFORE - 20 * MIN }]
  const since = recoverySince({ index: ix, nvrId: 'n1', beforeMs: BEFORE, opens, lastScanMs: PREV })
  check('since: from an hour before the camera\'s newest file that started before the restart', since(0) === BEFORE - MIN - RECENT_MARGIN_MS, String(since(0) - BEFORE))
  check("since: never before the location's last scan (at the dead worker's start: it wrote nothing earlier)", since(1) === PREV - RECENT_MARGIN_MS, String(since(1) - BEFORE))
  check('since: a camera with no rows yet, from the file the dead worker said it had open', since(2) === BEFORE - 40_000 - RECENT_MARGIN_MS, String(since(2) - BEFORE))
  check('since: a file announced open before the newest row wins (the earlier bound)', since(4) === BEFORE - 20 * MIN - RECENT_MARGIN_MS, String(since(4) - BEFORE))
  check("since: a camera nothing is known of, from the location's last scan", since(3) === PREV - RECENT_MARGIN_MS, String(since(3) - BEFORE))
  const unknown = recoverySince({ index: ix, nvrId: 'n1', beforeMs: BEFORE, opens: [], lastScanMs: null })
  check('since: nothing known and no scan before: its whole tree (null)', unknown(3) === null && unknown(0) === BEFORE - MIN - RECENT_MARGIN_MS)
  // the location was down at the restart before, and skipped: a file an earlier worker left there is older
  // than what the camera has recorded since, so only that location's last scan bounds
  const missed = recoverySince({ index: ix, nvrId: 'n1', beforeMs: BEFORE, opens, lastScanMs: PREV - 3 * HOUR, missed: true })
  check('since: a scan missed (the location skipped at the restart before): from its last scan, whatever the rows say', [0, 1, 2, 3, 4].every((ch) => missed(ch) === PREV - 3 * HOUR - RECENT_MARGIN_MS), J([0, 1, 2, 3, 4].map((ch) => missed(ch) - BEFORE)))
  ix.close()
}

// ---- real files, through the real share helper ----------------------------------------------------------
const root = mkdtempSync(join(DATA, 'loc-'))
writeFileSync(join(root, MARKER), '{"id":"L1"}')
const loc = { id: 'L1', path: root, type: 'network', role: 'main', limitGB: null }
const index = openRecIndex(join(DATA, 'recordings.db'))
const orphans = {}
{
  // cameras 0-2: three days of hour folders, two files an hour, indexed
  for (const ch of [0, 1, 2]) {
    for (let t = Math.floor((BEFORE - 3 * DAY) / HOUR) * HOUR; t < BEFORE - 5 * MIN; t += HOUR) {
      for (const m of [10, 40]) {
        const s = t + m * MIN
        if (s >= BEFORE - 3 * MIN) continue
        const p = segmentPath(root, 'n1', ch, s, 'h264')
        put(p, 100, s + 59_000, idxRows([[0, s]]))
        index.addSegment({ nvr: 'n1', ch, path: p, startMs: s, endMs: s + 59_000, bytes: 100, keyframes: 1, loc: 'L1' })
      }
    }
  }
  // what the dead worker left: open at the kill (with and without .idx), one closed but its row lost
  const t0 = BEFORE - 50_000
  orphans.open0 = segmentPath(root, 'n1', 0, t0, 'h264')
  put(orphans.open0, 5000, BEFORE - 2000, idxRows([[0, t0], [1500, t0 + 20_000]]))
  orphans.noIdx1 = segmentPath(root, 'n1', 1, BEFORE - 20_000, 'h264')
  put(orphans.noIdx1, 700, BEFORE - 1000)
  orphans.closed2 = segmentPath(root, 'n1', 2, BEFORE - 2 * MIN, 'h264')
  put(orphans.closed2, 900, BEFORE - MIN, idxRows([[0, BEFORE - 2 * MIN]]))
  orphans.open2 = segmentPath(root, 'n1', 2, BEFORE - MIN + 5000, 'h264')
  put(orphans.open2, 300, BEFORE - 3000, idxRows([[0, BEFORE - MIN + 5000]]))
  // a camera with no rows yet: the file it said it had open
  orphans.announced3 = segmentPath(root, 'n1', 3, BEFORE - 40_000, 'h264')
  put(orphans.announced3, 400, BEFORE - 1000, idxRows([[0, BEFORE - 40_000]]))
  // a camera added while the dead worker ran: nothing known of it but the worker's own start
  orphans.new4 = segmentPath(root, 'n1', 4, BEFORE - 90 * MIN, 'h264')
  put(orphans.new4, 400, BEFORE - 89 * MIN, idxRows([[0, BEFORE - 90 * MIN]]))
  // a file the writer gave up on two days ago ("location not writable": no row, no crash)
  orphans.old1 = segmentPath(root, 'n1', 1, BEFORE - 2 * DAY + 5 * MIN, 'h264')
  put(orphans.old1, 800, BEFORE - 2 * DAY + 6 * MIN, idxRows([[0, BEFORE - 2 * DAY + 5 * MIN]]))
  // the new worker's own file, and another NVR's leftover: not this recovery's
  orphans.fresh5 = segmentPath(root, 'n1', 5, BEFORE + 5000, 'h264')
  put(orphans.fresh5, 50, BEFORE + 6000, idxRows([[0, BEFORE + 5000]]))
  orphans.other = segmentPath(root, 'n2', 0, BEFORE - 30_000, 'h264')
  put(orphans.other, 50, BEFORE - 1000)
}
const opens = [{ nvr: 'n1', ch: 3, path: orphans.announced3, startMs: BEFORE - 40_000, loc: 'L1' }]
{
  let listed = 0
  const counting = (inner) => async (op, args) => {
    if (op === 'readdir') listed += args.dirs.length
    return inner(op, args)
  }
  const { shareCall } = await import('../share-calls.mjs')
  const viaHelper = (op, args) => shareCall(loc, op, args)
  await viaHelper('statfs') // the helper is started before the watch: its fork is not a file call here
  watching = resolve(root)
  onLoc.length = 0
  const since = recoverySince({ index, nvrId: 'n1', beforeMs: BEFORE, opens, lastScanMs: PREV })
  const got = await recoverOrphans({ index, loc, nvrId: 'n1', beforeMs: BEFORE, since, call: counting(viaHelper) })
  watching = null
  const by = (p) => got.find((r) => r.path === p)
  const recent = ['open0', 'noIdx1', 'closed2', 'open2', 'announced3', 'new4']
  check('after a restart: the files the dead worker left are found (open, no .idx, closed with its row lost, a camera with no rows, one added meanwhile)', recent.every((k) => by(orphans[k])) && got.length === recent.length, got.map((r) => r.path.slice(root.length)).join(' '))
  const a = by(orphans.open0)
  check('... each row as before: start from the first .idx row, end from its last change, bytes and keyframes', a && a.startMs === BEFORE - 50_000 && a.endMs === BEFORE - 2000 && a.bytes === 5000 && a.keyframes === 2 && a.ch === 0 && a.nvr === 'n1' && a.loc === 'L1', J(a))
  const b = by(orphans.noIdx1)
  check('... no .idx: the start from the file name, no keyframes', b && b.startMs === Date.UTC(2026, 8, 30, 10, 29, 0) && b.keyframes === 0 && b.endMs === BEFORE - 1000, J(b))
  check('... the new worker\'s file, another NVR\'s and the one given up on days ago are left alone', !index.has(orphans.fresh5) && !index.has(orphans.other) && !index.has(orphans.old1))
  check(`... ${listed} folders listed (the camera folders, and the hours from each camera's bound), not the 3 days`, listed <= 1 + 6 * 7 && listed >= 7, String(listed))
  check('... and this process made no file call on the location: the helper made them all', onLoc.length === 0, J(onLoc.slice(0, 5)))

  // the full scan (the service's start) finds the one given up on
  listed = 0
  const all = await recoverOrphans({ index, loc, nvrId: 'n1', beforeMs: BEFORE, since: null, call: counting(viaHelper) })
  check('every folder (the service\'s start): the file given up on two days ago is found, nothing twice', all.length === 1 && all[0].path === orphans.old1, all.map((r) => r.path.slice(root.length)).join(' '))
  check(`... ${listed} folders listed: every one of this NVR's`, listed > 200, String(listed))
}

// ---- the modes: every folder the first time, the recent ones after; again all after a failure ----------
{
  rec._test.reset()
  const ix = index
  for (const p of Object.values(orphans)) ix.remove(p) // not indexed again, each round
  const calls = []
  let fail = null
  const call = async (op, args) => {
    calls.push(op === 'readdir' ? args.dirs.length : 0)
    if (fail) {
      const e = fail
      fail = fail.once ? null : fail
      throw e
    }
    return (await import('../share-calls.mjs')).shareCall(loc, op, args)
  }
  const run = (o = {}) => recoverLocation({ index: ix, loc, nvrId: 'n1', beforeMs: BEFORE, prevSpawnMs: PREV, opens, call, ...o })
  const unindex = () => {
    for (const p of Object.values(orphans)) ix.remove(p)
  }
  // the service started (its worker at PREV): every folder, and what was left before then
  const r1 = await run({ beforeMs: PREV, prevSpawnMs: null, opens: [] })
  check('the first recovery for a location (the service\'s start): every folder, and the files left before it', r1.full === true && r1.added.length === 1 && r1.added[0].path === orphans.old1 && r1.listed > 200, J({ full: r1.full, added: r1.added.map((x) => x.path.slice(root.length)), listed: r1.listed }))
  unindex()
  // that worker died, and the next started at BEFORE: the recent folders only
  const r2 = await run()
  check('the next one (a worker restart): the recent folders only, every file the dead worker left', r2.full === false && r2.added.length === 6 && r2.listed < 50, J({ full: r2.full, added: r2.added.length, listed: r2.listed, ms: r2.ms }))
  unindex()
  fail = Object.assign(new Error('share not answering'), { code: 'ESHARESTUCK' })
  const r3 = await run().then(() => null, (e) => e)
  fail = null
  check('a scan that fails says so', r3?.code === 'ESHARESTUCK', r3?.message)
  const r4 = await run()
  check('... and the next one lists every folder again: what it missed may be older than the recent hours', r4.full === true && r4.added.length === 7, J({ full: r4.full, added: r4.added.length }))
  // a later crash: the worker started at BEFORE died, the next starts 10 minutes on
  const later = segmentPath(root, 'n1', 0, BEFORE + 5 * MIN, 'h264')
  put(later, 100, BEFORE + 6 * MIN, idxRows([[0, BEFORE + 5 * MIN]]))
  fail = Object.assign(new Error('the share helper stopped (exit code 3)'), { code: 'ESHAREGONE', once: true })
  const r5 = await run({ beforeMs: BEFORE + 10 * MIN, prevSpawnMs: BEFORE, opens: [] })
  check('a helper that stopped by itself is asked once more (a new one), and the scan goes on: the new crash\'s files', r5.full === false && J(r5.added.map((x) => x.path).sort()) === J([later, orphans.fresh5].sort()), J({ full: r5.full, added: r5.added.map((x) => x.path.slice(root.length)) }))
  // the location down at a restart (skipped), and a file left meanwhile older than rows written since elsewhere
  const skipped = segmentPath(root, 'n1', 1, BEFORE + 12 * MIN, 'h264')
  put(skipped, 100, BEFORE + 13 * MIN, idxRows([[0, BEFORE + 12 * MIN]]))
  const elsewhere = segmentPath(join(DATA, 'L2'), 'n1', 1, BEFORE + 2 * HOUR, 'h264')
  ix.addSegment({ nvr: 'n1', ch: 1, path: elsewhere, startMs: BEFORE + 2 * HOUR, endMs: BEFORE + 2 * HOUR + MIN, bytes: 1, keyframes: 1, loc: 'L2' })
  const r6 = await run({ beforeMs: BEFORE + 3 * HOUR, prevSpawnMs: BEFORE + 20 * MIN, opens: [] })
  check('after a restart this location missed: from its last scan on, not from the rows written since elsewhere', r6.full === false && r6.added.some((x) => x.path === skipped), J({ added: r6.added.map((x) => x.path.slice(root.length)), listed: r6.listed }))
}

// ---- the RAM spool: read in this process (it is memory, not a share, and has no helper) ------------------
{
  rec._test.reset()
  const spool = mkdtempSync(join(DATA, 'spool-'))
  const p = segmentPath(spool, 'n1', 0, BEFORE - 30_000, 'h264')
  put(p, 64, BEFORE - 1000, idxRows([[0, BEFORE - 30_000]]))
  const ix = openRecIndex(join(DATA, 'spool.db'))
  const forks = shareTest.forks()
  const r = await recoverLocation({ index: ix, loc: { id: 'ram-spool', path: spool }, nvrId: 'n1', beforeMs: BEFORE, opens: [], local: true })
  check('the RAM spool: its orphan found without a helper process', r.added.length === 1 && r.added[0].path === p && r.added[0].loc === 'ram-spool' && shareTest.forks() === forks, J({ added: r.added.map((x) => x.path), forks: shareTest.forks() - forks }))
  ix.close()
}

// ---- 26 cameras x 8 days, as the NAS holds them: the listings, and the main thread ----------------------
{
  const CH = 26
  const DAYS = 8
  const fakeRoot = resolve(join(DATA, 'nas'))
  const base = join(fakeRoot, 'nvr-2')
  const pad = (n) => String(n).padStart(2, '0')
  const firstHour = Math.floor((BEFORE - DAYS * DAY) / HOUR) * HOUR
  const hoursOf = []
  for (let t = firstHour; t <= BEFORE; t += HOUR) hoursOf.push(t)
  const dayName = (t) => new Date(t).toISOString().slice(0, 10)
  const days = [...new Set(hoursOf.map(dayName))]
  // every minute a file and its .idx; indexed except each camera's last one (open at the kill)
  const openAt = (ch) => BEFORE - 40_000 + ch * 500
  const orphanPath = (ch) => segmentPath(fakeRoot, 'nvr-2', ch, openAt(ch), 'h265')
  const orphanSet = new Set(Array.from({ length: CH }, (_, ch) => orphanPath(ch)))
  const fakeIndex = {
    has: (p) => !orphanSet.has(p),
    added: [],
    addSegment(s) {
      this.added.push(s)
      orphanSet.delete(s.path)
    },
    newestStart: (_nvr, ch, before) => Math.min(before - 1, openAt(ch) - MIN)
  }
  let listings = 0
  const tick = () => new Promise((r) => setImmediate(r))
  const call = async (op, args) => {
    await tick() // an answer comes back from another process
    if (op === 'readdir') {
      listings += args.dirs.length
      return args.dirs.map((d) => {
        const rel = d.slice(base.length + 1).split(sep).filter(Boolean)
        if (d === base) return { dir: d, entries: Array.from({ length: CH }, (_, ch) => ({ name: String(ch), file: false, dir: true })) }
        if (rel.length === 1) return { dir: d, entries: days.map((name) => ({ name, file: false, dir: true })) }
        if (rel.length === 2) return { dir: d, entries: hoursOf.filter((t) => dayName(t) === rel[1]).map((t) => ({ name: pad(new Date(t).getUTCHours()), file: false, dir: true })) }
        if (rel.length === 3) {
          const hourStart = Date.parse(`${rel[1]}T${rel[2]}:00:00Z`)
          if (!(hourStart <= BEFORE)) return { dir: d, error: 'ENOENT' }
          const out = []
          for (let m = 0; m < 60 && hourStart + m * MIN <= BEFORE; m++) out.push({ name: `${rel[2]}-${pad(m)}.h265`, file: true, dir: false }, { name: `${rel[2]}-${pad(m)}.h265.idx`, file: true, dir: false })
          return { dir: d, entries: out }
        }
        return { dir: d, error: 'ENOENT' }
      })
    }
    if (op === 'segInfo') return args.paths.map((path) => ({ path, size: 1000, mtimeMs: BEFORE - 1000, isFile: true, keyframes: 1, firstKeyMs: openAt(Number(basename(dirname(dirname(dirname(path)))))), lastKeyMs: null }))
    throw new Error(`unexpected ${op}`)
  }
  const measure = async (since) => {
    listings = 0
    fakeIndex.added = []
    for (let ch = 0; ch < CH; ch++) orphanSet.add(orphanPath(ch))
    const eld = monitorEventLoopDelay({ resolution: 1 })
    eld.enable()
    const stop = beat()
    const t0 = performance.now()
    const got = await recoverOrphans({ index: fakeIndex, loc: { id: 'NAS', path: fakeRoot }, nvrId: 'nvr-2', beforeMs: BEFORE, since, call })
    const took = performance.now() - t0
    const busy = stop()
    eld.disable()
    return { got: got.length, listings, busy, eld: eld.max / 1e6, took }
  }
  const allFolders = 1 + CH + CH * days.length + CH * hoursOf.length
  const full = await measure(null)
  check(`every folder (the service's start), 26 cameras x ${DAYS} days: ${full.listings.toLocaleString('en')} listings, the ${CH} orphans found, the main thread under 50 ms at a time`, full.listings === allFolders && full.got === CH && full.busy < 50 && full.eld < 50, `${full.listings} of ${allFolders} folders; longest busy stretch ${full.busy.toFixed(1)} ms, delay max ${full.eld.toFixed(1)} ms, ${Math.round(full.took)} ms in all`)
  const since = recoverySince({ index: fakeIndex, nvrId: 'nvr-2', beforeMs: BEFORE, opens: [], lastScanMs: PREV })
  const recent = await measure(since)
  check(`after a restart: ${recent.listings} listings instead of ${full.listings.toLocaleString('en')}, the same ${CH} orphans found`, recent.listings <= 1 + CH * 3 && recent.got === CH && recent.busy < 50, `longest busy stretch ${recent.busy.toFixed(1)} ms, ${Math.round(recent.took)} ms in all`)
}

stopShareHelpers()
index.close()
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
