// Live: a burst after a hiccup is not a slow decoder (stutter report 2.2, with verify-2's correction).
//
// The player used to drop every frame until the next keyframe (up to 2 s of video, more on a converted
// stream) whenever more than 12 frames waited for the decoder (player.js MAX_DECODE_QUEUE). But Chrome's
// hardware decoder hands the page only a few decoded pictures at a time (6 at 2560x1440 on the viewing
// PC, 11 at 1280x720) and decodes nothing more until the page closes one, so every frame the playout
// buffer holds beyond that waits in the decoder's queue: after a hiccup the frames held back arrive
// together and the queue is just that burst waiting its turn, not a decoder that cannot keep up. And the
// clock saw each frame only once decoded, so waits for a free picture looked like a camera clock running
// fast: the drift slew moved the picture later 10 ms every second, the queue grew with it, and the
// player dropped to the keyframe every 20-60 s on a perfectly even local stream (verify-2's trace).
//
// Live's player (live-tile.js, `arrivalClock`) now times each frame on the playout clock as it arrives,
// and drops to the keyframe only when the oldest frame in the decoder has waited there more than 250 ms
// past its display time -- or, whatever the clock says, when 150 frames wait. Playback and the wall keep
// the clock as it was (their players are made without the option; verify-2 found playback holding a
// frame 67 ms at a 4x -> 1x change with it on).
//
// One step past verify-2's rule, which counted from the display time alone: a frame that came after its
// display time is counted from when it came, as it was not kept waiting by the decoder. With verify-2's
// rule a 1.0 s hiccup against the 350 ms buffer (frames 650 ms late) still dropped to the keyframe, and
// so did a tile opening a second after one (the server's replay of the frames since, all at once); now
// the late frames are decoded and passed over, and the picture carries on. Showing them all, rather than
// skipping them, is the bigger buffer through the tunnel (report 2.4, Task 2).
//
// Replayed through the real player in virtual time (test/live-replay.mjs), on decoders like Chrome's
// on the owner's PC: 6 pictures with about 5 frames taken in before its decodeQueueSize counts them
// (verify-2: a 20-frame burst read 15), 11 pictures with 1 (1280x720: a 14-frame burst read 13,
// wc-burst2), or software decoding (no picture limit; a 15-frame burst read 15).
//   node cctv/test/player-burst.test.mjs
import { readFileSync } from 'node:fs'
import { arrivals, play, rng } from './live-replay.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const brief = (r) => JSON.stringify({ shown: r.shownPct, still: r.maxStillMs, notDecoded: r.notDecoded, queue: r.maxQueue, lat: r.medLatencyMs })

// the decoders (see the top)
const MAIN_1440 = { pool: 6, decodeMs: 8, inFlight: 5 }
const MAIN_720 = { pool: 11, decodeMs: 5, inFlight: 1 }
const SOFTWARE = { pool: Infinity, decodeMs: 5, inFlight: 0 }

/**
 * An even live stream at `fps` (each frame 50-55 ms after its capture, a keyframe every 2 s), except
 * that nothing arrives for `hiccupMs` from `at`: what was held back then comes at once, back to back.
 */
function hiccup({ fps, hiccupMs = 0, at = 8000, durMs = 30_000 }) {
  const r = rng(5)
  const F = 1000 / fps
  const out = []
  let last = -Infinity
  for (let i = 0; i * F < durMs; i++) {
    let t = i * F + 50 + r() * 5
    if (t >= at && t < at + hiccupMs) t = at + hiccupMs
    t = Math.max(t, last + 0.3)
    last = t
    out.push({ at: t, ts: i * F, isKey: i % Math.round(2000 / F) === 0 })
  }
  return out
}

/**
 * Replays arrivals through a player made as live-tile.js makes it (live: arrivalClock) or as before
 * (and as playback still is); also the longest the decoder's queue got (read as each frame is fed).
 */
async function run(arr, { live, patch, ...o }) {
  let maxQueue = 0
  const r = await play(arr, {
    ...o,
    playerOptions: { arrivalClock: live },
    patch: (p) => {
      const push = p.push.bind(p)
      p.push = (chunk) => {
        const out = push(chunk)
        maxQueue = Math.max(maxQueue, p.decoder?.decodeQueueSize ?? 0)
        return out
      }
      patch?.(p)
    }
  })
  return { ...r, maxQueue }
}

// ---- a hiccup inside the buffer: every frame is on time, only the decoder's queue is long ----
{
  // 2560x1440 at 30 fps, an 800 ms buffer (as far as the live clock grows; where the remote profile of
  // report 2.4 is to start), a 700 ms hiccup: the frames held back all come before their display time
  const arr = hiccup({ fps: 30, hiccupMs: 700 })
  const o = { fps: 30, clock: { startDelayMs: 800 }, decoder: MAIN_1440 }
  const before = await run(arr, { ...o, live: false })
  const r = await run(arr, { ...o, live: true })
  check('before: a 6-picture decoder behind an 800 ms buffer drops to the keyframe again and again, though no frame is late', before.notDecoded > 100 && before.shownPct < 60 && before.maxStillMs > 1000, brief(before))
  check('live: every frame decoded and shown, never still longer than 1.5 frame intervals', r.notDecoded === 0 && r.shownPct === 100 && r.maxStillMs <= 50, brief(r))
  check('  (the queue did pass 12: it is the frames waiting their turn)', r.maxQueue > 12, brief(r))
}
{
  // the case measured in Chrome on the owner's PC (wc-burst2): 1280x720 hardware, frames held 800 ms, a
  // 700 ms stall at 20 fps: the 14-frame burst read 13 and the player dropped
  const arr = hiccup({ fps: 20, hiccupMs: 700 })
  const o = { fps: 20, clock: { startDelayMs: 800 }, decoder: MAIN_720 }
  const before = await run(arr, { ...o, live: false })
  const r = await run(arr, { ...o, live: true })
  check('before: 1280x720, 800 ms held, a 700 ms stall: the burst reads 13 and the player waits for the next keyframe', before.maxQueue === 13 && before.notDecoded > 0 && before.maxStillMs > 1000, brief(before))
  check('live: every frame shown, never still longer than 1.5 frame intervals', r.notDecoded === 0 && r.shownPct === 100 && r.maxStillMs <= 75, brief(r))
}

// ---- a hiccup that outlasts the buffer by less than 250 ms: the late frames are skipped, no more ----
{
  // software decoding at 30 fps, the live buffer (350 ms), a 500 ms hiccup: measured in Chrome, the
  // 15-frame burst read 15 and the player dropped (wc-burst3). The frames that came up to ~150 ms late
  // are passed over as the display catches up; the picture holds for about that long, not until the
  // next keyframe
  const arr = hiccup({ fps: 30, hiccupMs: 500 })
  const o = { fps: 30, decoder: SOFTWARE }
  const before = await run(arr, { ...o, live: false })
  const r = await run(arr, { ...o, live: true })
  check('before: software decoding, a 500 ms hiccup: dropped to the keyframe, still for over a second', before.notDecoded > 0 && before.maxStillMs > 1000, brief(before))
  check('live: every frame goes to the decoder; the picture holds for the hiccup\'s overrun, not until the keyframe', r.notDecoded === 0 && r.maxStillMs <= 250 && r.shownPct >= 99.5, brief(r))
}
{
  // a 1.0 s hiccup against the 350 ms buffer leaves frames up to 650 ms late. Counted from its display
  // time alone (verify-2's rule) the oldest was over 250 ms behind and the player still dropped to the
  // keyframe; but a frame that came after its display time has been waiting on the decoder only since it
  // came. The late ones are passed over and the picture carries on; showing them all takes the bigger
  // buffer of report 2.4
  const arr = hiccup({ fps: 30, hiccupMs: 1000 })
  const o = { fps: 30, decoder: MAIN_1440 }
  const before = await run(arr, { ...o, live: false })
  const r = await run(arr, { ...o, live: true })
  check('live, a 1.0 s hiccup against 350 ms: still for the overrun (650 ms), not until the keyframe', before.notDecoded > 0 && before.maxStillMs > 1000 && r.notDecoded === 0 && r.maxStillMs <= 700, `${brief(r)} before ${brief(before)}`)
}

// ---- a tile opening: the server's replay from the camera's last keyframe comes at once ----
{
  // 30 fps, 2560x1440: the connection opens 1 s after the last keyframe and the server sends the 30
  // frames since (gop-replay.mjs) back to back, then the live frames. The clock re-anchors on the newest
  // (it is live), so the older ones are late: that is not the decoder being behind either
  const fps = 30
  const F = 1000 / fps
  const r0 = rng(9)
  const arr = []
  let t = 10_000
  for (let i = 270; i * F <= 9950; i++) arr.push({ at: (t += 0.3), ts: i * F, isKey: i === 270 })
  for (let i = 299; i * F < 22_000; i++) arr.push({ at: Math.max(i * F + 50 + r0() * 5, (t += 0.3)), ts: i * F, isKey: (i - 270) % 60 === 0 })
  const o = { fps, from: 10_000, warmMs: 0, decoder: MAIN_1440 }
  const before = await run(arr, { ...o, live: false })
  const r = await run(arr, { ...o, live: true })
  check('before: the replay overflows the decoder\'s queue and the player waits for the next keyframe', before.notDecoded > 20 && before.maxStillMs > 300, brief(before))
  check('live: all of it decoded, the late part passed over, then on at once: never still longer than 1.5 frame intervals', r.notDecoded === 0 && r.maxStillMs <= 50, brief(r))
}

// ---- the drift estimator: decoder waits are not a fast camera clock (verify-2) ----
{
  // perfectly steady local arrivals, 2560x1440 at 30 fps, 2 minutes, the live clock as it is
  const arr = arrivals({ fps: 30, durMs: 120_000, seed: 11 })
  const trace = (s) => (p) => {
    const adapt = p.clock.adapt.bind(p.clock)
    p.clock.adapt = (now) => {
      s.anchor0 ??= p.clock.anchor
      s.maxSlew = Math.max(s.maxSlew, Math.abs(p.clock.slewLeft))
      s.moved = Math.max(s.moved, p.clock.anchor - s.anchor0)
      return adapt(now)
    }
  }
  const o = { fps: 30, decoder: MAIN_1440 }
  const sb = { anchor0: null, maxSlew: 0, moved: 0 }
  const before = await run(arr, { ...o, live: false, patch: trace(sb) })
  const s = { anchor0: null, maxSlew: 0, moved: 0 }
  const r = await run(arr, { ...o, live: true, patch: trace(s) })
  check('before: timed once decoded, waits for a free picture read as a fast camera clock: the picture slews later, the queue grows, a drop', sb.maxSlew > 100 && sb.moved > 300 && before.notDecoded > 0 && before.maxStillMs > 1000, `slew ${Math.round(sb.maxSlew)} ms, moved ${Math.round(sb.moved)} ms, ${brief(before)}`)
  check('live: timed as it arrives, the clock never slews (the camera clock is exact) and the picture never moves later', s.maxSlew <= 5 && s.moved <= 0, `slew ${Math.round(s.maxSlew)} ms, moved ${Math.round(s.moved)} ms`)
  check('live: 2 minutes, every frame shown, never still longer than 1.5 frame intervals, delay as set (not grown)', r.notDecoded === 0 && r.shownPct === 100 && r.maxStillMs <= 50 && r.medLatencyMs <= 420 && before.medLatencyMs > r.medLatencyMs + 100, `${brief(r)} before ${brief(before)}`)
}

// ---- a decoder that really cannot keep up still drops, and the queue stays bounded ----
{
  // 50 ms a frame for a 30 fps stream: it falls further behind every frame
  const arr = hiccup({ fps: 30 })
  const r = await run(arr, { fps: 30, decoder: { pool: 6, decodeMs: 50, inFlight: 5 }, live: true })
  check('live, a decoder too slow for the stream: still dropped to the keyframe, the queue kept short', r.notDecoded > 100 && r.maxQueue <= 20, brief(r))
}
{
  // whatever the clock says: a stand-in by which no frame is ever due (the lateness rule can never
  // fire) and a decoder that hands nothing back: at most 150 frames wait, plus the keyframes after
  const arr = hiccup({ fps: 30, durMs: 10_000 })
  const r = await run(arr, {
    fps: 30,
    decoder: { pool: 0, decodeMs: 8, inFlight: 0 },
    live: true,
    patch: (p) => {
      p.clock.presentAt = () => Infinity
    }
  })
  const keys = arr.filter((a) => a.isKey).length
  check('live: frames wait for the decoder up to 150, never more (but for the keyframes that come after)', r.maxQueue >= 150 && r.maxQueue <= 150 + keys, `queue ${r.maxQueue}, ${keys} keyframes`)
}

// ---- only live uses it; the list of frames in the decoder is emptied on a restart ----
{
  let player = null
  let over = -Infinity // how many more frames the player lists as in the decoder than the decoder holds
  const patch = (p) => {
    player = p
    const push = p.push.bind(p)
    p.push = (chunk) => {
      const out = push(chunk)
      if (p.decoder) over = Math.max(over, p.fed.length - p.decoder.pending.length - (p.decoder.busy ? 1 : 0))
      return out
    }
  }
  await run(hiccup({ fps: 30, hiccupMs: 700, durMs: 12_000 }), { fps: 30, clock: { startDelayMs: 800 }, decoder: MAIN_1440, live: true, patch })
  check('live: the frames listed as in the decoder are the ones it holds (none left behind)', over === 0, `${over}`)
  check('  ... and forgotten when the player is reset (a reconnect) or closed', Array.isArray(player?.fed) && player.fed.length === 0, `${player?.fed?.length}`)
  const src = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8')
  check('playback and the wall make their players without it (the clock as before)', !/arrivalClock/.test(src('playback.js')) && !/arrivalClock/.test(src('wall.js')))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
