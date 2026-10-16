// "Steady picture" by locking every picture to the camera's own background (steady.mjs uses it).
//
// Why not ffmpeg's deshake (what steady.mjs used first): it follows the camera's movement, smoothing a
// path, instead of cancelling it. Measured on g-port/3 (Main Gate StreetV, the camera Mike asked for)
// with an artificial wind sway of up to ~20 px at 704 wide: deshake left 6.9 px of the 8.8 px typical
// sway; on a calm stretch it added jumps of up to 6.8 px where the camera moved 1.1. A fixed camera
// should stay where its background is, so each picture is measured against a slowly refreshed picture
// of that background (phase correlation) and moved back onto it: 0.09 px typical left on the same clip.
//
// Moving a picture back leaves a strip at its edge with nothing in it. Filled by repeating the edge row
// it smeared ("fuzzy around the edges"); here it keeps what the last picture showed there (the camera
// swinging the other way saw it), so the edge stays sharp and is at most a moment old.
//
// The pipeline, one per steadied camera: ffmpeg decodes the camera's stream to raw pictures, scaled to
// at most STEADY_WIDTH (yuv4mpeg on its stdout); Locker steadies each; a second ffmpeg encodes them to
// H.264. LockTranscoder has Transcoder's shape (push, endPicture, pending, reset, close, onFrame,
// onFail) so PhoneStream drives it as it drives any conversion.
//
// What it costs: two ffmpegs (decode + scale, encode: about what the plain 704-wide conversion cost,
// 16 % of a core) plus the measuring and moving here, a few ms a picture.
//
// The measuring and moving run in a worker thread per camera (steady-lock-worker.mjs): 22 ms a picture
// on an old i7-3770, which on the main thread would hold up every other socket the server serves.
//
// Pure apart from the spawns and the worker, which are injected: tested on any machine
// (test/steady-lock.test.mjs).
import { spawn as nodeSpawn } from 'node:child_process'
import { setPriority } from 'node:os'
import { Worker } from 'node:worker_threads'
import { CODEC_H265, CRF, FLUSH_IDLE_MS, GOP_FRAMES, NICE, PRESET, PRESETS, niceWrap, splitAccessUnits } from './transcode.mjs'

/** The picture each camera is measured on: a power of two each way for the FFT. */
export const MEASURE_W = 256
export const MEASURE_H = 128
/** The top of the picture left out of the measurement: the camera's own clock moves with nothing. */
export const OSD_SHARE = 0.08
/** How sure the measurement must be (the correlation peak's share, 0..1) to move the picture by it. */
export const UNSURE = 0.05
/** A move bigger than this share of the width is not the wind: the picture is left where it was. */
export const MAX_SHIFT_SHARE = 0.09
/** How fast the background picture follows the steadied one (light through the day). */
export const REF_RATE = 0.02
/** ...refreshed (and its FFT taken again) every this many pictures. */
export const REF_EVERY = 4
/** A jump this big in mean brightness (0-255) is a new picture: lights, the camera's own exposure. */
export const BRIGHT_JUMP = 25
/** ...or in colour (mean distance from grey, 0-255): the camera switching to infrared and back. */
export const COLOUR_JUMP = 10
/**
 * A picture at least this wide is moved by whole pixels, a row at a time (a memory copy), not between
 * pixels: at 1920 wide moving each pixel took longer than a camera's picture lasts (g-port/3's main
 * stream, 2026-10-16), and a pixel there is a fifth of one at 704, finer than the sub-stream's lock.
 */
export const WHOLE_PIXEL_WIDTH = 1000
/** Unsure for this long (a new view, a covered lens): the background is taken again from the picture. */
export const UNSURE_RESET_S = 2

// ---- FFT ---------------------------------------------------------------------------------------------

/** In-place radix-2 FFT of n complex numbers (re, im), stride 1 from `off`. inverse: unscaled. */
function fft1(re, im, off, n, inverse, cosT, sinT) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[off + i]; re[off + i] = re[off + j]; re[off + j] = t
      t = im[off + i]; im[off + i] = im[off + j]; im[off + j] = t
    }
  }
  const sgn = inverse ? 1 : -1
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const step = n / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cosT[k * step]
        const wi = sgn * sinT[k * step]
        const a = off + i + k
        const b = a + half
        const xr = re[b] * wr - im[b] * wi
        const xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr; im[b] = im[a] - xi
        re[a] += xr; im[a] += xi
      }
    }
  }
}

const tables = (n) => {
  const c = new Float64Array(n / 2)
  const s = new Float64Array(n / 2)
  for (let k = 0; k < n / 2; k++) {
    c[k] = Math.cos((2 * Math.PI * k) / n)
    s[k] = Math.sin((2 * Math.PI * k) / n)
  }
  return [c, s]
}

/** 2-D FFT of a w x h grid (row-major), in place. */
export function fft2(re, im, w, h, inverse = false, t = { row: tables(w), col: tables(h) }) {
  for (let y = 0; y < h; y++) fft1(re, im, y * w, w, inverse, t.row[0], t.row[1])
  const cr = new Float64Array(h)
  const ci = new Float64Array(h)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) { cr[y] = re[y * w + x]; ci[y] = im[y * w + x] }
    fft1(cr, ci, 0, h, inverse, t.col[0], t.col[1])
    for (let y = 0; y < h; y++) { re[y * w + x] = cr[y]; im[y * w + x] = ci[y] }
  }
}

// ---- the lock ----------------------------------------------------------------------------------------

/**
 * Steadies one camera's pictures (yuv420p, width x height): each is measured against the background
 * and moved back onto it, its empty edge kept from the picture before.
 */
export class Locker {
  /** @param {{ width: number, height: number, fps?: number }} o */
  constructor({ width, height, fps = 20 }) {
    if (!(width >= 16 && height >= 16) || width % 2 || height % 2) throw new Error(`a picture of ${width}x${height} cannot be steadied`)
    Object.assign(this, { width, height })
    this.top = Math.round(height * OSD_SHARE)
    this.unsureLimit = Math.max(1, Math.round(UNSURE_RESET_S * (fps > 0 ? fps : 20)))
    const W = MEASURE_W
    const H = MEASURE_H
    this.t = { row: tables(W), col: tables(H) }
    this.win = new Float64Array(W * H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) this.win[y * W + x] = (0.5 - 0.5 * Math.cos((2 * Math.PI * x) / (W - 1))) * (0.5 - 0.5 * Math.cos((2 * Math.PI * y) / (H - 1)))
    }
    // which source columns / rows each measuring cell averages
    this.xs = Array.from({ length: W + 1 }, (_, i) => Math.round((i * width) / W))
    this.ys = Array.from({ length: H + 1 }, (_, i) => this.top + Math.round((i * (height - this.top)) / H))
    this.scaleX = width / W
    this.scaleY = (height - this.top) / H
    this.ref = null // the background, as measured (MEASURE_W x MEASURE_H)
    this.refRe = new Float64Array(W * H)
    this.refIm = new Float64Array(W * H)
    this.canvas = null // the last picture out (its edge fills the next one's)
    this.dx = 0
    this.dy = 0
    this.n = 0
    this.unsure = 0
    this.last = null // { bright, colour } of the picture before
    this.resets = 0
  }

  /** The luma of a picture, averaged down to the measuring grid. */
  #small(y) {
    const W = MEASURE_W
    const H = MEASURE_H
    const out = new Float64Array(W * H)
    const w = this.width
    for (let j = 0; j < H; j++) {
      const y0 = this.ys[j]
      const y1 = Math.max(y0 + 1, this.ys[j + 1])
      for (let i = 0; i < W; i++) {
        const x0 = this.xs[i]
        const x1 = Math.max(x0 + 1, this.xs[i + 1])
        let s = 0
        for (let yy = y0; yy < y1; yy++) {
          const row = yy * w
          for (let xx = x0; xx < x1; xx++) s += y[row + xx]
        }
        out[j * W + i] = s / ((y1 - y0) * (x1 - x0))
      }
    }
    return out
  }

  /** The background's spectrum: taken again when the background has moved on. */
  #refSpectrum() {
    const N = MEASURE_W * MEASURE_H
    let mean = 0
    for (let i = 0; i < N; i++) mean += this.ref[i]
    mean /= N
    for (let i = 0; i < N; i++) { this.refRe[i] = (this.ref[i] - mean) * this.win[i]; this.refIm[i] = 0 }
    fft2(this.refRe, this.refIm, MEASURE_W, MEASURE_H, false, this.t)
  }

  /**
   * Where this picture's background is, against the background picture: { dx, dy } in measuring cells
   * (the picture's content moved by that much) and how sure (the peak's share, 0..1).
   */
  measure(small) {
    const W = MEASURE_W
    const H = MEASURE_H
    const N = W * H
    let mean = 0
    for (let i = 0; i < N; i++) mean += small[i]
    mean /= N
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    for (let i = 0; i < N; i++) re[i] = (small[i] - mean) * this.win[i]
    fft2(re, im, W, H, false, this.t)
    // cross-power spectrum, normalised: its inverse is a single peak where the picture moved to
    for (let i = 0; i < N; i++) {
      const ar = re[i]; const ai = im[i]
      const br = this.refRe[i]; const bi = this.refIm[i]
      // picture times the background's conjugate
      const cr = ar * br + ai * bi
      const ci = ai * br - ar * bi
      const m = Math.sqrt(cr * cr + ci * ci) || 1
      re[i] = cr / m
      im[i] = ci / m
    }
    fft2(re, im, W, H, true, this.t)
    let best = 0
    for (let i = 1; i < N; i++) if (re[i] > re[best]) best = i
    const px = best % W
    const py = (best - px) / W
    const at = (x, y) => re[((y + H) % H) * W + ((x + W) % W)] / N
    let sure = 0
    for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) sure += Math.max(0, at(px + xx, py + yy))
    // the peak's top, between cells: a shift between two cells splits the peak between them, in the
    // ratio of how near it is to each (Foroosh, Zerubia and Berthod 2002)
    const sub = (l, c, r) => {
      if (!(c > 0)) return 0
      if (r >= l && r > 0) return r / (r + c)
      if (l > 0) return -l / (l + c)
      return 0
    }
    let dx = px + sub(at(px - 1, py), at(px, py), at(px + 1, py))
    let dy = py + sub(at(px, py - 1), at(px, py), at(px, py + 1))
    if (dx > W / 2) dx -= W
    if (dy > H / 2) dy -= H
    return { dx, dy, sure }
  }

  /** Mean brightness and colour (distance from grey) of a picture, on a sparse sample. */
  #looks(y, u, v) {
    let b = 0
    let nb = 0
    for (let i = 0; i < y.length; i += 97) { b += y[i]; nb++ }
    let c = 0
    let nc = 0
    for (let i = 0; i < u.length; i += 31) { c += Math.abs(u[i] - 128) + Math.abs(v[i] - 128); nc++ }
    return { bright: b / nb, colour: c / nc }
  }

  #restart(small, frame) {
    this.ref = small
    this.#refSpectrum()
    this.canvas = Buffer.from(frame)
    this.dx = 0
    this.dy = 0
    this.unsure = 0
  }

  /**
   * Steadies one picture (yuv420p, width x height x 1.5 bytes).
   * @returns {{ frame: Buffer, dx: number, dy: number, sure: number, moved: boolean, reset: boolean }}
   *   frame: the picture out (the same buffer every time: copy it to keep it); dx/dy: how far it was
   *   moved back, in pixels
   */
  process(frame) {
    const w = this.width
    const h = this.height
    const ySize = w * h
    const cSize = ySize / 4
    if (frame.length < ySize + 2 * cSize) throw new Error(`a picture of ${frame.length} bytes, not ${ySize + 2 * cSize}`)
    const Y = frame.subarray(0, ySize)
    const U = frame.subarray(ySize, ySize + cSize)
    const V = frame.subarray(ySize + cSize, ySize + 2 * cSize)
    const small = this.#small(Y)
    const looks = this.#looks(Y, U, V)
    const changed = this.last && (Math.abs(looks.bright - this.last.bright) > BRIGHT_JUMP || Math.abs(looks.colour - this.last.colour) > COLOUR_JUMP)
    this.last = looks
    this.n++
    if (!this.ref || changed) {
      if (this.ref) this.resets++
      this.#restart(small, frame)
      return { frame: this.canvas, dx: 0, dy: 0, sure: 1, moved: false, reset: Boolean(changed) }
    }
    const m = this.measure(small)
    const dx = m.dx * this.scaleX
    const dy = m.dy * this.scaleY
    const limit = MAX_SHIFT_SHARE * w
    const sure = m.sure >= UNSURE && Math.abs(dx) <= limit && Math.abs(dy) <= limit
    if (sure) {
      this.dx = dx
      this.dy = dy
      this.unsure = 0
    } else if (++this.unsure >= this.unsureLimit) {
      // unsure for long: the view is not the background any more (moved, covered): taken again
      this.resets++
      this.#restart(small, frame)
      return { frame: this.canvas, dx: 0, dy: 0, sure: m.sure, moved: false, reset: true }
    }
    // (unsure for a moment: a lorry across the view; moved as the picture before was)
    this.#shift(Y, w, h, this.dx, this.dy, 0)
    this.#shift(U, w / 2, h / 2, this.dx / 2, this.dy / 2, ySize)
    this.#shift(V, w / 2, h / 2, this.dx / 2, this.dy / 2, ySize + cSize)
    if (this.n % REF_EVERY === 0) {
      const out = this.#small(this.canvas.subarray(0, ySize))
      for (let i = 0; i < out.length; i++) this.ref[i] += REF_RATE * REF_EVERY * (out[i] - this.ref[i])
      this.#refSpectrum()
    }
    return { frame: this.canvas, dx: this.dx, dy: this.dy, sure: m.sure, moved: true, reset: false }
  }

  /**
   * One plane moved back by (dx, dy) into the canvas at `at`: each pixel out is read from (x + dx, y + dy)
   * of the picture, between pixels; where that is off the picture the canvas keeps what it had.
   */
  #shift(src, w, h, dx, dy, at) {
    const out = this.canvas
    if (this.width >= WHOLE_PIXEL_WIDTH) {
      const ix = Math.round(dx)
      const iy = Math.round(dy)
      const x0 = Math.max(0, -ix)
      const x1 = Math.min(w, w - ix)
      for (let y = Math.max(0, -iy); y < Math.min(h, h - iy); y++) {
        const s = (y + iy) * w + ix
        src.copy(out, at + y * w + x0, s + x0, s + x1)
      }
      return
    }
    const ix = Math.floor(dx)
    const iy = Math.floor(dy)
    const fx = dx - ix
    const fy = dy - iy
    const w00 = (1 - fx) * (1 - fy)
    const w10 = fx * (1 - fy)
    const w01 = (1 - fx) * fy
    const w11 = fx * fy
    // the rows and columns whose source (and the one after it) is on the picture
    const x0 = Math.max(0, -ix)
    const x1 = Math.min(w, w - 1 - ix)
    const y0 = Math.max(0, -iy)
    const y1 = Math.min(h, h - 1 - iy)
    for (let y = y0; y < y1; y++) {
      const s0 = (y + iy) * w + ix
      const s1 = s0 + w
      const o = at + y * w
      for (let x = x0; x < x1; x++) {
        out[o + x] = w00 * src[s0 + x] + w10 * src[s0 + x + 1] + w01 * src[s1 + x] + w11 * src[s1 + x + 1] + 0.5
      }
    }
  }
}

// ---- yuv4mpeg ----------------------------------------------------------------------------------------

/**
 * Reads ffmpeg's yuv4mpeg output: one header line ("YUV4MPEG2 W704 H396 F20:1 ..."), then each picture
 * as "FRAME\n" and its bytes. onHeader(header line, { width, height, fps }) once, onFrame(bytes) each.
 */
export class Y4mReader {
  constructor({ onHeader, onFrame }) {
    Object.assign(this, { onHeader, onFrame })
    this.buf = Buffer.alloc(0)
    this.chunks = [] // pieces not joined yet, and how many bytes they hold
    this.held = 0
    this.header = null
    this.size = 0
  }

  push(chunk) {
    // Joined only once a whole picture is in: ffmpeg writes 64 KB at a time, and joining each piece
    // to what came before copied a 1920x1080 picture (3 MB) about 47 times over, 1.4 GB a second on
    // the main thread at 20 a second: full quality steadied fell behind the camera (2026-10-16).
    this.chunks.push(chunk)
    this.held += chunk.length
    if (this.header && this.buf.length + this.held < this.size + 6) return
    this.buf = Buffer.concat([this.buf, ...this.chunks])
    this.chunks = []
    this.held = 0
    for (;;) {
      const nl = this.buf.indexOf(10)
      if (!this.header) {
        if (nl < 0) return
        const line = this.buf.subarray(0, nl).toString('latin1')
        if (!line.startsWith('YUV4MPEG2 ')) throw new Error(`not yuv4mpeg: ${line.slice(0, 40)}`)
        const tag = (c) => line.split(' ').find((t) => t[0] === c)?.slice(1)
        const width = Number(tag('W'))
        const height = Number(tag('H'))
        const [a, b] = String(tag('F') ?? '').split(':').map(Number)
        const colour = tag('C') ?? '420jpeg'
        if (!colour.startsWith('420')) throw new Error(`yuv4mpeg colour ${colour}, not 4:2:0`)
        this.header = line
        this.size = width * height * 1.5
        this.buf = this.buf.subarray(nl + 1)
        this.onHeader(line, { width, height, fps: a > 0 && b > 0 ? a / b : 0 })
        continue
      }
      if (nl < 0) return
      const end = nl + 1 + this.size
      if (this.buf.length < end) return
      this.onFrame(this.buf.subarray(nl + 1, end))
      this.buf = this.buf.subarray(end)
    }
  }
}

// ---- the conversion ----------------------------------------------------------------------------------

/** The decoder: the camera's stream to raw pictures at most maxWidth wide, each out as it is decoded. */
export function decodeArgs({ inCodec = CODEC_H265, maxWidth = 704 } = {}) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
    '-f', inCodec === CODEC_H265 ? 'hevc' : 'h264', '-i', 'pipe:0', '-an',
    '-vf', `scale=min(${maxWidth}\\,iw):-2,format=yuv420p`,
    '-fps_mode', 'passthrough', '-flush_packets', '1', '-f', 'yuv4mpegpipe', 'pipe:1'
  ]
}

/** The encoder: steadied raw pictures to H.264, as every other live conversion makes it. */
export function encodeArgs({ crf = CRF, maxKbps = 0, bufSeconds = 4, gop = GOP_FRAMES, preset = PRESET, encThreads = 0 } = {}) {
  const g = String(Number.isInteger(gop) && gop > 0 ? gop : GOP_FRAMES)
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'yuv4mpegpipe', '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', PRESETS.includes(preset) ? preset : PRESET, ...(Number.isInteger(encThreads) && encThreads > 0 ? ['-threads', String(encThreads)] : []),
    '-crf', String(crf), '-tune', 'zerolatency', '-bf', '0', '-g', g, '-pix_fmt', 'yuv420p',
    ...(maxKbps > 0 ? ['-maxrate', `${maxKbps}k`, '-bufsize', `${Math.round(maxKbps * bufSeconds)}k`] : []),
    '-fps_mode', 'passthrough', '-flush_packets', '1', '-f', 'h264', 'pipe:1'
  ]
}

/**
 * A Locker in its own worker thread. process(bytes, done): the picture is copied over, and done(frame)
 * is called with the steadied one, in the order they went in (done(null) if the worker failed).
 * onReset(why) when the background was taken again ('picture' changed / 'unsure' too long).
 */
export class WorkerLocker {
  constructor(size, { onReset = () => {}, onError = () => {} } = {}) {
    this.queue = []
    this.worker = new Worker(new URL('./steady-lock-worker.mjs', import.meta.url), { workerData: size })
    this.worker.on('message', (m) => {
      if (m?.reset) onReset(m.reset)
      const done = this.queue.shift()
      done?.(m?.frame ? Buffer.from(m.frame.buffer, m.frame.byteOffset, m.frame.byteLength) : null)
    })
    this.worker.on('error', (e) => {
      for (const done of this.queue.splice(0)) done(null)
      onError(e)
    })
  }

  process(bytes, done) {
    const copy = new Uint8Array(bytes)
    this.queue.push(done)
    this.worker.postMessage(copy, [copy.buffer])
  }

  close() {
    this.queue = []
    this.worker.terminate().catch(() => {})
  }
}

/** The same, on this thread (tests). */
export class InlineLocker {
  constructor(size, { onReset = () => {} } = {}) {
    this.locker = new Locker(size)
    this.onReset = onReset
  }

  process(bytes, done) {
    const r = this.locker.process(bytes)
    if (r.reset) this.onReset(r.sure < UNSURE ? 'unsure' : 'picture')
    done(Buffer.from(r.frame))
  }

  close() {}
}

/** "The background was taken again" is said at most once in this long per camera. */
export const RESET_SAY_MS = 60_000

const AUD_H265 = Buffer.from([0, 0, 0, 1, 0x46, 0x01, 0x50])
const AUD_H264 = Buffer.from([0, 0, 0, 1, 0x09, 0xf0])

/**
 * One camera's steadied conversion: decoder ffmpeg -> Locker -> encoder ffmpeg. Transcoder's shape, so
 * PhoneStream drives it the same way; the times of the pictures pushed in are handed back in order to
 * the pictures that come out (the cameras send no B-frames, and -bf 0 out).
 */
export class LockTranscoder {
  /**
   * @param {{ inCodec?: number, maxWidth?: number, crf?: number, maxKbps?: number, bufSeconds?: number, gop?: number,
   *   preset?: string, encThreads?: number, onFrame: (tsMs: number, isKey: boolean, buf: Buffer) => void,
   *   onFail?: (err: Error) => void, log?: (line: string) => void, spawn?: Function, platform?: string,
   *   hasNice?: boolean, hasIonice?: boolean, setPriority?: Function, setTimer?: Function, clearTimer?: Function,
   *   flushIdleMs?: number, makeLocker?: (size: object, hooks: object) => WorkerLocker|InlineLocker, now?: () => number }} o
   *   (keepEvery, lowDelay and the rest of Transcoder's options are taken and ignored: every picture is
   *   kept, and the decoder always hands each out as it comes)
   */
  constructor({
    inCodec = CODEC_H265, maxWidth = 704, crf = CRF, maxKbps = 0, bufSeconds = 4, gop = GOP_FRAMES, preset = PRESET, encThreads = 0,
    onFrame, onFail = () => {}, log = (line) => console.log(line), spawn = nodeSpawn, platform = process.platform,
    hasNice = platform === 'linux', hasIonice = platform === 'linux', setPriority: prio = setPriority,
    setTimer = setTimeout, clearTimer = clearTimeout, flushIdleMs = FLUSH_IDLE_MS, makeLocker = (size, hooks) => new WorkerLocker(size, hooks), now = Date.now
  } = {}) {
    Object.assign(this, { inCodec, maxWidth: maxWidth > 0 ? maxWidth : 704, crf, maxKbps, bufSeconds, gop, preset, encThreads, onFrame, onFail, log, spawn, platform, hasNice, hasIonice, prio, setTimer, clearTimer, flushIdleMs, makeLocker, now })
    this.encoder = 'libx264'
    this.locker = null
    this.resets = 0
    this.resetSaidAt = -Infinity
    this.dec = null
    this.enc = null
    this.closed = false
    this.times = []
    this.buf = Buffer.alloc(0)
    this.out = 0
    this.idle = null
    this.stderr = ''
  }

  get running() {
    return Boolean(this.dec)
  }

  /** Pictures pushed in and not out yet: how far behind it runs (PhoneStream's maxLagS). */
  get pending() {
    return this.times.length
  }

  #spawn(args) {
    const { bin, args: full } = niceWrap('ffmpeg', args, { platform: this.platform, hasNice: this.hasNice, hasIonice: this.hasIonice })
    const p = this.spawn(bin, full, { stdio: ['pipe', 'pipe', 'pipe'] })
    if (!this.hasNice && p.pid) {
      try {
        this.prio(p.pid, NICE)
      } catch {}
    }
    p.stdin?.on('error', () => {})
    p.stderr?.on('data', (c) => {
      this.stderr = (this.stderr + String(c)).slice(-500)
    })
    return p
  }

  #start() {
    const dec = this.#spawn(decodeArgs({ inCodec: this.inCodec, maxWidth: this.maxWidth }))
    this.dec = dec
    this.enc = null
    this.out = 0
    this.buf = Buffer.alloc(0)
    this.times = []
    this.stderr = ''
    const reader = new Y4mReader({
      onHeader: (line, size) => {
        try {
          this.locker = this.makeLocker(size, {
            onReset: (why) => this.#reset(why),
            onError: (e) => this.#ended(dec, null, e)
          })
        } catch (e) {
          return this.#ended(dec, null, e)
        }
        const enc = this.#spawn(encodeArgs({ crf: this.crf, maxKbps: this.maxKbps, bufSeconds: this.bufSeconds, gop: this.gop, preset: this.preset, encThreads: this.encThreads }))
        this.enc = enc
        enc.stdout?.on('data', (c) => this.#onData(dec, c))
        enc.on('error', (e) => this.#ended(dec, null, e))
        enc.on('close', (code) => this.#ended(dec, code, null, 'encoder'))
        try {
          enc.stdin.write(`${line}\n`)
        } catch {}
      },
      onFrame: (bytes) => {
        if (dec !== this.dec || !this.locker || !this.enc) return
        this.locker.process(bytes, (frame) => {
          if (dec !== this.dec || !this.enc) return
          if (!frame) return this.#ended(dec, null, new Error('the steadying thread failed'))
          try {
            this.enc.stdin.write('FRAME\n')
            this.enc.stdin.write(frame)
          } catch {}
        })
      }
    })
    dec.stdout?.on('data', (c) => {
      if (dec !== this.dec || this.closed) return
      try {
        reader.push(c)
      } catch (e) {
        this.#ended(dec, null, e)
      }
    })
    dec.on('error', (e) => this.#ended(dec, null, e))
    dec.on('close', (code) => this.#ended(dec, code, null, 'decoder'))
  }

  push(tsMs, isKey, buf) {
    if (this.closed) return
    if (!this.dec) {
      if (!isKey) return
      this.#start()
    }
    try {
      this.dec.stdin.write(buf)
    } catch {}
    const t = this.times
    let i = t.length
    while (i > 0 && t[i - 1] > tsMs) i--
    t.splice(i, 0, tsMs)
  }

  /** Ends the picture just pushed (an access unit delimiter: the parser lets it go at once). */
  endPicture() {
    if (this.closed || !this.dec) return
    try {
      this.dec.stdin.write(this.inCodec === CODEC_H265 ? AUD_H265 : AUD_H264)
    } catch {}
  }

  #onData(dec, chunk) {
    if (dec !== this.dec || this.closed) return
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk)
    this.#drain(false)
    this.clearTimer(this.idle)
    this.idle = this.setTimer(() => {
      if (dec === this.dec && !this.closed) this.#drain(true)
    }, this.flushIdleMs)
    this.idle?.unref?.()
  }

  #drain(flush) {
    const { units, rest } = splitAccessUnits(this.buf, { flush })
    this.buf = rest
    for (const u of units) {
      const ts = this.times.shift()
      if (ts === undefined) continue
      this.out++
      this.onFrame(ts, u.isKey, u.buf)
    }
  }

  /** Either ffmpeg ended (or a picture could not be read): both go; the next keyframe starts afresh. */
  #ended(dec, code, err, which = 'conversion') {
    if (dec !== this.dec) return
    const out = this.out
    const why = err ? err.message : `the ${which} ffmpeg exited with ${code}${this.stderr ? `: ${this.stderr.trim()}` : ''}`
    this.reset()
    if (this.closed) return
    if (out === 0) return this.onFail(new Error(why))
    this.log(`[transcode] steadied conversion ended after ${out} frames (${why})`)
  }

  /** The background taken again (dusk, lights, a covered view): counted, said once a minute. */
  #reset(why) {
    this.resets++
    const t = this.now()
    if (t - this.resetSaidAt < RESET_SAY_MS) return
    this.resetSaidAt = t
    this.log(`[steady] the background was taken again (${why === 'unsure' ? 'the view could not be matched for a while' : 'the picture changed: lights, or day/night'}; ${this.resets} so far, said once a minute)`)
  }

  reset() {
    const procs = [this.dec, this.enc]
    this.locker?.close()
    this.locker = null
    this.dec = null
    this.enc = null
    this.clearTimer(this.idle)
    this.idle = null
    this.times = []
    this.buf = Buffer.alloc(0)
    for (const p of procs) {
      if (!p) continue
      try {
        p.stdin?.end()
      } catch {}
      try {
        p.kill('SIGKILL')
      } catch {}
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.reset()
  }
}
