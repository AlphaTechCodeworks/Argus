// The idle-stop queue (idle-stops.mjs): stops of streams nobody wants go one at a time per NVR, each
// at least 1 s after the previous one returned, never next to another live call of that NVR, and a
// stream wanted again before its turn is not stopped. Pure, with a fake clock: no SDK, no NVR.
// (Real LiveStreams over a fake SDK: live-pacing.test.mjs.)
//   node cctv/test/idle-stops.test.mjs
import { IDLE_STOP_GAP_MS, idleStopQueue } from '../idle-stops.mjs'

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}
const fakeClock = () => {
  let t = 0
  const timers = []
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const h = { at: t + Math.max(0, ms), fn }
      timers.push(h)
      return h
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h)
      if (i >= 0) timers.splice(i, 1)
    },
    async advance(ms) {
      await flush() // (what was started just before runs first)
      const end = t + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift()
        t = next.at
        next.fn()
        await flush()
      }
      t = end
      await flush()
    }
  }
}

const setup = ({ stopMs = 50 } = {}) => {
  const clock = fakeClock()
  const state = { busy: false }
  const calls = [] // { name, at, back }
  const q = idleStopQueue({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, busy: () => state.busy })
  // a stream like LiveStream: its StopLivePlay takes stopMs
  const stream = (name) => ({
    name,
    stopped: false,
    clients: new Set(),
    stop() {
      this.stopped = true
      const call = { name, at: clock.now(), back: null }
      calls.push(call)
      return new Promise((r) =>
        clock.setTimer(() => {
          call.back = clock.now()
          r()
        }, stopMs)
      )
    }
  })
  return { clock, state, calls, q, stream }
}

{
  // 12 streams unwanted at once (a site left, its linger run out)
  const { clock, calls, q, stream } = setup()
  const streams = Array.from({ length: 12 }, (_, i) => stream(`s${i}`))
  for (const s of streams) q.add(s)
  await clock.advance(30_000)
  const apart = calls.slice(1).map((c, i) => c.at - calls[i].back)
  check('12 unwanted streams: 12 stops', calls.length === 12, String(calls.length))
  check('... one at a time, each at least 1 s after the previous one returned', IDLE_STOP_GAP_MS === 1000 && apart.every((ms) => ms >= 1000), apart.join())
  check('... so their StopLivePlay calls are at least 1 s apart', calls.slice(1).every((c, i) => c.at - calls[i].at >= 1000))
  check('... the first at once', calls[0].at === 0)
  check('... and in the order they became idle', calls.map((c) => c.name).join() === streams.map((s) => s.name).join())
}
{
  // a stream wanted again before its turn keeps playing
  const { clock, calls, q, stream } = setup()
  const [a, b, c] = [stream('a'), stream('b'), stream('c')]
  q.add(a)
  q.add(b)
  q.add(c)
  await clock.advance(10)
  b.clients.add({}) // a viewer is back on b (LiveStream.add cancels it)
  q.cancel(b)
  c.clients.add({}) // (and c even without the cancel: it is not idle any more at its turn)
  await clock.advance(10_000)
  check('a re-WANT cancels a queued stop', calls.map((x) => x.name).join() === 'a' && !b.stopped && !c.stopped, calls.map((x) => x.name).join())
  check('... and nothing is left queued', q.size === 0, String(q.size))
  q.add(a)
  await clock.advance(5000)
  check('a stream already stopped is not stopped twice', calls.length === 1)
}
{
  // never next to another live call of the NVR
  const { clock, state, calls, q, stream } = setup()
  state.busy = true
  q.add(stream('x'))
  await clock.advance(5000)
  check('no idle stop while a live call of the NVR is in the SDK', calls.length === 0)
  state.busy = false
  q.kick() // (a call returning: live.mjs from sdk.mjs onCallSettled)
  await flush()
  check('... it goes as soon as that call is back', calls.length === 1 && calls[0].at === 5000, String(calls[0]?.at))
  state.busy = true
  q.add(stream('y'))
  await clock.advance(10_000)
  state.busy = false
  await clock.advance(250) // (or at the next look: every 250 ms)
  check('... or at the next look without a kick', calls.length === 2, String(calls.length))
}
{
  // a stop that hangs holds the ones behind it (they are not piled on)
  const { clock, calls, q, stream } = setup({ stopMs: 20_000 })
  q.add(stream('slow'))
  q.add(stream('next'))
  await clock.advance(15_000)
  check('a slow stop: the next one waits for it', calls.length === 1)
  await clock.advance(6000)
  check('... and goes 1 s after it returned', calls.length === 2 && calls[1].at === 21_000, String(calls[1]?.at))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
