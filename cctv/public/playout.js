// Playout clock: decides when each decoded frame is shown.
//
// Frames are shown at   capture timestamp / rate + anchor,   where the anchor maps the
// camera's clock onto this PC's clock plus a small buffer (the delay). The anchor
// only moves in deliberate steps, so frames keep the camera's own even cadence
// even though the network delivers them in bursts:
//   - a frame decoded after its display time  -> "late"; if that keeps happening
//     the delay grows (buffer absorbs bigger bursts)
//   - a steady link for a while               -> the delay shrinks a little
//   - playback far behind the newest frame    -> jump to the live edge
//     (e.g. the backlog an NVR sends when a stream starts)
//   - frames far too late for about a second, or a timestamp jump against wall time
//     (an outage: the camera clock froze or stepped) -> re-anchor on the new frames
//     instead of showing every one of them the moment it decodes
//   - camera clock a little fast or slow      -> the anchor is slewed by at most 1% of
//     real time (10 ms per second), so drift never builds up into a jump
//
// Pure logic with no browser APIs, so it can be tested in Node against
// recorded arrival times.

export const PLAYOUT_DEFAULTS = {
  // NVRs pause delivery for 0.3-0.45 s every few seconds and then send the frames in a
  // burst: the buffer starts large enough to ride that out
  startDelayMs: 350,
  minDelayMs: 150,
  maxDelayMs: 800,
  growMs: 40, // added when frames arrive late
  shrinkMs: 10, // removed after a steady period
  steadyMs: 10_000,
  behindMs: 400, // re-sync when frames are scheduled this far beyond the delay
  warmupMs: 1500, // ignore lateness right after a (re)start
  lateResyncMs: 500, // frames later than delay + this ...
  lateForMs: 1000, // ... for this long: re-anchor
  jumpMs: 2000, // capture and wall time between two frames differ by more: outage, re-anchor
  holeStepMs: 40, // after such a re-anchor the next frame is shown at least this long after the previous one
  slewWindowMs: 5000, // drift is measured on the earliest arrival in windows this long
  slewMax: 0.01, // the anchor moves at most this share of real time (1%)
  slewDeadMs: 5 // smaller drift errors are left alone
}

export class PlayoutClock {
  constructor(options = {}) {
    this.opts = { ...PLAYOUT_DEFAULTS, ...options }
    this.delay = this.opts.startDelayMs
    this.rate = 1 // playback speed: 2 shows two seconds of video per second
    this.reset()
  }

  reset() {
    this.anchor = null
    this.lastAt = null // display time given to the previous frame
    this.queuedUntil = 0 // after a hole: display time of the frames still queued from before it
    this.late = 0 // late frames since the last adapt()
    this.lateTotal = 0
    this.resyncs = 0
    this.warmupUntil = 0
    this.steadySince = null
    this.#track()
  }

  // forgets the arrival history (after every re-anchor)
  #track() {
    this.lastTs = null // capture and wall time of the previous frame (outage detection)
    this.lastNow = null
    this.lateSince = null // start of a run of frames far too late
    this.ref = null // anchor minus the earliest arrival offset, from the first window
    this.winStart = null
    this.winMin = Infinity // earliest arrival offset (now - ts / rate) in this window
    this.slewLeft = 0 // anchor correction still to apply
    this.lastAdapt = null
  }

  #reanchor(tsMs, now) {
    this.anchorAt(tsMs, now, this.delay)
  }

  /** Registers a decoded frame and returns when to show it (same clock as `now`). */
  schedule(tsMs, now) {
    const o = this.opts
    if (this.anchor === null) this.#reanchor(tsMs, now)
    else if (this.lastTs !== null && Math.abs(now - this.lastNow - (tsMs - this.lastTs) / this.rate) > o.jumpMs) {
      // an outage or a clock step (or a hole in recorded footage): wall time and capture time no
      // longer agree. Frames scheduled before it may still be queued (playback runs ahead): the
      // new frame goes after the last of them, or the display loop would skip them for it
      const lead = this.lastAt !== null ? Math.max(this.delay, this.lastAt + o.holeStepMs - now) : this.delay
      this.anchorAt(tsMs, now, lead)
      this.queuedUntil = now + lead // until then, being further ahead than the delay is expected
      this.resyncs++
    }
    this.lastTs = tsMs
    this.lastNow = now
    let at = tsMs / this.rate + this.anchor
    const queued = this.queuedUntil > now ? Math.max(0, this.queuedUntil - now - this.delay) : 0
    if (at - now > this.delay + o.behindMs + queued) {
      // we are showing old video (start-up backlog, or the camera clock ran ahead): jump to live
      this.#reanchor(tsMs, now)
      this.lastTs = tsMs
      this.lastNow = now
      at = tsMs / this.rate + this.anchor
      this.resyncs++
    } else if (now - at > this.delay + o.lateResyncMs) {
      // far behind: after about a second of this, start again from these frames
      this.lateSince ??= now
      if (now - this.lateSince >= o.lateForMs) {
        this.#reanchor(tsMs, now)
        this.lastTs = tsMs
        this.lastNow = now
        at = tsMs / this.rate + this.anchor
        this.resyncs++
      }
    } else {
      this.lateSince = null
    }
    if (at < now && now > this.warmupUntil) {
      this.late++
      this.lateTotal++
    }
    this.#measureDrift(tsMs, now)
    this.lastAt = at
    return at
  }

  // drift: the earliest (least network-delayed) arrival per window, against the first window
  #measureDrift(tsMs, now) {
    const o = this.opts
    const offset = now - tsMs / this.rate
    if (this.winStart === null) this.winStart = now
    if (offset < this.winMin) this.winMin = offset
    if (now - this.winStart < o.slewWindowMs) return
    const r = this.anchor - this.winMin
    if (this.ref === null) this.ref = r
    else {
      const err = r - this.ref // > 0: frames wait longer and longer (camera clock fast)
      this.slewLeft = Math.abs(err) > o.slewDeadMs ? -err : 0
    }
    this.winStart = now
    this.winMin = Infinity
  }

  /** Display time of a frame with capture timestamp tsMs. */
  presentAt(tsMs) {
    return tsMs / this.rate + this.anchor
  }

  /** Re-times playback so the frame at tsMs is shown at now + leadMs (after a pause or a speed change). */
  anchorAt(tsMs, now, leadMs = 0) {
    this.anchor = now - tsMs / this.rate + leadMs
    this.warmupUntil = now + this.opts.warmupMs
    this.steadySince = now
    this.#track()
  }

  setRate(rate, tsMs, now) {
    this.rate = rate
    // keep the buffer: the NVR needs a moment before it delivers at the new speed
    if (this.anchor !== null && tsMs !== undefined) this.anchorAt(tsMs, now, this.delay)
  }

  /** Call about once a second: grows the buffer after late frames, trims it when steady, slews drift. */
  adapt(now) {
    const o = this.opts
    if (this.anchor === null) return
    let step = 0
    if (this.late > 1) {
      step = Math.min(o.growMs, o.maxDelayMs - this.delay)
      this.steadySince = now
    } else if (now - this.steadySince > o.steadyMs) {
      step = -Math.min(o.shrinkMs, this.delay - o.minDelayMs)
      this.steadySince = now
    }
    this.delay += step
    this.anchor += step
    if (this.ref !== null) this.ref += step // a deliberate change, not drift
    this.late = 0
    // slew toward the drift-free anchor: at most slewMax of the time since the last call
    const dt = this.lastAdapt === null ? 1000 : Math.min(now - this.lastAdapt, 2000)
    this.lastAdapt = now
    if (this.slewLeft) {
      const max = o.slewMax * dt
      const s = Math.max(-max, Math.min(max, this.slewLeft))
      this.anchor += s
      this.slewLeft -= s // (ref stays: the error is measured again every window)
    }
  }
}
