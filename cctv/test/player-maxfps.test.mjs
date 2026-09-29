// Phones: the 15 fps draw limit, held in the video's own time (stutter report 2.8, Task 3).
//
// A phone's tiles are made with maxFps 15 (device.js maxLiveFps): its small screen gains little from
// more, and each picture drawn costs it. The player held that in wall time: at most one draw every
// 62.7 ms. On a 60 Hz screen that is every 4th refresh, and each draw showed the newest frame due, so a
// 20 fps camera (most cameras here are 18.7-20 fps) drew 15 times a second stepping 50, 50 and 100 ms
// through the video: movement at 1x, 1x, 2x, several times a second (the replay: 51-53% of steps
// uneven). The server does not thin a 20 fps stream for 15 either (phone-live.mjs keepEveryFor(20, 15)
// is 1), so nothing else evens it out.
//
// Held in the video's own time instead: a frame is drawn only when it was captured far enough after
// the last one drawn -- 3/4 of a 15 fps interval, less 4 ms for the cameras' own clocks, 46 ms. A
// 20 fps camera is drawn whole, 50 ms apart; a 25 fps one every 2nd frame, 12.5 a second 80 ms apart;
// a 30 fps one every 2nd frame, 15 a second 67 ms apart. A stream that goes back in time (a switch, a
// camera clock set back) is drawn at once, not held until it passes the last frame drawn.
//
// The iPhone's own full-screen player shows the tile's canvas through canvas.captureStream (viewer.js);
// with a rate of 15 it sampled the canvas every 67 ms and put the same judder back. With no rate it
// takes each picture as it is painted.
//
// Replayed through the real player in virtual time on a 60 Hz display (test/live-replay.mjs).
//   node cctv/test/player-maxfps.test.mjs
import { readFileSync } from 'node:fs'
import { NETS, REMOTE_LIVE, arrivals, play, rng, switchArrivals } from './live-replay.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

/**
 * Replays arrivals as a phone's tile plays them (maxFps 15 unless said; null: a PC) and lists every
 * picture drawn from `fromMs` on: { at, ts } (ms). steps: capture time advanced from one picture drawn
 * to the next; perSecond: pictures drawn a second.
 */
async function draws(arr, { maxFps = 15, fromMs = 3000, ...o } = {}) {
  const out = []
  const r = await play(arr, {
    maxFps,
    ...o,
    patch: (p) => {
      const onFrame = p.onFrame
      p.onFrame = (ts) => {
        const at = performance.now() // (the replay's virtual clock while it plays)
        if (at >= fromMs) out.push({ at, ts })
        onFrame(ts)
      }
    }
  })
  const steps = out.slice(1).map((d, i) => d.ts - out[i].ts)
  const perSecond = out.length > 1 ? ((out.length - 1) * 1000) / (out.at(-1).at - out[0].at) : 0
  return { ...r, out, steps, perSecond }
}
/** The steps as a count of each (rounded to the ms), for the output. */
const hist = (steps) => {
  const h = {}
  for (const s of steps) h[Math.round(s)] = (h[Math.round(s)] ?? 0) + 1
  return Object.entries(h)
    .sort((a, b) => a[0] - b[0])
    .map(([s, n]) => `${s} ms x${n}`)
    .join(', ')
}
const brief = (d) => `${d.perSecond.toFixed(2)}/s, ${d.out.length} drawn; steps ${hist(d.steps)}`
const allNear = (steps, ms, tol = 1) => steps.length > 0 && steps.every((s) => Math.abs(s - ms) < tol)

// ---- even cameras on the local network: the three rates the report names ----
{
  const d = await draws(arrivals({ fps: 20, durMs: 60_000, seed: 11 }), { fps: 20 })
  check('20 fps on a phone: every frame drawn, 20 a second, each 50 ms of video after the last', allNear(d.steps, 50) && Math.abs(d.perSecond - 20) < 0.2, brief(d))
}
{
  const d = await draws(arrivals({ fps: 30, durMs: 60_000, seed: 11 }), { fps: 30 })
  check('30 fps on a phone: 15 a second, every one 67 ms of video after the last (every 2nd frame, evenly)', allNear(d.steps, 1000 / 15) && Math.abs(d.perSecond - 15) < 0.2, brief(d))
}
{
  const d = await draws(arrivals({ fps: 25, durMs: 60_000, seed: 11 }), { fps: 25 })
  check('25 fps on a phone: 12.5 a second, every one 80 ms of video after the last (every 2nd frame, evenly)', allNear(d.steps, 80) && Math.abs(d.perSecond - 12.5) < 0.2, brief(d))
}
{
  // a limit still: a 60 fps camera (none here yet) is drawn every 3rd frame, 20 a second
  const d = await draws(arrivals({ fps: 60, durMs: 30_000, seed: 11 }), { fps: 60 })
  check('60 fps on a phone: every 3rd frame, 20 a second, 50 ms apart (never more than ~21 a second)', allNear(d.steps, 50) && Math.abs(d.perSecond - 20) < 0.2, brief(d))
}
{
  // a PC is not held at all
  const d = await draws(arrivals({ fps: 30, durMs: 30_000, seed: 11 }), { fps: 30, maxFps: null })
  check('30 fps on a PC (no limit): every frame, 30 a second', allNear(d.steps, 1000 / 30) && Math.abs(d.perSecond - 30) < 0.2, brief(d))
}

// ---- the cameras' own clocks (ev-source, 29 Sep): not exactly 50 ms apart ----
/** A camera stamping frames `stepMs` apart and `keyStepMs` before each keyframe (every `keyEvery`), `oddStepMs` every `oddEvery`th step. */
function camera({ stepMs, keyEvery = 40, keyStepMs = stepMs, oddEvery = 0, oddStepMs = stepMs, durMs = 60_000, seed = 3 }) {
  const r = rng(seed)
  const out = []
  let ts = 0
  let last = -Infinity
  for (let i = 0; ts < durMs; i++) {
    if (i > 0) ts += i % keyEvery === 0 ? keyStepMs : oddEvery && i % oddEvery === 0 ? oddStepMs : stepMs
    last = Math.max(ts + 50 + r() * 5, last + 0.3)
    out.push({ at: last, ts, isKey: i % keyEvery === 0 })
  }
  return out
}
{
  // the 20 fps models (rigginglot, solus, nvr1 4/6/14/26/29, several nvr-2): 49.6 ms apart, 67 ms
  // before most keyframes. 3/4 of a 15 fps interval exactly (50 ms) would pass over every other frame
  const d = await draws(camera({ stepMs: 49.6, keyStepMs: 67 }), { fps: 20 })
  check('a 20 fps camera stamping frames 49.6 ms apart (67 before a keyframe): every frame drawn', d.steps.length > 0 && d.steps.every((s) => Math.abs(s - 49.6) < 1 || Math.abs(s - 67) < 1), brief(d))
}
{
  // the "19 fps" models (nvr1 2, 3, 5, 7, 8, 25, 28, 32; nvr-2 8, 17, 25-29): 40 frames per 2.07-2.14 s,
  // one step in 7 of 67 ms: drawn as the camera took them
  const d = await draws(camera({ stepMs: 50, oddEvery: 7, oddStepMs: 1000 / 15 }), { fps: 19.1 })
  check('a "19 fps" camera (one step in 7 of 67 ms): every frame drawn, as the camera took them', d.steps.length > 0 && d.steps.every((s) => Math.abs(s - 50) < 1 || Math.abs(s - 1000 / 15) < 1), brief(d))
}

// ---- a phone through the tunnel (a remote page: REMOTE_LIVE) ----
{
  const d = await draws(arrivals({ fps: 20, durMs: 60_000, ...NETS['tunnel+nvr'], seed: 11 }), { fps: 20, ...REMOTE_LIVE })
  check('through the tunnel, 20 fps with the NVR\'s pauses: every frame still drawn, 50 ms apart', allNear(d.steps, 50), brief(d))
}
{
  const d = await draws(arrivals({ fps: 30, durMs: 60_000, ...NETS['tunnel+nvr'], seed: 11 }), { fps: 30, ...REMOTE_LIVE })
  check('through the tunnel, 30 fps with the NVR\'s pauses: 15 a second, 67 ms apart', allNear(d.steps, 1000 / 15) && Math.abs(d.perSecond - 15) < 0.3, brief(d))
}

// ---- a stream that goes back in time is drawn at once ----
{
  // a level change (adaptive-live): the new stream starts at its keyframe, 1.5 s older than the last
  // frame the old one sent. Held until the video passed the last frame drawn, the picture would stand
  // still 1.5 s; drawn at once, it steps back just as a PC's does
  const arr = switchArrivals({ fps: 20, gapToKeyMs: 1500, startMs: 900, spacing: 4 })
  const pc = await draws(arr, { fps: 20, maxFps: null, fromMs: 25_000 })
  const d = await draws(arr, { fps: 20, fromMs: 25_000 })
  const back = (x) => x.steps.filter((s) => s < 0).length
  check('a stream switched to an older keyframe: stepped back at once, still no longer than on a PC', back(d) >= 1 && back(d) === back(pc) && d.maxStillMs <= pc.maxStillMs + 17, `phone: still ${d.maxStillMs} ms, ${back(d)} back; PC: still ${pc.maxStillMs} ms, ${back(pc)} back`)
}

// ---- the iPhone's full-screen player takes every picture painted ----
{
  const viewer = readFileSync(new URL('../public/viewer.js', import.meta.url), 'utf8')
  const calls = viewer.match(/\.captureStream\([^)]*\)/g) ?? []
  check('viewer.js: the iPhone full screen captures the canvas with no frame rate (each paint)', calls.length > 0 && calls.every((c) => c === '.captureStream()'), calls.join(' '))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
