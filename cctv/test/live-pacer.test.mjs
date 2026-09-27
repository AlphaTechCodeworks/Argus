// The live pacer (live-pacer.mjs): viewers' starts per NVR at most 2 at a time (1 on a slow NVR),
// spaced by the last LivePlay's duration (250 ms to 10 s), at most 40 a minute, none while a call is
// late or for 60 s after a link reset; viewers before warm-ups; a waiting start never fails.
// Pure, with a fake clock: no SDK, no NVR.
//   node cctv/test/live-pacer.test.mjs
import { PACE, livePacer } from '../live-pacer.mjs'

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

/** A fake clock with timers that run only when advanced. */
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

/** A pacer over a fake clock; starts() gives each admitted start as { name, at, release }. */
const setup = (deps = {}) => {
  const clock = fakeClock()
  const state = { inFlight: 0, late: 0, lateAt: 0 }
  const pacer = livePacer({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, liveInFlight: () => state.inFlight, lateNow: () => state.late, lateAt: () => state.lateAt, ...deps })
  const got = []
  const start = (name, o = {}) =>
    pacer.wait(o).then((release) => {
      got.push({ name, at: clock.now(), release })
    })
  return { clock, state, pacer, got, start }
}
const names = (got) => got.map((g) => g.name).join(',')

{
  // a fast NVR: two at a time, 250 ms apart
  const { clock, pacer, got, start } = setup()
  for (let i = 0; i < 5; i++) start(`v${i}`)
  await flush()
  check('fast: the first start goes at once', names(got) === 'v0' && got[0].at === 0, names(got))
  await clock.advance(250)
  check('fast: a second one 250 ms later (2 at a time)', names(got) === 'v0,v1' && got[1].at === 250, names(got))
  await clock.advance(5000)
  check('fast: no third while two are still starting', got.length === 2 && pacer.waiting === 3, `${got.length} started, ${pacer.waiting} waiting`)
  got[0].release()
  await flush()
  check('fast: one over, the next goes at once', got.length === 3 && got[2].at === 5250, got.map((g) => g.at).join())
  got[1].release()
  got[1].release() // (twice: counted once)
  await flush()
  check('fast: ... but never closer than 250 ms to the one before', got.length === 3, String(got.length))
  await clock.advance(250)
  check('fast: ... then the next', got.length === 4 && got[3].at === 5500, got.map((g) => g.at).join())
  check('fast: the pacer counts its own starts in progress', pacer.active === 2, String(pacer.active))
}
{
  // a slow NVR (its last LivePlay took over 3 s): one at a time, spaced by that duration
  const { clock, pacer, got, start } = setup()
  pacer.played(4000)
  for (let i = 0; i < 3; i++) start(`s${i}`)
  await flush()
  check('slow: the first start goes', got.length === 1)
  await clock.advance(20_000)
  check('slow: one live call at a time', got.length === 1, String(got.length))
  got[0].release()
  await flush()
  check('slow: the next goes once the first is over (4 s gap long passed)', got.length === 2 && got[1].at === 20_000, got.map((g) => g.at).join())
  got[1].release()
  await clock.advance(3999)
  check("slow: the gap is the last LivePlay's duration (not yet at 3.999 s)", got.length === 2, String(got.length))
  await clock.advance(1)
  check('slow: ... and it goes at 4 s', got.length === 3 && got[2].at === 24_000, got.map((g) => g.at).join())
}
{
  // a call came back late in the last 10 minutes: slow too (one at a time), though LivePlays are quick
  const { clock, state, got, start } = setup()
  await clock.advance(60_000)
  state.lateAt = 30_000
  start('a')
  start('b')
  await clock.advance(1000)
  check('late in the last 10 min: one at a time', got.length === 1, String(got.length))
  got[0].release()
  await clock.advance(10 * 60_000)
  check('... one at a time until 10 minutes after the late return', got.length === 2)
  got[1].release()
  start('c')
  start('d')
  await clock.advance(300)
  check('10 minutes after the late return: two at a time again', got.length === 4, String(got.length))
}
{
  // the gap follows the last LivePlay's duration, between 250 ms and 10 s
  const gapOf = async (playMs) => {
    const { clock, pacer, got, start } = setup()
    pacer.played(playMs)
    start('a')
    start('b')
    await flush()
    got[0]?.release()
    for (let t = 0; t < 30_000 && got.length < 2; t += 50) await clock.advance(50)
    return got[1] ? got[1].at - got[0].at : null
  }
  const [g1, g2, g3] = [await gapOf(50), await gapOf(1500), await gapOf(25_000)]
  check('gap: 250 ms after a quick LivePlay', g1 === 250, String(g1))
  check("gap: the last LivePlay's duration (1.5 s)", g2 === 1500, String(g2))
  check('gap: never over 10 s', g3 === 10_000, String(g3))
}
{
  // at most 40 starts a minute
  const { clock, got, start } = setup()
  for (let i = 0; i < 45; i++) start(`v${i}`)
  for (let t = 0; t < 70_000; t += 50) {
    for (const g of got) g.release() // each LivePlay over at once
    await clock.advance(50)
  }
  const inFirstMinute = got.filter((g) => g.at < 60_000).length
  check('at most 40 starts in a minute', inFirstMinute === PACE.PER_MINUTE && PACE.PER_MINUTE === 40, String(inFirstMinute))
  check('the 41st goes a minute after the first', got[40]?.at === 60_000, String(got[40]?.at))
}
{
  // holds: a late call, live calls already in the SDK, a link reset
  const { clock, state, pacer, got, start } = setup()
  state.late = 1
  start('a')
  await clock.advance(30_000)
  check('hold: nothing while a call of the NVR is late', got.length === 0)
  state.late = 0
  pacer.kick() // (a call returning: sdk.mjs onCallSettled)
  await flush()
  check('... and it goes as soon as that call is back', got.length === 1)
  got[0].release()
  state.inFlight = 2 // e.g. the recorder's LivePlay and a stop inside the SDK
  start('b')
  await clock.advance(5000)
  check('hold: nothing while 2 live calls of the NVR are inside the SDK', got.length === 1)
  state.inFlight = 1
  pacer.kick()
  await flush()
  check('... one returns: it goes', got.length === 2)
  got[1].release()
  state.inFlight = 0
  pacer.linkReset()
  const resetAt = clock.now()
  start('c')
  await clock.advance(PACE.RESET_HOLD_MS - 1000)
  check(`hold: nothing for ${PACE.RESET_HOLD_MS / 1000} s after a link reset (the SDK's own reconnect)`, got.length === 2)
  await clock.advance(1000)
  check('... then it goes', got.length === 3 && got[2].at === resetAt + PACE.RESET_HOLD_MS, String(got[2]?.at - resetAt))
}
{
  // a viewer's start goes before a warm-up's queued earlier; a start that is not paced any more leaves at once
  const { clock, pacer, got, start } = setup()
  start('first')
  await flush()
  let viewerCame = false
  start('warm-1', { rank: () => 2 })
  start('warm-2', { rank: () => (viewerCame ? 1 : 2) })
  start('viewer', { rank: () => 1 })
  viewerCame = true // a viewer opened warm-2's camera after it was queued
  let stopped = false
  start('stopped', { rank: () => 1, cancelled: () => stopped })
  let recorded = false
  start('recorder came', { rank: () => 2, bypass: () => recorded })
  stopped = true
  recorded = true
  pacer.kick() // (live.mjs: LiveStream.stop() and add() kick the pacer)
  await clock.advance(1)
  check('cancelled and bypassing starts leave the queue at once, taking no slot', names(got) === 'first,stopped,recorder came', names(got))
  got[0].release()
  for (let t = 0; t < 3000; t += 50) {
    for (const g of got) g.release()
    await clock.advance(50)
  }
  check('viewers first (in their order), then warm-ups', names(got) === 'first,stopped,recorder came,warm-2,viewer,warm-1', names(got))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
