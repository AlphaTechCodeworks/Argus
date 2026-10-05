// Server recording inside an NVR's live worker (CCTV_LIVE_WORKER=on). For each camera whose
// recording mode is not 'off' it adds a "tap" to the camera's main stream (nvr.getStream(ch, 0),
// the same LiveStream live viewers use: one pull from the NVR for both) and writes the frames
// with segment-writer.mjs. The parent sends the settings; the worker reports each file it starts
// ({t:'segopen'}: playback can read it while it grows), each finished segment ({t:'segment'})
// and each stretch it could not record ({t:'recgap'}).
//
//   parent -> worker: { t: 'settings', recording: settings.recording, locations: [{id, path, role}] }
//                     locations: the healthy ones (storage.mjs), best first
//   worker -> parent: { t: 'segopen', nvr, ch, path, startMs, loc }   (both files created)
//                     { t: 'segment', nvr, ch, path, startMs, endMs, bytes, keyframes, loc }
//                     { t: 'recgap', nvr, ch, fromMs, toMs, reason }
//
// Only 'continuous' exists in this phase: motion/AI modes record continuously (logged once)
// until events arrive in phase 3. Times are this server's clock (UTC ms) when the frame arrived.
//
// Nothing here waits for a disk: the tap's send() (called in the SDK frame fan-out, next to the
// live viewers) only hands the frame to the camera's SegmentWriter queue. A disk too slow for
// it (over 8 MB or 10 s behind) makes the writer drop frames: reported as a recgap
// "disk too slow", recording resumes at a keyframe once the queue has caught up.
import { MAIN, REFUSALS_BEFORE_SUB, SUB, afterRefusal, afterVideo, chooseStream, degradedNote } from './stream-choice.mjs'
import { SegmentWriter, rollOffsetFor } from './segment-writer.mjs'
// The event modes' decision lives apart so it can be tested without a worker, an NVR or a disk.
import { shouldWrite } from './rec-modes.mjs'

const HEADER_SIZE = 16 // sdk.mjs encodeFrame: key flag, codec, size, time; then the payload
const FAILED_LOCATION_MS = 60_000 // a location a write failed on is skipped this long
// a hole this long in the recorded timeline is reported as a gap (playback's gapMs: 3 s). Stalls
// of 3-10 s used to leave no gap row, so the index could not explain them
const SILENCE_GAP_MS = 3000
const NO_VIDEO_REASON = 'no video from the NVR'
// frame times: the SDK header's capture time (us, the NVR's clock) mapped onto our clock by the
// smallest (arrival - capture) seen, i.e. the least-delayed frame. A catch-up burst after a stall
// then keeps its real spacing instead of being squeezed into a few ms. The offset may creep up
// this much per ms of capture time (clock rate difference), and is reset to the arrival time when the
// header time is 0, goes backwards or jumps too far, or when the mapped time lags arrival by more
// than MAX_LAG_MS for LAG_HOLD_MS on end (or by over MAX_BACKLOG_MS at all). A lag that comes and
// goes is the NVR catching up with what it buffered in a dropout (~11 s on Cashier Front): those
// frames keep their capture times. A lag that stays is a clock problem or a backlog that never clears.
const CLOCK_CREEP = 0.001
const MAX_LAG_MS = 5000
const LAG_HOLD_MS = 30_000
const MAX_BACKLOG_MS = 120_000
const MAX_HDR_STEP_MS = 60_000 // a header jump bigger than this is not trusted (NVR clock set)
// a stream the NVR refuses (LiveStream.lastFailure.fast: refused within 1 s, or no video within
// 8 s of a valid handle) is left alone this long (random in the range, so cameras spread out)
const REFUSED_BACKOFF_MS = [5 * 60_000, 10 * 60_000]
// ...except just after the recorder starts: an NVR still holding the connections of the process
// that just restarted refuses the same streams for a minute or so (nvr-2, cameras 25-32, after
// every restart), and a 5-10 min wait there was a 'not recording' alert after each deploy
const STARTUP_GRACE_MS = 3 * 60_000
const STARTUP_BACKOFF_MS = [30_000, 60_000]
// A camera already set to record when the recorder started (a worker restart: crash, watchdog kill,
// deploy), and taken on within STARTUP_GRACE_MS, has a gap from the recorder's start until its first
// written frame. The parent's downtime row ends when the worker was spawned, so the login, a
// cool-down and the stream starts after it were in no row at all: about 1,982 camera-seconds after
// the 02:29:47 crash had neither footage nor a gap row.
const STARTUP_REASON = 'recording starting after a restart'
// The worker's watchdog judges it by the recording (flow(), watchdog.mjs): a camera had a frame from
// the SDK this recently (flowing), or none for this long (frozen)
const FLOW_RECENT_MS = 10_000
const FROZEN_MS = 45_000
// A main stream the NVR "serves" but only trickles -- a few frames, then several seconds of nothing,
// over and over -- looked like a working stream: every brief burst of frames made afterVideo() mark
// the camera recovered, so it recorded a full-resolution stream full of holes instead of falling back
// to the sub-stream the NVR can actually serve within its budget (nvr-2 cameras 23/30/31/32, near the
// NVR's serving ceiling, 2026-09-27). This many "no video from the NVR" gaps within the window, while
// on the main stream, counts as the NVR failing to serve it, and drops the camera to the sub-stream.
const STUTTER_WINDOW_MS = 90_000
const STUTTER_COUNT = 3
const STUTTER_REASON = 'the main stream only trickled video (repeated short gaps)'
// ...but a trickle is footage, and a sub-stream the NVR refuses is none. One refused within this long
// of such a drop sends the camera straight back to the main stream, and the sub-stream is left alone
// for a refusal's back-off (5-10 min) instead of the camera. On 29 Sep value4u refused cam 25's sub
// 7 s after its main was dropped for trickling, and the camera, still sending video, recorded nothing
// for the 513 s back-off: 525 s missing (stutter report 2.10).
const TRICKLE_SUB_MS = 60_000
// A camera already recording when its stream setting (recording.stream) changes is moved to the stream
// the setting now calls for, at most one camera per NVR this often. Setting nvr-2 to 'sub' in one go
// would otherwise stop and start ~25 streams at once on an NVR that is already struggling to serve
// them -- the reason it was set to 'sub' -- and nothing else paces it: the worker's idle-stops and
// live pacer pace the viewers' streams, and the recorder's starts are exempt from both.
const MIGRATE_EVERY_MS = 3000
// ...and the switch is over within this long: the new stream's LivePlay and first keyframe, with
// LiveStream's own limits past that (no video within 8 s is a silent refusal, which files a row of
// its own; a start that fails is tried again after 5 s). A switch's gap row never runs past it: the
// rest is filed as the NVR sending no video, as the same stretch would be without a switch. The
// worker does not drive the recorder while the NVR is logged out, so an outage that followed a
// switch only reached it when the video came back, and was one 'switching' row an hour long.
const SWITCH_MAX_MS = 30_000

export class Recorder {
  /**
   * @param {{ nvrId: string, getStream: (ch: number) => {add, remove, clients}, online: () => boolean,
   *           channels: () => number[], send: (m: object) => void, now?: () => number,
   *           writerOpts?: object }} opts  writerOpts: extra SegmentWriter options (tests: a slow fs)
   */
  constructor({ nvrId, getStream, online, channels, send, now = Date.now, writerOpts = {} }) {
    this.nvrId = nvrId
    this.getStream = getStream
    this.online = online
    this.channels = channels
    this.send = send
    this.now = now
    this.startedAt = now()
    this.writerOpts = writerOpts
    this.writers = new Set() // every writer with work outstanding (also ones being closed)
    this.recording = null
    this.firstRecording = null // the first settings received: which cameras were recording before a restart
    this.locations = []
    this.cams = new Map() // ch -> cam
    this.takenOn = new Set() // every channel this recorder has had a camera for (a restart's ramp-up is only the first)
    this.failed = new Map() // location id -> { at, reason }
    this.noted = new Set()
    // Event-driven recording (phase 7): the parent sends the stretches each event-mode camera
    // should be writing, worked out from the events in the recordings database and the pre/post
    // seconds in settings. Until a message arrives, and whenever the last one is too old to trust,
    // an event-mode camera records continuously — see rec-modes.mjs for why.
    this.windows = new Map() // ch -> [[startMs, endMs]]
    this.windowsAt = null // when the parent last sent them
    this.migratedAt = -Infinity // when a camera last moved to another stream for its setting (#migrate)
  }

  /**
   * New event windows from the parent: { windows: { "<ch>": [[s, e]] }, at }.
   * Replaces what was there rather than merging, because the parent's list is the whole truth about
   * what that camera should be recording right now.
   */
  applyEvents({ windows, at } = {}) {
    if (!windows || typeof windows !== 'object') return
    this.windows = new Map(Object.entries(windows).map(([ch, w]) => [Number(ch), Array.isArray(w) ? w : []]))
    this.windowsAt = Number.isFinite(Number(at)) ? Number(at) : this.now()
  }

  /** Whether this camera should be writing at frame time `ts`, and the sentence explaining it. */
  #gate(cam, ts, nowMs) {
    return shouldWrite({
      mode: cam.mode,
      windows: this.windows.get(cam.ch) ?? [],
      feedAt: this.windowsAt,
      ts,
      nowMs
    })
  }

  /**
   * Whether a camera the NVR refuses may fall back to its sub-stream. On by default: reduced
   * quality is worth having and nothing is not. `recording.subFallback: false` turns it off for
   * an owner who would rather have a clean gap than footage at a lower resolution.
   */
  allowSubFallback() {
    return this.recording?.subFallback !== false
  }

  /** Cameras recording less than they should be, for the Health page. */
  degraded() {
    const now = this.now()
    const out = []
    for (const [ch, cam] of this.cams) {
      // only "auto" cameras can be degraded (a fallback); one set to record the sub-stream is not
      const note = this.#streamPref(ch) === 'auto' ? degradedNote(cam.pick, now) : null
      if (note) out.push({ nvr: this.nvrId, ch, note, since: cam.pick.subSince })
    }
    return out
  }

  /** New settings from the parent. */
  apply({ recording, locations } = {}) {
    this.recording = recording ?? null
    if (!this.firstRecording && this.recording?.defaults) this.firstRecording = this.recording
    this.locations = Array.isArray(locations) ? locations.filter((l) => l && typeof l.path === 'string') : []
    // a location the parent (re)confirms as healthy gets another chance
    for (const id of this.failed.keys()) if (!this.locations.some((l) => l.id === id)) this.failed.delete(id)
    this.sync()
  }

  /**
   * Which channels record now (ch -> { mode, locationId, online }). channels() gives numbers (all
   * online) or { ch, online }. An offline or empty slot is not taken up; a camera already
   * recording that goes offline stays (online false: detached, 'camera offline' gap).
   */
  wanted() {
    const r = this.recording
    if (!r?.defaults) return new Map()
    const prefix = `${this.nvrId}/`
    const known = new Map()
    for (const c of this.channels()) {
      if (typeof c === 'number') known.set(c, true)
      else if (c && Number.isInteger(c.ch)) known.set(c.ch, c.online !== false)
    }
    const chans = new Set(known.keys())
    for (const k of Object.keys(r.cameras ?? {})) if (k.startsWith(prefix)) chans.add(Number(k.slice(prefix.length)))
    const out = new Map()
    for (const ch of chans) {
      if (!Number.isInteger(ch) || ch < 0) continue
      // (no camera list at all, e.g. the NVR did not give one: cameras set up by hand are tried as before)
      const online = known.size === 0 ? true : known.get(ch) === true
      if (!online && !this.cams.has(ch)) continue // offline or not on the NVR: nothing to record yet
      const o = r.cameras?.[`${prefix}${ch}`] ?? {}
      const mode = o.mode ?? r.defaults.mode
      if (!mode || mode === 'off') continue
      if (mode !== 'continuous' && !this.noted.has(`${ch}:${mode}`)) {
        this.noted.add(`${ch}:${mode}`)
        console.log(`[rec ${this.nvrId}/${ch + 1}] mode ${mode}: recording only inside event windows, and continuously whenever the event feed is not fresh (rec-modes.mjs)`)
      }
      out.set(ch, { mode, locationId: o.locationId ?? null, online })
    }
    return out
  }

  /** Starts/stops cameras to match the settings; (re)attaches taps whose stream went away. */
  sync() {
    const want = this.wanted()
    for (const [ch, cam] of this.cams) if (!want.has(ch)) this.#stopCam(ch, cam)
    for (const [ch, w] of want) {
      let cam = this.cams.get(ch)
      if (!cam) {
        const now = this.now()
        // (trickleAt: when a trickling main last dropped it to the sub; subRefusedUntil: that sub-stream,
        // refused just after, is left alone until then: TRICKLE_SUB_MS)
        cam = { ch, tap: null, stream: null, writer: null, loc: null, locationId: w.locationId, gap: null, lastAt: 0, lastTs: 0, clk: null, waitKey: false, lastError: null, camOnline: true, attachedAt: 0, refusedUntil: 0, pick: { refusals: 0, onSub: false, subSince: 0, lastRefusedAt: 0 }, wantType: MAIN, bySetting: false, createdAt: now, frameAt: 0, stutterAt: [], trickleAt: 0, subRefusedUntil: 0 }
        cam.tap = this.#tapFor(cam)
        this.cams.set(ch, cam)
        // recording before the restart (on in the first settings), back now: not recorded from the
        // recorder's start until its first frame is written (a ramp-up under SILENCE_GAP_MS leaves no row).
        // Only the first time: a camera turned off and on again soon after has recorded since the start,
        // and was off by choice meanwhile
        if (now - this.startedAt < STARTUP_GRACE_MS && !this.takenOn.has(ch) && this.#onAtStart(ch)) cam.gap = { fromMs: this.startedAt, reason: STARTUP_REASON, startup: true }
        this.takenOn.add(ch)
        console.log(`[rec ${this.nvrId}/${ch + 1}] recording on`)
      }
      cam.locationId = w.locationId
      cam.mode = w.mode // the event gate needs to know whether this camera records on events
      if (!w.online && cam.camOnline) {
        // the NVR reports the camera offline: let go of its stream (no retries against a dead
        // camera); the time until it is back is a 'camera offline' gap
        cam.camOnline = false
        this.#detach(cam)
        this.#gapFrom(cam, 'camera offline')
        console.log(`[rec ${this.nvrId}/${ch + 1}] camera offline: waiting for it to come back`)
      } else if (w.online && !cam.camOnline) {
        cam.camOnline = true
        console.log(`[rec ${this.nvrId}/${ch + 1}] camera back online`)
      }
      const best = this.#pickLocation(cam)
      if (best?.id !== cam.loc?.id) this.#switchTo(cam, best)
      this.attach(cam)
    }
  }

  attach(cam) {
    if (!this.online() || !cam.camOnline) return
    const now = this.now()
    if (cam.stream && (cam.stream.stopped || !cam.stream.clients.has(cam.tap))) cam.stream = null
    // the NVR refused this stream (at once, or a handle that never sent video: nvr-2 refuses
    // silently): leave it alone for 5-10 minutes rather than asking every minute
    const f = cam.stream?.lastFailure
    if (f?.fast && f.at >= cam.attachedAt) {
      this.#detach(cam)
      cam.pick = afterRefusal(cam.pick, now)
      // Is there a cheaper stream to fall back on? An NVR at its bandwidth ceiling refuses the
      // main stream for ever, and the old behaviour was to keep asking every few minutes and
      // record nothing in between -- which is how eleven of nvr-2's cameras came to be online,
      // green on every page, and writing no footage at all.
      const next = chooseStream(cam.pick, now, { allowSub: this.allowSubFallback(), prefer: this.#streamPref(cam.ch) })
      // Dropping is the step from the main stream down to the sub. A refusal of the sub-stream it
      // asked for is not one: nothing cheaper is left, so it waits out the backoff like any refusal.
      // (Told by pick.onSub, every refusal under 'sub' was a drop -- a written frame there resets
      // onSub -- so the refused sub was asked for again at the next tick, and LiveStream restarted it
      // about once a minute for as long as the NVR said no, with a warning each time.)
      const dropping = next.type === SUB && cam.wantType !== SUB
      // the sub-stream a main that only trickled dropped it to a moment ago (TRICKLE_SUB_MS): back to that main
      const backToMain = cam.wantType === SUB && cam.trickleAt > 0 && now - cam.trickleAt <= TRICKLE_SUB_MS && this.#streamPref(cam.ch) === 'auto' && !cam.bySetting
      const reason = `refused by the NVR (${f.reason || 'no reason given'})`
      cam.lastError = { at: now, loc: cam.loc?.id ?? null, reason }
      this.#gapFrom(cam, reason)
      const [lo, hi] = now - this.startedAt < STARTUP_GRACE_MS ? STARTUP_BACKOFF_MS : REFUSED_BACKOFF_MS
      if (dropping) {
        // Worth trying at once rather than after the backoff: every minute spent waiting is a
        // minute of footage that does not exist, and the sub-stream costs the NVR very little.
        cam.refusedUntil = 0
        console.warn(`[rec ${this.nvrId}/${cam.ch + 1}] ${reason}; ${next.why}`)
      } else if (backToMain) {
        // At once (the next tick): the sub-stream waits out the backoff, not the camera. Its pick starts
        // afresh on the main, so a refusal of that main backs off as any first refusal does, and does not
        // drop it to the sub it just lost; #noteStutter leaves the trickle alone until subRefusedUntil.
        cam.subRefusedUntil = now + lo + Math.round(Math.random() * (hi - lo))
        cam.trickleAt = 0
        cam.stutterAt = []
        cam.pick = { refusals: 0, onSub: false, subSince: 0, lastRefusedAt: 0 }
        cam.refusedUntil = 0
        console.warn(`[rec ${this.nvrId}/${cam.ch + 1}] ${reason}: the sub-stream it dropped to for a main that only trickled; back to the main stream now, the sub-stream left alone for ${Math.round((cam.subRefusedUntil - now) / 1000)} s`)
      } else {
        cam.refusedUntil = now + lo + Math.round(Math.random() * (hi - lo))
        if (!cam.refusedLogged) console.warn(`[rec ${this.nvrId}/${cam.ch + 1}] ${reason}; trying again in ${Math.round((cam.refusedUntil - now) / 1000)} s`)
        if (lo === REFUSED_BACKOFF_MS[0]) cam.refusedLogged = true
      }
      return
    }
    if (now < cam.refusedUntil) {
      // A refusal is of one stream and says nothing about the other. A camera waiting one out whose
      // setting now calls for the other stream tries that at once, in its turn among the cameras
      // being moved (MIGRATE_EVERY_MS), not when the backoff ends: 'sub' set on an NVR that refuses
      // main streams is the remedy for exactly this, and the cameras it was meant for recorded
      // nothing for up to 10 more minutes. wantType is the stream refused (only attaching sets it).
      // Back to 'auto' from a sub-stream a setting chose, it is the main, as #migrate moves an
      // attached one (the refusals counted there were of the sub); otherwise chooseStream on the pick
      // as it stands ('auto' after the main was refused twice under 'main' takes the sub).
      const prefer = this.#streamPref(cam.ch)
      const back = prefer === 'auto' && cam.bySetting && cam.wantType === SUB
      const type = back ? MAIN : chooseStream(cam.pick, now, { allowSub: this.allowSubFallback(), prefer }).type
      if (type === cam.wantType || now - this.migratedAt < MIGRATE_EVERY_MS) return
      this.migratedAt = now
      cam.refusedUntil = 0
      cam.refusedLogged = false // a refusal of the new stream is news
      if (back) cam.pick = this.#movedPick(cam, MAIN)
      console.log(`[rec ${this.nvrId}/${cam.ch + 1}] recording setting changed: trying the ${type === SUB ? 'sub-stream' : 'main stream'} now, not after the refusal of the other`)
    }
    // recording a stream its setting no longer calls for: detached here (one camera per NVR every
    // MIGRATE_EVERY_MS), and the no-stream path below attaches the one it does
    if (cam.stream) this.#migrate(cam, now)
    if (!cam.stream) {
      cam.attachedAt = now
      const prefer = this.#streamPref(cam.ch)
      const pick = chooseStream(cam.pick, now, { allowSub: this.allowSubFallback(), prefer })
      cam.wantType = pick.type
      cam.bySetting = prefer === 'sub' || prefer === 'main' // a setting chose this stream, not 'auto' (#prefTarget)
      cam.stream = this.getStream(cam.ch, pick.type)
      cam.stream.add(cam.tap)
    }
  }

  #detach(cam) {
    cam.stream?.remove(cam.tap)
    cam.stream = null
  }

  /**
   * The stream an attached camera's setting now calls for when it is recording the other one (SUB or
   * MAIN), else null. 'sub' and 'main' are what they say. 'auto' only takes a camera back to the main
   * stream when a setting is what put it on the sub (bySetting: set when its stream was attached). One
   * that fell back there under 'auto' (refused, or the main only trickled) stays, and stream-choice.mjs
   * decides when it tries the main again. pick.onSub alone cannot tell the two apart: a fallback has
   * not set it until its first written frame, so a camera would be taken back to the main stream the
   * moment it fell back from it.
   */
  #prefTarget(cam) {
    const prefer = this.#streamPref(cam.ch)
    if (prefer === 'sub') return cam.wantType === SUB ? null : SUB
    if (prefer === 'main') return cam.wantType === MAIN ? null : MAIN
    return cam.wantType === SUB && cam.bySetting && !cam.pick?.onSub ? MAIN : null
  }

  /**
   * Moves a camera that is recording to the stream its setting now calls for (#prefTarget), one camera
   * per NVR every MIGRATE_EVERY_MS. sync() starts and stops cameras by mode, and attach() only chose a
   * stream for a camera without one, so setting nvr-2 to 'sub' moved just the 8 of its ~25 cameras
   * that happened to reattach; the rest went on recording the main stream the NVR only trickled.
   * Detaches the camera and opens a gap row saying why; the caller's no-stream path attaches the
   * new stream, and its first written frame ends the gap.
   */
  #migrate(cam, now) {
    const type = this.#prefTarget(cam)
    if (type === null || now - this.migratedAt < MIGRATE_EVERY_MS) return
    this.migratedAt = now
    const reason = `switching to the ${type === SUB ? 'sub-stream' : 'main stream'} (recording setting changed)`
    this.#detach(cam)
    // (a camera between events is not writing anyway: nothing is lost, so no row)
    if (!cam.eventIdle) {
      if (!cam.gap && cam.lastAt > 0 && now - cam.lastAt >= SILENCE_GAP_MS) {
        // A stall already under way is filed as what it is, up to now, and the switch starts here.
        // Its 'no video' row would only have opened with the stream's next frame, which this stream
        // will not send now, so the switch's row began at the last frame and took the stall in: a
        // camera moved partway through one of nvr-2's ~5 s holes had it filed as 'switching'.
        cam.gap = { fromMs: cam.lastTs || cam.lastAt, reason: NO_VIDEO_REASON }
        this.#endGap(cam, now)
        cam.gap = { fromMs: now, reason }
      } else this.#gapFrom(cam, reason)
      // (switchEnd: its row runs no further, SWITCH_MAX_MS)
      if (cam.gap?.reason === reason) Object.assign(cam.gap, { switching: true, switchEnd: now + SWITCH_MAX_MS })
    }
    // one stream per file: the old stream's file ends at its last frame, and the new stream's first
    // keyframe opens one of its own (a sub-stream in the same codec would not roll the file by itself)
    if (cam.writer?.open) cam.writer.close()
    cam.pick = this.#movedPick(cam, type)
    cam.stutterAt = []
    console.log(`[rec ${this.nvrId}/${cam.ch + 1}] ${reason}`)
  }

  /**
   * The pick for a camera a setting moves to stream `type`. What 'auto' counted on the old stream
   * (refusals, short gaps, a fallback) says nothing about the new one, and a refusal count left over
   * would have chooseStream pick the sub-stream again. Back to the main under 'auto' it starts one
   * refusal short of the sub: the camera was recording its sub-stream a moment ago, and a main the NVR
   * refuses drops it straight back there rather than leaving it with nothing for the 5-10 min backoff
   * of a first refusal. nvr-2 refused channels 18-32 on 09-25: one click back to 'auto' would have
   * left most of them recording nothing at the same time.
   */
  #movedPick(cam, type) {
    const back = type === MAIN && this.#streamPref(cam.ch) === 'auto'
    return { refusals: back ? REFUSALS_BEFORE_SUB - 1 : 0, onSub: false, subSince: 0, lastRefusedAt: 0 }
  }

  /** Called every 250 ms by the worker: reattach after a relogin, report long silences. */
  tick() {
    for (const cam of this.cams.values()) this.attach(cam)
  }

  /** Whether channel ch was set to record in the first settings this recorder was given. */
  #onAtStart(ch) {
    const r = this.firstRecording
    const mode = r?.cameras?.[`${this.nvrId}/${ch}`]?.mode ?? r?.defaults?.mode
    return Boolean(mode) && mode !== 'off'
  }

  /**
   * How the recording's video is flowing from the SDK, for this worker's watchdog (watchdog.mjs
   * spareWhile): of the cameras that should be delivering now (recording, camera online, not left
   * alone after a refusal), how many had a frame in the last FLOW_RECENT_MS (flowing) and how many
   * have had none for FROZEN_MS (frozen; counted from when the camera was taken on or attached, if
   * it never had one). null when no camera should be delivering.
   */
  flow(now = this.now()) {
    let cameras = 0
    let flowing = 0
    const frozenChs = []
    for (const cam of this.cams.values()) {
      if (!cam.camOnline || now < cam.refusedUntil) continue
      cameras++
      if (cam.frameAt && now - cam.frameAt < FLOW_RECENT_MS) flowing++
      else if (now - Math.max(cam.frameAt, cam.attachedAt, cam.createdAt) >= FROZEN_MS) frozenChs.push(cam.ch)
    }
    if (!cameras) return null
    return { at: now, cameras, flowing, frozen: frozenChs.length, recentMs: FLOW_RECENT_MS, frozenMs: FROZEN_MS, frozenChs: frozenChs.slice(0, 64) }
  }

  status() {
    return Object.fromEntries(
      [...this.cams.values()].map((c) => {
        const q = c.writer?.queueStatus()
        return [c.ch, { mode: c.mode ?? null, eventIdle: c.eventIdle ?? null, loc: c.loc?.id ?? null, writing: Boolean(c.writer?.open), lastFrameAt: c.lastAt || null, gapSince: c.gap?.fromMs ?? null, lastError: c.lastError, camOnline: c.camOnline, refusedUntil: c.refusedUntil > this.now() ? c.refusedUntil : null, queue: q ? { bytes: q.queuedBytes, ageMs: q.ageMs, dropped: q.dropped, overflows: q.overflows } : null }]
      })
    )
  }

  /** Stops every camera. Resolves once their last segments are on disk and reported. */
  stop() {
    for (const [ch, cam] of this.cams) this.#stopCam(ch, cam)
    return this.idle()
  }

  /** Resolves once every writer has done all the disk work queued so far. */
  idle() {
    return Promise.all([...this.writers].map((w) => w.drained())).then(() => {})
  }

  #pickLocation(cam) {
    const now = this.now()
    for (const [id, f] of this.failed) if (now - f.at > FAILED_LOCATION_MS) this.failed.delete(id)
    const ok = this.locations.filter((l) => !this.failed.has(l.id) && l.role !== 'archive')
    return (cam.locationId && ok.find((l) => l.id === cam.locationId)) || ok.find((l) => l.role === 'main') || ok.find((l) => l.role === 'overflow') || ok[0] || null
  }

  #switchTo(cam, loc) {
    this.#retire(cam.writer)
    cam.writer = null
    cam.loc = loc
    if (!loc) return
    // (each camera rolls over at its own second: not every file's fsync in the same second)
    const w = new SegmentWriter({ rollOffsetMs: rollOffsetFor(this.nvrId, cam.ch), ...this.writerOpts, root: loc.path, nvrId: this.nvrId, ch: cam.ch })
    w.on('open', (o) => this.send({ t: 'segopen', nvr: this.nvrId, ch: cam.ch, ...o, loc: loc.id }))
    w.on('segment', (s) => this.send({ t: 'segment', nvr: this.nvrId, ch: cam.ch, ...s, loc: loc.id }))
    w.on('error', (e) => {
      if (cam.writer === w && this.cams.get(cam.ch) === cam) this.#writeFailed(cam, loc, e)
      else this.failed.set(loc.id, { at: this.now(), reason: e.message }) // a writer being closed
    })
    w.on('overflow', (o) => {
      if (cam.writer !== w) return
      cam.lastError = { at: this.now(), loc: loc.id, reason: o.reason }
      console.warn(`[rec ${this.nvrId}/${cam.ch + 1}] ${o.reason}: dropping frames until it catches up`)
      this.#gapFrom(cam, o.reason)
    })
    this.writers.add(w)
    cam.writer = w
  }

  /** Closes a writer that is no longer used; its last segment is still reported. */
  #retire(w) {
    if (!w) return
    w.close()
    w.drained().then(() => {
      this.writers.delete(w)
      w.removeAllListeners('overflow')
    })
  }

  #writeFailed(cam, loc, e) {
    const reason = e.message
    cam.lastError = { at: this.now(), loc: loc.id, reason }
    if (!this.failed.has(loc.id)) console.warn(`[rec ${this.nvrId}/${cam.ch + 1}] ${reason}; trying another location`)
    this.failed.set(loc.id, { at: this.now(), reason })
    this.#gapFrom(cam, reason)
    cam.switchPending = true // done by the next #onFrame
  }

  /** Which stream this camera is set to record: 'auto' (main, sub on refusal), 'main' or 'sub'. */
  #streamPref(ch) {
    const r = this.recording
    return r?.cameras?.[`${this.nvrId}/${ch}`]?.stream ?? r?.nvrs?.[this.nvrId]?.stream ?? r?.defaults?.stream ?? 'auto'
  }

  #gapFrom(cam, reason) {
    // a reason of its own during the ramp-up after a restart (refused, camera offline, no storage),
    // or during a switch of stream for a setting (the new stream refused, the camera offline, the disk
    // too slow, a write failed): the ramp-up or the switch ends here and this one starts, so each
    // stretch carries the reason it had. A switch's row used to keep its own: a 5-10 min refusal or
    // an hour offline went into one 'switching' row, reports counted it as 'other', and a failed
    // write's 'not writable' never reached the parent's health check.
    const g = cam.gap
    if ((g?.startup || g?.switching) && reason !== g.reason) {
      const at = this.now()
      this.#endGap(cam, at)
      cam.gap = { fromMs: at, reason } // (from the old row's end: not again from the last frame)
      return
    }
    if (!cam.gap) cam.gap = { fromMs: cam.lastTs || cam.lastAt || this.now(), reason }
  }

  /**
   * A "no video from the NVR" gap just opened on this camera's MAIN stream. When they keep coming,
   * the NVR is serving the stream in a broken trickle rather than refusing it cleanly -- and
   * afterVideo() would otherwise mark the camera recovered on every brief burst, so it never falls
   * back. After STUTTER_COUNT within STUTTER_WINDOW_MS, drop to the sub-stream exactly as a clean
   * refusal would (so the retry backoff and the 30-minute main retry in stream-choice.mjs both apply).
   * @returns {boolean} whether it dropped to the sub-stream
   */
  #noteStutter(cam, now) {
    if (cam.wantType !== MAIN || cam.pick?.onSub || !this.allowSubFallback() || this.#streamPref(cam.ch) !== 'auto') return false
    // the sub-stream refused just after the last drop (TRICKLE_SUB_MS): the trickle is all there is
    // until that sub's back-off is over, and is recorded, gaps and all
    if (now < cam.subRefusedUntil) return false
    cam.stutterAt.push(now)
    const cutoff = now - STUTTER_WINDOW_MS
    while (cam.stutterAt.length && cam.stutterAt[0] < cutoff) cam.stutterAt.shift()
    if (cam.stutterAt.length < STUTTER_COUNT) return false
    cam.stutterAt = []
    cam.trickleAt = now
    cam.pick = { ...cam.pick, refusals: REFUSALS_BEFORE_SUB, lastRefusedAt: now }
    cam.lastError = { at: now, loc: cam.loc?.id ?? null, reason: STUTTER_REASON }
    const next = chooseStream(cam.pick, now, { allowSub: true })
    console.warn(`[rec ${this.nvrId}/${cam.ch + 1}] ${STUTTER_REASON}; ${next.why}`)
    this.#detach(cam) // the next tick attaches the sub-stream
    return true
  }

  #endGap(cam, toMs) {
    if (!cam.gap) return
    const g = cam.gap
    cam.gap = null
    // a camera that was recording again within SILENCE_GAP_MS of the restart lost nothing worth a row
    if (g.startup && toMs - g.fromMs < SILENCE_GAP_MS) return
    // a switch is over by switchEnd (SWITCH_MAX_MS); the rest of a longer one is the NVR sending nothing
    if (g.switching && toMs - g.switchEnd >= SILENCE_GAP_MS) {
      this.send({ t: 'recgap', nvr: this.nvrId, ch: cam.ch, fromMs: g.fromMs, toMs: g.switchEnd, reason: g.reason })
      this.send({ t: 'recgap', nvr: this.nvrId, ch: cam.ch, fromMs: g.switchEnd, toMs, reason: NO_VIDEO_REASON })
      return
    }
    this.send({ t: 'recgap', nvr: this.nvrId, ch: cam.ch, fromMs: g.fromMs, toMs, reason: g.reason })
  }

  #tapFor(cam) {
    const rec = this
    return {
      // the recorder's stream starts first in the NVR's lanes (lanes.mjs RANK), is never held by
      // the live pacer, and may start while the NVR cools down once nothing of it is stuck (live.mjs)
      recorder: true,
      background: true, // nobody is watching it
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0, // the writer has its own queue limits (segment-writer.mjs)
      stuckMs: 0, // never closed by live backpressure (backpressure.mjs)
      send(buf) {
        rec.#onFrame(cam, buf)
      },
      close() {} // LiveStream.fail(): attached again by tick()
    }
  }

  #onFrame(cam, buf) {
    if (this.cams.get(cam.ch) !== cam || buf.length <= HEADER_SIZE) return
    const now = this.now()
    cam.frameAt = now // video from the SDK, whether or not it is written (flow())
    const isKey = buf[0] === 1
    const { ts, lost, reanchored } = this.#stamp(cam, Number(buf.readBigInt64LE(8)) / 1000, now)
    // Event-driven modes: outside an event window this camera is meant not to be writing. That is a
    // decision, not a fault, so no gap row is filed for it and the silence check below is skipped —
    // a timeline that marked every quiet minute as "no video from the NVR" would be a lie, and
    // would bury the gaps that really are faults. The clock references are still moved on, so the
    // first frame after a quiet spell is not mistaken for a jump.
    const gate = this.#gate(cam, ts, now)
    if (!gate.write) {
      // the video is back and this camera is doing what it should (not writing between events):
      // the restart's ramp-up ends here, not at the next event, and so does a switch of stream
      if (cam.gap?.startup || cam.gap?.switching) this.#endGap(cam, ts)
      cam.lastTs = ts
      cam.lastAt = now
      cam.waitKey = true // the next written frame must be a keyframe: deltas need their reference
      // Finish the file the moment the window closes rather than leaving it open and empty. An open
      // file counts on the timeline as coverage up to three minutes past its last frame
      // (rec-index.mjs OPEN_MAX_MS), so leaving it open would draw footage that does not exist.
      // The writer opens a fresh file by itself on the next frame it is given.
      if (!cam.eventIdle && cam.writer?.open) cam.writer.close()
      cam.eventIdle = gate.why
      return
    }
    cam.eventIdle = null
    // (a re-anchor moves the timeline, it loses nothing: no gap row for that jump)
    if (cam.lastTs && ts - cam.lastTs >= SILENCE_GAP_MS && !cam.gap && !reanchored) {
      cam.gap = { fromMs: cam.lastTs, reason: NO_VIDEO_REASON }
      if (this.#noteStutter(cam, now)) return // dropped to the sub-stream: stop recording this trickle
    }
    // frames were lost (a stall inside the SDK: LiveStream did not restart, so nothing asked for
    // a keyframe): deltas that follow reference pictures the file does not have. Wait for a key.
    if (lost) cam.waitKey = true
    if (cam.waitKey) {
      if (!isKey) return
      cam.waitKey = false
    }
    if (!cam.writer) {
      if (!cam.loc) {
        const loc = this.#pickLocation(cam)
        if (loc) this.#switchTo(cam, loc)
      }
      if (!cam.writer) {
        this.#gapFrom(cam, 'no storage location available (none healthy or writable)')
        return
      }
    }
    if (cam.switchPending) {
      // a write failed (reported by the writer after the fact): move to the next location
      cam.switchPending = false
      this.#switchTo(cam, this.#pickLocation(cam))
      if (!cam.writer) {
        this.#gapFrom(cam, 'no storage location available (none healthy or writable)')
        return
      }
    }
    const frame = buf.subarray(HEADER_SIZE)
    const meta = { isKey, ts, codec: buf[1] === 1 ? 'h265' : 'h264' }
    const ok = cam.writer.write(frame, meta) // queued only: never waits for the disk
    if (ok) {
      cam.refusedLogged = false
      // Video is flowing, so whatever stream we settled on is the one working. A camera that came
      // back up on the main stream stops being marked degraded here, and nowhere else.
      // (a stream a setting chose, recorded after the setting went back to 'auto' while the camera
      // waits its turn in #migrate, is still that choice: were it marked a fallback here, the camera
      // would be listed degraded and #prefTarget would leave it on the sub-stream for good)
      if (this.#streamPref(cam.ch) === 'auto' && !cam.bySetting) {
        const was = cam.pick?.onSub
        cam.pick = afterVideo(cam.pick, now, cam.wantType ?? MAIN)
        // recovered to the main stream: forget the earlier trickle so a stale count can't drop it again
        if (was && !cam.pick.onSub) {
          cam.stutterAt = []
          console.log(`[rec ${this.nvrId}/${cam.ch + 1}] back on the main stream`)
        }
      } else {
        // recording the stream this camera is set to: a choice, never a fallback, so no degraded state
        cam.pick = { refusals: 0, onSub: false, subSince: 0, lastRefusedAt: 0 }
      }
      this.#endGap(cam, ts)
      cam.lastAt = now
      cam.lastTs = ts
    }
  }

  /**
   * This frame's time on our clock (ms) from its capture time hdrMs (the NVR's clock), and
   * whether frames were lost before it: the capture time jumped by SILENCE_GAP_MS or more, or,
   * without a usable capture time, nothing arrived for that long.
   */
  #stamp(cam, hdrMs, now) {
    const c = cam.clk
    let ts
    let lost
    let reanchored = false
    if (hdrMs > 0 && c && hdrMs >= c.hdr && hdrMs - c.hdr <= MAX_HDR_STEP_MS) {
      c.off = Math.min(c.off + (hdrMs - c.hdr) * CLOCK_CREEP, now - hdrMs)
      ts = hdrMs + c.off
      const lag = now - ts
      if (lag <= MAX_LAG_MS) c.lagSince = null
      else if (c.lagSince == null) c.lagSince = now
      if (lag > MAX_BACKLOG_MS || (c.lagSince != null && now - c.lagSince >= LAG_HOLD_MS)) {
        c.off = now - hdrMs
        c.lagSince = null
        ts = now
        reanchored = true
      }
      lost = hdrMs - c.hdr >= SILENCE_GAP_MS
      c.hdr = hdrMs
    } else {
      lost = cam.lastAt > 0 && now - cam.lastAt >= SILENCE_GAP_MS
      cam.clk = hdrMs > 0 ? { off: now - hdrMs, hdr: hdrMs, lagSince: null } : null
      ts = now
    }
    return { ts: Math.max(Math.round(ts), cam.lastTs || 0), lost, reanchored }
  }

  #stopCam(ch, cam) {
    this.cams.delete(ch)
    cam.stream?.remove(cam.tap)
    cam.stream = null
    this.#retire(cam.writer)
    cam.writer = null
    this.#endGap(cam, this.now())
    console.log(`[rec ${this.nvrId}/${ch + 1}] recording off`)
  }
}
