// Keeps Argus's own files on the device, so it opens at once on a weak signal.
//
// Only the app itself: pages, styles, scripts, icons. Never /api (data), never video (WebSockets do
// not pass through here at all). For those files: ask the server first -- cheap, since an unchanged
// file comes back as a 304 of a few bytes (static-files.mjs) -- and use the kept copy only when the
// server has not answered within WAIT_MS or cannot be reached. So a deploy still shows on the next
// load, and a bad signal no longer means a blank page.
const CACHE = 'argus-app-v1'
const WAIT_MS = 2500
const APP_FILE = /\.(html|css|js|svg|png|webmanifest)$|^\/$/

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || !APP_FILE.test(url.pathname)) return
  e.respondWith(fromNetworkElseKept(req))
})

async function fromNetworkElseKept(req) {
  const cache = await caches.open(CACHE)
  const kept = await cache.match(req, { ignoreSearch: true })
  const network = fetch(req).then(async (res) => {
    // only real, complete answers are kept; a redirect to the sign-in page is not the page
    if (res.ok && res.type === 'basic' && !res.redirected) await cache.put(req, res.clone())
    return res
  })
  if (!kept) return network
  const slow = new Promise((resolve) => setTimeout(() => resolve(kept), WAIT_MS))
  return Promise.race([network.catch(() => kept), slow])
}
