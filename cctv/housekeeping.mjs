// Deletes server recordings (every 5 minutes, CCTV_LIVE_WORKER=on; see server.mjs), location by
// location:
//  1. segments older than their camera's retentionDays;
//  2. over the location's space limit (limitGB, of Argus's recordings as the index counts them,
//     1 GB = 1,000,000,000 bytes; the owner's 12,000 GB on the shared NAS, 2026-09-29): the oldest
//     first by the same scoring as 3, down to the limit, never footage from the newest 24 h (a loud
//     warning when that is all that is left);
//  3. on a location with less than its low mark free (its own lowFreePct, else storage.lowFreePct):
//     the oldest segments first, taking first the camera furthest past its full-video days
//     (fullDays); footage inside a camera's full-video days is kept unless free space is below the
//     hard floor (its own floorFreePct, else storage.floorFreePct: then the oldest of it goes too,
//     with a warning).
// Bookmarked and exported stretches (bookmarks.mjs protectedRanges) are never deleted by any of them
// since 2026-09-29; bookmarks that cannot be read stop the run before any file.
// The .idx goes with its segment, the index row is removed, empty folders are removed. Only
// files inside their location's folder are ever deleted, and only on a location whose marker
// matches (storage.mjs): with a drive unplugged its mount point is an empty folder on the system
// disk, and nothing there (files, index rows, free space) may be taken for the drive's.
//
// The file calls (deleting, the folders, free space) are made by the location's helper process
// (share-calls.mjs), never by this process, and each run picks its files once instead of once per
// file (segment-delete.mjs says why: 12-15 s of frozen main thread every run at the NAS's floor,
// perf report R2). Free space is read from the helper at the start of a location's turn and counted
// on with the bytes of the files deleted; afterwards it must be seen to have risen (segment-delete.mjs
// checkFreeRose: a NAS keeping deleted files would otherwise be deleted from every run for nothing).
import { resolve, sep } from 'node:path'
import { freeMarks } from './location-health.mjs'
import { shareCall } from './share-calls.mjs'
import { CameraCursors, Heap, PROBE_BYTES, checkFreeRose, dirOf, freeingStalled, makeDeleter, stallEnded, _test as deleting } from './segment-delete.mjs'
import { protectionFor } from './thinning.mjs'

const DAY = 86_400_000
const MAX_DELETES = 20_000 // per run: the next run goes on
/** 1 GB, as limitGB counts it (and as the Storage page says). */
export const GB = 1e9
/** The space limit never deletes footage that ends within this of now. */
export const LIMIT_KEEPS_MS = DAY

// settings.mjs and storage.mjs load nvr-xml.mjs -> sdk.mjs (the SDK build), so they are loaded when a
// caller did not hand over what they give: the server always does, and the tests run on any PC
const currentSettings = async () => (await import('./settings.mjs')).getSettings()
const storageMarker = async () => (await import('./storage.mjs')).markerMatches

const camRec = (settings, nvr, ch) => ({ ...settings.recording.defaults, ...(settings.recording.cameras?.[`${nvr}/${ch}`] ?? {}) })
const pctOf = (bytes, total) => (total > 0 ? (bytes / total) * 100 : 100)
const gbText = (b) => `${(b / GB).toFixed(1)} GB`
const whenText = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** What the last run left to say per location (the Storage page, the alerts): locId -> { limitBlocked, notFreeing }. */
let lastAlarms = new Map()

/**
 * The alarms of the last run, by location: the space limit that could not be met (everything left is
 * from the newest 24 h or bookmarked), and deleting that does not free space. [{ id, path, kind, text }]
 */
export function housekeepingAlarms() {
  const out = []
  for (const [id, a] of lastAlarms) {
    if (a.limitBlocked) out.push({ id, path: a.path, kind: 'limit-blocked', text: a.limitBlocked })
    const st = freeingStalled(id)
    if (st) out.push({ id, path: a.path, kind: 'not-freeing', text: a.notFreeing ?? `${a.path}: deleting files did not free space on it` })
  }
  return out
}

/**
 * The alarms as alert candidates (alerts.mjs, through server.mjs extraCandidates): kind 'drive-full',
 * which pages the owner, one per location and alarm, open while each run finds it again.
 */
export function housekeepingCandidates() {
  return housekeepingAlarms().map((a) => ({
    key: `drive-full/${a.id}/${a.kind}`,
    kind: 'drive-full',
    title: a.kind === 'not-freeing' ? `${a.path}: deleting files does not free space` : `${a.path} is over its space limit`,
    detail: a.text
  }))
}

/**
 * @param {{ index: ReturnType<import('./rec-index.mjs').openRecIndex>|null, settings?: object,
 *           freeOf?: (loc) => {freeBytes, totalBytes}|Promise<...>, now?: number, onDelete?: (seg) => void,
 *           present?: (loc) => boolean, share?: typeof shareCall, protectedRanges?: Function|null,
 *           sleep?: (ms) => Promise<void>, log?: Function, warn?: Function }} opts
 *   freeOf: a location's free space; by default its helper's statfs (never this process's)
 *   share:  the file calls (share-calls.mjs shareCall; tests hand in the helper's ops)
 *   protectedRanges: bookmarks.mjs's; undefined loads it, null means no bookmarks module
 * @returns {Promise<{ deleted: {path, why, bytes}[], skipped: {path, why}[], warnings: string[], locations: object[], protection?: string }>}
 */
export async function runHousekeeping({ index, settings = null, freeOf = null, now = Date.now(), onDelete, present = null, share = shareCall, protectedRanges, sleep, log = console.log, warn: warnOut = console.warn } = {}) {
  const out = { deleted: [], skipped: [], warnings: [], locations: [] }
  if (!index) return out
  settings ??= await currentSettings()
  present ??= await storageMarker()
  freeOf ??= (loc) => share(loc, 'statfs')
  const warn = (w) => {
    out.warnings.push(w)
    warnOut(`[housekeeping] ${w}`)
  }
  const locs = settings.storage.locations ?? []
  // locations whose marker is there; the others are skipped entirely this run
  const here = new Set()
  for (const l of locs) {
    let ok = false
    try {
      ok = present(l)
    } catch {}
    if (ok) here.add(l.id)
    else warn(`${l.path}: skipped (its marker is missing or belongs to another drive: not mounted?)`)
  }

  // Gap rows ("not recorded because ...") older than the longest retention any camera has explain
  // nothing any more: pruned (the table otherwise grows forever)
  const retentions = [settings.recording?.defaults?.retentionDays, ...Object.values(settings.recording?.cameras ?? {}).map((c) => c?.retentionDays)].map(Number).filter((d) => Number.isFinite(d) && d > 0)
  try {
    if (retentions.length && typeof index.forgetGapsBefore === 'function') index.forgetGapsBefore(now - Math.max(...retentions) * DAY)
    // the backfill ledger goes the same way: a hole in footage that has been deleted is not a hole
    if (retentions.length && typeof index.backfillForgetBefore === 'function') index.backfillForgetBefore(now - Math.max(...retentions) * DAY)
  } catch (e) {
    out.warnings.push(`gap rows not pruned: ${e.message}`)
  }

  // Bookmarked and exported stretches, asked once for the whole run. Unreadable: nothing is deleted,
  // because footage that cannot be told from evidence is left alone (thinning.mjs, the same rule).
  let guard
  try {
    guard = await protectionFor(0, now, { protectedRanges })
  } catch (e) {
    warn(`bookmarks could not be read (${e.message}): nothing deleted this run`)
    out.protection = 'unread'
    return out
  }
  out.protection = guard.mode

  const alarms = new Map()
  const cams = here.size ? index.cameras() : []
  const unsafe = new Set() // tried and could not, or must not: not tried again in this run
  let taken = 0 // files handed to a helper this run, every location together (MAX_DELETES)
  for (const loc of locs) {
    if (!here.has(loc.id)) continue // statfs would read the disk underneath the mount point
    await location(loc)
  }
  lastAlarms = alarms
  return out

  async function location(loc) {
    const root = resolve(loc.path)
    const marks = freeMarks(settings, loc)
    const limitBytes = Number(loc.limitGB) > 0 ? Number(loc.limitGB) * GB : null
    const row = { id: loc.id, path: loc.path, limitBytes, useBytes: null, freeBytes: null, totalBytes: null, deleted: {}, limitBlocked: null }
    out.locations.push(row)
    alarms.set(loc.id, { path: loc.path, limitBlocked: null, notFreeing: null })
    const alarm = alarms.get(loc.id)

    // what is known before a file is touched: the index's count of this location's bytes (one row read),
    // its free space from its helper, and whether anything here is old enough for retention
    const use = limitBytes ? index.locationUse(loc.id).bytes : null
    row.useBytes = use
    let free = null
    try {
      const f = await freeOf(loc)
      if (Number.isFinite(f?.freeBytes) && f?.totalBytes > 0) free = { freeBytes: Number(f.freeBytes), totalBytes: Number(f.totalBytes) }
    } catch {} // not readable now: storage.mjs reports the location; retention and the limit go on
    row.freeBytes = free?.freeBytes ?? null
    row.totalBytes = free?.totalBytes ?? null
    const retentionOf = new Map(cams.map((c) => [`${c.nvr}/${c.ch}`, camRec(settings, c.nvr, c.ch).retentionDays]))
    const shortest = Math.min(...[...retentionOf.values()].map(Number).filter(Number.isFinite))
    const oldest = Number.isFinite(shortest) ? index.oldest(1, { loc: loc.id })[0] : null
    const retentionDue = Boolean(oldest && oldest.startMs < now - shortest * DAY)
    const overLimit = limitBytes !== null && use > limitBytes
    const lowB = free ? (free.totalBytes * marks.lowFreePct) / 100 : null
    const floorB = free ? (free.totalBytes * marks.floorFreePct) / 100 : null
    // a location where deleting did not free space: the space may have come back since (the NAS freed it late)
    if (free && stallEnded(loc.id, free.freeBytes)) log(`[housekeeping] ${loc.path}: the free space of the files deleted earlier has come back: deleting for free space goes on as before`)
    const stall = freeingStalled(loc.id)
    let lowNeeded = free !== null && free.freeBytes < lowB
    const probing = Boolean(stall && lowNeeded && now >= stall.retryAt)
    if (stall && lowNeeded && !probing) {
      alarm.notFreeing = `${loc.path}: deleting files did not free space on it at ${whenText(stall.since)} (a recycle bin or snapshots on the NAS?): nothing deleted on it for free space until one small try at ${whenText(stall.retryAt)}; it is ${pctOf(free.freeBytes, free.totalBytes).toFixed(1)}% free`
      warn(alarm.notFreeing)
      lowNeeded = false
    }
    if (!retentionDue && !overLimit && !lowNeeded) return

    const cur = new CameraCursors({ index, locId: loc.id, cams })
    const fullOf = new Map(cams.map((c) => [`${c.nvr}/${c.ch}`, camRec(settings, c.nvr, c.ch).fullDays]))
    const counts = new Map() // why -> { files, bytes }
    const del = makeDeleter({
      share,
      loc,
      index,
      // a folder where a camera's next file still is keeps it; the rest are tried (the helper removes
      // only empty ones)
      keepDirs: () => new Set(cur.list.map((c) => cur.peek(c)).filter(Boolean).map(dirOf)),
      onDeleted: (seg, why) => {
        out.deleted.push({ path: seg.path, why, bytes: Number(seg.bytes) || 0 })
        const k = counts.get(why) ?? { files: 0, bytes: 0 }
        k.files++
        k.bytes += Number(seg.bytes) || 0
        counts.set(why, k)
        onDelete?.(seg)
      },
      onFailed: (seg, error) => {
        warn(`cannot delete ${seg.path}: ${error}`)
        unsafe.add(seg.path)
      },
      onStop: (message) => warn(`${loc.path}: ${message}`)
    })
    const going = () => !del.stopped && taken < MAX_DELETES
    const passed = { protected: 0, refused: 0 } // rows passed over on this location, and why
    /** Whether a row may be deleted at all: inside this location's folder, not bookmarked, not refused before. */
    const may = (s) => {
      if (unsafe.has(s.path)) {
        passed.refused++
        return false
      }
      if (!resolve(s.path).startsWith(root + sep)) {
        warn(`not deleting ${s.path}: outside its location's folder (${loc.path})`)
        unsafe.add(s.path)
        passed.refused++
        return false
      }
      if (guard.protected(s)) {
        out.skipped.push({ path: s.path, why: 'bookmarked or exported' })
        unsafe.add(s.path)
        passed.protected++
        return false
      }
      return true
    }
    /** Moves the camera past its row, and deletes it if it may be. */
    const take = async (c, s, why) => {
      cur.next(c)
      if (!may(s)) return
      taken++
      await del.add(s, why)
    }
    // the score: how far past its camera's full-video days a file is (the deployed pick's, 2026-09-24):
    // furthest first, then the earliest start, then the camera's place in the list
    const entry = (c, s) => ({ c, s, past: now - s.endMs - fullOf.get(c.key) * DAY })
    const byScore = (a, b) => a.past > b.past || (a.past === b.past && (a.s.startMs < b.s.startMs || (a.s.startMs === b.s.startMs && a.c.order < b.c.order)))
    const byStart = (a, b) => a.s.startMs < b.s.startMs || (a.s.startMs === b.s.startMs && a.c.order < b.c.order)
    const heapOf = (before) => {
      const h = new Heap(before)
      for (const c of cur.list) {
        const s = cur.head(c)
        if (s) h.push(entry(c, s))
      }
      return h
    }
    const again = (h, c) => {
      const s = cur.head(c)
      if (s) h.push(entry(c, s))
    }

    // 1. retention, camera by camera. A row that started before the cutoff but ends after it (a file
    // longer than it should be) ends the camera's turn until it is due: this only ever deletes later.
    if (retentionDue) {
      for (const c of cur.list) {
        const cutoff = now - retentionOf.get(c.key) * DAY
        for (let s = cur.head(c); going() && s && s.startMs < cutoff && s.endMs < cutoff; s = cur.head(c)) await take(c, s, 'retention')
      }
    }

    // 2. the space limit: by the score, down to the limit, never the newest 24 h
    const heldNow = () => use - del.doneBytes - del.pendingBytes
    if (overLimit && going()) {
      const h = heapOf(byScore)
      let newest = 0
      while (h.size && going() && heldNow() > limitBytes) {
        const { c, s } = h.pop()
        if (s.endMs > now - LIMIT_KEEPS_MS) {
          newest++ // what is left of this camera here is from the newest 24 h: none of it goes for the limit
          continue
        }
        await take(c, s, 'over the limit')
        again(h, c)
      }
      if (heldNow() > limitBytes && going()) {
        const why = [newest ? 'from the newest 24 h' : '', passed.protected ? 'bookmarked or exported' : '', passed.refused ? 'files that could not be deleted' : ''].filter(Boolean).join(', or ')
        alarm.limitBlocked = `${loc.path}: over its ${Number(loc.limitGB).toLocaleString('en-GB')} GB limit (${gbText(heldNow())} held), but everything left there is ${why || 'kept for another reason'}: kept. Raise the limit, or make room by hand.`
        row.limitBlocked = alarm.limitBlocked
        warn(`OVER THE LIMIT: ${alarm.limitBlocked}`)
      }
    }

    // 3. low space: footage past its full-video days by the score, then below the floor anything, oldest
    // first. Counted from the free space read at the start plus the bytes deleted since.
    if (lowNeeded && going()) {
      const freeNow = () => free.freeBytes + del.doneBytes + del.pendingBytes
      const before = del.doneBytes + del.pendingBytes
      // one small try an hour on a location where deleting did not free space
      const room = () => !probing || del.doneBytes + del.pendingBytes - before < PROBE_BYTES
      const pctNow = () => pctOf(freeNow(), free.totalBytes).toFixed(1)
      if (freeNow() < lowB) {
        const h = heapOf(byScore)
        while (h.size && going() && room() && freeNow() < lowB && h.peek().past > 0) {
          const { c, s } = h.pop()
          await take(c, s, 'low space')
          again(h, c)
        }
        // only full-video footage left here
        if (freeNow() < lowB && freeNow() >= floorB && going() && room()) warn(`${loc.path}: ${pctNow()}% free (low mark ${marks.lowFreePct}%), but everything left is within its cameras' full-video days: kept`)
      }
      if (freeNow() < floorB && going() && room()) {
        warn(`${loc.path}: below the hard floor (${pctNow()}% free, floor ${marks.floorFreePct}%): deleting footage within full-video days, oldest first`)
        const h = heapOf(byStart)
        while (h.size && going() && room() && freeNow() < floorB) {
          const { c, s } = h.pop()
          await take(c, s, 'below floor')
          again(h, c)
        }
        if (freeNow() >= floorB && freeNow() < lowB) warn(`${loc.path}: back above the floor (${pctNow()}%); the rest is within full-video days: kept`)
      }
    }
    await del.flush()

    // did the files deleted free their space? (a recycle bin or snapshots on the NAS keep it)
    if (free && del.doneBytes > 0) {
      const r = await checkFreeRose({ loc, before: free, deletedBytes: del.doneBytes, freeOf, now, sleep })
      if (r.warning) {
        alarm.notFreeing = r.warning
        warn(`FREE SPACE DOES NOT RISE: ${r.warning}`)
      }
      if (r.cleared) log(`[housekeeping] ${loc.path}: free space rises again as files are deleted: deleting for free space goes on as before`)
    }

    // one line per run that deleted: the limit's as the owner asked for it, and one for the rest
    for (const [why, k] of counts) row.deleted[why] = { ...k }
    const lim = counts.get('over the limit')
    if (lim) {
      const first = index.oldest(1, { loc: loc.id })[0]
      log(`[housekeeping] over the ${Number(loc.limitGB).toLocaleString('en-GB')} GB limit on ${loc.path}: deleted ${lim.files} file${lim.files === 1 ? '' : 's'}, ${gbText(lim.bytes)}, oldest now ${first ? whenText(first.startMs) : 'none left'}`)
    }
    const rest = [...counts].filter(([why]) => why !== 'over the limit')
    if (rest.length) {
      const files = rest.reduce((a, [, k]) => a + k.files, 0)
      const bytes = rest.reduce((a, [, k]) => a + k.bytes, 0)
      log(`[housekeeping] ${loc.path}: deleted ${files} file${files === 1 ? '' : 's'}, ${gbText(bytes)} (${rest.map(([why, k]) => `${why} ${k.files}`).join(', ')})`)
    }
  }
}

export const _test = {
  reset() {
    deleting.reset()
    lastAlarms = new Map()
  },
  stalled: (id) => freeingStalled(id)
}
