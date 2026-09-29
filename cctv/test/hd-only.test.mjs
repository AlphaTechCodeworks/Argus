// The NVR's cameras recorded in HD only (hd-only.mjs): the 4 s wait for an SD frame that finds them,
// counted only while the NVR is really playing, and the list of them, which a slow NVR must not be
// able to fill for good. Temp folder only; pure (no SDK), so it runs anywhere.
//   node cctv/test/hd-only.test.mjs
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HD_ONLY_RETEST_MS, SD_FALLBACK_MS, SdWait, hdOnlyStore } from '../hd-only.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

check('4 s for an SD picture, a week before a mark is tried again', SD_FALLBACK_MS === 4000 && HD_ONLY_RETEST_MS === 7 * 24 * 3_600_000)
{
  const w = new SdWait()
  check('not started (the open waits in the NVR lane): never over, however long', [0, 500, 5000, 60_000].every((t) => w.tick(t, false) === false))
  check('started: the first tick only starts the count', w.tick(100_000, true) === false)
  check('... 3.5 s of playing is not enough', w.tick(103_500, true) === false)
  check('... 4 s is', w.tick(104_000, true) === true)
  const p = new SdWait()
  p.tick(0, true)
  p.tick(2000, true)
  p.tick(2500, false)
  p.tick(60_000, false) // paused by the viewer for a minute
  check('paused: the count stands still', p.tick(60_500, true) === false && p.ms === 2000, String(p.ms))
  p.restart()
  check('restart (played again with no frame yet): from zero', p.ms === 0 && p.tick(61_000, true) === false && p.tick(64_500, true) === false && p.tick(65_000, true) === true)
}
{
  const dir = mkdtempSync(join(tmpdir(), 'hd-only-'))
  const file = join(dir, 'hd-only.json')
  let t = 1_000_000
  writeFileSync(file, JSON.stringify({ n1: [2, 5], other: { 7: 123 } }))
  const s = hdOnlyStore({ file, nvrId: 'n1', now: () => t })
  check('an older release\'s list ([ch, …], written by the faulty rule) is not trusted: each camera is tried in SD again', !s.has(2) && !s.has(5) && !s.has(3))
  s.mark(3)
  s.mark(5)
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  check('marks are saved with their time; other NVRs are kept as they were', disk.n1['3'] === t && disk.n1['5'] === t && !('2' in disk.n1) && disk.other['7'] === 123, JSON.stringify(disk))
  s.unmark(5)
  check('unmark (an SD frame came): gone, and saved', !s.has(5) && !('5' in JSON.parse(readFileSync(file, 'utf8')).n1))
  t += HD_ONLY_RETEST_MS
  check('a week on: not trusted any more (the camera is tried in SD again)', !s.has(3))
  s.mark(2)
  check('... marked again when main frames come again', s.has(2))
  const again = hdOnlyStore({ file, nvrId: 'n1', now: () => t })
  check('read back by a new process: the same marks, with their times', again.has(2) && !again.has(3) && !again.has(5))
  const junk = join(dir, 'junk.json')
  writeFileSync(junk, 'not json')
  const j = hdOnlyStore({ file: junk, nvrId: 'n1', now: () => t })
  j.mark(1)
  check('an unreadable file: no marks, and marking still works', j.has(1) && !j.has(0))
  const logs = []
  const bad = hdOnlyStore({ file: join(dir, 'no-such-dir', 'x.json'), nvrId: 'n1', now: () => t, log: (l) => logs.push(l) })
  bad.mark(4)
  check('a file that cannot be written: kept in memory, said once, no throw', bad.has(4) && logs.length === 1)
}

// ---- playback.mjs uses it (read as text: playback.mjs loads the SDK, which this PC cannot) ---------------
{
  const src = readFileSync(new URL('../playback.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  check('playback.mjs: the wait counts only while the NVR plays the started session', /const running = this\.openedAt > 0 && this\.nvrRunning && !this\.paused\n\s*if \(!this\.gotFrames && !this\.mainStream && this\.sdWait\.tick\(Date\.now\(\), running\)\)/.test(src))
  check('playback.mjs: ... from zero again when played again before any frame', /if \(!this\.gotFrames\) this\.sdWait\.restart\(\)/.test(src))
  check('playback.mjs: the first SD frame clears a mark, the first main frame after a switch sets it', /if \(!this\.mainStream\) hdOnly\.unmark\(this\.ch\)\n\s*else if \(this\.markOnFrames\) \{/.test(src))
  check('playback.mjs: a switch alone marks nothing', !/markHdOnly\(this\.ch\)/.test(src) && /this\.markOnFrames = true/.test(src))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
