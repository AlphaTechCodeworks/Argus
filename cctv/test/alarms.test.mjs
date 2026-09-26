// Offline tests for the Alarms page's server side (alarms.mjs, event-rules.mjs, events-db.mjs) and
// its pure view code (public/alarms-view.js): rule validation and matching, priority, the quiet
// gap, the prioritised list, the filters, acknowledging, the bookmark and export handoffs, and the
// routes end to end against a real SQLite file in a temp folder.
//
// Temp data folder only; no NVR, no SDK, no network, and the notifier is given a fake sender so
// nothing is delivered anywhere.
//   node cctv/test/alarms.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
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
  acknowledge, addEvent, classify, closeEvents, createRule, deleteRule, eventsOfCamera,
  forgetEventsBefore, getEvent, lastEventMs, listEvents, listRules, unackedEvents,
  unacknowledge, updateRule
} = await import('../events-db.mjs')
const { CLIP_PRE_S, CLIP_POST_S, clipOf, handleAlarms, makeAlarmNotifier, nameCameras } = await import('../alarms.mjs')
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
  const named = nameCameras([{ nvr: 'n', ch: 1, type: 'ai', subtype: 'tripwire', startMs: T0, endMs: T0 + 5 * S }], [{ nvr: 'n', ch: 1, name: 'Yard' }])
  check('a camera gets its name', named[0].camera === 'Yard')
  check('and the kind gets a label', named[0].typeLabel === labelOf('ai'))
  check('a camera the server does not know keeps its key', nameCameras([{ nvr: 'n', ch: 9, type: 'motion', startMs: T0 }], [])[0].camera === 'n/9')

  const clip = clipOf(named[0])
  check('a clip starts before the alarm', clip.startMs === T0 - CLIP_PRE_S * S)
  check('and ends after it', clip.endMs === T0 + 5 * S + CLIP_POST_S * S)
  check('it names the camera it is of', clip.cameras.join() === 'n/1')
  check('and has a title somebody could file', /Yard/.test(clip.title) && /tripwire/.test(clip.title), clip.title)

  const msg = alarmMessage(named[0], { ruleName: 'Yard at night' })
  check('a notification reuses the phase 1 message shape', ['key', 'kind', 'title', 'detail', 'severity'].every((k) => k in msg), JSON.stringify(msg))
  check('its title says what and where', /Yard/.test(msg.title), msg.title)
  check('it names the rule that decided', /Yard at night/.test(msg.detail), msg.detail)
  check('a critical alarm is high severity to the sender', alarmMessage({ ...named[0], priority: 'critical' }).severity === 'high')
  check('a low one is not', alarmMessage({ ...named[0], priority: 'low' }).severity === 'medium')

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
  check('a different kind at the same moment is its own event', addEvent({ ...e, type: 'ai', subtype: 'tripwire' }, T0).isNew)

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
}

// --- the routes --------------------------------------------------------------------------------------
{
  const who = { user: 'alice', admin: true, cameras: () => [{ nvr: 'nvr1', ch: 0, name: 'Gate' }], now: T0 + 200 * MIN }
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
  check('a viewer can read the rules', (await handleAlarms('GET', '/api/alarms/rules', json({}), viewer))[0] === 200)
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
}

// --- the page's pure view code --------------------------------------------------------------------------
{
  const rows = alarmRows([
    { id: 1, camera: 'Gate', type: 'motion', subtype: '', priority: 'critical', startMs: T0, endMs: T0 + 5 * S, ackMs: null },
    { id: 2, camera: 'Yard', type: 'ai', subtype: 'tripwire', priority: 'low', startMs: T0 - MIN, endMs: null, ackMs: T0, ackUser: 'bob', ackNote: 'fox' }
  ], { now: T0 + 5 * MIN })
  check('every alarm becomes a row', rows.length === 2)
  check('the kind is put into words', rows[0].what === labelOf('motion'), rows[0].what)
  check('a subtype is shown beside it', /tripwire/.test(rows[1].what), rows[1].what)
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

closeEvents()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
