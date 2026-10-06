const MAX_TILE = 512 * 1024
const MAX_CACHE = 16 * 1024 * 1024
const TTL = 24 * 60 * 60 * 1000
const SERVICES = { street: 'World_Street_Map', satellite: 'World_Imagery' }

export function tileTarget(path) {
  const match = /^\/api\/map-tiles\/(street|satellite)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/.exec(path)
  if (!match) return null
  const [, layer, zs, xs, ys] = match
  const [z, x, y] = [zs, xs, ys].map(Number)
  if (z > 19 || x >= 2 ** z || y >= 2 ** z) return null
  return `https://server.arcgisonline.com/ArcGIS/rest/services/${SERVICES[layer]}/MapServer/tile/${z}/${y}/${x}`
}

export function createTileLoader({ fetchTile = fetch, now = Date.now } = {}) {
  const cache = new Map()
  const pending = new Map()
  const waiting = []
  let cacheBytes = 0
  let active = 0
  async function load(path) {
    const target = tileTarget(path)
    if (!target) throw new Error('Invalid map tile')
    const hit = cache.get(path)
    if (hit && hit.expires > now()) {
      cache.delete(path)
      cache.set(path, hit)
      return hit
    }
    if (hit) { cache.delete(path); cacheBytes -= hit.body.length }
    if (pending.has(path)) return pending.get(path)
    if (pending.size >= 64) throw new Error('Map imagery busy')
    const task = (async () => {
      if (active >= 8) await new Promise((resolve) => waiting.push(resolve))
      else active++
      try {
        const response = await fetchTile(target, { signal: AbortSignal.timeout(10_000), redirect: 'error', headers: { 'User-Agent': 'Argus-CCTV-Map/1.0' } })
        if (!response.ok || !/^image\/(jpeg|png)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Map imagery unavailable')
        if (Number(response.headers.get('content-length')) > MAX_TILE) { await response.body?.cancel(); throw new Error('Map tile too large') }
        const chunks = []
        let size = 0
        const reader = response.body.getReader()
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            size += value.length
            if (size > MAX_TILE) { await reader.cancel(); throw new Error('Map tile too large') }
            chunks.push(Buffer.from(value))
          }
        } finally { reader.releaseLock() }
        const body = Buffer.concat(chunks)
        const jpeg = body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
        const png = body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        if (!jpeg && !png) throw new Error('Invalid map imagery')
        const result = { body, type: jpeg ? 'image/jpeg' : 'image/png', expires: now() + TTL }
        while (cacheBytes + size > MAX_CACHE && cache.size) {
          const first = cache.keys().next().value
          cacheBytes -= cache.get(first).body.length
          cache.delete(first)
        }
        cache.set(path, result)
        cacheBytes += size
        return result
      } finally {
        const next = waiting.shift()
        if (next) next()
        else active--
      }
    })()
    pending.set(path, task)
    try { return await task } finally { pending.delete(path) }
  }
  return load
}

const loadTile = createTileLoader()
export async function handleMapTile(req, res, pathname, permitted) {
  if (!pathname.startsWith('/api/map-tiles/')) return false
  if (!permitted) { res.writeHead(403); res.end(); return true }
  if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return true }
  if (!tileTarget(pathname)) { res.writeHead(400); res.end(); return true }
  try {
    const tile = await loadTile(pathname)
    res.writeHead(200, { 'content-type': tile.type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' })
    res.end(tile.body)
  } catch {
    res.writeHead(502, { 'cache-control': 'no-store' })
    res.end()
  }
  return true
}
