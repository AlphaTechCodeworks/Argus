// Tests for the alerts made from the history of the server's key numbers (server-health-alerts.mjs):
// each rule's open and clear thresholds (the hysteresis), the wording, the disks read once per
// filesystem, the state kept between looks, and that alerts.mjs opens and clears them as they come
// (SELF_TIMED) with mute and grace as for any kind. Fake samples and a clock of their own; no server.
// Run:  node cctv/test/server-health-alerts.test.mjs
import { KINDS as ENGINE_KINDS, alertEngine } from '../alerts.mjs'
import { makeMetricsHistory } from '../metrics-history.mjs'
import { KINDS, LIMITS, diskFree, makeServerHealth, serverHealthAlerts } from '../server-health-alerts.mjs'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}
const J = (v) => JSON.stringify(v)
const MIN = 60_000
const T0 = 1_760_000_000_000
const GB = 2 ** 30

/** A minute's sample, the numbers that matter here and nothing else. */
const sample = (i, o = {}) => ({ t: T0 + i * MIN, load1: 1, cpuCount: 8, sub: { refused: 0 }, main: { refused: 0 }, perNvr: {}, ...o })
/** Samples 0..n-1, each with what `at(i)` says. */
const run = (n, at = () => ({})) => Array.from({ length: n }, (_, i) => sample(i, at(i)))
const keys = (list) => list.map((a) => a.key).sort()
const nowAfter = (samples) => samples.at(-1).t + 10_000

check('every kind is one the engine knows (and so can be muted in Settings)', KINDS.every((k) => ENGINE_KINDS.includes(k)), KINDS.join())

// ---- overloaded ----
{
  const nine = run(9, () => ({ load1: 9.4 }))
  check('overloaded: 9 minutes at or over the cores is not yet', serverHealthAlerts({ samples: nine, now: nowAfter(nine) }).length === 0)
  const ten = run(10, (i) => ({ load1: i === 0 ? 8 : 9.4 })) // exactly the core count counts as over
  const a = serverHealthAlerts({ samples: ten, now: nowAfter(ten) })
  check('overloaded: 10 minutes in a row opens it', J(keys(a)) === J(['server-overloaded']))
  const twelve = run(12, () => ({ load1: 9.4 }))
  const w = serverHealthAlerts({ samples: twelve, now: nowAfter(twelve) })[0]
  check('overloaded: the wording', `${w.title} — ${w.detail}` === 'Server overloaded: load 9.4 on 8 cores for 12 minutes — video may stutter', `${w.title} — ${w.detail}`)
  const dip = run(10, (i) => ({ load1: i === 4 ? 7.9 : 9 }))
  check('overloaded: one minute under breaks the run', serverHealthAlerts({ samples: dip, now: nowAfter(dip) }).length === 0)
  const gap = run(11, () => ({ load1: 9 })).filter((s, i) => i !== 5)
  check('overloaded: a missing minute breaks the run', serverHealthAlerts({ samples: gap, now: nowAfter(gap) }).length === 0)
  check('overloaded: a stopped sampler opens nothing', serverHealthAlerts({ samples: twelve, now: nowAfter(twelve) + 5 * MIN }).length === 0)
  check('overloaded: unknown load or cores opens nothing', serverHealthAlerts({ samples: run(12, () => ({ load1: null })), now: nowAfter(twelve) }).length === 0 &&
    serverHealthAlerts({ samples: run(12, () => ({ load1: 9, cpuCount: null })), now: nowAfter(twelve) }).length === 0)

  // the hysteresis: held while under the core count but not yet 5 minutes under 0.8 of it
  const up = new Set(['server-overloaded'])
  const band = [...twelve, ...run(3, () => ({ load1: 7 })).map((s, i) => ({ ...s, t: T0 + (12 + i) * MIN }))]
  const held = serverHealthAlerts({ samples: band, now: nowAfter(band), wasUp: up })
  check('overloaded: held between 0.8 of the cores and the cores', J(keys(held)) === J(['server-overloaded']), held[0]?.title)
  check('overloaded: ...and not opened there when it was not up', serverHealthAlerts({ samples: run(15, () => ({ load1: 7 })), now: nowAfter(band) }).length === 0)
  const four = [...twelve, ...run(4, () => ({ load1: 6 })).map((s, i) => ({ ...s, t: T0 + (12 + i) * MIN }))]
  check('overloaded: 4 minutes under 0.8 of the cores still held', serverHealthAlerts({ samples: four, now: nowAfter(four), wasUp: up }).length === 1)
  const five = [...twelve, ...run(5, () => ({ load1: 6 })).map((s, i) => ({ ...s, t: T0 + (12 + i) * MIN }))]
  check('overloaded: 5 minutes under 0.8 of the cores clears it', serverHealthAlerts({ samples: five, now: nowAfter(five), wasUp: up }).length === 0)
  check('overloaded: no fresh sample keeps an open one open', serverHealthAlerts({ samples: twelve, now: nowAfter(twelve) + 10 * MIN, wasUp: up }).length === 1)
}

// ---- the server's own disk ----
{
  const now = T0
  const d = (free) => [{ path: '/opt/cctv', freeBytes: free }]
  const low = serverHealthAlerts({ samples: [], disks: d(1.2 * GB), now })
  check('disk: under 1.5 GB opens it', J(keys(low)) === J(['server-disk//opt/cctv']))
  check('disk: the wording', low[0]?.title === 'Server disk nearly full: 1.2 GB free on /opt/cctv', low[0]?.title)
  check('disk: 1.5 GB exactly is not under', serverHealthAlerts({ samples: [], disks: d(1.5 * GB), now }).length === 0)
  const up = new Set(['server-disk//opt/cctv'])
  check('disk: held at 1.8 GB when it was up', serverHealthAlerts({ samples: [], disks: d(1.8 * GB), now, wasUp: up }).length === 1)
  check('disk: ...not opened at 1.8 GB when it was not', serverHealthAlerts({ samples: [], disks: d(1.8 * GB), now }).length === 0)
  check('disk: over 2 GB clears it', serverHealthAlerts({ samples: [], disks: d(2.1 * GB), now, wasUp: up }).length === 0)
  check('disk: unreadable keeps an open one, opens none', serverHealthAlerts({ samples: [], disks: d(null), now, wasUp: up }).length === 1 &&
    serverHealthAlerts({ samples: [], disks: d(null), now }).length === 0)

  const fs = {
    statSync: (p) => { if (p === '/missing') throw new Error('ENOENT'); return { dev: p.startsWith('/opt') ? 1 : 2 } },
    statfsSync: (p) => { if (p === '/bad') throw new Error('EIO'); return { bavail: 100, bsize: 4096 } }
  }
  const got = diskFree(['/opt/cctv', '/opt/cctv/data', '/missing', '/var/lib/cctv'], fs)
  check('diskFree: once per filesystem, a missing path left out', J(got) === J([{ path: '/opt/cctv', freeBytes: 409600 }, { path: '/var/lib/cctv', freeBytes: 409600 }]), J(got))
  check('diskFree: one that cannot be read is null', J(diskFree(['/bad'], fs)) === J([{ path: '/bad', freeBytes: null }]))
}

// ---- one recorder failing ----
{
  const names = { gpri: 'Gate Priority', law: 'Lawn' }
  const fails = (n, per = {}) => run(n, () => ({ perNvr: per }))
  // 30 minutes of one failed start each: 30
  const s30 = fails(30, { gpri: { failedStarts: 1, stalls: 0, relogins: 0, linkDrops: 0 } })
  const a = serverHealthAlerts({ samples: s30, now: nowAfter(s30), nvrNames: names })
  check('recorder: 30 failed starts in 30 minutes opens it', J(keys(a)) === J(['nvr-failing/gpri']))
  check('recorder: named by its display name', a[0]?.title === 'Recorder Gate Priority failing: 30 streams failed or stalled in 30 minutes', a[0]?.title)
  const s29 = fails(29, { gpri: { failedStarts: 1 } })
  check('recorder: 29 is not yet', serverHealthAlerts({ samples: s29, now: nowAfter(s29) }).length === 0)
  const mixed = fails(15, { gpri: { failedStarts: 1, stalls: 1 } })
  check('recorder: failed starts and stalls are added', serverHealthAlerts({ samples: mixed, now: nowAfter(mixed) }).length === 1)
  const re = fails(6, { law: { relogins: 1 } })
  const r = serverHealthAlerts({ samples: re, now: nowAfter(re), nvrNames: names })
  check('recorder: 6 re-logins opens it', J(keys(r)) === J(['nvr-failing/law']) && r[0].title === 'Recorder Lawn failing: 6 re-logins in 30 minutes', r[0]?.title)
  const old = run(40, (i) => ({ perNvr: i < 10 ? { gpri: { failedStarts: 5 } } : {} }))
  check('recorder: counts older than 30 minutes do not count', serverHealthAlerts({ samples: old, now: nowAfter(old) }).length === 0)
  const up = new Set(['nvr-failing/gpri'])
  const half = fails(15, { gpri: { failedStarts: 1 } })
  check('recorder: held at half (15) when it was up', serverHealthAlerts({ samples: half, now: nowAfter(half), wasUp: up }).length === 1)
  const under = fails(14, { gpri: { failedStarts: 1 } })
  check('recorder: under half clears it', serverHealthAlerts({ samples: under, now: nowAfter(under), wasUp: up }).length === 0)
  check('recorder: one with no counts left clears', serverHealthAlerts({ samples: run(5), now: nowAfter(run(5)), wasUp: up }).length === 0)
  check('recorder: an unknown id is named by its id', serverHealthAlerts({ samples: s30, now: nowAfter(s30) })[0]?.title.startsWith('Recorder gpri failing'))
}

// ---- viewers refused ----
{
  const at = (mins) => run(10, (i) => (mins.includes(i) ? { sub: { refused: 2 }, main: { refused: i === 9 ? 1 : 0 } } : {}))
  const two = at([1, 5])
  check('refused: 2 of the last 10 minutes is not yet', serverHealthAlerts({ samples: two, now: nowAfter(two) }).length === 0)
  const three = at([1, 5, 9])
  const a = serverHealthAlerts({ samples: three, now: nowAfter(three) })
  check('refused: 3 of the last 10 minutes opens it', J(keys(a)) === J(['viewers-refused']))
  check('refused: the wording counts sub and main', a[0]?.title === 'Viewers refused: 7 pictures turned away in 3 of the last 10 minutes', a[0]?.title)
  const up = new Set(['viewers-refused'])
  check('refused: held at 2 minutes when it was up', serverHealthAlerts({ samples: two, now: nowAfter(two), wasUp: up }).length === 1)
  const one = at([9])
  check('refused: 1 minute clears it', serverHealthAlerts({ samples: one, now: nowAfter(one), wasUp: up }).length === 0)
  const aged = run(20, (i) => ([1, 2, 3].includes(i) ? { sub: { refused: 1 } } : {}))
  check('refused: minutes older than 10 do not count', serverHealthAlerts({ samples: aged, now: nowAfter(aged) }).length === 0)
}

// ---- the state between looks ----
{
  let samples = run(12, () => ({ load1: 9 }))
  let t = nowAfter(samples)
  const logs = []
  const h = makeServerHealth({ samples: () => samples, now: () => t, log: (l) => logs.push(l) })
  check('state: opens', h.candidates().length === 1)
  samples = [...samples, sample(12, { load1: 7 })]
  t = nowAfter(samples)
  check('state: remembers it was up, so the lower line holds it', h.candidates().length === 1)
  samples = [...samples, ...[13, 14, 15, 16, 17].map((i) => sample(i, { load1: 5 }))]
  t = nowAfter(samples)
  check('state: clears after 5 calm minutes', h.candidates().length === 0)
  samples = [...samples, sample(18, { load1: 7 })]
  t = nowAfter(samples)
  check('state: once clear, the band does not open it again', h.candidates().length === 0)

  let boom = false
  let s2 = run(12, () => ({ load1: 9 }))
  const h2 = makeServerHealth({ samples: () => { if (boom) throw new Error('gone'); return s2 }, now: () => nowAfter(s2), log: (l) => logs.push(l) })
  h2.candidates()
  boom = true
  const kept = h2.candidates()
  h2.candidates()
  check('state: a failing provider answers what it answered last, never throws', kept.length === 1 && kept[0].key === 'server-overloaded')
  check('state: ...and says so once an hour', logs.filter((l) => l.includes('server-health checks failed')).length === 1, J(logs))
}

// ---- the samples kept in memory (metrics-history.mjs recent()) ----
{
  let t = T0
  const io = { appendFile: async () => {}, readFile: async () => '', writeFile: async () => {}, rename: async () => {}, open: async () => { throw new Error('none') } }
  const m = makeMetricsHistory({ file: 'x', providers: { load1: () => 2, cpuCount: () => 8 }, counts: { take: () => ({}) }, now: () => t, io, log: () => {} })
  for (let i = 0; i < 70; i++) {
    t = T0 + i * MIN
    await m.sample()
  }
  const r = m.recent()
  check('recent(): the last 60, oldest first', r.length === 60 && r[0].t === T0 + 10 * MIN && r.at(-1).t === T0 + 69 * MIN, `${r.length}`)
  r.length = 0
  check('recent(): a copy', m.recent().length === 60)
}

// ---- through the engine: opened at once, cleared at once, muted and grace as any kind ----
{
  const base = { raiseMs: 2 * MIN, clearMs: 5 * MIN, graceMs: 3 * MIN, notRecordingMs: 5 * MIN, clockSkewMs: 30_000 }
  const cand = { key: 'server-overloaded', kind: 'server-overloaded', title: 'Server overloaded: load 9 on 8 cores for 10 minutes', detail: 'video may stutter' }
  const snap = (extra) => ({ startedMs: T0, extra, locations: [], nvrs: [], cameras: [] })
  const e = alertEngine(base)
  const t1 = T0 + 10 * MIN
  const s1 = e.step(snap([cand]), t1)
  check('engine: opened on the first sighting (its own hold is already done)', s1.opened.length === 1 && s1.opened[0].severity === 'medium')
  const s2 = e.step(snap([]), t1 + 30_000)
  check('engine: cleared on the first check it is missing from', s2.cleared.length === 1 && s2.open.length === 0)
  const disk = { key: 'server-disk//opt/cctv', kind: 'server-disk', title: 'Server disk nearly full: 1.2 GB free on /opt/cctv', detail: 'x' }
  check('engine: the disk one is high', e.step(snap([disk]), t1 + 60_000).opened[0]?.severity === 'high')
  const muted = alertEngine({ ...base, muted: ['server-overloaded'] })
  check('engine: muted like any kind', muted.step(snap([cand]), t1).opened.length === 0)
  check('engine: nothing in the start-up grace', alertEngine(base).step(snap([cand]), T0 + MIN).opened.length === 0)
  const other = { key: 'drive-full/x', kind: 'drive-full', title: 'x', detail: '' }
  const e2 = alertEngine(base)
  e2.step(snap([other]), t1)
  check('engine: other kinds keep their raise time', e2.step(snap([other]), t1 + MIN).opened.length === 0 && e2.step(snap([other]), t1 + 2 * MIN).opened.length === 1)
  check('engine: ...and their clear time', e2.step(snap([]), t1 + 3 * MIN).cleared.length === 0)
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exitCode = failed ? 1 : 0
