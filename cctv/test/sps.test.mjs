// Offline test: picture size and VUI facts from the SPS of real camera keyframes (public/sps.js).
//   node cctv/test/sps.test.mjs <folder with cranes.bin, gate.bin, cage.bin, wharf.bin, robb-main.bin, robb-sub.bin>
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pictureSize, videoInfo } from '../public/sps.js'

const dir = process.argv[2] ?? '/work'
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
// [file, codec (0 H.264, 1 H.265), expected visible size]; sizes as ffprobe reports them
const CASES = [
  ['cranes.bin', 1, '3200x1800'], // coded 3200x1808
  ['gate.bin', 1, '3840x2160'],
  ['wharf.bin', 1, '3200x1800'], // coded 3200x1808
  ['robb-main.bin', 1, '3200x1800'], // coded 3200x1808: shown top-left 1280x720 before the fix
  ['cage.bin', 0, '1280x960'],
  ['robb-sub.bin', 0, '1280x720']
]
for (const [file, codec, want] of CASES) {
  const s = pictureSize(codec, new Uint8Array(readFileSync(join(dir, file))))
  check(`${file}: ${want}`, s && `${s.width}x${s.height}` === want, s ? `${s.width}x${s.height}` : 'no size')
}
check('no SPS: null', pictureSize(1, new Uint8Array([0, 0, 1, 0x26, 1, 2, 3])) === null)
check('cut-off SPS: null, no throw', pictureSize(1, new Uint8Array([0, 0, 1, 0x42, 1, 1])) === null)
check('garbage: null', pictureSize(0, new Uint8Array(64).fill(0xff)) === null)

// videoInfo on the real keyframes: TVT flags limited range with a 0/0/0 colour description (so:
// none), and codes 0-255 (the display range fix is for exactly that); the Dahua flags full range
const VUI = [
  ['gate.bin', 1, { width: 3840, height: 2160, fullRange: false, colourDesc: null, colourCodes: [0, 0, 0], fps: 20 }],
  ['wharf.bin', 1, { width: 3200, height: 1800, fullRange: false, colourDesc: null, colourCodes: [0, 0, 0], fps: 20 }],
  ['robb-sub.bin', 0, { width: 1280, height: 720, fullRange: false, colourDesc: null, colourCodes: [0, 0, 0], fps: 30 }],
  ['cage.bin', 0, { width: 1280, height: 960, fullRange: true, colourDesc: null, colourCodes: null, fps: 15 }]
]
for (const [file, codec, want] of VUI) {
  const v = videoInfo(codec, new Uint8Array(readFileSync(join(dir, file))))
  check(`videoInfo ${file}: ${JSON.stringify(want)}`, JSON.stringify(v) === JSON.stringify(want), JSON.stringify(v))
}
for (const [file, codec] of CASES) {
  const data = new Uint8Array(readFileSync(join(dir, file)))
  const v = videoInfo(codec, data)
  const s = pictureSize(codec, data)
  if (!v || v.width !== s.width || v.height !== s.height) check(`videoInfo size = pictureSize for ${file}`, false)
}

// synthetic SPSs: what other cameras may send
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
  nal(header, stop = true) {
    const b = [...this.bits]
    if (stop) b.push(1)
    while (b.length % 8) b.push(0)
    const out = []
    for (let i = 0; i < b.length; i += 8) out.push(b.slice(i, i + 8).reduce((a, x) => a * 2 + x, 0))
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
    return new Uint8Array([0, 0, 0, 1, header, ...esc])
  }
}
function h264Sps({ vui = true, full = false, desc = null, fps = null, cut = false } = {}) {
  const w = new BitWriter()
  w.u(8, 66)
  w.u(8, 0)
  w.u(8, 40)
  w.ue(0)
  w.ue(0)
  w.ue(2)
  w.ue(1)
  w.u(1, 0)
  w.ue(119) // 1920
  w.ue(67) // 1088, cropped to 1080
  w.u(1, 1)
  w.u(1, 1)
  w.u(1, 1)
  w.ue(0)
  w.ue(0)
  w.ue(0)
  w.ue(4)
  w.u(1, vui ? 1 : 0)
  if (vui) {
    w.u(1, 1) // aspect ratio: extended SAR
    w.u(8, 255)
    w.u(16, 1)
    w.u(16, 1)
    w.u(1, 0)
    w.u(1, 1)
    w.u(3, 5)
    w.u(1, full ? 1 : 0)
    w.u(1, desc ? 1 : 0)
    if (desc) for (const c of desc) w.u(8, c)
    if (!cut) {
      w.u(1, 0)
      w.u(1, fps ? 1 : 0)
      if (fps) {
        w.u(32, 1000)
        w.u(32, 2000 * fps)
        w.u(1, 1)
      }
    }
  }
  return w.nal(0x67, !cut)
}
const s1 = videoInfo(0, h264Sps({ full: true, desc: [1, 1, 1], fps: 25 }))
check('synthetic H.264: full range, BT.709 description, 25 fps', JSON.stringify(s1) === JSON.stringify({ width: 1920, height: 1080, fullRange: true, colourDesc: { primaries: 1, transfer: 1, matrix: 1 }, colourCodes: [1, 1, 1], fps: 25 }), JSON.stringify(s1))
const s2 = videoInfo(0, h264Sps({ vui: false }))
check('  no VUI: size only, the rest null', s2 && s2.width === 1920 && s2.fullRange === null && s2.colourDesc === null && s2.fps === null, JSON.stringify(s2))
const s3 = videoInfo(0, h264Sps({ desc: [2, 2, 2], fps: 20 }))
check('  unspecified description (2/2/2) counts as none', s3.colourDesc === null && JSON.stringify(s3.colourCodes) === '[2,2,2]' && s3.fullRange === false && s3.fps === 20, JSON.stringify(s3))
const s4 = videoInfo(0, h264Sps({ full: true, desc: [1, 1, 1], cut: true }))
check('  a VUI cut short keeps what came before the cut', s4 && s4.width === 1920 && s4.fullRange === true && s4.colourDesc?.matrix === 1 && s4.fps === null, JSON.stringify(s4))
check('  pictureSize unchanged on the same SPS', JSON.stringify(pictureSize(0, h264Sps({ full: true }))) === '{"width":1920,"height":1080}')
check('videoInfo: no SPS -> null', videoInfo(1, new Uint8Array([0, 0, 1, 0x26, 1, 2, 3])) === null && videoInfo(0, new Uint8Array(64).fill(0xff)) === null)

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
