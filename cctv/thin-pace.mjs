// How fast time-lapse thinning goes, when, and when it stands back (thinning.mjs runThinning; perf
// report Task 4 and its check verify-1, 2026-09-29).
//
//   thinPace(env)             the pace: MB/s of footage read, files at a time, the site's night hours
//   decideRun({ now, ... })   whether this 5-minute round converts, and why (in words for the page)
//   makeBucket(bytesPerSec)   spaces the files so the reads stay at the pace
//   noteRecorderGap(m)        the recorder's gap reports (nvrs.mjs): "disk too slow" makes it stand back
//   noteRound / settleRound   each round with the switch On, looked at once the next begins: the pace
//                             backs off after a "disk too slow" in it, and what it converted is counted
//
// The pace. Footage passes its full-video days at the rate it is recorded: 17.1 MB/s on average, 19.1
// MB/s on the 1.65 TB days (verify-1), so the job must convert faster than that while it works, or it
// never catches up; and the task asks for a day's footage converted within about 16 hours of rounds,
// which on the biggest day seen (1.65 TB, rounds working 4 minutes in 5) takes at least 36 MB/s. The
// audit's "20 MB/s or less" left 5-17 % of headroom; verify-1 showed one file at a time is 19-23 MB/s
// at most anyway. What was MEASURED (below; the audit's, on the production VM, 29 Sep): reading one
// segment from the NAS, one at a time, 0.30 s for 12 MB; an fsync 66-99 ms; a metadata call 0.9-2.4 ms.
// What is MODELLED from those, not measured: a whole rewrite end to end (fileMs: the reads, the helper's
// ~50 file calls, 3 fsyncs, the time-lapse written and read back) 0.55-0.75 s for 12 MB; and that three
// files in flight each take what one takes alone -- that the NAS serves 40 MB/s of cold reads and ~10
// fsyncs a second beside 87 recording streams. Neither has been measured: reading real footage from the
// NAS into /tmp on the server, to time 1, 2 and 3 reads at once and to run the rewrite on copies of real
// H.264 and H.265, was refused by this project's permission checks twice (p3-thin 2026-09-29, its fix
// round 2026-09-30; scratchpad p3fix/fetch.mjs and thin-real.mjs are ready for when it is allowed). So
// the default, 40 MB/s, is the round figure that meets the 16 hours on that model with room (14.3 h for
// the biggest day, 12.8 h for an average one: test/thin-pace.test.mjs), not a measured capacity; at 40
// MB/s of reads plus ~4.4 MB/s of time-lapse written, the NAS link (1 Gbit/s, ~117 MB/s) would carry about
// 60-65 MB/s with the recording. What keeps recording safe if the NAS cannot take it is the back-off
// below; CCTV_THIN_MBPS in /etc/cctv/cctv.env lowers the pace by hand.
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
// SLOW_HOLD_MS of the recorder reporting "disk too slow": recording always has the disk first. And it
// backs off (review of p3-thin, 2026-09-29: standing back 10 minutes came only after a recording gap,
// then went on at the same pace, so a pace too fast for the NAS would cost recording night after night):
// a report during a round, or within AFTER_ROUND_MS of its end, halves the pace, down to BACKOFF_MIN of it,
// for the rest of that night (an hour by day); from then on each hour of rounds with no such report
// doubles it back, to the whole pace at most. Kept in memory: a restart starts again at the whole pace.
import { siteMinutesOfDay } from './site-time.mjs'

/**
 * The audit's measurements this pace rests on (perf report R1 and verify-1, 29 Sep 2026, production VM), each
 * of one file or one call at a time: reading a segment, its .idx and a stat from the NAS took 177 ms + 10.1
 * ms per MB (8 files, 3-39 MB; R1's 5 files agreed); an fsync on the share 66-99 ms; one metadata call (stat,
 * rename, unlink) 0.9-2.4 ms at the median; parsing and building the rewrite 5-24 ms, about 10; the time-lapse
 * copy 8.7-11.1 % of the original over the 13 files (2.8-16 % per file); the mean segment 11.98 MB;
 * 1.474-1.65 TB recorded a day.
 */
export const MEASURED = Object.freeze({
  readBaseMs: 177,
  readMsPerMB: 10.1,
  fsyncMs: [66, 99],
  callMs: [0.9, 2.4],
  cpuMs: 10,
  thinShare: [0.087, 0.111],
  meanSegmentMB: 11.98,
  dayTB: [1.474, 1.65],
  recordMBps: [17.1, 19.1]
})
/**
 * What the model of a whole rewrite (fileMs) takes for granted, never measured (header): the time-lapse
 * written to the NAS at 100 MB/s, and files in flight together each as quick as one alone.
 */
export const ASSUMED = Object.freeze({ writeMBps: 100, inFlightScales: true })

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
 * and the two reads, and three are fsyncs.
 */
export function fileMs(mb, { calls, worst = true }) {
  const m = MEASURED
  const pick = ([a, b]) => (worst ? b : a)
  const readCalls = 1 + 4 + Math.ceil((mb * 1e6) / (8 * 1024 * 1024)) + 4 // stat; segment open/stat/reads/close; .idx
  const thinMB = mb * pick(m.thinShare)
  const others = Math.max(0, calls - readCalls - 3)
  return m.readBaseMs + m.readMsPerMB * mb + others * pick(m.callMs) + 3 * pick(m.fsyncMs) + (thinMB / ASSUMED.writeMBps) * 1000 + thinMB * m.readMsPerMB + m.cpuMs
}

/** MB/s converted while working, on the model: the pace, or what `atOnce` files in flight can do if that is less (ASSUMED.inFlightScales). */
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
 * hours just before it). slow: lastDiskTooSlow(). factor: the back-off (paceFactor()); achievedMBps: what
 * recent rounds converted (achievedMBps(), null while unknown): the coming night is judged at the lower of
 * the pace so lowered and that.
 * @returns {{ work: boolean, night: boolean, why: string }}
 */
export function decideRun({ now, backlogBytes, arrivalBytesPerHour = 0, pace, siteMin = siteMinutesOfDay, slow = lastDiskTooSlow(), factor = paceFactor(), achievedMBps: achieved = achievedMBps() }) {
  const night = inNight(now, pace.night, siteMin)
  if (!(backlogBytes > 0)) return { work: false, night, why: 'nothing waiting' }
  if (slow && now - slow.at >= 0 && now - slow.at < SLOW_HOLD_MS) {
    const cam = slow.nvr !== undefined && slow.ch !== undefined ? ` (${slow.nvr}/${Number(slow.ch) + 1})` : ''
    return { work: false, night, held: true, why: `the recorder reported "disk too slow" at ${hhmm(siteMin(slow.at))}${cam}: time-lapse waits ${SLOW_HOLD_MS / 60_000} minutes after that, so recording keeps the disk` }
  }
  if (night) return { work: true, night, why: 'night hours' }
  const nightHours = ((pace.night.to - pace.night.from + 1440) % 1440) / 60
  const byPace = pace.mbps * factor
  const rate = Number.isFinite(achieved) && achieved >= 0 ? Math.min(byPace, achieved) : byPace
  const how = rate >= pace.mbps ? '' : rate < byPace ? ` at the ${mbText(rate)} recent rounds converted` : ` at the pace lowered to ${mbText(rate)}`
  const capNight = rate * 1e6 * 3600 * nightHours * DUTY
  const due = backlogBytes + Math.max(0, arrivalBytesPerHour) * hoursToNightEnd(now, pace.night, siteMin)
  if (due > capNight) return { work: true, night, why: `by day: about ${gb(due)} would be waiting by the end of the coming night, more than it can convert (${gb(capNight)}${how}), so it converts now rather than fall behind` }
  return { work: false, night, why: `waiting for the night (${hhmm(pace.night.from)}-${hhmm(pace.night.to)} site time): it can convert the ${gb(backlogBytes)} waiting and what is recorded until then${how}` }
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

// ---- the rounds: the back-off after "disk too slow", and what they converted -------------------------------
/** A "disk too slow" this long after a round's end still counts as during it: recording's writes reach the NAS up to ~30 s late (the kernel's dirty-page expiry). */
export const AFTER_ROUND_MS = 60_000
/** Each such report halves the pace, down to this share of it (5 MB/s of 40). */
export const BACKOFF_MIN = 1 / 8
/** Once the night of the last report is over, each hour of rounds (12 rounds' working time) with none doubles the pace back. */
export const BACKOFF_STEP_MS = 12 * RUN_MS
/** By day (a round only when it must catch up), a lowered pace holds this long before it may come back. */
const DAY_HOLD_MS = 60 * 60_000
/** What the rounds converted is counted over the last this many (an hour of rounds), once there are 3. */
const ROUNDS_KEPT = 12

const freshRounds = () => ({ last: null, factor: 1, holdUntil: -Infinity, cleanMs: 0, slow: null, samples: [] })
let rounds = freshRounds()

/**
 * A round with the switch On is over (thinning.mjs runThinning): when it worked and what it converted.
 * full: it ended for want of time -- its minutes up, "disk too slow", every location stopped -- so what it
 * converted says what the NAS and the helper can do; a round that ran out of files, or was stopped by the
 * switch or the per-run limit, says nothing about that. held: it did not work at all because the recorder
 * had just said "disk too slow" (counted as a round that converted nothing).
 */
export function noteRound({ start, end, bytes = 0, full = false, held = false }) {
  rounds.last = { start, end, bytes: Math.max(0, Number(bytes) || 0), full: Boolean(full), held: Boolean(held), settled: false }
}

/**
 * The last round, looked at once, when the next begins (runThinning, with the switch On): a minute or so
 * after it ended, as it works at most 4 minutes of each 5, so a "disk too slow" up to AFTER_ROUND_MS after it
 * has been reported by then. Such a report halves the pace for the rest of that night; a round with none
 * counts towards doubling it back once that night is over; what a full round converted is kept. (Not held
 * back until the minute is up: a round that overran its 4 minutes by a few seconds would then be replaced
 * by the next one unlooked at.)
 */
export function settleRound({ slow = lastDiskTooSlow(), night, siteMin = siteMinutesOfDay }) {
  const r = rounds.last
  if (!r || r.settled) return
  r.settled = true
  const during = !r.held && slow && slow.at >= r.start && slow.at <= r.end + AFTER_ROUND_MS && slow.at !== rounds.slow?.at
  if (during) {
    rounds.factor = Math.max(BACKOFF_MIN, rounds.factor / 2)
    rounds.holdUntil = inNight(slow.at, night, siteMin) ? slow.at + hoursToNightEnd(slow.at, night, siteMin) * 3_600_000 : slow.at + DAY_HOLD_MS
    rounds.cleanMs = 0
    rounds.slow = { ...slow }
  } else if (!r.held && rounds.factor < 1 && r.start >= rounds.holdUntil) {
    rounds.cleanMs += Math.max(0, r.end - r.start)
    while (rounds.cleanMs >= BACKOFF_STEP_MS && rounds.factor < 1) {
      rounds.factor = Math.min(1, rounds.factor * 2)
      rounds.cleanMs -= BACKOFF_STEP_MS
    }
    if (rounds.factor >= 1) rounds.cleanMs = 0
  }
  // a round's share of the time is its slot (RUN_MS), however soon a "disk too slow" stopped it
  if (r.full || r.held) {
    rounds.samples.push({ bytes: r.held ? 0 : r.bytes, ms: RUN_MS })
    if (rounds.samples.length > ROUNDS_KEPT) rounds.samples.shift()
  }
}

/** The share of the pace the back-off leaves: 1, 1/2, 1/4 or 1/8. */
export const paceFactor = () => rounds.factor
/** MB/s of footage read now: the pace, backed off. */
export const effectiveMbps = (pace) => pace.mbps * rounds.factor
/** MB/s the last rounds that could work their whole time converted (a round held back counts as none), or null before 3 of them. */
export function achievedMBps() {
  if (rounds.samples.length < 3) return null
  const bytes = rounds.samples.reduce((a, s) => a + s.bytes, 0)
  const ms = rounds.samples.reduce((a, s) => a + s.ms, 0)
  return bytes / 1e6 / (ms / 1000)
}
/** The back-off in words, for the page and the log; '' at the whole pace. */
export function backoffText(pace, siteMin = siteMinutesOfDay) {
  if (rounds.factor >= 1) return ''
  const halvings = Math.round(Math.log2(1 / rounds.factor))
  const s = rounds.slow
  const cam = s?.nvr !== undefined && s?.ch !== undefined ? ` (${s.nvr}/${Number(s.ch) + 1})` : ''
  const when = s ? ` after the recorder reported "disk too slow" at ${hhmm(siteMin(s.at))} site time${cam} while it converted` : ''
  return `the pace is ${halvings === 1 ? 'halved' : `halved ${halvings} times`}, to ${mbText(effectiveMbps(pace))} of ${mbText(pace.mbps)},${when}; it doubles back after each hour of rounds with no such report, once that night is over`
}

export const _test = {
  reset() {
    slowLast = null
    rounds = freshRounds()
  }
}
