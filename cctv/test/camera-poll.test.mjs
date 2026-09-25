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
const { Nvr, jittered } = await import('../nvrs.mjs')

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

// wiring
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
check('worker STATS carry the camera list', /channels: nvr\.channels/.test(src('nvr-worker.mjs').split('sendStats')[1] ?? ''))
check('server /live uses liveOnline', /!nvr\.liveOnline/.test(src('server.mjs')))

print(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
