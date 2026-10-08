// The main process leaves a control login untried while the NVR's own worker cannot get in either
// (login-hold.mjs): a doomed login by serial number holds the one login lane for ~20 s, and playback
// logins to healthy NVRs waited behind it.
//   node cctv/test/login-hold.test.mjs
import { readFileSync } from 'node:fs'
import { FORCE_TRY_MS, HOLD_CHECK_MS, holdControlLogin } from '../login-hold.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const down = { sn: 'N4E6F159AB6U', failed: true, workerState: 'ready', workerStatus: 'connecting', sinceTryMs: 30_000 }

check('held: by serial, this process failed, the worker is not in either', holdControlLogin(down) === true)
check('held while the worker says offline too', holdControlLogin({ ...down, workerStatus: 'offline' }) === true)
check('the first attempt is always made', holdControlLogin({ ...down, failed: false }) === false)
check('made as soon as the worker is in', holdControlLogin({ ...down, workerStatus: 'online' }) === false)
check('an NVR reached by address is never held (it is probed over TCP outside the lane)', holdControlLogin({ ...down, sn: '' }) === false && holdControlLogin({ ...down, sn: undefined }) === false)
check('no worker, or one not running yet, holds nothing', holdControlLogin({ ...down, workerState: undefined }) === false && holdControlLogin({ ...down, workerState: 'starting' }) === false && holdControlLogin({ ...down, workerState: 'restarting' }) === false)
check('a worker that has not said anything yet holds nothing', holdControlLogin({ ...down, workerStatus: undefined }) === false && holdControlLogin({ ...down, workerStatus: '' }) === false)
check('an attempt is made anyway every FORCE_TRY_MS', holdControlLogin({ ...down, sinceTryMs: FORCE_TRY_MS - 1 }) === true && holdControlLogin({ ...down, sinceTryMs: FORCE_TRY_MS }) === false)
check('... and when the time of the last attempt is not known', holdControlLogin({ ...down, sinceTryMs: NaN }) === false && holdControlLogin({ ...down, sinceTryMs: undefined }) === false)
check('the figures: looked at again within seconds, tried anyway within minutes', HOLD_CHECK_MS <= 10_000 && FORCE_TRY_MS >= 5 * 60_000 && FORCE_TRY_MS <= 30 * 60_000)

// What it is for, in numbers: three unreachable NVRs retried once a minute, 20 s each, against the same
// three held and tried once every FORCE_TRY_MS.
{
  const LOGIN_MS = 20_000
  const before = (3 * LOGIN_MS) / 60_000
  const after = (3 * LOGIN_MS) / FORCE_TRY_MS
  check('the lane was taken up all the time by three doomed logins, and is now free nine-tenths of it', before >= 1 && after <= 0.1, `${before} -> ${after}`)
}

// nvrs.mjs uses it (read as text: nvrs.mjs loads the SDK, which a Windows PC cannot)
{
  const src = readFileSync(new URL('../nvrs.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  check('nvrs.mjs: #connect asks before each login, with the worker\'s own word', /holdControlLogin\(\{\s*sn,\s*failed: this\.controlFailed,\s*workerState: this\.worker\?\.state\(\),\s*workerStatus: this\.worker\?\.stats\(\)\?\.status,\s*sinceTryMs: Date\.now\(\) - this\.lastLoginTryAt\s*\}\)/.test(src))
  check('nvrs.mjs: ... and a held turn makes no login and does not lengthen the back-off', /await sleep\(jittered\(HOLD_CHECK_MS\)\)\n\s*delay = RETRY_MIN_MS \/ 2\n\s*continue/.test(src))
  check('nvrs.mjs: ... and the time of each real attempt is kept', /this\.lastLoginTryAt = Date\.now\(\)\n\s*const \{ userId, why \} = await login\(/.test(src))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exitCode = failures ? 1 : 0
