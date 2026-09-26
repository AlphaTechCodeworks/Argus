// Live video for phones at 15 frames a second, converted on the server so a phone also downloads
// and decodes less, not just draws less (public/device.js holds drawing to 15 fps on its own).
//
// One conversion per camera stream, shared by every phone watching it: it joins the normal stream
// as one more viewer, keeps one frame in every N (N from the stream's own frame rate), scales the
// main stream down to at most 1280 wide, and fans the result out like stream-hub.mjs does. Its own
// cap (CCTV_PHONE_LIVE_MAX, 16 by default) is separate from playback's; when it is reached, a phone
// is simply given the normal stream. Never refused: a phone that gets a bigger stream is better
// than a phone that gets nothing. ffmpeg runs at low priority (transcode.mjs), so recording wins.
//
// A phone asks with &fps=15 on its /live socket; the server grants it only to a browser that says
// it is a phone (isPhoneRequest), so a PC can never end up on the thinned stream by accident.
import { CAP_BYTES, gateSend } from './backpressure.mjs'
import { Transcoder, TranscodePool, CODEC_H264, CODEC_H265 } from './transcode.mjs'

export const PHONE_FPS = 15
export const PHONE_MAX_WIDTH = 1280
/** Picture quality for phones, and a ceiling on the bitrate (kbit/s) so it never costs more data. */
export const PHONE_CRF = 30
export const PHONE_SUB_KBPS = 300
export const PHONE_MAIN_KBPS = 1200
const HEADER_SIZE = 16 // sdk.mjs encodeFrame: key flag, codec, size, time (us); then the payload
const MAX_GOP_FRAMES = 200
const STOP_DELAY_MS = 10_000
/** Frames looked at to learn the stream's frame rate before converting. */
const RATE_SAMPLES = 12

/** The cap, from the environment; a bad or missing value means 16. */
export function maxPhoneStreams(env = process.env) {
  const n = Number(env.CCTV_PHONE_LIVE_MAX)
  return Number.isInteger(n) && n >= 0 && n <= 64 ? n : 16
}

/** Whether the browser on this request says it is a phone (same rule as public/device.js). */
export function isPhoneRequest(headers = {}) {
  const ch = headers['sec-ch-ua-mobile']
  if (ch === '?1') return true
  if (ch === '?0') return false
  return /iPhone|iPod|Android.*Mobile|Mobile.*Firefox|Windows Phone/i.test(String(headers['user-agent'] ?? ''))
}

/** One frame in every how many, to bring srcFps down to about PHONE_FPS. */
export function keepEveryFor(srcFps, target = PHONE_FPS) {
  if (!(srcFps > 0)) return 1
  return Math.max(1, Math.round(srcFps / target))
}

/** The stream's frame rate from capture times (ms), or 0 when there is not enough to say. */
export function frameRate(times) {
  if (times.length < 2) return 0
  const span = times[times.length - 1] - times[0]
  return span > 0 ? ((times.length - 1) * 1000) / span : 0
}

export function parseFrame(buf) {
  return { isKey: buf[0] === 1, codec: buf[1], ts: Number(buf.readBigInt64LE(8)) / 1000, payload: buf.subarray(HEADER_SIZE) }
}

export function encodeFrame(payload, isKey, codec, tsMs) {
  const msg = Buffer.allocUnsafe(HEADER_SIZE + payload.length)
  msg.writeUInt8(isKey ? 1 : 0, 0)
  msg.writeUInt8(codec, 1)
  msg.writeUInt16LE(0, 2)
  msg.writeUInt16LE(0, 4)
  msg.writeUInt16LE(0, 6)
  msg.writeBigInt64LE(BigInt(Math.round(tsMs * 1000)), 8)
  payload.copy(msg, HEADER_SIZE)
  return msg
}

/** One camera stream, thinned for phones. */
export class PhoneStream {
  /**
   * @param {{ source: { add: Function, remove: Function }, type: number, slot: { release: Function },
   *   makeTranscoder?: Function, onEmpty?: Function, log?: Function, stopDelayMs?: number }} o
   */
  constructor({ source, type, slot, makeTranscoder = (o) => new Transcoder(o), onEmpty = () => {}, log = (l) => console.log(l), stopDelayMs = STOP_DELAY_MS }) {
    Object.assign(this, { source, type, slot, makeTranscoder, onEmpty, log, stopDelayMs })
    this.clients = new Set()
    this.gop = []
    this.samples = []
    this.held = null // frames since the last keyframe, while the frame rate is being learned
    this.xcode = null
    this.passthrough = false
    this.closed = false
    this.stopTimer = null
    // what the normal stream sees: one more viewer, which never falls behind
    this.tap = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (buf) => this.#onSource(buf) }
    source.add(this.tap)
  }

  add(ws) {
    clearTimeout(this.stopTimer)
    this.stopTimer = null
    this.clients.add(ws)
    if (this.gop.length > 0) for (const m of this.gop) ws.send(m)
    else ws.waitForKey = true
  }

  remove(ws) {
    this.clients.delete(ws)
    if (this.clients.size > 0 || this.closed) return
    clearTimeout(this.stopTimer)
    this.stopTimer = setTimeout(() => {
      if (this.clients.size === 0) this.close()
    }, this.stopDelayMs)
    this.stopTimer.unref?.()
  }

  #onSource(buf) {
    if (this.closed || !(buf instanceof Uint8Array) || buf.length <= HEADER_SIZE) return
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.length)
    const f = parseFrame(buf)
    if (this.passthrough) return this.#fanOut(buf, f.isKey)
    if (!this.xcode) {
      // Learn the frame rate from the frames at hand, keeping them from the last keyframe on: the
      // normal stream replays its current GOP to a new viewer, so this is usually over at once and
      // the conversion starts from that keyframe instead of waiting seconds for the next one.
      if (f.isKey) this.held = []
      if (this.held) this.held.push(f)
      if (this.samples.length < RATE_SAMPLES) {
        this.samples.push(f.ts)
        return
      }
      const fps = frameRate(this.samples)
      const keepEvery = keepEveryFor(fps)
      if (keepEvery === 1 && this.type !== 0) {
        this.held = null
        // already 15 fps or less and small: converting would only cost CPU and picture
        this.passthrough = true
        this.slot.release() // costs nothing: the slot is for streams that cost a core
        this.log(`[phone-live] a sub stream at ${fps.toFixed(1)} fps: sent as it is`)
        return this.#fanOut(buf, f.isKey)
      }
      this.xcode = this.makeTranscoder({
        inCodec: f.codec === CODEC_H265 ? CODEC_H265 : CODEC_H264,
        keepEvery,
        maxWidth: this.type === 0 ? PHONE_MAX_WIDTH : 0,
        // a phone's small screen: lighter than the original, not heavier (crf 26 came out bigger)
        crf: PHONE_CRF,
        maxKbps: this.type === 0 ? PHONE_MAIN_KBPS : PHONE_SUB_KBPS,
        onFrame: (ts, isKey, out) => this.#onConverted(ts, isKey, out),
        onFail: (e) => this.log(`[phone-live] conversion failed: ${e.message}`),
        log: this.log
      })
      this.log(`[phone-live] converting a ${this.type === 0 ? 'main' : 'sub'} stream at ${fps.toFixed(1)} fps: keeping 1 in ${keepEvery}`)
      const held = this.held ?? []
      this.held = null
      for (const h of held) this.xcode.push(h.ts, h.isKey, h.payload)
      if (held.at(-1) === f) return
    }
    this.xcode.push(f.ts, f.isKey, f.payload)
  }

  #onConverted(ts, isKey, out) {
    this.#fanOut(encodeFrame(out, isKey, CODEC_H264, ts), isKey)
  }

  #fanOut(msg, isKey) {
    if (isKey) this.gop = [msg]
    else if (this.gop.length >= MAX_GOP_FRAMES) this.gop = []
    else if (this.gop.length > 0) this.gop.push(msg)
    const cap = CAP_BYTES[this.type] ?? CAP_BYTES[0]
    const now = Date.now()
    for (const ws of this.clients) if (gateSend(ws, isKey, { cap, now })) ws.send(msg)
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.stopTimer)
    this.source.remove(this.tap)
    this.xcode?.close()
    this.xcode = null
    this.slot.release()
    for (const ws of [...this.clients]) ws.close?.(1011, 'stream ended')
    this.clients.clear()
    this.onEmpty()
  }
}

/** Every phone stream on the server, by NVR, channel and stream type. */
export class PhoneLive {
  constructor({ pool = new TranscodePool(maxPhoneStreams()), makeTranscoder, log } = {}) {
    Object.assign(this, { pool, makeTranscoder, log })
    this.streams = new Map()
  }

  /**
   * Attaches a phone's socket to the thinned stream, or returns false when the cap is reached (the
   * caller then attaches it to the normal stream).
   */
  attach(key, source, type, ws) {
    let s = this.streams.get(key)
    if (!s || s.closed) {
      const slot = this.pool.acquire()
      if (!slot) return false
      s = new PhoneStream({ source, type, slot, makeTranscoder: this.makeTranscoder, log: this.log, onEmpty: () => this.streams.get(key) === s && this.streams.delete(key) })
      this.streams.set(key, s)
    }
    s.add(ws)
    ws.on?.('close', () => s.remove(ws))
    return true
  }
}
