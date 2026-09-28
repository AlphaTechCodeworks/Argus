// Offline tests for what a line crossing does (line-actions.mjs): the "Line crossing" alarm rule
// switched per camera, the ntfy topic made once and never logged, the automatic bookmark and its
// merging, the link in the message and the publicUrl setting behind it, and the
// POST /api/admin/lines/alert route. Temp data folder only; no NVR, nothing is sent anywhere.
// settings.mjs loads the SDK (through nvr-xml.mjs), so this runs on the server copy.
//   node cctv/test/line-actions.test.mjs
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-line-actions-test-'))
const DATA = process.env.DATA_DIR
writeFileSync(join(DATA, 'users.json'), JSON.stringify({ alice: { hash: 'x', role: 'admin' }, bob: { hash: 'x', role: 'viewer' } }))

const {
  AUTO_USER, BOOKMARK_POST_S, BOOKMARK_PRE_S, LINE_RULE_NAME, LINE_TYPE, RULE_MIN_GAP_S, RULE_PRIORITY,
  autoBookmark, ensureNtfyTopic, eventLink, handleLineAlert, lineRuleCameras, newTopic, onLineCrossing, setLineAlert
} = await import('../line-actions.mjs')
const { addEvent, closeEvents, listRules, updateRule } = await import('../events-db.mjs')
const { applyRules } = await import('../event-rules.mjs')
const { SETTINGS_FILE, getSettings, saveSettings } = await import('../settings.mjs')
const { CLIP_POST_S, CLIP_PRE_S, makeAlarmNotifier } = await import('../alarms.mjs')
const bookmarks = await import('../bookmarks.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const S = 1000
const MIN = 60 * S
const T = Date.parse('2026-09-27T14:00:00Z')
const json = (o) => async () => o
const statusOf = (fn) => {
  try {
    fn()
    return null
  } catch (e) {
    return e.status ?? e.message
  }
}
const crossing = (nvr, ch, startMs, extra = {}) => ({ nvr, ch, type: LINE_TYPE, subtype: 'tripwire', startMs, ...extra })
const rulesNamed = () => listRules().filter((r) => r.name === LINE_RULE_NAME)

// Everything printed while `fn` runs, so a secret can be looked for in it afterwards.
const said = []
const listen = async (fn) => {
  const saved = {}
  for (const m of ['log', 'warn', 'error', 'info']) {
    saved[m] = console[m]
    console[m] = (...a) => {
      said.push(a.map(String).join(' '))
      saved[m](...a)
    }
  }
  try {
    return await fn()
  } finally {
    Object.assign(console, saved)
  }
}
/** Every file in the data folder except settings.json that contains `text` (the database included). */
const filesWith = (text) => readdirSync(DATA)
  .filter((f) => f !== 'settings.json' && !f.startsWith('settings.json.tmp') && statSync(join(DATA, f)).isFile())
  .filter((f) => readFileSync(join(DATA, f)).includes(text))

// ---- the alarm rule ------------------------------------------------------------------------------
{
  check('no rule yet: no camera alerts', lineRuleCameras().length === 0)
  check('switching a camera off with no rule makes no rule', setLineAlert('nvr-2/2', false, 'alice') === null && rulesNamed().length === 0)

  const made = setLineAlert('nvr-2/2', true, 'alice', { now: T })
  check('switching the first camera on makes the rule', made?.name === LINE_RULE_NAME && rulesNamed().length === 1, JSON.stringify(made))
  check('  for line crossings only', made.types.length === 1 && made.types[0] === LINE_TYPE)
  check('  notifying, high priority, 30 s quiet gap, any time of day',
    made.notify === true && made.priority === RULE_PRIORITY && RULE_PRIORITY === 'high' && made.minGapS === RULE_MIN_GAP_S && RULE_MIN_GAP_S === 30 && made.schedule.length === 0)
  check('  enabled, for that camera alone, made by who asked', made.enabled === true && made.cameras.join() === 'nvr-2/2' && made.user === 'alice')
  check('the camera is listed as alerting', lineRuleCameras().join() === 'nvr-2/2')
  check('a crossing on it notifies', applyRules(listRules(), crossing('nvr-2', 2, T)).notify === true)
  check('  at high priority', applyRules(listRules(), crossing('nvr-2', 2, T)).priority === 'high')
  check('a crossing on another camera does not', applyRules(listRules(), crossing('nvr-2', 3, T)).notify === false)
  check('motion on the same camera does not', applyRules(listRules(), { nvr: 'nvr-2', ch: 2, type: 'motion', startMs: T }).notify === false)

  const again = setLineAlert('nvr-2/2', true, 'alice', { now: T })
  check('switching the same camera on twice lists it once', again.cameras.join() === 'nvr-2/2' && rulesNamed().length === 1)
  const two = setLineAlert('nvr-2/5', true, 'bob', { now: T })
  check('a second camera joins the same rule', two.id === made.id && two.cameras.join() === 'nvr-2/2,nvr-2/5' && rulesNamed().length === 1, two.cameras.join())
  const one = setLineAlert('nvr-2/2', false, 'alice', { now: T })
  check('switching one off leaves the other, still enabled', one.cameras.join() === 'nvr-2/5' && one.enabled === true)

  // An empty camera list means every camera to the rules: an enabled empty rule would alert on all.
  const none = setLineAlert('nvr-2/5', false, 'alice', { now: T })
  check('switching the last camera off disables the rule', none.enabled === false && none.cameras.length === 0 && none.id === made.id)
  check('  so a crossing on any camera notifies nobody', applyRules(listRules(), crossing('nvr1', 7, T)).notify === false)
  check('  and no camera is listed', lineRuleCameras().length === 0)
  const back = setLineAlert('nvr-2/2', true, 'alice', { now: T })
  check('switching one on again re-enables the same rule', back.id === made.id && back.enabled === true && back.cameras.join() === 'nvr-2/2')

  // what an admin changed on the Alarms page is theirs to keep
  updateRule(made.id, { priority: 'critical', minGapS: 120 }, T)
  const kept = setLineAlert('nvr-2/4', true, 'alice', { now: T })
  check('an admin’s own priority and quiet gap survive a camera being added', kept.priority === 'critical' && kept.minGapS === 120)
  updateRule(made.id, { enabled: false }, T)
  check('a rule an admin switched off lists no camera', lineRuleCameras().length === 0)
  const stillOff = setLineAlert('nvr-2/4', false, 'alice', { now: T })
  check('  and taking a camera out does not switch it back on', stillOff.enabled === false && stillOff.cameras.join() === 'nvr-2/2')
  const onAgain = setLineAlert('nvr-2/4', true, 'alice', { now: T })
  check('  switching a camera on does, notify included', onAgain.enabled === true && onAgain.notify === true && lineRuleCameras().join() === 'nvr-2/2,nvr-2/4')
  updateRule(made.id, { priority: 'high', minGapS: 30 }, T)

  check('a camera that is not "<nvr>/<ch>" is refused (400)', statusOf(() => setLineAlert('nvr-2', true, 'alice')) === 400)
  check('  nor a channel that is not a number', statusOf(() => setLineAlert('nvr-2/two', true, 'alice')) === 400)
}

// ---- the ntfy topic ------------------------------------------------------------------------------
{
  const t = newTopic()
  check('a topic is "argus-" and 20 lower-case letters and digits', /^argus-[a-z0-9]{20}$/.test(t), t.length)
  check('  which the topic setting accepts (8 to 64 of A-Z a-z 0-9 - _)', /^[A-Za-z0-9_-]{8,64}$/.test(t))
  const many = new Set(Array.from({ length: 2000 }, () => newTopic()))
  check('  and is different every time', many.size === 2000)

  check('no topic to begin with', getSettings().alerts.ntfy.topic === '')
  const first = await listen(() => ensureNtfyTopic('alice'))
  check('with none set, one is made', first.created === true && /^argus-[a-z0-9]{20}$/.test(first.topic))
  check('  and saved in the settings', getSettings().alerts.ntfy.topic === first.topic)
  const second = await listen(() => ensureNtfyTopic('alice'))
  check('with one set, it is kept', second.created === false && second.topic === first.topic)
  check('the topic was not printed', !said.some((l) => l.includes(first.topic)), said.join(' | '))
  check('  nor written anywhere but settings.json (audit trail, database)', filesWith(first.topic).length === 0, filesWith(first.topic).join())
  check('  but the settings change itself was audited', readFileSync(join(DATA, 'audit.jsonl'), 'utf8').includes('"settings-change"'))

  saveSettings({ alerts: { ntfy: { topic: 'owners-own-topic-2024' } } }, 'alice')
  const own = ensureNtfyTopic('alice')
  check('a topic the owner chose is never replaced', own.created === false && own.topic === 'owners-own-topic-2024' && getSettings().alerts.ntfy.topic === 'owners-own-topic-2024')
  saveSettings({ alerts: { ntfy: { topic: '' } } }, 'alice')
}

// ---- the link and the publicUrl setting --------------------------------------------------------------
{
  check('publicUrl defaults to the site’s address', getSettings().publicUrl === 'https://cctv.jfl.gripe')
  check('an event’s link opens the Alarms page at it', eventLink(12) === 'https://cctv.jfl.gripe/alarms.html#event=12', eventLink(12))
  check('  an id given as text works the same', eventLink('12') === 'https://cctv.jfl.gripe/alarms.html#event=12')
  check('  something that is not an event id gives no link', [0, -1, 1.5, 'x', null, undefined].every((v) => eventLink(v) === ''))

  saveSettings({ publicUrl: 'https://example.org/argus/' }, 'alice')
  check('a trailing slash is dropped when saved', getSettings().publicUrl === 'https://example.org/argus')
  check('  and a path is kept in the link', eventLink(5) === 'https://example.org/argus/alarms.html#event=5', eventLink(5))
  const refused = (v) => statusOf(() => saveSettings({ publicUrl: v }, 'alice')) === 400
  check('not an address: refused', refused('not an address'))
  check('not http(s): refused', refused('ftp://example.org') && refused('javascript:alert(1)'))
  check('a user name or password in it: refused', refused('https://u:p@example.org'))
  check('a ? or #: refused (the link is made by adding to it)', refused('https://example.org/?a=1') && refused('https://example.org/#top'))
  check('not text: refused', refused(42) && refused(null))
  check('too long: refused', refused(`https://example.org/${'a'.repeat(200)}`))
  check('  and a refused value changes nothing', getSettings().publicUrl === 'https://example.org/argus')
  saveSettings({ publicUrl: '' }, 'alice')
  check('empty is allowed and means no link', getSettings().publicUrl === '' && eventLink(5) === '')

  // a bad value put in the file by hand costs that value only
  const j = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
  writeFileSync(SETTINGS_FILE, JSON.stringify({ ...j, publicUrl: 'javascript:alert(1)', thumbnails: '1m' }))
  const s = getSettings()
  check('a bad publicUrl in the file falls back to the default', s.publicUrl === 'https://cctv.jfl.gripe' && s.thumbnails === '1m', s.publicUrl)
  saveSettings({ publicUrl: 'https://cctv.jfl.gripe', thumbnails: 'off' }, 'alice')
}

// ---- the route -------------------------------------------------------------------------------------
{
  check('the topic is empty again before the route is tried', getSettings().alerts.ntfy.topic === '')
  const known = (nvr, ch) => nvr === 'nvr-2' && ch >= 0 && ch < 32
  const post = (body) => handleLineAlert('POST', json(body), 'alice', { knownCamera: known })

  check('GET is not allowed', (await handleLineAlert('GET', json({}), 'alice'))[0] === 405)
  check('no NVR: 400', (await post({ ch: 2, on: true }))[0] === 400)
  check('a channel below 0: 400', (await post({ nvr: 'nvr-2', ch: -1, on: true }))[0] === 400)
  check('a channel as text: 400', (await post({ nvr: 'nvr-2', ch: '2', on: true }))[0] === 400)
  check('"on" that is not true or false: 400', (await post({ nvr: 'nvr-2', ch: 2, on: 'yes' }))[0] === 400)
  check('a camera the server does not have: 404', (await post({ nvr: 'nvr-9', ch: 2, on: true }))[0] === 404)
  check('bad JSON: 400', (await handleLineAlert('POST', async () => { throw new SyntaxError('bad') }, 'alice'))[0] === 400)
  check('nothing refused made a topic', getSettings().alerts.ntfy.topic === '')

  said.length = 0
  const [st, body] = await listen(() => post({ nvr: 'nvr-2', ch: 6, on: true }))
  check('switching a camera on answers 200', st === 200, JSON.stringify(body))
  check('  with the rule, the camera in it', body.rule?.name === LINE_RULE_NAME && body.rule.cameras.includes('nvr-2/6') && body.rule.enabled === true)
  check('  and the new topic, for the panel to show how to subscribe', body.ntfy?.created === true && /^argus-[a-z0-9]{20}$/.test(body.ntfy.topic) && body.ntfy.url === 'https://ntfy.sh', JSON.stringify(body.ntfy))
  check('  the topic is in the settings', getSettings().alerts.ntfy.topic === body.ntfy.topic)
  check('  and was not printed', !said.some((l) => l.includes(body.ntfy.topic)), said.join(' | '))
  check('  nor written to the audit trail or the database', filesWith(body.ntfy.topic).length === 0, filesWith(body.ntfy.topic).join())
  const auditRows = readFileSync(join(DATA, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  check('  the switch is audited: who, which camera, on', auditRows.some((r) => r.user === 'alice' && r.target === 'nvr-2/6' && r.detail === 'line-crossing phone alert on'))

  const [, body2] = await post({ nvr: 'nvr-2', ch: 7, on: true })
  check('a second camera: the same topic, not made again', body2.ntfy.created === false && body2.ntfy.topic === body.ntfy.topic && body2.rule.cameras.includes('nvr-2/7'))
  const [st3, body3] = await post({ nvr: 'nvr-2', ch: 6, on: false })
  check('switching off takes the camera out', st3 === 200 && !body3.rule.cameras.includes('nvr-2/6') && body3.rule.cameras.includes('nvr-2/7'))
  check('  and leaves the topic alone', body3.ntfy.created === false && getSettings().alerts.ntfy.topic === body.ntfy.topic)
}

// ---- footage kept: the automatic bookmark ---------------------------------------------------------
{
  check('the stretch is the same as a hand-made alarm bookmark', BOOKMARK_PRE_S === CLIP_PRE_S && BOOKMARK_POST_S === CLIP_POST_S && BOOKMARK_PRE_S === 30 && BOOKMARK_POST_S === 60)
  const now = T + 5 * MIN
  const nameOf = (key) => ({ 'nvr-2/2': 'Maingate Roadway' })[key] ?? key
  const opts = { store: bookmarks, nameOf, now, log: () => {} }

  const first = await autoBookmark(crossing('nvr-2', 2, T), opts)
  check('a crossing is bookmarked', first.ok && first.merged === false, JSON.stringify(first))
  check('  30 s before to 60 s after', first.bookmark.startMs === T - 30 * S && first.bookmark.endMs === T + 60 * S)
  check('  of that camera alone, filed under "system"', first.bookmark.cameras.join() === 'nvr-2/2' && first.bookmark.user === AUTO_USER && AUTO_USER === 'system')
  check('  named after the camera', first.bookmark.title === 'Line crossing — Maingate Roadway', first.bookmark.title)
  check('  and kept from housekeeping', bookmarks.protectedRanges(T - MIN, T + MIN).some(([a, b]) => a <= T - 30 * S && b >= T + 60 * S))

  const later = await autoBookmark(crossing('nvr-2', 2, T + 40 * S), opts)
  check('a crossing whose stretch overlaps stretches the same bookmark', later.ok && later.merged === true && later.bookmark.id === first.bookmark.id)
  check('  to cover both', later.bookmark.startMs === T - 30 * S && later.bookmark.endMs === T + 100 * S, `${later.bookmark.startMs - T} ${later.bookmark.endMs - T}`)
  const same = await autoBookmark(crossing('nvr-2', 2, T + 40 * S), opts)
  check('the same crossing seen again changes nothing', same.merged === true && same.bookmark.id === first.bookmark.id && same.bookmark.endMs === T + 100 * S)
  const grown = await autoBookmark(crossing('nvr-2', 2, T + 40 * S, { endMs: T + 70 * S }), opts)
  check('a crossing that grew (an end time) stretches it past its end', grown.bookmark.id === first.bookmark.id && grown.bookmark.endMs === T + 130 * S)
  const apart = await autoBookmark(crossing('nvr-2', 2, T + 10 * MIN), opts)
  check('a crossing long after gets a bookmark of its own', apart.ok && apart.merged === false && apart.bookmark.id !== first.bookmark.id)
  check('  and the first one is untouched', bookmarks.getBookmark(first.bookmark.id).endMs === T + 130 * S)
  const other = await autoBookmark(crossing('nvr-2', 3, T), opts)
  check('another camera at the same moment gets its own', other.ok && other.merged === false && other.bookmark.cameras.join() === 'nvr-2/3' && other.bookmark.title === 'Line crossing — nvr-2/3')

  // somebody's own bookmark is theirs: never stretched by a crossing
  const hers = bookmarks.createBookmark({ cameras: ['nvr-2/9'], startMs: T, endMs: T + MIN, title: 'Van at the gate' }, 'alice', { now })
  const nearHers = await autoBookmark(crossing('nvr-2', 9, T + 20 * S), opts)
  check('a person’s bookmark on that camera is not stretched', nearHers.merged === false && nearHers.bookmark.id !== hers.bookmark.id && bookmarks.getBookmark(hers.bookmark.id).endMs === T + MIN)

  // a stretch past the 24 hours a bookmark may cover starts a new one instead
  const long = bookmarks.createBookmark({ cameras: ['nvr-2/11'], startMs: T - 24 * 3600 * S + 45 * S, endMs: T + 30 * S, title: 'Line crossing — nvr-2/11' }, AUTO_USER, { now })
  check('(a nearly 24-hour automatic bookmark to stretch)', long.ok, long.error)
  const past = await autoBookmark(crossing('nvr-2', 11, T), opts)
  check('stretching past 24 hours starts a new bookmark', past.ok && past.merged === false && past.bookmark.id !== long.bookmark.id && past.bookmark.startMs === T - 30 * S)
  check('  and leaves the long one as it was', bookmarks.getBookmark(long.bookmark.id).endMs === T + 30 * S)

  const noStart = await autoBookmark({ nvr: 'nvr-2', ch: 2, type: LINE_TYPE }, opts)
  check('an event with no start time is not bookmarked', noStart.ok === false)
}

// ---- one crossing ------------------------------------------------------------------------------------
{
  const calls = { bookmark: [], snapshot: [] }
  const logs = []
  const deps = {
    bookmark: async (e, o) => {
      calls.bookmark.push({ e, o })
      return { ok: true, bookmark: { id: 1 }, merged: false }
    },
    snapshot: async (e) => {
      calls.snapshot.push(e)
      return `/data/event-snaps/${e.id}.jpg`
    },
    nameOf: (key) => key,
    log: (l) => logs.push(l)
  }
  const ev = { id: 501, ...crossing('nvr-2', 2, T) }

  const ignored = await onLineCrossing({ id: 500, nvr: 'nvr-2', ch: 2, type: 'motion', startMs: T }, deps)
  check('an event of another kind is ignored', ignored.bookmark === null && ignored.snapshot === null && calls.bookmark.length === 0 && calls.snapshot.length === 0)
  check('  and so is nothing at all', (await onLineCrossing(null, deps)).bookmark === null)

  const r1 = await onLineCrossing(ev, deps)
  check('a crossing is bookmarked', calls.bookmark.length === 1 && calls.bookmark[0].e === ev && calls.bookmark[0].o.nameOf === deps.nameOf && r1.bookmark?.ok === true)
  check('  and its snapshot is taken', (await r1.snapshot) === '/data/event-snaps/501.jpg' && calls.snapshot.length === 1 && calls.snapshot[0] === ev)
  const r2 = await onLineCrossing({ ...ev, endMs: T + 20 * S }, deps)
  check('the same event again (it grew) is bookmarked again, for the merge', calls.bookmark.length === 2)
  check('  but its snapshot is not taken twice', r2.snapshot === null && calls.snapshot.length === 1)

  const failing = {
    ...deps,
    bookmark: async () => { throw new Error('database locked') },
    snapshot: async () => { throw new Error('ffmpeg missing') }
  }
  const r3 = await onLineCrossing({ id: 502, ...crossing('nvr-2', 2, T + MIN) }, failing)
  check('a bookmark that fails does not stop the snapshot', r3.bookmark === null && r3.snapshot !== null)
  check('  a snapshot that fails comes back empty, not thrown', (await r3.snapshot) === null)
  check('  and both are logged', logs.some((l) => /database locked/.test(l)) && logs.some((l) => /ffmpeg missing/.test(l)), logs.join(' | '))
  const refused = await onLineCrossing({ id: 503, ...crossing('nvr-2', 2, T) }, { ...deps, bookmark: async () => ({ ok: false, error: 'no store' }) })
  check('a bookmark refused is logged too', refused.bookmark?.ok === false && logs.some((l) => /no store/.test(l)))
  check('no snapshot function: no snapshot', (await onLineCrossing({ id: 504, ...crossing('nvr-2', 2, T) }, { bookmark: deps.bookmark, log: () => {} })).snapshot === null)

  // with nothing injected: the real automatic bookmark
  const near = Date.now() - MIN
  await onLineCrossing({ id: 505, ...crossing('nvr-2', 20, near) }, { log: () => {} })
  const made = bookmarks.listBookmarks({ camera: 'nvr-2/20' })
  check('by default a crossing makes the real automatic bookmark', made.length === 1 && made[0].user === AUTO_USER && made[0].startMs === near - 30 * S, JSON.stringify(made))
}

// ---- the alert, end to end through the rule -------------------------------------------------------
{
  setLineAlert('nvr-2/2', true, 'alice')
  const sent = []
  const notifier = makeAlarmNotifier({
    sender: { deliver: async (alerts, kind) => sent.push({ alerts, kind }) },
    tzOffsetMin: () => -240,
    nameOf: (key) => (key === 'nvr-2/2' ? 'Maingate Roadway' : key),
    linkOf: (row) => eventLink(row.id),
    log: () => {}
  })
  const at = Date.now() - 5 * S
  const { event } = addEvent({ ...crossing('nvr-2', 2, at), source: 'alarm-status' }, at)
  await notifier.handle(event)
  await new Promise((r) => setImmediate(r))
  const msg = sent[0]?.alerts[0]
  check('a crossing on a switched-on camera sends an alert', sent.length === 1 && sent[0].kind === 'opened', JSON.stringify(sent))
  check('  titled with what and the camera’s name', msg?.title === 'Line crossing (tripwire) — Maingate Roadway', msg?.title)
  check('  with the site time and the rule', msg?.detail.startsWith(`at ${new Date(at - 240 * MIN).toISOString().slice(11, 19)} · rule: ${LINE_RULE_NAME}`), msg?.detail)
  check('  and the link to the event on its own line', msg?.detail.split('\n')[1] === `https://cctv.jfl.gripe/alarms.html#event=${event.id}`, msg?.detail)
  check('  at high urgency', msg?.severity === 'high')
  const { event: soon } = addEvent({ ...crossing('nvr-2', 2, at + 10 * S), source: 'alarm-status' }, at + 10 * S)
  await notifier.handle(soon)
  await new Promise((r) => setImmediate(r))
  check('a second crossing inside 30 s is kept but not sent', sent.length === 1)
}

closeEvents()
bookmarks.closeBookmarks()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
