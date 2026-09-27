// Tests for the cool-down after late SDK calls (sdk.mjs nvrCooling) in live view: while an NVR's
// call is stuck in the SDK or just came back late, no new LivePlay goes to that NVR (first starts,
// restarts, main and sub streams) and its stalled streams are left alone; other NVRs carry on,
// and everything starts again once it has cooled down. The recorder's streams (starts, restarts
// and stall restarts) are held only while a call of the NVR is still stuck. The connect lane (main
// streams, logins) waits while ANY NVR has a call stuck.
// Uses real Nvr and LiveStream objects over fake SDK functions and made-up hosts: nothing here
// reaches an NVR.
// Run inside the container:  node cctv/test/cooling.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cool-'))
process.env.SDK_COOL_MS = '2500' // a short cool-down (sdk.mjs reads it at load)
process.env.UV_THREADPOOL_SIZE = '64' // as in the container (sdk.mjs sizes its native-call cap from it)
const COOL_MS = 2500
const { NET_SDK, sdkCallT } = await import('../sdk.mjs')
const { Nvr } = await import('../nvrs.mjs')

const print = console.log.bind(console)
const out = [] // what the app logged (printed only if something fails)
console.log = (...a) => out.push(a.join(' '))
console.warn = (...a) => out.push(a.join(' '))

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  print(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const until = async (cond, maxMs) => {
  for (const end = Date.now() + maxMs; Date.now() < end; await sleep(50)) if (cond()) return true
  return cond()
}

// ---- fake SDK: every NET_SDK function is replaced, so none of these calls can reach the real one
const USER_IDS = { 'nvr-a.invalid': 11, 'nvr-b.invalid': 22 }
const NVR_OF = { 11: 'a', 22: 'b' }
const handles = new Map() // handle -> { nvr, ch, stream }
let nextHandle = 100
const log = [] // { fn, nvr, ch, stream, at }
const answers = {
  Login: (host) => USER_IDS[host] ?? -1,
  GetLastError: () => 0,
  LivePlay: (userId, info) => {
    const h = nextHandle++
    handles.set(h, { nvr: NVR_OF[userId], ch: info.lChannel, stream: info.streamType })
    log.push({ fn: 'LivePlay', ...handles.get(h), at: Date.now() })
    return h
  },
  StopLivePlay: (h) => {
    log.push({ fn: 'StopLivePlay', ...handles.get(h), at: Date.now() })
    return true
  }
}
for (const name of Object.keys(NET_SDK)) {
  const answer = answers[name] ?? (() => true)
  NET_SDK[name] = {
    fake: true,
    async(...args) {
      const cb = args.at(-1)
      setTimeout(() => cb(null, answer(...args.slice(0, -1))), 5)
    }
  }
}
if (!Object.values(NET_SDK).every((f) => f.fake)) throw new Error('the SDK is not fully faked: not running')

const calls = (fn, nvr, ch, stream) => log.filter((c) => c.fn === fn && c.nvr === nvr && (ch === undefined || c.ch === ch) && (stream === undefined || c.stream === stream))
/** A call to nvr that returns natively after afterMs, long past its 50 ms time limit. */
const slowCall = (nvr, afterMs) =>
  sdkCallT({ nvr, tag: `${nvr} slow call`, timeoutMs: 50 }, { async: (...a) => setTimeout(() => a.at(-1)(null, 1), afterMs) }).catch(() => {})
/** Makes nvr cool down: one of its calls comes back late. Resolves once it has; returns that time. */
const lateReturn = async (nvr) => {
  slowCall(nvr, 150)
  await sleep(170)
  return Date.now() - 20
}
const cfg = (id) => ({ id, site: 'Lab', name: `NVR ${id}`, host: `nvr-${id}.invalid`, port: 1, user: 'test', password: 'test' })

const A = new Nvr(cfg('a'))
const B = new Nvr(cfg('b'))
check('fake NVRs log in', await until(() => A.online && B.online, 5000), `${A.status} ${B.status}`)

// ---- first starts
const cooledFrom = await lateReturn('a')
const aSub = A.getStream(0, 1)
const aMain = A.getStream(1, 0)
const bSub = B.getStream(0, 1)
const bMain = B.getStream(1, 0)
await sleep(400)
check('first starts on a healthy NVR go ahead (sub and main)', calls('LivePlay', 'b').length === 2 && bSub.state === 'playing' && bMain.state === 'playing', `${calls('LivePlay', 'b').length} LivePlay`)
check('first starts on the cooling NVR do not enter the SDK (sub and main)', calls('LivePlay', 'a').length === 0, `${calls('LivePlay', 'a').length} LivePlay`)
check(
  'a held start is not a failure: no back-off, not counted, not logged as failed',
  aSub.restarts === 0 && aMain.restarts === 0 && A.health.liveFailures === 0 && !out.some((l) => l.includes('a/1:sub failed') || l.includes('a/2:main failed')),
  `restarts ${aSub.restarts}/${aMain.restarts}, liveFailures ${A.health.liveFailures}`
)
check('the log says the NVR is cooling, once', out.filter((l) => l.startsWith('[a]') && l.includes('came back') && l.includes('holding new streams')).length === 1, out.filter((l) => l.includes('came back')).join(' | '))
const startedAgain = await until(() => calls('LivePlay', 'a').length === 2, 8000)
const firstA = calls('LivePlay', 'a')[0]
check('the held streams start once the NVR has cooled down', startedAgain && aSub.state === 'playing' && aMain.state === 'playing' && firstA.at - cooledFrom >= COOL_MS, `${calls('LivePlay', 'a').length} LivePlay, first ${firstA ? firstA.at - cooledFrom : '-'} ms after the late return`)

// ---- the connect lane (main streams, logins) waits while ANY NVR has a call stuck in the SDK
slowCall('a', 900)
await sleep(150) // late now, still inside the SDK
const bMain2 = B.getStream(2, 0)
const bSub2 = B.getStream(3, 1)
await sleep(350)
check('while a call to A is stuck: a sub stream on B still starts (its own lane)', calls('LivePlay', 'b', 3, 1).length === 1 && bSub2.state === 'playing')
check('... a main stream on B waits (the SDK would queue its new connection behind the stuck call)', calls('LivePlay', 'b', 2, 0).length === 0)
check('... and starts once that call has returned', await until(() => calls('LivePlay', 'b', 2, 0).length === 1, 2000) && bMain2.state === 'playing')

// ---- stall restarts
await sleep(COOL_MS + 200) // A cools down again from that late return
const aCool = await lateReturn('a')
// the fake streams deliver no video: all "just had a frame" except the two made to stall (none for
// 1 s longer than the stall limit)
const { STALL_MS } = await import('../live.mjs')
for (const s of [...A.streams.values(), ...B.streams.values()]) s.lastFrameAt = Date.now()
aSub.lastFrameAt = Date.now() - STALL_MS - 1000
bSub.lastFrameAt = Date.now() - STALL_MS - 1000
const stopsA = calls('StopLivePlay', 'a').length
await A.checkStalled()
await A.checkStalled()
await B.checkStalled()
check('the stall check leaves the cooling NVR’s stalled stream alone', calls('StopLivePlay', 'a').length === stopsA && aSub.state === 'playing')
check('... says so once for the episode', out.filter((l) => l.startsWith('[a]') && l.includes('stalled') && l.includes('cooled down')).length === 1, out.filter((l) => l.startsWith('[a]')).join(' | '))
check('... and restarts the healthy NVR’s', calls('StopLivePlay', 'b', 0, 1).length === 1 && bSub.state === 'restarting')
await sleep(aCool + COOL_MS + 100 - Date.now())
await A.checkStalled()
const restartedAt = Date.now()
check('once cooled down, the stall check restarts it', calls('StopLivePlay', 'a', 0, 1).length === 1 && aSub.state === 'restarting' && aSub.restarts === 1, `${aSub.state}, restarts ${aSub.restarts}`)

// ---- a restart that falls due while the NVR is cooling waits, without escalating the back-off
// (the restart's back-off is 5 s; A starts cooling again 3.5 s into it)
const livePlaysA = calls('LivePlay', 'a', 0, 1).length
await sleep(3500 - (Date.now() - restartedAt))
await lateReturn('a')
await sleep(restartedAt + 5600 - Date.now()) // the back-off has run out
check('a restart due while the NVR cools does not enter the SDK', calls('LivePlay', 'a', 0, 1).length === livePlaysA && aSub.state === 'restarting', `${aSub.state}`)
check('... and does not escalate the back-off', aSub.restarts === 1, `restarts ${aSub.restarts}`)
check('the healthy NVR’s restart went ahead meanwhile', calls('LivePlay', 'b', 0, 1).length === 2 && bSub.state === 'playing')
check('... the held restart runs once the NVR has cooled down', (await until(() => calls('LivePlay', 'a', 0, 1).length === livePlaysA + 1, 7000)) && aSub.state === 'playing', `${aSub.state}`)

// ---- the recorder's streams: a cool-down holds them only while a call of that NVR is still late
// (a viewer's LivePlay that came back late held every recording restart on its NVR for a minute)
await sleep(COOL_MS + 200)
const tap = (recorder) => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, send() {}, close() {}, ...(recorder ? { recorder: true, background: true } : {}) })
const plays = (ch) => calls('LivePlay', 'a', ch, 1).length
{
  await lateReturn('a') // A cools down; nothing of A is inside the SDK any more
  const rec = A.getStream(20, 1)
  rec.add(tap(true))
  const view = A.getStream(21, 1)
  view.add(tap(false))
  await sleep(300)
  check('cooling, nothing still late: the recorder’s start goes ahead', plays(20) === 1 && rec.state === 'playing', `${plays(20)} LivePlay, ${rec.state}`)
  check('... while a viewer’s start waits', plays(21) === 0 && view.state === 'restarting', `${plays(21)} LivePlay, ${view.state}`)
  slowCall('a', 900) // late, still inside the SDK
  await sleep(150)
  const rec2 = A.getStream(22, 1)
  rec2.add(tap(true))
  await sleep(300)
  check('a call of A still late: the recorder’s start waits too', plays(22) === 0, `${plays(22)} LivePlay`)
  check('... and goes once that call is back', await until(() => plays(22) === 1, 7000))
}
{
  await sleep(COOL_MS + 200)
  const recR = A.getStream(23, 1)
  recR.add(tap(true))
  const viewR = A.getStream(24, 1)
  viewR.add(tap(false))
  await until(() => recR.state === 'playing' && viewR.state === 'playing', 3000)
  const [r0, v0] = [plays(23), plays(24)]
  const t0 = Date.now()
  recR.restart('test') // both back off 5 s
  viewR.restart('test')
  await sleep(3500 - (Date.now() - t0))
  await lateReturn('a') // A cools again 3.5 s into the back-off; nothing still late
  await sleep(t0 + 5600 - Date.now())
  check('a restart due while the NVR cools: the recorder’s goes ahead', plays(23) === r0 + 1 && recR.state === 'playing', `${plays(23) - r0} LivePlay, ${recR.state}`)
  check('... a viewer’s waits', plays(24) === v0 && viewR.state === 'restarting', `${plays(24) - v0} LivePlay, ${viewR.state}`)
}
{
  // a stream that stalls during a cool-down: the stall check restarts the recorder's once nothing of
  // the NVR is still late (a viewer's LivePlay back late held it for the whole minute); a viewer's
  // stalled stream waits for the end of the cool-down, as before
  await sleep(COOL_MS + 200)
  const recS = A.getStream(25, 1)
  recS.add(tap(true))
  const viewS = A.getStream(26, 1)
  viewS.add(tap(false))
  await until(() => recS.state === 'playing' && viewS.state === 'playing', 3000)
  const stops = (ch) => calls('StopLivePlay', 'a', ch, 1).length
  const lateAt = Date.now()
  slowCall('a', 900) // late after 50 ms, back at 900
  await sleep(150)
  for (const s of A.streams.values()) s.lastFrameAt = Date.now()
  recS.lastFrameAt = Date.now() - STALL_MS - 1000
  viewS.lastFrameAt = Date.now() - STALL_MS - 1000
  await A.checkStalled()
  check('stall in a cool-down, a call of A still late: the recorder’s stalled stream is left alone too', stops(25) === 0 && recS.state === 'playing', `${stops(25)} stops, ${recS.state}`)
  await sleep(lateAt + 1000 - Date.now()) // that call is back: A cools, nothing of it still late
  await A.checkStalled()
  check('... nothing still late: the stall check restarts the recorder’s', stops(25) === 1 && recS.state === 'restarting', `${stops(25)} stops, ${recS.state}`)
  check('... and leaves the viewer’s alone', stops(26) === 0 && viewS.state === 'playing', `${stops(26)} stops, ${viewS.state}`)
  await sleep(lateAt + 900 + COOL_MS + 150 - Date.now())
  await A.checkStalled()
  check('... which is restarted once the NVR has cooled down', stops(26) === 1 && viewS.state === 'restarting', `${stops(26)} stops, ${viewS.state}`)
}

if (failures) print(`\napp log:\n${out.join('\n')}`)
print(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
