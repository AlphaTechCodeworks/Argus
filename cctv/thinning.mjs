// The two jobs that remove footage: time-lapse thinning and retention.
//
//   runThinning({ index, ... })   after a camera's `fullDays`, rewrite its segments keeping one
//                                 keyframe per `timelapseS` (mode 'timelapse' only)
//   runRetention({ index, ... })  delete whole segments past the camera's retentionDays, and,
//                                 while a location is below the free-space floor, its oldest
//                                 footage first
//   recoverThinning(roots, opts)  finish or undo a rewrite that a crash caught half-done
//
// BOTH DEFAULT TO DRY RUN. Nothing here deletes or rewrites anything unless the caller passes
// dryRun: false, and in dry run the result lists exactly what it would have done. This code is
// the only thing in the system that can destroy footage that is still inside its retention, so
// the safe answer is the default one.
//
// Safeguards, all of them tested:
//  - a file is only touched when it is inside its location's folder (resolve + prefix check) and
//    that location's marker is present: an unplugged drive is an empty folder on the system disk,
//    and nothing there may be taken for the drive's;
//  - bookmarked and exported stretches are never touched (bookmarks.mjs protectedRanges, imported
//    defensively — see below);
//  - the rewrite is journalled: original footage is still on disk, intact, at every instant, and
//    a crash at any point rolls back to it (see the swap below);
//  - the new file is parsed and checked before the old one is moved aside, so a rewrite that
//    produced rubbish never replaces anything.
//
// The bookmarks module is being built alongside this one. It is imported at run time and
// feature-detected: no module, no export, we skip nothing and carry on. If it is there but
// throws, the run STOPS instead, because then we do not know what is protected and guessing
// would delete evidence.
//
// Off the main thread since 2026-09-29 (perf report R1 / Task 4 and its check verify-1). runThinning
// read, parsed and rewrote every candidate synchronously in the server, dry run too: about 0.31 s a 12
// MB file over SMB, up to 2,000 files a run, so ~10 minutes of frozen live video, pages and alarms in
// every 5, and the outside watcher would have remounted the share and restarted the service up to 3
// times an hour. And it never got past each camera's oldest 500 files: a rewritten file kept its place
// among the oldest, and every run read all of them again. Now:
//  - the dry run is worked out from the index alone (files, bytes, and an estimate of the time-lapse
//    left, labelled as one): no file is opened, whatever the switch;
//  - a real rewrite is the share helper's (share-ops.mjs thin, thinSwap, thinCommit, in a process of
//    its own), three files at a time at a set pace (thin-pace.mjs), nights first; the main thread
//    decides, checks each file again just before its swap, and updates the index row;
//  - each row says whether it was rewritten (rec-index.mjs THIN), and the walk reads only rows still
//    full video, so a file is never read twice and each run goes on where the last stopped;
//  - a rewrite in flight is in the index (thin_inflight) until its commit: a helper killed, a share
//    that hangs or a server that stops is put right by the helper's thinRecover (the journal rolls it
//    back), at once or at the next run, before anything else touches that file.
import { readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { floorTargetPct, freeMarks } from './location-health.mjs'
import { THIN } from './rec-index.mjs'
import { afterStretch, checkFreeRose, firstUnprotected, freeingStalled, makeDeleter, makePacer } from './segment-delete.mjs'
import { shareCall } from './share-calls.mjs'
import { siteMinutesOfDay } from './site-time.mjs'
import { markerPresent } from './storage-report.mjs'
import { RUN_MS, SLOW_HOLD_MS, STRAIN_HOLD_MS, achievedMBps, backoffText, decideRun, describePaceNow, effectiveMbps, lastDiskTooSlow, lastStrain, makeBucket, noteRound, paceFactor, recorderReports, settleRound, thinPace, usePaceFile } from './thin-pace.mjs'
import { THIN_SUFFIX as suffix, planThin, thinNames as names } from './thin-file.mjs'

// planThin, buildThinned and the check of a rewrite are in thin-file.mjs since 2026-09-29, so that the
// share helper can load them without the server's modules; planThin is still exported from here
export { planThin }

// settings.mjs (and storage.mjs) reach sdk.mjs -> koffi through nvr-xml.mjs, and this module has
// to be testable on a laptop with no SDK, so the settings are loaded at run time only when the
// caller did not hand them over (the jobs always run inside the server, which has them already).
const currentSettings = async () => (await import('./settings.mjs')).getSettings()

const DAY = 86_400_000
/** The most files one run of either job takes on; the next run, 5 minutes later, goes on. */
export const MAX_SEGMENTS_PER_RUN = 2000
const BATCH = 500
/** A segment bigger than this is not rewritten in one buffer. One minute of 4K is far under it. */
export const MAX_SEGMENT_BYTES = 512 * 1024 * 1024
// (PROTECT_MARGIN_MS, a minute more around every stretch, went on 2026-09-30: bookmarks.mjs protectedRanges
// already grows each bookmark by a minute either side, and with both a bookmark kept two. Whole files that
// touch a stretch are kept, so the keyframe before a bookmark is kept with the file that has it.)

const camRec = (settings, nvr, ch) => ({ ...settings.recording.defaults, ...(settings.recording.cameras?.[`${nvr}/${ch}`] ?? {}) })
const pct = (f) => (f.totalBytes > 0 ? (f.freeBytes / f.totalBytes) * 100 : 100)

// ---- protected stretches -------------------------------------------------------------------

/**
 * bookmarks.mjs protectedRanges(fromMs, toMs) -> [[fromMs, toMs], ...], or null when the module
 * or the export is not there yet. Never throws: a missing module is a normal state today.
 */
export async function loadProtectedRanges() {
  try {
    const m = await import('./bookmarks.mjs')
    return typeof m?.protectedRanges === 'function' ? m.protectedRanges : null
  } catch {
    return null
  }
}

/**
 * Normalises whatever protectedRanges answers into { span: [from, to], cameras: string[]|null } (null:
 * every camera). A stretch is [from, to] (every camera), [from, to, camera] (bookmarks.mjs since
 * 2026-09-30: a camera key, or null for every camera), [from, to, [cameras]], or an object with
 * fromMs/toMs and `camera` or `cameras`; no camera, or an empty list, is every camera. The stretch is
 * taken as it is: bookmarks.mjs has grown it by its minute either side already. Unparseable -> throws.
 */
function normaliseRanges(raw) {
  const out = []
  const bad = (r) => new Error(`protectedRanges gave a range we cannot read: ${JSON.stringify(r)}`)
  for (const r of raw ?? []) {
    const from = Array.isArray(r) ? r[0] : r?.fromMs ?? r?.startMs ?? r?.from
    const to = Array.isArray(r) ? r[1] : r?.toMs ?? r?.endMs ?? r?.to
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw bad(r)
    const which = Array.isArray(r) ? r[2] : r?.camera ?? r?.cameras
    let cameras = null
    if (typeof which === 'string') cameras = [which]
    else if (Array.isArray(which) && which.length) cameras = which
    else if (which !== undefined && which !== null && !(Array.isArray(which) && which.length === 0)) throw bad(r)
    if (cameras && !cameras.every((k) => typeof k === 'string' && k.includes('/'))) throw bad(r)
    out.push({ span: [Math.min(from, to), Math.max(from, to)], cameras })
  }
  return out
}

/** The ranges oldest first, those that overlap or touch made one. */
function mergeRanges(ranges) {
  const out = []
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1)
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** The first of these merged stretches the segment overlaps, or null: looked up by halving. */
function overlapIn(ranges, s) {
  const from = s.startMs
  const to = s.endMs ?? s.startMs
  // the first stretch that ends at or after the segment's start; the segment overlaps it if it
  // starts no later than the segment ends (every later stretch starts later still)
  let lo = 0
  let hi = ranges.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ranges[mid][1] < from) lo = mid + 1
    else hi = mid
  }
  return lo < ranges.length && ranges[lo][0] <= to ? ranges[lo] : null
}

/** A row's camera, as bookmarks name it ("<nvr>/<channel>", rec-index.mjs camKey); null for a row that names none. */
const cameraOf = (s) => (s?.nvr === undefined || s?.nvr === null || s?.ch === undefined || s?.ch === null ? null : `${s.nvr}/${Number(s.ch)}`)

/**
 * A guard object for one run: .protected(seg) says whether a segment must be left alone.
 * `mode` is 'none' (no bookmarks module yet) or 'ranges'. A run's `protection` can also be
 * 'unread': asking threw, and the run stopped before any file (the two catches below).
 * housekeeping.mjs asks through this too since 2026-09-29.
 *
 * A bookmark keeps the cameras it names (since 2026-09-30, final fix round of the storage work). The
 * guard took every stretch for every camera: production bookmarks every line crossing on one camera
 * (Maingate Roadway), so each crossing kept about 7 minutes of all 87 cameras, about 7 GB, for good,
 * and the 12,000 GB limit deleted other cameras' newer footage instead; once only such footage was left
 * the limit and the floor could free nothing, and the shared NAS would fill. Now a segment is protected
 * by the stretches of its own camera, and by the common ones: stretches that name no camera (a
 * bookmark whose cameras cannot be read, or a caller's plain [from, to]), which keep every camera.
 *
 * .stretchOf(seg) is the protected stretch [from, to] of the segment's camera (its own and the common
 * ones, merged) that it overlaps, or null. The deletion jobs use it to step over a stretch in one look:
 * every row of THAT CAMERA that starts inside it is in it, so none of them needs reading (housekeeping's
 * CameraCursors.skipTo, runRetention's per-camera walk). Passing them one by one on the main thread was
 * 120-136 ms for a 2-hour bookmark on the production VM, and about 1.5 s for a 24-hour one, every run,
 * since bookmarked footage is never deleted and so stays the oldest (review of p2-delete, 2026-09-29).
 * .commonOf(seg) is the common stretch it overlaps, or null: only those may be stepped over by a walk of
 * every camera's rows at once (segment-delete.mjs firstUnprotected, runRetention's floor, thinning's walk).
 * The ranges are merged and looked up by halving, not one by one.
 */
export async function protectionFor(fromMs, toMs, { protectedRanges } = {}) {
  const fn = protectedRanges === undefined ? await loadProtectedRanges() : protectedRanges
  if (typeof fn !== 'function') return { mode: 'none', common: [], cameras: [], listOf: () => [], ownOf: () => [], protected: () => false, stretchOf: () => null, commonOf: () => null }
  // A throw here is fatal for the run: we cannot tell bookmarked footage from the rest, and the
  // only safe thing to do with footage you cannot identify is nothing.
  const all = normaliseRanges(await fn(fromMs, toMs))
  const common = mergeRanges(all.filter((x) => !x.cameras).map((x) => x.span))
  const own = new Map() // camera -> its own stretches, as given
  for (const x of all) {
    for (const k of x.cameras ?? []) {
      if (!own.has(k)) own.set(k, [])
      own.get(k).push(x.span)
    }
  }
  const any = mergeRanges(all.map((x) => x.span)) // every stretch, whatever its camera
  const lists = new Map() // camera -> its own merged with the common ones, made when first asked
  /** A camera's stretches (its own and the common ones, merged), oldest first; null: every stretch of any camera. */
  const listOf = (k) => {
    if (k === null) return any // a row that names no camera: kept by any stretch, as every row was before
    if (!own.has(k)) return common
    if (!lists.has(k)) lists.set(k, mergeRanges([...common, ...own.get(k)]))
    return lists.get(k)
  }
  const stretchOf = (s) => overlapIn(listOf(cameraOf(s)), s)
  return {
    mode: 'ranges',
    common,
    /** The cameras with stretches of their own. */
    cameras: [...own.keys()],
    listOf,
    /** A camera's own stretches alone, merged (for saying which were passed). */
    ownOf: (k) => mergeRanges(own.get(k) ?? []),
    protected: (s) => stretchOf(s) !== null,
    stretchOf,
    commonOf: (s) => overlapIn(common, s)
  }
}

// ---- the safety net around every file operation ---------------------------------------------

/**
 * Whether we may touch this segment's files at all: its location is known, its marker is there,
 * and the file really is inside that folder.
 * @returns {{ ok: boolean, why: string, root: string|null }}
 */
export function mayTouch(seg, locs, here) {
  const loc = locs.get(seg.loc)
  if (!loc) return { ok: false, why: `unknown location ${seg.loc}`, root: null }
  if (!here.has(loc.id)) return { ok: false, why: `${loc.path} is not mounted`, root: null }
  const root = resolve(loc.path)
  const p = resolve(seg.path)
  if (!p.startsWith(root + sep)) return { ok: false, why: `${seg.path} is outside ${loc.path}`, root: null }
  return { ok: true, why: '', root }
}

/** Locations whose marker is present right now. */
function mountedSet(locs, present, warn) {
  const here = new Set()
  for (const l of locs.values()) {
    let ok = false
    try {
      ok = present(l)
    } catch {}
    if (ok) here.add(l.id)
    else warn(`${l.path}: skipped (its marker is missing or belongs to another drive: not mounted?)`)
  }
  return here
}

// ---- the journalled swap ----------------------------------------------------------------------
/*
 * A rewrite takes the original's place so that a crash at ANY instant leaves either the whole
 * original or the whole new pair on disk, never a mixture and never nothing:
 *
 *   0. the rewrite is in flight in the index (thin_inflight: the file as it was)   main thread
 *   1. the new pair written beside it (.thin-new), fsynced, read back, checked     helper: thin
 *      -- the main thread checks again: the switch, the bookmarks, the row --
 *   2. journal written + fsynced          <- from here on, a crash means "roll back"
 *   3. seg -> seg.thin-old, idx -> idx.thin-old; seg.thin-new -> seg, idx.thin-new -> idx
 *                                                                                  helper: thinSwap
 *   4. the index row is updated (time-lapse, the new size; thin_inflight too)      main thread
 *   5. journal deleted                    <- the commit point
 *   6. the .thin-old pair is deleted                                               helper: thinCommit
 *   7. no longer in flight                                                         main thread
 *
 * Until 2026-09-29 the same steps ran synchronously on the main thread (swapIn). Now any failure
 * or lost helper between 1 and 6 is put right by the helper's thinRecover (share-ops.mjs), which
 * rolls back whenever it finds the journal and sweeps up stray .thin-old / .thin-new files when it
 * does not, as recoverThinning() below does; the row is then made to match the file on disk (the
 * original's size and keyframes from step 0, or the rewrite's from step 4).
 */

const unlinkQuiet = (f) => {
  try {
    unlinkSync(f)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}

/**
 * Undoes or sweeps up after an interrupted rewrite under `root`, walking the whole folder with
 * synchronous calls: a tool for a drive looked at by hand, NEVER for the server on a share (a stale
 * share hangs the caller). The server puts its own rewrites right through the share helper
 * (share-ops.mjs thinRecover, from thin_inflight: runThinning), by the same rules.
 * @returns {{ rolledBack: string[], sweptUp: string[] }}
 */
export function recoverThinning(roots, { dryRun = false } = {}) {
  const out = { rolledBack: [], sweptUp: [] }
  const seen = new Set()
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
        continue
      }
      for (const [, s] of Object.entries(suffix)) {
        if (!e.name.endsWith(s)) continue
        const base = full.slice(0, full.length - s.length).replace(/\.idx$/, '')
        if (!seen.has(base)) seen.add(base)
      }
    }
  }
  for (const r of roots ?? []) {
    try {
      if (statSync(r).isDirectory()) walk(r)
    } catch {}
  }
  for (const p of seen) {
    const n = names(p)
    let hasJournal = false
    try {
      statSync(n.journal)
      hasJournal = true
    } catch {}
    if (hasJournal) {
      // The rewrite did not reach its commit point: put the original back, whichever half of the
      // swap had happened, and throw the half-made new pair away.
      out.rolledBack.push(p)
      if (dryRun) continue
      for (const [from, to] of [
        [n.oldSeg, n.seg],
        [n.oldIdx, n.idx]
      ]) {
        try {
          statSync(from)
          renameSync(from, to)
        } catch {}
      }
      unlinkQuiet(n.newSeg)
      unlinkQuiet(n.newIdx)
      unlinkQuiet(n.journal)
    } else {
      // No journal: either nothing had started or the swap committed. Either way the pair on
      // disk is the good one and these leftovers are litter.
      out.sweptUp.push(p)
      if (dryRun) continue
      for (const f of [n.oldSeg, n.oldIdx, n.newSeg, n.newIdx]) unlinkQuiet(f)
    }
  }
  return out
}

// ---- the thinning job ---------------------------------------------------------------------------

/**
 * The dry run's estimate of the time-lapse a rewrite leaves, and so of what it frees. From the index
 * alone: each file's bytes weighted by the share of its keyframes one per timelapseS keeps
 * (rec-index.mjs THIN_SQL.fullSummary), times the share of a file's bytes that its keyframes are. That
 * last share is in neither the index nor the .idx (which says where a keyframe starts, not how long it
 * is), so it comes from the audit's real files (29 Sep 2026, production VM): 13 files read from the NAS,
 * the time-lapse copy 8.7 % (R1, 5 files) and 11.1 % (verify-1, 8 files) of the originals with about 6
 * of each file's 30 keyframes kept, so keyframes are 43-56 % of a file's bytes (2.8-16 % per file kept:
 * one file alone can be far off, a day of them is not). Measured directly on 21 more (review of p3-thin
 * round 2, 30 Sep 2026: files of 26 Sep read into /tmp on the VM, every keyframe's bytes counted): 50.0 %
 * of their bytes (H.265 51.9 %, H.264 45.6 %; 11-100 % per file), the time-lapse 10.4 %: the middle figure
 * holds. An estimate, and the page and the log say so; the real runs report what they really freed.
 */
export const KEYFRAME_SHARE = Object.freeze({ low: 0.43, mid: 0.5, high: 0.56 })
/** Rows asked of the index at a time by the real run's walk (every camera's, oldest first). */
const LOOK = 100
/**
 * The most full-video rows, of any camera, one statement of the walks and sums below may pass: each looks
 * at one window of time, which ends where the WINDOW_ROWS-th row from its start begins (rec-index.mjs
 * THIN_SQL.fullNth), and the event loop goes round between windows. A camera not set to time-lapse, or
 * with more full-video days than the others, keeps its full video in segments_full past their cutoff,
 * and a statement asked for their rows passed all of it: 251-260 ms at a stretch on the development PC
 * for 20 cameras of 87 set to 'delete' on a 31-day index, dry run included (review of p3-thin,
 * 2026-09-29). By rows, not by time: a window of 5,000 is about an hour of the site's 87 cameras, however
 * the footage is spread; on the development PC 1-3 ms to pass, 7-15 ms to sum when all of it is the
 * group's (the production VM passes rows about twice as fast: the review's 0.19 against 0.41 us a row).
 * Test: thinning.test.mjs, 20 of 87 cameras set to 'delete' on a 31-day index.
 * What a whole dry run (or an On round's backlog) costs is every waiting row summed: about 1.8 us of main
 * thread a row on the development PC, so 230 ms for one day of the 87 cameras (125,280 rows) and 3.3 s at 14
 * days, in stretches of 19-28 ms (a window summed plus the pacer's 10 ms); about half that on the VM, some
 * 120 ms a day waiting (review of p3-thin, round 2, 2026-09-30, and scratchpad p3fix2/dry-cost.mjs: p3-thin's
 * "40 ms a day, in <= 10 ms slices" was wrong). Nothing waits at today's settings; with fullDays under the
 * ~8 days the space limit keeps, one or two days. Weeks of it only with far more space and Dry run kept on
 * for weeks: then a cache of each day's sums (kept right through every writer of the index) is the fix.
 */
const WINDOW_ROWS = 5000
/** Files noted in flight (thin_inflight) with the one about to go: the next ones read, in the same transaction. */
const NOTE_AHEAD = 5
/** Footage waiting longer than this past its full-video days is "falling behind": a warning, on the page too. */
export const BEHIND_MS = DAY
/**
 * A rewrite the helper answered "skipped" for, that no later run could do otherwise: the row is marked THIN.kept.
 * (ENOENT: the helper reads the marker again before it says so, and a share unmounted meanwhile is EMARKER,
 * which leaves the row as it was: review of p3-thin, 2026-09-29.)
 */
const LEFT_AS_IT_IS = /^(already thin|nothing to keep|no index rows|cannot be parsed|larger than)|ENOENT/

const gbs = (b) => `${(b / 1e9).toFixed(1)} GB`
const utc = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
const hoursText = (ms) => `${(ms / 3_600_000).toFixed(1)} h`

// Across runs, in memory: each camera's last kept keyframe, so the time-lapse spacing carries from one
// file to the next as it did within one synchronous run (a restart costs at most one extra keyframe a
// camera), and when the log last said the job was falling behind.
const lastKept = new Map() // "nvr/ch" -> { endMs, cursor }
let behindSaidAt = -Infinity
let paceSaid = ''
let backoffSaid = ''

/**
 * Windows of segments_full for the walks and sums (WINDOW_ROWS above): nth(from, n) is where the n-th
 * full-video row from `from` starts, any camera (an index without it -- a test's -- is one window);
 * end(from, to) is the end of the window that starts at `from`, a row's start.
 */
function windowsOf(index) {
  const nth = (from, n) => (typeof index.fullNth === 'function' ? index.fullNth(from, n) : n === 0 ? from : null)
  const end = (from, to) => {
    const e = nth(from, WINDOW_ROWS)
    // (more than WINDOW_ROWS rows starting in one millisecond, never written on purpose: that one is passed whole)
    return e === null || e >= to ? to : e > from ? e : from + 1
  }
  return { nth, end }
}

/**
 * A group's full-video rows past its cutoff (the cameras with one cutoff and interval: usually all of
 * them), oldest first across the cameras, read LOOK at a time from segments_full (rewritten rows are not
 * in it), a window at a time (WINDOW_ROWS). take() gives the oldest row of a camera not busy, so each
 * camera's files go in their order.
 */
class FullStream {
  constructor(index, group, tick) {
    this.index = index
    this.g = group
    this.tick = tick
    this.win = windowsOf(index)
    this.buf = [] // rows read and not taken yet, oldest first
    this.from = Number.MIN_SAFE_INTEGER // where the next look starts
    this.atFrom = new Set() // rows already read that start exactly there
    this.done = false
    this.past = new Map() // camera -> the end of its own bookmarked stretch the walk is in (skipCam)
  }
  /** Reads the next rows (at most LOOK), a window at a time, the loop let go round between windows; false when there are none. */
  async more() {
    while (!this.done) {
      // over time with no full video at all in one look, then one window from there
      const first = this.win.nth(this.from, 0)
      if (first === null || first >= this.g.cutoff) break
      if (first > this.from) {
        this.from = first
        this.atFrom = new Set()
      }
      const end = this.win.end(this.from, this.g.cutoff)
      const raw = this.index.fullOlderThan(this.g.cams, this.g.cutoff, LOOK, this.from, end)
      const rows = raw.filter((r) => !(r.startMs === this.from && this.atFrom.has(r.path)))
      if (rows.length) {
        for (const r of rows) {
          if (r.startMs !== this.from) this.atFrom = new Set()
          this.from = r.startMs
          this.atFrom.add(r.path)
          // (a row of a camera inside its own bookmarked stretch: skipCam)
          if (r.startMs < (this.past.get(`${r.nvr}/${r.ch}`) ?? -Infinity)) continue
          this.buf.push(r)
        }
        return true
      }
      // (a full look made only of rows read before at one start -- more than LOOK files starting in the same
      // millisecond, never written on purpose -- ends the walk: it only ever converts less)
      if (raw.length >= LOOK) break
      // none of these cameras' in this window: the next one
      this.from = end
      this.atFrom = new Set()
      await this.tick()
    }
    this.done = true
    return false
  }
  /** The oldest row read of a camera not in `busy`, reading on while the rows read are all busy ones. */
  async first(busy) {
    for (;;) {
      const r = this.buf.find((x) => !busy.has(`${x.nvr}/${x.ch}`))
      if (r) return r
      // as many rows read as three looks and every one of a busy camera: wait for one to be free
      if (this.buf.length >= 3 * LOOK || !(await this.more())) return null
      await this.tick() // (the rows read may all have been a camera's own bookmarked stretch: skipCam)
    }
  }
  take(r) {
    this.buf.splice(this.buf.indexOf(r), 1)
  }
  /**
   * Past a common bookmarked stretch [a, ms) (one that keeps every camera: thinning.mjs protectionFor's
   * commonOf): the rows read that start in it go, and the next look starts after it (the stretch holds the
   * row just taken, so every row not read yet starts in or after it). Rows read that start before it stay.
   */
  skipTo(a, ms) {
    this.buf = this.buf.filter((x) => x.startMs < a || x.startMs >= ms)
    if (ms > this.from) {
      this.from = ms
      this.atFrom = new Set()
    }
  }
  /**
   * Past one camera's own bookmarked stretch [a, ms) (since 2026-09-30 a bookmark keeps the cameras it names):
   * that camera's rows read that start in it go, and its rows read later that start before ms are passed as
   * they are read (every row not read yet starts at or after the row just taken, so in or after the stretch).
   * The other cameras' rows of that time are not its bookmark's: the walk reads on through them.
   */
  skipCam(key, a, ms) {
    this.buf = this.buf.filter((x) => `${x.nvr}/${x.ch}` !== key || x.startMs < a || x.startMs >= ms)
    this.past.set(key, Math.max(this.past.get(key) ?? -Infinity, ms))
  }
}

/**
 * Time-lapse thinning: for every camera set to `after: 'timelapse'`, rewrite its segments older
 * than `fullDays` so only one keyframe per `timelapseS` is left.
 *
 * Dry run (the default): what it would convert, from the index -- every such file on a mounted
 * location outside bookmarked stretches, not the first 2,000 -- with an estimate of what that frees
 * (KEYFRAME_SHARE). No file is opened and the share helper is not asked anything, but for one thing:
 * rewrites a run with the switch On left half done are put right first, in a dry run too.
 * On: those rewrites put right first; then, if thin-pace.mjs's rule
 * says this round works (nights; by day only to keep up; never within minutes of "disk too slow"),
 * the files go to their location's helper oldest first, `pace.atOnce` at a time (one per camera) at
 * `pace.mbps`, until `deadline` (RUN_MS into the storage round by default), `maxSegments`, the switch
 * leaving On, or "disk too slow" from the recorder.
 *
 * @param {{ index: object, settings?: object, now?: number, dryRun?: boolean,
 *           present?: (loc)=>boolean, protectedRanges?: function|null, maxSegments?: number,
 *           share?: Function, armed?: () => boolean, deadline?: number, pace?: object,
 *           siteMin?: (ms) => number, slow?: () => object|null, strain?: () => object|null,
 *           reports?: () => object[], paceFile?: string|null, clock?: () => number }} o
 *   now: the cutoffs are counted from it; clock: the time of day, the deadline and "disk too slow";
 *   slow / strain: the recorders' last "disk too slow" and writes seen waiting (thin-pace.mjs), reports: all
 *   of them kept; paceFile: where the pace's ceiling is kept (server.mjs: DATA_DIR/thin-pace.json)
 * @returns {Promise<{ dryRun, files, bytes, freedBytes, estimate, backlog, after, decision, stopped, pace,
 *                     recovered, left, thinned: {path, wasBytes, nowBytes, keptKeyframes, droppedKeyframes}[],
 *                     skipped: {path, why, files?}[], warnings: string[], protection: 'ranges'|'none'|'unread' }>}
 */
export async function runThinning({ index, settings = null, now = Date.now(), dryRun = true, present = markerPresent, protectedRanges, maxSegments = MAX_SEGMENTS_PER_RUN, share = shareCall, armed = null, deadline = null, pace = null, siteMin = siteMinutesOfDay, slow = lastDiskTooSlow, strain = lastStrain, reports = recorderReports, paceFile = null, clock = Date.now } = {}) {
  settings ??= await currentSettings()
  const out = { dryRun, files: 0, bytes: 0, freedBytes: 0, estimate: null, backlog: null, after: null, decision: null, stopped: null, pace: null, recovered: { rolledBack: 0, sweptUp: 0 }, left: [], thinned: [], skipped: [], warnings: [], protection: 'none' }
  if (!index) return out
  const warn = (w, { quiet = false } = {}) => {
    out.warnings.push(w)
    if (!quiet) console.warn(`[thinning] ${w}`)
  }
  pace ??= thinPace()
  // the pace's ceiling, learned from the rounds and kept in DATA_DIR (thin-pace.mjs; review of p3-thin, round 2):
  // read once, and said on the page in a dry run too, so an admin knows the pace before switching On
  if (paceFile) await usePaceFile(paceFile)
  out.pace = { mbps: pace.mbps, atOnce: pace.atOnce, night: pace.night, text: describePaceNow(pace), factor: paceFactor(pace), effectiveMbps: effectiveMbps(pace) }
  if (pace.warnings?.length) {
    // (said in the log once, on the page every run)
    const said = pace.warnings.join('; ')
    for (const w of pace.warnings) warn(w, { quiet: said === paceSaid })
    paceSaid = said
  }
  const locs = new Map((settings.storage?.locations ?? []).map((l) => [l.id, l]))
  const here = mountedSet(locs, present, warn)
  const tick = makePacer() // the event loop goes round every 10 ms of the walks here
  const win = windowsOf(index) // and no statement of theirs passes more than WINDOW_ROWS rows
  const stopLoc = new Map() // location id -> why nothing more is sent to its helper in this run
  const unsettled = new Set() // rewrites putRight could not settle (not known to be gone): they stay in flight
  const goneTimes = new Map() // location id -> its helper stopped by itself this many times in this run
  const stopLocation = (loc, why) => {
    if (stopLoc.has(loc.id)) return
    stopLoc.set(loc.id, why)
    warn(`${loc.path}: ${why}: nothing more converted on it this run`)
  }

  // Rewrites a run, a helper or the server did not finish: put right before anything else; housekeeping and
  // retention leave them alone meanwhile. In a dry run too since the review of p3-thin (2026-09-29): only On
  // did, so after a switch to Dry run the file stayed out of every deletion, a leftover beside it. Putting
  // right only finishes or undoes what a run with the switch On began -- the original put back, or a rewrite
  // never swapped in (or the original of one committed) swept up -- and never begins a rewrite. (With Off no
  // run happens: storage-jobs.mjs says they wait.)
  const inflight = typeof index.thinInflight === 'function' ? index.thinInflight() : []
  if (inflight.length) {
    await putRightLeftovers(inflight)
    const { rolledBack, sweptUp } = out.recovered
    if (rolledBack + sweptUp) warn(`put right ${rolledBack + sweptUp} time-lapse rewrite${rolledBack + sweptUp === 1 ? '' : 's'} left half done by an earlier run with the switch On (the server stopped, or the share hung): ${rolledBack} original${rolledBack === 1 ? '' : 's'} put back, ${sweptUp} with leftovers swept up`)
  }

  const cams = index.cameras()
  if (!cams.length) return out
  // Ask once for the whole window the run could touch, rather than per segment.
  let guard
  let rangesFn
  try {
    rangesFn = protectedRanges === undefined ? await loadProtectedRanges() : protectedRanges
    guard = await protectionFor(0, now, { protectedRanges: rangesFn })
  } catch (e) {
    warn(`bookmarks could not be read (${e.message}): nothing thinned this run`)
    // not 'none' ("nobody to ask, so nothing is protected"): the page said that too, in red, about
    // a run that touched nothing (review 2026-09-29)
    out.protection = 'unread'
    return out
  }
  out.protection = guard.mode

  // what waits, from the index: the dry run's answer, and the real run's backlog. The cameras go in groups
  // of one cutoff and interval (with no camera of its own days: one group, every camera).
  const groupsBy = new Map()
  for (const { nvr, ch } of cams) {
    const rec = camRec(settings, nvr, ch)
    if (rec.after !== 'timelapse') continue
    if (!Number.isFinite(rec.fullDays) || !Number.isFinite(rec.timelapseS) || !(rec.timelapseS > 0)) {
      warn(`${nvr}/${ch}: fullDays or timelapseS not set: skipped`)
      continue
    }
    const cutoff = now - rec.fullDays * DAY
    const k = `${cutoff}|${rec.timelapseS}`
    if (!groupsBy.has(k)) groupsBy.set(k, { cutoff, timelapseS: rec.timelapseS, cams: [], order: groupsBy.size })
    groupsBy.get(k).cams.push({ nvr, ch })
  }
  const groups = [...groupsBy.values()]
  const backlog = await backlogOf(groups)
  out.backlog = { files: backlog.files, bytes: backlog.bytes, oldestMs: backlog.oldestMs, lagMs: backlog.lagMs, perHourBytes: null }
  const est = (k) => Math.round(backlog.weighted * KEYFRAME_SHARE[k])
  if (dryRun) {
    out.files = backlog.files
    out.bytes = backlog.bytes
    out.estimate = {
      thinBytes: est('mid'),
      low: est('low'),
      high: est('high'),
      note: `an estimate from the index: keyframes taken as ${Math.round(KEYFRAME_SHARE.low * 100)}-${Math.round(KEYFRAME_SHARE.high * 100)} % of a file's bytes, as in 34 real files measured on 29 and 30 Sep 2026`
    }
    out.freedBytes = backlog.bytes - out.estimate.thinBytes
    return out
  }

  // ---- on: whether this round works (thin-pace.mjs), then the files, through the helper -------------
  // the round before this one, looked at now (thin-pace.mjs): a "disk too slow" in it lowers the pace; what it
  // converted counts towards the day rule's figure (review of p3-thin, 2026-09-29)
  // every report kept, and the last of each kind as this run was handed them (a test's own)
  const heard = reports()
  for (const x of [slow(), strain()]) if (x && !heard.some((y) => y.at === x.at && y.nvr === x.nvr && y.ch === x.ch)) heard.push(x)
  settleRound({ now: clock(), reports: heard, night: pace.night, siteMin, pace })
  out.pace.factor = paceFactor(pace)
  out.pace.effectiveMbps = effectiveMbps(pace)
  out.pace.achievedMBps = achievedMBps()
  out.pace.text = describePaceNow(pace)
  const lowered = backoffText(pace, siteMin, clock())
  // (in the log when it changes, on the page every run)
  if (lowered) warn(lowered, { quiet: lowered === backoffSaid })
  backoffSaid = lowered
  const defaults = settings.recording?.defaults ?? {}
  if (Number.isFinite(defaults.fullDays)) {
    // What arrives at the cutoff an hour: the full video of the 3 hours that pass it next. The 3 hours before
    // it were measured, and a job that keeps up has just rewritten those to about a tenth: the rate read low,
    // so the day rule waited for a night that could not clear what was coming, fell behind, and read the true
    // rate again from the hours it had not converted (audit of 2026-10-07). (Under 3 full-video hours: the
    // last 3 hours recorded.)
    const to = Math.min(now, now - defaults.fullDays * DAY + 3 * 3_600_000)
    out.backlog.perHourBytes = index.startedBetween(to - 3 * 3_600_000, to).bytes / 3
  }
  if (backlog.files > 0 && backlog.lagMs > BEHIND_MS) {
    const w = `FALLING BEHIND: ${backlog.files.toLocaleString('en-GB')} files (${gbs(backlog.bytes)}) of full video wait to be converted, the oldest ${hoursText(backlog.lagMs)} past its full-video days (at ${out.pace.text})`
    warn(w, { quiet: clock() - behindSaidAt < 3_600_000 })
    if (clock() - behindSaidAt >= 3_600_000) behindSaidAt = clock()
  }
  out.decision = decideRun({ now: clock(), backlogBytes: backlog.bytes, arrivalBytesPerHour: out.backlog.perHourBytes ?? 0, pace, siteMin, slow: slow(), strain: strain(), factor: out.pace.factor, achievedMBps: out.pace.achievedMBps })
  out.after = { files: backlog.files, bytes: backlog.bytes }
  if (!out.decision.work) {
    // a round held back by the recorders is a round that converted nothing (the day rule's figure) -- only when
    // it would otherwise have worked: by day, waiting for the night anyway, reports the NAS's other users caused
    // made the rule work by day, just when the NAS was under stress (review of p3-thin, round 2)
    if (out.decision.held && out.decision.wouldWork) noteRound({ start: clock(), end: clock(), held: true, mbps: out.pace.effectiveMbps })
    return out
  }

  const roundStart = clock()
  const until = deadline ?? roundStart + RUN_MS
  const bucket = makeBucket(out.pace.effectiveMbps * 1e6)
  // what the repair above could not put right (its share hung, or a person must look): not taken again
  const held = new Set(index.thinInflight().map((r) => r.path))
  const streams = groups.map((g) => new FullStream(index, g, tick))
  const busy = new Set() // "nvr/ch" of the cameras with a file being converted
  const running = new Set()
  // thin_inflight is written a few files ahead and cleared a few at a time (thinBegin, thinEnd): each commit
  // is WAL pages, and a checkpoint on the main thread every 1,000 of them. A file noted and not taken, or
  // done and not yet cleared, is harmless: putting it right finds nothing to do and its row as it is.
  const noted = new Set()
  let toEnd = []
  const keepInFlight = new Set() // could not be put right in this run: stays in thin_inflight
  const note = (rows) => {
    const fresh = rows.filter((r) => !noted.has(r.path))
    if (!fresh.length) return
    index.thinBegin(fresh.map((r) => ({ path: r.path, loc: r.loc, bytes: r.bytes, keyframes: r.keyframes })), clock())
    for (const r of fresh) noted.add(r.path)
    if (toEnd.length) endNoted()
  }
  const endNoted = () => {
    const list = toEnd
    toEnd = []
    index.thinEnd(list)
    for (const p of list) noted.delete(p)
  }
  let taken = 0
  const SWITCHED = 'the switch was set to Off or Dry run during this run'
  // why the round stopped, in a word: 'time', 'slow', 'strain' and 'locations' mean it ran out of time, not of
  // files, so what it converted says what the NAS can do (thin-pace.mjs noteRound)
  let stopKind = null
  const stopWhy = () => {
    if (out.stopped) return out.stopped
    const as = (kind, why) => ((stopKind = kind), why)
    if (clock() >= until) return as('time', `this round's ${RUN_MS / 60_000} minutes were up (the rest waits for the next round)`)
    if (taken >= maxSegments) return as('limit', `the most one run takes on (${maxSegments} files)`)
    if (armed && !armed()) return as('switch', SWITCHED)
    const sl = slow()
    const ago = sl ? clock() - sl.at : NaN
    if (ago >= 0 && ago < SLOW_HOLD_MS) return as('slow', `the recorder reported "disk too slow" at ${utc(sl.at)}${sl.nvr !== undefined ? ` (${sl.nvr}/${Number(sl.ch) + 1})` : ''}: no more files this round, so recording keeps the disk`)
    // the warning before a gap: a recorder's writes waiting half as long as makes one (thin-pace.mjs STRAIN_*)
    const st = strain()
    const since = st ? clock() - st.at : NaN
    if (since >= 0 && since < STRAIN_HOLD_MS) return as('strain', `the recorders' writes waited${Number.isFinite(st.ageMs) ? ` ${(st.ageMs / 1000).toFixed(1)} s` : ''} to be written at ${utc(st.at)}${st.nvr !== undefined ? ` (${st.nvr}/${Number(st.ch) + 1})` : ''}: no more files this round, so recording keeps the disk`)
    if (here.size && [...here].every((id) => stopLoc.has(id))) return as('locations', 'every location stopped (see the warnings)')
    return null
  }
  try {
    while (true) {
      const why = stopWhy()
      if (why) {
        out.stopped = why
        break
      }
      // the oldest waiting file (the furthest past its full-video days) of a camera not already being
      // converted: its time-lapse spacing carries from one file to the next
      await tick()
      let pick = null
      for (const st of streams) {
        const r = await st.first(busy)
        if (r && (!pick || st.g.cutoff - r.startMs > pick.st.g.cutoff - pick.s.startMs)) pick = { st, s: r }
      }
      if (!pick) {
        if (!running.size) break // nothing left
        await Promise.race(running)
        continue
      }
      const { st, s } = pick
      st.take(s)
      // a row starting inside its camera's bookmarked stretch: so does every row of that camera to the
      // stretch's end, and they are passed as they are read (skipCam); inside a common one (every camera's),
      // every camera's row to its end, in one look (skipTo). A file that starts before a stretch and runs
      // into it is passed by itself. Other cameras' rows of a camera's own stretch are not its bookmark's.
      const stretch = guard.stretchOf(s)
      if (stretch) {
        out.skipped.push({ path: s.path, why: 'bookmarked or exported' })
        if (s.startMs >= stretch[0]) st.skipCam(`${s.nvr}/${s.ch}`, stretch[0], afterStretch(stretch))
        const common = guard.commonOf(s)
        if (common && s.startMs >= common[0]) st.skipTo(common[0], afterStretch(common))
        continue
      }
      const may = mayTouch(s, locs, here)
      const loc = locs.get(s.loc)
      if (!may.ok || stopLoc.has(loc.id) || held.has(s.path)) {
        if (!may.ok) out.skipped.push({ path: s.path, why: may.why })
        else if (held.has(s.path)) out.skipped.push({ path: s.path, why: 'a rewrite of it was left half done and is not put right yet' })
        continue
      }
      while (running.size >= pace.atOnce) await Promise.race(running)
      await bucket.take(s.bytes)
      const late = stopWhy()
      if (late) {
        out.stopped = late
        break
      }
      // its location stopped meanwhile (another file's share hung, or its helper stopped twice): not sent to
      // it, where it would be one more call to a stuck share (review of p3-thin, 2026-09-29)
      if (stopLoc.has(loc.id) || held.has(s.path)) continue
      // in flight before the helper may make a file beside it: when it is not noted yet, it and the next few
      // read that could go, in one transaction (so one commit for every few files, not one each)
      try {
        if (!noted.has(s.path)) note([s, ...st.buf.filter((r) => mayTouch(r, locs, here).ok && !stopLoc.has(r.loc) && !held.has(r.path) && !guard.stretchOf(r)).slice(0, NOTE_AHEAD)])
      } catch (e) {
        warn(`${s.path}: not converted: the index could not note it (${e.message})`)
        out.stopped = `the index could not be written (${e.message})`
        break
      }
      taken++
      const key = `${s.nvr}/${s.ch}`
      busy.add(key)
      const job = one(st.g, key, s, loc)
        .catch((e) => warn(`${s.path}: ${e.message}`))
        .finally(() => {
          busy.delete(key)
          running.delete(job)
        })
      running.add(job)
    }
  } finally {
    await Promise.allSettled(running)
    // what was noted and not taken, and what is done, is no longer in flight; what could not be put right
    // stays, for the next run (and nothing deletes it meanwhile)
    const ending = new Set(toEnd)
    for (const p of noted) if (!keepInFlight.has(p)) ending.add(p)
    toEnd = [...ending]
    try {
      if (toEnd.length) endNoted()
    } catch (e) {
      warn(`the rewrites done could not be cleared from the index (${e.message}): the next run looks at them again (it finds nothing to put right)`)
    }
  }
  const wasBytes = out.thinned.reduce((a, t) => a + t.wasBytes, 0)
  out.files = out.thinned.length
  out.bytes = wasBytes
  out.after = { files: Math.max(0, backlog.files - out.files), bytes: Math.max(0, backlog.bytes - wasBytes) }
  // the next round looks at this one: a "disk too slow" during it, and what it converted (thin-pace.mjs)
  noteRound({ start: roundStart, end: clock(), bytes: wasBytes, full: ['time', 'slow', 'strain', 'locations'].includes(stopKind), mbps: out.pace.effectiveMbps })
  return out

  // ---- the pieces ---------------------------------------------------------------------------------

  /** Where these cameras' next full-video row in [from, to) starts, or null: a window at a time (WINDOW_ROWS). */
  async function nextFull(cams, from, to) {
    for (let at = from; at < to; ) {
      const first = win.nth(at, 0) // over time with no full video at all in one look
      if (first === null || first >= to) return null
      const end = win.end(first, to)
      const s = index.firstFull(cams, first, end)
      if (s !== null) return s
      at = end
      await tick()
    }
    return null
  }

  /**
   * What waits, from segments_full: per group, between bookmarked stretches, a window at a time
   * (WINDOW_ROWS; windows with none of the group's rows passed with one look each). No row objects, no files.
   *
   * A bookmark keeps the cameras it names (since 2026-09-30): the group's cameras with no bookmark of their
   * own are summed together between the common stretches, as before; each camera with bookmarks of its own
   * alone, between its own stretches and the common ones, from its first full-video file none of them
   * keeps, through its own rows (THIN_SQL.fullSummaryOf, camera first: a day of them a statement). Its
   * bookmarked files are full video for good (never converted), so the oldest waiting file, and with it
   * FALLING BEHIND, would otherwise be a bookmarked one. Summing each such camera through segments_full
   * would pass every other camera's rows once more per camera.
   */
  async function backlogOf(list) {
    const b = { files: 0, bytes: 0, weighted: 0, oldestMs: null, lagMs: 0 }
    const off = new Map() // why -> files on a location that is not usable now
    const common = guard.common ?? []
    const owners = new Set(guard.cameras ?? []) // cameras with bookmarks of their own
    const add = (g, r) => {
      const loc = locs.get(r.loc)
      if (!loc || !here.has(loc.id)) {
        const why = loc ? `${loc.path} is not mounted` : `unknown location ${r.loc}`
        off.set(why, (off.get(why) ?? 0) + r.files)
        return
      }
      b.files += r.files
      b.bytes += r.bytes
      b.weighted += r.weighted
      if (b.oldestMs === null || r.firstMs < b.oldestMs) b.oldestMs = r.firstMs
      b.lagMs = Math.max(b.lagMs, g.cutoff - r.firstMs)
    }
    const said = []
    for (const g of list) {
      const stepMs = g.timelapseS * 1000
      const rest = g.cams.filter((c) => !owners.has(`${c.nvr}/${c.ch}`))
      if (rest.length) {
        for (const [from, to] of between(common, g.cutoff)) {
          for (let t = await nextFull(rest, from, to); t !== null && t < to; ) {
            await tick()
            const end = win.end(t, to)
            for (const r of index.fullSummary(rest, { fromMs: t, toMs: end, endBefore: to, stepMs })) add(g, r)
            t = end < to ? await nextFull(rest, end, to) : null
          }
        }
      }
      for (const c of g.cams.filter((x) => owners.has(`${x.nvr}/${x.ch}`))) {
        const key = `${c.nvr}/${c.ch}`
        const ranges = guard.listOf(key)
        for (const [a, z] of guard.ownOf(key)) if (a < g.cutoff) said.push(`${utc(a)} to ${utc(z)} (${key})`)
        const first = await firstWaiting(c, ranges, g.cutoff)
        if (first === null) continue
        for (const [from, to] of between(ranges, g.cutoff, first)) {
          for (let t = from; t < to; t += DAY) {
            await tick()
            for (const r of index.fullSummaryOf(c, { fromMs: t, toMs: Math.min(t + DAY, to), endBefore: to, stepMs })) add(g, r)
          }
        }
      }
    }
    // one line per reason and per stretch, not per row (a drive unplugged with a week on it is 900,000 rows)
    for (const [why, files] of off) out.skipped.push({ path: `${files.toLocaleString('en-GB')} files`, why, files })
    const latest = Math.max(...list.map((g) => g.cutoff), -Infinity)
    for (const [a, z] of common) if (a < latest) out.skipped.push({ path: `${utc(a)} to ${utc(z)}`, why: 'bookmarked or exported' })
    for (const path of new Set(said)) out.skipped.push({ path, why: 'bookmarked or exported' })
    return b
  }

  /** The spans between these stretches, from `lo` up to the cutoff: [from, to) each, to exclusive. */
  function between(ranges, cutoff, lo = Number.MIN_SAFE_INTEGER) {
    const spans = []
    for (const [a, z] of ranges) {
      if (a >= cutoff) break
      if (z < lo) continue
      if (a > lo) spans.push([lo, a])
      lo = Math.max(lo, Math.floor(z) + 1)
    }
    if (lo < cutoff) spans.push([lo, cutoff])
    return spans
  }

  /**
   * Where one camera's first full-video file waiting to be converted (ended before the cutoff) starts that
   * none of these stretches keeps, or null: its full video read in time order, LOOK rows a window at a time,
   * the rows in a stretch passed as they come. (Full video before it is only bookmarked footage, which is
   * never converted: sparse in segments_full, so passed quickly.)
   */
  async function firstWaiting(c, ranges, cutoff) {
    for (let at = Number.MIN_SAFE_INTEGER; ; ) {
      const t = await nextFull([c], at, cutoff)
      if (t === null || t >= cutoff) return null
      const rows = index.fullOlderThan([c], cutoff, LOOK, t, win.end(t, cutoff))
      // (none: its next file runs past the cutoff, so it does not wait yet; the next after it)
      if (!rows.length) {
        at = t + 1
        continue
      }
      let next = rows.at(-1).startMs + 1
      for (const r of rows) {
        const st = overlapIn(ranges, r)
        if (!st) return r.startMs
        next = Math.max(next, r.startMs >= st[0] ? afterStretch(st) : r.startMs + 1)
      }
      // (two of one camera's files starting in the same millisecond at a look's end, never written on purpose:
      // the second is passed too, which only ever counts less)
      at = next
      await tick()
    }
  }

  /** One file: rewritten by the helper, checked here, swapped by the helper, the row, the commit. */
  async function one(g, key, s, loc) {
    const p = s.path
    const done = () => toEnd.push(p)
    const prev = lastKept.get(key)
    const cursor = prev && s.startMs >= prev.endMs - 5_000 && s.startMs - prev.endMs <= 5_000 ? prev.cursor : null
    let r
    try {
      r = await share(loc, 'thin', { path: p, timelapseS: g.timelapseS, cursor, maxBytes: MAX_SEGMENT_BYTES, swap: false })
    } catch (e) {
      return lost(loc, s, e, 'rewrite')
    }
    if (r?.outcome === 'skipped') {
      if (/half done/.test(r.why)) return lost(loc, s, Object.assign(new Error(r.why), { code: 'EHALFDONE' }), 'rewrite')
      done()
      if (LEFT_AS_IT_IS.test(r.why)) index.setThin(p, THIN.kept)
      if (Number.isFinite(r.cursor)) lastKept.set(key, { endMs: s.endMs, cursor: r.cursor })
      out.skipped.push({ path: p, why: r.why })
      return
    }
    if (r?.outcome !== 'thinned') {
      done()
      warn(`${p}: not converted (${r?.why ?? 'no answer'}); the original is untouched`)
      out.skipped.push({ path: p, why: r?.why ?? 'no answer' })
      return
    }
    // the rewrite is beside the original: is it still to go in? The switch, a bookmark made since the
    // run began (verify-1: a paced run lasts minutes), the row as it was when taken
    const no = await mustNotSwap(s)
    if (no) {
      try {
        await share(loc, 'thinAbort', { path: p })
        done()
      } catch (e) {
        return lost(loc, s, e, 'abort')
      }
      out.skipped.push({ path: p, why: no })
      return
    }
    try {
      await share(loc, 'thinSwap', { path: p })
    } catch (e) {
      return lost(loc, s, e, 'swap')
    }
    try {
      index.thinSwapped(p, { bytes: r.bytes, keyframes: r.keyframes })
    } catch (e) {
      // the row could not say time-lapse: the swap is rolled back, so file and row still agree
      return lost(loc, s, Object.assign(e, { code: 'EINDEX' }), 'index')
    }
    try {
      await share(loc, 'thinCommit', { path: p })
    } catch (e) {
      return lost(loc, s, e, 'commit')
    }
    done()
    lastKept.set(key, { endMs: s.endMs, cursor: r.cursor })
    out.thinned.push({ path: p, wasBytes: r.wasBytes, nowBytes: r.bytes, keptKeyframes: r.keyframes, droppedKeyframes: r.droppedKeyframes })
    out.freedBytes += r.wasBytes - r.bytes
  }

  /** Why the rewrite beside `s` must not go in now, or null. */
  async function mustNotSwap(s) {
    if (armed && !armed()) {
      out.stopped ??= SWITCHED
      return SWITCHED
    }
    try {
      const g = await protectionFor(s.startMs, s.endMs ?? s.startMs, { protectedRanges: rangesFn })
      if (g.protected(s)) return 'bookmarked or exported (since the run began): the rewrite was thrown away'
    } catch (e) {
      out.stopped ??= `the bookmarks could not be read (${e.message})`
      return 'the bookmarks could not be read: the rewrite was thrown away'
    }
    const row = index.thinRow(s.path)
    if (!row || row.bytes !== s.bytes || row.startMs !== s.startMs || row.thinned != null) return 'its index row changed while it was rewritten: the rewrite was thrown away'
    return null
  }

  /**
   * A step of a rewrite failed, or its helper was lost (`e.code`): the file is put right by the helper at
   * once when it can be asked, else it stays in flight for the next run. ESHARESTUCK: the share hangs,
   * nothing more goes to it this run. ESHAREGONE twice: the helper keeps dying, the same.
   */
  async function lost(loc, s, e, step) {
    const code = e?.code ?? null
    warn(`${s.path}: the ${step} did not finish (${e?.message ?? e}${code && !String(e?.message).includes(code) ? `, ${code}` : ''}): putting it right`)
    if (code === 'ESHARESTUCK' || code === 'EMARKER') {
      stopLocation(loc, code === 'EMARKER' ? 'its marker is not there (unmounted?)' : 'the share is not answering')
      keepInFlight.add(s.path)
      warn(`${s.path}: left in flight; it is put right at the next run, and nothing deletes it until then`)
      return
    }
    if (code === 'ESHAREGONE') {
      const n = (goneTimes.get(loc.id) ?? 0) + 1
      goneTimes.set(loc.id, n)
      if (n >= 2) stopLocation(loc, 'its share helper stopped twice in this run')
    }
    const ok = await putRight(loc, [{ path: s.path, loc: loc.id, wasBytes: s.bytes, wasKeyframes: s.keyframes }])
    if (!ok || out.left.includes(s.path) || unsettled.has(s.path)) keepInFlight.add(s.path)
  }

  /** The leftovers from before this run, location by location. */
  async function putRightLeftovers(rows) {
    const byLoc = new Map()
    for (const r of rows) {
      const loc = locs.get(r.loc)
      if (!loc || !here.has(loc.id)) {
        warn(`${r.path}: a rewrite left half done on ${loc ? `${loc.path}, which is not mounted` : `location ${r.loc}, which is not in the list`}: put right once it is back; nothing deletes it until then`)
        continue
      }
      if (!byLoc.has(loc.id)) byLoc.set(loc.id, { loc, rows: [] })
      byLoc.get(loc.id).rows.push(r)
    }
    for (const { loc, rows: list } of byLoc.values()) {
      for (let i = 0; i < list.length; i += 50) {
        await tick()
        if (!(await putRight(loc, list.slice(i, i + 50)))) break
      }
    }
  }

  /**
   * The helper's thinRecover for these rewrites in flight ({ path, wasBytes, wasKeyframes }), then each row
   * made to match its file: rolled back -> the original's size and keyframes, full video; no journal ->
   * the pair on disk is whole, and is the one whose size it has: the original's, or the row's own when the
   * row already says time-lapse (its swap reached the index); gone (the helper found nothing of it with the
   * marker there) -> no longer in flight, its row as it was. A path none of these, whose stat then fails, is
   * kept in flight (unsettled). false when the helper could not be asked (all kept in flight).
   */
  async function putRight(loc, rows) {
    const paths = rows.map((r) => r.path)
    let res
    const stats = new Map()
    try {
      res = await share(loc, 'thinRecover', { paths })
      const need = paths.filter((p) => !res.rolledBack.includes(p) && !res.left.includes(p) && !res.refused.includes(p) && !res.gone?.includes(p))
      if (need.length) for (const x of await share(loc, 'stat', { paths: need })) stats.set(x.path, x)
    } catch (e) {
      warn(`${loc.path}: ${rows.length} rewrite${rows.length === 1 ? '' : 's'} could not be put right now (${e.message}): kept in flight for the next run; nothing deletes ${rows.length === 1 ? 'it' : 'them'} until then`)
      if (e.code === 'ESHARESTUCK' || e.code === 'EMARKER') stopLocation(loc, e.code === 'EMARKER' ? 'its marker is not there (unmounted?)' : 'the share is not answering')
      return false
    }
    const ended = []
    const gone = new Set(Array.isArray(res.gone) ? res.gone : [])
    for (const r of rows) {
      const p = r.path
      const cur = index.thinRow(p)
      if (res.left.includes(p)) {
        // the segment or its .idx is missing and nothing beside it could be put back: a person must look
        out.left.push(p)
        warn(`LEFT HALF DONE, NEEDS A PERSON: ${p}: the file or its .idx is missing and there was nothing to put back; the files beside it are kept as they are, and nothing deletes it`)
        continue
      }
      if (res.refused.includes(p)) {
        ended.push(p)
        warn(`${p}: outside ${loc.path}: not touched`)
        continue
      }
      if (res.rolledBack.includes(p)) {
        ended.push(p)
        out.recovered.rolledBack++
        if (cur) index.setThin(p, null, { bytes: r.wasBytes, keyframes: r.wasKeyframes })
        continue
      }
      if (gone.has(p)) {
        // the helper found nothing of it, nor anything beside it, with the location's marker there: deleted
        ended.push(p)
        warn(`${p}: not there once put right (deleted meanwhile): its row is left as it is`)
        continue
      }
      if (res.sweptUp.includes(p)) out.recovered.sweptUp++
      const st = stats.get(p)
      if (!st || st.error) {
        // Not there, or not answered, and the helper did not say it is gone: the share may have been unmounted
        // since the helper looked (an empty mount point says ENOENT for everything), with the journal and the
        // original still beside it on the share. Kept in flight: nothing deletes it, and the next run looks
        // again (review of p3-thin, round 2, 2026-09-30: it was dropped as "deleted meanwhile").
        unsettled.add(p)
        warn(`${p}: ${st?.error === 'ENOENT' ? 'not there' : st?.error ?? 'no answer'} once put right, and not known to be gone (the share unmounted?): kept in flight for the next run; nothing deletes it until then`)
        continue
      }
      ended.push(p)
      if (cur) {
        if (st.size === cur.bytes) continue // the row says what is on disk (the original, or the committed rewrite)
        if (st.size === r.wasBytes) index.setThin(p, null, { bytes: r.wasBytes, keyframes: r.wasKeyframes })
        else {
          warn(`${p}: once put right its size (${st.size}) is neither the original's (${r.wasBytes}) nor its row's (${cur.bytes}): its row takes that size, as full video, and the next run looks at it again`)
          index.setThin(p, null, { bytes: st.size })
        }
      }
    }
    index.thinEnd(ended)
    return true
  }
}

// ---- the retention job ---------------------------------------------------------------------------

/** Rows asked for at a time while walking a location's oldest footage below the floor. */
const FLOOR_WALK = 200

/**
 * Deletes whole segments: past the camera's retentionDays first, then, on any location still
 * below the free-space floor, its oldest footage first whatever the camera.
 *
 * This is the deliberate, honest version of the second half of housekeeping.mjs: it is driven by
 * the per-camera days and the floor only, it goes oldest first, and it never touches a protected
 * stretch.
 *
 * Its file calls go to each location's helper since 2026-09-29 (segment-delete.mjs; perf report Task 3),
 * in batches, and the rows go only for the files the helper confirmed. Free space too comes from the
 * helper (the default freeOf), read once per location and counted on with the bytes deleted, not read
 * off the share after every file on the main thread. Because the run now waits on the helper, a save of
 * the switch is answered while it runs: `armed()` (storage-jobs.mjs) is asked before each batch, and Off
 * or Dry run stops it there.
 *
 * Bookmarked stretches are stepped over in one look each (review of p2-delete, 2026-09-29): each camera's
 * walk starts at the oldest row no bookmark of its camera covers on a mounted location (firstUnprotected),
 * and a camera's walk that comes to a row starting inside its camera's stretch goes on after its end; the
 * floor's walk, which reads every camera's rows at once, steps over the common stretches (every camera's)
 * that way and passes one camera's bookmarked rows by themselves (a bookmark keeps the cameras it names
 * since 2026-09-30). A bookmark past the days kept is never deleted, so it stays the oldest for good, and
 * passing its rows one by one was every run's cost, dry run included. `skipped` lists such a stretch once
 * per walk, not once per row.
 *
 * @param {{ share?: Function, armed?: () => boolean, sleep?: Function }} o (and the rest as before)
 * @returns {Promise<{ dryRun, deleted: {path, why, bytes}[], skipped: {path, why}[],
 *                     warnings: string[], freedBytes: number, protection: 'ranges'|'none'|'unread' }>}
 */
export async function runRetention({ index, settings = null, now = Date.now(), dryRun = true, present = markerPresent, freeOf = null, protectedRanges, maxDeletes = MAX_SEGMENTS_PER_RUN, share = shareCall, armed = null, sleep } = {}) {
  settings ??= await currentSettings()
  const out = { dryRun, deleted: [], skipped: [], warnings: [], freedBytes: 0, protection: 'none' }
  if (!index) return out
  freeOf ??= (loc) => share(loc, 'statfs')
  const warn = (w) => {
    out.warnings.push(w)
    console.warn(`[retention] ${w}`)
  }
  const locs = new Map((settings.storage?.locations ?? []).map((l) => [l.id, l]))
  const here = mountedSet(locs, present, warn)
  let guard
  try {
    guard = await protectionFor(0, now, { protectedRanges })
  } catch (e) {
    warn(`bookmarks could not be read (${e.message}): nothing deleted this run`)
    out.protection = 'unread' // as in runThinning
    return out
  }
  out.protection = guard.mode

  const refused = new Set() // seen in this run (taken, or tried and could not): never offered again
  // a time-lapse rewrite in flight (runThinning; the server stopped or the share hung during it): the file
  // on disk may be half swapped until the next thinning run puts it right, so it is not deleted before
  const inflight = new Set(typeof index.thinInflight === 'function' ? index.thinInflight().map((r) => r.path) : [])
  let switched = false
  const deleters = new Map() // location id -> the location's deleter (on only)
  const deleterFor = (loc) => {
    if (!deleters.has(loc.id)) {
      deleters.set(
        loc.id,
        makeDeleter({
          share,
          loc,
          index,
          beforeBatch: () => {
            if (switched || !armed || armed()) return switched ? 'the switch was set to Off or Dry run during this run' : null
            switched = true
            warn('the switch was set to Off or Dry run during this run: stopped before the next batch')
            return 'the switch was set to Off or Dry run during this run'
          },
          onDeleted: (seg, why) => {
            out.deleted.push({ path: seg.path, why, bytes: seg.bytes ?? null })
            out.freedBytes += Number(seg.bytes) || 0
          },
          onFailed: (seg, error) => warn(`cannot delete ${seg.path}: ${error}`),
          onStop: (message, code) => code !== 'EHALT' && warn(`${loc.path}: ${message}`)
        })
      )
    }
    return deleters.get(loc.id)
  }
  const flushAll = async () => {
    for (const d of deleters.values()) await d.flush()
  }
  /** Takes a segment: dry run, recorded; on, queued for its location's helper. false when it may not go. */
  const del = async (seg, why) => {
    if (refused.has(seg.path)) return false
    refused.add(seg.path)
    if (inflight.has(seg.path)) {
      out.skipped.push({ path: seg.path, why: 'its time-lapse rewrite is in flight (put right at the next thinning run first)' })
      return false
    }
    if (guard.protected(seg)) {
      out.skipped.push({ path: seg.path, why: 'bookmarked or exported' })
      return false
    }
    const may = mayTouch(seg, locs, here)
    if (!may.ok) {
      out.skipped.push({ path: seg.path, why: may.why })
      return false
    }
    if (dryRun) {
      out.deleted.push({ path: seg.path, why, bytes: seg.bytes ?? null })
      out.freedBytes += Number(seg.bytes) || 0
      return true
    }
    const d = deleterFor(locs.get(seg.loc))
    if (d.stopped) return false
    await d.add(seg, why)
    return !d.stopped
  }

  // where each mounted location's footage stops being bookmarked (everything before is): the walks below
  // start there
  const pace = makePacer()
  const cams = here.size ? index.cameras() : []
  const firstFree = new Map() // location id -> the start of its oldest row no bookmark of its camera covers
  for (const loc of locs.values()) {
    if (!here.has(loc.id)) continue
    const g = await firstUnprotected({ index, locId: loc.id, guard, pace, cams })
    for (const p of g.passed) out.skipped.push({ path: p.path, why: 'bookmarked or exported' })
    if (g.row) firstFree.set(loc.id, g.row.startMs)
  }
  // (rows on a location not mounted, or not in the list, cannot be deleted this run either way)
  const startAt = firstFree.size ? Math.min(...firstFree.values()) : null

  // 1. per-camera retention days, oldest first (olderThan is ordered by start_ms)
  let n = 0
  // Rows past their days on a location that is not mounted, or not in the list: they cannot go this run, and
  // the walk goes on after them. A camera's walk stopped at its first 500 of them, and its rows past their
  // days on the mounted locations, behind those, were never reached (audit of 2026-10-07). Counted by
  // reason, not listed row by row (as runThinning's backlog says them: a drive away for a week is 900,000 rows).
  const off = new Map() // why -> files
  for (const { nvr, ch } of startAt === null ? [] : cams) {
    if (switched) break
    const rec = camRec(settings, nvr, ch)
    if (!Number.isFinite(rec.retentionDays)) {
      warn(`${nvr}/${ch}: retentionDays not set: skipped`)
      continue
    }
    const cutoff = now - rec.retentionDays * DAY
    let fromMs = startAt
    for (let loop = 0; loop < 100 && n < maxDeletes && !switched; loop++) {
      const raw = index.olderThan(nvr, ch, cutoff, BATCH, fromMs)
      const batch = raw.filter((s) => !refused.has(s.path))
      if (!batch.length) break
      let any = false
      let jumped = false
      let away = false
      for (const s of batch) {
        if (n >= maxDeletes || switched) break
        await pace()
        if (!here.has(s.loc)) {
          const loc = locs.get(s.loc)
          const why = loc ? `${loc.path} is not mounted` : `unknown location ${s.loc}`
          off.set(why, (off.get(why) ?? 0) + 1)
          away = true
          continue
        }
        // a row starting inside a bookmarked stretch: so does the camera's every row to its end
        const st = guard.stretchOf(s)
        if (st && s.startMs >= st[0]) {
          out.skipped.push({ path: s.path, why: 'bookmarked or exported' })
          fromMs = afterStretch(st)
          jumped = true
          break
        }
        if (await del(s, 'past its retention days')) {
          any = true
          n++
        }
      }
      // (rows queued and not sent yet are still in the index, and refused: the next look passes them)
      if (!any && !jumped && !away) break
      // an answer that was not full had every such row: no need to ask again
      if (!jumped && raw.length < BATCH) break
      // rows that cannot go this run were among them: the next look starts after this one's last row (the
      // rest of it is taken, or refused)
      if (away && !jumped) fromMs = raw.at(-1).startMs + 1
    }
  }
  for (const [why, files] of off) out.skipped.push({ path: `${files.toLocaleString('en-GB')} files`, why, files })
  await flushAll()

  // 2. the free-space floor, per location, oldest first: free space from the location's helper, then
  // counted on with the bytes deleted
  for (const loc of locs.values()) {
    if (!here.has(loc.id) || switched) continue
    const { floorFreePct, lowFreePct } = freeMarks(settings, loc)
    // (from the floor's margin above it, and to there: location-health.mjs FLOOR_MARGIN_PCT says why)
    const floorToPct = floorTargetPct({ floorFreePct, lowFreePct })
    let free
    try {
      free = await freeOf(loc)
    } catch {
      continue // storage.mjs reports an unreadable location
    }
    if (!(free?.totalBytes > 0) || !Number.isFinite(free?.freeBytes)) continue
    if (pct(free) >= floorToPct) continue
    const under = pct(free) < floorFreePct ? 'below' : 'close to'
    const stall = dryRun ? null : freeingStalled(loc.id)
    if (stall && now < stall.retryAt) {
      warn(`${loc.path}: ${under} the hard floor (${pct(free).toFixed(1)}% free, floor ${floorFreePct}%), but deleting files did not free space on it (a recycle bin or snapshots on the NAS, or another program writing to the share?): nothing deleted on it for free space here (housekeeping makes one small try each run while it is below its floor)`)
      continue
    }
    warn(`${loc.path}: ${under} the hard floor (${pct(free).toFixed(1)}% free, floor ${floorFreePct}%): ${dryRun ? 'would delete' : 'deleting'} the oldest footage, even inside its retention`)
    const floorB = (free.totalBytes * floorToPct) / 100
    const d = dryRun ? null : deleterFor(loc)
    const base = d ? d.doneBytes : 0
    let dryFreed = 0
    const counted = () => free.freeBytes + (d ? d.doneBytes - base + d.pendingBytes : dryFreed)
    // (from its oldest row no bookmark covers; none: nothing here may go)
    let fromMs = firstFree.get(loc.id) ?? Number.MAX_SAFE_INTEGER
    walk: for (let loop = 0; loop < 1000 && n < maxDeletes && counted() < floorB; loop++) {
      const rows = index.oldest(FLOOR_WALK, { loc: loc.id, fromMs }).filter((s) => !refused.has(s.path))
      if (!rows.length) break
      for (const s of rows) {
        fromMs = s.startMs
        if (n >= maxDeletes || counted() >= floorB || d?.stopped || switched) break walk
        await pace()
        // a row starting inside a common bookmarked stretch (every camera's): so does every row here to its
        // end, whatever the camera. One camera's own stretch keeps that camera's rows only: del() passes each
        // (since 2026-09-30; the other cameras' footage of that time is the oldest like any other)
        const st = guard.commonOf(s)
        if (st && s.startMs >= st[0]) {
          out.skipped.push({ path: s.path, why: 'bookmarked or exported' })
          fromMs = afterStretch(st)
          continue walk
        }
        if (await del(s, 'below the free-space floor')) {
          n++
          if (!d) dryFreed += Number(s.bytes) || 0
        }
      }
    }
    if (!d) continue
    await d.flush()
    const r = await checkFreeRose({ loc, before: free, deletedBytes: d.doneBytes - base, freeOf, now, sleep })
    if (r.warning) warn(`FREE SPACE DOES NOT RISE: ${r.warning}`)
  }
  // No line of its own here: storage-jobs.mjs writes one summary for the run (every run that changed
  // footage; in dry run at most once an hour, where a line every 5 minutes said the same thing).
  return out
}

export const _test = { names, suffix, forget: () => (lastKept.clear(), (behindSaidAt = -Infinity), (paceSaid = ''), (backoffSaid = '')) }
