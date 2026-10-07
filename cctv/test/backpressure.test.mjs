// Tests for live backpressure (backpressure.mjs) and its use in stream-hub.mjs, live.mjs,
// nvr-worker.mjs and server.mjs. Pure JS: no SDK, no NVR.
// Run:  node cctv/test/backpressure.test.mjs
import { readFileSync } from 'node:fs'
import { CAP_BYTES, RESUME_BELOW, STUCK_MS, PING_MS, gateSend, keepAlive } from '../backpressure.mjs'
import { StreamHub } from '../stream-hub.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const MB = 1024 * 1024
check('caps: ~1 MB sub, 4 MB main', CAP_BYTES[1] === 1 * MB && CAP_BYTES[0] === 4 * MB)
check('resume below 256 KB', RESUME_BELOW === 256 * 1024)
check('stuck sockets closed after 30 s, ping every 15 s', STUCK_MS === 30_000 && PING_MS === 15_000)

const fakeWs = (buffered = 0) => ({
  OPEN: 1,
  readyState: 1,
  bufferedAmount: buffered,
  got: [],
  terminated: 0,
  send(b) {
    this.got.push(b)
  },
  terminate() {
    this.terminated++
    this.readyState = 3
  }
})

// ---- gateSend
{
  const opts = (now) => ({ cap: 1 * MB, resume: RESUME_BELOW, stuckMs: STUCK_MS, now })
  const ws = fakeWs(0)
  check('fresh socket, delta: sent', gateSend(ws, false, opts(0)) === true)
  ws.bufferedAmount = 2 * MB
  check('over the cap: delta not sent', gateSend(ws, false, opts(1)) === false)
  check('over the cap: KEYFRAME not sent either', gateSend(ws, true, opts(2)) === false)
  ws.bufferedAmount = 600 * 1024
  check('below the cap but above resume: keyframe still held', gateSend(ws, true, opts(3)) === false)
  ws.bufferedAmount = 100 * 1024
  check('below resume: delta still held (needs a keyframe)', gateSend(ws, false, opts(4)) === false)
  check('below resume + keyframe: sent', gateSend(ws, true, opts(5)) === true)
  check('then deltas flow again', gateSend(ws, false, opts(6)) === true)
  // stuck over the cap
  ws.bufferedAmount = 2 * MB
  gateSend(ws, false, opts(10_000))
  gateSend(ws, true, opts(10_000 + STUCK_MS - 1))
  check('over the cap < 30 s: not closed', ws.terminated === 0)
  gateSend(ws, false, opts(10_000 + STUCK_MS + 1))
  check('over the cap > 30 s: terminated', ws.terminated === 1)
  // leaving the cap resets the clock
  const w2 = fakeWs(2 * MB)
  gateSend(w2, false, opts(0))
  w2.bufferedAmount = 0
  gateSend(w2, false, opts(20_000))
  w2.bufferedAmount = 2 * MB
  gateSend(w2, false, opts(40_000))
  check('dropping below the cap restarts the stuck clock', w2.terminated === 0)
  // stuckMs 0 (taps): never closed
  const tap = fakeWs(9 * MB)
  gateSend(tap, false, { cap: 8 * MB, resume: MB, stuckMs: 0, now: 0 })
  gateSend(tap, false, { cap: 8 * MB, resume: MB, stuckMs: 0, now: 999_999 })
  check('stuckMs 0: never terminated', tap.terminated === 0)
  const closed = fakeWs(0)
  closed.readyState = 3
  check('closed socket: nothing sent', gateSend(closed, true, opts(0)) === false)
}

// ---- HubStream: keyframe while over the cap (the old code sent it)
{
  const hub = new StreamHub('n1', () => {}, { stopDelayMs: { 0: 10, 1: 10 } })
  const s = hub.getStream(3, 1)
  const a = fakeWs(0)
  const slow = fakeWs(0)
  s.add(a)
  s.add(slow)
  const K = Buffer.from([1, 0])
  const D = Buffer.from([0, 0])
  s.onFrame(K, true)
  slow.bufferedAmount = 2 * MB // over the 1 MB sub cap
  s.onFrame(D, false)
  s.onFrame(K, true)
  s.onFrame(K, true)
  check('hub: nothing (keyframes included) sent over the sub cap', slow.got.length === 1 && a.got.length === 4)
  slow.bufferedAmount = 300 * 1024
  s.onFrame(K, true)
  check('hub: keyframe held until below 256 KB', slow.got.length === 1)
  slow.bufferedAmount = 0
  s.onFrame(D, false)
  check('hub: delta after draining still held', slow.got.length === 1)
  s.onFrame(K, true)
  s.onFrame(D, false)
  check('hub: resumes on a keyframe below 256 KB', slow.got.length === 3)
  // main-stream cap is 4 MB
  const m = hub.getStream(3, 0)
  const mv = fakeWs(0)
  m.add(mv)
  m.onFrame(K, true)
  mv.bufferedAmount = 2 * MB
  m.onFrame(D, false)
  check('hub: 2 MB queued is fine on a main stream (4 MB cap)', mv.got.length === 2)
  // stuck viewer is closed by the hub
  const stuck = fakeWs(0)
  s.add(stuck)
  stuck.bufferedAmount = 5 * MB
  const realNow = Date.now
  let t = realNow()
  Date.now = () => t
  s.onFrame(D, false)
  t += STUCK_MS + 1000
  s.onFrame(D, false)
  Date.now = realNow
  check('hub: viewer stuck over the cap 30 s is terminated', stuck.terminated === 1)
}

// ---- keepAlive: ping every 15 s, terminate a socket that did not answer the last ping
{
  const handlers = new Map()
  const mk = () => {
    const ws = fakeWs(0)
    ws.pings = 0
    ws.ping = () => ws.pings++
    ws.on = (ev, fn) => handlers.set(ws, fn)
    return ws
  }
  const ok = mk()
  const dead = mk()
  const clients = new Set([ok, dead])
  const wss = { clients, on(ev, fn) { if (ev === 'connection') this.conn = fn } }
  const timers = []
  const ka = keepAlive(wss, { intervalMs: 15_000, setInterval: (fn, ms) => (timers.push({ fn, ms }), { unref() {} }) })
  wss.conn(ok)
  wss.conn(dead)
  check('keepAlive: one 15 s timer', timers.length === 1 && timers[0].ms === 15_000)
  timers[0].fn()
  check('keepAlive: first round pings everyone', ok.pings === 1 && dead.pings === 1)
  handlers.get(ok)() // pong from ok only
  timers[0].fn()
  check('keepAlive: a socket without a pong is terminated', dead.terminated === 1 && ok.terminated === 0 && ok.pings === 2)
  // ...and marked as cut by it: live-mux.mjs logs every page socket's close with its cause, and a
  // 1006 alone reads the same as the tunnel dropping it (stutter report 2.10)
  check('keepAlive: ... and marked as cut by it (closeCause, for the close\'s log line)', dead.closeCause === 'keep-alive: no answer to the last ping' && ok.closeCause === undefined, String(dead.closeCause))
  ka.stop?.()
}

// ---- keepAlive on /live-mux page sockets (live-mux.mjs serveMux): the ping queues behind everything
// already sent, so a page far behind on the tunnel answers it late. One still writing its backlog is
// waited for; one that has written nothing for 30 s is cut (stutter report 2.10: 7-11 MB behind at
// 4-6 Mbit/s is past the 15 s ping).
{
  const { serveMux } = await import('../live-mux.mjs')
  /** The page's socket as serveMux uses it: each message stays queued until drain() writes it. */
  const pageWs = () => ({
    OPEN: 1,
    readyState: 1,
    handlers: {},
    queue: [], // send callbacks of the messages not written yet, oldest first
    pings: 0,
    terminated: 0,
    on(ev, fn) { (this.handlers[ev] ??= []).push(fn); return this },
    emit(ev, ...a) { for (const fn of this.handlers[ev] ?? []) fn(...a) },
    send(d, opts, cb) { if (cb) this.queue.push(cb) },
    drain(n) { while (n-- > 0 && this.queue.length) this.queue.shift()() },
    ping() { this.pings++ },
    terminate() { this.terminated++; this.readyState = 3 }
  })
  const T0 = 5_000_000
  let now = T0
  const at = (s) => (now = T0 + s * 1000)
  /** A page socket served by serveMux with one tile, and keepAlive over it as server.mjs sets it up. */
  const page = () => {
    const ws = pageWs()
    let channel = null
    const mux = serveMux(ws, { attach: (c) => (channel = c), session: () => 'u', now: () => now, log: () => {} })
    ws.emit('message', Buffer.from(JSON.stringify({ op: 'sub', id: 1, nvr: 'n', ch: 0, stream: 1 })), false)
    const timers = []
    const wss = { clients: new Set([ws]), on(ev, fn) { if (ev === 'connection') this.conn = fn } }
    keepAlive(wss, { intervalMs: PING_MS, setInterval: (fn) => (timers.push(fn), { unref() {} }), quiet: () => mux.quiet() })
    wss.conn(ws)
    return { ws, mux, channel, round: () => timers[0]() }
  }
  {
    // 9 MB behind (nine 1 MB frames) on a link writing 0.5 MB a second (4 Mbit/s): 18 s to drain
    at(0)
    const { ws, mux, channel, round } = page()
    for (let i = 0; i < 9; i++) channel.send(Buffer.alloc(1_000_000))
    check('page socket: 9 MB queued', mux.queued() > 9_000_000, String(mux.queued()))
    round() // pings: the ping goes out behind the 9 MB
    for (let s = 2; s <= 14; s += 2) { at(s); ws.drain(1) }
    at(15)
    round() // no pong yet: it is still behind the last 2 MB
    check('page socket 9 MB behind but draining: not cut by a pong late behind its backlog', ws.terminated === 0 && ws.closeCause === undefined, `terminated ${ws.terminated}, ${ws.closeCause}`)
    check('... and not pinged again meanwhile (the pong it owes will come)', ws.pings === 1, `${ws.pings} pings`)
    at(16); ws.drain(1)
    at(18); ws.drain(1)
    ws.emit('pong') // the ping has reached the page
    at(30)
    round()
    check('... once its pong comes it is pinged as any socket is', ws.terminated === 0 && ws.pings === 2, `terminated ${ws.terminated}, ${ws.pings} pings`)
  }
  {
    // 9 MB behind, and the page stops reading at once (a frozen tab, a dead link): nothing is written
    at(0)
    const { ws, channel, round } = page()
    for (let i = 0; i < 9; i++) channel.send(Buffer.alloc(1_000_000))
    round()
    at(15); round()
    at(30); round()
    check('page socket stalled with 9 MB queued: not cut before 30 s without progress', ws.terminated === 0, `terminated ${ws.terminated}`)
    at(45); round()
    check('page socket that wrote nothing for 30 s (and missed its pong): cut', ws.terminated === 1, `terminated ${ws.terminated}`)
    check('... and marked so for the close\'s log line', ws.closeCause === `keep-alive: no answer to the last ping, and nothing written for ${STUCK_MS / 1000} s`, String(ws.closeCause))
  }
  {
    // nothing to send for a minute, then no pong: a dead peer with nothing queued is cut at once, as before
    at(0)
    const { ws, round } = page()
    at(60); round()
    at(75); round()
    check('idle page socket (nothing written for 30 s) that misses its pong: cut at that round', ws.terminated === 1, `terminated ${ws.terminated}`)
  }
}

// ---- wiring
{
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  const live = src('live.mjs')
  check('live.mjs uses gateSend', /gateSend\(/.test(live) && !/ws\.waitForKey = false\n\s*\}\n\s*ws\.send/.test(live))
  // (71ab680 made it 250 ms; an unrelated commit, ef842a7, put the 1500 back without a word)
  check('live.mjs: a sub-stream asks for a keyframe 250 ms in, the main at once', /^const KEYFRAME_WAIT_MS = \{ 0: 0, 1: 250 \}$/m.test(live))
  const hubSrc = src('stream-hub.mjs')
  check('stream-hub.mjs uses gateSend', /gateSend\(/.test(hubSrc))
  const worker = src('nvr-worker.mjs')
  check('worker tap has its own cap and is never closed', /capBytes/.test(worker) && /stuckMs: 0|stuckMs = 0|stuckMs:\s*0/.test(worker))
  const server = src('server.mjs')
  check('server pings /live sockets', /keepAlive\(wss/.test(server))
  check('server pings /live-mux page sockets with their progress (quiet: a pong late behind a backlog is waited for)', /keepAlive\(muxWss, \{ quiet: \(ws\) => pageSockets\.get\(ws\)\?\.quiet\(\) \?\? true \}\)/.test(server) && /pageSockets\.set\(ws, serveMux\(ws, \{/.test(server))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
