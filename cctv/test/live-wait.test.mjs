// Wait notices (live-wait.mjs): what a viewer without Live HD is told while its sub-stream has no
// picture yet, instead of being shown the main stream meanwhile. Fake socket and timers; pure.
//   node cctv/test/live-wait.test.mjs
import { SD_UNAVAILABLE_MS, WAIT_NOTICE_MS, waitForSub, waitWhy } from '../live-wait.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const fakeTimers = () => {
  const list = []
  return { list, every: (fn, ms) => { const t = { fn, ms, cleared: false }; list.push(t); return t }, clear: (t) => { t.cleared = true } }
}

check('why: held beats everything', waitWhy({ held: true, waitedMs: 99_999 }) === 'held')
check('why: starting, then unavailable after 15 s', waitWhy({ held: false, waitedMs: SD_UNAVAILABLE_MS - 1 }) === 'starting' && waitWhy({ held: false, waitedMs: SD_UNAVAILABLE_MS }) === 'unavailable' && SD_UNAVAILABLE_MS === 15_000)
check('every 4 s: under the tile\'s 8 s stall watchdog', WAIT_NOTICE_MS === 4000)
{
  let t = 0
  const timers = fakeTimers()
  const ws = { OPEN: 1, readyState: 1, sent: [], closes: [], send(d) { this.sent.push(d) }, on(e, f) { if (e === 'close') this.closes.push(f) } }
  const stream = { gop: [] }
  let held = false
  waitForSub(ws, { stream, held: () => held, every: timers.every, clear: timers.clear, now: () => t })
  const whys = () => ws.sent.map((d) => JSON.parse(d).why).join()
  check('a /live socket: a JSON object as text, at once', typeof ws.sent[0] === 'string' && ws.sent[0] === '{"op":"wait","why":"starting"}', ws.sent[0])
  check('... and a timer every 4 s', timers.list.length === 1 && timers.list[0].ms === WAIT_NOTICE_MS)
  t = 4000
  timers.list[0].fn()
  held = true
  t = 8000
  timers.list[0].fn()
  held = false
  t = 20_000
  timers.list[0].fn()
  check('each notice says why as it is then', whys() === 'starting,starting,held,unavailable', whys())
  stream.gop.push('keyframe')
  timers.list[0].fn()
  check('the sub-stream\'s first frame stops it', ws.sent.length === 4 && timers.list[0].cleared)
}
{
  const timers = fakeTimers()
  const notes = []
  const ch = { OPEN: 1, readyState: 1, sent: [], closes: [], send(d) { this.sent.push(d) }, notice(m) { notes.push(m) }, on(e, f) { if (e === 'close') this.closes.push(f) } }
  waitForSub(ch, { stream: { gop: [] }, held: () => false, every: timers.every, clear: timers.clear, now: () => 0 })
  check('a mux channel: through notice() (its send carries frames only), never send()', notes.length === 1 && notes[0].op === 'wait' && notes[0].why === 'starting' && ch.sent.length === 0)
  for (const f of ch.closes) f()
  check('closing the socket stops it', timers.list[0].cleared === true)
  ch.readyState = 3
  timers.list[0].fn()
  check('nothing is sent on a closed socket', notes.length === 1)
}
{
  const timers = fakeTimers()
  const ws = { OPEN: 1, readyState: 1, sent: [], send(d) { this.sent.push(d) }, on() {} }
  waitForSub(ws, { stream: { gop: ['keyframe'] }, held: () => false, every: timers.every, clear: timers.clear, now: () => 0 })
  check('a sub-stream already playing: nothing sent, no timer', ws.sent.length === 0 && timers.list.length === 0)
}

{
  // the NVR at its limit, but this sub-stream not held by it (the NVR refused it outright)
  let t = 0
  const timers = fakeTimers()
  const ws = { OPEN: 1, readyState: 1, sent: [], send(d) { this.sent.push(d) }, on() {} }
  waitForSub(ws, { stream: { gop: [] }, held: () => false, full: () => true, every: timers.every, clear: timers.clear, now: () => t })
  t = 4000
  timers.list[0].fn()
  t = 16_000
  timers.list[0].fn()
  const whys = ws.sent.map((d) => JSON.parse(d).why).join()
  check('the NVR full counts as held for the first notice only (value4u refusing 19-29 while others fill its limit)', whys === 'held,starting,unavailable', whys)
}
{
  const timers = fakeTimers()
  const ws = { OPEN: 1, readyState: 1, sent: [], send(d) { this.sent.push(d) }, on() {} }
  waitForSub(ws, { stream: { gop: [] }, held: () => false, since: 0, every: timers.every, clear: timers.clear, now: () => 20_000 })
  check('since: the 15 s counted from when the tile opened (a stand-in that ended later)', JSON.parse(ws.sent[0]).why === 'unavailable')
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
