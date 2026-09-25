// Saved views: the named sets of cameras a user watches together on the multi-camera playback page
// ("Yard and gates", "Loading bay"), each user their own.
//
//   data/saved-views.json   { "<user>": { views: [ { id, name, cameras: ["<nvr>/<ch>"], layout } ],
//                                         viewsVersion: n } }
//
//   GET /api/me/views                       -> { views: [...], version }
//   PUT /api/me/views { views, version }     -> { views, version }
//                                            or 409 { error, views, version } (the latest)
//
// This follows user-prefs.mjs (the live grid's camera order) deliberately and in every detail: the
// same atomic temp-file-and-rename write, the same .bak of the file before each save, the same
// refusal to treat an unreadable file as "no views", and the same version counter so that the same
// user on a second screen cannot silently wipe a view saved on the first. What is stored differs;
// how it is stored should not have to be reasoned about twice.
//
// It is a separate file from user-prefs.json rather than another field in it, because two writers
// doing read-modify-write on one file is how one of them loses an update. Nothing here needs to be
// read at the same instant as the grid order, so there is no reason to share.
//
// What a view actually is — the name limits, the camera-key rule, how many cameras and how many
// views — lives in public/grid-view.js, which the page also loads, exactly as bookmarks.mjs shares
// public/bookmarks-view.js. One definition, so the form on screen and the server agree.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR } from './auth.mjs'
import { MAX_VIEWS, applyViews, normaliseViews } from './public/grid-view.js'

export const VIEWS_PATH = '/api/me/views'
export const VIEWS_FILE = join(DATA_DIR, 'saved-views.json')

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The file cannot be used (unreadable or damaged): refused rather than read as "no views". */
class ViewsUnavailable extends Error {}

const warned = new Set()
const warnOnce = (msg) => {
  if (warned.has(msg)) return
  warned.add(msg)
  console.warn(msg)
}

/**
 * Everyone's views, as an object without a prototype (so no user name can reach one), and the file's
 * text, which the next save keeps as saved-views.json.bak. A missing file is "none yet"; a damaged
 * one throws, because answering "no views" would make the next save from any page wipe everybody's.
 */
function loadAll() {
  let text
  try {
    text = readFileSync(VIEWS_FILE, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { all: Object.create(null), text: null }
    warnOnce(`[views] ${VIEWS_FILE} unreadable (${e.code ?? e.message}); saved views are not read or saved until it is fixed`)
    throw new ViewsUnavailable(`unreadable (${e.code ?? e.message})`)
  }
  try {
    const j = JSON.parse(text)
    if (isPlainObject(j)) {
      warned.clear()
      return { all: Object.assign(Object.create(null), j), text }
    }
  } catch {}
  warnOnce(`[views] ${VIEWS_FILE} is damaged; saved views are not read or saved until it is fixed (the previous good copy is ${VIEWS_FILE}.bak)`)
  throw new ViewsUnavailable('damaged')
}

/** Writes text as file: a temp file + rename (never half-written), mode 0600. */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  rmSync(tmp, { force: true }) // a leftover from a crash could have other permissions
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

function saveAll(all, previousText) {
  mkdirSync(dirname(VIEWS_FILE), { recursive: true })
  if (previousText) {
    try {
      writeAtomic(`${VIEWS_FILE}.bak`, previousText)
    } catch (e) {
      console.warn(`[views] ${VIEWS_FILE}.bak not written: ${e.message}`)
    }
  }
  writeAtomic(VIEWS_FILE, `${JSON.stringify(all, null, 1)}\n`)
}

const isVersion = (v) => Number.isSafeInteger(v) && v >= 0

/** One user's views and their version, out of everyone's. */
function stateOf(all, user) {
  const entry = isPlainObject(all[user]) ? all[user] : {}
  return {
    views: normaliseViews(entry.views).views,
    version: isVersion(entry.viewsVersion) ? entry.viewsVersion : 0
  }
}

/** A user's saved views ([] when none, or when the file cannot be read). */
export function viewsOf(user) {
  try {
    return stateOf(loadAll().all, user).views
  } catch (e) {
    if (e instanceof ViewsUnavailable) return []
    throw e
  }
}

/**
 * Saves the views if they were made on the latest version. The read, the check and the write are one
 * synchronous step, so no other request can come between them.
 * @returns {{ saved: boolean, views: Array, version: number }} the new state, or the latest when refused
 */
function saveViews(user, views, version) {
  const { all, text } = loadAll()
  const result = applyViews(stateOf(all, user), { views, version })
  if (!result.saved) return result
  const entry = isPlainObject(all[user]) ? { ...all[user] } : {}
  if (result.views.length) entry.views = result.views
  else delete entry.views
  // Kept even when the list is emptied: a count that started again could match an old screen's
  // version, and that screen would then be allowed to put its stale views back.
  entry.viewsVersion = result.version
  all[user] = entry
  saveAll(all, text)
  return result
}

/**
 * GET/PUT /api/me/views for the logged-in user.
 *
 * The same shape as handleClocks in nvr-probe.mjs: null when this is not that route, so the caller
 * carries on routing. The user is always the session's — a body naming anyone else is refused by
 * never being looked at.
 *
 * @param {string} method
 * @param {string} pathname
 * @param {() => Promise<object>} readJson the request body as a JSON object
 * @param {string} user the signed-in user
 * @returns {Promise<[number, object] | null>}
 */
export async function handleViews(method, pathname, readJson, user) {
  if (pathname !== VIEWS_PATH) return null
  if (!user) return [401, { error: 'Not logged in' }]

  if (method === 'GET') {
    try {
      const { views, version } = stateOf(loadAll().all, user)
      return [200, { views, version }]
    } catch (e) {
      if (!(e instanceof ViewsUnavailable)) throw e
      return [500, { error: 'Saved views are unavailable (the views file is damaged or unreadable)' }]
    }
  }
  if (method !== 'PUT') return [405, { error: 'Method not allowed' }]

  let body
  try {
    body = await readJson()
  } catch {
    return [400, { error: 'The body must be a JSON object: { "views": [...], "version": n }' }]
  }
  const extra = Object.keys(body).find((k) => k !== 'views' && k !== 'version')
  if (extra !== undefined) return [400, { error: `Unknown field "${extra.slice(0, 40)}" (only "views" and "version")` }]
  if (!Array.isArray(body.views)) return [400, { error: 'views must be a list of saved views' }]
  if (body.views.length > MAX_VIEWS) return [400, { error: `At most ${MAX_VIEWS} saved views` }]
  if (!isVersion(body.version)) return [400, { error: 'version must be the version the change was made on (from GET)' }]

  // A view that does not pass the shared rules is refused rather than quietly dropped: someone who
  // typed a name too long should be told, not left wondering where their view went.
  const { views, dropped } = normaliseViews(body.views)
  if (dropped > 0) return [400, { error: `${dropped} of those views could not be saved: check the name and the cameras` }]

  let result
  try {
    result = saveViews(user, views, body.version)
  } catch (e) {
    if (!(e instanceof ViewsUnavailable)) console.warn(`[views] could not save the views of "${user}": ${e.message}`)
    return [500, { error: 'The views could not be saved' }]
  }
  if (!result.saved) return [409, { error: 'Your views were changed on another screen', views: result.views, version: result.version }]
  return [200, { views: result.views, version: result.version }]
}
