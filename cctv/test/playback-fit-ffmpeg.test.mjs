// A remote viewer's NVR main stream through the real ffmpeg (playback.mjs PlaybackSession #fitDecide; the
// playback hunt of 1 Oct 2026, finding F6). ffmpeg is installed on the server only, and playback.mjs loads
// koffi, so this runs there, on a copy. What the stand-in in playback-fit.test.mjs cannot prove: that the
// NVR's H.264 at the rate measured through the tunnel (6 Mbit/s) comes out of the session within the cap,
// every frame with its own capture time, and at the footage's own rate from the first second (the pacer
// waits for a converter that has just started, as server playback does since finding F3).
// The footage is ffmpeg's own test pattern with grain (2560x1440, 20 fps, a keyframe every 2 s), handed to
// the session as the NVR hands frames over: through the SDK's playback route, faster than they play. A
// fake NVR whose lane answers each SDK job without running it: nothing reaches an NVR.
//   node cctv/test/playback-fit-ffmpeg.test.mjs        (on the server copy)
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'pb-fit-ffmpeg-'))
const pb = await import('../playback.mjs')
const { TranscodePool, CODEC_H264 } = await import('../transcode.mjs')
const { CODEC, splitUnits } = await import('../rec-reader.mjs')
const { playFrames } = await import('../sdk.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const info = (line) => console.log(`INFO  ${line}`)
const until = async (pred, ms = 5000) => {
  const t = performance.now()
  while (!pred() && performance.now() - t < ms) await sleep(10)
  return pred()
}
const FPS = 20
const STEP = 1000 / FPS
const GOP = 2 * FPS
const SECONDS = 12
const KBPS = 6000 // what the NVR's main stream measured through the tunnel (6.3 Mbit/s)

const clip = execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=2560x1440:rate=${FPS}`,
  '-vf', 'noise=alls=12:allf=t', '-frames:v', String(SECONDS * FPS),
  '-c:v', 'libx264', '-preset', 'ultrafast', '-g', String(GOP), '-keyint_min', String(GOP), '-sc_threshold', '0', '-bf', '0', '-b:v', `${KBPS}k`, '-maxrate', `${KBPS}k`, '-bufsize', `${2 * KBPS}k`,
  '-pix_fmt', 'yuv420p', '-f', 'h264', 'pipe:1'
], { maxBuffer: 512 * 1024 * 1024 })
const units = splitUnits(clip, CODEC.h264).units
check(`footage: ${SECONDS} s of H.264 at ${FPS} fps, a keyframe every 2 s`, units.length === SECONDS * FPS && units.every((u, i) => u.isKey === (i % GOP === 0)), `${units.length} pictures`)
info(`the footage: ${((clip.length * 8) / SECONDS / 1000).toFixed(0)} kbit/s`)

const routes = new Map()
const realClaim = playFrames.claim.bind(playFrames)
playFrames.claim = (h, fn) => {
  routes.set(h, fn)
  realClaim(h, fn)
}
let handles = 700
const START = Date.now() - 3_600_000
/** A session of a fake NVR (its lane answers each job without running it), started; the frames it sends. */
async function open(id, fit, pool) {
  const handle = ++handles
  const answers = [true, handle]
  let n = 0
  const logs = []
  const nvr = { id, name: `NVR ${id}`, userId: 7, online: true, degraded: false }
  nvr.lane = { run: async () => { const k = n++; return k < answers.length ? answers[k] : true } }
  nvr.sessions = { acquire: async () => ({ userId: 9, release() {} }) }
  nvr.playback = pb.createPlayback(nvr, { pool, log: (l) => logs.push(l) })
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, texts: [], bins: [], handlers: {} }
  ws.send = (m) => {
    if (typeof m === 'string') return ws.texts.push(JSON.parse(m))
    ws.bins.push({ at: performance.now(), key: (m[0] & 1) === 1, codec: m[1], ts: Number(m.readBigInt64LE(8)) / 1000, bytes: m.length - 16 })
  }
  ws.on = (event, fn) => (ws.handlers[event] = fn)
  ws.close = () => {
    if (ws.readyState !== 1) return
    ws.readyState = 3
    ws.handlers.close?.()
  }
  nvr.playback.connect(ws, new URL(`ws://x/playback?nvr=${id}&ch=0&start=${START}`), { main: true, allowMain: () => true, fit })
  await until(() => ws.texts.some((m) => m.type === 'started'), 3000)
  const t0 = performance.now()
  for (let i = 0; i < units.length; i++) {
    const buf = clip.subarray(units[i].start, units[i].end)
    routes.get(handle)({ frameType: 1, length: buf.length, keyFrame: units[i].isKey ? 1 : 0, width: 2560, height: 1440, time: Math.round((START + i * STEP) * 1000) }, buf)
  }
  return { ws, logs, t0 }
}
/** What reached the socket in the 10 s from its first frame. */
function measure(ws) {
  const first = ws.bins[0]
  const span = ws.bins.filter((b) => b.at - first.at < 10_000)
  const perS = Array.from({ length: 10 }, (_, s) => span.filter((b) => b.at - first.at >= s * 1000 && b.at - first.at < (s + 1) * 1000))
  return {
    frames: perS.map((l) => l.length),
    kbit: perS.map((l) => Math.round((l.reduce((a, b) => a + b.bytes, 0) * 8) / 1000)),
    kbps: (span.reduce((a, b) => a + b.bytes, 0) * 8) / 10_000,
    ahead: Math.max(...span.map((b) => b.ts - first.ts - (b.at - first.at))),
    span
  }
}

{
  const pool = new TranscodePool(2)
  const { ws, logs, t0 } = await open('fit-ff', {}, pool)
  await until(() => ws.bins.length > 0, 8000)
  const firstAfter = ws.bins.length ? ws.bins[0].at - t0 : null
  await sleep(10_500)
  const m = measure(ws)
  info(`remote: first picture after ${firstAfter?.toFixed(0)} ms; frames a second ${m.frames.join(' ')}; kbit a second ${m.kbit.join(' ')}; ${m.kbps.toFixed(0)} kbit/s over 10 s; at most ${m.ahead.toFixed(0)} ms ahead`)
  check('remote, the NVR\'s 6 Mbit/s H.264 main stream: told {type:"fit", on:true}; every frame out is the converter\'s H.264', ws.texts.some((x) => x.type === 'fit' && x.on === true) && ws.bins.length > 150 && ws.bins.every((b) => b.codec === CODEC_H264), `${ws.bins.length} frames`)
  check('... within the cap over 10 s (2.5 Mbit/s; under 2.9 counted)', m.kbps > 300 && m.kbps < 2900, `${m.kbps.toFixed(0)} kbit/s`)
  check('... every frame once, in order, with the capture time of the frame it was made from, starting on the keyframe', ws.bins[0].key && m.span.every((b, i) => Math.abs(b.ts - (START + i * STEP)) < 0.01), m.span.slice(0, 3).map((b) => b.ts - START).join())
  check('... 20 frames in every second from the first (18-22 counted)', m.frames.every((n) => n >= 18 && n <= 22), m.frames.join(' '))
  check('... no frame more than 150 ms ahead of its time (no rush after the converter\'s start)', m.ahead <= 150, `${m.ahead.toFixed(0)} ms`)
  check('... the wait for the converter did not run out', !logs.some((l) => /gave no picture/.test(l)), logs.join(' | '))
  ws.close()
  check('... closed: the slot given back', pool.active === 0)
}
{
  // the local network: the NVR's own bytes, as before
  const pool = new TranscodePool(2)
  const { ws } = await open('fit-ff-local', null, pool)
  await until(() => ws.bins.length > 0, 3000)
  await sleep(10_500)
  const m = measure(ws)
  info(`local: frames a second ${m.frames.join(' ')}; ${m.kbps.toFixed(0)} kbit/s over 10 s`)
  check('local: the NVR\'s frames as they came (the footage\'s own bytes and rate), no conversion', pool.active === 0 && !ws.texts.some((x) => x.type === 'fit') && m.span.every((b, i) => b.bytes === units[i].end - units[i].start), `${m.kbps.toFixed(0)} kbit/s`)
  check('... 20 frames in every second', m.frames.every((n) => n >= 18 && n <= 22), m.frames.join(' '))
  ws.close()
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
