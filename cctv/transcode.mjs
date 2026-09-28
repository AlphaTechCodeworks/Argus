// Server-side H.265 -> H.264 conversion for playback, so a browser with no H.265 decoder can still
// watch the server's own recordings (rec-playback.mjs uses this; nothing here imports the SDK, so
// all of it runs and is tested on any machine: test/transcode.test.mjs).
//
// Why this exists: the recordings are H.265. Chrome and Edge on Windows have no H.265 decoder
// unless somebody installs the "HEVC Video Extensions" from the Microsoft Store, so a brand-new
// laptop with a good GPU fails exactly like an old one. Now the system is reachable from outside it
// will be opened on machines nobody controls, and "install a codec first" is not an answer. So when
// the page says it cannot decode H.265 (&h265=0 on the playback socket) the segments are pushed
// through ffmpeg and the browser is sent H.264 in the very same wire format, with the very same
// timestamps: the player needs no new code path at all.
//
// The quality trade, plainly: this is evidence, not a master copy. The picture is re-encoded with
// crf 26 / veryfast, which throws away detail in the noisy, moving parts of the picture that a second
// encode cannot afford, and playback converts at most 1920 wide (PLAYBACK_LIMITS): a 4K camera is
// watched at 1080p. It is visibly softer than the original on a big screen and it is generated fresh
// every time; the original H.265 file on disk is never touched, and an export still gets the real
// footage at full size. Speed matters more than the last few percent of quality here, because the
// conversion has to keep ahead of playback on a box whose first job is recording.
//
// What protects recording: a hard cap on how many conversions run at once (CCTV_TRANSCODE_MAX,
// 2 by default), nice/ionice so ffmpeg loses every contest against the recorder and exports, and a
// kill the moment the viewer closes the tab, seeks, or anything fails. An ffmpeg left running after
// a viewer has gone is a bug, not a tidiness problem: it would quietly eat the cores that record.
import { spawn as nodeSpawn } from 'node:child_process'
import { setPriority } from 'node:os'

/** Wire codec numbers (sdk.mjs CODEC_H264 / CODEC_H265, repeated here so this module stays SDK-free). */
export const CODEC_H264 = 0
export const CODEC_H265 = 1

/** Concurrent conversions allowed before viewers are turned away (a setting: CCTV_TRANSCODE_MAX). */
export const DEFAULT_MAX = 2
/** The encoder's quality knob. See the note at the top for what is being traded away. */
export const CRF = 26
export const PRESET = 'veryfast'
/** ffmpeg's stdout is flushed per packet, so a gap this long means the last frame is complete. */
export const FLUSH_IDLE_MS = 150
/** Where hardware encoding lives on this box; no such file means software only. */
export const RENDER_NODE = '/dev/dri/renderD128'
/** Every conversion runs at this much lower CPU and at idle disk priority: recording always wins. */
export const NICE = 10
/**
 * The size and rate a playback conversion (rec-playback.mjs) is held to. Measured on this server with
 * two 4K H.265 recordings (20 fps, 2.9 and 3.6 Mbit/s): converted at full size, ffmpeg made 16.9-18.8
 * pictures a second (0.85-0.94x real time: fed at 1x, the lag grew to 4 s in 30 s) and made 9.3-10
 * Mbit/s with 1.5 MB keyframes, more than one tunnel connection carries (3.5-6.5 Mbit/s). At most 1920
 * wide and 2500 kbit/s: 23-25 a second (1.16-1.26x), 2.2-2.5 Mbit/s, the lag at 1x under 0.5 s.
 * The buffer is 1 s at the cap, not the 4 s phones get, because the keyframe burst is what stalls a
 * viewer on a thin link: keyframes came out at 100-150 KB (a quarter of a second through the tunnel)
 * against 430-550 KB with 4 s. The price is sharpness, since the keyframe is what a still scene's
 * other pictures are built on: SSIM against the recording scaled to 1080p was 0.984 with 1 s, 0.987
 * with 2 s and 0.990 with 4 s, at the same 2.1-2.2 Mbit/s.
 */
export const PLAYBACK_LIMITS = Object.freeze({ maxWidth: 1920, maxKbps: 2500, bufSeconds: 1 })
/**
 * Decoder threads for a conversion that plays forward (lowDelay false, ffmpegArgs). Frame threads
 * decode the next picture while ffmpeg scales and encodes this one; each thread past the first holds
 * one picture back until more arrive. Measured on two 4K recordings (20 fps) within PLAYBACK_LIMITS:
 * one thread (low_delay) 23.7-24.6 pictures a second (1.19-1.23x real time), two 43.0-46.4 (2.15-2.32x),
 * ffmpeg's own choice (nine threads on this server) 47.9-50.3. Two gets almost all of it, holds back
 * one picture instead of eight, and leaves the cores to the recorder. (None of the 45 H.265 cameras
 * here uses wavefronts. A stream that did would decode on many threads even with low_delay, and two
 * would be slower for it.)
 */
export const DECODE_THREADS = 2

/** The cap, from the environment; a bad or missing value means the default. */
export function maxTranscodes(env = process.env) {
  const n = Number(env.CCTV_TRANSCODE_MAX)
  return Number.isInteger(n) && n >= 0 && n <= 16 ? n : DEFAULT_MAX
}

/**
 * Whether this frame must be converted before it is sent. Deliberately strict: the only reason to
 * convert is that the client said it cannot decode H.265, so a client that never asked can never be
 * sent anything but what was recorded.
 * @param {{ clientH265: boolean, codec: number }} o clientH265: the browser can decode H.265
 */
export function wantsTranscode({ clientH265, codec }) {
  return clientH265 === false && codec === CODEC_H265
}

/**
 * The client's answer to canDecodeH265(), from the playback URL (&h265=0/1). Anything else, including
 * the parameter missing, counts as "can decode": an old page that does not send it keeps today's
 * behaviour, and no conversion happens by accident.
 */
export function clientCanDecodeH265(params) {
  return params?.get?.('h265') !== '0'
}

/** How many conversions may run at once; a slot is held for as long as one viewer is being served. */
export class TranscodePool {
  constructor(max = DEFAULT_MAX) {
    this.max = Number.isInteger(max) && max >= 0 ? max : DEFAULT_MAX
    this.active = 0
  }

  /**
   * A slot, or null when the cap is reached. Null is not a queue: the viewer is told plainly that
   * the server is busy, because a queue for something this expensive only ever turns into a page
   * that waits for ever.
   * @returns {{ release: () => void }|null}
   */
  acquire() {
    if (this.active >= this.max) return null
    this.active++
    let done = false
    return {
      release: () => {
        if (done) return
        done = true
        this.active--
      }
    }
  }
}

/** The process-wide cap (one pool for the whole server: the cores are shared, not per camera). */
export const pool = new TranscodePool(maxTranscodes())
/**
 * Sub-stream (SD) conversions: a camera grid played back from the NVR on a laptop without HEVC. An
 * SD picture costs a fraction of a full-size one to convert, and a grid needs one per tile, so these
 * have their own, larger cap (CCTV_TRANSCODE_SD_MAX, 12 by default).
 */
export const lightPool = new TranscodePool((() => { const n = Number(process.env.CCTV_TRANSCODE_SD_MAX); return Number.isInteger(n) && n >= 0 && n <= 64 ? n : 12 })())

// ---- ffmpeg arguments -------------------------------------------------------------------------

/**
 * ffmpeg's arguments for one conversion: Annex B in on stdin, Annex B H.264 out on stdout.
 * No container either way, so nothing has to be demuxed or muxed and there is no latency but the
 * encoder's own. -bf 0 keeps the output in input order (see Transcoder for why that matters), and
 * -g 50 puts a keyframe in often enough that a decoder joining late recovers quickly.
 * keepEvery / maxWidth (phones, phone-live.mjs; maxWidth for playback too, PLAYBACK_LIMITS): keep one
 * frame in every keepEvery, and scale down to at most maxWidth wide. Software only: the GPU path would
 * need its own filters, and this server has no GPU encoder (its GPU is the VM's virtual one).
 * Never -fflags nobuffer: with it the packet ffmpeg reads while it probes the stream is thrown away
 * instead of decoded, and that packet is the first keyframe. A scrub's lone keyframe then never came
 * out at all, and every run began with the rest of a GOP decoded against a missing picture, each
 * picture handed the time of the one before it. -probesize 32 already stops the probe at that packet.
 * maxKbps / bufSeconds: cap the rate, with an encoder buffer of bufSeconds at the cap (below).
 * lowDelay (the default): -flags low_delay, which turns the decoder's frame threads off, so every
 * picture pushed in comes out without waiting for the next ones: what a scrub (one keyframe, then
 * nothing) and keyframes only (one every half second or more) need. It also makes the H.265 decoder
 * single-threaded: 4K converted below real time at full size, and at 1.2x within PLAYBACK_LIMITS
 * (smoothness report, cause 2a). So playback going forward passes false: DECODE_THREADS frame threads,
 * 2.2-2.3x, holding back one picture.
 * @param {{ encoder?: 'libx264'|'h264_vaapi', inCodec?: number, keepEvery?: number, maxWidth?: number,
 *   crf?: number, maxKbps?: number, bufSeconds?: number, lowDelay?: boolean }} o
 */
export function ffmpegArgs({ encoder = 'libx264', inCodec = CODEC_H265, keepEvery = 1, maxWidth = 0, crf = CRF, maxKbps = 0, bufSeconds = 4, lowDelay = true } = {}) {
  // (-threads here is an input option: it is the decoder's; libx264 picks its own)
  const decode = lowDelay ? ['-flags', 'low_delay'] : ['-threads', String(DECODE_THREADS)]
  const head = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...decode, '-probesize', '32', '-analyzeduration', '0']
  const input = ['-f', inCodec === CODEC_H265 ? 'hevc' : 'h264', '-i', 'pipe:0', '-an']
  const tail = ['-fps_mode', 'passthrough', '-flush_packets', '1', '-f', 'h264', 'pipe:1']
  if (encoder === 'h264_vaapi') {
    // Decode and encode both on the GPU: the frame never comes back to main memory, which is the
    // whole point of using it. If the GPU cannot decode this stream ffmpeg exits at once and the
    // caller falls back to libx264 rather than failing the playback.
    return [
      ...head,
      '-hwaccel', 'vaapi', '-hwaccel_device', RENDER_NODE, '-hwaccel_output_format', 'vaapi',
      ...input,
      '-c:v', 'h264_vaapi', '-qp', String(CRF), '-bf', '0', '-g', '50',
      ...tail
    ]
  }
  const filters = []
  // by frame number, not by time: raw Annex B has no timestamps for a time-based filter to use,
  // and a fixed ratio is what lets Transcoder hand each kept frame the right capture time
  if (keepEvery > 1) filters.push(`select=not(mod(n\\,${keepEvery}))`)
  if (maxWidth > 0) filters.push(`scale=min(${maxWidth}\\,iw):-2`)
  return [
    ...head,
    ...input,
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    '-c:v', 'libx264', '-preset', PRESET, '-crf', String(crf), '-tune', 'zerolatency', '-bf', '0', '-g', '50', '-pix_fmt', 'yuv420p',
    // Phones: a buffer of 4 s at the cap, so the keyframe (many times a normal frame) can be sent
    // whole and sharp, instead of being squeezed to the cap and arriving as blocks. Playback asks for
    // 1 s (PLAYBACK_LIMITS): there the burst itself is what stalls a viewer on a thin link.
    ...(maxKbps > 0 ? ['-maxrate', `${maxKbps}k`, '-bufsize', `${Math.round(maxKbps * bufSeconds)}k`] : []),
    ...tail
  ]
}

/** The detection run that proves h264_vaapi actually works on this box (no pipes, half a second). */
export function probeArgs() {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-vaapi_device', RENDER_NODE,
    '-f', 'lavfi', '-i', 'color=black:s=320x240:r=5:d=0.4',
    '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-f', 'null', '-'
  ]
}

/**
 * Wraps the command so the conversion always loses to recording: nice for the CPU, ionice class 3
 * (idle) for the disk. Only done where those tools exist (Linux, the server); everywhere else the
 * command is left alone and the priority is dropped after the spawn instead.
 * @param {{ platform?: string, hasNice?: boolean, hasIonice?: boolean, nice?: number }} o
 */
export function niceWrap(bin, args, { platform = process.platform, hasNice = true, hasIonice = true, nice = NICE } = {}) {
  if (platform !== 'linux' || !hasNice) return { bin, args }
  const pre = hasIonice ? ['ionice', '-c', '3', 'nice', '-n', String(nice)] : ['nice', '-n', String(nice)]
  return { bin: pre[0], args: [...pre.slice(1), bin, ...args] }
}

// ---- Annex B framing --------------------------------------------------------------------------

const VCL = (t) => t === 1 || t === 5
// A NAL that always opens an access unit when one is already in progress: delimiter, SPS, PPS, SEI.
const OPENER = (t) => t === 9 || t === 7 || t === 8 || t === 6

/** Every NAL unit start in an Annex B buffer: { at (the start code), payload (the NAL header byte index) }. */
export function nalStarts(buf) {
  const out = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0) continue
    if (buf[i + 2] === 1) {
      out.push({ at: i, payload: i + 3 })
      i += 2
    } else if (buf[i + 2] === 0 && buf[i + 3] === 1) {
      out.push({ at: i, payload: i + 4 })
      i += 3
    }
  }
  return out
}

/**
 * Splits an H.264 Annex B byte stream into whole access units (one picture each), because the wire
 * format sends one frame per message and ffmpeg's stdout is just bytes.
 *
 * A new unit starts at the first slice NAL of a new picture -- first_mb_in_slice is a ue(v), so the
 * value 0 is the single bit 1 and shows up as the top bit of the byte after the NAL header -- and
 * any parameter sets, SEI or delimiter in front of that slice belong to it, not to the picture
 * before. The last unit is held back until the next one starts (or `flush`), because until then
 * there is no way to know it is complete.
 * @returns {{ units: Array<{ buf: Buffer, isKey: boolean }>, rest: Buffer }} rest: bytes not yet a whole unit
 */
export function splitAccessUnits(buf, { flush = false } = {}) {
  const nals = nalStarts(buf)
  const bounds = [] // index into nals where each access unit begins
  let haveVcl = false
  for (let n = 0; n < nals.length; n++) {
    const t = buf[nals[n].payload] & 0x1f
    const first = VCL(t) && (buf[nals[n].payload + 1] & 0x80) !== 0
    if (bounds.length === 0) {
      bounds.push(n)
      haveVcl = VCL(t)
      continue
    }
    if (haveVcl && (OPENER(t) || first)) {
      bounds.push(n)
      haveVcl = VCL(t)
    } else if (VCL(t)) haveVcl = true
  }
  const units = []
  const last = flush ? bounds.length : bounds.length - 1
  for (let b = 0; b < last; b++) {
    const from = nals[bounds[b]].at
    const to = b + 1 < bounds.length ? nals[bounds[b + 1]].at : buf.length
    const slice = buf.subarray(from, to)
    let isKey = false
    for (let n = bounds[b]; n < (b + 1 < bounds.length ? bounds[b + 1] : nals.length); n++) {
      if ((buf[nals[n].payload] & 0x1f) === 5) isKey = true
    }
    if (slice.length) units.push({ buf: Buffer.from(slice), isKey })
  }
  const rest = flush || bounds.length === 0 ? Buffer.alloc(0) : Buffer.from(buf.subarray(nals[bounds.at(-1)].at))
  return { units, rest }
}

// ---- encoder detection ------------------------------------------------------------------------

let detected = null // the promise, so the detection runs once for the life of the process

/**
 * Which encoder this box will use, worked out once and remembered: hardware if /dev/dri/renderD128
 * exists and a real 0.4 s encode through it succeeds, software otherwise. Asked once rather than per
 * playback because the probe costs a process and the answer cannot change while the server runs.
 * @param {{ exists?: (p: string) => boolean, run?: (bin: string, args: string[]) => Promise<number>,
 *           log?: (line: string) => void, platform?: string, force?: boolean }} o
 * @returns {Promise<'libx264'|'h264_vaapi'>}
 */
export function detectEncoder({ exists, run, log = (l) => console.log(l), platform = process.platform, force = false } = {}) {
  if (detected && !force) return detected
  const probe = async () => {
    if (platform !== 'linux') return 'libx264'
    const there = exists ? exists(RENDER_NODE) : (await import('node:fs')).existsSync(RENDER_NODE)
    if (!there) return 'libx264'
    const code = await (run ?? runOnce)('ffmpeg', probeArgs()).catch(() => 1)
    return code === 0 ? 'h264_vaapi' : 'libx264'
  }
  detected = probe().then(
    (enc) => {
      setEncoder(enc)
      log(`[transcode] H.265 -> H.264 playback fallback using ${enc} (cap ${pool.max} at once)`)
      return enc
    },
    () => setEncoder('libx264')
  )
  return detected
}

/** The encoder decided on so far, without waiting (libx264 until detection has answered). */
export function encoderNow() {
  return current
}
let current = 'libx264'
/** Detection or a runtime failure settled on this encoder. */
export function setEncoder(enc) {
  current = enc === 'h264_vaapi' ? 'h264_vaapi' : 'libx264'
  return current
}

/** Runs a command to completion and resolves its exit code (used by the hardware probe). */
function runOnce(bin, args) {
  return new Promise((resolve) => {
    const p = nodeSpawn(bin, args, { stdio: 'ignore' })
    p.on('error', () => resolve(1))
    p.on('close', (code) => resolve(code ?? 1))
  })
}

// ---- the conversion itself --------------------------------------------------------------------

// Access unit delimiters (Transcoder.endPicture): H.265 NAL type 35 with pic_type 2 (any slice type),
// H.264 NAL type 9 with primary_pic_type 7 (any); each followed by its stop bit.
const AUD_H265 = Buffer.from([0, 0, 0, 1, 0x46, 0x01, 0x50])
const AUD_H264 = Buffer.from([0, 0, 0, 1, 0x09, 0xf0])

/**
 * One ffmpeg turning one viewer's H.265 frames into H.264, with the timestamps kept.
 *
 * Timestamps: raw Annex B carries none, so the time of each frame pushed in is remembered here and
 * given back to the frame that comes out. ffmpeg hands frames back in presentation order, so the
 * times are handed back smallest first rather than in the order they went in; with these recordings
 * (no B-frames) the two are the same, and if a camera ever does use them the picture still gets the
 * time it belongs to instead of a shuffled one.
 *
 * Everything is injectable so the lifetime -- and above all the killing -- is tested without ffmpeg.
 */
export class Transcoder {
  /**
   * @param {{ inCodec?: number, encoder?: string, onFrame: (tsMs: number, isKey: boolean, buf: Buffer) => void,
   *   onFail?: (err: Error) => void, onHardwareFailed?: () => void, log?: (line: string) => void,
   *   spawn?: Function, platform?: string, hasNice?: boolean, hasIonice?: boolean,
   *   setPriority?: Function, now?: () => number, setTimer?: Function, clearTimer?: Function,
   *   flushIdleMs?: number, lowDelay?: boolean|(() => boolean) }} o
   *   lowDelay: see ffmpegArgs; a function is asked each time an ffmpeg starts
   */
  constructor({
    inCodec = CODEC_H265,
    keepEvery = 1,
    maxWidth = 0,
    crf = CRF,
    maxKbps = 0,
    bufSeconds = 4,
    lowDelay = true,
    encoder = keepEvery > 1 || maxWidth > 0 ? 'libx264' : encoderNow(),
    onFrame,
    onFail = () => {},
    onHardwareFailed = () => {},
    log = (line) => console.log(line),
    spawn = nodeSpawn,
    platform = process.platform,
    hasNice = platform === 'linux',
    hasIonice = platform === 'linux',
    setPriority: prio = setPriority,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    flushIdleMs = FLUSH_IDLE_MS
  } = {}) {
    Object.assign(this, { inCodec, keepEvery, maxWidth, crf, maxKbps, bufSeconds, lowDelay, encoder, onFrame, onFail, onHardwareFailed, log, spawn, platform, hasNice, hasIonice, prio, setTimer, clearTimer, flushIdleMs })
    this.proc = null
    this.closed = false
    this.times = [] // the times of the frames pushed in and not yet handed back, smallest first
    this.buf = Buffer.alloc(0)
    this.out = 0 // frames handed back (a hardware encoder that produced none is a broken one)
    this.idle = null
  }

  /** Whether an ffmpeg is running right now (the proof that reset and close really kill it). */
  get running() {
    return Boolean(this.proc)
  }

  #start() {
    // asked afresh for every run (each starts at a keyframe after a reset): one session plays forward,
    // scrubs and plays keyframes only in turn, and only playing forward goes without low_delay
    const lowDelay = typeof this.lowDelay === 'function' ? Boolean(this.lowDelay()) : this.lowDelay !== false
    const args = ffmpegArgs({ encoder: this.encoder, inCodec: this.inCodec, keepEvery: this.keepEvery, maxWidth: this.maxWidth, crf: this.crf, maxKbps: this.maxKbps, bufSeconds: this.bufSeconds, lowDelay })
    const { bin, args: full } = niceWrap('ffmpeg', args, { platform: this.platform, hasNice: this.hasNice, hasIonice: this.hasIonice })
    const proc = this.spawn(bin, full, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    this.out = 0
    this.buf = Buffer.alloc(0)
    this.times = []
    this.inCount = 0 // frames fed to this ffmpeg: with keepEvery, only every keepEvery-th comes back
    this.stderr = ''
    // Where nice is not available (or the wrapper was skipped), ask the kernel directly. It is the
    // same intent: this work is never allowed to slow the recorder down.
    if (!this.hasNice && proc.pid) {
      try {
        this.prio(proc.pid, NICE)
      } catch {}
    }
    proc.stdin?.on('error', () => {}) // a killed ffmpeg gives EPIPE on the next write; not an error here
    proc.stdout?.on('data', (chunk) => this.#onData(proc, chunk))
    proc.stderr?.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-500)
    })
    proc.on('error', (e) => this.#onExit(proc, null, e))
    proc.on('close', (code) => this.#onExit(proc, code, null))
    return proc
  }

  /** Feeds one recorded frame in. Starts ffmpeg on the first frame of a run. */
  push(tsMs, isKey, buf) {
    if (this.closed) return
    if (!this.proc) {
      // Start on a keyframe only: a decoder handed deltas whose keyframe it never saw produces
      // nothing but errors, and after a seek the first frame is always a keyframe anyway.
      if (!isKey) return
      this.#start()
    }
    const n = this.inCount++
    try {
      this.proc.stdin.write(buf)
    } catch {}
    if (this.keepEvery > 1 && n % this.keepEvery !== 0) return // dropped by ffmpeg's select filter
    const t = this.times
    let i = t.length
    while (i > 0 && t[i - 1] > tsMs) i--
    t.splice(i, 0, tsMs)
  }

  /**
   * Ends the picture just pushed, for when nothing will follow it (a scrub: one keyframe, then
   * paused). ffmpeg's raw H.265/H.264 parser only knows a picture is complete when the next one
   * starts, so a lone keyframe was never decoded and the viewer saw no picture for the whole drag.
   * An access unit delimiter is the smallest thing that starts a new unit: the parser lets the
   * picture go, and the delimiter itself decodes to nothing. The bytes after the NAL header matter:
   * the H.265 parser reads one byte past its 2-byte header before it decides.
   */
  endPicture() {
    if (this.closed || !this.proc) return
    try {
      this.proc.stdin.write(this.inCodec === CODEC_H265 ? AUD_H265 : AUD_H264)
    } catch {}
  }

  #onData(proc, chunk) {
    if (proc !== this.proc || this.closed) return
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk)
    this.#drain(false)
    // The tail is held back until the next frame proves it complete, which would leave a scrub's
    // single keyframe stuck for ever. ffmpeg flushes a whole packet at a time, so a pause this long
    // means what is buffered is a whole frame.
    this.clearTimer(this.idle)
    this.idle = this.setTimer(() => {
      if (proc === this.proc && !this.closed) this.#drain(true)
    }, this.flushIdleMs)
    this.idle?.unref?.()
  }

  #drain(flush) {
    const { units, rest } = splitAccessUnits(this.buf, { flush })
    this.buf = rest
    for (const u of units) {
      const ts = this.times.shift()
      if (ts === undefined) continue // more pictures out than in: nothing sensible to stamp them with
      this.out++
      this.onFrame(ts, u.isKey, u.buf)
    }
  }

  #onExit(proc, code, err) {
    if (proc !== this.proc) return // an older run we already killed
    this.proc = null
    this.clearTimer(this.idle)
    this.idle = null
    if (this.closed) return
    const why = err ? err.message : `ffmpeg exited with ${code}${this.stderr ? `: ${this.stderr.trim()}` : ''}`
    if (this.encoder === 'h264_vaapi' && this.out === 0) {
      // The GPU said yes at startup and no in practice (a stream it cannot decode, the device busy).
      // Falling back costs a restart; failing the playback would cost the viewer the footage. The
      // restart waits for the next keyframe (push ignores deltas with no ffmpeg running), so this
      // costs at most one GOP of picture, once, and never the session.
      this.log(`[transcode] hardware encoding failed (${why}); falling back to libx264`)
      this.encoder = setEncoder('libx264')
      this.onHardwareFailed()
      return
    }
    if (this.out === 0) return this.onFail(new Error(why))
    // It had been working: the reader will push the next keyframe and a fresh ffmpeg starts then.
    this.log(`[transcode] conversion ended after ${this.out} frames (${why})`)
  }

  /** Kills ffmpeg and forgets everything in flight: a seek, a speed change, anything that jumps. */
  reset() {
    const proc = this.proc
    this.proc = null
    this.clearTimer(this.idle)
    this.idle = null
    this.times = []
    this.buf = Buffer.alloc(0)
    if (!proc) return
    try {
      proc.stdin?.end()
    } catch {}
    try {
      proc.kill('SIGKILL')
    } catch {}
  }

  /** The viewer has gone: kill and never call back again. */
  close() {
    if (this.closed) return
    this.closed = true
    this.reset()
  }
}
