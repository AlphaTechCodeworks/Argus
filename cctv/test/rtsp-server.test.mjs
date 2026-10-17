// Tests for the RTSP server's supervision (rtsp-server.mjs): where the binary is looked for, "not
// installed", the config written before each start, its lines with [rtsp] in front, restarts with a
// growing wait (and from the first again after a stable run), stop and restart. A fake spawn and clock.
// Run:  node cctv/test/rtsp-server.test.mjs
import { EventEmitter } from 'node:events'
import { BACKOFF_MS, STABLE_MS, backoffFor, findBinary, makeRtspServer } from '../rtsp-server.mjs'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

// ---- the binary ----
{
  const at = (...have) => (p) => have.includes(p.replace(/\\/g, '/'))
  check('CCTV_MEDIAMTX first', findBinary({ env: { CCTV_MEDIAMTX: '/x/m' }, appDir: '/app', dataDir: '/data', exists: at('/x/m', '/opt/cctv/mediamtx/mediamtx'), platform: 'linux' }) === '/x/m')
  check('then the installed copy', findBinary({ env: {}, appDir: '/app', dataDir: '/data', exists: at('/opt/cctv/mediamtx/mediamtx', '/app/bin/linux/mediamtx'), platform: 'linux' }) === '/opt/cctv/mediamtx/mediamtx')
  check('then one under the release, then DATA_DIR/bin', findBinary({ env: {}, appDir: '/app', dataDir: '/data', exists: at('/app/bin/linux/mediamtx'), platform: 'linux' }).replace(/\\/g, '/') === '/app/bin/linux/mediamtx' && findBinary({ env: {}, appDir: '/app', dataDir: '/data', exists: at('/data/bin/mediamtx'), platform: 'linux' }).replace(/\\/g, '/') === '/data/bin/mediamtx')
  check('none: null', findBinary({ env: {}, appDir: '/app', dataDir: '/data', exists: () => false, platform: 'linux' }) === null)
}
check('waits: 1 s doubling to a minute, and no further', backoffFor(0) === 1000 && backoffFor(1) === 2000 && backoffFor(6) === 60000 && backoffFor(50) === 60000 && BACKOFF_MS.length === 7)

// ---- supervision ----
{
  let t = 0
  const timers = []
  const spawned = []
  const logs = []
  let prepared = 0
  let bin = '/opt/cctv/mediamtx/mediamtx'
  const spawn = (b, args, opts) => {
    const c = new EventEmitter()
    Object.assign(c, { pid: 100 + spawned.length, stdout: new EventEmitter(), stderr: new EventEmitter(), killed: null, kill(sig) { this.killed = sig } })
    spawned.push({ b, args, opts, c })
    return c
  }
  const s = makeRtspServer({ binary: () => bin, configFile: '/data/rtsp/mediamtx.yml', cwd: '/data', prepare: () => prepared++, spawn, log: (l) => logs.push(l), now: () => t, setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h }, clearTimer: (h) => { h.cleared = true } })
  check('not started until asked', spawned.length === 0 && s.status().running === false)
  s.start()
  const first = spawned[0]
  check('started: the config written first, the binary with the config file, a clean environment', spawned.length === 1 && prepared === 1 && first.b === bin && first.args[0] === '/data/rtsp/mediamtx.yml' && !Object.keys(first.opts.env).some((k) => k.startsWith('MTX_')) && s.status().running)
  first.c.stdout.emit('data', Buffer.from('2026/10/15 09:00:00 INF [RTSP] listener opened on :8554 (TCP)\npartial'))
  first.c.stdout.emit('data', Buffer.from(' line\n'))
  check('its lines in the journal with [rtsp] in front, whole lines only', logs.includes('[rtsp] 2026/10/15 09:00:00 INF [RTSP] listener opened on :8554 (TCP)') && logs.includes('[rtsp] partial line'))
  s.start()
  check('asked again while running: nothing new', spawned.length === 1)
  t = 5000
  first.c.stderr.emit('data', Buffer.from('ERR listen tcp :8554: bind: address already in use\n'))
  first.c.emit('exit', 1, null)
  check('ended by itself: started again after 1 s, the reason kept', timers.at(-1).ms === 1000 && /address already in use/.test(s.status().lastError) && !s.status().running)
  timers.at(-1).fn()
  spawned.at(-1).c.emit('exit', 1, null)
  check('...then after 2 s', timers.at(-1).ms === 2000)
  timers.at(-1).fn()
  t += STABLE_MS + 1
  spawned.at(-1).c.emit('exit', null, 'SIGSEGV')
  check('after a stable run the waits start from 1 s again', timers.at(-1).ms === 1000 && /SIGSEGV/.test(s.status().lastError))
  timers.at(-1).fn()
  const running = spawned.at(-1).c
  s.stop()
  check('stopped: SIGTERM, and its end is not restarted', running.killed === 'SIGTERM' && (running.emit('exit', 0, 'SIGTERM'), timers.filter((x) => !x.cleared).length === timers.filter((x) => !x.cleared).length) && !s.status().running && s.status().wanted === false)
  const n = spawned.length
  s.restart()
  check('restart while stopped: started at once', spawned.length === n + 1)
  const before = spawned.at(-1).c
  s.restart()
  check('restart while running: the old one stopped, the new one started a moment later (its ports free)', before.killed === 'SIGTERM' && timers.at(-1).ms === 1500 && (timers.at(-1).fn(), spawned.length === n + 2))
  s.stop()
  bin = null
  s.start()
  check('no binary: not installed, nothing started, nothing thrown', s.status().installed === false && s.status().lastError === 'not installed' && spawned.length === n + 2)
}
{
  const logs = []
  const s = makeRtspServer({ binary: () => '/m', configFile: '/c', cwd: '/', prepare: () => { throw new Error('disk full') }, spawn: () => { throw new Error('never') }, log: (l) => logs.push(l), setTimer: () => ({}), clearTimer: () => {} })
  s.start()
  check('a config that cannot be written: said, nothing started, tried again later', /config not written: disk full/.test(s.status().lastError) && logs.some((l) => /disk full/.test(l)))
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exitCode = failed ? 1 : 0
