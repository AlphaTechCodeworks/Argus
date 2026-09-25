// Where events and alarm rules are kept: the `events` and `alarm_rules` tables of the recordings
// database (data/recordings.db, declared in rec-index.mjs).
//
// Its own connection, for the same reason bookmarks.mjs keeps one: the index's connection lives in
// nvrs.mjs, which loads the native SDK, and nothing in phase 7 may depend on that. These rules and
// this table have to be openable on a Windows machine with no SDK at all, which is where the tests
// run. SQLite in WAL mode is content with several connections in one process.
//
// An event and an alarm are the same row. There is no separate "alarm" table because there is no
// moment at which an event becomes an alarm: the rules give every event a priority as it arrives,
// and the Alarms page is a view of the rows worth a human's attention. Splitting them would mean
// deciding twice and being able to disagree with ourselves.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DATA_DIR } from './auth.mjs'
import { EVENTS_SCHEMA } from './rec-index.mjs'
import { DEFAULT_PRIORITY, PRIORITIES, checkRule } from './event-rules.mjs'

export const EVENTS_DB = join(DATA_DIR, 'recordings.db')
/** One page of results. A guard against a runaway query, not a paging scheme. */
export const MAX_RESULTS = 1000

const EV_COLS = `id, nvr, ch, type, subtype, start_ms AS startMs, end_ms AS endMs, source, detail,
  priority, rule_id AS ruleId, rule_name AS ruleName, notified_ms AS notifiedMs,
  ack_ms AS ackMs, ack_user AS ackUser, ack_note AS ackNote, seen_ms AS seenMs`
const RULE_COLS = `id, name, enabled, cameras, types, schedule, priority, notify,
  min_gap_s AS minGapS, user, created_ms AS createdMs, updated_ms AS updatedMs`

let db = null
let q = null

/** The connection, opened on first use. The schema statement only ever creates what is missing. */
function open(file = EVENTS_DB) {
  if (db) return q
  mkdirSync(dirname(file), { recursive: true })
  db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  db.exec(EVENTS_SCHEMA)
  q = {
    // OR IGNORE: intake re-reads stretches it has already read, and the same event seen twice must
    // stay one row with its acknowledgement intact (see the schema note in rec-index.mjs).
    add: db.prepare(`INSERT OR IGNORE INTO events
      (nvr, ch, type, subtype, start_ms, end_ms, source, detail, priority, rule_id, rule_name, seen_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    find: db.prepare(`SELECT ${EV_COLS} FROM events WHERE nvr = ? AND ch = ? AND type = ? AND subtype = ? AND start_ms = ?`),
    byId: db.prepare(`SELECT ${EV_COLS} FROM events WHERE id = ?`),
    // The window query is the only filter with an index behind it; the rest are applied in JS by
    // event-rules.filterAlarms, which the page uses on the same data.
    inWindow: db.prepare(`SELECT ${EV_COLS} FROM events WHERE start_ms >= ? AND start_ms <= ? ORDER BY start_ms DESC LIMIT ?`),
    ofCamera: db.prepare(`SELECT ${EV_COLS} FROM events WHERE nvr = ? AND ch = ? AND start_ms >= ? AND start_ms <= ? ORDER BY start_ms`),
    unacked: db.prepare(`SELECT ${EV_COLS} FROM events WHERE ack_ms IS NULL ORDER BY start_ms DESC LIMIT ?`),
    ack: db.prepare('UPDATE events SET ack_ms = ?, ack_user = ?, ack_note = ? WHERE id = ?'),
    unack: db.prepare('UPDATE events SET ack_ms = NULL, ack_user = NULL, ack_note = NULL WHERE id = ?'),
    extend: db.prepare('UPDATE events SET end_ms = ? WHERE id = ? AND (end_ms IS NULL OR end_ms < ?)'),
    noteSent: db.prepare('UPDATE events SET notified_ms = ? WHERE id = ?'),
    classify: db.prepare('UPDATE events SET priority = ?, rule_id = ?, rule_name = ? WHERE id = ?'),
    lastOf: db.prepare('SELECT MAX(start_ms) AS m FROM events WHERE nvr = ? AND ch = ?'),
    lastOfNvr: db.prepare('SELECT MAX(start_ms) AS m FROM events WHERE nvr = ?'),
    forget: db.prepare('DELETE FROM events WHERE start_ms < ? AND ack_ms IS NULL'),
    rules: db.prepare(`SELECT ${RULE_COLS} FROM alarm_rules ORDER BY id`),
    ruleById: db.prepare(`SELECT ${RULE_COLS} FROM alarm_rules WHERE id = ?`),
    ruleAdd: db.prepare(`INSERT INTO alarm_rules (name, enabled, cameras, types, schedule, priority, notify, min_gap_s, user, created_ms, updated_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    ruleSet: db.prepare(`UPDATE alarm_rules SET name = ?, enabled = ?, cameras = ?, types = ?, schedule = ?,
      priority = ?, notify = ?, min_gap_s = ?, updated_ms = ? WHERE id = ?`),
    ruleDrop: db.prepare('DELETE FROM alarm_rules WHERE id = ?')
  }
  return q
}

/** Opens the store somewhere else (the tests use a temp file). Closes any existing connection. */
export function useEventsDb(file) {
  closeEvents()
  open(file)
}

/** Closes the connection (tests, and a clean shutdown). The next call opens it again. */
export function closeEvents() {
  db?.close()
  db = null
  q = null
}

const plain = (r) => (r === undefined || r === null ? null : { ...r })
const jsonList = (text, what) => {
  try {
    const v = JSON.parse(text)
    return Array.isArray(v) ? v : []
  } catch {
    // A damaged rule is reported as matching nothing rather than as matching everything: an empty
    // camera list means "all cameras", so silently turning damage into [] would widen the rule.
    console.warn(`[events] a rule's ${what} could not be read; the rule is disabled until it is saved again`)
    return null
  }
}

/** A stored rule as the rest of the app uses it, with its JSON columns read back. */
function toRule(row) {
  if (!row) return null
  const cameras = jsonList(row.cameras, 'cameras')
  const types = jsonList(row.types, 'types')
  const schedule = jsonList(row.schedule, 'schedule')
  const damaged = cameras === null || types === null || schedule === null
  return {
    id: row.id,
    name: row.name,
    // A rule we could not read is never treated as enabled, whatever the column says.
    enabled: !damaged && row.enabled === 1,
    cameras: cameras ?? [],
    types: types ?? [],
    schedule: schedule ?? [],
    priority: PRIORITIES.includes(row.priority) ? row.priority : DEFAULT_PRIORITY,
    notify: row.notify === 1,
    minGapS: row.minGapS ?? 0,
    user: row.user ?? null,
    createdMs: row.createdMs,
    updatedMs: row.updatedMs,
    ...(damaged ? { damaged: true } : {})
  }
}

// ---- events ------------------------------------------------------------------------------------

/**
 * Records one event, or returns the row already there.
 * @param {{nvr, ch, type, subtype?, startMs, endMs?, source?, detail?, priority?, ruleId?, ruleName?}} e
 * @returns {{ event: object, isNew: boolean }}
 */
export function addEvent(e, nowMs = Date.now()) {
  const s = open()
  const subtype = String(e.subtype ?? '')
  const start = Math.round(Number(e.startMs))
  const res = s.add.run(
    String(e.nvr), Number(e.ch), String(e.type), subtype, start,
    Number.isFinite(Number(e.endMs)) ? Math.round(Number(e.endMs)) : null,
    String(e.source ?? ''), String(e.detail ?? ''),
    PRIORITIES.includes(e.priority) ? e.priority : DEFAULT_PRIORITY,
    Number.isFinite(Number(e.ruleId)) ? Number(e.ruleId) : null,
    e.ruleName ? String(e.ruleName) : null,
    Math.round(nowMs)
  )
  const row = plain(s.find.get(String(e.nvr), Number(e.ch), String(e.type), subtype, start))
  // An event we already had may have grown: the NVR keeps writing while the movement continues, so
  // the same event read an hour later has a later end. Extending it keeps one row rather than two.
  if (res.changes === 0 && row && Number.isFinite(Number(e.endMs))) {
    const end = Math.round(Number(e.endMs))
    s.extend.run(end, row.id, end)
    return { event: plain(s.byId.get(row.id)), isNew: false }
  }
  return { event: row, isNew: res.changes === 1 }
}

/** One event by id, or null. */
export const getEvent = (id) => plain(open().byId.get(Number(id)))

/** Events starting inside [fromMs, toMs], newest first. */
export function listEvents({ fromMs = null, toMs = null, limit = MAX_RESULTS } = {}) {
  const s = open()
  const cap = Math.min(Math.max(1, Math.floor(Number(limit) || MAX_RESULTS)), MAX_RESULTS)
  return s.inWindow.all(
    Number.isFinite(fromMs) ? Math.round(fromMs) : -8.64e15,
    Number.isFinite(toMs) ? Math.round(toMs) : 8.64e15,
    cap
  ).map(plain)
}

/** One camera's events in [fromMs, toMs], oldest first — what the recorder's windows are built from. */
export function eventsOfCamera(nvr, ch, fromMs, toMs) {
  return open().ofCamera.all(String(nvr), Number(ch), Math.round(fromMs), Math.round(toMs)).map(plain)
}

/** Everything still waiting for a human, newest first. */
export const unackedEvents = (limit = MAX_RESULTS) => open().unacked.all(Math.min(limit, MAX_RESULTS)).map(plain)

/**
 * Acknowledges an event: who looked at it, when, and what they made of it.
 * Acknowledging twice is not an error, but it does not overwrite the first person's note either —
 * the first account of an incident is the one worth keeping.
 * @returns {{ ok: true, event: object } | { ok: false, status: number, error: string }}
 */
export function acknowledge(id, user, note, nowMs = Date.now()) {
  const s = open()
  const n = Number(id)
  if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, status: 400, error: 'That is not an alarm id' }
  const row = plain(s.byId.get(n))
  if (!row) return { ok: false, status: 404, error: 'No such alarm' }
  if (row.ackMs) return { ok: false, status: 409, error: `${row.ackUser ?? 'somebody'} already acknowledged this one` }
  s.ack.run(Math.round(nowMs), String(user), String(note ?? ''), n)
  return { ok: true, event: plain(s.byId.get(n)) }
}

/** Takes an acknowledgement back (an admin correcting a mis-click). */
export function unacknowledge(id) {
  const s = open()
  const n = Number(id)
  const row = plain(s.byId.get(n))
  if (!row) return { ok: false, status: 404, error: 'No such alarm' }
  s.unack.run(n)
  return { ok: true, event: plain(s.byId.get(n)) }
}

/**
 * Records what the rules made of an event: its urgency and which rule decided that.
 * Kept on the row rather than worked out again when the page is drawn, so an alarm still says why
 * it was urgent after somebody has edited or deleted the rule that made it so.
 */
export function classify(id, { priority, ruleId = null, ruleName = null }) {
  const s = open()
  s.classify.run(PRIORITIES.includes(priority) ? priority : DEFAULT_PRIORITY, Number.isFinite(Number(ruleId)) ? Number(ruleId) : null, ruleName ? String(ruleName) : null, Number(id))
  return plain(s.byId.get(Number(id)))
}

/** Marks that a notification went out for this event (so it is never sent twice). */
export function noteNotified(id, nowMs = Date.now()) {
  open().noteSent.run(Math.round(nowMs), Number(id))
}

/**
 * The newest event time we hold for a camera (or a whole NVR), so a poll can ask for what it has
 * not seen instead of re-reading a month. null when there is nothing yet.
 */
export const lastEventMs = (nvr, ch = null) => {
  const s = open()
  const row = ch === null ? s.lastOfNvr.get(String(nvr)) : s.lastOf.get(String(nvr), Number(ch))
  return Number.isFinite(row?.m) ? row.m : null
}

/**
 * Drops events older than `beforeMs`. Acknowledged ones are kept: somebody wrote down what
 * happened, and that note is the record of it. Called from the same nightly job that prunes alerts.
 */
export function forgetEventsBefore(beforeMs) {
  open().forget.run(Math.round(beforeMs))
}

// ---- rules -------------------------------------------------------------------------------------

/** Every rule, in the order they were made. */
export const listRules = () => open().rules.all().map(toRule)

/** One rule, or null. */
export const getRule = (id) => toRule(open().ruleById.get(Number(id)))

/** Creates a rule from a checked body. @returns {{ok:true,rule}|{ok:false,error}} */
export function createRule(raw, user, nowMs = Date.now()) {
  const checked = checkRule(raw)
  if (!checked.ok) return checked
  const v = checked.value
  const s = open()
  const res = s.ruleAdd.run(
    v.name, v.enabled ? 1 : 0, JSON.stringify(v.cameras), JSON.stringify(v.types), JSON.stringify(v.schedule),
    v.priority, v.notify ? 1 : 0, v.minGapS, user ? String(user) : null, Math.round(nowMs), Math.round(nowMs)
  )
  return { ok: true, rule: getRule(Number(res.lastInsertRowid)) }
}

/**
 * Replaces a rule. The change is merged onto the stored rule and the whole thing checked again, so
 * switching one field off cannot leave a rule that would never have been accepted whole.
 */
export function updateRule(id, patch, nowMs = Date.now()) {
  const current = getRule(id)
  if (!current) return { ok: false, status: 404, error: 'No such rule' }
  const checked = checkRule({ ...current, ...(patch ?? {}) })
  if (!checked.ok) return { ok: false, status: 400, error: checked.error }
  const v = checked.value
  open().ruleSet.run(
    v.name, v.enabled ? 1 : 0, JSON.stringify(v.cameras), JSON.stringify(v.types), JSON.stringify(v.schedule),
    v.priority, v.notify ? 1 : 0, v.minGapS, Math.round(nowMs), Number(id)
  )
  return { ok: true, rule: getRule(id) }
}

/** Deletes a rule. Events already filed under it keep the name they were given. */
export function deleteRule(id) {
  const current = getRule(id)
  if (!current) return { ok: false, status: 404, error: 'No such rule' }
  open().ruleDrop.run(Number(id))
  return { ok: true }
}
