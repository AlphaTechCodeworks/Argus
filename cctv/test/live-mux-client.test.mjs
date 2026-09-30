// The shared live connection, browser side (public/live-mux.js): every tile's stream on ONE
// WebSocket to /live-mux instead of a socket per tile (the browser opens those one at a time: an 8x8
// grid took ~16 s through the public link). Stand-ins for the page, WebSocket and the clock; no
// server, no browser.
// Run:  node cctv/test/live-mux-client.test.mjs
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---- stand-ins (before the import: the module registers its listeners as it loads)
const listeners = {}
globalThis.addEventListener = (type, fn) => (listeners[type] ??= []).push(fn)
const fire = (type, e = {}) => { for (const fn of listeners[type] ?? []) fn(e) }
globalThis.window = { devicePixelRatio: 1 }
globalThis.requestAnimationFrame = () => 1
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.location = { protocol: 'http:', host: 'x' }
let store = {}
globalThis.localStorage = { getItem: (k) => store[k] ?? null }

let now = 1_000_000
const sockets = []
globalThis.WebSocket = class {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = [] // { at, msg }
    this.closedWith = null
    sockets.push(this)
  }
  send(text) {
    if (this.readyState !== 1) throw new Error('send() on a socket that is not open')
    if (typeof text !== 'string' || Buffer.byteLength(text) > 1024) throw new Error('not a text message of at most 1024 bytes')
    this.sent.push({ at: now, msg: JSON.parse(text) })
  }
  close(code) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.closedWith = code ?? 1005
    this.onclose?.({ code: this.closedWith, reason: '' })
  }
  // ---- the server's side
  accept() {
    this.readyState = 1
    this.onopen?.({})
  }
  fail(code = 1006, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  frame(id, bytes) {
    const b = new Uint8Array(4 + bytes.length)
    new DataView(b.buffer).setUint32(0, id, true)
    b.set(bytes, 4)
    this.onmessage?.({ data: b.buffer })
  }
  text(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  msgs(op) {
    return this.sent.map((s) => s.msg).filter((m) => !op || m.op === op)
  }
}

// a clock driven by hand: advance(ms) runs every timer due by then, in order
let timers = []
let seq = 0
const clock = {
  now: () => now,
  later(fn, ms) {
    const t = { at: now + Math.max(0, ms), fn, seq: seq++ }
    timers.push(t)
    return t
  },
  cancel(t) {
    timers = timers.filter((x) => x !== t)
  }
}
function advance(ms) {
  const until = now + ms
  for (;;) {
    let next = null
    for (const t of timers) if (t.at <= until && (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq))) next = t
    if (!next) break
    timers = timers.filter((x) => x !== next)
    now = Math.max(now, next.at)
    next.fn()
  }
  now = until
}

const mux = await import('../public/live-mux.js')
const { LiveTile, MAIN_STREAM, STALL_RECONNECT_MS, SUB_STREAM } = await import('../public/live-tile.js')
const { CODEC_H265 } = await import('../public/player.js')
const { serveMux } = await import('../live-mux.mjs')
const { liveSocket, useMux, muxState } = mux

/**
 * What the server (live-mux.mjs, the real one) makes of what one connection sent: each message
 * arrives delay(m) ms after it left, never before the one sent before it (TCP keeps the order).
 * @returns {{ closed: object | null, most: number, tooMany: number }} closed: the server closed the
 *   connection (code, reason); most: channels open at once; tooMany: subs refused at 128
 */
function serverSees(sent, delay = () => 0) {
  let t = 0
  const handlers = {}
  const texts = []
  const ws = {
    OPEN: 1, readyState: 1, closed: null,
    on(e, f) { handlers[e] = f; return this },
    send(d) { if (typeof d === 'string') texts.push(JSON.parse(d)) },
    close(code, reason) { this.closed = { code, reason }; this.readyState = 2 },
    terminate() { this.closed = { code: 1006 }; this.readyState = 2 }
  }
  const server = serveMux(ws, { session: () => 'ann', attach: () => {}, now: () => t, log: () => {} })
  let most = 0
  let arrived = 0
  for (const m of sent) {
    arrived = Math.max(arrived, m.at + delay(m))
    t = arrived
    handlers.message(Buffer.from(JSON.stringify(m.msg)), false)
    most = Math.max(most, server.channels.size)
  }
  return { closed: ws.closed, most, tooMany: texts.filter((m) => m.reason === 'too many channels').length }
}

const reset = () => {
  mux._test.reset(clock)
  timers = []
  sockets.length = 0
  store = {}
  location.protocol = 'http:'
}
/** Records what a channel (or socket) is told. */
const track = (c) => {
  const log = { opens: 0, closes: [], msgs: [], order: [] }
  c.onopen = () => { log.opens++; log.order.push('open') }
  c.onclose = (e) => { log.closes.push(e); log.order.push('close') }
  c.onmessage = (e) => { log.msgs.push(e.data); log.order.push('msg') }
  return log
}
const cam = (ch, more = {}) => ({ nvr: 'n1', ch, stream: 1, fps: null, h265: null, ...more })

// ---- off (the default): a socket of its own per tile, to exactly the /live address as before
{
  reset()
  // live-tile.js's own address before this change, verbatim
  const before = ({ nvr, ch, stream, fps, h265 }) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/live?nvr=${encodeURIComponent(nvr)}&ch=${ch}&stream=${stream}${fps === 15 ? '&fps=15' : ''}${h265 === null ? '' : `&h265=${h265 ? 1 : 0}`}`
  }
  let identical = true
  let n = 0
  for (const protocol of ['http:', 'https:']) {
    location.protocol = protocol
    for (const nvr of ['n1', 'a b/c&d', 'nvr-é'])
      for (const stream of [0, 1])
        for (const fps of [null, 15])
          for (const h265 of [null, true, false]) {
            const c = { nvr, ch: 7, stream, fps, h265 }
            const ws = liveSocket(c)
            n++
            if (!(ws instanceof globalThis.WebSocket) || ws !== sockets.at(-1) || ws.url !== before(c)) identical = false
          }
  }
  check('mux off: a plain WebSocket per call, returned at once, to the same /live address as before', identical && sockets.length === n, `${sockets.length}/${n}`)
  check('... e.g. a phone that can play H.265, over https', sockets.find((s) => s.url.startsWith('wss:') && s.url.includes('fps=15&h265=1'))?.url === 'wss://x/live?nvr=n1&ch=7&stream=0&fps=15&h265=1')
  check('... and muxState says off', muxState().on === false && muxState().socket === 'none')
}

// ---- on: one shared socket for every channel, subs sent once it opens
{
  reset()
  useMux(true)
  const a = liveSocket(cam(0))
  const b = liveSocket(cam(1, { fps: 15, h265: true }))
  const c = liveSocket({ nvr: 'n2', ch: 2, stream: 0, fps: null, h265: false })
  const la = track(a)
  const lb = track(b)
  const lc = track(c)
  const s = sockets[0]
  check('three channels, one socket, to /live-mux', sockets.length === 1 && s.url === 'ws://x/live-mux' && s.binaryType === 'arraybuffer', sockets.map((x) => x.url).join(' '))
  check('channels are not sockets, and start "connecting"', !(a instanceof globalThis.WebSocket) && [a, b, c].every((x) => x.readyState === 0))
  a.binaryType = 'arraybuffer' // (settable, as LiveTile does)
  advance(1000)
  check('nothing is sent while the socket is still opening', s.sent.length === 0 && a.readyState === 0)
  s.accept()
  const subs = s.msgs('sub')
  check('opened: a sub for each waiting channel, at once', subs.length === 3, JSON.stringify(subs))
  check('... fps and h265 left out while not known', same(subs[0], { op: 'sub', id: a.id, nvr: 'n1', ch: 0, stream: 1 }), JSON.stringify(subs[0]))
  check('... fps 15 and h265 1 for a phone that plays H.265', same(subs[1], { op: 'sub', id: b.id, nvr: 'n1', ch: 1, stream: 1, fps: 15, h265: 1 }), JSON.stringify(subs[1]))
  check('... h265 0, main stream', same(subs[2], { op: 'sub', id: c.id, nvr: 'n2', ch: 2, stream: 0, h265: 0 }), JSON.stringify(subs[2]))
  check('... ids distinct and in range', new Set([a.id, b.id, c.id]).size === 3 && [a, b, c].every((x) => Number.isInteger(x.id) && x.id >= 1 && x.id <= 2147483647))
  check('... each channel open, but onopen not called from inside that call', [a, b, c].every((x) => x.readyState === 1) && la.opens + lb.opens + lc.opens === 0)
  advance(0)
  check('... then onopen, once each', la.opens === 1 && lb.opens === 1 && lc.opens === 1)
  check('muxState: open, 3 channels, 3 messages', muxState().socket === 'open' && muxState().channels === 3 && muxState().messages === 3 && muxState().subsAllowedNow === 157, JSON.stringify(muxState()))

  // a channel made while the socket is open: its sub goes a moment later (a quick open-close is free)
  const d = liveSocket(cam(3))
  const ld = track(d)
  check('a channel on an open socket: connecting, no sub yet', d.readyState === 0 && s.msgs('sub').length === 3 && sockets.length === 1)
  advance(39)
  check('... not within 39 ms', s.msgs('sub').length === 3)
  advance(1)
  check('... sent after 40 ms, then open', s.msgs('sub').length === 4 && s.msgs('sub')[3].id === d.id && d.readyState === 1)
  advance(0)
  check('... onopen once', ld.opens === 1)

  // frames: routed by id, id taken off
  s.frame(b.id, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18])
  const got = lb.msgs[0]
  check('a frame reaches its channel only', lb.msgs.length === 1 && la.msgs.length === 0 && lc.msgs.length === 0 && ld.msgs.length === 0)
  check('... as an ArrayBuffer of exactly the frame (the 4-byte id removed)', got instanceof ArrayBuffer && same([...new Uint8Array(got)], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]), got && [...new Uint8Array(got)].join(','))
  s.frame(424242, [1, 2, 3])
  s.onmessage({ data: new ArrayBuffer(2) })
  check('frames for an unknown id, and runts, are dropped', [la, lb, lc, ld].every((l) => l.msgs.length === (l === lb ? 1 : 0)) && muxState().dropped === 1)
  s.text('not json')
  s.text({ op: 'hello', id: a.id })
  check('unknown text is ignored', a.readyState === 1)

  // "end" from the server: that channel closes, once, asynchronously
  s.text({ op: 'end', id: a.id, code: 1013, reason: 'NVR offline' })
  check('"end": the channel is closed', a.readyState === 3 && la.closes.length === 0)
  advance(0)
  check('... onclose once, with the code and reason', la.closes.length === 1 && la.closes[0].code === 1013 && la.closes[0].reason === 'NVR offline', JSON.stringify(la.closes))
  s.frame(a.id, [1, 2, 3])
  a.close()
  advance(0)
  check('... no frames after it, no unsub for it, no second onclose', la.msgs.length === 0 && !s.msgs('unsub').length && la.closes.length === 1)
  s.text({ op: 'end', id: a.id, code: 1008, reason: 'again' })
  advance(0)
  check('... a second "end" for it is ignored', la.closes.length === 1)

  // closed by its tile: unsub, onclose once, nothing after
  b.close()
  check('closed here: unsub sent', same(s.msgs().at(-1), { op: 'unsub', id: b.id }) && b.readyState === 3)
  check('... onclose not from inside close()', lb.closes.length === 0)
  advance(0)
  check('... then once', lb.closes.length === 1)
  b.close()
  b.close()
  advance(0)
  s.frame(b.id, [9, 9, 9])
  check('closed twice (hidden, then rebuilt): one unsub, one onclose, no frames after', s.msgs('unsub').length === 1 && lb.closes.length === 1 && lb.msgs.length === 1)

  // the handler is read when the close is delivered, not when it happens
  c.close()
  c.onclose = null // (as LiveTile's watchdog and reconnectNow do, before or after close())
  advance(0)
  check('onclose cleared before it is delivered: not called', lc.closes.length === 0)

  // a frame that arrives before onopen was delivered: open comes first
  const e = liveSocket(cam(5))
  const le = track(e)
  advance(40)
  s.frame(e.id, [1, 2, 3])
  check('a frame before onopen was delivered: onopen first, then the frame', le.order.join(',') === 'open,msg', le.order.join(','))
  advance(0)
  check('... and onopen only once', le.opens === 1)
  d.close()
  e.close()
  advance(0)
}

// ---- a channel closed before its sub went costs nothing
{
  reset()
  useMux(true)
  const a = liveSocket(cam(0))
  const b = liveSocket(cam(1))
  const la = track(a)
  track(b)
  a.close()
  advance(0)
  check('closed while the socket opens: onclose once', la.closes.length === 1 && a.readyState === 3)
  sockets[0].accept()
  advance(40) // (a sub waits 40 ms from its channel's start)
  check('... and no sub or unsub for it when it opens', same(sockets[0].msgs().map((m) => `${m.op}:${m.id}`), [`sub:${b.id}`]), JSON.stringify(sockets[0].msgs()))
  // the full-size view stepped with a held arrow key: open, close 30 ms later, 30 times
  const before = sockets[0].sent.length
  const logs = []
  for (let i = 0; i < 30; i++) {
    const c = liveSocket(cam(10 + i))
    logs.push(track(c))
    advance(30)
    c.close()
  }
  advance(0)
  check('a camera opened and closed within 30 ms: no message at all', sockets[0].sent.length === before, `${sockets[0].sent.length - before} sent`)
  check('... each still told onclose once', logs.every((l) => l.closes.length === 1 && l.opens === 0))
}

// ---- the shared socket lost: every channel closes, once; nothing is subscribed again by itself
{
  reset()
  useMux(true)
  const chans = [0, 1, 2, 3].map((ch) => liveSocket(cam(ch)))
  const logs = chans.map(track)
  const s = sockets[0]
  s.accept()
  advance(0)
  const late = liveSocket(cam(9)) // still waiting for its sub
  const ll = track(late)
  // one tile's handler throws: the others are still told
  const errors = []
  const consoleError = console.error
  console.error = (err) => errors.push(err)
  chans[1].onclose = () => { logs[1].closes.push('threw'); throw new Error('a tile failed') }
  s.fail(1006)
  check('socket lost: every channel closed at once', chans.every((c) => c.readyState === 3) && late.readyState === 3)
  check('... onclose not from inside the socket\'s own close', logs.every((l) => l.closes.length === 0) && ll.closes.length === 0)
  advance(0)
  console.error = consoleError
  check('... then once each, the waiting one too, even after one threw', logs.every((l) => l.closes.length === 1) && ll.closes.length === 1 && errors.length === 1, logs.map((l) => l.closes.length).join(','))
  const subsBefore = s.msgs('sub').length
  advance(60_000)
  check('... and nothing is subscribed again by itself', sockets.length === 1 && s.msgs('sub').length === subsBefore)
  chans[0].close()
  advance(0)
  check('... closing a lost channel does nothing', logs[0].closes.length === 1)
  check('... muxState: no socket', muxState().socket === 'none' && muxState().channels === 0)
  const again = liveSocket(cam(0))
  check('a new channel after that: a new socket', sockets.length === 2 && sockets[1].url === 'ws://x/live-mux' && again.readyState === 0)
  // the server closes the whole connection (e.g. signed out): its code and reason reach the tiles
  const la = track(again)
  sockets[1].accept()
  advance(0)
  sockets[1].fail(1008, 'signed out')
  advance(0)
  check('... closed by the server with 1008 "signed out": each channel is told so', la.closes.length === 1 && la.closes[0].code === 1008 && la.closes[0].reason === 'signed out', JSON.stringify(la.closes))
}

// ---- not open after 8 s: dropped, its channels closed; the next channel opens a new one
{
  reset()
  useMux(true)
  const a = liveSocket(cam(0))
  const la = track(a)
  advance(7999)
  check('still opening after 7.999 s: kept', sockets[0].readyState === 0 && a.readyState === 0)
  advance(1)
  check('8 s: the socket is dropped and its channels closed', sockets[0].readyState === 3 && a.readyState === 3 && la.closes.length === 1)
  const b = liveSocket(cam(0))
  check('... the tile\'s next try opens a new socket', sockets.length === 2 && b.readyState === 0)
  advance(8000)
  const c = liveSocket(cam(0))
  check('slow handshakes are not "no /live-mux": still channels after two timeouts', !(c instanceof globalThis.WebSocket) && sockets.length === 3 && muxState().fallback === false)
  sockets[2].accept()
  check('... and it opens', c.readyState === 1 || (advance(40), c.readyState === 1))
}

// ---- no channel for 30 s: the socket is closed
{
  reset()
  useMux(true)
  const a = liveSocket(cam(0))
  track(a)
  const s = sockets[0]
  s.accept()
  advance(100)
  a.close()
  advance(20_000)
  const b = liveSocket(cam(1))
  track(b)
  advance(20_000)
  s.frame(b.id, [1, 2, 3]) // (closing a channel after 6 s+ of nothing at all drops the connection: below)
  check('a channel within 30 s keeps the socket', s.readyState === 1 && sockets.length === 1 && s.msgs('sub').at(-1).id === b.id)
  b.close()
  advance(29_999)
  check('no channel for 29.999 s: still open', s.readyState === 1)
  advance(1)
  check('30 s: closed (1000)', s.readyState === 3 && s.closedWith === 1000 && muxState().socket === 'none')
  const c = liveSocket(cam(2))
  check('... the next channel opens a new one', sockets.length === 2 && c.readyState === 0)
}

// ---- a server without /live-mux: two failures before any open -> a socket per tile again
{
  reset()
  useMux(true)
  const a = liveSocket(cam(0))
  const la = track(a)
  sockets[0].fail(1006)
  advance(0)
  check('first failure: channels closed, still the shared socket next time', la.closes.length === 1 && !(liveSocket(cam(0)) instanceof globalThis.WebSocket))
  sockets[1].fail(1006)
  advance(0)
  const b = liveSocket(cam(4, { fps: 15, h265: false }))
  check('second failure in a row, never opened: a plain /live socket per tile', b instanceof globalThis.WebSocket && b.url === 'ws://x/live?nvr=n1&ch=4&stream=1&fps=15&h265=0' && muxState().fallback === true, b.url)
  advance(5 * 60_000)
  const c = liveSocket(cam(5))
  check('... tried again 5 minutes later (a page loaded while the server restarted)', !(c instanceof globalThis.WebSocket) && sockets.at(-1).url === 'ws://x/live-mux')

  // once it has opened on this page it is never given up (a server restart fails a few in a row)
  reset()
  useMux(true)
  track(liveSocket(cam(0)))
  sockets[0].accept()
  sockets[0].fail(1006)
  advance(0)
  for (let i = 0; i < 4; i++) {
    track(liveSocket(cam(0)))
    sockets.at(-1).fail(1006)
    advance(0)
  }
  check('opened once on this page: failures afterwards never fall back', !(liveSocket(cam(0)) instanceof globalThis.WebSocket) && muxState().fallback === false)
}

// ---- turned off in this browser
{
  reset()
  useMux(true)
  store['argus.liveMux'] = '0'
  const a = liveSocket(cam(3))
  check('localStorage argus.liveMux = "0": a plain /live socket', a instanceof globalThis.WebSocket && a.url === 'ws://x/live?nvr=n1&ch=3&stream=1' && muxState().on === false)
  globalThis.localStorage = { getItem: () => { throw new Error('denied') } }
  const b = liveSocket(cam(3))
  check('... storage that throws: the shared connection as asked', !(b instanceof globalThis.WebSocket))
  globalThis.localStorage = { getItem: (k) => store[k] ?? null }
}

// ---- what the server would refuse is failed here, without a message
{
  reset()
  useMux(true)
  const bad = [cam(256), cam(-1), cam(1.5), cam('3'), cam(0, { stream: 2 }), cam(0, { nvr: '' }), cam(0, { nvr: 'x'.repeat(1100) })]
  const logs = bad.map((c) => track(liveSocket(c)))
  check('bad channel, stream or size: closed at once, no socket opened for them', sockets.length === 0)
  advance(0)
  check('... onclose once each, 1008', logs.every((l) => l.closes.length === 1 && l.closes[0].code === 1008), logs.map((l) => l.closes[0]?.code).join(','))
  const odd = liveSocket(cam(0, { fps: 25 }))
  track(odd)
  sockets[0].accept()
  advance(40)
  check('fps other than 15 is left out, as /live did', same(sockets[0].msgs('sub')[0], { op: 'sub', id: odd.id, nvr: 'n1', ch: 0, stream: 1 }), JSON.stringify(sockets[0].msgs('sub')[0]))
}

// ---- the server's limits: at most 128 channels; subs a burst of 200, then 20 a second (paced here
// at 4/5 of both); unsubs free
{
  reset()
  useMux(true)
  const s = (() => { liveSocket(cam(0)).close(); return sockets[0] })()
  advance(0)
  s.accept()
  const chans = []
  for (let i = 0; i < 200; i++) {
    const c = liveSocket(cam(i % 64, { nvr: `n${Math.floor(i / 64)}` }))
    track(c)
    chans.push(c)
  }
  check('channels settling on an open connection are "queued" (not a stuck handshake)', chans.every((c) => c.readyState === 0 && c.queued === true))
  advance(40)
  check('200 channels: 128 subscribed, the rest wait "connecting" (queued)', s.msgs('sub').length === 128 && chans.filter((c) => c.readyState === 1).length === 128 && chans.slice(128).every((c) => c.readyState === 0 && c.queued === true) && chans[0].queued === false)
  // a page of the grid replaced (8x8): 64 closed, then more closed
  for (const c of chans.slice(0, 100)) c.close()
  check('100 closed: every unsub at once, and waiting subs in their place while the burst lasts (160)', s.msgs('unsub').length === 100 && s.msgs('sub').length === 160 && chans[0].queued === false, `${s.msgs('unsub').length} unsubs ${s.msgs('sub').length} subs`)
  advance(1000)
  const perSecond = s.msgs('sub').length - 160
  check('... then 16 a second', perSecond >= 15 && perSecond <= 16, `${perSecond}`)
  advance(1600)
  const ops = s.msgs()
  check('... every waiting channel subscribed 2.6 s after', s.msgs('sub').length === 200 && chans.slice(100).every((c) => c.readyState === 1), `${s.msgs('sub').length} subs`)
  const seen = serverSees(s.sent)
  check('the server never sees more than 128 channels open, nor a sub refused, and keeps the connection', seen.most <= 128 && seen.tooMany === 0 && seen.closed === null, JSON.stringify(seen))
  const first = s.sent[0].at
  const late = serverSees(s.sent, (m) => (m.at === first ? 2400 : 0))
  check('... also with the first burst arriving 2.4 s late', late.closed === null, JSON.stringify(late.closed))
  check('... each freed place taken by a sub after the unsub that freed it', ops.slice(128, 328).map((m) => m.op[0]).join('') === 'us'.repeat(32) + 'u'.repeat(68) + 's'.repeat(40))
  // an "end" makes room for a channel held back by the limit
  const more = []
  for (let i = 0; i < 30; i++) more.push(liveSocket(cam(i, { nvr: 'n9' })))
  more.forEach(track)
  advance(11_000)
  check('100 open + 30 new: 28 in, the last 2 wait at 128', s.msgs('sub').length === 228 && more.slice(0, 28).every((c) => c.readyState === 1) && more.slice(28).every((c) => c.readyState === 0), `${s.msgs('sub').length}`)
  s.text({ op: 'end', id: chans[150].id, code: 1013, reason: 'NVR offline' })
  check('... an "end" lets the next one in', s.msgs('sub').length === 229 && more[28].readyState === 1 && more[29].readyState === 0)
}

// ---- an 8x8 grid paged twice in 6 s: render() closes every tile and opens 64 new ones
{
  reset()
  useMux(true)
  const made = [] // { c, at }
  const page = () => {
    const cs = []
    for (let i = 0; i < 64; i++) {
      const c = liveSocket(cam(i, { nvr: `p${made.length}` }))
      track(c)
      made.push({ c, at: now })
      cs.push(c)
    }
    return cs
  }
  let tiles = page()
  const s = sockets[0]
  s.accept()
  for (const wait of [3100, 3000]) {
    advance(wait)
    for (const c of tiles) c.close()
    tiles = page()
  }
  advance(10_000)
  const subAt = new Map(s.sent.filter((x) => x.msg.op === 'sub').map((x) => [x.msg.id, x.at]))
  const held = made.map(({ c, at }) => (subAt.get(c.id) ?? Infinity) - at)
  const longest = Math.max(...held.slice(64)) // (the first page waited for the connection to open)
  check('every tile of the next two pages subscribed as soon as it settled (40 ms), none held back', longest === 40 && made.every(({ c }) => c.readyState === 1 || c.readyState === 3), `longest ${longest} ms`)
  const seen = serverSees(s.sent)
  check('... and the server keeps the connection', seen.closed === null && seen.most <= 128)
}

// ---- paging on and on: the client slows down, the server never closes the connection
{
  reset()
  useMux(true)
  let tiles = []
  const page = (n) => {
    for (const c of tiles) c.close()
    tiles = Array.from({ length: 64 }, (_, i) => { const c = liveSocket(cam(i, { nvr: `q${n}` })); track(c); return c })
  }
  page(0)
  const s = sockets[0]
  s.accept()
  for (let n = 1; n <= 40; n++) {
    advance(700)
    page(n)
  }
  advance(20_000)
  // bursts that reach the server late, by up to 2.4 s (a seeded, repeatable spread)
  let seed = 7
  const jitter = new Map()
  const delay = (m) => {
    if (!jitter.has(m.at)) { seed = (seed * 16807) % 2147483647; jitter.set(m.at, seed % 2400) }
    return jitter.get(m.at)
  }
  const seen = serverSees(s.sent, delay)
  check('a page every 0.7 s for 28 s: the last page\'s tiles all subscribed, the server never closes', tiles.every((c) => c.readyState === 1) && seen.closed === null && seen.most <= 128, JSON.stringify(seen.closed))
  check('... held back meanwhile, never over the rate (16 subs a second on average)', s.msgs('sub').length <= 160 + 16 * ((now - s.sent[0].at) / 1000))
}

// ---- a connection that says open but delivers nothing is dropped
{
  reset()
  useMux(true)
  const a = liveSocket(cam(0))
  const b = liveSocket(cam(1))
  const la = track(a)
  const lb = track(b)
  const s = sockets[0]
  s.accept()
  advance(0)
  s.frame(a.id, [1, 2, 3])
  advance(3000)
  a.close()
  check('closed with frames 3 s ago: the connection stays', s.readyState === 1)
  advance(0)
  const c = liveSocket(cam(2))
  track(c)
  advance(STALL_RECONNECT_MS)
  // (the tile's watchdog gives up on it after 8 s without a frame)
  c.close()
  check('closed by its watchdog with nothing at all received for 6 s+: the connection is dropped', s.readyState === 3 && b.readyState === 3)
  advance(0)
  check('... every other channel on it told', lb.closes.length === 1 && la.closes.length === 1)
}

// ---- 'online' / back from the cache: a quiet connection is dropped first
{
  reset()
  useMux(true)
  const a = liveSocket(cam(0))
  track(a)
  const s = sockets[0]
  s.accept()
  advance(0)
  s.frame(a.id, [1, 2, 3])
  advance(1000)
  fire('online')
  check('online, a frame 1 s ago: kept', s.readyState === 1 && a.readyState === 1)
  fire('pageshow', { persisted: false })
  advance(3000)
  fire('pageshow', { persisted: false })
  check('pageshow not from the cache: kept', s.readyState === 1)
  fire('online')
  check('online, nothing for 3 s: dropped', s.readyState === 3 && a.readyState === 3)
  reset()
  useMux(true)
  track(liveSocket(cam(0)))
  sockets[0].accept()
  advance(5000)
  fire('pageshow', { persisted: true })
  check('back from the cache and quiet: dropped', sockets[0].readyState === 3)
}

// ---- with LiveTile (the Live page's tiles)
{
  reset()
  useMux(true)
  const el = () => ({ textContent: '', classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c) }, contains(c) { return this.set.has(c) } }, append() {} })
  const mkTile = (ch, stream = SUB_STREAM, opts = {}) => {
    const parts = { '.status': el(), '.stats': el(), '.name': el(), '.dot': { className: '', title: '' }, canvas: { width: 0, height: 0, getContext: () => ({}) } }
    const t = new LiveTile({ querySelector: (q) => parts[q], append() {} }, { nvr: 'n1', ch }, stream, 0, { now: () => now, ...opts })
    clearTimeout(t.retry)
    t.frames = 0
    t.player.push = () => t.frames++
    return t
  }
  let disconnects = 0
  const t1 = mkTile(1, SUB_STREAM, { onDisconnect: () => disconnects++ })
  const t2 = mkTile(2, SUB_STREAM, { onDisconnect: () => disconnects++ })
  t1.connect()
  t2.connect()
  const s = sockets[0]
  check('two tiles, one socket', sockets.length === 1 && t1.ws !== t2.ws && t1.ws.readyState === 0)
  s.accept()
  advance(40)
  check('... both open', t1.ws.readyState === 1 && t2.ws.readyState === 1 && t1.lastDataAt === now)
  const frame = (t, key) => {
    const b = new Uint8Array(40)
    b[0] = key ? 1 : 0
    s.frame(t.ws.id, [...b])
  }
  frame(t1, true)
  frame(t1, false)
  check('... frames reach the right tile\'s player', t1.frames === 2 && t2.frames === 0 && t1.lendable)
  // the stall watchdog: 8 s without frames on an open channel -> unsub, a reconnect scheduled, once
  frame(t2, true)
  now += STALL_RECONNECT_MS
  frame(t1, true) // (t1 keeps receiving: the connection is alive)
  const old = t2.ws
  t2.updateStatus()
  check('a stalled tile drops its channel: unsub sent, a retry scheduled', old.readyState === 3 && same(s.msgs().at(-1), { op: 'unsub', id: old.id }) && t2.attempts === 1 && Boolean(t2.retry))
  clearTimeout(t2.retry)
  advance(0)
  check('... and its handler is not run a second time', t2.attempts === 1 && disconnects === 1 && s.readyState === 1)
  t2.connect()
  advance(40)
  check('... its reconnect is a new channel on the same socket', sockets.length === 1 && t2.ws !== old && t2.ws.readyState === 1 && s.msgs('sub').at(-1).id === t2.ws.id)
  // H.265 main stream the browser cannot play: close() from inside the player, reconnect on sub
  const t3 = mkTile(3, MAIN_STREAM)
  t3.connect()
  advance(40)
  const main = t3.ws
  t3.onUnsupported(CODEC_H265)
  check('H.265 main: closed, nothing called back from inside the player', main.readyState === 3 && t3.attempts === 0 && t3.streamType === SUB_STREAM)
  advance(0)
  check('... then its onclose schedules the retry on the sub stream', t3.attempts === 1 && Boolean(t3.retry))
  clearTimeout(t3.retry)
  // the network changes: the quiet connection is dropped before the tiles reconnect, and the tiles
  // go straight to a new one (no back-off, no sign-in check per tile)
  now += 3000
  const before = disconnects
  fire('online')
  check('online on a quiet connection: every tile on a new one at once', sockets.length === 2 && t1.ws.readyState === 0 && t2.ws.readyState === 0 && t1.attempts === 0, `${sockets.length} sockets`)
  advance(0)
  check('... the dropped channels\' onclose finds the handler cleared: no disconnect storm', disconnects === before && t1.attempts === 0 && t2.attempts === 0, `${disconnects - before} disconnects`)
  // a waiting channel whose connection never opens: the tile's watchdog and the 8 s limit agree
  const t4 = mkTile(4)
  sockets[1].fail(1006) // (t1/t2's new socket lost: tiles get onclose, then their back-off)
  advance(0)
  for (const t of [t1, t2]) clearTimeout(t.retry)
  t4.connect()
  const w4 = t4.ws
  now += 8000
  t4.updateStatus()
  check('a channel stuck waiting 8 s: dropped by the tile, one retry, no message sent', w4.readyState === 3 && t4.attempts === 1 && sockets.at(-1).sent.length === 0)
  advance(8000)
  advance(0)
  check('... and the connection\'s own 8 s limit then adds nothing', t4.attempts === 1)
  clearTimeout(t4.retry)
  for (const t of [t1, t2, t3, t4]) t.close()
  advance(0)

  // A channel held back here on an open connection (the server's limits) is waiting its turn, not a
  // stuck handshake: #stuckConnecting used to drop it after 8 s and send its tile to the back of
  // the queue with a longer back-off.
  reset()
  useMux(true)
  const fill = []
  for (let i = 0; i < 128; i++) fill.push(liveSocket(cam(i % 64, { nvr: `f${i >> 6}` })))
  fill.forEach(track)
  sockets[0].accept()
  advance(40)
  const t5 = mkTile(5)
  t5.connect()
  advance(40)
  const w5 = t5.ws
  now += 9000
  t5.updateStatus()
  check('a tile whose channel waits 9 s for room on the open connection (128 channels): kept, not dropped as stuck', t5.ws === w5 && w5.readyState === 0 && w5.queued === true && t5.attempts === 0 && sockets[0].msgs('sub').length === 128)
  sockets[0].frame(fill[1].id, [1, 2, 3]) // (the connection is alive: frames keep coming)
  fill[0].close()
  check('... its sub goes as soon as there is room', w5.readyState === 1 && sockets[0].msgs('sub').at(-1).id === w5.id)
  advance(0)
  t5.close()
  for (const c of fill) c.close()
  advance(0)
}

// ---- "wait" from the server (stream rights): handed to that channel's tile as the text it is ----------
{
  reset()
  useMux(true)
  const a = liveSocket(cam(0))
  const b = liveSocket(cam(1))
  const la = track(a)
  const lb = track(b)
  const s = sockets[0]
  s.accept()
  advance(40) // (a sub settles 40 ms before it goes: then both channels are open)
  s.text({ op: 'wait', id: a.id, why: 'held' })
  check('"wait": to that channel only, as the text it is', la.msgs.length === 1 && typeof la.msgs[0] === 'string' && JSON.parse(la.msgs[0]).why === 'held' && lb.msgs.length === 0, JSON.stringify(la.msgs))
  check('... the channel stays open', a.readyState === 1 && la.closes.length === 0)
  s.text({ op: 'wait', id: 424242, why: 'held' })
  s.text({ op: 'wait', why: 'held' })
  check('... one for an unknown id, or with no id, is dropped', la.msgs.length === 1 && lb.msgs.length === 0)
  // a Live tile on a channel: the notes are activity (no stall reconnect), and it says why it waits
  reset()
  useMux(true)
  const el = () => ({ textContent: '', classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c) }, contains(c) { return this.set.has(c) } }, append() {} })
  const parts = { '.status': el(), '.stats': el(), '.name': el(), '.dot': { className: '', title: '' }, canvas: { width: 0, height: 0, getContext: () => ({}) } }
  const t = new LiveTile({ querySelector: (q) => parts[q], append() {} }, { nvr: 'n1', ch: 3 }, SUB_STREAM, 0, { now: () => now })
  clearTimeout(t.retry)
  t.player.push = () => {}
  t.connect()
  sockets[0].accept()
  advance(40)
  for (let i = 0; i < 4; i++) {
    advance(4000)
    sockets[0].text({ op: 'wait', id: t.ws.id, why: 'held' })
    t.updateStatus()
  }
  check('a Live tile on a channel: 16 s of wait notes, no stall reconnect, and it says why', t.ws.readyState === 1 && t.attempts === 0 && parts['.status'].textContent === 'Waiting for room at the NVR (SD streams)', parts['.status'].textContent)
  t.close()
  advance(0)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
