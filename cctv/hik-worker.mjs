// One Hikvision device's live video in its own process: the Hikvision SDK is loaded here and nowhere
// else, so a crash inside it ends this process only; worker-supervisor.mjs starts a new one (the
// viewers stay connected and wait for a keyframe, as with a TVT NVR's worker). Started by
// hik-nvr.mjs (worker-supervisor.mjs startWorker with this script) with CCTV_WORKER_NVR=<device id>
// and the SDK's library path (hik-config.mjs hikChildEnv). The work itself is hik-worker-core.mjs.
//
// Tests: CCTV_HIK_FAKE_SDK=<module path> loads a fake SDK from that module (its default export) instead.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hikSdkDir } from './hik-config.mjs'
import { makeHikWorker } from './hik-worker-core.mjs'

const id = process.env.CCTV_WORKER_NVR
// (auth.mjs's rule for the data folder; nvrs.json is read here directly: nvrs.mjs would load the TVT SDK
// into this process too)
const DATA_DIR = process.env.DATA_DIR ?? join(import.meta.dirname, '..', 'data')
const readDevice = () => {
  try {
    const list = JSON.parse(readFileSync(join(DATA_DIR, 'nvrs.json'), 'utf8')).nvrs
    return Array.isArray(list) ? list.find((n) => n?.id === id) : null
  } catch {
    return null
  }
}
const cfg = readDevice()
if (!cfg) {
  console.error(`[worker ${id}] no device ${id} in the config`)
  process.exit(2)
}

let sdk = null
let sdkWhy = ''
if (process.env.CCTV_HIK_FAKE_SDK) {
  sdk = (await import(pathToFileURL(process.env.CCTV_HIK_FAKE_SDK).href)).default
} else {
  const { openHikSdk } = await import('./hik-sdk.mjs')
  const opened = await openHikSdk({ dir: hikSdkDir() })
  if (opened.ok) sdk = opened.sdk
  else sdkWhy = opened.why
}

const send = (m, done) => {
  if (!process.connected) return false
  try {
    return process.send(m, done ? () => done() : undefined)
  } catch {
    return false
  }
}
const worker = makeHikWorker({ cfg, sdk, sdkWhy, send, logDir: join(DATA_DIR, 'hiksdk-log', String(id).replace(/[^A-Za-z0-9_-]/g, '_')) })

// A call that never comes back from the SDK leaves this process useless: after this long, it exits and
// the supervisor starts a fresh one (the TVT workers have watchdog.mjs for the same).
const STUCK_MS = 120_000
setInterval(() => {
  const s = sdk?.stats?.()
  if (s && s.inFlight > 0 && s.oldestMs > STUCK_MS) {
    console.error(`[worker ${id}] a Hikvision SDK call has not returned for ${Math.round(s.oldestMs / 1000)} s (${s.calls.join(', ')}): restarting this worker`)
    process.kill(process.pid, 'SIGKILL')
  }
}, 10_000).unref()

let stopping = false
const shutdown = () => {
  if (stopping) return
  stopping = true
  worker.stop()
  // as a TVT worker: no logout, no stops; the kernel closes the device's sockets at the kill
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 200)
}
process.on('message', (m) => {
  if (m?.t === 'stop') return shutdown()
  worker.onMessage(m)
})
process.on('disconnect', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
worker.start().catch((e) => console.error(`[worker ${id}] ${e?.stack ?? e}`))
