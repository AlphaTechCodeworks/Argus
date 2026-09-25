// Tests for the SDK guards (time limits, call tracking, native-call cap, lanes,
// frame routing, cool-down after late calls, watchdog). Uses fake SDK functions, so no NVR is needed.
// Run inside the container:  node cctv/test/sdk-guards.test.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// a short cool-down for the tests below (sdk.mjs reads it at load)
process.env.SDK_COOL_MS = '1500'
const COOL_MS = 1500
const { Lane, PRIORITY, connectLane } = await import('../lanes.mjs')
const sdk = await import('../sdk.mjs')
const { SdkTimeout, discountPause, exclusiveSettled, lateCalls, liveFrames, sdkCallT, sdkStats } = sdk
const nvrCooling = sdk.nvrCooling ?? (() => undefined) // (so the checks below fail, not crash, without it)

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

/** A fake koffi function: .async(...args, cb) calls back after `ms` (never if ms is null). */
const fake = (ms, result = 1, err = null) => ({
  async(...args) {
    const cb = args.at(-1)
    if (ms !== null) setTimeout(() => cb(err, result), ms)
  }
})

// ---- sdkCallT ------------------------------------------------------------
{
  const r = await sdkCallT({ timeoutMs: 500 }, fake(20, 42))
  check('fast call resolves with its result', r === 42)
}
{
  const t0 = Date.now()
  let late = null
  const p = sdkCallT({ timeoutMs: 200, tag: 'slow', onLate: (v) => (late = v) }, fake(600, 7))
  const err = await p.catch((e) => e)
  check('slow call rejects with SdkTimeout at its budget', err instanceof SdkTimeout && Date.now() - t0 < 400, err?.message)
  const s = sdkStats()
  check('overdue call stays tracked as late while the native call runs', s.late === 1 && s.inFlight === 1, JSON.stringify({ late: s.late, inFlight: s.inFlight }))
  await sleep(500)
  check('late result is handed to onLate', late === 7)
  check('slot released once the native call really returns', sdkStats().inFlight === 0)
}
{
  const err = await sdkCallT({ timeoutMs: 500 }, fake(10, 0, new Error('boom'))).catch((e) => e)
  check('native errors reject', err?.message === 'boom')
}
{
  // a call that fails after its timeout still reaches onLate, so flags like "still starting" clear
  let lateArgs = null
  await sdkCallT({ timeoutMs: 100, onLate: (...a) => (lateArgs = a) }, fake(300, 5, new Error('late boom'))).catch(() => {})
  await sleep(300)
  check('late failure is handed to onLate (no result, the error)', lateArgs?.[0] === undefined && lateArgs?.[1]?.message === 'late boom')
}
{
  // native-call cap: UV_THREADPOOL_SIZE - 16 (the container sets 64 -> 48)
  const cap = sdkStats().cap
  const hung = Array.from({ length: cap }, () => sdkCallT({ timeoutMs: 100 }, fake(1500)).catch(() => {}))
  await sleep(20)
  const extra = sdkCallT({ timeoutMs: 5000 }, fake(10, 'queued-ok'))
  await sleep(20)
  const s = sdkStats()
  check(`calls beyond the cap (${cap}) wait in a queue`, s.running === cap && s.queued === 1, JSON.stringify({ running: s.running, queued: s.queued }))
  check('queued call runs when a slot frees', (await extra) === 'queued-ok')
  await Promise.all(hung)
  await sleep(1600)
}

// ---- exclusive calls (live calls on one camera never overlap in the SDK) ------
{
  const log = []
  const timed = (ms, tag) => ({
    async(...args) {
      const cb = args.at(-1)
      log.push(`start ${tag}`)
      setTimeout(() => {
        log.push(`end ${tag}`)
        cb(null, tag)
      }, ms)
    }
  })
  // A outlives its time limit; B (same key) must wait for A to really return
  const a = sdkCallT({ timeoutMs: 100, exclusive: 'nvrX/3' }, timed(400, 'A')).catch((e) => e)
  const b = sdkCallT({ timeoutMs: 200, exclusive: 'nvrX/3' }, timed(50, 'B'))
  const c = sdkCallT({ timeoutMs: 500, exclusive: 'nvrX/4' }, timed(50, 'C')) // another camera
  const aErr = await a
  check('exclusive: the first call still times out at its own limit', aErr instanceof SdkTimeout)
  check('exclusive: another camera is not held up', (await c) === 'C' && !log.includes('end A'), log.join(', '))
  check('exclusive: same camera waits for the late call to really return, and its time limit starts only then', (await b) === 'B' && log.indexOf('start B') > log.indexOf('end A'), log.join(', '))
  check('exclusive: key released once idle', await exclusiveSettled('nvrX/', 100))
}
{
  // koffi refusing the arguments must not leave the camera's queue blocked
  const bad = { async() { throw new TypeError('bad argument') } }
  const e = await sdkCallT({ timeoutMs: 200, exclusive: 'nvrY/1' }, bad).catch((err) => err)
  const next = await sdkCallT({ timeoutMs: 200, exclusive: 'nvrY/1' }, fake(10, 'next')).catch((err) => err)
  check('exclusive: a call koffi refuses rejects and frees the queue', e instanceof TypeError && next === 'next')
}
{
  const slow = sdkCallT({ timeoutMs: 50, exclusive: 'nvrZ/2' }, fake(300, 1)).catch(() => {})
  check('exclusiveSettled: false while a call is still inside the SDK', (await exclusiveSettled('nvrZ/', 100)) === false)
  check('exclusiveSettled: true once it returned', await exclusiveSettled('nvrZ/', 1000))
  await slow
}

// ---- lanes ---------------------------------------------------------------
{
  const lane = new Lane('t', 2)
  let running = 0
  let peak = 0
  const order = []
  const job = (name, ms) => async () => {
    running++
    peak = Math.max(peak, running)
    order.push(name)
    await sleep(ms)
    running--
  }
  const jobs = [
    lane.run(job('a', 50)),
    lane.run(job('b', 50)),
    lane.run(job('start1', 10), { priority: PRIORITY.NORMAL }),
    lane.run(job('refresh', 10), { priority: PRIORITY.LOW }),
    lane.run(job('stop1', 10), { priority: PRIORITY.HIGH }),
    lane.run(job('stop2', 10), { priority: PRIORITY.HIGH })
  ]
  await Promise.all(jobs)
  check('lane never runs more than its concurrency', peak === 2, `peak ${peak}`)
  check('stops run before queued starts, housekeeping last', order.join(',') === 'a,b,stop1,stop2,start1,refresh', order.join(','))
  const failing = await lane.run(async () => { throw new Error('x') }).catch((e) => e.message)
  check('a failing job rejects without blocking the lane', failing === 'x' && (await lane.run(async () => 'next')) === 'next')
}
{
  // while an NVR has as many calls stuck in the SDK as its lane allows, only stops go ahead
  const lane = new Lane('stuck-nvr', 1)
  const order = []
  await sdkCallT({ nvr: 'stuck-nvr', timeoutMs: 100 }, fake(700)).catch(() => {}) // now late, native call still running
  const start = lane.run(async () => order.push('start'), { priority: PRIORITY.NORMAL })
  const stop = lane.run(async () => order.push('stop'), { priority: PRIORITY.HIGH })
  await stop
  await sleep(200)
  check('lane holds back new work while calls are stuck, stops still run', order.join(',') === 'stop', order.join(','))
  await start
  check('held-back work runs once the stuck call returns', order.join(',') === 'stop,start', order.join(','))
  await sleep(10) // a job resolves just before its slot is freed
  const busy = lane.run(() => sleep(100)) // holds the only slot, so the next two queue
  const dropped = lane.run(async () => 'ran', { priority: PRIORITY.LOW }).catch((e) => e.message)
  const kept = lane.run(async () => 'kept', { priority: PRIORITY.HIGH })
  lane.close()
  await busy
  check('closing a lane drops queued work but keeps queued stops', (await kept) === 'kept' && (await dropped) === 'NVR removed', await dropped)
}
{
  // lateCalls(id): one NVR's overdue calls; lateCalls(): every NVR's
  const base = lateCalls()
  const a = sdkCallT({ nvr: 'count-a', timeoutMs: 50 }, fake(400)).catch(() => {})
  const b = sdkCallT({ nvr: 'count-b', timeoutMs: 50 }, fake(400)).catch(() => {})
  await sleep(100)
  check('lateCalls(id) counts one NVR, lateCalls() every NVR', lateCalls('count-a') === 1 && lateCalls() === base + 2, `${lateCalls('count-a')} / ${lateCalls()}`)
  await Promise.all([a, b])
  await sleep(400)
}
{
  // the connect lane (logins, main-stream LivePlay) holds back while ANY NVR has a call stuck in
  // the SDK, which serialises work across NVRs; stops still go, and the hold ends when it returns
  const order = []
  const stuck = sdkCallT({ nvr: 'slow-nvr', timeoutMs: 100 }, fake(700)).catch(() => {})
  await sleep(150) // late now; the native call still runs
  const login = connectLane.run(async () => order.push('login other-nvr'))
  const stop = connectLane.run(async () => order.push('stop'), { priority: PRIORITY.HIGH })
  await stop
  await sleep(200)
  check('connect lane holds a login while another NVR has a late call; stops still go', order.join(',') === 'stop', order.join(','))
  await login
  check('connect lane runs the held login once that call returns', order.join(',') === 'stop,login other-nvr', order.join(','))
  await stuck
  // an NVR lane still looks at its own NVR only
  const lane = new Lane('own-nvr', 1)
  const other = sdkCallT({ nvr: 'another-nvr', timeoutMs: 50 }, fake(400)).catch(() => {})
  await sleep(100)
  check('an NVR lane is not held by another NVR’s late call', (await lane.run(async () => 'ran')) === 'ran' && lateCalls('another-nvr') === 1)
  lane.close()
  await other
  await sleep(350)
}

// ---- cool-down after a late call (nvrCooling) ------------------------------
{
  const lines = []
  const warn = console.warn
  console.warn = (...a) => lines.push(a.join(' '))
  const late = sdkCallT({ nvr: 'cool-a', tag: 'cool-a/2:main', timeoutMs: 50 }, fake(300)).catch(() => {})
  await sleep(100)
  check('an NVR cools while its call is late (still inside the SDK)', nvrCooling('cool-a') === true)
  await late
  await sleep(300) // the native call has returned now, 250 ms after its time limit
  const returnedAt = Date.now()
  check('it keeps cooling after the late call came back', nvrCooling('cool-a') === true && lateCalls('cool-a') === 0)
  check('other NVRs do not cool', nvrCooling('cool-b') === false)
  await sdkCallT({ nvr: 'cool-c', timeoutMs: 500 }, fake(20))
  check('a call that returns in time does not cool its NVR', nvrCooling('cool-c') === false)
  const said = () => lines.filter((l) => l.includes('[cool-a]') && l.includes('came back') && l.includes('late'))
  check('one log line when the NVR starts cooling', said().length === 1, lines.join(' | '))
  // a second late return in the same episode: it keeps cooling, no second line
  await sleep(500)
  await sdkCallT({ nvr: 'cool-a', timeoutMs: 50 }, fake(150)).catch(() => {})
  await sleep(150)
  const secondAt = Date.now()
  check('another late return in the same episode is not logged again', said().length === 1, said().join(' | '))
  await sleep(returnedAt + COOL_MS + 350 - Date.now())
  check('the cool-down counts from the last late return', nvrCooling('cool-a') === true)
  await sleep(secondAt + COOL_MS + 150 - Date.now())
  check('cooling ends COOL_MS after the last late return', nvrCooling('cool-a') === false)
  console.warn = warn
}

// ---- a call only queued behind another NVR's slow call does not cool its NVR --
{
  const warn = console.warn
  console.warn = () => {}
  // the SDK serialises calls: cq-ok's call is late only because cq-slow's started first
  const slow = sdkCallT({ nvr: 'cq-slow', timeoutMs: 50 }, fake(400)).catch(() => {})
  await sleep(10)
  const ok = sdkCallT({ nvr: 'cq-ok', timeoutMs: 50 }, fake(300)).catch(() => {})
  await Promise.all([slow, ok])
  await sleep(450)
  check('the slow NVR cools after its late return', nvrCooling('cq-slow') === true)
  check('an NVR whose late call was queued behind another NVR’s does not cool', nvrCooling('cq-ok') === false)
  console.warn = warn
  await sleep(COOL_MS + 50)
}

// ---- when did a native call last return (for the watchdog) ------------------
{
  await sdkCallT({ timeoutMs: 500 }, fake(10))
  const fresh = sdkStats().lastReturnAgoMs
  await sleep(400)
  const aged = sdkStats().lastReturnAgoMs
  discountPause(300) // the machine "slept" 300 ms of that
  const discounted = sdkStats().lastReturnAgoMs
  check('sdkStats says how long ago a native call last returned', fresh < 100 && aged >= 380, `${fresh} -> ${aged} ms`)
  check('a pause discount shifts the last return too', aged - discounted >= 290 && discounted >= 0, `${aged} -> ${discounted} ms`)
  discountPause(60_000)
  check('... never into the future', sdkStats().lastReturnAgoMs >= 0 && sdkStats().lastReturnAgoMs < 50, String(sdkStats().lastReturnAgoMs))
}

// ---- frame routing -------------------------------------------------------
{
  const got = []
  // frames can arrive before LivePlay returns the handle: simulate via claim of an unknown handle
  liveFrames.claim(111, (info) => got.push(info.frameIndex))
  liveFrames.release(111)
  check('released handles are marked dead (no crash)', true)
}

// ---- watchdog (child process with short limits) --------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'wd-'))
  const code = `
    import { startWatchdog } from '${new URL('../watchdog.mjs', import.meta.url).href}'
    import { sdkCallT } from '${new URL('../sdk.mjs', import.meta.url).href}'
    startWatchdog()
    sdkCallT({ timeoutMs: 200, tag: 'stuck stop' }, { async() {} }).catch(() => {})
    setInterval(() => {}, 1000)
  `
  const t0 = Date.now()
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, DATA_DIR: dir, WATCHDOG_GRACE_MS: '0', WATCHDOG_CHECK_MS: '200', WATCHDOG_MAX_CALL_MS: '1500' },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const signal = await new Promise((resolve) => child.on('exit', (_c, sig) => resolve(sig)))
  const took = Date.now() - t0
  check('watchdog SIGKILLs the process when a call stays stuck', signal === 'SIGKILL' && took < 8000, `${signal} after ${took} ms`)
  let dump = null
  try {
    dump = JSON.parse(readFileSync(join(dir, 'last-hang.json'), 'utf8'))
  } catch {}
  check('watchdog writes a diagnostic dump', dump?.reason?.includes('stuck') && dump?.stats?.calls?.[0]?.tag === 'stuck stop', dump?.reason)
  check('watchdog logs the reason to stderr', stderr.includes('[watchdog]'))
  const restarts = JSON.parse(readFileSync(join(dir, 'restarts.json'), 'utf8'))
  check('watchdog records the restart for the crash-loop guard', Array.isArray(restarts) && restarts.length === 1)
}

{
  // the machine sleeps (here: the event loop is blocked for 3 s) while a call is in the SDK:
  // that time must not count, but a call that stays stuck afterwards still trips
  const dir = mkdtempSync(join(tmpdir(), 'wd-'))
  const code = `
    import { startWatchdog } from '${new URL('../watchdog.mjs', import.meta.url).href}'
    import { sdkCallT } from '${new URL('../sdk.mjs', import.meta.url).href}'
    startWatchdog()
    sdkCallT({ timeoutMs: 200, tag: 'stuck across sleep' }, { async() {} }).catch(() => {})
    setTimeout(() => {
      const until = Date.now() + 3000
      while (Date.now() < until) {} // "asleep"
      process.stderr.write('woke at ' + Date.now() + '\\n')
    }, 300)
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, DATA_DIR: dir, WATCHDOG_GRACE_MS: '1500', WATCHDOG_CHECK_MS: '200', WATCHDOG_MAX_CALL_MS: '1500', WATCHDOG_PAUSE_MS: '1000' },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const signal = await new Promise((resolve) => child.on('exit', (_c, sig) => resolve(sig)))
  const killedAt = Date.now()
  const woke = Number(/woke at (\d+)/.exec(stderr)?.[1] ?? 0)
  check('watchdog: a pause (sleep) is noticed and not counted against the call', stderr.includes('no check for') && woke > 0, stderr.split('\n').find((l) => l.includes('no check')) ?? stderr.slice(0, 200))
  check('watchdog: no kill right after waking; still kills a call that stays stuck', signal === 'SIGKILL' && killedAt - woke > 1400, `${signal} ${killedAt - woke} ms after waking`)
}

// The "many late calls" rule is patient: it needs 6 late calls, the oldest past LATE_HOLD_MS, AND
// no native call (any NVR) back for PROGRESS_MS. A slow NVR keeps calls coming back; a hung SDK
// returns nothing. The single stuck call rule (MAX_CALL_MS) does not wait for that.
const watchdogChild = async (body, env) => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-'))
  const code = `
    import { startWatchdog } from '${new URL('../watchdog.mjs', import.meta.url).href}'
    import { sdkCallT } from '${new URL('../sdk.mjs', import.meta.url).href}'
    const stuck = (tag, nvr) => sdkCallT({ timeoutMs: 100, tag, nvr }, { async() {} }).catch(() => {})
    const quick = { async(...a) { setTimeout(() => a.at(-1)(null, 1), 10) } }
    const keepReturning = () => setInterval(() => sdkCallT({ timeoutMs: 500, nvr: 'nvr-ok', tag: 'quick' }, quick).catch(() => {}), 150)
    startWatchdog()
    ${body}
    setInterval(() => {}, 1000)
  `
  const t0 = Date.now()
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    // (UV_THREADPOOL_SIZE: a native-call cap of 48 as in the container, so 6 calls are all in flight)
    env: { ...process.env, DATA_DIR: dir, UV_THREADPOOL_SIZE: '64', WATCHDOG_GRACE_MS: '0', WATCHDOG_CHECK_MS: '200', ...env },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const [exitCode, signal] = await new Promise((resolve) => child.on('exit', (c, sig) => resolve([c, sig])))
  let dump = null
  try {
    dump = JSON.parse(readFileSync(join(dir, 'last-hang.json'), 'utf8'))
  } catch {}
  return { exitCode, signal, took: Date.now() - t0, stderr, dump }
}
const SIX_STUCK = `for (let i = 0; i < 6; i++) stuck('stuck ' + i, 'nvr-' + (i % 3))`
{
  const r = await watchdogChild(SIX_STUCK, { WATCHDOG_MAX_CALL_MS: '20000', WATCHDOG_LATE_HOLD_MS: '1500', WATCHDOG_PROGRESS_MS: '800' })
  check('watchdog trips on 6 late calls with none returning, once the oldest is past the hold', r.signal === 'SIGKILL' && r.took >= 1500 && r.took < 6000 && /6 SDK calls overdue/.test(r.dump?.reason ?? ''), `${r.signal} after ${r.took} ms: ${r.dump?.reason}`)
  check('the hang dump says how long ago a native call last returned', r.dump?.lastReturnAgoMs >= 800 && r.dump?.stats?.lastReturnAgoMs >= 800, String(r.dump?.lastReturnAgoMs))
}
{
  const r = await watchdogChild(`${SIX_STUCK}; keepReturning(); setTimeout(() => { process.stderr.write('still running\\n'); process.exit(0) }, 3500)`, {
    WATCHDOG_MAX_CALL_MS: '20000', WATCHDOG_LATE_HOLD_MS: '1500', WATCHDOG_PROGRESS_MS: '800'
  })
  check('watchdog leaves 6 late calls alone while other calls keep returning', r.signal === null && r.exitCode === 0 && r.stderr.includes('still running'), `${r.signal ?? r.exitCode} after ${r.took} ms ${r.stderr.split('\n').find((l) => l.includes('[watchdog]')) ?? ''}`)
}
{
  // defaults for the late rule (only the single-call limit is shortened here)
  const r = await watchdogChild(`stuck('stuck stop', 'nvr-1'); keepReturning()`, { WATCHDOG_MAX_CALL_MS: '1500' })
  check('watchdog still trips on one call stuck past MAX_CALL_MS, even while others return', r.signal === 'SIGKILL' && r.took < 6000 && r.dump?.reason?.includes('stuck'), `${r.signal} after ${r.took} ms: ${r.dump?.reason}`)
  const l = r.dump?.limits ?? {}
  check('late rule defaults: oldest past 45 s and nothing back for 20 s (in the dump)', l.lateHoldMs === 45_000 && l.progressMs === 20_000 && l.maxLate === 6 && l.maxCallMs === 1500, JSON.stringify(l))
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
