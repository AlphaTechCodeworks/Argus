// Tests for thin-pace.mjs: how fast time-lapse thinning goes, when, and when it stands back.
//   node cctv/test/thin-pace.test.mjs
// Any PC, no SDK. The capacity figures come from a model (thin-pace.mjs fileMs) built on the audit's
// measurements of real footage read from the NAS on the production VM, one file at a time (perf report R1
// and its check verify-1, 29 Sep 2026), and on what that model assumes (ASSUMED: nobody has measured
// several reads at once beside the recording, nor a rewrite written to the NAS); the number of file calls
// a rewrite makes is counted here from the share helper's own ops, so the proof follows the code if it
// changes. The back-off and the day rule's figure (review of p3-thin) are what keep recording safe if the
// model is wrong.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
// Footage passes the cutoff at the recording rate (1.65 TB a day, evenly); every 5 minutes the job decides,
// and when it works it converts at its pace for its 4 minutes of the round. The rule must keep up (the
// backlog at each night's end is small), prefer the night (most of the work is done there), and never let
// full video wait much past its full-video days.
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
    const r = P.decideRun({ now: t, backlogBytes: backlog, arrivalBytesPerHour: arrivePerTick * 12, pace, siteMin })
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
  check('nothing reported: no slow disk', P.lastDiskTooSlow() === null)
  P.noteRecorderGap({ t: 'recgap', nvr: 'n1', ch: 4, fromMs: 1, toMs: 2, reason: 'camera offline' }, 1000)
  check('another gap reason is not a slow disk', P.lastDiskTooSlow() === null)
  P.noteRecorderGap({ t: 'recgap', nvr: 'n1', ch: 4, fromMs: 1, toMs: 2, reason: 'disk too slow: a write has waited 5.2 s' }, 5000)
  const s = P.lastDiskTooSlow()
  check('"disk too slow" is remembered with when (when it was reported) and which camera', s?.at === 5000 && s.nvr === 'n1' && s.ch === 4 && /5\.2 s/.test(s.reason), JSON.stringify(s))
}

// ---- backing off: a "disk too slow" while it converted halves the pace for the rest of the night -------------
// Review of p3-thin (2026-09-29): the 40 MB/s default rests on a model, not on a measurement of the NAS under
// recording, and standing back 10 minutes only came after a recording gap, then went on at the same pace: a
// pace too fast would cost recording again and again, every night. Now each such report during a round (or
// within a minute of its end: recording's writes reach the NAS up to ~30 s late) halves the pace, to 1/8 at
// most; it holds for the rest of that night, and comes back step by step: doubled after each hour of rounds
// (12 rounds' working time) with no report, from the night's end on.
{
  P._test.reset()
  const pace = P.thinPace({})
  const round = (start, { bytes = 1e9, full = true } = {}) => P.noteRound({ start, end: start + P.RUN_MS, bytes, full })
  const settle = (now, slow = P.lastDiskTooSlow()) => P.settleRound({ slow, night: pace.night, siteMin }) // (now: when the next round begins)
  check('no report: the whole pace', P.paceFactor() === 1 && P.effectiveMbps(pace) === 40)
  round(at(23))
  P.noteRecorderGap({ nvr: 'n1', ch: 2, reason: 'disk too slow: a write has waited 5.0 s' }, at(23, 2))
  settle(at(23, 5))
  check('a "disk too slow" during a round: the pace halved (20 MB/s), and said with when', P.paceFactor() === 0.5 && P.effectiveMbps(pace) === 20 && /halved/.test(P.backoffText(pace, siteMin)) && /23:02/.test(P.backoffText(pace, siteMin)), P.backoffText(pace, siteMin))
  settle(at(23, 10))
  check('... once for that report, however often it is looked at', P.paceFactor() === 0.5)
  round(at(23, 15))
  P.noteRecorderGap({ nvr: 'n1', ch: 2, reason: 'disk too slow' }, at(23, 19, 30))
  settle(at(23, 20))
  round(at(23, 30))
  P.noteRecorderGap({ nvr: 'n1', ch: 2, reason: 'disk too slow' }, at(23, 34, 30)) // 30 s after the round's end
  settle(at(23, 35))
  round(at(23, 40))
  P.noteRecorderGap({ nvr: 'n1', ch: 2, reason: 'disk too slow' }, at(23, 44, 10))
  settle(at(23, 45))
  check('... again at each report while it converts (one a minute after a round counts too), to 1/8 at most', P.paceFactor() === 0.125 && P.effectiveMbps(pace) === 5, String(P.paceFactor()))
  P.noteRecorderGap({ nvr: 'n1', ch: 2, reason: 'disk too slow' }, at(23, 52))
  settle(at(23, 55))
  check('a report while it was not converting (between rounds) does not lower it', P.paceFactor() === 0.125)
  // the rest of the night: clean rounds do not bring it back before 06:00
  for (let t = at(23, 50); t < at(24 + 5, 55); t += 5 * MIN) (round(t), settle(t + 5 * MIN))
  check('the rest of the night at the lowered pace, however many clean rounds', P.paceFactor() === 0.125, String(P.paceFactor()))
  // from the night's end: each hour of rounds (12 rounds' work) with no report doubles it back
  for (let i = 0; i < 12; i++) (round(at(24 + 20) + i * 5 * MIN), settle(at(24 + 20) + (i + 1) * 5 * MIN))
  check('... then doubled after an hour of rounds with no report', P.paceFactor() === 0.25, String(P.paceFactor()))
  for (let i = 0; i < 24; i++) (round(at(24 + 21) + i * 5 * MIN), settle(at(24 + 21) + (i + 1) * 5 * MIN))
  check('... and so on, back to the whole pace, never above it', P.paceFactor() === 1, String(P.paceFactor()))
  for (let i = 0; i < 24; i++) (round(at(24 + 23) + i * 5 * MIN), settle(at(24 + 23) + (i + 1) * 5 * MIN))
  check('... and stays there while no report comes', P.paceFactor() === 1)
  P._test.reset()
}

// ---- the day rule counts what rounds really converted, when that is less than the pace -----------------------
// Review of p3-thin: the rule judged the coming night from the set pace (40 MB/s x 10 h x 0.8 = 1.15 TB); with
// stand-backs or a slower NAS the rounds convert less, day work started only once a night's worth was waiting,
// and the backlog drifted towards the 1-day FALLING BEHIND mark.
{
  P._test.reset()
  const pace = P.thinPace({})
  check('before any round: nothing measured', P.achievedMBps() === null)
  // rounds that ran their 4 minutes converting 4.8 GB each: 20 MB/s
  for (let i = 0; i < 6; i++) P.noteRound({ start: at(1) + i * 5 * MIN, end: at(1) + i * 5 * MIN + P.RUN_MS, bytes: 4.8e9, full: true }), P.settleRound({ slow: null, night: pace.night, siteMin })
  // a round that ran out of files says nothing about what the NAS can do
  P.noteRound({ start: at(2), end: at(2) + 30_000, bytes: 1e8, full: false })
  P.settleRound({ slow: null, night: pace.night, siteMin })
  check('what the rounds converted while they could: 20 MB/s (a round that ran out of files not counted)', Math.abs(P.achievedMBps() - 20) < 1e-9, String(P.achievedMBps()))
  const d = (o) => P.decideRun({ now: at(14), backlogBytes: 5e11, arrivalBytesPerHour: 1e10, pace, siteMin, slow: null, ...o })
  const byPace = d({ achievedMBps: null })
  const byRounds = d({ achievedMBps: P.achievedMBps() })
  check('by day, 500 GB waiting: at the set pace the night would clear it, at what the rounds converted it would not: it works now, and says why', byPace.work === false && byRounds.work === true && /20 MB\/s/.test(byRounds.why), `${byPace.why} | ${byRounds.why}`)
  check('... and the halved pace counts the same way', d({ factor: 0.25 }).work === true, d({ factor: 0.25 }).why)
  P._test.reset()
}
{
  // A quieter spell (0.8 TB a day) on a NAS that gives the job only 16 MB/s while it works: the night converts
  // 0.46 TB of it. Judged at the set pace (1.15 TB a night), the day rule waited until more than a night's worth
  // was behind, and full video waited past the 1-day FALLING BEHIND mark; judged at what the rounds converted,
  // it works by day in time. (At the site's 1.47-1.65 TB days the rule works most of each day either way.)
  const pace = P.thinPace({})
  const sim = (useAchieved) => {
    P._test.reset()
    const rate = 16e6
    const arrivePerTick = (0.8e12 / 86_400) * 300
    let backlog = 0
    let maxBacklog = 0
    for (let t = at(0) - 10 * 86_400_000; t < at(0); t += 5 * MIN) {
      backlog += arrivePerTick
      P.settleRound({ slow: null, night: pace.night, siteMin })
      const r = P.decideRun({ now: t, backlogBytes: backlog, arrivalBytesPerHour: arrivePerTick * 12, pace, siteMin, slow: null, achievedMBps: useAchieved ? P.achievedMBps() : null })
      if (r.work) {
        const done = Math.min(backlog, rate * (P.RUN_MS / 1000))
        backlog -= done
        P.noteRound({ start: t, end: t + P.RUN_MS, bytes: done, full: done >= rate * (P.RUN_MS / 1000) })
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

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
