// One live camera stream from one NVR, shared by every browser watching it.
//
// Frames are passed through exactly as the camera encoded them (no transcoding).
// All SDK calls have time limits (sdk.mjs). Sub streams start through the NVR's
// lane; main streams, which open an extra NVR connection, go through the
// process-wide connect lane instead. A stream that stops delivering video is
// restarted in place: viewers stay connected (they wait for the next keyframe),
// and repeated restarts back off. While the NVR is cooling down after late calls
// (sdk.mjs nvrCooling), starts wait instead of adding calls to a slow NVR.
import { CAP_BYTES, gateSend } from './backpressure.mjs'
import { PRIORITY, connectLane } from './lanes.mjs'
import { CODEC_H264, FRAME_TYPE_VIDEO, FRAME_TYPE_VIDEO_FORMAT, NET_SDK, codecOf, encodeFrame, lastError, liveFrames, nvrCooling, sdkCallT } from './sdk.mjs'

const MAX_GOP_FRAMES = 400 // frames kept since the last keyframe, so new viewers start instantly
// slow sockets: nothing is sent over the cap (1 MB sub, 4 MB main), see backpressure.mjs
// keep a stream open a while after the last viewer leaves, so switching between grid and
// full screen does not stop and restart dozens of streams
const STOP_DELAY_MS = { 0: 10_000, 1: 30_000 }
// a playing stream with no video for this long is stalled; cameras have ~11 s outages that end by
// themselves, and a restart just before the video returns only makes the gap longer. The live
// worker (nvr-worker.mjs -> nvrs.mjs) runs the same LiveStream, so it uses this too.
// (tests with the fake SDK only: CCTV_TEST_STALL_MS shortens it)
export const STALL_MS = (process.env.CCTV_WORKER_FAKE_SDK === '1' && Number(process.env.CCTV_TEST_STALL_MS)) || 15_000
const RESTART_BACKOFF_MS = [5000, 15_000, 60_000]
const HEALTHY_MS = 60_000 // this long without problems resets the back-off
// ask the NVR for a keyframe only if none arrived this soon after start; main streams (full
// screen, where someone is waiting for the picture) ask straight away
const KEYFRAME_WAIT_MS = { 0: 0, 1: 1500 }
const KEYFRAME_EVERY_MS = 5000 // at most one keyframe request per stream per this
const BUSY_RETRY_MS = 5000 // retry delay while the NVR has calls stuck in the SDK or is cooling down
// a start refused this fast is the NVR saying no (stream limit, no permission, camera offline),
// not a slow network: lastFailure.fast (the recorder then backs off for minutes)
const FAST_REFUSAL_MS = 1000
// a valid handle that sends no video this long after the start: the NVR refused it silently
// (nvr-2 does this at its stream limit); treated as a fast refusal
export const FIRST_FRAME_MS = (process.env.CCTV_WORKER_FAKE_SDK === '1' && Number(process.env.CCTV_TEST_FIRST_FRAME_MS)) || 8000

export class LiveStream {
  /**
   * @param {import('./nvrs.mjs').Nvr} nvr
   * @param {number} ch
   * @param {number} streamType 0 = main, 1 = sub
   */
  constructor(nvr, ch, streamType) {
    this.nvr = nvr
    this.key = `${ch}:${streamType}`
    this.label = `${nvr.id}/${ch + 1}:${streamType ? 'sub' : 'main'}`
    // live calls on one camera (main and sub, from any stream object) never overlap in the SDK
    this.exclusive = `${nvr.id}/${ch}`
    this.ch = ch
    this.streamType = streamType
    this.clients = new Set()
    this.gop = []
    this.codec = CODEC_H264
    this.state = 'starting' // starting | playing | restarting | stopped
    this.handle = 0
    this.nativeStarting = false // a LivePlay is still running inside the SDK (even after its timeout)
    this.op = Promise.resolve() // the start or stop in progress
    this.lastFrameAt = 0
    this.lastKeyAt = 0
    this.playingSince = 0
    this.restarts = 0
    this.stopTimer = null
    this.retryTimer = null
    this.keyTimer = null
    this.lastKeyframeAsk = 0
    this.firstFrameTimer = null
    this.gotVideo = false
    this.lastFailure = null // { at, ms, fast, silent?, reason } of the last failed start (recorder.mjs)
    this.onFrame = this.#onFrame.bind(this)
    this.op = this.#start()
  }

  get stopped() {
    return this.state === 'stopped'
  }

  /** Playing, but no video for a while. Streams still starting are the watchdog's business, not a stall. */
  get stalled() {
    return this.state === 'playing' && Date.now() - this.lastFrameAt > STALL_MS
  }

  async #start() {
    this.state = 'starting'
    const nvr = this.nvr
    const info = { lChannel: this.ch, streamType: this.streamType, hPlayWnd: null, bNoDecode: 1 }
    this.nativeStarting = true
    let cooling = false
    let notTried = false // not logged in: never reached the SDK, so not a refusal
    const call = () => {
      // queued behind other work: the stream may have been stopped meanwhile
      if (this.stopped || nvr.userId < 0) {
        this.nativeStarting = false
        notTried = true
        return Promise.resolve(-1)
      }
      // checked when its turn comes (first starts and restarts, main and sub): calls to this NVR
      // are stuck in the SDK or just came back late, so don't add one; retried below
      if (nvrCooling(nvr.id)) {
        cooling = true
        this.nativeStarting = false
        return Promise.resolve(-1)
      }
      return sdkCallT(
        {
          nvr: nvr.id,
          tag: this.label,
          exclusive: this.exclusive,
          // LivePlay returned after we gave up on it: stop that orphan stream, and count the
          // start as finished only once that stop has returned (a restart waits for it)
          onLate: (h) => {
            if (h > 0) this.#stopHandle(h, 'late start').finally(() => (this.nativeStarting = false))
            else this.nativeStarting = false
          }
        },
        NET_SDK.LivePlay, nvr.userId, info, liveFrames.callback, null
      ).then(
        (h) => {
          this.nativeStarting = false
          return h
        },
        (e) => {
          // a timeout leaves the native call running; onLate clears the flag when it returns
          if (e?.name !== 'SdkTimeout') this.nativeStarting = false
          throw e
        }
      )
    }
    let callStart = 0
    let callError = null
    const timed = () => {
      callStart = Date.now()
      return call()
    }
    const handle = await (this.streamType === 0
      ? connectLane.run(timed) // opens a new NVR connection: one at a time, process-wide
      : nvr.lane.run(timed, { priority: PRIORITY.NORMAL })
    ).catch((e) => {
      callError = e
      return -1
    })
    if (this.stopped) {
      if (handle > 0) await this.#stopHandle(handle, 'stopped while starting')
      return
    }
    // held back, not failed: no back-off step, no failure count
    if (cooling) return this.#scheduleRestart(BUSY_RETRY_MS)
    if (handle <= 0) {
      const ms = callStart ? Date.now() - callStart : 0
      const fast = Boolean(callStart) && !callError && !notTried && ms < FAST_REFUSAL_MS
      // the SDK's last error, as a hint only (it may be per thread)
      const why = callError ? callError.message : await lastError().catch(() => 'no error code')
      this.lastFailure = { at: Date.now(), ms, fast, reason: `${fast ? `refused in ${ms} ms` : `failed after ${ms} ms`}: ${why}` }
      if (this.stopped) return
      console.log(`stream ${this.label} failed to start (${this.lastFailure.reason})`)
      nvr.liveFailed(this).catch((e) => console.warn(`[${nvr.id}] live failure check: ${e.message}`))
      this.#scheduleRestart()
      return
    }
    this.handle = handle
    this.lastFrameAt = Date.now()
    this.playingSince = Date.now()
    this.state = 'playing'
    // viewers (kept across a restart) must not decode the new stream against old reference frames
    for (const ws of this.clients) ws.waitForKey = true
    this.gotVideo = false
    clearTimeout(this.firstFrameTimer)
    this.firstFrameTimer = setTimeout(() => {
      if (this.state !== 'playing' || this.handle !== handle || this.gotVideo) return
      this.lastFailure = { at: Date.now(), ms: FIRST_FRAME_MS, fast: true, silent: true, reason: `no video within ${FIRST_FRAME_MS / 1000} s of starting (refused by the NVR?)` }
      this.restart(this.lastFailure.reason)
    }, FIRST_FRAME_MS)
    this.firstFrameTimer.unref?.()
    liveFrames.claim(handle, this.onFrame) // delivers frames that arrived before LivePlay returned
    nvr.liveStarted()
    console.log(`stream ${this.label} started`)
    clearTimeout(this.keyTimer)
    this.keyTimer = setTimeout(() => {
      if (this.clients.size && this.gop.length === 0) this.#askKeyframe()
    }, KEYFRAME_WAIT_MS[this.streamType] ?? 1500)
  }

  #onFrame(info, buf) {
    if (this.stopped) return
    if (info.frameType === FRAME_TYPE_VIDEO_FORMAT) {
      this.codec = codecOf(info, buf)
      return
    }
    if (info.frameType !== FRAME_TYPE_VIDEO || info.length === 0) return
    const now = Date.now()
    this.lastFrameAt = now
    this.gotVideo = true
    if (this.restarts && now - this.playingSince > HEALTHY_MS) this.restarts = 0
    if (info.keyFrame) {
      this.lastKeyAt = now
      this.nvr.noteCodec(this.ch, this.streamType, this.codec, info.width, info.height)
    }

    const msg = encodeFrame(info, buf, this.codec)
    if (info.keyFrame) this.gop = [msg]
    else if (this.gop.length >= MAX_GOP_FRAMES) this.gop = [] // too long to replay intact: new viewers wait for a keyframe
    else if (this.gop.length > 0) this.gop.push(msg)

    for (const ws of this.clients) this.#send(ws, msg, Boolean(info.keyFrame))
  }

  // viewers: the stream type's cap (backpressure.mjs); the worker's tap to the main process and
  // the recorder's tap bring their own cap (capBytes/resumeBytes) and are never closed (stuckMs 0)
  #send(ws, msg, isKey) {
    const opts = { cap: ws.capBytes ?? CAP_BYTES[this.streamType] ?? CAP_BYTES[0], now: Date.now() }
    if (ws.resumeBytes !== undefined) opts.resume = ws.resumeBytes
    if (ws.stuckMs !== undefined) opts.stuckMs = ws.stuckMs
    if (gateSend(ws, isKey, opts)) ws.send(msg)
  }

  #askKeyframe() {
    // not while the NVR cools down: the ask would only add a call to a slow NVR
    if (this.state !== 'playing' || nvrCooling(this.nvr.id) || Date.now() - this.lastKeyframeAsk < KEYFRAME_EVERY_MS) return
    this.lastKeyframeAsk = Date.now()
    // separate calls per stream type: NET_SDK_MakeKeyFrame is main-stream only
    const fn = this.streamType === 0 ? NET_SDK.MakeKeyFrame : NET_SDK.MakeKeyFrameSub
    this.nvr.lane
      .run(() => sdkCallT({ nvr: this.nvr.id, tag: this.label }, fn, this.nvr.userId, this.ch), { priority: PRIORITY.LOW })
      .catch(() => {})
  }

  add(ws) {
    clearTimeout(this.stopTimer)
    this.stopTimer = null
    this.clients.add(ws)
    // replay the current GOP so the picture appears without waiting for the next keyframe
    if (this.gop.length > 0) for (const msg of this.gop) ws.send(msg)
    else {
      ws.waitForKey = true
      this.#askKeyframe()
    }
  }

  remove(ws) {
    this.clients.delete(ws)
    if (this.clients.size === 0 && !this.stopped) {
      clearTimeout(this.stopTimer)
      this.stopTimer = setTimeout(() => this.stop(), STOP_DELAY_MS[this.streamType] ?? 10_000)
    }
  }

  /** Stops and starts the stream again (viewers stay connected); repeated restarts back off. */
  restart(reason) {
    if (this.state !== 'playing') return this.op
    this.state = 'restarting'
    console.log(`stream ${this.label} ${reason}, restarting`)
    const old = this.handle
    this.handle = 0
    this.gop = []
    this.op = (old > 0 ? this.#stopHandle(old, reason) : Promise.resolve()).then(() => this.#scheduleRestart())
    return this.op
  }

  #scheduleRestart(delay) {
    if (this.stopped) return
    this.state = 'restarting'
    if (delay === undefined) {
      delay = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)]
      this.restarts++
    }
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      if (this.stopped) return
      // don't add calls while this NVR has calls stuck in the SDK or just back late, or our last start still runs there
      if (this.nativeStarting || nvrCooling(this.nvr.id) || this.nvr.userId < 0) return this.#scheduleRestart(BUSY_RETRY_MS)
      this.op = this.#start()
    }, delay)
  }

  #stopHandle(handle, why) {
    liveFrames.release(handle)
    return this.nvr.lane
      .run(
        () =>
          sdkCallT(
            // a stop that returns after its timeout: now the handle value may be reused
            { nvr: this.nvr.id, tag: `${this.label} stop`, exclusive: this.exclusive, onLate: () => liveFrames.forget(handle) },
            NET_SDK.StopLivePlay, handle
          ),
        { priority: PRIORITY.HIGH }
      )
      .then(
        () => {
          liveFrames.forget(handle)
          console.log(`stream ${this.label} stopped${why ? ` (${why})` : ''}`)
        },
        (e) => console.warn(`stream ${this.label} stop failed: ${e.message}`)
      )
  }

  /** Stops the stream and disconnects its viewers (their browsers reconnect). */
  fail(reason) {
    const done = this.stop()
    for (const ws of this.clients) ws.close(1011, reason)
    return done
  }

  /** Stops the stream; resolves when the SDK has stopped it (or gave up trying). */
  stop() {
    if (this.stopped) return this.op
    this.state = 'stopped'
    clearTimeout(this.stopTimer)
    clearTimeout(this.retryTimer)
    clearTimeout(this.keyTimer)
    clearTimeout(this.firstFrameTimer)
    this.nvr.streamStopped(this)
    // wait for a start or stop already in progress, then stop whatever handle it left
    this.op = this.op
      .catch(() => {})
      .then(() => {
        const handle = this.handle
        this.handle = 0
        return handle > 0 ? this.#stopHandle(handle) : undefined
      })
    return this.op
  }
}
