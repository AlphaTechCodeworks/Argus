// CCTV gateway: logs in to TVT NVRs (one or more sites, see nvrs.mjs) through the
// native SDK and relays encoded video frames (H.264/H.265) to browsers over WebSocket.
//
// Served on HTTP (HTTP_PORT, for localhost) and HTTPS (HTTPS_PORT, for the LAN).
// Everything except the login page and /healthz requires a viewer session.
//
//   GET  /                     -> viewer page (cctv/public)
//   POST /api/login            -> { user, password } sets the session cookie
//   POST /api/logout
//   GET  /api/me               -> { user, admin }
//   /api/admin/nvrs            -> manage NVRs and sites (admins only), see admin.mjs
//   GET  /api/sites            -> NVRs with site, name and connection status
//   GET  /api/cameras          -> [{ nvr, site, nvrName, ch, name, online }]
//   /api/maps, /api/admin/maps -> camera maps per site, see maps.mjs
//   /api/admin/discovery       -> find TVT NVRs on the network (admins), see discovery.mjs
//   GET  /api/admin/vpn        -> VPN hub status and the remote sites (admins), see vpn.mjs
//   /api/admin/nvrs/:id/substreams -> sub-stream codec per channel, switch to H.264 (admins), see substreams.mjs
//   /api/admin/nvrs/:id/channels/:ch/image -> a camera's picture settings (admins), see imaging.mjs
//     .../image/profiles, .../image/schedule -> Day/Night set-up and schedule, see imaging.mjs
//     .../lens -> focus settings and "Focus now", see lens.mjs
//     .../stream, .../stream/estimate -> main (recording) stream, see streams.mjs
//     .../notes, .../figures -> app notes and measurements for Auto adjust, see camera-notes.mjs
//   /api/admin/sites/:site/notes -> a site's mains frequency (app data), see camera-notes.mjs
//   /api/admin/settings, /api/admin/storage, /api/admin/disks[/prepare] -> Settings tab
//     (recording, storage locations, preparing a USB drive), see settings-api.mjs
//   GET  /api/health           -> the Health page: alerts, NVRs, cameras, drive, last backup,
//                                 and live CPU/memory/network/disk/GPU figures
//   POST /api/admin/alerts/test { method: 'ntfy'|'email' } -> sends a test message (admins)
//   GET  /healthz              -> used by the Docker healthcheck
//   WS   /live?nvr=ID&ch=N&stream=S -> binary frames, S: 0 = main, 1 = sub
//   /api/playback/*?nvr=ID, WS /playback?nvr=ID -> recorded video, see playback.mjs
//   WS   /playback?nvr=ID&...&src=auto -> from the server's own recordings, see rec-playback.mjs
//   GET  /api/playback/timeline?nvr=ID&ch=N&from=ms&to=ms -> the server's own recordings, see rec-api.mjs
//   /api/exports               -> evidence exports (admins): list, start, progress, download,
//                                 delete; see export-api.mjs and export-job.mjs
//   WS   /motion?nvr=ID&...    -> motion search inside a box, see motion.mjs
//
// Wire format of each WebSocket message (little endian):
//   byte 0      flags  (bit0 = keyframe)
//   byte 1      codec  (0 = H.264, 1 = H.265)
//   bytes 2-3   width  (uint16)
//   bytes 4-5   height (uint16)
//   bytes 6-7   reserved
//   bytes 8-15  timestamp in microseconds (int64)
//   bytes 16-   Annex B bitstream
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { extname, join } from 'node:path'
import { WebSocketServer } from 'ws'
import { keepAlive } from './backpressure.mjs'
import * as auth from './auth.mjs'
import { motionScan } from './motion.mjs'
import { handleAdmin } from './admin.mjs'
import { handleDiscovery } from './discovery.mjs'
import { handleImaging } from './imaging.mjs'
import { handleLens } from './lens.mjs'
import { handleStreams } from './streams.mjs'
import { handleCameraNotes, handleSiteNotes } from './camera-notes.mjs'
import { handleSubstreams } from './substreams.mjs'
import { handleSettings } from './settings-api.mjs'
import { cameraRecording, getSettings } from './settings.mjs'
import { startAlerts } from './alert-checks.mjs'
import { makeSysinfo } from './sysinfo.mjs'
import { makeSender } from './alert-send.mjs'
import { lastBackup, runBackup } from './backup.mjs'
import { freePercent, listLocations } from './storage.mjs'
import { estimateRecentRam } from './rec-cache.mjs'
import { SAVE_LIMIT, UPLOAD_LIMIT, handleMapsAdmin, handleMapsRead } from './maps.mjs'
import { LIVE_WORKER, P2P_ENABLED, allCameras, nvrs, readConfig, recIndex, startNvrs, stopNvrs } from './nvrs.mjs'
import { runHousekeeping } from './housekeeping.mjs'
import { playbackApi } from './playback.mjs'
import { timelineApi } from './rec-api.mjs'
import { downloadExport, handleExports } from './export-api.mjs'
import { connectPlayback } from './rec-playback.mjs'
import { vpnView } from './vpn.mjs'
import { sdkStats } from './sdk.mjs'
import { loadCertificate } from './tls.mjs'
import { lastHang, startWatchdog, startupDelayMs } from './watchdog.mjs'
import { GRID_ORDER_PATH, handleGridOrder } from './user-prefs.mjs'

const {
  HTTP_PORT = '8080',
  HTTPS_PORT = '8443',
  CERT_HOSTS = '' // extra names/IPs for the certificate, e.g. this PC's LAN address
} = process.env

const PUBLIC_DIR = join(import.meta.dirname, 'public')

startWatchdog()
{
  const hang = lastHang()
  if (hang) console.warn(`Previous run was restarted by the watchdog at ${hang.at}: ${hang.reason}`)
  // after several watchdog restarts in a short time, wait before connecting again
  const delay = startupDelayMs()
  if (delay) console.warn(`Several watchdog restarts recently; connecting to NVRs in ${Math.round(delay / 1000)} s`)
  setTimeout(startNvrs, delay)
}

// server recording (CCTV_LIVE_WORKER=on only): retention and low-space deletion every 5 minutes
if (LIVE_WORKER) {
  let busy = false
  setInterval(() => {
    if (busy) return
    busy = true
    runHousekeeping({ index: recIndex() })
      .catch((e) => console.warn(`[housekeeping] failed: ${e.message}`))
      .finally(() => (busy = false))
  }, 5 * 60_000).unref()
}

// ---- health alerts and nightly settings backups ---------------------------

const DATA_DIR = auth.DATA_DIR
const STARTED_MS = Date.now()

// Only a hang from just before this start is worth reporting as "the server restarted": an older
// dump file describes a restart the owner was already told about days ago.
const RESTART_REASON = (() => {
  const hang = lastHang()
  const at = hang ? Date.parse(hang.at) : NaN
  return Number.isFinite(at) && STARTED_MS - at < 15 * 60_000 ? `watchdog: ${hang.reason}` : null
})()

/** Each storage location as the alert rules see it: is the drive really there, and how full. */
const locationState = () =>
  listLocations().map((l) => ({
    id: l.id,
    // The folder is what the owner recognises a location by; locations carry no other name.
    name: l.path,
    // The marker file is the test for "really mounted": an empty mount point has no marker.
    mounted: l.health.marker,
    freePct: l.health.marker ? freePercent(l.health) : 0
  }))

/** When each camera last had footage written: its newest closed segment, or the file being written. */
const lastSegmentMs = (nvrId, ch) => {
  const index = recIndex()
  if (!index) return null
  const closed = index.lastEnds(nvrId, ch).segEnd
  const open = index.openOf(nvrId, ch)?.startMs ?? null
  return closed === null && open === null ? null : Math.max(closed ?? 0, open ?? 0)
}

const alerts = startAlerts({
  dataDir: DATA_DIR,
  startedMs: STARTED_MS,
  restartReason: RESTART_REASON,
  getSettings,
  listNvrs: () =>
    [...nvrs.values()].map((n) => ({
      id: n.id,
      name: n.name,
      status: n.status,
      error: n.error,
      clockSkewMs: n.playback?.lastClock?.()?.skewMs ?? 0,
      // Always 0 for now: stream refusals are counted inside each live stream (live.mjs
      // lastFailure), and with CCTV_LIVE_WORKER=on those live in the worker process, so there is
      // no clean way to total them here yet. The nvr-refusing rule therefore never fires.
      refusalsLast10Min: 0
    })),
  // Only slots that actually hold a camera: an NVR reports all 32 of its channels whether or not
  // anything is plugged into them, and empty slots are permanently "offline".
  listCameras: () =>
    allCameras()
      .filter((c) => c.configured !== false)
      .map((c) => ({
        nvrId: c.nvr,
        ch: c.ch,
        name: c.name,
        online: c.online,
        recording: cameraRecording(c.nvr, c.ch).mode !== 'off',
        lastSegmentMs: lastSegmentMs(c.nvr, c.ch)
      })),
  locationState,
  lastBackup: () => lastBackup(DATA_DIR),
  sender: makeSender({ settings: getSettings().alerts, log: console.log }),
  // Reads /proc on every health poll; on Windows every figure simply comes back null.
  sysinfo: makeSysinfo()
})

// Nightly at 02:00, plus one at every start so a change made today is copied before the next one.
const backupTargets = () => {
  const onDrive = (getSettings().storage?.locations ?? []).filter((l) => l.path).map((l) => join(l.path, '_backup'))
  return [...onDrive, ...(process.env.CCTV_BACKUP_DIR ? [process.env.CCTV_BACKUP_DIR] : [])]
}
const runBackupNow = async () => {
  const r = await runBackup({ dataDir: DATA_DIR, targets: backupTargets() })
  console.log(`[backup] ${r.written.length} written${r.errors.length ? `, ${r.errors.length} failed: ${r.errors.join('; ')}` : ''}`)
}
const untilTwoAm = () => {
  const d = new Date()
  d.setHours(2, 0, 0, 0)
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
  return d.getTime() - Date.now()
}
const scheduleBackup = () => {
  // Re-scheduled after each run rather than on an interval, so it stays at 02:00 across a
  // daylight-saving change.
  setTimeout(() => {
    runBackupNow()
      .catch((e) => console.warn(`[backup] failed: ${e.message}`))
      .finally(scheduleBackup)
  }, untilTwoAm()).unref?.()
}
scheduleBackup()
runBackupNow().catch((e) => console.warn(`[backup] failed: ${e.message}`))

// ---- HTTP + WebSocket -----------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
}
const PUBLIC_PATHS = new Set(['/login.html', '/login.js', '/style.css', '/healthz'])
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer'
}

// CCTV_AUTH=off is for local development only: never publish such an instance beyond 127.0.0.1
const AUTH_OFF = process.env.CCTV_AUTH === 'off'

// What is running, shown in every page's header. The version is ours and is bumped by hand in
// VERSION; the release stamp is when that code was installed. Both matter: the version is what we
// talk about, the stamp is how we tell two installs of the same version apart.
const read = (name, fallback) => {
  try {
    return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8').trim() || fallback
  } catch {
    return fallback
  }
}
const VERSION = read('VERSION', '0.0')
const RELEASE = read('RELEASE', 'dev')
const BUILD = { version: `v${VERSION}`, release: RELEASE }
if (AUTH_OFF) console.warn('WARNING: CCTV_AUTH=off, sign-in is disabled. Development use only.')

const clientIp = (req) => req.socket.remoteAddress ?? ''
const currentUser = (req) =>
  AUTH_OFF ? 'dev' : auth.verifySession(auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME])

const readBody = (req, limit = 4096) =>
  new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > limit) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })

/** A JSON object body (an empty body reads as {}); JSON null, arrays and the like are a SyntaxError (400). */
const readJsonObject = async (req, limit = 8192) => {
  const v = JSON.parse((await readBody(req, limit)) || '{}')
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new SyntaxError('the body must be a JSON object')
  return v
}

// A camera's settings routes and the methods each allows: every write or hardware action is
// POST only (a GET on it answers 405), so it always gets the Origin and JSON checks below.
const CAMERA_METHODS = {
  image: ['GET', 'POST'], // read / change, undo, restart
  'image/profiles': ['GET', 'POST'], // Day/Night set-up plan (read only) / do it
  'image/schedule': ['POST'],
  lens: ['GET', 'POST'], // read / save, undo, focus
  stream: ['GET', 'POST'], // read / apply, undo
  'stream/estimate': ['POST'], // read only, but takes a body
  notes: ['GET', 'POST'],
  figures: ['GET', 'POST']
}
const CAMERA_ROUTE = /^\/api\/admin\/nvrs\/([^/]+)\/channels\/(\d{1,3})\/(image|image\/profiles|image\/schedule|lens|stream|stream\/estimate|notes|figures)$/

const sendJson = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...SECURITY_HEADERS, ...headers })
  res.end(JSON.stringify(data))
}

const serveFile = (res, pathname) => {
  // join() resolves any ../ segments, so the prefix check blocks path traversal
  const file = join(PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname)
  if (!file.startsWith(`${PUBLIC_DIR}/`) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, SECURITY_HEADERS).end('Not found')
    return
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    ...SECURITY_HEADERS
  })
  createReadStream(file).pipe(res)
}

const handleLogin = async (req, res) => {
  const ip = clientIp(req)
  if (auth.loginBlocked(ip)) return sendJson(res, 429, { error: 'Too many attempts, try again later' })
  let creds
  try {
    creds = JSON.parse(await readBody(req))
  } catch {
    return sendJson(res, 400, { error: 'Bad request' })
  }
  const user = String(creds.user ?? '')
  if (!(await auth.checkLogin(user, creds.password ?? ''))) {
    auth.recordFailure(ip)
    console.log(`login failed for "${user}" from ${ip}`)
    return sendJson(res, 401, { error: 'Wrong user name or password' })
  }
  auth.clearFailures(ip)
  console.log(`login ok for "${user}" from ${ip}`)
  const cookie = auth.sessionCookie(auth.createSession(user), Boolean(req.socket.encrypted))
  sendJson(res, 200, { user }, { 'set-cookie': cookie })
}

const handleRequest = async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const { pathname } = url

  if (pathname === '/healthz') {
    const list = [...nvrs.values()]
    const streams = list.reduce((n, nvr) => n + (nvr.worker ? nvr.worker.hub.streams.size : nvr.streams.size), 0)
    const s = sdkStats()
    // 503 while SDK calls are overdue: visible to monitoring (the watchdog does the restarting)
    const ok = s.late === 0 && s.oldestMs < 30_000
    const body = {
      ok,
      nvrs: list.length,
      online: list.filter((n) => n.online).length,
      streams,
      sdk: { inFlight: s.inFlight, cap: s.cap, queued: s.queued, late: s.late, oldestMs: s.oldestMs, oldest: s.oldest }
    }
    // CCTV_LIVE_WORKER=on: each NVR's live worker (its own SDK calls are counted there, not above)
    if (list.some((n) => n.worker)) {
      body.workers = Object.fromEntries(
        list
          .filter((n) => n.worker)
          .map((n) => {
            const w = n.worker.stats()
            return [n.id, { state: n.worker.state(), status: w?.status ?? null, late: w?.sdk?.late ?? null, inFlight: w?.sdk?.inFlight ?? null }]
          })
      )
    }
    return sendJson(res, ok ? 200 : 503, body)
  }
  if (pathname === '/api/login' && req.method === 'POST') return handleLogin(req, res)
  if (pathname === '/api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie() })
  }
  if (PUBLIC_PATHS.has(pathname)) return serveFile(res, pathname)

  const user = currentUser(req)
  if (!user) {
    if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Not logged in' })
    res.writeHead(302, { location: '/login.html', ...SECURITY_HEADERS }).end()
    return
  }

  if (pathname === '/api/me') return sendJson(res, 200, { user, admin: AUTH_OFF || auth.isAdmin(user), p2p: P2P_ENABLED, build: BUILD })
  if (pathname === GRID_ORDER_PATH) return sendJson(res, ...(await handleGridOrder(req, user)))
  if (pathname.startsWith('/api/admin/')) {
    if (!AUTH_OFF && !auth.isAdmin(user)) return sendJson(res, 403, { error: 'Only admins can manage NVRs and sites' })
    // changes only from the app's own pages, as JSON (blocks cross-site form posts)
    if (req.method !== 'GET') {
      const origin = req.headers.origin
      let sameOrigin = false
      try {
        sameOrigin = !origin || new URL(origin).host === req.headers.host
      } catch {} // "Origin: null" and the like: refused, not a crash
      if (!sameOrigin || !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return sendJson(res, 403, { error: 'Forbidden' })
      }
    }
    const sub = /^\/api\/admin\/nvrs\/([^/]+)\/substreams(\/job)?$/.exec(pathname)
    if (sub) {
      let id
      try {
        id = decodeURIComponent(sub[1])
      } catch {
        return sendJson(res, 400, { error: 'Bad NVR id' })
      }
      const [status, body] = await handleSubstreams(req.method, id, Boolean(sub[2]), () => readJsonObject(req, 8192), user)
      return sendJson(res, status, body)
    }
    const cam = CAMERA_ROUTE.exec(pathname)
    if (cam) {
      let id
      try {
        id = decodeURIComponent(cam[1])
      } catch {
        return sendJson(res, 400, { error: 'Bad NVR id' })
      }
      const what = cam[3]
      if (!CAMERA_METHODS[what].includes(req.method)) return sendJson(res, 405, { error: 'Method not allowed' }, { allow: CAMERA_METHODS[what].join(', ') })
      const ch = Number(cam[2])
      const readJson = () => readJsonObject(req, 8192)
      const [status, body] = what.startsWith('image')
        ? await handleImaging(req.method, id, ch, url.searchParams, readJson, user, what === 'image' ? '' : what.slice('image/'.length))
        : what === 'lens'
          ? await handleLens(req.method, id, ch, readJson, user)
          : what.startsWith('stream')
            ? await handleStreams(what === 'stream' ? 'stream' : 'estimate', req.method, id, ch, url.searchParams, readJson, user)
            : await handleCameraNotes(what, req.method, id, ch, readJson, user)
      return sendJson(res, status, body)
    }
    const siteNotes = /^\/api\/admin\/sites\/([^/]+)\/notes$/.exec(pathname)
    if (siteNotes) {
      if (!['GET', 'POST'].includes(req.method)) return sendJson(res, 405, { error: 'Method not allowed' }, { allow: 'GET, POST' })
      let site
      try {
        site = decodeURIComponent(siteNotes[1])
      } catch {
        return sendJson(res, 400, { error: 'Bad site' })
      }
      const [status, body] = await handleSiteNotes(req.method, site, () => readJsonObject(req, 4096))
      return sendJson(res, status, body)
    }
    if (pathname === '/api/admin/alerts/test' && req.method === 'POST') {
      const { method } = await readJsonObject(req, 1024)
      if (method !== 'ntfy' && method !== 'email') return sendJson(res, 400, { error: 'method must be ntfy or email' })
      return sendJson(res, 200, await alerts.testSend(method))
    }
    if (pathname === '/api/admin/vpn') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
      return sendJson(res, 200, vpnView(readConfig().nvrs))
    }
    if (pathname === '/api/admin/discovery') {
      const [status, body] = await handleDiscovery(req.method, async () => JSON.parse((await readBody(req, 4096)) || '{}'))
      return sendJson(res, status, body)
    }
    if (pathname.startsWith('/api/admin/maps/')) {
      const limit = pathname.endsWith('/plan') ? UPLOAD_LIMIT : SAVE_LIMIT
      const [status, body] = await handleMapsAdmin(req.method, pathname, async () => JSON.parse((await readBody(req, limit)) || '{}'))
      return sendJson(res, status, body)
    }
    // (the RAM estimate: the NVRs' cameras, not a scan of the whole index; one small query per camera)
    const ramEstimate = () => estimateRecentRam({ index: recIndex(), settings: getSettings(), list: allCameras() })
    const settingsAnswer = await handleSettings(req.method, pathname, () => readJsonObject(req, 16384), user, AUTH_OFF || auth.isAdmin(user), { ramEstimate, params: url.searchParams })
    if (settingsAnswer) return sendJson(res, settingsAnswer[0], settingsAnswer[1], settingsAnswer[2])
    const readJson = async () => JSON.parse((await readBody(req, 8192)) || '{}')
    const [status, body] = await handleAdmin(req.method, pathname, readJson)
    return sendJson(res, status, body)
  }
  // The Health page: everything anyone signed in may see about how the server is doing. It
  // carries no secret, so it is not admin-only (see alert-checks.mjs health()).
  if (pathname === '/api/health') return sendJson(res, 200, alerts.health())
  if (pathname === '/api/sites') return sendJson(res, 200, [...nvrs.values()].map((n) => n.info()))
  if (pathname === '/api/cameras') return sendJson(res, 200, allCameras())
  if (handleMapsRead(pathname, res, sendJson, SECURITY_HEADERS)) return
  if (pathname.startsWith('/api/exports')) {
    const who = { user, admin: AUTH_OFF || auth.isAdmin(user) }
    // Same cross-site guard as the admin routes: a change only from our own pages, as JSON.
    if (req.method !== 'GET') {
      const origin = req.headers.origin
      let sameOrigin = false
      try {
        sameOrigin = !origin || new URL(origin).host === req.headers.host
      } catch {}
      // DELETE carries no body, so it is not asked for a JSON content type.
      const jsonBody = req.method === 'DELETE' || String(req.headers['content-type'] ?? '').startsWith('application/json')
      if (!sameOrigin || !jsonBody) return sendJson(res, 403, { error: 'Forbidden' })
    }
    // The download streams straight to the response, so it is handled before the JSON routes.
    if (await downloadExport({ pathname, method: req.method, who, res, dataDir: DATA_DIR, headers: SECURITY_HEADERS, sendJson })) return
    const clockOf = (id) => nvrs.get(id)?.playback?.lastClock?.()?.skewMs ?? 0
    const answer = await handleExports({
      method: req.method,
      pathname,
      readJson: () => readJsonObject(req, 16384),
      who,
      user,
      index: recIndex(),
      dataDir: DATA_DIR,
      clockOf
    })
    if (answer) return sendJson(res, answer[0], answer[1])
  }
  if (pathname === '/api/playback/timeline') {
    // server recordings, from the database only (never the NVR), see rec-api.mjs
    const who = { user, admin: AUTH_OFF || auth.isAdmin(user) }
    const [status, body] = timelineApi({ nvr: nvrs.get(url.searchParams.get('nvr') ?? ''), params: url.searchParams, who, index: recIndex() })
    return sendJson(res, status, body)
  }
  if (pathname.startsWith('/api/playback/')) {
    // (503 with retryAfterS while the NVR is busy, see playback.mjs)
    const [status, body, headers] = await playbackApi(nvrs.get(url.searchParams.get('nvr') ?? ''), pathname, url.searchParams)
    return sendJson(res, status, body, headers)
  }
  serveFile(res, pathname)
}

const onRequest = (req, res) =>
  handleRequest(req, res).catch((e) => {
    console.error('request failed:', e)
    if (!res.headersSent) res.writeHead(500).end()
  })

const wss = new WebSocketServer({ noServer: true })
keepAlive(wss) // ping every 15 s; a socket that misses a pong is terminated (backpressure.mjs)
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost')
  const nvr = nvrs.get(url.searchParams.get('nvr') ?? '')
  if (!nvr) {
    ws.close(1013, 'unknown NVR')
    return
  }
  if (url.pathname === '/playback') {
    // server recordings (src=auto) or the NVR as before; the "NVR offline" refusal is for NVR
    // sessions only (server playback runs without the NVR), see rec-playback.mjs
    const user = currentUser(req)
    connectPlayback({ nvr, ws, url, who: { user, admin: AUTH_OFF || auth.isAdmin(user) }, index: recIndex() })
    return
  }
  if (url.pathname === '/motion') {
    if (!nvr.online) return ws.close(1013, 'NVR offline')
    motionScan(nvr, ws, url)
    return
  }
  // live video: with a live worker, the worker's own login decides (it polls the camera list)
  if (!nvr.liveOnline) {
    ws.close(1013, 'NVR offline')
    return
  }
  const ch = Number(url.searchParams.get('ch'))
  const streamType = Number(url.searchParams.get('stream') ?? 1)
  if (!Number.isInteger(ch) || ch < 0 || ![0, 1].includes(streamType)) {
    ws.close(1008, 'bad channel or stream')
    return
  }
  const stream = nvr.getStream(ch, streamType)
  stream.add(ws)
  ws.on('close', () => stream.remove(ws))
})

const onUpgrade = (req, socket, head) => {
  // this listener is synchronous: anything that throws here would take the whole process
  // down, so unparseable URLs and Origins (e.g. "Origin: null") are refused, not thrown.
  // Node drops its own error listener from upgrade sockets: a client resetting the
  // connection while we refuse it must not become an uncaught exception either.
  socket.on('error', () => {})
  let url
  let sameOrigin
  try {
    url = new URL(req.url, 'http://localhost')
    // same-origin only, and a valid session
    const origin = req.headers.origin
    sameOrigin = !origin || new URL(origin).host === req.headers.host
  } catch {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return
  }
  if (!['/live', '/playback', '/motion'].includes(url.pathname) || !sameOrigin || !currentUser(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
}

const httpServer = createServer(onRequest)
httpServer.on('upgrade', onUpgrade)
httpServer.listen(Number(HTTP_PORT), () => console.log(`HTTP  on port ${HTTP_PORT} (use http://localhost on this PC)`))

const certHosts = CERT_HOSTS.split(',').map((h) => h.trim()).filter(Boolean)
const httpsServer = createHttpsServer(loadCertificate(certHosts), onRequest)
httpsServer.on('upgrade', onUpgrade)
httpsServer.listen(Number(HTTPS_PORT), () => console.log(`HTTPS on port ${HTTPS_PORT} (for other PCs and phones)`))

if (Object.keys(auth.loadUsers()).length === 0) {
  console.warn('No viewer accounts yet. Create one with: docker exec -it tvt-cctv node cctv/adduser.mjs <name>')
}

const shutdown = async () => {
  // a clean logout is nice but must not hang; SIGKILL avoids exit() waiting on stuck SDK threads
  await Promise.race([stopNvrs().catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
  process.kill(process.pid, 'SIGKILL')
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
