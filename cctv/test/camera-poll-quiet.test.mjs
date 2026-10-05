// The camera-list poll (nvrs.mjs #refresh, GetDeviceIPCInfo) asks the NVR only when something may
// have changed. It went out every 30 s from every NVR worker: about 600 of the workers' ~850 SDK
// calls an hour (27-29 Sep), and 40 of them, mostly sent to an NVR that had already stopped
// answering, came back late and held its new streams for 60 s (40 of 141 cool-downs; perf nvr.md P4).
// Now, as an NVR worker runs it (CCTV_WORKER_NVR set) with real LiveStreams over the fake SDK:
// - nothing plays (nothing tells of a camera dropping off): a read every turn, as before;
// - every stream delivers video and the list has not changed for 20 turns: a read every 4 turns;
// - a stream with no video (a camera dropping off): read at the next turn, and every turn for 20
//   turns after the list changed (a rebooting camera is seen back at once);
// - at least 3 streams, and at least half, with no video (the NVR froze): not read at all;
// - the NVR cooling down after a late call: not read (as before);
// - a read that comes back late does not start a cool-down (background), though it counts as late
//   while it is inside the SDK;
// - an hourly line says how often the list was read and why not.
// Turns are CCTV_TEST_REFRESH_MS (200 ms, 30 s in service) +-20%; "no video" is CCTV_TEST_SILENT_MS
// (150 ms, 3 s in service). Fake SDK (test/fake-sdk.mjs), *.invalid hosts: nothing reaches an NVR.
// Needs the Linux SDK library (sdk.mjs loads it through koffi): run on a server copy.
//   node cctv/test/camera-poll-quiet.test.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

const DATA = mkdtempSync(join(tmpdir(), 'poll-quiet-'))
process.env.DATA_DIR = DATA
process.env.UV_THREADPOOL_SIZE = '64'
process.env.SDK_COOL_MS = '1500' // a late call's cool-down (60 s in service)
process.env.CCTV_WORKER_FAKE_SDK = '1'
process.env.CCTV_WORKER_NVR = 'q1' // as in the NVR's worker (its lanes and pacing)
process.env.CCTV_TEST_REFRESH_MS = '200'
process.env.CCTV_TEST_SILENT_MS = '150'
await import('./fake-sdk.mjs')
const koffi = (await import('koffi')).default
const { IPC_INFO, NET_SDK, lateCalls, liveFrames, nvrCooling, sdkCallT, sdkStats } = await import('../sdk.mjs')
const { Nvr } = await import('../nvrs.mjs')

const print = console.log.bind(console)
const logs = []
console.log = (...a) => logs.push(a.join(' '))
console.warn = (...a) => logs.push(a.join(' '))
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  print(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const until = async (cond, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (cond()) return true
  return cond()
}
const loop = monitorEventLoopDelay({ resolution: 10 })
loop.enable()

// ---- the NVR's camera list: four cameras, answered after ipcDelayMs ----------------------------------
const cams = [0, 1, 2, 3].map((ch) => ({ ch, name: `Cam ${ch + 1}`, online: true, ip: `10.0.0.${10 + ch}`, model: 'IPC-T1' }))
const reads = [] // when each GetDeviceIPCInfo went out
const answers = [] // when each came back from the (fake) SDK
let ipcDelayMs = 5
const zeros = (n) => new Array(n).fill(0)
NET_SDK.GetDeviceIPCInfo.async = (_userId, buf, _len, count, cb) => {
  reads.push(Date.now())
  const size = koffi.sizeof(IPC_INFO)
  cams.forEach((c, i) => {
    koffi.encode(buf, i * size, IPC_INFO, {
      deviceID: 0, channel: c.ch, guid: zeros(48), status: c.online ? 1 : 0, szEtherName: '', szServer: c.ip, nPort: 9008, nHttpPort: 80,
      nCtrlPort: 0, szID: '', username: '', manufacturerId: 0, manufacturerName: 'TVT', productModel: c.model, bUseDefaultCfg: 0,
      bPOEDevice: 0, resv: zeros(2), szChlname: c.name
    })
  })
  count.writeBigInt64LE(BigInt(cams.length))
  const delay = ipcDelayMs
  setTimeout(() => {
    answers.push(Date.now())
    cb(null, true)
  }, delay)
}
const readsIn = async (ms) => {
  const n = reads.length
  await sleep(ms)
  return reads.length - n
}

const nvr = new Nvr({ id: 'q1', site: 'T', name: 'Q1', host: 'q1.invalid', port: 6036, user: 'u', password: 'p' })
check('logs in and reads the four cameras', await until(() => nvr.online && nvr.channels.length === 4, 6000), `${nvr.channels.length} cameras`)

// ---- 1. nothing plays: nothing tells of a camera dropping off, so every turn reads -------------------
{
  const n = await readsIn(2000)
  check('no streams: a read every turn, as before (about 10 in 2 s)', n >= 7, `${n} reads`)
}

// ---- 2. four recorded sub-streams deliver video, the list unchanged: a read every 4 turns ----------------
const tapOf = () => ({ recorder: true, OPEN: 1, readyState: 1, bufferedAmount: 0, capBytes: 8 << 20, stuckMs: 0, send() {}, close() {} })
const taps = new Map()
const play = (ch) => {
  const s = nvr.getStream(ch, 1)
  const tap = tapOf()
  taps.set(ch, tap)
  s.add(tap)
  return s
}
const streams = [0, 1, 2, 3].map(play)
check('the four streams play and deliver video', await until(() => streams.every((s) => s.state === 'playing' && s.gotVideo), 5000), streams.map((s) => s.state).join())
const freeze = (s) => liveFrames.release(s.handle) // the NVR stops sending while the stream stays open
const thaw = (s) => liveFrames.claim(s.handle, s.onFrame)
await sleep(300)
{
  const n = await readsIn(4000)
  // 20 turns: 20 reads before; now the first turn 800 ms or more after the last read
  check('all streams flowing: a read about every 4 turns (4-5 in 4 s, 20 before)', n >= 2 && n <= 6, `${n} reads`)
}

// ---- 3. a camera drops off: its stream tells at once, and the list is read every turn for a while ---------
{
  const n0 = reads.length
  await until(() => reads.length > n0, 3000) // just after a read: the next quiet one is 800 ms or more away
  const t0 = Date.now()
  cams[1].online = false
  freeze(streams[1])
  const seen = await until(() => nvr.channels.find((c) => c.ch === 1)?.online === false, 3000)
  const took = Date.now() - t0
  check('a camera drops off: its silent stream brings the read forward (seen offline in under 750 ms, not the quiet 800+)', seen && took < 750, `${took} ms`)
  // the recorder lets go of an offline camera: its stream stops (recorder.mjs sync)
  streams[1].remove(taps.get(1))
  await streams[1].stop()
  const n = await readsIn(1500)
  check('... the list changed: the three that still flow do not slow it down (a read every turn, about 7 in 1.5 s)', n >= 5, `${n} reads`)
  const t1 = Date.now()
  cams[1].online = true
  const back = await until(() => nvr.channels.find((c) => c.ch === 1)?.online === true, 3000)
  check('... the camera comes back: seen at the next turn (under 500 ms)', back && Date.now() - t1 < 500, `${Date.now() - t1} ms`)
  streams[1] = play(1)
  check('... its stream plays again', await until(() => streams[1].state === 'playing' && streams[1].gotVideo, 5000))
  await sleep(4300) // 20 turns after the last change
  const q = await readsIn(2000)
  check('... 20 turns after the last change: every 4 turns again (2-3 in 2 s)', q >= 1 && q <= 3, `${q} reads`)
}

// ---- 4. the NVR freezes: most of its streams silent at once; not read at all -----------------------------
{
  for (const s of streams.slice(0, 3)) freeze(s)
  await sleep(200) // silent for 150 ms
  const n = await readsIn(2000)
  check('3 of 4 streams silent (the NVR froze): not read at all (about 10 before)', n === 0, `${n} reads`)
  for (const s of streams.slice(0, 3)) thaw(s)
  await sleep(200)
  freeze(streams[0])
  freeze(streams[1])
  await sleep(200)
  const m = await readsIn(1000)
  check('2 of 4 silent (fewer than 3): the cameras, not the NVR; read every turn (about 5 in 1 s)', m >= 3, `${m} reads`)
  thaw(streams[0])
  thaw(streams[1])
  await sleep(300)
}

// ---- 5. the NVR cools down after a late call: not read (as before) -----------------------------------------
{
  const slow = { cName: 'NET_SDK_TestSlow', async: (...a) => setTimeout(() => a.at(-1)(null, true), 150) }
  await sdkCallT({ nvr: 'q1', tag: 'a late call', timeoutMs: 50 }, slow).catch(() => {})
  await until(() => lateCalls('q1') === 0, 1000)
  check('a call back late: the NVR cools down', nvrCooling('q1'))
  freeze(streams[3]) // a silent stream would ask for a read at once
  await sleep(200)
  const n = await readsIn(1000)
  check('... not read while it cools down, whatever the streams say', n === 0, `${n} reads`)
  check('... reads again once it has cooled down', await until(() => !nvrCooling('q1'), 2000) && (await readsIn(600)) >= 1)
  thaw(streams[3])
  await sleep(300)
}

// ---- 6. a routine read that comes back late: counted late while inside, but no cool-down after --------------
{
  ipcDelayMs = 12_300 // GetDeviceIPCInfo's limit is 12 s
  const n0 = reads.length
  const a0 = answers.length
  freeze(streams[2]) // a silent stream: read at the next turn
  check('a slow read goes out', await until(() => reads.length === n0 + 1, 2000))
  const sentAt = reads[n0]
  thaw(streams[2])
  const entry = () => sdkStats().calls.find((c) => c.name === 'NET_SDK_GetDeviceIPCInfo')
  check('... it is background work (nobody waits on it)', entry()?.background === true, JSON.stringify(entry() ?? null))
  check('... past its limit it counts as late (the lane holds, the NVR reads as cooling)', await until(() => lateCalls('q1') === 1, 13_000) && nvrCooling('q1'))
  ipcDelayMs = 5
  check('... it comes back', await until(() => answers.length > a0 && lateCalls('q1') === 0, 2000))
  const backAt = answers[a0]
  await sleep(50)
  check('... and starts no cool-down: new streams are not held on its account', nvrCooling('q1') === false && !logs.some((l) => /GetDeviceIPCInfo.*came back .* late/.test(l)), logs.filter((l) => /late/.test(l)).join(' | '))
  const meanwhile = reads.filter((t) => t > sentAt && t < backAt).length
  check('... no other read went out while it was inside the SDK', meanwhile === 0, `${meanwhile}`)
}

// ---- 7. the hourly line (120 turns: 24 s here) ------------------------------------------------------------------
{
  const line = () => logs.find((l) => /^\[q1\] camera list read \d+ times in the last hour/.test(l))
  check('an hourly line: how often the list was read, and why not', await until(() => Boolean(line()), 8000), line())
  const m = /read (\d+) times in the last hour.*not read at (\d+) turns \(all streams flowing (\d+), NVR frozen (\d+), cooling down or busy (\d+)\)/.exec(line() ?? '')
  check('... with each reason counted', Boolean(m) && Number(m[1]) > 0 && Number(m[3]) > 0 && Number(m[4]) > 0 && Number(m[5]) > 0 && Number(m[2]) === Number(m[3]) + Number(m[4]) + Number(m[5]), line())
}

// ---- the main thread: nothing here blocks ----------------------------------------------------------------------
loop.disable()
check('event loop: the longest delay over the whole run under 50 ms', loop.max / 1e6 < 50, `max ${(loop.max / 1e6).toFixed(1)} ms, mean ${(loop.mean / 1e6).toFixed(2)} ms`)

for (const s of streams) s.remove(taps.get(s.ch))
await nvr.stop()
rmSync(DATA, { recursive: true, force: true })
print(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
