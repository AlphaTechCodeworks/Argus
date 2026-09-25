// Tests for housekeeping.mjs: retention and low-space deletion of server recordings.
// Temp dirs, synthetic segment files, a fake free-space function. Run: node cctv/test/housekeeping.test.mjs
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const data = mkdtempSync(join(tmpdir(), 'cctv-hk-'))
process.env.DATA_DIR = data
const { runHousekeeping } = await import('../housekeeping.mjs')
const { openRecIndex } = await import('../rec-index.mjs')
const { segmentPath } = await import('../segment-writer.mjs')

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0)
const DEFAULTS = { mode: 'continuous', fullDays: 30, after: 'timelapse', timelapseS: 10, retentionDays: 183, preS: 10, postS: 20 }
const settingsWith = (locs, cameras = {}, storage = {}) => ({ recording: { defaults: DEFAULTS, cameras }, storage: { locations: locs, lowFreePct: 15, floorFreePct: 5, ...storage } })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hk-loc-'))
  writeFileSync(join(root, '.cctv-recordings'), '{"id":"L1"}')
  const loc = { id: 'L1', path: root, type: 'usb', role: 'main', limitGB: null }
  const index = openRecIndex(join(mkdtempSync(join(tmpdir(), 'hk-db-')), 'r.db'))
  const add = (nvr, ch, ageDays, bytes = 1000) => {
    const startMs = NOW - ageDays * DAY
    const path = segmentPath(root, nvr, ch, startMs, 'h264')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, Buffer.alloc(10))
    writeFileSync(`${path}.idx`, Buffer.alloc(16))
    index.addSegment({ nvr, ch, path, startMs, endMs: startMs + 59_000, bytes, keyframes: 1, loc: 'L1' })
    return path
  }
  return { root, loc, index, add }
}
// free space: totalBytes 100_000; free = base + bytes of deleted segments
const fakeFree = (base) => {
  const f = { freed: 0, calls: 0, fn: () => ({ freeBytes: base + f.freed, totalBytes: 100_000 }) }
  return f
}

// ---- retention
{
  const { loc, index, add } = setup()
  const old = add('n1', 0, 200)
  const keep = add('n1', 0, 100)
  const shortOld = add('n1', 1, 40) // this camera keeps 30 days only
  const shortKeep = add('n1', 1, 20)
  const r = await runHousekeeping({ index, settings: settingsWith([loc], { 'n1/1': { retentionDays: 30, fullDays: 10 } }), freeOf: fakeFree(90_000).fn, now: NOW })
  check('retention: older than the camera retention is deleted', !existsSync(old) && !existsSync(`${old}.idx`) && !existsSync(shortOld))
  check('retention: newer kept', existsSync(keep) && existsSync(shortKeep))
  check('retention: removed from the index', index.segments('n1', 0, 0, NOW).length === 1 && index.segments('n1', 1, 0, NOW).length === 1)
  check('retention: empty folders removed', !existsSync(dirname(old)) && !existsSync(dirname(dirname(old))))
  check('retention: result lists the deletions', r.deleted.length === 2 && r.deleted.every((d) => d.why === 'retention'), JSON.stringify(r.deleted))
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
  const r = await runHousekeeping({
    index,
    settings: settingsWith([loc], { 'n1/1': { fullDays: 5 } }),
    freeOf: free.fn,
    now: NOW,
    onDelete: (seg) => { deletedOrder.push(seg.path); free.freed += seg.bytes }
  })
  check('low space: deletes furthest past full-days target first', deletedOrder.join() === [a, c, b].join(), deletedOrder.map((p) => p.split(/[\\/]/).slice(-5).join('/')).join(' '))
  check('low space: stops once above the low mark', existsSync(d) && existsSync(e))
  check('low space: result', r.deleted.filter((x) => x.why === 'low space').length === 3 && r.warnings.length === 0, JSON.stringify(r))
}

// ---- low space but only full-days footage left: kept, with a warning
{
  const { loc, index, add } = setup()
  const d = add('n1', 0, 10)
  const free = fakeFree(10_000) // 10%: low but above the 5% floor
  const r = await runHousekeeping({ index, settings: settingsWith([loc]), freeOf: free.fn, now: NOW, onDelete: (s) => (free.freed += s.bytes) })
  check('floor: footage inside full days is kept above the floor', existsSync(d))
  check('floor: a warning says so', r.warnings.length === 1 && /full-video days/.test(r.warnings[0]), JSON.stringify(r.warnings))
}

// ---- below the floor: full-days footage goes too (oldest first), with a warning
{
  const { loc, index, add } = setup()
  const d1 = add('n1', 0, 10)
  const d2 = add('n1', 0, 3)
  const free = fakeFree(4000) // 4% < 5% floor: 1000 bytes to reach the floor; the low mark would need 11000
  const r = await runHousekeeping({ index, settings: settingsWith([loc]), freeOf: free.fn, now: NOW, onDelete: (s) => (free.freed += s.bytes) })
  check('floor: below the floor, the oldest full-days footage is deleted', !existsSync(d1) && existsSync(d2))
  check('floor: warning logged', r.warnings.some((w) => /below the hard floor/.test(w)), JSON.stringify(r.warnings))
}

// ---- safety: a path outside the location root is never deleted
{
  const { loc, index } = setup()
  const outside = join(mkdtempSync(join(tmpdir(), 'hk-out-')), 'x.h264')
  writeFileSync(outside, 'keep me')
  index.addSegment({ nvr: 'n1', ch: 0, path: outside, startMs: NOW - 300 * DAY, endMs: NOW - 300 * DAY + 1000, bytes: 7, keyframes: 1, loc: 'L1' })
  const r = await runHousekeeping({ index, settings: settingsWith([loc]), freeOf: fakeFree(90_000).fn, now: NOW })
  check('safety: file outside its location is not deleted', existsSync(outside) && r.warnings.some((w) => /outside/.test(w)), JSON.stringify(r.warnings))
}

// ---- no index (recording never started): nothing happens
{
  const r = await runHousekeeping({ index: null, settings: settingsWith([]), now: NOW })
  check('no index: no-op', r.deleted.length === 0)
}

// ---- a drive that is not mounted: its mount point is an empty folder (no marker) on the system disk
for (const [name, marker] of [['marker missing (drive unplugged)', null], ['marker of another drive', '{"id":"OTHER"}']]) {
  const { root, loc, index, add } = setup()
  const old = add('n1', 0, 200)
  const p2 = add('n1', 0, 100)
  const { rmSync, unlinkSync } = await import('node:fs')
  // unplugged: the files are on the drive, not here; only the empty mount point is left
  rmSync(join(root, 'n1'), { recursive: true, force: true })
  unlinkSync(join(root, '.cctv-recordings'))
  if (marker) writeFileSync(join(root, '.cctv-recordings'), marker)
  let statfsCalls = 0
  const r = await runHousekeeping({ index, settings: settingsWith([loc]), freeOf: () => (statfsCalls++, { freeBytes: 1, totalBytes: 100_000 }), now: NOW })
  check(`not mounted (${name}): index rows kept (no ENOENT clean-up)`, index.segments('n1', 0, 0, NOW).length === 2 && r.deleted.length === 0, JSON.stringify(r.deleted))
  check(`not mounted (${name}): free space never read (it would be the system disk's)`, statfsCalls === 0)
  check(`not mounted (${name}): a warning says it was skipped`, r.warnings.some((w) => /skipped/.test(w) && w.includes(root)), JSON.stringify(r.warnings))
  void old, p2
}
// the default check really reads the marker (storage.mjs markerMatches)
{
  const { root, loc, index, add } = setup()
  const old = add('n1', 0, 200)
  const { unlinkSync } = await import('node:fs')
  unlinkSync(join(root, '.cctv-recordings'))
  await runHousekeeping({ index, settings: settingsWith([loc]), freeOf: fakeFree(90_000).fn, now: NOW })
  check('default marker check: no marker -> nothing deleted', existsSync(old) && index.segments('n1', 0, 0, NOW).length === 1)
  writeFileSync(join(root, '.cctv-recordings'), '{"id":"L1"}')
  await runHousekeeping({ index, settings: settingsWith([loc]), freeOf: fakeFree(90_000).fn, now: NOW })
  check('default marker check: marker back -> retention runs again', !existsSync(old) && index.segments('n1', 0, 0, NOW).length === 0)
}
// mounted and healthy, a file already gone (ENOENT): its row is removed
{
  const { loc, index, add } = setup()
  const gone = add('n1', 0, 200)
  const { unlinkSync } = await import('node:fs')
  unlinkSync(gone)
  unlinkSync(`${gone}.idx`)
  const r = await runHousekeeping({ index, settings: settingsWith([loc]), freeOf: fakeFree(90_000).fn, now: NOW })
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
  await runHousekeeping({ index, settings: settingsWith([loc]), freeOf: fakeFree(90_000).fn, now: NOW })
  const left = [...index.gaps('n1', 0, 0, NOW), ...index.gaps('n1', 1, 0, NOW)]
  check('gaps older than the retention (183 days) are pruned, newer ones kept', left.length === 2 && left.every((g) => g.toMs >= NOW - 183 * DAY), JSON.stringify(left.map((g) => (NOW - g.toMs) / DAY)))
  const { loc: loc2, index: idx2 } = setup()
  idx2.addGap({ nvr: 'n1', ch: 0, fromMs: NOW - 300 * DAY - 1, toMs: NOW - 300 * DAY, reason: 'x' })
  idx2.addGap({ nvr: 'n1', ch: 0, fromMs: NOW - 500 * DAY - 1, toMs: NOW - 500 * DAY, reason: 'x' })
  await runHousekeeping({ index: idx2, settings: settingsWith([loc2], { 'n2/4': { retentionDays: 400 } }), freeOf: fakeFree(90_000).fn, now: NOW })
  check('a camera keeping 400 days: gaps kept up to 400 days', idx2.gaps('n1', 0, 0, NOW).length === 1)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
