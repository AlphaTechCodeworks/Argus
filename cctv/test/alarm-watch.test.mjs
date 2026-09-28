// The cameras' own line-crossing alarms, read from each NVR's live alarm list (alarm-watch.mjs):
// parsing queryAlarmStatus (the answer captured from nvr-2 on 2026-09-27, which lists nine motion
// alarms and no AI alarm, plus AI items written here in the shape nvr-2's web client reads them), the
// watcher's manners (which NVRs it asks, never two queries at once to one NVR, a failing NVR logged
// once per 10 min) and what the server does with each report (crossingHandler).
// Pure: fake NVRs, a fake query, a fake clock and a fake store; no SDK, no network.
//   node cctv/test/alarm-watch.test.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAIL_LOG_MS, SOURCE_ALARM_STATUS, WATCH_EVERY_MS, crossingHandler, parseAlarmStatus, startAlarmWatch } from '../alarm-watch.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const sameFields = (got, want) => Boolean(got) && Object.keys(got).length === Object.keys(want).length && Object.keys(want).every((k) => got[k] === want[k])
const settle = () => new Promise((r) => setImmediate(r))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const captured = readFileSync(join(import.meta.dirname, 'fixtures', 'lines', 'alarmstatus.xml'), 'utf8')
const guid = (ch) => `{${(ch + 1).toString(16).toUpperCase().padStart(8, '0')}-0000-0000-0000-000000000000}`
// One active AI alarm, with the elements nvr-2's web client reads (viewAlarmStatus.js). Its recorded
// channel is another camera on purpose: the camera that alarmed is sourceChl, never a recorded one.
const aiItem = (type, ch, time, name = `Camera ${ch + 1}`) =>
  `<item><sourceChl id="${guid(ch)}">${name}</sourceChl><triggerRecChls type="list"><itemType></itemType>` +
  `<item id="${guid(ch + 5)}">Another camera</item></triggerRecChls><intelligentType>${type}</intelligentType>` +
  `<alarmTime>${time}</alarmTime><triggerAlarmOutNames></triggerAlarmOutNames><buzzerSwitch>false</buzzerSwitch>` +
  `<popMsgSwitch>false</popMsgSwitch><triggerPresetNames></triggerPresetNames><ftpRecSwitch>false</ftpRecSwitch>` +
  `<snapSwitch>false</snapSwitch><ftpSnapSwitch>false</ftpSnapSwitch><popVideoSwitch>false</popVideoSwitch>` +
  `<emailSwitch>false</emailSwitch></item>`
const LIST_OPEN = '<intelligents type="list">'
const withAi = (...items) => captured.replace(LIST_OPEN, LIST_OPEN + items.join(''))

// ---- parsing -------------------------------------------------------------------------------------

check('the captured answer has the AI list and nine motion alarms (one on Maingate Roadway)',
  captured.includes(LIST_OPEN) && captured.split('<sourceChl ').length - 1 === 9 && captured.includes('<sourceChl id="{00000003-0000-0000-0000-000000000000}">Maingate Roadway'))
check('motion alarms are not AI alarms: the captured answer gives none', parseAlarmStatus(captured).length === 0)

const START = Date.UTC(2026, 8, 28, 0, 7, 30) // 2026-09-28 00:07:30 UTC
const TRIP = aiItem('tripwire', 2, '2026-09-28 00:07:30', 'Maingate Roadway')
{
  const got = parseAlarmStatus(withAi(TRIP, aiItem('pea', 29, '2026-09-28 00:05:00', 'JP Wharf North')))
  check('each AI alarm is read: kind, camera id, 0-based channel, start',
    got.length === 2 && sameFields(got[0], { kind: 'tripwire', chlId: '{00000003-0000-0000-0000-000000000000}', ch: 2, startMs: START }), JSON.stringify(got))
  check('... channel ids in hex: {0000001E-...} is channel index 29', sameFields(got[1], { kind: 'pea', chlId: '{0000001E-0000-0000-0000-000000000000}', ch: 29, startMs: Date.UTC(2026, 8, 28, 0, 5, 0) }), JSON.stringify(got[1]))
  check('alarmTime is UTC, whatever this machine’s time zone', new Date(got[0].startMs).toISOString() === '2026-09-28T00:07:30.000Z')
}
{
  const noCamera = aiItem('tripwire', 2, '2026-09-28 00:07:30').replace(`<sourceChl id="${guid(2)}">`, '<sourceChl id="">')
  const noTime = aiItem('tripwire', 3, 'soon')
  const noKind = aiItem('', 4, '2026-09-28 00:07:30')
  const got = parseAlarmStatus(withAi(noCamera, noTime, noKind, aiItem('tripwire', 5, '2026-09-28 00:07:31')))
  check('an item whose camera, time or kind cannot be read is left out, not guessed', got.length === 1 && got[0].ch === 5, JSON.stringify(got))
}
{
  let why = ''
  try {
    parseAlarmStatus('<?xml version="1.0" encoding="UTF-8"?><response><status>fail</status><errorCode>536870947</errorCode></response>')
  } catch (e) {
    why = e.message
  }
  check('a refusal is an error, with its code', /refused queryAlarmStatus \(fail, code 536870947\)/.test(why), why)
  let empty = ''
  try {
    parseAlarmStatus('')
  } catch (e) {
    empty = e.message
  }
  check('... and so is an empty answer', /did not answer with a document/.test(empty), empty)
}

// ---- the watcher ---------------------------------------------------------------------------------

let t = START + 2000
const now = () => t

/** A watcher whose timer never fires during the test (the test calls tick itself). */
function watcher({ nvrList, lines, answer, ...more }) {
  const calls = []
  const crossings = []
  const logs = []
  const w = startAlarmWatch({
    nvrs: () => nvrList,
    linesOn: () => new Set(lines),
    query: async (nvr) => {
      calls.push(nvr.id)
      return typeof answer === 'function' ? answer(nvr) : answer
    },
    onCrossing: (e) => crossings.push(e),
    everyMs: 3_600_000,
    log: (l) => logs.push(l),
    now,
    ...more
  })
  return { w, calls, crossings, logs }
}

{
  const nvrList = [
    { id: 'nvr-2', name: 'NVR 2', online: true },
    { id: 'nvr-1', name: 'NVR 1', online: true }, // only a malformed key: no lines
    { id: 'nvr-3', name: 'NVR 3', online: false }, // lines, offline
    { id: 'nvr-4', name: 'NVR 4', online: true, degraded: true }, // lines, recovering
    { id: 'nvr-7', name: 'NVR 7', online: true } // no lines at all
  ]
  const answer = withAi(TRIP, aiItem('pea', 2, '2026-09-28 00:07:31'), aiItem('tripwire', 29, '2026-09-28 00:07:20'))
  const { w, calls, crossings } = watcher({ nvrList, lines: ['nvr-2/2', 'nvr-3/0', 'nvr-4/1', 'nvr-1/x', 'junk', '/4'], answer })
  const asked = await w.tick()
  check('only online, not recovering NVRs with a camera with lines on are asked', JSON.stringify(calls) === '["nvr-2"]' && JSON.stringify(asked) === '["nvr-2"]', JSON.stringify(calls))
  check('a tripwire alarm on a camera with lines is reported as a line crossing (UTC start, 0-based channel)',
    crossings.length === 1 && sameFields(crossings[0], { nvr: 'nvr-2', ch: 2, type: 'line-crossing', subtype: 'tripwire', startMs: START, endMs: START, source: SOURCE_ALARM_STATUS, again: false }), JSON.stringify(crossings))
  check('... not a pea alarm on that camera, nor a tripwire alarm on a camera without lines, nor any motion alarm', crossings.every((c) => c.ch === 2 && c.subtype === 'tripwire'))
  t += WATCH_EVERY_MS
  await w.tick()
  check('listed again next tick: the same alarm (again), its end moved on by this server’s clock',
    crossings.length === 2 && crossings[1].again === true && crossings[1].startMs === START && crossings[1].endMs === START + WATCH_EVERY_MS, JSON.stringify(crossings[1]))
  w.stop()
}

{
  let answer = captured
  const { w, crossings } = watcher({ nvrList: [{ id: 'nvr-2', online: true }], lines: ['nvr-2/2'], answer: () => answer })
  await w.tick()
  check('Maingate Roadway’s motion alarm is not a crossing', crossings.length === 0)
  answer = withAi(TRIP, TRIP)
  await w.tick()
  check('an alarm listed twice in one answer is one crossing', crossings.length === 1 && crossings[0].again === false)
  answer = captured
  t += WATCH_EVERY_MS
  await w.tick()
  answer = withAi(aiItem('tripwire', 2, '2026-09-28 00:08:10'))
  t += WATCH_EVERY_MS
  await w.tick()
  check('after the alarm ends, the next one is new', crossings.length === 2 && crossings[1].again === false && crossings[1].startMs === Date.UTC(2026, 8, 28, 0, 8, 10))
  w.stop()
}

{
  // nvr-2's first answer is held back; nvr-5 answers at once
  let release = null
  const calls = []
  const w = startAlarmWatch({
    nvrs: () => [{ id: 'nvr-2', online: true }, { id: 'nvr-5', online: true }],
    linesOn: () => new Set(['nvr-2/2', 'nvr-5/0']),
    query: (nvr) => {
      calls.push(nvr.id)
      return nvr.id === 'nvr-2' && !release ? new Promise((r) => (release = r)) : Promise.resolve(captured)
    },
    onCrossing: () => {},
    everyMs: 3_600_000,
    log: () => {},
    now
  })
  const first = w.tick()
  await settle()
  await w.tick()
  await w.tick()
  const n = (id) => calls.filter((c) => c === id).length
  check('an NVR whose last query has not come back is not asked again', n('nvr-2') === 1, JSON.stringify(calls))
  check('... while the other NVR is asked every tick', n('nvr-5') === 3, JSON.stringify(calls))
  release(withAi(TRIP))
  await first
  await w.tick()
  check('once it has answered it is asked again', n('nvr-2') === 2, JSON.stringify(calls))
  w.stop()
}

{
  let fail = false
  const { w, calls, crossings, logs } = watcher({
    nvrList: [{ id: 'nvr-2', online: true }, { id: 'nvr-6', online: true }],
    lines: ['nvr-2/2', 'nvr-6/0'],
    answer: (nvr) => {
      if (fail && nvr.id === 'nvr-2') throw new Error('Too many NVR settings requests at once (10 waiting); nothing was sent. Try again shortly')
      return withAi(TRIP)
    }
  })
  await w.tick()
  check('before the failure: one crossing', crossings.length === 1 && crossings[0].again === false)
  fail = true
  const t0 = t
  await w.tick()
  const mine = () => logs.filter((l) => l.includes('nvr-2'))
  check('a failed query is logged, naming the NVR and the reason', mine().length === 1 && mine()[0].includes('Too many NVR settings requests'), JSON.stringify(logs))
  for (let i = 0; i < 20; i++) {
    t += WATCH_EVERY_MS
    await w.tick()
  }
  check('... not again for the next 20 failing ticks', mine().length === 1, JSON.stringify(logs))
  check('... which were still tried (a failure only skips that tick)', calls.filter((c) => c === 'nvr-2').length === 22)
  check('... and the other NVR was not held up', calls.filter((c) => c === 'nvr-6').length === 22 && logs.every((l) => !l.includes('nvr-6')))
  t = t0 + FAIL_LOG_MS
  await w.tick()
  check('... logged again once FAIL_LOG_MS (10 min) has passed', mine().length === 2 && FAIL_LOG_MS === 600_000)
  fail = false
  t += WATCH_EVERY_MS
  await w.tick()
  check('answering again is logged once', mine().length === 3 && /answers again \(after 22 failed reads\)/.test(mine()[2]), mine()[2])
  check('an alarm listed across the failure is still the same alarm, not a new one', crossings.length === 2 && crossings[1].again === true && crossings[1].startMs === START)
  fail = true
  t += WATCH_EVERY_MS
  await w.tick()
  fail = false
  t += WATCH_EVERY_MS
  await w.tick()
  check('a failure soon after is not logged (nor its recovery): the 10 min apply per NVR, not per failure', mine().length === 3, JSON.stringify(mine()))
  w.stop()
}

{
  let busy = true
  const { w, calls } = watcher({ nvrList: [{ id: 'nvr-2', online: true }], lines: ['nvr-2/2'], answer: withAi(TRIP), sdkBusy: () => busy })
  await w.tick()
  check('nobody is asked while an SDK call is overdue', calls.length === 0)
  busy = false
  await w.tick()
  check('... and asked again once it is not', calls.length === 1)
  w.stop()
}

{
  const { w, crossings, logs } = watcher({
    nvrList: [{ id: 'nvr-2', online: true }],
    lines: ['nvr-2/2', 'nvr-2/3'],
    answer: withAi(TRIP, aiItem('tripwire', 3, '2026-09-28 00:07:31')),
    onCrossing: (e) => {
      if (e.ch === 2) throw new Error('database is locked')
      crossings.push(e)
    }
  })
  await w.tick()
  check('a crossing that cannot be filed is logged and the others still are', crossings.length === 1 && crossings[0].ch === 3 && logs.some((l) => l.includes('nvr-2/2') && l.includes('database is locked')), JSON.stringify(logs))
  w.stop()
}

{
  let release = null
  const calls = []
  const crossings = []
  const w = startAlarmWatch({
    nvrs: () => [{ id: 'nvr-2', online: true }],
    linesOn: () => new Set(['nvr-2/2']),
    query: (nvr) => {
      calls.push(nvr.id)
      return new Promise((r) => (release = r))
    },
    onCrossing: (e) => crossings.push(e),
    everyMs: 3_600_000,
    log: () => {},
    now
  })
  const pending = w.tick()
  w.stop()
  release(withAi(TRIP))
  await pending
  check('an answer that comes back after stop() is dropped', crossings.length === 0)
  await w.tick()
  check('... and a stopped watcher asks nothing', calls.length === 1)
}

{
  const calls = []
  const w = startAlarmWatch({
    nvrs: () => [{ id: 'nvr-2', online: true }],
    linesOn: () => new Set(['nvr-2/2']),
    query: async (nvr) => {
      calls.push(nvr.id)
      return captured
    },
    onCrossing: () => {},
    everyMs: 20,
    log: () => {}
  })
  await wait(200)
  const seen = calls.length
  w.stop()
  await wait(80)
  check('the timer ticks on its own every everyMs, and stop() ends it', seen >= 2 && calls.length === seen, `${seen} then ${calls.length}`)
}

// ---- what the server does with a report ------------------------------------------------------------

{
  const stored = []
  const handled = []
  const grown = []
  let answer = null
  const store = {
    addEvent: (row, nowMs) => {
      stored.push({ row, nowMs })
      return answer(row)
    }
  }
  const onCrossing = crossingHandler({ ...store, handle: (ev) => handled.push(ev), grew: (ev) => grown.push(ev), now: () => 1234 })
  const report = { nvr: 'nvr-2', ch: 2, type: 'line-crossing', subtype: 'tripwire', startMs: START, endMs: START, source: SOURCE_ALARM_STATUS, again: false }

  answer = (row) => ({ event: { id: 7, ...row }, isNew: true })
  check('a new crossing is stored and handled', onCrossing(report)?.id === 7 && handled.length === 1 && handled[0].id === 7 && grown.length === 0)
  check('... stored without the watcher’s again flag, with a detail, at the given time',
    !('again' in stored[0].row) && /line-crossing alarm/.test(stored[0].row.detail) && stored[0].nowMs === 1234 && stored[0].row.endMs === START)

  answer = (row) => ({ event: { id: 7, ...row, startMs: START - 20_000 }, isNew: false })
  check('merged into the camera’s previous crossing (a row with another start): handled again, not grown', onCrossing({ ...report, startMs: START + 20_000, endMs: START + 20_000 })?.id === 7 && handled.length === 2 && grown.length === 0)

  answer = (row) => ({ event: { id: 7, ...row }, isNew: false })
  check('the same alarm on a later tick: stored (its end moves on), grown, not handled', onCrossing({ ...report, endMs: START + 5000, again: true }) === null && handled.length === 2 && grown.length === 1 && grown[0].id === 7 && stored.at(-1).row.endMs === START + 5000)
  check('a row already there with this very start (a restart while it was listed): grown, not handled', onCrossing(report) === null && handled.length === 2 && grown.length === 2)

  answer = () => ({ event: null, isNew: false })
  check('nothing stored: nothing handled or grown', onCrossing(report) === null && handled.length === 2 && grown.length === 2)

  // Fix round 1: a row events-db has never stored before (isNew: true) must always be handled, even
  // when the watcher's own `again` says it has seen this alarm before. `again` is only the watcher's
  // memory of having filed an alarm, not what events-db holds. isNew is the source of truth, not again.
  answer = (row) => ({ event: { id: 42, ...row }, isNew: true })
  check('a fresh row (isNew) reported "again" by the watcher is still handled, not just grown',
    onCrossing({ ...report, nvr: 'nvr-9', again: true })?.id === 42 && handled.some((h) => h.id === 42) && !grown.some((g) => g.id === 42))
}

{
  // Fix round 1 reproduction: addEvent throws on the alarm's first sighting (e.g. the events-db is
  // briefly locked). The next tick files it (the watcher remembers an alarm only once it has been
  // filed, so it comes back as new) and storing comes back isNew: true: the alert must reach the
  // notifier exactly once, not be silently grown forever.
  let fail = true
  const stored = []
  const store = {
    addEvent: (row) => {
      if (fail) throw new Error('database is locked')
      stored.push(row)
      return { event: { id: 9, ...row }, isNew: stored.length === 1 }
    }
  }
  const handled = []
  const grown = []
  const logs = []
  const onCrossing = crossingHandler({ ...store, handle: (ev) => handled.push(ev.id), grew: (ev) => grown.push(ev.id) })
  const w = startAlarmWatch({
    nvrs: () => [{ id: 'nvr-2', online: true }],
    linesOn: () => new Set(['nvr-2/2']),
    query: async () => withAi(TRIP),
    onCrossing,
    everyMs: 3_600_000,
    log: (l) => logs.push(l),
    now
  })
  await w.tick()
  check('a failed filing is logged; nothing handled or grown yet', handled.length === 0 && grown.length === 0 && logs.some((l) => l.includes('database is locked')), JSON.stringify(logs))
  fail = false
  t += WATCH_EVERY_MS
  await w.tick()
  check('once storing succeeds (a fresh row, isNew): the alert reaches the notifier exactly once, not just grown',
    handled.length === 1 && handled[0] === 9 && grown.length === 0, JSON.stringify({ handled, grown }))
  t += WATCH_EVERY_MS
  await w.tick()
  check('... and the alarm still listed on the next tick only grows it', handled.length === 1 && grown.length === 1 && grown[0] === 9, JSON.stringify({ handled, grown }))
  w.stop()
}

{
  // The fold branch: a crossing 20 s after the camera's previous one, which events-db folds into that
  // one (isNew false, the row's start is the earlier crossing's). Its first filing throws. The watcher
  // remembers an alarm only once it has been filed, so the next tick reports it as new (again: false)
  // and crossingHandler hands it to the rules; reported `again: true` it would only have been grown.
  let fail = true
  const PREV = START - 20_000
  const handled = []
  const grown = []
  const reported = []
  const onCrossing = crossingHandler({
    addEvent: (row) => {
      if (fail) throw new Error('database is locked')
      return { event: { id: 5, ...row, startMs: PREV }, isNew: false }
    },
    handle: (ev) => handled.push(ev.id),
    grew: (ev) => grown.push(ev.id)
  })
  const w = startAlarmWatch({
    nvrs: () => [{ id: 'nvr-2', online: true }],
    linesOn: () => new Set(['nvr-2/2']),
    query: async () => withAi(TRIP),
    onCrossing: (e) => {
      reported.push(e.again)
      return onCrossing(e)
    },
    everyMs: 3_600_000,
    log: () => {},
    now
  })
  await w.tick()
  check('(the first filing of a crossing that folds fails)', handled.length === 0 && grown.length === 0 && reported.join() === 'false')
  fail = false
  t += WATCH_EVERY_MS
  await w.tick()
  check('filed on the next tick, it is reported as new and handled (the rules see the fold), not only grown',
    reported.join() === 'false,false' && handled.join() === '5' && grown.length === 0, JSON.stringify({ reported, handled, grown }))
  t += WATCH_EVERY_MS
  await w.tick()
  check('... after which it is the same alarm (again), only grown', reported.at(-1) === true && handled.length === 1 && grown.join() === '5', JSON.stringify({ reported, handled, grown }))
  w.stop()
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
