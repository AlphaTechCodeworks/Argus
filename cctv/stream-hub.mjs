// Parent side of the live worker (CCTV_LIVE_WORKER=on): one HubStream per camera stream, fanned
// out to every viewer. The worker sends each stream once; everything per viewer (GOP replay, slow
// sockets) happens here, with the same rules as live.mjs LiveStream.
import { CAP_BYTES, gateSend } from './backpressure.mjs'
import { replayGop } from './gop-replay.mjs'
import { MSG, restart, streamKey, want, unwant } from './worker-ipc.mjs'

const MAX_GOP_FRAMES = 400 // frames kept since the last keyframe, so new viewers start instantly
// slow sockets: nothing is sent over the cap (1 MB sub, 4 MB main), see backpressure.mjs
// keep a stream wanted a while after the last viewer leaves (grid <-> full screen switching)
// A sub-stream (what every grid shows) is kept running for a while after its last viewer leaves, so
// coming back to Live, paging, or closing a full-size view shows the picture at once instead of
// waiting for the NVR to start the stream again (CCTV_SUB_LINGER_S, 180 by default). Sub-streams
// are small; the main stream, the heavy one, still stops after 10 s.
const SUB_LINGER_MS = (() => { const n = Number(process.env.CCTV_SUB_LINGER_S); return (Number.isFinite(n) && n >= 0 ? n : 180) * 1000 })()
const STOP_DELAY_MS = { 0: 10_000, 1: SUB_LINGER_MS }

export class HubStream {
  constructor(hub, ch, type) {
    this.hub = hub
    this.ch = ch
    this.type = type
    this.streamType = type // (same field name as LiveStream)
    this.key = streamKey(ch, type)
    this.clients = new Set()
    this.gop = []
    this.stopTimer = null
    this.wanted = false
    this.fg = false // a real viewer (not only a warm-up) has asked for it: told to the worker
  }

  add(ws) {
    clearTimeout(this.stopTimer)
    this.stopTimer = null
    this.clients.add(ws)
    const bg = ws.background === true
    if (!this.wanted) {
      this.wanted = true
      this.fg = !bg
      this.hub.send(want(this.ch, this.type, bg))
    } else if (!bg && !this.fg) {
      this.fg = true
      this.hub.send(want(this.ch, this.type, false))
    }
    // replay the current GOP so the picture appears without waiting for the next keyframe
    if (this.gop.length > 0) replayGop(this.gop, ws)
    else ws.waitForKey = true
  }

  remove(ws) {
    this.clients.delete(ws)
    if (this.clients.size > 0 || this.closed) return
    clearTimeout(this.stopTimer)
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null
      if (this.clients.size > 0) return
      this.wanted = false
      this.fg = false
      this.gop = []
      this.hub.send(unwant(this.ch, this.type))
      if (this.hub.streams.get(this.key) === this) this.hub.streams.delete(this.key)
    }, this.hub.stopDelayMs[this.type] ?? 10_000)
  }

  onFrame(buf, isKey) {
    if (isKey) this.gop = [buf]
    else if (this.gop.length >= MAX_GOP_FRAMES) this.gop = [] // too long to replay intact
    else if (this.gop.length > 0) this.gop.push(buf)
    const cap = CAP_BYTES[this.type] ?? CAP_BYTES[0]
    const now = Date.now()
    for (const ws of this.clients) if (gateSend(ws, isKey, { cap, now })) ws.send(buf)
  }

  /** The worker restarted: old reference frames are useless to decoders. */
  reset() {
    this.gop = []
    for (const ws of this.clients) ws.waitForKey = true
  }

  /** Viewers are dropped (their browsers reconnect); used when the NVR is removed. */
  close() {
    this.closed = true // the sockets' close handlers call remove(): no linger timer after this
    clearTimeout(this.stopTimer)
    this.stopTimer = null
    for (const ws of [...this.clients]) ws.close?.(1011, 'NVR removed')
    this.clients.clear()
  }
}

export class StreamHub {
  constructor(nvrId, send, { stopDelayMs = STOP_DELAY_MS } = {}) {
    this.nvrId = nvrId
    this.send = send
    this.stopDelayMs = stopDelayMs
    this.streams = new Map()
  }

  getStream(ch, type) {
    const key = streamKey(ch, type)
    let s = this.streams.get(key)
    if (!s) this.streams.set(key, (s = new HubStream(this, ch, type)))
    return s
  }

  onMessage(msg) {
    if (msg?.t !== MSG.FRAME) return
    this.streams.get(msg.key)?.onFrame(msg.buf, msg.isKey)
  }

  /** After a worker restart: reset every stream and ask again for the ones still watched. */
  onWorkerRestart() {
    for (const s of this.streams.values()) {
      s.reset()
      if (s.wanted) this.send(want(s.ch, s.type, !s.fg))
    }
  }

  /** Asks the worker to restart one stream in place (viewers stay; they wait for the next keyframe). */
  restartStream(ch, type, why) {
    this.send(restart(ch, type, why))
  }

  closeAll() {
    for (const s of this.streams.values()) s.close()
    this.streams.clear()
  }
}
