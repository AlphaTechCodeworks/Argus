// What a line crossing does once it is an event: the phone alert, the footage kept around it and
// the snapshot of what crossed. The camera does the detecting (tripwire.mjs sets its lines) and
// alarm-watch.mjs turns its alarm into an event within seconds; everything after that is here.
//
// - Phone alert: one alarm rule, "Line crossing" (type line-crossing, notify on, priority high,
//   30 s quiet gap per camera), whose cameras are the ones switched on in the Lines panel. It is an
//   ordinary rule in events-db.mjs, so the Alarms page shows it and alarms.mjs sends it; nothing
//   here sends anything itself.
// - The ntfy topic: made the first time a camera is switched on, when there is none yet. It is a
//   secret (anyone who knows it can push to the owner's phone), so it is random, never logged, and
//   saved only in settings.json (settings.mjs logs and audits which settings changed, never values).
// - Footage kept: a bookmark from 30 s before to 60 s after each crossing, filed under "system", of
//   that camera alone (a bookmark keeps the cameras it names: bookmarks.mjs protectedRanges).
//   Bookmarked stretches are never thinned or deleted by housekeeping. A crossing whose stretch
//   overlaps the camera's previous automatic bookmark stretches that one instead of adding another,
//   so a busy afternoon is one bookmark, not two hundred. Since 2026-09-30 an automatic bookmark ends:
//   it is forgotten once it ended more than its camera's days kept ago (forgetLineBookmarks, every 5
//   minutes before housekeeping), unless a person changed it, which makes it theirs (bookmarks.mjs).
// - Snapshot: handed to event-snapshot.mjs (injected by the caller), once per event.
//
//   POST /api/admin/lines/alert { nvr, ch, on }   (admins; ch 0-based, as in /api/cameras)
//        -> { rule, ntfy: { topic, created, url } }
import { randomInt } from 'node:crypto'
import { DATA_DIR } from './auth.mjs'
import { audit } from './audit.mjs'
import { createRule, listRules, updateRule } from './events-db.mjs'
import { cameraKey, eventWindow } from './event-rules.mjs'
import { HttpError, errorAnswer } from './nvr-xml.mjs'
import { AUTO_USER } from './public/bookmarks-view.js'
import { getSettings, saveSettings } from './settings.mjs'

export const LINE_RULE_NAME = 'Line crossing'
/** The event kind a crossing is filed as (public/alarms-view.js EVENT_KINDS). */
export const LINE_TYPE = 'line-crossing'
export const RULE_PRIORITY = 'high'
/** One message per camera per 30 s: a lorry and its trailer are one alert, not two. */
export const RULE_MIN_GAP_S = 30
/** The same stretch a hand-made alarm bookmark covers (alarms.mjs CLIP_PRE_S / CLIP_POST_S). */
export const BOOKMARK_PRE_S = 30
export const BOOKMARK_POST_S = 60
/**
 * Who automatic bookmarks are filed under (public/bookmarks-view.js): no person made them, so only an admin
 * may change them, and a person who does takes it over (bookmarks.mjs updateBookmark).
 */
export { AUTO_USER }
export const TOPIC_PREFIX = 'argus-'
export const TOPIC_RANDOM_CHARS = 20
const TOPIC_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const CAMERA_KEY = /^[A-Za-z0-9._-]{1,64}\/\d{1,3}$/
const NVR_ID = /^[A-Za-z0-9._-]{1,64}$/
/** Snapshots already started, by event id: the alarm is seen again every 5 s while it lasts. */
const SNAPPED_MAX = 1000
const snapped = new Set()

// ---- the alarm rule ------------------------------------------------------------------------------

/**
 * Ours: named "Line crossing" and filed for line crossings alone. A person is free to name their
 * own rule "Line crossing" too (nothing stops them, and nothing should have to) — that one is
 * matched by its types instead, so a rule of theirs with other or no types is never adopted,
 * touched or listed as ours. If it isn't, setLineAlert makes a second rule of the same name that is.
 */
const isLineRule = (r) => r.name === LINE_RULE_NAME && Array.isArray(r.types) && r.types.length === 1 && r.types[0] === LINE_TYPE

/** The "Line crossing" rule, or null. Found by name and type: see isLineRule. */
function lineRule() {
  return listRules().find(isLineRule) ?? null
}

/**
 * The cameras whose crossings alert a phone: the rule's cameras while the rule is enabled, else
 * none. A rule an admin switched off on the Alarms page alerts nobody, so it lists nobody.
 */
export function lineRuleCameras() {
  const rule = lineRule()
  return rule && rule.enabled ? [...rule.cameras] : []
}

/**
 * Puts a camera into the "Line crossing" rule, or takes it out; makes the rule the first time.
 *
 * The rule is switched off when its last camera leaves, and that is not tidiness: an empty camera
 * list means "every camera" to the rules (event-rules.mjs ruleMatches), so an enabled rule with no
 * cameras would alert on every camera's crossings. Adding a camera switches it back on, with
 * notify on, because that is what the switch in the Lines panel says it does.
 *
 * @param {string} key   "<nvr>/<ch>", ch 0-based
 * @param {boolean} on
 * @param {string} user  who asked (the rule's creator when it is made)
 * @returns {object|null} the rule as stored; null when asked to remove a camera and there is no rule
 * @throws {HttpError} 400 for a bad camera key, 500 when the rule cannot be saved
 */
export function setLineAlert(key, on, user, { now = Date.now() } = {}) {
  if (typeof key !== 'string' || !CAMERA_KEY.test(key)) throw new HttpError(400, 'camera must look like "<nvr>/<channel>"')
  const current = lineRule()
  if (!current) {
    if (!on) return null
    const made = createRule({
      name: LINE_RULE_NAME,
      enabled: true,
      cameras: [key],
      types: [LINE_TYPE],
      schedule: [],
      priority: RULE_PRIORITY,
      notify: true,
      minGapS: RULE_MIN_GAP_S
    }, user, now)
    if (!made.ok) throw new HttpError(500, `the "${LINE_RULE_NAME}" alarm rule could not be made: ${made.error}`)
    return made.rule
  }
  const cameras = on ? [...new Set([...current.cameras, key])] : current.cameras.filter((c) => c !== key)
  // Taking a camera out never switches a rule on: one an admin switched off stays off.
  const patch = on ? { cameras, enabled: true, notify: true } : { cameras, enabled: cameras.length > 0 && current.enabled }
  const res = updateRule(current.id, patch, now)
  if (!res.ok) throw new HttpError(500, `the "${LINE_RULE_NAME}" alarm rule could not be changed: ${res.error}`)
  return res.rule
}

// ---- the ntfy topic ------------------------------------------------------------------------------

/** 'argus-' and 20 random letters and digits (about 103 bits): not guessable, still typeable. */
export function newTopic() {
  let s = TOPIC_PREFIX
  for (let i = 0; i < TOPIC_RANDOM_CHARS; i++) s += TOPIC_ALPHABET[randomInt(TOPIC_ALPHABET.length)]
  return s
}

/**
 * The ntfy topic phone alerts go to, made and saved when there is none yet. An existing topic is
 * never replaced: the owner's phone is subscribed to it. Nothing here logs the topic; the settings
 * log and audit line name the part of the settings that changed ("alerts"), not its value.
 * From the moment a topic exists, the health alerts go to it too (the same alert-send.mjs sender).
 * @returns {{ topic: string, created: boolean }}
 */
export function ensureNtfyTopic(user = AUTO_USER) {
  const current = getSettings().alerts?.ntfy?.topic ?? ''
  if (current) return { topic: current, created: false }
  const topic = newTopic()
  saveSettings({ alerts: { ntfy: { topic } } }, user)
  return { topic, created: true }
}

// ---- the link in the message ---------------------------------------------------------------------

/**
 * Where an event opens in Argus from a phone: the Alarms page scrolled to it. '' when the
 * publicUrl setting is empty or the id is not an event id, and the message then has no link.
 */
export function eventLink(eventId) {
  const base = getSettings().publicUrl ?? ''
  const id = Number(eventId)
  if (!base || !Number.isSafeInteger(id) || id <= 0) return ''
  return `${base}/alarms.html#event=${id}`
}

// ---- footage kept --------------------------------------------------------------------------------

let bookmarksModule = null
/**
 * bookmarks.mjs, loaded on first use and defensively, as alarms.mjs does: a server that cannot open
 * the bookmarks table loses the automatic bookmark, not the alert.
 */
async function bookmarkStore(log) {
  try {
    bookmarksModule ??= await import('./bookmarks.mjs')
    return bookmarksModule
  } catch (e) {
    log(`[lines] bookmarks are not available: ${e?.message ?? e}`)
    return null
  }
}

/** What a new automatic bookmark says of itself (the playback page shows it): how long it lasts, and how to keep it. */
export const AUTO_DESCRIPTION = 'Kept automatically around line crossings on this camera; later crossings stretch it. It is forgotten after the camera\'s days kept, with the footage; edit it to keep it (it is then yours).'

/** One of ours: filed by "system", of this camera alone, and titled as a line crossing. */
const isAuto = (b, key) => b.user === AUTO_USER && b.cameras.length === 1 && b.cameras[0] === key && String(b.title).startsWith(LINE_RULE_NAME)

/**
 * Keeps the footage around one crossing: 30 s before to 60 s after (the event's end, when it has
 * one). If the camera's newest automatic bookmark overlaps that stretch, it is stretched to cover
 * both; otherwise a new one is made. A merged stretch that would pass the 24 hours a bookmark may
 * cover (bookmarks-view.js MAX_BOOKMARK_MS) is refused by updateBookmark, and a new one starts.
 *
 * @param {{nvr: string, ch: number, startMs: number, endMs?: number|null, camera?: string}} event
 * @param {{ store?: object, nameOf?: (key: string) => string, now?: number, log?: Function }} [opts]
 *   store: bookmarks.mjs or a stand-in with listBookmarks, createBookmark and updateBookmark
 * @returns {Promise<{ ok: true, bookmark: object, merged: boolean } | { ok: false, error: string }>}
 */
export async function autoBookmark(event, { store = null, nameOf = null, now = Date.now(), log = console.log } = {}) {
  const win = eventWindow(event, { preS: BOOKMARK_PRE_S, postS: BOOKMARK_POST_S })
  if (!win) return { ok: false, error: 'the event has no start time' }
  const s = store ?? await bookmarkStore(log)
  if (!s) return { ok: false, error: 'bookmarks are not available on this server' }
  const key = cameraKey(event.nvr, event.ch)
  const [from, to] = win.map(Math.round)
  // listBookmarks is newest first and returns those overlapping [from, to], ends included
  const prev = s.listBookmarks({ camera: key, fromMs: from, toMs: to }).find((b) => isAuto(b, key))
  if (prev) {
    const startMs = Math.min(prev.startMs, from)
    const endMs = Math.max(prev.endMs, to)
    if (startMs === prev.startMs && endMs === prev.endMs) return { ok: true, bookmark: prev, merged: true }
    const res = s.updateBookmark(prev.id, { startMs, endMs }, { user: AUTO_USER, admin: true }, { now })
    if (res.ok) return { ok: true, bookmark: res.bookmark, merged: true }
    log(`[lines] bookmark ${prev.id} not stretched (${res.error}); starting a new one`)
  }
  const name = (nameOf ? nameOf(key) : null) || event.camera || key
  const res = s.createBookmark({
    cameras: [key],
    startMs: from,
    endMs: to,
    title: `${LINE_RULE_NAME} — ${name}`.slice(0, 120),
    description: AUTO_DESCRIPTION
  }, AUTO_USER, { now })
  return res.ok ? { ok: true, bookmark: res.bookmark, merged: false } : { ok: false, error: res.error }
}

const DAY = 86_400_000
/** Automatic bookmarks forgotten a round at most (listBookmarks' cap): the next round goes on. */
export const FORGET_BATCH = 500

/**
 * Forgets the automatic line-crossing bookmarks that ended more than their camera's retentionDays ago
 * (settings.recording: the camera's own, else the default), so their footage goes with the rest; one a
 * person changed is theirs (bookmarks.mjs updateBookmark) and stays, as does anybody's own. Every 5
 * minutes, before housekeeping (server.mjs).
 *
 * Why (final fix round of the storage work, 2026-09-30): every crossing is bookmarked, and since p2
 * housekeeping never deletes bookmarked footage, so each crossing's minutes stayed past the camera's
 * days kept for good, a bookmark more every crossing (Maingate Roadway, since 2026-09-28), and every
 * deletion walk passes them at the oldest end each run. A person's bookmark is a decision about what
 * matters; an automatic one is a guess that it might, worth keeping as long as the camera's footage is.
 *
 * @param {{ store?: object, settings?: object, now?: number, log?: Function, limit?: number }} [o]
 *   store: bookmarks.mjs or a stand-in with listBookmarks and removeBookmarks
 * @returns {Promise<{ forgotten: number, newestEndMs: number|null }>}
 */
export async function forgetLineBookmarks({ store = null, settings = null, now = Date.now(), log = console.log, limit = FORGET_BATCH } = {}) {
  const none = { forgotten: 0, newestEndMs: null }
  settings ??= getSettings()
  const rec = settings?.recording ?? {}
  const daysOf = (key) => Number({ ...(rec.defaults ?? {}), ...(rec.cameras?.[key] ?? {}) }.retentionDays)
  const all = [rec.defaults?.retentionDays, ...Object.values(rec.cameras ?? {}).map((c) => c?.retentionDays)].map(Number).filter((d) => Number.isFinite(d) && d > 0)
  if (!all.length) return none // (no days kept set anywhere: nothing to forget by)
  const s = store ?? (await bookmarkStore(log))
  if (!s || typeof s.removeBookmarks !== 'function') return none
  // only bookmarks that started before the shortest days kept can have ended before their camera's
  const before = now - Math.min(...all) * DAY
  const due = (b) => {
    if (!b.cameras.length || !isAuto(b, b.cameras[0])) return false
    const days = daysOf(b.cameras[0])
    return Number.isFinite(days) && days > 0 && b.endMs < now - days * DAY
  }
  const gone = s.listBookmarks({ toMs: before, keep: due, limit })
  if (!gone.length) return none
  const forgotten = s.removeBookmarks(gone.map((b) => b.id))
  const newestEndMs = Math.max(...gone.map((b) => b.endMs))
  log(`[lines] forgot ${forgotten} automatic line-crossing bookmark${forgotten === 1 ? '' : 's'} that ended more than their camera's days kept ago (the newest ended ${new Date(newestEndMs).toISOString().slice(0, 16).replace('T', ' ')} UTC): their footage goes with the rest`)
  return { forgotten, newestEndMs }
}

// ---- one crossing --------------------------------------------------------------------------------

/**
 * An event with its times on this server's clock, which the server's recordings, bookmarks and
 * thinning use: NVR time - skewMs (playback.mjs clock(): the NVR's clock - this server's). An event's
 * times are the NVR's own (alarmTime, its recorded-file list), and nvr1 runs about 220 s fast: without
 * this its snapshot looked for footage 220 s after the crossing and its bookmark kept the wrong stretch.
 * A copy; the stored row stays on the NVR's time (the fold and the unique key compare it with the
 * NVR's other times). seenMs is already this server's. skewMs 0 (under 2 s, or not read yet): the
 * same event.
 * @param {object} event  an events-db row
 * @param {number} skewMs
 */
export function onServerClock(event, skewMs) {
  const skew = Number(skewMs)
  if (!event || !Number.isFinite(skew) || skew === 0) return event
  const shift = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? v : Number(v) - skew)
  return { ...event, startMs: shift(event.startMs), endMs: shift(event.endMs) }
}

/**
 * Everything a line-crossing event sets off after it is stored: the bookmark now, the snapshot in
 * the background (it waits up to 3 minutes for the recording). Called for a new event and again
 * each time the same event grows; the bookmark merge and the per-event snapshot memory make the
 * repeats cheap. Events of any other kind are ignored, so a caller may pass every event.
 *
 * @param {object} event  the stored events-db row (addEvent(...).event: id, nvr, ch, type, startMs, endMs)
 * @param {object} [deps]
 * @param {(event: object, opts: object) => Promise<object>} [deps.bookmark]  default autoBookmark
 * @param {((event: object) => Promise<string|null>) | null} [deps.snapshot]  event-snapshot.mjs
 *   takeSnapshot bound to the recordings index; null: no snapshot
 * @param {(key: string) => string} [deps.nameOf]  camera names for the bookmark's title
 * @returns {Promise<{ bookmark: object|null, snapshot: Promise<string|null>|null }>} (callers may
 *   ignore it; the tests read it)
 */
export async function onLineCrossing(event, { bookmark = autoBookmark, snapshot = null, nameOf = null, log = console.log } = {}) {
  if (!event || event.type !== LINE_TYPE) return { bookmark: null, snapshot: null }
  const key = cameraKey(event.nvr, event.ch)
  let marked = null
  try {
    marked = await bookmark(event, { nameOf, log })
    if (marked && !marked.ok) log(`[lines] ${key}: no bookmark (${marked.error})`)
  } catch (e) {
    log(`[lines] ${key}: bookmark failed: ${e?.message ?? e}`)
  }
  let snap = null
  const id = Number(event.id)
  if (typeof snapshot === 'function' && Number.isSafeInteger(id) && id > 0 && !snapped.has(id)) {
    snapped.add(id)
    // a Set keeps insertion order, so the first one is the oldest
    if (snapped.size > SNAPPED_MAX) snapped.delete(snapped.values().next().value)
    snap = Promise.resolve()
      .then(() => snapshot(event))
      .catch((e) => {
        log(`[lines] ${key}: snapshot of event ${id} failed: ${e?.message ?? e}`)
        return null
      })
  }
  return { bookmark: marked, snapshot: snap }
}

// ---- the route -----------------------------------------------------------------------------------

/**
 * POST /api/admin/lines/alert { nvr, ch, on } — the Lines panel's "Alert my phone for this camera".
 * server.mjs has already checked admin, same origin and JSON. Switching on makes the ntfy topic
 * first (when there is none), so the rule never alerts into a topic that does not exist yet.
 *
 * @param {string} method
 * @param {() => Promise<object>} readJson
 * @param {string} user
 * @param {{ knownCamera?: (nvr: string, ch: number) => boolean }} [deps]
 * @returns {Promise<[number, object]>}
 */
export async function handleLineAlert(method, readJson, user, { knownCamera = () => true } = {}) {
  if (method !== 'POST') return [405, { error: 'Method not allowed' }]
  try {
    const body = await readJson()
    const { nvr, ch, on } = body ?? {}
    if (typeof nvr !== 'string' || !NVR_ID.test(nvr)) throw new HttpError(400, 'nvr must be an NVR id')
    if (!Number.isInteger(ch) || ch < 0 || ch > 255) throw new HttpError(400, 'ch must be a channel number from 0')
    if (typeof on !== 'boolean') throw new HttpError(400, 'on must be true or false')
    if (!knownCamera(nvr, ch)) throw new HttpError(404, 'No such camera on this NVR')
    const key = cameraKey(nvr, ch)
    const ntfy = on ? ensureNtfyTopic(user) : { topic: getSettings().alerts?.ntfy?.topic ?? '', created: false }
    const rule = setLineAlert(key, on, user)
    // the change to who gets alerted is a settings change as far as the audit trail is concerned
    audit(DATA_DIR, { user, action: 'settings-change', target: key, detail: `line-crossing phone alert ${on ? 'on' : 'off'}` })
    console.log(`[lines] ${key}: phone alert ${on ? 'on' : 'off'} (by ${user})${ntfy.created ? '; an ntfy topic was made' : ''}`)
    return [200, { rule, ntfy: { ...ntfy, url: getSettings().alerts?.ntfy?.url || 'https://ntfy.sh' } }]
  } catch (e) {
    return errorAnswer(e)
  }
}
