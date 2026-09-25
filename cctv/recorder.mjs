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
import { SegmentWriter, rollOffsetFor } from './segment-writer.mjs'

const HEADER_SIZE = 16 // sdk.mjs encodeFrame: key flag, codec, size, time; then the payload
const FAILED_LOCATION_MS = 60_000 // a location a write failed on is skipped this long
// a hole this long in the recorded timeline is reported as a gap (playback's gapMs: 3 s). Stalls
// of 3-10 s used to leave no gap row, so the index could not explain them
const SILENCE_GAP_MS = 3000
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
    this.writerOpts = writerOpts
    this.writers = new Set() // every writer with work outstanding (also ones being closed)
    this.recording = null
    this.locations = []
    this.cams = new Map() // ch -> cam
    this.failed = new Map() // location id -> { at, reason }
    this.noted = new Set()
  }

  /** New settings from the parent. */
  apply({ recording, locations } = {}) {
    this.recording = recording ?? null
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
        console.log(`[rec ${this.nvrId}/${ch + 1}] mode ${mode}: recorded continuously until events are supported`)
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
        cam = { ch, tap: null, stream: null, writer: null, loc: null, locationId: w.locationId, gap: null, lastAt: 0, lastTs: 0, clk: null, waitKey: false, lastError: null, camOnline: true, attachedAt: 0, refusedUntil: 0 }
        cam.tap = this.#tapFor(cam)
        this.cams.set(ch, cam)
        console.log(`[rec ${this.nvrId}/${ch + 1}] recording on`)
      }
      cam.locationId = w.locationId
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
      cam.refusedUntil = now + REFUSED_BACKOFF_MS[0] + Math.round(Math.random() * (REFUSED_BACKOFF_MS[1] - REFUSED_BACKOFF_MS[0]))
      const reason = `refused by the NVR (${f.reason || 'no reason given'})`
      cam.lastError = { at: now, loc: cam.loc?.id ?? null, reason }
      this.#gapFrom(cam, reason)
      if (!cam.refusedLogged) console.warn(`[rec ${this.nvrId}/${cam.ch + 1}] ${reason}; trying again in ${Math.round((cam.refusedUntil - now) / 60_000)} min`)
      cam.refusedLogged = true
      return
    }
    if (now < cam.refusedUntil) return
    if (!cam.stream) {
      cam.attachedAt = now
      cam.stream = this.getStream(cam.ch)
      cam.stream.add(cam.tap)
    }
  }

  #detach(cam) {
    cam.stream?.remove(cam.tap)
    cam.stream = null
  }

  /** Called every 250 ms by the worker: reattach after a relogin, report long silences. */
  tick() {
    for (const cam of this.cams.values()) this.attach(cam)
  }

  status() {
    return Object.fromEntries(
      [...this.cams.values()].map((c) => {
        const q = c.writer?.queueStatus()
        return [c.ch, { loc: c.loc?.id ?? null, writing: Boolean(c.writer?.open), lastFrameAt: c.lastAt || null, gapSince: c.gap?.fromMs ?? null, lastError: c.lastError, camOnline: c.camOnline, refusedUntil: c.refusedUntil > this.now() ? c.refusedUntil : null, queue: q ? { bytes: q.queuedBytes, ageMs: q.ageMs, dropped: q.dropped, overflows: q.overflows } : null }]
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

  #gapFrom(cam, reason) {
    if (!cam.gap) cam.gap = { fromMs: cam.lastTs || cam.lastAt || this.now(), reason }
  }

  #endGap(cam, toMs) {
    if (!cam.gap) return
    this.send({ t: 'recgap', nvr: this.nvrId, ch: cam.ch, fromMs: cam.gap.fromMs, toMs, reason: cam.gap.reason })
    cam.gap = null
  }

  #tapFor(cam) {
    const rec = this
    return {
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
    const isKey = buf[0] === 1
    const { ts, lost, reanchored } = this.#stamp(cam, Number(buf.readBigInt64LE(8)) / 1000, now)
    // (a re-anchor moves the timeline, it loses nothing: no gap row for that jump)
    if (cam.lastTs && ts - cam.lastTs >= SILENCE_GAP_MS && !cam.gap && !reanchored) cam.gap = { fromMs: cam.lastTs, reason: 'no video from the NVR' }
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
    if (cam.gap) {
      this.send({ t: 'recgap', nvr: this.nvrId, ch, fromMs: cam.gap.fromMs, toMs: this.now(), reason: cam.gap.reason })
      cam.gap = null
    }
    console.log(`[rec ${this.nvrId}/${ch + 1}] recording off`)
  }
}
