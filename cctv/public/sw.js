// Keeps Argus's own files on the device, so it opens at once on a weak signal.
//
// Only the files inside pages: styles, scripts, icons. Never page loads themselves: a page can
// answer with a redirect (to sign in), and a redirect handed back from here for a page load is
// refused by the browser outright (ERR_FAILED on Sites, 2026-09-26). Never /api (data), never video
// (WebSockets do not pass through here at all). For those files: ask the server first -- cheap,
// since an unchanged file comes back as a 304 of a few bytes (static-files.mjs) -- and use the kept
// copy only when the server has not answered within WAIT_MS or cannot be reached.
const CACHE = 'argus-app-v2'
const WAIT_MS = 2500
const APP_FILE = /\.(css|js|svg|png|webmanifest)$/

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) =>
  e.waitUntil((async () => {
    // the first version's kept files (pages among them) go
    for (const k of await caches.keys()) if (k.startsWith('argus-app-') && k !== CACHE) await caches.delete(k)
    await self.clients.claim()
  })())
)

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET' || req.mode === 'navigate') return
  const url = new URL(req.url)
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sw.js' || !APP_FILE.test(url.pathname)) return
  e.respondWith(fromNetworkElseKept(req))
})

async function fromNetworkElseKept(req) {
  const cache = await caches.open(CACHE)
  const kept = await cache.match(req, { ignoreSearch: true })
  const network = fetch(req).then(async (res) => {
    // only real, complete answers are kept
    if (res.ok && res.type === 'basic' && !res.redirected) await cache.put(req, res.clone())
    return res
  })
  if (!kept) return network
  const slow = new Promise((resolve) => setTimeout(() => resolve(kept), WAIT_MS))
  return Promise.race([network.catch(() => kept), slow])
}
