// A remote viewer's page in virtual time, for the level controller's tests (adaptive-live.test.mjs): its
// tiles on one /live-mux socket over a link of a set rate, through the real live-mux.mjs (the channels,
// the drain meter), stream-hub.mjs (a new viewer's GOP replay, gateSend and its caps), sub-bridge.mjs (a
// cold sub-stream's stand-in), and adaptive-live.mjs with phone-live.mjs (a fake converter that keeps
// what a level keeps). Date.now and the timers run on the page's clock while it plays, so every module
// reads the same time; nothing waits for real.
import { AdaptiveLive, TICK_MS } from '../adaptive-live.mjs'
import { replayGop } from '../gop-replay.mjs'
import { serveMux } from '../live-mux.mjs'
import { encodeFrame } from '../phone-live.mjs'
import { HubStream } from '../stream-hub.mjs'
import { bridgeSub } from '../sub-bridge.mjs'
import { TranscodePool } from '../transcode.mjs'

const START = 1_000_000 // the page's clock when it opens, in ms

/** Date.now, setTimeout, clearTimeout and setImmediate on a clock that moves only when told to. */
function virtualClock() {
  const real = { now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setImmediate: globalThis.setImmediate }
  let t = START
  let seq = 0
  const timers = new Map() // handle -> { at, fn, args }
  Date.now = () => t
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    const handle = { n: ++seq, unref() { return this }, ref() { return this }, hasRef: () => false }
    timers.set(handle, { at: t + Math.max(0, ms), fn, args })
    return handle
  }
  globalThis.clearTimeout = (handle) => timers.delete(handle)
  globalThis.setImmediate = (fn, ...args) => globalThis.setTimeout(fn, 0, ...args)
  return {
    now: () => t,
    /** Moves the clock to `at`, running every timer due by then in order. */
    to(at) {
      for (;;) {
        let next = null
        for (const [h, x] of timers) if (x.at <= at && (!next || x.at < next[1].at || (x.at === next[1].at && h.n < next[0].n))) next = [h, x]
        if (!next) break
        timers.delete(next[0])
        t = Math.max(t, next[1].at)
        next[1].fn(...next[1].args)
      }
      t = at
    },
    restore() {
      Date.now = real.now
      globalThis.setTimeout = real.setTimeout
      globalThis.clearTimeout = real.clearTimeout
      globalThis.setImmediate = real.setImmediate
    }
  }
}

/**
 * The page's socket as ws has it: each message (its fragments, as live-mux sends them) queues until the
 * link has written it, at `bps` bytes a second, and ws then runs its send callback. gone(n): its browser
 * has gone (a network change) and the server's socket was not told: the path takes n bytes more, then
 * nothing is written again.
 */
function linkSocket(bps) {
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, handlers: {}, queue: [], parts: 0, credit: 0, room: Infinity, written: 0 }
  ws.on = (ev, fn) => ((ws.handlers[ev] ??= []).push(fn), ws)
  ws.emit = (ev, ...a) => { for (const fn of ws.handlers[ev] ?? []) fn(...a) }
  ws.send = (data, opts, cb) => {
    if (typeof opts === 'function') [cb, opts] = [opts, {}]
    ws.parts += typeof data === 'string' ? Buffer.byteLength(data) : data.length
    if (opts?.fin === false) return
    ws.queue.push({ bytes: ws.parts, cb })
    ws.bufferedAmount += ws.parts
    ws.parts = 0
  }
  /** The link's work over the last `ms`. */
  ws.write = (ms) => {
    if (!ws.queue.length) return (ws.credit = 0)
    ws.credit += (bps * ms) / 1000
    while (ws.queue.length && ws.credit >= ws.queue[0].bytes && ws.room >= ws.queue[0].bytes) {
      const m = ws.queue.shift()
      ws.credit -= m.bytes
      ws.bufferedAmount -= m.bytes
      ws.room -= m.bytes
      ws.written += m.bytes
      m.cb?.()
    }
    if (!ws.queue.length) ws.credit = 0 // an idle link saves nothing up
  }
  ws.gone = (n) => (ws.room = n)
  ws.close = () => {}
  ws.terminate = () => {}
  return ws
}

/**
 * A camera's sub-stream: `fps` frames a second at `kbps`, a keyframe every `gopS` seconds holding
 * `keyShare` of its GOP's bytes; its first frame at `from` ms after the page opened (a cold stream),
 * or running since before it (from < 0: the GOP so far is there to replay).
 */
export function camera({ fps, kbps, gopS = 2, keyShare = 0.4, from = -10_000 }) {
  const every = 1000 / fps
  const perGop = Math.max(1, Math.round(gopS * fps))
  const gopBytes = ((kbps * 1000) / 8) * gopS
  const key = Math.round(gopBytes * keyShare)
  return { every, perGop, key, delta: Math.max(200, Math.round((gopBytes - key) / Math.max(1, perGop - 1))), from }
}

const zeros = new Map()
const payload = (n) => {
  let b = zeros.get(n)
  if (!b) zeros.set(n, (b = Buffer.alloc(n)))
  return b
}

/**
 * Opens a remote page: its tiles subscribe 15 ms apart from 0 ms, the link writes `linkMbps`, the
 * controller looks every TICK_MS from the first sub (its timer starts with the first socket), and it
 * plays for `durMs`. H.264 throughout.
 * @param {{ tiles: { ch: number, cam: ReturnType<typeof camera>, standIn?: [number, number],
 *   main?: [number, number, number, number] }[], linkMbps: number, durMs: number, poolMax?: number,
 *   remote?: boolean }} o
 *   standIn: a cold sub's stand-in as on 29 Sep, cut short: the main stream's GOP the worker replays into
 *   it at once, as [its keyframe, the whole GOP] in KB (verify-6), sent whole, and no main-stream frames
 *   after it. A remote viewer's stand-in is no longer that (sub-bridge.mjs): see main.
 *   main: a cold sub's stand-in from the camera's running main stream, as [Mbit/s, keyframe KB, GOP KB,
 *   running since (ms, before the page opened: where in its GOP it is)], 20 fps: once the stand-in wants
 *   it, the worker sends its GOP so far at once through the fan-out (verify-6), then its frames as they
 *   come, for as long as it is wanted. remote (true): the stand-in is a remote viewer's, the main
 *   stream's keyframes while the page has room for them; false: a local viewer's, every frame.
 *   reload: at deadAt ms the page's browser changes network (public/live-mux.js drops its socket and
 *   opens another), and the server's socket is not told: it takes pipeBytes more, then writes nothing
 *   and stays open (keep-alive would cut it 30 s later, backpressure.mjs; here it never goes); at
 *   openAt the same browser's new page socket opens, its tiles subscribing 15 ms apart as at first.
 * @returns {{ lines: string[], downs: string[], live: AdaptiveLive, written: number[], conversions: number }} lines:
 *   the controller's, each with the second it was said at in front; written: bytes each page socket wrote;
 *   conversions: how many converters were started in all
 */
export function openPage({ tiles, linkMbps, durMs, poolMax = 16, remote = true, reload = null }) {
  const clock = virtualClock()
  try {
    const lines = []
    let conversions = 0
    const makeTranscoder = (o) => {
      conversions++
      let n = 0
      let out = 0
      return {
        push(ts, isKey, p) {
          if (n++ % o.keepEvery) return
          o.onFrame(ts, out++ % Math.max(1, o.gop || 50) === 0, payload(Math.max(200, Math.round(p.length * 0.8))))
        },
        endPicture() {},
        close() {}
      }
    }
    const live = new AdaptiveLive({ pool: new TranscodePool(poolMax), makeTranscoder, log: (l) => lines.push(`${((clock.now() - START) / 1000).toFixed(2)} ${l}`), budgetBps: 1e12, now: clock.now })
    const hub = { send() {}, streams: new Map(), stopDelayMs: { 0: 10_000, 1: 180_000 } }
    const cams = tiles.map((t) => ({ ...t, stream: new HubStream(hub, t.ch, 1), next: Math.ceil(t.cam.from / t.cam.every), first: Math.ceil(t.cam.from / t.cam.every) }))
    // every frame due by `upTo` (ms after the page opened), at its capture time
    const frames = (c, upTo) => {
      while (c.next * c.cam.every <= upTo) {
        const isKey = (c.next - c.first) % c.cam.perGop === 0
        c.stream.onFrame(encodeFrame(payload(isKey ? c.cam.key : c.cam.delta), isKey, 0, c.next * c.cam.every), isKey)
        c.next++
      }
    }
    for (const c of cams) if (c.cam.from < 0) frames(c, -1)
    // a stand-in's running main stream (main): the worker sends it only while it is wanted, and when it
    // starts, the GOP so far at once, then each frame as it comes
    const mains = cams.filter((c) => c.main).map((c) => {
      const [mbps, keyKB, gopKB, from] = c.main
      const cam = camera({ fps: 20, kbps: mbps * 1000, gopS: (gopKB * 8) / (mbps * 1000), keyShare: keyKB / gopKB, from })
      const first = Math.ceil(from / cam.every)
      return (c.mainStream = { cam, stream: new HubStream(hub, c.ch, 0), next: first, first, lastKey: null, sending: false })
    })
    const mainFrame = (m, n, isKey) => m.stream.onFrame(encodeFrame(payload(isKey ? m.cam.key : m.cam.delta), isKey, 0, n * m.cam.every), isKey)
    const mainFrames = (m, upTo) => {
      for (; m.next * m.cam.every <= upTo; m.next++) {
        const isKey = (m.next - m.first) % m.cam.perGop === 0
        if (isKey) m.lastKey = m.next
        m.sending &&= m.stream.wanted
        if (!m.stream.wanted) continue
        if (!m.sending) for (let n = m.lastKey ?? m.next; n < m.next; n++) mainFrame(m, n, n === m.lastKey)
        m.sending = true
        mainFrame(m, m.next, isKey)
      }
    }
    for (const m of mains) mainFrames(m, -1)
    // a page socket, its tiles subscribing 15 ms apart from `from` ms
    const pages = []
    const open = (from) => {
      const ws = linkSocket((linkMbps * 1e6) / 8)
      const channels = new Map() // ch -> its channel on this socket
      serveMux(ws, {
        session: () => 'owner',
        now: clock.now,
        log: () => {},
        attach: (channel, sub) => {
          const c = cams.find((x) => x.ch === sub.ch)
          channels.set(c.ch, channel)
          // as live-attach.mjs does it: a cold sub's stand-in first, then the level controller
          if (c.standIn && !(c.stream.gop.length > 0)) {
            const [keyKB, gopKB] = c.standIn
            const gop = [encodeFrame(payload(keyKB * 1000), true, 0, -1000)]
            for (let i = 1; i < 20; i++) gop.push(encodeFrame(payload(Math.round(((gopKB - keyKB) * 1000) / 19)), false, 0, -1000 + i * 50))
            bridgeSub(channel, { sub: c.stream, main: { gop, add(tap) { replayGop(this.gop, tap) }, remove() {} }, clientH265: false })
          } else if (c.mainStream && !(c.stream.gop.length > 0)) bridgeSub(channel, { sub: c.stream, main: c.mainStream.stream, clientH265: false, remote })
          live.attach('owner-pc', { ws: channel, nvrId: 'nvr-2', ch: sub.ch, type: 1, source: c.stream })
          clearInterval(live.timer) // looked at below, on the page's clock
        }
      })
      pages.push({ ws, from, channels })
    }
    open(0)
    const STEP = 5
    for (let at = 0; at <= durMs; at += STEP) {
      clock.to(START + at)
      if (reload && at === reload.deadAt) pages[0].ws.gone(reload.pipeBytes)
      if (reload && at === reload.openAt) open(at)
      for (const p of pages) p.ws.write(STEP) // what the link wrote over the step just gone: a frame queued now goes at the next
      for (const p of pages) cams.forEach((c, i) => { if (!p.channels.has(c.ch) && at >= p.from + i * 15) p.ws.emit('message', Buffer.from(JSON.stringify({ op: 'sub', id: c.ch + 1, nvr: 'nvr-2', ch: c.ch, stream: 1 })), false) })
      for (const c of cams) frames(c, at)
      for (const m of mains) mainFrames(m, at)
      if (at > 0 && at % TICK_MS === 0) live.tick()
    }
    const said = lines.filter((l) => l.includes('[adaptive]'))
    return { lines: said, downs: said.filter((l) => /: (full|15|8) -> (15|8|4) /.test(l)), live, written: pages.map((p) => p.ws.written), conversions }
  } finally {
    clock.restore()
  }
}
