// Offline tests for the stream meter (public/stream-check.js): made-up Annex B frames with real
// NAL headers (and a real H.264 SPS where the picture size matters).
//   node cctv/test/stream-check.test.mjs
import { StreamMeter, isKeyframe } from '../public/stream-check.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

// ---- NAL units ------------------------------------------------------------------------------
class BitWriter {
  constructor() {
    this.bits = []
  }
  u(n, v) {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / 2 ** i) % 2)
  }
  ue(v) {
    const x = v + 1
    const n = Math.floor(Math.log2(x))
    this.u(n, 0)
    this.u(n + 1, x)
  }
  bytes() {
    const b = [...this.bits, 1] // rbsp stop bit
    while (b.length % 8) b.push(0)
    const out = []
    for (let i = 0; i < b.length; i += 8) out.push(b.slice(i, i + 8).reduce((a, x) => a * 2 + x, 0))
    // emulation prevention
    const esc = []
    let zeros = 0
    for (const x of out) {
      if (zeros >= 2 && x <= 3) {
        esc.push(3)
        zeros = 0
      }
      esc.push(x)
      zeros = x === 0 ? zeros + 1 : 0
    }
    return esc
  }
}
/** An H.264 SPS NAL (baseline) for a picture size, with a VUI: limited range, 0/0/0, 20 fps (TVT-like). */
function h264Sps(width, height) {
  const w = new BitWriter()
  w.u(8, 66)
  w.u(8, 0)
  w.u(8, 40)
  w.ue(0) // sps id
  w.ue(0) // log2_max_frame_num_minus4
  w.ue(2) // poc type
  w.ue(1) // max_num_ref_frames
  w.u(1, 0)
  const mbw = Math.ceil(width / 16)
  const mbh = Math.ceil(height / 16)
  w.ue(mbw - 1)
  w.ue(mbh - 1)
  w.u(1, 1) // frame_mbs_only
  w.u(1, 1) // direct_8x8
  const crop = mbw * 16 !== width || mbh * 16 !== height
  w.u(1, crop ? 1 : 0)
  if (crop) {
    w.ue(0)
    w.ue((mbw * 16 - width) / 2)
    w.ue(0)
    w.ue((mbh * 16 - height) / 2)
  }
  w.u(1, 1) // vui
  w.u(1, 0) // aspect
  w.u(1, 0) // overscan
  w.u(1, 1) // video signal type
  w.u(3, 5)
  w.u(1, 0) // limited range
  w.u(1, 1) // colour description: 0/0/0, as TVT sends
  w.u(8, 0)
  w.u(8, 0)
  w.u(8, 0)
  w.u(1, 0) // chroma location
  w.u(1, 1) // timing
  w.u(32, 1)
  w.u(32, 40)
  w.u(1, 1)
  return [0, 0, 0, 1, 0x67, ...w.bytes()]
}
const pad = (n) => new Array(Math.max(0, n)).fill(0x55)
/** An H.264 frame of about `bytes` bytes: key = SPS + PPS + IDR slice, else a P slice. */
const h264 = (key, bytes, size = [1920, 1080]) => {
  const head = key ? [...h264Sps(...size), 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 0, 1, 0x65, 0x88] : [0, 0, 0, 1, 0x41, 0x9a]
  return new Uint8Array([...head, ...pad(bytes - head.length)])
}
/** An HEVC frame: key = VPS + IDR_W_RADL (type 19), else TRAIL_R (type 1). */
const h265 = (key, bytes) => {
  const head = key ? [0, 0, 0, 1, 0x40, 0x01, 0x0c, 0x01, 0, 0, 0, 1, 0x26, 0x01, 0xaf] : [0, 0, 0, 1, 0x02, 0x01, 0xd0]
  return new Uint8Array([...head, ...pad(bytes - head.length)])
}

check('H.264: IDR (5) is a keyframe, after SPS/PPS/SEI', isKeyframe(0, h264(true, 100)) === true)
check('H.264: non-IDR slice (1) is not', isKeyframe(0, h264(false, 100)) === false)
check('HEVC: IDR_W_RADL (19) is a keyframe, after the VPS', isKeyframe(1, h265(true, 100)) === true)
check('HEVC: CRA (21) is a keyframe, TRAIL_R (1) is not', isKeyframe(1, new Uint8Array([0, 0, 1, 0x2a, 0x01, 0x55])) === true && isKeyframe(1, h265(false, 100)) === false)
check('HEVC: RASL (8) is not; parameter sets alone: no slice (null)', isKeyframe(1, new Uint8Array([0, 0, 1, 0x10, 0x01, 0x55])) === false && isKeyframe(1, new Uint8Array([0, 0, 1, 0x42, 0x01, 0x55])) === null)

// ---- a stream --------------------------------------------------------------------------------
/**
 * Feeds `seconds` of a stream: fps frames per second, a keyframe every `gop` frames of iBytes,
 * delta frames of pBytes (or pBytes(gopIndex)). Returns the next timestamp.
 */
function feed(m, { seconds, fps = 20, gop = 40, iBytes = 60_000, pBytes = 10_000, codec = 0, t0 = 0, size, extra = [] }) {
  const n = Math.round(seconds * fps)
  for (let i = 0; i < n; i++) {
    const ts = t0 + Math.round((i * 1e6) / fps)
    const key = i % gop === 0
    const g = Math.floor(i / gop)
    const bytes = key ? iBytes : typeof pBytes === 'function' ? pBytes(g) : pBytes
    const data = codec === 0 ? h264(key, bytes, size) : h265(key, bytes)
    m.add({ codecId: codec, timestampUs: ts, data, isKey: key })
    for (const e of extra) if (e.at === i) m.add({ codecId: codec, timestampUs: ts + 10_000, data: codec === 0 ? h264(true, e.bytes, size) : h265(true, e.bytes), isKey: true })
  }
  return t0 + Math.round((n * 1e6) / fps)
}
// (60000 + 39 x 10000) bytes per 2 s = 1800 kbit/s
{
  const m = new StreamMeter()
  feed(m, { seconds: 25 })
  const f = m.figures(2000)
  check('rate over whole GOPs: 1800 kbit/s, GOP 2 s, 20 fps', f.kbps === 1800 && f.gopS === 2 && f.fps === 20 && f.mode === 'gops', JSON.stringify({ kbps: f.kbps, gopS: f.gopS, fps: f.fps }))
  check('  the first GOP (before the second keyframe) is left out: 11 whole GOPs of 25 s', f.gops.length === 11 && f.windowS === 22, `${f.gops.length} GOPs over ${f.windowS} s`)
  check('  usage = kbps / QoI; every GOP at >= 90% of the cap: bindShare 1', f.usage === 0.9 && f.bindShare === 1, `usage ${f.usage} bindShare ${f.bindShare}`)
  check('  iShare, codec, size and range from the SPS', f.iShare === 0.133 && f.codec === 'h264' && f.width === 1920 && f.height === 1080 && f.fullRange === false, JSON.stringify({ iShare: f.iShare, codec: f.codec, w: f.width, h: f.height, fr: f.fullRange }))
  check('  enough (>= 20 s)', f.enough === true)
  check('  without a QoI: no usage or bindShare', m.figures(null).usage === null && m.figures(null).bindShare === null)
}
{
  const m = new StreamMeter()
  feed(m, { seconds: 12 })
  check('less than 20 s measured: figures marked not enough', m.figures(2000).enough === false && m.figures(2000).windowS === 8)
  const e = new StreamMeter()
  feed(e, { seconds: 1.5 })
  const f = e.figures(2000)
  check('  one keyframe only: nothing yet', f.windowS === 0 && f.kbps === null && f.gops.length === 0 && !f.enough)
}
{
  // bindShare: 8 GOPs at the cap, 2 well under it (a quiet moment)
  const m = new StreamMeter()
  feed(m, { seconds: 24, pBytes: (g) => (g === 3 || g === 7 ? 5_000 : 10_000) })
  const f = m.figures(2000)
  const low = f.gops.filter((g) => g.kbps < 1800).length
  check('bindShare: the share of GOPs at >= 90% of the cap', low === 2 && f.bindShare === 0.8 && f.usage < 0.9, `bindShare ${f.bindShare} usage ${f.usage} kbps ${f.gops.map((g) => g.kbps).join(',')}`)
}
{
  // a viewer connects: the NVR asks the camera for an extra keyframe 0.3 s after a scheduled one
  const m = new StreamMeter()
  feed(m, { seconds: 25, extra: [{ at: 206, bytes: 200_000 }] })
  const f = m.figures(2000)
  const plain = new StreamMeter()
  feed(plain, { seconds: 25 })
  const g = plain.figures(2000)
  check('a forced IDR (< 1 s after a keyframe) is counted but left out of the rate and the GOPs', f.forced === 1 && f.kbps === g.kbps && f.gops.length === g.gops.length && f.gopS === 2, `forced ${f.forced} kbps ${f.kbps} vs ${g.kbps}, gops ${f.gops.length}`)
}
{
  // codec change: the meter starts over
  const m = new StreamMeter()
  const t = feed(m, { seconds: 24 })
  check('before a codec change: 10 GOPs', m.figures(2000).gops.length === 10)
  feed(m, { seconds: 5, codec: 1, t0: t })
  const f = m.figures(2000)
  check('  reset on a codec change: only the new stream counts', f.codec === 'h265' && f.gops.length === 1 && f.windowS === 2 && m.resets === 1, `${f.codec} ${f.gops.length} GOPs ${f.windowS} s, resets ${m.resets}`)
}
{
  // picture size change (the camera's resolution was changed): SPS says so at the next keyframe
  const m = new StreamMeter()
  const t = feed(m, { seconds: 22 })
  feed(m, { seconds: 7, t0: t, size: [1280, 720] })
  const f = m.figures(2000)
  check('reset on a picture size change', f.width === 1280 && f.height === 720 && f.gops.length === 2 && m.resets === 1, `${f.width}x${f.height} ${f.gops.length} GOPs`)
}
{
  // a reconnect: timestamps jump back (the NVR's cached keyframe)
  const m = new StreamMeter()
  const t = feed(m, { seconds: 22 })
  feed(m, { seconds: 7, t0: t - 3_000_000 })
  check('reset when timestamps go back', m.resets === 1 && m.figures(2000).gops.length === 2)
  const j = new StreamMeter()
  const t2 = feed(j, { seconds: 22 })
  feed(j, { seconds: 7, t0: t2 + 8_000_000 })
  check('  or jump ahead by more than 5 s', j.resets === 1)
}
{
  // after a change: only whole GOPs after mark() count, so a rise is not diluted by the minutes before
  const m = new StreamMeter()
  const t = feed(m, { seconds: 120 }) // 1800 kbit/s for 2 minutes
  m.mark()
  const t2 = feed(m, { seconds: 12, t0: t, pBytes: 14_000 }) // the change: 2424 kbit/s
  const early = m.figures(2000, { sinceMark: true })
  check('mark: after the change, not enough yet (n of 20 s), whole figures still dominated by before', !early.enough && early.windowS === 10 && early.kbps === 2424 && m.figures(2000).kbps < 1900, JSON.stringify({ w: early.windowS, k: early.kbps, all: m.figures(2000).kbps }))
  feed(m, { seconds: 12, t0: t2, pBytes: 14_000 })
  const late = m.figures(2000, { sinceMark: true })
  check('  then the rise shows in full: usage 0.90 -> 1.21', late.enough && late.usage === 1.212 && m.figures(2000).usage < 1, `${late.usage} vs ${m.figures(2000).usage}`)
  const r = new StreamMeter()
  r.mark()
  feed(r, { seconds: 25 })
  check('  a mark before any frame (or before a restart): everything after it counts', r.figures(2000, { sinceMark: true }).windowS === 22)
}
{
  // H.265+: a keyframe every 8 s; graded in 10 s byte windows
  const m = new StreamMeter()
  feed(m, { seconds: 45, gop: 160, iBytes: 300_000, pBytes: 3_000, codec: 1 })
  const f = m.figures(2048)
  check('smart codec (GOP > 5 s): 10 s windows instead of GOPs', f.mode === 'windows' && f.gopS === 8 && f.gops.length === 3 && f.gops.every((g) => g.s === 10) && f.windowS === 30 && f.enough, JSON.stringify({ mode: f.mode, gopS: f.gopS, n: f.gops.length, windowS: f.windowS }))
  check('  its usage is well under the cap', f.usage < 0.5 && f.bindShare === 0, `usage ${f.usage}`)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
