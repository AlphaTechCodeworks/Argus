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
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, statfsSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { parseIdx } from './segment-writer.mjs'
import { markerPresent } from './storage-report.mjs'
import { THIN_SUFFIX as suffix, buildThinned, checkThinned, codecOf, planThin, thinNames as names } from './thin-file.mjs'

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
/** Margin around a protected stretch, so the keyframe before a bookmark survives too. */
export const PROTECT_MARGIN_MS = 60_000

const camRec = (settings, nvr, ch) => ({ ...settings.recording.defaults, ...(settings.recording.cameras?.[`${nvr}/${ch}`] ?? {}) })
const defaultFreeOf = (loc) => {
  const s = statfsSync(loc.path)
  return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) }
}
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

/** Normalises whatever protectedRanges answers into [[from, to]] pairs. Unparseable -> throws. */
function normaliseRanges(raw) {
  const out = []
  for (const r of raw ?? []) {
    const from = Array.isArray(r) ? r[0] : r?.fromMs ?? r?.startMs ?? r?.from
    const to = Array.isArray(r) ? r[1] : r?.toMs ?? r?.endMs ?? r?.to
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error(`protectedRanges gave a range we cannot read: ${JSON.stringify(r)}`)
    out.push([Math.min(from, to) - PROTECT_MARGIN_MS, Math.max(from, to) + PROTECT_MARGIN_MS])
  }
  return out
}

const overlaps = (ranges, fromMs, toMs) => ranges.some(([a, b]) => fromMs <= b && toMs >= a)

/**
 * A guard object for one run: .protected(seg) says whether a segment must be left alone.
 * `mode` is 'none' (no bookmarks module yet) or 'ranges'. A run's `protection` can also be
 * 'unread': asking threw, and the run stopped before any file (the two catches below).
 */
async function protectionFor(fromMs, toMs, { protectedRanges } = {}) {
  const fn = protectedRanges === undefined ? await loadProtectedRanges() : protectedRanges
  if (typeof fn !== 'function') return { mode: 'none', ranges: [], protected: () => false }
  // A throw here is fatal for the run: we cannot tell bookmarked footage from the rest, and the
  // only safe thing to do with footage you cannot identify is nothing.
  const ranges = normaliseRanges(await fn(fromMs, toMs))
  return { mode: 'ranges', ranges, protected: (s) => overlaps(ranges, s.startMs, s.endMs ?? s.startMs) }
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

// ---- thinning one file ------------------------------------------------------------------------

const unlinkQuiet = (f) => {
  try {
    unlinkSync(f)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}

function writeFsync(file, buf) {
  const fd = openSync(file, 'w')
  try {
    writeSync(fd, buf, 0, buf.length)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Reads the pair back off the disk and checks it really is what we meant to write: right size,
 * one .idx row per unit, every row at a unit start, every unit a keyframe, times increasing.
 * Throws when it is not, and then the original is still untouched.
 */
export function verifyThinned(segFile, idxFile, expect) {
  return checkThinned(segFile, readFileSync(segFile), parseIdx(readFileSync(idxFile)), expect)
}

/**
 * Puts the new pair in place of the old one so that a crash at ANY instant leaves either the
 * whole original or the whole new pair on disk, never a mixture and never nothing:
 *
 *   1. journal written + fsynced          <- from here on, a crash means "roll back"
 *   2. seg -> seg.thin-old, idx -> idx.thin-old
 *   3. seg.thin-new -> seg, idx.thin-new -> idx
 *   4. the index row is updated
 *   5. journal deleted                    <- the commit point
 *   6. the .thin-old pair is deleted
 *
 * recoverThinning() rolls back whenever it finds a journal (steps 1-4 did not all finish) and
 * sweeps up stray .thin-old / .thin-new files when it does not (committed, step 6 interrupted).
 */
function swapIn(p, updateIndex) {
  const n = names(p)
  writeFsync(n.journal, Buffer.from(`${JSON.stringify({ path: p, at: new Date().toISOString() })}\n`))
  renameSync(n.seg, n.oldSeg)
  renameSync(n.idx, n.oldIdx)
  renameSync(n.newSeg, n.seg)
  renameSync(n.newIdx, n.idx)
  updateIndex()
  unlinkSync(n.journal)
  unlinkQuiet(n.oldSeg)
  unlinkQuiet(n.oldIdx)
}

/**
 * Undoes or sweeps up after an interrupted rewrite under `root`. Safe to run at any time; run it
 * at startup before the jobs.
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
 * Time-lapse thinning: for every camera set to `after: 'timelapse'`, rewrite its segments older
 * than `fullDays` so only one keyframe per `timelapseS` is left.
 *
 * @param {{ index: object, settings?: object, now?: number, dryRun?: boolean,
 *           present?: (loc)=>boolean, protectedRanges?: function|null, maxSegments?: number }} o
 * @returns {Promise<{ dryRun, thinned: {path, wasBytes, nowBytes, keptKeyframes, droppedKeyframes}[],
 *                     skipped: {path, why}[], warnings: string[], freedBytes: number, protection: 'ranges'|'none'|'unread' }>}
 */
export async function runThinning({ index, settings = null, now = Date.now(), dryRun = true, present = markerPresent, protectedRanges, maxSegments = MAX_SEGMENTS_PER_RUN } = {}) {
  settings ??= await currentSettings()
  const out = { dryRun, thinned: [], skipped: [], warnings: [], freedBytes: 0, protection: 'none' }
  if (!index) return out
  const warn = (w) => {
    out.warnings.push(w)
    console.warn(`[thinning] ${w}`)
  }
  const locs = new Map((settings.storage?.locations ?? []).map((l) => [l.id, l]))
  const here = mountedSet(locs, present, warn)

  const cams = index.cameras()
  if (!cams.length) return out
  // Ask once for the whole window the run could touch, rather than per segment.
  let guard
  try {
    guard = await protectionFor(0, now, { protectedRanges })
  } catch (e) {
    warn(`bookmarks could not be read (${e.message}): nothing thinned this run`)
    // not 'none' ("nobody to ask, so nothing is protected"): the page said that too, in red, about
    // a run that touched nothing (review 2026-09-29)
    out.protection = 'unread'
    return out
  }
  out.protection = guard.mode

  let done = 0
  for (const { nvr, ch } of cams) {
    const rec = camRec(settings, nvr, ch)
    if (rec.after !== 'timelapse') continue
    if (!Number.isFinite(rec.fullDays) || !Number.isFinite(rec.timelapseS)) {
      warn(`${nvr}/${ch}: fullDays or timelapseS not set: skipped`)
      continue
    }
    const cutoff = now - rec.fullDays * DAY
    let cursor = -Infinity
    const seen = new Set()
    for (let guardLoop = 0; guardLoop < 100 && done < maxSegments; guardLoop++) {
      const batch = index.olderThan(nvr, ch, cutoff, BATCH).filter((s) => !seen.has(s.path))
      if (!batch.length) break
      for (const seg of batch) {
        seen.add(seg.path)
        if (done >= maxSegments) break
        const skip = (why) => out.skipped.push({ path: seg.path, why })
        if (guard.protected(seg)) {
          skip('bookmarked or exported')
          continue
        }
        const may = mayTouch(seg, locs, here)
        if (!may.ok) {
          skip(may.why)
          continue
        }
        const n = names(seg.path)
        let buf
        let rows
        try {
          const st = statSync(n.seg)
          if (st.size > MAX_SEGMENT_BYTES) {
            skip(`larger than ${MAX_SEGMENT_BYTES} bytes`)
            continue
          }
          buf = readFileSync(n.seg)
          rows = parseIdx(readFileSync(n.idx))
        } catch (e) {
          skip(`cannot read it (${e.code || e.message})`)
          continue
        }
        if (!rows.length) {
          skip('no index rows')
          continue
        }
        let plan
        try {
          plan = planThin(buf, rows, { codec: codecOf(seg.path), timelapseS: rec.timelapseS, cursor })
        } catch (e) {
          skip(`cannot be parsed (${e.message})`)
          continue
        }
        if (!plan.keep.length) {
          // Every keyframe in this file falls inside the previous one's interval. Leaving the file
          // as it is costs a minute of footage; deleting it here would be a second kind of
          // destruction hidden inside a "thin" job, so it is left for the retention job.
          skip('nothing to keep at this interval (left alone)')
          continue
        }
        const built = buildThinned(buf, plan.keep)
        if (built.bytes.length >= buf.length) {
          cursor = plan.cursor
          skip('already thin')
          continue
        }
        const row = { path: seg.path, wasBytes: buf.length, nowBytes: built.bytes.length, keptKeyframes: plan.keep.length, droppedKeyframes: rows.length - plan.keep.length }
        if (dryRun) {
          out.thinned.push(row)
          out.freedBytes += buf.length - built.bytes.length
          cursor = plan.cursor
          done++
          continue
        }
        try {
          writeFsync(n.newSeg, built.bytes)
          writeFsync(n.newIdx, built.idx)
          const v = verifyThinned(n.newSeg, n.newIdx, { bytes: built.bytes.length, keyframes: plan.keep.length, codec: codecOf(seg.path) })
          swapIn(seg.path, () => index.addSegment({ ...seg, bytes: v.bytes, keyframes: v.keyframes }))
        } catch (e) {
          warn(`${seg.path}: not thinned (${e.message}); the original is untouched`)
          unlinkQuiet(n.newSeg)
          unlinkQuiet(n.newIdx)
          skip(`rewrite failed: ${e.message}`)
          continue
        }
        out.thinned.push(row)
        out.freedBytes += row.wasBytes - row.nowBytes
        cursor = plan.cursor
        done++
      }
      if (batch.length < BATCH) break
    }
  }
  // No line of its own here: storage-jobs.mjs writes one summary for the run (every run that changed
  // footage; in dry run at most once an hour, where a line every 5 minutes said the same thing).
  return out
}

// ---- the retention job ---------------------------------------------------------------------------

/**
 * Deletes whole segments: past the camera's retentionDays first, then, on any location still
 * below the free-space floor, its oldest footage first whatever the camera.
 *
 * This is the deliberate, honest version of the second half of housekeeping.mjs: it is driven by
 * the per-camera days and the floor only, it goes oldest first, and it never touches a protected
 * stretch.
 *
 * @returns {Promise<{ dryRun, deleted: {path, why, bytes}[], skipped: {path, why}[],
 *                     warnings: string[], freedBytes: number, protection: 'ranges'|'none'|'unread' }>}
 */
export async function runRetention({ index, settings = null, now = Date.now(), dryRun = true, present = markerPresent, freeOf = defaultFreeOf, protectedRanges, maxDeletes = MAX_SEGMENTS_PER_RUN } = {}) {
  settings ??= await currentSettings()
  const out = { dryRun, deleted: [], skipped: [], warnings: [], freedBytes: 0, protection: 'none' }
  if (!index) return out
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

  const refused = new Set() // tried and could not: never tried again in this run
  const del = (seg, why) => {
    if (refused.has(seg.path)) return false
    if (guard.protected(seg)) {
      out.skipped.push({ path: seg.path, why: 'bookmarked or exported' })
      refused.add(seg.path)
      return false
    }
    const may = mayTouch(seg, locs, here)
    if (!may.ok) {
      out.skipped.push({ path: seg.path, why: may.why })
      refused.add(seg.path)
      return false
    }
    out.deleted.push({ path: seg.path, why, bytes: seg.bytes ?? null })
    out.freedBytes += Number(seg.bytes) || 0
    if (dryRun) {
      refused.add(seg.path) // so a dry run does not report the same file twice
      return true
    }
    for (const f of [resolve(seg.path), `${resolve(seg.path)}.idx`]) {
      try {
        unlinkSync(f)
      } catch (e) {
        if (e.code !== 'ENOENT') {
          warn(`cannot delete ${f}: ${e.code || e.message}`)
          out.deleted.pop()
          out.freedBytes -= Number(seg.bytes) || 0
          refused.add(seg.path)
          return false
        }
      }
    }
    index.remove(seg.path)
    for (let d = dirname(resolve(seg.path)); d.startsWith(may.root + sep); d = dirname(d)) {
      try {
        rmdirSync(d)
      } catch {
        break
      }
    }
    return true
  }

  // 1. per-camera retention days, oldest first (olderThan is ordered by start_ms)
  let n = 0
  for (const { nvr, ch } of index.cameras()) {
    const rec = camRec(settings, nvr, ch)
    if (!Number.isFinite(rec.retentionDays)) {
      warn(`${nvr}/${ch}: retentionDays not set: skipped`)
      continue
    }
    const cutoff = now - rec.retentionDays * DAY
    for (let loop = 0; loop < 100 && n < maxDeletes; loop++) {
      const batch = index.olderThan(nvr, ch, cutoff, BATCH).filter((s) => !refused.has(s.path))
      if (!batch.length) break
      let any = false
      for (const s of batch) {
        if (n >= maxDeletes) break
        if (del(s, 'past its retention days')) {
          any = true
          n++
        }
      }
      if (!any) break
    }
  }

  // 2. the free-space floor, per location, oldest first
  const { floorFreePct = 5 } = settings.storage ?? {}
  for (const loc of locs.values()) {
    if (!here.has(loc.id)) continue
    let free
    try {
      free = freeOf(loc)
    } catch {
      continue // storage.mjs reports an unreadable location
    }
    if (pct(free) >= floorFreePct) continue
    warn(`${loc.path}: below the hard floor (${pct(free).toFixed(1)}% free, floor ${floorFreePct}%): ${dryRun ? 'would delete' : 'deleting'} the oldest footage, even inside its retention`)
    for (let loop = 0; loop < maxDeletes && n < maxDeletes && pct(free) < floorFreePct; loop++) {
      const oldest = index.oldest(50, { loc: loc.id }).find((s) => !refused.has(s.path))
      if (!oldest) break
      if (!del(oldest, 'below the free-space floor')) continue
      n++
      if (dryRun) {
        // Nothing was really freed, so the loop would never end: count the bytes we would have
        // freed towards the floor instead.
        free = { freeBytes: free.freeBytes + (Number(oldest.bytes) || 0), totalBytes: free.totalBytes }
        continue
      }
      try {
        free = freeOf(loc)
      } catch {
        break
      }
    }
  }
  // No line of its own here: storage-jobs.mjs writes one summary for the run (every run that changed
  // footage; in dry run at most once an hour, where a line every 5 minutes said the same thing).
  return out
}

export const _test = { names, suffix, writeFsync }
