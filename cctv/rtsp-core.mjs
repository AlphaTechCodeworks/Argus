// Camera links (RTSP): the pure parts. Paths, the RTSP server's config, access keys and the answer to
// each "may this connection do this?" the RTSP server asks. No sockets, no files, no clock of its own:
// rtsp.mjs wires them up, and test/rtsp-core.test.mjs tests them.
//
// Paths, as outside programs see them (rtsp://<server>:8554/<path>):
//   <nvr id>/<camera number>        the camera's sub-stream (light: what a grid shows)
//   <nvr id>/<camera number>/main   its main stream (full quality), where the key allows it
//   <nvr id>/<camera number>/1080   its main stream converted to H.264, at most 1920x1080 and 20 fps:
//                                   lighter to decode (an old PC without H.265 hardware, an OCR tool),
//                                   still sharp enough to read text. Needs the same right as /main.
// The camera number counts from 1, as the pages show it ("nvr-2/5" is the 5th camera of nvr-2);
// inside the app a camera is "<nvr id>/<ch>" with ch from 0 (steady.mjs, user-prefs.mjs).
//
// Access keys: a user name ("cam-" and 8 hex digits) and a password (32 random bytes, base64url). Only
// the password's SHA-256 is kept: a 256-bit random secret needs no slow hash (scrypt is for passwords
// people choose), and the RTSP server asks again on every connection. The password is shown once,
// when the key is made; lost, the key is revoked and a new one made.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const DEFAULT_PORT = 8554
/** The RTSP server's own user for the feeds Argus publishes into it (loopback only, per-boot password). */
export const FEED_USER = 'argus-feed'
const NVR_ID = '[A-Za-z0-9._-]{1,64}'
const PATH_RE = new RegExp(`^(${NVR_ID})/([1-9][0-9]{0,3})(/main|/1080)?$`)
/** The RTSP server's pattern for the copied camera paths (a regular expression path, MediaMTX's "~" form). */
export const PATH_PATTERN = `~^${NVR_ID}/[1-9][0-9]{0,3}(/main)?$`
/** ...and for the converted ones (<nvr>/<camera>/1080), fed by convertCommand. */
export const PATH_PATTERN_1080 = `~^${NVR_ID}/[1-9][0-9]{0,3}/1080$`
/** How many 1080p conversions may run at once unless CCTV_RTSP_1080_MAX says otherwise (0: none). */
export const CONVERT_MAX_DEFAULT = 2
export const MAX_KEYS = 200
export const MAX_NAME = 60
export const MAX_KEY_CAMERAS = 512
const CAMERA_KEY_RE = /^[A-Za-z0-9._-]{1,64}\/\d{1,4}$/

/**
 * "nvr-2/5/main" -> { nvr: 'nvr-2', ch: 4, main: true, variant: 'main' }, or null for anything else.
 * variant: 'sub', 'main' or '1080'; main is true for '1080' too (it is made from the main stream, so
 * it needs the key's full-quality right and counts against the recorder's main-stream limit).
 */
export function parsePath(path) {
  const m = PATH_RE.exec(String(path ?? ''))
  if (!m) return null
  const n = Number(m[2])
  const variant = m[3] ? m[3].slice(1) : 'sub'
  return { nvr: m[1], ch: n - 1, main: variant !== 'sub', variant }
}

/** The path of a camera (ch from 0); variant: false or 'sub', true or 'main', or '1080'. */
export const pathOf = (nvr, ch, variant = false) => `${nvr}/${ch + 1}${variant === true || variant === 'main' ? '/main' : variant === '1080' ? '/1080' : ''}`

/** How many 1080p conversions may run at once: CCTV_RTSP_1080_MAX (a whole number, 0 = none), else the default. */
export function convertMaxOf(env = {}) {
  const v = env.CCTV_RTSP_1080_MAX
  const n = Number(v)
  return v !== undefined && v !== '' && Number.isInteger(n) && n >= 0 ? n : CONVERT_MAX_DEFAULT
}

/** The URL a program connects to; the password only when it is known (at creation). */
export function rtspUrl({ host, port = DEFAULT_PORT, user, password = null, path }) {
  const h = /:/.test(host) && !/^\[/.test(host) ? `[${host}]` : host
  const auth = user ? `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ''}@` : ''
  return `rtsp://${auth}${h}:${port}/${path}`
}

export const isLoopback = (ip) => /^(127\.|::1$|::ffff:127\.)/.test(String(ip ?? ''))

// ---- the RTSP server's config ----

const q = (s) => JSON.stringify(String(s)) // a YAML double-quoted string is a JSON string

/**
 * MediaMTX's config, as YAML. Only RTSP is on (TCP, and UDP unless udp is false); RTMP, HLS, WebRTC,
 * SRT, MoQ, the API, metrics, pprof and playback are all off. Every connection is put to Argus
 * (authHTTPAddress). Only the camera paths exist, each fed on demand by feedCommand (the /1080 ones by
 * convertCommand, when given: without it they do not exist) and stopped closeAfterS after its last
 * reader; readers are told to Argus by the hooks.
 * @param {{ port?: number, udp?: boolean, rtpPort?: number, authUrl: string, feedCommand: string,
 *   convertCommand?: string, onRead?: string, onUnread?: string, closeAfterS?: number,
 *   startTimeoutS?: number, logLevel?: string }} o
 */
export function buildConfig({ port = DEFAULT_PORT, udp = true, rtpPort = 8000, authUrl, feedCommand, convertCommand = '', onRead = '', onUnread = '', closeAfterS = 10, startTimeoutS = 20, logLevel = 'info' }) {
  if (!authUrl || !feedCommand) throw new Error('authUrl and feedCommand are needed')
  const lines = [
    '# Written by Argus (rtsp.mjs) at every start: edits here are lost.',
    `logLevel: ${logLevel}`,
    'logDestinations: [stdout]',
    'readTimeout: 10s',
    'writeTimeout: 10s',
    'writeQueueSize: 512',
    'authMethod: http',
    `authHTTPAddress: ${q(authUrl)}`,
    'authHTTPExclude: []',
    'api: false',
    'metrics: false',
    'pprof: false',
    'playback: false',
    'rtsp: true',
    `rtspTransports: [${udp ? 'udp, tcp' : 'tcp'}]`,
    'rtspEncryption: "no"',
    `rtspAddress: :${port}`,
    `rtpAddress: :${rtpPort}`,
    `rtcpAddress: :${rtpPort + 1}`,
    'rtspAuthMethods: [basic]',
    'rtmp: false',
    'hls: false',
    'webrtc: false',
    'srt: false',
    'moq: false',
    'paths:'
  ]
  const path = (pattern, command) => [
    `  ${q(pattern)}:`,
    '    source: publisher',
    '    overridePublisher: true',
    `    runOnDemand: ${q(command)}`,
    '    runOnDemandRestart: true',
    `    runOnDemandStartTimeout: ${startTimeoutS}s`,
    `    runOnDemandCloseAfter: ${closeAfterS}s`,
    `    runOnRead: ${q(onRead)}`,
    `    runOnUnread: ${q(onUnread)}`
  ]
  lines.push(...path(PATH_PATTERN, feedCommand))
  if (convertCommand) lines.push(...path(PATH_PATTERN_1080, convertCommand))
  return `${lines.join('\n')}\n`
}

/**
 * A command line argument, quoted for MediaMTX's own splitting (shell-like) when it needs it. A "$"
 * is left as it is: MediaMTX fills in $MTX_PATH and the like in the command before splitting it.
 */
export const arg = (s) => (/^[A-Za-z0-9_@%+=:,./$-]+$/.test(String(s)) ? String(s) : `"${String(s).replace(/(["\\])/g, '\\$1')}"`)

/**
 * The command that feeds one path: ffmpeg reads the camera from Argus's loopback feed (MPEG-TS,
 * ts-mux.mjs) and publishes it, copied, into the RTSP server. $MTX_PATH is filled in by MediaMTX.
 */
export function feedCommand({ ffmpeg = 'ffmpeg', feedUrl, rtspPort = DEFAULT_PORT, secret }) {
  return [
    arg(ffmpeg), '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-probesize', '5000000', '-analyzeduration', '3000000',
    '-f', 'mpegts', '-i', arg(`${feedUrl}?path=$MTX_PATH&s=${secret}`),
    '-map', '0:v:0', '-c', 'copy',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', arg(`rtsp://${FEED_USER}:${secret}@127.0.0.1:${rtspPort}/$MTX_PATH`)
  ].join(' ')
}

/**
 * The /1080 paths' settings. superfast rather than veryfast: on an i7-3770 with a 3840x2160 H.265
 * 20 fps source, the whole conversion took 12-19 % less CPU and only superfast kept up with real time
 * on these threads; at CRF 23 a 1080p picture is still plainly sharp for text. maxrate caps a busy or
 * noisy (night) picture. Exported for the tests.
 */
export const CONVERT = Object.freeze({
  maxWidth: 1920,
  maxHeight: 1080,
  maxFps: 20,
  preset: 'superfast',
  crf: 23,
  maxrate: '6M',
  bufsize: '12M', // two seconds at maxrate
  keyEveryS: 1,
  decodeThreads: 2,
  encodeThreads: 2
})

/**
 * The command that feeds one /1080 path: like feedCommand (Argus serves the camera's main stream for
 * it), but decoded, scaled down to fit 1920x1080 (aspect kept, never enlarged), held to at most 20 fps
 * (a slower camera keeps its own rate: no repeated frames), and encoded as H.264 (8-bit 4:2:0, no
 * B-frames, a keyframe every second) on few threads, so one conversion cannot take the whole machine.
 * Most of its cost is decoding the 4K H.265 (the server has no GPU).
 */
export function convertCommand({ ffmpeg = 'ffmpeg', feedUrl, rtspPort = DEFAULT_PORT, secret }) {
  const c = CONVERT
  const scale = `scale='min(${c.maxWidth},iw)':'min(${c.maxHeight},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`
  return [
    arg(ffmpeg), '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-probesize', '5000000', '-analyzeduration', '3000000',
    '-threads', String(c.decodeThreads),
    '-f', 'mpegts', '-i', arg(`${feedUrl}?path=$MTX_PATH&s=${secret}`),
    '-map', '0:v:0',
    '-filter_threads', '1', '-vf', arg(scale), '-fpsmax', String(c.maxFps),
    '-c:v', 'libx264', '-preset', c.preset, '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-crf', String(c.crf), '-maxrate', c.maxrate, '-bufsize', c.bufsize,
    '-force_key_frames', arg(`expr:gte(t,n_forced*${c.keyEveryS})`),
    '-threads', String(c.encodeThreads),
    '-f', 'rtsp', '-rtsp_transport', 'tcp', arg(`rtsp://${FEED_USER}:${secret}@127.0.0.1:${rtspPort}/$MTX_PATH`)
  ].join(' ')
}

/** The command that tells Argus a reader came or went. */
export const hookCommand = ({ node, script, url, secret, event }) => [arg(node), arg(script), event, arg(url), arg(secret)].join(' ')

// ---- access keys ----

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex')

/** A camera key "<nvr>/<ch>" (ch from 0), or null. */
export const cameraKey = (nvr, ch) => `${nvr}/${ch}`

/**
 * A new key's fields from what the admin asked for, or an error message. cameras: 'all', or a list of
 * "<nvr>/<ch>" (ch from 0) among the cameras known.
 * @param {{ name?: unknown, cameras?: unknown, main?: unknown }} body
 * @param {{ known: (nvr: string, ch: number) => boolean, count: number }} o
 */
export function checkNewKey(body, { known, count }) {
  if (count >= MAX_KEYS) return { error: `There are already ${MAX_KEYS} keys: revoke some first` }
  const name = String(body?.name ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_NAME)
  if (!name) return { error: 'Give the key a name (who or what will use it)' }
  let cameras
  if (body?.cameras === 'all') cameras = 'all'
  else if (Array.isArray(body?.cameras)) {
    if (body.cameras.length === 0) return { error: 'Choose at least one camera' }
    if (body.cameras.length > MAX_KEY_CAMERAS) return { error: 'Too many cameras' }
    const set = new Set()
    for (const c of body.cameras) {
      if (typeof c !== 'string' || !CAMERA_KEY_RE.test(c)) return { error: `Not a camera: ${String(c).slice(0, 40)}` }
      const [nvr, ch] = [c.slice(0, c.lastIndexOf('/')), Number(c.slice(c.lastIndexOf('/') + 1))]
      if (!known(nvr, ch)) return { error: `No such camera: ${nvr} camera ${ch + 1}` }
      set.add(c)
    }
    cameras = [...set].sort()
  } else return { error: 'cameras must be "all" or a list of cameras' }
  return { name, cameras, main: body?.main === true }
}

/** Makes a key: what is stored (hash only) and the password to show once. */
export function makeKey(fields, { by, now = Date.now(), random = randomBytes } = {}) {
  const id = random(6).toString('hex')
  const user = `cam-${random(4).toString('hex')}`
  const password = random(32).toString('base64url')
  return {
    key: { id, user, hash: `sha256:${sha256(password)}`, name: fields.name, cameras: fields.cameras, main: fields.main === true, camera: fields.camera ?? null, createdAt: now, createdBy: by ?? '', lastUsedAt: null, lastUsedIp: null },
    password
  }
}

/** Whether this password is the key's (constant time). */
export function passwordMatches(key, password) {
  if (typeof key?.hash !== 'string' || !key.hash.startsWith('sha256:') || typeof password !== 'string' || !password) return false
  const want = Buffer.from(key.hash.slice(7), 'hex')
  const got = Buffer.from(sha256(password), 'hex')
  return want.length === got.length && timingSafeEqual(want, got)
}

/** Whether the key covers this camera (ch from 0), and its main stream if asked for. */
export function keyAllows(key, nvr, ch, main = false) {
  if (!key) return false
  if (main && key.main !== true) return false
  if (key.cameras === 'all') return true
  return Array.isArray(key.cameras) && key.cameras.includes(cameraKey(nvr, ch))
}

/** The cameras (of those given: { nvr, ch, ... }) a key covers. */
export const camerasOfKey = (key, cameras) => cameras.filter((c) => keyAllows(key, c.nvr, c.ch))

/** A key as the Settings page sees it: never its hash. */
export const publicKey = (k) => ({ id: k.id, user: k.user, name: k.name, cameras: k.cameras, main: k.main === true, camera: k.camera ?? null, createdAt: k.createdAt, createdBy: k.createdBy, lastUsedAt: k.lastUsedAt ?? null, lastUsedIp: k.lastUsedIp ?? null })

/** The day (UTC) a time falls on, for "first use per key per day". */
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)

// ---- the RTSP server's questions ----

/**
 * The answer to one of MediaMTX's auth calls ({ user, password, ip, action, path, protocol, ... }).
 * @param {object} ask the call's JSON body
 * @param {{ secret: string, keys: object[], known: (nvr: string, ch: number) => boolean,
 *   mainRoom?: (nvr: string, ch: number) => boolean, convertRoom?: (nvr: string, ch: number) => true|string }} o
 *   known: the camera exists (its NVR is configured, the channel holds a camera)
 *   mainRoom: a main stream for this camera may be opened now (main-limit.mjs), or already runs
 *   convertRoom: a 1080p conversion of this camera may start now, or already runs: true, else why not
 * @returns {{ ok: boolean, why: string, key?: object, path?: object, feed?: boolean }}
 */
export function decide(ask, { secret, keys, known, mainRoom = () => true, convertRoom = () => true }) {
  const action = String(ask?.action ?? '')
  const user = typeof ask?.user === 'string' ? ask.user : ''
  const password = typeof ask?.password === 'string' ? ask.password : ''
  const path = parsePath(ask?.path)
  if (action === 'publish') {
    // (ffmpeg asks first without its credentials, and sends them when told to)
    if (!user && isLoopback(ask?.ip) && path) return { ok: false, why: 'credentials needed', ask: true }
    // only Argus's own feed: from this machine, with this boot's password
    if (user !== FEED_USER || !isLoopback(ask?.ip) || !path) return { ok: false, why: 'publishing is only for Argus itself' }
    const a = Buffer.from(sha256(password), 'hex')
    const b = Buffer.from(sha256(secret ?? ''), 'hex')
    if (!secret || !timingSafeEqual(a, b)) return { ok: false, why: 'wrong feed password' }
    return { ok: true, why: 'feed', feed: true, path }
  }
  if (action !== 'read') return { ok: false, why: `${action || 'that'} is not offered` }
  if (!path) return { ok: false, why: 'no such path' }
  if (!user) return { ok: false, why: 'credentials needed', ask: true }
  const key = keys.find((k) => k.user === user)
  if (!key || !passwordMatches(key, password)) return { ok: false, why: 'wrong user name or password', failed: true }
  if (!keyAllows(key, path.nvr, path.ch, path.main)) return { ok: false, why: path.main && key.main !== true ? 'this key is for the standard picture only' : 'this key does not cover that camera', key }
  if (!known(path.nvr, path.ch)) return { ok: false, why: 'no such camera', key }
  if (path.variant === '1080') {
    const room = convertRoom(path.nvr, path.ch)
    if (room !== true) return { ok: false, why: typeof room === 'string' && room ? room : '1080p not available now', key }
  }
  if (path.main && !mainRoom(path.nvr, path.ch)) return { ok: false, why: 'full quality not available now: the recorder is at its limit', key }
  return { ok: true, why: 'read', key, path }
}

/**
 * A limit on wrong passwords per address (a key's password cannot be guessed, but a program with a
 * stale key retries for ever): after `max` within windowMs, that address is refused for windowMs.
 */
export function failureLimit({ max = 20, windowMs = 10 * 60_000, now = Date.now } = {}) {
  const seen = new Map() // ip -> { n, since }
  return {
    blocked(ip) {
      const s = seen.get(ip)
      if (!s) return false
      if (now() - s.since > windowMs) {
        seen.delete(ip)
        return false
      }
      return s.n >= max
    },
    fail(ip) {
      const t = now()
      for (const [k, v] of seen) if (t - v.since > windowMs) seen.delete(k)
      const s = seen.get(ip) ?? { n: 0, since: t }
      s.n++
      seen.set(ip, s)
    }
  }
}
