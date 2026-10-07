// Tests recording into memory while every drive is down, and moving it onto a drive after (ram-spool.mjs).
//   node cctv/test/ram-spool.test.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIN_FREE_BYTES, SPOOL_ID, drainSpool, spoolCapBytes, spoolLocation, trimSpool, writableLocations } from '../ram-spool.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const base = mkdtempSync(join(tmpdir(), 'cctv-spool-'))
const shm = join(base, 'shm')
mkdirSync(shm)
const dir = join(shm, 'argus-spool')
const drive = { id: 'loc-nas', path: join(base, 'nas') }
mkdirSync(drive.path)

// a fake index: just the rows
const rows = new Map()
const index = {
  locationUse: (loc) => {
    const r = [...rows.values()].filter((x) => x.loc === loc)
    return { bytes: r.reduce((a, x) => a + x.bytes, 0), segments: r.length }
  },
  oldest: (limit, { loc }) => [...rows.values()].filter((x) => x.loc === loc).sort((a, b) => a.startMs - b.startMs).slice(0, limit),
  remove(p) { rows.delete(p) },
  has: (p) => rows.has(p),
  moveSegment(oldPath, newPath, loc) {
    const r = rows.get(oldPath)
    rows.delete(oldPath)
    rows.set(newPath, { ...r, path: newPath, loc })
  }
}

check('the cap is a quarter of the RAM by default', spoolCapBytes({}, 16 * 1024 ** 3) === 4 * 1024 ** 3)
check('CCTV_RAM_SPOOL_GB sets it, and 0 switches it off', spoolCapBytes({ CCTV_RAM_SPOOL_GB: '2' }) === 2 * 1024 ** 3 && spoolCapBytes({ CCTV_RAM_SPOOL_GB: '0' }) === 0)
check('not on Windows or a Mac', spoolLocation({ index, platform: 'win32', dir }) === null)
check('not when switched off', spoolLocation({ index, platform: 'linux', cap: 0, dir }) === null)
const loc = spoolLocation({ index, platform: 'linux', cap: 1000, dir })
check('with every drive down: a memory location for the workers', loc?.id === SPOOL_ID && loc.path === dir && existsSync(dir), JSON.stringify(loc))

// the workers record two segments into it
for (const [i, name] of [[0, 'a'], [1, 'b']]) {
  const p = join(dir, 'n1', '0', '2026-09-26', '13', `${name}.h265`)
  mkdirSync(join(dir, 'n1', '0', '2026-09-26', '13'), { recursive: true })
  writeFileSync(p, `video-${name}`)
  writeFileSync(`${p}.idx`, 'idx')
  rows.set(p, { path: p, loc: SPOOL_ID, startMs: i, bytes: 600 })
}
check('full is not a reason to stop: still handed out', spoolLocation({ index, platform: 'linux', cap: 1000, dir }) !== null)
{
  // it rotates: over 95 % of the cap, the oldest go until it is under 85 %
  const extra = join(dir, 'n1', '0', 'old.h265')
  writeFileSync(extra, 'oldest')
  rows.set(extra, { path: extra, loc: SPOOL_ID, startMs: -1, bytes: 300 })
  const r = await trimSpool({ index, cap: 1500, dir }) // 1500 held: full; one dropped leaves 1200, under 85 %
  check('full: the oldest is dropped to make room', r.removed === 1 && !existsSync(extra) && !rows.has(extra), JSON.stringify(r))
  check('and the newer footage is kept', index.locationUse(SPOOL_ID).segments === 2)
  check('under the cap nothing is dropped', (await trimSpool({ index, cap: 1e6, dir, freeOf: () => null })).removed === 0)
  // on disk: under the cap, but the disk itself is running low -> room is made anyway, oldest first
  const early = join(dir, 'n1', '0', 'early.h265')
  writeFileSync(early, 'early')
  rows.set(early, { path: early, loc: SPOOL_ID, startMs: -3, bytes: 400 })
  const low = await trimSpool({ index, cap: 1e6, dir, freeOf: () => MIN_FREE_BYTES - 300 })
  check('disk low (under the cap): the oldest go until the disk has its margin back', low.removed === 1 && !existsSync(early) && !rows.has(early) && index.locationUse(SPOOL_ID).segments === 2, JSON.stringify(low))
  check('disk with room and under the cap: nothing is dropped', (await trimSpool({ index, cap: 1e6, dir, freeOf: () => MIN_FREE_BYTES * 4 })).removed === 0)
}

// a row whose file a restart cleared out of memory
const ghost = join(dir, 'n1', '0', 'ghost.h265')
rows.set(ghost, { path: ghost, loc: SPOOL_ID, startMs: -5, bytes: 1 })
const r = await drainSpool({ index, target: drive, dir })
check('a file gone from memory is dropped from the index, not copied', !rows.has(ghost))
const moved = join(drive.path, 'n1', '0', '2026-09-26', '13', 'a.h265')
check('a drive back: both segments copied onto it', r.moved === 2 && readFileSync(moved, 'utf8') === 'video-a' && existsSync(`${moved}.idx`), JSON.stringify(r))
check('their rows now point at the drive', rows.has(moved) && rows.get(moved).loc === 'loc-nas')
check('and memory is freed', !existsSync(join(dir, 'n1', '0', '2026-09-26', '13', 'a.h265')) && index.locationUse(SPOOL_ID).segments === 0)

// a drive that fails mid-copy: nothing is lost, the rest stays in memory
{
  const p = join(dir, 'n1', '0', 'c.h265')
  writeFileSync(p, 'video-c')
  rows.set(p, { path: p, loc: SPOOL_ID, startMs: 5, bytes: 7 })
  const bad = { id: 'loc-bad', path: join(base, 'nas', 'a.h265', 'cannot-be-a-folder') } // a file where a folder must go
  writeFileSync(join(base, 'nas', 'a.h265'), 'x')
  const r2 = await drainSpool({ index, target: bad, dir })
  check('a copy that fails stops, and says so', r2.error && r2.left === 1, JSON.stringify(r2))
  check('the footage is still in memory and still indexed there', existsSync(p) && rows.get(p).loc === SPOOL_ID)
}

{
  // the minute memory handed back to the drive: a file of that name is on the drive already
  const same = join(dir, 'n1', '0', 'clash.h265')
  writeFileSync(same, 'from-memory')
  rows.set(same, { path: same, loc: SPOOL_ID, startMs: 9, bytes: 11 })
  const onDrive = join(drive.path, 'n1', '0', 'clash.h265')
  mkdirSync(join(drive.path, 'n1', '0'), { recursive: true })
  writeFileSync(onDrive, 'from-drive')
  rows.set(onDrive, { path: onDrive, loc: 'loc-nas', startMs: 9, bytes: 10 })
  const r3 = await drainSpool({ index, target: drive, dir })
  const kept = join(drive.path, 'n1', '0', 'clash.spool.h265')
  check('a name already on the drive: the copy is kept beside it, both indexed', !r3.error && readFileSync(kept, 'utf8') === 'from-memory' && readFileSync(onDrive, 'utf8') === 'from-drive' && rows.has(kept) && rows.has(onDrive), JSON.stringify(r3))
}

// ---- edge branches and the "never touch a file outside the spool folder" guards
{
  // a fresh fake index for these, isolated from the rows above
  const mkIndex = () => {
    const r = new Map()
    return {
      rows: r,
      locationUse: (loc) => { const xs = [...r.values()].filter((x) => x.loc === loc); return { bytes: xs.reduce((a, x) => a + x.bytes, 0), segments: xs.length } },
      oldest: (limit, { loc }) => [...r.values()].filter((x) => x.loc === loc).sort((a, b) => a.startMs - b.startMs).slice(0, limit),
      remove(p) { r.delete(p) },
      has: (p) => r.has(p),
      moveSegment(o, n, loc) { const row = r.get(o); r.delete(o); r.set(n, { ...row, path: n, loc }) }
    }
  }

  // an archive location is not one the recorder writes to (recorder.mjs #pickLocation): healthy, it neither
  // keeps the outage buffer off nor takes what is copied out of memory (audit of 2026-10-07)
  {
    const main = { id: 'M', path: '/srv/m', role: 'main' }
    const over = { id: 'O', path: '/srv/o', role: 'overflow' }
    const arch = { id: 'A', path: '/srv/a', role: 'archive' }
    check('writableLocations: main and overflow locations, never an archive one', JSON.stringify(writableLocations([arch, over, main]).map((l) => l.id)) === '["O","M"]' && writableLocations([arch]).length === 0 && writableLocations([]).length === 0 && writableLocations(null).length === 0)
    const nvrs = readFileSync(new URL('../nvrs.mjs', import.meta.url), 'utf8')
    check('nvrs.mjs: the workers get the memory location when no writable location is healthy (a healthy archive does not count)', /if \(!writableLocations\(locations\)\.length\) \{\s+const spool = spoolLocation\(/.test(nvrs))
    check('nvrs.mjs: the spool watch (on or off, making room, copying out) asks the writable locations only', /const real = writableLocations\(healthyLocations\(\)\)/.test(nvrs) && !/const real = healthyLocations\(\)/.test(nvrs))
  }

  check('a negative CCTV_RAM_SPOOL_GB falls back to the default quarter of RAM', spoolCapBytes({ CCTV_RAM_SPOOL_GB: '-5' }, 16 * 1024 ** 3) === 4 * 1024 ** 3)
  check('no /dev/shm (its parent is missing): no memory location', spoolLocation({ index, platform: 'linux', cap: 1000, dir: join(base, 'no-such', 'spool') }) === null)

  // trimSpool must drop in-dir footage to make room but never unlink a row whose path escapes the spool
  {
    const ix = mkIndex()
    const outside = join(base, 'outside-trim.h265')
    writeFileSync(outside, 'keep me')
    ix.rows.set(outside, { path: outside, loc: SPOOL_ID, startMs: -100, bytes: 100 }) // oldest, but not under dir
    const inside = join(dir, 'n1', '0', 'trimmable.h265')
    mkdirSync(join(dir, 'n1', '0'), { recursive: true })
    writeFileSync(inside, 'drop me')
    ix.rows.set(inside, { path: inside, loc: SPOOL_ID, startMs: 0, bytes: 900 })
    const r = await trimSpool({ index: ix, cap: 1000, dir, freeOf: () => MIN_FREE_BYTES * 4 }) // 1000 held = full
    check('trimSpool drops the in-dir file but never the one outside the spool', r.removed === 1 && !existsSync(inside) && existsSync(outside) && ix.has(outside) && readFileSync(outside, 'utf8') === 'keep me', JSON.stringify(r))
  }

  // drainSpool must never copy or unlink a row whose path escapes the spool
  {
    const ix = mkIndex()
    const outside = join(base, 'outside-drain.h265')
    writeFileSync(outside, 'stay')
    ix.rows.set(outside, { path: outside, loc: SPOOL_ID, startMs: 1, bytes: 5 })
    const r = await drainSpool({ index: ix, target: drive, dir })
    const wouldBe = join(drive.path, 'outside-drain.h265') // if the guard let it through, roughly where it would land
    check('drainSpool leaves a file outside the spool untouched (not copied, not removed, row kept)', r.moved === 0 && existsSync(outside) && ix.has(outside) && !existsSync(wouldBe), JSON.stringify(r))
  }
}

rmSync(base, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
