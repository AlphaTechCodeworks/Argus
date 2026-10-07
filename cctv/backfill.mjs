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
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { writeFileAtomicSync } from './atomic-write.mjs'
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
/**
 * The scan reads a camera's history a slice at a time, at most this much of it per read (about 360
 * one-minute files), and does slices for at most SCAN_TURN_MS before it lets the rest of the server run
 * (perf report R5 and verify-5, 2026-09-30: the whole window in one go held the main thread 3.3-4.5 s a
 * tick on production at 4 days of index).
 */
export const SCAN_SLICE_MS = 6 * 3_600_000
const SCAN_TURN_MS = 8
/** The pick reads the ledger's pending rows this many at a time, oldest hole first, up to PICK_ROWS of them. */
export const PICK_PAGE = 500
const PICK_ROWS = 10_000
/** Holes the NVR has rolled past are made permanent this many at a time. */
const AGE_OUT_BATCH = 500
const turn = () => new Promise((r) => setImmediate(r))

/**
 * Where a camera's next scan starts, after one that read the files `spans` ({ startMs, endMs }) up to h:
 * the latest point at or before h inside footage. A hole that has not ended by h starts there (at the
 * end of the footage before it), and the next scan finds it whole, as a scan of the whole window would.
 * With no footage by h (none yet in the window), h itself: a hole needs footage before it.
 */
function markAfter(spans, h) {
  let mark = null
  for (const [s, e] of mergeRanges(spans.map((x) => [Number(x.startMs), Number(x.endMs)]))) {
    if (s > h) break
    mark = Math.min(e, h)
  }
  return mark ?? h
}

// A refusal is the NVR telling us it has no capacity. Backing off by minutes would simply ask
// again while it is still full, so the first wait is already long and each further refusal doubles
// it. An ordinary failure (a search that errored, a leg that died) is not the same thing and gets a
// much shorter ladder.
export const REFUSED_BACKOFF_MS = [30 * MINUTE, 6 * 3_600_000]
export const ERROR_BACKOFF_MS = [5 * MINUTE, 2 * 3_600_000]
// How long a fill() that threw keeps the other holes of its camera at the back of the pick
// (chooseGap): 20 hours after the first throw, twice as long for each further one, up to 8 days. The
// hole that threw stays there twice as long as that.
// 20 hours is the rest of the night it happened in and no more: by the next night's window the
// camera's holes have their place by age again. A place at the back that only footage of that
// camera getting into the index could end lasted until the service was restarted wherever other
// holes were due at every tick: one refused write, and the five oldest holes of that camera aged out
// on the NVR behind a standing backlog, four of them never asked for.
// Twice as long for the hole itself, so that the camera's other holes are tried before it is: back
// in its place together with them it was the oldest, went first, threw again, and put them all at
// the back again. The doubling is for what really does throw every time: tried again after 1, 2, 4
// and 8 days and not every night.
export const THROWN_LAST_MS = [20 * 3_600_000, 8 * DAY]
/**
 * A pull counts as progress only when it made the row's missing time at least this much shorter.
 * Counting any written file as progress cleared the retry wait on pulls that only wrote footage from
 * outside the hole, and the same row was pulled again on the next tick (playback report 9).
 */
export const MIN_PROGRESS_MS = 1000

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
 * Before the deadline come two counts the job keeps in memory of fills that threw (tick()):
 * `throws`, how often this hole's fill() has thrown since one last returned, and `camThrows`, how
 * often its camera's have since footage of that camera last got into the index. A hole that has
 * thrown goes after every hole that has not, and among those that have not, the holes of a camera
 * that has go after the others: a throw is the only thing known about what else will throw. A
 * hole's own wait only says when it may be tried again, not that anything else gets a turn first:
 * with two such holes on one NVR, each was due, and older, whenever the NVR had rested from the
 * other, and the NVR's other holes were never pulled. The job hands a count over as 0 once the
 * throw is long enough ago (THROWN_LAST_MS; the hole's own twice as late as its camera's): the
 * place at the back is for a while, not for good.
 *
 * @param {object[]} rows ledger rows: { id, nvr, ch, fromMs, toMs, state, attempts, lastTryMs, nextTryMs?, throws?, camThrows? }
 * @param {{ now?:number, nvrs: Map<string, object>|object, retentionMsOf: (nvrId:string) => number,
 *   busyNvrs?: Set<string>, skipped?: Map<string, number> }} opts busyNvrs: NVRs already pulling (one
 *   camera at a time per NVR); skipped: the rows passed over and why, counted into (the job's pick, a
 *   page of rows at a time: the reason for no pick is the commonest over every page)
 * @returns {{ row: object|null, why: string|null }}
 */
export function chooseGap(rows, { now = Date.now(), nvrs, retentionMsOf, busyNvrs = new Set(), skipped = new Map() } = {}) {
  const get = (id) => (nvrs instanceof Map ? nvrs.get(id) : nvrs?.[id])
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
  // (holes whose fill() threw, then holes of a camera whose fills did, go last: see above)
  candidates.sort((a, b) => (a.row.throws ?? 0) - (b.row.throws ?? 0) || (a.row.camThrows ?? 0) - (b.row.camThrows ?? 0) || a.leftMs - b.leftMs || a.row.toMs - a.row.fromMs - (b.row.toMs - b.row.fromMs))
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
    writeFileAtomicSync(file, `${JSON.stringify({ running, by: who ?? null, at: new Date().toISOString() }, null, 1)}\n`)
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
    // deps.index may be the recordings index itself or, from server.mjs at start-up (before it is
    // open), a getter for it. The same shape-tolerance storage-report.mjs has -- and the reason it
    // has it: handing the getter straight through and storing it as `this.index` made every tick
    // throw "this.index.cameras is not a function", so backfill never filled a single gap (it was
    // wired with the getter on 2026-09-25 and silently did nothing until 2026-09-27). Resolved on
    // every use through the `index` getter below, so a tick always sees the currently-open index.
    this.getIndex = typeof deps.index === 'function' ? deps.index : () => deps.index ?? null
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
    this.failsInARow = 0 // ticks that threw since the last one that did not (#tickFailed waits longer for each)
    this.lastFailure = null // { at, message, inARow, hole, holeThrows } of the last tick that threw: status() shows it
    this.pullThrows = new Map() // ledger row id -> pulls of that hole that threw since one last returned (memory only)
    this.camThrows = new Map() // "nvr/ch" -> fills of that camera's holes that threw since footage of it last got into the index (memory only)
    this.nvrThrows = new Map() // NVR id -> fills on it that threw since footage from it last got into the index (memory only)
    this.pullThrowAt = new Map() // ledger row id -> when its fill() last threw: its place at the back of the pick lapses (THROWN_LAST_MS)
    this.camThrowAt = new Map() // "nvr/ch" -> the same for a camera's holes
    this.camBackoff = new Map() // "nvr/ch" -> when holes of that camera may be tried again after a throw (the camera's own ladder)
    this.thrownPull = null // the pull that threw in the tick now failing, for #tickFailed to word
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

  /** The shortest hole worth a pull, in ms (minGapSeconds, at least a second). */
  minGapMs() {
    const s = Number(this.cfg().minGapSeconds ?? 10)
    return Number.isFinite(s) ? Math.max(1000, s * 1000) : 10_000
  }

  /**
   * One camera's holes right now, straight from the index. (Its gap rows by gapsNear: gaps() walked every
   * gap row the camera has, kept 183 days, twice a pull; the same rows, 2026-09-30.)
   */
  holesOf(nvr, ch, fromMs, toMs, { minGapMs } = {}) {
    return findGaps({
      nvr,
      ch,
      now: this.now(),
      fromMs,
      toMs,
      minGapMs: minGapMs ?? this.minGapMs(),
      segments: this.index.segments(nvr, ch, fromMs, toMs),
      gapRows: this.index.gapsNear(nvr, ch, fromMs, toMs)
    })
  }

  /**
   * Looks through every camera's history for holes, from where its last scan stopped, and writes what
   * it finds into the ledger; then makes permanent the pending holes the NVRs have since rolled past.
   *
   * Every tick of the night window it read all 32 days of every camera on the main thread: 3.3-4.5 s a
   * tick at 4 days of index on production, about 65-70 s at 32 days, 24-121 ticks a night (verify-5,
   * 2026-09-29). It found the same holes every time but the newest (a hole is eligible only once out of
   * the 6-hour tail). So each camera keeps a mark in the index (backfill_scan): the latest point inside
   * footage its scan reached, where a hole not yet ended starts (markAfter). The next scan reads from
   * there, a slice at a time (SCAN_SLICE_MS, a file's start and end only), SCAN_TURN_MS of slices a turn
   * of the event loop: a tick is one short slice per camera, the first scan (after the deploy, or a mark
   * lost) the whole window in slices. It notes exactly the holes, reasons and kinds the full scan noted
   * at the same times (backfill-scan.test.mjs: 32 days x 87 cameras, and ticks after), but for two
   * things, both on purpose:
   *  - nothing behind a mark is looked at again. A hole a deletion opens there (stepping round a
   *    bookmarked stretch) is older than the NVR keeps by then, as the oldest footage is what goes; one a
   *    pull splits (backfill's own files) is still its row's, and fill() works out what is left of the row
   *    from the index every time. The full scan noted each leftover again, as a second row of the same
   *    footage.
   *  - a file over MAX_SEGMENT_MS long that began more than an hour before the window's start is seen
   *    (segments() left it out of the full scan, which then found no hole after it): older than the NVR
   *    keeps, so it goes to permanent at once.
   * A camera's whole window is looked through again when the shortest hole changes (minGapSeconds) or
   * the window reaches further back (nvrRetentionDays).
   * @param {{ stop?: () => boolean }} [o] stop: asked between slices (the job was stopped); the marks so far are kept
   * @returns {Promise<{ found: number, added: number, permanent: number, cameras: number, slices: number, rows: number, stopped: boolean }>}
   */
  async scan({ stop = () => false } = {}) {
    const index = this.index
    const now = this.now()
    const retention = this.retentionMs()
    const from = now - retention - SCAN_MARGIN_MS
    const edge = now - TAIL_MS // findGaps's tail: no hole ends after it
    const minGapMs = this.minGapMs()
    const out = { found: 0, added: 0, permanent: 0, cameras: 0, slices: 0, rows: 0, stopped: false }
    const marks = new Map(index.backfillMarks().map((m) => [`${m.nvr}/${m.ch}`, m]))
    const moved = new Map() // camera -> its new mark, kept at the end of each turn
    const keep = () => {
      if (moved.size) index.backfillMarkSet([...moved.values()])
      moved.clear()
    }
    let turnAt = performance.now()
    for (const { nvr, ch } of index.cameras()) {
      if (out.stopped || (out.stopped = stop())) break
      out.cameras++
      const key = `${nvr}/${ch}`
      const m = marks.get(key)
      const whole = !m || m.minGapMs !== minGapMs || from < m.fromMs
      const origin = whole ? from : m.fromMs
      let at = whole ? from : Math.max(m.markMs, from)
      let to = at
      while (to < edge) {
        if ((out.stopped = stop())) break
        // a slice on; after a stretch with no files (an outage, a camera that stopped), a slice past the next one
        let end = edge
        if (edge - to > SCAN_SLICE_MS) {
          const next = index.scanSpanAfter(nvr, ch, to, edge)
          if (next) end = Math.min(Math.max(to, next.startMs) + SCAN_SLICE_MS, edge)
        }
        to = end
        const spans = index.scanSpans(nvr, ch, at, to)
        const last = to >= edge
        if (last) {
          // whether footage goes on past the tail's edge decides where a hole across it is cut (findGaps's hi, as in the full scan)
          const after = index.scanSpanAfter(nvr, ch, to, now)
          if (after) spans.push(after)
        }
        out.slices++
        out.rows += spans.length
        const look = { nvr, ch, now, fromMs: at, toMs: last ? now : to, minGapMs, segments: spans }
        let holes = findGaps(look)
        if (holes.length) {
          // the reasons: the gap rows over these holes only (the same rows, in the same order, as over the whole window)
          holes = findGaps({ ...look, gapRows: index.gapsNear(nvr, ch, holes[0].fromMs, holes.at(-1).toMs) })
          out.found += holes.length
          out.added += index.backfillNoteMany(holes, now)
        }
        at = markAfter(spans, Math.min(to, edge))
        moved.set(key, { nvr, ch, markMs: at, fromMs: origin, minGapMs })
        if (performance.now() - turnAt >= SCAN_TURN_MS) {
          keep()
          await turn()
          turnAt = performance.now()
        }
      }
    }
    keep()
    // A separate pass over the ledger, because a hole falls off the end of the NVR's own retention while
    // it is sitting in the ledger waiting its turn, not while it is being found. This is where the
    // deadline actually bites, and where roadmap point 5's list comes from. Every pending row that has
    // aged out, oldest first, a batch a turn (it was the oldest 10,000 pending rows read as objects, 39 ms
    // on production: verify-5).
    for (;;) {
      const n = index.backfillAgeOut(now - retention, PERMANENT.aged, AGE_OUT_BATCH)
      out.permanent += n
      if (n < AGE_OUT_BATCH) break
      await turn()
    }
    return out
  }

  /**
   * The next ledger row to pull, or null and why not: chooseGap over the oldest PICK_ROWS pending rows,
   * read a page at a time (PICK_PAGE) with the rest of the server let run between pages. The tick read
   * all 10,000 at once, twice (39 + 42 ms on production at 7,500 rows: verify-5). Every NVR is given the
   * same retention here, so the row picked is the oldest hole that can be pulled (the shortest of those
   * that start together): one on a page beats every row on the pages after it, and reading stops there.
   * Unless its fill() has thrown: such a hole goes after every hole that has not (chooseGap), so the
   * reading goes on past it.
   * @returns {Promise<{ row: object|null, why: string|null }>}
   */
  async pick(now = this.now()) {
    const nvrs = this.nvrView()
    const retention = this.retentionMs()
    const skipped = new Map()
    let best = null
    let why = 'nothing to fill'
    let after = null
    // A count of throws puts a camera's holes, and the hole that threw for `times` as long, at the
    // back of the pick for a while and not for good: it is handed over as 0 once the last throw is
    // THROWN_LAST_MS ago, twice as long for each throw. (A count with no time beside it is one that
    // has just been made.)
    const stillLast = (count = 0, at, times = 1) => (count > 0 && (at === undefined || now - at < times * backoffMs(count, THROWN_LAST_MS)) ? count : 0)
    for (let seen = 0; seen < PICK_ROWS; ) {
      const limit = Math.min(PICK_PAGE, PICK_ROWS - seen)
      const page = this.index.backfillPendingPage({ after, limit })
      if (!page.length) break
      seen += page.length
      const got = chooseGap(
        page.map((r) => {
          const cam = `${r.nvr}/${r.ch}`
          return {
            ...r,
            // (its own wait, or its camera's after a throw, whichever is longer)
            nextTryMs: Math.max(this.nextTry.get(r.id) ?? 0, this.camBackoff.get(cam) ?? 0),
            throws: stillLast(this.pullThrows.get(r.id), this.pullThrowAt.get(r.id), 2),
            camThrows: stillLast(this.camThrows.get(cam), this.camThrowAt.get(cam))
          }
        }),
        { now, nvrs, retentionMsOf: () => retention, busyNvrs: this.busyNvrs, skipped }
      )
      why = got.why
      const r = got.row
      // (as chooseGap orders them: fewest throws, of the hole and then of its camera, then the oldest, then the shortest)
      const before = (a, b) => a.throws - b.throws || a.camThrows - b.camThrows || a.fromMs - b.fromMs || a.toMs - a.fromMs - (b.toMs - b.fromMs)
      if (r && (!best || before(r, best) < 0)) best = r
      const lastRow = page.at(-1)
      // A hole that has thrown, or whose camera has, does not end the reading: one that has not, on
      // a later page, goes before it. That reads the whole ledger (up to PICK_ROWS) each tick while
      // such a hole is the best there is, a page at a time as ever.
      if ((best && best.throws === 0 && best.camThrows === 0 && best.fromMs < lastRow.fromMs) || page.length < limit) break
      after = { fromMs: lastRow.fromMs, id: lastRow.id }
      await turn()
    }
    return best ? { row: best, why: null } : { row: null, why }
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
    // (the callback returns its promise, which never rejects: a test runs the armed callback itself,
    // on a clock of its own, and waits for it)
    this.timer = setTimeout(
      () =>
        this.tick().then(
          () => {
            this.failsInARow = 0
          },
          (e) => this.#tickFailed(e)
        ),
      ms
    )
    this.timer.unref?.()
  }

  /**
   * A tick that threw (the scan, the pick or a pull): keep it in the job's state and the journal, and try
   * again. tick() arms the next one only on the paths it returns from, and this used to log and no more:
   * one failure left a job that read as running and never ran again until it was stopped and started,
   * while the holes it could have filled aged out on the NVR (2026-10 code audit, H2). Each failure in a
   * row waits twice as long, up to ten ticks, so a fault that stays is tried about every five minutes and
   * does not fill the journal. status() carries the last failure and how many there were in a row; no
   * page or alert shows it yet.
   */
  #tickFailed(e) {
    let waitMs = this.tickMs
    try {
      this.failsInARow++
      waitMs = Math.min(this.tickMs * 10, this.tickMs * 2 ** (this.failsInARow - 1))
      const why = String(e?.message ?? e)
      const at = this.now()
      const min = (ms) => Math.round(ms / 60_000)
      // fill() threw (tick() says for which hole, and how long it and its NVR are left alone): the
      // job goes on with the other holes at its next run; anything else: the whole run is tried again
      const p = this.thrownPull && this.thrownPull.error === e ? this.thrownPull : null
      this.thrownPull = null
      const what = p ? `${p.hole}: the fill failed part-way (${why}); that hole is left alone for ${min(p.holeWaitMs)} min and ${p.nvr} for ${min(p.nvrWaitMs)} min` : `a run failed (${why})`
      const message = this.running ? `${what}; ${p ? 'the next run is' : 'trying again'} in ${Math.round(waitMs / 1000)} s` : `${what}; the job is stopped`
      // (kept apart from `what`, which the next run writes over: the last failure stays in status().
      // failsInARow starts again at any run that completes, also one that picked nothing because
      // every hole was waiting: for a pull that keeps throwing, holeThrows is the count that climbs)
      this.lastFailure = { at, message: why, inARow: this.failsInARow, hole: p?.hole ?? null, holeThrows: p?.holeThrows ?? null }
      this.last = { ...this.last, at, what: message, errors: this.last.errors + 1 }
      // (the stack once, for the first failure in a row: the journal should say where)
      console.warn(`[backfill] ${message}${this.failsInARow === 1 && e?.stack ? `\n${e.stack}` : ''}`)
    } catch (e2) {
      // nothing in here may keep the next tick from being armed, or reject: nobody waits for this.
      // One guarded try to say that the failed run could not be recorded.
      try {
        console.warn(`[backfill] a failed run could not be recorded: ${e2?.message ?? e2}`)
      } catch {
        // (the journal itself: there is nothing left to say it with)
      }
    } finally {
      if (this.running) this.#arm(waitMs)
    }
  }

  /**
   * One step: decide whether anything may happen, pick a gap, fill a bit of it. It deliberately
   * does at most one pull per tick, so between any two pulls the whole set of conditions (window,
   * exports, refusals, live recording) is checked again from scratch.
   */
  /** The recordings index, resolved now (null before it is open). See the constructor. */
  get index() {
    return this.getIndex()
  }

  async tick() {
    if (this.working) return
    this.working = true
    try {
      // the recordings index is not open yet (start-up): nothing to scan, look again next tick
      if (!this.index) {
        this.#arm(this.tickMs)
        return
      }
      const now = this.now()
      const cfg = this.cfg()
      const allowed = mayRun({ now, cfg, running: this.running, exportsBusy: this.exportsBusy(), recordingBusy: this.recordingBusy() })
      if (!allowed.go) {
        this.last.what = allowed.why
        if (this.running) this.#arm(Math.min(this.tickMs * 10, Math.max(this.tickMs, msUntilWindow(now, cfg.windowStart, cfg.windowEnd))))
        return
      }
      await this.scan({ stop: () => !this.running })
      if (!this.running) return // stopped while it scanned: stop() has cleared the timer, and nothing is pulled
      // Pending rows only, oldest hole first: the newest 5,000 rows of every state left the oldest
      // pending rows (785 of 5,785 on the server), the ones nearest their deadline, out of the pick.
      const pick = await this.pick(now)
      if (!pick.row) {
        this.last.what = pick.why
        this.#arm(this.tickMs)
        return
      }
      const row = pick.row
      let rest
      try {
        rest = await this.fill(row)
        // (it returned: what became of the hole is in the ledger, and its place in the pick is its own
        // again. The camera's count and the NVR's are fill()'s to clear, once footage has got into the index)
        this.pullThrows.delete(row.id)
        this.pullThrowAt.delete(row.id)
      } catch (e) {
        // fill() threw part-way (the index refusing a write after the footage was pulled, say): none of
        // what it does for a failed try has happened, so this hole, still the oldest, would be picked
        // again at the next tick and pulled from the same NVR again, for as long as the fault lasted,
        // each pull leaving files the index does not know. Counted here, in memory (the index may be
        // what failed):
        //   the hole waits on the error ladder, a step further for each throw, and for a while
        //     (THROWN_LAST_MS) goes after every hole that has not thrown, as the other holes of its
        //     camera go after those of cameras that have not (chooseGap): one hole, several, or a
        //     camera's, that always throw cannot hold the others back (report 9's shape);
        //   the camera waits on a ladder of its own, by its fills that threw since footage of it last
        //     got into the index: its holes are many, each new to the pick, and one of them was
        //     pulled, and threw, whenever nothing else was due (every 7.5 min, all night);
        //   the NVR rests on a ladder of its own, by its pulls that threw in a row (5, 10, 20 min ...
        //     2 h), so a fault at this end does not walk through every hole of every NVR a tick apart.
        //     Footage that gets into the index starts the camera's count and the NVR's again (fill()).
        // All from now, when it threw, not from when the tick began: a pull takes minutes. A back-off
        // fill() had already set is never shortened. Then the tick fails as any other.
        const threwAt = this.now()
        const cam = `${row.nvr}/${row.ch}`
        const holeThrows = (this.pullThrows.get(row.id) ?? 0) + 1
        const camThrows = (this.camThrows.get(cam) ?? 0) + 1
        const nvrThrows = (this.nvrThrows.get(row.nvr) ?? 0) + 1
        this.pullThrows.set(row.id, holeThrows)
        this.pullThrowAt.set(row.id, threwAt)
        this.camThrows.set(cam, camThrows)
        this.camThrowAt.set(cam, threwAt)
        this.nvrThrows.set(row.nvr, nvrThrows)
        const holeUntil = Math.max(this.nextTry.get(row.id) ?? 0, threwAt + backoffMs((row.attempts ?? 0) + holeThrows, ERROR_BACKOFF_MS))
        const camUntil = threwAt + backoffMs(camThrows, ERROR_BACKOFF_MS)
        const nvrUntil = Math.max(this.nvrBackoff.get(row.nvr) ?? 0, threwAt + backoffMs(nvrThrows, ERROR_BACKOFF_MS))
        this.nextTry.set(row.id, holeUntil)
        this.camBackoff.set(cam, camUntil)
        this.nvrBackoff.set(row.nvr, nvrUntil)
        // (for #tickFailed: which hole, and how long it, by its own wait or its camera's, and its NVR are in fact left alone)
        this.thrownPull = { error: e, hole: `${row.nvr}/${row.ch + 1}`, nvr: row.nvr, holeThrows, holeWaitMs: Math.max(holeUntil, camUntil) - threwAt, nvrWaitMs: nvrUntil - threwAt }
        throw e
      }
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
    // A failed try backs off the ROW (nextTry, on its ladder); the job itself only rests (restMs, a
    // tick by default) and then picks again, which passes over this row and takes the next deadline.
    // Returning the row's back-off as the job's rest woke the job just as that back-off ran out, and
    // the same row -- stuck, so the oldest, so first in the pick -- was pulled again: one hole the NVR
    // had nothing for was all the job did for 8 h, pulled at 0, 5, 15, 35 ... 395 min (report 9).
    //   stop 'nvr': the NVR could not be asked, or broke off. It stands down for the same wait
    //               (nvrBackoff), so the short rest is not a new search or leg on it every tick.
    //   stop 'job': no other row would get past this either (no storage, a refusal); the job waits.
    const fail = (message, { ladder = ERROR_BACKOFF_MS, stop = 'row', restMs = this.tickMs } = {}) => {
      const attempts = (row.attempts ?? 0) + 1
      const wait = backoffMs(attempts, ladder)
      // (the back-off before the ledger: if that write throws, the wait this try earned still stands)
      this.nextTry.set(row.id, this.now() + wait)
      if (stop === 'nvr') this.nvrBackoff.set(row.nvr, this.now() + wait)
      this.index.backfillSet(row.id, { attempts, lastTryMs: now, lastError: message })
      this.last = { ...this.last, at: now, what: message, errors: this.last.errors + 1 }
      return stop === 'job' ? wait : restMs
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
    const missingMs = totalMs(holes.map((h) => [h.fromMs, h.toMs]))

    // 2. What does the NVR say it has? A failure to ask is not an answer (rule 2 at the top).
    let cov
    try {
      cov = await this.coverage(nvr, row.ch, row.fromMs, row.toMs, { now: () => this.now() })
    } catch (e) {
      return fail(`the NVR search failed (${e?.message ?? e})`, { stop: 'nvr' })
    }
    const plan = gapPlan({ fromMs: row.fromMs, toMs: row.toMs }, { now, nvrRetentionMs: this.retentionMs(), coverage: cov })
    if (plan.permanent) {
      this.index.backfillSet(row.id, { state: 'permanent', note: plan.permanentReason, lastTryMs: now })
      this.log(`${row.nvr}/${row.ch + 1} ${new Date(row.fromMs).toISOString()}: permanent (${plan.permanentReason})`)
      return 0
    }
    if (!plan.decided) {
      // "we could not ask" - a refusal-shaped answer waits much longer than an ordinary hiccup, and
      // holds the whole job as a refusal from a leg does; an ordinary one stands down only that NVR
      const refused = /refus|busy|offline/i.test(String(plan.why ?? ''))
      return fail(plan.why ?? 'the NVR gave no answer', refused ? { ladder: REFUSED_BACKOFF_MS, stop: 'job' } : { stop: 'nvr' })
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
    if (!loc) return fail('no storage location available', { stop: 'job' })

    // 4. One piece per turn. Anything can have changed by the next one, so it is checked again.
    this.busyNvrs.add(row.nvr)
    const started = this.now()
    let result
    try {
      result = await this.pull({ nvr, row, loc, fromMs: work[0][0], toMs: work[0][1], skewMs: cov.skewMs ?? 0 })
    } catch (e) {
      this.busyNvrs.delete(row.nvr)
      // a throw here is this end (the writer, the disk), not the row or the NVR: the job waits
      return fail(`the pull failed (${e?.message ?? e})`, { stop: 'job' })
    }
    this.busyNvrs.delete(row.nvr)
    const elapsed = this.now() - started
    // The rest after a pull that got nowhere: it still used the NVR, so the rate limit holds, and it
    // is never shorter than a tick.
    const rested = Math.max(this.tickMs, restAfterMs(result.bytes ?? 0, elapsed, Number(cfg.perNvrMbps ?? 8), Number(cfg.restSeconds ?? 30)))

    if (result.refused) {
      // The NVR turned us away. This is nvr-2's normal state, and the only right answer is to stop
      // and come back much later: asking again now is exactly what would hurt live recording.
      const attempts = (row.attempts ?? 0) + 1
      const wait = backoffMs(attempts, REFUSED_BACKOFF_MS)
      this.nextTry.set(row.id, this.now() + wait)
      // the whole NVR stands down, not only this camera: it is the NVR that has no capacity left
      this.nvrBackoff.set(row.nvr, this.now() + wait)
      // (the ledger last, as in fail(): a refusal's long wait must stand also when that write throws)
      this.index.backfillSet(row.id, { attempts, lastTryMs: now, lastError: result.message })
      this.log(`${row.nvr} refused (${result.message}); leaving it alone for ${Math.round(wait / 60_000)} min`)
      return wait
    }
    if (!result.segments.length) {
      // A leg that played to its end with nothing usable is about this stretch (row 2658: the NVR has
      // nothing inside the hole, and the floor drops what it plays from before it). One that broke off
      // or ran out of time is about the NVR, which stands down rather than get a new leg every tick.
      return fail(result.message ?? 'the NVR sent no usable video', { stop: result.brokeOff ? 'nvr' : 'row', restMs: rested })
    }

    // 5. Index what landed, marked as backfilled so an export can say where it came from. Also when
    //    it turns out not to be progress (below): the files are on disk, and a file the index does not
    //    know is one housekeeping never deletes.
    const filledAt = this.now()
    for (const s of result.segments) {
      this.index.addSegment({ nvr: row.nvr, ch: row.ch, path: s.path, startMs: s.startMs, endMs: s.endMs, bytes: s.bytes, keyframes: s.keyframes, loc: loc.id, source: `backfill:${row.nvr}`, filledMs: filledAt })
    }
    // Footage of this camera, from this NVR, is in the index: whatever made fills throw (tick()
    // counts them: it rests the NVR and the camera longer for each in a row, and puts the camera's
    // holes after the others) is not this end as a whole, nor this camera. Here, once every segment
    // of the pull is in, and nowhere else: a fill() that returns without having indexed anything
    // (the NVR played nothing, the search failed) says nothing about that, and cleared the NVR's
    // count each time, so the NVR was pulled every five minutes for as long as the fault lasted.
    // (Also when what follows counts the try as failed, the hole less than a second shorter: what is
    // known by then is that this end can index footage of this camera.)
    const cam = `${row.nvr}/${row.ch}`
    this.nvrThrows.delete(row.nvr)
    this.camThrows.delete(cam)
    this.camThrowAt.delete(cam)
    this.camBackoff.delete(cam)
    const left = this.holesOf(row.nvr, row.ch, row.fromMs, row.toMs)
    const ms = result.segments.reduce((n, s) => n + (s.endMs - s.startMs), 0)
    // Progress is a hole that got shorter, not a file written: a pull whose footage all lies outside
    // the hole is a failed try, with the back-off that comes with one. Counting it as progress cleared
    // the retry wait, and the same row was pulled again on the next tick.
    if (left.length && missingMs - totalMs(left.map((h) => [h.fromMs, h.toMs])) < MIN_PROGRESS_MS) {
      const rest = fail(`pulled ${Math.round(ms / 1000)} s from the NVR, but the hole got less than a second shorter`, { restMs: rested })
      this.log(`${row.nvr}/${row.ch + 1}: ${this.last.what}; next try of this hole in ${Math.round((this.nextTry.get(row.id) - this.now()) / 60_000)} min`)
      return rest
    }
    this.index.backfillSet(row.id, left.length ? { attempts: row.attempts ?? 0, lastTryMs: now, lastError: null, note: `partly filled, ${left.length} piece(s) left` } : { state: 'filled', filledMs: filledAt, lastError: null, note: null })
    this.nextTry.delete(row.id)
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
      // floorMs: the NVR starts a playback at the file holding fromMs, often minutes before the hole,
      // and without a floor the leg kept those frames: copies of footage already on disk (108 of 293
      // backfilled segments), written again on every pull of the row
      leg = this.leg({ nvr, ch: row.ch, fromMs, toMs, skewMs, real: sink, gen: null, at: fromMs, floorMs: fromMs - 1 })
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
    // brokeOff: the leg errored or ran out of time, as against playing to its end
    const brokeOff = done.reason === 'error' || done.reason === 'timeout'
    return { segments, bytes: sink.stats.bytes, frames: sink.stats.frames, refused, brokeOff, message: segments.length ? null : (message ?? 'the NVR sent no video') }
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
      state: { ...this.last, failsInARow: this.failsInARow, lastFailure: this.lastFailure, busyNvrs: [...this.busyNvrs], mayRun: mayRun({ now, cfg, running: this.running, exportsBusy: this.exportsBusy(), recordingBusy: this.recordingBusy() }) },
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
