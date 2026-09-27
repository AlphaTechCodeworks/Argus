// A grid tile asks for a camera's sub-stream. When that stream is not running yet, the tile is sent
// the camera's MAIN stream meanwhile -- already running for recording on almost every camera, so its
// picture goes at once -- and the sub-stream's own first frame ends it.
//
// Measured through the public link, 2026-09-27: starting a cold sub-stream took 1.9 s (nvr-2) and
// 2.0 s (value4u) at the median, up to 5.8 s, while the main stream showed in 0.75-1.07 s; and value4u
// refuses the sub-streams of cameras 19-29 outright, so those tiles never showed anything. Their main
// streams run at 3-6 fps and 0.2-0.3 Mbit/s: about what a sub-stream costs.
//
// Everything after the hand-over is the normal path, untouched: the viewer's socket still waits for
// the sub-stream's keyframe (ws.waitForKey), and the tile's decoder sets itself up again for the
// sub-stream's picture size at that keyframe (player.js). The main stream is only a stand-in, so it
// gets its own backpressure gate: its keyframe waits never hold back the sub-stream's.
import { CAP_BYTES, gateSend } from './backpressure.mjs'

export const CODEC_H265 = 1 // sdk.mjs frame header byte 1 (transcode.mjs CODEC_H265)

/**
 * Sends `main` to `ws` until the first frame of the viewer's own stream is sent to it.
 * @param {object} ws the viewer's socket (ws: send, readyState, OPEN, bufferedAmount, on)
 * @param {{ sub: { gop: any[] }, main: { gop: any[], add: Function, remove: Function }, clientH265: boolean,
 *   cap?: number, log?: (line: string) => void }} o
 * @returns {{ end: () => void, active: () => boolean } | null} null when there is nothing to bridge
 */
export function bridgeSub(ws, { sub, main, clientH265, cap = CAP_BYTES[0], log = () => {} }) {
  // the sub-stream is running: its own picture goes at once
  if (!main || sub.gop.length > 0) return null
  const realSend = ws.send.bind(ws)
  let on = true
  let sent = 0
  // the stand-in's own gate: its waits and over-cap state never touch the viewer's (ws.waitForKey)
  const gate = {
    get readyState() { return ws.readyState },
    OPEN: ws.OPEN ?? 1,
    get bufferedAmount() { return ws.bufferedAmount ?? 0 },
    waitForKey: true,
    overSince: null,
    terminate: () => ws.terminate?.()
  }
  const end = () => {
    if (!on) return
    on = false
    // (ws.send is left wrapped, passing straight through from now on: other layers wrap it after
    // us -- adaptive-live.mjs counts the bytes it sends -- and putting ours back would drop theirs)
    main.remove(tap)
    if (sent) log(`${sent} frames of the main stream shown until the sub-stream came`)
  }
  const tap = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    background: true, // only a stand-in: the worker may start it behind real viewers
    send: (buf) => {
      if (!on || !(buf?.length > 16)) return
      // a browser that cannot play H.265 gets nothing from here (it waits for its own stream)
      if (buf[1] === CODEC_H265 && !clientH265) return end()
      if (gateSend(gate, (buf[0] & 1) === 1, { cap })) {
        sent++
        realSend(buf)
      }
    }
  }
  // the first frame of the viewer's own stream (a keyframe: it waits for one) ends the stand-in
  ws.send = (...args) => {
    end()
    return realSend(...args)
  }
  ws.on?.('close', end)
  main.add(tap) // replays the main stream's current GOP into the tap, keyframe first
  return { end, active: () => on }
}
