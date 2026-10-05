// Picture size from the sequence parameter set (SPS) in an Annex B keyframe, H.264 or H.265:
// the visible size, after the encoder's cropping (a 3200x1800 camera codes 3200x1808).
//
// The decoder needs it: WebCodecs configured without a size assumes 1280x720, and some
// hardware H.265 decoders (Intel on Windows) then keep 1280x720 as the visible part of
// every frame, so only the top-left of a bigger picture is shown.
//
// videoInfo() also reads the SPS's VUI: the range flag and colour description (TVT cameras
// flag limited range, with no colour description, but code the full 0-255 range: the
// display range fix and the picture measurement need to know) and the frame rate.

const CODEC_H265 = 1

class Bits {
  constructor(bytes) {
    this.b = bytes
    this.pos = 0
  }
  u(n) {
    let v = 0
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.pos >> 3]
      if (byte === undefined) throw new Error('SPS too short')
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1)
      this.pos++
    }
    return v
  }
  skip(n) {
    this.pos += n
    if (this.pos > this.b.length * 8) throw new Error('SPS too short')
  }
  ue() {
    let zeros = 0
    while (this.u(1) === 0) if (++zeros > 31) throw new Error('bad Exp-Golomb code')
    return 2 ** zeros - 1 + this.u(zeros)
  }
  se() {
    const k = this.ue()
    return k & 1 ? (k + 1) / 2 : -(k / 2)
  }
}

/** The SPS NAL unit's payload (after its header, emulation prevention removed), or null. */
function findSps(data, codecId) {
  const h265 = codecId === CODEC_H265
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) continue
    const type = h265 ? (data[i + 3] >> 1) & 0x3f : data[i + 3] & 0x1f
    if (type !== (h265 ? 33 : 7)) continue
    const start = i + 3 + (h265 ? 2 : 1)
    let end = start
    while (end + 2 < data.length && !(data[end] === 0 && data[end + 1] === 0 && data[end + 2] <= 1)) end++
    if (end + 2 >= data.length) end = data.length
    const out = []
    for (let j = start, zeros = 0; j < end && out.length < 512; j++) {
      if (zeros >= 2 && data[j] === 3) {
        zeros = 0
        continue
      }
      zeros = data[j] === 0 ? zeros + 1 : 0
      out.push(data[j])
    }
    return new Uint8Array(out)
  }
  return null
}

function h265Size(r) {
  r.skip(4) // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.u(3)
  r.skip(1)
  // profile_tier_level: general part, then per sub-layer
  r.skip(2 + 1 + 5 + 32 + 4 + 43 + 1 + 8)
  const present = []
  for (let i = 0; i < maxSubLayersMinus1; i++) present.push([r.u(1), r.u(1)])
  if (maxSubLayersMinus1 > 0) r.skip(2 * (8 - maxSubLayersMinus1))
  for (const [profile, level] of present) r.skip((profile ? 88 : 0) + (level ? 8 : 0))
  r.ue() // sps_seq_parameter_set_id
  const chroma = r.ue()
  const separate = chroma === 3 ? r.u(1) : 0
  let width = r.ue()
  let height = r.ue()
  if (r.u(1)) {
    const format = separate ? 0 : chroma
    const sx = format === 1 || format === 2 ? 2 : 1
    const sy = format === 1 ? 2 : 1
    const [left, right, top, bottom] = [r.ue(), r.ue(), r.ue(), r.ue()]
    width -= sx * (left + right)
    height -= sy * (top + bottom)
  }
  return { width, height, maxSubLayersMinus1 }
}

function h264Size(r) {
  const profile = r.u(8)
  r.skip(16) // constraint flags, level
  r.ue() // seq_parameter_set_id
  let chroma = 1
  let separate = 0
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = r.ue()
    if (chroma === 3) separate = r.u(1)
    r.ue()
    r.ue() // bit depths
    r.skip(1)
    if (r.u(1)) {
      // scaling matrices: parsed only to get past them
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (!r.u(1)) continue
        let last = 8
        let next = 8
        for (let j = 0; j < (i < 6 ? 16 : 64) && next !== 0; j++) {
          next = (last + r.se() + 256) % 256
          last = next === 0 ? last : next
        }
      }
    }
  }
  r.ue() // log2_max_frame_num_minus4
  const pocType = r.ue()
  if (pocType === 0) r.ue()
  else if (pocType === 1) {
    r.skip(1)
    r.se()
    r.se()
    const n = r.ue()
    for (let i = 0; i < n; i++) r.se()
  }
  r.ue() // max_num_ref_frames
  r.skip(1)
  const widthMbs = r.ue() + 1
  const heightUnits = r.ue() + 1
  const frameMbsOnly = r.u(1)
  if (!frameMbsOnly) r.skip(1)
  r.skip(1)
  let width = widthMbs * 16
  let height = (2 - frameMbsOnly) * heightUnits * 16
  if (r.u(1)) {
    const format = separate ? 0 : chroma
    const cx = format === 0 ? 1 : format === 3 ? 1 : 2
    const cy = (format === 0 ? 1 : format === 1 ? 2 : 1) * (2 - frameMbsOnly)
    const [left, right, top, bottom] = [r.ue(), r.ue(), r.ue(), r.ue()]
    width -= cx * (left + right)
    height -= cy * (top + bottom)
  }
  return { width, height }
}

// ---- the rest of the SPS, up to and through the VUI (only read by videoInfo) ----

function h265ScalingList(r) {
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
      if (!r.u(1)) r.ue() // scaling_list_pred_matrix_id_delta
      else {
        const n = Math.min(64, 1 << (4 + (sizeId << 1)))
        if (sizeId > 1) r.se() // dc coefficient
        for (let i = 0; i < n; i++) r.se()
      }
    }
  }
}

/** One st_ref_pic_set; returns its number of delta POCs (later sets may predict from it). */
function h265StRps(r, idx, num, counts) {
  if (idx !== 0 && r.u(1)) {
    // inter_ref_pic_set_prediction
    const deltaIdx = idx === num ? r.ue() + 1 : 1
    r.skip(1) // delta_rps_sign
    r.ue() // abs_delta_rps_minus1
    let n = 0
    for (let j = 0; j <= counts[idx - deltaIdx]; j++) {
      const used = r.u(1)
      if (used || r.u(1)) n++
    }
    return n
  }
  const neg = r.ue()
  const pos = r.ue()
  for (let i = 0; i < neg + pos; i++) {
    r.ue()
    r.skip(1)
  }
  return neg + pos
}

/** From just after the conformance window to vui_parameters_present_flag; true if a VUI follows. */
function h265ToVui(r, maxSubLayersMinus1) {
  r.ue()
  r.ue() // bit depths
  const pocBits = r.ue() + 4
  const ordering = r.u(1)
  for (let i = ordering ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
    r.ue()
    r.ue()
    r.ue()
  }
  for (let i = 0; i < 6; i++) r.ue() // coding and transform block sizes, hierarchy depths
  if (r.u(1) && r.u(1)) h265ScalingList(r) // scaling_list_enabled, then sps_scaling_list_data_present
  r.skip(2) // amp, sample_adaptive_offset
  if (r.u(1)) {
    // pcm
    r.skip(8)
    r.ue()
    r.ue()
    r.skip(1)
  }
  const numSets = r.ue()
  const counts = []
  for (let i = 0; i < numSets; i++) counts.push(h265StRps(r, i, numSets, counts))
  if (r.u(1)) {
    // long-term reference pictures
    const n = r.ue()
    for (let i = 0; i < n; i++) r.skip(pocBits + 1)
  }
  r.skip(2) // temporal mvp, strong intra smoothing
  return r.u(1) === 1
}

/** From just after the conformance window to vui_parameters_present_flag; true if a VUI follows. */
function h264ToVui(r) {
  return r.u(1) === 1
}

/**
 * The VUI fields both codecs share (aspect ratio, overscan, signal type), then their timing,
 * into `out` as they are read (a VUI cut short keeps what came before the cut).
 */
function vui(r, h265, out) {
  if (r.u(1) && r.u(8) === 255) r.skip(32) // aspect ratio (extended SAR)
  if (r.u(1)) r.skip(1) // overscan
  if (r.u(1)) {
    r.skip(3) // video_format
    out.fullRange = r.u(1) === 1
    if (r.u(1)) {
      const desc = { primaries: r.u(8), transfer: r.u(8), matrix: r.u(8) }
      out.colourCodes = [desc.primaries, desc.transfer, desc.matrix]
      // TVT cameras send 0/0/0: reserved primaries and transfer, and matrix 0 (identity, which
      // 4:2:0 video can't use). Like 2 (unspecified), that describes nothing.
      if (![desc.primaries, desc.transfer, desc.matrix].every((c) => c === 0 || c === 2)) out.colourDesc = desc
    }
  }
  if (r.u(1)) {
    r.ue()
    r.ue() // chroma sample location
  }
  if (h265) {
    r.skip(3) // neutral_chroma, field_seq, frame_field_info_present
    if (r.u(1)) for (let i = 0; i < 4; i++) r.ue() // default display window
  }
  if (r.u(1)) {
    const units = r.u(32)
    const scale = r.u(32)
    // H.264 counts fields (two ticks per frame); H.265 counts pictures
    const fps = units ? scale / (h265 ? units : 2 * units) : 0
    if (fps >= 1 && fps <= 240) out.fps = Math.round(fps * 1000) / 1000
  }
}

const sizeOk = (v) => Number.isInteger(v) && v >= 16 && v <= 16384

/** { width, height } of the picture, or null if the frame has no (readable) SPS. */
export function pictureSize(codecId, data) {
  const sps = findSps(data, codecId)
  if (!sps) return null
  try {
    const size = codecId === CODEC_H265 ? h265Size(new Bits(sps)) : h264Size(new Bits(sps))
    return sizeOk(size.width) && sizeOk(size.height) ? { width: size.width, height: size.height } : null
  } catch {
    return null
  }
}

/**
 * Picture size plus what the SPS's VUI says about the video, or null without a (readable) SPS:
 * { width, height, fullRange: true | false | null (not signalled),
 *   colourDesc: { primaries, transfer, matrix } (H.273 code points) | null: not signalled, or
 *     signalled with only reserved/unspecified codes (0 or 2; TVT sends 0/0/0),
 *   colourCodes: [primaries, transfer, matrix] as signalled | null,
 *   fps: number | null (no timing info) }.
 * A VUI that can't be read leaves those null; the size is still returned.
 */
export function videoInfo(codecId, data) {
  const sps = findSps(data, codecId)
  if (!sps) return null
  const h265 = codecId === CODEC_H265
  const r = new Bits(sps)
  let size
  try {
    size = h265 ? h265Size(r) : h264Size(r)
  } catch {
    return null
  }
  if (!sizeOk(size.width) || !sizeOk(size.height)) return null
  const info = { width: size.width, height: size.height, fullRange: null, colourDesc: null, colourCodes: null, fps: null }
  try {
    if (h265 ? h265ToVui(r, size.maxSubLayersMinus1) : h264ToVui(r)) vui(r, h265, info)
  } catch {}
  return info
}
