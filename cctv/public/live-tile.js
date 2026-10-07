// One live camera in a tile: streams it over WebSocket into a VideoPlayer, with reconnects.
// Used by the live grid (viewer.js) and the map's live popup (map.js).
import { clearStill, maybeKeepStill, showStill } from './stills.js'
import { CODEC_H265, VideoPlayer, canDecodeH265 } from './player.js'
import { liveSocket } from './live-mux.js'
import { activeTrace } from './frame-trace.js'
import { streamState, lastSeenText, cameraSeen, rememberCameraSeen } from './view-preferences.js'
import { streamHealth, healthyRetryReset } from './stream-health.js'
import { liveMetricsText } from './live-metrics.js'
import { cameraConnectionState } from './sites-model.js'

// Whether this device can play H.265, told to the server with each live stream: a remote viewer
// who can is sent an H.265 camera as it is (about half the data of H.264 for the same picture)
// instead of a conversion. Unknown until the check answers (a moment after the page loads); a
// stream opened before then is simply not told, and gets the safe H.264.
let deviceH265 = null
if (typeof window !== 'undefined') canDecodeH265().then((v) => (deviceH265 = v)).catch(() => {})
import { drawOsd, osdIsOff, osdLayout } from './osd-overlay.js'

const HEADER_SIZE = 16
export const SUB_STREAM = 1
export const MAIN_STREAM = 0
// The server's reason for refusing the main stream (stream-param.mjs): no Live HD on the camera. The
// tile goes over to the sub-stream rather than asking again (the server would refuse it every time).
export const HD_REFUSED = 'hd not allowed'

/** What a tile says while the server tells it its sub-stream has no picture yet (live-wait.mjs). */
export function waitText(why) {
  if (why === 'held') return 'Waiting for room at the NVR (SD streams)'
  if (why === 'unavailable') return 'SD stream not available from the NVR'
  return 'Starting…'
}
// stall watchdog: an open socket that delivers no frames this long shows 'no video' (about 2-3
// GOPs), and this long is closed and opened again (the server may have dropped a frozen stream)
export const NO_VIDEO_MS = 5000
export const STALL_RECONNECT_MS = 8000
// reconnect back-off: 1, 2, 4, 8 s then every 8 s (with jitter). It was up to 30 s: a camera that
// dropped for a moment stayed black half a minute after it was back.
export const RECONNECT_MAX_MS = 8000
// A connection still not open after this long, while no other one has opened either, is dropped and
// tried again (see #stuckConnecting). Browsers open WebSockets to one server ONE AT A TIME (RFC 6455
// 4.1): through the public link 24 at once opened over 6.5 s, one every ~250 ms (2026-09-27), so an
// 8x8 grid's last tile waits ~16 s for its turn. Dropping every socket older than a few seconds sent
// those to the back of the queue again and the grid, and the full-size view behind it, never loaded.
export const CONNECT_TIMEOUT_MS = 8000
let lastOpenAt = 0 // when any tile's socket last opened: the browser's queue is moving
// A tile under the full-size view keeps its connection and, without decoding, the stream from its
// last keyframe (at most this much): back on the grid it shows that at once and carries on. It used
// to reconnect, and through the internet link that was 1.7 s before the first tile moved again and
// 4.5 s before all nine did (2026-09-26). Past the limit it reconnects as before.
export const HOLD_MAX_BYTES = 3_000_000
export const reconnectDelay = (attempts) => Math.min(RECONNECT_MAX_MS, 1000 * 2 ** attempts)

// Every tile on the page, so that the network coming back (a phone moving between Wi-Fi and mobile
// data, a laptop waking) reconnects the waiting ones at once instead of at the end of their timer.
const liveTiles = new Set()

// One timer for every tile's once-a-second status (fps badge, stall check, overlay clock): a big
// grid had one interval per tile.
let ticker = null
function tickAll() {
  if (liveTiles.size === 0) {
    clearInterval(ticker)
    ticker = null
    return
  }
  for (const t of liveTiles) if (!t.closed) t.updateStatus()
}
const startTicker = () => {
  if (ticker) return
  ticker = setInterval(tickAll, 1000)
  ticker.unref?.() // (Node, in tests: never what keeps the process alive)
}
if (typeof addEventListener === 'function') {
  addEventListener('online', () => { for (const t of liveTiles) t.reconnectNow() })
  addEventListener('pageshow', (e) => { if (e.persisted) for (const t of liveTiles) t.reconnectNow() })
}

// A small page chip shown while the server is easing quality for bandwidth (adaptive-live.mjs #move,
// {op:'ease'}), so a lighter picture on a busy link reads as deliberate rather than broken. One chip
// for the page: present while any tile is eased, gone when none are.
const easedTiles = new Set()
let easeChip = null
function updateEaseChip() {
  if (typeof document === 'undefined') return
  if (easedTiles.size > 0 && !easeChip) {
    easeChip = document.createElement('div')
    easeChip.className = 'ease-chip'
    easeChip.textContent = 'Easing off · link busy'
    easeChip.title = 'The picture is lighter on purpose to fit the available bandwidth; it sharpens when the link frees up.'
    document.body.append(easeChip)
  } else if (easedTiles.size === 0 && easeChip) {
    easeChip.remove()
    easeChip = null
  }
}

/** The markup a LiveTile expects inside its tile element. */
// The .osd canvas sits over the video canvas and is drawn by this app (osd-overlay.js), never by
// the camera. It is a second canvas rather than drawing onto the player's own, because the player
// redraws that one on every frame and would wipe the text, and because the overlay must be able to
// come and go without the streaming path knowing anything about it.
export const TILE_HTML = '<canvas></canvas><canvas class="osd"></canvas><pre class="stats"></pre><span class="status"></span><span class="last-seen"></span><div class="label"><span class="dot dot-off" title="No video: nothing is arriving from this camera"></span><span class="name"></span><span class="stream-metrics" title="Received video: decoded resolution, codec, received FPS and average video payload bitrate"></span></div>'

/**
 * The state dot on a tile, the way Milestone shows it: green when video is arriving, red when
 * that camera is also being recorded by the server, grey when nothing is arriving. Pure, so it
 * can be tested without a DOM. The title carries the state in words as well, because colour on
 * its own is no use to a colour-blind viewer or a screen reader.
 *
 * `recording` is not known in the live grid today (/api/cameras does not report it), so
 * `undefined` is treated as "not known to be recorded" and shows green rather than red.
 *
 * @param {{ hasVideo?: boolean, recording?: boolean, stale?: boolean }} [state]
 * @returns {{ className: string, title: string }}
 */
export function tileDot({ hasVideo = false, recording = undefined, stale = false } = {}) {
  if (!hasVideo || stale) return { className: 'dot dot-off', title: 'No video: nothing is arriving from this camera' }
  if (recording === true) return { className: 'dot dot-rec', title: 'Video is arriving and this camera is being recorded' }
  return { className: 'dot dot-live', title: 'Video is arriving' }
}

export class LiveTile {
  /**
   * @param {HTMLElement} tile element with TILE_HTML inside
   * @param {{ nvr: string, ch: number }} cam
   * @param {number} streamType
   * @param {number} startDelayMs tiles open slightly staggered so a big grid doesn't hit the NVR all at once
   * @param {{ pacing?: boolean, clock?: object, maxQueuedFrames?: number, noRewindMs?: number, statsVisible?: () => boolean, onDisconnect?: () => void,
   *   onFirstFrame?: () => void, onUnsupported?: (codecId: number) => void }} [opts]
   *   clock: PlayoutClock options (the "Smooth" setting; a page through the tunnel's REMOTE_CLOCK);
   *   maxQueuedFrames: decoded frames the player keeps (the tunnel's bigger buffer: viewer.js);
   *   noRewindMs: no frame shown at or before one shown already, within this (a page through the
   *   tunnel: player.js REMOTE_NO_REWIND_MS);
   *   onFirstFrame: the first frame is on screen;
   *   recording: tells the dot whether the server is also recording this camera (red rather than
   *   green); leave it out where that is not known. onUnsupported: replaces the built-in handling (main -> sub fallback, message) when the
   *   browser can't play the stream
   *   onHdRefused: the main stream was refused for want of Live HD; return true when handled
   *   (viewer.js drops a layer not shown yet), else the tile goes over to the sub-stream itself
   */
  constructor(tile, cam, streamType, startDelayMs = 0, opts = {}) {
    this.tile = tile
    this.cam = cam
    this.nvr = cam.nvr
    this.ch = cam.ch
    this.streamType = streamType
    this.opts = opts
    this.status = tile.querySelector('.status')
    this.statsEl = tile.querySelector('.stats')
    this.metricsEl = tile.querySelector('.stream-metrics')
    this.connectionEl = null
    if (typeof document !== 'undefined' && document.createElement && tile.querySelector('.label')) {
      this.connectionEl = tile.querySelector('.connection-label') || document.createElement('span')
      this.connectionEl.className = 'connection-label'
      tile.querySelector('.label').append(this.connectionEl)
    }
    this.dotEl = tile.querySelector('.dot') // absent in older markup: the dot is then simply not drawn
    this.osdEl = tile.querySelector('canvas.osd') // absent in older markup: no overlay is drawn
    this.osdSig = '' // what is on the overlay canvas now, so it is only repainted when it changes
    this.closed = false
    this.waiting = false // the server said its sub-stream has no picture yet (a wait note, live-wait.mjs)
    this.suspended = false // connected, but frames are dropped (not decoded): see suspend()
    this.released = false // suspended AND disconnected, so the server stops sending it: see release()
    this.attempts = 0 // reconnects since video last arrived
    this.now = opts.now ?? (() => Date.now()) // (tests)
    this.lastDataAt = 0 // the last frame on this socket, or when it opened
    this.lastFrameAt = 0
    this.healthySince = 0
    this.maxFps = opts.maxFps ?? null // a phone asks the server for its 15 fps stream (phone-live.mjs)
    this.taps = new Set() // tiles borrowing this one's stream (#borrow)
    this.gop = null // the stream since its last keyframe (#keep)
    this.gopBytes = 0
    this.source = null // the tile whose stream this one shows, when borrowing
    this.tap = null
    let shown = false
    this.player = new VideoPlayer(tile.querySelector('canvas'), {
      pacing: opts.pacing ?? true,
      paintFirst: true, // the camera appears the moment its first keyframe is decoded
      // each frame timed as it arrives, and the burst after a hiccup decoded, not dropped to the next
      // keyframe as if the decoder could not keep up (player.js; stutter report 2.2, 29 Sep)
      arrivalClock: true,
      clock: opts.clock,
      maxQueuedFrames: opts.maxQueuedFrames,
      noRewindMs: opts.noRewindMs,
      maxFps: opts.maxFps,
      onUnsupported: (codecId) => (opts.onUnsupported ? opts.onUnsupported(codecId) : this.onUnsupported(codecId)),
      onFrame: () => {
        this.lastFrameAt = this.now()
        if (!this.healthySince) this.healthySince = this.lastFrameAt
        if (healthyRetryReset(this.healthySince, this.lastFrameAt)) this.attempts = 0
        rememberCameraSeen(`${this.nvr}/${this.ch}`, Date.now())
        if (!shown) clearStill(tile)
        // keep the last picture of this camera on this device, for the next time its tile appears
        if (typeof document !== 'undefined') maybeKeepStill(this.player.canvas, this.nvr, this.ch)
        // a picture on screen is live, whatever the badge said a moment ago ("connecting…" stayed
        // up until a whole second of frames had been counted, over a picture already moving)
        if (this.waiting || /connecting|no video/.test(this.status.textContent)) {
          this.waiting = false
          this.setStatus('LIVE', true)
        }
        if (shown) return
        shown = true
        opts.onFirstFrame?.()
      }
    })
    this.setStatus('connecting…')
    // the last picture seen of this camera, at once, until its live picture arrives (stills.js)
    if (typeof document !== 'undefined' && !opts.noStill) showStill(tile, this.nvr, this.ch)
    // the same camera already streaming in another tile (the grid, or a camera started ahead):
    // show its stream at once rather than open a connection of our own
    if (!this.#borrow(opts.borrowFrom)) this.retry = setTimeout(() => this.connect(), startDelayMs)
    liveTiles.add(this)
    this.statusTimer = null // (the shared ticker above drives updateStatus)
    startTicker()
  }

  setStatus(text, live = false) {
    if (this.tile.dataset) this.tile.dataset.streamState = streamState(text, live)
    // (only when it changes: a big grid would otherwise write every badge every second)
    if (this.status.textContent !== text) this.status.textContent = text
    this.status.classList.toggle('live', live)
    const lastSeen = this.tile.querySelector('.last-seen')
    if (lastSeen) {
      lastSeen.hidden = live
      const label = lastSeenText(cameraSeen(`${this.nvr}/${this.ch}`))
      if (lastSeen.textContent !== label) lastSeen.textContent = label
    }
  }

  /** Paints the state dot (only when it changes: a big grid would otherwise rewrite every tile every second). */
  setDot(state) {
    if (!this.dotEl) return
    const { className, title } = tileDot(state)
    if (this.dotEl.className !== className) this.dotEl.className = className
    if (this.dotEl.title !== title) this.dotEl.title = title
  }

  /**
   * Paints this app's overlay (osd-overlay.js) over the picture.
   *
   * The overlay canvas is given exactly the same pixel size as the player's canvas and the same
   * `object-fit: contain` in the stylesheet, so the two letterbox identically and the text sits
   * where the settings say it does relative to the PICTURE, not to the tile's black bars.
   *
   * `opts.osd()` gives the settings, the camera and the moment. The moment must be on the SERVER's
   * clock (viewer.js measures the difference from the server's Date header), because that is the
   * authoritative clock here and the whole reason this overlay exists rather than the camera's own.
   * Nothing is drawn when the tile has no picture yet: a time over a black tile looks like footage.
   */
  drawOverlay() {
    const el = this.osdEl
    if (!el) return
    const info = this.opts.osd?.(this)
    const vw = this.player?.canvas?.width ?? 0
    const vh = this.player?.canvas?.height ?? 0
    if (!info || osdIsOff(info.settings) || !this.player?.videoWidth || vw < 2 || vh < 2) {
      if (this.osdSig !== '') {
        el.width = 0 // a zero-sized canvas draws nothing and costs nothing
        this.osdSig = ''
      }
      return
    }
    const ctx = el.getContext('2d')
    if (!ctx) return
    const layout = osdLayout({
      settings: info.settings,
      camera: info.camera ?? {},
      atMs: info.atMs ?? null,
      width: vw,
      height: vh,
      tzMs: info.tzMs ?? 0,
      // A real measurement rather than the estimate, so a long camera name is cut at the right place
      // in whatever font this browser actually resolved.
      measure: (text, fontPx) => {
        ctx.font = `600 ${fontPx}px system-ui, "Segoe UI", Roboto, sans-serif`
        return ctx.measureText(text).width
      }
    })
    const sig = `${vw}x${vh}|${layout.lines.map((l) => `${l.text}@${Math.round(l.x)},${Math.round(l.y)}`).join('|')}`
    if (sig === this.osdSig && el.width === vw) return // a wall of tiles is not repainted for nothing
    this.osdSig = sig
    if (el.width !== vw || el.height !== vh) {
      el.width = vw
      el.height = vh
    } else ctx.clearRect(0, 0, vw, vh)
    drawOsd(ctx, layout)
  }

  updateStatus() {
    // borrowing from a tile that has closed or lost its connection: connect by ourselves
    if (this.source && (this.source.closed || this.source.ws?.readyState !== 1) && !this.closed) {
      this.#unborrow()
      this.connect()
    }
    const s = this.player.stats
    const connection = cameraConnectionState(this.cam)
    if (this.connectionEl) {
      this.connectionEl.textContent = connection?.text || ''
      this.connectionEl.title = connection?.detail || ''
      this.connectionEl.className = `connection-label connection-${connection?.key || 'unknown'}`
    }
    activeTrace()?.stats(this, s) // the D overlay's frame trace (frame-trace.js), when one runs
    const ws = this.ws
    const open = (this.source ? true : ws && ws.readyState === 1) && !this.suspended && !this.closed
    const since = open ? this.now() - (this.lastDataAt || this.now()) : 0
    const metrics = liveMetricsText(s, this.streamType === MAIN_STREAM, Boolean(open && this.lastFrameAt && since < 3000))
    if (this.metricsEl && this.metricsEl.textContent !== metrics) this.metricsEl.textContent = metrics
    const health = streamHealth({ now: this.now(), openedAt: this.connectAt || this.lastDataAt || this.now(),
      dataAt: this.lastDataAt, frameAt: this.lastFrameAt, waiting: this.waiting,
      hidden: Boolean(this.suspended || (typeof document !== 'undefined' && document.hidden)) })
    if (health.stale) this.healthySince = 0
    const canRecover = typeof document === 'undefined' || !document.hidden
    if (!this.source && !this.closed && ws?.readyState === 0 && this.#stuckConnecting()) {
      // a connection that never opens (its handshake stuck in Cloudflare or behind a frozen NVR)
      // waited for ever, and held up every other one behind it: the full-size view sat on the
      // sub-stream for 10+ minutes and a first click sometimes showed nothing (2026-09-27). Give up
      // on it and try again with the back-off.
      const onclose = ws.onclose
      ws.onclose = null
      ws.onmessage = null
      ws.onopen = null
      ws.close()
      onclose?.()
    } else if (open && canRecover && (health.recover || (!this.waiting && since >= STALL_RECONNECT_MS)) && this.source) {
      // the borrowed stream stopped: a connection of our own
      this.#unborrow()
      this.connect()
    } else if (open && canRecover && (health.recover || (!this.waiting && since >= STALL_RECONNECT_MS))) {
      // frames stopped on a socket that stays open: drop it (without waiting for its close
      // handshake, which may be stuck behind the backlog) and connect again with the back-off
      this.lastDataAt = 0
      const onclose = ws.onclose
      ws.onclose = null
      ws.onmessage = null
      ws.close()
      onclose?.()
    } else if (open && health.stale && !this.waiting) this.setStatus(health.text)
    else if (s.fps > 0 && open) {
      this.setStatus('LIVE', true)
      const fps = `${s.fps} fps`
      if (this.status.title !== fps) this.status.title = fps
    }
    this.setDot({
      hasVideo: Boolean(open && this.lastDataAt && s.fps > 0),
      stale: Boolean(open && health.stale),
      // the live grid has no per-camera recording flag yet; a caller that knows can supply one
      recording: this.opts.recording?.(this)
    })
    if (this.opts.statsVisible?.()) {
      this.statsEl.textContent = [
        `${s.width}×${s.height} ${s.codec} (${s.hw})`,
        `decoded ${s.coded} · visible ${s.visible} · canvas ${this.player?.canvas?.width ?? '?'}×${this.player?.canvas?.height ?? '?'}`,
        `${s.fps} fps · jitter ${s.jitterMs} ms`,
        `buffer ${s.delayMs} ms · ${s.kbps} kbps`,
        // (older: frames held back for being at or before one shown, on a page through the tunnel)
        `dropped ${s.dropped} · late ${s.late} · resync ${s.resyncs}${s.older ? ` · older ${s.older}` : ''}`
      ].join('\n')
    }
    // Once a second, which is exactly the resolution of the clock being shown.
    this.drawOverlay()
  }

  /**
   * This socket's handshake is stuck, not queued: past the limit, nothing has opened meanwhile, and
   * it is the oldest one waiting (the one the browser is actually trying; the rest wait behind it).
   */
  #stuckConnecting() {
    // a channel waiting its turn on the page's open shared connection (live-mux.js: the server's
    // limits hold its sub back for a moment) is not a stuck handshake
    if (this.ws?.queued) return false
    const now = this.now()
    if (now - this.connectAt < CONNECT_TIMEOUT_MS || now - lastOpenAt < CONNECT_TIMEOUT_MS) return false
    for (const t of liveTiles) {
      if (t !== this && !t.closed && t.ws?.readyState === 0 && t.connectAt < this.connectAt) return false
    }
    return true
  }

  connect() {
    if (this.closed || this.suspended) return
    this.setStatus('connecting…')
    // On the Live page a channel on the page's one shared connection (live-mux.js), which behaves
    // like a socket here; elsewhere a socket of its own to /live, as always
    this.ws = liveSocket({ nvr: this.nvr, ch: this.ch, stream: this.streamType, fps: this.maxFps, h265: deviceH265 })
    this.ws.binaryType = 'arraybuffer'
    this.lastDataAt = 0
    this.lastFrameAt = 0
    this.healthySince = 0
    this.connectAt = this.now()
    // The frame trace (frame-trace.js), when the viewer runs one from the D overlay: each frame as it
    // arrives here, on this tile's socket or channel, and what happens to the connection. Otherwise
    // one call per frame that finds none.
    activeTrace()?.event(this, 'connect', this.streamType === MAIN_STREAM ? 'main' : 'sub')
    this.ws.onopen = () => {
      this.lastDataAt = this.now()
      lastOpenAt = this.lastDataAt
      activeTrace()?.event(this, 'open')
    }
    this.ws.onmessage = (e) => {
      this.lastDataAt = this.now()
      // a text is a note from the server, never a frame (live-wait.mjs: the sub-stream has no picture
      // yet); it is activity all the same, so the stall watchdog leaves the tile alone
      if (typeof e.data === 'string') return this.#note(e.data)
      const buf = new Uint8Array(e.data)
      activeTrace()?.frame(this, buf)
      this.onMessage(buf)
    }
    this.ws.onclose = (e) => {
      activeTrace()?.event(this, 'close')
      this.player.reset()
      if (this.closed) return
      // the main stream refused for want of Live HD (at once, or taken away while it played): not
      // asked for again from here, the sub-stream instead
      if (e?.code === 1008 && e.reason === HD_REFUSED && this.streamType === MAIN_STREAM) return this.#hdRefused()
      this.opts.onDisconnect?.()
      this.setStatus('reconnecting…')
      // back off (1, 2, 4, 8 s: reconnectDelay) with jitter, so many tiles don't reconnect in lockstep
      const delay = reconnectDelay(this.attempts) * (0.7 + Math.random() * 0.6)
      this.attempts++
      this.retry = setTimeout(() => this.connect(), delay)
    }
  }

  /**
   * A note from the server:
   *  - {"op":"wait","why":…}  while the sub-stream has no picture yet
   *  - {"op":"ease","on":bool} quality is (no longer) being eased for bandwidth (adaptive-live.mjs)
   */
  #note(text) {
    let m
    try {
      m = JSON.parse(text)
    } catch {
      return
    }
    if (m?.op === 'ease') {
      if (m.on) easedTiles.add(this)
      else easedTiles.delete(this)
      return updateEaseChip()
    }
    if (m?.op !== 'wait') return
    this.waiting = true
    this.setStatus(waitText(m.why))
  }

  /**
   * The main stream refused for want of Live HD: the caller may handle it (viewer.js: a layer not
   * shown yet simply goes, the sub-stream under it stays); otherwise this tile goes over to the
   * sub-stream at once, for good, and says so.
   */
  #hdRefused() {
    if (this.opts.onHdRefused?.() === true) return
    this.streamType = SUB_STREAM
    // append, don't rewrite: the name element also holds the Recordings link in full screen
    this.tile.querySelector('.name')?.append(' (SD: full quality needs Live HD)')
    this.attempts = 0
    this.connect()
  }

  onMessage(buf) {
    if (buf.length <= HEADER_SIZE) return
    this.#keep(buf)
    for (const tap of this.taps) tap(buf)
    if (!this.suspended) this.#decode(buf)
  }

  #decode(buf) {
    const view = new DataView(buf.buffer, buf.byteOffset)
    this.player.push({
      isKey: (buf[0] & 1) === 1,
      codecId: buf[1],
      timestampUs: Number(view.getBigInt64(8, true)),
      data: buf.subarray(HEADER_SIZE)
    })
  }

  /**
   * The stream since its last keyframe, kept always (at most HOLD_MAX_BYTES): what lets this tile
   * pick up at once after being hidden (resume) and lend its picture to the full-size view (borrow).
   */
  #keep(buf) {
    if ((buf[0] & 1) === 1) {
      this.gop = [buf]
      this.gopBytes = buf.length
      return
    }
    if (!this.gop) return
    if (this.gopBytes + buf.length > HOLD_MAX_BYTES) {
      this.gop = null // too long a stretch to keep: nothing to lend until the next keyframe
      return
    }
    this.gop.push(buf)
    this.gopBytes += buf.length
  }

  /** Connected, with a picture's worth kept: something another tile can start from at once. */
  get lendable() {
    return !this.closed && this.ws?.readyState === 1 && Boolean(this.gop?.length) && this.lastDataAt > 0 && this.now() - this.lastDataAt < 3000
  }

  /**
   * Shows another tile's stream of the same camera instead of opening a connection of its own: its
   * kept stretch at once, then every frame it receives. Through the internet link a new connection
   * was 1-1.8 s before the full-size view showed anything (2026-09-26). If that tile stops (closed,
   * reconnecting), this one connects by itself (updateStatus).
   * @returns {boolean} false: nothing to borrow (the caller connects as usual)
   */
  #borrow(src) {
    if (!src?.lendable || src.streamType !== this.streamType || src.nvr !== this.nvr || src.ch !== this.ch) return false
    this.source = src
    this.lastDataAt = this.now()
    activeTrace()?.event(this, 'borrow', src) // its frames are the source's, traced there
    for (const m of src.gop) this.onMessage(m)
    this.tap = (buf) => {
      this.lastDataAt = this.now()
      this.onMessage(buf)
    }
    src.taps.add(this.tap)
    return true
  }

  /** Stops borrowing (the source went away, or this tile closes). */
  #unborrow() {
    if (!this.source) return
    this.source.taps.delete(this.tap)
    this.source = null
    this.tap = null
  }

  onUnsupported(codecId) {
    if (codecId === CODEC_H265 && this.streamType === MAIN_STREAM) {
      // browser can't decode H.265: fall back to the H.264 sub stream
      this.streamType = SUB_STREAM
      // append, don't rewrite: the name element also holds the Recordings link in full screen
      this.tile.querySelector('.name').append(' (sub stream, no H.265 in this browser)')
      this.ws.close()
      return
    }
    this.setStatus(codecId === CODEC_H265 ? 'H.265 — set sub-stream to H.264' : 'unsupported codec')
    // the browser can't show this stream: stop pulling it rather than load the NVR for nothing
    const msg = document.createElement('div')
    msg.className = 'tile-msg'
    msg.textContent =
      codecId === CODEC_H265
        // Same correction as playback.js: on Windows this is nearly always a missing codec, not a
        // machine that cannot cope. Saying "change it on the NVR" first sends people to reconfigure
        // a camera when installing one extension would have done.
        ? 'This camera sends H.265, which this browser cannot play. On Windows, Chrome and Edge need the "HEVC Video Extensions" from the Microsoft Store — installing it usually fixes this. Otherwise set the camera’s sub-stream to H.264 on the NVR.'
        : 'This browser cannot play this camera’s video format.'
    this.tile.append(msg)
    liveTiles.delete(this) // (off the ticker too)
    this.closed = true
    // its decoder and timers: this tile will never play (called from inside the player: after this turn)
    queueMicrotask(() => { try { this.player.close() } catch {} })
    clearTimeout(this.retry)
    this.ws?.close()
  }

  /**
   * Keeps the connection and keeps the stream from its last keyframe (#keep), but decodes nothing:
   * hidden under a full-size view, or started ahead as the full-size view's next camera.
   */
  suspend() {
    this.suspended = true
    activeTrace()?.event(this, 'suspend')
  }

  /**
   * Like suspend, but closes the connection so the server stops sending this stream. suspend alone
   * keeps the stream flowing (the frames are only dropped at the client), so a grid left under the
   * full-size view went on using its share of the link -- on a tunnel, 25-64 streams competing with
   * the one camera being watched. resume() reconnects a released tile; the stall watchdog leaves a
   * suspended one alone, so nothing reconnects it meanwhile.
   */
  release() {
    if (this.closed) return
    this.suspended = true
    this.released = true
    clearTimeout(this.retry)
    this.retry = null
    if (this.ws) {
      this.ws.onclose = null // resume() does the reconnect, not the socket's own close handler
      this.ws.onmessage = null
      this.ws.close()
      this.ws = null
    }
    activeTrace()?.event(this, 'suspend')
  }

  /**
   * Picks up again at once. Still connected, with the stream kept from its last keyframe: that is
   * decoded now and the frames carry on (no reconnect). Otherwise it reconnects, and the server
   * starts the new connection with the stream's latest keyframe.
   */
  resume() {
    if (!this.suspended || this.closed) return
    // the frame trace says which way it came back, as its replay must do the same (test/live-replay.mjs
    // segments); said while still hidden, so a trace that first sees the tile here knows it was
    const kept = this.lendable && !this.released // a released tile has no connection: it must reconnect
    activeTrace()?.event(this, 'resume', kept ? 'kept' : 'reconnect')
    this.suspended = false
    this.released = false
    if (kept) {
      this.player.reset()
      for (const m of this.gop) this.#decode(m)
      return
    }
    this.player.reset() // the last picture stays on the canvas until the new frames arrive
    clearTimeout(this.retry)
    if (this.ws) {
      this.ws.onclose = null
      this.ws.onmessage = null
      this.ws.close()
    }
    this.attempts = 0
    this.connect()
  }

  /** Waiting to reconnect (or on a dead socket): try again now, from the start of the back-off. */
  reconnectNow() {
    if (this.closed || this.suspended || this.source) return
    // left alone: a socket still opening, and an open one with frames in the last 2 s. An open one
    // gone quiet is replaced: after a network change a phone's socket can stay 'open' on a dead
    // connection until TCP gives up, minutes later.
    if (this.ws?.readyState === 0) return
    if (this.ws?.readyState === 1 && this.lastDataAt && this.now() - this.lastDataAt < 2000) return
    clearTimeout(this.retry)
    if (this.ws) {
      this.ws.onclose = null
      this.ws.onmessage = null
      this.ws.close()
    }
    this.attempts = 0
    this.connect()
  }

  close() {
    if (!this.closed) activeTrace()?.event(this, 'end')
    liveTiles.delete(this)
    if (easedTiles.delete(this)) updateEaseChip()
    this.closed = true
    this.#unborrow()
    this.taps.clear()
    this.gop = null
    clearTimeout(this.retry)
    this.ws?.close()
    this.player.close()
  }
}
