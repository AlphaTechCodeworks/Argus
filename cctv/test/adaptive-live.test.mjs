// Tests for the remote viewers' frame-rate levels (adaptive-live.mjs), with fake streams: no ffmpeg.
//   node cctv/test/adaptive-live.test.mjs
import { AdaptiveLive, CLIMB_AFTER_MS, LEVELS, REMOTE_CONVERSION, SETTLE_MS, SWITCH_WAIT_MS, TICK_MS, isRemoteAddress, nextLevel } from '../adaptive-live.mjs'
import { encodeFrame, parseFrame } from '../phone-live.mjs'
import { HubStream } from '../stream-hub.mjs'
import { TranscodePool, ffmpegArgs } from '../transcode.mjs'
import { play } from './live-replay.mjs'
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
/**
 * A tile on the camera's own stream for want of a conversion slot. Not one waiting there for its new
 * level's stream to have a picture (a switch: its slot is taken; these streams never send the keyframe
 * it waits for, and it goes over SWITCH_WAIT_MS after the step).
 */
const isRaw = (e) => e.stream === e.source && !e.switch
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
  const raw = () => [...v.sockets].filter(isRaw).length
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
  const raw = () => [...v.sockets].filter(isRaw).length
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
  // (each keeps its conversion at 8 until 4's has a picture: these streams never send the keyframe for it)
  const at4 = [...live.viewers.get('6d4bf842cafe').sockets].every((e) => (e.switch?.to ?? e.stream).fps === 4)
  check('a page stepped down to 4: its two tiles on their way to conversions, keeping the ones they had meanwhile', LEVELS[live.viewers.get('6d4bf842cafe').level].id === '4' && at4 && pool.active === 4, `${pool.active} slots`)
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
  check('at 8, a tile closed and another opened: no slot for the new one while the closed one\'s stream stays', LEVELS[v.level].id === '8' && pool.active === 3 && [...v.sockets].filter(isRaw).length === 1)
  now += SETTLE_MS
  heldAt([socks[0], socks[1], late], now)
  live.tick()
  check('... down to 4: that stream closed with the others, a slot for every tile', LEVELS[v.level].id === '4' && [...v.sockets].every((e) => !isRaw(e)), `${pool.active} slots, ${[...v.sockets].filter(isRaw).length} raw`)
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
  // on 3.8 Mbit/s full is too much: each climb back to it fails 12-14 s later. It tried every 24 s.
  const edge = openPage({ tiles, linkMbps: 3.8, durMs: 350_000 })
  const climbs = edge.lines.filter((l) => l.includes('-> full')).map((l) => l.match(/\(clean for (\d+) s;/)?.[1])
  check('... on 3.8 Mbit/s, where full fails each time: 20, 40, 80, 80 s clean before each climb back', climbs.join() === '20,40,80,80', edge.lines.join(' | '))
  // On 4 Mbit/s, just too much, each climb failed 4 s later on its own burst: every tile moved back to
  // the camera's own stream was sent its GOP again. Moved at the camera's next keyframe with nothing
  // replayed (report 2.5), full holds there for over 40 s each time, and no climb counts as failed.
  const just = openPage({ tiles, linkMbps: 4, durMs: 250_000 })
  const held = []
  let upAt = null
  for (const l of just.lines) {
    const t = Number.parseFloat(l)
    if (l.includes('-> full')) upAt = t
    else if (upAt !== null && l.includes('full -> 15')) held.push(t - upAt)
  }
  check('... on 4 Mbit/s, just too much: full holds over 30 s after each climb (it failed 4 s after, on the climb\'s own burst)', held.length >= 2 && held.every((s) => s > 30), `${held.join(', ')} s | ${just.lines.join(' | ')}`)
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

// ---- level changes without a freeze or a jump back (stutter report 2.5, verify-5) ----
/**
 * A remote viewer's tiles on real camera streams (stream-hub.mjs HubStream: its GOP replay, its gate)
 * under the level controller, in virtual time (ms from T). Camera i sends `fps` frames a second, a
 * keyframe every `gopS` s (at whole multiples of it), from 6 s before the viewer comes (its GOP so far
 * is there to replay); `type` 1 a sub-stream, 0 a main. The converter hands back each picture it keeps
 * `lag` frames after it went in (ffmpeg's parser and decoder hold pictures back), a keyframe every
 * o.gop pictures out. The controller looks every TICK_MS, `phase` ms into each 2 s: 1000, mid-GOP;
 * 0, just as a keyframe comes. Every frame a socket is sent is noted: when, its capture time,
 * keyframe or not, converted or the camera's own.
 */
function rig({ cams, pool = 16, lag = 2, phase = 1000, key = 'rig' }) {
  let now = T - 6000
  let pressAt = null
  const logs = []
  const made = []
  const makeTranscoder = (o) => {
    const x = {
      o, closed: false, inputs: 0, outs: 0, pending: [], firstIn: null,
      push(ts) {
        this.firstIn ??= ts
        const i = this.inputs++
        if (i % o.keepEvery === 0) this.pending.push({ i, ts })
        while (this.pending.length && this.pending[0].i <= i - lag) {
          const p = this.pending.shift()
          o.onFrame(p.ts, this.outs++ % Math.max(1, o.gop || 50) === 0, Buffer.alloc(3))
        }
      },
      endPicture() {},
      close() { this.closed = true }
    }
    made.push(x)
    return x
  }
  const live = new AdaptiveLive({ pool: new TranscodePool(pool), makeTranscoder, log: (l) => logs.push(`${((now - T) / 1000).toFixed(2)} ${l}`), budgetBps: 1e9, now: () => now })
  const hub = { send() {}, streams: new Map(), stopDelayMs: { 0: 10_000, 1: 180_000 } }
  const recorder = () => {
    const ws = { ...fakeWs(), overSince: null }
    ws.send = (b) => { const f = parseFrame(b); ws.got.push({ at: now - T, ts: f.ts, key: f.isKey, converted: f.payload.length === 3 }) }
    return ws
  }
  const tiles = cams.map((c, ch) => ({ ...c, ch, stream: new HubStream(hub, ch, c.type ?? 1), ws: recorder(), next: 0, every: 1000 / c.fps, keyEvery: Math.max(1, Math.round((c.gopS ?? 2) * c.fps)) }))
  // (capture times in ms from T, as the camera's clock; a tile's `every` may be changed as it runs)
  const frames = (upTo) => {
    for (const t of tiles) {
      t.ts ??= -6000
      while (t.ts <= upTo) {
        const isKey = t.next % t.keyEvery === 0
        t.stream.onFrame(encodeFrame(Buffer.alloc(isKey ? 40 : 8), isKey, 0, t.ts), isKey)
        t.next++
        t.ts += t.every
      }
    }
  }
  let pressed = []
  /** Runs to `ms`, a millisecond at a time: the cameras' frames, then the controller's looks. */
  const to = (ms) => {
    for (let at = now - T + 1; at <= ms; at++) {
      now = T + at
      frames(at)
      if (at > 0 && (at - phase) % TICK_MS === 0) {
        // the look `down` asked for: its sockets held over their cap for 3 s, as plainly as a link shows it
        const press = at === pressAt ? pressed : []
        for (const ws of press) ws.overSince = now - 3000
        live.tick()
        for (const ws of press) ws.overSince = null
      }
    }
  }
  to(0)
  for (const t of tiles) live.attach(key, { ws: t.ws, nvrId: 'n1', ch: t.ch, type: t.type ?? 1, source: t.stream })
  clearInterval(live.timer)
  const v = live.viewers.get(key)
  const entry = (t) => [...v.sockets].find((e) => e.ws === t.ws)
  /** Runs to the first look at or after `ms`, which finds the link backed up (these sockets'): one level down. */
  const down = (ms, socks = tiles.map((t) => t.ws)) => {
    pressAt = ms + ((((phase - ms) % TICK_MS) + TICK_MS) % TICK_MS)
    pressed = socks
    to(pressAt)
    return pressAt
  }
  return { live, v, tiles, logs, made, to, down, entry, socket: recorder }
}
/** A socket's frames: whether any was older than one before it, and the longest wait between two, from `from` ms on. */
const seen = (got, from = 0) => {
  const g = got.filter((f) => f.at >= from)
  let back = 0
  let gap = 0
  for (let i = 1; i < g.length; i++) {
    back = Math.max(back, g[i - 1].ts - g[i].ts)
    gap = Math.max(gap, g[i].at - g[i - 1].at)
  }
  return { back, gap, n: g.length }
}
/** A socket's frames from `from` to `to` ms, for a failure's message: at:capture time, k keyframe, c converted. */
const brief = (got, from, to) => got.filter((f) => f.at >= from && f.at <= to).map((f) => `${f.at}:${Math.round(f.ts)}${f.key ? 'k' : ''}${f.converted ? 'c' : ''}`).join(' ')
{
  // (b) A grid sub-stream at or under a level's rate is sent as it is there, but it was put on a
  // stream of that level all the same: it lost the picture it had until the camera's next keyframe,
  // 0-2.5 s, on 11 of 26 tiles at 04:18:05 (verify-5). The camera's stream already knows its rate from
  // the GOP it holds: such a sub stays where it is.
  const r = rig({ cams: [{ fps: 20 }] })
  const [t] = r.tiles
  r.down(5000)
  check('(b) a 20 fps sub at 15 (its camera\'s GOP shows its rate): stays on the camera\'s own stream, no stream made for it', LEVELS[r.v.level].id === '15' && r.entry(t).stream === t.stream && r.live.streams.size === 0, `${LEVELS[r.v.level].id} ${[...r.live.streams.keys()]}`)
  r.to(8000)
  const s = seen(t.ws.got, 3000)
  check('  its picture goes on: every frame once, in order, none missed at the step', s.back === 0 && s.gap <= 51 && s.n === 101, JSON.stringify(s))
  r.down(9000)
  check('  at 8 (1 in 3) it is converted', LEVELS[r.v.level].id === '8' && r.live.streams.has('n1/0/1@8') && r.made.at(-1)?.o.keepEvery === 3, `${[...r.live.streams.keys()]}`)
}
{
  // Its rate not known yet (a look just as a keyframe comes: one frame to go on): a level's stream
  // learns it, as before, and hands it on, so the next time it is known
  const r = rig({ cams: [{ fps: 20 }], phase: 0 })
  const [t] = r.tiles
  r.down(6000)
  check('the rate not known yet: a level\'s stream learns it, as before (the socket on its way there)', LEVELS[r.v.level].id === '15' && r.entry(t).switch?.to === r.live.streams.get('n1/0/1@15'), `${LEVELS[r.v.level].id} ${[...r.live.streams.keys()]}`)
  r.down(10_000)
  r.to(12_500)
  const s = seen(t.ws.got, 5000)
  check('(a) ... stepped down from the stream that sent it as it was: kept until the camera\'s next keyframe (12 s), where 8\'s conversion starts: nothing older, no wait longer than a frame and the converter\'s lag (2 frames)',
    s.back === 0 && s.gap <= 151 && r.entry(t).stream.fps === 8 && r.made.at(-1)?.firstIn === 12_000, `${JSON.stringify(s)} ${brief(t.ws.got, 11_900, 12_200)}`)
  r.to(40_000) // clean for 20 s: back up to 15, again at a look just as a keyframe comes
  check('... and the next time it is known: back at 15 the sub is on the camera\'s own stream, no stream of 15 made', LEVELS[r.v.level].id === '15' && r.entry(t).stream === t.stream && !r.live.streams.has('n1/0/1@15'), `${LEVELS[r.v.level].id} ${[...r.live.streams.keys()]}`)
}
{
  // decided once for the level: a later reading of the rate does not move it back and forth
  const r = rig({ cams: [{ fps: 20 }] })
  const [t] = r.tiles
  r.down(5000)
  t.every = 1000 / 30 // the camera now reads 30 fps, which 15 would convert
  r.to(11_000)
  check('(b) decided for the level: the looks after it, reading another rate, leave it where it is', LEVELS[r.v.level].id === '15' && r.entry(t).stream === t.stream && r.live.streams.size === 0, `${[...r.live.streams.keys()]}`)
}
// (a) Every move took the socket off its stream before the new one had a picture, and the new one's
// first picture was older than what it had: a conversion started from the keyframe it held, a running
// stream replayed its GOP. A hold, then a jump back (0.8-1.4 s in the replay; verify-5: 0-2.4 s). Now a
// moved socket is never sent a frame older than one it has had, and waits no longer than the new
// stream's first keyframe; the moves that can, make it before they break it.
{
  // A 30 fps sub (keyframes every 2 s, at 4, 6, 8 s ...), a converter that holds 2 frames back (67 ms)
  const r = rig({ cams: [{ fps: 30 }] })
  const [t] = r.tiles
  const x = () => r.made.at(-1)
  // full -> 15 at 5 s: from the camera's own stream onto a new conversion (1 in 2)
  r.down(5000)
  const b15 = r.entry(t).switch?.to ?? r.entry(t).stream
  r.to(6200)
  const raw = t.ws.got.filter((f) => f.at >= 5000 && !f.converted)
  check('(a) a step down from the camera\'s own stream: it keeps that stream up to its next keyframe (6 s), none of it from there on',
    raw.length === 30 && raw.at(-1).ts < 6000 && Math.round(raw[0].ts) === 5000, brief(t.ws.got, 4900, 6200))
  check('  the new level\'s conversion starts from that keyframe, not the one it held (4 s): nothing it has shown converted again', x()?.firstIn === 6000 && r.entry(t).stream === b15 && b15.fps === 15, `first in ${x()?.firstIn}`)
  let s = seen(t.ws.got, 4000)
  check('  its first picture is that keyframe, converted, 2 frames later: nothing older than it had, and no wait longer than that', s.back === 0 && s.gap <= 101 && t.ws.got.find((f) => f.converted)?.ts === 6000 && t.ws.got.find((f) => f.converted).key, `${JSON.stringify(s)} ${brief(t.ws.got, 5950, 6150)}`)
  // 15 -> 8 at 9 s: from a conversion onto a new one, a slot free for it (no slot: below)
  r.down(9000)
  check('(a) a step down from a conversion, a slot free: it keeps the old one meanwhile', r.entry(t).stream === b15 && r.entry(t).switch?.to.fps === 8, `${[...r.live.streams.keys()]}`)
  r.to(10_500)
  s = seen(t.ws.got, 8000)
  check('  and goes over at the new one\'s first picture (the camera\'s keyframe at 10 s), the old one closed then: nothing older, no wait longer than a frame of the new level (133 ms)',
    s.back === 0 && s.gap <= 134 && x()?.firstIn === 10_000 && r.entry(t).stream.fps === 8 && b15.closed && r.live.streams.size === 1, `${JSON.stringify(s)} ${brief(t.ws.got, 9900, 10_300)}`)
  // 8 -> 15 at 29 s (clean for 20 s): a climb onto a new conversion, a slot free. It keeps the old one
  // until the new one has its first picture: the frame rate changes, and nothing else
  const b8 = r.entry(t).stream
  r.to(29_000)
  check('(a) a climb onto a new conversion: it stays on the old one meanwhile', LEVELS[r.v.level].id === '15' && r.entry(t).stream === b8 && r.entry(t).switch?.to.fps === 15, LEVELS[r.v.level].id)
  r.to(31_000)
  s = seen(t.ws.got, 28_000)
  check('  and goes over at the new one\'s first picture (the camera\'s keyframe at 30 s): nothing older, no wait longer than a frame of the old one (133 ms)',
    s.back === 0 && s.gap <= 134 && r.entry(t).stream.fps === 15 && b8.closed && x()?.firstIn === 30_000, `${JSON.stringify(s)} ${brief(t.ws.got, 29_850, 30_150)}`)
  // 15 -> full at 49 s: onto the camera's own stream, at its next keyframe, with nothing replayed
  const c15 = r.entry(t).stream
  r.to(49_000)
  check('(a) a climb onto the camera\'s own stream: it stays on its conversion until that stream\'s next keyframe', r.v.level === 0 && r.entry(t).stream === c15 && r.entry(t).switch?.to === t.stream, String(r.v.level))
  r.to(51_000)
  s = seen(t.ws.got, 48_000)
  const k50 = t.ws.got.find((f) => f.key && f.ts === 50_000)
  const at50 = t.ws.got.filter((f) => f.at === k50?.at)
  check('  and goes over there (50 s), nothing replayed: nothing older, no wait, at most the conversion\'s last picture and that keyframe at once',
    s.back === 0 && s.gap <= 67 && r.entry(t).stream === t.stream && c15.closed && r.live.streams.size === 0 && at50.length <= 2 && at50.at(-1)?.ts === 50_000 && !at50.at(-1).converted, `${JSON.stringify(s)} ${brief(t.ws.got, 49_900, 50_100)}`)
}
{
  // A step down waits at most SWITCH_WAIT_MS on the camera's stream for its keyframe: the link is
  // backed up. A camera with a keyframe every 4 s (nvr1 31 LCL Cage), stepped down 3 s before the next.
  const r = rig({ cams: [{ fps: 30, gopS: 4 }] })
  const [t] = r.tiles
  r.down(7000) // keyframes at 6, 10 s
  r.to(10_500)
  const raw = t.ws.got.filter((f) => f.at >= 7000 && !f.converted)
  const s = seen(t.ws.got, 6000)
  check(`(a) a step down on a camera whose next keyframe is 3 s off: it leaves the camera's stream after ${SWITCH_WAIT_MS / 1000} s, and waits for that keyframe converted: nothing older`,
    raw.at(-1)?.at <= 7000 + SWITCH_WAIT_MS + 34 && raw.at(-1).at >= 7000 + SWITCH_WAIT_MS - 34 && s.back === 0 && t.ws.got.find((f) => f.converted)?.ts === 10_000, `${JSON.stringify(s)} ${brief(t.ws.got, 9400, 10_100)}`)
}
{
  // no slot for the new level's stream while the old one holds the only one: the old one gives it up
  // first (verify-1), and the socket waits for the new one's first keyframe
  const r = rig({ cams: [{ fps: 30 }], pool: 1 })
  const [t] = r.tiles
  r.down(5000)
  const b15 = r.entry(t).switch?.to
  r.down(9000)
  check('(a) a step down with no slot free: off its conversion at once, which closes there and then; the new one has its slot', b15?.closed && r.entry(t).stream.fps === 8 && !r.entry(t).switch && r.live.streams.size === 1, `${[...r.live.streams.keys()]}`)
  r.to(10_500)
  const s8 = seen(t.ws.got, 8000)
  check('  it converts from the camera\'s next keyframe (10 s): the first picture there, nothing older, no wait longer than that keyframe\'s (1 s), the converter\'s lag and a frame',
    s8.back === 0 && s8.gap <= 1000 + 101 && r.made.at(-1)?.firstIn === 10_000 && t.ws.got.filter((f) => f.at > 9000)[0]?.ts === 10_000, `${JSON.stringify(s8)} ${brief(t.ws.got, 8900, 10_100)}`)
  r.to(29_000) // 8 -> 15
  const s = seen(t.ws.got, 28_000)
  check('(a) a climb with no slot free: the old conversion closes first, the new one takes its slot; nothing older than it had',
    r.entry(t).stream.fps === 15 && r.live.streams.size === 1 && s.back === 0, `${JSON.stringify(s)} ${[...r.live.streams.keys()]}`)
  r.to(31_000)
  const after = seen(t.ws.got, 28_000)
  check('  its first picture there: the camera\'s next keyframe (30 s), converted', after.back === 0 && t.ws.got.filter((f) => f.at > 29_000)[0]?.ts === 30_000 && after.gap <= 1000 + 101, `${JSON.stringify(after)} ${brief(t.ws.got, 28_900, 30_100)}`)
}
{
  // onto a stream that runs already (another viewer's, at the level this one steps down to): its GOP
  // replay is older than what the socket has; it is sent nothing until that stream's next keyframe
  const r = rig({ cams: [{ fps: 30 }] })
  const [t] = r.tiles
  r.down(5000) // the first viewer: at 15, on its conversion from 6 s
  const other = r.socket()
  r.live.attach('other', { ws: other, nvrId: 'n1', ch: 0, type: 1, source: t.stream })
  r.down(11_000, [other]) // the second viewer, on the camera's own stream, down to 15: the first one's conversion
  const s = seen(other.got, 10_000)
  const first = other.got.find((f) => f.converted)
  check('(a) onto another viewer\'s running conversion: nothing older than it had (not its replay), from that stream\'s next keyframe on',
    s.back === 0 && [...r.live.viewers.get('other').sockets][0].stream === r.entry(t).stream && (r.to(14_000), seen(other.got, 10_000).back === 0) && other.got.find((f) => f.converted)?.key, `${JSON.stringify(seen(other.got, 10_000))} ${brief(other.got, 10_900, 12_200)} ${first?.ts}`)
}
{
  // a socket closing while it waits to switch: the conversion made for it closes, and its slot is back
  const r = rig({ cams: [{ fps: 30, gopS: 4 }] })
  const [t] = r.tiles
  r.down(7000)
  const waiting = r.entry(t).switch?.to
  r.to(8000)
  t.ws.handlers.close()
  check('(a) a socket closing while it waits to switch: the conversion made for it closed, the slot back', waiting && waiting.closed && r.live.pool.active === 0 && r.live.streams.size === 0, `${r.live.pool.active} slots`)
}
{
  // a level change while a climb's switch still waits (a camera with a keyframe every 6 s): back down
  // to the level it came from, it stays on the stream it never left
  const r = rig({ cams: [{ fps: 30, gopS: 6 }] })
  const [t] = r.tiles
  r.down(5000) // keyframes at 0, 6, 12 ... s: onto 15's conversion at 6 s
  r.to(25_000) // clean for 20 s: back to full, waiting for the keyframe at 30 s
  const c15 = r.entry(t).stream
  check('(a) a climb waiting for a keyframe 5 s off', r.v.level === 0 && r.entry(t).switch?.to === t.stream && c15.fps === 15)
  r.down(29_000)
  r.to(31_000)
  const s = seen(t.ws.got, 24_000)
  check('  then stepped back down to 15: it stays on the conversion it never left, the switch dropped, the picture as it was', LEVELS[r.v.level].id === '15' && r.entry(t).stream === c15 && !c15.closed && !r.entry(t).switch && s.back === 0 && s.gap <= 67, `${JSON.stringify(s)}`)
}
{
  // The replay of a switch (report Task 6): what a tile is sent through every level change, full to 4
  // and back, played through the Live page's real player (test/live-replay.mjs), as a local page's (no
  // help from the browser). The picture never steps back: the stutter investigation's replay had 0.8-1.4 s
  // at each change, and the code before this change, on this very replay, 50-333 ms back and a still of
  // up to 733 ms. Every switch is made before it is broken here (slots free): no still longer than a
  // frame at 4 fps (240-267 ms).
  const r = rig({ cams: [{ fps: 30 }, { fps: 20 }, { fps: 25, type: 0 }] })
  r.down(5000)
  r.down(9000)
  r.down(13_000)
  r.to(80_000) // climbs back at 33, 53 and 73 s
  const levels = r.logs.filter((l) => l.includes('[adaptive]')).map((l) => l.match(/: (\S+ -> \S+) /)?.[1]).join(', ')
  check('the replay of a switch: full -> 15 -> 8 -> 4 and back up to full', levels === 'full -> 15, 15 -> 8, 8 -> 4, 4 -> 8, 8 -> 15, 15 -> full', levels)
  for (const t of r.tiles) {
    const got = seen(t.ws.got, 1000)
    const p = await play(t.ws.got.map((f) => ({ at: f.at, ts: f.ts, isKey: f.key })), { fps: t.fps, decoder: { pool: 16, decodeMs: 3 } })
    check(`  a ${t.fps} fps ${t.type === 0 ? 'main' : 'sub'}: never a frame older than one it had; played, the picture never steps back, the longest still ${p.maxStillMs} ms`,
      got.back === 0 && p.backwards === 0 && p.maxBackMs === 0 && p.maxStillMs <= 267 + 17, `${JSON.stringify(got)} ${JSON.stringify({ back: p.maxBackMs, still: p.maxStillMs, resyncs: p.resyncs })}`)
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
