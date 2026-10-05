// The start of a converted server playback with the real ffmpeg (rec-playback.mjs; the playback hunt
// of 1 Oct 2026, finding F3). ffmpeg is installed on the server only, so this runs there, on a copy.
// What the stand-ins in rec-playback.test.mjs cannot prove: that the real converter, which keeps
// pictures inside until more go in, gives back the frame the pacer waits for, and that the frames
// then reach the socket at the footage's own rate from the first second.
//   - the premise of CONVERTER_HOLDS: handed four frames and no more, a conversion playing forward
//     (no low_delay, PLAYBACK_LIMITS) gives the first back; handed two, nothing. H.265 and H.264;
//   - the whole path, a recorded test clip (ffmpeg's own test pattern with grain, 2560x1440 at 20 fps,
//     never the production store), ServerPlayback and the real Transcoder:
//       H.265 for a browser without it, a start mid-GOP, then a seek on the same socket;
//       the same, a start on a keyframe (no preroll: the first picture needs the frames after it);
//       H.264 for a remote viewer, a start mid-GOP.
//     From the first frame at the start point on: 20 frames in every second, none more than 150 ms
//     ahead of its media time, every frame in order with its own time, and no wait run out.
// Before the fix the same runs gave the traced shape (frames a second 14, 30, 31, 20): the pacer
// went on at 1x while ffmpeg started, and what it had been handed came out in a rush.
// ffmpeg runs behind ionice and nice here exactly as in the service. Nothing reaches an NVR.
//   node cctv/test/rec-playback-ffmpeg.test.mjs        (on the server copy)
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-pb-ffmpeg-test-'))
const { CODEC_H264, CODEC_H265, PLAYBACK_LIMITS, TranscodePool, Transcoder } = await import('../transcode.mjs')
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
const T0 = Date.UTC(2026, 8, 24, 15, 0, 0)
const FPS = 20
const STEP = 1000 / FPS
const GOP = 2 * FPS // a keyframe every 2 s, as the cameras' mains
const SECONDS = 12

if (!execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString().includes('libx265')) {
  console.log('SKIP  everything: this ffmpeg has no libx265 to make H.265 test footage with')
  process.exit(0)
}

/**
 * Raw Annex B from ffmpeg's test pattern with grain in every picture, held to a camera's bitrate: no
 * B-frames (the cameras use none), a keyframe every GOP frames exactly, H.265 without wavefronts
 * (transcode-ffmpeg.test.mjs testVideo, the same footage).
 */
function testVideo(codec, frames, size = '2560x1440', kbps = 3000) {
  const enc = codec === 'h265'
    ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', `log-level=error:keyint=${GOP}:min-keyint=${GOP}:scenecut=0:open-gop=0:bframes=0:wpp=0:bitrate=${kbps}:vbv-maxrate=${kbps}:vbv-bufsize=${2 * kbps}`]
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', String(GOP), '-keyint_min', String(GOP), '-sc_threshold', '0', '-bf', '0', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${2 * kbps}k`]
  return execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${FPS}`,
    '-vf', 'noise=alls=12:allf=t', '-frames:v', String(frames), ...enc, '-pix_fmt', 'yuv420p',
    '-f', codec === 'h265' ? 'hevc' : 'h264', 'pipe:1'
  ], { maxBuffer: 512 * 1024 * 1024 })
}

const clips = {}
for (const codec of ['h265', 'h264']) {
  const clip = testVideo(codec, SECONDS * FPS)
  const units = splitUnits(clip, CODEC[codec]).units
  clips[codec] = { clip, units, frame: (i) => clip.subarray(units[i].start, units[i].end) }
  check(`footage: ${SECONDS} s of ${codec === 'h265' ? 'H.265' : 'H.264'} at ${FPS} fps, a keyframe every 2 s`, units.length === SECONDS * FPS && units.every((u, i) => u.isKey === (i % GOP === 0)), `${units.length} pictures, ${units.filter((u) => u.isKey).length} keyframes, ${(clip.length * 8 / SECONDS / 1e6).toFixed(1)} Mbit/s`)
}

// ---- the premise: what a conversion playing forward gives back, handed a few frames and no more ----
// ffmpeg keeps one picture in its parser and one in its second decoder thread, and the Transcoder
// the last one out until the next proves it whole (or 150 ms pass): so the pacer hands a starting
// converter three frames past the start point (rec-playback.mjs CONVERTER_HOLDS), and waits.
for (const [label, codec, inCodec] of [['H.265', 'h265', CODEC_H265], ['H.264', 'h264', CODEC_H264]]) {
  const handed = async (n) => {
    const out = []
    const t = new Transcoder({ inCodec, ...PLAYBACK_LIMITS, lowDelay: false, onFrame: (ts) => out.push({ ts, at: performance.now() }), log: () => {} })
    const t0 = performance.now()
    for (let i = 0; i < n; i++) t.push(T0 + i * STEP, clips[codec].units[i].isKey, clips[codec].frame(i))
    await until(() => out.length > 0, 6000)
    const first = out.length ? out[0].at - t0 : null
    await sleep(600) // (well past the Transcoder's 150 ms)
    t.close()
    return { out, first }
  }
  const two = await handed(2)
  const four = await handed(4)
  check(`${label}, playing forward: handed 2 frames and no more, the conversion gives nothing back`, two.out.length === 0, `${two.out.length} out`)
  check(`${label}:   handed 4, it gives the first back (and at most one more, held until 150 ms had passed)`, four.out.length >= 1 && four.out.length <= 2 && four.out[0].ts === T0, `${four.out.length} out, the first ${four.first === null ? '-' : Math.round(four.first)} ms after they went in`)
}

// ---- the whole path: recorded clips, ServerPlayback, the real Transcoder ---------------------------------
const ROOT = mkdtempSync(join(tmpdir(), 'cctv-pb-ffmpeg-rec-'))
const IDX = openRecIndex(join(process.env.DATA_DIR, 'recordings.db'))
const CH = { h265: 0, h264: 1 }
for (const codec of ['h265', 'h264']) {
  const w = new SegmentWriter({ root: ROOT, nvrId: 'n1', ch: CH[codec], codec })
  const segs = []
  w.on('segment', (s) => segs.push(s))
  for (let i = 0; i < clips[codec].units.length; i++) {
    w.write(clips[codec].frame(i), { isKey: clips[codec].units[i].isKey, ts: T0 + i * STEP })
    if (w.queueStatus().queuedBytes > 1 << 20) await w.drained()
  }
  await w.close()
  for (const s of segs) IDX.addSegment({ nvr: 'n1', ch: CH[codec], ...s, loc: 'L1' })
  check(`recorded: one .${codec} file`, segs.length === 1 && segs[0].path.endsWith(`.${codec}`), `${segs.length} files`)
}

const nvr = { id: 'n1', name: 'NVR n1', online: true, playback: { connect: () => { throw new Error('the NVR must not be used') } } }
/** A server playback on a fake socket, its converter watched: what went in and what came out, and when. */
function open(codec, start, { remote = false, h265 = '0' } = {}) {
  const sock = { OPEN: 1, readyState: 1, bufferedAmount: 0, bins: [], texts: [], log: [], handlers: {} }
  sock.send = (m) => {
    const at = performance.now()
    if (typeof m === 'string') {
      const o = JSON.parse(m)
      sock.texts.push(o)
      sock.log.push({ at, text: o })
      return
    }
    const f = { at, key: (m[0] & 1) === 1, codec: m[1], tsMs: Number(m.readBigInt64LE(8)) / 1000 }
    sock.bins.push(f)
    sock.log.push({ at, bin: f })
  }
  sock.on = (event, fn) => (sock.handlers[event] = fn)
  sock.close = () => {
    if (sock.readyState !== 1) return
    sock.readyState = 3
    sock.handlers.close?.()
  }
  const x = { in: [], out: [], runs: 0 }
  const logs = []
  const makeTranscoder = (o) => {
    const t = new Transcoder({ ...o, onFrame: (ts, isKey, buf) => { x.out.push({ ts, at: performance.now(), run: x.runs }); o.onFrame(ts, isKey, buf) } })
    const push = t.push.bind(t)
    const reset = t.reset.bind(t)
    t.push = (ts, isKey, buf) => { x.in.push({ ts, at: performance.now(), run: x.runs }); push(ts, isKey, buf) }
    t.reset = () => { x.runs++; reset() }
    return t
  }
  const url = new URL(`ws://x/playback?nvr=n1&ch=${CH[codec]}&stream=0&start=${start}&src=auto&h265=${h265}`)
  sock.t0 = performance.now()
  const s = rp.connectPlayback({ nvr, ws: sock, url, who: { user: 'admin', admin: true }, index: IDX, legs: null, remote, opts: { fitAboveKbps: 0, pool: new TranscodePool(2), makeTranscoder, log: (l) => logs.push(l) } })
  return { sock, s, x, logs }
}
/** The frames sent after {type:'started', gen}. */
const after = (sock, gen) => {
  const i = sock.log.findIndex((e) => e.text?.type === 'started' && e.text.gen === gen)
  return i < 0 ? [] : sock.log.slice(i + 1).filter((e) => e.bin).map((e) => e.bin)
}
/** Frames in each whole second from `from` (a wall time), `n` seconds. */
const perSecond = (bins, from, n) => Array.from({ length: n }, (_, k) => bins.filter((b) => b.at >= from + k * 1000 && b.at < from + (k + 1) * 1000).length)
/** How far ahead of its media time a frame after `first` was sent at most, with `first` as the clock (ms). */
const maxLead = (bins, first) => Math.max(0, ...bins.filter((b) => b.at > first.at).map((b) => b.tsMs - first.tsMs - (b.at - first.at)))

/**
 * One start (or seek) at T, watched for `secs` seconds from the first frame at T: the checks.
 * frames: the frames sent for it; x, run: its converter's log; t0: when it was asked for.
 */
async function judge(label, { sock, x, logs }, T, gen, run, t0, secs) {
  const frames = () => after(sock, gen)
  await until(() => frames().some((b) => b.tsMs >= T), 15_000)
  const first = frames().find((b) => b.tsMs >= T)
  if (!first) return check(`${label}: a frame at the start point reaches the socket`, false, `${frames().length} frames; ${logs.join(' | ')}`)
  await until(() => performance.now() >= first.at + secs * 1000 + 100, secs * 1000 + 1000)
  const bins = frames()
  const k0 = Math.round((bins[0].tsMs - T0) / STEP)
  const pre = bins.filter((b) => b.tsMs < T).length
  const rate = perSecond(bins, first.at, secs)
  const lead = maxLead(bins.filter((b) => b.at < first.at + secs * 1000), first)
  const ins = x.in.filter((p) => p.run === run)
  const outs = x.out.filter((p) => p.run === run)
  const atFirst = ins.filter((p) => p.at <= outs[0]?.at).length
  info(`${label}: ${perSecond(bins, t0, secs + 2).join(' ')} frames in each second from the start (${pre} of them the preroll); the converter's first picture ${Math.round(outs[0]?.at - ins[0]?.at)} ms after its first frame, with ${atFirst} frames in; the first frame at the start point on the socket ${Math.round(first.at - t0)} ms after the start`)
  check(`${label}: from the first frame at the start point, ${FPS} frames in every second (+-2), ${secs} s`, rate.every((n) => Math.abs(n - FPS) <= 2), rate.join(' '))
  check(`${label}:   none sent more than 150 ms ahead of its media time`, lead <= 150, `${Math.round(lead)} ms ahead at most`)
  check(`${label}:   H.264 from the keyframe at or before the start point, every frame in order with its own time`, bins[0].key && bins[0].tsMs <= T && k0 % GOP === 0 && T - bins[0].tsMs < GOP * STEP && bins.every((b, j) => b.codec === 0 && Math.abs(b.tsMs - (T0 + (k0 + j) * STEP)) < 0.5), `${bins.length} frames from ${bins[0].tsMs - T0} ms`)
  check(`${label}:   the converter was handed the frames up to the start point and 3 more, and nothing until it gave the one at the start point back`, atFirst === pre + (bins.some((b) => b.tsMs === T) ? 1 : 0) + 3 && ins[atFirst]?.at >= bins[atFirst - 4]?.at - 1, `${atFirst} in before its first picture; the next went in ${Math.round(ins[atFirst]?.at - bins[atFirst - 4]?.at)} ms after frame ${atFirst - 3} came out`)
  check(`${label}:   no wait run out`, !logs.some((l) => /gave no picture/.test(l)), logs.join(' | '))
}

{
  // H.265 for a browser that cannot decode it (the site PC): a start 1 s into a GOP, then a seek
  const T = T0 + 2000 + 1000
  const o = open('h265', T)
  await judge('H.265 for a browser without it, a start mid-GOP', o, T, 0, 0, o.sock.t0, 5)
  const T2 = T0 + 8000 + 500
  const t2 = performance.now()
  o.sock.handlers.message(Buffer.from(J({ seek: T2, gen: 1 })), false)
  await judge('  then a seek on the same socket', o, T2, 1, 1, t2, 2)
  o.s.close()
}
{
  // a start on a keyframe: no preroll, and the keyframe comes out only once three more frames are in
  const T = T0 + 4000
  const o = open('h265', T)
  await judge('H.265, a start on a keyframe', o, T, 0, 0, o.sock.t0, 4)
  o.s.close()
}
{
  // H.264 over the cap for a remote viewer (through the tunnel every frame is converted to fit)
  const T = T0 + 2000 + 1000
  const o = open('h264', T, { remote: true, h265: '1' })
  await judge('H.264 for a remote viewer, a start mid-GOP', o, T, 0, 0, o.sock.t0, 4)
  check('  (the page was told it is converted to fit)', o.sock.texts.some((t) => t.type === 'fit' && t.on === true), J(o.sock.texts.filter((t) => t.type === 'fit')))
  o.s.close()
}
IDX.close()

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
