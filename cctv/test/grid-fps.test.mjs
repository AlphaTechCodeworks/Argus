// Tests for the balanced grid fps: a remote viewer pins every grid tile to one uniform rate, the fast
// cameras capped to it and a slower one left alone (adaptive-live.mjs + phone-live.mjs). Fake streams
// and a fake converter: no ffmpeg, and no native SDK, so it runs anywhere.
//   node cctv/test/grid-fps.test.mjs
import { AdaptiveLive, GRID_FPS_OPTIONS, LEVELS, SETTLE_MS, gridFpsOf } from '../adaptive-live.mjs'
import { PhoneStream, encodeFrame, keepEveryFor } from '../phone-live.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T = 1_000_000
// a camera stream as the fan-out has it: a new viewer (or a level's stream joining it) is sent its GOP
function gopSource(fps, n = 20) {
  const gop = fps > 0 ? Array.from({ length: n }, (_, i) => encodeFrame(Buffer.from([0, 0, 1, 1]), i === 0, 0, (i * 1000) / fps)) : []
  return { gop, viewers: new Set(), add(ws) { this.viewers.add(ws); for (const f of gop) ws.send(f) }, remove(ws) { this.viewers.delete(ws) } }
}
// a camera stream that only fans out what it is told to emit (for a PhoneStream on its own)
function emitSource() {
  return { viewers: new Set(), add(ws) { this.viewers.add(ws) }, remove(ws) { this.viewers.delete(ws) }, emit(buf) { for (const v of this.viewers) v.send(buf) } }
}
function fakeWs() {
  return { OPEN: 1, readyState: 1, bufferedAmount: 0, got: [], handlers: {}, send(b) { this.got.push(b) }, on(e, f) { this.handlers[e] = f } }
}
const noopXcode = () => ({ push() {}, close() {} })
const newLive = (slots = 8, now = null) => new AdaptiveLive({ pool: new (class { constructor() { this.max = slots; this.active = 0 } acquire() { return this.active < this.max ? (this.active++, { release: () => this.active-- }) : null } })(), makeTranscoder: noopXcode, log: () => {}, budgetBps: 1e9, ...(now ? { now } : {}) })
// a link that cannot keep up: each socket held over its cap for 3 s at this look (as adaptive-live.test)
const heldAt = (socks, now) => { for (const ws of socks) ws.overSince = now - 3000 }

// ---- what a valid choice is ----
check('the grid fps options are 4 / 8 / 10 / 15', JSON.stringify(GRID_FPS_OPTIONS) === '[4,8,10,15]')
check('a valid choice is kept, anything else reads as Auto (0)', gridFpsOf(8) === 8 && gridFpsOf('15') === 15 && gridFpsOf(0) === 0 && gridFpsOf(7) === 0 && gridFpsOf(null) === 0 && gridFpsOf('x') === 0)

// ---- conversion math (phone-live.mjs keepEveryFor) ----
check('a faster source is thinned to the target', keepEveryFor(20, 4) === 5 && keepEveryFor(30, 15) === 2 && keepEveryFor(24, 8) === 3)
check('a source at or below the target is left alone (keep every frame)', keepEveryFor(8, 10) === 1 && keepEveryFor(15, 15) === 1 && keepEveryFor(3, 4) === 1)

// ---- the conversion hits a chosen target fps from a faster source, and leaves a slower source alone ----
{
  const made = []
  const mk = (o) => { const x = { o, push() {}, close() {} }; made.push(x); return x }
  const src = emitSource()
  const s = new PhoneStream({ source: src, type: 1, slot: { release() {} }, fps: 4, makeTranscoder: mk, learnMs: 1000, keySeconds: 2, now: () => 0 })
  for (let i = 0; i < 20; i++) src.emit(encodeFrame(Buffer.from([0, 0, 1, 1]), i % 12 === 0, 0, i * 50)) // 50 ms = 20 fps
  check('PhoneStream converts a faster source to the chosen fps (keep 1 in 5 of 20 fps for 4)', made.length === 1 && made[0].o.keepEvery === 5 && !s.passthrough, `made ${made.length}, keep ${made[0]?.o.keepEvery}`)
}
{
  const made = []
  const mk = (o) => { const x = { o, push() {}, close() {} }; made.push(x); return x }
  let released = false
  const src = emitSource()
  const s = new PhoneStream({ source: src, type: 1, slot: { release() { released = true } }, fps: 10, makeTranscoder: mk, learnMs: 1000, keySeconds: 2, now: () => 0 })
  for (let i = 0; i < 20; i++) src.emit(encodeFrame(Buffer.from([0, 0, 1, 1]), i % 12 === 0, 0, i * 125)) // 125 ms = 8 fps
  check('PhoneStream leaves a slower source alone (sent as it is, its slot freed)', made.length === 0 && s.passthrough && released)
}

// ---- Auto reproduces today's pass-through exactly ----
{
  const live = newLive()
  const src = gopSource(20)
  const ws = fakeWs()
  live.attach('auto', { ws, nvrId: 'n1', ch: 0, type: 1, source: src })
  check('Auto at full: a sub passes through on the camera own stream (no conversion), as today', src.viewers.has(ws) && live.streams.size === 0)
  clearInterval(live.timer)
}

// ---- a grid fps converts a sub that would pass through at full, at the chosen fps ----
{
  const live = newLive()
  live.setGridFps('g', 4) // chosen before any socket: remembered for the viewer that then arrives
  const src = gopSource(20)
  const ws = fakeWs()
  live.attach('g', { ws, nvrId: 'n1', ch: 0, type: 1, source: src })
  const [e] = live.viewers.get('g').sockets
  check('a grid fps at full: a sub that would pass through is converted at the chosen fps', !src.viewers.has(ws) && e.stream !== src && e.stream.fps === 4 && live.streams.size === 1, `fps ${e.stream?.fps}`)
  clearInterval(live.timer)
}

// ---- a camera slower than the pick keeps its own rate (frames cannot be invented) ----
{
  const live = newLive()
  live.setGridFps('slow', 8)
  const src = gopSource(5) // 5 fps, below the chosen 8
  const ws = fakeWs()
  live.attach('slow', { ws, nvrId: 'n1', ch: 1, type: 1, source: src })
  check('a camera slower than the pick keeps its own stream (no conversion raises it)', src.viewers.has(ws) && live.streams.size === 0)
  clearInterval(live.timer)
}

// ---- every sub tile of a viewer gets the same target ----
{
  const live = newLive()
  live.setGridFps('many', 8)
  const rates = [20, 30, 25]
  rates.forEach((r, i) => live.attach('many', { ws: fakeWs(), nvrId: 'n1', ch: i, type: 1, source: gopSource(r) }))
  const streams = [...live.viewers.get('many').sockets].map((e) => e.stream)
  check('every sub tile of the viewer is converted to the same target fps', streams.length === 3 && streams.every((s) => s && s.fps === 8), streams.map((s) => s?.fps).join(','))
  clearInterval(live.timer)
}

// ---- the main stream (full screen) is unaffected ----
{
  const live = newLive()
  live.setGridFps('m', 4)
  const sub = gopSource(20)
  const main = gopSource(20) // an H.264 main (full screen)
  const subWs = fakeWs()
  const mainWs = fakeWs()
  live.attach('m', { ws: subWs, nvrId: 'n1', ch: 0, type: 1, source: sub })
  live.attach('m', { ws: mainWs, nvrId: 'n1', ch: 0, type: 0, source: main, mayMain: () => true })
  const socks = [...live.viewers.get('m').sockets]
  const subE = socks.find((e) => e.type === 1)
  check('the main stream keeps its own path (own stream at full, as today): the grid fps does not touch it', main.viewers.has(mainWs))
  check('... only the grid (sub) tile is converted, at the chosen fps', subE.stream !== sub && subE.stream.fps === 4)
  clearInterval(live.timer)
}

// ---- the chosen fps is a ceiling, not a floor: the controller still steps the viewer below it ----
{
  let now = T
  const live = newLive(8, () => now)
  live.setGridFps('ceil', 15)
  const ws = fakeWs()
  live.attach('ceil', { ws, nvrId: 'n1', ch: 0, type: 1, source: gopSource(30) })
  const v = live.viewers.get('ceil')
  const [e] = v.sockets
  check('grid fps 15 at full: a 30 fps camera is converted to 15', e.stream.fps === 15 && v.level === 0, `fps ${e.stream?.fps}, level ${v.level}`)
  now += SETTLE_MS; heldAt([ws], now); live.tick() // full -> 15
  now += SETTLE_MS; heldAt([ws], now); live.tick() // 15 -> 8
  check('the controller still steps the viewer down (the chosen fps never pins it up)', LEVELS[v.level].id === '8')
  // a tile at the stepped-down level: its target is the level's 8 (min(8, 15)), below the chosen 15
  const ws2 = fakeWs()
  live.attach('ceil', { ws: ws2, nvrId: 'n1', ch: 1, type: 1, source: gopSource(30) })
  const e2 = [...v.sockets].find((x) => x.ws === ws2)
  check('at the stepped-down level a tile converts below the chosen fps (a ceiling, not a floor)', e2.stream.fps === 8 && 8 < 15, `fps ${e2.stream?.fps}`)
  clearInterval(live.timer)
}

// ---- changing the choice live re-targets the open grid, no reattach ----
{
  const live = newLive()
  const src = gopSource(20)
  const ws = fakeWs()
  live.attach('live', { ws, nvrId: 'n1', ch: 0, type: 1, source: src })
  check('starts Auto: pass-through', src.viewers.has(ws) && live.streams.size === 0)
  live.setGridFps('live', 4)
  const [e] = live.viewers.get('live').sockets
  // it keeps its picture and switches at the camera's next keyframe (#switchTo), so the move is pending
  check('setting a grid fps live re-targets the open tile to the chosen fps (switch at next keyframe)', e.switch && e.switch.to && e.switch.to.fps === 4, `switch to fps ${e.switch?.to?.fps}`)
  live.setGridFps('live', 0) // back to Auto
  const [e2] = live.viewers.get('live').sockets
  check('back to Auto: the pending conversion is dropped and the tile stays on the camera own stream', e2.stream === src && !e2.switch && live.streams.size === 0)
  clearInterval(live.timer)
}

// ---- Auto and a grid fps never share a converted stream (an Auto viewer is untouched) ----
{
  const live = newLive()
  const srcAuto = gopSource(20)
  const srcPick = gopSource(20)
  live.attach('viewerAuto', { ws: fakeWs(), nvrId: 'n1', ch: 0, type: 1, source: srcAuto })
  live.setGridFps('viewerPick', 4)
  live.attach('viewerPick', { ws: fakeWs(), nvrId: 'n1', ch: 0, type: 1, source: srcPick })
  check('the Auto viewer stays on the camera own stream while the other converts', srcAuto.viewers.size === 1 && live.streams.size === 1)
  clearInterval(live.timer)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
