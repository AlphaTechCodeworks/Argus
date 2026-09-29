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

// ---- wiring
{
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  const live = src('live.mjs')
  check('live.mjs uses gateSend', /gateSend\(/.test(live) && !/ws\.waitForKey = false\n\s*\}\n\s*ws\.send/.test(live))
  const hubSrc = src('stream-hub.mjs')
  check('stream-hub.mjs uses gateSend', /gateSend\(/.test(hubSrc))
  const worker = src('nvr-worker.mjs')
  check('worker tap has its own cap and is never closed', /capBytes/.test(worker) && /stuckMs: 0|stuckMs = 0|stuckMs:\s*0/.test(worker))
  const server = src('server.mjs')
  check('server pings /live sockets', /keepAlive\(wss/.test(server))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
