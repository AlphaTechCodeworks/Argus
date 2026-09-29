// Playout clock: decides when each decoded frame is shown.
//
// Frames are shown at   capture timestamp / rate + anchor,   where the anchor maps the
// camera's clock onto this PC's clock plus a small buffer (the delay). The anchor
// only moves in deliberate steps, so frames keep the camera's own even cadence
// even though the network delivers them in bursts:
//   - a frame decoded after its display time  -> "late"; if that keeps happening
//     the delay grows (buffer absorbs bigger bursts; playback takes it up a few ms a frame;
//     a page through the tunnel grows it by each late frame's lateness at once, REMOTE_CLOCK)
//   - a steady link for a while               -> the delay shrinks a little
//   - playback far behind the newest frame    -> jump to the live edge
//     (e.g. the backlog an NVR sends when a stream starts)
//   - frames far too late for about a second, or a timestamp jump against wall time
//     (an outage: the camera clock froze or stepped) -> re-anchor on the new frames
//     instead of showing every one of them the moment it decodes
//   - camera clock a little fast or slow      -> the anchor is slewed by at most 1% of
//     real time (10 ms per second), so drift never builds up into a jump
//   - playback slowed down                    -> the frames still coming at the old speed
//     play at up to that speed, so the buffer keeps the frames it had (setRate, arrived)
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
  slewDeadMs: 5, // smaller drift errors are left alone
  growSlew: 0, // 0: a grown buffer moves the anchor at once; else each frame takes this share of its spacing
  catchUpMs: 2000, // after a slow-down (setRate), frames arriving this long are checked for being too far ahead
  stretchLate: false, // a late frame grows the buffer by its lateness at once (REMOTE_CLOCK)
  stretchMarginMs: 30, // ... and this much more
  shrinkWindowMs: 0 // > 0: shrink towards the largest lateness of this long, shrinkMs every adapt() (REMOTE_CLOCK)
}

/**
 * Recorded footage (playback.js, and wall.js with it): a larger buffer than live, and frames far too
 * late re-anchor at once. The server paces playback on its main thread; when that stalls (1.3-1.9 s,
 * smoothness report cause 1) its pacer resumes where it was, so every later frame is as late as the
 * stall was. Waiting lateForMs to be sure showed those frames as they landed for a second and then
 * froze again for a buffer's length: two freezes for one stall. Live keeps the default, where a late
 * run is often the NVR catching up and passes by itself.
 *
 * A grown buffer reaches the picture a few ms a frame (growSlew 10%: 4 ms a frame at 25 fps, the
 * 40 ms step in 0.4 s) instead of every frame waiting 40 ms longer at once, a hitch each time
 * (smoothness report, minor items). Live keeps the step, as it always had.
 */
export const PLAYBACK_CLOCK = { startDelayMs: 300, minDelayMs: 200, maxDelayMs: 1000, lateForMs: 0, growSlew: 0.1 }

/**
 * Live on a page opened through the Cloudflare tunnel or the tailnet (viewer.js; stutter report 2.4
 * with verify-4's corrections, 29 Sep). The page's one socket through the tunnel stalls now and then
 * for longer than live's buffer can hold (350 ms, growing to 800 at most): another tile's keyframe
 * ahead of it (634 KB takes 0.8-1.5 s at 3.3-6 Mbit/s), a lost packet (0.6% of the bytes are sent
 * again). Each stall froze the picture and then jumped ahead, and live's buffer grows only 40 ms a
 * second, and only after two late frames in one. The replay of a 1.2 s stall every 20 s: 97% of
 * frames shown, 3 freezes a minute; with this profile 100% and one freeze, the first
 * (test/live-replay.test.mjs).
 *
 *  - stretchLate: a frame that comes late grows the buffer by its lateness and 30 ms at once. The
 *    picture is standing still waiting for it anyway, so nothing visible moves: that frame and the
 *    ones after it play at the camera's cadence instead of jumping ahead, and the next stall as long
 *    is ridden out. Up to 2 s. Not in the warm-up after a (re)start: the lateness there is the
 *    start-up replay, not the link.
 *  - shrinkWindowMs: once a minute has passed with no frame that needed as much, the buffer comes
 *    down 10 ms a second (live: 10 ms every 10 s) towards the largest lateness of that minute and
 *    30 ms. 10 ms at once is less than a frame at 30 fps, so no frame is skipped on the way down.
 *    With live's shrink a page opened over a busy link (50% for 6 s) still held 1.7 s five minutes
 *    later in verify-4's replay; this way it is back to 150 ms by then.
 *  - Past 2 s late for a second the clock re-syncs on the late frames as live does, and starts from
 *    350 ms again: the link cannot carry the stream (the controller's business), and re-anchoring on
 *    a 2 s buffer held the picture for 2 s each time.
 * Starts at live's 350 ms and may come down to 150 ms: verify-4 found the report's 800/500 added half
 * a second on a clean tunnel for nothing. The player holds up to 2 s of decoded frames with it
 * (player.js REMOTE_QUEUED_FRAMES).
 */
export const REMOTE_CLOCK = { startDelayMs: 350, minDelayMs: 150, maxDelayMs: 2000, stretchLate: true, shrinkWindowMs: 60_000 }

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
    this.lastAtTs = null // ... and its capture time (setRate's pivot when nothing is buffered)
    this.queuedUntil = 0 // after a hole: display time of the frames still queued from before it
    this.late = 0 // late frames since the last adapt()
    this.lateTotal = 0
    this.resyncs = 0
    this.stretches = 0 // late frames the buffer grew for (stretchLate)
    this.warmupUntil = 0
    this.steadySince = null
    this.growLeft = 0 // growth adapt() decided that the anchor has still to take up (growSlew)
    this.catchUp = null // after a slow-down: { from, until, lastTs, lastNow, target } (setRate, arrived)
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
    // shrinkWindowMs: the delay each frame needed (see schedule), the most of each second so far, and
    // since when they are counted (after the warm-up: a window is only whole a window after that)
    this.needMax = -Infinity
    this.needs = [] // { at, need } per adapt(), the last shrinkWindowMs
    this.needFrom = null
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
    if (this.growLeft > 0 && this.lastTs !== null) {
      // a grown buffer, a little per frame: each frame takes up growSlew of its own spacing (10%:
      // 4 ms at 25 fps), so the picture runs a little slow for a moment instead of holding a frame
      const s = Math.min(this.growLeft, (Math.max(0, tsMs - this.lastTs) / this.rate) * o.growSlew)
      this.growLeft -= s
      this.#shift(s)
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
        // (a stretched buffer that could not hold it starts again from its start: see REMOTE_CLOCK)
        if (o.stretchLate) this.delay = Math.min(this.delay, o.startDelayMs)
        this.#reanchor(tsMs, now)
        this.lastTs = tsMs
        this.lastNow = now
        at = tsMs / this.rate + this.anchor
        this.resyncs++
      }
    } else {
      this.lateSince = null
    }
    // stretchLate: the picture is standing still waiting for this frame; the buffer grows by its
    // lateness (and a margin) now, so it and the frames after it keep their cadence (REMOTE_CLOCK)
    if (o.stretchLate && at + this.growLeft < now && now > this.warmupUntil) {
      const s = Math.min(Math.ceil(now - at + o.stretchMarginMs), o.maxDelayMs - this.delay)
      if (s > 0) {
        this.delay += s
        this.#shift(s)
        at += s
        this.steadySince = now
        this.stretches++
      }
    }
    // shrinkWindowMs: the delay that would have had this frame just on time. A stretch or a shrink
    // moves the delay and the anchor together, so it stays what the link did, whatever they were
    if (o.shrinkWindowMs && now > this.warmupUntil) {
      this.needFrom ??= now
      this.needMax = Math.max(this.needMax, this.delay - (at - now))
    }
    // (a frame the growth still under way will cover is not late again: it would grow twice)
    if (at + this.growLeft < now && now > this.warmupUntil) {
      this.late++
      this.lateTotal++
    }
    this.#measureDrift(tsMs, now)
    this.lastAt = at
    this.lastAtTs = tsMs
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
    this.growLeft = 0 // (the new anchor has the whole delay)
    this.catchUp = null // (and no more than it)
    this.#track()
  }

  /**
   * Playback speed. The frame shown next (tsMs, the oldest buffered) keeps its display time and the
   * ones after it follow at the new rate, so the buffer keeps as many frames as it had. It used to
   * put that frame a whole buffer later: the picture held for the buffer's length at every change,
   * and at 2x and 4x the buffer then held two or four times the decoded frames -- more than a
   * hardware decoder hands out (6 at 2560x1440 on the viewing PC), so it stalled and the player
   * skipped to the next keyframe, 2-4 s on (smoothness report cause 5).
   *
   * With nothing buffered (every decoded frame shown: at 4x through the tunnel the frames come just
   * in time) the newest decoded frame keeps its time instead. That case used to change only the rate:
   * the next frame's time made no sense, so it re-synced a whole buffer ahead (at 4x, four times the
   * frames), and a slow-down's catch-up (below) never started.
   *
   * The frames the server sends at the old speed until the command reaches it are still coming. After
   * a speed-up they come late and are shown as they come. After a slow-down they come early, each one
   * further ahead than the last: 4x to 1x put them 4 x the lead + 3 x the round trip ahead, 656-697 ms
   * at 30 fps through the tunnel. That is more than the hardware decoder holds (its 6 frames and the
   * player's 12 waiting are 600 ms at 30 fps), but the clock only sees a frame once it is decoded, at
   * most 6 frames ahead, so it never re-synced: the player dropped to the next keyframe, and again at
   * every one after it. So after a slow-down arrived() looks at the frames as they come in, for
   * catchUpMs, and plays those that would add to the buffer at up to the old speed: the picture
   * carries on at 4x about as long as the server did, and the buffer keeps the frames it had.
   */
  setRate(rate, tsMs, now) {
    const pivot = tsMs ?? this.lastAtTs
    if (this.anchor === null || pivot === null) {
      this.rate = rate // no clock yet: the next frame anchors it
      return
    }
    const at = this.presentAt(pivot)
    const growLeft = this.growLeft
    // (4x to 2x to 1x in quick succession: frames sent at 4x may still be coming)
    const from = Math.max(this.rate, this.catchUp !== null && now <= this.catchUp.until ? this.catchUp.from : 0)
    this.rate = rate
    this.anchorAt(pivot, now, at - now)
    this.growLeft = growLeft // (a growth under way carries on)
    if (rate < from) this.catchUp = { from, until: now + this.opts.catchUpMs, lastTs: null, lastNow: now, target: null }
  }

  /**
   * A frame as it arrives, before it waits to be decoded (player.push). Only a slow-down (setRate) makes
   * this do anything, and only for catchUpMs.
   *
   * The first frame to arrive after the change sets the lead to keep: the one the buffer had, as many
   * frames as before, but no more than the delay and no fewer than minDelayMs make at 1x (delay /
   * rate: at 2x the same frames last half as long). Not the delay itself: at 25 fps a 640 ms buffer
   * is 16 frames, and the decoder waits for its 6 to be shown with at most 12 more queued, so the
   * frames the server sent at 4x, piling up behind the 1x picture until the lead got there, overflowed
   * the queue anyway. A frame that would be shown further ahead than that lead brings the picture
   * forward by what the old speed gains in the time since the frame before -- no more, so the picture
   * runs at most at the old speed, in steps of the few ms between 4x frames. While the old-speed
   * frames come in that is what each adds to the lead, so it holds. A growth adapt() has not passed
   * on yet is dropped first: the buffer is big enough.
   */
  arrived(tsMs, now) {
    const c = this.catchUp
    if (c === null || this.anchor === null) return
    if (now > c.until) {
      this.catchUp = null
      return
    }
    const since = now - c.lastNow
    const jump = c.lastTs !== null && Math.abs(since - (tsMs - c.lastTs) / this.rate) > this.opts.jumpMs
    c.lastTs = tsMs
    c.lastNow = now
    if (jump) {
      this.catchUp = null // a hole in the footage (the server skips one at once): not a lead to take out
      return
    }
    const lead = this.presentAt(tsMs) + this.growLeft - now // (once a growth under way is taken up)
    c.target ??= Math.min(this.delay, Math.max(this.opts.minDelayMs, lead * this.rate)) / this.rate
    let over = lead - c.target
    if (over <= 0) return
    const g = Math.min(over, this.growLeft)
    this.growLeft -= g
    over -= g
    if (over > 0) this.#shift(-Math.min(over, since * (c.from / this.rate - 1)))
  }

  // a deliberate move of the anchor: the drift reference moves with it, so it is not taken for drift
  #shift(ms) {
    this.anchor += ms
    if (this.ref !== null) this.ref += ms
  }

  /** Call about once a second: grows the buffer after late frames, trims it when steady, slews drift. */
  adapt(now) {
    const o = this.opts
    if (this.anchor === null) return
    if (o.shrinkWindowMs && this.needFrom !== null) {
      this.needs.push({ at: now, need: this.needMax })
      this.needMax = -Infinity
      while (this.needs[0].at <= now - o.shrinkWindowMs) this.needs.shift()
    }
    let step = 0
    if (this.late > 1) {
      step = Math.min(o.growMs, o.maxDelayMs - this.delay)
      this.steadySince = now
    } else if (o.shrinkWindowMs) {
      // a whole window counted: down by shrinkMs towards what its latest frame needed, and the margin
      if (this.needFrom !== null && now - this.needFrom >= o.shrinkWindowMs) {
        const need = this.needs.reduce((a, n) => Math.max(a, n.need), -Infinity)
        const target = Math.max(o.minDelayMs, Math.ceil(need + o.stretchMarginMs))
        if (this.delay > target) step = -Math.min(o.shrinkMs, this.delay - target)
      }
    } else if (now - this.steadySince > o.steadyMs) {
      step = -Math.min(o.shrinkMs, this.delay - o.minDelayMs)
      this.steadySince = now
    }
    this.delay += step
    // live moves the picture by the whole step at once; playback's growSlew lets schedule() take a
    // growth up frame by frame (a shrink is 10 ms, under a frame: at once everywhere)
    if (step > 0 && o.growSlew > 0) this.growLeft += step
    else this.#shift(step)
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
