// Tests live video thinned for phones (phone-live.mjs), with a fake converter: no ffmpeg needed.
//   node cctv/test/phone-live.test.mjs
import { PhoneLive, encodeFrame, frameRate, isPhoneRequest, keepEveryFor, parseFrame } from '../phone-live.mjs'
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

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
