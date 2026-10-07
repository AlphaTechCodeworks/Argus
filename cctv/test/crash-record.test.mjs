// A JavaScript error that ends the process leaves a file behind (crash-record.mjs): what it was,
// where, and how long the process had been up. On 2026-10-07 the service restarted by itself at
// 06:10 and nothing said why: the watchdog had not fired, and the journal no longer reached back.
// The record is written by a monitor, which only watches: the process still ends as it would have.
// Each case runs in a child process, because the thing under test is a process dying.
// Run:  node cctv/test/crash-record.test.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const mod = new URL('../crash-record.mjs', import.meta.url).href
/** Runs `body` in a child after recordCrashes(); returns its exit and the record it left, if any. */
const run = (body, env = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'crash-'))
  const code = `import { recordCrashes } from '${mod}'\nrecordCrashes({ dataDir: ${JSON.stringify(dir)} })\n${body}`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20_000 })
  const file = join(dir, `last-crash${env.CCTV_WORKER_NVR ? `-${env.CCTV_WORKER_NVR}` : ''}.json`)
  return { status: r.status, stderr: r.stderr, dir, file, record: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null }
}

{
  const r = run(`setTimeout(() => { throw new TypeError('nvr.worker is null') }, 20)`)
  check('a thrown error still ends the process with an error status', r.status === 1, String(r.status))
  check('... and still prints its stack, as before', /TypeError: nvr\.worker is null/.test(r.stderr))
  check('the record names the error', r.record?.name === 'TypeError' && r.record?.message === 'nvr.worker is null', JSON.stringify(r.record)?.slice(0, 120))
  check('... carries the stack', /TypeError: nvr\.worker is null\n\s+at /.test(r.record?.stack ?? ''))
  check('... says it was thrown, when, and how long the process had run', r.record?.origin === 'uncaughtException' && Math.abs(Date.parse(r.record?.at) - Date.now()) < 60_000 && r.record?.uptimeS >= 0 && r.record?.pid > 0)
}
{
  const r = run(`Promise.reject(new Error('the NVR did not answer'))\nsetTimeout(() => {}, 200)`)
  check('a rejection nobody handles ends the process too', r.status === 1, String(r.status))
  check('... and is recorded as one', r.record?.origin === 'unhandledRejection' && r.record?.message === 'the NVR did not answer', JSON.stringify(r.record)?.slice(0, 120))
}
{
  const r = run(`setTimeout(() => { throw 'a bare string' }, 20)`)
  check('something thrown that is not an Error is recorded as text', r.record?.message === 'a bare string' && r.record?.stack === null, JSON.stringify(r.record)?.slice(0, 120))
}
{
  const r = run(`setTimeout(() => { throw new Error('in a worker') }, 20)`, { CCTV_WORKER_NVR: 'nvr-2' })
  check("a live worker keeps its own record, apart from the main process's", r.record?.message === 'in a worker' && r.record?.worker === 'nvr-2' && !existsSync(join(r.dir, 'last-crash.json')))
}
{
  const r = run(`setTimeout(() => process.exit(0), 20)`)
  check('a process that ends normally leaves no record', r.status === 0 && r.record === null)
}
{
  // the folder is gone: the record cannot be written, and that must not change how the process ends
  const dir = join(tmpdir(), `crash-missing-${Date.now()}`, 'nope')
  const code = `import { recordCrashes } from '${mod}'\nrecordCrashes({ dataDir: ${JSON.stringify(dir)} })\nsetTimeout(() => { throw new Error('still dies') }, 20)`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20_000 })
  check('a record that cannot be written does not get in the way', r.status === 1 && /Error: still dies/.test(r.stderr), `${r.status}`)
}
{
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  check('the server records its crashes', /recordCrashes\(\{ dataDir: auth\.DATA_DIR \}\)/.test(src('server.mjs')))
  check('each live worker records its own', /recordCrashes\(\{ dataDir: DATA_DIR \}\)/.test(src('nvr-worker.mjs')))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
