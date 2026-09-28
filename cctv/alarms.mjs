// The Alarms page's server side: the prioritised list, acknowledging, the rules that decide how
// urgent an event is and who gets told, and the handoffs to bookmarks and to export.
//
// An alarm is an event (events-db.mjs) that the rules gave a priority to. There is no separate
// alarm table and no moment at which an event "becomes" an alarm; see the note at the top of
// events-db.mjs for why splitting them would mean deciding the same thing twice.
//
// Notification reuses phase 1's delivery exactly as it stands: alert-send.mjs makeSender() takes a
// list of { key, kind, title, detail, severity } and a kind of 'opened' or 'cleared', and handles
// its own retries and its own failure reporting. event-rules.alarmMessage() shapes an alarm into
// that, so nothing in alert-send.mjs had to change to carry alarms as well as health alerts.
//
// Bookmarks are imported defensively. bookmarks.mjs opens the recordings database and is expected
// to be there, but the Alarms page must still draw on a server where it is not: a missing bookmark
// button is a nuisance, an Alarms page that will not load because of one is an outage.
//
//
// WIRING (the one thing still to do by hand). This phase adds no line to server.mjs, so the routes
// below are not reachable until somebody adds two lines to it, beside the existing handleClocks
// call. They return [status, body] (optionally headers) or null, exactly like handleClocks, so:
//
//   import { handleEvents } from './events.mjs'
//   import { handleAlarms } from './alarms.mjs'
//   ...inside handleRequest, beside the other handlers:
//   const ev = await handleEvents(req.method, pathname + url.search, () => readJsonObject(req, 4096),
//     { nvrs, user, admin: AUTH_OFF || auth.isAdmin(user), intake: null })
//   if (ev) return sendJson(res, ...ev)
//   const al = await handleAlarms(req.method, pathname + url.search, () => readJsonObject(req, 8192),
//     { user, admin: AUTH_OFF || auth.isAdmin(user), cameras: allCameras })
//   if (al) return sendJson(res, ...al)
//
// Event intake, the notifier and the window feed are already started by nvrs.mjs startNvrs().
//   GET    /api/alarms?from=&to=&types=&cameras=&priorities=&acked=&text=   (everyone signed in)
//   POST   /api/alarms/:id/ack        { note }         -> { alarm }
//   POST   /api/alarms/:id/unack                       -> { alarm }   (admins: undo a mis-click)
//   POST   /api/alarms/:id/bookmark   { title?, description? } -> { bookmark }
//   GET    /api/alarms/:id/clip                        -> the times the export dialog should open on
//   GET    /api/alarms/rules                           -> { rules }
//   POST   /api/alarms/rules          { ...rule }      -> 201 { rule }   (admins)
//   PATCH  /api/alarms/rules/:id      { ...fields }    -> { rule }       (admins)
//   DELETE /api/alarms/rules/:id                       -> { deleted: true } (admins)
import {
  acknowledge, classify, createRule, deleteRule, getEvent, getRule,
  listEvents, listRules, noteNotified, unacknowledge, updateRule
} from './events-db.mjs'
import {
  alarmMessage, applyRules, cameraKey, checkAck, eventWindow,
  filterAlarms, labelOf, prioritise, summarise, withinQuietGap
} from './event-rules.mjs'

const NO_STORE = { 'cache-control': 'no-store' }
/** How far back the page looks when nothing else is asked for. */
export const DEFAULT_WINDOW_MS = 7 * 86_400_000
/** Seconds either side of an alarm that a bookmark or an export starts out covering. */
export const CLIP_PRE_S = 30
export const CLIP_POST_S = 60

// Number(null) and Number('') are both 0, and a 0 nobody asked for is a window that ends at the
// epoch: a missing parameter has to come back as null, never as a number.
const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : null)
/** A query-string tri-state: "true", "false", or absent meaning "either". */
const tri = (v) => (v === 'true' ? true : v === 'false' ? false : null)

/**
 * The names cameras are known by, so the list reads "Cashier Front" rather than "nvr1/3".
 * `cameras` is whatever the server already has (allCameras()); a camera it does not know keeps its
 * key, which is still true and still findable.
 */
export function nameCameras(alarms, cameras) {
  const names = new Map()
  for (const c of cameras ?? []) names.set(cameraKey(c.nvr ?? c.nvrId, c.ch), c.name)
  return alarms.map((a) => ({ ...a, camera: names.get(cameraKey(a.nvr, a.ch)) ?? cameraKey(a.nvr, a.ch), typeLabel: labelOf(a.type) }))
}

// ---- classifying and notifying -------------------------------------------------------------------

/**
 * The bridge from an event arriving to somebody's phone buzzing.
 *
 * Called with each newly stored event (events.mjs makeEventIntake passes it as onEvent). It asks
 * the rules what to make of it, writes that onto the row, and — only if a rule said so — hands it
 * to the phase 1 sender.
 *
 * Two gates stand between an event and a notification, because the failure mode here is not
 * missing a message, it is a hundred messages at 3 a.m. and a phone that gets muted for ever:
 *   - the rule's own quiet gap (minGapS), kept per rule and camera
 *   - the row's notified_ms, so the same alarm is never sent twice whatever happens upstream
 *
 * @param {object} deps
 * @param {{deliver: Function}} deps.sender      alert-send.mjs makeSender()
 * @param {() => object[]} [deps.rules]          the rules, read fresh so an edit takes effect at once
 * @param {() => number} [deps.tzOffsetMin]      site wall-clock offset, for rule schedules
 * @param {(key: string) => string} [deps.nameOf]
 * @param {(row: object) => string} [deps.linkOf]  the event's address in Argus for the message
 *   (line-actions.mjs eventLink, passed in by nvrs.mjs: importing it here would load settings.mjs
 *   and with it the SDK, and this module's tests run without one); '' leaves the link out
 */
export function makeAlarmNotifier({ sender, rules = listRules, tzOffsetMin = () => 0, nameOf = null, linkOf = () => '', now = Date.now, log = console.log }) {
  /** "<ruleId>|<camera>" -> when we last sent for it */
  const lastSent = new Map()

  return {
    /** Classifies one event and sends it on if a rule asked for that. @returns {object} the stored row */
    async handle(event) {
      const verdict = applyRules(rules(), event, { tzOffsetMin: tzOffsetMin() })
      const row = classify(event.id, { priority: verdict.priority, ruleId: verdict.rule?.id ?? null, ruleName: verdict.rule?.name ?? null }) ?? event
      if (!verdict.notify || row.notifiedMs) return row

      const nowMs = now()
      const gateKey = `${verdict.rule?.id ?? '-'}|${cameraKey(row.nvr, row.ch)}`
      if (withinQuietGap(verdict.rule, lastSent.get(gateKey), nowMs)) return row
      lastSent.set(gateKey, nowMs)

      const named = nameOf ? { ...row, camera: nameOf(cameraKey(row.nvr, row.ch)) } : row
      // A link that cannot be made (settings unreadable) costs the link, never the alert.
      let link = ''
      try {
        link = String(linkOf(row) ?? '')
      } catch (e) {
        log(`[alarms] no link for alarm ${row.id}: ${e?.message ?? e}`)
      }
      // Fire and forget, like the health alerts: delivery has its own retries and a slow mail
      // server must never hold up the poll that found the event.
      void Promise.resolve(sender.deliver([alarmMessage(named, { ruleName: verdict.rule?.name ?? '', link, tzOffsetMin: tzOffsetMin() })], 'opened'))
        .catch((e) => log(`[alarms] could not deliver: ${e?.message ?? e}`))
      noteNotified(row.id, nowMs)
      return { ...row, notifiedMs: nowMs }
    }
  }
}

// ---- bookmarks and export ------------------------------------------------------------------------

/**
 * The stretch of footage an alarm points at: the alarm itself with a little either side, because
 * the useful part of an incident starts before whatever triggered it.
 */
export function clipOf(alarm, { preS = CLIP_PRE_S, postS = CLIP_POST_S } = {}) {
  const [startMs, endMs] = eventWindow(alarm, { preS, postS }) ?? [alarm.startMs, alarm.startMs]
  return {
    cameras: [cameraKey(alarm.nvr, alarm.ch)],
    startMs,
    endMs,
    title: `${labelOf(alarm.type)}${alarm.subtype ? ` (${alarm.subtype})` : ''} — ${alarm.camera ?? cameraKey(alarm.nvr, alarm.ch)}`
  }
}

/**
 * Bookmarks an alarm, if bookmarks are available on this server.
 * The import is inside the function and inside a try: a build without bookmarks.mjs, or one where
 * it cannot open the database, loses the button and nothing else.
 */
export async function bookmarkAlarm(alarm, raw, user) {
  let bookmarks
  try {
    bookmarks = await import('./bookmarks.mjs')
  } catch (e) {
    return { ok: false, status: 501, error: `Bookmarks are not available on this server (${String(e?.message ?? e).slice(0, 80)})` }
  }
  if (typeof bookmarks.createBookmark !== 'function') {
    return { ok: false, status: 501, error: 'Bookmarks are not available on this server' }
  }
  const clip = clipOf(alarm)
  const res = bookmarks.createBookmark({
    cameras: clip.cameras,
    startMs: clip.startMs,
    endMs: clip.endMs,
    title: String(raw?.title ?? clip.title).slice(0, 120),
    description: String(raw?.description ?? alarm.detail ?? '')
  }, user)
  return res.ok ? { ok: true, bookmark: res.bookmark } : { ok: false, status: 400, error: res.error }
}

// ---- the routes ------------------------------------------------------------------------------------

const ACK = /^\/api\/alarms\/(\d+)\/ack$/
const UNACK = /^\/api\/alarms\/(\d+)\/unack$/
const BOOKMARK = /^\/api\/alarms\/(\d+)\/bookmark$/
const CLIP = /^\/api\/alarms\/(\d+)\/clip$/
const RULE = /^\/api\/alarms\/rules\/(\d+)$/

/**
 * All the alarm routes. Same shape as handleClocks in nvr-probe.mjs — [status, body] with optional
 * headers, or null when the path is not one of these — so server.mjs wires it in with one line and
 * needs to know nothing about what is in here.
 *
 * @param {string} method
 * @param {string} pathname   with or without its query string
 * @param {() => Promise<object>} readJson
 * @param {{user?: string, admin?: boolean, cameras?: Function, now?: number}} deps
 * @returns {Promise<[number, object, object?] | null>}
 */
export async function handleAlarms(method, pathname, readJson, deps = {}) {
  const [path, search = ''] = String(pathname ?? '').split('?')
  if (!path.startsWith('/api/alarms')) return null
  const { user = null, admin = false, cameras = () => [], now = Date.now(), canSee = () => true } = deps
  // an alarm on a camera this user may not see does not exist for them (rights.mjs, via server.mjs)
  const visible = (row) => Boolean(row) && canSee(row.nvr, row.ch)
  // A rule names cameras. One about cameras this user may not see is not theirs to read: it says
  // which cameras raise alarms and when nobody is watching. Cameras they may not see are left out of
  // the rest. An empty list means every camera, so a rule stripped down to none would read as "any
  // camera": it is dropped instead, as is a damaged one (its camera list could not be read, so it
  // reads as empty). Admins edit rules and see them whole.
  const ruleFor = (rule) => {
    if (admin || !rule) return rule
    if (rule.damaged) return null
    if (!rule.cameras.length) return rule
    const cameras = rule.cameras.filter((k) => {
      const slash = String(k).lastIndexOf('/')
      return slash > 0 && canSee(k.slice(0, slash), Number(k.slice(slash + 1)))
    })
    return cameras.length ? { ...rule, cameras } : null
  }
  if (!user) return [401, { error: 'Not signed in' }, NO_STORE]

  try {
    // ---- the rules
    if (path === '/api/alarms/rules') {
      if (method === 'GET') return [200, { rules: listRules().map(ruleFor).filter(Boolean), admin }, NO_STORE]
      if (method === 'POST') {
        if (!admin) return [403, { error: 'Only an admin can change alarm rules' }, NO_STORE]
        const res = createRule(await readJson(), user, now)
        return res.ok ? [201, { rule: res.rule }, NO_STORE] : [400, { error: res.error }, NO_STORE]
      }
      return [405, { error: 'Method not allowed' }, { allow: 'GET, POST' }]
    }
    const ruleId = RULE.exec(path)
    if (ruleId) {
      if (method === 'GET') {
        const rule = ruleFor(getRule(ruleId[1]))
        return rule ? [200, { rule }, NO_STORE] : [404, { error: 'No such rule' }, NO_STORE]
      }
      if (!admin) return [403, { error: 'Only an admin can change alarm rules' }, NO_STORE]
      if (method === 'PATCH') {
        const res = updateRule(Number(ruleId[1]), await readJson(), now)
        return res.ok ? [200, { rule: res.rule }, NO_STORE] : [res.status ?? 400, { error: res.error }, NO_STORE]
      }
      if (method === 'DELETE') {
        const res = deleteRule(Number(ruleId[1]))
        return res.ok ? [200, { deleted: true }, NO_STORE] : [res.status, { error: res.error }, NO_STORE]
      }
      return [405, { error: 'Method not allowed' }, { allow: 'GET, PATCH, DELETE' }]
    }

    // ---- one alarm
    const ack = ACK.exec(path)
    if (ack) {
      if (method !== 'POST') return [405, { error: 'Method not allowed' }, { allow: 'POST' }]
      if (!visible(getEvent(Number(ack[1])))) return [404, { error: 'No such alarm' }, NO_STORE]
      const checked = checkAck(await readJson())
      if (!checked.ok) return [400, { error: checked.error }, NO_STORE]
      const res = acknowledge(Number(ack[1]), user, checked.value.note, now)
      return res.ok ? [200, { alarm: nameCameras([res.event], cameras())[0] }, NO_STORE] : [res.status, { error: res.error }, NO_STORE]
    }
    const unack = UNACK.exec(path)
    if (unack) {
      if (method !== 'POST') return [405, { error: 'Method not allowed' }, { allow: 'POST' }]
      // Undoing somebody else's account of an incident is an admin's job, not a viewer's.
      if (!admin) return [403, { error: 'Only an admin can take an acknowledgement back' }, NO_STORE]
      const res = unacknowledge(Number(unack[1]))
      return res.ok ? [200, { alarm: nameCameras([res.event], cameras())[0] }, NO_STORE] : [res.status, { error: res.error }, NO_STORE]
    }
    const clip = CLIP.exec(path)
    if (clip) {
      if (method !== 'GET') return [405, { error: 'Method not allowed' }, { allow: 'GET' }]
      const row = getEvent(Number(clip[1]))
      if (!visible(row)) return [404, { error: 'No such alarm' }, NO_STORE]
      // The times only. Exporting itself stays entirely in export-api.mjs; this route exists so the
      // page can open the export dialog already filled in, without a second way to make an export.
      return [200, { clip: clipOf(nameCameras([row], cameras())[0]) }, NO_STORE]
    }
    const bm = BOOKMARK.exec(path)
    if (bm) {
      if (method !== 'POST') return [405, { error: 'Method not allowed' }, { allow: 'POST' }]
      const row = getEvent(Number(bm[1]))
      if (!visible(row)) return [404, { error: 'No such alarm' }, NO_STORE]
      const res = await bookmarkAlarm(nameCameras([row], cameras())[0], await readJson(), user)
      return res.ok ? [201, { bookmark: res.bookmark }, NO_STORE] : [res.status, { error: res.error }, NO_STORE]
    }

    // ---- the list
    if (path === '/api/alarms') {
      if (method !== 'GET') return [405, { error: 'Method not allowed' }, { allow: 'GET' }]
      const p = new URLSearchParams(search)
      const fromMs = num(p.get('from')) ?? now - DEFAULT_WINDOW_MS
      const toMs = num(p.get('to')) ?? now
      const rows = nameCameras(listEvents({ fromMs, toMs, limit: num(p.get('limit')) ?? 500 }).filter(visible), cameras())
      const filtered = filterAlarms(rows, {
        types: list(p.get('types')),
        cameras: list(p.get('cameras')),
        priorities: list(p.get('priorities')),
        acked: tri(p.get('acked')),
        text: p.get('text') ?? ''
      })
      const { sourceReport } = await import('./events.mjs')
      return [200, {
        alarms: prioritise(filtered),
        summary: summarise(filtered),
        window: { fromMs, toMs },
        user,
        admin,
        // Printed under the filters, so the page states plainly what it cannot report rather than
        // letting an empty list imply that nothing happened.
        sources: sourceReport()
      }, NO_STORE]
    }

    return null
  } catch (e) {
    if (e instanceof SyntaxError) return [400, { error: 'Bad JSON' }]
    console.error(`[alarms] ${e?.stack ?? e}`)
    return [500, { error: 'The alarm list could not be read' }]
  }
}
