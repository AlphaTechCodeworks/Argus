// Map tile proxy + on-disk cache. The map page (public/map.js) asks THIS server for tiles instead
// of the browser reaching OpenStreetMap / ArcGIS itself, so a viewing PC on an isolated network
// (the server has internet; the PC may not) still gets maps as long as it can reach the server. The
// server fetches each tile once and caches it. It also means one cache sending a proper
// User-Agent, which OpenStreetMap's tile usage policy asks for, rather than every browser hitting
// them anonymously.
//
//   GET /api/tiles/{layer}/{z}/{x}/{y}   layer: street | satellite   -> the tile image (cached)
//
// Only the two known layers and integer tile coordinates within range are ever fetched: the
// upstream URL is built from a fixed template, never from arbitrary request text (no open proxy).
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, rename, writeFile, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from './auth.mjs'

const CACHE_DIR = join(DATA_DIR, 'tiles')
const FETCH_TIMEOUT_MS = 8000
const USER_AGENT = 'Argus-CCTV/1.0 (self-hosted VMS map tile proxy)'
const MAX_Z = 19
// The cache is bounded so a lot of panning cannot fill the disk on a small box. Tiles are ~5-20 KB,
// so this is tens of thousands of them; over it, the oldest are pruned down to PRUNE_TO.
const MAX_CACHE_BYTES = 1024 * 1024 * 1024 // 1 GB
const PRUNE_TO_BYTES = Math.floor(MAX_CACHE_BYTES * 0.8)

// street tiles are z/x/y and PNG; satellite is z/y/x and JPEG (ArcGIS World_Imagery).
const LAYERS = {
  street: { url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, type: 'image/png', ext: 'png' },
  satellite: { url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`, type: 'image/jpeg', ext: 'jpg' }
}

const TILE_RE = /^\/api\/tiles\/([a-z]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/

// Only one fetch per tile is in flight at a time, so a burst of requests for the same tile (the map
// asks for a screenful at once) makes one upstream request, not a dozen.
const inflight = new Map() // cacheFile -> Promise<Buffer | null>

// Approximate cache size, kept in memory so the disk is not scanned on every miss. Starts unknown
// (0) and is reconciled by an actual scan whenever a prune runs.
let cacheBytes = 0
let pruning = null

async function pruneIfNeeded() {
  if (cacheBytes < MAX_CACHE_BYTES || pruning) return
  pruning = (async () => {
    const files = []
    let total = 0
    // layer / z / x / file
    for (const layer of await readdir(CACHE_DIR).catch(() => [])) {
      const ld = join(CACHE_DIR, layer)
      for (const z of await readdir(ld).catch(() => [])) {
        const zd = join(ld, z)
        for (const x of await readdir(zd).catch(() => [])) {
          const xd = join(zd, x)
          for (const f of await readdir(xd).catch(() => [])) {
            const p = join(xd, f)
            const s = await stat(p).catch(() => null)
            if (s?.isFile()) {
              files.push({ p, size: s.size, at: s.mtimeMs })
              total += s.size
            }
          }
        }
      }
    }
    files.sort((a, b) => a.at - b.at) // oldest first
    while (total > PRUNE_TO_BYTES && files.length) {
      const f = files.shift()
      if (await unlink(f.p).then(() => true, () => false)) total -= f.size
    }
    cacheBytes = total
  })().finally(() => { pruning = null })
  await pruning
}

/** Fetch a tile from upstream and cache it; returns the bytes, or null if it could not be fetched. */
async function fetchTile(layer, z, x, y, cacheFile) {
  if (inflight.has(cacheFile)) return inflight.get(cacheFile)
  const p = (async () => {
    try {
      const res = await fetch(LAYERS[layer].url(z, x, y), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'image/png,image/jpeg,image/*' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) return null
      // write to a temp name then rename, so a half-written file is never served
      const tmp = `${cacheFile}.${process.pid}.tmp`
      await mkdir(join(cacheFile, '..'), { recursive: true })
      await writeFile(tmp, buf)
      await rename(tmp, cacheFile).catch(async () => { await unlink(tmp).catch(() => {}) })
      cacheBytes += buf.length
      pruneIfNeeded().catch(() => {})
      return buf
    } catch {
      return null
    }
  })()
  inflight.set(cacheFile, p)
  try {
    return await p
  } finally {
    inflight.delete(cacheFile)
  }
}

/**
 * Serves a map tile if `pathname` is a tile request, from the cache or by fetching it once.
 * @returns {Promise<boolean>} true if it handled the request (then the caller must not answer too)
 */
export async function handleTile(pathname, res, headers = {}) {
  const m = TILE_RE.exec(pathname)
  if (!m) return false
  const [, layer, zS, xS, yS] = m
  const spec = LAYERS[layer]
  const z = Number(zS)
  const x = Number(xS)
  const y = Number(yS)
  const max = 2 ** z
  if (!spec || z > MAX_Z || x >= max || y >= max) {
    res.writeHead(404, { ...headers, 'content-type': 'text/plain' }).end('no such tile')
    return true
  }
  const cacheFile = join(CACHE_DIR, layer, String(z), String(x), `${y}.${spec.ext}`)
  // a tile never changes for a given z/x/y, so let the browser keep it for a long time too
  const ok = (extra = {}) => ({ ...headers, 'content-type': spec.type, 'cache-control': 'public, max-age=604800, immutable', ...extra })
  if (existsSync(cacheFile)) {
    res.writeHead(200, ok())
    createReadStream(cacheFile).on('error', () => res.destroy()).pipe(res)
    return true
  }
  const buf = await fetchTile(layer, z, x, y, cacheFile)
  if (!buf) {
    // the server could not reach the tile source: the browser shows a blank square, as before
    res.writeHead(502, { ...headers, 'content-type': 'text/plain' }).end('tile source unreachable')
    return true
  }
  res.writeHead(200, ok()).end(buf)
  return true
}
