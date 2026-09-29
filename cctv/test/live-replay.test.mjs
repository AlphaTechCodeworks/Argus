// The live replay (test/live-replay.mjs) and its fixtures: traces read and replay as the Live page's
// D overlay records them (public/frame-trace.js), the fixtures are what their models make, the page
// it fakes is put back, nothing shown is invented -- and the baseline: what today's player shows on
// the modelled traces, the numbers a change to live smoothness is measured against.
//   node cctv/test/live-replay.test.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import {
  FIXTURES, FIXTURE_DIR, NETS, arrivals, fixtureTrace, frameRateOf, modelTrace, play, playTile, segments, traceProblem, traceText
} from './live-replay.mjs'
import { FrameTrace } from '../public/frame-trace.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const brief = (r) => JSON.stringify({ shown: r.shownPct, freezes: r.freezesPerMin, still: r.maxStillMs, back: r.maxBackMs, lat: r.medLatencyMs, dropped: r.dropped, resyncs: r.resyncs })

// ---- the fixtures: modelled traces in the recorder's format, small, and exactly what the models make
{
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort()
  check('one fixture for each model', JSON.stringify(files) === JSON.stringify(Object.keys(FIXTURES).map((n) => `${n}.json`).sort()), files.join(' '))
  const bytes = files.reduce((a, f) => a + statSync(new URL(f, FIXTURE_DIR)).size, 0)
  check('small: a few hundred KB in all', bytes < 400_000, `${Math.round(bytes / 1024)} KB`)
  for (const name of Object.keys(FIXTURES)) {
    // (a Windows checkout with core.autocrlf may hand it over with CRLF line ends)
    const text = readFileSync(new URL(`${name}.json`, FIXTURE_DIR), 'utf8').replace(/\r\n/g, '\n')
    check(`${name}.json is a frame trace (format and version of public/frame-trace.js)`, traceProblem(JSON.parse(text)) === null, traceProblem(JSON.parse(text)))
    check(`${name}.json is exactly what its model makes (node cctv/test/live-replay.mjs --write-fixtures)`, text === traceText(modelTrace(name)))
  }
  const lan = fixtureTrace('lan')
  check('the models: 20 fps and 30 fps, 2 minutes, a keyframe every 2 s', Math.round(frameRateOf(lan.tiles[0].frames.map(([at, ts]) => ({ at, ts })))) === 20 && Math.round(frameRateOf(lan.tiles[1].frames.map(([at, ts]) => ({ at, ts })))) === 30 && lan.tiles[0].frames.length === 2400 && lan.tiles[0].frames[40][3] === 1 && lan.tiles[0].frames[39][3] === 0)
}

// ---- a trace as the Live page records it replays as it is ----
{
  // the recorder fed a modelled 20 fps tunnel stream, by its own clock, as live-tile.js feeds it
  let now = 0
  const tr = new FrameTrace({ now: () => now, wallNow: () => 0, later: () => 1, cancel: () => {}, durationMs: 60_000 })
  const tile = { nvr: 'nvr-2', ch: 9, streamType: 1 }
  tr.event(tile, 'connect', 'sub')
  tr.event(tile, 'open')
  const US0 = 1_759_118_880_000_000
  for (const a of arrivals({ fps: 20, durMs: 50_000, ...NETS.tunnel, seed: 5 })) {
    now = a.at
    const b = new Uint8Array(64)
    b[0] = a.isKey ? 1 : 0
    new DataView(b.buffer).setBigInt64(8, BigInt(US0 + Math.round(a.ts * 1000)), true)
    tr.frame(tile, b)
  }
  const trace = JSON.parse(JSON.stringify(tr.stop())) // through the file, as downloaded
  check('a recorded trace reads as one', traceProblem(trace) === null, traceProblem(trace))
  const r = await playTile(trace.tiles[0])
  check('... and replays: a tunnel stream with no stalls plays whole, in one stretch', r.shownPct >= 99.5 && r.freezesPerMin === 0 && r.backwards === 0 && r.stretches === 1, brief(r))
}

// ---- the stretches a tile really played: reconnects start afresh, hidden stretches are not played ----
{
  const frames = []
  // 50 s at 20 fps, a keyframe every 2 s; nothing arrives while the socket is down (30.03-31 s)
  for (let i = 0; i < 1000; i++) if (i * 50 + 60 < 30_030 || i * 50 + 60 > 31_000) frames.push([i * 50 + 60, i * 50, 1000, i % 40 === 0 ? 1 : 0])
  const tile = { id: 1, frames, events: [[0, 'connect', 'sub'], [0, 'open'], [10_030, 'suspend'], [15_030, 'resume'], [30_030, 'close'], [30_500, 'connect', 'sub'], [31_000, 'open']] }
  const parts = segments(tile)
  check('segments: split at the suspend and at the close', parts.length === 3, JSON.stringify(parts.map((p) => [p.fromMs, p.arr.length])))
  check('... the first from its open, up to the suspend', parts[0].fromMs === 0 && parts[0].arr.length === 200)
  check('... on resume, the frames kept since the last keyframe, all at the resume, then on', parts[1].fromMs === 15_030 && parts[1].arr[0].isKey && parts[1].arr[0].at === 15_030 && parts[1].arr[0].ts === 14_000 && parts[1].arr.filter((f) => f.at === 15_030).length === 20 && parts[1].arr.at(-1).ts === 29_950)
  const twice = segments({ ...tile, events: [[0, 'open'], [10_030, 'suspend'], [12_000, 'suspend'], [15_030, 'resume']] })
  check('... a tile suspended twice (the grid hidden again) is not counted twice', twice.length === 2 && twice[0] !== twice[1], JSON.stringify(twice.map((p) => [p.fromMs, p.arr.length])))
  check('... after the close, from the reconnect\'s open', parts[2].fromMs === 31_000 && parts[2].arr[0].ts === 30_950 && parts[2].arr.at(-1).ts === 49_950, JSON.stringify(parts[2] && [parts[2].fromMs, parts[2].arr[0]]))
}

// ---- nothing shown is invented, and the page it fakes is put back ----
{
  const realSetInterval = globalThis.setInterval
  const realPerformance = globalThis.performance
  // 20 fps with 5 s of it never sent (a camera that stopped): a still picture, not made-up frames
  const arr = arrivals({ fps: 20, durMs: 30_000, seed: 3 }).filter((a) => a.ts < 12_000 || a.ts >= 17_000)
  const r = await play(arr, { fps: 20, decoder: { pool: 16, decodeMs: 3 } })
  check('a 5 s hole at the camera: shown as a still picture of 5 s, no frame made up for it', r.maxStillMs >= 5000 && r.counts.shown <= arr.length, brief(r))
  check('the virtual page is only there while it plays (setInterval, performance put back)', globalThis.setInterval === realSetInterval && globalThis.performance === realPerformance && typeof globalThis.VideoDecoder === 'undefined')
}

// ---- the baseline: today's player (public/player.js and playout.js at 119c43e) on the fixtures ----
// The numbers every later change is measured against (stutter report, section 3). A change to the
// player or its clock that moves them updates them here, with its gain: that is the point.
{
  const base = async (name, i) => playTile(fixtureTrace(name).tiles[i])
  const near = (r, shown, freezes) => Math.abs(r.shownPct - shown) <= 0.5 && Math.abs(r.freezesPerMin - freezes) <= 0.5
  let r = await base('lan', 0)
  check('baseline: local network, 20 fps sub: every frame, no freeze', r.shownPct === 100 && r.freezesPerMin === 0 && r.dropped === 0, brief(r))
  r = await base('lan', 1)
  check('baseline: local network, 30 fps 2560x1440 main, a decoder holding 6 pictures: 87.7% shown, 5.7 freezes a minute (report 2.2)', near(r, 87.7, 5.7), brief(r))
  r = await base('tunnel-nvr', 0)
  check('baseline: tunnel with the NVR\'s pauses, 20 fps sub: 98.9%, 1.0 freeze a minute', near(r, 98.9, 1.0), brief(r))
  r = await base('tunnel-hol', 0)
  check('baseline: tunnel with other tiles\' keyframes ahead on the socket, 20 fps sub: 84.1%, 8.6 freezes a minute', near(r, 84.1, 8.6), brief(r))
  r = await base('tunnel-stall', 0)
  check('baseline: tunnel with a 1.2 s stall every ~20 s, 20 fps sub: 89.0%, 6.6 freezes a minute, the D overlay\'s "dropped" counting them (report 2.4)', near(r, 89.0, 6.6) && r.dropped > 0, brief(r))
  r = await base('switch', 0)
  check('baseline: a level change onto a new conversion: the picture steps back 1.4 s (report 2.5)', r.backwards >= 1 && r.maxBackMs === 1400, brief(r))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
