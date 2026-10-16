// A stand-in for the SDK library's functions (what hik-call-thread.mjs binds), for the tests, modelled
// on how the real one keeps its error code (libhpr.so HPR_SetLastError on HPR_ThreadTls_*): one "last
// error" per thread, set by the call that failed and cleared by the next call made on that thread.
// makeLib() is one thread's view: each call has its own error slot, as each thread has in the SDK (a
// call thread imports this module once, so it gets one).
//   Login_V40 to 192.0.2.1 fails with 7 (cannot connect); user "wrong" fails with 1 and fills the lock
//   fields; anything else logs in as user 1.
import { LAYOUT } from '../hik-structs.mjs'

export function makeLib() {
  let lastError = 0
  const ok = (v = 1) => (...args) => {
    lastError = 0
    return v
  }
  const str = (buf, off, n) => {
    const b = Buffer.from(buf.buffer, buf.byteOffset + off, n)
    const end = b.indexOf(0)
    return b.subarray(0, end < 0 ? n : end).toString('utf8')
  }
  const L = LAYOUT.NET_DVR_USER_LOGIN_INFO.fields
  const D = LAYOUT.NET_DVR_DEVICEINFO_V40.fields
  return {
    Init: ok(), Cleanup: ok(), SetConnectTime: ok(), SetReconnect: ok(), SetLogToFile: ok(), SetSDKInitCfg: ok(), SetSDKInitCfgPath: ok(),
    Logout: ok(), StopRealPlay: ok(), GetDVRConfig: ok(),
    GetSDKBuildVersion: () => 0x06010b28, // (does not touch the error, as the real one is not documented to)
    GetLastError: () => lastError,
    Login_V40(li, di) {
      lastError = 0
      const host = str(li, L.sDeviceAddress[0], 129)
      const user = str(li, L.sUserName[0], 64)
      if (host === '192.0.2.1') {
        lastError = 7
        return -1
      }
      if (user === 'wrong') {
        di[D.bySupportLock[0]] = 1
        di[D.byRetryLoginTime[0]] = 2
        lastError = 1
        return -1
      }
      Buffer.from('FAKESERIAL').copy(Buffer.from(di.buffer, di.byteOffset, di.length), 0)
      return 1
    },
    RealPlay_V40(userId) {
      lastError = 0
      if (userId !== 1) {
        lastError = 102 // not logged in
        return -1
      }
      return 200
    },
    SetSDKLocalCfgP2P2C(type, s) {
      lastError = 0
      if (!s?.pAppID) {
        lastError = 17
        return 0
      }
      return 1
    }
  }
}
