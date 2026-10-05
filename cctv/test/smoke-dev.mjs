// Light smoke test against a running dev instance (CCTV_AUTH=off), from inside its container:
//   docker exec tvt-cctv-dev node cctv/test/smoke-dev.mjs [nvrId]
// Opens a few live tiles, a playback paused before it starts, and motion searches that are
// cancelled while waiting for a playback login (a leaked login would make the last one fail).
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'

const NVR = process.argv[2] || 'nvr1'
const BASE = 'ws://127.0.0.1:8080'
const HTTP = 'http://127.0.0.1:8080'
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const json = async (path) => (await fetch(HTTP + path)).json()
const open = (path) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE + path)
    ws.binaryType = 'nodebuffer'
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
// frame header: flags (bit 0 = keyframe) at byte 0
const isKey = (buf) => (buf[0] & 1) === 1

const cams = (await json('/api/cameras')).filter((c) => c.nvr === NVR && c.online)
check('cameras listed', cams.length > 0, `${cams.length} online`)

// ---- live: 6 sub-stream tiles for 12 s ----
{
  const tiles = cams.slice(0, 6)
  const stats = tiles.map(() => ({ frames: 0, keys: 0 }))
  const socks = await Promise.all(tiles.map((c) => open(`/live?nvr=${NVR}&ch=${c.ch}&stream=1`)))
  socks.forEach((ws, i) =>
    ws.on('message', (d, bin) => {
      if (!bin) return
      stats[i].frames++
      if (isKey(d)) stats[i].keys++
    })
  )
  await sleep(12_000)
  for (const ws of socks) ws.close()
  const fps = stats.map((s) => (s.frames / 12).toFixed(0))
  check('live: every tile gets video', stats.every((s) => s.frames > 50 && s.keys > 0), `fps ${fps.join(',')}`)
  check('live: first frame of each tile is a keyframe path (keys seen)', stats.every((s) => s.keys >= 1))
}

// ---- playback paused before it starts ----
{
  const { now } = await json(`/api/playback/now?nvr=${NVR}`)
  const cam = cams[1] ?? cams[0]
  const ws = await open(`/playback?nvr=${NVR}&ch=${cam.ch}&stream=1&start=${now - 10 * 60_000}`)
  let frames = 0
  const msgs = []
  ws.on('message', (d, bin) => (bin ? frames++ : msgs.push(JSON.parse(String(d)))))
  ws.send(JSON.stringify({ pause: true })) // arrives while the playback is still opening
  const t0 = Date.now()
  while (!msgs.some((m) => m.type === 'started' || m.type === 'error') && Date.now() - t0 < 30_000) await sleep(200)
  check('playback: started', msgs.some((m) => m.type === 'started'), JSON.stringify(msgs))
  await sleep(6000)
  const whilePaused = frames
  check('playback: pause sent before start is honoured', whilePaused < 60, `${whilePaused} frames while paused`)
  ws.send(JSON.stringify({ pause: false }))
  await sleep(6000)
  check('playback: resumes', frames - whilePaused > 60, `${frames - whilePaused} frames after resume`)
  ws.close()
}

// ---- motion searches cancelled while waiting for a login, then one to completion ----
{
  const { now } = await json(`/api/playback/now?nvr=${NVR}`)
  const cam = cams[2] ?? cams[0]
  const q = (from, to) => `/motion?nvr=${NVR}&ch=${cam.ch}&from=${from}&to=${to}&box=0.25,0.25,0.5,0.5&sens=2`
  for (let i = 0; i < 3; i++) {
    const ws = await open(q(now - 3 * 3_600_000, now - 2 * 3_600_000))
    await sleep(800 + i * 400) // inside the recording search or the playback login
    ws.close()
    await sleep(300)
  }
  await sleep(3000)
  const ws = await open(q(now - 40 * 60_000, now - 30 * 60_000))
  const msgs = []
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))))
  const t0 = Date.now()
  await new Promise((resolve) => ws.on('close', resolve))
  const last = msgs.at(-1)
  check('motion: search after cancelled ones completes (no leaked logins)', last?.type === 'done', `${JSON.stringify(last)} in ${Math.round((Date.now() - t0) / 1000)} s`)
}

const health = await json('/healthz')
check('health: no late SDK calls', health.ok && health.sdk?.late === 0, JSON.stringify(health.sdk))
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
