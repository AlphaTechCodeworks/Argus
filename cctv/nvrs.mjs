// NVRs and sites.
//
// The list lives in data/nvrs.json (managed with cctv/nvr.mjs) and is watched:
// adding, removing, relabelling or changing an NVR takes effect within a few
// seconds, without a restart. On first start the list is created from the
// TVT_* settings in .env.
//
// Each NVR keeps its own SDK session. A session that stops working (NVR
// rebooted, network lost) is logged out and logged in again with backoff. All
// SDK work for an NVR goes through its lane (a few operations at a time) and
// every call has a time limit; see sdk.mjs, lanes.mjs and watchdog.mjs.
import koffi from 'koffi'
import { siteOffsetMin } from './site-time.mjs'
import { existsSync, mkdirSync, readFileSync, watchFile, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DATA_DIR } from './auth.mjs'
import { Lane, PRIORITY, connectLane } from './lanes.mjs'
import { LiveStream } from './live.mjs'
import { createPlayback } from './playback.mjs'
import { CODEC_H265, IPC_INFO, NET_SDK, exclusiveSettled, initSdk, lastErrorReason, lateCalls, nvrCooling, plainSerial, sdkCallT, sdkStuck, setP2pServer } from './sdk.mjs'
import { probeTarget, tcpReachable } from './probe.mjs'
import { XML_HEADER, transparent, xmlSettled } from './nvr-xml.mjs'
import { parseMainEncoders, parseOnlineChlList, parseRecStatus } from './nvr-online.mjs'
import { startWorker } from './worker-supervisor.mjs'
import { openRecIndex } from './rec-index.mjs'
import { createWarmer } from './rec-cache.mjs'
import { downtimeGaps, recoverLocation } from './rec-recover.mjs'
import { cameraRecording, getSettings, onSettingsChange } from './settings.mjs'
import { spareWhile } from './watchdog.mjs'
import { checkHealth, listLocations, onChange as onStorageChange, startHealthChecks } from './storage.mjs'
import { SPOOL_ID, drainSpool, spoolLocation, trimSpool } from './ram-spool.mjs'
import { noteRecorderGap, noteRecorderQueues } from './thin-pace.mjs'

export const NVRS_FILE = join(DATA_DIR, 'nvrs.json')

// NVRs added by serial number (the NVR's cloud ID) are reached through the P2P cloud they are sold
// with instead of by address, for sites without port forwarding or a VPN. Eye in Cloud, Provision
// and TVT are one cloud; the serial number and the login go through it, over UDP (P2P 2.0). The SDK
// takes one cloud server per process (sdk.mjs setP2pServer), so every login by serial number uses
// P2P_SERVER: cli-nat20.eyeincloud.com port 9969, the address a login was proven through end to end
// (2026-10-04), or CCTV_P2P_SERVER=host:port (device.provisionisr-nat2.com:9968 and
// c2020.autonat.com:7968 reach the same cloud). A serial NVR's record has a host and port like every
// other (the P2P server it was saved with; older records: c2020.autonat.com:7968), but they are not
// used to connect.
const P2P_DEFAULT = { host: 'cli-nat20.eyeincloud.com', port: 9969 }
const p2pServerFrom = (value) => {
  if (!value) return P2P_DEFAULT
  const m = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(value.trim())
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 65535) return { host: m[1], port: Number(m[2]) }
  console.warn(`CCTV_P2P_SERVER=${value} is not host:port; using ${P2P_DEFAULT.host}:${P2P_DEFAULT.port}`)
  return P2P_DEFAULT
}
export const P2P_SERVER = p2pServerFrom(process.env.CCTV_P2P_SERVER)
// On unless CCTV_P2P=off. Until 2026-10 it was off: this SDK asks the cloud for an MD5 of the serial
// instead of the serial, so every login by serial number failed ("cannot connect" after ~20 s); the
// plain-serial add-on (sdk.mjs) puts the serial back.
export const P2P_ENABLED = process.env.CCTV_P2P !== 'off'
const P2P_OFF = 'Adding NVRs by serial number is switched off on this server (CCTV_P2P=off). Connect by IP address (on site, over a VPN or with port forwarding).'
const NET_SDK_CONNECT_NAT = 1 // older P2P: the SDK fetches a server list over HTTP from nat.eyeincloud.com
const NET_SDK_CONNECT_NAT20 = 2
// NAT 1.0 NVRs (cfg.nat === 1) register with this older cloud over HTTP (port 80 for the server list)
// and then UDT-connect. Unlike NAT 2.0 it needs no SetNat2Addr and no plain-serial add-on -- the serial
// is sent correctly by this path -- so it coexists with NAT 2.0 in one process. CCTV_NAT1_SERVER overrides.
const NAT1_DEFAULT = { host: 'nat.eyeincloud.com', port: 80 }
export const NAT1_SERVER = (() => {
  const v = process.env.CCTV_NAT1_SERVER
  const m = /^([^:]+):(\d+)$/.exec(String(v ?? ''))
  if (m && Number(m[2]) > 0) return { host: m[1], port: Number(m[2]) }
  if (v) console.warn(`CCTV_NAT1_SERVER=${v} is not host:port; using ${NAT1_DEFAULT.host}:${NAT1_DEFAULT.port}`)
  return NAT1_DEFAULT
})()
// CCTV_LIVE_WORKER=on: each NVR's live video comes from its own child process (nvr-worker.mjs,
// worker-supervisor.mjs), fanned out here by stream-hub.mjs; this process keeps a control-only
// login (picture and stream settings, playback). Never inside a worker itself.
export const LIVE_WORKER = process.env.CCTV_LIVE_WORKER === 'on' && !process.env.CCTV_WORKER_NVR
/** How an NVR is reached, for messages. */
export const whereIs = (cfg) => (cfg.sn ? `serial ${cfg.sn} (P2P cloud${Number(cfg.nat) === 1 ? ', NAT 1.0' : ''})` : `${cfg.host}:${cfg.port}`)

const MAX_CHANNEL_FAILURES = 4 // ~2 minutes of failed channel refreshes -> log in again
// camera list poll (tests with the fake SDK: CCTV_TEST_REFRESH_MS)
const CHANNEL_REFRESH_MS = (process.env.CCTV_WORKER_FAKE_SDK === '1' && Number(process.env.CCTV_TEST_REFRESH_MS)) || 30_000
// The camera list is read at a turn only while something may have changed (#listHeld). Every worker
// read it at every 30 s turn: about 600 of the workers' ~850 SDK calls an hour (27-29 Sep), to learn
// what changes when a camera drops off. 40 of those reads came back late and each held that NVR's new
// streams for 60 s (40 of the workers' 141 cool-downs), and 32 of the 40 were sent to an NVR whose
// cameras had already gone quiet (a median 7 s before). So: while every stream of the NVR delivers
// video and the list has not changed for CHANNEL_SETTLED_MS, a read every CHANNEL_QUIET_MS; a stream
// with no video for SILENT_MS (a camera dropping off stops its stream first) brings the read back to
// the next turn; and while most of them are silent at once (the NVR froze) none is sent at all.
const CHANNEL_QUIET_MS = CHANNEL_REFRESH_MS * 4 // 2 minutes (from ~120 reads an hour per NVR to ~27)
const CHANNEL_SETTLED_MS = CHANNEL_REFRESH_MS * 20 // 10 minutes after a change: a rebooting camera is seen back within a turn
const SILENT_MS = (process.env.CCTV_WORKER_FAKE_SDK === '1' && Number(process.env.CCTV_TEST_SILENT_MS)) || 3000
const CHANNEL_LOG_MS = CHANNEL_REFRESH_MS * 120 // an hour: how often the list was read, and why not (#logListTurns)
/**
 * Corrects a P2P NVR's camera online flags in place. Over the cloud, GetDeviceIPCInfo's own online
 * flag is unreliable (the whole read comes back empty at random, wiping every state), so the NVR's
 * authoritative queryOnlineChlList is used instead when we have it (#onlineChannels): a configured
 * channel is online iff the NVR lists it online, or it is delivering video right now (which no status
 * read can argue with). An empty slot (no camera address and no name) stays offline. When the online
 * list could not be read this turn and none was ever read, it falls back to the as-read flag plus
 * video. Pure, so it can be tested on its own; mutates `list`.
 * @param {Array<{ch:number, configured:boolean, online:boolean}>} list
 * @param {{ hasVideo:(ch:number)=>boolean, onlineSet?:Set<number>|null }} ctx onlineSet: the NVR's
 *   online channels (queryOnlineChlList), or null to fall back to the as-read flag.
 */
export function applyP2pOnline(list, { hasVideo, onlineSet = null }) {
  for (const c of list) {
    if (!c.configured) { c.online = false; continue } // an empty slot is never online
    c.online = onlineSet ? onlineSet.has(c.ch) || hasVideo(c.ch) : c.online || hasVideo(c.ch)
  }
}
/** The camera list as far as a change to it matters (the order is the channels'). */
const listSig = (list) => list.map((c) => `${c.ch}|${c.online}|${c.configured}|${c.name}|${c.ip}|${c.httpPort}|${c.model}|${c.maker}`).join('\n')
const WORKER_LIST_FRESH_MS = Math.max(15_000, CHANNEL_REFRESH_MS * 3) // STATS come every 5 s
const CONTROL_KEEPALIVE_MS = 5 * 60_000 // main's own poll while the worker polls
/** ms +-20% (rnd: tests). */
export const jittered = (ms, rnd = Math.random) => Math.round(ms * (0.8 + 0.4 * rnd()))
const MAX_LIVE_FAILURES = 6 // consecutive LivePlay failures -> log in again
const RETRY_MIN_MS = 5000
const RETRY_MAX_MS = 60_000

// ---- config file ----------------------------------------------------------

export const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'nvr'

export const uniqueId = (base, taken) => {
  let id = slug(base)
  for (let n = 2; taken.has(id); n++) id = `${slug(base)}-${n}`
  return id
}

/** @returns {{ nvrs: Array<{ id: string, site: string, name: string, host: string, port: number, user: string, password: string, sn?: string }> }} (sn: reached by serial number through the P2P cloud; host/port are then not used) */
export const readConfig = () => {
  if (!existsSync(NVRS_FILE)) return { nvrs: [] }
  const cfg = JSON.parse(readFileSync(NVRS_FILE, 'utf8'))
  return { nvrs: Array.isArray(cfg.nvrs) ? cfg.nvrs : [] }
}

export const writeConfig = (cfg) => {
  mkdirSync(dirname(NVRS_FILE), { recursive: true })
  writeFileSync(NVRS_FILE, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Checks and normalises NVR settings from the app or the command line.
 * @returns {{ site: string, name: string, host: string, port: number, user: string, sn?: string }} throws on bad input
 */
export const cleanNvrFields = (input, { partial = false } = {}) => {
  const out = {}
  const text = (key, max, required) => {
    if (input[key] === undefined) {
      if (required && !partial) throw new Error(`${key} is required`)
      return
    }
    const v = String(input[key]).trim()
    if (required && !v) throw new Error(`${key} is required`)
    if (v.length > max) throw new Error(`${key} is too long`)
    out[key] = v
  }
  text('site', 64, true)
  text('name', 64, true)
  text('user', 64, true)
  // at another site (VPN or a slow link): the full-size view stays on the sub stream
  if (input.remote !== undefined) out.remote = input.remote === true
  // serial number: connect through the P2P cloud ('' = connect by address)
  if (input.sn !== undefined) {
    const sn = String(input.sn ?? '').trim().toUpperCase()
    if (sn && !/^[A-Z0-9]{6,64}$/.test(sn)) throw new Error('Serial number: letters and digits only, as printed on the NVR')
    if (sn && !P2P_ENABLED) throw new Error(P2P_OFF)
    out.sn = sn
  }
  // which P2P generation the NVR is on: 2 = NAT 2.0 (the default, device.eyeincloud.com), 1 = NAT 1.0
  // (the older nat.eyeincloud.com cloud). Only meaningful for a serial NVR.
  if (input.nat !== undefined) out.nat = Number(input.nat) === 1 ? 1 : 2
  if (out.sn) {
    // no address is needed: the record gets the cloud server's in place of the NVR's, and an address
    // sent along is not used (login() goes straight to the NAT 1.0 or 2.0 server)
    const srv = Number(out.nat ?? (partial ? undefined : 2)) === 1 ? NAT1_SERVER : P2P_SERVER
    out.host = srv.host
    out.port = srv.port
  } else if (input.sn === '' && partial && input.host === undefined) {
    throw new Error('Enter the NVR IP address to connect to it by address')
  }
  if (out.host === undefined && (input.host !== undefined || !partial)) {
    const host = String(input.host ?? '').trim()
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new Error('Enter the NVR IP address or host name')
    out.host = host
  }
  if (out.port === undefined && (input.port !== undefined || !partial)) {
    const port = Number(input.port ?? 6036)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1-65535')
    out.port = port
  }
  return out
}

/**
 * onLate handler for logins: a login that succeeds after we gave up on it would
 * otherwise hold one of the NVR account's limited user sessions forever.
 */
const logoutLate = (tag, nvr = '') => (userId) => {
  if (userId >= 0) {
    connectLane.run(() => sdkCallT({ nvr, tag: `${tag}: late logout` }, NET_SDK.Logout, userId), { priority: PRIORITY.LOW }).catch(() => {})
  }
}

/**
 * One login through the connect lane (logins go one at a time: a login can block other SDK work).
 * @returns {Promise<{ userId: number, why: string }>} userId -1 on failure, with the reason
 */
const login = async ({ host, port, user, password, sn, nat }, { tag, nvr = '', info = {}, priority = PRIORITY.NORMAL }) => {
  let err = null
  // Reachability first (probe.mjs): NET_SDK_Login against an NVR that does not answer at all
  // blocks inside the SDK for well over the watchdog's limit, and one such NVR then took the
  // whole server down again and again. A TCP connect asks the same question in a couple of
  // seconds and can really be abandoned, so when it fails we never make the blocking call and
  // this counts as an ordinary failed login attempt, with the usual backoff. The probe is done
  // before taking the connect lane, so an unreachable NVR does not hold up healthy ones either.
  // An NVR reached by serial number is not probed: the P2P cloud answers over UDP only.
  const target = probeTarget({ host, port, sn })
  if (target) {
    const reach = await tcpReachable(target.host, target.port)
    if (!reach.ok) {
      return { userId: -1, why: `The NVR ${reach.why}` }
    }
  }
  // mayBlock: a login is known to sit inside this SDK for minutes; the watchdog must not read
  // that on its own as a hung SDK (see watchdog.mjs), and logoutLate below already tidies up
  // a login that succeeds after we gave up on it.
  const byAddress = () => sdkCallT({ nvr, tag, mayBlock: true, onLate: logoutLate(tag, nvr) }, NET_SDK.Login, host, Number(port), user, password, info)
  // NAT 1.0 (older P2P): the server (nat.eyeincloud.com:80) goes straight into LoginEx with connect
  // type 1; the SDK fetches a server list over HTTP and UDT-connects. No SetNat2Addr and no plain-serial
  // add-on -- this path sends the serial correctly -- so it coexists with NAT 2.0 in the same process.
  const byNat1 = () => sdkCallT({ nvr, tag, mayBlock: true, onLate: logoutLate(tag, nvr) }, NET_SDK.LoginEx, NAT1_SERVER.host, NAT1_SERVER.port, user, password, info, NET_SDK_CONNECT_NAT, sn)
  // NAT 2.0 by serial number: the plain serial registered with the add-on, the SDK pointed at the P2P
  // server (the first time in this process; the record's own host and port are not used), then the login
  const bySerial = async () => {
    plainSerial(sn)
    const { host: p2pHost, port: p2pPort } = P2P_SERVER
    if (!(await setP2pServer(p2pHost, p2pPort, { nvr, tag: `${tag}: P2P server` }))) throw new Error(`the SDK did not accept the P2P server ${p2pHost}:${p2pPort}`)
    return sdkCallT({ nvr, tag, mayBlock: true, onLate: logoutLate(tag, nvr) }, NET_SDK.LoginEx, p2pHost, p2pPort, user, password, info, NET_SDK_CONNECT_NAT20, sn)
  }
  const bySerialAny = Number(nat) === 1 ? byNat1 : bySerial
  const userId = await connectLane
    .run(sn ? bySerialAny : byAddress, { priority })
    .catch((e) => {
      err = e
      return -1
    })
  if (userId >= 0) return { userId, why: '' }
  // a timeout is not an SDK error (the SDK would report "success")
  const late = sn ? 'The NVR did not answer through the P2P cloud in time (is it online, with P2P switched on in its network settings?)' : 'The NVR did not answer in time'
  // Login returns -1 without throwing on a refusal (busy/at its session cap): read the real code, but
  // never let an empty/0 ("success") slot become the failure reason -- that was the "failed: success" line
  const why = err
    ? (err.name === 'SdkTimeout' ? late : err.message)
    : await lastErrorReason(sn ? 'the NVR did not let us in (it may be busy or at its connection limit on the P2P cloud)' : 'the NVR did not let us in')
  return { userId: -1, why }
}

/** Logs in once to check an address and login; returns the model or throws with the reason. */
export const testLogin = async ({ host, port, user, password, sn, nat }) => {
  await initSdk()
  const info = {}
  const where = whereIs({ host, port, sn })
  const { userId, why } = await login({ host, port, user, password, sn, nat }, { tag: `test login ${where}`, info })
  if (userId < 0) {
    console.warn(`[admin] test login to ${where} failed: ${why}`)
    throw new Error(why)
  }
  await sleep(500)
  await connectLane.run(() => sdkCallT({ tag: `test logout ${where}` }, NET_SDK.Logout, userId)).catch(() => {})
  return String(info.deviceProduct ?? '').replace(/\0.*$/, '') || 'NVR'
}

/** First start: create the list from the single NVR in .env. */
const seedConfig = () => {
  if (existsSync(NVRS_FILE)) return
  const { TVT_HOST, TVT_PORT = '6036', TVT_USER, TVT_PASS } = process.env
  if (!TVT_HOST || !TVT_USER || !TVT_PASS) {
    writeConfig({ nvrs: [] })
    return
  }
  writeConfig({
    nvrs: [{ id: 'nvr1', site: 'Main site', name: 'NVR 1', host: TVT_HOST, port: Number(TVT_PORT), user: TVT_USER, password: TVT_PASS }]
  })
  console.log(`Created ${NVRS_FILE} from .env (edit it with: node cctv/nvr.mjs)`)
}

// ---- playback sessions ----------------------------------------------------

const PLAYBACK_LOGINS = 4 // extra logins per NVR for playback; the NVR limits users per account
const IDLE_LOGOUT_MS = 120_000
const WAIT_MS = 15_000
const SETTLE_MS = 1500 // after login, before the session is used

/**
 * Separate logins for recorded playback. Two playbacks on one login interfere on
 * these NVRs (one speeds up, frames cross over), so every playback borrows its
 * own login from this pool; live view stays on the NVR's main login.
 */
class SessionPool {
  constructor(nvr) {
    this.nvr = nvr
    this.idle = [] // { userId, timer, gen }
    this.inUse = 0
    this.opening = 0
    this.waiters = []
    this.gen = 0 // bumped on closeAll: logins from an older NVR session are not reused
  }

  /** @returns {Promise<{ userId: number, release: () => void }>} */
  async acquire() {
    if (this.nvr.stopped) throw new Error(`${this.nvr.name} was removed`)
    if (this.nvr.degraded) throw new Error(`${this.nvr.name} is busy recovering. Try again in a minute.`)
    const idle = this.idle.pop()
    if (idle) {
      clearTimeout(idle.timer)
      return this.#lease(idle.userId, idle.gen)
    }
    if (this.inUse + this.opening < PLAYBACK_LOGINS) {
      this.opening++
      const gen = this.gen
      try {
        const t0 = Date.now()
        const { userId, why } = await login(this.nvr.cfg, { tag: 'playback login', nvr: this.nvr.id })
        if (userId < 0) {
          console.warn(`[${this.nvr.id}] playback login failed: ${why}`)
          throw new Error(`Playback login failed: ${why}`)
        }
        // a session is only ready once the NVR has pushed its channel state; a playback
        // started before that stalls in a 10 s SDK timeout (and blocks other logins meanwhile)
        await sleep(SETTLE_MS)
        if (gen !== this.gen || this.nvr.stopped) {
          // the NVR reconnected (or was removed) while this login was opening
          this.#logout(userId)
          throw new Error(`${this.nvr.name} reconnected. Try again.`)
        }
        console.log(`[${this.nvr.id}] playback login ready in ${Date.now() - t0} ms (${this.inUse + 1} in use)`)
        return this.#lease(userId, gen)
      } catch (e) {
        this.#wakeOne() // let a waiter try its own login instead of timing out
        throw e
      } finally {
        this.opening--
      }
    }
    // all playback logins busy: wait for one
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          reject(new Error('All playback connections to this NVR are busy. Try again shortly.'))
        }, WAIT_MS)
      }
      this.waiters.push(waiter)
    })
  }

  #lease(userId, gen) {
    this.inUse++
    let released = false
    return {
      userId,
      release: () => {
        if (released) return
        released = true
        this.inUse--
        this.#giveBack(userId, gen)
      }
    }
  }

  #logout(userId) {
    connectLane
      .run(() => sdkCallT({ nvr: this.nvr.id, tag: 'playback logout' }, NET_SDK.Logout, userId), { priority: PRIORITY.LOW })
      .catch(() => {})
  }

  /** A waiter gets its own chance (a failed or stale login freed capacity). */
  #wakeOne() {
    const waiter = this.waiters.shift()
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.acquire().then(waiter.resolve, waiter.reject)
  }

  #giveBack(userId, gen) {
    // a login from before a relogin (NVR rebooted, link lost) is not trustworthy: log it out
    if (gen !== this.gen || this.nvr.stopped) {
      this.#logout(userId)
      this.#wakeOne()
      return
    }
    const waiter = this.waiters.shift()
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve(this.#lease(userId, gen))
      return
    }
    const entry = { userId, timer: null, gen }
    entry.timer = setTimeout(() => {
      this.idle.splice(this.idle.indexOf(entry), 1)
      this.#logout(userId)
    }, IDLE_LOGOUT_MS)
    this.idle.push(entry)
  }

  closeAll(reason = 'NVR reconnecting') {
    this.gen++
    for (const { userId, timer } of this.idle.splice(0)) {
      clearTimeout(timer)
      this.#logout(userId)
    }
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(reason))
    }
  }
}

// ---- one NVR --------------------------------------------------------------

const LANE_CONCURRENCY = 2 // SDK operations at once per NVR (the SDK serialises internally anyway)
// In an NVR's worker, where recording shares this login with the viewers, the lane holds new work
// (stops excepted) once ONE call of the NVR is late, not two: at 03:51:54 a second LivePlay went in
// next to a late one on nvr1, and the worker was killed with every recording on that NVR
const LANE_HOLD_AT = process.env.CCTV_WORKER_NVR ? 1 : LANE_CONCURRENCY
const MASS_STALL_SHARE = 0.5 // this share of an NVR's streams stalling at once = an NVR problem
const RESTART_SPACING_MS = 250
const PROBE_BACKOFF_MS = 30_000 // after a probe the NVR didn't answer, wait this long before the next
const RELOGIN_BACKOFF_MS = [0, 5000, 15_000, 60_000, 5 * 60_000] // by relogins in the last 10 min
const RELOGIN_WINDOW_MS = 10 * 60_000
const LOGOUT_WAIT_MS = 30_000 // longest wait for live calls still inside the SDK before a logout

/**
 * A camera's SDK guid (IPC_INFO.guid, uchar[48]) as a stable id for the export: its ASCII text when
 * printable (some firmware stores a UUID string there), else hex. Null when empty. This is the closest
 * thing the SDK gives to a per-camera serial -- it is a guid/id, not a real serial number.
 */
const guidHex = (g) => {
  const bytes = Array.from(g ?? []).map((n) => Number(n) & 0xff)
  while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop()
  if (!bytes.length) return null
  return bytes.every((b) => b >= 32 && b < 127) ? Buffer.from(bytes).toString('ascii') : bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

export class Nvr {
  constructor(cfg) {
    this.apply(cfg)
    this.userId = -1
    this.status = 'connecting' // connecting | online | offline
    this.error = ''
    this.model = ''
    this.serial = '' // the NVR's serial number, read at login (to add it elsewhere by serial)
    this.channels = []
    this.p2pOnlineSet = null // P2P NVRs: the NVR's last good online-channel list (queryOnlineChlList)
    this.streams = new Map()
    this.scans = new Set() // abort functions of running motion searches
    this.codecSeen = new Map() // "ch:stream" -> { codec: 'h264' | 'h265', width, height, at }
    // from the live worker's stats (workerStats): viewers' sub-streams held at the NVR's sub-stream
    // limit, that limit (null: none known), and the cameras whose main stream plays
    this.subsHeld = new Set()
    this.subsParked = new Set()
    this.subLimit = null
    this.subsFull = false // at the limit: a viewer's new sub-stream would be held
    this.mainsPlaying = new Set()
    this.health = { channelFailures: 0, liveFailures: 0 }
    this.stopped = false
    this.relogging = false
    this.connecting = false
    this.probing = false
    this.checking = false
    this.refreshing = false
    this.stallsHeld = false // stalled streams left alone while the NVR cools down (logged once)
    this.probeFailedAt = 0
    this.relogins = [] // times of recent relogins, for back-off
    this.gen = 0 // session generation: results from an older session are ignored
    this.controlFailed = false // this login has failed since it was last up (or since the start): see borrowing
    this.lane = new Lane(cfg.id, LANE_CONCURRENCY, { holdAt: LANE_HOLD_AT })
    this.sessions = new SessionPool(this)
    this.playback = createPlayback(this)
    this.loggedInAt = 0 // when the current session logged in (playback.mjs asks for no recording dates just after)
    this.lastOwnPoll = 0 // when this process last read the camera list itself
    this.listReadAt = 0 // when the camera list was last read (the routine read, the stall probe, a login)
    this.listChangedAt = 0 // when a read last found a camera added, gone, renamed, moved, offline or back
    // the turns of the routine read since the last hourly line: read (failed: no answer), or not read
    // because every stream flows (quiet), most are silent (frozen), or the NVR cools down or is busy
    this.listTurns = { since: Date.now(), read: 0, failed: 0, quiet: 0, frozen: 0, busy: 0 }
    this.workerListAt = 0 // when the live worker last sent its camera list (STATS)
    this.refreshTimer = null
    this.#scheduleRefresh()
    this.#connect().catch((e) => this.#log('connect', e))
  }

  // a camera-list turn every ~30 s, +-20% so NVRs (and processes) don't all ask in the same second
  // (whether a turn reads the list: #refresh)
  #scheduleRefresh() {
    if (this.stopped) return
    this.refreshTimer = setTimeout(() => {
      this.#refresh()
        .catch((e) => this.#log('refresh', e))
        .finally(() => this.#scheduleRefresh())
    }, jittered(CHANNEL_REFRESH_MS))
    this.refreshTimer.unref?.()
  }

  /** The live worker is up and sent its camera list recently: it does the polling. */
  get #workerPolls() {
    return Boolean(this.worker) && this.worker.state() === 'ready' && Date.now() - this.workerListAt < WORKER_LIST_FRESH_MS
  }

  /** For live video: with a worker, what the worker's own login says; else this process's login. */
  get liveOnline() {
    const s = this.worker?.state() === 'ready' ? this.worker.stats() : null
    if (s?.status) return s.status === 'online'
    return this.online
  }

  #log(what, e) {
    console.warn(`[${this.id}] ${what} failed: ${e?.message ?? e}`)
  }

  /** Updates labels in place; returns true if the connection settings changed. */
  apply(cfg) {
    const changed = ['host', 'port', 'user', 'password', 'sn'].some((k) => this.cfg && (this.cfg[k] ?? '') !== (cfg[k] ?? ''))
    this.cfg = { ...cfg }
    this.id = cfg.id
    this.site = cfg.site || 'Unassigned'
    this.name = cfg.name || cfg.id
    return changed
  }

  get online() {
    return this.status === 'online'
  }

  /**
   * Recovering, or SDK calls to this NVR are stuck, or the SDK itself is (sdk.mjs sdkStuck: a call
   * to any NVR overdue with nothing back since): don't start optional work (playback, settings,
   * event searches, tests). The SDK runs one call at a time for every NVR, so work for this NVR
   * would only queue behind another NVR's stuck call.
   */
  get degraded() {
    return !this.online || this.relogging || this.probing || lateCalls(this.id) > 0 || sdkStuck()
  }

  /** The worker's STATS while it is ready, logged in and reports its session; else null. */
  get #workerSession() {
    const s = this.worker?.state() === 'ready' ? this.worker.stats() : null
    return s?.status === 'online' && Number.isInteger(s.gen) ? s : null
  }

  /**
   * XML commands go out on the worker's login: this process's own (control) login is down and has
   * failed at least once since it was last up, while the worker is logged in. An NVR at its session
   * limit lets one of the two in (shad, 2026-10-06, for most of a day). "Failed once" keeps a normal
   * start out of it: a slow P2P login is still in progress then, not refused. This login keeps
   * retrying and takes over again when it gets in. CCTV_XML_VIA_WORKER=off turns it off (read here,
   * not at import, so the service's env file can change it at a restart and the tests can too).
   */
  get borrowing() {
    return process.env.CCTV_XML_VIA_WORKER !== 'off' && !this.online && this.controlFailed && this.#workerSession !== null
  }

  /** An XML command can be sent: on this login, or on the worker's (xml-session.mjs). */
  get xmlOnline() {
    return this.online || this.borrowing
  }

  /**
   * The session an XML command would use. A page that read its settings on one session is refused
   * a write on another (nvr-xml.mjs transparent), and a change of path counts as a change of session.
   */
  get xmlGen() {
    const s = this.borrowing ? this.#workerSession : null
    return s ? `worker:${this.worker.spawnedAt?.() ?? 0}:${s.gen}` : `own:${this.gen}`
  }

  /** As degraded, for the session an XML command would use. */
  get xmlDegraded() {
    if (!this.borrowing) return this.degraded
    return (this.#workerSession?.sdk?.late ?? 0) > 0 || sdkStuck()
  }

  info() {
    const subs = [...this.codecSeen.entries()].filter(([k]) => k.endsWith(':1')).map(([, v]) => v.codec)
    return {
      id: this.id,
      site: this.site,
      name: this.name,
      host: this.cfg.host,
      sn: this.cfg.sn || '',
      via: this.cfg.sn ? 'p2p' : 'lan',
      remote: Boolean(this.cfg.sn || this.cfg.remote),
      // Video is flowing even though the control login is down (e.g. a P2P NVR at its session cap:
      // the worker holds the video login while this process's second, control login can't get in):
      // report online, not the control login's offline. Health and the nvr-offline alert read this.
      // allCameras() still uses the control login for per-camera events, so a worker restart does not
      // read as every camera going offline.
      status: !this.online && this.liveOnline ? 'online' : this.status,
      error: !this.online && this.liveOnline ? '' : this.error,
      model: this.model,
      serial: this.serial,
      cameras: this.channels.length,
      camerasOnline: this.channels.filter((c) => c.online).length,
      subStreamsSeen: { h264: subs.filter((c) => c === 'h264').length, h265: subs.filter((c) => c === 'h265').length }
    }
  }

  /** Called by live streams on keyframes: remembers which codec each camera actually sends. */
  noteCodec(ch, streamType, codec, width, height) {
    this.codecSeen.set(`${ch}:${streamType}`, { codec: codec === CODEC_H265 ? 'h265' : 'h264', width, height, at: Date.now() })
  }

  async #connect() {
    if (this.connecting) return
    this.connecting = true
    try {
      await initSdk()
      for (let delay = RETRY_MIN_MS; !this.stopped; delay = Math.min(delay * 2, RETRY_MAX_MS)) {
        this.status = this.status === 'offline' ? 'offline' : 'connecting'
        const { host, port, user, password, sn, nat } = this.cfg
        const where = whereIs(this.cfg)
        const info = {}
        const t0 = Date.now()
        // a login to an NVR that doesn't answer holds the connect lane for ~15 s: let others go first.
        // Also a repeatedly-reconnecting NVR (relogins.length > 1), so one flapping P2P site does not
        // keep the healthy NVRs' logins waiting behind it, even while it still shows "connecting".
        const priority = this.status === 'offline' || this.relogins.length > 1 ? PRIORITY.LOW : PRIORITY.NORMAL
        const { userId, why } = await login({ host, port, user, password, sn, nat }, { tag: 'login', nvr: this.id, info, priority })
        if (this.stopped) {
          if (userId >= 0) logoutLate('login', this.id)(userId)
          return
        }
        if (userId >= 0) {
          this.gen++
          this.userId = userId
          this.loggedInAt = Date.now()
          this.model = String(info.deviceProduct ?? '').replace(/\0.*$/, '')
          this.serial = String(info.szSN ?? '').replace(/\0.*$/, '').trim()
          this.health = { channelFailures: 0, liveFailures: 0 }
          await sleep(1500) // the NVR pushes channel state right after login
          // a busy NVR just after a restart: the SDK gives up on this after 10 s; ask once more
          if (!(await this.#queryChannels(PRIORITY.HIGH))) await this.#queryChannels(PRIORITY.HIGH)
          this.status = 'online'
          this.error = ''
          this.controlFailed = false
          console.log(`[${this.id}] logged in to ${where} (${this.model || 'NVR'}) in ${Date.now() - t0} ms, ${this.channels.length} cameras`)
          return
        }
        this.error = why
        this.status = 'offline'
        this.controlFailed = true
        console.log(`[${this.id}] login to ${where} failed: ${this.error}; retrying in ${delay / 1000}s`)
        await sleep(delay)
      }
    } finally {
      this.connecting = false
    }
  }

  /**
   * Reads the camera list. Returns false if the NVR did not answer.
   * background: nobody waits on this read (the routine one), so coming back late does not start the
   * NVR's cool-down (sdk.mjs); the stall probe and liveFailed's check are not background.
   */
  async #queryChannels(priority = PRIORITY.LOW, { background = false } = {}) {
    const max = 64
    const size = koffi.sizeof(IPC_INFO)
    const buf = Buffer.alloc(size * max)
    const count = Buffer.alloc(8)
    const userId = this.userId
    if (userId < 0) return false
    const ok = await this.lane
      // one at a time per NVR: the refresh, the stall probe and liveFailed can all ask at once,
      // and two of these overlapping preceded a heap-corruption crash
      .run(() => sdkCallT({ nvr: this.id, tag: 'channels', exclusive: `${this.id}/channels`, background }, NET_SDK.GetDeviceIPCInfo, userId, buf, buf.length, count), { priority })
      .catch(() => false)
    if (!ok || userId !== this.userId) return Boolean(ok)
    const n = Math.min(Number(count.readBigInt64LE(0)), max)
    const list = []
    for (let i = 0; i < n; i++) {
      const ipc = koffi.decode(buf, i * size, IPC_INFO)
      // An NVR reports every channel slot it has, empty ones included. A slot with no camera
      // address and no name has no camera in it; counting those as offline cameras made the
      // alerts claim 21 of rigginglot's 11 cameras were down.
      const configured = Boolean(String(ipc.szServer ?? '').trim() || String(ipc.szChlname ?? '').trim())
      // the camera's own make and model, as the NVR reports them: how a spec sheet is found (does
      // it have a microphone, a speaker, how wide is it ...)
      const model = String(ipc.productModel ?? '').replace(/\0.*$/, '').trim()
      const maker = String(ipc.manufacturerName ?? '').replace(/\0.*$/, '').trim()
      // the camera's own address and web port, as the NVR connects to it: settings the NVR cannot
      // pass on (day/night on some models) are made on the camera's own page (admins only, see
      // /api/admin/camera-addresses)
      const ip = String(ipc.szServer ?? '').replace(/\0.*$/, '').trim()
      const httpPort = Number(ipc.nHttpPort) || null
      list.push({ ch: ipc.channel, name: ipc.szChlname || `Camera ${ipc.channel + 1}`, online: ipc.status === 1, configured, model, maker, ip, httpPort })
    }
    // A P2P (serial) NVR's per-camera status above is unreliable over the cloud (it even comes back
    // empty at random), so the NVR's own queryOnlineChlList is the authority instead (#reconcileP2pOnline).
    if (this.cfg.sn && list.length > 0) await this.#reconcileP2pOnline(list)
    if (list.length > 0) {
      list.sort((a, b) => a.ch - b.ch)
      // (the first list of this process is no change: there was nothing to compare it with)
      if (this.channels.length > 0 && listSig(list) !== listSig(this.channels)) this.listChangedAt = Date.now()
      this.channels = list
    }
    this.listReadAt = Date.now()
    return true
  }

  /** A channel that is delivering video right now: it is online whatever the status flag says. */
  #channelHasVideo(ch) {
    for (const s of this.streams.values()) if (s.ch === ch && s.state === 'playing' && s.gotVideo) return true
    return false
  }

  /**
   * Corrects a P2P NVR's camera online flags from the NVR's own queryOnlineChlList (see
   * applyP2pOnline). The list is small and answers in ~100 ms over the cloud; the last good one is
   * kept, so a read that fails does not blank the states, and a brand-new process with no list yet
   * falls back to the as-read flag plus video.
   */
  async #reconcileP2pOnline(list) {
    const set = await this.#onlineChannels()
    if (set) this.p2pOnlineSet = set
    applyP2pOnline(list, { hasVideo: (ch) => this.#channelHasVideo(ch), onlineSet: set ?? this.p2pOnlineSet ?? null })
  }

  /** The NVR's online channels (queryOnlineChlList), or null if the read failed. Never throws. */
  async #onlineChannels() {
    if (this.userId < 0) return null
    try {
      return parseOnlineChlList(String((await transparent(this, 'queryOnlineChlList', `${XML_HEADER}</request>`, 'online channels', { outBytes: 64 * 1024 })) ?? ''))
    } catch {
      return null
    }
  }

  /**
   * Full per-camera detail for the localhost export (camera-export.mjs): a fresh GetDeviceIPCInfo for
   * identity and the extra IPC_INFO fields the routine poll drops, queryRecStatus for main/sub
   * resolution, frame rate and recording status, the sub-stream codec as last seen in live video, and
   * the main-stream encoder (incl. whether H.265+ is on and offered). Read-only -- never mutates
   * this.channels. Runs on this process's own login (the control login when a worker holds the video) and is never borrowed from the worker: it is a heavy, unattended read (the nightly export), and a slow one would hold up the process that records.
   * Returns [] if the NVR did not answer; a failed queryRecStatus / encode read just leaves those fields null.
   */
  async cameraDetail() {
    // The two XML reads below name this login's session. Should it drop while they wait (the gate
    // in camera-export.mjs was passed a moment ago) they are refused, where without a session named
    // they would go out on the worker's login (borrowing): the heavy read this must keep off it.
    const own = `own:${this.gen}`
    const cams = await this.#queryChannelsFull()
    if (cams.length === 0) return cams
    let rec = null
    try {
      rec = parseRecStatus(String((await transparent(this, 'queryRecStatus', `${XML_HEADER}</request>`, 'rec status', { gen: own, outBytes: 256 * 1024 })) ?? ''))
    } catch {
      rec = null
    }
    // Main-stream encoder, incl. whether H.265+ is on and whether the camera offers it. H.265+ is an
    // encoder mode, not a distinct bitstream, so it is readable only here, never from the video. Ask for
    // the main fields only (not the big per-bitrate quality caps) to keep the answer small -- the heavy
    // full form is what the NAT 1.0 relay NVRs refuse. A failed read just leaves the encoder fields null.
    let enc = null
    try {
      enc = parseMainEncoders(String((await transparent(this, 'queryNetworkNodeEncodeInfo', `${XML_HEADER}<requireField><name/><mainCaps/><main/><an/></requireField></request>`, 'encode info', { gen: own, outBytes: 2 * 1024 * 1024 })) ?? ''))
    } catch {
      enc = null
    }
    for (const c of cams) {
      const r = rec?.get(c.ch) ?? null
      c.recStatus = r?.recStatus ?? null
      c.mainRes = r?.main?.resolution ?? null
      c.mainFps = r?.main?.fps ?? null
      c.subRes = r?.sub?.resolution ?? null
      c.subFps = r?.sub?.fps ?? null
      c.subCodec = this.codecSeen.get(`${c.ch}:1`)?.codec ?? null // as seen in live video (null if never streamed here)
      const e = enc?.get(c.ch) ?? null
      c.mainEnct = e?.enct ?? null // 'h264' | 'h265' | 'h265p' (H.265+) | 'h265s' | ... ; null if the read failed
      c.mainBitType = e?.bitType || null // 'VBR' | 'CBR' | null
      c.h265pCapable = e ? e.h265pCapable : null // null = unknown (encode read failed)
    }
    return cams
  }

  /** A fresh GetDeviceIPCInfo decoded in full (identity + the extra fields the routine poll drops); configured slots only. Never mutates state. */
  async #queryChannelsFull() {
    const max = 64
    const size = koffi.sizeof(IPC_INFO)
    const buf = Buffer.alloc(size * max)
    const count = Buffer.alloc(8)
    const userId = this.userId
    if (userId < 0) return []
    // same exclusive key as #queryChannels: two overlapping GetDeviceIPCInfo once preceded a heap-corruption crash
    const ok = await this.lane
      .run(() => sdkCallT({ nvr: this.id, tag: 'camera detail', exclusive: `${this.id}/channels` }, NET_SDK.GetDeviceIPCInfo, userId, buf, buf.length, count), { priority: PRIORITY.LOW })
      .catch(() => false)
    if (!ok || userId !== this.userId) return []
    const n = Math.min(Number(count.readBigInt64LE(0)), max)
    const str = (v) => String(v ?? '').replace(/\0.*$/, '').trim()
    const out = []
    for (let i = 0; i < n; i++) {
      const ipc = koffi.decode(buf, i * size, IPC_INFO)
      const ip = str(ipc.szServer)
      const name = str(ipc.szChlname)
      if (!(ip || name)) continue // empty slot, no camera in it
      out.push({
        ch: ipc.channel,
        name: name || `Camera ${ipc.channel + 1}`,
        online: ipc.status === 1,
        ip: ip || null,
        httpPort: Number(ipc.nHttpPort) || null,
        model: str(ipc.productModel) || null,
        maker: str(ipc.manufacturerName) || null,
        // extras the routine poll does not keep
        uid: guidHex(ipc.guid), // closest thing to a camera serial the SDK gives (a guid/id, not a real serial)
        mac: str(ipc.szEtherName) || null,
        camId: str(ipc.szID) || null,
        dataPort: Number(ipc.nPort) || null,
        ctrlPort: Number(ipc.nCtrlPort) || null,
        nvrLogin: str(ipc.username) || null,
        poe: Boolean(ipc.bPOEDevice)
      })
    }
    return out
  }

  /**
   * Why this turn does not read the camera list (null: read it). Only this process's own streams
   * tell (in the main process with live workers there are none, and its keepalive is not held here).
   * - 'frozen': at least 3 of the streams that play, and at least half of them, have had no video for
   *   SILENT_MS: the NVR itself has stopped answering, and a read would only be one more call to it
   *   (checkStalled's probe reads the list once they have been stalled for STALL_MS). The 15 s
   *   "stalled" alone would miss most: the late reads went out a median of 7 s into the freeze.
   * - 'quiet': every stream plays and delivers video, the list has not changed for
   *   CHANNEL_SETTLED_MS, and it was read under CHANNEL_QUIET_MS ago.
   * With no stream at all nothing tells of a camera dropping off: read every turn, as before.
   */
  #listHeld(now = Date.now()) {
    let playing = 0
    let silent = 0
    let other = 0
    for (const s of this.streams.values()) {
      if (s.stopped) continue
      if (s.state !== 'playing') other++
      else {
        playing++
        if (now - s.lastFrameAt >= SILENT_MS) silent++
      }
    }
    if (silent >= 3 && silent >= playing * MASS_STALL_SHARE) return 'frozen'
    if (playing === 0 || silent > 0 || other > 0) return null
    if (now - this.listChangedAt < CHANNEL_SETTLED_MS || now - this.listReadAt >= CHANNEL_QUIET_MS) return null
    return 'quiet'
  }

  /** Once an hour (this NVR's own streams only: its worker, or the main process without workers): how often the list was read, and why not. */
  #logListTurns(now = Date.now()) {
    const t = this.listTurns
    if (this.worker || now - t.since < CHANNEL_LOG_MS) return
    const held = t.quiet + t.frozen + t.busy
    console.log(`[${this.id}] camera list read ${t.read} times in the last hour${t.failed ? ` (${t.failed} not answered)` : ''}; not read at ${held} turns (all streams flowing ${t.quiet}, NVR frozen ${t.frozen}, cooling down or busy ${t.busy})`)
    this.listTurns = { since: now, read: 0, failed: 0, quiet: 0, frozen: 0, busy: 0 }
  }

  async #refresh() {
    this.#logListTurns()
    const turns = this.listTurns
    // one at a time, and not while this NVR cools down after a late call (it would only add another and renew the cool-down),
    // nor while the SDK is stuck on any NVR's call (it would only queue behind it)
    if (this.userId < 0 || this.relogging || this.connecting || this.refreshing || nvrCooling(this.id) || sdkStuck()) {
      turns.busy++
      return
    }
    // the worker polls and sends the list: only a slow keepalive here (keeps this control login
    // checked for picture settings, playback and motion search)
    if (this.#workerPolls && Date.now() - this.lastOwnPoll < CONTROL_KEEPALIVE_MS) return
    const held = this.#listHeld()
    if (held) {
      turns[held]++
      return
    }
    this.lastOwnPoll = Date.now()
    this.refreshing = true
    const gen = this.gen
    try {
      // background: a late one says only that the NVR had stopped answering, which its streams had
      // mostly shown already; it must not hold the NVR's new streams for a minute after it recovered
      const ok = await this.#queryChannels(PRIORITY.LOW, { background: true })
      turns.read++
      if (!ok) turns.failed++
      if (gen !== this.gen) return // the session changed meanwhile
      if (ok) {
        this.health.channelFailures = 0
        if (!this.online && !this.relogging) {
          this.status = 'online'
          this.controlFailed = false // up again: see borrowing
        }
      } else if (++this.health.channelFailures >= MAX_CHANNEL_FAILURES) {
        this.#relogin('NVR not answering').catch((e) => this.#log('relogin', e))
      }
    } finally {
      this.refreshing = false
    }
  }

  liveStarted() {
    this.health.liveFailures = 0
  }

  /**
   * A stream failed to start. One camera failing (no permission, camera rebooting, NVR stream
   * limit) must not take the whole NVR down, so this only counts while nothing else plays, and
   * a relogin needs the NVR itself to stop answering.
   */
  async liveFailed(stream) {
    this.onLiveFailed?.(stream) // the NVR worker learns the NVR's sub-stream limit from these (sub-cap.mjs)
    const others = [...this.streams.values()].some((s) => s !== stream && s.state === 'playing')
    if (others) return
    if (++this.health.liveFailures < MAX_LIVE_FAILURES) return
    this.health.liveFailures = 0
    const gen = this.gen
    if (await this.#queryChannels(PRIORITY.HIGH)) return // the NVR answers: it's the cameras, not the session
    if (gen === this.gen) this.#relogin('live streams keep failing and the NVR does not answer').catch((e) => this.#log('relogin', e))
  }

  async #relogin(why) {
    if (this.relogging || this.connecting || this.stopped) return
    // with calls to this NVR still stuck inside the SDK, a new login would only queue
    // behind them; the watchdog restarts the process if they stay stuck
    if (lateCalls(this.id) > 0) {
      console.warn(`[${this.id}] ${why}, but SDK calls to it are still stuck; waiting`)
      return
    }
    this.relogging = true
    const now = Date.now()
    this.relogins = this.relogins.filter((t) => now - t < RELOGIN_WINDOW_MS)
    const wait = RELOGIN_BACKOFF_MS[Math.min(this.relogins.length, RELOGIN_BACKOFF_MS.length - 1)]
    this.relogins.push(now)
    console.log(`[${this.id}] ${why}, logging in again${wait ? ` in ${wait / 1000} s` : ''}`)
    // "connecting", not "offline", through the backoff wait: a quick recovery then never registers as
    // an outage. #connect marks it offline only once a login attempt has actually failed (and the
    // nvr-offline alert still needs the condition to hold its 2 min either way).
    this.status = 'connecting'
    this.error = why
    try {
      await this.#closeSession()
      if (wait) await sleep(wait)
    } finally {
      this.relogging = false
    }
    if (!this.stopped) await this.#connect()
  }

  async #closeSession(reason = 'NVR reconnecting') {
    this.gen++
    for (const abort of this.scans) abort()
    this.playback.stopAll(reason)
    this.sessions.closeAll(reason)
    // stops go through the lane (a few at a time, never a burst) and each has a time limit
    await Promise.allSettled([...this.streams.values()].map((s) => s.fail(reason)))
    // a stop that ran past its time limit may still be inside the SDK: never log out under it
    // the same for XML calls (settings reads and changes): calls queued behind one are refused
    // at their session check (gen changed above), the one inside the SDK is waited for
    const [live, xml] = await Promise.all([exclusiveSettled(`${this.id}/`, LOGOUT_WAIT_MS), xmlSettled(this, LOGOUT_WAIT_MS)])
    if (!live) console.warn(`[${this.id}] live calls still inside the SDK after ${LOGOUT_WAIT_MS / 1000} s; logging out anyway`)
    if (!xml) console.warn(`[${this.id}] an XML call is still inside the SDK after ${LOGOUT_WAIT_MS / 1000} s; logging out anyway`)
    const userId = this.userId
    this.userId = -1
    if (userId >= 0) {
      await connectLane.run(() => sdkCallT({ nvr: this.id, tag: 'logout' }, NET_SDK.Logout, userId)).catch(() => {})
    }
  }

  getStream(ch, streamType) {
    // live worker: the same add/remove contract, but the stream plays in this NVR's worker
    if (this.worker) return this.worker.hub.getStream(ch, streamType)
    const key = `${ch}:${streamType}`
    let stream = this.streams.get(key)
    if (!stream) {
      stream = new LiveStream(this, ch, streamType)
      this.streams.set(key, stream)
    }
    return stream
  }

  /** A viewer's sub-stream of this camera waits for room at the NVR's sub-stream limit (live worker only). */
  subHeld(ch) {
    return Boolean(this.worker) && this.subsHeld.has(ch)
  }

  /** The NVR is at its sub-stream limit: a tile's sub-stream not running yet will be held (the worker's word comes a moment later). */
  subFull() {
    return Boolean(this.worker) && this.subsFull
  }

  /** This camera's main stream plays (in the live worker, as of its last stats): a stand-in joins it without starting it. */
  mainPlaying(ch) {
    return Boolean(this.worker) && this.mainsPlaying.has(ch)
  }

  /** Restarts one live stream in place (viewers stay connected), in this process or in the NVR's worker. */
  restartStream(ch, streamType, why) {
    if (this.worker) return this.worker.hub.restartStream(ch, streamType, why)
    return this.streams.get(`${ch}:${streamType}`)?.restart(why)
  }

  streamStopped(stream) {
    if (this.streams.get(stream.key) === stream) this.streams.delete(stream.key)
  }

  /**
   * Restarts streams that stopped delivering video. If many stall at once the
   * problem is the NVR or the link, not the cameras: check the NVR once, and
   * restart the streams one by one only if it answers.
   */
  async checkStalled() {
    if (this.worker) return // the worker checks its own streams
    if (this.checking || this.probing || this.relogging || this.connecting || this.userId < 0) return
    const playing = [...this.streams.values()].filter((s) => s.state === 'playing')
    const stalled = playing.filter((s) => s.stalled)
    // calls to this NVR are stuck in the SDK or just came back late (sdk.mjs nvrCooling): restarts
    // would only pile on. Its stalled streams are handled once it has cooled down -- except the
    // recorder's, as soon as none of those calls is still inside the SDK (#stallHeld)
    const held = stalled.filter((s) => this.#stallHeld(s))
    if (!nvrCooling(this.id)) this.stallsHeld = false
    else if (held.length && !this.stallsHeld) {
      this.stallsHeld = true
      console.warn(`[${this.id}] ${held.length} stalled stream${held.length === 1 ? '' : 's'} left alone while this NVR answers slowly; restarting once it has cooled down`)
    }
    const due = stalled.filter((s) => !held.includes(s))
    if (due.length === 0) return
    this.checking = true
    const gen = this.gen
    try {
      // (the held ones count here too: many stalled at once is the NVR's problem, whoever's they are)
      if (stalled.length >= 3 && stalled.length >= playing.length * MASS_STALL_SHARE) {
        if (Date.now() - this.probeFailedAt < PROBE_BACKOFF_MS) return
        this.probing = true
        console.warn(`[${this.id}] ${stalled.length} of ${playing.length} streams stalled at once; checking the NVR`)
        let answered = false
        try {
          answered = await this.#queryChannels(PRIORITY.HIGH)
        } finally {
          this.probing = false
        }
        if (gen !== this.gen) return
        if (!answered) {
          this.probeFailedAt = Date.now()
          console.warn(`[${this.id}] NVR not answering`)
          if (++this.health.channelFailures >= MAX_CHANNEL_FAILURES) this.#relogin('NVR not answering').catch((e) => this.#log('relogin', e))
          return
        }
      }
      for (const s of due) {
        // (the NVR may have started cooling meanwhile: a restart came back late)
        if (gen !== this.gen || !s.stalled || this.#stallHeld(s)) continue
        await s.restart('stalled')
        await sleep(RESTART_SPACING_MS)
      }
    } finally {
      this.checking = false
    }
  }

  /**
   * Whether the NVR's cool-down holds back this stalled stream's restart. The recorder's stream is
   * held only while one of the NVR's calls is still inside the SDK late, as its starts are (live.mjs
   * #coolingHolds): a viewer's LivePlay back late (03:14:14, 03:50:51, 04:10:26) otherwise left a
   * recorded camera that stalled in that minute unrecorded until the cool-down was over.
   */
  #stallHeld(s) {
    return nvrCooling(this.id) && (!s.recorded || lateCalls(this.id) > 0)
  }

  async stop() {
    this.stopped = true
    this.status = 'offline'
    clearTimeout(this.refreshTimer)
    const worker = this.worker
    if (worker) worker.hub.closeAll()
    await Promise.all([this.#closeSession('NVR removed'), worker?.stop()])
    this.lane.close()
  }

  /** Worker stats (every 5 s): the codecs its streams saw, for info() and the sub-stream page. */
  workerStats(stats) {
    for (const [k, v] of Object.entries(stats?.codecSeen ?? {})) this.codecSeen.set(k, v)
    // viewers' sub-streams the worker holds at the NVR's sub-stream limit (nvr-worker.mjs, sub-cap.mjs),
    // and the cameras whose main stream plays: a held tile is shown that main meanwhile (live-attach.mjs)
    const chs = (v) => new Set((Array.isArray(v) ? v : []).filter(Number.isInteger))
    // every sub-stream held (a viewer's, a warm-up's, a lingering one's): newly so, the picture the
    // hub kept of it is old now, and a stale picture would keep a returning viewer's stand-in away
    const parked = chs(stats?.subCap?.parked ?? stats?.subCap?.held)
    for (const ch of parked) if (!this.subsParked.has(ch)) this.worker?.hub?.streams.get(`${ch}:1`)?.reset()
    this.subsParked = parked
    this.subsHeld = chs(stats?.subCap?.held)
    this.subLimit = Number.isInteger(stats?.subCap?.limit) ? stats.subCap.limit : null
    this.subsFull = stats?.subCap?.full === true
    if (Array.isArray(stats?.mainPlaying)) this.mainsPlaying = new Set(stats.mainPlaying.filter(Number.isInteger))
    // the worker's camera list (it polls; this process then does not, see #refresh)
    const list = stats?.channels
    if (Array.isArray(list) && list.length > 0 && list.every((c) => c && Number.isInteger(c.ch))) {
      // older workers do not send `configured`; assume a camera is there rather than hiding one
      // (make, model and address come along too: they were dropped here, so the app showed every
      // camera's make and model as unknown)
      const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')
      this.channels = list.map((c) => ({ ch: c.ch, name: String(c.name ?? `Camera ${c.ch + 1}`), online: c.online === true, configured: c.configured !== false, model: text(c.model, 64), maker: text(c.maker, 64), ip: text(c.ip, 64), httpPort: Number.isInteger(c.httpPort) ? c.httpPort : null })).sort((a, b) => a.ch - b.ch)
      this.workerListAt = Date.now()
    }
  }
}

// ---- server recording (CCTV_LIVE_WORKER=on only) ---------------------------
// The recorders run in the workers (recorder.mjs); here: their settings (recording settings +
// the healthy storage locations, sent again on every change), the index of what they wrote, and
// the file-cache warming of each finished segment ("recent footage in RAM", rec-cache.mjs).

export const REC_DB = join(DATA_DIR, 'recordings.db')
let index = null
/** The recordings index (rec-index.mjs), or null (no live worker, or it could not be opened). */
export const recIndex = () => index
let warmer = null
/** "Recent footage in RAM": reads each finished segment once into the file cache (rec-cache.mjs), or null (no live worker). */
export const recWarmer = () => warmer

const healthyLocations = () => listLocations().filter((l) => l.health.ok).map(({ id, path, role }) => ({ id, path, role }))
const recordingMsg = () => {
  const locations = healthyLocations()
  // every drive down: record into memory meanwhile (ram-spool.mjs), until a drive is back or it fills
  if (!locations.length) {
    const spool = spoolLocation({ index })
    if (spool) locations.push(spool)
  }
  return { recording: getSettings().recording, locations }
}
let spoolWasOn = false
let draining = false
/** Every 30 s: memory full or a drive back -> tell the workers; a drive back -> copy memory onto it. */
function watchSpool() {
  const t = setInterval(async () => {
    if (!index) return
    const real = healthyLocations()
    const on = !real.length && Boolean(spoolLocation({ index }))
    if (on !== spoolWasOn) {
      console.warn(on ? '[spool] every storage location is down: recording into the outage buffer until one is back (the oldest dropped as it fills)' : '[spool] a storage location is back: recording goes to it')
      spoolWasOn = on
      pushRecording()
    }
    // full: drop the oldest so it keeps the latest stretch (only while nothing else can take it)
    if (!real.length) await trimSpool({ index, log: (l) => console.warn(l) })
    if (real.length && !draining && index.locationUse(SPOOL_ID).segments > 0) {
      draining = true
      const target = real.find((l) => l.role === 'main') ?? real[0]
      await drainSpool({ index, target, log: (l) => console.log(l) }).catch(() => {})
      draining = false
    }
  }, 30_000)
  t.unref?.()
}
const pushRecording = () => {
  let msg
  try {
    msg = recordingMsg()
  } catch (e) {
    return console.warn(`[rec] settings not sent to the workers: ${e.message}`)
  }
  for (const n of nvrs.values()) n.worker?.setRecording(msg)
}
const onRecording = (m) => {
  if (m.t === 'recgap') {
    console.warn(`[rec ${m.nvr}/${m.ch + 1}] not recorded ${new Date(m.fromMs).toISOString()} - ${new Date(m.toMs).toISOString()}: ${m.reason}`)
    // "disk too slow": time-lapse thinning stands back for a while, so recording keeps the disk (thin-pace.mjs)
    noteRecorderGap(m)
    // a failed write: check the locations now rather than in up to 30 s (the workers get the result)
    if (/not writable/.test(m.reason)) checkHealth().catch(() => {})
  }
  if (m.t === 'segment') warmer?.onSegment(m) // (with or without the index: it only reads the file)
  if (!index) return
  if (m.t === 'segopen') index.noteOpen(m) // the file being written: memory only (playback reads it)
  else if (m.t === 'segment') {
    index.addSegment(m)
    index.noteClosed(m.path)
  } else index.addGap(m)
}
/**
 * A worker for nvrId has started: the files an earlier one had open are no longer being written
 * (dropOpen), and those it left without an index row are indexed now (rec-recover.mjs): after a restart
 * from the hour folders it can have left them in, listed by each location's share helper (perf report R8,
 * 2026-09-30: every hour folder of the NVR, 15.7-30.3 s and about 3,000 listings each restart at 4-5 days).
 */
const recoverFor = (nvrId, beforeMs) => {
  if (!index) return
  // what the dead worker said it had open ('segopen'): where a camera with no row yet can have a file left
  const opens = index.opensOf(nvrId)
  index.dropOpen(nvrId)
  const prevSpawnMs = workerSpawns.get(nvrId) ?? null
  workerSpawns.set(nvrId, beforeMs)
  let locs
  try {
    locs = listLocations().filter((l) => l.health.ok)
  } catch {
    return
  }
  // the outage buffer too: on disk it outlives a restart, and a segment left open there has to be
  // indexed, or it would never be copied to a real location nor counted towards the buffer's size.
  // It is memory, not a share, and has no helper: it is read in this process (recoverLocation local).
  let spoolId = null
  try {
    const sp = spoolLocation({ index })
    if (sp && existsSync(sp.path) && !locs.some((l) => l.id === sp.id)) {
      locs.push(sp)
      spoolId = sp.id
    }
  } catch {}
  const idx = index
  ;(async () => {
    for (const loc of locs) {
      try {
        const r = await recoverLocation({ index: idx, loc, nvrId, beforeMs, prevSpawnMs, opens, local: loc.id === spoolId })
        if (r.added.length) console.log(`[rec ${nvrId}] recovered ${r.added.length} segment file${r.added.length === 1 ? '' : 's'} left open (crash or kill) on ${loc.id} (${r.full ? 'every folder' : 'the recent hours'}: ${r.listed} folders listed in ${(r.ms / 1000).toFixed(1)} s)`)
      } catch (e) {
        console.warn(`[rec ${nvrId}] recovery scan of ${loc.path} failed: ${e.message}; the next start of this worker lists every folder`)
      }
    }
    // then the time nothing was recorded because the service (first start) or this worker was down
    try {
      const reason = startedWorkers.has(nvrId) ? 'recording worker restarted' : 'service down'
      startedWorkers.add(nvrId)
      const added = downtimeGaps({ index: idx, nvrId, channels: recordingChannels(nvrId, idx), atMs: beforeMs, reason })
      if (added.length) console.log(`[rec ${nvrId}] ${reason}: gap rows for ${added.length} camera${added.length === 1 ? '' : 's'}`)
    } catch (e) {
      console.warn(`[rec ${nvrId}] downtime gap rows not written: ${e.message}`)
    }
  })()
}
const startedWorkers = new Set() // NVR ids whose worker has started since this process began
const workerSpawns = new Map() // NVR id -> when its worker last started (this process): the dead one's start, at a restart
/** The channels of nvrId that have footage and whose recording is on now (as recorder.mjs wanted()). */
const recordingChannels = (nvrId, idx) => {
  const r = getSettings().recording
  if (!r?.defaults) return []
  return idx
    .cameras()
    .filter((c) => c.nvr === String(nvrId))
    .map((c) => c.ch)
    .filter((ch) => {
      const mode = r.cameras?.[`${nvrId}/${ch}`]?.mode ?? r.defaults.mode
      return Boolean(mode) && mode !== 'off'
    })
}
const REC_FLOWING_MS = 10_000 // a camera whose recorder had a frame this recently is recording
/**
 * Whether the workers are recording now: cameras whose recorder had a frame in the last 10 s, from
 * each worker's STATS (sent every 5 s; a worker that stops sending them soon counts as not
 * recording). The watchdog asks before it kills this process (spareWhile in startRecording): the
 * kill would take every worker, and all recording, with it.
 * @returns {string} e.g. '64 cameras on 4 NVRs', or '' when none is recording
 */
export const recordingActive = (now = Date.now()) => {
  let cams = 0
  let on = 0
  for (const n of nvrs.values()) {
    const rec = n.worker?.stats()?.rec
    if (!rec || typeof rec !== 'object') continue
    const k = Object.values(rec).filter((c) => Number.isFinite(c?.lastFrameAt) && now - c.lastFrameAt < REC_FLOWING_MS).length
    if (k) {
      cams += k
      on++
    }
  }
  return cams ? `${cams} camera${cams === 1 ? '' : 's'} on ${on} NVR${on === 1 ? '' : 's'}` : ''
}

let recordingStarted = false
function startRecording() {
  if (recordingStarted) return
  recordingStarted = true
  // a stuck SDK in this process is not worth every camera's recording (watchdog.mjs spareWhile)
  spareWhile(recordingActive)
  try {
    index = openRecIndex(REC_DB)
  } catch (e) {
    console.error(`[rec] cannot open ${REC_DB}: ${e.message}; recordings are written but not indexed`)
  }
  warmer = createWarmer() // settings memory.recentMinutes, read at each segment (0 = off)
  onSettingsChange(pushRecording)
  onStorageChange(pushRecording)
  startHealthChecks()
  watchSpool()
}

/** A new Nvr, with its live worker when CCTV_LIVE_WORKER=on. */
const makeNvr = (cfg) => {
  const nvr = new Nvr(cfg)
  if (LIVE_WORKER) {
    // (each worker's recorders' write queues, every 5 s: writes waiting make time-lapse stand back before a gap, thin-pace.mjs)
    nvr.worker = startWorker(nvr.id, { onStats: (s) => { nvr.workerStats(s); noteRecorderQueues(nvr.id, s?.rec) }, onRecording, onReady: ({ spawnedAt }) => recoverFor(nvr.id, spawnedAt) })
    try {
      nvr.worker.setRecording(recordingMsg())
    } catch (e) {
      console.warn(`[rec] settings not sent to ${nvr.id}: ${e.message}`)
    }
  }
  return nvr
}

// ---- all NVRs -------------------------------------------------------------

/** @type {Map<string, Nvr>} */
export const nvrs = new Map()

const STOP_WAIT_MS = 8500 // the workers get 6 s to close their segments (worker-supervisor.mjs), then this process's own logout
const bounded = (p) => Promise.race([p, sleep(STOP_WAIT_MS)])

let syncing = Promise.resolve()
const sync = () => {
  syncing = syncing.then(syncNow, syncNow).catch((e) => console.error(`NVR list sync failed: ${e.message}`))
  return syncing
}

async function syncNow() {
  let cfg
  try {
    cfg = readConfig()
  } catch (e) {
    console.error(`Cannot read ${NVRS_FILE}: ${e.message}`)
    return
  }
  // NVRs by serial number only while P2P is switched on (see P2P_ENABLED)
  const skipped = cfg.nvrs.filter((n) => n?.sn && !P2P_ENABLED)
  if (skipped.length) console.warn(`${skipped.map((n) => n.id).join(', ')}: by serial number (P2P cloud), which is switched off on this server (CCTV_P2P=off); not connecting`)
  const wanted = new Map(cfg.nvrs.filter((n) => n && n.id && n.host && (!n.sn || P2P_ENABLED)).map((n) => [n.id, n]))
  for (const [id, nvr] of nvrs) {
    if (!wanted.has(id)) {
      console.log(`[${id}] removed`)
      nvrs.delete(id)
      await retire(nvr)
    }
  }
  for (const [id, c] of wanted) {
    const existing = nvrs.get(id)
    if (!existing) {
      await workerGone(id)
      nvrs.set(id, makeNvr(c))
    } else if (existing.apply(c)) {
      console.log(`[${id}] connection settings changed, reconnecting`)
      nvrs.delete(id)
      await retire(existing)
      await workerGone(id)
      nvrs.set(id, makeNvr(c))
    }
  }
}

// live worker: an NVR's old worker must have exited (its login gone) before a new one is forked
// for the same id, or the NVR sees an extra video login; worker.stop() ends in SIGKILL if needed
const exitingWorkers = new Map() // id -> Promise (the old worker's stop)
const retire = async (nvr) => {
  if (nvr.worker) {
    const p = nvr.worker.stop()
    exitingWorkers.set(nvr.id, p)
    p.catch(() => {}).then(() => exitingWorkers.get(nvr.id) === p && exitingWorkers.delete(nvr.id))
  }
  await bounded(nvr.stop()) // the parent's own session: give up after STOP_WAIT_MS as before
}
const workerGone = (id) => (exitingWorkers.get(id) ?? Promise.resolve()).catch(() => {})

// ---- events and alarms (phase 7) -------------------------------------------------------------
//
// Three small jobs, all deliberately slow. Event intake polls the NVRs' own recorded-file index one
// camera at a time (events.mjs explains why that is the only confirmed source and how gently it is
// done); the offline check turns a camera dropping off into an event; and the window push tells each
// worker which stretches its event-mode cameras should be recording (rec-modes.mjs).
//
// The notifier is given its own sender built from the same settings and the same alert-send.mjs the
// health alerts use, rather than being handed the health checks' instance: server.mjs owns that one,
// and this phase adds nothing to server.mjs. Delivery, retries and failure reporting are unchanged.
const EVENT_TICK_MS = 5000 // the intake rate-limits itself; this is only how often it is offered a turn
const OFFLINE_TICK_MS = 30_000
const WINDOW_TICK_MS = 15_000
let eventIntake = null
/** What event intake is doing, per NVR, for the Alarms and Health pages ([] when it is not running). */
export const eventStatus = () => eventIntake?.status() ?? []

/**
 * An NVR's clock minus this server's, from its last clock read (playback.mjs lastClock), for
 * line-actions.mjs onServerClock: a crossing's snapshot and bookmark are taken on this server's clock,
 * its recordings' time base. The intake reads each NVR's clock about once a minute; before the first
 * read after a start, and under 2 s, it is 0 and the event's own times are used.
 */
const skewOf = (nvrId) => nvrs.get(nvrId)?.playback?.lastClock?.()?.skewMs ?? 0

async function startEvents() {
  const [{ intakeClock, makeEventIntake }, { buildWindowMessage }, { eventsOfCamera }, { makeAlarmNotifier }, { makeSender }] = await Promise.all([
    import('./events.mjs'), import('./rec-modes.mjs'), import('./events-db.mjs'), import('./alarms.mjs'), import('./alert-send.mjs')
  ])
  const sender = makeSender({ settings: () => getSettings().alerts ?? {} })
  // the alert's link back to the event in Argus (settings publicUrl): passed in rather than
  // imported by alarms.mjs, whose tests run without the SDK that settings.mjs loads
  // never fatal: without line-actions.mjs the alerts still go, only without the link
  const eventLink = await import('./line-actions.mjs').then((m) => m.eventLink, (e) => {
    console.warn(`[alarms] alerts go without a link to the event: ${e.message}`)
    return () => ''
  })
  const notifier = makeAlarmNotifier({
    sender,
    tzOffsetMin: () => siteOffsetMin(),
    nameOf: (key) => allCameras().find((c) => `${c.nvr}/${c.ch}` === key)?.name ?? key,
    linkOf: (row) => eventLink(row.id)
  })

  // A line crossing the recorded-file intake finds itself (record bits 0x80/0x400) gets the same
  // automatic bookmark and snapshot as one the alarm watch saw first (line-actions.mjs onLineCrossing
  // ignores every other event type, so it is safe to call for every event this intake reports). Loaded
  // non-fatally, the same way as startLineWatch below: a failed import logs one warning and the intake
  // carries on, only without a bookmark or a picture for these.
  const lineCrossing = await Promise.all([import('./line-actions.mjs'), import('./event-snapshot.mjs')]).then(
    ([{ onLineCrossing, onServerClock }, { takeSnapshot }]) => ({ onLineCrossing, onServerClock, takeSnapshot }),
    (e) => {
      console.warn(`[lines] recorded crossings get no automatic bookmark or snapshot: ${e.message}`)
      return null
    }
  )
  const nameOf = (key) => allCameras().find((c) => `${c.nvr}/${c.ch}` === key)?.name ?? key
  const snapshot = (event) => {
    const index = recIndex()
    // no recordings index here (no live worker, or it could not be opened): nothing to take a picture from
    return index ? lineCrossing.takeSnapshot(event, { index }) : Promise.resolve(null)
  }

  eventIntake = makeEventIntake({
    listNvrs: () => [...nvrs.values()],
    camerasOf: (nvr) => nvr.channels.filter((c) => c.configured !== false),
    // background work: nobody waits on these, so one that comes back late does not hold the NVR's
    // playback and searches (sdk.mjs); the clock is the NVR's last read while it is under a minute old
    recordings: (nvr, ch, date) => nvr.playback.recordings(ch, date, { background: true }),
    clock: (nvr) => intakeClock(nvr),
    onEvent: (event) => {
      void notifier.handle(event).catch((e) => console.warn(`[alarms] ${e.message}`))
      // the stored row stays on the NVR's time; its snapshot and bookmark are on this server's clock
      if (lineCrossing) void lineCrossing.onLineCrossing(lineCrossing.onServerClock(event, skewOf(event.nvr)), { snapshot, nameOf }).catch((e) => console.warn(`[lines] ${e.message}`))
    },
    log: console.warn,
    // any overdue call, for any NVR: the SDK runs one call at a time for all of them
    sdkBusy: () => lateCalls() > 0
  })

  // Line crossings within seconds. Started on its own and never fatal: if the watcher or a module it
  // needs cannot load, the recorded-file intake above still finds the crossings, only later.
  startLineWatch(notifier).catch((e) => console.warn(`[alarm-watch] not started: ${e.message}`))

  const every = (ms, fn) => {
    const t = setInterval(() => {
      try {
        const r = fn()
        if (r?.catch) r.catch((e) => console.warn(`[events] ${e.message}`))
      } catch (e) {
        console.warn(`[events] ${e.message}`)
      }
    }, ms)
    t.unref?.()
  }
  every(EVENT_TICK_MS, () => eventIntake.tick())
  every(OFFLINE_TICK_MS, () => eventIntake.checkOffline(allCameras()))
  every(WINDOW_TICK_MS, () => {
    if (!LIVE_WORKER) return
    const recording = getSettings().recording
    for (const nvr of nvrs.values()) {
      if (!nvr.worker) continue
      nvr.worker.setEventWindows(buildWindowMessage({
        nvrId: nvr.id,
        cameras: nvr.channels,
        recording,
        eventsOf: (ch, from, to) => eventsOfCamera(nvr.id, ch, from, to),
        nowMs: Date.now()
      }))
    }
  })
}

// ---- line crossings (alarm-watch.mjs) --------------------------------------------------------------
//
// The cameras' own line-crossing alarms, read from each NVR's live alarm list every 5 s, and only on
// NVRs where an admin has switched lines on (tripwire.mjs lines-on.json). A new crossing is stored like
// any other event, goes through the same rules and notifier as the recorded-file intake's new events
// (onEvent above), and then gets its automatic bookmark and snapshot (line-actions.mjs).
async function startLineWatch(notifier) {
  const [{ crossingHandler, startAlarmWatch }, { linesOn }, { onLineCrossing, onServerClock }, { takeSnapshot }, { addEvent }] = await Promise.all([
    import('./alarm-watch.mjs'), import('./tripwire.mjs'), import('./line-actions.mjs'), import('./event-snapshot.mjs'), import('./events-db.mjs')
  ])
  // readerFor is left to event-snapshot.mjs: its default opens the reader (SegmentReader.open()), which
  // reads the .idx; an unopened reader has no keyframe times and no picture would ever be taken
  const snapshot = (event) => {
    const index = recIndex()
    // no recordings index here (no live worker, or it could not be opened): nothing to take a picture from
    return index ? takeSnapshot(event, { index }) : Promise.resolve(null)
  }
  const nameOf = (key) => allCameras().find((c) => `${c.nvr}/${c.ch}` === key)?.name ?? key
  startAlarmWatch({
    nvrs: () => nvrs.values(),
    linesOn,
    // a read with nothing to say: the XML queue, the read breaker and the busy refusals all apply to it
    query: (nvr) => transparent(nvr, 'queryAlarmStatus', `${XML_HEADER}</request>`, 'alarm watch'),
    // the stored row stays on the NVR's time (alarmTime); its snapshot and bookmark are on this server's clock
    onCrossing: crossingHandler({
      addEvent,
      handle: (event) => {
        void notifier.handle(event).catch((e) => console.warn(`[alarms] ${e.message}`))
        void onLineCrossing(onServerClock(event, skewOf(event.nvr)), { snapshot, nameOf }).catch((e) => console.warn(`[lines] ${e.message}`))
      },
      grew: (event) => void onLineCrossing(onServerClock(event, skewOf(event.nvr)), { snapshot, nameOf }).catch((e) => console.warn(`[lines] ${e.message}`))
    }),
    log: console.warn,
    // any overdue call, for any NVR: a question now would only queue behind it (as for the intake)
    sdkBusy: () => lateCalls() > 0
  })
}

export const startNvrs = () => {
  if (LIVE_WORKER) startRecording()
  // Never fatal: a server that cannot do events must still record and still show live video.
  startEvents().catch((e) => console.warn(`[events] intake not started: ${e.message}`))
  seedConfig()
  sync()
  watchFile(NVRS_FILE, { interval: 2000 }, () => sync())
  setInterval(() => {
    for (const nvr of nvrs.values()) nvr.checkStalled().catch((e) => console.warn(`[${nvr.id}] stall check: ${e.message}`))
  }, 5000)
}

/** Every camera on every NVR, grouped by site then NVR. (Only fields the grid uses: it re-renders on any change.) */
/**
 * Every camera. live: `online` follows the NVR's video login (the worker's, up in ~4.5 s after a
 * start) for the Live grid and the warm-up; otherwise the control login, as before, for events
 * (camera-offline) and alarms: a worker restarting must not read as every camera going offline.
 * anyLogin: either login will do, the rule Health and the nvr-offline alert use for the NVR itself
 * (info() above). A P2P NVR at its session limit keeps refusing the control login while the worker
 * streams; judged by the control login alone, every camera of an NVR the page calls online read
 * offline (shad, 2026-10-06: "12 cameras offline", all of them showing video).
 */
export const allCameras = ({ live = false, anyLogin = false } = {}) =>
  [...nvrs.values()]
    .sort((a, b) => a.site.localeCompare(b.site) || a.name.localeCompare(b.name))
    .flatMap((nvr) =>
      nvr.channels.map((c) => ({
        nvr: nvr.id,
        site: nvr.site,
        nvrName: nvr.name,
        ch: c.ch,
        name: c.name,
        // live: the video login (Live waited for the control login, one NVR at a time, up to ~31 s)
        online: c.online && (anyLogin ? nvr.online || nvr.liveOnline : live ? nvr.liveOnline : nvr.online),
        // false for an empty channel slot on the NVR: there is no camera there to be offline
        configured: c.configured !== false,
        model: c.model || null,
        maker: c.maker || null,
        // whether the server is set to record this camera, so a live tile can show the red dot
        // that tells a viewer at a glance this one is being kept
        recording: cameraRecording(nvr.id, c.ch).mode !== 'off',
        // another site (VPN, TVT P2P): little bandwidth, so the full-size view stays on the sub stream
        remote: Boolean(nvr.cfg.sn || nvr.cfg.remote)
      }))
    )

export const stopNvrs = () => Promise.all([...nvrs.values()].map((n) => bounded(n.stop())))
