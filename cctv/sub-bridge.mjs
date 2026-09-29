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
//
// A remote viewer (through the tunnel) gets the main stream's KEYFRAMES only, each only while its
// page keeps up: less than RESUME_BELOW queued on its socket, for a /live-mux channel the whole
// page's queue, which every tile waits behind. On 29 Sep a remote page's stand-ins were whole main
// streams -- nvr-2/10 at 5.18 Mbit/s, /17 at 3.99, /21 at 2.25, each GOP so far (up to 1.3 MB)
// replayed at once by the worker -- for 9-27 s into a 3.5-6.5 Mbit/s tunnel, and no level thins a
// stand-in (stutter report 2.6, verify-6). Keyframes alone are still about half of such a main (634
// KB of /10's 1279 KB GOP every 2 s: 2.6 Mbit/s): under the gate's cap (4 MB of the stand-in's own)
// they still backed that page up 4.9 MB, its tiles 7.2 s behind, in a replay of it (t8 scratch). A
// keyframe that waits for the page's queue takes only the room the page leaves: that page replayed
// over 5 Mbit/s (live-mux-server.test.mjs), 0.98 MB queued at most and no tile's frame 1.3 s behind,
// against 4.58 MB and 7 s with every frame. A held tile stays a picture that moves on at every
// keyframe while its page has room (a main like /21's on a page of 15 sub-streams: one every 2.45 s)
// instead of going black (value4u holds 14-16 sub-streams for minutes; verify-6: with no stand-in
// they would show a still that long). Several stand-ins on a full link take turns as its room
// comes, by where their keyframes fall: in that replay /17's kept coming just after /10's had taken
// it, and its first picture waited 10 s, for its own sub-stream. Once the sub-stream runs, nothing
// more: its keyframe, which a fan-out holds back while this socket still has the last one queued,
// is next (with every frame, /17's stand-in outlived its sub-stream's start by 22 s there). A local
// viewer's stand-in is the main stream as it is, as before.
import { CAP_BYTES, RESUME_BELOW, gateSend } from './backpressure.mjs'

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
 * @param {object} ws the viewer's socket (ws: send, readyState, OPEN, bufferedAmount, on; a /live-mux
 *   channel has sharedBufferedAmount too, its page's whole queue)
 * @param {{ sub: { gop: any[] }, main: { gop: any[], add: Function, remove: Function }, clientH265: boolean,
 *   remote?: boolean, cap?: number, log?: (line: string, why?: string) => void, now?: () => number }} o
 *   remote: the viewer is through the tunnel (live-attach.mjs): the main stream's keyframes only, each
 *   while its page keeps up (see above); log: live-attach.mjs puts the camera and the viewer (remote
 *   or local) in front of each line; an end line has why it ended as well ('sub', 'closed', 'h265'),
 *   which it uses to say the H.265 one less often
 * @returns {{ end: () => void, active: () => boolean } | null} null when there is nothing to bridge
 */
export function bridgeSub(ws, { sub, main, clientH265, remote = false, cap = CAP_BYTES[0], log = () => {}, now = Date.now }) {
  // the sub-stream is running: its own picture goes at once
  if (!main || sub.gop.length > 0) return null
  const realSend = ws.send.bind(ws)
  const startedAt = now()
  let on = true
  let sent = 0
  let bytes = 0
  let heldBack = 0 // frames its own gate kept off a link that had too much queued (remote: keyframes its page had no room for)
  const what = remote ? 'keyframe' : 'frame'
  // a remote viewer's page keeps up: less than RESUME_BELOW queued on its socket (a /live-mux channel:
  // the page's whole queue, every tile's), and its sub-stream not running yet
  const room = () => ws.readyState === (ws.OPEN ?? 1) && (ws.sharedBufferedAmount ?? ws.bufferedAmount ?? 0) < RESUME_BELOW && !(sub.gop.length > 0)
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
    else log(`${after} (${ENDED[why]}): ${sent} ${what}${sent === 1 ? '' : 's'}, ${(bytes / 1e6).toFixed(2)} MB sent, ${heldBack} held back`, why)
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
      const isKey = (buf[0] & 1) === 1
      // a remote viewer: nothing between keyframes (the worker's replay of the GOP so far included)
      if (remote && !isKey) return
      if (remote ? room() : gateSend(gate, isKey, { cap })) {
        if (!sent) log(`stand-in started: the main stream${remote ? '\'s keyframes' : ''} until the sub-stream's first frame`)
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
