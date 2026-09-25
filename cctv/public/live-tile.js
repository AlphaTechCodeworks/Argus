// One live camera in a tile: streams it over WebSocket into a VideoPlayer, with reconnects.
// Used by the live grid (viewer.js) and the map's live popup (map.js).
import { CODEC_H265, VideoPlayer } from './player.js'

const HEADER_SIZE = 16
export const SUB_STREAM = 1
export const MAIN_STREAM = 0
// stall watchdog: an open socket that delivers no frames this long shows 'no video' (about 2-3
// GOPs), and this long is closed and opened again (the server may have dropped a frozen stream)
export const NO_VIDEO_MS = 5000
export const STALL_RECONNECT_MS = 18_000

/** The markup a LiveTile expects inside its tile element. */
export const TILE_HTML = '<canvas></canvas><pre class="stats"></pre><div class="label"><span class="name"></span><span class="status"></span></div>'

export class LiveTile {
  /**
   * @param {HTMLElement} tile element with TILE_HTML inside
   * @param {{ nvr: string, ch: number }} cam
   * @param {number} streamType
   * @param {number} startDelayMs tiles open slightly staggered so a big grid doesn't hit the NVR all at once
   * @param {{ pacing?: boolean, clock?: object, statsVisible?: () => boolean, onDisconnect?: () => void,
   *   onFirstFrame?: () => void, onUnsupported?: (codecId: number) => void }} [opts]
   *   clock: PlayoutClock options (the "Smooth" setting); onFirstFrame: the first frame is on screen;
   *   onUnsupported: replaces the built-in handling (main -> sub fallback, message) when the
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
    this.closed = false
    this.suspended = false // connected, but frames are dropped (not decoded): see suspend()
    this.attempts = 0 // reconnects since video last arrived
    this.now = opts.now ?? (() => Date.now()) // (tests)
    this.lastDataAt = 0 // the last frame on this socket, or when it opened
    let shown = false
    this.player = new VideoPlayer(tile.querySelector('canvas'), {
      pacing: opts.pacing ?? true,
      clock: opts.clock,
      onUnsupported: (codecId) => (opts.onUnsupported ? opts.onUnsupported(codecId) : this.onUnsupported(codecId)),
      onFrame: () => {
        if (shown) return
        shown = true
        opts.onFirstFrame?.()
      }
    })
    this.setStatus('connecting…')
    this.retry = setTimeout(() => this.connect(), startDelayMs)
    this.statusTimer = setInterval(() => this.updateStatus(), 1000)
  }

  setStatus(text, live = false) {
    // (only when it changes: a big grid would otherwise write every badge every second)
    if (this.status.textContent !== text) this.status.textContent = text
    this.status.classList.toggle('live', live)
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
    if (this.opts.statsVisible?.()) {
      this.statsEl.textContent = [
        `${s.width}×${s.height} ${s.codec} (${s.hw})`,
        `decoded ${s.coded} · visible ${s.visible} · canvas ${this.player?.canvas?.width ?? '?'}×${this.player?.canvas?.height ?? '?'}`,
        `${s.fps} fps · jitter ${s.jitterMs} ms`,
        `buffer ${s.delayMs} ms · ${s.kbps} kbps`,
        `dropped ${s.dropped} · late ${s.late} · resync ${s.resyncs}`
      ].join('\n')
    }
  }

  connect() {
    this.setStatus('connecting…')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new WebSocket(`${proto}://${location.host}/live?nvr=${encodeURIComponent(this.nvr)}&ch=${this.ch}&stream=${this.streamType}`)
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
        ? 'This camera sends H.265, which this browser cannot play. Set the camera’s sub-stream to H.264 on the NVR.'
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
