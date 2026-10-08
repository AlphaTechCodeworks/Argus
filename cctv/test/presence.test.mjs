// Tests for makePresence (presence.mjs): distinct connected sessions, local vs remote, counted once
// whatever the number of sockets. No server, no sockets -- plain objects stand in for the sockets.
//   node cctv/test/presence.test.mjs
import { MAX_OPEN_EACH, MAX_VIEWERS, makePresence } from '../presence.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}
const J = (o) => JSON.stringify(o)

// nobody connected
{
  const p = makePresence()
  check('empty: nobody connected', J(p.summary()) === J({ people: 0, local: 0, remote: 0 }))
}

// one local viewer with several sockets (tabs/cameras) is one person
{
  const p = makePresence()
  p.join('alice', {}, { remote: false })
  p.join('alice', {}, { remote: false })
  p.join('alice', {}, { remote: false })
  check('one person, many sockets, counted once', J(p.summary()) === J({ people: 1, local: 1, remote: 0 }))
}

// local and remote split
{
  const p = makePresence()
  p.join('alice', {}, { remote: false })
  p.join('bob', {}, { remote: true })
  p.join('carol', {}, { remote: true })
  check('local vs remote split', J(p.summary()) === J({ people: 3, local: 1, remote: 2 }))
}

// a viewer is forgotten only when its LAST socket closes
{
  const p = makePresence()
  const a1 = {}
  const a2 = {}
  p.join('alice', a1, { remote: false })
  p.join('alice', a2, { remote: false })
  p.leave('alice', a1)
  check('still present with one socket left', p.summary().people === 1)
  p.leave('alice', a2)
  check('gone when the last socket closes', p.summary().people === 0)
}

// leaving an unknown key or socket is harmless
{
  const p = makePresence()
  p.join('alice', {}, {})
  p.leave('nobody', {})
  p.leave('alice', {}) // a socket that was never joined
  check('leaving an unknown socket does not drop the viewer', p.summary().people === 1)
}

// a session that moves onto the tunnel is counted as remote (its latest state)
{
  const p = makePresence()
  const s1 = {}
  p.join('alice', s1, { remote: false })
  const s2 = {}
  p.join('alice', s2, { remote: true })
  check('latest socket decides local/remote', J(p.summary()) === J({ people: 1, local: 0, remote: 1 }))
}

// ---- what each viewer has open (list: Health, "Who is watching") --------------------------------
// who it is and where from, and what it has open, by the socket or channel that holds it
{
  const p = makePresence()
  const page = {} // a page's /live-mux socket
  const t1 = {} // two of its tiles (channels)
  const t2 = {}
  p.join('alice', page, { remote: false, now: 1000, user: 'alice', address: '192.168.1.20' })
  p.open('alice', t1, { type: 'live', nvr: 'n1', ch: 0, stream: 'sub', kind: 'own' })
  const closeT2 = p.open('alice', t2, { type: 'live', nvr: 'n1', ch: 3, stream: 'main', kind: 'own' })
  const pb = {} // and a playback socket of its own
  p.join('alice', pb, { remote: false, now: 2000, user: 'alice', address: '192.168.1.20' })
  p.open('alice', pb, { type: 'playback', nvr: 'n2', ch: 5, source: 'server' })
  const { viewers, total } = p.list({ nameOf: (nvr, ch) => ({ site: 'Shop', nvrName: nvr.toUpperCase(), camera: `Cam ${ch + 1}` }) })
  const v = viewers[0]
  check('list: many sockets and channels are one viewer', total === 1 && viewers.length === 1 && v.counts.sockets === 2)
  check('list: who, from where, since the first socket', v.user === 'alice' && v.address === '192.168.1.20' && v.remote === false && v.since === 1000, J(v))
  check('list: the live streams, named', J(v.live) === J([
    { nvr: 'n1', ch: 0, site: 'Shop', nvrName: 'N1', camera: 'Cam 1', stream: 'sub', kind: 'own' },
    { nvr: 'n1', ch: 3, site: 'Shop', nvrName: 'N1', camera: 'Cam 4', stream: 'main', kind: 'own' }]), J(v.live))
  check('list: the playback and its source', J(v.playback) === J([{ nvr: 'n2', ch: 5, site: 'Shop', nvrName: 'N2', camera: 'Cam 6', source: 'server' }]), J(v.playback))
  check('list: counts', J(v.counts) === J({ sockets: 2, live: 2, playback: 1, other: 0, cameras: 3 }), J(v.counts))
  check('list: nothing of the session in it', J(Object.keys(v).sort()) === J(['address', 'counts', 'live', 'other', 'playback', 'remote', 'since', 'user']) && !Object.hasOwn(v, 'key') && !Object.hasOwn(v, 'sockets'))
  closeT2()
  check('a tile closing takes its camera off the list', p.list().viewers[0].live.length === 1 && p.list().viewers[0].counts.cameras === 2)
  p.open('alice', pb, { type: 'playback', nvr: 'n2', ch: 5, source: 'nvr' })
  check('the same socket again replaces what it had open', J(p.list().viewers[0].playback.map((x) => x.source)) === J(['nvr']))
  p.leave('alice', pb)
  check('a socket closing takes what it had open', p.list().viewers[0].playback.length === 0 && p.list().viewers[0].counts.sockets === 1)
  p.leave('alice', page)
  check('the last socket closing takes the viewer and all it had open', p.list().total === 0 && p.list().viewers.length === 0)
  check('...and a late close of one of its tiles is harmless', (() => { try { closeT2(); return p.summary().people === 0 } catch { return false } })())
}

// names that cannot be read, and things without names
{
  const p = makePresence()
  p.join('bob', {}, { remote: true, user: 'bob', address: '203.0.113.9' })
  p.open('bob', {}, { type: 'motion', nvr: 'n1', ch: 2 })
  p.open('bob', {}, { type: 'live', nvr: 'n1', ch: 2 })
  const v = p.list({ nameOf: () => { throw new Error('gone') } }).viewers[0]
  check('list: a name that cannot be read is null, not a failure', v.live[0].camera === null && v.live[0].nvr === 'n1' && v.live[0].ch === 2)
  check('list: a live stream with nothing said is the sub-stream, kind unknown', v.live[0].stream === 'sub' && v.live[0].kind === 'unknown')
  check('list: a motion search is under other; the camera counted once', J(v.other.map((x) => x.what)) === J(['motion']) && v.counts.cameras === 1 && v.remote === true)
  check('open: for a viewer that is not connected, nothing is kept', (p.open('nobody', {}, { type: 'live', nvr: 'n1', ch: 0 }), p.list().total === 1))
}

// the same camera twice the same way (two tabs) is one line
{
  const p = makePresence()
  p.join('carol', {}, { user: 'carol' })
  for (let i = 0; i < 3; i++) p.open('carol', {}, { type: 'live', nvr: 'n1', ch: 0, stream: 'sub', kind: 'own' })
  p.open('carol', {}, { type: 'live', nvr: 'n1', ch: 0, stream: 'main', kind: 'own' })
  const v = p.list().viewers[0]
  check('list: one line per camera and way of watching it', v.live.length === 2 && v.counts.live === 2 && v.counts.cameras === 1, J(v.counts))
}

// bounded
{
  const p = makePresence()
  for (let i = 0; i < MAX_VIEWERS + 25; i++) p.join(`v${i}`, {}, { user: `user${i}`, now: i })
  for (let ch = 0; ch < MAX_OPEN_EACH + 40; ch++) p.open('v0', {}, { type: 'live', nvr: 'n1', ch, stream: 'sub', kind: 'own' })
  const { viewers, total } = p.list()
  check('list: at most MAX_VIEWERS viewers, the total still said', viewers.length === MAX_VIEWERS && total === MAX_VIEWERS + 25 && MAX_VIEWERS === 200)
  check('list: longest connected first', viewers[0].user === 'user0' && viewers[1].user === 'user1')
  check('list: at most MAX_OPEN_EACH cameras each, the count still whole', viewers[0].live.length === MAX_OPEN_EACH && viewers[0].counts.live === MAX_OPEN_EACH + 40 && MAX_OPEN_EACH === 100)
  check('list: tighter bounds when asked', p.list({ maxViewers: 3, maxEach: 2 }).viewers.length === 3 && p.list({ maxViewers: 3, maxEach: 2 }).viewers[0].live.length === 2)
  check('summary still counts everyone', p.summary().people === MAX_VIEWERS + 25)
}

// a name or address with control characters, or far too long, is cut to plain text
{
  const p = makePresence()
  p.join('k', {}, { user: `eve\n${'x'.repeat(200)}`, address: 'a'.repeat(100) })
  const v = p.list().viewers[0]
  check('list: name and address are bounded, single-line text', v.user.length === 64 && !v.user.includes('\n') && v.address.length === 45)
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
