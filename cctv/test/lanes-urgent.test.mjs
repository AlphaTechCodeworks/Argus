// Lanes: a job someone is waiting for (urgent) starts ahead of queued background jobs, even when
// the viewer arrived after it was queued; stops (HIGH) still go first. Needs the SDK module (Linux):
//   node cctv/test/lanes-urgent.test.mjs
import { Lane, PRIORITY } from '../lanes.mjs'

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const order = []
let release
const gate = new Promise((r) => (release = r))
const lane = new Lane('test-urgent', 1)
lane.run(() => gate) // occupies the one slot
const job = (name) => () => order.push(name)
const watched = { now: false }
const done = [
  lane.run(job('rec-1')),
  lane.run(job('rec-2')),
  lane.run(job('viewer-late'), { urgent: () => watched.now }),
  lane.run(job('rec-3')),
  lane.run(job('stop'), { priority: PRIORITY.HIGH }),
  lane.run(job('viewer'), { urgent: () => true })
]
watched.now = true // a viewer opened that camera after its start was queued
release()
await Promise.all(done)
check('stops first, then the watched cameras, then the recorder in order', JSON.stringify(order) === JSON.stringify(['stop', 'viewer-late', 'viewer', 'rec-1', 'rec-2', 'rec-3']), order.join(','))
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
