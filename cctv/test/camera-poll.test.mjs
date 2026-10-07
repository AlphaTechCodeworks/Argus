// The camera list (GetDeviceIPCInfo) is polled once per NVR: with a live worker the worker polls
// and sends the list in its STATS; the main process skips its own poll while the worker's list is
// fresh (a slow keepalive poll only) and polls again while the worker restarts. Polls are spread
// with +-20% jitter. Fake SDK (test/fake-sdk.mjs), *.invalid hosts: nothing reaches an NVR.
// Run:  node cctv/test/camera-poll.test.mjs
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'poll-'))
process.env.CCTV_WORKER_FAKE_SDK = '1'
process.env.CCTV_TEST_REFRESH_MS = '200'
await import('./fake-sdk.mjs')
const { Nvr, allCameras, jittered, nvrs } = await import('../nvrs.mjs')

const print = console.log.bind(console)
console.log = () => {}
console.warn = () => {}
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  print(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const until = async (cond, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (cond()) return true
  return cond()
}

// jitter
check('jitter: -20%', jittered(30_000, () => 0) === 24_000)
check('jitter: +20%', jittered(30_000, () => 1) === 36_000)
check('jitter: middle', jittered(30_000, () => 0.5) === 30_000)

const polls = () => globalThis.__fakeSdk.calls('GetDeviceIPCInfo').length
const nvr = new Nvr({ id: 'p1', site: 'T', name: 'P1', host: 'p1.invalid', port: 6036, user: 'u', password: 'p' })
check('logs in', await until(() => nvr.online, 5000))
const afterLogin = polls()
check('without a worker: main polls by itself', await until(() => polls() >= afterLogin + 2, 3000), `${polls() - afterLogin}`)

// now a (fake) live worker that sends its list every "5 s"
let state = 'ready'
let stats = null
nvr.worker = { state: () => state, stats: () => stats, hub: { getStream() {}, restartStream() {} }, stop: async () => {} }
const sendStats = () => {
  stats = { t: 'stats', status: 'online', channels: [{ ch: 0, name: 'Door', online: true }, { ch: 3, name: 'Yard', online: false }] }
  nvr.workerStats(stats)
}
sendStats()
check('worker STATS: main takes the worker camera list', nvr.channels.length === 2 && nvr.channels[1].name === 'Yard' && nvr.channels[1].online === false, JSON.stringify(nvr.channels))
const t = setInterval(sendStats, 100)
await sleep(100)
const base = polls()
await sleep(1200)
check('worker ready with a fresh list: main does not poll', polls() === base, `${polls() - base} polls`)
check('liveOnline follows the worker', nvr.liveOnline === true)
// The control login is refused while the worker's video login is up (shad, 2026-10-06: a P2P NVR at
// its session limit). Health counts that NVR as online, so its cameras must be judged the same way,
// or every one of them reads offline under an NVR the same page calls online. No await in between:
// the status is put back before anything else can look at it.
{
  nvrs.set(nvr.id, nvr)
  const was = nvr.status
  nvr.status = 'offline'
  const cam = (list, ch) => list.find((c) => c.nvr === nvr.id && c.ch === ch)?.online
  check('control login down, video up: events still follow the control login', cam(allCameras(), 0) === false)
  check('control login down, video up: health sees the camera online', cam(allCameras({ anyLogin: true }), 0) === true)
  check('control login down, video up: a camera the NVR calls offline stays offline', cam(allCameras({ anyLogin: true }), 3) === false)
  nvr.status = was
  check('both logins up: health sees the camera online', cam(allCameras({ anyLogin: true }), 0) === true)
  nvrs.delete(nvr.id)
}

// Borrowing: the NVR refuses the control login while the worker is logged in, so XML commands go
// out on the worker's login (nvr-xml.mjs). No await in this block: the STATS timer above rewrites
// `stats` every 100 ms, and everything is put back before anything else can look.
{
  const was = { status: nvr.status, failed: nvr.controlFailed, stats, spawnedAt: nvr.worker.spawnedAt }
  nvr.worker.spawnedAt = () => 111
  stats = { ...stats, status: 'online', gen: 4, sdk: { late: 0 } }
  check('borrowing: not while the control login is up', nvr.borrowing === false && nvr.xmlOnline === true && nvr.xmlGen === `own:${nvr.gen}`, nvr.xmlGen)
  nvr.status = 'offline'
  nvr.controlFailed = false
  check('borrowing: not before the control login has failed once (a normal start)', nvr.borrowing === false && nvr.xmlOnline === false)
  nvr.controlFailed = true
  check('borrowing: control login refused, worker logged in', nvr.borrowing === true && nvr.xmlOnline === true)
  check("borrowing: the session is the worker's", nvr.xmlGen === 'worker:111:4', nvr.xmlGen)
  check('borrowing: not degraded just because the control login is down', nvr.degraded === true && nvr.xmlDegraded === false)
  stats = { ...stats, sdk: { late: 1 } }
  check("borrowing: degraded while the worker's SDK calls are late", nvr.xmlDegraded === true)
  stats = { ...stats, sdk: { late: 0 }, gen: 5 }
  check('borrowing: a worker relogin is a new session', nvr.xmlGen === 'worker:111:5', nvr.xmlGen)
  process.env.CCTV_XML_VIA_WORKER = 'off'
  check('borrowing: switched off', nvr.borrowing === false && nvr.xmlOnline === false && nvr.xmlGen === `own:${nvr.gen}`)
  delete process.env.CCTV_XML_VIA_WORKER
  stats = { ...stats, status: 'offline' }
  check('borrowing: not while the worker is logged out', nvr.borrowing === false)
  stats = { ...stats, status: 'online', gen: undefined }
  check('borrowing: not from a worker too old to report its session', nvr.borrowing === false)
  nvr.status = was.status
  nvr.controlFailed = was.failed
  stats = was.stats
  nvr.worker.spawnedAt = was.spawnedAt
}
// The control login has died under a polling worker. Its keepalive read comes once in 5 minutes, and
// a read not answered used to count as that turn's keepalive: the 4 failures a relogin takes were 15
// to 20 minutes apart in all. One not answered is asked again at the next turn.
{
  const { NET_SDK } = await import('../sdk.mjs')
  const real = NET_SDK.GetDeviceIPCInfo.async
  let dead = true
  NET_SDK.GetDeviceIPCInfo.async = (...args) => real(...args.slice(0, -1), (err, ok) => args.at(-1)(err, dead ? false : ok))
  const logins = () => globalThis.__fakeSdk.calls('Login').length
  const from = { polls: polls(), logins: logins() }
  nvr.lastOwnPoll = 0 // the keepalive is due (5 minutes since the last read)
  check('keepalive not answered: asked again at the next turns, not 5 minutes later', await until(() => polls() >= from.polls + 3, 3000), `${polls() - from.polls} reads`)
  check('keepalive not answered 4 times: the control login is made again', await until(() => logins() > from.logins, 5000), `${polls() - from.polls} reads, ${logins() - from.logins} logins`)
  dead = false
  check('... and is online again', await until(() => nvr.online && nvr.lastOwnPoll > 0, 8000), nvr.status)
  const quiet = polls()
  await sleep(1200)
  check('answered again: back to the slow keepalive', polls() === quiet, `${polls() - quiet} reads`)
  NET_SDK.GetDeviceIPCInfo.async = real
}
stats = { ...stats, status: 'offline' }
nvr.workerStats(stats)
check('liveOnline: worker says offline', nvr.liveOnline === false)
// the worker restarts: main polls again (fallback)
clearInterval(t)
state = 'restarting'
stats = null
const b2 = polls()
check('worker restarting: main polls again', await until(() => polls() >= b2 + 2, 3000), `${polls() - b2}`)
check('worker restarting: liveOnline falls back to the main login', nvr.liveOnline === nvr.online)
clearInterval(t)
nvr.worker = null
await nvr.stop()
// a control login that fails is remembered (127.0.0.1:1 refuses the connection: nothing reaches an NVR)
{
  const down = new Nvr({ id: 'p2', site: 'T', name: 'P2', host: '127.0.0.1', port: 1, user: 'u', password: 'p' })
  check('a new NVR has not failed yet', down.controlFailed === false)
  check('a failed control login is remembered', await until(() => down.controlFailed === true, 10_000))
  await down.stop()
}

// wiring
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
check('alerts and Health read cameras by either login', /listCameras: \(\) =>\s+allCameras\(\{ anyLogin: true \}\)/.test(src('server.mjs')))
// (the definition, not the first call of it, which comes earlier in the file)
check('worker STATS carry the camera list', /channels: nvr\.channels/.test(src('nvr-worker.mjs').split('const sendStats')[1] ?? ''))
// (the /live attach steps are in live-attach.mjs since /live-mux shares them)
check('server /live uses liveOnline', /!nvr\.liveOnline/.test(src('live-attach.mjs')) && /liveAttacher\(/.test(src('server.mjs')))

print(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
