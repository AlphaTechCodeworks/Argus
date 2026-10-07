// Tests for the backfill scan and pick made incremental (backfill.mjs; perf report R5 / Task 7, and its
// check verify-5, 2026-09-30).
//
// Why: every tick of the backfill job (every ~34 s in the night window) ran scan() on the main thread:
// 87 cameras x 32 days of segment rows and gap rows read as objects, every hole found again and written
// to the ledger again, then two reads of 10,000 pending ledger rows. 3.3-4.5 s of frozen main thread a
// tick at 4 days of index on production (verify-5), and about 65-70 s at 32 days; 24-121 ticks a night.
// Now each camera's scan goes on from where the last one stopped (a mark kept in the index), a slice at
// a time, and the pick reads the pending rows a page at a time, oldest first, stopping at the first
// page that decides it.
//
// What must hold:
//   the same holes    on a synthetic 32-day x 87-camera index, the ledger after a first scan and
//                     after ticks later on (holes coming out of the 6-hour tail, one straddling its
//                     edge, new cameras, a camera that stopped, a two-day outage) is exactly what the
//                     old full scan would have written at those same times, reasons and all
//   the main thread   the first scan (the whole window) and a whole tick afterwards (scan, pick, a
//                     pull) never hold the main thread 50 ms or more (busy stretches and
//                     monitorEventLoopDelay); the old scan on the same index is timed for comparison
//   a restart         a new job goes on from the marks: one short slice per camera
//   the settings      a shorter minGapSeconds, or a longer nvrRetentionDays, scans the window again
//   the pick          the same row, or the same reason for none, as chooseGap over the oldest 10,000
//                     pending rows; the aged rows made permanent, all of them
//
// Temp folders only, removed at the end; nothing reaches an NVR. Runs on any PC.
// Run: node cctv/test/backfill-scan.test.mjs     (BF_SCAN_SEG_MIN=1 for production's one-minute files:
// about ten times the rows and the time)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PerformanceObserver, monitorEventLoopDelay } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'

const DATA = mkdtempSync(join(tmpdir(), 'bf-scan-'))
process.env.DATA_DIR = DATA
writeFileSync(join(DATA, 'users.json'), '{}')
process.on('exit', () => {
  try {
    rmSync(DATA, { recursive: true, force: true })
  } catch {}
})

let failures = 0
let checks = 0
const check = (n, ok, e = '') => {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const J = (v) => JSON.stringify(v)

const { openRecIndex, MAX_SEGMENT_MS } = await import('../rec-index.mjs')
const bf = await import('../backfill.mjs')
const { BackfillJob, chooseGap, findGaps, SCAN_MARGIN_MS, TAIL_MS, PERMANENT } = bf

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0)
const RET_DAYS = 30
const SEG_MS = Math.max(1, Number(process.env.BF_SCAN_SEG_MIN) || 10) * MIN

// a small seeded generator, so a failure can be run again
let seed = 20260930
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (a, b) => a + Math.floor(rand() * (b - a + 1))

// ---- the synthetic index: 87 cameras on four NVRs, 33 days and 3 hours of footage -------------------
const CAMS = [...Array.from({ length: 26 }, (_, ch) => ['nvr1', ch]), ...Array.from({ length: 26 }, (_, ch) => ['nvr-2', ch]), ...Array.from({ length: 26 }, (_, ch) => ['value4u', ch]), ...Array.from({ length: 9 }, (_, ch) => ['rigginglot', ch])]
const FROM0 = NOW - RET_DAYS * DAY - SCAN_MARGIN_MS // the old scan's window start at NOW
const EDGE0 = NOW - TAIL_MS
const REASONS = ['refused by the NVR (no reason given)', 'no video from the NVR', 'disk too slow', 'camera offline', 'recording worker restarted']
const file = join(DATA, 'recordings.db')
const buildStarted = performance.now()
let segRows = 0
let gapRows = 0
{
  // the two tables as rec-index.mjs makes them, filled before its indexes exist (built once at its first
  // open, rather than kept up row by row: several times quicker)
  const raw = new DatabaseSync(file)
  raw.exec(`CREATE TABLE segments (path TEXT PRIMARY KEY, nvr TEXT NOT NULL, ch INTEGER NOT NULL, start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL, bytes INTEGER NOT NULL, keyframes INTEGER NOT NULL, loc TEXT);
    CREATE TABLE gaps (id INTEGER PRIMARY KEY, nvr TEXT NOT NULL, ch INTEGER NOT NULL, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, reason TEXT);`)
  const insSeg = raw.prepare('INSERT INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc) VALUES (?, ?, ?, ?, ?, 1000, 1, ?)')
  const insGap = raw.prepare('INSERT INTO gaps (nvr, ch, from_ms, to_ms, reason) VALUES (?, ?, ?, ?, ?)')
  let n = 0
  const seg = (nvr, ch, s, e) => {
    insSeg.run(`/syn/${nvr}/${ch}/${++n}.h264`, nvr, ch, s, e, 'L1')
    segRows++
  }
  const gap = (nvr, ch, s, e, reason) => {
    insGap.run(nvr, ch, s, e, reason)
    gapRows++
  }
  /** Recorder rows for a hole: the whole of it, part of it, two of them, or more than it; or none (unknown). */
  const explain = (nvr, ch, s, e) => {
    const r = rand()
    const a = REASONS[between(0, REASONS.length - 1)]
    const b = REASONS[between(0, REASONS.length - 1)]
    if (r < 0.28) gap(nvr, ch, s, e, a)
    else if (r < 0.42) gap(nvr, ch, s - between(0, 3000), s + Math.round(((e - s) * between(30, 100)) / 100), a)
    else if (r < 0.56) {
      const m = s + Math.round(((e - s) * between(10, 90)) / 100)
      gap(nvr, ch, s, m, a)
      gap(nvr, ch, m, e, b)
    } else if (r < 0.7) gap(nvr, ch, s - MIN, e + MIN, a)
    // else: nothing explains it
  }
  raw.exec('BEGIN')
  for (const [nvr, ch] of CAMS) {
    const key = `${nvr}/${ch}`
    let t = NOW - 33 * DAY + between(0, SEG_MS)
    let end = NOW + 3 * HOUR
    const outages = []
    if (key === 'value4u/25') t = NOW - 10 * DAY // a camera added 10 days ago
    if (key === 'rigginglot/8') end = NOW - 5 * DAY // one that stopped 5 days ago
    if (key === 'nvr1/25') outages.push([NOW - 12 * DAY, NOW - 10 * DAY, 'camera offline']) // two days away
    if (key === 'nvr1/24') outages.push([EDGE0 - 20 * MIN, EDGE0 + 40 * MIN, 'no video from the NVR']) // across the tail's edge
    if (key === 'nvr1/23') outages.push([EDGE0 + 10 * MIN, EDGE0 + 25 * MIN, 'camera offline']) // comes out of the tail later
    if (key === 'value4u/24') outages.push([FROM0 - HOUR, FROM0 + 2 * HOUR, 'camera offline']) // across the window's start
    const pHole = nvr === 'nvr-2' ? 0.08 : 0.042
    const noise = key === 'nvr-2/0' ? 1 : nvr === 'nvr-2' ? 0.3 : 0.02
    while (t < end) {
      const o = outages.find(([a, b]) => t >= a && t < b)
      if (o) {
        gap(nvr, ch, o[0], o[1], o[2])
        t = o[1]
        outages.splice(outages.indexOf(o), 1)
        continue
      }
      // Files over MAX_SEGMENT_MS (no keyframe for that long) are left out of the window's first two days:
      // the old scan's segments() does not see one that began over an hour before the window's start,
      // and missed the hole after it (older than the NVR keeps anyway); the new scan finds it (below).
      const long = t > NOW - 31 * DAY && rand() < 0.002
      let len = long ? between(MAX_SEGMENT_MS + 1, 3 * MAX_SEGMENT_MS) : SEG_MS - between(0, 3000)
      // a file stops where an outage starts (the outage's times are what the checks below look for)
      const cut = outages.find(([a]) => a > t && a < t + len)
      if (cut) len = cut[0] - t
      seg(nvr, ch, t, t + len)
      if (rand() < 0.004) seg(nvr, ch, t + between(0, 5000), t + len - between(0, 5000)) // a second file of the same stretch
      if (rand() < noise) {
        const x = t + between(0, len - 5000)
        gap(nvr, ch, x, x + between(500, 4000), 'no video from the NVR')
      }
      if (rand() < 0.001) gap(nvr, ch, t, t + between(61, 180) * MIN, 'disk too slow') // a long row over footage
      if (cut) {
        t = cut[0]
        continue
      }
      let next = t + len
      const r = rand()
      if (r < pHole) {
        const c = rand()
        const hole = c < 0.15 ? between(2000, 9999) : c < 0.3 ? between(10_000, 60_000) : c < 0.8 ? between(1, 30) * MIN + between(0, 59_999) : c < 0.99 ? between(30, 360) * MIN : between(6 * 60, 30 * 60) * MIN
        // (none that would reach an outage: the outages keep their own times, with footage before them)
        if (!outages.some(([a]) => a >= next && a <= next + hole + SEG_MS)) {
          explain(nvr, ch, next, next + hole)
          next += hole
        }
      } else if (r < pHole + 0.1) next += between(1, 1999) // a seam: one stretch (JOIN_MS)
      t = next
    }
  }
  raw.exec('COMMIT')
  raw.close()
}
const index = openRecIndex(file, { walAutocheckpoint: 0 })
const raw = new DatabaseSync(file)
console.log(`(synthetic index: ${CAMS.length} cameras, ${segRows.toLocaleString('en')} segment rows (${SEG_MS / MIN}-minute files) and ${gapRows.toLocaleString('en')} gap rows over 33 days, built in ${Math.round(performance.now() - buildStarted)} ms)`)

// ---- the old scan, as it was: every camera's whole window, every tick ------------------------------
/** The holes the old scan() found at `now`: key nvr/ch/from/to -> 'reason|kind'. */
function oldScan(now, { minGapMs = 10_000, retentionDays = RET_DAYS } = {}) {
  const from = now - retentionDays * DAY - SCAN_MARGIN_MS
  const out = new Map()
  for (const { nvr, ch } of index.cameras()) {
    const holes = findGaps({ nvr, ch, now, fromMs: from, toMs: now, minGapMs, segments: index.segments(nvr, ch, from, now), gapRows: index.gaps(nvr, ch, from, now) })
    for (const g of holes) out.set(`${nvr}/${ch}/${g.fromMs}/${g.toMs}`, `${g.reason}|${g.kind}`)
  }
  return out
}
/** The ledger now, keyed as oldScan. */
const ledger = () => new Map(raw.prepare('SELECT nvr, ch, from_ms AS f, to_ms AS t, reason, kind FROM backfill_gaps').all().map((r) => [`${r.nvr}/${r.ch}/${r.f}/${r.t}`, `${r.reason}|${r.kind}`]))
/** What an INSERT OR IGNORE ledger holds after the old scan ran at each time: the first time a hole was seen wins. */
const union = (maps) => {
  const out = new Map()
  for (const m of maps) for (const [k, v] of m) if (!out.has(k)) out.set(k, v)
  return out
}
function sameHoles(name, got, want) {
  const missing = [...want.keys()].filter((k) => !got.has(k))
  const extra = [...got.keys()].filter((k) => !want.has(k))
  const relabelled = [...want.keys()].filter((k) => got.has(k) && got.get(k) !== want.get(k))
  check(name, !missing.length && !extra.length && !relabelled.length, `${got.size.toLocaleString('en')} holes vs ${want.size.toLocaleString('en')}; missing ${missing.length} ${missing.slice(0, 3).join(' ')}; extra ${extra.length} ${extra.slice(0, 3).join(' ')}; other reason ${relabelled.length} ${relabelled.slice(0, 2).map((k) => `${k}: ${got.get(k)} vs ${want.get(k)}`).join(' ')}`)
}

// ---- the job -----------------------------------------------------------------------------------------
const nowBox = { t: NOW }
const cfg = { enabled: true, windowStart: '00:00', windowEnd: '23:59', nvrRetentionDays: RET_DAYS, minGapSeconds: 10, maxGapMinutes: 60, perNvrMbps: 8, restSeconds: 30 }
const legs = []
/** A leg as the NVR sends one: a keyframe a second, 50 at a time with a turn of the loop between them. */
const leg = ({ fromMs, toMs, real }) => {
  legs.push({ fromMs, toMs })
  let closed = false
  const done = (async () => {
    for (let t = fromMs; t < toMs && !closed; ) {
      for (let k = 0; k < 50 && t < toMs; k++, t += 1000) {
        const b = Buffer.alloc(16 + 200)
        b[0] = 1
        b.writeUInt32LE(200, 4)
        b.writeBigInt64LE(BigInt(Math.round(t * 1000)), 8)
        real.send(b)
      }
      await new Promise((r) => setImmediate(r))
    }
    return { reason: 'reached' }
  })()
  return { done, close: () => (closed = true), command() {}, fromMs, toMs }
}
const recRoot = mkdtempSync(join(DATA, 'rec-'))
let jobs = 0
function makeJob(over = {}) {
  return new BackfillJob({
    index,
    nvrs: new Map(['nvr1', 'nvr-2', 'value4u', 'rigginglot'].map((id) => [id, { id, online: true, ...(over.nvrs?.[id] ?? {}) }])),
    locations: () => [{ id: 'L1', path: recRoot, role: 'main' }],
    settings: () => ({ backfill: { ...cfg, ...(over.cfg ?? {}) } }),
    coverage: async (_n, _ch, from, to) => ({ ranges: [[from, to]], skewMs: 0 }),
    leg,
    now: () => nowBox.t,
    exportsBusy: () => false,
    recordingBusy: () => false,
    stateFile: join(DATA, `state-${++jobs}.json`),
    log: () => {}
  })
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
/** fn() measured: { value, busy (longest stretch), eld (monitorEventLoopDelay max), took, gc (the longest garbage collection meanwhile) }. */
async function measured(fn) {
  const eld = monitorEventLoopDelay({ resolution: 1 })
  let gc = 0
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) gc = Math.max(gc, e.duration)
  })
  obs.observe({ entryTypes: ['gc'] })
  eld.enable()
  const stop = beat()
  const t0 = performance.now()
  const value = await fn()
  const took = performance.now() - t0
  const busy = stop()
  eld.disable()
  await new Promise((r) => setImmediate(r)) // the observer's last entries
  obs.disconnect()
  return { value, busy, eld: eld.max / 1e6, took, gc }
}
const resetLedger = () => raw.exec('DELETE FROM backfill_gaps; DELETE FROM backfill_scan')
const ms = (x) => `${x.toFixed(1)} ms`

// ---- 1. the first scan: the whole window, in slices -----------------------------------------------------
const refs = [] // the old scan's holes at each time the new one ran
{
  // the old scan's read part on the same index, for comparison (it held the main thread all along)
  const t0 = performance.now()
  refs.push(oldScan(NOW))
  const oldMs = performance.now() - t0
  // the lowest of up to 3 rounds from an empty ledger: a synchronous stretch shows in every round, this
  // PC being busy with other programs in one now and then
  const rounds = []
  for (let round = 0; round < 3; round++) {
    resetLedger()
    nowBox.t = NOW
    const job = makeJob()
    rounds.push({ ...(await measured(() => job.scan())), job })
    if (rounds.at(-1).busy < 50 && rounds.at(-1).eld < 50) break
  }
  const best = rounds.reduce((a, b) => (b.busy < a.busy ? b : a))
  const s = best.value ?? {}
  sameHoles('the first scan writes exactly the holes the old full scan finds (32 days x 87 cameras, reasons and kinds included)', ledger(), refs[0])
  check(`... and the main thread is never held 50 ms or more (the old scan's read part here: ${Math.round(oldMs)} ms in one stretch)`, best.busy < 50 && best.eld < 50, `longest busy stretch ${ms(best.busy)}, event-loop delay max ${ms(best.eld)}; ${Math.round(best.took)} ms in all, ${s.slices} slices, ${s.rows?.toLocaleString('en')} rows; rounds (busy / delay / longest GC): ${rounds.map((r) => `${ms(r.busy)} / ${ms(r.eld)} / ${ms(r.gc)}`).join(', ')}`)
  check('... it counts what it did', s.found === refs[0].size && s.added === refs[0].size && s.cameras === CAMS.length, J({ found: s.found, added: s.added, cameras: s.cameras }))
  const marks = raw.prepare('SELECT COUNT(*) AS n, MAX(mark_ms) AS hi FROM backfill_scan').get()
  check('... and keeps a mark for every camera, none past the tail\'s edge', marks.n === CAMS.length && marks.hi <= EDGE0, J(marks))
  const straddle = [...refs[0].keys()].filter((k) => k.startsWith('nvr1/24/'))
  check('... the hole across the tail\'s edge is noted as the old scan noted it, up to the edge', straddle.some((k) => k.endsWith(`/${EDGE0}`)), straddle.join(' '))
}

// ---- 2. ticks later on: new holes come out of the tail, the edge moves ------------------------------------
{
  const times = [NOW + 34_000, NOW + 68_000, NOW + 102_000, NOW + 20 * MIN, NOW + 2 * HOUR, NOW + 2 * HOUR + 34_000]
  const job = makeJob()
  let steady = null
  for (const t of times) {
    nowBox.t = t
    refs.push(oldScan(t))
    const r = await measured(() => job.scan())
    if (t === NOW + 34_000) steady = r
  }
  sameHoles('ticks at +34 s, +68 s, +102 s, +20 min, +2 h, +2 h 34 s: the ledger is what the old scan would have written at those times', ledger(), union(refs))
  const s = steady.value
  check('a tick\'s scan once the marks are there: one slice per camera (a stopped camera\'s too), a few rows each, well under 50 ms', s.slices === CAMS.length && s.rows < CAMS.length * 5 && steady.busy < 50, `${s.slices} slices, ${s.rows} rows, ${ms(steady.took)} in all, longest stretch ${ms(steady.busy)}`)
  const late = [...ledger().keys()].filter((k) => k.startsWith('nvr1/23/'))
  check('the outage that came out of the tail after the first scan is in the ledger', late.some((k) => k.endsWith(`/${EDGE0 + 10 * MIN}/${EDGE0 + 25 * MIN}`)), late.join(' '))
}

// ---- 3. a whole tick: scan, pick, pull ------------------------------------------------------------------
{
  const rounds = []
  const tickTimes = [] // the times the ticks ran at; their refs are taken below, after the rewind
  for (let round = 0; round < 3; round++) {
    nowBox.t = NOW + 2 * HOUR + (round + 2) * 34_000
    tickTimes.push(nowBox.t)
    const job = makeJob({ cfg: { maxGapMinutes: 1 } }) // (a minute a pull: a longer hole is left in part)
    job.running = true
    legs.length = 0
    const r = await measured(() => job.tick())
    job.stop('test')
    rounds.push({ ...r, pulled: legs.length, what: job.last.what })
    if (r.busy < 50 && r.eld < 50) break
  }
  const best = rounds.reduce((a, b) => (b.busy < a.busy ? b : a))
  check('a whole tick (the scan, the pick among the pending rows, a pull and its rows) holds the main thread under 50 ms at a time', best.pulled === 1 && best.busy < 50 && best.eld < 50, `${best.pulled} pulled (${best.what}); longest busy stretch ${ms(best.busy)}, delay max ${ms(best.eld)}, ${Math.round(best.took)} ms in all; rounds (busy / delay / longest GC): ${rounds.map((r) => `${ms(r.busy)} / ${ms(r.eld)} / ${ms(r.gc)}`).join(', ')}`)
  // What the pulls wrote splits their holes behind the marks. The old scan noted each piece left as a
  // hole of its own, a second ledger row for footage its row already stands for; the new one does not
  // look behind the marks, and fill() works out what is left of the row from the index every time.
  const t = nowBox.t
  // (A row with a try on it was pulled too: the pick now takes a hole whose start the NVR has rolled past
  // while its end has not, the next round's scan may age that row out, and its note then says so.)
  const pulledRows = raw.prepare("SELECT id, nvr, ch, from_ms AS f, to_ms AS t FROM backfill_gaps WHERE note LIKE 'partly filled%' OR state = 'filled' OR last_try_ms IS NOT NULL").all()
  const inAPulledRow = (k) => {
    const [nvr, ch, f, to] = k.split('/')
    return pulledRows.some((r) => r.nvr === nvr && String(r.ch) === ch && Number(f) >= r.f && Number(to) <= r.t)
  }
  const old = oldScan(t)
  const now = ledger()
  const onlyOld = [...old.keys()].filter((k) => !now.has(k))
  check('... the old scan would now note the pulled rows\' leftovers again as holes of their own; the new one leaves them to their rows', pulledRows.length > 0 && onlyOld.every(inAPulledRow), `${pulledRows.length} rows pulled; ${onlyOld.length} leftovers the old scan would note: ${onlyOld.slice(0, 3).join(' ')}`)
  // the rest of this file compares with the old scan on the index as it was built
  raw.exec('DELETE FROM segments WHERE source IS NOT NULL')
  // Only now take each tick's ref, on the rewound index. Taking them inside the loop (before the
  // rewind) folded the pulls' leftover split-holes into `refs`, which the incremental scan never
  // records (behind the marks; checked just above) -- and how many ticks ran here is timing-driven
  // (the best-of-3 perf retry breaks as soon as a round is quiet). That made the later equality
  // assertions (sections 4-5) fail about one run in three on whichever leftover a second or third
  // round had snapshotted. Taken here, every tick-time ref is the old scan on the index as built,
  // exactly as every other section's ref is, so the union the later sections compare against holds
  // regardless of how many rounds ran.
  for (const tt of tickTimes) refs.push(oldScan(tt))
}

// ---- 4. a restart goes on from the marks ------------------------------------------------------------------
{
  nowBox.t = NOW + 3 * HOUR
  refs.push(oldScan(nowBox.t))
  const job = makeJob()
  const r = await measured(() => job.scan())
  check('a new job (a restart) goes on from the marks in the index: one slice per camera, not the whole window', r.value.slices === CAMS.length && r.value.rows < CAMS.length * 60, `${r.value.slices} slices, ${r.value.rows} rows, ${ms(r.took)}`)
  sameHoles('... and the ledger is still what the old scan would have written', ledger(), union(refs))
}

// ---- 5. settings that change what a hole is, or how far back to look -------------------------------------
{
  nowBox.t = NOW + 3 * HOUR + 34_000
  const five = oldScan(nowBox.t, { minGapMs: 5000 })
  const job = makeJob({ cfg: { minGapSeconds: 5 } })
  const r = await job.scan()
  const got = ledger()
  const shortOnes = [...five.keys()].filter((k) => !refs.some((m) => m.has(k)))
  check('a shorter minGapSeconds: the whole window is looked at again, and the holes of 5-10 s are found', shortOnes.length > 0 && shortOnes.every((k) => got.has(k)) && r.slices > CAMS.length * 20, `${shortOnes.length} new holes, ${shortOnes.filter((k) => got.has(k)).length} in the ledger; ${r.slices} slices`)
  refs.push(five)
  sameHoles('... and nothing else: the ledger is the old scan\'s at each time, 10 s then 5 s', got, union(refs))
  const back = makeJob({ cfg: { minGapSeconds: 5, nvrRetentionDays: RET_DAYS + 1 } })
  const r2 = await back.scan()
  const day31 = oldScan(nowBox.t, { minGapMs: 5000, retentionDays: RET_DAYS + 1 })
  refs.push(day31)
  check('a longer nvrRetentionDays: the day it adds is scanned too', r2.slices > CAMS.length * 20 && ((l) => [...day31.keys()].every((k) => l.has(k)))(ledger()), `${r2.slices} slices, ${r2.added} added`)
  sameHoles('... and the ledger is still the old scan\'s at each time', ledger(), union(refs))
}

// ---- 6. holes the NVR has rolled past: every one made permanent, nothing else -----------------------------
{
  nowBox.t = NOW + 3 * HOUR + DAY // a day on: a day of holes has aged out
  const job = makeJob()
  const at = nowBox.t
  const retention = job.retentionMs()
  const r = await job.scan()
  const aged = raw.prepare("SELECT COUNT(*) AS n FROM backfill_gaps WHERE state = 'pending' AND to_ms < ?").get(at - retention).n
  const wrong = raw.prepare("SELECT COUNT(*) AS n FROM backfill_gaps WHERE state = 'permanent' AND to_ms >= ?").get(at - retention).n
  const notes = raw.prepare("SELECT DISTINCT note FROM backfill_gaps WHERE state = 'permanent'").all().map((x) => x.note)
  check('every pending hole older than the NVR keeps is made permanent, however many, and no other', r.permanent > 0 && aged === 0 && wrong === 0 && J(notes) === J([PERMANENT.aged]), J({ permanent: r.permanent, leftAged: aged, wrong, notes }))
}

// ---- 7. the pick: a page at a time, the same answer as all 10,000 at once ---------------------------------
{
  nowBox.t = NOW + 3 * HOUR + DAY
  const pending = raw.prepare("SELECT COUNT(*) AS n FROM backfill_gaps WHERE state = 'pending'").get().n
  // the NVR of the oldest hole the NVRs still keep: offline, every row before its next one is passed
  const first = index.backfillPending({ limit: 10_000 }).find((r) => r.fromMs + RET_DAYS * DAY > nowBox.t)
  const offline = { online: false }
  const scenarios = [
    ['every NVR ready', {}, new Set(), 0],
    [`${first.nvr} (the oldest hole's) offline`, { [first.nvr]: offline }, new Set(), 0],
    ['two NVRs busy, one refusing', {}, new Set(['nvr-2', 'value4u']), 0],
    ['a third of the rows backing off', {}, new Set(), 1 / 3],
    ['the oldest 1,234 rows backing off (the pick on a later page)', {}, new Set(), -1234],
    ['all but rigginglot offline', { nvr1: offline, 'nvr-2': offline, value4u: offline }, new Set(), 0],
    ['every NVR offline (no pick: the reason)', { nvr1: offline, 'nvr-2': offline, value4u: offline, rigginglot: offline }, new Set(), 0]
  ]
  const bad = []
  const pages = []
  for (const [name, nvrs, busy, backingOff] of scenarios) {
    const job = makeJob({ nvrs })
    if (name.includes('refusing')) job.refusingOf = (id) => id === 'rigginglot'
    for (const b of busy) job.busyNvrs.add(b)
    if (backingOff) for (const [i, r] of index.backfillPending({ limit: 10_000 }).entries()) if (backingOff < 0 ? i < -backingOff : rand() < backingOff) job.nextTry.set(r.id, nowBox.t + HOUR)
    const want = chooseGap(index.backfillPending({ limit: 10_000 }).map((r) => ({ ...r, nextTryMs: job.nextTry.get(r.id) ?? 0 })), { now: nowBox.t, nvrs: job.nvrView(), retentionMsOf: () => job.retentionMs(), busyNvrs: job.busyNvrs })
    let read = 0
    const real = index.backfillPendingPage
    index.backfillPendingPage = (o) => {
      const rows = real(o)
      read += rows.length
      return rows
    }
    const got = await job.pick(nowBox.t)
    index.backfillPendingPage = real
    pages.push(`${name}: ${read} rows read`)
    if (got.row?.id !== want.row?.id || got.why !== want.why) bad.push(`${name}: ${got.row?.id ?? got.why} vs ${want.row?.id ?? want.why}`)
  }
  check(`the pick, a page at a time, picks what chooseGap picks from the oldest 10,000 pending rows (${pending.toLocaleString('en')} pending)`, bad.length === 0, bad.join('; ') || pages.join('; '))
  check('... reading one page or a few when the oldest rows can be pulled, not 10,000', Number(/(\d+) rows/.exec(pages[0])?.[1]) <= 3 * bf.PICK_PAGE, pages[0])
}

// ---- 8. stopped half way: the next scan goes on, and ends with the same ledger ----------------------------
{
  resetLedger()
  nowBox.t = NOW
  const job = makeJob()
  let asked = 0
  const r1 = await job.scan({ stop: () => ++asked > 400 })
  const partial = raw.prepare('SELECT COUNT(*) AS n FROM backfill_scan').get().n
  const r2 = await job.scan()
  check('a scan stopped half way keeps its marks, and the next one goes on from them', r1.stopped === true && partial > 0 && partial < CAMS.length && r1.slices + r2.slices < CAMS.length * 140, J({ first: r1.slices, marks: partial, second: r2.slices }))
  sameHoles('... and the ledger ends up exactly the old scan\'s', ledger(), refs[0])
}

// ---- 9. a long file begun over an hour before the window: the scan finds the hole after it. Until the
//         MAX_SEGMENT_MS fix (rec-index.mjs) segments() could not see such a file and only scanSpans() caught
//         it; segments() now consults segments_long too, so the segments()-based scan agrees. ------------
{
  const ix = openRecIndex(join(DATA, 'edge.db'))
  const from = NOW - RET_DAYS * DAY - SCAN_MARGIN_MS
  ix.addSegment({ nvr: 'e', ch: 0, path: '/e/long.h264', startMs: from - 2 * HOUR, endMs: from + HOUR, bytes: 1, keyframes: 1, loc: 'L1' })
  ix.addSegment({ nvr: 'e', ch: 0, path: '/e/next.h264', startMs: from + HOUR + 5 * MIN, endMs: from + 2 * HOUR, bytes: 1, keyframes: 1, loc: 'L1' })
  ix.addSegment({ nvr: 'e', ch: 0, path: '/e/now.h264', startMs: NOW - MIN, endMs: NOW, bytes: 1, keyframes: 1, loc: 'L1' })
  const job = new BackfillJob({ index: ix, settings: () => ({ backfill: cfg }), now: () => NOW, stateFile: join(DATA, 'edge.json'), log: () => {} })
  await job.scan()
  const rows = ix.backfillList({})
  const old = findGaps({ nvr: 'e', ch: 0, now: NOW, fromMs: from, toMs: NOW, segments: ix.segments('e', 0, from, NOW), gapRows: [] })
  check('a file over an hour long that began before the window: the hole after it is recorded permanent (older than the NVR keeps), and segments() now sees the long file so the scan over it agrees', rows.some((r) => r.fromMs === from + HOUR && r.toMs === from + HOUR + 5 * MIN && r.state === 'permanent') && old.some((g) => g.fromMs === from + HOUR), J(rows.map((r) => [r.fromMs - from, r.toMs - from, r.state])))
  ix.close()
}

raw.close()
index.close()
console.log(`\n${checks - failures} of ${checks} passed`)
if (failures) console.log(`${failures} failed`)
process.exit(failures ? 1 : 0)
