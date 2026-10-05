// Tests for recorded playback while an NVR is busy (recovering, or its SDK calls are stuck or just
// came back late, sdk.mjs nvrCooling): the timeline requests (/api/playback/now, /dates,
// /recordings) and new playbacks answer at once with "busy" and retryAfterS instead of queuing more
// SDK work; other NVRs and playbacks already running carry on. GetDeviceTime is ordinary work
// (NORMAL priority), not a stop (HIGH).
// The NVRs are fakes whose lane records each job's priority and answers it without running it, so
// no playback SDK call runs and nothing reaches an NVR.
// Run inside the container:  node cctv/test/playback-busy.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'pb-busy-'))
process.env.SDK_COOL_MS = '1500' // a short cool-down (sdk.mjs reads it at load)
const COOL_MS = 1500
const { sdkCallT } = await import('../sdk.mjs')
const { PRIORITY } = await import('../lanes.mjs')
const pb = await import('../playback.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const BUSY = 'The NVR is busy; try again in a moment'

/** A fake NVR. Its lane answers each job from `answers` (default true) without running it. */
const fakeNvr = (id, answers = []) => {
  const nvr = {
    id,
    name: `NVR ${id}`,
    userId: 7,
    online: true,
    degraded: false,
    jobs: [], // priority of every lane job
    logins: 0,
    lane: {
      run: (_task, { priority = PRIORITY.NORMAL } = {}) => {
        nvr.jobs.push(priority)
        return Promise.resolve(answers.length ? answers.shift() : true)
      }
    },
    sessions: {
      acquire: async () => {
        nvr.logins++
        return { userId: 9, release() {} }
      }
    }
  }
  nvr.playback = pb.createPlayback(nvr)
  return nvr
}
/** Makes the NVR cool down: one of its calls comes back late. */
const lateReturn = async (id) => {
  sdkCallT({ nvr: id, timeoutMs: 50 }, { async: (...a) => setTimeout(() => a.at(-1)(null, 1), 150) }).catch(() => {})
  await sleep(170)
}
const api = pb.playbackApi ?? (async () => [0, { error: 'no playbackApi in playback.mjs' }])
const get = (nvr, path, query = '') => api(nvr, `/api/playback/${path}`, new URLSearchParams(query))
/** A fake browser WebSocket for /playback. */
const fakeWs = () => {
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, sent: [], closedWith: 0, handlers: {} }
  ws.send = (m) => typeof m === 'string' && ws.sent.push(JSON.parse(m))
  ws.on = (event, fn) => (ws.handlers[event] = fn)
  ws.close = (code) => {
    if (ws.readyState !== 1) return
    ws.readyState = 3
    ws.closedWith = code
    ws.handlers.close?.()
  }
  ws.command = (obj) => ws.handlers.message(Buffer.from(JSON.stringify(obj)), false)
  return ws
}
const openPlayback = (nvr, ws) => nvr.playback.connect(ws, new URL(`ws://x/playback?nvr=${nvr.id}&ch=0&stream=0&start=${Date.now() - 3_600_000}`), { main: true, allowMain: () => true })

// ---- GetDeviceTime is ordinary work
{
  const a = fakeNvr('pb-prio')
  await a.playback.clock()
  check('GetDeviceTime (the NVR clock) runs at NORMAL priority; HIGH is for stops', a.jobs.join() === String(PRIORITY.NORMAL), a.jobs.join())
}

// ---- the routes, healthy and busy
const a = fakeNvr('pb-a')
const b = fakeNvr('pb-b')
{
  const [status] = await get(a, 'now')
  check('healthy NVR: /now answers', status === 200 && a.jobs.length === 1, `${status}, ${a.jobs.length} jobs`)
  a.jobs.length = 0
}
await lateReturn('pb-a')
{
  const t0 = Date.now()
  const answers = [await get(a, 'now'), await get(a, 'dates'), await get(a, 'recordings', 'ch=0&date=2026-09-24')]
  const took = Date.now() - t0
  check('cooling NVR: /now, /dates and /recordings answer 503 at once', answers.every(([s]) => s === 503) && took < 100, `${answers.map(([s]) => s).join()} in ${took} ms`)
  check('... with the busy message and when to try again', answers.every(([, body]) => body.error === BUSY && body.retryAfterS >= 1 && body.retryAfterS <= Math.ceil(COOL_MS / 1000)), JSON.stringify(answers[0][1]))
  check('... also as a Retry-After header', answers[0][2]?.['retry-after'] === String(answers[0][1].retryAfterS), JSON.stringify(answers[0][2]))
  check('... without queuing any SDK work', a.jobs.length === 0, `${a.jobs.length} jobs`)
  const e = await a.playback.clock().catch((err) => err)
  check('clock() itself refuses (new playbacks and motion search use it)', e?.name === 'NvrBusy' && e.retryAfterS > 0, e?.message)
  const [sb] = await get(b, 'now')
  check('another NVR is not affected', sb === 200 && b.jobs.length === 1, `${sb}, ${b.jobs.length} jobs`)
}
{
  const c = fakeNvr('pb-c')
  c.degraded = true // relogging, probing, or calls stuck (nvrs.mjs)
  const [status, body] = await get(c, 'dates')
  check('a recovering (degraded) NVR answers 503 busy too', status === 503 && body.error === BUSY && body.retryAfterS > 0 && c.jobs.length === 0, `${status} ${JSON.stringify(body)}`)
}
{
  // a request that was already waiting for the lane when the NVR started cooling is refused when
  // its turn comes. (userId 'none': koffi would refuse it for a real SDK call, so nothing can run natively)
  const d = fakeNvr('pb-d')
  d.userId = 'none'
  const held = []
  d.lane.run = (task) => new Promise((resolve, reject) => held.push(() => Promise.resolve().then(task).then(resolve, reject)))
  const waiting = d.playback.clock()
  await lateReturn('pb-d')
  held.shift()()
  const e = await waiting.catch((err) => err)
  check('a request queued before the NVR started cooling is refused when its turn comes', e?.name === 'NvrBusy', `${e?.name}: ${e?.message}`)
}
{
  // unchanged answers of the routes
  check('unknown NVR: 404', (await api(undefined, '/api/playback/now', new URLSearchParams()))[0] === 404)
  const off = fakeNvr('pb-off')
  off.online = false
  const [s, body] = await get(off, 'now')
  check('offline NVR: 503 "offline" as before', s === 503 && body.error === 'NVR pb-off is offline' && body.retryAfterS === undefined, JSON.stringify(body))
  check('bad recordings query: 400', (await get(b, 'recordings', 'ch=x'))[0] === 400)
}

// ---- new playbacks and running ones
{
  const ws = fakeWs()
  openPlayback(a, ws)
  await sleep(50)
  check('a new playback on the cooling NVR fails at once with the busy message', ws.sent[0]?.type === 'error' && ws.sent[0].message === BUSY && ws.closedWith === 1011, JSON.stringify(ws.sent))
  check('... without a login or SDK work', a.logins === 0 && a.jobs.length === 0, `${a.logins} logins, ${a.jobs.length} jobs`)
}
{
  // a playback that is running when its NVR starts cooling carries on (and its controls still go)
  const e = fakeNvr('pb-e', [true, 77, true]) // clock, PlayBackByTimeEx (handle), SetPlayDataCallBack
  const ws = fakeWs()
  openPlayback(e, ws)
  await sleep(50)
  check('a playback on a healthy NVR opens', ws.sent.some((m) => m.type === 'started') && e.logins === 1, JSON.stringify(ws.sent))
  await lateReturn('pb-e')
  const jobs = e.jobs.length
  ws.command({ pause: true })
  await sleep(50)
  check('once that NVR cools, the running playback is left alone and its controls still go (HIGH)', ws.readyState === 1 && !ws.sent.some((m) => m.type === 'error') && e.jobs.length === jobs + 1 && e.jobs.at(-1) === PRIORITY.HIGH, `${JSON.stringify(ws.sent)} jobs ${e.jobs.join()}`)
  ws.close(1000)
}

{
  // A viewer who holds an arrow key over an NVR-only stretch opens and closes a playback per key
  // repeat. Each one waits for the NVR's clock first; one closed meanwhile must not go on to take a
  // login (2.4-3.9 s each on a remote NVR) only to hand it straight back.
  const f = fakeNvr('pb-f')
  const held = []
  f.lane.run = (_task, { priority = PRIORITY.NORMAL } = {}) => {
    f.jobs.push(priority)
    return new Promise((resolve) => held.push(() => resolve(true)))
  }
  const ws = fakeWs()
  openPlayback(f, ws)
  await sleep(20)
  check('a playback that is opening waits for the NVR clock first', held.length === 1 && f.logins === 0, `${held.length} held, ${f.logins} logins`)
  ws.close(1000) // the viewer moved on
  held.shift()()
  await sleep(50)
  check('closed while the clock was read: it never takes a login', f.logins === 0, `${f.logins} logins`)
  check('  nor asks the NVR for anything more', f.jobs.length === 1 && held.length === 0, `${f.jobs.length} jobs, ${held.length} held`)
}

// ---- after the cool-down
await sleep(COOL_MS + 100)
{
  a.jobs.length = 0
  const [status] = await get(a, 'now')
  check('the NVR answers again once it has cooled down', status === 200 && a.jobs.length === 1, `${status}`)
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
