// Tests for alerts.mjs: when an alert opens, when it clears, grouping and suppression.
// Pure module, no I/O. Run: node cctv/test/alerts.test.mjs
import { alertEngine, KINDS } from '../alerts.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 25, 9, 0, 0)
const MIN = 60_000

/** A snapshot where everything is healthy. */
const ok = (o = {}) => ({
  // The server started at T0, so the 3 min grace covers T0..T0+3 MIN: the timings below are
  // written around that window.
  startedMs: T0,
  restartReason: null,
  locations: [{ id: 'usb', name: 'USB drive', mounted: true, freePct: 59 }],
  cameras: [{ nvrId: 'nvr1', ch: 0, name: 'Cashier Front', online: true, recording: true, lastSegmentMs: T0 }],
  nvrs: [{ id: 'nvr1', name: 'Main site', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }],
  ...o
})

const eng = (o = {}) => alertEngine({ raiseMs: 2 * MIN, clearMs: 1 * MIN, graceMs: 3 * MIN, notRecordingMs: 5 * MIN, clockSkewMs: 30_000, muted: [], ...o })

// --- raise delay -------------------------------------------------------------------------------
{
  const e = eng()
  const bad = ok({ locations: [{ id: 'usb', name: 'USB drive', mounted: false, freePct: 0 }] })
  check('nothing opens during the start grace', e.step(bad, T0 + 1 * MIN).opened.length === 0)
  check('still nothing before raiseMs after grace', e.step(bad, T0 + 4 * MIN).opened.length === 0)
  const r = e.step(bad, T0 + 6 * MIN)
  check('drive-missing opens after raiseMs', r.opened.length === 1 && r.opened[0].kind === 'drive-missing', JSON.stringify(r.opened))
  check('it does not open twice', e.step(bad, T0 + 7 * MIN).opened.length === 0)
  check('open list carries it', e.step(bad, T0 + 8 * MIN).open.length === 1)
}

// --- clear delay -------------------------------------------------------------------------------
{
  const e = eng()
  const bad = ok({ locations: [{ id: 'usb', name: 'USB drive', mounted: false, freePct: 0 }] })
  e.step(bad, T0 + 4 * MIN); e.step(bad, T0 + 7 * MIN)
  check('does not clear immediately', e.step(ok(), T0 + 7 * MIN + 10_000).cleared.length === 0)
  const c = e.step(ok(), T0 + 9 * MIN)
  check('clears after clearMs', c.cleared.length === 1 && c.cleared[0].kind === 'drive-missing')
  check('does not clear twice', e.step(ok(), T0 + 10 * MIN).cleared.length === 0)
}

// --- grouping ----------------------------------------------------------------------------------
{
  const e = eng()
  const cams = ['Front Gate', 'Yard', 'Bay 3'].map((name, i) => ({ nvrId: 'nvr-2', ch: i, name, online: false, recording: true, lastSegmentMs: T0 }))
  const s = ok({ cameras: cams, nvrs: [{ id: 'nvr-2', name: 'NVR 2', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }] })
  e.step(s, T0 + 4 * MIN)
  const r = e.step(s, T0 + 7 * MIN)
  check('3 offline cameras on one NVR are one alert', r.opened.length === 1, JSON.stringify(r.opened.map(a => a.title)))
  check('the title counts them', r.opened[0].title === 'nvr-2: 3 cameras offline', r.opened[0]?.title)
  check('the detail names them', r.opened[0].detail.includes('Front Gate') && r.opened[0].detail.includes('Bay 3'))
}

// --- suppression -------------------------------------------------------------------------------
{
  const e = eng()
  const s = ok({
    cameras: [{ nvrId: 'nvr1', ch: 0, name: 'Cashier Front', online: false, recording: true, lastSegmentMs: T0 - 30 * MIN }],
    nvrs: [{ id: 'nvr1', name: 'Main site', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }]
  })
  e.step(s, T0 + 4 * MIN)
  const r = e.step(s, T0 + 7 * MIN)
  check('an offline camera does not also raise not-recording', r.opened.length === 1 && r.opened[0].kind === 'camera-offline', JSON.stringify(r.opened.map(a => a.kind)))
}
{
  const e = eng()
  const s = ok({
    cameras: [0, 1].map((ch) => ({ nvrId: 'nvr1', ch, name: `Cam ${ch}`, online: false, recording: true, lastSegmentMs: T0 - 30 * MIN })),
    nvrs: [{ id: 'nvr1', name: 'Main site', online: false, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }]
  })
  e.step(s, T0 + 4 * MIN)
  const r = e.step(s, T0 + 7 * MIN)
  check('an offline NVR folds in its cameras', r.opened.length === 1 && r.opened[0].kind === 'nvr-offline', JSON.stringify(r.opened.map(a => a.kind)))
}
{
  const e = eng()
  const s = ok({
    locations: [{ id: 'usb', name: 'USB drive', mounted: false, freePct: 0 }],
    cameras: [{ nvrId: 'nvr1', ch: 0, name: 'Cashier Front', online: true, recording: true, lastSegmentMs: T0 - 30 * MIN }]
  })
  e.step(s, T0 + 4 * MIN)
  const r = e.step(s, T0 + 7 * MIN)
  check('a missing drive suppresses not-recording', r.opened.every(a => a.kind !== 'not-recording'), JSON.stringify(r.opened.map(a => a.kind)))
}

// --- immediate kinds ---------------------------------------------------------------------------
{
  const e = eng()
  const s = ok({ nvrs: [{ id: 'nvr1', name: 'Main site', online: true, loginError: 'wrong password', refusalsLast10Min: 0, clockSkewMs: 0 }] })
  const r = e.step(s, T0 + 4 * MIN)
  check('a login failure opens at once (no raise delay)', r.opened.length === 1 && r.opened[0].kind === 'nvr-login')
}
{
  const e = eng()
  const s = ok({ nvrs: [{ id: 'nvr1', name: 'Main site', online: true, loginError: null, refusalsLast10Min: 3, clockSkewMs: 0 }] })
  check('2 refusals is not enough', eng().step(ok({ nvrs: [{ id: 'nvr1', name: 'M', online: true, loginError: null, refusalsLast10Min: 2, clockSkewMs: 0 }] }), T0 + 4 * MIN).opened.length === 0)
  check('3 refusals in 10 min opens at once', e.step(s, T0 + 4 * MIN).opened.length === 1)
}

// --- clock skew --------------------------------------------------------------------------------
{
  const e = eng()
  const s = ok({ nvrs: [{ id: 'nvr1', name: 'Main site', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 220_000 }] })
  e.step(s, T0 + 4 * MIN)
  const r = e.step(s, T0 + 7 * MIN)
  check('a 220 s clock skew opens', r.opened.length === 1 && r.opened[0].kind === 'nvr-clock', JSON.stringify(r.opened.map(a => a.kind)))
  check('the title says how far out', r.opened[0].title === 'nvr1 clock is 220 s fast', r.opened[0]?.title)
  check('a 10 s skew does not open', eng().step(ok({ nvrs: [{ id: 'n', name: 'n', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 10_000 }] }), T0 + 7 * MIN).opened.length === 0)
}

// --- restart (one shot) ------------------------------------------------------------------------
{
  const e = eng()
  const s = ok({ restartReason: 'watchdog: SDK call stuck for 90 s' })
  const r = e.step(s, T0 + 1 * MIN)
  check('a restart reports during the grace', r.opened.length === 1 && r.opened[0].kind === 'server-restart')
  check('and never repeats', e.step(s, T0 + 5 * MIN).opened.length === 0)
  check('and never clears', e.step(ok(), T0 + 9 * MIN).cleared.length === 0)
}

// --- muting ------------------------------------------------------------------------------------
{
  const e = eng({ muted: ['drive-missing'] })
  const bad = ok({ locations: [{ id: 'usb', name: 'USB drive', mounted: false, freePct: 0 }] })
  e.step(bad, T0 + 4 * MIN)
  check('a muted kind never opens', e.step(bad, T0 + 7 * MIN).opened.length === 0)
}

// --- the NVR's own disk ------------------------------------------------------------------------
//
// The NVR keeps its own copy of roughly the last 30 days, and that copy is the only redundancy
// this system has. A disk the NVR itself calls broken has to be worth a message; a disk we simply
// could not ask about must not be.
const withStorage = (storage, nvr = {}) => ok({ nvrs: [{ id: 'nvr1', name: 'Main site', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0, storage, ...nvr }] })
const healthyDisk = { available: true, disks: [{ name: 'disk1', state: 'ok', status: 'read/write' }], days: 33, worst: 'ok' }
const brokenDisk = { available: true, disks: [{ name: 'disk1', state: 'ok', status: 'read/write' }, { name: 'disk2', state: 'bad', status: 'exception' }], days: 33, worst: 'bad' }
{
  const e = eng()
  const bad = withStorage(brokenDisk)
  check('a healthy disk opens nothing', e.step(withStorage(healthyDisk), T0 + 7 * MIN).opened.length === 0)
  const e2 = eng()
  check('a failed disk waits out raiseMs like the rest', e2.step(bad, T0 + 4 * MIN).opened.length === 0)
  const r = e2.step(bad, T0 + 7 * MIN)
  check('then nvr-disk opens', r.opened.length === 1 && r.opened[0].kind === 'nvr-disk', JSON.stringify(r.opened))
  check('it is high severity: the safety net is gone', r.opened[0].severity === 'high')
  check('it names the disk and what the NVR called it', /disk2/.test(r.opened[0].detail) && /exception/.test(r.opened[0].detail), r.opened[0].detail)
  check('one alert per NVR, not one per disk', e2.step(bad, T0 + 9 * MIN).open.filter((a) => a.kind === 'nvr-disk').length === 1)
  const c = e2.step(withStorage(healthyDisk), T0 + 11 * MIN)
  check('and it clears when the disk comes back', c.cleared.length === 1 && c.cleared[0].kind === 'nvr-disk')
}
{
  const e = eng()
  const none = withStorage({ available: true, disks: [], days: null, worst: 'missing' })
  e.step(none, T0 + 4 * MIN)
  const r = e.step(none, T0 + 7 * MIN)
  check('an NVR that reports no disk at all raises it', r.opened.length === 1 && /no disk/.test(r.opened[0].title), JSON.stringify(r.opened))
}
{
  // The important half of the rule: silence when we do not know, rather than a guess.
  const e = eng()
  for (const s of [null, undefined, { available: false, why: 'not supported', disks: [], days: null, worst: 'unknown' }]) {
    e.step(withStorage(s), T0 + 4 * MIN)
    check('an NVR we could not ask raises nothing', e.step(withStorage(s), T0 + 7 * MIN).opened.length === 0, JSON.stringify(s))
  }
}
{
  // A word we have never seen ('unknown') is not evidence of a fault.
  const e = eng()
  const odd = withStorage({ available: true, disks: [{ name: 'disk1', state: 'unknown', status: 'quantum flux' }], days: null, worst: 'unknown' })
  e.step(odd, T0 + 4 * MIN)
  check('an unrecognised disk state raises nothing', e.step(odd, T0 + 7 * MIN).opened.length === 0)
}
{
  // An offline NVR has its own alert; its stale disk reading must not add a second one.
  const e = eng()
  const off = withStorage(brokenDisk, { online: false })
  e.step(off, T0 + 4 * MIN)
  const r = e.step(off, T0 + 7 * MIN)
  check('an offline NVR raises nvr-offline only', r.opened.length === 1 && r.opened[0].kind === 'nvr-offline', JSON.stringify(r.opened.map((a) => a.kind)))
}
{
  const e = eng({ muted: ['nvr-disk'] })
  const bad = withStorage(brokenDisk)
  e.step(bad, T0 + 4 * MIN)
  check('nvr-disk can be muted like any other kind', e.step(bad, T0 + 7 * MIN).opened.length === 0)
}

// --- refusals that nobody counted ---------------------------------------------------------------
{
  const e = eng()
  const unmeasured = ok({ nvrs: [{ id: 'nvr1', name: 'Main site', online: true, loginError: null, refusalsLast10Min: null, clockSkewMs: 0 }] })
  e.step(unmeasured, T0 + 4 * MIN)
  check('a refusal count of null never fires nvr-refusing', e.step(unmeasured, T0 + 7 * MIN).opened.length === 0)
}

check('KINDS covers every kind used', ['server-restart', 'drive-missing', 'drive-full', 'not-recording', 'camera-offline', 'nvr-offline', 'nvr-disk', 'nvr-refusing', 'nvr-login', 'nvr-clock', 'retention-short'].every(k => KINDS.includes(k)), KINDS.join())

// --- days kept short of the target (retention-target.mjs, 2026-09-30): handed in ready made, like the forecast ---
{
  const short = { key: 'retention-short/nas', kind: 'retention-short', title: '/srv/nas keeps 8.2 days of footage, short of its 30-day target', detail: 'At 1.47 TB a day ...' }
  // (the camera keeps recording all along: only the storage figure is wrong)
  const at = (ms, extra = []) => ok({ extra, cameras: [{ nvrId: 'nvr1', ch: 0, name: 'Cashier Front', online: true, recording: true, lastSegmentMs: ms }] })
  const e = eng()
  const first = e.step(at(T0 + 4 * MIN, [short]), T0 + 4 * MIN)
  const due = e.step(at(T0 + 7 * MIN, [short]), T0 + 7 * MIN)
  check('retention-short: not on the first sighting; opens once raiseMs has passed, as a medium alert', first.opened.length === 0 && due.opened.length === 1 && due.opened[0].kind === 'retention-short' && due.opened[0].severity === 'medium', JSON.stringify(due.opened))
  const later = e.step(at(T0 + 60 * MIN, [{ ...short, title: '/srv/nas keeps 8.3 days of footage, short of its 30-day target' }]), T0 + 60 * MIN)
  check('... never sent again while it holds, though its days move', later.opened.length === 0 && later.open.length === 1 && /8\.3 days/.test(later.open[0].title), JSON.stringify(later.open.map((a) => a.title)))
  const gone = [e.step(at(T0 + 61 * MIN), T0 + 61 * MIN), e.step(at(T0 + 63 * MIN), T0 + 63 * MIN)].flatMap((r) => r.cleared)
  check('... cleared once it no longer holds (clearMs after its last sighting), once', gone.length === 1 && gone[0].kind === 'retention-short', JSON.stringify(gone))
  const m = eng({ muted: ['retention-short'] })
  m.step(at(T0 + 4 * MIN, [short]), T0 + 4 * MIN)
  check('... and can be muted like any other kind', m.step(at(T0 + 7 * MIN, [short]), T0 + 7 * MIN).opened.length === 0)
}

// --- an open alert keeps its severity and start (audit 2026-10-07 M3) ---------------------------
{
  const e = eng()
  const nvr = (online) => [{ id: 'nvr1', name: 'Main site', online, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }]
  e.step(ok({ nvrs: nvr(false) }), T0 + 4 * MIN)
  const opened = e.step(ok({ nvrs: nvr(false) }), T0 + 6 * MIN).opened[0]
  check('nvr-offline opens high, since its first sighting', opened?.severity === 'high' && opened.since === T0 + 4 * MIN, JSON.stringify(opened))
  const later = e.step(ok({ nvrs: nvr(false) }), T0 + 7 * MIN).open[0]
  check('on the next pass the open alert still has its severity and start', later?.severity === 'high' && later.since === T0 + 4 * MIN, JSON.stringify(later))
  e.step(ok(), T0 + 7 * MIN + 30_000)
  const gone = e.step(ok(), T0 + 9 * MIN).cleared[0]
  check('... and so does its clear', gone?.severity === 'high' && gone.since === T0 + 4 * MIN && gone.clearedAt === T0 + 9 * MIN, JSON.stringify(gone))
}
{
  // the wording still follows the facts: a second camera going offline changes the open alert's title
  const e = eng()
  const cam = (ch, online) => ({ nvrId: 'nvr1', ch, name: `Cam ${ch + 1}`, online, recording: true, lastSegmentMs: T0 })
  const one = ok({ cameras: [cam(0, false), cam(1, true)] })
  e.step(one, T0 + 4 * MIN); e.step(one, T0 + 6 * MIN)
  const r = e.step(ok({ cameras: [cam(0, false), cam(1, false)] }), T0 + 7 * MIN)
  check('an open alert takes the newer wording and keeps its severity', r.opened.length === 0 && r.open[0]?.title === 'nvr1: 2 cameras offline' && r.open[0].severity === 'medium' && r.open[0].since === T0 + 4 * MIN, JSON.stringify(r.open))
}

// --- a camera alert is not "OK again" because its NVR went offline (audit 2026-10-07 M3) --------
{
  const e = eng()
  const nvr = (online) => [{ id: 'nvr1', name: 'Main site', online, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }]
  const cam = (online) => [{ nvrId: 'nvr1', ch: 0, name: 'Cashier Front', online, recording: true, lastSegmentMs: T0 }]
  const camDown = ok({ cameras: cam(false) })
  const nvrDown = ok({ cameras: cam(false), nvrs: nvr(false) })
  e.step(camDown, T0 + 4 * MIN)
  check('the camera alert opens', e.step(camDown, T0 + 6 * MIN).opened[0]?.kind === 'camera-offline')
  const cleared = []
  let r
  for (let t = 7; t <= 20; t++) {
    r = e.step(nvrDown, T0 + t * MIN)
    cleared.push(...r.cleared)
  }
  check('with its NVR offline the camera alert does not clear', cleared.length === 0, JSON.stringify(cleared))
  check('... and both stay open', r.open.map((a) => a.kind).sort().join() === 'camera-offline,nvr-offline', r.open.map((a) => a.kind).join())
  // the NVR is back and the camera is still offline: the same alert goes on, nothing is sent again
  r = e.step(camDown, T0 + 21 * MIN)
  check('NVR back, camera still offline: no second camera alert', r.opened.length === 0 && r.open.some((a) => a.kind === 'camera-offline'), JSON.stringify(r.opened))
  check('... only the NVR alert clears', r.cleared.length === 1 && r.cleared[0].kind === 'nvr-offline', JSON.stringify(r.cleared))
  // the camera really is back: it clears clearMs after that, as before
  check('camera back: not cleared at once', e.step(ok(), T0 + 21 * MIN + 30_000).cleared.length === 0)
  r = e.step(ok(), T0 + 23 * MIN)
  check('... cleared after clearMs', r.cleared.length === 1 && r.cleared[0].kind === 'camera-offline' && r.cleared[0].severity === 'medium', JSON.stringify(r.cleared))
}
{
  // NVR back with the camera online: the clear time starts when the NVR could be asked again
  const e = eng()
  const nvr = (online) => [{ id: 'nvr1', name: 'Main site', online, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }]
  const cam = (online) => [{ nvrId: 'nvr1', ch: 0, name: 'Cashier Front', online, recording: true, lastSegmentMs: T0 + 30 * MIN }]
  const camDown = ok({ cameras: cam(false) })
  e.step(camDown, T0 + 4 * MIN); e.step(camDown, T0 + 6 * MIN)
  for (let t = 7; t <= 12; t++) e.step(ok({ cameras: cam(false), nvrs: nvr(false) }), T0 + t * MIN)
  const up = ok({ cameras: cam(true) })
  check('NVR and camera back: the camera alert is not cleared on the first pass', e.step(up, T0 + 12 * MIN + 30_000).cleared.every((a) => a.kind !== 'camera-offline'))
  const all = [...e.step(up, T0 + 13 * MIN).cleared, ...e.step(up, T0 + 14 * MIN).cleared]
  check('... and is cleared clearMs later', all.some((a) => a.kind === 'camera-offline'), JSON.stringify(all.map((a) => a.kind)))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
