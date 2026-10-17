// Live on the local network: a decoder that keeps frames back, and frames that come in clumps.
//
// Measured on the viewing PC (2026-10-09): H.264 at 1280x720 comes out of Chrome's decoder about ten
// frames after it went in (0.33 s at 30 fps), and the NVRs hand frames over in clumps, a wait of
// 80-190 ms each second. Together that is past the 350 ms buffer, the frames come out after their
// display time and the page skipped them: a 20-tile grid drew 20.9 frames of 26.2, every one of them
// arrived and decoded. The clock was never told (it times live frames as they arrive), so the buffer
// never grew. Now it is told, as it already was through the tunnel (player.js #onDecoded), except
// while the decoder is overloaded: then a bigger buffer only shows the same few frames later.
//
// Replayed through the real player in virtual time (test/live-replay.mjs), each stream with the
// option off (as before) and on.
//   node cctv/test/player-decoder-hold.test.mjs
import { REMOTE_LIVE, arrivals, play } from './live-replay.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const brief = (r) => JSON.stringify({ shown: r.shownPct, freezes: r.freezesPerMin, still: r.maxStillMs, lat: r.medLatencyMs })
const both = async (arr, decoder) => ({
  before: await play(arr, { decoder, playerOptions: { arrivalClock: true, countDecoderHold: false } }),
  after: await play(arr, { decoder, playerOptions: { arrivalClock: true } })
})
const HOLDS_TEN = { pool: 11, decodeMs: 5, inFlight: 1, hold: 10 }
const clumps = (fps, durMs = 120_000) => arrivals({ fps, durMs, nvr: { every: 1000, lo: 120, hi: 200 } })

{
  const { before, after } = await both(clumps(26), HOLDS_TEN)
  check('before: 26 fps in clumps through a decoder that keeps ten frames back: frames skipped, the picture freezes', before.shownPct < 92 && before.freezesPerMin > 5, brief(before))
  check('now: the buffer grows to cover it: 99% shown, at most one freeze a minute, under 0.3 s more delay', after.shownPct >= 99 && after.freezesPerMin <= 1 && after.medLatencyMs - before.medLatencyMs < 300 && after.medLatencyMs <= 850, brief(after))
}
{
  const { before, after } = await both(clumps(26), { pool: 11, decodeMs: 5, inFlight: 1, hold: 0 })
  check('a decoder that keeps nothing back (H.265 here): nothing changes, the delay included', after.shownPct === before.shownPct && after.medLatencyMs === before.medLatencyMs, `${brief(before)} -> ${brief(after)}`)
}
{
  const { before, after } = await both(arrivals({ fps: 30, durMs: 120_000 }), HOLDS_TEN)
  check('an even 30 fps stream through the same decoder: every frame shown either way, the delay within a frame', after.shownPct >= 100 && Math.abs(after.medLatencyMs - before.medLatencyMs) <= 40, `${brief(before)} -> ${brief(after)}`)
}
{
  // 50 ms a frame for a 30 fps stream: it falls further behind every frame, and skips to keyframes
  const { before, after } = await both(arrivals({ fps: 30, durMs: 60_000 }), { pool: 6, decodeMs: 50, inFlight: 5 })
  check('an overloaded decoder: the buffer is not grown for it (within 60 ms and 4 points of before)', after.medLatencyMs - before.medLatencyMs <= 60 && before.shownPct - after.shownPct <= 4, `${brief(before)} -> ${brief(after)}`)
}
{
  // 36 ms a frame for 30 fps: only just too slow, so it is a while before it first skips to a keyframe
  const { before, after } = await both(arrivals({ fps: 30, durMs: 120_000 }), { pool: 6, decodeMs: 36, inFlight: 5 })
  check('a decoder only just too slow: seen to be falling behind before its first skip, the buffer left alone', after.medLatencyMs - before.medLatencyMs <= 60 && before.shownPct - after.shownPct <= 1, `${brief(before)} -> ${brief(after)}`)
}
{
  // ten frames at 10 fps is a second: more than live's buffer may grow to (800 ms)
  const { before, after } = await both(clumps(10), HOLDS_TEN)
  check('a hold longer than the buffer may grow: not grown for it', after.medLatencyMs - before.medLatencyMs <= 40, `${brief(before)} -> ${brief(after)}`)
}
{
  // live through the tunnel (REMOTE_CLOCK grows by a late frame's whole lateness): left as it was
  const arr = arrivals({ fps: 30, durMs: 60_000 })
  const decoder = { pool: 6, decodeMs: 50, inFlight: 5 }
  const before = await play(arr, { decoder, clock: REMOTE_LIVE.clock, playerOptions: { ...REMOTE_LIVE.playerOptions, arrivalClock: true, countDecoderHold: false } })
  const after = await play(arr, { decoder, clock: REMOTE_LIVE.clock, playerOptions: { ...REMOTE_LIVE.playerOptions, arrivalClock: true } })
  check('live through the tunnel, an overloaded decoder: exactly as before', after.shownPct === before.shownPct && after.medLatencyMs === before.medLatencyMs && after.maxStillMs === before.maxStillMs, `${brief(before)} -> ${brief(after)}`)
}

console.log(failures ?`\n${failures} failed` : '\nall passed')
process.exitCode = failures ? 1 : 0
