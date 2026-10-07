// Days kept against the target, and whether the space Argus may use will hold it (2026-09-30, p4-target;
// scratchpad ideas.md idea 1, "do I really keep 30 days?"). For each storage location, and for all of them:
//   - how far back its footage goes (the oldest file no bookmark covers), and where in that the full video
//     and the time-lapse are, against the target (recording.defaults.retentionDays, or a camera's own);
//   - a forecast at the daily volume of the last WHOLE_DAYS whole days (site days): how many days of full
//     video and of time-lapse fit under the location's space limit and free-space marks, deleted the way
//     housekeeping.mjs deletes (the limit and the low mark take footage by how far past its full-video days
//     it is, the hard floor the oldest), and the date the limit (or the low mark) is reached;
//   - the time-lapse's size from real time-lapse files when there are any (one per camera and hour,
//     rec-index.mjs TL_ROW, weighed against the same cameras' full video now), else estimated from the
//     share of keyframes one per interval keeps (thinning.mjs KEYFRAME_SHARE); it says which.
// A shortfall -- the days kept, or the forecast, under the target -- is an alert candidate, kind
// 'retention-short' (alerts.mjs: opened once and kept open while it holds, like every other alert). It does
// not go quiet when the location recycles: a location deleting to stay under its limit at 8 days, against
// 30, is the shortfall itself (the drive-filling forecast, storage-report.mjs, rightly stays quiet there).
//
// Off the hot path. measureRetention() reads the index -- index searches only, one statement per turn of the
// event loop, no file call on any location -- every REFRESH_MS on its own timer (startRetentionWatch, from
// server.mjs), and keeps each whole day's sums between runs. What the Storage page and the alert checks ask
// for (retentionView, retentionCandidates) is arithmetic on those figures and the free space and limit the
// storage report already has: under 1 ms (retention-target.test.mjs).
import { firstUnprotected } from './segment-delete.mjs'
import { siteDate, siteDayStart } from './site-time.mjs'

const DAY = 86_400_000
const HOUR = 3_600_000

/** The daily volume is the average of this many whole days (site days) before today. */
export const WHOLE_DAYS = 3
/** At most this many rows in one statement summing a day (a window ends where the WINDOW_ROWS-th row starts). */
export const WINDOW_ROWS = 5000
/**
 * A whole day's sums are read again when older than this: backfill fills holes in past days (01:00-05:00 site
 * time, up to the NVRs' 30 days), and the floor may delete from them. One such day a measurement, and none
 * while a new day is being summed, so no measurement sums more than one day after the first (a day of the
 * site's 87 cameras: about 190 ms of main thread in slices of under 10 ms on the development PC, half that
 * on the production VM; three at a start).
 */
export const DAY_STALE_MS = 12 * HOUR
/**
 * Where full video begins after the newest time-lapse: looked for a window of FULL_LOOK_ROWS rows at a time, up
 * to FULL_LOOK_MS past the newest time-lapse sample (the time-lapse goes on up to an hour past it: TL_ROW),
 * however many cameras that is (87 cameras' two hours: 10,440 rows), and at most FULL_LOOKS windows.
 */
export const FULL_LOOK_ROWS = 1000
export const FULL_LOOK_MS = 2 * HOUR
export const FULL_LOOKS = 100
/** Real time-lapse files needed to size the time-lapse from (each stands for about an hour of one camera). */
export const MIN_SAMPLE_FILES = 24
/**
 * Short once the days fall more than RAISE_SHORT_DAYS under the target; short until within CLEAR_SHORT_DAYS of
 * it again. The forecast moves with each day's volume and the other backups' use of the NAS, and a location
 * recycling at exactly its target reads a few minutes either side of it: without the gap, an alert that
 * opens and clears (and pushes) every few days at the edge.
 */
export const RAISE_SHORT_DAYS = 0.25
export const CLEAR_SHORT_DAYS = 0.05
/** Within this share of its limit (or this share of the drive above its low mark), a location counts as recycling. */
export const AT_MARK_SLACK = 0.01
export const REFRESH_MS = 5 * 60_000
export const FIRST_REFRESH_MS = 60_000
/** Figures older than this (the measuring has failed since) are not shown; an open shortfall is kept (retentionCandidates). */
export const FACTS_STALE_MS = 30 * 60_000
/** A date further away than this is "not within a year". */
export const HORIZON_DAYS = 366

const camRec = (settings, nvr, ch) => ({ ...(settings?.recording?.defaults ?? {}), ...(settings?.recording?.cameras?.[`${nvr}/${ch}`] ?? {}) })
const finite = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const turn = () => new Promise((r) => setImmediate(r))

/** The last `n` whole days on the site's clock before `now`'s day, oldest first: [{ date, fromMs, toMs }]. */
export function wholeDays(now, n = WHOLE_DAYS) {
  const out = []
  let to = siteDayStart(siteDate(now))
  for (let i = 0; i < n; i++) {
    const date = siteDate(to - 1)
    const from = siteDayStart(date)
    out.unshift({ date, fromMs: from, toMs: to })
    to = from
  }
  return out
}

// ---- measuring (the index; its own timer) -----------------------------------------------------------------

/** Every camera's use of each location in [fromMs, toMs), a window of WINDOW_ROWS rows a statement, a turn of the loop between. */
async function useBetween(index, fromMs, toMs, stepMs, pause) {
  const by = new Map()
  for (let from = fromMs; from < toMs; ) {
    const nth = index.startNth(from, WINDOW_ROWS)
    let until = nth === null || nth > toMs ? toMs : nth
    if (until <= from) until = from + 1 // over WINDOW_ROWS files starting in one millisecond: that millisecond alone
    for (const r of index.dayUse(from, until, stepMs)) {
      const k = `${r.loc}|${r.nvr}|${r.ch}`
      const a = by.get(k)
      if (!a) by.set(k, { ...r })
      else {
        a.files += r.files
        a.bytes += r.bytes
        a.ms += r.ms
        a.fullBytes += r.fullBytes
        a.fullMs += r.fullMs
        a.weighted += r.weighted
      }
    }
    from = until
    await pause()
  }
  return [...by.values()]
}

/** Where the first full-video file on a location starts, from fromMs on; null when none starts within FULL_LOOK_MS of it. */
async function fullFrom(index, loc, fromMs, pause) {
  let from = fromMs
  for (let i = 0; i < FULL_LOOKS; i++) {
    const r = index.fullNext(loc, from, FULL_LOOK_ROWS)
    if (r.s !== null) return r.s <= fromMs + FULL_LOOK_MS ? r.s : null
    if (r.n < FULL_LOOK_ROWS || r.last === null || r.last > fromMs + FULL_LOOK_MS) return null
    from = r.last + 1
    await pause()
  }
  return null
}

/**
 * What the index says about each location, for retentionView. Index searches only, one statement a turn of
 * the event loop (`pause`); no file on any location is touched. `cache` keeps each whole day's sums between
 * runs (the watch keeps one).
 * @returns {Promise<object|null>} { at, stepMs, keyframeShare, protection, warnings, days: [{ date, fromMs, toMs,
 *   rows: [{ loc, nvr, ch, files, bytes, ms, fullBytes, fullMs, weighted }] }], locations: { [id]: { id, anyOldestMs, oldestMs,
 *   timelapse: { oldestMs, newestMs } | null, fullFromMs, sample: [{ nvr, ch, files, bytes, ms }] } } }
 */
export async function measureRetention({ index, settings, now = Date.now(), protectedRanges, cache = new Map(), pause = turn } = {}) {
  if (!index || !settings?.storage) return null
  // (loaded here: thinning.mjs loads storage-report.mjs, which loads this module)
  const { KEYFRAME_SHARE, protectionFor } = await import('./thinning.mjs')
  // (the keyframes one picture per interval keeps are counted at the default interval for every camera: a
  // camera with one of its own is estimated at the default's, and measured like the rest once it has time-lapse)
  const stepMs = Math.max(1, finite(settings.recording?.defaults?.timelapseS) ?? 10) * 1000
  const facts = { at: now, stepMs, keyframeShare: { ...KEYFRAME_SHARE }, protection: 'none', warnings: [], days: [], locations: {} }
  // Bookmarked footage is never deleted, so it stays the oldest there for good: the days kept are counted from
  // the oldest file no bookmark of its own camera covers (segment-delete.mjs firstUnprotected, a look a stretch
  // at most).
  let guard = null
  try {
    guard = await protectionFor(0, now, { protectedRanges })
    facts.protection = guard.mode
  } catch (e) {
    facts.protection = 'unread'
    facts.warnings.push(`the bookmarks could not be read (${e.message}): the oldest footage counted may be a bookmarked stretch`)
  }

  // The whole days: new ones summed; otherwise, one summed more than DAY_STALE_MS ago read again.
  const days = wholeDays(now)
  const keyOf = (d) => `${d.fromMs}|${d.toMs}|${stepMs}`
  const keep = new Set(days.map(keyOf))
  for (const k of [...cache.keys()]) if (!keep.has(k)) cache.delete(k)
  let summed = false
  for (const d of days) {
    if (cache.has(keyOf(d))) continue
    cache.set(keyOf(d), { at: now, rows: await useBetween(index, d.fromMs, d.toMs, stepMs, pause) })
    summed = true
  }
  if (!summed) {
    const stale = days.map((d) => ({ d, c: cache.get(keyOf(d)) })).filter((x) => now - x.c.at > DAY_STALE_MS).sort((a, b) => a.c.at - b.c.at)[0]
    if (stale) cache.set(keyOf(stale.d), { at: now, rows: await useBetween(index, stale.d.fromMs, stale.d.toMs, stepMs, pause) })
  }
  for (const d of days) facts.days.push({ ...d, rows: cache.get(keyOf(d)).rows })

  // (a bookmark keeps the cameras it names since 2026-09-30: the gate asks camera by camera, so it needs them)
  let cams = null
  for (const loc of settings.storage.locations ?? []) {
    const any = index.oldest(1, { loc: loc.id })[0] ?? null
    if (guard && any) cams ??= index.cameras()
    const first = guard && any ? (await firstUnprotected({ index, locId: loc.id, guard, pace: pause, cams })).row : any
    // the time-lapse's edges, to the hour; full video from the first full-video file at or after its newest
    const edges = index.timelapseEdges(loc.id)
    let fullFromMs = first?.startMs ?? null
    let sample = []
    if (edges) {
      fullFromMs = await fullFrom(index, loc.id, edges.newestMs, pause)
      // a day of real time-lapse files, one an hour per camera: day and night alike
      sample = index.timelapseSample(loc.id, edges.newestMs - DAY, edges.newestMs + 1)
    }
    facts.locations[loc.id] = { id: loc.id, anyOldestMs: any?.startMs ?? null, oldestMs: first?.startMs ?? null, timelapse: edges, fullFromMs, sample }
    await pause()
  }
  return facts
}

// ---- the forecast (arithmetic) ----------------------------------------------------------------------------

/** The largest x in [lo, hi] for which ok(x) holds, ok being true up to a point and false after it; lo when none. */
function largest(ok, lo, hi) {
  if (!ok(lo)) return lo
  if (ok(hi)) return hi
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2
    if (ok(mid)) lo = mid
    else hi = mid
  }
  return lo
}

/** Bytes a group of cameras holds when it keeps k days: full video to its full-video days, then `s` of it a day. */
const holds = (g, k) => {
  const kk = clamp(k, 0, g.R)
  return g.rate * (Math.min(kk, g.F) + g.s * Math.max(0, kk - g.F))
}

/**
 * The days each group keeps under a location's space, deleted as housekeeping.mjs deletes. Whichever rule
 * deletes first decides, as Argus's bytes stay under it (the other programs' files on the share as they are):
 *  - the limit, when it comes before the low mark: by how far past its full-video days a file is, furthest
 *    first -- so every group keeps its full-video days plus the same x, x below 0 too -- never the newest day;
 *  - the low mark: the same, but only footage past its full-video days. With nothing else left there, the
 *    full video grows on to the limit (by the score again) or to the hard floor (the oldest first: every group
 *    keeps the same age), whichever comes first.
 * Retention deletes at each group's target. { kept: days per group, bound: which rule, null when none }
 */
function keptUnder(gs, { limitCap, lowCap, floorCap }) {
  const total = (kOf) => gs.reduce((a, g) => a + holds(g, kOf(g)), 0)
  if (total((g) => g.R) <= Math.min(limitCap ?? Infinity, lowCap ?? Infinity)) return { kept: gs.map((g) => g.R), bound: null }
  const span = Math.max(...gs.map((g) => g.R - g.F), 0)
  const byScore = (cap, least) => {
    const at = (x) => (g) => clamp(g.F + x, least, g.R)
    const x = largest((v) => total(at(v)) <= cap, least - Math.max(...gs.map((g) => g.F)), span)
    return gs.map(at(x))
  }
  if (limitCap !== null && (lowCap === null || limitCap <= lowCap)) return { kept: byScore(limitCap, 1), bound: 'limit' }
  const fullOnly = total((g) => Math.min(g.F, g.R))
  if (fullOnly <= lowCap) return { kept: byScore(lowCap, 0), bound: 'low mark' }
  const next = Math.min(limitCap ?? Infinity, floorCap ?? Infinity)
  if (fullOnly <= next) return { kept: gs.map((g) => Math.min(g.F, g.R)), bound: 'low mark' }
  if (limitCap !== null && limitCap <= (floorCap ?? Infinity)) return { kept: byScore(limitCap, 1), bound: 'limit' }
  const d = largest((v) => total((g) => Math.min(v, g.R)) <= floorCap, 0, Math.max(...gs.map((g) => g.R)))
  return { kept: gs.map((g) => Math.min(d, g.R)), bound: 'floor' }
}

/**
 * When the bytes held reach the first mark that deletes for space (the limit, or the low mark when it comes
 * first or there is no limit), at the groups' daily volume: each group grows by its whole volume while its
 * oldest footage is inside its full-video days, by the time-lapse share of it after that (the day passing its
 * full-video days is converted as the newest comes in), and not at all once it is at its target. The
 * location's age is its oldest footage's. { what, reached, days, ms } (days and ms null: not at this volume).
 */
function reachOf(gs, { held, age, limitCap, lowCap, now }) {
  const caps = [limitCap, lowCap].filter((v) => v !== null)
  if (held === null || age === null || !caps.length) return null
  const cap = Math.min(...caps)
  const what = limitCap !== null && limitCap <= (lowCap ?? Infinity) ? 'limit' : 'low mark'
  if (held >= cap) return { what, reached: true, days: 0, ms: now }
  const growth = (a) => gs.reduce((s, g) => s + g.rate * (a < g.F ? 1 : a < g.R ? g.s : 0), 0)
  const points = [...new Set(gs.flatMap((g) => [g.F, g.R]))].filter((p) => p > age).sort((x, y) => x - y)
  let t = 0
  let b = held
  let a = age
  for (const next of [...points, Infinity]) {
    const gr = growth(a)
    const span = next - a
    if (gr > 0) {
      const need = (cap - b) / gr
      if (need <= span) {
        t += need
        return t > HORIZON_DAYS ? { what, reached: false, days: null, ms: null } : { what, reached: false, days: t, ms: now + t * DAY }
      }
      b += gr * span
    }
    t += span
    a = next
    if (!Number.isFinite(t) || t > HORIZON_DAYS) break
  }
  return { what, reached: false, days: null, ms: null }
}

/** One scenario (the switch as it is, or time-lapse On): the groups' days, the worst against its target, the date. */
function scenario(groups, converting, caps, { held, age, now }) {
  const gs = groups.map((g) => ({ ...g, s: converting && g.timelapse && g.share !== null ? g.share : 1 }))
  const { kept, bound } = keptUnder(gs, caps)
  let w = 0
  gs.forEach((g, i) => {
    if (g.R - kept[i] > gs[w].R - kept[w]) w = i
  })
  const g = gs[w]
  const k = kept[w]
  const tl = converting && g.timelapse && g.share !== null
  return {
    converting,
    daysFit: k,
    fullDays: tl ? Math.min(k, g.F) : k,
    timelapseDays: tl ? Math.max(0, k - g.F) : 0,
    targetDays: g.R,
    shortBy: Math.max(0, g.R - k),
    bound,
    reach: reachOf(gs, { held, age, ...caps, now }),
    groups: gs.map((x, i) => ({ cameras: x.cameras, fullDays: x.F, targetDays: x.R, timelapse: x.timelapse, perDay: x.rate, daysFit: kept[i] }))
  }
}

/** Remembered shortfalls (location id and kind), for the gap between raising and clearing. */
const shortMemory = new Set()

/**
 * Days kept against the target, and the forecast, per location and for all of them. Arithmetic only.
 * @param {{ facts: object|null, settings: object, locations: object[], now?: number, memory?: Set<string> }} o
 *   locations: the Storage report's rows (id, path, argusBytes, freeBytes, totalBytes, limitBytes,
 *   limitEnforced, lowFreePct, floorFreePct)
 */
export function retentionView({ facts, settings, locations = [], now = Date.now(), memory = shortMemory } = {}) {
  const d = settings?.recording?.defaults ?? {}
  const out = {
    available: false,
    reason: '',
    at: facts?.at ?? null,
    mode: settings?.storage?.thinning ?? 'dry-run',
    targetDays: finite(d.retentionDays),
    camerasOwnTarget: Object.values(settings?.recording?.cameras ?? {}).filter((o) => o && finite(o.retentionDays) !== null).length,
    protection: facts?.protection ?? null,
    warnings: [...(facts?.warnings ?? [])],
    locations: {},
    overall: null
  }
  if (!facts) return { ...out, reason: 'not measured yet: every 5 minutes, the first a minute after the server starts' }
  if (now - facts.at > FACTS_STALE_MS) return { ...out, stale: true, reason: `not measured since ${new Date(facts.at).toISOString().slice(0, 16).replace('T', ' ')} UTC (the server log says why)` }
  out.available = true
  for (const row of locations) {
    const f = facts.locations?.[row.id]
    out.locations[row.id] = f ? locationView(row, f, facts, settings, out.mode, now, memory) : { id: row.id, path: row.path, available: false, reason: 'not measured yet (added since the last measurement)' }
  }
  out.overall = overallOf(out, now)
  return out
}

function locationView(row, f, facts, settings, mode, now, memory) {
  const days = facts.days.filter((x) => f.anyOldestMs !== null && f.anyOldestMs <= x.fromMs)
  const n = days.length
  const cams = new Map()
  for (const day of days) {
    for (const r of day.rows) {
      if (r.loc !== row.id) continue
      const k = `${r.nvr}/${r.ch}`
      const a = cams.get(k) ?? { nvr: r.nvr, ch: r.ch, files: 0, bytes: 0, ms: 0, fullBytes: 0, fullMs: 0, weighted: 0 }
      a.files += r.files
      a.bytes += r.bytes
      a.ms += r.ms
      // (rows with no full-video sums of their own are all full video)
      a.fullBytes += r.fullBytes ?? r.bytes
      a.fullMs += r.fullMs ?? r.ms
      a.weighted += r.weighted
      cams.set(k, a)
    }
  }
  // What a camera records in those days, as full video: the bytes of its files still full video, scaled from
  // their footage time to all of its footage time there. With 3 full-video days or fewer, some of the whole
  // days are time-lapse already, at about a tenth of the size; counted as they are, the daily volume read low
  // and the days forecast high (29.4 days where 20.5 fit at 1 full-video day: audit of 2026-10-07, M12). A
  // camera with no full video left in those days has nothing to scale from, and is counted as it is.
  for (const c of cams.values()) c.asFull = c.fullMs > 0 ? c.fullBytes * (c.ms / c.fullMs) : c.bytes
  // the cameras recording here, by what their settings keep: full-video days, target, time-lapse or not
  const groupsBy = new Map()
  const planOf = (c) => {
    const p = camRec(settings, c.nvr, c.ch)
    const R = finite(p.retentionDays)
    const F = Math.min(finite(p.fullDays) ?? R, R)
    return { F, R, timelapse: p.after === 'timelapse' && F < R }
  }
  for (const c of cams.values()) {
    if (!(c.bytes > 0)) continue
    const p = planOf(c)
    if (p.R === null) continue
    const key = `${p.F}|${p.R}|${p.timelapse}`
    const g = groupsBy.get(key) ?? { ...p, rate: 0, cameras: 0 }
    g.rate += c.asFull / n
    g.cameras++
    groupsBy.set(key, g)
  }
  const groups = [...groupsBy.values()]

  // The time-lapse's size against full video: from a day of real time-lapse files here (one an hour per camera)
  // weighed against the same cameras' full video now; else the keyframes one per interval keeps, times the share
  // of a file's bytes keyframes are (thinning.mjs KEYFRAME_SHARE: measured on real files, 43-56 %).
  let share = null
  if (groups.some((g) => g.timelapse)) {
    let files = 0
    let tlBytes = 0
    let asFull = 0
    for (const s of f.sample ?? []) {
      const c = cams.get(`${s.nvr}/${s.ch}`)
      const bps = c && c.ms > 0 ? c.asFull / c.ms : 0
      if (!(bps > 0) || !(s.ms > 0)) continue
      files += s.files
      tlBytes += s.bytes
      asFull += s.ms * bps
    }
    if (files >= MIN_SAMPLE_FILES && asFull > 0) share = { how: 'measured', value: tlBytes / asFull, files }
    else {
      let bytes = 0
      let weighted = 0
      for (const c of cams.values()) {
        // (the keyframes kept are counted on full-video files: rec-index.mjs TARGET_SQL.dayUse)
        if (!planOf(c).timelapse || !(c.fullMs > 0)) continue
        bytes += c.fullBytes
        weighted += c.weighted
      }
      const kept = bytes > 0 ? weighted / bytes : null
      const ks = facts.keyframeShare ?? { low: 0.43, mid: 0.5, high: 0.56 }
      if (kept !== null) share = { how: 'estimated', value: kept * ks.mid, low: kept * ks.low, high: kept * ks.high, files }
    }
  }
  for (const g of groups) g.share = g.timelapse ? share?.value ?? null : null

  // the space: the enforced limit (location-health.mjs spaceLimit), and what Argus may hold before free space
  // falls to the low mark and to the hard floor, the other programs' files staying as they are
  const held = finite(row.argusBytes)
  const limitCap = row.limitEnforced === true && finite(row.limitBytes) > 0 ? finite(row.limitBytes) : null
  const free = finite(row.freeBytes)
  const total = finite(row.totalBytes)
  const freeKnown = held !== null && free !== null && total > 0
  const lowPct = finite(row.lowFreePct) ?? 15
  const floorPct = finite(row.floorFreePct) ?? 5
  const lowCap = freeKnown ? held + free - (total * lowPct) / 100 : null
  const floorCap = freeKnown ? held + free - (total * floorPct) / 100 : null

  const daysOf = (ms) => (ms === null || ms === undefined ? null : (now - ms) / DAY)
  const daysKept = daysOf(f.oldestMs)
  const fullDaysKept = daysOf(f.fullFromMs)
  const timelapse = f.timelapse ? { oldestMs: f.timelapse.oldestMs, newestMs: f.timelapse.newestMs, days: ((f.fullFromMs ?? f.timelapse.newestMs) - f.timelapse.oldestMs) / DAY } : null
  const targets = [...new Set(groups.map((g) => g.R))].sort((a, b) => a - b)
  if (!targets.length && finite(settings?.recording?.defaults?.retentionDays) !== null) targets.push(finite(settings.recording.defaults.retentionDays))
  // what the location must keep: the largest target of its cameras (its oldest footage bounds every one of them)
  const targetDays = targets.at(-1) ?? null

  // recycling for space: at its limit, or its free space at the low mark (nothing more fits there)
  const atLimit = limitCap !== null && held !== null && held >= limitCap * (1 - AT_MARK_SLACK)
  const atLow = freeKnown && free <= total * (lowPct / 100 + AT_MARK_SLACK)
  const recycling = atLimit ? 'limit' : atLow ? 'low mark' : null

  let forecast = null
  let forecastReason = ''
  if (!n) forecastReason = `needs a whole day of footage here first (a site day; the oldest here is from ${f.anyOldestMs === null ? 'nowhere: none yet' : new Date(f.anyOldestMs).toISOString().slice(0, 16).replace('T', ' ')} UTC)`
  else if (!groups.length) forecastReason = `nothing recorded here in the last ${n} whole ${n === 1 ? 'day' : 'days'}`
  else if (limitCap === null && lowCap === null) forecastReason = 'no space limit, and its free space is not known'
  else {
    const caps = { limitCap, lowCap, floorCap }
    const ctx = { held, age: daysKept, now }
    const on = mode === 'on'
    const asIs = scenario(groups, on, caps, ctx)
    // what switching time-lapse On would give, beside it (while it is not, and where it would change the days)
    const withTl = !on && groups.some((g) => g.timelapse && g.share !== null) ? scenario(groups, true, caps, ctx) : null
    forecast = { now: asIs, timelapse: withTl && Math.abs(withTl.daysFit - asIs.daysFit) >= 0.05 ? withTl : null }
  }

  const remember = (kind, days, target) => {
    const key = `${row.id}|${kind}`
    if (days === null || target === null) {
      memory.delete(key)
      return false
    }
    const short = days < target - (memory.has(key) ? CLEAR_SHORT_DAYS : RAISE_SHORT_DAYS)
    if (short) memory.add(key)
    else memory.delete(key)
    return short
  }
  return {
    id: row.id,
    path: row.path,
    available: true,
    oldestMs: f.oldestMs,
    daysKept,
    fullFromMs: f.fullFromMs,
    fullDaysKept,
    timelapse,
    targetDays,
    targets,
    wholeDays: days.map((x) => x.date),
    perDay: groups.length ? groups.reduce((a, g) => a + g.rate, 0) : null,
    cameras: groups.reduce((a, g) => a + g.cameras, 0),
    share,
    capacity: { heldBytes: held, limitBytes: limitCap, lowBytes: lowCap, floorBytes: floorCap },
    recycling,
    forecast,
    forecastReason,
    short: {
      // the days kept count only where the location can hold no more: elsewhere fewer days are a young location
      actual: remember('actual', recycling ? daysKept : null, targetDays),
      forecast: remember('forecast', forecast ? forecast.now.daysFit : null, forecast ? forecast.now.targetDays : null)
    }
  }
}

/** For all locations: the oldest footage anywhere, and the location furthest short of its target. */
function overallOf(view, now) {
  const ls = Object.values(view.locations).filter((l) => l.available)
  const minOf = (xs) => {
    const v = xs.filter((x) => Number.isFinite(x))
    return v.length ? Math.min(...v) : null
  }
  const oldestMs = minOf(ls.map((l) => l.oldestMs))
  const fullFromMs = minOf(ls.map((l) => l.fullFromMs))
  const tlOldest = minOf(ls.map((l) => l.timelapse?.oldestMs))
  let worst = null
  for (const l of ls) {
    const f = l.forecast?.now
    if (f && (!worst || f.shortBy > worst.forecast.shortBy)) worst = { id: l.id, path: l.path, forecast: f }
  }
  return {
    oldestMs,
    daysKept: oldestMs === null ? null : (now - oldestMs) / DAY,
    fullFromMs,
    fullDaysKept: fullFromMs === null ? null : (now - fullFromMs) / DAY,
    timelapseOldestMs: tlOldest,
    worst,
    short: ls.filter((l) => l.short.actual || l.short.forecast).map((l) => l.id)
  }
}

// ---- the alert candidate ------------------------------------------------------------------------------------

const d1 = (x) => (Math.round(x * 10) / 10).toLocaleString('en-GB')
const daysText = (x) => `${d1(x)} ${Math.round(x * 10) === 10 ? 'day' : 'days'}`
const sizeText = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(2)} TB` : `${Math.round(b / 1e9).toLocaleString('en-GB')} GB`)
const pct = (x) => `${(Math.round(x * 1000) / 10).toLocaleString('en-GB')} %`
const dateText = (ms) => new Date(ms).toISOString().slice(0, 10)
// (a limit as it is set on the page: whole GB of 1,000,000,000 bytes)
const markText = (l, what) => (what === 'limit' ? `its ${Math.round(l.capacity.limitBytes / 1e9).toLocaleString('en-GB')} GB limit` : what === 'floor' ? 'its hard floor' : 'its low mark')

/** "7 of full video and 11.2 of time-lapse" */
const splitText = (s) => (s.timelapseDays > 0 ? `${d1(s.fullDays)} of full video and ${d1(s.timelapseDays)} of time-lapse` : 'all of it full video')

/** The time-lapse's size, and how it is known. */
export function shareText(share) {
  if (!share) return ''
  return share.how === 'measured'
    ? `time-lapse taken as ${pct(share.value)} of full video, measured from ${share.files.toLocaleString('en-GB')} real time-lapse files`
    : `time-lapse taken as ${pct(share.value)} of full video, an estimate from the keyframes it keeps (${(Math.round(share.low * 1000) / 10).toLocaleString('en-GB')}-${pct(share.high)}): no real time-lapse here to measure yet`
}

/** The forecast in one sentence: "At 1.47 TB a day (the last 3 whole days), its 12,000 GB limit holds about 8.2 days (...); ... reached ..." */
export function forecastText(l) {
  const s = l.forecast?.now
  if (!s) return l.forecastReason ? `No forecast: ${l.forecastReason}.` : ''
  const fits = s.shortBy > 0 ? `${s.bound ? markText(l, s.bound) : 'the space it may use'} holds about ${daysText(s.daysFit)} (${splitText(s)})` : `the whole ${daysText(s.targetDays)} fit (${splitText(s)})`
  const reach = !s.reach ? '' : s.reach.reached ? `; ${markText(l, s.reach.what)} is reached already` : s.reach.days !== null ? `; ${markText(l, s.reach.what)} is reached about ${dateText(s.reach.ms)}` : ''
  const withTl = l.forecast.timelapse ? ` With time-lapse On: about ${daysText(l.forecast.timelapse.daysFit)} (${splitText(l.forecast.timelapse)}).` : ''
  // (the time-lapse's size only where some of the days are time-lapse)
  const sh = s.timelapseDays > 0 || l.forecast.timelapse?.timelapseDays > 0 ? shareText(l.share) : ''
  return `At ${sizeText(l.perDay)} a day (the last ${l.wholeDays.length} whole ${l.wholeDays.length === 1 ? 'day' : 'days'}), ${fits}${reach}.${withTl}${sh ? ` ${sh[0].toUpperCase()}${sh.slice(1)}.` : ''}`
}

/** location id -> its candidate as the last fresh figures made it (null: none). Kept while figures are stale. */
const lastCandidate = new Map()

/**
 * The shortfalls as alert candidates (alerts.mjs kind 'retention-short'; through server.mjs extraCandidates),
 * one per location: its days kept under the target while it recycles for space, or its forecast under it.
 * Figures gone stale (the measuring has failed for FACTS_STALE_MS) change nothing: a shortfall stays open, as its
 * "OK" would say all is well when nothing is known; one never measured is no candidate.
 * @param {{ retention: object, locations: object[] }} report the Storage report (storage-report.mjs)
 */
export function retentionCandidates(report) {
  const v = report?.retention
  if (!v?.available) return v?.stale ? (report.locations ?? []).map((row) => lastCandidate.get(row.id)).filter(Boolean) : []
  const out = []
  for (const row of report.locations ?? []) {
    const l = v.locations?.[row.id]
    if (l?.available) lastCandidate.set(row.id, null)
    if (!l?.available || !(l.short.actual || l.short.forecast)) continue
    const target = l.short.actual ? l.targetDays : l.forecast.now.targetDays
    const title = l.short.actual ? `${row.path} keeps ${daysText(l.daysKept)} of footage, short of its ${target}-day target` : `${row.path} will keep about ${daysText(l.forecast.now.daysFit)} of footage, short of its ${target}-day target`
    const back = l.daysKept === null ? 'There is nothing here outside bookmarked stretches' : `Its footage goes back ${daysText(l.daysKept)}${l.timelapse && l.fullDaysKept !== null ? ` (${d1(l.fullDaysKept)} of full video, then ${d1(l.timelapse.days)} of time-lapse)` : ''}`
    const now = `${back}${l.recycling ? `, and it is deleting to stay at ${markText(l, l.recycling)}` : ''}.`
    const c = { key: `retention-short/${row.id}`, kind: 'retention-short', title, detail: `${now} ${forecastText(l)}` }
    lastCandidate.set(row.id, c)
    out.push(c)
  }
  return out
}

// ---- the watch (server.mjs) -----------------------------------------------------------------------------------

let current = null
let running = null
const dayCache = new Map()

/** The last figures measured (retentionView's facts), or null. */
export const retentionFacts = () => current

/** Measures once (never two at a time, never throws): the new figures, or null when there was nothing to measure or it failed. */
export function refreshRetention({ index, settings, protectedRanges, now = Date.now() } = {}) {
  if (running) return running
  running = (async () => {
    try {
      const f = await measureRetention({ index, settings, now, protectedRanges, cache: dayCache })
      if (f) current = f
      return f
    } catch (e) {
      console.warn(`[retention] days kept not measured: ${e.message}`)
      return null
    } finally {
      running = null
    }
  })()
  return running
}

/**
 * Measures every `everyMs`, the first `firstMs` after the start (server.mjs; the index may not be open before).
 * index and settings may be getters. The timers never keep the process alive.
 */
export function startRetentionWatch({ index, settings, protectedRanges, everyMs = REFRESH_MS, firstMs = FIRST_REFRESH_MS } = {}) {
  const go = () => refreshRetention({ index: typeof index === 'function' ? index() : index, settings: typeof settings === 'function' ? settings() : settings, protectedRanges })
  const first = setTimeout(go, firstMs)
  first.unref?.()
  const timer = setInterval(go, everyMs)
  timer.unref?.()
  return {
    stop() {
      clearTimeout(first)
      clearInterval(timer)
    }
  }
}

export const _test = {
  reset() {
    current = null
    dayCache.clear()
    shortMemory.clear()
    lastCandidate.clear()
  }
}
