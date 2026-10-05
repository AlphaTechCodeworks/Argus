// Recorded H.264 / H.265 frames wrapped in an MP4 container, with nothing re-encoded.
//
// The frames come off disk as the camera sent them (Annex B, see segment-writer.mjs) and are read
// back by rec-reader.mjs as { buf, isKey, ts }. All this module does is change the framing: the
// Annex B start codes become 4-byte lengths, which is what MP4 needs, and the NAL unit payloads
// are copied through byte for byte. An export whose pixels were touched is worthless as evidence,
// so there is no decoder, no encoder and no ffmpeg anywhere in here.
//
// Flavour: a plain (progressive) MP4 — ftyp, moov, mdat — not a fragmented one. A fragmented MP4
// would let us stream the file out as we go, but every fragment repeats a default duration and
// CCTV frame timing is not constant: the per-frame durations of a real sample table are the honest
// record of when each picture was captured. A plain file also seeks in any player without an
// index being rebuilt. moov is written before mdat (the chunk offset is patched in afterwards),
// so the file plays while it is still being copied over a network.
//
// What it does NOT do:
//  - No audio, one video track per file, no B-frames: the samples are written in the order given
//    and no ctts (composition offset) box is produced. TVT cameras code IPPP, so decode order and
//    presentation order are the same; a stream with B-frames would play with the wrong picture
//    order. There is nothing in the recorded data that would let us recover a real DTS.
//  - No edit list, so the first sample is at time zero; the wall-clock time of the clip belongs in
//    the export manifest (export-pack.mjs), not in the container.
//  - hvcC's chroma format and bit depth are written as 4:2:0 8-bit rather than parsed out of the
//    SPS. Every TVT camera codes that, and no player is known to reject a file over those fields,
//    but a 10-bit stream would be mis-described.
//  - Parameter sets are left in the samples as well as being copied into avcC / hvcC. Strictly,
//    'avc1' and 'hvc1' mean the parameter sets live only in the sample entry ('avc3' / 'hev1'
//    allow them in-band), but avc1/hvc1 is what players actually support, and every decoder in
//    practice ignores a repeated SPS. Dropping them from the samples would mean the bytes in the
//    file were no longer exactly what was recorded, which is the one thing that must not happen.
//
// Verified against: the structural tests in cctv/test/mp4.test.mjs, which parse the output back.
// Not yet verified by playing a file produced from real recorded footage in VLC, ffprobe,
// QuickTime or a browser — see the report for Task 2.
import { pictureSize } from './public/sps.js'

const SPS_CODEC_H265 = 1 // the codec id sps.js expects
const DEFAULT_TIMESCALE = 1000 // ticks per second; frame times arrive in ms
const DEFAULT_FRAME_MS = 40 // a lone frame's duration (25 fps), when there is no gap to measure
const MAX_NAL_LENGTH_SIZE = 4 // the length prefix this module writes, and declares in avcC / hvcC

// NAL unit types we have to recognise to build the codec configuration
const H264_NAL = { sps: 7, pps: 8 }
const H265_NAL = { vps: 32, sps: 33, pps: 34 }

const u8 = (v) => Buffer.from([v & 0xff])
const u16 = (v) => {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(v & 0xffff)
  return b
}
const u32 = (v) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(v >>> 0)
  return b
}
const str = (s) => Buffer.from(s, 'latin1')

/** A box: its size, its type, then its contents. */
const box = (type, ...parts) => {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))))
  return Buffer.concat([u32(body.length + 8), str(type), body])
}
/** A full box: a version and 24 flag bits before the contents. */
const fullBox = (type, version, flags, ...parts) => box(type, u8(version), u8(flags >> 16), u8(flags >> 8), u8(flags), ...parts)

/**
 * Annex B bytes split into NAL unit payloads (the start codes dropped, nothing else touched).
 * A zero byte immediately before a 3-byte start code belongs to that start code (a 4-byte one);
 * any further zeros stay with the NAL unit before it, as they are in the recorded bytes. This is
 * the same rule rec-reader.mjs splitUnits() uses, so the two agree on where a unit begins.
 * @param {Buffer} bytes
 * @returns {Buffer[]}
 */
export function splitNals(bytes) {
  const starts = []
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      starts.push(i)
      i += 2
    }
  }
  const out = []
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k] + 3
    let to = k + 1 < starts.length ? starts[k + 1] : bytes.length
    if (k + 1 < starts.length && to - 1 > from && bytes[to - 1] === 0) to -= 1
    if (to > from) out.push(bytes.subarray(from, to))
  }
  return out
}

/** The NAL unit type of a payload, or -1 when it is too short to have a header. */
const nalType = (nal, h265) => (nal.length < (h265 ? 2 : 1) ? -1 : h265 ? (nal[0] >> 1) & 0x3f : nal[0] & 0x1f)

/**
 * The RBSP of a NAL unit payload: its header removed and the emulation prevention bytes taken out.
 * Only used to read the fixed fields at the front of an H.265 SPS (the profile, tier and level,
 * which hvcC repeats); the bytes stored in the file are always the untouched original.
 */
function rbsp(nal, headerBytes, limit = 64) {
  const out = []
  let zeros = 0
  for (let i = headerBytes; i < nal.length && out.length < limit; i++) {
    if (zeros >= 2 && nal[i] === 3) {
      zeros = 0
      continue
    }
    zeros = nal[i] === 0 ? zeros + 1 : 0
    out.push(nal[i])
  }
  return Buffer.from(out)
}

/** The parameter sets the frames carry: the first of each kind wins (they repeat every keyframe). */
function parameterSets(frames, h265) {
  const wanted = h265 ? H265_NAL : H264_NAL
  const found = { vps: null, sps: null, pps: null }
  for (const frame of frames) {
    for (const nal of splitNals(frame.bytes)) {
      const t = nalType(nal, h265)
      for (const [name, type] of Object.entries(wanted)) if (t === type && !found[name]) found[name] = nal
    }
    if (found.sps && found.pps && (!h265 || found.vps)) break
  }
  return found
}

/**
 * avcC (ISO/IEC 14496-15): the H.264 decoder configuration. The profile, compatibility and level
 * bytes are the first three of the SPS's RBSP, so they always agree with the SPS stored beside them.
 */
function avcC(sps, pps) {
  const head = rbsp(sps, 1, 3)
  if (head.length < 3) throw new Error('writeMp4: the H.264 SPS is too short to read its profile and level')
  return box(
    'avcC',
    u8(1), // configurationVersion
    u8(head[0]), // AVCProfileIndication
    u8(head[1]), // profile_compatibility
    u8(head[2]), // AVCLevelIndication
    u8(0xfc | (MAX_NAL_LENGTH_SIZE - 1)), // 6 reserved bits, then lengthSizeMinusOne
    u8(0xe0 | 1), // 3 reserved bits, then numOfSequenceParameterSets
    u16(sps.length),
    sps,
    u8(1), // numOfPictureParameterSets
    u16(pps.length),
    pps,
  )
}

/**
 * hvcC (ISO/IEC 14496-15): the H.265 decoder configuration. The 12 bytes of profile_tier_level sit
 * at a fixed, byte-aligned place in the SPS (after sps_video_parameter_set_id, max_sub_layers_minus1
 * and temporal_id_nesting_flag, which are one byte together), so they can be copied straight across.
 */
function hvcC(vps, sps, pps) {
  const head = rbsp(sps, 2, 16)
  if (head.length < 13) throw new Error('writeMp4: the H.265 SPS is too short to read its profile, tier and level')
  const maxSubLayersMinus1 = (head[0] >> 1) & 7
  const temporalIdNested = head[0] & 1
  const ptl = head.subarray(1, 13) // profile_space/tier/profile_idc, compatibility flags, constraint flags, level
  const arrays = [
    [H265_NAL.vps, vps],
    [H265_NAL.sps, sps],
    [H265_NAL.pps, pps],
  ]
  return box(
    'hvcC',
    u8(1), // configurationVersion
    ptl, // general_profile_space .. general_level_idc, exactly as the SPS codes them
    u16(0xf000), // 4 reserved bits set, min_spatial_segmentation_idc = 0 (not signalled)
    u8(0xfc), // 6 reserved bits set, parallelismType = 0 (unknown)
    u8(0xfc | 1), // chromaFormat: 4:2:0 (see the header note)
    u8(0xf8), // bitDepthLumaMinus8 = 0
    u8(0xf8), // bitDepthChromaMinus8 = 0
    u16(0), // avgFrameRate: 0, unspecified — the sample table carries the real timing
    // constantFrameRate = 0 (unknown), numTemporalLayers, temporalIdNested, lengthSizeMinusOne
    u8((0 << 6) | ((maxSubLayersMinus1 + 1) << 3) | (temporalIdNested << 2) | (MAX_NAL_LENGTH_SIZE - 1)),
    u8(arrays.length),
    ...arrays.flatMap(([type, nal]) => [
      u8(0x80 | type), // array_completeness: these are all the parameter sets of this kind
      u16(1), // numNalus
      u16(nal.length),
      nal,
    ]),
  )
}

/** A visual sample entry ('avc1' or 'hvc1'), holding the codec configuration box. */
const sampleEntry = (name, width, height, config) =>
  box(
    name,
    Buffer.alloc(6), // reserved
    u16(1), // data_reference_index
    u16(0),
    u16(0),
    Buffer.alloc(12), // pre_defined and reserved
    u16(width),
    u16(height),
    u32(0x00480000), // horizresolution: 72 dpi
    u32(0x00480000), // vertresolution
    u32(0), // reserved
    u16(1), // frame_count: one picture per sample
    Buffer.alloc(32), // compressorname: empty
    u16(0x0018), // depth: colour, no alpha
    u16(0xffff), // pre_defined: -1
    config,
  )

/** stts, run-length encoded: consecutive samples of equal duration share an entry. */
function stts(durations) {
  const runs = []
  for (const d of durations) {
    const last = runs.at(-1)
    if (last && last[1] === d) last[0]++
    else runs.push([1, d])
  }
  return fullBox('stts', 0, 0, u32(runs.length), ...runs.flatMap(([count, delta]) => [u32(count), u32(delta)]))
}

/**
 * Wraps already-encoded frames in an MP4 container. The NAL unit payloads are copied unchanged.
 * @param {{ frames: { bytes: Buffer|Uint8Array, ptsMs: number, keyframe: boolean }[],
 *           codec: 'h264'|'h265', timescale?: number }} opts
 *   frames: in time order, ptsMs relative to anything (only the gaps are used); timescale: ticks
 *   per second in the file, 1000 by default so a millisecond is a tick.
 * @returns {Buffer} the whole file
 * @throws {Error} with a plain message when the frames cannot make a valid file: no frames, an
 *   unknown codec, no keyframe among them, or parameter sets missing from the stream.
 */
export function writeMp4({ frames, codec, timescale = DEFAULT_TIMESCALE } = {}) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('writeMp4: no frames to write')
  if (codec !== 'h264' && codec !== 'h265') throw new Error(`writeMp4: unknown codec ${JSON.stringify(codec)}, expected 'h264' or 'h265'`)
  if (!(timescale > 0)) throw new Error('writeMp4: timescale must be a positive number')
  const h265 = codec === 'h265'
  const list = frames.map((f) => ({ ...f, bytes: Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(f.bytes ?? []) }))
  if (!list.some((f) => f.keyframe)) {
    throw new Error('writeMp4: none of the frames is a keyframe, so nothing could be decoded or seeked to')
  }

  const sets = parameterSets(list, h265)
  const missing = ['vps', 'sps', 'pps'].filter((k) => (k !== 'vps' || h265) && !sets[k])
  if (missing.length) {
    throw new Error(`writeMp4: the frames carry no ${missing.map((k) => k.toUpperCase()).join(' and no ')}, so no codec configuration can be written`)
  }

  // The picture size comes from the same SPS parser the players and the picture checks use
  // (public/sps.js), so an export states the size the rest of the system agrees on.
  const size = pictureSize(h265 ? SPS_CODEC_H265 : 0, list.find((f) => f.keyframe).bytes)
  if (!size) throw new Error('writeMp4: the SPS could not be read, so the picture size is unknown')

  // Samples: the Annex B start codes replaced by 4-byte lengths, the payloads untouched.
  const samples = list.map((f) => {
    const nals = splitNals(f.bytes)
    if (!nals.length) throw new Error(`writeMp4: a frame at ${f.ptsMs} ms holds no NAL units`)
    return Buffer.concat(nals.flatMap((n) => [u32(n.length), n]))
  })

  // Durations: the real gap to the next frame, never zero. The last frame keeps the one before it
  // (a single frame gets 25 fps), so it is shown rather than flashing past.
  const ticks = list.map((f) => Math.round((Number(f.ptsMs) || 0) * (timescale / 1000)))
  const durations = ticks.slice(1).map((t, i) => Math.max(1, t - ticks[i]))
  durations.push(durations.at(-1) ?? Math.max(1, Math.round((DEFAULT_FRAME_MS * timescale) / 1000)))
  const total = durations.reduce((s, d) => s + d, 0)

  const syncs = list.flatMap((f, i) => (f.keyframe ? [i + 1] : [])) // stss is one-based
  const config = h265 ? hvcC(sets.vps, sets.sps, sets.pps) : avcC(sets.sps, sets.pps)
  const stbl = box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), sampleEntry(h265 ? 'hvc1' : 'avc1', size.width, size.height, config)),
    stts(durations),
    fullBox('stss', 0, 0, u32(syncs.length), ...syncs.map(u32)),
    // one chunk holding every sample: the file is written in one piece, so there is nothing to
    // interleave with and a second chunk would only add a second offset to keep right
    fullBox('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1)),
    fullBox('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.length))),
    fullBox('stco', 0, 0, u32(1), u32(0)), // patched below, once the size of moov is known
  )
  const moov = box(
    'moov',
    fullBox(
      'mvhd',
      0,
      0,
      u32(0), // creation_time: not stated here; the manifest carries the real times
      u32(0), // modification_time
      u32(timescale),
      u32(total),
      u32(0x00010000), // rate: 1.0
      u16(0x0100), // volume: full (no audio track, but the field is not optional)
      u16(0),
      u32(0),
      u32(0),
      unityMatrix(),
      Buffer.alloc(24), // pre_defined
      u32(2), // next_track_ID
    ),
    box(
      'trak',
      fullBox(
        'tkhd',
        0,
        3, // enabled, in the movie
        u32(0),
        u32(0),
        u32(1), // track_ID
        u32(0), // reserved
        u32(total),
        Buffer.alloc(8), // reserved
        u16(0), // layer
        u16(0), // alternate_group
        u16(0), // volume: zero for video
        u16(0),
        unityMatrix(),
        u32(size.width * 65536),
        u32(size.height * 65536),
      ),
      box(
        'mdia',
        fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(total), u16(0x55c4), u16(0)), // language 'und'
        fullBox('hdlr', 0, 0, u32(0), str('vide'), Buffer.alloc(12), str('VideoHandler'), u8(0)),
        box(
          'minf',
          fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
          box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))), // flag 1: the data is in this file
          stbl,
        ),
      ),
    ),
  )

  const ftyp = box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str(h265 ? 'hvc1' : 'avc1'), str('mp41'))
  // moov comes before mdat so the file plays before it has all arrived; that makes the chunk
  // offset depend on moov's own size, which is why stco is written last and patched here. The
  // offset is 32-bit (stco, not co64): an export over 4 GB would need co64, and the job's 50 GB
  // limit is per job, not per file — a single clip that big is not something this writes today.
  const mdatStart = ftyp.length + moov.length
  const chunkOffset = mdatStart + 8
  if (chunkOffset > 0xffffffff) throw new Error('writeMp4: the file is too large for 32-bit chunk offsets')
  moov.writeUInt32BE(chunkOffset, moov.length - 4)
  const mdat = Buffer.concat([u32(8 + samples.reduce((s, b) => s + b.length, 0)), str('mdat'), ...samples])
  return Buffer.concat([ftyp, moov, mdat])
}

/** The identity transformation matrix every mvhd and tkhd has to carry. */
function unityMatrix() {
  return Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)])
}
