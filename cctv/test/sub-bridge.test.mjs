// A grid tile's stand-in picture while its sub-stream is not running (sub-bridge.mjs): the main
// stream goes to the viewer until the sub-stream's first frame does, then only the sub-stream.
// Fake streams and sockets; no SDK.
//   node cctv/test/sub-bridge.test.mjs
import { QUEUE_S } from '../adaptive-live.mjs'
import { RESUME_BELOW } from '../backpressure.mjs'
import { ROOM_S, bridgeSub } from '../sub-bridge.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const frame = (tag, key, codec = 0, size = 40) => {
  const b = Buffer.alloc(size)
  b[0] = key ? 1 : 0
  b[1] = codec
  b.write(tag, 20)
  return b
}
const tagOf = (b) => b.toString('utf8', 20, 28).replace(/\0+$/, '')

/** A stream as stream-hub.mjs HubStream has it: add replays the GOP, frames fan out. */
class FakeStream {
  constructor() { this.gop = []; this.clients = new Set() }
  add(c) { this.clients.add(c); for (const m of this.gop) c.send(m) }
  remove(c) { this.clients.delete(c) }
  frame(buf, key) {
    if (key) this.gop = [buf]
    else if (this.gop.length) this.gop.push(buf)
    for (const c of this.clients) c.send(buf)
  }
}
const socket = () => {
  const got = []
  const handlers = {}
  return { got, OPEN: 1, readyState: 1, bufferedAmount: 0, waitForKey: true, send(b) { got.push(tagOf(b)) }, on(ev, fn) { handlers[ev] = fn }, fire(ev) { handlers[ev]?.() } }
}

// the sub-stream is running: nothing to bridge
{
  const sub = new FakeStream()
  sub.gop = [frame('s-k', true)]
  const main = new FakeStream()
  const ws = socket()
  check('a running sub-stream: no stand-in', bridgeSub(ws, { sub, main, clientH265: true }) === null && main.clients.size === 0)
}

// a cold sub-stream: the main stream's picture at once, then its frames, until the sub-stream's keyframe
{
  const sub = new FakeStream()
  const main = new FakeStream()
  main.gop = [frame('m-k1', true), frame('m-d1', false)]
  const ws = socket()
  const b = bridgeSub(ws, { sub, main, clientH265: true })
  check('the main stream\'s current GOP goes at once, keyframe first', ws.got.join() === 'm-k1,m-d1', ws.got.join())
  main.frame(frame('m-d2', false), false)
  check('... and its next frames follow', ws.got.at(-1) === 'm-d2')
  // the normal path now sends the viewer its own stream (sub keyframe)
  ws.send(frame('s-k', true))
  main.frame(frame('m-d3', false), false)
  check('the sub-stream\'s first frame ends it: the main stream stops going', ws.got.join() === 'm-k1,m-d1,m-d2,s-k', ws.got.join())
  check('... and the stand-in has left the main stream', main.clients.size === 0 && !b.active())
  ws.send(frame('s-d', false))
  check('... after which the socket sends as before', ws.got.at(-1) === 's-d')
}

// the NVR refuses the sub-stream: the main stream goes on for as long as the tile is open
{
  const sub = new FakeStream()
  const main = new FakeStream()
  const ws = socket()
  bridgeSub(ws, { sub, main, clientH265: true })
  check('nothing yet (the main stream has no keyframe yet): nothing sent', ws.got.length === 0)
  main.frame(frame('m-d0', false), false)
  check('... a delta before any keyframe is not sent (it could not be decoded)', ws.got.length === 0)
  main.frame(frame('m-k', true), true)
  main.frame(frame('m-d', false), false)
  check('then from the main stream\'s keyframe on', ws.got.join() === 'm-k,m-d', ws.got.join())
  ws.fire('close')
  check('the viewer leaving ends it', main.clients.size === 0)
}

// a browser that cannot play H.265 is not sent an H.265 main stream
{
  const sub = new FakeStream()
  const main = new FakeStream()
  main.gop = [frame('m-k', true, 1)]
  const ws = socket()
  const b = bridgeSub(ws, { sub, main, clientH265: false })
  check('H.265 main, browser without H.265: nothing sent, stand-in ended', ws.got.length === 0 && !b.active() && main.clients.size === 0)
}

// a slow link: the stand-in stops at its cap without touching the viewer's own wait for a keyframe
{
  const sub = new FakeStream()
  const main = new FakeStream()
  const ws = socket()
  bridgeSub(ws, { sub, main, clientH265: true, cap: 1000 })
  main.frame(frame('m-k', true), true)
  ws.bufferedAmount = 5000
  main.frame(frame('m-d', false), false)
  check('over the cap: nothing more sent', ws.got.join() === 'm-k', ws.got.join())
  check('... and the viewer\'s own stream still waits for its keyframe (ws.waitForKey untouched)', ws.waitForKey === true)
  ws.bufferedAmount = 0
  main.frame(frame('m-d2', false), false)
  main.frame(frame('m-k2', true), true)
  check('drained: it resumes at the next keyframe, not with a delta it could not decode', ws.got.join() === 'm-k,m-k2', ws.got.join())
}

// another layer wraps ws.send after the stand-in (adaptive-live.mjs counts bytes): its wrapper stays
{
  const sub = new FakeStream()
  const main = new FakeStream()
  main.gop = [frame('m-k', true)]
  const ws = socket()
  bridgeSub(ws, { sub, main, clientH265: true })
  let counted = 0
  const inner = ws.send.bind(ws)
  ws.send = (b) => { counted++; return inner(b) }
  ws.send(frame('s-k', true))
  ws.send(frame('s-d', false))
  check('a later wrapper of ws.send survives the hand-over', counted === 2 && ws.got.join() === 'm-k,s-k,s-d', `${counted} ${ws.got.join()}`)
}

// every stand-in is logged, one line when it starts and one when it ends (with what it sent): on
// 29 Sep nothing said which tiles had one, for how long, or how much it put on a remote viewer's link
{
  const sub = new FakeStream()
  const main = new FakeStream()
  main.gop = [frame('m-k', true), frame('m-d1', false)]
  const ws = socket()
  const logs = []
  let t = 1000
  bridgeSub(ws, { sub, main, clientH265: true, cap: 1000, log: (l) => logs.push(l), now: () => t })
  check('a stand-in logs its start', logs.length === 1 && logs[0] === 'stand-in started: the main stream until the sub-stream\'s first frame', logs.join(' | '))
  ws.bufferedAmount = 5000 // over its cap: the next frame is held back
  main.frame(frame('m-d2', false), false)
  ws.bufferedAmount = 0
  t = 3500
  ws.send(frame('s-k', true))
  check('... and its end: how long, why, the frames and bytes it sent and those its gate held back', logs.length === 2 && logs[1] === 'stand-in ended after 2.5 s (the sub-stream came): 2 frames, 0.00 MB sent, 1 held back', logs.join(' | '))
  ws.send(frame('s-d', false))
  ws.fire('close')
  check('... once', logs.length === 2)
}
{
  const sub = new FakeStream()
  const main = new FakeStream()
  main.gop = [frame('m-k', true)]
  const ws = socket()
  const logs = []
  bridgeSub(ws, { sub, main, clientH265: true, log: (l) => logs.push(l), now: () => 0 })
  for (let i = 0; i < 4; i++) main.frame(Buffer.alloc(300_000, 0), false)
  ws.fire('close')
  check('a tile closed before its sub-stream came: logged as such, with the bytes in MB', logs[1] === 'stand-in ended after 0.0 s (the tile closed): 5 frames, 1.20 MB sent, 0 held back', logs.join(' | '))
}
{
  // A stand-in that never sends a frame is one line, at its end. The H.265 one repeats: the tile gets
  // nothing, shows "no video" and reconnects every 8-16 s (review of 29 Sep: 14-16 held tiles on
  // value4u, about 2 lines a second while the page was open); its end says why as the log's second
  // argument, for live-attach.mjs to say it less often.
  const sub = new FakeStream()
  const main = new FakeStream()
  main.gop = [frame('m-k', true, 1)]
  const logs = []
  bridgeSub(socket(), { sub, main, clientH265: false, log: (l, why) => logs.push([l, why]), now: () => 0 })
  check('an H.265 main for a browser without H.265: one line, saying why', logs.length === 1 && logs[0][0] === 'stand-in ended after 0.0 s, having sent nothing (the main stream is H.265, which this browser cannot play)' && logs[0][1] === 'h265', JSON.stringify(logs))
}
{
  // the main stream not playing yet (no keyframe to start from), and the sub-stream first
  const sub = new FakeStream()
  const main = new FakeStream()
  const ws = socket()
  const logs = []
  let t = 0
  bridgeSub(ws, { sub, main, clientH265: true, log: (l, why) => logs.push([l, why]), now: () => t })
  main.frame(frame('m-d0', false), false) // a delta: nothing to decode it from, not sent
  check('nothing sent yet: nothing logged yet', logs.length === 0)
  t = 1900
  ws.send(frame('s-k', true))
  check('... the sub-stream first: one line, with the frame its gate held back', logs.length === 1 && logs[0][0] === 'stand-in ended after 1.9 s, having sent nothing (the sub-stream came): 1 held back' && logs[0][1] === 'sub', JSON.stringify(logs))
}
{
  // one that sends: its start at its first frame, its end with the count (one frame: "1 frame")
  const sub = new FakeStream()
  const main = new FakeStream()
  const ws = socket()
  const logs = []
  bridgeSub(ws, { sub, main, clientH265: true, log: (l) => logs.push(l), now: () => 0 })
  const before = logs.length
  main.frame(frame('m-k', true), true)
  check('a main that starts later: the start is logged with its first frame, not before', before === 0 && logs.length === 1 && logs[0].startsWith('stand-in started'), logs.join(' | '))
  ws.send(frame('s-k', true))
  check('... and "1 frame", not "1 frames"', logs[1] === 'stand-in ended after 0.0 s (the sub-stream came): 1 frame, 0.00 MB sent, 0 held back', logs.join(' | '))
}
{
  const logs = []
  const sub = new FakeStream()
  sub.gop = [frame('s-k', true)]
  bridgeSub(socket(), { sub, main: new FakeStream(), clientH265: true, log: (l) => logs.push(l) })
  check('no stand-in (the sub-stream runs): nothing logged', logs.length === 0)
}

// ---- a remote viewer (through the tunnel): the main stream's keyframes only, each while its page keeps
// up. On 29 Sep a remote page's stand-ins were whole main streams, 2-5 Mbit/s each with their GOP
// replayed at once, into a 3.5-6.5 Mbit/s tunnel (stutter report 2.6, verify-6) ----
{
  const sub = new FakeStream()
  const main = new FakeStream()
  main.gop = [frame('m-k1', true), frame('m-d1', false), frame('m-d2', false)]
  const ws = socket()
  const b = bridgeSub(ws, { sub, main, clientH265: true, remote: true })
  check('remote: the main stream\'s GOP replayed into it: its keyframe alone', ws.got.join() === 'm-k1', ws.got.join())
  main.frame(frame('m-d3', false), false)
  check('... no frame between keyframes', ws.got.join() === 'm-k1', ws.got.join())
  main.frame(frame('m-k2', true), true)
  check('... the next keyframe goes: a picture a GOP, a slideshow that moves', ws.got.join() === 'm-k1,m-k2', ws.got.join())
  ws.send(frame('s-k', true))
  main.frame(frame('m-k3', true), true)
  check('... the sub-stream\'s first frame ends it, as for a local viewer', ws.got.join() === 'm-k1,m-k2,s-k' && !b.active() && main.clients.size === 0, ws.got.join())
  ws.send(frame('s-d', false))
  check('... and every frame of its own stream goes after it', ws.got.at(-1) === 's-d')
}
{
  // On a page open the parent's main stream is a new one, and the worker replays its GOP through the
  // fan-out, frame after frame (verify-6), not through add
  const sub = new FakeStream()
  const main = new FakeStream()
  const ws = socket()
  bridgeSub(ws, { sub, main, clientH265: true, remote: true })
  main.frame(frame('m-k', true), true)
  for (let i = 0; i < 30; i++) main.frame(frame(`m-d${i}`, false), false)
  check('remote: the worker\'s replay through the fan-out: its keyframe alone', ws.got.join() === 'm-k', ws.got.join())
}
{
  // a local viewer, said as such: every frame, as before
  const sub = new FakeStream()
  const main = new FakeStream()
  main.gop = [frame('m-k1', true), frame('m-d1', false)]
  const ws = socket()
  bridgeSub(ws, { sub, main, clientH265: true, remote: false })
  main.frame(frame('m-d2', false), false)
  check('a local viewer: every frame of the main stream, as before', ws.got.join() === 'm-k1,m-d1,m-d2', ws.got.join())
}
{
  // Each keyframe only while the viewer's page keeps up. Keyframes alone are still about half of these
  // mains (nvr-2/10: 634 KB of a 1279 KB GOP every 2 s, 2.6 Mbit/s), and under the stand-in's own cap
  // (4 MB of its own) three of them backed the 03:55 page up over 4 MB, its tiles over 6 s behind
  // (live-mux-server.test.mjs replays it). A page whose drain rate is not measured yet (live-mux.mjs
  // drainBps null: idle, or a burst queued just now) keeps up while it has less than RESUME_BELOW
  // queued: the whole page's queue, which every tile waits behind.
  const sub = new FakeStream()
  const main = new FakeStream()
  const ws = socket()
  ws.drainBps = null
  ws.sharedBufferedAmount = RESUME_BELOW // other tiles' frames: this channel has nothing of its own queued
  const logs = []
  let t = 0
  bridgeSub(ws, { sub, main, clientH265: true, remote: true, log: (l) => logs.push(l), now: () => t })
  main.frame(frame('m-k1', true), true)
  check('remote: its page with RESUME_BELOW queued: the keyframe is held back', ws.got.length === 0, ws.got.join())
  check('... the viewer\'s own wait for its keyframe untouched', ws.waitForKey === true)
  check('... nothing sent: nothing logged yet', logs.length === 0, logs.join(' | '))
  ws.sharedBufferedAmount = RESUME_BELOW - 1
  main.frame(frame('m-d', false), false)
  main.frame(frame('m-k2', true), true)
  check('... its page under it: the next keyframe goes', ws.got.join() === 'm-k2', ws.got.join())
  check('... its start logged as keyframes', logs.length === 1 && logs[0] === 'stand-in started: the main stream\'s keyframes until the sub-stream\'s first frame', logs.join(' | '))
  main.frame(frame('m-k3', true), true)
  t = 6000
  ws.send(frame('s-k', true))
  check('... and its end, with the keyframes it sent and those held back', logs.length === 2 && logs[1] === 'stand-in ended after 6.0 s (the sub-stream came): 2 keyframes, 0.00 MB sent, 1 held back', logs.join(' | '))
}
{
  // The sub-stream runs but its keyframe has not gone to this socket yet: a fan-out holds it back while
  // the socket's own queue is over RESUME_BELOW, and there that is the stand-in's last keyframe. More of
  // the main would hold it back again (the page replay in live-mux-server.test.mjs: with every frame,
  // nvr-2/17's stand-in outlived its sub-stream's start by 22 s)
  const sub = new FakeStream()
  const main = new FakeStream()
  const ws = socket()
  const b = bridgeSub(ws, { sub, main, clientH265: true, remote: true })
  main.frame(frame('m-k1', true), true)
  sub.frame(frame('s-k', true), true) // running (not sent here: this socket is not its viewer in this test)
  main.frame(frame('m-k2', true), true)
  check('remote: once the sub-stream runs, no more of the main: its own keyframe is next', ws.got.join() === 'm-k1' && b.active(), ws.got.join())
}
{
  // A /live-mux page's socket drains at a rate it measures (live-mux.mjs drainBps), and the level
  // controller counts what the page has queued as its link not keeping up once that takes more than
  // QUEUE_S (1 s) to go at that rate, on two looks in a row (adaptive-live.mjs). No level thins a
  // stand-in, so its keyframe goes only if, with it, the page's queue goes within ROOM_S: under that
  // line, with room for the meter's error. With less than RESUME_BELOW queued as the only rule,
  // nvr-2/10's 634 KB keyframes -- 1 s by themselves at 5 Mbit/s, one every 2 s like the controller's
  // looks -- stepped the 03:55 page down in 11 of 20 replays (review of t8; adaptive-live.test.mjs).
  const sub = new FakeStream()
  const main = new FakeStream()
  const ws = socket()
  ws.drainBps = 625_000 // 5 Mbit/s
  ws.sharedBufferedAmount = 0
  const room = ROOM_S * ws.drainBps // 375 KB
  bridgeSub(ws, { sub, main, clientH265: true, remote: true })
  check('ROOM_S: 0.6 s, under the controller\'s line (QUEUE_S)', ROOM_S === 0.6 && ROOM_S < QUEUE_S, String(ROOM_S))
  main.frame(frame('m-k1', true, 0, 634_000), true)
  check('remote, its page draining 5 Mbit/s with nothing queued: nvr-2/10\'s 634 KB keyframe (1 s by itself) is held back', ws.got.length === 0, ws.got.join())
  ws.sharedBufferedAmount = room - 243_000
  main.frame(frame('m-k2', true, 0, 243_000), true)
  check('... /21\'s 243 KB, the page\'s queue ROOM_S with it: it goes', ws.got.join() === 'm-k2', ws.got.join())
  ws.sharedBufferedAmount = room - 243_000 + 1
  main.frame(frame('m-k3', true, 0, 243_000), true)
  check('... a byte more queued: it waits', ws.got.join() === 'm-k2', ws.got.join())
  ws.sharedBufferedAmount = 100_000
  ws.drainBps = 1_250_000 // 10 Mbit/s
  main.frame(frame('m-k4', true, 0, 634_000), true)
  check('... the page draining 10 Mbit/s, 100 KB queued: /10\'s 634 KB goes (0.59 s with it)', ws.got.join() === 'm-k2,m-k4', ws.got.join())
  ws.sharedBufferedAmount = 0
  ws.drainBps = 0 // busy, and nothing written
  main.frame(frame('m-k5', true, 0, 1000), true)
  check('... a page whose socket writes nothing: not even a small one', ws.got.join() === 'm-k2,m-k4', ws.got.join())
  ws.drainBps = null
  ws.sharedBufferedAmount = RESUME_BELOW - 1
  main.frame(frame('m-k6', true, 0, 634_000), true)
  check('... a rate not measured yet: less than RESUME_BELOW queued, as before', ws.got.join() === 'm-k2,m-k4,m-k6', ws.got.join())
}
{
  // a /live socket of its own (no page): its own queue, and no rate to go by: less than RESUME_BELOW
  const sub = new FakeStream()
  const main = new FakeStream()
  const ws = socket()
  ws.bufferedAmount = RESUME_BELOW
  bridgeSub(ws, { sub, main, clientH265: true, remote: true })
  main.frame(frame('m-k1', true), true)
  ws.bufferedAmount = 0
  main.frame(frame('m-k2', true), true)
  check('remote, a /live socket: held while its own queue is RESUME_BELOW, then the next keyframe', ws.got.join() === 'm-k2', ws.got.join())
}
{
  // a remote browser without H.265 and an H.265 main: nothing, ended at once, as for a local one
  const sub = new FakeStream()
  const main = new FakeStream()
  main.gop = [frame('m-k', true, 1)]
  const ws = socket()
  const logs = []
  const b = bridgeSub(ws, { sub, main, clientH265: false, remote: true, log: (l, why) => logs.push([l, why]), now: () => 0 })
  check('remote, H.265 main, browser without H.265: nothing sent, ended at once, said as before', ws.got.length === 0 && !b.active() && main.clients.size === 0 && logs.length === 1 && logs[0][1] === 'h265', JSON.stringify(logs))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
