// Hang watchdog. If SDK calls stay stuck, the process kills itself so Docker
// (restart: unless-stopped, init: true) starts a fresh one; both NVRs are back
// in about 3 seconds. This is the last line of defence behind the time limits
// in sdk.mjs and the lanes in lanes.mjs. In the main process the kill waits (up to HOLD_MAX_MS)
// while the recording workers record, since it would take them down too (spareWhile); in an NVR
// worker the time a stuck call is given follows how its recording's video is flowing (spareWhile too).
//
// It uses SIGKILL on purpose: process.exit() runs libuv's shutdown, which joins
// every thread-pool worker, and workers stuck inside the SDK would make exit
// hang forever.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './auth.mjs'
import { callInFlight, discountPause, sdkStats } from './sdk.mjs'

const env = (name, fallback) => Number(process.env[name] ?? fallback) // overridable for tests
const CHECK_MS = env('WATCHDOG_CHECK_MS', 5000)
const GRACE_MS = env('WATCHDOG_GRACE_MS', 60_000) // no verdicts during start-up
const MAX_CALL_MS = env('WATCHDOG_MAX_CALL_MS', 90_000) // one call stuck this long
const MAX_LATE = 6 // or this many calls past their budget ...
// ... with the oldest stuck at least this long (a slow NVR makes calls a few seconds late
// for a while; a hung SDK keeps them stuck for minutes) ...
const LATE_HOLD_MS = env('WATCHDOG_LATE_HOLD_MS', 45_000)
// ... and no native call (any NVR) back for this long: calls that keep coming back, even late,
// mean a slow NVR, which a restart does not cure; a hung SDK returns nothing
const PROGRESS_MS = env('WATCHDOG_PROGRESS_MS', 20_000)
const MAX_QUEUE_WAIT_MS = 30_000 // or the native-call cap full for this long
// a check this much later than scheduled: the machine slept (Windows Modern Standby pauses
// WSL) or the process was frozen. That time is not counted against SDK calls, and the NVR
// connections get GRACE_MS to come back before any verdict.
const PAUSE_MS = env('WATCHDOG_PAUSE_MS', 20_000)
// a live worker (nvr-worker.mjs, CCTV_WORKER_NVR set) keeps its own files: its restarts must not
// feed the main app's crash-loop guard (startupDelayMs) or its "restarted by the watchdog" note
const WORKER = String(process.env.CCTV_WORKER_NVR ?? '').replace(/[^A-Za-z0-9_-]/g, '')
// the main process that runs the recording workers (nvrs.mjs LIVE_WORKER); without them (Docker) the
// main process runs every live stream itself
const REC_WORKERS = !WORKER && process.env.CCTV_LIVE_WORKER === 'on'
const SUFFIX = WORKER ? `-${WORKER}` : ''
const RESTARTS_FILE = join(DATA_DIR, `restarts${SUFFIX}.json`)
const DUMP_FILE = join(DATA_DIR, `last-hang${SUFFIX}.json`)
const HOLD_FILE = join(DATA_DIR, `last-hold${SUFFIX}.json`)
// Main process only (spareWhile): the longest a stuck-SDK verdict is held off while the workers
// record, counted from the first verdict on the stuck call (so a single stuck call is killed at the
// first verdict from 90 s + 5 min on, however often other NVRs' returns cleared it between). Killing this
// process kills every worker with it (fork + KillMode=mixed): about a minute of footage from every
// camera, when this process needs no SDK call to relay video or index segments. Every stall seen to
// clear by itself did so well inside this: the SDK breaks its links after 26-29 s, and the slowest
// late returns came back about 80 s after they started. A call still stuck 5 minutes after the
// verdict is not coming back, and meanwhile playback from the NVRs, their settings and event intake
// are unavailable, so it ends in the old restart. Never more than 10 minutes, whatever the
// environment says: this process must not be left hanging for ever.
const HOLD_MAX_MS = (() => {
  const v = env('WATCHDOG_HOLD_MAX_MS', 5 * 60_000)
  return Number.isFinite(v) && v >= 0 ? Math.min(v, 10 * 60_000) : 5 * 60_000
})()
const HOLD_LOG_MS = 60_000 // while holding: a log line (and a fresh last-hold.json) this often
// An NVR worker is judged by its recording (spareWhile with recorder.mjs flow()). In a worker that
// serves one NVR the single-stuck-call rule always applied at 90 s (no other NVR can show progress),
// and one viewer's stuck call cost every recording of that NVR: 03:53:25, a sub LivePlay stuck 90 s
// while the NVR's other calls kept returning (2,240 camera-seconds). So:
//   - half or more of the cameras that should be delivering had a frame in the last 10 s: the
//     recording is fine, a stuck call may run to FLOW_MAX_CALL_MS before the kill;
//   - 80% or more have had nothing for 45 s: the kill comes at FROZEN_CALL_MS. Both kills that day
//     came 55-97 s after the recording had already frozen;
//   - otherwise MAX_CALL_MS, as before.
const FLOW_MAX_CALL_MS = env('WATCHDOG_FLOW_MAX_CALL_MS', 300_000)
const FROZEN_CALL_MS = env('WATCHDOG_FROZEN_CALL_MS', 60_000)
const FLOWING_SHARE = 0.5
const FROZEN_SHARE = 0.8

const startedAt = Date.now()

/** Thread census: which kernel wait each thread is in (helps tell an SDK lock from I/O). */
function threadCensus() {
  try {
    const counts = {}
    for (const t of readdirSync('/proc/self/task')) {
      let comm = '?'
      let wchan = '?'
      try {
        comm = readFileSync(`/proc/self/task/${t}/comm`, 'utf8').trim()
        wchan = readFileSync(`/proc/self/task/${t}/wchan`, 'utf8').trim() || '0'
      } catch {}
      const key = `${comm} @ ${wchan}`
      counts[key] = (counts[key] ?? 0) + 1
    }
    return counts
  } catch {
    return {}
  }
}

const readRestarts = () => {
  try {
    return JSON.parse(readFileSync(RESTARTS_FILE, 'utf8'))
  } catch {
    return []
  }
}

/** How long to wait before connecting to NVRs after repeated watchdog restarts (crash-loop guard). */
export function startupDelayMs() {
  const recent = readRestarts().filter((t) => Date.now() - t < 15 * 60_000)
  if (recent.length < 3) return 0
  return Math.min(30_000 * 2 ** (recent.length - 3), 10 * 60_000)
}

function trip(reason, stats) {
  const dump = {
    at: new Date().toISOString(),
    reason,
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    lastReturnAgoMs: stats.lastReturnAgoMs, // a native call (any NVR) last returned this long ago
    limits: { maxCallMs: MAX_CALL_MS, maxLate: MAX_LATE, lateHoldMs: LATE_HOLD_MS, progressMs: PROGRESS_MS, maxQueueWaitMs: MAX_QUEUE_WAIT_MS, holdMaxMs: WORKER ? 0 : HOLD_MAX_MS, lateCounts: REC_WORKERS ? 'lateRoots' : 'lateBlocking', ...(WORKER ? { flowMaxCallMs: FLOW_MAX_CALL_MS, frozenCallMs: FROZEN_CALL_MS } : {}) },
    // a worker: how the recording's video was flowing at the kill (recorder.mjs flow(); null: nothing to record)
    ...(WORKER ? { flow: flowNow() } : {}),
    stats,
    threads: threadCensus()
  }
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(DUMP_FILE, `${JSON.stringify(dump, null, 2)}\n`)
    const recent = readRestarts().filter((t) => Date.now() - t < 24 * 3_600_000)
    writeFileSync(RESTARTS_FILE, JSON.stringify([...recent, Date.now()]))
  } catch {}
  // a synchronous write to fd 2, so the reason reaches the log before the kill
  try {
    writeSync(2, `[watchdog] ${reason}; restarting. Details in ${DUMP_FILE}\n${JSON.stringify({ ...stats, calls: stats.calls.slice(0, 10) })}\n`)
  } catch {}
  process.kill(process.pid, 'SIGKILL')
}

/**
 * Is some OTHER NVR still getting answers out of the SDK? Evidence has to be positive: a call
 * belonging to a different NVR must really have returned within PROGRESS_MS. If none ever has
 * (a single-NVR install, or the whole library wedged), this is false and the verdict stands.
 */
const othersProgressing = (stats, nvrId) =>
  Object.entries(stats.lastReturnAgoByNvr ?? {}).some(([id, ago]) => id !== nvrId && ago < PROGRESS_MS)

let spare = null // main process: () => truthy (a description) while killing this process would stop recording
let flowProbe = null // worker: () => the recorder's flow snapshot (recorder.mjs flow())

/**
 * What killing this process would cost the recording.
 *
 * Main process: while probe() says the recording workers are recording, a stuck SDK here does
 * not get the process killed at once. Rules 1 and 2 log "holding" and write last-hold.json instead,
 * until the stuck call returns or HOLD_MAX_MS has passed since the first verdict on it; then the
 * old kill. With nothing recording, or a probe that throws, the verdicts kill at once as before.
 *
 * NVR worker (CCTV_WORKER_NVR set): probe() gives the recorder's flow ({ cameras, flowing, frozen },
 * recorder.mjs flow()), and the single-stuck-call rule's limit follows it (FLOW_MAX_CALL_MS while the
 * recording flows, FROZEN_CALL_MS once it has frozen, MAX_CALL_MS otherwise). Anything else from the
 * probe (null, no cameras, a throw) leaves MAX_CALL_MS. The other rules are unchanged there.
 * @param {() => any} probe  main: truthy while recording (a string is shown in the log); worker: a flow snapshot
 */
export function spareWhile(probe) {
  const fn = typeof probe === 'function' ? probe : null
  if (WORKER) flowProbe = fn
  else spare = fn
}

/** Worker: the recorder's flow now, or null (no probe, nothing to record, or a probe that throws). */
function flowNow() {
  if (!flowProbe) return null
  try {
    const f = flowProbe()
    return f && typeof f === 'object' && Number.isFinite(f.cameras) && f.cameras > 0 ? f : null
  } catch {
    return null
  }
}

/** The single-stuck-call limit for this check, and why it is not MAX_CALL_MS ('' when it is). */
function callLimit(flow) {
  if (!flow) return { ms: MAX_CALL_MS, why: '' }
  const n = flow.cameras
  if (flow.flowing >= n * FLOWING_SHARE) return { ms: Math.max(MAX_CALL_MS, FLOW_MAX_CALL_MS), why: `recording still flowing (${flow.flowing} of ${n} cameras had a frame in the last ${Math.round((flow.recentMs ?? 10_000) / 1000)} s)` }
  if (flow.frozen >= n * FROZEN_SHARE) return { ms: Math.min(MAX_CALL_MS, FROZEN_CALL_MS), why: `recording frozen (${flow.frozen} of ${n} cameras without a frame for ${Math.round((flow.frozenMs ?? 45_000) / 1000)} s)` }
  return { ms: MAX_CALL_MS, why: '' }
}
let flowNoted = 0 // the stuck call (sdkStats id) already logged as given longer because recording flows

const spareReason = () => {
  if (!spare) return null
  try {
    const r = spare()
    return r ? (typeof r === 'string' ? r : 'recording') : null
  } catch {
    return null
  }
}

// The hold belongs to the stuck call that started it (sdkStats calls[].id), not to a run of verdicts
// in a row: a call to another NVR that comes back clears the verdict for PROGRESS_MS, and a limit
// that started over after each such return was never reached while the call stayed stuck (and
// last-hold.json said 'recovered'). Meanwhile that NVR cannot log in again, its playback and
// settings stay refused, and event intake for every NVR stays paused (lateCalls() > 0).
let hold = null // { id, since, loggedAt, first } while a kill is held off; id: the stuck call's

const callName = (c) => `${c.name}${c.tag ? ` (${c.tag})` : ''}${c.nvr ? ` on ${c.nvr}` : ''}`

function writeHold(outcome, reason, recording, stats, now) {
  const record = {
    at: new Date(now).toISOString(),
    since: new Date(hold.since).toISOString(),
    heldS: Math.round((now - hold.since) / 1000),
    limitS: Math.round(HOLD_MAX_MS / 1000),
    outcome, // holding | recovered | killed
    reason,
    recording,
    first: hold.first,
    stats: { ...stats, calls: stats.calls.slice(0, 20) },
    threads: outcome === 'holding' ? threadCensus() : undefined
  }
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(HOLD_FILE, `${JSON.stringify(record, null, 2)}\n`)
  } catch {}
}

/** The call a hold was for has left the SDK: the hold ends without a restart. */
function recovered(stats, now) {
  writeHold('recovered', `${hold.first.call} returned`, spareReason() ?? '', stats, now)
  console.warn(`[watchdog] ${hold.first.call} returned after ${Math.round((now - hold.since) / 1000)} s held; no restart`)
  hold = null
}

/**
 * A verdict (rule 1 or 2) on the stuck call `stuck` (the oldest call in flight that is not a login)
 * was reached. Returns null to hold it off (the workers are recording and the limit has not been
 * reached since the first verdict on that call), or the reason to kill with, as before.
 */
function holdOrKill(reason, stuck, stats, now) {
  // a hold for a call that has returned meanwhile is over: this is a new stall, with a limit of its own
  if (hold && !callInFlight(hold.id)) recovered(stats, now)
  const recording = spareReason()
  if (!recording) {
    if (!hold) return reason
    writeHold('killed', `${reason}; the workers stopped recording`, '', stats, now)
    return `${reason}; held ${Math.round((now - hold.since) / 1000)} s until the workers stopped recording`
  }
  if (!hold) {
    hold = {
      id: stuck.id,
      since: now,
      loggedAt: 0,
      first: { at: new Date(now).toISOString(), reason, call: callName(stuck), id: stuck.id, oldest: stats.oldest, oldestMs: stats.oldestMs }
    }
  }
  const held = now - hold.since
  if (held >= HOLD_MAX_MS) {
    writeHold('killed', reason, recording, stats, now)
    return `${reason}; held ${Math.round(held / 1000)} s while the workers recorded, the limit`
  }
  if (now - hold.loggedAt >= HOLD_LOG_MS) {
    hold.loggedAt = now
    writeHold('holding', reason, recording, stats, now)
    const left = Math.round((HOLD_MAX_MS - held) / 1000)
    console.warn(`[watchdog] ${reason}; holding: not restarting while the workers record (${recording}). Restarting in ${left} s unless it returns. Details in ${HOLD_FILE}`)
  }
  return null
}

/**
 * No verdict at this check. The hold ends only once the call it was for has returned; while that
 * call is still inside the SDK (other NVRs' returns only cleared the verdict for now), it goes on
 * and so does its limit.
 */
function released(stats, now) {
  if (hold && !callInFlight(hold.id)) recovered(stats, now)
}

export function startWatchdog() {
  let lastCheck = Date.now()
  let quietUntil = 0
  setInterval(() => {
    const now = Date.now()
    const paused = now - lastCheck - CHECK_MS
    lastCheck = now
    if (paused > PAUSE_MS) {
      discountPause(paused)
      if (hold) hold.since += paused // time asleep does not count towards the hold's limit either
      quietUntil = now + GRACE_MS
      console.warn(`[watchdog] no check for ${Math.round(paused / 1000)} s (system sleep?): not counted against SDK calls; judging again in ${GRACE_MS / 1000} s`)
      return
    }
    if (now - startedAt < GRACE_MS || now < quietUntil) return
    const s = sdkStats()
    // What this is for: a heap-corrupted SDK stops returning anything and no time limit in
    // sdk.mjs can free it, so only a restart helps. What it is NOT for: an NVR that has gone
    // off the network. Two things follow, both learnt the hard way on the live server, where one
    // unreachable NVR had the process killed five times in six minutes and stopped the other
    // four NVRs recording each time.
    //
    // 1. A login (mayBlock) that is stuck proves nothing: NET_SDK_Login is known to block for
    //    minutes in this SDK when the far end does not answer, a late login is already tidied
    //    up by logoutLate in nvrs.mjs, and probe.mjs now avoids the call altogether in the
    //    common case. So stuck logins do not drive a verdict on their own.
    // 2. One NVR's stuck call is not evidence either, as long as calls to OTHER NVRs keep
    //    coming back: the library is plainly still working, and killing the process would only
    //    take the healthy NVRs down with the broken one. If nothing else is returning (or there
    //    is nothing else), a stuck call still trips, exactly as before.
    //
    // Two more from 09-27, when two restarts of this process stopped all 87 cameras for a minute each:
    // 3. In the main process that runs the recording workers, calls queued behind one stuck call
    //    are not evidence of their own: the SDK serialises work across NVRs, so everything asked
    //    after a stuck call waits behind it. At 04:12:13 one FindRecDate plus six event-poller
    //    calls queued behind it made "7 SDK calls overdue", and the restart took all recording
    //    with it. There the late rule counts only the call that started the jam (sdk.mjs
    //    lateRoots), which is never more than one, so the rule does not fire there at all: the
    //    single stuck call rule judges that call, and point 4 holds its verdict. A worker, and a
    //    main process without recording workers (CCTV_LIVE_WORKER off: it runs every live stream
    //    itself, where bursts of StopLivePlay have wedged the SDK), count every late call as
    //    before, so such a wedge still ends at LATE_HOLD_MS rather than MAX_CALL_MS.
    // 4. Main process: while the workers are recording (spareWhile), both verdicts are held off
    //    instead of killing, until the stuck call returns or HOLD_MAX_MS after the first verdict
    //    on it (see holdOrKill). This process needs no SDK call to relay video or index segments,
    //    and killing it kills every worker with it.
    // 5. An NVR worker: the single stuck call's limit follows the recording's flow (callLimit).
    let verdict = null
    const oldestBlocking = s.calls.find((c) => !c.mayBlock)
    const lateCount = REC_WORKERS ? s.lateRoots : s.lateBlocking
    const limit = WORKER && oldestBlocking && oldestBlocking.ms > Math.min(MAX_CALL_MS, FROZEN_CALL_MS) ? callLimit(flowNow()) : { ms: MAX_CALL_MS, why: '' }
    if (oldestBlocking && oldestBlocking.ms > MAX_CALL_MS && limit.ms > MAX_CALL_MS && flowNoted !== oldestBlocking.id) {
      flowNoted = oldestBlocking.id
      console.warn(`[watchdog] SDK call stuck for ${Math.round(oldestBlocking.ms / 1000)} s: ${callName(oldestBlocking)}; ${limit.why}: not restarting before ${Math.round(limit.ms / 1000)} s`)
    }
    if (oldestBlocking && oldestBlocking.ms > limit.ms && !othersProgressing(s, oldestBlocking.nvr)) {
      verdict = `SDK call stuck for ${Math.round(oldestBlocking.ms / 1000)} s: ${oldestBlocking.name}${oldestBlocking.tag ? ` (${oldestBlocking.tag})` : ''}${limit.why ? `; ${limit.why}` : ''}`
    } else if (lateCount >= MAX_LATE && s.oldestMs > LATE_HOLD_MS && s.lastReturnAgoMs > PROGRESS_MS) {
      verdict = `${lateCount} SDK calls overdue, none returned for ${Math.round(s.lastReturnAgoMs / 1000)} s`
    }
    if (verdict) {
      // (both verdicts are about the oldest call in flight that is not a login: with 6 late ones
      // for rule 2 there is one)
      const kill = holdOrKill(verdict, oldestBlocking ?? s.calls[0], s, now)
      if (kill) return trip(kill, s)
    } else {
      released(s, now)
    }
    if (s.queued > 0 && s.queuedOldestMs > MAX_QUEUE_WAIT_MS) {
      const reason = `SDK call slots exhausted for ${Math.round(s.queuedOldestMs / 1000)} s`
      if (hold) writeHold('killed', reason, spareReason() ?? '', s, now) // (this rule is not held)
      return trip(reason, s)
    }
  }, CHECK_MS).unref()
}

/**
 * Whether a previous run was restarted by the watchdog (for /api/sites and the log), and the
 * oldest call then in flight ({ name, nvr, tag }, or null): playback.mjs keeps the FindRecDate
 * that wedged the SDK from being asked again straight after the restart.
 */
export const lastHang = () => {
  if (!existsSync(DUMP_FILE)) return null
  try {
    const d = JSON.parse(readFileSync(DUMP_FILE, 'utf8'))
    const c = Array.isArray(d.stats?.calls) ? d.stats.calls[0] : null // oldest first
    const oldest = c && typeof c.name === 'string' ? { name: c.name, nvr: String(c.nvr ?? ''), tag: String(c.tag ?? '') } : null
    return { at: d.at, reason: d.reason, oldest }
  } catch {
    return null
  }
}
