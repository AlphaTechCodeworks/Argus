// Tests for the history of the key numbers (metrics-history.mjs): which of a worker's lines are
// counted as what, the line written each minute, 14 days kept, reading the last hours back, the
// answer cut down to about 720 points, and the admins' route. A temporary folder, a clock of its
// own; no server, no SDK.
// Run:  node cctv/test/metrics-history.test.mjs
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KEEP_MS, MAX_POINTS, METRICS_PATH, SAMPLE_MS, TRIM_EVERY_MS, buildSample, classifyWorkerLine, downsample, handleMetrics, hoursOf, makeLineCounts, makeMetricsHistory } from '../metrics-history.mjs'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}
const J = (v) => JSON.stringify(v)

// ---- the workers' lines ----
{
  for (const [line, want] of [
    ['stream gpri/3:sub failed to start (refused in 12 ms: cannot connect)', 'failedStarts'],
    ['stream gpri/3:main failed to start (failed after 5003 ms: network timeout)', 'failedStarts'],
    ['stream law/17:main no video within 20 s of starting (refused by the NVR?), restarting', 'failedStarts'],
    ['stream gpri/12:sub stalled, restarting', 'stalls'],
    ['[gpri] 3 streams failed to start, logging in again in 30 s', 'relogins'],
    ['[gpri] the NVR stopped answering, logging in again', 'relogins'],
    ['[gpri] the NVR dropped its links: viewers\' new streams on it wait 30 s', 'linkDrops'],
    ['stream gpri/3:sub started', null],
    ['stream gpri/3:sub stopped (no viewers)', null],
    ['stream gpri/3:sub stop failed: network timeout', null],
    ['[gpri] 2 stalled streams left alone while this NVR answers slowly; restarting once it has cooled down', null],
    ['[gpri] login to 10.0.0.5:6036 failed: cannot connect; retrying in 30s', null],
    ['Net Disconnected...... m_deviceID = 12', null],
    ['../../DVR_NET_SDK/source/main_utility/NVRNetDevice_N9000.cpp, StartLive,2805 StartLive false channel=1,streamType=2', null],
    ['', null]
  ]) check(`${want ?? 'not counted'}: ${line.slice(0, 50)}`, classifyWorkerLine(line) === want, String(classifyWorkerLine(line)))
  check('not a string is not counted', classifyWorkerLine(undefined) === null && classifyWorkerLine(null) === null)

  const c = makeLineCounts()
  c.line('gpri', 'stream gpri/3:sub failed to start (x)')
  c.line('gpri', 'stream gpri/4:sub failed to start (x)')
  c.line('gpri', 'stream gpri/3:sub stalled, restarting')
  c.line('law', '[law] the NVR dropped its links: viewers\' new streams on it wait 30 s')
  c.line('quiet', 'stream quiet/1:sub started')
  const got = c.take()
  check('counted per recorder; one with nothing is left out', J(got) === J({ gpri: { failedStarts: 2, stalls: 1, relogins: 0, linkDrops: 0 }, law: { failedStarts: 0, stalls: 0, relogins: 0, linkDrops: 1 } }), J(got))
  check('taken: the next minute starts from nothing', J(c.take()) === '{}')
}

// ---- one sample ----
const providers = (o = {}) => ({
  load1: () => 1.23456,
  cpuCount: () => 8,
  nvrs: () => ({ online: 9, total: 10 }),
  streams: () => 142,
  viewers: () => ({ people: 5, local: 4, remote: 1 }),
  h264: () => ({ running: 3, cap: 6, step: 'fine', units: 12, budgetUnits: 200, viewers: 4, refused: 7, main: { running: 1, refused: 2 } }),
  sdk: () => ({ inFlight: 2, late: 0 }),
  loopWorstMs: () => 38,
  ...o
})
{
  const last = { sub: null, main: null }
  const s = buildSample(providers(), { t: 1000, perNvr: { gpri: { failedStarts: 1, stalls: 0, relogins: 0, linkDrops: 0 } }, last })
  check('the line\'s shape', J(s) === J({ t: 1000, load1: 1.23, cpuCount: 8, nvrsOnline: 9, nvrsTotal: 10, streams: 142, viewers: { people: 5, local: 4, remote: 1 }, sub: { running: 3, units: 12, budgetUnits: 200, refused: 0 }, main: { running: 1, refused: 0 }, other: { remote: null, playback: null, playbackSd: null, steady: null, ffmpeg: null, rtsp: null, rtspReaders: null }, sdk: { inFlight: 2, late: 0 }, loopWorstMs: 38, perNvr: { gpri: { failedStarts: 1, stalls: 0, relogins: 0, linkDrops: 0 } } }), J(s))
  const s2 = buildSample(providers({ h264: () => ({ running: 3, units: 12, budgetUnits: 200, refused: 10, main: { running: 0, refused: 2 } }) }), { t: 2000, last })
  check('refused is this minute\'s, not the total', s2.sub.refused === 3 && s2.main.refused === 0, J([s2.sub, s2.main]))
  const s3 = buildSample(providers({ h264: () => ({ running: 0, units: 0, budgetUnits: 200, refused: 1 }) }), { t: 3000, last })
  check('a total that went back (a restart) is nothing refused; no main conversions is none running', s3.sub.refused === 0 && s3.main.running === 0 && s3.main.refused === 0, J([s3.sub, s3.main]))
  const s4 = buildSample(providers({ viewers: () => { throw new Error('x') }, load1: () => NaN, streams: undefined }), { t: 4000, last })
  check('a provider that throws, is missing or answers nonsense: nulls, the rest as it is', s4.viewers.people === null && s4.load1 === null && s4.streams === null && s4.cpuCount === 8 && s4.nvrsOnline === 9, J(s4))
}

// ---- the file ----
const dir = mkdtempSync(join(tmpdir(), 'metrics-history-'))
const file = join(dir, 'metrics.jsonl')
{
  let t = Date.UTC(2026, 9, 13, 12, 0, 0)
  const counts = makeLineCounts()
  const logged = []
  const h = makeMetricsHistory({ file, providers: providers(), counts, now: () => t, log: (l) => logged.push(l) })
  check('nothing recorded yet: nothing read, nothing said', J(await h.read(24)) === '[]' && logged.length === 0)
  counts.line('gpri', 'stream gpri/3:sub stalled, restarting')
  const first = await h.sample()
  check('a sample is one line of JSON', readFileSync(file, 'utf8') === `${J(first)}\n` && first.perNvr.gpri.stalls === 1, readFileSync(file, 'utf8').slice(0, 80))
  if (process.platform !== 'win32') check('the file is the service\'s alone (0600)', (statSync(file).mode & 0o777) === 0o600, (statSync(file).mode & 0o777).toString(8))
  for (let i = 0; i < 9; i++) {
    t += SAMPLE_MS
    await h.sample()
  }
  const all = await h.read(24)
  check('ten minutes: ten lines, oldest first, the counts in their own minute only', all.length === 10 && all[0].t === first.t && all[9].t === t && J(all[1].perNvr) === '{}', `${all.length}`)
  t += 30 * 60_000
  check('read(hours) is from now back', (await h.read(1)).length === 10 && (await makeMetricsHistory({ file, providers: providers(), now: () => t + 3_600_000 }).read(1)).length === 0)
  check('nothing was said in the journal', logged.length === 0, J(logged))
}
{
  // a long file: the last hours are read from its end, and whole lines only
  const t1 = Date.UTC(2026, 9, 13, 12, 0, 0)
  const pad = { viewers: { people: 5, local: 4, remote: 1 }, perNvr: { 'a-recorder-with-a-long-id': { failedStarts: 12, stalls: 3, relogins: 1, linkDrops: 0 }, 'Señal-ñ': { failedStarts: 1, stalls: 0, relogins: 0, linkDrops: 0 } } }
  const lines = []
  for (let i = 5 * 1440 - 1; i >= 0; i--) lines.push(J({ t: t1 - i * SAMPLE_MS, load1: 1, ...pad }))
  writeFileSync(file, `${lines.join('\n')}\n`)
  const h = makeMetricsHistory({ file, providers: providers(), now: () => t1, log: () => {} })
  const day = await h.read(24)
  check('five days on disk (over 1 MB): a day read back is its 1441 lines', statSync(file).size > 1_000_000 && day.length === 1441 && day[0].t === t1 - 86_400_000 && day.at(-1).t === t1, `${day.length}`)
  check('...with names outside ASCII whole', day[0].perNvr['Señal-ñ']?.failedStarts === 1)
  check('all of it when more is asked for than there is', (await h.read(336)).length === 5 * 1440)
  // a line cut short by a power loss is passed over
  writeFileSync(file, `${lines.slice(-3).join('\n')}\n{"t":${t1},"load1":\n`)
  check('a broken last line is left out, the rest read', (await h.read(1)).length === 3)
}
{
  // 14 days kept: older lines go, at most once an hour
  let t = Date.UTC(2026, 9, 13, 12, 0, 0)
  const old = [t - KEEP_MS - 2 * 3_600_000, t - KEEP_MS - 60_000, t - KEEP_MS + 3_600_000 + 60_000, t - 60_000]
  writeFileSync(file, old.map((x) => `${J({ t: x })}\n`).join(''))
  const h = makeMetricsHistory({ file, providers: providers(), now: () => t, log: () => {} })
  await h.sample()
  check('not trimmed in the first hour', readFileSync(file, 'utf8').split('\n').length - 1 === 5)
  t += TRIM_EVERY_MS
  await h.sample()
  const kept = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).t)
  check('an hour on: the lines older than 14 days are gone, the rest and the new one stay', J(kept) === J([old[2], old[3], t - TRIM_EVERY_MS, t]), J(kept))
  if (process.platform !== 'win32') check('...and the new file is still 0600', (statSync(file).mode & 0o777) === 0o600)
  t += SAMPLE_MS
  await h.sample()
  check('...and not again within the hour', readFileSync(file, 'utf8').trim().split('\n').length === 5)
}
{
  // a disk that cannot be written: swallowed, said once an hour at most
  let t = 1_000_000_000
  const logged = []
  const io = { appendFile: async () => { throw new Error('EACCES: permission denied') }, open: async () => { throw new Error('ENOENT') } }
  const h = makeMetricsHistory({ file, providers: providers(), now: () => t, log: (l) => logged.push(l), io })
  const s = await h.sample()
  t += SAMPLE_MS
  await h.sample()
  check('a write that fails does not throw, and is said once', s?.t === 1_000_000_000 && logged.length === 1 && /could not write the history: EACCES/.test(logged[0]), J(logged))
  t += TRIM_EVERY_MS
  await h.sample()
  check('...and again an hour later', logged.length === 2)
  check('a file that cannot be opened reads as nothing', J(await h.read(24)) === '[]')
  // providers that all throw still give a line; a counter that throws gives none, and no exception
  const bad = makeMetricsHistory({ file: join(dir, 'other.jsonl'), providers: { load1: () => { throw new Error('x') } }, counts: { take: () => { throw new Error('y') } }, now: () => t + TRIM_EVERY_MS, log: (l) => logged.push(l) })
  check('a sample that cannot be taken resolves to nothing', (await bad.sample()) === null && /could not take a sample: y/.test(logged.at(-1)), logged.at(-1))
}
{
  // start() samples on a timer that does not hold the process open; stop() ends it
  const f2 = join(dir, 'timer.jsonl')
  const h = makeMetricsHistory({ file: f2, providers: providers(), log: () => {} })
  check('start answers the recorder, twice is once', h.start(15) === h && h.start(15) === h)
  await new Promise((r) => setTimeout(r, 120))
  h.stop()
  await h.settled()
  const n = readFileSync(f2, 'utf8').trim().split('\n').length
  check('the timer wrote samples', n >= 2, `${n}`)
  await new Promise((r) => setTimeout(r, 60))
  await h.settled()
  check('...and none after stop', readFileSync(f2, 'utf8').trim().split('\n').length === n)
}

// ---- the answer: about 720 points ----
{
  const t0 = Math.floor(Date.UTC(2026, 9, 13) / (14 * SAMPLE_MS)) * 14 * SAMPLE_MS
  const mk = (i, o = {}) => ({ t: t0 + i * SAMPLE_MS, load1: i % 2 ? 3 : 1, cpuCount: 8, nvrsOnline: 9, nvrsTotal: 10, streams: 100 + (i % 2) * 10, viewers: { people: 4, local: 3, remote: 1 }, sub: { running: 2, units: 10, budgetUnits: 200, refused: 1 }, main: { running: 0, refused: 0 }, sdk: { inFlight: 1, late: 0 }, loopWorstMs: i % 14 === 3 ? 900 : 20, perNvr: i % 2 ? { law: { failedStarts: 2, stalls: 1, relogins: 0, linkDrops: 0 } } : {}, ...o })
  const day = Array.from({ length: 1440 }, (_, i) => mk(i))
  const twelve = downsample(day.slice(0, 720), { spanMs: 12 * 3_600_000 })
  check('12 hours fit as they are', twelve.bucketMs === SAMPLE_MS && twelve.samples.length === 720 && twelve.samples[0] === day[0])
  const d = downsample(day, { spanMs: 24 * 3_600_000 })
  check('24 hours: 720 points of 2 minutes', d.bucketMs === 2 * SAMPLE_MS && d.samples.length === 720, `${d.bucketMs} ${d.samples.length}`)
  const p = d.samples[0]
  check('levels are averaged', p.t === t0 && p.load1 === 2 && p.streams === 105 && p.viewers.people === 4 && p.sub.units === 10 && p.cpuCount === 8, J(p))
  check('counts are added up', p.sub.refused === 2 && J(p.perNvr) === J({ law: { failedStarts: 2, stalls: 1, relogins: 0, linkDrops: 0 } }), J([p.sub, p.perNvr]))
  check('the worst pause is the worst, not the average', d.samples[1].loopWorstMs === 900 && d.samples[0].loopWorstMs === 20)
  const week = Array.from({ length: 7 * 1440 }, (_, i) => mk(i))
  const w = downsample(week, { spanMs: 7 * 86_400_000 })
  check('7 days: 720 points of 14 minutes', w.bucketMs === 14 * SAMPLE_MS && w.samples.length === 720 && w.samples[0].perNvr.law.failedStarts === 14 && w.samples[0].sub.refused === 14, `${w.bucketMs} ${w.samples.length}`)
  check('14 days: still about 720', downsample(week, { spanMs: 14 * 86_400_000 }).samples.length <= MAX_POINTS)
  const gaps = downsample([mk(0, { load1: null, viewers: undefined, sub: undefined, perNvr: undefined }), mk(1, { load1: null })], { spanMs: 24 * 3_600_000 }).samples[0]
  check('missing figures stay missing, never NaN', gaps.load1 === null && gaps.viewers.people === 4 && gaps.sub.refused === 1 && !J(gaps).includes('NaN'), J(gaps))
  check('nothing in, nothing out', downsample([], { spanMs: 86_400_000 }).samples.length === 0)
}

// ---- the route ----
{
  check('hours: 1 to 336, 24 when not said', hoursOf(null) === 24 && hoursOf('') === 24 && hoursOf('abc') === 24 && hoursOf('0') === 1 && hoursOf('-5') === 1 && hoursOf('168') === 168 && hoursOf('9999') === 336 && hoursOf('2.9') === 2)
  const asked = []
  const history = { read: async (hours) => { asked.push(hours); return [{ t: 5 }, { t: 6 }] } }
  const q = (s) => new URLSearchParams(s)
  check('another path is not this route', (await handleMetrics('GET', '/api/admin/viewers', { admin: true }, q(''), history)) === null)
  const no = await handleMetrics('GET', METRICS_PATH, { user: 'bob', admin: false }, q(''), history)
  check('not an admin: 403, and the history is not read', no[0] === 403 && asked.length === 0)
  check('nobody: 403', (await handleMetrics('GET', METRICS_PATH, null, q(''), history))[0] === 403)
  const post = await handleMetrics('POST', METRICS_PATH, { admin: true }, q(''), history)
  check('only GET', post[0] === 405 && post[2].allow === 'GET')
  const ok = await handleMetrics('GET', METRICS_PATH, { user: 'ann', admin: true }, q(''), history, { now: () => 99 })
  check('an admin: now, the step and the samples, never cached', ok[0] === 200 && ok[1].now === 99 && ok[1].stepSeconds === 60 && ok[1].bucketSeconds === 120 && ok[1].hours === 24 && ok[1].samples.length === 1 && ok[2]['cache-control'] === 'no-store' && asked.at(-1) === 24, J(ok[1]))
  await handleMetrics('GET', METRICS_PATH, { admin: true }, q('hours=168'), history)
  await handleMetrics('GET', METRICS_PATH, { admin: true }, q('hours=100000'), history)
  check('hours as asked, held to 14 days', asked.at(-2) === 168 && asked.at(-1) === 336, J(asked))
}

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `${failed} FAILED` : 'all passed')
process.exitCode = failed ? 1 : 0
