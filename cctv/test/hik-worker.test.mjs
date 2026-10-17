// A Hikvision device's worker, with a fake SDK (test/fake-hik-sdk.mjs): no SDK, no device.
//   1. hik-worker-core.mjs in this process: login, camera list, want/unwant/restart, frames out in the
//      browser's format, a stalled stream restarted, requests answered "not supported", the SDK missing.
//   2. the real child process (hik-worker.mjs) under worker-supervisor.mjs, as the server runs it:
//      ready, stats, a viewer's stream through the hub; and the test-login child (hik-test-login.mjs).
//   3. hik-nvr.mjs, the server's stand-in, on a fake supervisor.
//   node cctv/test/hik-worker.test.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NOT_INSTALLED } from '../hik-core.mjs'
import { UNSUPPORTED, makeHikWorker } from '../hik-worker-core.mjs'
import { runTestLogin } from '../hik-test-login.mjs'
import { MSG, streamKey, want, unwant, restart } from '../worker-ipc.mjs'
import { makeFakeHikSdk } from './fake-hik-sdk.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(20)
  }
  return fn()
}
const quiet = { log() {}, warn() {} }
const cfg = { id: 'hik1', name: 'Yard', site: 'Yard', brand: 'hikvision', host: '192.168.1.64', port: 8000, user: 'admin', password: 'secret' }

// ---- 1. the core ----
{
  const sdk = makeFakeHikSdk({ fps: 50, gop: 10 })
  const out = []
  let t = Date.now()
  const w = makeHikWorker({ cfg, sdk, send: (m, done) => { out.push(m); done?.(); return true }, log: quiet, now: () => t, env: {} })
  await w.start()
  check('READY first', out[0]?.t === MSG.READY)
  check('logs in with the record\'s address, port and user', await until(() => w._state.status === 'online') && sdk.calls.some((c) => c[0] === 'login' && c[1] === '192.168.1.64' && c[2] === 8000 && c[3] === 'admin'))
  const st = w.stats()
  check('stats: online, model and serial from the device, its SDK version', st.status === 'online' && st.model === 'DS-7608NI-K2' && st.serial.startsWith('DS-7608NI') && st.sdkVersion === 'V6.1.11.40', JSON.stringify([st.status, st.model, st.sdkVersion]))
  check('stats: 4 cameras from the IP channels, no passwords in it', st.channels.length === 4 && st.channels[0].ip === '192.168.254.2' && !JSON.stringify(st).includes('secret'))
  check('stats: the shape the server reads (subCap, mainPlaying, codecSeen, gen)', st.subCap && Array.isArray(st.mainPlaying) && typeof st.codecSeen === 'object' && st.gen === 1)

  w.onMessage(want(1, 1))
  check('want: the sub-stream of camera 2 starts on SDK channel 34, stream type 1', await until(() => sdk.calls.some((c) => c[0] === 'startLive' && c[2] === 34 && c[3] === 1)))
  check('frames go out for 1:1, the first one a keyframe in the 16-byte format', await until(() => out.filter((m) => m.t === MSG.FRAME && m.key === streamKey(1, 1)).length >= 5))
  const frames = out.filter((m) => m.t === MSG.FRAME)
  check('first frame: keyframe, H.264, 640 wide, Annex B after the header', frames[0].isKey && frames[0].buf[0] === 1 && frames[0].buf[1] === 0 && frames[0].buf.readUInt16LE(2) === 640 && frames[0].buf.readUInt32BE(16) === 1)
  check('codecSeen and mainPlaying in stats', JSON.stringify(w.stats().codecSeen['1:1']?.codec) === '"h264"' && w.stats().mainPlaying.length === 0)

  w.onMessage(want(0, 0))
  await until(() => w.stats().mainPlaying.includes(0))
  check('a main stream that plays is in mainPlaying', w.stats().mainPlaying.includes(0))

  const before = sdk.calls.filter((c) => c[0] === 'startLive').length
  const h = [...w._streams.values()].find((s) => s.key === '1:1').handle
  w.onMessage(restart(1, 1, 'codec changed'))
  check('restart: stopped and started again', await until(() => sdk.calls.some((c) => c[0] === 'stopLive' && c[1] === h) && sdk.calls.filter((c) => c[0] === 'startLive').length === before + 1))

  // a stream that stops delivering: restarted at the next check
  const s = [...w._streams.values()].find((x) => x.key === '0:0')
  const h0 = s.handle
  clearInterval(sdk.live.get(h0)?.timer) // the camera goes quiet
  t += 20_000
  for (const x of w._streams.values()) if (x.key !== '0:0') x.lastFrameAt = t // the other one still flows
  await w._checkStreams()
  check('a stream with no video for 15 s is stopped and started again', await until(() => sdk.calls.some((c) => c[0] === 'stopLive' && c[1] === h0) && w._streams.get('0:0').handle !== h0))

  w.onMessage(unwant(1, 1))
  check('unwant: stopped, forgotten', await until(() => !w._streams.has('1:1')))

  w.onMessage({ t: MSG.REQ, id: 7, op: 'xml' })
  const res = out.find((m) => m.t === MSG.RES && m.id === 7)
  check('a settings request is answered "not supported" (status 501)', res && res.ok === false && res.error.message === UNSUPPORTED && res.error.status === 501)
  w.onMessage({ t: MSG.SETTINGS, rec: {} })
  w.onMessage({ t: MSG.AUDIOWANT, ch: 0, on: true })
  check('recording settings and sound requests are ignored (no SDK call)', !sdk.calls.some((c) => !['init', 'login', 'ipConfig', 'startLive', 'stopLive', 'logout'].includes(c[0])))
  w.stop()
  for (const x of sdk.live.values()) clearInterval(x.timer)
}

{
  // a stream the device refuses: tried again later, with the reason
  const sdk = makeFakeHikSdk({ fps: 0, startFails: 1 })
  let t = Date.now()
  const w = makeHikWorker({ cfg, sdk, send: () => true, log: quiet, now: () => t, env: {} })
  await w.start()
  await until(() => w._state.status === 'online')
  w.onMessage(want(0, 1))
  await until(() => w._streams.get('0:1')?.error)
  check('a refused start keeps the reason', /cannot connect/.test(w._streams.get('0:1').error), w._streams.get('0:1').error)
  t += 6000
  await w._checkStreams()
  check('... and is tried again after its back-off', await until(() => w._streams.get('0:1').handle >= 0))
  w.stop()
}

{
  // wrong password: offline, with the tries left
  const sdk = makeFakeHikSdk({ login: 'password' })
  const w = makeHikWorker({ cfg, sdk, send: () => true, log: quiet, env: {} })
  await w.start()
  await until(() => w._state.status === 'offline')
  check('wrong password: offline, the plain reason with the tries left', w._state.error === 'wrong user name or password (4 tries left before the user is locked)', w._state.error)
  w.stop()
}

{
  // the SDK is not installed: the device says so, and nothing else happens
  const out = []
  const w = makeHikWorker({ cfg, sdk: null, sdkWhy: NOT_INSTALLED, send: (m) => { out.push(m); return true }, log: quiet, env: {} })
  await w.start()
  const st = out.find((m) => m.t === MSG.STATS)
  check('not installed: READY, then offline with exactly that message', out[0].t === MSG.READY && st?.status === 'offline' && st.error === 'Hikvision support is not installed on this server')
  w.onMessage(want(0, 1))
  check('... and a want does nothing', w._streams.get('0:1')?.handle === -1)
  w.stop()
}

{
  // Hik-Connect: signed in before the login only when it is fully set up
  const sdk = makeFakeHikSdk({ fps: 0 })
  const p2pCfg = { ...cfg, p2p: { enabled: true, account: 'me@example.com', password: 'pw', appId: 'A', authAddr: 'a.test', platformAddr: 'p.test', platformType: 1 } }
  const w = makeHikWorker({ cfg: p2pCfg, sdk, send: () => true, log: quiet, env: {} })
  await w.start()
  await until(() => w._state.status === 'online')
  const call = sdk.calls.find((c) => c[0] === 'p2pLogin2C')
  check('Hik-Connect ready: the 2C sign-in goes first, with exactly the stored values', call && call[1].appId === 'A' && call[1].platformType === 1 && call[1].account === 'me@example.com' && sdk.calls.indexOf(call) < sdk.calls.findIndex((c) => c[0] === 'login'))
  w.stop()
  const sdk2 = makeFakeHikSdk({ fps: 0 })
  const w2 = makeHikWorker({ cfg: { ...cfg, p2p: { enabled: false, account: 'me@example.com', password: 'pw' } }, sdk: sdk2, send: () => true, log: quiet, env: {} })
  await w2.start()
  await until(() => w2._state.status === 'online')
  check('Hik-Connect not set up: no sign-in at all', !sdk2.calls.some((c) => c[0] === 'p2pLogin2C') && w2.stats().p2p.state === 'off')
  w2.stop()
}

{
  // the Sites page's Test, in-process
  const r = await runTestLogin({ sdk: makeFakeHikSdk({ fps: 0 }), fields: { host: '192.168.1.64', port: 8000, user: 'admin', password: 'x' }, env: {} })
  check('test login: model, serial, cameras, SDK version', r.ok && r.model === 'DS-7608NI-K2' && r.serial.startsWith('DS-7608NI') && r.cameras === 4 && r.sdkVersion === 'V6.1.11.40', JSON.stringify(r))
  const bad = await runTestLogin({ sdk: makeFakeHikSdk({ login: 'password' }), fields: { host: 'h', port: 8000, user: 'u', password: 'x' }, env: {} })
  check('test login: the plain error', !bad.ok && /^wrong user name or password/.test(bad.why))
  const none = await runTestLogin({ sdk: null, sdkWhy: NOT_INSTALLED, fields: {}, env: {} })
  check('test login: not installed', !none.ok && none.why === NOT_INSTALLED)
  const slow = await runTestLogin({ sdk: makeFakeHikSdk({ login: 'timeout' }), fields: { host: 'h', port: 8000, user: 'u' }, env: {} })
  check('test login: no answer in time', !slow.ok && slow.why === 'the device did not answer in time')
}

// ---- 2. the real child processes ----
const data = mkdtempSync(join(tmpdir(), 'hik-worker-test-'))
const fake = fileURLToPath(new URL('./fake-hik-sdk.mjs', import.meta.url))
try {
  writeFileSync(join(data, 'nvrs.json'), JSON.stringify({ nvrs: [cfg] }))
  process.env.DATA_DIR = data
  const { startWorker } = await import('../worker-supervisor.mjs')
  let stats = null
  const w = startWorker('hik1', { script: './hik-worker.mjs', env: { DATA_DIR: data, CCTV_HIK_FAKE_SDK: fake, FAKE_HIK_FPS: '25' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], onStats: (s) => (stats = s) })
  check('child: ready', await until(() => w.state() === 'ready', 10_000))
  check('child: stats say online, 4 cameras', await until(() => stats?.status === 'online' && stats.channels.length === 4, 10_000), JSON.stringify(stats?.status))
  // a viewer, as live-attach.mjs adds one: the hub asks the worker, frames come back through it
  const got = []
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (b) => got.push(b), close() {} }
  const s = w.hub.getStream(2, 1)
  s.add(ws)
  check('child: a viewer gets frames through the hub, starting with a keyframe', await until(() => got.length >= 3, 10_000) && got[0][0] === 1, `${got.length} frames`)
  s.remove(ws)
  await w.stop()
  check('child: stops', w._child().exitCode !== null || w._child().signalCode !== null)

  const { testHikLogin } = await import('../hik-nvr.mjs')
  const ok = await testHikLogin({ host: '192.168.1.64', port: 8000, user: 'admin', password: 'x' }, { env: { ...process.env, CCTV_HIK_FAKE_SDK: fake, FAKE_HIK_LOGIN: 'ok' } })
  check('test-login child: the device\'s model and camera count', ok.model === 'DS-7608NI-K2' && ok.cameras === 4)
  let err = null
  await testHikLogin({ host: 'h', port: 8000, user: 'u', password: 'x' }, { env: { ...process.env, CCTV_HIK_FAKE_SDK: fake, FAKE_HIK_LOGIN: 'password' } }).catch((e) => (err = e))
  check('test-login child: the plain error', /^wrong user name or password/.test(err?.message ?? ''), err?.message)
  err = null
  await testHikLogin({ host: 'h', port: 8000, user: 'u' }, { env: { ...process.env, CCTV_HIKSDK_DIR: join(data, 'none') } }).catch((e) => (err = e))
  check('test-login child, no SDK on this machine: "not installed"', /^Hikvision support is not installed on this server/.test(err?.message ?? ''), err?.message)

  // ---- 3. the server's stand-in ----
  const { HikNvr } = await import('../hik-nvr.mjs')
  let statsFn = null
  const hub = { getStream: (ch, t) => ({ ch, t }), restartStream: () => {}, closeAll() {}, streams: new Map() }
  let st = null
  const fakeSup = (id, o) => {
    statsFn = o.onStats
    return { hub, state: () => 'ready', stats: () => st, stop: async () => {} , opts: o }
  }
  const n = new HikNvr(cfg, { startWorker: fakeSup, env: {} })
  check('stand-in: its worker is hik-worker.mjs, with the SDK on the library path', n.worker.opts.script === './hik-worker.mjs' && /hcnetsdk/.test(n.worker.opts.env.LD_LIBRARY_PATH))
  check('stand-in: connecting until the worker says', n.status === 'connecting' && !n.liveOnline)
  st = { status: 'online', gen: 1, model: 'DS-7608NI-K2', serial: 'S1', channels: [{ ch: 0, name: 'Camera 1', online: true, configured: true, ip: '192.168.254.2' }, { ch: 1, name: 'Camera 2', online: false, configured: false }], mainPlaying: [0], codecSeen: { '0:1': { codec: 'h265' } } }
  statsFn(st)
  const info = n.info()
  check('stand-in: online by its worker; model, serial, cameras', info.status === 'online' && info.brand === 'hikvision' && info.model === 'DS-7608NI-K2' && info.cameras === 1 && info.camerasOnline === 1 && info.subStreamsSeen.h265 === 1)
  check('stand-in: no control login, so the TVT-only features stay away', n.online === false && n.degraded === true && n.xmlOnline === false && n.borrowing === false && n.userId === -1)
  check('stand-in: live goes to the worker\'s hub', JSON.stringify(n.getStream(0, 1)) === '{"ch":0,"t":1}' && n.mainPlaying(0) && !n.subHeld(0))
  let rej = null
  await n.playback.recordings(0, '2026-10-16').catch((e) => (rej = e))
  check('stand-in: playback answers "not supported"', rej?.message === UNSUPPORTED)
  check('stand-in: a change of address restarts it; a new name does not', n.apply({ ...cfg, host: '192.168.1.65' }) === true && n.apply({ ...cfg, host: '192.168.1.65', name: 'Other' }) === false)
} finally {
  rmSync(data, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
