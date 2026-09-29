// Tests for the remote viewers' frame-rate levels (adaptive-live.mjs), with fake streams: no ffmpeg.
//   node cctv/test/adaptive-live.test.mjs
import { AdaptiveLive, CLIMB_AFTER_MS, LEVELS, REMOTE_CONVERSION, SETTLE_MS, TICK_MS, isRemoteAddress, nextLevel } from '../adaptive-live.mjs'
import { encodeFrame } from '../phone-live.mjs'
import { TranscodePool, ffmpegArgs } from '../transcode.mjs'
import { camera, openPage } from './remote-page.mjs'

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
{
  // A climb that fails (a step down within 30 s of it) doubles the wait before the next, up to 80 s,
  // and 5 minutes with nothing piling up puts it back to 20 s. On 29 Sep a climb at 04:07:46 was
  // stepped down again at 04:08:08. Only a failed climb: one burst must not keep a page low (verify-1).
  let v = nextLevel({ level: 1, changedAt: T - 30_000, cleanSince: T - CLIMB_AFTER_MS }, { pressure: null, now: T })
  check('clean for 20 s: up', v.level === 0 && v.why === 'clean for 20 s', JSON.stringify(v))
  v = nextLevel(v, { pressure: true, now: T + 10_000 })
  check('down 10 s after that climb: the next one waits 40 s clean', v.level === 1 && v.climbAfterMs === 40_000, JSON.stringify(v))
  check('... not after 20 s', nextLevel(v, { pressure: null, now: T + 30_000 }).level === 1)
  v = nextLevel(v, { pressure: null, now: T + 50_000 })
  check('... after 40 s: up', v.level === 0 && v.why === 'clean for 40 s', JSON.stringify(v))
  v = nextLevel(v, { pressure: true, now: T + 55_000 })
  v = nextLevel(v, { pressure: null, now: T + 135_000 })
  check('down again 5 s after it: 80 s clean before the next', v.level === 0 && v.why === 'clean for 80 s', JSON.stringify(v))
  v = nextLevel(v, { pressure: true, now: T + 140_000 })
  check('... and again: still 80 s, no more', v.level === 1 && v.climbAfterMs === 80_000, JSON.stringify(v))
  v = nextLevel(v, { pressure: null, now: T + 140_000 + 5 * 60_000 - 1 })
  check('... 5 minutes with nothing piling up, less 1 ms: still 80 s', v.climbAfterMs === 80_000 && v.level === 0)
  v = nextLevel({ ...v, level: 1 }, { pressure: null, now: T + 140_000 + 5 * 60_000 })
  check('... at 5 minutes: back to 20 s', v.climbAfterMs === CLIMB_AFTER_MS, JSON.stringify(v))
  // down 31 s after a climb: the climb held
  const up = nextLevel({ level: 2, changedAt: T - 30_000, cleanSince: T - CLIMB_AFTER_MS }, { pressure: null, now: T })
  check('down 31 s after a climb: that climb held, the wait stays 20 s', nextLevel(up, { pressure: true, now: T + 31_000 }).climbAfterMs === CLIMB_AFTER_MS)
  // two steps down after one climb: the second follows a step, not a climb
  const once = nextLevel(nextLevel(up, { pressure: true, now: T + 5000 }), { pressure: true, now: T + 9000 })
  check('two steps down after one climb: doubled once', once.level === 3 && once.climbAfterMs === 40_000, JSON.stringify(once))
}

// ---- moving viewers between streams ----
function fakeSource(name) {
  return { name, viewers: new Set(), add(ws) { this.viewers.add(ws) }, remove(ws) { this.viewers.delete(ws) } }
}
function fakeWs() {
  return { OPEN: 1, readyState: 1, bufferedAmount: 0, got: [], handlers: {}, send(b) { this.got.push(b) }, on(e, f) { this.handlers[e] = f } }
}
// A camera stream as the fan-out has it: a new viewer (or a level's stream joining it) is sent its GOP.
function gopSource(fps, n = 20) {
  const gop = fps > 0 ? Array.from({ length: n }, (_, i) => encodeFrame(Buffer.from([0, 0, 1, 1]), i === 0, 0, (i * 1000) / fps)) : []
  return { gop, viewers: new Set(), add(ws) { this.viewers.add(ws); for (const f of gop) ws.send(f) }, remove(ws) { this.viewers.delete(ws) } }
}
/** A link that cannot keep up, as plainly as it shows: each socket held over its cap for 3 s at this look. */
const heldAt = (socks, now) => { for (const ws of socks) ws.overSince = now - 3000 }
{
  let now = T
  const logs = []
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: () => ({ push() {}, close() {} }), log: (l) => logs.push(l), budgetBps: 1e9, now: () => now })
  const src = fakeSource('cam') // an H.264 camera (no H.265 keyframe seen)
  const ws = fakeWs()
  live.attach('session-a', { ws, nvrId: 'n1', ch: 0, type: 1, source: src })
  const v = live.viewers.get('session-a')
  check('a remote viewer starts on the camera own stream (no wait for a conversion)', LEVELS[v.level].id === 'full' && src.viewers.has(ws))
  now += SETTLE_MS
  heldAt([ws], now)
  live.tick()
  check('its link backing up: onto the shared 15 fps stream', LEVELS[v.level].id === '15' && !src.viewers.has(ws) && live.streams.size === 1, logs.at(-1))
  now += SETTLE_MS
  heldAt([ws], now)
  live.tick()
  check('still backing up: 8 fps', LEVELS[v.level].id === '8')
  ws.overSince = null
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
  page.drainBps = 600_000 // 4.8 Mbit/s: 3.2 s to go, at this look and the next
  now += TICK_MS
  live.tick()
  now += TICK_MS
  ws[2].overSince = now - 1000 // held over its cap for a second
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
  // is not "idle" with megabytes queued (review of 29 Sep); the step is a tile's, held over its cap
  page.sharedBufferedAmount = 1_900_000
  now += SETTLE_MS
  heldAt([ws[2]], now)
  live.tick()
  check('... megabytes queued, no rate yet: "not measured yet", not "idle"', logs.at(-1).includes('; 1.90 MB queued, draining: not measured yet,'), logs.at(-1))
  page.sharedBufferedAmount = 0
  ws[2].overSince = null
  now += CLIMB_AFTER_MS
  live.tick()
  // a viewer on plain /live sockets (no page socket to measure): the queue, and no rate
  const solo = fakeWs()
  live.attach('solo', { ws: solo, nvrId: 'n1', ch: 9, type: 1, source: fakeSource('cam9') })
  solo.send(Buffer.alloc(300_000)) // a frame, handed to the socket and not written yet
  solo.bufferedAmount = 300_000
  now += TICK_MS
  live.tick()
  now += TICK_MS
  live.tick()
  check('... a plain /live socket: its queue, no drain rate', logs.some((l) => l.startsWith('[adaptive] solo: full -> 15 (video backing up on its link; 1 camera; 0.30 MB queued; ')), logs.join(' | '))
  clearInterval(live.timer)
}

// ---- conversion slots at a level change (verify-1) ----
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

// ---- a page back within 15 s comes back one level above where it left (verify-1) ----
{
  // Twice on 29 Sep every socket of the owner's page closed and came back (03:55:42, 04:19:39): it was
  // forgotten and started again at full, on the link that had just taken it down.
  let now = T
  const logs = []
  const pool = new TranscodePool(8)
  const live = new AdaptiveLive({ pool, makeTranscoder: () => ({ push() {}, close() {} }), log: (l) => logs.push(l), budgetBps: 1e9, now: () => now })
  const open = () => [fakeWs(), fakeWs()].map((ws, i) => (live.attach('6d4bf842cafe', { ws, nvrId: 'n1', ch: i, type: 1, source: gopSource(30) }), ws))
  const socks = open()
  for (let i = 0; i < 3; i++) {
    now += SETTLE_MS
    heldAt(socks, now)
    live.tick()
  }
  check('a page stepped down to 4: its two tiles on conversions', LEVELS[live.viewers.get('6d4bf842cafe').level].id === '4' && pool.active === 2)
  for (const ws of socks) ws.handlers.close()
  check('every socket of it closes: forgotten, and the slots of the level it left given back at once (not 10 s later)', live.viewers.size === 0 && pool.active === 0, `${pool.active} slots`)
  now += 14_000
  open()
  const v = live.viewers.get('6d4bf842cafe')
  check('back 14 s later: one level above where it left, 8, not full', LEVELS[v.level].id === '8', LEVELS[v.level].id)
  check('... and said, once', logs.filter((l) => l.includes(': back after')).join() === '[adaptive] 6d4bf842: back after 14.0 s, at 8 (it left at 4)', logs.join(' | '))
  check('... its tiles on level 8\'s conversions', [...v.sockets].every((e) => e.stream !== e.source && e.stream.fps === 8) && pool.active === 2, `${pool.active} slots`)
  for (const e of [...v.sockets]) e.ws.handlers.close()
  now += 15_001
  live.tick()
  open()
  check('back 15 s and more later: a new visit, at full', live.viewers.get('6d4bf842cafe').level === 0)
  clearInterval(live.timer)
}
{
  // A tile closed at a level leaves its stream there for its 10 s (a tile that reconnects finds it); a
  // level change closes it with the others, and its slot is there for the new level.
  let now = T
  const pool = new TranscodePool(3)
  const live = new AdaptiveLive({ pool, makeTranscoder: () => ({ push() {}, close() {} }), log: () => {}, budgetBps: 1e9, now: () => now })
  const socks = [0, 1, 2].map((i) => { const ws = fakeWs(); live.attach('left', { ws, nvrId: 'n1', ch: i, type: 1, source: gopSource(30) }); return ws })
  const v = live.viewers.get('left')
  for (let i = 0; i < 2; i++) {
    now += SETTLE_MS
    heldAt(socks, now)
    live.tick()
  }
  socks[2].handlers.close()
  const late = fakeWs()
  live.attach('left', { ws: late, nvrId: 'n1', ch: 7, type: 1, source: gopSource(30) })
  check('at 8, a tile closed and another opened: no slot for the new one while the closed one\'s stream stays', LEVELS[v.level].id === '8' && pool.active === 3 && [...v.sockets].filter((e) => e.stream === e.source).length === 1)
  now += SETTLE_MS
  heldAt([socks[0], socks[1], late], now)
  live.tick()
  check('... down to 4: that stream closed with the others, a slot for every tile', LEVELS[v.level].id === '4' && [...v.sockets].every((e) => e.stream !== e.source), `${pool.active} slots, ${[...v.sockets].filter((e) => e.stream === e.source).length} raw`)
  clearInterval(live.timer)
}

// ---- pressure: what a page has queued against how fast its socket drains (stutter report 2.1) ----
// It was any queue over 256 KB at one look, and on 29 Sep all 12 steps down said "video backing up": a
// page opening or a level change queues more than that by itself, and it was still going out at the
// next look, so the next step followed (full to 4 fps in 10 s, three times).
/** A page's /live-mux socket as its channels show it: the whole queue, its drain rate, what it has written. */
function fakePage() {
  const page = { queued: 0, drainBps: null, written: 0 }
  page.channel = () => ({ ...fakeWs(), overSince: null, get sharedBufferedAmount() { return page.queued }, get drainBps() { return page.drainBps }, get writtenBytes() { return page.written } })
  return page
}
/** A viewer on a fake page of n tiles, looked at twice: past its opening (nothing queued then) and settled. */
function onPage(key, n = 2) {
  const clock = { now: T }
  const logs = []
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: () => ({ push() {}, close() {} }), log: (l) => logs.push(l), budgetBps: 1e9, now: () => clock.now })
  const page = fakePage()
  const socks = Array.from({ length: n }, (_, i) => {
    const ws = page.channel()
    live.attach(key, { ws, nvrId: 'n1', ch: i, type: 1, source: fakeSource(`cam${i}`) })
    return ws
  })
  clearInterval(live.timer)
  const look = () => {
    clock.now += TICK_MS
    live.tick()
  }
  look()
  look()
  return { live, page, socks, logs, look, clock, v: live.viewers.get(key) }
}
{
  const { page, look, v, logs } = onPage('slow')
  page.queued = 1_500_000
  page.drainBps = 625_000 // 5 Mbit/s: 2.4 s to go
  look()
  check('a queue of 2.4 s at one look: not yet', v.level === 0, logs.at(-1))
  page.queued = 400_000 // 0.6 s
  look()
  check('... 0.6 s at the next: the look before no longer counts', v.level === 0)
  page.queued = 1_500_000
  look()
  check('... over a second again: one look', v.level === 0)
  look()
  check('... and at the next: two looks in a row, one level down', v.level === 1 && logs.at(-1).includes('full -> 15 (video backing up on its link; 2 cameras; 1.50 MB queued, draining at 5.0 Mbit/s (2.4 s);'), logs.at(-1))
}
{
  const { page, look, v, logs } = onPage('fast')
  page.queued = 300_000
  page.drainBps = 12_500_000 // 100 Mbit/s: 0.02 s
  look()
  look()
  look()
  check('300 KB queued on a link that writes it in 0.02 s, three looks: not pressure (it was, over 256 KB)', v.level === 0, logs.at(-1))
  page.queued = 1_500_000
  page.drainBps = null // queued too lately to say how fast it goes
  look()
  look()
  check('... 1.5 MB with no rate measured yet: not read as over', v.level === 0, logs.at(-1))
  page.drainBps = 0 // busy, and nothing written: a link that stopped
  look()
  look()
  check('... busy and nothing written: over, and down at the second look', v.level === 1, logs.at(-1))
}
{
  const { socks, look, v, logs, clock } = onPage('held')
  socks[0].overSince = clock.now + TICK_MS - 1500
  look()
  check('a tile held over its cap for 1.5 s: not yet', v.level === 0, logs.at(-1))
  look()
  check('... for 3.5 s: down at once, no second look needed (a frozen tile; verify-1)', v.level === 1 && logs.at(-1).includes('full -> 15 (a tile held over its cap for more than 2 s; 2 cameras;'), logs.at(-1))
}
{
  // a plain /live socket has no drain meter: its queue over 256 KB stands for over a second, two looks too
  let now = T
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: () => ({ push() {}, close() {} }), log: () => {}, budgetBps: 1e9, now: () => now })
  const ws = fakeWs()
  ws.send = function (b) { this.bufferedAmount += b.length } // queued until written
  live.attach('plain', { ws, nvrId: 'n1', ch: 0, type: 1, source: fakeSource('cam') })
  const v = live.viewers.get('plain')
  now += 2 * TICK_MS
  live.tick()
  ws.send(Buffer.alloc(300_000))
  now += TICK_MS
  live.tick()
  check('a plain /live socket, 300 KB queued: one look, not yet', v.level === 0)
  now += TICK_MS
  live.tick()
  check('... two: down', v.level === 1)
  clearInterval(live.timer)
}

// ---- what a page opening or a level change queues by itself goes out first (verify-1) ----
{
  // The page opens: its tiles' replays (and a stand-in's) are queued as each one is attached, 2.1 MB
  // in all, 3.4 s of a 5 Mbit/s link.
  let now = T
  const logs = []
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: () => ({ push() {}, close() {} }), log: (l) => logs.push(l), budgetBps: 1e9, now: () => now })
  const page = fakePage()
  page.drainBps = 625_000
  for (let i = 0; i < 3; i++) {
    page.queued += 700_000
    live.attach('opening', { ws: page.channel(), nvrId: 'n1', ch: i, type: 1, source: fakeSource(`cam${i}`) })
  }
  const v = live.viewers.get('opening')
  for (let i = 0; i < 3; i++) {
    now += TICK_MS
    live.tick()
  }
  check('a page opening with 2.1 MB of its own replays queued (3.4 s): not read at 2, 4 or 6 s while they go out', v.level === 0, logs.at(-1))
  page.written = 2_100_000 // gone; behind them, 1.4 s of what the cameras sent meanwhile
  page.queued = 900_000
  now += TICK_MS
  live.tick()
  check('... once they have gone the queue is read: one look over a second', v.level === 0)
  now += TICK_MS
  live.tick()
  check('... two: down', v.level === 1, logs.at(-1))
  clearInterval(live.timer)
}
{
  // ...and for 8 s at most: an opening's replays that do not go out at all are the link's doing
  let now = T
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: () => ({ push() {}, close() {} }), log: () => {}, budgetBps: 1e9, now: () => now })
  const page = fakePage()
  page.drainBps = 0
  page.queued = 2_100_000
  live.attach('stuck', { ws: page.channel(), nvrId: 'n1', ch: 0, type: 1, source: fakeSource('cam') })
  const v = live.viewers.get('stuck')
  const levels = []
  for (let i = 0; i < 5; i++) {
    now += TICK_MS
    live.tick()
    levels.push(v.level)
  }
  check('... nothing of them written: not read before 8 s, then two looks (8 and 10 s): down at 10 s', levels.join() === '0,0,0,0,1', levels.join())
  clearInterval(live.timer)
}
{
  // After a level change: what was queued just after it (the new streams' first keyframes behind what
  // was already there) goes out before the queue is read again. A tile held over its cap is not hidden.
  const { page, socks, look, v, logs, clock } = onPage('moved', 3)
  page.queued = 1_500_000
  page.drainBps = 625_000
  look()
  look()
  check('two looks over a second: down to 15', v.level === 1, logs.at(-1))
  page.queued = 1_800_000 // not written yet: what was queued at the move, and more
  look()
  look()
  check('... 1.5 MB queued at the move not gone yet: 2.9 s queued at two settled looks, no second step', v.level === 1, logs.at(-1))
  page.written = 1_500_000 // gone
  page.queued = 1_000_000 // 1.6 s of what level 15 sends: still too much
  look()
  check('... once gone: read again, one look', v.level === 1)
  look()
  check('... two: down to 8', v.level === 2, logs.at(-1))
  socks[0].overSince = clock.now + 2 * TICK_MS - 3000
  look()
  look()
  check('... in the next level change\'s grace, a tile held over its cap for 3 s: down at the first settled look', v.level === 3, logs.at(-1))
}
{
  // Only a page opening or a level change: a tile opening later has no grace of its own. Under a real
  // overload tiles with no picture for 8 s reconnect (live-tile.js), and a grace for each would never
  // let the queue be read (verify-1).
  const { page, look, v, live, logs } = onPage('later')
  page.drainBps = 625_000
  page.queued = 1_500_000 // its replay: 2.4 s
  live.attach('later', { ws: page.channel(), nvrId: 'n1', ch: 9, type: 1, source: fakeSource('cam9') })
  look()
  check('a tile opening later with 1.5 MB of replay: read at once, one look', v.level === 0, logs.at(-1))
  look()
  check('... two: down', v.level === 1, logs.at(-1))
}

// ---- replays of a page over a link of a set rate (remote-page.mjs: the real mux, fan-out and stand-ins) ----
{
  // The 03:55 page open on 29 Sep (stutter report Task 4): 16 nvr-2 sub tiles on one socket over a
  // 5 Mbit/s link. 5 sub-streams already running (their GOP replayed at once) and 11 cold, starting when
  // the journal has them start (1.05 to 29.32 s after the page opened); for the H.264 mains of three of
  // those (cams 10, 17, 21) the stand-in's replay: keyframes of 634, 499 and 243 KB, GOPs of 1279, 950
  // and 690 KB (ev-remote, verify-6), 2.6 MB at once. Each sub 250 kbit/s at 18-30 fps, a keyframe every
  // 2 s: 4 Mbit/s once all 16 run, which the link carries with a fifth to spare, as the tunnel carried
  // the page at full for 11 minutes that night. Left out: the stand-ins' frames after their replay,
  // 2-5 Mbit/s each for up to 27 s, more than this link carries at any level (a level cannot thin a
  // stand-in; verify-6: that is the stand-ins' question, report 2.6).
  const cold = [1.05, 2.16, 3.35, 4.72, 6.51, 8.58, 10.27, 12.25, 24.38, 27.13, 29.32]
  const coldCh = [2, 3, 4, 6, 7, 9, 16, 18, 19, 20, 21] // cams 3, 4, 5, 7, 8, 10, 17, 19, 20, 21, 22
  const warmCh = [0, 1, 5, 17, 22] // cams 1, 2, 6, 18, 23
  const fps = [20.6, 20.6, 30, 30, 18.3, 20.6, 30, 25.4, 30, 30, 20, 20, 25.4, 27.5, 30, 20]
  const standIn = { 9: [634, 1279], 16: [499, 950], 20: [243, 690] }
  const tiles = [
    ...warmCh.map((ch, i) => ({ ch, cam: camera({ fps: fps[i], kbps: 250, from: -5000 - i * 413 }) })),
    ...coldCh.map((ch, i) => ({ ch, cam: camera({ fps: fps[5 + i], kbps: 250, from: cold[i] * 1000 }), standIn: standIn[ch] }))
  ]
  const open = openPage({ tiles, linkMbps: 5, durMs: 60_000 })
  check('the 03:55 page open over 5 Mbit/s: no step down in 60 s (it stepped full -> 15 at 4 s, 1.48 MB queued, 2.4 s)', open.downs.length === 0, open.downs.join(' | '))
  const slow = openPage({ tiles, linkMbps: 3, durMs: 60_000 })
  check('... the same page on 3 Mbit/s, less than its 4 Mbit/s: it still steps down', slow.downs.length > 0, slow.lines.join(' | '))
  // on 4 Mbit/s full is just too much: each climb back to it fails 4 s later. It tried every 24 s.
  const edge = openPage({ tiles, linkMbps: 4, durMs: 250_000 })
  const climbs = edge.lines.filter((l) => l.includes('-> full')).map((l) => l.match(/\(clean for (\d+) s;/)?.[1])
  check('... on 4 Mbit/s, where full fails each time: 20, 40, 80, 80 s clean before each climb back', climbs.join() === '20,40,80,80', edge.lines.join(' | '))
}
{
  // A real overload: 16 sub tiles of 0.5 Mbit/s (25 fps) into a 2 Mbit/s link, four times what it carries
  const tiles = Array.from({ length: 16 }, (_, i) => ({ ch: i, cam: camera({ fps: 25, kbps: 500, from: -3000 - i * 137 }) }))
  const r = openPage({ tiles, linkMbps: 2, durMs: 12_000 })
  const first = Number.parseFloat(r.downs[0] ?? 'NaN')
  check('a real overload, 16 x 0.5 Mbit/s into 2 Mbit/s: the first step down within 6 s', first <= 6, r.lines.join(' | '))
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
  const seen = []
  for (const id of ['15', '8', '4']) {
    now += SETTLE_MS
    heldAt([ws], now)
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
  now += SETTLE_MS
  heldAt([ws], now)
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
  now += SETTLE_MS
  heldAt([ws], now)
  live.tick() // full -> 15: onto a new stream of its own
  ws.overSince = null
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
