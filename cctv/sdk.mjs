// TVT native SDK: loaded and initialised once per process, shared by every NVR.
//
// Every SDK call goes through sdkCall()/sdkCallT(), which runs it on a libuv
// worker thread (koffi .async). A blocking call on the main thread deadlocks:
// SDK threads wait for the main thread to run frame callbacks while the main
// thread waits for them.
//
// Calls are also tracked and time-limited. The SDK serialises work internally
// across all NVRs, and under load a call can hang for minutes (seen: 23
// concurrent StopLivePlay calls stuck for 254 s, blocking both NVRs). A call
// that exceeds its budget rejects with SdkTimeout so JS can move on; the native
// call keeps its worker thread until it really returns, and the watchdog
// (watchdog.mjs) restarts the process if calls stay stuck.
//
// We deliberately do not use the wrapper's Device class for sessions: its login
// blocks the main thread and its dispose() calls NET_SDK_Cleanup, which would
// tear down every other NVR's session too.
import koffi from 'koffi'
import { existsSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { LPNET_SDK_DEVICEINFO } from '../build/lib/struct/LPNET_SDK_DEVICEINFO.js'

// Must run before the first koffi.load. The SDK calls our frame callbacks from
// its own threads at ~30 fps per stream; the defaults (4 resident async pools,
// 256 async calls, 128 KiB async stacks) are too small for dozens of streams,
// and one SDK function uses a 128 KiB stack frame by itself.
if (process.env.CCTV_KOFFI_DEFAULTS !== '1') {
  koffi.config({ ...koffi.config(), max_async_calls: 1024, resident_async_pools: 16, async_stack_size: 1 << 20 })
}

export const lib = koffi.load(join(import.meta.dirname, '../bin/linux/libdvrnetsdk.so'))

// ---- tracked, time-limited calls ------------------------------------------

const POOL = Number(process.env.UV_THREADPOOL_SIZE ?? 4)
if (POOL < 16) console.warn('UV_THREADPOOL_SIZE is small; slow NVR calls can stall all others. Set it to 64.')
// leave threads free for web logins (scrypt) and file I/O, which share the pool
const MAX_NATIVE = Math.max(4, POOL - 16)

// per-function budgets (ms); anything slower is "late"
const BUDGETS = {
  NET_SDK_Login: 20_000, // SetConnectTime 5 s x 3 tries
  NET_SDK_LoginEx: 40_000, // by serial number through TVT's P2P relay: slower than a LAN login
  NET_SDK_SetNat2Addr: 10_000,
  NET_SDK_Logout: 10_000,
  NET_SDK_LivePlay: 15_000,
  NET_SDK_StopLivePlay: 10_000,
  NET_SDK_MakeKeyFrame: 5000,
  NET_SDK_MakeKeyFrameSub: 5000,
  NET_SDK_GetDeviceIPCInfo: 10_000,
  NET_SDK_TransparentConfig: 20_000,
  NET_SDK_PlayBackByTimeEx: 20_000,
  NET_SDK_StopPlayBack: 10_000,
  NET_SDK_PlayBackControl: 10_000,
  NET_SDK_SetPlayDataCallBack: 10_000,
  NET_SDK_FindFile: 15_000,
  NET_SDK_FindNextFile: 15_000,
  NET_SDK_FindClose: 10_000,
  NET_SDK_FindRecDate: 15_000,
  NET_SDK_FindNextRecDate: 15_000,
  NET_SDK_FindRecDateClose: 10_000,
  NET_SDK_GetDeviceTime: 10_000
}
const DEFAULT_BUDGET = 30_000
const SLOW_LOG_MS = 2000
// An NVR whose call came back after its time limit "cools down" for this long (nvrCooling): no
// new streams start on it and its stalled streams are not restarted, so a slow NVR does not
// collect more stuck calls, which the SDK makes other NVRs' calls queue behind. (SDK_COOL_MS: for tests)
const COOL_MS = Number(process.env.SDK_COOL_MS ?? 60_000)

const names = new WeakMap() // koffi function -> C name
/** Declares an SDK function from a C-like signature and remembers its name for logs and budgets. */
export const bind = (sig, ...rest) => {
  const fn = rest.length ? lib.func(sig, ...rest) : lib.func(sig)
  names.set(fn, rest.length ? sig : sig.match(/([A-Za-z_]\w*)\s*\(/)[1])
  return fn
}

export class SdkTimeout extends Error {
  constructor(name, tag, ms) {
    super(`${name}${tag ? ` (${tag})` : ''} did not return within ${ms} ms`)
    this.name = 'SdkTimeout'
  }
}

let seq = 0
const inFlight = new Map() // id -> { name, tag, nvr, startedAt, late }
const waiting = [] // calls queued for a free native slot: { start, queuedAt }
let running = 0
let lastReturnAt = Date.now() // when a native call (any NVR) last returned: the watchdog's sign of progress
const lateReturnAt = new Map() // NVR id -> when one of its calls last came back after its time limit

/** A call to an NVR came back after its time limit: the NVR cools down from now (logged once per episode). */
const noteLateReturn = (entry, budget) => {
  const now = Date.now()
  const prev = lateReturnAt.get(entry.nvr)
  lateReturnAt.set(entry.nvr, now)
  if (prev !== undefined && now - prev < COOL_MS) return
  const lateS = Math.round((now - entry.startedAt - budget) / 1000)
  console.warn(`[${entry.nvr}] ${entry.name}${entry.tag ? ` (${entry.tag})` : ''} came back ${lateS} s late: holding new streams on this NVR for ${COOL_MS / 1000} s`)
}

const settleListeners = new Set()
/** fn() runs whenever a native call really returns (lanes use it to resume work held back by late calls). */
export const onCallSettled = (fn) => settleListeners.add(fn)

const release = () => {
  running--
  const next = waiting.shift()
  if (next) next.start()
  for (const fn of settleListeners) fn()
}

// Diagnostics: SDK_TRACE=1, or a file "sdk-trace" in the data folder at start, logs every native
// call's start and end to stderr, synchronously, so after a crash the log shows what was inside
// the SDK at that moment. Only numeric first arguments (login ids, handles) are printed.
const TRACE = process.env.SDK_TRACE === '1' || existsSync(join(process.env.DATA_DIR ?? join(import.meta.dirname, '../data'), 'sdk-trace'))
if (TRACE) console.warn('[sdk] tracing every native call (SDK_TRACE)')
const trace = (line) => {
  try {
    writeSync(2, `[trace] ${new Date().toISOString().slice(11, 23)} ${line}\n`)
  } catch {}
}

// Calls that must never overlap inside the SDK: key -> promise that settles when the last
// queued call with that key has really returned (see sdkCallT's `exclusive`).
const exclusiveTails = new Map()

/**
 * Runs an SDK function on a worker thread with a time limit.
 * @param {{ timeoutMs?: number, tag?: string, nvr?: string, exclusive?: string, onLate?: (result: any, err?: Error) => void }} opts
 *   onLate: called when the native call finishes after its timeout, with its result
 *   (e.g. a LivePlay that returns a handle nobody is waiting for any more), or with
 *   result undefined and the error if it failed late
 *   exclusive: calls with the same key run one at a time: each starts only after the previous
 *   one has returned from the SDK, even if that was long after its time limit. Live calls on
 *   one camera use it: a StopLivePlay still running inside the SDK while another stop or a
 *   LivePlay starts on the same camera corrupted the heap ("double free or corruption"), and
 *   the SDK hands a new stream the handle value of one just stopped, so a late stop could
 *   stop the new stream. The time limit starts when the call does, not while it waits here.
 */
export function sdkCallT(opts, fn, ...args) {
  const name = names.get(fn) ?? 'sdk call'
  const budget = opts.timeoutMs ?? BUDGETS[name] ?? DEFAULT_BUDGET
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    let returned = () => {} // for `exclusive`: the next call with the key may start
    const queuedAt = Date.now()
    const start = () => {
      running++
      const id = ++seq
      const entry = { name, tag: opts.tag ?? '', nvr: opts.nvr ?? '', startedAt: Date.now(), late: false }
      inFlight.set(id, entry)
      if (TRACE) trace(`> ${id} ${name} ${entry.tag} nvr=${entry.nvr}${typeof args[0] === 'number' || typeof args[0] === 'bigint' ? ` a0=${args[0]}` : ''} running=${running}`)
      timer = setTimeout(() => {
        entry.late = true
        // the SDK serialises calls: if another NVR's call started earlier and is still inside,
        // this one is late because it queued behind that one, so its own NVR does not cool
        for (const [otherId, o] of inFlight) {
          if (otherId !== id && o.nvr && o.nvr !== entry.nvr && o.startedAt <= entry.startedAt) entry.queuedBehind = true
        }
        if (!settled) {
          settled = true
          reject(new SdkTimeout(name, entry.tag, budget))
        }
      }, budget)
      try {
        fn.async(...args, (err, res) => {
          if (TRACE) trace(`< ${id} ${name} ${Date.now() - entry.startedAt}ms${err ? ' error' : ''}`)
          clearTimeout(timer)
          inFlight.delete(id)
          lastReturnAt = Date.now()
          if (entry.late && entry.nvr && !entry.queuedBehind) noteLateReturn(entry, budget)
          release()
          try {
            const ms = Date.now() - entry.startedAt
            if (ms > SLOW_LOG_MS) console.warn(`[sdk] ${name}${entry.tag ? ` (${entry.tag})` : ''} took ${ms} ms${entry.late ? ' (after its timeout)' : ''}`)
            if (settled) {
              try {
                opts.onLate?.(err ? undefined : res, err)
              } catch (e) {
                console.warn(`[sdk] ${name} late handler failed: ${e.message}`)
              }
              return
            }
            settled = true
            if (err) reject(err)
            else resolve(res)
          } finally {
            returned()
          }
        })
      } catch (e) {
        // koffi refused the arguments: nothing runs natively
        clearTimeout(timer)
        inFlight.delete(id)
        release()
        returned()
        if (!settled) {
          settled = true
          reject(e)
        }
      }
    }
    const go = () => {
      if (running < MAX_NATIVE) start()
      else waiting.push({ start, queuedAt })
    }
    if (!opts.exclusive) return go()
    const key = opts.exclusive
    const prev = exclusiveTails.get(key) ?? Promise.resolve()
    const mine = new Promise((r) => (returned = r))
    const tail = prev.then(() => mine)
    exclusiveTails.set(key, tail)
    tail.then(() => {
      if (exclusiveTails.get(key) === tail) exclusiveTails.delete(key)
    })
    prev.then(go)
  })
}

/**
 * Waits until no `exclusive` call whose key starts with prefix is running or queued, or
 * maxMs passed. Resolves true if they all returned.
 */
export async function exclusiveSettled(prefix, maxMs) {
  const until = Date.now() + maxMs
  for (;;) {
    const tails = [...exclusiveTails].filter(([k]) => k.startsWith(prefix)).map(([, t]) => t)
    if (tails.length === 0) return true
    const left = until - Date.now()
    if (left <= 0) return false
    let timer
    await Promise.race([Promise.allSettled(tails), new Promise((r) => (timer = setTimeout(r, left)))])
    clearTimeout(timer)
  }
}

/**
 * Leaves ms out of the age of every call in flight or queued: the machine slept (or the
 * process was frozen) for that long, which says nothing about the SDK (watchdog.mjs).
 */
export function discountPause(ms) {
  for (const e of inFlight.values()) e.startedAt += ms
  for (const w of waiting) w.queuedAt += ms
  lastReturnAt = Math.min(Date.now(), lastReturnAt + ms)
}

/** sdkCallT with the default budget for the function. */
export const sdkCall = (fn, ...args) => sdkCallT({}, fn, ...args)

/** Snapshot for the watchdog and /healthz. */
export const sdkStats = () => {
  const now = Date.now()
  const list = [...inFlight.values()].map((e) => ({ ...e, ms: now - e.startedAt }))
  const oldest = list.reduce((a, b) => (b.ms > (a?.ms ?? -1) ? b : a), null)
  return {
    inFlight: list.length,
    running,
    cap: MAX_NATIVE,
    queued: waiting.length,
    queuedOldestMs: waiting.length ? now - waiting[0].queuedAt : 0,
    late: list.filter((e) => e.late).length,
    lateByNvr: list.filter((e) => e.late && e.nvr).reduce((m, e) => ({ ...m, [e.nvr]: (m[e.nvr] ?? 0) + 1 }), {}),
    oldestMs: oldest?.ms ?? 0,
    oldest: oldest ? `${oldest.name}${oldest.tag ? ` (${oldest.tag})` : ''}` : '',
    lastReturnAgoMs: now - lastReturnAt,
    calls: list.sort((a, b) => b.ms - a.ms).slice(0, 50)
  }
}

/** Number of late (overdue, still running) calls attributed to one NVR, or to any NVR when no id is given. */
export const lateCalls = (nvrId) => {
  let n = 0
  for (const e of inFlight.values()) if (e.late && (nvrId === undefined || e.nvr === nvrId)) n++
  return n
}

/**
 * How much longer an NVR cools down (0: not cooling). It cools while one of its calls is late
 * (still inside the SDK) and for COOL_MS after one came back late: an NVR that answers that slowly
 * gets no new streams or stall restarts meanwhile (live.mjs, nvrs.mjs), and playback searches and
 * new playbacks are refused as busy (playback.mjs). Other NVRs are not affected.
 */
export const coolingLeftMs = (nvrId) => {
  if (lateCalls(nvrId) > 0) return COOL_MS // (at least: it counts from the return)
  const at = lateReturnAt.get(nvrId)
  return at === undefined ? 0 : Math.max(0, at + COOL_MS - Date.now())
}
/** Whether an NVR is cooling down after late calls (see coolingLeftMs). */
export const nvrCooling = (nvrId) => coolingLeftMs(nvrId) > 0

// ---- types ----------------------------------------------------------------

koffi.struct('CCTV_FRAME_INFO', {
  deviceID: 'uint32',
  channel: 'uint32',
  frameType: 'uint32',
  length: 'uint32',
  keyFrame: 'uint32',
  width: 'uint32',
  height: 'uint32',
  frameIndex: 'uint32',
  frameAttrib: 'uint32',
  streamID: 'uint32',
  time: 'int64',
  relativeTime: 'int64'
})
koffi.struct('CCTV_CLIENT_INFO', {
  lChannel: 'long',
  streamType: 'long',
  hPlayWnd: 'void *',
  bNoDecode: 'int'
})
export const IPC_INFO = koffi.struct('CCTV_IPC_INFO', {
  deviceID: 'uint',
  channel: 'ushort',
  guid: koffi.array('uchar', 48),
  status: 'ushort',
  szEtherName: koffi.array('char', 16, 'String'),
  szServer: koffi.array('char', 64, 'String'),
  nPort: 'ushort',
  nHttpPort: 'ushort',
  nCtrlPort: 'ushort',
  szID: koffi.array('char', 64, 'String'),
  username: koffi.array('char', 36, 'String'),
  manufacturerId: 'uint',
  manufacturerName: koffi.array('char', 36, 'String'),
  productModel: koffi.array('char', 36, 'String'),
  bUseDefaultCfg: 'uchar',
  bPOEDevice: 'uchar',
  resv: koffi.array('uchar', 2),
  szChlname: koffi.array('char', 36, 'String')
})
export const FrameCallback = koffi.proto(
  'void CctvFrameCallback(int64 handle, CCTV_FRAME_INFO info, uint8 *buf, void *user)'
)

// ---- functions ------------------------------------------------------------

export const NET_SDK = {
  Init: bind('bool NET_SDK_Init()'),
  SetConnectTime: bind('bool NET_SDK_SetConnectTime(uint32 waitMs, uint32 tries)'),
  SetReconnect: bind('bool NET_SDK_SetReconnect(uint32 intervalMs, int enable)'),
  GetLastError: bind('uint32 NET_SDK_GetLastError()'),
  Login: bind('NET_SDK_Login', 'long', ['str', 'uint16', 'str', 'str', koffi.out(koffi.pointer(LPNET_SDK_DEVICEINFO))]),
  // by serial number through TVT's P2P relay (connect type NET_SDK_CONNECT_NAT20 = 2); the
  // relay's address goes where the NVR's would, after SetNat2Addr (DVR_NET_SDK.h)
  LoginEx: bind('NET_SDK_LoginEx', 'long', ['str', 'uint16', 'str', 'str', koffi.out(koffi.pointer(LPNET_SDK_DEVICEINFO)), 'int', 'str']),
  SetNat2Addr: bind('bool NET_SDK_SetNat2Addr(str serverAddr, uint16 port)'),
  Logout: bind('bool NET_SDK_Logout(long userId)'),
  LivePlay: bind('int64 NET_SDK_LivePlay(long userId, CCTV_CLIENT_INFO *info, CctvFrameCallback *cb, void *user)'),
  StopLivePlay: bind('bool NET_SDK_StopLivePlay(int64 handle)'),
  MakeKeyFrame: bind('bool NET_SDK_MakeKeyFrame(long userId, long channel)'), // main stream only
  MakeKeyFrameSub: bind('bool NET_SDK_MakeKeyFrameSub(long userId, long channel)'),
  GetDeviceIPCInfo: bind('bool NET_SDK_GetDeviceIPCInfo(long userId, void *buf, long bufSize, void *count)'),
  // the NVR's XML config API over the logged-in SDK connection (NVMS-9000 web commands)
  TransparentConfig: bind(
    'bool NET_SDK_TransparentConfig(long userId, const char *sendXML, const char *strUrl, void *out, uint32 outSize, void *bytesReturned)'
  )
}

// NET_SDK_ERROR, as far as needed for messages (see DVR_NET_SDK.h)
const ERRORS = {
  0: 'success',
  1: 'wrong password',
  2: 'user lacks permission',
  5: 'too many connections',
  6: 'login refused',
  8: 'cannot connect',
  9: 'not connected',
  11: 'network receive error',
  12: 'network timeout',
  50: 'user does not exist',
  55: 'too many users',
  92: 'unknown user',
  93: 'user name or password empty',
  95: 'NVR busy',
  97: 'NVR not ready'
}
/** Last SDK error as text. A hint only: the SDK may keep it per thread and calls run on pool threads. */
export const lastError = async () => {
  const code = await sdkCall(NET_SDK.GetLastError).catch(() => -1)
  return ERRORS[code] ?? `error ${code}`
}

let initialised = null
/** Initialises the SDK once (idempotent). */
export const initSdk = () => {
  initialised ??= (async () => {
    if (!(await sdkCall(NET_SDK.Init))) throw new Error('NET_SDK_Init failed')
    await sdkCall(NET_SDK.SetConnectTime, 5000, 3)
    await sdkCall(NET_SDK.SetReconnect, 10_000, 1)
  })()
  return initialised
}

// ---- frames ---------------------------------------------------------------

export const FRAME_TYPE_VIDEO = 1
export const FRAME_TYPE_VIDEO_FORMAT = 5
export const CODEC_H264 = 0
export const CODEC_H265 = 1
export const HEADER_SIZE = 16

/** View of a frame's bytes: native memory (only valid inside the callback) or an already copied Buffer. */
const bytesOf = (buf, len) => (Buffer.isBuffer(buf) ? buf : Buffer.from(koffi.view(buf, len)))

/** Codec announced by a VIDEO_FORMAT frame (BITMAPINFOHEADER, FOURCC at offset 16). */
export const codecOf = (info, buf) =>
  /265|hevc/i.test(bytesOf(buf, info.length).toString('latin1', 16, 20)) ? CODEC_H265 : CODEC_H264

/**
 * The codec of an Annex B keyframe from its own NAL units (parameter sets or IDR), or null if
 * it can't tell. The NVR's format notes are sometimes empty or arrive late during playback.
 *   H.265: 2-byte NAL header, VPS 0x40 01, SPS 0x42 01, PPS 0x44 01, IDR/CRA 0x26/0x28/0x2a 01
 *   H.264: 1-byte header, SPS 0x67/0x27, PPS 0x68/0x28, IDR 0x65/0x25
 */
export const sniffCodec = (buf, length) => {
  const b = bytesOf(buf, Math.min(length, 512))
  for (let i = 0; i + 4 < b.length; i++) {
    if (b[i] !== 0 || b[i + 1] !== 0) continue
    const j = b[i + 2] === 1 ? i + 3 : b[i + 2] === 0 && b[i + 3] === 1 ? i + 4 : -1
    if (j < 0 || j + 1 >= b.length) continue
    const h = b[j]
    if ((h & 0x81) === 0 && b[j + 1] === 1 && [32, 33, 34, 19, 20, 21].includes((h >> 1) & 0x3f)) return CODEC_H265
    if ((h & 0x80) === 0 && [7, 8, 5].includes(h & 0x1f)) return CODEC_H264
    i = j
  }
  return null
}

/** Packs an SDK video frame into the WebSocket wire format described in server.mjs. */
export const encodeFrame = (info, buf, codec) => {
  const msg = Buffer.allocUnsafe(HEADER_SIZE + info.length)
  msg.writeUInt8(info.keyFrame ? 1 : 0, 0)
  msg.writeUInt8(codec, 1)
  msg.writeUInt16LE(info.width, 2)
  msg.writeUInt16LE(info.height, 4)
  msg.writeUInt16LE(0, 6)
  msg.writeBigInt64LE(BigInt(info.time), 8)
  bytesOf(buf, info.length).copy(msg, HEADER_SIZE)
  return msg
}

// ---- frame routing ----------------------------------------------------------
//
// One callback per kind for the whole process, registered once and never
// unregistered: koffi reuses freed callback slots, so a slot unregistered while
// the SDK may still call it could deliver frames to the wrong stream. Frames are
// routed by the handle the SDK passes. Live frames can arrive before LivePlay
// has returned the handle; those are kept briefly and handed over once the
// stream claims the handle.

const PENDING_MAX_FRAMES = 90
const PENDING_TTL_MS = 20_000

const DEAD_TTL_MS = 5 * 60_000

const makeRouter = (keepEarly) => {
  const routes = new Map() // handle -> (info, buf) => void
  // handle -> { at, format, frames: [{ info, data }], waitKey }: frames that arrived before the stream claimed the handle
  const pending = new Map()
  const dead = new Map() // handle -> released at; frames still arriving for a stream being stopped are dropped
  const copy = (info, buf) => ({ info: { ...info }, data: Buffer.from(new Uint8Array(koffi.view(buf, info.length))) })
  const callback = koffi.register((handle, info, buf) => {
    const route = routes.get(handle)
    if (route) return route(info, buf)
    if (!keepEarly || info.length === 0 || dead.has(handle)) return
    let p = pending.get(handle)
    if (!p) pending.set(handle, (p = { at: Date.now(), format: null, frames: [], waitKey: false }))
    if (info.frameType === FRAME_TYPE_VIDEO_FORMAT) {
      p.format = copy(info, buf) // always keep the latest codec announcement
      return
    }
    if (info.frameType !== FRAME_TYPE_VIDEO) return
    if (p.frames.length >= PENDING_MAX_FRAMES) {
      // full: start over from the next keyframe rather than keep a GOP with frames missing
      p.frames = []
      p.waitKey = true
    }
    if (p.waitKey && !info.keyFrame) return
    p.waitKey = false
    p.frames.push(copy(info, buf))
  }, koffi.pointer(FrameCallback))
  setInterval(() => {
    const now = Date.now()
    for (const [h, p] of pending) if (now - p.at > PENDING_TTL_MS) pending.delete(h)
    for (const [h, at] of dead) if (now - at > DEAD_TTL_MS) dead.delete(h)
  }, 5000).unref()
  return {
    callback,
    /** Starts delivering frames for handle to fn (including any that arrived early). */
    claim(handle, fn) {
      dead.delete(handle) // the SDK may reuse a handle value
      routes.set(handle, fn)
      const p = pending.get(handle)
      if (p) {
        pending.delete(handle)
        if (p.format) fn(p.format.info, p.format.data)
        for (const { info, data } of p.frames) fn(info, data)
      }
    },
    /** Stops delivering frames for handle; late frames are dropped until forget() (or a TTL). */
    release(handle) {
      routes.delete(handle)
      pending.delete(handle)
      dead.set(handle, Date.now())
    },
    /** The stream on handle has really stopped: the SDK may hand the same value to a new stream. */
    forget(handle) {
      dead.delete(handle)
      pending.delete(handle)
    }
  }
}

export const liveFrames = makeRouter(true)
export const playFrames = makeRouter(false)
