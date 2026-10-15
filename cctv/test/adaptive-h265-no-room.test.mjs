// A remote viewer whose browser cannot play H.265, and no conversion slot free (adaptive-live.mjs
// #rawOk, #noRoom). On 15 Oct a remote PC paging through H.265 cameras met value4u/2 with every
// conversion slot taken (the page before still held its conversions for their stop delay, one pool for
// phones and remote viewers together): the server sent the camera's own H.265 stream, the tile's
// decoder refused its keyframe, asked again for H.264 twice at once, met the same H.265 replay, and gave
// up on the camera for good -- "This camera sends H.265, which this browser cannot play" until a refresh.
// Now the tile is closed with the "no room" reason the page shows as "server busy" and asks again on,
// and is never sent H.265. Also: a level below full never passes an H.265 sub through to such a browser.
// Fake streams, no ffmpeg.
//   node cctv/test/adaptive-h265-no-room.test.mjs
// (ADAPTIVE_LIVE=<path> runs it against another copy of adaptive-live.mjs: the one before the fix fails it)
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { encodeFrame } from '../phone-live.mjs'
import { TranscodePool } from '../transcode.mjs'
import { NO_ROOM, NO_ROOM_MAIN } from '../h264-fallback.mjs'

const mod = process.env.ADAPTIVE_LIVE ? pathToFileURL(resolve(process.env.ADAPTIVE_LIVE)).href : '../adaptive-live.mjs'
const { AdaptiveLive, FULL_STOP_MS, LEVELS, SETTLE_MS } = await import(mod)

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const H264 = 0
const H265 = 1
// A camera stream as the fan-out has it: a new viewer is sent its GOP so far, keyframe first
function camera(codec, { fps = 20, n = 20 } = {}) {
  const gop = Array.from({ length: n }, (_, i) => encodeFrame(Buffer.from([0, 0, 1, 1]), i === 0, codec, (i * 1000) / fps))
  return { gop, viewers: new Set(), add(ws, { replay = true } = {}) { this.viewers.add(ws); if (replay) for (const f of this.gop) ws.send(f) }, remove(ws) { this.viewers.delete(ws) } }
}
// A /live-mux channel as adaptive-live sees it: close() tells the page, and 'close' comes on a later tick
function channel() {
  return {
    OPEN: 1, readyState: 1, bufferedAmount: 0, got: [], handlers: {}, closedWith: null,
    send(b) { this.got.push(b) },
    on(e, f) { this.handlers[e] = f },
    close(code, reason) {
      if (this.closedWith) return
      this.closedWith = { code, reason }
      this.readyState = 3
      setImmediate(() => this.handlers.close?.())
    }
  }
}
const h265Sent = (ws) => ws.got.filter((b) => b[1] === H265).length
const converters = () => ({ push() {}, close() {} })

// ---- the 15 Oct case: a page's conversions still running, the next page's H.265 camera finds no slot
{
  const logs = []
  const pool = new TranscodePool(2)
  const live = new AdaptiveLive({ pool, makeTranscoder: converters, log: (l) => logs.push(l), budgetBps: 1e9 })
  // page 1: two H.265 cameras, each converted at full (the browser did not say it plays H.265)
  const a = camera(H265)
  const b = camera(H265)
  const wa = channel()
  const wb = channel()
  live.attach('af087be5', { ws: wa, nvrId: 'nvr1', ch: 0, type: 1, source: a })
  live.attach('af087be5', { ws: wb, nvrId: 'nvr1', ch: 1, type: 1, source: b })
  check('page 1: both H.265 cameras converted, the pool full', pool.active === 2 && !a.viewers.has(wa) && !b.viewers.has(wb) && h265Sent(wa) + h265Sent(wb) === 0, `${pool.active} in use`)
  // the viewer pages on: page 1's tiles close, page 2's open at once (their conversions run on FULL_STOP_MS)
  wa.close(1000, '')
  wb.close(1000, '')
  await sleep(1)
  const v2 = camera(H265)
  const w = channel()
  live.attach('af087be5', { ws: w, nvrId: 'value4u', ch: 1, type: 1, source: v2 })
  check('page 2: value4u/2 (H.265) with no slot free: not one H.265 frame sent to a browser that cannot play it', h265Sent(w) === 0, `${h265Sent(w)} H.265 frames sent`)
  check('  not put on the camera\'s own stream', !v2.viewers.has(w))
  check(`  its tile is closed 1013 "${NO_ROOM}": the page says the server is busy and asks again`, w.closedWith?.code === 1013 && w.closedWith?.reason === NO_ROOM, JSON.stringify(w.closedWith))
  check('  the log says so, with the pool', logs.some((l) => /^\[adaptive\] value4u\/2: no conversion slot for its H\.265 sub stream \(2 of 2 in use\)/.test(l)), logs.at(-1))
  // the tile asks again at once, twice (live-tile.js #askH264 before this fix): the same answer, quietly
  const n = logs.length
  const w2 = channel()
  live.attach('af087be5', { ws: w2, nvrId: 'value4u', ch: 1, type: 1, source: v2 })
  check('  asked again within the minute: the same, not said again in the log', w2.closedWith?.reason === NO_ROOM && h265Sent(w2) === 0 && logs.length === n)
  await sleep(1)
  const v = live.viewers.get('af087be5')
  check('  a socket so closed leaves the viewer (its close handler)', v === undefined || ![...v.sockets].some((e) => e.ws === w || e.ws === w2))
  // once the old page's conversions have stopped, the tile's next ask is converted
  await sleep(FULL_STOP_MS + 200)
  const w3 = channel()
  live.attach('af087be5', { ws: w3, nvrId: 'value4u', ch: 1, type: 1, source: v2 })
  check('a slot free again: the next ask is converted (no H.265, not closed)', !w3.closedWith && !v2.viewers.has(w3) && live.streams.has('value4u/1/1@full') && h265Sent(w3) === 0, JSON.stringify(w3.closedWith))
  w3.close(1000, '')
  clearInterval(live.timer)
}

// ---- no slot: H.264, or a browser that plays H.265, still gets the camera's own stream
{
  const live = new AdaptiveLive({ pool: new TranscodePool(0), makeTranscoder: converters, log: () => {}, budgetBps: 1e9 })
  const plays = camera(H265)
  const w1 = channel()
  live.attach('hevc', { ws: w1, nvrId: 'n1', ch: 0, type: 1, source: plays, clientH265: true })
  check('no slot, a browser that plays H.265: the camera\'s own H.265, as before', plays.viewers.has(w1) && !w1.closedWith && h265Sent(w1) > 0)
  const h264 = camera(H264)
  const w2 = channel()
  live.attach('pc', { ws: w2, nvrId: 'n1', ch: 1, type: 1, source: h264 })
  check('no slot, an H.264 camera: its own stream, as before', h264.viewers.has(w2) && !w2.closedWith)
  // a main for the full-size view: its own reason, so the page stays on the sub-stream quietly
  const main = camera(H265)
  const w3 = channel()
  live.attach('pc', { ws: w3, nvrId: 'n1', ch: 2, type: 0, source: main })
  check(`no slot, an H.265 main for a browser without H.265: closed "${NO_ROOM_MAIN}", nothing sent`, w3.closedWith?.reason === NO_ROOM_MAIN && h265Sent(w3) === 0 && !main.viewers.has(w3), JSON.stringify(w3.closedWith))
  clearInterval(live.timer)
}

// ---- found to be H.265 only after it joined (no keyframe, no codec seen), and no slot then
{
  let now = 1_000_000
  const live = new AdaptiveLive({ pool: new TranscodePool(0), makeTranscoder: converters, log: () => {}, budgetBps: 1e9, now: () => now })
  const cold = camera(H265)
  const gop = cold.gop
  cold.gop = []
  const w = channel()
  live.attach('pc', { ws: w, nvrId: 'n1', ch: 3, type: 1, source: cold })
  check('nothing known of the camera yet: its own stream (as before)', cold.viewers.has(w) && !w.closedWith)
  cold.gop = gop // its first keyframe: H.265
  now += 2000
  live.tick()
  check('  the next look finds it H.265 with no slot: off the raw stream, closed "no room"', !cold.viewers.has(w) && w.closedWith?.reason === NO_ROOM, JSON.stringify(w.closedWith))
  clearInterval(live.timer)
}

// ---- below full: an H.265 sub with nothing to thin is never passed through to a browser without H.265
{
  let now = 1_000_000
  const made = []
  const make = (o) => { const x = { o, push() {}, close() {} }; made.push(x); return x }
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: make, log: () => {}, budgetBps: 1e9, now: () => now })
  const cam = camera(H265, { fps: 20, n: 24 }) // a 20 fps sub: at level 15, 1 in round(20/15) = 1, nothing to thin
  const pc = channel()
  const tv = channel()
  live.attach('pc', { ws: pc, nvrId: 'value4u', ch: 1, type: 1, source: cam })
  live.attach('hevc', { ws: tv, nvrId: 'value4u', ch: 1, type: 1, source: cam, clientH265: true })
  // both links back up: level 15
  now += SETTLE_MS
  for (const ws of [pc, tv]) ws.overSince = now - 3000
  live.tick()
  const lv = (k) => LEVELS[live.viewers.get(k).level].id
  check('both viewers stepped down to 15', lv('pc') === '15' && lv('hevc') === '15', `${lv('pc')} ${lv('hevc')}`)
  check('  the browser that plays H.265: the camera\'s own stream (nothing to thin at 15)', cam.viewers.has(tv))
  const s = live.streams.get('value4u/1/1@15+h264')
  check('  the one that does not: a level-15 stream of its own that converts H.265 even with nothing to thin', !cam.viewers.has(pc) && Boolean(s) && s.h264Only === true && s.clients.has(pc), [...live.streams.keys()].join())
  check('  never sent H.265', h265Sent(pc) === 0, `${h265Sent(pc)} H.265 frames`)
  clearInterval(live.timer)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
