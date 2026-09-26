// One NVR's live video in its own process (CCTV_LIVE_WORKER=on): its SDK, its lanes and its
// watchdog, so a slow or crashing NVR cannot hold up another NVR's video. Started by
// worker-supervisor.mjs with CCTV_WORKER_NVR=<nvr id>; the real Nvr and LiveStream classes do
// the work, and each wanted stream has one "tap" (a fake WebSocket) that forwards its frames
// to the parent, which fans them out to the viewers (stream-hub.mjs).
import { recentRefusals } from './nvr-health.mjs'
import { allowAllCloses } from './segment-writer.mjs'
import { MSG, frameMsg, streamKey } from './worker-ipc.mjs'

if (process.env.CCTV_WORKER_FAKE_SDK === '1') await import('./test/fake-sdk.mjs') // tests: replaces NET_SDK
const { Nvr, readConfig } = await import('./nvrs.mjs')
const { sdkStats } = await import('./sdk.mjs')
const { startWatchdog } = await import('./watchdog.mjs')
const { Recorder } = await import('./recorder.mjs')

const id = process.env.CCTV_WORKER_NVR
const cfg = readConfig().nvrs.find((n) => n?.id === id)
if (!cfg) {
  console.error(`[worker ${id}] no NVR ${id} in the config`)
  process.exit(2)
}

startWatchdog() // kills this worker only; the supervisor starts a new one
const nvr = new Nvr(cfg) // logs in by itself (the constructor connects)
const taps = new Map() // key -> { tap, stream, ch, type }
// server recording (settings from the parent; off until a camera's mode is not 'off'): its taps
// sit on the same main-stream LiveStream as the live tap, so both share one pull from the NVR
const recorder = new Recorder({
  nvrId: id,
  // the stream type is the recorder's choice now: it drops to the sub-stream for a camera the
  // NVR keeps refusing, rather than recording nothing at all (stream-choice.mjs)
  getStream: (ch, type = 0) => nvr.getStream(ch, type),
  online: () => nvr.userId >= 0 && nvr.online,
  channels: () => nvr.channels.map((c) => ({ ch: c.ch, online: c.online !== false })), // offline slots are not recorded
  send: (m) => process.connected && process.send(m)
})
// bytes not yet handed to the parent count as the tap's bufferedAmount. Over TAP_CAP the tap gets
// nothing (keyframes included) until it is below TAP_RESUME, then resumes on a keyframe
// (backpressure.mjs gateSend). A tap is never closed for being slow: stuckMs 0.
const TAP_CAP = 8 * 1024 * 1024
const TAP_RESUME = 1024 * 1024

/** A fake WebSocket for LiveStream: frames go to the parent; a slow parent makes it skip to the next keyframe. */
const tapFor = (key, background = false) => {
  let pending = 0
  return {
    // only warm-ups asked for it: a real viewer's stream starts ahead of it (live.mjs urgent())
    background,
    OPEN: 1,
    readyState: 1,
    capBytes: TAP_CAP,
    resumeBytes: TAP_RESUME,
    stuckMs: 0,
    get bufferedAmount() {
      return pending
    },
    send(buf) {
      if (!process.connected) return
      pending += buf.length
      process.send(frameMsg(key, buf, buf[0] === 1), () => (pending -= buf.length))
    },
    close() {} // LiveStream.fail(): the parent's viewers stay; the stream is asked for again below
  }
}

const attach = (key) => {
  const t = taps.get(key)
  if (!t || t.stream) return
  t.stream = nvr.getStream(t.ch, t.type)
  t.stream.add(t.tap)
}

// streams are started only while the NVR is logged in (a LivePlay before that only fails and
// backs off); after a relogin (LiveStream.fail dropped the taps) they are started again
let lastSentStatus = ''
setInterval(() => {
  // the main process learns of a login (or a drop) at once, not at the next 5 s stats
  if (nvr.status !== lastSentStatus) {
    lastSentStatus = nvr.status
    sendStats()
  }
  if (nvr.userId < 0 || !nvr.online) return
  for (const [key, t] of taps) {
    if (t.stream && (t.stream.stopped || !t.stream.clients.has(t.tap))) t.stream = null
    if (!t.stream) attach(key)
  }
  recorder.sync() // also picks up cameras found after login when the default mode records
}, 250).unref()

// streams that stop delivering video while the NVR session stays up are restarted here, like
// startNvrs() does in the main process (Nvr.checkStalled skips only the parent's worker proxy).
// Without this a stalled stream stayed silent until the NVR resumed it by itself: holes in the
// recordings of 10-190 s. checkStalled itself waits until the NVR is logged in.
const STALL_CHECK_MS = (process.env.CCTV_WORKER_FAKE_SDK === '1' && Number(process.env.CCTV_TEST_STALL_CHECK_MS)) || 5000
const stallTimer = setInterval(() => {
  nvr.checkStalled().catch((e) => console.warn(`[${id}] stall check: ${e.message}`))
}, STALL_CHECK_MS)
stallTimer.unref()

process.on('message', (m) => {
  if (m?.t === MSG.WANT) {
    const key = streamKey(m.ch, m.type)
    const had = taps.get(key)
    if (had) {
      if (!m.background) had.tap.background = false // a viewer now wants it too
      return
    }
    taps.set(key, { tap: tapFor(key, m.background === true), stream: null, ch: m.ch, type: m.type })
    if (nvr.userId >= 0 && nvr.online) attach(key)
  } else if (m?.t === MSG.UNWANT) {
    const key = streamKey(m.ch, m.type)
    const t = taps.get(key)
    taps.delete(key)
    if (t?.stream) {
      t.stream.remove(t.tap)
      // the parent already waited out the linger: stop now rather than linger twice
      if (t.stream.clients.size === 0) t.stream.stop()
    }
  } else if (m?.t === MSG.SETTINGS) {
    recorder.apply(m)
  } else if (m?.t === MSG.EVENTS) {
    // Which stretches each event-mode camera should be writing (phase 7, rec-modes.mjs). The
    // recorder falls back to recording continuously if these stop arriving.
    recorder.applyEvents(m)
  } else if (m?.t === MSG.RESTART) {
    nvr.streams.get(streamKey(m.ch, m.type))?.restart(String(m.why || 'restart asked'))
  } else if (m?.t === MSG.STOP) shutdown()
})
process.on('disconnect', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  clearInterval(stallTimer) // no restarts while the streams are being stopped
  // tests only (with the fake SDK): a worker that overstays its stop
  const slow = process.env.CCTV_WORKER_FAKE_SDK === '1' ? Number(process.env.CCTV_WORKER_TEST_SLOW_STOP_MS || 0) : 0
  if (slow) await new Promise((r) => setTimeout(r, slow))
  // closes (fsyncs) the open segments; their messages go out before the exit. A disk that does
  // not finish within 4 s: those files are picked up by the recovery scan at the next start
  allowAllCloses()
  await Promise.race([recorder.stop(), new Promise((r) => setTimeout(r, 4000))])
  await new Promise((r) => setImmediate(r))
  // a clean logout is nice but must not hang; SIGKILL avoids exit() waiting on stuck SDK threads
  await Promise.race([nvr.stop().catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
  process.kill(process.pid, 'SIGKILL')
}

process.send?.({ t: MSG.READY })
// (channels: the worker polls the camera list; the main process uses this one, nvrs.mjs workerStats)
// refusals: the streams live in THIS process, so the main process cannot count them itself; without
// this number the Health page's "refused" column and the nvr-refusing alert are both dead letters.
const sendStats = () => process.connected && process.send({ t: MSG.STATS, status: nvr.status, error: nvr.error, streams: nvr.streams.size, refusals: recentRefusals(nvr.streams.values(), Date.now()), channels: nvr.channels, codecSeen: Object.fromEntries(nvr.codecSeen), sdk: sdkStats(), rec: recorder.status() })
setInterval(sendStats, 5000).unref()
