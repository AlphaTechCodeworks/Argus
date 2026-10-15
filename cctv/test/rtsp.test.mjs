// Tests for camera links' wiring (rtsp.mjs): the admin routes (switch, keys, the one-click link,
// revoke), the stored file, the /internal routes (only this machine with this boot's secret), the
// RTSP server's auth questions with last use and the daily audit row, a camera's feed (its frames as
// MPEG-TS, the tap left when the feed ends, a main counted against the recorder's limit) and the
// reader count. Fake NVRs and a fake RTSP server: no MediaMTX, no ffmpeg, no SDK.
// Run:  node cctv/test/rtsp.test.mjs
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { makeMainLimit } from '../main-limit.mjs'
import { FEED_USER } from '../rtsp-core.mjs'
import { ADMIN_PATH, AUTH_PATH, EVENT_PATH, FEED_PATH, hostAddresses, makeRtsp, readStore } from '../rtsp.mjs'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

const dir = mkdtempSync(join(tmpdir(), 'rtsp-'))
try {
  // ---- a fake world ----
  class Stream {
    constructor() { this.taps = new Set() }
    add(t) { this.taps.add(t) }
    remove(t) { this.taps.delete(t) }
  }
  const streams = new Map()
  const nvr = (id, sn) => ({ id, name: id.toUpperCase(), site: 'Site', cfg: sn ? { sn } : {}, liveOnline: true, channels: [0, 1, 2, 3, 4].map((ch) => ({ ch, name: `Cam ${ch + 1}` })).concat([{ ch: 5, name: 'empty', configured: false }]), getStream(ch, type) { const k = `${id}/${ch}/${type}`; if (!streams.has(k)) streams.set(k, new Stream()); return streams.get(k) } })
  const nvrs = new Map([['shad', nvr('shad')], ['p2p', nvr('p2p', 'SN123')]])
  const mainLimit = makeMainLimit({ log: () => {} })
  const audits = []
  const lines = []
  const server = { started: 0, stopped: 0, restarted: 0, running: false, start() { this.started++; this.running = true }, stop() { this.stopped++; this.running = false }, restart() { this.restarted++ }, status() { return { installed: true, running: this.running, lastError: null } } }
  let t = Date.UTC(2026, 9, 15, 9)
  const rtsp = makeRtsp({ dataDir: dir, appDir: '/opt/cctv/current', httpPort: 8080, nvrs, mainLimit, audit: (r) => audits.push(r), log: (l) => lines.push(l), env: {}, hosts: () => ['192.168.1.232'], server, now: () => t, nodePath: '/usr/local/bin/node' })
  const admin = { user: 'mike', admin: true }
  const call = (body) => rtsp.handleAdmin('POST', ADMIN_PATH, async () => body, admin, { ip: '192.168.1.20', device: 'Windows PC' })

  // ---- admin routes ----
  check('not this route: null', (await rtsp.handleAdmin('GET', '/api/admin/other', null, admin)) === null)
  check('a viewer: refused', (await rtsp.handleAdmin('GET', ADMIN_PATH, null, { user: 'ann', admin: false }))[0] === 403)
  {
    const [s, v] = await rtsp.handleAdmin('GET', ADMIN_PATH, null, admin)
    check('the view: off, installed, port, hosts, no keys, the configured cameras with their paths', s === 200 && v.enabled === false && v.status.installed === true && v.port === 8554 && v.hosts[0] === '192.168.1.232' && v.keys.length === 0 && v.cameras.length === 10 && v.cameras[0].path === 'shad/1' && v.cameras[0].mainPath === 'shad/1/main', JSON.stringify(v).slice(0, 200))
  }
  rtsp.start()
  check('off at start: the RTSP server is not started', server.started === 0)

  const [ls, link0] = await call({ action: 'link', nvr: 'shad', ch: 2 })
  check('one-click link while off: says so, offers to turn on, makes nothing', ls === 200 && link0.ready === false && link0.why === 'off' && readStore(join(dir, 'rtsp.json')).keys.length === 0)
  const [, link] = await call({ action: 'link', nvr: 'shad', ch: 2, turnOn: true })
  check('...with turnOn: switched on, started, a key for that camera alone with main, its password and paths', link.ready === true && server.started === 1 && link.password.length === 43 && link.key.cameras.join() === 'shad/2' && link.key.main === true && link.path === 'shad/3' && link.mainPath === 'shad/3/main' && link.earlier === 0 && link.key.name === 'Cam 3 (SHAD)', JSON.stringify(link).slice(0, 300))
  check('switching on and the key are audited (who, address, device)', audits.some((a) => a.action === 'camera-link' && a.target === 'service' && /switched on/.test(a.detail)) && audits.some((a) => a.action === 'camera-link' && a.target === 'Cam 3 (SHAD)' && a.user === 'mike' && a.ip === '192.168.1.20' && /device: Windows PC/.test(a.detail)))
  const [, link2] = await call({ action: 'link', nvr: 'shad', ch: 2 })
  check('a second click: a new key, the earlier one counted', link2.ready && link2.key.id !== link.key.id && link2.earlier === 1)
  check('link to a camera that does not exist (or an empty slot): 404', (await call({ action: 'link', nvr: 'shad', ch: 5 }))[0] === 404 && (await call({ action: 'link', nvr: 'nope', ch: 0 }))[0] === 404)
  const [cs, made] = await call({ action: 'create', name: 'Gate reader', cameras: ['p2p/0', 'p2p/1'], main: false })
  check('a key for chosen cameras', cs === 200 && made.key.name === 'Gate reader' && made.linkCameras.map((c) => c.path).join() === 'p2p/1,p2p/2' && made.keys.length === 3)
  check('a bad key request: 400 with the reason', (await call({ action: 'create', name: '', cameras: 'all' }))[0] === 400 && (await call({ action: 'create', name: 'x', cameras: ['shad/9'] }))[0] === 400)
  const [, all] = await call({ action: 'create', name: 'VMS', cameras: 'all', main: true })
  {
    const raw = readFileSync(join(dir, 'rtsp.json'), 'utf8')
    check('stored: hashes only, never a password', !raw.includes(link.password) && !raw.includes(made.password) && raw.includes(`sha256:`) && readStore(join(dir, 'rtsp.json')).enabled === true)
    if (process.platform !== 'win32') check('stored 0600', (statSync(join(dir, 'rtsp.json')).mode & 0o777) === 0o600)
  }

  // ---- /internal: only this machine, with this boot's secret ----
  const res = () => {
    const r = new EventEmitter()
    Object.assign(r, { status: null, chunks: [], ended: false, destroyed: false, writableLength: 0, writeHead(s) { this.status = s; return this }, end() { this.ended = true; return this }, write(b) { this.chunks.push(b); return true }, destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close') } } })
    return r
  }
  const req = (method, body) => Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method })
  const url = (path, q = {}) => new URL(`http://127.0.0.1:8080${path}?${new URLSearchParams({ s: rtsp.secret, ...q })}`)
  const internal = async (path, method, body, { local = true, q = {}, secret } = {}) => {
    const r = res()
    const u = url(path, q)
    if (secret !== undefined) u.searchParams.set('s', secret)
    const handled = await rtsp.handleInternal(req(method, body), r, u, { local })
    return { handled, r }
  }
  check('another path: not handled', (await rtsp.handleInternal(req('GET'), res(), new URL('http://x/internal/else'), { local: true })) === false)
  check('from another machine: 403', (await internal(AUTH_PATH, 'POST', {}, { local: false })).r.status === 403)
  check('without the secret, or a wrong one: 403', (await internal(AUTH_PATH, 'POST', {}, { secret: '' })).r.status === 403 && (await internal(FEED_PATH, 'GET', undefined, { secret: 'x' })).r.status === 403)

  const auth = async (o) => (await internal(AUTH_PATH, 'POST', { protocol: 'rtsp', ip: '192.168.1.77', ...o })).r.status
  check('auth: a reader with the camera\'s link', (await auth({ action: 'read', user: link.key.user, password: link.password, path: 'shad/3' })) === 200)
  check('auth: its main too (a link has full quality)', (await auth({ action: 'read', user: link.key.user, password: link.password, path: 'shad/3/main' })) === 200)
  check('auth: not another camera', (await auth({ action: 'read', user: link.key.user, password: link.password, path: 'shad/4' })) === 401)
  check('auth: the feed publishing from this machine', (await auth({ action: 'publish', user: FEED_USER, password: rtsp.secret, ip: '127.0.0.1', path: 'shad/3' })) === 200)
  check('auth: no credentials yet: 401 and no line in the journal', (() => { const n = lines.length; return auth({ action: 'read', path: 'shad/3' }).then((s) => s === 401 && lines.length === n) })())
  {
    const uses = audits.filter((a) => a.action === 'camera-link-use')
    check('first use of a key today: one audit row with the address', uses.length === 1 && uses[0].ip === '192.168.1.77' && uses[0].target === 'shad/3' && /Cam 3/.test(uses[0].user))
    const k = readStore(join(dir, 'rtsp.json')).keys.find((x) => x.id === link.key.id)
    check('...and the last use saved', k.lastUsedAt === t && k.lastUsedIp === '192.168.1.77')
    t += 86_400_000
    await auth({ action: 'read', user: link.key.user, password: link.password, path: 'shad/3' })
    check('the next day: another row', audits.filter((a) => a.action === 'camera-link-use').length === 2)
  }
  {
    for (let i = 0; i < 20; i++) await auth({ action: 'read', user: link.key.user, password: 'wrong', path: 'shad/3', ip: '10.9.9.9' })
    check('20 wrong passwords from one address: that address refused even with the right one', (await auth({ action: 'read', user: link.key.user, password: link.password, path: 'shad/3', ip: '10.9.9.9' })) === 401 && (await auth({ action: 'read', user: link.key.user, password: link.password, path: 'shad/3', ip: '10.9.9.8' })) === 200)
  }

  // ---- a feed ----
  const frame = (isKey, codec, tsMs, n = 300) => {
    const b = Buffer.alloc(16 + n, 0x55)
    b[0] = isKey ? 1 : 0
    b[1] = codec
    b.writeBigInt64LE(BigInt(tsMs * 1000), 8)
    return b
  }
  {
    const r = res()
    const reqF = req('GET')
    rtsp.handleInternal(reqF, r, url(FEED_PATH, { path: 'shad/3' }), { local: true })
    await new Promise((ok) => setImmediate(ok))
    const s = streams.get('shad/2/1')
    const tap = [...(s?.taps ?? [])][0]
    check('a feed: 200 MPEG-TS, the camera\'s sub-stream tapped once', r.status === 200 && s.taps.size === 1 && rtsp.feeds.has('shad/3') && rtsp.summary().feeds === 1)
    tap.send(frame(false, 0, 1000))
    tap.send(frame(true, 0, 1040))
    tap.send(frame(false, 0, 1090))
    const out = Buffer.concat(r.chunks)
    check('frames as TS: nothing before the keyframe, then PAT, PMT and video', out.length > 0 && out.length % 188 === 0 && out[0] === 0x47 && ((out[1] & 0x1f) << 8 | out[2]) === 0 && out.length >= 188 * 6)
    tap.send(frame(true, 1, 1130))
    check('the codec changing: the feed ends (ffmpeg starts again)', r.destroyed === true && s.taps.size === 0 && !rtsp.feeds.has('shad/3'))
  }
  {
    check('a camera that does not exist: 404; a bad path: 400', (await internal(FEED_PATH, 'GET', undefined, { q: { path: 'shad/9' } })).r.status === 404 && (await internal(FEED_PATH, 'GET', undefined, { q: { path: 'x' } })).r.status === 400)
    nvrs.get('shad').liveOnline = false
    check('its recorder offline: 503', (await internal(FEED_PATH, 'GET', undefined, { q: { path: 'shad/1' } })).r.status === 503)
    nvrs.get('shad').liveOnline = true
  }
  {
    // a P2P recorder allows 3 cameras in full quality: three feeds take them, a fourth is refused
    const open = []
    for (const n of [1, 2, 3, 4]) {
      const r = res()
      rtsp.handleInternal(req('GET'), r, url(FEED_PATH, { path: `p2p/${n}/main` }), { local: true })
      open.push(r)
    }
    check('main feeds count against the recorder\'s limit (P2P: 3)', open.slice(0, 3).every((r) => r.status === 200) && open[3].status === 503 && mainLimit.cameras('p2p').length === 3)
    check('...so the RTSP server is told no for a 4th camera\'s main, yes for one already fed', (await auth({ action: 'read', user: all.key.user, password: all.password, path: 'p2p/4/main' })) === 401 && (await auth({ action: 'read', user: all.key.user, password: all.password, path: 'p2p/1/main' })) === 200)
    open[0].destroy()
    check('a feed ending leaves the stream and the limit', streams.get('p2p/0/0').taps.size === 0 && mainLimit.cameras('p2p').length === 2)
    for (const r of open) r.destroy()
  }

  // ---- readers ----
  {
    const ev = async (event, path, id) => (await internal(EVENT_PATH, 'POST', { event, path, id })).r.status
    await ev('read', 'shad/3', 'a')
    await ev('read', 'shad/3', 'b')
    await ev('read', 'p2p/1/main', 'c')
    check('readers counted per path', rtsp.summary().readers === 3)
    await ev('unread', 'shad/3', 'a')
    check('...and taken off', rtsp.summary().readers === 2)
    check('a bad event: 400', (await ev('peek', 'shad/3', 'x')) === 400 && (await ev('read', 'nope', 'x')) === 400)
  }

  // ---- revoke, switch off ----
  {
    server.running = true
    const [s, v] = await call({ action: 'revoke', id: link.key.id })
    check('revoked: gone, audited, and with readers on the server it is started again (cutting them off)', s === 200 && !v.keys.some((k) => k.id === link.key.id) && server.restarted === 1 && audits.some((a) => /revoked/.test(a.detail)))
    check('...its password no longer opens anything', (await auth({ action: 'read', user: link.key.user, password: link.password, path: 'shad/3' })) === 401)
    check('revoking an unknown key: 404', (await call({ action: 'revoke', id: 'nope' }))[0] === 404)
    const [, off] = await call({ action: 'enable', on: false })
    check('switched off: stopped, said in the view', off.enabled === false && server.stopped >= 1 && rtsp.summary().enabled === false)
  }

  // ---- CCTV_RTSP=off ----
  {
    const s2 = { ...server, started: 0, start() { this.started++ }, stop() {}, status: () => ({ installed: true, running: false }) }
    const r2 = makeRtsp({ dataDir: dir, appDir: '/x', httpPort: 8080, nvrs, mainLimit, env: { CCTV_RTSP: 'off' }, server: s2, log: () => {}, hosts: () => [] })
    check('CCTV_RTSP=off: switching on is refused', (await r2.handleAdmin('POST', ADMIN_PATH, async () => ({ action: 'enable', on: true }), admin))[0] === 409)
    check('...and a link says why', (await r2.handleAdmin('POST', ADMIN_PATH, async () => ({ action: 'link', nvr: 'shad', ch: 0, turnOn: true }), admin))[1].why === 'off-here')
  }

  // ---- the server's addresses ----
  check('addresses: private LAN first, then the tailnet, then others; loopback left out; extra names last', JSON.stringify(hostAddresses({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], ts: [{ family: 'IPv4', address: '100.64.1.2', internal: false }], eth: [{ family: 'IPv4', address: '192.168.1.232', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }] }, ['cctv.example', null])) === JSON.stringify(['192.168.1.232', '100.64.1.2', 'cctv.example']))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exitCode = failed ? 1 : 0
