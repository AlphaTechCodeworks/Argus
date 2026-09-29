// Every live tile of a page on one socket (live-mux.mjs), the server side: the protocol, its limits,
// and each channel standing in for a /live socket in the real pipeline (stream-hub.mjs HubStream,
// backpressure.mjs gateSend, sub-bridge.mjs, adaptive-live.mjs, live-attach.mjs). Fake sockets, then
// one real ws server on 127.0.0.1; no SDK.
//   node cctv/test/live-mux-server.test.mjs
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { WebSocket, WebSocketServer } from 'ws'
import {
  DRAIN_WINDOW_MS, MAX_CHANNELS, MAX_MALFORMED, MAX_MESSAGE_BYTES, MESSAGE_BURST, MESSAGES_PER_S, SOCKET_CAP_BYTES,
  SOCKET_SOFT_BYTES, SUB_BURST, SUBS_PER_S, serveMux
} from '../live-mux.mjs'
import { StreamHub } from '../stream-hub.mjs'
import { CAP_BYTES, STUCK_MS, gateSend } from '../backpressure.mjs'
import { REPLAY_MAX_BYTES } from '../gop-replay.mjs'
import { bridgeSub } from '../sub-bridge.mjs'
import { AdaptiveLive, PRESSURE_BYTES, SETTLE_MS } from '../adaptive-live.mjs'
import { TranscodePool } from '../transcode.mjs'
import { H265_QUIET_MS, PHONE_SPARE, liveAttacher } from '../live-attach.mjs'
import { camera } from './remote-page.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const tick = () => new Promise((r) => setImmediate(r))
const MB = 1024 * 1024

/**
 * The page's socket as ws has it, as far as the mux uses it. send throws unless open: the mux must
 * look first. A message may come in fragments (fin: false, then fin: true), as ws sends them; each
 * message stays queued (bufferedAmount) until drain() writes it, which runs its send callback.
 */
class FakeSocket {
  constructor() {
    this.OPEN = 1
    this.readyState = 1
    this.bufferedAmount = 0
    this.sent = [] // whole messages: a string, or { parts } (the binary fragments as handed to send)
    this.parts = [] // the fragments of the message being sent
    this.queue = [] // { bytes, cb } of every message not written yet, oldest first
    this.handlers = {}
    this.closedWith = null
    this.terminated = false
  }
  on(ev, fn) { (this.handlers[ev] ??= []).push(fn); return this }
  emit(ev, ...a) { for (const fn of this.handlers[ev] ?? []) fn(...a) }
  send(d, opts, cb) {
    if (typeof opts === 'function') [cb, opts] = [opts, {}]
    if (this.readyState !== 1) throw new Error(`send while readyState ${this.readyState}`)
    let msg
    if (typeof d === 'string') {
      if (this.parts.length) throw new Error('a text message inside a fragmented one')
      msg = d
    } else {
      this.parts.push(d)
      if (opts?.fin === false) {
        if (cb) throw new Error('a callback on a first fragment')
        return
      }
      msg = { parts: this.parts }
      this.parts = []
    }
    this.sent.push(msg)
    const bytes = typeof msg === 'string' ? Buffer.byteLength(msg) : msg.parts.reduce((a, p) => a + p.length, 0)
    this.bufferedAmount += bytes
    this.queue.push({ bytes, cb })
  }
  /** The peer reads n messages (or all): each one's send callback runs, as ws runs it once written. */
  drain(n = Infinity) {
    while (n-- > 0 && this.queue.length) {
      const m = this.queue.shift()
      this.bufferedAmount -= m.bytes
      m.cb?.()
    }
  }
  /** The peer reads until at most `bytes` are left queued. */
  drainTo(bytes) {
    while (this.bufferedAmount > bytes && this.queue.length) this.drain(1)
  }
  close(code, reason) {
    if (this.readyState !== 1) return
    this.readyState = 2
    this.closedWith = { code, reason }
    setImmediate(() => { this.readyState = 3; this.emit('close', code) })
  }
  terminate() {
    this.terminated = true
    this.readyState = 2
    setImmediate(() => { this.readyState = 3; this.emit('close', 1006) })
  }
  msg(o) { this.emit('message', Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)), false) }
  texts() { return this.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d)) }
  frames() {
    return this.sent.filter((d) => typeof d !== 'string').map(({ parts }) => {
      const raw = Buffer.concat(parts)
      return { id: raw.readUInt32LE(0), body: raw.subarray(4), raw, parts }
    })
  }
}

/** A mux on a fake socket; attach records each channel (or does what the test says). */
function setup({ attach, who } = {}) {
  const ws = new FakeSocket()
  const state = { user: 'ann', t: 0 }
  const attached = []
  const logs = []
  const mux = serveMux(ws, {
    session: () => state.user,
    attach: attach ?? ((channel, sub, user) => attached.push({ channel, sub, user })),
    now: () => state.t,
    log: (l) => logs.push(l),
    who
  })
  return { ws, mux, state, attached, logs }
}
const sub = (id, extra = {}) => ({ op: 'sub', id, nvr: 'n1', ch: 3, stream: 1, ...extra })
/** A frame as /live sends it: 16-byte header, then Annex B (size: the whole frame, header included). */
const frame = (key, tag = 1, size = 24) => {
  const b = Buffer.alloc(size)
  b[0] = key ? 1 : 0
  b.writeUInt32BE(1, 16) // start code
  b[20] = key ? 0x65 : 0x41
  b[21] = tag
  return b
}
const closeCounter = (c) => {
  const n = { v: 0 }
  c.on('close', () => n.v++)
  return n
}
/** What a fan-out (live.mjs, stream-hub.mjs) does with a frame for one viewer, at time now. */
const fanOut = (c, buf, isKey, type, now) => {
  if (!gateSend(c, isKey, { cap: CAP_BYTES[type], now })) return false
  c.send(buf)
  return true
}

// ---- sub: a channel attached as a /live socket would be ----
{
  const { ws, mux, attached } = setup()
  ws.msg(sub(7, { ch: 12, stream: 0, fps: 15, h265: 1 }))
  const a = attached[0]
  check('a sub attaches one channel, with the fields the /live path takes and the session\'s user', attached.length === 1 && a.sub.nvr === 'n1' && a.sub.ch === 12 && a.sub.stream === 0 && a.sub.fps === 15 && a.sub.h265 === true && a.user === 'ann', JSON.stringify(a?.sub))
  const c = a.channel
  check('... which looks like an open socket (OPEN 1, readyState 1)', c.readyState === 1 && c.OPEN === 1 && mux.channels.get(7) === c)
  check('... with gateSend\'s state of its own', c.waitForKey === false && c.overSince === null)
  ws.msg(sub(8))
  check('h265 and fps may be left out (then no H.265, no phone stream)', attached[1].sub.h265 === false && attached[1].sub.fps === null)
  ws.msg(sub(9, { h265: null, fps: null }))
  check('... or sent as null', attached.length === 3 && attached[2].sub.h265 === false && attached[2].sub.fps === null)

  // frames: the id in front, the frame itself untouched and not copied
  const f = frame(true, 5)
  const before = Buffer.from(f)
  c.send(f)
  attached[1].channel.send(f)
  const got = ws.frames()
  check('a frame goes out as one binary message: uint32 LE channel id, then the frame exactly', got.length === 2 && got[0].id === 7 && got[0].body.equals(before) && got[0].raw.length === f.length + 4 && got[1].id === 8)
  check('... in two fragments: the 4-byte id, then the very frame (shared by every viewer, not copied)', got.every((m) => m.parts.length === 2 && m.parts[0].length === 4 && m.parts[1] === f) && f.equals(before))
  check('... the id fragment made once per channel, not per frame', got[0].parts[0] !== got[1].parts[0] && (c.send(f), ws.frames()[2].parts[0] === got[0].parts[0]))
  const u8 = new Uint8Array([0, 0, 0, 0, 9, 9])
  c.send(u8)
  check('a Uint8Array frame (from the worker) goes the same way', ws.frames()[3].id === 7 && Buffer.from(ws.frames()[3].body).equals(Buffer.from(u8)) && ws.frames()[3].parts[1] === u8)
  ws.msg(sub(2147483647))
  attached[3].channel.send(f)
  check('the largest id, little endian', ws.frames().at(-1).raw.subarray(0, 4).equals(Buffer.from([0xff, 0xff, 0xff, 0x7f])))
  check('nothing but frames was sent', ws.texts().length === 0)
}

// ---- unsub ----
{
  const { ws, mux, attached } = setup()
  ws.msg(sub(1))
  ws.msg(sub(2))
  const c = attached[0].channel
  const n = closeCounter(c)
  const m = closeCounter(c) // several listeners, as sub-bridge, adaptive-live and live-attach each add one
  ws.msg({ op: 'unsub', id: 1 })
  check('unsub: the channel is closed at once, its id free', c.readyState === 3 && !mux.channels.has(1) && mux.channels.size === 1)
  check('... its close handlers wait for a later tick, as ws\'s \'close\' does', n.v === 0 && m.v === 0)
  await tick()
  check('... then each runs once', n.v === 1 && m.v === 1)
  check('... and nothing is sent back', ws.texts().length === 0)
  c.send(frame(true))
  c.close(1011, 'NVR removed')
  await tick()
  check('a closed channel sends nothing, and closing it again does nothing', ws.sent.length === 0 && n.v === 1)
  ws.msg({ op: 'unsub', id: 99 })
  ws.msg({ op: 'unsub', id: 1 })
  check('unsub of an id that is not open (the server ended it already): ignored', mux.channels.size === 1 && ws.closedWith === null)
  const off = attached[1].channel
  let removed = 0
  const fn = () => removed++
  off.on('close', fn)
  off.off('close', fn)
  off.once('close', () => removed += 10)
  ws.msg({ op: 'unsub', id: 2 })
  await tick()
  check('off() takes a listener out; once() runs once', removed === 10)
}

// ---- the server ends a channel: "end" with the /live close code ----
{
  const refuse = (code, reason) => (channel) => channel.close(code, reason)
  const { ws, mux } = setup({ attach: refuse(1008, 'not allowed') })
  ws.msg(sub(4))
  check('a refused sub: "end" with the code and reason /live closes with', JSON.stringify(ws.texts()) === '[{"op":"end","id":4,"code":1008,"reason":"not allowed"}]', JSON.stringify(ws.texts()))
  check('... and the id is free again', mux.channels.size === 0 && ws.closedWith === null)
}
{
  const { ws, mux, attached } = setup()
  ws.msg(sub(4))
  const c = attached[0].channel
  const n = closeCounter(c)
  c.close(1011, 'NVR removed') // stream-hub.mjs HubStream.close, live.mjs LiveStream.fail
  c.close(1011, 'NVR removed') // (LiveStream.fail can reach a viewer twice: idempotent)
  await tick()
  check('ended by the stream: one "end" (1011 NVR removed), handlers once', JSON.stringify(ws.texts()) === '[{"op":"end","id":4,"code":1011,"reason":"NVR removed"}]' && n.v === 1 && c.readyState === 3)
  ws.msg(sub(4))
  check('the same id can be subscribed again after its "end"', attached.length === 2 && mux.channels.get(4) === attached[1].channel && attached[1].channel.readyState === 1)
}
{
  const { ws, mux } = setup({ attach: () => { throw new Error('boom') } })
  ws.msg(sub(6))
  check('attach throwing: that channel ends 1011, the socket stays', ws.texts()[0]?.code === 1011 && ws.texts()[0]?.reason === 'server error' && mux.channels.size === 0 && ws.readyState === 1)
}

// ---- the same id again: the old channel ends silently ----
{
  const { ws, mux, attached } = setup()
  ws.msg(sub(5, { ch: 1 }))
  const old = attached[0].channel
  const n = closeCounter(old)
  ws.msg(sub(5, { ch: 2 }))
  const now = attached[1].channel
  await tick()
  check('sub with an open id: the old channel is ended (its handlers run once), no "end"', old.readyState === 3 && n.v === 1 && ws.texts().length === 0)
  check('... the new one takes the id', mux.channels.size === 1 && mux.channels.get(5) === now && attached[1].sub.ch === 2)
  old.send(frame(true, 1))
  now.send(frame(true, 2))
  check('... the old one sends nothing any more, the new one sends under the id', ws.frames().length === 1 && ws.frames()[0].id === 5 && ws.frames()[0].body[21] === 2)
  old.close(1011, 'late')
  check('... and a late close of the old one leaves the new one alone', mux.channels.get(5) === now && ws.texts().length === 0)
}

// ---- at most 128 channels ----
{
  const { ws, mux, attached } = setup()
  for (let id = 1; id <= MAX_CHANNELS; id++) ws.msg(sub(id))
  check(`${MAX_CHANNELS} channels open`, MAX_CHANNELS === 128 && mux.channels.size === 128 && attached.length === 128)
  ws.msg(sub(129))
  check('one more: "end" 1008 "too many channels", not attached', attached.length === 128 && JSON.stringify(ws.texts()) === '[{"op":"end","id":129,"code":1008,"reason":"too many channels"}]')
  ws.msg(sub(128))
  check('the same id again replaces, it does not count twice', attached.length === 129 && mux.channels.size === 128 && ws.texts().length === 1)
  ws.msg({ op: 'unsub', id: 1 })
  ws.msg(sub(129))
  check('after an unsub there is room again', attached.length === 130 && mux.channels.has(129) && ws.readyState === 1)
}

// ---- rates: subs a burst of 200, then 20 a second; any message a burst of 1000, then 100 a second ----
{
  const { ws, mux, attached } = setup()
  for (let i = 0; i < SUB_BURST; i++) ws.msg(sub(1)) // (the same id: each replaces the last)
  check(`${SUB_BURST} subs at once: fine`, SUB_BURST === 200 && SUBS_PER_S === 20 && ws.readyState === 1 && attached.length === 200)
  const n = closeCounter(attached.at(-1).channel)
  ws.msg(sub(2))
  check('one more at the same moment: the socket is closed 1008 "too many requests", not attached', ws.closedWith?.code === 1008 && ws.closedWith?.reason === 'too many requests' && attached.length === 200)
  check('... every channel ends at once', attached.at(-1).channel.readyState === 3 && mux.channels.size === 0)
  await tick()
  check('... their handlers run once', n.v === 1)
  ws.readyState = 1 // (were it still open) nothing more is read once it is closing
  ws.msg(sub(3))
  check('... and nothing is read after that', attached.length === 200)
}
{
  const { ws, state, attached } = setup()
  for (let i = 0; i < SUB_BURST; i++) ws.msg(sub(1))
  state.t = 1000
  for (let i = 0; i < SUBS_PER_S; i++) ws.msg(sub(1))
  check('the bucket refills: 20 more a second later are fine', ws.readyState === 1 && attached.length === 220)
  ws.msg(sub(1))
  check('... but not 21', ws.closedWith?.code === 1008 && attached.length === 220)
}
{
  // unsubs only free what a sub took: they do not count against the subs
  const { ws, state, attached } = setup()
  for (let i = 0; i < SUB_BURST; i++) ws.msg(sub(i % 64 + 1))
  for (let i = 0; i < MESSAGE_BURST - SUB_BURST; i++) ws.msg({ op: 'unsub', id: i % 64 + 1 })
  check(`${SUB_BURST} subs and ${MESSAGE_BURST - SUB_BURST} unsubs at once: fine`, MESSAGE_BURST === 1000 && ws.readyState === 1 && attached.length === 200)
  ws.msg({ op: 'unsub', id: 1 })
  check(`... the ${MESSAGE_BURST + 1}st message of any kind: closed 1008 "too many requests"`, ws.closedWith?.code === 1008 && ws.closedWith?.reason === 'too many requests')
  const b = setup()
  for (let i = 0; i < MESSAGE_BURST; i++) b.ws.msg({ op: 'unsub', id: 1 })
  b.state.t = 1000
  for (let i = 0; i < MESSAGES_PER_S; i++) b.ws.msg({ op: 'unsub', id: 1 })
  check('... that bucket refills too: 100 more a second later are fine', MESSAGES_PER_S === 100 && b.ws.readyState === 1)
  b.ws.msg({ op: 'unsub', id: 1 })
  check('... but not 101', b.ws.closedWith?.code === 1008)
  void state
}
{
  // A client keeping to 180 in any 10.5 s (the first client's budget) sends a burst at 0 and the next
  // at 10.5 s; the first arrives 0.6 s late (a stalled phone link, this process busy). A rolling "200
  // in 10 s" saw 360 in one window and closed the page's socket.
  const { ws, state, attached } = setup()
  state.t = 600
  for (let i = 0; i < 180; i++) ws.msg(sub(i % 100 + 1))
  state.t = 10_500
  for (let i = 0; i < 180; i++) ws.msg(sub(i % 100 + 1))
  check('a burst that arrived late is not counted against the next one', ws.readyState === 1 && ws.closedWith === null && attached.length === 360)
}
{
  // An 8x8 grid loaded, then paged twice (render() closes every tile and opens 64 new ones): 64
  // subs, then 64 unsubs and 64 subs at 3.1 s and at 6.1 s. That was 320 messages in 6.1 s.
  const { ws, state, attached } = setup()
  let id = 1
  for (let i = 0; i < 64; i++) ws.msg(sub(id++, { ch: i }))
  for (const at of [3100, 6100]) {
    state.t = at
    for (let i = id - 64; i < id; i++) ws.msg({ op: 'unsub', id: i })
    for (let i = 0; i < 64; i++) ws.msg(sub(id++, { ch: i }))
  }
  check('an 8x8 grid paged twice in 6.1 s: every sub attached, the socket stays', ws.readyState === 1 && attached.length === 192)
}

// ---- malformed messages: ignored, and more than 20 close the socket ----
{
  const { ws, mux, attached } = setup()
  const raw = (s) => ws.emit('message', Buffer.from(s), false)
  const pad = (n) => {
    const base = JSON.stringify({ ...sub(40), pad: '' })
    return JSON.stringify({ ...sub(40), pad: 'x'.repeat(n - base.length) })
  }
  check('the padding helper is exact', Buffer.byteLength(pad(MAX_MESSAGE_BYTES)) === 1024 && Buffer.byteLength(pad(MAX_MESSAGE_BYTES + 1)) === 1025)
  raw(pad(MAX_MESSAGE_BYTES))
  check('a message of exactly 1024 bytes is read', attached.length === 1 && mux.channels.has(40))
  const bad = [
    () => ws.emit('message', Buffer.from(JSON.stringify(sub(41))), true), // binary
    () => raw(pad(MAX_MESSAGE_BYTES + 1).replace('"id":40', '"id":41')), // 1025 bytes (ws refuses it first: below)
    () => raw('not json'),
    () => raw('[1,2]'),
    () => raw('null'),
    () => raw('{"op":"sub"}'), // no id
    () => ws.msg(sub(0)),
    () => ws.msg(sub(2147483648)),
    () => ws.msg(sub(1.5)),
    () => ws.msg(sub('3')),
    () => ws.msg({ op: 'pause', id: 3 }),
    () => ws.msg({ id: 3 })
  ]
  for (const b of bad) b()
  check('binary, too big, not JSON, no or bad id, unknown op: ignored, nothing sent back', ws.sent.length === 0 && attached.length === 1 && ws.readyState === 1)
  // a good id with bad fields: counted too, and answered "end" so its tile does not wait
  const badFields = [{ ch: 256 }, { ch: -1 }, { ch: 1.5 }, { ch: '3' }, { stream: 2 }, { stream: undefined }, { nvr: 5 }, { fps: '15' }]
  badFields.forEach((f, i) => ws.msg(sub(50 + i, f)))
  check('a good id with a bad field: "end" 1008 "bad channel or stream", not attached', attached.length === 1 && ws.texts().length === badFields.length && ws.texts().every((m, i) => m.op === 'end' && m.id === 50 + i && m.code === 1008 && m.reason === 'bad channel or stream'), JSON.stringify(ws.texts()[0]))
  check(`${bad.length + badFields.length} malformed messages: the socket stays`, bad.length + badFields.length === MAX_MALFORMED && ws.readyState === 1)
  ws.msg(sub(60))
  check('... and good ones still work', attached.length === 2)
  const c = attached[0].channel
  ws.msg(sub(61, { h265: 2 }))
  check('the 21st: the socket is closed 1008, no "end" for it', MAX_MALFORMED === 20 && ws.closedWith?.code === 1008 && ws.texts().length === badFields.length)
  check('... and every channel ends', c.readyState === 3 && mux.channels.size === 0)
}

// ---- every sub checks the session again ----
{
  const { ws, mux, state, attached } = setup()
  ws.msg(sub(1))
  const n = closeCounter(attached[0].channel)
  state.user = null // the session expired, or the account was removed
  ws.msg({ op: 'unsub', id: 77 })
  check('an unsub does not look at the session', ws.readyState === 1)
  ws.msg(sub(2))
  check('a sub when signed out: the socket is closed 1008 "signed out", nothing attached', ws.closedWith?.code === 1008 && ws.closedWith?.reason === 'signed out' && attached.length === 1)
  check('... the channels already open end with it', mux.channels.size === 0 && attached[0].channel.readyState === 3)
  await tick()
  check('... their handlers run once', n.v === 1)
}
{
  const ws = new FakeSocket()
  let attaches = 0
  serveMux(ws, { session: () => { throw new Error('users file') }, attach: () => attaches++, log: () => {} })
  ws.msg(sub(1))
  check('a session check that throws counts as signed out', ws.closedWith?.reason === 'signed out' && attaches === 0)
}

// ---- the page's socket closing ends every channel ----
{
  const { ws, mux, attached } = setup()
  for (const id of [1, 2, 3]) ws.msg(sub(id))
  const counts = attached.map((a) => closeCounter(a.channel))
  ws.readyState = 3
  ws.emit('close', 1006)
  check('socket gone: every channel is closed at once', attached.every((a) => a.channel.readyState === 3) && mux.channels.size === 0)
  await tick()
  check('... each channel\'s handlers run once', counts.every((n) => n.v === 1))
  attached[0].channel.close(1011, 'NVR removed')
  ws.emit('close', 1006)
  await tick()
  check('... and never again (no "end" on a closed socket either)', counts.every((n) => n.v === 1) && ws.sent.length === 0)
  ws.msg(sub(4))
  check('... nothing is read after it', attached.length === 3)
}
{
  const { ws, attached } = setup()
  ws.msg(sub(1))
  const c = attached[0].channel
  ws.readyState = 2 // closing (keepAlive, the browser leaving): the channel stops at once
  c.send(frame(true))
  check('the socket closing: the channel reads as closed and sends nothing', c.readyState === 3 && ws.sent.length === 0)
}

// ---- every close of a page's socket is logged: its code and reason, why, and what it never wrote.
// On 29 Sep a remote page was forgotten and restarted at full twice, and nothing said whether its
// socket had been cut, by what, or how far behind it was (stutter report 2.10) ----
{
  const { ws, state, attached, logs } = setup({ who: 'remote' })
  for (const id of [1, 2, 3]) ws.msg(sub(id))
  attached[0].channel.send(frame(false, 1, 999_996)) // 1 MB with its id
  state.t = 4000
  ws.drain()
  attached[0].channel.send(frame(false, 1, 1_999_996))
  state.t = 812_000
  ws.readyState = 3
  ws.emit('close', 1001, Buffer.from('going away'))
  check('a page\'s socket closing is logged: remote or local, how long it was open, code and reason, channels, what was never written, drain rate, bytes written',
    logs.at(-1) === '[live-mux] a remote page\'s socket closed after 812 s: code 1001 "going away"; 3 channels, 2.00 MB never written, draining at 0.0 Mbit/s; 1.00 MB written in all (0.0 Mbit/s on average)', logs.at(-1))
  ws.emit('close', 1006)
  check('... once', logs.filter((l) => l.includes('socket closed')).length === 1)
}
{
  // the socket dies with a backlog: ws calls the queued sends back with an error, maybe before its
  // 'close'. Those bytes were never written: not counted as written, and still in the line.
  const { ws, state, attached, logs } = setup()
  ws.msg(sub(1))
  attached[0].channel.send(frame(false, 1, 999_996))
  state.t = 1000
  const lost = ws.queue.shift()
  ws.bufferedAmount -= lost.bytes
  lost.cb(new Error('socket gone'))
  ws.readyState = 3
  ws.emit('close', 1006, Buffer.alloc(0))
  check('... a send called back with an error (the socket gone): never written, not written', /; 1 channels, 1\.00 MB never written, draining at 0\.0 Mbit\/s; 0\.00 MB written in all/.test(logs.at(-1)), logs.at(-1))
}
{
  // the keep-alive (backpressure.mjs) cut it: the line says so, not just 1006
  const { ws, logs } = setup({ who: 'remote' })
  ws.msg(sub(1))
  ws.closeCause = 'keep-alive: no answer to the last ping'
  ws.readyState = 3
  ws.emit('close', 1006, Buffer.alloc(0))
  check('... cut by the keep-alive: the line says so', /: code 1006 \(keep-alive: no answer to the last ping\); 1 channels, 0\.00 MB never written, draining: idle;/.test(logs.at(-1)), logs.at(-1))
}
{
  // a burst queued just before the close: too little busy time to say how fast it drained, which is
  // not "idle" with a megabyte never written (review of 29 Sep)
  const { ws, state, attached, logs } = setup()
  ws.msg(sub(1))
  attached[0].channel.send(frame(false, 1, 999_996))
  state.t += 100
  ws.readyState = 3
  ws.emit('close', 1006, Buffer.alloc(0))
  check('... a megabyte queued 0.1 s before: "not measured yet", not "idle"', /; 1 channels, 1\.00 MB never written, draining: not measured yet;/.test(logs.at(-1)), logs.at(-1))
}
{
  // closed by the server itself (too many requests, bad messages, signed out): the reason it gave
  const { ws, logs } = setup()
  ws.msg(sub(1))
  ws.msg({ op: 'sub', id: 2, nvr: 'n1', ch: 3, stream: 1 })
  for (let i = 0; i <= MAX_MALFORMED; i++) ws.msg('not json')
  ws.emit('close', 1008, Buffer.from('bad messages'))
  check('... closed by the server: the reason it gave, and the channels it had then', /^\[live-mux\] a page's socket closed after 0 s: code 1008 "bad messages" \(closed by the server: bad messages\); 2 channels,/.test(logs.at(-1)), logs.at(-1))
}

// ---- the page's socket's drain rate: bytes written a second while it had something queued, from
// ws's write callbacks, over the last DRAIN_WINDOW_MS (adaptive-live logs it at every level change;
// verify-1: queued bytes alone say nothing about how long they take to go) ----
{
  const { ws, state, attached } = setup()
  ws.msg(sub(1))
  const c = attached[0].channel
  check('drainBps: nothing queued yet, so no rate (null)', c.drainBps === null, String(c.drainBps))
  for (let i = 0; i < 4; i++) c.send(frame(false, 1, 99_996)) // 100 KB each with its id
  for (let i = 1; i <= 4; i++) {
    state.t = i * 250
    ws.drain(1)
  }
  check('4 x 100 KB written over the 1 s they were queued: 400 KB/s', Math.round(c.drainBps) === 400_000, String(c.drainBps))
  check('writtenBytes: every byte the page\'s socket has written, ever (adaptive-live\'s grace after a level change)', c.writtenBytes === 400_000, String(c.writtenBytes))
  state.t = 3000
  check('... idle since: still the rate it drained at while it had something to write', Math.round(c.drainBps) === 400_000, String(c.drainBps))
  state.t = 1000 + DRAIN_WINDOW_MS + 1
  check('... nothing queued for a whole window: no rate', c.drainBps === null, String(c.drainBps))
  // a slower stretch, queued throughout: the window holds only it
  const t0 = state.t
  for (let i = 0; i < 12; i++) c.send(frame(false, 1, 99_996))
  for (let i = 1; i <= 8; i++) {
    state.t = t0 + i * 1000
    ws.drain(1)
  }
  check('a backlog written at 100 KB a second: the rate over the last window is that', Math.abs(c.drainBps - 100_000) < 2000, String(c.drainBps))
  check('... the same on every channel of the page', (ws.msg(sub(2)), attached[1].channel.drainBps === c.drainBps))
  // a burst written within a few ms (into the kernel's buffer, not over the link): too short to say
  const { ws: ws2, state: st2, attached: at2 } = setup()
  ws2.msg(sub(1))
  at2[0].channel.send(frame(true, 1, 600_000))
  st2.t = 20
  ws2.drain()
  check('... 600 KB gone in 20 ms: too little busy time to call it a rate (null)', at2[0].channel.drainBps === null, String(at2[0].channel.drainBps))
}

// ---- bufferedAmount: each channel's own part of the socket's queue ----
{
  const { ws, mux, attached } = setup()
  for (const id of [1, 2, 3, 4]) ws.msg(sub(id))
  const [a, b, c] = attached.map((x) => x.channel)
  a.send(frame(false, 1, 600_000))
  b.send(frame(false, 1, 10_000))
  check('a channel\'s bufferedAmount: the bytes of its own frames not written yet (with their id)', a.bufferedAmount === 600_004 && b.bufferedAmount === 10_004 && c.bufferedAmount === 0)
  check('... sharedBufferedAmount: the whole socket\'s, the same on every channel', attached.every((x) => x.channel.sharedBufferedAmount === 610_008) && mux.queued() === 610_008)
  ws.drain(1)
  check('... written: no longer counted (a first, FIFO)', a.bufferedAmount === 0 && b.bufferedAmount === 10_004 && mux.queued() === 10_004)
  ws.msg({ op: 'unsub', id: 2 })
  check('... an ended channel\'s frames still count for the socket until written', mux.queued() === 10_004 && a.sharedBufferedAmount === 10_004)
  ws.drain()
  check('... then nothing', mux.queued() === 0 && a.sharedBufferedAmount === 0)
}
{
  // A remote page in the full-size view over an 8x8 grid: 64 sub channels and the main, 65 on one
  // socket, all going through adaptive-live. The main queues 1 MB on a page whose socket writes 100 KB
  // a second: the page's link is not keeping up. An even share (1 MB / 65) was under the pressure
  // mark until 65 x 256 KB were queued; now every channel reads the whole socket's queue, and how long
  // it takes to go at the rate the socket drains.
  let state = null
  const live = new AdaptiveLive({ pool: new TranscodePool(4), makeTranscoder: () => ({ push() {}, close() {} }), log: () => {}, budgetBps: 1e12, now: () => state.t })
  const src = { gop: [], viewers: new Set(), add(w) { this.viewers.add(w); w.waitForKey = true }, remove(w) { this.viewers.delete(w) } }
  const page = setup({ attach: (channel, s) => { attached.push({ channel, sub: s }); live.attach('page', { ws: channel, nvrId: 'n1', ch: s.ch, type: s.stream, source: src }) } })
  const { ws, attached } = page
  state = page.state
  for (let i = 0; i < 64; i++) ws.msg(sub(i + 1, { ch: i }))
  ws.msg(sub(100, { ch: 5, stream: 0 }))
  const main = attached.at(-1).channel
  state.t = SETTLE_MS + 1
  live.tick()
  check('adaptive-live: 65 channels of one page are one viewer, on the camera\'s own stream while nothing is queued', live.viewers.get('page')?.sockets.size === 65 && live.viewers.get('page').level === 0)
  for (let i = 0; i < 10; i++) main.send(frame(i === 0, 1, 99_996))
  state.t += 1000
  ws.drain(1) // 100 KB in the second since: 900 KB to go, 9 s
  check('... the main queues 1 MB: every channel of the page reads the whole socket\'s queue, and its drain rate', attached.every((a) => a.channel.sharedBufferedAmount === 900_000 && Math.round(a.channel.drainBps) === 100_000) && 900_000 > PRESSURE_BYTES)
  live.tick()
  check('... over a second to go at one look: not yet', live.viewers.get('page').level === 0)
  state.t += 2000
  ws.drain(2)
  live.tick()
  check('... and at the next (7 s to go): the page steps down a level', live.viewers.get('page').level === 1, `level ${live.viewers.get('page').level}`)
  ws.drain()
  for (const a of attached) a.channel.close()
  await tick()
  check('... the channels leave it when they end', !live.viewers.has('page'))
}

// ---- backpressure per channel: a main keeping the queue up does not hold a sub, nor terminate the page ----
{
  // A laptop on weak Wi-Fi (no adaptive-live): the full-size 4K main above the link rate, and its
  // grid sub tile. The page reads all the time, but the queue stays at about 3 MB: over the sub's
  // cap (1 MB), under the main's (4 MB). Every 40 ms: a 60 KB main frame, a 4 KB sub frame.
  const { ws, state, attached } = setup()
  ws.msg(sub(1, { stream: 0 }))
  ws.msg(sub(2, { stream: 1 }))
  const [main, sub1] = attached.map((a) => a.channel)
  let subSent = 0
  let subFrames = 0
  let mainHeld = 0
  for (let t = 0; t <= STUCK_MS + 10_000; t += 40) {
    state.t = t
    const k = t / 40
    if (!fanOut(main, frame(k % 50 === 0, 1, 60_000), k % 50 === 0, 0, t)) mainHeld++
    subFrames++
    if (fanOut(sub1, frame(k % 25 === 0, 2, 4000), k % 25 === 0, 1, t)) subSent++
    ws.drainTo(3 * MB)
  }
  check('a sub next to a main holding the queue at ~3 MB: its own queue is small, it is never held back', subSent === subFrames && sub1.overSince === null, `${subSent}/${subFrames}`)
  check('... and the page\'s socket is not terminated after 30 s (it reads)', !ws.terminated && ws.readyState === 1)
  check('... the main, under its own cap, is not held either', mainHeld === 0 && main.bufferedAmount < CAP_BYTES[0])
}
{
  // a page that stopped reading (a frozen tab): the channel over its cap for STUCK_MS terminates the
  // page's whole socket, as a /live socket was
  const { ws, state, attached } = setup()
  ws.msg(sub(1))
  const c = attached[0].channel
  c.send(frame(false, 1, 700_000))
  c.send(frame(false, 1, 700_000))
  state.t = 1000
  check('over its cap: held back, not terminated yet', !fanOut(c, frame(false), false, 1, 1000) && !ws.terminated && c.overSince === 1000)
  state.t = 1000 + STUCK_MS + 1
  fanOut(c, frame(false), false, 1, state.t)
  check('nothing written for 30 s: the page\'s socket is terminated', ws.terminated && c.readyState === 3)
}
{
  // ... but a socket that is still writing is a slow link, not a frozen tab: the channel just waits
  const { ws, state, attached } = setup()
  ws.msg(sub(1))
  ws.msg(sub(2))
  const [c, d] = attached.map((a) => a.channel)
  d.send(frame(false, 1, 100_000)) // (another channel's frame, ahead of this one's)
  c.send(frame(false, 1, 700_000))
  c.send(frame(false, 1, 700_000))
  fanOut(c, frame(false), false, 1, 1000)
  state.t = 20_000
  ws.drain(1) // the peer reads, slowly
  state.t = 1000 + STUCK_MS + 1
  fanOut(c, frame(false), false, 1, state.t)
  check('over its cap for 30 s while the socket still writes: not terminated, still held', !ws.terminated && ws.readyState === 1 && c.readyState === 1 && c.waitForKey === true)
}

// ---- the socket as a whole: the grid's heaviest held first, then everyone, replays included ----
{
  // 60 light sub tiles and 4 heavy ones: past SOCKET_SOFT_BYTES the heavy ones (queuing more than an
  // even share) are held back, the light ones stay live; a main (the full-size view) is not held there
  const { ws, mux, attached } = setup()
  for (let i = 1; i <= 64; i++) ws.msg(sub(i, { ch: i - 1 }))
  ws.msg(sub(100, { stream: 0 }))
  const chans = attached.map((a) => a.channel)
  const heavy = chans.slice(0, 4)
  const light = chans.slice(4, 64)
  const main = chans[64]
  for (const c of light) c.send(frame(false, 1, 5000))
  for (let i = 0; i < 5; i++) for (const c of heavy) c.send(frame(false, 1, 100_000))
  main.send(frame(false, 1, 600_000))
  check('the queue past the soft mark (every channel under its own cap)', mux.queued() > SOCKET_SOFT_BYTES && mux.queued() < SOCKET_CAP_BYTES && chans.every((c) => c.sharedBufferedAmount === mux.queued()))
  check('... the heavy grid tiles are held back', heavy.every((c) => !fanOut(c, frame(false), false, 1, 0) && c.waitForKey === true))
  check('... the light ones are not', light.every((c) => fanOut(c, frame(false), false, 1, 0)))
  check('... nor the main, under its own cap', fanOut(main, frame(false), false, 0, 0))
  ws.drainTo(SOCKET_SOFT_BYTES / 2)
  check('... once it has drained, a heavy tile resumes on its next keyframe', heavy.every((c) => !fanOut(c, frame(false), false, 1, 0)) && heavy.every((c) => c.bufferedAmount < CAP_BYTES[1]) && (ws.drain(), heavy.every((c) => fanOut(c, frame(true), true, 1, 0))))
}
{
  const { ws, mux, attached } = setup()
  for (const [id, stream] of [[1, 0], [2, 1], [3, 1]]) ws.msg(sub(id, { stream }))
  const [main, s1, s2] = attached.map((a) => a.channel)
  for (let i = 0; i < 5; i++) main.send(frame(false, 1, 1_700_000))
  check('past SOCKET_CAP_BYTES (8 MB): every channel is held back, the main too', mux.queued() > SOCKET_CAP_BYTES && !fanOut(main, frame(true), true, 0, 0) && !fanOut(s1, frame(true), true, 1, 0) && !fanOut(s2, frame(true), true, 1, 0))
  const before = ws.sent.length
  s2.send(frame(true, 1, 50_000)) // a GOP replay (not gated by gateSend)
  check('... and a frame sent past the gate (a GOP replay) is dropped, the channel waits for a keyframe', ws.sent.length === before && s2.waitForKey === true)
  ws.drainTo(SOCKET_CAP_BYTES / 2)
  check('... under the cap again: the channels resume on their keyframes', fanOut(s1, frame(true), true, 1, 0) && (s2.send(frame(true, 3)), ws.frames().at(-1).body[21] === 3))
}
{
  // One signed-in user, the live right to one camera: 128 subs of its main stream, then the page
  // stops reading. Each sub replayed the stream's GOP (1.5 MB) in a copy of its own, and every frame
  // after was copied 128 times: 537 MB queued after 2000 frames, the process heading for OOM.
  const hub = new StreamHub('n1', () => {}, { stopDelayMs: { 0: 5, 1: 5 } })
  const s = hub.getStream(0, 0)
  const made = new Set()
  const mk = (key, size) => { const f = frame(key, 1, size); made.add(f); return f }
  s.onFrame(mk(true, 300_000), true)
  for (let i = 0; i < 12; i++) s.onFrame(mk(false, 100_000), false)
  const { ws, mux, attached } = setup({ attach: (channel) => { attached.push({ channel }); s.add(channel); channel.on('close', () => s.remove(channel)) } })
  for (let id = 1; id <= 128; id++) ws.msg(sub(id, { ch: 0, stream: 0 }))
  const bound = SOCKET_CAP_BYTES + 300_004
  check('128 subs of one camera on a page that does not read: the queue stays bounded', attached.length === 128 && mux.queued() <= bound && ws.bufferedAmount <= bound, `${(mux.queued() / MB).toFixed(1)} MB`)
  for (let i = 0; i < 2000; i++) s.onFrame(mk(i % 50 === 0, i % 50 === 0 ? 300_000 : 20_000), i % 50 === 0)
  check('... and after 2000 more frames', mux.queued() <= bound && ws.bufferedAmount <= bound, `${(mux.queued() / MB).toFixed(1)} MB`)
  const parts = ws.frames().flatMap((m) => m.parts)
  check('... every frame queued is the stream\'s own Buffer, never a copy (the rest: 4-byte ids)', parts.every((p) => made.has(p) || p.length === 4) && parts.some((p) => made.has(p)))
  hub.closeAll()
}
{
  // An 8x8 page's 64 subs in one message batch, each camera's GOP 150 KB (a 30 KB keyframe and
  // deltas). Replayed whole, tiles 1-63's GOPs (9.4 MB) went out before tile 64's keyframe.
  const hub = new StreamHub('n1', () => {}, { stopDelayMs: { 0: 5, 1: 5 } })
  const streams = []
  for (let ch = 0; ch < 64; ch++) {
    const s = hub.getStream(ch, 1)
    s.onFrame(frame(true, ch, 30_000), true)
    for (let i = 0; i < 12; i++) s.onFrame(frame(false, ch, 10_000), false)
    streams.push(s)
  }
  const { ws, attached } = setup({ attach: (channel, x) => { attached.push({ channel }); streams[x.ch].add(channel); channel.on('close', () => streams[x.ch].remove(channel)) } })
  for (let ch = 0; ch < 64; ch++) ws.msg(sub(ch + 1, { ch }))
  const msgs = ws.frames()
  const lastKey = msgs.findIndex((m) => m.id === 64)
  const ahead = msgs.slice(0, lastKey).reduce((a, m) => a + m.raw.length, 0)
  check('64 subs together: the last tile\'s keyframe waits behind at most REPLAY_MAX_BYTES of replays and the other keyframes', lastKey > 0 && ahead <= REPLAY_MAX_BYTES + 63 * 30_004, `${(ahead / MB).toFixed(2)} MB ahead`)
  check('... the first tiles still get their whole GOP (a picture that moves at once)', msgs.filter((m) => m.id === 1).length === 13 && attached[0].channel.waitForKey === false)
  check('... the later ones their keyframe, and wait for the next', msgs.filter((m) => m.id === 64).length === 1 && attached[63].channel.waitForKey === true)
  hub.closeAll()
}

// ---- terminate: the whole socket, every channel ----
{
  const { ws, mux, state, attached, logs } = setup()
  for (const id of [1, 2]) ws.msg(sub(id))
  const counts = attached.map((a) => closeCounter(a.channel))
  attached[0].channel.send(frame(true, 1, 1000))
  state.t = STUCK_MS + 1
  attached[0].channel.terminate()
  check('a channel\'s terminate() on a socket that wrote nothing for 30 s terminates the page\'s socket', ws.terminated)
  check('... every channel is closed at once', attached.every((a) => a.channel.readyState === 3) && mux.channels.size === 0)
  await tick()
  await tick()
  check('... their handlers run once, also after the socket\'s own close', counts.every((n) => n.v === 1))
  check('... and the close is logged as that, with the channels it had', /: code 1006 \(nothing written for 30 s\); 2 channels, 0\.00 MB never written, draining at 0\.0 Mbit\/s;/.test(logs.at(-1)), logs.at(-1))
}

// ---- in the real pipeline: HubStream, gateSend, sub-bridge ----
{
  const hub = new StreamHub('n1', () => {}, { stopDelayMs: { 0: 5, 1: 5 } })
  const s = hub.getStream(3, 1)
  // what live-attach.mjs does on the plain path
  const { ws, attached } = setup({ attach: (channel, sub) => { attached.push({ channel, sub }); s.add(channel); channel.on('close', () => s.remove(channel)) } })
  s.onFrame(frame(true, 1), true) // a running stream: its GOP is replayed to a new viewer
  s.onFrame(frame(false, 2), false)
  ws.msg(sub(9))
  const c = attached[0].channel
  check('HubStream: the GOP is replayed into the channel, keyframe first, with its id', ws.frames().map((f) => `${f.id}:${f.body[21]}`).join() === '9:1,9:2')
  s.onFrame(frame(false, 3), false)
  check('... and the next frames follow', ws.frames().at(-1).body[21] === 3 && s.clients.has(c))
  // another channel's backlog (3 MB, not the grid's: a main) does not hold this one back
  ws.msg(sub(10, { stream: 0 }))
  for (let i = 0; i < 3; i++) attached[1].channel.send(frame(false, 1, MB))
  s.onFrame(frame(false, 4), false)
  check('3 MB queued by another channel: this one\'s own queue is small, its frames still go', ws.frames().filter((f) => f.id === 9).at(-1).body[21] === 4 && c.waitForKey === false)
  ws.drain()
  // its own backlog over the sub cap: held back, then resumes on a keyframe
  c.send(frame(false, 1, 2 * MB))
  s.onFrame(frame(false, 5), false)
  check('its own 2 MB queued (over the 1 MB sub cap): nothing sent, waiting for a keyframe', ws.frames().filter((f) => f.id === 9).length === 5 && c.waitForKey === true && c.overSince != null)
  ws.drain()
  s.onFrame(frame(false, 6), false)
  check('... written: a delta still waits for the keyframe', ws.frames().filter((f) => f.id === 9).length === 5)
  s.onFrame(frame(true, 7), true)
  check('... the keyframe goes, and sending resumes', ws.frames().filter((f) => f.id === 9).at(-1).body[21] === 7 && c.waitForKey === false && c.overSince === null)
  // the NVR removed: HubStream.close ends every viewer 1011
  hub.closeAll()
  const ends = ws.texts().filter((m) => m.id === 9)
  check('NVR removed: the channel gets "end" 1011 "NVR removed"', ends.length === 1 && ends[0].code === 1011 && ends[0].reason === 'NVR removed' && c.readyState === 3)
  await tick()
  check('... and the stream lost its viewer', s.clients.size === 0)
}
{
  // sub-bridge wraps ws.send: a channel's send can be replaced, and the wrapper still prefixes
  const { ws, attached } = setup()
  ws.msg(sub(3))
  const c = attached[0].channel
  const main = { gop: [frame(true, 7)], clients: new Set(), add(t) { this.clients.add(t); for (const m of this.gop) t.send(m) }, remove(t) { this.clients.delete(t) } }
  const b = bridgeSub(c, { sub: { gop: [] }, main, clientH265: true })
  check('sub-bridge: the main stream\'s picture goes to the channel, with its id', ws.frames().length === 1 && ws.frames()[0].id === 3 && ws.frames()[0].body[21] === 7)
  c.send(frame(true, 8)) // the sub-stream's own first frame, through the wrapped send
  check('... the sub-stream\'s first frame ends it and goes through', !b.active() && main.clients.size === 0 && ws.frames().at(-1).body[21] === 8 && ws.frames().at(-1).id === 3)
}

// ---- live-attach.mjs: one viewer's live video, for /live and every channel alike ----
{
  const mkStream = (gop) => ({ gop, viewers: new Set(), add(w) { this.viewers.add(w) }, remove(w) { this.viewers.delete(w) } })
  const mkNvr = ({ online = true, subCold = false } = {}) => ({
    id: 'n1',
    liveOnline: online,
    streams: new Map(),
    getStream(ch, type) {
      const k = `${ch}/${type}`
      if (!this.streams.has(k)) this.streams.set(k, mkStream(type === 1 && subCold ? [] : [frame(true)]))
      return this.streams.get(k)
    }
  })
  const fakeWs = () => ({
    OPEN: 1, readyState: 1, bufferedAmount: 0, closedWith: null, handlers: {}, sent: [],
    send(d) { this.sent.push(d) },
    on(e, f) { (this.handlers[e] ??= []).push(f); return this },
    close(code, reason) { this.closedWith = { code, reason } }
  })
  const req = (addr = '192.168.1.20', headers = {}) => ({ socket: { remoteAddress: addr }, headers: { 'user-agent': 'Desktop', cookie: 'c=1', ...headers } })
  let allowed = true
  const asked = []
  const adaptive = { calls: [], attach(key, o) { this.calls.push({ key, ...o }) } }
  const phone = { ok: true, calls: [], attach(key, stream, type, ws, opts) { this.calls.push({ key, stream, type, ws, opts }); return this.ok } }
  const attachLogs = []
  const attachLive = liveAttacher({ can: (who, action, target) => { asked.push({ who, action, target }); return allowed }, currentUser: () => 'ann', adaptiveLive: adaptive, phoneLive: phone, log: (l) => attachLogs.push(l) })
  const who = { user: 'ann', admin: false }
  const base = { who, ch: 3, streamType: 0, clientH265: false, phone15: false }
  const run = (o = {}, r = req()) => { const w = fakeWs(); const nvr = o.nvr ?? mkNvr(); attachLive(w, r, { ...base, nvr, ...o }); return { w, nvr } }

  allowed = false
  let x = run({ nvr: mkNvr({ online: false }) })
  check('attachLive: no live right: 1008 "not allowed", before anything else (even an offline NVR)', x.w.closedWith?.code === 1008 && x.w.closedWith.reason === 'not allowed' && x.nvr.streams.size === 0 && asked[0].action === 'live' && asked[0].who === who && asked[0].target.nvr === 'n1' && asked[0].target.ch === 3)
  allowed = true
  x = run({ nvr: mkNvr({ online: false }) })
  check('... NVR offline: 1013 "NVR offline"', x.w.closedWith?.code === 1013 && x.w.closedWith.reason === 'NVR offline' && x.nvr.streams.size === 0)
  const bads = [{ ch: NaN }, { ch: -1 }, { ch: 1.5 }, { streamType: 2 }, { streamType: NaN }].map((o) => run(o).w.closedWith)
  check('... a bad channel or stream: 1008 "bad channel or stream"', bads.every((c) => c?.code === 1008 && c.reason === 'bad channel or stream'), JSON.stringify(bads))
  x = run()
  const main = x.nvr.getStream(3, 0)
  check('... on the local network: the camera\'s stream itself', x.w.closedWith === null && main.viewers.has(x.w) && adaptive.calls.length === 0 && phone.calls.length === 0)
  for (const f of x.w.handlers.close) f()
  check('... and it leaves the stream when it closes', main.viewers.size === 0)
  x = run({ streamType: 1, nvr: mkNvr({ subCold: true }) })
  const cold = x.nvr.getStream(3, 1)
  const stand = [...x.nvr.getStream(3, 0).viewers]
  check('... a cold sub-stream: the main stream stands in (sub-bridge), the viewer waits on its sub-stream', cold.viewers.has(x.w) && stand.length === 1 && stand[0].background === true)
  // every stand-in is logged, with its camera and whether the viewer is remote (stutter report 2.6),
  // from its first frame sent
  stand[0].send(frame(true))
  check('... logged with its camera and "local"', attachLogs.at(-1) === "[sub-bridge] n1/4, local viewer: stand-in started: the main stream until the sub-stream's first frame", attachLogs.join(' | '))
  x.w.send(frame(true))
  check('... and its end', /^\[sub-bridge\] n1\/4, local viewer: stand-in ended after [\d.]+ s \(the sub-stream came\): 1 frame, 0\.00 MB sent, 0 held back$/.test(attachLogs.at(-1)), attachLogs.at(-1))
  x = run({ streamType: 1, nvr: mkNvr({ subCold: true }) }, req('127.0.0.1'))
  for (const s of x.nvr.getStream(3, 0).viewers) s.send(frame(true))
  check('... a remote viewer\'s stand-in is logged as remote, and as keyframes', attachLogs.at(-1) === "[sub-bridge] n1/4, remote viewer: stand-in started: the main stream's keyframes until the sub-stream's first frame", attachLogs.at(-1))
  // A remote viewer's stand-in is the main stream's keyframes only, each while its page keeps up
  // (sub-bridge.mjs): on 29 Sep a remote page's stand-ins were whole main streams, 2-5 Mbit/s each
  // into a 3.5-6.5 Mbit/s tunnel (stutter report 2.6, verify-6). A local viewer's is every frame.
  const fed = (addr) => {
    const y = run({ streamType: 1, nvr: mkNvr({ subCold: true }) }, req(addr))
    const [tap] = y.nvr.getStream(3, 0).viewers
    for (const k of [true, false, false, true, false]) tap.send(frame(k))
    return y.w.sent.map((b) => (b[0] === 1 ? 'K' : 'd')).join('')
  }
  check('... a remote viewer\'s stand-in: the main stream\'s keyframes only', fed('127.0.0.1') === 'KK', fed('127.0.0.1'))
  check('... a local viewer\'s: every frame, as before', fed('192.168.1.20') === 'KddKd', fed('192.168.1.20'))
  adaptive.calls.length = 0
  x = run({ clientH265: true }, req('127.0.0.1'))
  const key = createHash('sha1').update('ann|Desktop|c=1').digest('hex')
  const call = adaptive.calls.at(-1)
  check('... a remote viewer: adaptive-live, one key per browser (user, user agent, cookie)', adaptive.calls.length === 1 && call.key === key && call.ws === x.w && call.nvrId === 'n1' && call.ch === 3 && call.type === 0 && call.clientH265 === true && x.nvr.getStream(3, 0).viewers.size === 0)
  // what the NVR saw each stream send (nvrs.mjs codecSeen): a main started on demand has no keyframe
  // yet, and adaptive-live must not send its first one, H.265, to a PC that cannot decode it (stutter
  // report 2.7)
  check('... no codec seen for it: none passed', call.codec === undefined, JSON.stringify(call.codec))
  const seen = mkNvr()
  seen.codecSeen = new Map([['3:0', { codec: 'h265', width: 3840, height: 2160 }], ['3:1', { codec: 'h264' }]])
  run({ nvr: seen }, req('127.0.0.1'))
  run({ nvr: seen, streamType: 1 }, req('127.0.0.1'))
  check('... the codec the NVR saw on that very stream (main H.265, sub H.264)', adaptive.calls.at(-2).codec === 'h265' && adaptive.calls.at(-2).type === 0 && adaptive.calls.at(-1).codec === 'h264' && adaptive.calls.at(-1).type === 1, JSON.stringify(adaptive.calls.slice(-2).map((c) => c.codec)))
  x = run({ phone15: true }, req('192.168.1.20', { 'user-agent': 'Mozilla/5.0 (iPhone)' }))
  check('... a phone asking for 15 fps: the shared thinned stream', phone.calls.length === 1 && phone.calls[0].key === 'n1/3/0' && phone.calls[0].ws === x.w && x.nvr.getStream(3, 0).viewers.size === 0)
  check('... which names its camera in the log, the channel from 1', phone.calls[0].opts?.camera === 'n1/4', JSON.stringify(phone.calls[0].opts))
  phone.ok = false
  x = run({ phone15: true }, req('192.168.1.20', { 'user-agent': 'Mozilla/5.0 (iPhone)' }))
  check('... no room for it: the camera\'s own stream', phone.calls.length === 2 && x.nvr.getStream(3, 0).viewers.has(x.w))
  x = run({ phone15: true })
  check('... 15 fps asked by a desktop: the camera\'s own stream', phone.calls.length === 2 && x.nvr.getStream(3, 0).viewers.has(x.w))
  // and a mux channel through it: the refusal is an "end", the page's socket stays
  const off = mkNvr({ online: false })
  const m = setup({ attach: (channel, s) => attachLive(channel, req(), { nvr: off, who, ch: s.ch, streamType: s.stream, clientH265: s.h265, phone15: s.fps === 15 }) })
  m.ws.msg(sub(5))
  check('... on a channel, NVR offline is "end" 1013 for that id, the socket stays', JSON.stringify(m.ws.texts()) === '[{"op":"end","id":5,"code":1013,"reason":"NVR offline"}]' && m.ws.readyState === 1)
  // the watch (access-watch.mjs): one let in is tracked for the live right on its camera, with its own
  // request (the session asked again later); a refused one never is
  const tracked = []
  const watched = liveAttacher({ can: () => allowed, currentUser: () => 'ann', adaptiveLive: adaptive, phoneLive: phone, track: (w, r, what) => tracked.push({ w, r, what }) })
  allowed = false
  watched(fakeWs(), req(), { ...base, nvr: mkNvr() })
  allowed = true
  watched(fakeWs(), req(), { ...base, nvr: mkNvr({ online: false }) })
  watched(fakeWs(), req(), { ...base, nvr: mkNvr(), ch: -1 })
  const inWs = fakeWs()
  const inReq = req()
  watched(inWs, inReq, { ...base, nvr: mkNvr() })
  check('... let in: tracked with the live right on its camera and its own request; refused (rights, offline, bad channel): not', tracked.length === 1 && tracked[0].w === inWs && tracked[0].r === inReq && JSON.stringify(tracked[0].what) === '{"actions":["live"],"nvr":"n1","ch":3}', JSON.stringify(tracked.map((t) => t.what)))
}

// ---- live-attach.mjs: a sub-stream held at the NVR's sub-stream limit (value4u: 15, sub-cap.mjs) ----
// the tile gets the main stream meanwhile; a phone that cannot play the H.265 it is gets it converted
{
  const mkStream = (gop) => ({ gop, viewers: new Set(), add(w) { this.viewers.add(w) }, remove(w) { this.viewers.delete(w) } })
  const mkNvr = ({ held = true, full = false, mainCodec = 'h265', subCodec = 'h264', mainPlaying = true } = {}) => ({
    id: 'v4', liveOnline: true, streams: new Map(),
    codecSeen: new Map([['3:0', { codec: mainCodec }], ['3:1', { codec: subCodec }]]),
    subHeld: (ch) => held && ch === 3,
    subFull: () => full,
    mainPlaying: (ch) => mainPlaying && ch === 3,
    getStream(ch, type) {
      const k = `${ch}/${type}`
      if (!this.streams.has(k)) this.streams.set(k, mkStream(type === 1 ? [] : [frame(true)]))
      return this.streams.get(k)
    }
  })
  const fakeWs = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, closedWith: null, handlers: {}, sent: [], send(d) { this.sent.push(d) }, on(e, f) { (this.handlers[e] ??= []).push(f); return this }, close(code, reason) { this.closedWith = { code, reason } } })
  const phoneReq = { socket: { remoteAddress: '192.168.1.30' }, headers: { 'user-agent': 'Mozilla/5.0 (iPhone)', cookie: 'c=1' } }
  const deskReq = { socket: { remoteAddress: '192.168.1.20' }, headers: { 'user-agent': 'Desktop', cookie: 'c=1' } }
  const mkPhone = (free = 16, running = []) => ({ free, calls: [], detached: [], attach(key, stream, type, ws, opts) { this.calls.push({ key, stream, type, ws, opts }); return true }, detach(key, ws) { this.detached.push({ key, ws }) }, room() { return this.free }, has(key) { return running.includes(key) } })
  const heldLogs = []
  const run = ({ nvr = mkNvr(), phone = mkPhone(), r = phoneReq, clientH265 = false } = {}) => {
    const attach = liveAttacher({ can: () => true, currentUser: () => 'ann', adaptiveLive: { attach() {} }, phoneLive: phone, log: (l) => heldLogs.push(l) })
    const w = fakeWs()
    attach(w, r, { nvr, who: { user: 'ann' }, ch: 3, streamType: 1, clientH265, phone15: true })
    return { w, nvr, phone, sub: nvr.getStream(3, 1), main: nvr.getStream(3, 0) }
  }
  const KEY = 'v4/3/0/standin'
  let x = run()
  const conv = x.phone.calls.find((c) => c.key === KEY)
  check('held sub, phone, H.265 main that plays: the stand-in is the main converted for phones, a conversion of its own asking in the background', conv && conv.stream === x.main && conv.type === 0 && conv.opts?.background === true && conv.ws.background === true && x.main.viewers.size === 0, JSON.stringify(x.phone.calls.map((c) => c.key)))
  check('... its conversion names its camera in the log', conv?.opts?.camera === 'v4/4', JSON.stringify(conv?.opts))
  conv.ws.send(frame(true)) // the conversion's first frame
  check('... its stand-in logged as held, and converted for a phone', heldLogs.at(-1) ==="[sub-bridge] v4/4, local viewer, sub-stream held at the NVR's limit, main converted for a phone: stand-in started: the main stream until the sub-stream's first frame", heldLogs.join(' | '))
  check('... the held sub-stream itself is not thinned (nothing to thin; no conversion place held for it)', !x.phone.calls.some((c) => c.key === 'v4/3/1') && x.sub.viewers.has(x.w))
  x.w.send(frame(true)) // the sub-stream's first frame (there is room now): the stand-in ends
  check('... its first frame ends the stand-in, and the converted stream is let go', x.phone.detached.length === 1 && x.phone.detached[0].key === KEY && x.phone.detached[0].ws === conv.ws)
  x = run({ phone: mkPhone(PHONE_SPARE - 1) })
  check(`... fewer than ${PHONE_SPARE} conversions free: the main as it is (as before)`, x.phone.calls.length === 0 && [...x.main.viewers].some((v) => v.background === true))
  x = run({ phone: mkPhone(0, [KEY]) })
  check('... none free, but that stand-in conversion already runs: joined (it costs no place)', x.phone.calls.some((c) => c.key === KEY))
  x = run({ clientH265: true })
  check('... a phone that plays H.265: the main as it is', !x.phone.calls.some((c) => c.key === KEY) && x.main.viewers.size === 1)
  x = run({ nvr: mkNvr({ mainCodec: 'h264' }) })
  check('... an H.264 main: as it is', !x.phone.calls.some((c) => c.key === KEY) && x.main.viewers.size === 1)
  x = run({ nvr: mkNvr({ mainPlaying: false }) })
  check('... a main that does not play: no conversion started for it (never makes the NVR start one)', !x.phone.calls.some((c) => c.key === KEY))
  x = run({ nvr: mkNvr({ held: false }) })
  check('... a sub-stream that is only cold (not held, here in ~2 s): no conversion started for it, the sub thinned as before', !x.phone.calls.some((c) => c.key === KEY) && x.phone.calls.some((c) => c.key === 'v4/3/1' && c.ws === x.w) && x.main.viewers.size === 1)
  x = run({ nvr: mkNvr({ held: false, full: true }) })
  check('... not in the worker\'s list yet, but the NVR is at its limit: treated as held at once (converted stand-in, not thinned)', x.phone.calls.some((c) => c.key === KEY) && !x.phone.calls.some((c) => c.key === 'v4/3/1'))
  x = run({ nvr: mkNvr({ subCodec: 'h265' }) })
  check('... a held H.265 sub-stream is still thinned (a phone may not play it as it is)', x.phone.calls.some((c) => c.key === 'v4/3/1' && c.ws === x.w))
  x = run({ r: deskReq })
  check('... a desktop: the main as it is, the viewer on its held sub-stream', x.phone.calls.length === 0 && x.main.viewers.size === 1 && x.sub.viewers.has(x.w))
  // with the real hub and phone-live: the worker is asked for the main in the background only
  {
    const { PhoneLive } = await import('../phone-live.mjs')
    const sent = []
    const hub = new StreamHub('v4', (m) => sent.push(m))
    const nvr = { ...mkNvr(), getStream: (ch, type) => hub.getStream(ch, type) }
    const phoneLive = new PhoneLive({ pool: new TranscodePool(16), makeTranscoder: () => ({ push() {}, close() {} }), log: () => {} })
    const attach = liveAttacher({ can: () => true, currentUser: () => 'ann', adaptiveLive: { attach() {} }, phoneLive, log: () => {} })
    attach(fakeWs(), phoneReq, { nvr, who: { user: 'ann' }, ch: 3, streamType: 1, clientH265: false, phone15: true })
    const mains = sent.filter((m) => m.t === 'want' && m.ch === 3 && m.type === 0)
    check('... real hub + phone-live: the stand-in\'s conversion asks the worker for the main as background, never foreground', mains.length === 1 && mains[0].background === true && phoneLive.has(KEY), JSON.stringify(sent))
  }
}

// ---- live-attach.mjs: an H.265 main standing in for a browser without H.265 is said once in
// H265_QUIET_MS per camera and viewer. It sends nothing and ends at once, and the tile, with no
// picture, asks again every 8-16 s: 14-16 held tiles on value4u were about 2 lines a second for as
// long as the owner's page was open (review of 29 Sep) ----
{
  // a main stream as stream-hub.mjs has it: add replays its GOP (here an H.265 keyframe) at once
  const mkStream = (gop) => ({ gop, viewers: new Set(), add(w) { this.viewers.add(w); for (const m of this.gop) w.send(m) }, remove(w) { this.viewers.delete(w) } })
  const h265Key = () => { const b = frame(true); b[1] = 1; return b }
  const mkNvr = () => ({
    id: 'v4', liveOnline: true, streams: new Map(),
    subHeld: () => true,
    getStream(ch, type) {
      const k = `${ch}/${type}`
      if (!this.streams.has(k)) this.streams.set(k, mkStream(type === 1 ? [] : [h265Key()]))
      return this.streams.get(k)
    }
  })
  const fakeWs = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, sent: [], send(d) { this.sent.push(d) }, on() { return this }, close() {} })
  const deskReq = (cookie = 'c=1') => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'user-agent': 'Desktop', cookie } })
  const logs = []
  let t = 0
  const attach = liveAttacher({ can: () => true, currentUser: () => 'ann', adaptiveLive: { attach() {} }, phoneLive: {}, log: (l) => logs.push(l), now: () => t })
  const nvr = mkNvr()
  const open = (ch = 19, r = deskReq()) => attach(fakeWs(), r, { nvr, who: { user: 'ann' }, ch, streamType: 1, clientH265: false, phone15: false })
  open()
  check('an H.265 stand-in for a browser without H.265: one line, saying it is said once in 10 min', logs.length === 1 && logs[0] === "[sub-bridge] v4/20, remote viewer, sub-stream held at the NVR's limit: stand-in ended after 0.0 s, having sent nothing (the main stream is H.265, which this browser cannot play); said once in 10 min for this camera and viewer", JSON.stringify(logs))
  for (let i = 1; i <= 50; i++) {
    t = i * 10_000 // the tile asking again every 10 s, for 500 s
    open()
  }
  check('... asked again every 10 s for 500 s: nothing more', logs.length === 1, `${logs.length} lines`)
  open(20)
  open(19, deskReq('c=2'))
  check('... another camera, or another viewer: its own line', logs.length === 3 && logs[1].startsWith('[sub-bridge] v4/21, ') && logs[2].startsWith('[sub-bridge] v4/20, '), JSON.stringify(logs.slice(1)))
  t = H265_QUIET_MS
  open()
  check('... 10 min on: said again, with how many were left out', logs.length === 4 && logs[3].endsWith('; said once in 10 min for this camera and viewer, 50 left out since the last'), logs.at(-1))
}

// ---- a remote page with stand-ins, in the real pipeline: live-attach.mjs, sub-bridge.mjs,
// stream-hub.mjs and the page's socket over a link of 5 Mbit/s, the owner's tunnel on 29 Sep (3.5-6.5
// Mbit/s). A stand-in's main reaches the parent once the stand-in wants it: first the worker's replay
// of its GOP so far, at once, through the fan-out (verify-6), then its frames as they come. H.264
// throughout (this PC plays no H.265: the H.265 mains of a page stand in for nothing). ----
{
  const LINK = 5e6 / 8 // bytes a second
  const STEP = 5 // ms
  const bufs = new Map()
  /** A frame of `size` bytes, H.264; body[21] says whose: 'M' a main stream's, 'S' a sub-stream's. */
  const tagged = (key, main, size) => {
    const k = `${key}${main}${size}`
    if (!bufs.has(k)) bufs.set(k, frame(key, main ? 77 : 83, size))
    return bufs.get(k)
  }
  /**
   * The page's tiles subscribe 15 ms apart, from 0, and it plays for durMs; at full, every tile on the
   * camera's own stream (the level controller is adaptive-live.test's).
   * @param {string} addr the viewer's address: 127.0.0.1 through the tunnel, else the local network
   * @param {{ subs: { ch: number, cam: object }[], mains: { [ch: number]: [number, number, number, number] },
   *   held?: number[], durMs: number, keysOnly?: boolean }} page mains: a stand-in's main as [Mbit/s,
   *   keyframe KB, GOP KB, running since (ms, before the page opened: where in its GOP it is)], 20 fps;
   *   held: sub-streams held at the NVR's limit; keysOnly: the mains' keyframes alone reach the stand-ins
   *   (with a local address: keyframes only, under nothing but the stand-in's own gate)
   * @returns {{ maxQueue: number, subWaitMs: number, standIn: number, pictures: Map<number, { at: number, key: boolean }[]>, logs: string[] }}
   *   maxQueue: the most the page's socket had queued; subWaitMs: the longest a sub-stream's frame
   *   waited on it; standIn: the stand-ins' bytes; pictures: per channel, when its stand-in's frames went
   */
  const playPage = (addr, { subs: tiles, mains: measured, held = [], durMs, keysOnly = false }) => {
    const hub = new StreamHub('nvr-2', () => {}, { stopDelayMs: { 0: 5, 1: 5 } })
    const nvr = { id: 'nvr-2', liveOnline: true, getStream: (ch, type) => hub.getStream(ch, type), subHeld: (ch) => held.includes(ch), subFull: () => false }
    const adaptiveLive = { attach(key, { ws, source }) { source.add(ws); ws.on('close', () => source.remove(ws)) } }
    const logs = []
    const attachLive = liveAttacher({ can: () => true, currentUser: () => 'ann', adaptiveLive, phoneLive: {}, log: (l) => logs.push(l) })
    const r = { socket: { remoteAddress: addr }, headers: { 'user-agent': 'Desktop', cookie: 'c=1' } }
    const { ws, state } = setup({ attach: (channel, s) => attachLive(channel, r, { nvr, who: { user: 'ann' }, ch: s.ch, streamType: s.stream, clientH265: false, phone15: false }) })
    const src = (ch, type, cam) => ({ ch, type, cam, stream: hub.getStream(ch, type), next: Math.ceil(cam.from / cam.every), first: Math.ceil(cam.from / cam.every), lastKey: null, replayed: false })
    const subs = tiles.map((t) => src(t.ch, 1, t.cam))
    const mains = Object.entries(measured).map(([ch, [mbps, keyKB, gopKB, from]]) => src(Number(ch), 0, camera({ fps: 20, kbps: mbps * 1000, gopS: (gopKB * 8) / (mbps * 1000), keyShare: keyKB / gopKB, from })))
    // every frame of a stream due by `upTo` (ms after the page opened)
    const frames = (s, upTo) => {
      while (s.next * s.cam.every <= upTo) {
        const n = s.next++
        const key = (n - s.first) % s.cam.perGop === 0
        if (key) s.lastKey = n
        if (s.type === 0 && !s.stream.wanted) continue
        if (s.type === 0 && !s.replayed) {
          s.replayed = true
          for (let m = s.lastKey; m < (keysOnly ? Math.min(n, s.lastKey + 1) : n); m++) s.stream.onFrame(tagged(m === s.lastKey, true, m === s.lastKey ? s.cam.key : s.cam.delta), m === s.lastKey)
        }
        if (s.type === 0 && keysOnly && !key) continue
        s.stream.onFrame(tagged(key, s.type === 0, key ? s.cam.key : s.cam.delta), key)
      }
    }
    for (const s of subs) if (s.cam.from < 0) frames(s, -1)
    for (const s of mains) frames(s, -1)
    // the link: each message is written once the link has had the time for all of it; the time each
    // one was queued at is kept beside the socket's queue, in the same order
    const queuedAt = []
    let stamped = 0
    let credit = 0
    const out = { maxQueue: 0, subWaitMs: 0, standIn: 0, pictures: new Map(), logs }
    for (let at = 0; at <= durMs; at += STEP) {
      state.t = at
      credit += (LINK * STEP) / 1000
      while (ws.queue.length && credit >= ws.queue[0].bytes) {
        credit -= ws.queue[0].bytes
        const m = queuedAt.shift()
        if (m.sub) out.subWaitMs = Math.max(out.subWaitMs, at - m.at)
        ws.drain(1)
      }
      if (!ws.queue.length) credit = 0 // an idle link saves nothing up
      subs.forEach((s, i) => { if (at === i * 15) ws.msg({ op: 'sub', id: s.ch + 1, nvr: 'nvr-2', ch: s.ch, stream: 1 }) })
      for (const s of subs) frames(s, at)
      for (const s of mains) frames(s, at)
      for (; stamped < ws.sent.length; stamped++) {
        const d = ws.sent[stamped]
        const f = typeof d === 'string' ? null : Buffer.concat(d.parts)
        queuedAt.push({ at, sub: f?.[4 + 21] === 83 })
        if (f?.[4 + 21] === 77) {
          out.standIn += f.length - 4
          const ch = f.readUInt32LE(0) - 1
          out.pictures.set(ch, [...(out.pictures.get(ch) ?? []), { at, key: f[4] === 1 }])
        }
      }
      out.maxQueue = Math.max(out.maxQueue, ws.bufferedAmount)
    }
    return out
  }
  const mb = (n) => (n / 1e6).toFixed(2)
  const said = (a, b) => `remote: ${mb(a.maxQueue)} MB queued at most, sub frames waiting up to ${a.subWaitMs} ms, ${mb(a.standIn)} MB of stand-ins; every frame: ${mb(b.maxQueue)} MB, ${b.subWaitMs} ms, ${mb(b.standIn)} MB`
  /**
   * A stand-in's pictures: how many, all keyframes, the first (ms after its tile asked), and the longest
   * without one until `until`: from its tile asking (gap), and once it had one (apart: what its tile
   * counts as no video, live-tile.js; one with no picture yet waits without saying so).
   */
  const shown = (o, ch, askedAt, until) => {
    const p = (o.pictures.get(ch) ?? []).filter((x) => x.at <= until)
    const edges = [askedAt, ...p.map((x) => x.at), until]
    const gaps = edges.slice(1).map((x, i) => x - edges[i])
    return { ch, n: p.length, keys: p.every((x) => x.key), first: p.length ? p[0].at - askedAt : null, gap: Math.max(...gaps), apart: p.length ? Math.max(...gaps.slice(1)) : null }
  }

  // The 03:55 page of 29 Sep (stutter report 2.6, verify-6; the page adaptive-live.test.mjs replays for
  // its levels): 16 nvr-2 sub tiles, 5 of them running, 11 cold and starting when the journal has them
  // start (1.05 to 29.32 s after the page opened), each 250 kbit/s at 18-30 fps. The H.264 mains of three
  // of the cold ones stand in until then, as measured: nvr-2/10 5.18 Mbit/s, keyframe 634 KB of a 1279
  // KB GOP, until 8.58 s; /17 3.99 Mbit/s, 499 of 950 KB, until 10.27 s; /21 2.25 Mbit/s, 243 of 690 KB,
  // until 27.13 s.
  const cold = [1.05, 2.16, 3.35, 4.72, 6.51, 8.58, 10.27, 12.25, 24.38, 27.13, 29.32]
  const coldCh = [2, 3, 4, 6, 7, 9, 16, 18, 19, 20, 21] // cams 3, 4, 5, 7, 8, 10, 17, 19, 20, 21, 22
  const warmCh = [0, 1, 5, 17, 22] // cams 1, 2, 6, 18, 23
  const fps = [20.6, 20.6, 30, 30, 18.3, 20.6, 30, 25.4, 30, 30, 20, 20, 25.4, 27.5, 30, 20]
  const p0355 = {
    subs: [
      ...warmCh.map((ch, i) => ({ ch, cam: camera({ fps: fps[i], kbps: 250, from: -5000 - i * 413 }) })),
      ...coldCh.map((ch, i) => ({ ch, cam: camera({ fps: fps[5 + i], kbps: 250, from: cold[i] * 1000 }) }))
    ],
    mains: { 9: [5.18, 634, 1279, -10_000], 16: [3.99, 499, 950, -10_700], 20: [2.25, 243, 690, -11_300] },
    durMs: 32_000
  }
  const before = playPage('192.168.1.20', p0355) // every frame, as a local viewer still gets them, and as a remote one did
  const after = playPage('127.0.0.1', p0355) // through the tunnel
  console.log(`INFO  the 03:55 page open over 5 Mbit/s, ${said(after, before)}`)
  check('the 03:55 page with every stand-in frame (as on 29 Sep): the page backs up over 4 MB, its tiles over 6 s behind', before.maxQueue > 4e6 && before.subWaitMs > 6000, said(after, before))
  // Keyframes alone are still about half of these mains (/10: 634 KB of its 1279 KB GOP every 2 s, 2.6
  // Mbit/s). Keyframes only, under nothing but the stand-in's own gate (its 4 MB cap; verify-6's fix as
  // it stood): as bad as every frame. Hence a remote viewer's waits for the page's room (sub-bridge.mjs).
  const gated = playPage('192.168.1.20', { ...p0355, keysOnly: true })
  const gatedSaid = `${mb(gated.maxQueue)} MB queued at most, sub frames waiting up to ${gated.subWaitMs} ms, ${mb(gated.standIn)} MB of stand-ins`
  console.log(`INFO  ... keyframes only under the stand-in's own cap: ${gatedSaid}`)
  check('... keyframes only, under the stand-in\'s own 4 MB cap: still over 4 MB queued, its tiles over 6 s behind', gated.maxQueue > 4e6 && gated.subWaitMs > 6000, gatedSaid)
  // a stand-in's keyframe goes only if the page's queue with it goes within ROOM_S (0.6 s) at the rate
  // its socket drains, or, that rate not measured yet, into less than RESUME_BELOW: at most that and
  // the biggest keyframe (634 KB), with the frames the page's tiles send meanwhile
  check('... a remote viewer\'s: under 1.1 MB queued, and no tile\'s frame waits 2 s', after.maxQueue < 1.1e6 && after.subWaitMs < 2000, said(after, before))
  // ROOM_S of 5 Mbit/s is 375 KB with what the page has queued. /21's 243 KB keyframes fit, one a GOP
  // once the page's opening replays have gone; /10's 634 KB and /17's 499 KB never do. /10's first
  // went as its tile asked, the page's rate not measured yet, and its tile held that picture until its
  // own sub-stream came, 8.4 s on; /17's showed nothing until its own.
  const shows = [9, 16, 20].map((ch) => shown(after, ch, p0355.subs.findIndex((t) => t.ch === ch) * 15, cold[coldCh.indexOf(ch)] * 1000))
  const [s10, s17, s21] = shows
  check('... its stand-ins: keyframes that fit the page\'s room: /21\'s one a GOP (2.45 s) from 3.2 s, /17\'s none, /10\'s first alone, as its tile asked', shows.every((s) => s.keys) && s21.n >= 8 && s21.first < 3500 && s21.apart <= 2450 && s17.n === 0 && s10.n === 1 && s10.first === 0, JSON.stringify(shows))
  check('... its log lines say keyframes', after.logs.some((l) => /^\[sub-bridge\] nvr-2\/10, remote viewer: stand-in ended after [\d.]+ s \(the sub-stream came\): \d+ keyframes?, [\d.]+ MB sent, \d+ held back$/.test(l)), after.logs.join(' | '))
  // (With every frame all three showed at once, 7 s behind like every tile of the page. With keyframes
  // let through while the page had less than RESUME_BELOW queued, /10's came at least every 4 s, but
  // they stepped the whole page down in about half the phases of its keyframes: adaptive-live.test.mjs.
  // That is the cost: a main whose keyframe is more than ROOM_S of the link shows nothing, or at a
  // page's opening its first picture held, until its own sub-stream comes, as with no stand-in. Held
  // 8.4 s, as /10's here, its tile says "no video" from 5 s and may reconnect at 8 (live-tile.js looks
  // once a second).)

  // A tile held at the NVR's sub-stream limit (value4u holds 14-16 for minutes; verify-6), its main as
  // nvr-2/21's (2.25 Mbit/s, 243 KB keyframes every 2.45 s), on a page of 15 running sub-streams (3.75
  // Mbit/s): its first picture once the page's opening replays have gone, then one a GOP, never long
  // enough without one for its tile to say "no video" (5 s, live-tile.js NO_VIDEO_MS), and the page
  // keeps up. With every frame the page carries 6 Mbit/s.
  const pHeld = {
    subs: [
      ...Array.from({ length: 15 }, (_, ch) => ({ ch, cam: camera({ fps: 20 + (ch % 3) * 5, kbps: 250, from: -3000 - ch * 211 }) })),
      { ch: 15, cam: camera({ fps: 20, kbps: 250, from: 1e9 }) }
    ],
    mains: { 15: [2.25, 243, 690, -11_300] },
    held: [15],
    durMs: 60_000
  }
  const heldBefore = playPage('192.168.1.20', pHeld)
  const heldAfter = playPage('127.0.0.1', pHeld)
  console.log(`INFO  a held tile's stand-in for 60 s, ${said(heldAfter, heldBefore)}`)
  const h = shown(heldAfter, 15, 15 * 15, pHeld.durMs)
  check('a held tile\'s stand-in on a remote page: its first within 6 s, then a keyframe a GOP (2.45 s)', h.keys && h.n >= 20 && h.first < 6000 && h.apart <= 2450, JSON.stringify(h))
  check('... and the page keeps up: under 1 MB queued, no tile\'s frame waits 1.5 s (every frame: over 4 MB, 6 s)', heldAfter.maxQueue < 1e6 && heldAfter.subWaitMs < 1500 && heldBefore.maxQueue > 4e6 && heldBefore.subWaitMs > 6000, said(heldAfter, heldBefore))
  check('... its lines say it is held, and keyframes', heldAfter.logs[0] === "[sub-bridge] nvr-2/16, remote viewer, sub-stream held at the NVR's limit: stand-in started: the main stream's keyframes until the sub-stream's first frame", heldAfter.logs.join(' | '))
}

// ---- server.mjs wiring (source shape: importing server.mjs starts the NVRs) ----
{
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  check('the upgrade lets /live-mux through, with the same origin and session checks as /live', /\['\/live', '\/live-mux', '\/playback', '\/motion'\]\.includes\(url\.pathname\) \|\| !sameOrigin \|\| !currentUser\(req\)/.test(src))
  check('/live-mux is upgraded by a ws server of its own, whose maxPayload is MAX_MESSAGE_BYTES', /const muxWss = new WebSocketServer\(\{ noServer: true, maxPayload: MAX_MESSAGE_BYTES \}\)/.test(src) && /const server = url\.pathname === '\/live-mux' \? muxWss : wss\n\s*server\.handleUpgrade\(req, socket, head, \(ws\) => server\.emit\('connection', ws, req\)\)/.test(src))
  check('... pinged like the others, with the same connection handler', /keepAlive\(muxWss\)/.test(src) && /wss\.on\('connection', onConnection\)/.test(src) && /muxWss\.on\('connection', onConnection\)/.test(src))
  const conn = src.slice(src.indexOf('const onConnection'))
  check('/live-mux is served right after meterSocket, before the NVR lookup', /meterSocket\(ws, [^)]*\)\n[\s\S]*?if \(url\.pathname === '\/live-mux'\) \{\n\s*serveMux\(ws,/.test(conn) && conn.indexOf("'/live-mux'") < conn.indexOf('nvrs.get('))
  check('/live and every mux channel go through the same attachLive (live-attach.mjs)', (src.match(/attachLive\((ws|channel), req,/g) ?? []).length === 2 && /const attachLive = liveAttacher\(\{ can, currentUser, adaptiveLive, phoneLive, track: watch\.track \}\)/.test(src) && !/function attachLive/.test(src))
  check('the session is checked again for each sub', /session: \(\) => currentUser\(req\)/.test(src))
  check('the page socket\'s close is logged as remote or local, by the rule live-attach uses', /serveMux\(ws, \{[\s\S]{0,400}?who: isRemoteAddress\(req\.socket\.remoteAddress\) \? 'remote' : 'local'/.test(src))
}

// ---- over a real ws socket ----
{
  const http = createServer()
  // as server.mjs has it: /live-mux on a server of its own
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  const streams = []
  let read = 0
  http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)))
  wss.on('connection', (ws) => {
    ws.on('message', () => read++)
    serveMux(ws, {
      session: () => 'ann',
      attach: (channel, sub) => {
        if (sub.ch === 13) return channel.close(1013, 'NVR offline')
        streams.push(channel)
      },
      log: () => {}
    })
  })
  await new Promise((r) => http.listen(0, '127.0.0.1', r))
  const url = `ws://127.0.0.1:${http.address().port}/live-mux`
  const open = (u) => new Promise((resolve, reject) => {
    const c = new WebSocket(u)
    c.binaryType = 'nodebuffer'
    c.got = []
    c.on('message', (d, isBinary) => c.got.push(isBinary ? d : JSON.parse(String(d))))
    c.closed = new Promise((r) => c.on('close', (code, reason) => r({ code, reason: String(reason) })))
    c.on('open', () => resolve(c))
    c.on('error', reject)
  })
  const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)) }

  const c = await open(url)
  c.send(JSON.stringify(sub(21)))
  c.send(JSON.stringify(sub(22, { ch: 13 })))
  c.send(JSON.stringify(sub(23, { ch: 4 })))
  await until(() => streams.length === 2 && c.got.length === 1)
  streams[0].send(frame(true, 4))
  await until(() => c.got.length === 2)
  const bin = c.got.find(Buffer.isBuffer)
  const end = c.got.find((m) => !Buffer.isBuffer(m))
  check('real ws: a refused channel\'s "end" arrives as text', end?.op === 'end' && end.id === 22 && end.code === 1013 && end.reason === 'NVR offline', JSON.stringify(end))
  check('real ws: a frame arrives as one binary message, id first', bin?.readUInt32LE(0) === 21 && bin.subarray(4).equals(frame(true, 4)))
  // two channels' frames interleaved, big and small, with a text message between: each whole
  const sizes = [70_000, 24, 200_000, 1000, 24, 150_000]
  sizes.forEach((n, i) => { streams[i % 2].send(frame(i === 0, 10 + i, n)); if (i === 2) streams[1].close(1011, 'NVR removed') })
  await until(() => c.got.length === 2 + sizes.length)
  const tail = c.got.slice(2)
  const want = sizes.map((n, i) => (i % 2 === 1 && i > 2 ? null : { id: i % 2 === 0 ? 21 : 23, tag: 10 + i, n })).filter(Boolean)
  const bins = tail.filter(Buffer.isBuffer)
  check('real ws: frames of several channels, fragments back to back: every message whole, in order', bins.length === want.length && bins.every((b, i) => b.readUInt32LE(0) === want[i].id && b.length === want[i].n + 4 && b[4 + 21] === want[i].tag) && tail.some((m) => m.op === 'end' && m.id === 23), JSON.stringify(tail.map((m) => (Buffer.isBuffer(m) ? `${m.readUInt32LE(0)}:${m.length}` : m.op))))
  await until(() => streams[0].bufferedAmount === 0)
  check('real ws: the channel\'s queue drains to 0 once ws has written it', streams[0].bufferedAmount === 0 && streams[0].sharedBufferedAmount === 0 && streams[0].readyState === 1)
  // a message over 1024 bytes: ws refuses it from its header (1009), the mux never reads it
  const before = read
  c.send('x'.repeat(64 * 1024))
  const shut = await c.closed
  check('real ws: a message over 1024 bytes closes the socket 1009, unread (maxPayload)', shut.code === 1009 && read === before, JSON.stringify(shut))
  await until(() => streams[0].readyState === 3)
  check('real ws: ... and its channels end', streams[0].readyState === 3)

  const e = await open(url)
  e.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false })
  const bad = await e.closed
  check('real ws: a frame ws cannot read closes that socket (1007), not the server', bad.code === 1007, JSON.stringify(bad))

  const d = await open(url)
  for (let i = 0; i <= MAX_MALFORMED; i++) d.send(Buffer.from([1, 2, 3]))
  const dshut = await d.closed
  check('real ws: 21 binary messages close the socket 1008', dshut.code === 1008 && dshut.reason === 'bad messages', JSON.stringify(dshut))

  wss.close()
  http.close()
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
