// Tests for the NVR's recorded-file search (playback.mjs recordings(): the NVR-mode timeline, the event
// intake, rec-fallback coverage, backfill and motion search) and the NVR clock reads around it
// (playback report problem 5; SDK answer changes 2, 3 and 9):
//   - recordings() uses the NVR's last clock read while it is under 10 min old, a playback open while
//     it is under 5 min old; /api/playback/now always reads the clock
//   - a failed FindFile (handle <= 0) is an error, not "no footage", and the timeline route says so
//   - a FindNextFile walk is complete only when it ends with 86 (no file) or 87 (no more files); 88,
//     89 or anything else is an error, and the search handle is closed either way
//   - a background search (recordings(ch, date, { background: true })) has its own tag and coming back
//     late does not cool the NVR; a timeline search's late return still does
// Fake SDK search functions (playback.mjs _test.setSearchCalls) and fake lanes: nothing reaches an NVR.
// Run on a server copy:  node cctv/test/playback-search.test.mjs
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'pb-search-'))
process.env.SDK_COOL_MS = '1500' // a short cool-down (sdk.mjs reads it at load)
const sdk = await import('../sdk.mjs')
const { PRIORITY } = await import('../lanes.mjs')
const pb = await import('../playback.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const J = (v) => JSON.stringify(v)
const MIN = 60_000
const H = 60 * MIN
const TZ = -4 * H // the NVRs' time zone: UTC-4
// (the clock-age checks move this process's clock forward instead of waiting; timers are not affected)
const realNow = Date.now
let shiftMs = 0
Date.now = () => realNow() + shiftMs

// ---- fake SDK search functions --------------------------------------------------------------------
const log = [] // every fake call: { fn, a0 }
const dev = { files: [], endCode: 87, handle: 55, findMs: 5, timeMs: 5, timeOk: true }
const cursors = new Map() // search handle -> index of the next file
const fakeFn = (cName, answer, ms = () => 5) => ({
  cName, // (sdk.mjs names the call like the real one: time limits, logs)
  async(...args) {
    const cb = args.at(-1)
    const a = args.slice(0, -1)
    log.push({ fn: cName.replace('NET_SDK_', ''), a0: a[0] })
    setTimeout(() => {
      try {
        cb(null, answer(...a))
      } catch (e) {
        cb(e)
      }
    }, ms())
  }
})
const fakes = {
  // the NVR's local wall clock, fields read as UTC (as GetDeviceTime fills PB_DD_TIME)
  GetDeviceTime: fakeFn('NET_SDK_GetDeviceTime', (_user, t) => {
    if (!dev.timeOk) return false
    Object.assign(t, pb.toDD(Date.now() + TZ))
    return true
  }, () => dev.timeMs),
  FindFile: fakeFn('NET_SDK_FindFile', () => {
    if (dev.handle > 0) cursors.set(dev.handle, 0)
    return dev.handle
  }, () => dev.findMs),
  FindNextFile: fakeFn('NET_SDK_FindNextFile', (h, item) => {
    const i = cursors.get(h) ?? 0
    const f = dev.files[i]
    if (!f) return dev.endCode
    cursors.set(h, i + 1)
    Object.assign(item, { startTime: pb.toDD(f[0]), stopTime: pb.toDD(f[1]), dwRecType: f[2] })
    return 85 // NET_SDK_FILE_SUCCESS: one more file
  }),
  FindClose: fakeFn('NET_SDK_FindClose', () => true)
}
check('playback.mjs lets the tests replace its search calls (_test.setSearchCalls)', typeof pb._test?.setSearchCalls === 'function')
if (typeof pb._test?.setSearchCalls !== 'function') {
  // (without it every search below would call the real SDK)
  console.log(`\n${failures} FAILED`)
  process.exit(1)
}
pb._test.setSearchCalls(fakes)
const calls = (fn) => log.filter((c) => c.fn === fn).length

/** A fake NVR whose lane runs its jobs (so the fake SDK functions above are what they call). */
const nvrOf = (id) => {
  const nvr = { id, name: `NVR ${id}`, userId: 7, online: true, degraded: false, jobs: [] }
  nvr.lane = {
    run: (task, { priority = PRIORITY.NORMAL } = {}) => {
      nvr.jobs.push(priority)
      return Promise.resolve().then(task)
    }
  }
  nvr.playback = pb.createPlayback(nvr)
  return nvr
}
// a past NVR-local day, so none of its files is after "now"
const DAY = new Date(Date.now() + TZ - 2 * 86_400_000).toISOString().slice(0, 10)
const D0 = Date.parse(`${DAY}T00:00:00Z`) - TZ // its local midnight, in UTC
const FILES = [
  [D0 + H, D0 + H + 10 * MIN, 0x1], // continuous
  [D0 + H + 10 * MIN + 1000, D0 + H + 20 * MIN, 0x4], // motion, 1 s later: one stretch with the first
  [D0 + 5 * H, D0 + 5 * H + MIN, 0x1]
]
const WANT = { ranges: [[D0 + H, D0 + H + 20 * MIN], [D0 + 5 * H, D0 + 5 * H + MIN]], events: [[D0 + H + 10 * MIN + 1000, D0 + H + 20 * MIN, 0x4]] }
const reset = () => {
  dev.files = FILES
  dev.endCode = 87
  dev.handle = 55
  dev.findMs = 5
  dev.timeMs = 5
  dev.timeOk = true
}
/** The tag of the fake call `fn` of NVR id while it is inside the SDK (sdk.mjs sdkStats). */
const tagInFlight = (id, fn) => sdk.sdkStats().calls.find((c) => c.nvr === id && c.name === `NET_SDK_${fn}`)?.tag

// ---- background searches: their own tag; a late return does not cool the NVR ----------------------
{
  reset()
  const a = nvrOf('bg-a')
  dev.timeMs = 150
  dev.findMs = 150
  const fg = a.playback.recordings(0, DAY)
  await sleep(60)
  const fgClock = tagInFlight('bg-a', 'GetDeviceTime')
  await sleep(150)
  const fgFind = tagInFlight('bg-a', 'FindFile')
  await fg
  check('a timeline search (and its clock read) is tagged "playback" as before', fgClock === 'playback' && fgFind === 'playback', `${fgClock} / ${fgFind}`)
  const b = nvrOf('bg-b')
  const bg = b.playback.recordings(0, DAY, { background: true })
  await sleep(60)
  const bgClock = tagInFlight('bg-b', 'GetDeviceTime')
  await sleep(150)
  const bgFind = tagInFlight('bg-b', 'FindFile')
  const r = await bg
  check('a background search (and its clock read) has its own tag', bgClock === 'background search' && bgFind === 'background search', `${bgClock} / ${bgFind}`)
  check('... and answers the same', J(r) === J(WANT), J(r))

  // late: a short time limit for every search call, FindFile back after it
  reset()
  pb._test.setSearchCalls({ ...fakes, timeoutMs: 60 })
  const lines = []
  const warn = console.warn
  console.warn = (...x) => lines.push(x.join(' '))
  const c = nvrOf('bg-late')
  await c.playback.clock() // (the clock read of the search itself is not what is late here)
  dev.findMs = 200
  const e1 = await c.playback.recordings(0, DAY, { background: true }).catch((e) => e)
  check('a background search past its time limit rejects (SdkTimeout)', e1?.name === 'SdkTimeout' && /background search/.test(e1.message), e1?.message)
  await sleep(250) // FindFile has come back now, late
  check('... and once it has come back late, its NVR is not cooling', sdk.nvrCooling('bg-late') === false && sdk.lateCalls('bg-late') === 0)
  check('... nor is "holding" logged for it', !lines.some((l) => l.includes('[bg-late]') && l.includes('holding')), lines.join(' | '))
  const d = nvrOf('fg-late')
  await d.playback.clock()
  const e2 = await d.playback.recordings(0, DAY).catch((e) => e)
  await sleep(250)
  check('a timeline search back late still cools its NVR', e2?.name === 'SdkTimeout' && sdk.nvrCooling('fg-late') === true, e2?.message)
  console.warn = warn
  pb._test.setSearchCalls(fakes)
  await sleep(1600) // (fg-late cools down)
}

// ---- a failed search is not "no footage" ----------------------------------------------------------
{
  reset()
  const n = nvrOf('fail')
  await n.playback.recordings(0, DAY) // (reads the clock)
  for (const handle of [0, -1]) {
    dev.handle = handle
    const next = calls('FindNextFile')
    const closes = calls('FindClose')
    const e = await n.playback.recordings(0, DAY).catch((err) => err)
    check(`FindFile answering ${handle}: recordings() rejects instead of answering no footage`, e instanceof Error && !Array.isArray(e?.ranges) && /unknown/.test(e.message), J(e?.message ?? e))
    check('... without walking or closing a handle it never got', calls('FindNextFile') === next && calls('FindClose') === closes)
  }
  const [status, body] = await pb.playbackApi(n, '/api/playback/recordings', new URLSearchParams(`ch=0&date=${DAY}`))
  check('the timeline route answers 502 with the reason, not 200 with no ranges', status === 502 && /unknown/.test(body.error ?? ''), `${status} ${J(body)}`)
  dev.handle = 55
  const [ok, good] = await pb.playbackApi(n, '/api/playback/recordings', new URLSearchParams(`ch=0&date=${DAY}`))
  check('... and 200 with the ranges once the search works again', ok === 200 && J(good) === J(WANT), `${ok} ${J(good)}`)
}

// ---- how a FindNextFile walk ends -------------------------------------------------------------------
{
  reset()
  const n = nvrOf('walk')
  for (const code of [86, 87]) {
    dev.endCode = code
    const closes = calls('FindClose')
    const r = await n.playback.recordings(0, DAY).catch((e) => e)
    check(`a walk ending with ${code} is a complete day`, J(r) === J(WANT) && calls('FindClose') === closes + 1, J(r?.message ?? r))
  }
  // 88 NET_SDK_FILE_EXCEPTION and 89 NET_SDK_TRY_LATER used to end the walk like 87: a broken list
  // shown as the whole day
  for (const code of [88, 89, -1, 90]) {
    dev.endCode = code
    const closes = calls('FindClose')
    const e = await n.playback.recordings(0, DAY).catch((err) => err)
    check(`a walk ending with ${code} is an error, not a complete day`, e instanceof Error && e.message.includes(String(code)) && /unknown/.test(e.message), J(e?.message ?? e))
    check('... and the search handle is still closed', calls('FindClose') === closes + 1)
  }
  dev.endCode = 87
  dev.files = []
  const empty = await n.playback.recordings(0, DAY)
  check('a day without files: empty, with no error (the NVR said so)', J(empty) === J({ ranges: [], events: [] }), J(empty))
}

// ---- the clock: recordings() reuses the last read under 10 min old ------------------------------------
{
  reset()
  const n = nvrOf('clock')
  const t0 = calls('GetDeviceTime')
  await n.playback.recordings(0, DAY)
  check('the first search reads the NVR clock once', calls('GetDeviceTime') === t0 + 1)
  await n.playback.recordings(1, DAY)
  await n.playback.recordings(2, DAY, { background: true })
  check('searches after it use that read: no GetDeviceTime', calls('GetDeviceTime') === t0 + 1, `${calls('GetDeviceTime') - t0} reads`)
  shiftMs += 9 * MIN
  const r9 = await n.playback.recordings(0, DAY)
  check('... still 9 min later', calls('GetDeviceTime') === t0 + 1 && J(r9) === J(WANT), `${calls('GetDeviceTime') - t0} reads`)
  shiftMs += 2 * MIN
  await n.playback.recordings(0, DAY)
  check('11 min after the read the clock is read again', calls('GetDeviceTime') === t0 + 2, `${calls('GetDeviceTime') - t0} reads`)
  const [status, now] = await pb.playbackApi(n, '/api/playback/now', new URLSearchParams())
  check('/api/playback/now reads the clock every time, however fresh the last read', status === 200 && calls('GetDeviceTime') === t0 + 3 && now.tzOffsetMs === TZ, `${status} ${J(now)}`)
  // today: a file still being written is cut at "now" from the reused read (NVR clock = server + skew)
  const today = new Date(Date.now() + TZ).toISOString().slice(0, 10)
  const T0 = Date.parse(`${today}T00:00:00Z`) - TZ
  if (Date.now() - T0 > 2 * MIN) {
    dev.files = [[T0, Date.now() + H, 0x1]]
    const r = await n.playback.recordings(0, today)
    const end = r.ranges[0]?.[1] ?? 0
    check('today, from the reused read: the open file ends at the NVR\'s now', calls('GetDeviceTime') === t0 + 3 && Math.abs(end - Date.now()) < 3000, `${end - Date.now()} ms`)
  }
  // a failed clock read is still an error (checked as before)
  const m = nvrOf('clock-fail')
  dev.timeOk = false
  const e = await m.playback.recordings(0, DAY).catch((err) => err)
  check('with no usable clock read the search fails (GetDeviceTime failed)', /GetDeviceTime failed/.test(e?.message ?? ''), e?.message)
  dev.timeOk = true
  shiftMs = 0
}

// ---- the clock: a playback open reuses the last read under 5 min old ---------------------------------
{
  /** A fake NVR whose lane answers jobs from `answers` without running them (so no playback call runs). */
  const o = { id: 'open', name: 'NVR open', userId: 7, online: true, degraded: false, jobs: [], answers: [], logins: 0 }
  o.lane = {
    run: (_task, { priority = PRIORITY.NORMAL } = {}) => {
      o.jobs.push(priority)
      const a = o.answers.shift()
      return Promise.resolve(typeof a === 'function' ? a() : a ?? true)
    }
  }
  o.sessions = { acquire: async () => (o.logins++, { userId: 9, release() {} }) }
  o.playback = pb.createPlayback(o)
  const fakeWs = () => {
    const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, sent: [], handlers: {} }
    ws.send = (m) => typeof m === 'string' && ws.sent.push(JSON.parse(m))
    ws.on = (event, fn) => (ws.handlers[event] = fn)
    ws.close = () => {
      if (ws.readyState !== 1) return
      ws.readyState = 3
      ws.handlers.close?.()
    }
    return ws
  }
  const open = async () => {
    const ws = fakeWs()
    o.jobs.length = 0
    o.playback.connect(ws, new URL(`ws://x/playback?nvr=open&ch=0&stream=0&start=${Date.now() - H}`))
    await sleep(60)
    const jobs = [...o.jobs]
    const started = ws.sent.some((m) => m.type === 'started')
    ws.close()
    await sleep(20)
    return { jobs, started, sent: ws.sent }
  }
  o.answers.push(() => pb.toDD(Date.now() + TZ))
  await o.playback.clock()
  check('(the NVR clock was read)', o.playback.lastClock()?.tzOffsetMs === TZ)
  shiftMs += 4 * MIN
  o.answers.push(77, true) // PlayBackByTimeEx (a handle), SetPlayDataCallBack
  const a = await open()
  check('a playback opened 4 min after a clock read does not read the clock: playback, then its callback', a.started && J(a.jobs) === J([PRIORITY.NORMAL, PRIORITY.HIGH]), `${J(a.jobs)} ${J(a.sent)}`)
  shiftMs += 2 * MIN
  o.answers.length = 0
  o.answers.push(() => pb.toDD(Date.now() + TZ), 78, true) // GetDeviceTime, PlayBackByTimeEx, SetPlayDataCallBack
  const b = await open()
  check('6 min after it, the open reads the clock first', b.started && J(b.jobs) === J([PRIORITY.NORMAL, PRIORITY.NORMAL, PRIORITY.HIGH]), `${J(b.jobs)} ${J(b.sent)}`)
  o.answers.length = 0
  o.answers.push(79, true)
  const c = await open()
  check('... which the next open uses', c.started && c.jobs.length === 2, J(c.jobs))
  shiftMs = 0
}

// ---- the other callers pass background ------------------------------------------------------------
{
  const motion = readFileSync(new URL('../motion.mjs', import.meta.url), 'utf8')
  check('motion.mjs: its day searches and its clock read are background work',
    /nvr\.playback\.recordings\(ch, date, \{ background: true \}\)/.test(motion) && /nvr\.playback\.clock\(\{ background: true \}\)/.test(motion))
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
