// The real ffmpeg behind the H.265 -> H.264 playback conversion (transcode.mjs). ffmpeg is installed
// on the server only, so this runs there. It proves what the fake ffmpeg in transcode.test.mjs cannot:
// that a scrub's picture comes out at all. A scrub pushes one keyframe into a fresh ffmpeg and then
// nothing more, and ffmpeg's raw HEVC/H.264 parser holds a picture until the next one starts, so the
// keyframe never came out and a browser without HEVC showed the old picture for the whole drag.
// Transcoder.endPicture() writes an access unit delimiter after it, which ends the picture.
//   - one keyframe from ffmpeg's own test pattern (H.265 at 1080p and 4K, H.264 at 1080p), pushed and
//     ended: exactly one H.264 picture comes back, with the keyframe's time, and it decodes;
//   - two scrubs in a row on one converter (a reset between them, as every scrub does);
//   - the whole path: a recorded .h265 file, ServerPlayback with &h265=0, {scrub}: one converted
//     frame on the socket after {type:'scrub'}, for each of two scrubs.
// ffmpeg runs behind ionice and nice here exactly as in the service. Nothing reaches an NVR.
//   node cctv/test/transcode-ffmpeg.test.mjs        (on the server copy)
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-xcode-ffmpeg-test-'))
const { CODEC_H264, CODEC_H265, TranscodePool, Transcoder } = await import('../transcode.mjs')
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
 * (the cameras use none: a picture is decoded and shown in the order it arrives).
 */
function testVideo({ size, codec = 'h265', frames = 1, gop = 10 }) {
  const enc = codec === 'h265'
    ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', `log-level=error:keyint=${gop}:min-keyint=${gop}:scenecut=0:open-gop=0:bframes=0`]
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-bf', '0']
  return execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=10`,
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
function converter(inCodec) {
  const frames = []
  const fails = []
  const logs = []
  const t = new Transcoder({
    inCodec,
    encoder: 'libx264',
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
  const session = rp.connectPlayback({
    nvr, ws, url, who: { user: 'admin', admin: true }, index: IDX, legs: null,
    opts: { pool: new TranscodePool(2), makeTranscoder: (o) => (xc = new Transcoder({ ...o, encoder: 'libx264' })), log: (l) => logs.push(l) }
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
  session.close()
  check('close: the conversion is closed and its ffmpeg killed', session.xcode === null && xc?.running === false)
  IDX.close()
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
