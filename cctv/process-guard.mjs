// The net under a promise rejection nobody catches. Node ends the process on one (its default, and
// nothing starts this app with --unhandled-rejections), and nothing here listened for it. In the
// main process that takes every viewer's socket, a running export and every NVR worker with it, so
// recording stops on every camera for about a minute; in a worker, that NVR's video and recording
// until the supervisor has a new one logged in. One was found in 2026-10: a playback command of
// 'null' threw inside an async handler nobody awaited. That one is fixed where it was; this is for
// the next: it is logged and counted, and the process carries on.
//
//   guardProcess({ name })  -> this process's one 'unhandledRejection' listener
//   processErrors()         -> { unhandledRejections, lastAt, lastMessage }, for the Health page
//
// For the two processes that live long and hold other people's work, server.mjs and nvr-worker.mjs.
// Each imports, before any other module of the app, a module that makes the call
// (process-guard-server.mjs, process-guard-worker.mjs): a file's imports are all loaded before its
// own first line runs, so a call in the file itself would leave them, and the timers and I/O that
// already run while they load, without the net. Not for share-helper.mjs (its parent turns an exit
// into a new helper, which is the right outcome there), report-worker.mjs or the command-line
// tools: those should end, loudly.
//
// No 'uncaughtException' listener, on purpose. Node documents carrying on after one as unsafe: the
// throw cut off whatever was calling the code that threw (the rest of an event's listeners, Node's
// own stream and socket code part-way through), and nothing puts that right; a rejection ended only
// the async job it happened in. And something already starts each process again: systemd the main
// one, worker-supervisor.mjs a worker. So an exception nobody catches ends the process, as it
// always did.
//
// Kept running is not nothing wrong: the job that rejected stopped part-way. So each one is a line
// in the log and a count for Health, to be found and fixed where it is. And a job whose last line
// is what ends the process (shutdown() in server.mjs and nvr-worker.mjs) has that line in a finally:
// stopped part-way, it would otherwise leave the process running, half shut down.
//
// Imports nothing, so it is the same on any machine and its test runs it for real (no SDK).

// A fault that loops (a timer whose job rejects every second) would be 86,400 stacks a day in a
// journal capped at 1 GB: a line is logged only while fewer than MAX_LINES were in the minute before
// it, and the ones over that are one line saying how many, when that minute is over (like loop-lag.mjs).
const MAX_LINES = 20
const MINUTE_MS = 60_000
const LAST_CHARS = 300 // lastMessage is for a page: the first line of the reason, no longer than this

let guard = null // { name, log, now } once guardProcess() has run
let count = 0
let lastAt = null
let lastMessage = null
let logged = [] // when each of the last lines was logged: at most MAX_LINES, the oldest first
let untold = 0 // counted but not logged, since the last line that said so
let owed = null // the timer that says how many those were

/** What was rejected, as text: an Error's stack (it begins with its name and message), anything else as a string. */
function textOf(reason) {
  try {
    if (reason instanceof Error && typeof reason.stack === 'string' && reason.stack) return reason.stack
    return String(reason)
  } catch {
    return '(a reason that cannot be shown as text)' // String() throws on some: an object with no toString
  }
}

/** The one line for the rejections not logged one by one. Also a timer's callback, so it must not throw. */
function tellRest() {
  try {
    clearTimeout(owed)
    owed = null
    if (!untold) return
    const n = untold
    untold = 0
    guard.log(`[${guard.name}] ${n} more unhandled rejection${n === 1 ? '' : 's'} in the minute before were not logged (${count} since this process started)`)
  } catch {} // (as in onRejection)
}

function onRejection(reason) {
  // Nothing in here may throw: an exception inside this listener is an uncaught exception, and the
  // net would be what ends the process (a log that fails, a reason String() cannot take).
  try {
    count++
    const { name, log, now } = guard
    const at = now()
    const text = textOf(reason)
    lastAt = at
    lastMessage = text.split('\n', 1)[0].slice(0, LAST_CHARS)
    // (a clock set back must not hold the log back for as long as it went back: start again)
    if (logged.length && at < logged.at(-1)) logged = []
    while (logged.length && logged[0] <= at - MINUTE_MS) logged.shift()
    if (logged.length >= MAX_LINES) {
      untold++
      if (!owed) {
        // when the oldest of those lines is a minute old: a timer, so the line comes even if no more
        // rejections do; unref, it is never what keeps a process alive
        owed = setTimeout(tellRest, Math.max(0, logged[0] + MINUTE_MS - at))
        owed.unref()
      }
      return
    }
    tellRest() // (the timer may be late, or the clock not the timer's: say it before the next line)
    logged.push(at)
    log(`[${name}] unhandled rejection (kept running): ${text}`)
  } catch {}
}

/**
 * From here on a promise rejection nobody catches is logged and counted, and this process keeps
 * running. Once per process: a later call adds no second listener, and the first name stays.
 * @param {{ name?: string, log?: (line: string) => void, now?: () => number }} [o]
 *   name: who is speaking, the "[name]" in front of each line; log, now: for the tests
 */
export function guardProcess({ name, log = console.error, now = Date.now } = {}) {
  if (guard) return
  guard = { name: String(name ?? 'process'), log, now }
  process.on('unhandledRejection', onRejection)
}

/**
 * This process's unhandled rejections since it started (plain data, so a worker's can cross its pipe).
 * @returns {{ unhandledRejections: number, lastAt: number|null, lastMessage: string|null }}
 *   lastAt: ms since 1970, by the guard's clock; lastMessage: the first line of the last reason
 */
export const processErrors = () => ({ unhandledRejections: count, lastAt, lastMessage })
