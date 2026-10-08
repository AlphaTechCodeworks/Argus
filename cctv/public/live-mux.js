// Every live tile's stream over ONE WebSocket (/live-mux), instead of a socket per tile.
//
// Browsers open WebSockets to one server ONE AT A TIME (RFC 6455 4.1): through the public link
// (Cloudflare) 24 at once opened over 6.5 s, ~250 ms each (2026-09-27), so an 8x8 grid (64 tiles,
// one /live socket each) took ~16 s before its last camera moved, and every new stream (the
// full-size view, the next camera) paid a ~300 ms handshake. Here the page opens one connection and
// each tile's stream is a "channel" on it: starting one is a small message on a connection that is
// already open.
//
// Protocol v1 (server.mjs /live-mux is the other half):
//   page -> server, text:   {"op":"sub","id":N,"nvr":"..","ch":0..255,"stream":0|1[,"fps":15][,"h265":0|1]}
//                           {"op":"unsub","id":N}
//   server -> page, binary: the channel id (4 bytes, little-endian), then the frame exactly as /live sends it
//   server -> page, text:   {"op":"end","id":N,"code":..,"reason":".."} (the server ended that channel)
//   server -> page, text:   {"op":"wait","id":N,"why":".."} (that channel's sub-stream has no picture yet,
//                           and this viewer is shown no main stream meanwhile: live-wait.mjs). Handed
//                           to the tile as a text message, as a /live socket's tile gets it
//   server -> page, text:   {"op":"convert","id":N,"on":true} (that channel's H.265 camera is being
//                           converted to H.264 for this browser: h264-fallback.mjs). Handed on the same way
// The server allows 128 channels on one connection, and subs at a burst of 200, then 20 a second;
// past that it closes the whole connection, every tile with it: this side paces its subs (flush).
// Unsubs cost nothing there (they only free what a sub took) and go at once.
//
// To LiveTile a channel looks like the WebSocket it replaces (readyState, onopen, onmessage, onclose,
// close()), so its stall watchdog, its back-off and #stuckConnecting work unchanged. Off unless the
// page asks for it (useMux: the Live page). Elsewhere, in tests, against a server without /live-mux,
// and with localStorage 'argus.liveMux' = '0', a tile gets its own /live socket as before.

// The shared connection still not open after this long is dropped: its channels close and each tile
// tries again with its own back-off. (live-tile.js has the same limit; not imported from there,
// because that file imports this one.)
const CONNECT_TIMEOUT_MS = 8000
// no channel for this long: the connection is closed
const IDLE_CLOSE_MS = 30_000
// The server's limits on one connection (live-mux.mjs). Subs are paced here at 4/5 of its burst and
// of its rate: they can reach the server closer together than they left (a phone link that stalls
// a second, a server busy attaching the ones before), and with this much to spare a burst may arrive
// 2.5 s late and still fit. It was 180 messages per 10.5 s against 200 per 10 s, unsubs included: a
// burst 0.5 s late closed the connection, and an 8x8 page change (64 unsubs, 64 subs) twice in 6 s
// left the last page's tiles 'connecting' for up to 7.5 s.
const MAX_CHANNELS = 128
const SUB_BURST = 160
const SUBS_PER_S = 16
// A sub waits this long before it goes: the full-size view stepped with a held arrow key opens and
// closes a camera every ~30 ms, and a channel closed before its sub went costs no message at all.
const SETTLE_MS = 40
// Nothing at all has arrived for this long while a channel was waiting for frames: the connection
// is dead though it says open (a phone that moved between Wi-Fi and mobile data keeps a socket
// 'open' until TCP gives up, minutes later). With a socket per tile each tile's watchdog replaced its
// own; on one connection they would all just subscribe again on the same dead one.
const QUIET_MS = 6000
// 'online', or the page back from the browser's cache: a connection this quiet is not trusted
const WAKE_QUIET_MS = 2000
// Two connections in a row closed before they opened, on a page where none ever opened: a server
// without /live-mux. Tiles use sockets of their own for a while, then the shared one is tried again
// (a page loaded while the server was restarting would otherwise never get it).
const MAX_FAILURES = 2
const FALLBACK_MS = 5 * 60_000

const realClock = {
  now: () => Date.now(),
  later(fn, ms) {
    const t = setTimeout(fn, ms)
    t?.unref?.() // (Node, in tests: never what keeps the process alive)
    return t
  },
  cancel: (t) => clearTimeout(t)
}
let clock = realClock

let enabled = false
let sock = null // the shared connection (opening or open), or null
let sockOpen = false
let everOpened = false // on this page
let failures = 0 // connections in a row closed before they opened
let fallbackUntil = 0
let lastRxAt = 0 // anything at all received on the connection (or when it opened)
let nextId = 1
const waiting = [] // channels whose sub has not gone yet, oldest first (readyState 0)
const channels = new Map() // id -> channel subscribed on the connection (readyState 1)
const unsubs = [] // ids whose unsub has not gone yet
let subTokens = SUB_BURST // subs that may go now (a token bucket, per connection as the server's)
let tokensAt = 0
let messages = 0 // sent on this connection
let connectTimer = null
let flushTimer = null
let idleTimer = null
const counts = { frames: 0, dropped: 0 }

const wsBase = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`

/** The address of one camera's own /live socket: what every tile opened before the shared connection. */
export function liveUrl({ nvr, ch, stream, fps = null, h265 = null }) {
  return `${wsBase()}/live?nvr=${encodeURIComponent(nvr)}&ch=${ch}&stream=${stream}${fps === 15 ? '&fps=15' : ''}${h265 == null ? '' : `&h265=${h265 ? 1 : 0}`}`
}

const optedOut = () => {
  try {
    return globalThis.localStorage?.getItem('argus.liveMux') === '0'
  } catch {
    return false
  }
}

/** The tiles this page opens from now on share one connection (on), or each open their own (off). */
export function useMux(on) {
  enabled = Boolean(on)
}

/**
 * A live stream for one tile: a channel on the shared connection, or (the shared connection off,
 * turned off in this browser, or not offered by the server) a WebSocket of its own to /live, exactly
 * as before. Either way nothing is delivered before the caller has set its handlers.
 * @param {{ nvr: string, ch: number, stream: number, fps?: number | null, h265?: boolean | number | null }} cam
 *   fps: 15 asks for a phone's stream (anything else: left out); h265: null while not known
 */
export function liveSocket(cam) {
  if (!enabled || optedOut() || clock.now() < fallbackUntil) return new WebSocket(liveUrl(cam))
  return new Channel(cam)
}

class Channel {
  constructor({ nvr, ch, stream, fps = null, h265 = null }) {
    this.id = nextId
    nextId = nextId >= 2147483647 ? 1 : nextId + 1
    this.readyState = 0
    this.binaryType = 'arraybuffer' // (frames always arrive as ArrayBuffers)
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.createdAt = clock.now()
    this.subAt = 0
    this.opening = false // subscribed, onopen not delivered yet
    this.sub = subMessage(this.id, { nvr, ch, stream, fps, h265 })
    if (!this.sub) {
      // What the server would refuse. It answers a malformed message with nothing at all (the tile
      // would wait for its watchdog) and closes the connection after 20 of them: fail it here.
      end(this, 1008, 'bad channel or stream')
      return
    }
    waiting.push(this)
    idle()
    connect()
    if (sockOpen && !flushTimer) flushTimer = clock.later(flush, SETTLE_MS)
  }

  // Waiting for its sub to go on a connection that is open (held back by the server's limits, or
  // settling): its turn comes, it is not a handshake that is stuck. LiveTile's #stuckConnecting
  // dropped such a channel after 8 s and sent its tile to the back with a longer back-off.
  get queued() {
    return this.readyState === 0 && sockOpen
  }

  close() {
    if (this.readyState === 3) return // (a tile is often closed twice: hidden, then the grid rebuilt)
    const i = waiting.indexOf(this)
    if (i >= 0) waiting.splice(i, 1) // its sub never went: nothing to take back
    const subscribed = channels.get(this.id) === this
    if (subscribed) {
      channels.delete(this.id)
      unsubs.push(this.id)
    }
    end(this, 1000, '', true)
    if (subscribed) {
      // Nothing at all has arrived on the connection for QUIET_MS while this one waited (typically
      // its tile's watchdog giving up): the connection is dead, not just this camera. Its other
      // channels close too, and their tiles reconnect on a new one.
      if (clock.now() - Math.max(lastRxAt, this.subAt) >= QUIET_MS) drop(sock, 'nothing received', false)
      else flush()
    }
    idle()
  }
}

function subMessage(id, { nvr, ch, stream, fps, h265 }) {
  if (typeof nvr !== 'string' || !nvr || !Number.isInteger(ch) || ch < 0 || ch > 255 || (stream !== 0 && stream !== 1)) return null
  const m = { op: 'sub', id, nvr, ch, stream }
  if (fps === 15) m.fps = 15
  if (h265 != null) m.h265 = h265 ? 1 : 0
  const text = JSON.stringify(m)
  return new TextEncoder().encode(text).length <= 1024 ? text : null
}

// Handlers are called on a later turn, never from inside the call that caused them, and read when
// called, not when queued: a tile closes its socket from inside its own player's callback
// (onUnsupported), and on 'online' this file drops a dead connection before live-tile.js's listener
// reconnects every tile, which first clears the handler of the one it replaces. One handler that
// throws must not keep the rest of the tiles from being told.
const outbox = []
let outboxTimer = null
function post(fn) {
  outbox.push(fn)
  if (!outboxTimer) outboxTimer = clock.later(deliver, 0)
}
function deliver() {
  outboxTimer = null
  for (const fn of outbox.splice(0)) {
    try {
      fn()
    } catch (e) {
      if (typeof reportError === 'function') reportError(e)
      else console.error(e)
    }
  }
}

/** The channel is over: onclose, once. */
function end(ch, code, reason, wasClean = false) {
  ch.readyState = 3
  ch.opening = false
  post(() => ch.onclose?.({ code, reason, wasClean }))
}

function opened(ch) {
  if (!ch.opening || ch.readyState !== 1) return
  ch.opening = false
  ch.onopen?.({ type: 'open' })
}

function connect() {
  if (sock) return
  const s = new WebSocket(`${wsBase()}/live-mux`)
  s.binaryType = 'arraybuffer'
  sock = s
  sockOpen = false
  // Not counted as a failure: other tabs of this site wait in the same one-at-a-time queue, so a slow
  // handshake says nothing about whether the server has /live-mux.
  connectTimer = clock.later(() => drop(s, 'not open after 8 s', false), CONNECT_TIMEOUT_MS)
  s.onopen = () => {
    if (sock !== s) return
    clock.cancel(connectTimer)
    connectTimer = null
    sockOpen = true
    everOpened = true
    failures = 0
    lastRxAt = clock.now()
    // (the server's buckets start full with each connection)
    subTokens = SUB_BURST
    tokensAt = lastRxAt
    messages = 0
    flush()
    idle()
  }
  s.onmessage = (e) => {
    if (sock === s) receive(e.data)
  }
  s.onclose = (e) => drop(s, e?.reason || 'connection lost', true, e?.code || 1006)
  s.onerror = () => {} // (a close follows)
}

/**
 * The connection is gone (closed, dropped, or given up on): every channel on it closes, and each
 * tile opens a new one with its own back-off. Nothing is subscribed again from here.
 * @param {boolean} failed closed by the other end: counts towards the fallback if it never opened
 */
function drop(s, reason, failed, code = 1006) {
  if (!s || s !== sock) return
  const wasOpen = sockOpen
  sock = null
  sockOpen = false
  for (const t of [connectTimer, flushTimer, idleTimer]) if (t) clock.cancel(t)
  connectTimer = flushTimer = idleTimer = null
  s.onopen = s.onmessage = s.onerror = s.onclose = null
  try { s.close(1000) } catch {}
  if (!wasOpen && failed && !everOpened && ++failures >= MAX_FAILURES) {
    failures = 0
    fallbackUntil = clock.now() + FALLBACK_MS
  }
  const lost = [...channels.values(), ...waiting]
  channels.clear()
  waiting.length = 0
  unsubs.length = 0
  for (const ch of lost) end(ch, code, reason)
}

/**
 * Sends what is due: every unsub at once (the server counts a channel until its unsub arrives, and
 * refuses a sub past 128), then each sub once it has settled, as the server's limit on subs allows.
 * What cannot go yet goes later; a channel waiting for its sub stays "connecting" (and `queued`), the
 * way a socket waits its turn in the browser's queue.
 */
function flush() {
  if (flushTimer) clock.cancel(flushTimer)
  flushTimer = null
  if (!sockOpen) return
  const t = clock.now()
  subTokens = Math.min(SUB_BURST, subTokens + (Math.max(0, t - tokensAt) * SUBS_PER_S) / 1000)
  tokensAt = t
  while (unsubs.length) send(JSON.stringify({ op: 'unsub', id: unsubs.shift() }))
  let wait = null
  // (held back by the channel limit: the next unsub or end calls this again)
  while (waiting.length && channels.size < MAX_CHANNELS) {
    const ch = waiting[0]
    if (t - ch.createdAt < SETTLE_MS) {
      wait = SETTLE_MS - (t - ch.createdAt)
      break
    }
    if (subTokens < 1) {
      wait = Math.max(1, Math.ceil(((1 - subTokens) * 1000) / SUBS_PER_S))
      break
    }
    subTokens--
    waiting.shift()
    ch.readyState = 1
    ch.subAt = t
    ch.opening = true
    channels.set(ch.id, ch)
    send(ch.sub)
    post(() => opened(ch))
  }
  if (wait !== null) flushTimer = clock.later(flush, wait)
}

function send(text) {
  sock.send(text)
  messages++
}

function receive(data) {
  lastRxAt = clock.now()
  if (typeof data === 'string') return control(data)
  if (!(data?.byteLength >= 4)) return
  const ch = channels.get(new DataView(data).getUint32(0, true))
  if (!ch) {
    counts.dropped++ // (closed here; the server had not had its unsub yet)
    return
  }
  counts.frames++
  if (ch.opening) opened(ch) // (a frame is never delivered before open)
  if (ch.readyState === 1) ch.onmessage?.({ data: data.slice(4) })
}

function control(text) {
  let m
  try {
    m = JSON.parse(text)
  } catch {
    return
  }
  if (!Number.isInteger(m?.id)) return
  if (m.op === 'wait' || m.op === 'convert') {
    const ch = channels.get(m.id)
    if (!ch) return
    if (ch.opening) opened(ch)
    if (ch.readyState === 1) ch.onmessage?.({ data: text })
    return
  }
  if (m.op !== 'end') return
  const ch = channels.get(m.id)
  if (!ch) {
    // closed here already, and its unsub still waiting to go: the server has let the id go itself
    const i = unsubs.indexOf(m.id)
    if (i >= 0) unsubs.splice(i, 1)
    return
  }
  channels.delete(m.id)
  end(ch, Number.isInteger(m.code) ? m.code : 1011, String(m.reason ?? ''), true)
  flush() // (room for a channel held back by the limit)
  idle()
}

/** No channel left: the connection is closed after IDLE_CLOSE_MS, unless one is opened meanwhile. */
function idle() {
  if (waiting.length || channels.size) {
    if (idleTimer) clock.cancel(idleTimer)
    idleTimer = null
    return
  }
  if (!sock || idleTimer) return
  idleTimer = clock.later(() => {
    idleTimer = null
    if (!waiting.length && !channels.size) drop(sock, 'idle', false, 1000)
  }, IDLE_CLOSE_MS)
}

// The network came back (a phone between Wi-Fi and mobile data, a laptop waking) or the page came
// back from the browser's cache: a quiet connection is dropped now. These listeners run before
// live-tile.js's (that file imports this one), so its reconnectNow then finds every channel closed
// and puts each tile on a fresh connection at once. One still opening is left to its time limit, as
// a tile leaves its own.
function wake() {
  if (!sockOpen) return
  if (clock.now() - lastRxAt > WAKE_QUIET_MS || (!waiting.length && !channels.size)) drop(sock, 'network changed', false)
}
if (typeof addEventListener === 'function') {
  addEventListener('online', wake)
  addEventListener('pageshow', (e) => { if (e.persisted) wake() })
}

/** For diagnostics from the console (window.cctvMux on the Live page). */
export function muxState() {
  const t = clock.now()
  return {
    on: enabled && !optedOut(),
    fallback: t < fallbackUntil,
    socket: sock ? (sockOpen ? 'open' : 'connecting') : 'none',
    channels: channels.size,
    waiting: waiting.length,
    unsubsWaiting: unsubs.length,
    messages,
    subsAllowedNow: sockOpen ? Math.floor(Math.min(SUB_BURST, subTokens + (Math.max(0, t - tokensAt) * SUBS_PER_S) / 1000)) : null,
    quietMs: sockOpen ? t - lastRxAt : null,
    failures,
    everOpened,
    frames: counts.frames,
    dropped: counts.dropped
  }
}

/**
 * On a big grid over a slow link the shared connection carries a backlog of the page being left; the
 * new page's streams queue behind it (the server logs "a page socket has stopped, N MB queued", and
 * the last page's tiles stayed 'connecting' for seconds). Dropping the connection before the new page
 * subscribes lets it start on a clean one -- the tiles that were on it are being replaced anyway, so
 * each opens a fresh channel on the new connection. Only for grids big enough to back up; a small
 * grid, where there is no backlog to speak of, is left alone so its page change stays instant.
 * @param {number} [minChannels] act only when the page being left has at least this many tiles
 */
export function freshenForPageChange(minChannels = 17) {
  if (sock && sockOpen && channels.size + waiting.length >= minChannels) drop(sock, 'the page changed on a big grid', false)
}

/** (tests) Forgets every channel and the connection, off again; clock: { now, later, cancel }. */
export const _test = {
  reset(c = realClock) {
    for (const t of [connectTimer, flushTimer, idleTimer, outboxTimer]) if (t) clock.cancel(t)
    connectTimer = flushTimer = idleTimer = outboxTimer = null
    clock = c
    enabled = false
    sock = null
    sockOpen = false
    everOpened = false
    failures = 0
    fallbackUntil = 0
    lastRxAt = 0
    nextId = 1
    waiting.length = 0
    channels.clear()
    unsubs.length = 0
    subTokens = SUB_BURST
    tokensAt = 0
    messages = 0
    outbox.length = 0
    counts.frames = counts.dropped = 0
  }
}
