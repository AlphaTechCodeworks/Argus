// Tests for process-guard.mjs: the net under a promise rejection nobody catches. Node ends the
// process on one and nothing in this app listened for it: in the main server that takes every
// viewer's socket, a running export and every NVR worker (so about a minute of recording on every
// camera) with it. One was found in 2026-10: a playback command of 'null' threw inside an async
// handler nobody awaited. Every case here runs in a node process of its own, so what is tested is
// what a process really does (ends, or goes on), not a listener called by hand. No SDK: runs on
// Windows and Linux. server.mjs and nvr-worker.mjs need sdk.mjs, so their wiring is read, not run
// (their shutdown functions alone are run, as they are written, with stand-ins for what they call).
//   node cctv/test/process-guard.test.mjs
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}

const GUARD = new URL('../process-guard.mjs', import.meta.url).href
const IMPORT = `import { guardProcess, processErrors } from ${JSON.stringify(GUARD)}`
const TURN = 'const turn = (ms = 30) => new Promise((r) => setTimeout(r, ms))'
// the two modules that make the call themselves, one for each guarded process (imported for what they do)
const importing = (f) => `import ${JSON.stringify(new URL(`../${f}`, import.meta.url).href)}`

/** Runs `code` as a module in a node process of its own, with no flags but Node's own defaults (`more`: its environment besides). */
function run(code, more = {}) {
  const env = { ...process.env }
  delete env.NODE_OPTIONS // (a developer's --unhandled-rejections would change what is being pinned here)
  delete env.CCTV_WORKER_NVR
  Object.assign(env, more)
  const t0 = Date.now()
  // 30 s: under the minute a line still owed is held back for, so a timer that kept the process open shows as no status
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 30_000 })
  return { status: r.status, signal: r.signal, out: String(r.stdout ?? '').replace(/\r\n/g, '\n'), err: String(r.stderr ?? '').replace(/\r\n/g, '\n'), ms: Date.now() - t0 }
}
const lines = (text) => text.split('\n').filter(Boolean)
/** The guard's own lines of one process (a stack's other lines start with spaces, not with the name). */
const said = (r, name) => lines(r.err).filter((l) => l.startsWith(`[${name}] `))
const kept = (r, name) => said(r, name).filter((l) => l.startsWith(`[${name}] unhandled rejection (kept running): `))
const flat = (text, max) => text.trim().replace(/\s+/g, ' ').slice(0, max)
const short = (r) => `status ${r.status}${r.signal ? ` (${r.signal})` : ''} | out: ${flat(r.out, 120)} | err: ${flat(r.err, 200)}`
/** check() of a process that was run: what it did is said only when that is not what was expected. */
const ran = (n, ok, r, e = '') => check(n, ok, ok ? e : [e, short(r)].filter(Boolean).join(' | '))
const json = (r) => {
  try {
    return JSON.parse(lines(r.out).at(-1))
  } catch {
    return {}
  }
}

// The fault as it was found: an async handler handed null, and nobody waiting for it. Then
// something to do 200 ms later, which only a process still running does.
const FAULT = `const onCommand = async (cmd) => cmd.type
onCommand(null)
setTimeout(() => console.log('still running'), 200)`
const NULL_READ = "TypeError: Cannot read properties of null (reading 'type')"

// ---- the fault: without the guard, the process is over --------------------------------------------------
{
  const r = run(FAULT)
  ran('no guard: a rejection nobody catches ends the process with a non-zero status', Number.isInteger(r.status) && r.status !== 0, r)
  ran('...at once: what it had to do 200 ms later never happens', !r.out.includes('still running'), r)
  ran('...and what Node prints on the way out is the reason', r.err.includes(NULL_READ), r)
}

// ---- with the guard: logged, and the process goes on ---------------------------------------------------
{
  const r = run(`${IMPORT}
guardProcess({ name: 'guarded' })
${FAULT}`)
  const k = kept(r, 'guarded')
  ran('guarded: the same rejection is logged once, with the reason', k.length === 1 && k[0] === `[guarded] unhandled rejection (kept running): ${NULL_READ}`, r)
  ran('...with the stack under it (where it was thrown)', /^\[guarded\] unhandled rejection \(kept running\): TypeError: [^\n]*\n +at /m.test(r.err), r)
  ran('...and the process goes on: what it had to do 200 ms later is done', r.out.includes('still running'), r)
  ran('...and ends normally when its work is done (status 0)', r.status === 0, r)
}

// ---- processErrors(): how many, and the last one ----------------------------------------------------
{
  const r = run(`${IMPORT}
${TURN}
const before = processErrors()
guardProcess({ name: 'count', log: () => {} })
const t0 = Date.now()
Promise.reject(new Error('one'))
Promise.reject(new RangeError('two'))
await turn()
const mid = processErrors()
Promise.reject(new Error('three'))
await turn()
console.log(JSON.stringify({ before, mid, after: processErrors(), t0, t1: Date.now() }))`)
  const j = json(r)
  ran('processErrors(): nothing yet is 0, and no last one', j.before?.unhandledRejections === 0 && j.before?.lastAt === null && j.before?.lastMessage === null, r)
  ran('processErrors(): counts them', j.mid?.unhandledRejections === 2 && j.after?.unhandledRejections === 3, r)
  ran('processErrors(): the last message (its first line: the kind of error and what it said)', j.mid?.lastMessage === 'RangeError: two' && j.after?.lastMessage === 'Error: three', r)
  ran('processErrors(): when the last one was', Number.isFinite(j.after?.lastAt) && j.after.lastAt >= j.t0 && j.after.lastAt <= j.t1 && j.after.lastAt >= j.mid.lastAt, r)
  ran('...with a log of its own given, nothing goes to stderr', r.err === '' && r.status === 0, r)
}
{
  // lastMessage is for a page (the Health field to come): one line, and no more of it than fits there. The log has it all
  const r = run(`${IMPORT}
guardProcess({ name: 'long' })
Promise.reject(new Error('x'.repeat(1000) + '\\nits second line'))
setTimeout(() => console.log(JSON.stringify(processErrors())), 50)`)
  const m = json(r).lastMessage
  ran('processErrors(): a long reason: lastMessage is its first line, cut at 300 characters', m === `Error: ${'x'.repeat(293)}`, r, `${m?.length} characters`)
  ran('...the line in the log is not cut', kept(r, 'long')[0] === `[long] unhandled rejection (kept running): Error: ${'x'.repeat(1000)}` && r.err.includes('\nits second line\n'), r)
}

// ---- a looping fault must not fill the journal: 20 lines in any minute, then one for the rest ---------------
{
  // the real clock: 50 at once
  const r = run(`${IMPORT}
${TURN}
guardProcess({ name: 'burst' })
for (let i = 1; i <= 50; i++) Promise.reject(new Error('burst-' + i))
await turn()
console.log(JSON.stringify(processErrors()))`)
  const k = kept(r, 'burst')
  ran('50 in a burst: 20 lines, the first 20', k.length === 20 && k.every((l, i) => l.endsWith(`: Error: burst-${i + 1}`)), r, `${k.length} lines`)
  ran('...all 50 counted, and the last one is the 50th', json(r).unhandledRejections === 50 && json(r).lastMessage === 'Error: burst-50', r)
  // (held open, it would be stopped by run()'s 30 s limit and have no status)
  ran('...and the line still owed for the other 30 does not hold the process open: it ends by itself, status 0', r.status === 0, r, `${r.ms} ms`)
}
{
  // a clock of our own, 100 ms short of a minute after the first 20: the line for the rest comes by
  // itself when that minute is over, with no rejection after it to bring it. Then a second minute
  // like the first: a fault that loops goes on for hours, and each minute's line must say that
  // minute's number (5 here, not 35) and come by itself too (a new timer once the first has spoken)
  const r = run(`${IMPORT}
${TURN}
let t = 1_700_000_000_000
guardProcess({ name: 'burst', now: () => t })
const reject = (from, to) => { for (let i = from; i <= to; i++) Promise.reject(new Error('burst-' + i)) }
reject(1, 20)
await turn()
t += 59_900
reject(21, 50)
await turn(1000)
console.error('[burst] MINUTE 2')
t += 100
reject(51, 70)
await turn()
t += 59_900
reject(71, 75)
await turn(1000)
console.error('[burst] END')
console.log(JSON.stringify(processErrors()))`)
  const s = said(r, 'burst')
  const first = s.slice(0, s.indexOf('[burst] MINUTE 2') + 1)
  const second = s.slice(first.length)
  const logged = (l) => l.startsWith('[burst] unhandled rejection (kept running): ')
  const k1 = first.filter(logged)
  const k2 = second.filter(logged)
  ran('50 inside one minute: at most 20 logged lines', k1.length === 20 && k1.every((l, i) => l.endsWith(`: Error: burst-${i + 1}`)), r, `${k1.length} lines`)
  ran('...plus one line for the rest, when the minute is over, saying how many (30)', first.length === 22 && /^\[burst\] 30 more unhandled rejections /.test(first[20]) && /not logged/.test(first[20]) && first[21] === '[burst] MINUTE 2', r, first.slice(20).join(' | '))
  ran('the next minute, 25 more: 20 lines again, from the first of them', k2.length === 20 && k2.every((l, i) => l.endsWith(`: Error: burst-${i + 51}`)) && second.slice(0, 20).every((l, i) => l === k2[i]), r, `${k2.length} lines`)
  ran('...and one line for the 5 of that minute (not 35), again by itself when the minute is over', second.length === 22 && /^\[burst\] 5 more unhandled rejections [^\n]*not logged \(75 since this process started\)$/.test(second[20]) && second[21] === '[burst] END', r, second.slice(20).join(' | '))
  ran('...all 75 counted', json(r).unhandledRejections === 75 && r.status === 0, r)
}
{
  // a minute is 60 s from the oldest line: one 1 ms inside it is still held back, one at 60 s is
  // logged, after the line for those that were not
  const r = run(`${IMPORT}
${TURN}
let t = 1_700_000_000_000
guardProcess({ name: 'burst', now: () => t })
for (let i = 1; i <= 50; i++) Promise.reject(new Error('burst-' + i))
await turn()
t += 59_999
Promise.reject(new Error('burst-51'))
await turn()
t += 1
Promise.reject(new Error('burst-52'))
await turn()
console.log(JSON.stringify(processErrors()))`)
  const s = said(r, 'burst')
  ran('59.999 s after 20 lines: still not logged', kept(r, 'burst').length === 21 && !r.err.includes('burst-51'), r, `${kept(r, 'burst').length} lines`)
  ran('60 s after them: the line for the 31 not logged, then this one', s.length === 22 && /^\[burst\] 31 more unhandled rejections /.test(s[20]) && s[21] === '[burst] unhandled rejection (kept running): Error: burst-52', r, s.slice(20).join(' | '))
  ran('...every one counted all the while, and lastAt is by the clock given', json(r).unhandledRejections === 52 && json(r).lastAt === 1_700_000_060_000, r)
}
{
  // a clock set back (the machine's time put right) must not hold the log back for as long as it went back
  const r = run(`${IMPORT}
${TURN}
let t = 1_700_000_000_000
guardProcess({ name: 'clock', now: () => t })
for (let i = 1; i <= 20; i++) Promise.reject(new Error('clock-' + i))
await turn()
t -= 3_600_000
Promise.reject(new Error('clock-21'))
await turn()`)
  const k = kept(r, 'clock')
  ran('the clock set back an hour after 20 lines: the next one is logged, not held back until the clock is there again', k.length === 21 && k[20].endsWith(': Error: clock-21') && r.status === 0, r, `${k.length} lines`)
}

// ---- once per process ---------------------------------------------------------------------------------
{
  const r = run(`${IMPORT}
${TURN}
const had = process.listenerCount('unhandledRejection')
guardProcess({ name: 'twice' })
guardProcess({ name: 'twice' })
guardProcess({ name: 'other' })
Promise.reject(new Error('just the once'))
await turn()
console.log(JSON.stringify({ had, listeners: process.listenerCount('unhandledRejection'), n: processErrors().unhandledRejections }))`)
  const j = json(r)
  ran('guardProcess twice (and a third time): still one listener', j.had === 0 && j.listeners === 1, r)
  ran('...so each rejection is logged once and counted once, under the first name', kept(r, 'twice').length === 1 && !r.err.includes('[other]') && j.n === 1 && r.status === 0, r)
}

// ---- there before the app's other modules are loaded ------------------------------------------------
// A file's imports are all loaded before its own first line runs, wherever that line stands, and
// auth.mjs waits for a hash while it loads: timers and I/O already run then. So a guardProcess()
// call in server.mjs itself came after all of that, with no net until then. process-guard-server.mjs
// and process-guard-worker.mjs make the call themselves and are the first module each file imports.
{
  const mod = (code) => JSON.stringify(`data:text/javascript,${encodeURIComponent(code)}`)
  // two modules of an app as it loads: one starts a job that is rejected 5 ms later, one waits 100 ms
  const LOADING = `import ${mod("setTimeout(() => Promise.reject(new Error('rejected while the imports load')), 5)")}
import ${mod('await new Promise((r) => setTimeout(r, 100))')}`
  const REASON = 'Error: rejected while the imports load'
  {
    const r = run(`import { guardProcess } from ${JSON.stringify(GUARD)}
${LOADING}
guardProcess({ name: 'late' })
console.log('still running')`)
    ran('guardProcess() called by the file itself is too late for a rejection while its imports load: the process is over', Number.isInteger(r.status) && r.status !== 0 && !r.out.includes('still running') && said(r, 'late').length === 0 && r.err.includes(REASON), r)
  }
  {
    const r = run(`${importing('process-guard-server.mjs')}
${LOADING}
import { processErrors } from ${JSON.stringify(GUARD)}
console.log('still running ' + processErrors().unhandledRejections)`)
    const k = kept(r, 'server')
    ran("process-guard-server.mjs imported first: the same rejection is logged, under the name 'server'", k.length === 1 && k[0] === `[server] unhandled rejection (kept running): ${REASON}`, r)
    ran('...the process goes on to run the file itself and ends normally, and processErrors() has counted it', r.out.includes('still running 1') && r.status === 0, r)
  }
  {
    const r = run(`${importing('process-guard-worker.mjs')}
${LOADING}
console.log('still running')`, { CCTV_WORKER_NVR: 'nvr7' })
    const k = kept(r, 'nvr7')
    // (in the journal the supervisor puts "[worker nvr7] " in front of every line of a worker: no "worker" of its own here)
    ran("process-guard-worker.mjs imported first: logged under the NVR's id, like the worker's other lines", k.length === 1 && k[0] === `[nvr7] unhandled rejection (kept running): ${REASON}` && said(r, 'worker nvr7').length === 0, r)
    ran('...and the worker goes on to run the file itself', r.out.includes('still running') && r.status === 0, r)
  }
}

// ---- what it must not do ----------------------------------------------------------------------------
{
  // Node's own flag is stronger than the guard: with --unhandled-rejections=strict a rejection is
  // raised as an uncaught exception before any listener hears of it. Nothing starts the app with it
  // (checked below); the tests that run a real worker do, on purpose, so that a rejection nobody
  // catches in a worker still ends it and fails them, as it did before the worker was guarded
  const r = run(`${importing('process-guard-worker.mjs')}
${FAULT}`, { CCTV_WORKER_NVR: 'nvr7', NODE_OPTIONS: '--unhandled-rejections=strict' })
  ran('NODE_OPTIONS=--unhandled-rejections=strict: a guarded worker still ends on a rejection nobody catches', Number.isInteger(r.status) && r.status !== 0 && !r.out.includes('still running') && said(r, 'nvr7').length === 0 && r.err.includes(NULL_READ), r)
}
{
  // an exception nobody catches is not a rejection: Node calls carrying on after one unsafe, and
  // systemd (main) and the worker supervisor start a new process
  const r = run(`${IMPORT}
guardProcess({ name: 'thrown' })
console.log('listeners ' + process.listenerCount('uncaughtException'))
setTimeout(() => { throw new Error('thrown, not rejected') }, 20)
setTimeout(() => console.log('still running'), 300)`)
  ran('an uncaught exception still ends the process (non-zero status, nothing after it runs)', Number.isInteger(r.status) && r.status !== 0 && !r.out.includes('still running') && r.err.includes('thrown, not rejected'), r)
  ran('...the guard does not listen for it, or say it kept running', r.out.includes('listeners 0') && said(r, 'thrown').length === 0, r)
}
{
  // nvr-worker.mjs loads the SDK, the NVR and the recorder with await import() right after the
  // guard: a worker that cannot load must still end, for the supervisor to start another, and not
  // sit there guarded with nothing loaded
  const r = run(`${IMPORT}
guardProcess({ name: 'startup' })
setTimeout(() => console.log('still running'), 300)
await import('data:text/javascript,throw new Error("the SDK did not load")')
console.log('loaded')`)
  ran('a start-up that fails (a module loaded with await import() throws) still ends the process', Number.isInteger(r.status) && r.status !== 0 && r.err.includes('the SDK did not load') && !r.out.includes('loaded') && !r.out.includes('still running') && said(r, 'startup').length === 0, r)
}
{
  // the net must not be what ends the process: a throw inside an 'unhandledRejection' listener is
  // an uncaught exception
  const r = run(`${IMPORT}
guardProcess({ name: 'badlog', log: () => { throw new Error('the log itself failed') } })
Promise.reject(new Error('anything'))
setTimeout(() => console.log('still running ' + processErrors().unhandledRejections), 100)`)
  ran('a log that throws: counted all the same, and the process goes on', r.status === 0 && r.out.includes('still running 1'), r)
}
{
  const r = run(`${IMPORT}
guardProcess({ name: 'odd' })
Promise.reject('just words')
Promise.reject(undefined)
Promise.reject(Object.create(null))
setTimeout(() => console.log('still running ' + JSON.stringify(processErrors())), 100)`)
  const k = kept(r, 'odd')
  ran('a reason that is no Error is logged as the text it makes', k.length === 3 && k[0] === '[odd] unhandled rejection (kept running): just words' && k[1] === '[odd] unhandled rejection (kept running): undefined', r)
  ran('...and one that cannot be made into text (String() throws on it) is still a line, and the process goes on', k.length === 3 && k[2].length > '[odd] unhandled rejection (kept running): '.length && r.status === 0 && r.out.includes('"unhandledRejections":3'), r)
}

// ---- the wiring (server.mjs and nvr-worker.mjs need sdk.mjs, so they are read, not run, here; their shutdowns are run) ----
{
  // (a file that is not there fails its checks rather than ending the run)
  const src = (f) => {
    try {
      return readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    } catch {
      return ''
    }
  }
  // (with or without names: `import './x.mjs'` is a module imported for what it does)
  const STATIC_IMPORT = /^(?:(?:import\b[^\n]*|\}) from |import )'([^']+)'(?: *\/\/[^\n]*)?$/gm
  const imported = (text) => [...text.matchAll(STATIC_IMPORT)].map((m) => m[1])
  const firstLocal = (text) => imported(text).find((s) => s.startsWith('.'))
  /** Every module a file names, in an import or an import(). */
  const specifiers = (text) => [...text.matchAll(/^\s*import\b[^\n]*?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2])

  const guard = src('process-guard.mjs')
  check('process-guard.mjs imports nothing but node: built-ins (it runs, and is tested, on any machine)', guard.length > 0 && specifiers(guard).every((s) => s.startsWith('node:')), specifiers(guard).join(', '))
  for (const f of ['process-guard-server.mjs', 'process-guard-worker.mjs']) {
    // (anything else it imported would be loaded, and run, before the guard is there)
    check(`${f} imports process-guard.mjs and nothing else`, specifiers(src(f)).join() === './process-guard.mjs', specifiers(src(f)).join(', '))
  }

  const server = src('server.mjs')
  check('server.mjs: process-guard-server.mjs is the first module it imports', imported(server)[0] === './process-guard-server.mjs', String(imported(server)[0]))
  const worker = src('nvr-worker.mjs')
  check('nvr-worker.mjs: process-guard-worker.mjs is the first of its own modules it imports (ahead of it, only node: built-ins)', firstLocal(worker) === './process-guard-worker.mjs' && imported(worker).slice(0, imported(worker).indexOf('./process-guard-worker.mjs')).every((s) => s.startsWith('node:')), imported(worker).slice(0, 4).join(', '))
  check('...and neither makes a late call of its own', server.length > 0 && worker.length > 0 && !/guardProcess/.test(server + worker))

  // share-helper.mjs: its parent turns an exit into a new helper, which is the right outcome there
  check('share-helper.mjs and report-worker.mjs are not guarded (they should end)', src('share-helper.mjs').length > 0 && src('report-worker.mjs').length > 0 && !/process-guard|unhandledRejection/.test(src('share-helper.mjs') + src('report-worker.mjs')))

  // A shutdown is an async job nobody waits for. A rejection inside one used to end the process by
  // itself, which is what the shutdown was after anyway. Guarded, it is logged and the process kept:
  // a worker would then stay for good with stopping = true, its loop gone, deaf to every message and
  // signal, its STATS still going out, so the supervisor saw a ready worker and started no other.
  // So the SIGKILL that ends each shutdown comes whatever became of the lines before it. The two
  // functions are run here as they are written, each in a process of its own under its guard, with
  // stand-ins for what they call (the real ones need the SDK), one of which fails.
  /** A function's text: from `start` to the first line after it that is a "}" alone at the left edge. */
  const fn = (text, start) => {
    const at = text.indexOf(start)
    const end = at < 0 ? -1 : text.indexOf('\n}\n', at)
    return end < 0 ? '// (not found)' : text.slice(at, end + 2)
  }
  const STAYED = "setTimeout(() => { console.log('still here'); process.exit(0) }, 500)"
  const workerStop = (failing) => `${importing('process-guard-worker.mjs')}
let stopping = false
const id = process.env.CCTV_WORKER_NVR
const loop = setInterval(() => {}, 1000)
const stallTimer = setInterval(() => {}, 1000)
const refuseNewCalls = () => { ${failing === 'refuseNewCalls' ? "throw new Error('refuseNewCalls() failed')" : ''} }
const nvr = { lane: { clear() {} } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const allowAllCloses = () => {}
const recorder = { stop: async () => { ${failing === 'recorder.stop' ? "throw new Error('recorder.stop() failed')" : ''} } }
const sendStats = (sent) => (console.log('last stats handed over'), sent(), true)
${fn(worker, 'async function shutdown() {')}
shutdown()
${STAYED}`
  // (Windows has no signals: a process killed there ends with status 1; one stopped by run()'s 30 s limit is a SIGTERM)
  const killed = (r) => r.signal === 'SIGKILL' || (process.platform === 'win32' && r.status === 1)
  const gone = (r, name, why) => killed(r) && !r.out.includes('still here') && r.err.startsWith(`[${name}] stopping failed part-way: Error: ${why}\n`) && kept(r, name).length === 0
  {
    const r = run(workerStop('recorder.stop'), { CCTV_WORKER_NVR: 'w1' })
    ran("nvr-worker.mjs shutdown(): recorder.stop() rejects: said, and the worker is killed all the same (not left 'stopping' for good)", gone(r, 'w1', 'recorder.stop() failed'), r)
  }
  {
    const r = run(workerStop('refuseNewCalls'), { CCTV_WORKER_NVR: 'w1' })
    ran('nvr-worker.mjs shutdown(): its first call throws: the same', gone(r, 'w1', 'refuseNewCalls() failed'), r)
  }
  {
    const r = run(workerStop(''), { CCTV_WORKER_NVR: 'w1' })
    ran('nvr-worker.mjs shutdown(): nothing fails: killed once its last stats are handed over, as before', killed(r) && r.out === 'last stats handed over\n' && r.err === '', r)
  }
  {
    const r = run(`${importing('process-guard-server.mjs')}
const stopNvrs = () => { throw new Error('stopNvrs() failed') }
${fn(server, 'const shutdown = async () => {')}
shutdown()
${STAYED}`)
    ran('server.mjs shutdown(): stopNvrs() throws: said, and the process is killed all the same', gone(r, 'server', 'stopNvrs() failed'), r)
  }

  // --unhandled-rejections=strict would end the process in spite of the guard (Node raises the
  // rejection as an uncaught exception before any listener hears of it)
  const root = (f) => {
    try {
      return readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8')
    } catch {
      return ''
    }
  }
  const starters = [root('deploy/cctv.service'), root('Dockerfile'), src('worker-supervisor.mjs')]
  check('nothing starts node with --unhandled-rejections (the service, the image, the worker supervisor)', starters.every((s) => s.length > 0 && !s.includes('unhandled-rejections')))

  // ...but the tests that run a real worker (under the fake SDK) do: guarded, a rejection nobody
  // catches in the worker is one line on its stderr and their checks would all still pass; with the
  // flag the worker ends there, as before the guard, and they fail (the flag is tested above)
  let tests = []
  try {
    tests = readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.test.mjs') && f !== 'process-guard.test.mjs')
  } catch {}
  const runsWorker = tests.filter((f) => /\bfork\(new URL\('\.\.\/nvr-worker\.mjs'|\bstartWorker\(|CCTV_LIVE_WORKER = 'on'/.test(src(`test/${f}`)))
  const lenient = runsWorker.filter((f) => !/^process\.env\.NODE_OPTIONS = [^\n]*--unhandled-rejections=strict/m.test(src(`test/${f}`)))
  // (live-worker.test.mjs is the worker's own test: not found among them, nothing was looked at)
  check('every test that runs a real worker runs it with --unhandled-rejections=strict', runsWorker.includes('live-worker.test.mjs') && lenient.length === 0, `${runsWorker.length} of them${lenient.length ? `, not: ${lenient.join(', ')}` : ''}`)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
