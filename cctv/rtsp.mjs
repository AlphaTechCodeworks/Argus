// Camera links (RTSP): any camera Argus sees -- P2P-only sites included -- for outside programs (VLC,
// another VMS, an OCR engine), as rtsp://<server>:8554/<path>, with access keys an admin makes.
//
//   outside program --RTSP--> MediaMTX (child of Argus, rtsp-server.mjs) --asks--> POST /internal/rtsp-auth
//        (first reader of a path) MediaMTX runs ffmpeg --GET /internal/rtsp-feed--> Argus: the camera's
//        own frames from its hub stream (no extra NVR login), as MPEG-TS (ts-mux.mjs); ffmpeg copies
//        them (no re-encode) into MediaMTX, which hands them to every reader of that path. ~10 s after
//        the last reader leaves, MediaMTX stops ffmpeg and Argus leaves the stream.
//
// Paths (rtsp-core.mjs): <nvr id>/<camera number> is the sub-stream, <nvr id>/<camera number>/main the
// main stream. A main counts against the recorder's full-quality limit like a viewer's (main-limit.mjs).
// <nvr id>/<camera number>/1080 is the main stream converted to H.264 at most 1920x1080 (for old PCs
// and OCR tools that cannot decode 4K H.265 fast enough): the same right and limit as /main, its ffmpeg
// re-encodes (rtsp-core.mjs convertCommand, one per camera however many read it), and at most
// CCTV_RTSP_1080_MAX (default 2, 0 = none) run at once, as each costs a core or two.
//
// The /internal/* routes answer only this machine (no Cloudflare header) carrying this boot's random
// secret, which only Argus and its children know. Publishing into MediaMTX is the same: loopback and
// the secret. The secret is in the config file (DATA_DIR/rtsp/mediamtx.yml, 0600) and on ffmpeg's
// command line.
//
// Admin routes (server.mjs checks admin, same origin and JSON first):
//   GET  /api/admin/rtsp   -> { enabled, envOff, status, port, hosts, feeds, readers, keys, cameras }
//   POST /api/admin/rtsp   { action: 'enable', on }                     -> the same
//                          { action: 'create', name, cameras: 'all'|["<nvr>/<ch>"], main } -> { key, password, ... }
//                          { action: 'link', nvr, ch, turnOn? }        -> the one-click link for a camera
//                          { action: 'revoke', id }                     -> the same as GET
// Keys and the switch: DATA_DIR/rtsp.json (atomic, 0600). Off unless switched on; CCTV_RTSP=off keeps it off.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomicSync } from './atomic-write.mjs'
import { mayOpenMain, maxViewerMains } from './main-limit.mjs'
import { DEFAULT_PORT, buildConfig, cameraKey, camerasOfKey, checkNewKey, convertCommand, convertMaxOf, dayOf, decide, failureLimit, feedCommand, hookCommand, makeKey, parsePath, pathOf, publicKey } from './rtsp-core.mjs'
import { MEDIAMTX_VERSION, findBinary, makeRtspServer } from './rtsp-server.mjs'
import { TsMuxer } from './ts-mux.mjs'

export const ADMIN_PATH = '/api/admin/rtsp'
export const AUTH_PATH = '/internal/rtsp-auth'
export const FEED_PATH = '/internal/rtsp-feed'
export const EVENT_PATH = '/internal/rtsp-event'
const HEADER = 16 // sdk.mjs encodeFrame: key flag, codec, ..., time (us); then the Annex-B payload
const SAVE_EVERY_MS = 10 * 60_000 // a key's last use is written at most this often (and on a new day)

/** The server's own addresses an outside program can reach: private LAN ones first. */
export function hostAddresses(ifaces = networkInterfaces(), extra = []) {
  const out = []
  for (const list of Object.values(ifaces ?? {})) {
    for (const a of list ?? []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address)
  }
  const rank = (ip) => (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 0 : /^100\./.test(ip) ? 1 : 2)
  out.sort((a, b) => rank(a) - rank(b))
  return [...new Set([...out, ...extra.filter(Boolean)])]
}

/** The stored file, read: { enabled, keys }. A missing or damaged file is "off, no keys". */
export function readStore(file) {
  try {
    if (!existsSync(file)) return { enabled: false, keys: [] }
    const s = JSON.parse(readFileSync(file, 'utf8'))
    return { enabled: s?.enabled === true, keys: Array.isArray(s?.keys) ? s.keys.filter((k) => k && typeof k.user === 'string' && typeof k.hash === 'string') : [] }
  } catch {
    return { enabled: false, keys: [] }
  }
}

/**
 * @param {{ dataDir: string, appDir: string, httpPort: number|string, nvrs: Map<string, object>,
 *   mainLimit: { ask: Function, leave: Function, cameras: Function }, audit?: (row: object) => void,
 *   log?: (line: string) => void, env?: object, hosts?: () => string[], server?: object, now?: () => number,
 *   nodePath?: string }} o
 */
export function makeRtsp({ dataDir, appDir, httpPort, nvrs, mainLimit, audit = () => {}, log = (l) => console.log(l), env = process.env, hosts = () => hostAddresses(), server = null, now = Date.now, nodePath = process.execPath }) {
  const file = join(dataDir, 'rtsp.json')
  const dir = join(dataDir, 'rtsp')
  const configFile = join(dir, 'mediamtx.yml')
  const secret = randomBytes(24).toString('hex') // this boot's
  const envOff = env.CCTV_RTSP === 'off'
  const port = (() => { const n = Number(env.CCTV_RTSP_PORT); return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT })()
  // TCP only unless CCTV_RTSP_UDP=on: over UDP a lost packet of a big stream smears the picture grey
  // until the next keyframe (2026-10-16: the container reader on the test PC pulled Lawrence 14 in 4K
  // H.265 over UDP, grey and broken, while the app's own view was perfect). Offered only TCP, a program
  // asking for UDP is told so (461) and asks again over TCP by itself (ffmpeg, VLC and OpenCV do).
  const udp = env.CCTV_RTSP_UDP === 'on'
  const ffmpeg = env.CCTV_FFMPEG || 'ffmpeg'
  const convertMax = convertMaxOf(env)
  let store = readStore(file)
  let lastSaved = 0
  const feeds = new Map() // path -> { path, nvr, ch, main, variant, since, frames, bytes }
  const readers = new Map() // path -> Set(reader id)
  const failures = failureLimit({ now })
  const base = `http://127.0.0.1:${httpPort}`

  const save = () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileAtomicSync(file, `${JSON.stringify({ version: 1, enabled: store.enabled, keys: store.keys }, null, 2)}\n`)
    lastSaved = now()
  }

  const writeConfig = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const yml = buildConfig({
      port,
      udp,
      authUrl: `${base}${AUTH_PATH}?s=${secret}`,
      feedCommand: feedCommand({ ffmpeg, feedUrl: `${base}${FEED_PATH}`, rtspPort: port, secret }),
      convertCommand: convertMax > 0 ? convertCommand({ ffmpeg, feedUrl: `${base}${FEED_PATH}`, rtspPort: port, secret }) : '',
      onRead: hookCommand({ node: nodePath, script: join(appDir, 'cctv', 'rtsp-hook.mjs'), url: `${base}${EVENT_PATH}`, secret, event: 'read' }),
      onUnread: hookCommand({ node: nodePath, script: join(appDir, 'cctv', 'rtsp-hook.mjs'), url: `${base}${EVENT_PATH}`, secret, event: 'unread' })
    })
    writeFileAtomicSync(configFile, yml)
    readers.clear() // a (re)started server has no readers yet
  }

  const rtspServer = server ?? makeRtspServer({ binary: () => findBinary({ env, appDir, dataDir }), configFile, cwd: dataDir, prepare: writeConfig, log })

  const camera = (nvrId, ch) => nvrs.get(nvrId)?.channels?.find((c) => c.ch === ch && c.configured !== false) ?? null
  const known = (nvrId, ch) => Boolean(camera(nvrId, ch))
  const mainRoom = (nvrId, ch) => {
    if (feeds.has(pathOf(nvrId, ch, true)) || feeds.has(pathOf(nvrId, ch, '1080'))) return true
    const nvr = nvrs.get(nvrId)
    return mayOpenMain(mainLimit.cameras(nvrId), `${nvrId}/${ch + 1}`, maxViewerMains(nvr))
  }
  const converting = () => [...feeds.values()].filter((f) => f.variant === '1080').length
  /** Whether a 1080p conversion of this camera may start now: true, or why not (said to the program's log line). */
  const convertRoom = (nvrId, ch) => {
    if (convertMax === 0) return '1080p is switched off on this server (CCTV_RTSP_1080_MAX=0)'
    if (feeds.has(pathOf(nvrId, ch, '1080'))) return true // (already converted: one more reader costs nothing)
    const n = converting()
    return n < convertMax ? true : `1080p not available now: ${n} of ${convertMax} conversions already running`
  }
  const allCameras = () => [...nvrs.values()].flatMap((n) => (n.channels ?? []).filter((c) => c.configured !== false).map((c) => ({ nvr: n.id, ch: c.ch, name: c.name, site: n.site, nvrName: n.name, p2p: Boolean(n.cfg?.sn), path: pathOf(n.id, c.ch), mainPath: pathOf(n.id, c.ch, true), path1080: convertMax > 0 ? pathOf(n.id, c.ch, '1080') : null })))

  const readerCount = () => [...readers.values()].reduce((n, s) => n + s.size, 0)
  const status = () => ({ ...rtspServer.status(), version: MEDIAMTX_VERSION })
  const view = () => ({ enabled: store.enabled, envOff, status: status(), port, udp, hosts: hosts(), feeds: feeds.size, converting: converting(), convertMax, readers: readerCount(), keys: store.keys.map(publicKey), cameras: allCameras() })

  const sync = () => {
    if (store.enabled && !envOff) rtspServer.start()
    else rtspServer.stop()
  }

  /** The body of a JSON POST from MediaMTX or the hook (small). */
  const body = (req, limit = 8192) =>
    new Promise((resolve) => {
      let s = ''
      req.on('data', (c) => {
        s += c
        if (s.length > limit) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(s || '{}'))
        } catch {
          resolve(null)
        }
      })
      req.on('error', () => resolve(null))
    })

  const used = (key, ask) => {
    const t = now()
    const before = key.lastUsedAt
    key.lastUsedAt = t
    key.lastUsedIp = String(ask.ip ?? '').slice(0, 64)
    const newDay = !before || dayOf(before) !== dayOf(t)
    if (newDay) audit({ user: `camera link: ${key.name}`, action: 'camera-link-use', target: String(ask.path ?? ''), ip: key.lastUsedIp, detail: `key ${key.user}, first use today` })
    if (newDay || t - lastSaved > SAVE_EVERY_MS) {
      try {
        save()
      } catch (e) {
        log(`[rtsp] could not save the keys' last use: ${e?.message ?? e}`)
      }
    }
  }

  async function onAuth(req, res) {
    const ask = await body(req)
    if (!ask) return res.writeHead(400).end()
    const ip = String(ask.ip ?? '')
    if (ask.action === 'read' && ask.user && failures.blocked(ip)) {
      return res.writeHead(401).end()
    }
    const d = decide(ask, { secret, keys: store.keys, known, mainRoom, convertRoom })
    if (d.ok) {
      if (d.key) used(d.key, ask)
      return res.writeHead(200).end()
    }
    if (d.failed) failures.fail(ip)
    if (!d.ask) log(`[rtsp] refused ${ask.action} ${String(ask.path ?? '').slice(0, 80)} from ${ip.slice(0, 64)}${d.key ? ` (key "${d.key.name}")` : ask.user ? ` (user ${String(ask.user).slice(0, 40)})` : ''}: ${d.why}`)
    res.writeHead(401).end()
  }

  async function onEvent(req, res) {
    const e = await body(req, 2048)
    const path = parsePath(e?.path) ? e.path : null
    if (!path || !['read', 'unread'].includes(e.event)) return res.writeHead(400).end()
    const id = String(e.id ?? '').slice(0, 80) || `?${now()}`
    if (e.event === 'read') {
      if (!readers.has(path)) readers.set(path, new Set())
      readers.get(path).add(id)
    } else {
      readers.get(path)?.delete(id)
      if (readers.get(path)?.size === 0) readers.delete(path)
    }
    res.writeHead(204).end()
  }

  function onFeed(req, res, url) {
    const path = url.searchParams.get('path') ?? ''
    const p = parsePath(path)
    if (!p) return res.writeHead(400).end('bad path')
    const nvr = nvrs.get(p.nvr)
    if (!nvr || !known(p.nvr, p.ch)) return res.writeHead(404).end('no such camera')
    if (!nvr.liveOnline) return res.writeHead(503).end('NVR offline')
    if (feeds.has(path)) log(`[rtsp] ${path}: a second feed asked for while one runs; the RTSP server replaces the first`)
    if (p.variant === '1080') {
      // (asked again here: two cameras let in at once by the RTSP server could both start)
      const room = convertRoom(p.nvr, p.ch)
      if (room !== true) {
        log(`[rtsp] ${path}: ${room}`)
        return res.writeHead(503).end(room)
      }
    }
    const feed = { path, nvr: p.nvr, ch: p.ch, main: p.main, variant: p.variant, since: now(), frames: 0, bytes: 0 }
    if (p.main) {
      let got = true
      try {
        got = mainLimit.ask(nvr, p.ch, feed)
      } catch {}
      if (got !== true) {
        log(`[rtsp] ${path}: full quality refused: ${got}`)
        return res.writeHead(503).end(String(got))
      }
    }
    const stream = nvr.getStream(p.ch, p.main ? 0 : 1)
    const mux = new TsMuxer()
    let ended = false
    const tap = {
      OPEN: 1,
      get readyState() {
        return ended || res.destroyed ? 3 : 1
      },
      get bufferedAmount() {
        return res.writableLength
      },
      replayMaxBytes: Infinity, // (loopback: ffmpeg learns the stream from the whole GOP at once)
      terminate: () => res.destroy(),
      close: () => res.destroy(),
      send(buf) {
        if (ended || !(buf instanceof Uint8Array) || buf.length <= HEADER) return
        if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.length)
        let out
        try {
          out = mux.frame(buf.subarray(HEADER), { isKey: buf[0] === 1, codec: buf[1] === 1 ? 'h265' : 'h264', tsMs: Number(buf.readBigInt64LE(8)) / 1000 })
        } catch (e) {
          log(`[rtsp] ${path}: ${e.message}; feed restarted`)
          return res.destroy()
        }
        if (!out) return
        feed.frames++
        feed.bytes += out.length
        res.write(out)
      }
    }
    // (frames reach the tap through the hub's fan-out, which holds back a feed over its cap and cuts
    // one stuck there for 30 s: backpressure.mjs gateSend, with terminate above)
    res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store' })
    feeds.set(path, feed)
    log(`[rtsp] feeding ${path} (${p.variant === '1080' ? 'main stream, converted to 1080p H.264' : p.main ? 'main stream' : 'sub-stream'})`)
    const end = () => {
      if (ended) return
      ended = true
      try {
        stream.remove(tap)
      } catch {}
      if (p.main) {
        try {
          mainLimit.leave(feed)
        } catch {}
      }
      if (feeds.get(path) === feed) feeds.delete(path)
      log(`[rtsp] ${path} feed ended after ${Math.round((now() - feed.since) / 1000)} s, ${feed.frames} frames`)
    }
    res.on('close', end)
    stream.add(tap)
  }

  /** Answers /internal/*; true when it was one of them. local: the request came from this machine. */
  async function handleInternal(req, res, url, { local }) {
    if (![AUTH_PATH, FEED_PATH, EVENT_PATH].includes(url.pathname)) return false
    if (!local || url.searchParams.get('s') !== secret) {
      res.writeHead(403).end()
      return true
    }
    if (url.pathname === FEED_PATH) {
      if (req.method !== 'GET') return res.writeHead(405).end(), true
      onFeed(req, res, url)
      return true
    }
    if (req.method !== 'POST') return res.writeHead(405).end(), true
    if (url.pathname === AUTH_PATH) await onAuth(req, res)
    else await onEvent(req, res)
    return true
  }

  const makeOne = (fields, who, meta) => {
    const { key, password } = makeKey(fields, { by: who.user, now: now() })
    store = { ...store, keys: [...store.keys, key] }
    save()
    audit({ user: who.user, action: 'camera-link', target: key.name, detail: `key ${key.user} made: ${fields.cameras === 'all' ? 'all cameras' : `${fields.cameras.length} camera${fields.cameras.length === 1 ? '' : 's'}`}${fields.main ? ', full quality too' : ', standard picture only'}${meta?.device ? `; device: ${meta.device}` : ''}`, ip: meta?.ip ?? '' })
    log(`[rtsp] ${who.user} made key "${key.name}" (${key.user})`)
    return { key: publicKey(key), password, linkCameras: camerasOfKey(key, allCameras()), port, hosts: hosts() }
  }

  const setEnabled = (on, who, meta) => {
    if (store.enabled === on) return
    store = { ...store, enabled: on }
    save()
    audit({ user: who.user, action: 'camera-link', target: 'service', detail: `camera links (RTSP) switched ${on ? 'on' : 'off'}${meta?.device ? `; device: ${meta.device}` : ''}`, ip: meta?.ip ?? '' })
    log(`[rtsp] switched ${on ? 'on' : 'off'} by ${who.user}`)
    sync()
  }

  /**
   * The admin routes. @returns {Promise<[number, object]|null>}
   * @param {{ user: string, admin: boolean }} who @param {{ ip?: string, device?: string }} [meta]
   */
  async function handleAdmin(method, pathname, readJson, who, meta = {}) {
    if (pathname !== ADMIN_PATH) return null
    if (!who?.admin) return [403, { error: 'Admins only' }]
    if (method === 'GET') return [200, view()]
    if (method !== 'POST') return [405, { error: 'Method not allowed' }]
    let b
    try {
      b = await readJson()
    } catch {
      return [400, { error: 'Bad request' }]
    }
    try {
      if (b.action === 'enable') {
        if (b.on === true && envOff) return [409, { error: 'Camera links are switched off on this server (CCTV_RTSP=off).' }]
        setEnabled(b.on === true, who, meta)
        return [200, view()]
      }
      if (b.action === 'create') {
        const f = checkNewKey(b, { known, count: store.keys.length })
        if (f.error) return [400, { error: f.error }]
        return [200, { ...makeOne(f, who, meta), ...view() }]
      }
      if (b.action === 'link') {
        // the one-click link for a camera (Live's full-size view, the camera's page under Sites): a
        // key of its own for that camera alone, standard picture and full quality, its password shown
        // this once in the address
        const ch = Number(b.ch)
        const nvrId = String(b.nvr ?? '')
        const cam = Number.isInteger(ch) ? camera(nvrId, ch) : null
        if (!cam) return [404, { error: 'No such camera' }]
        const st = status()
        if (envOff) return [200, { ready: false, why: 'off-here', message: 'Camera links are switched off on this server (CCTV_RTSP=off).' }]
        if (!st.installed) return [200, { ready: false, why: 'not-installed', message: 'The RTSP server is not installed on this machine yet (deploy/install-mediamtx.sh).' }]
        if (!store.enabled) {
          if (b.turnOn !== true) return [200, { ready: false, why: 'off', message: 'Camera links are off.' }]
          setEnabled(true, who, meta)
        }
        const n = nvrs.get(nvrId)
        const name = `${cam.name || `Camera ${ch + 1}`} (${n?.name || nvrId})`.slice(0, 60)
        const made = makeOne({ name, cameras: [cameraKey(nvrId, ch)], main: true, camera: cameraKey(nvrId, ch) }, who, meta)
        const earlier = store.keys.filter((k) => k.camera === cameraKey(nvrId, ch) && k.id !== made.key.id).length
        return [200, { ready: true, ...made, path: pathOf(nvrId, ch), mainPath: pathOf(nvrId, ch, true), path1080: convertMax > 0 ? pathOf(nvrId, ch, '1080') : null, p2p: Boolean(n?.cfg?.sn), earlier }]
      }
      if (b.action === 'revoke') {
        const k = store.keys.find((x) => x.id === b.id)
        if (!k) return [404, { error: 'No such key' }]
        store = { ...store, keys: store.keys.filter((x) => x !== k) }
        save()
        audit({ user: who.user, action: 'camera-link', target: k.name, detail: `key ${k.user} revoked${meta?.device ? `; device: ${meta.device}` : ''}`, ip: meta?.ip ?? '' })
        log(`[rtsp] ${who.user} revoked key "${k.name}" (${k.user})`)
        // MediaMTX asks only when a program connects: one already reading on this key is cut off by
        // starting the server again (the others reconnect by themselves, with their own keys)
        if (readerCount() > 0 && rtspServer.status().running) rtspServer.restart()
        return [200, view()]
      }
      return [400, { error: 'action must be enable, create, link or revoke' }]
    } catch (e) {
      log(`[rtsp] admin action failed: ${e?.message ?? e}`)
      return [500, { error: `Could not save: ${e?.message ?? e}` }]
    }
  }

  return {
    start: sync,
    stop: () => rtspServer.stop(),
    handleInternal,
    handleAdmin,
    /** For /healthz and the metrics minute line. */
    summary: () => {
      const st = rtspServer.status()
      return { enabled: store.enabled && !envOff, installed: st.installed, running: st.running, feeds: feeds.size, converting: converting(), readers: readerCount() }
    },
    // (tests)
    secret,
    feeds,
    readers,
    configFile
  }
}
