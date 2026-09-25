// Server recordings read back as frames, for playback: the reverse of segment-writer.mjs.
//
// A segment file holds one camera's SDK payloads back to back (Annex B, never altered), and
// <file>.idx holds one 16-byte row per keyframe [uint64 LE offset, int64 LE time in ms]. Frame
// boundaries and frame times are not stored, so they are recovered here:
//  - Frames: the bytes are split into access units (splitUnits). A keyframe is a unit that starts
//    at an .idx offset.
//  - Times: the .idx times are arrival times at the worker and jitter by up to ~0.45 s (the NVR
//    sends in bursts). They are smoothed with a line fit per run of the file (smoothKeyTimes), and
//    the frames of a GOP are spaced evenly between its keyframe and the next one, unless that span
//    holds a hole: the NVR stalled and came back within the minute, and the recorder carried on in
//    the same file. Such a GOP (its frame step over 1.5x that of the GOPs around it) keeps their step
//    from its keyframe, and holeAfter(k) reports the rest of the span, which playback jumps like a
//    hole between files. Key times start inside the file's own arrival span (fileKeyTimes), and then
//    every GOP gets at least its frames x the file's measured frame step (#settle): after a stall the
//    NVR's catch-up burst can deliver whole GOPs within milliseconds, and those GOPs take their time
//    from the hole before them instead of being squeezed. The last GOP of a closed file goes at the
//    camera's step, evenly up to the next file's first keyframe when that follows on (nextStartMs),
//    so minute joins are seamless; it may run past endMs (the last P-frame's arrival).
// A file that is still being written can be read: .idx rows whose bytes are not on disk yet are
// ignored, the last (possibly incomplete) unit is held back, and refresh() picks up what has
// arrived since. Times already handed out for such a file never change and never go back.
//
// Does not import sdk.mjs (that loads koffi); CODEC matches sdk.mjs CODEC_H264 / CODEC_H265.
import * as fsp from 'node:fs/promises'
import { parseIdx } from './segment-writer.mjs'

export const CODEC = Object.freeze({ h264: 0, h265: 1 })
/** Frame spacing when nothing better is known (25 fps). */
export const DEFAULT_STEP_MS = 40
const KEY_CHUNK = 256 * 1024 // keyframe(): read this much at a time until the next unit starts
const MAX_READ = 4 * 1024 * 1024 // at most this much per read call
const FIT_MIN_ROWS = 4
const FIT_MAX_RESIDUAL_MS = 500
// smoothKeyTimes: a step further than this from the median ends a run (arrival jitter moves a key by up to
// ~0.3-0.45 s, so a step by up to about twice that; a GOP of another length or a burst is not jitter)
const RUN_DEV_MS = 600
const MIN_KEY_STEP_MS = 1 // keyframe times at least this far apart
// A closed file's last frame is placed this far before endMs (1 µs, the resolution of the wire's
// timestamps): the recorder stamps in whole ms, and the next file's first keyframe often arrived in
// the same burst, with the same stamp.
const END_EPS_MS = 0.001
// A hole inside a file (see #innerStep): a GOP whose frame step is over HOLE_RATIO x that of a GOP near it,
// looking at up to HOLE_NEIGHBOURS GOPs on each side
const HOLE_RATIO = 1.5
const HOLE_NEIGHBOURS = 2
const HOLE_REF_MIN_FRAMES = 5 // a GOP this short (a burst's fragment) is no reference for a frame step
// GOP floor (#settle): every GOP lasts at least its frames x the file's frame step (#fileStep). A GOP whose key span
// is under SUSPECT_SPAN x the median span is counted (read) to check; the others cannot be squeezed.
const SUSPECT_SPAN = 0.75
const STEP_REFS = 3 // GOPs of a typical span counted to measure the frame step
const STEP_REF_TRIES = 8
// minute joins: the last GOP of a closed file runs evenly up to the next file's first keyframe when that needs a
// step of at most JOIN_MAX x the camera's (a shorter one too: its frames must not run into the next file's);
// otherwise (a real gap) it keeps the camera's step
const JOIN_MAX = 1.33
// a burst at a file's start takes its time from the hole before only when the previous file ended this long before
// (that file's last GOP may run past its endMs by up to a GOP)
const PREV_TAIL_MS = 10_000
/** The last frame step measured per camera folder (a file too short to measure its own uses it). */
const cameraSteps = new Map()
const CAMERA_STEPS_MAX = 1000
const folderOf = (path) => String(path).replace(/[\\/][^\\/]*$/, '').replace(/[\\/]\d{4}-\d{2}-\d{2}[\\/]\d{2}$/, '')
const EMPTY = Buffer.alloc(0)
const SC3 = Buffer.from([0, 0, 1])
// NAL types that begin a new access unit once the current one has a picture (VCL NAL)
const START_264 = new Set([6, 7, 8, 9, 14, 15, 16, 17, 18]) // SEI, SPS, PPS, AUD, 14-18
const START_265 = new Set([32, 33, 34, 35, 39, 41, 42, 43, 44, 48, 49, 50, 51, 52, 53, 54, 55]) // VPS, SPS, PPS, AUD, prefix SEI, ...

const tsOf = (r) => (typeof r === 'number' ? r : r.tsMs)

/** The codec number of a segment file from its extension (.h264 / .h265). */
export const codecOfPath = (path) => (/\.h265$/i.test(String(path)) ? CODEC.h265 : CODEC.h264)

/**
 * Splits Annex B bytes into access units.
 * A new unit starts at the first of these NAL units after a picture (VCL) NAL has been seen:
 *   H.264: SEI, SPS, PPS, AUD, types 14-18, or a slice with first_mb_in_slice == 0;
 *   H.265: VPS, SPS, PPS, AUD, prefix SEI, 41-44, 48-55, or a slice with first_slice_segment_in_pic_flag.
 * Suffix SEI, end of sequence/stream and filler data stay with the current unit. With keyOffsets,
 * a unit also always starts at a key offset (an SDK keyframe starts there).
 * @param {Buffer} buf
 * @param {0|1} codec CODEC.h264 / CODEC.h265
 * @param {{ final?: boolean, keyOffsets?: Set<number>|null, base?: number }} [opts]
 *   final false: the bytes may continue (a growing file), so the last unit is held back;
 *   keyOffsets: file offsets of keyframes (the .idx), base: the file offset of buf[0].
 *   Without keyOffsets a unit is a keyframe when it holds an H.264 IDR (5) or H.265 IRAP (16-21) NAL.
 * @returns {{ units: { start: number, end: number, isKey: boolean }[], used: number }}
 *   used: bytes accounted for (the start of the held-back unit when final is false)
 */
export function splitUnits(buf, codec, { final = true, keyOffsets = null, base = 0 } = {}) {
  const units = []
  const n = buf.length
  let cur = null
  let sawVcl = false
  let from = 0
  for (;;) {
    const p = buf.indexOf(SC3, from)
    if (p < 0) break
    const h = p + 3 // the NAL header
    if (h + 2 >= n) break // its header is not all there (only at the very end)
    let s = p - 1 >= from && buf[p - 1] === 0 ? p - 1 : p // a 4-byte start code
    // a trailing zero byte of the previous frame, then a keyframe with a 3-byte start code
    if (keyOffsets && s !== p && !keyOffsets.has(base + s) && keyOffsets.has(base + p)) s = p
    let vcl, first, begins, key
    if (codec === CODEC.h265) {
      const t = (buf[h] >> 1) & 0x3f
      vcl = t < 32
      first = vcl && (buf[h + 2] & 0x80) !== 0
      begins = START_265.has(t)
      key = t >= 16 && t <= 21
    } else {
      const t = buf[h] & 0x1f
      vcl = t >= 1 && t <= 5
      first = vcl && (buf[h + 1] & 0x80) !== 0 // first_mb_in_slice == 0: ue(v) '1'
      begins = START_264.has(t)
      key = t === 5
    }
    const atKey = keyOffsets !== null && keyOffsets.has(base + s)
    if (!cur || atKey || (sawVcl && (begins || first))) {
      if (cur) cur.end = s
      cur = { start: s, end: n, isKey: atKey }
      units.push(cur)
      sawVcl = false
    }
    if (!keyOffsets && key) cur.isKey = true
    if (vcl) sawVcl = true
    from = h + 1
  }
  if (!final) return units.length ? { units: units.slice(0, -1), used: units.at(-1).start } : { units, used: 0 }
  return { units, used: n }
}

/** The last k with time <= t, or -1 (t before the first). rows: .idx rows or plain times, ascending. */
export function keyAtOrBefore(rows, t) {
  let lo = 0
  let hi = rows.length - 1
  let k = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (tsOf(rows[mid]) <= t) (k = mid), (lo = mid + 1)
    else hi = mid - 1
  }
  return k
}

/** The first k with time >= t, or -1 (t after the last). rows: .idx rows or plain times, ascending. */
export function keyAtOrAfter(rows, t) {
  let lo = 0
  let hi = rows.length - 1
  let k = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (tsOf(rows[mid]) >= t) (k = mid), (hi = mid - 1)
    else lo = mid + 1
  }
  return k
}

/**
 * Keyframe times with the arrival jitter smoothed out (strictly increasing).
 * The rows are split into runs wherever a step is under 0.5x or over 1.5x the median step, or more
 * than 600 ms from it (a gap, a burst, or a change of GOP length: the fit is per key index, so it
 * assumes GOPs of equal length, and across a 30-frame GOP among 60-frame ones it smeared the
 * difference over the run). In each run of 4 or more rows a least-squares line t = a + b*k is
 * fitted, and a row takes the fitted time when it is within 500 ms of it; otherwise (and in
 * shorter runs) it keeps its own time.
 * @param {({ tsMs: number }|number)[]} rows
 * @returns {number[]}
 */
export function smoothKeyTimes(rows) {
  const t = rows.map(tsOf)
  const out = t.slice()
  const n = t.length
  if (n >= FIT_MIN_ROWS) {
    const m = median(t.slice(1).map((v, k) => v - t[k]))
    if (m > 0) {
      let a = 0
      for (let k = 1; k <= n; k++) {
        const d = k < n ? t[k] - t[k - 1] : 0
        if (k === n || d < 0.5 * m || d > 1.5 * m || Math.abs(d - m) > RUN_DEV_MS) {
          fitRun(t, out, a, k - 1)
          a = k
        }
      }
    }
  }
  for (let k = 1; k < n; k++) if (!(out[k] > out[k - 1])) out[k] = out[k - 1] + MIN_KEY_STEP_MS
  return out
}

/**
 * A file's keyframe times: smoothKeyTimes, kept inside the file's own arrival span. The recorder
 * stamps every frame on arrival, so a file's first keyframe arrived no earlier than the previous
 * file's last frame; with these times the frames of consecutive files never go back.
 *  - Row 0 keeps its raw time (the segment's startMs), whatever the fit says.
 *  - Every later time comes at least 1 ms after the one before it and, with endMs, at most
 *    endMs - 1 µs (leaving 1 ms for each keyframe after it). Only a run of keyframes with raw
 *    times less than 1 ms apart at the very end could still go past that: strictly increasing wins.
 * @param {({ tsMs: number }|number)[]} rows
 * @param {{ endMs?: number|null }} [opts] endMs: the time of the file's last frame (a closed file)
 * @returns {number[]}
 */
export function fileKeyTimes(rows, { endMs = null } = {}) {
  const out = smoothKeyTimes(rows)
  const n = out.length
  if (!n) return out
  out[0] = tsOf(rows[0])
  const hi = endMs == null ? Infinity : endMs - END_EPS_MS
  for (let k = 1; k < n; k++) out[k] = Math.max(out[k - 1] + MIN_KEY_STEP_MS, Math.min(out[k], hi - (n - 1 - k) * MIN_KEY_STEP_MS))
  return out
}

function median(a) {
  if (!a.length) return 0
  const s = a.slice().sort((x, y) => x - y)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Least-squares line over t[a..b] (relative to t[a], for precision); fitted times into out. */
function fitRun(t, out, a, b) {
  const len = b - a + 1
  if (len < FIT_MIN_ROWS) return
  const y0 = t[a]
  let sy = 0
  for (let k = a; k <= b; k++) sy += t[k] - y0
  const xm = (len - 1) / 2
  const ym = sy / len
  let sxx = 0
  let sxy = 0
  for (let k = a; k <= b; k++) {
    const dx = k - a - xm
    sxx += dx * dx
    sxy += dx * (t[k] - y0 - ym)
  }
  const slope = sxy / sxx
  for (let k = a; k <= b; k++) {
    const fit = y0 + ym + slope * (k - a - xm)
    if (Math.abs(t[k] - fit) < FIT_MAX_RESIDUAL_MS) out[k] = fit
  }
}

const even = (t0, step, n) => Array.from({ length: n }, (_, i) => t0 + i * step)

/** Reads len bytes at pos (fewer at the end of the file), in calls of at most MAX_READ. */
async function readAt(fh, pos, len) {
  if (len <= 0) return EMPTY
  const buf = Buffer.allocUnsafe(len)
  let got = 0
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, Math.min(MAX_READ, len - got), pos + got)
    if (!bytesRead) break
    got += bytesRead
  }
  return got < len ? buf.subarray(0, got) : buf
}

/**
 * One segment file, read back as frames. Opened read-only; one operation at a time (not re-entrant).
 * Frame times within GOP k (n frames, T = fileKeyTimes): T[k] + i * (T[k+1] - T[k]) / n, or, when the
 * GOP holds a hole (#innerStep), T[k] + i * the step of a GOP near it, the rest up to T[k+1] being the
 * hole (holeAfter(k)).
 * The last GOP: at the previous GOP's step (or the file's); in a closed file evenly up to nextStartMs when
 * the next file follows on, and with a hole up to endMs when endMs is long after its frames. In a growing
 * file the same step: times handed out then are kept after it closes.
 */
export class SegmentReader {
  /**
   * @param {{ path: string, endMs?: number|null, growing?: boolean, fs?: object }} opts
   *   endMs: the time of the file's last frame (the index's end_ms); growing: still being written;
   *   fs: { open } like node:fs/promises (handles need read, stat, close)
   */
  constructor({ path, endMs = null, growing = false, fs = fsp, nextStartMs = null, prevEndMs = null }) {
    this.path = path
    this.endMs = endMs
    this.nextStartMs = nextStartMs // the next file's first keyframe (a closed file's last GOP runs up to it)
    this.prevEndMs = prevEndMs // the previous file's end: a burst at this file's start may go back to it, not further
    this.step = null // the file's frame step (#fileStep): { ms, refs }
    this.growing = growing
    this.fs = fs
    this.codec = codecOfPath(path)
    this.fh = null
    this.idxFh = null
    this.size = 0 // bytes of the data file this reader works with (as of the last open/refresh)
    this.rows = [] // .idx rows whose keyframe starts on disk: [{ offset, tsMs }]
    this.times = [] // smoothed key times, one per row
    this.allRows = [] // every whole .idx row read so far
    this.idxPos = 0
    this.keySet = new Set()
    this.counts = [] // frames per GOP, once a complete GOP has been split
    this.fixed = new Map() // k -> { ts, step?, final }: times handed out for a GOP read while it was growing
    this.holes = new Map() // k -> { fromMs, toMs }: a hole inside the file after GOP k's frames (holeAfter)
  }

  /** Opens the file and reads its .idx. Throws with the failure's code (ENOENT for a missing file). */
  async open() {
    try {
      this.fh = await this.fs.open(this.path, 'r')
      this.idxFh = await this.fs.open(`${this.path}.idx`, 'r')
      await this.#load()
      if (!this.growing) await this.#closeIdx()
    } catch (e) {
      await this.close()
      throw e
    }
    return this
  }

  /** A growing file: reads what has arrived since. True when there are new bytes or rows. */
  async refresh() {
    if (!this.growing || !this.fh || !this.idxFh) return false
    const size = this.size
    const n = this.rows.length
    await this.#load()
    return this.size !== size || this.rows.length !== n
  }

  /** The writer has closed a growing file (endMs: its last frame's time): reads the rest, then reads it as closed. */
  async markClosed(endMs = this.endMs, nextStartMs = this.nextStartMs) {
    if (endMs != null) this.endMs = endMs
    if (nextStartMs != null) this.nextStartMs = nextStartMs
    if (!this.growing) return
    this.growing = false // first: keyframes read now are timed as in a closed file (up to endMs)
    if (this.fh && this.idxFh) await this.#load()
    await this.#closeIdx()
  }

  /**
   * The frames of GOP k: [{ buf, isKey, ts }] (buf: a view into one read), [] when k is out of range.
   * Reads from rows[k].offset to rows[k+1].offset (or the end of the file for the last GOP).
   */
  async gop(k) {
    if (!this.fh || !(k >= 0 && k < this.rows.length)) return []
    const last = k === this.rows.length - 1
    const start = this.rows[k].offset
    const end = last ? this.size : this.rows[k + 1].offset
    const partial = last && this.growing
    const buf = await readAt(this.fh, start, end - start)
    const { units } = splitUnits(buf, this.codec, { final: !partial, keyOffsets: this.keySet, base: start })
    if (!partial) this.counts[k] = units.length
    const ts = await this.#frameTimes(k, units.length, partial)
    return units.map((u, i) => ({ buf: buf.subarray(u.start, u.end), isKey: u.isKey, ts: ts[i] }))
  }

  /**
   * Keyframe k alone: { buf, ts }, read in 256 KB chunks until the next unit starts. null when k is
   * out of range, or when it is the newest keyframe of a growing file and not complete yet.
   */
  async keyframe(k) {
    if (!this.fh || !(k >= 0 && k < this.rows.length)) return null
    const last = k === this.rows.length - 1
    const start = this.rows[k].offset
    const limit = last ? this.size : this.rows[k + 1].offset
    const partial = last && this.growing
    const ts = this.times[k]
    const opts = { keyOffsets: this.keySet, base: start }
    let acc = EMPTY
    for (let pos = start; ; ) {
      const want = Math.min(KEY_CHUNK, limit - pos)
      if (want > 0) {
        const b = await readAt(this.fh, pos, want)
        acc = acc.length ? Buffer.concat([acc, b]) : b
        pos = b.length < want ? limit : pos + b.length
      }
      const { units } = splitUnits(acc, this.codec, { ...opts, final: false })
      if (units.length) return { buf: acc.subarray(units[0].start, units[0].end), ts } // the next unit has started
      if (pos >= limit) {
        if (partial) return null
        const u = splitUnits(acc, this.codec, opts).units[0]
        return u ? { buf: acc.subarray(u.start, u.end), ts } : null
      }
    }
  }

  /**
   * The hole inside the file after GOP k's frames, once gop(k) has timed them (see #innerStep): { fromMs: its
   * last frame's time, toMs: the next keyframe's }, or null (its frames run up to the next keyframe).
   */
  holeAfter(k) {
    return this.holes.get(k) ?? null
  }

  /** Closes the file handles. */
  close() {
    const hs = [this.fh, this.idxFh].filter(Boolean)
    this.fh = null
    this.idxFh = null
    return Promise.all(hs.map((h) => h.close().catch(() => {}))).then(() => {})
  }

  async #closeIdx() {
    const h = this.idxFh
    this.idxFh = null
    if (h) await h.close().catch(() => {})
  }

  // The data file's size first, then the .idx: the writer writes a keyframe's row before its bytes,
  // so every keyframe with bytes below that size has its row by then.
  async #load() {
    this.size = (await this.fh.stat()).size
    const idxSize = (await this.idxFh.stat()).size
    const whole = Math.floor((idxSize - this.idxPos) / 16) * 16 // a partial last row is left for later
    if (whole > 0) {
      const b = await readAt(this.idxFh, this.idxPos, whole)
      const got = Math.floor(b.length / 16) * 16
      for (const r of parseIdx(b.subarray(0, got))) this.allRows.push(r)
      this.idxPos += got
    }
    const rows = []
    let prev = -1
    for (const r of this.allRows) {
      if (r.offset >= this.size) break // its bytes are not on disk yet
      if (r.offset <= prev) continue
      rows.push(r)
      prev = r.offset
    }
    this.rows = rows
    this.keySet = new Set(rows.map((r) => r.offset))
    const fixedBefore = Math.min(this.times.length, rows.length)
    this.#retime()
    await this.#settle(fixedBefore)
  }

  /**
   * The GOP floor: key times from `from` on (those before were handed out already) are moved so that every GOP
   * lasts at least its frames x the file's frame step. The .idx times are arrival times (files recorded before the
   * capture-time stamps, or when the header time was unusable), and after a stall the NVR sends what it buffered in
   * a burst: a GOP's keyframe can arrive milliseconds before the next one. Its frames were captured earlier, so the
   * time comes out of the hole before it: backwards from the newest key, a key moves earlier until its GOP fits
   * (never before the previous file's end, prevEndMs, nor, when that is not known, the file's own startMs); then
   * forwards, a key moves later where that was not enough. Only GOPs whose span is short (SUSPECT_SPAN) or that a
   * move touched are counted (read); the others cannot be squeezed.
   */
  async #settle(from) {
    const T = this.times
    const n = T.length
    if (n < 2 || from >= n) return
    const spans = T.slice(1).map((v, k) => v - T[k])
    const med = median(spans)
    const step = await this.#fileStep()
    if (!(step > 0)) return
    const moved = new Set()
    const minSpan = async (k) => (await this.#count(k)) * step
    // (a file of a few GOPs: the median may be the burst itself, so every GOP is checked)
    const few = n - 1 < FIT_MIN_ROWS
    const suspect = (k) => few || T[k + 1] - T[k] < SUSPECT_SPAN * med || moved.has(k) || moved.has(k + 1)
    const raw0 = tsOf(this.rows[0])
    const lo0 = from > 0 || this.prevEndMs == null ? raw0 : Math.min(raw0, this.prevEndMs + PREV_TAIL_MS)
    // backwards: take the time from the hole before
    for (let k = n - 2; k >= from; k--) {
      if (!suspect(k)) continue
      const want = T[k + 1] - (await minSpan(k))
      if (T[k] > want) {
        // key 0 not before lo0; the first new key of a growing file stays after the frames handed out before it
        const floor = k === 0 ? lo0 : k === from ? T[k] : -Infinity
        if (Math.max(want, floor) < T[k]) {
          T[k] = Math.max(want, floor)
          moved.add(k)
        }
      }
    }
    if (from === 0 && T[0] < lo0) T[0] = lo0
    // forwards: whatever did not fit
    for (let k = Math.max(from, 1); k < n; k++) {
      if (!suspect(k - 1) && k - 1 >= from) continue
      const want = T[k - 1] + (await minSpan(k - 1))
      if (T[k] < want) {
        T[k] = want
        moved.add(k)
      }
    }
  }

  /**
   * The file's frame step (ms): over up to STEP_REFS GOPs whose key span is nearest the median span (and with at
   * least HOLE_REF_MIN_FRAMES frames), their spans over their frames. A file too short for that takes its camera's
   * last measured step, else the median step of its GOPs, else DEFAULT_STEP_MS.
   */
  async #fileStep() {
    if (this.step && (this.step.refs >= STEP_REFS || !this.growing)) return this.step.ms
    const T = this.times
    const inner = T.length - 1
    let ms = null
    let refs = 0
    if (inner >= 1) {
      const spans = T.slice(1).map((v, k) => v - T[k])
      const med = median(spans)
      const order = spans.map((s, k) => k).sort((a, b) => Math.abs(spans[a] - med) - Math.abs(spans[b] - med))
      let span = 0
      let frames = 0
      for (const k of order.slice(0, STEP_REF_TRIES)) {
        if (refs >= STEP_REFS) break
        if (!(Math.abs(spans[k] - med) <= 0.1 * med)) break
        const c = await this.#count(k)
        if (c < HOLE_REF_MIN_FRAMES) continue
        span += spans[k]
        frames += c
        refs++
      }
      if (refs) ms = span / frames
    }
    const key = folderOf(this.path)
    if (ms != null && refs >= 2) {
      cameraSteps.delete(key)
      cameraSteps.set(key, ms)
      if (cameraSteps.size > CAMERA_STEPS_MAX) cameraSteps.delete(cameraSteps.keys().next().value)
    }
    // one reference GOP is not enough (a short restart file: it may be the NVR's prebuffer, sent in a burst)
    if (refs < 2) ms = cameraSteps.get(key) ?? ms
    if (ms == null && inner >= 1) {
      const steps = []
      for (let k = 0; k < inner; k++) {
        const c = await this.#count(k)
        if (c > 0) steps.push((T[k + 1] - T[k]) / c)
      }
      if (steps.length) ms = median(steps)
    }
    if (!(ms > 0)) ms = DEFAULT_STEP_MS
    this.step = { ms, refs }
    return ms
  }

  // Key times for the rows (fileKeyTimes, up to endMs once the file is closed). Times already
  // computed stay as they were (a growing file: frames may have been handed out with them); a new
  // row comes after the frames handed out before it.
  #retime() {
    const fresh = fileKeyTimes(this.rows, { endMs: this.growing ? null : this.endMs })
    const old = this.times
    for (let k = 0; k < fresh.length; k++) {
      if (k < old.length) {
        fresh[k] = old[k]
        continue
      }
      if (k === 0) continue
      const f = this.fixed.get(k - 1)
      const floor = f && !f.final && f.ts.length ? Math.max(fresh[k - 1] + 1, f.ts.at(-1) + f.step) : fresh[k - 1] + 1
      if (fresh[k] < floor) fresh[k] = floor
    }
    this.times = fresh
  }

  /** Whether GOP j is complete with a keyframe after it (an inner GOP: its span is known). */
  #inner(j) {
    return j >= 0 && j < this.rows.length - 1
  }

  /** The number of frames of inner GOP j (splitting it if it has not been read). */
  async #count(j) {
    let n = this.counts[j]
    if (n == null) {
      const start = this.rows[j].offset
      const buf = await readAt(this.fh, start, this.rows[j + 1].offset - start)
      n = this.counts[j] = splitUnits(buf, this.codec, { keyOffsets: this.keySet, base: start }).units.length
    }
    return n
  }

  /** The even frame step of inner GOP j (its span over its frames), or null (also for a GOP of a few frames: no reference). */
  async #rawStep(j, minFrames = 1) {
    if (!this.#inner(j)) return null
    const n = await this.#count(j)
    return n >= minFrames ? (this.times[j + 1] - this.times[j]) / n : null
  }

  /**
   * The frame step of inner GOP k (n frames): { step, hole }. Its frames are spaced evenly up to the next
   * keyframe, unless the GOP holds a hole: the NVR stalled and came back within the minute, and the recorder
   * carried on in the same file, so the span to the next keyframe includes the silence. That is taken to be the
   * case when, on each side of k that has inner GOPs, one of the nearest HOLE_NEIGHBOURS has a frame step under
   * 1 / HOLE_RATIO of k's even step. Its frames then go at the nearest such step before k (else after it), from
   * its keyframe, and the rest of the span is a hole (hole: true). A long GOP at the same frame rate, keyframes-only
   * footage and a change of frame rate (the GOPs on one side of it have its step) are not holes; two holes in a
   * row are (the next GOP out on that side counts). Only a neighbour that k is over HOLE_RATIO x as long as is
   * split (read), and the side after k only when the side before it says hole, so steady footage (also with
   * GOPs of varying length) costs no reads; a stall shorter than about half a GOP can go unnoticed.
   */
  async #innerStep(k, n) {
    const T = this.times
    const span = T[k + 1] - T[k]
    const step = span / n
    let found = null
    for (const dir of [-1, 1]) {
      let side = false
      let ref = null
      for (let d = 1; d <= HOLE_NEIGHBOURS && ref === null; d++) {
        const j = k + dir * d
        if (!this.#inner(j)) break
        side = true
        if (!(span > HOLE_RATIO * (T[j + 1] - T[j]))) continue // not much longer than GOP j (no read)
        // (a burst's fragment of a few frames is no reference for a normal GOP: keyframes-only footage still is)
        const s = await this.#rawStep(j, n >= HOLE_REF_MIN_FRAMES ? HOLE_REF_MIN_FRAMES : 1)
        if (s !== null && step > HOLE_RATIO * s) ref = s
      }
      if (!side) continue
      if (ref === null) return { step, hole: false } // GOPs on this side have its step
      found ??= ref
    }
    return found === null ? { step, hole: false } : { step: found, hole: true }
  }


  #noteHole(k, hole, fromMs, toMs) {
    if (hole) this.holes.set(k, { fromMs, toMs })
    else this.holes.delete(k)
  }

  async #frameTimes(k, n, partial) {
    if (n === 0) return []
    const f = this.fixed.get(k)
    if (f?.final && f.ts.length === n) return f.ts.slice()
    const tail = f && !f.final ? f.ts.slice(0, n) : null // times handed out while this GOP was growing
    const Tk = this.times[k]
    if (k < this.rows.length - 1) {
      const Tn = this.times[k + 1]
      if (!tail) {
        const { step, hole } = await this.#innerStep(k, n)
        const ts = even(Tk, step, n)
        this.#noteHole(k, hole, ts.at(-1), Tn)
        // a growing file: the GOPs after this one may still change the answer; the times handed out stay
        if (this.growing) this.fixed.set(k, { ts, final: true })
        return ts.slice()
      }
      // the rest of the GOP spread evenly between the last time handed out and the next keyframe; at the step
      // the handed-out part went at when that would be over HOLE_RATIO x slower (the NVR stalled meanwhile: a hole)
      const L = tail.at(-1)
      const r = n - tail.length
      const span = Tn > L ? Tn - L : r + 1
      const hole = span / (r + 1) > HOLE_RATIO * f.step
      const ts = [...tail, ...Array.from({ length: r }, (_, j) => (hole ? L + (j + 1) * f.step : L + ((j + 1) * span) / (r + 1)))]
      this.#noteHole(k, hole, ts.at(-1), Tn)
      this.fixed.set(k, { ts, final: true })
      return ts.slice()
    }
    // the step of the nearest GOP before it that is not a burst's fragment (a frame rate change carries on); else the file's
    let prev = null
    for (let j = k - 1; (n > 1 || partial) && prev === null && j >= Math.max(0, k - 3); j--) {
      const c = await this.#count(j)
      if (c >= HOLE_REF_MIN_FRAMES) prev = (await this.#innerStep(j, c)).step
    }
    const base = prev ?? (n > 1 || partial ? await this.#fileStep() : DEFAULT_STEP_MS)
    if (partial) {
      const step = base
      const ts = even(Tk, step, n)
      if (tail) tail.forEach((v, i) => (ts[i] = v))
      this.fixed.set(k, { ts, step, final: false })
      return ts.slice()
    }
    // the last GOP of a closed file: at the camera's step, never squeezed to end at endMs (the last P-frame's arrival:
    // keyframes arrive later than P-frames, so that gave a speed-up and then a still at every minute join). When the
    // next file follows on, evenly up to its first keyframe (up to JOIN_MAX x the step; never into it), so the join is
    // seamless; when endMs is long after the frames (the NVR stalled in this GOP), the rest up to endMs is a hole.
    const from = tail ? tail.at(-1) : Tk
    const r = tail ? n - tail.length : n - 1
    let step = base
    let stalled = false
    if (r > 0) {
      const next = this.nextStartMs
      const join = next != null && next > from ? (next - from) / (r + 1) : null
      if (this.endMs != null && (this.endMs - from) / r > HOLE_RATIO * base && !(join !== null && join <= JOIN_MAX * base)) stalled = true
      else if (join !== null && join <= JOIN_MAX * base) step = join
    }
    // the rest of the span up to endMs is a hole (holeAfter): the pacer jumps it with a notice
    // instead of showing the GOP's last picture as a still for up to a minute
    const last = from + r * step
    this.#noteHole(k, stalled, last, this.endMs)
    if (!tail) return even(Tk, step, n)
    const ts = [...tail, ...Array.from({ length: r }, (_, j) => from + (j + 1) * step)]
    this.fixed.set(k, { ts, final: true })
    return ts.slice()
  }
}
