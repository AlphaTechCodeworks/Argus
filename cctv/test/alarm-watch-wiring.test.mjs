// nvrs.mjs's wiring for line crossings (alarm-watch.mjs, line-actions.mjs, event-snapshot.mjs):
// source shape only. nvrs.mjs loads koffi/the native SDK, so it cannot be imported on a PC without it
// (see Task 8 Step 1 for the running check on the server); this reads it as text instead, the same way
// live-mux-server.test.mjs checks server.mjs's wiring without importing it.
// Pure: no import of nvrs.mjs, no SDK, no network.
//   node cctv/test/alarm-watch-wiring.test.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const src = readFileSync(join(import.meta.dirname, '..', 'nvrs.mjs'), 'utf8')
const watchAt = src.indexOf('async function startLineWatch')
const startNvrsAt = src.indexOf('export const startNvrs')
const watchBody = watchAt >= 0 && startNvrsAt >= 0 ? src.slice(watchAt, startNvrsAt) : ''

check('nvr-xml.mjs XML_HEADER and transparent are imported (line 23)',
  /import \{ XML_HEADER, transparent, xmlSettled \} from '\.\/nvr-xml\.mjs'/.test(src))

check('startLineWatch is started beside the recorded-file intake, non-fatally',
  /startLineWatch\(notifier\)\.catch\(\(e\) => console\.warn\(`\[alarm-watch\] not started: \$\{e\.message\}`\)\)/.test(src))

check('startLineWatch is defined before startNvrs', watchAt >= 0 && startNvrsAt >= 0 && watchAt < startNvrsAt)

check('startLineWatch loads alarm-watch.mjs, tripwire.mjs, line-actions.mjs, event-snapshot.mjs and events-db.mjs',
  /import\('\.\/alarm-watch\.mjs'\), import\('\.\/tripwire\.mjs'\), import\('\.\/line-actions\.mjs'\), import\('\.\/event-snapshot\.mjs'\), import\('\.\/events-db\.mjs'\)/.test(watchBody))

check('... never bookmarks.mjs or rec-reader.mjs (Task 5\'s bookmark stays its default autoBookmark, Task 6\'s readerFor stays its default openReader)',
  !/bookmarks\.mjs/.test(src) && !/rec-reader\.mjs/.test(src) && !/new SegmentReader/.test(src) && !/\{ SegmentReader \}/.test(src))

check('the snapshot helper passes only { index }: readerFor is left to event-snapshot.mjs\'s default, which opens the reader',
  /const snapshot = \(event\) => \{[\s\S]*?takeSnapshot\(event, \{ index \}\)[\s\S]*?\}/.test(watchBody))

// The event's times are the NVR's; the snapshot and the bookmark are on this server's clock (F1 of the
// final review: nvr1 runs about 220 s fast). Each of the three calls hands onLineCrossing the event
// moved by that NVR's skew, from its last clock read; the stored row itself stays on the NVR's time.
check('onLineCrossing is called with the event on this server\'s clock and { snapshot, nameOf } (bookmark left to its default autoBookmark), from both the watch and the intake',
  (src.match(/onLineCrossing\((?:lineCrossing\.)?onServerClock\(event, skewOf\(event\.nvr\)\), \{ snapshot, nameOf \}\)/g) ?? []).length === 3 &&
  !/onLineCrossing\(event,/.test(src))

check('skewOf is the NVR\'s last clock read (playback.mjs lastClock: its clock - this server\'s), 0 before the first',
  /const skewOf = \(nvrId\) => nvrs\.get\(nvrId\)\?\.playback\?\.lastClock\?\.\(\)\?\.skewMs \?\? 0/.test(src))

check('startLineWatch takes onServerClock from line-actions.mjs',
  /const \[\{ crossingHandler, startAlarmWatch \}, \{ linesOn \}, \{ onLineCrossing, onServerClock \}, \{ takeSnapshot \}, \{ addEvent \}\] = await Promise\.all/.test(watchBody))

check('crossingHandler is given a grew callback so a long alarm\'s bookmark can follow its end',
  /crossingHandler\(\{\s*addEvent,\s*handle: \(event\) => \{[\s\S]*?\},\s*grew: \(event\) => void onLineCrossing\(onServerClock\(event, skewOf\(event\.nvr\)\), \{ snapshot, nameOf \}\)/.test(watchBody))

check('the recorded-file intake\'s onEvent also calls onLineCrossing for line-crossing events, loaded non-fatally',
  /const lineCrossing = await Promise\.all\(\[import\('\.\/line-actions\.mjs'\), import\('\.\/event-snapshot\.mjs'\)\]\)\.then\(\s*\(\[\{ onLineCrossing, onServerClock \}, \{ takeSnapshot \}\]\) => \(\{ onLineCrossing, onServerClock, takeSnapshot \}\),/.test(src) &&
  /if \(lineCrossing\) void lineCrossing\.onLineCrossing\(lineCrossing\.onServerClock\(event, skewOf\(event\.nvr\)\), \{ snapshot, nameOf \}\)\.catch/.test(src))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
