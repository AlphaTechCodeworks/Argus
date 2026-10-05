// Starts and watches one live worker (nvr-worker.mjs) per NVR, CCTV_LIVE_WORKER=on. The hub
// (stream-hub.mjs) keeps viewers connected across worker restarts: they wait for a keyframe.
import { fork } from 'node:child_process'
import { StreamHub } from './stream-hub.mjs'
import { MSG, want } from './worker-ipc.mjs'

const BACKOFF_MS = [2000, 5000, 15_000, 60_000]
const HEALTHY_MS = 5 * 60_000 // ready this long: the back-off starts again from the first step
// the worker's own shutdown takes up to about 5 s (close segments 4 s, hand over its last messages
// 1 s; no stops, no logout since the aborts in those): it was killed at 5 once, when it logged out
const STOP_WAIT_MS = 6000
const KILL_WAIT_MS = 10_000 // after SIGKILL: the exit event normally follows at once
// The TVT SDK prints this line for each link it loses when the NVR drops its connections ("Net
// Disconnected...... m_deviceID = 29", 02:25:03 and 03:13-03:14 on 09-27), and then reconnects them
// by itself. The worker is told (MSG.LINKRESET): viewers' new streams on that NVR wait a while
// (live-pacer.mjs) rather than add LivePlays while the SDK is reconnecting the recording's.
const LINK_RESET_RE = /Net Disconnected/
const LINK_RESET_EVERY_MS = 1000 // one reset prints a line per link: at most one message a second
// The SDK prints this line, then a blank line, over and over (" %s, %s,%d  m_bLoginSuccess == false ":
// file, function, line). The pair was about half of the journal on a normal day and says nothing a
// person acts on, so it is not written there; onLine still gets it, like every line, because that
// is where the SDK's output is watched.
const LOGIN_STATE_NOISE_RE = /ProcChannelState.*m_bLoginSuccess == false/

/**
 * Copies a child's output to `out`, each line prefixed, except the SDK's login-state noise (above)
 * and the blank line after it; onLine (optional) is shown every line, those included.
 */
export function prefixLines(from, out, prefix, onLine = null) {
  if (!from) return
  let rest = ''
  let afterNoise = false // the last line was the SDK's noise: a blank line now is its second half
  const keep = (l) => {
    const noise = LOGIN_STATE_NOISE_RE.test(l)
    const drop = noise || (afterNoise && l.trim() === '')
    afterNoise = noise
    return !drop
  }
  from.setEncoding('utf8')
  from.on('data', (d) => {
    const lines = (rest + d).split('\n')
    rest = lines.pop()
    const kept = lines.filter(keep)
    if (kept.length) out.write(kept.map((l) => `${prefix}${l}\n`).join(''))
    if (onLine) for (const l of lines) onLine(l)
  })
  from.on('end', () => {
    if (rest && keep(rest)) out.write(`${prefix}${rest}\n`)
    if (rest && onLine) onLine(rest)
    rest = ''
  })
}

/**
 * Watches a worker's output for the SDK's lines about links the NVR dropped: send(at) at the first
 * one, then at most once every LINK_RESET_EVERY_MS while they go on.
 * @param {(at: number) => void} send
 * @returns {(line: string) => void}
 */
export function linkResetWatch(send, now = Date.now) {
  let last = -Infinity
  return (line) => {
    if (!LINK_RESET_RE.test(line)) return
    const t = now()
    if (t - last < LINK_RESET_EVERY_MS) return
    last = t
    send(t)
  }
}

/**
 * @param {string} nvrId
 * @param {{ env?: object, stdio?: any, onStats?: (stats: object) => void, onRecording?: (m: object) => void,
 *           onReady?: (r: { again: boolean, spawnedAt: number }) => void }} [opts]
 *   stdio: for tests; onRecording: the worker's segopen / segment / recgap messages (recorder.mjs);
 *   onReady: each worker process that has started (the first and every restart)
 */
export function startWorker(nvrId, { env = {}, stdio, onStats, onRecording, onReady } = {}) {
  let recSettings = null // the last settings message: sent again to every new worker
  let child = null
  let state = 'starting' // starting | ready | restarting
  let stats = null
  let tries = 0
  let readyAt = 0
  let stopping = false
  let timer = null
  let stopped = null // the stop() promise
  const hub = new StreamHub(nvrId, (m) => {
    if (child?.connected) child.send(m)
  })

  const spawn = () => {
    const childEnv = { ...process.env, ...env, CCTV_WORKER_NVR: nvrId }
    delete childEnv.CCTV_LIVE_WORKER // the worker itself plays the streams
    // by default the worker's output goes to ours line by line, prefixed "[worker <id>] "
    const c = fork(new URL('./nvr-worker.mjs', import.meta.url), [], { serialization: 'advanced', env: childEnv, stdio: stdio ?? ['ignore', 'pipe', 'pipe', 'ipc'] })
    c.spawnedAt = Date.now()
    child = c
    if (!stdio) {
      // (the SDK prints from inside the worker: only its output shows that the NVR dropped the links)
      const onLine = linkResetWatch((at) => {
        try {
          if (c === child && c.connected) c.send({ t: MSG.LINKRESET, at })
        } catch {} // (the worker is going: nothing to hold)
      })
      prefixLines(c.stdout, process.stdout, `[worker ${nvrId}] `, onLine)
      prefixLines(c.stderr, process.stderr, `[worker ${nvrId}] `, onLine)
    }
    c.on('error', (e) => console.warn(`[worker ${nvrId}] ${e.message}`))
    c.on('message', (m) => {
      if (c !== child) return
      if (m?.t === MSG.FRAME) return hub.onMessage(m)
      if (m?.t === MSG.SEGOPEN || m?.t === MSG.SEGMENT || m?.t === MSG.RECGAP) {
        try {
          onRecording?.(m)
        } catch (e) {
          console.warn(`[worker ${nvrId}] recording message: ${e.message}`)
        }
        return
      }
      if (m?.t === MSG.READY) {
        const again = state === 'restarting'
        state = 'ready'
        readyAt = Date.now()
        if (recSettings) c.send(recSettings)
        try {
          onReady?.({ again, spawnedAt: c.spawnedAt })
        } catch (e) {
          console.warn(`[worker ${nvrId}] onReady: ${e.message}`)
        }
        if (again) {
          console.log(`[worker ${nvrId}] ready again`)
          hub.onWorkerRestart()
        } else for (const s of hub.streams.values()) if (s.wanted) c.send(want(s.ch, s.type, !s.fg))
      } else if (m?.t === MSG.STATS) {
        stats = m
        onStats?.(m)
      }
    })
    c.on('exit', (code, signal) => {
      if (stopping || c !== child) return
      if (readyAt && Date.now() - readyAt > HEALTHY_MS) tries = 0
      readyAt = 0
      const delay = BACKOFF_MS[Math.min(tries++, BACKOFF_MS.length - 1)]
      console.warn(`[worker ${nvrId}] exited (${signal ? `signal ${signal}` : `code ${code}`}), restarting in ${delay / 1000} s`)
      state = 'restarting'
      stats = null
      for (const s of hub.streams.values()) s.reset()
      timer = setTimeout(spawn, delay)
    })
  }
  spawn()

  return {
    hub,
    state: () => state,
    stats: () => stats,
    _child: () => child, // tests
    /** Recording settings for the worker (recorder.mjs); kept and sent again after a restart. */
    setRecording(msg) {
      recSettings = { ...msg, t: MSG.SETTINGS }
      if (state === 'ready' && child?.connected) child.send(recSettings)
    },
    /**
     * Event windows for the worker (rec-modes.mjs): which stretches each event-mode camera should
     * be recording. Deliberately NOT kept and resent the way the settings are — windows go stale
     * within minutes, and a worker that has just restarted must fall back to recording
     * continuously until a fresh set arrives rather than act on an old one.
     */
    setEventWindows(msg) {
      if (state === 'ready' && child?.connected) child.send({ ...msg, t: MSG.EVENTS })
    },
    /** Stops the worker; resolves once it has exited (SIGKILL if it overstays). Same promise on every call. */
    stop() {
      stopped ??= stopNow()
      return stopped
    }
  }

  async function stopNow() {
    stopping = true
    clearTimeout(timer)
    const c = child
    if (!c || c.exitCode !== null || c.signalCode !== null) return
    const gone = new Promise((r) => c.once('exit', r))
    if (c.connected) c.send({ t: MSG.STOP })
    await Promise.race([gone, new Promise((r) => setTimeout(r, STOP_WAIT_MS))])
    if (c.exitCode === null && c.signalCode === null) {
      console.warn(`[worker ${nvrId}] did not stop in ${STOP_WAIT_MS / 1000} s; killing it`)
      c.kill('SIGKILL')
      await Promise.race([gone, new Promise((r) => setTimeout(r, KILL_WAIT_MS))])
    }
  }
}
