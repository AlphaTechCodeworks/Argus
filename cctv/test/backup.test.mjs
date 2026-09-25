// Tests for backup.mjs: what is copied, where, how many are kept, and what a failed target does.
// Run: node cctv/test/backup.test.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastBackup, runBackup } from '../backup.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 25, 2, 0, 0)
const DAY = 86_400_000

// A path that cannot be created on either platform: on Windows an unused drive letter fails,
// whereas a POSIX-looking absolute path would quietly be created on the current drive.
const BAD = process.platform === 'win32' ? 'Z:\\nowhere\\at\\all' : '/nowhere/at/all'

function dataDir() {
  const d = mkdtempSync(join(tmpdir(), 'cctv-bk-'))
  writeFileSync(join(d, 'settings.json'), '{"recording":{}}')
  writeFileSync(join(d, 'users.json'), '{"mike":{}}')
  writeFileSync(join(d, 'nvrs.json'), '[]')
  writeFileSync(join(d, 'session-secret'), 'shhh')
  writeFileSync(join(d, 'recordings.db'), 'binary')
  return d
}

{
  const d = dataDir(), t1 = mkdtempSync(join(tmpdir(), 'cctv-t1-'))
  const r = await runBackup({ dataDir: d, targets: [t1], now: () => T0, keep: 7 })
  const dir = readdirSync(t1)[0]
  check('one dated folder is written', readdirSync(t1).length === 1 && /^2026-09-25/.test(dir), readdirSync(t1).join())
  check('settings are copied', existsSync(join(t1, dir, 'settings.json')))
  check('users are copied', existsSync(join(t1, dir, 'users.json')))
  check('the NVR list is copied', existsSync(join(t1, dir, 'nvrs.json')))
  check('the recordings database is NOT copied (too big, rebuildable)', !existsSync(join(t1, dir, 'recordings.db')))
  check('the session secret is NOT copied', !existsSync(join(t1, dir, 'session-secret')))
  check('it reports what it wrote', r.written.length === 1 && r.errors.length === 0, JSON.stringify(r))
  check('lastBackup reads it back', lastBackup(d)?.at === T0, JSON.stringify(lastBackup(d)))
}
{
  const d = dataDir(), t1 = mkdtempSync(join(tmpdir(), 'cctv-t2-'))
  for (let i = 0; i < 9; i++) await runBackup({ dataDir: d, targets: [t1], now: () => T0 + i * DAY, keep: 7 })
  const kept = readdirSync(t1).sort()
  check('only `keep` folders are kept', kept.length === 7, String(kept.length))
  // Named in full, so this fails if the wrong end of the list is pruned rather than passing
  // merely because the folder names carry a time as well as a date.
  check('the oldest are the ones dropped', kept[0] === '2026-09-27T02-00-00' && kept[6] === '2026-10-03T02-00-00', kept.join())
}
{
  const d = dataDir(), good = mkdtempSync(join(tmpdir(), 'cctv-t3-'))
  const r = await runBackup({ dataDir: d, targets: [good, BAD], now: () => T0, keep: 7 })
  check('a good target still gets its copy', r.written.length === 1, JSON.stringify(r.written))
  check('the bad target is reported, not thrown', r.errors.length === 1 && r.errors[0].includes(BAD), JSON.stringify(r.errors))
}
{
  const d = dataDir()
  const r = await runBackup({ dataDir: d, targets: [], now: () => T0, keep: 7 })
  check('no targets is not an error', r.errors.length === 0 && r.written.length === 0)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
