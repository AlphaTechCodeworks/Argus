// One live camera in a tile: streams it over WebSocket into a VideoPlayer, with reconnects.
// Used by the live grid (viewer.js) and the map's live popup (map.js).
import { clearStill, maybeKeepStill, showStill } from './stills.js'
import { CODEC_H265, VideoPlayer, canDecodeH265 } from './player.js'
import { liveSocket } from './live-mux.js'
import { activeTrace } from './frame-trace.js'

// Whether this device can play H.265, told to the server with each live stream: a remote viewer
// who can is sent an H.265 camera as it is (about half the data of H.264 for the same picture)
// instead of a conversion. Unknown until the check answers (a moment after the page loads); a
// stream opened before then is simply not told, and gets the safe H.264.
let deviceH265 = null
if (typeof window !== 'undefined') canDecodeH265().then((v) => (deviceH265 = v)).catch(() => {})
// A viewer on the local network whose browser cannot play H.265 is sent an H.265 stream converted
// to H.264 by the server (h264-fallback.mjs), but only when the page says so itself (h265=0): not
// saying is not "cannot". So the answer goes both ways, and three things make it "cannot":
//  - the check above answered no;
//  - a tile's decoder refused a real H.265 keyframe (the check can say yes for a decoder that then
//    fails, and a stream opened before the check answered was not told): remembered for as long as
//    the page lives, so every later tile asks for H.264 the first time;
//  - ?h265=0 on the page's address, for testing the conversion from a PC that plays H.265 perfectly
//    well (https://…/?h265=0). Honoured as a downgrade only: ?h265=1 or anything else is ignored, so
//    the address can never claim a decoder the browser lacks. (The full-size view's main stream is
//    asked for the same way, and comes converted too while the server has room for it.)
let learnedNoH265 = false
/** Whether the page's address forces "this browser cannot play H.265" (?h265=0, nothing else). */
export function h265Forced(search) {
  try {
    return new URLSearchParams(search ?? '').get('h265') === '0'
  } catch {
    return false
  }
}
const forcedNoH265 = typeof location !== 'undefined' && h265Forced(location.search)
/**
 * What a stream is opened with: true (plays H.265), false (cannot: forced, learnt, or the check said
 * so), null (not known yet: the server is told nothing, and sends the camera's stream as it is).
 * @param {{ device: boolean|null, forced?: boolean, learned?: boolean }} o
 */
export function h265Answer({ device, forced = false, learned = false }) {
  if (forced || learned) return false
  return device === true ? true : device === false ? false : null
}
/**
 * Whether the page knows by now that this browser cannot play H.265 (the check said so, a decoder
 * refused, or the address forces it): the Live page limits its grid then (viewer.js). It can turn
 * true at any moment while the page lives, and never turns back.
 */
export function cannotPlayH265() {
  return h265Answer({ device: deviceH265, forced: forcedNoH265, learned: learnedNoH265 }) === false
}
// The server's reasons for closing a stream it could not convert (h264-fallback.mjs NO_ROOM, FAILED)
export const H264_NO_ROOM = 'h265: no room to convert'
export const H264_FAILED = 'h265: conversion failed'
// ...after which the tile asks again this often: room comes back when another viewer closes a camera
export const H264_RETRY_MS = 30_000
// H.265 keyframes a tile may meet in a row, each answered by asking again for H.264, before it gives
// up and shows the message: the first can be a stream opened before the page knew, the second one the
// server attached before it had seen what the camera sends. A third is a server that does not convert.
export const H264_ASKS = 2
const H265_ADVICE = 'On Windows, Chrome and Edge need the "HEVC Video Extensions" from the Microsoft Store — installing it usually fixes this. Otherwise set the camera’s sub-stream to H.264 on the NVR.'
/**
 * What a tile says when it cannot show an H.265 camera: the badge and the message under it.
 * why: H264_NO_ROOM / H264_FAILED (the server said it cannot convert it); anything else: this
 * browser cannot play it and nothing converts it (a main stream, a remote viewer, an older server).
 */
export function h265Text(why) {
  if (why === H264_NO_ROOM) return { status: 'H.265 — server busy', text: `This camera sends H.265, which this browser cannot play, and the server has no room to convert another H.265 camera right now: it is already converting as many as it is allowed. It will try again by itself. ${H265_ADVICE}` }
  if (why === H264_FAILED) return { status: 'H.265 — not converted', text: `This camera sends H.265, which this browser cannot play, and the server could not convert it. It will try again by itself. ${H265_ADVICE}` }
  return { status: 'H.265 — set sub-stream to H.264', text: `This camera sends H.265, which this browser cannot play. ${H265_ADVICE}` }
}
export const CONVERTED_TITLE = 'This camera sends H.265, which this browser cannot play, so the server is converting it to H.264 for this PC. That costs the server CPU for as long as it is watched; setting the camera’s sub-stream to H.264 on the NVR removes the need.'
// The server's reason for refusing a main stream it has no room to convert (NO_ROOM_MAIN): the server
// converts few of those at once, and the full-size view has the sub-stream to show instead
export const H264_NO_ROOM_MAIN = 'h265: no room to convert main'
// ...and on a converted main stream (the full-size view): what it is, and that it is not the camera's full size
export const CONVERTED_MAIN_TITLE = 'This camera sends H.265, which this browser cannot play, so the server is converting its full-quality picture to H.264 for this PC, at up to 1920 pixels wide. That costs the server most of a processor core for as long as it is watched; the "HEVC Video Extensions" from the Microsoft Store let Chrome and Edge play the camera’s own picture instead.'
/**
 * The title of the full-size view's small mark while it stays on the sub-stream because the server
 * did not convert the main one (viewer.js): no room among the few it converts at once, or it failed.
 */
export function mainNotConvertedTitle(why) {
  const what = why === H264_FAILED ? 'the server could not convert its full-quality picture just now' : 'the server is already converting as many full-quality pictures as it is allowed'
  return `This camera sends H.265, which this browser cannot play, and ${what}. This view shows the standard picture meanwhile and tries the full-quality one again by itself.`
}
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
export const TILE_HTML = '<canvas></canvas><canvas class="osd"></canvas><pre class="stats"></pre><span class="status"></span><div class="label"><span class="dot dot-off" title="No video: nothing is arriving from this camera"></span><span class="name"></span></div>'

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

/**
 * Whether a frame the decoder kept past its display time grows the playout buffer (player.js
 * countDecoderHold). On unless this browser was told otherwise: localStorage 'argus.decoderHold' =
 * 'off' puts the player back as it was, for comparing the two on the same screen.
 */
export function decoderHoldCounted(storage) {
  try {
    // (read in here: where storage is blocked, reading the property itself throws)
    return (storage ?? globalThis.localStorage)?.getItem('argus.decoderHold') !== 'off'
  } catch {
    return true
  }
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
   *   onMainNotConverted: the server did not convert this H.265 main stream for a browser that cannot
   *   play it (why: H264_NO_ROOM_MAIN, H264_FAILED); return true when handled (viewer.js, the same
   *   way), else the tile goes over to the sub-stream itself
   */
  constructor(tile, cam, streamType, startDelayMs = 0, opts = {}) {
    this.tile = tile
    this.nvr = cam.nvr
    this.ch = cam.ch
    this.streamType = streamType
    this.opts = opts
    this.status = tile.querySelector('.status')
    this.statsEl = tile.querySelector('.stats')
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
    this.maxFps = opts.maxFps ?? null // a phone asks the server for its 15 fps stream (phone-live.mjs)
    this.h264Asks = 0 // H.265 keyframes in a row answered by asking again for H.264 (#askH264)
    this.converted = false // the server converts this camera to H.264 for this browser (its badge)
    this.convMsg = null // the message shown while the server cannot convert it (#noConversion)
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
      countDecoderHold: decoderHoldCounted(),
      clock: opts.clock,
      maxQueuedFrames: opts.maxQueuedFrames,
      noRewindMs: opts.noRewindMs,
      maxFps: opts.maxFps,
      onUnsupported: (codecId) => {
        // this browser cannot play H.265, whatever the check said: every tile from now on says so.
        // The tile asks again, for H.264 (the server converts it, a main stream as well as a sub);
        // only when H.265 comes all the same does it give up as it used to (a main: over to the
        // sub-stream, or what its caller does)
        if (codecId === CODEC_H265) learnedNoH265 = true
        if (codecId === CODEC_H265 && this.#askH264()) return
        return opts.onUnsupported ? opts.onUnsupported(codecId) : this.onUnsupported(codecId)
      },
      onFrame: () => {
        this.h264Asks = 0
        if (this.convMsg) this.#clearConvMsg()
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
    // (only when it changes: a big grid would otherwise write every badge every second)
    if (this.status.textContent !== text) this.status.textContent = text
    this.status.classList.toggle('live', live)
    const placeholder = this.tile?.querySelector('.tile-placeholder strong')
    if (placeholder && placeholder.textContent !== text) placeholder.textContent = text === 'LIVE' ? 'Live video' : text
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
    activeTrace()?.stats(this, s) // the D overlay's frame trace (frame-trace.js), when one runs
    const ws = this.ws
    const open = (this.source ? true : ws && ws.readyState === 1) && !this.suspended && !this.closed
    const since = open ? this.now() - (this.lastDataAt || this.now()) : 0
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
    } else if (open && since >= STALL_RECONNECT_MS && this.source) {
      // the borrowed stream stopped: a connection of our own
      this.#unborrow()
      this.connect()
    } else if (open && since >= STALL_RECONNECT_MS) {
      // frames stopped on a socket that stays open: drop it (without waiting for its close
      // handshake, which may be stuck behind the backlog) and connect again with the back-off
      this.lastDataAt = 0
      const onclose = ws.onclose
      ws.onclose = null
      ws.onmessage = null
      ws.close()
      onclose?.()
    } else if (open && since >= NO_VIDEO_MS) this.setStatus('no video')
    else if (s.fps > 0 && open) {
      this.setStatus('LIVE', true)
      const fps = `${s.fps} fps`
      if (this.status.title !== fps) this.status.title = fps
    }
    if (!this.closed && !this.suspended && this.ws?.readyState === 0 && !this.lastDataAt && /connecting|Waiting for video|No video received/.test(this.status.textContent)) {
      const seconds = Math.max(0, Math.floor((this.now() - this.connectAt) / 1000))
      this.setStatus(seconds >= 30 ? 'No video received · waiting to connect' : `Waiting for video · ${seconds}s`)
    }
    this.setDot({
      // (a tile shown from its keyframes alone draws nothing in most seconds: it has video all the same, wall-thin.js)
      hasVideo: Boolean(open && this.lastDataAt && (s.fps > 0 || this.player.keysOnly || this.player.afterThin)),
      stale: Boolean(open && since >= NO_VIDEO_MS),
      // the live grid has no per-camera recording flag yet; a caller that knows can supply one
      recording: this.opts.recording?.(this)
    })
    if (this.opts.statsVisible?.()) {
      this.statsEl.textContent = [
        `${s.width}×${s.height} ${s.codec} (${s.hw})`,
        `decoded ${s.coded} · visible ${s.visible} · canvas ${this.player?.canvas?.width ?? '?'}×${this.player?.canvas?.height ?? '?'}`,
        `${s.fps} fps · jitter ${s.jitterMs} ms`,
        `buffer ${s.delayMs} ms · ${s.kbps} kbps`,
        `queue ${s.queuedFrames ?? 0} frames · image estimate ${s.queuedImageMiB ?? 0} MiB · decoding ${s.decodeQueue ?? 0}`,
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
    this.setStatus('connecting…')
    // On the Live page a channel on the page's one shared connection (live-mux.js), which behaves
    // like a socket here; elsewhere a socket of its own to /live, as always
    this.#setConverted(false) // (said again by the server if this connection is converted too)
    this.ws = liveSocket({ nvr: this.nvr, ch: this.ch, stream: this.streamType, fps: this.maxFps, h265: h265Answer({ device: deviceH265, forced: forcedNoH265, learned: learnedNoH265 }) })
    this.ws.binaryType = 'arraybuffer'
    this.lastDataAt = 0
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
      this.attempts = 0
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
      // a main stream the server did not convert (no room among the few it converts, or it failed):
      // nothing is said over the picture, the sub-stream is there to show instead
      if (this.streamType === MAIN_STREAM && (e?.reason === H264_NO_ROOM_MAIN || e?.reason === H264_FAILED)) return this.#mainNotConverted(e.reason)
      // H.265 that this browser cannot play and the server cannot convert just now: said, not black
      if (e?.reason === H264_NO_ROOM || e?.reason === H264_FAILED) return this.#noConversion(e.reason)
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
   *  - {"op":"convert","on":true} this H.265 camera is converted to H.264 for this browser (h264-fallback.mjs)
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
    if (m?.op === 'convert') return this.#setConverted(m.on === true)
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

  /**
   * The server did not convert this H.265 main stream: the caller may handle it (viewer.js: the
   * layer goes, the sub-stream under it stays, and it asks again later); otherwise this tile goes
   * over to the sub-stream at once, which the server converts on a budget with far more room.
   */
  #mainNotConverted(why) {
    if (this.opts.onMainNotConverted?.(why) === true) return
    this.streamType = SUB_STREAM
    this.attempts = 0
    this.connect()
  }

  /**
   * The mark on a tile whose camera the server converts for this browser, beside its name as the SD
   * badge is (viewer.js): small, and its title says what it costs and how to be rid of it.
   */
  #setConverted(on) {
    if (this.converted === on) return
    this.converted = on
    if (typeof document === 'undefined') return
    this.convBadge?.remove()
    this.convBadge = null
    if (!on) return
    const b = document.createElement('span')
    b.className = 'sd-badge conv-badge'
    b.textContent = 'CONV'
    b.title = this.streamType === MAIN_STREAM ? CONVERTED_MAIN_TITLE : CONVERTED_TITLE
    this.tile.querySelector('.label')?.append(b)
    this.convBadge = b
  }

  /**
   * An H.265 keyframe this browser cannot decode: connect again at once, this time saying so
   * (learnedNoH265 is set by now), and the server sends its H.264 conversion instead. At most
   * H264_ASKS times in a row: after that the server is not converting (a main: turned off, an older
   * server, or a viewer through the tunnel on a path of its own), and the tile says why or falls back.
   * @returns {boolean} false: not asked again (the caller shows the message)
   */
  #askH264() {
    if (this.closed || this.h264Asks >= H264_ASKS) return false
    this.h264Asks++
    this.#unborrow() // (another tile's stream of this camera is the same H.265)
    this.gop = null // nothing of it to lend, or to pick up from
    const ws = this.ws
    if (ws) {
      ws.onclose = null
      ws.onmessage = null
      ws.close()
    }
    // (called from inside the player: its reset and the new connection after this turn)
    clearTimeout(this.retry)
    this.retry = setTimeout(() => {
      if (this.closed) return
      this.player.reset()
      this.connect()
    }, 0)
    return true
  }

  /**
   * The server closed the stream because it cannot convert this H.265 camera now (no room in its
   * budget, or the conversion failed). The tile says so, with the same advice as ever, and asks again
   * every H264_RETRY_MS: the first picture that comes takes the message away.
   */
  #noConversion(why) {
    const { status, text } = h265Text(why)
    this.setStatus(status)
    if (typeof document !== 'undefined') {
      if (!this.convMsg) {
        this.convMsg = document.createElement('div')
        this.convMsg.className = 'tile-msg'
        this.tile.append(this.convMsg)
      }
      if (this.convMsg.textContent !== text) this.convMsg.textContent = text
    } else this.convMsg = { textContent: text, remove() {} } // (tests: no page)
    clearTimeout(this.retry)
    this.retry = setTimeout(() => this.#retryConversion(status), H264_RETRY_MS * (0.8 + Math.random() * 0.4))
  }

  #retryConversion(status) {
    if (this.closed) return
    // hidden meanwhile (under the full-size view): resume() connects when it is shown again
    if (this.suspended) return
    this.connect()
    this.setStatus(status) // (not "connecting…": the message is still up, and says what it waits for)
  }

  #clearConvMsg() {
    this.convMsg?.remove?.()
    this.convMsg = null
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
    this.#setConverted(src.converted === true) // (its stream is this one's now)
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
    const src = this.source
    src.taps.delete(this.tap)
    this.source = null
    this.tap = null
    this.opts.onUnborrow?.(src) // (viewer.js: a main stream started ahead goes when nothing shows it)
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
    // Reached for H.265 only when asking the server for H.264 did not help (#askH264: a server that
    // does not convert, or a path it does not convert on). Same correction as playback.js (h265Text's
    // advice): on Windows this is nearly always a missing codec, not a machine that cannot cope.
    // Saying "change it on the NVR" first sends people to reconfigure a camera when installing one
    // extension would have done.
    this.setStatus(codecId === CODEC_H265 ? h265Text().status : 'unsupported codec')
    // the browser can't show this stream: stop pulling it rather than load the NVR for nothing
    this.#clearConvMsg()
    const msg = document.createElement('div')
    msg.className = 'tile-msg'
    msg.textContent = codecId === CODEC_H265 ? h265Text().text : 'This browser cannot play this camera’s video format.'
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
    this.#clearConvMsg()
    this.closed = true
    this.#unborrow()
    this.taps.clear()
    this.gop = null
    clearTimeout(this.retry)
    this.ws?.close()
    this.player.close()
  }
}
