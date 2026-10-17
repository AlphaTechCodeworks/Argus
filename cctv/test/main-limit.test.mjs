// Tests for the per-recorder limit on cameras in full quality (main-limit.mjs): the limits and their
// environment overrides, the decision, the join and leave bookkeeping (a socket that closes twice
// frees its place once), the refusal line once a minute per recorder, and the same through attachLive
// (live-attach.mjs): refused with the reason the page takes as "standard picture for now", a camera
// already in full quality always joined, sub-streams never counted. Fake NVRs and sockets; no SDK.
//   node cctv/test/main-limit.test.mjs
import { liveAttacher } from '../live-attach.mjs'
import { LAN_DEFAULT, MAIN_AT_LIMIT, P2P_DEFAULT, REFUSED_QUIET_MS, makeMainLimit, maxViewerMains, mayOpenMain, refusedLine } from '../main-limit.mjs'
import { MAIN_AT_LIMIT as PAGE_REASON, mainNotConvertedTitle } from '../public/live-tile.js'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}
const J = (v) => JSON.stringify(v)

// ---- the limits ----
{
  const p2p = { id: 's3', cfg: { sn: 'N1234' } }
  const lan = { id: 'gpri', cfg: { host: '10.0.0.5' } }
  check('a P2P recorder: 3', maxViewerMains(p2p, {}) === 3 && P2P_DEFAULT === 3)
  check('one on the network: 8', maxViewerMains(lan, {}) === 8 && LAN_DEFAULT === 8)
  check('the environment overrides each', maxViewerMains(p2p, { CCTV_MAX_VIEWER_MAINS_P2P: '5' }) === 5 && maxViewerMains(lan, { CCTV_MAX_VIEWER_MAINS_LAN: '2' }) === 2)
  check('...and only its own', maxViewerMains(lan, { CCTV_MAX_VIEWER_MAINS_P2P: '5' }) === 8)
  check('nonsense in the environment is ignored', maxViewerMains(p2p, { CCTV_MAX_VIEWER_MAINS_P2P: 'lots' }) === 3 && maxViewerMains(p2p, { CCTV_MAX_VIEWER_MAINS_P2P: '-1' }) === 3 && maxViewerMains(p2p, { CCTV_MAX_VIEWER_MAINS_P2P: '' }) === 3)
  check('no cfg at all: the network limit', maxViewerMains({ id: 'x' }, {}) === 8)
  const before = process.env.CCTV_MAX_VIEWER_MAINS_P2P
  process.env.CCTV_MAX_VIEWER_MAINS_P2P = '4'
  check('read at each call', maxViewerMains(p2p) === 4)
  if (before === undefined) delete process.env.CCTV_MAX_VIEWER_MAINS_P2P
  else process.env.CCTV_MAX_VIEWER_MAINS_P2P = before
}

// ---- the decision ----
{
  check('under the limit: yes', mayOpenMain(['a/1', 'a/2'], 'a/3', 3) === true)
  check('at the limit, a new camera: no', mayOpenMain(['a/1', 'a/2', 'a/3'], 'a/4', 3) === false)
  check('at the limit, a camera already in full quality: yes', mayOpenMain(new Set(['a/1', 'a/2', 'a/3']), 'a/2', 3) === true)
  check('a limit of 0: nothing new', mayOpenMain([], 'a/1', 0) === false)
}

// ---- the bookkeeping ----
{
  let t = 0
  const lines = []
  const m = makeMainLimit({ limitOf: () => 3, now: () => t, log: (l) => lines.push(l) })
  const nvr = { id: 's3' }
  const h = Array.from({ length: 8 }, (_, i) => ({ i }))
  check('three cameras let in', m.ask(nvr, 0, h[0]) === true && m.ask(nvr, 1, h[1]) === true && m.ask(nvr, 2, h[2]) === true)
  check('the fourth refused, with the reason the page knows', m.ask(nvr, 3, h[3]) === MAIN_AT_LIMIT && MAIN_AT_LIMIT === PAGE_REASON)
  check('...and the line said', J(lines) === J(['[live] s3: full quality refused for s3/4: already 3 of 3 cameras in full quality on this recorder']), J(lines))
  check('a second viewer of a camera already in full quality: let in', m.ask(nvr, 1, h[4]) === true && J(m.cameras('s3')) === J(['s3/1', 's3/2', 's3/3']))
  m.ask(nvr, 4, h[5])
  check('another refusal within the minute: no second line', lines.length === 1)
  t = REFUSED_QUIET_MS
  m.ask(nvr, 4, h[5])
  check('a minute on: said again', lines.length === 2)
  check('another recorder has its own count', m.ask({ id: 'lan' }, 0, h[6]) === true && m.cameras('lan').length === 1)
  m.leave(h[1])
  check('one of two viewers of a camera leaves: the camera still counts', m.cameras('s3').includes('s3/2') && m.ask(nvr, 5, h[7]) === MAIN_AT_LIMIT)
  m.leave(h[4])
  m.leave(h[4]) // close twice
  check('the last viewer leaves (twice): its place is freed once', J(m.cameras('s3')) === J(['s3/1', 's3/3']))
  check('...and a new camera fits again', m.ask(nvr, 5, h[7]) === true)
  m.leave({}) // never asked
  check('leave for a handle never counted: nothing happens', m.cameras('s3').length === 3)
  m.ask(nvr, 0, h[2]) // one handle asking again for another camera is moved, not counted twice
  check('a handle asking again is moved', J(m.cameras('s3')) === J(['s3/1', 's3/6']), J(m.cameras('s3')))
  check('the line itself', refusedLine({ nvr: 'gpri', camera: 'gpri/9', count: 8, max: 8 }) === '[live] gpri: full quality refused for gpri/9: already 8 of 8 cameras in full quality on this recorder')
}

// ---- through attachLive ----
{
  const mkStream = () => ({ gop: [], viewers: new Set(), add(w) { this.viewers.add(w) }, remove(w) { this.viewers.delete(w) } })
  const nvr = {
    id: 's3', cfg: { sn: 'N1234' }, liveOnline: true, streams: new Map(), codecSeen: new Map(), subHeld: () => false, subFull: () => false, mainPlaying: () => false,
    getStream(ch, type) {
      const k = `${ch}/${type}`
      if (!this.streams.has(k)) this.streams.set(k, mkStream())
      return this.streams.get(k)
    }
  }
  const fakeWs = () => {
    const onClose = []
    return {
      OPEN: 1, readyState: 1, bufferedAmount: 0, closedWith: null, send() {},
      on(ev, fn) { if (ev === 'close') onClose.push(fn); return this },
      close(code, reason) { this.closedWith = { code, reason } },
      fireClose() { for (const f of onClose) f() }
    }
  }
  const req = { socket: { remoteAddress: '192.168.1.20' }, headers: { cookie: 'c=1', 'user-agent': 'x' } }
  const lines = []
  const attach = liveAttacher({
    can: () => true, currentUser: () => 'admin', adaptiveLive: { attach() {} }, phoneLive: { attach: () => false, detach() {}, room: () => 16, has: () => false },
    track: () => {}, log: (l) => lines.push(l), now: () => 0,
    mainLimit: makeMainLimit({ limitOf: (n) => maxViewerMains(n, {}), now: () => 0, log: (l) => lines.push(l) })
  })
  const open = (ch, streamType = 0) => {
    const w = fakeWs()
    attach(w, req, { nvr, who: { user: 'admin', admin: true }, ch, streamType, clientH265: true, phone15: false })
    return w
  }
  const mains = [0, 1, 2].map((ch) => open(ch))
  check('attachLive: three cameras of a P2P recorder in full quality', mains.every((w) => w.closedWith === null && nvr.getStream(mains.indexOf(w), 0).viewers.has(w)))
  const fourth = open(3)
  check('attachLive: the fourth refused 1013 with the page\'s reason (not an error, not "hd not allowed")', J(fourth.closedWith) === J({ code: 1013, reason: MAIN_AT_LIMIT }), J(fourth.closedWith))
  check('attachLive: ...not put on the stream, and the refusal said', !nvr.getStream(3, 0).viewers.has(fourth) && lines.some((l) => l.startsWith('[live] s3: full quality refused for s3/4: already 3 of 3')))
  const sub = open(3, 1)
  check('attachLive: the same camera\'s sub-stream is never limited', sub.closedWith === null)
  const again = open(1)
  check('attachLive: a camera already in full quality is joined', again.closedWith === null)
  mains[0].fireClose()
  mains[0].fireClose()
  const now4 = open(3)
  check('attachLive: a closed viewer frees its place (closing twice frees it once)', now4.closedWith === null)
  check('attachLive: and the limit holds again after', open(4).closedWith?.reason === MAIN_AT_LIMIT)

  // a bookkeeping that throws must not cost the video
  const attach2 = liveAttacher({
    can: () => true, currentUser: () => 'admin', adaptiveLive: { attach() {} }, phoneLive: { attach: () => false, detach() {}, room: () => 16, has: () => false },
    track: () => {}, log: () => {}, now: () => 0,
    mainLimit: { ask() { throw new Error('broken') }, leave() { throw new Error('broken') } }
  })
  const w = fakeWs()
  attach2(w, req, { nvr, who: { user: 'admin' }, ch: 7, streamType: 0, clientH265: true, phone15: false })
  const letIn = w.closedWith === null && nvr.getStream(7, 0).viewers.has(w)
  let threw = false
  try {
    w.fireClose()
  } catch {
    threw = true
  }
  check('attachLive: a broken count lets the main in, and its close throws nothing', letIn && !threw)
}

// ---- what the full-size view says meanwhile ----
check('the page\'s explanation for the limit', /already sending as many cameras in full quality/.test(mainNotConvertedTitle(PAGE_REASON)) && !/H\.265/.test(mainNotConvertedTitle(PAGE_REASON)))

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exitCode = failed ? 1 : 0
