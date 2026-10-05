// How fast time-lapse thinning goes, when, and when it stands back (thinning.mjs runThinning; perf
// report Task 4 and its check verify-1, 2026-09-29).
//
//   thinPace(env)             the pace: MB/s of footage read, files at a time, the site's night hours
//   decideRun({ now, ... })   whether this 5-minute round converts, and why (in words for the page)
//   makeBucket(bytesPerSec)   spaces the files so the reads stay at the pace
//   noteRecorderGap(m)        the recorder's gap reports (nvrs.mjs): "disk too slow" makes it stand back
//   noteRecorderQueues(n, r)  the recorders' write queues (their stats, nvrs.mjs): writes waiting, the
//                             warning before a gap, make it stand back too
//   noteRound / settleRound   each round with the switch On, looked at again as the next ones begin: the
//                             pace's ceiling moves with the reports whose gaps began in it, and what it
//                             converted is counted
//   usePaceFile(file)         where the ceiling is kept (DATA_DIR/thin-pace.json)
//
// The pace. Footage passes its full-video days at the rate it is recorded: 17.1 MB/s on average, 19.1
// MB/s on the 1.65 TB days (verify-1), so the job must convert faster than that while it works, or it
// never catches up; and the task asks for a day's footage converted within about 16 hours of rounds,
// which on the biggest day seen (1.65 TB, rounds working 4 minutes in 5) takes at least 36 MB/s. The
// audit's "20 MB/s or less" left 5-17 % of headroom; verify-1 showed one file at a time is 19-23 MB/s
// at most anyway. What was MEASURED (below), on the production VM beside the recording: reading one segment
// from the NAS, one at a time, 0.30 s for 12 MB, an fsync 66-99 ms, a metadata call 0.9-2.4 ms (the audit, 29
// Sep); and reading real segments cold from the NAS one, two and three at a time, 54.0, 55.4 and 70.5 MB/s
// together (review of p3-thin round 2, 30 Sep: 21 files of 26 Sep, 279 MB, 16 cameras, H.264 and H.265, read
// into /tmp; the helper's rewrite then run on those copies: all 21 decode with no ffmpeg error, one I frame
// per keyframe kept, the time-lapse 10.4 % of the bytes, 50-53 file calls, 1-10 ms of CPU a file). What is
// MODELLED from those: a whole rewrite end to end (fileMs: the reads, the helper's ~50 file calls, 3 fsyncs,
// the time-lapse written and read back), 0.55-0.75 s for 12 MB alone and 0.77-0.93 s with three in flight,
// each reading at a third of what three reads get together. What is ASSUMED, as nothing may be written to
// the shared NAS to measure it: the writes and fsyncs of three in flight each as quick as one alone. So three
// in flight convert 38.6-46.6 MB/s of footage, and the default, 40 MB/s, is the round figure in that range
// that meets the 16 hours with room (14.8 h for the biggest day, 13.2 h for an average one:
// test/thin-pace.test.mjs); the reads alone had 70 MB/s. At 40 MB/s of reads plus ~4.4 MB/s of time-lapse written, the NAS link (1 Gbit/s, ~117
// MB/s) carries about 60-65 MB/s with the recording. What keeps recording safe if the NAS cannot take it
// beside the recording at night is the ceiling below, which starts at half this pace and rises only after
// whole nights without a recording gap; CCTV_THIN_MBPS in /etc/cctv/cctv.env lowers the pace, and so the most
// the ceiling rises to, by hand.
//
// When. Nights first (CCTV_THIN_NIGHT, site time, 20:00-06:00 by default: fewer people watching, so
// fewer playback reads on the NAS and on the server): at night every round converts. By day a round
// converts only if the coming night alone would not catch up, counting what is recorded until then, at
// the lower of the pace and what recent rounds really converted (a slower NAS, or stand-backs, would
// otherwise leave it waiting until a whole night's worth was behind: review of p3-thin); so a day is
// converted in the night that follows it and the morning after, and full video never waits more than
// about half a day past its full-video days (the test runs four such days, and ten quieter ones on a NAS
// that gives the job only 16 MB/s).
//
// Standing back. A round never starts, and a round under way stops taking new files, within
// SLOW_HOLD_MS of the recorder reporting "disk too slow", or STRAIN_HOLD_MS of a recorder's writes seen
// waiting half as long as a gap takes (the warning before one): recording always has the disk first. And
// the pace has a ceiling learned from the rounds and kept in DATA_DIR (the section below says how: review
// of p3-thin, 2026-09-29 and round 2, 2026-09-30): a fresh start at half the pace; half what a round ran at
// after a gap that began in it; a step up only after a whole night of rounds with none.
import { readFile, rename, writeFile } from 'node:fs/promises'
import { siteMinutesOfDay } from './site-time.mjs'

/**
 * The measurements this pace rests on, on the production VM beside the recording. The audit's (perf report R1
 * and verify-1, 29 Sep 2026), each of one file or one call at a time: reading a segment, its .idx and a stat
 * from the NAS took 177 ms + 10.1 ms per MB (8 files, 3-39 MB; R1's 5 files agreed); an fsync on the share
 * 66-99 ms; one metadata call (stat, rename, unlink) 0.9-2.4 ms at the median; parsing and building the
 * rewrite 5-24 ms, about 10; the time-lapse copy 8.7-11.1 % of the original over the 13 files (2.8-16 % per
 * file); the mean segment 11.98 MB; 1.474-1.65 TB recorded a day. Review of p3-thin round 2 (30 Sep 2026, 21
 * files of 26 Sep, 3.5 days old, 7 each): read one, two and three at a time, 54.0, 55.4 and 70.5 MB/s together
 * (one at a time 111 ms + 9.4 ms per MB: the audit's figure, a little quicker); the time-lapse 10.4 % of their
 * bytes (3.6-23 % per file), their keyframes 50.0 % (thinning.mjs KEYFRAME_SHARE).
 */
export const MEASURED = Object.freeze({
  readBaseMs: 177,
  readMsPerMB: 10.1,
  readAtOnceMBps: [54.0, 55.4, 70.5],
  fsyncMs: [66, 99],
  callMs: [0.9, 2.4],
  cpuMs: 10,
  thinShare: [0.087, 0.111],
  meanSegmentMB: 11.98,
  dayTB: [1.474, 1.65],
  recordMBps: [17.1, 19.1]
})
/**
 * What the model of a whole rewrite (fileMs) takes for granted, never measured (header; nothing may be written
 * to the shared NAS to measure it): the time-lapse written to the NAS at 100 MB/s, and the writes, fsyncs and
 * metadata calls of files in flight together each as quick as one alone (the reads in flight are measured).
 */
export const ASSUMED = Object.freeze({ writeMBps: 100, writesInFlightScale: true })

export const DEFAULT_MBPS = 40
export const AT_ONCE = 3
/** Site minutes of the day; the night may cross midnight. */
export const DEFAULT_NIGHT = Object.freeze({ from: 20 * 60, to: 6 * 60 })
/** The storage jobs run every 5 minutes (server.mjs); thinning works at most RUN_MS of each round, from its start. */
export const TICK_MS = 5 * 60_000
export const RUN_MS = 4 * 60_000
const DUTY = RUN_MS / TICK_MS
/** How long after a "disk too slow" report thinning stands back. */
export const SLOW_HOLD_MS = 10 * 60_000

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const gb = (b) => `${Math.round(b / 1e9).toLocaleString('en-GB')} GB`
const mbText = (x) => `${Math.round(x * 10) / 10} MB/s`

/**
 * The pace from the environment (read by the server at each run, so a change needs only a restart):
 * CCTV_THIN_MBPS (MB/s of footage read, 0 < x <= 200), CCTV_THIN_NIGHT ("HH:MM-HH:MM", site time).
 * @returns {{ mbps: number, atOnce: number, night: { from: number, to: number }, warnings: string[] }}
 */
export function thinPace(env = process.env) {
  const warnings = []
  let mbps = DEFAULT_MBPS
  if (env.CCTV_THIN_MBPS !== undefined && env.CCTV_THIN_MBPS !== '') {
    const v = Number(env.CCTV_THIN_MBPS)
    if (Number.isFinite(v) && v > 0 && v <= 200) mbps = v
    else warnings.push(`CCTV_THIN_MBPS=${env.CCTV_THIN_MBPS} is not a pace between 0 and 200 MB/s: ${DEFAULT_MBPS} MB/s is used`)
  }
  let night = { ...DEFAULT_NIGHT }
  if (env.CCTV_THIN_NIGHT !== undefined && env.CCTV_THIN_NIGHT !== '') {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(env.CCTV_THIN_NIGHT).trim())
    const from = m ? Number(m[1]) * 60 + Number(m[2]) : NaN
    const to = m ? Number(m[3]) * 60 + Number(m[4]) : NaN
    if (m && Number(m[1]) < 24 && Number(m[3]) < 24 && Number(m[2]) < 60 && Number(m[4]) < 60 && from !== to) night = { from, to }
    else warnings.push(`CCTV_THIN_NIGHT=${env.CCTV_THIN_NIGHT} is not "HH:MM-HH:MM": ${hhmm(DEFAULT_NIGHT.from)}-${hhmm(DEFAULT_NIGHT.to)} is used`)
  }
  return { mbps, atOnce: AT_ONCE, night, warnings }
}

/** "40 MB/s, 3 files at a time; nights 20:00-06:00 site time" */
export const describePace = (p) => `${p.mbps} MB/s, ${p.atOnce} files at a time; nights ${hhmm(p.night.from)}-${hhmm(p.night.to)} site time`

/**
 * The time one rewrite of an `mb` MB file takes end to end (read, rewrite, fsyncs, swap, commit): a model
 * built from MEASURED and ASSUMED, not a measurement. `calls` is how many file calls the helper makes for
 * it (test/thin-pace.test.mjs counts them from share-ops.mjs), of which the measured read covers the stat
 * and the two reads, and three are fsyncs. atOnce: files in flight together, each reading at its share of
 * what that many reads got together (MEASURED.readAtOnceMBps), never quicker than one alone.
 */
export function fileMs(mb, { calls, worst = true, atOnce = 1 }) {
  const m = MEASURED
  const pick = ([a, b]) => (worst ? b : a)
  const readCalls = 1 + 4 + Math.ceil((mb * 1e6) / (8 * 1024 * 1024)) + 4 // stat; segment open/stat/reads/close; .idx
  const thinMB = mb * pick(m.thinShare)
  const others = Math.max(0, calls - readCalls - 3)
  const together = m.readAtOnceMBps[Math.min(m.readAtOnceMBps.length, Math.max(1, atOnce)) - 1]
  const readMs = Math.max(m.readBaseMs + m.readMsPerMB * mb, atOnce > 1 ? ((atOnce * mb) / together) * 1000 : 0)
  return readMs + others * pick(m.callMs) + 3 * pick(m.fsyncMs) + (thinMB / ASSUMED.writeMBps) * 1000 + thinMB * m.readMsPerMB + m.cpuMs
}

/** MB/s converted while working, on the model: the pace, or what `atOnce` files in flight can do if that is less. */
export function throughputMBps(pace, model) {
  const mb = MEASURED.meanSegmentMB
  return Math.min(pace.mbps, (pace.atOnce * mb) / (fileMs(mb, { ...model, atOnce: pace.atOnce }) / 1000))
}

/** Hours of 5-minute rounds (RUN_MS of work each) to convert `tb` TB. */
export const hoursForDay = (tb, pace, model) => (tb * 1e12) / (throughputMBps(pace, model) * 1e6) / DUTY / 3600

/** Whether `now` is in the night hours (site time). */
export function inNight(now, night, siteMin = siteMinutesOfDay) {
  const m = siteMin(now)
  return night.from < night.to ? m >= night.from && m < night.to : m >= night.from || m < night.to
}

/** Hours from `now` to the end of the night under way, or else of the next one. */
export function hoursToNightEnd(now, night, siteMin = siteMinutesOfDay) {
  const m = siteMin(now)
  const len = (night.to - night.from + 1440) % 1440
  const mins = inNight(now, night, siteMin) ? (night.to - m + 1440) % 1440 : ((night.from - m + 1440) % 1440) + len
  return mins / 60
}

/**
 * Whether this round converts. backlogBytes: full video past its full-video days, waiting (the index's
 * figure); arrivalBytesPerHour: the rate footage passes the cutoff (what the cameras recorded in the
 * hours just before it). slow: lastDiskTooSlow(); strain: lastStrain(). factor: the ceiling (paceFactor());
 * achievedMBps: what recent rounds converted (achievedMBps(), null while unknown): the coming night is judged
 * at the lower of the pace so lowered and that.
 * A round held back by the recorders (held) says whether it would otherwise have worked (wouldWork): by day,
 * waiting for the night, it would not have, and runThinning does not count it as a round that converted
 * nothing (review of p3-thin, round 2: on a shared NAS, "disk too slow" reports its other users caused made
 * the day rule work by day, adding load just when the NAS was under stress).
 * @returns {{ work: boolean, night: boolean, why: string, held?: true, wouldWork?: boolean }}
 */
export function decideRun({ now, backlogBytes, arrivalBytesPerHour = 0, pace, siteMin = siteMinutesOfDay, slow = lastDiskTooSlow(), strain = lastStrain(), factor = paceFactor(pace), achievedMBps: achieved = achievedMBps() }) {
  const night = inNight(now, pace.night, siteMin)
  if (!(backlogBytes > 0)) return { work: false, night, why: 'nothing waiting' }
  const base = night ? { work: true, night, why: 'night hours' } : dayRule()
  const cam = (x) => (x.nvr !== undefined && x.nvr !== null && x.ch !== undefined && x.ch !== null ? ` (${x.nvr}/${Number(x.ch) + 1})` : '')
  if (slow && now - slow.at >= 0 && now - slow.at < SLOW_HOLD_MS) {
    return { work: false, night, held: true, wouldWork: base.work, why: `the recorder reported "disk too slow" at ${hhmm(siteMin(slow.at))}${cam(slow)}: time-lapse waits ${SLOW_HOLD_MS / 60_000} minutes after that, so recording keeps the disk` }
  }
  if (strain && now - strain.at >= 0 && now - strain.at < STRAIN_HOLD_MS) {
    const how = Number.isFinite(strain.ageMs) ? ` ${(strain.ageMs / 1000).toFixed(1)} s` : ''
    return { work: false, night, held: true, wouldWork: base.work, why: `the recorders' writes waited${how} to be written at ${hhmm(siteMin(strain.at))}${cam(strain)}: time-lapse waits ${STRAIN_HOLD_MS / 60_000} minutes after that, so recording keeps the disk` }
  }
  return base

  function dayRule() {
    const nightHours = ((pace.night.to - pace.night.from + 1440) % 1440) / 60
    const byPace = pace.mbps * factor
    const rate = Number.isFinite(achieved) && achieved >= 0 ? Math.min(byPace, achieved) : byPace
    const how = rate >= pace.mbps ? '' : rate < byPace ? ` at the ${mbText(rate)} recent rounds converted` : ` at the pace lowered to ${mbText(rate)}`
    const capNight = rate * 1e6 * 3600 * nightHours * DUTY
    const due = backlogBytes + Math.max(0, arrivalBytesPerHour) * hoursToNightEnd(now, pace.night, siteMin)
    if (due > capNight) return { work: true, night, why: `by day: about ${gb(due)} would be waiting by the end of the coming night, more than it can convert (${gb(capNight)}${how}), so it converts now rather than fall behind` }
    return { work: false, night, why: `waiting for the night (${hhmm(pace.night.from)}-${hhmm(pace.night.to)} site time): it can convert the ${gb(backlogBytes)} waiting and what is recorded until then${how}` }
  }
}

/**
 * Spaces reads at `bytesPerSec`: take(bytes) resolves when a file of that size may start. The first
 * goes at once; a pause saves up nothing beyond that.
 */
export function makeBucket(bytesPerSec, { now = () => performance.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let next = -Infinity
  return {
    async take(bytes) {
      const t = now()
      const at = Math.max(t, next)
      next = at + (Math.max(0, Number(bytes) || 0) / bytesPerSec) * 1000
      if (at > t) await sleep(at - t)
    },
    /** How long the next file would wait now. */
    waitMs: () => Math.max(0, next - now())
  }
}

// ---- what the recorders report: "disk too slow", and their writes waiting ------------------------------
/** Reports are kept this long after they arrive, for the rounds they fall in (settleRound). */
const REPORTS_KEPT_MS = 30 * 60_000
const REPORTS_MAX = 2000
/**
 * The warning before a gap (review of p3-thin, round 2, 2026-09-30): each recorder's write queue, in its
 * worker's stats every 5 s (Recorder.status().queue). segment-writer.mjs drops frames -- a "disk too slow"
 * gap -- once a write has waited 10 s or 8 MB wait to be written; half of either is the NAS falling behind
 * with nothing lost yet. Not calibrated on the site (nobody has recorded the queues' normal ages there): a
 * write waiting 5 s beside ~0.2 MB/s per camera is far outside what a healthy share does.
 */
export const STRAIN_AGE_MS = 5000
export const STRAIN_BYTES = 4 * 1024 * 1024
/** How long after writes were seen waiting thinning stands back (a round; a gap's is SLOW_HOLD_MS). */
export const STRAIN_HOLD_MS = 5 * 60_000
/** One NVR's waiting writes are one report this often at most (its stats come every 5 s). */
const STRAIN_EVERY_MS = 30_000

let reports = [] // { kind: 'gap' | 'strain', at, fromMs, nvr, ch, reason }, in the order they came
let slowLast = null
let strainLast = null

function keep(r) {
  reports.push(r)
  const old = r.at - REPORTS_KEPT_MS
  while (reports.length && (reports[0].at < old || reports.length > REPORTS_MAX)) reports.shift()
}

/**
 * A recorder's gap report ({t:'recgap', nvr, ch, fromMs, toMs, reason}; nvrs.mjs): a "disk too slow" one is
 * kept, with when it came (`at`: the stand-back runs from it) and when its gap began (`fromMs`: the round it
 * falls in). A recorder reports a gap when it records again, so after a long stall that is minutes later, and
 * every camera of a stall reports it on its own (review of p3-thin, round 2: only the last was kept, by when
 * it came).
 */
export function noteRecorderGap(m, now = Date.now()) {
  if (!/disk too slow/i.test(String(m?.reason ?? ''))) return
  const fromMs = Number.isFinite(m.fromMs) && m.fromMs <= now ? m.fromMs : now
  slowLast = { kind: 'gap', at: now, fromMs, nvr: m.nvr, ch: m.ch, reason: String(m.reason) }
  keep({ ...slowLast })
}

/**
 * One worker's recorder status (nvr-worker.mjs STATS, every 5 s; nvrs.mjs): a camera whose oldest write has
 * waited STRAIN_AGE_MS, or with STRAIN_BYTES waiting, is kept as a report of kind 'strain', its gap-to-be
 * begun when that write was queued.
 */
export function noteRecorderQueues(nvr, rec, now = Date.now()) {
  if (!rec || typeof rec !== 'object') return
  let worst = null
  for (const [ch, c] of Object.entries(rec)) {
    const q = c?.queue
    if (!q) continue
    const ageMs = Math.max(0, Number(q.ageMs) || 0)
    const bytes = Math.max(0, Number(q.bytes) || 0)
    if ((ageMs >= STRAIN_AGE_MS || bytes >= STRAIN_BYTES) && (!worst || ageMs > worst.ageMs || (ageMs === worst.ageMs && bytes > worst.bytes))) worst = { ch: Number(ch), ageMs, bytes }
  }
  if (!worst) return
  if (strainLast && strainLast.nvr === nvr && now - strainLast.at >= 0 && now - strainLast.at < STRAIN_EVERY_MS) return
  const reason = `writes waiting to be written: ${(worst.bytes / 1048576).toFixed(1)} MB, the oldest for ${(worst.ageMs / 1000).toFixed(1)} s`
  strainLast = { kind: 'strain', at: now, fromMs: now - worst.ageMs, nvr, ch: worst.ch, ageMs: worst.ageMs, bytes: worst.bytes, reason }
  keep({ ...strainLast })
}

/** { at, fromMs, nvr, ch, reason } of the last "disk too slow" report since the server started, or null. */
export const lastDiskTooSlow = () => (slowLast ? { ...slowLast } : null)
/** The last time a recorder's writes were seen waiting (noteRecorderQueues), or null. */
export const lastStrain = () => (strainLast ? { ...strainLast } : null)
/** Every report kept (the last half hour), oldest first. */
export const recorderReports = () => reports.map((r) => ({ ...r }))

// ---- the ceiling: learned from the rounds, kept in DATA_DIR ------------------------------------------------
// Review of p3-thin, round 2 (2026-09-30): the back-off before this halved the pace for the rest of a night,
// then doubled it back after each clean hour of rounds (by day after an hour), in memory. A NAS that takes
// 22-30 MB/s beside the recording then cost 8-9 recording gaps a day, every day, and a restart went back to
// 40. Now the pace has a ceiling, moved only by what the rounds show:
//  - a fresh start is at half the pace (START_SHARE: 20 of 40 MB/s): nothing has measured the NAS beside the
//    recording (the header), and verify-1 said to start low and watch;
//  - a "disk too slow", or writes waiting (STRAIN_*), whose gap began during a round or AFTER_ROUND_MS after
//    its end caps it at half what that round ran at (down to BACKOFF_MIN of the pace), once per round however
//    many cameras report the one stall; and that pace is remembered as one the NAS could not take (badMbps);
//  - each whole night of rounds (NIGHT_EVIDENCE_MS of work or more) with none raises it one step (STEP_SHARE:
//    5 MB/s of 40), never by day, never twice a night; up to the pace, or, below a pace that cost a gap, up to
//    one step under it; that one is tried again only after PROBE_FIRST whole nights there with none, then 4,
//    8, 16 after each try that costs a gap again (a clean night at it forgets it);
//  - it is kept in DATA_DIR/thin-pace.json (usePaceFile), so a restart goes on from it.
// So a round too fast for the NAS costs at most one gap between two whole nights without one, and once the
// ceiling has found what the NAS takes, fewer and fewer (the test runs NASes taking 12-36 MB/s for three weeks:
// never more than one gap a day). Halving and then stepping up alone (the review's first form) averaged about
// three quarters of what the NAS takes, so at 30 MB/s it fell a day behind 1.5 TB days; held one step under
// the pace that cost a gap, it keeps up.
/** A "disk too slow" this long after a round's end still counts as during it: recording's writes reach the NAS up to ~30 s late (the kernel's dirty-page expiry). */
export const AFTER_ROUND_MS = 60_000
/** A report may come this long after the round it is about ended (it comes when recording resumes). */
export const REPORT_LATE_MS = 10 * 60_000
/** The ceiling never goes below this share of the pace (5 MB/s of 40). */
export const BACKOFF_MIN = 1 / 8
/** A fresh start: this share of the pace. */
export const START_SHARE = 1 / 2
/** Each whole night of rounds with no report raises the ceiling by this share of the pace. */
export const STEP_SHARE = 1 / 8
/** A night whose rounds worked less than this in all shows too little: no step. */
export const NIGHT_EVIDENCE_MS = 60 * 60_000
/** Whole nights one step under a pace that cost a gap before that pace is tried again; doubled after each try that costs one, to PROBE_MOST. */
export const PROBE_FIRST = 2
export const PROBE_MOST = 16
/** What the rounds converted is counted over the last this many (an hour of rounds), once there are 3. */
const ROUNDS_KEPT = 12

const freshState = () => ({ capMbps: null, badMbps: null, topNights: 0, probeEvery: PROBE_FIRST, lowered: null, raised: null, night: null })
let state = freshState() // saved in DATA_DIR
let recent = [] // the rounds not looked at for good yet: { start, end, bytes, full, held, mbps, sampled, flagged, counted }
let samples = []

const stepOf = (pace) => pace.mbps * STEP_SHARE
const floorOf = (pace) => pace.mbps * BACKOFF_MIN
/** The ceiling now, in MB/s of footage read: never above the pace. */
const capOf = (pace) => Math.min(pace.mbps, Number.isFinite(state.capMbps) ? Math.max(floorOf(pace), state.capMbps) : pace.mbps * START_SHARE)
/** How high clean nights take the ceiling: the pace, or one step under a pace that cost a gap. */
const topOf = (pace) => (Number.isFinite(state.badMbps) ? Math.max(floorOf(pace), Math.min(pace.mbps, state.badMbps - stepOf(pace))) : pace.mbps)
/** Where the night that `t` is in ends (a minute's start), or null by day. */
function nightEndOf(t, night, siteMin) {
  if (!inNight(t, night, siteMin)) return null
  const m = siteMin(t)
  return Math.floor(t / 60_000) * 60_000 + ((night.to - m + 1440) % 1440) * 60_000
}

/**
 * A round with the switch On is over (thinning.mjs runThinning): when it worked, what it converted, and at
 * what pace (mbps: the ceiling it ran at). full: it ended for want of time -- its minutes up, the disk too
 * slow, every location stopped -- so what it converted says what the NAS and the helper can do; a round that
 * ran out of files, or was stopped by the switch or the per-run limit, says nothing about that. held: it did
 * not work because the recorder had just said the disk was too slow, when it otherwise would have (counted as
 * a round that converted nothing).
 */
export function noteRound({ start, end, bytes = 0, full = false, held = false, mbps = null }) {
  recent.push({ start, end: Math.max(start, end), bytes: Math.max(0, Number(bytes) || 0), full: Boolean(full), held: Boolean(held), mbps: Number.isFinite(mbps) && mbps > 0 ? mbps : null, sampled: false, flagged: false, counted: false })
  if (recent.length > 64) recent.shift()
}

/**
 * The rounds, looked at again at the start of each (runThinning, switch On; `now`): each report is set against
 * the rounds its gap began in (settle once per round), what full rounds converted is counted, and a night over
 * with all its rounds looked at is judged. reports: recorderReports() by default (a test's own too).
 */
export function settleRound({ now = Date.now(), reports: list = reports, night, siteMin = siteMinutesOfDay, pace = thinPace() }) {
  let changed = false
  const gapStart = (x) => (Number.isFinite(x?.fromMs) ? x.fromMs : x?.at)
  for (const r of recent) {
    // what it converted, once, when the next round begins (a round's share of the time is its slot, RUN_MS,
    // however soon the disk stopped it)
    if (!r.sampled) {
      r.sampled = true
      if (r.full || r.held) {
        samples.push({ bytes: r.held ? 0 : r.bytes, ms: RUN_MS })
        if (samples.length > ROUNDS_KEPT) samples.shift()
      }
    }
    if (!r.held && !r.flagged) {
      const hit = list.find((x) => x && gapStart(x) >= r.start && gapStart(x) <= r.end + AFTER_ROUND_MS)
      if (hit) {
        r.flagged = true
        const was = capOf(pace)
        const ran = r.mbps ?? was
        // a try of the pace that cost a gap before (the ceiling was there): the next try waits twice as long
        if (Number.isFinite(state.badMbps) && was >= state.badMbps) state.probeEvery = Math.min(PROBE_MOST, (state.probeEvery || PROBE_FIRST) * 2)
        state.badMbps = Number.isFinite(state.badMbps) ? Math.min(state.badMbps, ran) : ran
        state.topNights = 0
        const to = Math.max(floorOf(pace), Math.min(was, ran / 2))
        if (to < was) state.capMbps = to
        state.lowered = { at: hit.at, fromMs: gapStart(hit), kind: hit.kind === 'strain' ? 'strain' : 'gap', nvr: hit.nvr ?? null, ch: hit.ch ?? null, ageMs: Number.isFinite(hit.ageMs) ? hit.ageMs : null, ranMbps: ran, toMbps: Math.min(was, to) }
        changed = true
      }
    }
    // counted towards its night once no report about it can still come
    if (!r.counted && now - r.end >= REPORT_LATE_MS) {
      r.counted = true
      const ends = r.held ? null : nightEndOf(r.start, night, siteMin)
      if (ends !== null) {
        if (state.night && state.night.endsAt !== ends) changed = judgeNight(pace) || changed
        if (!state.night) state.night = { endsAt: ends, workMs: 0, gap: false }
        state.night.workMs += r.end - r.start
        if (r.flagged) state.night.gap = true
        changed = true
      }
    }
  }
  recent = recent.filter((r) => !r.counted || !r.sampled)
  // a night over, and every round of it looked at for good: one step up if none of them had a report
  if (state.night && now >= state.night.endsAt && !recent.some((r) => !r.counted && !r.held && nightEndOf(r.start, night, siteMin) === state.night.endsAt)) changed = judgeNight(pace) || changed
  if (changed) save()
}

/** A night over: a whole night of rounds with no report moves the ceiling up one step (the header says how far). */
function judgeNight(pace) {
  const n = state.night
  state.night = null
  if (!n || n.gap || n.workMs < NIGHT_EVIDENCE_MS) return true
  const was = capOf(pace)
  let to = was
  if (Number.isFinite(state.badMbps) && was >= state.badMbps) {
    // a whole night at the pace that once cost a gap, with none: it no longer does
    state.badMbps = null
    state.probeEvery = PROBE_FIRST
    state.topNights = 0
    to = was + stepOf(pace)
  } else if (was < topOf(pace)) to = Math.min(topOf(pace), was + stepOf(pace))
  else if (Number.isFinite(state.badMbps)) {
    // one step under it: tried again after so many whole nights here with none
    state.topNights = (state.topNights || 0) + 1
    if (state.topNights >= (state.probeEvery || PROBE_FIRST)) {
      state.topNights = 0
      to = state.badMbps
    }
  }
  to = Math.min(pace.mbps, to)
  if (to > was) {
    state.capMbps = to
    state.raised = { at: n.endsAt, fromMbps: was, toMbps: to }
  }
  return true
}

/** The share of the pace the ceiling leaves now (1 at the whole pace). */
export const paceFactor = (pace = thinPace()) => capOf(pace) / pace.mbps
/** MB/s of footage read now: the pace under its ceiling. */
export const effectiveMbps = (pace = thinPace()) => capOf(pace)
/** MB/s the last rounds that could work their whole time converted (a round held back counts as none), or null before 3 of them. */
export function achievedMBps() {
  if (samples.length < 3) return null
  const bytes = samples.reduce((a, s) => a + s.bytes, 0)
  const ms = samples.reduce((a, s) => a + s.ms, 0)
  return bytes / 1e6 / (ms / 1000)
}
/** The ceiling as it stands, for the page: { mbps, maxMbps, badMbps, lowered, raised }. */
export const paceState = (pace = thinPace()) => ({ mbps: capOf(pace), maxMbps: pace.mbps, badMbps: Number.isFinite(state.badMbps) ? state.badMbps : null, lowered: state.lowered ? { ...state.lowered } : null, raised: state.raised ? { ...state.raised } : null })

/**
 * The pace as it is now, for the page: "20 MB/s (up to 40 MB/s: it rises by 5 MB/s after each night of rounds
 * with no "disk too slow"), 3 files at a time; nights 20:00-06:00 site time"; or, held one step under a pace that
 * cost a gap, "35 MB/s (up to 40 MB/s: 40 MB/s cost a recording gap; tried again after 2 more nights with none), ...".
 */
export function describePaceNow(pace = thinPace()) {
  const cap = capOf(pace)
  if (cap >= pace.mbps) return describePace(pace)
  const bad = state.badMbps
  const nights = Math.max(1, (state.probeEvery || PROBE_FIRST) - (state.topNights || 0))
  const how =
    Number.isFinite(bad) && cap >= topOf(pace)
      ? `${mbText(bad)} cost a recording gap; tried again after ${nights} more night${nights === 1 ? '' : 's'} of rounds with none`
      : `it rises by ${mbText(stepOf(pace))} after each night of rounds with no "disk too slow"${Number.isFinite(bad) ? `, to ${mbText(topOf(pace))}` : ''}`
  return `${mbText(cap)} (up to ${mbText(pace.mbps)}: ${how}), ${describePace(pace).replace(/^[^,]*, /, '')}`
}

/**
 * A lowered ceiling in words, for the page and the log (a warning), until it is back one step under the pace
 * that cost the gap; '' otherwise -- a fresh start stepping up, and the ceiling held under that pace, are said
 * in describePaceNow. "at 01:00 site time" gains the day when it was not today.
 */
export function backoffText(pace = thinPace(), siteMin = siteMinutesOfDay, now = Date.now()) {
  const cap = capOf(pace)
  const lo = state.lowered
  if (cap >= pace.mbps || !lo || cap >= Math.min(lo.ranMbps, topOf(pace))) return ''
  const t = lo.fromMs ?? lo.at
  const cam = lo.nvr !== null && lo.nvr !== undefined && lo.ch !== null && lo.ch !== undefined ? ` (${lo.nvr}/${Number(lo.ch) + 1})` : ''
  const day = now - t > 20 * 3_600_000 ? ` on ${siteDayText(t, siteMin)}` : ''
  const what = lo.kind === 'strain' ? `the recorders' writes waited${Number.isFinite(lo.ageMs) ? ` ${(lo.ageMs / 1000).toFixed(1)} s` : ''} to be written` : 'the recorder reported "disk too slow"'
  return `the pace is lowered to ${mbText(cap)} of ${mbText(pace.mbps)}: ${what} at ${hhmm(siteMin(t))} site time${day}${cam} while it converted at ${mbText(lo.ranMbps)}; it rises by ${mbText(stepOf(pace))} after each night of rounds with no such report, to ${mbText(topOf(pace))}`
}
/** "3 Oct": the site's date at `t`, its offset taken from siteMin (a test's site clock too). */
function siteDayText(t, siteMin) {
  const utcMin = Math.floor((((t / 60_000) % 1440) + 1440) % 1440)
  const off = ((siteMin(t) - utcMin + 720 + 1440) % 1440) - 720
  const d = new Date(t + off * 60_000)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}

// ---- kept in DATA_DIR ------------------------------------------------------------------------------------
let store = { file: null, saving: Promise.resolve() }

/**
 * Where the ceiling is kept (server.mjs: DATA_DIR/thin-pace.json, on the server's own disk). Read once, when
 * first given; a file that cannot be read leaves the start, and says so. Asynchronous, as is every save.
 */
export async function usePaceFile(file) {
  if (!file || store.file === file) return
  store.file = file
  let j
  try {
    j = JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[thinning] ${file} could not be read (${e.message}): the time-lapse pace starts again at ${START_SHARE * 100} % of its most`)
    return
  }
  const num = (x) => (Number.isFinite(x) ? x : null)
  const obj = (x) => (x && typeof x === 'object' && Number.isFinite(x.at) ? { ...x } : null)
  state = {
    capMbps: num(j?.capMbps) !== null && j.capMbps > 0 ? j.capMbps : null,
    badMbps: num(j?.badMbps) !== null && j.badMbps > 0 ? j.badMbps : null,
    topNights: num(j?.topNights) !== null && j.topNights >= 0 ? Math.floor(j.topNights) : 0,
    probeEvery: num(j?.probeEvery) !== null && j.probeEvery >= PROBE_FIRST ? Math.min(PROBE_MOST, Math.floor(j.probeEvery)) : PROBE_FIRST,
    lowered: obj(j?.lowered),
    raised: obj(j?.raised),
    night: j?.night && Number.isFinite(j.night.endsAt) && Number.isFinite(j.night.workMs) ? { endsAt: j.night.endsAt, workMs: Math.max(0, j.night.workMs), gap: Boolean(j.night.gap) } : null
  }
}

function save() {
  const file = store.file
  if (!file) return
  const body = `${JSON.stringify({ v: 1, savedAt: Date.now(), ...state })}\n`
  store.saving = store.saving
    .then(async () => {
      await writeFile(`${file}.tmp`, body)
      await rename(`${file}.tmp`, file)
    })
    .catch((e) => console.warn(`[thinning] ${file} not written (${e.message}): the time-lapse pace is kept in memory until the next save`))
}

/** Waits for the saves under way (tests; the server does not wait). */
export const flushPace = () => store.saving

export const _test = {
  reset() {
    reports = []
    slowLast = null
    strainLast = null
    state = freshState()
    recent = []
    samples = []
    store = { file: null, saving: Promise.resolve() }
  }
}
