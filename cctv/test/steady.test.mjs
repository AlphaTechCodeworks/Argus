// "Steady picture" (steady.mjs): the setting's store, the cap on cameras steadied at once, the
// conversion's settings (locked to the background at 704 wide: steady-lock.mjs), giving up a conversion that fails or keeps
// falling behind, moving viewers when the setting changes or a place frees, which viewers live-attach.mjs
// sends to it, and the admin route. Fake sources, sockets and converters: no ffmpeg, no SDK.
//   node cctv/test/steady.test.mjs
import { liveAttacher } from '../live-attach.mjs'
import { buildSample } from '../metrics-history.mjs'
import { encodeFrame } from '../phone-live.mjs'
import {
  BUSY, DEFAULT_MAX, FAILED, FAILED_QUIET_MS, MOVE_CODE, MOVE_REASON, READY_REASON, STALL_RESETS, STEADY_PATH, STEADY_PRESET, STEADY_WIDTH,
  SteadyLive, handleSteady, maxSteady, steadyKey, steadyStore
} from '../steady.mjs'
import { LockTranscoder } from '../steady-lock.mjs'
import { CODEC_H264, CODEC_H265, Transcoder, ffmpegArgs } from '../transcode.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const J = JSON.stringify
const tick = () => new Promise((r) => setTimeout(r, 0))

// ---- ffmpeg's arguments ---------------------------------------------------------------------------
{
  const a = ffmpegArgs({ maxWidth: STEADY_WIDTH, deshake: true, preset: STEADY_PRESET, encThreads: 1 })
  const vf = a[a.indexOf('-vf') + 1]
  check('steadied: deshake right after the scale to 704 wide', vf === 'scale=min(704\\,iw):-2,deshake', vf)
  check('... with its own defaults (no wider search), on libx264 veryfast, one thread', !/rx=|ry=/.test(vf) && a.includes('libx264') && a[a.indexOf('-preset') + 1] === 'veryfast' && a[a.indexOf('-threads', a.indexOf('-i')) + 1] === '1')
  const plain = ffmpegArgs({ maxWidth: STEADY_WIDTH })
  check('not steadied: no deshake anywhere (every other conversion as it was)', !plain.join(' ').includes('deshake') && plain[plain.indexOf('-vf') + 1] === 'scale=min(704\\,iw):-2')
  check('... nor with deshake anything but true', !ffmpegArgs({ deshake: 'yes' }).join(' ').includes('deshake') && !ffmpegArgs({}).includes('-vf'))
  check('a steadying Transcoder is software, whatever the box has (the GPU path has no filters)', new Transcoder({ deshake: true, onFrame() {} }).encoder === 'libx264')
  // what steadies now: the lock to the background, not deshake (it followed the sway: steady-lock.mjs)
  const real = new SteadyLive({ max: 1, isOn: () => true })
  check('a steadied camera is converted by the lock to the background (LockTranscoder), not deshake', real.makeTranscoder({ onFrame() {} }) instanceof LockTranscoder)
}

// ---- the cap ----------------------------------------------------------------------------------------
check('4 cameras at once unless CCTV_STEADY_MAX says otherwise', DEFAULT_MAX === 4 && maxSteady({}) === 4)
check('CCTV_STEADY_MAX: a whole number, 0 turns it off', maxSteady({ CCTV_STEADY_MAX: '2' }) === 2 && maxSteady({ CCTV_STEADY_MAX: '0' }) === 0)
check('... silly, negative, fractional or empty: the default', ['-1', '2.5', '99', '', ' ', 'lots'].every((v) => maxSteady({ CCTV_STEADY_MAX: v }) === 4))

// ---- the store ----------------------------------------------------------------------------------------
{
  const files = {}
  const read = (f) => { if (!(f in files)) throw Object.assign(new Error('no file'), { code: 'ENOENT' }); return files[f] }
  const write = (f, d) => { files[f] = d }
  const logs = []
  const s = steadyStore({ file: 'steady.json', read, write, now: () => 1234, log: (l) => logs.push(l) })
  check('no file: nothing steadied, nothing said', !s.isOn('n1', 3) && s.list().length === 0 && logs.length === 0)
  check('switched on: on, and saved', s.set('n1', 3, true, 'mike') === true && s.isOn('n1', 3) && s.has('n1/3') && J(JSON.parse(files['steady.json'])) === J({ cameras: { 'n1/3': { by: 'mike', at: 1234 } } }))
  check('... again: nothing changes', s.set('n1', 3, true, 'ann') === false && s.list()[0].by === 'mike')
  check('another camera of the same NVR is not', !s.isOn('n1', 2) && !s.isOn('n2', 3))
  const again = steadyStore({ file: 'steady.json', read, write })
  check('read back as it was saved', again.isOn('n1', 3) && J(again.list()) === J([{ nvr: 'n1', ch: 3, by: 'mike', at: 1234 }]))
  check('switched off: off, and saved', s.set('n1', 3, false, 'mike') === true && !s.isOn('n1', 3) && J(JSON.parse(files['steady.json'])) === J({ cameras: {} }))
  const broken = steadyStore({ file: 'steady.json', read, write: () => { throw new Error('disk full') } })
  let threw = false
  try { broken.set('n1', 1, true, 'mike') } catch { threw = true }
  check('a save that fails throws, and changes nothing', threw && !broken.isOn('n1', 1))
  files['bad.json'] = '{nope'
  files['odd.json'] = J({ cameras: { 'n1/2': { by: 'x', at: 5 }, '../../etc': { by: 'x' }, 'n1/abc': {} } })
  check('an unreadable file: nothing steadied, said', steadyStore({ file: 'bad.json', read, write, log: (l) => logs.push(l) }).list().length === 0 && logs.some((l) => /unreadable/.test(l)))
  check('keys that are not a camera are not read', J(steadyStore({ file: 'odd.json', read, write }).list().map((c) => steadyKey(c.nvr, c.ch))) === J(['n1/2']))
}

// ---- the shared steadied streams ---------------------------------------------------------------------
const src = () => ({ taps: new Set(), add(t) { this.taps.add(t) }, remove(t) { this.taps.delete(t) }, send(buf) { for (const t of [...this.taps]) t.send(buf) } })
const sock = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, got: [], notes: [], handlers: {}, closedWith: null,
  send(b) { if (typeof b === 'string') this.notes.push(JSON.parse(b)); else this.got.push(b) },
  on(e, f) { (this.handlers[e] ??= []).push(f) },
  close(code, reason) { if (this.readyState === 3) return; this.readyState = 3; this.closedWith = { code, reason }; for (const f of this.handlers.close ?? []) f() } })
const frame = (i, codec = CODEC_H264) => encodeFrame(Buffer.from([0, 0, 0, 1, i % 40 === 0 ? 0x65 : 0x41, 1, 2, 3]), i % 40 === 0, codec, 1000 + i * 50)
const makers = []
const fakeMaker = (o) => {
  const x = { o, pushed: 0, resets: 0, closed: false, pending: 0, push() { this.pushed++ }, endPicture() {}, reset() { this.resets++ }, close() { this.closed = true } }
  makers.push(x)
  return x
}
{
  makers.length = 0
  const on = new Set(['n1/0', 'n1/1', 'n1/2', 'n1/3', 'n1/4', 'n1/5'])
  const logs = []
  const sl = new SteadyLive({ max: 4, isOn: (k) => on.has(k), makeTranscoder: fakeMaker, log: (l) => logs.push(l), stopDelayMs: 5 })
  const sources = [0, 1, 2, 3, 4, 5].map(() => src())
  const viewers = [0, 1, 2, 3].map((i) => {
    const ws = sock()
    check(`camera ${i + 1}: steadied (within the cap)`, sl.attach(`n1/${i}`, sources[i], ws, { camera: `n1/${i + 1}` }) === true)
    return ws
  })
  check('... each told so at once', viewers.every((ws) => J(ws.notes) === J([{ op: 'steady', on: true }])))
  check('... one shared conversion each, counted', sl.summary().running === 4 && sl.summary().cap === 4 && sl.summary().viewers === 4)
  const second = sock()
  check('a second viewer of a steadied camera joins its conversion (no place taken)', sl.attach('n1/0', sources[0], second) === true && sl.summary().running === 4 && sl.streams.get('n1/0').clients.size === 2)
  const late = sock()
  check('a fifth camera past the cap: BUSY', sl.attach('n1/4', sources[4], late, { camera: 'n1/5' }) === BUSY && sl.summary().refused === 1)
  check('... said in the log once, with how to raise it', logs.filter((l) => /no room to steady n1\/5/.test(l) && /CCTV_STEADY_MAX/.test(l)).length === 1)
  check('... and it waits for a place', sl.waiting.get('n1/4')?.has(late) === true && late.readyState === 1)
  sl.attach('n1/5', sources[5], sock())
  check('... a busy line is not said again within the minute', logs.filter((l) => /no room to steady/.test(l)).length === 1 && sl.summary().refused === 2)

  // the frames: every one converted, H.264 too, at 704 wide, steadied
  for (let i = 0; i < 14; i++) sources[0].send(frame(i))
  const x = makers[0]
  check('an H.264 camera is converted all the same (the conversion is what steadies it)', x && x.pushed > 0, String(x?.pushed))
  check('... 704 wide at most (no deshake: the converter is what steadies), veryfast on one thread, every frame kept', x.o.deshake === undefined && x.o.maxWidth === STEADY_WIDTH && x.o.preset === 'veryfast' && x.o.encThreads === 1 && x.o.keepEvery === 1, J({ ...x.o, onFrame: undefined, onFail: undefined, log: undefined }))
  x.o.onFrame(1000, true, Buffer.from([0, 0, 0, 1, 0x65, 9]))
  check('its pictures go to every viewer of the camera as H.264', viewers[0].got.length === 1 && second.got.length === 1 && viewers[0].got[0][1] === CODEC_H264)

  // a place frees: the camera that waited is moved onto it
  for (const ws of [viewers[3]]) ws.close()
  await new Promise((r) => setTimeout(r, 20)) // its linger (stopDelayMs 5), then the wake
  check('the last viewer of a camera gone: after its linger, its place frees', sl.summary().running === 3 || sl.summary().running === 4)
  check('... and the camera that waited longest is moved (closed, to connect again)', late.closedWith?.code === MOVE_CODE && late.closedWith?.reason === READY_REASON, J(late.closedWith))
  const back = sock()
  check('... and steadied when it does', sl.attach('n1/4', sources[4], back) === true && sl.summary().running === 4)

  // switched off: every viewer of that camera moved, its stream ends
  const plainViewer = sock()
  sl.watch('n1/0', viewers[0])
  sl.watch('n1/0', second)
  sl.watch('n1/0', plainViewer)
  on.delete('n1/0')
  sl.restart('n1/0')
  check('switched: every live socket of the camera is closed to connect again', [viewers[0], second, plainViewer].every((ws) => ws.readyState === 3) && plainViewer.closedWith?.code === MOVE_CODE && plainViewer.closedWith?.reason === MOVE_REASON)
  check('... its conversion ends', !sl.streams.has('n1/0') && makers[0].closed === true)
  check('... and nothing of another camera is touched', viewers[1].readyState === 1 && viewers[2].readyState === 1)
  check('a camera switched off is not wanted any more', sl.wants('n1/0') === false && sl.wants('n1/1') === true)
}

// ---- given up: failed, or falling behind again and again ------------------------------------------------
{
  makers.length = 0
  let now = 1_000_000
  const logs = []
  const sl = new SteadyLive({ max: 2, isOn: () => true, makeTranscoder: fakeMaker, log: (l) => logs.push(l), now: () => now, defer: (f) => f() })
  const s1 = src()
  const a = sock()
  sl.attach('n1/7', s1, a, { camera: 'n1/8' })
  for (let i = 0; i < 14; i++) s1.send(frame(i, CODEC_H265))
  makers[0].o.onFail(new Error('ffmpeg exited'))
  await tick()
  check('a conversion that fails: its viewers are closed (they connect again)', a.readyState === 3)
  check('... said once, with the camera and why', logs.filter((l) => /\[steady\] n1\/8: steadying failed \(ffmpeg exited\)/.test(l)).length === 1, J(logs))
  check('... and for a minute the camera is not tried again: FAILED, its own picture', sl.attach('n1/7', s1, sock()) === FAILED && sl.summary().running === 0)
  now += FAILED_QUIET_MS
  check('... after it, tried again', sl.attach('n1/7', s1, sock()) === true)

  const s2 = src()
  const b = sock()
  sl.attach('n1/9', s2, b)
  for (let i = 0; i < 14; i++) s2.send(frame(i))
  const x = makers.at(-1)
  for (let i = 0; i < STALL_RESETS; i++) { now += 1000; x.reset() }
  check(`reset ${STALL_RESETS} times in a minute (it keeps falling behind): given up`, b.readyState === 3 && sl.attach('n1/9', s2, sock()) === FAILED && logs.some((l) => /fell behind the camera 3 times/.test(l)))
  check('... the resets themselves still reached the converter', x.resets === STALL_RESETS)
}

check('off (a cap of nothing): not enabled, nothing wanted', new SteadyLive({ max: 0, isOn: () => true }).enabled === false && new SteadyLive({ max: 0, isOn: () => true }).wants('n1/0') === false)

// ---- who live-attach.mjs sends to it ---------------------------------------------------------------
const key = (codec) => encodeFrame(Buffer.from([0, 0, 0, 1, 1, 2, 3, 4]), true, codec, 1000)
const mkStream = () => ({ gop: [key(CODEC_H265)], viewers: new Set(), add(w) { this.viewers.add(w) }, remove(w) { this.viewers.delete(w) } })
const mkNvr = ({ held = false } = {}) => ({
  id: 'n1', liveOnline: true, streams: new Map(),
  codecSeen: new Map([['3:1', { codec: 'h265' }], ['3:0', { codec: 'h265' }]]),
  subHeld: () => held, subFull: () => false, mainPlaying: () => true,
  getStream(ch, type) {
    const k = `${ch}/${type}`
    if (!this.streams.has(k)) this.streams.set(k, mkStream())
    return this.streams.get(k)
  }
})
const fakeWs = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, closedWith: null, handlers: {}, sent: [], send(d) { this.sent.push(d) }, on(e, f) { (this.handlers[e] ??= []).push(f); return this }, close(code, reason) { this.closedWith = { code, reason }; this.readyState = 3 } })
const LOCAL = { socket: { remoteAddress: '192.168.1.20' }, headers: { cookie: 'c=1', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0' } }
const REMOTE = { socket: { remoteAddress: '100.64.1.2' }, headers: { cookie: 'c=1', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0' } }
const PHONE = { socket: { remoteAddress: '192.168.1.30' }, headers: { cookie: 'c=1', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148' } }

function run({ on = true, answer = true, streamType = 1, r = LOCAL, held = false, enabled = true, can = () => true } = {}) {
  const steady = { enabled, calls: [], watched: [], wants: (k) => on && k === 'n1/3', watch(k, ws) { this.watched.push(k) }, attach(k, source, ws, o) { this.calls.push({ key: k, source, ws, o }); return answer } }
  const adaptive = { calls: [], attach(viewer, a) { this.calls.push(a) } }
  const phone = { calls: [], attach(...a) { this.calls.push(a); return true }, has: () => false, room: () => 8 }
  const mainLimit = { asked: 0, ask() { this.asked++; return true }, leave() {} }
  const tracked = []
  const logs = []
  const attach = liveAttacher({ can, currentUser: () => 'ann', adaptiveLive: adaptive, phoneLive: phone, h264Fallback: null, track: (ws, req, o) => tracked.push(o), log: (l) => logs.push(l), mainLimit, steady })
  const nvr = mkNvr({ held })
  const ws = fakeWs()
  attach(ws, r, { nvr, who: { user: 'ann', admin: false }, ch: 3, streamType, clientH265: false, noH265: true, phone15: r === PHONE })
  return { ws, nvr, steady, adaptive, phone, mainLimit, tracked, logs }
}
{
  const t = run()
  check('a steadied camera\'s sub-stream: the steadied stream, from the camera\'s sub-stream', t.steady.calls.length === 1 && t.steady.calls[0].source === t.nvr.getStream(3, 1) && t.steady.calls[0].o.camera === 'n1/4')
  check('... nothing else attached, the live right watched for', t.nvr.getStream(3, 1).viewers.size === 0 && J(t.tracked) === J([{ actions: ['live'], nvr: 'n1', ch: 3 }]))
  check('... and the socket noted for the switch', J(t.steady.watched) === J(['n1/3']))
  const m = run({ streamType: 0 })
  check('the main stream asked for (the full-size view): the steadied stream too', m.steady.calls.length === 1 && m.steady.calls[0].source === m.nvr.getStream(3, 1) && m.nvr.getStream(3, 0).viewers.size === 0)
  check('... the recorder\'s full-quality limit not asked, no full-quality line', m.mainLimit.asked === 0 && !m.logs.some((l) => /full quality/.test(l)))
  const noHd = run({ streamType: 0, can: (who, action) => action !== 'live-hd' })
  check('... but without Live HD refused as before (the page then asks for the sub-stream, steadied)', noHd.ws.closedWith?.code === 1008 && noHd.steady.calls.length === 0)
  const rem = run({ r: REMOTE })
  check('a viewer from outside: steadied too, not the adaptive path', rem.steady.calls.length === 1 && rem.adaptive.calls.length === 0)
  const ph = run({ r: PHONE })
  check('a phone: steadied too, not the phone conversion', ph.steady.calls.length === 1 && ph.phone.calls.length === 0)
  const off = run({ on: false })
  check('switched off: the camera\'s own stream, as always (still noted for the switch)', off.steady.calls.length === 0 && off.nvr.getStream(3, 1).viewers.has(off.ws) && J(off.steady.watched) === J(['n1/3']))
  const busy = run({ answer: BUSY })
  check('past the cap: the camera\'s own stream, its tile told why first', busy.nvr.getStream(3, 1).viewers.has(busy.ws) && J(busy.ws.sent.slice(0, 1).map((s) => JSON.parse(s))) === J([{ op: 'steady', on: false, why: 'busy' }]))
  const failed = run({ answer: FAILED, streamType: 0 })
  check('failed: the camera\'s own stream (a main asked for: the main), told so', failed.nvr.getStream(3, 0).viewers.has(failed.ws) && JSON.parse(failed.ws.sent[0]).why === 'failed' && failed.mainLimit.asked === 1)
  const held = run({ held: true })
  check('a sub-stream the NVR holds back: not steadied (nothing to steady yet), as it was', held.steady.calls.length === 0 && held.ws.sent.length === 0)
  const dis = run({ enabled: false })
  check('the feature off: nothing asked of it, not even noted', dis.steady.calls.length === 0 && dis.steady.watched.length === 0 && dis.nvr.getStream(3, 1).viewers.has(dis.ws))
  const throwing = run()
  check('no rights: refused before anything is steadied', run({ can: () => false }).steady.calls.length === 0 && throwing.ws.closedWith === null)
}
{
  // it must not cost the video: a steady that throws leaves the normal path
  const steady = { enabled: true, wants: () => true, watch() {}, attach() { throw new Error('boom') } }
  const logs = []
  const attach = liveAttacher({ can: () => true, currentUser: () => 'ann', adaptiveLive: { attach() {} }, phoneLive: { attach: () => false }, log: (l) => logs.push(l), mainLimit: { ask: () => true, leave() {} }, steady })
  const nvr = mkNvr()
  const ws = fakeWs()
  attach(ws, LOCAL, { nvr, who: { user: 'ann' }, ch: 3, streamType: 1, clientH265: true, phone15: false })
  check('steady throwing: the camera\'s own stream, said', nvr.getStream(3, 1).viewers.has(ws) && logs.some((l) => /\[steady\] n1\/4: boom/.test(l)))
}

// ---- the route -----------------------------------------------------------------------------------------
{
  const files = {}
  const store = steadyStore({ file: 's.json', read: (f) => files[f] ?? '{}', write: (f, d) => { files[f] = d } })
  const restarted = []
  const live = { restart: (k) => restarted.push(k), summary: () => ({ running: 1, cap: 4 }) }
  const audits = []
  const deps = { user: 'mike', store, live, knownCamera: (nvr, ch) => nvr === 'n1' && ch < 16, audit: (r) => audits.push(r), log: () => {} }
  const post = (body) => handleSteady('POST', async () => body, deps)
  check('the path', STEADY_PATH === '/api/admin/steady')
  check('bad requests: 400', (await post({ nvr: '../x', ch: 1, on: true }))[0] === 400 && (await post({ nvr: 'n1', ch: -1, on: true }))[0] === 400 && (await post({ nvr: 'n1', ch: 1, on: 'yes' }))[0] === 400 && (await handleSteady('POST', async () => { throw new Error('bad json') }, deps))[0] === 400)
  check('a camera the NVR does not have: 404', (await post({ nvr: 'n1', ch: 20, on: true }))[0] === 404 && audits.length === 0)
  const [st, body] = await post({ nvr: 'n1', ch: 2, on: true })
  check('switched on: saved, its viewers moved, audited as a settings change', st === 200 && body.changed === true && store.isOn('n1', 2) && J(restarted) === J(['n1/2']) && audits.length === 1 && audits[0].action === 'settings-change' && audits[0].user === 'mike' && audits[0].target === 'n1/2' && /steady picture on for camera 3/.test(audits[0].detail))
  check('... again: unchanged, nobody moved, nothing audited', (await post({ nvr: 'n1', ch: 2, on: true }))[1].changed === false && restarted.length === 1 && audits.length === 1)
  const [, list] = await handleSteady('GET', null, deps)
  check('GET: the steadied cameras, and how many run of the cap', list.cameras.length === 1 && list.cameras[0].ch === 2 && list.running === 1 && list.cap === 4)
  check('switched off: audited too', (await post({ nvr: 'n1', ch: 2, on: false }))[1].changed === true && /off/.test(audits[1].detail) && restarted.length === 2)
  check('another method: 405', (await handleSteady('DELETE', null, deps))[0] === 405)
  const failing = { ...deps, store: steadyStore({ file: 'x', read: () => '{}', write: () => { throw new Error('disk full') } }) }
  check('a save that fails: 500, nothing moved or audited', (await handleSteady('POST', async () => ({ nvr: 'n1', ch: 1, on: true }), failing))[0] === 500 && restarted.length === 2 && audits.length === 2)
}

// ---- the minute history ----------------------------------------------------------------------------------
{
  const s = buildSample({ other: () => ({ remote: 1, playback: 0, playbackSd: 0, steady: 2, ffmpeg: 5 }) }, { t: 1 })
  check('the minute history counts the steadied cameras', s.other.steady === 2 && s.other.ffmpeg === 5)
  check('... null when not said (an older server)', buildSample({ other: () => ({ remote: 1 }) }, { t: 1 }).other.steady === null)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
