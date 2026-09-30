// One remote viewer's look can never stall the others (adaptive-live.mjs tick): with fake streams, no ffmpeg.
//   node cctv/test/adaptive-null-stream.test.mjs
//
// A remote main refused at a level change after #move took it off its level stream (no picture yet) is
// on no stream; a plain /live socket stays in the viewer's sockets until ws says 'close' (after the peer
// answers the close frame, up to ws's 30 s closeTimeout behind a backed-up link). The viewer's next level
// change read that null stream in #move's first pass: tick() threw, and every viewer after it in the Map
// was skipped at every tick until the socket closed -- no steps down or climbs, no switch cut over past
// its time (the bypass hunt on the merge of live-smooth into stream-rights, merge-hunt/null-stream).
import { AdaptiveLive, SETTLE_MS, TICK_MS } from '../adaptive-live.mjs'
import { StreamHub } from '../stream-hub.mjs'
import { TranscodePool } from '../transcode.mjs'

const MINUTE = 60_000 // a failed look is said once a minute a viewer (LOOK_FAILED_SAY_MS)
let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const frame = (isKey, ts) => {
  const b = Buffer.alloc(40)
  b[0] = isKey ? 1 : 0
  b.writeBigInt64LE(BigInt(ts * 1000), 8)
  return b
}
/** A /live socket; `closing`: its close is not done (no 'close' yet) until finish(). */
const fakeWs = (closing = false) => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, overSince: null, handlers: [], send() {}, on(e, f) { if (e === 'close') this.handlers.push(f); return this }, close() { if (this.readyState !== 1) return; this.readyState = 2; if (!closing) this.finish() }, finish() { this.readyState = 3; for (const f of this.handlers) f() } })

for (const closing of [false, true]) {
  let t = 1_000_000
  const logs = []
  const hub = new StreamHub('n1', () => {}, { stopDelayMs: { 0: 60_000, 1: 60_000 } })
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: (o) => ({ push: (ts, k, p) => o.onFrame(ts, k, p), endPicture() {}, close() {} }), log: (l) => logs.push(l), budgetBps: 1e12, now: () => t })
  const sub7 = hub.getStream(7, 1)
  const feed = (to) => { for (; t < to; t += 50) sub7.onFrame(frame(t % 1000 === 0, t), t % 1000 === 0) }
  const ySub = fakeWs(closing)
  const zSub = fakeWs(closing)
  live.attach('y', { ws: ySub, nvrId: 'n1', ch: 7, type: 1, source: sub7 })
  live.attach('z', { ws: zSub, nvrId: 'n1', ch: 7, type: 1, source: sub7 })
  clearInterval(live.timer)
  feed(t + SETTLE_MS + 100)
  // y's full-size view of an H.265 camera whose main has sent nothing yet: its level-full conversion is
  // made at once, with no picture; then y's Live HD goes (mayMain says so), the sweep not run yet
  let answer = true
  const yMain = fakeWs(closing)
  live.attach('y', { ws: yMain, nvrId: 'n1', ch: 8, type: 0, source: hub.getStream(8, 0), codec: 'h265', mayMain: () => answer })
  answer = 'hd not allowed'
  ySub.overSince = yMain.overSince = t - 3000
  live.tick() // y: full -> 15; its main taken off its conversion, then refused: on no stream
  ySub.overSince = yMain.overSince = null
  feed(t + SETTLE_MS + 100)
  const Y = live.viewers.get('y')
  const Z = live.viewers.get('z')
  const zBefore = Z.level
  ySub.overSince = yMain.overSince = zSub.overSince = t - 3000
  let threw = null
  try {
    live.tick()
  } catch (e) {
    threw = e.message
  }
  const label = closing ? 'socket still closing' : 'socket closed'
  const s8 = live.streams.get('n1/7/1@8')
  check(`(${label}) the refused main was closed 1008 at the first level change`, yMain.readyState !== 1)
  check(`(${label}) y's next level change: tick() does not throw`, threw === null, threw)
  check(`(${label}) z, the next viewer, is looked at in that tick`, Z.level === zBefore + 1, `${zBefore} -> ${Z.level}`)
  check(`(${label}) y's own look does not fail either: it steps down 15 -> 8, its sub onto level 8's stream, the refused main on none`, threw === null && Y.level === 2 &&[...Y.sockets].some((e) => e.ws === ySub && s8 && (e.stream === s8 || e.switch?.to === s8)) && ![...live.streams.values()].some((s) => s.clients.has(yMain)) && !logs.some((l) => l.includes('look failed')), `level ${Y.level} | ${logs.filter((l) => l.includes('look failed')).join(' | ')}`)
  if (closing) {
    yMain.finish()
    check(`(${label}) once its close is done, let go`, ![...Y.sockets].some((e) => e.ws === yMain) && Y.sockets.size === 1)
  }
}

// ---- a viewer whose look throws, whatever the cause: the others are looked at as usual ----
{
  let t = 2_000_000
  const logs = []
  const hub = new StreamHub('n1', () => {}, { stopDelayMs: { 0: 60_000, 1: 60_000 } })
  const live = new AdaptiveLive({ pool: new TranscodePool(8), makeTranscoder: (o) => ({ push: (ts, k, p) => o.onFrame(ts, k, p), endPicture() {}, close() {} }), log: (l) => logs.push(l), budgetBps: 1e12, now: () => t })
  const sub3 = hub.getStream(3, 1)
  const feed = (to) => { for (; t < to; t += 50) sub3.onFrame(frame(t % 1000 === 0, t), t % 1000 === 0) }
  const [a, b, c] = ['a', 'b', 'c'].map((k) => {
    const ws = fakeWs()
    live.attach(k, { ws, nvrId: 'n1', ch: 3, type: 1, source: sub3 })
    return ws
  })
  clearInterval(live.timer)
  feed(t + SETTLE_MS + 100)
  // a's look throws (a stand-in for any bug: its socket's backpressure mark cannot be read), b and c
  // are after it in the Map and backed up
  let broken = true
  Object.defineProperty(a, 'overSince', { get() { if (broken) throw new Error('a broken socket'); return null }, configurable: true })
  b.overSince = c.overSince = t - 3000
  const [A, B, C] = ['a', 'b', 'c'].map((k) => live.viewers.get(k))
  // (what tick() threw, if anything)
  const thrown = []
  const look = () => {
    try {
      live.tick()
    } catch (e) {
      thrown.push(e.message)
    }
  }
  look()
  const said = () => logs.filter((l) => l.includes('its look failed'))
  check('a viewer whose look throws: tick() does not throw', thrown.length === 0, thrown[0])
  check('  the viewers after it are looked at in that tick (both step down)', B.level === 1 && C.level === 1, `b ${B.level}, c ${C.level}`)
  check('  said, naming the viewer and the error', said().length === 1 && said()[0].startsWith('[adaptive] a: its look failed') && said()[0].includes('a broken socket'), said().join(' | '))
  // ten more looks within the minute, backed up again: it fails at each, said no more; the others step
  // down again
  b.overSince = c.overSince = t - 3000
  for (let i = 0; i < 10; i++) {
    t += TICK_MS
    look()
  }
  check('  failing at every look: said once a minute, not at each; tick() never throws', said().length === 1 && thrown.length === 0, `${said().length} said, ${thrown.length} thrown`)
  check('  ... and the others are looked at at each (stepped down further)', B.level > 1 && C.level > 1, `b ${B.level}, c ${C.level}`)
  t += MINUTE
  look()
  check('  a minute on: said again, with how many were not said', said().length === 2 && said()[1].includes('(10 more since it was last said)'), said().at(-1))
  broken = false
  Object.defineProperty(a, 'overSince', { value: t - 3000, writable: true, configurable: true })
  t += TICK_MS
  look()
  check('  once it no longer throws, looked at as any other (it steps down too)', A.level === 1 && said().length === 2 && thrown.length === 0, `a ${A.level}`)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
