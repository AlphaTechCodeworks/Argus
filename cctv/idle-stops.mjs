// Stops of streams nobody wants any more, per NVR, one at a time and spaced out (live.mjs).
//
// Leaving a site used to stop all of its sub-streams together about 3 minutes later, when their
// linger ran out: 7-16 StopLivePlay calls within about 2 seconds. Twice such a burst was followed by
// the worker aborting inside the SDK (02:29:47 nvr1 'double free or corruption', 03:15:04 nvr-2),
// although the stops already ran one after another. So these stops wait in a queue per NVR:
//   - each starts at least IDLE_STOP_GAP_MS after the previous one has returned;
//   - none starts while another live call (LivePlay, StopLivePlay) of that NVR is inside the SDK;
//   - a stream that is wanted again meanwhile just carries on playing: its stop is dropped.
// Stops that are part of a restart (a stall, no first frame) never wait here: that stream is wanted,
// and every second it waits is a second with no picture and no recording.
//
// Pure apart from the clock and the timers it is given (tests: fakes).
export const IDLE_STOP_GAP_MS = 1000

/**
 * One NVR's queue of idle stops. A stream is anything with `stopped`, `clients` (a Set) and `stop()`
 * (a promise that settles once the SDK has stopped it, or gave up).
 * @param {{ gapMs?: number, busy?: () => boolean, now?: () => number, setTimer?: Function,
 *   clearTimer?: Function, recheckMs?: number }} [deps] busy: a live call of this NVR is inside the SDK
 */
export function idleStopQueue({ gapMs = IDLE_STOP_GAP_MS, busy = () => false, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, recheckMs = 250 } = {}) {
  const queue = []
  let running = false
  let lastEnd = -Infinity // when the previous idle stop returned
  let timer = null
  const idle = (s) => !s.stopped && s.clients.size === 0

  const later = (ms) => {
    timer = setTimer(pump, ms)
    timer?.unref?.()
  }

  function pump() {
    if (timer !== null) clearTimer(timer)
    timer = null
    if (running) return
    while (queue.length && !idle(queue[0])) queue.shift() // wanted again, or stopped some other way
    if (!queue.length) return
    const wait = lastEnd + gapMs - now()
    if (wait > 0) return later(wait)
    // (a returning call also wakes this: live.mjs kicks it from sdk.mjs onCallSettled)
    if (busy()) return later(recheckMs)
    const s = queue.shift()
    running = true
    Promise.resolve()
      .then(() => s.stop())
      .catch(() => {})
      .finally(() => {
        running = false
        lastEnd = now()
        pump()
      })
  }

  return {
    /** Queues the stop of a stream nobody wants (once; its place is kept if it is already queued). */
    add(s) {
      if (!queue.includes(s)) queue.push(s)
      pump()
    },
    /** The stream is wanted again (or is being stopped some other way): no idle stop for it. */
    cancel(s) {
      const i = queue.indexOf(s)
      if (i >= 0) queue.splice(i, 1)
    },
    has: (s) => queue.includes(s),
    kick: () => pump(),
    get size() {
      return queue.length
    }
  }
}
