// Tests for the remote viewers' frame-rate levels (adaptive-live.mjs), with fake streams: no ffmpeg.
//   node cctv/test/adaptive-live.test.mjs
import { AdaptiveLive, CLIMB_AFTER_MS, LEVELS, REMOTE_CONVERSION, SETTLE_MS, TICK_MS, isRemoteAddress, nextLevel } from '../adaptive-live.mjs'
import { encodeFrame } from '../phone-live.mjs'
import { TranscodePool, ffmpegArgs } from '../transcode.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

// ---- who is remote ----
check('the Funnel (from tailscaled on this machine) is remote', isRemoteAddress('127.0.0.1') && isRemoteAddress('::ffff:127.0.0.1') && isRemoteAddress('::1'))
check('a tailnet device is remote', isRemoteAddress('100.114.214.72') && isRemoteAddress('::ffff:100.64.0.1'))
check('the local network is not', !isRemoteAddress('192.168.1.40') && !isRemoteAddress('10.0.0.5') && !isRemoteAddress('100.12.0.1'))

// ---- the decision ----
const T = 1_000_000
{
  let v = { level: 1, changedAt: T, cleanSince: T }
  let n = nextLevel(v, { pressure: true, now: T + 1000 })
  check('pressure right after a change waits for it to settle', n.level === 1)
  n = nextLevel(v, { pressure: true, now: T + SETTLE_MS })
  check('pressure once settled: one level down', n.level === 2, JSON.stringify(n))
  v = { level: 3, changedAt: T, cleanSince: T }
  check('never below the lowest level', nextLevel(v, { pressure: true, now: T + 60_000 }).level === 3)
  v = { level: 2, changedAt: T, cleanSince: T }
  check('clean, but not yet long enough: stays', nextLevel(v, { pressure: false, now: T + CLIMB_AFTER_MS - 1 }).level === 2)
  check('clean long enough: one level up', nextLevel(v, { pressure: false, now: T + CLIMB_AFTER_MS }).level === 1)
  v = { level: 0, changedAt: T, cleanSince: T }
  check('the camera\'s own stream is the top', nextLevel(v, { pressure: false, now: T + 999_999 }).level === 0)
  check('over the budget: down even without pressure', nextLevel({ level: 0, changedAt: T, cleanSince: T }, { pressure: false, overBudget: true, now: T + SETTLE_MS }).level === 1)
}

// ---- moving viewers between streams ----
function fakeSource(name) {
  return { name, viewers: new Set(), add(ws) { this.viewers.add(ws) }, remove(ws) { this.viewers.delete(ws) } }
}
function fakeWs() {
  return { OPEN: 1, readyState: 1, bufferedAmount: 0, got: [], handlers: {}, send(b) { this.got.push(b) }, on(e, f) { this.handlers[e] = f } }
}
{
  let now = T
  const logs = []
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: () => ({ push() {}, close() {} }), log: (l) => logs.push(l), budgetBps: 1e9, now: () => now })
  const src = fakeSource('cam') // an H.264 camera (no H.265 keyframe seen)
  const ws = fakeWs()
  live.attach('session-a', { ws, nvrId: 'n1', ch: 0, type: 1, source: src })
  const v = live.viewers.get('session-a')
  check('a remote viewer starts on the camera own stream (no wait for a conversion)', LEVELS[v.level].id === 'full' && src.viewers.has(ws))
  ws.bufferedAmount = 1e6
  now += SETTLE_MS
  live.tick()
  check('its link backing up: onto the shared 15 fps stream', LEVELS[v.level].id === '15' && !src.viewers.has(ws) && live.streams.size === 1, logs.at(-1))
  now += SETTLE_MS
  live.tick()
  check('still backing up: 8 fps', LEVELS[v.level].id === '8')
  ws.bufferedAmount = 0
  now += CLIMB_AFTER_MS
  live.tick()
  check('clean for 20 s: back up to 15', LEVELS[v.level].id === '15')
  now += CLIMB_AFTER_MS
  live.tick()
  check('and on to the camera own stream', v.level === 0 && src.viewers.has(ws))
  const sum = live.summary()
  check('the summary counts the viewer and its level', sum.viewers.length === 1 && sum.viewers[0].level === 'full')
  ws.handlers.close()
  check('closing the socket forgets the viewer', live.viewers.size === 0)
  clearInterval(live.timer)
}
{
  // an H.265 camera at the top level: converted, never sent raw (a laptop without HEVC shows black)
  const live = new AdaptiveLive({ pool: new TranscodePool(4), makeTranscoder: () => ({ push() {}, close() {} }), log: () => {}, budgetBps: 1e9 })
  const src = fakeSource('h265')
  src.gop = [Buffer.from([1, 1])]
  const ws = fakeWs()
  live.attach('s2', { ws, nvrId: 'n1', ch: 3, type: 1, source: src })
  check('an H.265 camera is converted even at the top level', !src.viewers.has(ws) && live.streams.size === 1)
  clearInterval(live.timer)
}
{
  // a device that plays H.265 is sent the H.265 camera as it is: half the data, no conversion
  const live = new AdaptiveLive({ pool: new TranscodePool(4), makeTranscoder: () => ({ push() {}, close() {} }), log: () => {}, budgetBps: 1e9 })
  const src = fakeSource('h265')
  src.gop = [Buffer.from([1, 1])]
  const ws = fakeWs()
  live.attach('s3', { ws, nvrId: 'n1', ch: 4, type: 1, source: src, clientH265: true })
  check('a device that plays H.265 gets the H.265 camera untouched', src.viewers.has(ws) && live.streams.size === 0)
  clearInterval(live.timer)
}
{
  // no room for a conversion: the camera's own stream, never nothing
  const live = new AdaptiveLive({ pool: new TranscodePool(0), makeTranscoder: () => ({ push() {}, close() {} }), log: () => {}, budgetBps: 1e9 })
  const src = fakeSource('cam')
  src.gop = [Buffer.from([1, 1])]
  const ws = fakeWs()
  live.attach('s', { ws, nvrId: 'n1', ch: 0, type: 1, source: src })
  check('no conversion slot left: gets the camera own stream', src.viewers.has(ws))
  clearInterval(live.timer)
}
{
  // one H.265 camera does not drag the viewer's other cameras into conversions (2026-09-26)
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: () => ({ push() {}, close() {} }), log: () => {}, budgetBps: 1e9 })
  const h264 = fakeSource('sub')
  h264.gop = [Buffer.from([1, 0])]
  const h265 = fakeSource('main')
  const wsA = fakeWs()
  const wsB = fakeWs()
  live.attach('mix', { ws: wsA, nvrId: 'n1', ch: 5, type: 1, source: h264 })
  live.attach('mix', { ws: wsB, nvrId: 'n1', ch: 5, type: 0, source: h265 }) // no keyframe seen yet
  h265.gop = [Buffer.from([1, 1])] // ...then it turns out to be H.265
  live.tick()
  const v = live.viewers.get('mix')
  check('mixed: the viewer stays at full', v.level === 0, String(v.level))
  check('mixed: the H.264 camera stays on its own stream', h264.viewers.has(wsA))
  check('mixed: only the H.265 one is converted', !h265.viewers.has(wsB) && live.streams.size === 1, String(live.streams.size))
  clearInterval(live.timer)
}

{
  // a level's conversion names its camera in the log, the channel counted from 1 (stutter report 2.10)
  const logs = []
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: () => ({ push() {}, close() {} }), log: (l) => logs.push(l), budgetBps: 1e9 })
  const src = fakeSource('cam')
  src.gop = [Buffer.from([1, 1])] // H.265: converted at once, even at the top level
  live.attach('named', { ws: fakeWs(), nvrId: 'nvr-2', ch: 4, type: 0, source: src })
  const frameAt = (i) => {
    const b = Buffer.alloc(24)
    b[0] = i % 12 === 0 ? 1 : 0
    b[1] = 1
    b.writeBigInt64LE(BigInt(Math.round(i * 33.3 * 1000)), 8)
    return b
  }
  for (let i = 0; i < 13; i++) for (const tap of src.viewers) tap.send(frameAt(i))
  check('a level\'s conversion names its camera in the log', logs.some((l) => l.startsWith('[phone-live] nvr-2/5: converting a main stream')), logs.join(' | '))
  clearInterval(live.timer)
}

{
  // Every level change says what the link looked like: the page's queue, how fast it drains (so how
  // long that queue takes), channels held over their cap, and how many tiles were left on the raw
  // stream for want of a conversion slot. On 29 Sep 12 steps down said only "video backing up", and
  // nobody could tell which were real (verify-1, correction 5).
  let now = T
  const logs = []
  const live = new AdaptiveLive({ pool: new TranscodePool(1), makeTranscoder: () => ({ push() {}, close() {} }), log: (l) => logs.push(l), budgetBps: 1e9, now: () => now })
  const page = { sharedBufferedAmount: 0, drainBps: null } // the page's one socket, as its channels see it
  const channel = () => ({ ...fakeWs(), get sharedBufferedAmount() { return page.sharedBufferedAmount }, get drainBps() { return page.drainBps }, overSince: null })
  const ws = [channel(), channel(), channel()]
  ws.forEach((w, i) => live.attach('link', { ws: w, nvrId: 'nvr-2', ch: i, type: 1, source: fakeSource(`cam${i}`) }))
  page.sharedBufferedAmount = 1_900_000
  page.drainBps = 600_000 // 4.8 Mbit/s
  ws[2].overSince = T
  now += SETTLE_MS
  live.tick()
  check('a step down logs the queue, its drain rate and how long it takes, those held over their cap, and the tiles left raw for want of a slot',
    logs.at(-1) === '[adaptive] link: full -> 15 (video backing up on its link; 3 cameras; 1.90 MB queued, draining at 4.8 Mbit/s (3.2 s), 1 held over its cap; 2 on the raw stream for want of a conversion slot, 0 of 1 free)', logs.at(-1))
  page.sharedBufferedAmount = 0
  page.drainBps = null
  ws[2].overSince = null
  now += CLIMB_AFTER_MS
  live.tick()
  // (the level it left gives its slot back there and then: 1 of 1 free)
  check('a climb logs the same, with an idle link', logs.at(-1) === '[adaptive] link: 15 -> full (clean for 20 s; 3 cameras; 0.00 MB queued, draining: idle; 0 on the raw stream for want of a conversion slot, 1 of 1 free)', logs.at(-1))
  // a burst queued just before the look: too little busy time yet to say how fast it drains, which
  // is not "idle" with megabytes queued (review of 29 Sep)
  page.sharedBufferedAmount = 1_900_000
  now += SETTLE_MS
  live.tick()
  check('... megabytes queued, no rate yet: "not measured yet", not "idle"', logs.at(-1).includes('; 1.90 MB queued, draining: not measured yet;'), logs.at(-1))
  page.sharedBufferedAmount = 0
  now += CLIMB_AFTER_MS
  live.tick()
  // a viewer on plain /live sockets (no page socket to measure): the queue, and no rate
  const solo = fakeWs()
  live.attach('solo', { ws: solo, nvrId: 'n1', ch: 9, type: 1, source: fakeSource('cam9') })
  solo.bufferedAmount = 300_000
  now += SETTLE_MS
  live.tick()
  check('... a plain /live socket: its queue, no drain rate', logs.some((l) => l.startsWith('[adaptive] solo: full -> 15 (video backing up on its link; 1 camera; 0.30 MB queued; ')), logs.join(' | '))
  clearInterval(live.timer)
}

// ---- conversion slots at a level change (verify-1) ----
// A camera stream as the fan-out has it: a new viewer (or a level's stream joining it) is sent its GOP.
function gopSource(fps, n = 20) {
  const gop = fps > 0 ? Array.from({ length: n }, (_, i) => encodeFrame(Buffer.from([0, 0, 1, 1]), i === 0, 0, (i * 1000) / fps)) : []
  return { gop, viewers: new Set(), add(ws) { this.viewers.add(ws); for (const f of gop) ws.send(f) }, remove(ws) { this.viewers.delete(ws) } }
}
/** Held over its cap for 3 s at every look: pressure, whatever else the rules say. */
const heldAt = (socks, now) => { for (const ws of socks) ws.overSince = now - 3000 }
{
  // verify-1's replay of the 03:55 page: 16 sub tiles, 4 at 20.6 fps (sent as they are at 15), 6 at
  // 30 fps (converted at every level) and 6 cold (a level's stream for them keeps its slot while it
  // waits for frames), and pressure at every look. The new level's streams took their slots before the
  // old level's gave theirs back, 10 s later: 12 of the 16 were left on the camera's own stream at 8,
  // and all 16 at 4 -- more to send, not less.
  let now = T
  const pool = new TranscodePool(16)
  const live = new AdaptiveLive({ pool, makeTranscoder: () => ({ push() {}, close() {} }), log: () => {}, budgetBps: 1e9, now: () => now })
  const fps = [...Array(4).fill(20.6), ...Array(6).fill(30), ...Array(6).fill(0)]
  const socks = fps.map((f, i) => {
    const ws = fakeWs()
    live.attach('slots', { ws, nvrId: 'nvr-2', ch: i, type: 1, source: gopSource(f) })
    return ws
  })
  const v = live.viewers.get('slots')
  const raw = () => [...v.sockets].filter((e) => e.stream === e.source).length
  const seen = {}
  for (let i = 0; i < 10 && v.level < 3; i++) {
    now += 2000
    heldAt(socks, now)
    live.tick()
    seen[LEVELS[v.level].id] = `${raw()} raw, ${pool.active} slots`
  }
  check('16 tiles stepped down to 8 and to 4: none left on the camera\'s own stream for want of a slot (were 12 and 16)',
    v.level === 3 && seen['8'].startsWith('0 raw') && seen['4'].startsWith('0 raw'), JSON.stringify(seen))
  clearInterval(live.timer)
}
{
  // A tile left on the camera's own stream for want of a slot stayed there for as long as the page
  // stayed on that level: only a level change looked again (verify-1). Now every look does.
  let now = T
  const pool = new TranscodePool(2)
  const live = new AdaptiveLive({ pool, makeTranscoder: () => ({ push() {}, close() {} }), log: () => {}, budgetBps: 1e9, now: () => now })
  const phone = pool.acquire() // a phone's conversion holds one of the two
  const socks = [fakeWs(), fakeWs()]
  socks.forEach((ws, i) => live.attach('retry', { ws, nvrId: 'n1', ch: i, type: 1, source: gopSource(30) }))
  const v = live.viewers.get('retry')
  now += SETTLE_MS
  heldAt(socks, now)
  live.tick()
  const raw = () => [...v.sockets].filter((e) => e.stream === e.source).length
  check('one slot for two tiles at 15: one converted, one on the camera\'s own stream', LEVELS[v.level].id === '15' && raw() === 1, `level ${LEVELS[v.level].id}, ${raw()} raw`)
  for (const ws of socks) ws.overSince = null
  phone.release()
  now += TICK_MS
  live.tick()
  check('... the phone lets its slot go: the next look puts that tile on its conversion', LEVELS[v.level].id === '15' && raw() === 0, `${raw()} raw`)
  clearInterval(live.timer)
}
{
  // More than half the tiles on the camera's own stream for want of a slot: a level lower finds no
  // more slots and thins none of them, and only moves the rest again. It stays, and says so once.
  let now = T
  const logs = []
  const live = new AdaptiveLive({ pool: new TranscodePool(1), makeTranscoder: () => ({ push() {}, close() {} }), log: (l) => logs.push(l), budgetBps: 1e9, now: () => now })
  const socks = [fakeWs(), fakeWs(), fakeWs()]
  socks.forEach((ws, i) => live.attach('starved', { ws, nvrId: 'n1', ch: i, type: 1, source: gopSource(30) }))
  const v = live.viewers.get('starved')
  for (let i = 0; i < 6; i++) {
    now += TICK_MS
    heldAt(socks, now)
    live.tick()
  }
  const stays = logs.filter((l) => l.startsWith('[adaptive] starved: stays at 15'))
  check('2 of 3 tiles on the raw stream at 15: no step to 8 under pressure', LEVELS[v.level].id === '15', logs.join(' | '))
  check('... said once, with why and the tiles on the raw stream',
    stays.length === 1 && /^\[adaptive\] starved: stays at 15, a level lower would find no conversion slot either \(.+; 3 cameras; 0\.00 MB queued, 3 held over their cap; 2 on the raw stream for want of a conversion slot, 0 of 1 free\)$/.test(stays[0]), logs.join(' | '))
  clearInterval(live.timer)
}

// ---- conversions for a PC through the tunnel (stutter report 2.7) ----
// A converter that hands back every frame it keeps, and the frames a source sends its viewers.
function converters() {
  const made = []
  const make = (o) => {
    const x = { o, n: 0, push(ts, k) { if (this.n++ % o.keepEvery === 0) o.onFrame(ts, k, Buffer.from([1])) }, close() { this.closed = true } }
    made.push(x)
    return x
  }
  return { made, make }
}
const send = (src, n, { fps = 30, codec = 1, from = 0 } = {}) => {
  for (let i = from; i < from + n; i++) for (const v of [...src.viewers]) v.send(encodeFrame(Buffer.from([0, 0, 1, 1]), i % 12 === 0, codec, (i * 1000) / fps))
}
{
  // Level full, an H.265 main for a browser without H.265: it went through level 15's settings (a 30 fps
  // camera kept 1 in 2 at 1280 wide, "converting a main stream at 30.0 fps to about 15" while at full,
  // 03:56:59). Now every frame, at most 1920 wide, 2.5 Mbit/s with a 1 s buffer and two decoder threads
  // (playback's settings, transcode.mjs PLAYBACK_LIMITS), a keyframe every 2 s.
  const { made, make } = converters()
  const logs = []
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: make, log: (l) => logs.push(l), budgetBps: 1e9 })
  const src = fakeSource('h265 main')
  src.gop = [encodeFrame(Buffer.from([0, 0, 1, 1]), true, 1, 0)]
  const ws = fakeWs()
  live.attach('pc', { ws, nvrId: 'nvr-2', ch: 19, type: 0, source: src })
  send(src, 24)
  const o = made[0]?.o ?? {}
  check('level full, an H.265 main for a PC: its own conversion, every frame kept (not level 15\'s 1 in 2)', live.streams.has('nvr-2/19/0@full') && made.length === 1 && o.keepEvery === 1, `${[...live.streams.keys()]} keep ${o.keepEvery}`)
  const a = made[0] ? ffmpegArgs(o).join(' ') : ''
  check('  playback\'s settings: at most 1920 wide, 2.5 Mbit/s with a 1 s buffer, two decoder threads; a keyframe every 2 s (60 pictures at 30 fps)', !a.includes('select') && a.includes('-vf scale=min(1920\\,iw):-2') && a.includes('-maxrate 2500k -bufsize 2500k') && a.includes('-threads 2') && !a.includes('low_delay') && / -g 60 /.test(a), a)
  check('  every frame from its first keyframe reaches the browser, as H.264', ws.got.length === 12 && ws.got.every((b) => b[1] === 0), `${ws.got.length} frames`)
  check('  the log says so', logs.includes('[phone-live] nvr-2/20: converting a main stream at 30.0 fps to H.264, every frame kept'), logs.join(' | '))
  check('LEVELS: full carries the settings its H.265 conversion uses', LEVELS[0].id === 'full' && LEVELS[0].fps === 0 && LEVELS[0].maxWidth === 1920 && LEVELS[0].mainKbps === 2500 && LEVELS[0].crf === 25 && LEVELS[0].subKbps === 700, JSON.stringify(LEVELS[0]))
  clearInterval(live.timer)
}
{
  // Every level converts with a 1 s buffer, two decoder threads and a keyframe every 2 s of what it
  // sends: -g 50 counted pictures, 4.2 s at 12 fps, 6.3 at 8 and 12.5 at 4 to wait after a drop.
  let now = T
  const { made, make } = converters()
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: make, log: () => {}, budgetBps: 1e9, now: () => now })
  const src = fakeSource('24 fps sub')
  src.gop = [encodeFrame(Buffer.from([0, 0, 1, 1]), true, 0, 0)]
  const ws = fakeWs()
  live.attach('steps', { ws, nvrId: 'n1', ch: 1, type: 1, source: src })
  ws.bufferedAmount = 1e6
  const seen = []
  for (const id of ['15', '8', '4']) {
    now += SETTLE_MS
    live.tick()
    send(src, 13, { fps: 24, codec: 0, from: 12 })
    const x = made.at(-1)
    const a = x ? ffmpegArgs(x.o).join(' ') : ''
    seen.push({ id: LEVELS[live.viewers.get('steps').level].id, keep: x?.o.keepEvery, buf: a.match(/-bufsize (\d+k)/)?.[1], threads: /-threads 2 /.test(a) && !/low_delay/.test(a), g: a.match(/ -g (\d+) /)?.[1] })
  }
  check('levels 15, 8, 4 on a 24 fps sub: 1 in 2, 3, 6; the buffer 1 s of each cap; two decoder threads; a keyframe every 24, 16, 8 pictures (2 s each)',
    JSON.stringify(seen) === JSON.stringify([{ id: '15', keep: 2, buf: '700k', threads: true, g: '24' }, { id: '8', keep: 3, buf: '450k', threads: true, g: '16' }, { id: '4', keep: 6, buf: '280k', threads: true, g: '8' }]), JSON.stringify(seen))
  clearInterval(live.timer)
}
{
  // An H.265 main at full, then the link backs up: its socket moves to level 15's own conversion (1 in 2)
  let now = T
  const { made, make } = converters()
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: make, log: () => {}, budgetBps: 1e9, now: () => now })
  const src = fakeSource('h265 main')
  src.gop = [encodeFrame(Buffer.from([0, 0, 1, 1]), true, 1, 0)]
  const ws = fakeWs()
  live.attach('down', { ws, nvrId: 'n1', ch: 4, type: 0, source: src })
  send(src, 13)
  ws.bufferedAmount = 1e6
  now += SETTLE_MS
  live.tick()
  send(src, 13, { from: 12 })
  check('an H.265 main stepped down from full: onto level 15\'s conversion, 1 in 2 of 30 fps', live.streams.has('n1/4/0@15') && made.length === 2 && made[1].o.keepEvery === 2 && made[1].o.maxWidth === 1280, `${[...live.streams.keys()]} ${made.map((x) => x.o.keepEvery)}`)
  clearInterval(live.timer)
}
{
  // A main started on demand has no keyframe yet when the socket joins. Its first keyframe, H.265,
  // went out raw until the next tick moved the socket: the PC's decoder cannot take it, and the
  // full-size view fell back to the sub-stream for 2 minutes (viewer.js NO_MAIN_MS). The NVR's
  // codecSeen says what the camera sends (live-attach.mjs passes it as codec).
  const { made, make } = converters()
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: make, log: () => {}, budgetBps: 1e9 })
  const cold = fakeSource('cold main')
  const ws = fakeWs()
  live.attach('cold', { ws, nvrId: 'n1', ch: 2, type: 0, source: cold, codec: 'h265' })
  check('no keyframe yet, H.265 seen on it: converted from the start, not the raw stream', !cold.viewers.has(ws) && live.streams.has('n1/2/0@full'), [...live.streams.keys()].join())
  send(cold, 24)
  check('  its first keyframe never reaches the browser as H.265', ws.got.length === 12 && ws.got.every((b) => b[1] === 0) && made.length === 1, `${ws.got.length} frames, codecs ${[...new Set(ws.got.map((b) => b[1]))]}`)
  const h264 = fakeSource('cold h264')
  const w2 = fakeWs()
  live.attach('cold', { ws: w2, nvrId: 'n1', ch: 3, type: 0, source: h264, codec: 'h264' })
  const none = fakeSource('never seen')
  const w3 = fakeWs()
  live.attach('cold', { ws: w3, nvrId: 'n1', ch: 5, type: 0, source: none })
  check('  H.264 seen, or nothing seen yet: the camera\'s own stream, as before', h264.viewers.has(w2) && none.viewers.has(w3))
  const plays = fakeSource('cold, H.265-capable')
  const w4 = fakeWs()
  live.attach('other', { ws: w4, nvrId: 'n1', ch: 6, type: 0, source: plays, codec: 'h265', clientH265: true })
  check('  a browser that plays H.265: the camera\'s own stream', plays.viewers.has(w4))
  // what the stream itself shows wins: the camera was changed to H.264 since it was seen
  const changed = fakeSource('now h264')
  const w5 = fakeWs()
  live.attach('cold', { ws: w5, nvrId: 'n1', ch: 7, type: 0, source: changed, codec: 'h265' })
  changed.gop = [encodeFrame(Buffer.from([0, 0, 1, 1]), true, 0, 0)]
  live.tick()
  check('  its keyframe says H.264 after all: the next tick puts it on the camera\'s own stream', changed.viewers.has(w5) && !live.streams.get('n1/7/0@full')?.clients.has(w5))
  clearInterval(live.timer)
}
{
  // A camera that trickles (0.8 fps, every frame a keyframe: nvr-2's wharf cameras on 29 Sep). A level's
  // new stream of it learnt its rate from 12 frames and sent nothing for 15 s: at 04:08:08.8 a step
  // down left two such tiles with nothing new until 04:08:22.9 (stutter report 2.9). A remote viewer's
  // streams decide within 1 s of capture time, a sub-stream's frames going out as they come meanwhile.
  let now = T
  const { made, make } = converters()
  const logs = []
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: make, log: (l) => logs.push(l), budgetBps: 1e9, now: () => now })
  const src = fakeSource('trickling sub')
  const ws = fakeWs()
  live.attach('trickle', { ws, nvrId: 'nvr-2', ch: 30, type: 1, source: src })
  ws.bufferedAmount = 1e6
  now += SETTLE_MS
  live.tick() // full -> 15: onto a new stream of its own
  ws.bufferedAmount = 0
  const frame = (i) => { for (const v of [...src.viewers]) v.send(encodeFrame(Buffer.from([0, 0, 1, 1]), true, 0, i * 1250)) }
  check('REMOTE_CONVERSION: a remote viewer\'s stream decides its rate within 1 s of capture time', REMOTE_CONVERSION.learnMs === 1000, JSON.stringify(REMOTE_CONVERSION))
  frame(0)
  check('a remote viewer stepped down on a sub-stream trickling at 0.8 fps: its next frame goes out as it comes', LEVELS[live.viewers.get('trickle').level].id === '15' && ws.got.length === 1, `${ws.got.length} sent`)
  frame(1)
  check('  its rate decided at the second frame (1.25 s), not the 13th (15 s): sent as it is', logs.includes('[phone-live] nvr-2/31: a sub stream at 0.8 fps: sent as it is') && ws.got.length === 2 && made.length === 0, logs.join(' | '))
  clearInterval(live.timer)
}
{
  // ...and a trickle that is converted lets each picture out as it goes in: ffmpeg held two back, 2.7 s
  // each at 0.8 fps (measured through the real ffmpeg, 29 Sep). Under 10 fps: low_delay, each picture ended.
  const { made, make } = converters()
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: make, log: () => {}, budgetBps: 1e9 })
  const src = fakeSource('trickling h265 main')
  live.attach('slow', { ws: fakeWs(), nvrId: 'nvr-2', ch: 0, type: 0, source: src, codec: 'h265' })
  for (const i of [0, 1]) for (const v of [...src.viewers]) v.send(encodeFrame(Buffer.from([0, 0, 1, 1]), true, 1, i * 1250))
  check('REMOTE_CONVERSION: a source under 10 fps is converted picture by picture', REMOTE_CONVERSION.slowFps === 10 && made.length === 1 && made[0].o.lowDelay === true, JSON.stringify(REMOTE_CONVERSION))
  clearInterval(live.timer)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
