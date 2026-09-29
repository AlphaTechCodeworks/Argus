// How fast time-lapse thinning goes, when, and when it stands back (thinning.mjs runThinning; perf
// report Task 4 and its check verify-1, 2026-09-29).
//
//   thinPace(env)             the pace: MB/s of footage read, files at a time, the site's night hours
//   decideRun({ now, ... })   whether this 5-minute round converts, and why (in words for the page)
//   makeBucket(bytesPerSec)   spaces the files so the reads stay at the pace
//   noteRecorderGap(m)        the recorder's gap reports (nvrs.mjs): "disk too slow" makes it stand back
//
// The pace. Footage passes its full-video days at the rate it is recorded: 17.1 MB/s on average, 19.1
// MB/s on the 1.65 TB days (verify-1), so the job must convert faster than that while it works, or it
// never catches up. The audit's "20 MB/s or less" left 5-17 % of headroom; verify-1 showed one file at a
// time is 19-23 MB/s at most anyway. The measured cost of one file (MEASURED below: real footage read
// from the NAS on the production VM, 29 Sep) is 0.55-0.75 s for a 12 MB file with the swap's fsyncs, so
// three at a time reach 47-63 MB/s; the default pace is 40 MB/s, which converts the biggest day seen
// (1.65 TB) in about 14.3 h of 5-minute rounds and an average day (1.47 TB) in 12.8 h
// (test/thin-pace.test.mjs proves it from these figures). At 40 MB/s of reads plus about 4.4 MB/s of
// time-lapse written, the NAS link (1 Gbit/s, about 117 MB/s) carries about 60-65 MB/s with the
// recording: half of it. Lower it with CCTV_THIN_MBPS in /etc/cctv/cctv.env if the recorder reports
// "disk too slow" while it runs; a fresh measurement on this release was not allowed from here
// (reading the NAS was refused), so these are the audit's figures, not new ones.
//
// When. Nights first (CCTV_THIN_NIGHT, site time, 20:00-06:00 by default: fewer people watching, so
// fewer playback reads on the NAS and on the server): at night every round converts. By day a round
// converts only if the coming night alone would not catch up, counting what is recorded until then; so
// a day is converted in the night that follows it and the morning after, and full video never waits
// more than about half a day past its full-video days (the test runs four such days).
//
// Standing back. A round never starts, and a round under way stops taking new files, within
// SLOW_HOLD_MS of the recorder reporting "disk too slow": recording always has the disk first.
import { siteMinutesOfDay } from './site-time.mjs'

/**
 * The audit's measurements this pace rests on (perf report R1 and verify-1, 29 Sep 2026, production VM):
 * reading a segment, its .idx and a stat from the NAS took 177 ms + 10.1 ms per MB (8 files, 3-39 MB;
 * R1's 5 files agreed); an fsync on the share 66-99 ms; one metadata call (stat, rename, unlink) 0.9-2.4
 * ms at the median; parsing and building the rewrite about 10 ms; the time-lapse copy 8.7-11.1 % of the
 * original over the 13 files (2.8-16 % per file); the mean segment 11.98 MB; 1.474-1.65 TB recorded a day.
 */
export const MEASURED = Object.freeze({
  readBaseMs: 177,
  readMsPerMB: 10.1,
  fsyncMs: [66, 99],
  callMs: [0.9, 2.4],
  cpuMs: 10,
  thinShare: [0.087, 0.111],
  writeMBps: 100,
  meanSegmentMB: 11.98,
  dayTB: [1.474, 1.65],
  recordMBps: [17.1, 19.1]
})

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
 * The time one rewrite of an `mb` MB file takes end to end (read, rewrite, fsyncs, swap, commit), from
 * MEASURED: `calls` is how many file calls the helper makes for it (test/thin-pace.test.mjs counts them
 * from share-ops.mjs), of which the measured read covers the stat and the two reads, and three are fsyncs.
 */
export function fileMs(mb, { calls, worst = true }) {
  const m = MEASURED
  const pick = ([a, b]) => (worst ? b : a)
  const readCalls = 1 + 4 + Math.ceil((mb * 1e6) / (8 * 1024 * 1024)) + 4 // stat; segment open/stat/reads/close; .idx
  const thinMB = mb * pick(m.thinShare)
  const others = Math.max(0, calls - readCalls - 3)
  return m.readBaseMs + m.readMsPerMB * mb + others * pick(m.callMs) + 3 * pick(m.fsyncMs) + (thinMB / m.writeMBps) * 1000 + thinMB * m.readMsPerMB + m.cpuMs
}

/** MB/s converted while working: the pace, or what `atOnce` files in flight can do if that is less. */
export function throughputMBps(pace, model) {
  const mb = MEASURED.meanSegmentMB
  return Math.min(pace.mbps, (pace.atOnce * mb) / (fileMs(mb, model) / 1000))
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
 * hours just before it). slow: lastDiskTooSlow().
 * @returns {{ work: boolean, night: boolean, why: string }}
 */
export function decideRun({ now, backlogBytes, arrivalBytesPerHour = 0, pace, siteMin = siteMinutesOfDay, slow = lastDiskTooSlow() }) {
  const night = inNight(now, pace.night, siteMin)
  if (!(backlogBytes > 0)) return { work: false, night, why: 'nothing waiting' }
  if (slow && now - slow.at >= 0 && now - slow.at < SLOW_HOLD_MS) {
    const cam = slow.nvr !== undefined && slow.ch !== undefined ? ` (${slow.nvr}/${Number(slow.ch) + 1})` : ''
    return { work: false, night, why: `the recorder reported "disk too slow" at ${hhmm(siteMin(slow.at))}${cam}: time-lapse waits ${SLOW_HOLD_MS / 60_000} minutes after that, so recording keeps the disk` }
  }
  if (night) return { work: true, night, why: 'night hours' }
  const nightHours = ((pace.night.to - pace.night.from + 1440) % 1440) / 60
  const capNight = pace.mbps * 1e6 * 3600 * nightHours * DUTY
  const due = backlogBytes + Math.max(0, arrivalBytesPerHour) * hoursToNightEnd(now, pace.night, siteMin)
  if (due > capNight) return { work: true, night, why: `by day: about ${gb(due)} would be waiting by the end of the coming night, more than it can convert (${gb(capNight)}), so it converts now rather than fall behind` }
  return { work: false, night, why: `waiting for the night (${hhmm(pace.night.from)}-${hhmm(pace.night.to)} site time): it can convert the ${gb(backlogBytes)} waiting and what is recorded until then` }
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

// ---- "disk too slow" ---------------------------------------------------------------------------------
let slowLast = null

/** A recorder's gap report ({t:'recgap', nvr, ch, reason}; nvrs.mjs): a "disk too slow" one is remembered. */
export function noteRecorderGap(m, now = Date.now()) {
  if (/disk too slow/i.test(String(m?.reason ?? ''))) slowLast = { at: now, nvr: m.nvr, ch: m.ch, reason: String(m.reason) }
}

/** { at, nvr, ch, reason } of the last "disk too slow" report since the server started, or null. */
export const lastDiskTooSlow = () => (slowLast ? { ...slowLast } : null)

export const _test = {
  reset() {
    slowLast = null
  }
}
