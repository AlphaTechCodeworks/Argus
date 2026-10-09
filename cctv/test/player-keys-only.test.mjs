// A tile shown from its keyframes alone (player.js setKeysOnly; wall-thin.js decides which).
// Replayed through the real player in virtual time (test/live-replay.mjs).
//   node cctv/test/player-keys-only.test.mjs
import { arrivals, play } from './live-replay.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const brief = (r) => JSON.stringify({ shown: r.shownPct, still: r.maxStillMs, lat: r.medLatencyMs, back: r.backwards })
const SLOW = { pool: 6, decodeMs: 50, inFlight: 5 } // 50 ms a frame: too slow for 30 fps
const FAST = { pool: 11, decodeMs: 5, inFlight: 1 }

{
  const arr = arrivals({ fps: 30, durMs: 60_000 }) // a keyframe every 2 s
  const all = await play(arr, { decoder: SLOW, playerOptions: { arrivalClock: true } })
  const keys = await play(arr, { decoder: SLOW, playerOptions: { arrivalClock: true }, patch: (p) => p.setKeysOnly(true) })
  check('every frame through a decoder too slow for it: late, with long still stretches', all.medLatencyMs > 600 && all.maxStillMs >= 1000, brief(all))
  check('keyframes only through the same decoder: one current picture every 2 s, never later than the buffer', keys.shownPct > 1 && keys.shownPct < 3 && keys.maxStillMs <= 2100 && keys.medLatencyMs <= 450 && keys.backwards === 0, brief(keys))
}
{
  // 20 s of keyframes only, then every frame again: it carries on from the next keyframe
  const arr = arrivals({ fps: 30, durMs: 60_000 })
  let n = 0
  let sawKeyAt = null // the first keyframe after the switch back
  let between = 0 // frames between the switch and it
  let leaked = 0 // ... that reached the decoder
  const r = await play(arr, {
    decoder: FAST,
    playerOptions: { arrivalClock: true },
    patch: (p) => {
      p.setKeysOnly(true)
      const push = p.push.bind(p)
      p.push = (chunk) => {
        if (++n === 610) p.setKeysOnly(false) // 20 s in, mid keyframe interval
        const fedBefore = p.decoder?.fed ?? 0
        const out = push(chunk)
        // (the replay's decoder does not model frames leaning on earlier ones, so this is checked
        // here: between the switch and the next keyframe nothing may be handed to the decoder)
        if (n >= 610 && sawKeyAt === null) {
          if (chunk.isKey) sawKeyAt = n
          else {
            between++
            if ((p.decoder?.fed ?? 0) !== fedBefore || p.afterThin !== true) leaked++
          }
        }
        return out
      }
    }
  })
  check('between the switch back and the next keyframe, no frame reaches the decoder', between > 10 && leaked === 0 && sawKeyAt !== null, `${between} frames, ${leaked} reached it`)
  check('back at full rate from the next keyframe: two thirds of the minute at every frame, never a step back, never a corrupt start', r.shownPct > 60 && r.shownPct < 75 && r.backwards === 0 && r.maxStillMs <= 2100, brief(r))
}
{
  const arr = arrivals({ fps: 30, durMs: 30_000 })
  const plain = await play(arr, { decoder: FAST, playerOptions: { arrivalClock: true } })
  check('never asked for: nothing changes', plain.shownPct >= 100, brief(plain))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exitCode = failures ? 1 : 0
