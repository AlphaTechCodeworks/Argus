// The RTSP server (MediaMTX) as a child of Argus: found, started with the config rtsp.mjs writes,
// restarted with a growing wait when it ends by itself, its lines in the journal with "[rtsp]" in
// front, stopped when Argus stops or the feature is switched off.
//
// The binary is not part of the app (deploy/install-mediamtx.sh puts a pinned, checksummed copy at
// /opt/cctv/mediamtx/mediamtx). Not there: the feature says "not installed" and nothing else changes.
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The version deploy/install-mediamtx.sh installs (kept in step with it). */
export const MEDIAMTX_VERSION = 'v1.21.1'
/** Waits before each restart after it ended by itself: 1 s, doubling, at most a minute. */
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000]
/** Up this long and a later end starts the waits from the first again. */
export const STABLE_MS = 60_000

/**
 * Where the binary is: CCTV_MEDIAMTX, the installed copy, one under the release (bin/linux) or under
 * DATA_DIR/bin. The first that exists, or null.
 */
export function findBinary({ env = process.env, appDir, dataDir, exists = existsSync, platform = process.platform } = {}) {
  const exe = platform === 'win32' ? 'mediamtx.exe' : 'mediamtx'
  const candidates = [env.CCTV_MEDIAMTX, platform === 'win32' ? null : '/opt/cctv/mediamtx/mediamtx', appDir && join(appDir, 'bin', platform === 'win32' ? 'windows' : 'linux', exe), dataDir && join(dataDir, 'bin', exe)].filter(Boolean)
  return candidates.find((p) => exists(p)) ?? null
}

/** The wait before restart number n (from 0). */
export const backoffFor = (n) => BACKOFF_MS[Math.min(Math.max(0, n), BACKOFF_MS.length - 1)]

/**
 * @param {{ binary: () => string|null, configFile: string, cwd: string, prepare?: () => void,
 *   spawn?: Function, log?: (line: string) => void, now?: () => number, setTimer?: Function, clearTimer?: Function }} o
 *   prepare: writes the config before each start (a new per-boot secret is not needed: one per Argus process)
 */
export function makeRtspServer({ binary, configFile, cwd, prepare = () => {}, spawn = nodeSpawn, log = (l) => console.log(l), now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let child = null
  let wanted = false
  let timer = null
  let failures = 0
  let startedAt = null
  let lastError = null
  let restarts = 0
  let lastLine = ''

  const lines = (prefix) => {
    let rest = ''
    return (chunk) => {
      rest += chunk.toString('utf8')
      const parts = rest.split(/\r?\n/)
      rest = parts.pop() ?? ''
      if (rest.length > 4096) { parts.push(rest); rest = '' }
      for (const l of parts) {
        if (!l.trim()) continue
        lastLine = l.slice(0, 300)
        if (/\bERR\b|error/i.test(l)) lastError = lastLine
        log(`[rtsp] ${prefix}${l}`)
      }
    }
  }

  function start() {
    timer = null
    if (!wanted || child) return
    const bin = binary()
    if (!bin) {
      lastError = 'not installed'
      return
    }
    try {
      prepare()
    } catch (e) {
      lastError = `config not written: ${e?.message ?? e}`
      log(`[rtsp] ${lastError}`)
      return schedule()
    }
    let c
    try {
      // a clean environment: MediaMTX reads MTX_* variables as settings, and needs nothing of ours
      c = spawn(bin, [configFile], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } })
    } catch (e) {
      lastError = `could not start: ${e?.message ?? e}`
      log(`[rtsp] ${lastError}`)
      return schedule()
    }
    child = c
    startedAt = now()
    log(`[rtsp] started ${bin} (pid ${c.pid ?? '?'})`)
    c.stdout?.on('data', lines(''))
    c.stderr?.on('data', lines(''))
    c.on('error', (e) => {
      lastError = `could not start: ${e?.message ?? e}`
      log(`[rtsp] ${lastError}`)
    })
    c.on('exit', (code, signal) => {
      if (child !== c) return
      child = null
      const upMs = now() - startedAt
      startedAt = null
      if (!wanted) return log(`[rtsp] stopped`)
      if (upMs >= STABLE_MS) failures = 0
      lastError = `ended by itself (${signal ?? `exit ${code}`})${lastLine ? `: ${lastLine}` : ''}`
      log(`[rtsp] ${lastError}; starting again in ${backoffFor(failures) / 1000} s`)
      schedule()
    })
  }

  function schedule() {
    if (!wanted || timer) return
    const wait = backoffFor(failures++)
    restarts++
    timer = setTimer(start, wait)
    timer?.unref?.()
  }

  function stop() {
    wanted = false
    if (timer) clearTimer(timer)
    timer = null
    const c = child
    child = null
    startedAt = null
    if (c) {
      try {
        c.kill('SIGTERM')
      } catch {}
      log('[rtsp] stopping')
    }
  }

  return {
    /** Runs it (again) if it is not running. */
    start() {
      wanted = true
      failures = 0
      lastError = null
      if (!child && !timer) start()
    },
    stop,
    /** Stopped and started again at once (a key revoked: its readers are cut off; the others reconnect). */
    restart() {
      const had = Boolean(child)
      stop()
      wanted = true
      failures = 0
      // (the one stopped lets go of its ports first)
      if (had) {
        timer = setTimer(start, 1500)
        timer?.unref?.()
      } else start()
    },
    status: () => ({ installed: Boolean(binary()), running: Boolean(child), pid: child?.pid ?? null, upSinceMs: startedAt, wanted, lastError, restarts })
  }
}
