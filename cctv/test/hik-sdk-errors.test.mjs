// A failed SDK call's error code (prod smoke 2026-10-16: "login failed: error 0: no error"). The SDK
// keeps its last error per thread and the next call on that thread clears it; fake-hik-lib.mjs models
// exactly that. Checked:
//   - reading the error as a separate call, on another thread (what hik-sdk.mjs used to do), gives 0;
//   - runCall reads it on the same thread straight after the failing call, and gets it;
//   - through the real call threads (worker_threads, hik-call-thread.mjs) and hik-sdk.mjs's own
//     login(): code 7 for an address with nothing on it, 1 with the tries left for a wrong password,
//     while other calls run on the other threads at the same time.
// No SDK, no koffi, no device.   node cctv/test/hik-sdk-errors.test.mjs
import { fileURLToPath } from 'node:url'
import { failed, makeCallPool, runCall } from '../hik-call-thread.mjs'
import { loginErrorText } from '../hik-core.mjs'
import { bindSdk, makeCaller } from '../hik-sdk.mjs'
import { alloc, writeField } from '../hik-structs.mjs'
import { makeLib } from './fake-hik-lib.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const loginInfo = (host, user = 'admin') => {
  const li = alloc('NET_DVR_USER_LOGIN_INFO')
  writeField(li, 'NET_DVR_USER_LOGIN_INFO', 'sDeviceAddress', host)
  writeField(li, 'NET_DVR_USER_LOGIN_INFO', 'wPort', 8000)
  writeField(li, 'NET_DVR_USER_LOGIN_INFO', 'sUserName', user)
  return li
}

// ---- the rule, on two "threads" ----
const threadA = makeLib()
const threadB = makeLib()
check('failed(): -1 for a handle/user id, FALSE for a BOOL, never for a version', failed('Login_V40', -1) && !failed('Login_V40', 0) && failed('GetDVRConfig', 0) && !failed('GetDVRConfig', 1) && !failed('GetSDKBuildVersion', 0))
check('the login fails on thread A', threadA.Login_V40(loginInfo('192.0.2.1'), alloc('NET_DVR_DEVICEINFO_V40')) === -1)
check('the old way: GetLastError as its own call, on another thread, reads 0', threadB.GetLastError() === 0)
threadA.Init()
check('... and on the same thread after any other call it reads 0 too', threadA.GetLastError() === 0)
const r = runCall(threadA, 'Login_V40', [loginInfo('192.0.2.1'), alloc('NET_DVR_DEVICEINFO_V40')])
check('runCall: the error read right after the failing call, on its thread: 7', r.res === -1 && r.err === 7, JSON.stringify(r))
check('runCall: no error read for a call that worked', runCall(threadA, 'Init', []).err === 0)

// ---- the real call threads ----
const fakeLib = fileURLToPath(new URL('./fake-hik-lib.mjs', import.meta.url))
const pool = makeCallPool({ fakeLib, threads: 3 })
try {
  const di = alloc('NET_DVR_DEVICEINFO_V40')
  // logins that fail and work, side by side on every thread at once
  const runs = await Promise.all([
    pool.call('Login_V40', [loginInfo('192.0.2.1'), di]),
    pool.call('Login_V40', [loginInfo('192.168.1.64'), alloc('NET_DVR_DEVICEINFO_V40')]),
    pool.call('Init', []),
    pool.call('Login_V40', [loginInfo('192.168.1.64', 'wrong'), alloc('NET_DVR_DEVICEINFO_V40')]),
    pool.call('GetSDKBuildVersion', [])
  ])
  check('pool: a login to nothing comes back -1 with error 7', runs[0].res === -1 && runs[0].err === 7, JSON.stringify(runs[0].err))
  check('pool: one that works comes back with a user id and error 0, its device info filled in', runs[1].res === 1 && runs[1].err === 0 && runs[1].args[1].subarray(0, 10).toString() === 'FAKESERIAL')
  check('pool: a wrong password comes back with error 1', runs[3].res === -1 && runs[3].err === 1)
  check('pool: a value is a value (no error read)', runs[4].res === 0x06010b28 && runs[4].err === 0)
  check('pool: an unknown function is refused, not crashed on', await pool.call('Nope', []).then(() => false, (e) => /not bound/.test(e.message)))

  // hik-sdk.mjs itself, on the pool (its ES callback needs koffi, which is stubbed: no stream is started here)
  const koffi = { proto: () => ({}), register: () => ({}), pointer: (t) => t }
  const lib = { func: () => ({ async: (...a) => a.at(-1)(null, 1) }) }
  const sdk = bindSdk({ koffi, lib, types: {}, dir: '/opt/cctv/hcnetsdk/current', pool })
  const init = await sdk.init({})
  check('sdk.init through the call threads', init.ok === true, JSON.stringify(init))
  const dead = await sdk.login({ host: '192.0.2.1', port: 8000, user: 'admin', password: '' })
  check('sdk.login to an address with nothing on it: code 7, "cannot connect" (the prod smoke read 0)', dead.userId === -1 && dead.code === 7 && /cannot connect/.test(loginErrorText(dead.code, dead.info)), JSON.stringify({ userId: dead.userId, code: dead.code }))
  const wrong = await sdk.login({ host: '192.168.1.64', port: 8000, user: 'wrong', password: 'x' })
  check('sdk.login with a wrong password: code 1, with the tries left from the device info', wrong.code === 1 && loginErrorText(wrong.code, wrong.info) === 'wrong user name or password (2 tries left before the user is locked)', loginErrorText(wrong.code, wrong.info))
  const good = await sdk.login({ host: '192.168.1.64', port: 8000, user: 'admin', password: 'x' })
  check('sdk.login that works: user 1, serial from the device info', good.userId === 1 && good.info.serial === 'FAKESERIAL')
  const p2p = await sdk.p2pLogin2C({ platformType: 0, appId: '', authAddr: 'a', platformAddr: 'p', account: 'x', password: 'y' })
  check('sdk.p2pLogin2C refused: its own error code (17)', p2p.ok === false && p2p.code === 17)
  const live = await sdk.startLive(5, 33, 1, () => {})
  check('sdk.startLive refused (not logged in): its own error code (102)', live.handle === -1 && live.code === 102 && live.step === 'RealPlay_V40')
  const cl = await sdk.cleanup()
  check('sdk.cleanup: { ok, code }', cl.ok === true && cl.code === 0)

  // a call over its limit: rejected, and its late result goes to onLate
  const slow = { call: () => new Promise((r) => setTimeout(() => r({ res: 3, err: 0 }), 150)) }
  let late = null
  const caller = makeCaller(slow)
  const timedOut = await caller.call('NET_DVR_Login_V40', 50, 'Login_V40', [], (v) => (late = v)).then(() => false, (e) => e.name === 'HikTimeout')
  await new Promise((r) => setTimeout(r, 200))
  check('a call over its limit is a HikTimeout, and its late result (a login) reaches onLate', timedOut && late === 3)
} finally {
  await pool.close()
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
