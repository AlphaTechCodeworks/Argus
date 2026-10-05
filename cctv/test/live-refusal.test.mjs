// LiveStream start failures: a start the NVR refuses at once is marked fast (lastFailure.fast) and
// logged with the SDK's last error; a start that gets a valid handle but no video within 8 s
// (nvr-2 refuses silently) is treated as refused: stopped, marked, retried on the back-off.
// A start that fails with 9, "not connected" (the SDK re-making a link that dropped), is not a
// refusal: the recorder keeps the camera and the stream's own restart steps try it again; 8,
// value4u's sub-stream limit, still is (both with a real Recorder over real LiveStreams, fake clock).
// Fake SDK functions and a fake NVR object: nothing reaches an NVR.
// Run:  node cctv/test/live-refusal.test.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { mock } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'refusal-'))
process.env.CCTV_WORKER_FAKE_SDK = '1'
process.env.CCTV_TEST_FIRST_FRAME_MS = '400'
const { NET_SDK, liveFrames, FRAME_TYPE_VIDEO } = await import('../sdk.mjs')
const { Lane } = await import('../lanes.mjs')

const print = console.log.bind(console)
const out = []
console.log = (...a) => out.push(a.join(' '))
console.warn = (...a) => out.push(a.join(' '))
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  print(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const until = async (cond, maxMs) => {
  for (const end = Date.now() + maxMs; Date.now() < end; await sleep(25)) if (cond()) return true
  return cond()
}

const log = []
let nextHandle = 500
const feeding = new Set([7]) // channels whose handle delivers video
const handleCh = new Map()
// how a channel's starts fail (an SDK error code; none: it plays): always (channel 5 is refused at
// once, 31 NET_SDK_DVR_NORESOURCE), or the next few (a link being re-made)
const always = new Map([[5, 31]])
const next = new Map()
let lastError = 0 // GetLastError: the code of the last start that failed
const answers = {
  GetLastError: () => lastError,
  LivePlay: (userId, info) => {
    const ch = info.lChannel
    const code = always.get(ch) ?? next.get(ch)?.shift() ?? 0
    log.push({ fn: 'LivePlay', ch, code, at: Date.now() })
    if (code) {
      lastError = code
      return -1
    }
    const h = nextHandle++
    handleCh.set(h, ch)
    return h
  },
  StopLivePlay: (h) => {
    log.push({ fn: 'StopLivePlay', ch: handleCh.get(h) })
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
const realClaim = liveFrames.claim.bind(liveFrames)
const timers = []
const feeds = new Map() // handle -> its video's interval
liveFrames.claim = (h, fn) => {
  realClaim(h, fn)
  if (!feeding.has(handleCh.get(h))) return
  let n = 0
  const t = setInterval(() => {
    const key = n++ % 25 === 0
    fn({ frameType: FRAME_TYPE_VIDEO, length: 16, keyFrame: key ? 1 : 0, width: 64, height: 36, time: Date.now() * 1000 }, Buffer.alloc(16, 1))
  }, 40)
  t.unref?.()
  timers.push(t)
  feeds.set(h, t)
}

const { LiveStream } = await import('../live.mjs')
const nvr = {
  id: 'fake',
  userId: 3,
  lane: new Lane('fake', 2),
  failed: 0,
  liveFailed() {
    this.failed++
    return Promise.resolve()
  },
  liveStarted() {},
  streamStopped() {},
  noteCodec() {}
}
const ws = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, send() {} })

const refused = new LiveStream(nvr, 5, 0)
refused.add(ws())
check('fast refusal: lastFailure marked fast', await until(() => refused.lastFailure?.fast === true, 3000), JSON.stringify(refused.lastFailure))
check('fast refusal: the reason carries the SDK error', /refused/.test(refused.lastFailure?.reason ?? '') && /error 31|no resource|31/.test(refused.lastFailure?.reason ?? ''), refused.lastFailure?.reason)
// (31 has a text now, sdk.mjs errorText: "NVR has no resources left")
check('fast refusal: the log says why', out.some((l) => l.includes('fake/6:main failed to start') && /31|no resource/.test(l)), out.filter((l) => l.includes('fake/6')).join(' | '))
check('fast refusal: its code is kept', refused.lastFailure?.code === 31, JSON.stringify(refused.lastFailure))

const silent = new LiveStream(nvr, 6, 0)
silent.add(ws())
check('silent: plays first', await until(() => silent.state === 'playing', 2000))
check('silent: no video in the first-frame window -> refused', await until(() => silent.lastFailure?.silent === true && silent.lastFailure.fast === true, 3000), JSON.stringify(silent.lastFailure))
check('silent: its handle is stopped and a restart is scheduled', await until(() => log.some((c) => c.fn === 'StopLivePlay' && c.ch === 6), 2000) && silent.state === 'restarting')
check('silent: logged', out.some((l) => l.includes('fake/7:main') && /no video/.test(l)))

const good = new LiveStream(nvr, 7, 0)
good.add(ws())
await sleep(900)
check('a stream with video: no failure', good.state === 'playing' && good.lastFailure == null, JSON.stringify(good.lastFailure))

for (const s of [refused, silent, good]) await s.stop()
for (const t of timers) clearInterval(t)
timers.length = 0

// ---- A dropped link is not a refusal (perf audit R4, 29 Sep 2026)
// When the NVR drops its links, the SDK answers a start with 9, "not connected", until it has made
// the link again (20-60 s; the next stream started a median 27.7 s after). Taken as the NVR saying
// no, the recorder left the camera alone for 5-10 minutes: 42 times in 63.5 h (27-29 Sep), 43 of 44
// within 21 s of a link drop, 15,546 s of recording lost. Here a real Recorder records over real
// LiveStreams on a fake clock (node:test mock timers), with the worker's 250 ms recorder tick and
// its 5 s stall check (nvr-worker.mjs). No storage location: nothing is written (the refusal is
// decided in Recorder.attach, whatever the disk does).
{
  const { Recorder } = await import('../recorder.mjs')
  const { recentRefusals } = await import('../nvr-health.mjs')
  const { subCap } = await import('../sub-cap.mjs')
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() })
  // one step of the fake clock: its timers, then everything they set going until the loop turns.
  // longestTurn: the longest such step in real time, a heartbeat of the main thread
  let longestTurn = 0
  const step1 = async (step) => {
    const t = performance.now()
    mock.timers.tick(step)
    await new Promise((r) => setImmediate(r))
    longestTurn = Math.max(longestTurn, performance.now() - t)
  }
  const advance = async (ms, step = 50) => {
    for (let t = 0; t < ms; t += step) await step1(step)
  }
  const advanceUntil = async (cond, maxMs, step = 50) => {
    for (let t = 0; t < maxMs && !cond(); t += step) await step1(step)
    return cond()
  }
  const streams = new Map()
  const getStream = (ch, type = 0) => {
    const key = `${ch}:${type}`
    let s = streams.get(key)
    if (!s || s.stopped) streams.set(key, (s = new LiveStream(nvr, ch, type)))
    return s
  }
  const rec = new Recorder({ nvrId: 'fake', getStream, online: () => true, channels: () => [10, 11], send() {}, now: () => Date.now() })
  const recTick = setInterval(() => rec.sync(), 250)
  const stallCheck = setInterval(() => {
    for (const s of streams.values()) if (s.stalled) s.restart('stalled')
  }, 5000)
  // past the recorder's first 3 minutes, when a refusal waits 30-60 s: now it waits 5-10 minutes
  await advance(185_000, 5000)
  const DEFAULTS = { mode: 'off', fullDays: 30, after: 'timelapse', timelapseS: 10, retentionDays: 183, preS: 10, postS: 20 }
  feeding.add(10)
  rec.apply({ recording: { defaults: DEFAULTS, cameras: { 'fake/10': { mode: 'continuous' } } }, locations: [] })
  await advance(3000)
  const cam = rec.cams.get(10)
  const main = streams.get('10:0')
  check('dropped link: the camera records its main stream, which plays', main?.state === 'playing' && cam?.stream === main && rec.flow()?.flowing === 1, `${main?.state} ${JSON.stringify(rec.flow())}`)

  // the link drops: no more video, and the SDK answers the next two starts "not connected". The
  // main thread is watched in real time from here until it records again: this path adds no
  // blocking work (the SDK's last error was already read on every failed start)
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  longestTurn = 0
  const realAt = performance.now()
  const dropAt = Date.now()
  next.set(10, [9, 9])
  clearInterval(feeds.get(main.handle))
  const starts = () => log.filter((c) => c.fn === 'LivePlay' && c.ch === 10 && c.at > dropAt)
  check('dropped link: stalled, restarted, and the start fails with 9', await advanceUntil(() => starts().length === 1 && main.lastFailure != null, 40_000), JSON.stringify(starts()))
  check('dropped link: 9 is not a refusal (lastFailure not fast), its code and reason kept', main.lastFailure?.fast === false && main.lastFailure.code === 9 && /not connected/.test(main.lastFailure.reason), JSON.stringify(main.lastFailure))
  check('dropped link: logged as a failed start, not a refusal', out.some((l) => l.includes('fake/11:main failed to start') && /not connected/.test(l) && !/refused/.test(l)), out.filter((l) => l.includes('fake/11')).join(' | '))
  const nine = { ...main.lastFailure }
  await advance(1000) // four of the recorder's ticks
  check('dropped link: the recorder keeps the camera on its stream: no 5-10 minute back-off', cam.stream === main && main.clients.has(cam.tap) && cam.refusedUntil === 0, cam.refusedUntil ? `left alone for ${Math.round((cam.refusedUntil - Date.now()) / 1000)} s` : '')
  check('dropped link: no "refused by the NVR" line, and no step towards the sub-stream', !out.some((l) => l.includes('[rec fake/11]') && /refused/.test(l)) && cam.pick.refusals === 0 && cam.wantType === 0, `${out.filter((l) => l.includes('[rec fake/11]')).join(' | ')} refusals ${cam.pick.refusals}`)
  check('dropped link: not counted towards "the NVR is refusing streams"', recentRefusals(streams.values(), Date.now()) === 0)

  // the SDK has the link back by the third start: it plays
  check('dropped link: playing again once the link is back', await advanceUntil(() => main.state === 'playing' && main.gotVideo, 120_000), `${main.state} ${JSON.stringify(starts())}`)
  const [s1, s2, s3] = starts()
  const gap1 = s2 ? s2.at - s1.at : NaN
  const gap2 = s3 ? s3.at - s2.at : NaN
  check('dropped link: tried again 15 s after the "not connected", and 60 s after the second: each within 60 s', starts().length === 3 && s2.code === 9 && s3.code === 0 && gap1 >= 15_000 && gap1 < 16_000 && gap2 >= 60_000 && gap2 < 61_000, `${gap1} ms, ${gap2} ms`)
  check('dropped link: recording again 75 s after the first "not connected", not 5-10 minutes', s3 && s3.at - s1.at < 77_000 && cam.stream === main && rec.flow()?.flowing === 1, `${s3 ? s3.at - s1.at : '-'} ms`)
  loop.disable()
  const delayMs = loop.max / 1e6 // (0: the loop's timer never fired late)
  check('dropped link: the main thread is never held 50 ms on the way (real time: event-loop delay, longest step)', delayMs < 50 && longestTurn < 50, `delay max ${delayMs.toFixed(1)} ms over ${loop.count} late samples, longest step ${longestTurn.toFixed(1)} ms, ${Math.round(performance.now() - realAt)} ms for ${Math.round((Date.now() - dropAt) / 1000)} s of fake time`)

  // value4u at its sub-stream limit: 8, "cannot connect", is still a refusal
  always.set(11, 8)
  rec.apply({ recording: { defaults: DEFAULTS, cameras: { 'fake/10': { mode: 'continuous' }, 'fake/11': { mode: 'continuous', stream: 'sub' } } }, locations: [] })
  const sub = streams.get('11:1')
  check('sub-stream limit (8): a refusal still (lastFailure fast), its code kept', (await advanceUntil(() => sub?.lastFailure != null, 5000)) && sub.lastFailure.fast === true && sub.lastFailure.code === 8, JSON.stringify(sub?.lastFailure))
  await advance(1000)
  const cam11 = rec.cams.get(11)
  const wait = cam11.refusedUntil - Date.now()
  check('sub-stream limit (8): the recorder lets go of it for 5-10 minutes', cam11.stream === null && !sub.clients.has(cam11.tap) && wait > 5 * 60_000 - 2000 && wait <= 10 * 60_000, `${Math.round(wait / 1000)} s`)
  const said = out.find((l) => l.includes('[rec fake/12] refused by the NVR') && /cannot connect/.test(l))
  check('sub-stream limit (8): and says so ("trying again in 300+ s")', Number(said?.match(/trying again in (\d+) s/)?.[1]) >= 298, said)
  await advance(4 * 60_000, 250)
  check('sub-stream limit (8): 4 minutes on, still left alone; the camera on the dropped link records', cam11.stream === null && Date.now() < cam11.refusedUntil && cam.stream === main && rec.flow()?.cameras === 1 && rec.flow()?.flowing === 1, JSON.stringify(rec.flow()))
  // sub-cap.mjs learns the limit from the same lastFailure: 8 counts, 9 never
  const cap = subCap({ now: () => Date.now() })
  const eight = { ...sub.lastFailure }
  cap.refused({ code: nine.code, fast: nine.fast, playing: 15 })
  cap.refused({ code: nine.code, fast: nine.fast, playing: 15 })
  const afterNine = cap.known()
  cap.refused({ code: eight.code, fast: eight.fast, playing: 15 })
  cap.refused({ code: eight.code, fast: eight.fast, playing: 15 })
  check('sub-cap: two code-8 refusals set the limit; two dropped-link failures set none', afterNine === null && cap.known() === 15, `${afterNine} ${cap.known()}`)

  clearInterval(recTick)
  clearInterval(stallCheck)
  await rec.stop()
  for (const s of streams.values()) s.stop()
  await advance(1000)
  for (const t of timers) clearInterval(t)
  mock.timers.reset()
}

rmSync(process.env.DATA_DIR, { recursive: true, force: true })
print(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
