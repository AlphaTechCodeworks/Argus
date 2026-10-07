// Offline tests for the storage report, the "full in N days" forecast, the drive-full-forecast
// alert candidate and the Storage page's pure render. No SDK, no real disks, Windows-safe.
//   node cctv/test/storage-report.test.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const data = mkdtempSync(join(tmpdir(), 'cctv-storage-report-'))
process.env.DATA_DIR = data
writeFileSync(join(data, 'users.json'), JSON.stringify({ boss: { hash: 'x', role: 'admin' }, viewer: { hash: 'x', role: 'viewer' } }))

const { buildStorageReport, driveFullCandidates, forecast, handleStorage, readHistory, recordSample, setStorageContext, MIN_SAMPLES } = await import('../storage-report.mjs')
const { renderStorage, forecastCell, bytes, days, NOT_AVAILABLE } = await import('../public/storage.js')

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}

const DAY = 86_400_000
const HOUR = 3_600_000
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0)
const TB = 1e12

/** Samples every hour for `hours`, used growing by `perDay` bytes, plus optional noise. */
const series = (hours, { startUsed = 0, perDay = 0, total = TB, noise = 0, step = HOUR } = {}) => {
  const out = []
  const n = Math.floor((hours * HOUR) / step)
  for (let i = 0; i <= n; i++) {
    const ms = NOW - hours * HOUR + i * step
    const wobble = noise ? ((i % 2 === 0 ? 1 : -1) * noise) : 0
    out.push({ ms, usedBytes: startUsed + (perDay * (i * step)) / DAY + wobble, totalBytes: total })
  }
  return out
}

// ---- the forecast, and its refusals -----------------------------------------------------------
{
  const f = forecast([], { now: NOW })
  check('no history: null, not zero', f.daysToFull === null && f.bytesPerDay === null && f.confident === false, JSON.stringify(f))
  check('...and it says why', /not enough history/.test(f.reason), f.reason)
}
{
  // Three samples an hour apart: real data, still not enough to extrapolate a week from.
  const f = forecast(series(2, { startUsed: 500e9, perDay: 50e9 }), { now: NOW, freeBytes: 500e9, totalBytes: TB, floorFreePct: 5 })
  check('a couple of hours of history: still null', f.daysToFull === null && f.confident === false, JSON.stringify(f))
}
{
  const s = series(24, { startUsed: 500e9, perDay: 50e9 })
  check('the sample set really is long enough for the test below', s.length > MIN_SAMPLES)
  const f = forecast(s, { now: NOW, freeBytes: 500e9 - 50e9, totalBytes: TB, floorFreePct: 5 })
  check('a day of steady growth: a growth rate', Math.abs(f.bytesPerDay - 50e9) < 1e9, String(f.bytesPerDay))
  // free 450 GB, floor 5% of 1 TB = 50 GB, headroom 400 GB at 50 GB/day = 8 days
  check('...and an honest days-to-full down to the floor, not to zero', Math.abs(f.daysToFull - 8) < 0.2, String(f.daysToFull))
  check('...and it is marked confident', f.confident === true)
}
{
  const f = forecast(series(48, { startUsed: 900e9, perDay: -20e9 }), { now: NOW, freeBytes: 100e9, totalBytes: TB })
  check('a drive being emptied: no forecast', f.daysToFull === null && f.confident === false && f.reason === 'not filling up', JSON.stringify(f))
}
{
  // A recycling drive: used bounces around a level. Fitting a line to that is guesswork.
  const f = forecast(series(72, { startUsed: 950e9, perDay: 1e9, noise: 40e9 }), { now: NOW, freeBytes: 50e9, totalBytes: TB })
  check('uneven usage: no forecast, and it says so', f.daysToFull === null && /uneven/.test(f.reason), JSON.stringify(f))
}
{
  const f = forecast(series(48, { startUsed: 500e9, perDay: 50e9, total: null }), { now: NOW, freeBytes: null, totalBytes: null })
  check('growth known but free space unknown: growth given, days null', Number.isFinite(f.bytesPerDay) === false || f.daysToFull === null, JSON.stringify(f))
}
{
  const old = series(24, { startUsed: 500e9, perDay: 50e9 }).map((s) => ({ ...s, ms: s.ms - 60 * DAY }))
  const f = forecast(old, { now: NOW, freeBytes: 450e9, totalBytes: TB })
  check('two-month-old samples are not evidence about today', f.daysToFull === null && /not enough history/.test(f.reason), JSON.stringify(f))
}
{
  const f = forecast(series(24, { startUsed: 950e9, perDay: 50e9 }), { now: NOW, freeBytes: 10e9, totalBytes: TB, floorFreePct: 5 })
  check('already below the floor: 0 days, not a negative one', f.daysToFull === 0, String(f.daysToFull))
}

// ---- the sample history ------------------------------------------------------------------------
{
  const h1 = recordSample(data, [{ id: 'L1', usedBytes: 100, totalBytes: 1000 }], NOW)
  check('a sample is stored', h1.L1?.length === 1 && h1.L1[0].usedBytes === 100, JSON.stringify(h1))
  const h2 = recordSample(data, [{ id: 'L1', usedBytes: 200, totalBytes: 1000 }], NOW + 60_000)
  check('at most one an hour', h2.L1.length === 1, JSON.stringify(h2))
  const h3 = recordSample(data, [{ id: 'L1', usedBytes: 300, totalBytes: 1000 }], NOW + HOUR + 1)
  check('an hour later: a second one', h3.L1.length === 2 && h3.L1[1].usedBytes === 300)
  check('it survives a reread', readHistory(data).L1?.length === 2)
  recordSample(data, [{ id: 'L2', usedBytes: null, totalBytes: 1000 }], NOW + 2 * HOUR)
  check('a location we could not measure stores nothing (no fake zero)', readHistory(data).L2 === undefined)
  writeFileSync(join(data, 'storage-history.json'), '{ this is not json')
  check('a corrupt history file is not a crash', Object.keys(readHistory(data)).length === 0)
  rmSync(join(data, 'storage-history.json'))
}
{
  // The samples are taken by the alert checks (server.mjs extraCandidates, every check; one an hour is kept),
  // not only when an admin opens the Storage page: an unattended server never had enough of them to forecast
  // from, and production's file was a week old (audit of 2026-10-07, M11). What the checks do, here: the report
  // as they build it, its locations handed to recordSample.
  const settings = { recording: { defaults: {}, cameras: {} }, storage: { locations: [{ id: 'L1', path: '/srv/rec/usb1', type: 'usb', role: 'main' }, { id: 'L2', path: '/srv/rec/nas', type: 'network', role: 'main' }], lowFreePct: 15, floorFreePct: 5 } }
  const checkAt = (now, free) => {
    const report = buildStorageReport({ settings, index: null, history: readHistory(data), now, present: (l) => l.id === 'L1', freeOf: () => ({ freeBytes: free, totalBytes: 1000 }), retention: null })
    recordSample(data, report.locations, now)
    return report
  }
  for (let i = 0; i < 60; i++) checkAt(NOW + i * 60_000, 900 - i)
  const h = readHistory(data)
  check('the alert checks take the samples: 60 checks in an hour keep one, of the mounted location only', h.L1?.length === 1 && h.L1[0].usedBytes === 100 && h.L1[0].totalBytes === 1000 && h.L2 === undefined, JSON.stringify(h))
  for (let i = 1; i <= MIN_SAMPLES; i++) checkAt(NOW + i * HOUR + 1, 900 - 10 * i)
  const later = checkAt(NOW + (MIN_SAMPLES + 1) * HOUR, 900 - 10 * (MIN_SAMPLES + 1))
  check('... and with nobody opening the page, the history grows by one an hour and the report reads it', readHistory(data).L1.length === MIN_SAMPLES + 1 && later.locations[0].forecast.samples === MIN_SAMPLES + 1, JSON.stringify(later.locations[0].forecast))
  rmSync(join(data, 'storage-history.json'))
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const body = server.match(/extraCandidates: \(\) => \{[\s\S]*?\n  \},/)?.[0] ?? ''
  check('server.mjs: the alert checks hand the report\'s locations to recordSample', /const report = buildStorageReport\(/.test(body) && /recordSample\(DATA_DIR, report\.locations\)/.test(body) && /import \{[^}]*\brecordSample\b[^}]*\} from '\.\/storage-report\.mjs'/.test(server), body.slice(0, 200))
}

// ---- the report ---------------------------------------------------------------------------------
const DEFAULTS = { mode: 'continuous', fullDays: 30, after: 'timelapse', timelapseS: 10, retentionDays: 180, preS: 10, postS: 20 }
const L1 = { id: 'L1', path: '/srv/rec/usb1', type: 'usb', role: 'main', limitGB: null }
const L2 = { id: 'L2', path: '/srv/rec/nas', type: 'network', role: 'overflow', limitGB: null }
const settings = (locs = [L1], cameras = {}) => ({ recording: { defaults: DEFAULTS, cameras }, storage: { locations: locs, lowFreePct: 15, floorFreePct: 5 } })

/** A stand-in for rec-index.mjs with just the calls the report makes. */
const fakeIndex = (segs) => ({
  cameras: () => [...new Map(segs.map((s) => [`${s.nvr}/${s.ch}`, { nvr: s.nvr, ch: s.ch }])).values()],
  first: (nvr, ch) => segs.filter((s) => s.nvr === nvr && s.ch === ch).sort((a, b) => a.startMs - b.startMs)[0] ?? null,
  lastSegmentEnd: (nvr, ch) => {
    const mine = segs.filter((s) => s.nvr === nvr && s.ch === ch)
    return mine.length ? Math.max(...mine.map((s) => s.endMs)) : null
  },
  oldestOf: (nvr, ch, loc, limit) => segs.filter((s) => s.nvr === nvr && s.ch === ch && s.loc === loc).sort((a, b) => a.startMs - b.startMs).slice(0, limit)
})

const seg = (nvr, ch, ageDays, loc = 'L1') => ({ nvr, ch, loc, path: `/srv/rec/${nvr}-${ch}-${ageDays}`, startMs: NOW - ageDays * DAY, endMs: NOW - ageDays * DAY + 60_000, bytes: 1000, keyframes: 60 })

{
  const index = fakeIndex([seg('n1', 0, 200), seg('n1', 0, 1), seg('n1', 1, 10), seg('n1', 1, 0)])
  const r = buildStorageReport({
    settings: settings(),
    index,
    history: { L1: series(24, { startUsed: 500e9, perDay: 50e9 }) },
    now: NOW,
    freeOf: () => ({ freeBytes: 450e9, totalBytes: TB }),
    present: () => true
  })
  const loc = r.locations[0]
  check('used/free/total per location', loc.usedBytes === 550e9 && loc.freeBytes === 450e9 && loc.usedPct === 55, JSON.stringify({ u: loc.usedBytes, p: loc.usedPct }))
  const n10 = loc.cameras.find((c) => c.camera === 'n1/0')
  check('days kept per camera on that location', Math.abs(n10.daysKept - 200) < 0.1, String(n10.daysKept))
  check('...against the camera target', n10.targetDays === 180 && n10.meetsTarget === true)
  const n11 = loc.cameras.find((c) => c.camera === 'n1/1')
  check('a camera short of its target is marked, not hidden', n11.meetsTarget === false && Math.abs(n11.daysKept - 10) < 0.1)
  check('growth per day is reported', Math.abs(loc.forecast.bytesPerDay - 50e9) < 1e9, String(loc.forecast.bytesPerDay))
  check('full in N days is reported', loc.forecast.confident && loc.forecast.daysToFull > 0)
  check('a location with footage past a target counts as recycling', loc.cycling === true)
  check('each camera\'s days kept overall: from its oldest footage on a mounted location', Math.abs(r.cameras.find((c) => c.camera === 'n1/0').daysKept - 200) < 0.1 && r.cameras.find((c) => c.camera === 'n1/0').meetsTarget === true && r.cameras.find((c) => c.camera === 'n1/1').meetsTarget === false && r.cameras.find((c) => c.camera === 'n1/1').oldestMs === NOW - 10 * DAY, JSON.stringify(r.cameras))
}
{
  // Rows on a location that is not mounted, or was removed from the list, stay in the index. A camera's days
  // kept counted from the oldest of all of them: with production's NAS removed on 1 October the figure grew a
  // day per day on footage nobody can play (audit of 2026-10-07). It is the oldest on the mounted locations.
  const index = fakeIndex([seg('n1', 0, 60, 'GONE'), seg('n1', 0, 40, 'L2'), seg('n1', 0, 5, 'L1'), seg('n1', 1, 50, 'GONE'), seg('n1', 1, 30, 'L2')])
  const r = buildStorageReport({ settings: settings([L1, L2]), index, history: {}, now: NOW, freeOf: () => ({ freeBytes: 450e9, totalBytes: TB }), present: (l) => l.id === 'L1', retention: null })
  const c0 = r.cameras.find((c) => c.camera === 'n1/0')
  const c1 = r.cameras.find((c) => c.camera === 'n1/1')
  check('DAYS KEPT PER CAMERA: the oldest on the mounted locations (5 days), not a removed location\'s (60) or an unmounted one\'s (40)', Math.abs(c0.daysKept - 5) < 0.1 && c0.oldestMs === NOW - 5 * DAY && c0.meetsTarget === false, JSON.stringify(c0))
  check('... a camera with footage only where it cannot be played: not available, never a number', c1.daysKept === null && c1.oldestMs === null && c1.meetsTarget === null && Number.isFinite(c1.newestMs), JSON.stringify(c1))
  const both = buildStorageReport({ settings: settings([L1, L2]), index, history: {}, now: NOW, freeOf: () => ({ freeBytes: 450e9, totalBytes: TB }), present: () => true, retention: null })
  check('... with the second location mounted again, its footage counts (40 and 30 days)', Math.abs(both.cameras.find((c) => c.camera === 'n1/0').daysKept - 40) < 0.1 && Math.abs(both.cameras.find((c) => c.camera === 'n1/1').daysKept - 30) < 0.1, JSON.stringify(both.cameras.map((c) => c.daysKept)))
}
{
  const r = buildStorageReport({ settings: settings([L1]), index: fakeIndex([]), history: {}, now: NOW, freeOf: () => ({ freeBytes: 1, totalBytes: 2 }), present: () => false })
  const loc = r.locations[0]
  check('an unmounted location reports nothing as a figure', loc.mounted === false && loc.usedBytes === null && loc.freeBytes === null && loc.forecast.daysToFull === null, JSON.stringify(loc))
  check('...and says why in the warnings', r.warnings.some((w) => /not mounted/.test(w)))
}
{
  const r = buildStorageReport({ settings: settings([L1]), index: null, history: {}, now: NOW, freeOf: () => ({ freeBytes: 1e9, totalBytes: 2e9 }), present: () => true })
  check('no index: figures that need it are absent, no crash', r.locations[0].cameras.length === 0 && r.locations[0].cycling === null && r.warnings.some((w) => /index/.test(w)))
}
{
  const r = buildStorageReport({
    settings: settings([L1]),
    index: fakeIndex([]),
    history: {},
    now: NOW,
    freeOf: () => {
      throw new Error('statfs said no')
    },
    present: () => true
  })
  check('a location we cannot stat: nulls and a warning, never zeroes', r.locations[0].usedBytes === null && r.locations[0].usedPct === null && r.warnings.some((w) => /statfs said no/.test(w)))
}

// ---- each location's space limit and own marks (the owner's 12,000 GB of the NAS, 2026-09-29) ----------
{
  const NAS = { ...L2, role: 'main', limitGB: 12_000, limitSetAt: '2026-09-29T12:00:00.000Z', lowFreePct: 7, floorFreePct: 4 }
  const index = { ...fakeIndex([seg('n1', 0, 3, 'L2')]), locationUse: (loc) => ({ bytes: loc === 'L2' ? 5_512e9 : 0, segments: 1 }) }
  const alarms = [{ id: 'L2', path: NAS.path, kind: 'limit-blocked', text: `${NAS.path}: over its 12,000 GB limit (12,100.0 GB held), but everything left there is from the newest 24 h: kept.` }]
  const r = buildStorageReport({ settings: settings([L1, NAS]), index, history: {}, now: NOW, freeOf: () => ({ freeBytes: 7.7e12, totalBytes: 16.63e12 }), present: () => true, alarms })
  const nas = r.locations.find((l) => l.id === 'L2')
  check('a location\'s own marks are its row\'s (the report\'s defaults stay the settings\')', nas.lowFreePct === 7 && nas.floorFreePct === 4 && r.locations[0].lowFreePct === 15 && r.lowFreePct === 15, JSON.stringify({ low: nas.lowFreePct, floor: nas.floorFreePct }))
  check('Argus\'s bytes there (the index\'s count) and the limit in bytes (1 GB = 1,000,000,000 bytes)', nas.argusBytes === 5_512e9 && nas.limitBytes === 12_000e9 && r.locations[0].limitBytes === null, JSON.stringify({ a: nas.argusBytes, l: nas.limitBytes }))
  check('... enforced: saved through this code (limitSetAt)', nas.limitEnforced === true && r.locations[0].limitEnforced === false, JSON.stringify({ nas: nas.limitEnforced, l1: r.locations[0].limitEnforced }))
  const old = buildStorageReport({ settings: settings([{ ...L1, limitGB: 500 }]), index, history: {}, now: NOW, freeOf: () => ({ freeBytes: 7.7e11, totalBytes: 1e12 }), present: () => true }).locations[0]
  check('a limit saved before it was enforced (no limitSetAt): shown, not enforced', old.limitBytes === 500e9 && old.limitEnforced === false, JSON.stringify({ l: old.limitBytes, e: old.limitEnforced }))
  check('housekeeping\'s alarm for the location is in the warnings and on its row', r.warnings.some((w) => /newest 24 h/.test(w)) && nas.alarms.length === 1, JSON.stringify(r.warnings))
}

// ---- the alert candidate ------------------------------------------------------------------------
const reportWith = (o) => ({ locations: [{ id: 'L1', path: '/srv/rec/usb1', mounted: true, usedPct: 90, cycling: false, forecast: { bytesPerDay: 50e9, daysToFull: 3, confident: true, reason: '' }, ...o }] })
{
  const c = driveFullCandidates(reportWith({}))
  check('forecast full in 3 days: one candidate', c.length === 1 && c[0].kind === 'drive-filling' && c[0].key === 'drive-filling/L1', JSON.stringify(c))
  check('...and it says when and why', /3 days/.test(c[0].title) && /recycling/.test(c[0].detail), JSON.stringify(c[0]))
}
check('forecast full in 20 days: nothing', driveFullCandidates(reportWith({ forecast: { bytesPerDay: 1e9, daysToFull: 20, confident: true, reason: '' } })).length === 0)
check('THE IMPORTANT ONE: a recycling drive never alerts, however full', driveFullCandidates(reportWith({ cycling: true, usedPct: 99, forecast: { bytesPerDay: 50e9, daysToFull: 0.5, confident: true, reason: '' } })).length === 0)
check('no confidence, no alert', driveFullCandidates(reportWith({ forecast: { bytesPerDay: 50e9, daysToFull: 2, confident: false, reason: 'usage is too uneven to extrapolate' } })).length === 0)
check('no forecast at all, no alert', driveFullCandidates(reportWith({ forecast: { bytesPerDay: null, daysToFull: null, confident: false, reason: 'not enough history yet' } })).length === 0)
check('an unmounted drive is left to drive-missing', driveFullCandidates(reportWith({ mounted: false })).length === 0)
check('cycling unknown (no footage indexed there) still alerts only on a confident forecast', driveFullCandidates(reportWith({ cycling: null })).length === 1)

// ---- days kept against the target (retention-target.mjs, 2026-09-30, p4-target) -------------------------
// The NAS at its 12,000 GB limit keeps 8.2 days; one camera is set to keep 7 days and has them, so the location
// counts as "cycling", and the drive-filling forecast rightly stays quiet about a drive that is full and
// overwriting. That line ("overwriting its own oldest footage: normal, never alert") must not hide that the
// other camera wants 180 days and gets 8.2.
const { retentionCandidates, wholeDays } = await import('../retention-target.mjs')
const nasFacts = (now = NOW) => ({
  at: now,
  stepMs: 10_000,
  keyframeShare: { low: 0.43, mid: 0.5, high: 0.56 },
  protection: 'ranges',
  warnings: [],
  days: wholeDays(now).map((d) => ({ ...d, rows: [0, 1].map((ch) => ({ loc: 'L2', nvr: 'n1', ch, files: 1440, bytes: 0.735e12, ms: 1440 * 59_000, weighted: 0.147e12 })) })),
  locations: { L2: { id: 'L2', anyOldestMs: now - 8.2 * DAY, oldestMs: now - 8.2 * DAY, timelapse: null, fullFromMs: now - 8.2 * DAY, sample: [] } }
})
const NAS12 = { ...L2, role: 'main', limitGB: 12_000, limitSetAt: '2026-09-29T12:00:00.000Z', lowFreePct: 7, floorFreePct: 5 }
{
  const cams = { 'n1/0': { retentionDays: 7, fullDays: 7 } }
  const index = { ...fakeIndex([seg('n1', 0, 7.5, 'L2'), seg('n1', 1, 8.2, 'L2'), seg('n1', 0, 0, 'L2'), seg('n1', 1, 0, 'L2')]), locationUse: (loc) => ({ bytes: loc === 'L2' ? 12_000e9 : 0, segments: 4 }) }
  const r = buildStorageReport({
    settings: { ...settings([NAS12], cams), storage: { ...settings([NAS12]).storage, thinning: 'dry-run' } },
    index,
    history: { L2: series(48, { startUsed: 14.5e12, perDay: 0.2e12, total: 16.63e12 }) },
    now: NOW,
    freeOf: () => ({ freeBytes: 1.19e12, totalBytes: 16.63e12 }),
    present: () => true,
    retention: nasFacts()
  })
  const l = r.retention.locations.L2
  check('THE REPORT CARRIES THE DAYS KEPT AGAINST THE TARGET: 8.2 days at the limit, against 180', r.retention.available && l.recycling === 'limit' && Math.abs(l.daysKept - 8.2) < 0.01 && l.targetDays === 180 && l.short.actual === true, JSON.stringify({ recycling: l.recycling, daysKept: l.daysKept, target: l.targetDays, short: l.short }))
  check('... from the report\'s own figures for the location (Argus\'s bytes, free space, the limit)', l.capacity.heldBytes === 12_000e9 && l.capacity.limitBytes === 12_000e9 && Math.abs(l.capacity.lowBytes - (12_000e9 + 1.19e12 - 0.07 * 16.63e12)) < 1, JSON.stringify(l.capacity))
  check('... the location counts as cycling (a camera has reached its own 7 days)', r.locations[0].cycling === true)
  const wouldFill = driveFullCandidates({ ...r, locations: r.locations.map((x) => ({ ...x, cycling: false })) })
  check('... its free space forecast would say "full" were it not cycling', wouldFill.length === 1, JSON.stringify(r.locations[0].forecast))
  const df = driveFullCandidates(r)
  const rc = retentionCandidates(r)
  check('THE SHORTFALL IS NOT HIDDEN BY RECYCLING: drive-filling stays quiet, retention-short speaks', df.length === 0 && rc.length === 1 && rc[0].kind === 'retention-short' && rc[0].key === 'retention-short/L2' && /180-day target/.test(rc[0].title), JSON.stringify({ df, rc }))
  const unread = { ...nasFacts(), protection: 'unread', warnings: ['the bookmarks could not be read (database is locked): the oldest footage counted may be a bookmarked stretch'] }
  const withUnread = buildStorageReport({ settings: settings([NAS12], cams), index, history: {}, now: NOW, freeOf: () => ({ freeBytes: 1.19e12, totalBytes: 16.63e12 }), present: () => true, retention: unread })
  check('... bookmarks that could not be read when it was measured: said in the page\'s warnings', withUnread.warnings.some((w) => /days kept: the bookmarks could not be read/.test(w)), JSON.stringify(withUnread.warnings))
  const none = buildStorageReport({ settings: settings([NAS12]), index, history: {}, now: NOW, freeOf: () => ({ freeBytes: 1.19e12, totalBytes: 16.63e12 }), present: () => true, retention: null })
  check('... nothing measured yet: the report says so, no candidate', none.retention.available === false && retentionCandidates(none).length === 0, JSON.stringify(none.retention.reason))
}

// ---- the route ------------------------------------------------------------------------------------
{
  const json = async () => ({})
  setStorageContext({ index: null, dataDir: data, settingsOf: () => settings([L1]) })
  check('an unrelated path is not ours', (await handleStorage('GET', '/api/health', json, 'boss')) === null)
  const [s403] = await handleStorage('GET', '/api/storage', json, 'viewer')
  check('non-admins get 403', s403 === 403)
  const [s405] = await handleStorage('POST', '/api/storage', json, 'boss')
  check('only GET', s405 === 405)
  const [s200, body] = await handleStorage('GET', '/api/storage', json, 'boss')
  check('admins get the report', s200 === 200 && Array.isArray(body.locations) && Array.isArray(body.warnings), JSON.stringify(body).slice(0, 120))
  check('... with the days kept against the target (not measured yet here: said in words)', body.retention?.available === false && typeof body.retention.reason === 'string', JSON.stringify(body.retention))
}
{
  // The route read the share itself: its marker (readFileSync) and its free space (statfsSync), on the main
  // thread, at every Storage page's minute. server.mjs hands it storage.mjs's answers from the last check.
  const json = async () => ({})
  const share = { id: 'L9', path: join(data, 'no-such-share'), type: 'network', role: 'main' }
  let asked = 0
  setStorageContext({ index: null, dataDir: data, settingsOf: () => settings([share]), present: (l) => (asked++, l.id === 'L9'), freeOf: () => ({ freeBytes: 7e12, totalBytes: 16e12 }) })
  const [, body] = await handleStorage('GET', '/api/storage', json, 'boss')
  check('THE ROUTE ASKS STORAGE.MJS, NOT THE SHARE: the marker and free space from the context (the folder is not even there)', body.locations[0].mounted === true && body.locations[0].freeBytes === 7e12 && asked >= 1, JSON.stringify(body.locations[0]).slice(0, 200))
  setStorageContext({ index: null, dataDir: data, settingsOf: () => settings([L1]) })
}

// ---- the time-lapse and retention switch, and what the jobs last did (storage-jobs.mjs) ---------------
{
  const json = async () => ({})
  const { runStorageJobs, _test: jobs } = await import('../storage-jobs.mjs')
  jobs.reset()
  const withSwitch = (thinning, cameras = {}) => {
    const s = settings([L1], cameras)
    if (thinning !== undefined) s.storage.thinning = thinning
    return s
  }
  // n1/3 keeps its own full days; n1/4 only records differently, which is not "days of its own"
  setStorageContext({ index: null, dataDir: data, settingsOf: () => withSwitch('on', { 'n1/3': { fullDays: 14 }, 'n1/4': { mode: 'off' } }) })
  let [, body] = await handleStorage('GET', '/api/storage', json, 'boss')
  check('the report carries the switch as set', body.jobs?.mode === 'on', JSON.stringify(body.jobs))
  check('...the days the jobs work from', body.jobs.defaults.fullDays === 30 && body.jobs.defaults.retentionDays === 180 && body.jobs.defaults.timelapseS === 10 && body.jobs.defaults.after === 'timelapse', JSON.stringify(body.jobs.defaults))
  check('...how many cameras have days of their own', body.jobs.camerasOwnDays === 1, body.jobs.camerasOwnDays)
  check('...and no last run before there has been one', body.jobs.thinning === null && body.jobs.retention === null)
  // the pace as it is now, its ceiling included (a fresh start: half the most, a step up after each clean night;
  // review of p3-thin, round 2), so an admin reads it before switching On
  check('...and how fast and when time-lapse is written, as it is now (thin-pace.mjs)', body.jobs.pace === '20 MB/s (up to 40 MB/s: it rises by 5 MB/s after each night of rounds with no "disk too slow"), 3 files at a time; nights 20:00-06:00 site time', body.jobs.pace)
  await runStorageJobs({
    mode: 'dry-run',
    index: {},
    jobs: { thinning: async () => ({ thinned: [{}, {}], skipped: [], warnings: [], freedBytes: 2e9 }), retention: async () => ({ deleted: [], skipped: [], warnings: [], freedBytes: 0 }) },
    args: () => ({}),
    log: () => {},
    warn: () => {}
  })
  ;[, body] = await handleStorage('GET', '/api/storage', json, 'boss')
  check('after a run the report carries what each job did', body.jobs.thinning?.segments === 2 && body.jobs.thinning.mode === 'dry-run' && body.jobs.retention?.segments === 0, JSON.stringify(body.jobs))
  setStorageContext({ index: null, dataDir: data, settingsOf: () => withSwitch(undefined) })
  ;[, body] = await handleStorage('GET', '/api/storage', json, 'boss')
  check('settings without the switch read as dry run', body.jobs.mode === 'dry-run')
  jobs.reset()
}

// ---- the page's pure render ------------------------------------------------------------------------
check('bytes: null is words, not a zero', bytes(null) === NOT_AVAILABLE && bytes(undefined) === NOT_AVAILABLE && bytes(Number.NaN) === NOT_AVAILABLE)
check('bytes: a figure', bytes(1_400_000_000) === '1.4 GB' && bytes(0) === '0 B', bytes(1_400_000_000))
check('days: null is words', days(null) === NOT_AVAILABLE && days(3) === '3 days' && days(1) === '1 day' && days(0.5) === 'less than a day')
{
  const c = forecastCell({ bytesPerDay: null, daysToFull: null, confident: false, reason: 'not enough history yet' })
  check('a forecast with no history reads "not available" and explains', c.value === NOT_AVAILABLE && /not enough history/.test(c.note), JSON.stringify(c))
}
{
  const c = forecastCell({ bytesPerDay: 1e9, daysToFull: 3, confident: true, reason: '' })
  check('a near forecast is marked bad', c.value === 'full in 3 days' && c.state === 'bad', JSON.stringify(c))
}
{
  const c = forecastCell({ bytesPerDay: -1, daysToFull: null, confident: false, reason: 'not filling up' })
  check('a drive that is not filling up says so, without a date', c.value === NOT_AVAILABLE && /recycling/.test(c.note), JSON.stringify(c))
}
{
  const r = renderStorage({
    locations: [
      {
        id: 'L1', path: '/srv/rec/usb1', type: 'usb', role: 'main', mounted: true,
        usedBytes: 550e9, freeBytes: 450e9, totalBytes: TB, usedPct: 55, freePct: 45, lowFreePct: 15, floorFreePct: 5,
        cycling: true, forecast: { bytesPerDay: 50e9, daysToFull: 8, confident: true, reason: '' },
        cameras: [{ camera: 'n1/0', daysKept: 200, targetDays: 180, meetsTarget: true }, { camera: 'n1/1', daysKept: 10, targetDays: 180, meetsTarget: false }]
      }
    ],
    warnings: ['something to say']
  })
  const l = r.locations[0]
  check('render: used shown as a percentage with the raw figures underneath', l.usedPct === '55 %' && l.used === '550 GB of 1.0 TB', JSON.stringify({ p: l.usedPct, u: l.used }))
  check('render: growth per day', l.growth === '50.0 GB a day', l.growth)
  check('render: the forecast', l.forecast.value === 'full in 8 days', l.forecast.value)
  check('render: recycling is stated as normal, not as a fault', /as designed/.test(l.recycling), l.recycling)
  check('render: a camera short of target is a warning, not an error', l.cameras[1].state === 'warn' && /170 days short/.test(l.cameras[1].short), JSON.stringify(l.cameras[1]))
  check('render: warnings come through', r.warnings[0] === 'something to say')
  check('render: totals', r.totals.mounted === 1 && r.totals.used === '550 GB')
}
{
  const r = renderStorage({ locations: [{ id: 'L1', path: '/p', mounted: false, usedBytes: null, freeBytes: null, totalBytes: null, usedPct: null, cameras: [] }] })
  const l = r.locations[0]
  check('render: an unmounted drive is words everywhere, never 0', l.status.value === 'Not mounted' && l.used === NOT_AVAILABLE && l.usedPct === NOT_AVAILABLE && l.free === NOT_AVAILABLE && l.growth === NOT_AVAILABLE)
}
{
  // Argus's recordings against the location's space limit (1 GB = 1,000,000,000 bytes), and that it is enforced
  const { limitCell, LIMIT_TEXT } = await import('../public/storage.js')
  const at = (argusBytes, limitBytes, limitEnforced = true) => renderStorage({ locations: [{ id: 'L2', path: '/srv/cctv-net/nas', type: 'network', role: 'main', mounted: true, usedBytes: 8.9e12, freeBytes: 7.73e12, totalBytes: 16.63e12, usedPct: 53.5, freePct: 46.5, lowFreePct: 7, floorFreePct: 4, argusBytes, limitBytes, limitEnforced, cameras: [] }] }).locations[0]
  const l = at(5_512e9, 12_000e9)
  check('render: Argus\'s recordings against the limit, in whole GB, enforced', l.limit.value === '5,512 GB' && l.limit.note === 'of the 12,000 GB limit (enforced), 46 %' && l.limit.state === 'ok', JSON.stringify(l.limit))
  check('render: ... near the limit (95 %) a warning, over it bad', at(11_500e9, 12_000e9).limit.state === 'warn' && at(12_100e9, 12_000e9).limit.state === 'bad')
  check('render: ... the line that says it is enforced and how, with what a GB is', l.limitText === LIMIT_TEXT && /enforced/.test(LIMIT_TEXT) && /newest 24 hours/.test(LIMIT_TEXT) && /bookmarked/.test(LIMIT_TEXT) && /1 GB = 1,000,000,000 bytes/.test(LIMIT_TEXT), l.limitText)
  check('render: the enforcing line says how much one clean-up takes at most (review of p2-delete)', /every 5 minutes/.test(LIMIT_TEXT) && /240 GB/.test(LIMIT_TEXT) && !/within 5 minutes/.test(LIMIT_TEXT), LIMIT_TEXT)
  const notYet = at(5_512e9, 12_000e9, false)
  check('render: a limit saved before it was enforced: shown as not enforced, how to enforce it, and no enforcing line', /not enforced/.test(notYet.limit.note) && /save/i.test(notYet.limit.note) && notYet.limit.state === 'ok' && notYet.limitText === '', JSON.stringify(notYet.limit))
  const none = at(5_512e9, null)
  check('render: no limit set: the figure, and no enforcement line', none.limit.value === '5,512 GB' && /no space limit/.test(none.limit.note) && none.limitText === '', JSON.stringify(none.limit))
  check('render: Argus\'s bytes not known: words, not 0', limitCell({ argusBytes: null, limitBytes: 12_000e9 }).value === NOT_AVAILABLE)
  check('render: the location\'s own marks colour its use', at(5_512e9, 12_000e9).usedState === 'ok' && renderStorage({ locations: [{ id: 'x', path: '/p', mounted: true, usedBytes: 94, freeBytes: 6, totalBytes: 100, usedPct: 94, freePct: 6, lowFreePct: 7, floorFreePct: 4, cameras: [] }] }).locations[0].usedState === 'warn')
}
{
  // Settings > Storage, a location's card: its limit and own marks, and the question asked before a limit
  // that could delete footage at once
  const { locationEdit } = await import('../public/storage.js')
  const nas = { id: 'nas-1', path: '/srv/cctv-net/nas', limitGB: null, lowFreePct: null, floorFreePct: null }
  const e1 = locationEdit(nas, { limitGB: '12000', lowFreePct: '7', floorFreePct: '' })
  check('edit: what is sent (empty is the default / no limit)', JSON.stringify(e1.body) === JSON.stringify({ action: 'set', id: 'nas-1', limitGB: 12000, lowFreePct: 7, floorFreePct: null }) && !e1.error, JSON.stringify(e1))
  check('edit: a new limit is asked about first: enforced, what goes and what never does, for good', /12,000 GB/.test(e1.ask) && /enforced/.test(e1.ask) && /oldest/.test(e1.ask) && /newest 24 hours/.test(e1.ask) && /bookmarked/.test(e1.ask) && /cannot be brought back/.test(e1.ask) && /1 GB = 1,000,000,000 bytes/.test(e1.ask), e1.ask)
  const set = { ...nas, limitGB: 12000, limitEnforced: true }
  check('edit: a lower limit is asked about; a higher one, the same one, or none is not', !!locationEdit(set, { limitGB: '11000' }).ask && !locationEdit(set, { limitGB: '13000' }).ask && !locationEdit(set, { limitGB: '12000' }).ask && !locationEdit(set, { limitGB: '' }).ask)
  // a card saved for its marks sends no limit when the limit is as it was (the server would otherwise
  // check it against a share's size, unknown while it is unmounted: review of p2-delete)
  const enforced = { ...set, limitEnforced: true }
  const same = locationEdit(enforced, { limitGB: '12000', lowFreePct: '7', floorFreePct: '' })
  check('edit: the limit as it was is not sent, nor asked about; the marks are', !('limitGB' in same.body) && !same.ask && same.body.lowFreePct === 7, JSON.stringify(same))
  check('edit: a changed limit is sent', locationEdit(enforced, { limitGB: '13000' }).body.limitGB === 13000 && locationEdit(enforced, { limitGB: '' }).body.limitGB === null)
  const notYet = locationEdit({ ...set, limitEnforced: false }, { limitGB: '12000' })
  check('edit: a limit saved before it was enforced, saved as it is: sent, and asked about (it starts deleting)', notYet.body.limitGB === 12000 && /enforced/.test(notYet.ask ?? ''), JSON.stringify(notYet))
  check('edit: the question says how much one clean-up takes at most', /every 5 minutes/.test(e1.ask) && /240 GB/.test(e1.ask) && !/within 5 minutes/.test(e1.ask), e1.ask)
  check('edit: a limit that is not a positive number is refused on the page', /positive/.test(locationEdit(nas, { limitGB: '-3' }).error ?? '') && /positive/.test(locationEdit(nas, { limitGB: 'lots' }).error ?? ''))
  check('edit: marks that are not whole numbers 1-50 refused on the page', /whole number/.test(locationEdit(nas, { lowFreePct: '7.5' }).error ?? '') && /whole number/.test(locationEdit(nas, { floorFreePct: '0' }).error ?? ''))
}
check('render: nothing configured is not a crash', renderStorage({}).empty === true && renderStorage(null).empty === true)
{
  // the days kept and the forecast on each location's panel, and one line for all of them
  const { retentionView } = await import('../retention-target.mjs')
  const row = { id: 'L2', path: NAS12.path, type: 'network', role: 'main', mounted: true, usedBytes: 15.44e12, freeBytes: 1.19e12, totalBytes: 16.63e12, usedPct: 92.8, freePct: 7.2, lowFreePct: 7, floorFreePct: 5, argusBytes: 12_000e9, limitBytes: 12_000e9, limitEnforced: true, cameras: [] }
  const facts = nasFacts()
  facts.locations.L2.sample = [0, 1].map((ch) => ({ nvr: 'n1', ch, files: 24, bytes: ((24 * 0.735e12) / 1440) * 0.104, ms: 24 * 59_000 }))
  const s = { ...settings([NAS12], {}), recording: { defaults: { ...DEFAULTS, fullDays: 7, retentionDays: 30 }, cameras: {} } }
  s.storage.thinning = 'dry-run'
  const retention = retentionView({ facts, settings: s, locations: [row], now: NOW, memory: new Set() })
  const r = renderStorage({ locations: [row], retention })
  const l = r.locations[0]
  check('render: days kept, against the target, bad when short at its limit', l.kept.value === '8.2 days' && l.kept.state === 'bad' && /target 30 days/.test(l.kept.note), JSON.stringify(l.kept))
  check('render: the days that fit, with the volume, the date, and what time-lapse On would give', l.fit.value === 'about 8.2 days' && l.fit.state === 'bad' && /1\.5 TB a day/.test(l.fit.note) && /12,000 GB limit reached/.test(l.fit.note) && /With time-lapse On: about 18\.2 days/.test(l.fit.note), JSON.stringify(l.fit))
  check('render: how the time-lapse was sized, in words', /time-lapse 10\.4 % of full video, measured from 48 real time-lapse files/.test(l.fit.note), l.fit.note)
  check('render: "Recycling" says it recycles for space (its "cycling" only knows a camera at its target)', l.recycling === 'yes, for space' && l.recyclingNote === 'deleting to stay at its space limit' && l.recyclingState === 'bad', JSON.stringify([l.recycling, l.recyclingNote, l.recyclingState]))
  // room enough: both answers the whole 30 days, so no "with time-lapse On" beside it, nor the time-lapse's size
  const roomy = { ...row, cycling: false, argusBytes: 3e12, limitBytes: 50_000e9, freeBytes: 60e12, totalBytes: 70e12 }
  const fits = renderStorage({ locations: [roomy], retention: retentionView({ facts: nasFacts(), settings: s, locations: [roomy], now: NOW, memory: new Set() }) }).locations[0]
  check('render: where the target fits either way, neither "with time-lapse On" nor the time-lapse\'s size', fits.fit.value === 'all 30 days' && !/time-lapse On/.test(fits.fit.note) && !/of full video,/.test(fits.fit.note) && fits.recycling === 'not yet', JSON.stringify(fits.fit))
  const est = { ...facts, locations: { L2: { ...facts.locations.L2, sample: [] } } }
  const estNote = renderStorage({ locations: [row], retention: retentionView({ facts: est, settings: s, locations: [row], now: NOW, memory: new Set() }) }).locations[0].fit.note
  check('render: an estimate says so, with its range', /time-lapse about 10 % of full video, an estimate from its keyframes \(8\.6-11\.2 %\)/.test(estNote), estNote)
  check('render: one line for all locations', /Footage goes back 8\.2 days/.test(r.target) && /30-day target/.test(r.target) && /Short of it/.test(r.target) && r.target.includes(NAS12.path), r.target)
  const notYet = renderStorage({ locations: [row], retention: { available: false, reason: 'not measured yet: every 5 minutes, the first a minute after the server starts', locations: {} } })
  check('render: not measured yet: words, not a figure', notYet.locations[0].kept.value === NOT_AVAILABLE && /not measured yet/.test(notYet.locations[0].kept.note) && /not measured yet/.test(notYet.target), JSON.stringify(notYet.locations[0].kept))
  const tlOnly = { ...facts, locations: { L2: { ...facts.locations.L2, timelapse: { oldestMs: NOW - 8.2 * DAY, newestMs: NOW - 2 * DAY }, fullFromMs: null } } }
  const tlNote = renderStorage({ locations: [row], retention: retentionView({ facts: tlOnly, settings: s, locations: [row], now: NOW, memory: new Set() }) }).locations[0].kept.note
  check('render: time-lapse with no full video after it (a location recording goes elsewhere now): said so', /time-lapse 6\.2 days, no full video after it/.test(tlNote), tlNote)
  const older = renderStorage({ locations: [row] })
  check('render: an older server (no retention in the answer): no crash, nothing claimed', older.locations[0].kept.value === NOT_AVAILABLE && older.target === '', JSON.stringify(older.locations[0].kept))
}
check('render: a camera whose days we cannot say gets no colour', renderStorage({ locations: [{ id: 'L', path: '/p', mounted: true, usedBytes: 1, freeBytes: 1, totalBytes: 2, usedPct: 50, freePct: 50, cameras: [{ camera: 'c', daysKept: null, targetDays: null, meetsTarget: null }] }] }).locations[0].cameras[0].state === '')

// ---- the switch and the last runs, as the page says them ---------------------------------------------
{
  const { jobsView, switchOnWarning, THINNING_CHOICES } = await import('../public/storage.js')
  const at = Date.UTC(2026, 9, 2, 20, 5, 0)
  const hhmm = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const run = (o) => ({ job: 'thinning', mode: 'dry-run', dryRun: true, at, tookMs: 900, segments: 0, bytes: 0, skipped: 0, skippedWhy: [], warnings: [], warningCount: 0, limit: 2000, reachedLimit: false, protection: 'ranges', error: null, ...o })
  const base = { mode: 'dry-run', defaults: { after: 'timelapse', fullDays: 7, timelapseS: 10, retentionDays: 30 }, camerasOwnDays: 0, thinning: null, retention: null }
  const view = (o, now = at + 60_000) => jobsView({ ...base, ...o }, { now })

  check('the three choices, in the owner\'s words', THINNING_CHOICES.map((c) => c.value).join() === 'dry-run,on,off' &&
    /Dry run — shows what it would do, changes nothing/.test(THINNING_CHOICES[0].text) && /On — converts and deletes as set/.test(THINNING_CHOICES[1].text) && THINNING_CHOICES[2].text === 'Off', JSON.stringify(THINNING_CHOICES))
  check('the plan in plain words', view({}).plan === 'Full video for 7 days, then time-lapse (one picture every 10 s) until day 30, then deleted.', view({}).plan)
  check('the plan says when cameras have days of their own', /2 cameras have days of their own/.test(view({ camerasOwnDays: 2 }).plan) && /1 camera has days of its own/.test(view({ camerasOwnDays: 1 }).plan))
  check('the plan for "keep everything" does not promise a time-lapse', view({ defaults: { ...base.defaults, after: 'keep' } }).plan === 'Everything kept for 30 days, then deleted.', view({ defaults: { ...base.defaults, after: 'keep' } }).plan)
  check('before a run: says it has not run yet', view({}).lines.every((l) => /not run yet/.test(l.text)) && view({}).lines.map((l) => l.label).join() === 'Time-lapse,Retention')

  const v1 = view({ thinning: run({ segments: 1240, bytes: 310e9 }), retention: run({ job: 'retention', segments: 12, bytes: 3.1e9 }) })
  check('dry run, the owner\'s example line', v1.lines[0].text === `Last run ${hhmm} (dry run): would convert 1,240 files, freeing 310 GB`, v1.lines[0].text)
  check('dry run, retention', v1.lines[1].text === `Last run ${hhmm} (dry run): would delete 12 files, freeing 3.1 GB`, v1.lines[1].text)
  const v2 = view({ mode: 'on', thinning: run({ mode: 'on', dryRun: false, segments: 1240, bytes: 310e9 }) })
  check('on: what it did', v2.lines[0].text === `Last run ${hhmm}: converted 1,240 files, freed 310 GB`, v2.lines[0].text)
  const v3 = view({ thinning: run({}), retention: run({ job: 'retention' }) })
  check('dry run that found nothing says so', v3.lines[0].text === `Last run ${hhmm} (dry run): nothing to convert yet` && v3.lines[1].text === `Last run ${hhmm} (dry run): nothing to delete yet`, JSON.stringify(v3.lines.map((l) => l.text)))
  const v4 = view({ thinning: run({ segments: 5, bytes: 1e9, skipped: 7, skippedWhy: [{ why: 'already thin', n: 3 }, { why: 'bookmarked or exported', n: 2 }, { why: 'no index rows', n: 1 }] }) })
  check('skipped files are counted with the reasons', /· 7 skipped \(already thin 3, bookmarked or exported 2, no index rows 1\)$/.test(v4.lines[0].text), v4.lines[0].text)
  const v5 = view({ thinning: run({ segments: 2000, bytes: 5e11, reachedLimit: true }) })
  check('a run that hit the per-run limit says there is more', /most one run/.test(v5.lines[0].text), v5.lines[0].text)
  const v6 = view({ thinning: run({ error: 'database is locked' }) })
  check('a failed run is red and says why', v6.lines[0].state === 'bad' && /failed: database is locked/.test(v6.lines[0].text), v6.lines[0].text)
  const v7 = view({ mode: 'off', thinning: run({ mode: 'off', segments: null, bytes: null, skipped: null }) })
  check('switched off: says it is not running', /switched off/i.test(v7.lines[0].text) && !/would/.test(v7.lines[0].text), v7.lines[0].text)
  // rewrites left half done wait for Dry run or On to be put right: said with Off too (review of p3-thin)
  const halfDone = '2 time-lapse rewrites were left half done (the server stopped, or the share hung): they are put right by the first run with the switch on Dry run or On; until then nothing deletes those files'
  const v7b = view({ mode: 'off', thinning: run({ mode: 'off', segments: null, bytes: null, skipped: null, warnings: [halfDone], warningCount: 1 }) })
  check('switched off with rewrites left half done: the warning is shown, in amber', v7b.lines[0].warnings.join() === halfDone && v7b.lines[0].state === 'warn' && /switched off/i.test(v7b.lines[0].text), JSON.stringify(v7b.lines[0]))
  const v8 = view({ thinning: run({ warnings: ['w1', 'w2'], warningCount: 4 }) })
  check('warnings listed, with how many more there were', v8.lines[0].warnings.join('|') === 'w1|w2|and 2 more (the server log has them all)' && v8.lines[0].state === 'warn', JSON.stringify(v8.lines[0]))
  const v9 = view({ thinning: run({ protection: 'none', segments: 3, bytes: 1e9, unprotected: true }) })
  check('a run that had files in play without the bookmarks is red and says so', v9.lines[0].state === 'bad' && v9.lines[0].warnings.some((w) => /bookmark/i.test(w)), JSON.stringify(v9.lines[0]))
  // (review 2026-09-29) 'none' with nothing in play is an empty index, not an alarm
  const v9b = view({ thinning: run({ protection: 'none', unprotected: false }) })
  check('no bookmarks asked but nothing in play: no alarm', v9b.lines[0].state === '' && v9b.lines[0].warnings.length === 0, JSON.stringify(v9b.lines[0]))
  const v9c = view({ thinning: run({ protection: 'unread', error: 'the bookmarks could not be read, so it stopped before touching anything', warnings: ['bookmarks could not be read (bookmarks table locked): nothing thinned this run'], warningCount: 1 }) })
  check('bookmarks unreadable: says it stopped, with the reason, and no "nothing was treated as bookmarked"', /failed: the bookmarks could not be read/.test(v9c.lines[0].text) && v9c.lines[0].warnings.some((w) => /table locked/.test(w)) && !v9c.lines[0].warnings.some((w) => /nothing was treated/.test(w)), JSON.stringify(v9c.lines[0]))
  // thinning off the main thread (perf report Task 4, 2026-09-29): the dry run's figures are an estimate from
  // the index; with the switch On, what still waits, why a round did not convert, why it stopped early
  const e1 = view({ thinning: run({ segments: 12_345, bytes: 132.5e9, fullBytes: 148e9, estimate: { thinBytes: 15.5e9, low: 13.3e9, high: 17.4e9 }, backlog: { files: 12_345, bytes: 148e9, lagMs: 5 * 3_600_000 } }) })
  check('dry run from the index: the full video it would convert, and what it frees as an estimate with its range', e1.lines[0].text === `Last run ${hhmm} (dry run): would convert 12,345 files (148 GB of full video), freeing about 133 GB (an estimate from the index: 131-135 GB) · the oldest 5.0 h past its full-video days`, e1.lines[0].text)
  // a day of the site's footage: the range must not round to "1.3-1.3 TB" (seen in a browser, 2026-09-29)
  const eTB = view({ thinning: run({ segments: 123_275, bytes: 1.32e12, fullBytes: 1.477e12, estimate: { thinBytes: 0.155e12, low: 0.133e12, high: 0.174e12 }, backlog: { files: 123_275, bytes: 1.477e12, lagMs: 0 } }) })
  check('... at a day\'s size the range still shows two figures', /freeing about 1\.3 TB \(an estimate from the index: 1,303-1,344 GB\)$/.test(eTB.lines[0].text), eTB.lines[0].text)
  const onRun = (o) => run({ mode: 'on', dryRun: false, pace: '40 MB/s, 3 files at a time; nights 20:00-06:00 site time', ...o })
  const e2 = view({ mode: 'on', thinning: onRun({ segments: 812, bytes: 8.6e9, fullBytes: 9.7e9, after: { files: 11_533, bytes: 138e9 }, backlog: { files: 12_345, bytes: 148e9, lagMs: 3_600_000 }, decision: { work: true, night: true, why: 'night hours' } }) })
  check('on: converted, and what still waits', e2.lines[0].text === `Last run ${hhmm}: converted 812 files, freed 8.6 GB · still waiting: 11,533 files, 138 GB`, e2.lines[0].text)
  const e3 = view({ mode: 'on', thinning: onRun({ after: { files: 40, bytes: 4.8e8 }, backlog: { files: 40, bytes: 4.8e8, lagMs: 3_600_000 }, decision: { work: false, night: false, why: 'waiting for the night (20:00-06:00 site time): it can convert the 0 GB waiting and what is recorded until then' } }) })
  check('on, a round that did not convert: says why, and what waits', e3.lines[0].text === `Last run ${hhmm}: nothing converted: waiting for the night (20:00-06:00 site time): it can convert the 0 GB waiting and what is recorded until then · waiting: 40 files, 480 MB`, e3.lines[0].text)
  const e4 = view({ mode: 'on', thinning: onRun({ segments: 3, bytes: 3e7, after: { files: 9, bytes: 1e8 }, stopped: 'the recorder reported "disk too slow" at 2026-10-02 20:03 UTC (n1/4): no more files this round, so recording keeps the disk' }) })
  check('on, stopped early for the recorder: said, in amber', /· stopped early: the recorder reported "disk too slow"/.test(e4.lines[0].text) && e4.lines[0].state === 'warn', JSON.stringify(e4.lines[0]))
  const e5 = view({ mode: 'on', thinning: onRun({ segments: 3, bytes: 3e7, after: { files: 9, bytes: 1e8 }, stopped: "this round's 4 minutes were up (the rest waits for the next round)" }) })
  check('... but not the end of a round\'s minutes, which is how a round ends', !/stopped/.test(e5.lines[0].text) && e5.lines[0].state === '', e5.lines[0].text)
  const e6 = view({ mode: 'on', pace: '40 MB/s, 3 files at a time; nights 20:00-06:00 site time' })
  check('the plan says how fast and when it converts', /Time-lapse is written at 40 MB\/s, 3 files at a time; nights 20:00-06:00 site time first\.$/.test(e6.plan), e6.plan)
  const v10 = view({ thinning: run({}) }, at + 3 * 86_400_000)
  check('a last run more than a day ago gives the day too', /^Last run \d{1,2} [A-Z][a-z]{2} \d\d:\d\d/.test(v10.lines[0].text), v10.lines[0].text)
  check('an older server without the switch: nothing invented', jobsView(undefined).mode === null && jobsView(undefined).lines.every((l) => l.text === NOT_AVAILABLE))

  const w = switchOnWarning({ ...base, camerasOwnDays: 2 })
  check('the confirm names the full-video days and the rewrite to time-lapse', /older than 7 days/.test(w) && /rewritten to time-lapse/.test(w) && /one picture every 10 s/.test(w), w)
  check('the confirm names the total days and deletion for good', /older than 30 days/.test(w) && /deleted/.test(w) && /for good/.test(w), w)
  check('the confirm says bookmarked and exported stretches are kept', /Bookmarked and exported stretches are kept/.test(w), w)
  check('the confirm mentions cameras with days of their own', /2 cameras/.test(w), w)
  const wk = switchOnWarning({ ...base, defaults: { ...base.defaults, after: 'keep' } })
  const we = switchOnWarning({ ...base, defaults: { ...base.defaults, fullDays: 30 } })
  check('with full days equal to the total, the confirm promises no time-lapse either', !/rewritten/.test(we) && /older than 30 days/.test(we), we)
  check('with "keep everything" the confirm promises no time-lapse, only deletion', !/time-lapse, one picture|rewritten/.test(wk) && /older than 30 days/.test(wk) && /for good/.test(wk), wk)
  check('two things named: "Neither can be undone"', /Neither can be undone\./.test(w), w)
  check('only deletion named: "This cannot be undone", no "Neither"', /This cannot be undone\./.test(wk) && !/Neither/.test(wk) && /This cannot be undone\./.test(we) && !/Neither/.test(we), wk)
  // housekeeping.mjs keeps bookmarked stretches too since 2026-09-29 (it asks the bookmarks as these jobs do)
  check('the confirm says bookmarked and exported stretches are kept, by the clean-up rules too', /Bookmarked and exported stretches are kept/.test(w) && /clean-up rules/.test(w) && !/bookmarked or not/.test(w), w)

  // Save always sends what was picked (review 2026-09-29): the page's idea of the switch can be a
  // minute old, and a "No change" on a stale view left it On while the admin believed it Off.
  const { saveSteps } = await import('../public/storage.js')
  check('Save: Off and Dry run are always sent, never asked about', ['off', 'dry-run'].every((m) => saveSteps(m).send === true && saveSteps(m).ask === false), JSON.stringify(saveSteps('off')))
  check('Save: On is always asked about first, then sent', saveSteps('on').send === true && saveSteps('on').ask === true)
  check('Save: nothing picked, or a value that is not a choice, sends nothing', saveSteps(undefined).send === false && saveSteps('ON').send === false)

  // The server's value in words, and an unsaved choice said to be one (review round 2, 2026-09-29):
  // an admin who clicked Off and left without Save came back to Off checked, with the server On.
  const { switchNote } = await import('../public/storage.js')
  const on = switchNote('on', null)
  check('the switch as the server has it, in words', on.now === 'Now: On — converts and deletes as set' && on.unsaved === '', JSON.stringify(on))
  check('...for each position', switchNote('dry-run', null).now === 'Now: Dry run — shows what it would do, changes nothing' && switchNote('off', null).now === 'Now: Off', switchNote('off', null).now)
  const pend = switchNote('on', 'off')
  check('a choice clicked but not saved says so, and what the switch still is', pend.unsaved === 'Not saved yet: the switch is still On until you press Save' && pend.now === on.now, JSON.stringify(pend))
  check('...Dry run picked on a server that is Off, too', switchNote('off', 'dry-run').unsaved === 'Not saved yet: the switch is still Off until you press Save')
  check('the saved value picked again is not "not saved"', switchNote('on', 'on').unsaved === '' && switchNote('dry-run', 'dry-run').unsaved === '')
  check('an older server without the switch: nothing invented', switchNote(null, null).now === '' && switchNote(null, 'on').unsaved === '')
}

// ---- the page's files ---------------------------------------------------------------------------
{
  // (Storage is a tab of Settings now; storage.html only sends old links there)
  const html = readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8')
  check('the page loads storage.js and has the ids it paints into', /storage\.js/.test(html) && ['sr-locations', 'sr-warnings', 'sr-totals'].every((id) => html.includes(`id="${id}"`)))
  const tl = html.match(/<section[^>]*data-tab="storage"[^>]*aria-labelledby="sj-title"[\s\S]*?<\/section>/)?.[0] ?? ''
  check('Settings > Storage has the time-lapse and retention switch, its plan and its last runs', ['sj-title', 'sj-form', 'sj-choices', 'sj-plan', 'sj-runs', 'sj-msg', 'sj-now'].every((id) => tl.includes(`id="${id}"`)), tl.slice(0, 200))
  // repainted every minute: as a live region a screen reader read both lines out again each time
  check('the last-runs list is not a live region (#sj-msg announces saves)', /<ul id="sj-runs"[^>]*>/.test(tl) && !/<ul id="sj-runs"[^>]*aria-live/.test(tl), tl.match(/<ul id="sj-runs"[^>]*>/)?.[0])
  const note = tl.match(/<p class="hp-note">[\s\S]*?<\/p>/)?.[0] ?? ''
  check('the note under the switch says what the clean-up rules delete (low space, the space limit, past the total days), bookmarks excepted', /clean-up rules/.test(note) && /space limit/.test(note) && /total days/.test(note) && /except bookmarked and exported stretches/.test(note) && !/bookmarked or not/.test(note), note)
}

rmSync(data, { recursive: true, force: true })
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
