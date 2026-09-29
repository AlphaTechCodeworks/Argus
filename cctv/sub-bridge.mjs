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
// A remote viewer (through the tunnel) gets the main stream's KEYFRAMES only, each only if its page
// has room for it. On 29 Sep a remote page's stand-ins were whole main streams -- nvr-2/10 at 5.18
// Mbit/s, /17 at 3.99, /21 at 2.25, each GOP so far (up to 1.3 MB) replayed at once by the worker --
// for 9-27 s into a 3.5-6.5 Mbit/s tunnel, and no level thins a stand-in (stutter report 2.6,
// verify-6). Keyframes alone are still about half of such a main (634 KB of /10's 1279 KB GOP every 2
// s: 2.6 Mbit/s): under the gate's cap (4 MB of the stand-in's own) they backed that page up 5.06 MB,
// its tiles 7.4 s behind, as badly as every frame (live-mux-server.test.mjs replays both).
//
// The room is what the level controller leaves (adaptive-live.mjs): it steps every tile of a page down
// once what the page has queued -- one FIFO, which every tile waits behind -- takes more than QUEUE_S
// to go at the rate the page's socket drains (live-mux.mjs drainBps), on two looks 2 s apart. A
// keyframe goes only if, with it, the page's queue goes within ROOM_S at that rate. Let through while
// the page had less than RESUME_BELOW queued, /10's keyframes -- 1 s by themselves at 5 Mbit/s, one
// every 2 s like the controller's looks -- stepped the 03:55 page down in 11 of 20 replays of it with
// the controller (review of t8); within ROOM_S, in none (adaptive-live.test.mjs). That page over 5
// Mbit/s: 0.86 MB queued at most, no tile's frame 1.3 s behind, against 4.58 MB and 7 s with every
// frame (live-mux-server.test.mjs). A held tile stays a picture that moves on at every keyframe that
// fits (a main like /21's on a page of 15 sub-streams: one every 2.45 s) instead of going black
// (value4u holds 14-16 sub-streams for minutes; verify-6: with no stand-in they would show a still
// that long). Several that fit take turns as the room comes, by where their keyframes fall.
//
// The cost: a main whose keyframe is more than ROOM_S of the link shows nothing until its own
// sub-stream comes, as with no stand-in -- on 5 Mbit/s /10's and /17's never go (they would need 8.5
// and 6.7 Mbit/s with nothing else queued); on a phone's 1-2 Mbit/s nothing over 75-150 KB goes, so
// its tiles no longer wait 2.5-5 s behind a keyframe like /10's once a GOP. A page whose rate is not
// measured yet (drainBps null: idle, or a burst queued just now; the controller reads no pressure
// there either) takes one while it has less than RESUME_BELOW queued, as at a page's opening: /10's
// tile then held its first picture 8.4 s, until its sub-stream came. A /live socket (the fallback
// when a page cannot use /live-mux) has no rate at all: less than RESUME_BELOW queued, as before.
//
// Once the sub-stream runs, nothing more: its keyframe, which a fan-out holds back while this socket
// still has the last one queued, is next (with every frame, /17's stand-in outlived its sub-stream's
// start by 22 s in that replay). A local viewer's stand-in is the main stream as it is, as before.
import { QUEUE_S } from './adaptive-live.mjs'
import { CAP_BYTES, RESUME_BELOW, gateSend } from './backpressure.mjs'

export const CODEC_H265 = 1 // sdk.mjs frame header byte 1 (transcode.mjs CODEC_H265)

/**
 * A remote viewer's stand-in keyframe goes only if, with it, its page's queue goes within this at the
 * rate the page's socket drains: under the level controller's line (QUEUE_S), with room for that
 * meter's error while half-megabyte keyframes go through it. The 03:55 page, replayed with the level
 * controller at 40 phases of its mains' keyframes on each of 13 links from 4 to 12 Mbit/s (t8 fix
 * round scratch; adaptive-live.test.mjs replays 30 of them): at 0.7 of QUEUE_S it still stepped down
 * in 3 of those 520 replays, at 0.65 and 0.6 in none (at such steps the meter read a 6 Mbit/s link at
 * 5.0, an 8 Mbit/s one at 6.1). 0.6, for a margin.
 */
export const ROOM_S = 0.6 * QUEUE_S

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
 *   channel has sharedBufferedAmount and drainBps too, its page's whole queue and how fast it goes)
 * @param {{ sub: { gop: any[] }, main: { gop: any[], add: Function, remove: Function }, clientH265: boolean,
 *   remote?: boolean, cap?: number, log?: (line: string, why?: string) => void, now?: () => number }} o
 *   remote: the viewer is through the tunnel (live-attach.mjs): the main stream's keyframes only, each
 *   only if its page has room for it (see above); log: live-attach.mjs puts the camera and the viewer
 *   (remote or local) in front of each line; an end line has why it ended as well ('sub', 'closed',
 *   'h265'), which it uses to say the H.265 one less often
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
  let leftOut = 0 // remote: keyframes not sent once the sub-stream ran (its own keyframe is next: no congestion)
  const what = remote ? 'keyframe' : 'frame'
  // a remote viewer's page has room for a keyframe of `size` bytes: its whole queue, every tile's, goes
  // within ROOM_S with it at the rate its socket drains; a rate not measured yet (live-mux.mjs drainBps
  // null: idle, or a burst queued just now), or a /live socket, which has none: less than RESUME_BELOW
  // queued
  const room = (size) => {
    if (ws.readyState !== (ws.OPEN ?? 1)) return false
    const queued = ws.sharedBufferedAmount ?? ws.bufferedAmount ?? 0
    const bps = ws.drainBps
    return bps == null ? queued < RESUME_BELOW : queued + size <= bps * ROOM_S
  }
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
    const late = leftOut ? `, ${leftOut} left out once the sub-stream ran` : ''
    if (!sent) log(`${after}, having sent nothing (${ENDED[why]})${heldBack || leftOut ? `: ${heldBack} held back${late}` : ''}`, why)
    else log(`${after} (${ENDED[why]}): ${sent} ${what}${sent === 1 ? '' : 's'}, ${(bytes / 1e6).toFixed(2)} MB sent, ${heldBack} held back${late}`, why)
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
      // a remote viewer: nothing between keyframes (the worker's replay of the GOP so far included),
      // and nothing once its sub-stream runs
      if (remote && !isKey) return
      if (remote && sub.gop.length > 0) {
        leftOut++
        return
      }
      if (remote ? room(buf.length) : gateSend(gate, isKey, { cap })) {
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
