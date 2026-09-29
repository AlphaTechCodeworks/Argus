// The live replay (test/live-replay.mjs) and its fixtures: traces read and replay as the Live page's
// D overlay records them (public/frame-trace.js), the fixtures are what their models make, the page
// it fakes is put back, nothing shown is invented -- and the baseline: what today's player shows on
// the modelled traces, the numbers a change to live smoothness is measured against.
//   node cctv/test/live-replay.test.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import {
  FIXTURES, FIXTURE_DIR, NETS, REMOTE_LIVE, arrivals, decoderFor, fixtureTrace, frameRateOf, modelTrace, play, playTile, segments, traceProblem, traceText
} from './live-replay.mjs'
import { FrameTrace } from '../public/frame-trace.js'
import { REMOTE_CLOCK } from '../public/playout.js'

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
{
  // A hidden tile's connection drops (the page's socket, or the server ending the channel) and comes
  // back while the full-size view is still open: the tile stays hidden across the reconnect
  // (live-tile.js keeps `suspended`), keeping the new connection's stream, and shows nothing until its
  // resume. The review of 29 Sep found the replay playing those 19 s as if they had been on screen.
  const frames = []
  for (let i = 0; i < 1000; i++) if (i * 50 + 60 < 20_030 || i * 50 + 60 > 21_000) frames.push([i * 50 + 60, i * 50, 1000, i % 40 === 0 ? 1 : 0])
  const tile = { id: 1, frames, events: [[0, 'connect', 'sub'], [0, 'open'], [10_030, 'suspend'], [20_030, 'close'], [20_500, 'connect', 'sub'], [21_000, 'open'], [40_030, 'resume', 'kept']] }
  const parts = segments(tile)
  const hidden = parts.flatMap((p) => p.arr).filter((f) => f.ts >= 10_000 && f.ts < 38_000)
  check('segments: a hidden tile that reconnects stays hidden: nothing between its suspend and its resume is played', parts.length === 2 && hidden.length === 0, JSON.stringify(parts.map((p) => [p.fromMs, p.arr.length, p.arr[0].ts])))
  check('... and its resume decodes what it kept from the new connection, from its last keyframe', parts[1]?.fromMs === 40_030 && parts[1].arr[0].isKey && parts[1].arr[0].ts === 38_000 && parts[1].arr.filter((f) => f.at === 40_030).length === 40 && parts[1].arr.at(-1).ts === 49_950)
}
{
  // Back from hiding with nothing fresh kept (a camera trickling, nothing for 3 s; or more than
  // HOLD_MAX_BYTES since its keyframe): live-tile.js resume() connects again instead of decoding what
  // it kept, and the trace says so ('resume', 'reconnect'). The replay must not decode the kept GOP
  // then as well: the new connection's replay of it would follow, frames stepping back and resyncs
  // the real tile never had (the review of 29 Sep).
  const frames = []
  for (let i = 0; i < 1200; i++) {
    const at = i * 50 + 60
    if (at > 26_000 && at < 30_300) continue // nothing arrives from 26 s: no longer lendable at 30 s
    frames.push([at, i * 50, 1000, i % 40 === 0 ? 1 : 0])
  }
  // the new connection opens at 30.2 s and starts with the camera's latest keyframe (28 s), in a burst
  const replay = []
  for (let ts = 28_000, at = 30_300; ts <= 30_250; ts += 50, at += 1) replay.push([at, ts, 1000, ts === 28_000 ? 1 : 0])
  const all = [...frames.filter((f) => f[0] < 30_300), ...replay, ...frames.filter((f) => f[1] > 30_250).map((f) => [Math.max(f[0], 30_400), ...f.slice(1)])]
  const tile = { id: 1, frames: all, events: [[0, 'connect', 'sub'], [0, 'open'], [10_030, 'suspend'], [30_030, 'resume', 'reconnect'], [30_030, 'connect', 'sub'], [30_200, 'open']] }
  const parts = segments(tile)
  check('segments: a resume that connects again starts afresh from the new connection, nothing kept decoded', parts.length === 2 && parts[1].fromMs === 30_200 && parts[1].arr[0].at === 30_300 && parts[1].arr[0].ts === 28_000 && parts[1].arr.every((f, i) => i === 0 || f.ts > parts[1].arr[i - 1].ts), JSON.stringify(parts.map((p) => [p.fromMs, p.arr.length, p.arr[0]])))
  const r = await playTile(tile)
  const fresh = await playTile({ id: 1, frames: all.filter((f) => f[0] >= 30_300), events: [[30_030, 'connect', 'sub'], [30_200, 'open']] })
  const oldEvents = tile.events.map((e) => (e[1] === 'resume' ? [e[0], 'resume'] : e))
  const wrong = await playTile({ ...tile, events: oldEvents })
  check('... and replays as any new connection with that start does, not with the kept GOP in front (more resyncs and frames passed over)',r.backwards === 0 && r.resyncs === fresh.resyncs && r.dropped === fresh.dropped && wrong.resyncs > r.resyncs, `${brief(r)} fresh ${brief(fresh)} kept in front ${brief(wrong)}`)
  const old = segments({ ...tile, events: oldEvents })
  check('... a trace from before the resume said which (no word): as a resume that decoded what it kept', old[1]?.fromMs === 30_030 && old[1].arr[0].at === 30_030 && old[1].arr[0].ts === 24_000, JSON.stringify(old.map((p) => [p.fromMs, p.arr.length, p.arr[0]])))
}
{
  // A trace started while the full-size view is open: the grid's tiles are already hidden when the
  // recorder first sees them (the recorder says so first: frame-trace.js), so their frames are not
  // played until the resume.
  let now = 0
  const tr = new FrameTrace({ now: () => now, wallNow: () => 0, later: () => 1, cancel: () => {}, durationMs: 60_000 })
  const tile = { nvr: 'nvr-2', ch: 3, streamType: 1, suspended: true }
  const US0 = 1_759_118_880_000_000
  for (let i = 0; i < 600; i++) {
    now = i * 50 + 60
    if (now > 15_000 && tile.suspended) {
      tile.suspended = false
      tr.event(tile, 'resume', 'kept')
    }
    const b = new Uint8Array(64)
    b[0] = i % 40 === 0 ? 1 : 0
    new DataView(b.buffer).setBigInt64(8, BigInt(US0 + i * 50_000), true)
    tr.frame(tile, b)
  }
  const parts = segments(JSON.parse(JSON.stringify(tr.stop())).tiles[0])
  check('segments: a trace started over a hidden tile plays nothing of it before its resume', parts.length === 1 && parts[0].fromMs === 15_010 && parts[0].arr[0].isKey && parts[0].arr[0].ts === 14_000 && parts[0].arr[0].at === 15_010, JSON.stringify(parts.map((p) => [p.fromMs, p.arr.length, p.arr[0]])))
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
{
  // one replay at a time: play() puts one virtual page and clock in place, and a second at the same
  // time (Promise.all over a trace's tiles) would silently run both on it
  const arr = arrivals({ fps: 20, durMs: 15_000, ...NETS.tunnel, seed: 4 })
  const solo = await play(arr, { fps: 20 })
  const first = play(arr, { fps: 20 })
  const second = await play(arr, { fps: 20 }).then(() => null, (e) => e)
  const r = await first
  check('play() is not re-entrant: a second while one runs is refused, the first unharmed', second?.message === 'play() is not re-entrant: await each replay' && brief(r) === brief(solo), `${second} ${brief(r)} ${brief(solo)}`)
  check('... and the next, once it is done, runs', brief(await play(arr, { fps: 20 })) === brief(solo))
}

// ---- the baseline: the Live page's player (public/player.js and playout.js) on the fixtures ----
// The numbers every later change is measured against (stutter report, section 3). A change to the
// player or its clock that moves them updates them here, with its gain: that is the point.
// Gains so far (the numbers at 119c43e in brackets):
//   report 2.2 (live-smooth t1, 29 Sep): frames timed as they arrive, a burst after a hiccup not taken
//   for a slow decoder (player.js arrivalClock, as live-tile.js makes its player)
{
  const base = async (name, i) => playTile(fixtureTrace(name).tiles[i])
  const near = (r, shown, freezes) => Math.abs(r.shownPct - shown) <= 0.5 && Math.abs(r.freezesPerMin - freezes) <= 0.5
  let r = await base('lan', 0)
  check('baseline: local network, 20 fps sub: every frame, no freeze', r.shownPct === 100 && r.freezesPerMin === 0 && r.dropped === 0, brief(r))
  r = await base('lan', 1)
  check('baseline: local network, 30 fps 2560x1440 main, a decoder holding 6 pictures: every frame, no freeze, never still over 1.5 frame intervals [87.7%, 5.7 freezes a minute]', r.shownPct === 100 && r.freezesPerMin === 0 && r.maxStillMs <= 50, brief(r))
  r = await base('tunnel-nvr', 0)
  check('baseline: tunnel with the NVR\'s pauses, 20 fps sub: 99.7%, no freeze [98.9%, 1.0]', near(r, 99.7, 0), brief(r))
  r = await base('tunnel-hol', 0)
  check('baseline: tunnel with other tiles\' keyframes ahead on the socket, 20 fps sub: 98.9%, 2.0 freezes a minute [84.1%, 8.6]', near(r, 98.9, 2.0), brief(r))
  r = await base('tunnel-stall', 0)
  check('baseline: tunnel with a 1.2 s stall every ~20 s, 20 fps sub: 97.3%, 3.1 freezes a minute, the D overlay\'s "dropped" counting the frames passed over (report 2.4) [89.0%, 6.6]', near(r, 97.3, 3.1) && r.dropped > 0, brief(r))
  r = await base('switch', 0)
  check('baseline: a level change onto a new conversion: the picture steps back 1.4 s (report 2.5)', r.backwards >= 1 && r.maxBackMs === 1400, brief(r))
  // the player as it was, and as playback's still is: the harness can replay it (playerOptions)
  r = await playTile(fixtureTrace('lan').tiles[1], { playerOptions: { arrivalClock: false } })
  check('... without arrivalClock (the player at 119c43e): local network, 30 fps 2560x1440 main: 87.7%, 5.7 freezes a minute', near(r, 87.7, 5.7), brief(r))
}
// ---- the same baseline with a decoder like real Chrome's on the owner's PC: it takes about 5 frames
// in before its queue counts them (verify-2: a 20-frame burst read 15), and the model above, which
// counts every one, is about 3 times too gloomy. A gain is claimed on both, never on one alone ----
{
  const chrome = async (name, i) => {
    const tile = fixtureTrace(name).tiles[i]
    return playTile(tile, { decoder: { ...decoderFor(tile), inFlight: 5 } })
  }
  const near = (r, shown, freezes) => Math.abs(r.shownPct - shown) <= 0.5 && Math.abs(r.freezesPerMin - freezes) <= 0.5
  let r = await chrome('lan', 1)
  check('baseline, Chrome-like decoder: local network, 30 fps 2560x1440 main: every frame, no freeze [98.3%, 0.5]', r.shownPct === 100 && r.freezesPerMin === 0, brief(r))
  r = await chrome('tunnel-nvr', 0)
  check('baseline, Chrome-like decoder: tunnel with the NVR\'s pauses: 99.7%, no freeze [99.6%, 0]', near(r, 99.7, 0), brief(r))
  r = await chrome('tunnel-hol', 0)
  check('baseline, Chrome-like decoder: tunnel with other tiles\' keyframes ahead: 98.9%, 2.0 freezes a minute [96.5%, 3.5]', near(r, 98.9, 2.0), brief(r))
  r = await chrome('tunnel-stall', 0)
  check('baseline, Chrome-like decoder: tunnel with a 1.2 s stall every ~20 s: 97.3%, 3.1 freezes a minute [90.7%, 5.6]', near(r, 97.3, 3.1), brief(r))
}

// ---- a page through the tunnel: the remote profile (report 2.4 with verify-4's corrections, 29 Sep) ----
// viewer.js gives a page not opened on the local network (device.js isLocalHost) the remote playout
// clock (playout.js REMOTE_CLOCK: a late frame grows the buffer by its lateness, up to 2 s, coming down
// over a minute) and a player that keeps up to 2 s of decoded frames (player.js REMOTE_QUEUED_FRAMES).
// What it shows on the modelled tunnel traces, on both decoder models (Task 2's proof: frames shown
// about 100%, freezes of 200 ms or more at most about 0.5 a minute, median delay about 1.2-2 s where
// the link stalls; the numbers in brackets are the local profile's, above). Local pages are not
// touched: the baseline above is theirs, unchanged.
{
  const remote = async (name, i, decoder = {}) => {
    const tile = fixtureTrace(name).tiles[i]
    return playTile(tile, { ...REMOTE_LIVE, decoder: { ...decoderFor(tile), ...decoder } })
  }
  const pin = (r, shown, freezes, lat) => Math.abs(r.shownPct - shown) <= 0.1 && Math.abs(r.freezesPerMin - freezes) <= 0.1 && Math.abs(r.medLatencyMs - lat) <= 50
  check('remote profile: the player keeps 2 s of decoded frames at 30 fps and 15 spare (75), not the usual 45', REMOTE_LIVE.playerOptions.maxQueuedFrames === 75 && REMOTE_LIVE.clock === REMOTE_CLOCK)
  const page = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8')
  check('... playback and the wall keep theirs: no remote clock, no decoded-frame limit of their own', ['playback.js', 'wall.js'].every((f) => !/REMOTE_|maxQueuedFrames|stretchLate|shrinkWindowMs/.test(page(f))))
  for (const decoder of [{}, { inFlight: 5 }]) {
    const on = decoder.inFlight ? ', Chrome-like decoder' : ''
    let r = await remote('tunnel-stall', 0, decoder)
    check(`remote profile${on}: tunnel with a 1.2 s stall every ~20 s: 100% of frames, one freeze in 2 minutes (the first stall), median delay 1.57 s [97.3%, 3.1 a minute, 0.78 s]`, pin(r, 100, 0.5, 1567) && r.skipEventsPerMin === 0, brief(r))
    r = await remote('tunnel-hol', 0, decoder)
    check(`remote profile${on}: tunnel with other tiles' keyframes ahead: 100%, one freeze of about 200 ms, median delay 1.18 s [98.9%, 2.0, 1.03 s]`, pin(r, 100, 0.5, 1184) && r.maxStillMs < 250, brief(r))
    r = await remote('tunnel-nvr', 0, decoder)
    check(`remote profile${on}: tunnel with the NVR's pauses: 100%, one still of about 200 ms, median delay 0.77 s [99.7%, 0, 0.65 s]`, pin(r, 100, 0.5, 767) && r.maxStillMs < 250, brief(r))
    r = await remote('lan', 0, decoder)
    check(`remote profile${on}: a clean link (the local model): every frame, no freeze, median delay 0.42 s (350 ms for the first minute, then down to 150) [100%, 0, 0.37 s]`, r.shownPct === 100 && r.freezesPerMin === 0 && pin(r, 100, 0, 417), brief(r))
  }
  // 30 fps decoded in software (no picture limit): at 1.1-1.5 s of buffer the player holds more than
  // 45 decoded frames, and the usual limit threw frames away (verify-4: 2.8 a minute)
  const arr = arrivals({ fps: 30, durMs: 120_000, ...NETS['tunnel+stall'], seed: 11 })
  const soft = { pool: Infinity, decodeMs: 3 }
  const kept = await play(arr, { ...REMOTE_LIVE, decoder: soft })
  const cut = await play(arr, { clock: REMOTE_CLOCK, decoder: soft })
  check('remote profile, 30 fps decoded in software, 1.2 s stalls: every frame with 75 decoded frames kept, frames thrown away with 45', kept.shownPct === 100 && kept.skipEventsPerMin === 0 && cut.skipEventsPerMin > 5, `${brief(kept)} with 45: ${brief(cut)}`)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
