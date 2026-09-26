// What the Storage page shows, and the figures the thinning/retention jobs and the drive-full
// forecast alert are decided from.
//
//   buildStorageReport({ settings, index, history, now, freeOf, present })
//     -> { now, locations: [...], cameras: [...], warnings: [] }
//   forecast(samples, opts) -> { bytesPerDay, daysToFull, confident, reason }
//   driveFullCandidates(report, opts) -> alert candidates for alerts.mjs to adopt
//   handleStorage(method, pathname, readJson, user) -> [status, body] | null
//
// The one rule that shapes all of it: never invent a figure. A location we could not stat, a
// camera with one day of history, a drive whose free space is going up and down rather than
// down — all of those give null, and the page prints "not available". A wrong "full in 3 days"
// is worse than no forecast at all: somebody drives to site for it.
import { mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAdmin } from './auth.mjs'

// The caller may hand us a plain user name or the { user, admin } the newer routes pass around.
// Taking only one of the two is how a route ends up refusing everybody: isAdmin() given an object
// looks it up as if it were a name, finds nothing, and denies an admin as confidently as a
// stranger. CCTV_AUTH=off has no real users at all, and is honoured here as everywhere else.
const AUTH_OFF = process.env.CCTV_AUTH === 'off'
const admin = (who) => (AUTH_OFF ? true : who && typeof who === 'object' ? who.admin === true : isAdmin(who))

// storage.mjs and settings.mjs both pull in nvr-xml.mjs -> sdk.mjs -> koffi, which cannot even be
// loaded on a machine without the Linux SDK. This module has to stay testable on any laptop, so
// the one thing it needs from storage.mjs (is the drive really mounted?) is three lines and is
// repeated here, and settings.mjs is imported at run time inside the route.
export const MARKER = '.cctv-recordings'
export function markerPresent(loc) {
  try {
    return JSON.parse(readFileSync(join(loc.path, MARKER), 'utf8'))?.id === loc.id
  } catch {
    return false
  }
}

const DAY = 86_400_000
const HOUR = 3_600_000

/** A forecast needs at least this many samples spanning at least this long. Below it: null. */
export const MIN_SAMPLES = 4
export const MIN_SPAN_MS = 12 * HOUR
/** Samples older than this are not evidence about today's growth rate. */
export const MAX_SAMPLE_AGE_MS = 21 * DAY
/** How much of the straight-line fit the scatter is allowed to be before we admit we don't know. */
export const MAX_NOISE_RATIO = 0.6
/** The forecast alert fires under this many days. */
export const ALERT_DAYS = 7

const defaultFreeOf = (loc) => {
  const s = statfsSync(loc.path)
  return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) }
}

const camRec = (settings, nvr, ch) => ({ ...settings.recording.defaults, ...(settings.recording.cameras?.[`${nvr}/${ch}`] ?? {}) })

// ---- the forecast ------------------------------------------------------------------------------

/**
 * Straight-line fit of used bytes against time, and how long until the drive is full.
 *
 * "Full" means down to the hard floor, not to zero: the floor is where recording stops, so that
 * is the date that matters.
 *
 * @param {{ ms: number, usedBytes: number, totalBytes: number }[]} samples oldest or newest first, either
 * @param {{ now?: number, freeBytes?: number|null, floorFreePct?: number, totalBytes?: number|null }} o
 * @returns {{ bytesPerDay: number|null, daysToFull: number|null, confident: boolean, reason: string,
 *             samples: number, spanMs: number }}
 */
export function forecast(samples, { now = Date.now(), freeBytes = null, totalBytes = null, floorFreePct = 5 } = {}) {
  const no = (reason, extra = {}) => ({ bytesPerDay: null, daysToFull: null, confident: false, reason, samples: 0, spanMs: 0, ...extra })
  const pts = (samples ?? [])
    .filter((s) => s && Number.isFinite(s.ms) && Number.isFinite(s.usedBytes) && now - s.ms <= MAX_SAMPLE_AGE_MS && s.ms <= now + HOUR)
    .sort((a, b) => a.ms - b.ms)
  const spanMs = pts.length ? pts.at(-1).ms - pts[0].ms : 0
  if (pts.length < MIN_SAMPLES) return no('not enough history yet', { samples: pts.length, spanMs })
  if (spanMs < MIN_SPAN_MS) return no('not enough history yet', { samples: pts.length, spanMs })

  // Least squares on (hours since the first sample, used bytes). Hours rather than ms keeps the
  // numbers small enough that the arithmetic stays exact.
  const t0 = pts[0].ms
  const xs = pts.map((p) => (p.ms - t0) / HOUR)
  const ys = pts.map((p) => p.usedBytes)
  const n = pts.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
  }
  if (sxx === 0) return no('not enough history yet', { samples: n, spanMs })
  const slopePerHour = sxy / sxx
  const bytesPerDay = Math.round(slopePerHour * 24)

  // How badly the points miss the line. A drive that is being written and thinned and emptied in
  // turn scatters far off any line, and extrapolating that is guesswork dressed up as a date.
  let ssRes = 0
  for (let i = 0; i < n; i++) ssRes += (ys[i] - (my + slopePerHour * (xs[i] - mx))) ** 2
  const rmse = Math.sqrt(ssRes / n)
  const rise = Math.abs(slopePerHour) * (spanMs / HOUR)
  const noisy = rise <= 0 || rmse / rise > MAX_NOISE_RATIO

  if (bytesPerDay <= 0) return { bytesPerDay, daysToFull: null, confident: false, reason: 'not filling up', samples: n, spanMs }
  if (noisy) return { bytesPerDay, daysToFull: null, confident: false, reason: 'usage is too uneven to extrapolate', samples: n, spanMs }

  const last = pts.at(-1)
  const total = Number.isFinite(totalBytes) ? totalBytes : last.totalBytes
  const free = Number.isFinite(freeBytes) ? freeBytes : Number.isFinite(total) ? total - last.usedBytes : null
  if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) {
    return { bytesPerDay, daysToFull: null, confident: false, reason: 'free space not available', samples: n, spanMs }
  }
  // Down to the floor, not to zero.
  const headroom = free - total * (floorFreePct / 100)
  const days = headroom <= 0 ? 0 : headroom / bytesPerDay
  return { bytesPerDay, daysToFull: Math.round(days * 10) / 10, confident: true, reason: '', samples: n, spanMs }
}

// ---- the sample history -----------------------------------------------------------------------
// Kept as one small JSON file rather than in the recordings DB: it is a handful of numbers per
// location per hour and nothing else reads it.

const HISTORY_FILE = 'storage-history.json'
const MAX_PER_LOC = 24 * 22 // three weeks of hourly samples

/** { [locationId]: [{ ms, usedBytes, totalBytes }] }, oldest first. Never throws. */
export function readHistory(dataDir) {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, HISTORY_FILE), 'utf8'))
    const out = {}
    for (const [k, v] of Object.entries(j ?? {})) if (Array.isArray(v)) out[k] = v.filter((s) => Number.isFinite(s?.ms) && Number.isFinite(s?.usedBytes))
    return out
  } catch {
    return {}
  }
}

/**
 * Adds one sample per location, at most one an hour, and writes the file atomically (a half
 * written history would silently poison every forecast after it).
 * @returns {object} the history as it now stands
 */
export function recordSample(dataDir, locations, now = Date.now(), everyMs = HOUR) {
  const hist = readHistory(dataDir)
  let changed = false
  for (const l of locations ?? []) {
    if (!l || !Number.isFinite(l.usedBytes) || !Number.isFinite(l.totalBytes) || l.totalBytes <= 0) continue
    const list = (hist[l.id] ??= [])
    if (list.length && now - list.at(-1).ms < everyMs) continue
    list.push({ ms: now, usedBytes: l.usedBytes, totalBytes: l.totalBytes })
    if (list.length > MAX_PER_LOC) list.splice(0, list.length - MAX_PER_LOC)
    changed = true
  }
  if (changed) {
    try {
      mkdirSync(dataDir, { recursive: true })
      const tmp = join(dataDir, `.${HISTORY_FILE}.tmp`)
      writeFileSync(tmp, `${JSON.stringify(hist)}\n`)
      renameSync(tmp, join(dataDir, HISTORY_FILE))
    } catch (e) {
      console.warn(`[storage-report] history not written: ${e.message}`)
    }
  }
  return hist
}

// ---- the report --------------------------------------------------------------------------------

const roundDays = (ms) => (Number.isFinite(ms) ? Math.round((ms / DAY) * 10) / 10 : null)

/**
 * Everything the Storage page and the jobs need, per location and per camera.
 *
 * @param {{ settings?: object, index: object|null, history?: object, now?: number,
 *           freeOf?: (loc) => {freeBytes,totalBytes}, present?: (loc) => boolean }} o
 */
export function buildStorageReport({ settings, index = null, history = {}, now = Date.now(), freeOf = defaultFreeOf, present = markerPresent } = {}) {
  if (!settings?.storage) throw new Error('buildStorageReport needs the settings object')
  const warnings = []
  const floorFreePct = settings.storage?.floorFreePct ?? 5
  const lowFreePct = settings.storage?.lowFreePct ?? 15
  const cams = []
  if (index) {
    for (const { nvr, ch } of index.cameras()) {
      const rec = camRec(settings, nvr, ch)
      const first = index.first(nvr, ch)
      const ends = index.lastEnds(nvr, ch)
      const oldestMs = first?.startMs ?? null
      const newestMs = ends?.segEnd ?? null
      // Days kept is measured from the oldest footage to now, not to the newest: a camera that
      // stopped recording a week ago still only holds what it holds.
      const daysKept = Number.isFinite(oldestMs) ? roundDays(now - oldestMs) : null
      cams.push({
        nvr,
        ch,
        camera: `${nvr}/${ch}`,
        mode: rec.mode,
        targetDays: rec.retentionDays ?? null,
        fullDays: rec.fullDays ?? null,
        after: rec.after ?? null,
        timelapseS: rec.timelapseS ?? null,
        oldestMs,
        newestMs,
        daysKept,
        // null when we cannot say, never false: "not available" is not "failing".
        meetsTarget: daysKept === null || !Number.isFinite(rec.retentionDays) ? null : daysKept >= rec.retentionDays * 0.95
      })
    }
  } else {
    warnings.push('the recordings index is not open: days kept and growth are not available')
  }

  const locations = []
  for (const loc of settings.storage?.locations ?? []) {
    const row = {
      id: loc.id,
      path: loc.path,
      type: loc.type,
      role: loc.role,
      limitGB: loc.limitGB ?? null,
      mounted: false,
      usedBytes: null,
      freeBytes: null,
      totalBytes: null,
      usedPct: null,
      freePct: null,
      lowFreePct,
      floorFreePct,
      cameras: [],
      cycling: null,
      forecast: { bytesPerDay: null, daysToFull: null, confident: false, reason: 'not available', samples: 0, spanMs: 0 }
    }
    let mounted = false
    try {
      mounted = present(loc)
    } catch {
      mounted = false
    }
    row.mounted = mounted
    if (!mounted) {
      row.forecast.reason = 'the drive or share is not mounted'
      warnings.push(`${loc.path}: not mounted (its marker is missing or belongs to another drive)`)
      locations.push(row)
      continue
    }
    try {
      const f = freeOf(loc)
      row.freeBytes = f.freeBytes
      row.totalBytes = f.totalBytes
      if (Number.isFinite(f.freeBytes) && Number.isFinite(f.totalBytes) && f.totalBytes > 0) {
        row.usedBytes = f.totalBytes - f.freeBytes
        row.usedPct = Math.round(((f.totalBytes - f.freeBytes) / f.totalBytes) * 1000) / 10
        row.freePct = Math.round((f.freeBytes / f.totalBytes) * 1000) / 10
      }
    } catch (e) {
      warnings.push(`${loc.path}: free space not available (${e.message})`)
    }

    // Per camera, on this location. oldestOf is the only per-location lookup the index has, which
    // is exactly what "how far back does this drive go for this camera" means.
    if (index) {
      for (const c of cams) {
        const oldest = index.oldestOf(c.nvr, c.ch, loc.id, 1)[0] ?? null
        if (!oldest) continue
        const daysHere = roundDays(now - oldest.startMs)
        row.cameras.push({
          camera: c.camera,
          nvr: c.nvr,
          ch: c.ch,
          daysKept: daysHere,
          targetDays: c.targetDays,
          fullDays: c.fullDays,
          meetsTarget: daysHere === null || !Number.isFinite(c.targetDays) ? null : daysHere >= c.targetDays * 0.95,
          oldestMs: oldest.startMs
        })
      }
      // Cycling: the oldest footage here has already reached some camera's retention target, so
      // housekeeping is deleting as fast as the recorder writes. On these recorders that is the
      // normal steady state and a full drive means nothing.
      row.cycling = row.cameras.length === 0 ? null : row.cameras.some((c) => c.meetsTarget === true)
    }

    row.forecast = forecast(history?.[loc.id] ?? [], { now, freeBytes: row.freeBytes, totalBytes: row.totalBytes, floorFreePct })
    locations.push(row)
  }

  return { now, floorFreePct, lowFreePct, locations, cameras: cams, warnings }
}

// ---- the alert candidate -----------------------------------------------------------------------

/**
 * Drives forecast to hit the free-space floor within `days`. For server.mjs / alert-checks.mjs to
 * fold into the snapshot; the shape matches the candidates alerts.mjs makes (key, kind, title,
 * detail), and the kind is deliberately NOT `drive-full`.
 *
 * Why this is so cautious: these recorders cycle. A drive that sits at 97 % used for ever, with
 * housekeeping deleting yesterday's oldest hour to make room for today's, is the system working
 * exactly as designed — alerts.mjs already raises `drive-full` off the low-free threshold, and
 * that one is about to stop recording, not about filling up. This candidate is only for the
 * other case: a drive whose usage is genuinely climbing and which has NOT yet started recycling,
 * so when it does hit the floor it will start eating footage the site is supposed to still have.
 * No forecast, no confidence, or a drive already cycling: nothing is raised.
 */
export function driveFullCandidates(report, { days = ALERT_DAYS } = {}) {
  const out = []
  for (const l of report?.locations ?? []) {
    if (!l.mounted) continue // drive-missing covers it
    const f = l.forecast
    if (!f?.confident || !Number.isFinite(f.daysToFull)) continue // never guess
    if (l.cycling === true) continue // overwriting its own oldest footage: normal, never alert
    if (f.daysToFull >= days) continue
    const when = f.daysToFull < 1 ? 'today' : `in about ${Math.round(f.daysToFull)} ${Math.round(f.daysToFull) === 1 ? 'day' : 'days'}`
    out.push({
      key: `drive-filling/${l.id}`,
      kind: 'drive-filling',
      title: `${l.path} will be full ${when}`,
      detail: `Growing by about ${Math.round(f.bytesPerDay / 1e9)} GB a day, ${l.usedPct ?? '?'} % used, and it has not started recycling yet: at the floor it will begin deleting footage that is still inside its retention.`
    })
  }
  return out
}

// ---- the route ---------------------------------------------------------------------------------
// The index lives in server.mjs; it hands it over once at startup rather than this module
// reaching into it.

let indexRef = () => null
let dataDirRef = null
let settingsRef = null
/**
 * server.mjs: setStorageContext({ index, dataDir }) after the index is open.
 * `settingsOf` is only for the offline tests, where settings.mjs cannot be loaded at all.
 */
export function setStorageContext({ index = null, dataDir = null, settingsOf = null } = {}) {
  // `index` may be the recordings index itself or a function that returns it. The server has only
  // the getter to hand at start-up, because the index is not open yet then -- and handing the
  // getter straight through produced a page that threw "index.cameras is not a function" the first
  // time anybody opened it. Taking either shape is cheaper than remembering which one it wants.
  indexRef = typeof index === 'function' ? index : () => index
  dataDirRef = dataDir
  settingsRef = settingsOf
}

/**
 * GET /api/storage -> the report (admins only: it names every location and every camera).
 * @returns {Promise<[number, object]|null>} null when the path is not ours
 */
export async function handleStorage(method, pathname, _readJson, user) {
  if (pathname !== '/api/storage') return null
  if (method !== 'GET') return [405, { error: 'Method not allowed' }]
  if (!admin(user)) return [403, { error: 'Only admins can see storage' }]
  const settings = settingsRef ? settingsRef() : (await import('./settings.mjs')).getSettings()
  let history = {}
  try {
    if (dataDirRef) {
      const report = buildStorageReport({ settings, index: indexRef() })
      history = recordSample(dataDirRef, report.locations, Date.now())
    }
  } catch (e) {
    console.warn(`[storage-report] sample not taken: ${e.message}`)
  }
  return [200, buildStorageReport({ settings, index: indexRef(), history })]
}

export const _test = { HISTORY_FILE }
