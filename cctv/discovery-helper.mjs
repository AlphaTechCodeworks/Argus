// Discovery helper: runs the TVT network search (UDP 23456, see mhed.mjs) on the PC
// itself, for when the app runs inside Docker Desktop, where multicast never reaches
// the network. The app asks it at http://host.docker.internal:23457/search.
//
// Start it on the PC that runs Docker (needs Node.js 20 or later, nothing else):
//   node cctv/discovery-helper.mjs
// It listens on this PC's loopback address only (Docker Desktop forwards the app's
// requests there), answers nothing but /search, and changes nothing on the network:
// each search is one 140-byte request, the same one TVT's own tools send.
import http from 'node:http'
import { mhedSearch } from './mhed.mjs'

const PORT = Number(process.env.DISCOVERY_HELPER_PORT ?? 23457)
const BIND = '127.0.0.1'
// requests must be addressed to us by one of these names (blocks DNS-rebinding tricks
// from web pages open in a browser on this PC)
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `host.docker.internal:${PORT}`])
const MIN_INTERVAL_MS = 2000

let running = null
let lastAt = 0
let last = null

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  // checked as plain strings: parsing an odd request line must not be able to crash the helper
  if (!HOSTS.has(String(req.headers.host ?? '').toLowerCase())) return send(403, { error: 'forbidden' })
  if (req.method !== 'GET' || String(req.url).split('?')[0] !== '/search') return send(404, { error: 'not found' })
  try {
    // one search at a time; repeated requests within 2 s share the last result
    if (!running && Date.now() - lastAt > MIN_INTERVAL_MS) {
      running = mhedSearch({ waitMs: 2500 }).finally(() => {
        running = null
        lastAt = Date.now()
      })
      last = running
    }
    const { devices, interfaces } = await last
    // no console output per search: a click in a Windows console window (QuickEdit) pauses
    // every write to it, which would freeze the helper until the selection ends
    send(200, { devices, interfaces })
  } catch (e) {
    send(500, { error: e.message })
  }
})
// failures are reported to the app (and shown on the Sites page), so nothing needs the console
server.on('clientError', (_e, socket) => socket.destroy())

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use: is the helper already running?` : e.message)
  process.exit(1)
})
server.listen(PORT, BIND, () => {
  console.log(`CCTV discovery helper listening on ${BIND}:${PORT}. Leave this window open; press Ctrl+C to stop.`)
})
