// Repro attempt: the recording-date search (FindRecDate) during a burst of live starts.
//   docker exec tvt-cctv-dev node cctv/test/dates-burst.mjs [nvrId] [tiles] [delayMs]
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'

const NVR = process.argv[2] || 'nvr1'
const TILES = Number(process.argv[3] || 23)
const DELAY = Number(process.argv[4] || 500)
const HTTP = 'http://127.0.0.1:8080'
const json = async (path, ms = 90_000) => (await fetch(HTTP + path, { signal: AbortSignal.timeout(ms) })).json()

const cams = (await json('/api/cameras')).filter((c) => c.nvr === NVR && c.online).slice(0, TILES)
const socks = cams.map((c) => new WebSocket(`ws://127.0.0.1:8080/live?nvr=${NVR}&ch=${c.ch}&stream=1`))
await sleep(DELAY)
const t0 = Date.now()
const poll = setInterval(async () => {
  try {
    console.log(`  +${Date.now() - t0} ms`, JSON.stringify((await json('/healthz', 3000)).sdk))
  } catch (e) {
    console.log(`  +${Date.now() - t0} ms health failed: ${e.message}`)
  }
}, 5000)
try {
  const r = await json(`/api/playback/dates?nvr=${NVR}`)
  console.log(`dates during ${cams.length}-stream start: ${Date.now() - t0} ms, ${r.length} dates`)
} catch (e) {
  console.log(`dates FAILED after ${Date.now() - t0} ms: ${e.message}`)
}
clearInterval(poll)
for (const ws of socks) ws.close()
