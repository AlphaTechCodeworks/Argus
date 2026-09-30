// Bookmarks: the stretches someone marked as mattering — "van reverses into the gate", "till
// drawer opened" — so they can be found again months later and, just as importantly, so the jobs
// that delete old footage leave them alone.
//
// They are rows in the recordings database (data/recordings.db, the `bookmarks` table declared in
// rec-index.mjs) because that is the file housekeeping and thinning already open. This module
// keeps its own connection to it: the index's connection lives in nvrs.mjs, which loads the NVR
// SDK, and nothing here may depend on that — these rules and this table have to be testable on a
// Windows machine with no SDK at all.
//
// The rules about what a bookmark may contain are not here either. They are in
// public/bookmarks-view.js, which the playback page also loads, so the form on screen and the
// check on the server cannot drift apart.
//
//   GET    /api/bookmarks?text=&from=&to=&camera=   -> { bookmarks: [...] }   (everyone signed in)
//   POST   /api/bookmarks { cameras, startMs, endMs, title, description }  -> 201 { bookmark }
//   PATCH  /api/bookmarks/:id { any of the above }  -> { bookmark }
//   DELETE /api/bookmarks/:id                       -> { deleted: true }
//
// Who may change one: an admin, or the person whose name is on it. A viewer can bookmark what they
// saw and tidy up after themselves, and cannot quietly rewrite somebody else's account of an
// incident.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DATA_DIR, isAdmin } from './auth.mjs'
import { BOOKMARKS_SCHEMA } from './rec-index.mjs'
import { AUTO_USER, DEFAULT_MARGIN_MS, checkBookmark, checkPatch, protectedByCamera } from './public/bookmarks-view.js'

export const BOOKMARKS_DB = join(DATA_DIR, 'recordings.db')
/** One page of results. A site accumulates bookmarks slowly; this is a guard, not a paging scheme. */
export const MAX_RESULTS = 500
const NO_STORE = { 'cache-control': 'no-store' }
const COLS = 'id, cameras, start_ms AS startMs, end_ms AS endMs, title, description, user, created_ms AS createdMs'

let db = null
let q = null

/**
 * The connection, opened on first use. Its own connection rather than the index's: this module
 * must not import nvrs.mjs (and so the SDK). SQLite in WAL mode is happy with two readers and a
 * writer in one process, and the two touch different tables anyway.
 *
 * The schema statement runs on every open. It only ever creates what is missing, so on the server's
 * populated database it adds the bookmarks table the first time and does nothing after that.
 */
function open() {
  if (db) return q
  mkdirSync(dirname(BOOKMARKS_DB), { recursive: true })
  db = new DatabaseSync(BOOKMARKS_DB)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  db.exec(BOOKMARKS_SCHEMA)
  q = {
    add: db.prepare('INSERT INTO bookmarks (cameras, start_ms, end_ms, title, description, user, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    get: db.prepare(`SELECT ${COLS} FROM bookmarks WHERE id = ?`),
    // read row by row (iterate) and stopped at the cap by listBookmarks, which filters first
    all: db.prepare(`SELECT ${COLS} FROM bookmarks ORDER BY start_ms DESC`),
    // overlapping, not contained: a search for an hour must still find the bookmark that straddles it
    inWindow: db.prepare(`SELECT ${COLS} FROM bookmarks WHERE end_ms >= ? AND start_ms <= ? ORDER BY start_ms DESC`),
    protect: db.prepare('SELECT start_ms AS startMs, end_ms AS endMs, cameras FROM bookmarks WHERE end_ms >= ? AND start_ms <= ? ORDER BY start_ms'),
    // one maker's that ended before a time, a page on from the last one returned (listEndedBefore). "+user" keeps
    // SQLite off the user index: that one would have it read and sort every row of the maker's each page, where
    // the end index is already in the page's order, so the walk stops at the page's end.
    endedBy: db.prepare(`SELECT ${COLS} FROM bookmarks WHERE +user = ? AND end_ms < ? AND (end_ms, id) > (?, ?) ORDER BY end_ms, id LIMIT ?`),
    update: db.prepare('UPDATE bookmarks SET cameras = ?, start_ms = ?, end_ms = ?, title = ?, description = ?, user = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM bookmarks WHERE id = ?')
  }
  return q
}

/** Closes the connection (tests, and a clean shutdown). The next call opens it again. */
export function closeBookmarks() {
  db?.close()
  db = null
  q = null
}

/**
 * A stored row as the rest of the app sees it: `cameras` back from its JSON text, and never a
 * half-row. A row whose cameras column cannot be parsed is not silently turned into a bookmark of
 * no cameras — that would quietly widen what housekeeping may delete — so it keeps an empty list
 * and is reported as damaged, which is visible in the list rather than invisible in a job.
 */
function toBookmark(row) {
  if (!row) return null
  let cameras = []
  let damaged = false
  try {
    const parsed = JSON.parse(row.cameras)
    if (Array.isArray(parsed)) cameras = parsed.filter((c) => typeof c === 'string')
    else damaged = true
  } catch {
    damaged = true
  }
  return {
    id: row.id,
    cameras,
    startMs: row.startMs,
    endMs: row.endMs,
    title: row.title,
    description: row.description ?? '',
    user: row.user,
    createdMs: row.createdMs,
    ...(damaged ? { damaged: true } : {})
  }
}

/** A client-supplied id: a positive whole number and nothing else. */
function idFrom(raw) {
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * A time from the query string: milliseconds, or a date the browser's own date field produces
 * ("2026-09-25"), which is read as UTC midnight. Anything else is null, never a guess and never
 * NaN passed on to SQLite.
 */
export function msFrom(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  const s = String(raw).trim()
  if (/^-?\d+$/.test(s)) {
    const n = Number(s)
    return Number.isSafeInteger(n) ? n : null
  }
  const parsed = Date.parse(s)
  return Number.isFinite(parsed) ? parsed : null
}

// ---- the store ----------------------------------------------------------------------------------

/**
 * Creates a bookmark. `user` is the signed-in name and is never taken from the body: a client that
 * could choose it could file a bookmark under someone else's account.
 * @returns {{ ok: true, bookmark: object } | { ok: false, error: string }}
 */
export function createBookmark(raw, user, { now = Date.now() } = {}) {
  if (!user) return { ok: false, error: 'Not signed in' }
  const checked = checkBookmark(raw, { now })
  if (!checked.ok) return { ok: false, error: checked.error }
  const v = checked.value
  const s = open()
  const res = s.add.run(JSON.stringify(v.cameras), v.startMs, v.endMs, v.title, v.description, String(user), Math.round(now))
  return { ok: true, bookmark: toBookmark(s.get.get(Number(res.lastInsertRowid))) }
}

/** One bookmark, or null. */
export function getBookmark(id) {
  const n = idFrom(id)
  return n === null ? null : toBookmark(open().get.get(n))
}

/**
 * The bookmarks matching a search, newest first.
 * The time window is done in SQL (it is the one filter with an index behind it); the text and
 * camera filters are applied to those rows here, because `cameras` is JSON and a LIKE against it
 * would match a camera key that happens to be a prefix of another.
 * The cap counts the bookmarks that pass every filter, `keep` among them (the caller's rights
 * check): rows are read newest first and reading stops at the cap, so a viewer's own bookmarks are
 * never pushed out of their list by newer ones on cameras they may not see.
 * @param {{ text?: string, fromMs?: number|null, toMs?: number|null, camera?: string|null, limit?: number,
 *   keep?: ((bookmark: object) => boolean) | null }} f
 */
export function listBookmarks({ text = '', fromMs = null, toMs = null, camera = null, limit = MAX_RESULTS, keep = null } = {}) {
  const s = open()
  const cap = Math.min(Math.max(1, Math.floor(Number(limit) || MAX_RESULTS)), MAX_RESULTS)
  const from = Number.isFinite(fromMs) ? Math.round(fromMs) : null
  const to = Number.isFinite(toMs) ? Math.round(toMs) : null
  const rows = from !== null || to !== null
    ? s.inWindow.iterate(from ?? -8.64e15, to ?? 8.64e15)
    : s.all.iterate()
  const needle = String(text ?? '').trim().toLowerCase()
  const cam = camera ? String(camera) : null
  const out = []
  for (const row of rows) {
    const b = toBookmark(row)
    if (cam && !b.cameras.includes(cam)) continue
    if (needle && !`${b.title}\n${b.description}\n${b.user}`.toLowerCase().includes(needle)) continue
    if (keep && !keep(b)) continue
    out.push(b)
    if (out.length >= cap) break // (leaving the loop ends the statement)
  }
  return out
}

/**
 * Changes a bookmark. The change is merged onto the stored row and the whole thing checked again,
 * so moving only the start cannot leave a bookmark that ends before it begins.
 *
 * A bookmark no person made (filed under AUTO_USER: a line crossing's, line-actions.mjs) that a person
 * changes becomes theirs: the signed-in name goes on it. Since 2026-09-30 an automatic bookmark is
 * forgotten after its camera's days kept (auto-bookmarks.mjs forgetAutoBookmarks), and a person who took
 * the trouble to change one -- a note of what happened, a longer stretch -- has kept it. Later crossings
 * no longer stretch it either: what a person wrote about an incident is not grown by the system.
 * (Edits made before this rule, on the master deployed until then, left "system" on the bookmark; the
 * forget step tells those by their description instead: auto-bookmarks.mjs isAutoBookmark.)
 * @returns {{ ok: true, bookmark: object } | { ok: false, status: number, error: string }}
 */
export function updateBookmark(id, patch, who, { now = Date.now() } = {}) {
  const n = idFrom(id)
  if (n === null) return { ok: false, status: 400, error: 'That is not a bookmark id' }
  const current = getBookmark(n)
  if (!current) return { ok: false, status: 404, error: 'No such bookmark' }
  if (!mayChange(current, who)) return { ok: false, status: 403, error: 'Only an admin or the person who made a bookmark can change it' }
  const fields = checkPatch(patch)
  if (!fields.ok) return { ok: false, status: 400, error: fields.error }
  const checked = checkBookmark({ ...current, ...fields.value }, { now })
  if (!checked.ok) return { ok: false, status: 400, error: checked.error }
  const v = checked.value
  const by = whoOf(who).user
  const user = current.user === AUTO_USER && by && by !== AUTO_USER ? by : current.user
  const s = open()
  s.update.run(JSON.stringify(v.cameras), v.startMs, v.endMs, v.title, v.description, user, n)
  return { ok: true, bookmark: toBookmark(s.get.get(n)) }
}

/** Deletes a bookmark. @returns {{ ok: true } | { ok: false, status: number, error: string }} */
export function deleteBookmark(id, who) {
  const n = idFrom(id)
  if (n === null) return { ok: false, status: 400, error: 'That is not a bookmark id' }
  const current = getBookmark(n)
  if (!current) return { ok: false, status: 404, error: 'No such bookmark' }
  if (!mayChange(current, who)) return { ok: false, status: 403, error: 'Only an admin or the person who made a bookmark can delete it' }
  open().remove.run(n)
  return { ok: true }
}

/**
 * Deletes these bookmarks in one transaction, with no rights check: for the server's own jobs, which
 * decide which (auto-bookmarks.mjs forgetAutoBookmarks: automatic ones past their camera's days kept).
 * One commit for the lot, not one each: each is WAL pages, and a checkpoint lands on the main thread.
 * @param {number[]} ids
 * @returns {number} how many there were
 */
export function removeBookmarks(ids) {
  const list = [...new Set((ids ?? []).map(idFrom).filter((n) => n !== null))]
  if (!list.length) return 0
  const s = open()
  let gone = 0
  db.exec('BEGIN')
  try {
    for (const n of list) gone += Number(s.remove.run(n).changes)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return gone
}

/**
 * One maker's bookmarks that ended before `beforeMs`, oldest end first (the same end by id), at most `limit`, from
 * after `after` on: the { endMs, id } of the last one a previous page returned (null: from the oldest). For the
 * server's own jobs, which page through them a bounded number a round (auto-bookmarks.mjs forgetAutoBookmarks):
 * no rights check, and no cap but the one asked for, so a short page means the end was reached.
 *
 * Why (data-safety review of 19321dd, 2026-09-30): the forget step used listBookmarks, which reads every row in
 * its window in JavaScript and filters there; with 20,000 automatic bookmarks it read them all each 5 minutes
 * (157-199 ms on the main thread). Here the maker and the end are SQLite's, in the end index's order.
 * @param {string} user
 * @param {number} beforeMs
 * @param {{ after?: { endMs: number, id: number } | null, limit?: number }} [o]
 * @returns {object[]}
 */
export function listEndedBefore(user, beforeMs, { after = null, limit = 1000 } = {}) {
  const before = beforeMs === null || beforeMs === undefined ? NaN : Number(beforeMs)
  if (!user || !Number.isFinite(before)) return []
  const n = Math.max(1, Math.floor(Number(limit)) || 1000)
  const from = after && Number.isFinite(after.endMs) && Number.isSafeInteger(after.id) ? after : { endMs: -8.64e15, id: 0 }
  return open().endedBy.all(String(user), Math.round(before), Math.round(from.endMs), from.id, n).map(toBookmark)
}

/**
 * The stretches housekeeping and thinning must not touch, within [fromMs, toMs], camera by camera:
 * every bookmark overlapping the window, grown by `marginMs` at each end, and merged with the same
 * camera's others (public/bookmarks-view.js protectedByCamera).
 *
 * The margin is the point. A bookmark of the moment itself is no use if the minute leading up to it
 * has been deleted, and that is usually the minute that explains what happened. It is applied here,
 * once: the jobs take these stretches as they are (thinning.mjs protectionFor).
 *
 * A bookmark keeps the cameras it names, not every camera (since 2026-09-30): each stretch says its
 * camera, null for every camera (a bookmark whose cameras cannot be read). Before, a line-crossing
 * bookmark of one camera kept all 87 cameras' footage of its minutes.
 *
 * The answer is not clipped to the window: a caller asking about a day wants the true edges of the
 * protected stretches, so that a segment reaching past midnight is still seen as protected.
 *
 * @returns {Array<[number, number, string|null]>} oldest first, none overlapping another of its camera
 */
export function protectedRanges(fromMs, toMs, { marginMs = DEFAULT_MARGIN_MS } = {}) {
  const from = Number(fromMs)
  const to = Number(toMs)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return []
  const margin = Number.isFinite(marginMs) && marginMs > 0 ? Math.round(marginMs) : 0
  // widened before the lookup as well as after it, or a bookmark just outside the window whose
  // margin reaches into it would be missed
  const rows = open().protect.all(Math.round(from) - margin, Math.round(to) + margin)
  return protectedByCamera(rows, margin)
}

/** Whether this person may edit or delete this bookmark. `who` is a name or { user, admin }. */
function mayChange(bookmark, who) {
  const { user, admin } = whoOf(who)
  if (admin) return true
  return Boolean(user) && bookmark.user === user
}

/**
 * The signed-in person, however the caller names them: a plain user name (their role is then read
 * from data/users.json) or { user, admin } when the caller has already worked the role out — which
 * server.mjs has, and which is the only way the AUTH_OFF development mode can say "treat me as an
 * admin" without inventing an account.
 */
function whoOf(who) {
  if (who && typeof who === 'object') {
    const user = who.user ?? who.name ?? null
    return { user: user ? String(user) : null, admin: who.admin === true || (who.admin === undefined && Boolean(user) && isAdmin(String(user))) }
  }
  const user = who ? String(who) : null
  return { user, admin: Boolean(user) && isAdmin(user) }
}

// ---- the requests -------------------------------------------------------------------------------

const ID_PATH = /^\/api\/bookmarks\/([^/]+)$/

/**
 * All four bookmark routes.
 *
 * `pathname` is the path only; the filters for GET come from its query string, which is why the
 * whole request line may be passed in as well — either "/api/bookmarks" with the search
 * separately, or "/api/bookmarks?text=..." — and both read the same.
 *
 * @param {string} method
 * @param {string} pathname                 '/api/bookmarks', with or without its query string
 * @param {() => Promise<object>} readJson   the request's JSON object body (POST and PATCH only)
 * @param {string | { user: string, admin?: boolean }} user  the signed-in person
 * @param {{ canSee?: ((nvr: string, ch: number) => boolean) | null }} [rights] which cameras this
 *   person may watch or play back (server.mjs canSee, from rights.mjs). Missing: none, for anyone
 *   but an admin.
 * @returns {Promise<[number, any, object?] | null>} null when the path is not one of these routes
 */
export async function handleBookmarks(method, pathname, readJson, user, { canSee = null } = {}) {
  const [path, search = ''] = String(pathname ?? '').split('?')
  const who = whoOf(user)
  const idMatch = ID_PATH.exec(path)
  if (path !== '/api/bookmarks' && !idMatch) return null
  if (!who.user) return [401, { error: 'Not signed in' }, NO_STORE]

  // A bookmark names cameras and says what happened on them. Anyone but an admin is shown only the
  // bookmarks on a camera they may see, and in those only the cameras they may see; one on none of
  // their cameras does not exist for them (404, so its id is not even confirmed). They may bookmark
  // only cameras they may see.
  const seeKey = (k) => {
    const slash = typeof k === 'string' ? k.lastIndexOf('/') : -1
    return slash > 0 && typeof canSee === 'function' && Boolean(canSee(k.slice(0, slash), Number(k.slice(slash + 1))))
  }
  const visible = (b) => who.admin || b.cameras.some(seeKey)
  const shown = (b) => (who.admin ? b : { ...b, cameras: b.cameras.filter(seeKey) })
  const namesHidden = (list) => !who.admin && Array.isArray(list) && list.some((k) => typeof k === 'string' && !seeKey(k))
  const NOT_YOURS = [403, { error: 'You cannot bookmark a camera you have no access to' }, NO_STORE]

  try {
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1])
      const current = getBookmark(id)
      if (current && !visible(current) && ['GET', 'PATCH', 'DELETE'].includes(method)) return [404, { error: 'No such bookmark' }, NO_STORE]
      if (method === 'GET') {
        return current ? [200, { bookmark: shown(current) }, NO_STORE] : [404, { error: 'No such bookmark' }, NO_STORE]
      }
      if (method === 'PATCH') {
        let patch = await readJson()
        if (!who.admin && patch && typeof patch === 'object' && 'cameras' in patch) {
          if (namesHidden(patch.cameras)) return NOT_YOURS
          // The dialog shows the list without the cameras this person may not see; saving it must
          // not drop them from the bookmark (and so from what housekeeping keeps).
          if (current && Array.isArray(patch.cameras)) patch = { ...patch, cameras: [...patch.cameras, ...current.cameras.filter((k) => !seeKey(k))] }
        }
        const res = updateBookmark(id, patch, who)
        return res.ok ? [200, { bookmark: shown(res.bookmark) }, NO_STORE] : [res.status, { error: res.error }, NO_STORE]
      }
      if (method === 'DELETE') {
        const res = deleteBookmark(id, who)
        return res.ok ? [200, { deleted: true }, NO_STORE] : [res.status, { error: res.error }, NO_STORE]
      }
      return [405, { error: 'Method not allowed' }, { allow: 'GET, PATCH, DELETE' }]
    }

    if (method === 'GET') {
      const params = new URLSearchParams(search)
      const camera = params.get('camera')
      // aimed at a camera this person may not see: nothing, rather than the shared bookmarks that
      // would say it is on them
      if (camera && !who.admin && !seeKey(camera)) return [200, { bookmarks: [], user: who.user, admin: who.admin }, NO_STORE]
      const bookmarks = listBookmarks({
        text: params.get('text') ?? '',
        fromMs: msFrom(params.get('from')),
        toMs: msFrom(params.get('to')),
        camera,
        keep: who.admin ? null : visible
      }).map(shown)
      return [200, { bookmarks, user: who.user, admin: who.admin }, NO_STORE]
    }
    if (method === 'POST') {
      const body = await readJson()
      if (namesHidden(body?.cameras)) return NOT_YOURS
      const res = createBookmark(body, who.user)
      return res.ok ? [201, { bookmark: res.bookmark }, NO_STORE] : [400, { error: res.error }, NO_STORE]
    }
    return [405, { error: 'Method not allowed' }, { allow: 'GET, POST' }]
  } catch (e) {
    if (e instanceof SyntaxError) return [400, { error: 'Bad JSON' }]
    console.error(`[bookmarks] ${e.stack ?? e}`)
    return [500, { error: 'The bookmark could not be saved' }]
  }
}
