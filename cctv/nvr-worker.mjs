// One NVR's live video in its own process (CCTV_LIVE_WORKER=on): its SDK, its lanes and its
// watchdog, so a slow or crashing NVR cannot hold up another NVR's video. Started by
// worker-supervisor.mjs with CCTV_WORKER_NVR=<nvr id>; the real Nvr and LiveStream classes do
// the work, and each wanted stream has one "tap" (a fake WebSocket) that forwards its frames
// to the parent, which fans them out to the viewers (stream-hub.mjs).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './auth.mjs'
import { loopWorstMs } from './loop-lag.mjs'
import { recentRefusals } from './nvr-health.mjs'
import { memoryNow } from './proc-memory.mjs'
import { allowAllCloses } from './segment-writer.mjs'
import { LIMIT_ERROR, subCap } from './sub-cap.mjs'
import { MSG, frameMsg, streamKey } from './worker-ipc.mjs'

if (process.env.CCTV_WORKER_FAKE_SDK === '1') await import('./test/fake-sdk.mjs') // tests: replaces NET_SDK
const { Nvr, readConfig } = await import('./nvrs.mjs')
const { refuseNewCalls, sdkStats } = await import('./sdk.mjs')
const { spareWhile, startWatchdog } = await import('./watchdog.mjs')
const { Recorder } = await import('./recorder.mjs')
const { linkReset } = await import('./live.mjs')

const id = process.env.CCTV_WORKER_NVR
const cfg = readConfig().nvrs.find((n) => n?.id === id)
if (!cfg) {
  console.error(`[worker ${id}] no NVR ${id} in the config`)
  process.exit(2)
}

startWatchdog() // kills this worker only; the supervisor starts a new one
const nvr = new Nvr(cfg) // logs in by itself (the constructor connects)
const taps = new Map() // key -> { tap, stream, ch, type }
let stopping = false // shutdown() has begun
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
// this worker's watchdog judges a stuck call by the recording: longer while its video flows, less
// once it has frozen (watchdog.mjs)
spareWhile(() => recorder.flow())
// bytes not yet handed to the parent count as the tap's bufferedAmount. Over TAP_CAP the tap gets
// nothing (keyframes included) until it is below TAP_RESUME, then resumes on a keyframe
// (backpressure.mjs gateSend). A tap is never closed for being slow: stuckMs 0.
const TAP_CAP = 8 * 1024 * 1024
const TAP_RESUME = 1024 * 1024

/** A fake WebSocket for LiveStream: frames go to the parent; a slow parent makes it skip to the next keyframe. */
const tapFor = (key, background = false) => {
  let pending = 0
  return {
    // only warm-ups (or the sub-bridge) asked for it: a real viewer's stream starts ahead of it (live.mjs rank())
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

// A background WANT for a MAIN stream comes only from the sub-bridge (sub-bridge.mjs: a cold sub
// tile shows the camera's main meanwhile; warm-ups ask for subs only). It must never make this
// worker start a main stream: for a camera recorded on its sub that was a LivePlay, and a
// StopLivePlay 10 s later, per tile, on the NVRs that refuse those mains anyway (they started 8 of
// the 21 cool-downs on 09-27). So such a tap only joins a main stream that is already playing --
// the recorder's own pull, no SDK call -- and is parked until then; the 250 ms loop below attaches
// it once that stream plays. A parked tap never creates a LiveStream.
const bridgeOnly = (t) => t.type === 0 && t.tap.background === true
const parked = (t) => bridgeOnly(t) && nvr.streams.get(streamKey(t.ch, t.type))?.state !== 'playing'

// Sub-streams at the NVR's limit (sub-cap.mjs): value4u plays 15 at once and refuses the rest. Once
// the limit is known, a sub-stream tap whose stream is not playing yet starts only while there is
// room: a viewer's up to the limit, a warm-up's (or a lingering stream's: stream-hub.mjs tells those
// as background) VIEWER_ROOM below it, so a viewer's tile still starts at once. The others wait here,
// "held", and the parent shows a held viewer's tile the camera's main stream meanwhile (nvrs.mjs
// subHeld, sub-bridge.mjs). A held viewer takes the place of a playing warm-up, one at a time, and a
// refused stream that only a held-back tap wants is let go instead of asked for every minute. The
// recorder's sub-streams keep their places through their restarts: viewers never take them.
const VIEWER_ROOM = 2
const CAP_FILE = join(DATA_DIR, `sub-cap-${id}.json`) // so a restart does not learn it again with refusals
const CAP_SAVE_EVERY_MS = 60 * 60_000 // a confirmed limit is written again this often (its time moves on)
const readSavedCap = () => {
  try {
    return JSON.parse(readFileSync(CAP_FILE, 'utf8'))
  } catch {
    return null
  }
}
const cap = subCap({ saved: readSavedCap() })
let capSavedAt = 0
let capSavedLimit = cap.known()
const saveCap = (force) => {
  if (!force && Date.now() - capSavedAt < CAP_SAVE_EVERY_MS) return
  capSavedAt = Date.now()
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(`${CAP_FILE}.tmp`, `${JSON.stringify(cap.toJSON())}\n`)
    renameSync(`${CAP_FILE}.tmp`, CAP_FILE)
  } catch (e) {
    console.warn(`[${id}] ${CAP_FILE} not written: ${e.message}`)
  }
}
const capChanged = () => {
  const limit = cap.known()
  if (limit === capSavedLimit) return saveCap(false)
  capSavedLimit = limit
  console.log(`[${id}] the NVR plays at most ${limit} sub-streams at once: viewers' tiles beyond that are shown the main stream until there is room`)
  saveCap(true)
}
const subs = () => [...nvr.streams.values()].filter((s) => s.streamType === 1 && !s.stopped)
// sub-streams let go for a held viewer (makeRoom): they keep their place at the NVR until their
// StopLivePlay has returned, so the viewer's LivePlay does not land on a place still taken
const freeing = new Set()
/** Restarting, and coming back for its place: after a stall, not after a refusal at the limit. */
const comingBack = (s) => s.state === 'restarting' && s.clients.size > 0 && !(s.lastFailure?.code === LIMIT_ERROR && s.lastFailure.at > s.playingSince)
/**
 * Sub-streams that take one of the NVR's places: playing or on their way there, restarting ones that
 * will ask for theirs back, and the recorder's in any state -- a viewer never takes the place of a
 * recording that restarts (a549c21): its restart would be refused and the camera left unrecorded for
 * 5-10 minutes. (Refused, the recorder lets go of it at its next tick, and then it counts no more.)
 */
const holding = (except) => freeing.size + subs().filter((s) => s !== except && (s.recorded || s.state === 'playing' || s.state === 'starting' || comingBack(s))).length
const room = (t) => {
  const limit = cap.limit()
  return limit === Infinity ? Infinity : (t.tap.background ? limit - VIEWER_ROOM : limit)
}
// a start refused at the limit (live.mjs lastFailure.code), counted with the others playing then
// (those being let go still hold their places)
nvr.onLiveFailed = (s) => {
  if (s.streamType !== 1) return
  const playing = subs().filter((o) => o !== s && o.state === 'playing').length + freeing.size
  const f = s.lastFailure
  if (f && cap.refused({ code: f.code, fast: f.fast, playing })) capChanged()
  else if (f?.code === LIMIT_ERROR && cap.known() !== null) saveCap(false)
}

/** A sub-stream tap that has to wait for room at the NVR's limit. Joining a stream that plays costs nothing. */
const capHeld = (t) => {
  if (t.type !== 1 || cap.limit() === Infinity) return false
  const s = nvr.streams.get(streamKey(t.ch, 1))
  if (s && !s.stopped && (s.recorded || s.state === 'playing')) return false
  return holding(s) >= room(t)
}

/** A sub-stream the NVR refused at its limit, still asked for again and again for this tap alone. */
const refusedAtLimit = (t) => {
  const s = t.stream
  const f = s.lastFailure
  if (t.type !== 1 || s.state !== 'restarting' || s.recorded || f?.code !== LIMIT_ERROR || !(f.at > s.playingSince)) return false
  return holding(s) >= room(t)
}

const attach = (key) => {
  const t = taps.get(key)
  if (!t || t.stream || parked(t)) return
  if (capHeld(t)) {
    t.held = true
    return
  }
  t.held = false
  t.stream = nvr.getStream(t.ch, t.type)
  t.stream.add(t.tap)
}

/** The tap lets go of its stream; with nobody else on it, the stream stops (idle-stops.mjs pacing). */
const detach = (t) => {
  const s = t.stream
  t.stream = null
  if (!s) return
  s.remove(t.tap)
  // the parent already waited out the linger: stop now rather than linger twice
  if (s.clients.size === 0) s.stopWhenIdle()
}

/** A refused sub-stream let go at the NVR's limit: it holds no handle, so it stops at once (no SDK call, no more retries). */
const letGo = (t) => {
  const s = t.stream
  detach(t)
  t.held = true
  if (s.clients.size === 0 && !(s.handle > 0) && !s.nativeStarting) s.stop()
}

/**
 * A held viewer's sub-stream takes the place of a playing warm-up's (or a lingering one's), one at a
 * time. It is stopped here, not through the idle-stop queue, and its place counts as taken until
 * its StopLivePlay has returned (freeing): only then does the viewer's start go out.
 */
const makeRoom = () => {
  if (cap.limit() === Infinity || freeing.size > 0) return
  if (![...taps.values()].some((t) => t.type === 1 && t.held && !t.stream && !t.tap.background)) return
  const warm = [...taps.values()].find((t) => t.type === 1 && t.tap.background && t.stream?.state === 'playing' && !t.stream.recorded && t.stream.clients.size === 1)
  if (!warm) return
  const s = warm.stream
  detach(warm) // (queues an idle stop, which stop() below takes back)
  warm.held = true
  freeing.add(s)
  s.stop().finally(() => freeing.delete(s))
}

/** Viewers' sub-stream taps held at the limit: the parent shows those tiles the main stream. */
const heldNow = () => [...taps.values()].filter((t) => t.type === 1 && t.held && !t.stream && !t.tap.background).map((t) => t.ch).sort((a, b) => a - b)
/** Every sub-stream tap held (warm-ups and lingering ones too): the worker sends the parent nothing more for them. */
const parkedNow = () => [...taps.values()].filter((t) => t.type === 1 && t.held && !t.stream).map((t) => t.ch).sort((a, b) => a - b)
/** At the limit: a viewer's new sub-stream would be held (the parent treats a cold tile as held at once). */
const fullNow = () => cap.limit() !== Infinity && holding() >= cap.limit()
let heldSent = ''

// streams are started only while the NVR is logged in (a LivePlay before that only fails and
// backs off); after a relogin (LiveStream.fail dropped the taps) they are started again
let lastSentStatus = ''
const loop = setInterval(() => {
  // the main process learns of a login (or a drop) at once, not at the next 5 s stats
  if (nvr.status !== lastSentStatus) {
    lastSentStatus = nvr.status
    sendStats()
  }
  if (nvr.userId < 0 || !nvr.online) return
  // more sub-streams playing than the limit said (the recorder's own go past it): it was higher
  if (cap.playing(subs().filter((s) => s.state === 'playing').length)) capChanged()
  for (const [key, t] of taps) {
    if (t.stream && (t.stream.stopped || !t.stream.clients.has(t.tap))) t.stream = null
    // nor does the bridge's tap keep a main stream going by itself once it stops playing (the
    // recorder let go of a refused main, which would go on restarting for the bridge alone)
    if (t.stream && bridgeOnly(t) && t.stream.state !== 'playing' && t.stream.clients.size === 1) detach(t)
    // refused at the NVR's limit: held until there is room, not asked for again every minute
    if (t.stream && refusedAtLimit(t)) letGo(t)
    if (!t.stream) attach(key)
  }
  makeRoom()
  const held = `${heldNow().join(',')}|${parkedNow().join(',')}|${fullNow()}`
  if (held !== heldSent) {
    heldSent = held
    sendStats() // the parent's tiles for these go to the main stream now, not at the next 5 s stats
  }
  recorder.sync() // also picks up cameras found after login when the default mode records
}, 250)
loop.unref()

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
  // stopping: nothing is started, stopped, re-created or restarted any more (see shutdown)
  if (stopping) return
  if (m?.t === MSG.WANT) {
    const key = streamKey(m.ch, m.type)
    const had = taps.get(key)
    if (had) {
      had.tap.background = m.background === true // a viewer wants it now, or only warm-ups again
      // a viewer now wants a main the bridge's tap was parked on: it starts at once
      if (!had.stream && nvr.userId >= 0 && nvr.online) attach(key)
      return
    }
    taps.set(key, { tap: tapFor(key, m.background === true), stream: null, ch: m.ch, type: m.type })
    if (nvr.userId >= 0 && nvr.online) attach(key)
  } else if (m?.t === MSG.UNWANT) {
    const key = streamKey(m.ch, m.type)
    const t = taps.get(key)
    taps.delete(key)
    if (t) detach(t)
  } else if (m?.t === MSG.SETTINGS) {
    recorder.apply(m)
  } else if (m?.t === MSG.EVENTS) {
    // Which stretches each event-mode camera should be writing (phase 7, rec-modes.mjs). The
    // recorder falls back to recording continuously if these stop arriving.
    recorder.applyEvents(m)
  } else if (m?.t === MSG.RESTART) {
    nvr.streams.get(streamKey(m.ch, m.type))?.restart(String(m.why || 'restart asked'))
  } else if (m?.t === MSG.LINKRESET) {
    // the SDK printed that the NVR dropped this worker's links (worker-supervisor.mjs): viewers' new
    // streams wait while it reconnects them (live-pacer.mjs); the recorder's do not
    linkReset(id)
  } else if (m?.t === MSG.STOP) shutdown()
})
process.on('disconnect', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/**
 * Stops the worker: the recording's segments are closed and reported, then SIGKILL, with no
 * StopLivePlay and no Logout. The 250 ms loop used to re-create every camera the recorder had
 * just stopped (04:39:04: 'recording off', then 'recording on' for all 25 and new mains starting
 * in the old worker), and the stops and logout of the old way aborted inside the SDK at 03:35:48,
 * 04:03:58 and 04:39:09. The kernel closes the NVR's sockets at the kill, as at every watchdog kill.
 */
async function shutdown() {
  if (stopping) return
  stopping = true
  clearInterval(loop) // no re-attached taps, no re-created cameras
  clearInterval(stallTimer) // no stall restarts
  refuseNewCalls('the worker is stopping') // nothing new enters the SDK (timers of streams included)
  nvr.lane.clear('the worker is stopping')
  // tests only (with the fake SDK): a worker that overstays its stop
  const slow = process.env.CCTV_WORKER_FAKE_SDK === '1' ? Number(process.env.CCTV_WORKER_TEST_SLOW_STOP_MS || 0) : 0
  if (slow) await sleep(slow)
  // closes (fsyncs) the open segments; their messages go out before the exit. A disk that does
  // not finish within 4 s: those files are picked up by the recovery scan at the next start
  allowAllCloses()
  await Promise.race([recorder.stop(), sleep(4000)])
  // messages go to the parent in order: once a last one has been handed over, so have the
  // segments' (a kill straight after recorder.stop() could lose them)
  await Promise.race([new Promise((r) => sendStats(r) || r()), sleep(1000)])
  process.kill(process.pid, 'SIGKILL')
}

process.send?.({ t: MSG.READY })
// (channels: the worker polls the camera list; the main process uses this one, nvrs.mjs workerStats)
// refusals: the streams live in THIS process, so the main process cannot count them itself; without
// this number the Health page's "refused" column and the nvr-refusing alert are both dead letters.
// (sent: called once the message has been handed over; returns false when nothing was sent)
const sendStats = (sent) => {
  if (!process.connected) return false
  try {
    // subCap: the NVR's sub-stream limit (null: none known), the viewers' sub-streams held at it, every
    // sub-stream held (their pictures in the parent are old now), and whether it is at the limit;
    // mainPlaying: cameras whose main stream delivers video (a held tile's stand-in joins only those)
    // loop: the longest pause of this worker's event loop in the last minute (loop-lag.mjs, /healthz);
    // mem: this process's memory, logged by the parent once an hour (proc-memory.mjs; perf report Task 0)
    const mainPlaying = [...nvr.streams.values()].filter((s) => s.streamType === 0 && s.state === 'playing' && s.gotVideo).map((s) => s.ch)
    process.send({ t: MSG.STATS, status: nvr.status, error: nvr.error, streams: nvr.streams.size, refusals: recentRefusals(nvr.streams.values(), Date.now()), channels: nvr.channels, codecSeen: Object.fromEntries(nvr.codecSeen), subCap: { limit: cap.known(), held: heldNow(), parked: parkedNow(), full: fullNow() }, mainPlaying, sdk: sdkStats(), rec: recorder.status(), loop: { worstMs: loopWorstMs() }, mem: memoryNow() }, typeof sent === 'function' ? () => sent() : undefined)
    return true
  } catch {
    return false
  }
}
setInterval(sendStats, 5000).unref()
