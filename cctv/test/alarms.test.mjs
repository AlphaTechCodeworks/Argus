// Offline tests for the Alarms page's server side (alarms.mjs, event-rules.mjs, events-db.mjs) and
// its pure view code (public/alarms-view.js): rule validation and matching, priority, the quiet
// gap, the prioritised list, the filters, acknowledging, the bookmark and export handoffs, and the
// routes end to end against a real SQLite file in a temp folder.
//
// Temp data folder only; no NVR, no SDK, no network, and the notifier is given a fake sender so
// nothing is delivered anywhere.
//   node cctv/test/alarms.test.mjs
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-alarms-test-'))
// Alice is an admin, Bob a viewer: the roles come from the real users file, so ownership and the
// admin-only routes are tried through the same lookup the server uses.
writeFileSync(join(process.env.DATA_DIR, 'users.json'), JSON.stringify({ alice: { hash: 'x', role: 'admin' }, bob: { hash: 'x', role: 'viewer' } }))

const {
  DEFAULT_PRIORITY, PRIORITIES, alarmMessage, applyRules, cameraKey, checkAck, checkRule,
  filterAlarms, labelOf, prioritise, priorityRank, ruleMatches, summarise, withinQuietGap
} = await import('../event-rules.mjs')
const {
  EVENT_KEEP_DAYS, MERGE_MS, acknowledge, addEvent, classify, closeEvents, createRule, deleteRule, eventKeepDays, eventsOfCamera,
  forgetEventsBefore, getEvent, lastEventMs, listEvents, listRules, unackedEvents,
  unacknowledge, updateRule
} = await import('../events-db.mjs')
const { CLIP_PRE_S, CLIP_POST_S, NOTIFY_MAX_AGE_MS, clipOf, handleAlarms, makeAlarmNotifier, nameCameras } = await import('../alarms.mjs')
const { alarmRows, filterSummary, ruleSummary, timeAgo } = await import('../public/alarms-view.js')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 25, 9, 0, 0) // a Friday
const MIN = 60_000
const S = 1000
const json = (o) => async () => o

// --- rule validation ---------------------------------------------------------------------------
{
  const ok = checkRule({ name: 'Yard at night', cameras: ['nvr1/3'], types: ['motion'], priority: 'high', notify: true, schedule: [{ days: [5], from: '22:00', to: '06:00' }] })
  check('a complete rule is accepted', ok.ok, ok.error)
  check('and comes back tidied', ok.value.enabled === true && ok.value.minGapS === 0)
  check('a rule with no name is refused', !checkRule({ types: ['motion'] }).ok)
  check('a rule with an unknown kind is refused', /not an event kind/.test(checkRule({ name: 'x', types: ['unicorn'] }).error ?? ''))
  check('a rule with a bad camera key is refused', !checkRule({ name: 'x', cameras: ['nvr1'] }).ok)
  check('a rule with a bad priority is refused', !checkRule({ name: 'x', priority: 'urgent' }).ok)
  check('a rule with a bad time is refused', !checkRule({ name: 'x', schedule: [{ from: '25:00', to: '01:00' }] }).ok)
  check('a rule with a bad day is refused', !checkRule({ name: 'x', schedule: [{ days: [9] }] }).ok)
  check('a rule with a silly quiet gap is refused', !checkRule({ name: 'x', minGapS: -1 }).ok)
  // Unset means all: a half-filled form must do something obvious rather than nothing.
  const bare = checkRule({ name: 'Everything' })
  check('an empty rule means every camera and every kind', bare.ok && bare.value.cameras.length === 0 && bare.value.types.length === 0)
  check('and it defaults to the quietest priority', bare.value.priority === DEFAULT_PRIORITY)
  check('and to not notifying', bare.value.notify === false)
  check('an unconfirmed kind may still be written into a rule', checkRule({ name: 'x', types: ['ai-person'] }).ok)
  check('a rule may name line crossings', checkRule({ name: 'Line crossing', types: ['line-crossing'], priority: 'high', notify: true, minGapS: 30 }).ok)
}

// --- matching ----------------------------------------------------------------------------------
{
  const ev = { nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0 }
  const all = { name: 'all', enabled: true, cameras: [], types: [], schedule: [], priority: 'medium' }
  check('an empty rule matches anything', ruleMatches(all, ev))
  check('a disabled rule matches nothing', !ruleMatches({ ...all, enabled: false }, ev))
  check('the right camera matches', ruleMatches({ ...all, cameras: ['nvr1/3'] }, ev))
  check('another camera does not', !ruleMatches({ ...all, cameras: ['nvr1/4'] }, ev))
  check('the right kind matches', ruleMatches({ ...all, types: ['motion'] }, ev))
  check('another kind does not', !ruleMatches({ ...all, types: ['ai'] }, ev))
  const crossing = { nvr: 'nvr2', ch: 2, type: 'line-crossing', subtype: 'tripwire', startMs: T0 }
  check('a line-crossing rule matches a crossing', ruleMatches({ ...all, types: ['line-crossing'] }, crossing))
  check('... on its own cameras only', !ruleMatches({ ...all, cameras: ['nvr2/3'], types: ['line-crossing'] }, crossing))
  check('... and not motion', !ruleMatches({ ...all, types: ['line-crossing'] }, ev))
  check('a smart-detection rule no longer catches a crossing', !ruleMatches({ ...all, types: ['ai'] }, crossing))
  const told = applyRules([{ ...all, id: 9, types: ['line-crossing'], priority: 'high', notify: true }], crossing)
  check('a crossing under a notifying line rule is high and tells someone', told.priority === 'high' && told.notify === true, JSON.stringify(told))
  check('the schedule is applied', !ruleMatches({ ...all, schedule: [{ from: '22:00', to: '23:00' }] }, ev))
  check('and the site offset with it', ruleMatches({ ...all, schedule: [{ from: '04:00', to: '06:00' }] }, ev, { tzOffsetMin: -240 }))
  check('cameraKey is the key used everywhere else', cameraKey('nvr1', 3) === 'nvr1/3')
}

// --- priority and notification -------------------------------------------------------------------
{
  const ev = { nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0 }
  check('no rules: the event is still kept, quietly', applyRules([], ev).priority === DEFAULT_PRIORITY && applyRules([], ev).notify === false)
  const rules = [
    { id: 1, name: 'quiet', enabled: true, cameras: [], types: [], schedule: [], priority: 'low', notify: true },
    { id: 2, name: 'loud', enabled: true, cameras: ['nvr1/3'], types: ['motion'], schedule: [], priority: 'critical', notify: false }
  ]
  const v = applyRules(rules, ev)
  check('the most urgent matching rule sets the priority', v.priority === 'critical' && v.rule.id === 2, JSON.stringify(v.rule))
  // The important one: a quieter rule must never cancel a rule that asked to be told.
  check('notification is the OR of every match', v.notify === true)
  check('both matches are reported', v.matched.length === 2)
  check('priorityRank puts critical first', priorityRank('critical') < priorityRank('low'))
  check('an unknown priority ranks last rather than throwing', priorityRank('nonsense') === PRIORITIES.length)

  const rule = { minGapS: 60 }
  check('inside the quiet gap: hold', withinQuietGap(rule, T0, T0 + 30 * S))
  check('past it: send', !withinQuietGap(rule, T0, T0 + 90 * S))
  check('never sent before: send', !withinQuietGap(rule, undefined, T0))
  check('no gap set: always send', !withinQuietGap({ minGapS: 0 }, T0, T0))
}

// --- the list ------------------------------------------------------------------------------------
{
  const list = [
    { id: 1, nvr: 'n', ch: 0, type: 'motion', priority: 'low', startMs: T0 + 5 * MIN, ackMs: null },
    { id: 2, nvr: 'n', ch: 1, type: 'ai', priority: 'critical', startMs: T0, ackMs: null },
    { id: 3, nvr: 'n', ch: 0, type: 'motion', priority: 'critical', startMs: T0 + 9 * MIN, ackMs: T0 + 10 * MIN },
    { id: 4, nvr: 'n', ch: 0, type: 'motion', priority: 'medium', startMs: T0 + 2 * MIN, ackMs: null }
  ]
  const order = prioritise(list).map((a) => a.id)
  check('anything still needing a human comes first', order.slice(0, 3).every((id) => id !== 3), order.join())
  check('then the most urgent', order[0] === 2, order.join())
  check('then the newest', order.join() === '2,4,1,3', order.join())
  check('prioritise does not change the list it was given', list[0].id === 1)

  check('filter by kind', filterAlarms(list, { types: ['ai'] }).length === 1)
  check('filter by camera', filterAlarms(list, { cameras: ['n/1'] }).length === 1)
  check('filter by priority', filterAlarms(list, { priorities: ['critical'] }).length === 2)
  check('filter to what is unacknowledged', filterAlarms(list, { acked: false }).length === 3)
  check('filter to what is acknowledged', filterAlarms(list, { acked: true }).length === 1)
  check('no filters means everything', filterAlarms(list, {}).length === 4)
  check('filter by time excludes what is outside the window', filterAlarms(list, { fromMs: T0 + 4 * MIN }).length === 2)
  check('a text search looks at the kind and the camera', filterAlarms(nameCameras(list, [{ nvr: 'n', ch: 1, name: 'Yard' }]), { text: 'yard' }).length === 1)

  const s = summarise(list)
  check('the summary counts everything', s.total === 4)
  check('and what is still waiting', s.unacked === 3)
  check('and names the worst thing still waiting', s.worst === 'critical')
  check('an acknowledged critical does not set the worst', summarise([list[2]]).worst === null)
}

// --- naming and clips -------------------------------------------------------------------------------
{
  const named = nameCameras([{ nvr: 'n', ch: 1, type: 'line-crossing', subtype: 'tripwire', startMs: T0, endMs: T0 + 5 * S }], [{ nvr: 'n', ch: 1, name: 'Yard' }])
  check('a camera gets its name', named[0].camera === 'Yard')
  check('and the kind gets a label', named[0].typeLabel === labelOf('line-crossing') && named[0].typeLabel === 'Line crossing', named[0].typeLabel)
  check('a camera the server does not know keeps its key', nameCameras([{ nvr: 'n', ch: 9, type: 'motion', startMs: T0 }], [])[0].camera === 'n/9')

  const clip = clipOf(named[0])
  check('a clip starts before the alarm', clip.startMs === T0 - CLIP_PRE_S * S)
  check('and ends after it', clip.endMs === T0 + 5 * S + CLIP_POST_S * S)
  check('it names the camera it is of', clip.cameras.join() === 'n/1')
  check('and has a title somebody could file', /Yard/.test(clip.title) && /tripwire/.test(clip.title), clip.title)

  const msg = alarmMessage(named[0], { ruleName: 'Yard at night' })
  check('a notification reuses the phase 1 message shape', ['key', 'kind', 'title', 'detail', 'severity'].every((k) => k in msg), JSON.stringify(msg))
  check('its title says what and where', /Yard/.test(msg.title), msg.title)
  check('... naming a crossing as one', /^Line crossing \(tripwire\)/.test(msg.title), msg.title)
  check('it names the rule that decided', /Yard at night/.test(msg.detail), msg.detail)
  check('a critical alarm is high severity to the sender', alarmMessage({ ...named[0], priority: 'critical' }).severity === 'high')
  check('a low one is not', alarmMessage({ ...named[0], priority: 'low' }).severity === 'medium')
  // the phone alert for a line crossing: when on the site's clock, and a link back to the event
  const linked = alarmMessage(named[0], { ruleName: 'Yard at night', link: 'https://cctv.example/alarms.html#event=42', tzOffsetMin: -240 })
  check('with the site offset the detail starts with the site time', linked.detail.startsWith('at 05:00:00 · '), linked.detail)
  check('  and the link is a line of its own, last', linked.detail.split('\n').length === 2 && linked.detail.split('\n')[1] === 'https://cctv.example/alarms.html#event=42', linked.detail)
  check('  an offset of 0 is still an offset (UTC site)', alarmMessage(named[0], { tzOffsetMin: 0 }).detail === 'at 09:00:00', alarmMessage(named[0], { tzOffsetMin: 0 }).detail)
  check('without them the detail is as before', msg.detail === 'rule: Yard at night' && !msg.detail.includes('\n'), msg.detail)

  check('an acknowledgement note is checked', checkAck({ note: 'checked the yard, it was a fox' }).ok)
  check('a huge note is refused', !checkAck({ note: 'x'.repeat(501) }).ok)
  check('an empty note is allowed', checkAck({}).ok && checkAck({}).value.note === '')
}

// --- the store ---------------------------------------------------------------------------------------
{
  const e = { nvr: 'nvr1', ch: 3, type: 'motion', subtype: '', startMs: T0, endMs: T0 + 5 * S, source: 'nvr-recordings', detail: 'the NVR recorded this' }
  const first = addEvent(e, T0)
  check('an event is stored', first.isNew && first.event.id > 0)
  const again = addEvent(e, T0 + MIN)
  check('the same event again is not a second row', !again.isNew && again.event.id === first.event.id)
  const longer = addEvent({ ...e, endMs: T0 + 30 * S }, T0 + 2 * MIN)
  check('but an event that has grown is extended', longer.event.endMs === T0 + 30 * S)
  const shorter = addEvent({ ...e, endMs: T0 + 10 * S }, T0 + 3 * MIN)
  check('and never shrunk back', shorter.event.endMs === T0 + 30 * S)
  // (a line crossing folds only into another line crossing, never into this motion event)
  check('a different kind at the same moment is its own event', addEvent({ ...e, type: 'line-crossing', subtype: 'tripwire' }, T0).isNew)

  check('the newest event time is known per camera', lastEventMs('nvr1', 3) === T0)
  check('and per NVR', lastEventMs('nvr1') === T0)
  check('a camera with nothing has no newest event', lastEventMs('nvr1', 99) === null)
  check('a camera’s events come back oldest first', eventsOfCamera('nvr1', 3, T0 - MIN, T0 + MIN).length === 2)
  check('the window is respected', eventsOfCamera('nvr1', 3, T0 + MIN, T0 + 2 * MIN).length === 0)

  const id = first.event.id
  check('an event starts unacknowledged', getEvent(id).ackMs === null)
  const ack = acknowledge(id, 'bob', 'it was a fox', T0 + 5 * MIN)
  check('acknowledging works', ack.ok && ack.event.ackUser === 'bob' && ack.event.ackNote === 'it was a fox')
  // The first account of an incident is the one worth keeping.
  check('a second person cannot overwrite the first account', !acknowledge(id, 'alice', 'no it was not', T0 + 6 * MIN).ok)
  check('and is told who got there first', /bob/.test(acknowledge(id, 'alice', 'x', T0).error))
  check('acknowledging something that is not there is a 404', acknowledge(99_999, 'bob', '', T0).status === 404)
  check('an id that is not an id is a 400', acknowledge('nonsense', 'bob', '', T0).status === 400)
  check('an admin can take it back', unacknowledge(id).ok && getEvent(id).ackMs === null)

  const graded = classify(id, { priority: 'high', ruleId: 7, ruleName: 'Yard at night' })
  check('the rules’ verdict is written onto the row', graded.priority === 'high' && graded.ruleName === 'Yard at night')
  check('so it survives the rule being deleted later', getEvent(id).ruleName === 'Yard at night')

  check('the list comes back newest first', listEvents({ limit: 10 }).length === 2)
  check('unacknowledged events can be asked for on their own', unackedEvents(10).length === 2)
  acknowledge(id, 'bob', 'kept', T0 + 7 * MIN)
  forgetEventsBefore(T0 + 60 * MIN)
  check('housekeeping drops old events', listEvents({ limit: 10 }).length === 1)
  check('but never one somebody wrote a note on', getEvent(id)?.ackNote === 'kept')
}
{
  // ... and something calls it (audit 2026-10-07 M5: forgetEventsBefore had no caller, so the table only grew)
  const DAY = 86_400_000
  const now = T0 - 400 * DAY // long before the rows the tests below count
  const old = addEvent({ nvr: 'keep1', ch: 0, type: 'motion', startMs: now - 91 * DAY, source: 'x' }, now).event
  const oldNoted = addEvent({ nvr: 'keep1', ch: 1, type: 'motion', startMs: now - 200 * DAY, source: 'x' }, now).event
  const recent = addEvent({ nvr: 'keep1', ch: 2, type: 'motion', startMs: now - 89 * DAY, source: 'x' }, now).event
  acknowledge(oldNoted.id, 'bob', 'the break-in', now)
  check('an event nobody acknowledged is kept 90 days at least', EVENT_KEEP_DAYS === 90 && eventKeepDays({}) === 90 && eventKeepDays({ recording: { defaults: { retentionDays: 30 } } }) === 90)
  check('... and as long as the longest days kept of any camera', eventKeepDays({ recording: { defaults: { retentionDays: 183 }, cameras: { 'nvr1/0': { retentionDays: 366 }, 'nvr1/1': { mode: 'off' } } } }) === 366)
  const gone = forgetEventsBefore(now - eventKeepDays({}) * DAY)
  check('past that it goes, and the count comes back', getEvent(old.id) === null && gone >= 1, `${gone}`)
  check('a newer one stays, and so does an old one with a note', getEvent(recent.id) !== null && getEvent(oldNoted.id)?.ackNote === 'the break-in')
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const round = server.slice(server.indexOf('if (LIVE_WORKER) {'), server.indexOf('.then(() => sweepSnapshots())'))
  check('server.mjs: the 5-minute round forgets old events, before the sweep of their pictures',
    round.includes('forgetEventsBefore(Date.now() - eventKeepDays(getSettings()) * 86_400_000)') && /import \{[^}]*\bforgetEventsBefore\b[^}]*\} from '\.\/events-db\.mjs'/.test(server), round.slice(-300))
}

// --- rules in the store -----------------------------------------------------------------------------
{
  const made = createRule({ name: 'Yard at night', cameras: ['nvr1/3'], types: ['motion'], priority: 'high', notify: true, minGapS: 120 }, 'alice', T0)
  check('a rule is stored', made.ok && made.rule.id > 0)
  check('its lists come back as lists', Array.isArray(made.rule.cameras) && made.rule.cameras[0] === 'nvr1/3')
  check('and who made it', made.rule.user === 'alice')
  check('a bad rule is refused before it is stored', !createRule({ name: '' }, 'alice', T0).ok)
  check('it is in the list', listRules().some((r) => r.id === made.rule.id))

  const patched = updateRule(made.rule.id, { priority: 'critical' }, T0 + MIN)
  check('a patch is merged onto the stored rule', patched.ok && patched.rule.priority === 'critical')
  check('and the untouched fields survive', patched.rule.cameras.join() === 'nvr1/3' && patched.rule.minGapS === 120)
  check('a patch that would make it invalid is refused', !updateRule(made.rule.id, { name: '' }, T0).ok)
  check('and the stored rule is unchanged', updateRule(made.rule.id, { name: '' }, T0) && listRules().find((r) => r.id === made.rule.id).name === 'Yard at night')
  check('patching a rule that is not there is a 404', updateRule(99_999, {}, T0).status === 404)
  check('deleting works', deleteRule(made.rule.id).ok && !listRules().some((r) => r.id === made.rule.id))
  check('deleting twice is a 404, not a crash', deleteRule(made.rule.id).status === 404)
}

// --- the notifier ------------------------------------------------------------------------------------
{
  const sent = []
  const sender = { deliver: async (alerts, kind) => sent.push({ alerts, kind }) }
  const rules = [{ id: 1, name: 'loud', enabled: true, cameras: [], types: ['motion'], schedule: [], priority: 'critical', notify: true, minGapS: 60 }]
  let now = T0 + 100 * MIN
  const notifier = makeAlarmNotifier({ sender, rules: () => rules, now: () => now, log: () => {} })

  const one = addEvent({ nvr: 'nvr1', ch: 0, type: 'motion', startMs: now, source: 'x' }, now).event
  const graded = await notifier.handle(one)
  check('the notifier grades the event', graded.priority === 'critical' && graded.ruleName === 'loud')
  await new Promise((r) => setImmediate(r))
  check('and a rule that asked for it gets a message out', sent.length === 1 && sent[0].kind === 'opened', JSON.stringify(sent))
  check('the message is the phase 1 shape', sent[0].alerts[0].severity === 'high')

  now += 10 * S
  const two = addEvent({ nvr: 'nvr1', ch: 0, type: 'motion', startMs: now, source: 'x' }, now).event
  await notifier.handle(two)
  await new Promise((r) => setImmediate(r))
  check('a second alarm inside the quiet gap is not sent', sent.length === 1, `${sent.length}`)
  check('but it is still recorded, at full priority', getEvent(two.id).priority === 'critical')

  now += 5 * MIN
  const three = addEvent({ nvr: 'nvr1', ch: 0, type: 'motion', startMs: now, source: 'x' }, now).event
  await notifier.handle(three)
  await new Promise((r) => setImmediate(r))
  check('once the gap has passed, the next one is sent', sent.length === 2)

  now += 10 * MIN
  const quiet = addEvent({ nvr: 'nvr1', ch: 0, type: 'pos', startMs: now, source: 'x' }, now).event
  await notifier.handle(quiet)
  await new Promise((r) => setImmediate(r))
  check('a kind no rule mentions is kept but nobody is woken', sent.length === 2 && getEvent(quiet.id).priority === DEFAULT_PRIORITY)

  const sameAgain = await notifier.handle(getEvent(three.id))
  await new Promise((r) => setImmediate(r))
  check('the same alarm is never delivered twice', sent.length === 2, `${sent.length}`)
  check('because the row remembers it was sent', sameAgain.notifiedMs > 0)

  // the link and the site's time reach what the sender is given
  const got = []
  const toSender = { deliver: async (alerts) => got.push(alerts[0]) }
  const linking = makeAlarmNotifier({ sender: toSender, rules: () => rules, now: () => now, tzOffsetMin: () => -240, linkOf: (row) => `https://cctv.example/alarms.html#event=${row.id}`, log: () => {} })
  now += 10 * MIN
  const four = addEvent({ nvr: 'nvr1', ch: 0, type: 'motion', startMs: now, source: 'x' }, now).event
  await linking.handle(four)
  await new Promise((r) => setImmediate(r))
  check('the message carries the link to the event', got.length === 1 && got[0].detail.endsWith(`\nhttps://cctv.example/alarms.html#event=${four.id}`), JSON.stringify(got))
  check('  and when it happened on the site clock', got[0]?.detail.startsWith(`at ${new Date(now - 240 * MIN).toISOString().slice(11, 19)} · `), got[0]?.detail)
  const broken = makeAlarmNotifier({ sender: toSender, rules: () => rules, now: () => now, linkOf: () => { throw new Error('settings unreadable') }, log: () => {} })
  now += 10 * MIN
  const five = addEvent({ nvr: 'nvr1', ch: 0, type: 'motion', startMs: now, source: 'x' }, now).event
  await broken.handle(five)
  await new Promise((r) => setImmediate(r))
  check('a link that cannot be made costs the link, not the alert', got.length === 2 && !got[1].detail.includes('\n'), JSON.stringify(got[1]))
}
{
  // The quiet gap and the name in the message come from the rule that asked to notify, not from the
  // most urgent matching rule (audit 2026-10-07 M4): a critical rule with no gap and notify off took
  // away the 30 s gap of the rule that does notify, and the message named the critical rule.
  const sent = []
  const sender = { deliver: async (alerts) => sent.push(alerts[0]) }
  const rules = [
    { id: 11, name: 'grade only', enabled: true, cameras: [], types: ['tamper'], schedule: [], priority: 'critical', notify: false, minGapS: 0 },
    { id: 12, name: 'tell me', enabled: true, cameras: [], types: ['tamper'], schedule: [], priority: 'low', notify: true, minGapS: 30 }
  ]
  let now = T0 + 300 * MIN
  const notifier = makeAlarmNotifier({ sender, rules: () => rules, now: () => now, log: () => {} })
  const tamper = (ch) => addEvent({ nvr: 'nvr1', ch, type: 'tamper', startMs: now, source: 'x' }, now).event
  const first = await notifier.handle(tamper(5))
  await new Promise((r) => setImmediate(r))
  check('graded by the most urgent rule, told by the rule that asked', first.priority === 'critical' && first.ruleName === 'grade only' && sent.length === 1, JSON.stringify(first))
  check('the message names the rule that asked to notify', /rule: tell me$/.test(sent[0]?.detail ?? ''), JSON.stringify(sent[0]))
  now += 10 * S
  await notifier.handle(tamper(5))
  await new Promise((r) => setImmediate(r))
  check('the notifying rule\'s quiet gap holds, whatever the gap of the more urgent rule', sent.length === 1, `${sent.length}`)
  await notifier.handle(tamper(6))
  await new Promise((r) => setImmediate(r))
  check('the gap is per camera', sent.length === 2, `${sent.length}`)
  now += 31 * S
  await notifier.handle(tamper(5))
  await new Promise((r) => setImmediate(r))
  check('once that gap has passed, the next one is sent', sent.length === 3, `${sent.length}`)

  // two rules that both ask: a message goes when either rule's gap has passed, and starts both gaps
  rules.push({ id: 13, name: 'tell me rarely', enabled: true, cameras: [], types: ['tamper'], schedule: [], priority: 'high', notify: true, minGapS: 300 })
  now += 10 * MIN
  await notifier.handle(tamper(5))
  now += 10 * S
  await notifier.handle(tamper(5))
  await new Promise((r) => setImmediate(r))
  check('two rules asking: one message, not one per rule', sent.length === 4, `${sent.length}`)
  now += 31 * S
  await notifier.handle(tamper(5))
  await new Promise((r) => setImmediate(r))
  check('... and the shorter gap decides when the next one goes', sent.length === 5 && /rule: tell me$/.test(sent[4]?.detail ?? ''), `${sent.length} ${sent[4]?.detail}`)
}
{
  // An event read back long after it happened (the intake catching up after an outage or a restart,
  // events.mjs CATCH_UP_MS) is graded and kept, but nobody is told: NOTIFY_MAX_AGE_MS.
  const sent = []
  const sender = { deliver: async (alerts) => sent.push(alerts[0]) }
  const rules = [{ id: 21, name: 'door', enabled: true, cameras: [], types: ['sensor', 'line-crossing'], schedule: [], priority: 'high', notify: true, minGapS: 600 }]
  const now = T0 + 190 * MIN
  const notifier = makeAlarmNotifier({ sender, rules: () => rules, now: () => now, log: () => {} })
  const filed = (startMs, extra = {}) => addEvent({ nvr: 'nvr1', ch: 7, type: 'sensor', startMs, source: 'recordings', ...extra }, now).event
  const settle = () => new Promise((r) => setImmediate(r))
  check('the age limit is hours, not minutes and not days', NOTIFY_MAX_AGE_MS >= 3_600_000 + 15 * MIN && NOTIFY_MAX_AGE_MS <= 6 * 3_600_000, `${NOTIFY_MAX_AGE_MS}`)

  const old = filed(now - 3 * 24 * 60 * MIN)
  const oldRow = await notifier.handle(old)
  await settle()
  check('an event three days old is graded by its rule', oldRow.priority === 'high' && oldRow.ruleName === 'door' && getEvent(old.id).priority === 'high' && getEvent(old.id).ruleName === 'door', JSON.stringify(getEvent(old.id)))
  check('... but is not sent', sent.length === 0, JSON.stringify(sent))
  check('... and is not marked as notified', !oldRow.notifiedMs && !getEvent(old.id).notifiedMs, JSON.stringify(getEvent(old.id)))
  const justOver = filed(now - NOTIFY_MAX_AGE_MS - S)
  await notifier.handle(justOver)
  await settle()
  check('one second past the limit is still not sent', sent.length === 0 && !getEvent(justOver.id).notifiedMs)

  // the old ones did not start the rule's quiet gap (10 min here): the late one below still goes
  const late = filed(now - NOTIFY_MAX_AGE_MS + MIN)
  const lateRow = await notifier.handle(late)
  await settle()
  check('an event inside the limit (filed late, after a back-off) is sent as before', sent.length === 1 && lateRow.notifiedMs === now && getEvent(late.id).notifiedMs === now, `${sent.length} ${JSON.stringify(getEvent(late.id))}`)

  // a live event: the alarm watcher's crossing (seconds old), and one whose NVR clock runs ahead
  const live = makeAlarmNotifier({ sender, rules: () => rules, now: () => now, log: () => {} })
  const crossing = addEvent({ nvr: 'nvr1', ch: 8, type: 'line-crossing', subtype: 'tripwire', startMs: now - 4 * S, source: 'alarm-status' }, now).event
  const crossed = await live.handle(crossing)
  await settle()
  check('a live watcher crossing is sent and marked, as before', sent.length === 2 && crossed.notifiedMs === now && crossed.priority === 'high', `${sent.length} ${JSON.stringify(crossed)}`)
  const ahead = addEvent({ nvr: 'nvr1', ch: 9, type: 'line-crossing', subtype: 'tripwire', startMs: now + 90 * S, source: 'alarm-status' }, now).event
  await live.handle(ahead)
  await settle()
  check('an event stamped ahead of this server (the NVR clock runs fast) is sent', sent.length === 3, `${sent.length}`)
}

// --- the routes --------------------------------------------------------------------------------------
{
  // canSee is explicit here too, as server.mjs's real one always is (and, for an admin, always
  // true): the fail-closed default below must never be what stands in for "an admin sees everything".
  const who = { user: 'alice', admin: true, cameras: () => [{ nvr: 'nvr1', ch: 0, name: 'Gate' }], now: T0 + 200 * MIN, canSee: () => true }
  check('a path that is not ours is not ours', (await handleAlarms('GET', '/api/health', json({}), who)) === null)
  const anon = await handleAlarms('GET', '/api/alarms', json({}), { user: null })
  check('signed out is a 401', anon[0] === 401)

  const listed = await handleAlarms('GET', '/api/alarms?from=0', json({}), who)
  check('the list answers', listed[0] === 200 && Array.isArray(listed[1].alarms))
  check('it is prioritised', listed[1].alarms.length > 0)
  check('it carries the summary', typeof listed[1].summary.unacked === 'number')
  check('it names the cameras', listed[1].alarms.some((a) => a.camera === 'Gate'))
  check('it is never cached', listed[2]['cache-control'] === 'no-store')
  // The honest bit the page prints under the filters.
  check('and it states what cannot be reported', listed[1].sources.notAvailable.length >= 3)
  const filtered = await handleAlarms('GET', '/api/alarms?from=0&types=pos', json({}), who)
  check('the filters are applied server-side too', filtered[1].alarms.every((a) => a.type === 'pos'))
  // The limit counts the alarms shown, not the rows read: a kind that is not among the newest rows
  // is still found (it used to be cut off before the filter ran).
  const everything = listEvents({ limit: 1000 })
  const older = everything.find((e) => e.type !== everything[0].type)
  check('(there is an older alarm of another kind to look for)', Boolean(older))
  const one = await handleAlarms('GET', `/api/alarms?from=0&types=${older.type}&limit=1`, json({}), who)
  check('a filter with a limit of 1 finds the newest match, not nothing', one[1].alarms.length === 1 && one[1].alarms[0].id === older.id, JSON.stringify(one[1].alarms.map((x) => x.id)))
  check('listEvents with keep: the limit counts kept rows', listEvents({ limit: 1, keep: (e) => e.id === older.id }).length === 1)
  // The kind, priority, camera and acknowledged tests are the database's, not JS on every row.
  const kinds = listEvents({ where: { types: [older.type] } })
  check('listEvents where: a kind', kinds.length > 0 && kinds.every((e) => e.type === older.type) && kinds.some((e) => e.id === older.id))
  const ofCam = listEvents({ where: { cameras: [{ nvr: older.nvr, ch: older.ch }] }, keep: () => true })
  check('listEvents where: a camera', ofCam.length > 0 && ofCam.every((e) => e.nvr === older.nvr && e.ch === older.ch))
  check('listEvents where: acknowledged or not', listEvents({ where: { acked: false } }).every((e) => !e.ackMs) && listEvents({ where: { acked: true } }).every((e) => e.ackMs))
  check('listEvents where: a kind and a limit', listEvents({ where: { types: [older.type] }, limit: 1 }).length === 1)
  check('listEvents where: nothing given tests nothing', listEvents({ where: { types: [], priorities: null, cameras: [], acked: null }, limit: 1000 }).length === everything.length)
  // a JS test reads a bounded number of rows, and says when it stopped short
  const cut = listEvents({ keep: () => false, maxScan: 1 })
  check('listEvents keep: stops at maxScan and says so', cut.length === 0 && cut.scanLimited === true)
  check('... and does not say so when it read everything', listEvents({ keep: () => false }).scanLimited !== true)
  const byCam = await handleAlarms('GET', `/api/alarms?from=0&cameras=${older.nvr}/${older.ch}&priorities=${older.priority}`, json({}), who)
  check('the route: camera and priority filters still hold', byCam[1].alarms.length > 0 && byCam[1].alarms.every((x) => x.nvr === older.nvr && x.ch === older.ch && x.priority === older.priority) && byCam[1].scanLimited === false)
  const byText = await handleAlarms('GET', '/api/alarms?from=0&text=gate', json({}), who)
  check('the route: the text search still finds a camera by its name', byText[1].alarms.length > 0 && byText[1].alarms.every((x) => /gate/i.test(`${x.camera} ${x.detail ?? ''} ${x.typeLabel} ${x.subtype ?? ''} ${x.ackNote ?? ''}`)))
  // the text search is narrowed by the database first, and must find exactly what it found before
  for (const text of ['gate', 'GATE', labelOf(older.type).split(' ')[0], `${older.nvr}/${older.ch}`, 'no-such-word-anywhere', '100%', 'a_b', 'é']) {
    const got = await handleAlarms('GET', `/api/alarms?from=0&text=${encodeURIComponent(text)}`, json({}), who)
    const want = filterAlarms(nameCameras(everything, who.cameras()), { text }).map((x) => x.id).sort((x, y) => x - y)
    check(`the route: text "${text}" finds what a search of every row finds`, JSON.stringify(got[1].alarms.map((x) => x.id).sort((x, y) => x - y)) === JSON.stringify(want), `${got[1].alarms.length} vs ${want.length}`)
  }

  // rights: a viewer who may see no camera sees no alarm, and cannot act on one by its id
  const blind = { user: 'carol', admin: false, cameras: who.cameras, now: who.now, canSee: () => false }
  const none = await handleAlarms('GET', '/api/alarms?from=0', json({}), blind)
  check('a camera the viewer may not see: its alarms are not listed', none[0] === 200 && none[1].alarms.length === 0, `${none[1].alarms?.length}`)
  const someId = listed[1].alarms[0].id
  check('... nor acknowledged, opened as a clip or bookmarked by id (404, as if absent)', (await handleAlarms('POST', `/api/alarms/${someId}/ack`, json({ note: 'x' }), blind))[0] === 404 && (await handleAlarms('GET', `/api/alarms/${someId}/clip`, json({}), blind))[0] === 404)
  const onlyGate = { ...blind, canSee: (nvr, ch) => nvr === 'nvr1' && ch === 0 }
  const some = await handleAlarms('GET', '/api/alarms?from=0', json({}), onlyGate)
  check('may see one camera: only that camera\'s alarms', some[1].alarms.length > 0 && some[1].alarms.every((a) => a.nvr === 'nvr1' && a.ch === 0))

  const target = listed[1].alarms.find((a) => !a.ackMs)
  const acked = await handleAlarms('POST', `/api/alarms/${target.id}/ack`, json({ note: 'seen' }), who)
  check('acknowledging through the route works', acked[0] === 200 && acked[1].alarm.ackUser === 'alice')
  check('acknowledging twice is a 409', (await handleAlarms('POST', `/api/alarms/${target.id}/ack`, json({ note: 'x' }), who))[0] === 409)
  check('a viewer cannot take an acknowledgement back', (await handleAlarms('POST', `/api/alarms/${target.id}/unack`, json({}), { user: 'bob', admin: false }))[0] === 403)
  check('an admin can', (await handleAlarms('POST', `/api/alarms/${target.id}/unack`, json({}), who))[0] === 200)
  check('a note that is too long is a 400', (await handleAlarms('POST', `/api/alarms/${target.id}/ack`, json({ note: 'x'.repeat(600) }), who))[0] === 400)
  check('acknowledging by GET is not allowed', (await handleAlarms('GET', `/api/alarms/${target.id}/ack`, json({}), who))[0] === 405)

  const clip = await handleAlarms('GET', `/api/alarms/${target.id}/clip`, json({}), who)
  check('the clip route gives the export dialog its times', clip[0] === 200 && clip[1].clip.endMs > clip[1].clip.startMs)
  check('a clip for an alarm that is not there is a 404', (await handleAlarms('GET', '/api/alarms/999999/clip', json({}), who))[0] === 404)

  const bm = await handleAlarms('POST', `/api/alarms/${target.id}/bookmark`, json({ title: 'Fox in the yard' }), who)
  check('bookmarking an alarm works when bookmarks are there', bm[0] === 201 && bm[1].bookmark.title === 'Fox in the yard', JSON.stringify(bm[1]))
  check('and the bookmark covers the alarm with margin', bm[1].bookmark.startMs < target.startMs)

  const viewer = { user: 'bob', admin: false, cameras: () => [] }
  check('a viewer can read the rules on cameras they may see', (await handleAlarms('GET', '/api/alarms/rules', json({}), viewer))[0] === 200)
  check('but not make one', (await handleAlarms('POST', '/api/alarms/rules', json({ name: 'x' }), viewer))[0] === 403)
  const made = await handleAlarms('POST', '/api/alarms/rules', json({ name: 'Gate at night', types: ['motion'], priority: 'high' }), who)
  check('an admin can', made[0] === 201 && made[1].rule.name === 'Gate at night')
  check('a bad rule is a 400', (await handleAlarms('POST', '/api/alarms/rules', json({ name: '' }), who))[0] === 400)
  check('a rule can be read back', (await handleAlarms('GET', `/api/alarms/rules/${made[1].rule.id}`, json({}), who))[1].rule.priority === 'high')
  check('patched', (await handleAlarms('PATCH', `/api/alarms/rules/${made[1].rule.id}`, json({ notify: true }), who))[1].rule.notify === true)
  check('and deleted', (await handleAlarms('DELETE', `/api/alarms/rules/${made[1].rule.id}`, json({}), who))[1].deleted === true)
  check('a viewer cannot delete one', (await handleAlarms('DELETE', '/api/alarms/rules/1', json({}), viewer))[0] === 403)
  check('a rule that is not there is a 404', (await handleAlarms('GET', '/api/alarms/rules/99999', json({}), who))[0] === 404)
  check('bad JSON is a 400, not a 500', (await handleAlarms('POST', '/api/alarms/rules', async () => { throw new SyntaxError('bad') }, who))[0] === 400)

  // rights: a rule on cameras a viewer may not see is not theirs to read (it says which cameras raise
  // alarms, and when nobody is watching)
  const hidden = await handleAlarms('POST', '/api/alarms/rules', json({ name: 'Far yard', cameras: ['rigginglot/2'], types: ['motion'], notify: true, schedule: [{ days: [1], from: '22:00', to: '06:00' }] }), who)
  const mixed = await handleAlarms('POST', '/api/alarms/rules', json({ name: 'Gate and far yard', cameras: ['nvr1/0', 'rigginglot/2'], types: ['motion'] }), who)
  const anyCam = await handleAlarms('POST', '/api/alarms/rules', json({ name: 'Anything', types: ['motion'] }), who)
  const gateOnly = { user: 'carol', admin: false, cameras: () => [], canSee: (nvr, ch) => nvr === 'nvr1' && ch === 0 }
  const seen = (await handleAlarms('GET', '/api/alarms/rules', json({}), gateOnly))[1].rules
  check('a rule on cameras the viewer may not see is not listed', !seen.some((r) => r.id === hidden[1].rule.id))
  check('... nor read by its id (404)', (await handleAlarms('GET', `/api/alarms/rules/${hidden[1].rule.id}`, json({}), gateOnly))[0] === 404)
  check('a rule on some of their cameras shows only those', JSON.stringify(seen.find((r) => r.id === mixed[1].rule.id)?.cameras) === '["nvr1/0"]')
  check('... by its id too', JSON.stringify((await handleAlarms('GET', `/api/alarms/rules/${mixed[1].rule.id}`, json({}), gateOnly))[1].rule?.cameras) === '["nvr1/0"]')
  check('a rule on any camera is still listed', seen.some((r) => r.id === anyCam[1].rule.id))
  check('no camera key the viewer may not see appears anywhere', !JSON.stringify(seen).includes('rigginglot'))
  check('an admin still sees the whole rule', (await handleAlarms('GET', `/api/alarms/rules/${mixed[1].rule.id}`, json({}), who))[1].rule.cameras.length === 2)
  for (const r of [hidden, mixed, anyCam]) await handleAlarms('DELETE', `/api/alarms/rules/${r[1].rule.id}`, json({}), who)

  // FAIL CLOSED: a caller that forgets the canSee hook entirely (left out of deps, not passed as
  // () => true) must get nothing for a non-admin, never every camera's alarms and rules.
  const forgot = { user: 'carol', admin: false, cameras: () => [] } // no canSee at all
  const noneDefault = await handleAlarms('GET', '/api/alarms?from=0', json({}), forgot)
  check('a forgotten canSee hook: a non-admin sees no alarms, not all of them', noneDefault[0] === 200 && noneDefault[1].alarms.length === 0, `${noneDefault[1].alarms?.length}`)
  check('...nor acknowledged, opened as a clip or bookmarked by id (404, as if absent)', (await handleAlarms('POST', `/api/alarms/${someId}/ack`, json({ note: 'x' }), forgot))[0] === 404 && (await handleAlarms('GET', `/api/alarms/${someId}/clip`, json({}), forgot))[0] === 404)
  const onCam = await handleAlarms('POST', '/api/alarms/rules', json({ name: 'Gate rule', cameras: ['nvr1/0'], types: ['motion'] }), who)
  const anyCam2 = await handleAlarms('POST', '/api/alarms/rules', json({ name: 'Any camera rule', types: ['motion'] }), who)
  const rulesForgot = (await handleAlarms('GET', '/api/alarms/rules', json({}), forgot))[1].rules
  check('a forgotten canSee hook: a rule naming a camera is hidden, not shown as if any camera', !rulesForgot.some((r) => r.id === onCam[1].rule.id))
  check('...a rule naming no camera at all is still listed (it names none to hide)', rulesForgot.some((r) => r.id === anyCam2[1].rule.id))
  for (const r of [onCam, anyCam2]) await handleAlarms('DELETE', `/api/alarms/rules/${r[1].rule.id}`, json({}), who)
}

// source-shape: server.mjs always hands handleAlarms a canSee (the same one events, bookmarks and
// maps get), rather than leaving it out and falling on the fail-closed default
{
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  check(
    'server.mjs passes handleAlarms a canSee hook',
    /handleAlarms\(req\.method, pathname \+ url\.search, \(\) => readJsonObject\(req, 8192\), \{ user, admin: who\.admin, cameras: allCameras, canSee \}\)/.test(server)
  )
}

// --- the page's pure view code --------------------------------------------------------------------------
{
  const rows = alarmRows([
    { id: 1, camera: 'Gate', type: 'motion', subtype: '', priority: 'critical', startMs: T0, endMs: T0 + 5 * S, ackMs: null },
    { id: 2, camera: 'Yard', type: 'line-crossing', subtype: 'tripwire', priority: 'low', startMs: T0 - MIN, endMs: null, ackMs: T0, ackUser: 'bob', ackNote: 'fox' }
  ], { now: T0 + 5 * MIN })
  check('every alarm becomes a row', rows.length === 2)
  check('the kind is put into words', rows[0].what === labelOf('motion'), rows[0].what)
  check('a subtype is shown beside it', rows[1].what === 'Line crossing (tripwire)', rows[1].what)
  check('an unacknowledged row is marked as needing someone', rows[0].needsAck === true && rows[1].needsAck === false)
  check('an acknowledged row says who and what they said', /bob/.test(rows[1].ack) && /fox/.test(rows[1].ack), rows[1].ack)
  check('one still open is not given a made-up length', rows[1].lasted === null)
  check('one that ended is', rows[0].lasted === '5 s', rows[0].lasted)
  check('the priority is carried through for the colour', rows[0].priority === 'critical')

  check('a moment ago reads as such', timeAgo(T0, T0 + 30 * S) === 'just now', timeAgo(T0, T0 + 30 * S))
  check('minutes read as minutes', timeAgo(T0, T0 + 5 * MIN) === '5 min ago')
  check('hours read as hours', timeAgo(T0, T0 + 3 * 3_600_000) === '3 h ago')
  check('days read as days', timeAgo(T0, T0 + 2 * 86_400_000) === '2 days ago')

  check('the filter line says what is being shown', /3 of 10/.test(filterSummary({ total: 10, unacked: 3 }, { acked: false })), filterSummary({ total: 10, unacked: 3 }, { acked: false }))
  check('an empty list says so plainly', /nothing/i.test(filterSummary({ total: 0, unacked: 0 }, {})))

  const summary = ruleSummary({ name: 'Yard at night', cameras: ['nvr1/3'], types: ['motion'], priority: 'high', notify: true, schedule: [{ days: [5], from: '22:00', to: '06:00' }] })
  check('a rule reads as a sentence', /Motion/.test(summary) && /Yard|nvr1\/3/.test(summary), summary)
  check('and says it notifies', /notif/i.test(summary), summary)
  check('a rule with no limits says so', /any camera/i.test(ruleSummary({ name: 'x', cameras: [], types: [], priority: 'low' })), ruleSummary({ name: 'x', cameras: [], types: [], priority: 'low' }))
}

// --- line crossings fold together --------------------------------------------------------------------------
//
// One crossing reaches the store twice: the alarm watcher files it within seconds, and the recording
// list finds the NVR's recording of it minutes later, a few seconds earlier (pre-record) and often
// with both line bits. Somebody walking along a line also crosses it several times in a few seconds.
// A line crossing starting within 30 s of another on the same camera is folded into it; nothing else
// ever is.
{
  check('the fold window is 30 s', MERGE_MS === 30_000, String(MERGE_MS))
  const B = T0 + 500 * MIN
  const lc = (o) => ({ nvr: 'nvr5', ch: 2, type: 'line-crossing', subtype: 'tripwire', source: 'alarm-status', ...o })

  const a = addEvent(lc({ startMs: B }), B)
  check('a first crossing is a new event', a.isNew && a.event.type === 'line-crossing')
  const same = addEvent(lc({ startMs: B }), B + 5 * S)
  check('the same alarm seen again is still one row, with no end made up', !same.isNew && same.event.id === a.event.id && same.event.endMs === null, JSON.stringify(same.event))
  const rec = addEvent(lc({ subtype: 'line crossed', source: 'nvr-recordings', startMs: B - 5 * S, endMs: B + 40 * S }), B + 3 * MIN)
  check('its recording, 5 s earlier and with the other line bit, is folded in', !rec.isNew && rec.event.id === a.event.id, JSON.stringify(rec.event))
  check('... and moves the end out to the recording’s', rec.event.endMs === B + 40 * S, `${rec.event.endMs - B}`)
  check('... keeping the first sighting’s start, subtype and source', rec.event.startMs === B && rec.event.subtype === 'tripwire' && rec.event.source === 'alarm-status', JSON.stringify(rec.event))
  const edge = addEvent(lc({ startMs: B + 30 * S }), B + 4 * MIN)
  check('a crossing exactly 30 s later is still folded in', !edge.isNew && edge.event.id === a.event.id)
  check('... and never pulls the end back', edge.event.endMs === B + 40 * S, `${edge.event.endMs - B}`)

  const later = addEvent(lc({ startMs: B + 31 * S }), B + 4 * MIN)
  check('31 s later is a new event', later.isNew && later.event.id !== a.event.id)
  const between = addEvent(lc({ startMs: B + 45 * S }), B + 4 * MIN)
  check('a crossing near two events joins the nearer one', !between.isNew && between.event.id === later.event.id)
  check('... whose end grows to it', between.event.endMs === B + 45 * S, `${between.event.endMs - B}`)
  check('the camera holds two crossing events, not five', eventsOfCamera('nvr5', 2, B - MIN, B + MIN).length === 2)

  // Somebody already looked at it: its recording turning up later must not make a fresh alarm.
  acknowledge(a.event.id, 'bob', 'a walker', B + 5 * MIN)
  const afterAck = addEvent(lc({ subtype: 'line crossed', source: 'nvr-recordings', startMs: B + 2 * S, endMs: B + 50 * S }), B + 6 * MIN)
  check('an acknowledged crossing still takes its recording', !afterAck.isNew && afterAck.event.id === a.event.id && afterAck.event.ackNote === 'a walker' && afterAck.event.endMs === B + 50 * S)

  // Nothing else folds: other kinds, other cameras, other NVRs.
  const m1 = addEvent({ nvr: 'nvr5', ch: 2, type: 'motion', startMs: B + 2 * S, source: 'x' }, B + 6 * MIN)
  const m2 = addEvent({ nvr: 'nvr5', ch: 2, type: 'motion', startMs: B + 4 * S, source: 'x' }, B + 6 * MIN)
  check('motion beside a crossing is its own event', m1.isNew)
  check('motion never folds into motion', m2.isNew && m2.event.id !== m1.event.id)
  const mot = addEvent({ nvr: 'nvr5', ch: 3, type: 'motion', startMs: B, source: 'x' }, B + 6 * MIN)
  const lone = addEvent(lc({ ch: 3, startMs: B + 5 * S }), B + 6 * MIN)
  check('a crossing beside only a motion event is its own event', lone.isNew && lone.event.id !== mot.event.id)
  check('... and the motion event is left alone', getEvent(mot.event.id).endMs === null && getEvent(mot.event.id).type === 'motion')
  check('a crossing on another camera is its own event', addEvent(lc({ ch: 4, startMs: B + S }), B + 6 * MIN).isNew)
  check('... and on another NVR', addEvent(lc({ nvr: 'nvr6', startMs: B + S }), B + 6 * MIN).isNew)
}

// A recorded file folds into a crossing when the file's time [start, end] overlaps that crossing's own
// start ± 30 s (the alarm's start as stored), not only when the two starts are within 30 s: a file
// already open for motion starts long before the alarm, and one crossing must stay one event, one
// phone alert and one snapshot. Never by touching an end that an earlier fold moved out: back-to-back
// files would chain into the first crossing, and the later crossings in them (the intake is the
// fallback for crossings the watcher missed) would get no alert, bookmark or snapshot. The alarm
// watcher's own rows keep the start-to-start rule, so a long file's end never swallows the alert of a
// later crossing the camera raised afresh.
{
  const C = T0 + 700 * MIN
  const lc = (o) => ({ nvr: 'nvr7', ch: 1, type: 'line-crossing', subtype: 'tripwire', source: 'alarm-status', ...o })
  const rec = (o) => lc({ subtype: 'line crossed', source: 'nvr-recordings', ...o })
  const w = addEvent(lc({ startMs: C }), C)
  // the file [C - 3 min, C + 60 s] with motion and a line bit (0x4 | 0x400): two rows, as the intake files them
  const early = addEvent(rec({ startMs: C - 180 * S, endMs: C + 60 * S }), C + 3 * MIN)
  const motion = addEvent({ nvr: 'nvr7', ch: 1, type: 'motion', subtype: '', startMs: C - 180 * S, endMs: C + 60 * S, source: 'nvr-recordings' }, C + 3 * MIN)
  check('a recording that started 3 min before the alarm (a file open for motion) folds into the watcher’s crossing', !early.isNew && early.event.id === w.event.id, JSON.stringify(early.event))
  check('... keeping the alarm’s start, its end moved out to the file’s', early.event.startMs === C && early.event.endMs === C + 60 * S, JSON.stringify(early.event))
  check('... while that file’s motion row is an event of its own', motion.isNew && motion.event.type === 'motion')
  const apart = addEvent(rec({ startMs: C + 300 * S, endMs: C + 330 * S }), C + 7 * MIN)
  check('a recorded crossing well clear of it is its own event', apart.isNew && apart.event.id !== w.event.id)
  check('the camera holds two crossings and one motion event', eventsOfCamera('nvr7', 1, C - 5 * MIN, C + 10 * MIN).map((e) => e.type).sort().join() === 'line-crossing,line-crossing,motion')
  // the edges of the window: a file ending 25 s before the alarm, or starting 25 s after it, is the same crossing
  const E = T0 + 800 * MIN
  const w2 = addEvent(lc({ ch: 5, startMs: E }), E)
  check('a file ending 25 s before the alarm’s start folds in (the alarm’s start ± 30 s)', addEvent(rec({ ch: 5, startMs: E - 3 * MIN, endMs: E - 25 * S }), E + 3 * MIN).event.id === w2.event.id)
  check('... and one starting 25 s after it', addEvent(rec({ ch: 5, startMs: E + 25 * S, endMs: E + 2 * MIN }), E + 4 * MIN).event.id === w2.event.id)
  check('... but one ending 31 s before it is its own event', addEvent(rec({ ch: 6, startMs: E - 3 * MIN, endMs: E - 31 * S }), E + 3 * MIN).isNew && addEvent(lc({ ch: 6, startMs: E }), E + 3 * MIN).isNew)

  const D = T0 + 900 * MIN
  const first = addEvent(lc({ ch: 2, startMs: D }), D)
  const long = addEvent(rec({ ch: 2, startMs: D - 5 * S, endMs: D + 40 * MIN }), D + 3 * MIN)
  check('a 40 min file folds into the crossing it started with', !long.isNew && long.event.id === first.event.id && long.event.endMs === D + 40 * MIN)
  const later = addEvent(lc({ ch: 2, startMs: D + 10 * MIN }), D + 10 * MIN)
  check('... but a crossing the watcher sees 10 min into that file is still its own event (its own alert)', later.isNew && later.event.id !== first.event.id)
}

// Regression (re-review of F3): back-to-back recorded files must not chain into the first crossing
// through the end each earlier fold moved out.
{
  const T = T0 + 1000 * MIN
  const rec = (o) => ({ nvr: 'nvr8', type: 'line-crossing', subtype: 'tripwire', source: 'nvr-recordings', ...o })
  // A: two back-to-back files, no watcher row
  const a1 = addEvent(rec({ ch: 1, startMs: T, endMs: T + 10 * MIN }), T + 11 * MIN)
  const a2 = addEvent(rec({ ch: 1, startMs: T + 10 * MIN + S, endMs: T + 20 * MIN }), T + 21 * MIN)
  check('A: a file is a new event, and the next back-to-back file is a new event too (its own alert)', a1.isNew && a2.isNew && a2.event.id !== a1.event.id, JSON.stringify([a1.event, a2.event].map((e) => [e.id, e.startMs - T, e.endMs - T])))
  check('A: the first keeps its own end', getEvent(a1.event.id).endMs === T + 10 * MIN)
  // B: a watcher crossing at T, then three back-to-back files: only the one covering its start folds in
  const w = addEvent({ nvr: 'nvr8', ch: 2, type: 'line-crossing', subtype: 'tripwire', startMs: T, source: 'alarm-status' }, T)
  const b1 = addEvent(rec({ ch: 2, startMs: T - 3 * MIN, endMs: T + 60 * S }), T + 5 * MIN)
  const b2 = addEvent(rec({ ch: 2, startMs: T + 61 * S, endMs: T + 5 * MIN }), T + 6 * MIN)
  const b3 = addEvent(rec({ ch: 2, startMs: T + 5 * MIN + S, endMs: T + 9 * MIN }), T + 10 * MIN)
  check('B: the file covering the watcher crossing’s start folds into it', !b1.isNew && b1.event.id === w.event.id && getEvent(w.event.id).endMs === T + 60 * S, JSON.stringify(getEvent(w.event.id)))
  check('B: the later back-to-back files are new events, not chained into it', b2.isNew && b3.isNew && new Set([w.event.id, b2.event.id, b3.event.id]).size === 3, JSON.stringify([b2, b3].map((r) => [r.isNew, r.event.id, r.event.startMs - T])))
  check('B: the camera holds three crossings: 0-60 s, 61 s-5 min, 5 min 1 s-9 min',
    eventsOfCamera('nvr8', 2, T - 5 * MIN, T + 10 * MIN).map((e) => `${(e.startMs - T) / S}-${(e.endMs - T) / S}`).join() === '0-60,61-300,301-540',
    eventsOfCamera('nvr8', 2, T - 5 * MIN, T + 10 * MIN).map((e) => `${(e.startMs - T) / S}-${(e.endMs - T) / S}`).join())
}

closeEvents()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
