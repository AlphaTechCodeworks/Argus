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

check('KINDS covers every kind used', ['server-restart', 'drive-missing', 'drive-full', 'not-recording', 'camera-offline', 'nvr-offline', 'nvr-refusing', 'nvr-login', 'nvr-clock'].every(k => KINDS.includes(k)), KINDS.join())

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
