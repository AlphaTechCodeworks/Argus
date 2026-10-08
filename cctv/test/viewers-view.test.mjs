// Tests for the Health page's "Who is watching" shaping (public/viewers-view.js), no DOM; and that
// health.js paints it as text, for admins only (source scan: the page needs a browser).
//   node cctv/test/viewers-view.test.mjs
import { readFileSync } from 'node:fs'
import { MAX_ROWS, connectedFor, openLine, viewersView } from '../public/viewers-view.js'

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}
const J = (o) => JSON.stringify(o)

// ---- how long ---------------------------------------------------------------------------------------
check('connectedFor: seconds', connectedFor(20_000) === 'under a minute' && connectedFor(NaN) === 'under a minute' && connectedFor(-5) === 'under a minute')
check('connectedFor: minutes', connectedFor(41 * 60_000) === '41 m')
check('connectedFor: hours', connectedFor(81 * 60_000) === '1 h 21 m')
check('connectedFor: days (a wall display)', connectedFor((2 * 1440 + 3 * 60 + 9) * 60_000) === '2 d 3 h')

// ---- one line per thing open ------------------------------------------------------------------------
check('openLine: the camera\'s own sub-stream needs no more words', openLine({ camera: 'Gate', ch: 0, stream: 'sub', kind: 'own' }, 'live') === 'Gate — live, sub-stream')
check('openLine: a main stream', openLine({ camera: 'Gate', ch: 0, stream: 'main', kind: 'own' }, 'live') === 'Gate — live, main stream')
check('openLine: converted for a PC without H.265', openLine({ camera: 'Gate', ch: 0, stream: 'sub', kind: 'h264' }, 'live') === 'Gate — live, sub-stream, converted to H.264 for a PC without H.265')
check('openLine: a remote viewer and a phone', /fitted to a remote link$/.test(openLine({ camera: 'Gate', stream: 'sub', kind: 'remote' }, 'live')) && /phone stream$/.test(openLine({ camera: 'Gate', stream: 'sub', kind: 'phone' }, 'live')))
check('openLine: an unknown kind says nothing it does not know', openLine({ camera: 'Gate', stream: 'sub', kind: 'unknown' }, 'live') === 'Gate — live, sub-stream')
check('openLine: a camera with no name goes by its number', openLine({ camera: null, ch: 4, stream: 'sub' }, 'live') === 'Camera 5 — live, sub-stream')
check('openLine: playback and its source', openLine({ camera: 'Till', source: 'server' }, 'playback') === 'Till — playback, server recordings' && openLine({ camera: 'Till', source: 'nvr' }, 'playback') === 'Till — playback, from the NVR' && openLine({ camera: 'Till', source: 'unknown' }, 'playback') === 'Till — playback')
check('openLine: a motion search', openLine({ camera: 'Till', what: 'motion' }, 'other') === 'Till — motion search')

// ---- the rows -----------------------------------------------------------------------------------------
const NOW = 10_000_000
const cam = (nvr, ch, o = {}) => ({ nvr, ch, site: nvr === 'n1' ? 'Shop' : 'Yard', nvrName: nvr === 'n1' ? 'Main' : 'Gatehouse', camera: `Cam ${ch + 1}`, ...o })
const data = {
  now: NOW,
  total: 2,
  viewers: [
    {
      user: 'alice', address: '192.168.1.20', remote: false, since: NOW - 81 * 60_000,
      live: [cam('n1', 0, { stream: 'sub', kind: 'own' }), cam('n2', 3, { stream: 'sub', kind: 'h264' }), cam('n1', 1, { stream: 'main', kind: 'own' })],
      playback: [cam('n1', 5, { source: 'server' })],
      other: [],
      counts: { sockets: 2, live: 3, playback: 1, other: 0, cameras: 4 }
    },
    { user: 'bob', address: '203.0.113.9', remote: true, since: NOW - 30_000, live: [], playback: [], other: [], counts: { sockets: 1, live: 0, playback: 0, other: 0, cameras: 0 } }
  ]
}
{
  const r = viewersView(data)
  check('view: the count and the summary line', r.count === 2 && r.summary === '2 people · 1 on the network · 1 outside' && r.more === '', r.summary)
  const [a, b] = r.rows
  check('view: a row: name, where, address, how long, how many', J([a.name, a.where, a.address, a.connected, a.watching]) === J(['alice', 'on the network', '192.168.1.20', '1 h 21 m', '4 cameras · 1 in playback']), J(a))
  check('view: what it watches, grouped by site and NVR, live before playback', J(a.groups) === J([
    { label: 'Shop · Main', lines: ['Cam 1 — live, sub-stream', 'Cam 2 — live, main stream', 'Cam 6 — playback, server recordings'] },
    { label: 'Yard · Gatehouse', lines: ['Cam 4 — live, sub-stream, converted to H.264 for a PC without H.265'] }]), J(a.groups))
  check('view: someone outside with nothing open', J([b.name, b.where, b.connected, b.watching, b.groups.length]) === J(['bob', 'outside', 'under a minute', 'nothing open', 0]), J(b))
  check('view: a row keeps its key from one refresh to the next', a.key === viewersView({ ...data, now: NOW + 5000 }).rows[0].key && a.key !== b.key)
  check('view: one camera is "1 camera"', viewersView({ now: NOW, viewers: [{ ...data.viewers[0], counts: { live: 1, playback: 0, other: 0, cameras: 1 } }] }).rows[0].watching === '1 camera')
}
{
  const r = viewersView({ now: NOW, viewers: [], total: 0 })
  check('view: nobody: no rows, and the words for it', r.rows.length === 0 && r.count === 0 && r.summary === '' && /Nobody has video open/.test(r.empty))
  check('view: an answer that is not one is nobody, not a crash', viewersView(null).rows.length === 0 && viewersView({ viewers: 'x' }).count === 0)
}
{
  // what the server's bounds left out is said, per person and for the list
  const cut = viewersView({ now: NOW, total: 205, viewers: [{ user: 'wall', since: NOW, remote: false, live: [cam('n1', 0, { stream: 'sub' })], playback: [], other: [], counts: { live: 140, playback: 0, other: 0, cameras: 140 } }] })
  check('view: cameras left out of one person\'s list are counted', cut.rows[0].more === '…and 139 more' && cut.rows[0].watching === '140 cameras')
  check('view: people left out are counted', cut.count === 205 && cut.more === '204 more not shown.')
  const many = viewersView({ now: NOW, viewers: Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({ user: `u${i}`, since: NOW, live: [], playback: [], other: [], counts: {} })) })
  check('view: at most MAX_ROWS rows painted', many.rows.length === MAX_ROWS && many.more === '5 more not shown.')
  check('view: a name-less session and a nameless NVR still read', viewersView({ now: NOW, viewers: [{ since: NOW, live: [{ nvr: 'n9', ch: 0, stream: 'sub' }], playback: [], other: [] }] }).rows[0].name === 'unknown' && viewersView({ now: NOW, viewers: [{ since: NOW, live: [{ nvr: 'n9', ch: 0, stream: 'sub' }] }] }).rows[0].groups[0].label === 'n9')
}

// ---- health.js and health.html wiring (source scan) ---------------------------------------------------
{
  const src = readFileSync(new URL('../public/health.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const html = readFileSync(new URL('../public/health.html', import.meta.url), 'utf8')
  const paint = src.slice(src.indexOf('const paintWatching'), src.indexOf('// The same account wiring'))
  check('health.js: asked only by an admin', /const loadWatching = \(\) => \{\n\s*if \(!isAdmin\) return\n\s*fetch\('\/api\/admin\/viewers'\)/.test(paint))
  check('health.js: on the page\'s own refresh, and once the account is known', /if \(document\.hidden\) return\n\s*loadWatching\(\)/.test(src) && /isAdmin = me\.admin === true\n\s*loadWatching\(\)/.test(src))
  check('health.js: painted as text, never as HTML', paint.length > 0 && !/innerHTML|insertAdjacentHTML|outerHTML/.test(paint) && /textContent: line/.test(paint))
  check('health.js: a row left open stays open across a refresh', /wasOpen\.has\(p\.key\)/.test(paint))
  check('health.html: the section starts hidden (shown to admins by health.js)', /<details id="watching" class="hp-history" open hidden>/.test(html) && /id="watchingRows"/.test(html) && /id="watchingNote"/.test(html))
  check('health.html: says what the list is, and points to the sign-ins', /people with video open now/.test(html) && /<a href="\/audit\.html">Audit<\/a>/.test(html))
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exitCode = failures ? 1 : 0
