// "Steady picture": a camera that shakes (on a pole in the wind, on a gate post) is steadied on the
// server, for every live viewer of it, when an admin has switched it on for that camera. The cameras
// have no stabilisation of their own (queryChlVideoParam on 9 cameras over 3 NVRs, 2026-10-14: no
// antiShake / EIS), so the server does it: each picture is locked to the camera's own background and
// its empty edge kept from the picture before (steady-lock.mjs LockTranscoder). ffmpeg's deshake, used
// first, followed the sway instead of cancelling it (2026-10-16, g-port/3 in the wind: "it dont work";
// on a measured clip it left 6.9 of 8.8 px, the lock 0.10).
//
// What it costs, measured on the production server (Xeon Gold 5317, 8 cores) with a 704-wide 20 fps
// stream paced as the camera sends, libx264 veryfast on one thread: about half a core per camera
// (decode, lock in a worker thread, encode), pictures out 0.1 s after they go in. So: the sub-stream,
// scaled to STEADY_WIDTH, H.264 out at the camera's own frame rate.
//
// One conversion per camera, shared by everybody watching it (phone-live.mjs PhoneStream, as the H.264
// conversions for office PCs share theirs: h264-fallback.mjs), started when the first viewer comes and
// stopped LINGER_MS after the last leaves. Every live viewer of the camera gets it -- grid tiles, the
// full-size view, phones, viewers from outside, the Android app: they all come through live-attach.mjs.
// A viewer who asks for the main stream (full quality) gets the main stream steadied, at most
// STEADY_MAIN_WIDTH wide (attach main), within the recorder's full-quality limit and a cap of its own
// (CCTV_STEADY_MAIN_MAX, 2: about 2 cores each). Past either, the steadied standard picture: never a
// refusal, which every page would need code to handle. Its tile says "Steady picture" (live-tile.js).
//
// How many cameras are steadied at once has a cap of its own (CCTV_STEADY_MAX, DEFAULT_MAX: 4, about
// 2 cores), apart from every other conversion's budget so that neither starves the other, and counted
// in the minute history (metrics-history.mjs other.steady). A camera past it plays as it always did and
// its tiles say "Steady picture paused: the server is busy"; when a place frees, those viewers are moved
// onto it (closed with MOVE_CODE: their tiles connect again at once and are steadied this time).
//
// A conversion that fails (no ffmpeg, a stream it cannot read), or keeps falling behind the camera
// (STALL_RESETS resets within STALL_WINDOW_MS: a busy box), is given up: its viewers are closed, connect
// again, and get the camera's own stream for FAILED_QUIET_MS, said once in the log.
//
// Switched on or off (handleSteady, admins only, audited): every live viewer of that camera is closed
// with MOVE_CODE, and connects again within about a second onto what it should have now.
//
// Pure apart from its one file: nothing here imports the SDK, so all of it is tested on any machine
// (test/steady.test.mjs).
import { readFileSync } from 'node:fs'
import { writeFileAtomicSync } from './atomic-write.mjs'
import { ended, PhoneStream } from './phone-live.mjs'
import { LockTranscoder } from './steady-lock.mjs'
import { TranscodePool } from './transcode.mjs'

/** A steadied picture is at most this wide (never wider than the camera's own sub-stream). */
export const STEADY_WIDTH = 704
/**
 * Full quality steadied (a viewer asking for the main stream of a steadied camera): the main stream,
 * scaled to at most this wide. Measured on the server with g-port/3's 2560x1440 H.265 main stream:
 * 1920 wide keeps up at about 2 cores a camera (moved by whole pixels: steady-lock.mjs
 * WHOLE_PIXEL_WIDTH); 2560 fell behind the camera.
 */
export const STEADY_MAIN_WIDTH = 1920
export const STEADY_MAIN_KBPS = 6000
export const MAIN_ENCODER_THREADS = 2
/** How many cameras may be steadied in full quality at once, unless CCTV_STEADY_MAIN_MAX says otherwise. */
export const DEFAULT_MAIN_MAX = 2
/** The encoder's settings: veryfast on one thread is what was measured (about half a core a camera, all in). */
export const STEADY_PRESET = 'veryfast'
export const STEADY_CRF = 22
export const STEADY_KBPS = 3000
export const ENCODER_THREADS = 1
/** How many cameras may be steadied at once, unless CCTV_STEADY_MAX says otherwise. */
export const DEFAULT_MAX = 4
/** A conversion nobody watches runs on this long (a tile hidden under the full-size view comes back to it). */
export const LINGER_MS = 10_000
/** A camera whose conversion failed is not tried again for this long: its viewers get its own stream. */
export const FAILED_QUIET_MS = 60_000
/** More than this many seconds of pictures in the converter and not out: it is reset (PhoneStream maxLagS). */
export const MAX_LAG_S = 2
/** ...and reset this many times within STALL_WINDOW_MS, it is given up as failed. */
export const STALL_RESETS = 3
export const STALL_WINDOW_MS = 60_000
/** "No room" is said in the log at most once in this long. */
export const BUSY_SAY_MS = 60_000
/** Why a viewer is not steadied: the `why` of its note ({ op: 'steady', on: false, why }). */
export const BUSY = 'busy'
export const FAILED = 'failed'
/**
 * A viewer moved (the setting switched, a place freed): its socket is closed with this, and its tile
 * connects again at once (live-tile.js reconnects on any close it has no special meaning for).
 */
export const MOVE_CODE = 1012
export const MOVE_REASON = 'steady picture changed'
export const READY_REASON = 'steady picture ready'

/** How the shared stream runs (PhoneStream's options): a sub-stream, every frame, always converted. */
export const STREAM = Object.freeze({
  type: 1,
  fps: 0, // nothing thinned: the camera's own frame rate
  h264Only: true,
  convertAll: true, // H.264 cameras too: the conversion is what steadies it
  subMaxWidth: STEADY_WIDTH,
  crf: STEADY_CRF,
  subKbps: STEADY_KBPS,
  keySeconds: 2,
  bufSeconds: 2,
  wholeReplay: true, // its frame rate is learnt from the GOP replayed as it joins
  slowFps: 1000, // each picture ended as it goes in: no picture held back by ffmpeg's parser
  maxLagS: MAX_LAG_S
})

/** The cap, from the environment; a bad or missing value means 4. 0: off (nothing is ever steadied). */
export function maxSteady(env = process.env, name = 'CCTV_STEADY_MAX', fallback = DEFAULT_MAX) {
  const raw = env[name]
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= 16 ? n : fallback
}

/** The cap on full quality steadied at once (CCTV_STEADY_MAIN_MAX, default 2; 0: never, the standard picture). */
export const maxSteadyMain = (env = process.env) => maxSteady(env, 'CCTV_STEADY_MAIN_MAX', DEFAULT_MAIN_MAX)

/** The full-quality stream of a camera, as the shared streams are keyed ("nvr-2/4:main"). */
const mainId = (key) => `${key}:main`

/** How a full-quality steadied stream runs: STREAM, but the main stream, at most STEADY_MAIN_WIDTH wide. */
export const MAIN_STREAM = Object.freeze({ ...STREAM, type: 0, maxWidth: STEADY_MAIN_WIDTH, mainKbps: STEADY_MAIN_KBPS })

/** A camera as this file keys it: its NVR and channel from 0 ("nvr-2/4"), as event-rules.mjs cameraKey. */
export const steadyKey = (nvr, ch) => `${nvr}/${Number(ch)}`
const KEY_RE = /^[A-Za-z0-9._-]{1,64}\/\d{1,3}$/
const NVR_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * The cameras an admin has switched "Steady picture" on for, kept in `file` (DATA_DIR/steady.json):
 *   { "cameras": { "<nvr>/<ch from 0>": { "by": "<admin>", "at": <ms> } } }
 * A camera not in it is off. Read once; written whole and atomically on every change.
 * @param {{ file: string, now?: () => number, log?: (line: string) => void, write?: (file: string, data: string) => void, read?: (file: string) => string }} o
 */
export function steadyStore({ file, now = Date.now, log = (l) => console.warn(l), write = (f, d) => writeFileAtomicSync(f, d), read = (f) => readFileSync(f, 'utf8') }) {
  const cameras = new Map() // key -> { by, at }
  try {
    const j = JSON.parse(read(file))
    for (const [k, v] of Object.entries(j?.cameras ?? {})) {
      if (KEY_RE.test(k)) cameras.set(k, { by: typeof v?.by === 'string' ? v.by.slice(0, 64) : '', at: Number.isFinite(v?.at) ? v.at : 0 })
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') log(`[steady] ${file} unreadable (${e?.message ?? e}); no camera is steadied until it is set again`)
  }
  const save = () => write(file, `${JSON.stringify({ cameras: Object.fromEntries([...cameras].sort((a, b) => a[0].localeCompare(b[0]))) }, null, 1)}\n`)
  return {
    /** Whether the camera under this key ("nvr/ch") is steadied. */
    has: (key) => cameras.has(key),
    isOn: (nvr, ch) => cameras.has(steadyKey(nvr, ch)),
    /**
     * Switches a camera on or off. Throws when the file cannot be written (and nothing changes).
     * @returns {boolean} whether anything changed
     */
    set(nvr, ch, on, by = '') {
      const key = steadyKey(nvr, ch)
      if (cameras.has(key) === (on === true)) return false
      const before = cameras.get(key)
      if (on === true) cameras.set(key, { by: String(by).slice(0, 64), at: now() })
      else cameras.delete(key)
      try {
        save()
      } catch (e) {
        if (before) cameras.set(key, before)
        else cameras.delete(key)
        throw e
      }
      return true
    },
    /** Every steadied camera: [{ nvr, ch, by, at }]. */
    list: () => [...cameras].map(([k, v]) => {
      const i = k.lastIndexOf('/')
      return { nvr: k.slice(0, i), ch: Number(k.slice(i + 1)), by: v.by, at: v.at }
    })
  }
}

/** A note for a viewer's tile: a /live-mux channel has notice(), a /live socket takes it as text. */
export function tell(ws, obj) {
  try {
    if (typeof ws.notice === 'function') ws.notice(obj)
    else ws.send(JSON.stringify(obj))
  } catch {}
}

const isOpen = (ws) => ws && ws.readyState === 1

/** Every steadied camera's shared conversion on the server, and the viewers waiting for one. */
export class SteadyLive {
  /**
   * @param {{ max?: number, isOn?: (key: string) => boolean, makeTranscoder?: (o: object) => object,
   *   log?: (line: string) => void, now?: () => number, stopDelayMs?: number, defer?: (fn: Function) => void }} [o]
   *   max: the cap (maxSteady); isOn: the setting, by key (steadyStore has); makeTranscoder, now,
   *   stopDelayMs, defer: for tests
   */
  constructor({ max = maxSteady(), mainMax = maxSteadyMain(), isOn = () => false, makeTranscoder = (o) => new LockTranscoder(o), log = (l) => console.log(l), now = () => Date.now(), stopDelayMs = LINGER_MS, defer = queueMicrotask } = {}) {
    Object.assign(this, { isOn, makeTranscoder, log, now, stopDelayMs, defer })
    this.pool = new TranscodePool(max)
    this.mainPool = new TranscodePool(mainMax) // full quality: its own cap, about 2 cores each
    this.streams = new Map() // key -> PhoneStream
    this.failed = new Map() // key -> when its conversion was given up
    this.waiting = new Map() // key -> sockets playing the camera's own stream for want of room
    this.viewers = new Map() // key -> every live socket of the camera, steadied or not (moved when the setting changes)
    this.refused = 0
    this.busySaidAt = -Infinity
  }

  /** Off (a cap of nothing): live-attach.mjs leaves every viewer as it always was. */
  get enabled() {
    return this.pool.max > 0
  }

  /** Whether the camera is to be steadied: switched on, and the feature not off. */
  wants(key) {
    try {
      return this.enabled && this.isOn(key) === true
    } catch {
      return false
    }
  }

  /** A live socket of the camera, whatever it plays: moved when the setting changes (restart). */
  watch(key, ws) {
    if (!this.viewers.has(key)) this.viewers.set(key, new Set())
    this.viewers.get(key).add(ws)
    ws.on?.('close', () => {
      const set = this.viewers.get(key)
      set?.delete(ws)
      if (set && set.size === 0) this.viewers.delete(key)
    })
  }

  /**
   * Attaches a viewer's socket to the camera's steadied stream, starting it when it is the first.
   * source: the camera's sub-stream (stream-hub.mjs HubStream, live.mjs LiveStream); camera: as the log
   * names it ("nvr-2/5"). The socket is told { op: 'steady', on: true } at once.
   * @returns {true|string} true: attached; else BUSY or FAILED, and the caller gives it the camera's own
   *   stream (and the note: noteNotSteady). A BUSY one is moved onto a place when one frees.
   */
  attach(key, source, ws, { camera, main = false } = {}) {
    // full quality (main): its own stream and cap; past the cap the caller falls back to the steadied
    // standard picture, so a full-quality viewer never waits for a place
    const id = main ? mainId(key) : key
    let s = this.streams.get(id)
    // made on a stream that is not the camera's any more (its NVR edited and made again), or ended:
    // closed (its viewers connect again) and made again on this one, as phone-live.mjs does
    if (s && !s.closed && (s.source !== source || ended(s.source))) s.close()
    if (!s || s.closed) {
      const at = this.failed.get(id)
      if (at !== undefined) {
        if (this.now() - at < FAILED_QUIET_MS) return FAILED
        this.failed.delete(id)
      }
      const slot = this.#slot(main)
      if (!slot && main) return BUSY
      if (!slot) {
        this.refused++
        const t = this.now()
        if (t - this.busySaidAt >= BUSY_SAY_MS) {
          this.busySaidAt = t
          this.log(`[steady] no room to steady ${camera ?? key}: ${this.pool.active} of ${this.pool.max} cameras steadied already; it plays as it is until a place frees (${this.refused} so far, said once in ${BUSY_SAY_MS / 1000} s). CCTV_STEADY_MAX raises it`)
        }
        this.#wait(key, ws)
        return BUSY
      }
      s = new PhoneStream({
        source, slot, camera, tag: 'steady',
        makeTranscoder: (o) => this.#make(id, { ...o, encThreads: main ? MAIN_ENCODER_THREADS : ENCODER_THREADS }),
        log: this.log, now: this.now, stopDelayMs: this.stopDelayMs,
        ...(main ? MAIN_STREAM : STREAM),
        onEmpty: () => {
          if (this.streams.get(id) === s) this.streams.delete(id)
        }
      })
      // (made and closed in one go when its conversion fails at its very first frame)
      if (s.closed) return FAILED
      this.streams.set(id, s)
    }
    s.add(ws)
    ws.on?.('close', () => s.remove(ws))
    tell(ws, { op: 'steady', on: true })
    return true
  }

  /** The converter: the stream's own settings, locked to the background, given up when it keeps falling behind. */
  #make(key, o) {
    const resets = []
    const x = this.makeTranscoder({
      ...o,
      preset: STEADY_PRESET,
      encThreads: o.encThreads ?? ENCODER_THREADS,
      onFail: (e) => {
        o.onFail?.(e)
        this.#failed(key, e?.message ?? String(e))
      }
    })
    const reset = x.reset?.bind(x)
    if (reset) {
      x.reset = () => {
        const t = this.now()
        resets.push(t)
        while (resets.length && t - resets[0] > STALL_WINDOW_MS) resets.shift()
        reset()
        if (resets.length >= STALL_RESETS) this.defer(() => this.#failed(key, `fell behind the camera ${resets.length} times in ${STALL_WINDOW_MS / 1000} s`))
      }
    }
    return x
  }

  /** Given up: its viewers are closed, and get the camera's own stream for FAILED_QUIET_MS. Said once. */
  #failed(key, why) {
    if (this.failed.has(key) && this.now() - this.failed.get(key) < FAILED_QUIET_MS) return
    this.failed.set(key, this.now())
    const s = this.streams.get(key)
    this.log(`[steady] ${s?.who?.replace(/^\[steady\] |:$/g, '') ?? key}: steadying failed (${why}); its viewers get the camera's own picture for ${FAILED_QUIET_MS / 1000} s`)
    s?.close()
  }

  /** A place, or null. One nobody watches any more gives its place up, the one left longest first. */
  #slot(main = false) {
    const pool = main ? this.mainPool : this.pool
    let slot = pool.acquire()
    if (!slot) {
      const idle = [...this.streams].filter(([id, s]) => id.endsWith(':main') === main && !s.closed && s.clients.size === 0).map(([, s]) => s).sort((a, b) => (a.emptyAt ?? -Infinity) - (b.emptyAt ?? -Infinity))
      for (const s of idle) {
        s.close()
        if ((slot = pool.acquire())) break
      }
    }
    if (!slot) return null
    return {
      release: () => {
        slot.release()
        this.defer(() => this.#wake())
      }
    }
  }

  #wait(key, ws) {
    if (!this.waiting.has(key)) this.waiting.set(key, new Set())
    this.waiting.get(key).add(ws)
    ws.on?.('close', () => this.waiting.get(key)?.delete(ws))
  }

  /**
   * A place has freed: the viewers of the camera that has waited longest are moved onto it (closed
   * with MOVE_CODE; they connect again and are steadied). One camera per free place.
   */
  #wake() {
    let room = this.pool.max - this.pool.active
    for (const [key, set] of [...this.waiting]) {
      if (room <= 0) break
      const open = [...set].filter(isOpen)
      this.waiting.delete(key)
      if (!open.length || !this.wants(key)) continue
      for (const ws of open) ws.close?.(MOVE_CODE, READY_REASON)
      room--
    }
  }

  /**
   * The setting of this camera has changed: its steadied stream ends, and every live viewer of it is
   * closed with MOVE_CODE, to connect again onto what it should have now.
   */
  restart(key) {
    this.failed.delete(key)
    this.waiting.delete(key)
    this.streams.get(key)?.close()
    this.streams.get(mainId(key))?.close()
    this.failed.delete(mainId(key))
    for (const ws of [...(this.viewers.get(key) ?? [])]) {
      if (isOpen(ws)) ws.close?.(MOVE_CODE, MOVE_REASON)
    }
  }

  /** For the minute history and /healthz: how many cameras are steadied now, of how many, and who watches. */
  summary() {
    let viewers = 0
    for (const s of this.streams.values()) viewers += s.clients.size
    return { running: this.pool.active, cap: this.pool.max, mainRunning: this.mainPool.active, mainCap: this.mainPool.max, viewers, refused: this.refused }
  }
}

/**
 * What a viewer of a steadied camera that is not steadied is told, before it is given the camera's own
 * stream: its tile says "Steady picture paused: the server is busy" (or could not be steadied).
 */
export const noteNotSteady = (ws, why) => tell(ws, { op: 'steady', on: false, why: why === FAILED ? FAILED : BUSY })

// ---- the route -------------------------------------------------------------------------------------

export const STEADY_PATH = '/api/admin/steady'

/**
 * GET  /api/admin/steady                 -> { cameras: [{ nvr, ch, by, at }], running, cap }
 * POST /api/admin/steady { nvr, ch, on } -> { nvr, ch, on, changed }
 * server.mjs has already checked admin, same origin and JSON. A change is audited ('settings-change')
 * and moves the camera's live viewers (SteadyLive.restart).
 * @param {string} method
 * @param {() => Promise<object>} readJson
 * @param {{ user: string, store: ReturnType<typeof steadyStore>, live: SteadyLive, knownCamera?: (nvr: string, ch: number) => boolean,
 *   audit?: (row: object) => void, log?: (line: string) => void }} deps
 * @returns {Promise<[number, object]>}
 */
export async function handleSteady(method, readJson, { user, store, live, knownCamera = () => true, audit = () => {}, log = (l) => console.log(l) }) {
  if (method === 'GET') {
    const sum = live?.summary?.() ?? {}
    return [200, { cameras: store.list(), running: sum.running ?? 0, cap: sum.cap ?? 0 }]
  }
  if (method !== 'POST') return [405, { error: 'Method not allowed' }]
  let body
  try {
    body = await readJson()
  } catch {
    return [400, { error: 'Bad request' }]
  }
  const { nvr, ch, on } = body ?? {}
  if (typeof nvr !== 'string' || !NVR_RE.test(nvr)) return [400, { error: 'nvr must be an NVR id' }]
  if (!Number.isInteger(ch) || ch < 0 || ch > 255) return [400, { error: 'ch must be a channel number from 0' }]
  if (typeof on !== 'boolean') return [400, { error: 'on must be true or false' }]
  if (!knownCamera(nvr, ch)) return [404, { error: 'No such camera on this NVR' }]
  let changed
  try {
    changed = store.set(nvr, ch, on, user)
  } catch (e) {
    log(`[steady] ${nvr}/${ch + 1}: the setting could not be saved: ${e?.message ?? e}`)
    return [500, { error: 'The setting could not be saved' }]
  }
  if (changed) {
    const key = steadyKey(nvr, ch)
    live?.restart?.(key)
    audit({ user, action: 'settings-change', target: key, detail: `steady picture ${on ? 'on' : 'off'} for camera ${ch + 1}` })
    log(`[steady] ${nvr}/${ch + 1}: steady picture ${on ? 'on' : 'off'} (by ${user || 'someone'})`)
  }
  return [200, { nvr, ch, on, changed }]
}
