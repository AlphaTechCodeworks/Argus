// Repro attempt: a new login (playback) while the first recording-date search is running.
//   docker exec tvt-cctv-dev node cctv/test/dates-login.mjs [nvrId] [delayMs]
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'

const NVR = process.argv[2] || 'nvr1'
const DELAY = Number(process.argv[3] || 1500)
const HTTP = 'http://127.0.0.1:8080'
const json = async (path, ms = 90_000) => (await fetch(HTTP + path, { signal: AbortSignal.timeout(ms) })).json()

let cam
for (let i = 0; i < 30 && !cam; i++, await sleep(1000)) cam = (await json('/api/cameras')).filter((c) => c.nvr === NVR && c.online)[1]
const { now } = await json(`/api/playback/now?nvr=${NVR}`)
const t0 = Date.now()
const poll = setInterval(async () => {
  try {
    console.log(`  +${Date.now() - t0} ms`, JSON.stringify((await json('/healthz', 3000)).sdk))
  } catch (e) {
    console.log(`  +${Date.now() - t0} ms health failed: ${e.message}`)
  }
}, 5000)
const dates = json(`/api/playback/dates?nvr=${NVR}`).then(
  (r) => console.log(`dates: ${Date.now() - t0} ms, ${r.length} dates`),
  (e) => console.log(`dates FAILED after ${Date.now() - t0} ms: ${e.message}`)
)
await sleep(DELAY)
const ws = new WebSocket(`ws://127.0.0.1:8080/playback?nvr=${NVR}&ch=${cam.ch}&stream=1&start=${now - 10 * 60_000}`)
const started = new Promise((resolve) => {
  ws.on('message', (d, bin) => {
    if (bin) return
    const m = JSON.parse(String(d))
    console.log(`playback ${m.type}${m.message ? `: ${m.message}` : ''} at +${Date.now() - t0} ms`)
    if (m.type === 'started' || m.type === 'error') resolve()
  })
  ws.on('close', resolve)
})
await Promise.all([dates, Promise.race([started, sleep(80_000)])])
clearInterval(poll)
ws.close()
