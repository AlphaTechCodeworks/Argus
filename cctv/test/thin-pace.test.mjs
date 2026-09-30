// Tests for thin-pace.mjs: how fast time-lapse thinning goes, when, and when it stands back.
//   node cctv/test/thin-pace.test.mjs
// Any PC, no SDK. The capacity figures come from a model (thin-pace.mjs fileMs) built on the audit's
// measurements of real footage read from the NAS on the production VM, one file at a time (perf report R1
// and its check verify-1, 29 Sep 2026), and on what that model assumes (ASSUMED: nobody has measured
// several reads at once beside the recording, nor a rewrite written to the NAS); the number of file calls
// a rewrite makes is counted here from the share helper's own ops, so the proof follows the code if it
// changes. The back-off and the day rule's figure (review of p3-thin) are what keep recording safe if the
// model is wrong.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const P = await import('../thin-pace.mjs')
const { makeShareOps } = await import('../share-ops.mjs')

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const HOUR = 3_600_000
const MIN = 60_000

// ---- the defaults and the settings from the environment -------------------------------------------------
{
  const d = P.thinPace({})
  check('defaults: 40 MB/s of footage read, 3 files at a time, night 20:00-06:00 site time', d.mbps === 40 && d.atOnce === 3 && d.night.from === 20 * 60 && d.night.to === 6 * 60, JSON.stringify(d))
  const e = P.thinPace({ CCTV_THIN_MBPS: '25', CCTV_THIN_NIGHT: '22:30-05:15' })
  check('CCTV_THIN_MBPS and CCTV_THIN_NIGHT change them', e.mbps === 25 && e.night.from === 22 * 60 + 30 && e.night.to === 5 * 60 + 15, JSON.stringify(e))
  const bad = P.thinPace({ CCTV_THIN_MBPS: 'fast', CCTV_THIN_NIGHT: '25:00-xx' })
  check('values that cannot be read are the defaults, and say so', bad.mbps === 40 && bad.night.from === 20 * 60 && bad.warnings.length === 2, JSON.stringify(bad))
  check('... as is a pace of 0 or one above 200 MB/s', P.thinPace({ CCTV_THIN_MBPS: '0' }).mbps === 40 && P.thinPace({ CCTV_THIN_MBPS: '500' }).mbps === 40)
}

// ---- the file calls one rewrite makes (thin, thinSwap, thinCommit), counted from the helper's ops ----------
const nal = (type, payload) => Buffer.concat([Buffer.from([0, 0, 0, 1, type & 0x1f]), Buffer.from(payload)])
const frame = (isKey, size = 40) => Buffer.concat([nal(9, [0x10]), nal(isKey ? 5 : 1, Buffer.alloc(size, isKey ? 0xa5 : 0x5c).map((v, i) => (i === 0 ? 0x88 : v)))])
let calls = null
{
  const root = mkdtempSync(join(tmpdir(), 'thin-pace-'))
  writeFileSync(join(root, '.cctv-recordings'), JSON.stringify({ id: 'L1' }))
  const p = join(root, 'n1', '0', '2026-09-22', '08', '00.h264')
  mkdirSync(dirname(p), { recursive: true })
  const parts = []
  const idx = []
  let off = 0
  for (let g = 0; g < 30; g++) {
    const k = frame(true, 4000)
    idx.push([off, Date.UTC(2026, 8, 22, 8) + g * 2000])
    parts.push(k)
    off += k.length
    for (let f = 0; f < 39; f++) {
      const x = frame(false, 300)
      parts.push(x)
      off += x.length
    }
  }
  writeFileSync(p, Buffer.concat(parts))
  const ib = Buffer.alloc(idx.length * 16)
  idx.forEach(([o, t], i) => (ib.writeBigUInt64LE(BigInt(o), i * 16), ib.writeBigInt64LE(BigInt(t), i * 16 + 8)))
  writeFileSync(`${p}.idx`, ib)
  const ops = makeShareOps({ id: 'L1', root })
  let n = 0
  const tick = () => n++
  const r = await ops.thin({ path: p, timelapseS: 10, cursor: null, maxBytes: 1e9, swap: false }, tick)
  const a = n
  await ops.thinSwap({ path: p }, tick)
  const b = n
  await ops.thinCommit({ path: p }, tick)
  calls = n
  check('a whole rewrite (thin, swap, commit) makes a known number of file calls, each reported', r.outcome === 'thinned' && calls > 30 && calls < 80, `${a} + ${b - a} + ${calls - b} = ${calls}`)
  rmSync(root, { recursive: true, force: true })
}

// ---- the proof, on the model: a day's footage converted within about 16 hours at the defaults ------------
{
  const m = P.MEASURED
  const pace = P.thinPace({})
  const worst = P.fileMs(m.meanSegmentMB, { calls, worst: true })
  const best = P.fileMs(m.meanSegmentMB, { calls, worst: false })
  check('one 12 MB file end to end, on the model built from the audit\'s measurements: 0.5-0.8 s (verify-1: 0.53-0.63 s without the extra checks)', best > 450 && worst < 850 && best < worst, `${best.toFixed(0)}-${worst.toFixed(0)} ms, ${calls} file calls`)
  const one = P.throughputMBps({ mbps: 1000, atOnce: 1 }, { calls, worst: true })
  check('one file at a time cannot keep up with the recording on its worst figures (verify-1: 19-23 MB/s at most)', one < m.recordMBps[1], `${one.toFixed(1)} MB/s against ${m.recordMBps[1]} MB/s recorded`)
  const t = P.throughputMBps(pace, { calls, worst: true })
  check('three at a time reach the default pace on the worst figures, if three in flight each go as fast as one alone (ASSUMED, not measured)', t >= pace.mbps, `${t.toFixed(1)} MB/s`)
  const h = P.hoursForDay(m.dayTB[1], pace, { calls, worst: true })
  const h0 = P.hoursForDay(m.dayTB[0], pace, { calls, worst: true })
  check('THE BIGGEST DAY SEEN (1.65 TB) IS CONVERTED WITHIN 16 HOURS AT THE DEFAULTS, runs every 5 minutes included (on the model)', h <= 16, `${h.toFixed(1)} h (1.474 TB: ${h0.toFixed(1)} h)`)
  check('... and 20 MB/s (the audit\'s first idea) would not be: verify-1 was right that it is too tight', P.hoursForDay(m.dayTB[1], { ...pace, mbps: 20 }, { calls, worst: true }) > 24)
}

// ---- when: nights first, days only when the night alone would fall behind --------------------------------
const siteMin = (ms) => Math.floor((((ms / MIN) % 1440) + 1440) % 1440) // the site on UTC, for the test
const at = (h, mm = 0, ss = 0) => Date.UTC(2026, 9, 3, h, mm, ss)
{
  const pace = P.thinPace({})
  const d = (now, o = {}) => P.decideRun({ now, backlogBytes: 1e11, arrivalBytesPerHour: 6e10, pace, siteMin, ...o })
  check('at night it works', d(at(23)).work === true && d(at(23)).night === true && d(at(3)).work === true)
  check('by day with a backlog the coming night can clear: it waits for the night, and says so', d(at(14), { backlogBytes: 1e11, arrivalBytesPerHour: 1e10 }).work === false && /night/.test(d(at(14), { backlogBytes: 1e11, arrivalBytesPerHour: 1e10 }).why))
  check('by day with more than the coming night can clear: it works now', d(at(14), { backlogBytes: 1.2e12 }).work === true && /behind|catch up/.test(d(at(14), { backlogBytes: 1.2e12 }).why), d(at(14), { backlogBytes: 1.2e12 }).why)
  check('nothing waiting: nothing to do, night or day', d(at(23), { backlogBytes: 0 }).work === false && d(at(12), { backlogBytes: 0 }).work === false)
  const slow = d(at(23), { slow: { at: at(22, 55), nvr: 'n1', ch: 3 } })
  check('the recorder said "disk too slow" in the last 10 minutes: it stands back, and says when and where', slow.work === false && /disk too slow/.test(slow.why) && /22:55/.test(slow.why), slow.why)
  check('... and goes on once 10 minutes have passed', d(at(23, 6), { slow: { at: at(22, 55) } }).work === true)
  check('the night can cross midnight or not', P.inNight(at(21), { from: 20 * 60, to: 6 * 60 }, siteMin) && !P.inNight(at(7), { from: 20 * 60, to: 6 * 60 }, siteMin) && P.inNight(at(2), { from: 60, to: 300 }, siteMin) && !P.inNight(at(6), { from: 60, to: 300 }, siteMin))
  check('hours until the coming night ends: 16 at 14:00, 3 at 03:00', Math.abs(P.hoursToNightEnd(at(14), pace.night, siteMin) - 16) < 1e-9 && Math.abs(P.hoursToNightEnd(at(3), pace.night, siteMin) - 3) < 1e-9)
}

// ---- four days of the site's biggest days, run by the rule in 5-minute rounds -----------------------------
// At the default pace, the most it rises to (a fresh start begins lower: below). Footage passes the cutoff
// at the recording rate (1.65 TB a day, evenly); every 5 minutes the job decides, and when it works it
// converts at its pace for its 4 minutes of the round. The rule must keep up (the backlog at each night's
// end is small), prefer the night (most of the work is done there), and never let full video wait much
// past its full-video days.
{
  const pace = P.thinPace({})
  const rate = Math.min(pace.mbps, P.throughputMBps(pace, { calls, worst: true })) * 1e6 // bytes/s while working
  const perTick = rate * (P.RUN_MS / 1000)
  const arrivePerTick = (1.65e12 / 86_400) * 300
  let backlog = 0
  let bytes = 0
  let bytesNight = 0
  let maxBacklog = 0
  const endOfNight = []
  const hoursByDay = []
  let today = 0 // seconds converting today, in 5-minute rounds of RUN_MS working time
  for (let t = at(0) - 4 * 86_400_000; t < at(0); t += 5 * MIN) {
    backlog += arrivePerTick
    const r = P.decideRun({ now: t, backlogBytes: backlog, arrivalBytesPerHour: arrivePerTick * 12, pace, siteMin, factor: 1, slow: null, strain: null, achievedMBps: null })
    if (r.work) {
      const done = Math.min(backlog, perTick)
      backlog -= done
      bytes += done
      if (r.night) bytesNight += done
      today += (done / rate) * (300_000 / P.RUN_MS) // the round's other minute counts too
    }
    maxBacklog = Math.max(maxBacklog, backlog)
    if (siteMin(t) === pace.night.to) endOfNight.push(backlog)
    if (siteMin(t) === 1440 - 5) (hoursByDay.push(today / 3600), (today = 0))
  }
  const lagH = maxBacklog / (1.65e12 / 24)
  check('four days at 1.65 TB a day: the job keeps up (each night ends with less than 2 hours of footage waiting)', endOfNight.slice(1).every((b) => b < 2 * (1.65e12 / 24)), endOfNight.map((b) => `${(b / 1e9).toFixed(0)} GB`).join(', '))
  check('... in at most 16 hours of 5-minute rounds a day', hoursByDay.every((h) => h <= 16), hoursByDay.map((h) => `${h.toFixed(1)} h`).join(', '))
  check('... most of it at night', bytesNight / bytes > 0.6, `${((bytesNight / bytes) * 100).toFixed(0)}% of ${(bytes / 1e12).toFixed(2)} TB at night`)
  check('... and full video never waits more than half a day past its full-video days', lagH < 12, `${lagH.toFixed(1)} h at most`)
}

// ---- the pace: bytes read per second, never more ------------------------------------------------------------
{
  let clock = 0
  const slept = []
  const b = P.makeBucket(10e6, { now: () => clock, sleep: async (ms) => (slept.push(ms), (clock += ms)) })
  await b.take(12e6) // the first file goes at once
  await b.take(12e6) // then 1.2 s after it
  await b.take(6e6)
  check('the bucket spaces files by their size at the pace (10 MB/s: 12 MB, 1.2 s, then 12 MB, 1.2 s)', slept.length === 2 && Math.abs(slept[0] - 1200) < 1e-6 && Math.abs(slept[1] - 1200) < 1e-6 && clock === 2400, JSON.stringify(slept))
  clock += 60_000
  slept.length = 0
  await b.take(12e6)
  check('... and a pause does not save up a burst beyond the next file', slept.length === 0 && Math.abs(b.waitMs() - 1200) < 1e-6)
}

// ---- "disk too slow" from the recorder --------------------------------------------------------------------
{
  P._test.reset()
  check('nothing reported: no slow disk', P.lastDiskTooSlow() === null && P.recorderReports().length === 0)
  P.noteRecorderGap({ t: 'recgap', nvr: 'n1', ch: 4, fromMs: 1, toMs: 2, reason: 'camera offline' }, 1000)
  check('another gap reason is not a slow disk', P.lastDiskTooSlow() === null && P.recorderReports().length === 0)
  P.noteRecorderGap({ t: 'recgap', nvr: 'n1', ch: 4, fromMs: 3000, toMs: 4000, reason: 'disk too slow: a write has waited 5.2 s' }, 5000)
  const s = P.lastDiskTooSlow()
  check('"disk too slow" is remembered with when it was reported, when its gap began, and which camera', s?.at === 5000 && s.fromMs === 3000 && s.nvr === 'n1' && s.ch === 4 && /5\.2 s/.test(s.reason), JSON.stringify(s))
  P.noteRecorderGap({ t: 'recgap', nvr: 'n1', ch: 5, fromMs: 3100, toMs: 4000, reason: 'disk too slow: a write has waited 5.0 s' }, 6000)
  check('... every report kept (for the rounds they fall in), not only the last', P.recorderReports().length === 2 && P.lastDiskTooSlow().ch === 5, JSON.stringify(P.recorderReports()))
  P._test.reset()
}

// ---- the recorders' writes waiting: the warning before a gap ------------------------------------------------
// Review of p3-thin, round 2 (2026-09-30): each recorder's write queue (Recorder.status().queue, in the workers'
// stats every 5 s) shows the disk falling behind before any frame is dropped: a gap starts at 10 s or 8 MB
// waiting (segment-writer.mjs). Half of either stops time-lapse there, before recording loses anything.
{
  P._test.reset()
  const pace = P.thinPace({})
  P.noteRecorderQueues('n1', { 2: { queue: { bytes: 2e5, ageMs: 300 } }, 3: { queue: null } }, at(1))
  check('the recorders\' writes waiting a little (0.3 s): nothing', P.lastStrain() === null)
  P.noteRecorderQueues('n1', { 2: { queue: { bytes: 2e5, ageMs: 300 } }, 5: { queue: { bytes: 3e6, ageMs: 6200 } } }, at(1))
  const s = P.lastStrain()
  check('A CAMERA\'S WRITES WAITING 6.2 S (a gap comes at 10): noted, with the camera', s?.nvr === 'n1' && s.ch === 5 && s.ageMs === 6200 && s.at === at(1) && s.fromMs === at(1) - 6200, JSON.stringify(s))
  P.noteRecorderQueues('n1', { 7: { queue: { bytes: 5 * 1024 * 1024, ageMs: 900 } } }, at(1, 2))
  check('... as is 5 MB waiting (a gap comes at 8 MB)', P.lastStrain()?.ch === 7 && P.lastStrain().at === at(1, 2))
  const held = P.decideRun({ now: at(1, 3), backlogBytes: 1e11, arrivalBytesPerHour: 6e10, pace, siteMin, slow: null })
  check('while the writes wait: no round, and it says why', held.work === false && held.held === true && held.wouldWork === true && /waited|waiting/.test(held.why) && /01:02/.test(held.why), held.why)
  check('... and a round goes again 5 minutes after it', P.decideRun({ now: at(1, 8), backlogBytes: 1e11, arrivalBytesPerHour: 6e10, pace, siteMin, slow: null }).work === true)
  P._test.reset()
}

// ---- the pace learned from the rounds (review of p3-thin, round 2, 2026-09-30) --------------------------------
// The 40 MB/s default rests on a model, not on a measurement of the NAS beside the recording (thin-pace.mjs's
// header), and the back-off before this did not hold: the pace came back to 40 MB/s after every clean hour of
// rounds, only the last "disk too slow" was kept, and it was timed when it arrived. So a NAS taking 22-30 MB/s
// beside the recording got 8-9 recording gaps a day, every day, and a restart went back to 40. Now the pace has
// a ceiling: a fresh start at half the pace; a "disk too slow" (or writes waiting, above) whose gap began during a
// round -- or a minute after its end -- caps it at half what that round ran at; each whole night of rounds with
// none raises it one step (an eighth of the pace), never above the pace; the ceiling is kept in DATA_DIR.
const DAY = 86_400_000
const pace = P.thinPace({})
const settle = (now) => P.settleRound({ now, night: pace.night, siteMin, pace })
const round = (start, { end = start + P.RUN_MS, bytes = 4e9, full = true } = {}) => P.noteRound({ start, end, bytes, full, mbps: P.effectiveMbps(pace) })
/** Rounds every 5 minutes in [from, to), each settled when the next begins, as runThinning does; then one more look at `to`. */
const rounds = (from, to, o) => {
  for (let t = from; t < to; t += 5 * MIN) (settle(t), round(t, o))
  settle(to)
}
/** A whole night of rounds (20:00-06:00 site time) from the evening of day d, then a look a quarter of an hour after. */
const cleanNight = (d) => rounds(at(20) + d * DAY, at(20) + d * DAY + 10 * HOUR + 15 * MIN)
const mbps = () => P.effectiveMbps(pace)
{
  P._test.reset()
  check('A FRESH START GOES AT HALF THE PACE (20 of 40 MB/s): nothing has measured the NAS beside the recording', mbps() === 20 && P.paceFactor(pace) === 0.5, String(mbps()))
  check('... said in the pace (up to 40 MB/s, a step each night), not as a warning', /^20 MB\/s/.test(P.describePaceNow(pace)) && /up to 40 MB\/s/.test(P.describePaceNow(pace)) && /night/.test(P.describePaceNow(pace)) && P.backoffText(pace, siteMin) === '', P.describePaceNow(pace))
  rounds(at(20), at(24 + 2))
  check('... not raised in the middle of a night', mbps() === 20)
  rounds(at(24 + 2), at(24 + 6) + 15 * MIN)
  check('A WHOLE NIGHT OF ROUNDS WITH NO "DISK TOO SLOW": one step up (5 MB/s, to 25)', mbps() === 25, String(mbps()))
  rounds(at(24 + 8), at(24 + 19))
  check('... and not by day, however many clean rounds', mbps() === 25, String(mbps()))
  for (let d = 1; d < 6; d++) cleanNight(d)
  check('... one step a night, up to the pace (40 MB/s) and never above it', mbps() === 40, String(mbps()))
  P._test.reset()
  rounds(at(20), at(20, 40))
  settle(at(24 + 6, 15))
  check('a night with only 40 minutes of rounds says too little about the NAS: no step', mbps() === 20, String(mbps()))
  P._test.reset()
}
{
  P._test.reset()
  for (let d = 0; d < 4; d++) cleanNight(d)
  check('(four clean nights: the whole pace)', mbps() === 40)
  const t = at(23) + 4 * DAY
  settle(t)
  round(t)
  P.noteRecorderGap({ nvr: 'n1', ch: 2, fromMs: t + 60_000, toMs: t + 75_000, reason: 'disk too slow: a write has waited 10.1 s' }, t + 75_000)
  settle(t + 5 * MIN)
  const said = P.backoffText(pace, siteMin)
  check('"DISK TOO SLOW" WHOSE GAP BEGAN IN A ROUND: the pace capped at half what that round ran at (20 of 40 MB/s), and said with when and where', mbps() === 20 && /disk too slow/.test(said) && /23:01/.test(said) && /n1\/3/.test(said) && /40 MB\/s/.test(said), said)
  rounds(t + 15 * MIN, at(24 + 6) + 4 * DAY + 15 * MIN)
  check('... the rest of that night at 20, and no step at its end (it was not a night without one)', mbps() === 20, String(mbps()))
  rounds(at(24 + 7) + 4 * DAY, at(24 + 19) + 4 * DAY)
  check('THE LOWERED PACE HOLDS BY DAY: twelve clean hours of rounds do not bring it back (it came back after each clean hour: 8-9 gaps a day)', mbps() === 20, String(mbps()))
  cleanNight(5)
  check('... then one step after a whole night with none (25 MB/s)', mbps() === 25, String(mbps()))
  cleanNight(6)
  check('... and one more the next (30 MB/s)', mbps() === 30, String(mbps()))
  P._test.reset()
}
{
  // Held one step under the pace that cost a gap, and that pace tried again only now and then: halving and then
  // stepping straight back up averaged about three quarters of what the NAS takes (a day behind at 30 MB/s).
  const gapNight = (d) => {
    rounds(at(20) + d * DAY, at(23) + d * DAY)
    const t = at(23) + d * DAY
    settle(t)
    round(t)
    P.noteRecorderGap({ nvr: 'n1', ch: 0, fromMs: t + 30_000, toMs: t + 40_000, reason: 'disk too slow' }, t + 40_000)
    rounds(t + 5 * MIN, at(30) + d * DAY + 15 * MIN)
  }
  P._test.reset()
  for (let d = 0; d < 4; d++) cleanNight(d)
  gapNight(4)
  const seen = []
  for (let d = 5; d < 12; d++) (cleanNight(d), seen.push(mbps()))
  check('AFTER A GAP AT 40 MB/S: a step a night to one step under it (35), held there two whole nights, then 40 tried again; a whole night at it with none forgets the gap', seen.join() === '25,30,35,35,40,40,40' && P.paceState(pace).badMbps === null, `${seen.join()} bad ${P.paceState(pace).badMbps}`)
  P._test.reset()
  for (let d = 0; d < 4; d++) cleanNight(d)
  gapNight(4)
  for (let d = 5; d < 10; d++) cleanNight(d)
  check('(tried again at 40 after two nights at 35)', mbps() === 40)
  gapNight(10)
  check('... the try costs a gap again: 20 MB/s, and 40 MB/s still the pace that costs one', mbps() === 20 && P.paceState(pace).badMbps === 40, JSON.stringify(P.paceState(pace)))
  const seen2 = []
  let held = ''
  for (let d = 11; d < 18; d++) {
    cleanNight(d)
    seen2.push(mbps())
    if (d === 14) held = P.describePaceNow(pace)
  }
  check('... so the next try waits twice as long: four whole nights at 35', seen2.join() === '25,30,35,35,35,35,40', seen2.join())
  check('... and the pace says why it is held there, and until when (not a warning)', /^35 MB\/s \(up to 40 MB\/s: 40 MB\/s cost a recording gap; tried again after 3 more nights/.test(held), held)
  P._test.reset()
}
{
  // Review of p3-thin, round 2: only the LAST report was kept, so one during a round was forgotten when another
  // camera reported more than a minute after the round's end: a NAS that stalls makes each camera report as its
  // own recording resumes. And 87 cameras reporting one stall must not halve the pace 87 times.
  P._test.reset()
  for (let d = 0; d < 4; d++) cleanNight(d)
  const t = at(1) + 5 * DAY
  settle(t)
  P.noteRound({ start: t, end: t + 61_000, bytes: 2.4e9, full: true, mbps: 40 }) // stopped by the first report
  P.noteRecorderGap({ nvr: 'n1', ch: 0, fromMs: t + 50_000, toMs: t + 60_000, reason: 'disk too slow: a write has waited 10.0 s' }, t + 60_000)
  for (let c = 1; c < 6; c++) P.noteRecorderGap({ nvr: 'n1', ch: c, fromMs: t + 50_000 + c * 1000, toMs: t + 150_000, reason: 'disk too slow: 8.1 MB waiting to be written' }, t + 61_000 + 90_000 + c * 1000)
  settle(t + 5 * MIN)
  check('A BURST OF "DISK TOO SLOW" FROM SIX CAMERAS FOR ONE STALL, the last 90 s after the round ended: the pace halved once (20 MB/s)', mbps() === 20, String(mbps()))
  settle(t + 10 * MIN)
  settle(t + 20 * MIN)
  check('... each report counted once, each round once: still 20', mbps() === 20, String(mbps()))
  P._test.reset()
}
{
  // Timed by the gap's own start (the report's fromMs), not by when it arrives: a recorder says so only when it
  // records again, which after a long stall is minutes later.
  P._test.reset()
  for (let d = 0; d < 4; d++) cleanNight(d)
  const t = at(2) + 5 * DAY
  settle(t)
  round(t)
  settle(t + 5 * MIN) // (nothing reported yet; no round now)
  P.noteRecorderGap({ nvr: 'n2', ch: 9, fromMs: t + 200_000, toMs: t + 480_000, reason: 'disk too slow: a write has waited 10.0 s' }, t + 480_000)
  settle(t + 10 * MIN)
  check('A GAP THAT BEGAN IN A ROUND, REPORTED 4 MINUTES AFTER IT ENDED: it counts (20 MB/s)', mbps() === 20, String(mbps()))
  const t2 = t + 20 * MIN
  settle(t2)
  round(t2)
  P.noteRecorderGap({ nvr: 'n2', ch: 3, fromMs: t2 - 30_000, toMs: t2 + 20_000, reason: 'disk too slow: a write has waited 10.0 s' }, t2 + 20_000)
  settle(t2 + 5 * MIN)
  check('... while one that began before the round started (the NAS busy with something else), reported during it, does not', mbps() === 20, String(mbps()))
  const t3 = t2 + 10 * MIN
  settle(t3)
  round(t3)
  P.noteRecorderQueues('n1', { 4: { queue: { bytes: 1e6, ageMs: 5500 } } }, t3 + 100_000)
  settle(t3 + 5 * MIN)
  check('WRITES WAITING 5.5 S DURING A ROUND lower it as a gap would (10 MB/s): the warning before the gap', mbps() === 10 && /waited|waiting/.test(P.backoffText(pace, siteMin)), `${mbps()} ${P.backoffText(pace, siteMin)}`)
  P._test.reset()
}
{
  // Kept in DATA_DIR (thin-pace.json): in memory, a restart went back to the whole pace.
  const dir = mkdtempSync(join(tmpdir(), 'thin-pace-state-'))
  const file = join(dir, 'thin-pace.json')
  P._test.reset()
  await P.usePaceFile(file)
  check('no file yet: the start (20 MB/s)', mbps() === 20)
  const t = at(1) + 2 * DAY
  for (const s of [t, t + 15 * MIN]) {
    settle(s)
    round(s)
    P.noteRecorderGap({ nvr: 'n1', ch: 1, fromMs: s + 30_000, toMs: s + 40_000, reason: 'disk too slow' }, s + 40_000)
  }
  settle(t + 20 * MIN)
  await P.flushPace()
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  check('A LOWERED PACE IS SAVED IN DATA_DIR: 5 MB/s after two rounds with a gap (20, then 10, then the floor)', mbps() === 5 && saved.capMbps === 5, JSON.stringify(saved))
  const was = mbps()
  P._test.reset()
  check('(memory gone: the start again)', mbps() === 20)
  await P.usePaceFile(file)
  check('... AND A RESTART GOES ON AT IT, not at the whole pace, and knows which pace cost the gap', mbps() === was && /10 MB\/s cost a recording gap/.test(P.describePaceNow(pace)), `${mbps()} ${P.describePaceNow(pace)}`)
  writeFileSync(file, 'not json')
  P._test.reset()
  const warned = []
  const warn = console.warn
  console.warn = (m) => warned.push(String(m))
  await P.usePaceFile(file)
  console.warn = warn
  check('a file that cannot be read: the start, and the log says so', mbps() === 20 && warned.some((w) => /thin-pace\.json/.test(w)), warned.join(' | '))
  P._test.reset()
  rmSync(dir, { recursive: true, force: true })
}

// ---- the day rule counts what rounds really converted, when that is less than the pace -----------------------
// Review of p3-thin: the rule judged the coming night from the set pace (40 MB/s x 10 h x 0.8 = 1.15 TB); with
// stand-backs or a slower NAS the rounds convert less, day work started only once a night's worth was waiting,
// and the backlog drifted towards the 1-day FALLING BEHIND mark.
{
  P._test.reset()
  check('before any round: nothing measured', P.achievedMBps() === null)
  // rounds that ran their 4 minutes converting 4.8 GB each: 20 MB/s
  for (let i = 0; i < 6; i++) P.noteRound({ start: at(1) + i * 5 * MIN, end: at(1) + i * 5 * MIN + P.RUN_MS, bytes: 4.8e9, full: true }), P.settleRound({ now: at(1) + (i + 1) * 5 * MIN, night: pace.night, siteMin, pace })
  // a round that ran out of files says nothing about what the NAS can do
  P.noteRound({ start: at(2), end: at(2) + 30_000, bytes: 1e8, full: false })
  P.settleRound({ now: at(2, 5), night: pace.night, siteMin, pace })
  check('what the rounds converted while they could: 20 MB/s (a round that ran out of files not counted)', Math.abs(P.achievedMBps() - 20) < 1e-9, String(P.achievedMBps()))
  const d = (o) => P.decideRun({ now: at(14), backlogBytes: 5e11, arrivalBytesPerHour: 1e10, pace, siteMin, slow: null, strain: null, factor: 1, ...o })
  const byPace = d({ achievedMBps: null })
  const byRounds = d({ achievedMBps: P.achievedMBps() })
  check('by day, 500 GB waiting: at the set pace the night would clear it, at what the rounds converted it would not: it works now, and says why', byPace.work === false && byRounds.work === true && /20 MB\/s/.test(byRounds.why), `${byPace.why} | ${byRounds.why}`)
  check('... and a lowered pace counts the same way', d({ factor: 0.25, achievedMBps: null }).work === true, d({ factor: 0.25, achievedMBps: null }).why)
  P._test.reset()
}
{
  // Review of p3-thin, round 2: a round held back by a recent "disk too slow" counted as a round that converted
  // nothing, even by day when the rule would have waited for the night anyway -- and on a shared NAS its other
  // users cause such reports too. Four of them one afternoon made the rule work by day, adding load exactly when
  // the NAS was under stress. The rule now says whether the round would have worked (wouldWork); runThinning
  // counts a held round only then.
  const siteDay = (o) => P.decideRun({ now: at(13), backlogBytes: 5e10, arrivalBytesPerHour: 6e10, pace, siteMin, strain: null, factor: 1, achievedMBps: 40, ...o })
  const held = siteDay({ slow: { at: at(12, 58), nvr: 'n1', ch: 0 } })
  check('BY DAY, WAITING FOR THE NIGHT, "DISK TOO SLOW" HOLDS IT BACK: and it says it would not have worked anyway', held.work === false && held.held === true && held.wouldWork === false && siteDay({ slow: null }).work === false, JSON.stringify(held))
  const night = P.decideRun({ now: at(23), backlogBytes: 5e10, arrivalBytesPerHour: 6e10, pace, siteMin, strain: null, factor: 1, achievedMBps: 40, slow: { at: at(22, 58) } })
  check('... at night it would have: that one counts as a round that converted nothing', night.held === true && night.wouldWork === true, JSON.stringify(night))
  // the reviewer's afternoon, as runThinning now notes it: a clean night at 40 MB/s, 50 GB waiting at 13:00,
  // four reports between 13:00 and 15:00 while it waits; at 15:30 it still waits for the night
  P._test.reset()
  for (let i = 0; i < 12; i++) P.noteRound({ start: at(1) + i * 5 * MIN, end: at(1) + i * 5 * MIN + P.RUN_MS, bytes: 9.6e9, full: true }), P.settleRound({ now: at(1) + (i + 1) * 5 * MIN, night: pace.night, siteMin, pace })
  let slow = null
  const reports = [at(13, 10), at(13, 40), at(14, 10), at(14, 40)]
  for (let t = at(13); t <= at(15, 30); t += 5 * MIN) {
    for (const r of reports) if (r <= t && (!slow || slow.at < r)) slow = { at: r, nvr: 'n1', ch: 0 }
    P.settleRound({ now: t, night: pace.night, siteMin, pace })
    const dec = P.decideRun({ now: t, backlogBytes: 5e10, arrivalBytesPerHour: 6e10, pace, siteMin, slow, strain: null, factor: 1 })
    if (dec.held && dec.wouldWork) P.noteRound({ start: t, end: t, held: true })
  }
  const later = P.decideRun({ now: at(15, 30), backlogBytes: 5e10 + 6e10 * 2.5, arrivalBytesPerHour: 6e10, pace, siteMin, slow: null, strain: null, factor: 1 })
  check('... so reports by day while it waits leave what the rounds converted as it was (40 MB/s), and at 15:30 it still waits for the night', Math.abs(P.achievedMBps() - 40) < 1e-9 && later.work === false, `${P.achievedMBps()} MB/s; ${later.why}`)
  P._test.reset()
}
{
  // A quieter spell (0.8 TB a day) on a NAS that gives the job only 16 MB/s while it works: the night converts
  // 0.46 TB of it. Judged at the set pace (1.15 TB a night), the day rule waited until more than a night's worth
  // was behind, and full video waited past the 1-day FALLING BEHIND mark; judged at what the rounds converted,
  // it works by day in time. (At the site's 1.47-1.65 TB days the rule works most of each day either way.)
  const sim = (useAchieved) => {
    P._test.reset()
    const rate = 16e6
    const arrivePerTick = (0.8e12 / 86_400) * 300
    let backlog = 0
    let maxBacklog = 0
    for (let t = at(0) - 10 * 86_400_000; t < at(0); t += 5 * MIN) {
      backlog += arrivePerTick
      P.settleRound({ now: t, night: pace.night, siteMin, pace })
      const r = P.decideRun({ now: t, backlogBytes: backlog, arrivalBytesPerHour: arrivePerTick * 12, pace, siteMin, slow: null, strain: null, factor: 1, achievedMBps: useAchieved ? P.achievedMBps() : null })
      if (r.work) {
        const done = Math.min(backlog, rate * (P.RUN_MS / 1000))
        backlog -= done
        P.noteRound({ start: t, end: t + P.RUN_MS, bytes: done, full: done >= rate * (P.RUN_MS / 1000), mbps: 40 })
      }
      maxBacklog = Math.max(maxBacklog, backlog)
    }
    return maxBacklog / (0.8e12 / 24)
  }
  const before = sim(false)
  const after = sim(true)
  check('ten days of 0.8 TB on a NAS at 16 MB/s: judged at what the rounds converted, full video never waits a day past its full-video days (the FALLING BEHIND mark); judged at the set pace it did', before > 24 && after < 24, `${after.toFixed(1)} h at most on what rounds converted; ${before.toFixed(1)} h on the set pace`)
  P._test.reset()
}

// ---- a NAS that can take only so much beside the recording: at most one gap a night -----------------------------
// Review of p3-thin, round 2: rounds that go faster than the NAS can take beside the recording cost a recording
// gap. The whole job as runThinning runs it (settle, decide, a held round noted only when it would have worked,
// the pace's own ceiling), 21 days of 1.5 TB, a NAS that takes L MB/s of reads beside the recording: a round
// above L gets a stall 45 s in, reported by six cameras over the next 2.5 minutes as their recording resumes
// (the first stops the round). No early warning from the writes waiting here: the worst case.
const nasSim = (L, { dayTB = 1.5, days = 21, steadyFrom = 8 } = {}) => {
  P._test.reset()
  const arrivePerTick = ((dayTB * 1e12) / 86_400) * 300
  const siteDay = (t) => Math.floor((t - at(12)) / DAY) // noon to noon: a night and the day after it
  const gaps = new Map()
  let backlog = 0
  let maxLagH = 0
  let bytes = 0
  const start = at(12) - days * DAY
  for (let t = start; t < at(12); t += 5 * MIN) {
    backlog += arrivePerTick
    settle(t)
    const r = P.decideRun({ now: t, backlogBytes: backlog, arrivalBytesPerHour: arrivePerTick * 12, pace, siteMin })
    if (!r.work) {
      if (r.held && r.wouldWork) P.noteRound({ start: t, end: t, held: true })
    } else {
      const p = mbps()
      const rate = P.throughputMBps({ ...pace, mbps: p }, { calls, worst: true }) * 1e6
      if (p > L) {
        const done = Math.min(backlog, rate * 60)
        backlog -= done
        bytes += done
        for (let c = 0; c < 6; c++) P.noteRecorderGap({ nvr: 'n1', ch: c, fromMs: t + 45_000 + c * 1000, toMs: t + 60_000 + c * 30_000, reason: 'disk too slow: a write has waited 10.0 s' }, t + 60_000 + c * 30_000)
        P.noteRound({ start: t, end: t + 61_000, bytes: done, full: true, mbps: p })
        gaps.set(siteDay(t), (gaps.get(siteDay(t)) ?? 0) + 1)
      } else {
        const done = Math.min(backlog, rate * (P.RUN_MS / 1000))
        backlog -= done
        bytes += done
        P.noteRound({ start: t, end: t + P.RUN_MS, bytes: done, full: done >= rate * (P.RUN_MS / 1000), mbps: p })
      }
    }
    if (t - start >= steadyFrom * DAY) maxLagH = Math.max(maxLagH, backlog / ((dayTB * 1e12) / 24))
  }
  const steady = [...Array(days - steadyFrom).keys()].map((i) => gaps.get(siteDay(start) + steadyFrom + i) ?? 0)
  P._test.reset()
  return { most: Math.max(...steady), total: steady.reduce((a, b) => a + b, 0), days: steady.length, maxLagH, all: [...gaps.values()].reduce((a, b) => a + b, 0) }
}
{
  const out = [12, 22, 30, 36].map((L) => ({ L, ...nasSim(L) }))
  check('A NAS THAT TAKES 12, 22, 30 OR 36 MB/S BESIDE THE RECORDING: AT MOST ONE RECORDING GAP A NIGHT (and the day after it) once settled, days 9-21', out.every((o) => o.most <= 1), out.map((o) => `${o.L} MB/s: ${o.total} gaps in ${o.days} days, at most ${o.most} a day (${o.all} in all 21)`).join('; '))
  const keep = out.filter((o) => o.L >= 30)
  check('... and at 30 MB/s or more it keeps up with 1.5 TB a day: full video never waits a day past its full-video days', keep.every((o) => o.maxLagH < 24), out.map((o) => `${o.L} MB/s: ${o.maxLagH.toFixed(1)} h`).join(', '))
  const all = nasSim(1000, { dayTB: 1.65, days: 10, steadyFrom: 0 })
  check('a NAS that takes it all, from a fresh start at 20 MB/s on the biggest days (1.65 TB): no gap, and full video never waits a day past its days while the pace steps up', all.all === 0 && all.maxLagH < 24, `${all.maxLagH.toFixed(1)} h at most`)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
