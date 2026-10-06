// One live camera stream from one NVR, shared by every browser watching it.
//
// Frames are passed through exactly as the camera encoded them (no transcoding).
// All SDK calls have time limits (sdk.mjs). Sub streams start through the NVR's
// lane; main streams, which open an extra NVR connection, go through the
// process-wide connect lane instead. A stream that stops delivering video is
// restarted in place: viewers stay connected (they wait for the next keyframe),
// and repeated restarts back off. While the NVR is cooling down after late calls
// (sdk.mjs nvrCooling), starts wait instead of adding calls to a slow NVR -- except
// the recorder's, once none of that NVR's calls is still inside the SDK late.
// Inside an NVR's worker, viewers' starts are paced (live-pacer.mjs); a stream nobody
// wants any more is stopped through the NVR's idle-stop queue (idle-stops.mjs).
import { CAP_BYTES, gateSend } from './backpressure.mjs'
import { replayGop } from './gop-replay.mjs'
import { idleStopQueue } from './idle-stops.mjs'
import { liveStartTimeoutMs } from './live-start-policy.mjs'
import { PRIORITY, RANK, connectLane } from './lanes.mjs'
import { PACE, livePacer } from './live-pacer.mjs'
import { CODEC_H264, FRAME_TYPE_VIDEO, FRAME_TYPE_VIDEO_FORMAT, NET_SDK, codecOf, encodeFrame, errorText, lastErrorCode, lastLateReturnAt, lateCalls, liveCallsInFlight, liveFrames, nvrCooling, onCallSettled, sdkCallT } from './sdk.mjs'

const MAX_GOP_FRAMES = 400 // frames kept since the last keyframe, so new viewers start instantly
// slow sockets: nothing is sent over the cap (1 MB sub, 4 MB main), see backpressure.mjs
// keep a stream open a while after the last viewer leaves, so switching between grid and
// full screen does not stop and restart dozens of streams
// A sub-stream (what every grid shows) is kept running for a while after its last viewer leaves, so
// coming back to Live, paging, or closing a full-size view shows the picture at once instead of
// waiting for the NVR to start the stream again (CCTV_SUB_LINGER_S, 180 by default). Sub-streams
// are small; the main stream, the heavy one, still stops after 10 s.
const SUB_LINGER_MS = (() => { const n = Number(process.env.CCTV_SUB_LINGER_S); return (Number.isFinite(n) && n >= 0 ? n : 180) * 1000 })()
const STOP_DELAY_MS = { 0: 10_000, 1: SUB_LINGER_MS }
// a playing stream with no video for this long is stalled; cameras have ~11 s outages that end by
// themselves, and a restart just before the video returns only makes the gap longer. The live
// worker (nvr-worker.mjs -> nvrs.mjs) runs the same LiveStream, so it uses this too.
// (tests with the fake SDK only: CCTV_TEST_STALL_MS shortens it)
export const STALL_MS = (process.env.CCTV_WORKER_FAKE_SDK === '1' && Number(process.env.CCTV_TEST_STALL_MS)) || 15_000
const RESTART_BACKOFF_MS = [5000, 15_000, 60_000]
const HEALTHY_MS = 60_000 // this long without problems resets the back-off
// ask the NVR for a keyframe only if none arrived this soon after start; main streams (full
// screen, where someone is waiting for the picture) ask straight away
// How long to wait for a keyframe to turn up by itself before asking the NVR for one. Nothing can
// be shown until a keyframe arrives, so this is dead time in front of every picture. The main
// stream asks at once; the sub stream used to wait 1.5 s, which is most of the delay people feel
// when a grid of tiles opens. 250 ms still lets a keyframe that is already on its way win, so the
// NVR is not asked needlessly, without the wait being noticeable.
const KEYFRAME_WAIT_MS = { 0: 0, 1: 1500 }
const KEYFRAME_EVERY_MS = 5000 // at most one keyframe request per stream per this
const BUSY_RETRY_MS = 5000 // retry delay while the NVR has calls stuck in the SDK or is cooling down
// a start refused this fast is the NVR saying no (stream limit, no permission, camera offline),
// not a slow network: lastFailure.fast (the recorder then backs off for minutes)
const FAST_REFUSAL_MS = 1000
// ...but not SDK error 9, "not connected": the NVR has not said anything, the SDK is making the
// link it dropped again (20-60 s; the next stream of that NVR started a median 27.7 s later). Taken
// as a refusal it cost 5-10 minutes of recording per camera: 42 times in 63.5 h (27-29 Sep 2026),
// 43 of 44 within 21 s of a link drop, 15,546 camera-seconds not recorded. Not fast: the recorder
// keeps the camera and the stream's own restart steps try it again (RESTART_BACKOFF_MS: after a
// stall's restart, 15 s and then 60 s later).
// (8, "cannot connect", stays a refusal: value4u at its sub-stream limit, sub-cap.mjs.)
const LINK_DOWN_ERROR = 9
// a valid handle that sends no video this long after the start: the NVR refused it silently
// (nvr-2 does this at its stream limit); treated as a fast refusal
export const FIRST_FRAME_MS = (process.env.CCTV_WORKER_FAKE_SDK === '1' && Number(process.env.CCTV_TEST_FIRST_FRAME_MS)) || 8000
// A P2P main stream (full screen) is the heavy one -- a big-sensor H.265 picture pulled over a cloud
// relay -- and its first keyframe can take longer than the 8 s above to arrive when the tunnel is
// busy, tripping the watchdog and restarting a stream that was about to play (seen on site-3, 5 MP
// over NAT 1.0). Give that case a wider window; the sub stream and LAN main keep the 8 s default.
export const FIRST_FRAME_P2P_MAIN_MS = (process.env.CCTV_WORKER_FAKE_SDK === '1' && Number(process.env.CCTV_TEST_FIRST_FRAME_MS)) || 20_000

// Viewers' starts are paced in the NVR workers, where recording shares the NVR's login with them.
// The main process without workers (CCTV_LIVE_WORKER off) starts them as it always has.
const PACED = Boolean(process.env.CCTV_WORKER_NVR)
const pacers = new Map() // NVR id -> livePacer
const idleStops = new Map() // NVR id -> idleStopQueue
const pacerFor = (id) => {
  let p = pacers.get(id)
  if (!p) pacers.set(id, (p = livePacer({ liveInFlight: () => liveCallsInFlight(id), lateNow: () => lateCalls(id), lateAt: () => lastLateReturnAt(id) })))
  return p
}
const idleStopsFor = (id) => {
  let q = idleStops.get(id)
  if (!q) idleStops.set(id, (q = idleStopQueue({ busy: () => liveCallsInFlight(id) > 0 })))
  return q
}
// a call that returns may be what a paced start or an idle stop is waiting for. The pacers look a
// moment later (setImmediate): a start whose LivePlay just returned first tells its pacer how long it
// took and lets go of its turn (#start, in the microtasks after this), so the next start does not go
// by the old reading
let pacerKick = null
onCallSettled(() => {
  for (const q of idleStops.values()) q.kick()
  if (pacerKick !== null || pacers.size === 0) return
  pacerKick = setImmediate(() => {
    pacerKick = null
    for (const p of pacers.values()) p.kick()
  })
})

const resetLoggedAt = new Map() // NVR id -> when the hold was last logged
/**
 * The NVR dropped its links (the worker's SDK printed so; worker-supervisor.mjs, MSG.LINKRESET):
 * viewers' and warm-ups' new starts on it wait PACE.RESET_HOLD_MS while the SDK reconnects its
 * links (live-pacer.mjs); the recorder's go on. Outside an NVR's worker nothing is paced: nothing to hold.
 */
export const linkReset = (nvrId, at = Date.now()) => {
  if (!PACED) return
  const logged = resetLoggedAt.get(nvrId) ?? -Infinity
  if (at - logged >= PACE.RESET_HOLD_MS) {
    resetLoggedAt.set(nvrId, at)
    console.warn(`[${nvrId}] the NVR dropped its links: viewers' new streams on it wait ${PACE.RESET_HOLD_MS / 1000} s`)
  }
  pacerFor(nvrId).linkReset(at)
}

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
    this.lastFailure = null // { at, ms, fast, code?, silent?, reason } of the last failed start (recorder.mjs)
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

  /** The recorder writes this stream (its tap, recorder.mjs, is one of the clients). */
  get recorded() {
    for (const c of this.clients) if (c.recorder === true) return true
    return false
  }

  /** Its place in the lanes (lanes.mjs RANK): the recorder's first, then a viewer's, then background work. */
  rank() {
    let r = RANK.BACKGROUND
    for (const c of this.clients) {
      if (c.recorder === true) return RANK.RECORDER
      if (!c.background) r = RANK.VIEWER
    }
    return r
  }

  /**
   * Whether the NVR's cool-down holds this start back (calls to it are stuck in the SDK or just came
   * back late). The recorder's stream is held only while one of those calls is still inside the SDK:
   * a viewer's LivePlay that came back late (03:14:14, 03:50:51, 04:10:26 ...) held every recording
   * restart on that NVR for a minute.
   */
  #coolingHolds() {
    if (!nvrCooling(this.nvr.id)) return false
    return !this.recorded || lateCalls(this.nvr.id) > 0
  }

  async #start() {
    this.state = 'starting'
    const nvr = this.nvr
    // A P2P NVR caps how many streams it will serve at once (and the tunnel its bandwidth): with a
    // grid's worth of sub-streams open it refuses a main stream outright ("cannot connect"). Those
    // subs have no viewer once a full-size view is open -- they only linger (SUB_LINGER_MS) for a
    // quick return to the grid -- yet they held the NVR's slots for ~3 minutes, which is why the
    // main (full screen) took that long to appear. Free the viewer-less ones now so the main gets a
    // slot; they reconnect when the grid comes back. Through the idle-stop queue, which paces stops
    // one at a time (several stops together inside the SDK once corrupted its heap).
    if (this.streamType === 0 && nvr.cfg?.sn) this.#freeIdleSubs()
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
      if (this.#coolingHolds()) {
        cooling = true
        this.nativeStarting = false
        return Promise.resolve(-1)
      }
      return sdkCallT(
        {
          nvr: nvr.id,
          tag: this.label,
          exclusive: this.exclusive,
          timeoutMs: liveStartTimeoutMs(this.streamType, nvr.cfg?.sn),
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
    // the recorder's stream first, then one someone is waiting to see, then warm-ups (lanes.mjs RANK)
    const rank = () => this.rank()
    const timed = () => {
      callStart = Date.now()
      return call()
    }
    // a viewer's or a warm-up's start waits its turn on this NVR first (live-pacer.mjs); the
    // recorder's never does, nor one the cool-down holds anyway (it is only put off below)
    let paced = null
    if (PACED && rank() !== RANK.RECORDER && !this.#coolingHolds()) {
      paced = await pacerFor(nvr.id).wait({ rank, cancelled: () => this.stopped, bypass: () => rank() === RANK.RECORDER })
    }
    const handle = await (this.streamType === 0
      ? connectLane.run(timed, { rank }) // opens a new NVR connection: one at a time, process-wide
      : nvr.lane.run(timed, { priority: PRIORITY.NORMAL, rank })
    )
      .catch((e) => {
        callError = e
        return -1
      })
      .finally(() => {
        // how quickly this NVR answers a LivePlay now (anyone's): the pacer's gap and its "slow",
        // learnt before this start lets go of its turn. The other way round, the next start went by
        // the old reading: a LivePlay back after 8 s let another go next to one still in flight
        if (PACED && callStart && !cooling && !notTried) pacerFor(nvr.id).played(Date.now() - callStart)
        paced?.()
      })
    if (this.stopped) {
      if (handle > 0) await this.#stopHandle(handle, 'stopped while starting')
      return
    }
    // held back, not failed: no back-off step, no failure count
    if (cooling) return this.#scheduleRestart(BUSY_RETRY_MS)
    if (handle <= 0) {
      const ms = callStart ? Date.now() - callStart : 0
      // the SDK's last error, as a hint only (it may be per thread); its code too, for a start that
      // reached the NVR (8, "cannot connect": value4u at its sub-stream limit, sub-cap.mjs). Read
      // before `fast` is decided: a dropped link (LINK_DOWN_ERROR) is not a refusal
      const code = callError || notTried ? null : await lastErrorCode()
      const fast = Boolean(callStart) && !callError && !notTried && ms < FAST_REFUSAL_MS && code !== LINK_DOWN_ERROR
      const why = callError ? callError.message : errorText(code)
      this.lastFailure = { at: Date.now(), ms, fast, code, reason: `${fast ? `refused in ${ms} ms` : `failed after ${ms} ms`}: ${why}` }
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
    const firstFrameMs = this.streamType === 0 && this.nvr.cfg?.sn ? FIRST_FRAME_P2P_MAIN_MS : FIRST_FRAME_MS
    this.firstFrameTimer = setTimeout(() => {
      if (this.state !== 'playing' || this.handle !== handle || this.gotVideo) return
      this.lastFailure = { at: Date.now(), ms: firstFrameMs, fast: true, silent: true, reason: `no video within ${firstFrameMs / 1000} s of starting (refused by the NVR?)` }
      this.restart(this.lastFailure.reason)
    }, firstFrameMs)
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

  /**
   * @param {{ replay?: boolean }} [o] replay false: nothing is replayed, and the socket starts where
   *   its waitForKey says (as stream-hub.mjs HubStream.add: a socket adaptive-live.mjs moves here at
   *   this stream's keyframe)
   */
  add(ws, { replay = true } = {}) {
    clearTimeout(this.stopTimer)
    this.stopTimer = null
    idleStops.get(this.nvr.id)?.cancel(this) // wanted again: it plays on, no stop
    this.clients.add(ws)
    // the recorder's tap: a start of this stream waiting in the pacer goes now; a viewer's: ahead of warm-ups
    if (this.state === 'starting') pacers.get(this.nvr.id)?.kick()
    if (!replay) return
    // replay the current GOP so the picture appears without waiting for the next keyframe
    if (this.gop.length > 0) replayGop(this.gop, ws)
    else {
      ws.waitForKey = true
      this.#askKeyframe()
    }
  }

  remove(ws) {
    this.clients.delete(ws)
    if (this.clients.size === 0 && !this.stopped) {
      clearTimeout(this.stopTimer)
      this.stopTimer = setTimeout(() => this.stopWhenIdle(), STOP_DELAY_MS[this.streamType] ?? 10_000)
    }
  }

  /**
   * A main stream is starting on this NVR: stop its sub-streams that no viewer wants any more (they
   * are only lingering for a quick return to the grid, SUB_LINGER_MS), so their slots at the NVR free
   * up for the main. The one the full-size view borrows keeps its viewer, so it is left running.
   * Stops go through the idle-stop queue (paced; cancelled if the sub is wanted again before its turn).
   */
  #freeIdleSubs() {
    for (const s of this.nvr.streams.values()) {
      if (s !== this && s.streamType === 1 && !s.stopped && s.clients.size === 0 && s.stopTimer) s.stopWhenIdle()
    }
  }

  /**
   * Nobody wants this stream: it is stopped through its NVR's idle-stop queue (idle-stops.mjs), at
   * most one such stop a second and none next to another live call of that NVR. Wanted again before
   * its turn (add), it plays on.
   */
  stopWhenIdle() {
    clearTimeout(this.stopTimer)
    this.stopTimer = null
    if (this.stopped || this.clients.size > 0) return
    idleStopsFor(this.nvr.id).add(this)
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
      // don't add calls while this NVR has calls stuck in the SDK or just back late (the recorder's
      // stream: only while stuck), or our last start still runs there
      if (this.nativeStarting || this.#coolingHolds() || this.nvr.userId < 0) return this.#scheduleRestart(BUSY_RETRY_MS)
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
            // also one stop at a time per NVR, even after a timeout: when an NVR dropped every
            // connection, six stops left inside the SDK together corrupted its heap (SIGABRT)
            { nvr: this.nvr.id, tag: `${this.label} stop`, exclusive: [this.exclusive, `${this.nvr.id}/stops`], onLate: () => liveFrames.forget(handle) },
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
    idleStops.get(this.nvr.id)?.cancel(this)
    pacers.get(this.nvr.id)?.kick() // a start of ours waiting there leaves the queue at once
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
