// The net under a promise rejection nobody catches, for the main server. Node ends the process on
// one (its default, and nothing starts this app with --unhandled-rejections), and nothing here
// listened for it. In the main process that takes every viewer's socket, a running export and every
// NVR worker with it, so recording stops on every camera for about a minute. One was found in
// 2026-10: a playback command of 'null' threw inside an async handler nobody awaited (put right in
// playback.mjs, a change of its own). This is for the next: it is logged and counted, and the
// process carries on.
//
//   guardProcess({ name })  -> this process's one 'unhandledRejection' listener
//   processErrors()         -> { unhandledRejections, lastAt, lastMessage }, in /healthz
//
// For server.mjs, which imports, before any other module, a module that makes the call
// (process-guard-server.mjs): a file's imports are all loaded before its own first line runs, so a
// call in the file itself would leave them, and the timers and I/O that already run while they
// load, without the net.
//
// Not for an NVR worker (nvr-worker.mjs), on purpose. A worker that ends is replaced by its
// supervisor within seconds, logged in afresh, and only its own NVR waits. Kept running after a job
// of its own stopped part-way it would go on reporting ready, with nothing to say whether it still
// records and nothing to start another: its count could not leave the process, and nothing would
// act on it. Until both exist, ending is the better outcome there. Nor for share-helper.mjs (its
// parent turns an exit into a new helper), report-worker.mjs or the command-line tools: those
// should end, loudly.
//
// No 'uncaughtException' listener, on purpose. Node documents carrying on after one as unsafe: the
// throw cut off whatever was calling the code that threw (the rest of an event's listeners, Node's
// own stream and socket code part-way through), and nothing puts that right; a rejection ended only
// the async job it happened in. And systemd starts the process again. So an exception nobody
// catches ends the process, as it always did.
//
// Kept running is not nothing wrong: the job that rejected stopped part-way. So each one is a line
// in the log and a count in /healthz (no page or alert shows it yet), to be found and fixed where
// it is. And a job whose last line is what ends the process (shutdown() in server.mjs) has that
// line in a finally: stopped part-way, it would otherwise leave the process running, half shut down.
//
// Imports nothing but node:util, so it is the same on any machine and its test runs it for real (no SDK).
import { inspect } from 'node:util'

// A fault that loops (a timer whose job rejects every second) would be 86,400 stacks a day in a
// journal capped at 1 GB: a reason is logged only while fewer than MAX_LINES were in the minute
// before it, and those over that are a line saying how many, when the oldest of them is a minute old
// or before the next one that is logged (like loop-lag.mjs). So at most MAX_LINES reasons in any
// minute, and at most as many of those lines.
const MAX_LINES = 20
const MINUTE_MS = 60_000
const LAST_CHARS = 300 // lastMessage is for a page: the first line of the reason, no longer than this
// The limit above is on lines, not on their size. One reason (a message that carries a whole reply, an
// object with a table in it; not a deep stack, V8 keeps ten frames) is logged up to LOG_HEAD +
// LOG_TAIL characters: both ends, since an Error's frames, its cause and its properties come after
// its message, with a line between them that says so.
const LOG_HEAD = 6000
const LOG_TAIL = 2000

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

/**
 * A reason as the log has it: as Node prints an error the process dies of (the stack, and what a
 * stack leaves out: the cause, an AggregateError's errors, properties such as code), so that the log
 * says no less than it did when the process ended there; a string as it is. Only for a line that is
 * logged: inspect() of a large object takes time, and a looping fault rejects thousands of times.
 * @param {unknown} reason
 * @param {string} text textOf(reason), the fallback
 */
function logTextOf(reason, text) {
  try {
    if (reason !== null && (typeof reason === 'object' || typeof reason === 'function')) return inspect(reason)
  } catch {} // (a reason inspect() cannot take: a proxy whose traps throw)
  return text
}

/** The one line for the rejections not logged one by one. Also a timer's callback, so it must not throw. */
function tellRest() {
  try {
    clearTimeout(owed)
    owed = null
    if (!untold) return
    const n = untold
    untold = 0
    guard.log(`[${guard.name}] ${n} more unhandled rejection${n === 1 ? ' was' : 's were'} not logged (${count} since this process started)`)
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
    // (a copy: a slice keeps the whole string it was cut from alive, megabytes of it for as long as
    // no other rejection follows)
    lastMessage = Buffer.from(text.split('\n', 1)[0].slice(0, LAST_CHARS)).toString()
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
    const full = logTextOf(reason, text)
    const shown = full.length > LOG_HEAD + LOG_TAIL ? `${full.slice(0, LOG_HEAD)}\n[${name}] (that reason is ${full.length} characters: the first ${LOG_HEAD} and the last ${LOG_TAIL} are logged, this line between them)\n${full.slice(-LOG_TAIL)}` : full
    log(`[${name}] unhandled rejection (kept running): ${shown}`)
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
 * This process's unhandled rejections since it started (plain data: /healthz sends it as it is).
 * @returns {{ unhandledRejections: number, lastAt: number|null, lastMessage: string|null }}
 *   lastAt: ms since 1970, by the guard's clock; lastMessage: the first line of the last reason
 */
export const processErrors = () => ({ unhandledRejections: count, lastAt, lastMessage })
