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
// Main streams too, for the full-size view, but as a kind of their own (KINDS): scaled to at most
// 1920 wide, on a ladder and a budget apart from the sub-streams'. A main is 4-8 MP and costs most
// of a core to convert, where a sub-stream costs 7-16 % of one: out of one budget, two full-size
// views would take every grid tile's conversion, or a wall of tiles would leave none for the
// full-size view. So a main has a count of its own (CCTV_H264_FALLBACK_MAIN_MAX, 2; 0 leaves main
// streams exactly as they were: not converted) and its own CPU (CCTV_H264_FALLBACK_MAIN_CORES, 1.6).
// Past it the viewer is refused with a reason of its own (NO_ROOM_MAIN), and its full-size view
// stays on the (converted) sub-stream, as it did before mains were converted at all (viewer.js).
// The map, the linger's mechanics, the quiet after a failure and every kill are shared.
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
/**
 * The same for a main stream scaled to 1920 wide. Measured on the same server, 2560x1440 at 20 fps,
 * 4 Mbit/s H.265 in, calm and noisy synthetic content, two decoder threads and one encoder thread,
 * crf 23: decoding alone 21-22; ultrafast 45-49; superfast 60-75; veryfast 70-90 (1.6-2.2x real
 * time). Each cost is the top of what was measured and a little more, for crf 22. Two steps: one
 * running, veryfast; two, superfast. ultrafast is not on it: this is the picture somebody chose to
 * look at full size, and without deblocking or adaptive quantisation it shows at 1080p; a third
 * viewer is better served by the sub-stream than all three by that. The ceilings are a main's
 * (backpressure.mjs: 4 MB of queue for one).
 */
export const MAIN_LADDER = Object.freeze([
  Object.freeze({ id: 'veryfast', preset: 'veryfast', crf: 22, maxKbps: 8000, cost: 95 }),
  Object.freeze({ id: 'superfast', preset: 'superfast', crf: 22, maxKbps: 10000, cost: 80 })
])
/** The CPU these conversions may take in all, in cores (CCTV_H264_FALLBACK_CORES). */
export const DEFAULT_CORES = 2
/** ...and how many may run at once whatever they cost: each is a process (CCTV_H264_FALLBACK_MAX). */
export const DEFAULT_MAX = 24
/** ...and the same two for main streams (CCTV_H264_FALLBACK_MAIN_CORES, CCTV_H264_FALLBACK_MAIN_MAX): two at superfast. */
export const DEFAULT_MAIN_CORES = 1.6
export const DEFAULT_MAIN_MAX = 2
/** A converted main is at most this wide, never wider than the camera's (transcode.mjs ffmpegArgs maxWidth). */
export const MAIN_MAX_WIDTH = 1920
/** One encoder thread each: the box is shared with a worker process per NVR, and a sub-stream needs no more. */
export const ENCODER_THREADS = 1
/**
 * A main's encoder has one thread too. With two, superfast ran 2.4-3.4x real time instead of
 * 2.1-2.8x and cost 65-86 % of a core instead of 60-75: more CPU for speed a live view has no use
 * for, and zerolatency's second thread cuts each picture into slices, which costs picture.
 */
export const MAIN_ENCODER_THREADS = 1
/** A keyframe every this many seconds out: what a viewer who joins late, or lost a frame, waits at most. */
export const KEY_SECONDS = 2
/** The encoder's buffer at the ceiling, in seconds (transcode.mjs ffmpegArgs bufSeconds). */
export const BUF_SECONDS = 2
/** A conversion nobody watches runs on this long (a tile hidden under the full-size view comes back to it). */
export const LINGER_MS = 10_000
/**
 * ...a main's only this long: it costs most of a core, and a full-size view that closes is usually
 * gone. Long enough for a page that reloads, or a view closed and opened again by mistake.
 */
export const MAIN_LINGER_MS = 3000
/**
 * Every picture is ended as it goes in (PhoneStream slowFps, Transcoder.endPicture), whatever the
 * camera's rate: a rate under this, which every camera's is. ffmpeg's parser holds a picture until
 * the next one begins, a whole frame interval of delay at 15 fps, and this is live view. Through the
 * real ffmpeg (the server's image, 704x480 H.265 at 15 fps, paced as a camera sends): a picture came
 * out 150-160 ms after it went in without this, 80-95 ms with it, every picture decodable and in
 * order. (The 67 ms left is transcode.mjs holding each picture until the next one's first bytes.)
 */
export const EACH_PICTURE_BELOW_FPS = 1000
/**
 * A main is not converted that way at 10 fps and up, where every camera here is: the decoder has two
 * threads instead (transcode.mjs DECODE_THREADS; low_delay would turn them off). One thread decodes
 * 1440p at five times real time (19-20 % of a core), so the threads are not for speed there; they are
 * for the 4K cameras, which one thread kept ahead of by only 1.19-1.23x at 20 fps (2.15-2.32x with
 * two), on a box where ffmpeg is niced under everything else. A conversion that falls behind is
 * reset (MAX_LAG_S) and its viewer waits for the camera's next keyframe; the second thread holds one
 * picture back, 50 ms at 20 fps, which nobody sees in a live view. Below this rate one thread has
 * the time, as for a sub-stream. Either way each picture is ended as it goes in (PhoneStream endEach),
 * so the parser does not hold a second one back. Through the real ffmpeg (the server's image on a
 * slower PC, 2560x1440 H.265 at 20 fps, paced as a camera sends, superfast): a picture came out
 * 180-185 ms after it went in with two threads alone, 135-140 ms with each picture ended; with
 * low_delay 100-130 ms while it kept up, which there it did not (reset twice in 20 s). On the server
 * itself, niced, at veryfast: 131 ms in the middle, 136 ms for nine pictures in ten, none reset.
 */
export const MAIN_EACH_PICTURE_BELOW_FPS = 10
/** More than this many seconds of pictures in a converter and not out: it is reset (PhoneStream maxLagS). */
export const MAX_LAG_S = 2
/**
 * A step back up to a better preset waits until there is room for this many more conversions at it:
 * one viewer opening and closing a camera at the edge of a step must not restart every encoder each time.
 */
export const STEP_UP_SPARE = 2
/**
 * ...a main's as soon as it fits: with two at most there is no room to wait for, and the one left
 * running when the other full-size view closes should not stay on the weaker preset.
 */
export const MAIN_STEP_UP_SPARE = 0
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
/** ...and a main refused for want of room: its own, so the full-size view stays on its sub-stream instead (viewer.js). */
export const NO_ROOM_MAIN = 'h265: no room to convert main'

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

/** The main streams' CPU budget in units, from the environment; a bad or missing value means 1.6 cores. 0: off. */
export function mainBudgetUnits(env = process.env) {
  const raw = env.CCTV_H264_FALLBACK_MAIN_CORES
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw)
  return Math.round((Number.isFinite(n) && n >= 0 && n <= 8 ? n : DEFAULT_MAIN_CORES) * 100)
}

/** The most main streams converted at once, from the environment; a bad or missing value means 2. 0: off. */
export function maxMainFallbacks(env = process.env) {
  const raw = env.CCTV_H264_FALLBACK_MAIN_MAX
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= 8 ? n : DEFAULT_MAIN_MAX
}

/** How many conversions fit at all: the count, or what the budget holds at the ladder's last step. */
export function capacity({ units = DEFAULT_CORES * 100, max = DEFAULT_MAX, ladder = LADDER } = {}) {
  return Math.max(0, Math.min(max, Math.floor(units / ladder.at(-1).cost)))
}

/**
 * The ladder's step (an index into LADDER) for n conversions running at once: the best one at which
 * all n fit the budget, so n times its cost is never over it (for an n within capacity; past that,
 * the last step, and the caller refuses). Never a better step for more conversions.
 * current: the step they are on now. Going down is at once; back up only with room for
 * STEP_UP_SPARE more at the better step.
 * ladder, spare: another kind's (a main stream's: MAIN_LADDER, MAIN_STEP_UP_SPARE).
 * @param {number} n
 * @param {{ units?: number, current?: number|null, ladder?: ReadonlyArray<{ cost: number }>, spare?: number }} [o]
 */
export function stepFor(n, { units = DEFAULT_CORES * 100, current = null, ladder = LADDER, spare = STEP_UP_SPARE } = {}) {
  const fits = (i, k) => k * ladder[i].cost <= units
  let plain = ladder.findIndex((_, i) => fits(i, n))
  if (plain < 0) plain = ladder.length - 1
  if (!Number.isInteger(current) || current < 0 || current >= ladder.length || plain >= current) return plain
  for (let i = plain; i < current; i++) if (fits(i, n + spare)) return i
  return current
}

/**
 * The two kinds of conversion, and what differs between them: the ladder and how soon it steps back
 * up, the encoder's threads, the linger, the reason a viewer is refused with, and how its shared
 * stream runs (PhoneStream's options). Either way every frame is kept and only H.265 converted,
 * started and held to real time as a remote viewer's full-rate conversion is (adaptive-live.mjs
 * REMOTE_CONVERSION). A sub-stream's decoder holds nothing back (low_delay) and each picture is out
 * as it goes in, with nothing scaled. A main is scaled to MAIN_MAX_WIDTH and decoded on two threads
 * (MAIN_EACH_PICTURE_BELOW_FPS says why).
 */
const SHARED = { fps: 0, h264Only: true, keySeconds: KEY_SECONDS, bufSeconds: BUF_SECONDS, learnMs: 1000, wholeReplay: true, rejudge: true, maxLagS: MAX_LAG_S }
export const KINDS = Object.freeze({
  sub: Object.freeze({ id: 'sub', ladder: LADDER, spare: STEP_UP_SPARE, encThreads: ENCODER_THREADS, lingerMs: LINGER_MS, noRoom: NO_ROOM, stream: Object.freeze({ ...SHARED, type: 1, slowFps: EACH_PICTURE_BELOW_FPS }) }),
  main: Object.freeze({ id: 'main', ladder: MAIN_LADDER, spare: MAIN_STEP_UP_SPARE, encThreads: MAIN_ENCODER_THREADS, lingerMs: MAIN_LINGER_MS, noRoom: NO_ROOM_MAIN, stream: Object.freeze({ ...SHARED, type: 0, maxWidth: MAIN_MAX_WIDTH, lowDelay: false, slowFps: MAIN_EACH_PICTURE_BELOW_FPS, endEach: true }) })
})

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
   *   onClose?: () => void, setTimer?: Function, clearTimer?: Function, handoverMs?: number,
   *   ladder?: ReadonlyArray<object>, encThreads?: number }} k
   *   step: the ladder's step now; make: the converter itself; onClose: told once, when it closes;
   *   ladder, encThreads: its kind's (KINDS), a sub-stream's unless said
   */
  constructor(o, { step, make = (opts) => new Transcoder(opts), onStep = () => {}, onClose = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, handoverMs = HANDOVER_MS, ladder = LADDER, encThreads = ENCODER_THREADS }) {
    Object.assign(this, { o, step, make, onStep, onClose, setTimer, clearTimer, handoverMs, ladder, encThreads })
    this.closed = false
    this.fed = false // a frame has gone into `cur`
    this.old = null // the converter being left, still handing back
    this.held = [] // the new one's pictures meanwhile
    this.timer = null
    this.index = this.#index(step())
    this.cur = this.#make(this.index)
  }

  #index(i) {
    return Number.isInteger(i) && i >= 0 && i < this.ladder.length ? i : this.ladder.length - 1
  }

  #make(index) {
    const L = this.ladder[index]
    const x = this.make({ ...this.o, crf: L.crf, maxKbps: L.maxKbps, preset: L.preset, encThreads: this.encThreads, onFrame: (ts, isKey, buf) => this.#from(x, ts, isKey, buf) })
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

/** Every such conversion on the server, by NVR, channel and stream. */
export class H264Fallback {
  /**
   * @param {{ units?: number, max?: number, mainUnits?: number, mainMax?: number, makeTranscoder?: (o: object) => object,
   *   log?: (line: string) => void, now?: () => number, stopDelayMs?: number, mainStopDelayMs?: number,
   *   setTimer?: Function, clearTimer?: Function }} [o]
   *   units, max: the sub-streams' budget (budgetUnits, maxFallbacks); mainUnits, mainMax: the main
   *   streams' (mainBudgetUnits, maxMainFallbacks); makeTranscoder, the lingers, the timers, now: for tests
   */
  constructor({ units = budgetUnits(), max = maxFallbacks(), mainUnits = mainBudgetUnits(), mainMax = maxMainFallbacks(), makeTranscoder = (o) => new Transcoder(o), log = (l) => console.log(l), now = () => Date.now(), stopDelayMs = LINGER_MS, mainStopDelayMs = MAIN_LINGER_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { makeTranscoder, log, now, stopDelayMs, setTimer, clearTimer })
    // each kind's budget and where it stands in it: nothing of one is ever counted against the other
    const kind = (K, u, m, lingerMs) => ({ ...K, units: u, lingerMs, pool: new TranscodePool(capacity({ units: u, max: m, ladder: K.ladder })), step: 0, fullSaidAt: -Infinity, refused: 0 })
    this.kinds = { sub: kind(KINDS.sub, units, max, stopDelayMs), main: kind(KINDS.main, mainUnits, mainMax, mainStopDelayMs) }
    this.streams = new Map()
    this.xcodes = new Set() // the converters running, each on the step it was last moved to
    this.unseen = new Map() // key -> the sockets not told yet that their stream is converted (its first picture tells them)
    this.failed = new Map() // key -> when its conversion failed outright
  }

  /** Off (a budget of nothing): live-attach.mjs then leaves every viewer on the camera's own stream, as before. */
  get enabled() {
    return this.pool.max > 0
  }

  /** The same for main streams: off, a main stream is never converted, as before there was any of this. */
  get mainEnabled() {
    return this.kinds.main.pool.max > 0
  }

  // (the sub-streams' budget under the names it had when it was the only one)
  get pool() {
    return this.kinds.sub.pool
  }

  get units() {
    return this.kinds.sub.units
  }

  get step() {
    return this.kinds.sub.step
  }

  get refused() {
    return this.kinds.sub.refused
  }

  /** A kind's ladder step follows the number of its kind running; said when it changes. */
  #restep(K) {
    const n = K.pool.active
    const next = stepFor(n, { units: K.units, current: K.step, ladder: K.ladder, spare: K.spare })
    if (next === K.step) return
    const was = K.ladder[K.step]
    K.step = next
    const L = K.ladder[next]
    if (n > 0) this.log(`[h264-fallback] ${n} of ${K.pool.max} ${K.id === 'main' ? 'main-stream ' : ''}conversions running: ${L.preset} crf ${L.crf} (was ${was.preset}), each from its camera's next keyframe; about ${((n * L.cost) / 100).toFixed(2)} of ${(K.units / 100).toFixed(2)} cores`)
  }

  /**
   * A place for one more conversion of a kind, or null. One of that kind nobody watches any more
   * gives its place up, the one left longest first.
   */
  #slot(K) {
    let slot = K.pool.acquire()
    if (!slot) {
      const idle = [...this.streams.values()].filter((s) => s.kind === K && !s.closed && s.clients.size === 0).sort((a, b) => (a.emptyAt ?? -Infinity) - (b.emptyAt ?? -Infinity))
      for (const s of idle) {
        s.close()
        if ((slot = K.pool.acquire())) break
      }
    }
    if (!slot) return null
    this.#restep(K)
    return {
      release: () => {
        slot.release()
        this.#restep(K)
      }
    }
  }

  #make(key, K, o) {
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
      { step: () => K.step, make: this.makeTranscoder, onClose: () => this.xcodes.delete(x), setTimer: this.setTimer, clearTimer: this.clearTimer, ladder: K.ladder, encThreads: K.encThreads }
    )
    x.kind = K
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
   * Attaches a viewer's socket to the shared H.264 conversion of a camera's stream, starting it
   * when it is the first. source: the camera's own stream (stream-hub.mjs HubStream, live.mjs
   * LiveStream); camera: as the log names it ("nvr-2/5"); kind: 'sub' (unless said) or 'main', which
   * must be the stream the key names.
   * @returns {true|string} true: attached; else why not, NO_ROOM (a main: NO_ROOM_MAIN) or FAILED: the
   *   socket is the caller's to close
   */
  attach(key, source, ws, { camera, kind = 'sub' } = {}) {
    const K = this.kinds[kind] ?? this.kinds.sub
    const main = K.id === 'main'
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
      const slot = this.#slot(K)
      if (!slot) {
        K.refused++
        const t = this.now()
        if (t - K.fullSaidAt >= FULL_SAY_MS) {
          K.fullSaidAt = t
          const tail = main
            ? 'Its full-size view stays on the sub-stream and asks again. CCTV_H264_FALLBACK_MAIN_CORES / CCTV_H264_FALLBACK_MAIN_MAX raise it'
            : 'Its tile says so. CCTV_H264_FALLBACK_CORES / CCTV_H264_FALLBACK_MAX raise it; an H.264 sub-stream on the camera needs none'
          this.log(`[h264-fallback] no room to convert ${camera ?? key}${main ? "'s main stream" : ''}: ${K.pool.active} of ${K.pool.max} ${main ? 'main-stream ' : ''}conversions running (${(K.units / 100).toFixed(2)} cores allowed); ${K.refused} refused so far, said once in ${FULL_SAY_MS / 1000} s. ${tail}`)
        }
        return K.noRoom
      }
      s = new PhoneStream({
        source, slot, camera, tag: 'h264-fallback',
        makeTranscoder: (o) => this.#make(key, K, o),
        log: this.log, now: this.now, stopDelayMs: K.lingerMs,
        // what its kind says (KINDS): live view on the local network, every frame, only H.265 converted
        ...K.stream,
        onEmpty: () => {
          if (this.streams.get(key) === s) this.streams.delete(key)
          this.unseen.delete(key)
        }
      })
      // (made and closed in one go when its conversion fails at its very first frame: #failed)
      if (s.closed) return FAILED
      s.kind = K
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

  /**
   * For /api/health and /healthz: how many run, of how many; the step; the CPU they are counted as, of
   * the budget. The sub-streams' as it always was, and the main streams' the same under `main`, left
   * out when they are off (the summary is then what it was).
   */
  summary() {
    const of = (K) => {
      let units = 0
      for (const x of this.xcodes) if (x.kind === K) units += K.ladder[x.index].cost
      let viewers = 0
      for (const s of this.streams.values()) if (s.kind === K) viewers += s.clients.size
      const L = K.ladder[K.step]
      return { running: K.pool.active, cap: K.pool.max, step: L.id, crf: L.crf, units, budgetUnits: K.units, viewers, refused: K.refused }
    }
    return { ...of(this.kinds.sub), ...(this.mainEnabled ? { main: of(this.kinds.main) } : {}) }
  }
}
