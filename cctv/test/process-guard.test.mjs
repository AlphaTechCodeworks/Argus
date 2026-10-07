// Tests for process-guard.mjs: the net under a promise rejection nobody catches. Node ends the
// process on one and nothing in this app listened for it: in the main server that takes every
// viewer's socket, a running export and every NVR worker (so about a minute of recording on every
// camera) with it. One was found in 2026-10: a playback command of 'null' threw inside an async
// handler nobody awaited. Every case here runs in a node process of its own, so what is tested is
// what a process really does (ends, or goes on), not a listener called by hand. No SDK: runs on
// Windows and Linux. server.mjs needs sdk.mjs, so its wiring is read, not run (its shutdown function
// alone is run, as it is written, with a stand-in for what it calls). No test starts server.mjs.
// The guard is for the main server only: that an NVR worker is not guarded is pinned here too.
//   node cctv/test/process-guard.test.mjs
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}

const GUARD = new URL('../process-guard.mjs', import.meta.url).href
const IMPORT = `import { guardProcess, processErrors } from ${JSON.stringify(GUARD)}`
const TURN = 'const turn = (ms = 30) => new Promise((r) => setTimeout(r, ms))'
// the module that makes the call itself, for the guarded process (imported for what it does)
const importing = (f) => `import ${JSON.stringify(new URL(`../${f}`, import.meta.url).href)}`

/** Runs `code` as a module in a node process of its own, with no flags but Node's own defaults (`more`: its environment besides). */
function run(code, more = {}) {
  const env = { ...process.env }
  delete env.NODE_OPTIONS // (a developer's --unhandled-rejections would change what is being pinned here)
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
  // lastMessage is for a page (/healthz now, a Health field to come): one line, and no more of it than fits there
  const r = run(`${IMPORT}
guardProcess({ name: 'long' })
Promise.reject(new Error('x'.repeat(1000) + '\\nits second line'))
setTimeout(() => console.log(JSON.stringify(processErrors())), 50)`)
  const m = json(r).lastMessage
  ran('processErrors(): a long reason: lastMessage is its first line, cut at 300 characters', m === `Error: ${'x'.repeat(293)}`, r, `${m?.length} characters`)
  ran('...the line in the log is not cut', kept(r, 'long')[0] === `[long] unhandled rejection (kept running): Error: ${'x'.repeat(1000)}` && r.err.includes('\nits second line\n'), r)
}
{
  // the limit of 20 lines a minute is no limit on their size: a reason that carries a whole reply, or
  // megabytes of it, is logged up to 8,000 characters, both ends, and the log says how long it was
  const r = run(`${IMPORT}
guardProcess({ name: 'huge' })
Promise.reject('y'.repeat(2_999_000) + 'e'.repeat(1000))
Promise.reject('z'.repeat(8000))
setTimeout(() => console.log(JSON.stringify(processErrors())), 50)`)
  const START = '[huge] unhandled rejection (kept running): '
  const k = kept(r, 'huge')
  const all = lines(r.err)
  ran('a reason of 3,000,000 characters: its first 6,000 are logged', k.length === 2 && all[0] === `${START}${'y'.repeat(6000)}`, r, `${all[0]?.length} characters`)
  ran('...the next line says it was cut, and from what', all[1] === '[huge] (that reason is 3000000 characters: the first 6000 and the last 2000 are logged, this line between them)', r, all[1]?.slice(0, 140))
  ran('...and then its last 2,000', all[2] === `${'y'.repeat(1000)}${'e'.repeat(1000)}`, r, `${all[2]?.length} characters`)
  ran('...one of exactly 8,000 is logged whole, with no such line', all[3] === `${START}${'z'.repeat(8000)}` && all.length === 4 && r.err.length < 17_000, r, `${r.err.length} characters on stderr`)
  ran('...both counted, and the process goes on', json(r).unhandledRejections === 2 && json(r).lastMessage === 'z'.repeat(300) && r.status === 0, r)
}
{
  // The log is now the only trace of the fault, so it must say no less than Node did when the process
  // died of it: an Error's cause, the errors of an AggregateError and properties such as code are not
  // in its stack. (A refused fetch is "TypeError: fetch failed" and nothing more without its cause.)
  const r = run(`${IMPORT}
${TURN}
guardProcess({ name: 'rich' })
const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:59999'), { code: 'ECONNREFUSED', syscall: 'connect' })
Promise.reject(new TypeError('fetch failed', { cause: refused }))
await turn()
console.error('[rich] SECOND')
Promise.reject(Object.assign(new Error('the share is not answering'), { code: 'ESHARESTUCK', extra: { retryAfterS: 5 } }))
await turn()
console.error('[rich] THIRD')
Promise.reject(new AggregateError([new Error('first of two'), new RangeError('second of two')], 'both failed'))
await turn()
console.error('[rich] FOURTH')
Promise.reject({ status: 503, why: 'a plain object' })
await turn()
console.log(JSON.stringify(processErrors()))`)
  const part = (from, to) => r.err.slice(r.err.indexOf(from), to ? r.err.indexOf(to) : undefined)
  const one = part('[rich] unhandled', '[rich] SECOND')
  ran('an Error with a cause: the line begins as before, with the error and its stack', kept(r, 'rich')[0] === '[rich] unhandled rejection (kept running): TypeError: fetch failed' && /\n +at /.test(one), r)
  ran('...and the cause is there too, with its own message and its code', one.includes('[cause]') && one.includes('connect ECONNREFUSED 127.0.0.1:59999') && one.includes("code: 'ECONNREFUSED'"), r, flat(one, 300))
  ran('an Error with properties of its own (a code, the retry hint): they are logged', /code: 'ESHARESTUCK'/.test(part('[rich] SECOND', '[rich] THIRD')) && /retryAfterS: 5/.test(part('[rich] SECOND', '[rich] THIRD')), r)
  ran('an AggregateError: the errors inside it are logged', part('[rich] THIRD', '[rich] FOURTH').includes('first of two') && part('[rich] THIRD', '[rich] FOURTH').includes('RangeError: second of two'), r)
  ran('a reason that is a plain object: what is in it, not "[object Object]"', kept(r, 'rich')[3] === "[rich] unhandled rejection (kept running): { status: 503, why: 'a plain object' }", r, kept(r, 'rich')[3])
  ran('...and lastMessage (for a page) stays the short text of the reason', json(r).lastMessage === '[object Object]' && json(r).unhandledRejections === 4 && r.status === 0, r)
}
{
  // The shape a refused fetch to a host name really has: a TypeError with no frame of ours, whose
  // cause is an AggregateError (one error for each address tried), and only those errors say which
  // host and port. They are three levels down: at inspect()'s usual depth of 2 the log had
  // "[errors]: [ [Error], [Error] ]", where Node's message at the death of the process names both.
  // Built by hand, no network. And a chain of causes five long, each with a property of its own.
  const r = run(`${IMPORT}
${TURN}
guardProcess({ name: 'deep' })
const tried = (address) => Object.assign(new Error('connect ECONNREFUSED ' + address + ':59999'), { errno: -111, code: 'ECONNREFUSED', syscall: 'connect', address, port: 59999 })
const refused = Object.assign(new AggregateError([tried('::1'), tried('127.0.0.1')], ''), { code: 'ECONNREFUSED' })
Promise.reject(new TypeError('fetch failed', { cause: refused }))
await turn()
console.error('[deep] SECOND')
let chain = Object.assign(new Error('cause 5'), { step: 'five' })
for (const n of [4, 3, 2, 1]) chain = Object.assign(new Error('cause ' + n, { cause: chain }), { step: 'step-' + n })
Promise.reject(new Error('the top', { cause: chain }))
await turn()
console.error('[deep] THIRD')
Promise.reject({ a: { b: { c: { d: 'four down' } } }, note: 'a plain object' })
await turn()`)
  const part = (from, to) => r.err.slice(r.err.indexOf(from), to ? r.err.indexOf(to) : undefined)
  const one = part('[deep] unhandled', '[deep] SECOND')
  ran('a refused fetch to a host name: each address that was tried is in the log, with its port', one.includes("address: '::1'") && one.includes("address: '127.0.0.1'") && (one.match(/port: 59999/g) ?? []).length === 2 && !one.includes('[Error]'), r, flat(one, 400))
  const two = part('[deep] SECOND', '[deep] THIRD')
  ran('a chain of five causes, each with a property of its own: all five are in the log', ['cause 1', 'cause 2', 'cause 3', 'cause 4', "step: 'step-4'"].every((s) => two.includes(s)), r, flat(two.replace(/\n +at [^\n]+/g, ''), 400))
  // (an object that is no Error: Node's message at death only named its class, and its fields are logged to the usual depth and no deeper)
  ran('a plain object: its fields to the usual depth, and no deeper', kept(r, 'deep')[2] === "[deep] unhandled rejection (kept running): { a: { b: { c: [Object] } }, note: 'a plain object' }" && r.status === 0, r, kept(r, 'deep')[2])
}
{
  // What is logged is worked out only for a line that is logged: inspect() of a large reason takes
  // time, and a fault that loops rejects thousands of times. The same Error 50 times, with its stack
  // behind a getter that counts. The short text (for the count and lastMessage) reads it three times
  // for every rejection; inspect() once more, and only for the 20 that are logged.
  const r = run(`${IMPORT}
${TURN}
guardProcess({ name: 'cost' })
const e = new Error('the same one')
const stack = e.stack
let reads = 0
Object.defineProperty(e, 'stack', { get() { reads++; return stack } })
for (let i = 0; i < 20; i++) Promise.reject(e)
await turn()
const logged = reads
for (let i = 0; i < 30; i++) Promise.reject(e)
await turn()
console.log(JSON.stringify({ logged: logged / 20, notLogged: (reads - logged) / 30, n: processErrors().unhandledRejections }))`)
  const j = json(r)
  ran('the long text is made only for a line that is logged: a rejection over the limit costs less', kept(r, 'cost').length === 20 && j.n === 50 && j.notLogged === 3 && j.logged === 4, r, `stack read ${j.logged}x for each one logged, ${j.notLogged}x for each one not`)
}
{
  // an Error whose message is longer than the cut still has its frames in the log: they come after
  // the message, which is why both ends are kept
  const r = run(`${IMPORT}
guardProcess({ name: 'longmsg' })
function whereItWasThrown() { return Promise.reject(Object.assign(new Error('m'.repeat(20000)), { code: 'ELONG' })) }
whereItWasThrown()
setTimeout(() => console.log('still running'), 50)`)
  ran('an Error with a 20,000-character message: where it was thrown and its code are still in the log', /\n +at whereItWasThrown /.test(r.err) && r.err.includes("code: 'ELONG'") && said(r, 'longmsg').some((l) => /^\[longmsg\] \(that reason is \d+ characters: the first 6000 and the last 2000 are logged/.test(l)) && r.err.length < 9000 && r.out.includes('still running'), r, `${r.err.length} characters on stderr`)
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
// makes the call itself and is the first module server.mjs imports.
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
}

// ---- what it must not do ----------------------------------------------------------------------------
{
  // Node's own flag is stronger than the guard: with --unhandled-rejections=strict a rejection is
  // raised as an uncaught exception before any listener hears of it. Nothing starts the server with
  // it (checked below): if something did, the guard would be there and do nothing
  const r = run(`${importing('process-guard-server.mjs')}
${FAULT}`, { NODE_OPTIONS: '--unhandled-rejections=strict' })
  ran('NODE_OPTIONS=--unhandled-rejections=strict: a guarded process still ends on a rejection nobody catches', Number.isInteger(r.status) && r.status !== 0 && !r.out.includes('still running') && said(r, 'server').length === 0 && r.err.includes(NULL_READ), r)
}
{
  // an exception nobody catches is not a rejection: Node calls carrying on after one unsafe, and
  // systemd starts a new process
  const r = run(`${IMPORT}
guardProcess({ name: 'thrown' })
console.log('listeners ' + process.listenerCount('uncaughtException'))
setTimeout(() => { throw new Error('thrown, not rejected') }, 20)
setTimeout(() => console.log('still running'), 300)`)
  ran('an uncaught exception still ends the process (non-zero status, nothing after it runs)', Number.isInteger(r.status) && r.status !== 0 && !r.out.includes('still running') && r.err.includes('thrown, not rejected'), r)
  ran('...the guard does not listen for it, or say it kept running', r.out.includes('listeners 0') && said(r, 'thrown').length === 0, r)
}
{
  // a module loaded with await import() that throws: a process that cannot load must still end, for
  // what started it to start another, and not sit there guarded with nothing loaded
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

// ---- the wiring (server.mjs needs sdk.mjs, so it is read, not run, here; its shutdown is run) -----------
{
  // (a file that is not there fails its checks rather than ending the run)
  const src = (f) => {
    try {
      return readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    } catch {
      return ''
    }
  }
  /** Every module a file names: after a `from`, in an `import '...'` or in an import(), with either quote. */
  const specifiers = (text) => [...text.matchAll(/\bfrom\s*['"]([^'"\n]+)['"]|^\s*import\s*['"]([^'"\n]+)['"]|\bimport\(\s*['"]([^'"\n]+)['"]/gm)].map((m) => m[1] ?? m[2] ?? m[3])
  /** A file's first line that is neither blank nor a // comment. */
  const firstCode = (text) => text.split('\n').find((l) => l.trim() && !l.trim().startsWith('//')) ?? ''

  const guard = src('process-guard.mjs')
  check('process-guard.mjs imports nothing but node: built-ins (it runs, and is tested, on any machine)', guard.length > 0 && specifiers(guard).every((s) => s.startsWith('node:')), specifiers(guard).join(', '))
  // (anything else it imported would be loaded, and run, before the guard is there)
  check('process-guard-server.mjs imports process-guard.mjs and nothing else', specifiers(src('process-guard-server.mjs')).join() === './process-guard.mjs', specifiers(src('process-guard-server.mjs')).join(', '))

  const server = src('server.mjs')
  // The line itself, not a list of the imports found: a module put above it would be loaded first
  // however it was written (double quotes, a semicolon, an `export ... from`), and a list made by a
  // pattern sees only the ways the pattern knows.
  check("server.mjs: its first line of code is the import of process-guard-server.mjs", firstCode(server) === "import './process-guard-server.mjs'", firstCode(server).slice(0, 80))
  check('...and it makes no late call of its own', server.length > 0 && !/guardProcess/.test(server))
  // (read, not run: that the line is in the /healthz body and that the name it uses is imported from
  // the guard. A typing mistake in either would be an error at start-up or at the first /healthz,
  // which no test here would see: no test starts server.mjs)
  check('server.mjs: /healthz carries the count (errors: processErrors())', /pathname === '\/healthz'[\s\S]{0,2500}?\n\s+errors: processErrors\(\),?\n/.test(server) && /^import \{ processErrors \} from '\.\/process-guard\.mjs'$/m.test(server) && /^export const processErrors = /m.test(guard))

  // Not a worker: one that ends is replaced by its supervisor within seconds, and kept running after
  // a job of its own stopped part-way it would go on reporting ready with nothing to act on that
  // (process-guard.mjs says so at length). share-helper.mjs: its parent turns an exit into a new helper.
  const others = ['nvr-worker.mjs', 'share-helper.mjs', 'report-worker.mjs']
  const guarded = others.filter((f) => /process-guard|unhandledRejection/.test(src(f)))
  check('nvr-worker.mjs, share-helper.mjs and report-worker.mjs are not guarded (they end, and are started again)', others.every((f) => src(f).length > 0) && guarded.length === 0, guarded.join(', '))

  // A shutdown is an async job nobody waits for. A rejection inside one used to end the process by
  // itself, which is what the shutdown was after anyway. Guarded, it is logged and the process kept,
  // half shut down, until systemd's 15 s are up. So the SIGKILL that ends it comes whatever became
  // of the lines before it. The function is run here as it is written, in a process of its own
  // under the guard, with a stand-in for what it calls (the real one needs the SDK).
  /** A function's text: from `start` to the first line after it that is a "}" alone at the left edge. */
  const fn = (text, start) => {
    const at = text.indexOf(start)
    const end = at < 0 ? -1 : text.indexOf('\n}\n', at)
    return end < 0 ? '// (not found)' : text.slice(at, end + 2)
  }
  const STAYED = "setTimeout(() => { console.log('still here'); process.exit(0) }, 2000)"
  const serverStop = (stopNvrs, before = '') => `${importing('process-guard-server.mjs')}
${before}
const stopNvrs = ${stopNvrs}
${fn(server, 'const shutdown = async () => {')}
shutdown()
${STAYED}`
  // (Windows has no signals: a process killed there ends with status 1; one stopped by run()'s 30 s limit is a SIGTERM)
  const killed = (r) => r.signal === 'SIGKILL' || (process.platform === 'win32' && r.status === 1)
  {
    const r = run(serverStop("() => { throw new Error('stopNvrs() failed') }"))
    ran('server.mjs shutdown(): stopNvrs() throws: said, and the process is killed all the same', killed(r) && !r.out.includes('still here') && r.err.startsWith('[server] stopping failed part-way: Error: stopNvrs() failed\n') && kept(r, 'server').length === 0, r)
  }
  {
    const r = run(serverStop('async () => {}'))
    ran('server.mjs shutdown(): nothing to wait for and nothing fails: killed, with nothing said', killed(r) && r.out === '' && r.err === '', r, `${r.ms} ms`)
  }
  {
    // The wait is the time the NVR workers have to close their segments and log out: the kill must
    // come after stopNvrs() is done, not beside it. A stop that takes a while and says when it is done.
    const r = run(serverStop("async () => { await new Promise((r) => setTimeout(r, 400)); console.log('the NVRs are stopped') }"))
    ran('server.mjs shutdown(): it waits for the NVRs to be stopped, and is killed only then', killed(r) && r.out === 'the NVRs are stopped\n' && r.err === '', r, `${r.ms} ms`)
  }
  {
    // ... but not for ever: a stop that never ends is given 9 s (the workers get 8, the unit allows
    // 15). The function is run with a setTimeout of its own that says how long it was asked to wait
    // and waits a tenth of a second instead.
    const SHORT = "const realSetTimeout = globalThis.setTimeout\nconst setTimeout = (f, ms) => realSetTimeout(f, ms >= 1000 && ms !== 2000 ? (console.log('limit ' + ms), 100) : ms)"
    const r = run(serverStop('() => new Promise(() => {})', SHORT))
    ran('server.mjs shutdown(): a stop that never ends is given 9 s, and the process is killed then', killed(r) && r.out === 'limit 9000\n' && r.err === '', r, `${r.ms} ms`)
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
  const starters = [root('deploy/cctv.service'), root('Dockerfile')]
  check('nothing starts the server with --unhandled-rejections (the service, the image)', starters.every((s) => s.length > 0 && !s.includes('unhandled-rejections')))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
