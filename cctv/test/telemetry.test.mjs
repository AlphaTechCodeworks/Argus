// Tests the experience score (public/qoe.js), the page's collector (public/telemetry.js) and the
// server's side of it (telemetry.mjs).   node --test cctv/test/telemetry.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'argus-telemetry-'))
const { WEIGHTS, attention, score, smoothness, stability, startupScore, switchScore, scrubScore } = await import('../public/qoe.js')
const { createCollector, MAX_SAMPLES } = await import('../public/telemetry.js')
const { BODY_LIMIT, TELEMETRY_PATH, TELEMETRY_ADMIN_PATH, cleanBatch, cohortOf, handleTelemetry, makeTelemetry } = await import('../telemetry.mjs')

const near = (a, b, e = 1e-9) => Math.abs(a - b) < e

test('the weights are the owner\'s and add up to one', () => {
  assert.deepEqual(WEIGHTS, { smoothness: 0.35, startup: 0.25, scrubbing: 0.15, switching: 0.1, stability: 0.1, efficiency: 0.05 })
  assert.ok(near(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 1))
})

test('smoothness: full marks at the rate owed, nothing while frozen', () => {
  assert.equal(smoothness({ fps: 20, fpsSrc: 20, role: 'focus' }), 1)
  assert.equal(smoothness({ fps: 10, fpsSrc: 20, role: 'focus' }), 0.5)
  // a grid tile is owed 15 at most: 15 of a 30 fps camera is all it can use
  assert.equal(smoothness({ fps: 15, fpsSrc: 30, role: 'grid' }), 1)
  assert.equal(smoothness({ fps: 15, fpsSrc: 30, role: 'focus' }), 0.5)
  assert.equal(smoothness({ fps: 20, fpsSrc: 20, stalled: true }), 0)
  assert.equal(smoothness({ fps: 0, fpsSrc: 20 }), 0)
  // uneven delivery costs up to 0.3
  assert.ok(near(smoothness({ fps: 20, fpsSrc: 20, jitterMs: 80, role: 'focus' }), 0.7))
  assert.ok(near(smoothness({ fps: 20, fpsSrc: 20, jitterMs: 500, role: 'focus' }), 0.7))
})

test('the timed parts fall with the wait and never leave 0..1', () => {
  assert.equal(startupScore(0), 1)
  assert.ok(near(startupScore(800), Math.exp(-1)))
  assert.ok(near(switchScore(1200), Math.exp(-1)))
  assert.ok(near(scrubScore(300), Math.exp(-1)))
  assert.ok(startupScore(60_000) < 1e-9)
  assert.equal(startupScore(-5), 0)
  assert.equal(stability({ reconnects: 0, minutes: 10 }), 1)
  assert.equal(stability({ reconnects: 5, minutes: 10 }), 0.5)
  assert.equal(stability({ reconnects: 50, minutes: 10 }), 0)
  assert.equal(stability({ reconnects: 1, minutes: 0 }), null)
})

test('a session is scored only on what happened in it', () => {
  assert.deepEqual(score({}), { score: null, from: [], parts: {} })
  // live only, everything perfect: 1, not 0.85 for want of a seek
  const live = score({ smoothness: 1, startup: 1, switching: 1, stability: 1 })
  assert.ok(near(live.score, 1))
  assert.deepEqual(live.from, ['smoothness', 'startup', 'switching', 'stability'])
  // the weights keep their proportions among the parts present
  const two = score({ smoothness: 1, startup: 0 })
  assert.ok(near(two.score, 0.35 / 0.6))
  assert.equal(score({ smoothness: null, startup: 0.5 }).score, 0.5)
  assert.equal(score({ smoothness: 7 }).score, 1) // (clamped)
})

test('attention: the one camera open counts for more than a grid tile of its size; a hidden one for nothing', () => {
  assert.ok(attention({ w: 640, h: 360, role: 'focus' }) > attention({ w: 640, h: 360, role: 'grid' }))
  assert.ok(attention({ w: 1280, h: 720 }) > attention({ w: 640, h: 360 }))
  assert.equal(attention({ w: 640, h: 360, visible: false }), 0)
  assert.equal(attention({ w: 0, h: 0 }), 0)
})

const tile = (o = {}) => ({ nvr: 'nvr1', ch: 2, stream: 1, role: 'grid', playing: true, fps: 20, jitterMs: 4, bufMs: 350, dropped: 0, late: 0, resync: 0, decQueue: 1, kbps: 600, w: 640, h: 360, attempts: 0, ...o })

test('the collector times a first picture and full quality, and scores nothing before it', () => {
  let t = 1_000_000
  const sent = []
  const c = createCollector({ now: () => t, send: (b) => sent.push(b), device: 'dev1', page: 'live' })
  c.watch([tile({ playing: false, fps: 0 })])
  c.sample([tile({ playing: false, fps: 0 })])
  assert.deepEqual(c.pending(), { samples: 0, events: 0 }, 'a tile still starting is not a frozen one')
  t += 640
  c.watch([tile()])
  c.sample([tile()])
  assert.deepEqual(c.pending(), { samples: 1, events: 1 })
  // the one camera open, on its main stream: that wait is the one to full quality
  c.watch([tile(), tile({ stream: 0, role: 'focus', playing: false })])
  t += 900
  c.watch([tile(), tile({ stream: 0, role: 'focus' })])
  c.watch([tile({ attempts: 1 }), tile({ stream: 0, role: 'focus' })])
  assert.equal(c.flush(), true)
  assert.equal(c.flush(), false, 'nothing gathered, nothing sent')
  const [b] = sent
  assert.deepEqual({ v: b.v, device: b.device, page: b.page }, { v: 1, device: 'dev1', page: 'live' })
  assert.deepEqual(b.events.map((e) => [e.kind, e.ms ?? null]), [['first-picture', 640], ['hd', 900], ['reconnect', null]])
  assert.equal(b.samples[0].fps, 20)
  assert.equal(b.samples[0].fpsSrc, 20)
})

test('the collector forgets a tile that has gone, and never grows without end', () => {
  let t = 5_000_000
  const c = createCollector({ now: () => t, send: () => {}, device: 'd', page: 'live' })
  c.watch([tile()])
  c.watch([]) // closed
  t += 5000
  c.watch([tile({ playing: false })])
  t += 300
  c.watch([tile()])
  for (let i = 0; i < MAX_SAMPLES + 50; i++) c.sample([tile()])
  assert.equal(c.pending().samples, MAX_SAMPLES)
  assert.equal(c.pending().events, 2, 'opened again: timed again, from when it came back')
})

const req = (method, body, headers = {}) => {
  const r = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)])
  r.method = method
  r.headers = { host: 'cctv.local', origin: 'https://cctv.local', 'content-type': 'application/json', ...headers }
  return r
}
const batch = (o = {}) => ({ v: 1, device: 'abc123abc123', page: 'live', samples: [], events: [], ...o })
const sample = (o = {}) => ({ t: Date.now(), nvr: 'nvr1', ch: 0, stream: 1, role: 'grid', fps: 20, fpsSrc: 20, jitterMs: 0, bufMs: 350, dropped: 0, late: 0, resync: 0, decQueue: 0, kbps: 500, w: 640, h: 360, stalled: false, visible: true, ...o })

test('a batch from a page is made safe: bad cameras dropped, numbers clamped, the clock not believed', () => {
  assert.equal(cleanBatch(null), null)
  assert.equal(cleanBatch({ v: 2, samples: [], events: [] }), null)
  assert.equal(cleanBatch({ v: 1, samples: 'x', events: [] }), null)
  const now = 2_000_000_000_000
  const b = cleanBatch(batch({
    device: '../../etc', page: 'elsewhere',
    samples: [sample({ t: 5, fps: 9999, w: -4 }), sample({ nvr: '../x' }), sample({ ch: 9999 }), sample({ nvr: 'ok', fps: 'fast' })],
    events: [{ t: now, kind: 'first-picture', nvr: 'nvr1', ch: 1, ms: 1e12 }, { t: now, kind: 'rm -rf' }, { t: now, kind: 'step', dir: 7 }]
  }), now)
  assert.equal(b.device, 'unknown')
  assert.equal(b.page, 'live')
  assert.equal(b.samples.length, 2)
  assert.deepEqual([b.samples[0].t, b.samples[0].fps, b.samples[0].w], [now, 120, 0])
  assert.equal(b.samples[1].fps, 0)
  assert.deepEqual(b.events, [{ t: now, kind: 'first-picture', nvr: 'nvr1', ch: 1, ms: 600_000 }, { t: now, kind: 'step' }])
})

test('the cohort is fixed for a user on a browser, and about one in ten is the holdout', () => {
  assert.equal(cohortOf('mike', 'dev1'), cohortOf('mike', 'dev1'))
  let holdout = 0
  for (let i = 0; i < 2000; i++) if (cohortOf(`user${i}`, 'd') === 'holdout') holdout++
  assert.ok(holdout > 140 && holdout < 260, `holdout ${holdout} of 2000`)
})

test('the routes: who may, what is taken, what is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'argus-tel-routes-'))
  const store = makeTelemetry({ dir })
  const me = { user: 'ann', admin: false }
  assert.equal(await handleTelemetry(req('GET'), '/api/other', me, store), null)
  assert.equal((await handleTelemetry(req('POST', batch()), TELEMETRY_PATH, null, store))[0], 401)
  assert.equal((await handleTelemetry(req('GET'), TELEMETRY_PATH, me, store))[0], 405)
  assert.equal((await handleTelemetry(req('POST', batch(), { 'content-type': 'text/plain' }), TELEMETRY_PATH, me, store))[0], 415)
  assert.equal((await handleTelemetry(req('POST', batch(), { origin: 'https://evil.example' }), TELEMETRY_PATH, me, store))[0], 403)
  assert.equal((await handleTelemetry(req('POST', batch(), { origin: 'not an address' }), TELEMETRY_PATH, me, store))[0], 403)
  assert.equal((await handleTelemetry(req('POST', '{not json'), TELEMETRY_PATH, me, store))[0], 400)
  assert.equal((await handleTelemetry(req('POST', 'x'.repeat(200_000)), TELEMETRY_PATH, me, store))[0], 400)
  const ok = await handleTelemetry(req('POST', batch({ samples: [sample()] })), TELEMETRY_PATH, me, store)
  assert.equal(ok[0], 200)
  assert.equal(ok[1].cohort, cohortOf('ann', 'abc123abc123'))
  assert.equal((await handleTelemetry(req('GET'), TELEMETRY_ADMIN_PATH, me, store))[0], 403)
  assert.equal((await handleTelemetry(req('POST'), TELEMETRY_ADMIN_PATH, { user: 'boss', admin: true }, store))[0], 405)
  // on disk: one line, with the session's user, whatever the page said
  const [file] = readdirSync(dir)
  const line = JSON.parse(readFileSync(join(dir, file), 'utf8').trim())
  assert.deepEqual([line.user, line.device, line.samples.length], ['ann', 'abc123abc123', 1])
})

test('the summary scores each cohort from what it was sent', async () => {
  const store = makeTelemetry({ dir: mkdtempSync(join(tmpdir(), 'argus-tel-sum-')) })
  // find a user in each cohort
  const inCohort = (c) => { for (let i = 0; ; i++) if (cohortOf(`u${i}`, 'abc123abc123') === c) return `u${i}` }
  const a = inCohort('apsi'), h = inCohort('holdout')
  // apsi: perfect tiles, a quick first picture
  store.add(a, cleanBatch(batch({ samples: Array.from({ length: 60 }, () => sample()), events: [{ t: Date.now(), kind: 'first-picture', nvr: 'nvr1', ch: 0, ms: 0 }] })))
  // holdout: half the frames a grid tile is owed (15), a slow first picture, a reconnect
  store.add(h, cleanBatch(batch({ samples: Array.from({ length: 60 }, () => sample({ fps: 7.5 })), events: [{ t: Date.now(), kind: 'first-picture', nvr: 'nvr1', ch: 0, ms: 800 }, { t: Date.now(), kind: 'reconnect', nvr: 'nvr1', ch: 0 }] })))
  const s = store.summary().cohorts
  assert.ok(near(s.apsi.parts.smoothness, 1) && near(s.apsi.parts.startup, 1) && near(s.apsi.parts.stability, 1))
  assert.ok(near(s.apsi.score, 1))
  assert.deepEqual(s.apsi.from, ['smoothness', 'startup', 'stability'], 'no seek and no step: those parts are not counted')
  assert.ok(near(s.holdout.parts.smoothness, 0.5) && near(s.holdout.parts.startup, Math.exp(-1)) && near(s.holdout.parts.stability, 0))
  assert.ok(s.holdout.score < s.apsi.score)
  assert.deepEqual([s.apsi.sessions, s.apsi.tileSeconds, s.apsi.opens], [1, 60, 1])
})

test('the store stays inside its size and its days, and a full one drops the batch, not the server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'argus-tel-cap-'))
  let t = Date.parse('2026-10-20T12:00:00Z')
  writeFileSync(join(dir, '2026-09-01.jsonl'), 'x'.repeat(500)) // long past its days
  writeFileSync(join(dir, '2026-10-18.jsonl'), 'x'.repeat(500))
  const store = makeTelemetry({ dir, now: () => t, maxBytes: 1500, keepDays: 14 })
  store.add('u', cleanBatch(batch(), t))
  assert.deepEqual(readdirSync(dir).sort(), ['2026-10-18.jsonl', '2026-10-20.jsonl'], 'the old day went')
  for (let i = 0; i < 40; i++) store.add('u', cleanBatch(batch(), t))
  assert.ok(store.counts.notWritten > 0, 'past the size: counted, not written')
  assert.ok(store.counts.bytes <= 1500)
  t += 11 * 60_000 // the next look at the folder drops the oldest day to make room
  store.add('u', cleanBatch(batch(), t))
  assert.deepEqual(readdirSync(dir), ['2026-10-20.jsonl'])
  // and a folder that cannot be written is a count, never an error
  const broken = makeTelemetry({ dir: join(dir, '2026-10-20.jsonl', 'nope'), now: () => t })
  assert.doesNotThrow(() => broken.add('u', cleanBatch(batch(), t)))
  assert.equal(broken.counts.notWritten, 1)
})

test('the Health card: two rows, the parts not seen said so, an empty period said so', async () => {
  const { experienceView } = await import('../public/experience-view.js')
  assert.equal(experienceView(null).note, 'Nothing measured yet in this period.')
  const v = experienceView({ hours: 24, kept: { notWritten: 2 }, cohorts: { apsi: { score: 0.681, from: ['smoothness', 'startup'], parts: { smoothness: 0.56, startup: 0.85 }, sessions: 3, tileSeconds: 600, batches: 9 }, holdout: { score: null, from: [], parts: {}, sessions: 0, tileSeconds: 0, batches: 0 } } })
  assert.equal(v.heads.length, 10)
  assert.deepEqual(v.rows[0], ['Optimised', '68', '56', '85', '–', '–', '–', '–', '3', '10 tile-min'])
  assert.deepEqual(v.rows[1].slice(1, 3), ['–', '–'])
  assert.match(v.note, /not seen yet: scrubbing, switching, stability, efficiency/)
  assert.match(v.note, /2 batches were not kept/)
})

test('a restart does not empty the score: what was kept is read back, old and broken lines passed over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'argus-tel-reload-'))
  let t = Date.parse('2026-10-20T12:00:00Z')
  const first = makeTelemetry({ dir, now: () => t })
  first.add('u', cleanBatch(batch({ samples: Array.from({ length: 30 }, () => sample({ t })), events: [{ t, kind: 'first-picture', nvr: 'nvr1', ch: 0, ms: 0 }] }), t))
  const file = join(dir, '2026-10-20.jsonl')
  const old = JSON.stringify({ at: t - 30 * 86_400_000, user: 'old', cohort: 'apsi', samples: [sample()], events: [] })
  writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n${old}\n`)
  t += 60_000
  const again = makeTelemetry({ dir, now: () => t })
  const c = again.summary().cohorts[cohortOf('u', 'abc123abc123')]
  assert.deepEqual([c.tileSeconds, c.opens, again.counts.reloaded], [30, 1, 1])
  assert.ok(near(c.score, 1))
})

test('a decoder that had to be set up again is reported once each time', () => {
  const sent = []
  const c = createCollector({ now: () => 9_000_000, send: (b) => sent.push(b), device: 'd', page: 'live' })
  c.watch([tile({ decoderErrors: 2 })]) // (already there when the tile was first seen: not news)
  c.watch([tile({ decoderErrors: 3 })])
  c.watch([tile({ decoderErrors: 3 })])
  c.flush()
  assert.deepEqual(sent[0].events.map((e) => e.kind), ['first-picture', 'decoder-reset'])
})

test('by NVR: the slowest to a first picture comes first, with its frozen share', async () => {
  const t = Date.parse('2026-10-20T12:00:00Z')
  const store = makeTelemetry({ dir: mkdtempSync(join(tmpdir(), 'argus-tel-nvr-')), now: () => t })
  const first = (nvr, ms) => ({ t, kind: 'first-picture', nvr, ch: 0, ms })
  store.add('u', cleanBatch(batch({
    samples: [sample({ t, nvr: 'slow' }), sample({ t, nvr: 'slow', stalled: true, fps: 0 }), sample({ t, nvr: 'quick' })],
    events: [first('quick', 400), first('slow', 2000), first('slow', 6000), first('slow', 4000), { t, kind: 'hd', nvr: 'slow', ch: 0, ms: 3000 }]
  }), t))
  const { nvrs } = store.summary()
  assert.deepEqual(nvrs.map((n) => n.nvr), ['slow', 'quick'])
  assert.deepEqual([nvrs[0].opens, nvrs[0].firstMs, nvrs[0].firstMs90, nvrs[0].hdMs, nvrs[0].tileSeconds], [3, 4000, 6000, 3000, 2])
  assert.ok(near(nvrs[0].frozenShare, 0.5))
  const { nvrView } = await import('../public/experience-view.js')
  assert.deepEqual(nvrView({ nvrs }).nvrRows[1].slice(0, 5), ['quick', '1', '0.4 s', '0.4 s', '–'])
})

test('a page of many tiles is sampled less often, so its batch stays under what the server reads', () => {
  const sent = []
  const c = createCollector({ now: () => 5_000_000, send: (b) => sent.push(b), device: 'd', page: 'live' })
  const wall = Array.from({ length: 100 }, (_, i) => tile({ ch: i, arrived: 25, decoded: 25, gapMs: 180, rafHz: 60, rafGapMs: 17 }))
  c.watch(wall)
  for (let i = 0; i < 10; i++) c.sample(wall) // ten seconds of a 10 x 10
  c.flush()
  assert.equal(sent[0].samples.length, 200)
  assert.ok(JSON.stringify(sent[0]).length < BODY_LIMIT, `${JSON.stringify(sent[0]).length} bytes`)
  assert.deepEqual([sent[0].samples[0].in, sent[0].samples[0].rafHz], [25, 60])
})
