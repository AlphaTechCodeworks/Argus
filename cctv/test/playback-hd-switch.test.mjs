// The NVR playback session's switch to the main stream (playback.mjs PlaybackSession, hd-only.mjs):
// a camera the NVR records in HD only is found by "no SD frame in 4 s of the NVR playing", and only a
// viewer who may see main is switched, asked then and again once the SD playback has stopped; anyone
// else is refused once no SD frame has come in 6 s of playing. The 4 s used to be counted from before
// the session had started (openedAt 0 until the NVR answered) and through a pause at open, so a slow
// NVR or the camera wall marked cameras HD-only for good. Fake NVRs whose lane answers each SDK job
// without running it (as playback-busy.test.mjs): nothing reaches an NVR, but playback.mjs loads
// koffi, so this runs on the server copy. A frame is handed to a session as the NVR would, through the
// SDK's playback route (frame(), below): an SD frame clears a mark, the first main frame sets it.
//   node cctv/test/playback-hd-switch.test.mjs        (on the server copy)
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'pb-hd-switch-'))
const pb = await import('../playback.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const HD_FILE = join(process.env.DATA_DIR, 'hd-only.json')
const marked = (id, ch) => existsSync(HD_FILE) && String(ch) in (JSON.parse(readFileSync(HD_FILE, 'utf8'))[id] ?? {})

/**
 * A fake NVR. Its lane answers each job in turn from `answers` (then true) without running it: the
 * clock read, PlayBackByTimeEx (a handle), SetPlayDataCallBack, then stops and controls. `slow` holds
 * the answer to job number `slow.job` for `slow.ms` (a tile waiting behind others in the NVR's lane).
 * `acquireMs` holds the login (the NVR's few playback logins all taken); `doneAt[k]`: when job k was
 * answered.
 */
const fakeNvr = (id, answers, slow = null, { acquireMs = 0 } = {}) => {
  let n = 0
  const nvr = {
    id, name: `NVR ${id}`, userId: 7, online: true, degraded: false, jobs: 0, doneAt: [],
    lane: {
      run: async () => {
        const k = n++
        nvr.jobs++
        if (slow && k === slow.job) await sleep(slow.ms)
        nvr.doneAt[k] = Date.now()
        return k < answers.length ? answers[k] : true
      }
    },
    sessions: {
      acquire: async () => {
        if (acquireMs) await sleep(acquireMs)
        return { userId: 9, release() {} }
      }
    }
  }
  nvr.playback = pb.createPlayback(nvr)
  return nvr
}
// Frames: the SDK's playback callback is routed by handle (sdk.mjs playFrames). Each handle's route is
// kept here, so a test can hand a session a frame as the NVR would.
const { playFrames } = await import('../sdk.mjs')
const routes = new Map()
const realClaim = playFrames.claim.bind(playFrames)
playFrames.claim = (h, fn) => {
  routes.set(h, fn)
  realClaim(h, fn)
}
const frame = (h) => routes.get(h)({ frameType: 1, length: 16, keyFrame: 1, width: 64, height: 36, time: Date.now() * 1000 }, Buffer.alloc(16, 1))
/** A fake browser WebSocket for /playback: the JSON it is sent, and how it was closed. */
const fakeWs = () => {
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, sent: [], closedWith: null, handlers: {} }
  ws.send = (m) => typeof m === 'string' && ws.sent.push(JSON.parse(m))
  ws.on = (event, fn) => (ws.handlers[event] = fn)
  ws.close = (code, reason) => {
    if (ws.readyState !== 1) return
    ws.readyState = 3
    ws.closedWith = { code, reason }
    ws.handlers.close?.()
  }
  ws.command = (obj) => ws.handlers.message(Buffer.from(JSON.stringify(obj)), false)
  return ws
}
const url = (id) => new URL(`ws://x/playback?nvr=${id}&ch=0&start=${Date.now() - 3_600_000}`)
const types = (ws) => ws.sent.map((m) => m.type).join()
const until = async (pred, ms) => {
  const t = Date.now()
  while (!pred() && Date.now() - t < ms) await sleep(50)
  return pred()
}

// (M1) the open is slow (its SetPlayDataCallBack waits 1.5 s in the NVR's lane); no right to see main
{
  let asked = 0
  const nvr = fakeNvr('pb-slow', [true, 77], { job: 2, ms: 1500 })
  const ws = fakeWs()
  const r = nvr.playback.connect(ws, url('pb-slow'), { main: false, allowMain: () => { asked++; return false } })
  check('connect: the sub-stream, as asked', r?.main === false)
  await sleep(1200)
  check('M1: while the open waits in the NVR lane (500 ms ticks go by), nothing is decided, nobody asked', ws.sent.length === 0 && ws.closedWith === null && asked === 0, types(ws))
  await until(() => ws.sent.some((m) => m.type === 'started'), 3000)
  const startedAt = Date.now()
  await sleep(5000)
  check('... started, 5 s of playing without a frame: still waiting (nothing to switch to: SD_REFUSE_MS is 6 s)', ws.closedWith === null && !ws.sent.some((m) => m.type === 'stream'), types(ws))
  await until(() => ws.closedWith !== null, 3000)
  check('... 6 s of playing, no SD frame, no right to see main: {type:"error"}, then 1008 "hd not allowed"', ws.closedWith?.code === 1008 && ws.closedWith.reason === 'hd not allowed' && ws.sent.at(-1)?.type === 'error' && /No SD recording/.test(ws.sent.at(-1).message) && asked >= 1 && Date.now() - startedAt >= 5500, `${JSON.stringify(ws.closedWith)} ${types(ws)}`)
  check('... never switched to main, and the camera not marked HD-only', !ws.sent.some((m) => m.type === 'stream') && !marked('pb-slow', 0))
}

// (M2) opened paused (the camera wall opens its tiles paused), played 5 s later
{
  let asked = 0
  const nvr = fakeNvr('pb-paused', [true, 78])
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-paused'), { main: false, allowMain: () => { asked++; return false } })
  ws.command({ pause: true })
  await until(() => ws.sent.some((m) => m.type === 'started'), 3000)
  await sleep(5000)
  check('M2: paused from the start, 5 s: nothing decided (a paused NVR sends no frames)', ws.closedWith === null && asked === 0, types(ws))
  ws.command({ pause: false })
  await sleep(5000)
  check('... played: 5 s later still waiting (the count started again at play)', ws.closedWith === null)
  await until(() => ws.closedWith !== null, 3000)
  check('... then refused as above, after 6 s of playing', ws.closedWith?.reason === 'hd not allowed' && asked >= 1)
}

// a viewer who may see main: switched, told, watched for it (onMain); marked only once main frames come
{
  let asked = 0
  let told = 0
  const nvr = fakeNvr('pb-hd', [true, 79, true, true, true, 80, true])
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-hd'), { main: false, allowMain: () => { asked++; return true }, onMain: () => told++ })
  await until(() => ws.sent.some((m) => m.type === 'stream'), 8000)
  check('allowed: no SD in 4 s of playing, so over to main: {type:"stream", stream:0}', ws.sent.some((m) => m.type === 'stream' && m.stream === 0) && ws.closedWith === null, types(ws))
  check('... asked when the 4 s ran out, and again once the SD playback had stopped', asked === 2, String(asked))
  check('... the caller is told (the server watches it for the main-stream rights at once, and audits it)', told === 1)
  check('... not marked HD-only yet: no main frame has come (a slow NVR is no proof)', !marked('pb-hd', 0))
  ws.close(1000)
}

// allowed when the 4 s ran out, the right gone while the NVR stopped the SD playback: refused, never main
{
  let asked = 0
  let told = 0
  const nvr = fakeNvr('pb-gone', [true, 82])
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-gone'), { main: false, allowMain: () => ++asked === 1, onMain: () => told++ })
  await until(() => ws.closedWith !== null, 8000)
  check('the right taken away during the switch: {type:"error"}, 1008 "hd not allowed", no {type:"stream"}, nothing watched for main', ws.closedWith?.reason === 'hd not allowed' && ws.sent.at(-1)?.type === 'error' && !ws.sent.some((m) => m.type === 'stream') && asked === 2 && told === 0, `${JSON.stringify(ws.closedWith)} ${types(ws)} asked ${asked}`)
}

// (M1, a slower open) the login waits 9 s, then SetPlayDataCallBack 1.5 s: longer than IDLE_END_MS (8 s),
// so "no frame for 8 s, the recording has ended" must not be judged before the session has started either
{
  const nvr = fakeNvr('pb-login', [true, 86], { job: 2, ms: 1500 }, { acquireMs: 9000 })
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-login'), { main: false, allowMain: () => true })
  await until(() => ws.sent.some((m) => m.type === 'started'), 14_000)
  check('M1, a 9 s login and a slow SetPlayDataCallBack: nothing but "started" (no "end", no "stream") before it', ws.sent[0]?.type === 'started' && ws.closedWith === null, types(ws))
  ws.close(1000)
}

// after the switch the main stream opens slowly (its SetPlayDataCallBack waits 5 s): not judged "end"
// either; the camera is marked HD-only when the first main frame comes, not before
{
  const nvr = fakeNvr('pb-reopen', [true, 87, true, true, true, 88], { job: 6, ms: 5000 })
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-reopen'), { main: false, allowMain: () => true })
  await until(() => ws.sent.some((m) => m.type === 'stream'), 8000)
  await until(() => ws.sent.filter((m) => m.type === 'started').length === 2, 8000)
  check('the main stream re-opening slowly after the switch: no "end" before it has started', types(ws) === 'started,stream,started', types(ws))
  check('... not marked HD-only before a main frame', !marked('pb-reopen', 0) && !nvr.playback.isHdOnly(0))
  frame(88)
  check('... marked with its first main frame', marked('pb-reopen', 0) && nvr.playback.isHdOnly(0))
  ws.close(1000)
}

// an SD frame clears a mark (here one made meanwhile, as another session would): a false mark heals itself
{
  const nvr = fakeNvr('pb-heal', [true, 89])
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-heal'), { main: false, allowMain: () => true })
  await until(() => ws.sent.some((m) => m.type === 'started'), 3000)
  nvr.playback.markHdOnly(0)
  const was = marked('pb-heal', 0)
  frame(89)
  check('an SD frame clears the camera\'s HD-only mark', was && !marked('pb-heal', 0) && !nvr.playback.isHdOnly(0), types(ws))
  ws.close(1000)
}

// (M2, paused mid-count) 3 s of playing without a frame, paused 1 s, played again: the 4 s start again
{
  const nvr = fakeNvr('pb-midpause', [true, 90])
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-midpause'), { main: false, allowMain: () => true })
  await until(() => ws.sent.some((m) => m.type === 'started'), 3000)
  await sleep(3000)
  ws.command({ pause: true })
  await sleep(1000)
  ws.command({ pause: false })
  const playedAt = Date.now()
  await sleep(3000)
  check('M2, paused after 3 s of playing, then played: 3 s later still waiting (the count started again at play)', !ws.sent.some((m) => m.type === 'stream'), types(ws))
  await until(() => ws.sent.some((m) => m.type === 'stream'), 3000)
  check('... then over to main, 4 s after the play', ws.sent.some((m) => m.type === 'stream') && Date.now() - playedAt >= 3500, types(ws))
  ws.close(1000)
}

// (M2, a busy lane) opened paused, then played; the RESUME waits 9 s in the NVR's lane (the camera wall
// resumes every tile at once): nothing counts as playing, for the switch or for "end", until the NVR has
// taken it
{
  const nvr = fakeNvr('pb-resume', [true, 91], { job: 4, ms: 9000 })
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-resume'), { main: false, allowMain: () => true })
  ws.command({ pause: true })
  await until(() => ws.sent.some((m) => m.type === 'started'), 3000)
  await sleep(1000)
  ws.command({ pause: false })
  await sleep(10_000)
  check('M2, the RESUME held 9 s in the lane: 1 s after the NVR took it, nothing decided (no "stream", no "end")', types(ws) === 'started' && nvr.doneAt[4] > 0, types(ws))
  await until(() => ws.sent.some((m) => m.type === 'stream'), 5000)
  const after = Date.now() - nvr.doneAt[4]
  check('... then over to main, 4 s after the NVR took the RESUME, and no "end" before', ws.sent.some((m) => m.type === 'stream') && !ws.sent.some((m) => m.type === 'end') && after >= 3500, `${types(ws)}; ${after} ms after the RESUME`)
  ws.close(1000)
}

// a camera the NVR is known to record in HD only
{
  const nvr = fakeNvr('pb-known', [true, 81])
  nvr.playback.markHdOnly(0)
  const ok = fakeWs()
  const r = nvr.playback.connect(ok, url('pb-known'), { main: false, allowMain: () => true })
  check('known HD-only, a viewer who may see main: main at once, and said ({type:"stream"})', r?.main === true && ok.sent[0]?.type === 'stream')
  ok.close(1000)
  const bad = fakeWs()
  check('connect without a decision (no main flag) is refused "bad parameters"', nvr.playback.connect(bad, url('pb-known')) === null && bad.closedWith?.reason === 'bad parameters')
}
{
  const nvr = fakeNvr('pb-known-sd', [true, 83])
  nvr.playback.markHdOnly(0)
  const ws = fakeWs()
  const r = nvr.playback.connect(ws, url('pb-known-sd'), { main: false, allowMain: () => false })
  check('known HD-only, no right to see main: tried in SD all the same (a mark can be wrong; an SD frame clears it)', r?.main === false && ws.closedWith === null && !ws.sent.some((m) => m.type === 'stream'), types(ws))
  await until(() => ws.closedWith !== null, 12_000)
  check('... no SD frame in 6 s of playing: refused with words, 1008 "hd not allowed"; the mark stays', ws.closedWith?.reason === 'hd not allowed' && ws.sent.at(-1)?.type === 'error' && nvr.playback.isHdOnly(0), `${JSON.stringify(ws.closedWith)} ${types(ws)}`)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
