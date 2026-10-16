// A Hikvision device in the server: the stand-in nvrs.mjs keeps in its `nvrs` map next to the TVT
// NVRs (nvrs.mjs makeNvr). It holds no SDK session of its own: everything goes through its own child
// process (hik-worker.mjs, started by worker-supervisor.mjs whatever CCTV_LIVE_WORKER says), so a crash
// in the Hikvision SDK cannot take down the server or a TVT NVR. Live video comes from the worker's
// hub exactly as a TVT NVR's does: nvr.getStream(ch, type) -> stream-hub.mjs HubStream, which is what
// Live, views, camera links (rtsp), steady picture and the H.264 fallback all use.
//
// What a TVT NVR has and this does not (stage 1): playback from the device, the NVR's XML settings,
// reboot, disks, clock sync, events. Those features read nvr.online (false here: there is no control
// login), nvr.xmlOnline (false) and nvr.degraded (true), and refuse as they do for an NVR that is not
// reachable; the stubs below answer anything that gets past them with UNSUPPORTED.
import { fork } from 'node:child_process'
import { HIK_CONNECTION_KEYS, hikChildEnv, p2pChanged } from './hik-config.mjs'
import { UNSUPPORTED } from './hik-worker-core.mjs'
import { startWorker as startWorkerDefault } from './worker-supervisor.mjs'

const unsupported = () => Promise.reject(Object.assign(new Error(UNSUPPORTED), { status: 501 }))

export class HikNvr {
  /** @param {object} cfg @param {{ startWorker?: Function, env?: object }} [o] (tests: a fake supervisor) */
  constructor(cfg, { startWorker = startWorkerDefault, env = process.env } = {}) {
    this.brand = 'hikvision'
    this.apply(cfg)
    this.userId = -1 // no session in this process
    this.model = ''
    this.serial = ''
    this.channels = []
    this.streams = new Map() // (they play in the worker; kept for code that counts them)
    this.codecSeen = new Map()
    this.mainsPlaying = new Set()
    this.scans = new Set()
    this.stopped = false
    this.loggedInAt = 0
    this.workerListAt = 0
    this.p2pStatus = null
    // what the TVT-only features find if they get this far
    this.playback = { lastClock: () => null, clock: unsupported, recordings: unsupported, isHdOnly: () => false, connect: (ws) => { ws?.close?.(1013, UNSUPPORTED); return null } }
    this.sessions = { acquire: unsupported }
    this.lane = { run: unsupported, clear() {}, close() {} }
    this.worker = startWorker(cfg.id, {
      script: './hik-worker.mjs',
      env: hikChildEnv(env),
      onStats: (s) => this.workerStats(s)
    })
  }

  /** Updates labels in place; true when the worker must start again (connection settings changed). */
  apply(cfg) {
    const changed = Boolean(this.cfg) && (HIK_CONNECTION_KEYS.some((k) => (this.cfg[k] ?? '') !== (cfg[k] ?? '')) || p2pChanged(this.cfg, cfg))
    this.cfg = { ...cfg }
    this.id = cfg.id
    this.site = cfg.site || 'Unassigned'
    this.name = cfg.name || cfg.id
    return changed
  }

  /** The worker's last stats while it is ready, else null. */
  get #stats() {
    return this.worker?.state() === 'ready' ? this.worker.stats() : null
  }
  get status() {
    return this.#stats?.status ?? 'connecting'
  }
  get error() {
    return this.#stats?.error ?? ''
  }
  get gen() {
    return this.#stats?.gen ?? 0
  }
  /** No control login: the TVT settings, playback and events never run against this device. */
  get online() {
    return false
  }
  get liveOnline() {
    return this.#stats?.status === 'online'
  }
  get degraded() {
    return true
  }
  get borrowing() {
    return false
  }
  get xmlOnline() {
    return false
  }
  get xmlDegraded() {
    return true
  }
  get xmlGen() {
    return `hik:${this.gen}`
  }

  info() {
    const subs = [...this.codecSeen.entries()].filter(([k]) => k.endsWith(':1')).map(([, v]) => v.codec)
    return {
      id: this.id,
      site: this.site,
      name: this.name,
      brand: 'hikvision',
      host: this.cfg.host,
      sn: '',
      via: 'lan',
      remote: Boolean(this.cfg.remote),
      status: this.status,
      error: this.status === 'online' ? '' : this.error,
      model: this.model,
      serial: this.serial,
      cameras: this.channels.filter((c) => c.configured !== false).length,
      camerasOnline: this.channels.filter((c) => c.configured !== false && c.online).length,
      subStreamsSeen: { h264: subs.filter((c) => c === 'h264').length, h265: subs.filter((c) => c === 'h265').length }
    }
  }

  noteCodec() {} // (the worker reports codecs in its stats)

  getStream(ch, streamType) {
    return this.worker.hub.getStream(ch, streamType)
  }
  subHeld() {
    return false
  }
  subFull() {
    return false
  }
  mainPlaying(ch) {
    return this.mainsPlaying.has(ch)
  }
  restartStream(ch, streamType, why) {
    return this.worker.hub.restartStream(ch, streamType, why)
  }
  streamStopped() {}
  async checkStalled() {} // the worker checks its own streams
  async cameraDetail() {
    return this.channels.filter((c) => c.configured !== false).map((c) => ({ ch: c.ch, name: c.name, online: c.online && this.liveOnline, ip: c.ip || null, model: null, maker: 'Hikvision' }))
  }

  /** The worker's stats (every 5 s, and at once on a change of state). */
  workerStats(s) {
    if (!s) return
    for (const [k, v] of Object.entries(s.codecSeen ?? {})) this.codecSeen.set(k, v)
    if (typeof s.model === 'string' && s.model) this.model = s.model.slice(0, 64)
    if (typeof s.serial === 'string' && s.serial) this.serial = s.serial.slice(0, 64)
    if (Array.isArray(s.mainPlaying)) this.mainsPlaying = new Set(s.mainPlaying.filter(Number.isInteger))
    if (s.p2p) this.p2pStatus = s.p2p
    const list = s.channels
    if (Array.isArray(list) && list.every((c) => c && Number.isInteger(c.ch))) {
      const t = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')
      this.channels = list.map((c) => ({ ch: c.ch, name: String(c.name ?? `Camera ${c.ch + 1}`).slice(0, 64), online: c.online === true, configured: c.configured !== false, model: t(c.model, 64), maker: t(c.maker, 64) || 'Hikvision', ip: t(c.ip, 64), httpPort: Number.isInteger(c.httpPort) ? c.httpPort : null })).sort((a, b) => a.ch - b.ch)
      this.workerListAt = Date.now()
    }
    if (s.status === 'online' && !this.loggedInAt) this.loggedInAt = Date.now()
  }

  async stop() {
    this.stopped = true
    const w = this.worker
    w?.hub.closeAll()
    await w?.stop()
  }
}

const TEST_MS = 60_000 // login (3 tries x 5 s), device info, IP channels, logout, with room

/**
 * One test login in a child process (hik-test-login.mjs). Resolves the device's model, serial and
 * camera count; rejects with the plain reason. Never loads the SDK in this process.
 * @param {object} fields host, port, user, password (+ p2p)
 */
export function testHikLogin(fields, { env = process.env, timeoutMs = TEST_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./hik-test-login.mjs', import.meta.url), [], { env: { ...hikChildEnv(env), CCTV_HIK_TEST_CHILD: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' })
    let done = false
    const lines = []
    const keep = (d) => {
      for (const l of String(d).split('\n')) if (l.trim() && lines.length < 20) lines.push(l.trim())
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const finish = (fn, v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch {}
      fn(v)
    }
    const timer = setTimeout(() => finish(reject, new Error('the test did not finish in time')), timeoutMs)
    child.on('message', (r) => (r?.ok ? finish(resolve, r) : finish(reject, Object.assign(new Error(r?.why || 'the test failed'), { p2p: r?.p2p ?? null }))))
    child.on('error', (e) => finish(reject, e))
    child.on('exit', (code, signal) => finish(reject, new Error(`the test process ended (${signal ?? `code ${code}`})${lines.length ? `: ${lines.at(-1).slice(0, 200)}` : ''}`)))
    child.send({ host: fields.host, port: fields.port, user: fields.user, password: fields.password ?? '', p2p: fields.p2p ?? null })
  })
}
