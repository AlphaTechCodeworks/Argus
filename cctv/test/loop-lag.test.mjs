// Tests for loop-lag.mjs: "[loop] blocked N ms" whenever this process's event loop pauses over
// 250 ms, and the longest pause of the last minute for /healthz and the workers' STATS (perf report
// Task 0, 2026-09-29). No SDK, Windows-safe; the watchdog wiring itself is checked with a real
// process in live-worker.test.mjs (it needs sdk.mjs).
//   node cctv/test/loop-lag.test.mjs
import { readFileSync } from 'node:fs'

const { BLOCKED_MS, loopWatch, startLoopLag, loopWorstMs } = await import('../loop-lag.mjs')

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const busy = (ms) => {
  const t = Date.now()
  while (Date.now() - t < ms);
}
const blockedLines = (lines) => lines.filter((l) => /^\[loop\] blocked \d+ ms/.test(l))
const msOf = (l) => Number(l.match(/^\[loop\] blocked (\d+) ms/)?.[1])

check('the threshold is 250 ms', BLOCKED_MS === 250)

// ---- the arithmetic, on clocks of our own -------------------------------------------------------------
/**
 * A loop of our own: `run(idle, busy)` has it wait `idle` ms, then work `busy` ms (computing, or
 * waiting in a synchronous call when `onCpu` is false), then take the beat that was due.
 */
function fakeLoop(o = {}) {
  const c = { t: 0, idle: 0, cpu: 0, lines: [] }
  c.w = loopWatch({ now: () => c.t, idleMs: () => (o.noIdle ? null : c.idle), cpuMs: () => (o.noCpu ? null : c.cpu), log: (l) => c.lines.push(l), ...o.watch })
  c.run = (idle, busy, onCpu = true) => {
    c.t += idle + busy
    c.idle += idle
    if (onCpu) c.cpu += busy
    c.w.beat()
  }
  // n beats on time with the loop 5% busy (the main thread's load on 09-29)
  c.quiet = (n) => {
    for (let i = 0; i < n; i++) c.run(95, 5)
  }
  return c
}
{
  const c = fakeLoop()
  c.quiet(50)
  check('beats on time: no line, and the worst is nothing', c.lines.length === 0 && c.w.worstMs() === 0, `${c.lines} / ${c.w.worstMs()}`)

  // a 1 s block spent computing, 30 ms after the last beat: that beat is 930 ms late
  c.run(30, 1000)
  check('a 1 s block: one line, "[loop] blocked 1000 ms" (not the 930 ms the beat was late)', c.lines.length === 1 && msOf(c.lines[0]) === 1000, c.lines.join(' | '))
  check('...that says the thread was computing through it', /computed for 1000 ms of it$/.test(c.lines[0]), c.lines[0])
  check('...and it is the worst of the last minute', c.w.worstMs() === 1000)

  c.quiet(10)
  c.run(50, 240)
  check('a 240 ms pause: no line, but the worst still says 1000', c.lines.length === 1 && c.w.worstMs() === 1000)

  // 12 s waiting on the NAS (a synchronous unlink on a slow share): busy, hardly any CPU
  c.run(10, 12_000, false)
  check('a 12 s pause spent waiting says so', c.lines.length === 2 && msOf(c.lines[1]) === 12_000 && /computed for 0 ms of it \(the rest was waiting: synchronous file or network I\/O on this thread, or the whole machine paused\)$/.test(c.lines[1]), c.lines[1])
  check('the worst of the last minute is now 12000', c.w.worstMs() === 12_000)

  // a minute of on-time beats later, both have left the window
  c.quiet(601)
  check('a minute later the worst is back to what a quiet loop does (0)', c.w.worstMs() === 0, String(c.w.worstMs()))
  check('...and no more lines', c.lines.length === 2)
}
{
  // busy nearly all the time with short jobs, never long: the beats come on time, so no pause
  const c = fakeLoop()
  for (let i = 0; i < 100; i++) c.run(2, 103)
  check('a loop 98% busy with short jobs: no line, the worst is how late the beats were', c.lines.length === 0 && c.w.worstMs() === 5, `${c.lines} / ${c.w.worstMs()}`)
}
{
  // the whole VM stopped for 1.2 s while the loop waited for work (verify-6, 17:02:22): that time
  // counts as the loop's idle time, so only the beat's lateness shows it
  const c = fakeLoop()
  c.run(95, 5)
  c.t += 1200 + 100
  c.idle += 1200 + 100
  c.w.beat()
  check('the machine paused while the loop waited: logged, by the lateness, as waiting', c.lines.length === 1 && msOf(c.lines[0]) === 1200 && /computed for 0 ms of it \(the rest was waiting/.test(c.lines[0]), c.lines[0])
}
{
  // no per-thread CPU figure (Node before 23.9): the line is just the pause
  const c = fakeLoop({ noCpu: true })
  c.run(0, 500)
  check('without a CPU figure: "[loop] blocked 500 ms" and nothing more', c.lines.length === 1 && c.lines[0] === '[loop] blocked 500 ms', c.lines[0])
}
{
  // no idle figure either: the lateness alone (short by up to a beat)
  const c = fakeLoop({ noCpu: true, noIdle: true })
  c.run(30, 1000)
  check('without the loop\'s idle time: the lateness, "[loop] blocked 930 ms"', c.lines.length === 1 && c.lines[0] === '[loop] blocked 930 ms', c.lines[0])
}
{
  // Something pausing the loop every second must not fill the journal (66 MB a day already, root
  // disk 2.9 GB free on 09-29): 20 lines a minute, then one line for the rest when the minute ends.
  const c = fakeLoop({ noCpu: true })
  for (let i = 0; i < 25; i++) {
    c.run(0, 300) // a 300 ms pause
    c.quiet(1)
  }
  c.run(0, 400) // the longest of those not logged: 400 ms
  check('26 pauses in one minute: 20 lines', blockedLines(c.lines).length === 20, String(c.lines.length))
  while (c.t < 60_000) c.quiet(1)
  const rest = c.lines.filter((l) => /^\[loop\] 6 more pauses over 250 ms/.test(l))
  check('...then one line for the other 6 once the minute is over, with the longest', c.lines.length === 21 && rest.length === 1 && /the longest 400 ms/.test(rest[0]), c.lines.at(-1))
  c.run(0, 300)
  check('...and the next minute logs one by one again', c.lines.length === 22 && msOf(c.lines.at(-1)) === 300, c.lines.at(-1))
}
{
  // a clock that goes backwards (it should not: performance.now is monotonic) is no pause
  const c = fakeLoop()
  c.quiet(100)
  c.t -= 5000
  c.w.beat()
  c.quiet(10)
  check('time going backwards: no line, no negative worst', c.lines.length === 0 && c.w.worstMs() === 0, `${c.lines} / ${c.w.worstMs()}`)
}

// ---- the real thing: this process's own loop --------------------------------------------------------
{
  const lines = []
  const lag = startLoopLag({ log: (l) => lines.push(l) })
  check('startLoopLag: once per process (a second call gives the same watch)', startLoopLag() === lag)
  await sleep(300)
  check('idle: no line', blockedLines(lines).length === 0, lines.join(' | '))
  busy(1000)
  await sleep(200)
  const got = blockedLines(lines)
  check('a 1 s busy loop logs exactly one blocked line', got.length === 1, lines.join(' | '))
  check('...of about 1000 ms', msOf(got[0]) >= 950 && msOf(got[0]) <= 1100, got[0])
  check('...that says it computed most of it (when this Node can tell)', typeof process.threadCpuUsage !== 'function' || /computed for (\d+) ms/.test(got[0]) && Number(got[0].match(/computed for (\d+) ms/)[1]) >= 700, got[0])
  check('loopWorstMs(): the worst of the last minute is that pause', loopWorstMs() >= 950 && loopWorstMs() <= 1100, String(loopWorstMs()))
  await sleep(300)
  check('...and still one line afterwards', blockedLines(lines).length === 1)

  // three pauses a little apart: three lines ("whenever", not "the worst of each 5 s")
  lines.length = 0
  for (let i = 0; i < 3; i++) {
    busy(300)
    await sleep(100)
  }
  const three = blockedLines(lines)
  check('three 300 ms pauses 100 ms apart: three lines', three.length === 3 && three.every((l) => msOf(l) >= 250 && msOf(l) <= 400), lines.join(' | '))
  lag.stop()
}

// ---- the wiring (the modules that use it need sdk.mjs, so they are read, not run, here) ----------------
{
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const wd = src('watchdog.mjs')
  check("watchdog.mjs: startWatchdog starts the loop watch (the main process's and each worker's)", /import \{[^}]*\bstartLoopLag\b[^}]*\} from '\.\/loop-lag\.mjs'/.test(wd) && /export function startWatchdog\(\) \{\n[^\n]*startLoopLag\(\)/.test(wd))
  const server = src('server.mjs')
  const route = server.slice(server.indexOf("if (pathname === '/healthz') {"))
  const head = route.slice(0, route.indexOf('return sendJson(res, ok ? 200 : 503'))
  check('/healthz: the worst pause of the last minute, this process', /\bloop: \{ worstMs: loopWorstMs\(\)/.test(head), head.match(/loop:[^\n]*/)?.[0])
  check("/healthz: ...and each worker's, from its STATS", /loopWorstMs: w\?\.loop\?\.worstMs \?\? null/.test(head), head.match(/loopWorstMs:[^\n]*/)?.[0])
  check('/healthz: whether it is ok does not depend on it (Task 0 changes no behaviour)', /const ok = s\.late === 0 && s\.oldestMs < 30_000\n/.test(head))
  const worker = src('nvr-worker.mjs')
  const stats = worker.match(/process\.send\(\{ t: MSG\.STATS,[^\n]*/)?.[0] ?? ''
  check('nvr-worker.mjs: STATS carry the loop and the memory', /\bloop: \{ worstMs: loopWorstMs\(\) \}/.test(stats) && /\bmem: memoryNow\(\)/.test(stats), stats.slice(0, 120))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
