// A small MPEG-TS writer for one video stream: the camera's own H.264 or H.265 frames (Annex-B, as
// the hub hands them out), each with its capture time, wrapped so ffmpeg can copy them on without
// guessing anything (rtsp.mjs: the feed into the RTSP server).
//
// Why not the bare Annex-B: a raw stream carries no times, so ffmpeg makes them up at 25 frames a
// second whatever the camera sends (a 20 fps camera drifts a second every 5), and it carries no
// codec, which ffmpeg would have to be told on its command line before the first frame is known.
// MPEG-TS says the codec in its programme table and each frame's time in its header.
//
// Video only, no B-frames (IP cameras send none): every frame's PTS is its DTS. PAT and PMT go
// before every keyframe, the clock (PCR) with every frame, the keyframes are marked random access.
// Pure: Buffers in, Buffers out. Tested in test/ts-mux.test.mjs.

export const TS_PACKET = 188
export const PMT_PID = 0x1000
export const VIDEO_PID = 0x100
export const STREAM_TYPE = { h264: 0x1b, h265: 0x24 }
const CLOCK = 90 // 90 kHz ticks per ms
/** Where the first frame's PTS starts (2 s), so the PCR a little behind it is never negative. */
export const START_TICKS = 2 * 90_000
const PCR_LEAD = 300 * CLOCK // the clock runs 300 ms behind the frames
/** A step in the camera's times bigger than this (or backwards) is a jump, not the stream's rate. */
export const JUMP_MS = 5_000
const WRAP = 2 ** 33

/** CRC-32/MPEG-2, for the PAT and PMT. */
export function crc32mpeg(buf) {
  let crc = 0xffffffff
  for (const b of buf) {
    crc ^= b << 24
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0
  }
  return crc >>> 0
}

/** A PSI section (table id, then its body), with its length and CRC. */
function section(tableId, body) {
  const len = body.length + 4 // + CRC
  const head = Buffer.from([tableId, 0xb0 | ((len >> 8) & 0x0f), len & 0xff])
  const withoutCrc = Buffer.concat([head, body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32mpeg(withoutCrc))
  return Buffer.concat([withoutCrc, crc])
}

export function patSection() {
  // transport stream id 1, version 0, current; section 0 of 0; programme 1 -> PMT_PID
  return section(0x00, Buffer.from([0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff]))
}

export function pmtSection(codec) {
  const type = STREAM_TYPE[codec]
  if (!type) throw new Error(`unknown codec ${codec}`)
  return section(0x02, Buffer.from([
    0x00, 0x01, 0xc1, 0x00, 0x00, // programme 1, version 0, current, section 0 of 0
    0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, // the PCR is on the video PID
    0xf0, 0x00, // no programme descriptors
    type, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0x00 // the one stream, no descriptors
  ]))
}

/** One TS packet holding a whole PSI section (pointer field 0, the rest 0xff). */
function psiPacket(pid, sectionBuf, cc) {
  const p = Buffer.alloc(TS_PACKET, 0xff)
  p[0] = 0x47
  p[1] = 0x40 | ((pid >> 8) & 0x1f)
  p[2] = pid & 0xff
  p[3] = 0x10 | (cc & 0x0f)
  p[4] = 0x00
  sectionBuf.copy(p, 5)
  return p
}

function writeTimestamp(buf, at, marker, ticks) {
  const t = BigInt(Math.round(ticks)) % BigInt(WRAP)
  buf[at] = (marker << 4) | (Number((t >> 30n) & 0x07n) << 1) | 1
  buf[at + 1] = Number((t >> 22n) & 0xffn)
  buf[at + 2] = (Number((t >> 15n) & 0x7fn) << 1) | 1
  buf[at + 3] = Number((t >> 7n) & 0xffn)
  buf[at + 4] = (Number(t & 0x7fn) << 1) | 1
}

/** The PES header of one video frame with its PTS (length 0: unbounded, as video may be). */
export function pesHeader(ptsTicks) {
  const h = Buffer.alloc(14)
  h[0] = 0x00
  h[1] = 0x00
  h[2] = 0x01
  h[3] = 0xe0 // video stream 0
  h[4] = 0x00
  h[5] = 0x00
  h[6] = 0x84 // '10', data alignment
  h[7] = 0x80 // PTS only
  h[8] = 0x05
  writeTimestamp(h, 9, 0x2, ptsTicks)
  return h
}

function pcrField(ticks) {
  const base = BigInt(Math.max(0, Math.round(ticks))) % BigInt(WRAP)
  const f = Buffer.alloc(6)
  f[0] = Number((base >> 25n) & 0xffn)
  f[1] = Number((base >> 17n) & 0xffn)
  f[2] = Number((base >> 9n) & 0xffn)
  f[3] = Number((base >> 1n) & 0xffn)
  f[4] = (Number(base & 1n) << 7) | 0x7e // 6 reserved bits, extension 0 (high bit)
  f[5] = 0x00
  return f
}

/**
 * The muxer for one feed. frame(payload, { isKey, codec: 'h264'|'h265', tsMs }) returns the TS bytes
 * for that frame (a Buffer, possibly with PAT and PMT first), or null for a frame that cannot start a
 * stream (a delta before the first keyframe).
 */
export class TsMuxer {
  constructor() {
    this.cc = { pat: 0, pmt: 0, video: 0 }
    this.codec = null
    this.lastMs = null // the camera's time of the last frame
    this.pts = null // its PTS, in 90 kHz ticks
  }

  /** The PTS for a frame at the camera's time tsMs: continuous across the camera's jumps, always rising. */
  ptsFor(tsMs) {
    if (this.pts === null || !Number.isFinite(tsMs)) {
      this.pts = this.pts === null ? START_TICKS : this.pts + 40 * CLOCK
    } else {
      const step = tsMs - this.lastMs
      // a clock set back, or a hole of seconds: carried on as one frame at 25 fps, not a jump; two
      // frames at the same time: one tick apart (the times must rise)
      const ms = step > 0 && step <= JUMP_MS ? step : step === 0 ? 1 / CLOCK : 40
      this.pts += Math.max(1, Math.round(ms * CLOCK))
    }
    if (Number.isFinite(tsMs)) this.lastMs = tsMs
    return this.pts
  }

  frame(payload, { isKey, codec, tsMs }) {
    if (!STREAM_TYPE[codec]) return null
    if (this.codec === null && !isKey) return null
    if (this.codec !== null && this.codec !== codec) throw new Error(`the codec changed from ${this.codec} to ${codec}`)
    this.codec = codec
    const pts = this.ptsFor(tsMs)
    const out = []
    if (isKey) {
      out.push(psiPacket(0, patSection(), this.cc.pat++))
      out.push(psiPacket(PMT_PID, pmtSection(codec), this.cc.pmt++))
    }
    const pes = Buffer.concat([pesHeader(pts), payload])
    let at = 0
    let first = true
    while (at < pes.length) {
      const p = Buffer.alloc(TS_PACKET, 0xff)
      p[0] = 0x47
      p[1] = (first ? 0x40 : 0x00) | ((VIDEO_PID >> 8) & 0x1f)
      p[2] = VIDEO_PID & 0xff
      // the adaptation field: the clock (and random access) on the first packet, stuffing on the last
      let adapt = null
      if (first) {
        const pcr = pcrField(pts - PCR_LEAD)
        adapt = Buffer.concat([Buffer.from([isKey ? 0x50 : 0x10]), pcr]) // flags: (random access) + PCR
      }
      const room = TS_PACKET - 4 - (adapt ? adapt.length + 1 : 0)
      const left = pes.length - at
      if (left < room) {
        // stuffing: the adaptation field grows by what is missing
        const pad = room - left
        if (adapt) adapt = Buffer.concat([adapt, Buffer.alloc(pad, 0xff)])
        else adapt = pad === 1 ? Buffer.alloc(0) : Buffer.concat([Buffer.from([0x00]), Buffer.alloc(pad - 2, 0xff)])
      }
      let o = 4
      if (adapt) {
        p[3] = 0x30 | (this.cc.video & 0x0f)
        p[4] = adapt.length
        adapt.copy(p, 5)
        o = 5 + adapt.length
      } else {
        p[3] = 0x10 | (this.cc.video & 0x0f)
      }
      const n = Math.min(TS_PACKET - o, left)
      pes.copy(p, o, at, at + n)
      at += n
      this.cc.video++
      first = false
      out.push(p)
    }
    return Buffer.concat(out)
  }
}
