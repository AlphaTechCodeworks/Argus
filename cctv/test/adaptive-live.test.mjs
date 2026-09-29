// Tests for the remote viewers' frame-rate levels (adaptive-live.mjs), with fake streams: no ffmpeg.
//   node cctv/test/adaptive-live.test.mjs
import { AdaptiveLive, CLIMB_AFTER_MS, LEVELS, SETTLE_MS, isRemoteAddress, nextLevel } from '../adaptive-live.mjs'
import { TranscodePool } from '../transcode.mjs'

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

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
