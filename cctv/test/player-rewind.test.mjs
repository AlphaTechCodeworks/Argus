// A page through the tunnel never shows a frame older than one it has shown (stutter report 2.5 (c),
// verify-5).
//
// A remote viewer's level change put its tiles on a new stream whose first picture was older than
// what was on screen: a conversion started from the keyframe it held, a running stream replayed its
// GOP. The player showed those frames as they came, and the picture jumped back: 0.8-1.4 s in the
// stutter investigation's replay, 0-2.4 s by where the keyframe fell. adaptive-live.mjs no longer sends
// a moved tile anything older than it had; the player stands behind it for what still comes older (a
// reconnect's replay from the camera's last keyframe, a stream that went out on its own frames while
// it learnt its rate before converting): such a frame is decoded -- the frames after it depend on it --
// but not timed on the playout clock and not shown. The picture holds instead, until the stream is
// past what was shown.
//
// Within REMOTE_NO_REWIND_MS of the newest frame shown: longer ago than that is a camera clock set
// back, not a replay, and is shown as it comes. verify-5: at least 15 s (at -g 50 a level-4 stream
// stepped back up to 13 s; its keyframes are 2 s apart now, the cameras' own 2-4 s).
//
// Local pages keep the player as it was (the stutter report's rule for the local network).
// Replayed through the real player in virtual time (test/live-replay.mjs).
//   node cctv/test/player-rewind.test.mjs
import { readFileSync } from 'node:fs'
import { REMOTE_NO_REWIND_MS } from '../public/player.js'
import { NETS, REMOTE_LIVE, arrivals, fixtureTrace, play, playTile, switchArrivals } from './live-replay.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const brief = (r) => JSON.stringify({ shown: r.shownPct, back: r.maxBackMs, backwards: r.backwards, still: r.maxStillMs, resyncs: r.resyncs, notDecoded: r.notDecoded })

check('REMOTE_NO_REWIND_MS: at least 15 s (verify-5)', REMOTE_NO_REWIND_MS >= 15_000, String(REMOTE_NO_REWIND_MS))
check('... a page through the tunnel\'s players have it (REMOTE_LIVE, as viewer.js gives them)', REMOTE_LIVE.playerOptions.noRewindMs === REMOTE_NO_REWIND_MS)

// ---- a switch onto an older keyframe (the fixture: a new conversion 0.9 s after the change, its keyframe 1.5 s back) ----
{
  const tile = fixtureTrace('switch').tiles[0]
  const local = await playTile(tile)
  const remote = await playTile(tile, REMOTE_LIVE)
  check('the switch fixture, a local page: steps back 1.4 s, as before', local.maxBackMs === 1400, brief(local))
  check('... a page through the tunnel: never steps back; nothing left undecoded', remote.backwards === 0 && remote.maxBackMs === 0 && remote.notDecoded === 0, brief(remote))
  check('... and holds a little longer than a local page did before it jumped back: through the older frames\' arrival too (up to 0.25 s here)', remote.maxStillMs <= local.maxStillMs + 250, `remote ${brief(remote)} local ${brief(local)}`)
}
{
  // where the keyframe falls (verify-5: 0 to a keyframe interval back; the older frames come 4 ms apart
  // behind it), and a join of a running stream (its GOP replayed at once)
  const cases = [
    ['a new conversion, its keyframe 0.3 s back', { gapToKeyMs: 300, startMs: 900, spacing: 4 }],
    ['a new conversion, its keyframe 1.0 s back', { gapToKeyMs: 1000, startMs: 900, spacing: 4 }],
    ['a new conversion, its keyframe 2.5 s back', { gapToKeyMs: 2500, startMs: 900, spacing: 4 }],
    ['a running stream joined, its GOP from 1.5 s back replayed at once', { gapToKeyMs: 1500, startMs: 0, spacing: 0.5 }]
  ]
  for (const [what, o] of cases) {
    const arr = switchArrivals({ fps: 20, ...o })
    let player = null
    const local = await play(arr, { fps: 20, warmMs: 25_000 })
    const remote = await play(arr, { fps: 20, warmMs: 25_000, ...REMOTE_LIVE, patch: (p) => (player = p) })
    check(`${what}: a page through the tunnel never steps back, the older frames decoded and not shown; it holds at most 0.25 s longer than a local page before its jump back`,
      remote.backwards === 0 && remote.notDecoded === 0 && player.stats.older > 0 && remote.maxStillMs <= local.maxStillMs + 250, `remote ${brief(remote)} older ${player?.stats.older}; local ${brief(local)}`)
  }
}

// ---- a reconnect: the tile's player is reset, and the new connection starts at the camera's last keyframe ----
{
  // 20 fps through the tunnel; at 30 s the socket drops, and 0.4 s later the new one replays the GOP from
  // the keyframe at 28 s in one burst, then carries on
  const base = arrivals({ fps: 20, durMs: 60_000, ...NETS.tunnel, seed: 5 })
  const arr = [...base.filter((a) => a.at < 30_000), ...base.filter((a) => a.ts >= 28_000 && a.ts < 30_400).map((a, i) => ({ ...a, at: 30_400 + i })), ...base.filter((a) => a.ts >= 30_400).map((a) => ({ ...a, at: Math.max(a.at, 30_500) }))]
  const reconnect = (p) => {
    const push = p.push.bind(p)
    let done = false
    p.push = (c) => {
      if (!done && c.timestampUs / 1000 - 1_700_000_000_000 === 28_000 && performance.now() >= 30_400) {
        done = true
        p.reset() // live-tile.js: the socket closed
      }
      return push(c)
    }
  }
  const local = await play(arr, { fps: 20, patch: reconnect })
  const remote = await play(arr, { fps: 20, ...REMOTE_LIVE, patch: reconnect })
  check('a reconnect\'s replay from the camera\'s last keyframe (2 s back): a local page steps back, a page through the tunnel holds and carries on', local.backwards >= 1 && remote.backwards === 0 && remote.shownPct > 95, `remote ${brief(remote)}; local ${brief(local)}`)
}

// ---- a camera clock set back ----
const without = { clock: REMOTE_LIVE.clock, playerOptions: { maxQueuedFrames: REMOTE_LIVE.playerOptions.maxQueuedFrames } }
{
  // 20 fps; at 30 s the camera's clock is set back a minute: further back than the window, a new time
  // line, played as without it (as a clock set back always was: a still while the frames queued from
  // before it clear, t2's note -- not this change's)
  const arr = arrivals({ fps: 20, durMs: 60_000, seed: 3 }).map((a) => (a.at >= 30_000 ? { ...a, ts: a.ts - 60_000 } : a))
  const r = await play(arr, { fps: 20, ...REMOTE_LIVE })
  const plain = await play(arr, { fps: 20, ...without })
  check('a camera clock set back a minute (further back than the window): played exactly as without it', brief(r) === brief(plain) && r.counts.shown === plain.counts.shown, `${brief(r)} ${brief(plain)}`)
  // ...set back 3 s, within it: the cost of the window, the picture held until the camera is past
  // where it was, about 3 s
  const near = arrivals({ fps: 20, durMs: 60_000, seed: 3 }).map((a) => (a.at >= 30_000 ? { ...a, ts: a.ts - 3000 } : a))
  const held = await play(near, { fps: 20, ...REMOTE_LIVE })
  check('a camera clock set back 3 s (within the window): held about that long, then played on, never back', held.backwards === 0 && held.maxStillMs >= 2900 && held.maxStillMs <= 3500, brief(held))
}
{
  // a steady stream: nothing held back, as before
  const arr = arrivals({ fps: 25, durMs: 60_000, ...NETS['tunnel+nvr'], seed: 7 })
  let player = null
  const r = await play(arr, { fps: 25, ...REMOTE_LIVE, patch: (p) => (player = p) })
  const plain = await play(arr, { fps: 25, ...without })
  check('a stream that never goes back: played exactly as without it', brief(r) === brief(plain) && player.stats.older === 0, `${brief(r)} ${brief(plain)}`)
}

// ---- who has it ----
{
  const src = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const viewer = src('viewer.js')
  const tileOptions = viewer.match(/\nconst tileOptions = \(cam\) => \(\{[\s\S]*?\n\}\)\n/)?.[0] ?? ''
  check('viewer.js: a page through the tunnel gives its tiles the window, a local page nothing', /\n {2}noRewindMs: REMOTE_PAGE \? REMOTE_NO_REWIND_MS : undefined,?\n/.test(tileOptions) && /import \{[^}]*\bREMOTE_NO_REWIND_MS\b[^}]*\} from '\.\/player\.js'/.test(viewer), tileOptions)
  check('live-tile.js hands it to its player', /\n {6}noRewindMs: opts\.noRewindMs,\n/.test(src('live-tile.js')))
  check('playback and the wall do not (a seek goes back on purpose)', ['playback.js', 'wall.js'].every((f) => !src(f).includes('noRewind')))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
