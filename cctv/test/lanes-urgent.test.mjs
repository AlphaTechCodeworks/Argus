// Lanes: within a priority, the recorder's starts go first, then the ones a viewer is waiting for
// (even when the viewer arrived after the start was queued as background work), then background
// work (warm-ups), first come first served within each; stops (HIGH) go before all of them. In a
// worker, holdAt 1 holds new work once one call of the NVR is late. Needs the SDK module (Linux):
//   node cctv/test/lanes-urgent.test.mjs
import { Lane, PRIORITY, RANK } from '../lanes.mjs'
import { sdkCallT } from '../sdk.mjs'

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
{
  const order = []
  let release
  const gate = new Promise((r) => (release = r))
  const lane = new Lane('test-urgent', 1)
  lane.run(() => gate) // occupies the one slot
  const job = (name) => () => order.push(name)
  const watched = { now: false }
  const done = [
    lane.run(job('warm-1'), { rank: () => RANK.BACKGROUND }),
    lane.run(job('rec-1'), { rank: () => RANK.RECORDER }),
    lane.run(job('viewer-late'), { rank: () => (watched.now ? RANK.VIEWER : RANK.BACKGROUND) }),
    lane.run(job('rec-2'), { rank: () => RANK.RECORDER }),
    lane.run(job('stop'), { priority: PRIORITY.HIGH }),
    lane.run(job('viewer'), { rank: () => RANK.VIEWER }),
    lane.run(job('other')), // no rank: background work
    lane.run(job('rec-3'), { rank: () => RANK.RECORDER })
  ]
  watched.now = true // a viewer opened that camera after its start was queued
  release()
  await Promise.all(done)
  check('stops first, then the recorder, then the watched cameras, then background work', JSON.stringify(order) === JSON.stringify(['stop', 'rec-1', 'rec-2', 'rec-3', 'viewer-late', 'viewer', 'warm-1', 'other']), order.join(','))
}
{
  // holdAt: an NVR worker's lane holds new work (stops excepted) once ONE call of its NVR is late
  const late = (nvr) => sdkCallT({ nvr, tag: 'late one', timeoutMs: 30 }, { async: (...a) => setTimeout(() => a.at(-1)(null, 1), 400) }).catch(() => {})
  const ran = []
  const one = new Lane('hold-1', 2, { holdAt: 1 })
  const two = new Lane('hold-2', 2)
  late('hold-1')
  late('hold-2')
  await new Promise((r) => setTimeout(r, 80)) // both late now, still inside the "SDK"
  const p = [one.run(() => ran.push('one')), two.run(() => ran.push('two')), one.run(() => ran.push('one-stop'), { priority: PRIORITY.HIGH })]
  await new Promise((r) => setTimeout(r, 50))
  check('holdAt 1: held while one call of the NVR is late (a stop still goes)', !ran.includes('one') && ran.includes('one-stop'), ran.join(','))
  check('default (holdAt = concurrency 2): one late call does not hold it', ran.includes('two'), ran.join(','))
  await Promise.all(p)
  check('... and it goes once that call has returned', ran.includes('one'), ran.join(','))
}
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
