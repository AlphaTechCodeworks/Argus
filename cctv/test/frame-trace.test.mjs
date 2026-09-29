// The debug frame trace (public/frame-trace.js): off unless started; while on, every frame of every
// tile with its arrival time, capture time, size and keyframe flag, the tiles' connection events and
// the D overlay's counters, for 2 minutes, then one JSON object. test/live-replay.mjs reads what it
// writes. Fake clocks; no browser.
//   node cctv/test/frame-trace.test.mjs
import { FrameTrace, TRACE_FORMAT, TRACE_MAX_FRAMES, TRACE_MS, TRACE_VERSION, activeTrace, startTrace, stopTrace, traceFileName } from '../public/frame-trace.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

/** A frame as /live sends it: key flag, codec, width, height, 0, capture time (µs), then the payload. */
const frame = ({ key = false, codec = 0, us, size = 40, w = 0, h = 0 }) => {
  const b = new Uint8Array(size)
  const v = new DataView(b.buffer)
  b[0] = key ? 1 : 0
  b[1] = codec
  v.setUint16(2, w, true)
  v.setUint16(4, h, true)
  v.setBigInt64(8, BigInt(us), true)
  return b
}
const US0 = 1_759_118_880_123_456 // a capture time on the camera's clock, in µs

check('two minutes, as the plan asks', TRACE_MS === 120_000)
check('off unless started: no trace', activeTrace() === null)

{
  let now = 5000.04
  const timers = []
  let done = null
  let doneCalls = 0
  const t = startTrace({ page: { host: 'cctv.example', layout: 'g4' }, now: () => now, wallNow: () => Date.UTC(2026, 8, 29, 4, 8, 0, 250), later: (fn, ms) => (timers.push({ fn, ms }), timers.length), cancel: () => {}, onDone: (x) => { done = x; doneCalls++ } })
  check('started: it is the active trace, with a timer for its two minutes', activeTrace() === t && timers.length === 1 && timers[0].ms === TRACE_MS)
  check('... and only one at a time', startTrace({ now: () => now }) === t)
  const grid = { nvr: 'nvr-2', ch: 5, streamType: 1 }
  const full = { nvr: 'nvr-2', ch: 22, streamType: 0 }
  t.event(grid, 'connect', 'sub')
  now += 12.34
  t.event(grid, 'open')
  now += 100
  t.frame(grid, frame({ key: true, us: US0, size: 60_000, w: 704, h: 480 }))
  now += 50.06
  t.frame(grid, frame({ us: US0 + 50_000, size: 3000 }))
  now += 49.99
  t.frame(grid, frame({ us: US0 + 99_999, size: 2800 }))
  t.stats(grid, { fps: 20, dropped: 0, late: 1, resyncs: 0, delayMs: 350, kbps: 900 })
  t.frame(full, frame({ key: true, codec: 1, us: US0 + 2_000_000, size: 200_000 }))
  t.event(full, 'borrow', grid)
  t.event(grid, 'suspend')
  t.frame(grid, frame({ key: true, us: US0 + 2_050_000, size: 60_000, w: 1280, h: 720 }))
  t.frame(grid, frame({ key: true, codec: 1, us: US0 + 2_100_000, size: 60_000, w: 1280, h: 720 }))
  t.frame(grid, new Uint8Array(10)) // no header: not a frame
  t.event(grid, 'close')
  now += 1000
  const x = t.stop()
  const [a, b] = x.tiles
  check('the file says what it is: format, version, when (ISO), how long', x.format === TRACE_FORMAT && x.version === TRACE_VERSION && x.startedAt === '2026-09-29T04:08:00.250Z' && x.durationMs === 1212 && x.truncated === false, JSON.stringify({ ...x, tiles: undefined }))
  check('... and the page it was recorded on', x.page.host === 'cctv.example' && x.page.layout === 'g4')
  check('tiles in the order first seen, named as the logs name cameras (channel from 1)', x.tiles.length === 2 && a.id === 1 && a.camera === 'nvr-2/6' && a.nvr === 'nvr-2' && a.ch === 5 && a.stream === 'sub' && b.id === 2 && b.camera === 'nvr-2/23' && b.stream === 'main', JSON.stringify(x.tiles.map(({ frames, events, stats, ...r }) => r)))
  check('frames: [arrival ms since the start (0.1 ms), capture ms since the tile\'s first, bytes, key]', JSON.stringify(a.frames.slice(0, 3)) === '[[112.3,0,60000,1],[162.4,50,3000,0],[212.4,99.999,2800,0]]', JSON.stringify(a.frames.slice(0, 3)))
  check('... the tile\'s first capture time kept once, in epoch ms', a.capture0 === US0 / 1000 && b.capture0 === (US0 + 2_000_000) / 1000, String(a.capture0))
  check('... a frame without a header is not one', a.frames.length === 5)
  check('... the codec from the first frame\'s header, a change as an event', a.codec === 'h265' && b.codec === 'h265' && a.events.some((e) => e[1] === 'codec' && e[2] === 'h265'), JSON.stringify(a.events))
  check('events in order, with their times: connect (the stream asked for), open, suspend, close', JSON.stringify(a.events.filter((e) => ['connect', 'open', 'suspend', 'close'].includes(e[1]))) === '[[0,"connect","sub"],[12.3,"open"],[212.4,"suspend"],[212.4,"close"]]', JSON.stringify(a.events))
  check('... the picture size from a keyframe\'s header, when it changes', JSON.stringify(a.events.filter((e) => e[1] === 'size')) === '[[112.3,"size",704,480],[212.4,"size",1280,720]]', JSON.stringify(a.events))
  check('... a borrow names the tile lent from by its id', JSON.stringify(b.events) === '[[212.4,"borrow",1]]', JSON.stringify(b.events))
  check('stats: [at, fps, dropped, late, resyncs, delay ms], the D overlay\'s counters', JSON.stringify(a.stats) === '[[212.4,20,0,1,0,350]]', JSON.stringify(a.stats))
  check('stopped: onDone once with the trace, and no trace is active', doneCalls === 1 && done === x && activeTrace() === null)
  check('... stopping again changes nothing', t.stop() === x && doneCalls === 1 && stopTrace() === null)
  check('... frames after the stop are not taken', (t.frame(grid, frame({ us: US0 + 3_000_000 })), a.frames.length === 5))
  check('the trace survives JSON as it is', JSON.stringify(JSON.parse(JSON.stringify(x))) === JSON.stringify(x))
  check('the file\'s name says where and when', traceFileName(x, 'cctv.jfl.gripe') === 'argus-trace-cctv.jfl.gripe-20260929-040800.json', traceFileName(x, 'cctv.jfl.gripe'))
  check('... an address with a port is safe as a file name', traceFileName(x, '192.168.1.232:8443') === 'argus-trace-192.168.1.232_8443-20260929-040800.json', traceFileName(x, '192.168.1.232:8443'))
}

{
  // two minutes on: it stops by itself, at the first thing after its time (or its timer)
  let now = 0
  let done = null
  const t = new FrameTrace({ now: () => now, later: () => 1, cancel: () => {}, onDone: (x) => (done = x) })
  const tile = { nvr: 'n1', ch: 0, streamType: 1 }
  for (let i = 0; i <= 2400; i++) {
    now = i * 50
    t.frame(tile, frame({ key: i % 40 === 0, us: US0 + i * 50_000 }))
  }
  now = TRACE_MS + 10
  t.frame(tile, frame({ us: US0 + 999_000_000 }))
  check('past its two minutes: done, with every frame up to then and none after', done !== null && done.tiles[0].frames.length === 2400 && done.durationMs === TRACE_MS, `${done?.tiles[0].frames.length} ${done?.durationMs}`)
}

{
  // the timer ends it when no frame comes (a page gone quiet)
  let fire = null
  let done = null
  startTrace({ now: () => 0, later: (fn) => (fire = fn), cancel: () => {}, onDone: (x) => (done = x) })
  fire()
  check('its timer ends it with nothing recorded: an empty trace, and it is no longer active', done?.tiles.length === 0 && activeTrace() === null)
}

{
  // memory: past TRACE_MAX_FRAMES the frames stop and the file says so
  const t = new FrameTrace({ now: () => 1, later: () => 1, cancel: () => {} })
  const tile = { nvr: 'n1', ch: 0, streamType: 1 }
  const f = frame({ us: US0 })
  for (let i = 0; i <= TRACE_MAX_FRAMES; i++) t.frame(tile, f)
  const x = t.stop()
  check(`at most ${TRACE_MAX_FRAMES} frames, then "truncated"`, x.truncated === true && x.tiles[0].frames.length === TRACE_MAX_FRAMES)
}

{
  // the Live page's wiring (viewer.js needs a whole page to import: its source, as other tests read server.mjs)
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../public/viewer.js', import.meta.url), 'utf8')
  check('viewer.js: the trace is started, stopped and downloaded from its button', /import \{[^}]*\bstartTrace\b[^}]*\} from '\.\/frame-trace\.js'/.test(src) && /startTrace\(\{/.test(src) && /stopTrace\(\)/.test(src) && /downloadTrace\(trace\)/.test(src))
  check('viewer.js: the button shows only with the D overlay, or while a trace runs', /traceBtn\.hidden = !showStats && !t\b/.test(src))
  check('viewer.js: D shows or hides it with the overlay', /showStats = !showStats\n\s*grid\.classList\.toggle\('show-stats', showStats\)\n\s*showTraceBtn\(\)/.test(src))
  check('viewer.js: ?stats=1 opens the overlay at load (a phone has no D key)', /let showStats = new URLSearchParams\(location\.search\)\.get\('stats'\) === '1'/.test(src))
  const tile = readFileSync(new URL('../public/live-tile.js', import.meta.url), 'utf8')
  check('live-tile.js: each frame goes to the trace as it arrives, before anything else is done with it', /const buf = new Uint8Array\(e\.data\)\n\s*activeTrace\(\)\?\.frame\(this, buf\)\n\s*this\.onMessage\(buf\)/.test(tile))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
