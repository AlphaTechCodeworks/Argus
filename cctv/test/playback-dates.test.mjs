// Tests for the recording days (/api/playback/dates, NET_SDK_FindRecDate). On nvr1 that search has
// wedged the whole SDK, the watchdog restarted the service (stopping all recording), and the open
// Playback tab asked again 2 s after the restart. Now: a good answer is kept on disk and reused for
// an hour, also by a new instance; a search that runs past its time limit opens a breaker for that
// NVR for 2 hours (kept on disk too), during which the answer comes from the cache and the SDK is
// never called; a start-up whose last watchdog dump names that search for the NVR opens it too; and
// nothing is asked in the first 2 minutes after a login. With nothing cached, a held-back search
// answers an empty list, not 503: the page reads a 503 with retryAfterS on /dates as 'the NVR is
// busy' and then loads nothing else from that NVR until it clears (up to the breaker's 2 hours).
// Only a busy NVR (checkBusy, which refuses /now too) still answers 503 when nothing is cached.
// Fake bindings (playback.mjs _test.setDateCalls) on a fake NVR whose lane runs its jobs; a fake
// clock for the cache and the breaker. Nothing reaches an NVR.
// Needs the Linux SDK library (sdk.mjs loads it through koffi):  node cctv/test/playback-dates.test.mjs
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const DATA = mkdtempSync(join(tmpdir(), 'pb-dates-'))
process.env.DATA_DIR = DATA
process.env.UV_THREADPOOL_SIZE = '64' // as in the container (sdk.mjs sizes its native-call cap from it)
process.env.SDK_COOL_MS = '200' // a late search cools its NVR; keep that short (it counts in real time)
const COOL_MS = 200
const pb = await import('../playback.mjs')

const print = console.log.bind(console)
const out = []
console.warn = (...a) => out.push(a.join(' '))
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  print(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const M = 60_000
const H = 60 * M
let clock = Date.UTC(2026, 8, 27, 4, 0, 0)
const now = () => clock

// ---- fake date search: FindRecDate answers a handle, FindNextRecDate walks `days`; either can be
// made to hang (it then returns only when released, long after its 80 ms time limit)
let days = [[2026, 9, 25], [2026, 9, 26]]
let hang = '' // '' | 'find' | 'next'
const calls = { find: 0, next: 0, close: 0 }
const hung = [] // callbacks of hung calls
let walkPos = 0
pb._test.setDateCalls({
  timeoutMs: 80,
  FindRecDate: {
    async: (...a) => {
      calls.find++
      walkPos = 0
      if (hang === 'find') return void hung.push(() => a.at(-1)(null, 0))
      setTimeout(() => a.at(-1)(null, 55), 2)
    }
  },
  FindNextRecDate: {
    async: (...a) => {
      calls.next++
      if (hang === 'next') return void hung.push(() => a.at(-1)(null, 0))
      const d = days[walkPos++]
      if (d) Object.assign(a[1], { year: d[0], month: d[1], mday: d[2] })
      setTimeout(() => a.at(-1)(null, d ? 85 : 0), 2)
    }
  },
  FindRecDateClose: { async: (...a) => (calls.close++, setTimeout(() => a.at(-1)(null, true), 2)) }
})
const releaseHung = async () => {
  for (const f of hung.splice(0)) f()
  await sleep(COOL_MS + 50) // back (late), and its NVR done cooling
}

const fakeNvr = (id, over = {}) => {
  const n = { id, name: `NVR ${id}`, userId: 7, online: true, degraded: false, loggedInAt: clock - 10 * M, jobs: 0, ...over }
  n.lane = { run: (task) => (n.jobs++, Promise.resolve().then(task)) }
  n.playback = pb.createPlayback(n, { now })
  return n
}
const dates = (n) => pb.playbackApi(n, '/api/playback/dates', new URLSearchParams())
const saved = () => {
  try {
    return JSON.parse(readFileSync(join(DATA, 'rec-dates.json'), 'utf8'))
  } catch {
    return {}
  }
}
const searches = () => calls.find

// ---- a good answer is kept, on disk too, and reused for an hour
const d1 = fakeNvr('d1')
{
  const [s, body] = await dates(d1)
  check('first /dates asks the NVR once', s === 200 && JSON.stringify(body) === '["2026-09-25","2026-09-26"]' && searches() === 1, `${s} ${JSON.stringify(body)}`)
  check('... and saves the answer to rec-dates.json', saved().d1?.at === clock && saved().d1.dates.length === 2, JSON.stringify(saved()))
  clock += 50 * M
  const [s2, again] = await dates(d1)
  check('within the hour: answered from the cache, no search, no lane job', s2 === 200 && again.length === 2 && searches() === 1 && d1.jobs === 1, `${searches()} searches, ${d1.jobs} jobs`)
  const d1b = fakeNvr('d1')
  const [s3, fromFile] = await dates(d1b)
  check('a new instance (a restart) answers from the saved days without asking', s3 === 200 && fromFile.length === 2 && searches() === 1 && d1b.jobs === 0, `${searches()} searches`)
}

// ---- a search that runs past its time limit: breaker, written to disk; the cache answers
{
  clock += 20 * M // the saved answer is 70 min old: stale
  hang = 'find'
  const t0 = Date.now()
  const [s, body] = await dates(d1)
  check('stale cache: /dates asks again; FindRecDate never comes back: the request fails', s === 502 && /did not return/.test(body.error) && searches() === 2 && Date.now() - t0 < 1000, `${s} ${JSON.stringify(body)}`)
  const b = saved().d1
  check('... and the breaker is written (2 h)', b?.openUntil === clock + 2 * H && /time limit/.test(b.why) && b.dates.length === 2, JSON.stringify(b))
  check('... and logged', out.some((l) => l.includes('[d1]') && l.includes('recording days') && l.includes('2 h')), out.join(' | '))
  const [s2, cached] = await dates(d1)
  check('the next /dates answers from the (old) cache with no binding call', s2 === 200 && cached.length === 2 && searches() === 2, `${s2}, ${searches()} searches`)
  await releaseHung()
  hang = ''
  clock += 30 * M
  const d1c = fakeNvr('d1')
  const [s3, c3] = await dates(d1c)
  check('a new instance reads the breaker and the cache: no search', s3 === 200 && c3.length === 2 && searches() === 2 && d1c.jobs === 0, `${s3}, ${searches()} searches`)
  clock += 91 * M // the breaker (2 h) has run out
  const [s4] = await dates(d1c)
  check('once the breaker has run out, it asks again', s4 === 200 && searches() === 3 && saved().d1.at === clock, `${s4}, ${searches()} searches`)
}

// ---- no cache while the breaker is open: 503 with a Retry-After, still no search
{
  hang = 'next' // FindNextRecDate is the one that hangs this time
  const d2 = fakeNvr('d2')
  const [s] = await dates(d2)
  check('a FindNextRecDate past its time limit opens the breaker too', s === 502 && saved().d2?.openUntil === clock + 2 * H, JSON.stringify(saved().d2))
  const before = searches()
  const jobs = d2.jobs
  const [s2, body, headers] = await dates(d2)
  // (a 503 with retryAfterS here held the whole Playback page for up to the breaker's 2 hours: in
  // NVR mode no /recordings, in server mode no NVR clock, events or NVR-only stretches)
  check('breaker open, nothing cached: no days (200 []) at once, no search, no lane job', s2 === 200 && Array.isArray(body) && body.length === 0 && !headers?.['retry-after'] && searches() === before && d2.jobs === jobs, `${s2} ${JSON.stringify(body)}`)
  check('... and the empty answer is not saved as the NVR\'s days', !saved().d2?.at && saved().d2?.dates?.length === 0, JSON.stringify(saved().d2))
  await releaseHung()
  hang = ''
}

// ---- not within 2 minutes of a login (04:13:16 came 2 s after one)
{
  const d3 = fakeNvr('d3', { loggedInAt: clock - 30_000 })
  const before = searches()
  const [s, body] = await dates(d3)
  check('30 s after a login, nothing cached: no days (200 []), no search', s === 200 && Array.isArray(body) && body.length === 0 && searches() === before && d3.jobs === 0, `${s} ${JSON.stringify(body)}`)
  clock += 91_000
  const [s2, c2] = await dates(d3)
  check('2 minutes after the login it asks', s2 === 200 && c2.length === 2 && searches() === before + 1, `${s2}`)
  // with a cache, a fresh login answers from it (however old)
  clock += 2 * H
  d3.loggedInAt = clock - 5000
  const [s3, c3] = await dates(d3)
  check('just after a login, an old cache answers without a search', s3 === 200 && c3.length === 2 && searches() === before + 1, `${s3}`)
}

// ---- a busy NVR answers from its cache (it used to say 503 however recent the answer was)
{
  const d4 = fakeNvr('d4')
  await dates(d4)
  clock += 2 * H
  d4.degraded = true
  const before = searches()
  const [s, c] = await dates(d4)
  check('busy NVR with an old cache: the cache, no search', s === 200 && c.length === 2 && searches() === before, `${s}`)
  const d5 = fakeNvr('d5', { degraded: true })
  const [s2, body] = await dates(d5)
  check('busy NVR with no cache: 503 busy as before', s2 === 503 && body.error === 'The NVR is busy; try again in a moment', `${s2} ${JSON.stringify(body)}`)
}

// ---- start-up after a watchdog restart whose oldest call was this NVR's date search
{
  const hangAt = clock - 5 * M
  const call = (name, nvr) => ({ name, tag: 'playback', nvr, ms: 45_000, late: true })
  writeFileSync(join(DATA, 'last-hang.json'), JSON.stringify({ at: new Date(hangAt).toISOString(), reason: 'SDK call stuck for 91 s: NET_SDK_FindRecDate (playback)', stats: { calls: [call('NET_SDK_FindRecDate', 'd6'), call('NET_SDK_GetDeviceTime', 'd7')] } }))
  const before = searches()
  const d6 = fakeNvr('d6')
  const [s, body] = await dates(d6)
  check('a start-up whose last hang names FindRecDate for this NVR makes no search (no days, not 503)', s === 200 && Array.isArray(body) && body.length === 0 && searches() === before && d6.jobs === 0, `${s} ${JSON.stringify(body)}`)
  const d7 = fakeNvr('d7')
  const [s2] = await dates(d7)
  check('... another NVR (not the oldest call) is asked as usual', s2 === 200 && searches() === before + 1, `${s2}`)
  clock = hangAt + 2 * H + 1000
  const d6b = fakeNvr('d6')
  const [s3] = await dates(d6b)
  check('... and 2 hours after that hang it is asked again', s3 === 200 && searches() === before + 2, `${s3}`)
}

pb._test.setDateCalls(null)
if (failures) print(`\napp log:\n${out.join('\n')}`)
print(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
