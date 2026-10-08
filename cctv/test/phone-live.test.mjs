// Tests live video thinned for phones (phone-live.mjs), with a fake converter: no ffmpeg needed.
//   node cctv/test/phone-live.test.mjs
import { CATCH_UP_MS, LAG_HOLD_MS, PhoneLive, PhoneStream, encodeFrame, frameRate, gopFor, isPhoneRequest, keepEveryFor, parseFrame, steadyRate } from '../phone-live.mjs'
import { HubStream } from '../stream-hub.mjs'
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
// (REMOTE_CONVERSION there: how every level's conversion runs, and how soon it starts)
const REMOTE = { bufSeconds: 1, lowDelay: false, keySeconds: 2, learnMs: 1000, slowFps: 10, wholeReplay: true, rejudge: true, maxLagS: 2 }
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

// ---- a camera that trickles: its picture at once (stutter report 2.9) ----
// A new stream learnt its frame rate from 12 frames and sent nothing meanwhile: 15 s at 0.8 fps. On 29
// Sep a level change left two trickling tiles with nothing new for 14 s (04:08:08.8 -> 04:08:22.9), and
// a full-size main showed nothing from its conversion for 13 s (04:03:55.9 -> 04:04:09.2). A remote
// viewer's stream (learnMs) decides after 12 frames or 1 s of capture time, whichever comes first, and
// meanwhile a sub-stream's H.264 goes out as it comes.
{
  /**
   * One PhoneStream on a camera sending `fps` (a keyframe every `keyEvery` frames), one socket on it,
   * fed `n` frames. `replay`: the camera's stream was running, and replays that many frames (from its
   * last keyframe) to the stream as it joins -- a level change; 0: a cold stream, the socket there
   * before its first frame. Each thing sent is timed by the capture time (ms) of the frame being handed
   * over then (at the join: the last one replayed).
   */
  const feed = (opts, { type = 1, codec = 0, fps = 0.8, keyEvery = 1, replay = 0, n = 8 } = {}) => {
    const frame = (i) => encodeFrame(Buffer.from([0, 0, 1, 1]), i % keyEvery === 0, codec, (i * 1000) / fps)
    const gop = Array.from({ length: replay }, (_, i) => frame(i))
    const src = fakeSource()
    src.add = function (ws) { this.viewers.add(ws); for (const m of gop) ws.send(m) }
    let at = replay ? ((replay - 1) * 1000) / fps : 0
    const out = []
    const logs = []
    const xs = []
    const s = new PhoneStream({
      source: src, type, slot: { release() {} }, camera: 'n1/1', log: (l) => logs.push({ at, l }), ...opts,
      makeTranscoder: (o) => {
        const x = { o, pushed: 0, push(ts, k) { if (this.pushed++ % o.keepEvery === 0) o.onFrame(ts, k, Buffer.from([1])) }, close() {} }
        xs.push(x)
        return x
      }
    })
    const ws = fakeWs()
    // the fake converter's pictures are 1 byte, the camera's own 4
    ws.send = (b) => { const f = parseFrame(b); out.push({ at, ts: f.ts, key: f.isKey, codec: f.codec, converted: f.payload.length === 1 }) }
    s.add(ws)
    for (let i = replay; i < replay + n; i++) {
      at = (i * 1000) / fps
      src.emit(frame(i))
    }
    return { s, out, logs, xs }
  }
  const show = (r) => JSON.stringify({ out: r.out.slice(0, 4), logs: r.logs })

  // a sub-stream, cold (a tile opened while stepped down): level 15
  const sub = feed({ fps: 15, ...REMOTE })
  check('a remote viewer\'s sub-stream trickling at 0.8 fps: its first keyframe goes out as it comes, within 1.3 s (was 15 s: 12 frames first)', sub.out.length > 0 && sub.out[0].at <= 1300 && sub.out[0].ts === 0, show(sub))
  check('  its rate decided at the second frame (1 s of capture time), 0.8 fps: sent as it is', sub.logs.length === 1 && sub.logs[0].at === 1250 && sub.logs[0].l === '[phone-live] n1/1: a sub stream at 0.8 fps: sent as it is', show(sub))
  check('  every frame goes out once, in order, as it came', sub.out.length === 8 && sub.out.every((o, i) => o.ts === i * 1250 && o.at === o.ts && !o.converted), show(sub))

  // a main is scaled down on a level, so it is always converted: none of its own frames goes out
  const main = feed({ fps: 15, ...REMOTE }, { type: 0 })
  check('a remote viewer\'s H.264 main trickling at 0.8 fps (level 15): converted from the second frame, its first picture 1.25 s after the first keyframe (was 15 s)', main.out.length > 0 && main.out[0].at <= 1300 && main.out[0].converted && main.logs[0]?.l === '[phone-live] n1/1: converting a main stream at 0.8 fps to about 15: keeping 1 in 1, each picture out as it comes', show(main))
  check('  the main\'s own frames never go out as they are (a level is there to send less than the main)', main.out.length > 0 && main.out.every((o) => o.converted), show(main))
  // an H.265 main at level full, for a PC that cannot play it: 29 Sep 04:03:55.9, nothing for 13 s
  const h265 = feed({ fps: 0, maxWidth: 1920, h264Only: true, ...REMOTE }, { type: 0, codec: 1 })
  check('an H.265 main trickling at 0.8 fps at level full: converted from the second frame, 1.25 s after the first keyframe, never sent as H.265', h265.out.length > 0 && h265.out[0].at <= 1300 && h265.out.every((o) => o.converted && o.codec === 0), show(h265))

  // the camera's stream was running: it replays its last keyframe to the stream as it joins
  const moved = feed({ fps: 15, ...REMOTE }, { replay: 1 })
  check('a running trickle (a level change): the frame after the join goes out as it comes, 1.25 s after it, the rate decided then', moved.out[0]?.at === 1250 && moved.out[0].ts === 1250 && moved.logs[0]?.at === 1250, show(moved))
  check('  the keyframe replayed at the join is only learnt from, not sent on (a socket moved here has it)', moved.out.length > 0 && moved.out.every((o) => o.ts >= 1250), show(moved))
  // ...which matters on a fast one: a step down moved 11 pass-through tiles at once on a link already
  // backed up (29 Sep 04:18:05); sent again, that would be up to a sub-stream's GOP each
  const fast = feed({ fps: 15, ...REMOTE }, { fps: 20, keyEvery: 40, replay: 20, n: 30 })
  check('a running 20 fps sub: decided at the join on the 12 frames replayed (as before), none of them sent again', fast.logs[0]?.at === 950 && fast.logs[0].l === '[phone-live] n1/1: a sub stream at 20.0 fps: sent as it is' && fast.out.length > 0 && fast.out.every((o) => o.ts > 950), show(fast))

  // 1 s comes first below 12 fps; 12 frames above
  const five = feed({ fps: 4, crf: 29, subKbps: 280, ...REMOTE }, { fps: 5, keyEvery: 10, n: 14 })
  check('a 5 fps sub: decided at 1 s of capture time (its 6th frame), at 5.0 fps', five.logs[0]?.at === 1000 && five.logs[0].l === '[phone-live] n1/1: a sub stream at 5.0 fps: sent as it is', show(five))
  const twenty = feed({ fps: 8, crf: 27, subKbps: 450, ...REMOTE }, { fps: 20, keyEvery: 40, n: 30 })
  check('a 20 fps sub at level 8: still decided on 12 frames (at 0.6 s), 1 in 3', twenty.logs[0]?.at === 600 && twenty.logs[0].l === '[phone-live] n1/1: converting a sub stream at 20.0 fps to about 8: keeping 1 in 3' && twenty.xs[0]?.o.keepEvery === 3, show(twenty))
  check('  its own frames went out while it learnt, then only converted ones, from the keyframe it learnt from', twenty.out.slice(0, 12).every((o, i) => !o.converted && o.ts === i * 50) && twenty.out.slice(12).every((o) => o.converted) && twenty.out[12]?.key && twenty.out[12].ts === 0, show({ out: twenty.out.slice(10, 14), logs: twenty.logs }))
  const late = fakeWs()
  twenty.s.add(late)
  check('  a socket joining after that is sent the converted pictures only, never the camera\'s own', late.got.length > 0 && late.got.every((b) => parseFrame(b).payload.length === 1), `${late.got.length} sent`)

  // a phone on the local network is not a remote viewer: as before, by the local-network rule
  const phone = feed({}, { n: 14 })
  check('a phone on the local network: as before, nothing sent until 12 frames have been seen (15 s at 0.8 fps)', phone.out[0]?.at === 15000 && phone.logs[0]?.at === 15000, show(phone))

  // ---- a stream made for sockets a level change moves off a picture (stutter report 2.5, verify-5) ----
  // It learnt its rate from the camera's replay as it joined and converted from the keyframe it held,
  // up to a keyframe interval older than what those sockets had on screen: their picture stepped back
  // (1.4 s in the replay) and the conversion caught up through seconds it had already shown, a burst of
  // CPU and bytes at every step. fromNextKey: learnt from the replay all the same, and converted from
  // the camera's next keyframe, newer than anything they had; startTs says which (adaptive-live.mjs
  // switches them there).
  const rates = []
  const next = feed({ fps: 8, crf: 27, subKbps: 450, ...REMOTE, fromNextKey: true, onRate: (r) => rates.push(r) }, { fps: 20, keyEvery: 40, replay: 20, n: 40 })
  const x = next.xs[0]
  check('fromNextKey: decided at the join on the replay (20 fps, 1 in 3) and its converter started then, nothing converted from the replay', next.logs[0]?.at === 950 && x?.o.keepEvery === 3 && x.pushed === 20, show(next))
  check('  converted from the camera\'s next keyframe (2 s): its first picture that keyframe, and none older', next.out.length > 0 && next.out[0].key && next.out[0].ts === 2000 && next.out.every((o) => o.converted && o.ts >= 2000) && next.s.startTs === 2000, show(next))
  check('  the rate it learnt is handed on (onRate: adaptive-live remembers it)', rates.length === 1 && rates[0] === 20, JSON.stringify(rates))
  const held = feed({ fps: 8, crf: 27, subKbps: 450, ...REMOTE }, { fps: 20, keyEvery: 40, replay: 20, n: 40 })
  check('  without it (a tile just opened, nothing on screen): from the keyframe it held, at once, as before', held.out[0]?.key && held.out[0].ts === 0 && held.out[0].at === 950 && held.s.startTs === 0, show(held))
  // a running sub whose replay was too short to decide on: it learns on the camera's live frames and
  // sends them on as they come (report 2.9); the keyframe it then holds is one it has sent already
  const learnt = feed({ fps: 8, crf: 27, subKbps: 450, ...REMOTE, fromNextKey: true }, { fps: 20, keyEvery: 8, replay: 2, n: 30 })
  const steps = learnt.out.map((o) => o.ts)
  check('fromNextKey, learning on live frames: never a frame older than one sent (its own, then converted from the next keyframe)', steps.length > 0 && steps.every((t, i) => i === 0 || t >= steps[i - 1]), show({ out: learnt.out.slice(0, 12), logs: learnt.logs }))
  check('  the camera\'s own frames go on up to that keyframe (no hold while the conversion waits for it), then only converted ones',
    learnt.out.filter((o) => !o.converted).map((o) => o.ts).join() === '400,450,500,550,600,650,700,750' && learnt.out.filter((o) => o.converted)[0]?.ts === 800 && learnt.out.filter((o) => o.converted)[0].key && learnt.s.startTs === 400, show({ out: learnt.out.slice(0, 12), logs: learnt.logs }))
  const pass = feed({ fps: 15, ...REMOTE, fromNextKey: true }, { fps: 20, keyEvery: 40, replay: 20, n: 42 })
  check('fromNextKey, sent as it is: its first keyframe out is the camera\'s next one (startTs)', pass.s.passthrough && pass.s.startTs === 2000 && pass.out[0]?.ts === 2000 && pass.out[0].key, show(pass))
}
{
  // ...and a socket joining it after it decided, before its conversion's first picture (a trickle, or
  // keyframes under 1 s apart). It said it starts at the camera's own keyframe it had passed on
  // (startTs), and the socket switching to it goes over when its old stream reaches that. Decided by
  // then, the stream had thrown the camera's frames it passed on away for anyone joining, and converted
  // from the keyframe after: the socket was sent the camera's deltas, which it cannot show without their
  // keyframe, and nothing it could show for a keyframe interval (the review of ef43e60). Those frames go
  // on up to that keyframe, so they are there for a socket joining too, from the last of their keyframes.
  const src = fakeSource()
  const s = new PhoneStream({ source: src, type: 1, slot: { release() {} }, camera: 'n1/1', log: () => {}, fps: 8, crf: 27, subKbps: 450, ...REMOTE, fromNextKey: true, makeTranscoder })
  const frame = (i) => encodeFrame(Buffer.from([0, 0, 1, 1]), i % 8 === 0, 0, i * 50) // 20 fps, a keyframe every 0.4 s
  for (let i = 0; i < 14; i++) src.emit(frame(i)) // decided at the 12th (0.6 s), to convert from the keyframe at 0.8 s
  const ws = fakeWs()
  s.add(ws)
  for (let i = 14; i < 24; i++) src.emit(frame(i))
  const got = ws.got.map((b) => { const f = parseFrame(b); return { ts: f.ts, key: f.isKey, converted: f.payload.length === 1 } })
  const own = got.filter((f) => !f.converted).map((f) => f.ts)
  check('fromNextKey, a socket joining after it decided on live frames: sent the camera\'s own frames from their last keyframe (startTs) on, then the conversion from the keyframe after, nothing missed',
    s.startTs === 400 && got[0]?.key && own.join() === '400,450,500,550,600,650,700,750' && got.find((f) => f.converted)?.ts === 800 && got.every((f, i) => i === 0 || f.ts > got[i - 1].ts), `startTs ${s.startTs} ${JSON.stringify(got.slice(0, 3))}`)
}

// ---- a stream made at the camera's keyframe, its rate known (adaptive-live.mjs #handOver) ----
// No conversion slot free at a step down: a tile keeps its own conversion to the camera's next keyframe,
// and there that one closes and the new level's stream is made, from inside the keyframe's fan-out, with
// the slot it gave back. The rate is known already (the camera stream's GOP, the conversion it leaves):
// learnt again, the stream took the keyframe it was made at as its first sample, sent the camera's own
// frames on while it learnt, and converted from the keyframe after, a keyframe interval later.
{
  const hub = { send() {}, streams: new Map(), stopDelayMs: { 0: 10_000, 1: 10_000 } }
  /** A 20 fps sub (a keyframe every 2 s) on the real fan-out; at its keyframe at 2 s a stream of level 8 is made, and a socket put on it. */
  const handOver = (extra) => {
    const src = new HubStream(hub, 0, 1)
    src.add(fakeWs())
    const frame = (i) => encodeFrame(Buffer.from([0, 0, 1, 1]), i % 40 === 0, 0, i * 50)
    for (let i = 0; i < 30; i++) src.onFrame(frame(i), i % 40 === 0)
    const xs = []
    const logs = []
    const out = []
    const rates = []
    let s = null
    src.add({
      OPEN: 1, readyState: 1, bufferedAmount: 0,
      send: (b) => {
        const f = parseFrame(b)
        if (s || !f.isKey || f.ts !== 2000) return
        s = new PhoneStream({
          source: src, type: 1, slot: { release() {} }, camera: 'n1/1', log: (l) => logs.push(l), fps: 8, crf: 27, subKbps: 450, ...REMOTE, fromNextKey: true, onRate: (r) => rates.push(r), ...extra,
          makeTranscoder: (o) => {
            const x = { o, pushed: [], push(ts, k) { this.pushed.push(ts); if ((this.pushed.length - 1) % o.keepEvery === 0) o.onFrame(ts, k, Buffer.from([1])) }, close() {} }
            xs.push(x)
            return x
          }
        })
        const ws = fakeWs()
        ws.send = (m) => { const g = parseFrame(m); out.push({ ts: g.ts, key: g.isKey, converted: g.payload.length === 1 }) }
        s.add(ws)
      }
    })
    for (let i = 30; i < 70; i++) src.onFrame(frame(i), i % 40 === 0)
    return { s, xs, logs, out, rates }
  }
  const known = handOver({ srcFps: 20 })
  check('srcFps: made in the camera keyframe\'s fan-out, it decides at once on the rate it is given, nothing learnt', known.logs.length === 1 && known.logs[0] === '[phone-live] n1/1: converting a sub stream at 20.0 fps to about 8: keeping 1 in 3' && known.rates.join() === '20', JSON.stringify(known.logs))
  check('  and converts from that very keyframe: its first picture out is that keyframe (startTs), and none of the camera\'s own frames goes out',
    known.xs[0]?.pushed[0] === 2000 && known.out[0]?.key && known.out[0].ts === 2000 && known.out.every((o) => o.converted) && known.s.startTs === 2000, JSON.stringify(known.out.slice(0, 4)))
  const learnt = handOver({})
  check('  (not given: learnt again from there, the camera\'s own frames sent on meanwhile, converted only from the keyframe after)', learnt.xs.every((x) => x.pushed.length === 0) && learnt.out.length > 0 && learnt.out.every((o) => !o.converted), JSON.stringify(learnt.out.slice(0, 3)))
}

// ---- a remote viewer's stream learns its rate from the camera's whole replay ----
// A main's GOP so far over 1.5 MB (gop-replay.mjs REPLAY_MAX_BYTES: a 25 fps 4K main 1.6 s in) is replayed
// to a new viewer as its keyframe alone, the rest from the next keyframe on. A level's stream joining it
// learnt its rate from those two keyframes, 2 s apart: 0.5 fps, and converted a 25 fps main one picture
// at a time, every picture a keyframe, under level 15's 2.5 Mbit/s (the review of ef43e60). Its tap never
// goes over the network: a remote viewer's stream is replayed the GOP whole.
{
  const hub = { send() {}, streams: new Map(), stopDelayMs: { 0: 10_000, 1: 10_000 } }
  const bigMain = (opts) => {
    const src = new HubStream(hub, 0, 0)
    src.add(fakeWs())
    const frame = (i) => encodeFrame(Buffer.alloc(i % 50 === 0 ? 200_000 : 60_000), i % 50 === 0, 1, i * 40)
    for (let i = 0; i < 40; i++) src.onFrame(frame(i), i % 50 === 0) // 1.6 s into a 2 s GOP: 2.54 MB
    const xs = []
    const logs = []
    const s = new PhoneStream({ source: src, type: 0, slot: { release() {} }, camera: 'n1/1', log: (l) => logs.push(l), fps: 15, ...opts, makeTranscoder: (o) => { xs.push(o); return { push() {}, endPicture() {}, close() {} } } })
    for (let i = 40; i < 120; i++) src.onFrame(frame(i), i % 50 === 0)
    s.close()
    return { o: xs[0], logs, gop: src.gop.length }
  }
  const remote = bigMain(REMOTE)
  check('a remote viewer\'s stream joining a main whose GOP so far is 2.5 MB: its rate from the replay, 25 fps (1 in 2, a keyframe every 25 pictures), not 0.5 from two keyframes',
    remote.o?.keepEvery === 2 && remote.o.gop === 25 && remote.o.lowDelay === false && remote.logs[0] === '[phone-live] n1/1: converting a main stream at 25.0 fps to about 15: keeping 1 in 2', JSON.stringify({ o: remote.o && { k: remote.o.keepEvery, g: remote.o.gop, low: remote.o.lowDelay }, logs: remote.logs }))
  const phone = bigMain({})
  check('  a phone on the local network: its replay as before (cut to the keyframe past 1.5 MB)', phone.o && phone.logs[0] !== remote.logs[0], JSON.stringify(phone.logs))
}

// ---- a socket moved onto a running level stream at its keyframe (adaptive-live.mjs #swap) ----
// A remote viewer's tile going onto another viewer's stream of its new level: it keeps its own until that
// stream's next keyframe past what it has, and joins it as that keyframe goes out, from inside its
// fan-out. Its GOP replayed then is older than what the tile has (or that same keyframe again).
{
  const src = fakeSource()
  const s = new PhoneStream({ source: src, type: 1, slot: { release() {} }, camera: 'n1/1', log: () => {}, fps: 15, ...REMOTE, srcFps: 20, makeTranscoder })
  const frame = (i) => encodeFrame(Buffer.from([0, 0, 1, 1]), i % 20 === 0, 0, i * 50)
  for (let i = 0; i < 30; i++) src.emit(frame(i))
  const moved = fakeWs()
  const plain = fakeWs()
  s.add({
    OPEN: 1, readyState: 1, bufferedAmount: 0,
    send: (b) => {
      const f = parseFrame(b)
      if (!f.isKey || f.ts !== 2000 || s.clients.has(moved)) return
      moved.waitForKey = true
      s.add(moved, { replay: false })
      s.add(plain)
    }
  })
  for (let i = 30; i < 45; i++) src.emit(frame(i))
  const ts = (ws) => ws.got.map((b) => parseFrame(b).ts)
  check('PhoneStream.add replay false, from inside its keyframe\'s fan-out: nothing replayed, that keyframe once, then on', s.passthrough && ts(moved).join() === '2000,2050,2100,2150,2200', ts(moved).join())
  check('  (a default add there: the keyframe twice, replayed and then as it goes out)', ts(plain).filter((t) => t === 2000).length === 2, ts(plain).slice(0, 3).join())
}

// ---- a trickle's conversion: each picture out as it goes in ----
// ffmpeg's parser holds a picture until the next one begins, and a second decoder thread one more
// (transcode.mjs): measured through the real ffmpeg on the server (29 Sep), a remote PC's conversion
// of an H.265 main at 0.8 fps put out its first picture 3.9 s after the first keyframe and every
// picture 2.7 s after it came. Under slowFps a remote viewer's conversion runs with low_delay (one
// decoder thread, plenty at that rate) and ends each picture as it goes in (Transcoder.endPicture):
// 1.5 s and 0.2 s.
{
  /** A PhoneStream fed `n` frames at `fps`, every one a keyframe, through a fake converter that notes its calls. */
  const slow = (opts, { type = 0, codec = 1, fps = 0.8, n = 6 } = {}) => {
    const src = fakeSource()
    const calls = []
    const xs = []
    const logs = []
    const s = new PhoneStream({
      source: src, type, slot: { release() {} }, camera: 'n1/1', log: (l) => logs.push(l), ...opts,
      makeTranscoder: (o) => {
        const x = { o, push(ts) { calls.push(`push ${ts}`); o.onFrame(ts, true, Buffer.from([1])) }, endPicture() { calls.push('end') }, close() {} }
        xs.push(x)
        return x
      }
    })
    s.add(fakeWs())
    for (let i = 0; i < n; i++) src.emit(encodeFrame(Buffer.from([0, 0, 1, 1]), true, codec, (i * 1000) / fps))
    return { calls, o: xs[0]?.o ?? {}, args: xs[0] ? ffmpegArgs(xs[0].o).join(' ') : '', logs }
  }
  const full = { fps: 0, maxWidth: 1920, h264Only: true, ...REMOTE }
  const h265 = slow(full)
  check('a remote PC\'s H.265 main at 0.8 fps (level full): converted with low_delay, no decoder threads to hold a picture back', h265.o.lowDelay === true && h265.args.includes('-flags low_delay') && !h265.args.includes('-threads'), h265.args)
  check('  each picture ended as it goes in, so the parser lets it go at once', h265.calls.join(', ') === 'push 1250, end, push 2500, end, push 3750, end, push 5000, end, push 6250, end', h265.calls.join(', '))
  check('  the log says so', h265.logs[0] === '[phone-live] n1/1: converting a main stream at 0.8 fps to H.264, every frame kept, each picture out as it comes', h265.logs.join(' | '))
  const l15 = slow({ fps: 15, ...REMOTE }, { codec: 0, fps: 5, n: 8 })
  check('a 5 fps H.264 main at level 15: the same (the 1 s of learning, then each picture ended)', l15.o.lowDelay === true && l15.calls.filter((c) => c === 'end').length === l15.calls.filter((c) => c.startsWith('push')).length && l15.calls.length > 0, l15.calls.join(', '))
  const fast = slow(full, { fps: 20, n: 20 })
  check('a 20 fps H.265 main at full: two decoder threads and nothing ended, as before (their speed is what 20 fps needs)', fast.o.lowDelay === false && fast.args.includes('-threads 2') && !fast.calls.includes('end') && fast.calls.length > 0, `${fast.args} | ${fast.calls.slice(0, 4)}`)
  const phone = slow({}, { n: 14 })
  check('a phone on the local network: its conversion as before (the converter\'s own low_delay, nothing ended)', phone.o.lowDelay === undefined && !phone.calls.includes('end') && phone.calls.length > 0, phone.calls.slice(0, 4).join(', '))
}

// ---- a hole in a new stream's first second (the final review of live-smooth) ----
// A remote viewer's stream decided its rate after 12 frames or 1 s of capture time, on the mean over
// the span, and never judged again: one hole of 1 s or more in that first second read a normal camera as
// a trickle, for the stream's whole life. nvr-2 freezes all its cameras for 11-32 s just when streams
// are opened (stutter report 2.3), and JPB DOOR has 28 holes over 1 s in 10 minutes. Now a hole is left
// out of the reading (steadyRate), and a rate read on fewer than FIRM_INTERVALS intervals is read again
// at the 12th frame; more than 2x off, the stream's settings follow from the camera's next keyframe.
check('steadyRate: an even stream as frameRate reads it (20 fps; a "19 fps" camera, 1 step in 7 of 67 ms)',
  steadyRate([0, 50, 100, 150, 200, 250]) === 20 && Math.abs(steadyRate([0, 50, 100, 150, 200, 250, 300, 367, 417, 467, 517, 567]) - frameRate([0, 50, 100, 150, 200, 250, 300, 367, 417, 467, 517, 567])) < 1e-9)
check('  a 30 fps sub on the 60 Hz grid (33 and 50 ms steps, 25.4 fps): the mean, as frameRate (the median would read 30)',
  Math.abs(steadyRate([0, 33, 67, 117, 150, 183, 233, 267, 300, 350, 383, 417]) - frameRate([0, 33, 67, 117, 150, 183, 233, 267, 300, 350, 383, 417])) < 1e-9)
check('  a hole of 1.2 s among 50 ms steps left out: 20 fps (frameRate: 6.5)', steadyRate([0, 50, 1250, 1300, 1350, 1400, 1450, 1500, 1550, 1600, 1650, 1700]) === 20, String(steadyRate([0, 50, 1250, 1300, 1350, 1400, 1450, 1500, 1550, 1600, 1650, 1700])))
check('  a 15 s freeze after 3 steps of 33 ms left out: 30 fps', Math.abs(steadyRate([0, 33.3, 66.7, 100, 15100]) - 30) < 0.01, String(steadyRate([0, 33.3, 66.7, 100, 15100])))
check('  a trickle at 0.8 fps is one (1250 ms steps); two steps, one a hole: the slower reading (the 12th frame reads it again)', steadyRate([0, 1250, 2500]) === 0.8 && steadyRate([0, 50, 1250]) === 1.6 && steadyRate([5]) === 0 && steadyRate([]) === 0)
{
  /**
   * One PhoneStream on a camera of `fps` (a keyframe every `keyEvery` frames), fed `n` frames with a
   * hole of `hole` ms after frame `holeAfter`; `slots` conversion slots in all, one of them its own.
   */
  const holed = (opts, { type = 0, codec = 1, fps = 20, keyEvery = 40, hole = 1200, holeAfter = 1, n = 120, slots = 1 } = {}) => {
    const src = fakeSource()
    const xs = []
    const logs = []
    const rates = []
    const out = []
    let free = slots - 1
    const slot = () => ({ gone: false, release() { if (!this.gone) { this.gone = true; free++ } } })
    const s = new PhoneStream({
      source: src, type, slot: slot(), camera: 'n1/1', log: (l) => logs.push(l), onRate: (r) => rates.push(r), acquire: () => (free > 0 ? (free--, slot()) : null), ...opts,
      makeTranscoder: (o) => {
        const x = { o, pushed: [], closed: false, push(ts, k) { if (this.pushed.push(ts) % o.keepEvery === 1 || o.keepEvery === 1) o.onFrame(ts, k, Buffer.from([1])) }, endPicture() {}, close() { this.closed = true } }
        xs.push(x)
        return x
      }
    })
    const ws = fakeWs()
    ws.send = (b) => { const g = parseFrame(b); out.push({ ts: g.ts, key: g.isKey, converted: g.payload.length === 1 }) }
    s.add(ws)
    let ts = 0
    const keys = []
    for (let i = 0; i < n; i++) {
      if (i % keyEvery === 0) keys.push(ts)
      src.emit(encodeFrame(Buffer.from([0, 0, 1, 1]), i % keyEvery === 0, codec, ts))
      ts += i === holeAfter ? hole : 1000 / fps
    }
    return { s, xs, logs, rates, out, keys, free: () => free }
  }
  const show = (r) => JSON.stringify({ xs: r.xs.map((x) => ({ k: x.o.keepEvery, g: x.o.gop, low: x.o.lowDelay, first: x.pushed[0], closed: x.closed })), logs: r.logs, rates: r.rates })

  // a 4K H.265 main at full, 20 fps: a 1.2 s hole read it as 1.6 fps, -g 3 and one decoder thread for good
  const full = holed({ fps: 0, crf: 25, mainKbps: 2500, maxWidth: 1920, h264Only: true, ...REMOTE })
  const last = full.xs.at(-1)
  const args = last ? ffmpegArgs(last.o).join(' ') : ''
  check('a 20 fps H.265 main at level full, a 1.2 s hole after its first keyframe: converted from its next keyframe as 20 fps, a keyframe every 2 s (-g 40), two decoder threads',
    full.xs.length === 2 && full.xs[0].closed && last.o.keepEvery === 1 && last.o.gop === 40 && last.o.lowDelay === false && args.includes('-threads 2') && / -g 40 /.test(args) && last.pushed[0] === full.keys[1], show(full))
  check('  meanwhile converted as the 1 s rule read it (1.6 fps: picture by picture), never handed on as its rate; 20 fps is', full.xs[0].o.lowDelay === true && full.rates.join() === '20', show(full))
  check('  the log says it read the rate again, and how it converts now', full.logs.some((l) => l === '[phone-live] n1/1: its rate read again on its first 12 frames: 20.0 fps, not 1.6 (a hole as it started); from the camera\'s next keyframe:') && full.logs.at(-1) === '[phone-live] n1/1: converting a main stream at 20.0 fps to H.264, every frame kept', show(full))
  const ts = full.out.map((o) => o.ts)
  check('  what goes out never steps back', ts.length > 0 && ts.every((t, i) => i === 0 || t >= ts[i - 1]), ts.slice(0, 20).join())

  // a 30 fps sub at level 8: read as a trickle and sent as it is, 30 fps where level 8 sends 8
  const sub = holed({ fps: 8, crf: 27, subKbps: 450, ...REMOTE }, { type: 1, codec: 0, fps: 30, keyEvery: 60 })
  check('a 30 fps sub at level 8, a 1.2 s hole after its first keyframe: not left sent as it is: converted from its next keyframe, 1 in 4, a keyframe every 15 pictures (2 s), two decoder threads',
    !sub.s.passthrough && sub.xs.length === 1 && sub.xs[0].o.keepEvery === 4 && sub.xs[0].o.gop === 15 && sub.xs[0].o.lowDelay === false && Math.abs(sub.xs[0].pushed[0] - sub.keys[1]) < 0.01 && sub.free() === 0, show(sub))
  const after = sub.out.filter((o) => o.ts >= sub.keys[1])
  check('  its own frames up to that keyframe, then only converted ones, about 8 a second', sub.out.filter((o) => o.ts < sub.keys[1]).every((o) => !o.converted) && after.length > 0 && after.every((o) => o.converted) && after.length <= Math.ceil((sub.keys.length ? (sub.out.at(-1).ts - sub.keys[1]) / 1000 : 0) * 7.5) + 1, `${after.length} converted | ${show(sub)}`)
  const none = holed({ fps: 8, crf: 27, subKbps: 450, ...REMOTE, acquire: () => null }, { type: 1, codec: 0, fps: 30, keyEvery: 60 })
  check('  no conversion slot free then: still sent as it is, and said', none.s.passthrough && none.xs.length === 0 && none.logs.at(-1) === '[phone-live] n1/1: a sub stream at 30.0 fps: still sent as it is, no conversion slot free', show(none))

  // an H.264 main at 15 whose NVR froze 15 s after its keyframe and 3 frames: read on 4 steps, the hole
  // left out, at once (it read 0.3 fps: -g 1, every picture a keyframe, 1 in 1 kept: 30 fps, not 15)
  const froze = holed({ fps: 15, ...REMOTE }, { type: 0, codec: 0, fps: 30, keyEvery: 60, hole: 15_000, holeAfter: 3 })
  check('an H.264 main at 15, a 15 s NVR freeze after its keyframe and 3 frames: 30 fps at once (the freeze left out), 1 in 2, -g 30, nothing read again', froze.xs.length === 1 && froze.xs[0].o.keepEvery === 2 && froze.xs[0].o.gop === 30 && froze.rates.length === 1 && Math.abs(froze.rates[0] - 30) < 0.01 && !froze.logs.some((l) => l.includes('read again')), show(froze))

  // a camera that really trickles: read again at its 12th frame (15 s), the same, nothing changed
  const trickle = holed({ fps: 15, ...REMOTE }, { type: 1, codec: 0, fps: 0.8, keyEvery: 1, hole: 1250, n: 14 })
  check('a sub trickling at 0.8 fps: sent as it is from its 2nd frame, read again at its 12th, the same: nothing restarted, its rate handed on then', trickle.s.passthrough && trickle.xs.length === 0 && trickle.rates.join() === '0.8' && trickle.logs.length === 1, show(trickle))
  // a phone on the local network: its 12 frames and the mean, as before (the local-network rule)
  const phone = holed({}, { type: 1, codec: 0, fps: 30, keyEvery: 60 })
  check('a phone on the local network: 12 frames, read as before (the hole in the mean), nothing read again', phone.logs.length === 1 && phone.logs[0].startsWith('[phone-live] n1/1: a sub stream at 7.2 fps') && phone.rates.length === 1, show(phone))
}

// ---- a conversion that falls behind the camera (the final review of live-smooth) ----
// ffmpeg runs niced, so recording wins; under a load that takes a conversion below real time, push went
// on writing to its stdin, the frames in it grew (transcode.mjs pending), the remote picture fell
// further behind and the server's memory grew for as long as the load lasted. A remote viewer's
// conversion (maxLagS) with more than that many seconds of the camera in it for LAG_HOLD_MS is reset,
// and starts again at the camera's next keyframe, said once. The GOP a new one starts from is let
// through first, and so are frames handed in faster than they come.
{
  /**
   * A 4K-like H.265 main at `fps` (a keyframe every `keyEvery`) through a converter that hands back
   * `speed` x real time; `replay` frames of its GOP replayed as the stream joins (all at that moment);
   * burst: every frame handed in at once, the clock standing still (transcode-ffmpeg.test's feed).
   */
  const lagging = (opts, { speed, fps = 20, keyEvery = 40, replay = 0, n = 200, burst = false }) => {
    const clock = { wall: 0 }
    const frame = (i) => encodeFrame(Buffer.from([0, 0, 1, 1]), i % keyEvery === 0, 1, (i * 1000) / fps)
    const gop = Array.from({ length: replay }, (_, i) => frame(i))
    const src = fakeSource()
    src.add = function (ws) { this.viewers.add(ws); for (const m of gop) ws.send(m) }
    clock.wall = replay ? ((replay - 1) * 1000) / fps : 0
    const xs = []
    const logs = []
    const s = new PhoneStream({
      source: src, type: 0, slot: { release() {} }, camera: 'n1/1', log: (l) => logs.push(l), now: () => clock.wall, ...opts,
      makeTranscoder: (o) => {
        // pending: pushed in, not handed back; it hands back what `speed` x the time since it started allows
        const x = {
          o, from: null, pushed: 0, out: 0, resets: 0,
          get pending() { return this.pushed - this.out },
          push(ts, k) {
            if (this.from === null) {
              if (!k) return // (after a reset, nothing until a keyframe, as Transcoder.push)
              this.from = clock.wall
            }
            this.pushed++
            const can = Math.floor(((clock.wall - this.from) / 1000) * fps * speed) + 1
            while (this.out < Math.min(this.pushed, can)) { this.out++; o.onFrame(ts, false, Buffer.from([1])) }
          },
          reset() { this.resets++; this.from = null; this.pushed = 0; this.out = 0 },
          endPicture() {},
          close() {}
        }
        xs.push(x)
        return x
      }
    })
    s.add(fakeWs())
    let most = 0
    for (let i = replay; i < replay + n; i++) {
      if (!burst) clock.wall = (i * 1000) / fps
      src.emit(frame(i))
      most = Math.max(most, xs[0]?.pending ?? 0)
    }
    return { xs, logs, most }
  }
  const FULL = { fps: 0, maxWidth: 1920, h264Only: true, ...REMOTE }
  const slow = lagging(FULL, { speed: 0.5 })
  check(`a remote PC's level-full conversion at half real time: reset once 2 s of the camera (40 pictures at 20 fps) has been in it for ${LAG_HOLD_MS / 1000} s`, slow.xs[0]?.resets >= 1 && slow.most > 40 && slow.most <= 51, `resets ${slow.xs[0]?.resets}, at most ${slow.most} in it`)
  check('  said once', slow.logs.filter((l) => l.includes('fell behind the camera')).length === 1 && slow.logs.some((l) => /^\[phone-live\] n1\/1: the conversion fell behind the camera: 5\d pictures in it, more than 2 s of them for 1 s; started again at the camera's next keyframe \(said once\)$/.test(l)), slow.logs.join(' | '))
  const fine = lagging(FULL, { speed: 1.2 })
  check('  at 1.2x real time: never reset (the 13 frames it learnt from, in it at its start, then 1 or 2)', fine.xs[0]?.resets === 0 && fine.most <= 13, `resets ${fine.xs[0]?.resets}, at most ${fine.most}`)
  const burst = lagging(FULL, { speed: 0.5, burst: true })
  check('  200 frames handed in at once, the clock standing still: not reset (a burst is not a converter behind)', burst.xs[0]?.resets === 0 && burst.most > 40, `resets ${burst.xs[0]?.resets}, at most ${burst.most}`)
  const joined = lagging(FULL, { speed: 2.5, fps: 30, keyEvery: 100, replay: 90 })
  check('  a new one converting from a 3 s GOP replayed at once (90 pictures in it), at 2.5x: not reset, it catches up', joined.xs[0]?.resets === 0 && joined.most > 60, `resets ${joined.xs[0]?.resets}, at most ${joined.most}`)
  const stuck = lagging(FULL, { speed: 0.8, fps: 30, keyEvery: 100, replay: 90, n: 300 })
  check('  ... at 0.8x it never catches up: reset 5 s after its first live frame, and a second over, at the latest', stuck.xs[0]?.resets >= 1, `resets ${stuck.xs[0]?.resets}, at most ${stuck.most}`)
  const phone = lagging({}, { speed: 0.5 })
  check('  a phone on the local network: as before, nothing reset', phone.xs[0]?.resets === 0 && !phone.logs.some((l) => l.includes('fell behind')), `resets ${phone.xs[0]?.resets}`)

  /**
   * A fresh level-full conversion of a 20 fps main whose GOP replayed as it joins is R frames (its
   * keyframe first), through a converter that hands back nothing until t0 s after its first frame (its
   * process, the probe, a 4K keyframe: 0.24-0.41 s on the server, transcode-ffmpeg.test's INFO) and then
   * runs at `speed` x real time; never: it hands back nothing at all. Live frames then come in real time.
   * resetAt: its first reset, in ms from the first live frame.
   */
  const starting = ({ R, speed, t0, fps = 20, keyEvery = 40, n = 120, never = false }) => {
    const clock = { wall: 0 }
    const frame = (i) => encodeFrame(Buffer.from([0, 0, 1, 1]), i % keyEvery === 0, 1, (i * 1000) / fps)
    const gop = Array.from({ length: R }, (_, i) => frame(i))
    const src = fakeSource()
    src.add = function (ws) { this.viewers.add(ws); for (const m of gop) ws.send(m) }
    const xs = []
    const logs = []
    const s = new PhoneStream({
      source: src, type: 0, slot: { release() {} }, camera: 'n1/1', log: (l) => logs.push(l), now: () => clock.wall, ...FULL,
      makeTranscoder: (o) => {
        const x = {
          o, from: null, ts: [], out: 0, resets: 0, resetAt: null,
          get pending() { return this.ts.length - this.out },
          tick() {
            if (this.from === null || never) return
            const can = Math.floor(((clock.wall - this.from) / 1000 - t0) * fps * speed)
            while (this.out < Math.min(this.ts.length, can)) o.onFrame(this.ts[this.out++], false, Buffer.from([1]))
          },
          push(ts, k) {
            if (this.from === null) {
              if (!k) return
              this.from = clock.wall
            }
            this.ts.push(ts)
            this.tick()
          },
          reset() { this.resets++; this.resetAt ??= clock.wall; this.from = null; this.ts = []; this.out = 0 },
          endPicture() {},
          close() {}
        }
        xs.push(x)
        return x
      }
    })
    s.add(fakeWs())
    // (the replay at 0, the first live frame 1/fps later, as lag-start.mjs has them)
    for (let i = R; i < R + n; i++) {
      clock.wall = ((i - R + 1) * 1000) / fps
      xs[0]?.tick()
      src.emit(frame(i))
    }
    const at = xs[0]?.resetAt
    return { resets: xs[0]?.resets ?? 0, resetAt: at == null ? null : at - 1000 / fps, logs }
  }
  // Armed before its first picture, a GOP replayed just under the line (40 pictures at 20 fps) went over
  // it while ffmpeg started, and a converter well above real time was reset at its open: ~1.5 s with
  // nothing on screen and a "fell behind" line (the review of d5390d6, lag-start.mjs: at 1.3x with its
  // first picture at 0.5 s, GOPs of 35-39 frames). Armed once a picture is back, and under the line.
  for (const speed of [1.68, 1.5, 1.3]) {
    for (const t0 of [0.3, 0.5]) {
      const hit = []
      for (let R = 1; R <= 40; R++) {
        const r = starting({ R, speed, t0 })
        if (r.resets > 0 || r.logs.some((l) => l.includes('fell behind'))) hit.push(R)
      }
      check(`a fresh level-full conversion at ${speed}x real time, its first picture ${t0} s after its first frame: not reset at its start, whatever its GOP replay (1-40 frames)`, hit.length === 0, hit.length ? `reset for GOP replays of ${hit.join(',')} frames` : 'none reset')
    }
  }
  // CATCH_UP_MS counts from the first live frame: from the replayed keyframe, a 3 s GOP (60 frames) left
  // it 2 s, and a 1.3x converter still 3 s of the camera behind was reset then.
  const long = starting({ R: 60, speed: 1.3, t0: 0.5, keyEvery: 80, n: 200 })
  check('  a 3 s GOP replayed (60 frames), first picture at 0.5 s, 1.3x: not reset (CATCH_UP_MS from the first live frame, not the replayed keyframe)', long.resets === 0, long.resets ? `reset at ${long.resetAt} ms` : 'not reset')
  // a converter that is really too slow is still reset, whatever its start
  const slowStart = starting({ R: 39, speed: 0.5, t0: 0.5, n: 200 })
  check('  one at 0.5x, its first picture at 0.5 s and a GOP of 39: still reset, said once', slowStart.resets >= 1 && slowStart.logs.filter((l) => l.includes('fell behind the camera')).length === 1, `resets ${slowStart.resets} at ${slowStart.resetAt} ms`)
  const slowOne = starting({ R: 1, speed: 0.8, t0: 0.3, n: 300 })
  check('  one at 0.8x from a lone keyframe: still reset', slowOne.resets >= 1, `resets ${slowOne.resets}`)
  // ...and one that hands back nothing at all (an ffmpeg that hangs): CATCH_UP_MS after the first live
  // frame, whatever has come back, and LAG_HOLD_MS over
  const hung = starting({ R: 20, speed: 1, t0: 0, never: true, n: 200 })
  check(`  one that hands back nothing: reset ${CATCH_UP_MS / 1000} s after the first live frame and ${LAG_HOLD_MS / 1000} s over, not before`, hung.resets >= 1 && hung.resetAt >= CATCH_UP_MS + LAG_HOLD_MS && hung.resetAt <= CATCH_UP_MS + LAG_HOLD_MS + 100, `resets ${hung.resets} at ${hung.resetAt} ms`)
}

// ---- an NVR's connection settings are edited: nvrs.mjs retires the Nvr (its hub's closeAll) and
// makes a new one under the same id. A conversion's tap has no close, so the old conversion stayed
// in the map under the same key: a phone that reconnected got its old replay and nothing after.
{
  const { StreamHub } = await import('../stream-hub.mjs')
  const sock = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, got: [], closed: null, handlers: {}, send(b) { this.got.push(b) }, on(e, f) { this.handlers[e] = f }, close(c, r) { this.closed = c + ' ' + r } })
  const make = (o) => ({ push(ts, k) { o.onFrame(ts, k, Buffer.from([1])) }, close() {} })
  const feed = (hub, n, from = 0) => { for (let i = from; i < from + n; i++) hub.onMessage({ t: 'frame', key: '2:1', buf: encodeFrame(Buffer.from([0, 0, 1, 1]), i % 30 === 0, 0, (i * 1000) / 30), isKey: i % 30 === 0 }) }
  const pool = new TranscodePool(4)
  const live = new PhoneLive({ pool, makeTranscoder: make, log: () => {} })
  const hub1 = new StreamHub('n1', () => {})
  const phone = sock()
  live.attach('n1/2/1', hub1.getStream(2, 1), 1, phone, { camera: 'n1/3' })
  feed(hub1, 60)
  const first = live.streams.get('n1/2/1')
  check('edited NVR: a phone plays before the edit', phone.got.length > 0 && !first.closed)
  hub1.closeAll()
  const hub2 = new StreamHub('n1', () => {})
  const phone2 = sock()
  const ok = live.attach('n1/2/1', hub2.getStream(2, 1), 1, phone2, { camera: 'n1/3' })
  const second = live.streams.get('n1/2/1')
  check('edited NVR: the next phone gets a conversion of the new stream, the old one closed', ok === true && first.closed && second !== first && second.source === hub2.getStream(2, 1) && hub2.getStream(2, 1).clients.size === 1)
  check('edited NVR: ... the viewer of the old one is dropped to reconnect, and its place given back', phone.closed === '1011 stream ended' && pool.active === 1, phone.closed + ', ' + pool.active + ' running')
  phone.handlers.close?.()
  const before = phone2.got.length
  feed(hub2, 120, 60)
  check('edited NVR: ... and the new one plays', phone2.got.length > before && live.streams.get('n1/2/1') === second, String(phone2.got.length - before))
  // the same stream handed in again joins the conversion that runs
  const phone3 = sock()
  live.attach('n1/2/1', hub2.getStream(2, 1), 1, phone3, { camera: 'n1/3' })
  check('the same stream again: the running conversion is joined, not made again', live.streams.get('n1/2/1') === second && !second.closed && pool.active === 1)
}

{
  const pool = new TranscodePool(1)
  const live = new PhoneLive({ pool, makeTranscoder, log: () => {} })
  const src = fakeSource(), a = fakeWs(), b = fakeWs()
  live.attach('failure/0/0', src, 0, a)
  live.attach('failure/0/0', src, 0, b)
  for (let i = 0; i < 24; i++) src.emit(encodeFrame(Buffer.from([0, 0, 1, 1]), i % 12 === 0, 1, i * 33.3))
  const failed = made.at(-1)
  failed.o.onFail(new Error('encoder stopped'))
  await new Promise(resolve => queueMicrotask(resolve))
  check('failed encoder closes both viewers and frees its source, slot and shared registry entry', a.readyState === 3 && b.readyState === 3 && src.viewers.size === 0 && pool.active === 0 && !live.has('failure/0/0'))
  const next = fakeWs()
  check('a reconnect after encoder failure can acquire a fresh conversion', live.attach('failure/0/0', src, 0, next) && pool.active === 1)
  live.streams.get('failure/0/0').close()
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
