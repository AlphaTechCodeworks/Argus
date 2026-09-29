// A grid tile asks for a camera's sub-stream. When that stream is not running yet, the tile is sent
// the camera's MAIN stream meanwhile -- already running for recording on almost every camera, so its
// picture goes at once -- and the sub-stream's own first frame ends it.
//
// Measured through the public link, 2026-09-27: starting a cold sub-stream took 1.9 s (nvr-2) and
// 2.0 s (value4u) at the median, up to 5.8 s, while the main stream showed in 0.75-1.07 s; and value4u
// refuses the sub-streams of cameras 19-29 outright, so those tiles never showed anything.
//
// value4u plays only 15 sub-streams at once (sub-cap.mjs). Beyond that its NVR worker holds a
// viewer's sub-stream back until there is room (nvr-worker.mjs), and the tile gets the main stream
// here the same way meanwhile -- for as long as it waits. Those mains are heavier (1-5 Mbit/s, most
// of them H.265): a phone that cannot play H.265 is given the main as converted for phones, shared
// with full-size views (live-attach.mjs, phone-live.mjs), rather than nothing.
//
// Everything after the hand-over is the normal path, untouched: the viewer's socket still waits for
// the sub-stream's keyframe (ws.waitForKey), and the tile's decoder sets itself up again for the
// sub-stream's picture size at that keyframe (player.js). The main stream is only a stand-in, so it
// gets its own backpressure gate: its keyframe waits never hold back the sub-stream's.
import { CAP_BYTES, gateSend } from './backpressure.mjs'

export const CODEC_H265 = 1 // sdk.mjs frame header byte 1 (transcode.mjs CODEC_H265)

// Why a stand-in ended, as its log line says it
const ENDED = { sub: 'the sub-stream came', closed: 'the tile closed', h265: 'the main stream is H.265, which this browser cannot play' }

/**
 * Sends `main` to `ws` until the first frame of the viewer's own stream is sent to it.
 * Logs one line when it starts sending and one when it ends, with what it sent: a stand-in is a main
 * stream on the viewer's link, 2-5 Mbit/s and up to 1.5 MB of replay at once, and on 29 Sep nothing
 * said which remote tiles had one or for how long (stutter report 2.6, verify-6). One that never
 * sends a frame is one line, at its end: an H.265 main for a browser without H.265 ends at once, and
 * its tile, with no picture, asks again every 8-16 s (review of 29 Sep: 14-16 held tiles on value4u,
 * about two lines a second while the page was open).
 * @param {object} ws the viewer's socket (ws: send, readyState, OPEN, bufferedAmount, on)
 * @param {{ sub: { gop: any[] }, main: { gop: any[], add: Function, remove: Function }, clientH265: boolean,
 *   cap?: number, log?: (line: string, why?: string) => void, now?: () => number }} o
 *   log: live-attach.mjs puts the camera and the viewer (remote or local) in front of each line; an
 *   end line has why it ended as well ('sub', 'closed', 'h265'), which it uses to say the H.265 one
 *   less often
 * @returns {{ end: () => void, active: () => boolean } | null} null when there is nothing to bridge
 */
export function bridgeSub(ws, { sub, main, clientH265, cap = CAP_BYTES[0], log = () => {}, now = Date.now }) {
  // the sub-stream is running: its own picture goes at once
  if (!main || sub.gop.length > 0) return null
  const realSend = ws.send.bind(ws)
  const startedAt = now()
  let on = true
  let sent = 0
  let bytes = 0
  let heldBack = 0 // frames its own gate kept off a link that had too much queued
  // the stand-in's own gate: its waits and over-cap state never touch the viewer's (ws.waitForKey)
  const gate = {
    get readyState() { return ws.readyState },
    OPEN: ws.OPEN ?? 1,
    get bufferedAmount() { return ws.bufferedAmount ?? 0 },
    waitForKey: true,
    overSince: null,
    terminate: () => ws.terminate?.()
  }
  const end = (why) => {
    if (!on) return
    on = false
    // (ws.send is left wrapped, passing straight through from now on: other layers wrap it after
    // us -- adaptive-live.mjs counts the bytes it sends -- and putting ours back would drop theirs)
    main.remove(tap)
    const after = `stand-in ended after ${((now() - startedAt) / 1000).toFixed(1)} s`
    if (!sent) log(`${after}, having sent nothing (${ENDED[why]})${heldBack ? `: ${heldBack} held back` : ''}`, why)
    else log(`${after} (${ENDED[why]}): ${sent} frame${sent === 1 ? '' : 's'}, ${(bytes / 1e6).toFixed(2)} MB sent, ${heldBack} held back`, why)
  }
  const tap = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    background: true, // only a stand-in: the worker may start it behind real viewers
    send: (buf) => {
      if (!on || !(buf?.length > 16)) return
      // a browser that cannot play H.265 gets nothing from here (it waits for its own stream)
      if (buf[1] === CODEC_H265 && !clientH265) return end('h265')
      if (gateSend(gate, (buf[0] & 1) === 1, { cap })) {
        if (!sent) log('stand-in started: the main stream until the sub-stream\'s first frame')
        sent++
        bytes += buf.length
        realSend(buf)
      } else heldBack++
    }
  }
  // the first frame of the viewer's own stream (a keyframe: it waits for one) ends the stand-in
  ws.send = (...args) => {
    end('sub')
    return realSend(...args)
  }
  ws.on?.('close', () => end('closed'))
  main.add(tap) // replays the main stream's current GOP into the tap, keyframe first
  return { end, active: () => on }
}
