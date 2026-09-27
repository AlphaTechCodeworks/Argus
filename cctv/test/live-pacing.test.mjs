// Real LiveStreams in an NVR worker (CCTV_WORKER_NVR set) over fake SDK functions and a fake NVR
// object: viewers' starts are paced (live-pacer.mjs: 250 ms apart on a quick NVR, never more than 2
// live calls in flight), the recorder's start is not; streams nobody wants are stopped through the
// idle-stop queue (idle-stops.mjs: at least 1 s apart, never next to another live call, dropped when
// wanted again), while a restart's stop goes at once. A LivePlay that comes back slow counts before
// the next start is let go; after the NVR dropped its links viewers' starts wait out the hold.
// Nothing here reaches an NVR.
// Needs the SDK module (Linux):  node cctv/test/live-pacing.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'pacing-'))
process.env.CCTV_WORKER_NVR = 'p1' // as in an NVR worker: live.mjs paces viewers' starts
process.env.CCTV_WORKER_FAKE_SDK = '1'
process.env.CCTV_TEST_FIRST_FRAME_MS = '60000' // (the fake streams send no video)
process.env.CCTV_SUB_LINGER_S = '0' // a sub nobody watches is unwanted at once
const { NET_SDK } = await import('../sdk.mjs')
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
  for (const end = Date.now() + maxMs; Date.now() < end; await sleep(20)) if (cond()) return true
  return cond()
}

// ---- fake SDK: LivePlay takes 100 ms, StopLivePlay 30 ms; every call is logged with its start and end
const log = [] // { fn, ch, at, end }
const handleCh = new Map()
let nextHandle = 900
let live = 0 // live calls inside the fake SDK now
let maxLive = 0
const LIVE_MS = { LivePlay: 100, StopLivePlay: 30 }
const PLAY_MS = new Map() // ch -> how long that channel's LivePlay takes instead
for (const name of Object.keys(NET_SDK)) {
  NET_SDK[name] = {
    fake: true,
    cName: `NET_SDK_${name}`, // (so sdk.mjs counts them as live calls, with their real time limits)
    async(...args) {
      const cb = args.at(-1)
      const entry = { fn: name, ch: null, at: Date.now(), end: 0 }
      let result = true
      if (name === 'LivePlay') {
        result = nextHandle++
        entry.ch = args[1].lChannel
        handleCh.set(result, entry.ch)
      } else if (name === 'StopLivePlay') entry.ch = handleCh.get(args[0])
      else if (name === 'GetLastError') result = 0
      const ms = (name === 'LivePlay' && PLAY_MS.get(entry.ch)) || (LIVE_MS[name] ?? 5)
      if (LIVE_MS[name]) {
        log.push(entry)
        maxLive = Math.max(maxLive, ++live)
      }
      setTimeout(() => {
        if (LIVE_MS[name]) live--
        entry.end = Date.now()
        cb(null, result)
      }, ms)
    }
  }
}
if (!Object.values(NET_SDK).every((f) => f.fake)) throw new Error('the SDK is not fully faked: not running')

const { LiveStream, linkReset } = await import('../live.mjs')
const { PACE } = await import('../live-pacer.mjs')
const streams = new Map()
const nvr = {
  id: 'p1',
  userId: 3,
  lane: new Lane('p1', 2, { holdAt: 1 }),
  liveFailed: () => Promise.resolve(),
  liveStarted() {},
  streamStopped(s) {
    if (streams.get(s.key) === s) streams.delete(s.key)
  },
  noteCodec() {}
}
const get = (ch) => {
  const key = `${ch}:1`
  if (!streams.has(key)) streams.set(key, new LiveStream(nvr, ch, 1))
  return streams.get(key)
}
const viewer = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, send() {}, close() {} })
const recTap = () => ({ ...viewer(), recorder: true, background: true })
const plays = () => log.filter((c) => c.fn === 'LivePlay')
const stops = () => log.filter((c) => c.fn === 'StopLivePlay')

// ---- viewers' starts are paced; the recorder's is not
const viewers = new Map()
for (let ch = 0; ch < 6; ch++) {
  const v = viewer()
  viewers.set(ch, v)
  get(ch).add(v)
}
await sleep(300)
get(10).add(recTap()) // the recorder comes for a camera while viewers' starts still wait
check('all 6 viewers’ streams and the recorder’s start', await until(() => plays().length === 7, 5000), `${plays().length} LivePlay`)
const viewerPlays = plays().filter((c) => c.ch !== 10)
const gaps = viewerPlays.slice(1).map((c, i) => c.at - viewerPlays[i].at)
check('viewers’ LivePlays at least 250 ms apart (the last took 100 ms)', gaps.every((g) => g >= 240), gaps.join())
check('never more than 2 live calls in the SDK at once', maxLive <= 2, String(maxLive))
const recAt = plays().findIndex((c) => c.ch === 10)
check('the recorder’s start is not paced: it goes ahead of the viewers still waiting', recAt >= 0 && recAt < 6 && plays()[recAt].at - viewerPlays[0].at < 5 * 250, `${recAt}th, ${plays()[recAt]?.at - viewerPlays[0].at} ms after the first`)
check('every stream plays', await until(() => [...streams.values()].every((s) => s.state === 'playing'), 2000))

// ---- streams nobody wants: stopped through the idle-stop queue
await sleep(1200) // (the last LivePlay back well before)
const t0 = Date.now()
for (const ch of [0, 1, 2, 3]) get(ch).remove(viewers.get(ch))
await sleep(200)
get(2).add(viewers.get(2)) // wanted again before its turn
check('four unwanted: the first stop goes at once', await until(() => stops().length >= 1, 500) && stops()[0].at - t0 < 150, `${stops()[0]?.at - t0} ms`)
await until(() => stops().length >= 3, 6000)
await sleep(1500)
const idle = stops()
const idleGaps = idle.slice(1).map((c, i) => c.at - idle[i].end)
check('... three stops: the one wanted again is not stopped', idle.length === 3 && !idle.some((c) => c.ch === 2) && streams.get('2:1')?.state === 'playing', idle.map((c) => c.ch).join())
check('... each at least 1 s after the previous one returned', idleGaps.every((g) => g >= 990), idleGaps.join())
const overlaps = idle.filter((s) => plays().some((p) => p.at < s.end && (p.end || Infinity) > s.at))
check('... none next to a LivePlay', overlaps.length === 0)

// ---- a restart's stop goes at once, not through the idle queue
for (const ch of [4, 5]) get(ch).remove(viewers.get(ch)) // two more idle stops: one now, one in 1 s
await until(() => stops().length === 4, 1000)
const before = stops().length
const r0 = Date.now()
get(10).restart('test: no video')
check('a restart’s stop goes at once while idle stops wait', await until(() => stops().length === before + 1, 400) && stops().at(-1).ch === 10 && stops().at(-1).at - r0 < 150, `${stops().at(-1)?.ch} after ${stops().at(-1)?.at - r0} ms`)
check('... and the idle stop still comes, spaced', await until(() => stops().filter((c) => c.ch === 5 || c.ch === 4).length === 2, 3000))

// ---- a LivePlay that comes back slow while another is still in flight: the pacer knows the NVR is
// slow before that start lets go of its turn, so no further start goes next to the one in flight
// (03:51:54: two sub LivePlays on a struggling nvr1; one came back after 78 s, the other never)
for (const s of [...streams.values()]) s.stop()
await sleep(1500)
const at = (ch) => plays().find((c) => c.ch === ch)
/** Channel a's LivePlay started once channel b's had returned (not while it was still in flight). */
const wentAfter = (a, b) => at(b)?.end > 0 && at(a).at >= at(b).end
{
  PLAY_MS.set(20, 3500) // (over 3 s: the NVR is slow now)
  PLAY_MS.set(21, 6000)
  for (const ch of [20, 21, 22]) get(ch).add(viewer())
  check('slow: the first two viewers’ starts go (the NVR answered quickly so far)', (await until(() => at(20) && at(21), 2000)) && at(21).at - at(20).at < 1000 && !at(22), `${at(21)?.at - at(20)?.at} ms apart`)
  await until(() => at(20).end > 0, 5000)
  await sleep(300)
  check('slow: one back after 3.5 s, one still in flight: no third start next to it', !at(22) || wentAfter(22, 21), `22 went ${at(22) ? at(22).at - at(20).end : '-'} ms after 20 was back; 21 ${at(21).end ? 'back' : 'still in flight'}`)
  check('... it goes once the one in flight is back', (await until(() => at(22) && at(21).end > 0, 10_000)) && wentAfter(22, 21), `${at(22)?.at - at(21)?.end} ms after`)
}
for (const s of [...streams.values()]) s.stop()
await sleep(1500)
{
  // the same with the recorder's LivePlay the one still in flight (it is not paced, but counts): the
  // returning call wakes the pacer only once its start has told it how long it took
  PLAY_MS.set(23, 3500)
  PLAY_MS.set(24, 6000)
  get(26).add(viewer()) // a quick one first: the NVR answers quickly again, whatever came before
  await until(() => at(26)?.end > 0, 10_000)
  get(23).add(viewer())
  await until(() => at(23), 1000)
  get(24).add(recTap())
  await until(() => at(24), 1000)
  get(25).add(viewer())
  await until(() => at(23).end > 0, 5000)
  await sleep(300)
  check('slow: the recorder’s LivePlay in flight, a viewer’s back after 3.5 s: no viewer start next to it', at(24) && (!at(25) || wentAfter(25, 24)), `25 went ${at(25) ? at(25).at - at(23).end : '-'} ms after 23 was back; 24 ${at(24)?.end ? 'back' : 'still in flight'}`)
  check('... it goes once the recorder’s is back', (await until(() => at(25) && at(24).end > 0, 10_000)) && wentAfter(25, 24), `${at(25)?.at - at(24)?.end} ms after`)
}
for (const s of [...streams.values()]) s.stop()
await sleep(1500)
{
  // the NVR dropped its links (MSG.LINKRESET from the supervisor): viewers' new starts wait out the
  // hold (60 s; 1.5 s here), the recorder's go at once
  PACE.RESET_HOLD_MS = 1500
  const t0 = Date.now()
  linkReset('p1')
  get(30).add(viewer())
  get(31).add(recTap())
  check('link reset: the recorder’s start goes at once', (await until(() => at(31), 1000)) && at(31).at - t0 < 500, `${at(31)?.at - t0} ms`)
  check('... a viewer’s waits out the hold', (await until(() => at(30), 5000)) && at(30).at - t0 >= 1450, `${at(30)?.at - t0} ms`)
  check('... and the worker says so', out.filter((l) => l.includes('p1') && l.includes('dropped its links')).length === 1, out.filter((l) => l.includes('dropped')).join(' | '))
}

for (const s of [...streams.values()]) s.stop()
await sleep(100)
if (failures) print(`\napp log:\n${out.join('\n')}`)
print(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
