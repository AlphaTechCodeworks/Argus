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

// Logins by serial number need the plain-serial add-on, bin/linux/libp2pserial.so (native/p2pserial).
// For such a login the SDK gives the P2P cloud the upper-case MD5 of the serial as the device code,
// but the cloud knows these NVRs by the plain serial, so it answered "not online" and every login
// failed ("cannot connect" after ~20 s). The SDK calls the NAT library's NAT_CLIENT_ConnectDev through
// its PLT; the add-on stands in front of that function and puts the plain serial back for the serials
// registered with it (plainSerial below), passing every other call through unchanged. For that it has
// to come before the SDK in the symbol search order: it is loaded first, with its symbols global
// (RTLD_GLOBAL). For the same reason the SDK must never be loaded with { deep: true }: RTLD_DEEPBIND
// makes the SDK look in its own dependencies first, which goes straight past the add-on. Without the
// add-on everything else works, and logins by serial number are still tried (plainSerial warns once).
const P2P_SERIAL_LIB = join(import.meta.dirname, '../bin/linux/libp2pserial.so')
let p2pSerialLib = null
let p2pSerialMissing = '' // why the add-on is not loaded, for plainSerial's warning
if (!existsSync(P2P_SERIAL_LIB)) p2pSerialMissing = `${P2P_SERIAL_LIB} is missing`
else {
  try {
    p2pSerialLib = koffi.load(P2P_SERIAL_LIB, { global: true })
  } catch (e) {
    p2pSerialMissing = `${P2P_SERIAL_LIB} could not be loaded (${e.message})`
  }
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
  NET_SDK_LoginEx: 40_000, // by serial number through the P2P cloud: the SDK gives up by itself after ~20 s
  NET_SDK_SetNat2Addr: 10_000,
  NET_SDK_Cleanup: 10_000, // 0.5-3 s after a login by serial number
  NET_SDK_Logout: 10_000,
  NET_SDK_RebootDVR: 10_000,
  NET_SDK_ShutDownDVR: 10_000,
  NET_SDK_LivePlay: 15_000,
  NET_SDK_StopLivePlay: 10_000,
  NET_SDK_MakeKeyFrame: 5000,
  NET_SDK_MakeKeyFrameSub: 5000,
  NET_SDK_GetDeviceIPCInfo: 12_000, // the SDK gives up by itself at ~10.02 s: that is a failure, not a late return
  NET_SDK_TransparentConfig: 20_000,
  NET_SDK_PlayBackByTimeEx: 20_000,
  NET_SDK_StopPlayBack: 10_000,
  NET_SDK_PlayBackControl: 10_000,
  NET_SDK_SetPlayDataCallBack: 10_000,
  // the SDK waits 20 s for the NVR's answer and then gives up by itself with a failed handle: a
  // plain failure, not a late return (at 15 s every one of them came back "5 s late" and cooled nvr1)
  NET_SDK_FindFile: 21_000,
  NET_SDK_FindNextFile: 15_000,
  NET_SDK_FindClose: 10_000,
  NET_SDK_FindRecDate: 15_000,
  NET_SDK_FindNextRecDate: 15_000,
  NET_SDK_FindRecDateClose: 10_000,
  NET_SDK_GetDeviceTime: 16_000 // on NVMS-9000 an XML round trip (queryTimeCfg) the SDK waits up to 15 s for
}
const DEFAULT_BUDGET = 30_000
const SLOW_LOG_MS = 2000
// An NVR whose call came back after its time limit "cools down" for this long (nvrCooling): no
// new streams start on it and its stalled streams are not restarted, and (main process) its playback
// searches and new playbacks are refused as busy, so a slow NVR does not collect more stuck calls,
// which the SDK makes other NVRs' calls queue behind. (SDK_COOL_MS: for tests)
const COOL_MS = Number(process.env.SDK_COOL_MS ?? 60_000)

/** A function's time limit (ms) by its C name, for a call that sets none (sdkCallT timeoutMs). */
export const budgetOf = (name) => BUDGETS[name] ?? DEFAULT_BUDGET

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
// NVR id -> when one of its calls last returned from the SDK at all. The watchdog uses it to tell
// "this one NVR is not answering" from "the SDK itself is wedged": if calls to OTHER NVRs keep
// coming back, the library is still working and killing the process would only lose the healthy ones.
const returnAtByNvr = new Map()

/**
 * What a cool-down holds back in this process, for its log line: a live worker's new streams; in the
 * main process with live workers (CCTV_LIVE_WORKER=on), only playback and searches, since live view
 * and recording run in the workers with their own SDK; in a main process without workers, all of it.
 */
const coolHolds = () => {
  if (process.env.CCTV_WORKER_NVR) return 'new streams'
  return process.env.CCTV_LIVE_WORKER === 'on' ? 'playback and searches' : 'new streams, playback and searches'
}

/** A call to an NVR came back after its time limit: the NVR cools down from now (logged once per episode). */
const noteLateReturn = (entry, budget) => {
  const now = Date.now()
  const prev = lateReturnAt.get(entry.nvr)
  lateReturnAt.set(entry.nvr, now)
  if (prev !== undefined && now - prev < COOL_MS) return
  const lateS = Math.round((now - entry.startedAt - budget) / 1000)
  console.warn(`[${entry.nvr}] ${entry.name}${entry.tag ? ` (${entry.tag})` : ''} came back ${lateS} s late: holding ${coolHolds()} on this NVR for ${COOL_MS / 1000} s`)
}

const settleListeners = new Set()
/** fn() runs whenever a native call really returns (lanes use it to resume work held back by late calls). */
export const onCallSettled = (fn) => settleListeners.add(fn)

const release = () => {
  running--
  const next = waiting.shift()
  if (next) next.start()
  // A listener that throws must not stop what follows release() in the native callback: the late
  // handler (onLate) and the exclusive key's release. A skipped onLate leaves nvr-xml.mjs's record of
  // the call inside the SDK set, and that NVR's XML calls and reboot refused until a restart; a
  // skipped key release leaves every later call with that key waiting for ever.
  for (const fn of settleListeners) {
    try {
      fn()
    } catch (e) {
      console.warn(`[sdk] a settle listener failed: ${e?.message ?? e}`)
    }
  }
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

// A worker that is shutting down (nvr-worker.mjs) lets nothing new into the SDK: it is SIGKILLed a
// moment later and the kernel closes the NVR's sockets, as at every watchdog kill. The service stops
// that aborted (03:35:48, 04:03:58, 04:39:09) were in the StopLivePlay burst and Logout of that stop.
let refusing = null // why new calls are refused, or null
/** From now on every call is refused before it reaches the SDK (calls already inside it run on). */
export const refuseNewCalls = (why = 'the process is stopping') => {
  refusing = why
}

/**
 * Runs an SDK function on a worker thread with a time limit.
 * @param {{ timeoutMs?: number, tag?: string, nvr?: string, exclusive?: string|string[], mayBlock?: boolean, background?: boolean, onLate?: (result: any, err?: Error) => void }} opts
 *   mayBlock: this call is known to block inside the SDK when the NVR does not answer (logins),
 *   so the watchdog does not treat it on its own as a hung SDK
 *   background: nobody waits on this call (the event intake's, coverage's and motion search's
 *   searches and clock reads), so coming back late does not start its NVR's cool-down: an intake
 *   search back late held every viewer's playback and searches of nvr1 for 60 s. While it is inside
 *   the SDK past its limit it still counts as late (lateCalls, nvrCooling), as other calls queue
 *   behind it then.
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
  // (cName: a test's stand-in for a bound function, test/fake-sdk.mjs, named like the real one)
  const name = names.get(fn) ?? fn?.cName ?? 'sdk call'
  const budget = opts.timeoutMs ?? budgetOf(name)
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    let returned = () => {} // for `exclusive`: the next call with the key may start
    const queuedAt = Date.now()
    const start = () => {
      if (refusing) {
        returned()
        if (!settled) {
          settled = true
          reject(new Error(`${name}${opts.tag ? ` (${opts.tag})` : ''} not started: ${refusing}`))
        }
        waiting.shift()?.start() // (started from release(): the slot it would have taken is free)
        return
      }
      running++
      const id = ++seq
      // mayBlock: this call is known to sit inside the SDK for minutes when the far end does not
      // answer (logins). It still counts as work in flight, but the watchdog does not read it on
      // its own as a hung SDK (see watchdog.mjs).
      const entry = { name, tag: opts.tag ?? '', nvr: opts.nvr ?? '', mayBlock: opts.mayBlock === true, background: opts.background === true, startedAt: Date.now(), late: false }
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
          if (entry.nvr) returnAtByNvr.set(entry.nvr, lastReturnAt)
          // a late login (mayBlock) does not cool its NVR: a login is known to sit in the SDK for a
          // while, logoutLate tidies up one we gave up on, and a new session is exactly when the
          // recorder wants to start its streams (02:30:11: a login 1 s late held 23 cameras for 60 s).
          // Nor does a late background call (see background above): nobody was waiting on it.
          if (entry.late && entry.nvr && !entry.queuedBehind && !entry.mayBlock && !entry.background) noteLateReturn(entry, budget)
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
    // one key or several: the call waits for the previous call on every key
    const keys = [].concat(opts.exclusive)
    const prev = Promise.all(keys.map((k) => exclusiveTails.get(k) ?? Promise.resolve()))
    const mine = new Promise((r) => (returned = r))
    const tail = prev.then(() => mine)
    for (const key of keys) {
      exclusiveTails.set(key, tail)
      tail.then(() => {
        if (exclusiveTails.get(key) === tail) exclusiveTails.delete(key)
      })
    }
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
  for (const [id, at] of returnAtByNvr) returnAtByNvr.set(id, Math.min(Date.now(), at + ms))
}

/** sdkCallT with the default budget for the function. */
export const sdkCall = (fn, ...args) => sdkCallT({}, fn, ...args)

/** Snapshot for the watchdog and /healthz. */
export const sdkStats = () => {
  const now = Date.now()
  const list = [...inFlight].map(([id, e]) => ({ ...e, id, ms: now - e.startedAt }))
  const oldest = list.reduce((a, b) => (b.ms > (a?.ms ?? -1) ? b : a), null)
  // A victim started while an older call was (and still is) inside the SDK. The SDK serialises
  // work across NVRs, so a victim that is late is most likely only queued behind that older call:
  // at 04:12:13 one stuck FindRecDate plus six event-poller calls queued behind it read as
  // "7 SDK calls overdue". Only the oldest call in flight can be a root (ties go by start order), so
  // lateRoots is 0 or 1: the watchdog counts it only where the late rule is to leave such a queue
  // to the single-stuck-call rule (the main process that runs the recording workers).
  for (const e of list) e.victim = list.some((o) => o.startedAt < e.startedAt || (o.startedAt === e.startedAt && o.id < e.id))
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
    // per NVR: how long ago one of its calls last returned (the watchdog's test for "are the
    // other NVRs still healthy?"). NVRs that have never had a call return are simply absent.
    lastReturnAgoByNvr: Object.fromEntries([...returnAtByNvr].map(([id, at]) => [id, now - at])),
    // late calls that are not `mayBlock` (logins): only these are evidence of a hung SDK
    lateBlocking: list.filter((e) => e.late && !e.mayBlock).length,
    // ... and of those, the ones that started a jam rather than queued behind one (see victim)
    lateRoots: list.filter((e) => e.late && !e.mayBlock && !e.victim).length,
    calls: list.sort((a, b) => b.ms - a.ms).slice(0, 50)
  }
}

/**
 * Whether the SDK looks stuck from here: a call is past its time limit and no native call (for
 * any NVR) has come back since it started. The main process then refuses new SDK work at once
 * (degraded NVRs, playback busy, XML calls refused, refreshes skipped) instead of queuing it
 * behind the stuck call: queued calls only fill the SDK queue and the libuv pool, and read to the
 * watchdog as more evidence of a hang. It clears as soon as any native call returns.
 * Any late call counts, not only the oldest: a login stuck for minutes on an NVR that does not
 * answer (while others kept returning) must not hide a newer call that has since stopped
 * everything. A late login (mayBlock) alone does not count, for the reason the watchdog ignores
 * it: logins are known to sit in the SDK for minutes while other NVRs' calls go on working, and
 * refusing everything would also stop the calls that could show it. If it does hold everything
 * up, the next call asked behind it goes late too, and that one counts.
 */
export const sdkStuck = () => {
  // (<=: release() starts a queued call in the same millisecond the previous one returned)
  for (const e of inFlight.values()) if (e.late && !e.mayBlock && lastReturnAt <= e.startedAt) return true
  return false
}

/** Whether the call with this id (sdkStats().calls[].id) is still inside the SDK: the watchdog's hold belongs to one call. */
export const callInFlight = (id) => inFlight.has(id)

/** Number of late (overdue, still running) calls attributed to one NVR, or to any NVR when no id is given. */
export const lateCalls = (nvrId) => {
  let n = 0
  for (const e of inFlight.values()) if (e.late && (nvrId === undefined || e.nvr === nvrId)) n++
  return n
}

const LIVE_CALLS = new Set(['NET_SDK_LivePlay', 'NET_SDK_StopLivePlay'])
/**
 * LivePlay and StopLivePlay calls of one NVR inside the SDK now (late ones included). The live
 * pacer (live-pacer.mjs) and the idle-stop queue (idle-stops.mjs) start a viewer's stream or an
 * unwanted stream's stop only below their limit, so viewers' churn does not pile onto the calls the
 * NVR's recording depends on.
 */
export const liveCallsInFlight = (nvrId) => {
  let n = 0
  for (const e of inFlight.values()) if (e.nvr === nvrId && LIVE_CALLS.has(e.name)) n++
  return n
}

/** When a call of this NVR last came back after its time limit (0: never), as counted for its cool-down. */
export const lastLateReturnAt = (nvrId) => lateReturnAt.get(nvrId) ?? 0

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
  // only for a one-shot tool about to exit (cleanupSdk): it ends every session of the process
  Cleanup: bind('bool NET_SDK_Cleanup()'),
  SetConnectTime: bind('bool NET_SDK_SetConnectTime(uint32 waitMs, uint32 tries)'),
  SetReconnect: bind('bool NET_SDK_SetReconnect(uint32 intervalMs, int enable)'),
  GetLastError: bind('uint32 NET_SDK_GetLastError()'),
  Login: bind('NET_SDK_Login', 'long', ['str', 'uint16', 'str', 'str', koffi.out(koffi.pointer(LPNET_SDK_DEVICEINFO))]),
  // by serial number through the P2P cloud (connect type NET_SDK_CONNECT_NAT20 = 2, DVR_NET_SDK.h),
  // after SetNat2Addr (setP2pServer); with this connect type the address given here is not used
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
  ),
  // maintenance: reboot or power off the device, on the logged-in session (DVR_NET_SDK.h)
  RebootDVR: bind('bool NET_SDK_RebootDVR(long userId)'),
  ShutDownDVR: bind('bool NET_SDK_ShutDownDVR(long userId)')
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
  27: 'busy', // NET_SDK_BUSY
  31: 'NVR has no resources left', // NET_SDK_DVR_NORESOURCE
  50: 'user does not exist',
  55: 'too many users',
  // FindNext* codes that end a walk early (85 one more item, 86 none found, 87 no more)
  88: 'file exception',
  89: 'try later',
  92: 'unknown user',
  93: 'user name or password empty',
  95: 'NVR busy',
  97: 'NVR not ready'
}
/** An SDK error code as text. */
export const errorText = (code) => ERRORS[code] ?? `error ${code}`
/** Last SDK error code (-1 when it cannot be read). A hint only, as lastError. */
export const lastErrorCode = () => sdkCall(NET_SDK.GetLastError).catch(() => -1)
/** Last SDK error as text. A hint only: the SDK may keep it per thread and calls run on pool threads. */
export const lastError = async () => errorText(await lastErrorCode())
/**
 * The last SDK error as the reason a call failed, or `fallback` when the SDK reports none. A failed
 * call that did not throw (e.g. Login/LoginEx returning -1) leaves its code in a thread-local slot
 * that, read back on a pool thread or after another NVR's call, often reads 0 ("success") or -1
 * (unreadable). Those must never become the reason a call "failed" (the "failed: success" log/line).
 */
export const lastErrorReason = async (fallback) => {
  const code = await lastErrorCode()
  return code > 0 ? errorText(code) : fallback
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

// ---- logins by serial number --------------------------------------------------

// The add-on's registration (see the top of this file). Called directly, not on a worker thread like
// the SDK's functions: it only adds the serial to a small table and never waits on the SDK.
// (test/fake-sdk.mjs replaces add, to see what is registered)
export const P2P_SERIAL = { add: p2pSerialLib?.func('int p2pserial_add(const char *serial)') ?? null }
let p2pSerialWarned = false
/**
 * Registers a serial number with the plain-serial add-on, before a login by that serial number, so
 * the P2P cloud is asked for the NVR by its plain serial. Returns whether the add-on is active and
 * took it. Without the add-on the login is still tried (the SDK then sends the MD5, which the cloud
 * does not know), and one warning says why it will fail.
 */
export const plainSerial = (sn) => {
  if (!P2P_SERIAL.add) {
    if (!p2pSerialWarned) {
      p2pSerialWarned = true
      console.warn(`[sdk] ${p2pSerialMissing || 'the plain-serial add-on is not loaded'}: logins by serial number are tried, but the SDK asks the P2P cloud for an MD5 of the serial, which the cloud does not know, so they fail ("cannot connect" after ~20 s). Install bin/linux/libp2pserial.so with the app.`)
    }
    return false
  }
  if (P2P_SERIAL.add(String(sn)) === 1) return true
  console.warn(`[sdk] the plain-serial add-on did not take serial ${sn} (empty, too long, or its table is full); this login asks the cloud for its MD5`)
  return false
}

// The P2P server the SDK was pointed at in this process (setP2pServer): { addr, ok }, or null
let p2pServer = null
/**
 * Points the SDK at the P2P cloud's server for logins by serial number (NET_SDK_SetNat2Addr). The SDK
 * takes that once per process: the first call starts its NAT client and returns true, every later one
 * returns false and changes nothing (until NET_SDK_Cleanup and NET_SDK_Init). So the first call here
 * is the real one, and the address is remembered once the SDK has taken it; a later call with the same
 * address resolves true without asking the SDK, and one with another address is refused, naming the
 * address this process is bound to. Resolves the SDK's answer to the real call.
 * @param {object} [opts] sdkCallT options for the real call (nvr, tag)
 */
export const setP2pServer = (host, port, opts = {}) => {
  const addr = `${host}:${port}`
  if (p2pServer && p2pServer.addr !== addr) {
    return Promise.reject(new Error(`the P2P server ${addr} cannot be used: this process is bound to the P2P server ${p2pServer.addr} (the SDK takes one per process; a restart is needed to change it)`))
  }
  if (!p2pServer) {
    const mine = { addr }
    const forget = () => {
      if (p2pServer === mine) p2pServer = null
    }
    // a call that came back after its time limit may still have started the NAT client: bound after all
    const onLate = (ok) => {
      if (ok && !p2pServer) p2pServer = { addr, ok: Promise.resolve(true) }
    }
    mine.ok = sdkCallT({ ...opts, onLate }, NET_SDK.SetNat2Addr, String(host), Number(port)).then(Boolean)
    // refused or failed: no NAT client was started, so the next login asks again
    mine.ok.then((ok) => ok || forget(), forget)
    p2pServer = mine
  }
  return p2pServer.ok
}

/**
 * NET_SDK_Cleanup, for a one-shot tool about to exit after a login by serial number (nvr.mjs): a
 * process that exits normally within ~30 s of such a login without it can segfault in the SDK's NAT
 * threads (exit code 139). Takes 0.5-3 s; resolves false if it failed. Never in the server or an NVR
 * worker: it ends every session of the process (they end with SIGKILL). Afterwards initSdk starts
 * the SDK afresh, and the P2P server can be set again.
 */
export const cleanupSdk = async () => {
  if (!initialised) return true
  await initialised.catch(() => {})
  initialised = null
  p2pServer = null
  return sdkCall(NET_SDK.Cleanup).catch(() => false)
}

// ---- frames ---------------------------------------------------------------

export const FRAME_TYPE_VIDEO = 1
export const FRAME_TYPE_VIDEO_FORMAT = 5
/** dvrdvstypedef.h DD_FRAME_TYPE_AUDIO / _AUDIO_FORMAT: a camera microphone's sound, and its format. */
export const FRAME_TYPE_AUDIO = 2
export const FRAME_TYPE_AUDIO_FORMAT = 6

// Which cameras send sound: noted once per channel, with the format announcement's bytes, so the
// log says which cameras have a working microphone and what encoding it is (G.711, AAC ...). The
// frames themselves are not used yet.
const audioNoted = new Map() // "device/channel" -> { formatHex }
export const audioSeen = () => Object.fromEntries(audioNoted)
function noteAudio(info, buf) {
  const key = `${info.deviceID}/${info.channel}`
  const prev = audioNoted.get(key)
  if (info.frameType === FRAME_TYPE_AUDIO_FORMAT) {
    const hex = Buffer.from(new Uint8Array(koffi.view(buf, Math.min(info.length, 64)))).toString('hex')
    if (prev?.formatHex === hex) return
    audioNoted.set(key, { formatHex: hex, frames: prev?.frames ?? 0 })
    console.log(`[audio] channel ${info.channel + 1}: audio format announced (${info.length} bytes: ${hex})`)
    return
  }
  if (!prev) {
    audioNoted.set(key, { formatHex: null, frames: 1 })
    console.log(`[audio] channel ${info.channel + 1}: audio frames arriving (${info.length} bytes each, first frame head ${Buffer.from(new Uint8Array(koffi.view(buf, Math.min(info.length, 16)))).toString('hex')})`)
  }
}
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
    if (info.frameType === FRAME_TYPE_AUDIO || info.frameType === FRAME_TYPE_AUDIO_FORMAT) {
      try { noteAudio(info, buf) } catch {}
    }
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
