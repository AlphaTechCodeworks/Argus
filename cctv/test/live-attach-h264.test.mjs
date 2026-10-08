// Tests who is given the H.264 conversion of an H.265 sub-stream (live-attach.mjs with
// h264-fallback.mjs): a PC on the local network whose page said its browser cannot play H.265, and
// nobody else. Viewers who play H.265, phones and remote viewers go exactly where they went before.
// Fake NVRs, sockets and converters: nothing here needs ffmpeg or the SDK.
//   node cctv/test/live-attach-h264.test.mjs
import { FAILED, H264Fallback, NO_ROOM } from '../h264-fallback.mjs'
import { liveAttacher } from '../live-attach.mjs'
import { encodeFrame, parseFrame } from '../phone-live.mjs'
import { StreamHub } from '../stream-hub.mjs'
import { CODEC_H264, CODEC_H265 } from '../transcode.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const key = (codec) => encodeFrame(Buffer.from([0, 0, 0, 1, 1, 2, 3, 4]), true, codec, 1000)
const mkStream = (gop) => ({ gop, viewers: new Set(), add(w) { this.viewers.add(w) }, remove(w) { this.viewers.delete(w) } })
/** An NVR whose camera 4 (ch 3) has the sub-stream described. seen: what the NVR last saw it send; gop: the codec of its last keyframe, null for none yet. */
const mkNvr = ({ seen = 'h265', gop = CODEC_H265, mainSeen = 'h265' } = {}) => ({
  id: 'n1', liveOnline: true, streams: new Map(),
  codecSeen: new Map([...(seen ? [['3:1', { codec: seen }]] : []), ['3:0', { codec: mainSeen }]]),
  subHeld: () => false, subFull: () => false, mainPlaying: () => true,
  getStream(ch, type) {
    const k = `${ch}/${type}`
    if (!this.streams.has(k)) this.streams.set(k, mkStream(type === 1 ? (gop === null ? [] : [key(gop)]) : [key(mainSeen === 'h265' ? CODEC_H265 : CODEC_H264)]))
    return this.streams.get(k)
  }
})
const fakeWs = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, closedWith: null, handlers: {}, sent: [], send(d) { this.sent.push(d) }, on(e, f) { (this.handlers[e] ??= []).push(f); return this }, close(code, reason) { this.closedWith = { code, reason }; this.readyState = 3 } })
const req = (addr = '192.168.1.20', headers = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/109.0' }) => ({ socket: { remoteAddress: addr }, headers: { cookie: 'c=1', ...headers } })
const PHONE = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148' }

/** One attach, with a fallback that records what it is asked and answers `answer`. */
function run(o = {}, { r = req(), answer = true, enabled = true, withFallback = true, phoneOk = true } = {}) {
  const fallback = { enabled, calls: [], attach(k, source, ws, opts) { this.calls.push({ key: k, source, ws, opts }); return answer } }
  const adaptive = { calls: [], attach(viewer, a) { this.calls.push(a) } }
  const phone = { calls: [], attach(k, stream, type, ws, opts) { this.calls.push({ key: k, type, ws, opts }); return phoneOk }, detach() {}, room: () => 16, has: () => false }
  const tracked = []
  const attach = liveAttacher({ can: () => true, currentUser: () => 'ann', adaptiveLive: adaptive, phoneLive: phone, ...(withFallback ? { h264Fallback: fallback } : {}), track: (w, rq, what) => tracked.push(what), log: () => {} })
  const w = fakeWs()
  const nvr = o.nvr ?? mkNvr()
  attach(w, r, { nvr, who: { user: 'ann' }, ch: 3, streamType: 1, clientH265: false, noH265: false, phone15: false, ...o, nvr })
  const sub = nvr.getStream(3, 1)
  return { w, nvr, sub, fallback, adaptive, phone, tracked, raw: sub.viewers.has(w) }
}

// ---- who is converted ----
{
  let x = run({ noH265: true })
  check('H.265 sub-stream, a local PC whose page says it cannot play H.265, room: the shared conversion', x.fallback.calls.length === 1 && x.fallback.calls[0].key === 'n1/3/1' && x.fallback.calls[0].source === x.sub && x.fallback.calls[0].ws === x.w && !x.raw && x.w.closedWith === null)
  check('... which names its camera for the log, the channel from 1', x.fallback.calls[0].opts?.camera === 'n1/4')
  check('... let in and tracked like any sub-stream viewer (the live right on its camera)', JSON.stringify(x.tracked[0]) === '{"actions":["live"],"nvr":"n1","ch":3}', JSON.stringify(x.tracked))
  check('... nothing asked of the phones\' or the remote viewers\' paths', x.phone.calls.length === 0 && x.adaptive.calls.length === 0)

  x = run({ noH265: true }, { answer: NO_ROOM })
  check('no room in the budget: closed 1013 with the reason its tile shows, never left on H.265 it cannot play', x.w.closedWith?.code === 1013 && x.w.closedWith.reason === NO_ROOM && !x.raw, JSON.stringify(x.w.closedWith))
  x = run({ noH265: true }, { answer: FAILED })
  check('a conversion that failed: closed 1013 with that reason', x.w.closedWith?.code === 1013 && x.w.closedWith.reason === FAILED && !x.raw)
  check('the reasons fit a WebSocket close (123 bytes at most)', Buffer.byteLength(NO_ROOM) <= 123 && Buffer.byteLength(FAILED) <= 123 && NO_ROOM !== FAILED)
}

// ---- who is not ----
{
  let x = run({ clientH265: true })
  check('H.265 and a browser that plays it: the camera\'s own stream, the conversion never asked', x.raw && x.fallback.calls.length === 0 && x.w.closedWith === null)
  x = run({})
  check('H.265 and a page that did not say (an older page, or one that does not know yet): the camera\'s own stream, as always', x.raw && x.fallback.calls.length === 0)
  x = run({ noH265: true, nvr: mkNvr({ seen: 'h264', gop: CODEC_H264 }) })
  check('an H.264 camera is never converted, whatever the browser says', x.raw && x.fallback.calls.length === 0)
  x = run({ noH265: true, nvr: mkNvr({ seen: 'h265', gop: CODEC_H264 }) })
  check('... its last keyframe decides, not what the NVR saw earlier (a camera set to H.264 since)', x.raw && x.fallback.calls.length === 0)
  x = run({ noH265: true, nvr: mkNvr({ seen: 'h264', gop: CODEC_H265 }) })
  check('... and the other way round (set to H.265 since): converted', !x.raw && x.fallback.calls.length === 1)
  x = run({ noH265: true, nvr: mkNvr({ seen: 'h265', gop: null }) })
  check('no keyframe yet (a cold sub-stream), the NVR saw H.265 on it: converted', !x.raw && x.fallback.calls.length === 1)
  x = run({ noH265: true, nvr: mkNvr({ seen: null, gop: null }) })
  check('codec not known at all: the camera\'s own stream (no wait, no conversion started on a guess); the tile asks again if H.265 comes', x.raw && x.fallback.calls.length === 0)
  x = run({ noH265: true, streamType: 0 })
  check('a main stream is not converted: the camera\'s own, as before', x.nvr.getStream(3, 0).viewers.has(x.w) && x.fallback.calls.length === 0 && x.w.closedWith === null)
  x = run({ noH265: true }, { enabled: false })
  check('the budget set to nothing (off): the camera\'s own stream, as before', x.raw && x.fallback.calls.length === 0)
  x = run({ noH265: true }, { withFallback: false })
  check('no fallback handed in at all: the camera\'s own stream', x.raw && x.w.closedWith === null)
}

// ---- remote viewers and phones: their own paths, untouched ----
{
  // the tunnel arrives from 127.0.0.1, the tailnet from 100.64/10 (adaptive-live.mjs isRemoteAddress)
  for (const addr of ['127.0.0.1', '100.101.102.103']) {
    const x = run({ noH265: true }, { r: req(addr) })
    const a = x.adaptive.calls[0]
    check(`a remote viewer (${addr}) who cannot play H.265: the remote path, as before, with what it was told before`, x.adaptive.calls.length === 1 && a.ws === x.w && a.clientH265 === false && a.codec === 'h265' && a.type === 1 && a.source === x.sub && x.fallback.calls.length === 0 && !x.raw)
  }
  let x = run({ noH265: true, phone15: true }, { r: req('192.168.1.30', PHONE) })
  check('a phone asking for 15 fps: the phones\' shared stream, as before', x.phone.calls.length === 1 && x.phone.calls[0].key === 'n1/3/1' && x.phone.calls[0].ws === x.w && x.fallback.calls.length === 0 && !x.raw)
  x = run({ noH265: true, phone15: true }, { r: req('192.168.1.30', PHONE), phoneOk: false })
  check('... no room among the phones: the camera\'s own stream, as before (not this budget\'s)', x.phone.calls.length === 1 && x.fallback.calls.length === 0 && x.raw)
  x = run({ noH265: true, phone15: true })
  check('15 fps asked by a desktop is a desktop: converted', x.phone.calls.length === 0 && x.fallback.calls.length === 1)
}

// ---- the whole way, with the real hub and the real fallback ----
{
  const hub = new StreamHub('n1', () => {}, { stopDelayMs: { 0: 5, 1: 5 } })
  const nvr = { ...mkNvr(), getStream: (ch, type) => hub.getStream(ch, type) }
  const made = []
  const logs = []
  const h264Fallback = new H264Fallback({ units: 16, max: 1, stopDelayMs: 10, log: (l) => logs.push(l), makeTranscoder: (o) => { const t = { o, closed: false, push(ts, k) { o.onFrame(ts, k, Buffer.from([0, 0, 0, 1, k ? 0x65 : 0x41])) }, close() { this.closed = true } }; made.push(t); return t } })
  const attach = liveAttacher({ can: () => true, currentUser: () => 'ann', adaptiveLive: { attach() {} }, phoneLive: { attach: () => false, detach() {}, room: () => 0, has: () => false }, h264Fallback, log: () => {} })
  const frames = (w) => w.sent.filter((d) => typeof d !== 'string')
  const notes = (w) => w.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d))
  const sub = hub.getStream(3, 1)
  const h265 = (i) => encodeFrame(Buffer.from([0, 0, 0, 1, i % 30 === 0 ? 0x26 : 0x02, i]), i % 30 === 0, CODEC_H265, i * 66.7)
  const warm = fakeWs()
  sub.add(warm) // (someone already watching: the stream runs)
  for (let i = 0; i < 20; i++) sub.onFrame(h265(i), i % 30 === 0)
  const old = fakeWs() // the old office PC
  const modern = fakeWs() // a PC that plays H.265
  const silent = fakeWs() // a page that did not say
  attach(old, req('192.168.1.21'), { nvr, who: { user: 'ann' }, ch: 3, streamType: 1, clientH265: false, noH265: true, phone15: false })
  attach(modern, req('192.168.1.22'), { nvr, who: { user: 'ann' }, ch: 3, streamType: 1, clientH265: true, noH265: false, phone15: false })
  attach(silent, req('192.168.1.23'), { nvr, who: { user: 'ann' }, ch: 3, streamType: 1, clientH265: false, noH265: false, phone15: false })
  check('the old PC has a picture at once, converted from the camera\'s last keyframe on: H.264, 20 frames', made.length === 1 && frames(old).length === 20 && frames(old).every((f) => parseFrame(f).codec === CODEC_H264) && parseFrame(frames(old)[0]).isKey, `${made.length} ${frames(old).length}`)
  check('... with the camera\'s own capture times', frames(old).every((f, i) => Math.abs(parseFrame(f).ts - i * 66.7) < 0.01))
  check('... and its tile told it is converted', JSON.stringify(notes(old)) === '[{"op":"convert","on":true}]', JSON.stringify(notes(old)))
  check('the PC that plays H.265 has the camera\'s own bytes, untouched, and no note', frames(modern).length === 20 && frames(modern).every((f, i) => f.equals(h265(i))) && notes(modern).length === 0)
  check('... and so has the page that did not say', frames(silent).length === 20 && frames(silent).every((f, i) => f.equals(h265(i))) && notes(silent).length === 0)
  for (let i = 20; i < 35; i++) sub.onFrame(h265(i), i % 30 === 0)
  check('live: each on its own, frame for frame', frames(old).length === 35 && frames(modern).length === 35 && frames(modern)[34].equals(h265(34)) && parseFrame(frames(old)[34]).codec === CODEC_H264 && parseFrame(frames(old)[30]).isKey)
  const second = fakeWs()
  attach(second, req('192.168.1.24'), { nvr, who: { user: 'ann' }, ch: 3, streamType: 1, clientH265: false, noH265: true, phone15: false })
  check('a second old PC on the same camera: the same conversion, a picture at once from its last keyframe', made.length === 1 && h264Fallback.summary().running === 1 && frames(second).length === 5 && parseFrame(frames(second)[0]).isKey && Math.abs(parseFrame(frames(second)[0]).ts - 30 * 66.7) < 0.01)
  const other = fakeWs()
  const sub2 = hub.getStream(5, 1)
  sub2.add(fakeWs())
  for (let i = 0; i < 3; i++) sub2.onFrame(h265(i), i === 0)
  attach(other, req('192.168.1.21'), { nvr, who: { user: 'ann' }, ch: 5, streamType: 1, clientH265: false, noH265: true, phone15: false })
  check('another H.265 camera with the budget full: closed with "no room", and no H.265 sent to it', other.closedWith?.code === 1013 && other.closedWith.reason === NO_ROOM && frames(other).length === 0 && !sub2.clients.has(other))
  check('... the first camera\'s viewers are not disturbed', old.closedWith === null && modern.closedWith === null && made[0].closed === false)
  for (const w of [old, second]) for (const f of w.handlers.close ?? []) f()
  await new Promise((r) => setTimeout(r, 40))
  check('both old PCs gone: after its linger the conversion is closed and its place free', made[0].closed && h264Fallback.summary().running === 0)
  check('... the PC that plays H.265 never noticed', modern.closedWith === null && sub.clients.has(modern))
  for (const w of [modern, silent, warm]) for (const f of w.handlers.close ?? []) f()
  sub.remove(warm)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
