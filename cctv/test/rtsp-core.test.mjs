// Tests for camera links' pure parts (rtsp-core.mjs): paths, URLs, the RTSP server's config and
// commands, new keys, password checks, what a key covers, and every answer to the RTSP server's
// "may this connection do this?". No server, no files.
// Run:  node cctv/test/rtsp-core.test.mjs
import { CONVERT, CONVERT_MAX_DEFAULT, DEFAULT_PORT, FEED_USER, PATH_PATTERN, PATH_PATTERN_1080, arg, buildConfig, convertCommand, convertMaxOf, camerasOfKey, checkNewKey, decide, failureLimit, feedCommand, hookCommand, isLoopback, keyAllows, makeKey, parsePath, passwordMatches, pathOf, publicKey, rtspUrl, sha256 } from '../rtsp-core.mjs'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}
const J = (v) => JSON.stringify(v)

// ---- paths and addresses ----
check('a sub-stream path: camera numbers count from 1', J(parsePath('nvr-2/5')) === J({ nvr: 'nvr-2', ch: 4, main: false, variant: 'sub' }))
check('a main path', J(parsePath('shad/12/main')) === J({ nvr: 'shad', ch: 11, main: true, variant: 'main' }))
check('a 1080p path: made from the main stream, so main too', J(parsePath('lawrence/14/1080')) === J({ nvr: 'lawrence', ch: 13, main: true, variant: '1080' }))
for (const bad of ['', 'nvr', 'nvr/0', 'nvr/05', 'nvr/1/sub', 'nvr/1/main/x', 'nvr/1/720', 'nvr/1/1080/main', 'nvr/1/main/1080', 'nvr/1/1080/', '../x/1', 'a b/1', 'nvr/12345', '/nvr/1', 'nvr/1/', null, undefined, `${'x'.repeat(65)}/1`]) {
  check(`not a path: ${J(bad)}`, parsePath(bad) === null)
}
check('pathOf and parsePath agree', pathOf('nvr-2', 4) === 'nvr-2/5' && pathOf('nvr-2', 4, true) === 'nvr-2/5/main' && pathOf('nvr-2', 4, 'main') === 'nvr-2/5/main' && pathOf('nvr-2', 4, '1080') === 'nvr-2/5/1080' && pathOf('nvr-2', 4, 'sub') === 'nvr-2/5' && J(parsePath(pathOf('a.b_c', 0, true))) === J({ nvr: 'a.b_c', ch: 0, main: true, variant: 'main' }) && parsePath(pathOf('a', 3, '1080')).variant === '1080')
{
  const copy = new RegExp(PATH_PATTERN.slice(1))
  const conv = new RegExp(PATH_PATTERN_1080.slice(1))
  check('the RTSP server patterns match what parsePath takes', copy.test('nvr-2/5/main') && copy.test('nvr-2/5') && !copy.test('nvr-2/0') && conv.test('nvr-2/5/1080') && !conv.test('nvr-2/0/1080'))
  check('...and never the same path (each path has one feed command)', !copy.test('nvr-2/5/1080') && !conv.test('nvr-2/5/main') && !conv.test('nvr-2/5'))
}
check('the 1080p limit: CCTV_RTSP_1080_MAX, 0 allowed, nonsense ignored', CONVERT_MAX_DEFAULT === 2 && convertMaxOf({}) === 2 && convertMaxOf({ CCTV_RTSP_1080_MAX: '0' }) === 0 && convertMaxOf({ CCTV_RTSP_1080_MAX: '5' }) === 5 && convertMaxOf({ CCTV_RTSP_1080_MAX: '-1' }) === 2 && convertMaxOf({ CCTV_RTSP_1080_MAX: '1.5' }) === 2 && convertMaxOf({ CCTV_RTSP_1080_MAX: 'x' }) === 2 && convertMaxOf({ CCTV_RTSP_1080_MAX: '' }) === 2)
check('an address with the password', rtspUrl({ host: '192.168.1.232', user: 'cam-ab12cd34', password: 'p-_x', path: 'shad/3' }) === 'rtsp://cam-ab12cd34:p-_x@192.168.1.232:8554/shad/3')
check('...without it, an IPv6 host in brackets, another port', rtspUrl({ host: 'fe80::1', port: 9554, user: 'u', path: 'a/1/main' }) === 'rtsp://u@[fe80::1]:9554/a/1/main')
check('loopback addresses', isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.1') && !isLoopback('192.168.1.5') && !isLoopback('') && !isLoopback(undefined))

// ---- the config and its commands ----
{
  const feed = feedCommand({ feedUrl: 'http://127.0.0.1:8080/internal/rtsp-feed', secret: 'abc123', rtspPort: 8554 })
  check('the feed command: MPEG-TS in, copied, published to the loopback with the feed user', /^ffmpeg .*-f mpegts -i "http:\/\/127\.0\.0\.1:8080\/internal\/rtsp-feed\?path=\$MTX_PATH&s=abc123" .*-c copy -f rtsp -rtsp_transport tcp rtsp:\/\/argus-feed:abc123@127\.0\.0\.1:8554\/\$MTX_PATH$/.test(feed), feed)
  check('arguments quoted only when needed, $ left for MediaMTX', arg('/usr/bin/ffmpeg') === '/usr/bin/ffmpeg' && arg('a b') === '"a b"' && arg('x?y=$P') === '"x?y=$P"' && arg('say "hi"') === '"say \\"hi\\""')
  const hook = hookCommand({ node: '/usr/local/bin/node', script: '/opt/cctv/current/cctv/rtsp-hook.mjs', url: 'http://127.0.0.1:8080/internal/rtsp-event', secret: 's1', event: 'read' })
  check('the hook command', hook === '/usr/local/bin/node /opt/cctv/current/cctv/rtsp-hook.mjs read http://127.0.0.1:8080/internal/rtsp-event s1', hook)
  const y = buildConfig({ authUrl: 'http://127.0.0.1:8080/internal/rtsp-auth?s=abc', feedCommand: feed, onRead: hook, onUnread: hook.replace(' read ', ' unread ') })
  const has = (line) => y.split('\n').includes(line)
  check('auth by Argus over HTTP', has('authMethod: http') && has('authHTTPAddress: "http://127.0.0.1:8080/internal/rtsp-auth?s=abc"') && has('authHTTPExclude: []'))
  check('only RTSP: TCP and UDP on 8554', has('rtsp: true') && has('rtspTransports: [udp, tcp]') && has(`rtspAddress: :${DEFAULT_PORT}`) && has('rtspEncryption: "no"'))
  check('everything else off: RTMP, HLS, WebRTC, SRT, MoQ, API, metrics, pprof, playback', ['rtmp', 'hls', 'webrtc', 'srt', 'moq', 'api', 'metrics', 'pprof', 'playback'].every((k) => has(`${k}: false`)))
  check('one path pattern, fed on demand, closed 10 s after the last reader', has(`  ${J(PATH_PATTERN)}:`) && has(`    runOnDemand: ${J(feed)}`) && has('    runOnDemandCloseAfter: 10s') && has('    runOnDemandRestart: true') && !/all_others/.test(y))
  check('the hooks tell Argus of readers', has(`    runOnRead: ${J(hook)}`) && y.includes('runOnUnread: "/usr/local/bin/node /opt/cctv/current/cctv/rtsp-hook.mjs unread'))
  check('no convert command: no 1080p paths', !y.includes(J(PATH_PATTERN_1080)))
  {
    const conv = convertCommand({ feedUrl: 'http://127.0.0.1:8080/internal/rtsp-feed', secret: 'abc123', rtspPort: 8554 })
    const argv = conv.match(/"(?:[^"\\]|\\.)*"|\S+/g).map((a) => (a.startsWith('"') ? a.slice(1, -1) : a))
    const after = (flag, from = 0) => argv[argv.indexOf(flag, from) + 1]
    const iAt = argv.indexOf('-i')
    check('1080p: reads the same loopback feed (Argus serves the main stream for the path)', after('-i') === 'http://127.0.0.1:8080/internal/rtsp-feed?path=$MTX_PATH&s=abc123' && after('-f') === 'mpegts' && argv.includes('0:v:0'), conv)
    check('1080p: decoded on 2 threads (set before the input), encoded on 2, filters on 1', argv.indexOf('-threads') < iAt && after('-threads') === '2' && argv.lastIndexOf('-threads') > iAt && argv[argv.lastIndexOf('-threads') + 1] === '2' && after('-filter_threads') === '1')
    const vf = after('-vf')
    check('1080p: scaled to fit 1920x1080, aspect kept, never enlarged, even sizes', vf === "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", vf)
    check('1080p: at most 20 fps (no repeated frames for a slower camera)', after('-fpsmax') === '20' && !argv.includes('-r') && !/fps=/.test(vf))
    check('1080p: H.264, superfast, zero latency, 8-bit 4:2:0, CRF 23 capped at 6 Mbit/s', after('-c:v') === 'libx264' && after('-preset') === CONVERT.preset && CONVERT.preset === 'superfast' && after('-tune') === 'zerolatency' && after('-pix_fmt') === 'yuv420p' && after('-crf') === '23' && after('-maxrate') === '6M' && after('-bufsize') === '12M')
    check('1080p: a keyframe every second', after('-force_key_frames') === 'expr:gte(t,n_forced*1)')
    check('1080p: published like the copied feeds, never copied itself', /-f rtsp -rtsp_transport tcp rtsp:\/\/argus-feed:abc123@127\.0\.0\.1:8554\/\$MTX_PATH$/.test(conv) && !conv.includes('-c copy'))
    const y2 = buildConfig({ authUrl: 'http://x', feedCommand: feed, convertCommand: conv, onRead: hook })
    const l2 = y2.split('\n')
    const at = l2.indexOf(`  ${J(PATH_PATTERN_1080)}:`)
    check('with a convert command: a second path pattern, fed by it, on demand, closed 10 s after the last reader, readers told', at > l2.indexOf(`  ${J(PATH_PATTERN)}:`) && l2[at + 3] === `    runOnDemand: ${J(conv)}` && l2[at + 6] === '    runOnDemandCloseAfter: 10s' && l2[at + 7] === `    runOnRead: ${J(hook)}` && l2.filter((x) => x === `    runOnDemand: ${J(feed)}`).length === 1, l2.slice(at, at + 10).join(' | '))
  }
  check('UDP can be left out', buildConfig({ authUrl: 'x', feedCommand: 'y', udp: false }).includes('rtspTransports: [tcp]'))
  let threw = false
  try { buildConfig({}) } catch { threw = true }
  check('no auth address or feed: refused', threw)
}

// ---- keys ----
const cams = new Set(['shad/0', 'shad/1', 'site3/4'])
const known = (nvr, ch) => cams.has(`${nvr}/${ch}`)
{
  check('a name is needed', checkNewKey({ name: '  ', cameras: 'all' }, { known, count: 0 }).error)
  check('cameras: all', J(checkNewKey({ name: ' Gate reader ', cameras: 'all', main: true }, { known, count: 0 })) === J({ name: 'Gate reader', cameras: 'all', main: true }))
  check('cameras chosen: known only, sorted, once each', J(checkNewKey({ name: 'x', cameras: ['site3/4', 'shad/0', 'shad/0'] }, { known, count: 0 })) === J({ name: 'x', cameras: ['shad/0', 'site3/4'], main: false }))
  check('an unknown camera is refused', /No such camera: shad camera 10/.test(checkNewKey({ name: 'x', cameras: ['shad/9'] }, { known, count: 0 }).error ?? ''))
  check('a malformed camera is refused', /Not a camera/.test(checkNewKey({ name: 'x', cameras: ['a b/1'] }, { known, count: 0 }).error ?? ''))
  check('no cameras, or not a list: refused', checkNewKey({ name: 'x', cameras: [] }, { known, count: 0 }).error && checkNewKey({ name: 'x', cameras: 'some' }, { known, count: 0 }).error)
  check('too many keys: refused', /already/.test(checkNewKey({ name: 'x', cameras: 'all' }, { known, count: 200 }).error ?? ''))
  check('main only when exactly true', checkNewKey({ name: 'x', cameras: 'all', main: 'yes' }, { known, count: 0 }).main === false)
  check('control characters leave the name', checkNewKey({ name: 'a\nb', cameras: 'all' }, { known, count: 0 }).name === 'a b')

  const { key, password } = makeKey({ name: 'Gate', cameras: ['shad/1'], main: false }, { by: 'mike', now: 1000 })
  check('a key: user cam-<8 hex>, a 43-character password, only its hash kept', /^cam-[0-9a-f]{8}$/.test(key.user) && password.length === 43 && key.hash === `sha256:${sha256(password)}` && !J(key).includes(password))
  check('...made by, when, never used', key.createdBy === 'mike' && key.createdAt === 1000 && key.lastUsedAt === null)
  check('its password matches; another, an empty one or none does not', passwordMatches(key, password) && !passwordMatches(key, `${password}x`) && !passwordMatches(key, '') && !passwordMatches(key, undefined) && !passwordMatches({ hash: 'md5:x' }, password))
  check('two keys differ', makeKey({ name: 'a', cameras: 'all' }).password !== makeKey({ name: 'a', cameras: 'all' }).password)
  check('the page never sees the hash', !('hash' in publicKey(key)) && publicKey(key).user === key.user)
  check('what a key covers', keyAllows(key, 'shad', 1) && !keyAllows(key, 'shad', 0) && !keyAllows(key, 'shad', 1, true) && keyAllows({ cameras: 'all', main: true }, 'any', 7, true) && !keyAllows(null, 'shad', 1))
  check('a key\'s cameras of a list', J(camerasOfKey(key, [{ nvr: 'shad', ch: 0 }, { nvr: 'shad', ch: 1 }]).map((c) => c.ch)) === J([1]))

  // ---- the RTSP server's questions ----
  const secret = 'f'.repeat(48)
  const keys = [key, { ...makeKey({ name: 'All HD', cameras: 'all', main: true }).key }]
  const allHd = makeKey({ name: 'All HD', cameras: 'all', main: true })
  keys[1] = allHd.key
  const ask = (o, more = {}) => decide({ ip: '192.168.1.50', protocol: 'rtsp', ...o }, { secret, keys, known, ...more })
  check('publish: Argus\'s own feed, from this machine, with this boot\'s secret', ask({ action: 'publish', user: FEED_USER, password: secret, ip: '127.0.0.1', path: 'shad/2' }).ok === true)
  check('publish: ffmpeg\'s first try without credentials is asked for them, quietly', (() => { const d = ask({ action: 'publish', ip: '127.0.0.1', path: 'shad/2' }); return d.ok === false && d.ask === true })() && ask({ action: 'publish', path: 'shad/2' }).ask !== true)
  check('publish: refused from another machine', ask({ action: 'publish', user: FEED_USER, password: secret, path: 'shad/2' }).ok === false)
  check('publish: refused with the wrong secret, as another user, or on a path that is no camera', !ask({ action: 'publish', user: FEED_USER, password: 'x', ip: '127.0.0.1', path: 'shad/2' }).ok && !ask({ action: 'publish', user: key.user, password, ip: '127.0.0.1', path: 'shad/2' }).ok && !ask({ action: 'publish', user: FEED_USER, password: secret, ip: '127.0.0.1', path: 'other' }).ok)
  check('publish: refused when no secret was ever made', decide({ action: 'publish', user: FEED_USER, password: '', ip: '127.0.0.1', path: 'shad/2' }, { secret: '', keys, known }).ok === false)
  for (const a of ['playback', 'api', 'metrics', 'pprof', '']) check(`${a || 'no action'}: never`, ask({ action: a, user: allHd.key.user, password: allHd.password, path: 'shad/1' }).ok === false)
  check('read without credentials: asked for them (and not counted as a failure)', (() => { const d = ask({ action: 'read', path: 'shad/2' }); return d.ok === false && d.ask === true && !d.failed })())
  check('read with the key: its camera', (() => { const d = ask({ action: 'read', user: key.user, password, path: 'shad/2' }); return d.ok && d.key === key })())
  check('read: another camera, or its main, refused', !ask({ action: 'read', user: key.user, password, path: 'shad/1' }).ok && /standard picture only/.test(ask({ action: 'read', user: key.user, password, path: 'shad/2/main' }).why))
  check('read: a wrong password is a failure', (() => { const d = ask({ action: 'read', user: key.user, password: 'nope', path: 'shad/2' }); return !d.ok && d.failed === true })())
  check('read: an unknown user is a failure', ask({ action: 'read', user: 'cam-00000000', password, path: 'shad/2' }).failed === true)
  check('read: every camera with an all-cameras key, main too', ask({ action: 'read', user: allHd.key.user, password: allHd.password, path: 'site3/5/main' }).ok)
  check('read: a camera that does not exist (any more)', ask({ action: 'read', user: allHd.key.user, password: allHd.password, path: 'site3/9' }).why === 'no such camera')
  check('read: main refused while the recorder is at its limit; the sub still fine', !ask({ action: 'read', user: allHd.key.user, password: allHd.password, path: 'site3/5/main' }, { mainRoom: () => false }).ok && ask({ action: 'read', user: allHd.key.user, password: allHd.password, path: 'site3/5' }, { mainRoom: () => false }).ok)
  check('read: 1080p with a full-quality key', ask({ action: 'read', user: allHd.key.user, password: allHd.password, path: 'site3/5/1080' }).ok)
  check('read: 1080p needs full quality: a standard-only key is refused', /standard picture only/.test(ask({ action: 'read', user: key.user, password, path: 'shad/2/1080' }).why))
  check('read: 1080p refused while the recorder is at its main limit', !ask({ action: 'read', user: allHd.key.user, password: allHd.password, path: 'site3/5/1080' }, { mainRoom: () => false }).ok)
  {
    const d = ask({ action: 'read', user: allHd.key.user, password: allHd.password, path: 'site3/5/1080' }, { convertRoom: () => '1080p not available now: 2 of 2 conversions already running' })
    check('read: 1080p refused at the conversion limit, with the reason; main and sub still fine', !d.ok && /2 of 2/.test(d.why) && !d.failed && ask({ action: 'read', user: allHd.key.user, password: allHd.password, path: 'site3/5/main' }, { convertRoom: () => 'no' }).ok && ask({ action: 'read', user: allHd.key.user, password: allHd.password, path: 'site3/5' }, { convertRoom: () => 'no' }).ok)
    let asked = null
    ask({ action: 'read', user: allHd.key.user, password: allHd.password, path: 'site3/5/1080' }, { convertRoom: (n, c) => ((asked = `${n}/${c}`), true) })
    check('...the conversion limit is asked for that camera (ch from 0)', asked === 'site3/4')
  }
  check('read: a revoked key (gone from the list) is refused', decide({ action: 'read', user: key.user, password, path: 'shad/2', ip: 'x' }, { secret, keys: [allHd.key], known }).ok === false)
}

// ---- wrong passwords per address ----
{
  let t = 0
  const f = failureLimit({ max: 3, windowMs: 1000, now: () => t })
  f.fail('a'); f.fail('a')
  check('under the limit: not blocked', !f.blocked('a'))
  f.fail('a')
  check('at the limit: blocked; another address not', f.blocked('a') && !f.blocked('b'))
  t = 1500
  check('after the window: free again', !f.blocked('a'))
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exitCode = failed ? 1 : 0
