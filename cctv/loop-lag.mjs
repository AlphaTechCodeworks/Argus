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
// How. A beat every 100 ms: a pause makes the next beat late, so every pause over 100 ms is seen
// (the watchdog's 5 s check is late only when a pause covers the moment it was due: one 1 s pause
// in five). How late the beat is says the pause to within 100 ms; the loop's own idle time (the time
// it spent waiting for work, performance.nodeTiming.idleTime) makes it exact: in the gap between two
// beats the thread was busy for gap - idle, which is the pause plus the little else it did then.
// Why not faster, or monitorEventLoopDelay (all measured on the production VM, 2026-09-29): each
// wake-up of a process there costs 80-270 us of CPU, so a 20 ms beat cost 0.4-1.3% of a core per
// process (100 ms: 0.03-0.2%); monitorEventLoopDelay wakes as often, and read and reset every 5 s it
// loses the interval after each reset (a 1 s busy loop read as 32 ms).
//
// Started by watchdog.mjs startWatchdog(), which the main process and every NVR worker run.
import { performance } from 'node:perf_hooks'

export const BLOCKED_MS = 250 // a pause this long is a line in the log
const BEAT_MS = 100
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

/** How long this loop has waited for work since it started, in ms, or null where Node cannot tell. */
function loopIdleMs() {
  const v = performance.nodeTiming?.idleTime
  return Number.isFinite(v) ? v : null
}

/**
 * The arithmetic, with no timer: beat() is called every beatMs, and a beat that comes late comes
 * late by the pause just ended.
 * @param {{ beatMs?: number, blockedMs?: number, windowMs?: number, maxLines?: number, now?: () => number,
 *           idleMs?: () => number|null, cpuMs?: () => number|null, log?: (line: string) => void }} [o]
 */
export function loopWatch({ beatMs = BEAT_MS, blockedMs = BLOCKED_MS, windowMs = WINDOW_MS, maxLines = MAX_LINES, now = () => performance.now(), idleMs = loopIdleMs, cpuMs = threadCpuMs, log = console.warn } = {}) {
  let last = now()
  let lastIdle = idleMs()
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
      const idle = idleMs()
      const cpu = cpuMs()
      const gap = Math.max(0, t - last)
      const late = Math.max(0, gap - beatMs)
      // Late by more than a beat: the loop did not turn for at least that long, and what it was busy
      // with in the gap is the better figure (the beat's lateness alone is short by up to a beat). Not
      // otherwise: a loop busy with many short jobs is not paused, however little it idles. A pause
      // while the loop was idle (the whole machine stopped) shows only as the lateness.
      const busy = idle === null || lastIdle === null ? 0 : Math.max(0, gap - (idle - lastIdle))
      const pause = late > beatMs ? Math.max(late, Math.min(busy, gap)) : late
      const used = cpu === null || lastCpu === null ? null : Math.max(0, cpu - lastCpu)
      last = Math.max(last, t) // (a clock that went back is no pause, and not a long one next time)
      lastIdle = idle
      lastCpu = cpu
      const m = Math.floor(last / 60_000)
      if (m !== minute) {
        if (untold) log(`[loop] ${untold} more pauses over ${blockedMs} ms in the minute before were not logged one by one; the longest ${Math.round(untoldMost)} ms`)
        minute = m
        lines = 0
        untold = 0
        untoldMost = 0
      }
      note(Math.floor(last / 1000), pause)
      if (pause <= blockedMs) return
      if (lines >= maxLines) {
        untold++
        untoldMost = Math.max(untoldMost, pause)
        return
      }
      lines++
      const ms = Math.round(pause)
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
