// The Hikvision SDK's calls, made on threads of our own so that each failing call's error code can be
// read on the thread that made it.
//
// Why: the SDK keeps its last error PER THREAD. libhpr.so's HPR_SetLastError/HPR_GetLastError sit on
// HPR_ThreadTls_* (pthread keys; the library imports __tls_get_addr and pthread_getspecific), and
// libHCCore.so has StreamTransClient_GetLastErrorByTls. A koffi .async call runs on whichever libuv pool
// thread is free, so a NET_DVR_GetLastError made as its own async call after a failed NET_DVR_Login_V40
// usually ran on another thread and read 0 ("login failed: error 0: no error" on prod, 2026-10-16).
//
// So every call goes to one of a few call threads (worker_threads), runs there synchronously, and when
// it failed, NET_DVR_GetLastError is called right after it on the same thread, before anything else can
// run there: runCall below. The main thread never blocks (the SDK's ES callback is registered and runs
// there: hik-sdk.mjs). Buffers passed as void * come back filled (they are copied both ways).
//
//   main thread:  makeCallPool({ libPath, threads }) -> { call(fn, args) -> Promise<{ res, err, args }>, close() }
//   call thread:  this file with workerData.hikCallThread (libPath, or fakeLib: a module for the tests)
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

/** The ES callback's type (HCNetSDK.h 51935): void (LONG lPreviewHandle, NET_DVR_PACKET_INFO_EX *pstruPackInfo, void *pUser). */
export const ES_CALLBACK = 'void HikEsRealPlayCallBack(int32_t lPreviewHandle, void *pstruPackInfo, void *pUser)'

/**
 * Every function bound, as koffi's lib.func arguments (the tests parse each one with koffi). LONG,
 * BOOL and DWORD are 32-bit on Linux (HCNetSDK.h 35-48); an enum parameter is an int; structures go
 * as void * Buffers, except NET_SDK_P2P_SERVER_2C, which koffi builds from an object for one call.
 */
export const FUNCTIONS = {
  // 51942: BOOL NET_DVR_SetSDKInitCfg(NET_SDK_INIT_CFG_TYPE enumType, void* const lpInBuff)
  SetSDKInitCfg: ['int NET_DVR_SetSDKInitCfg(int enumType, void *lpInBuff)'],
  // the same function for the string-valued types (LIBEAY_PATH, SSLEAY_PATH: "Path in string format", guide 12.1.40)
  SetSDKInitCfgPath: ['NET_DVR_SetSDKInitCfg', 'int', ['int', 'const char *']],
  Init: ['int NET_DVR_Init()'], // 50930
  Cleanup: ['int NET_DVR_Cleanup()'], // 50931
  SetConnectTime: ['int NET_DVR_SetConnectTime(uint32_t dwWaitTime, uint32_t dwTryTimes)'], // 50958
  SetReconnect: ['int NET_DVR_SetReconnect(uint32_t dwInterval, int bEnableRecon)'], // 50959
  GetSDKBuildVersion: ['uint32_t NET_DVR_GetSDKBuildVersion()'], // 50961
  Login_V40: ['int32_t NET_DVR_Login_V40(void *pLoginInfo, void *lpDeviceInfo)'], // 50978
  Logout: ['int NET_DVR_Logout(int32_t lUserID)'], // 50981
  GetLastError: ['uint32_t NET_DVR_GetLastError()'], // 50983
  // 50999: LONG NET_DVR_RealPlay_V40(LONG lUserID, LPNET_DVR_PREVIEWINFO, REALDATACALLBACK, void *pUser)
  RealPlay_V40: ['int32_t NET_DVR_RealPlay_V40(int32_t lUserID, void *lpPreviewInfo, void *fRealDataCallBack_V30, void *pUser)'],
  StopRealPlay: ['int NET_DVR_StopRealPlay(int32_t lRealHandle)'], // 51003
  // 51340: BOOL NET_DVR_GetDVRConfig(LONG lUserID, DWORD dwCommand, LONG lChannel, LPVOID lpOutBuffer, DWORD dwOutBufferSize, LPDWORD lpBytesReturned)
  GetDVRConfig: ['int NET_DVR_GetDVRConfig(int32_t lUserID, uint32_t dwCommand, int32_t lChannel, void *lpOutBuffer, uint32_t dwOutBufferSize, void *lpBytesReturned)'],
  SetLogToFile: ['int NET_DVR_SetLogToFile(uint32_t nLogLevel, const char *strLogDir, int bAutoDel)'], // 51370
  SetESRealPlayCallBack: ['int NET_DVR_SetESRealPlayCallBack(int32_t iRealHandle, HikEsRealPlayCallBack *fPlayESCallBack, void *pUser)'], // 51935
  // 51863: BOOL NET_DVR_SetSDKLocalCfg(NET_SDK_LOCAL_CFG_TYPE enumType, const void *lpInBuff), with NET_SDK_P2P_SERVER_2C (32081)
  SetSDKLocalCfgP2P2C: ['NET_DVR_SetSDKLocalCfg', 'int', ['int', 'HIK_NET_SDK_P2P_SERVER_2C *']]
}

/** Functions that return a LONG handle or user id: -1 is failure. The BOOL ones fail with 0 (FALSE). */
const RETURNS_HANDLE = new Set(['Login_V40', 'RealPlay_V40'])
/** Functions whose answer is a value, never a failure. */
const NEVER_FAIL = new Set(['GetSDKBuildVersion', 'GetLastError'])
/** Whether this result of `fn` is a failure (so its error code must be read now, on this thread). */
export const failed = (fn, res) => (NEVER_FAIL.has(fn) ? false : RETURNS_HANDLE.has(fn) ? res < 0 : !res)

/**
 * One call, synchronously, on the calling thread; when it failed, NET_DVR_GetLastError straight after
 * it on the same thread, with nothing in between. err is 0 when the call did not fail.
 * @param {Record<string, Function>} F the bound functions @returns {{ res: any, err: number }}
 */
export function runCall(F, fn, args) {
  const res = F[fn](...args)
  const err = failed(fn, res) ? Number(F.GetLastError()) : 0
  return { res, err }
}

// ---- the call thread ------------------------------------------------------------------------------
if (!isMainThread && workerData?.hikCallThread) {
  let F
  if (workerData.fakeLib) {
    // tests: a stand-in library (one module instance per thread, so its "last error" is per thread too)
    F = (await import(pathToFileURL(workerData.fakeLib).href)).makeLib()
  } else {
    const koffi = (await import('koffi')).default
    // calls are synchronous here: a roomy stack for them, before this thread's first load (how deep
    // this SDK's own stack goes is not known; one TVT SDK function needed 128 KiB, sdk.mjs)
    try {
      koffi.config({ ...koffi.config(), sync_stack_size: 4 << 20 })
    } catch {}
    const { defineHikTypes } = await import('./hik-structs.mjs')
    defineHikTypes(koffi) // (the P2P structure's type, by name, for SetSDKLocalCfgP2P2C)
    koffi.proto(ES_CALLBACK)
    const lib = koffi.load(workerData.libPath)
    // SetESRealPlayCallBack is made on the main thread, where the callback lives (hik-sdk.mjs)
    F = Object.fromEntries(Object.entries(FUNCTIONS).filter(([k]) => k !== 'SetESRealPlayCallBack').map(([k, sig]) => [k, lib.func(...sig)]))
  }
  parentPort.on('message', ({ id, fn, args }) => {
    let out
    try {
      if (!F[fn]) throw new Error(`${fn} is not bound on the call thread`)
      out = { id, ...runCall(F, fn, args), args }
    } catch (e) {
      out = { id, error: e?.message ?? String(e) }
    }
    parentPort.postMessage(out)
  })
  parentPort.postMessage({ ready: true })
}

// ---- the main thread's side --------------------------------------------------------------------------

/**
 * A few call threads. call(fn, args) goes to the least busy one; it resolves { res, err, args } (args:
 * the Buffers as the SDK left them, already copied back into the caller's Buffers).
 * @param {{ libPath?: string, fakeLib?: string, threads?: number }} o
 */
export function makeCallPool({ libPath, fakeLib, threads = 3 } = {}) {
  const pool = []
  let seq = 0
  const spawn = () => {
    const w = new Worker(new URL(import.meta.url), { workerData: { hikCallThread: true, libPath, fakeLib } })
    const t = { w, pending: new Map(), dead: null }
    w.unref()
    w.on('message', (m) => {
      if (m?.ready) return
      const p = t.pending.get(m.id)
      if (!p) return
      t.pending.delete(m.id)
      if (m.error) return p.reject(new Error(m.error))
      // the SDK's writes into Buffers passed as void * come back as copies: put them where the caller looks
      for (let i = 0; i < p.args.length; i++) {
        const mine = p.args[i]
        const back = m.args?.[i]
        if (Buffer.isBuffer(mine) && back instanceof Uint8Array && back.length === mine.length) mine.set(back)
      }
      p.resolve({ res: m.res, err: m.err, args: p.args })
    })
    const fail = (why) => {
      t.dead = why
      for (const p of t.pending.values()) p.reject(new Error(`the SDK call thread stopped: ${why}`))
      t.pending.clear()
    }
    w.on('error', (e) => fail(e?.message ?? String(e)))
    w.on('exit', (code) => fail(`exit ${code}`))
    return t
  }
  for (let i = 0; i < threads; i++) pool.push(spawn())
  return {
    call(fn, args = []) {
      const live = pool.filter((t) => !t.dead)
      if (!live.length) return Promise.reject(new Error('no SDK call thread is running'))
      const t = live.reduce((a, b) => (b.pending.size < a.pending.size ? b : a))
      const id = ++seq
      return new Promise((resolve, reject) => {
        t.pending.set(id, { resolve, reject, args })
        t.w.postMessage({ id, fn, args })
      })
    },
    busy: () => pool.map((t) => t.pending.size),
    close: () => Promise.all(pool.map((t) => t.w.terminate().catch(() => {})))
  }
}
