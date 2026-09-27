// Tests for the live worker (CCTV_LIVE_WORKER=on): nvr-worker.mjs, worker-supervisor.mjs and the
// wiring in nvrs.mjs. Fake SDK only (test/fake-sdk.mjs), hosts *.invalid: nothing reaches an NVR.
// Run:  node cctv/test/live-worker.test.mjs
import { fork } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const print = console.log.bind(console)
let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; print(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const until = async (pred, ms = 8000) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50)); return pred() }

const data = mkdtempSync(join(tmpdir(), 'cctv-worker-'))
writeFileSync(join(data, 'nvrs.json'), JSON.stringify({ nvrs: [{ id: 'w1', site: 'T', name: 'W1', host: 'w1.invalid', port: 6036, user: 'u', password: 'p' }] }))
process.env.DATA_DIR = data
process.env.CCTV_WORKER_FAKE_SDK = '1'

// ---- I1: a worker's watchdog keeps its own files; the main app's crash-loop guard ignores them
{
  const { spawn } = await import('node:child_process')
  const { existsSync, readFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'wdw-'))
  const wd = new URL('../watchdog.mjs', import.meta.url).href
  const code = `
    import { startWatchdog } from '${wd}'
    import { sdkCallT } from '${new URL('../sdk.mjs', import.meta.url).href}'
    startWatchdog()
    sdkCallT({ timeoutMs: 200, tag: 'stuck' }, { async() {} }).catch(() => {})
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, DATA_DIR: dir, CCTV_WORKER_NVR: 'w9', WATCHDOG_GRACE_MS: '0', WATCHDOG_CHECK_MS: '200', WATCHDOG_MAX_CALL_MS: '1000' },
    stdio: ['ignore', 'ignore', 'ignore']
  })
  const sig = await new Promise((r) => child.on('exit', (_c, s) => r(s)))
  check('worker watchdog trips', sig === 'SIGKILL')
  check('worker watchdog writes its own files', existsSync(join(dir, 'restarts-w9.json')) && existsSync(join(dir, 'last-hang-w9.json')))
  check("worker watchdog leaves the main app's files alone", !existsSync(join(dir, 'restarts.json')) && !existsSync(join(dir, 'last-hang.json')))
  // many recent worker restarts: the main app still starts at once and reports no hang of its own
  writeFileSync(join(dir, 'restarts-w9.json'), JSON.stringify([1, 2, 3, 4, 5].map(() => Date.now())))
  const probe = spawn(process.execPath, ['--input-type=module', '-e', `import { startupDelayMs, lastHang } from '${wd}'; console.log(JSON.stringify({ d: startupDelayMs(), h: lastHang() }))`], { env: { ...process.env, DATA_DIR: dir, CCTV_WORKER_NVR: '' }, stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  probe.stdout.on('data', (d) => (out += d))
  await new Promise((r) => probe.on('exit', r))
  let res = null
  try { res = JSON.parse(out) } catch {}
  check("main app's startupDelayMs and lastHang ignore worker files", res?.d === 0 && res?.h === null, out.trim())
  void readFileSync
}

// ---- Task 3: the worker process on its own
{
  const child = fork(new URL('../nvr-worker.mjs', import.meta.url), [], { serialization: 'advanced', stdio: ['ignore', 'pipe', 'inherit', 'ipc'], env: { ...process.env, CCTV_WORKER_NVR: 'w1' } })
  const got = []
  let wout = ''
  child.stdout.on('data', (d) => (wout += d))
  child.on('message', (m) => got.push(m))
  check('worker says ready', await until(() => got.some((m) => m.t === 'ready')))
  child.send({ t: 'want', ch: 2, type: 1 })
  check('frames arrive for the wanted stream', await until(() => got.some((m) => m.t === 'frame' && m.key === '2:1')))
  const first = got.find((m) => m.t === 'frame')
  check('frames are Buffers with the key flag', first?.buf instanceof Uint8Array && first.isKey === (first.buf[0] === 1))
  check('the first frame is a keyframe', first?.isKey === true)
  // I2: restart message restarts the worker's LiveStream
  await until(() => wout.includes('stream w1/3:sub started'))
  child.send({ t: 'restart', ch: 2, type: 1, why: 'sub-stream codec changed' })
  check('restart message restarts the stream in the worker', await until(() => wout.includes('stream w1/3:sub sub-stream codec changed, restarting'), 3000), wout.split('\n').slice(-3).join(' | '))
  child.send({ t: 'unwant', ch: 2, type: 1 })
  await new Promise((r) => setTimeout(r, 400))
  const n = got.filter((m) => m.t === 'frame').length
  await new Promise((r) => setTimeout(r, 400))
  check('unwant stops the frames', got.filter((m) => m.t === 'frame').length === n)
  child.send({ t: 'stop' })
  check('worker exits on stop', await until(() => child.exitCode !== null || child.signalCode !== null))
}

// ---- the sub-bridge's background WANT for a main never makes the worker start one; a stopping
// worker makes no SDK call (no StopLivePlay, no Logout) and re-creates no camera
{
  const { readdirSync } = await import('node:fs')
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const loc = mkdtempSync(join(tmpdir(), 'rec-bridge-'))
  writeFileSync(join(loc, '.cctv-recordings'), '{}')
  const DEFAULTS = { mode: 'off', fullDays: 30, after: 'timelapse', timelapseS: 10, retentionDays: 183, preS: 10, postS: 20 }
  const settings = (cameras) => ({ t: 'settings', recording: { defaults: DEFAULTS, cameras }, locations: [{ id: 'LB', path: loc, role: 'main' }] })
  const child = fork(new URL('../nvr-worker.mjs', import.meta.url), [], { serialization: 'advanced', stdio: ['ignore', 'pipe', 'inherit', 'ipc'], env: { ...process.env, CCTV_WORKER_NVR: 'w1', CCTV_FAKE_LOG_CALLS: '1' } })
  let wout = ''
  child.stdout.on('data', (d) => (wout += d))
  const got = []
  child.on('message', (m) => got.push(m))
  const plays = (key) => (wout.match(new RegExp(`^\\[fake-sdk\\] LivePlay ${key}$`, 'gm')) ?? []).length
  const framesOf = (key) => got.some((m) => m.t === 'frame' && m.key === key)
  check('bridge: worker ready and logged in', (await until(() => got.some((m) => m.t === 'ready'))) && (await until(() => wout.includes('logged in'))))
  child.send(settings({}))
  child.send({ t: 'want', ch: 4, type: 0, background: true }) // what the sub-bridge sends for a cold sub tile
  await sleep(2000)
  check('bridge: a background main WANT, camera not recorded on its main: no LivePlay after 2 s', plays('4:0') === 0 && !framesOf('4:0'), `${plays('4:0')} LivePlay`)
  child.send(settings({ 'w1/5': { mode: 'continuous' } }))
  check("bridge: the recorder's own main starts", await until(() => wout.includes('stream w1/6:main started'), 5000))
  child.send({ t: 'want', ch: 5, type: 0, background: true })
  check("bridge: with the camera recorded on its main, the tap joins the recorder's pull (frames arrive)", await until(() => framesOf('5:0'), 3000))
  await sleep(500)
  check('bridge: ... with no extra LivePlay', plays('5:0') === 1, `${plays('5:0')} LivePlay`)
  child.send({ t: 'want', ch: 4, type: 0, background: false }) // a viewer opens that camera full size
  check('bridge: a foreground main WANT still starts it', await until(() => plays('4:0') === 1 && framesOf('4:0'), 3000), `${plays('4:0')} LivePlay`)

  child.send({ t: 'want', ch: 7, type: 1 }) // a viewer's sub
  check('stop: a wanted sub plays', await until(() => framesOf('7:1'), 3000))
  check('stop: the recorder writes', await until(() => walk(loc).some((f) => f.endsWith('.h264')), 5000))
  await sleep(300)
  const mark = wout.length
  const at = got.length
  const t0 = Date.now()
  child.send({ t: 'stop' })
  check('stop: the process exits within 6 s', await until(() => child.exitCode !== null || child.signalCode !== null, 6000), `${Date.now() - t0} ms, ${child.signalCode ?? child.exitCode}`)
  const after = wout.slice(mark)
  check('stop: no StopLivePlay and no Logout', !/^\[fake-sdk\] (StopLivePlay|Logout)/m.test(after), after.split('\n').filter((l) => l.startsWith('[fake-sdk]')).join(' | '))
  const off = after.indexOf('recording off')
  check("stop: no 'recording on' after 'recording off'", off >= 0 && !after.slice(off).includes('recording on'), after.split('\n').filter((l) => l.includes('recording o')).join(' | '))
  const seg = got.slice(at).find((m) => m.t === 'segment' && m.ch === 5)
  check('stop: the segment is closed and reported', seg?.bytes > 0 && seg.path.startsWith(loc), JSON.stringify(seg))
}

// ---- an NVR that plays only so many sub-streams at once (value4u: 15; sub-cap.mjs): the worker
// learns the limit from two "cannot connect" refusals, stops asking for the refused ones, holds
// warm-ups back below it, and lets a held viewer take a warm-up's place
{
  const { existsSync, readFileSync } = await import('node:fs')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const capData = mkdtempSync(join(tmpdir(), 'cctv-subcap-')) // its own sub-cap-w1.json, not the other tests'
  writeFileSync(join(capData, 'nvrs.json'), JSON.stringify({ nvrs: [{ id: 'w1', site: 'T', name: 'W1', host: 'w1.invalid', port: 6036, user: 'u', password: 'p' }] }))
  const child = fork(new URL('../nvr-worker.mjs', import.meta.url), [], { serialization: 'advanced', stdio: ['ignore', 'pipe', 'inherit', 'ipc'], env: { ...process.env, DATA_DIR: capData, CCTV_WORKER_NVR: 'w1', CCTV_FAKE_LOG_CALLS: '1', CCTV_FAKE_MAX_SUBS: '5' } })
  let wout = ''
  child.stdout.on('data', (d) => (wout += d))
  const got = []
  child.on('message', (m) => got.push(m))
  const plays = (key) => (wout.match(new RegExp(`^\\[fake-sdk\\] LivePlay ${key}$`, 'gm')) ?? []).length
  const framesOf = (key, from = 0) => got.slice(from).some((m) => m.t === 'frame' && m.key === key)
  const stats = () => got.filter((m) => m.t === 'stats').at(-1)
  check('sub limit: worker ready and logged in', (await until(() => got.some((m) => m.t === 'ready'))) && (await until(() => wout.includes('logged in'))))
  for (let ch = 0; ch < 5; ch++) child.send({ t: 'want', ch, type: 1 })
  check('sub limit: five viewers\' sub-streams play', await until(() => [0, 1, 2, 3, 4].every((ch) => framesOf(`${ch}:1`)), 8000))
  child.send({ t: 'want', ch: 5, type: 1 })
  child.send({ t: 'want', ch: 6, type: 1 })
  check('sub limit: two refusals at 5 playing set the limit (stats say 5, the log says so)', await until(() => stats()?.subCap?.limit === 5 && wout.includes('plays at most 5 sub-streams at once'), 8000), JSON.stringify(stats()?.subCap))
  check('sub limit: the refused viewers\' sub-streams are held (in the stats at once)', await until(() => JSON.stringify(stats()?.subCap?.held) === '[5,6]', 3000), JSON.stringify(stats()?.subCap))
  const p5 = plays('5:1')
  const p6 = plays('6:1')
  await sleep(7000) // past the 5 s retry of a refused start
  check('sub limit: a held sub-stream is not asked for again and again', plays('5:1') === p5 && plays('6:1') === p6, `5:1 ${p5} -> ${plays('5:1')}, 6:1 ${p6} -> ${plays('6:1')}`)
  child.send({ t: 'want', ch: 7, type: 1, background: true }) // a warm-up
  await sleep(1500)
  check('sub limit: a warm-up is held back below the limit (no LivePlay)', plays('7:1') === 0 && !(stats()?.subCap?.held ?? []).includes(7), `${plays('7:1')} LivePlay`)
  check('sub limit: the limit is saved for the next start', existsSync(join(capData, 'sub-cap-w1.json')) && JSON.parse(readFileSync(join(capData, 'sub-cap-w1.json'), 'utf8')).limit === 5)
  // viewer 0 leaves its tile, the stream lingers (background): a held viewer takes its place
  const from = got.length
  child.send({ t: 'want', ch: 0, type: 1, background: true })
  check('sub limit: a held viewer takes the place of a stream nobody watches (it stops)', await until(() => wout.includes('stream w1/1:sub stopped'), 6000))
  check('sub limit: ... and one held viewer\'s sub-stream plays', await until(() => framesOf('5:1', from) || framesOf('6:1', from), 6000))
  check('sub limit: ... the other is still held, and the warm-up is not started', await until(() => (stats()?.subCap?.held ?? []).length === 1, 3000) && plays('7:1') === 0 && plays('0:1') === 1, JSON.stringify(stats()?.subCap))
  child.send({ t: 'stop' })
  await until(() => child.exitCode !== null || child.signalCode !== null, 6000)
}

// ---- the SDK's "Net Disconnected" lines in a worker's output: one LINKRESET a second at most
{
  const { linkResetWatch } = await import('../worker-supervisor.mjs')
  let t = 1000
  const sent = []
  const onLine = linkResetWatch((at) => sent.push(at), () => t)
  onLine('stream w1/3:sub started')
  onLine('Net Disconnected...... m_deviceID = 29')
  onLine('Net Disconnected...... m_deviceID = 30') // the same reset: a line per link
  t += 400
  onLine('Net Disconnected...... m_deviceID = 1')
  t += 700
  onLine('Net Disconnected...... m_deviceID = 2')
  check('link reset: at most one message a second, none for other lines', sent.join() === '1000,2100', sent.join())
}

// ---- Task 4: supervisor
{
  const { startWorker } = await import('../worker-supervisor.mjs')
  const sup = startWorker('w1', { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, got: [], send(b) { this.got.push(b) } }
  sup.hub.getStream(2, 1).add(ws)
  check('supervisor: worker ready', await until(() => sup.state() === 'ready'))
  check('supervisor: frames reach the viewer', await until(() => ws.got.length > 3))
  check('supervisor: first frame to the viewer is a keyframe', ws.got[0]?.[0] === 1)
  const old = sup._child()
  const states = []
  const poll = setInterval(() => states.push(sup.state()), 20)
  old.kill('SIGKILL')
  check('supervisor: restarting after a crash', await until(() => sup.state() === 'restarting', 2000))
  const before = ws.got.length
  check('supervisor: ready again after the restart', await until(() => sup.state() === 'ready' && sup._child() !== old, 10_000))
  check('supervisor: frames reach the same viewer again', await until(() => ws.got.length > before + 3))
  check('supervisor: after the restart the viewer restarts on a keyframe', ws.got[before]?.[0] === 1)
  clearInterval(poll)
  check('supervisor: stats arrive', await until(() => sup.stats() !== null, 7000))
  const last = sup._child()
  await sup.stop()
  check('supervisor: stop ends the worker', last.exitCode !== null || last.signalCode !== null)
  await new Promise((r) => setTimeout(r, 2500))
  check('supervisor: no restart after stop', sup._child() === last && (last.exitCode !== null || last.signalCode !== null))
}

// ---- Task 5: nvrs.mjs with CCTV_LIVE_WORKER=on
{
  process.env.CCTV_LIVE_WORKER = 'on'
  await import('./fake-sdk.mjs') // the parent's own control login must not reach an NVR either
  const { nvrs, startNvrs, stopNvrs } = await import('../nvrs.mjs')
  console.log = () => {}
  // M7: worker output reaches our stdout line by line, prefixed
  let appOut = ''
  const realWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => {
    appOut += chunk
    return /^(PASS|FAIL|\n)/.test(String(chunk)) ? realWrite(chunk, ...rest) : true
  }
  process.env.CCTV_WORKER_TEST_SLOW_STOP_MS = '7000' // the first worker overstays its stop (for I3)
  process.env.CCTV_FAKE_NET_DOWN_CH = '11' // a LivePlay of channel 11: the worker's SDK says the NVR dropped a link
  process.env.CCTV_FAKE_LOG_CALLS = '1'
  let appErr = ''
  const realErr = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk, ...rest) => {
    appErr += chunk
    return realErr(chunk, ...rest)
  }
  startNvrs()
  check('app: NVR w1 created', await until(() => nvrs.has('w1')))
  const nvr = nvrs.get('w1')
  check('app: worker started for w1', await until(() => nvr.worker?.state() === 'ready'))
  delete process.env.CCTV_WORKER_TEST_SLOW_STOP_MS
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, got: [], send(b) { this.got.push(b) } }
  const s = nvr.getStream(2, 1)
  s.add(ws)
  check('app: frames reach the viewer through the worker', await until(() => ws.got.length > 3))
  check('app: no LivePlay in the parent', globalThis.__fakeSdk.calls('LivePlay').length === 0, `${globalThis.__fakeSdk.calls('LivePlay').length}`)
  check('app: parent control login still made', globalThis.__fakeSdk.calls('Login').length >= 1)
  check('app: parent keeps no LiveStream', nvr.streams.size === 0)
  // I2: the sub-stream page's restart goes through the worker
  await until(() => appOut.includes('stream w1/3:sub started'))
  nvr.restartStream(2, 1, 'sub-stream codec changed')
  check('app: restartStream restarts the stream in the worker', await until(() => appOut.includes('[worker w1] stream w1/3:sub sub-stream codec changed, restarting'), 3000))
  check('app: worker log lines are prefixed', /^\[worker w1\] /m.test(appOut) && !/^stream w1\//m.test(appOut))
  // the SDK in the worker says the NVR dropped its links: the supervisor tells the worker (LINKRESET),
  // which holds viewers' new streams on that NVR (live-pacer.mjs)
  const quiet = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, send() {} })
  nvr.getStream(11, 1).add(quiet())
  check('app: the SDK’s "Net Disconnected" reaches the worker as a link reset', await until(() => appErr.includes('[worker w1] [w1] the NVR dropped its links'), 3000), appErr.split('\n').filter((l) => l.includes('dropped')).join(' | '))
  nvr.getStream(12, 1).add(quiet())
  await new Promise((r) => setTimeout(r, 1500))
  check('app: ... a viewer’s new stream on that NVR then waits', appOut.includes('[worker w1] [fake-sdk] LivePlay 11:1') && !appOut.includes('[worker w1] [fake-sdk] LivePlay 12:1'))
  process.stderr.write = realErr
  delete process.env.CCTV_FAKE_NET_DOWN_CH
  // I3: a config change replaces the NVR; the new worker is forked only after the old one has exited
  const oldChild = nvr.worker._child()
  let oldExitAt = 0
  oldChild.once('exit', () => (oldExitAt = Date.now()))
  writeFileSync(join(data, 'nvrs.json'), JSON.stringify({ nvrs: [{ id: 'w1', site: 'T', name: 'W1', host: 'w1b.invalid', port: 6036, user: 'u', password: 'p' }] }))
  check('app: NVR replaced after the config change', await until(() => nvrs.get('w1') && nvrs.get('w1') !== nvr, 20_000))
  const nvr2 = nvrs.get('w1')
  const newChild = nvr2.worker._child()
  check('app: new worker forked only after the old one exited', oldExitAt > 0 && newChild.spawnedAt >= oldExitAt, `old exit ${oldExitAt}, new fork ${newChild.spawnedAt}`)
  check('app: new worker gets ready', await until(() => nvr2.worker.state() === 'ready'))
  await stopNvrs()
  check('app: stopNvrs ends the worker', newChild.exitCode !== null || newChild.signalCode !== null)
  process.stdout.write = realWrite
}

print(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
