// Tests for "Who is watching" on the server (viewers.mjs): what a tracked socket is, what a live
// stream is being sent, the access watch's track telling presence, and GET /api/admin/viewers.
// No server, no sockets: small objects stand in, and server.mjs's wiring is read from its source.
//   node cctv/test/viewers.test.mjs
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { makePresence } from '../presence.mjs'
import { VIEWERS_PATH, handleViewers, liveKind, openOf, trackingOpen } from '../viewers.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}
const J = (o) => JSON.stringify(o)

// ---- what a live stream is being sent ---------------------------------------------------------------
check('liveKind: nothing said is the camera\'s own stream', liveKind() === 'own' && liveKind({ stream: 'main' }) === 'own')
check('liveKind: a remote viewer, whatever else it said', liveKind({ remote: true, phone: true, noH265: true, codec: 'h265', h264On: true }) === 'remote')
check('liveKind: a phone before the PC without H.265', liveKind({ phone: true, noH265: true, codec: 'h265', h264On: true }) === 'phone')
check('liveKind: a PC without H.265 on an H.265 sub-stream is converted', liveKind({ noH265: true, stream: 'sub', codec: 'h265', h264On: true }) === 'h264')
check('liveKind: ...an H.264 camera is its own', liveKind({ noH265: true, stream: 'sub', codec: 'h264', h264On: true }) === 'own')
check('liveKind: ...a codec not seen yet is not guessed', liveKind({ noH265: true, stream: 'sub', codec: null, h264On: true }) === 'unknown')
check('liveKind: ...a main stream is never converted', liveKind({ noH265: true, stream: 'main', codec: 'h265', h264On: true }) === 'own')
check('liveKind: ...nor anything with the conversions off', liveKind({ noH265: true, stream: 'sub', codec: 'h265', h264On: false }) === 'own')

// ---- what a tracked socket is -------------------------------------------------------------------------
check('openOf: /live with only the live right is the sub-stream', J(openOf('/live', ['live'])) === J({ type: 'live', stream: 'sub' }))
check('openOf: /live-mux with Live HD is the main stream', J(openOf('/live-mux', ['live', 'live-hd'])) === J({ type: 'live', stream: 'main' }))
check('openOf: server playback', J(openOf('/playback', ['playback-server'])) === J({ type: 'playback', source: 'server' }))
check('openOf: server playback with its gaps from the NVR is still the server\'s', openOf('/playback', ['playback-server', 'playback-nvr']).source === 'server')
check('openOf: NVR playback, sub and main', openOf('/playback', ['playback-nvr']).source === 'nvr' && openOf('/playback', ['playback-nvr', ['live-hd', 'playback-server']]).source === 'nvr')
check('openOf: a motion search', J(openOf('/motion', ['playback-nvr'])) === J({ type: 'motion' }))
check('openOf: anything else is nobody watching', openOf('/other', ['live']) === null && openOf('/playback', null).source === 'unknown')

// ---- the watch's track tells presence -------------------------------------------------------------------
const sock = (extra = {}) => Object.assign(new EventEmitter(), { readyState: 1, send() {}, ...extra })
const req = (url, cookie = 'c=1') => ({ url, headers: { cookie }, socket: { remoteAddress: '192.168.1.20' } })
{
  const p = makePresence()
  const tracked = []
  const track = trackingOpen({
    track: (ws, r, what) => (tracked.push(what), 'stop'),
    presence: p,
    keyOf: (r) => r.headers.cookie,
    describe: (handle, r, open, nvr, ch) => ({ kind: `${open.stream}@${nvr}/${ch}` })
  })
  const page = sock()
  const r = req('/live-mux')
  p.join('c=1', page, { user: 'alice', address: '192.168.1.20' })
  const tile = sock()
  check('track: what the watch answers is passed back', track(tile, r, { actions: ['live'], nvr: 'n1', ch: 4 }) === 'stop')
  check('track: and the watch is asked just the same', J(tracked) === J([{ actions: ['live'], nvr: 'n1', ch: 4 }]))
  check('track: the tile is on the viewer\'s list, with what describe adds', J(p.list().viewers[0].live.map((x) => [x.nvr, x.ch, x.stream, x.kind])) === J([['n1', 4, 'sub', 'sub@n1/4']]))
  // the stand-in's handle (live-attach.mjs standInHandle): no send, the same tile again
  track({ readyState: 1, on() {}, close() {} }, r, { actions: ['live', 'live-hd'], nvr: 'n1', ch: 4 })
  check('track: a handle that is not a socket is not listed, but is still watched', p.list().viewers[0].live.length === 1 && tracked.length === 2)
  track(sock({ readyState: 3 }), r, { actions: ['live'], nvr: 'n1', ch: 9 })
  check('track: nor a socket closed already', p.list().viewers[0].live.length === 1 && tracked.length === 3)
  tile.emit('close')
  check('track: the tile closing takes it off the list', p.list().viewers[0].live.length === 0 && p.list().total === 1)

  // playback on its own socket, going over to the NVR's main stream (tracked again)
  const pb = sock()
  const pr = req('/playback?nvr=n1&ch=2')
  p.join('c=1', pb, { user: 'alice' })
  track(pb, pr, { actions: ['playback-server'], nvr: 'n1', ch: 2 })
  check('track: a playback, without asking describe', J(p.list().viewers[0].playback.map((x) => [x.ch, x.source])) === J([[2, 'server']]))
  track(pb, pr, { actions: ['playback-nvr', ['live-hd', 'playback-server']], nvr: 'n1', ch: 2 })
  check('track: tracked again, it is one entry with what it plays now', J(p.list().viewers[0].playback.map((x) => x.source)) === J(['nvr']))
  const ms = sock()
  p.join('c=1', ms, {})
  track(ms, req('/motion?nvr=n1&ch=2'), { actions: ['playback-nvr'], nvr: 'n1', ch: 2 })
  check('track: a motion search is "other"', J(p.list().viewers[0].other.map((x) => x.what)) === J(['motion']))

  // nothing here may stop a stream being watched for its rights
  const broken = trackingOpen({ track: () => 'still', presence: { open: () => { throw new Error('no') } }, keyOf: () => { throw new Error('no') } })
  check('track: a failure in the list never stops the watch', broken(sock(), req('/live'), { actions: ['live'], nvr: 'n1', ch: 0 }) === 'still')
}

// ---- GET /api/admin/viewers -----------------------------------------------------------------------------
{
  const p = makePresence()
  const ws = {}
  p.join('k1', ws, { remote: true, now: 5000, user: 'alice', address: '203.0.113.9' })
  p.open('k1', {}, { type: 'live', nvr: 'n1', ch: 0, stream: 'sub', kind: 'remote' })
  const admin = { user: 'boss', admin: true }
  const nameOf = (nvr, ch) => ({ site: 'Shop', nvrName: 'Main', camera: `Cam ${ch + 1}` })
  check('route: other paths are not ours', handleViewers('GET', '/api/admin/users', admin, p) === null)
  for (const who of [{ user: 'guard', admin: false }, { user: 'x' }, { user: 'x', admin: 'yes' }, null]) {
    const [st, body, headers] = handleViewers('GET', VIEWERS_PATH, who, p)
    check(`route: refused for ${J(who)}`, st === 403 && J(body) === J({ error: 'Admins only' }) && headers['cache-control'] === 'no-store')
  }
  check('route: a viewer is refused whatever the method, before anything is read', handleViewers('POST', VIEWERS_PATH, { user: 'guard', admin: false }, { list: () => { throw new Error('read') } })[0] === 403)
  const post = handleViewers('POST', VIEWERS_PATH, admin, p)
  check('route: GET only', post[0] === 405 && post[2].allow === 'GET' && post[2]['cache-control'] === 'no-store')
  const [st, body, headers] = handleViewers('GET', VIEWERS_PATH, admin, p, { now: () => 9000, nameOf })
  check('route: an admin gets it, never cached', st === 200 && headers['cache-control'] === 'no-store')
  check('route: the shape', J(Object.keys(body)) === J(['now', 'viewers', 'total', 'people']) && body.now === 9000 && body.total === 1 && J(body.people) === J({ people: 1, local: 0, remote: 1 }), J(body))
  check('route: one viewer, with what it has open', J(body.viewers) === J([{
    user: 'alice', address: '203.0.113.9', remote: true, since: 5000,
    live: [{ nvr: 'n1', ch: 0, site: 'Shop', nvrName: 'Main', camera: 'Cam 1', stream: 'sub', kind: 'remote' }],
    playback: [], other: [],
    counts: { sockets: 1, live: 1, playback: 0, other: 0, cameras: 1 }
  }]), J(body.viewers))
  check('route: the viewer\'s key is not in it', !J(body).includes('k1'))
}

// ---- server.mjs wiring (source scan: the server needs the SDK) ------------------------------------------
{
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  check('server.mjs: the route, with the request\'s own who', /const viewersRoute = handleViewers\(req\.method, pathname, who, presence, \{ nameOf: cameraNames \}\)\n\s*if \(viewersRoute\) return sendJson\(res, \.\.\.viewersRoute\)/.test(src))
  check('server.mjs: ...answered after the sign-in check made who', src.indexOf('const who = { user, admin: AUTH_OFF || auth.isAdmin(user) }') < src.indexOf('const viewersRoute') && src.indexOf('const who = {') > 0)
  check('server.mjs: every track goes through trackingOpen, set before attachLive reads it', /watch\.track = trackingOpen\(\{\n\s*track: watch\.track,/.test(src) && src.indexOf('watch.track = trackingOpen(') < src.indexOf('const attachLive = liveAttacher(') && src.indexOf('watch.track = trackingOpen(') < src.indexOf('const onConnection ='))
  check('server.mjs: a socket joins with its user and the visitor\'s address', /presence\.join\(vkey, ws, \{ remote: isRemoteAddress\(req\.socket\.remoteAddress\), user: currentUser\(req\), address: clientIp\(req\) \}\)/.test(src))
  check('server.mjs: a mux channel\'s "sub" is kept for its kind', /asked\.set\(channel, sub\)/.test(src) && src.indexOf('asked.set(channel, sub)') < src.indexOf('attachLive(channel, req,'))
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exitCode = failures ? 1 : 0
