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

// ---- a stream kept past its linger (adaptive-live.mjs keeps a socket's source and adds to it again
// when a stopped page writes again). It had left the hub: it got no frames, and its next linger's
// unwant stopped the newer stream of the same camera under its viewers.
{
  const msgs = []
  const h = new StreamHub('n4', (m) => msgs.push(m), { stopDelayMs: { 0: 30, 1: 30 } })
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const count = (t) => msgs.filter((m) => m.t === t).length
  const frame = (key) => h.onMessage({ t: MSG.FRAME, key, buf: Buffer.from([1, 9]), isKey: true })
  const old = h.getStream(5, 0)
  const v = fakeWs()
  old.add(v)
  old.remove(v)
  await wait(60)
  check('kept stream: its linger over, it has left the hub', !h.streams.has('5:0') && msgs.at(-1).t === MSG.UNWANT)
  old.add(v)
  frame('5:0')
  check('kept stream: added to again with its key free, it is the hub\'s stream again', h.streams.get('5:0') === old && h.getStream(5, 0) === old && msgs.at(-1).t === MSG.WANT)
  check('kept stream: ... and its viewer gets the frames', v.got.length === 1, String(v.got.length))
  old.remove(v)
  await wait(60)
  // a newer stream of the camera has taken its place by the time it is added to again
  const newer = h.getStream(5, 0)
  const other = fakeWs()
  newer.add(other)
  const wants = count(MSG.WANT)
  const back = fakeWs()
  old.add(back)
  frame('5:0')
  check('kept stream: with a newer one in the hub, its socket goes onto that one', newer !== old && newer.clients.has(back) && old.clients.size === 0 && back.got.length === 1 && other.got.length === 1)
  check('kept stream: ... and asks the worker for nothing more', count(MSG.WANT) === wants)
  const unwants = count(MSG.UNWANT)
  old.remove(back)
  await wait(60)
  check('kept stream: taken off it, the socket leaves the newer one', !newer.clients.has(back) && newer.clients.has(other))
  check('kept stream: ... and no unwant stops the newer one under its viewer', count(MSG.UNWANT) === unwants && h.streams.get('5:0') === newer)
  // a linger that runs out on a stream that is not the hub's any more says nothing to the worker
  const a7 = h.getStream(7, 1)
  const w7 = fakeWs()
  a7.add(w7)
  a7.remove(w7)
  h.streams.delete('7:1')
  const b7 = h.getStream(7, 1)
  b7.add(fakeWs())
  const n = count(MSG.UNWANT)
  await wait(60)
  check('a linger ending on a stream no longer the hub\'s: no unwant, the hub\'s stream stays', count(MSG.UNWANT) === n && h.streams.get('7:1') === b7 && a7.wanted === false)
}

// ---- a P2P NVR (reached by serial number) serves only so many streams: a viewer's main stream
// asked for ends the lingers of its sub-streams nobody watches, at once, not 180 s later. In worker
// mode live.mjs #freeIdleSubs frees nothing: each lingering sub still has the parent's tap there.
{
  const { readFileSync } = await import('node:fs')
  const msgs = []
  const h = new StreamHub('p', (m) => msgs.push(m), { stopDelayMs: { 0: 10_000, 1: 180_000 }, p2p: true })
  const said = (from) => msgs.slice(from).map((m) => m.t + ' ' + m.ch + ':' + m.type + (m.background ? ' bg' : '')).join(', ')
  const idleMain = h.getStream(9, 0)
  const m9 = fakeWs()
  idleMain.add(m9)
  idleMain.remove(m9)
  const idle = [0, 1, 2].map((ch) => {
    const s = h.getStream(ch, 1)
    const w = fakeWs()
    s.add(w)
    s.remove(w)
    return s
  })
  const watched = h.getStream(3, 1)
  watched.add(fakeWs())
  const warm = h.getStream(4, 1)
  warm.add({ ...fakeWs(), background: true })
  let at = msgs.length
  // a stand-in's main (sub-bridge.mjs) is asked for in the background: nothing is freed for it
  const standIn = h.getStream(6, 0)
  standIn.add({ ...fakeWs(), background: true })
  check('P2P: a main asked for in the background frees nothing', said(at) === 'want 6:0 bg' && idle.every((s) => s.wanted), said(at))
  at = msgs.length
  h.getStream(5, 0).add(fakeWs())
  check('P2P: a viewer\'s main ends the lingers of the subs nobody watches, before its own want', said(at) === 'unwant 0:1, unwant 1:1, unwant 2:1, want 5:0', said(at))
  check('P2P: ... they have left the hub, their timers gone', idle.every((s) => !s.wanted && s.stopTimer === null && s.left) && !h.streams.has('0:1'))
  check('P2P: ... a sub with a viewer, a warm-up\'s, and a lingering main are left as they were', watched.wanted && warm.wanted && idleMain.wanted && idleMain.stopTimer !== null && h.streams.get('3:1') === watched && h.streams.get('4:1') === warm)
  at = msgs.length
  h.getStream(5, 0).add(fakeWs())
  check('P2P: a second viewer of that main asks nothing more', msgs.length === at)
  // a main the stand-in started in the background, now wanted by a viewer: freed for it then
  const s7 = h.getStream(7, 1)
  const w7 = fakeWs()
  s7.add(w7)
  s7.remove(w7)
  at = msgs.length
  standIn.add(fakeWs())
  check('P2P: a background main a viewer now wants frees them too', said(at) === 'unwant 7:1, want 6:0', said(at))
  // back to the grid: the freed sub starts again
  at = msgs.length
  h.getStream(0, 1).add(fakeWs())
  check('P2P: back on the grid, a freed sub is asked for again', said(at) === 'want 0:1', said(at))
  clearTimeout(idleMain.stopTimer)

  // an NVR reached by its address has no such limit: its subs linger on
  const lan = []
  const g = new StreamHub('lan', (m) => lan.push(m), { stopDelayMs: { 0: 10_000, 1: 180_000 } })
  const sub = g.getStream(0, 1)
  const w = fakeWs()
  sub.add(w)
  sub.remove(w)
  g.getStream(5, 0).add(fakeWs())
  check('by address: a main leaves the lingering subs alone', sub.wanted && sub.stopTimer !== null && !lan.some((m) => m.t === MSG.UNWANT))
  clearTimeout(sub.stopTimer)

  const src = (name) => readFileSync(new URL('../' + name, import.meta.url), 'utf8')
  check('wiring: nvrs.mjs tells the worker\'s hub that the NVR is a P2P one', /startWorker\(nvr\.id, \{[^\n]*p2p: Boolean\(cfg\.sn\)/.test(src('nvrs.mjs')))
  check('wiring: worker-supervisor.mjs passes it to its StreamHub', /new StreamHub\(nvrId, [^]*?\}, \{ p2p \}\)/.test(src('worker-supervisor.mjs')))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
