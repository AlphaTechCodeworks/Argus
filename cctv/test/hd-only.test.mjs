// The NVR's cameras recorded in HD only (hd-only.mjs): the 4 s wait for an SD frame that finds them,
// counted only while the NVR is really playing, and the list of them, which a slow NVR must not be
// able to fill for good. Temp folder only; pure (no SDK), so it runs anywhere.
//   node cctv/test/hd-only.test.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HD_ONLY_RETEST_MS, SD_FALLBACK_MS, SD_REFUSE_MS, SdWait, hdOnlyStore, noSdAction } from '../hd-only.mjs'

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
  // the server's clock stepped back: a mark dated after "now" would otherwise be trusted for longer than a week
  writeFileSync(file, JSON.stringify({ n1: { 6: t + 60_000 } }))
  check('a mark dated in the future (the clock was stepped back) is not trusted: tried in SD again', !hdOnlyStore({ file, nvrId: 'n1', now: () => t }).has(6))
  const step = hdOnlyStore({ file: join(dir, 'step.json'), nvrId: 'n1', now: () => t })
  step.mark(8)
  t -= 5000
  check('... nor one made just before the clock went back', !step.has(8))
  rmSync(dir, { recursive: true, force: true })
}

// ---- playback.mjs uses it (read as text: playback.mjs loads the SDK, which this PC cannot) ---------------
{
  const src = readFileSync(new URL('../playback.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  check('playback.mjs: the wait counts only while the NVR plays the started session', /const running = this\.openedAt > 0 && this\.nvrRunning && !this\.resuming && !this\.paused\n\s*if \(!this\.gotFrames && !this\.mainStream && this\.sdWait\.tick\(Date\.now\(\), running\)\)/.test(src))
  check('playback.mjs: ... from zero again when played again before any frame', /if \(!this\.gotFrames\) this\.sdWait\.restart\(\)/.test(src))
  check('playback.mjs: ... counted from when the NVR took the RESUME (it can wait its turn in the lane), not from when it was asked', /this\.resuming\+\+\n\s*try \{\n\s*await this\.#control\(PLAYCTRL\.RESUME\)\n(\s*\/\/.*\n)*\s*if \(this\.speed !== 1\) await this\.#control\(PLAYCTRL\.FF, SPEED_CODE\[this\.speed\] \?\? 0\)\n\s*\} finally \{\n\s*this\.resuming--\n\s*\}\n\s*this\.lastFrameAt = Date\.now\(\)\n(\s*\/\/.*\n)*\s*if \(!this\.gotFrames\) this\.sdWait\.restart\(\)/.test(src))
  // RESUME plays at normal speed: a session at 2x/4x/8x asks for its speed again after every resume, and
  // a speed command while the NVR is paused is left for that resume (it could set a paused NVR playing)
  check('playback.mjs: the speed is asked for again after a RESUME', /await this\.#control\(PLAYCTRL\.RESUME\)\n(\s*\/\/.*\n)*\s*if \(this\.speed !== 1\) await this\.#control\(PLAYCTRL\.FF, SPEED_CODE\[this\.speed\] \?\? 0\)/.test(src))
  check('playback.mjs: ... and a speed command is sent to the NVR only while it plays', /this\.speed = speed\n(\s*\/\/.*\n)*\s*if \(this\.nvrRunning\) await this\.#control\(speed === 1 \? PLAYCTRL\.NORMAL : PLAYCTRL\.FF, SPEED_CODE\[speed\] \?\? 0\)/.test(src))
  check('playback.mjs: "end" (no frame for 8 s) is judged only once the session has started and the NVR plays it', /if \(this\.openedAt > 0 && this\.nvrRunning && !this\.resuming && this\.queue\.length === 0 && Date\.now\(\) - this\.lastFrameAt > IDLE_END_MS\)/.test(src))
  check('playback.mjs: ... nor while the main stream opens after a switch', /this\.markOnFrames = true\n\s*this\.openedAt = 0\b/.test(src))
  check('playback.mjs: the first SD frame clears a mark, the first main frame after a switch sets it', /if \(!this\.mainStream\) hdOnly\.unmark\(this\.ch\)\n\s*else if \(this\.markOnFrames\) \{/.test(src))
  check('playback.mjs: a switch alone marks nothing', !/markHdOnly\(this\.ch\)/.test(src) && /this\.markOnFrames = true/.test(src))
}

// ---- no SD frame, for a viewer who may or may not see main (stream rights) --------------------------------
{
  check('SD_REFUSE_MS: longer than the switch, shorter than the "end of recording" notice (IDLE_END_MS, 8 s)', SD_REFUSE_MS === 6000 && SD_REFUSE_MS > SD_FALLBACK_MS && SD_REFUSE_MS < 8000)
  check('noSdAction: wait on under 4 s of playing, whoever it is, marked or not', [true, false].every((marked) => noSdAction({ waitedMs: 3999, mayMain: true, marked }) === null && noSdAction({ waitedMs: 3999, mayMain: false, marked }) === null))
  check('... then over to main for a viewer who may see main, marked or not', noSdAction({ waitedMs: 4000, mayMain: true, marked: false }) === 'switch' && noSdAction({ waitedMs: 4000, mayMain: true, marked: true }) === 'switch')
  check('... anyone else, on a camera marked HD only, waits longer (nothing to switch to), then is refused', noSdAction({ waitedMs: 5999, mayMain: false, marked: true }) === null && noSdAction({ waitedMs: 6000, mayMain: false, marked: true }) === 'refuse')
  // no frame on a camera nobody has seen to be HD only is no footage in that stretch (the camera off that
  // day, a motion-only schedule, before the NVR's retention): never a refusal, which the camera wall keeps
  // for the tile's life; the session tells the page the recording ended ("end", IDLE_END_MS), as before
  check('... anyone else, on a camera NOT marked HD only: never refused, however long (the session ends as a recording does)', [6000, 8000, 60_000, 3_600_000].every((waitedMs) => noSdAction({ waitedMs, mayMain: false, marked: false }) === null))
  check('... and a mark that is not the literal true (a caller that forgot to ask) refuses nobody', noSdAction({ waitedMs: 60_000, mayMain: false }) === null && noSdAction({ waitedMs: 60_000, mayMain: false, marked: 1 }) === null)
  const src = readFileSync(new URL('../playback.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const body = (head) => src.slice(src.indexOf(head), src.indexOf('\n    }\n', src.indexOf(head)))
  check('playback.mjs #watch: noSdAction decides, with the right and the camera\'s HD-only mark asked now', /this\.sdWait\.tick\(Date\.now\(\), running\)\) \{\n\s*const act = noSdAction\(\{ waitedMs: this\.sdWait\.ms, mayMain: askMain\(this\.allowMain\), marked: hdOnly\.has\(this\.ch\) \}\)\n\s*if \(act === 'switch'\) return this\.#switchToMain\(\)\n\s*if \(act === 'refuse'\) return this\.#refuseHd\(\)/.test(src))
  const sw = body('async #switchToMain() {')
  const asked = sw.indexOf('if (!askMain(this.allowMain)) {')
  check('playback.mjs #switchToMain: asked again once the SD playback has stopped, before main is said, watched or opened', asked > sw.indexOf('StopPlayBack') && asked < sw.indexOf('this.onMain()') && asked < sw.indexOf("type: 'stream'") && asked < sw.indexOf('this.#open()') && /if \(!askMain\(this\.allowMain\)\) \{\n\s*this\.#refuseHd\(HD_ASK_MESSAGE\)\n\s*return this\.#unregister\(\)/.test(sw))
  // that refusal is for the right taken away, on any camera: a camera not marked HD only is not said to
  // have "no SD recording" (on the camera wall the words stay on the tile)
  const refuse = body('\n    #refuseHd(') // (the method, not a call to it)
  check('playback.mjs #refuseHd: says the words it is given, "No SD recording ..." when none (noSdAction\'s refusal)', /#refuseHd\(message = HD_ONLY_MESSAGE\) \{/.test(refuse) && /this\.send\(\{ type: 'error', message \}\)/.test(refuse) && /import \{ HD_ASK_MESSAGE, HD_NOT_ALLOWED, HD_ONLY_MESSAGE \} from '\.\/stream-param\.mjs'/.test(src))
  check('playback.mjs connect: a camera marked HD only goes to main at once only for a viewer who may see main (anyone else is tried in SD)', /const asMain = main \|\| \(hdOnly\.has\(ch\) && askMain\(allowMain\)\)/.test(src))
  check('playback.mjs: the stream is never read from the URL (the caller decides)', !/searchParams\.get\('stream'\)/.test(src))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
