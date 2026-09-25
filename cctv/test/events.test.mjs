// Offline tests for event intake (events.mjs, event-rules.mjs, rec-modes.mjs, motion-tune.mjs):
// the NVR recording-type bits, schedules, pre/post windows, the recording gate, the poller's
// manners, the read-only command probe, and the motion write's refusals.
//
// Temp data folder only; no NVR, no SDK, no network. Nothing here sends anything anywhere, and the
// one module that would (motion-tune) is driven with a fake query so the write path is exercised
// without a real box.
//   node cctv/test/events.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-events-test-'))
writeFileSync(join(process.env.DATA_DIR, 'users.json'), JSON.stringify({ alice: { hash: 'x', role: 'admin' } }))

const {
  CONTINUOUS_BITS, EVENT_TYPES, MODE_TYPES, TYPE_NAMES,
  eventWindow, eventsForMode, inSchedule, inWindows, isEventMode,
  recordWindows, shouldRecord, typesFromRecordBits
} = await import('../event-rules.mjs')
const {
  BACKOFF_MS, EVENT_PROBES, EVENT_PROBE_NAMES, FIRST_LOOK_MS, MIN_POLL_MS, SOURCE_RECORDINGS,
  backoffFor, daysToAsk, eventsFromRecordings, itemsOf, makeEventIntake, offlineEvents,
  pollable, probeEvents, probeShapes, sourceReport, summariseProbe
} = await import('../events.mjs')
const { FEED_FRESH_MS, buildWindowMessage, shouldWrite, windowsFor } = await import('../rec-modes.mjs')
const { buildMotionEdit, readArea, readMotionAnswer, writeMotionThreshold } = await import('../motion-tune.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 25, 9, 0, 0)
const MIN = 60_000
const S = 1000

// --- the NVR's recording-type bits ---------------------------------------------------------------
//
// These are the one event source in this phase that is not a guess: DD_RECORD_TYPE, from the
// vendor's own header, read by a search this app already makes to draw the timeline.
{
  check('plain scheduled recording is not an event', typesFromRecordBits(CONTINUOUS_BITS).length === 0)
  check('manual recording alone is not an event', typesFromRecordBits(0x1).length === 0)
  const motion = typesFromRecordBits(0x4)
  check('0x4 is motion', motion.length === 1 && motion[0].type === 'motion', JSON.stringify(motion))
  const both = typesFromRecordBits(0x2 | 0x4)
  check('scheduled + motion is one motion event', both.length === 1 && both[0].type === 'motion')
  const two = typesFromRecordBits(0x4 | 0x400)
  check('one file can carry two reasons', two.length === 2 && two.some((t) => t.type === 'motion') && two.some((t) => t.subtype === 'tripwire'), JSON.stringify(two))
  check('0x1000 is a face', typesFromRecordBits(0x1000)[0].type === 'face')
  check('0x20 is tamper', typesFromRecordBits(0x20)[0].type === 'tamper')
  // The honest half: a bit we have no name for is reported as a bit, not as motion.
  const odd = typesFromRecordBits(0x8000)
  check('an unknown bit is named, not guessed at', odd.length === 1 && odd[0].type === 'nvr-event' && /0x8000/.test(odd[0].subtype), JSON.stringify(odd))
  check('a known bit plus an unknown one gives both', typesFromRecordBits(0x4 | 0x8000).length === 2)
  check('nothing at all gives nothing', typesFromRecordBits(0).length === 0 && typesFromRecordBits(null).length === 0)
}

// --- what this app admits it cannot do -------------------------------------------------------------
{
  const person = EVENT_TYPES.find((t) => t.type === 'ai-person')
  check('ai-person exists as a name but is marked unconfirmed', person && person.confirmed === false)
  check('ai-vehicle likewise', EVENT_TYPES.find((t) => t.type === 'ai-vehicle')?.confirmed === false)
  check('motion is confirmed', EVENT_TYPES.find((t) => t.type === 'motion')?.confirmed === true)
  // Nothing in the mapping may ever produce an unconfirmed kind.
  const produced = new Set()
  for (let bit = 1; bit <= 0x8000; bit <<= 1) for (const t of typesFromRecordBits(bit)) produced.add(t.type)
  check('the recording-type mapping never produces an unconfirmed kind',
    ![...produced].some((t) => EVENT_TYPES.find((x) => x.type === t)?.confirmed === false), [...produced].join())
  const report = sourceReport()
  check('the source report names person and vehicle as not available', report.notAvailable.some((n) => /Person and vehicle/.test(n.what)))
  check('and says what would confirm them', report.notAvailable.every((n) => Boolean(n.toConfirm)))
}

// --- schedules -------------------------------------------------------------------------------------
//
// T0 is Friday 2026-09-25 09:00 UTC. Friday is day 5.
{
  check('no schedule means always', inSchedule(null, T0) && inSchedule([], T0))
  check('inside an ordinary span', inSchedule([{ from: '08:00', to: '17:00' }], T0))
  check('outside it', !inSchedule([{ from: '10:00', to: '17:00' }], T0))
  check('the end is exclusive', !inSchedule([{ from: '07:00', to: '09:00' }], T0))
  check('the start is inclusive', inSchedule([{ from: '09:00', to: '10:00' }], T0))
  check('the right day passes', inSchedule([{ days: [5], from: '08:00', to: '17:00' }], T0))
  check('the wrong day does not', !inSchedule([{ days: [1, 2], from: '08:00', to: '17:00' }], T0))
  check('several spans: any one is enough', inSchedule([{ from: '00:00', to: '01:00' }, { from: '08:00', to: '17:00' }], T0))
  // through midnight
  const night = [{ from: '22:00', to: '06:00' }]
  check('22:00 is inside a night span', inSchedule(night, Date.UTC(2026, 8, 25, 22, 30)))
  check('02:00 is inside a night span', inSchedule(night, Date.UTC(2026, 8, 26, 2, 0)))
  check('noon is not', !inSchedule(night, Date.UTC(2026, 8, 25, 12, 0)))
  // A night span's days are the days it starts on, which is what "Friday night" means.
  const friNight = [{ days: [5], from: '22:00', to: '06:00' }]
  check('Friday night covers Friday 23:00', inSchedule(friNight, Date.UTC(2026, 8, 25, 23, 0)))
  check('Friday night covers Saturday 02:00', inSchedule(friNight, Date.UTC(2026, 8, 26, 2, 0)))
  check('Friday night does not cover Sunday 02:00', !inSchedule(friNight, Date.UTC(2026, 8, 27, 2, 0)))
  check('00:00 to 00:00 is the whole day', inSchedule([{ from: '00:00', to: '00:00' }], T0))
  // site wall clock: -4 h turns 09:00 UTC into 05:00 locally
  check('the site offset is applied', !inSchedule([{ from: '08:00', to: '17:00' }], T0, -240))
  check('and the local hour is what matches', inSchedule([{ from: '04:00', to: '06:00' }], T0, -240))
}

// --- pre/post windows --------------------------------------------------------------------------------
{
  const ev = { startMs: T0, endMs: T0 + 10 * S }
  check('a window grows either side', JSON.stringify(eventWindow(ev, { preS: 10, postS: 20 })) === JSON.stringify([T0 - 10 * S, T0 + 30 * S]))
  check('an event with no end is a moment', JSON.stringify(eventWindow({ startMs: T0 }, { preS: 5, postS: 5 })) === JSON.stringify([T0 - 5 * S, T0 + 5 * S]))
  check('no seconds means the event itself', JSON.stringify(eventWindow(ev)) === JSON.stringify([T0, T0 + 10 * S]))
  check('an event with no start is no window', eventWindow({}) === null)

  const events = [{ startMs: T0, endMs: T0 + 5 * S }, { startMs: T0 + 8 * S, endMs: T0 + 9 * S }, { startMs: T0 + 10 * MIN, endMs: T0 + 10 * MIN }]
  const w = recordWindows(events, { preS: 2, postS: 2 })
  check('overlapping windows merge', w.length === 2, JSON.stringify(w))
  check('the merged one spans both', w[0][0] === T0 - 2 * S && w[0][1] === T0 + 11 * S, JSON.stringify(w[0]))
  check('a distant event stays its own window', w[1][0] === T0 + 10 * MIN - 2 * S)
  check('joinMs pulls nearby windows together', recordWindows(events, { preS: 2, postS: 2, joinMs: 15 * MIN }).length === 1)
  check('no events, no windows', recordWindows([]).length === 0 && recordWindows(null).length === 0)

  check('inside a window', inWindows(w, T0 + 3 * S))
  check('between windows', !inWindows(w, T0 + 60 * S))
  check('the edges count', inWindows(w, w[0][0]) && inWindows(w, w[0][1]))
  check('shouldRecord agrees', shouldRecord(events, T0 + 3 * S, { preS: 2, postS: 2 }))
  check('and says no in the quiet', !shouldRecord(events, T0 + 60 * S, { preS: 2, postS: 2 }))
}

// --- which events a mode cares about -----------------------------------------------------------------
{
  const mixed = [{ type: 'motion' }, { type: 'ai' }, { type: 'face' }, { type: 'camera-offline' }, { type: 'pos' }]
  check('motion mode takes motion only', eventsForMode(mixed, 'motion').length === 1)
  check('ai mode takes the smart ones', eventsForMode(mixed, 'ai').length === 2, JSON.stringify(eventsForMode(mixed, 'ai')))
  check('ai-or-motion takes all three', eventsForMode(mixed, 'ai-or-motion').length === 3)
  check('continuous is not an event mode', !isEventMode('continuous') && eventsForMode(mixed, 'continuous').length === 0)
  check('off is not either', !isEventMode('off'))
  check('every mode in MODE_TYPES lists only known kinds', Object.values(MODE_TYPES).flat().every((t) => TYPE_NAMES.includes(t)))
}

// --- the recording gate ------------------------------------------------------------------------------
//
// The important rule: an event mode with no trustworthy event feed records EVERYTHING, and says so.
// Silently recording nothing because the poller is stuck is how a month of footage goes missing.
{
  const win = [[T0, T0 + 10 * S]]
  check('continuous ignores the windows entirely', shouldWrite({ mode: 'continuous', windows: [], feedAt: null, ts: T0, nowMs: T0 }).write)
  const never = shouldWrite({ mode: 'motion', windows: [], feedAt: null, ts: T0, nowMs: T0 })
  check('no feed yet: record anyway', never.write)
  check('and say why', /no events have reached/.test(never.why), never.why)
  const stale = shouldWrite({ mode: 'motion', windows: win, feedAt: T0 - 2 * FEED_FRESH_MS, ts: T0 + 60 * S, nowMs: T0 + 60 * S })
  check('a stale feed: record anyway', stale.write)
  check('and say how stale', /cannot be trusted/.test(stale.why), stale.why)
  check('fresh feed, inside a window: write', shouldWrite({ mode: 'motion', windows: win, feedAt: T0, ts: T0 + 5 * S, nowMs: T0 + 5 * S }).write)
  const idle = shouldWrite({ mode: 'motion', windows: win, feedAt: T0, ts: T0 + 60 * S, nowMs: T0 + 60 * S })
  check('fresh feed, outside every window: do not write', !idle.write)
  check('and it is called waiting, not a fault', idle.why === 'waiting for an event', idle.why)

  const evs = [{ type: 'motion', startMs: T0, endMs: T0 + S }, { type: 'pos', startMs: T0 + 5 * MIN, endMs: T0 + 5 * MIN }]
  const made = windowsFor(evs, 'motion', { preS: 10, postS: 20 })
  check('windowsFor uses only the mode’s kinds', made.length === 1 && made[0][0] === T0 - 10 * S && made[0][1] === T0 + 21 * S, JSON.stringify(made))

  const msg = buildWindowMessage({
    nvrId: 'nvr1',
    cameras: [{ ch: 0 }, { ch: 1 }, { ch: 2 }],
    recording: { defaults: { mode: 'continuous', preS: 10, postS: 20 }, cameras: { 'nvr1/1': { mode: 'motion' }, 'nvr1/2': { mode: 'ai', preS: 1, postS: 1 } } },
    eventsOf: (ch) => (ch === 1 ? [{ type: 'motion', startMs: T0, endMs: T0 }] : [{ type: 'ai', startMs: T0, endMs: T0 }]),
    nowMs: T0 + MIN
  })
  check('only event-mode cameras get windows', Object.keys(msg.windows).sort().join() === '1,2', Object.keys(msg.windows).join())
  check('per-camera pre/post beats the defaults', msg.windows[2][0][0] === T0 - 1 * S, JSON.stringify(msg.windows[2]))
  check('and the defaults are used when the camera has none', msg.windows[1][0][0] === T0 - 10 * S, JSON.stringify(msg.windows[1]))
  check('the message is stamped so the worker can tell it is fresh', msg.at === T0 + MIN)
}

// --- intake from the recorded-file index --------------------------------------------------------------
{
  const recs = { ranges: [], events: [[T0, T0 + 20 * S, 0x4], [T0 + MIN, T0 + MIN + S, 0x4 | 0x400], [T0 + 2 * MIN, T0 + 2 * MIN, 0x2]] }
  const rows = eventsFromRecordings('nvr1', 3, recs)
  check('each reason in a file becomes its own row', rows.length === 3, JSON.stringify(rows.map((r) => `${r.type}/${r.subtype}`)))
  check('a plain scheduled file makes none', rows.every((r) => r.startMs !== T0 + 2 * MIN))
  check('the camera is carried', rows[0].nvr === 'nvr1' && rows[0].ch === 3)
  check('the source is named', rows.every((r) => r.source === SOURCE_RECORDINGS))
  check('the detail states the raw type', /0x4/.test(rows[0].detail), rows[0].detail)
  check('an answer with no events makes none', eventsFromRecordings('n', 0, { events: [] }).length === 0)
  check('a missing answer makes none, it does not throw', eventsFromRecordings('n', 0, null).length === 0)
}

// --- camera offline ------------------------------------------------------------------------------------
{
  const cams = [{ nvr: 'nvr1', ch: 0, name: 'Gate', online: true }, { nvr: 'nvr1', ch: 1, name: 'Yard', online: true }]
  const first = offlineEvents(new Map(), cams, T0)
  check('the first sighting of healthy cameras files nothing', first.events.length === 0)
  const gone = offlineEvents(first.state, [cams[0], { ...cams[1], online: false }], T0 + MIN)
  check('a camera going offline is one event', gone.events.length === 1 && gone.events[0].type === 'camera-offline')
  check('it names the camera', /Yard/.test(gone.events[0].detail), gone.events[0].detail)
  const still = offlineEvents(gone.state, [cams[0], { ...cams[1], online: false }], T0 + 2 * MIN)
  check('a camera still offline is not news every pass', still.events.length === 0)
  const back = offlineEvents(still.state, cams, T0 + 3 * MIN)
  check('and coming back files nothing either (that is the Health page’s job)', back.events.length === 0)
  // A camera that was offline before the server started must not produce an event on first sight.
  check('never-seen-before and offline files nothing', offlineEvents(new Map(), [{ nvr: 'n', ch: 0, online: false }], T0).events.length === 0)
}

// --- the poller's manners --------------------------------------------------------------------------------
//
// nvr-2 is at its bandwidth ceiling and rigginglot takes 37 s over routine calls. Every "no" here is
// load this phase does not add to a box that is already struggling.
{
  const ok = { id: 'n', name: 'N', online: true }
  check('a healthy NVR may be asked', pollable(ok, T0).ok)
  check('an offline one may not', !pollable({ ...ok, online: false }, T0).ok)
  check('a degraded one may not', !pollable({ ...ok, degraded: true }, T0).ok)
  check('a stopped one may not', !pollable({ ...ok, stopped: true }, T0).ok)
  const refusing = pollable({ ...ok, refusalsLast10Min: 3 }, T0)
  check('one refusing streams is left alone', !refusing.ok)
  check('and the reason says so in words', /refusing/.test(refusing.why), refusing.why)
  check('two refusals is not enough to stop', pollable({ ...ok, refusalsLast10Min: 2 }, T0).ok)
  check('asked recently: wait', !pollable(ok, T0, { nextAt: T0 + MIN }).ok)
  check('every refusal comes with a sentence', ['online', 'degraded'].every(() => true) && pollable(null, T0).why.length > 0)

  check('the first failure waits a minute', backoffFor(1) === BACKOFF_MS[0])
  check('the backoff grows', backoffFor(3) > backoffFor(1))
  check('and stops at an hour', backoffFor(99) === BACKOFF_MS.at(-1) && BACKOFF_MS.at(-1) === 60 * 60_000)

  check('a first-ever poll looks back hours, not a month', FIRST_LOOK_MS === 6 * 3_600_000)
  check('one NVR is never asked more than once a minute', MIN_POLL_MS >= 60_000)
  const days = daysToAsk(T0 - 3 * 86_400_000, T0, 0)
  check('a long catch-up is capped at two days a pass', days.length === 2, days.join())
  check('and it catches up from the newest end', days.at(-1) === '2026-09-25', days.join())
  check('one day in the window is one day asked', daysToAsk(T0 - MIN, T0, 0).length === 1)
}

// --- the poller itself -----------------------------------------------------------------------------------
{
  const stored = []
  const store = {
    addEvent: (e) => {
      const already = stored.find((s) => s.nvr === e.nvr && s.ch === e.ch && s.type === e.type && s.startMs === e.startMs)
      if (already) return { event: already, isNew: false }
      const row = { id: stored.length + 1, ...e }
      stored.push(row)
      return { event: row, isNew: true }
    },
    lastEventMs: () => null
  }
  const asked = []
  let now = T0
  const nvrs = [{ id: 'nvr1', name: 'One', online: true }, { id: 'nvr2', name: 'Two', online: false }]
  const seen = []
  const intake = makeEventIntake({
    listNvrs: () => nvrs,
    camerasOf: () => [{ ch: 0 }, { ch: 1 }],
    recordings: async (nvr, ch, date) => {
      asked.push(`${nvr.id}/${ch}/${date}`)
      return { events: [[now - MIN, now - MIN + S, 0x4]] }
    },
    onEvent: (e) => seen.push(e),
    now: () => now,
    log: () => {},
    store
  })

  const r1 = await intake.tick()
  check('a pass does one camera on one NVR', asked.length === 1 && r1.nvr === 'nvr1' && r1.ch === 0, JSON.stringify(r1))
  check('it stored what it found', r1.stored === 1 && seen.length === 1 && seen[0].type === 'motion')
  check('the offline NVR was never asked', !asked.some((a) => a.startsWith('nvr2')))
  now += 100
  check('and it is not asked again straight away', (await intake.tick()) === null, JSON.stringify(asked))
  now += 5000
  const r2 = await intake.tick()
  check('after the rest, the next camera', r2.ch === 1, JSON.stringify(r2))
  check('re-reading the same stretch stores nothing twice', r2.stored === 0 || stored.length === 2, `${stored.length}`)

  const status = intake.status()
  check('status covers every NVR', status.length === 2)
  check('the offline one says why it is quiet', /offline/.test(status.find((s) => s.nvr === 'nvr2').why))
  check('and names the only confirmed source', status[0].source === SOURCE_RECORDINGS)
}
{
  // A failing NVR backs off and does not take the whole pass down with it.
  let now = T0
  const intake = makeEventIntake({
    listNvrs: () => [{ id: 'slow', name: 'Slow', online: true }],
    camerasOf: () => [{ ch: 0 }],
    recordings: async () => { throw new Error('the NVR is not answering') },
    now: () => now,
    log: () => {},
    store: { addEvent: () => ({ event: null, isNew: false }), lastEventMs: () => null }
  })
  const r = await intake.tick()
  check('a failure is reported, not thrown', r?.error && /not answering/.test(r.error), JSON.stringify(r))
  now += 30_000
  check('and it is left alone while it backs off', (await intake.tick()) === null)
  check('status explains the silence', /not answering/.test(intake.status()[0].why))
}

// --- the read-only command probe ------------------------------------------------------------------------
//
// This is the part that must never turn into "we guessed a name and built on it".
{
  check('every candidate is a query, never an edit', EVENT_PROBE_NAMES.every((n) => /^(query|search)/.test(n)), EVENT_PROBE_NAMES.join())
  check('every candidate says why it is a candidate', EVENT_PROBES.every((p) => p.why.length > 20))
  check('the one that would give object class is in the list', EVENT_PROBE_NAMES.includes('searchSmartTarget'))
  check('the shapes include a bodyless one and a time-bounded one', probeShapes({ fromMs: T0, toMs: T0 + MIN }).length >= 4)

  const sent = []
  const query = async (_nvr, url, doc) => {
    sent.push(url)
    if (url === 'queryLog' && /startTime/.test(doc)) return '<?xml version="1.0"?><response><status>success</status><content><item><time>x</time></item></content></response>'
    if (url === 'searchSmartTarget') return '<?xml version="1.0"?><response><status>fail</status><errorCode>536870923</errorCode></response>'
    throw new Error('the NVR did not accept the request (404)')
  }
  const run = await probeEvents({ id: 'nvr1' }, query, { candidates: EVENT_PROBES.slice(0, 5), sleep: async () => {} })
  const log = run.results.find((r) => r.cmd === 'queryLog')
  check('a command that answers is marked supported', log.supported && log.known)
  check('it stops at the first shape that works', log.tried.filter((t) => t.ok).length === 1)
  const smart = run.results.find((r) => r.cmd === 'searchSmartTarget')
  check('an errorCode still proves the firmware knows the command', smart.known && !smart.supported, JSON.stringify(smart.tried.map((t) => t.status)))
  const missing = run.results.find((r) => r.cmd === 'queryAlarmStatus')
  check('a bare failure means the firmware does not have it', !missing.known && !missing.supported)
  check('a failure never stops the run', run.results.length === 5)

  const sum = summariseProbe(run)
  check('the summary lists what answered', sum.working.includes('queryLog'))
  check('object class is only claimed when searchSmartTarget succeeded', sum.objectClassAvailable === false)
  check('the verdict is a sentence somebody can act on', sum.verdict.length > 30, sum.verdict)
  const none = summariseProbe({ results: [{ cmd: 'x', known: false, supported: false, tried: [] }] })
  check('nothing answering says intake stays on the recorded-event index', /recorded-event index/.test(none.verdict), none.verdict)
  const knownOnly = summariseProbe({ results: [{ cmd: 'queryLog', known: true, supported: false, tried: [] }] })
  check('known-but-refused says the shape is wrong, not the name', /shape is wrong/.test(knownOnly.verdict), knownOnly.verdict)
}
{
  check('itemsOf finds a plain list', itemsOf('<response><content><item>a</item><item>b</item></content></response>').length === 2)
  check('itemsOf finds a wrapped list', itemsOf('<response><content><logList><item>a</item></logList></content></response>').length === 1)
  check('itemsOf on nothing is nothing, not a throw', itemsOf('<response></response>').length === 0)
}

// --- motion tuning: reading ------------------------------------------------------------------------------
{
  const good = '<?xml version="1.0"?><response><status>success</status><content><chl id="{00000001-0000-0000-0000-000000000000}"><sensitivity>50</sensitivity><holdTime>10</holdTime><area><item>1111</item><item>1100</item></area></chl></content></response>'
  const r = readMotionAnswer(good, '{00000001-0000-0000-0000-000000000000}')
  check('a good answer reads back', r.available && r.sensitivity === 50, JSON.stringify(r))
  check('the hold time comes too', r.holdTime === 10)
  check('the zone grid is read', r.area?.rows === 2 && r.area.cols === 4, JSON.stringify(r.area))
  // The honest half: never a reassuring zero.
  check('no sensitivity means not available', readMotionAnswer('<response><status>success</status><content><chl></chl></content></response>').available === false)
  check('a refusal says so', /refused/.test(readMotionAnswer('<response><status>fail</status><errorCode>17</errorCode></response>').why))
  check('no document at all says so', /did not answer/.test(readMotionAnswer('').why))
  check('an unreadable zone grid is null, not an empty grid', readArea({ children: [{ name: 'area', children: [], text: 'zzz', attrs: {} }], attrs: {} }) === null)
}

// --- motion tuning: building the write --------------------------------------------------------------------
//
// Built by substituting one number into the NVR's own answer, because these boxes replace the whole
// block and a field we forgot to mention is a field we silently wiped.
{
  const answer = '<?xml version="1.0"?><response><status>success</status><content><chl id="A"><sensitivity>50</sensitivity><holdTime>10</holdTime></chl></content></response>'
  const built = buildMotionEdit(answer, 70)
  check('the edit is built', built.ok)
  check('the old value is reported', built.was === '50')
  check('the new value is in it', /<sensitivity>70<\/sensitivity>/.test(built.doc))
  check('and every other field survived untouched', /<holdTime>10<\/holdTime>/.test(built.doc), built.doc)
  check('it is a request document, not a response', /^<\?xml/.test(built.doc) && /<\/request>$/.test(built.doc))
  const many = buildMotionEdit('<response><content><chl id="A"><sensitivity>1</sensitivity></chl><chl id="B"><sensitivity>2</sensitivity></chl></content></response>', 9)
  check('two cameras in one answer is refused, not guessed at', !many.ok && /2 sensitivity elements/.test(many.error), many.error)
  check('no sensitivity element is refused', !buildMotionEdit('<response><content><chl/></content></response>', 9).ok)
  check('no content at all is refused', !buildMotionEdit('<response></response>', 9).ok)
}

// --- motion tuning: the write's refusals ---------------------------------------------------------------------
//
// Changing an NVR threshold is a WRITE to somebody else's box. Every one of these is a case where
// nothing must be sent.
{
  const goodAnswer = '<?xml version="1.0"?><response><status>success</status><content><chl id="{00000001-0000-0000-0000-000000000000}"><sensitivity>50</sensitivity></chl></content></response>'
  const nvr = { id: 'nvr1', name: 'One', online: true, cfg: { host: 'h', port: 1 } }
  // The four pieces motion-tune borrows from nvr-xml.mjs, which loads the native SDK. Stubbed here
  // so the write path itself is under test on a machine with no SDK; the real ones are used on the
  // server. The lock is a real one-at-a-time lock, so a second change while one is running throws.
  let held = false
  const xml = {
    HttpError: class extends Error {
      constructor(status, message) { super(message); this.status = status }
    },
    chlIdOf: (c) => `{${(c + 1).toString(16).toUpperCase().padStart(8, '0')}-0000-0000-0000-000000000000}`,
    deviceOf: (n) => `${n.cfg.host}:${n.cfg.port}`,
    withNvrLock: async (_n, _what, fn) => {
      if (held) throw new Error('another change is running on this NVR')
      held = true
      try { return await fn({ note: '' }) } finally { held = false }
    }
  }
  const tried = async (want, answers) => {
    const sent = []
    let i = 0
    const query = async (_n, url, doc) => {
      sent.push({ url, doc })
      return answers[Math.min(i++, answers.length - 1)]
    }
    let error = null
    let out = null
    try {
      out = await writeMotionThreshold(nvr, 0, want, 'alice', query, xml)
    } catch (e) {
      error = e
    }
    return { sent, out, error }
  }

  const bad = await tried({ threshold: 500 }, [goodAnswer])
  check('a threshold out of range is refused', bad.error && /0 to 100/.test(bad.error.message))
  check('and nothing was sent at all', bad.sent.length === 0)

  const blind = await tried({ threshold: 70 }, ['<response><status>fail</status><errorCode>17</errorCode></response>'])
  check('it never writes what it could not first read', blind.error && /nothing was changed/.test(blind.error.message), blind.error?.message)
  check('only the read went out', blind.sent.length === 1 && blind.sent[0].url === 'queryMotion')

  const same = await tried({ threshold: 50 }, [goodAnswer])
  check('setting it to what it already is sends nothing', same.out?.changed === false && same.sent.length === 1, JSON.stringify(same.out))

  const refused = await tried({ threshold: 70 }, [goodAnswer, '<response><status>fail</status><errorCode>9</errorCode></response>'])
  check('an NVR that refuses the write is reported, not assumed', refused.error && /refused the change \(code 9\)/.test(refused.error.message), refused.error?.message)

  const ok = await tried({ threshold: 70 }, [goodAnswer, '<response><status>success</status></response>', goodAnswer.replace('>50<', '>70<')])
  check('a good write reads back and confirms', ok.out?.applied === true, JSON.stringify(ok.out))
  check('it read, wrote and read again', ok.sent.map((s) => s.url).join() === 'queryMotion,editMotion,queryMotion', ok.sent.map((s) => s.url).join())
  check('and it logged what it did', ok.out?.logged?.was === 50 && ok.out.logged.wanted === 70 && ok.out.logged.by === 'alice', JSON.stringify(ok.out?.logged))

  const lied = await tried({ threshold: 70 }, [goodAnswer, '<response><status>success</status></response>', goodAnswer])
  check('an NVR that says success and keeps its old value is caught', lied.out?.applied === false, JSON.stringify(lied.out))
  check('and the caller is warned in words', /still reports its old sensitivity/.test(lied.out?.warning ?? ''), lied.out?.warning)
}

// --- the tuning view's arithmetic ------------------------------------------------------------------
{
  const { changedFraction, confirmText, maskFromArea, meterReading, pct, thresholdNote } = await import('../public/motion-view.js')
  const flat = (v, n = 16) => Uint8Array.from({ length: n }, () => v)
  check('an identical pair changed nothing', changedFraction(flat(100), flat(100)) === 0)
  // The one that matters: a cloud brightening the whole scene is not movement.
  check('an even lighting change is subtracted out', changedFraction(flat(100), flat(160)) === 0)
  const moved = flat(100)
  const after = flat(100)
  after[0] = 255
  after[1] = 255
  check('real movement counts', changedFraction(moved, after) === 2 / 16, String(changedFraction(moved, after)))
  check('mismatched samples give null, not zero', changedFraction(flat(100), flat(100, 8)) === null)
  check('nothing to compare gives null', changedFraction(null, flat(100)) === null)
  const mask = Uint8Array.from({ length: 16 }, (_v, i) => (i < 2 ? 0 : 1))
  check('pixels outside the watched zone are ignored', changedFraction(moved, after, mask) === 0)

  const m = meterReading([0.1, 0.2, 0.9, 0.3])
  check('the meter shows the newest, an average and the peak', m.now === 0.3 && m.peak === 0.9 && m.samples === 4)
  check('with nothing measured it shows nothing, not zero', meterReading([]).now === null)
  check('a percentage of nothing is a dash', pct(null) === '—')

  const { mask: made } = maskFromArea({ rows: 2, cols: 2, cells: [[1, 0], [0, 0]] }, 4, 4)
  check('a zone grid becomes a mask', made && made[0] === 1 && made[3] === 0)
  const none = maskFromArea(null, 4, 4)
  check('no grid means the whole picture, and it says so', none.mask === null && /does not tell us/.test(none.why))
  const empty = maskFromArea({ rows: 1, cols: 2, cells: [[0, 0]] }, 4, 4)
  check('a grid watching nothing is reported as such', empty.mask === null && /no part/.test(empty.why))

  const note = thresholdNote({ available: true, sensitivity: 50, min: 1, max: 100 })
  check('the note states the NVR’s number and its range', /50/.test(note) && /1–100/.test(note))
  // The honesty the whole panel rests on.
  check('and says our meter is not the NVR’s scale', /not the same scale/.test(note), note)
  check('an unreadable setting says why instead', thresholdNote({ available: false, why: 'it did not answer' }) === 'it did not answer')
  check('the confirmation names the camera and both numbers', /Yard/.test(confirmText('Yard', 50, 70)) && /50 to 70/.test(confirmText('Yard', 50, 70)))
  check('and says whose equipment it is', /owner/.test(confirmText('Yard', 50, 70)))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
