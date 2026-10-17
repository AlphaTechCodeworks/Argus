// The Hikvision HCNetSDK (Device Network SDK V6.1.11.40, Linux 64-bit) through koffi: only the
// functions Argus needs, declared exactly as in incEn/HCNetSDK.h (hik-call-thread.mjs FUNCTIONS, with
// the header's line numbers). Loaded only in a Hikvision child process (hik-worker.mjs,
// hik-test-login.mjs, tools/hik-smoke.mjs), never in the server or a TVT worker, so a crash inside this
// SDK ends that one process and nothing else.
//
// Structures are passed as Buffers (void *) filled at the offsets of hik-structs.mjs LAYOUT; before
// anything is called, LAYOUT is checked against koffi's own layout of the same structures, and a
// mismatch refuses to start (it would mean the transcription is wrong).
//
// Every call runs on one of a few SDK call threads (hik-call-thread.mjs), with a time limit here. The
// SDK keeps its last error per thread, so a call's error code is read on its own thread right after it
// failed and comes back with the result ({ res, err }); NET_DVR_GetLastError is never called on its
// own. Only NET_DVR_SetESRealPlayCallBack is made from this (main) thread, where the callback lives,
// and the callback's packets arrive here; this thread never blocks on the SDK.
//
//   openHikSdk({ dir }) -> { ok: true, sdk } | { ok: false, why }   (why NOT_INSTALLED when it is not there)
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ES_CALLBACK, FUNCTIONS, makeCallPool } from './hik-call-thread.mjs'
import { NOT_INSTALLED, parseDeviceCfgV40, parseDeviceInfoV40 } from './hik-core.mjs'
import { INIT_CFG, LAYOUT, LOCAL_CFG, LOG_ERRORS_ONLY, NET_DVR_GET_DEVICECFG_V40, NET_DVR_GET_IPPARACFG_V40, alloc, defineHikTypes, layoutMismatches, writeField } from './hik-structs.mjs'

export { ES_CALLBACK, FUNCTIONS }

/** Per-call time limits (ms). A login to an address that does not answer takes SetConnectTime x tries. */
const BUDGET = { init: 15_000, login: 30_000, logout: 10_000, config: 15_000, realplay: 15_000, stop: 10_000, p2p: 30_000, other: 10_000 }
const CONNECT_WAIT_MS = 5000
const CONNECT_TRIES = 3
/** SDK call threads: logins, stream starts (up to 5 s each when a camera does not answer) and stops in parallel. */
const CALL_THREADS = 4

export class HikTimeout extends Error {
  constructor(what, ms) {
    super(`${what} did not return within ${Math.round(ms / 1000)} s`)
    this.name = 'HikTimeout'
  }
}

/** The library file under the SDK's lib directory. */
export const hikLibPath = (dir) => join(dir, 'libhcnetsdk.so')

/**
 * Loads the SDK from `dir` (hik-config.mjs hikSdkDir). Resolves { ok: false, why } when it is not
 * installed or cannot be loaded; never throws for that.
 * @param {{ dir: string, koffiModule?: object }} o koffiModule: tests
 */
export async function openHikSdk({ dir, koffiModule } = {}) {
  if (process.platform !== 'linux') return { ok: false, why: `${NOT_INSTALLED} (the Hikvision SDK used here is for Linux)` }
  if (!dir || !existsSync(hikLibPath(dir))) return { ok: false, why: NOT_INSTALLED }
  let koffi
  try {
    koffi = koffiModule ?? (await import('koffi')).default
  } catch (e) {
    return { ok: false, why: `Hikvision support could not start: koffi is missing (${e.message})` }
  }
  // before the first koffi.load (sdk.mjs explains): roomier async stacks and more async calls than
  // koffi's defaults, as for the TVT SDK (only SetESRealPlayCallBack is async here now)
  try {
    koffi.config({ ...koffi.config(), max_async_calls: 256, resident_async_pools: 8, async_stack_size: 1 << 20 })
  } catch {}
  const types = defineHikTypes(koffi)
  const bad = layoutMismatches(koffi, types)
  if (bad.length) return { ok: false, why: `Hikvision support refused to start: structure layout check failed (${bad.slice(0, 3).join('; ')})` }
  let lib
  try {
    lib = koffi.load(hikLibPath(dir))
  } catch (e) {
    return { ok: false, why: `Hikvision support could not be loaded on this server: ${e.message}` }
  }
  try {
    const pool = makeCallPool({ libPath: hikLibPath(dir), threads: CALL_THREADS })
    // the first call proves the threads load the library too (it cannot fail: a version number)
    await pool.call('GetSDKBuildVersion', [])
    return { ok: true, sdk: bindSdk({ koffi, lib, types, dir, pool }) }
  } catch (e) {
    return { ok: false, why: `Hikvision support could not be loaded on this server: ${e.message}` }
  }
}

/**
 * One ES callback's NET_DVR_PACKET_INFO_EX (a pointer valid only during the callback) as a packet with
 * a copy of its bytes, or null when it carries none.
 */
export function decodePacket(koffi, types, pInfo) {
  const p = koffi.decode(pInfo, types.NET_DVR_PACKET_INFO_EX)
  if (!p.pPacketBuffer || !p.dwPacketSize) return null
  return {
    type: p.dwPacketType,
    width: p.wWidth,
    height: p.wHeight,
    tsMs: p.dwTimeStampHigh * 2 ** 32 + p.dwTimeStamp,
    frameNum: p.dwFrameNum,
    mode: p.dwPacketMode,
    // a copy: the SDK's buffer is only valid inside the callback
    bytes: Buffer.from(new Uint8Array(koffi.view(p.pPacketBuffer, p.dwPacketSize)))
  }
}

/**
 * Time-limited calls through a call pool: call(what, budget, fn, args, onLate) resolves { res, err }
 * (err: the call's own error code, read on its thread; 0 when it did not fail). A call that comes back
 * after its limit goes to onLate(res) (a login or stream nobody waits for any more is undone there).
 * Exported for the tests, which give it a pool on a fake library.
 */
export function makeCaller(pool) {
  const inFlight = new Map() // id -> { what, startedAt }
  let seq = 0
  const call = (what, budget, fn, args, onLate) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      inFlight.set(id, { what, startedAt: Date.now() })
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        reject(new HikTimeout(what, budget))
      }, budget)
      timer.unref?.()
      pool.call(fn, args).then(
        (r) => {
          clearTimeout(timer)
          inFlight.delete(id)
          if (settled) {
            try { onLate?.(r.res) } catch {}
            return
          }
          settled = true
          resolve({ res: r.res, err: r.err })
        },
        (e) => {
          clearTimeout(timer)
          inFlight.delete(id)
          if (!settled) {
            settled = true
            reject(e)
          }
        }
      )
    })
  const stats = () => ({ inFlight: inFlight.size, oldestMs: Math.max(0, ...[...inFlight.values()].map((c) => Date.now() - c.startedAt)), calls: [...inFlight.values()].map((c) => c.what) })
  return { call, stats }
}

/**
 * The SDK object hik-worker-core.mjs and hik-test-login.mjs use. koffi/lib/types: the main thread's
 * copy, for the ES callback only; pool: the call threads for everything else.
 */
export function bindSdk({ koffi, lib, types, dir, pool }) {
  const { call, stats } = makeCaller(pool)
  const v = async (what, budget, fn, args, onLate) => (await call(what, budget, fn, args, onLate)).res

  // ---- elementary-stream packets: one callback for the process, routed by preview handle ----
  // (registered once and never unregistered, for the reason sdk.mjs gives for its frame routers)
  const EsCallback = koffi.proto(ES_CALLBACK)
  const SetESRealPlayCallBack = lib.func(...FUNCTIONS.SetESRealPlayCallBack)
  const routes = new Map() // handle -> onPacket
  const dropped = { noRoute: 0, empty: 0 }
  const esCallback = koffi.register((handle, pInfo) => {
    const onPacket = routes.get(handle)
    if (!onPacket || !pInfo) {
      dropped.noRoute++
      return
    }
    let p
    try {
      p = decodePacket(koffi, types, pInfo)
    } catch {
      return
    }
    if (!p) {
      dropped.empty++
      return
    }
    try {
      onPacket(p)
    } catch {}
  }, koffi.pointer(EsCallback))
  /** SetESRealPlayCallBack on this thread (the callback is this thread's), off the event loop, with a limit. */
  const setEs = (handle) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), BUDGET.other)
      SetESRealPlayCallBack.async(handle, esCallback, null, (err, ok) => {
        clearTimeout(timer)
        resolve(!err && Boolean(ok))
      })
    })

  return {
    dir,
    stats: () => ({ ...stats(), dropped: { ...dropped } }),

    /** SetSDKInitCfg (paths of its components and OpenSSL), Init, connect time, reconnect, error log. */
    async init({ logDir } = {}) {
      const sdkPath = alloc('NET_DVR_LOCAL_SDK_PATH')
      writeField(sdkPath, 'NET_DVR_LOCAL_SDK_PATH', 'sPath', `${dir.replace(/\/+$/, '')}/`)
      // before NET_DVR_Init (guide 12.1.40 remarks); a FALSE here is only a note: the library path covers it
      const notes = []
      const r0 = await call('NET_DVR_SetSDKInitCfg(SDK_PATH)', BUDGET.other, 'SetSDKInitCfg', [INIT_CFG.SDK_PATH, sdkPath])
      if (!r0.res) notes.push(`SDK path not accepted (error ${r0.err})`)
      for (const [type, file] of [[INIT_CFG.LIBEAY_PATH, 'libcrypto.so.3'], [INIT_CFG.SSLEAY_PATH, 'libssl.so.3']]) {
        if (!existsSync(join(dir, file))) continue
        const r = await call('NET_DVR_SetSDKInitCfg(OpenSSL)', BUDGET.other, 'SetSDKInitCfgPath', [type, join(dir, file)])
        if (!r.res) notes.push(`${file} not accepted (error ${r.err})`)
      }
      const init = await call('NET_DVR_Init', BUDGET.init, 'Init', [])
      if (!init.res) return { ok: false, why: `NET_DVR_Init failed (error ${init.err})`, notes }
      await call('NET_DVR_SetConnectTime', BUDGET.other, 'SetConnectTime', [CONNECT_WAIT_MS, CONNECT_TRIES])
      await call('NET_DVR_SetReconnect', BUDGET.other, 'SetReconnect', [10_000, 1])
      if (logDir) {
        // errors only, and the SDK deletes its oldest files itself (bAutoDel TRUE): bounded. The guide
        // asks for an absolute path ending in "/" (12.7.7 remarks)
        try {
          mkdirSync(logDir, { recursive: true })
          const r = await call('NET_DVR_SetLogToFile', BUDGET.other, 'SetLogToFile', [LOG_ERRORS_ONLY, `${logDir.replace(/\/+$/, '')}/`, 1])
          if (!r.res) notes.push(`SDK log not started (error ${r.err})`)
        } catch (e) {
          notes.push(`SDK log not started (${e.message})`)
        }
      }
      return { ok: true, notes }
    },

    version: () => v('NET_DVR_GetSDKBuildVersion', BUDGET.other, 'GetSDKBuildVersion', []),
    /** NET_DVR_Cleanup: { ok, code }. */
    async cleanup() {
      try {
        const r = await call('NET_DVR_Cleanup', BUDGET.other, 'Cleanup', [])
        return { ok: Boolean(r.res), code: r.err }
      } catch (e) {
        return { ok: false, why: e.message }
      }
    },
    /** Ends the call threads (a one-shot tool about to exit). */
    close: () => pool.close(),

    /**
     * Hik-Connect account sign-in: NET_DVR_SetSDKLocalCfg(NET_SDK_P2P_LOGIN_2C, NET_SDK_P2P_SERVER_2C).
     * UNVERIFIED: not in the developer guide and no developer access was available; the values are
     * passed exactly as the header names them, nothing is filled in by Argus.
     */
    async p2pLogin2C({ platformType, appId, authAddr, platformAddr, account, password }) {
      const r = await call('NET_DVR_SetSDKLocalCfg(P2P_LOGIN_2C)', BUDGET.p2p, 'SetSDKLocalCfgP2P2C', [
        LOCAL_CFG.P2P_LOGIN_2C,
        { byPlatformType: platformType, byRes1: [0, 0, 0], pAppID: appId, pAuthAddr: authAddr, pPlatformAddr: platformAddr, pUserName: account, pPassword: password, byRes: new Array(40).fill(0) }
      ])
      return r.res ? { ok: true } : { ok: false, code: r.err }
    },

    /** NET_DVR_Login_V40, synchronous (bUseAsynLogin 0), private protocol. code: its own error code. */
    async login({ host, port, user, password }) {
      const li = alloc('NET_DVR_USER_LOGIN_INFO')
      writeField(li, 'NET_DVR_USER_LOGIN_INFO', 'sDeviceAddress', host)
      writeField(li, 'NET_DVR_USER_LOGIN_INFO', 'wPort', port)
      writeField(li, 'NET_DVR_USER_LOGIN_INFO', 'sUserName', user)
      writeField(li, 'NET_DVR_USER_LOGIN_INFO', 'sPassword', password)
      writeField(li, 'NET_DVR_USER_LOGIN_INFO', 'bUseAsynLogin', 0)
      const di = alloc('NET_DVR_DEVICEINFO_V40')
      let r
      try {
        // a login that comes back after we gave up holds one of the device's sessions: log it out
        r = await call('NET_DVR_Login_V40', BUDGET.login, 'Login_V40', [li, di], (late) => {
          if (late >= 0) call('NET_DVR_Logout (late login)', BUDGET.logout, 'Logout', [late]).catch(() => {})
        })
      } finally {
        li.fill(0) // the password does not stay in this Buffer longer than the call
      }
      const info = parseDeviceInfoV40(di)
      if (r.res >= 0) return { userId: r.res, info }
      return { userId: -1, info, code: r.err }
    },

    logout: (userId) => v('NET_DVR_Logout', BUDGET.logout, 'Logout', [userId]).catch(() => false),

    /** NET_DVR_GET_DEVICECFG_V40: the device's name, model name and serial. */
    async deviceCfg(userId) {
      const buf = alloc('NET_DVR_DEVICECFG_V40')
      writeField(buf, 'NET_DVR_DEVICECFG_V40', 'dwSize', LAYOUT.NET_DVR_DEVICECFG_V40.size)
      const r = await call('NET_DVR_GetDVRConfig(DEVICECFG_V40)', BUDGET.config, 'GetDVRConfig', [userId, NET_DVR_GET_DEVICECFG_V40, 0, buf, buf.length, Buffer.alloc(4)])
      return r.res ? { ok: true, ...parseDeviceCfgV40(buf) } : { ok: false, code: r.err }
    },

    /** NET_DVR_GET_IPPARACFG_V40 of group 0 (lChannel 0): the IP channels, as a Buffer for hik-core channelsFrom. */
    async ipConfig(userId) {
      const buf = alloc('NET_DVR_IPPARACFG_V40')
      writeField(buf, 'NET_DVR_IPPARACFG_V40', 'dwSize', LAYOUT.NET_DVR_IPPARACFG_V40.size)
      const r = await call('NET_DVR_GetDVRConfig(IPPARACFG_V40)', BUDGET.config, 'GetDVRConfig', [userId, NET_DVR_GET_IPPARACFG_V40, 0, buf, buf.length, Buffer.alloc(4)])
      return r.res ? { ok: true, buf } : { ok: false, code: r.err }
    },

    /**
     * Live view without a window (hPlayWnd 0) or a raw-data callback, then the elementary-stream
     * callback on its handle, so packets arrive as H.264/H.265 NAL units with their type, size and time
     * stamp (NET_DVR_PACKET_INFO_EX). bBlocked 1: the call returns once the stream is connected or has
     * failed (PREVIEWINFO comment: "the SDK Connect failure return until 5s timeout").
     * @returns {Promise<{ handle: number, code?: number, step?: string, why?: string }>}
     */
    async startLive(userId, sdkChannel, streamType, onPacket) {
      const pi = alloc('NET_DVR_PREVIEWINFO')
      writeField(pi, 'NET_DVR_PREVIEWINFO', 'lChannel', sdkChannel)
      writeField(pi, 'NET_DVR_PREVIEWINFO', 'dwStreamType', streamType)
      writeField(pi, 'NET_DVR_PREVIEWINFO', 'dwLinkMode', 0) // TCP
      writeField(pi, 'NET_DVR_PREVIEWINFO', 'hPlayWnd', 0)
      writeField(pi, 'NET_DVR_PREVIEWINFO', 'bBlocked', 1)
      writeField(pi, 'NET_DVR_PREVIEWINFO', 'dwDisplayBufNum', 1)
      const stopLate = (h) => {
        if (h >= 0) call('NET_DVR_StopRealPlay (late start)', BUDGET.stop, 'StopRealPlay', [h]).catch(() => {})
      }
      const r = await call('NET_DVR_RealPlay_V40', BUDGET.realplay, 'RealPlay_V40', [userId, pi, null, null], stopLate)
      if (r.res < 0) return { handle: -1, code: r.err, step: 'RealPlay_V40' }
      const handle = r.res
      routes.set(handle, onPacket)
      if (!(await setEs(handle))) {
        routes.delete(handle)
        await call('NET_DVR_StopRealPlay', BUDGET.stop, 'StopRealPlay', [handle]).catch(() => {})
        // (its error code is not known: the SDK keeps it on the thread that made that call)
        return { handle: -1, step: 'SetESRealPlayCallBack', why: 'the SDK refused the elementary-stream callback for this stream' }
      }
      return { handle }
    },

    async stopLive(handle) {
      routes.delete(handle)
      return v('NET_DVR_StopRealPlay', BUDGET.stop, 'StopRealPlay', [handle]).catch(() => false)
    }
  }
}
