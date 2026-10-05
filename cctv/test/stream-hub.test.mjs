// Tests for the live-worker IPC messages (worker-ipc.mjs) and the parent-side fan-out (stream-hub.mjs).
// Pure JS: no SDK, no NVR.
// Run:  node cctv/test/stream-hub.test.mjs
import { MSG, streamKey, want, unwant, frameMsg } from '../worker-ipc.mjs'
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`) }
check('streamKey', streamKey(18, 0) === '18:0')
check('want/unwant', JSON.stringify(want(3, 1)) === '{"t":"want","ch":3,"type":1,"background":false}' && want(3, 1, true).background === true && unwant(3, 1).t === MSG.UNWANT)
const b = Buffer.from([1, 2, 3])
const f = frameMsg('3:1', b, true)
check('frame keeps the Buffer and the key flag', f.t === MSG.FRAME && f.key === '3:1' && f.buf === b && f.isKey === true)

// ---- HubStream / StreamHub
const { StreamHub } = await import('../stream-hub.mjs')
const sent = []
const hub = new StreamHub('n1', (m) => sent.push(m), { stopDelayMs: { 0: 50, 1: 50 } })
const fakeWs = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, got: [], send(b) { this.got.push(b) } })
const a = fakeWs()
const s = hub.getStream(18, 0)
s.add(a)
check('first viewer asks the worker once', sent.filter((m) => m.t === 'want').length === 1 && sent[0].ch === 18 && sent[0].type === 0)
hub.getStream(18, 0).add(fakeWs())
check('second viewer: same stream, no second want', hub.getStream(18, 0) === s && sent.filter((m) => m.t === 'want').length === 1)
const P = (k) => Buffer.from([k ? 1 : 0, 9])
s.onFrame(P(false), false)
check('no keyframe yet: nothing sent (waitForKey)', a.got.length === 0)
s.onFrame(P(true), true); s.onFrame(P(false), false)
check('keyframe then delta reach the viewer', a.got.length === 2)
const late = fakeWs(); s.add(late)
check('late viewer gets the GOP replayed at once', late.got.length === 2)
const slow = fakeWs(); s.add(slow); slow.bufferedAmount = 5 * 1024 * 1024
s.onFrame(P(false), false)
check('slow viewer skips to the next keyframe', slow.got.length === 2 && a.got.length === 3)
s.remove(a)
await new Promise((r) => setTimeout(r, 80))
check('no unwant while viewers remain', !sent.some((m) => m.t === 'unwant'))
for (const w of [...s.clients]) s.remove(w)
s.add(a); s.remove(a) // a viewer inside the linger cancels it and restarts it
await new Promise((r) => setTimeout(r, 30))
check('no unwant inside the linger', !sent.some((m) => m.t === 'unwant'))
await new Promise((r) => setTimeout(r, 60))
check('unwant after the linger', sent.at(-1).t === 'unwant' && sent.filter((m) => m.t === 'unwant').length === 1 && !hub.streams.has('18:0'))
const aBefore = a.got.length
hub.onMessage({ t: 'frame', key: '18:0', buf: P(true), isKey: true })
check('frames for an unwanted stream are ignored', !hub.streams.has('18:0') && a.got.length === aBefore)
{
  const v = fakeWs()
  const s2 = hub.getStream(4, 1)
  s2.add(v)
  hub.onMessage({ t: 'frame', key: '4:1', buf: P(true), isKey: true })
  check('frames are routed by key', v.got.length === 1)
  const wantsBefore = sent.filter((m) => m.t === 'want' && m.ch === 4).length
  hub.onWorkerRestart()
  check('worker restart: viewers wait for a keyframe again', [...hub.streams.values()].every((x) => x.gop.length === 0) && v.waitForKey === true)
  check('worker restart: watched streams are asked for again', sent.filter((m) => m.t === 'want' && m.ch === 4).length === wantsBefore + 1)
  hub.onMessage({ t: 'frame', key: '4:1', buf: P(false), isKey: false })
  check('after restart: deltas held back until a keyframe', v.got.length === 1)
  for (let i = 0; i < 405; i++) s2.onFrame(P(i === 0), i === 0)
  check('GOP capped at 400 frames (then new viewers wait)', s2.gop.length <= 400)
  // M2: NVR removed: the sockets' close handlers call remove(); no linger timer may be left behind
  const closedWs = { ...fakeWs(), close() { s2.remove(this) } }
  s2.remove(v)
  s2.add(closedWs) // the only viewer: its close handler would arm the linger
  const unwants = sent.filter((m) => m.t === 'unwant').length
  hub.closeAll()
  check('closeAll leaves no linger timer', s2.stopTimer === null && hub.streams.size === 0)
  await new Promise((r) => setTimeout(r, 80))
  check('closeAll: no unwant sent afterwards', sent.filter((m) => m.t === 'unwant').length === unwants)
}
{
  // A socket moved onto the camera's own stream by a level change (adaptive-live.mjs) joins at that
  // stream's next keyframe, with nothing replayed: it has the picture the replay would start from, and
  // a replay of the GOP so far stepped it back in time by up to a keyframe interval (stutter report
  // 2.5, verify-5). The caller says where it starts (waitForKey); the stream sends nothing before that.
  const h = new StreamHub('n3', () => {}, { stopDelayMs: { 0: 50, 1: 50 } })
  const s3 = h.getStream(1, 1)
  s3.add(fakeWs())
  s3.onFrame(P(true), true)
  s3.onFrame(P(false), false)
  const moved = { ...fakeWs(), waitForKey: true }
  s3.add(moved, { replay: false })
  check('add with replay: false: the GOP so far is not replayed', moved.got.length === 0)
  s3.onFrame(P(false), false)
  check('... it waits for a keyframe, as the caller left it', moved.got.length === 0)
  s3.onFrame(P(true), true)
  check('... and takes the stream from there', moved.got.length === 1 && moved.got[0][0] === 1)
  // added from inside the fan-out of a keyframe (a tap that watches for it): that keyframe, once
  const joins = { ...fakeWs(), waitForKey: true }
  let armed = false
  const tap = { ...fakeWs(), send(buf) { if (armed && buf[0] === 1) { s3.remove(this); s3.add(joins, { replay: false }) } } }
  s3.add(tap) // (the replay it is sent as it joins is not what it watches for)
  armed = true
  s3.onFrame(P(false), false)
  s3.onFrame(P(true), true)
  s3.onFrame(P(false), false)
  check('a socket added by a tap as a keyframe goes out: that keyframe and what follows, each once, nothing before', joins.got.length === 2 && joins.got[0][0] === 1 && joins.got[1][0] === 0 && !s3.clients.has(tap), `${joins.got.map((x) => x[0])}`)
  check('... a default add still replays the GOP (a new tile)', (() => { const n = fakeWs(); s3.add(n); return n.got.length === 2 })())
}
{
  // I2: restart request goes to the worker
  const h = new StreamHub('n2', (m) => sent.push(m))
  h.restartStream(5, 1, 'sub-stream codec changed')
  const r = sent.at(-1)
  check('restartStream sends a restart message', r?.t === MSG.RESTART && r.ch === 5 && r.type === 1 && r.why === 'sub-stream codec changed')
}

{
  // warm-ups ask the worker as background; a real viewer arriving later is told to it, so the
  // worker starts that stream ahead of the other warm-ups (viewers first, in the worker too)
  const msgs = []
  const h = new StreamHub('n9', (m) => msgs.push(m), { stopDelayMs: { 0: 50, 1: 50 } })
  const s9 = h.getStream(7, 1)
  s9.add({ ...fakeWs(), background: true })
  check('a warm-up asks for the stream as background', msgs.length === 1 && msgs[0].t === MSG.WANT && msgs[0].background === true, JSON.stringify(msgs))
  s9.add(fakeWs())
  check('a viewer then: the worker is told it is wanted in the foreground', msgs.length === 2 && msgs[1].t === MSG.WANT && msgs[1].background === false, JSON.stringify(msgs))
  s9.add(fakeWs())
  check('a second viewer: nothing more to tell', msgs.length === 2)
  h.onWorkerRestart()
  check('after a worker restart it is asked for again as foreground', msgs.at(-1).t === MSG.WANT && msgs.at(-1).background === false)
  const s8 = h.getStream(8, 1)
  s8.add(fakeWs())
  check('a viewer first: foreground straight away', msgs.at(-1).ch === 8 && msgs.at(-1).background === false)
  // the viewers leave, the warm-up stays: back to background, so it waits behind real viewers again
  const s6 = h.getStream(6, 1)
  const warm = { ...fakeWs(), background: true }
  const viewer = fakeWs()
  s6.add(warm)
  s6.add(viewer)
  s6.remove(viewer)
  check('the last viewer leaves a warm-up stream: the worker is told it is background again', msgs.at(-1).ch === 6 && msgs.at(-1).t === MSG.WANT && msgs.at(-1).background === true && s6.fg === false, JSON.stringify(msgs.at(-1)))
  // the last viewer leaves a sub-stream: its linger is background (a viewer's may take its place at
  // an NVR's sub-stream limit, nvr-worker.mjs); a viewer back within it makes it foreground again
  const s5 = h.getStream(5, 1)
  const only = fakeWs()
  s5.add(only)
  s5.remove(only)
  check('a sub-stream nobody watches any more: background for its linger', msgs.at(-1).ch === 5 && msgs.at(-1).type === 1 && msgs.at(-1).background === true && s5.fg === false && s5.wanted === true, JSON.stringify(msgs.at(-1)))
  s5.add(fakeWs())
  check('... a viewer back within the linger: foreground again', msgs.at(-1).ch === 5 && msgs.at(-1).background === false && s5.fg === true)
  const m7 = h.getStream(7, 0)
  const full = fakeWs()
  m7.add(full)
  const before = msgs.length
  m7.remove(full)
  check('... a main stream\'s linger is left as it was (foreground)', msgs.length === before && m7.fg === true)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
