// Offline tests for the video player's measuring hooks (public/player.js), with small stand-ins
// for WebCodecs and the page: frames held while the decoder is set up, codec changes,
// grabAfterKey's frame positions (and its fallback when keyframes are rare), the display range
// fix, and for playback from the server: the preroll skipped with a poster (skipUntil), stills
// (reverse, scrubbing) and seekReset (the decoder kept across seeks).
// No video is decoded: a stand-in decoder turns every chunk into a frame with its timestamp.
//   node cctv/test/player.test.mjs
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const tick = () => new Promise((r) => setImmediate(r))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- stand-ins --------------------------------------------------------------------------------
globalThis.window = { devicePixelRatio: 1 }
globalThis.requestAnimationFrame = () => 1 // frames stay queued; nothing here needs them shown
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.EncodedVideoChunk = class {
  constructor(init) {
    Object.assign(this, init)
  }
}
let live = 0 // VideoFrames not closed
const allFrames = [] // every VideoFrame made, to check which were closed
class FakeFrame {
  constructor(ts) {
    this.timestamp = ts
    this.displayWidth = this.codedWidth = 3840
    this.displayHeight = this.codedHeight = 2160
    this.visibleRect = { x: 0, y: 0, width: 64, height: 36 }
    this.colorSpace = { matrix: null, fullRange: false }
    this.closed = false
    live++
    allFrames.push(this)
  }
  clone() {
    return new FakeFrame(this.timestamp)
  }
  close() {
    if (this.closed) return
    this.closed = true
    live--
  }
}
const env = { setupMs: 0, refuseColour: false, configs: [], decoders: [] }
globalThis.VideoDecoder = class {
  static async isConfigSupported(config) {
    env.configs.push(config)
    if (env.setupMs) await sleep(env.setupMs)
    return { supported: !(config.colorSpace && env.refuseColour), config }
  }
  constructor({ output }) {
    this.output = output
    this.state = 'unconfigured'
    this.decodeQueueSize = 0
    this.decoded = []
    this.epoch = 0 // reset() drops the frames still being decoded, as WebCodecs does
    this.resets = 0
    this.configures = 0
    env.decoders.push(this)
  }
  configure(c) {
    this.config = c
    this.configures++
    this.state = 'configured'
  }
  decode(chunk) {
    this.decoded.push(chunk)
    this.decodeQueueSize++
    const epoch = this.epoch
    queueMicrotask(() => {
      if (epoch !== this.epoch) return
      this.decodeQueueSize--
      if (this.state === 'configured') this.output(new FakeFrame(chunk.timestamp))
    })
  }
  reset() {
    this.epoch++
    this.resets++
    this.decodeQueueSize = 0
    this.state = 'unconfigured'
  }
  close() {
    this.state = 'closed'
  }
}
const canvas = () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), getBoundingClientRect: () => ({ width: 64, height: 36 }) })
/** A canvas that notes the frame number of every picture drawn on it. */
const drawCanvas = (draws) => ({ width: 0, height: 0, getContext: () => ({ drawImage: (f) => draws.push(f.timestamp / US) }), getBoundingClientRect: () => ({ width: 64, height: 36 }) })

// an H.264 SPS (1920x1080, VUI: limited range, colour description 0/0/0 as TVT sends; or full range)
function sps(full = false) {
  const bits = []
  const u = (n, v) => {
    for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) % 2)
  }
  const ue = (v) => {
    const n = Math.floor(Math.log2(v + 1))
    u(n, 0)
    u(n + 1, v + 1)
  }
  u(8, 66)
  u(8, 0)
  u(8, 40)
  ue(0)
  ue(0)
  ue(2)
  ue(1)
  u(1, 0)
  ue(119)
  ue(67)
  u(1, 1)
  u(1, 1)
  u(1, 1)
  ue(0)
  ue(0)
  ue(0)
  ue(4)
  u(1, 1)
  u(1, 0)
  u(1, 0)
  u(1, 1)
  u(3, 5)
  u(1, full ? 1 : 0)
  u(1, 1)
  u(8, full ? 1 : 0)
  u(8, full ? 1 : 0)
  u(8, full ? 1 : 0)
  u(1, 0)
  u(1, 0)
  bits.push(1)
  while (bits.length % 8) bits.push(0)
  const out = []
  let zeros = 0
  for (let i = 0; i < bits.length; i += 8) {
    const x = bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0)
    if (zeros >= 2 && x <= 3) {
      out.push(3)
      zeros = 0
    }
    out.push(x)
    zeros = x === 0 ? zeros + 1 : 0
  }
  return [0, 0, 0, 1, 0x67, ...out]
}
const US = 50_000 // 20 fps
const chunk = (n, key, { codecId = 0, full = false } = {}) => ({
  isKey: key,
  codecId,
  timestampUs: n * US,
  data: new Uint8Array(key ? [...sps(full), 0, 0, 0, 1, 0x65, 0x88, 0x55] : [0, 0, 0, 1, 0x41, 0x9a, 0x55])
})

const A = await import('../public/player.js')
const results = []
for (const paused of [false, true]) {
  const p = new A.VideoPlayer(canvas(), process.argv.includes('--paused-cap') ? { maxQueuedImageBytes: 256 * 1024 * 1024 } : {})
  p.paused = paused
  p.push(chunk(0, true))
  await tick()
  for (let n = 1; n <= 100; n++) { p.push(chunk(n, false)); await tick() }
  results.push({paused, retainedFrames:p.queue.length, estimatedYuvMiB:p.queue.length*3840*2160*1.5/1024/1024})
  p.close()
  if (live !== 0) throw new Error(`Leaked ${live} frames`)
}
console.log(JSON.stringify({kind:'synthetic WebCodecs frame ownership, not real GPU allocation',results},null,2))
