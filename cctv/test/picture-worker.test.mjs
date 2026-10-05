// Offline test of the measuring Worker (public/picture-worker.js) with stand-ins for the Worker
// scope, VideoFrame and OffscreenCanvas: frames are copied out and closed, measured in order,
// the display self-check runs on the frames asked for, and opaque frames fall back to drawing.
//   node cctv/test/picture-worker.test.mjs
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const out = []
globalThis.self = { postMessage: (m) => out.push(m) }
const W = 640
const H = 360
const lum = (x, y) => Math.round(70 + 90 * (x / W) + 30 * Math.sin(x / 37) * Math.cos(y / 23))
const coded = (x, y) => (x < W / 10 ? 10 : lum(x, y)) // a dark strip on the left: coded 10, shown black by a limited display
// what the browser draws: a limited-range display (coded 0-16 -> black), for the self-check;
// drawImage's source rectangle is honoured (the self-check draws a region 1:1)
const drawnRects = []
globalThis.OffscreenCanvas = class {
  constructor(w, h) {
    this.w = w
    this.h = h
  }
  getContext() {
    let src = [0, 0, W, H]
    return {
      drawImage: (_frame, ...a) => {
        if (a.length === 8) src = a.slice(0, 4)
        drawnRects.push({ src, w: this.w, h: this.h })
      },
      getImageData: (x, y, w, h) => {
        const [sx, sy, sw, sh] = src
        const data = new Uint8ClampedArray(w * h * 4)
        for (let j = 0; j < h; j++) {
          for (let i = 0; i < w; i++) {
            const v = Math.max(0, Math.min(255, ((coded(sx + (i * sw) / w, sy + (j * sh) / h) - 16) * 255) / 219))
            data.set([v, v, v, 255], 4 * (j * w + i))
          }
        }
        return { data, width: w, height: h }
      }
    }
  }
}
let open = 0
class FakeFrame {
  constructor(format, ts) {
    this.format = format
    this.timestamp = ts
    this.codedWidth = this.displayWidth = W
    this.codedHeight = this.displayHeight = H
    this.visibleRect = { x: 0, y: 0, width: W, height: H }
    this.colorSpace = { matrix: 'rgb', fullRange: false } // what a browser may report for TVT's 0/0/0
    this.closed = false
    this.copied = false
    open++
  }
  allocationSize() {
    return W * H * 3 / 2 + 64
  }
  async copyTo(buf) {
    if (this.closed) throw new Error('closed')
    this.copied = true
    const pad = 32 // planes not packed tight, as a decoder may lay them out
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) buf[y * W + x] = coded(x, y)
    const c = W * H + pad
    if (this.format === 'NV12') {
      for (let i = 0; i < (W / 2) * (H / 2); i++) {
        buf[c + 2 * i] = 128 + (i % 7) - 3
        buf[c + 2 * i + 1] = 128 + (i % 5) - 2
      }
      return [{ offset: 0, stride: W }, { offset: c, stride: W }]
    }
    for (let i = 0; i < (W / 2) * (H / 2); i++) {
      buf[c + i] = 128 + (i % 7) - 3
      buf[c + (W / 2) * (H / 2) + i] = 128 + (i % 5) - 2
    }
    return [{ offset: 0, stride: W }, { offset: c, stride: W / 2 }, { offset: c + (W / 2) * (H / 2), stride: W / 2 }]
  }
  close() {
    if (!this.closed) open--
    this.closed = true
  }
}

await import('../public/picture-worker.js')
const send = (msg) => self.onmessage({ data: msg })
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

send({ type: 'start', opts: { stream: 'main', codec: 'h265' } })
const frames = [6, 12, 18, 24].map((k) => new FakeFrame('I420', k))
frames.forEach((f, i) => send({ type: 'frame', frame: f, meta: { set: 0, sinceKey: f.timestamp, ts: f.timestamp, aligned: true, selfCheck: i === 0 } }))
send({ type: 'result', id: 1 })
await settle()
const res = out.find((m) => m.type === 'result' && m.id === 1)?.result
check('frames are copied out, then closed (none left open)', frames.every((f) => f.copied && f.closed) && open === 0, `open ${open}`)
check('each frame reported as measured, in order, before the result', out.filter((m) => m.type === 'added').length === 4 && out.findIndex((m) => m.type === 'result') === 4)
check('the result covers every frame sent before it', res && res.frames === 4 && res.planes === 'coded' && res.noise.sets[0].pairs.length === 3, res && `${res.frames} frames`)
check('  display colour from the frame: limited range, BT.709 for a reported "rgb" matrix', res.displayRange === 'limited' && res.displayMatrix === 'bt709')
check('  stream and codec from start', res.stream === 'main' && res.codec === 'h265')
check('display self-check on the frame asked for: this display clips the coded shadows -> limited', res.selfCheck && res.selfCheck.range === 'limited' && res.selfCheck.all.length === 1 && out.find((m) => m.type === 'added').selfCheck?.range === 'limited', JSON.stringify(res.selfCheck))
const rect = drawnRects.at(-1)
check('  the region is drawn 1:1 (320x180 of the frame, not the frame scaled down), clear of the OSD bands, where it can tell', rect && rect.w === 320 && rect.h === 180 && rect.src[2] === 320 && rect.src[3] === 180 && rect.src[1] >= 0.15 * H && rect.src[1] + 180 <= 0.85 * H + 1 && rect.src[0] === 0 && JSON.stringify(res.selfCheck.region) === JSON.stringify(rect.src), JSON.stringify({ rect, region: res.selfCheck.region }))

out.length = 0
send({ type: 'start', opts: {} })
const nv = new FakeFrame('NV12', 6)
send({ type: 'frame', frame: nv, meta: { set: 0, sinceKey: 6, displayRange: 'full', displayMatrix: 'bt709' } })
send({ type: 'result', id: 2 })
await settle()
const r2 = out.find((m) => m.type === 'result')?.result
check('NV12 frames: measured from the interleaved chroma; meta can set the display range', r2 && r2.frames === 1 && !r2.mono && r2.displayRange === 'full' && nv.closed, r2 && JSON.stringify({ mono: r2.mono, range: r2.displayRange }))

out.length = 0
send({ type: 'start', opts: {} })
const opaque = new FakeFrame(null, 6)
send({ type: 'frame', frame: opaque, meta: { set: 0, sinceKey: 6, displayRange: 'limited', selfCheck: true } })
send({ type: 'result', id: 3 })
await settle()
const r3 = out.find((m) => m.type === 'result')?.result
check('a frame with no format (GPU memory): measured as the browser draws it', r3 && r3.planes === 'rgba' && r3.displayRange === 'full' && !opaque.copied && opaque.closed && r3.selfCheck === null, r3 && JSON.stringify({ planes: r3.planes, range: r3.displayRange, self: r3.selfCheck }))

out.length = 0
const bad = new FakeFrame('I420', 6)
bad.copyTo = async () => {
  throw new Error('copy failed')
}
send({ type: 'frame', frame: bad, meta: {} })
send({ type: 'result', id: 4 })
await settle()
check('a frame that fails: an error message, the frame closed, later messages still answered', out[0]?.type === 'error' && /copy failed/.test(out[0].message) && bad.closed && out.some((m) => m.type === 'result' && m.id === 4))
check('no VideoFrame left open', open === 0, `open ${open}`)

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
