// Hang watchdog. If SDK calls stay stuck, the process kills itself so Docker
// (restart: unless-stopped, init: true) starts a fresh one; both NVRs are back
// in about 3 seconds. This is the last line of defence behind the time limits
// in sdk.mjs and the lanes in lanes.mjs.
//
// It uses SIGKILL on purpose: process.exit() runs libuv's shutdown, which joins
// every thread-pool worker, and workers stuck inside the SDK would make exit
// hang forever.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './auth.mjs'
import { discountPause, sdkStats } from './sdk.mjs'

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
const SUFFIX = WORKER ? `-${WORKER}` : ''
const RESTARTS_FILE = join(DATA_DIR, `restarts${SUFFIX}.json`)
const DUMP_FILE = join(DATA_DIR, `last-hang${SUFFIX}.json`)

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
    limits: { maxCallMs: MAX_CALL_MS, maxLate: MAX_LATE, lateHoldMs: LATE_HOLD_MS, progressMs: PROGRESS_MS, maxQueueWaitMs: MAX_QUEUE_WAIT_MS },
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

export function startWatchdog() {
  let lastCheck = Date.now()
  let quietUntil = 0
  setInterval(() => {
    const now = Date.now()
    const paused = now - lastCheck - CHECK_MS
    lastCheck = now
    if (paused > PAUSE_MS) {
      discountPause(paused)
      quietUntil = now + GRACE_MS
      console.warn(`[watchdog] no check for ${Math.round(paused / 1000)} s (system sleep?): not counted against SDK calls; judging again in ${GRACE_MS / 1000} s`)
      return
    }
    if (now - startedAt < GRACE_MS || now < quietUntil) return
    const s = sdkStats()
    if (s.oldestMs > MAX_CALL_MS) return trip(`SDK call stuck for ${Math.round(s.oldestMs / 1000)} s: ${s.oldest}`, s)
    if (s.late >= MAX_LATE && s.oldestMs > LATE_HOLD_MS && s.lastReturnAgoMs > PROGRESS_MS) {
      return trip(`${s.late} SDK calls overdue, none returned for ${Math.round(s.lastReturnAgoMs / 1000)} s`, s)
    }
    if (s.queued > 0 && s.queuedOldestMs > MAX_QUEUE_WAIT_MS) return trip(`SDK call slots exhausted for ${Math.round(s.queuedOldestMs / 1000)} s`, s)
  }, CHECK_MS).unref()
}

/** Whether a previous run was restarted by the watchdog (for /api/sites and the log). */
export const lastHang = () => {
  if (!existsSync(DUMP_FILE)) return null
  try {
    const d = JSON.parse(readFileSync(DUMP_FILE, 'utf8'))
    return { at: d.at, reason: d.reason }
  } catch {
    return null
  }
}
