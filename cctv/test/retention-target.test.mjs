// Tests for retention-target.mjs: days kept against the target, the forecast of the days the space holds,
// and the shortfall's alert candidate. First the arithmetic on hand-made figures (the owner's NAS: 16.63 TB
// shared, ~3.44 TB of other backups, 1.47 TB a day, the 12,000 GB limit), then the figures measured from a
// real index (node:sqlite) of synthetic rows, and what measuring them costs the main thread.
// No SDK, no real disks, Windows-safe.   Run: node cctv/test/retention-target.test.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ROOT = mkdtempSync(join(tmpdir(), 'cctv-rtarget-'))
process.env.DATA_DIR = join(ROOT, 'data')
process.env.CCTV_SITE_TZ_OFFSET_MIN = '-240' // the site's UTC-4, whatever this PC's zone
process.on('exit', () => {
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {}
})

const T = await import('../retention-target.mjs')
const { measureRetention, retentionView, retentionCandidates, wholeDays, RAISE_SHORT_DAYS, CLEAR_SHORT_DAYS, MIN_SAMPLE_FILES } = T
const { openRecIndex, THIN } = await import('../rec-index.mjs')
await import('../thinning.mjs') // (loaded before the fs spy below: loading it is not measuring)

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const J = (v) => JSON.stringify(v)
const near = (a, b, tol = 0.05) => Number.isFinite(a) && Math.abs(a - b) <= tol

const DAY = 86_400_000
const HOUR = 3_600_000
const MIN = 60_000
const TB = 1e12
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0) // 08:00 on 3 Oct at the site

// ---- the whole days ------------------------------------------------------------------------------------
{
  const d = wholeDays(NOW)
  check('the last three whole days on the site\'s clock, oldest first (a site day starts 04:00 UTC at UTC-4)', J(d.map((x) => x.date)) === J(['2026-09-30', '2026-10-01', '2026-10-02']) && d[0].fromMs === Date.UTC(2026, 8, 30, 4) && d[2].toMs === Date.UTC(2026, 9, 3, 4), J(d))
}

// ---- the arithmetic, on hand-made figures ---------------------------------------------------------------
const CAMS = 87
const DEFAULTS = { mode: 'continuous', fullDays: 7, after: 'timelapse', timelapseS: 10, retentionDays: 30 }
const settingsOf = ({ defaults = {}, cameras = {}, thinning = 'on', locs = [NAS] } = {}) => ({ recording: { defaults: { ...DEFAULTS, ...defaults }, cameras }, storage: { thinning, locations: locs, lowFreePct: 15, floorFreePct: 5 } })
const NAS = { id: 'NAS', path: '/srv/cctv-net/backups/cctvbackup', type: 'network', role: 'main' }

/**
 * Figures as measureRetention gives them: `cams` cameras recording `perDay` bytes a day between them on one
 * location over the three whole days; a time-lapse sample that weighs `share` of the same cameras' full video.
 */
const factsOf = ({ loc = 'NAS', cams = CAMS, perDay = 1.47 * TB, oldestMs = NOW - 3.68 * DAY, anyOldestMs = oldestMs, timelapse = null, fullFromMs = oldestMs, share = null, sampleFiles = 24, weightedShare = 0.2, at = NOW, camOf = (c) => ({ nvr: 'nvr1', ch: c }) } = {}) => {
  const days = wholeDays(NOW).map((d) => ({
    ...d,
    rows: Array.from({ length: cams }, (_, c) => ({ loc, ...camOf(c), files: 1440, bytes: perDay / cams, ms: 1440 * 59_000, weighted: (perDay / cams) * weightedShare }))
  }))
  const sample = share === null ? [] : Array.from({ length: cams }, (_, c) => ({ ...camOf(c), files: sampleFiles, bytes: ((sampleFiles * perDay) / cams / 1440) * share, ms: sampleFiles * 59_000 }))
  return { at, stepMs: 10_000, keyframeShare: { low: 0.43, mid: 0.5, high: 0.56 }, protection: 'ranges', warnings: [], days, locations: { [loc]: { id: loc, anyOldestMs, oldestMs, timelapse, fullFromMs, sample } } }
}
/** The Storage report's row for the NAS: 16.63 TB, `free` free, Argus holding `held`, its marks and limit. */
const rowOf = ({ held = 5.41 * TB, free = 7.77 * TB, total = 16.63 * TB, limit = 12_000e9, enforced = true, low = 7, floor = 5, id = 'NAS', path = NAS.path } = {}) => ({ id, path, mounted: true, argusBytes: held, freeBytes: free, totalBytes: total, limitBytes: limit, limitEnforced: enforced, lowFreePct: low, floorFreePct: floor })
const viewOf = (o = {}) => {
  const memory = o.memory ?? new Set()
  return retentionView({ facts: o.facts ?? factsOf(o.f), settings: o.settings ?? settingsOf(o.s), locations: o.rows ?? [rowOf(o.r)], now: o.now ?? NOW, memory })
}

// Argus holding 7 days of full video and 1.2 of time-lapse (8.2 days, 10.47 TB), the other backups' 3.44 TB beside it
const PLAN = { f: { share: 0.104, oldestMs: NOW - 8.2 * DAY }, r: { held: 7 * 1.47 * TB + 1.2 * 0.104 * 1.47 * TB, free: (16.63 - 3.44) * TB - (7 * 1.47 + 1.2 * 0.104 * 1.47) * TB } }
// recycling at the limit: 12,000 GB held, the oldest footage 8.2 days old
const RECYCLING = { f: { share: 0.104, oldestMs: NOW - 8.2 * DAY }, s: { thinning: 'dry-run' }, r: { held: 12 * TB, free: 1.19 * TB } }
{
  // the owner's plan (7 days full video, time-lapse to 30), switched On, the 12,000 GB limit, time-lapse 10.4 % of full video
  const v = viewOf(PLAN)
  const l = v.locations.NAS
  const f = l.forecast.now
  // 7 days of full video: 10.29 TB; 1.71 TB left at 0.153 TB a day of time-lapse: 11.2 days
  check('THE PLAN AT 1.47 TB A DAY UNDER 12,000 GB: 7 days of full video and about 11.2 of time-lapse fit, 18.2 in all', near(f.fullDays, 7) && near(f.timelapseDays, 11.19) && near(f.daysFit, 18.19) && f.bound === 'limit', J(f))
  check('... short of the 30-day target by about 11.8 days: a forecast shortfall', near(f.shortBy, 11.81) && f.targetDays === 30 && l.short.forecast === true, J({ shortBy: f.shortBy, short: l.short }))
  check('... the daily volume from the three whole days, and the time-lapse\'s size measured from real files', near(l.perDay / TB, 1.47, 1e-9) && J(l.wholeDays) === J(['2026-09-30', '2026-10-01', '2026-10-02']) && l.share.how === 'measured' && near(l.share.value, 0.104, 1e-9) && l.share.files === CAMS * 24, J(l.share))
  check('... not recycling (5.41 TB held of 12,000 GB): the days kept now (8.2) are no shortfall of their own', l.recycling === null && near(l.daysKept, 8.2) && l.short.actual === false, J({ recycling: l.recycling, daysKept: l.daysKept }))
  // the oldest 8.2 days old (past the 7 full days): growing by the time-lapse alone, 0.153 TB a day
  check('... the limit reached in about 10 days at that (the day past 7 days converted as the newest comes in)', f.reach?.what === 'limit' && near(f.reach.days, (12 - PLAN.r.held / TB) / (0.104 * 1.47), 0.05) && near(f.reach.ms, NOW + f.reach.days * DAY, 1), J(f.reach))
  check('... and no second scenario: time-lapse is already On', l.forecast.timelapse === null)
}
{
  // the same with the switch on Dry run: no time-lapse is written, so full video only, and the page says what On would give
  const v = viewOf({ f: { share: 0.104 }, s: { thinning: 'dry-run' } })
  const l = v.locations.NAS
  check('DRY RUN: full video only, 12,000 GB / 1.47 TB = 8.2 days fit, no time-lapse', near(l.forecast.now.daysFit, 8.16) && near(l.forecast.now.fullDays, 8.16) && l.forecast.now.timelapseDays === 0 && l.forecast.now.converting === false, J(l.forecast.now))
  check('... with time-lapse On it would be 18.2 (said beside it)', near(l.forecast.timelapse?.daysFit, 18.19) && l.forecast.timelapse.converting === true, J(l.forecast.timelapse))
  check('... the limit reached in about 4.5 days at the full 1.47 TB a day (5.41 TB held, 3.7 days of it)', near(l.forecast.now.reach.days, (12 - 5.41) / 1.47, 0.05), J(l.forecast.now.reach))
}
{
  // room enough: a 20,000 GB limit on a 40 TB share (7 % low mark: 32.2 TB for Argus): 10.3 + 23 x 0.153 = 13.8 TB
  const v = viewOf({ f: { share: 0.104 }, r: { limit: 20_000e9, total: 40 * TB, free: 30 * TB, held: 5 * TB } })
  const f = v.locations.NAS.forecast.now
  check('ROOM ENOUGH: the whole 30 days fit (retention deletes at 30, not the limit); no shortfall', f.daysFit === 30 && f.fullDays === 7 && f.timelapseDays === 23 && f.bound === null && f.shortBy === 0 && v.locations.NAS.short.forecast === false, J(f))
  check('... and the limit is never reached: 13.8 TB is all 30 days hold', f.reach?.days === null && f.reach.reached === false, J(f.reach))
}
{
  // today's production settings: 30 days full video, 183 kept, no limit, the default 15 % low mark: the low mark
  // cannot delete full video, so the share fills to its 5 % floor and deletes oldest first there: 8.4 days
  // (the audit's own figure, storage.md 1: (0.95 x 16.63 - 3.44) / 1.47)
  const v = viewOf({ f: { share: 0.104 }, s: { defaults: { fullDays: 30, retentionDays: 183 }, thinning: 'dry-run' }, r: { limit: null, enforced: false, low: 15, floor: 5 } })
  const f = v.locations.NAS.forecast.now
  check('TODAY\'S SETTINGS (30 full, 183 kept, no limit, 15 % low): about 8.4 days, at the hard floor', near(f.daysFit, 8.4) && f.bound === 'floor' && f.targetDays === 183, J(f))
  check('... the date is the low mark\'s (no limit): (5.41 + 7.77 - 2.49) TB at 1.47 TB a day, 2.2 days', f.reach?.what === 'low mark' && near(f.reach.days, (5.41 + 7.77 - 0.15 * 16.63 - 5.41) / 1.47), J(f.reach))
  // 7 full days, dry run, the 15 % low mark: 10.3 TB of full video fits under it (10.7 TB); the rest of the mark by the score
  const v2 = viewOf({ f: { share: 0.104 }, s: { thinning: 'dry-run' }, r: { limit: null, enforced: false, low: 15 } })
  check('... 7 full days under the 15 % low mark (no limit): 7.3 days, the low mark deleting past the full-video days', near(v2.locations.NAS.forecast.now.daysFit, (5.41 + 7.77 - 0.15 * 16.63) / 1.47) && v2.locations.NAS.forecast.now.bound === 'low mark', J(v2.locations.NAS.forecast.now))
  // a limit saved before limits were enforced is no limit
  const v3 = viewOf({ f: { share: 0.104 }, s: { thinning: 'dry-run' }, r: { limit: 12_000e9, enforced: false, low: 15 } })
  check('... a limit not enforced (saved before 29 Sep) is not counted', v3.locations.NAS.forecast.now.bound === 'low mark', J(v3.locations.NAS.forecast.now))
}
{
  // RECYCLING AT THE LIMIT: Argus holds 12,000 GB, the oldest footage 8.2 days old, target 30
  const v = viewOf(RECYCLING)
  const l = v.locations.NAS
  check('RECYCLING AT ITS LIMIT, 8.2 DAYS KEPT AGAINST 30: an actual shortfall (it does not go quiet because it recycles)', l.recycling === 'limit' && l.short.actual === true && near(l.daysKept, 8.2), J({ recycling: l.recycling, short: l.short, daysKept: l.daysKept }))
  check('... the limit reached already', l.forecast.now.reach?.reached === true, J(l.forecast.now.reach))
  // at the low mark (no limit): free space at 7 %
  const lowAt = viewOf({ f: RECYCLING.f, s: { thinning: 'dry-run' }, r: { limit: null, enforced: false, held: 12 * TB, free: 0.07 * 16.63 * TB } })
  check('... recycling at its low mark counts too', lowAt.locations.NAS.recycling === 'low mark' && lowAt.locations.NAS.short.actual === true, J(lowAt.locations.NAS.recycling))
  // retention cycling: 30 days kept, deleting at 30
  const kept = viewOf({ f: { share: 0.104, oldestMs: NOW - 30 * DAY - 2 * MIN }, r: RECYCLING.r })
  check('... at the limit but keeping its 30 days: no actual shortfall', kept.locations.NAS.short.actual === false, J(kept.locations.NAS.short))
  // young and not recycling: 2 days kept, room for 30
  const young = viewOf({ f: { share: 0.104, oldestMs: NOW - 2.5 * DAY, anyOldestMs: NOW - 2.5 * DAY }, r: { limit: 20_000e9, total: 40 * TB, free: 30 * TB, held: 3 * TB } })
  check('A YOUNG LOCATION (2.5 days, room for 30): no shortfall of either kind', young.locations.NAS.short.actual === false && young.locations.NAS.short.forecast === false && young.locations.NAS.forecast.now.daysFit === 30, J({ short: young.locations.NAS.short, wholeDays: young.locations.NAS.wholeDays }))
  check('... its forecast from the two whole days it has', J(young.locations.NAS.wholeDays) === J(['2026-10-01', '2026-10-02']), J(young.locations.NAS.wholeDays))
}
{
  // the time-lapse's size: measured from real files, else estimated from the keyframes, and it says which
  const few = viewOf({ f: { share: 0.104, sampleFiles: 1, cams: MIN_SAMPLE_FILES - 1 } }).locations.NAS.share
  check('FEWER THAN MIN_SAMPLE_FILES REAL TIME-LAPSE FILES: an estimate from the keyframes (20 % of them kept x 43-56 % of the bytes), said as one', few.how === 'estimated' && near(few.value, 0.2 * 0.5, 1e-9) && near(few.low, 0.2 * 0.43, 1e-9) && near(few.high, 0.2 * 0.56, 1e-9), J(few))
  const none = viewOf({ f: {} }).locations.NAS.share
  check('... none at all: the estimate', none.how === 'estimated' && none.files === 0, J(none))
  const del = viewOf({ f: {}, s: { defaults: { after: 'delete' } } }).locations.NAS
  check('... no camera set to time-lapse: no time-lapse share, and full video to the end', del.share === null && del.forecast.now.timelapseDays === 0 && near(del.forecast.now.daysFit, 12 / 1.47), J(del.forecast.now))
}
{
  // no whole day yet: no forecast, and it says why; the days kept are still said
  const l = viewOf({ f: { oldestMs: NOW - 0.5 * DAY, anyOldestMs: NOW - 0.5 * DAY } }).locations.NAS
  check('NO WHOLE DAY OF FOOTAGE YET: no forecast (never a guess), in words; the days kept still said', l.forecast === null && /whole day/.test(l.forecastReason) && near(l.daysKept, 0.5) && l.short.forecast === false, J({ reason: l.forecastReason, daysKept: l.daysKept }))
  const unknown = viewOf({ f: { share: 0.104 }, r: { limit: null, enforced: false, free: null, total: null } }).locations.NAS
  check('... no limit and free space unknown: no forecast, in words', unknown.forecast === null && /free space/.test(unknown.forecastReason), unknown.forecastReason)
  const notYet = retentionView({ facts: null, settings: settingsOf(), locations: [rowOf()], now: NOW })
  check('... nothing measured yet: not available, and no candidate', notYet.available === false && /not measured yet/.test(notYet.reason) && retentionCandidates({ retention: notYet, locations: [rowOf()] }).length === 0, J(notYet))
  const stale = viewOf({ f: { at: NOW - 2 * HOUR, share: 0.104 } })
  check('... figures two hours old (the measuring failed since): not used', stale.available === false && /since/.test(stale.reason), stale.reason)
}
{
  // two kinds of camera on one location: 20 of 87 kept as full video until day 30 ('delete'), 67 on time-lapse;
  // the limit deletes by how far past its full-video days a file is, so both keep 7 + x days
  const cams = Object.fromEntries(Array.from({ length: 20 }, (_, c) => [`nvr1/${c}`, { after: 'delete' }]))
  const l = viewOf({ f: { share: 0.104 }, s: { cameras: cams } }).locations.NAS
  const x = (12 - 7 * 1.47) / ((20 / 87) * 1.47 + (67 / 87) * 1.47 * 0.104)
  check('TWO KINDS OF CAMERA: both keep 7 + x days (the score), x from the limit', l.forecast.now.groups.length === 2 && l.forecast.now.groups.every((g) => near(g.daysFit, 7 + x)) && near(l.forecast.now.daysFit, 7 + x), J(l.forecast.now.groups))
  // the limit comes before the low mark (12,000 GB against 12,016 GB): Argus stays under it and the free space
  // never reaches the low mark, so the floor's oldest-first rule does not count. One camera kept 7 days by its own
  // settings, the other 30 full + 180 in all (dry run): the score takes the first down to its newest day (its
  // files are furthest past its full-video days), and the second keeps (12 TB - 0.735 TB) / 0.735 TB = 15.3 days.
  const two = viewOf({ f: { cams: 2, share: 0.104 }, s: { thinning: 'dry-run', defaults: { fullDays: 30, retentionDays: 180 }, cameras: { 'nvr1/0': { retentionDays: 7, fullDays: 7 } } } }).locations.NAS.forecast.now
  const g7 = two.groups.find((g) => g.targetDays === 7)
  const g180 = two.groups.find((g) => g.targetDays === 180)
  check('THE LIMIT BEFORE THE LOW MARK: the limit\'s score decides, not the floor\'s oldest-first (never both at once)', two.bound === 'limit' && near(g180?.daysFit, 12 / 0.735 - 1) && near(g7?.daysFit, 1) && near(two.daysFit, 12 / 0.735 - 1) && two.targetDays === 180, J(two))
  const own = viewOf({ f: { share: 0.104 }, s: { cameras: { 'nvr1/0': { retentionDays: 60 } } }, r: { limit: 100_000e9, total: 200 * TB, free: 190 * TB } }).locations.NAS
  // (its oldest footage bounds every camera there: one wanting 60 days is short at 30 whatever the rest want)
  check('... a camera with a target of its own: the location\'s targets are both; the largest is what it must keep', J(own.targets) === J([30, 60]) && own.targetDays === 60, J(own.targets))
  const both = viewOf({ f: { share: 0.104, oldestMs: NOW - 30 * DAY - 2 * MIN }, s: { cameras: { 'nvr1/0': { retentionDays: 60 } } }, r: RECYCLING.r }).locations.NAS
  check('... recycling at its limit at 30 days while one camera wants 60: short', both.short.actual === true, J({ short: both.short, targets: both.targets }))
}
{
  // hysteresis: raised under the target less RAISE_SHORT_DAYS, cleared at the target less CLEAR_SHORT_DAYS
  const memory = new Set()
  const at = (days) => viewOf({ f: {}, s: { thinning: 'dry-run', defaults: { after: 'delete' } }, r: { limit: days * 1.47 * TB, total: 400 * TB, free: 390 * TB }, memory }).locations.NAS.short.forecast
  const seen = [at(30 - RAISE_SHORT_DAYS + 0.05), at(30 - RAISE_SHORT_DAYS - 0.05), at(30 - RAISE_SHORT_DAYS + 0.05), at(30 - CLEAR_SHORT_DAYS - 0.01), at(30 - CLEAR_SHORT_DAYS + 0.01), at(30 - RAISE_SHORT_DAYS + 0.05)]
  check('SHORT ONCE UNDER THE TARGET LESS 6 HOURS; STAYS SHORT UNTIL WITHIN AN HOUR OF IT (no flapping at the edge)', J(seen) === J([false, true, true, true, false, false]), J(seen))
}

// ---- the alert candidate --------------------------------------------------------------------------------
{
  const row = rowOf(RECYCLING.r)
  const v = viewOf({ ...RECYCLING, rows: [row] })
  const c = retentionCandidates({ retention: v, locations: [row] })
  check('A SHORTFALL IS ONE CANDIDATE PER LOCATION, kind retention-short', c.length === 1 && c[0].kind === 'retention-short' && c[0].key === 'retention-short/NAS', J(c))
  check('... its title says the days kept and the target', /keeps 8\.2 days of footage/.test(c[0].title) && /30-day target/.test(c[0].title) && c[0].title.includes(NAS.path), c[0].title)
  check('... its detail says the forecast, the volume, what time-lapse On would give and how the time-lapse was sized', /1\.47 TB a day/.test(c[0].detail) && /its 12,000 GB limit holds about 8\.2 days/.test(c[0].detail) && /time-lapse On/i.test(c[0].detail) && /18\.2 days/.test(c[0].detail) && /measured from 2,088 real time-lapse files/.test(c[0].detail), c[0].detail)
  const noTl = retentionCandidates({ retention: viewOf({ ...RECYCLING, s: { thinning: 'dry-run', defaults: { fullDays: 30, retentionDays: 180 } } }), locations: [row] })
  check('... where time-lapse would change nothing (30 full days, 8 kept): neither "with time-lapse On" nor its size', noTl.length === 1 && !/time-lapse On/.test(noTl[0].detail) && !/taken as/.test(noTl[0].detail), noTl[0]?.detail)
  const allMarked = retentionCandidates({ retention: viewOf({ f: { share: 0.104, oldestMs: null, anyOldestMs: NOW - 3.68 * DAY } }), locations: [rowOf()] })
  check('... a location whose every file is bookmarked: its days kept said as such, not "0 days"', allMarked.length === 1 && /nothing here outside bookmarked stretches/.test(allMarked[0].detail) && !/0 days/.test(allMarked[0].detail), allMarked[0]?.detail)
  const fc = retentionCandidates({ retention: viewOf({ f: { share: 0.104 } }), locations: [rowOf()] })
  check('... a forecast shortfall alone says "will keep about"', fc.length === 1 && /will keep about 18\.2 days/.test(fc[0].title), fc[0]?.title)
  check('... none when the target is kept', retentionCandidates({ retention: viewOf({ f: { share: 0.104 }, r: { limit: 20_000e9, total: 40 * TB, free: 30 * TB, held: 5 * TB } }), locations: [rowOf()] }).length === 0)
  // measuring that fails for over half an hour leaves figures too old to show; an open shortfall is not
  // cleared by that (its "OK" would be a push saying all is well when nothing is known): the last kept
  const short = retentionCandidates({ retention: viewOf(RECYCLING), locations: [row] })
  const stale = retentionCandidates({ retention: viewOf({ ...RECYCLING, f: { ...RECYCLING.f, at: NOW - 2 * HOUR } }), locations: [row] })
  check('FIGURES GONE STALE (the measuring fails): the last shortfall kept, not cleared', J(stale) === J(short) && stale.length === 1, J(stale))
  const fresh = retentionCandidates({ retention: viewOf({ ...RECYCLING, r: { held: 5 * TB, limit: 50_000e9, total: 70 * TB, free: 55 * TB } }), locations: [row] })
  const after = retentionCandidates({ retention: viewOf({ ...RECYCLING, f: { ...RECYCLING.f, at: NOW - 2 * HOUR } }), locations: [row] })
  check('... and once fresh figures said the target is met, stale ones keep that too', fresh.length === 0 && after.length === 0, J({ fresh, after }))
  check('... never measured at all: nothing', retentionCandidates({ retention: retentionView({ facts: null, settings: settingsOf(), locations: [row], now: NOW }), locations: [row] }).length === 0)
}

// ---- measured from a real index --------------------------------------------------------------------------
// 87 cameras x 5 days of minute files on the NAS (626,400 rows): the oldest day and the hours up to 4 days
// old rewritten to time-lapse (1.3 MB of 12 MB), except a bookmarked stretch at the oldest end (2 hours, every
// camera); full video after. Built by one INSERT ... WITH RECURSIVE.
const dbFile = join(ROOT, 'recordings.db')
openRecIndex(dbFile).close()
const OLDEST = Date.UTC(2026, 8, 28, 12, 0, 0) // 5 days before NOW, on the hour
const CUT = NOW - 4 * DAY // rewritten before this (the plan: 4 full-video days here)
const MARK = [OLDEST, OLDEST + 2 * HOUR - 1] // the bookmark
{
  const raw = new DatabaseSync(dbFile)
  raw.exec('PRAGMA synchronous = OFF')
  raw.exec('BEGIN')
  raw
    .prepare(
      `WITH RECURSIVE m(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM m WHERE k < ?), c(ch) AS (SELECT 0 UNION ALL SELECT ch + 1 FROM c WHERE ch < 86)
       INSERT INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc, thinned)
       SELECT '/srv/nas/nvr1/' || ch || '/' || (? + k * 60000) || '.h265', 'nvr1', ch, ? + k * 60000, ? + k * 60000 + 59000,
         CASE WHEN ? + k * 60000 < ? AND ? + k * 60000 > ? THEN 1300000 ELSE 12000000 END, 30, 'NAS',
         CASE WHEN ? + k * 60000 < ? AND ? + k * 60000 > ? THEN ${THIN.timelapse} END
       FROM m CROSS JOIN c`
    )
    .run(5 * 1440 - 1, OLDEST, OLDEST, OLDEST, OLDEST, CUT, OLDEST, MARK[1], OLDEST, CUT, OLDEST, MARK[1])
  raw.exec('COMMIT')
  raw.close()
}
const index = openRecIndex(dbFile)
const settings = settingsOf({ defaults: { fullDays: 4 } })
// (as bookmarks.mjs gives it: a minute either side; no cameras named: every camera. Since the final fix round
// of 2026-09-30 the guard takes the stretches as given, where it added a minute of its own)
const protectedRanges = () => [{ fromMs: MARK[0] - MIN, toMs: MARK[1] + MIN, cameras: [] }]
{
  const cache = new Map()
  const facts = await measureRetention({ index, settings, now: NOW, protectedRanges, cache })
  const loc = facts.locations.NAS
  const raw = new DatabaseSync(dbFile)
  const want = wholeDays(NOW).map((d) => raw.prepare('SELECT COUNT(*) AS n, SUM(bytes) AS b FROM segments WHERE start_ms >= ? AND start_ms < ?').get(d.fromMs, d.toMs))
  raw.close()
  const got = facts.days.map((d) => ({ n: d.rows.reduce((a, r) => a + r.files, 0), b: d.rows.reduce((a, r) => a + r.bytes, 0) }))
  check('MEASURED: each whole day\'s files and bytes exactly as SUM over the rows says, per camera', J(got) === J(want) && facts.days.every((d) => d.rows.length === CAMS), J({ got, want }))
  // (a bookmark keeps a minute either side: the file of its last minute's next minute is kept too)
  check('... the oldest footage is the first file after the bookmarked stretch; the oldest file of all is its first', loc.oldestMs === OLDEST + 2 * HOUR + MIN && loc.anyOldestMs === OLDEST && facts.protection === 'ranges', J({ oldest: new Date(loc.oldestMs).toISOString(), any: new Date(loc.anyOldestMs).toISOString() }))
  // a bookmark keeps the cameras it names (final fix round, 2026-09-30): the same stretch on one camera leaves
  // the other 86 cameras' footage of those hours the oldest, and the days kept are counted from it
  const oneCam = await measureRetention({ index, settings, now: NOW, protectedRanges: () => [{ fromMs: MARK[0] - MIN, toMs: MARK[1] + MIN, cameras: ['nvr1/0'] }], cache })
  check('A BOOKMARK OF ONE CAMERA: THE OLDEST FOOTAGE IS STILL THE OTHER CAMERAS\' FIRST FILE', oneCam.locations.NAS.oldestMs === OLDEST, new Date(oneCam.locations.NAS.oldestMs ?? 0).toISOString())
  check('... the time-lapse from the first hour after the bookmark to the last hour before the cutoff (to the hour)', loc.timelapse?.oldestMs === OLDEST + 2 * HOUR && loc.timelapse.newestMs === CUT - HOUR, J(loc.timelapse && { oldest: new Date(loc.timelapse.oldestMs).toISOString(), newest: new Date(loc.timelapse.newestMs).toISOString() }))
  check('... full video from the cutoff on (the first full-video file after the newest time-lapse)', loc.fullFromMs === CUT, new Date(loc.fullFromMs ?? 0).toISOString())
  // where full video begins is looked for up to FULL_LOOK_MS past the newest time-lapse sample, however many
  // cameras (rows) that is, and not further: 87 cameras' 2 hours are 10,440 rows, over ten windows
  let looks = 0
  const lookCounted = new Proxy(index, { get: (t, k) => (k === 'fullNext' ? (...a) => (looks++, t.fullNext(...a)) : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) })
  const far = await measureRetention({ index: lookCounted, settings, now: NOW, protectedRanges, cache })
  check('... found an hour of 87 cameras\' rows on (5,220 rows: six windows)', far.locations.NAS.fullFromMs === CUT && looks === 6, `${looks} looks`)
  check('FULL_LOOK_MS is two hours', T.FULL_LOOK_MS === 2 * HOUR)
  // (the time-lapse is 14:00 on 28 Sep to 11:59 on 29 Sep: 22 hours' first files, all within the day before the newest)
  check('... a sample of one real time-lapse file an hour per camera, over the day before the newest', loc.sample.length === CAMS && loc.sample.every((s) => s.files === 22 && s.bytes === 22 * 1_300_000), J(loc.sample[0]))
  const v = retentionView({ facts, settings, locations: [rowOf({ held: 3 * TB })], now: NOW })
  const l = v.locations.NAS
  check('... the view: 5 days kept (less the bookmark), 4 of full video, time-lapse 0.9 more; the share measured at 1.3 of 12 MB', near(l.daysKept, 5 - 2 / 24) && near(l.fullDaysKept, 4) && near(l.timelapse.days, 1 - 2 / 24 - 0, 0.05) && l.share.how === 'measured' && near(l.share.value, 1.3 / 12, 1e-6), J({ daysKept: l.daysKept, full: l.fullDaysKept, tl: l.timelapse, share: l.share }))
  // measured again: the whole days are not summed again (a closed day changes only by backfill: DAY_STALE_MS)
  let dayUses = 0
  const counted = new Proxy(index, { get: (t, k) => (k === 'dayUse' ? (...a) => (dayUses++, t.dayUse(...a)) : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) })
  await measureRetention({ index: counted, settings, now: NOW + 5 * MIN, protectedRanges, cache })
  check('... measured again five minutes later: the whole days come from the cache (no dayUse)', dayUses === 0 && cache.size === 3, `${dayUses} dayUse, ${cache.size} days cached`)
  await measureRetention({ index: counted, settings, now: NOW + DAY, protectedRanges, cache })
  check('... a day later: only the new whole day is summed (8 hours of rows here); the one that dropped out is forgotten', dayUses > 0 && dayUses <= 10 && cache.size === 3, `${dayUses} dayUse, ${cache.size} days cached`)
  dayUses = 0
  await measureRetention({ index: counted, settings, now: NOW + DAY + 5 * MIN, protectedRanges, cache })
  const one = dayUses
  dayUses = 0
  await measureRetention({ index: counted, settings, now: NOW + DAY + 10 * MIN, protectedRanges, cache })
  check('... then the days summed over DAY_STALE_MS ago are read again, one a measurement (backfill may have filled them since)', one >= 20 && one <= 40 && dayUses >= 20 && dayUses <= 40, `${one} then ${dayUses} dayUse`)
  const unread = await measureRetention({ index, settings, now: NOW, protectedRanges: () => { throw new Error('database is locked') }, cache })
  check('... bookmarks that cannot be read: the oldest file of all, and it says so', unread.protection === 'unread' && unread.locations.NAS.oldestMs === OLDEST && /bookmarks could not be read/.test(unread.warnings[0]), J(unread.warnings))
}

// ---- the daily volume where the whole days are partly time-lapse already (audit of 2026-10-07, M12) --------
// One camera recording 12 MB a minute, 17.28 GB a day, for 5 days; 1 full-video day, and the job has kept up:
// everything over a day old is time-lapse at a tenth of the size. Of the three whole days, two are all
// time-lapse and the newest is time-lapse for its first 8 hours (to 12:00 UTC on 2 Oct; the site's day starts
// 04:00 UTC). Counted as they are the three days averaged 5.2 GB a day, and the forecast was 29.4 days where
// 20.5 fit.
{
  const f = join(ROOT, 'partly.db')
  openRecIndex(f).close()
  const cut = NOW - DAY
  const raw = new DatabaseSync(f)
  raw.exec('BEGIN')
  raw
    .prepare(
      `WITH RECURSIVE m(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM m WHERE k < ?)
       INSERT INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc, thinned)
       SELECT '/srv/nas/nvr1/0/' || (? + k * 60000) || '.h265', 'nvr1', 0, ? + k * 60000, ? + k * 60000 + 60000,
         CASE WHEN ? + k * 60000 < ? THEN 1200000 ELSE 12000000 END, 30, 'NAS', CASE WHEN ? + k * 60000 < ? THEN ${THIN.timelapse} END
       FROM m`
    )
    .run(5 * 1440 - 1, OLDEST, OLDEST, OLDEST, OLDEST, cut, OLDEST, cut)
  raw.exec('COMMIT')
  raw.close()
  const ix = openRecIndex(f)
  const GBd = 12_000_000 * 1440 // 17.28 GB a day
  const view = async (fullDays, at = NOW) => {
    const s = settingsOf({ defaults: { fullDays } })
    const facts = await measureRetention({ index: ix, settings: s, now: at, protectedRanges: null, cache: new Map() })
    return { facts, l: retentionView({ facts, settings: s, locations: [rowOf({ held: 0.1 * TB, free: 1 * TB, total: 2 * TB, limit: 500e9 })], now: at }).locations.NAS }
  }
  const { facts, l } = await view(1)
  const days = facts.days.map((d) => d.rows[0])
  check('PARTLY TIME-LAPSE: measured, two whole days are all time-lapse and the newest is full video for its last 16 hours', days.length === 3 && days[0].fullMs === 0 && days[1].fullMs === 0 && days[2].fullMs === 16 * HOUR && days[2].fullBytes === 16 * 60 * 12_000_000 && days[2].ms === DAY, J(days))
  check('... THE DAILY VOLUME IS THE FULL VIDEO\'S, 17.28 GB A DAY (counted as they are the days gave 5.2)', near(l.perDay / 1e9, 17.28, 1e-6), String(l.perDay / 1e9))
  check('... the time-lapse measured against the same full video: a tenth of it', l.share.how === 'measured' && near(l.share.value, 0.1, 1e-9), J(l.share))
  // 1 full-video day (17.28 GB) and time-lapse at 1.728 GB a day under 500 GB: all 30 days fit (67.4 GB)
  check('... and the forecast is drawn at that volume: the plan\'s 30 days are 67.4 GB', l.forecast.now.daysFit === 30 && near(l.forecast.now.fullDays, 1), J(l.forecast.now))
  // what the days would have read counted as they are: (2 x 1.728 + 8/24 x 1.728 + 16/24 x 17.28) / 3
  const asTheyAre = days.reduce((a, r) => a + r.bytes, 0) / 3 / 1e9
  check('... (the figures as they were counted before: 5.18 GB a day, under a third of it)', near(asTheyAre, 5.184, 1e-6), String(asTheyAre))
  // a camera with no full video left in the whole days (measured the moment the day turns, 1 full-video day and
  // the newest hours not there yet): nothing to scale from, counted as it is rather than as nothing
  const none = retentionView({ facts: { ...facts, days: facts.days.slice(0, 2) }, settings: settingsOf({ defaults: { fullDays: 1 } }), locations: [rowOf({ held: 0.1 * TB, free: 1 * TB, total: 2 * TB, limit: 500e9 })], now: NOW }).locations.NAS
  check('... no full video in the days at all: counted as it is (1.728 GB a day), never as nothing', near(none.perDay / 1e9, 1.728, 1e-6), String(none.perDay / 1e9))
  ix.close()
}

// ---- what measuring costs the main thread -----------------------------------------------------------------
/** The main thread's longest busy stretch while fn runs (a 2 ms beat less the loop's idle time), and monitorEventLoopDelay's max. */
async function mainThread(fn) {
  const { monitorEventLoopDelay } = await import('node:perf_hooks')
  const h = monitorEventLoopDelay({ resolution: 1 })
  let last = performance.now()
  let lastIdle = performance.nodeTiming.idleTime
  let worst = 0
  const t = setInterval(() => {
    const now = performance.now()
    const idle = performance.nodeTiming.idleTime
    worst = Math.max(worst, now - last - (idle - lastIdle))
    last = now
    lastIdle = idle
  }, 2)
  h.enable()
  const idle0 = performance.nodeTiming.idleTime
  const t0 = performance.now()
  const value = await fn()
  const busy = performance.now() - t0 - (performance.nodeTiming.idleTime - idle0)
  h.disable()
  clearInterval(t)
  return { value, busyMs: busy, worstMs: worst, delayMaxMs: h.max / 1e6 }
}
{
  const { default: fs } = await import('node:fs')
  const { syncBuiltinESMExports } = await import('node:module')
  const touched = []
  const restore = []
  const spy = (obj, name) => {
    const real = obj[name]
    if (typeof real !== 'function') return
    obj[name] = function (p, ...a) {
      if (String(p?.href ?? p).startsWith('/srv/')) touched.push(`${name} ${p}`)
      return real.call(this, p, ...a)
    }
    restore.push(() => (obj[name] = real))
  }
  for (const n of ['openSync', 'readFileSync', 'statSync', 'lstatSync', 'existsSync', 'readdirSync', 'accessSync', 'statfsSync', 'open', 'readFile', 'stat', 'lstat', 'readdir', 'access', 'statfs']) spy(fs, n)
  for (const n of ['open', 'readFile', 'stat', 'lstat', 'readdir', 'access', 'statfs']) spy(fs.promises, n)
  syncBuiltinESMExports()
  // each index statement timed: none may be long (the day sums are windows of WINDOW_ROWS rows)
  let longest = { ms: 0, name: '' }
  const timed = new Proxy(index, {
    get: (t, k) =>
      typeof t[k] !== 'function'
        ? t[k]
        : (...a) => {
            const t0 = performance.now()
            const v = t[k](...a)
            const ms = performance.now() - t0
            if (ms > longest.ms) longest = { ms, name: String(k) }
            return v
          }
  })
  const runs = []
  for (let i = 0; i < 3; i++) {
    longest = { ms: 0, name: '' }
    const m = await mainThread(() => measureRetention({ index: timed, settings, now: NOW, protectedRanges, cache: new Map() }))
    runs.push({ ...m, longest })
  }
  for (const r of restore) r()
  syncBuiltinESMExports()
  const best = runs.reduce((a, b) => (Math.max(b.worstMs, b.longest.ms) < Math.max(a.worstMs, a.longest.ms) ? b : a))
  check('MEASURING 3 WHOLE DAYS OF 87 CAMERAS (375,840 ROWS) FROM SCRATCH: NO STRETCH OF MAIN THREAD OVER 50 MS (the best of three)', best.worstMs < 50 && best.longest.ms < 50 && best.delayMaxMs < 50, runs.map((r) => `longest stretch ${r.worstMs.toFixed(1)} ms, longest statement ${r.longest.ms.toFixed(1)} ms (${r.longest.name}), event-loop delay max ${r.delayMaxMs.toFixed(1)} ms, busy ${r.busyMs.toFixed(0)} ms in all`).join(' | '))
  check('... and no file call on the location: index searches only', touched.length === 0, touched.slice(0, 3).join('; '))
  // what the alert checks and the page ask for, from those figures: arithmetic
  const facts = best.value
  const rows = [rowOf({ held: 3 * TB })]
  const t0 = performance.now()
  for (let i = 0; i < 100; i++) retentionCandidates({ retention: retentionView({ facts, settings, locations: rows, now: NOW }), locations: rows })
  const each = (performance.now() - t0) / 100
  check('THE VIEW AND THE CANDIDATES (every alert check, every Health poll): under 1 ms from the figures', each < 1, `${each.toFixed(3)} ms each`)
}
index.close()

// ---- the watch: measured on its own timer; a failure keeps the last figures and says so ----------------------
{
  const warned = []
  const realWarn = console.warn
  console.warn = (m) => warned.push(String(m))
  try {
    const got = await T.refreshRetention({ index: { oldest: () => { throw new Error('the index is closed') }, startNth: () => { throw new Error('the index is closed') } }, settings, protectedRanges, now: NOW })
    check('A MEASUREMENT THAT THROWS: nothing thrown out of the timer, a warning in the log', got === null && warned.some((w) => /\[retention\].*the index is closed/.test(w)), J(warned))
  } finally {
    console.warn = realWarn
  }
  check('... and no index at all: nothing measured, nothing thrown', (await T.refreshRetention({ index: null, settings, protectedRanges, now: NOW })) === null)
}

// ---- server.mjs: the watch started, the candidates with the others, the Storage route given the marker and free space from storage.mjs ----
{
  const { readFileSync } = await import('node:fs')
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  check('server.mjs starts the watch with the index, the settings and the bookmarks', /startRetentionWatch\(\{ index: recIndex, settings: getSettings, protectedRanges \}\)/.test(server))
  check('... hands the alert checks retentionCandidates of the same report as the drive-filling forecast', /retentionCandidates\(report\)/.test(server) && /driveFullCandidates\(report, \{ days: 7 \}\)/.test(server))
  check('... and the Storage route storage.mjs\'s marker check and free space (never a file call on a share: statfsSync and the marker read were the defaults)', /setStorageContext\(\{[^}]*present: markerMatches[^}]*freeOf[^}]*\}\)/.test(server), (server.match(/setStorageContext\(\{[^}]*\}\)/) ?? [''])[0])
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
