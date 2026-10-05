// Tests for mp4.mjs, phase 4 Task 2 ("MP4 without re-encoding"): recorded H.264 / H.265 Annex B
// frames wrapped in an MP4 container with nothing re-encoded.
//
// The tests parse the bytes writeMp4() produced back into boxes and assert on the structure, not
// on a hash: box order and nesting, every box's size against its real content, the track size
// against the SPS, the sample table against the frame times, the sync table against the keyframes,
// and — the point of the whole exercise — that every NAL unit's payload inside the file is
// byte-identical to the input.
//
// The fixtures are synthetic but real bitstreams: the SPS bytes are written bit by bit here (with
// emulation prevention applied afterwards, so the unescaping paths are exercised) and the sizes
// asserted on come from the same SPS the writer parses.
// No NVR, no disk, no SDK: this file imports nothing that pulls in koffi.
// Run:  node cctv/test/mp4.test.mjs

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}\n`)
}
/** A module, or {} with a FAIL when it cannot be loaded (so a missing file still reports the rest). */
const load = async (path) => {
  try {
    return await import(path)
  } catch (e) {
    check(`load ${path}`, false, e.message)
    return {}
  }
}
/** The message of the error a call throws, or '' when it does not throw. */
const throws = (fn) => {
  try {
    fn()
    return ''
  } catch (e) {
    return e.message
  }
}

const { writeMp4 } = await load('../mp4.mjs')

// ---- fixtures: bitstreams written bit by bit, so the parsed sizes are the ones coded here ----

class BitWriter {
  constructor() {
    this.bits = []
  }
  u(n, v) {
    for (let i = n - 1; i >= 0; i--) this.bits.push((v / 2 ** i) & 1)
    return this
  }
  ue(v) {
    const c = v + 1
    const n = 32 - Math.clz32(c)
    this.u(n - 1, 0)
    return this.u(n, c)
  }
  /** rbsp_trailing_bits: a stop bit, then zeros to the byte boundary. */
  end() {
    this.bits.push(1)
    while (this.bits.length % 8) this.bits.push(0)
    return this
  }
  bytes() {
    const b = Buffer.alloc(this.bits.length / 8)
    this.bits.forEach((bit, i) => {
      if (bit) b[i >> 3] |= 1 << (7 - (i & 7))
    })
    return b
  }
}

/** RBSP to NAL payload: an emulation prevention byte after every pair of zeros. */
const escape = (rbsp) => {
  const out = []
  let zeros = 0
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) {
      out.push(3)
      zeros = 0
    }
    out.push(b)
    zeros = b === 0 ? zeros + 1 : 0
  }
  return Buffer.from(out)
}

const WIDTH = 640
const HEIGHT = 360 // 368 coded, 4 rows cropped off the bottom (2 luma rows per crop unit)
const H264_PROFILE = 66
const H264_LEVEL = 30
const H265_PROFILE = 1
const H265_LEVEL = 120

function h264Sps() {
  const w = new BitWriter()
  w.u(8, H264_PROFILE).u(8, 0).u(8, H264_LEVEL)
  w.ue(0) // seq_parameter_set_id
  w.ue(0) // log2_max_frame_num_minus4
  w.ue(2) // pic_order_cnt_type: 2, so nothing follows it
  w.ue(1) // max_num_ref_frames
  w.u(1, 0) // gaps_in_frame_num_value_allowed_flag
  w.ue(WIDTH / 16 - 1) // pic_width_in_mbs_minus1
  w.ue(368 / 16 - 1) // pic_height_in_map_units_minus1
  w.u(1, 1) // frame_mbs_only_flag
  w.u(1, 1) // direct_8x8_inference_flag
  w.u(1, 1) // frame_cropping_flag
  w.ue(0).ue(0).ue(0).ue(4) // left, right, top, bottom: 4 crop units off the bottom
  w.u(1, 0) // vui_parameters_present_flag
  return Buffer.concat([Buffer.from([0x67]), escape(w.end().bytes())]) // NAL type 7, ref idc 3
}

function h265Sps() {
  const w = new BitWriter()
  w.u(4, 0) // sps_video_parameter_set_id
  w.u(3, 0) // sps_max_sub_layers_minus1
  w.u(1, 1) // sps_temporal_id_nesting_flag
  // profile_tier_level, general part only (no sub-layers)
  w.u(2, 0).u(1, 0).u(5, H265_PROFILE) // profile_space, tier_flag, profile_idc
  w.u(32, 0x60000000) // general_profile_compatibility_flags
  w.u(24, 0x900000).u(24, 0x000000) // general constraint indicator flags (48 bits)
  w.u(8, H265_LEVEL)
  w.ue(0) // sps_seq_parameter_set_id
  w.ue(1) // chroma_format_idc: 4:2:0
  w.ue(WIDTH)
  w.ue(HEIGHT)
  w.u(1, 0) // conformance_window_flag
  w.ue(0).ue(0) // bit depths
  w.ue(4) // log2_max_pic_order_cnt_lsb_minus4
  return Buffer.concat([Buffer.from([0x42, 0x01]), escape(w.end().bytes())]) // NAL type 33
}

const nal = (header, body) => Buffer.concat([Buffer.from(header), Buffer.from(body)])
const START4 = Buffer.from([0, 0, 0, 1])
const START3 = Buffer.from([0, 0, 1])
/** Annex B bytes for a list of NAL units, alternating 4- and 3-byte start codes. */
const annexB = (nals) => Buffer.concat(nals.flatMap((n, i) => [i % 2 ? START3 : START4, n]))

const H264 = {
  sps: h264Sps(),
  pps: nal([0x68], [0xce, 0x38, 0x80]), // type 8
  idr: (n) => nal([0x65], Buffer.alloc(n, 0xa5)), // type 5
  slice: (n) => nal([0x41], Buffer.alloc(n, 0x5a)), // type 1, non-IDR
}
const H265 = {
  vps: nal([0x40, 0x01], [0x0c, 0x01, 0xff, 0xff, 0x01]), // type 32
  sps: h265Sps(),
  pps: nal([0x44, 0x01], [0xc1, 0x72, 0xb4, 0x62, 0x40]), // type 34
  idr: (n) => nal([0x26, 0x01], Buffer.alloc(n, 0xa5)), // type 19, IDR_W_RADL
  slice: (n) => nal([0x02, 0x01], Buffer.alloc(n, 0x5a)), // type 1, TRAIL_R
}

/** Frames with times that are deliberately uneven: CCTV frame timing is not constant. */
const PTS = [0, 41, 79, 120, 200, 241, 280]
const KEYS = [0, 4] // which of those are keyframes

const h264Frames = () =>
  PTS.map((ptsMs, i) => ({
    ptsMs,
    keyframe: KEYS.includes(i),
    bytes: KEYS.includes(i) ? annexB([H264.sps, H264.pps, H264.idr(300 + i)]) : annexB([H264.slice(100 + i)]),
  }))

const h265Frames = () =>
  PTS.map((ptsMs, i) => ({
    ptsMs,
    keyframe: KEYS.includes(i),
    bytes: KEYS.includes(i) ? annexB([H265.vps, H265.sps, H265.pps, H265.idr(300 + i)]) : annexB([H265.slice(100 + i)]),
  }))

// ---- a small MP4 box reader, and an Annex B splitter, to check the output against ----

/** The boxes between start and end: [{ type, size, start, body, end }]; `bad` when a size is wrong. */
function boxes(buf, start = 0, end = buf.length) {
  const out = []
  let p = start
  while (p + 8 <= end) {
    const size = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    if (size < 8 || p + size > end) {
      out.push({ type, size, start: p, bad: true })
      break
    }
    out.push({ type, size, start: p, body: p + 8, end: p + size })
    p += size
  }
  return out
}
const find = (list, type) => list.find((b) => b.type === type)
/** The child boxes of a container, skipping `skip` bytes of its own fields first. */
const kids = (buf, b, skip = 0) => (b ? boxes(buf, b.body + skip, b.end) : [])
/** The box at a path of types from the top, or undefined. */
function at(buf, path, skips = {}) {
  let list = boxes(buf)
  let box
  for (const type of path) {
    box = find(list, type)
    if (!box) return undefined
    list = kids(buf, box, skips[type] ?? 0)
  }
  return box
}

/** Annex B to NAL payloads, the way the writer must see them (one leading zero is start code). */
function splitAnnexB(buf) {
  const marks = []
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      marks.push(i)
      i += 2
    }
  }
  return marks.map((p, i) => {
    const from = p + 3
    let to = i + 1 < marks.length ? marks[i + 1] : buf.length
    if (i + 1 < marks.length && to - 1 > from && buf[to - 1] === 0) to -= 1
    return buf.subarray(from, to)
  })
}

/** The length-prefixed NAL payloads of a sample. */
function splitLengthPrefixed(buf) {
  const out = []
  for (let p = 0; p + 4 <= buf.length; ) {
    const n = buf.readUInt32BE(p)
    out.push(buf.subarray(p + 4, p + 4 + n))
    p += 4 + n
  }
  return out
}

/** The sample table of a file: { stts, stss, stsz, stsc, stco, samples: [Buffer] }. */
function sampleTable(buf) {
  const stbl = at(buf, ['moov', 'trak', 'mdia', 'minf', 'stbl'], { minf: 0 })
  const list = kids(buf, stbl)
  const stts = find(list, 'stts')
  const stss = find(list, 'stss')
  const stsz = find(list, 'stsz')
  const stco = find(list, 'stco')
  const stsc = find(list, 'stsc')
  const durations = []
  const n = buf.readUInt32BE(stts.body + 4)
  for (let i = 0; i < n; i++) {
    const count = buf.readUInt32BE(stts.body + 8 + i * 8)
    const delta = buf.readUInt32BE(stts.body + 12 + i * 8)
    for (let j = 0; j < count; j++) durations.push(delta)
  }
  const syncs = []
  if (stss) for (let i = 0, m = buf.readUInt32BE(stss.body + 4); i < m; i++) syncs.push(buf.readUInt32BE(stss.body + 8 + i * 4))
  const sizes = []
  const uniform = buf.readUInt32BE(stsz.body + 4)
  const count = buf.readUInt32BE(stsz.body + 8)
  for (let i = 0; i < count; i++) sizes.push(uniform || buf.readUInt32BE(stsz.body + 12 + i * 4))
  const offset = buf.readUInt32BE(stco.body + 8)
  const samples = []
  for (let i = 0, p = offset; i < sizes.length; i++) {
    samples.push(buf.subarray(p, p + sizes[i]))
    p += sizes[i]
  }
  return { durations, syncs, sizes, offset, samples, stsc, boxTypes: list.map((b) => b.type) }
}

// ---- refusals: a clear error, never a broken file ----

check('refuses no frames', throws(() => writeMp4({ frames: [], codec: 'h264' })).includes('no frames'))
check('refuses a missing frames list', throws(() => writeMp4({ codec: 'h264' })).includes('no frames'))
check(
  'refuses an unknown codec',
  throws(() => writeMp4({ frames: h264Frames(), codec: 'vp9' })).includes('codec'),
)
check(
  'refuses frames with no keyframe',
  throws(() => writeMp4({ frames: h264Frames().map((f) => ({ ...f, keyframe: false })), codec: 'h264' })).includes('keyframe'),
)
{
  // the parameter sets have to come out of the frames; without them there is no avcC to write
  const noSps = [{ ptsMs: 0, keyframe: true, bytes: annexB([H264.pps, H264.idr(100)]) }]
  check('refuses H.264 with no SPS', throws(() => writeMp4({ frames: noSps, codec: 'h264' })).includes('SPS'))
  const noPps = [{ ptsMs: 0, keyframe: true, bytes: annexB([H264.sps, H264.idr(100)]) }]
  check('refuses H.264 with no PPS', throws(() => writeMp4({ frames: noPps, codec: 'h264' })).includes('PPS'))
  const noVps = [{ ptsMs: 0, keyframe: true, bytes: annexB([H265.sps, H265.pps, H265.idr(100)]) }]
  check('refuses H.265 with no VPS', throws(() => writeMp4({ frames: noVps, codec: 'h265' })).includes('VPS'))
}

// ---- H.264: structure ----

const mp4 = writeMp4({ frames: h264Frames(), codec: 'h264' })
check('returns a Buffer', Buffer.isBuffer(mp4))

{
  const top = boxes(mp4)
  check(
    'top level is ftyp, moov, mdat in that order',
    top.map((b) => b.type).join() === 'ftyp,moov,mdat',
    top.map((b) => b.type).join(),
  )
  check('no box overruns the file', !top.some((b) => b.bad))
  const total = top.reduce((s, b) => s + b.size, 0)
  check('the box sizes account for every byte', total === mp4.length, `${total} of ${mp4.length}`)
  check('ftyp names an mp4 brand', mp4.toString('latin1', top[0].body, top[0].body + 4) === 'isom')
}

{
  const moov = at(mp4, ['moov'])
  const types = kids(mp4, moov).map((b) => b.type)
  check('moov holds mvhd then trak', types.join() === 'mvhd,trak', types.join())
  const mdia = at(mp4, ['moov', 'trak', 'mdia'])
  check('trak holds tkhd then mdia', kids(mp4, at(mp4, ['moov', 'trak'])).map((b) => b.type).join() === 'tkhd,mdia')
  check('mdia holds mdhd, hdlr, minf', kids(mp4, mdia).map((b) => b.type).join() === 'mdhd,hdlr,minf')
  const minf = at(mp4, ['moov', 'trak', 'mdia', 'minf'])
  check('minf holds vmhd, dinf, stbl', kids(mp4, minf).map((b) => b.type).join() === 'vmhd,dinf,stbl')
  check('hdlr is a video handler', mp4.toString('latin1', find(kids(mp4, mdia), 'hdlr').body + 8, find(kids(mp4, mdia), 'hdlr').body + 12) === 'vide')
  const stbl = at(mp4, ['moov', 'trak', 'mdia', 'minf', 'stbl'])
  check('stbl holds stsd, stts, stss, stsc, stsz, stco', kids(mp4, stbl).map((b) => b.type).join() === 'stsd,stts,stss,stsc,stsz,stco')
}

{
  // tkhd: track width and height as 16.16 fixed point, from the SPS the frames carry
  const tkhd = at(mp4, ['moov', 'trak', 'tkhd'])
  const w = mp4.readUInt32BE(tkhd.end - 8) / 65536
  const h = mp4.readUInt32BE(tkhd.end - 4) / 65536
  check('tkhd width and height come from the SPS', w === WIDTH && h === HEIGHT, `${w}x${h}`)
  check('tkhd is enabled and in the movie', (mp4.readUInt32BE(tkhd.body) & 0xffffff) === 3)
}

{
  const stsd = at(mp4, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'], { minf: 0 })
  const entries = kids(mp4, stsd, 8)
  check('stsd holds one avc1 entry', entries.length === 1 && entries[0].type === 'avc1', entries.map((b) => b.type).join())
  const entry = entries[0]
  check('the sample entry repeats the picture size', mp4.readUInt16BE(entry.body + 24) === WIDTH && mp4.readUInt16BE(entry.body + 26) === HEIGHT)
  const avcC = find(kids(mp4, entry, 78), 'avcC')
  check('the sample entry holds an avcC', !!avcC)
  if (avcC) {
    const c = mp4.subarray(avcC.body, avcC.end)
    check('avcC version, profile and level come from the SPS', c[0] === 1 && c[1] === H264_PROFILE && c[3] === H264_LEVEL, [...c.subarray(0, 4)].join())
    check('avcC says 4-byte NAL lengths', (c[4] & 3) === 3)
    check('avcC holds one SPS', (c[5] & 0x1f) === 1)
    const spsLen = c.readUInt16BE(6)
    check('avcC holds the SPS bytes unchanged', c.subarray(8, 8 + spsLen).equals(H264.sps), `${spsLen} bytes`)
    const p = 8 + spsLen
    check('avcC holds one PPS', c[p] === 1)
    const ppsLen = c.readUInt16BE(p + 1)
    check('avcC holds the PPS bytes unchanged', c.subarray(p + 3, p + 3 + ppsLen).equals(H264.pps))
    check('avcC has no bytes left over', p + 3 + ppsLen === c.length, `${p + 3 + ppsLen} of ${c.length}`)
  }
}

// ---- H.264: the sample table against the frame times and bytes ----

{
  const t = sampleTable(mp4)
  const frames = h264Frames()
  check('one sample per frame', t.sizes.length === frames.length && t.durations.length === frames.length)
  const want = PTS.slice(1).map((v, i) => v - PTS[i])
  check('the durations are the real gaps between the frame times', t.durations.slice(0, -1).join() === want.join(), t.durations.join())
  check('a variable frame rate is preserved', new Set(t.durations).size > 1, t.durations.join())
  check('the last frame has a sensible duration', t.durations.at(-1) > 0 && t.durations.at(-1) === want.at(-1), String(t.durations.at(-1)))
  check('the sync table lists the keyframes, one-based', t.syncs.join() === KEYS.map((k) => k + 1).join(), t.syncs.join())
  check('stsc puts every sample in one chunk', mp4.readUInt32BE(t.stsc.body + 8) === 1 && mp4.readUInt32BE(t.stsc.body + 12) === frames.length)

  const mdat = find(boxes(mp4), 'mdat')
  check('the chunk offset points at the mdat payload', t.offset === mdat.body, `${t.offset} vs ${mdat.body}`)
  const end = t.offset + t.sizes.reduce((s, n) => s + n, 0)
  check('the samples fill the mdat exactly', end === mdat.end, `${end} of ${mdat.end}`)

  let identical = true
  let sameCount = true
  frames.forEach((f, i) => {
    const wantNals = splitAnnexB(f.bytes)
    const gotNals = splitLengthPrefixed(t.samples[i])
    if (wantNals.length !== gotNals.length) sameCount = false
    wantNals.forEach((n, j) => {
      if (!gotNals[j] || !gotNals[j].equals(n)) identical = false
    })
  })
  check('every NAL unit survives the conversion', sameCount)
  check('the NAL payload bytes in the file are byte-identical to the input', identical)
  check(
    'the sample sizes are the NAL payloads plus a 4-byte length each',
    t.sizes.join() === frames.map((f) => splitAnnexB(f.bytes).reduce((s, n) => s + n.length + 4, 0)).join(),
  )

  // the durations are what mvhd and mdhd say the film lasts
  const mdhd = at(mp4, ['moov', 'trak', 'mdia', 'mdhd'])
  const total = t.durations.reduce((s, d) => s + d, 0)
  check('mdhd timescale and duration match the samples', mp4.readUInt32BE(mdhd.body + 12) === 1000 && mp4.readUInt32BE(mdhd.body + 16) === total)
  const mvhd = at(mp4, ['moov', 'mvhd'])
  check('mvhd duration matches', mp4.readUInt32BE(mvhd.body + 16) === total)
}

// ---- a non-default timescale ----

{
  const m = writeMp4({ frames: h264Frames(), codec: 'h264', timescale: 90000 })
  const t = sampleTable(m)
  const mdhd = at(m, ['moov', 'trak', 'mdia', 'mdhd'])
  check('the timescale is honoured', m.readUInt32BE(mdhd.body + 12) === 90000)
  check('the durations are scaled to it', t.durations[0] === Math.round(41 * 90), t.durations.slice(0, 3).join())
}

// ---- H.265 ----

{
  const m = writeMp4({ frames: h265Frames(), codec: 'h265' })
  const top = boxes(m).map((b) => b.type).join()
  check('H.265: top level is ftyp, moov, mdat', top === 'ftyp,moov,mdat', top)
  const tkhd = at(m, ['moov', 'trak', 'tkhd'])
  check('H.265: the track size comes from the SPS', m.readUInt32BE(tkhd.end - 8) / 65536 === WIDTH && m.readUInt32BE(tkhd.end - 4) / 65536 === HEIGHT)
  const stsd = at(m, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])
  const entry = kids(m, stsd, 8)[0]
  check('H.265: the sample entry is hvc1', entry.type === 'hvc1', entry.type)
  const hvcC = find(kids(m, entry, 78), 'hvcC')
  check('H.265: the sample entry holds an hvcC', !!hvcC)
  if (hvcC) {
    const c = m.subarray(hvcC.body, hvcC.end)
    check('hvcC version and profile come from the SPS', c[0] === 1 && (c[1] & 0x1f) === H265_PROFILE, [...c.subarray(0, 2)].join())
    check('hvcC compatibility flags come from the SPS', c.readUInt32BE(2) === 0x60000000, c.readUInt32BE(2).toString(16))
    check('hvcC level comes from the SPS', c[12] === H265_LEVEL, String(c[12]))
    check('hvcC says 4-byte NAL lengths', (c[21] & 3) === 3)
    check('hvcC holds three arrays', c[22] === 3, String(c[22]))
    // VPS, SPS then PPS, each one NAL unit, bytes unchanged
    let p = 23
    const want = [
      [32, H265.vps],
      [33, H265.sps],
      [34, H265.pps],
    ]
    let ok = true
    for (const [type, bytes] of want) {
      if ((c[p] & 0x3f) !== type || c.readUInt16BE(p + 1) !== 1) ok = false
      const len = c.readUInt16BE(p + 3)
      if (!c.subarray(p + 5, p + 5 + len).equals(bytes)) ok = false
      p += 5 + len
    }
    check('hvcC holds the VPS, SPS and PPS bytes unchanged, in order', ok)
    check('hvcC has no bytes left over', p === c.length, `${p} of ${c.length}`)
  }
  const t = sampleTable(m)
  const frames = h265Frames()
  const want = PTS.slice(1).map((v, i) => v - PTS[i])
  check('H.265: the durations are the real gaps', t.durations.slice(0, -1).join() === want.join(), t.durations.join())
  check('H.265: the sync table lists the keyframes', t.syncs.join() === KEYS.map((k) => k + 1).join(), t.syncs.join())
  let identical = true
  frames.forEach((f, i) => {
    const wantNals = splitAnnexB(f.bytes)
    const gotNals = splitLengthPrefixed(t.samples[i])
    if (wantNals.length !== gotNals.length) identical = false
    wantNals.forEach((n, j) => {
      if (!gotNals[j] || !gotNals[j].equals(n)) identical = false
    })
  })
  check('H.265: the NAL payload bytes in the file are byte-identical to the input', identical)
}

// ---- a single frame still gets a duration ----

{
  const m = writeMp4({ frames: [{ ptsMs: 0, keyframe: true, bytes: annexB([H264.sps, H264.pps, H264.idr(64)]) }], codec: 'h264' })
  const t = sampleTable(m)
  check('a lone frame gets a non-zero duration', t.durations.length === 1 && t.durations[0] > 0, t.durations.join())
  check('a lone frame is still a sync sample', t.syncs.join() === '1')
}

process.stdout.write(`${failures ? `${failures} FAILED` : 'all passed'}\n`)
process.exit(failures ? 1 : 0)
