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

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
