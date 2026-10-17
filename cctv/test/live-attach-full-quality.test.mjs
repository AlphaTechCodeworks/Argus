// Tests the journal's line for who opened a camera in full quality (live-attach.mjs): said when a
// viewer's request for the main stream is let in, with the account, the device, local or remote and
// the visitor's own address; once in a minute for the same viewer and camera; never for a
// sub-stream, a refusal, or a main that only stands in for a cold sub-stream.
// Fake NVRs and sockets: nothing here needs the SDK.
//   node cctv/test/live-attach-full-quality.test.mjs
import { FULL_QUALITY_QUIET_MS, fullQualityGate, fullQualityLine, liveAttacher } from '../live-attach.mjs'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}
const J = (v) => JSON.stringify(v)

// ---- should it be said now ----
{
  let t = 0
  const say = fullQualityGate({ now: () => t })
  check('the first time: yes', say('v1', 'n1/4') === true)
  check('again at once: no', say('v1', 'n1/4') === false)
  check('another camera, or another viewer: yes', say('v1', 'n1/5') === true && say('v2', 'n1/4') === true)
  t = FULL_QUALITY_QUIET_MS - 1
  check('just under a minute: still no', say('v1', 'n1/4') === false)
  t = FULL_QUALITY_QUIET_MS
  check('a minute on: yes again', say('v1', 'n1/4') === true && say('v1', 'n1/4') === false)
  // old entries are dropped as new ones come: many viewers over a day do not pile up
  let n = 0
  const sayMany = fullQualityGate({ everyMs: 10, now: () => n })
  for (n = 0; n < 5000; n++) sayMany(`v${n}`, 'n1/1')
  n = 0
  check('an entry past its quiet was forgotten', sayMany('v0', 'n1/1') === true)
}

// ---- the line ----
{
  check('the line', fullQualityLine({ user: 'ann', device: 'Windows PC · Chrome 141', remote: false, address: '192.168.1.20', camera: 'n1/4' }) === '[live] ann (Windows PC · Chrome 141, local 192.168.1.20) opened full quality n1/4')
  check('...remote, and with nothing known of the device', fullQualityLine({ user: 'bob', device: '', remote: true, address: '190.108.212.196', camera: 'gpri/12' }) === '[live] bob (unknown device, remote 190.108.212.196) opened full quality gpri/12')
}

// ---- through attachLive ----
const mkStream = () => ({ gop: [], viewers: new Set(), add(w) { this.viewers.add(w) }, remove(w) { this.viewers.delete(w) } })
const mkNvr = () => ({
  id: 'n1', liveOnline: true, streams: new Map(), codecSeen: new Map(), subHeld: () => false, subFull: () => false, mainPlaying: () => true,
  getStream(ch, type) {
    const k = `${ch}/${type}`
    if (!this.streams.has(k)) this.streams.set(k, mkStream())
    return this.streams.get(k)
  }
})
const fakeWs = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, closedWith: null, send() {}, on() { return this }, close(code, reason) { this.closedWith = { code, reason } } })
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const req = (addr = '192.168.1.20', o = {}) => ({ socket: { remoteAddress: addr }, headers: { cookie: 'c=1', 'user-agent': CHROME, ...o } })
const setup = ({ can = () => true, clientAddress, log } = {}) => {
  const lines = []
  let t = 1_000_000
  const adaptive = { calls: 0, attach() { this.calls++ } }
  const attach = liveAttacher({
    can, currentUser: () => 'ann', adaptiveLive: adaptive, phoneLive: { attach: () => false, detach() {}, room: () => 16, has: () => false },
    track: () => {}, log: log ?? ((l) => lines.push(l)), now: () => t, ...(clientAddress ? { clientAddress } : {})
  })
  const nvr = mkNvr()
  return { lines, nvr, adaptive, tick: (ms) => { t += ms }, open: (o = {}, r = req()) => { const w = fakeWs(); attach(w, r, { nvr, who: { user: 'ann' }, ch: 3, streamType: 0, clientH265: true, phone15: false, ...o }); return w } }
}
{
  const x = setup()
  const w = x.open()
  check('a main stream let in: one line, with who, what and where', J(x.lines) === J(['[live] ann (Windows PC · Chrome 141, local 192.168.1.20) opened full quality n1/4']), J(x.lines))
  check('...and the viewer is on the stream as before', x.nvr.getStream(3, 0).viewers.has(w) && w.closedWith === null)
  x.open()
  x.open()
  check('asked again within the minute: no more lines', x.lines.length === 1)
  x.open({ ch: 4 })
  check('another camera: its own line', x.lines.length === 2 && x.lines[1].endsWith('opened full quality n1/5'))
  x.open({}, req('192.168.1.20', { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1' }))
  check('another device of the same account: its own line', x.lines.length === 3 && x.lines[2].includes('(iPhone · Safari 18, local '), x.lines[2])
  x.tick(FULL_QUALITY_QUIET_MS)
  x.open()
  check('a minute later: said again', x.lines.length === 4)
}
{
  const x = setup()
  x.open({ streamType: 1 })
  check('a sub-stream is not said', x.lines.filter((l) => l.startsWith('[live]')).length === 0, J(x.lines))
  const y = setup({ can: (who, action) => action !== 'live-hd' })
  const w = y.open()
  check('full quality refused (no Live HD): closed, nothing said', w.closedWith?.code === 1008 && y.lines.length === 0)
  const z = setup({ can: () => false })
  check('no right to the camera at all: nothing said', z.open().closedWith?.code === 1008 && z.lines.length === 0)
  const s = setup()
  s.open({ streamType: 1 }) // a cold sub-stream: the main stands in for it (sub-bridge.mjs), which nobody asked for
  check('a main standing in for a cold sub-stream is not "opened full quality"', s.lines.every((l) => !l.startsWith('[live]')), J(s.lines))
}
{
  // through the tunnel the socket is cloudflared's: remote, and the address is the visitor's own
  const x = setup({ clientAddress: (r) => r.headers['cf-connecting-ip'] ?? r.socket.remoteAddress })
  x.open({}, req('127.0.0.1', { 'cf-connecting-ip': '190.108.212.196' }))
  check('a remote viewer: said as remote, with the address handed in', J(x.lines) === J(['[live] ann (Windows PC · Chrome 141, remote 190.108.212.196) opened full quality n1/4']) && x.adaptive.calls === 1, J(x.lines))
}
{
  // the line is for people: nothing about it may cost the video
  const x = setup({ clientAddress: () => { throw new Error('broken') } })
  const w = x.open()
  check('an address that cannot be read: no line, the stream all the same', x.lines.length === 0 && x.nvr.getStream(3, 0).viewers.has(w) && w.closedWith === null)
  const y = setup({ log: () => { throw new Error('journal gone') } })
  const w2 = y.open()
  check('a log that throws: the stream all the same', y.nvr.getStream(3, 0).viewers.has(w2) && w2.closedWith === null)
}

console.log(failed ? `${failed} FAILED` : 'all passed')
process.exitCode = failed ? 1 : 0
