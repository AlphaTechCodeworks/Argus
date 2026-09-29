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

// ---- the arithmetic, on a clock of our own --------------------------------------------------------
{
  let t = 0
  let cpu = 0
  const lines = []
  const w = loopWatch({ beatMs: 20, now: () => t, cpuMs: () => cpu, log: (l) => lines.push(l) })
  const beats = (n, cpuEach = 0) => {
    for (let i = 0; i < n; i++) {
      t += 20
      cpu += cpuEach
      w.beat()
    }
  }
  beats(50)
  check('beats on time: no line, nothing worst', lines.length === 0 && w.worstMs() === 0, `${lines} / ${w.worstMs()}`)

  // a 1 s block spent computing: the next beat comes 1,020 ms after the last one
  t += 1020
  cpu += 1000
  w.beat()
  check('a 1 s block: one line, "[loop] blocked 1000 ms"', lines.length === 1 && msOf(lines[0]) === 1000, lines.join(' | '))
  check('...that says the thread was computing through it', /computed for 1000 ms of it$/.test(lines[0]), lines[0])
  check('...and it is the worst of the last minute', w.worstMs() === 1000)

  beats(10)
  t += 240 + 20 // 240 ms late: under the threshold
  w.beat()
  check('a 240 ms pause: no line, but the worst still says 1000', lines.length === 1 && w.worstMs() === 1000)

  // 12 s waiting on the NAS (a synchronous unlink on a slow share): hardly any CPU
  t += 12_000 + 20
  cpu += 40
  w.beat()
  check('a 12 s pause spent waiting says so', lines.length === 2 && msOf(lines[1]) === 12_000 && /computed for 40 ms of it \(the rest was waiting: synchronous file or network I\/O on this thread, or the whole machine paused\)$/.test(lines[1]), lines[1])
  check('the worst of the last minute is now 12000', w.worstMs() === 12_000)

  // a minute of on-time beats later, both have left the window
  beats(3001)
  check('a minute later the worst is back to 0', w.worstMs() === 0, String(w.worstMs()))
  check('...and no more lines', lines.length === 2)
}
{
  // no per-thread CPU figure (Node before 23.9): the line is just the pause
  let t = 0
  const lines = []
  const w = loopWatch({ beatMs: 20, now: () => t, cpuMs: () => null, log: (l) => lines.push(l) })
  t += 20
  w.beat()
  t += 520
  w.beat()
  check('without a CPU figure: "[loop] blocked 500 ms" and nothing more', lines.length === 1 && lines[0] === '[loop] blocked 500 ms', lines[0])
}
{
  // Something pausing the loop every second must not fill the journal (69 MB a day already, root
  // disk 2.9 GB free on 09-29): 20 lines a minute, then one line for the rest when the minute ends.
  let t = 0
  const lines = []
  const w = loopWatch({ beatMs: 20, now: () => t, cpuMs: () => null, log: (l) => lines.push(l) })
  t = 20
  w.beat()
  for (let i = 0; i < 25; i++) {
    t += 300 + 20 // a 300 ms pause
    w.beat()
    t += 20
    w.beat()
  }
  t += 400 + 20 // the longest of those not logged: 400 ms
  w.beat()
  check('26 pauses in one minute: 20 lines', blockedLines(lines).length === 20, String(lines.length))
  while (t < 60_000) {
    t += 20
    w.beat()
  }
  t += 20
  w.beat()
  const rest = lines.filter((l) => /^\[loop\] 6 more pauses over 250 ms/.test(l))
  check('...then one line for the other 6 once the minute is over, with the longest', lines.length === 21 && rest.length === 1 && /the longest 400 ms/.test(rest[0]), lines.at(-1))
  t += 300 + 20
  w.beat()
  check('...and the next minute logs one by one again', lines.length === 22 && msOf(lines.at(-1)) === 300, lines.at(-1))
}
{
  // a clock that goes backwards (it should not: performance.now is monotonic) is no pause
  let t = 10_000
  const lines = []
  const w = loopWatch({ beatMs: 20, now: () => t, cpuMs: () => null, log: (l) => lines.push(l) })
  t -= 5000
  w.beat()
  check('time going backwards: no line, no negative worst', lines.length === 0 && w.worstMs() === 0)
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
