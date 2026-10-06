// Localhost-only per-camera export (a report, not a live feature): one entry per NVR, each with one
// row per configured camera -- identity (name, address, web port, make, model, online), the extra
// IPC_INFO fields (a guid/id, MAC, ports, the login the NVR uses, PoE), the main/sub resolution and
// frame rate and recording status (queryRecStatus), and the sub-stream codec as last seen in live.
//
// Read-only and one NVR at a time, so a site is never flooded; never throws per NVR. The route is
// gated to localhost in server.mjs (same as /healthz), so it needs no sign-in and is not reachable
// off the box. The per-camera read itself is Nvr.cameraDetail (nvrs.mjs).
//
//   GET /api/cameras-export     -> { at, nvrs: [...] }  (localhost)
//   GET /api/admin/cameras      -> { at, cached, nvrs: [...] }  (admins; the Cameras report page)
//   GET /api/admin/cameras.xlsx -> the same, as a spreadsheet download (admins)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildXlsx } from './xlsx-writer.mjs'

/**
 * @param {Map<string, import('./nvrs.mjs').Nvr>} nvrs
 * @returns {Promise<Array<object>>} one entry per NVR with its cameras (offline NVRs get an empty list)
 */
export async function cameraExport(nvrs) {
  const out = []
  for (const nvr of nvrs.values()) {
    const base = { nvr: nvr.id, nvrName: nvr.name, site: nvr.site, via: nvr.cfg.sn ? 'p2p' : 'lan', nvrModel: nvr.model || null, nvrOnline: nvr.online }
    if (!nvr.online) {
      out.push({ ...base, cameras: [] })
      continue
    }
    try {
      out.push({ ...base, cameras: await nvr.cameraDetail() })
    } catch (e) {
      out.push({ ...base, cameras: [], error: String(e?.message ?? e).slice(0, 120) })
    }
  }
  return out
}

// The report reads every NVR (GetDeviceIPCInfo + queryRecStatus, one NVR at a time) -- a lot of load on
// a site, and on a P2P NVR it spends one of its few sessions. So it is NOT re-read every time the page
// opens: the page serves the last snapshot, and only an explicit Refresh (?fresh=1) or the nightly job
// (startCameraReportSchedule, 2 AM site time) reads every NVR again. The snapshot is kept on disk, so a
// restart does not force a read either.
let cache = { at: 0, nvrs: null, running: null }
let storeFile = null // data/cameras-report.json, once startCameraReportSchedule has run

function persist() {
  if (!storeFile || !cache.nvrs) return
  try {
    mkdirSync(dirname(storeFile), { recursive: true })
    writeFileSync(storeFile, JSON.stringify({ at: cache.at, nvrs: cache.nvrs }), { mode: 0o600 })
  } catch (e) {
    console.warn(`[cameras] could not save the snapshot: ${e.message}`)
  }
}

/** Reads every NVR now and updates the snapshot. Never two reads at once: callers share the one in flight. */
function readNow(nvrs) {
  if (cache.running) return cache.running
  cache.running = (async () => {
    try {
      const list = await cameraExport(nvrs)
      cache = { at: Date.now(), nvrs: list, running: null }
      persist()
      return { at: cache.at, cached: false, nvrs: list }
    } finally {
      cache.running = null
    }
  })()
  return cache.running
}

/**
 * The cameras report. By default the last snapshot (the nightly read, or the last Refresh), returned at
 * once and marked `cached` -- no NVR is read on a normal page open. `fresh` reads every NVR again (the
 * Refresh button, and the nightly job). With no snapshot at all yet (first ever, nothing saved), one read.
 */
export async function camerasReport(nvrs, { fresh = false } = {}) {
  if (fresh) return readNow(nvrs)
  if (cache.nvrs) return { at: cache.at, cached: true, nvrs: cache.nvrs }
  return readNow(nvrs)
}

/**
 * Loads the saved snapshot and refreshes it once a day at `hour` (site-local; 2 AM by default, when the
 * sites are quiet). This nightly read is the only automatic one -- opening the page never reads a live NVR.
 */
export function startCameraReportSchedule(nvrs, { dataDir, hour = 2 } = {}) {
  storeFile = join(dataDir, 'cameras-report.json')
  try {
    const saved = JSON.parse(readFileSync(storeFile, 'utf8'))
    if (saved && Array.isArray(saved.nvrs)) cache = { at: Number(saved.at) || 0, nvrs: saved.nvrs, running: null }
  } catch {} // no saved snapshot yet: the first page open builds one
  const offsetMin = Number(process.env.CCTV_SITE_TZ_OFFSET_MIN) || 0
  const msUntilNext = () => {
    const now = Date.now()
    const site = new Date(now + offsetMin * 60_000) // its getUTC* read back as the site's wall clock
    let target = Date.UTC(site.getUTCFullYear(), site.getUTCMonth(), site.getUTCDate(), hour, 0, 0) - offsetMin * 60_000
    if (target <= now) target += 24 * 3600_000
    return target - now
  }
  const arm = () => {
    const ms = msUntilNext()
    console.log(`[cameras] next inventory refresh in ${Math.round(ms / 3600_000)} h (${new Date(Date.now() + ms).toISOString()}); page opens serve the saved snapshot${cache.nvrs ? ` (from ${new Date(cache.at).toISOString()})` : ' (none yet)'}`)
    const timer = setTimeout(() => {
      readNow(nvrs)
        .then((r) => console.log(`[cameras] nightly refresh: ${(r.nvrs ?? []).reduce((n, x) => n + (x.cameras?.length ?? 0), 0)} cameras from ${(r.nvrs ?? []).length} NVRs`))
        .catch((e) => console.warn(`[cameras] nightly refresh failed: ${e.message}`))
        .finally(arm)
    }, ms)
    timer.unref?.()
  }
  arm()
}

export const CAMERA_COLUMNS = ['NVR', 'Site', 'Ch', 'Camera Name', 'Online', 'IP Address', 'Make', 'Model', 'Main Res', 'Main FPS', 'Main Codec', 'H.265+ Capable', 'Sub Res', 'Sub FPS', 'Sub Codec', 'Recording', 'PoE', 'NVR Login', 'Port']

// The NVR's encoder codes -> how they read in the report. "+" is H.26x+ (adaptive), "Smart" the smart variant.
const ENCT_LABEL = { h264: 'H.264', h264p: 'H.264+', h264s: 'H.264 Smart', h265: 'H.265', h265p: 'H.265+', h265s: 'H.265 Smart' }
export const enctLabel = (e) => (e ? ENCT_LABEL[e] ?? String(e).toUpperCase() : '')
const yesNoNull = (v) => (v == null ? '' : v ? 'Yes' : 'No')

/** Flattens the report to one row per camera (a note row for an NVR that could not be read). */
export function cameraRows(report) {
  const rows = [CAMERA_COLUMNS]
  for (const n of report.nvrs ?? []) {
    const cams = n.cameras ?? []
    if (cams.length === 0) {
      const why = n.nvrOnline ? n.error || 'no cameras returned' : 'offline at this read — no cameras listed'
      rows.push([n.nvrName || n.nvr, n.site || '', null, `(${why})`, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null])
      continue
    }
    for (const c of [...cams].sort((a, b) => (a.ch ?? 0) - (b.ch ?? 0))) {
      rows.push([
        n.nvrName || n.nvr, n.site || '', c.ch, c.name || '', c.online ? 'Yes' : 'No', c.ip || '',
        c.maker || '', c.model || '', c.mainRes || '', c.mainFps ?? '', enctLabel(c.mainEnct), yesNoNull(c.h265pCapable),
        c.subRes || '', c.subFps ?? '', (c.subCodec || '').toUpperCase(), c.recStatus || '', c.poe ? 'Yes' : 'No', c.nvrLogin || '',
        c.dataPort || c.ctrlPort || ''
      ])
    }
  }
  return rows
}

/** The report as an .xlsx file (one "Cameras" sheet). */
export function camerasXlsx(report) {
  return buildXlsx([{ name: 'Cameras', rows: cameraRows(report) }])
}
