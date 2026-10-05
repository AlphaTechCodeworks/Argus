// A debug-only recorder of what reaches this browser on every live tile: for TRACE_MS (2 minutes)
// after the viewer starts it, each frame's arrival time, capture time, size and keyframe flag, per
// tile, then a JSON file to download. Behind the D overlay (viewer.js): nothing is recorded unless the
// viewer starts it, and until then each frame costs live-tile.js one call that finds no trace.
//
// Why (stutter report, 2026-09-29, Task 0): every finding about stutter on a remote page rested on
// modelled arrivals, because nothing measured what really reaches a browser through the tunnel. A
// trace is replayed through the real player by test/live-replay.mjs, which is how a change to the
// player or the server proves its gain on what the viewer actually got.
//
// The file (format "argus-frame-trace", version 1):
//   { format, version, startedAt (ISO, this device's clock), durationMs, truncated, page: { what the
//     page was: host, layout, smooth, ... }, tiles: [{ id, camera ("nvr-2/6", the channel from 1),
//     nvr, ch (from 0, as the page asks for it), stream ('main' | 'sub'), codec ('h264' | 'h265'),
//     capture0, frames, events, stats }] }
//   frames: [arrivalMs, captureMs, bytes, key], one per frame as it arrived on the tile's socket (or
//     channel of the page's socket): arrivalMs in ms since the trace started (performance.now, to
//     0.1 ms); captureMs the camera's capture time from the frame's header, less capture0 (the
//     tile's first frame's, epoch ms), so the numbers stay short; bytes the whole message, header
//     included; key 1 for a keyframe. A tile borrowing another's stream (the full-size view) records
//     no frames of its own: they are the other tile's.
//   events: [atMs, what, ...]: connect (with the stream asked for), open, close, suspend, resume
//     (with "kept": it decoded the stream it kept, or "reconnect": nothing fresh kept, it connected
//     again), borrow (with the id of the tile lent from), size (width, height, from a keyframe's
//     header), codec (a change), end. A tile already hidden or borrowing when the trace first sees it
//     has "suspend" or "borrow" first, at that moment.
//   stats: [atMs, fps, dropped, late, resyncs, delayMs], the D overlay's counters (player.stats),
//     once a second: what the viewer saw, to set against what the replay says they would see.

export const TRACE_MS = 120_000
// A 64-tile page at 30 fps is 230 000 frames in 2 minutes; past this the frames stop (truncated)
export const TRACE_MAX_FRAMES = 600_000
export const TRACE_FORMAT = 'argus-frame-trace'
export const TRACE_VERSION = 1
const HEADER_SIZE = 16 // sdk.mjs encodeFrame: key flag, codec, width, height, 0, capture time (µs)

let current = null

/** The trace being recorded, or null: live-tile.js asks on every frame. */
export const activeTrace = () => current

/**
 * Starts recording (one at a time: while one runs, that one is returned).
 * @param {{ durationMs?: number, page?: object, onDone?: (trace: object) => void, now?: () => number,
 *   wallNow?: () => number, later?: (fn: Function, ms: number) => any, cancel?: (t: any) => void }} [o]
 *   onDone: called once with the finished trace (the JSON's object), at the end or on stop
 */
export function startTrace(o = {}) {
  if (current) return current
  const t = new FrameTrace({
    ...o,
    onDone: (trace) => {
      if (current === t) current = null
      o.onDone?.(trace)
    }
  })
  current = t
  return t
}

/** Stops the trace being recorded now; its object (also handed to its onDone), or null when none runs. */
export const stopTrace = () => current?.stop() ?? null

export class FrameTrace {
  constructor({ durationMs = TRACE_MS, page = {}, onDone = () => {}, now = () => performance.now(), wallNow = () => Date.now(), later = (fn, ms) => setTimeout(fn, ms), cancel = (t) => clearTimeout(t) } = {}) {
    Object.assign(this, { durationMs, page, onDone, now, cancel })
    this.t0 = now()
    this.startedAt = new Date(wallNow()).toISOString()
    this.records = new Map() // tile -> its record (tiles in the order first seen)
    this.frames = 0
    this.truncated = false
    this.done = null // the finished trace, once stopped
    this.timer = later(() => this.stop(), durationMs)
  }

  /** ms since the start, to 0.1 ms */
  #at() {
    return Math.round((this.now() - this.t0) * 10) / 10
  }

  get elapsedMs() {
    return this.done ? this.durationMs : Math.min(this.durationMs, this.now() - this.t0)
  }

  /**
   * A tile's record, made the first time the tile is seen, with what it is doing then: a trace
   * started while a full-size view is open finds the grid's tiles and the two started ahead already
   * hidden, and the view already borrowing. Without a "suspend" first their hidden frames replay as
   * shown (the review of 29 Sep). `what`: the event being recorded, not said twice.
   */
  #rec(tile, what = null) {
    let r = this.records.get(tile)
    if (!r) {
      r = { id: this.records.size + 1, camera: `${tile.nvr}/${tile.ch + 1}`, nvr: tile.nvr, ch: tile.ch, stream: tile.streamType === 0 ? 'main' : 'sub', codec: null, capture0: null, us0: null, width: 0, height: 0, frames: [], events: [], stats: [] }
      this.records.set(tile, r)
      if (tile.suspended && what !== 'suspend') r.events.push([this.#at(), 'suspend'])
      if (tile.source && what !== 'borrow') r.events.push([this.#at(), 'borrow', this.#rec(tile.source).id])
    }
    return r
  }

  /** Whether the trace still takes things in: running, and within its time. */
  #open() {
    if (this.done) return false
    if (this.now() - this.t0 < this.durationMs) return true
    this.stop()
    return false
  }

  /**
   * One frame as it arrived on a tile's socket or channel (the 16-byte header, then the bitstream).
   * @param {{ nvr: string, ch: number, streamType: number }} tile
   * @param {Uint8Array} buf
   */
  frame(tile, buf) {
    if (!this.#open() || !(buf?.length > HEADER_SIZE)) return
    if (this.frames >= TRACE_MAX_FRAMES) {
      this.truncated = true
      return
    }
    const r = this.#rec(tile)
    const at = this.#at()
    const key = (buf[0] & 1) === 1
    const codec = buf[1] === 1 ? 'h265' : 'h264'
    if (r.codec !== codec) {
      if (r.codec !== null) r.events.push([at, 'codec', codec])
      r.codec = codec
    }
    const view = new DataView(buf.buffer, buf.byteOffset, buf.length)
    if (key) {
      // the camera's picture size, where the header has it (a converted stream's has 0)
      const w = view.getUint16(2, true)
      const h = view.getUint16(4, true)
      if (w > 0 && h > 0 && (w !== r.width || h !== r.height)) {
        r.width = w
        r.height = h
        r.events.push([at, 'size', w, h])
      }
    }
    const us = Number(view.getBigInt64(8, true))
    if (r.us0 === null) {
      r.us0 = us
      r.capture0 = us / 1000
    }
    r.frames.push([at, (us - r.us0) / 1000, buf.length, key ? 1 : 0])
    this.frames++
  }

  /** Something that happened to a tile's connection or display (see the file's events above). */
  event(tile, what, ...args) {
    if (!this.#open()) return
    const r = this.#rec(tile, what)
    r.events.push([this.#at(), what, ...args.map((a) => (a && typeof a === 'object' ? this.#rec(a).id : a))])
  }

  /** The D overlay's counters for a tile, once a second (live-tile.js updateStatus). */
  stats(tile, s) {
    if (!this.#open()) return
    this.#rec(tile).stats.push([this.#at(), s.fps, s.dropped, s.late, s.resyncs, s.delayMs])
  }

  /** Ends the recording (at once, or at the end of its time); the finished trace. */
  stop() {
    if (this.done) return this.done
    this.cancel(this.timer)
    this.done = {
      format: TRACE_FORMAT,
      version: TRACE_VERSION,
      startedAt: this.startedAt,
      durationMs: Math.round(Math.min(this.durationMs, this.now() - this.t0)),
      truncated: this.truncated,
      page: this.page,
      tiles: [...this.records.values()].map(({ us0, width, height, ...r }) => r)
    }
    this.onDone(this.done)
    return this.done
  }
}

/** The file name for a trace: where and when it was recorded. */
export function traceFileName(trace, host = '') {
  const when = trace.startedAt.replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-')
  const where = String(host).replace(/[^\w.-]+/g, '_')
  return `argus-trace-${where ? `${where}-` : ''}${when}.json`
}

/** Hands the trace to the browser as a file download (a local Blob: nothing is sent anywhere). */
export function downloadTrace(trace, host = location.host) {
  const blob = new Blob([JSON.stringify(trace)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = traceFileName(trace, host)
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
  return { name: a.download, bytes: blob.size }
}
