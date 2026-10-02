// Every live tile of a page on ONE WebSocket: /live-mux.
//
// Why: through the public link (Cloudflare) a browser opens WebSockets to one host ONE AT A TIME
// (RFC 6455 4.1). Measured: 24 opened together took 6.5 s, about 250 ms each, so an 8x8 grid (64
// tiles, a /live socket each) needed about 16 s to connect, and every new stream after that (full
// screen, the next camera) paid a handshake of about 300 ms of its own. On one shared socket a new
// tile costs one small message.
//
// Each tile is a CHANNEL of the page's socket, handed to the /live pipeline (live-attach.mjs:
// rights, sub-bridge, adaptive-live, phone-live, the stream's fan-out) as if it were a /live socket
// of its own. It has the part of the ws interface those modules use: send, readyState and OPEN,
// bufferedAmount, waitForKey and overSince (gateSend's, per channel), on('close'), close, terminate.
//
// Protocol v1 (public/live-mux.js is the other side):
//   client -> server, TEXT only, one JSON object each, at most 1024 bytes:
//     {"op":"sub","id":N,"nvr":"<id>","ch":0..255,"stream":0|1,"fps":15?,"h265":0|1?}
//         N from 1 to 2^31-1. Attaches channel N as /live?nvr=&ch=&stream=&fps=&h265= would be
//         attached. A channel N still open is ended first, silently.
//     {"op":"unsub","id":N}   ends channel N; nothing is sent back
//     Binary frames, unknown ops and bad fields are ignored and counted: the 21st closes the socket
//     1008. A "sub" with a good id but bad fields is also answered with "end" (1008 "bad channel or
//     stream"), so its tile tries again at once instead of waiting for its stall watchdog. A message
//     over 1024 bytes closes the socket 1009 (server.mjs gives /live-mux a ws server whose
//     maxPayload is MAX_MESSAGE_BYTES: ws refuses it from its header, before buffering it).
//   server -> client:
//     BINARY  uint32 LE channel id, then the frame exactly as /live sends it (16-byte header and
//             the Annex B bitstream, see server.mjs). Sent as two fragments of one message, the id
//             and then the frame itself: the browser hands the page one message, and the frame,
//             shared by every viewer of the stream, is never copied.
//     TEXT    {"op":"end","id":N,"code":C,"reason":"..."}: the server ended channel N with the code
//             and reason /live would have closed its socket with (1008 not allowed, 1013 NVR
//             offline, 1011 NVR removed, ...). N is free again.
//     TEXT    {"op":"wait","id":N,"why":"held"|"starting"|"unavailable"}: channel N's sub-stream has
//             no picture yet, and this viewer is shown no main stream meanwhile (no Live HD,
//             live-wait.mjs); repeated every 4 s until its first frame. A page that does not know
//             the op ignores it. 1008 "hd not allowed" in an "end": the main stream refused for want
//             of Live HD (live-attach.mjs, access-watch.mjs).
//   Per socket: at most 128 open channels (another "sub" is answered "end" 1008 "too many channels").
//   Rates, as token buckets (a burst, then a steady rate; past either the socket is closed 1008 "too
//   many requests"): 200 subs at once, then 20 a second; 1000 messages of any kind at once, then 100
//   a second. That is v1's "200 in any 10 s" for the subs, the ones that cost (each attaches a stream
//   and replays its GOP), but a burst that arrived late (a stalled phone link, this process busy
//   attaching the one before) is not counted against the next one, and unsubs, which only free what a
//   sub took, cost nothing there: a page change of an 8x8 grid is 64 unsubs and 64 subs, and two of
//   them in 6 s were past the old limit. Every client v1 allowed is allowed here. Every "sub" checks
//   the session again, as the upgrade did: signed out (the session expired, or the account was
//   removed; logout only clears the cookie) closes the socket 1008 "signed out". The socket closing,
//   for any reason, ends every channel.
//
// Backpressure. The page's channels share one FIFO: a byte queued for one tile delays every tile
// behind it. Each channel counts the bytes of its own frames still queued (from ws.send until ws has
// written them), and that is its bufferedAmount: gateSend (backpressure.mjs) holds back the channel
// that queues too much of its own, as it held back a /live socket, and one channel's backlog never
// holds back another. On top of that the socket as a whole is bounded: past SOCKET_SOFT_BYTES the
// grid's channels queuing more than an even share are held back (a heavy tile skips to its next
// keyframe, the rest stay live), and past SOCKET_CAP_BYTES every channel is. adaptive-live reads the
// whole socket's queue (sharedBufferedAmount): on one FIFO any backlog is every tile's latency.
import { STUCK_MS } from './backpressure.mjs'
import { REPLAY_MAX_BYTES } from './gop-replay.mjs'

export const MAX_MESSAGE_BYTES = 1024
export const MAX_CHANNELS = 128
export const SUB_BURST = 200
export const SUBS_PER_S = 20
export const MESSAGE_BURST = 1000
export const MESSAGES_PER_S = 100
export const MAX_MALFORMED = 20
// The page's whole queue: past the soft mark the grid's heaviest channels wait, past the cap every
// channel does. Fixed, not per channel: 64 tiles on one socket must not be allowed 64 queues' worth
// of latency (about 3 s at 20 Mbit/s for the cap, a tenth of that on the local network).
export const SOCKET_SOFT_BYTES = 2 * 1024 * 1024
export const SOCKET_CAP_BYTES = 8 * 1024 * 1024
// How fast the page's socket drains: the bytes ws finished writing (its send callbacks) per second of
// the time it had something queued, over about the last DRAIN_WINDOW_MS. The queued bytes alone say
// nothing about how long they take to go: 256 KB is 0.05 s on the local network and 0.4 s through a
// 5 Mbit/s tunnel (verify-1, 2026-09-29). Busy time only: a socket idle half the time is not a slow
// one. ws calls back once the kernel has taken the bytes, so a short burst into an empty kernel
// buffer reads much faster than the link; less than DRAIN_MIN_BUSY_MS of busy time is too little to
// say (null). Under a backlog, the only time it matters, the kernel's buffer is full and the rate is
// the link's.
export const DRAIN_WINDOW_MS = 4000
const DRAIN_MIN_BUSY_MS = 200
const DRAIN_MARK_MS = 250
const MAX_ID = 2147483647
const ID_BYTES = 4
const OPEN = 1 // ws readyState
const CLOSED = 3
const MAIN = 0 // stream type

const goodId = (id) => Number.isInteger(id) && id >= 1 && id <= MAX_ID

/** A client message as { op, id, ...}, or null when it is not one (binary, too big, not JSON, bad id or op). */
function parse(data, isBinary) {
  if (isBinary || !Buffer.isBuffer(data) || data.length > MAX_MESSAGE_BYTES) return null
  let m
  try {
    m = JSON.parse(data.toString('utf8'))
  } catch {
    return null
  }
  if (!m || typeof m !== 'object' || Array.isArray(m) || !goodId(m.id)) return null
  return m.op === 'sub' || m.op === 'unsub' ? m : null
}

/** A "sub"'s fields as the /live path takes them, or null when one is bad. */
function subFields({ nvr, ch, stream, fps, h265 }) {
  if (typeof nvr !== 'string' || !Number.isInteger(ch) || ch < 0 || ch > 255 || (stream !== 0 && stream !== 1)) return null
  // the optional ones: absent, or null from a client that writes what it does not know
  if (fps != null && typeof fps !== 'number') return null
  if (h265 != null && ![0, 1, false, true].includes(h265)) return null
  return { nvr, ch, stream, fps: fps ?? null, h265: h265 === 1 || h265 === true }
}

/**
 * The drain rate of one socket (see DRAIN_WINDOW_MS): add(n) when bytes are handed to ws, done(n, ok)
 * from its send callback (ok false: called back with an error, the socket gone); bps() is the rate in
 * bytes a second, or null; written and lost count every byte done.
 */
function drainMeter(now) {
  let queued = 0
  let written = 0 // bytes written, ever
  let lost = 0 // bytes ws gave up on (the socket died with them queued)
  let busy = 0 // ms with something queued, ever, up to busyFrom
  let busyFrom = null // since when something has been queued (null: nothing is)
  // what had been written and how long it had been busy, every DRAIN_MARK_MS or so (taken on each
  // event, after it); the first one is the last at or before the window's start
  const marks = []
  const busyAt = (t) => busy + (busyFrom === null ? 0 : t - busyFrom)
  const mark = (t) => {
    if (!marks.length || t - marks.at(-1).at >= DRAIN_MARK_MS) marks.push({ at: t, written, busy: busyAt(t) })
    while (marks.length > 1 && marks[1].at <= t - DRAIN_WINDOW_MS) marks.shift()
  }
  return {
    add(n) {
      const t = now()
      if (queued === 0) busyFrom = t
      queued += n
      mark(t)
    },
    done(n, ok = true) {
      const t = now()
      if (ok) written += n
      else lost += n
      queued -= n
      if (queued <= 0 && busyFrom !== null) {
        busy += t - busyFrom
        busyFrom = null
        queued = 0
      }
      mark(t)
    },
    bps() {
      const t = now()
      mark(t)
      const b = busyAt(t) - marks[0].busy
      return b >= DRAIN_MIN_BUSY_MS ? ((written - marks[0].written) * 1000) / b : null
    },
    get written() {
      return written
    },
    get lost() {
      return lost
    }
  }
}

/** A token bucket: `size` at once, then `perSecond`. take() is false when it is empty. */
function bucket(size, perSecond, now) {
  let tokens = size
  let at = now()
  return {
    take() {
      const t = now()
      tokens = Math.min(size, tokens + (Math.max(0, t - at) * perSecond) / 1000)
      at = t
      if (tokens < 1) return false
      tokens--
      return true
    }
  }
}

/** One tile's stream on the page's socket: to the /live pipeline, a socket of its own. */
class MuxChannel {
  #mux
  #open = true
  #onClose = []
  #type
  #queued = 0 // this channel's bytes handed to ws and not written yet
  #idBuf

  constructor(id, mux, type) {
    this.id = id
    this.#mux = mux
    this.#type = type
    this.OPEN = OPEN
    // gateSend's per-socket state (backpressure.mjs), per channel: one tile waiting for a keyframe
    // must not hold back the others
    this.waitForKey = false
    this.overSince = null
    // the first fragment of each of its messages; ws does not mask (or touch) what a server sends,
    // so every queued message can point at this one
    this.#idBuf = Buffer.alloc(ID_BYTES)
    this.#idBuf.writeUInt32LE(id, 0)
  }

  get readyState() {
    return this.#open && this.#mux.ws.readyState === OPEN ? OPEN : CLOSED
  }

  // What gateSend compares with this channel's cap (1 MB sub, 4 MB main): its own queued bytes, so
  // the channel that queues too much is the one held back, as on a socket of its own. It used to be
  // an even share of the socket's queue, which let 65 channels queue 65 caps (a remote page 13 s
  // behind before adaptive-live saw anything) and held a sub over its cap, then terminated the whole
  // page, while a main stream kept the queue up. Held back as part of the socket (see above): the
  // whole socket's queue, which is then over every channel's cap.
  get bufferedAmount() {
    const all = this.#mux.queued
    if (all > SOCKET_CAP_BYTES) return all
    // the grid's tiles, not a main stream: that is the one being looked at full size
    if (this.#type !== MAIN && all > SOCKET_SOFT_BYTES && this.#queued > all / Math.max(1, this.#mux.channels.size)) return all
    return this.#queued
  }

  /** The page's whole queue, every channel's: what adaptive-live reads as the link keeping up or not. */
  get sharedBufferedAmount() {
    return this.#mux.queued
  }

  /** How fast the page's socket drains, in bytes a second (see DRAIN_WINDOW_MS), or null: for adaptive-live's log. */
  get drainBps() {
    return this.#mux.drain.bps()
  }

  /** The bytes the page's socket has written, ever (the same meter): adaptive-live's grace after a level change. */
  get writtenBytes() {
    return this.#mux.drain.written
  }

  /**
   * What the system has not yet taken of the piece the page's socket is writing now, in bytes (0: nothing
   * in hand; null: this socket does not say). writtenBytes moves once a WHOLE frame has gone (ws's send
   * callback), and a main stream's keyframe of 600 KB takes 4.8 s at 1 Mbit/s, 16 s at 0.3: between two
   * looks 2 s apart a slow link that works had "written nothing", as a page that has stopped reading has
   * (adaptive-live.mjs #stopped; the review of fix D, 1 Oct: stepped down at 10-20 s where it was 4 s,
   * never at 0.15 Mbit/s, and its conversions paused). This number goes down as the link takes the frame
   * and stands still when the reader has stopped (test/live-mux-socket.test.mjs, a real socket). Only
   * whether it changed counts. It is the stream handle's own count (libuv's write queue), which ws and
   * net do not pass on.
   */
  get socketPending() {
    return this.#mux.pending()
  }

  /**
   * Which page socket this channel is on: the same object for every channel of one socket, nothing
   * more. adaptive-live tells a browser's page socket gone dead (its network changed, and the server's
   * end still open) from the new one the same browser opened (the final review of 29 Sep).
   */
  get page() {
    return this.#mux.page
  }

  // A new channel's GOP replay (gop-replay.mjs) queues behind whatever the page's socket already
  // holds, and every channel subscribed after it queues behind the replay: 64 subs in one go put
  // ~10 MB of replays in front of the last tile's keyframe. A replay goes whole while it fits in
  // what is left of REPLAY_MAX_BYTES on the socket; past that, just its keyframe (the picture
  // appears at once and moves from the next keyframe).
  get replayMaxBytes() {
    return Math.max(0, REPLAY_MAX_BYTES - this.#mux.queued)
  }

  /** Sends one frame (a Buffer, or a Uint8Array from the worker) under this channel's id. */
  send(data) {
    const mux = this.#mux
    if (!this.#open || mux.ws.readyState !== OPEN || !(data instanceof Uint8Array)) return
    // The socket over its cap: nothing more. A GOP replay goes to a new viewer without gateSend; this
    // is its gate (without it 128 subs of one camera on a page that stopped reading queued 128 replays).
    if (mux.queued > SOCKET_CAP_BYTES) {
      this.waitForKey = true
      return
    }
    const n = ID_BYTES + data.length
    if (mux.queued === 0) mux.progressAt = mux.now()
    this.#queued += n
    mux.queued += n
    mux.drain.add(n)
    // two fragments of one message, back to back (nothing else can come between them): the id, then
    // the frame as it is. A copy with the id in front cost an allocation and a copy of every frame
    // for every viewer, and held a copy per channel in the queue.
    mux.ws.send(this.#idBuf, { binary: true, fin: false })
    mux.ws.send(data, { binary: true, fin: true }, (err) => {
      // written (or the socket gone: an error): no longer queued
      this.#queued -= n
      mux.queued -= n
      mux.progressAt = mux.now()
      mux.drain.done(n, !err)
    })
  }

  on(event, fn) {
    if (event === 'close' && typeof fn === 'function') this.#onClose.push(fn)
    return this
  }

  once(event, fn) {
    return this.on(event, fn) // 'close' comes once anyway
  }

  off(event, fn) {
    if (event === 'close') this.#onClose = this.#onClose.filter((f) => f !== fn)
    return this
  }

  removeListener(event, fn) {
    return this.off(event, fn)
  }

  /** The server ends this channel: the page is told with "end", and its tile reconnects by itself. */
  close(code = 1000, reason = '') {
    if (!this.end()) return
    this.#mux.sendText({ op: 'end', id: this.id, code, reason: String(reason) })
  }

  /** A note for this channel's tile, as text with its id (live-wait.mjs): send() carries frames only. */
  notice(obj) {
    if (!this.#open || this.#mux.ws.readyState !== OPEN) return
    this.#mux.sendText({ ...obj, id: this.id })
  }

  // gateSend gives up on a channel held over its cap for STUCK_MS. On a /live socket of its own
  // that was a peer that stopped reading; here the channel may only be waiting behind the others on
  // a slow link. The page's socket goes only when it has written nothing at all for that long (a
  // frozen tab): then every tile of the page reconnects with its own back-off.
  terminate() {
    if (this.#mux.stalled()) this.#mux.terminate()
  }

  /**
   * Ends the channel without a word to the page (unsub, an id sent again, the socket gone).
   * @returns {boolean} false when it had already ended
   */
  end() {
    if (!this.#open) return false
    this.#open = false
    if (this.#mux.channels.get(this.id) === this) this.#mux.channels.delete(this.id)
    // on a later tick, as ws emits 'close': LiveStream.fail (live.mjs) closes its viewers while it
    // goes through its Set of them, and their handlers take them out of it
    setImmediate(() => {
      const fns = this.#onClose
      this.#onClose = []
      for (const fn of fns) {
        try {
          fn()
        } catch (e) {
          this.#mux.log(`[live-mux] a close handler failed: ${e.message}`)
        }
      }
    })
    return true
  }
}

/**
 * Serves one /live-mux socket.
 * @param {object} ws the page's socket (ws)
 * @param {{ attach: (channel: MuxChannel, sub: { nvr: string, ch: number, stream: 0|1, fps: number|null, h265: boolean }, user: string) => void,
 *   session: () => string|null, now?: () => number, log?: (line: string) => void, who?: string }} o
 *   attach: what the /live path does with a socket (live-attach.mjs), refusing with channel.close(code, reason);
 *   session: the signed-in user of the upgrade request now, or null; who: "remote" or "local", for the log
 * @returns {{ channels: Map<number, MuxChannel>, queued: () => number, quiet: () => boolean }} the open
 *   channels and the bytes queued on the socket, for tests and diagnostics; quiet: whether it has written
 *   nothing for STUCK_MS (nothing to write, or a peer that stopped reading), for its keep-alive
 */
export function serveMux(ws, { attach, session, now = Date.now, log = (line) => console.log(line), who = '' }) {
  const channels = new Map() // id -> MuxChannel
  const subs = bucket(SUB_BURST, SUBS_PER_S, now)
  const messages = bucket(MESSAGE_BURST, MESSAGES_PER_S, now)
  const openedAt = now()
  let malformed = 0
  let done = false
  let cause = null // why this side ended it, for the close's log line
  let channelsAtEnd = null // how many tiles it carried when it ended

  const endAll = () => {
    channelsAtEnd ??= channels.size
    for (const c of [...channels.values()]) c.end()
  }
  const mux = {
    ws,
    channels,
    log,
    now,
    queued: 0, // bytes of frames handed to ws and not written yet: every channel's, ended ones' too
    progressAt: now(), // when ws last wrote some of them (or the queue last started from empty)
    drain: drainMeter(now), // how fast it writes them (DRAIN_WINDOW_MS)
    page: Object.freeze({}), // this socket, as its channels name it (MuxChannel.page)
    pending: () => {
      const n = ws._socket?._handle?.writeQueueSize
      return typeof n === 'number' ? n : null
    },
    stalled: () => mux.queued > 0 && now() - mux.progressAt > STUCK_MS,
    sendText: (msg) => {
      if (ws.readyState === OPEN) ws.send(JSON.stringify(msg))
    },
    terminate: () => {
      done = true
      cause ??= `nothing written for ${STUCK_MS / 1000} s`
      endAll()
      ws.terminate()
    }
  }
  const shut = (code, reason) => {
    if (done) return
    done = true
    cause ??= `closed by the server: ${reason}`
    log(`[live-mux] closing a page's socket: ${reason}`)
    endAll()
    ws.close(code, reason)
  }
  const bad = () => {
    if (++malformed > MAX_MALFORMED) shut(1008, 'bad messages')
  }

  ws.on('message', (data, isBinary) => {
    if (done || ws.readyState !== OPEN) return
    if (!messages.take()) return shut(1008, 'too many requests')
    const m = parse(data, isBinary)
    if (!m) return bad()
    if (m.op === 'unsub') {
      channels.get(m.id)?.end() // (an id the server already ended: nothing to do)
      return
    }
    if (!subs.take()) return shut(1008, 'too many requests')
    let user = null
    try {
      user = session()
    } catch {}
    if (!user) return shut(1008, 'signed out')
    channels.get(m.id)?.end() // the same id again: the new subscription replaces the old one
    const sub = subFields(m)
    if (!sub) {
      bad()
      if (!done) mux.sendText({ op: 'end', id: m.id, code: 1008, reason: 'bad channel or stream' })
      return
    }
    if (channels.size >= MAX_CHANNELS) return mux.sendText({ op: 'end', id: m.id, code: 1008, reason: 'too many channels' })
    const channel = new MuxChannel(m.id, mux, sub.stream)
    channels.set(m.id, channel) // before attach: a refusal inside it ends the channel again
    try {
      attach(channel, sub, user)
    } catch (e) {
      log(`[live-mux] attaching ${sub.nvr}/${sub.ch}/${sub.stream} failed: ${e.message}`)
      channel.close(1011, 'server error')
    }
  })
  // Every close is logged, once: its code and reason, why (the keep-alive, backpressure.mjs, marks
  // the sockets it cuts), how many tiles it carried, and how far behind it was: the bytes it never
  // wrote, whether still queued or already called back with an error (ws does that to the queued
  // sends of a socket that died, perhaps before its 'close'). On 29 Sep a remote page was forgotten
  // and restarted at full twice, and nothing said whether its socket had been cut or by what
  // (stutter report 2.10). One line per page, never per frame.
  let logged = false
  ws.on('close', (code, reason) => {
    done = true
    endAll()
    if (logged) return
    logged = true
    const secs = (now() - openedAt) / 1000
    const why = String(reason ?? '')
    const because = ws.closeCause ?? cause
    const bps = mux.drain.bps()
    const unwritten = mux.queued + mux.drain.lost
    const mb = (n) => (n / 1e6).toFixed(2)
    const mbit = (perS) => ((perS * 8) / 1e6).toFixed(1)
    // no rate: nothing queued in the window, or a burst queued too lately to measure (not "idle")
    const draining = bps !== null ? `draining at ${mbit(bps)} Mbit/s` : unwritten > 0 ? 'draining: not measured yet' : 'draining: idle'
    log(`[live-mux] a ${who ? `${who} ` : ''}page's socket closed after ${Math.round(secs)} s: code ${code}${why ? ` "${why}"` : ''}${because ? ` (${because})` : ''}; ` +
      `${channelsAtEnd} channels, ${mb(unwritten)} MB never written, ${draining}; ` +
      `${mb(mux.drain.written)} MB written in all (${mbit(secs > 0 ? mux.drain.written / secs : 0)} Mbit/s on average)`)
  })
  // a frame ws cannot read (bad UTF-8, a bad opcode, over maxPayload) closes the socket by itself;
  // with no listener the 'error' it emits would be thrown, and take the whole process down
  ws.on('error', () => {})
  // (not mux.stalled(), which needs bytes queued: a pong can also be late behind bytes written a
  // moment ago, still in the kernel's buffer or on the wire, and a socket idle that long owes nothing)
  return { channels, queued: () => mux.queued, quiet: () => now() - mux.progressAt > STUCK_MS }
}
