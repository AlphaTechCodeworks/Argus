// The real ffmpeg behind the H.265 -> H.264 playback conversion (transcode.mjs). ffmpeg is installed
// on the server only, so this runs there. It proves what the fake ffmpeg in transcode.test.mjs cannot:
// that a scrub's picture comes out at all. A scrub pushes one keyframe into a fresh ffmpeg and then
// nothing more, and ffmpeg's raw HEVC/H.264 parser holds a picture until the next one starts, so the
// keyframe never came out and a browser without HEVC showed the old picture for the whole drag.
// Transcoder.endPicture() writes an access unit delimiter after it, which ends the picture.
//   - one keyframe from ffmpeg's own test pattern (H.265 at 1080p and 4K, H.264 at 1080p), pushed and
//     ended: exactly one H.264 picture comes back, with the keyframe's time, and it decodes;
//   - two scrubs in a row on one converter (a reset between them, as every scrub does);
//   - playing forward without low_delay (frame threads): every picture out, in order, at most one
//     held back until the next arrives; the speed with and without it, for the record;
//   - playback's limits (PLAYBACK_LIMITS): noisy 4K comes out 1920x1080, within the rate cap, and no
//     picture bigger than the 1 s buffer;
//   - keyframes only within PLAYBACK_LIMITS, stamped maxKeysPerS a second (picturesPerS): pictures
//     no smaller than with no cap at all on a clean clip, and a grainy clip within the cap per
//     second of wall clock at that rate;
//   - the whole path: a recorded .h265 file, ServerPlayback with &h265=0, {scrub}: one converted
//     frame on the socket after {type:'scrub'}, for each of two scrubs, each ffmpeg with low_delay;
//     played at 1x (no low_delay, every picture) and at 2x (keyframes only, with low_delay, each out
//     without waiting for the next, stamped 8 a second).
// ffmpeg runs behind ionice and nice here exactly as in the service. Nothing reaches an NVR.
//   node cctv/test/transcode-ffmpeg.test.mjs        (on the server copy)
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-xcode-ffmpeg-test-'))
const { CODEC_H264, CODEC_H265, DECODE_THREADS, PLAYBACK_LIMITS, TranscodePool, Transcoder } = await import('../transcode.mjs')
const { CODEC, splitUnits } = await import('../rec-reader.mjs')
const { SegmentWriter } = await import('../segment-writer.mjs')
const { openRecIndex } = await import('../rec-index.mjs')
const rp = await import('../rec-playback.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const info = (line) => console.log(`INFO  ${line}`)
const until = async (pred, ms = 5000) => {
  const t = performance.now()
  while (!pred() && performance.now() - t < ms) await sleep(10)
  return pred()
}
const J = (v) => JSON.stringify(v)
// after the first picture, this long with nothing more is "exactly one"
const QUIET_MS = 1000
const T0 = Date.UTC(2026, 8, 24, 15, 0, 0)

if (!execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString().includes('libx265')) {
  console.log('SKIP  everything: this ffmpeg has no libx265 to make H.265 test footage with')
  process.exit(0)
}

/**
 * Raw Annex B from ffmpeg's test pattern: 10 fps, a keyframe every `gop` frames exactly, no B-frames
 * (the cameras use none: a picture is decoded and shown in the order it arrives), and H.265 without
 * wavefronts (none of the 45 H.265 cameras here uses them; with them low_delay would still decode on
 * several threads, and the decoder's speed would not look like the cameras').
 */
function testVideo({ size, codec = 'h265', frames = 1, gop = 10, rate = 10, noise = false }) {
  const enc = codec === 'h265'
    ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', `log-level=error:keyint=${gop}:min-keyint=${gop}:scenecut=0:open-gop=0:bframes=0:wpp=0`]
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-bf', '0']
  return execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${rate}`,
    // noise: fresh grain in every picture, so every picture is expensive (a rate cap has work to do)
    ...(noise ? ['-vf', 'noise=alls=40:allf=t'] : []),
    '-frames:v', String(frames), ...enc, '-pix_fmt', 'yuv420p',
    '-f', codec === 'h265' ? 'hevc' : 'h264', 'pipe:1'
  ], { maxBuffer: 256 * 1024 * 1024 })
}

/** What ffprobe makes of raw H.264: { codec_name, width, height, nb_read_frames } as strings. */
function probe(buf) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-f', 'h264', '-i', 'pipe:0', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'default=nw=1'
  ], { input: buf }).toString()
  return Object.fromEntries(out.trim().split('\n').map((l) => l.split('=')))
}

/** A real Transcoder (real ffmpeg, niced) whose pictures are collected with their arrival time. */
function converter(inCodec, opts = {}) {
  const frames = []
  const fails = []
  const logs = []
  const t = new Transcoder({
    inCodec,
    encoder: 'libx264',
    ...opts,
    onFrame: (ts, isKey, buf) => frames.push({ ts, isKey, buf, at: performance.now() }),
    onFail: (e) => fails.push(e),
    log: (l) => logs.push(l)
  })
  return { t, frames, fails, logs }
}

// ---- the premise: a lone keyframe with nothing after it --------------------------------------------
{
  const key = testVideo({ size: '640x360' })
  const { t, frames } = converter(CODEC_H265)
  t.push(T0, true, key)
  await sleep(1500)
  info(`without endPicture a lone H.265 keyframe gave ${frames.length} picture(s) in 1.5 s (ffmpeg holds it until the next picture starts)`)
  t.close()
}

// ---- one keyframe pushed and ended: exactly one picture ------------------------------------------------
for (const [label, size, codec, inCodec] of [
  ['H.265 1080p', '1920x1080', 'h265', CODEC_H265],
  ['H.265 4K', '3840x2160', 'h265', CODEC_H265],
  ['H.264 1080p', '1920x1080', 'h264', CODEC_H264]
]) {
  const key = testVideo({ size, codec })
  const units = splitUnits(key, codec === 'h265' ? CODEC.h265 : CODEC.h264).units
  const { t, frames, fails, logs } = converter(inCodec)
  const t0 = performance.now()
  t.push(T0 + 1000, true, key)
  t.endPicture()
  await until(() => frames.length > 0, 10_000)
  await sleep(QUIET_MS)
  const f = frames[0]
  const p = f ? probe(f.buf) : {}
  check(`${label}: one keyframe (${units.length} picture) pushed, then endPicture: exactly one picture out`, units.length === 1 && units[0].isKey && frames.length === 1 && fails.length === 0, `${frames.length} out, ${fails.map((e) => e.message).join(' | ')} ${logs.join(' | ')}`)
  check(`${label}:   a keyframe with the time pushed in`, f?.isKey === true && f.ts === T0 + 1000, f ? `${f.isKey} ${f.ts - T0}` : '-')
  check(`${label}:   it decodes as one ${size} H.264 picture`, p.codec_name === 'h264' && `${p.width}x${p.height}` === size && p.nb_read_frames === '1', J(p))
  if (f) info(`${label}: the converted picture came ${Math.round(f.at - t0)} ms after the push (a fresh ffmpeg each time)`)
  t.close()
  check(`${label}:   close kills ffmpeg`, t.running === false)
}

// ---- playing: every picture comes out, the first keyframe too ------------------------------------------
// ffmpeg reads the first packet to probe the stream; with -fflags nobuffer it threw that packet away,
// so the first keyframe was never decoded: H.265 lost a picture and decoded the rest of the GOP
// against a missing one, H.264 lost the whole GOP, and either way every picture after that was handed
// an earlier picture's time.
for (const [label, codec, inCodec] of [['H.265', 'h265', CODEC_H265], ['H.264', 'h264', CODEC_H264]]) {
  const clip = testVideo({ size: '640x360', codec, frames: 20, gop: 10 })
  const units = splitUnits(clip, codec === 'h265' ? CODEC.h265 : CODEC.h264).units
  const { t, frames, fails } = converter(inCodec)
  units.forEach((u, i) => t.push(T0 + i * 100, u.isKey, clip.subarray(u.start, u.end)))
  t.endPicture() // (the last one would otherwise wait for a next)
  await until(() => frames.length >= units.length, 10_000)
  await sleep(QUIET_MS)
  check(`${label}: ${units.length} pictures pushed (keyframes at 0 and 10), ${units.length} out, each with its own time`, units.length === 20 && frames.length === 20 && frames.every((f, i) => f.ts === T0 + i * 100) && frames[0].isKey && fails.length === 0, `${frames.length} out`)
  t.close()
}

// ---- playing forward without low_delay (smoothness report, cause 2a) -----------------------------------------
// low_delay turns the H.265 decoder's frame threads off: one thread, slower than real time at 4K. Without
// it the decoder runs DECODE_THREADS frame threads, and each thread past the first holds one picture
// back until more arrive: the pictures still all come out, in order, each with its own time.
{
  const clip = testVideo({ size: '640x360', frames: 30, gop: 10 })
  const units = splitUnits(clip, CODEC.h265).units
  const { t, frames, fails } = converter(CODEC_H265, { lowDelay: false })
  units.slice(0, 20).forEach((u, i) => t.push(T0 + i * 100, u.isKey, clip.subarray(u.start, u.end)))
  t.endPicture()
  await until(() => frames.length >= 20, 10_000)
  await sleep(QUIET_MS)
  const held = 20 - frames.length
  check(`without low_delay: 20 pictures pushed and ended, at most ${DECODE_THREADS - 1} held back by the decoder's threads`, held >= 0 && held <= DECODE_THREADS - 1 && fails.length === 0, `${frames.length} out`)
  units.slice(20).forEach((u, i) => t.push(T0 + (20 + i) * 100, u.isKey, clip.subarray(u.start, u.end)))
  t.endPicture()
  await until(() => frames.length >= 30 - held, 10_000)
  await sleep(QUIET_MS)
  check('  the next pictures release them: every picture out, in order, each with its own time', frames.length >= 30 - held && frames.every((f, i) => f.ts === T0 + i * 100) && frames[0].isKey, `${frames.length} out`)
  const p = probe(Buffer.concat(frames.map((f) => f.buf)))
  check('  and they decode', p.codec_name === 'h264' && Number(p.nb_read_frames) === frames.length, J(p))
  t.close()
  check('  close kills ffmpeg', t.running === false)
}
{
  // The speed. Grain in every picture makes the decoder the slow part, as it is with the cameras'
  // 4K; one thread against two should come out near 2x (on real recordings: 23.7 against 43.3 a second).
  const FPS = 20
  const clip = testVideo({ size: '3840x2160', frames: 20, gop: 10, rate: FPS, noise: true })
  const units = splitUnits(clip, CODEC.h265).units
  const rate = async (lowDelay) => {
    const { t, frames } = converter(CODEC_H265, { ...PLAYBACK_LIMITS, lowDelay })
    const t0 = performance.now()
    units.forEach((u, i) => t.push(T0 + i * 50, u.isKey, clip.subarray(u.start, u.end)))
    t.endPicture()
    const want = units.length - (lowDelay ? 0 : DECODE_THREADS - 1)
    await until(() => frames.length >= want, 60_000)
    const s = (frames.at(-1).at - t0) / 1000
    t.close()
    return { n: frames.length, fps: frames.length / s }
  }
  const slow = await rate(true)
  const fast = await rate(false)
  info(`noisy 4K H.265 within PLAYBACK_LIMITS: ${slow.fps.toFixed(1)} pictures/s with low_delay, ${fast.fps.toFixed(1)} without (${(fast.fps / slow.fps).toFixed(2)}x)`)
  check('without low_delay the conversion is clearly faster (at least 1.3x; the margin is for a busy server)', fast.fps >= 1.3 * slow.fps, `${slow.fps.toFixed(1)} -> ${fast.fps.toFixed(1)}`)
}

// ---- two scrubs in a row: each reset kills ffmpeg, and each keyframe still comes out ----------------------
{
  const clip = testVideo({ size: '1280x720', frames: 10, gop: 5 })
  const keys = splitUnits(clip, CODEC.h265).units.filter((u) => u.isKey).map((u) => clip.subarray(u.start, u.end))
  const { t, frames, fails } = converter(CODEC_H265)
  t.push(T0 + 500, true, keys[1])
  t.endPicture()
  await until(() => frames.length > 0, 10_000)
  t.reset()
  t.push(T0, true, keys[0])
  t.endPicture()
  await until(() => frames.length > 1, 10_000)
  await sleep(QUIET_MS)
  check('two scrubs on one converter: one picture for each, in the order asked', keys.length === 2 && J(frames.map((f) => f.ts - T0)) === J([500, 0]) && frames.every((f) => f.isKey) && fails.length === 0, J(frames.map((f) => f.ts - T0)))
  t.close()
}

// ---- playback's limits (PLAYBACK_LIMITS): 4K comes out 1920 wide, and no picture bursts past the buffer ----
// Converted at full size a 4K recording ran slower than real time and came out at ~9 Mbit/s with
// 1.5 MB keyframes (smoothness report, cause 2b).
{
  const FPS = 20
  const clip = testVideo({ size: '3840x2160', frames: 20, gop: 10, rate: FPS, noise: true })
  const units = splitUnits(clip, CODEC.h265).units
  const run = async (opts) => {
    const { t, frames, fails } = converter(CODEC_H265, opts)
    units.forEach((u, i) => t.push(T0 + i * 50, u.isKey, clip.subarray(u.start, u.end)))
    t.endPicture()
    await until(() => frames.length >= units.length, 60_000)
    await sleep(QUIET_MS)
    t.close()
    return { frames, fails, bytes: frames.reduce((s, f) => s + f.buf.length, 0), max: Math.max(0, ...frames.map((f) => f.buf.length)) }
  }
  const capped = await run({ ...PLAYBACK_LIMITS })
  const full = await run({})
  const bufBytes = (PLAYBACK_LIMITS.maxKbps * 1000 * PLAYBACK_LIMITS.bufSeconds) / 8
  // what the cap allows over the clip: the rate for its length plus one full buffer (10% for x264's rounding)
  const allowed = 1.1 * ((PLAYBACK_LIMITS.maxKbps * 1000 * units.length) / FPS / 8 + bufBytes)
  info(`a noisy 4K H.265 clip of ${units.length} pictures: ${Math.round(full.bytes / 1024)} KB converted at full size (largest picture ${Math.round(full.max / 1024)} KB), ${Math.round(capped.bytes / 1024)} KB within PLAYBACK_LIMITS (largest ${Math.round(capped.max / 1024)} KB)`)
  const p = capped.frames.length ? probe(Buffer.concat(capped.frames.map((f) => f.buf))) : {}
  check('PLAYBACK_LIMITS: every picture of a 4K clip comes out, each with its own time', units.length === 20 && capped.frames.length === 20 && capped.frames.every((f, i) => f.ts === T0 + i * 50) && capped.fails.length === 0, `${capped.frames.length} out`)
  check('  scaled to 1920x1080', p.codec_name === 'h264' && p.width === '1920' && p.height === '1080' && p.nb_read_frames === '20', J(p))
  check('  no picture larger than the 1 s buffer at the cap (a keyframe cannot burst past it)', capped.max <= 1.1 * bufBytes, `largest ${capped.max} B, buffer ${bufBytes} B`)
  check('  and the whole clip within the cap', capped.bytes <= allowed, `${capped.bytes} B, allowed ${Math.round(allowed)} B`)
  check('  (the same clip at full size is far bigger: the cap is what held it down)', full.frames.length === 20 && full.bytes > 3 * allowed, `${full.bytes} B`)
}

// ---- keyframes only within PLAYBACK_LIMITS: the cap per second of wall clock ----------------------------
// x264 spends the rate cap as maxKbps / fps per picture, the fps taken from the input's timestamps,
// which the raw demuxer puts one camera frame apart (20 fps here, from the H.265 stream's own timing).
// A keyframe run (reverse, 8x-32x, and 2x-4x while converting) sends at most maxKeysPerS pictures a
// second, so each got a 1x picture's share, 15.6 KB, while the link sat mostly idle: blockier
// pictures in exactly the modes used to scan for an event. Stamped 8 a second (picturesPerS, what
// rec-playback asks for such a run), each gets an eighth of a second's share.
{
  const FPS = 20
  const KEYS = 30
  const PER_S = 8 // rec-playback's maxKeysPerS
  // what a keyframe run pushes: one keyframe per second of footage, stamped at the camera's 20 fps.
  // Only those pictures are encoded (the frames between would never be read), from ffmpeg's busier
  // test pattern; grain makes every picture expensive.
  const keyRun = (grain) => {
    const clip = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=${FPS}`,
      '-vf', [grain ? `noise=alls=${grain}:allf=t` : '', `select=not(mod(n\\,${FPS})),setpts=N/${FPS}/TB`].filter(Boolean).join(','),
      '-frames:v', String(KEYS), '-r', String(FPS), '-c:v', 'libx265', '-preset', 'ultrafast',
      '-x265-params', 'log-level=error:keyint=1:min-keyint=1:scenecut=0:open-gop=0:bframes=0:wpp=0',
      '-pix_fmt', 'yuv420p', '-f', 'hevc', 'pipe:1'
    ], { maxBuffer: 256 * 1024 * 1024 })
    return splitUnits(clip, CODEC.h265).units.map((u) => ({ isKey: u.isKey, buf: clip.subarray(u.start, u.end) }))
  }
  const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1] ?? 0
  const run = async (keys, opts) => {
    const { t, frames, fails } = converter(CODEC_H265, { lowDelay: true, ...opts })
    for (let i = 0; i < keys.length; i++) {
      t.push(T0 + i * 1000, true, keys[i].buf)
      t.endPicture() // as rec-playback's #deliver does for each one
      await sleep(25)
    }
    await until(() => frames.length >= keys.length, 60_000)
    t.close()
    const sizes = frames.map((f) => f.buf.length)
    // the last ten: the buffer's head start (it begins 90% full) is spent by then
    const sum = (a) => a.reduce((s, n) => s + n, 0)
    return { frames, fails, bytes: sum(sizes), tail: median(sizes.slice(-10)), tailMean: sum(sizes.slice(-10)) / 10 }
  }
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`

  const clean = keyRun(0)
  const free = await run(clean, { maxWidth: PLAYBACK_LIMITS.maxWidth })
  const before = await run(clean, { ...PLAYBACK_LIMITS })
  const keyed = await run(clean, { ...PLAYBACK_LIMITS, picturesPerS: PER_S })
  info(`a clean keyframe run of ${KEYS} (1080p, a keyframe a second at 20 fps), last ten pictures' median: ${kb(free.tail)} with no cap, ${kb(before.tail)} capped per camera frame, ${kb(keyed.tail)} stamped ${PER_S} a second`)
  check(`keyframes only, stamped ${PER_S} a second: every keyframe comes out, each with its own time`, clean.length === KEYS && clean.every((k) => k.isKey) && keyed.frames.length === KEYS && keyed.frames.every((f, i) => f.ts === T0 + i * 1000) && keyed.fails.length === 0, `${keyed.frames.length} out`)
  const p = keyed.frames.length ? probe(Buffer.concat(keyed.frames.map((f) => f.buf))) : {}
  check('  and they decode, 1920x1080', p.codec_name === 'h264' && p.width === '1920' && p.height === '1080' && p.nb_read_frames === String(KEYS), J(p))
  check('  (capped per camera frame, as before, the clean clip\'s pictures were squeezed: well under the uncapped size)', before.tail < 0.7 * free.tail, `${kb(before.tail)} vs ${kb(free.tail)}`)
  check('  a clean clip\'s pictures are no smaller than with no cap at all', keyed.tail >= free.tail, `${kb(keyed.tail)} vs ${kb(free.tail)}`)

  const grainy = keyRun(20)
  const gFree = await run(grainy, { maxWidth: PLAYBACK_LIMITS.maxWidth })
  const gKeyed = await run(grainy, { ...PLAYBACK_LIMITS, picturesPerS: PER_S })
  const bufBytes = (PLAYBACK_LIMITS.maxKbps * 1000 * PLAYBACK_LIMITS.bufSeconds) / 8
  // the run takes KEYS / PER_S seconds of wall clock at most pictures a second: the cap over that
  // time plus one full buffer (10% for x264's rounding)
  const allowed = 1.1 * ((PLAYBACK_LIMITS.maxKbps * 1000 * KEYS) / PER_S / 8 + bufBytes)
  const mbit = (bytesPerPicture) => `${((bytesPerPicture * 8 * PER_S) / 1e6).toFixed(2)} Mbit/s`
  info(`a grainy keyframe run of ${KEYS}: ${kb(gFree.bytes)} with no cap, ${kb(gKeyed.bytes)} stamped ${PER_S} a second; at ${PER_S} a second that is ${mbit(gKeyed.bytes / KEYS)} over the run (the first picture from the buffer's head start), ${mbit(gKeyed.tailMean)} over the last ten`)
  check(`  a grainy clip at ${PER_S} a second stays within the cap per second of wall clock`, gKeyed.frames.length === KEYS && gKeyed.bytes <= allowed, `${gKeyed.bytes} B, allowed ${Math.round(allowed)} B`)
  check('  (with no cap it would not: the cap is what held it)', gFree.frames.length === KEYS && gFree.bytes > 2 * allowed, `${gFree.bytes} B`)
}

// ---- the whole path: a recorded .h265 file, ServerPlayback, {scrub} --------------------------------------
{
  const ROOT = mkdtempSync(join(tmpdir(), 'cctv-xcode-ffmpeg-rec-'))
  const IDX = openRecIndex(join(process.env.DATA_DIR, 'recordings.db'))
  const CH = 5
  // 4 s at 10 fps, a keyframe every 1 s
  const clip = testVideo({ size: '1280x720', frames: 40, gop: 10 })
  const units = splitUnits(clip, CODEC.h265).units
  const w = new SegmentWriter({ root: ROOT, nvrId: 'n1', ch: CH, codec: 'h265' })
  const segs = []
  w.on('segment', (s) => segs.push(s))
  units.forEach((u, i) => w.write(clip.subarray(u.start, u.end), { isKey: u.isKey, ts: T0 + i * 100 }))
  await w.close()
  for (const s of segs) IDX.addSegment({ nvr: 'n1', ch: CH, ...s, loc: 'L1' })
  check('footage: 40 H.265 pictures, 4 keyframes, recorded in one .h265 file', units.length === 40 && units.filter((u) => u.isKey).length === 4 && segs.length === 1 && /\.h265$/.test(segs[0].path), `${units.length} ${segs.length}`)

  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, texts: [], log: [], handlers: {} }
  ws.send = (m) => {
    const at = performance.now()
    if (typeof m === 'string') {
      const o = JSON.parse(m)
      ws.texts.push(o)
      ws.log.push({ at, text: o })
      return
    }
    ws.log.push({ at, bin: { key: (m[0] & 1) === 1, codec: m[1], tsMs: Number(m.readBigInt64LE(8)) / 1000, buf: Buffer.from(m.subarray(16)) } })
  }
  ws.on = (event, fn) => (ws.handlers[event] = fn)
  ws.close = () => {
    if (ws.readyState !== 1) return
    ws.readyState = 3
    ws.handlers.close?.()
  }
  const scrub = (t, gen) => ws.handlers.message(Buffer.from(J({ scrub: t, gen })), false)
  /** The frames sent after {type:'scrub', gen} (null: that message has not come). */
  const after = (gen) => {
    const i = ws.log.findIndex((e) => e.text?.type === 'scrub' && e.text.gen === gen)
    return i < 0 ? null : ws.log.slice(i + 1).filter((e) => e.bin)
  }
  const nvr = { id: 'n1', name: 'NVR n1', online: true, playback: { connect: () => { throw new Error('the NVR must not be used') } } }
  const url = new URL(`ws://x/playback?nvr=n1&ch=${CH}&stream=0&start=${T0}&src=auto&h265=0`)
  let xc = null
  const logs = []
  const spawned = [] // every ffmpeg's arguments, to see which ran with low_delay
  const spy = (o) => new Transcoder({ ...o, encoder: 'libx264', spawn: (bin, args, opt) => (spawned.push(args.join(' ')), spawn(bin, args, opt)) })
  const session = rp.connectPlayback({
    nvr, ws, url, who: { user: 'admin', admin: true }, index: IDX, legs: null,
    opts: { pool: new TranscodePool(2), makeTranscoder: (o) => (xc = spy(o)), log: (l) => logs.push(l) }
  })
  // straight away, as a drag does: the start is dropped before it has read anything
  const t1 = performance.now()
  scrub(T0 + 2500, 1)
  await until(() => (after(1)?.length ?? 0) > 0, 10_000)
  const got1 = performance.now() - t1
  await sleep(QUIET_MS)
  const s1 = ws.texts.find((m) => m.type === 'scrub' && m.gen === 1)
  const f1 = after(1) ?? []
  check('scrub over converted footage: {type:"scrub", gen 1} at the keyframe before T, then exactly one frame', Boolean(s1) && !s1.none && s1.at <= T0 + 2500 && s1.at > T0 + 1500 && f1.length === 1, `${J(s1)}, ${f1.length} frames ${logs.join(' | ')}`)
  check('  it is converted: H.264, a keyframe, at the time the scrub announced', f1[0]?.bin.codec === 0 && f1[0].bin.key && Math.abs(f1[0].bin.tsMs - s1?.at) < 0.001, f1[0] ? `${f1[0].bin.codec} ${f1[0].bin.key} ${f1[0].bin.tsMs - s1?.at}` : '-')
  const p1 = f1[0] ? probe(f1[0].bin.buf) : {}
  check('  and it decodes: one 1280x720 H.264 picture', p1.codec_name === 'h264' && p1.width === '1280' && p1.height === '720' && p1.nb_read_frames === '1', J(p1))
  if (f1.length) info(`the scrub's converted picture reached the socket ${Math.round(got1)} ms after {scrub} (the page waits at most 1500 ms)`)

  scrub(T0 + 450, 2)
  await until(() => (after(2)?.length ?? 0) > 0, 10_000)
  await sleep(QUIET_MS)
  const s2 = ws.texts.find((m) => m.type === 'scrub' && m.gen === 2)
  const f2 = after(2) ?? []
  check('a second scrub (the drag goes on): exactly one converted keyframe for gen 2, at its time', Boolean(s2) && f2.length === 1 && f2[0].bin.codec === 0 && f2[0].bin.key && Math.abs(f2[0].bin.tsMs - s2.at) < 0.001, `${J(s2)}, ${f2.length} frames`)
  check('  each scrub ran its own ffmpeg, with low_delay (frame threads would hold its keyframe back)', spawned.length === 2 && spawned.every((a) => a.includes('-flags low_delay') && !a.includes('-threads')), spawned.join(' | '))
  check('  and stamped 8 a second (one picture at a time): its one picture still comes out, above', spawned.length === 2 && spawned.every((a) => a.includes(' -r 8 -f hevc -i pipe:0')), spawned.join(' | '))
  session.close()
  check('close: the conversion is closed and its ffmpeg killed', session.xcode === null && xc?.running === false)

  /** A playback of the recording from T0, converted (&h265=0), at `speed`: its binary frames with their arrival time. */
  const play = (speed) => {
    const sock = { OPEN: 1, readyState: 1, bufferedAmount: 0, bins: [], handlers: {} }
    sock.send = (m) => {
      if (typeof m !== 'string') sock.bins.push({ at: performance.now(), key: (m[0] & 1) === 1, codec: m[1], tsMs: Number(m.readBigInt64LE(8)) / 1000, buf: Buffer.from(m.subarray(16)) })
    }
    sock.on = (event, fn) => (sock.handlers[event] = fn)
    sock.close = () => {
      if (sock.readyState !== 1) return
      sock.readyState = 3
      sock.handlers.close?.()
    }
    sock.t0 = performance.now()
    const s = rp.connectPlayback({
      nvr, ws: sock, url, who: { user: 'admin', admin: true }, index: IDX, legs: null,
      opts: { pool: new TranscodePool(2), makeTranscoder: spy, log: () => {} }
    })
    if (speed !== 1) sock.handlers.message(Buffer.from(J({ speed })), false) // as the page does when the socket opens
    return { sock, s }
  }
  {
    // 1x: forward, without low_delay; every picture but the last one or two, which wait in ffmpeg for
    // a next picture that never comes (the footage ends): one in the parser, one in the second thread
    spawned.length = 0
    const { sock, s } = play(1)
    await until(() => sock.bins.length >= units.length - DECODE_THREADS, 15_000)
    await sleep(QUIET_MS)
    const bins = sock.bins
    check('playing converted footage at 1x: every picture but the last one or two, converted, each at its own time, in order', bins.length >= units.length - DECODE_THREADS && bins.every((b, i) => b.codec === 0 && Math.abs(b.tsMs - (T0 + i * 100)) < 1) && bins[0].key, `${bins.length} of ${units.length}: ${bins.slice(0, 3).map((b) => b.tsMs - T0).join()}`)
    check(`  its ffmpeg ran without low_delay, on ${DECODE_THREADS} decoder threads`, spawned.length === 1 && !spawned[0].includes('low_delay') && spawned[0].includes(`-threads ${DECODE_THREADS} `), spawned.join(' | '))
    check('  with the recording\'s own timestamps (no -r)', spawned.length === 1 && !spawned[0].includes(' -r '), spawned.join(' | '))
    const p = bins.length ? probe(Buffer.concat(bins.map((b) => b.buf))) : {}
    check('  and it decodes: 1280x720 H.264, every picture sent', p.codec_name === 'h264' && p.width === '1280' && p.height === '720' && Number(p.nb_read_frames) === bins.length, J(p))
    s.close()
  }
  {
    // 2x (keyframes only while converting, one a second of footage: every 500 ms): with low_delay,
    // each keyframe ended at once, so none waits for the next one
    spawned.length = 0
    const { sock, s } = play(2)
    await until(() => sock.bins.length >= 3, 10_000)
    await sleep(QUIET_MS)
    const keys = sock.bins.slice(0, 3)
    // (one ffmpeg converts them all, so after the first the encoder codes each as a change from the
    // one before, as it does for 8x-32x and reverse: the first is the only H.264 keyframe)
    check('playing converted footage at 2x: the recording\'s keyframes only, converted, each at its own time', keys.length === 3 && keys[0].key && keys.every((b, i) => b.codec === 0 && Math.abs(b.tsMs - (T0 + i * 1000)) < 1), keys.map((b) => `${b.key}@${b.tsMs - T0}`).join())
    const first = keys[0] ? keys[0].at - sock.t0 : Infinity
    info(`at 2x the first converted keyframe was out ${Math.round(first)} ms after the start, then every ${keys.slice(1).map((b, i) => Math.round(b.at - keys[i].at)).join(', ')} ms`)
    // held until the next keyframe it would have come 500 ms later: after a fresh ffmpeg's ~300 ms, about 800 ms
    check('  not held for the next keyframe: the first one out within 650 ms of the start', first < 650, `${Math.round(first)} ms`)
    check('  its ffmpeg ran with low_delay', spawned.length >= 1 && spawned[0].includes('-flags low_delay'), spawned.join(' | '))
    check('  its pictures stamped maxKeysPerS (8) a second, so the rate cap is shared by the pictures that really go', spawned.length >= 1 && spawned[0].includes(' -r 8 -f hevc -i pipe:0'), spawned.join(' | '))
    s.close()
  }
  IDX.close()
}

// ---- a remote viewer: the whole path, H.264 then H.265, within PLAYBACK_LIMITS (smoothness report, cause 3) ----
// Through the tunnel every frame goes through the conversion, H.264 as well (rec-playback.mjs
// `remote`), so a busy main stream fits one tunnel connection. A recording whose codec changes
// between two files restarts ffmpeg for the new codec on that file's first keyframe (#transcode): the
// pictures after the switch must come out too. Lost at the switch: the one or two inside the old
// ffmpeg (its parser and its second decoder thread) and at most one out of it but not yet proved whole.
{
  const ROOT = mkdtempSync(join(tmpdir(), 'cctv-xcode-ffmpeg-remote-'))
  const IDX = openRecIndex(join(process.env.DATA_DIR, 'recordings-remote.db'))
  const CH = 6
  const FPS = 20
  const N = 60 // 3 s a file, a keyframe a second
  let n = 0
  const parts = []
  for (const [codec, rc] of [['h264', CODEC.h264], ['h265', CODEC.h265]]) {
    // grain in every picture: 2560x1440 recorded far above the cap, so the cap has work to do
    const clip = testVideo({ size: '2560x1440', codec, frames: N, gop: FPS, rate: FPS, noise: true })
    const units = splitUnits(clip, rc).units
    const w = new SegmentWriter({ root: ROOT, nvrId: 'n1', ch: CH, codec })
    const segs = []
    w.on('segment', (s) => segs.push(s))
    const times = []
    for (const u of units) {
      const ts = T0 + n++ * (1000 / FPS)
      times.push(ts)
      w.write(clip.subarray(u.start, u.end), { isKey: u.isKey, ts })
      if (w.queueStatus().queuedBytes > 1 << 20) await w.drained()
    }
    await w.close()
    for (const s of segs) IDX.addSegment({ nvr: 'n1', ch: CH, ...s, loc: 'L1' })
    parts.push({ codec, units, times, bytes: clip.length, segs })
  }
  check('footage: an H.264 file, then an H.265 one straight after it, 60 pictures each', parts.every((p) => p.units.length === N && p.segs.length === 1) && /\.h264$/.test(parts[0].segs[0].path) && /\.h265$/.test(parts[1].segs[0].path), parts.map((p) => `${p.units.length} ${p.segs.length}`).join(' | '))

  const sock = { OPEN: 1, readyState: 1, bufferedAmount: 0, bins: [], texts: [], handlers: {} }
  sock.send = (m) => {
    if (typeof m === 'string') return sock.texts.push(JSON.parse(m))
    sock.bins.push({ at: performance.now(), key: (m[0] & 1) === 1, codec: m[1], tsMs: Number(m.readBigInt64LE(8)) / 1000, buf: Buffer.from(m.subarray(16)) })
  }
  sock.on = (event, fn) => (sock.handlers[event] = fn)
  sock.close = () => {
    if (sock.readyState !== 1) return
    sock.readyState = 3
    sock.handlers.close?.()
  }
  const spawned = []
  const nvr = { id: 'n1', name: 'NVR n1', online: true, playback: { connect: () => { throw new Error('the NVR must not be used') } } }
  const s = rp.connectPlayback({
    nvr, ws: sock, url: new URL(`ws://x/playback?nvr=n1&ch=${CH}&stream=0&start=${T0}&src=auto&h265=1`), who: { user: 'admin', admin: true }, index: IDX, legs: null, remote: true,
    opts: { pool: new TranscodePool(2), makeTranscoder: (o) => new Transcoder({ ...o, spawn: (bin, args, opt) => (spawned.push(args.join(' ')), spawn(bin, args, opt)) }), log: () => {} }
  })
  const switchTs = parts[1].times[0]
  const t0 = performance.now()
  await until(() => sock.bins.filter((b) => b.tsMs >= switchTs).length >= N - DECODE_THREADS, 30_000)
  await sleep(QUIET_MS)
  s.close()
  const a = sock.bins.filter((b) => b.tsMs < switchTs)
  const b = sock.bins.filter((b) => b.tsMs >= switchTs)
  const lost = N - a.length
  check('remote, played at 1x: the page is told it is converted to fit ({type:"fit", on:true})', sock.texts.some((t) => t.type === 'fit' && t.on === true), J(sock.texts.filter((t) => t.type === 'fit')))
  check('  every picture sent is H.264, each at a recorded time, in order', sock.bins.length > 0 && sock.bins.every((f, i) => f.codec === 0 && (i === 0 || f.tsMs > sock.bins[i - 1].tsMs)) && sock.bins.every((f) => parts.some((p) => p.times.some((t) => Math.abs(t - f.tsMs) < 0.5))), `${sock.bins.length} pictures`)
  check(`  the H.264 file: converted, its first picture a keyframe, at most ${DECODE_THREADS + 1} lost at the switch`, a.length > 0 && a[0].key && Math.abs(a[0].tsMs - T0) < 0.5 && lost >= 0 && lost <= DECODE_THREADS + 1, `${a.length} of ${N}`)
  check(`  the H.265 file after it: converted from its first keyframe on, all but the last ${DECODE_THREADS} at most (held in ffmpeg at the end)`, b.length >= N - DECODE_THREADS && b[0].key && Math.abs(b[0].tsMs - switchTs) < 0.5, `${b.length} of ${N}, first at ${b[0]?.tsMs - switchTs}`)
  check('  two ffmpegs: one reading H.264, then one reading H.265', spawned.length === 2 && spawned[0].includes(' -f h264 -i pipe:0') && spawned[1].includes(' -f hevc -i pipe:0'), spawned.map((x) => x.slice(x.indexOf(' -f '), x.indexOf(' -i ') + 3)).join(' | '))
  const pa = a.length ? probe(Buffer.concat(a.map((f) => f.buf))) : {}
  const pb = b.length ? probe(Buffer.concat(b.map((f) => f.buf))) : {}
  check('  both parts decode, 1920x1080 (at most 1920 wide), every picture sent', pa.width === '1920' && pa.height === '1080' && Number(pa.nb_read_frames) === a.length && pb.width === '1920' && pb.height === '1080' && Number(pb.nb_read_frames) === b.length, `${J(pa)} ${J(pb)}`)
  const bufBytes = (PLAYBACK_LIMITS.maxKbps * 1000 * PLAYBACK_LIMITS.bufSeconds) / 8
  const secs = (N / FPS) * 2
  const allowed = 1.1 * ((PLAYBACK_LIMITS.maxKbps * 1000 * secs) / 8 + 2 * bufBytes) // (each ffmpeg starts with a full buffer)
  const sent = sock.bins.reduce((sum, f) => sum + f.buf.length, 0)
  const recorded = parts.reduce((sum, p) => sum + p.bytes, 0)
  const mbit = (bytes) => ((bytes * 8) / secs / 1e6).toFixed(2)
  info(`remote viewer, grainy 2560x1440 at 20 fps: recorded ${mbit(recorded)} Mbit/s, sent ${mbit(sent)} Mbit/s converted; the first picture out ${Math.round(sock.bins[0]?.at - t0)} ms after the start; ${lost} lost at the codec switch`)
  check('  what is sent stays within the cap (2.5 Mbit/s and a 1 s buffer per ffmpeg)', sent <= allowed, `${sent} B, allowed ${Math.round(allowed)} B`)
  check('  (the recording itself is far above it: the conversion is what holds the rate down)', recorded > 3 * allowed, `${recorded} B`)
  IDX.close()
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
