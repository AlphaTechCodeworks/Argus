// Offline tests for the H.265 -> H.264 playback fallback's logic (cctv/transcode.mjs): when a
// recording may be converted at all, the ffmpeg arguments, nice/ionice, the concurrency cap, the
// Annex B framing, ending a scrub's picture (endPicture), encoder detection with its fallback, and
// -- the part that matters most -- that the ffmpeg process is really killed on close, on error and on seek.
//
// Nothing here spawns ffmpeg or touches the SDK, so it runs on Windows with plain node:
//   node cctv/test/transcode.test.mjs
// What only the real ffmpeg can show (that the pictures come out at all) is in transcode-ffmpeg.test.mjs.
import { EventEmitter } from 'node:events'
import {
  CODEC_H264,
  CODEC_H265,
  DECODE_THREADS,
  DEFAULT_MAX,
  GOP_FRAMES,
  NICE,
  PLAYBACK_LIMITS,
  RENDER_NODE,
  TranscodePool,
  Transcoder,
  clientCanDecodeH265,
  detectEncoder,
  encoderNow,
  ffmpegArgs,
  maxTranscodes,
  nalStarts,
  niceWrap,
  probeArgs,
  setEncoder,
  splitAccessUnits,
  wantsTranscode
} from '../transcode.mjs'

let failures = 0
const J = (v) => JSON.stringify(v)
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

// ---- when a recording may be converted at all -------------------------------------------------
{
  check('wantsTranscode: H.265 recording and a browser that cannot decode it', wantsTranscode({ clientH265: false, codec: CODEC_H265 }) === true)
  check('  a browser that CAN decode H.265 is never sent anything else', wantsTranscode({ clientH265: true, codec: CODEC_H265 }) === false)
  check('  an H.264 recording is never touched', wantsTranscode({ clientH265: false, codec: CODEC_H264 }) === false && wantsTranscode({ clientH265: true, codec: CODEC_H264 }) === false)
  // a client that says nothing must behave exactly as it does today
  check('  clientH265 missing or not exactly false means no conversion', wantsTranscode({ codec: CODEC_H265 }) === false && wantsTranscode({ clientH265: 0, codec: CODEC_H265 }) === false)

  const q = (s) => new URLSearchParams(s)
  check('clientCanDecodeH265: only &h265=0 asks for conversion', clientCanDecodeH265(q('h265=0')) === false)
  check('  h265=1, a junk value, or the parameter missing: no conversion', clientCanDecodeH265(q('h265=1')) === true && clientCanDecodeH265(q('h265=yes')) === true && clientCanDecodeH265(q('ch=1')) === true && clientCanDecodeH265(null) === true)
}

// ---- the cap ----------------------------------------------------------------------------------
{
  check('the cap starts at 2', DEFAULT_MAX === 2)
  check('maxTranscodes: from the environment', maxTranscodes({ CCTV_TRANSCODE_MAX: '4' }) === 4 && maxTranscodes({ CCTV_TRANSCODE_MAX: '0' }) === 0)
  check('  a missing, negative, fractional or silly value falls back to the default', maxTranscodes({}) === 2 && maxTranscodes({ CCTV_TRANSCODE_MAX: '-1' }) === 2 && maxTranscodes({ CCTV_TRANSCODE_MAX: '1.5' }) === 2 && maxTranscodes({ CCTV_TRANSCODE_MAX: 'lots' }) === 2 && maxTranscodes({ CCTV_TRANSCODE_MAX: '99' }) === 2)

  const p = new TranscodePool(2)
  const a = p.acquire()
  const b = p.acquire()
  check('pool: two slots, then no more (the third viewer is refused, not queued)', a && b && p.acquire() === null && p.active === 2)
  a.release()
  check('  a released slot frees one', p.active === 1 && Boolean(p.acquire()))
  b.release()
  b.release()
  check('  releasing twice does not invent a free slot', p.active === 1, `active ${p.active}`)
  const none = new TranscodePool(0)
  check('  a cap of 0 turns the feature off', none.acquire() === null)

  // keepFree: a conversion that has an alternative (a remote viewer's playback fitted to the tunnel,
  // rec-playback.mjs) leaves that many slots for the ones that have none (H.265 for a browser without it)
  const q = new TranscodePool(2)
  const opt = q.acquire({ keepFree: 1 })
  check('pool, keepFree 1: a slot while two are free', Boolean(opt) && q.active === 1)
  check('  not the last one', q.acquire({ keepFree: 1 }) === null && q.active === 1)
  const need = q.acquire()
  check('  which is still there for a conversion that must have it', Boolean(need) && q.active === 2)
  opt?.release()
  need?.release()
  check('  a cap of 1 has no slot to spare', new TranscodePool(1).acquire({ keepFree: 1 }) === null)
}

// ---- ffmpeg arguments -------------------------------------------------------------------------
{
  const soft = ffmpegArgs({ encoder: 'libx264', inCodec: CODEC_H265 })
  const s = soft.join(' ')
  check('ffmpegArgs: hevc in on stdin, raw H.264 out on stdout', /-f hevc -i pipe:0/.test(s) && /-f h264 pipe:1/.test(s), s)
  check('  libx264 at veryfast/crf 26, the measured trade', /-c:v libx264/.test(s) && /-preset veryfast/.test(s) && /-crf 26/.test(s))
  check('  no B-frames and no reordering, so a frame comes out for each one put in, in order', /-bf 0/.test(s) && /-fps_mode passthrough/.test(s))
  check('  flushed per packet, and the probe stops at the first packet, so playback is not held up', /-flush_packets 1/.test(s) && /-probesize 32/.test(s))
  // nobuffer throws away the packet read while probing -- the first keyframe (transcode-ffmpeg.test.mjs)
  check('  never -fflags nobuffer: the first keyframe is decoded, not dropped by the probe', !/nobuffer/.test(s) && !/nobuffer/.test(ffmpegArgs({ encoder: 'h264_vaapi' }).join(' ')) && !/nobuffer/.test(ffmpegArgs({ keepEvery: 2, maxWidth: 1280 }).join(' ')), s)
  check('  no audio is ever produced', s.includes('-an'))
  check('  an H.264 recording would be fed in as h264 (never reached, but not wrong)', ffmpegArgs({ inCodec: CODEC_H264 }).join(' ').includes('-f h264 -i pipe:0'))

  // Playback's size and rate cap (smoothness report, cause 2b): a 4K H.265 recording converted at full
  // size ran at 0.79-0.99x real time and came out at ~9 Mbit/s, more than the tunnel carries.
  check('PLAYBACK_LIMITS: playback converts at most 1920 wide, at most 2.5 Mbit/s, with a 1 s buffer', PLAYBACK_LIMITS.maxWidth === 1920 && PLAYBACK_LIMITS.maxKbps === 2500 && PLAYBACK_LIMITS.bufSeconds === 1 && Object.isFrozen(PLAYBACK_LIMITS), JSON.stringify(PLAYBACK_LIMITS))
  const capped = ffmpegArgs({ encoder: 'libx264', ...PLAYBACK_LIMITS }).join(' ')
  check('  scaled down to 1920 wide (never up), the height kept in proportion', capped.includes('-vf scale=min(1920\\,iw):-2'), capped)
  check('  the rate capped at 2500k with a buffer of 1 s at the cap: a keyframe cannot burst past what a tunnel carries', capped.includes('-maxrate 2500k -bufsize 2500k'), capped)
  const phone = ffmpegArgs({ encoder: 'libx264', maxKbps: 500 }).join(' ')
  check('  a cap without bufSeconds keeps the 4 s buffer (phones, phone-live.mjs: unchanged)', phone.includes('-maxrate 500k -bufsize 2000k'), phone)
  check('  no cap: no rate options at all (unchanged)', !/-maxrate|-bufsize/.test(s))
  // Keyframes only: x264 spends the cap as maxKbps / fps per picture, the fps taken from the input's
  // timestamps, which the raw demuxer puts one camera frame apart. A keyframe run sends 2-8 pictures
  // a second, so each got a 1x picture's share (15.6 KB at 20 fps) and came out blocky, with the
  // link mostly idle. picturesPerS stamps them that many a second instead.
  const keys = ffmpegArgs({ encoder: 'libx264', ...PLAYBACK_LIMITS, picturesPerS: 8 }).join(' ')
  check('  picturesPerS: the pictures are stamped that many a second (-r, an input option: before -i)', keys.includes('-analyzeduration 0 -r 8 -f hevc -i pipe:0'), keys)
  check('  and the cap is the same number, now per second of wall clock', keys.includes('-maxrate 2500k -bufsize 2500k'), keys)
  check('  picturesPerS not given, or 0: the stream\'s own timestamps (unchanged)', !/ -r /.test(capped) && !/ -r /.test(ffmpegArgs({ encoder: 'libx264', ...PLAYBACK_LIMITS, picturesPerS: 0 }).join(' ')), capped)

  // -flags low_delay turns the H.265 decoder's frame threads off: one thread, 0.8-0.99x real time at
  // 4K (smoothness report, cause 2a). Playing forward it is dropped; one picture at a time (a scrub,
  // keyframes only) keeps it, since frame threads hold pictures back until more arrive.
  check('  low_delay by default (scrubs, keyframes, phones and NVR playback unchanged), no thread count', /-nostdin -flags low_delay -probesize 32/.test(s) && !/-threads/.test(s), s)
  const played = ffmpegArgs({ encoder: 'libx264', lowDelay: false }).join(' ')
  check(`  lowDelay false: no low_delay, and ${DECODE_THREADS} decoder threads (an input option: before -i)`, !/low_delay/.test(played) && played.includes(`-nostdin -threads ${DECODE_THREADS} -probesize 32 -analyzeduration 0 -f hevc -i pipe:0`), played)
  check('  two decoder threads: each holds back one picture at most', DECODE_THREADS === 2)

  const hw = ffmpegArgs({ encoder: 'h264_vaapi' }).join(' ')
  check('  hardware: h264_vaapi on the render node, decode and encode both on the GPU', /-c:v h264_vaapi/.test(hw) && hw.includes(RENDER_NODE) && /-hwaccel vaapi/.test(hw) && /-hwaccel_output_format vaapi/.test(hw), hw)
  check('  hardware output is still raw H.264 on stdout', /-f h264 pipe:1/.test(hw) && !/libx264/.test(hw))

  // The keyframe interval, in pictures out. 50 unless the caller says: playback and a phone on the
  // local network are unchanged. A remote viewer's live conversion asks for 2 s of its own output
  // rate (phone-live.mjs gopFor): 50 pictures was 3.3 s at 15 fps and 12.5 s at 4, the wait for a
  // picture after every drop (stutter report 2.7).
  check('gop: a keyframe every 50 pictures when not given (playback, phones: unchanged)', GOP_FRAMES === 50 && / -g 50 /.test(s) && / -g 50 /.test(capped) && / -g 50 /.test(hw), s)
  const g60 = ffmpegArgs({ encoder: 'libx264', ...PLAYBACK_LIMITS, gop: 60 }).join(' ')
  check('  gop 60: -g 60, and no other keyframe interval', / -g 60 /.test(g60) && (g60.match(/ -g /g) ?? []).length === 1, g60)
  check('  on the GPU too', / -g 40 /.test(ffmpegArgs({ encoder: 'h264_vaapi', gop: 40 }).join(' ')))
  const odd = [0, -3, 2.5, NaN, '30', null].map((gop) => ffmpegArgs({ encoder: 'libx264', gop }).join(' ').match(/ -g (\S+) /)?.[1])
  check('  anything but a whole number above 0: the default 50', J(odd) === J(['50', '50', '50', '50', '50', '50']), J(odd))
  check('probeArgs: a short self-contained encode that proves the GPU really works', probeArgs().join(' ').includes('-c:v h264_vaapi') && probeArgs().join(' ').includes('-f null'))
}

// ---- nice / ionice ----------------------------------------------------------------------------
{
  const w = niceWrap('ffmpeg', ['-i', 'pipe:0'], { platform: 'linux' })
  check('niceWrap: on the server ffmpeg runs behind ionice -c 3 and nice', w.bin === 'ionice' && w.args.join(' ') === `-c 3 nice -n ${NICE} ffmpeg -i pipe:0`, `${w.bin} ${w.args.join(' ')}`)
  const n = niceWrap('ffmpeg', ['-x'], { platform: 'linux', hasIonice: false })
  check('  without ionice, nice alone', n.bin === 'nice' && n.args.join(' ') === `-n ${NICE} ffmpeg -x`)
  const none = niceWrap('ffmpeg', ['-x'], { platform: 'linux', hasNice: false })
  check('  with neither, the command is left alone (the priority is dropped after the spawn)', none.bin === 'ffmpeg' && none.args.join(' ') === '-x')
  check('  off Linux, unchanged', niceWrap('ffmpeg', ['-x'], { platform: 'win32' }).bin === 'ffmpeg')
}

// ---- Annex B framing --------------------------------------------------------------------------
// Handmade H.264: 4-byte start codes, NAL header, then a payload byte whose top bit says this slice
// starts a new picture (first_mb_in_slice = 0).
const nal = (type, firstMb = true, extra = 3) => Buffer.concat([Buffer.from([0, 0, 0, 1, type & 0x1f]), Buffer.from([firstMb ? 0x88 : 0x0c]), Buffer.alloc(extra, 0x42)])
const SPS = nal(7)
const PPS = nal(8)
const IDR = nal(5)
const P = nal(1)
const P2 = nal(1, false) // a second slice of the same picture
{
  check('nalStarts: finds 4-byte and 3-byte start codes', nalStarts(Buffer.from([0, 0, 0, 1, 9, 0, 0, 1, 7])).length === 2)
  check('  a lone zero pair is not a start code', nalStarts(Buffer.from([0, 0, 5, 6, 7, 8])).length === 0)

  const stream = Buffer.concat([SPS, PPS, IDR, P, P, P])
  const one = splitAccessUnits(stream)
  check('split: one picture per access unit, the last held back until the next proves it complete', one.units.length === 3, `${one.units.length} units`)
  check('  the parameter sets belong to the keyframe in front of them, not to the picture before', one.units[0].isKey === true && one.units[0].buf.length === SPS.length + PPS.length + IDR.length)
  check('  the frames after it are not keyframes', one.units[1].isKey === false && one.units[2].isKey === false)
  check('  the held-back tail is returned to be prepended to the next chunk', one.rest.length === P.length)

  const all = splitAccessUnits(stream, { flush: true })
  check('  flush (a scrub: one keyframe and nothing more is coming) releases the tail', all.units.length === 4 && all.rest.length === 0)

  const multi = splitAccessUnits(Buffer.concat([IDR, P2, P, P2]), { flush: true })
  check('  a picture cut into several slices stays one frame', multi.units.length === 2 && multi.units[0].isKey === true, `${multi.units.length} units`)

  // the real case: ffmpeg's stdout arrives in whatever sized lumps the pipe feels like
  const whole = Buffer.concat([SPS, PPS, IDR, P, P, SPS, PPS, IDR, P])
  let rest = Buffer.alloc(0)
  const got = []
  for (let i = 0; i < whole.length; i += 5) {
    const r = splitAccessUnits(Buffer.concat([rest, whole.subarray(i, i + 5)]))
    rest = r.rest
    got.push(...r.units)
  }
  got.push(...splitAccessUnits(rest, { flush: true }).units)
  check('  the same units come out however the bytes are chopped up', got.map((u) => (u.isKey ? 'K' : 'p')).join('') === 'KppKp', got.map((u) => (u.isKey ? 'K' : 'p')).join(''))
  check('  and every byte is accounted for', Buffer.concat(got.map((u) => u.buf)).equals(whole))
  check('  nothing in, nothing out', splitAccessUnits(Buffer.alloc(0)).units.length === 0 && splitAccessUnits(Buffer.alloc(0), { flush: true }).units.length === 0)
}

// ---- a fake ffmpeg ----------------------------------------------------------------------------
// Stands in for the real one so the lifetime can be tested anywhere. It records every kill.
class FakeProc extends EventEmitter {
  constructor() {
    super()
    this.pid = 4242
    this.killed = []
    this.written = []
    this.stdin = Object.assign(new EventEmitter(), { write: (b) => this.written.push(b), end: () => (this.ended = true) })
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
  }
  kill(sig) {
    this.killed.push(sig)
  }
}

function harness(opts = {}) {
  const procs = []
  const frames = []
  const fails = []
  const logs = []
  const timers = []
  const t = new Transcoder({
    onFrame: (ts, isKey, buf) => frames.push({ ts, isKey, buf }),
    onFail: (e) => fails.push(e),
    log: (l) => logs.push(l),
    platform: 'linux',
    hasNice: true,
    hasIonice: true,
    spawn: (bin, args) => {
      const p = new FakeProc()
      p.bin = bin
      p.args = args
      procs.push(p)
      return p
    },
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => {},
    ...opts
  })
  return { t, procs, frames, fails, logs, fireIdle: () => timers.splice(0).forEach((fn) => fn()) }
}

// ---- pushing frames through -------------------------------------------------------------------
{
  const { t, procs, frames, fireIdle } = harness()
  t.push(1000, false, P)
  check('Transcoder: nothing starts on a delta frame (a decoder needs the keyframe first)', procs.length === 0 && t.running === false)
  t.push(2000, true, IDR)
  check('  the first keyframe starts one ffmpeg', procs.length === 1 && t.running === true)
  check('  and it is niced', procs[0].bin === 'ionice')
  t.push(2040, false, P)
  t.push(2080, false, P)
  procs[0].stdout.emit('data', Buffer.concat([SPS, PPS, IDR, P, P]))
  check('  each converted picture is handed back with the time of the frame that went in', frames.map((f) => f.ts).join() === '2000,2040', frames.map((f) => f.ts).join())
  check('  and the keyframe is still a keyframe', frames[0].isKey === true && frames[1].isKey === false)
  fireIdle()
  check('  the last picture follows once ffmpeg has gone quiet (a scrub shows its still)', frames.length === 3 && frames[2].ts === 2080)

  // frames handed back in presentation order get the presentation times, not a shuffled set
  const h2 = harness()
  h2.t.push(5000, true, IDR)
  h2.t.push(5080, false, P)
  h2.t.push(5040, false, P)
  h2.procs[0].stdout.emit('data', Buffer.concat([IDR, P, P]))
  h2.fireIdle()
  check('  times are handed back in time order, so reordering cannot shuffle the picture', h2.frames.map((f) => f.ts).join() === '5000,5040,5080', h2.frames.map((f) => f.ts).join())

  const h3 = harness({ ...PLAYBACK_LIMITS })
  h3.t.push(1000, true, IDR)
  const a = h3.procs[0]?.args.join(' ') ?? ''
  check('  the limits it is given reach ffmpeg (size, rate and buffer)', a.includes('scale=min(1920\\,iw):-2') && a.includes('-maxrate 2500k -bufsize 2500k'), a)
  h3.t.close()

  // lowDelay may be a function: asked each time an ffmpeg starts (a run starts at a keyframe after
  // every reset), because one session plays forward, scrubs and plays keyframes in turn
  let still = false
  const h4 = harness({ lowDelay: () => still })
  h4.t.push(1000, true, IDR)
  h4.t.reset()
  still = true
  h4.t.push(2000, true, IDR)
  const runs = h4.procs.map((p) => /low_delay/.test(p.args.join(' ')))
  check('  lowDelay as a function: asked at each start (a run playing forward, then a scrub)', J(runs) === J([false, true]), J(runs))
  h4.t.close()
  // picturesPerS too: keyframes only, then playing forward again after a reset
  let perS = 8
  const h6 = harness({ ...PLAYBACK_LIMITS, picturesPerS: () => perS })
  h6.t.push(1000, true, IDR)
  h6.t.reset()
  perS = 0
  h6.t.push(2000, true, IDR)
  const stamped = h6.procs.map((p) => p.args.join(' ').match(/ -r (\d+) /)?.[1] ?? null)
  check('  picturesPerS as a function: asked at each start (keyframes only, then playing forward)', J(stamped) === J(['8', null]), J(stamped))
  h6.t.close()
  const h5 = harness()
  h5.t.push(1000, true, IDR)
  check('  lowDelay not given: low_delay, as before', /low_delay/.test(h5.procs[0].args.join(' ')))
  check('  gop not given: a keyframe every 50 pictures, as before', / -g 50 /.test(h5.procs[0].args.join(' ')), h5.procs[0].args.join(' '))
  h5.t.close()
  const h7 = harness({ gop: 30 })
  h7.t.push(1000, true, IDR)
  check('  the keyframe interval it is given reaches ffmpeg (gop)', / -g 30 /.test(h7.procs[0].args.join(' ')), h7.procs[0].args.join(' '))
  h7.t.close()
}

// ---- ending a picture: a scrub's single keyframe ------------------------------------------------
// ffmpeg's raw H.265/H.264 parser holds a picture until the next one starts, and after a scrub
// nothing else is written: without an end marker the keyframe never came out (the real ffmpeg proves
// it in transcode-ffmpeg.test.mjs). endPicture() writes an access unit delimiter, which starts the
// next unit, so the parser lets the keyframe go.
{
  const AUD_265 = Buffer.from([0, 0, 0, 1, 0x46, 0x01, 0x50])
  const AUD_264 = Buffer.from([0, 0, 0, 1, 0x09, 0xf0])
  const { t, procs } = harness()
  t.endPicture()
  check('endPicture: nothing running (no keyframe yet): nothing written, no ffmpeg started', procs.length === 0 && t.running === false)
  t.push(7000, true, IDR)
  t.endPicture()
  const w = procs[0].written
  check('  H.265 in: an access unit delimiter (00 00 00 01 46 01 50) straight after the keyframe', w.length === 2 && w[0] === IDR && Buffer.from(w[1]).equals(AUD_265), w.map((b) => Buffer.from(b).toString('hex')).join(' | '))
  check('  it is not a frame: no time is waiting for it', t.times.length === 1 && t.times[0] === 7000, t.times.join())
  t.reset()
  t.endPicture()
  check('  after a reset (the ffmpeg killed) it writes nothing and starts nothing', procs.length === 1 && w.length === 2)
  t.push(8000, true, IDR)
  t.close()
  t.endPicture()
  check('  after close it writes nothing', procs[1].written.length === 1)

  const h4 = harness({ inCodec: CODEC_H264 })
  h4.t.push(9000, true, IDR)
  h4.t.endPicture()
  const w4 = h4.procs[0].written
  check('  H.264 in: the H.264 delimiter (00 00 00 01 09 f0)', w4.length === 2 && Buffer.from(w4[1]).equals(AUD_264), w4.map((b) => Buffer.from(b).toString('hex')).join(' | '))
}

// ---- killing it: close, error, seek -------------------------------------------------------------
{
  const { t, procs } = harness()
  t.push(1, true, IDR)
  t.close()
  check('kill on close: the viewer left, ffmpeg is killed at once', procs[0].killed.join() === 'SIGKILL' && t.running === false)
  procs[0].stdout.emit('data', Buffer.concat([IDR, P]))
  check('  and a late chunk from it can no longer reach the socket', t.buf.length === 0)
  t.push(2, true, IDR)
  check('  a closed conversion never starts another ffmpeg', procs.length === 1)
  t.close()
  check('  closing twice is harmless', procs[0].killed.length === 1)
}
{
  const { t, procs } = harness()
  t.push(1, true, IDR)
  t.reset()
  check('kill on seek: reset kills ffmpeg and drops everything in flight', procs[0].killed.join() === 'SIGKILL' && t.running === false && t.times.length === 0 && t.buf.length === 0)
  t.push(2, false, P)
  check('  the new position waits for its keyframe', procs.length === 1)
  t.push(3, true, IDR)
  check('  and then a fresh ffmpeg is started', procs.length === 2 && t.running === true)
  check('  the one killed at the seek stays killed', procs[0].killed.length === 1 && procs[1].killed.length === 0)
  procs[0].stdout.emit('data', Buffer.concat([IDR, P, P]))
  t.reset()
  check('  frames from the old ffmpeg never become frames of the new position', t.buf.length === 0)
}
{
  // ffmpeg is missing, or dies before producing anything: the session is failed, not left hanging
  const { t, procs, fails } = harness()
  t.push(1, true, IDR)
  procs[0].emit('error', new Error('spawn ffmpeg ENOENT'))
  check('failure: an ffmpeg that never starts is reported once', fails.length === 1 && /ENOENT/.test(fails[0].message), fails[0]?.message)
  check('  and nothing is left running', t.running === false)
}
{
  // it had been working and then stopped: not a failure, the next keyframe starts a new one
  const { t, procs, fails, logs } = harness()
  t.push(1, true, IDR)
  t.push(2, false, P)
  t.push(3, false, P)
  procs[0].stdout.emit('data', Buffer.concat([IDR, P, P]))
  procs[0].emit('close', 0)
  check('an ffmpeg that ends after doing its work is logged, not reported as a failure', fails.length === 0 && logs.some((l) => /ended after 2 frames/.test(l)), logs.join(' | '))
  t.push(9, true, IDR)
  check('  and the next keyframe starts a new one', procs.length === 2)
}

// ---- hardware encoding, and falling back when it does not work ---------------------------------
{
  const before = encoderNow()
  setEncoder('h264_vaapi')
  const hw = []
  const { t, procs, fails, logs } = harness({ encoder: 'h264_vaapi', onHardwareFailed: () => hw.push(1) })
  t.push(1, true, IDR)
  check('hardware: the vaapi arguments are used', procs[0].args.join(' ').includes('h264_vaapi'))
  procs[0].stderr.emit('data', 'Device creation failed')
  procs[0].emit('close', 1)
  check('  a GPU that fails at runtime falls back to libx264 instead of failing the playback', fails.length === 0 && t.encoder === 'libx264' && hw.length === 1 && encoderNow() === 'libx264', logs.join(' | '))
  check('  and the fallback is logged with the reason', logs.some((l) => /hardware encoding failed/.test(l) && /Device creation failed/.test(l)), logs.join(' | '))
  t.push(2, true, IDR)
  check('  the next ffmpeg is a software one', procs.length === 2 && procs[1].args.join(' ').includes('libx264') && !procs[1].args.join(' ').includes('vaapi'))
  setEncoder(before)
}

// ---- detection at startup ----------------------------------------------------------------------
{
  const logs = []
  const ok = await detectEncoder({ platform: 'linux', exists: (p) => p === RENDER_NODE, run: async () => 0, log: (l) => logs.push(l), force: true })
  check('detectEncoder: a render node and a probe that succeeds -> hardware', ok === 'h264_vaapi' && encoderNow() === 'h264_vaapi')
  check('  and it says which encoder is in use', logs.some((l) => /h264_vaapi/.test(l)), logs.join(' | '))
  const noNode = await detectEncoder({ platform: 'linux', exists: () => false, run: async () => 0, log: () => {}, force: true })
  check('  no /dev/dri/renderD128 -> software, without running a probe at all', noNode === 'libx264')
  const badProbe = await detectEncoder({ platform: 'linux', exists: () => true, run: async () => 1, log: () => {}, force: true })
  check('  a render node whose probe fails -> software', badProbe === 'libx264')
  const threw = await detectEncoder({ platform: 'linux', exists: () => true, run: async () => { throw new Error('no ffmpeg') }, log: () => {}, force: true })
  check('  no ffmpeg at all -> software (the playback then fails honestly, not silently)', threw === 'libx264')
  const win = await detectEncoder({ platform: 'win32', exists: () => true, run: async () => 0, log: () => {}, force: true })
  check('  off Linux -> software', win === 'libx264')

  let runs = 0
  const first = await detectEncoder({ platform: 'linux', exists: () => true, run: async () => (runs++, 0), log: () => {}, force: true })
  const second = await detectEncoder({ platform: 'linux', exists: () => true, run: async () => (runs++, 0), log: () => {} })
  check('  the answer is worked out once and remembered', first === second && runs === 1, `${runs} probes`)
  setEncoder('libx264')
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
