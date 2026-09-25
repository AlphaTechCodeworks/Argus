// Per-user preferences of the viewer pages, for any logged-in user (not admins only). For now the
// live grid's camera order (public/grid-order.js), each user their own. App data only:
//
//   data/user-prefs.json   { "<user>": { gridOrder: ["<nvr>/<ch>", ...], gridOrderVersion: n } }
//   written as a temp file + rename (never half-written), mode 0600; the file before each save is
//   kept as data/user-prefs.json.bak. A file that is unreadable or damaged is never treated as
//   "no preferences": GET and PUT answer 500 and nothing is written until it is fixed (the pages
//   keep their own copies and send their changes again later), so other users' orders survive.
//
//   GET /api/me/grid-order                           -> { order: [...], version }  ([] = the default order)
//   PUT /api/me/grid-order  { order: [...], version } -> { order, version }        (as saved, the new version)
//                                                     or 409 { error, order, version } (the latest)
//
// The version counts the user's saves (0: none yet; a reset goes on counting). A PUT names the
// version its change was made on; when the order has been saved since (the same user on another
// screen), it is refused with 409 and the latest order, and the page does its change again on
// that (public/grid-order.js). So no screen overwrites a change it has not seen. The check and the
// write are one synchronous step (no other request can come between them).
//
// The user is always the session's (server.mjs passes it in); a body naming anyone is refused.
// A PUT gets the same checks as the admin writes: same origin, application/json.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR } from './auth.mjs'

export const GRID_ORDER_PATH = '/api/me/grid-order'
export const PREFS_FILE = join(DATA_DIR, 'user-prefs.json')
/** A camera key: "<nvr id>/<channel>" (the same rule as public/grid-order.js). */
export const KEY_RE = /^[A-Za-z0-9._-]{1,64}\/\d{1,4}$/
export const MAX_KEYS = 4096
/** Room for MAX_KEYS of the longest keys as compact JSON (about 295 KB), and not much more. */
export const BODY_LIMIT = 320 * 1024

const NO_STORE = { 'cache-control': 'no-store' }
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

class BadRequest extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// ---- the file ------------------------------------------------------------------------------------

/** The file cannot be used (unreadable or damaged): refused rather than read as "no preferences". */
class PrefsUnavailable extends Error {}
const warned = new Set()
const warnOnce = (msg) => {
  if (warned.has(msg)) return
  warned.add(msg)
  console.warn(msg)
}

/**
 * Everyone's preferences, as an object without a prototype (so no user name can reach one), and
 * the file's text (kept as user-prefs.json.bak by the next save). A missing file is "none yet";
 * a file that cannot be read or does not parse throws PrefsUnavailable: answering "no order" would
 * make every page replace its own copy, and the next save would wipe the other users' orders.
 */
function loadAll() {
  let text
  try {
    text = readFileSync(PREFS_FILE, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { all: Object.create(null), text: null }
    warnOnce(`[user-prefs] ${PREFS_FILE} unreadable (${e.code ?? e.message}); camera orders are not read or saved until it is fixed`)
    throw new PrefsUnavailable(`unreadable (${e.code ?? e.message})`)
  }
  try {
    const j = JSON.parse(text)
    if (isPlainObject(j)) {
      warned.clear()
      return { all: Object.assign(Object.create(null), j), text }
    }
  } catch {}
  warnOnce(`[user-prefs] ${PREFS_FILE} is damaged; camera orders are not read or saved until it is fixed (the previous good copy is ${PREFS_FILE}.bak)`)
  throw new PrefsUnavailable('damaged')
}

/** Writes text as file: a temp file + rename (never half-written), mode 0600. */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  rmSync(tmp, { force: true }) // a leftover from a crash could have other permissions
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

function saveAll(all, previousText) {
  mkdirSync(dirname(PREFS_FILE), { recursive: true })
  // the last good file, for restoring by hand if this one is ever damaged
  if (previousText) {
    try {
      writeAtomic(`${PREFS_FILE}.bak`, previousText)
    } catch (e) {
      console.warn(`[user-prefs] ${PREFS_FILE}.bak not written: ${e.message}`)
    }
  }
  writeAtomic(PREFS_FILE, `${JSON.stringify(all, null, 1)}\n`)
}

const isVersion = (v) => Number.isSafeInteger(v) && v >= 0

/** A user's saved camera order and its version, from everyone's preferences. */
function stateOf(all, user) {
  const entry = isPlainObject(all[user]) ? all[user] : {}
  const saved = Array.isArray(entry.gridOrder) ? entry.gridOrder : []
  return {
    order: [...new Set(saved.filter((k) => typeof k === 'string' && KEY_RE.test(k)))].slice(0, MAX_KEYS),
    version: isVersion(entry.gridOrderVersion) ? entry.gridOrderVersion : 0
  }
}

/** The user's saved camera order ([] when none). */
export const gridOrderOf = (user) => {
  try {
    return stateOf(loadAll().all, user).order
  } catch (e) {
    if (e instanceof PrefsUnavailable) return []
    throw e
  }
}

/**
 * Saves the order if it was made on the latest version (read, checked and written in one step).
 * Throws PrefsUnavailable (nothing written) when the file is unreadable or damaged.
 * @returns {{ saved: boolean, order: string[], version: number }} the new state, or the latest one when refused
 */
function saveGridOrder(user, order, version) {
  const { all, text } = loadAll()
  const now = stateOf(all, user)
  if (version !== now.version) return { saved: false, ...now }
  const entry = isPlainObject(all[user]) ? { ...all[user] } : {}
  if (order.length) entry.gridOrder = order
  else delete entry.gridOrder
  // kept after a reset too: a count that started again could match an old screen's version
  entry.gridOrderVersion = now.version + 1
  all[user] = entry
  saveAll(all, text)
  return { saved: true, order, version: entry.gridOrderVersion }
}

// ---- the request ------------------------------------------------------------------------------------

/** Changes only from the app's own pages, as JSON (blocks cross-site form posts): as server.mjs does for admin writes. */
function sameOriginJson(req) {
  const origin = req.headers.origin
  let sameOrigin = false
  try {
    sameOrigin = !origin || new URL(origin).host === req.headers.host
  } catch {} // "Origin: null" and the like: refused
  return sameOrigin && String(req.headers['content-type'] ?? '').startsWith('application/json')
}

/** The body as text, at most limit bytes (413 beyond, without reading on when the length says so). */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) return reject(new BadRequest(413, 'Too large'))
    const chunks = []
    let size = 0
    let done = false
    const finish = (fn, v) => {
      if (done) return
      done = true
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      fn(v)
    }
    const onData = (c) => {
      const b = typeof c === 'string' ? Buffer.from(c) : c
      size += b.length
      if (size <= limit) return chunks.push(b)
      req.resume() // the rest is read and dropped; the answer closes the connection
      finish(reject, new BadRequest(413, 'Too large'))
    }
    const onEnd = () => finish(resolve, Buffer.concat(chunks).toString('utf8'))
    const onError = (e) => finish(reject, e)
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

/** A PUT body: { order: [keys], version } and nothing else; repeated keys kept once. */
function changeFromBody(body) {
  if (!isPlainObject(body)) throw new BadRequest(400, 'The body must be a JSON object: { "order": [...], "version": n }')
  const extra = Object.keys(body).find((k) => k !== 'order' && k !== 'version')
  if (extra !== undefined) throw new BadRequest(400, `Unknown field "${extra.slice(0, 40)}" (only "order" and "version")`)
  if (!Array.isArray(body.order)) throw new BadRequest(400, 'order must be a list of camera keys ("<nvr>/<channel>")')
  if (body.order.length > MAX_KEYS) throw new BadRequest(400, `At most ${MAX_KEYS} cameras`)
  const bad = body.order.findIndex((k) => typeof k !== 'string' || !KEY_RE.test(k))
  if (bad >= 0) throw new BadRequest(400, `Camera key ${bad + 1} is not "<nvr>/<channel>"`)
  if (!isVersion(body.version)) throw new BadRequest(400, 'version must be the version of the order the change was made on (from GET)')
  return { order: [...new Set(body.order)], version: body.version }
}

/**
 * GET/PUT /api/me/grid-order for the logged-in user.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} user the session's user (never one from the body)
 * @returns {Promise<[number, object, object?]>} status, JSON body, extra headers
 */
export async function handleGridOrder(req, user) {
  if (!user) return [401, { error: 'Not logged in' }]
  if (req.method === 'GET') {
    try {
      return [200, stateOf(loadAll().all, user), NO_STORE]
    } catch (e) {
      if (!(e instanceof PrefsUnavailable)) throw e
      return [500, { error: 'Saved camera orders are unavailable (the preferences file is damaged or unreadable)' }, NO_STORE]
    }
  }
  if (req.method !== 'PUT') return [405, { error: 'Method not allowed' }, { allow: 'GET, PUT' }]
  if (!sameOriginJson(req)) return [403, { error: 'Forbidden' }]
  let change
  try {
    let body
    try {
      body = JSON.parse(await readBody(req, BODY_LIMIT))
    } catch (e) {
      if (e instanceof BadRequest) throw e
      throw new BadRequest(400, 'Bad JSON')
    }
    change = changeFromBody(body)
  } catch (e) {
    if (!(e instanceof BadRequest)) throw e
    return e.status === 413 ? [413, { error: `The order is too large (at most ${MAX_KEYS} cameras)` }, { connection: 'close' }] : [400, { error: e.message }]
  }
  let result
  try {
    result = saveGridOrder(user, change.order, change.version)
  } catch (e) {
    // (PrefsUnavailable: already logged once; nothing was written)
    if (!(e instanceof PrefsUnavailable)) console.warn(`[user-prefs] could not save the camera order of "${user}": ${e.message}`)
    return [500, { error: 'The order could not be saved' }]
  }
  const { saved, order, version } = result
  if (!saved) return [409, { error: 'The camera order was changed on another screen', order, version }, NO_STORE]
  return [200, { order, version }, NO_STORE]
}
