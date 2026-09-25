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

// ---- the report ---------------------------------------------------------------------------------
const DEFAULTS = { mode: 'continuous', fullDays: 30, after: 'timelapse', timelapseS: 10, retentionDays: 180, preS: 10, postS: 20 }
const L1 = { id: 'L1', path: '/srv/rec/usb1', type: 'usb', role: 'main', limitGB: null }
const L2 = { id: 'L2', path: '/srv/rec/nas', type: 'network', role: 'overflow', limitGB: null }
const settings = (locs = [L1], cameras = {}) => ({ recording: { defaults: DEFAULTS, cameras }, storage: { locations: locs, lowFreePct: 15, floorFreePct: 5 } })

/** A stand-in for rec-index.mjs with just the calls the report makes. */
const fakeIndex = (segs) => ({
  cameras: () => [...new Map(segs.map((s) => [`${s.nvr}/${s.ch}`, { nvr: s.nvr, ch: s.ch }])).values()],
  first: (nvr, ch) => segs.filter((s) => s.nvr === nvr && s.ch === ch).sort((a, b) => a.startMs - b.startMs)[0] ?? null,
  lastEnds: (nvr, ch) => {
    const mine = segs.filter((s) => s.nvr === nvr && s.ch === ch)
    return { segEnd: mine.length ? Math.max(...mine.map((s) => s.endMs)) : null, gapEnd: null }
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
check('render: nothing configured is not a crash', renderStorage({}).empty === true && renderStorage(null).empty === true)
check('render: a camera whose days we cannot say gets no colour', renderStorage({ locations: [{ id: 'L', path: '/p', mounted: true, usedBytes: 1, freeBytes: 1, totalBytes: 2, usedPct: 50, freePct: 50, cameras: [{ camera: 'c', daysKept: null, targetDays: null, meetsTarget: null }] }] }).locations[0].cameras[0].state === '')

// ---- the page's files ---------------------------------------------------------------------------
{
  const html = readFileSync(new URL('../public/storage.html', import.meta.url), 'utf8')
  check('the page loads storage.js and has the ids it paints into', /storage\.js/.test(html) && ['locations', 'warnings', 'totals', 'whoami', 'logout'].every((id) => html.includes(`id="${id}"`)))
}

rmSync(data, { recursive: true, force: true })
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
