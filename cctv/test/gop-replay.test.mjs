// Tests for the GOP replay to a new viewer (gop-replay.mjs): whole, or just its keyframe past the
// limit, and the limit a socket sets for itself (a /live-mux channel, live-mux.mjs). Pure JS.
// Run:  node cctv/test/gop-replay.test.mjs
import { REPLAY_MAX_BYTES, replayGop } from '../gop-replay.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const viewer = (extra = {}) => ({ got: [], waitForKey: false, send(m) { this.got.push(m) }, ...extra })
const gop = [Buffer.alloc(300_000), Buffer.alloc(100_000), Buffer.alloc(100_000)] // 500 KB, keyframe first

{
  const w = viewer()
  check('nothing to replay: nothing sent', replayGop([], w) === 0 && w.got.length === 0 && w.waitForKey === false)
  check('a GOP under REPLAY_MAX_BYTES goes whole, in order, the frames themselves', replayGop(gop, w) === 3 && w.got.every((m, i) => m === gop[i]) && w.waitForKey === false)
}
{
  const big = [Buffer.alloc(REPLAY_MAX_BYTES), Buffer.alloc(1)]
  const w = viewer()
  check('past REPLAY_MAX_BYTES: just the keyframe, then wait for the next', replayGop(big, w) === 1 && w.got[0] === big[0] && w.waitForKey === true)
}
{
  // a /live-mux channel: what is left of the page's socket
  const w = viewer({ replayMaxBytes: 400_000 })
  check('a socket\'s own replayMaxBytes lowers the limit for it: just the keyframe', replayGop(gop, w) === 1 && w.got[0] === gop[0] && w.waitForKey === true)
  const z = viewer({ replayMaxBytes: 0 })
  check('... 0: still the keyframe (a picture at once)', replayGop(gop, z) === 1 && z.got[0] === gop[0])
  const r = viewer({ replayMaxBytes: 500_000 })
  check('... a GOP that fits it goes whole', replayGop(gop, r) === 3 && r.waitForKey === false)
  const e = viewer({ replayMaxBytes: 0 })
  check('an explicit limit wins over the socket\'s', replayGop(gop, e, 1e9) === 3)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
