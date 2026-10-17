// "Steady picture" by locking to the background (steady-lock.mjs): the FFT, the measurement against a
// known move, a swaying camera held still, the empty edge kept from the picture before (not smeared),
// the background taken again when the picture changes (day/night), yuv4mpeg read in pieces, and the
// conversion's life (start on a keyframe, both ffmpegs, times handed back, failure, reset) with fake
// ffmpegs. No ffmpeg, no SDK, no worker thread.
//   node cctv/test/steady-lock.test.mjs
import { EventEmitter } from 'node:events'
import {
  InlineLocker, LockTranscoder, Locker, MAX_SHIFT_SHARE, RESET_SAY_MS, WHOLE_PIXEL_WIDTH, Y4mReader, decodeArgs, encodeArgs, fft2
} from '../steady-lock.mjs'
import { CODEC_H264, CODEC_H265 } from '../transcode.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

// ---- the FFT ------------------------------------------------------------------------------------------
{
  const w = 16
  const h = 8
  const re = Float64Array.from({ length: w * h }, (_, i) => Math.sin(i * 0.37) + (i % 5))
  const im = new Float64Array(w * h)
  const orig = Float64Array.from(re)
  fft2(re, im, w, h)
  check('the FFT of a grid: its first bin is the sum', Math.abs(re[0] - orig.reduce((a, b) => a + b, 0)) < 1e-9)
  fft2(re, im, w, h, true)
  check('... and back again (divided by its size) is the grid', orig.every((v, i) => Math.abs(re[i] / (w * h) - v) < 1e-9 && Math.abs(im[i]) < 1e-9))
}

// ---- a scene and a camera looking at it -----------------------------------------------------------
const W = 352
const H = 198
const WW = 420
const WH = 260
let seed = 11
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
const world = new Float64Array(WW * WH)
for (let k = 0; k < 50; k++) {
  const cx = rnd() * WW
  const cy = rnd() * WH
  const r = 4 + rnd() * 25
  const v = rnd() * 200
  for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) {
    const d = (x - cx) ** 2 + (y - cy) ** 2
    if (d < r * r) world[y * WW + x] += v * (1 - d / (r * r))
  }
}
for (let i = 0; i < world.length; i++) world[i] = Math.min(250, world[i] + rnd() * 10)
/** What the camera sees with its view's corner at (ox, oy) of the scene: yuv420p, colour `uv` (128: grey). */
const view = (ox, oy, { uv = 140, light = 0 } = {}) => {
  const f = Buffer.alloc(W * H * 1.5, uv)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = x + ox
    const sy = y + oy
    const x0 = Math.floor(sx)
    const y0 = Math.floor(sy)
    const fx = sx - x0
    const fy = sy - y0
    const g = (a, b) => world[b * WW + a]
    f[y * W + x] = Math.min(255, light + (1 - fx) * (1 - fy) * g(x0, y0) + fx * (1 - fy) * g(x0 + 1, y0) + (1 - fx) * fy * g(x0, y0 + 1) + fx * fy * g(x0 + 1, y0 + 1))
  }
  return f
}

// ---- measuring and holding still -------------------------------------------------------------------
{
  const L = new Locker({ width: W, height: H })
  const first = L.process(view(30, 30))
  check('the first picture is the background: out as it came, not moved', first.moved === false && first.dx === 0 && first.dy === 0)
  const r = L.process(view(36.5, 26))
  check('the camera swings 6.5 right and 4 up: the picture is moved back by as much', Math.abs(r.dx + 6.5) < 0.4 && Math.abs(r.dy - 4) < 0.4 && r.moved, `${r.dx.toFixed(2)}, ${r.dy.toFixed(2)}`)
  // a camera swaying in the wind for 80 pictures: where the scene sits in the picture out stays put
  let worst = 0
  for (let i = 0; i < 80; i++) {
    const t = i / 20
    const ox = 30 + 7 * Math.sin(2 * Math.PI * 0.7 * t) + 2 * Math.sin(2 * Math.PI * 2.3 * t)
    const oy = 30 + 5 * Math.sin(2 * Math.PI * 0.9 * t + 1)
    const s = L.process(view(ox, oy))
    worst = Math.max(worst, Math.hypot(s.dx + (ox - 30), s.dy + (oy - 30)))
  }
  check('a camera swaying up to 9 px in the wind is held within half a pixel of its background', worst < 0.5, worst.toFixed(2))
}
{
  // the edge: moved 8 left, the right-hand 8 columns had nothing; they keep the picture before's, not a smear
  const L = new Locker({ width: W, height: H })
  L.process(view(30, 30))
  const before = Buffer.from(L.canvas)
  const r = L.process(view(38, 30))
  const out = r.frame
  let same = 0
  let smeared = 0
  for (let y = 40; y < 150; y++) {
    const x = W - 3
    if (Math.abs(out[y * W + x] - before[y * W + x]) <= 2) same++
    if (out[y * W + x] === out[y * W + W - 9]) smeared++
  }
  check('the empty edge keeps what the picture before showed there (sharp, not the last column repeated)', same > 100 && smeared < 20, `${same} same, ${smeared} smeared`)
}
{
  // day to night: the colour goes, the picture is new; the background is taken again, once
  const L = new Locker({ width: W, height: H })
  L.process(view(30, 30))
  L.process(view(32, 30))
  const r = L.process(view(32, 30, { uv: 128 }))
  check('the camera switching to infrared (the colour gone): the background is taken again', r.reset === true && r.moved === false && L.resets === 1)
  const after = L.process(view(35, 30, { uv: 128 }))
  check('... and held from there', after.moved && Math.abs(after.dx + 3) < 0.4, after.dx.toFixed(2))
  const lit = L.process(view(35, 30, { uv: 128, light: 60 }))
  check('lights coming on (much brighter at once): taken again too', lit.reset === true && L.resets === 2)
}
{
  // a move far bigger than wind (the camera turned): not followed, the picture held where it was
  const L = new Locker({ width: W, height: H })
  L.process(view(30, 30))
  L.process(view(33, 30))
  const big = L.process(view(30 + MAX_SHIFT_SHARE * W * 1.2 + 3, 30))
  check('a jump bigger than the wind could make is not followed: moved as the picture before', Math.abs(big.dx + 3) < 0.4, big.dx.toFixed(2))
}
{
  // full quality (at least WHOLE_PIXEL_WIDTH wide): moved by whole pixels, a row at a time
  const BW = WHOLE_PIXEL_WIDTH + 24
  const BH = 200
  const scene = new Uint8Array((BW + 40) * BH)
  for (let k = 0; k < 120; k++) {
    const cx = rnd() * (BW + 40)
    const cy = rnd() * BH
    const r = 4 + rnd() * 30
    const v = 40 + rnd() * 180
    for (let y = Math.max(0, (cy - r) | 0); y < Math.min(BH, cy + r); y++) for (let x = Math.max(0, (cx - r) | 0); x < Math.min(BW + 40, cx + r); x++) if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) scene[y * (BW + 40) + x] = v
  }
  const big = (ox) => {
    const f = Buffer.alloc(BW * BH * 1.5, 128)
    for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) f[y * BW + x] = scene[y * (BW + 40) + x + ox]
    return f
  }
  const L = new Locker({ width: BW, height: BH })
  L.process(big(10))
  const r = L.process(big(15))
  const row = 120 * BW
  let match = 0
  for (let x = 0; x < BW - 10; x++) if (r.frame[row + x] === big(10)[row + x]) match++
  check('a full-quality picture is moved back by whole pixels, onto its background exactly', Math.round(r.dx) === -5 && match === BW - 10, `${r.dx.toFixed(2)}, ${match} of ${BW - 10}`)
}
check('a picture that is not even sized cannot be steadied', (() => { try { new Locker({ width: 353, height: 198 }); return false } catch { return true } })())

// ---- yuv4mpeg -------------------------------------------------------------------------------------------
{
  const got = []
  let head = null
  const r = new Y4mReader({ onHeader: (line, size) => { head = { line, size } }, onFrame: (b) => got.push(Buffer.from(b)) })
  const px = 4 * 2 * 1.5
  const a = Buffer.alloc(px, 7)
  const b = Buffer.alloc(px, 9)
  const all = Buffer.concat([Buffer.from('YUV4MPEG2 W4 H2 F20:1 Ip A1:1 C420jpeg XYSCSS=420JPEG\n'), Buffer.from('FRAME\n'), a, Buffer.from('FRAME\n'), b])
  for (let i = 0; i < all.length; i += 5) r.push(all.subarray(i, i + 5))
  check('yuv4mpeg read in 5-byte pieces: its size and rate from the header', head?.size.width === 4 && head.size.height === 2 && head.size.fps === 20 && head.line.endsWith('XYSCSS=420JPEG'))
  check('... and each picture whole', got.length === 2 && got[0].equals(a) && got[1].equals(b))
  let threw = false
  try { new Y4mReader({ onHeader() {}, onFrame() {} }).push(Buffer.from('YUV4MPEG2 W4 H2 F20:1 C444\n')) } catch { threw = true }
  check('... anything but 4:2:0 is refused', threw)
}

// ---- ffmpeg's arguments ------------------------------------------------------------------------------
{
  const d = decodeArgs({ inCodec: CODEC_H265, maxWidth: 704 })
  check('the decoder: H.265 in, each picture out as it comes, at most 704 wide, yuv4mpeg out', d[d.indexOf('-f') + 1] === 'hevc' && d.includes('low_delay') && d[d.indexOf('-vf') + 1] === 'scale=min(704\\,iw):-2,format=yuv420p' && d.at(-2) === 'yuv4mpegpipe')
  check('... H.264 in when the camera sends it', decodeArgs({ inCodec: CODEC_H264 }).includes('h264'))
  const e = encodeArgs({ crf: 22, preset: 'veryfast', encThreads: 1, maxKbps: 3000, bufSeconds: 2, gop: 40 })
  check('the encoder: libx264 veryfast, one thread, no B-frames, the GOP and rate cap asked for, H.264 out', e.includes('libx264') && e[e.indexOf('-preset') + 1] === 'veryfast' && e[e.indexOf('-threads') + 1] === '1' && e[e.indexOf('-bf') + 1] === '0' && e[e.indexOf('-g') + 1] === '40' && e[e.indexOf('-maxrate') + 1] === '3000k' && e[e.indexOf('-bufsize') + 1] === '6000k' && e.at(-2) === 'h264')
  check('... no deshake anywhere: the lock does the steadying', ![...d, ...e].join(' ').includes('deshake'))
}

// ---- the conversion, with fake ffmpegs -------------------------------------------------------------------
const fakeProc = (args) => {
  const p = new EventEmitter()
  p.args = args
  p.stdin = Object.assign(new EventEmitter(), { written: [], ended: false, write(b) { this.written.push(Buffer.from(b)) }, end() { this.ended = true } })
  p.stdout = new EventEmitter()
  p.stderr = new EventEmitter()
  p.killed = false
  p.kill = () => { p.killed = true }
  p.pid = 0
  return p
}
const SMALL = 'YUV4MPEG2 W16 H16 F20:1 Ip A1:1 C420jpeg'
const tiny = (v) => Buffer.alloc(16 * 16 * 1.5, v)
// an H.264 picture as the encoder would hand it out (a slice starting a new picture)
const au = (key) => Buffer.from([0, 0, 0, 1, key ? 0x65 : 0x41, 0x88, 1, 2])
{
  const procs = []
  const out = []
  const fails = []
  const logs = []
  const x = new LockTranscoder({
    inCodec: CODEC_H265, maxWidth: 704, preset: 'veryfast', encThreads: 1,
    onFrame: (ts, key, buf) => out.push({ ts, key, n: buf.length }), onFail: (e) => fails.push(e.message), log: (l) => logs.push(l),
    spawn: (bin, args) => { const p = fakeProc(args); procs.push(p); return p }, platform: 'win32',
    makeLocker: (size, hooks) => new InlineLocker(size, hooks), setTimer: () => null, clearTimer: () => {}
  })
  x.push(1000, false, Buffer.from([1]))
  check('nothing starts on a delta frame (a decoder needs the keyframe first)', procs.length === 0 && !x.running)
  x.push(1000, true, Buffer.from([0, 0, 0, 1, 0x40]))
  x.endPicture()
  x.push(1050, false, Buffer.from([0, 0, 0, 1, 0x02]))
  check('a keyframe starts the decoder, the frames go into it, each ended (a delimiter after it)', procs.length === 1 && x.running && procs[0].args.includes('yuv4mpegpipe') && procs[0].stdin.written.length === 3 && x.pending === 2)
  const dec = procs[0]
  dec.stdout.emit('data', Buffer.from(`${SMALL}\nFRA`))
  check('the decoder\'s header starts the encoder, handed the same header', procs.length === 2 && procs[1].args.includes('libx264') && procs[1].stdin.written[0].toString() === `${SMALL}\n`)
  dec.stdout.emit('data', Buffer.concat([Buffer.from('ME\n'), tiny(100), Buffer.from('FRAME\n'), tiny(100)]))
  const enc = procs[1]
  const frames = enc.stdin.written.filter((b) => b.length === 16 * 16 * 1.5)
  check('each decoded picture goes to the encoder steadied, behind its FRAME line', frames.length === 2 && enc.stdin.written.filter((b) => b.toString() === 'FRAME\n').length === 2)
  enc.stdout.emit('data', Buffer.concat([au(true), au(false), au(false)]))
  check('the encoder\'s pictures are handed back with the times of the frames that went in, in order', out.length === 2 && out[0].ts === 1000 && out[0].key && out[1].ts === 1050 && !out[1].key && x.pending === 0)
  x.reset()
  check('reset: both ffmpegs killed, nothing in flight', dec.killed && enc.killed && !x.running && x.pending === 0)
  x.push(2000, true, Buffer.from([0, 0, 0, 1, 0x40]))
  check('... the next keyframe starts afresh', procs.length === 3 && x.running)
  procs[2].emit('close', 1)
  check('a decoder that ends before any picture came out: the conversion failed', fails.length === 1 && /decoder ffmpeg exited with 1/.test(fails[0]) && !x.running)
  x.close()
  x.push(3000, true, Buffer.from([1]))
  check('closed: never starts again', procs.length === 3)
}
{
  // the background taken again is said, once a minute
  const logs = []
  let now = 0
  const x = new LockTranscoder({ onFrame() {}, log: (l) => logs.push(l), spawn: (b, a) => fakeProc(a), platform: 'win32', now: () => now,
    makeLocker: (size, hooks) => ({ process: (b, done) => { hooks.onReset('picture'); done(Buffer.from(b)) }, close() {} }), setTimer: () => null, clearTimer: () => {} })
  x.push(0, true, Buffer.from([1]))
  const dec = x.dec
  dec.stdout.emit('data', Buffer.concat([Buffer.from(`${SMALL}\n`), Buffer.from('FRAME\n'), tiny(1), Buffer.from('FRAME\n'), tiny(1)]))
  now = RESET_SAY_MS + 1
  dec.stdout.emit('data', Buffer.concat([Buffer.from('FRAME\n'), tiny(1)]))
  check('"the background was taken again" is said once a minute, with how many so far', logs.filter((l) => /background was taken again/.test(l)).length === 2 && /3 so far/.test(logs.at(-1)) && x.resets === 3)
  x.close()
}

if (failures) {
  console.log(`\n${failures} FAILED`)
  process.exitCode = 1
} else console.log('\nall passed')
