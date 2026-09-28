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
const sdkStuck = sdk.sdkStuck ?? (() => undefined)

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

// ---- a late login (mayBlock) does not cool its NVR; an ordinary late call still does ------
// (02:30:11: a relogin 1 s late held the recording restarts of 23 cameras for 60 s)
{
  const lines = []
  const warn = console.warn
  console.warn = (...a) => lines.push(a.join(' '))
  await sdkCallT({ nvr: 'cool-login', tag: 'login', mayBlock: true, timeoutMs: 50 }, fake(200)).catch(() => {})
  await sleep(250) // it has come back now, 150 ms after its time limit
  check('a login (mayBlock) that came back late leaves its NVR not cooling', nvrCooling('cool-login') === false && lateCalls('cool-login') === 0)
  check('... and nothing is logged about holding new streams', !lines.some((l) => l.includes('[cool-login]')), lines.join(' | '))
  await sdkCallT({ nvr: 'cool-plain', tag: 'channels', timeoutMs: 50 }, fake(200)).catch(() => {})
  await sleep(250)
  check('an ordinary call that came back late still cools its NVR', nvrCooling('cool-plain') === true)
  console.warn = warn
  await sleep(COOL_MS + 50)
}

// ---- a background call (event intake, coverage, motion search) back late does not cool its NVR ----
// Nobody waits on those. nvr1's intake searches came back "5 s late" (the SDK's own 20 s give-up)
// and each time held that NVR's playback and searches for 60 s (playback report, problem 5).
{
  const lines = []
  const warn = console.warn
  console.warn = (...a) => lines.push(a.join(' '))
  const bg = sdkCallT({ nvr: 'cool-bg', tag: 'background search', background: true, timeoutMs: 50 }, fake(250)).catch((e) => e)
  await sleep(120)
  check('a background call that is late still counts while it is inside the SDK', nvrCooling('cool-bg') === true && lateCalls('cool-bg') === 1)
  check('... it still rejects at its time limit', (await bg)?.name === 'SdkTimeout')
  await sleep(250) // it has come back now, 200 ms after its time limit
  check('a background call that came back late leaves its NVR not cooling', nvrCooling('cool-bg') === false && lateCalls('cool-bg') === 0)
  check('... and nothing is logged about holding anything', !lines.some((l) => l.includes('[cool-bg]') && l.includes('holding')), lines.join(' | '))
  await sdkCallT({ nvr: 'cool-fg', tag: 'playback', timeoutMs: 50 }, fake(200)).catch(() => {})
  await sleep(250)
  check('the same call without background still cools its NVR', nvrCooling('cool-fg') === true)
  console.warn = warn
  await sleep(COOL_MS + 50)
}

// ---- what the cool-down holds, said as it is for the process ---------------------------------------
// In the main process with live workers it holds only playback and searches (live view and recording
// run in the workers, with their own SDK); in a worker, new streams; without workers, all of them.
{
  const lines = []
  const warn = console.warn
  console.warn = (...a) => lines.push(a.join(' '))
  const saved = { CCTV_WORKER_NVR: process.env.CCTV_WORKER_NVR, CCTV_LIVE_WORKER: process.env.CCTV_LIVE_WORKER }
  const setEnv = (env) => {
    for (const k of Object.keys(saved)) {
      if (env[k] === undefined) delete process.env[k]
      else process.env[k] = env[k]
    }
  }
  const saidFor = async (id, env) => {
    setEnv(env)
    try {
      await sdkCallT({ nvr: id, timeoutMs: 50 }, fake(150)).catch(() => {})
      await sleep(150)
    } finally {
      setEnv(saved)
    }
    return lines.find((l) => l.startsWith(`[${id}]`)) ?? ''
  }
  const main = await saidFor('say-main', { CCTV_LIVE_WORKER: 'on' })
  check('main process with live workers: "holding playback and searches", not new streams', /came back \d+ s late: holding playback and searches on this NVR for [\d.]+ s$/.test(main) && !main.includes('new streams'), main)
  const worker = await saidFor('say-worker', { CCTV_WORKER_NVR: 'say-worker' })
  check('a live worker: "holding new streams"', /holding new streams on this NVR/.test(worker) && !worker.includes('playback'), worker)
  const alone = await saidFor('say-alone', {})
  check('main process without workers: new streams, playback and searches', /holding new streams, playback and searches on this NVR/.test(alone), alone)
  console.warn = warn
  await sleep(COOL_MS + 50)
}

// ---- time limits the SDK's own waits fit inside --------------------------------------------------
{
  const budgetOf = sdk.budgetOf ?? (() => 0)
  // [lib] the SDK waits 20 s for a FindFile reply and gives up with a failed handle: inside our limit
  // that is a plain failure, not a late return that cools the NVR
  check('FindFile: time limit at least 21 s (the SDK gives up by itself at 20 s)', budgetOf('NET_SDK_FindFile') >= 21_000, budgetOf('NET_SDK_FindFile'))
  // [lib] on NVMS-9000 GetDeviceTime is an XML round trip the SDK waits up to 15 s for
  check('GetDeviceTime: time limit at least 16 s (the SDK waits up to 15 s)', budgetOf('NET_SDK_GetDeviceTime') >= 16_000, budgetOf('NET_SDK_GetDeviceTime'))
  check('an unknown function gets the default limit', budgetOf('NET_SDK_Nothing') === 30_000, budgetOf('NET_SDK_Nothing'))
}

// ---- error texts ---------------------------------------------------------------------------------
{
  const { errorText } = sdk
  check('error 27 (NET_SDK_BUSY) has a text', !/^error /.test(errorText(27)) && /busy/i.test(errorText(27)), errorText(27))
  check('error 31 (NET_SDK_DVR_NORESOURCE) has a text', !/^error /.test(errorText(31)) && /resource/i.test(errorText(31)), errorText(31))
  check('unknown codes still read "error N"', errorText(4242) === 'error 4242')
}

// ---- victims and roots (the watchdog's late rule counts roots only) -----------------------
{
  const warn = console.warn
  console.warn = () => {}
  const root = sdkCallT({ nvr: 'jam-0', tag: 'root', timeoutMs: 50 }, fake(700)).catch(() => {})
  await sleep(5)
  // three calls to three NVRs asked while the root is inside the SDK (the event poller at 04:12).
  // (Three, not six: this process may run with the default native-call cap of 4.)
  const victims = Array.from({ length: 3 }, (_, i) => sdkCallT({ nvr: `jam-${i % 3}`, tag: `victim ${i}`, timeoutMs: 50 }, fake(700)).catch(() => {}))
  await sleep(150)
  const s = sdkStats()
  const jam = s.calls.filter((c) => c.nvr.startsWith('jam-'))
  check('sdkStats: the oldest call in flight is the only one not marked a victim', jam.length === 4 && jam.filter((c) => !c.victim).map((c) => c.tag).join() === 'root', jam.map((c) => `${c.tag}:${c.victim}`).join(', '))
  check('sdkStats: lateRoots counts the root only, lateBlocking all four', s.lateRoots === 1 && s.lateBlocking === 4, `roots ${s.lateRoots}, blocking ${s.lateBlocking}`)
  await Promise.all([root, ...victims])
  await sleep(700)
  check('sdkStats: none left once they returned', sdkStats().lateRoots === 0 && sdkStats().inFlight === 0)
  console.warn = warn
}

// ---- sdkStuck: a call past its time limit with nothing back since it started --------------
{
  const warn = console.warn
  console.warn = () => {}
  /** A fake call that returns only when told to. */
  const held = () => {
    const f = { finish: () => {} }
    f.fn = { async: (...a) => (f.finish = () => a.at(-1)(null, 1)) }
    return f
  }
  check('sdkStuck: false with nothing in flight', sdkStuck() === false)
  const a = held()
  const pa = sdkCallT({ nvr: 'stk-a', tag: 'stuck', timeoutMs: 80 }, a.fn).catch(() => {})
  await sleep(30)
  check('sdkStuck: false while the call is still within its time limit', sdkStuck() === false)
  await sleep(100)
  check('sdkStuck: true once it is past its limit and nothing has come back since it started', sdkStuck() === true)
  await sdkCallT({ nvr: 'stk-b', timeoutMs: 500 }, fake(5))
  check('sdkStuck: false as soon as any native call comes back', sdkStuck() === false && lateCalls('stk-a') === 1)
  // a newer call that stops everything is not hidden by the older one (e.g. a login stuck for
  // minutes on an NVR that does not answer while the others kept returning)
  const b = held()
  const pb = sdkCallT({ nvr: 'stk-c', tag: 'wedge', timeoutMs: 80 }, b.fn).catch(() => {})
  await sleep(130)
  check('sdkStuck: true for a newer call past its limit with nothing back since, whatever older call is in flight', sdkStuck() === true)
  a.finish()
  b.finish()
  await Promise.all([pa, pb])
  await sleep(10)
  check('sdkStuck: false once they returned', sdkStuck() === false && lateCalls() === 0)
  // a login (mayBlock) past its limit on its own is not the SDK stuck; a call asked behind it that
  // goes late with nothing back is
  const login = held()
  const pl = sdkCallT({ nvr: 'stk-l', tag: 'login', mayBlock: true, timeoutMs: 80 }, login.fn).catch(() => {})
  await sleep(130)
  check('sdkStuck: a late login alone does not count', sdkStuck() === false && lateCalls('stk-l') === 1)
  const behind = held()
  const pbh = sdkCallT({ nvr: 'stk-m', tag: 'behind the login', timeoutMs: 80 }, behind.fn).catch(() => {})
  await sleep(130)
  check('sdkStuck: ... a call asked behind it that goes late with nothing back does', sdkStuck() === true)
  login.finish()
  behind.finish()
  await Promise.all([pl, pbh])
  await sleep(10)
  console.warn = warn
  await sleep(COOL_MS + 50)
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
    import * as wd from '${new URL('../watchdog.mjs', import.meta.url).href}'
    const { startWatchdog } = wd
    const spareWhile = wd.spareWhile ?? (() => {}) // (so the checks fail, not crash, without it)
    import { sdkCallT } from '${new URL('../sdk.mjs', import.meta.url).href}'
    const stuck = (tag, nvr) => sdkCallT({ timeoutMs: 100, tag, nvr }, { async() {} }).catch(() => {})
    const returnsAfter = (ms, tag, nvr) => sdkCallT({ timeoutMs: 100, tag, nvr }, { async(...a) { setTimeout(() => a.at(-1)(null, 1), ms) } }).catch(() => {})
    const exitAt = (ms) => setTimeout(() => { process.stderr.write('still running\\n'); process.exit(0) }, ms)
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
  const suffix = env?.CCTV_WORKER_NVR ? `-${env.CCTV_WORKER_NVR}` : ''
  const json = (name) => {
    try {
      return JSON.parse(readFileSync(join(dir, `${name}${suffix}.json`), 'utf8'))
    } catch {
      return null
    }
  }
  return { exitCode, signal, took: Date.now() - t0, stderr, dump: json('last-hang'), hold: json('last-hold') }
}
const SIX_STUCK = `for (let i = 0; i < 6; i++) stuck('stuck ' + i, 'nvr-' + (i % 3))`
const LATE_RULE = { WATCHDOG_MAX_CALL_MS: '20000', WATCHDOG_LATE_HOLD_MS: '1500', WATCHDOG_PROGRESS_MS: '800' }
{
  // a recording worker's watchdog is not changed: there six late calls still trip the late rule
  const r = await watchdogChild(SIX_STUCK, { ...LATE_RULE, CCTV_WORKER_NVR: 'wd-w1' })
  check('worker: watchdog trips on 6 late calls with none returning, once the oldest is past the hold', r.signal === 'SIGKILL' && r.took >= 1500 && r.took < 6000 && /6 SDK calls overdue/.test(r.dump?.reason ?? ''), `${r.signal} after ${r.took} ms: ${r.dump?.reason}`)
  check('the hang dump says how long ago a native call last returned', r.dump?.lastReturnAgoMs >= 800 && r.dump?.stats?.lastReturnAgoMs >= 800, String(r.dump?.lastReturnAgoMs))
}
{
  // the main process that runs the recording workers: one stuck call and six asked behind it
  // (04:12:13) are one jam, not seven (the single stuck call rule judges the root)
  const r = await watchdogChild(`stuck('root', 'nvr-0'); setTimeout(() => { ${SIX_STUCK} }, 20); exitAt(3500)`, { ...LATE_RULE, CCTV_LIVE_WORKER: 'on' })
  check('main with recording workers: a stuck root plus 6 victims does not trip the late rule', r.signal === null && r.exitCode === 0 && r.stderr.includes('still running'), `${r.signal ?? r.exitCode} after ${r.took} ms: ${r.dump?.reason ?? ''}`)
}
{
  // ... but a main process without recording workers (CCTV_LIVE_WORKER off, e.g. Docker: it runs
  // every live stream itself) keeps the late rule as it was: the same jam still ends at LATE_HOLD_MS
  const r = await watchdogChild(`stuck('root', 'nvr-0'); setTimeout(() => { ${SIX_STUCK} }, 20)`, { ...LATE_RULE, CCTV_LIVE_WORKER: '' })
  check('main without recording workers: a stuck root plus 6 victims still trips the late rule', r.signal === 'SIGKILL' && r.took >= 1500 && r.took < 6000 && /7 SDK calls overdue/.test(r.dump?.reason ?? '') && r.dump?.limits?.lateCounts === 'lateBlocking', `${r.signal} after ${r.took} ms: ${r.dump?.reason}; ${r.dump?.limits?.lateCounts}`)
}
// main process: while the workers record (spareWhile), a stuck-SDK verdict is held, up to a limit
{
  const r = await watchdogChild(`spareWhile(() => '3 cameras on 1 NVR'); stuck('stuck search', 'nvr-1'); exitAt(3000)`, { WATCHDOG_MAX_CALL_MS: '1000' })
  check('main: spareWhile(() => true) with one stuck call: still running after 3 s', r.signal === null && r.exitCode === 0 && r.stderr.includes('still running'), `${r.signal ?? r.exitCode} after ${r.took} ms`)
  check('... and it logs that it is holding, and why', /\[watchdog\] SDK call stuck .*holding.*3 cameras on 1 NVR/.test(r.stderr), r.stderr.split('\n').find((l) => l.includes('[watchdog]')) ?? '')
  check('... and writes last-hold.json (no hang dump)', r.hold?.outcome === 'holding' && r.hold.recording === '3 cameras on 1 NVR' && r.hold.stats?.calls?.[0]?.tag === 'stuck search' && r.hold.limitS === 300 && r.dump === null, JSON.stringify(r.hold)?.slice(0, 300))
}
{
  const r = await watchdogChild(`spareWhile(() => false); stuck('stuck search', 'nvr-1')`, { WATCHDOG_MAX_CALL_MS: '1000' })
  check('main: spareWhile(() => false): killed as before', r.signal === 'SIGKILL' && r.took < 4000 && /^SDK call stuck/.test(r.dump?.reason ?? '') && !/held/.test(r.dump?.reason ?? '') && r.hold === null, `${r.signal} after ${r.took} ms: ${r.dump?.reason}`)
}
{
  const r = await watchdogChild(`spareWhile(() => { throw new Error('probe broke') }); stuck('stuck search', 'nvr-1')`, { WATCHDOG_MAX_CALL_MS: '1000' })
  check('main: a probe that throws spares nothing', r.signal === 'SIGKILL' && r.took < 4000, `${r.signal} after ${r.took} ms`)
}
{
  const r = await watchdogChild(`spareWhile(() => true); stuck('stuck search', 'nvr-1')`, { WATCHDOG_MAX_CALL_MS: '1000', WATCHDOG_HOLD_MAX_MS: '1500' })
  check('main: the hold reaches its limit: killed', r.signal === 'SIGKILL' && r.took >= 2400 && r.took < 6000 && /held \d+ s while the workers recorded, the limit/.test(r.dump?.reason ?? ''), `${r.signal} after ${r.took} ms: ${r.dump?.reason}`)
  check('... last-hold.json says so', r.hold?.outcome === 'killed' && r.hold.heldS >= 1, JSON.stringify(r.hold)?.slice(0, 200))
}
{
  const r = await watchdogChild(`let on = true; spareWhile(() => on); stuck('stuck search', 'nvr-1'); setTimeout(() => (on = false), 2000)`, { WATCHDOG_MAX_CALL_MS: '1000' })
  check('main: a hold ends in the kill once the workers stop recording', r.signal === 'SIGKILL' && r.took >= 1900 && r.took < 5000 && /until the workers stopped recording/.test(r.dump?.reason ?? ''), `${r.signal} after ${r.took} ms: ${r.dump?.reason}`)
}
{
  const r = await watchdogChild(`spareWhile(() => true); returnsAfter(2500, 'slow search', 'nvr-1'); exitAt(3800)`, { WATCHDOG_MAX_CALL_MS: '1000' })
  check('main: a held stall that clears by itself: no restart', r.signal === null && r.exitCode === 0 && /\(slow search\) on nvr-1 returned after \d+ s held; no restart/.test(r.stderr), `${r.signal ?? r.exitCode}: ${r.stderr.split('\n').filter((l) => l.includes('[watchdog]')).join(' | ')}`)
  check('... last-hold.json says it recovered', r.hold?.outcome === 'recovered' && r.hold.first?.oldest?.includes('slow search') && r.hold.first?.call?.includes('slow search'), JSON.stringify(r.hold)?.slice(0, 300))
}
{
  // The hold belongs to the stuck call, not to a run of verdicts: another NVR's call that comes back
  // now and then (every 1.5 s, more than PROGRESS_MS apart) clears the verdict for a moment each
  // time, and must neither start the limit over nor count as the stall having cleared. (With the
  // limit starting over after each return the process was never killed, and last-hold.json said
  // 'recovered' while the call was still stuck.)
  const body = `spareWhile(() => true); stuck('stuck search', 'nvr-1')
    setInterval(() => sdkCallT({ timeoutMs: 500, nvr: 'nvr-ok', tag: 'now and then' }, quick).catch(() => {}), 1500)
    exitAt(9000)`
  const r = await watchdogChild(body, { WATCHDOG_MAX_CALL_MS: '1000', WATCHDOG_PROGRESS_MS: '800', WATCHDOG_HOLD_MAX_MS: '1500' })
  check('main: a call stuck for good is killed at the hold limit although other NVRs return now and then', r.signal === 'SIGKILL' && r.took >= 2400 && r.took < 7000 && /held \d+ s while the workers recorded, the limit/.test(r.dump?.reason ?? ''), `${r.signal ?? r.exitCode} after ${r.took} ms: ${r.dump?.reason ?? ''}`)
  check('... and the hold never reported that it had cleared', !/returned after|no restart/.test(r.stderr) && r.hold?.outcome === 'killed' && r.hold.first?.call?.includes('stuck search'), `${r.stderr.split('\n').filter((l) => l.includes('[watchdog]')).join(' | ')}; ${r.hold?.outcome}`)
}
{
  // a stuck call that returned ends its hold; a later stuck call gets a limit of its own
  const body = `spareWhile(() => true); returnsAfter(2000, 'first', 'nvr-1'); setTimeout(() => stuck('second', 'nvr-2'), 2100)`
  const r = await watchdogChild(body, { WATCHDOG_MAX_CALL_MS: '1000', WATCHDOG_PROGRESS_MS: '800', WATCHDOG_HOLD_MAX_MS: '1500' })
  check('main: after a held call returned, the next stuck call is held for the full limit again', r.signal === 'SIGKILL' && r.took >= 4500 && r.took < 9000 && /\(first\) on nvr-1 returned after/.test(r.stderr) && /the limit/.test(r.dump?.reason ?? '') && r.hold?.first?.call?.includes('second'), `${r.signal} after ${r.took} ms: ${r.dump?.reason}; ${r.stderr.split('\n').filter((l) => l.includes('[watchdog]')).join(' | ')}`)
}
{
  const r = await watchdogChild(`spareWhile(() => true); stuck('stuck stop', 'nvr-1')`, { WATCHDOG_MAX_CALL_MS: '1000', CCTV_WORKER_NVR: 'wd-w2' })
  check('worker: a probe that gives no flow snapshot leaves the single-call limit as it was (no hold either)', r.signal === 'SIGKILL' && r.took < 4000 && r.hold === null, `${r.signal} after ${r.took} ms`)
}
// an NVR worker judged by its recording's flow (recorder.mjs flow() through spareWhile)
{
  const flowing = `{ at: Date.now(), cameras: 10, flowing: 8, frozen: 0, recentMs: 10000, frozenMs: 45000, frozenChs: [] }`
  const r = await watchdogChild(`spareWhile(() => (${flowing})); stuck('viewer LivePlay', 'nvr-1'); exitAt(3000)`, { WATCHDOG_MAX_CALL_MS: '1000', WATCHDOG_FLOW_MAX_CALL_MS: '20000', CCTV_WORKER_NVR: 'wd-w3' })
  check('worker: recording flowing: no kill at MAX_CALL (still running after 3 s)', r.signal === null && r.exitCode === 0 && r.stderr.includes('still running'), `${r.signal ?? r.exitCode} after ${r.took} ms: ${r.dump?.reason ?? ''}`)
  check('... and it says why, once', (r.stderr.match(/\[watchdog\] SDK call stuck .*viewer LivePlay.*recording still flowing \(8 of 10 cameras.*not restarting before 20 s/g) ?? []).length === 1, r.stderr.split('\n').filter((l) => l.includes('[watchdog]')).join(' | '))
}
{
  const flowing = `{ at: Date.now(), cameras: 10, flowing: 5, frozen: 0 }`
  const r = await watchdogChild(`spareWhile(() => (${flowing})); stuck('viewer LivePlay', 'nvr-1')`, { WATCHDOG_MAX_CALL_MS: '800', WATCHDOG_FLOW_MAX_CALL_MS: '2000', CCTV_WORKER_NVR: 'wd-w4' })
  check('worker: recording flowing (half the cameras): killed at the longer limit', r.signal === 'SIGKILL' && r.took >= 2000 && r.took < 5000 && /recording still flowing/.test(r.dump?.reason ?? ''), `${r.signal} after ${r.took} ms: ${r.dump?.reason}`)
  check('... the dump includes the flow snapshot and the limits', r.dump?.flow?.cameras === 10 && r.dump.flow.flowing === 5 && r.dump.limits?.flowMaxCallMs === 2000 && r.dump.limits?.frozenCallMs === 60_000, JSON.stringify({ flow: r.dump?.flow, limits: r.dump?.limits }))
}
{
  const frozen = `{ at: Date.now(), cameras: 10, flowing: 0, frozen: 9, recentMs: 10000, frozenMs: 45000, frozenChs: [0, 1, 2, 3, 4, 5, 6, 7, 8] }`
  const r = await watchdogChild(`spareWhile(() => (${frozen})); stuck('viewer LivePlay', 'nvr-1')`, { WATCHDOG_MAX_CALL_MS: '5000', WATCHDOG_FROZEN_CALL_MS: '800', CCTV_WORKER_NVR: 'wd-w5' })
  check('worker: recording frozen: killed at the frozen limit, before MAX_CALL', r.signal === 'SIGKILL' && r.took >= 800 && r.took < 3000 && /recording frozen \(9 of 10 cameras/.test(r.dump?.reason ?? ''), `${r.signal} after ${r.took} ms: ${r.dump?.reason}`)
  check('... the dump includes the flow snapshot', r.dump?.flow?.frozen === 9 && r.dump.flow.frozenChs?.length === 9, JSON.stringify(r.dump?.flow))
}
{
  const neither = `{ at: Date.now(), cameras: 10, flowing: 3, frozen: 2 }`
  const r = await watchdogChild(`spareWhile(() => (${neither})); stuck('viewer LivePlay', 'nvr-1')`, { WATCHDOG_MAX_CALL_MS: '1000', WATCHDOG_FROZEN_CALL_MS: '400', WATCHDOG_FLOW_MAX_CALL_MS: '20000', CCTV_WORKER_NVR: 'wd-w6' })
  check('worker: neither flowing nor frozen: MAX_CALL as before', r.signal === 'SIGKILL' && r.took >= 1000 && r.took < 4000 && !/recording/.test(r.dump?.reason ?? ''), `${r.signal} after ${r.took} ms: ${r.dump?.reason}`)
}
{
  const r = await watchdogChild(`spareWhile(() => { throw new Error('probe broke') }); stuck('viewer LivePlay', 'nvr-1')`, { WATCHDOG_MAX_CALL_MS: '1000', WATCHDOG_FLOW_MAX_CALL_MS: '20000', CCTV_WORKER_NVR: 'wd-w7' })
  check('worker: a flow probe that throws: MAX_CALL as before', r.signal === 'SIGKILL' && r.took < 4000 && r.dump?.flow === null, `${r.signal} after ${r.took} ms`)
}
{
  const r = await watchdogChild(`${SIX_STUCK}; keepReturning(); setTimeout(() => { process.stderr.write('still running\\n'); process.exit(0) }, 3500)`, {
    WATCHDOG_MAX_CALL_MS: '20000', WATCHDOG_LATE_HOLD_MS: '1500', WATCHDOG_PROGRESS_MS: '800'
  })
  check('watchdog leaves 6 late calls alone while other calls keep returning', r.signal === null && r.exitCode === 0 && r.stderr.includes('still running'), `${r.signal ?? r.exitCode} after ${r.took} ms ${r.stderr.split('\n').find((l) => l.includes('[watchdog]')) ?? ''}`)
}
{
  // defaults for the late rule (only the single-call limit is shortened here). (This used to keep
  // calls to another NVR returning meanwhile and expect a kill; since 633f325 other NVRs' returns
  // spare a stuck call, so the child never died and the test hung. Both halves are checked now.)
  const r = await watchdogChild(`stuck('stuck stop', 'nvr-1')`, { WATCHDOG_MAX_CALL_MS: '1500' })
  check('watchdog trips on one call stuck past MAX_CALL_MS without waiting for the late rule', r.signal === 'SIGKILL' && r.took < 6000 && r.dump?.reason?.includes('stuck'), `${r.signal} after ${r.took} ms: ${r.dump?.reason}`)
  const l = r.dump?.limits ?? {}
  check('late rule defaults: oldest past 45 s and nothing back for 20 s (in the dump)', l.lateHoldMs === 45_000 && l.progressMs === 20_000 && l.maxLate === 6 && l.maxCallMs === 1500, JSON.stringify(l))
  const kept = await watchdogChild(`stuck('stuck stop', 'nvr-1'); keepReturning(); exitAt(3500)`, { WATCHDOG_MAX_CALL_MS: '1500' })
  check('... but not while calls to another NVR keep returning', kept.signal === null && kept.exitCode === 0, `${kept.signal ?? kept.exitCode} after ${kept.took} ms: ${kept.dump?.reason ?? ''}`)
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
