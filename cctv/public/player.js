// Video engine shared by live view and recorded playback.
//
// Smoothness: decoded frames wait in a small jitter buffer and are shown on the
// display's refresh (requestAnimationFrame) at their capture time, as scheduled
// by the PlayoutClock, instead of the moment they happen to finish decoding.
//
// Lightness: hardware decoding is preferred, canvases are sized to what is
// actually on screen (not the full video resolution), and one shared render
// loop serves every player, drawing only when a new frame is due.
//
// Playback from the server's recordings (playback.js server mode) adds:
//  - skipUntil(ts): after a seek the server sends the frames from the keyframe before the wanted
//    time at once (the preroll). They are decoded but not shown; the keyframe is drawn at once as
//    a poster, so a picture appears before the first frame due is decoded.
//  - setStills(on): reverse and scrubbing send single keyframes: each is drawn as soon as it is
//    decoded, without the playout clock. Stills never skip: turning them on ends a skipUntil.
//  - seekReset(): a seek keeps the decoder set up (reset + configure with the same config), so it
//    needs no isConfigSupported round trip.
import { PlayoutClock } from './playout.js'
import { pictureSize, videoInfo } from './sps.js'

const MAX_QUEUED_FRAMES = 45
const MAX_PAUSED_FRAMES = 90 // frames that may arrive after a pause request reaches the NVR
const MAX_DECODE_QUEUE = 12
// while a preroll is being skipped (skipUntil) its burst may wait to be decoded, up to this many
// frames (about a keyframe interval of 12 s at 25 fps), instead of MAX_DECODE_QUEUE and MAX_HELD
const MAX_PREROLL_FRAMES = 300
// frames that arrive while the decoder is being set up are kept (not dropped) up to this much,
// so a new stream or a codec change doesn't lose the rest of the keyframe interval
const MAX_HELD = 30
const MAX_HELD_US = 1_000_000
const KEYS_KEPT = 16 // timestamps of the last keyframes (to tell decoded keyframes apart)
const LONG_GOP_MS = 5000 // H.265+/H.264+ send keyframes rarely
const LONG_GOP_WAIT_MS = 12_000 // ... so grabAfterKey waits this long for one, then measures anywhere
// the keyframe interval not known yet (the stream only just started, e.g. after a camera
// restart): after the first set, wait this long for the next keyframe before measuring anywhere
const UNKNOWN_GOP_WAIT_MS = 5000

export const CODEC_H264 = 0
export const CODEC_H265 = 1

// Display range fix (?range=full, off by default until checked by eye on the test PC): TVT
// cameras flag their video as limited range with no colour description, but code the full
// 0-255 range, so the browser's limited-range conversion clips shadows and highlights the
// camera recorded. The fix tells the decoder the video is full-range BT.709.
const RANGE_FIX = typeof location !== 'undefined' && new URLSearchParams(location.search).get('range') === 'full'
const FULL_RANGE_709 = { fullRange: true, matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' }

/** Whether a stream (its videoInfo) has the TVT signature the range fix is for. */
export const wantsRangeFix = (info) => Boolean(info) && info.fullRange === false && !info.colourDesc

/** Builds the WebCodecs codec string from the first SPS in an Annex B H.264 frame. */
function h264Codec(data) {
  for (let i = 0; i + 7 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7) {
      const hex = (b) => b.toString(16).padStart(2, '0')
      return `avc1.${hex(data[i + 4])}${hex(data[i + 5])}${hex(data[i + 6])}`
    }
  }
  return 'avc1.640033'
}

// browsers differ in which H.265 codec strings they accept; try the common forms
const H265_CODECS = ['hev1.1.6.L153.B0', 'hvc1.1.6.L153.B0', 'hev1.1.6.L120.90', 'hvc1.1.6.L120.90', 'hev1.1.6.L93.B0', 'hvc1.1.6.L93.B0']

async function pickDecoderConfig(codecId, data, size, info, rangeFix = RANGE_FIX) {
  const codecs = codecId === CODEC_H265 ? H265_CODECS : [h264Codec(data)]
  // without a size the decoder assumes 1280x720, which some hardware decoders keep (see sps.js)
  const dims = size ? { codedWidth: size.width, codedHeight: size.height } : {}
  // with the range fix, try the colour-space override first; a browser that refuses it still plays
  const colours = rangeFix && wantsRangeFix(info) ? [{ colorSpace: FULL_RANGE_709 }, {}] : [{}]
  for (const colour of colours) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
      for (const codec of codecs) {
        const config = { codec, optimizeForLatency: true, hardwareAcceleration, ...dims, ...colour }
        const { supported } = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }))
        if (supported) return config
      }
    }
  }
  return null
}

/** Whether this browser can decode H.265 at all (checked once, before asking for H.265 video). */
let h265Support
export function canDecodeH265() {
  if (!('VideoDecoder' in window)) return Promise.resolve(false)
  h265Support ??= (async () => {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
      for (const codec of H265_CODECS) {
        const res = await VideoDecoder.isConfigSupported({ codec, hardwareAcceleration }).catch(() => ({}))
        if (res.supported) return true
      }
    }
    return false
  })()
  return h265Support
}

// ---- shared render loop ---------------------------------------------------

const active = new Set()
let rafId = 0

function tick(now) {
  for (const player of active) player.present(now)
  rafId = active.size > 0 ? requestAnimationFrame(tick) : 0
}

function track(player) {
  active.add(player)
  if (!rafId) rafId = requestAnimationFrame(tick)
}

// ---- player ---------------------------------------------------------------

export class VideoPlayer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ pacing?: boolean, clock?: object, onUnsupported?: (codecId: number) => void, onFrame?: (tsMs: number) => void, onPoster?: (tsMs: number) => void }} [options]
   *   pacing: false draws frames as soon as they decode (for comparison only)
   *   clock: PlayoutClock options (playback uses a larger buffer than live)
   *   onFrame: called with the capture time of each frame as it is shown
   *   onPoster: called when a preroll's keyframe is drawn as a poster (skipUntil; onFrame is not)
   *   maxFps: draw at most this many frames a second (a phone gains nothing above 15); the frames
   *     between are still decoded -- each depends on the one before -- just never drawn
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { alpha: false })
    this.pacing = options.pacing ?? true
    this.onUnsupported = options.onUnsupported
    this.onFrame = options.onFrame
    this.onPoster = options.onPoster
    this.minDrawGapMs = options.maxFps > 0 ? 1000 / options.maxFps - 4 : 0 // -4: one display refresh of slack
    this.lastDrawAt = 0
    this.clock = new PlayoutClock(options.clock)
    this.paused = false
    this.decoder = null
    this.config = null // the config the decoder was set up with (seekReset sets it up again with it)
    this.configuring = false
    this.needKey = true
    this.skipTs = null // skipUntil: decoded frames before this time (ms) are not shown
    this.posterShown = false
    this.stills = false // setStills: every decoded frame is drawn at once
    this.seekSeq = 0 // counts seekReset()s: a frame set up for before one is not decoded after it
    this.queue = [] // { frame: VideoFrame, ts: ms } in decode order, waiting for display
    this.videoWidth = 0
    this.videoHeight = 0
    this.codecId = null
    this.size = null // picture size the decoder was set up for (from the SPS)
    this.closed = false
    this.stats = { fps: 0, jitterMs: 0, delayMs: 0, dropped: 0, late: 0, resyncs: 0, kbps: 0, width: 0, height: 0, codec: '', hw: '', coded: '', visible: '' }
    this.win = { frames: 0, bytes: 0, intervals: [], lastShown: 0 }
    this.grabs = [] // callers waiting for the next frame shown, at full size (grab())
    this.onChunk = null // (chunk) => void: sees every encoded frame as it arrives (set while the picture panel is open)
    this.keyTs = [] // timestamps (µs) of the last keyframes received, oldest first
    this.keyTsSet = new Set() // the same, to recognise decoded keyframes
    this.held = null // frames that arrived while the decoder was being set up
    this.heldLost = false
    this.sinceKey = null // decoded frames since the last keyframe (null: none decoded yet)
    this.lastKeyTs = null // timestamp of the last keyframe decoded, and the gap to the one before (µs)
    this.keyGapUs = null
    this.info = null // videoInfo (sps.js) of the stream the decoder is set up for
    this.rangeFixed = false // the display range fix's colour space is in the decoder config
    this.gop = null // a running grabAfterKey
    this.statsTimer = setInterval(() => this.#everySecond(), 1000)

    this.resizeObserver = new ResizeObserver(() => this.#fitCanvas())
    this.resizeObserver.observe(canvas)
    track(this)
  }

  /**
   * Feeds one encoded frame.
   * @param {{ isKey: boolean, codecId: number, timestampUs: number, data: Uint8Array }} chunk
   */
  push(chunk) {
    if (this.closed) return
    this.win.bytes += chunk.data.length
    if (chunk.isKey) this.#noteKey(chunk.timestampUs)
    if (this.onChunk) {
      try {
        this.onChunk(chunk)
      } catch (e) {
        console.warn('onChunk', e)
      }
    }
    if (this.configuring) return this.#hold(chunk)
    return this.#feed(chunk)
  }

  #noteKey(ts) {
    if (this.keyTsSet.has(ts)) return
    this.keyTs.push(ts)
    this.keyTsSet.add(ts)
    while (this.keyTs.length > KEYS_KEPT) this.keyTsSet.delete(this.keyTs.shift())
  }

  /**
   * Keeps a frame that arrives while the decoder is being set up (up to 1 s or 30 frames; while a
   * preroll is skipped, up to MAX_PREROLL_FRAMES: the server sends it all at once).
   */
  #hold(chunk) {
    const held = this.held
    const skipping = this.skipTs !== null
    const full = held.length >= (skipping ? MAX_PREROLL_FRAMES : MAX_HELD)
    if (held.length && (full || (!skipping && chunk.timestampUs - held[0].timestampUs > MAX_HELD_US))) {
      // set-up is taking too long: drop them, and carry on from the next keyframe
      this.stats.dropped += held.length
      held.length = 0
      this.heldLost = true
    }
    if (this.heldLost && !chunk.isKey) {
      this.stats.dropped++
      return
    }
    if (chunk.isKey) this.heldLost = false // a keyframe needs nothing that came before it
    held.push(chunk)
  }

  /** Decodes a frame, setting the decoder up first when needed; then any frames held meanwhile. */
  async #feed(first) {
    let chunk = first
    let backlog = false
    while (chunk && !this.closed) {
      const { isKey, codecId, data } = chunk
      // a frame of another codec can't go to this decoder: wait for that codec's keyframe
      if (this.decoder && codecId !== this.codecId) this.needKey = true
      // the decoder is told the picture size, and set up again at a keyframe with a new size
      // (a camera's resolution was changed)
      const size = isKey ? pictureSize(codecId, data) : null
      const resized = Boolean(size) && (size.width !== this.size?.width || size.height !== this.size?.height)
      if (resized && this.decoder) this.needKey = true
      let ok = !this.needKey || isKey
      if (ok && this.needKey) {
        if (!this.decoder || this.codecId !== codecId || resized) {
          this.configuring = true
          this.held ??= []
          const seq = this.seekSeq
          ok = await this.#configure(codecId, data, size).catch((e) => {
            console.warn('decoder set-up failed', e)
            this.#closeDecoder()
            return false
          })
          if (!ok) this.held.length = 0
          // a seek came meanwhile (seekReset): this frame is from before it; the decoder stays set up
          else if (seq !== this.seekSeq) ok = false
        }
        if (ok) this.needKey = false
      }
      if (ok) this.#decode(chunk, backlog)
      chunk = this.held?.shift()
      backlog = true
    }
    if (this.configuring) {
      // frames were lost while setting up: what follows can't be decoded without a keyframe
      if (this.heldLost) this.needKey = true
      this.configuring = false
      this.held = null
      this.heldLost = false
    }
  }

  #decode({ isKey, timestampUs, data }, backlog) {
    if (!this.decoder || this.decoder.state !== 'configured') return
    // decoder can't keep up: skip to the next keyframe rather than fall behind (frames held
    // during set-up are a known, bounded backlog; so is a preroll being skipped, sent at once)
    const limit = this.skipTs !== null ? MAX_PREROLL_FRAMES : MAX_DECODE_QUEUE + (backlog ? MAX_HELD : 0)
    if (this.decoder.decodeQueueSize > limit && !isKey) {
      this.needKey = true
      this.stats.dropped++
      return
    }
    this.decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: timestampUs, data }))
  }

  async #configure(codecId, data, size) {
    this.#closeDecoder()
    const info = videoInfo(codecId, data)
    const config = await pickDecoderConfig(codecId, data, size, info)
    if (this.closed) return false
    if (!config) {
      this.onUnsupported?.(codecId)
      return false
    }
    this.codecId = codecId
    this.size = size
    this.info = info
    this.rangeFixed = Boolean(config.colorSpace)
    this.stats.codec = config.codec
    this.stats.hw = config.hardwareAcceleration === 'prefer-hardware' ? 'hardware' : 'auto'
    this.decoder = new VideoDecoder({
      output: (frame) => this.#onDecoded(frame),
      error: (err) => {
        console.warn('decoder error', err)
        this.#closeDecoder()
        this.needKey = true
      }
    })
    this.decoder.configure(config)
    this.config = config
    return true
  }

  #onDecoded(frame) {
    if (this.closed) {
      frame.close()
      return
    }
    // position in the keyframe interval (the decoder keeps timestamps; there are no B-frames)
    if (this.keyTsSet.has(frame.timestamp)) {
      this.sinceKey = 0
      this.keyGapUs = this.lastKeyTs === null ? null : frame.timestamp - this.lastKeyTs
      this.lastKeyTs = frame.timestamp
    } else if (this.sinceKey !== null) this.sinceKey++
    if (this.gop) this.#gopFrame(frame)
    if (frame.displayWidth !== this.videoWidth || frame.displayHeight !== this.videoHeight) {
      this.videoWidth = frame.displayWidth
      this.videoHeight = frame.displayHeight
      // for the D overlay: what the decoder reports vs. what it decoded (size mismatches crop the picture)
      const v = frame.visibleRect
      this.stats.coded = `${frame.codedWidth}×${frame.codedHeight}`
      this.stats.visible = v ? `${v.width}×${v.height}+${v.x}+${v.y}` : '?'
      this.#fitCanvas()
    }
    const ts = frame.timestamp / 1000
    if (this.skipTs !== null) {
      if (ts < this.skipTs) {
        // the preroll: decoded because the frames after it need it, not shown (and not dropped);
        // its first frame, the keyframe, is drawn at once as a poster
        if (this.posterShown) frame.close()
        else {
          this.posterShown = true
          this.#draw(frame, performance.now())
          this.onPoster?.(ts)
        }
        return
      }
      this.skipTs = null
    }
    if (!this.pacing || this.stills) {
      this.#draw(frame, performance.now())
      this.onFrame?.(ts)
      return
    }
    if (!this.paused) this.clock.schedule(ts, performance.now())
    this.queue.push({ frame, ts })
    while (this.queue.length > (this.paused ? MAX_PAUSED_FRAMES : MAX_QUEUED_FRAMES)) {
      this.queue.shift().frame.close()
      this.stats.dropped++
    }
  }

  /** Called by the shared render loop on every display refresh. */
  present(now) {
    if (this.paused || this.stills || this.queue.length === 0) return
    // newest frame that is due; anything older than it is skipped
    let due = -1
    for (let i = 0; i < this.queue.length && this.clock.presentAt(this.queue[i].ts) <= now; i++) due = i
    if (due < 0) return
    // held to maxFps: wait, and draw the newest due frame when the gap is up
    if (this.minDrawGapMs && now - this.lastDrawAt < this.minDrawGapMs) return
    this.lastDrawAt = now
    for (let i = 0; i < due; i++) {
      this.queue[i].frame.close()
      this.stats.dropped++
    }
    const { frame, ts } = this.queue[due]
    this.queue.splice(0, due + 1)
    this.#draw(frame, now)
    this.onFrame?.(ts)
  }

  /** Freezes on the current picture; buffered frames are kept. */
  pause() {
    this.paused = true
  }

  resume() {
    this.paused = false
    // continue from the oldest buffered frame instead of skipping what arrived while paused
    if (this.queue.length > 0) this.clock.anchorAt(this.queue[0].ts, performance.now())
    else this.clock.anchor = null
  }

  /** Playback speed; the next buffered frame is shown immediately at the new rate. */
  setRate(rate) {
    const next = this.queue[0]?.ts
    this.clock.setRate(rate, next, performance.now())
  }

  #draw(frame, now) {
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height)
    if (this.grabs.length) this.#grabFrame(frame)
    frame.close()
    const w = this.win
    if (w.lastShown) w.intervals.push(now - w.lastShown)
    w.lastShown = now
    w.frames++
  }

  /**
   * The next frame shown, at the video's own size (not the on-screen size), as ImageData:
   * for measuring the picture. Rejects if nothing is shown within timeoutMs.
   */
  grab(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject }
      waiter.timer = setTimeout(() => {
        this.grabs = this.grabs.filter((w) => w !== waiter)
        reject(new Error('no picture'))
      }, timeoutMs)
      this.grabs.push(waiter)
    })
  }

  #grabFrame(frame) {
    const waiting = this.grabs.splice(0)
    for (const w of waiting) clearTimeout(w.timer)
    try {
      const c = document.createElement('canvas')
      c.width = frame.displayWidth
      c.height = frame.displayHeight
      const g = c.getContext('2d', { willReadFrequently: true })
      g.drawImage(frame, 0, 0, c.width, c.height)
      const image = g.getImageData(0, 0, c.width, c.height)
      for (const w of waiting) w.resolve(image)
    } catch (e) {
      for (const w of waiting) w.reject(e)
    }
  }

  /** Median time between scheduled keyframes received (ms), or null before two were seen. */
  keyIntervalMs() {
    const gaps = []
    for (let i = 1; i < this.keyTs.length; i++) {
      const d = (this.keyTs[i] - this.keyTs[i - 1]) / 1000
      if (d >= 1000) gaps.push(d) // a keyframe sooner than 1 s after another was asked for (a viewer connecting)
    }
    gaps.sort((a, b) => a - b)
    return gaps.length ? gaps[gaps.length >> 1] : null
  }

  /**
   * How this browser shows the video: { matrix, range: 'limited' | 'full', rangeFixed }. With
   * the range fix the decoder was told full-range BT.709; otherwise the frame's own colour space
   * (TVT's limited-range flag), matrix BT.709 when the stream doesn't say.
   */
  displayColour(frame = null) {
    if (this.rangeFixed) return { matrix: 'bt709', range: 'full', rangeFixed: true }
    const cs = frame?.colorSpace
    const full = cs?.fullRange ?? this.info?.fullRange ?? false
    return { matrix: cs?.matrix ?? 'bt709', range: full ? 'full' : 'limited', rangeFixed: false }
  }

  /**
   * Frames at fixed positions after keyframes, for measuring the picture (plan D2): in each of
   * `sets` keyframe intervals in a row, the decoded frames `offsets` after its keyframe. Each
   * is a clone handed at once to sink(frame, meta), which owns it (transfer it to a Worker, or
   * close it): the player keeps none. meta = { set, sinceKey, ts (µs), aligned, displayMatrix,
   * displayRange, selfCheck (first frame of each set) }.
   *
   * The first set starts at the next keyframe, the next at the one after. When keyframes are
   * rare (keyframe interval over 5 s, H.265+) or none comes, it waits up to 12 s for one, then
   * takes the remaining frames every 6 frames from wherever the stream is ("position in GOP
   * unknown" unless the first set did start at a keyframe; the Measurer drops pairs close
   * after a keyframe from sinceKey). With the interval not known yet (a stream that just
   * started, e.g. after a camera restart) the next set waits up to 5 s for the next keyframe.
   *
   * Resolves { frames, sets: [[sinceKey, ...] per set], aligned, complete, reason, gopMs }
   * when done, at a deadline with what it has (timeoutMs, if given, caps the whole grab), or
   * when the stream restarts. Rejects when nothing was taken ('no picture'), when cancelled
   * through `signal` (AbortError) or when the player closes.
   * keyWaitMs: how long to wait for a rare keyframe (12 s).
   * @param {{ offsets?: number[], sets?: number, timeoutMs?: number, keyWaitMs?: number, sink: (frame: VideoFrame, meta: object) => void, signal?: AbortSignal }} opts
   */
  grabAfterKey({ offsets = [6, 12, 18, 24], sets = 2, timeoutMs, keyWaitMs = LONG_GOP_WAIT_MS, sink, signal } = {}) {
    if (typeof sink !== 'function') return Promise.reject(new Error('grabAfterKey needs a sink'))
    if (this.closed) return Promise.reject(new Error('closed'))
    if (this.gop) return Promise.reject(new Error('a measurement is already running'))
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
    const step = offsets.length > 1 ? offsets[1] - offsets[0] : 6
    return new Promise((resolve, reject) => {
      const g = {
        offsets,
        sets,
        sink,
        resolve,
        reject,
        signal,
        gopMs: this.keyIntervalMs(),
        step,
        span: offsets[offsets.length - 1] - offsets[0] + step, // frames one set covers
        fps: this.stats.fps || 20,
        set: -1, // -1 while waiting for the first keyframe
        taken: [],
        got: 0, // offsets taken in this set since its keyframe
        mode: 'keys', // 'free': at fixed frame counts, not at keyframes
        waitNext: false, // a set is done, the interval unknown: waiting for the next keyframe
        targets: null, // free mode: [{ set, at }] frame counts still to take
        frameNo: 0,
        aligned: true,
        timer: null,
        hard: null
      }
      g.onAbort = () => this.#gopEnd('cancelled')
      signal?.addEventListener('abort', g.onAbort)
      this.gop = g
      if (timeoutMs !== undefined) g.hard = setTimeout(() => this.#gopEnd('timeout'), timeoutMs)
      // the next keyframe comes within one interval; rare or unknown ones: wait up to 12 s
      this.#gopArm(this.#shortGop() ? 2 * g.gopMs + 2000 : keyWaitMs)
    })
  }

  #shortGop() {
    const ms = this.gop.gopMs
    return ms !== null && ms <= LONG_GOP_MS
  }

  #gopArm(ms) {
    const g = this.gop
    clearTimeout(g.timer)
    g.timer = setTimeout(() => this.#gopTimeout(), ms)
  }

  #gopTimeout() {
    const g = this.gop
    if (!g) return
    // no keyframe came (or none that could start a set): take the frames from here on
    if (g.mode === 'keys' && g.taken.every((t) => t.length === 0)) {
      g.aligned = false
      this.#gopFree(0, 1)
      return
    }
    // the next keyframe did not come soon: the remaining sets from here (sinceKey still counts)
    if (g.mode === 'keys' && g.waitNext) {
      g.waitNext = false
      this.#gopFree(g.set + 1, 1)
      return
    }
    this.#gopEnd('timeout')
  }

  /** Sets `from`.. at fixed frame counts, the first `lead` frames from now, `step` apart. */
  #gopFree(from, lead) {
    const g = this.gop
    g.mode = 'free'
    g.targets = []
    for (let s = from; s < g.sets; s++) for (const o of g.offsets) g.targets.push({ set: s, at: g.frameNo + lead + (s - from) * g.span + (o - g.offsets[0]) })
    while (g.taken.length < g.sets) g.taken.push([])
    this.#gopArm(((g.targets[g.targets.length - 1].at - g.frameNo) / g.fps) * 1000 + 2000)
  }

  #gopFrame(frame) {
    const g = this.gop
    g.frameNo++
    if (g.mode === 'free') {
      const t = g.targets[0]
      if (t && t.at === g.frameNo) {
        g.targets.shift()
        this.#gopTake(frame, t.set)
        if (!g.targets.length) this.#gopEnd('complete')
      }
      return
    }
    if (this.sinceKey === 0) {
      const forced = this.keyGapUs !== null && this.keyGapUs < 1_000_000
      if (g.set >= 0 && g.got < g.offsets.length && forced) {
        // an extra keyframe (asked for when a viewer connects): this set starts again after it
        // (frames already taken stay; the Measurer drops the pairs across the keyframe)
        g.got = 0
      } else {
        // a keyframe: the next set starts, or the last one is over
        if (g.set + 1 >= g.sets) return this.#gopEnd('keyframe interval shorter than the offsets')
        g.set++
        g.taken[g.set] = []
        g.got = 0
        g.waitNext = false
        g.gopMs = this.keyIntervalMs() ?? g.gopMs
        // time for this set and, with regular keyframes, the next interval's
        const frames = g.offsets[g.offsets.length - 1] + (g.sets - g.set - 1) * g.span
        this.#gopArm(this.#shortGop() ? (g.sets - g.set) * g.gopMs + 2000 : (frames / g.fps) * 1000 + 2000)
      }
    }
    if (g.set < 0 || !g.offsets.includes(this.sinceKey)) return
    this.#gopTake(frame, g.set)
    g.got++
    if (g.got < g.offsets.length) return
    if (g.set + 1 >= g.sets) return this.#gopEnd('complete')
    g.gopMs = this.keyIntervalMs() ?? g.gopMs
    if (this.#shortGop()) return this.#gopArm(g.gopMs + 2000) // the next keyframe starts the next set
    if (g.gopMs === null) {
      // interval not known yet (a stream that just started): a normal 2 s interval would put
      // +30..48 across the next keyframe, so wait a little for that keyframe instead
      g.waitNext = true
      this.#gopArm(UNKNOWN_GOP_WAIT_MS)
      return
    }
    // rare keyframes: the next set follows in this interval, not the next one
    this.#gopFree(g.set + 1, g.step)
  }

  #gopTake(frame, set) {
    const g = this.gop
    let copy
    try {
      copy = frame.clone()
    } catch {
      return
    }
    const { matrix, range } = this.displayColour(frame)
    const first = g.taken[set].length === 0
    g.taken[set].push(this.sinceKey)
    try {
      g.sink(copy, { set, sinceKey: this.sinceKey, ts: frame.timestamp, aligned: g.aligned, displayMatrix: matrix, displayRange: range, selfCheck: first })
    } catch (e) {
      copy.close()
      console.warn('grabAfterKey sink', e)
    }
  }

  #gopEnd(reason) {
    const g = this.gop
    if (!g) return
    this.gop = null
    clearTimeout(g.timer)
    clearTimeout(g.hard)
    g.signal?.removeEventListener('abort', g.onAbort)
    const frames = g.taken.reduce((a, t) => a + t.length, 0)
    if (reason === 'cancelled') return g.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
    if (reason === 'closed') return g.reject(new Error('closed'))
    if (!frames) return g.reject(new Error('no picture'))
    g.resolve({ frames, sets: g.taken, aligned: g.aligned, complete: reason === 'complete', reason, gopMs: g.gopMs ?? this.keyIntervalMs() })
  }

  /** Backing store = on-screen size (capped at the video size), same aspect as the video. */
  #fitCanvas() {
    if (!this.videoWidth) return
    const box = this.canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const scale = Math.min(1, (box.width * dpr) / this.videoWidth, (box.height * dpr) / this.videoHeight)
    const w = Math.max(2, Math.round(this.videoWidth * scale))
    const h = Math.max(2, Math.round(this.videoHeight * scale))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
  }

  #everySecond() {
    if (this.pacing) this.clock.adapt(performance.now())
    const w = this.win
    const n = w.intervals.length
    const mean = n ? w.intervals.reduce((a, b) => a + b, 0) / n : 0
    const variance = n ? w.intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0
    Object.assign(this.stats, {
      fps: w.frames,
      jitterMs: Math.round(Math.sqrt(variance) * 10) / 10,
      kbps: Math.round((w.bytes * 8) / 1000),
      delayMs: this.pacing ? this.clock.delay : 0,
      late: this.clock.lateTotal,
      resyncs: this.clock.resyncs,
      width: this.videoWidth,
      height: this.videoHeight
    })
    w.frames = 0
    w.bytes = 0
    w.intervals = []
  }

  /** Clears buffered video, e.g. before a seek or after a reconnect. */
  reset() {
    for (const { frame } of this.queue) frame.close()
    this.queue = []
    this.clock.reset()
    this.needKey = true
    if (this.held) this.held.length = 0
    this.skipTs = null
    this.stills = false
    // a measurement can't pair frames across a restart: it ends with what it has
    if (this.gop) this.#gopEnd('stream restarted')
    this.#closeDecoder()
  }

  /**
   * A seek on a running stream (server playback): like reset(), but the decoder stays: it is reset
   * and configured again with the same config (no isConfigSupported round trip), and waits for a
   * keyframe. Frames still being decoded are discarded by the decoder's reset.
   */
  seekReset() {
    for (const { frame } of this.queue) frame.close()
    this.queue = []
    this.clock.reset()
    if (this.held) this.held.length = 0
    this.skipTs = null
    this.posterShown = false
    this.seekSeq++
    if (this.gop) this.#gopEnd('stream restarted')
    // the position in the keyframe interval starts again at the next keyframe
    this.sinceKey = null
    this.lastKeyTs = null
    this.keyGapUs = null
    const d = this.decoder
    if (d && d.state !== 'closed' && this.config) {
      try {
        d.reset()
        d.configure(this.config)
      } catch (e) {
        console.warn('decoder reset failed', e)
        this.#closeDecoder()
      }
    }
    this.needKey = true
  }

  /**
   * After a seek (server playback): decoded frames before tsMs are the preroll. They are closed
   * unseen (not counted as dropped), except the first, the keyframe, which is drawn at once as a
   * poster (onPoster, not onFrame). Meanwhile the decode queue may hold MAX_PREROLL_FRAMES.
   * Ends at the first decoded frame at or after tsMs (shown as usual) or at the next (seek)reset.
   */
  skipUntil(tsMs) {
    this.skipTs = tsMs
    this.posterShown = false
  }

  /**
   * Stills (server playback in reverse and while scrubbing): each decoded frame is drawn at once
   * and reported to onFrame, without the playout clock. Turning it on closes the frames waiting
   * for display and ends a preroll skip (skipUntil), even when stills are on already: reverse and
   * scrubbing never skip, and their keyframes are older than a 1x start's `at` (a start that
   * finished before the socket's {speed:-4} arrived). Turning it off lets the clock anchor afresh.
   */
  setStills(on) {
    on = Boolean(on)
    if (on) this.skipTs = null
    if (on === this.stills) return
    this.stills = on
    if (on) {
      for (const { frame } of this.queue) frame.close()
      this.queue = []
    } else {
      this.clock.anchor = null
    }
  }

  #closeDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    this.decoder = null
    this.codecId = null
    this.sinceKey = null
    this.lastKeyTs = null
    this.keyGapUs = null
  }

  close() {
    this.closed = true
    active.delete(this)
    clearInterval(this.statsTimer)
    this.resizeObserver.disconnect()
    for (const w of this.grabs.splice(0)) {
      clearTimeout(w.timer)
      w.reject(new Error('closed'))
    }
    if (this.gop) this.#gopEnd('closed')
    this.onChunk = null
    this.reset()
  }
}
