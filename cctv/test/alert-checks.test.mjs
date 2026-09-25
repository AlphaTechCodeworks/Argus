// Tests for alert-checks.mjs: turning live server state into a snapshot, and the loop's
// open/clear/send/record cycle with fake time. Every dependency is injected, so nothing here
// reaches the SDK and the file runs with plain node on any machine.
// Run: node cctv/test/alert-checks.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSnapshot, startAlerts } from '../alert-checks.mjs'
import { readAlerts } from '../alert-log.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 25, 9, 0, 0)
const MIN = 60_000

const deps = (o = {}) => ({
  dataDir: mkdtempSync(join(tmpdir(), 'cctv-ac-')),
  startedMs: T0 - 60 * MIN,
  restartReason: null,
  getSettings: () => ({
    storage: { locations: [{ id: 'usb', name: 'USB drive' }], lowFreePct: 15 },
    recording: { defaults: { mode: 'continuous' }, cameras: {} },
    alerts: { ntfy: { url: '', topic: '' }, email: { host: '', port: 587, secure: false, user: '', pass: '', from: '', to: [] }, muted: [], notRecordingMinutes: 5, clockSkewSeconds: 30 }
  }),
  listNvrs: () => [{ id: 'nvr1', name: 'Main site', status: 'online', error: '', clockSkewMs: 0, refusalsLast10Min: 0 }],
  listCameras: () => [{ nvrId: 'nvr1', ch: 0, name: 'Cashier Front', online: true, recording: true, lastSegmentMs: T0 }],
  locationState: () => [{ id: 'usb', name: 'USB drive', mounted: true, freePct: 59 }],
  ...o
})

/** A sender that records what it was asked to deliver. */
const fakeSender = (sent = [], pending = {}) => ({
  deliver: async (alerts, kind) => { sent.push({ kind, alerts }) },
  test: async () => ({ ok: true }),
  pending: () => pending
})

// --- snapshot ----------------------------------------------------------------------------------
{
  const s = buildSnapshot(deps(), T0)
  check('the snapshot carries the location with its lowFreePct', s.locations[0].lowFreePct === 15, JSON.stringify(s.locations))
  check('an online NVR is online', s.nvrs[0].online === true)
  check('a camera carries its last segment time', s.cameras[0].lastSegmentMs === T0)
}
{
  const s = buildSnapshot(deps({ listNvrs: () => [{ id: 'n', name: 'n', status: 'offline', error: '', clockSkewMs: 0, refusalsLast10Min: 0 }] }), T0)
  check('a non-online status is offline', s.nvrs[0].online === false, String(s.nvrs[0]?.online))
}
{
  const s = buildSnapshot(deps({ listNvrs: () => [{ id: 'n', name: 'n', status: 'error', error: 'wrong password', clockSkewMs: 0, refusalsLast10Min: 0 }] }), T0)
  check('a password error becomes loginError', s.nvrs[0].loginError === 'wrong password', s.nvrs[0]?.loginError)
}
{
  const s = buildSnapshot(deps({ listNvrs: () => [{ id: 'n', name: 'n', status: 'error', error: 'connection timed out', clockSkewMs: 0, refusalsLast10Min: 0 }] }), T0)
  check('a non-password error is not a loginError', s.nvrs[0].loginError === null, s.nvrs[0]?.loginError)
}
{
  const s = buildSnapshot(deps({ listCameras: () => [{ nvrId: 'nvr1', ch: 0, name: 'Cam', online: true, recording: true, lastSegmentMs: null }] }), T0)
  check('a camera with no recording yet counts as up to date', s.cameras[0].lastSegmentMs === T0, String(s.cameras[0]?.lastSegmentMs))
}

// --- the loop ----------------------------------------------------------------------------------
{
  const d = deps({ locationState: () => [{ id: 'usb', name: 'USB drive', mounted: false, freePct: 0 }] })
  const sent = []
  let t = T0
  const a = startAlerts({ ...d, now: () => t, sender: fakeSender(sent), autoStart: false })
  a.tick(); t += 3 * MIN; a.tick()
  check('the drive alert is sent once it is due', sent.length === 1 && sent[0].kind === 'opened', JSON.stringify(sent.map((s) => s.kind)))
  check('it is written to the history', readAlerts(d.dataDir, 0).some((r) => r.event === 'opened' && r.kind === 'drive-missing'), JSON.stringify(readAlerts(d.dataDir, 0)))
  check('health() reports it open', a.health().open.length === 1, JSON.stringify(a.health().open))
  t += 1 * MIN; a.tick()
  check('it is not sent again', sent.length === 1, String(sent.length))
  a.stop()
}
{
  let mounted = false
  const d = deps({ locationState: () => [{ id: 'usb', name: 'USB drive', mounted, freePct: 59 }] })
  const sent = []
  let t = T0
  const a = startAlerts({ ...d, now: () => t, sender: { ...fakeSender(), deliver: async (alerts, kind) => { sent.push(kind) } }, autoStart: false })
  a.tick(); t += 3 * MIN; a.tick()
  mounted = true
  t += 2 * MIN; a.tick()
  check('the clear is sent once the drive is back', sent.join() === 'opened,cleared', sent.join())
  check('the clear is in the history', readAlerts(d.dataDir, 0).some((r) => r.event === 'cleared'))
  check('health() is empty again', a.health().open.length === 0)
  a.stop()
}

// --- a failure to read the state ---------------------------------------------------------------
{
  const logged = []
  const d = deps({ listNvrs: () => { throw new Error('the NVR list blew up') } })
  const a = startAlerts({ ...d, now: () => T0, sender: fakeSender(), autoStart: false, log: (l) => logged.push(l) })
  let threw = false
  try { a.tick() } catch { threw = true }
  check('tick() never throws when the state cannot be read', !threw)
  check('and says so in the log', logged.some((l) => /could not read the state/.test(l)), logged.join(' | '))
  a.stop()
}

// --- health() shape ----------------------------------------------------------------------------
{
  const a = startAlerts({
    ...deps(),
    now: () => T0,
    sender: { ...fakeSender(), pending: () => ({ emailError: 'nope' }) },
    lastBackup: () => ({ at: T0 - 8 * 3600_000, files: [], written: ['/a'], errors: [] }),
    autoStart: false
  })
  a.tick()
  const h = a.health()
  check('health carries the nvrs', h.nvrs.length === 1 && h.nvrs[0].id === 'nvr1')
  check('health carries the locations', h.locations.length === 1)
  check('health carries the cameras', h.cameras.length === 1)
  check('health carries the sender status', h.sending.emailError === 'nope', JSON.stringify(h.sending))
  check('health carries the history', Array.isArray(h.history))
  check('health carries the last backup', h.backup?.written?.length === 1, JSON.stringify(h.backup))
  check('health never carries a secret', !JSON.stringify(h).includes('pass') && !JSON.stringify(h).includes('topic'), JSON.stringify(h).slice(0, 200))
  a.stop()
}
{
  // No backup and a health() before the first tick: still the full shape, never a crash.
  const a = startAlerts({ ...deps(), now: () => T0, sender: fakeSender(), autoStart: false })
  const h = a.health()
  check('health works before the first tick', h.nvrs.length === 1 && h.open.length === 0, JSON.stringify(h.open))
  check('no backup yet is null', h.backup === null, JSON.stringify(h.backup))
  a.stop()
}

// --- the test button -----------------------------------------------------------------------------
{
  const asked = []
  const a = startAlerts({ ...deps(), now: () => T0, sender: { ...fakeSender(), test: async (m) => { asked.push(m); return { ok: true } } }, autoStart: false })
  const r = await a.testSend('ntfy')
  check('testSend passes the method through to the sender', asked.join() === 'ntfy' && r.ok === true, JSON.stringify(r))
  a.stop()
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
