// Tests for housekeeping.mjs: retention, low-space deletion and each location's space limit.
// Temp dirs, synthetic segment files, a fake free-space function. Run: node cctv/test/housekeeping.test.mjs
// The file calls go through the location's share helper (share-calls.mjs) since 2026-09-29 (perf report
// Task 3): most cases here hand runHousekeeping the helper's own ops run in this process
// (share-ops.mjs, the same marker and inside-the-folder refusals), a few the real helper process, and
// the timing case a fake share taking 3 ms a file call.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const data = mkdtempSync(join(tmpdir(), 'cctv-hk-'))
// Every folder this test makes, and the indexes in them, removed at its end: each run left about 57 hk-loc-* and
// hk-db-* folders (~23 MB) in the temp folder, 2,158 of them by 2026-09-30 (review of p3-thin; thinning.test's
// were fixed the same way in 966e6f4).
const made = []
const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  made.push(d)
  return d
}
const opened = [] // setup()'s indexes: closed at the end (Windows keeps an open database's file)
process.env.DATA_DIR = data
const { runHousekeeping, housekeepingCandidates, _test: hk } = await import('../housekeeping.mjs')
const { openRecIndex } = await import('../rec-index.mjs')
const { segmentPath } = await import('../segment-writer.mjs')
const { makeShareOps } = await import('../share-ops.mjs')
const { stopShareHelpers } = await import('../share-calls.mjs')
const { markerPresent } = await import('../storage-report.mjs')

const DAY = 86_400_000
const HOUR = 3_600_000
const GB = 1e9
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0)
const DEFAULTS = { mode: 'continuous', fullDays: 30, after: 'timelapse', timelapseS: 10, retentionDays: 183, preS: 10, postS: 20 }
const settingsWith = (locs, cameras = {}, storage = {}) => ({ recording: { defaults: DEFAULTS, cameras }, storage: { locations: locs, lowFreePct: 15, floorFreePct: 5, ...storage } })

/** The helper's own ops, run in this process: what the helper would do, without the process. */
const ops = new Map()
const localShare = (loc, op, args) => {
  const key = `${loc.id}\n${loc.path}`
  if (!ops.has(key)) ops.set(key, makeShareOps({ id: loc.id, root: loc.path }))
  const o = ops.get(key)
  if (!Object.hasOwn(o, op)) return Promise.reject(Object.assign(new Error(`EBADOP: ${op}`), { code: 'EBADOP' }))
  return o[op](args ?? {}, () => {})
}
/** runHousekeeping with this file's defaults: the local helper ops, the marker read off the folder, no bookmarks module. */
const run = (o) => runHousekeeping({ share: localShare, present: markerPresent, protectedRanges: null, now: NOW, log: () => {}, warn: () => {}, ...o })

function setup({ id = 'L1', limitGB = null, marks = {} } = {}) {
  const root = tmp('hk-loc-')
  writeFileSync(join(root, '.cctv-recordings'), JSON.stringify({ id }))
  // (a limit is enforced once saved through storage.mjs, which stamps limitSetAt)
  const loc = { id, path: root, type: 'usb', role: 'main', limitGB, ...(limitGB ? { limitSetAt: '2026-09-29T12:00:00.000Z' } : {}), ...marks }
  const index = openRecIndex(join(tmp('hk-db-'), 'r.db'))
  opened.push(index)
  const add = (nvr, ch, ageDays, bytes = 1000) => {
    const startMs = NOW - ageDays * DAY
    const path = segmentPath(root, nvr, ch, startMs, 'h264')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, Buffer.alloc(10))
    writeFileSync(`${path}.idx`, Buffer.alloc(16))
    index.addSegment({ nvr, ch, path, startMs, endMs: startMs + 59_000, bytes, keyframes: 1, loc: id })
    return path
  }
  return { root, loc, index, add }
}
// free space: totalBytes 100_000; free = base + bytes of deleted segments
const fakeFree = (base, total = 100_000) => {
  const f = { freed: 0, calls: 0, fn: () => (f.calls++, { freeBytes: base + f.freed, totalBytes: total }) }
  return f
}
const tail = (p) => p.split(/[\\/]/).slice(-5).join('/')

// ---- retention (through the real helper process: the default share) ------------------------------------
{
  const { loc, index, add } = setup()
  const old = add('n1', 0, 200)
  const keep = add('n1', 0, 100)
  const shortOld = add('n1', 1, 40) // this camera keeps 30 days only
  const shortKeep = add('n1', 1, 20)
  // no `share`: the default, shareCall, forks the location's helper
  const r = await runHousekeeping({ index, settings: settingsWith([loc], { 'n1/1': { retentionDays: 30, fullDays: 10 } }), freeOf: fakeFree(90_000).fn, now: NOW, present: markerPresent, protectedRanges: null, log: () => {}, warn: () => {} })
  check('retention: older than the camera retention is deleted (by the location\'s helper process)', !existsSync(old) && !existsSync(`${old}.idx`) && !existsSync(shortOld))
  check('retention: newer kept', existsSync(keep) && existsSync(shortKeep))
  check('retention: removed from the index', index.segments('n1', 0, 0, NOW).length === 1 && index.segments('n1', 1, 0, NOW).length === 1)
  check('retention: empty folders removed', !existsSync(dirname(old)) && !existsSync(dirname(dirname(old))))
  check('retention: result lists the deletions', r.deleted.length === 2 && r.deleted.every((d) => d.why === 'retention'), JSON.stringify(r.deleted))
  stopShareHelpers()
}

// ---- a file whose time-lapse rewrite is in flight is not deleted (thinning.mjs, perf report Task 4) ------
// The server stopped, or the share hung, in the middle of a rewrite: the file may be half swapped (the
// original aside as .thin-old) until the next thinning run puts it right. Deleting the segment meanwhile
// would leave that original on the share for good, out of the index.
{
  const { loc, index, add } = setup()
  const held = add('n1', 0, 200)
  const other = add('n1', 0, 199)
  index.thinBegin({ path: held, loc: loc.id, bytes: 1000, keyframes: 1 }, NOW)
  const free = fakeFree(1_000) // below the floor too: every rule wants the oldest
  const r = await run({ index, settings: settingsWith([loc]), freeOf: free.fn, onDelete: (seg) => (free.freed += seg.bytes) })
  check('A FILE WHOSE REWRITE IS IN FLIGHT IS NOT DELETED, by retention or below the floor', existsSync(held) && index.byPath(held) !== null && !existsSync(other) && !r.deleted.some((d) => d.path === held), JSON.stringify(r.deleted.map((d) => [tail(d.path), d.why])))
  index.thinEnd(held)
  await run({ index, settings: settingsWith([loc]), freeOf: fakeFree(1_000).fn })
  check('... and goes like any other once it is put right', !existsSync(held) && index.byPath(held) === null)
}

// ---- low space: oldest first, camera furthest past its full-days target first; full days protected
{
  const { loc, index, add } = setup()
  const a = add('n1', 0, 60) // cam0 fullDays 30: 30 days past target
  const b = add('n1', 0, 40) // 10 past
  const c = add('n1', 1, 25) // cam1 fullDays 5: 20 past
  const d = add('n1', 0, 10) // inside cam0 full days
  const e = add('n1', 1, 2) // inside cam1 full days
  const free = fakeFree(12_000) // 12% free, low mark 15% -> 3000 bytes to free
  const deletedOrder = []
  const r = await run({
    index,
    settings: settingsWith([loc], { 'n1/1': { fullDays: 5 } }),
    freeOf: free.fn,
    onDelete: (seg) => { deletedOrder.push(seg.path); free.freed += seg.bytes }
  })
  check('low space: deletes furthest past full-days target first', deletedOrder.join() === [a, c, b].join(), deletedOrder.map(tail).join(' '))
  check('low space: stops once above the low mark', existsSync(d) && existsSync(e))
  check('low space: result', r.deleted.filter((x) => x.why === 'low space').length === 3 && r.warnings.length === 0, JSON.stringify(r))
}

// ---- low space but only full-days footage left: kept, with a warning
{
  const { loc, index, add } = setup()
  const d = add('n1', 0, 10)
  const free = fakeFree(10_000) // 10%: low but above the 5% floor
  const r = await run({ index, settings: settingsWith([loc]), freeOf: free.fn, onDelete: (s) => (free.freed += s.bytes) })
  check('floor: footage inside full days is kept above the floor', existsSync(d))
  check('floor: a warning says so', r.warnings.length === 1 && /full-video days/.test(r.warnings[0]), JSON.stringify(r.warnings))
}

// ---- below the floor: full-days footage goes too (oldest first), with a warning
{
  const { loc, index, add } = setup()
  const d1 = add('n1', 0, 10)
  const d2 = add('n1', 0, 3)
  const free = fakeFree(4000) // 4% < 5% floor: 1000 bytes to reach the floor; the low mark would need 11000
  const r = await run({ index, settings: settingsWith([loc]), freeOf: free.fn, onDelete: (s) => (free.freed += s.bytes) })
  check('floor: below the floor, the oldest full-days footage is deleted', !existsSync(d1) && existsSync(d2))
  check('floor: warning logged', r.warnings.some((w) => /below the hard floor/.test(w)), JSON.stringify(r.warnings))
}

// ---- each location's own marks (the owner's NAS: a low mark near 7 % so 12 TB is usable, 2026-09-29)
{
  const { loc, index, add } = setup({ marks: { lowFreePct: 7, floorFreePct: 3 } })
  const old = add('n1', 0, 60)
  const r = await run({ index, settings: settingsWith([loc]), freeOf: fakeFree(10_000).fn })
  check('a location\'s own low mark (7 %): at 10 % free nothing is deleted, though the default is 15 %', existsSync(old) && r.deleted.length === 0, JSON.stringify(r.deleted))
  const f = fakeFree(6_000)
  const r2 = await run({ index, settings: settingsWith([loc]), freeOf: f.fn, onDelete: (s) => (f.freed += s.bytes) })
  check('... and below it (6 %) the footage past its full-video days goes', !existsSync(old) && r2.deleted.length === 1 && r2.deleted[0].why === 'low space', JSON.stringify(r2.deleted))
  const { loc: l2, index: i2, add: add2 } = setup({ marks: { floorFreePct: 2 } })
  const inside = add2('n1', 0, 3)
  const r3 = await run({ index: i2, settings: settingsWith([l2]), freeOf: fakeFree(4000).fn })
  check('a location\'s own floor (2 %): at 4 % free, footage inside its full-video days is kept', existsSync(inside) && r3.deleted.length === 0 && r3.warnings.some((w) => /full-video days/.test(w)), JSON.stringify(r3.warnings))
}

// ---- safety: a path outside the location root is never deleted
{
  const { loc, index } = setup()
  const outside = join(tmp('hk-out-'), 'x.h264')
  writeFileSync(outside, 'keep me')
  index.addSegment({ nvr: 'n1', ch: 0, path: outside, startMs: NOW - 300 * DAY, endMs: NOW - 300 * DAY + 1000, bytes: 7, keyframes: 1, loc: 'L1' })
  const r = await run({ index, settings: settingsWith([loc]), freeOf: fakeFree(90_000).fn })
  check('safety: file outside its location is not deleted', existsSync(outside) && r.warnings.some((w) => /outside/.test(w)), JSON.stringify(r.warnings))
  // ... nor when a caller's check were ever wrong: the helper refuses it on its own
  const refused = await localShare(loc, 'unlink', { paths: [outside], withIdx: true })
  check('safety: the helper refuses a path outside the location too', existsSync(outside) && refused[0]?.error === 'EOUTSIDE', JSON.stringify(refused))
}

// ---- no index (recording never started): nothing happens
{
  const r = await run({ index: null, settings: settingsWith([]) })
  check('no index: no-op', r.deleted.length === 0)
}

// ---- a drive that is not mounted: its mount point is an empty folder (no marker) on the system disk
for (const [name, marker] of [['marker missing (drive unplugged)', null], ['marker of another drive', '{"id":"OTHER"}']]) {
  const { root, loc, index, add } = setup()
  add('n1', 0, 200)
  add('n1', 0, 100)
  // unplugged: the files are on the drive, not here; only the empty mount point is left
  rmSync(join(root, 'n1'), { recursive: true, force: true })
  unlinkSync(join(root, '.cctv-recordings'))
  if (marker) writeFileSync(join(root, '.cctv-recordings'), marker)
  let statfsCalls = 0
  const calls = []
  const r = await run({ index, settings: settingsWith([loc]), freeOf: () => (statfsCalls++, { freeBytes: 1, totalBytes: 100_000 }), share: (l, op, a) => (calls.push(op), localShare(l, op, a)) })
  check(`not mounted (${name}): index rows kept (no ENOENT clean-up)`, index.segments('n1', 0, 0, NOW).length === 2 && r.deleted.length === 0, JSON.stringify(r.deleted))
  check(`not mounted (${name}): free space never read (it would be the system disk's), nothing asked of its helper`, statfsCalls === 0 && calls.length === 0, calls.join())
  check(`not mounted (${name}): a warning says it was skipped`, r.warnings.some((w) => /skipped/.test(w) && w.includes(root)), JSON.stringify(r.warnings))
}
// the marker went after the check said it was there (a share unmounted a second ago): the helper reads it
// again before it deletes anything, and refuses
{
  const { root, loc, index, add } = setup()
  const old = add('n1', 0, 200)
  writeFileSync(join(root, '.cctv-recordings'), '{"id":"OTHER"}')
  const r = await run({ index, settings: settingsWith([loc]), freeOf: fakeFree(90_000).fn, present: () => true })
  check('marker of another location, though the check said mounted: the helper refuses, the file and its row stay', existsSync(old) && index.byPath(old) !== null && r.deleted.length === 0 && r.warnings.some((w) => /marker/.test(w)), JSON.stringify(r.warnings))
}
// the default check really reads the marker (storage.mjs markerMatches), with the real helper process;
// storage.mjs needs the SDK build (it loads settings.mjs -> nvr-xml.mjs -> sdk.mjs): server only
{
  let storageLoads = true
  try {
    await import('../storage.mjs')
  } catch {
    storageLoads = false
  }
  if (!storageLoads) console.log('SKIP  default marker check (storage.mjs cannot be loaded without the SDK build: run on the server)')
  else {
    const { root, loc, index, add } = setup()
    const old = add('n1', 0, 200)
    unlinkSync(join(root, '.cctv-recordings'))
    const o = { index, settings: settingsWith([loc]), freeOf: fakeFree(90_000).fn, now: NOW, protectedRanges: null, log: () => {}, warn: () => {} }
    await runHousekeeping(o)
    check('default marker check: no marker -> nothing deleted', existsSync(old) && index.segments('n1', 0, 0, NOW).length === 1)
    writeFileSync(join(root, '.cctv-recordings'), '{"id":"L1"}')
    await runHousekeeping(o)
    check('default marker check: marker back -> retention runs again', !existsSync(old) && index.segments('n1', 0, 0, NOW).length === 0)
    stopShareHelpers()
  }
}
// mounted and healthy, a file already gone (ENOENT): its row is removed
{
  const { loc, index, add } = setup()
  const gone = add('n1', 0, 200)
  unlinkSync(gone)
  unlinkSync(`${gone}.idx`)
  const r = await run({ index, settings: settingsWith([loc]), freeOf: fakeFree(90_000).fn })
  check('healthy location, file already gone: row removed', index.segments('n1', 0, 0, NOW).length === 0 && r.deleted.length === 1)
}
{
  // the recording-gaps table is pruned with retention (the longest any camera keeps footage)
  const { loc, index } = setup()
  const gap = (ageDays, ch = 0) => index.addGap({ nvr: 'n1', ch, fromMs: NOW - ageDays * DAY - 60_000, toMs: NOW - ageDays * DAY, reason: 'no video from the NVR' })
  gap(200)
  gap(190, 1)
  gap(100)
  gap(1)
  await run({ index, settings: settingsWith([loc]), freeOf: fakeFree(90_000).fn })
  const left = [...index.gaps('n1', 0, 0, NOW), ...index.gaps('n1', 1, 0, NOW)]
  check('gaps older than the retention (183 days) are pruned, newer ones kept', left.length === 2 && left.every((g) => g.toMs >= NOW - 183 * DAY), JSON.stringify(left.map((g) => (NOW - g.toMs) / DAY)))
  const { loc: loc2, index: idx2 } = setup()
  idx2.addGap({ nvr: 'n1', ch: 0, fromMs: NOW - 300 * DAY - 1, toMs: NOW - 300 * DAY, reason: 'x' })
  idx2.addGap({ nvr: 'n1', ch: 0, fromMs: NOW - 500 * DAY - 1, toMs: NOW - 500 * DAY, reason: 'x' })
  await run({ index: idx2, settings: settingsWith([loc2], { 'n2/4': { retentionDays: 400 } }), freeOf: fakeFree(90_000).fn })
  check('a camera keeping 400 days: gaps kept up to 400 days', idx2.gaps('n1', 0, 0, NOW).length === 1)
}

// ---- bookmarked and exported stretches (bookmarks.mjs protectedRanges): kept by every rule here ---------
{
  const { loc, index, add } = setup()
  const booked = add('n1', 0, 200)
  const other = add('n1', 1, 210)
  const lowBooked = add('n1', 0, 60)
  const lowOther = add('n1', 0, 50)
  const f = fakeFree(13_500) // 1500 bytes short of the low mark: 1000 come from retention, the rest from low space
  const r = await run({ index, settings: settingsWith([loc]), freeOf: f.fn, onDelete: (s) => (f.freed += s.bytes), protectedRanges: () => [[NOW - 200 * DAY, NOW - 200 * DAY + 1000], [NOW - 60 * DAY, NOW - 60 * DAY + 1000]] })
  check('bookmarked: kept past its retention days, while the rest goes', existsSync(booked) && !existsSync(other) && index.byPath(booked) !== null)
  check('bookmarked: kept at low space too, the next oldest goes instead', existsSync(lowBooked) && !existsSync(lowOther), JSON.stringify(r.deleted.map((d) => tail(d.path))))
  check('bookmarked: listed as skipped', r.skipped.some((s) => s.path === booked && /bookmark/.test(s.why)), JSON.stringify(r.skipped))
  const { loc: l2, index: i2, add: add2 } = setup()
  const s = add2('n1', 0, 200)
  const r2 = await run({ index: i2, settings: settingsWith([l2]), freeOf: fakeFree(1000).fn, protectedRanges: () => { throw new Error('bookmarks table locked') } })
  check('BOOKMARKS UNREADABLE: NOTHING DELETED, however old or full', existsSync(s) && r2.deleted.length === 0 && r2.warnings.some((w) => /bookmarks could not be read/.test(w)), JSON.stringify(r2.warnings))
  // ... and since nothing is deleted, not even at the floor, a location below its low mark pages the
  // owner (the shared NAS would otherwise fill to 0 with a console line only: review of p2-delete)
  hk.reset()
  const locked = () => { throw new Error('bookmarks table locked') }
  await run({ index: i2, settings: settingsWith([l2]), freeOf: fakeFree(1000).fn, protectedRanges: locked })
  const c1 = housekeepingCandidates()
  check('... below its low mark: an alert (drive-full, which pages) that nothing is deleted because the bookmarks cannot be read', c1.length === 1 && c1[0].key === 'drive-full/L1/bookmarks-unread' && c1[0].kind === 'drive-full' && /bookmarks/.test(c1[0].title) && /1\.0% free/.test(c1[0].detail) && /bookmarks table locked/.test(c1[0].detail), JSON.stringify(c1))
  await run({ index: i2, settings: settingsWith([l2]), freeOf: fakeFree(90_000).fn, protectedRanges: locked })
  check('... with room above its low mark: the warning only, no alert', housekeepingCandidates().length === 0, JSON.stringify(housekeepingCandidates()))
  // an alarm the run could not look at again stays (here: deleting did not free space)
  const { _test: deleting } = await import('../segment-delete.mjs')
  deleting.setStall('L1', { since: NOW - 60_000, retryAt: NOW + HOUR, deletedBytes: 5 * GB, roseBytes: 0, freeAfter: 1000 })
  await run({ index: i2, settings: settingsWith([l2]), freeOf: fakeFree(1000).fn, protectedRanges: locked })
  check('... and the alarms it could not look at again are kept (not freeing space)', housekeepingCandidates().map((c) => c.key).sort().join() === 'drive-full/L1/bookmarks-unread,drive-full/L1/not-freeing', JSON.stringify(housekeepingCandidates().map((c) => c.key)))
  await run({ index: i2, settings: settingsWith([l2]), freeOf: fakeFree(90_000).fn, sleep: async () => {} })
  check('... readable again: that alert ends', !housekeepingCandidates().some((c) => /bookmarks-unread/.test(c.key)), JSON.stringify(housekeepingCandidates()))
  hk.reset()
}

// ---- the space limit (location.limitGB, 1 GB = 1,000,000,000 bytes; the owner's 12 TB on the NAS) --------
// A NAS with room that frees the space of what is deleted (else the rise check would, rightly, stop
// deleting for free space on it: see below)
const roomy = () => {
  const f = fakeFree(900 * GB, 1000 * GB)
  return { freeOf: f.fn, onDelete: (s) => (f.freed += s.bytes) }
}
hk.reset()
{
  const { loc, index, add } = setup({ limitGB: 3 })
  const d10 = add('n1', 0, 10, GB)
  const d9 = add('n1', 0, 9, GB)
  const d8 = add('n1', 1, 8, GB)
  const d3 = add('n1', 0, 3, GB)
  const d2 = add('n1', 1, 2, GB)
  const h1 = add('n1', 0, 1 / 24, GB)
  const lines = []
  const r = await run({ index, settings: settingsWith([loc]), ...roomy(), log: (l) => lines.push(l) })
  check('over the limit: the oldest go until it is met (6 GB held, 3 GB allowed)', !existsSync(d10) && !existsSync(d9) && !existsSync(d8) && existsSync(d3) && existsSync(d2) && existsSync(h1), JSON.stringify(r.deleted.map((d) => tail(d.path))))
  check('... listed as over the limit, and the index agrees; nothing to warn about', r.deleted.length === 3 && r.deleted.every((d) => d.why === 'over the limit') && index.locationUse('L1').bytes === 3 * GB && r.warnings.length === 0, JSON.stringify(r.warnings))
  const oldestNow = new Date(NOW - 3 * DAY).toISOString().slice(0, 16).replace('T', ' ')
  check('... one line for the run: "over the 3 GB limit on <folder>: deleted 3 files, 3.0 GB, oldest now <date>"', lines.length === 1 && lines[0] === `[housekeeping] over the 3 GB limit on ${loc.path}: deleted 3 files, 3.0 GB, oldest now ${oldestNow} UTC`, JSON.stringify(lines))
  const again = await run({ index, settings: settingsWith([loc]), ...roomy() })
  check('... and at the limit, nothing more goes', again.deleted.length === 0 && existsSync(d3))
}
{
  // a limit saved before the limit was enforced (the old page saved it as a note: no question asked, no
  // size check) is not enforced until an admin saves it on this page (review of p2-delete, 2026-09-29)
  const { loc, index, add } = setup({ limitGB: 1 })
  delete loc.limitSetAt
  const old = add('n1', 0, 10, GB)
  add('n1', 0, 9, GB)
  const r = await run({ index, settings: settingsWith([loc]), ...roomy() })
  check('a limit saved before it was enforced (no limitSetAt): nothing deleted for it', existsSync(old) && r.deleted.length === 0 && index.locationUse('L1').segments === 2, JSON.stringify(r.deleted))
}
{
  // the same scoring as low space: footage furthest past its camera's full-video days first, so a camera
  // keeping 5 full days loses its 8-day-old footage before another camera's 10-day-old full video
  const { loc, index, add } = setup({ limitGB: 2 })
  const a10 = add('n1', 0, 10, GB) // fullDays 30: 20 days short of its time-lapse
  const b8 = add('n1', 1, 8, GB) // fullDays 5: 3 days past
  add('n1', 1, 3, GB)
  const r = await run({ index, settings: settingsWith([loc], { 'n1/1': { fullDays: 5 } }), ...roomy() })
  check('over the limit: by the same scoring (past its camera\'s full-video days first), not simply oldest', !existsSync(b8) && existsSync(a10) && r.deleted.length === 1, JSON.stringify(r.deleted.map((d) => tail(d.path))))
}
{
  const { loc, index, add } = setup({ limitGB: 1 })
  const booked = add('n1', 0, 10, GB)
  const next = add('n1', 0, 9, GB)
  add('n1', 0, 3, GB)
  const r = await run({ index, settings: settingsWith([loc]), ...roomy(), protectedRanges: () => [[NOW - 10 * DAY, NOW - 10 * DAY + 1000]] })
  check('over the limit: a bookmarked stretch is kept, the next oldest goes', existsSync(booked) && !existsSync(next) && r.skipped.some((s) => s.path === booked), JSON.stringify(r.deleted.map((d) => tail(d.path))))
}
{
  const { loc, index, add } = setup({ limitGB: 1 })
  const a = add('n1', 0, 20 / 24, GB)
  const b = add('n1', 1, 10 / 24, GB)
  const c = add('n1', 0, 1 / 24, GB)
  const warned = []
  const r = await run({ index, settings: settingsWith([loc]), ...roomy(), warn: (w) => warned.push(w) })
  check('over the limit, but everything is from the newest 24 h: nothing deleted', existsSync(a) && existsSync(b) && existsSync(c) && r.deleted.length === 0)
  check('... and it says so loudly', warned.some((w) => /limit/.test(w) && /newest 24 h/.test(w)) && r.warnings.some((w) => /newest 24 h/.test(w)), JSON.stringify(warned))
  const cands = housekeepingCandidates()
  check('... and it is an alert (drive-full, which pages the owner) until a run can meet the limit', cands.length === 1 && cands[0].kind === 'drive-full' && cands[0].key === 'drive-full/L1/limit-blocked' && /over its space limit/.test(cands[0].title) && /newest 24 h/.test(cands[0].detail), JSON.stringify(cands))
}
{
  // a bookmarked stretch in the middle of the oldest footage (bookmarks protect every camera): the limit
  // deletes what is before it and after it, each camera stepping over it in one look, and keeps all of
  // it; a file that starts before the stretch and runs into it is kept too (review of p2-delete)
  hk.reset()
  const { loc, index } = setup({ limitGB: 1 })
  const t0 = NOW - 20 * DAY
  const MIN = 60_000
  const put = (ch, s, e = s + 59_000, path = segmentPath(loc.path, 'n1', ch, s, 'h264')) => index.addSegment({ nvr: 'n1', ch, path, startMs: s, endMs: e, bytes: 1e7, keyframes: 1, loc: 'L1' })
  for (let k = 0; k < 200; k++) for (let ch = 0; ch < 3; ch++) put(ch, t0 + k * MIN)
  // (a second file in minute 48: a name of its own)
  const crossing = segmentPath(loc.path, 'n1', 0, t0 + 48 * MIN, 'h265')
  put(0, t0 + 48 * MIN + 30_000, t0 + 49 * MIN + 30_000, crossing) // runs into the stretch (with its 1-minute margin, from minute 49)
  const stretch = [t0 + 50 * MIN, t0 + 149 * MIN] // kept with the margin: minutes 49 to 150 of each camera
  const kept = (s) => s.startMs <= t0 + 150 * MIN && s.endMs >= t0 + 49 * MIN
  let reads = 0
  const counted = new Proxy(index, { get: (t, k) => (['oldest', 'oldestOf', 'oldestPerCamera'].includes(k) ? (...a) => (reads++, t[k](...a)) : t[k]) })
  const share = async (l, op, a) => (op === 'unlink' ? a.paths.map((path) => ({ path, ok: true })) : op === 'rmdir' ? a.dirs.map((dir) => ({ dir, removed: [] })) : { freeBytes: 900 * GB, totalBytes: 1000 * GB })
  const warned = []
  const r = await runHousekeeping({ index: counted, settings: settingsWith([loc]), share, present: () => true, protectedRanges: () => [stretch], now: NOW, log: () => {}, warn: (w) => warned.push(w), sleep: async () => {} })
  const left = [0, 1, 2].flatMap((ch) => index.segments('n1', ch, 0, NOW))
  check('a bookmarked stretch in the middle: everything before and after it goes for the limit, none of it', r.deleted.length === 3 * 98 && left.length === 3 * 102 + 1 && left.every(kept) && r.deleted.every((d) => d.why === 'over the limit'), `${r.deleted.length} deleted, ${left.length} left, ${left.filter((s) => !kept(s)).length} of them not bookmarked`)
  check('... the file running into it is kept', index.byPath(crossing) !== null)
  check('... each camera steps over it with one look (not 102 rows each)', reads <= 12, `${reads} reads`)
  check('... and over the limit with only bookmarked footage left: said loudly', warned.some((w) => /OVER THE LIMIT/.test(w) && /bookmarked/.test(w)), JSON.stringify(warned))
}
{
  // a marker of another location: nothing on it is touched for the limit either
  const { root, loc, index, add } = setup({ limitGB: 1 })
  const old = add('n1', 0, 10, GB)
  add('n1', 0, 9, GB)
  writeFileSync(join(root, '.cctv-recordings'), '{"id":"OTHER"}')
  const r = await run({ index, settings: settingsWith([loc]), ...roomy() })
  check('over the limit on a location whose marker is another\'s: nothing touched, rows kept', existsSync(old) && index.locationUse('L1').segments === 2 && r.deleted.length === 0 && r.warnings.some((w) => /skipped/.test(w)), JSON.stringify(r.warnings))
  const r2 = await run({ index, settings: settingsWith([loc]), ...roomy(), present: () => true })
  check('... nor when the check was out of date: the helper reads the marker and refuses', existsSync(old) && index.locationUse('L1').segments === 2 && r2.deleted.length === 0, JSON.stringify(r2.warnings))
}

// ---- deleting through the helper: batches, a file that will not go, a helper that stops answering --------
{
  const { loc, index, add } = setup()
  const paths = []
  for (let i = 0; i < 250; i++) paths.push(add('n1', i % 3, 200 + i / 1440))
  const stuck = paths[7]
  const calls = []
  const share = async (l, op, a) => {
    calls.push({ op, n: a?.paths?.length ?? a?.dirs?.length ?? 0 })
    const res = await localShare(l, op, a)
    return op === 'unlink' ? res.map((x) => (x.path === stuck ? { path: x.path, ok: false, error: 'EACCES', file: x.path } : x)) : res
  }
  let removeMany = 0
  const counted = new Proxy(index, { get: (t, k) => (k === 'removeMany' ? (p) => (removeMany++, t.removeMany(p)) : t[k]) })
  const r = await run({ index: counted, settings: settingsWith([loc]), freeOf: fakeFree(90_000).fn, share })
  const unlinks = calls.filter((c) => c.op === 'unlink')
  check('250 files past retention: 3 calls to the helper (at most 100 files each), 3 index transactions', unlinks.length === 3 && unlinks.every((c) => c.n <= 100) && removeMany === 3, JSON.stringify(unlinks))
  check('... a file the helper could not delete keeps its row, with a warning; the rest go', r.deleted.length === 249 && index.byPath(stuck) !== null && index.locationUse('L1').segments === 1 && r.warnings.some((w) => w.includes('EACCES')), JSON.stringify(r.warnings))
}
{
  const { loc, index, add } = setup()
  for (let i = 0; i < 250; i++) add('n1', 0, 200 + i / 1440)
  let unlinks = 0
  const share = async (l, op, a) => {
    if (op === 'unlink' && ++unlinks === 2) throw Object.assign(new Error('share not answering'), { code: 'ESHARESTUCK' })
    return localShare(l, op, a)
  }
  const r = await run({ index, settings: settingsWith([loc]), freeOf: fakeFree(90_000).fn, share })
  check('a helper that stops answering: the run stops on that location, the rows of the batch not confirmed stay', r.deleted.length === 100 && index.locationUse('L1').segments === 150 && r.warnings.some((w) => /not answering/.test(w)) && unlinks === 2, `${r.deleted.length} deleted, ${index.locationUse('L1').segments} left: ${JSON.stringify(r.warnings)}`)
}

// ---- free space that does not rise when files are deleted (a recycle bin or snapshots on the NAS) --------
{
  hk.reset()
  const { loc, index, add } = setup()
  for (let i = 0; i < 20; i++) add('n1', 0, 60 - i, 2 * GB)
  // 100 TB share, 14.99 % free: 10 GB to reach the 15 % low mark, and free space that never moves
  const total = 100_000 * GB
  const stuckFree = () => ({ freeBytes: 0.15 * total - 10 * GB, totalBytes: total })
  const warned = []
  const waits = []
  const r = await run({ index, settings: settingsWith([loc]), freeOf: stuckFree, warn: (w) => warned.push(w), sleep: async (ms) => waits.push(ms) })
  check('low space: 10 GB to free, 5 files of 2 GB deleted', r.deleted.length === 5, String(r.deleted.length))
  check('... an alert too: deleting does not free space', housekeepingCandidates().some((c) => c.key === 'drive-full/L1/not-freeing' && c.kind === 'drive-full' && /does not free space/.test(c.title)), JSON.stringify(housekeepingCandidates()))
  check('... free space did not rise: asked again later (a NAS may report it late), then a loud warning', waits.length >= 2 && warned.some((w) => /free space/.test(w) && /recycle bin|snapshots/.test(w)), `${waits.join()} ${JSON.stringify(warned)}`)
  check('... the warning says another program writing to the share can cause it too (the NAS is shared)', warned.some((w) => /another program writing to the share/.test(w)), JSON.stringify(warned))
  // a restart does not forget it (in memory only, the first run after each restart deleted the whole
  // shortfall again, up to 20,000 files: review of p2-delete)
  const { _test: deleting } = await import('../segment-delete.mjs')
  deleting.reload()
  check('... it is kept in DATA_DIR: after a restart the location is still known not to free space', hk.stalled('L1') !== null && existsSync(join(data, 'storage-stalls.json')), JSON.stringify(hk.stalled('L1')))
  const r2 = await run({ index, settings: settingsWith([loc]), freeOf: stuckFree, now: NOW + 5 * 60_000, sleep: async () => {} })
  check('... so the next run deletes nothing for free space on it (no runaway deletion), and says why', r2.deleted.length === 0 && r2.warnings.some((w) => /free space/.test(w)), JSON.stringify(r2.warnings))
  // an hour on, one small try: at most 2 GB; free space now rises with it, and deletion goes on as before
  let freed = 0
  const risingFree = () => ({ freeBytes: 0.15 * total - 10 * GB + freed, totalBytes: total })
  const r3 = await run({ index, settings: settingsWith([loc]), freeOf: risingFree, now: NOW + 65 * 60_000, onDelete: (s) => (freed += s.bytes), sleep: async () => {} })
  check('... an hour later one small try (at most 2 GB), and free space seen to rise clears it', r3.deleted.length === 1 && hk.stalled('L1') === null, `${r3.deleted.length} deleted, ${JSON.stringify(hk.stalled('L1'))}`)
  hk.reset()
}
{
  // below the hard floor, though, one small try every run (at most 2 GB), not once an hour: when another
  // program's writes made free space look stuck, deleting comes back within 5 minutes, not an hour, while
  // a NAS that really keeps deleted files loses 2 GB a run of its oldest footage at most (review of p2-delete)
  hk.reset()
  const { loc, index, add } = setup()
  for (let i = 0; i < 20; i++) add('n1', 0, 60 - i, 2 * GB)
  const total = 100_000 * GB
  const { _test: deleting } = await import('../segment-delete.mjs')
  deleting.setStall('L1', { since: NOW - 60_000, retryAt: NOW + HOUR, deletedBytes: 10 * GB, roseBytes: 0, freeAfter: 0.04 * total })
  const floorFree = () => ({ freeBytes: 0.04 * total, totalBytes: total })
  const f1 = await run({ index, settings: settingsWith([loc]), freeOf: floorFree, sleep: async () => {} })
  const f2 = await run({ index, settings: settingsWith([loc]), freeOf: floorFree, now: NOW + 5 * 60_000, sleep: async () => {} })
  check('stalled and below the hard floor: one small try every run (2 GB each, oldest first), the stall on while it frees nothing', f1.deleted.length === 1 && f2.deleted.length === 1 && hk.stalled('L1') !== null && f1.warnings.some((w) => /one small try this run/.test(w)), `${f1.deleted.length}, ${f2.deleted.length}: ${JSON.stringify(f1.warnings)}`)
  deleting.setStall('L1', { since: NOW - 60_000, retryAt: NOW + HOUR, deletedBytes: 10 * GB, roseBytes: 0, freeAfter: 0.1 * total })
  const above = await run({ index, settings: settingsWith([loc]), freeOf: () => ({ freeBytes: 0.1 * total, totalBytes: total }), now: NOW + 10 * 60_000, sleep: async () => {} })
  check('... above the floor (below the low mark): still once an hour', above.deleted.length === 0, String(above.deleted.length))
  hk.reset()
}
{
  // the NAS freed the space late: at a later run's start free space is up by more than half of what was
  // deleted, so the stall ends there (it would otherwise last, with its alert, until the next deletion)
  hk.reset()
  const { loc, index, add } = setup()
  for (let i = 0; i < 20; i++) add('n1', 0, 60 - i, 2 * GB)
  const total = 100_000 * GB
  let free = 0.15 * total - 10 * GB
  await run({ index, settings: settingsWith([loc]), freeOf: () => ({ freeBytes: free, totalBytes: total }), sleep: async () => {} })
  const stalledFirst = hk.stalled('L1') !== null
  free += 10 * GB // the 10 GB show up late; the location is above its low mark now
  const lines = []
  const r = await run({ index, settings: settingsWith([loc]), freeOf: () => ({ freeBytes: free, totalBytes: total }), now: NOW + 5 * 60_000, log: (l) => lines.push(l), sleep: async () => {} })
  check('deleted space that shows up late ends the stall at the next run, and says so', stalledFirst && hk.stalled('L1') === null && r.deleted.length === 0 && lines.some((l) => /free space of the files deleted earlier has come back/.test(l)) && housekeepingCandidates().length === 0, `${stalledFirst} ${JSON.stringify(hk.stalled('L1'))} ${JSON.stringify(lines)}`)
  hk.reset()
}

// ---- the main thread while it deletes: 87 cameras x 1,000 segments, a share taking 3 ms a file call -------
// Perf report R2 / Task 3 (2026-09-29): at the NAS's floor each 5-minute run deletes what 5 minutes
// recorded, about 470 files, and the old loop picked each one by asking all 87 cameras again (22.8 ms)
// and made 3-4 SMB calls per file on the main thread: 12-15 s frozen every run. Here the pick is made
// once per run and the file calls wait on the helper (a fake here, 3 ms a file call, answering
// asynchronously as the helper process does), so the longest stretch the main thread is busy must stay
// under 50 ms, and the index is asked at most once per 50 files deleted. Twice: on a fake index (the
// task's proof: housekeeping's own work), and on the real one (rec-index.mjs, SQLite) with its rows in
// the order recording writes them (minute by minute, the cameras in turn).
{
  const CAMS = 87
  const PER = 1000
  const SEG = 12_000_000 // an average production segment, 12 MB
  const TOTAL = 16_630 * GB
  const WANT = 470
  const root = tmp('hk-nas-')
  const loc = { id: 'NAS', path: root, type: 'network', role: 'main', limitGB: null }
  const camsList = Array.from({ length: CAMS }, (_, c) => ({ nvr: `nvr${c % 4}`, ch: c }))
  const startOf = (k) => NOW - 20 * DAY + k * 60_000
  const rowOf = (c, k) => ({ nvr: camsList[c].nvr, ch: c, path: segmentPath(root, camsList[c].nvr, c, startOf(k), 'h265'), startMs: startOf(k), endMs: startOf(k) + 59_900, bytes: SEG, keyframes: 60, loc: 'NAS' })
  const firstMinutes = new Set() // each camera's first 6 minute files: the oldest 522
  for (let c = 0; c < CAMS; c++) for (let k = 0; k < 6; k++) firstMinutes.add(rowOf(c, k).path)
  // A 2-hour bookmark at the oldest end (review of p2, 2026-09-29): bookmarks protect every camera, so
  // with the 1-minute margin each camera's first 122 minute files (10,614 rows) are kept, and the 470 go
  // from the 6 minutes after it. Passing those rows one by one on the main thread was 120-136 ms on the
  // production VM, and every run walked them again (261 index reads with nothing to delete).
  const BOOKED = [startOf(0), startOf(120)]
  const afterBooked = new Set()
  for (let c = 0; c < CAMS; c++) for (let k = 122; k < 128; k++) afterBooked.add(rowOf(c, k).path)

  /** The index as housekeeping asks it, in memory: per camera its rows oldest first, and the ones removed. */
  // built once: 87,000 rows made just before a round were collected by the garbage collector during it
  const byCam = camsList.map((_, c) => Array.from({ length: PER }, (_, k) => rowOf(c, k)))
  function fakeIndex() {
    const gone = new Set()
    let goneBytes = 0
    const from = (c, fromMs, limit) => {
      const out = []
      for (const r of byCam[c]) {
        if (out.length >= limit) break
        if (r.startMs >= fromMs && !gone.has(r.path)) out.push({ ...r })
      }
      return out
    }
    const camNo = (nvr, ch) => (camsList[ch]?.nvr === nvr ? ch : -1)
    return {
      cameras: () => camsList.map((c) => ({ ...c })),
      locationUse: () => ({ bytes: CAMS * PER * SEG - goneBytes, segments: CAMS * PER - gone.size }),
      oldest: (limit, { fromMs = -Infinity } = {}) => byCam.flatMap((_, c) => from(c, fromMs, limit)).sort((a, b) => a.startMs - b.startMs).slice(0, limit),
      oldestPerCamera: (_loc, cams, limit, fromMs = -Infinity) => cams.flatMap((x) => (camNo(x.nvr, x.ch) >= 0 ? from(x.ch, fromMs, limit) : [])),
      oldestOf: (nvr, ch, _loc, limit, fromMs = -Infinity) => (camNo(nvr, ch) >= 0 ? from(ch, fromMs, limit) : []),
      removeMany: (paths) => {
        for (const p of paths) {
          if (gone.has(p)) continue
          gone.add(p)
          goneBytes += SEG
        }
      },
      forgetGapsBefore: () => {},
      backfillForgetBefore: () => {},
      close: () => {}
    }
  }
  // the real index, its rows written minute by minute with the cameras in turn, as recording writes them
  const bigDir = tmp('hk-big-')
  const template = join(bigDir, 'template.db')
  {
    openRecIndex(template).close()
    const raw = new DatabaseSync(template)
    const ins = raw.prepare('INSERT INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    raw.exec('BEGIN')
    for (let k = 0; k < PER; k++) {
      for (let c = 0; c < CAMS; c++) {
        const r = rowOf(c, k)
        ins.run(r.path, r.nvr, r.ch, r.startMs, r.endMs, r.bytes, r.keyframes, r.loc)
      }
    }
    raw.exec('COMMIT')
    raw.close() // the last connection: the log is written back into the file, which is copied per round
  }
  let copies = 0
  const realIndex = () => {
    const f = join(bigDir, `copy${copies++}.db`)
    copyFileSync(template, f)
    const ix = openRecIndex(f)
    ix.file = f
    return ix
  }

  const settings = { recording: { defaults: { ...DEFAULTS, fullDays: 7 }, cameras: {} }, storage: { locations: [loc], lowFreePct: 15, floorFreePct: 5 } }
  /** The main thread's longest busy stretch: between two runs of a 5 ms timer, the time that passed less the loop's idle time. */
  const beat = () => {
    let last = performance.now()
    let lastIdle = performance.nodeTiming.idleTime
    let worst = 0
    const step = () => {
      const now = performance.now()
      const idle = performance.nodeTiming.idleTime
      worst = Math.max(worst, now - last - (idle - lastIdle))
      last = now
      lastIdle = idle
    }
    const t = setInterval(step, 5)
    return () => (clearInterval(t), step(), worst)
  }
  const writes = new Set(['removeMany', 'remove', 'forgetGapsBefore', 'backfillForgetBefore', 'addSegment'])
  async function once(make, ranges = []) {
    const index = make()
    const before = index.locationUse('NAS').segments
    const calls = {}
    const counted = new Proxy(index, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => ((calls[k] = (calls[k] ?? 0) + 1), t[k](...a)) : t[k]) })
    let freed = 0
    const fileCalls = { unlink: 0, rmdir: 0, statfs: 0 }
    const free0 = (TOTAL * 15) / 100 - WANT * SEG + 1 // 470 files short of the low mark
    const share = async (l, op, a) => {
      if (op === 'statfs') {
        fileCalls.statfs++
        await sleep(3)
        return { freeBytes: free0 + freed, totalBytes: TOTAL }
      }
      if (op === 'unlink') {
        fileCalls.unlink += a.paths.length * 2
        await sleep(3 * a.paths.length * 2) // each file and its .idx, one call each
        freed += a.paths.length * SEG
        return a.paths.map((path) => ({ path, ok: true }))
      }
      if (op === 'rmdir') {
        fileCalls.rmdir += a.dirs.length
        await sleep(3 * a.dirs.length)
        return a.dirs.map((dir) => ({ dir, removed: [dir] }))
      }
      throw new Error(`unexpected ${op}`)
    }
    const eld = monitorEventLoopDelay({ resolution: 1 })
    eld.enable()
    const stop = beat()
    const t0 = performance.now()
    const r = await runHousekeeping({ index: counted, settings, share, present: () => true, protectedRanges: () => ranges, now: NOW, log: () => {}, warn: () => {}, sleep: async () => {} })
    const took = performance.now() - t0
    const busy = stop()
    eld.disable()
    const reads = Object.entries(calls).filter(([k]) => !writes.has(k)).reduce((a, [, n]) => a + n, 0)
    let walPages = null
    if (index.file) {
      try {
        walPages = Math.round(statSync(`${index.file}-wal`).size / (4096 + 24))
      } catch {}
    }
    const out = { busy, eld: eld.max / 1e6, took, deleted: r.deleted.length, left: before - index.locationUse('NAS').segments, reads, calls, fileCalls, first: r.deleted[0]?.path, r, walPages }
    index.close()
    return out
  }
  // the lowest of up to 3 rounds, each from the same rows: a synchronous stretch shows in every round,
  // while this PC being busy with other programs stretches one now and then (as in share-helper.test.mjs)
  async function quietest(make, ranges) {
    const rounds = []
    for (let round = 0; round < 3; round++) {
      rounds.push(await once(make, ranges))
      if (rounds.at(-1).busy < 50 && rounds.at(-1).eld < 50) break
    }
    return { best: rounds.reduce((a, b) => (b.busy < a.busy ? b : a)), text: rounds.map((x) => `${x.busy.toFixed(1)} / ${x.eld.toFixed(1)} ms`).join(', ') }
  }
  for (const [name, make] of [['a fake index', fakeIndex], ['the real index (SQLite)', realIndex]]) {
    const { best, text } = await quietest(make)
    check(`${name}: 470 files deleted from 87 x 1,000 segments at a share taking 3 ms a file call, and the main thread's longest busy stretch is under 50 ms (the old loop: about 12-15 s)`, best.deleted === WANT && best.left === WANT && best.busy < 50, `${best.deleted} deleted in ${Math.round(best.took)} ms; longest busy stretch ${best.busy.toFixed(1)} ms; rounds (busy / event-loop delay): ${text}`)
    check(`${name}: ... monitorEventLoopDelay agrees, no delay of 50 ms or more`, best.eld < 50, `${best.eld.toFixed(1)} ms`)
    check(`${name}: ... the index asked at most once per 50 files deleted`, best.reads <= Math.ceil(WANT / 50), `${best.reads} reads: ${JSON.stringify(best.calls)}`)
    check(`${name}: ... its rows removed in one transaction per batch of at most 100`, (best.calls.removeMany ?? 0) <= Math.ceil(WANT / 100) && !best.calls.remove, JSON.stringify(best.calls))
    check(`${name}: ... the oldest first (each camera's first minutes)`, best.r.deleted.every((d) => d.why === 'low space' && firstMinutes.has(d.path)), best.first)
    check(`${name}: ... folders tried only where the index says one was emptied (here none: each camera's next file is in the same hour)`, best.fileCalls.rmdir === 0, JSON.stringify(best.fileCalls))
    // Not this path's work, but on its thread: SQLite writes the database file back from its log (a
    // checkpoint) in whichever write takes the log past 1,000 pages, about 63 ms on production and
    // every ~90 s from recording alone (perf report R11). The pages these deletions add bring about one
    // more a run; moving checkpoints off the main thread is Task 12's.
    if (best.walPages !== null) console.log(`NOTE  ${name}: the 470 deletions wrote about ${best.walPages} pages to SQLite's log (a checkpoint every 1,000 pages: perf report R11, Task 12)`)
  }
  // the same behind a 2-hour bookmark at the oldest end: the stretch is stepped over, not walked row by row
  for (const [name, make] of [['a fake index', fakeIndex], ['the real index (SQLite)', realIndex]]) {
    const { best, text } = await quietest(make, [BOOKED])
    check(`behind a 2-hour bookmark on all 87 cameras (${name}): 470 files deleted, the main thread's longest busy stretch under 50 ms (review: 120-136 ms on the production VM)`, best.deleted === WANT && best.left === WANT && best.busy < 50 && best.eld < 50, `${best.deleted} deleted in ${Math.round(best.took)} ms; rounds (busy / event-loop delay): ${text}`)
    check(`... (${name}) none of it bookmarked: the 6 minutes after the stretch`, best.r.deleted.every((d) => d.why === 'low space' && afterBooked.has(d.path)), best.first)
    check(`... (${name}) the stretch passed with a look or two, not row by row: the index asked at most once per 50 files deleted (review: 261 reads)`, best.reads <= Math.ceil(WANT / 50), `${best.reads} reads: ${JSON.stringify(best.calls)}`)
    check(`... (${name}) what was passed over is said once per stretch, not once per row (10,614 rows)`, best.r.skipped.length >= 1 && best.r.skipped.length <= CAMS && best.r.skipped.every((s) => /bookmark/.test(s.why)), String(best.r.skipped.length))
  }

  // Nothing to delete but a 2-hour bookmark 40 days old, past the 30 days kept (the review's rewalk.mjs):
  // bookmarked footage is never deleted, so it stays the oldest for good, and every 5-minute run walked
  // all 10,440 of its rows again (165-199 ms on Windows; about 1.5 s for a 24-hour bookmark). Now each
  // run steps over it with a look or two.
  {
    const f = join(bigDir, 'rewalk.db')
    openRecIndex(f).close()
    const raw = new DatabaseSync(f)
    const ins = raw.prepare('INSERT INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const b0 = NOW - 40 * DAY
    const put = (c, s) => ins.run(segmentPath(root, camsList[c].nvr, c, s, 'h265'), camsList[c].nvr, c, s, s + 59_000, 1000, 1, 'NAS')
    raw.exec('BEGIN')
    for (let k = 0; k < 120; k++) for (let c = 0; c < CAMS; c++) put(c, b0 + k * 60_000)
    for (let k = 0; k < 60; k++) for (let c = 0; c < CAMS; c++) put(c, NOW - 2 * DAY + k * 60_000)
    raw.exec('COMMIT')
    raw.close()
    const index = openRecIndex(f)
    const rs = { recording: { defaults: { ...DEFAULTS, fullDays: 7, retentionDays: 30 }, cameras: {} }, storage: { locations: [loc], lowFreePct: 15, floorFreePct: 5 } }
    const runs = []
    for (let run = 1; run <= 3; run++) {
      const calls = {}
      const counted = new Proxy(index, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => ((calls[k] = (calls[k] ?? 0) + 1), t[k](...a)) : t[k]) })
      const stop = beat()
      const r = await runHousekeeping({ index: counted, settings: rs, share: async () => { throw new Error('no file call expected') }, freeOf: () => ({ freeBytes: 90, totalBytes: 100 }), present: () => true, protectedRanges: () => [[b0, b0 + 2 * HOUR]], now: NOW + run * 300_000, log: () => {}, warn: () => {} })
      runs.push({ busy: stop(), deleted: r.deleted.length, skipped: r.skipped.length, reads: Object.entries(calls).filter(([k]) => !writes.has(k)).reduce((a, [, n]) => a + n, 0), calls })
    }
    index.close()
    check('a bookmark past the days kept, nothing else to delete: each run steps over it with a few looks (review: 261 index reads, 10,440 rows passed, every run)', runs.every((x) => x.deleted === 0 && x.reads <= 5), JSON.stringify(runs.map((x) => x.calls)))
    check('... and says so once per stretch, not once per row', runs.every((x) => x.skipped <= CAMS), runs.map((x) => x.skipped).join())
    check('... the main thread\'s longest busy stretch well under 50 ms, each run', runs.every((x) => x.busy < 50), runs.map((x) => x.busy.toFixed(1)).join(', '))
  }
  // the databases of this block are 50-100 MB a run: not left in the temp folder (they were, 1.8 GB of
  // them by 2026-09-29)
  try {
    rmSync(bigDir, { recursive: true, force: true, maxRetries: 5 })
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  } catch {}
}

// ---- server.mjs hands housekeeping the bookmarks and the marker check ------------------------------------
{
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const call = server.match(/runHousekeeping\(\{[^}]*\}\)/)?.[0] ?? ''
  check('server.mjs: runHousekeeping is asked with the bookmarks (protectedRanges) and the location markers (present: markerMatches)', /\bprotectedRanges\b/.test(call) && /\bpresent: markerMatches\b/.test(call) && /\bindex: recIndex\(\)/.test(call), call || 'no call found')
}

stopShareHelpers()
for (const ix of opened) {
  try {
    ix.close()
  } catch {} // (closed already by its case)
}
for (const d of [data, ...made]) {
  try {
    rmSync(d, { recursive: true, force: true, maxRetries: 5 })
  } catch {}
}
const leftBehind = made.filter((d) => existsSync(d))
check('the test\'s temp folders are removed at its end', leftBehind.length === 0, `${made.length} made, ${leftBehind.length} left: ${leftBehind.slice(0, 3).join(', ')}`)
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
