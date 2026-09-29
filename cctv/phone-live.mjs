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
import { replayGop } from './gop-replay.mjs'
import { Transcoder, TranscodePool, CODEC_H264, CODEC_H265 } from './transcode.mjs'

export const PHONE_FPS = 15
export const PHONE_MAX_WIDTH = 1280
/** Picture quality for phones, and a ceiling on the bitrate (kbit/s) so it never costs more data. */
export const PHONE_CRF = 25
export const PHONE_SUB_KBPS = 700
export const PHONE_MAIN_KBPS = 2500
const HEADER_SIZE = 16 // sdk.mjs encodeFrame: key flag, codec, size, time (us); then the payload
const MAX_GOP_FRAMES = 200
const STOP_DELAY_MS = 10_000
/** Frames looked at to learn the stream's frame rate before converting. */
export const RATE_SAMPLES = 12

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

/**
 * The keyframe interval, in pictures out, for a keyframe every `seconds` of the stream going out:
 * srcFps over the frames kept (keepEvery). ffmpeg's -g counts pictures, so the 50 it was given
 * (transcode.mjs GOP_FRAMES) was 3.3 s at 15 fps, 6.3 s at 8 and 12.5 s at 4, and a tile that lost
 * a frame waited that long for its next picture (backpressure.mjs; stutter report 2.7). At least 1
 * (a trickle of one picture every few seconds is all keyframes); 0 when the rate is not known, which
 * leaves the converter's own interval.
 */
export function gopFor(srcFps, keepEvery = 1, seconds = 2) {
  if (!(srcFps > 0) || !(keepEvery >= 1)) return 0
  return Math.max(1, Math.round((seconds * srcFps) / keepEvery))
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
   *   makeTranscoder?: Function, onEmpty?: Function, log?: Function, stopDelayMs?: number, camera?: string,
   *   fps?: number, crf?: number, subKbps?: number, mainKbps?: number, maxWidth?: number,
   *   bufSeconds?: number, lowDelay?: boolean, keySeconds?: number, h264Only?: boolean, learnMs?: number,
   *   slowFps?: number }} o
   *   camera: the camera as the log names it, the NVR and the channel from 1 ("nvr-2/5")
   *   fps: the rate to thin to, 0 for every frame (a remote viewer's level full: H.265 converted for
   *   a browser that cannot play it, nothing thinned); maxWidth: a main stream's, scaled down to it
   *   bufSeconds, lowDelay: the converter's (transcode.mjs ffmpegArgs); not given, its own (4 s, low_delay)
   *   keySeconds: a keyframe every that many seconds of the stream going out (gopFor); 0, not given:
   *   the converter's own 50 pictures
   *   h264Only: everyone on this stream plays H.264 only, so H.265 is converted even with nothing to
   *   thin; not given (a phone, a level shared with browsers that play H.265): a sub-stream with nothing
   *   to thin is sent as it is, whatever its codec
   *   learnMs: the frame rate is decided after RATE_SAMPLES frames or this much of their capture time,
   *   whichever comes first, and until then a sub-stream's H.264 goes out as it comes (a remote
   *   viewer's: see #onSource); 0, not given (a phone): 12 frames, and nothing sent until then
   *   slowFps: a source slower than this is converted picture by picture: low_delay, and each picture
   *   ended as it goes in (a remote viewer's: a camera that trickles); 0, not given: as lowDelay says
   *   fromNextKey: made for sockets a level change moves off a picture (adaptive-live.mjs): converted
   *   from the camera's next keyframe as it comes, not the one held from the replay as it joined (older
   *   than what they have on screen); startTs then says which keyframe that is
   *   srcFps: the source's frame rate, when the caller knows it already: decided on it at the first
   *   frame, nothing learnt (adaptive-live.mjs #handOver makes a stream inside the camera's keyframe's
   *   fan-out, and with fromNextKey it converts from that very keyframe); 0, not given: learnt
   *   onRate: told the frame rate once it is decided (adaptive-live.mjs remembers it)
   */
  constructor({ source, type, slot, makeTranscoder = (o) => new Transcoder(o), onEmpty = () => {}, log = (l) => console.log(l), stopDelayMs = STOP_DELAY_MS, fps = PHONE_FPS, crf = PHONE_CRF, subKbps = PHONE_SUB_KBPS, mainKbps = PHONE_MAIN_KBPS, maxWidth = PHONE_MAX_WIDTH, bufSeconds, lowDelay, keySeconds = 0, h264Only = false, learnMs = 0, slowFps = 0, fromNextKey = false, srcFps = 0, onRate = () => {}, background = false, camera = '?' }) {
    // fps / crf / kbps / maxWidth: the level this stream is thinned to (adaptive-live.mjs picks one per
    // viewer); bufSeconds / lowDelay / keySeconds / learnMs / slowFps / fromNextKey / srcFps: how its
    // conversion runs and starts (a phone on the local network gives none: the converter's own, as always)
    Object.assign(this, { source, type, slot, makeTranscoder, onEmpty, log, stopDelayMs, fps, crf, subKbps, mainKbps, maxWidth, bufSeconds, lowDelay, keySeconds, h264Only, learnMs, slowFps, fromNextKey, srcFps, onRate })
    // Every line names its camera. On 29 Sep they named none, and the 15-24 conversions a remote
    // viewer's level change started at once could only be matched to cameras by their timing
    // (stutter report 2.10).
    this.who = `[phone-live] ${camera}${background ? ' (stand-in)' : ''}:`
    this.clients = new Set()
    this.gop = []
    this.samples = []
    this.held = null // frames since the last keyframe, while the frame rate is being learned
    this.heldLive = false // ... that keyframe came as the camera sent it, not in the replay as it joined
    this.ownTs = null // capture time of the last of the camera's own frames it sent on as they came (learnMs)
    this.awaitKey = false // converting from the camera's next keyframe (fromNextKey)
    // capture time of the keyframe its first picture out is (or will be, once converted): a socket a
    // level change moves here switches at it (adaptive-live.mjs)
    this.startTs = null
    this.xcode = null
    this.eachPicture = false // each picture ended as it goes in (slowFps)
    this.passthrough = false
    this.closed = false
    this.stopTimer = null
    // what the normal stream sees: one more viewer, which never falls behind
    // (background: only a stand-in, live-attach.mjs: the NVR worker joins a main that plays for it, never starts one)
    this.tap = { OPEN: 1, readyState: 1, bufferedAmount: 0, background, send: (buf) => this.#onSource(buf) }
    // (what the normal stream replays as the tap joins is learnt from, never sent on as it comes: #onSource)
    this.joining = true
    source.add(this.tap)
    this.joining = false
  }

  add(ws) {
    clearTimeout(this.stopTimer)
    this.stopTimer = null
    this.clients.add(ws)
    if (this.gop.length > 0) replayGop(this.gop, ws)
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
    if (this.passthrough) {
      if (f.isKey && !this.joining) this.startTs ??= f.ts
      return this.#fanOut(buf, f.isKey)
    }
    if (!this.xcode) {
      // Learn the frame rate from the frames at hand, keeping them from the last keyframe on: the
      // normal stream replays its current GOP to a new viewer, so this is usually over at once and
      // the conversion starts from that keyframe instead of waiting seconds for the next one.
      if (f.isKey) {
        this.held = []
        this.heldLive = !this.joining
      }
      if (this.held) this.held.push(f)
      // A remote viewer's stream (learnMs) decides after a second of capture time when that comes
      // before 12 frames: a camera trickling at 0.8 fps was 15 s learning its 12, and nothing went out
      // meanwhile. On 29 Sep a step down left two trickling tiles with nothing new for 14 s (04:08:08.8
      // -> 04:08:22.9), and a full-size main showed nothing from its conversion for 13 s (04:03:55.9 ->
      // 04:04:09.2) (stutter report 2.9). At 12 fps and up the 12 frames still come first.
      // (a rate given, srcFps: nothing to learn)
      const known = this.srcFps > 0
      const timed = this.learnMs > 0 && this.samples.length > 0 && f.ts - this.samples[0] >= this.learnMs
      if (!known && this.samples.length < RATE_SAMPLES && !timed) {
        this.samples.push(f.ts)
        // ...and meanwhile a sub-stream's H.264 goes out as it comes, as the camera's own stream would:
        // one at or under the level's rate (every trickle) is sent as it is once decided anyway. Not a
        // main, which a level always scales down (nvr-2/10's keyframe alone was 634 KB on 29 Sep: what
        // the level is there to spare the link), nor H.265, which the browser may not play. Nor what
        // the normal stream replays as this stream joins: a socket moved here by a level change was
        // shown it already, and a step down moved 11 pass-through tiles at once (04:18:05) on a link
        // that was backed up -- sent again, that is up to a sub-stream's GOP (99-195 KB) per tile.
        if (this.learnMs > 0 && !this.joining && this.type !== 0 && f.codec === CODEC_H264) this.#own(buf, f)
        return
      }
      // the 12 frames; or those of the first second, with this one that ends it
      const fps = known ? this.srcFps : frameRate(this.samples.length < RATE_SAMPLES ? [...this.samples, f.ts] : this.samples)
      this.onRate(fps)
      const keepEvery = this.fps > 0 ? keepEveryFor(fps, this.fps) : 1
      if (keepEvery === 1 && this.type !== 0 && !(this.h264Only && f.codec === CODEC_H265)) {
        this.held = null
        // already 15 fps or less and small: converting would only cost CPU and picture
        this.passthrough = true
        this.slot.release() // costs nothing: the slot is for streams that cost a core
        this.log(`${this.who} a sub stream at ${fps.toFixed(1)} fps: sent as it is`)
        if (f.isKey && !this.joining) this.startTs ??= f.ts
        return this.#fanOut(buf, f.isKey)
      }
      // the camera's own frames sent while learning are not for anyone joining from now on: a socket
      // that joins waits for the conversion's first keyframe, as it always did
      this.gop = []
      // A slow source is converted picture by picture. ffmpeg's parser holds a picture until the next
      // one begins, and the second decoder thread (lowDelay false) one more: measured through the real
      // ffmpeg on the server (29 Sep), an H.265 main at 0.8 fps came out 2.7 s after each frame, its
      // first picture 3.9 s after its first keyframe. With low_delay and an end to each picture as it
      // goes in (Transcoder.endPicture): 0.2 s, and 1.5 s. One decoder thread is plenty at that rate:
      // it converts 4K H.265 at 24 pictures a second here (transcode.mjs DECODE_THREADS).
      this.eachPicture = this.slowFps > 0 && fps > 0 && fps < this.slowFps
      this.xcode = this.makeTranscoder({
        inCodec: f.codec === CODEC_H265 ? CODEC_H265 : CODEC_H264,
        keepEvery,
        maxWidth: this.type === 0 ? this.maxWidth : 0,
        // a phone's small screen: lighter than the original, not heavier (crf 26 came out bigger)
        crf: this.crf,
        maxKbps: this.type === 0 ? this.mainKbps : this.subKbps,
        bufSeconds: this.bufSeconds,
        lowDelay: this.eachPicture || this.lowDelay,
        gop: this.keySeconds > 0 ? gopFor(fps, keepEvery, this.keySeconds) : 0,
        onFrame: (ts, isKey, out) => this.#onConverted(ts, isKey, out),
        onFail: (e) => this.log(`${this.who} conversion failed: ${e.message}`),
        // its own lines ("[transcode] conversion ended after N frames", the hardware encoder given
        // up) name the camera as well: a level change ends 15-24 conversions at once
        log: (line) => this.log(`${this.who} ${line}`)
      })
      const what = this.fps > 0 ? `to about ${this.fps}: keeping 1 in ${keepEvery}` : 'to H.264, every frame kept'
      this.log(`${this.who} converting a ${this.type === 0 ? 'main' : 'sub'} stream at ${fps.toFixed(1)} fps ${what}${this.eachPicture ? ', each picture out as it comes' : ''}`)
      const held = this.held ?? []
      this.held = null
      // Made for sockets a level change moves off a picture (fromNextKey): the keyframe held from the
      // replay as it joined is older than what they have on screen, by up to a keyframe interval, and so
      // is one it has already sent on as it came while learning. Converted from there, their picture
      // stepped back (1.4 s in the stutter investigation's replay) and ffmpeg first caught up through
      // seconds they had seen: at a step down, 14-20 such catch-ups at once (29 Sep 04:08:08; stutter
      // report 2.5, verify-5). From the camera's next keyframe instead, its converter already running.
      if (this.fromNextKey && (!this.heldLive || (this.ownTs !== null && held[0] && held[0].ts <= this.ownTs))) {
        this.awaitKey = true
        return this.#awaiting(buf, f)
      }
      if (held[0]?.isKey) this.startTs ??= held[0].ts
      for (const h of held) this.#push(h)
      if (held.at(-1) === f) return
    }
    if (this.awaitKey) {
      if (!f.isKey || this.joining) return this.#awaiting(buf, f)
      this.awaitKey = false
      this.startTs ??= f.ts
    }
    this.#push(f)
  }

  /**
   * A frame before the camera's next keyframe, the conversion waiting for it (fromNextKey): not
   * converted. The camera's own frames it was sending on as they came while it learnt go on up to it,
   * so its sockets keep a moving picture until the converted one takes over.
   */
  #awaiting(buf, f) {
    if (this.ownTs !== null && !this.joining) this.#own(buf, f)
  }

  /** One of the camera's own frames sent on as it came (learnMs; see #onSource). */
  #own(buf, f) {
    if (f.isKey) this.startTs ??= f.ts
    this.ownTs = f.ts
    this.#fanOut(buf, f.isKey)
  }

  #push(f) {
    this.xcode.push(f.ts, f.isKey, f.payload)
    if (this.eachPicture) this.xcode.endPicture?.()
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
   * caller then attaches it to the normal stream). camera: the camera as the log names it ("nvr-2/5").
   */
  attach(key, source, type, ws, { background = false, camera } = {}) {
    let s = this.streams.get(key)
    if (!s || s.closed) {
      const slot = this.pool.acquire()
      if (!slot) return false
      s = new PhoneStream({ source, type, slot, background, camera, makeTranscoder: this.makeTranscoder, log: this.log, onEmpty: () => this.streams.get(key) === s && this.streams.delete(key) })
      this.streams.set(key, s)
    }
    s.add(ws)
    ws.on?.('close', () => s.remove(ws))
    return true
  }

  /** Takes a socket off a thinned stream before it closes (sub-bridge.mjs: a stand-in that has ended). */
  detach(key, ws) {
    this.streams.get(key)?.remove(ws)
  }

  /** Whether a thinned stream runs under this key (joining it costs no conversion). */
  has(key) {
    const s = this.streams.get(key)
    return Boolean(s) && !s.closed
  }

  /** How many more conversions may start (the cap, less those running). */
  room() {
    return this.pool.max - this.pool.active
  }
}
