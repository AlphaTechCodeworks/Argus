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
  // a location with a low mark of its own (the NAS's near 7 %, 2026-09-29): the alert goes by that one
  const own = buildSnapshot(deps({ locationState: () => [{ id: 'nas', name: 'NAS', mounted: true, freePct: 10, lowFreePct: 7 }, { id: 'usb', name: 'USB drive', mounted: true, freePct: 59, lowFreePct: null }] }), T0)
  check('a location\'s own low mark rides on it; one without keeps the default', own.locations[0].lowFreePct === 7 && own.locations[1].lowFreePct === 15, JSON.stringify(own.locations))
  check('an online NVR is online', s.nvrs[0].online === true)
  check('a camera carries its last segment time', s.cameras[0].lastSegmentMs === T0)
  check('no disk reader means no storage, not a fake one', s.nvrs[0].storage === null)
  // "Nobody counted" must survive as null all the way to the page, not become a comforting 0.
  check('an unmeasured refusal count stays null', buildSnapshot(deps({ listNvrs: () => [{ id: 'nvr1', name: 'Main site', status: 'online', error: '' }] }), T0).nvrs[0].refusalsLast10Min === null)
}
{
  // What each NVR says about its own disks rides along on the snapshot, and so out on /api/health.
  const storage = { at: T0, available: true, why: '', disks: [{ name: 'disk1', state: 'ok', status: 'read/write', days: 33 }], days: 33, worst: 'ok', caps: { firmware: '1.4.5.2' } }
  const s = buildSnapshot(deps({ nvrStorage: { get: () => storage, refresh: async () => {} } }), T0)
  check('the disk reading rides on the NVR', s.nvrs[0].storage === storage)
}
{
  // The check loop must be unkillable: a disk reader that throws is logged and ignored.
  let ticked = false
  const a = startAlerts(deps({
    autoStart: false,
    now: () => T0,
    sender: fakeSender(),
    log: () => {},
    nvrStorage: { get: () => { ticked = true; return null }, refresh: () => { throw new Error('the NVR reader blew up') } }
  }))
  a.tick()
  check('a disk reader that throws does not stop the check', ticked === true)
  check('and the health page still answers', typeof a.health().now === 'number')
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
  // the clear is held 5 min now (CLEAR_MS, anti-flap): a drive back for less than that is not cleared yet
  t += 6 * MIN; a.tick()
  check('the clear is sent once the drive is back', sent.join() === 'opened,cleared', sent.join())
  check('the clear is in the history', readAlerts(d.dataDir, 0).some((r) => r.event === 'cleared'))
  check('health() is empty again', a.health().open.length === 0)
  a.stop()
}

// --- days kept short of the target (retention-target.mjs, 2026-09-30, p4-target) --------------------------
// The NAS at its 12,000 GB limit keeps 8.2 days against 30, from the figures the watch measured: the check
// sends it once, keeps it open while the NAS goes on recycling (the drive-filling forecast is quiet there by
// design), and clears it once the target is met again.
{
  // (retention-target.mjs loads auth.mjs, which writes a session secret into DATA_DIR: a folder of this run's, removed after)
  const { mkdtempSync: tmp, rmSync } = await import('node:fs')
  if (!process.env.DATA_DIR) {
    const own = tmp(join(tmpdir(), 'cctv-ac-data-'))
    process.env.DATA_DIR = own
    process.on('exit', () => {
      try {
        rmSync(own, { recursive: true, force: true })
      } catch {}
    })
  }
  const { retentionView, retentionCandidates, wholeDays } = await import('../retention-target.mjs')
  const DAY = 86_400_000
  let oldest = T0 - 8.2 * DAY
  let t = T0
  const facts = () => ({
    at: t,
    stepMs: 10_000,
    keyframeShare: { low: 0.43, mid: 0.5, high: 0.56 },
    protection: 'ranges',
    warnings: [],
    days: wholeDays(t).map((d) => ({ ...d, rows: [{ loc: 'nas', nvr: 'nvr1', ch: 0, files: 1440, bytes: 1.47e12, ms: 1440 * 59_000, weighted: 0.294e12 }] })),
    locations: { nas: { id: 'nas', anyOldestMs: oldest, oldestMs: oldest, timelapse: null, fullFromMs: oldest, sample: [] } }
  })
  const row = { id: 'nas', path: '/srv/nas', mounted: true, argusBytes: 12_000e9, freeBytes: 1.19e12, totalBytes: 16.63e12, limitBytes: 12_000e9, limitEnforced: true, lowFreePct: 7, floorFreePct: 5 }
  const settings = { recording: { defaults: { fullDays: 7, after: 'timelapse', timelapseS: 10, retentionDays: 30 }, cameras: {} }, storage: { thinning: 'dry-run', locations: [{ id: 'nas', path: '/srv/nas' }] } }
  let space = { limitBytes: 12_000e9, freeBytes: 1.19e12, totalBytes: 16.63e12 }
  const memory = new Set()
  const extraCandidates = () => {
    const r = { ...row, ...space }
    return retentionCandidates({ retention: retentionView({ facts: facts(), settings, locations: [r], now: t, memory }), locations: [r] })
  }
  const sent = []
  // (the camera records all along: only the storage figure is wrong)
  const a = startAlerts({ ...deps({ listCameras: () => [{ nvrId: 'nvr1', ch: 0, name: 'Cashier Front', online: true, recording: true, lastSegmentMs: t }] }), extraCandidates, now: () => t, sender: fakeSender(sent), autoStart: false, log: () => {} })
  a.tick()
  t += 3 * MIN
  a.tick()
  check('DAYS KEPT SHORT OF THE TARGET WHILE RECYCLING: sent once it is due, kind retention-short', sent.length === 1 && sent[0].alerts[0].kind === 'retention-short' && /keeps 8\.2 days/.test(sent[0].alerts[0].title), JSON.stringify(sent.map((s) => s.alerts.map((x) => x.title))))
  for (let i = 0; i < 20; i++) {
    t += 30 * 60_000
    a.tick()
  }
  check('... ten hours of checks later, still recycling at the limit: open, and not sent again', sent.length === 1 && a.health().open.some((x) => x.kind === 'retention-short'), String(sent.length))
  // the owner buys space: a 70 TB share with a 50,000 GB limit holds the 30 days of full video (44.1 TB)
  space = { limitBytes: 50_000e9, freeBytes: 55e12, totalBytes: 70e12 }
  oldest = t - 30 * DAY
  a.tick()
  t += 6 * MIN // the clear is held 5 min now (CLEAR_MS, anti-flap)
  a.tick()
  check('... the target met again: cleared, once', sent.length === 2 && sent[1].kind === 'cleared' && sent[1].alerts[0].kind === 'retention-short', JSON.stringify(sent.map((s) => s.kind)))
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

// --- health() reuses a recent snapshot ------------------------------------------------------------
// Building one reads every camera's last recording from the index on the main thread, which also
// paces every playback. The banner on every page asks every 30 s and the Health page every 2 s; each
// used to build a snapshot of its own, and one built by the 30 s check was never shared with them.
{
  let t = T0
  let builds = 0
  let name = 'Cashier Front'
  const a = startAlerts(deps({
    autoStart: false,
    now: () => t,
    sender: fakeSender(),
    listCameras: () => { builds++; return [{ nvrId: 'nvr1', ch: 0, name, online: true, recording: true, lastSegmentMs: t }] }
  }))
  a.tick()
  check('the alert check builds a snapshot', builds === 1, String(builds))
  t += 1000
  a.health()
  check('a poll a second after the check uses the check\'s snapshot', builds === 1, String(builds))
  t += 3000
  a.health()
  check('... and four seconds after it', builds === 1, String(builds))
  t += 1000
  name = 'Till'
  const h = a.health()
  check('five seconds after it, the poll builds a fresh one', builds === 2 && h.cameras[0].name === 'Till', `${builds} ${h.cameras[0]?.name}`)
  // the Health page, open for a minute (every 2 s), with a banner on another page (every 30 s)
  const before = builds
  for (let i = 1; i <= 30; i++) {
    t += 2000
    a.health()
    if (i % 15 === 0) a.health()
  }
  const polled = builds - before
  check('a minute of polls every 2 s builds one snapshot per 5-6 s, not one per poll', polled >= 10 && polled <= 12, `${polled} built for 32 polls`)
  name = 'Door'
  t += 5000
  check('what the page shows is never more than 5 s old', a.health().cameras[0].name === 'Door')
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
