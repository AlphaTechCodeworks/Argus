// A grid tile's stand-in picture while its sub-stream is not running (sub-bridge.mjs): the main
// stream goes to the viewer until the sub-stream's first frame does, then only the sub-stream.
// Fake streams and sockets; no SDK.
//   node cctv/test/sub-bridge.test.mjs
import { bridgeSub } from '../sub-bridge.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const frame = (tag, key, codec = 0) => {
  const b = Buffer.alloc(40)
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

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
