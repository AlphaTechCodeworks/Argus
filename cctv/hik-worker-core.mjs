// One Hikvision device's live video, the logic of its child process (hik-worker.mjs is the process
// around it). It speaks the same messages as a TVT NVR's worker (worker-ipc.mjs: want / unwant /
// restart / stop in, ready / stats / frame out), so worker-supervisor.mjs and stream-hub.mjs serve its
// streams to every viewer path unchanged. The SDK is passed in, so the tests drive all of this with a
// fake one (test/hik-worker.test.mjs).
//
// What it does: logs in (with back-off), reads the camera list (login info + IP channels), starts a
// stream when the parent wants one and stops it when it does not, restarts a stream that stops
// delivering, logs in again when the device stops answering, and sends its state every 5 s.
// What it does not do (yet): recording, playback, settings, sound -- the parent's requests for those
// are answered "not supported", and recording settings are ignored.
import { channelsFrom, errorText, loginErrorText, makeFrameShaper, sdkVersionText } from './hik-core.mjs'
import { p2pSettings, p2pState } from './hik-config.mjs'
import { MSG, frameMsg, streamKey } from './worker-ipc.mjs'

export const UNSUPPORTED = 'Hikvision recorders do not support this in Argus yet'

const RETRY_MIN_MS = 5000
const RETRY_MAX_MS = 60_000
const STATS_MS = 5000
const CHANNEL_REFRESH_MS = 60_000
const STALL_MS = 15_000 // no video for this long on a playing stream: restart it
const MAX_LIST_FAILURES = 3 // camera-list reads in a row the device did not answer: log in again
const TAP_CAP = 8 * 1024 * 1024 // bytes handed to the parent and not yet taken: over this, skip to the next keyframe
const TAP_RESUME = 1024 * 1024

/**
 * @param {{
 *   cfg: object,                      the device's record (hik-config.mjs)
 *   sdk: object|null,                 hik-sdk.mjs's sdk, or null when it could not be opened
 *   sdkWhy?: string,                  why there is no sdk (NOT_INSTALLED ...)
 *   send: (msg: object, done?: () => void) => boolean,
 *   log?: { log: Function, warn: Function },
 *   logDir?: string, env?: object, now?: () => number,
 *   timers?: { setTimeout, clearTimeout, setInterval, clearInterval }
 * }} o
 */
export function makeHikWorker({ cfg, sdk, sdkWhy = '', send, log = console, logDir, env = process.env, now = Date.now, timers = globalThis }) {
  const id = cfg.id
  const where = `${cfg.host}:${cfg.port}`
  const state = {
    status: sdk ? 'connecting' : 'offline',
    error: sdk ? '' : sdkWhy,
    userId: -1,
    gen: 0,
    model: '',
    serial: '',
    name: '',
    sdkVersion: '',
    channels: [],
    p2p: { state: p2pState(cfg, env).state, error: '' },
    listFailures: 0
  }
  const streams = new Map() // key -> stream
  const codecSeen = new Map() // "ch:type" -> { codec, width, height, at }
  let stopped = false
  let connecting = false
  const ticks = []

  const every = (ms, fn) => {
    const t = timers.setInterval(() => {
      try {
        const r = fn()
        if (r?.catch) r.catch((e) => log.warn(`[${id}] ${e?.message ?? e}`))
      } catch (e) {
        log.warn(`[${id}] ${e?.message ?? e}`)
      }
    }, ms)
    t?.unref?.()
    ticks.push(t)
  }
  const sleep = (ms) => new Promise((r) => {
    const t = timers.setTimeout(r, ms)
    t?.unref?.()
  })

  // ---- the state the parent sees ----
  function stats() {
    return {
      t: MSG.STATS,
      brand: 'hikvision',
      status: state.status,
      error: state.error,
      gen: state.gen,
      model: state.model,
      serial: state.serial,
      deviceName: state.name,
      sdkVersion: state.sdkVersion,
      streams: streams.size,
      refusals: 0,
      channels: state.channels.map(({ ch, name, online, configured, ip, model, maker, httpPort }) => ({ ch, name, online, configured, ip, model, maker, httpPort })),
      codecSeen: Object.fromEntries(codecSeen),
      subCap: { limit: null, held: [], parked: [], full: false },
      mainPlaying: [...streams.values()].filter((s) => s.type === 0 && s.state === 'playing' && s.gotVideo).map((s) => s.ch),
      p2p: { ...state.p2p },
      sdk: { late: 0, ...(sdk?.stats?.() ?? {}) }
    }
  }
  let lastSent = ''
  const sendStats = () => {
    try {
      send(stats())
    } catch {}
  }
  const setStatus = (status, error = '') => {
    state.status = status
    state.error = error
    const sig = `${status}|${error}`
    if (sig !== lastSent) {
      lastSent = sig
      sendStats()
    }
  }

  // ---- login ----
  async function connect() {
    if (!sdk || connecting || stopped) return
    connecting = true
    try {
      for (let delay = RETRY_MIN_MS; !stopped; delay = Math.min(delay * 2, RETRY_MAX_MS)) {
        if (state.status !== 'offline') setStatus('connecting')
        // Hik-Connect sign-in first, when it is set up (UNVERIFIED: see hik-sdk.mjs p2pLogin2C). It does not
        // change how the device itself is reached: that is still its address (the header and the guide
        // say nothing of a device login through it), so a failure is reported and the login goes on.
        if (state.p2p.state === 'ready' && !state.p2p.signedIn) {
          const s = p2pSettings(cfg, env)
          const r = await sdk.p2pLogin2C(s).catch((e) => ({ ok: false, why: e.message }))
          state.p2p = r.ok ? { state: 'ready', signedIn: true, error: '' } : { state: 'ready', signedIn: false, error: `Hik-Connect sign-in failed: ${r.why ?? errorText(r.code)}` }
          if (!r.ok) log.warn(`[${id}] ${state.p2p.error}`)
        }
        const t0 = now()
        let r
        try {
          r = await sdk.login({ host: cfg.host, port: Number(cfg.port), user: cfg.user, password: cfg.password ?? '' })
        } catch (e) {
          r = { userId: -1, why: e.name === 'HikTimeout' ? 'the device did not answer in time' : e.message }
        }
        if (stopped) {
          if (r.userId >= 0) sdk.logout(r.userId)
          return
        }
        if (r.userId >= 0) {
          state.userId = r.userId
          state.gen++
          state.serial = r.info?.serial ?? ''
          const dc = await sdk.deviceCfg(r.userId).catch(() => ({ ok: false }))
          if (dc.ok) {
            state.model = dc.model || state.model
            state.name = dc.name || ''
            state.serial = state.serial || dc.serial || ''
          }
          state.info = r.info
          await readChannels(true)
          state.listFailures = 0
          setStatus('online')
          log.log(`[${id}] logged in to ${where} (${state.model || 'Hikvision device'}${state.serial ? `, serial ${state.serial}` : ''}) in ${now() - t0} ms, ${state.channels.filter((c) => c.configured).length} cameras`)
          sendStats()
          for (const s of streams.values()) if (s.wanted) startStream(s)
          return
        }
        const why = r.why ?? loginErrorText(r.code, r.info ?? {})
        setStatus('offline', why)
        log.log(`[${id}] login to ${where} failed: ${why}; retrying in ${Math.round(delay / 1000)} s`)
        await sleep(delay)
      }
    } finally {
      connecting = false
    }
  }

  async function relogin(why) {
    if (stopped || connecting) return
    log.warn(`[${id}] logging in again: ${why}`)
    const old = state.userId
    state.userId = -1
    for (const s of streams.values()) dropHandle(s, 'relogin')
    setStatus('connecting', why)
    if (old >= 0) await sdk.logout(old)
    connect()
  }

  /** Reads the camera list. Returns false if the device did not answer. */
  async function readChannels(first = false) {
    const userId = state.userId
    if (userId < 0 || !state.info) return false
    const info = state.info
    let ipcfg = null
    const hasIp = info.ipChannels > 0
    if (hasIp) {
      const r = await sdk.ipConfig(userId).catch((e) => ({ ok: false, why: e.message }))
      if (userId !== state.userId) return false
      if (!r.ok) {
        if (first) log.warn(`[${id}] IP channel list not read: ${r.why ?? errorText(r.code)}`)
        return false
      }
      ipcfg = r.buf
    }
    const list = channelsFrom(info, ipcfg)
    const sig = (l) => l.map((c) => `${c.ch}|${c.sdkChannel}|${c.online}|${c.configured}|${c.ip}`).join('\n')
    if (sig(list) !== sig(state.channels)) {
      state.channels = list
      sendStats()
    }
    return true
  }

  async function refreshList() {
    if (state.userId < 0 || stopped) return
    const ok = await readChannels()
    if (ok || state.info?.ipChannels === 0) {
      state.listFailures = 0
      return
    }
    if (++state.listFailures >= MAX_LIST_FAILURES) await relogin('the device stopped answering')
  }

  // ---- streams ----
  const channelOf = (ch) => state.channels.find((c) => c.ch === ch)

  function makeStream(ch, type, background) {
    return { key: streamKey(ch, type), ch, type, background, wanted: true, state: 'idle', handle: -1, run: null, lastFrameAt: 0, gotVideo: false, failures: 0, retryAt: 0, pending: 0, skipping: false, starting: false, error: '' }
  }

  function dropHandle(s, why) {
    const h = s.handle
    if (s.run) s.run.alive = false // packets still on their way from this run are dropped
    s.run = null
    s.handle = -1
    s.state = s.wanted ? 'restarting' : 'idle'
    s.gotVideo = false
    if (h >= 0) sdk.stopLive(h).catch(() => {})
    if (why && h >= 0) log.log(`[${id}] ${s.key}: stopped (${why})`)
  }

  async function startStream(s) {
    if (!sdk || stopped || s.starting || s.handle >= 0 || state.userId < 0 || state.status !== 'online') return
    const c = channelOf(s.ch)
    if (!c || !c.configured) {
      s.state = 'restarting'
      s.error = c ? 'no camera on this channel' : 'no such camera'
      s.retryAt = now() + RETRY_MAX_MS
      return
    }
    s.starting = true
    s.state = 'starting'
    const gen = state.gen
    const run = { alive: true }
    s.run = run
    const shaper = makeFrameShaper({ now })
    const onPacket = (p) => {
      if (!run.alive) return
      const out = shaper(p)
      if (!out.frame) return
      s.lastFrameAt = now()
      if (!s.gotVideo) {
        s.gotVideo = true
        s.state = 'playing'
        s.failures = 0
      }
      if (out.key) codecSeen.set(s.key, { codec: out.codec === 1 ? 'h265' : 'h264', width: out.width, height: out.height, at: now() })
      // a slow parent: nothing more until it has taken most of what it has, then from a keyframe
      if (s.skipping) {
        if (!out.key || s.pending > TAP_RESUME) return
        s.skipping = false
      } else if (s.pending > TAP_CAP) {
        s.skipping = true
        return
      }
      const n = out.frame.length
      s.pending += n
      // (process.send's false only means a backlog: the message is still queued, and its callback says when it went)
      send(frameMsg(s.key, out.frame, out.key), () => (s.pending -= n))
    }
    let r
    try {
      r = await sdk.startLive(state.userId, c.sdkChannel, s.type, onPacket)
    } catch (e) {
      r = { handle: -1, why: e.name === 'HikTimeout' ? 'the device did not start the stream in time' : e.message }
    } finally {
      s.starting = false
    }
    if (r.handle >= 0 && (!run.alive || !s.wanted || stopped || gen !== state.gen)) {
      run.alive = false
      sdk.stopLive(r.handle).catch(() => {})
      if (s.run === run) s.state = 'idle'
      return
    }
    if (!run.alive) return // dropped meanwhile (and it did not start)
    if (r.handle < 0) {
      run.alive = false
      s.run = null
      s.failures++
      s.state = 'restarting'
      s.error = r.why ?? `${r.step ? `${r.step}: ` : ''}${errorText(r.code)}`
      s.retryAt = now() + Math.min(RETRY_MIN_MS * 2 ** Math.min(s.failures - 1, 4), RETRY_MAX_MS)
      log.warn(`[${id}] camera ${s.ch + 1} ${s.type === 0 ? 'main' : 'sub'} stream did not start: ${s.error}`)
      return
    }
    s.handle = r.handle
    // the stall clock starts now (packets may already have arrived: they set gotVideo)
    if (!s.gotVideo) s.lastFrameAt = now() // the stall clock starts now
    if (!s.gotVideo) s.state = 'started'
    s.error = ''
  }

  /** Streams that stopped delivering are restarted; streams that failed are tried again when due. */
  async function checkStreams() {
    if (stopped || state.userId < 0 || state.status !== 'online') return
    const t = now()
    const live = [...streams.values()].filter((s) => s.wanted && s.handle >= 0)
    const stalled = live.filter((s) => t - s.lastFrameAt > STALL_MS)
    // every stream silent at once: the device, not the cameras -- is it still answering?
    if (stalled.length >= 2 && stalled.length === live.length) {
      const ok = await readChannels()
      if (!ok) {
        await relogin('no video from any camera and the device does not answer')
        return
      }
    }
    for (const s of stalled) {
      log.warn(`[${id}] camera ${s.ch + 1} ${s.type === 0 ? 'main' : 'sub'} stream: no video for ${Math.round((t - s.lastFrameAt) / 1000)} s, restarting it`)
      dropHandle(s)
      s.retryAt = t
    }
    for (const s of streams.values()) if (s.wanted && s.handle < 0 && !s.starting && t >= s.retryAt) startStream(s)
  }

  // ---- messages from the parent ----
  function onMessage(m) {
    if (stopped || !m) return
    if (m.t === MSG.WANT) {
      const key = streamKey(m.ch, m.type)
      let s = streams.get(key)
      if (s) {
        s.background = m.background === true
        s.wanted = true
      } else streams.set(key, (s = makeStream(m.ch, m.type, m.background === true)))
      startStream(s)
    } else if (m.t === MSG.UNWANT) {
      const s = streams.get(streamKey(m.ch, m.type))
      if (!s) return
      s.wanted = false
      streams.delete(s.key)
      dropHandle(s)
    } else if (m.t === MSG.RESTART) {
      const s = streams.get(streamKey(m.ch, m.type))
      if (!s) return
      dropHandle(s, String(m.why || 'restart asked'))
      s.retryAt = 0
      startStream(s)
    } else if (m.t === MSG.REQ) {
      try {
        send({ t: MSG.RES, id: m.id, ok: false, error: { message: UNSUPPORTED, name: 'Error', status: 501, extra: null } })
      } catch {}
    } else if (m.t === MSG.STOP) {
      stop()
    }
    // SETTINGS / EVENTS (recording), LINKRESET and AUDIOWANT (TVT only) are ignored
  }

  async function start() {
    send({ t: MSG.READY })
    if (!sdk) {
      log.warn(`[${id}] ${state.error}`)
      sendStats()
      every(STATS_MS, sendStats)
      return
    }
    every(STATS_MS, sendStats)
    let init
    try {
      init = await sdk.init({ logDir })
    } catch (e) {
      init = { ok: false, why: e.message }
    }
    if (!init.ok) {
      setStatus('offline', `Hikvision support could not start: ${init.why}`)
      log.warn(`[${id}] ${state.error}`)
      return
    }
    for (const n of init.notes ?? []) log.warn(`[${id}] Hikvision SDK: ${n}`)
    state.sdkVersion = sdkVersionText(await sdk.version().catch(() => 0))
    log.log(`[${id}] Hikvision SDK ${state.sdkVersion} loaded`)
    every(CHANNEL_REFRESH_MS, refreshList)
    every(1000, checkStreams)
    connect()
  }

  /** Stops everything at once: nothing new goes into the SDK; the process is killed right after. */
  function stop() {
    if (stopped) return
    stopped = true
    for (const t of ticks) timers.clearInterval(t)
  }

  return { start, onMessage, stop, stats, _state: state, _streams: streams, _checkStreams: checkStreams, _refreshList: refreshList }
}
