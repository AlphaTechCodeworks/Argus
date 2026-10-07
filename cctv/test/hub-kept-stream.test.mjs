// A remote viewer's full-size view whose page stops reading and then reads again (adaptive-live.mjs
// pauses its conversion, then puts it back), with the camera's main stream from a live worker's hub
// (stream-hub.mjs). The pause takes the conversion's tap off the HubStream; its linger runs out and
// it leaves the hub. adaptive-live.mjs keeps it as the socket's source and adds to it again: it used
// to get no frames from then on, and its next linger sent an unwant that stopped the newer stream of
// the same camera under whoever watched it.
// Pure JS: no SDK, no NVR, no ffmpeg.
// Run:  node cctv/test/hub-kept-stream.test.mjs
import { AdaptiveLive, TICK_MS } from '../adaptive-live.mjs'
import { encodeFrame } from '../phone-live.mjs'
import { StreamHub } from '../stream-hub.mjs'
import { TranscodePool } from '../transcode.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const sent = []
// (the main stream's linger as 300 ms, not 10 s)
const hub = new StreamHub('n1', (m) => sent.push(`${m.t} ${m.ch}:${m.type}`), { stopDelayMs: { 0: 300, 1: 300 } })
const clock = { now: 1_000_000 }
const logs = []
const make = (o) => ({ push(ts, k) { o.onFrame(ts, k, Buffer.from([1])) }, close() {} })
const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: make, log: (l) => logs.push(l), budgetBps: 1e9, now: () => clock.now })
const fakeWs = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, got: [], handlers: {}, send(b) { this.got.push(b) }, on(e, f) { this.handlers[e] = f } })
// one page socket (/live-mux) and its channels
const page = { queued: 0, drainBps: null, written: 0, pending: null }
page.channel = () => ({ ...fakeWs(), overSince: null, get sharedBufferedAmount() { return page.queued }, get drainBps() { return page.drainBps }, get writtenBytes() { return page.written }, get socketPending() { return page.pending }, page })
let frame = 0
// the worker's frames of camera 6's main stream, as they reach the hub
const feed = (n) => {
  for (let i = frame; i < frame + n; i++) hub.onMessage({ t: 'frame', key: '5:0', buf: encodeFrame(Buffer.from([0, 0, 1, 1]), i % 12 === 0, 1, (i * 1000) / 30), isKey: i % 12 === 0 })
  frame += n
}
const look = (wrote) => {
  page.written += wrote
  feed(15)
  clock.now += TICK_MS
  live.tick()
}

const kept = hub.getStream(5, 0) // live-attach.mjs: nvr.getStream(ch, 0)
const ws = page.channel()
live.attach('pc', { ws, nvrId: 'n1', ch: 5, type: 0, source: kept, codec: 'h265', mayMain: () => true })
clearInterval(live.timer)
page.drainBps = 2_000_000
look(100_000)
look(100_000)
check('the full-size view plays', ws.got.length > 0 && hub.streams.get('5:0') === kept && sent.join() === 'want 5:0', `${ws.got.length} frames; ${sent.join(', ')}`)

// the page stops reading: its conversion is paused, and the hub's stream lingers out
page.queued = 6_000_000
page.drainBps = 0
for (let i = 0; i < 6; i++) look(0)
await sleep(450)
check('its page stops reading: the conversion is paused and the main stream leaves the hub', logs.some((l) => l.includes('paused')) && !hub.streams.has('5:0') && sent.at(-1) === 'unwant 5:0', sent.join(', '))

// the page writes again: back onto a conversion of the stream it kept
const at = ws.got.length
page.queued = 200_000
page.drainBps = 2_000_000
look(5_800_000)
feed(60)
check('it writes again: the stream it kept is the hub\'s again, asked for once', logs.some((l) => l.includes('writes again')) && hub.streams.get('5:0') === kept && sent.filter((m) => m === 'want 5:0').length === 2, sent.join(', '))
check('... and its picture is back', ws.got.length > at, `${ws.got.length - at} new frames`)

// its tile reconnects: the hub hands out the same stream, not a second one beside it
const again = hub.getStream(5, 0)
const ws2 = page.channel()
live.attach('pc', { ws: ws2, nvrId: 'n1', ch: 5, type: 0, source: again, codec: 'h265', mayMain: () => true })
ws.handlers.close()
feed(60)
check('a reconnecting tile finds the same stream and plays', again === kept && ws2.got.length > 0, `${ws2.got.length} frames`)

// the view is closed; the conversion ends 2 s later (FULL_STOP_MS) and the stream lingers. Someone
// else opens the camera inside that linger: nothing may stop it under them
ws2.handlers.close()
await sleep(2200)
const local = fakeWs()
const now = hub.getStream(5, 0)
now.add(local)
const unwants = sent.filter((m) => m === 'unwant 5:0').length
await sleep(450)
feed(12)
check('a viewer who opens the camera after that keeps it: no unwant under them', sent.filter((m) => m === 'unwant 5:0').length === unwants && now.wanted === true && hub.streams.get('5:0') === now && local.got.length > 0, sent.join(', '))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
