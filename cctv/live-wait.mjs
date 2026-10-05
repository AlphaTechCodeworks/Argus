// A viewer without Live HD whose sub-stream has no picture yet (cold, held at the NVR's sub-stream
// limit, or never sent by the NVR) is not shown the main stream meanwhile (live-attach.mjs): the
// stand-in is main-stream pictures, a full-resolution keyframe even when it lasts two seconds. Its
// tile would then show nothing, for minutes at the NVR's limit, and its stall watchdog
// (live-tile.js, 8 s) would drop and reopen it over and over. So it is told why it waits, at once
// and every WAIT_NOTICE_MS until the sub-stream's first frame or the socket closes: a JSON object as
// text, {"op":"wait","why":W} on a /live socket, {"op":"wait","id":N,"why":W} on a /live-mux
// channel (MuxChannel.notice: a channel's send carries frames only). W is 'held' (the NVR holds this
// sub-stream back at its limit, nvrs.mjs subHeld), 'starting', or 'unavailable' (not held, and
// nothing SD_UNAVAILABLE_MS after the tile opened: the NVR does not send this camera's sub-stream, as
// value4u refuses cameras 19-29). Always an object: a pre-release /live tile turns a text into
// new Uint8Array(text), empty for an object (it counts as activity and is dropped) but a zero-filled
// array for a text of digits.
//
// Only for a socket with no stand-in running: on one with a bridge (sub-bridge.mjs) any send ends the
// stand-in. Pure (no SDK); the timers are injectable for the tests.
export const WAIT_NOTICE_MS = 4000
export const SD_UNAVAILABLE_MS = 15_000

/** @returns {'held'|'starting'|'unavailable'} */
export const waitWhy = ({ held, waitedMs }) => (held ? 'held' : waitedMs >= SD_UNAVAILABLE_MS ? 'unavailable' : 'starting')

/**
 * Tells the viewer on `ws` why its sub-stream shows nothing yet, until it does.
 * @param {object} ws the viewer's /live socket or mux channel (send, notice?, readyState, OPEN, on)
 * @param {{ stream: { gop: any[] }, held: () => boolean, full?: () => boolean, everyMs?: number,
 *   every?: typeof setInterval, clear?: typeof clearInterval, now?: () => number, since?: number }} o
 *   stream: the sub-stream it waits for; held: whether the NVR holds this one back at its limit, asked
 *   at each notice; full: whether the NVR is at its limit, which counts as held for the first notice
 *   only (the tile's request is not in the worker's list yet, and will be held); after that a camera
 *   the NVR refuses outright is not called held while other tiles fill the limit; since: when the
 *   tile opened (the 15 s are counted from then)
 * @returns {() => void} stops the notices
 */
export function waitForSub(ws, { stream, held, full = () => false, everyMs = WAIT_NOTICE_MS, every = setInterval, clear = clearInterval, now = Date.now, since = now() }) {
  let timer = null
  let first = true
  const stop = () => {
    if (timer !== null) clear(timer)
    timer = null
  }
  const open = () => ws.readyState === (ws.OPEN ?? 1)
  const say = () => {
    if (!open() || stream.gop?.length > 0) return stop()
    const isHeld = held() === true || (first && full() === true)
    first = false
    const msg = { op: 'wait', why: waitWhy({ held: isHeld, waitedMs: now() - since }) }
    if (typeof ws.notice === 'function') ws.notice(msg)
    else ws.send(JSON.stringify(msg))
  }
  say()
  if (open() && !(stream.gop?.length > 0)) {
    timer = every(say, everyMs)
    timer?.unref?.()
  }
  ws.on?.('close', stop)
  return stop
}
