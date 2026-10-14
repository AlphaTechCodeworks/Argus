// Keeps Argus's own files on the device, so it opens at once on a weak signal.
//
// Only the files inside pages: styles, scripts, icons. Never page loads themselves: a page can
// answer with a redirect (to sign in), and a redirect handed back from here for a page load is
// refused by the browser outright (ERR_FAILED on Sites, 2026-09-26). Never /api (data), never video
// (WebSockets do not pass through here at all).
//
// The pages link every file with the release it belongs to (?v=<release>, static-files.mjs), and
// such a file never changes: it is served from here at once when kept, fetched once when not, and
// the copies of older releases are dropped. A file asked for without a release (an old page, a
// manifest icon): ask the server first -- an unchanged file comes back as a 304 of a few bytes --
// and use the kept copy of exactly that address only when the server has not answered within
// WAIT_MS or cannot be reached. (v2 matched kept copies ignoring the query and let a slow server
// hand back an old copy: straight after a deploy a browser could run old and new files together.)
const CACHE = 'argus-app-v4'
const WAIT_MS = 2500
const APP_FILE = /\.(css|js|svg|png|webmanifest)$/
// map tiles (map.js LAYERS): the street and satellite tile servers. Kept on the device so the map
// opens at once and a flight between sites does not show blank squares the second time around. A
// tile for a z/x/y never changes, so it is served from here whenever kept (cache-first).
const TILE_CACHE = 'argus-tiles-v2'
const TILE_HOSTS = new Set(['tile.openstreetmap.org', 'server.arcgisonline.com'])
const TILE_MAX = 128
let tileWrites = 0, tilePending = 0, tileWork = Promise.resolve()

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) =>
  e.waitUntil((async () => {
    // earlier versions' kept files go
    for (const k of await caches.keys()) if (k.startsWith('argus-app-') && k !== CACHE) await caches.delete(k)
    for (const k of await caches.keys()) if (k.startsWith('argus-tiles-') && k !== TILE_CACHE) await caches.delete(k)
    await self.clients.claim()
  })())
)

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // map tiles (cross-origin image servers): cache-first, so a tile seen once is instant after
  if (TILE_HOSTS.has(url.hostname)) return e.respondWith(mapTile(req, e))
  if (req.mode === 'navigate') return
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sw.js' || !APP_FILE.test(url.pathname)) return
  e.respondWith(url.searchParams.has('v') ? released(req, url) : fromNetworkElseKept(req))
})

/** A map tile: the kept copy if there is one, else the server's (kept for next time). Fail-safe:
 *  any trouble with the cache just goes to the network, so a tile never breaks on the cache layer. */
async function mapTile(req, event) {
  try {
    const cache = await caches.open(TILE_CACHE)
    const kept = await cache.match(req)
    if (kept) return kept
    const res = await fetch(req) // a cross-origin image: an opaque response (status unreadable)
    // Opaque responses have unknowable quota cost; do not store them.
    if (res.ok && res.type !== 'opaque' && !res.redirected && tilePending < 16) {
      const copy = res.clone()
      tilePending++
      tileWork = tileWork.catch(() => {}).then(async () => {
        const estimate = await navigator.storage?.estimate?.().catch(() => null)
        if (estimate?.quota && estimate.usage / estimate.quota > 0.8) return
        await cache.put(req, copy)
        if (++tileWrites % 16 === 0) await trimTiles(cache)
      }).catch(() => {}).finally(() => { tilePending-- })
      event?.waitUntil(tileWork)
    }
    return res
  } catch {
    return fetch(req)
  }
}

/** Keeps the tile store bounded: past TILE_MAX, drop the oldest (cache.keys is insertion order). */
async function trimTiles(cache) {
  const keys = await cache.keys()
  if (keys.length <= TILE_MAX) return
  for (const k of keys.slice(0, keys.length - TILE_MAX)) await cache.delete(k).catch(() => {})
}

/** A file of one release: the kept copy if there is one, else the server's (kept for next time). */
async function released(req, url) {
  let cache
  try {
    cache = await caches.open(CACHE)
    const kept = await cache.match(req)
    if (kept) return kept
  } catch {}
  // never waits for ever: a download that hangs (a server restarting behind Cloudflare) fails, and
  // the page can say so rather than stay blank
  const res = await fetch(req, { signal: AbortSignal.timeout(20_000) })
  if (cache && res.ok && res.type === 'basic' && !res.redirected) try {
    await cache.put(req, res.clone())
    // this file's copies from other releases are of no further use
    for (const k of await cache.keys()) {
      const u = new URL(k.url)
      if (u.pathname === url.pathname && u.search !== url.search) await cache.delete(k)
    }
  } catch {}
  return res
}

async function fromNetworkElseKept(req) {
  let cache, kept
  try { cache = await caches.open(CACHE); kept = await cache.match(req) } catch {}
  const network = fetch(req, { signal: AbortSignal.timeout(20_000) }).then(async (res) => {
    // only real, complete answers are kept
    if (cache && res.ok && res.type === 'basic' && !res.redirected) try { await cache.put(req, res.clone()) } catch {}
    return res
  })
  if (!kept) return network
  let timer
  const slow = new Promise((resolve) => { timer = setTimeout(() => resolve(kept), WAIT_MS) })
  return Promise.race([network.catch(() => kept), slow]).finally(() => clearTimeout(timer))
}
