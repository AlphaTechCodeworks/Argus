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
    this.displayWidth = this.codedWidth = 64
    this.displayHeight = this.codedHeight = 36
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
  constructor({ output, error }) {
    this.output = output
    this.error = error
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

{
  const unavailable = globalThis.VideoDecoder
  delete globalThis.VideoDecoder
  let refused = null
  const p = new A.VideoPlayer(canvas(), { onUnsupported: id => { refused = id } })
  await p.push(chunk(0, true))
  check('missing WebCodecs reports unsupported rather than silently leaving a black tile', refused === 0)
  p.close()
  globalThis.VideoDecoder = unavailable
}

{
  let refused = null
  const p = new A.VideoPlayer(canvas(), { onUnsupported: id => { refused = id } })
  await p.push(chunk(0, true, { codecId: 1 }))
  await tick()
  const decoder = p.decoder
  decoder.error(new Error('HEVC stream rejected after capability probe'))
  check('HEVC runtime failure requests the caller fallback and closes the rejected decoder', refused === 1 && p.decoder === null && decoder.state === 'closed')
  p.close()
}

// ---- set-up and holding --------------------------------------------------------------------
{
  env.setupMs = 20
  const p = new A.VideoPlayer(canvas())
  const seen = []
  p.onChunk = (c) => seen.push(c.timestampUs)
  for (let n = 0; n < 6; n++) p.push(chunk(n, n === 0)) // all arrive while the decoder is being set up
  await sleep(60)
  await tick()
  const d = env.decoders.at(-1)
  check('frames arriving while the decoder is set up are kept and decoded in order', d && d.decoded.map((c) => c.timestamp / US).join(',') === '0,1,2,3,4,5', d?.decoded.map((c) => c.timestamp / US).join(','))
  check('  onChunk sees each frame once, as it arrives', seen.map((t) => t / US).join(',') === '0,1,2,3,4,5')
  check('  keyframe timestamps are kept', p.keyTs.length === 1 && p.keyTsSet.has(0))
  p.close()
}
{
  env.setupMs = 30
  const p = new A.VideoPlayer(canvas())
  for (let n = 0; n < 45; n++) p.push(chunk(n, n === 0)) // 2.2 s of frames during one set-up
  await sleep(80)
  await tick()
  const d = env.decoders.at(-1)
  check('  more than 1 s / 30 frames: those are dropped, then wait for a keyframe', d.decoded.length === 1 && p.needKey === true, `${d.decoded.length} decoded`)
  p.push(chunk(45, false))
  await tick()
  p.push(chunk(46, true))
  await tick()
  check('  ... and carry on from it', d.decoded.map((c) => c.timestamp / US).join(',') === '0,46', d.decoded.map((c) => c.timestamp / US).join(','))
  p.close()
}
{
  env.setupMs = 0
  const p = new A.VideoPlayer(canvas())
  p.push(chunk(0, true))
  await tick()
  await tick()
  p.push(chunk(1, false))
  await tick()
  const first = env.decoders.at(-1)
  p.push(chunk(2, false, { codecId: 1 })) // another codec, not a keyframe: can't be decoded here
  await tick()
  check('a frame of another codec sets needKey and is not decoded', p.needKey && first.decoded.length === 2, `${first.decoded.length} decoded`)
  p.push(chunk(3, true, { codecId: 1 }))
  await tick()
  await tick()
  const second = env.decoders.at(-1)
  check('  its keyframe sets up a new decoder', second !== first && first.state === 'closed' && second.decoded.length === 1 && p.codecId === 1)
  p.close()
}

// ---- grabAfterKey --------------------------------------------------------------------------------
/** A live stream: frame n at n x 50 ms (fed without waiting), keyframes where isKey(n) says. */
async function play(p, from, to, isKey, { paceMs = 0 } = {}) {
  for (let n = from; n < to; n++) {
    p.push(chunk(n, isKey(n)))
    await tick()
    if (paceMs) await sleep(paceMs)
  }
}
const every40 = (n) => n % 40 === 0
{
  const p = new A.VideoPlayer(canvas())
  await play(p, 0, 50, every40) // two keyframes seen: keyframe interval 2 s known
  const got = []
  const grab = p.grabAfterKey({ sink: (f, meta) => { got.push({ n: f.timestamp / US, ...meta }); f.close() } })
  await play(p, 50, 150, every40)
  const r = await grab
  check('grabAfterKey: keyframe +6, 12, 18, 24 in two keyframe intervals in a row', got.map((g) => g.n).join(',') === '86,92,98,104,126,132,138,144' && JSON.stringify(r.sets) === '[[6,12,18,24],[6,12,18,24]]', got.map((g) => `${g.set}:${g.n}`).join(' '))
  check('  resolves complete and aligned, with the interval', r.complete && r.aligned && r.frames === 8 && r.gopMs === 2000, JSON.stringify(r))
  check('  meta: set, sinceKey, ts, display colour, self-check on the first frame of each set', got[0].set === 0 && got[4].set === 1 && got[0].sinceKey === 6 && got[0].ts === 86 * US && got[0].displayRange === 'limited' && got[0].displayMatrix === 'bt709' && got[0].selfCheck && !got[1].selfCheck && got[4].selfCheck, JSON.stringify(got[0]))
  check('  the player keeps none of the clones', got.length === 8 && !p.gop)
  let second = null
  try {
    const g1 = p.grabAfterKey({ sink: (f) => f.close(), timeoutMs: 50 })
    await p.grabAfterKey({ sink: (f) => f.close() }).catch((e) => (second = e.message))
    await g1.catch(() => {})
  } catch {}
  check('  one measurement at a time', second === 'a measurement is already running', second)
  p.close()
}
{
  // a viewer connects: the NVR asks for extra keyframes (as in JP Bond's clip: 0, 1, 7, 8)
  const p = new A.VideoPlayer(canvas())
  await play(p, 0, 50, every40)
  const got = []
  const grab = p.grabAfterKey({ sink: (f, meta) => { got.push({ n: f.timestamp / US, ...meta }); f.close() } })
  const keys = new Set([80, 81, 90]) // 81: 50 ms after 80; 90: after the set's first frame (86)
  await play(p, 50, 175, (n) => every40(n) || keys.has(n))
  const r = await grab
  check('an extra keyframe under 1 s after another starts the set again (not the next set)', JSON.stringify(r.sets[0]) === '[6,6,12,18,24]' && got.filter((g) => g.set === 0).map((g) => g.n).join(',') === '87,96,102,108,114', `${JSON.stringify(r.sets)} ${got.map((g) => `${g.set}:${g.n}`).join(' ')}`)
  check('  the second set starts at the next scheduled keyframe', JSON.stringify(r.sets[1]) === '[6,12,18,24]' && got.find((g) => g.set === 1)?.n === 126, got.filter((g) => g.set === 1).map((g) => g.n).join(','))
  p.close()
}
{
  // H.265+: the next keyframe is far off; wait (here 100 ms instead of 12 s), then take them anywhere
  const p = new A.VideoPlayer(canvas())
  await play(p, 0, 20, (n) => n === 0)
  const got = []
  const grab = p.grabAfterKey({ keyWaitMs: 100, sink: (f, meta) => { got.push({ n: f.timestamp / US, ...meta }); f.close() } })
  await play(p, 20, 120, (n) => n === 0, { paceMs: 4 })
  const r = await grab
  const ns = got.map((g) => g.n)
  const steps = ns.slice(1).map((n, i) => n - ns[i])
  check('rare keyframes: after the wait, 2 sets of 4 frames 6 apart from where the stream is', got.length === 8 && steps.every((s) => s === 6) && got.slice(0, 4).every((g) => g.set === 0) && got.slice(4).every((g) => g.set === 1), `${ns.join(',')}`)
  check('  marked not aligned; sinceKey still counted from the last keyframe', !r.aligned && !got[0].aligned && got[0].sinceKey === got[0].n, JSON.stringify({ aligned: r.aligned, sk: got[0].sinceKey, n: got[0].n }))
  p.close()
}
{
  // keyframes every 8 s but one comes soon: the first set starts at it, the second follows at once
  const p = new A.VideoPlayer(canvas())
  await play(p, 0, 170, (n) => n === 0 || n === 160) // interval 8 s known
  const got = []
  const grab = p.grabAfterKey({ sink: (f, meta) => { got.push({ n: f.timestamp / US, ...meta }); f.close() } })
  await play(p, 170, 380, (n) => n % 160 === 0)
  const r = await grab
  check('long keyframe interval: set A after the keyframe, set B right after it in the same interval', JSON.stringify(r.sets) === '[[6,12,18,24],[30,36,42,48]]' && r.aligned && got[0].n === 326, `${JSON.stringify(r.sets)} from ${got[0]?.n}`)
  p.close()
}
{
  // a stream that just started (after a camera restart): its first keyframe starts set A with
  // the interval not known yet; set B waits for the next keyframe instead of running across it
  const p = new A.VideoPlayer(canvas())
  const got = []
  const grab = p.grabAfterKey({ sink: (f, meta) => { got.push({ n: f.timestamp / US, ...meta }); f.close() } })
  await play(p, 0, 120, every40)
  const r = await grab
  check('unknown keyframe interval: set B starts at the next keyframe (not +30..48 across it)', JSON.stringify(r.sets) === '[[6,12,18,24],[6,12,18,24]]' && got.map((g) => g.n).join(',') === '6,12,18,24,46,52,58,64' && r.complete && r.aligned && r.gopMs === 2000, `${JSON.stringify(r.sets)} ${got.map((g) => g.n).join(',')}`)
  p.close()
}
{
  // ... and if that keyframe does not come soon, the rest from where the stream is (sinceKey counted)
  const p = new A.VideoPlayer(canvas())
  const got = []
  const grab = p.grabAfterKey({ sink: (f, meta) => { got.push({ n: f.timestamp / US, ...meta }); f.close() } })
  await play(p, 0, 30, (n) => n === 0)
  await sleep(5100) // no keyframe within 5 s
  await play(p, 30, 80, (n) => n === 0)
  const r = await grab
  check('  no next keyframe within 5 s: set B from where the stream is', r.complete && r.sets[0].join() === '6,12,18,24' && r.sets[1].length === 4 && got.slice(4).every((g, i, a) => i === 0 || g.n - a[i - 1].n === 6) && got[4].sinceKey === got[4].n, `${JSON.stringify(r.sets)} ${got.map((g) => g.n).join(',')}`)
  p.close()
}
{
  const p = new A.VideoPlayer(canvas())
  await play(p, 0, 50, every40)
  const ctl = new AbortController()
  const got = []
  const grab = p.grabAfterKey({ signal: ctl.signal, sink: (f, meta) => { got.push(meta); f.close() } })
  await play(p, 50, 90, every40)
  ctl.abort()
  let err = null
  await grab.catch((e) => (err = e))
  await play(p, 90, 140, every40)
  check('cancel: rejects with AbortError and takes nothing more', err?.name === 'AbortError' && got.length === 1 && !p.gop, `${err?.name} after ${got.length}`)
  const grab2 = p.grabAfterKey({ sink: (f, meta) => { got.push(meta); f.close() } })
  await play(p, 140, 180, every40)
  p.reset()
  const r = await grab2
  check('  a stream restart ends it with what it has', r.reason === 'stream restarted' && !r.complete && r.frames === 3, JSON.stringify(r))
  const grab3 = p.grabAfterKey({ sink: (f) => f.close() })
  p.close()
  let closed = null
  await grab3.catch((e) => (closed = e.message))
  check('  closing the player rejects it', closed === 'closed')
}
check('no VideoFrame left open by the grabs (queued display frames closed on close())', live === 0, `${live} open`)

// ---- server playback: preroll (skipUntil), stills, seekReset ------------------------------------------------
{
  // a seek on a running player: its decoder is set up already. The server sends the GOP from the
  // keyframe (frame 0) at once; the viewer asked for frame 30
  env.setupMs = 0
  const draws = []
  const shown = []
  const posters = []
  const p = new A.VideoPlayer(drawCanvas(draws), { onFrame: (ts) => shown.push(ts), onPoster: (ts) => posters.push(ts) })
  await play(p, 1000, 1003, (n) => n === 1000) // playing somewhere else before the seek
  const d = env.decoders.at(-1)
  p.seekReset()
  p.skipUntil(30 * 50)
  const mark = allFrames.length
  for (let n = 0; n < 50; n++) p.push(chunk(n, n === 0)) // all 50 at once
  await tick()
  await tick()
  const made = allFrames.slice(mark)
  const before = made.filter((f) => f.timestamp < 30 * US)
  check('skipUntil: none of the 50 is dropped by the decode-queue guard (all pushed at once)', d.decoded.length >= 50 && p.stats.dropped === 0 && !p.needKey, `${d.decoded.length} decoded, ${p.stats.dropped} dropped`)
  check('  frames 1-29 are closed, not shown and not counted as dropped', before.length === 30 && before.every((f) => f.closed) && p.queue.every((q) => q.ts >= 1500) && p.queue.length === 20, `${before.filter((f) => !f.closed).length} open, queue ${p.queue.length}`)
  check('  the keyframe is drawn once as a poster, without onFrame (onPoster says so)', draws.join() === '0' && shown.length === 0 && posters.join() === '0', `draws ${draws.join()} shown ${shown.join()} posters ${posters.join()}`)
  p.present(p.clock.presentAt(1500) + 1)
  check('  onFrame is first called with frame 30', shown[0] === 1500 && draws.join() === '0,30', `shown ${shown.join()} draws ${draws.join()}`)
  check('  skipping is over once frame 30 is decoded', p.skipTs === null)
  p.close()
}
{
  // the first start: the burst arrives while the decoder is still being set up (held frames)
  env.setupMs = 20
  const draws = []
  const shown = []
  const p = new A.VideoPlayer(drawCanvas(draws), { onFrame: (ts) => shown.push(ts) })
  p.skipUntil(30 * 50)
  for (let n = 0; n < 50; n++) p.push(chunk(n, n === 0)) // 2.5 s of frames during the set-up
  await sleep(60)
  await tick()
  await tick()
  const d = env.decoders.at(-1)
  check('skipUntil at the first start: frames held during set-up are kept beyond 30 frames / 1 s', d.decoded.length === 50 && p.stats.dropped === 0 && draws.join() === '0' && p.queue.length === 20, `${d.decoded.length} decoded, ${p.stats.dropped} dropped, draws ${draws.join()}, queue ${p.queue.length}`)
  p.close()
  env.setupMs = 0
}
{
  // without skipUntil the guards are as before
  const p = new A.VideoPlayer(canvas())
  await play(p, 0, 2, (n) => n === 0)
  for (let n = 2; n < 50; n++) p.push(chunk(n, false))
  await tick()
  check('  without skipUntil the decode-queue guard still drops a burst (12 frames)', p.stats.dropped > 0 && p.needKey, `${p.stats.dropped} dropped`)
  p.close()
}
{
  const draws = []
  const shown = []
  const p = new A.VideoPlayer(drawCanvas(draws), { onFrame: (ts) => shown.push(ts) })
  await play(p, 0, 3, (n) => n === 0) // playing: frames wait in the queue for their display time
  const queued = p.queue.map((q) => q.frame)
  p.setStills(true)
  check('setStills(true): the frames waiting for display are closed (not counted as dropped)', p.queue.length === 0 && queued.every((f) => f.closed) && p.stats.dropped === 0)
  for (const n of [120, 80, 40]) {
    p.push(chunk(n, true)) // reverse: keyframes going back
    await tick()
    await tick()
  }
  check('  each decoded frame is drawn at once and onFrame is called for it; the queue is not used', draws.join() === '120,80,40' && shown.join() === '6000,4000,2000' && p.queue.length === 0, `draws ${draws.join()} shown ${shown.join()}`)
  const anchored = p.clock.anchor !== null // (still the one from the frames played before)
  p.setStills(false)
  check('setStills(false): the clock anchor is reset', anchored && p.clock.anchor === null)
  p.push(chunk(41, false))
  await tick()
  const lead = p.clock.presentAt(41 * 50) - performance.now()
  check('  the next frame is anchored afresh (shown after the playout delay, not by the old anchor)', p.queue.length === 1 && Math.abs(lead - p.clock.delay) < 30 && draws.length === 3, `lead ${Math.round(lead)} ms, delay ${p.clock.delay}`)
  p.setStills(true)
  p.pause()
  p.push(chunk(20, true))
  await tick()
  await tick()
  check('  stills are drawn while paused too (scrubbing)', draws.join() === '120,80,40,20' && shown.at(-1) === 1000, draws.join())
  p.close()
}
{
  // a 1x start with a preroll (skipUntil), then reverse: {type:'mode', stills:true} comes and the
  // keyframes going back are all older than the start's `at`. Reverse never skips: each is shown.
  const draws = []
  const shown = []
  const p = new A.VideoPlayer(drawCanvas(draws), { onFrame: (ts) => shown.push(ts) })
  await play(p, 1000, 1003, (n) => n === 1000) // playing somewhere else before the seek
  p.seekReset()
  p.skipUntil(130 * 50)
  p.push(chunk(100, true)) // the preroll's keyframe: drawn as the poster
  await tick()
  await tick()
  p.setStills(true)
  check('setStills(true) ends a preroll skip (reverse and scrubbing never skip)', p.skipTs === null, `skipTs ${p.skipTs}`)
  for (const n of [80, 60]) {
    p.push(chunk(n, true))
    await tick()
    await tick()
  }
  check('  keyframes older than the skipped-to time are drawn and reported to onFrame', draws.join() === '100,80,60' && shown.join() === '4000,3000', `draws ${draws.join()} shown ${shown.join()}`)
  p.close()
}
{
  // the same with stills on already: a camera change while reversing. The new socket starts at 1x
  // (with a preroll) before its {speed:-4} arrives, then says {type:'mode', stills:true}
  const draws = []
  const shown = []
  const p = new A.VideoPlayer(drawCanvas(draws), { onFrame: (ts) => shown.push(ts) })
  p.setStills(true)
  await play(p, 1000, 1001, (n) => n === 1000) // a still of the camera before
  p.seekReset()
  p.skipUntil(130 * 50)
  p.push(chunk(100, true))
  await tick()
  await tick()
  p.setStills(true)
  for (const n of [80, 60]) {
    p.push(chunk(n, true))
    await tick()
    await tick()
  }
  check('  stills on already: setStills(true) still ends the skip', p.skipTs === null && draws.join() === '1000,100,80,60' && shown.join() === '50000,4000,3000', `skipTs ${p.skipTs} draws ${draws.join()} shown ${shown.join()}`)
  p.close()
}
{
  env.configs.length = 0
  const p = new A.VideoPlayer(canvas())
  await play(p, 0, 10, (n) => n === 0)
  const d = env.decoders.at(-1)
  const config = d.config
  const configs = env.configs.length
  p.push(chunk(10, false)) // still being decoded when the seek comes
  const openBefore = live
  p.seekReset()
  await tick()
  await tick()
  check('seekReset: the same decoder, reset and configured again with the saved config (no isConfigSupported)', env.decoders.at(-1) === d && d.resets === 1 && d.configures === 2 && d.config === config && d.state === 'configured' && env.configs.length === configs, `resets ${d.resets} configures ${d.configures} configs ${env.configs.length - configs}`)
  check('  needKey is set, nothing is queued, and no VideoFrame is left open', p.needKey && p.queue.length === 0 && live === 0, `needKey ${p.needKey} queue ${p.queue.length} open ${live} (was ${openBefore})`)
  p.push(chunk(200, false))
  await tick()
  p.push(chunk(201, true))
  await tick()
  check('  a delta frame after it waits for the keyframe; the keyframe goes to the same decoder', d.decoded.at(-1).timestamp === 201 * US && !d.decoded.some((c) => c.timestamp === 200 * US) && env.decoders.at(-1) === d && env.configs.length === configs)
  p.close()
  const q = new A.VideoPlayer(canvas())
  q.seekReset() // before any decoder: nothing to reset
  check('  seekReset before the first frame is harmless', q.needKey && !q.decoder)
  q.close()
}
{
  // a frame step on a paused player: the server sends the GOP from the keyframe (frame 0) up to the
  // frame asked for (31) and nothing after it
  const draws = []
  const shown = []
  const posters = []
  const p = new A.VideoPlayer(drawCanvas(draws), { onFrame: (ts) => shown.push(ts), onPoster: (ts) => posters.push(ts) })
  await play(p, 0, 31, (n) => n === 0) // playing, frames waiting for their display time
  p.pause()
  const waiting = p.queue.map((q) => q.frame)
  draws.length = 0
  shown.length = 0
  p.seekReset()
  p.stepTo(31 * 50)
  const mark = allFrames.length
  for (let n = 0; n <= 31; n++) p.push(chunk(n, n === 0)) // all at once
  await tick()
  await tick()
  const made = allFrames.slice(mark)
  check('stepTo: the frame asked for is drawn at once on a paused player, and reported to onFrame', draws.join() === '31' && shown.join() === '1550' && p.paused, `draws ${draws.join()} shown ${shown.join()}`)
  check('  no poster: the keyframe and the frames before the one asked for are decoded and closed unseen', posters.length === 0 && made.length === 32 && made.every((f) => f.closed) && p.stats.dropped === 0 && !p.needKey, `${posters.length} posters, ${made.filter((f) => !f.closed).length} open, ${p.stats.dropped} dropped`)
  check('  nothing is left waiting for display, and the frames that were are closed', p.queue.length === 0 && waiting.length > 0 && waiting.every((f) => f.closed) && p.skipTs === null && p.stepShow === false, `queue ${p.queue.length}`)
  // play goes on with the frames after it: decoded by the same decoder, shown by the clock again
  p.resume()
  p.push(chunk(32, false))
  await tick()
  await tick()
  check('  the frame after it, on play, is queued for its display time as always (not drawn at once)', p.queue.length === 1 && p.queue[0].ts === 1600 && draws.join() === '31', `queue ${p.queue.length} draws ${draws.join()}`)
  // a seek's start after a step skips with a poster again
  p.seekReset()
  p.skipUntil(110 * 50)
  for (let n = 100; n <= 111; n++) p.push(chunk(n, n === 100))
  await tick()
  await tick()
  check('  skipUntil after a step: the poster is back, and the frames due wait for the clock', draws.join() === '31,100' && posters.join() === '5000' && p.queue.length === 2 && shown.join() === '1550', `draws ${draws.join()} queue ${p.queue.length}`)
  p.close()
}
{
  // the same before any decoder is set up (a step as the first thing after opening the page), and in
  // stills (reverse chosen, paused): only the frame asked for is drawn there too
  env.setupMs = 20
  const draws = []
  const shown = []
  const p = new A.VideoPlayer(drawCanvas(draws), { onFrame: (ts) => shown.push(ts) })
  p.pause()
  p.setStills(true)
  p.seekReset()
  p.stepTo(40 * 50)
  for (let n = 0; n <= 40; n++) p.push(chunk(n, n === 0))
  await sleep(60)
  await tick()
  await tick()
  check('stepTo at the first start, in stills: frames held during set-up are all decoded, one drawn', env.decoders.at(-1).decoded.length === 41 && draws.join() === '40' && shown.join() === '2000' && p.stats.dropped === 0, `${env.decoders.at(-1).decoded.length} decoded, draws ${draws.join()}`)
  p.close()
  env.setupMs = 0
}
check('no VideoFrame left open after the server-playback cases', live === 0, `${live} open`)

// ---- display range fix --------------------------------------------------------------------------
{
  env.configs.length = 0
  const p = new A.VideoPlayer(canvas())
  p.push(chunk(0, true))
  await tick()
  await tick()
  check('without ?range=full: no colour-space override; shown as limited range', !env.configs.some((c) => c.colorSpace) && !p.rangeFixed && p.displayColour().range === 'limited', JSON.stringify(p.displayColour()))
  p.close()
}
globalThis.location = { search: '?range=full' }
const B = await import('../public/player.js?range=full')
{
  env.configs.length = 0
  const p = new B.VideoPlayer(canvas())
  p.push(chunk(0, true))
  await tick()
  await tick()
  const cfg = env.decoders.at(-1).config
  check('?range=full on a TVT stream (limited flag, 0/0/0): full-range BT.709 override', JSON.stringify(cfg.colorSpace) === JSON.stringify({ fullRange: true, matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' }) && p.rangeFixed, JSON.stringify(cfg))
  check('  displayColour says so', JSON.stringify(p.displayColour()) === JSON.stringify({ matrix: 'bt709', range: 'full', rangeFixed: true }))
  p.close()
  const q = new B.VideoPlayer(canvas())
  q.push(chunk(0, true, { full: true }))
  await tick()
  await tick()
  check('  a stream that flags full range (JPB DOOR) is left as it is', !env.decoders.at(-1).config.colorSpace && !q.rangeFixed && q.displayColour().range === 'full')
  q.close()
  env.refuseColour = true
  const r = new B.VideoPlayer(canvas())
  r.push(chunk(0, true))
  await tick()
  await tick()
  check('  a browser that refuses the override still plays, without it', env.decoders.at(-1).state === 'configured' && !env.decoders.at(-1).config.colorSpace && !r.rangeFixed)
  r.close()
  env.refuseColour = false
}
check('wantsRangeFix: only limited range with no colour description', A.wantsRangeFix({ fullRange: false, colourDesc: null }) && !A.wantsRangeFix({ fullRange: true, colourDesc: null }) && !A.wantsRangeFix({ fullRange: false, colourDesc: { primaries: 1, transfer: 1, matrix: 1 } }) && !A.wantsRangeFix({ fullRange: null, colourDesc: null }) && !A.wantsRangeFix(null))

// ---- remote playback: timed on arrival, a bigger buffer, the remote clock at 1x (playback hunt F4) ----
{
  const { REMOTE_PLAYBACK_CLOCK, PLAYBACK_CLOCK } = await import('../public/playout.js')
  const p = new A.VideoPlayer(canvas(), { clock: PLAYBACK_CLOCK })
  check('local playback: not timed on arrival, the 45-frame buffer, no remote profile (unchanged by this)', p.arrivalClock === false && p.maxQueued === 45 && p.remote === null && p.clock.opts.stretchLate === false, `arrival ${p.arrivalClock}, queued ${p.maxQueued}, remote ${p.remote}`)
  p.remotePlayback({ clock: REMOTE_PLAYBACK_CLOCK })
  check('remotePlayback: frames timed on arrival, up to REMOTE_QUEUED_FRAMES kept, the remote profile at 1x', p.arrivalClock === true && p.maxQueued >= A.REMOTE_QUEUED_FRAMES && p.remote !== null && p.clock.opts.stretchLate === true && p.clock.opts.restartPastMax === true, `arrival ${p.arrivalClock}, queued ${p.maxQueued} vs ${A.REMOTE_QUEUED_FRAMES}`)
  p.setRate(2)
  check('  at a faster speed it falls back to the page clock (the stretch/re-anchor is a 1x rule)', p.clock.opts.stretchLate === false && p.clock.opts.restartPastMax !== true, JSON.stringify(p.clock.opts.stretchLate))
  p.setRate(1)
  check('  back at 1x the remote profile again', p.clock.opts.stretchLate === true && p.clock.opts.restartPastMax === true)
  p.remotePlayback({ clock: REMOTE_PLAYBACK_CLOCK })
  check('  calling it again is harmless (idempotent)', p.arrivalClock === true && p.remote !== null)
  p.close()

  const np = new A.VideoPlayer(canvas(), { pacing: false })
  np.remotePlayback({ clock: REMOTE_PLAYBACK_CLOCK })
  check('without pacing there is no playout clock to make remote: remotePlayback is a no-op', np.arrivalClock === false && np.remote === null)
  np.close()
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
