// Live video for a PC on the local network whose browser cannot play H.265: the camera's H.265
// sub-stream converted to H.264 on the server, so the tile shows a picture instead of "H.265 — set
// sub-stream to H.264". Old office PCs have no H.265 decoder, and Chrome and Edge on Windows have none
// either without the "HEVC Video Extensions"; nobody watching a wall of cameras should have to care.
//
// One conversion per camera sub-stream, shared by every such viewer of it: the same shared stream a
// phone gets (phone-live.mjs PhoneStream: one more viewer of the camera's stream, its GOP replayed to
// whoever joins late, stopped a little after its last viewer leaves), with nothing thinned and
// nothing scaled. A viewer whose browser plays H.265 is never here: it stays on the camera's own
// stream, byte for byte (live-attach.mjs decides, and only for a page that said h265=0 itself). An
// H.264 camera is never converted: one that turns out to send H.264 after all is sent as it is, and
// gives its place back (PhoneStream h264Only).
//
// Main streams are left out, on purpose. A main is 5-8 MP: converting one, scaled to 1920 wide, kept
// ahead of a 20 fps 4K camera by only 1.16-1.26x on this server with one decoder thread (transcode.mjs
// PLAYBACK_LIMITS), most of a core each, where a sub-stream costs 7-16 % of one. Two full-size views
// would take the whole budget from every grid tile. The full-size view of such a PC stays on its
// (converted) sub-stream, as it stayed on the sub-stream before.
//
// What it may cost is a budget, and it is this feature's own: phones and remote viewers share a pool
// (phone-live.mjs CCTV_PHONE_LIVE_MAX) that these conversions never draw on, so neither starves the
// other. The budget is CPU, in units of 1 % of one core (CCTV_H264_FALLBACK_CORES, 2 cores by
// default), with a plain count on top (CCTV_H264_FALLBACK_MAX, 24). Inside it the encoder follows a
// ladder: few conversions running, the better preset; more, a faster one, so the total stays inside
// the budget (LADDER, stepFor). Past the last step a viewer is refused, and its tile says the server
// has no room to convert another camera right now (live-tile.js); it asks again by itself.
import { ended, PhoneStream } from './phone-live.mjs'
import { Transcoder, TranscodePool } from './transcode.mjs'

/**
 * The encoder's settings by how many conversions run, best first. cost: what one conversion takes,
 * in units of 1 % of one core, decode included. Measured on the production server (8 vCPU Xeon Gold
 * 5317, no GPU, load about 4), one thread, 704x480 at 15 fps, H.265 in, noisy synthetic content (a
 * real camera's still scene is cheaper): decoding alone 2.9; ultrafast crf 23 6.6; superfast crf 23
 * 11.8; veryfast crf 22 15.1; faster crf 22 20.7; medium crf 22 41.6. Each cost here is the measured
 * one and a little more, for the lower crf. faster and medium are not on it: a third and nearly three
 * times veryfast's cost for a difference nobody sees on a 480p tile.
 *
 * crf 21 on a 704x480 picture is near enough to the camera's own that the conversion is not what
 * limits it (the camera's H.265 is). ultrafast is a weaker encoder (no CABAC, no deblocking, no
 * adaptive quantisation): at the same crf it looks worse, so it is given one step of crf and twice
 * the ceiling instead. These viewers are on the local network: bits are cheap there, cores are not.
 * maxKbps is only a ceiling (crf decides the rate), there so that a camera pointed at rain cannot
 * fill a viewer's queue (backpressure.mjs: 1 MB for a sub-stream).
 */
export const LADDER = Object.freeze([
  Object.freeze({ id: 'veryfast', preset: 'veryfast', crf: 21, maxKbps: 3000, cost: 16 }),
  Object.freeze({ id: 'superfast', preset: 'superfast', crf: 21, maxKbps: 4000, cost: 13 }),
  Object.freeze({ id: 'ultrafast', preset: 'ultrafast', crf: 20, maxKbps: 6000, cost: 8 })
])
/** The CPU these conversions may take in all, in cores (CCTV_H264_FALLBACK_CORES). */
export const DEFAULT_CORES = 2
/** ...and how many may run at once whatever they cost: each is a process (CCTV_H264_FALLBACK_MAX). */
export const DEFAULT_MAX = 24
/** One encoder thread each: the box is shared with a worker process per NVR, and a sub-stream needs no more. */
export const ENCODER_THREADS = 1
/** A keyframe every this many seconds out: what a viewer who joins late, or lost a frame, waits at most. */
export const KEY_SECONDS = 2
/** The encoder's buffer at the ceiling, in seconds (transcode.mjs ffmpegArgs bufSeconds). */
export const BUF_SECONDS = 2
/** A conversion nobody watches runs on this long (a tile hidden under the full-size view comes back to it). */
export const LINGER_MS = 10_000
/**
 * Every picture is ended as it goes in (PhoneStream slowFps, Transcoder.endPicture), whatever the
 * camera's rate: a rate under this, which every camera's is. ffmpeg's parser holds a picture until
 * the next one begins, a whole frame interval of delay at 15 fps, and this is live view. Through the
 * real ffmpeg (the server's image, 704x480 H.265 at 15 fps, paced as a camera sends): a picture came
 * out 150-160 ms after it went in without this, 80-95 ms with it, every picture decodable and in
 * order. (The 67 ms left is transcode.mjs holding each picture until the next one's first bytes.)
 */
export const EACH_PICTURE_BELOW_FPS = 1000
/** More than this many seconds of pictures in a converter and not out: it is reset (PhoneStream maxLagS). */
export const MAX_LAG_S = 2
/**
 * A step back up to a better preset waits until there is room for this many more conversions at it:
 * one viewer opening and closing a camera at the edge of a step must not restart every encoder each time.
 */
export const STEP_UP_SPARE = 2
/**
 * A change of step: the old encoder is given this long to hand back what it still holds before the
 * new one's pictures go out (SteppedTranscoder). All but its last picture are out in a few
 * milliseconds; past this, what it has not handed back is left out.
 */
export const HANDOVER_MS = 120
/** A camera whose conversion failed outright (no ffmpeg, a stream it cannot read) is not tried again for this long. */
export const FAILED_QUIET_MS = 60_000
/** "No room" is said in the log at most once in this long. */
export const FULL_SAY_MS = 60_000
/** Why a viewer was refused: the close reason its tile reads (public/live-tile.js has the same two). */
export const NO_ROOM = 'h265: no room to convert'
export const FAILED = 'h265: conversion failed'

/** The CPU budget in units (1 % of one core), from the environment; a bad or missing value means 2 cores. 0: off. */
export function budgetUnits(env = process.env) {
  const raw = env.CCTV_H264_FALLBACK_CORES
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw)
  return Math.round((Number.isFinite(n) && n >= 0 && n <= 16 ? n : DEFAULT_CORES) * 100)
}

/** The most conversions at once, from the environment; a bad or missing value means 24. 0: off. */
export function maxFallbacks(env = process.env) {
  const raw = env.CCTV_H264_FALLBACK_MAX
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= 64 ? n : DEFAULT_MAX
}

/** How many conversions fit at all: the count, or what the budget holds at the ladder's last step. */
export function capacity({ units = DEFAULT_CORES * 100, max = DEFAULT_MAX } = {}) {
  return Math.max(0, Math.min(max, Math.floor(units / LADDER.at(-1).cost)))
}

/**
 * The ladder's step (an index into LADDER) for n conversions running at once: the best one at which
 * all n fit the budget, so n times its cost is never over it (for an n within capacity; past that,
 * the last step, and the caller refuses). Never a better step for more conversions.
 * current: the step they are on now. Going down is at once; back up only with room for
 * STEP_UP_SPARE more at the better step.
 * @param {number} n
 * @param {{ units?: number, current?: number|null }} [o]
 */
export function stepFor(n, { units = DEFAULT_CORES * 100, current = null } = {}) {
  const fits = (i, k) => k * LADDER[i].cost <= units
  let plain = LADDER.findIndex((_, i) => fits(i, n))
  if (plain < 0) plain = LADDER.length - 1
  if (!Number.isInteger(current) || current < 0 || current >= LADDER.length || plain >= current) return plain
  for (let i = plain; i < current; i++) if (fits(i, n + STEP_UP_SPARE)) return i
  return current
}

/**
 * One camera's converter, as PhoneStream drives it (push, endPicture, reset, close, pending), on
 * the ladder's step of the moment. When the step has changed it moves to the new settings at the
 * camera's next keyframe: a new ffmpeg starts there, the old one is told its last picture is whole
 * (endPicture) and hands back what it holds, and only then do the new one's pictures go out, in
 * order. The viewer sees no stall: the old one's very last picture (1/15 s) is left out, the one
 * transcode.mjs holds until the next begins or 150 ms pass, and waiting for that would be the stall.
 * Both ffmpegs are killed on every way out (close, reset, the old one at the end of its hand-over).
 */
export class SteppedTranscoder {
  /**
   * @param {object} o what PhoneStream asks its converter for (transcode.mjs Transcoder's options)
   * @param {{ step: () => number, make?: (o: object) => object, onStep?: (index: number) => void,
   *   onClose?: () => void, setTimer?: Function, clearTimer?: Function, handoverMs?: number }} k
   *   step: the ladder's step now; make: the converter itself; onClose: told once, when it closes
   */
  constructor(o, { step, make = (opts) => new Transcoder(opts), onStep = () => {}, onClose = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, handoverMs = HANDOVER_MS }) {
    Object.assign(this, { o, step, make, onStep, onClose, setTimer, clearTimer, handoverMs })
    this.closed = false
    this.fed = false // a frame has gone into `cur`
    this.old = null // the converter being left, still handing back
    this.held = [] // the new one's pictures meanwhile
    this.timer = null
    this.index = this.#index(step())
    this.cur = this.#make(this.index)
  }

  #index(i) {
    return Number.isInteger(i) && i >= 0 && i < LADDER.length ? i : LADDER.length - 1
  }

  #make(index) {
    const L = LADDER[index]
    const x = this.make({ ...this.o, crf: L.crf, maxKbps: L.maxKbps, preset: L.preset, encThreads: ENCODER_THREADS, onFrame: (ts, isKey, buf) => this.#from(x, ts, isKey, buf) })
    return x
  }

  #from(x, ts, isKey, buf) {
    if (this.closed) return
    if (x === this.old) {
      this.o.onFrame(ts, isKey, buf)
      if (!(x.pending > 1)) this.#finish()
    } else if (x === this.cur) {
      if (this.old) this.held.push([ts, isKey, buf])
      else this.o.onFrame(ts, isKey, buf)
    }
  }

  /** The old converter is done with (or out of time): killed, and the new one's pictures go out. */
  #finish() {
    const old = this.old
    this.old = null
    this.clearTimer(this.timer)
    this.timer = null
    old?.close()
    for (const [ts, isKey, buf] of this.held.splice(0)) if (!this.closed) this.o.onFrame(ts, isKey, buf)
  }

  get pending() {
    return this.cur.pending
  }

  get running() {
    return Boolean(this.cur.running || this.old?.running)
  }

  push(ts, isKey, buf) {
    if (this.closed) return
    if (isKey && !this.old) {
      const want = this.#index(this.step())
      if (want !== this.index) this.#move(want)
    }
    this.fed = true
    this.cur.push(ts, isKey, buf)
  }

  #move(want) {
    const old = this.cur
    this.index = want
    if (!this.fed) old.close() // nothing in it yet: nothing to hand over
    else {
      old.endPicture?.()
      if (old.pending > 1) {
        this.old = old
        this.timer = this.setTimer(() => this.#finish(), this.handoverMs)
        this.timer?.unref?.()
      } else old.close()
    }
    this.cur = this.#make(want)
    this.fed = false
    this.onStep(want)
  }

  endPicture() {
    if (!this.closed) this.cur.endPicture?.()
  }

  /** Everything in flight is forgotten (PhoneStream: it fell behind the camera); starts again at the next keyframe. */
  reset() {
    if (this.old) {
      this.held = []
      this.#finish()
    }
    this.cur.reset?.()
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.clearTimer(this.timer)
    this.timer = null
    this.held = []
    this.old?.close()
    this.old = null
    this.cur.close()
    this.onClose()
  }
}

/** A note for a viewer's tile: a /live-mux channel has notice(), a /live socket takes it as text. */
function tell(ws, obj) {
  try {
    if (typeof ws.notice === 'function') ws.notice(obj)
    else ws.send(JSON.stringify(obj))
  } catch {}
}

/** Every such conversion on the server, by NVR and channel. */
export class H264Fallback {
  /**
   * @param {{ units?: number, max?: number, makeTranscoder?: (o: object) => object, log?: (line: string) => void,
   *   now?: () => number, stopDelayMs?: number, setTimer?: Function, clearTimer?: Function }} [o]
   *   units, max: the budget (budgetUnits, maxFallbacks); makeTranscoder, the timers, now: for tests
   */
  constructor({ units = budgetUnits(), max = maxFallbacks(), makeTranscoder = (o) => new Transcoder(o), log = (l) => console.log(l), now = () => Date.now(), stopDelayMs = LINGER_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { units, makeTranscoder, log, now, stopDelayMs, setTimer, clearTimer })
    this.pool = new TranscodePool(capacity({ units, max }))
    this.streams = new Map()
    this.xcodes = new Set() // the converters running, each on the step it was last moved to
    this.unseen = new Map() // key -> the sockets not told yet that their stream is converted (its first picture tells them)
    this.failed = new Map() // key -> when its conversion failed outright
    this.step = 0
    this.fullSaidAt = -Infinity
    this.refused = 0
  }

  /** Off (a budget of nothing): live-attach.mjs then leaves every viewer on the camera's own stream, as before. */
  get enabled() {
    return this.pool.max > 0
  }

  /** The ladder's step follows the number running; said when it changes. */
  #restep() {
    const n = this.pool.active
    const next = stepFor(n, { units: this.units, current: this.step })
    if (next === this.step) return
    const was = LADDER[this.step]
    this.step = next
    const L = LADDER[next]
    if (n > 0) this.log(`[h264-fallback] ${n} of ${this.pool.max} conversions running: ${L.preset} crf ${L.crf} (was ${was.preset}), each from its camera's next keyframe; about ${((n * L.cost) / 100).toFixed(2)} of ${(this.units / 100).toFixed(2)} cores`)
  }

  /** A place for one more conversion, or null. One nobody watches any more gives its place up, the one left longest first. */
  #slot() {
    let slot = this.pool.acquire()
    if (!slot) {
      const idle = [...this.streams.values()].filter((s) => !s.closed && s.clients.size === 0).sort((a, b) => (a.emptyAt ?? -Infinity) - (b.emptyAt ?? -Infinity))
      for (const s of idle) {
        s.close()
        if ((slot = this.pool.acquire())) break
      }
    }
    if (!slot) return null
    this.#restep()
    return {
      release: () => {
        slot.release()
        this.#restep()
      }
    }
  }

  #make(key, o) {
    const x = new SteppedTranscoder(
      {
        ...o,
        onFrame: (ts, isKey, buf) => {
          o.onFrame(ts, isKey, buf)
          // a converted picture has gone out: the tiles waiting to hear are told theirs is converted
          const unseen = this.unseen.get(key)
          if (!unseen?.size) return
          for (const ws of unseen) tell(ws, { op: 'convert', on: true })
          unseen.clear()
        },
        onFail: (e) => {
          o.onFail?.(e)
          this.#failed(key)
        }
      },
      { step: () => this.step, make: this.makeTranscoder, onClose: () => this.xcodes.delete(x), setTimer: this.setTimer, clearTimer: this.clearTimer }
    )
    this.xcodes.add(x)
    return x
  }

  /**
   * ffmpeg gave nothing at all for this camera. Its viewers are dropped; their tiles ask again and are
   * told so (FAILED) rather than left black, and the camera is left alone for FAILED_QUIET_MS.
   */
  #failed(key) {
    this.failed.set(key, this.now())
    this.streams.get(key)?.close()
  }

  /**
   * Attaches a viewer's socket to the shared H.264 conversion of a camera's sub-stream, starting it
   * when it is the first. source: the camera's own sub-stream (stream-hub.mjs HubStream, live.mjs
   * LiveStream); camera: as the log names it ("nvr-2/5").
   * @returns {true|string} true: attached; else why not, NO_ROOM or FAILED: the socket is the caller's to close
   */
  attach(key, source, ws, { camera } = {}) {
    let s = this.streams.get(key)
    // made on a stream that is not the camera's any more (its NVR edited and made again), or ended:
    // closed (its viewers reconnect) and made again on this one, as phone-live.mjs does
    if (s && !s.closed && (s.source !== source || ended(s.source))) s.close()
    if (!s || s.closed) {
      const at = this.failed.get(key)
      if (at !== undefined) {
        if (this.now() - at < FAILED_QUIET_MS) return FAILED
        this.failed.delete(key)
      }
      const slot = this.#slot()
      if (!slot) {
        this.refused++
        const t = this.now()
        if (t - this.fullSaidAt >= FULL_SAY_MS) {
          this.fullSaidAt = t
          this.log(`[h264-fallback] no room to convert ${camera ?? key}: ${this.pool.active} of ${this.pool.max} conversions running (${(this.units / 100).toFixed(2)} cores allowed); ${this.refused} refused so far, said once in ${FULL_SAY_MS / 1000} s. Its tile says so. CCTV_H264_FALLBACK_CORES / CCTV_H264_FALLBACK_MAX raise it; an H.264 sub-stream on the camera needs none`)
        }
        return NO_ROOM
      }
      s = new PhoneStream({
        source, type: 1, slot, camera, tag: 'h264-fallback',
        makeTranscoder: (o) => this.#make(key, o),
        log: this.log, now: this.now, stopDelayMs: this.stopDelayMs,
        // every frame, converted only if it is H.265; started and held to real time as a remote viewer's
        // full-rate conversion is (adaptive-live.mjs REMOTE_CONVERSION), but with the decoder holding
        // nothing back (low_delay) and each picture out as it goes in: this is live view on the local network
        fps: 0, h264Only: true, keySeconds: KEY_SECONDS, bufSeconds: BUF_SECONDS, learnMs: 1000, slowFps: EACH_PICTURE_BELOW_FPS, wholeReplay: true, rejudge: true, maxLagS: MAX_LAG_S,
        onEmpty: () => {
          if (this.streams.get(key) === s) this.streams.delete(key)
          this.unseen.delete(key)
        }
      })
      // (made and closed in one go when its conversion fails at its very first frame: #failed)
      if (s.closed) return FAILED
      this.streams.set(key, s)
    }
    s.add(ws)
    ws.on?.('close', () => {
      s.remove(ws)
      this.unseen.get(key)?.delete(ws)
    })
    // The tile marks itself as converted (live-tile.js). Told now when converted pictures are already
    // going out (it has just been sent them); otherwise with the first one, never before: a /live
    // socket takes the note as a message, and the stand-in for a cold sub-stream ends at the first
    // message sent to its viewer (sub-bridge.mjs). A camera that sends H.264 after all never says it.
    if (s.xcode && s.gop.length > 0) tell(ws, { op: 'convert', on: true })
    else {
      if (!this.unseen.has(key)) this.unseen.set(key, new Set())
      this.unseen.get(key).add(ws)
    }
    return true
  }

  /** For /api/health and /healthz: how many run, of how many; the step; the CPU they are counted as, of the budget. */
  summary() {
    let units = 0
    for (const x of this.xcodes) units += LADDER[x.index].cost
    let viewers = 0
    for (const s of this.streams.values()) viewers += s.clients.size
    const L = LADDER[this.step]
    return { running: this.pool.active, cap: this.pool.max, step: L.id, crf: L.crf, units, budgetUnits: this.units, viewers, refused: this.refused }
  }
}
