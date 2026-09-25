// Does a recording search stall while live streams run on the same login?
//   docker exec tvt-cctv-dev node cctv/test/search-under-load.mjs [nvrId] [liveTiles]
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'

const NVR = process.argv[2] || 'nvr1'
const TILES = Number(process.argv[3] || 12)
const HTTP = 'http://127.0.0.1:8080'
const json = async (path) => (await fetch(HTTP + path, { signal: AbortSignal.timeout(90_000) })).json()
const timed = async (label, path) => {
  const t0 = Date.now()
  try {
    const r = await json(path)
    console.log(`${label}: ${Date.now() - t0} ms ${JSON.stringify(r).slice(0, 80)}`)
  } catch (e) {
    console.log(`${label}: FAILED after ${Date.now() - t0} ms (${e.message})`)
  }
}
const health = async () => console.log('health', JSON.stringify((await json('/healthz')).sdk))

const cams = (await json('/api/cameras')).filter((c) => c.nvr === NVR && c.online).slice(0, TILES)
const { now, tzOffsetMs } = await json(`/api/playback/now?nvr=${NVR}`)
const today = new Date(now + tzOffsetMs).toISOString().slice(0, 10)

await timed('search, no live', `/api/playback/recordings?nvr=${NVR}&ch=${cams[0].ch}&date=${today}`)

const socks = cams.map((c) => {
  const ws = new WebSocket(`ws://127.0.0.1:8080/live?nvr=${NVR}&ch=${c.ch}&stream=1`)
  ws.frames = 0
  ws.on('message', (_d, bin) => bin && ws.frames++)
  return ws
})
// search while the streams are still starting (the burst), then once they are steady
await sleep(500)
await timed(`search during ${cams.length}-stream start`, `/api/playback/recordings?nvr=${NVR}&ch=${cams[1].ch}&date=${today}`)
await health()
await sleep(10_000)
console.log('fps', socks.map((w) => Math.round(w.frames / 10.5)).join(','))
await timed(`search with ${cams.length} steady streams`, `/api/playback/recordings?nvr=${NVR}&ch=${cams[2].ch}&date=${today}`)
await health()
for (const ws of socks) ws.close()
