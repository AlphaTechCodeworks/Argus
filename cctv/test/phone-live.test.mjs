// Tests live video thinned for phones (phone-live.mjs), with a fake converter: no ffmpeg needed.
//   node cctv/test/phone-live.test.mjs
import { PhoneLive, PhoneStream, encodeFrame, frameRate, gopFor, isPhoneRequest, keepEveryFor, parseFrame } from '../phone-live.mjs'
import { TranscodePool, ffmpegArgs } from '../transcode.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

// ---- who is a phone ----
check('Android Chrome (client hint) is a phone', isPhoneRequest({ 'sec-ch-ua-mobile': '?1' }))
check('desktop Chrome (client hint) is not, whatever else', !isPhoneRequest({ 'sec-ch-ua-mobile': '?0', 'user-agent': 'Android Mobile' }))
check('iPhone Safari by its user agent', isPhoneRequest({ 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148' }))
check('a Windows laptop is not', !isPhoneRequest({ 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0' }))

// ---- how many frames to keep ----
check('30 fps -> keep 1 in 2', keepEveryFor(30) === 2)
check('25 fps -> keep 1 in 2', keepEveryFor(25) === 2)
check('15 fps and under -> every frame', keepEveryFor(15) === 1 && keepEveryFor(10) === 1)
check('60 fps -> 1 in 4', keepEveryFor(60) === 4)
check('frame rate from capture times', Math.abs(frameRate([0, 40, 80, 120]) - 25) < 0.01)
check('ffmpeg keeps 1 in 2 and scales down', ffmpegArgs({ keepEvery: 2, maxWidth: 1280 }).join(' ').includes('select=not(mod(n\\,2)),scale=min(1280\\,iw):-2'))
{
  const f = parseFrame(encodeFrame(Buffer.from([0, 0, 0, 1, 0x65]), true, 1, 1234.5))
  check('frames round-trip through the wire format', f.isKey && f.codec === 1 && Math.abs(f.ts - 1234.5) < 0.01 && f.payload.length === 5)
}

// ---- the shared stream ----
function fakeSource() {
  return { viewers: new Set(), add(ws) { this.viewers.add(ws) }, remove(ws) { this.viewers.delete(ws) },
    emit(buf) { for (const v of this.viewers) v.send(buf) } }
}
function fakeWs() {
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, got: [], handlers: {}, send(b) { this.got.push(b) }, on(e, f) { this.handlers[e] = f }, close() { this.readyState = 3 } }
  return ws
}
const made = []
const makeTranscoder = (o) => {
  const x = { o, pushed: [], closed: false, push(ts, k, p) { this.pushed.push(ts); if (this.pushed.length % o.keepEvery === 1 || o.keepEvery === 1) o.onFrame(ts, k, Buffer.from([1])) }, close() { this.closed = true } }
  made.push(x)
  return x
}
{
  const pool = new TranscodePool(1)
  const live = new PhoneLive({ pool, makeTranscoder, log: () => {} })
  const src = fakeSource()
  const a = fakeWs(), b = fakeWs()
  check('a phone is attached to the thinned stream', live.attach('n1/0/0', src, 0, a))
  check('a second phone on the same camera shares it (no second slot)', live.attach('n1/0/0', src, 0, b) && pool.active === 1)
  check('the thinned stream is one more viewer of the normal one', src.viewers.size === 1)
  // 30 fps main stream: 12 frames to learn the rate, then a keyframe starts the conversion
  for (let i = 0; i < 12; i++) src.emit(encodeFrame(Buffer.from([0, 0, 1, 1]), i === 0, 1, i * 33.3))
  check('nothing converted while learning the frame rate', made.length === 0)
  for (let i = 12; i < 24; i++) src.emit(encodeFrame(Buffer.from([0, 0, 1, 1]), i === 12, 1, i * 33.3))
  const x = made[0]
  check('then one conversion, 1 in 2 kept, H.265 in, main scaled to 1280', x && x.o.keepEvery === 2 && x.o.inCodec === 1 && x.o.maxWidth === 1280, JSON.stringify(x?.o && { k: x.o.keepEvery, c: x.o.inCodec, w: x.o.maxWidth }))
  // a phone on the local network keeps the ffmpeg it always had: the remote viewers' settings below
  // (a 1 s buffer, two decoder threads, a keyframe every 2 s) are theirs alone
  const phoneArgs = ffmpegArgs(x.o).join(' ')
  check('a phone\'s conversion is unchanged: low_delay, a 4 s buffer at 2.5 Mbit/s, a keyframe every 50 pictures', phoneArgs.includes('-flags low_delay') && !phoneArgs.includes('-threads') && phoneArgs.includes('-maxrate 2500k -bufsize 10000k') && / -g 50 /.test(phoneArgs) && phoneArgs.includes('-crf 25'), phoneArgs)
  check('both phones get the converted frames', a.got.length > 0 && a.got.length === b.got.length && parseFrame(a.got[0]).codec === 0)
  const c = fakeWs()
  check('the cap reached for another camera: false, so it gets the normal stream', !live.attach('n1/1/0', fakeSource(), 0, c))
  a.handlers.close(); b.handlers.close()
  const s = live.streams.get('n1/0/0')
  s.close()
  check('the last phone gone: conversion killed, slot freed, off the normal stream', x.closed && pool.active === 0 && src.viewers.size === 0)
}
{
  // a sub stream already at 12 fps: sent as it is, and costs no slot
  const pool = new TranscodePool(1)
  made.length = 0
  const live = new PhoneLive({ pool, makeTranscoder, log: () => {} })
  const src = fakeSource()
  const a = fakeWs()
  live.attach('n1/2/1', src, 1, a)
  for (let i = 0; i < 20; i++) src.emit(encodeFrame(Buffer.from([0, 0, 1, 1]), i % 12 === 0, 0, i * 83.3))
  check('a slow sub stream is passed through, not converted', made.length === 0 && a.got.length > 0)
  check('  and gives its slot back', pool.active === 0)
}
{
  // Every [phone-live] line names its camera (nvr/channel from 1): the 29 Sep lines named none, and a
  // conversion could only be matched to a camera by its timing (stutter report 2.10)
  const logs = []
  made.length = 0
  const live = new PhoneLive({ pool: new TranscodePool(4), makeTranscoder, log: (l) => logs.push(l) })
  const slow = fakeSource()
  live.attach('nvr-2/4/1', slow, 1, fakeWs(), { camera: 'nvr-2/5' })
  for (let i = 0; i < 20; i++) slow.emit(encodeFrame(Buffer.from([0, 0, 1, 1]), i % 12 === 0, 0, i * 83.3))
  const fast = fakeSource()
  live.attach('nvr-2/0/0', fast, 0, fakeWs(), { camera: 'nvr-2/1' })
  for (let i = 0; i < 24; i++) fast.emit(encodeFrame(Buffer.from([0, 0, 1, 1]), i % 12 === 0, 1, i * 33.3))
  made[0].o.onFail(new Error('ffmpeg exited'))
  const stand = fakeSource()
  live.attach('value4u/9/0/standin', stand, 0, fakeWs(), { background: true, camera: 'value4u/10' })
  for (let i = 0; i < 24; i++) stand.emit(encodeFrame(Buffer.from([0, 0, 1, 1]), i % 12 === 0, 1, i * 33.3))
  check('a pass-through line names its camera', logs.some((l) => l === '[phone-live] nvr-2/5: a sub stream at 12.0 fps: sent as it is'), logs.join(' | '))
  check('a conversion line names its camera', logs.some((l) => l === '[phone-live] nvr-2/1: converting a main stream at 30.0 fps to about 15: keeping 1 in 2'), logs.join(' | '))
  check('a failed conversion names its camera', logs.some((l) => l === '[phone-live] nvr-2/1: conversion failed: ffmpeg exited'), logs.join(' | '))
  check('a stand-in\'s conversion says it is one', logs.some((l) => l.startsWith('[phone-live] value4u/10 (stand-in): converting a main stream')), logs.join(' | '))
  check('every [phone-live] line names a camera', logs.length === 4 && logs.every((l) => /^\[phone-live\] [\w-]+\/\d+( \(stand-in\))?: /.test(l)), logs.join(' | '))
  // ...and so do the converter's own lines (transcode.mjs: a conversion that ended, the hardware
  // encoder given up): a level change ends 15-24 at once, which a camera-less line cannot be matched to
  made[0].o.log('[transcode] conversion ended after 812 frames (ffmpeg exited with 1)')
  check('the converter\'s lines name its camera too', logs.at(-1) === '[phone-live] nvr-2/1: [transcode] conversion ended after 812 frames (ffmpeg exited with 1)', logs.at(-1))
}

// ---- a keyframe every 2 s of the stream going out ----
// ffmpeg's -g counts pictures out, so 50 was 3.3 s at 15 fps, 6.3 s at 8 and 12.5 s at 4: after a
// drop a tile waited that long for its next picture (stutter report 2.7). gopFor turns seconds into
// pictures at the rate out: the source's rate over the frames kept.
{
  const got = [[30, 1], [20, 1], [30, 2], [30, 4], [30, 8], [20, 3], [0.8, 1], [0.2, 1], [0, 1]].map(([fps, k]) => gopFor(fps, k, 2))
  check('gopFor: 2 s at the rate out (30 fps every frame 60, 20 fps 40, 1 in 2 of 30 30, 1 in 4 15, 1 in 8 8, 1 in 3 of 20 13)', JSON.stringify(got.slice(0, 6)) === JSON.stringify([60, 40, 30, 15, 8, 13]), JSON.stringify(got))
  check('  a trickle: at least every other picture at 0.8 fps, every picture below 0.25 fps (never 0)', got[6] === 2 && got[7] === 1, JSON.stringify(got))
  check('  no rate known: 0, the converter\'s own interval', got[8] === 0, JSON.stringify(got))
}

// ---- what a remote viewer's level asks of its stream (adaptive-live.mjs) ----
{
  /** One PhoneStream fed `n` frames at `fps` (a keyframe every 12), with a fake converter. */
  const run = (opts, { type = 0, codec = 1, fps = 30, n = 24 } = {}) => {
    const src = fakeSource()
    const xs = []
    const logs = []
    const slot = { freed: 0, release() { this.freed++ } }
    const s = new PhoneStream({
      source: src, type, slot, camera: 'n1/1', log: (l) => logs.push(l), ...opts,
      makeTranscoder: (o) => {
        const x = { o, pushed: 0, push(ts, k) { if (this.pushed++ % o.keepEvery === 0) o.onFrame(ts, k, Buffer.from([1])) }, close() {} }
        xs.push(x)
        return x
      }
    })
    const ws = fakeWs()
    s.add(ws)
    for (let i = 0; i < n; i++) src.emit(encodeFrame(Buffer.from([0, 0, 1, 1]), i % 12 === 0, codec, (i * 1000) / fps))
    return { s, xs, logs, ws, slot, args: xs[0] ? ffmpegArgs(xs[0].o).join(' ') : '' }
  }
  const REMOTE = { bufSeconds: 1, lowDelay: false, keySeconds: 2 }

  // level full for a browser without H.265: every frame, at most 1920 wide, playback's buffer and threads
  const full = run({ fps: 0, crf: 25, mainKbps: 2500, maxWidth: 1920, h264Only: true, ...REMOTE })
  const fo = full.xs[0]?.o ?? {}
  check('fps 0 (level full): a 30 fps H.265 main keeps every frame, at most 1920 wide, 2.5 Mbit/s', fo.keepEvery === 1 && fo.maxWidth === 1920 && fo.maxKbps === 2500 && fo.inCodec === 1, JSON.stringify({ k: fo.keepEvery, w: fo.maxWidth, r: fo.maxKbps }))
  check('  ffmpeg: no frame dropped, scaled to 1920, a 1 s buffer, two decoder threads, a keyframe every 60 pictures (2 s)', !full.args.includes('select') && full.args.includes('-vf scale=min(1920\\,iw):-2') && full.args.includes('-maxrate 2500k -bufsize 2500k') && full.args.includes('-threads 2') && !full.args.includes('low_delay') && / -g 60 /.test(full.args), full.args)
  check('  every frame from the conversion\'s first keyframe goes out', full.ws.got.length === 12 && full.ws.got.every((b, i) => Math.abs(parseFrame(b).ts - ((12 + i) * 1000) / 30) < 0.01), `${full.ws.got.length} out`)
  check('  the log says every frame is kept', full.logs.at(-1) === '[phone-live] n1/1: converting a main stream at 30.0 fps to H.264, every frame kept', full.logs.at(-1))

  // h264Only (level full exists only for browsers that cannot play H.265): an H.265 sub-stream kept whole is
  // converted, never sent as it is; an H.264 one has nothing to convert
  const sub265 = run({ fps: 0, subKbps: 700, h264Only: true, ...REMOTE }, { type: 1, codec: 1, fps: 20 })
  check('h264Only: an H.265 sub-stream kept whole is converted (H.265 never goes out as it is), not scaled', sub265.xs.length === 1 && sub265.xs[0].o.keepEvery === 1 && sub265.xs[0].o.maxWidth === 0 && sub265.xs[0].o.maxKbps === 700 && sub265.ws.got.every((b) => parseFrame(b).codec === 0) && sub265.slot.freed === 0, `${sub265.xs.length} conversions`)
  const sub264 = run({ fps: 0, subKbps: 700, h264Only: true, ...REMOTE }, { type: 1, codec: 0, fps: 20 })
  check('  an H.264 sub-stream is sent as it is, and gives its slot back', sub264.xs.length === 0 && sub264.ws.got.length > 0 && sub264.slot.freed === 1)
  const phone265 = run({}, { type: 1, codec: 1, fps: 12 })
  check('  without it (a phone): a 12 fps H.265 sub-stream is sent as it is, as before', phone265.xs.length === 0 && phone265.ws.got.length > 0 && phone265.slot.freed === 1)

  // the thinning levels: the same buffer, threads and 2 s of keyframes, at their own rates
  const l15 = run({ fps: 15, ...REMOTE })
  check('level 15 on a 30 fps main: 1 in 2, 1280 wide (as before), a 1 s buffer, two threads, a keyframe every 30 pictures (2 s at 15)', l15.xs[0]?.o.keepEvery === 2 && l15.args.includes('select=not(mod(n\\,2)),scale=min(1280\\,iw):-2') && l15.args.includes('-maxrate 2500k -bufsize 2500k') && l15.args.includes('-threads 2') && / -g 30 /.test(l15.args), l15.args)
  const l8 = run({ fps: 8, crf: 27, subKbps: 450, ...REMOTE }, { type: 1, codec: 0, fps: 24 })
  check('level 8 on a 24 fps sub: 1 in 3, a keyframe every 16 pictures (2 s at 8)', l8.xs[0]?.o.keepEvery === 3 && l8.args.includes('-maxrate 450k -bufsize 450k') && / -g 16 /.test(l8.args), l8.args)
  const l4 = run({ fps: 4, crf: 29, mainKbps: 900, ...REMOTE }, { fps: 24 })
  check('level 4 on a 24 fps main: 1 in 6, a keyframe every 8 pictures (2 s at 4), not every 50 (12.5 s)', l4.xs[0]?.o.keepEvery === 6 && l4.args.includes('-maxrate 900k -bufsize 900k') && / -g 8 /.test(l4.args), l4.args)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
