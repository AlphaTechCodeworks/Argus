// Tests that a network share is checked from another process -- the share helper, one long-lived
// process per share (share-calls.mjs) -- and that a share which never answers cannot hold up the
// server (storage.mjs).
//   node cctv/test/share-probe.test.mjs
// The case it exists for, 2026-09-26: the server froze twice inside one file call to a NAS whose SMB
// session had gone stale. Since 2026-09-29 (perf report R6 / Task 2) the check no longer forks the
// whole server every 30 s: one helper is started and asked.
//
// This process watches itself: every process it starts (child_process) and every file call it makes
// on the share's folder (fs, sync, callback and promise forms) is recorded, and the server's side must
// make none on the share.
import cp from 'node:child_process'
import fs, { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const base = mkdtempSync(join(tmpdir(), 'cctv-share-'))
process.env.DATA_DIR = join(base, 'data')
mkdirSync(process.env.DATA_DIR)
writeFileSync(join(process.env.DATA_DIR, 'users.json'), JSON.stringify({ boss: { hash: 'x', role: 'admin' } }))

// ---- the watch, installed before any app module is loaded -------------------------------------------
const started = [] // [function, what]
for (const k of ['fork', 'spawn', 'execFile', 'exec', 'spawnSync', 'execFileSync', 'execSync']) {
  const real = cp[k]
  cp[k] = function (...a) {
    started.push([k, String(a[0])])
    return real.apply(this, a)
  }
}
let watching = null // the share's folder, while its file calls are being counted
const onShare = [] // [function, path]
const asPath = (p) => {
  try {
    if (typeof p === 'string') return resolve(p)
    if (Buffer.isBuffer(p)) return resolve(p.toString())
    if (p instanceof URL) return resolve(fileURLToPath(p))
  } catch {}
  return null
}
const note = (k, p) => {
  const r = watching && asPath(p)
  if (r && (r === watching || r.startsWith(watching + sep))) onShare.push([k, r])
}
const wrap = (obj, k, label) => {
  const real = obj[k]
  const w = function (...a) {
    note(label, a[0])
    if (/^(rename|copyFile|link|symlink|cp)/.test(k)) note(label, a[1])
    return real.apply(this, a)
  }
  for (const key of Reflect.ownKeys(real)) if (!['length', 'name', 'prototype'].includes(key)) Object.defineProperty(w, key, Object.getOwnPropertyDescriptor(real, key))
  obj[k] = w
}
for (const k of Object.keys(fs)) if (typeof fs[k] === 'function' && /^[a-z]/.test(k)) wrap(fs, k, k)
for (const k of Object.keys(fs.promises)) if (typeof fs.promises[k] === 'function') wrap(fs.promises, k, `promises.${k}`)
syncBuiltinESMExports()

const storage = await import('../storage.mjs')
const calls = await import('../share-calls.mjs')
const { saveSettings } = await import('../settings.mjs')
const { SHARE_ANSWER_MS, _test, checkHealth, listLocations, pickLocation, markerMatches, freeOf, onChange, startHealthChecks, stopHealthChecks, shareCall } = storage

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
async function until(fn, ms = 3000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(20)) if (fn()) return true
  return fn()
}
function beat() {
  let last = performance.now()
  let worst = 0
  const t = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last)
    last = now
  }, 5)
  return () => {
    clearInterval(t)
    return Math.max(worst, performance.now() - last)
  }
}

// the share: a folder with its marker, listed as a network location
const good = join(base, 'share')
mkdirSync(good)
writeFileSync(join(good, storage.MARKER), JSON.stringify({ id: 'loc-good' }))
const loc = { id: 'loc-good', path: good, type: 'network', role: 'main', limitGB: null, added: '2026-09-29T00:00:00Z', addedBy: 'boss' }
saveSettings({ storage: { locations: [loc] } }, 'boss', { internal: true })

// the watch catches a file call on the share from this process (so a pass below means something)
watching = resolve(good)
fs.statSync(good)
check('the watch sees a file call on the share made from this process', onShare.length === 1, JSON.stringify(onShare))
onShare.length = 0

check('the answer time is still 10 s', SHARE_ANSWER_MS === 10_000)

// ---- a share that answers --------------------------------------------------------------------------
const before = started.length
const seen = []
const off = onChange((list) => seen.push(list))
{
  const list = await checkHealth()
  const h = list.find((l) => l.id === 'loc-good').health
  check('a share that answers is healthy, checked from another process', h.ok === true && h.marker === true && calls._test.pidOf(loc) > 0 && calls._test.pidOf(loc) !== process.pid, JSON.stringify(h))
  check('...one process started for it: the helper', started.length - before === 1 && started[before][0] === 'fork' && /share-helper\.mjs$/.test(started[before][1]), JSON.stringify(started.slice(before)))
}
{
  const h = await _test.probeShare({ id: 'loc-gone', path: join(base, 'nope') }, 0, false)
  check('a share that is not there is down, with the reason', h.ok === false && /missing/.test(h.reason), h.reason)
}

// ---- the 30-second check no longer starts a process each time --------------------------------------
{
  const pid = calls._test.pidOf(loc)
  const n0 = started.length
  const stop = beat()
  startHealthChecks(40)
  await sleep(1300) // about 30 checks, the 20th with the write-speed test
  stopHealthChecks()
  await sleep(100)
  const worst = stop()
  const h = listLocations().find((l) => l.id === 'loc-good').health
  check('about 30 checks: no process started, the same helper answered', started.length === n0 && calls._test.pidOf(loc) === pid, `${started.length - n0} started: ${JSON.stringify(started.slice(n0))}`)
  check('...the write-speed test ran in it too', h.ok && h.writeMBps > 0, JSON.stringify(h))
  check("...and this process's main thread never held for 50 ms", worst < 50, `${worst.toFixed(1)} ms`)
}

// ---- everything else the server asks about a share, without touching it -----------------------------
{
  check('listLocations: the share as last checked', listLocations().find((l) => l.id === 'loc-good').health.ok === true)
  check('pickLocation: the healthy share is where recording goes', pickLocation('nvr1/1')?.id === 'loc-good')
  check('markerMatches: from the last check', markerMatches(loc) === true)
  const f = freeOf(loc)
  check('freeOf: from the last check', f.totalBytes > 0)
  // the file calls the deletion and time-lapse jobs will make (Tasks 3-4), all in the helper
  watching = null
  const file = join(good, 'n1', '0', '2026-09-22', '06', '00.h264')
  mkdirSync(join(good, 'n1', '0', '2026-09-22', '06'), { recursive: true })
  writeFileSync(file, 'x')
  writeFileSync(`${file}.idx`, 'x')
  watching = resolve(good)
  const st = await shareCall(loc, 'stat', { paths: [file] })
  const ls = await shareCall(loc, 'readdir', { dirs: [join(good, 'n1')] })
  const fr = await shareCall(loc, 'statfs')
  const del = await shareCall(loc, 'unlink', { paths: [file], withIdx: true })
  const rm = await shareCall(loc, 'rmdir', { dirs: [join(good, 'n1', '0', '2026-09-22', '06')] })
  watching = null
  check('stat, readdir, statfs, unlink and rmdir through the helper: all answered', st[0].size === 1 && ls[0].entries[0].name === '0' && fr.totalBytes > 0 && del[0].ok === true && rm[0].removed.length === 4 && !existsSync(join(good, 'n1')), JSON.stringify({ st, ls, del, rm }))
  watching = resolve(good)
}
check('THE SERVER SIDE MADE NO FILE CALL ON THE SHARE (checks, lists, deletes)', onShare.length === 0, JSON.stringify(onShare.slice(0, 5)))
watching = null

// ---- a share that never answers ----------------------------------------------------------------------
// The real helper, with its file calls made to hang on the share while the flag file exists (like a
// stale SMB session: the call never comes back).
const flag = join(base, 'hang-on')
const hangHelper = join(base, 'hang-helper.mjs')
writeFileSync(
  hangHelper,
  `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const flag = ${JSON.stringify(flag)}
const share = ${JSON.stringify(resolve(good))}
for (const k of ['stat', 'statfs', 'readFile', 'writeFile', 'readdir', 'unlink', 'rmdir', 'rename', 'open']) {
  const real = fs.promises[k]
  fs.promises[k] = (p, ...a) => (String(p).startsWith(share) && fs.existsSync(flag) ? new Promise(() => {}) : real(p, ...a))
}
syncBuiltinESMExports()
await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'share-helper.mjs')).href)})
`
)
calls._test.setHelper(hangHelper)
calls._test.setAnswerMs(1000)
calls.stopShareHelpers()
await checkHealth() // a helper of the hanging kind, answering while the share still does
{
  const oldPid = calls._test.pidOf(loc)
  writeFileSync(flag, '1')
  const n0 = seen.length
  const t0 = Date.now()
  let ticks = 0
  const iv = setInterval(() => ticks++, 100)
  const stop = beat()
  await checkHealth()
  const worst = stop()
  clearInterval(iv)
  const took = Date.now() - t0
  const h = listLocations().find((l) => l.id === 'loc-good').health
  check('a share that never answers is called down', h.ok === false && h.reason === 'share not answering', h.reason)
  check('within the answer time, not forever', took >= 1000 && took < 2500, `${took} ms`)
  check('and the server kept running meanwhile', ticks >= 8 && worst < 50, `${ticks} ticks, longest hold ${worst.toFixed(1)} ms`)
  check('the listeners were told (recording moves elsewhere)', seen.length === n0 + 1 && seen.at(-1).some((l) => l.id === 'loc-good' && !l.health.ok))
  check('the hung helper is killed', await until(() => !alive(oldPid)))
  // /healthz lists shares by path, ok and reason: the outside watcher remounts a share it sees
  // "not answering" twice in a row (deploy/cctv-healthwatch.mjs stuckShares)
  check('the reason is one the outside watcher acts on', /not answering/.test(h.reason))
  await until(() => calls.shareStuckFor(loc) === null)
  rmSync(flag)
  await checkHealth()
  const h2 = listLocations().find((l) => l.id === 'loc-good').health
  check('the share answers again: a NEW helper answers the next check', h2.ok === true && calls._test.pidOf(loc) > 0 && calls._test.pidOf(loc) !== oldPid, `${oldPid} -> ${calls._test.pidOf(loc)}`)
  check('...and the listeners were told it is back', seen.at(-1).some((l) => l.id === 'loc-good' && l.health.ok))

  // a deletion that hangs: the share is down at once, not at the next check up to 30 s later
  writeFileSync(flag, '1')
  const n1 = seen.length
  const del = await calls.shareCall(loc, 'unlink', { paths: [join(good, 'x.h264')] }).then(() => null, (e) => e)
  await sleep(50)
  const h3 = listLocations().find((l) => l.id === 'loc-good').health
  check('a deletion that hangs: the call fails as not answering', del?.code === 'ESHARESTUCK', del?.message)
  check('...the share is down at once, and the listeners told', !h3.ok && /not answering/.test(h3.reason) && seen.length === n1 + 1, `${h3.reason}, ${seen.length - n1} notices`)
  rmSync(flag)
  await until(() => calls.shareStuckFor(loc) === null)
  await checkHealth()
  check('...and back at the next check', listLocations().find((l) => l.id === 'loc-good').health.ok === true)
}
calls._test.setHelper(null)

{
  const EventEmitter = (await import('node:events')).EventEmitter
  // a helper that goes on reporting file calls (every 200 ms) but never finishes the check: the check
  // as a whole still gets the answer time, as before the helper
  const slowKid = new EventEmitter()
  slowKid.pid = 800000
  slowKid.connected = true
  slowKid.send = (m, cb) => {
    cb?.(null)
    const iv = setInterval(() => slowKid.emit('message', { n: m.n, progress: true }), 200)
    slowKid.once('exit', () => clearInterval(iv))
    return true
  }
  slowKid.kill = () => setImmediate(() => slowKid.emit('exit', null, 'SIGKILL'))
  slowKid.unref = () => {}
  slowKid.disconnect = () => {}
  calls._test.setFork(() => slowKid)
  calls.stopShareHelpers()
  const t0 = Date.now()
  await checkHealth()
  const took = Date.now() - t0
  const hs = listLocations().find((l) => l.id === 'loc-good').health
  check('a check whose file calls go on coming back but never ends: down within the answer time', hs.reason === 'share not answering' && took < 1500, `${hs.reason} after ${took} ms`)
  await until(() => calls.shareStuckFor(loc) === null)

  // a helper that cannot be killed (stuck in the kernel): the share stays down, "stuck for N s", and
  // no second helper is started after it (the one-stuck-check rule of 2026-09-26)
  const kids = []
  calls._test.setFork(() => {
    const c = new EventEmitter()
    c.pid = 900000 + kids.length
    c.sent = []
    c.connected = true
    c.send = (m, cb) => (c.sent.push(m), cb?.(null), true)
    c.kill = () => {}
    c.unref = () => {}
    c.disconnect = () => {}
    kids.push(c)
    return c
  })

  await checkHealth()
  await sleep(1100)
  await checkHealth()
  const h = listLocations().find((l) => l.id === 'loc-good').health
  check('an unkillable stuck helper: the share stays down, "stuck for N s"', !h.ok && /^share not answering: a check has been stuck for \d+ s$/.test(h.reason), h.reason)
  check('...and no second helper was started after it', kids.length === 1)
  calls._test.setFork(null)
  kids[0].emit('exit', null, 'SIGKILL')
  await checkHealth()
  check('once it has exited, a real helper answers the next check', listLocations().find((l) => l.id === 'loc-good').health.ok === true)
}
calls._test.setAnswerMs(SHARE_ANSWER_MS)

// ---- a share taken off the list: its helper goes --------------------------------------------------
{
  const pid = calls._test.pidOf(loc)
  saveSettings({ storage: { locations: [] } }, 'boss', { internal: true })
  await checkHealth()
  check('a share no longer in the list: its helper is stopped', await until(() => !alive(pid)) && calls._test.pidOf(loc) === null, `pid ${pid}`)
}
off()

// listLocations never touches a share: its health is whatever the last check said
_test.setShareHealth('loc-x', { ok: false, reason: 'share not answering', marker: false })
check('markerMatches for a share uses the last check, not the share', storage.markerMatches({ id: 'loc-x', type: 'network', path: '/nowhere' }) === false)
_test.setShareHealth('loc-x', { ok: true, reason: '', marker: true })
check('and says yes once a check found the marker', storage.markerMatches({ id: 'loc-x', type: 'network', path: '/nowhere' }) === true)

calls.stopShareHelpers()
await sleep(200)
rmSync(base, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
