// Tests recording into memory while every drive is down, and moving it onto a drive after (ram-spool.mjs).
//   node cctv/test/ram-spool.test.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SPOOL_ID, drainSpool, spoolCapBytes, spoolLocation } from '../ram-spool.mjs'

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
check('full: no more memory handed out', spoolLocation({ index, platform: 'linux', cap: 1000, dir }) === null)

const r = await drainSpool({ index, target: drive, dir })
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

rmSync(base, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
