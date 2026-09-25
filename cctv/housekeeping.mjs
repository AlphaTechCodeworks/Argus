// Deletes server recordings (every 5 minutes, CCTV_LIVE_WORKER=on; see server.mjs):
//  1. segments older than their camera's retentionDays;
//  2. on a location with less than storage.lowFreePct free: the oldest segments first, taking
//     first the camera furthest past its full-video days (fullDays); footage inside a camera's
//     full-video days is kept unless free space is below storage.floorFreePct (then the oldest
//     of it goes too, with a warning).
// The .idx goes with its segment, the index row is removed, empty folders are removed. Only
// files inside their location's folder are ever deleted, and only on a location whose marker
// matches (storage.mjs): with a drive unplugged its mount point is an empty folder on the system
// disk, and nothing there (files, index rows, free space) may be taken for the drive's.
import { rmdirSync, statfsSync, unlinkSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { getSettings } from './settings.mjs'
import { markerMatches } from './storage.mjs'

const DAY = 86_400_000
const BATCH = 500
const MAX_DELETES = 20_000 // per run: the next run goes on

const defaultFreeOf = (loc) => {
  const s = statfsSync(loc.path)
  return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) }
}
const pct = (f) => (f.totalBytes > 0 ? (f.freeBytes / f.totalBytes) * 100 : 100)

const camRec = (settings, nvr, ch) => ({ ...settings.recording.defaults, ...(settings.recording.cameras?.[`${nvr}/${ch}`] ?? {}) })

/**
 * @param {{ index: ReturnType<import('./rec-index.mjs').openRecIndex>|null, settings?: object,
 *           freeOf?: (loc) => {freeBytes, totalBytes}, now?: number, onDelete?: (seg) => void }} opts
 * @returns {Promise<{ deleted: {path, why}[], warnings: string[] }>}
 */
export async function runHousekeeping({ index, settings = getSettings(), freeOf = defaultFreeOf, now = Date.now(), onDelete, present = markerMatches } = {}) {
  const out = { deleted: [], warnings: [] }
  if (!index) return out
  const locs = new Map(settings.storage.locations.map((l) => [l.id, l]))
  const warn = (w) => {
    out.warnings.push(w)
    console.warn(`[housekeeping] ${w}`)
  }
  const unsafe = new Set()
  // locations whose marker is there; the others are skipped entirely this run
  const here = new Set()
  for (const l of locs.values()) {
    let ok = false
    try {
      ok = present(l)
    } catch {}
    if (ok) here.add(l.id)
    else warn(`${l.path}: skipped (its marker is missing or belongs to another drive: not mounted?)`)
  }
  const del = (seg, why) => {
    const loc = locs.get(seg.loc)
    const root = loc ? resolve(loc.path) : null
    const p = resolve(seg.path)
    if (loc && !here.has(loc.id)) {
      unsafe.add(seg.path) // not mounted: its files and rows stay as they are
      return false
    }
    if (!root || !p.startsWith(root + sep)) {
      if (!unsafe.has(seg.path)) warn(`not deleting ${seg.path}: outside its location's folder (${loc ? loc.path : `unknown location ${seg.loc}`})`)
      unsafe.add(seg.path)
      return false
    }
    for (const f of [p, `${p}.idx`]) {
      try {
        unlinkSync(f)
      } catch (e) {
        if (e.code !== 'ENOENT') {
          warn(`cannot delete ${f}: ${e.code || e.message}`)
          unsafe.add(seg.path) // not tried again in this run
          return false
        }
      }
    }
    index.remove(seg.path)
    // empty hour / day / camera / NVR folders, never the location itself
    for (let d = dirname(p); d.startsWith(root + sep); d = dirname(d)) {
      try {
        rmdirSync(d)
      } catch {
        break
      }
    }
    out.deleted.push({ path: seg.path, why })
    onDelete?.(seg)
    return true
  }

  // 1. retention. Gap rows ("not recorded because ...") older than the longest retention any
  // camera has explain nothing any more: pruned (the table otherwise grows forever)
  try {
    const days = [settings.recording?.defaults?.retentionDays, ...Object.values(settings.recording?.cameras ?? {}).map((c) => c?.retentionDays)].map(Number).filter((d) => Number.isFinite(d) && d > 0)
    if (days.length && typeof index.forgetGapsBefore === 'function') index.forgetGapsBefore(now - Math.max(...days) * DAY)
  } catch (e) {
    out.warnings.push(`gap rows not pruned: ${e.message}`)
  }
  for (const { nvr, ch } of index.cameras()) {
    const cutoff = now - camRec(settings, nvr, ch).retentionDays * DAY
    for (let n = 0; n < MAX_DELETES; ) {
      const batch = index.olderThan(nvr, ch, cutoff, BATCH).filter((s) => !unsafe.has(s.path))
      if (!batch.length) break
      let any = false
      for (const s of batch) if (del(s, 'retention')) (any = true), n++
      if (!any) break
    }
  }

  // 2. low space, per location
  const { lowFreePct, floorFreePct } = settings.storage
  for (const loc of locs.values()) {
    if (!here.has(loc.id)) continue // statfs would read the disk underneath the mount point
    let free
    try {
      free = freeOf(loc)
    } catch {
      continue // not mounted / missing: storage.mjs reports it
    }
    if (pct(free) >= lowFreePct) continue
    const cams = index.cameras()
    let warnedFull = false
    let warnedFloor = false
    for (let n = 0; n < MAX_DELETES && pct(free) < lowFreePct; n++) {
      // each camera's oldest segment here, scored by how far it is past the camera's full-video days
      let pick = null
      for (const { nvr, ch } of cams) {
        const s = index.oldestOf(nvr, ch, loc.id, 50).find((x) => !unsafe.has(x.path))
        if (!s) continue
        const past = now - s.endMs - camRec(settings, nvr, ch).fullDays * DAY
        if (!pick || past > pick.past || (past === pick.past && s.startMs < pick.s.startMs)) pick = { s, past }
      }
      if (!pick) break
      if (pick.past <= 0) {
        // only full-video footage left here
        if (pct(free) >= floorFreePct) {
          if (!warnedFull) warn(`${loc.path}: ${pct(free).toFixed(1)}% free (low mark ${lowFreePct}%), but everything left is within its cameras' full-video days: kept`)
          warnedFull = true
          break
        }
        // below the floor: take the oldest full-video footage
        const oldest = index.oldest(50, { loc: loc.id }).find((x) => !unsafe.has(x.path))
        if (!oldest) break
        if (!warnedFloor) warn(`${loc.path}: below the hard floor (${pct(free).toFixed(1)}% free, floor ${floorFreePct}%): deleting footage within full-video days, oldest first`)
        warnedFloor = true
        if (!del(oldest, 'below floor')) break
        if (pct((free = freeOf(loc))) >= floorFreePct) {
          if (pct(free) < lowFreePct) warn(`${loc.path}: back above the floor (${pct(free).toFixed(1)}%); the rest is within full-video days: kept`)
          break
        }
        continue
      }
      if (!del(pick.s, 'low space')) continue
      free = freeOf(loc)
    }
  }
  if (out.deleted.length) console.log(`[housekeeping] deleted ${out.deleted.length} segment${out.deleted.length === 1 ? '' : 's'}`)
  return out
}
