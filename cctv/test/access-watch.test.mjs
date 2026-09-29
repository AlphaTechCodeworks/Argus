// Open video sockets looked at again (access-watch.mjs): a camera taken away, an account removed or a
// session signed out ends the /live sockets, /live-mux channels and /playback sockets already showing
// it, not only the next one. Real auth.mjs, rights.mjs, live-mux.mjs and live-attach.mjs in a temp
// DATA_DIR; fake sockets, fake streams and no timers of its own: no SDK, nothing reaches an NVR.
//   node cctv/test/access-watch.test.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'access-watch-'))
process.env.DATA_DIR = DIR
writeFileSync(join(DIR, 'users.json'), JSON.stringify({ boss: { hash: 'x', role: 'admin' }, alice: { hash: 'x', role: 'viewer' } }))
const ALICE = { live: ['nvr-2/5', 'nvr-2/6'], 'live-hd': ['nvr-2/5', 'nvr-2/6'], 'playback-server': ['nvr-2/5'], 'playback-nvr': ['nvr-2/5'] }
writeFileSync(join(DIR, 'rights.json'), JSON.stringify({ version: 1, users: { alice: { grants: ALICE } } }))

const auth = await import('../auth.mjs')
const rights = await import('../rights.mjs')
const { serveMux } = await import('../live-mux.mjs')
const { liveAttacher } = await import('../live-attach.mjs')
const { accessWatch } = await import('../access-watch.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const tick = () => new Promise((r) => setImmediate(r))
const J = JSON.stringify

/** A socket as ws has it, as far as the mux, live-attach and the watch use it. close() emits 'close' on a later tick, as ws does. */
class FakeWs {
  constructor() {
    this.OPEN = 1
    this.readyState = 1
    this.bufferedAmount = 0
    this.sent = []
    this.handlers = {}
    this.closedWith = null
    this.closes = 0
  }
  on(ev, fn) { (this.handlers[ev] ??= []).push(fn); return this }
  emit(ev, ...a) { for (const fn of this.handlers[ev] ?? []) fn(...a) }
  send(d, opts, cb) { if (typeof opts === 'function') cb = opts; this.sent.push(d); cb?.() }
  close(code, reason) {
    this.closes++
    if (this.readyState !== 1) return
    this.readyState = 2
    this.closedWith = { code, reason }
    setImmediate(() => { this.readyState = 3; this.emit('close', code) })
  }
  terminate() { this.close(1006, '') }
  msg(o) { this.emit('message', Buffer.from(JSON.stringify(o)), false) }
  texts() { return this.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d)) }
}

const frame = () => Buffer.alloc(24, 1)
const mkStream = () => ({ gop: [frame()], viewers: new Set(), add(w) { this.viewers.add(w) }, remove(w) { this.viewers.delete(w) } })
const streams = new Map() // ch -> the main stream of nvr-2's camera ch
const NVR = { id: 'nvr-2', liveOnline: true, getStream(ch) { if (!streams.has(ch)) streams.set(ch, mkStream()); return streams.get(ch) } }
const reqWith = (token) => ({ socket: { remoteAddress: '192.168.1.20' }, headers: { 'user-agent': 'Desktop', cookie: `${auth.COOKIE_NAME}=${token}` } })
// as server.mjs has them
const currentUser = (req) => auth.verifySession(auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME])
const isAdmin = (u) => auth.isAdmin(u)

let tickFn = null
const watch = accessWatch({ currentUser, isAdmin, can: rights.can, every: (fn) => { tickFn = fn; return null } })
let stopRightsHook = rights.onRightsSaved(watch.sweepSoon)
auth.onUsersChanged(watch.sweepSoon)
const attachLive = liveAttacher({ can: rights.can, currentUser, adaptiveLive: { attach() {} }, phoneLive: { attach: () => false }, track: watch.track })
const whoOf = (u) => ({ user: u, admin: auth.isAdmin(u) })

/** A /live socket, attached as server.mjs attaches one. */
function live(req, ch) {
  const ws = new FakeWs()
  attachLive(ws, req, { nvr: NVR, who: whoOf(currentUser(req)), ch, streamType: 0, clientH265: false, phone15: false })
  return ws
}
/** A /playback socket as server.mjs tracks it: server playback with NVR legs needs both rights. */
function playback(req, ch, actions) {
  const ws = new FakeWs()
  watch.track(ws, req, { actions, nvr: NVR.id, ch })
  return ws
}

check('the timer is set up (a hand-edited file, adduser.mjs and a session running out are caught by it)', typeof tickFn === 'function')

// ---- (a) a mux channel: the camera taken away ends that channel; the page's other tiles carry on
let token = auth.createSession('alice')
let req = reqWith(token)
const page = new FakeWs()
serveMux(page, {
  session: () => currentUser(req),
  attach: (channel, sub, user) => attachLive(channel, req, { nvr: NVR, who: whoOf(user), ch: sub.ch, streamType: sub.stream, clientH265: false, phone15: false }),
  log: () => {}
})
page.msg({ op: 'sub', id: 1, nvr: 'nvr-2', ch: 5, stream: 0 })
page.msg({ op: 'sub', id: 2, nvr: 'nvr-2', ch: 6, stream: 0 })
page.msg({ op: 'sub', id: 3, nvr: 'nvr-2', ch: 7, stream: 0 }) // not hers: refused at once, never tracked
await tick()
check('(a) two channels attached, the third refused', streams.get(5).viewers.size === 1 && streams.get(6).viewers.size === 1 && page.texts().some((t) => t.id === 3 && t.code === 1008))
check('(a) only the attached channels are watched', watch.size() === 2, String(watch.size()))
const srvLegs = playback(req, 5, ['playback-server', 'playback-nvr']) // (b) below
const srvOnly = playback(req, 5, ['playback-server'])
rights.saveRights('alice', { grants: { ...ALICE, live: ['nvr-2/6'] } })
await tick() // the save's sweep (onRightsSaved -> sweepSoon)
await tick() // the channel's close handlers (live-mux.mjs runs them on a later tick)
check('(a) saving the rights ends the channel of the camera taken away: "end" 1008 "not allowed"', page.texts().some((t) => t.op === 'end' && t.id === 1 && t.code === 1008 && t.reason === 'not allowed'), J(page.texts()))
check('(a) ... and it has left the stream', streams.get(5).viewers.size === 0)
check('(a) the other tile still plays, and the page\'s socket stays open', streams.get(6).viewers.size === 1 && page.closedWith === null && !page.texts().some((t) => t.id === 2))

// ---- (b) playback sockets: each needs the rights of what it plays, as they are now
check('(b) playback of a camera still allowed stays open', srvLegs.closedWith === null && srvOnly.closedWith === null)
rights.saveRights('alice', { grants: { ...ALICE, live: ['nvr-2/6'], 'playback-nvr': [] } })
await tick()
check('(b) NVR playback taken away: a server playback filling its gaps from the NVR is closed 1008 "not allowed"', srvLegs.closedWith?.code === 1008 && srvLegs.closedWith.reason === 'not allowed', J(srvLegs.closedWith))
check('(b) ... one playing the server\'s recordings only stays open', srvOnly.closedWith === null)
rights.saveRights('alice', { grants: { live: ['nvr-2/6'], 'live-hd': ['nvr-2/6'] } })
await tick()
check('(b) server playback taken away too: closed 1008 "not allowed"', srvOnly.closedWith?.code === 1008 && srvOnly.closedWith.reason === 'not allowed')

// ---- (c) the timer alone: a change this process did not make (hand edit, adduser.mjs)
stopRightsHook()
const tile = live(req, 6)
check('(c) a /live socket on a camera she may watch plays', tile.closedWith === null && streams.get(6).viewers.has(tile))
rights.saveRights('alice', { grants: {} })
await tick()
check('(c) with no hook to say so, it plays on until the timer', tile.closedWith === null)
tickFn()
await tick()
check('(c) the timer\'s sweep closes it 1008 "not allowed", and it leaves the stream', tile.closedWith?.code === 1008 && tile.closedWith.reason === 'not allowed' && !streams.get(6).viewers.has(tile))
check('(c) ... the mux channel of that camera ended the same way', page.texts().some((t) => t.op === 'end' && t.id === 2 && t.code === 1008))
tickFn()
await tick()
check('(c) a closed socket is not closed again by the next sweep', tile.closes === 1, String(tile.closes))
stopRightsHook = rights.onRightsSaved(watch.sweepSoon)

// ---- (d) the account removed: every socket of hers closes "signed out"
rights.saveRights('alice', { grants: ALICE })
const bossReq = reqWith(auth.createSession('boss'))
const bossTile = live(bossReq, 9) // an admin: rights.json names no camera of his
const d1 = live(req, 5)
const d2 = playback(req, 5, ['playback-nvr'])
await tick()
check('(d) her sockets play again once the rights are back', d1.closedWith === null && d2.closedWith === null)
auth.saveUsers({ boss: { hash: 'x', role: 'admin' } })
await tick()
check('(d) removing her account closes every socket of hers 1008 "signed out"', [d1, d2].every((w) => w.closedWith?.code === 1008 && w.closedWith.reason === 'signed out'), J([d1.closedWith, d2.closedWith]))
check('(d) an admin\'s socket stays open whatever rights.json says', bossTile.closedWith === null)

// ---- (e) signing out: the token is refused from then on, and the sockets it opened close
const oldToken = token
await new Promise((r) => setTimeout(r, 5)) // the account made again a moment after the old token
auth.saveUsers({ boss: { hash: 'x', role: 'admin' }, alice: { hash: 'x', role: 'viewer', since: Date.now() } })
rights.saveRights('alice', { grants: ALICE })
check('(e) a token issued before the account was made again is refused', auth.verifySession(oldToken) === null)
token = auth.createSession('alice')
req = reqWith(token)
const e1 = live(req, 5)
check('(e) a fresh session plays', auth.verifySession(token) === 'alice' && e1.closedWith === null)
check('(e) revokeSession: only a session that is still good is written down', auth.revokeSession('junk') === false && auth.revokeSession(oldToken) === false)
check('(e) signing out revokes the token', auth.revokeSession(token) === true && auth.verifySession(token) === null)
await tick()
check('(e) ... and its sockets close 1008 "signed out"', e1.closedWith?.code === 1008 && e1.closedWith.reason === 'signed out', J(e1.closedWith))
{
  const file = join(DIR, 'revoked-sessions.json')
  const again = await import('../auth.mjs?restarted') // a fresh module: the server after a restart
  check('(e) the revocation survives a restart', existsSync(file) && again.verifySession(token) === null && again.verifySession(auth.createSession('alice')) === 'alice')
  check('(e) the file holds signatures, never a whole token', !readFileSync(file, 'utf8').includes(token))
}
check('(e) another session of hers is not signed out with it', auth.verifySession(auth.createSession('alice')) === 'alice')

// ---- (f) the watch itself
{
  const w = new FakeWs()
  let calls = 0
  const odd = accessWatch({ currentUser: () => 'alice', isAdmin: () => false, can: () => { calls++; throw new Error('broken') }, every: () => null })
  odd.track(w, {}, { actions: ['live'], nvr: 'nvr-2', ch: 5 })
  odd.sweep()
  check('(f) a check that throws is a no: the socket is closed 1008 "not allowed"', calls === 1 && w.closedWith?.code === 1008 && w.closedWith.reason === 'not allowed')
  const gone = new FakeWs()
  gone.readyState = 3
  odd.track(gone, {}, { actions: ['live'], nvr: 'nvr-2', ch: 5 })
  check('(f) a socket already closed is not tracked (its close event has been and gone)', odd.size() === 0)
  const shared = { n: 0 }
  const many = accessWatch({ currentUser: () => { shared.n++; return 'boss' }, isAdmin: () => true, can: () => true, every: () => null })
  const r = {}
  for (let i = 0; i < 5; i++) many.track(new FakeWs(), r, { actions: ['live'], nvr: 'nvr-2', ch: i })
  many.sweep()
  check('(f) one session check per request per sweep (a page\'s channels share its upgrade request)', shared.n === 1, String(shared.n))
  let soon = 0
  const coalesce = accessWatch({ currentUser: () => null, isAdmin: () => false, can: () => false, every: () => null, defer: (fn) => { soon++; setImmediate(fn) } })
  coalesce.sweepSoon(); coalesce.sweepSoon(); coalesce.sweepSoon()
  check('(f) several saves in a row: one sweep', soon === 1)
  await tick()
}
await tick()
check('(f) nothing closed is left in the watch', watch.size() === 1, `${watch.size()} (the admin's tile)`)

// ---- (g) needs any one of which will do, and why a socket is closed (stream rights) -----------------
{
  let allowed = {}
  const g = accessWatch({ currentUser: (r) => r.user, isAdmin: () => false, can: (who, a) => allowed[a] === true, every: () => null })
  const ann = { user: 'ann' }
  const nvrMain = new FakeWs()
  g.track(nvrMain, ann, { actions: ['playback-nvr', ['live-hd', 'playback-server']], nvr: 'n', ch: 1 })
  const liveMain = new FakeWs()
  g.track(liveMain, ann, { actions: ['live', 'live-hd'], nvr: 'n', ch: 1 })
  const sub = new FakeWs()
  g.track(sub, ann, { actions: ['live'], nvr: 'n', ch: 1 })
  allowed = { live: true, 'playback-nvr': true, 'playback-server': true }
  g.sweep()
  check('(g) an any-of group is met by one of its actions (Playback HD for the NVR\'s main stream)', nvrMain.closedWith === null)
  check('(g) Live HD gone, Live kept: the live main socket closes 1008 "hd not allowed"', liveMain.closedWith?.code === 1008 && liveMain.closedWith.reason === 'hd not allowed', J(liveMain.closedWith))
  check('(g) ... the sub-stream socket stays', sub.closedWith === null)
  allowed = { live: true, 'playback-nvr': true }
  g.sweep()
  check('(g) neither action of the group: the NVR main socket closes "hd not allowed"', nvrMain.closedWith?.reason === 'hd not allowed', J(nvrMain.closedWith))
  const both = new FakeWs()
  g.track(both, ann, { actions: ['playback-nvr', ['live-hd', 'playback-server']], nvr: 'n', ch: 1 })
  allowed = {}
  g.sweep()
  check('(g) a plain need gone as well: "not allowed", not "hd not allowed"', both.closedWith?.reason === 'not allowed' && sub.closedWith?.reason === 'not allowed', J([both.closedWith, sub.closedWith]))
  const gone = new FakeWs()
  g.track(gone, { user: null }, { actions: ['live', 'live-hd'], nvr: 'n', ch: 1 })
  g.sweep()
  check('(g) no session: "signed out", whatever the needs', gone.closedWith?.reason === 'signed out')
  const group = ['live-hd', 'playback-server']
  const kept = new FakeWs()
  g.track(kept, ann, { actions: ['playback-nvr', group], nvr: 'n', ch: 1 })
  group.pop() // the caller changing its array afterwards
  allowed = { 'playback-nvr': true, 'playback-server': true }
  g.sweep()
  check('(g) track keeps its own copy of a group', kept.closedWith === null)
  await tick()
}

// ---- (h) Live HD taken away, Live kept: the main stream goes, the sub-stream stays (real rights) -------
{
  const mk = (gop) => ({ gop, viewers: new Set(), add(w) { this.viewers.add(w) }, remove(w) { this.viewers.delete(w) } })
  const cams = new Map()
  // ch 5's sub-stream is not running (cold): with Live HD its main stream stands in
  const NVR2 = { id: 'nvr-2', liveOnline: true, getStream(ch, type) { const k = `${ch}/${type}`; if (!cams.has(k)) cams.set(k, mk(type === 1 && ch === 5 ? [] : [frame()])); return cams.get(k) } }
  rights.saveRights('alice', { grants: ALICE })
  const hreq = reqWith(auth.createSession('alice'))
  const attachAs = (ch, streamType) => { const ws = new FakeWs(); attachLive(ws, hreq, { nvr: NVR2, who: whoOf('alice'), ch, streamType, clientH265: true, phone15: false }); return ws }
  const main6 = attachAs(6, 0)
  const sub6 = attachAs(6, 1)
  const cold5 = attachAs(5, 1)
  // and a page's /live-mux channel on the same cold sub-stream
  const page2 = new FakeWs()
  serveMux(page2, {
    session: () => currentUser(hreq),
    attach: (channel, sub, user) => attachLive(channel, hreq, { nvr: NVR2, who: whoOf(user), ch: sub.ch, streamType: sub.stream, clientH265: true, phone15: false }),
    log: () => {}
  })
  page2.msg({ op: 'sub', id: 21, nvr: 'nvr-2', ch: 5, stream: 1 })
  await tick()
  check('(h) with Live HD: the main stream plays, and a cold sub-stream (a socket, a mux channel) is shown the main stream meanwhile, no wait notice', cams.get('6/0').viewers.has(main6) && cams.get('5/0').viewers.size === 2 && cold5.texts().length === 0 && page2.texts().length === 0, J(page2.texts()))
  rights.saveRights('alice', { grants: { ...ALICE, 'live-hd': [] } })
  await tick()
  await tick()
  check('(h) Live HD taken away: the main socket closes 1008 "hd not allowed"', main6.closedWith?.code === 1008 && main6.closedWith.reason === 'hd not allowed', J(main6.closedWith))
  check('(h) ... the sub-stream socket stays open', sub6.closedWith === null && cams.get('6/1').viewers.has(sub6))
  check('(h) ... both stand-ins end; the socket and the mux channel stay on their own sub-stream', cams.get('5/0').viewers.size === 0 && cold5.closedWith === null && cams.get('5/1').viewers.has(cold5) && cams.get('5/1').viewers.size === 2 && !page2.texts().some((t) => t.op === 'end'), J(page2.texts()))
  check('(h) ... and each is told why it waits from then on, as a tile without Live HD is (live-wait.mjs)', J(cold5.texts()) === '[{"op":"wait","why":"starting"}]' && J(page2.texts()) === '[{"op":"wait","why":"starting","id":21}]', J([cold5.texts(), page2.texts()]))
  rights.saveRights('alice', { grants: { live: [] } })
  await tick()
  await tick()
  check('(h) Live taken away too: the rest close "not allowed"', sub6.closedWith?.reason === 'not allowed' && cold5.closedWith?.reason === 'not allowed' && page2.texts().some((t) => t.op === 'end' && t.id === 21 && t.reason === 'not allowed'), J(page2.texts()))
}

// ---- server.mjs wiring (source shape: importing server.mjs starts the NVRs)
{
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  check('server.mjs: one watch, with the session and the rights as the upgrade has them', /const watch = accessWatch\(\{ currentUser, isAdmin: \(u\) => AUTH_OFF \|\| auth\.isAdmin\(u\), can \}\)/.test(src))
  check('server.mjs: a sweep when rights or accounts are saved', /onRightsSaved\(watch\.sweepSoon\)/.test(src) && /auth\.onUsersChanged\(watch\.sweepSoon\)/.test(src))
  check('server.mjs: every /live socket and mux channel is tracked (liveAttacher)', /const attachLive = liveAttacher\(\{ can, currentUser, isAdmin: \(u\) => AUTH_OFF \|\| auth\.isAdmin\(u\), adaptiveLive, phoneLive, track: watch\.track \}\)/.test(src))
  const pb = src.slice(src.indexOf("if (url.pathname === '/playback') {"))
  check('server.mjs: a /playback socket is watched for what connectPlayback decided', /connectPlayback\(\{[^}]*allowedMain, onMain \}\)[\s\S]{0,400}if \(session\) watch\.track\(ws, req, \{ actions: session\.actions, nvr: nvr\.id, ch: target\.ch \}\)/.test(pb.slice(0, 3000)))
  check('server.mjs: an NVR session going over to main is watched for the main-stream rights, and asked at once (a sweep)', /const onMain = \(\) => \{\s*watch\.track\(ws, req, \{ actions: NVR_MAIN_ACTIONS, nvr: nvr\.id, ch: target\.ch \}\)\s*watch\.sweepSoon\(\)\s*\}/.test(pb.slice(0, 3000)))
  check('server.mjs: "may see main" is asked from the session as it is then, not the upgrade\'s who (a demoted admin)', /const allowedMain = \(_who, nvrId, ch\) => \{\s*const u = currentUser\(req\)\s*return Boolean\(u\) && mayHd\(\{ user: u, admin: AUTH_OFF \|\| auth\.isAdmin\(u\) \}, nvrId, ch\)\s*\}/.test(pb.slice(0, 3000)))
  const motion = src.slice(src.indexOf("if (url.pathname === '/motion') {"))
  check('server.mjs: a /motion socket is tracked (playback-nvr) before the search starts', /watch\.track\(ws, req, \{ actions: \['playback-nvr'\]/.test(motion.slice(0, motion.indexOf('motionScan('))))
  const logout = src.slice(src.indexOf("if (pathname === '/api/logout'"), src.indexOf("if (pathname === '/api/logout'") + 900)
  check('server.mjs: signing out revokes the session token before the cookie is cleared', /auth\.revokeSession\(/.test(logout) && logout.indexOf('auth.revokeSession(') < logout.indexOf('auth.clearCookie()'))
}

rmSync(DIR, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
