// CCTV gateway: logs in to TVT NVRs (one or more sites, see nvrs.mjs) through the
// native SDK and relays encoded video frames (H.264/H.265) to browsers over WebSocket.
//
// Served on HTTP (HTTP_PORT, for localhost) and HTTPS (HTTPS_PORT, for the LAN).
// Everything except the login page and /healthz requires a viewer session; /healthz answers
// anyone but this machine itself and a signed-in admin with { ok } only.
//
//   GET  /                     -> viewer page (cctv/public)
//   POST /api/login            -> { user, password } sets the session cookie
//   POST /api/logout
//   GET  /api/me               -> { user, admin }
//   /api/admin/nvrs            -> manage NVRs and sites (admins only), see admin.mjs
//   GET  /api/sites            -> NVRs with site, name and connection status
//   GET  /api/cameras          -> [{ nvr, site, nvrName, ch, name, online }]
//   /api/maps, /api/admin/maps -> camera maps per site, see maps.mjs
//   /api/camera-links, /api/admin/camera-links -> which camera adjoins which, see camera-links.mjs
//   /api/admin/discovery       -> find TVT NVRs on the network (admins), see discovery.mjs
//   GET  /api/admin/vpn        -> VPN hub status and the remote sites (admins), see vpn.mjs
//   /api/admin/nvrs/:id/substreams -> sub-stream codec per channel, switch to H.264 (admins), see substreams.mjs
//   GET  /api/admin/nvrs/:id/disks[?discover=1] -> what the NVR says about its own disks and how
//                                 many days it holds; discover=1 sends every candidate query and
//                                 returns the raw answers (read only), see nvr-disks.mjs
//   GET  /api/admin/nvrs/:id/netstatus -> the NVR's receive and send bandwidth, in use and left, and
//                                 its ports' addresses (read only), see nvr-netstatus.mjs
//   /api/admin/nvrs/:id/channels/:ch/image -> a camera's picture settings (admins), see imaging.mjs
//     .../image/profiles, .../image/schedule -> Day/Night set-up and schedule, see imaging.mjs
//     .../lens -> focus settings and "Focus now", see lens.mjs
//     .../stream, .../stream/estimate -> main (recording) stream, see streams.mjs
//     .../lines -> line-crossing lines the camera detects on, see tripwire.mjs
//     .../notes, .../figures -> app notes and measurements for Auto adjust, see camera-notes.mjs
//   /api/admin/sites/:site/notes -> a site's mains frequency (app data), see camera-notes.mjs
//   /api/admin/settings, /api/admin/storage, /api/admin/disks[/prepare] -> Settings tab
//     (recording, storage locations, preparing a USB drive), see settings-api.mjs
//   GET  /api/health           -> the Health page: alerts, NVRs, cameras, drive, last backup,
//                                 and live CPU/memory/network/disk/GPU figures
//   POST /api/admin/alerts/test { method: 'ntfy'|'email' } -> sends a test message (admins)
//   POST /api/admin/lines/alert { nvr, ch, on } -> a camera's line-crossing phone alert on or off
//                                 (admins): the "Line crossing" alarm rule, see line-actions.mjs
//   GET  /healthz              -> used by the Docker healthcheck and the watchers on this machine;
//                                 { ok } only for anyone else who is not an admin (security.mjs localProbe)
//   WS   /live?nvr=ID&ch=N&stream=S -> binary frames, S: 0 = main, 1 = sub
//   WS   /live-mux             -> every live tile of a page on one socket, see live-mux.mjs
//   /api/playback/*?nvr=ID, WS /playback?nvr=ID -> recorded video, see playback.mjs
//   WS   /playback?nvr=ID&...&src=auto -> from the server's own recordings, see rec-playback.mjs
//   GET  /api/playback/timeline?nvr=ID&ch=N&from=ms&to=ms -> the server's own recordings, see rec-api.mjs
//   /api/exports               -> evidence exports: list, start, progress, download, delete (each
//                                 person their own while their export right covers it, an admin
//                                 every one); see export-api.mjs and export-job.mjs
//   WS   /motion?nvr=ID&...    -> motion search inside a box, see motion.mjs
//   (every video socket and /live-mux channel is asked its rights again while it is open, and
//    closed 1008 once refused or signed out: see access-watch.mjs)
//   GET  /api/events/:id/snapshot -> an event's picture (JPEG), for users who may play that
//                                 camera back, see event-snapshot.mjs
//
// Wire format of each WebSocket message (little endian):
//   byte 0      flags  (bit0 = keyframe)
//   byte 1      codec  (0 = H.264, 1 = H.265)
//   bytes 2-3   width  (uint16)
//   bytes 4-5   height (uint16)
//   bytes 6-7   reserved
//   bytes 8-15  timestamp in microseconds (int64)
//   bytes 16-   Annex B bitstream
import { clientIpOf, localProbe, securityHeaders } from './security.mjs'
import { handleNvrLog } from './nvr-log.mjs'
import { handleNetStatus } from './nvr-netstatus.mjs'
import { handleRelays } from './relays.mjs'
import { transparent } from './nvr-xml.mjs'
import { readAlerts } from './alert-log.mjs'
import { PERIODS, composeReport, countInThread, periodWindow, startDailySummary } from './reports.mjs'
import { commonOffset, useSiteOffset } from './site-time.mjs'
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
import { handleLines } from './tripwire.mjs'
import { ADMIN_OSD_PATH, OSD_PATH, handleCameraNotes, handleOsd as handleCameraOsd, handleSiteNotes } from './camera-notes.mjs'
import { handleSubstreams } from './substreams.mjs'
import { handleClocks, handleProbe } from './nvr-probe.mjs'
import { handleClockWrite, measuredDrift, startClockSync, zoneOffsets } from './nvr-clock.mjs'
import { handleSettings } from './settings-api.mjs'
import { cameraRecording, getSettings } from './settings.mjs'
import { startAlerts } from './alert-checks.mjs'
import { makeSysinfo } from './sysinfo.mjs'
import { makeSender } from './alert-send.mjs'
import { lastBackup, runBackup } from './backup.mjs'
import { freeOf, freePercent, listLocations, markerMatches } from './storage.mjs'
import { PhoneLive } from './phone-live.mjs'
import { AdaptiveLive, isRemoteAddress } from './adaptive-live.mjs'
import { MAX_MESSAGE_BYTES, serveMux } from './live-mux.mjs'
import { liveAttacher } from './live-attach.mjs'
import { ffmpegCpuPercent, meterSocket, trafficSummary } from './traffic.mjs'
import { isCached, fileResponse, setAssetStamp, warmFiles } from './static-files.mjs'
import { startWarmStreams } from './warm-streams.mjs'
import { allGridOrders } from './user-prefs.mjs'
import { pool as playbackTranscodes } from './transcode.mjs'
import { estimateRecentRam } from './rec-cache.mjs'
import { SAVE_LIMIT, UPLOAD_LIMIT, handleMapsAdmin, handleMapsRead, readMaps } from './maps.mjs'
import { ADMIN_LINKS_PATH, BODY_LIMIT as LINKS_BODY_LIMIT, LINKS_PATH, handleCameraLinks } from './camera-links.mjs'
import { LIVE_WORKER, P2P_ENABLED, REC_DB, allCameras, nvrs, readConfig, recIndex, startNvrs, stopNvrs } from './nvrs.mjs'
import { runHousekeeping } from './housekeeping.mjs'
import { playbackApi } from './playback.mjs'
import { timelineApi } from './rec-api.mjs'
import { downloadExport, handleExports } from './export-api.mjs'
import { listExports } from './export-job.mjs'
import { connectPlayback } from './rec-playback.mjs'
import { accessWatch } from './access-watch.mjs'
import { vpnView } from './vpn.mjs'
import { nvrCooling, sdkStats } from './sdk.mjs'
import { discoverStorage, makeNvrStorage, probeSmart, readStorage, sdkQuery } from './nvr-disks.mjs'
import { recentRefusals } from './nvr-health.mjs'
import { probeTarget, tcpReachable } from './probe.mjs'
import { handleBookmarks, protectedRanges } from './bookmarks.mjs'
import { handleBackfill, initBackfill } from './backfill.mjs'
import { buildStorageReport, driveFullCandidates, handleStorage, readHistory, setStorageContext } from './storage-report.mjs'
import { can, canPlayAnyOn, handleRights, onRightsSaved, sitesFor } from './rights.mjs'
import { healthFor } from './health-view.mjs'
import { handleUsers } from './users-api.mjs'
import { machineRebootAvailable, requestReboot } from './machine-reboot.mjs'
import { audit, handleAudit, pruneAudit } from './audit.mjs'
import { handleViews } from './views.mjs'
import { handleEvents } from './events.mjs'
import { handleSnapshot, sweepSnapshots } from './event-snapshot.mjs'
import { handleAlarms } from './alarms.mjs'
import { handleLineAlert } from './line-actions.mjs'
import { handleOsd } from './osd.mjs'
import { MAX_SEGMENTS_PER_RUN, runRetention, runThinning } from './thinning.mjs'
import { runStorageJobs } from './storage-jobs.mjs'
import { detectEncoder } from './transcode.mjs'
import { httpsOptions } from './tls.mjs'
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

/**
 * Time-lapse thinning and retention, which between them are the only things in this system that
 * delete or rewrite footage on purpose.
 *
 * They run in dry run until somebody deliberately says otherwise: `storage.thinning: 'on'`. In dry
 * run they work out exactly what they would do, touch nothing, and say so in the log -- so a night
 * or two of "would have removed N segments, freeing X GB" can be read before any of it is real.
 * The first dry run on 2026-09-25 came back zero for both, because nothing recorded so far is old
 * enough to have reached any threshold; the interesting numbers arrive as footage ages, and are
 * worth seeing before the jobs are armed rather than after.
 *
 * The switch is Settings > Storage since 2026-09-29 (off / dry run / on, audited); storage-jobs.mjs
 * keeps what each job last did for that page and writes a summary line at most once an hour, so a
 * quiet journal can no longer mean either "found nothing" or "never ran".
 */
function thinAndRetain() {
  const index = recIndex()
  return runStorageJobs({
    // a function: read again before each job, so Off or Dry run set during a long thinning run holds
    // for retention in the same round (storage-jobs.mjs)
    mode: () => getSettings().storage?.thinning,
    index,
    jobs: { thinning: runThinning, retention: runRetention },
    args: () => ({ index, settings: getSettings(), protectedRanges, present: markerMatches }),
    limit: MAX_SEGMENTS_PER_RUN
  })
}

// server recording (CCTV_LIVE_WORKER=on only): retention and low-space deletion every 5 minutes
if (LIVE_WORKER) {
  let busy = false
  setInterval(() => {
    if (busy) return
    busy = true
    runHousekeeping({ index: recIndex() })
      .then(() => pruneAudit(auth.DATA_DIR)) // a year of audit is kept; older rows go with the rest
      .then(() => thinAndRetain())
      // pictures of events that are gone (event-snapshot.mjs; it never throws)
      .then(() => sweepSnapshots())
      .catch((e) => console.warn(`[housekeeping] failed: ${e.message}`))
      .finally(() => (busy = false))
  }, 5 * 60_000).unref()

  // The storage forecast is built from free-space samples taken over time, so it has nothing to say
  // until it has been running a while -- and it says that, rather than extrapolating from one point.
  setStorageContext({ index: recIndex, dataDir: auth.DATA_DIR })

  // Backfill: pulling stretches the server missed from the NVR that still has them. It resumes a
  // job interrupted by a restart, and stands down for live recording and exports -- nothing here
  // is worth a frame of live video. It only runs at all once an owner switches it on.
  initBackfill({
    index: recIndex,
    nvrs,
    locations: listLocations,
    settings: getSettings,
    // An export is somebody waiting at a screen for evidence; backfill is a job with days of slack.
    // If this cannot be answered the module assumes an export IS running and stands down, which is
    // the right way round to be wrong.
    exportsBusy: () => listExports(auth.DATA_DIR).some((j) => j.state === 'running' || j.state === 'queued'),
    recordingBusy: () => false, // recording never pauses; the rate limit is what keeps backfill polite
    refusingOf: (id) => recentRefusals(nvrs.get(id)?.streams ?? [], Date.now()) > 0,
    coolingOf: (id) => Boolean(nvrCooling(id))
  })
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
    // The marker file is the test for "really mounted": an empty mount point has no marker. A share
    // not checked yet since the server started is unknown (null), not missing: saying "not mounted"
    // for the half-minute after every restart was a false alarm.
    mounted: l.health.reason === 'not checked yet' ? null : l.health.marker,
    freePct: l.health.marker ? freePercent(l.health) : 0
  }))

/** When each camera last had footage written: its newest closed segment, or the file being written. */
const lastSegmentMs = (nvrId, ch) => {
  const index = recIndex()
  if (!index) return null
  const closed = index.lastSegmentEnd(nvrId, ch)
  const open = index.openOf(nvrId, ch)?.startMs ?? null
  return closed === null && open === null ? null : Math.max(closed ?? 0, open ?? 0)
}

/**
 * Streams of this NVR whose last start was refused rather than slow, in the last 10 minutes.
 * With CCTV_LIVE_WORKER=on the streams live in the worker process, so the figure comes back in
 * its STATS message (nvr-worker.mjs); without a worker they are here. null means nobody counted
 * — the Health page then says "not measured" rather than a reassuring zero, and the
 * nvr-refusing rule (which needs >= 3) simply does not fire.
 */
const refusalsOf = (n) => {
  if (n.worker) {
    const s = n.worker.state() === 'ready' ? n.worker.stats() : null
    return Number.isFinite(s?.refusals) ? s.refusals : null
  }
  return recentRefusals(n.streams?.values?.() ?? [], Date.now())
}

/** How long ago a call to this NVR last came back from the SDK, or null if none ever has. */
const lastContactOf = (() => {
  let cached = { at: 0, byNvr: {} }
  return (id) => {
    // sdkStats() walks every in-flight call; once per health poll is plenty for a whole list.
    if (Date.now() - cached.at > 1000) cached = { at: Date.now(), byNvr: sdkStats().lastReturnAgoByNvr ?? {} }
    const ms = cached.byNvr[id]
    return Number.isFinite(ms) ? ms : null
  }
})()

/** What each NVR says about its own disks and retention (nvr-disks.mjs): background, cached 10 min. */
const nvrStorage = makeNvrStorage({
  listNvrs: () => [...nvrs.values()],
  // Only asked for an NVR that is not logged in, so the page can separate "the network is down"
  // from "it is there but would not let us in".
  reach: async (nvr) => {
    const target = probeTarget(nvr.cfg)
    return target ? tcpReachable(target.host, target.port) : { ok: true, why: '', skipped: true }
  }
})

// The server is the master clock: it keeps its own time by NTP and every recording is stamped
// with it, so the NVRs are kept in step with the server rather than each hoping to reach a time
// server of its own -- which a remote site may not be able to reach at all.
/**
 * An NVR's clock error for Health: the newer of the clock sync's reading and playback's, and none at
 * all (no alert) when both are over 30 minutes old -- an old reading was alerted on for hours after
 * the clock had been put right.
 */
const CLOCK_READING_MAX_AGE_MS = 30 * 60_000
function freshSkewMs(n) {
  const a = measuredDrift(n.id)
  const pb = n.playback?.lastClock?.()
  const b = pb ? { driftMs: pb.skewMs, at: pb.at } : null
  const newest = [a, b].filter((x) => x && Date.now() - x.at < CLOCK_READING_MAX_AGE_MS).sort((x, y) => y.at - x.at)[0]
  return newest ? newest.driftMs : 0
}
const clockSync = startClockSync(nvrs, { enabled: () => getSettings().clockSync?.enabled !== false })
// Which encoder the H.265 -> H.264 playback fallback will use, probed once at start rather than on
// the first viewer: the probe runs a real short encode, and paying for that while somebody is
// waiting for video is the wrong moment.
//
// The failure is logged rather than swallowed. An earlier version threw the error away, which hid
// the fact that this line had been commented out by a botched edit and was never running at all --
// silence looked exactly like success.
detectEncoder().catch((e) => console.warn(`[transcode] could not work out which encoder to use: ${e.message}`))

const alerts = startAlerts({
  dataDir: DATA_DIR,
  startedMs: STARTED_MS,
  restartReason: RESTART_REASON,
  getSettings,
  nvrStorage,
  // "This drive will be full in under a week", from the free-space samples storage-report keeps.
  // It stays quiet for a drive that has already reached its retention and is overwriting, because
  // a cycling recorder is permanently full and an alert that fires every night is one nobody reads.
  extraCandidates: () => driveFullCandidates(
    buildStorageReport({ settings: getSettings(), index: recIndex(), history: readHistory(DATA_DIR), present: markerMatches, freeOf }),
    { days: 7 }
  ),
  listNvrs: () =>
    [...nvrs.values()].map((n) => ({
      id: n.id,
      name: n.name,
      status: n.status,
      error: n.error,
      model: n.model,
      serial: n.serial,
      host: n.cfg?.host ?? null,
      via: n.cfg?.sn ? 'p2p' : 'lan',
      streams: n.worker ? (n.worker.stats()?.streams ?? null) : n.streams.size,
      cooling: nvrCooling(n.id),
      lastContactMs: lastContactOf(n.id),
      clockSkewMs: freshSkewMs(n),
      refusalsLast10Min: refusalsOf(n)
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
  sender: makeSender({ settings: () => getSettings().alerts ?? {}, log: console.log }),
  // Reads /proc on every health poll; on Windows every figure simply comes back null.
  sysinfo: makeSysinfo()
})

// Nightly at 02:00, plus one at every start so a change made today is copied before the next one.
const backupTargets = () => {
  // Only locations whose recordings marker is present: a network share that has dropped leaves an
  // empty folder behind on the server's own disk, and on 2026-09-26 the nightly backup wrote into
  // exactly that folder while recording -- which checks the marker -- rightly refused to. A backup
  // that lands on the wrong disk is worse than a skipped one: it looks done and is not where
  // anyone will look for it.
  const onDrive = listLocations().filter((l) => l.path && l.health?.marker).map((l) => join(l.path, '_backup'))
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
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
}
// the sign-in page's own stylesheets and theme script: without them it is unstyled until signed in
const PUBLIC_PATHS = new Set(['/login.html', '/login.js', '/style.css', '/theme-boot.js', '/css/tokens.css', '/css/base.css', '/css/components.css', '/logo.svg', '/manifest.webmanifest', '/icon-180.png', '/icon-512.png', '/sw.js', '/healthz'])
const SECURITY_HEADERS = securityHeaders()

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

// the visitor behind the Cloudflare tunnel, not cloudflared (security.mjs)
const clientIp = (req) => clientIpOf(req.socket.remoteAddress, req.headers['cf-connecting-ip'])
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
  figures: ['GET', 'POST'],
  lines: ['GET', 'POST'] // read / change, undo
}
const CAMERA_ROUTE = /^\/api\/admin\/nvrs\/([^/]+)\/channels\/(\d{1,3})\/(image|image\/profiles|image\/schedule|lens|stream|stream\/estimate|notes|figures|lines)$/

const sendJson = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...SECURITY_HEADERS, ...headers })
  res.end(JSON.stringify(data))
}

const serveFile = (res, pathname, req = null) => {
  // join() resolves any ../ segments, so the prefix check blocks path traversal
  const file = join(PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname)
  // (a file already served skips the two disk checks: loadFile's own stat still sees a change)
  if (!file.startsWith(`${PUBLIC_DIR}/`) || (!isCached(file) && (!existsSync(file) || !statSync(file).isFile()))) {
    res.writeHead(404, SECURITY_HEADERS).end('Not found')
    return
  }
  // compressed, and 304 when the browser's copy is current (static-files.mjs)
  const r = fileResponse({
    path: file,
    type: MIME[extname(file)] ?? 'application/octet-stream',
    ifNoneMatch: req?.headers['if-none-match'],
    acceptEncoding: req?.headers['accept-encoding'],
    // this release's own name for the file (the pages link it so): kept for good (static-files.mjs)
    versioned: /[?&]v=/.test(req?.url ?? '')
  })
  res.writeHead(r.status, { ...r.headers, ...SECURITY_HEADERS })
  res.end(r.body ?? undefined)
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
    // Failed sign-ins are the ones worth keeping: a run of them from one address is the first
    // sign of somebody trying the door. audit() never throws, so it cannot break a login.
    audit(auth.DATA_DIR, { user, action: 'login-failed', ip, ok: false })
    return sendJson(res, 401, { error: 'Wrong user name or password' })
  }
  auth.clearFailures(ip)
  console.log(`login ok for "${user}" from ${ip}`)
  audit(auth.DATA_DIR, { user, action: 'login', ip })
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
      sdk: { inFlight: s.inFlight, cap: s.cap, queued: s.queued, late: s.late, oldestMs: s.oldestMs, oldest: s.oldest },
      // network shares as last checked (never checked here): the outside watcher remounts one that
      // stopped answering, which the server itself, no longer frozen by it, would otherwise hide
      shares: listLocations().filter((l) => l.type === 'network').map((l) => ({ path: l.path, ok: l.health.ok, reason: l.health.reason }))
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
    // The whole body (NVR ids, share paths, SDK load) is for the watchers on this machine and for a
    // signed-in admin. Anyone else, through the tunnel or on the LAN, learns only whether it is up:
    // the status code and { ok } are all the Docker healthcheck and server-restart.js read.
    const u = currentUser(req)
    const full = localProbe(req.socket.remoteAddress, req.headers['cf-connecting-ip']) || Boolean(u && (AUTH_OFF || auth.isAdmin(u)))
    return sendJson(res, ok ? 200 : 503, full ? body : { ok })
  }
  if (pathname === '/api/login' && req.method === 'POST') return handleLogin(req, res)
  if (pathname === '/api/logout' && req.method === 'POST') {
    // Read before the cookie is cleared, or there is nobody to name in the entry.
    const leaving = currentUser(req)
    if (leaving) audit(auth.DATA_DIR, { user: leaving, action: 'logout', ip: clientIp(req) })
    // Clearing the cookie signs out this browser only: the token would stay good for its 7 days, and a
    // page still open with it would keep its video and could open more. Revoked, it is refused from
    // now on, and the sockets it opened are closed (auth.mjs revokeSession, access-watch.mjs).
    auth.revokeSession(auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME])
    return sendJson(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie() })
  }
  if (PUBLIC_PATHS.has(pathname)) return serveFile(res, pathname, req)

  const user = currentUser(req)
  if (!user) {
    if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Not logged in' })
    res.writeHead(302, { location: '/login.html', ...SECURITY_HEADERS }).end()
    return
  }

  // Who is asking, in the one shape the rights and audit layers accept. Authority comes from the
  // session and nowhere else: a user named in a request body says whose settings are being
  // changed, never who is doing the changing.
  const who = { user, admin: AUTH_OFF || auth.isAdmin(user) }
  // What this user may see of a camera at all: watching it live or playing it back (rights.mjs). The
  // routes that tell about cameras rather than show them (events, alarms, bookmarks, health, maps,
  // links, overlays) keep every other camera out of their answers with it.
  const canSee = (nvr, ch) => who.admin || ['live', 'playback-server', 'playback-nvr'].some((a) => can(who, a, { nvr, ch }))

  if (pathname === '/api/me') return sendJson(res, 200, { user, admin: who.admin, p2p: P2P_ENABLED, build: BUILD, canRebootMachine: who.admin && machineRebootAvailable() })
  if (pathname === GRID_ORDER_PATH) return sendJson(res, ...(await handleGridOrder(req, user)))

  // Signed in is enough for these. Bookmarks: only those on cameras this user may see, and in them
  // only those cameras (canSee; bookmarks.mjs). Saved views are each user's own.
  const marks = await handleBookmarks(req.method, pathname + url.search, () => readJsonObject(req, 8192), who, { canSee })
  if (marks) return sendJson(res, ...marks)
  const views = await handleViews(req.method, pathname, () => readJsonObject(req, 32768), user)
  if (views) return sendJson(res, ...views)
  // An event's picture (event-snapshot.mjs): a JPEG, not JSON, so it is answered here, before the JSON
  // routes; who may see it is decided inside (a playback right for that camera)
  const snapRoute = /^\/api\/events\/(\d{1,15})\/snapshot$/.exec(pathname)
  if (snapRoute) return handleSnapshot(req, res, snapRoute[1], who)
  // alarms and events of cameras this user may not see stay out of their lists (canSee above):
  // watching live or playing back that camera is what lets them see what happened on it
  const ev = await handleEvents(req.method, pathname + url.search, () => readJsonObject(req, 4096), { nvrs, user, admin: who.admin, intake: null, canSee })
  if (ev) return sendJson(res, ...ev)
  const al = await handleAlarms(req.method, pathname + url.search, () => readJsonObject(req, 8192), { user, admin: who.admin, cameras: allCameras, canSee })
  // every camera's own address and web port, as its NVR connects to it (admins): for the settings an
  // NVR cannot pass on, such as day/night on some models, made on the camera's own page
  if (pathname === '/api/admin/camera-addresses') {
    if (!who.admin) return sendJson(res, 403, { error: 'Admins only' })
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
    return sendJson(res, 200, [...nvrs.values()].flatMap((n) => n.channels.filter((c) => c.configured !== false).map((c) => ({
      nvr: n.id, site: n.site, ch: c.ch, name: c.name, online: c.online, ip: c.ip || null, httpPort: c.httpPort ?? null, model: c.model || null, maker: c.maker || null
    }))))
  }
  // NVR alarm outputs, read only (relays.mjs)
  const relays = await handleRelays(req.method, pathname, { nvrs, admin: who.admin, query: transparent })
  if (relays) return sendJson(res, ...relays)
  // an NVR's own event log, read only (nvr-log.mjs)
  const nvrLog = await handleNvrLog(req.method, pathname, url.search, { nvrs, admin: who.admin, query: transparent })
  if (nvrLog) return sendJson(res, ...nvrLog)
  // an NVR's network status: how much of its send budget, shared by every client, is left (nvr-netstatus.mjs)
  const netStatus = await handleNetStatus(req.method, pathname, { nvrs, admin: who.admin, query: transparent })
  if (netStatus) return sendJson(res, ...netStatus)
  if (al) return sendJson(res, ...al)
  const store = await handleStorage(req.method, pathname, () => readJsonObject(req, 4096), who)  // accepts the { user, admin } shape
  if (store) return sendJson(res, ...store)
  // Which camera adjoins which: read by everyone signed in (the follow strip needs it), changed by
  // admins only. The admin path goes through the same guard block below as every other admin write.
  // The read is built from the cameras this user may see: camera-links.mjs drops every link and
  // suggestion whose either end is not among them, labels and all.
  if (pathname === LINKS_PATH) {
    const answer = await handleCameraLinks(req.method, pathname, () => readJsonObject(req, LINKS_BODY_LIMIT), { cameras: () => allCameras().filter((c) => canSee(c.nvr, c.ch)), maps: readMaps })
    if (answer) return sendJson(res, answer[0], answer[1], answer[2])
  }
  // What each camera draws over its own picture: its name and the clock. Read by everyone signed
  // in, because every page that shows video draws it, but only for the cameras they may see (the
  // text is a name); changed by admins only, which the handler checks for itself. The NVRs refuse
  // to say or set their own OSD, so this is the app's.
  if (pathname === OSD_PATH || pathname === ADMIN_OSD_PATH) {
    const answer = await handleCameraOsd(req.method, pathname, () => readJsonObject(req, 16 * 1024), { admin: who.admin, canSee })
    if (answer) return sendJson(res, ...answer)
  }
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
    // Read-only: what this NVR actually supports. The firmware offers far more than this app
    // uses (tamper detection, face matching, its own disk state), but whether a given NVR has any
    // of it depends on its model, firmware and licence, so the only honest answer is to ask it.
    const probe = await handleProbe(req.method, pathname, nvrs)
    if (probe) return sendJson(res, probe[0], probe[1])
    // GET /api/admin/nvr-clocks?sync=1 — run the master-clock pass now and say what it did to each
    // NVR. Without this the only way to see the sync work is to restart and wait three minutes,
    // and its answer for an NVR it chose to leave alone is as interesting as one it corrected.
    if (pathname === '/api/admin/nvr-clocks' && req.method === 'GET' && url.searchParams.get('sync')) {
      return sendJson(res, 200, { ran: await clockSync.runNow() })
    }
    // What a camera burns into its own picture: its name, the clock, and where they sit.
    const osd = await handleOsd(req.method, pathname, url.searchParams, () => readJsonObject(req, 2048), nvrs, who)
    if (osd) return sendJson(res, ...osd)
    const clocks = await handleClocks(req.method, pathname, nvrs)
    if (clocks) return sendJson(res, clocks[0], clocks[1])
    const clockWrite = await handleClockWrite(req.method, pathname, () => readJsonObject(req, 2048), nvrs, user)
    if (clockWrite) return sendJson(res, clockWrite[0], clockWrite[1])

    // Filling holes in the server's copy from the NVR's own, while the NVR still has them.
    const backfill = await handleBackfill(req.method, pathname, () => readJsonObject(req, 2048), user)
    if (backfill) return sendJson(res, backfill[0], backfill[1])
    // Who may do what, and the record of who did.
    const rightsRoute = await handleRights(req.method, pathname, () => readJsonObject(req, 8192), who)
    if (rightsRoute) return sendJson(res, ...rightsRoute)
    // accounts: add a viewer or an admin from the app (users-api.mjs)
    const usersRoute = await handleUsers(req.method, pathname, () => readJsonObject(req, 2048), who)
    if (usersRoute) return sendJson(res, ...usersRoute)
    // Settings > Server: restart. The answer goes out first; systemd (Restart=always) starts it again.
    if (req.method === 'POST' && pathname === '/api/admin/restart') {
      if (!who?.admin) return sendJson(res, 403, { error: 'Only an admin can restart the server' })
      audit(auth.DATA_DIR, { user: who.user, action: 'server-restart', target: 'server', ok: true })
      console.log(`[server] restart asked for by ${who.user}`)
      sendJson(res, 200, { restarting: true })
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
      return
    }
    // Reports: a day, a week or a month of recording, per camera and in total (reports.mjs, admins)
    if (req.method === 'GET' && pathname === '/api/admin/reports') {
      if (!who?.admin) return sendJson(res, 403, { error: 'Only an admin can see reports' })
      const period = PERIODS.includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'week'
      try {
        return sendJson(res, 200, await reportFor(period))
      } catch (e) {
        return sendJson(res, 500, { error: `The report could not be made: ${e.message}` })
      }
    }
    // Settings > Server: reboot the whole machine (machine-reboot.mjs: a root unit does it)
    if (req.method === 'POST' && pathname === '/api/admin/reboot') {
      if (!who?.admin) return sendJson(res, 403, { error: 'Only an admin can reboot the machine' })
      let r
      try {
        r = requestReboot({ dataDir: auth.DATA_DIR })
      } catch (e) {
        r = { status: 500, body: { error: `Could not ask for the reboot: ${e.message}` } }
      }
      audit(auth.DATA_DIR, { user: who.user, action: 'machine-reboot', target: 'server', ok: r.status === 200, detail: r.body.error })
      console.log(`[server] machine reboot asked for by ${who.user}: ${r.status === 200 ? 'rebooting' : r.body.error}`)
      return sendJson(res, r.status, r.body)
    }
    const auditRoute = handleAudit(req.method, pathname, url.searchParams, who, auth.DATA_DIR, { can })
    if (auditRoute) return sendJson(res, ...auditRoute)

    // GET /api/admin/nvrs/:id/disks[?discover=1] — what this NVR says about its own disks.
    // Without discover: the cached snapshot the Health page uses, read again now.
    // With discover: every candidate command is sent once and the raw answers come back, so the
    // shapes these NVRs really return can be confirmed. Read-only: the list is fixed and every
    // name on it is a query (see nvr-disks.mjs DISCOVERY); nothing here can be made to write.
    const disksRoute = /^\/api\/admin\/nvrs\/([^/]+)\/disks$/.exec(pathname)
    if (disksRoute) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' }, { allow: 'GET' })
      let id
      try {
        id = decodeURIComponent(disksRoute[1])
      } catch {
        return sendJson(res, 400, { error: 'Bad NVR id' })
      }
      const nvr = nvrs.get(id)
      if (!nvr) return sendJson(res, 404, { error: 'No such NVR' })
      if (!nvr.online) return sendJson(res, 409, { error: `${nvr.name} is ${nvr.status}; try again when it is online` })
      try {
        if (url.searchParams.get('discover')) {
          // ?cmds=a,b,c asks this NVR about command names we are still hunting for -- the disk
          // health one, for instance, which these boxes advertise as supportHDHealth without
          // saying what it is called. Only names beginning "query" are passed on: everything in
          // this dialect that changes the NVR is an "edit"/"set"/"add" command, so a read-only
          // hunt cannot become a write by way of a URL.
          const asked = (url.searchParams.get('cmds') ?? '')
            .split(',').map((s) => s.trim()).filter((s) => /^query[A-Za-z0-9]{1,48}$/.test(s)).slice(0, 40)
          return sendJson(res, 200, { id, answers: await discoverStorage(nvr, sdkQuery, asked.length ? asked : undefined) })
        }
        // ?smart=1 — which request shape queryDiskSmartInfo will actually accept
        if (url.searchParams.get('smart')) return sendJson(res, 200, { id, ...await probeSmart(nvr, sdkQuery) })
        return sendJson(res, 200, { id, storage: await readStorage(nvr, sdkQuery, Date.now) })
      } catch (e) {
        return sendJson(res, 502, { error: e.message })
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
            : what === 'lines'
              ? await handleLines(req.method, id, ch, url.searchParams, readJson, user)
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
    // The Lines panel's "Alert my phone for this camera": the camera joins or leaves the "Line
    // crossing" alarm rule, and the ntfy topic is made the first time one is switched on.
    if (pathname === '/api/admin/lines/alert') {
      const known = (id, ch) => Boolean(nvrs.get(id)?.channels.some((c) => c.ch === ch && c.configured !== false))
      const [status, body] = await handleLineAlert(req.method, () => readJsonObject(req, 1024), user, { knownCamera: known })
      return sendJson(res, status, body, status === 405 ? { allow: 'POST' } : {})
    }
    if (pathname === '/api/admin/alerts/test' && req.method === 'POST') {
      const { method } = await readJsonObject(req, 1024)
      if (!['ntfy', 'email', 'webhook'].includes(method)) return sendJson(res, 400, { error: 'method must be ntfy, email or webhook' })
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
    if (pathname === ADMIN_LINKS_PATH) {
      const answer = await handleCameraLinks(req.method, pathname, () => readJsonObject(req, LINKS_BODY_LIMIT), { admin: true, cameras: allCameras, maps: readMaps })
      if (answer) return sendJson(res, answer[0], answer[1], answer[2])
    }
    // (the RAM estimate: the NVRs' cameras, not a scan of the whole index; one small query per camera)
    const ramEstimate = () => estimateRecentRam({ index: recIndex(), settings: getSettings(), list: allCameras() })
    const settingsAnswer = await handleSettings(req.method, pathname, () => readJsonObject(req, 16384), user, AUTH_OFF || auth.isAdmin(user), { ramEstimate, params: url.searchParams })
    if (settingsAnswer) return sendJson(res, settingsAnswer[0], settingsAnswer[1], settingsAnswer[2])
    const readJson = async () => JSON.parse((await readBody(req, 8192)) || '{}')
    const [status, body] = await handleAdmin(req.method, pathname, readJson)
    return sendJson(res, status, body)
  }
  // The Health page: how the server is doing, for anyone signed in (see alert-checks.mjs health()).
  // An admin gets all of it; anyone else only the cameras they may see and those cameras' NVRs, by
  // name and state (health-view.mjs): no other camera, and no address, model or serial.
  if (pathname === '/api/health') {
    // plus remote viewing: what goes out over the internet, the levels remote viewers are on, and
    // what the video conversions cost (Health: "Remote viewing")
    const remote = adaptiveLive.summary()
    return sendJson(res, 200, healthFor({
      ...alerts.health(),
      viewing: {
        traffic: trafficSummary(),
        remote,
        conversions: {
          playback: { running: playbackTranscodes.active, cap: playbackTranscodes.max },
          remote: { running: remote.conversions, cap: remote.conversionCap },
          phones: { running: phoneLive.pool.active, cap: phoneLive.pool.max },
          cpu: ffmpegCpuPercent()
        }
      }
    }, { admin: who.admin, canSee }))
  }
  // an admin sees every NVR in full; anyone else only the sites they hold a grant on, by site, name
  // and status (rights.mjs sitesFor): never an NVR's address, P2P serial, model or serial number
  if (pathname === '/api/sites') return sendJson(res, 200, sitesFor(who, [...nvrs.values()].map((n) => n.info())))
  // only the cameras this user may watch live (rights.mjs; an admin sees all)
  if (pathname === '/api/cameras') return sendJson(res, 200, who.admin ? allCameras({ live: true }) : allCameras({ live: true }).filter((c) => can(who, 'live', { nvr: c.nvr, ch: c.ch })))
  // a map shows where cameras are and what they cover: only the sites and cameras this user may see
  // (maps.mjs mapsFor; a site is visible when one of its NVRs' cameras is)
  const siteVisible = (site) => [...nvrs.values()].some((n) => n.site === site && n.channels.some((c) => canSee(n.id, c.ch)))
  if (handleMapsRead(pathname, res, sendJson, SECURITY_HEADERS, who.admin ? null : { canSee, siteVisible })) return
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
    const id = url.searchParams.get('nvr') ?? ''
    if (pathname === '/api/playback/recordings') {
      // a camera's recordings on the NVR (an NVR search): only for a user who may play it back from
      // the NVR; server playback alone never reaches the NVR (rights.mjs)
      const target = { nvr: id, ch: Number(url.searchParams.get('ch')) }
      if (!can(who, 'playback-nvr', target)) return sendJson(res, 403, { error: 'You may not play back this camera from the NVR' })
    } else if (!canPlayAnyOn(who, id, nvrs.get(id)?.channels.map((c) => c.ch) ?? [])) {
      // /now and /dates: the NVR's clock and recording days, and an SDK call to it, for someone who
      // may play back at least one of its cameras (rights.mjs canPlayAnyOn)
      return sendJson(res, 403, { error: 'You may not play back from this NVR' })
    }
    // (503 with retryAfterS while the NVR is busy, see playback.mjs)
    const [status, body, headers] = await playbackApi(nvrs.get(url.searchParams.get('nvr') ?? ''), pathname, url.searchParams)
    return sendJson(res, status, body, headers)
  }
  serveFile(res, pathname, req)
}

const onRequest = (req, res) =>
  handleRequest(req, res).catch((e) => {
    console.error('request failed:', e)
    if (!res.headersSent) res.writeHead(500).end()
  })

// Browsers send /live, /playback and /motion only small JSON commands; ws's own default would take
// 100 MiB messages from any signed-in client (security audit 2026-09-27)
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
// /live-mux on a server of its own: a page sends it nothing over MAX_MESSAGE_BYTES, and ws refuses a
// bigger message (1009) from its header, before reading it.
const muxWss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
// ping every 15 s; a socket that misses a pong is terminated (backpressure.mjs)
keepAlive(wss)
keepAlive(muxWss)
// Every open video socket and mux channel is asked again while it is open (access-watch.mjs): soon
// after rights or accounts are saved or a session is signed out, and every SWEEP_MS. A camera taken
// away, an account removed or a sign-out ends what is already showing, not only the next one.
const watch = accessWatch({ currentUser, isAdmin: (u) => AUTH_OFF || auth.isAdmin(u), can })
onRightsSaved(watch.sweepSoon)
auth.onUsersChanged(watch.sweepSoon)
const onConnection = (ws, req) => {
  // A frame ws cannot parse (a text frame with invalid UTF-8, a bad opcode) is an 'error' event on
  // the socket, which then closes; with no listener Node treats it as unhandled and exits: one
  // signed-in client could take the whole server down (found in the /live-mux review, 2026-09-27)
  ws.on('error', () => {})
  const url = new URL(req.url, 'http://localhost')
  meterSocket(ws, req.socket.remoteAddress)
  // every live tile of a page on this one socket (live-mux.mjs)
  if (url.pathname === '/live-mux') {
    serveMux(ws, {
      // the session again on every "sub", as the upgrade checked it
      session: () => currentUser(req),
      attach: (channel, sub, user) => {
        const nvr = nvrs.get(sub.nvr)
        if (!nvr) return channel.close(1013, 'unknown NVR')
        // the rights as they are now, on every "sub"; a channel let in is watched while it is open
        // (attachLive tracks it), so a change also ends the tiles already playing
        const who = { user, admin: AUTH_OFF || auth.isAdmin(user) }
        attachLive(channel, req, { nvr, who, ch: sub.ch, streamType: sub.stream, clientH265: sub.h265, phone15: sub.fps === 15 })
      }
    })
    return
  }
  const nvr = nvrs.get(url.searchParams.get('nvr') ?? '')
  if (!nvr) {
    ws.close(1013, 'unknown NVR')
    return
  }
  const user = currentUser(req)
  const who = { user, admin: AUTH_OFF || auth.isAdmin(user) }
  const target = { nvr: nvr.id, ch: Number(url.searchParams.get('ch')) }
  if (url.pathname === '/playback') {
    // server recordings (src=auto) or the NVR as before; the "NVR offline" refusal is for NVR
    // sessions only (server playback runs without the NVR), see rec-playback.mjs. Either playback
    // right opens the socket; connectPlayback asks the right of the source it serves.
    if (!can(who, 'playback-server', target) && !can(who, 'playback-nvr', target)) return ws.close(1008, 'not allowed')
    // remote by live view's rule (live-attach.mjs): the socket's own address, where the Cloudflare
    // tunnel arrives from 127.0.0.1. Its server playback is converted to fit the tunnel.
    const session = connectPlayback({ nvr, ws, url, who, index: recIndex(), remote: isRemoteAddress(req.socket.remoteAddress) })
    // ...and for as long as it is open, the rights of what it plays (access-watch.mjs): the NVR's
    // recordings, or the server's and, when its gaps are filled from the NVR, the NVR's as well. A
    // socket connectPlayback refused is closing already and is not tracked.
    const auto = url.searchParams.get('src') === 'auto'
    watch.track(ws, req, { actions: !auto ? ['playback-nvr'] : session?.legs ? ['playback-server', 'playback-nvr'] : ['playback-server'], nvr: nvr.id, ch: target.ch })
    return
  }
  if (url.pathname === '/motion') {
    // motion search reads a camera's recordings on the NVR (its search and its playback): the same
    // right as playing them back from the NVR
    if (!can(who, 'playback-nvr', target)) return ws.close(1008, 'not allowed')
    if (!nvr.online) return ws.close(1013, 'NVR offline')
    // ...and while the search runs (access-watch.mjs)
    watch.track(ws, req, { actions: ['playback-nvr'], nvr: nvr.id, ch: target.ch })
    motionScan(nvr, ws, url)
    return
  }
  // /live (a missing ch reads as 0, a missing stream as 1, as always)
  attachLive(ws, req, {
    nvr,
    who,
    ch: target.ch,
    streamType: Number(url.searchParams.get('stream') ?? 1),
    clientH265: url.searchParams.get('h265') === '1',
    phone15: url.searchParams.get('fps') === '15'
  })
}
wss.on('connection', onConnection)
muxWss.on('connection', onConnection)
const phoneLive = new PhoneLive()
// each user's first screen of cameras, streaming before anyone opens Live (warm-streams.mjs)
startWarmStreams({
  cameras: () => allCameras({ live: true }),
  orders: allGridOrders,
  // every camera of an NVR with no refused stream in the last 10 minutes (warm-streams.mjs)
  roomy: (id) => {
    const n = nvrs.get(id)
    return Boolean(n?.liveOnline) && refusalsOf(n) === 0
  },
  streamOf: (id, ch) => {
    const n = nvrs.get(id)
    return n?.liveOnline ? n.getStream(ch, 1) : null
  }
})
const adaptiveLive = new AdaptiveLive({ pool: phoneLive.pool }) // one cap on conversions for phones and remote viewers together
// one viewer's live video, for /live and every /live-mux channel alike (live-attach.mjs)
const attachLive = liveAttacher({ can, currentUser, adaptiveLive, phoneLive, track: watch.track })

// This listener is synchronous and nothing above it catches: anything that throws here takes the
// whole process down. A malformed Cookie did exactly that, unauthenticated, until 2026-09-27
// (auth.mjs parseCookies). So the whole of it is guarded: whatever goes wrong refuses the socket.
const onUpgrade = (req, socket, head) => {
  try {
    upgrade(req, socket, head)
  } catch (e) {
    console.error('websocket upgrade refused:', e?.message ?? e)
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch {}
  }
}
const upgrade = (req, socket, head) => {
  // unparseable URLs and Origins (e.g. "Origin: null") are refused, not thrown.
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
  if (!['/live', '/live-mux', '/playback', '/motion'].includes(url.pathname) || !sameOrigin || !currentUser(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return
  }
  const server = url.pathname === '/live-mux' ? muxWss : wss
  server.handleUpgrade(req, socket, head, (ws) => server.emit('connection', ws, req))
}

const httpServer = createServer(onRequest)
httpServer.on('upgrade', onUpgrade)
// Reports (reports.mjs): made in their own thread, kept a few minutes (a page re-opened, the daily
// summary and the page asking for the same day) so the database is not counted again for nothing
const reportCache = new Map() // period -> { at, rep }
async function reportFor(period) {
  const hit = reportCache.get(period)
  const keepMs = period === 'today' ? 60_000 : 5 * 60_000
  if (hit && Date.now() - hit.at < keepMs) return hit.rep
  const w = periodWindow(period)
  const counts = await countInThread(REC_DB, w.fromMs, w.toMs)
  const rep = composeReport({ counts, cameras: allCameras(), fromMs: w.fromMs, toMs: w.toMs, storageHistory: readHistory(auth.DATA_DIR), alerts: readAlerts(auth.DATA_DIR, w.fromMs), label: w.label, locationNames: Object.fromEntries((getSettings().storage?.locations ?? []).map((l) => [l.id, l.path])) })
  reportCache.set(period, { at: Date.now(), rep })
  return rep
}
// yesterday's report at 07:00 site time through the alert channels (ntfy, webhooks), unless switched off
{
  const reportSender = makeSender({ settings: () => getSettings().alerts ?? {}, log: console.log })
  startDailySummary({
    dataDir: auth.DATA_DIR,
    buildYesterday: () => reportFor('yesterday'),
    deliver: (alerts, kind) => reportSender.deliver(alerts, kind),
    enabled: () => getSettings().alerts?.dailySummary !== false && Boolean(getSettings().alerts?.ntfy?.topic || getSettings().alerts?.webhooks?.length)
  })
}
// the site's wall clock (backfill window, alarm schedules, reports): the NVRs' own time zone
useSiteOffset(() => commonOffset(zoneOffsets()))
// every link between app files carries this release, so no cache (Cloudflare's 4 h among them)
// can hand a browser an old or mixed set of files after a deploy (static-files.mjs)
setAssetStamp(RELEASE)
warmFiles(PUBLIC_DIR, MIME)
httpServer.listen(Number(HTTP_PORT), () => console.log(`HTTP  on port ${HTTP_PORT} (use http://localhost on this PC)`))

const certHosts = CERT_HOSTS.split(',').map((h) => h.trim()).filter(Boolean)
const httpsServer = createHttpsServer(httpsOptions(certHosts), onRequest)
httpsServer.on('upgrade', onUpgrade)
httpsServer.listen(Number(HTTPS_PORT), () => console.log(`HTTPS on port ${HTTPS_PORT} (for other PCs and phones)`))

if (Object.keys(auth.loadUsers()).length === 0) {
  console.warn('No viewer accounts yet. Create one with: docker exec -it tvt-cctv node cctv/adduser.mjs <name>')
}

const shutdown = async () => {
  // a clean logout is nice but must not hang; SIGKILL avoids exit() waiting on stuck SDK threads
  // (9 s: the NVR workers get 8 s to close their segments and log out; the unit allows 15)
  await Promise.race([stopNvrs().catch(() => {}), new Promise((r) => setTimeout(r, 9000))])
  process.kill(process.pid, 'SIGKILL')
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
