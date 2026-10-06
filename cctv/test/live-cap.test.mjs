// Tests for the box-wide live-stream cap coordinator (live-cap.mjs). Pure: the settings, the live
// count and the warm-up handle are injected, so no NVR is needed.
//   node cctv/test/live-cap.test.mjs
import { makeLiveCap } from '../live-cap.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

// a warm-up driver with `avail` droppable warm-ups: release(n) frees up to n and records each ask
const fakeWarm = (avail) => ({ asks: [], avail, release(n) { this.asks.push(n); const f = Math.max(0, Math.min(n, this.avail)); this.avail -= f; return f } })
const cfg = (o) => ({ enabled: true, maxStreams: 36, hdHeadroom: 2, ...o })

{
  // off: every method is a pass-through, nothing is counted or dropped
  const warm = fakeWarm(20)
  const cap = makeLiveCap({ settings: () => cfg({ enabled: false }), count: () => 40, warm })
  check('off: not enabled', cap.enabled() === false)
  check('off: warmBudget is Infinity', cap.warmBudget() === Infinity)
  check('off: admitViewer never sheds', cap.admitViewer(true) === 0 && warm.asks.length === 0)
  check('off: admitMain never sheds', cap.admitMain(true) === 0 && warm.asks.length === 0)
}
{
  // on by default, and the warm budget is the cap less the headroom
  check('enabled defaults on', makeLiveCap({ settings: () => ({ maxStreams: 10 }), count: () => 0 }).enabled() === true)
  const cap = makeLiveCap({ settings: () => cfg(), count: () => 0, warm: fakeWarm(0) })
  check('warmBudget = maxStreams - hdHeadroom', cap.warmBudget() === 34)
}
{
  // below the cap: nothing dropped
  const warm = fakeWarm(10)
  const cap = makeLiveCap({ settings: () => cfg(), count: () => 30, warm })
  check('viewer below the cap: no warm-up dropped', cap.admitViewer(true) === 0 && warm.asks.length === 0)
  check('main below the cap: no warm-up dropped', cap.admitMain(true) === 0 && warm.asks.length === 0)
}
{
  // at the cap: one warm-up preempted so the box does not climb past it (viewer > warm-up)
  const warm = fakeWarm(10)
  const cap = makeLiveCap({ settings: () => cfg(), count: () => 36, warm })
  check('viewer at the cap: one warm-up preempted', cap.admitViewer(true) === 1 && warm.asks.at(-1) === 1)
  check('a reused stream (fresh false) sheds nothing', cap.admitViewer(false) === 0)
}
{
  // a full-size main at the cap preempts a warm-up the same way, so it starts rather than fall to sub
  const warm = fakeWarm(10)
  const cap = makeLiveCap({ settings: () => cfg(), count: () => 36, warm })
  check('main at the cap: a warm-up preempted (HD upgrade > warm-up)', cap.admitMain(true) === 1)
  check('an already-wanted main (fresh false) sheds nothing', cap.admitMain(false) === 0)
}
{
  // well over the cap (viewers grew between warm passes): the whole overage is shed
  const warm = fakeWarm(10)
  const cap = makeLiveCap({ settings: () => cfg(), count: () => 40, warm })
  check('over the cap by 4: sheds overage + 1 (the new stream)', cap.admitViewer(true) === 5 && warm.asks.at(-1) === 5) // 40 + 1 - 36
}
{
  // nothing to preempt: the viewer is still admitted by the caller, only fewer slots freed
  const warm = fakeWarm(0)
  const cap = makeLiveCap({ settings: () => cfg(), count: () => 36, warm })
  check('no warm-ups to drop: asked for one, none freed (viewer not blocked here)', cap.admitMain(true) === 0 && warm.asks.at(-1) === 1)
}
{
  // warmRemote reflects the setting (server.mjs uses it to filter remote NVRs from warm-ups)
  check('warmRemote false by default', makeLiveCap({ settings: () => ({}), count: () => 0 }).warmRemote() === false)
  check('warmRemote true when set', makeLiveCap({ settings: () => ({ warmRemote: true }), count: () => 0 }).warmRemote() === true)
}
{
  // attachWarm: a cap built before the warm-up driver exists can still preempt once it is attached
  const warm = fakeWarm(5)
  const cap = makeLiveCap({ settings: () => cfg(), count: () => 36 })
  check('no warm handle yet: sheds nothing', cap.admitViewer(true) === 0)
  cap.attachWarm(warm)
  check('after attachWarm: preempts', cap.admitViewer(true) === 1)
}
{
  // a change to the settings applies at once (they are read fresh on every call)
  let live = cfg({ maxStreams: 36 })
  const warm = fakeWarm(10)
  const cap = makeLiveCap({ settings: () => live, count: () => 30, warm })
  check('at 30 of 36: nothing dropped', cap.admitViewer(true) === 0)
  live = cfg({ maxStreams: 28 }) // the cap is lowered
  check('the lower cap takes effect at once: 30 is now over 28, one dropped', cap.admitViewer(true) === 3) // 30 + 1 - 28
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
