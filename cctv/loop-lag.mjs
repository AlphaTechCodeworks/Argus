// Event-loop pauses, seen. While this process's JavaScript thread is busy with one job, everything
// else in it waits: in the main process live video to every viewer, pages, the API and alarm checks;
// in an NVR worker its recording's frames. The performance audit of 2026-09-29 found jobs that hold
// it for seconds to minutes (thinning ~10 min per run once footage passes fullDays, low-space
// deletion 12-15 s, the backfill scan 3.3-4.5 s a night tick) and nothing in the log said so: the
// watchdog only mentioned a check more than 20 s late, as "system sleep?". So (Task 0):
//   - "[loop] blocked N ms" whenever the loop pauses over BLOCKED_MS, with how much of it this thread
//     spent computing (a scan) rather than waiting (a synchronous read of a slow share, or the whole
//     machine paused: verify-6 saw a 1.2 s pause of the VM at 17:02:22);
//   - loopWorstMs(): the longest pause of the last minute, for /healthz and each worker's STATS.
// A day of these lines is the baseline each later fix is judged against.
//
// Why a beat of its own and not the watchdog's 5 s check: that check is late only when a pause
// covers the moment it was due, so it would see a 1 s pause at a random moment one time in five.
// A 20 ms beat is late after every pause, by the pause (to within 20 ms). It costs 50 wake-ups a
// second of a few microseconds each; the main process already wakes thousands of times a second.
// monitorEventLoopDelay was tried first (2026-09-29): read and reset every 5 s, it loses the first
// interval after each reset, so a pause just after a reset, or read before its timer fired, is
// never recorded (a 1 s busy loop read as 32 ms).
//
// Started by watchdog.mjs startWatchdog(), which the main process and every NVR worker run.
import { performance } from 'node:perf_hooks'

export const BLOCKED_MS = 250 // a pause this long is a line in the log
const BEAT_MS = 20
const WINDOW_MS = 60_000 // loopWorstMs() looks this far back
// Something pausing the loop every second would be 86,400 lines a day in a journal capped at 1 GB
// that already grows about 66 MB a day (perf report D7): the first MAX_LINES in a minute are logged
// one by one, and the rest as one line when that minute is over.
const MAX_LINES = 20

/** This thread's CPU time in ms (Node 23.9 on), or null where Node cannot tell. */
function threadCpuMs() {
  if (typeof process.threadCpuUsage !== 'function') return null
  const u = process.threadCpuUsage()
  return (u.user + u.system) / 1000
}

/**
 * The arithmetic, with no timer: beat() is called every beatMs, and a beat that comes late comes
 * late by the pause just ended.
 * @param {{ beatMs?: number, blockedMs?: number, windowMs?: number, maxLines?: number,
 *           now?: () => number, cpuMs?: () => number|null, log?: (line: string) => void }} [o]
 */
export function loopWatch({ beatMs = BEAT_MS, blockedMs = BLOCKED_MS, windowMs = WINDOW_MS, maxLines = MAX_LINES, now = () => performance.now(), cpuMs = threadCpuMs, log = console.warn } = {}) {
  let last = now()
  let lastCpu = cpuMs()
  // the longest pause that ended in each second of the window: [second, ms]
  const seconds = []
  let minute = Math.floor(last / 60_000)
  let lines = 0 // logged one by one this minute
  let untold = 0 // over the threshold this minute, not logged one by one
  let untoldMost = 0

  const note = (sec, ms) => {
    const top = seconds.at(-1)
    if (top && top[0] === sec) top[1] = Math.max(top[1], ms)
    else seconds.push([sec, ms])
    while (seconds.length && seconds[0][0] <= sec - windowMs / 1000) seconds.shift()
  }

  return {
    beat() {
      const t = now()
      const cpu = cpuMs()
      const late = Math.max(0, t - last - beatMs)
      const used = cpu === null || lastCpu === null ? null : Math.max(0, cpu - lastCpu)
      last = Math.max(last, t) // (a clock that went back is no pause, and not a long one next time)
      lastCpu = cpu
      const m = Math.floor(last / 60_000)
      if (m !== minute) {
        if (untold) log(`[loop] ${untold} more pauses over ${blockedMs} ms in the minute before were not logged one by one; the longest ${Math.round(untoldMost)} ms`)
        minute = m
        lines = 0
        untold = 0
        untoldMost = 0
      }
      note(Math.floor(last / 1000), late)
      if (late <= blockedMs) return
      if (lines >= maxLines) {
        untold++
        untoldMost = Math.max(untoldMost, late)
        return
      }
      lines++
      const ms = Math.round(late)
      if (used === null) return log(`[loop] blocked ${ms} ms`)
      // the CPU figure covers the whole gap between two beats, so it can be a little over the pause
      const c = Math.min(ms, Math.round(used))
      log(`[loop] blocked ${ms} ms: this thread computed for ${c} ms of it${c < ms / 2 ? ' (the rest was waiting: synchronous file or network I/O on this thread, or the whole machine paused)' : ''}`)
    },
    /** The longest pause of the last minute, in ms (0: none worth a millisecond). */
    worstMs() {
      const from = Math.floor(now() / 1000) - windowMs / 1000
      let most = 0
      for (const [sec, ms] of seconds) if (sec > from && ms > most) most = ms
      return Math.round(most)
    }
  }
}

let running = null

/**
 * Starts this process's beat (once; later calls get the same one).
 * @returns {{ worstMs: () => number, stop: () => void }}
 */
export function startLoopLag(opts = {}) {
  if (running) return running
  const watch = loopWatch(opts)
  const timer = setInterval(() => watch.beat(), opts.beatMs ?? BEAT_MS)
  timer.unref() // never what keeps a process alive
  running = {
    worstMs: () => watch.worstMs(),
    stop() {
      clearInterval(timer)
      running = null
    }
  }
  return running
}

/** The longest pause of this process's event loop in the last minute, in ms; null when not watched. */
export const loopWorstMs = () => (running ? running.worstMs() : null)
