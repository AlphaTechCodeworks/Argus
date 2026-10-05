// One unreachable NVR must not take the server down.
//
// The live fault this covers: an NVR whose network had failed did not answer a TCP connection at
// all; NET_SDK_Login then blocked inside the SDK for over 90 s, the watchdog read that as a hung
// SDK and SIGKILLed the process, systemd restarted it, and round it went — five kills in six
// minutes, with the four healthy NVRs and their cameras losing recording each time.
//
// Covered here: an unreachable NVR fails its login without any SDK call and backs off as usual;
// a reachable one still logs in normally; a stuck login alone does not trip the watchdog; one
// NVR's stuck call does not trip it while other NVRs' calls keep returning; and the watchdog
// still SIGKILLs the process for the case it was built for (a genuinely wedged SDK).
//
// Needs the Linux SDK library (nvrs.mjs -> sdk.mjs loads it through koffi), so run it inside the
// container, not on Windows:  node cctv/test/unreachable-nvr.test.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'unreach-'))
process.env.UV_THREADPOOL_SIZE = '64' // as in the container (sdk.mjs sizes its native-call cap from it)
const { NET_SDK } = await import('../sdk.mjs')

const print = console.log.bind(console)
const out = [] // what the app logged (printed only if something fails)
console.log = (...a) => out.push(a.join(' '))
console.warn = (...a) => out.push(a.join(' '))

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  print(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const until = async (cond, maxMs) => {
  for (const end = Date.now() + maxMs; Date.now() < end; await sleep(50)) if (cond()) return true
  return cond()
}

// ---- fake SDK: every NET_SDK function is replaced, so none of these calls can reach the real one
const log = [] // { fn, host, at }
const answers = {
  // only the address the test listener is on logs in; the login itself is instant here, because
  // what is being tested is whether it is attempted at all
  Login: (host) => (host === '127.0.0.1' ? 42 : -1),
  GetLastError: () => 0
}
for (const name of Object.keys(NET_SDK)) {
  const answer = answers[name] ?? (() => true)
  NET_SDK[name] = {
    fake: true,
    async(...args) {
      const plain = args.slice(0, -1)
      log.push({ fn: name, host: typeof plain[0] === 'string' ? plain[0] : '', at: Date.now() })
      setTimeout(() => args.at(-1)(null, answer(...plain)), 5)
    }
  }
}
if (!Object.values(NET_SDK).every((f) => f.fake)) throw new Error('the SDK is not fully faked: not running')

const { Nvr } = await import('../nvrs.mjs')
const calls = (fn) => log.filter((c) => c.fn === fn)
const cfg = (id, host, port) => ({ id, site: 'Lab', name: `NVR ${id}`, host, port, user: 'test', password: 'test' })
/** A listening socket on 127.0.0.1, standing in for an NVR that is on the network. */
const listen = () =>
  new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })

// ---- an unreachable NVR fails fast, with no SDK call at all ----------------
{
  // a port with nothing on it: the connection is refused, which is "not there" just as a
  // connection that never answers is (that one is covered in probe.test.mjs, where the timing
  // can be controlled without waiting on a real dead address)
  const { server, port } = await listen()
  await new Promise((r) => server.close(r))
  const t0 = Date.now()
  const dead = new Nvr(cfg('dead', '127.0.0.1', port))
  const failed = () => out.filter((l) => l.startsWith('[dead] login to') && l.includes('failed'))
  check('an unreachable NVR fails its first login attempt', await until(() => failed().length >= 1, 4000), failed().join(' | '))
  check('... without making any SDK call', calls('Login').length === 0 && calls('LoginEx').length === 0, `${log.map((c) => c.fn).join(',')}`)
  check('... quickly (well inside the watchdog limits, which is the whole point)', Date.now() - t0 < 4000, `${Date.now() - t0} ms`)
  check('... saying where it could not be reached', /127\.0\.0\.1:/.test(dead.error ?? ''), dead.error)
  check('... and is simply offline, like any other failed login', dead.status === 'offline', dead.status)

  // the retry backoff still applies: the next attempt is ~5 s later (RETRY_MIN_MS), not a hot loop
  check('it does not retry in a tight loop', failed().length === 1, `${failed().length} attempts in ${Date.now() - t0} ms`)
  const second = await until(() => failed().length >= 2, 7000)
  const gap = failed().length >= 2 ? Date.now() - t0 : 0
  check('... it retries after the usual backoff', second && gap >= 4500, `second attempt after ~${gap} ms`)
  check('... still without any SDK call', calls('Login').length === 0)
  await dead.stop()
}

// ---- a reachable NVR still logs in normally --------------------------------
{
  const { server, port } = await listen()
  const live = new Nvr(cfg('live', '127.0.0.1', port))
  check('a reachable NVR logs in as before', await until(() => live.online, 8000), `${live.status} ${live.error ?? ''}`)
  check('... through the SDK login', calls('Login').length === 1, `${calls('Login').length} Login calls`)
  await live.stop()
  server.close()
}

// ---- the watchdog ----------------------------------------------------------
// Two changes, both about telling "an NVR is broken" from "the SDK is wedged". A wedged SDK is
// what the watchdog exists for (a heap-corruption crash), and it must still fire for that.
const watchdogChild = async (body, env) => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-'))
  const code = `
    import { startWatchdog } from '${new URL('../watchdog.mjs', import.meta.url).href}'
    import { sdkCallT } from '${new URL('../sdk.mjs', import.meta.url).href}'
    const stuck = (tag, opts = {}) => sdkCallT({ timeoutMs: 100, tag, ...opts }, { async() {} }).catch(() => {})
    const quick = { async(...a) { setTimeout(() => a.at(-1)(null, 1), 10) } }
    const keepReturning = (nvr) => setInterval(() => sdkCallT({ timeoutMs: 500, nvr, tag: 'quick' }, quick).catch(() => {}), 150)
    startWatchdog()
    ${body}
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, DATA_DIR: dir, UV_THREADPOOL_SIZE: '64', WATCHDOG_GRACE_MS: '0', WATCHDOG_CHECK_MS: '200', WATCHDOG_MAX_CALL_MS: '1500', WATCHDOG_PROGRESS_MS: '800', ...env },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const t0 = Date.now()
  const [exitCode, signal] = await new Promise((resolve) => child.on('exit', (c, sig) => resolve([c, sig])))
  let dump = null
  try {
    dump = JSON.parse(readFileSync(join(dir, 'last-hang.json'), 'utf8'))
  } catch {}
  return { exitCode, signal, took: Date.now() - t0, stderr, dump }
}
const RAN_ON = `setTimeout(() => { process.stderr.write('still running\\n'); process.exit(0) }, 4000)`

{
  // the case the watchdog was built for: a call stuck in the SDK with nothing else coming back
  const r = await watchdogChild(`stuck('stuck stop', { nvr: 'nvr-a' }); ${RAN_ON}`)
  check('the watchdog still SIGKILLs the process for a stuck SDK call with nothing else returning', r.signal === 'SIGKILL' && /stuck for/.test(r.dump?.reason ?? ''), `${r.signal ?? r.exitCode}: ${r.dump?.reason}`)
}
{
  // a login blocks inside this SDK by nature; on its own that is an NVR fault, not a hung library
  const r = await watchdogChild(`stuck('login', { nvr: 'nvr-a', mayBlock: true }); ${RAN_ON}`)
  check('a stuck login alone does not kill the process', r.signal === null && r.exitCode === 0 && r.stderr.includes('still running'), `${r.signal ?? r.exitCode}: ${r.stderr.split('\n').find((l) => l.includes('[watchdog]')) ?? ''}`)
}
{
  // ... but an ordinary call stuck alongside it still does, and the reason names that call
  const r = await watchdogChild(`stuck('login', { nvr: 'nvr-a', mayBlock: true }); stuck('stuck stop', { nvr: 'nvr-a' }); ${RAN_ON}`)
  check('a stuck login does not mask an ordinary stuck call', r.signal === 'SIGKILL' && /stuck stop/.test(r.dump?.reason ?? ''), `${r.signal ?? r.exitCode}: ${r.dump?.reason}`)
}
{
  // one NVR wedged, the others answering: killing the process would only lose the healthy ones
  const r = await watchdogChild(`stuck('stuck stop', { nvr: 'nvr-bad' }); keepReturning('nvr-ok'); ${RAN_ON}`)
  check('one NVR’s stuck call does not kill the process while another NVR keeps answering', r.signal === null && r.exitCode === 0 && r.stderr.includes('still running'), `${r.signal ?? r.exitCode}: ${r.stderr.split('\n').find((l) => l.includes('[watchdog]')) ?? ''}`)
}
{
  // the same NVR's own quick calls are no evidence: the library could still be wedged for the rest
  const r = await watchdogChild(`stuck('stuck stop', { nvr: 'nvr-bad' }); keepReturning('nvr-bad'); ${RAN_ON}`)
  check('the stuck NVR’s own returning calls do not excuse it', r.signal === 'SIGKILL' && /stuck for/.test(r.dump?.reason ?? ''), `${r.signal ?? r.exitCode}: ${r.dump?.reason}`)
}
{
  // and when the healthy NVR stops answering too, the SDK is wedged and the watchdog fires
  const r = await watchdogChild(`stuck('stuck stop', { nvr: 'nvr-bad' }); const t = keepReturning('nvr-ok'); setTimeout(() => clearInterval(t), 500); ${RAN_ON}`)
  check('when the other NVRs stop answering as well, the watchdog fires', r.signal === 'SIGKILL' && /stuck for/.test(r.dump?.reason ?? ''), `${r.signal ?? r.exitCode}: ${r.dump?.reason}`)
}

if (failures) print(`\napp log:\n${out.join('\n')}`)
print(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
