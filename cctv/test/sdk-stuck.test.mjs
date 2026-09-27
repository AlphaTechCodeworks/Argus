// While the SDK is stuck (sdk.mjs sdkStuck: a call past its time limit with nothing back since it
// started), the main process refuses new SDK work at once instead of queuing it behind the stuck
// call, where it only filled the SDK queue and the thread pool and read to the watchdog as more
// evidence of a hang: NVRs read as degraded, the camera-list refresh is skipped, /api/playback/now
// and /dates answer 503 with Retry-After, and XML calls are refused before they queue. As soon as
// any native call returns, everything works again. Also recordingActive(), which the watchdog asks
// before it kills this process.
// Fake SDK (test/fake-sdk.mjs) and fake bindings, *.invalid hosts: nothing reaches an NVR.
// Needs the Linux SDK library (sdk.mjs loads it through koffi):  node cctv/test/sdk-stuck.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'stuck-'))
process.env.UV_THREADPOOL_SIZE = '64' // as in the container (sdk.mjs sizes its native-call cap from it)
process.env.SDK_COOL_MS = '300' // the stuck call's NVR cools briefly once it is back
process.env.CCTV_WORKER_FAKE_SDK = '1' // (only so that CCTV_TEST_REFRESH_MS applies)
process.env.CCTV_TEST_REFRESH_MS = '200'
await import('./fake-sdk.mjs')
const { sdkCallT, sdkStats, sdkStuck } = await import('../sdk.mjs')
const { Nvr, nvrs, recordingActive } = await import('../nvrs.mjs')
const pb = await import('../playback.mjs')
const xmlMod = await import('../nvr-xml.mjs')

const print = console.log.bind(console)
const out = []
console.log = (...a) => out.push(a.join(' '))
console.warn = (...a) => out.push(a.join(' '))
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  print(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const until = async (cond, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (cond()) return true
  return cond()
}

// ---- the NVRs: a real Nvr over the fake SDK (degraded, refresh, XML), and two plain fakes for
// the playback routes (as in playback-busy.test.mjs; their lanes never run a real SDK call)
const nvr = new Nvr({ id: 's1', site: 'T', name: 'S1', host: 's1.invalid', port: 6036, user: 'u', password: 'p' })
check('the fake NVR logs in', await until(() => nvr.online, 5000))
const fake = (id, lane) => {
  const n = { id, name: `NVR ${id}`, userId: 7, online: true, degraded: false, loggedInAt: 0, jobs: 0 }
  n.lane = { run: (task) => (n.jobs++, lane(task)) }
  n.playback = pb.createPlayback(n)
  return n
}
const answering = fake('pb-now', () => Promise.resolve(true)) // answers GetDeviceTime without running it
const running = fake('pb-dates', (task) => Promise.resolve().then(task))
let findCalls = 0
pb._test.setDateCalls({
  FindRecDate: { async: (...a) => (findCalls++, setTimeout(() => a.at(-1)(null, 55), 5)) },
  FindNextRecDate: { async: (...a) => setTimeout(() => a.at(-1)(null, 0), 5) }, // no days
  FindRecDateClose: { async: (...a) => setTimeout(() => a.at(-1)(null, true), 5) }
})
let xmlCalls = 0
xmlMod._test.setCall(async (_opts, _userId, _xml, _url, outBuf, _size, len) => {
  xmlCalls++
  const b = Buffer.from('<?xml version="1.0"?><response><status>success</status></response>')
  b.copy(outBuf)
  len.writeUInt32LE(b.length)
  return true
})

const polls = () => globalThis.__fakeSdk.calls('GetDeviceIPCInfo').length
check('before: the refresh polls the camera list', await until(() => polls() >= 2, 3000))
check('before: not stuck, the NVR is not degraded', sdkStuck() === false && nvr.degraded === false)

// ---- a call that never comes back (until told to), started right after a refresh returned, so
// nothing else returns in between (any return at all means the SDK is not stuck)
const seen = polls()
await until(() => polls() > seen, 2000)
await until(() => sdkStats().inFlight === 0, 500)
let finish = () => {}
const stuckCall = sdkCallT({ nvr: 'wedged', tag: 'FindRecDate (fake)', timeoutMs: 60 }, { async: (...a) => (finish = () => a.at(-1)(null, 0)) }).catch(() => {})
await sleep(90)
check('sdkStuck: true once the call is past its limit with nothing back since', sdkStuck() === true)
check('every NVR reads as degraded, not only the stuck call’s', nvr.degraded === true)
{
  const before = polls()
  await sleep(700)
  check('the camera-list refresh is skipped meanwhile', polls() === before, `${polls() - before} polls`)
}
{
  const t0 = Date.now()
  const now = await pb.playbackApi(answering, '/api/playback/now', new URLSearchParams())
  const dates = await pb.playbackApi(running, '/api/playback/dates', new URLSearchParams())
  const took = Date.now() - t0
  check('/api/playback/now and /dates answer 503 at once', now[0] === 503 && dates[0] === 503 && took < 50, `${now[0]} ${dates[0]} in ${took} ms`)
  check('... with Retry-After', now[2]?.['retry-after'] === String(now[1].retryAfterS) && dates[1].retryAfterS > 0, JSON.stringify(now))
  check('... without queuing anything (no lane job, no date search)', answering.jobs === 0 && running.jobs === 0 && findCalls === 0, `${answering.jobs}/${running.jobs} jobs, ${findCalls} searches`)
  const real = await pb.playbackApi(nvr, '/api/playback/now', new URLSearchParams())
  check('... also on the real Nvr', real[0] === 503, JSON.stringify(real))
}
{
  const e = await xmlMod.transparent(nvr, 'queryChlVideoParam', '<x/>', 'survey').catch((err) => err)
  check('an XML call is refused before it queues, the binding never called', e instanceof xmlMod.HttpError && e.status === 503 && e.extra?.retryAfterS > 0 && xmlCalls === 0, `${e?.status} ${e?.message}; ${xmlCalls} calls`)
  const w = await xmlMod.transparent(nvr, 'editChlVideoParam', '<x/>', 'change').catch((err) => err)
  check('... a change too', w instanceof xmlMod.HttpError && w.status === 503 && xmlCalls === 0)
  const [status, body] = xmlMod.errorAnswer(e)
  check('errorAnswer gives 503 with retryAfterS', status === 503 && body.retryAfterS > 0, JSON.stringify(body))
}

// ---- the call comes back: everything works again
finish()
await stuckCall
await sleep(10)
check('once it returned: not stuck, not degraded', sdkStuck() === false && nvr.degraded === false)
{
  const now = await pb.playbackApi(answering, '/api/playback/now', new URLSearchParams())
  check('/api/playback/now answers again', now[0] === 200 && answering.jobs === 1, `${now[0]}`)
  const dates = await pb.playbackApi(running, '/api/playback/dates', new URLSearchParams())
  check('/api/playback/dates answers again (one search)', dates[0] === 200 && Array.isArray(dates[1]) && findCalls === 1, `${dates[0]} ${JSON.stringify(dates[1])}, ${findCalls} searches`)
  const x = await xmlMod.transparent(nvr, 'queryChlVideoParam', '<x/>', 'survey').catch((err) => err)
  check('XML calls go through again', typeof x === 'string' && /success/.test(x) && xmlCalls === 1, String(x?.message ?? x).slice(0, 80))
  const before = polls()
  check('the refresh polls again', await until(() => polls() > before, 2000))
}

// ---- what the watchdog asks before killing this process (nvrs.mjs recordingActive)
{
  const at = Date.now()
  const worker = (rec) => ({ worker: { stats: () => (rec ? { rec } : null) } })
  nvrs.set('ra1', worker({ 0: { lastFrameAt: at - 2000 }, 1: { lastFrameAt: at - 30_000 }, 2: { lastFrameAt: null } }))
  nvrs.set('ra2', worker({ 4: { lastFrameAt: at - 9000 }, 5: { lastFrameAt: at - 100 } }))
  nvrs.set('ra3', worker(null)) // restarting: no stats
  nvrs.set('ra4', {}) // no worker
  check('recordingActive: cameras with a frame in the last 10 s, and their NVRs', recordingActive(at) === '3 cameras on 2 NVRs', recordingActive(at))
  check('recordingActive: \'\' once none has had a frame for 10 s (a worker that stops sending stats ages out)', recordingActive(at + 12_000) === '', recordingActive(at + 12_000))
  for (const id of ['ra1', 'ra2', 'ra3', 'ra4']) nvrs.delete(id)
  check('recordingActive: \'\' with no workers', recordingActive() === '')
}

await nvr.stop()
if (failures) print(`\napp log:\n${out.join('\n')}`)
print(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
