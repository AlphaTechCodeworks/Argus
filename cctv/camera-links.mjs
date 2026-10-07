// Which camera adjoins which: for each camera, the cameras a person can walk to next, each with a
// short label saying where it leads ("through the front door"). The cameras here are not smart —
// there is no detection to follow — so this hand-drawn adjacency is the whole mechanism behind
// following someone from camera to camera.
//
//   data/camera-links.json   { version: n, links: { "<nvr>/<ch>": [ { to: "<nvr>/<ch>", label }, ... ] } }
//   written as a temp file + rename (never half-written), mode 0600; the file before each save is
//   kept as data/camera-links.json.bak.
//
//   GET /api/camera-links                       -> { links, version, suggestions }   (everyone signed in;
//                                               a viewer is told only about the cameras they may watch
//                                               or play back: server.mjs hands in only those as cameras)
//   PUT /api/admin/camera-links { links, version } -> { links, version }
//                                               or 409 { error, links, version } (the latest)
//   POST /api/admin/camera-links { action: 'link' | 'unlink', from, to, label?, oneWay?, version }
//                                               -> { links, version } or 409 as above
//
// The links are shared by everyone, not per user, so the versioning matters more here than it does
// in user-prefs.mjs: two admins on the map page must not silently overwrite each other. A write
// names the version it was made on; when the links have been saved since, it is refused with 409
// and the latest links, and the page re-applies its change on those.
//
// Direction: a link is two-way by default, which is stored as two entries (a -> b and b -> a).
// A one-way link — a fire door, a stairwell you can only come down — is simply the one entry, so
// anything reading the data just looks up links["<nvr>/<ch>"] and needs to know nothing else.
//
// Suggestions are NEVER stored. They are worked out on each read from the site map (the nearest few
// cameras on the same map) and answered in their own `suggestions` field, marked `suggested: true`.
// An install is then useful before anyone has drawn a link, without a guess ever being mistaken for
// something a person confirmed.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR } from './auth.mjs'

export const LINKS_PATH = '/api/camera-links'
export const ADMIN_LINKS_PATH = '/api/admin/camera-links'
export const LINKS_FILE = join(DATA_DIR, 'camera-links.json')
/** A camera key: "<nvr id>/<channel>" (the same rule as user-prefs.mjs). */
export const KEY_RE = /^[A-Za-z0-9._-]{1,64}\/\d{1,4}$/
/** More than a dozen ways out of one camera's view is a map drawing, not a follow strip. */
export const MAX_NEIGHBOURS = 12
/** The label is read at a glance beside a thumbnail, so it stays short. */
export const MAX_LABEL = 60
export const MAX_CAMERAS = 4096
/** How many nearest cameras to offer as suggestions for a camera with no links yet. */
export const SUGGEST_COUNT = 4
/** Room for the largest plausible set of links as compact JSON, and not much more. */
export const BODY_LIMIT = 512 * 1024

const NO_STORE = { 'cache-control': 'no-store' }
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export class LinkError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** The file cannot be used (unreadable or damaged): refused rather than read as "no links". */
export class LinksUnavailable extends Error {}

// ---- validation and the pure operations ------------------------------------------------------------

/**
 * One neighbour entry, checked. `known` (a Set of camera keys) is the list of cameras that exist;
 * when it is given, a link to a camera that is not there is refused.
 */
function cleanEntry(raw, from, known) {
  if (!isPlainObject(raw)) throw new LinkError(400, 'Each neighbour must be { "to": "<nvr>/<channel>", "label": "..." }')
  const extra = Object.keys(raw).find((k) => k !== 'to' && k !== 'label')
  if (extra !== undefined) throw new LinkError(400, `Unknown field "${extra.slice(0, 40)}" on a neighbour (only "to" and "label")`)
  const to = raw.to
  if (typeof to !== 'string' || !KEY_RE.test(to)) throw new LinkError(400, `A neighbour of ${from} is not a camera key ("<nvr>/<channel>")`)
  if (to === from) throw new LinkError(400, `${from} cannot lead to itself`)
  if (known && !known.has(to)) throw new LinkError(400, `There is no camera ${to}`)
  const label = raw.label === undefined || raw.label === null ? '' : raw.label
  if (typeof label !== 'string') throw new LinkError(400, `The label of ${from} -> ${to} must be text`)
  // a stray newline would break the one-line look of the strip, and leading space is never meant
  const text = label.replace(/\s+/g, ' ').trim()
  if (text.length > MAX_LABEL) throw new LinkError(400, `The label of ${from} -> ${to} is longer than ${MAX_LABEL} characters`)
  return { to, label: text }
}

/**
 * A whole set of links, checked and put in a settled order (so the file does not churn and two
 * saves of the same links produce the same bytes).
 *
 * @param {object} raw            { "<nvr>/<ch>": [ { to, label } ] }
 * @param {Set<string>} [known]   the cameras that exist; when given, links are checked against it
 * @param {{ drop?: boolean }} [opts]  drop: leave out links to cameras that are not in `known`
 *                                     instead of refusing (used when reading a stored file, so one
 *                                     removed camera cannot make the whole file unusable)
 */
export function cleanLinks(raw, known, { drop = false } = {}) {
  if (!isPlainObject(raw)) throw new LinkError(400, 'links must be a JSON object of camera key -> neighbours')
  const entries = Object.entries(raw)
  if (entries.length > MAX_CAMERAS) throw new LinkError(400, `At most ${MAX_CAMERAS} cameras`)
  const out = {}
  for (const [from, list] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (typeof from !== 'string' || !KEY_RE.test(from)) {
      if (drop) continue
      throw new LinkError(400, `"${String(from).slice(0, 40)}" is not a camera key ("<nvr>/<channel>")`)
    }
    if (!Array.isArray(list)) {
      if (drop) continue
      throw new LinkError(400, `The neighbours of ${from} must be a list`)
    }
    if (drop && known && !known.has(from)) continue // the camera itself has gone
    if (list.length > MAX_NEIGHBOURS) throw new LinkError(400, `${from} has more than ${MAX_NEIGHBOURS} neighbours`)
    const seen = new Set()
    const kept = []
    for (const item of list) {
      let entry
      try {
        entry = cleanEntry(item, from, drop ? undefined : known)
      } catch (e) {
        if (drop && e instanceof LinkError) continue // damaged single entry: dropped, the rest stand
        throw e
      }
      if (drop && known && !known.has(entry.to)) continue // that camera has been removed
      if (seen.has(entry.to)) {
        if (drop) continue
        throw new LinkError(400, `${from} lists ${entry.to} twice`)
      }
      seen.add(entry.to)
      kept.push(entry)
    }
    if (kept.length) out[from] = kept.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0))
  }
  return out
}

/** A copy of links with one direction added or relabelled. */
function withEntry(links, from, to, label) {
  const list = (links[from] ?? []).filter((n) => n.to !== to)
  if (list.length + 1 > MAX_NEIGHBOURS) throw new LinkError(400, `${from} already has ${MAX_NEIGHBOURS} neighbours`)
  return { ...links, [from]: [...list, { to, label }] }
}

/**
 * Adds a link, two-way unless `oneWay`. Two-way is the default because a way out of one camera's
 * view is almost always a way back: if the yard leads to the gate, the gate leads to the yard.
 * Returns a new links object; the one passed in is not changed. Only the two cameras of the new link
 * are checked against `known`: the links already there stand as stored, so one of them naming a
 * camera of an NVR that is removed or not logged in yet does not refuse every new link.
 */
export function addLink(links, { from, to, label = '', oneWay = false }, known) {
  if (typeof from !== 'string' || !KEY_RE.test(from)) throw new LinkError(400, `"${String(from).slice(0, 40)}" is not a camera key ("<nvr>/<channel>")`)
  if (known && !known.has(from)) throw new LinkError(400, `There is no camera ${from}`)
  const b = cleanEntry({ to, label }, from, known) // checks the target, the self-link and the label
  let out = withEntry(links, from, b.to, b.label)
  // the same label both ways: "through the front door" describes the doorway, not a direction
  if (!oneWay) out = withEntry(out, b.to, from, b.label)
  return cleanLinks(out)
}

/** Removes a link. Both directions unless `oneWay`, which removes only from -> to. */
export function removeLink(links, { from, to, oneWay = false }) {
  const out = { ...links }
  const strip = (x, y) => {
    const list = (out[x] ?? []).filter((n) => n.to !== y)
    if (list.length) out[x] = list
    else delete out[x]
  }
  strip(from, to)
  if (!oneWay) strip(to, from)
  return out
}

/** Every camera `key` leads to, as the pages want it. */
export const neighboursOf = (links, key) => links[key] ?? []

// ---- suggestions -------------------------------------------------------------------------------

/** Metres per degree of longitude at a latitude, for the rough distance below. */
const M_PER_DEG = 111_320

/** Where a camera sits on a site map, in units the distances below can compare. */
function placement(map) {
  const mode = map?.mode === 'geo' ? 'geo' : 'plan'
  const cams = map?.[mode]?.cams
  if (!isPlainObject(cams)) return null
  const out = []
  for (const [key, c] of Object.entries(cams)) {
    if (!KEY_RE.test(key) || !isPlainObject(c)) continue
    if (mode === 'geo') {
      if (typeof c.lat !== 'number' || typeof c.lng !== 'number') continue
      out.push({ key, x: c.lng * Math.cos((c.lat * Math.PI) / 180) * M_PER_DEG, y: c.lat * M_PER_DEG })
    } else {
      if (typeof c.x !== 'number' || typeof c.y !== 'number') continue
      out.push({ key, x: c.x, y: c.y })
    }
  }
  return { mode, cams: out }
}

/**
 * The nearest few cameras to each placed camera, as a first guess at its neighbours. Same map only:
 * a straight-line distance means nothing between two different site plans.
 *
 * These are guesses, and they say so: every entry carries `suggested: true` and a `why`, and none
 * of this is ever written to the file. Only what a person confirms is stored.
 *
 * @param {object} map        one site's map, as maps.mjs stores it
 * @param {object} [links]    the confirmed links, so a pair already drawn is not offered again
 * @param {{ count?: number, known?: Set<string> }} [opts]
 * @returns {object} { "<nvr>/<ch>": [ { to, label: '', suggested: true, why, distance, units } ] }
 */
export function suggestNeighbours(map, links = {}, { count = SUGGEST_COUNT, known } = {}) {
  const p = placement(map)
  if (!p || p.cams.length < 2) return {}
  const units = p.mode === 'geo' ? 'metres' : 'plan pixels'
  const why = 'nearest camera on the map — a guess, not a drawn link'
  const out = {}
  for (const a of p.cams) {
    if (known && !known.has(a.key)) continue
    const already = new Set((links[a.key] ?? []).map((n) => n.to))
    const near = p.cams
      .filter((b) => b.key !== a.key && !already.has(b.key) && (!known || known.has(b.key)))
      .map((b) => ({ key: b.key, distance: Math.round(Math.hypot(a.x - b.x, a.y - b.y)) }))
      // nearest first; the key breaks a tie so the order is the same on every machine and every read
      .sort((m, n) => m.distance - n.distance || (m.key < n.key ? -1 : m.key > n.key ? 1 : 0))
      .slice(0, count)
    if (near.length) out[a.key] = near.map((n) => ({ to: n.key, label: '', suggested: true, why, distance: n.distance, units }))
  }
  return out
}

// ---- the file ----------------------------------------------------------------------------------

const warned = new Set()
const warnOnce = (msg) => {
  if (warned.has(msg)) return
  warned.add(msg)
  console.warn(msg)
}

/** Writes text as file: a temp file + rename (never half-written), mode 0600. */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  rmSync(tmp, { force: true }) // a leftover from a crash could have other permissions
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * The stored file, raw. A missing file is "none yet"; a file that cannot be read or does not parse
 * throws LinksUnavailable, because answering "no links" would let the next save wipe every link.
 */
function loadFile() {
  let text
  try {
    text = readFileSync(LINKS_FILE, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { links: {}, version: 0, text: null }
    warnOnce(`[camera-links] ${LINKS_FILE} unreadable (${e.code ?? e.message}); camera links are not read or saved until it is fixed`)
    throw new LinksUnavailable(`unreadable (${e.code ?? e.message})`)
  }
  try {
    const j = JSON.parse(text)
    if (isPlainObject(j)) {
      warned.clear()
      return { links: isPlainObject(j.links) ? j.links : {}, version: Number.isSafeInteger(j.version) && j.version >= 0 ? j.version : 0, text }
    }
  } catch {}
  warnOnce(`[camera-links] ${LINKS_FILE} is damaged; camera links are not read or saved until it is fixed (the previous good copy is ${LINKS_FILE}.bak)`)
  throw new LinksUnavailable('damaged')
}

/**
 * The stored links and their version. Links naming a camera that no longer exists are left out of
 * the answer — an NVR being swapped should not stop the follow strip working — but they stay in the
 * file until something is saved, so putting the camera back brings its links back with it.
 *
 * @param {Set<string>|string[]} [known] the cameras that exist (allCameras(); nothing is dropped without it)
 */
export function readLinks(known) {
  const { links, version } = loadFile()
  const set = known ? (known instanceof Set ? known : new Set(known)) : undefined
  return { links: cleanLinks(links, set, { drop: true }), version }
}

/**
 * Saves the links if the change was made on the latest version (read, checked and written in one
 * synchronous step, so no other request can come between them).
 * @param {{ stored?: boolean }} [opts]  stored: `links` is the file as it stands with one link added or
 *   removed (and that link already checked). The rest is written back as it was, not checked against
 *   `known`, and the answer leaves out links to cameras that are not there, as readLinks does.
 * @returns {{ saved: boolean, links: object, version: number }} the new state, or the latest when refused
 */
export function saveLinks(links, version, known, { stored = false } = {}) {
  const now = loadFile()
  if (version !== now.version) return { saved: false, links: cleanLinks(now.links, known, { drop: true }), version: now.version }
  const clean = cleanLinks(links, stored ? undefined : known)
  const next = now.version + 1
  mkdirSync(dirname(LINKS_FILE), { recursive: true })
  if (now.text) {
    try {
      writeAtomic(`${LINKS_FILE}.bak`, now.text)
    } catch (e) {
      console.warn(`[camera-links] ${LINKS_FILE}.bak not written: ${e.message}`)
    }
  }
  writeAtomic(LINKS_FILE, `${JSON.stringify({ version: next, links: clean }, null, 1)}\n`)
  return { saved: true, links: stored ? cleanLinks(clean, known, { drop: true }) : clean, version: next }
}

// ---- the requests ------------------------------------------------------------------------------

const isVersion = (v) => Number.isSafeInteger(v) && v >= 0

/**
 * GET /api/camera-links (anyone signed in) and PUT/POST /api/admin/camera-links (admins).
 * server.mjs does the same-origin and JSON checks for the admin write, as it does for every other one.
 *
 * @param {string} method
 * @param {string} pathname
 * @param {() => Promise<object>} readJson   the request's JSON object body
 * @param {{ admin?: boolean, cameras?: () => Array<{nvr: string, ch: number}>, maps?: () => object }} ctx
 *        cameras: the cameras that exist, maps: { sites: { ... } } for the suggestions
 * @returns {Promise<[number, any, object?] | null>} null when the path is not one of these routes
 */
export async function handleCameraLinks(method, pathname, readJson, { admin = false, cameras = () => [], maps = () => ({ sites: {} }) } = {}) {
  const known = () => new Set(cameras().map((c) => `${c.nvr}/${c.ch}`))
  if (pathname === LINKS_PATH) {
    if (method !== 'GET') return [405, { error: 'Method not allowed' }, { allow: 'GET' }]
    try {
      const set = known()
      const { links, version } = readLinks(set)
      const suggestions = {}
      for (const map of Object.values(maps()?.sites ?? {})) Object.assign(suggestions, suggestNeighbours(map, links, { known: set }))
      return [200, { links, version, suggestions }, NO_STORE]
    } catch (e) {
      if (e instanceof LinksUnavailable) return [500, { error: 'Camera links are unavailable (the file is damaged or unreadable)' }, NO_STORE]
      return [500, { error: `Cannot read camera links: ${e.message}` }, NO_STORE]
    }
  }
  if (pathname !== ADMIN_LINKS_PATH) return null
  if (!admin) return [403, { error: 'Only admins can change camera links' }]
  if (method !== 'PUT' && method !== 'POST') return [405, { error: 'Method not allowed' }, { allow: 'PUT, POST' }]
  try {
    const body = await readJson()
    if (!isPlainObject(body)) throw new LinkError(400, 'The body must be a JSON object')
    if (!isVersion(body.version)) throw new LinkError(400, 'version must be the version the change was made on (from GET /api/camera-links)')
    const set = known()
    let wanted
    if (method === 'PUT') {
      wanted = cleanLinks(body.links, set)
    } else {
      // one link at a time, so the map editor does not have to send the whole set back
      const { links } = readLinks() // the file as it stands, not the pruned answer
      const oneWay = body.oneWay === true
      if (body.action === 'link') wanted = addLink(links, { from: body.from, to: body.to, label: body.label, oneWay }, set)
      else if (body.action === 'unlink') wanted = removeLink(links, { from: String(body.from ?? ''), to: String(body.to ?? ''), oneWay })
      else throw new LinkError(400, 'action must be link or unlink')
    }
    // (POST: only the link asked for was checked against the cameras; a stored link to a removed or
    // not-yet-logged-in NVR's camera refused every link and unlink with a 400)
    const { saved, links, version } = saveLinks(wanted, body.version, set, { stored: method === 'POST' })
    if (!saved) return [409, { error: 'The camera links were changed on another screen', links, version }, NO_STORE]
    return [200, { links, version }, NO_STORE]
  } catch (e) {
    if (e instanceof LinkError) return [e.status, { error: e.message }]
    if (e instanceof LinksUnavailable) return [500, { error: 'Camera links are unavailable (the file is damaged or unreadable)' }]
    if (e instanceof SyntaxError) return [400, { error: 'Bad JSON' }]
    console.error(`[camera-links] ${e.stack ?? e}`)
    return [500, { error: 'The camera links could not be saved' }]
  }
}
