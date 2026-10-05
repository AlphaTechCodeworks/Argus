// How hard a camera's main stream presses against its bitrate cap, from the video the browser
// already receives (the NVR does no extra work): bytes per frame, which frames are keyframes,
// and so bytes per keyframe interval (GOP).
//
// Only NAL unit headers are read, never slice headers: these encoders set the real quantiser
// per block, so a slice QP says nothing (every HEVC clip had cu_qp_delta on and slice QP 26
// at usages from 0.45 to 0.95). Grading uses the rate against the cap only.
import { videoInfo } from './sps.js'

const CODEC_H265 = 1
const FORCED_S = 1 // a keyframe this soon after another was asked for (a viewer connecting), not scheduled
const JUMP_S = 5 // frames further apart than this: the stream restarted
const MIN_WINDOW_S = 20 // enough to grade: about 10 GOPs of 2 s
const SMART_GOP_S = 5 // H.265+/H.264+ send keyframes rarely: grade 10 s byte windows instead
const WINDOW_S = 10
const KEEP_S = 300 // older frames are forgotten
const BIND = 0.9 // a GOP (or window) at >= 90% of the cap counts as "at the cap"

/**
 * Whether an Annex B frame is a keyframe (H.264 IDR, type 5; HEVC IRAP, types 16-21), from the
 * first slice NAL's header. null when the frame has no slice at all.
 */
export function isKeyframe(codecId, data) {
  const h265 = codecId === CODEC_H265
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) continue
    const type = h265 ? (data[i + 3] >> 1) & 0x3f : data[i + 3] & 0x1f
    if (h265 ? type < 32 : type >= 1 && type <= 5) return h265 ? type >= 16 && type <= 21 : type === 5
    i += 2
  }
  return null
}

const median = (a) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s[s.length >> 1]
}
const r3 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000)

export class StreamMeter {
  constructor() {
    this.reset()
  }

  reset() {
    this.frames = [] // { ts (s), bytes, key, forced }, from the second scheduled keyframe on
    this.codecId = null
    this.info = null // videoInfo of the last keyframe with an SPS
    this.keys = 0 // scheduled keyframes seen since the reset
    this.lastKeyTs = null
    this.lastTs = null
    this.resets = (this.resets ?? -1) + 1
    // a mark made before the stream restarted: everything from the restart on is after it
    if (this.markTs !== null && this.markTs !== undefined) this.markTs = -Infinity
  }

  /**
   * Marks now (e.g. a setting was just applied): figures(qoi, { sinceMark: true }) then counts
   * only whole keyframe intervals that start after it, so a change's effect on the rate is not
   * diluted by the minutes before it.
   */
  mark() {
    this.markTs = this.lastTs ?? -Infinity
  }

  /** One encoded frame as the player receives it: { codecId, timestampUs, data, isKey? }. */
  add({ codecId, timestampUs, data, isKey }) {
    const ts = timestampUs / 1e6
    if (this.codecId !== null && codecId !== this.codecId) this.reset()
    // a reconnect or a stall: what came before is another stretch of stream
    if (this.lastTs !== null && (ts < this.lastTs || ts - this.lastTs > JUMP_S)) this.reset()
    this.codecId = codecId
    this.lastTs = ts
    const key = isKeyframe(codecId, data) ?? Boolean(isKey)
    let forced = false
    if (key) {
      const info = videoInfo(codecId, data)
      if (info) {
        if (this.info && (info.width !== this.info.width || info.height !== this.info.height)) {
          this.reset()
          this.codecId = codecId
          this.lastTs = ts
        }
        this.info = info
      }
      forced = this.lastKeyTs !== null && ts - this.lastKeyTs < FORCED_S
      if (!forced) {
        this.keys++
        this.lastKeyTs = ts
      }
    }
    // everything before the second scheduled keyframe is left out: a new connection starts
    // with the NVR's cached keyframe, whose GOP is cut short
    if (this.keys < 2) return
    this.frames.push({ ts, bytes: data.length, key: key && !forced, forced })
    while (this.frames.length > 2 && ts - this.frames[0].ts > KEEP_S) this.frames.shift()
    // keep the window starting at a scheduled keyframe
    while (this.frames.length && !this.frames[0].key) this.frames.shift()
  }

  /**
   * Figures over whole GOPs (or 10 s windows for smart codecs) since the second keyframe:
   * { windowS, enough, mode: 'gops' | 'windows', fps, kbps, gopS, gops: [{ s, kbps, iBytes }],
   *   qoi, usage, bindShare, iShare, forced, codec, width, height, fullRange }.
   * qoi is the camera's bitrate cap in kbit/s (null: usage and bindShare stay null).
   * enough: at least 20 s measured; before that the figures are provisional.
   * sinceMark: only from the first scheduled keyframe after mark() (all of it without a mark).
   */
  figures(qoi = null, { sinceMark = false } = {}) {
    let f = this.frames
    if (sinceMark && this.markTs !== null && this.markTs !== undefined) {
      const from = f.findIndex((x) => x.key && x.ts > this.markTs)
      f = from < 0 ? [] : f.slice(from)
    }
    const keyAt = []
    for (let i = 0; i < f.length; i++) if (f[i].key) keyAt.push(i)
    const gopS = keyAt.length > 1 ? median(keyAt.slice(1).map((k, j) => f[k].ts - f[keyAt[j]].ts)) : null
    const smart = gopS !== null && gopS > SMART_GOP_S
    const gops = []
    let end = -1 // frames [0, end) are counted
    if (!smart) {
      for (let j = 0; j + 1 < keyAt.length; j++) {
        const a = keyAt[j]
        const b = keyAt[j + 1]
        gops.push(this.#span(f, a, b, f[b].ts - f[a].ts))
      }
      end = keyAt.length > 1 ? keyAt[keyAt.length - 1] : -1
    } else {
      // byte windows of 10 s from the first keyframe
      let a = 0
      for (let i = 1; i < f.length; i++) {
        if (f[i].ts - f[a].ts < WINDOW_S) continue
        gops.push(this.#span(f, a, i, f[i].ts - f[a].ts))
        a = i
        end = i
      }
    }
    const windowS = end > 0 ? f[end].ts - f[0].ts : 0
    let bytes = 0
    let iBytes = 0
    let forced = 0
    for (let i = 0; i < end; i++) {
      if (f[i].forced) {
        forced++
        continue // an extra keyframe for a new viewer is not the camera's normal rate
      }
      bytes += f[i].bytes
      if (f[i].key) iBytes += f[i].bytes
    }
    const kbps = windowS > 0 ? (bytes * 8) / windowS / 1000 : null
    const usage = qoi && kbps !== null ? kbps / qoi : null
    const bound = qoi ? gops.filter((g) => g.kbps >= BIND * qoi).length : 0
    return {
      windowS: r3(windowS),
      enough: windowS >= MIN_WINDOW_S,
      mode: smart ? 'windows' : 'gops',
      fps: windowS > 0 ? r3(end / windowS) : null,
      kbps: kbps === null ? null : Math.round(kbps),
      gopS: r3(gopS),
      gops,
      qoi: qoi || null,
      usage: r3(usage),
      bindShare: qoi && gops.length ? r3(bound / gops.length) : null,
      iShare: bytes ? r3(iBytes / bytes) : null,
      forced,
      codec: this.codecId === null ? null : this.codecId === CODEC_H265 ? 'h265' : 'h264',
      width: this.info?.width ?? null,
      height: this.info?.height ?? null,
      fullRange: this.info?.fullRange ?? null
    }
  }

  /** Rate of frames f[a, b) over s seconds (forced keyframes left out). */
  #span(f, a, b, s) {
    let bytes = 0
    let iBytes = 0
    for (let i = a; i < b; i++) {
      const x = f[i]
      if (x.forced) continue
      bytes += x.bytes
      if (x.key) iBytes += x.bytes
    }
    return { s: r3(s), kbps: Math.round((bytes * 8) / s / 1000), iBytes }
  }
}
