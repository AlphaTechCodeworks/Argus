// Gap backfill from the NVRs (phase 2b).
//
// Why this exists, and why it has a deadline: the server keeps 6-12 months of footage but each
// NVR only holds about 30 days of its own. Every hole in the server's copy - a restart, a stream
// the NVR refused, a disk that could not keep up - can still be filled from the NVR while the NVR
// still has that stretch. Once the NVR has aged past it, the hole is permanent and nothing can be
// done about it ever again. So this job is a race against the NVRs' own retention, and the gaps it
// picks first are the ones closest to falling off the end.
//
// Three rules shape everything here, in this order:
//
//  1. Live recording always wins. Footage not recorded now is lost now; a hole filled tomorrow
//     instead of tonight costs nothing. So the job only runs inside an off-peak window, one camera
//     at a time per NVR, rate limited, and it stands down the moment the NVR is offline, degraded,
//     cooling after late SDK calls, or refusing streams. nvr-2 is already at 128 of 192 Mb and
//     refuses streams; asking it again straight away would take live recording down with it, so a
//     refusal means "stop and come back much later", never "retry".
//  2. Never invent data. A hole we cannot characterise is reported as `unknown`, not as filled and
//     not as permanent. A stretch the NVR says nothing useful about is left pending and asked
//     again later; only a definite answer ("older than the NVR keeps", "the NVR has no recording
//     of this stretch") makes a gap permanent.
//  3. Everything survives a restart. The ledger of holes lives in the recordings DB
//     (rec-index.mjs `backfill_gaps`), not in memory, so a restart halfway through a night picks up
//     where it left off, and a hole that can never be filled stops being retried for good.
//
// What lands on disk is real footage: the NVR's own frames, written by the ordinary SegmentWriter
// into ordinary segment files with ordinary .idx keyframe indexes, at the times the frames really
// have (server time, the NVR's clock skew already taken out by rec-fallback.mjs). Playback,
// housekeeping, thinning and exports treat them exactly like live recordings, except that their
// index row carries `source` ("backfill:<nvr id>") and `filledMs`, so an evidence export can state
// where that stretch came from and when it was pulled.
//
// Everything above the horizontal rule is pure: no SDK, no NVR, no disk, no clock of its own. That
// is the part that must be right, and it is the part the tests hammer. The job below it is thin
// glue that calls those functions and does the I/O, with every dependency injectable so that the
// whole of it can be tested on Windows with fakes and no Linux SDK anywhere in sight.
//
//   GET  /api/admin/backfill        -> { enabled, running, window, state, gaps, permanent, ... }
//   POST /api/admin/backfill/run    -> starts the job (still only works inside the window)
//   POST /api/admin/backfill/stop   -> stops it; anything in flight is closed cleanly
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { siteMinutesOfDay } from './site-time.mjs'
import { join } from 'node:path'
import { DATA_DIR, isAdmin } from './auth.mjs'

// The caller may hand us a plain user name or the { user, admin } the newer routes pass around.
// Taking only one of the two is how a route ends up refusing everybody: isAdmin() given an object
// looks it up as if it were a name, finds nothing, and denies an admin as confidently as a
// stranger. CCTV_AUTH=off has no real users at all, and is honoured here as everywhere else.
const AUTH_OFF = process.env.CCTV_AUTH === 'off'
const admin = (who) => (AUTH_OFF ? true : who && typeof who === 'object' ? who.admin === true : isAdmin(who))
import { nvrCoverage, startLeg } from './rec-fallback.mjs'
import { SegmentWriter } from './segment-writer.mjs'

const MINUTE = 60_000
const DAY = 86_400_000
const HEADER_SIZE = 16 // sdk.mjs encodeFrame: key flag, codec, size, time (us); then the payload

/** Segments this close together are one stretch, as everywhere else (rec-index.mjs JOIN_MS). */
export const JOIN_MS = 2000
/**
 * Footage newer than this is left alone: the recorder may still be writing it, its last segment
 * may not be indexed yet, and the live NVR fallback in playback covers the last few hours anyway
 * (roadmap 2b point 6). Backfilling it would only fight the recorder for the same NVR.
 */
export const TAIL_MS = 6 * 3_600_000
/** How far back a scan looks. Beyond the NVRs' own retention there is nothing to find. */
export const SCAN_MARGIN_MS = 2 * DAY

// A refusal is the NVR telling us it has no capacity. Backing off by minutes would simply ask
// again while it is still full, so the first wait is already long and each further refusal doubles
// it. An ordinary failure (a search that errored, a leg that died) is not the same thing and gets a
// much shorter ladder.
export const REFUSED_BACKOFF_MS = [30 * MINUTE, 6 * 3_600_000]
export const ERROR_BACKOFF_MS = [5 * MINUTE, 2 * 3_600_000]

/**
 * The backfill settings, repeated here so that this module never has to import settings.mjs.
 * That import would drag in the SDK through nvr-xml.mjs, and the whole point of keeping the gap
 * detection and the scheduling pure is that they can be developed and tested on a machine with no
 * Linux SDK on it. settings.mjs holds the same defaults and does the validation; server.mjs passes
 * its getSettings in as a dependency. With nobody passing one, `enabled` is false and the job does
 * nothing, which is the right way round for something that competes with live recording.
 */
export const DEFAULT_BACKFILL = Object.freeze({ enabled: false, windowStart: '01:00', windowEnd: '05:00', nvrRetentionDays: 30, minGapSeconds: 10, maxGapMinutes: 60, perNvrMbps: 8, restSeconds: 30 })

/** Reasons a gap is permanent. Written into the ledger and shown on the Storage/Health page. */
export const PERMANENT = Object.freeze({
  aged: 'older than the NVR still keeps',
  nothing: 'the NVR has no recording of this stretch'
})

// ---- pure: ranges ------------------------------------------------------------------------------

/** [[s, e]] sorted and merged, anything within joinMs of its neighbour joined. Never mutates the input. */
export function mergeRanges(spans, joinMs = JOIN_MS) {
  const ok = spans.filter((r) => Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] >= r[0]).map((r) => [r[0], r[1]])
  ok.sort((a, b) => a[0] - b[0])
  const out = []
  for (const [s, e] of ok) {
    const last = out.at(-1)
    if (last && s <= last[1] + joinMs) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/** The parts of [fromMs, toMs] that `covered` (merged, sorted) does not cover. */
export function complement(covered, fromMs, toMs) {
  const out = []
  let at = fromMs
  for (const [s, e] of covered) {
    if (e <= at) continue
    if (s >= toMs) break
    if (s > at) out.push([at, Math.min(s, toMs)])
    at = Math.max(at, e)
    if (at >= toMs) break
  }
  if (at < toMs) out.push([at, toMs])
  return out.filter(([s, e]) => e > s)
}

/** The overlap of two sorted, merged lists of ranges. */
export function intersect(a, b) {
  const out = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0])
    const e = Math.min(a[i][1], b[j][1])
    if (e > s) out.push([s, e])
    if (a[i][1] < b[j][1]) i++
    else j++
  }
  return out
}

/** Ranges cut into pieces of at most maxMs, so one NVR leg is never an open-ended pull. */
export function chunkRanges(ranges, maxMs) {
  const out = []
  for (const [s, e] of ranges) {
    for (let at = s; at < e; at += maxMs) out.push([at, Math.min(at + maxMs, e)])
  }
  return out
}

const totalMs = (ranges) => ranges.reduce((n, [s, e]) => n + (e - s), 0)

// ---- pure: gap detection -----------------------------------------------------------------------

/**
 * The holes in one camera's recorded timeline, each with a reason and an age. This is the part that
 * has to be right: everything else only acts on what this says.
 *
 * Two sources are combined, and they disagree more often than one would like:
 *  - the recorder's own gap rows ("refused by the NVR", "disk too slow", "camera offline", the
 *    downtime rows rec-recover.mjs writes): these say WHY, but a row can also cover time that was
 *    in the end recorded (the recorder reports the gap from the last frame it had, and footage
 *    written by another worker or recovered afterwards may fill part of it).
 *  - the segments actually in the index: these say WHAT IS THERE, which is the only thing that
 *    matters for deciding whether a hole exists at all.
 * So the holes come from the segments, and the reasons are borrowed from whichever recorder rows
 * overlap them. A hole no row explains is reported with kind 'unknown' and reason null - never
 * guessed at, never quietly dropped.
 *
 * Nothing before the camera's first segment is a hole (there was no recording yet, which is not the
 * same as footage lost), and nothing inside the tail is either (the recorder may still be at work
 * there; see TAIL_MS).
 *
 * @param {{ segments: {startMs:number, endMs:number}[], gapRows?: {fromMs:number, toMs:number, reason?:string}[],
 *   nvr?: string, ch?: number, now?: number, fromMs?: number, toMs?: number, minGapMs?: number,
 *   joinMs?: number, tailMs?: number }} opts
 * @returns {{nvr:string|null, ch:number|null, fromMs:number, toMs:number, durationMs:number,
 *   reason:string|null, kind:'recorder'|'unknown', ageMs:number}[]} oldest first
 */
export function findGaps({ segments = [], gapRows = [], nvr = null, ch = null, now = Date.now(), fromMs = -Infinity, toMs = Infinity, minGapMs = 10_000, joinMs = JOIN_MS, tailMs = TAIL_MS } = {}) {
  const covered = mergeRanges(
    segments.map((s) => [Number(s.startMs), Number(s.endMs)]),
    joinMs
  )
  if (!covered.length) return [] // a camera with no footage at all has no holes, only no history
  // the stretch a hole can live in: from the first frame we ever recorded to the start of the tail
  const lo = Math.max(covered[0][0], fromMs)
  const hi = Math.min(covered.at(-1)[1], toMs, now - tailMs)
  if (!(hi > lo)) return []
  const rows = gapRows
    .map((g) => ({ fromMs: Number(g.fromMs), toMs: Number(g.toMs), reason: g.reason ?? null }))
    .filter((g) => Number.isFinite(g.fromMs) && Number.isFinite(g.toMs) && g.toMs > g.fromMs)
  const out = []
  for (const [s, e] of complement(covered, lo, hi)) {
    if (e - s < minGapMs) continue // shorter than the shortest gap worth a whole NVR session
    // every recorder row that overlaps this hole, longest overlap first: the reason that explains
    // most of the hole is the one to show
    const hits = rows
      .map((g) => ({ g, overlap: Math.min(g.toMs, e) - Math.max(g.fromMs, s) }))
      .filter((h) => h.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
    const reasons = [...new Set(hits.map((h) => h.g.reason).filter(Boolean))]
    // a row has to explain a real share of the hole to be its reason; a 2 s row against a 3 h hole
    // explains nothing, and pretending otherwise would hide the fact that we do not know
    const explained = totalMs(mergeRanges(hits.map((h) => [Math.max(h.g.fromMs, s), Math.min(h.g.toMs, e)])))
    const known = reasons.length > 0 && explained >= (e - s) / 2
    out.push({
      nvr,
      ch,
      fromMs: s,
      toMs: e,
      durationMs: e - s,
      reason: known ? reasons.join('; ') : null,
      kind: known ? 'recorder' : 'unknown',
      ageMs: Math.max(0, now - e)
    })
  }
  return out
}

/**
 * What can be done about one gap, given what the NVR says it holds.
 *
 * `coverage` is rec-fallback's nvrCoverage answer, or null when it has not been asked. A coverage
 * answer carrying a `reason` (offline, busy, the search failed) is NOT an answer about the footage:
 * it leaves the gap pending, because "we could not ask" must never be recorded as "there is
 * nothing there".
 *
 * @param {{fromMs:number, toMs:number}} gap
 * @param {{ now?:number, nvrRetentionMs:number, coverage?:{ranges:number[][], reason?:string}|null }} opts
 * @returns {{ decided:boolean, permanent:boolean, permanentReason:string|null, work:number[][], why:string|null }}
 */
export function gapPlan(gap, { now = Date.now(), nvrRetentionMs, coverage = null } = {}) {
  const none = { decided: false, permanent: false, permanentReason: null, work: [], why: null }
  // The deadline itself: the NVR has already rolled past the end of this hole, so no amount of
  // asking will ever bring it back. Marked permanent and never retried.
  if (now - gap.toMs > nvrRetentionMs) return { ...none, decided: true, permanent: true, permanentReason: PERMANENT.aged }
  if (!coverage) return { ...none, why: 'the NVR has not been asked yet' }
  if (coverage.reason) return { ...none, why: coverage.reason }
  const work = intersect(mergeRanges([[gap.fromMs, gap.toMs]]), mergeRanges(coverage.ranges ?? []))
  if (!work.length) return { ...none, decided: true, permanent: true, permanentReason: PERMANENT.nothing }
  return { decided: true, permanent: false, permanentReason: null, work, why: null }
}

// ---- pure: scheduling --------------------------------------------------------------------------

/** "HH:MM" as minutes past midnight, or null when it is not a time of day. */
export function parseHhmm(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/**
 * Is `minutes` (past midnight, local) inside the window? A window that ends before it starts wraps
 * past midnight, which is the normal case here: 01:00-05:00 does not, but 22:00-04:00 would.
 */
export function inWindow(minutes, startHhmm, endHhmm) {
  const a = parseHhmm(startHhmm)
  const b = parseHhmm(endHhmm)
  if (a === null || b === null || a === b) return false
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b
}

/** Minutes past local midnight for a wall-clock time. */
// on the site's clock (site-time.mjs), not the server's: the server runs on UTC, so 01:00-05:00 was
// 21:00-01:00 on site
export const minutesOfDay = (ms) => siteMinutesOfDay(ms)

/** How long until the window opens again (0 while it is open). */
export function msUntilWindow(ms, startHhmm, endHhmm) {
  const now = minutesOfDay(ms)
  if (inWindow(now, startHhmm, endHhmm)) return 0
  const a = parseHhmm(startHhmm)
  if (a === null) return DAY
  const mins = (a - now + 1440) % 1440
  return (mins || 1440) * MINUTE
}

/**
 * How long to wait after moving `bytes` in `elapsedMs`, so the average never exceeds `mbps`, plus a
 * fixed rest between pulls. This is the whole rate limit: it is deliberately crude, because the
 * point is to stay far below what the NVR can give, not to use it efficiently.
 */
export function restAfterMs(bytes, elapsedMs, mbps, restSeconds) {
  const needed = mbps > 0 ? (Number(bytes) * 8000) / (mbps * 1e6) : 0
  return Math.max(0, Math.round(needed - elapsedMs)) + Math.max(0, Math.round(restSeconds * 1000))
}

/** Backoff after n failures, doubling from the first value up to the second. */
export const backoffMs = (n, [first, max]) => Math.min(max, first * 2 ** Math.max(0, n - 1))

/**
 * May this NVR be asked for backfill at all? Every "no" here is a reason to come back later, never
 * a reason to give up on the gap.
 * @param {{online?:boolean, degraded?:boolean, cooling?:boolean, refusing?:boolean, busyUntil?:number}} n
 * @returns {{ ok: boolean, why: string|null }}
 */
export function nvrReady(n, now = Date.now()) {
  if (!n) return { ok: false, why: 'the NVR is not configured' }
  if (!n.online) return { ok: false, why: 'the NVR is offline' }
  if (n.degraded) return { ok: false, why: 'the NVR is busy recovering' }
  if (n.cooling) return { ok: false, why: 'the NVR is cooling down after late calls' }
  if (n.refusing) return { ok: false, why: 'the NVR is refusing streams' }
  if (n.busyUntil > now) return { ok: false, why: `backing off for another ${Math.round((n.busyUntil - now) / 1000)} s` }
  return { ok: true, why: null }
}

/**
 * The next gap to work on, or null with the reason nothing was picked.
 *
 * The order is the deadline: the gap with the least time left before its NVR rolls past it goes
 * first, because that is the one that becomes impossible soonest. Length breaks ties, shortest
 * first, so a night spent on one huge hole never starves ten small ones.
 *
 * @param {object[]} rows ledger rows: { id, nvr, ch, fromMs, toMs, state, attempts, lastTryMs, nextTryMs? }
 * @param {{ now?:number, nvrs: Map<string, object>|object, retentionMsOf: (nvrId:string) => number,
 *   busyNvrs?: Set<string> }} opts busyNvrs: NVRs already pulling (one camera at a time per NVR)
 * @returns {{ row: object|null, why: string|null }}
 */
export function chooseGap(rows, { now = Date.now(), nvrs, retentionMsOf, busyNvrs = new Set() } = {}) {
  const get = (id) => (nvrs instanceof Map ? nvrs.get(id) : nvrs?.[id])
  const skipped = new Map()
  const note = (why) => skipped.set(why, (skipped.get(why) ?? 0) + 1)
  const candidates = []
  for (const r of rows) {
    if (r.state === 'permanent' || r.state === 'filled') continue
    if (busyNvrs.has(r.nvr)) {
      note('that NVR is already busy with another camera')
      continue
    }
    if (r.nextTryMs > now) {
      note('waiting out a backoff')
      continue
    }
    const ready = nvrReady(get(r.nvr), now)
    if (!ready.ok) {
      note(ready.why)
      continue
    }
    const retention = retentionMsOf(r.nvr)
    const leftMs = r.fromMs + retention - now // time before the NVR loses the START of this hole
    if (leftMs <= 0) {
      note('older than the NVR still keeps')
      continue
    }
    candidates.push({ row: r, leftMs })
  }
  if (!candidates.length) {
    const worst = [...skipped.entries()].sort((a, b) => b[1] - a[1])[0]
    return { row: null, why: worst ? worst[0] : 'nothing to fill' }
  }
  candidates.sort((a, b) => a.leftMs - b.leftMs || a.row.toMs - a.row.fromMs - (b.row.toMs - b.row.fromMs))
  return { row: candidates[0].row, why: null }
}

/**
 * Should the job do anything at all right now? Live recording and exports come first; outside the
 * window it does nothing even when told to run.
 * @returns {{ go: boolean, why: string|null }}
 */
export function mayRun({ now = Date.now(), cfg, running, exportsBusy = false, recordingBusy = false } = {}) {
  if (!cfg?.enabled) return { go: false, why: 'backfill is switched off in the settings' }
  if (!running) return { go: false, why: 'the job is stopped' }
  if (recordingBusy) return { go: false, why: 'live recording needs the NVRs; backfill stands down' }
  if (exportsBusy) return { go: false, why: 'an export is running; backfill stands down' }
  if (!inWindow(minutesOfDay(now), cfg.windowStart, cfg.windowEnd)) return { go: false, why: `outside the off-peak window (${cfg.windowStart}-${cfg.windowEnd})` }
  return { go: true, why: null }
}

// ------------------------------------------------------------------------------------------------
// Below here: the parts that touch NVRs and disks. Everything is injected so the tests can drive it
// with fakes; nothing in this half is needed to decide anything, only to carry it out.
// ------------------------------------------------------------------------------------------------

const STATE_FILE = () => join(DATA_DIR, 'backfill.json')

/** Whether the job should be running, remembered across restarts (roadmap 2b point 3: resumable). */
function readRunFlag(file = STATE_FILE()) {
  try {
    if (!existsSync(file)) return false
    return JSON.parse(readFileSync(file, 'utf8'))?.running === true
  } catch {
    return false
  }
}

function writeRunFlag(running, who, file = STATE_FILE()) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify({ running, by: who ?? null, at: new Date().toISOString() }, null, 1)}\n`)
    renameSync(tmp, file)
  } catch (e) {
    console.warn(`[backfill] could not remember the run flag: ${e.message}`)
  }
}

/**
 * A sink shaped like the browser WebSocket rec-fallback's startLeg writes to, but it writes the
 * frames into a SegmentWriter instead of sending them anywhere. The leg has already rewritten each
 * frame's time to server time, so the files land at the times the footage really has.
 *
 * bufferedAmount is the writer's queue: startLeg's session uses it for flow control, so a slow disk
 * slows the pull down instead of filling memory. That is also why the job cannot outrun the drive
 * the recorders are writing to.
 */
export function writerSink(writer) {
  const stats = { frames: 0, bytes: 0, firstTs: null, lastTs: null, dropped: 0 }
  return {
    OPEN: 1,
    readyState: 1,
    stats,
    get bufferedAmount() {
      return writer.queueStatus().queuedBytes
    },
    send(data) {
      if (typeof data === 'string') return // the leg's own {started}/{source}/{stream} notes: nothing to write
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (buf.length <= HEADER_SIZE) return
      const ts = Number(buf.readBigInt64LE(8)) / 1000
      if (!Number.isFinite(ts) || ts <= 0) return // a frame without a usable time is not written anywhere
      const ok = writer.write(buf.subarray(HEADER_SIZE), { isKey: buf[0] === 1, ts, codec: buf[1] === 1 ? 'h265' : 'h264' })
      if (!ok) {
        stats.dropped++
        return
      }
      stats.frames++
      stats.bytes += buf.length - HEADER_SIZE
      if (stats.firstTs === null) stats.firstTs = ts
      stats.lastTs = ts
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.())

/** The backfill job. One per process; server.mjs makes it and hands it to handleBackfill. */
export class BackfillJob {
  /**
   * @param {{ index: object, nvrs: Map|object, locations: () => {id:string,path:string,role?:string}[],
   *   settings?: () => object, coverage?: Function, leg?: Function, makeWriter?: Function,
   *   now?: () => number, exportsBusy?: () => boolean, recordingBusy?: () => boolean,
   *   refusingOf?: (nvrId:string) => boolean, coolingOf?: (nvrId:string) => boolean,
   *   tickMs?: number, stateFile?: string, log?: Function }} deps
   */
  constructor(deps = {}) {
    this.index = deps.index ?? null
    this.nvrs = deps.nvrs ?? new Map()
    this.locations = deps.locations ?? (() => [])
    this.settings = deps.settings ?? (() => ({}))
    this.coverage = deps.coverage ?? nvrCoverage
    this.leg = deps.leg ?? startLeg
    this.makeWriter = deps.makeWriter ?? ((o) => new SegmentWriter(o))
    this.now = deps.now ?? Date.now
    // Fail safe: if nobody told us how to see exports or recording trouble, assume the worst rather
    // than assume it is fine. A backfill that never runs is a nuisance; one that runs on top of a
    // live recording is the thing this whole phase exists to protect.
    this.exportsBusy = deps.exportsBusy ?? (() => true)
    this.recordingBusy = deps.recordingBusy ?? (() => false)
    this.refusingOf = deps.refusingOf ?? (() => false)
    this.coolingOf = deps.coolingOf ?? (() => false)
    this.tickMs = deps.tickMs ?? 30_000
    this.stateFile = deps.stateFile ?? STATE_FILE()
    this.log = deps.log ?? ((m) => console.log(`[backfill] ${m}`))
    this.running = readRunFlag(this.stateFile)
    this.timer = null
    this.working = false
    this.busyNvrs = new Set()
    this.nvrBackoff = new Map() // NVR id -> when it may be asked again (a refusal covers every camera on it)
    this.nextTry = new Map() // ledger row id -> the time it may be tried again (memory only)
    this.last = { at: null, what: 'not started yet', filledMs: 0, bytes: 0, errors: 0 }
    this.current = null
  }

  cfg() {
    const s = this.settings()
    // the stored settings over the defaults, so a field missing from an old settings file (or from a
    // caller that passed none) still has a sane value rather than NaN
    return { ...DEFAULT_BACKFILL, ...(s?.backfill ?? {}) }
  }

  /** The NVR objects as the pure scheduler wants them (cooling and refusals come from outside). */
  nvrView() {
    const out = new Map()
    const entries = this.nvrs instanceof Map ? [...this.nvrs.entries()] : Object.entries(this.nvrs ?? {})
    for (const [id, n] of entries) {
      out.set(id, { online: Boolean(n?.online), degraded: Boolean(n?.degraded), cooling: Boolean(this.coolingOf(id)), refusing: Boolean(this.refusingOf(id)), busyUntil: this.nvrBackoff.get(id) ?? 0 })
    }
    return out
  }

  retentionMs() {
    const d = Number(this.cfg().nvrRetentionDays)
    return (Number.isFinite(d) && d > 0 ? d : 30) * DAY
  }

  // ---- the ledger

  /** One camera's holes right now, straight from the index. */
  holesOf(nvr, ch, fromMs, toMs, { minGapMs } = {}) {
    const cfg = this.cfg()
    const min = minGapMs ?? Math.max(1000, Number(cfg.minGapSeconds ?? 10) * 1000)
    return findGaps({
      nvr,
      ch,
      now: this.now(),
      fromMs,
      toMs,
      minGapMs: min,
      segments: this.index.segments(nvr, ch, fromMs, toMs),
      gapRows: this.index.gaps(nvr, ch, fromMs, toMs)
    })
  }

  /**
   * Looks over every camera's recent history and writes what it finds into the ledger. Holes
   * already past the NVRs' retention are marked permanent here, so they are never picked up again.
   * @returns {{ found: number, added: number, permanent: number }}
   */
  scan() {
    const now = this.now()
    const retention = this.retentionMs()
    const from = now - retention - SCAN_MARGIN_MS
    const out = { found: 0, added: 0, permanent: 0 }
    for (const { nvr, ch } of this.index.cameras()) {
      for (const g of this.holesOf(nvr, ch, from, now)) {
        out.found++
        const known = this.index.backfillFind(nvr, ch, g.fromMs, g.toMs)
        this.index.backfillNote({ nvr, ch, fromMs: g.fromMs, toMs: g.toMs, reason: g.reason, kind: g.kind }, now)
        if (!known) out.added++
      }
    }
    // A separate pass over the whole ledger, because a hole falls off the end of the NVR's own
    // retention while it is sitting in the ledger waiting its turn, not while it is being found.
    // This is where the deadline actually bites, and where roadmap point 5's list comes from.
    for (const row of this.index.backfillList({ state: 'pending', limit: 10_000 })) {
      if (now - row.toMs > retention) {
        this.index.backfillSet(row.id, { state: 'permanent', note: PERMANENT.aged })
        out.permanent++
      }
    }
    return out
  }

  // ---- running

  start(who) {
    if (!this.running) {
      this.running = true
      writeRunFlag(true, who, this.stateFile)
      this.log(`started by ${who ?? '?'}`)
    }
    this.#arm(0)
    return this.status()
  }

  stop(who) {
    if (this.running) {
      this.running = false
      writeRunFlag(false, who, this.stateFile)
      this.log(`stopped by ${who ?? '?'}`)
    }
    clearTimeout(this.timer)
    this.timer = null
    this.current?.abort?.()
    return this.status()
  }

  /** Called at boot: picks the job up again if it was running before the restart. */
  resume() {
    if (this.running) this.#arm(0)
    return this.running
  }

  #arm(ms) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.tick().catch((e) => console.warn(`[backfill] tick failed: ${e.message}`))
    }, ms)
    this.timer.unref?.()
  }

  /**
   * One step: decide whether anything may happen, pick a gap, fill a bit of it. It deliberately
   * does at most one pull per tick, so between any two pulls the whole set of conditions (window,
   * exports, refusals, live recording) is checked again from scratch.
   */
  async tick() {
    if (this.working) return
    this.working = true
    try {
      const now = this.now()
      const cfg = this.cfg()
      const allowed = mayRun({ now, cfg, running: this.running, exportsBusy: this.exportsBusy(), recordingBusy: this.recordingBusy() })
      if (!allowed.go) {
        this.last.what = allowed.why
        if (this.running) this.#arm(Math.min(this.tickMs * 10, Math.max(this.tickMs, msUntilWindow(now, cfg.windowStart, cfg.windowEnd))))
        return
      }
      this.scan()
      const rows = this.index.backfillList({ limit: 5000 }).map((r) => ({ ...r, nextTryMs: this.nextTry.get(r.id) ?? 0 }))
      const pick = chooseGap(rows, { now, nvrs: this.nvrView(), retentionMsOf: () => this.retentionMs(), busyNvrs: this.busyNvrs })
      if (!pick.row) {
        this.last.what = pick.why
        this.#arm(this.tickMs)
        return
      }
      const rest = await this.fill(pick.row)
      this.#arm(Math.max(rest, 0))
    } finally {
      this.working = false
    }
  }

  /**
   * Fills what can be filled of one ledger row, and says how long to rest afterwards.
   * Every exit updates the row, so nothing is ever left in a state a restart cannot read.
   * @returns {Promise<number>} ms to wait before the next pull
   */
  async fill(row) {
    const now = this.now()
    const cfg = this.cfg()
    const nvr = this.nvrs instanceof Map ? this.nvrs.get(row.nvr) : this.nvrs?.[row.nvr]
    const fail = (message, ladder = ERROR_BACKOFF_MS) => {
      const attempts = (row.attempts ?? 0) + 1
      this.index.backfillSet(row.id, { attempts, lastTryMs: now, lastError: message })
      this.nextTry.set(row.id, this.now() + backoffMs(attempts, ladder))
      this.last = { ...this.last, at: now, what: message, errors: this.last.errors + 1 }
      return backoffMs(attempts, ladder)
    }
    if (!nvr) return fail(`${row.nvr} is not configured any more`)

    // 1. What is actually still missing? The row may be half filled by an earlier night, or by the
    //    live fallback, so the holes are recomputed from the index rather than trusted from the row.
    const holes = this.holesOf(row.nvr, row.ch, row.fromMs, row.toMs)
    if (!holes.length) {
      this.index.backfillSet(row.id, { state: 'filled', filledMs: now, lastError: null })
      this.last = { ...this.last, at: now, what: `${row.nvr}/${row.ch + 1}: nothing left to fill` }
      return 0
    }

    // 2. What does the NVR say it has? A failure to ask is not an answer (rule 2 at the top).
    let cov
    try {
      cov = await this.coverage(nvr, row.ch, row.fromMs, row.toMs, { now: () => this.now() })
    } catch (e) {
      return fail(`the NVR search failed (${e?.message ?? e})`)
    }
    const plan = gapPlan({ fromMs: row.fromMs, toMs: row.toMs }, { now, nvrRetentionMs: this.retentionMs(), coverage: cov })
    if (plan.permanent) {
      this.index.backfillSet(row.id, { state: 'permanent', note: plan.permanentReason, lastTryMs: now })
      this.log(`${row.nvr}/${row.ch + 1} ${new Date(row.fromMs).toISOString()}: permanent (${plan.permanentReason})`)
      return 0
    }
    if (!plan.decided) {
      // "we could not ask" - a refusal-shaped answer waits much longer than an ordinary hiccup
      const refused = /refus|busy|offline/i.test(String(plan.why ?? ''))
      return fail(plan.why ?? 'the NVR gave no answer', refused ? REFUSED_BACKOFF_MS : ERROR_BACKOFF_MS)
    }

    // 3. Only the parts that are BOTH missing here and present there, in bounded pieces.
    const maxMs = Math.max(MINUTE, Number(cfg.maxGapMinutes ?? 60) * MINUTE)
    const work = chunkRanges(
      intersect(
        mergeRanges(holes.map((h) => [h.fromMs, h.toMs])),
        mergeRanges(plan.work)
      ),
      maxMs
    )
    if (!work.length) {
      this.index.backfillSet(row.id, { state: 'permanent', note: PERMANENT.nothing, lastTryMs: now })
      return 0
    }
    const loc = this.locations().find((l) => l.role !== 'archive') ?? null
    if (!loc) return fail('no storage location available')

    // 4. One piece per turn. Anything can have changed by the next one, so it is checked again.
    this.busyNvrs.add(row.nvr)
    const started = this.now()
    let result
    try {
      result = await this.pull({ nvr, row, loc, fromMs: work[0][0], toMs: work[0][1], skewMs: cov.skewMs ?? 0 })
    } catch (e) {
      this.busyNvrs.delete(row.nvr)
      return fail(`the pull failed (${e?.message ?? e})`)
    }
    this.busyNvrs.delete(row.nvr)
    const elapsed = this.now() - started

    if (result.refused) {
      // The NVR turned us away. This is nvr-2's normal state, and the only right answer is to stop
      // and come back much later: asking again now is exactly what would hurt live recording.
      const attempts = (row.attempts ?? 0) + 1
      const wait = backoffMs(attempts, REFUSED_BACKOFF_MS)
      this.index.backfillSet(row.id, { attempts, lastTryMs: now, lastError: result.message })
      this.nextTry.set(row.id, this.now() + wait)
      // the whole NVR stands down, not only this camera: it is the NVR that has no capacity left
      this.nvrBackoff.set(row.nvr, this.now() + wait)
      this.log(`${row.nvr} refused (${result.message}); leaving it alone for ${Math.round(wait / 60_000)} min`)
      return wait
    }
    if (!result.segments.length) return fail(result.message ?? 'the NVR sent no usable video')

    // 5. Index what landed, marked as backfilled so an export can say where it came from.
    const filledAt = this.now()
    for (const s of result.segments) {
      this.index.addSegment({ nvr: row.nvr, ch: row.ch, path: s.path, startMs: s.startMs, endMs: s.endMs, bytes: s.bytes, keyframes: s.keyframes, loc: loc.id, source: `backfill:${row.nvr}`, filledMs: filledAt })
    }
    const left = this.holesOf(row.nvr, row.ch, row.fromMs, row.toMs)
    this.index.backfillSet(row.id, left.length ? { attempts: row.attempts ?? 0, lastTryMs: now, lastError: null, note: `partly filled, ${left.length} piece(s) left` } : { state: 'filled', filledMs: filledAt, lastError: null, note: null })
    this.nextTry.delete(row.id)
    const ms = result.segments.reduce((n, s) => n + (s.endMs - s.startMs), 0)
    this.last = { at: filledAt, what: `${row.nvr}/${row.ch + 1}: filled ${Math.round(ms / 1000)} s (${result.bytes} bytes)`, filledMs: this.last.filledMs + ms, bytes: this.last.bytes + result.bytes, errors: this.last.errors }
    this.log(this.last.what)
    return restAfterMs(result.bytes, elapsed, Number(cfg.perNvrMbps ?? 8), Number(cfg.restSeconds ?? 30))
  }

  /**
   * One NVR playback leg written straight to disk. This is the only place that talks to an NVR.
   * @returns {Promise<{ segments: object[], bytes: number, refused: boolean, message: string|null }>}
   */
  async pull({ nvr, row, loc, fromMs, toMs, skewMs }) {
    const writer = this.makeWriter({ root: loc.path, nvrId: row.nvr, ch: row.ch })
    const segments = []
    writer.on('segment', (s) => segments.push(s))
    writer.on('error', (e) => this.log(`write failed: ${e.message}`))
    const sink = writerSink(writer)
    let leg = null
    let done
    try {
      leg = this.leg({ nvr, ch: row.ch, fromMs, toMs, skewMs, real: sink, gen: null, at: fromMs })
      this.current = { row: row.id, abort: () => leg.close() }
      // A leg is bounded: the stretch itself plus generous slack. A session that stops sending is
      // closed rather than left holding an NVR login all night.
      const budgetMs = Math.min(30 * MINUTE, (toMs - fromMs) * 2 + 60_000)
      done = await Promise.race([leg.done, sleep(budgetMs).then(() => ({ reason: 'timeout' }))])
      if (done.reason === 'timeout') leg.close()
    } finally {
      this.current = null
      await writer.close()
      await writer.drained()
    }
    const message = done.message ?? (done.reason === 'timeout' ? 'the NVR leg ran out of time' : null)
    // A leg that failed before a single frame, with a refusal-shaped message, is the NVR saying no.
    const refused = done.reason === 'error' && sink.stats.frames === 0 && /refus|busy|limit|resource|no capacity|failed to start/i.test(String(message ?? ''))
    return { segments, bytes: sink.stats.bytes, frames: sink.stats.frames, refused, message: segments.length ? null : (message ?? 'the NVR sent no video') }
  }

  // ---- what the page shows

  status() {
    const cfg = this.cfg()
    const now = this.now()
    const rows = this.index ? this.index.backfillList({ limit: 2000 }) : []
    const view = (r) => ({ ...r, durationMs: r.toMs - r.fromMs, ageMs: Math.max(0, now - r.toMs), nextTryMs: this.nextTry.get(r.id) ?? null })
    const pending = rows.filter((r) => r.state === 'pending').map(view)
    return {
      enabled: Boolean(cfg.enabled),
      running: this.running,
      window: { start: cfg.windowStart, end: cfg.windowEnd, open: inWindow(minutesOfDay(now), cfg.windowStart, cfg.windowEnd), opensInMs: msUntilWindow(now, cfg.windowStart, cfg.windowEnd) },
      nvrRetentionDays: Number(cfg.nvrRetentionDays ?? 30),
      state: { ...this.last, busyNvrs: [...this.busyNvrs], mayRun: mayRun({ now, cfg, running: this.running, exportsBusy: this.exportsBusy(), recordingBusy: this.recordingBusy() }) },
      counts: {
        pending: pending.length,
        filled: rows.filter((r) => r.state === 'filled').length,
        permanent: rows.filter((r) => r.state === 'permanent').length,
        unknown: pending.filter((r) => r.kind === 'unknown').length
      },
      // oldest first: these are the ones the NVRs lose next
      gaps: pending.sort((a, b) => a.fromMs - b.fromMs).slice(0, 500),
      // roadmap 2b point 5: the holes nobody will ever fill, listed so somebody knows
      permanent: rows
        .filter((r) => r.state === 'permanent')
        .sort((a, b) => b.fromMs - a.fromMs)
        .slice(0, 500)
        .map(view)
    }
  }
}

// ---- the routes --------------------------------------------------------------------------------

let job = null

/** server.mjs makes the job once and hands it over; handleBackfill answers from it. */
export function initBackfill(deps) {
  job = deps instanceof BackfillJob ? deps : new BackfillJob(deps)
  job.resume()
  return job
}

/** The job, or null when the server has not made one (no recordings DB). */
export const backfillJob = () => job

/**
 * GET  /api/admin/backfill        the gaps and the job's state
 * POST /api/admin/backfill/run    start (it still only works inside the off-peak window)
 * POST /api/admin/backfill/stop   stop
 *
 * @param {string} method
 * @param {string} pathname
 * @param {() => Promise<object>} readJson the request's JSON body (unused today; kept so the route
 *   signature matches every other admin handler and options can be added without changing callers)
 * @param {string} user
 * @returns {Promise<[number, object] | null>} null when the path is not one of these routes
 */
export async function handleBackfill(method, pathname, readJson, user) {
  if (pathname !== '/api/admin/backfill' && pathname !== '/api/admin/backfill/run' && pathname !== '/api/admin/backfill/stop') return null
  if (!admin(user)) return [403, { error: 'Only admins can see or change backfill' }]
  const want = pathname === '/api/admin/backfill' ? 'GET' : 'POST'
  if (method !== want) return [405, { error: 'Method not allowed' }]
  if (!job) return [503, { error: 'Backfill is not available (no recordings index)' }]
  try {
    if (pathname === '/api/admin/backfill') return [200, job.status()]
    if (pathname === '/api/admin/backfill/run') {
      const cfg = job.cfg()
      if (!cfg.enabled) return [409, { error: 'Backfill is switched off in Settings' }]
      return [200, job.start(user)]
    }
    return [200, job.stop(user)]
  } catch (e) {
    return [500, { error: e?.message ?? String(e) }]
  }
}
