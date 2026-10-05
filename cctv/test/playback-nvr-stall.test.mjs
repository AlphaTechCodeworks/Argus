// The NVR playback session (playback.mjs PlaybackSession) when the NVR stops answering mid-play
// (playback hunt F8): those NVRs stalled when many streams were opened, and the session sent
// {type:'end'} after 8 s of silence even though the recording had not ended -- the page then seeked
// away or said "End of recordings". Now, while the NVR has an overdue SDK call (nvrStalled), the
// silence is read as the NVR not answering: a {type:'notice', waiting:true} is sent once and the
// session waits; {type:'end'} is sent only when the NVR is answering and there is simply no more
// footage. The stall signal (lateCalls/sdkStuck) is injected here so both paths are deterministic.
// Fake NVRs whose lane answers each SDK job without running it (as playback-hd-switch.test.mjs);
// nothing reaches an NVR, but playback.mjs loads koffi, so this runs on the server copy.
//   node cctv/test/playback-nvr-stall.test.mjs        (on the server copy)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'pb-nvr-stall-'))
const pb = await import('../playback.mjs')
const { playFrames } = await import('../sdk.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

// A fake NVR whose lane answers each job from `answers` (then true): the clock read, PlayBackByTimeEx
// (a handle), SetPlayDataCallBack, then controls. `nvrStalled` is passed through to createPlayback.
const fakeNvr = (id, answers, { nvrStalled } = {}) => {
  let n = 0
  const nvr = {
    id, name: `NVR ${id}`, userId: 7, online: true, degraded: false,
    lane: { run: async () => { const k = n++; return k < answers.length ? answers[k] : true } },
    sessions: { acquire: async () => ({ userId: 9, release() {} }) }
  }
  nvr.playback = pb.createPlayback(nvr, { nvrStalled })
  return nvr
}
// the SDK's playback callback is routed by handle (sdk.mjs playFrames): keep each route so a test can
// hand a session a frame as the NVR would
const routes = new Map()
const realClaim = playFrames.claim.bind(playFrames)
playFrames.claim = (h, fn) => { routes.set(h, fn); realClaim(h, fn) }
const frame = (h) => routes.get(h)({ frameType: 1, length: 16, keyFrame: 1, width: 64, height: 36, time: Date.now() * 1000 }, Buffer.alloc(16, 1))
const fakeWs = () => {
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, sent: [], closedWith: null, handlers: {} }
  ws.send = (m) => typeof m === 'string' && ws.sent.push(JSON.parse(m))
  ws.on = (event, fn) => (ws.handlers[event] = fn)
  ws.close = (code, reason) => { if (ws.readyState !== 1) return; ws.readyState = 3; ws.closedWith = { code, reason }; ws.handlers.close?.() }
  ws.command = (obj) => ws.handlers.message(Buffer.from(JSON.stringify(obj)), false)
  return ws
}
const url = (id) => new URL(`ws://x/playback?nvr=${id}&ch=0&start=${Date.now() - 3_600_000}`)
const types = (ws) => ws.sent.map((m) => m.type).join()
const until = async (pred, ms) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await sleep(50); return pred() }
const waits = (ws) => ws.sent.filter((m) => m.type === 'notice' && m.waiting)

// ---- the NVR stalls mid-play: a notice, not an end; then a frame; then a real end -------------------
{
  let stalled = true
  const nvr = fakeNvr('pb-stall', [true, 91], { nvrStalled: () => stalled })
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-stall'), { main: false, allowMain: () => true })
  await until(() => ws.sent.some((m) => m.type === 'started'), 3000)
  frame(91) // one frame: the session is really playing
  // ~9 s of silence while the NVR has an overdue call (stalled): "not answering", no end
  await until(() => waits(ws).length > 0, 11000)
  check('a stalled NVR, 8 s without a frame: a "not answering" notice, not {type:"end"}', waits(ws).length >= 1 && /not answering/i.test(waits(ws)[0].message) && !ws.sent.some((m) => m.type === 'end'), types(ws))
  await sleep(2500) // the #watch keeps ticking past 8 s
  check('  said once while it stays stalled, not at every tick, and still no end', waits(ws).length === 1 && !ws.sent.some((m) => m.type === 'end'), `${waits(ws).length} notices; ${types(ws)}`)
  // a frame arrives: the stall is over (and a later stall could be said again)
  frame(91)
  check('  a frame clears the stall state', !ws.sent.some((m) => m.type === 'end'))
  // the NVR is answering again, and there is simply no more footage: a real end
  stalled = false
  const ended = await until(() => ws.sent.some((m) => m.type === 'end'), 11000)
  check('a real end (the NVR answering, no more footage): {type:"end"} as before', ended && ws.sent.some((m) => m.type === 'end'), types(ws))
  ws.close(1000)
}

// ---- no stall: the old behaviour (end after 8 s of silence) is unchanged ----------------------------
{
  const nvr = fakeNvr('pb-end', [true, 92], { nvrStalled: () => false })
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-end'), { main: false, allowMain: () => true })
  await until(() => ws.sent.some((m) => m.type === 'started'), 3000)
  frame(92)
  const ended = await until(() => ws.sent.some((m) => m.type === 'end'), 11000)
  check('an NVR that answers but has no more footage: {type:"end"} after 8 s, and no "not answering" notice', ended && waits(ws).length === 0, types(ws))
  ws.close(1000)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
