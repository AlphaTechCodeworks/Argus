// One live camera in a tile: streams it over WebSocket into a VideoPlayer, with reconnects.
// Used by the live grid (viewer.js) and the map's live popup (map.js).
import { clearStill, maybeKeepStill, showStill } from './stills.js'
import { CODEC_H265, VideoPlayer, canDecodeH265 } from './player.js'

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
// stall watchdog: an open socket that delivers no frames this long shows 'no video' (about 2-3
// GOPs), and this long is closed and opened again (the server may have dropped a frozen stream)
export const NO_VIDEO_MS = 5000
export const STALL_RECONNECT_MS = 18_000

/** The markup a LiveTile expects inside its tile element. */
// The .osd canvas sits over the video canvas and is drawn by this app (osd-overlay.js), never by
// the camera. It is a second canvas rather than drawing onto the player's own, because the player
// redraws that one on every frame and would wipe the text, and because the overlay must be able to
// come and go without the streaming path knowing anything about it.
export const TILE_HTML = '<canvas></canvas><canvas class="osd"></canvas><pre class="stats"></pre><div class="label"><span class="dot dot-off" title="No video: nothing is arriving from this camera"></span><span class="name"></span><span class="status"></span></div>'

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
   * @param {{ pacing?: boolean, clock?: object, statsVisible?: () => boolean, onDisconnect?: () => void,
   *   onFirstFrame?: () => void, onUnsupported?: (codecId: number) => void }} [opts]
   *   clock: PlayoutClock options (the "Smooth" setting); onFirstFrame: the first frame is on screen;
   *   recording: tells the dot whether the server is also recording this camera (red rather than
   *   green); leave it out where that is not known. onUnsupported: replaces the built-in handling (main -> sub fallback, message) when the
   *   browser can't play the stream
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
    this.suspended = false // connected, but frames are dropped (not decoded): see suspend()
    this.attempts = 0 // reconnects since video last arrived
    this.now = opts.now ?? (() => Date.now()) // (tests)
    this.lastDataAt = 0 // the last frame on this socket, or when it opened
    this.maxFps = opts.maxFps ?? null // a phone asks the server for its 15 fps stream (phone-live.mjs)
    let shown = false
    this.player = new VideoPlayer(tile.querySelector('canvas'), {
      pacing: opts.pacing ?? true,
      clock: opts.clock,
      maxFps: opts.maxFps,
      onUnsupported: (codecId) => (opts.onUnsupported ? opts.onUnsupported(codecId) : this.onUnsupported(codecId)),
      onFrame: () => {
        if (!shown) clearStill(tile)
        // keep the last picture of this camera on this device, for the next time its tile appears
        if (typeof document !== 'undefined') maybeKeepStill(this.player.canvas, this.nvr, this.ch)
        // a picture on screen is live, whatever the badge said a moment ago ("connecting…" stayed
        // up until a whole second of frames had been counted, over a picture already moving)
        if (/connecting|no video/.test(this.status.textContent)) this.setStatus('live', true)
        if (shown) return
        shown = true
        opts.onFirstFrame?.()
      }
    })
    this.setStatus('connecting…')
    // the last picture seen of this camera, at once, until its live picture arrives (stills.js)
    if (typeof document !== 'undefined' && !opts.noStill) showStill(tile, this.nvr, this.ch)
    this.retry = setTimeout(() => this.connect(), startDelayMs)
    this.statusTimer = setInterval(() => this.updateStatus(), 1000)
  }

  setStatus(text, live = false) {
    // (only when it changes: a big grid would otherwise write every badge every second)
    if (this.status.textContent !== text) this.status.textContent = text
    this.status.classList.toggle('live', live)
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
    const s = this.player.stats
    const ws = this.ws
    const open = ws && ws.readyState === 1 && !this.suspended && !this.closed
    const since = open ? this.now() - (this.lastDataAt || this.now()) : 0
    if (open && since >= STALL_RECONNECT_MS) {
      // frames stopped on a socket that stays open: drop it (without waiting for its close
      // handshake, which may be stuck behind the backlog) and connect again with the back-off
      this.lastDataAt = 0
      const onclose = ws.onclose
      ws.onclose = null
      ws.onmessage = null
      ws.close()
      onclose?.()
    } else if (open && since >= NO_VIDEO_MS) this.setStatus('no video')
    else if (s.fps > 0 && open) this.setStatus(`${s.fps} fps`, true)
    this.setDot({
      hasVideo: Boolean(open && this.lastDataAt && s.fps > 0),
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
        `dropped ${s.dropped} · late ${s.late} · resync ${s.resyncs}`
      ].join('\n')
    }
    // Once a second, which is exactly the resolution of the clock being shown.
    this.drawOverlay()
  }

  connect() {
    this.setStatus('connecting…')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new WebSocket(`${proto}://${location.host}/live?nvr=${encodeURIComponent(this.nvr)}&ch=${this.ch}&stream=${this.streamType}${this.maxFps === 15 ? '&fps=15' : ''}${deviceH265 === null ? '' : `&h265=${deviceH265 ? 1 : 0}`}`)
    this.ws.binaryType = 'arraybuffer'
    this.lastDataAt = 0
    this.ws.onopen = () => (this.lastDataAt = this.now())
    this.ws.onmessage = (e) => {
      this.attempts = 0
      this.lastDataAt = this.now()
      this.onMessage(new Uint8Array(e.data))
    }
    this.ws.onclose = () => {
      this.player.reset()
      if (!this.closed) {
        this.opts.onDisconnect?.()
        this.setStatus('reconnecting…')
        // back off (2, 4, 8 … 30 s) with jitter, so many tiles don't reconnect in lockstep
        const delay = Math.min(30_000, 2000 * 2 ** this.attempts) * (0.7 + Math.random() * 0.6)
        this.attempts++
        this.retry = setTimeout(() => this.connect(), delay)
      }
    }
  }

  onMessage(buf) {
    if (this.suspended || buf.length <= HEADER_SIZE) return
    const view = new DataView(buf.buffer, buf.byteOffset)
    this.player.push({
      isKey: (buf[0] & 1) === 1,
      codecId: buf[1],
      timestampUs: Number(view.getBigInt64(8, true)),
      data: buf.subarray(HEADER_SIZE)
    })
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
    this.closed = true
    clearTimeout(this.retry)
    this.ws?.close()
  }

  /** Keeps the connection and the last picture, but decodes nothing (hidden under a full-size view). */
  suspend() {
    this.suspended = true
  }

  /**
   * Picks up again at once: reconnects, and the server starts the new connection with the
   * stream's latest keyframe, so the picture moves again without waiting for the next one.
   */
  resume() {
    if (!this.suspended || this.closed) return
    this.suspended = false
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

  close() {
    this.closed = true
    clearTimeout(this.retry)
    clearInterval(this.statusTimer)
    this.ws?.close()
    this.player.close()
  }
}
