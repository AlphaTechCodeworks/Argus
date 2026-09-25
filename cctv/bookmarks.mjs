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
import { DEFAULT_MARGIN_MS, checkBookmark, checkPatch, mergeProtected } from './public/bookmarks-view.js'

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
    all: db.prepare(`SELECT ${COLS} FROM bookmarks ORDER BY start_ms DESC LIMIT ?`),
    // overlapping, not contained: a search for an hour must still find the bookmark that straddles it
    inWindow: db.prepare(`SELECT ${COLS} FROM bookmarks WHERE end_ms >= ? AND start_ms <= ? ORDER BY start_ms DESC LIMIT ?`),
    protect: db.prepare('SELECT start_ms AS startMs, end_ms AS endMs FROM bookmarks WHERE end_ms >= ? AND start_ms <= ? ORDER BY start_ms'),
    update: db.prepare('UPDATE bookmarks SET cameras = ?, start_ms = ?, end_ms = ?, title = ?, description = ? WHERE id = ?'),
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
 * @param {{ text?: string, fromMs?: number|null, toMs?: number|null, camera?: string|null, limit?: number }} f
 */
export function listBookmarks({ text = '', fromMs = null, toMs = null, camera = null, limit = MAX_RESULTS } = {}) {
  const s = open()
  const cap = Math.min(Math.max(1, Math.floor(Number(limit) || MAX_RESULTS)), MAX_RESULTS)
  const from = Number.isFinite(fromMs) ? Math.round(fromMs) : null
  const to = Number.isFinite(toMs) ? Math.round(toMs) : null
  const rows = from !== null || to !== null
    ? s.inWindow.all(from ?? -8.64e15, to ?? 8.64e15, cap)
    : s.all.all(cap)
  const needle = String(text ?? '').trim().toLowerCase()
  const cam = camera ? String(camera) : null
  return rows
    .map(toBookmark)
    .filter((b) => {
      if (cam && !b.cameras.includes(cam)) return false
      if (needle && !`${b.title}\n${b.description}\n${b.user}`.toLowerCase().includes(needle)) return false
      return true
    })
}

/**
 * Changes a bookmark. The change is merged onto the stored row and the whole thing checked again,
 * so moving only the start cannot leave a bookmark that ends before it begins.
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
  const s = open()
  s.update.run(JSON.stringify(v.cameras), v.startMs, v.endMs, v.title, v.description, n)
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
 * The stretches housekeeping and thinning must not touch, within [fromMs, toMs]: every bookmark
 * overlapping the window, grown by `marginMs` at each end and merged.
 *
 * The margin is the point. A bookmark of the moment itself is no use if the minute leading up to it
 * has been deleted, and that is usually the minute that explains what happened.
 *
 * The answer is not clipped to the window: a caller asking about a day wants the true edges of the
 * protected stretches, so that a segment reaching past midnight is still seen as protected.
 *
 * @returns {Array<[number, number]>} oldest first, none overlapping another
 */
export function protectedRanges(fromMs, toMs, { marginMs = DEFAULT_MARGIN_MS } = {}) {
  const from = Number(fromMs)
  const to = Number(toMs)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return []
  const margin = Number.isFinite(marginMs) && marginMs > 0 ? Math.round(marginMs) : 0
  // widened before the lookup as well as after it, or a bookmark just outside the window whose
  // margin reaches into it would be missed
  const rows = open().protect.all(Math.round(from) - margin, Math.round(to) + margin)
  return mergeProtected(rows, margin)
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
 * @returns {Promise<[number, any, object?] | null>} null when the path is not one of these routes
 */
export async function handleBookmarks(method, pathname, readJson, user) {
  const [path, search = ''] = String(pathname ?? '').split('?')
  const who = whoOf(user)
  const idMatch = ID_PATH.exec(path)
  if (path !== '/api/bookmarks' && !idMatch) return null
  if (!who.user) return [401, { error: 'Not signed in' }, NO_STORE]

  try {
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1])
      if (method === 'GET') {
        const bookmark = getBookmark(id)
        return bookmark ? [200, { bookmark }, NO_STORE] : [404, { error: 'No such bookmark' }, NO_STORE]
      }
      if (method === 'PATCH') {
        const res = updateBookmark(id, await readJson(), who)
        return res.ok ? [200, { bookmark: res.bookmark }, NO_STORE] : [res.status, { error: res.error }, NO_STORE]
      }
      if (method === 'DELETE') {
        const res = deleteBookmark(id, who)
        return res.ok ? [200, { deleted: true }, NO_STORE] : [res.status, { error: res.error }, NO_STORE]
      }
      return [405, { error: 'Method not allowed' }, { allow: 'GET, PATCH, DELETE' }]
    }

    if (method === 'GET') {
      const params = new URLSearchParams(search)
      const bookmarks = listBookmarks({
        text: params.get('text') ?? '',
        fromMs: msFrom(params.get('from')),
        toMs: msFrom(params.get('to')),
        camera: params.get('camera')
      })
      return [200, { bookmarks, user: who.user, admin: who.admin }, NO_STORE]
    }
    if (method === 'POST') {
      const res = createBookmark(await readJson(), who.user)
      return res.ok ? [201, { bookmark: res.bookmark }, NO_STORE] : [400, { error: res.error }, NO_STORE]
    }
    return [405, { error: 'Method not allowed' }, { allow: 'GET, POST' }]
  } catch (e) {
    if (e instanceof SyntaxError) return [400, { error: 'Bad JSON' }]
    console.error(`[bookmarks] ${e.stack ?? e}`)
    return [500, { error: 'The bookmark could not be saved' }]
  }
}
