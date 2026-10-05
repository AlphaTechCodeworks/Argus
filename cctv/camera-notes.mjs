// What this app notes about cameras for Auto adjust. App data only: nothing here is ever sent
// to a camera or an NVR.
//
//   data/camera-notes.json
//     { site: { "<site>": { mains: '50' | '60' | null } },
//       cameras: { "<device>|<chlId>": { location: 'outdoor' | 'covered' | 'indoor' | null,
//                                       seen: [{ at, cfgFile }], focusRef: { rise25, at }, monoNightAt } } }
//   - location: set by an admin; gates the colour rules (indoor light does not follow the sun).
//   - mains: the site's mains frequency, set by an admin (anti-flicker needs it).
//   - seen: which profile the camera reported as in use, and when. Cameras that switch
//     profiles by themselves (program auto/time) are trusted to report the right one only
//     after they were seen on both Day and Night (North Gate still said "Day" at 19:00).
//   - focusRef: a daytime edge-sharpness figure, to compare later measurements with.
//   - monoNightAt: last time the camera was measured black-and-white at night (the Day/Night
//     set-up is only useful on cameras that really go to infrared at night).
//   data/picture-figures.log: the panel's measurements (numbers only), one JSON line each, for
//     calibrating the rules later. Shortened above 1 MB.
//
//   GET  /api/admin/nvrs/:id/channels/:ch/notes      -> { location, seen, focusRef, monoNightAt, mains, site }
//   POST /api/admin/nvrs/:id/channels/:ch/notes      { location, confirm: true }
//   GET  /api/admin/nvrs/:id/channels/:ch/figures    -> { figures: [last 24 h, newest first] }
//   POST /api/admin/nvrs/:id/channels/:ch/figures    { device, period, profile, stream, width, height, codec?, settingsHash?, displayCheck?, figures }
//   GET  /api/admin/sites/:site/notes                -> { site, mains }
//   POST /api/admin/sites/:site/notes                { mains, confirm: true }
//
// The same file also holds the on-screen display the app draws over the picture (public/osd-overlay.js):
//     { osd: { default: <settings>, cameras: { "<nvr>/<ch>": <settings> } } }
//   - This is app data like everything else here: nothing is ever sent to a camera or an NVR. The
//     NVR's own OSD calls exist but both our NVRs refuse them outright, and drawing it ourselves is
//     better anyway (see the top of public/osd-overlay.js for why).
//   - It is keyed by "<nvr>/<ch>" rather than by "<device>|<chlId>" like the camera notes above,
//     because these settings are read and written by the pages, which speak in NVR ids and channel
//     numbers, exactly as camera-links.mjs does. The notes above are keyed by the NVR's hardware
//     address because they outlive an NVR being re-added; an overlay position is cheap to set again.
//   GET  /api/osd          -> { default, cameras }   (everyone signed in: every page draws it; a
//                             viewer gets only the cameras they may see, as the text is a name)
//   PUT  /api/admin/osd    { default?, cameras? }    (admins; a camera set to null goes back to the default)
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR } from './auth.mjs'
import { HttpError, cameraOf, deviceOf, errorAnswer, isPlainObject, readLogCached, rotateLog } from './nvr-xml.mjs'
import { nvrs } from './nvrs.mjs'
import { siteOffsetMin } from './site-time.mjs'
import { DEFAULT_OSD, cleanOsdSettings, osdFor } from './public/osd-overlay.js'

const NOTES_FILE = join(DATA_DIR, 'camera-notes.json')
export const FIGURES_FILE = join(DATA_DIR, 'picture-figures.log')
const LOCATIONS = ['outdoor', 'covered', 'indoor']
const MAINS = ['50', '60']
const SEEN_MAX = 50
const SEEN_EVERY_MS = 60 * 60_000 // a profile report is noted when it changes, or once an hour
const VERIFIED_WITHIN_MS = 30 * 24 * 3600_000
const FIGURES_BACK_MS = 24 * 3600_000

export const cameraKey = (device, chlId) => `${device}|${chlId}`

// ---- the notes file ------------------------------------------------------------------------

let cache = null // { key, notes }
function load() {
  let key = 'none'
  try {
    const st = statSync(NOTES_FILE)
    key = `${st.size}:${st.mtimeMs}`
  } catch {}
  if (cache?.key === key) return cache.notes
  let notes = { site: {}, cameras: {}, osd: { default: null, cameras: {} } }
  if (key !== 'none') {
    try {
      const j = JSON.parse(readFileSync(NOTES_FILE, 'utf8'))
      if (isPlainObject(j))
        notes = {
          site: isPlainObject(j.site) ? j.site : {},
          cameras: isPlainObject(j.cameras) ? j.cameras : {},
          osd: {
            default: isPlainObject(j.osd?.default) ? j.osd.default : null,
            cameras: isPlainObject(j.osd?.cameras) ? j.osd.cameras : {}
          }
        }
    } catch (e) {
      console.warn(`[notes] ${NOTES_FILE} unreadable (${e.message}); starting empty`)
    }
  }
  cache = { key, notes }
  return notes
}

/** Applies fn to the notes and writes them (temp file + rename, never a half-written file). */
function update(fn) {
  const notes = structuredClone(load())
  fn(notes)
  mkdirSync(dirname(NOTES_FILE), { recursive: true })
  const tmp = `${NOTES_FILE}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(notes, null, 1), { mode: 0o600 })
  renameSync(tmp, NOTES_FILE)
  cache = null
  return notes
}

const blank = () => ({ location: null, seen: [], focusRef: null, monoNightAt: null })

/** This camera's notes (a copy). */
export function cameraNotes(device, chlId) {
  return { ...blank(), ...(load().cameras[cameraKey(device, chlId)] ?? {}) }
}

/** The site's notes. */
export const siteNotes = (site) => ({ mains: load().site[site]?.mains ?? null })

/**
 * Notes which profile the camera reports as in use (from an unconditioned read). Only for
 * cameras that switch profiles by themselves; noted when it changes, or once an hour.
 * Never throws: a note that can't be saved must not stop a settings read.
 */
export function noteSeen(device, chlId, cfgFile, program, now = Date.now()) {
  if (!cfgFile || !program || program === 'normal') return
  try {
    const last = cameraNotes(device, chlId).seen.at(-1)
    if (last && last.cfgFile === cfgFile && now - Date.parse(last.at) < SEEN_EVERY_MS) return
    update((n) => {
      const c = (n.cameras[cameraKey(device, chlId)] ??= blank())
      c.seen = [...(c.seen ?? []), { at: new Date(now).toISOString(), cfgFile }].slice(-SEEN_MAX)
    })
  } catch (e) {
    console.warn(`[notes] profile report not noted: ${e.message}`)
  }
}

/**
 * Is the camera's own report of the profile in use trustworthy? Yes when it always uses one
 * profile (program normal, or no profiles); for cameras that switch by themselves only once
 * they were seen reporting both Day and Night within 30 days.
 */
export function activeVerified(device, chlId, program, now = Date.now()) {
  if (!program || program === 'normal') return true
  const recent = cameraNotes(device, chlId).seen.filter((s) => now - Date.parse(s.at) < VERIFIED_WITHIN_MS)
  return recent.some((s) => s.cfgFile === 'day') && recent.some((s) => s.cfgFile === 'night')
}

// ---- figures ---------------------------------------------------------------------------------

/** Numbers, booleans, null and short labels only, one level of nesting, short number lists. */
function cleanFigures(v, depth = 0) {
  if (!isPlainObject(v)) throw new HttpError(400, 'figures must be an object')
  const out = {}
  for (const [k, x] of Object.entries(v)) {
    if (!/^[A-Za-z][\w.-]{0,39}$/.test(k)) throw new HttpError(400, `figures: bad name "${k.slice(0, 40)}"`)
    if (x === null || typeof x === 'boolean') out[k] = x
    else if (typeof x === 'number') {
      if (!Number.isFinite(x)) throw new HttpError(400, `figures: ${k} is not a number`)
      out[k] = x
    } else if (typeof x === 'string' && x.length <= 40) out[k] = x
    else if (Array.isArray(x) && x.length <= 32 && x.every((n) => typeof n === 'number' && Number.isFinite(n))) out[k] = x
    else if (isPlainObject(x) && depth === 0) out[k] = cleanFigures(x, 1)
    else throw new HttpError(400, `figures: ${k} is not a number, flag or short label`)
  }
  return out
}

const short = (v, re) => (typeof v === 'string' && re.test(v) ? v : null)

function recordFigures(nvr, ch, chlId, name, body, user) {
  const figures = cleanFigures(body.figures)
  const device = deviceOf(nvr)
  const width = Number.isInteger(body.width) ? body.width : null
  const entry = {
    at: new Date().toISOString(),
    user,
    nvr: nvr.id,
    device,
    chl: chlId,
    ch: ch + 1,
    name,
    profile: short(body.profile, /^[A-Za-z]{1,16}$/),
    period: short(body.period, /^(day|dusk|night)$/),
    stream: short(body.stream, /^(main|sub)$/),
    width,
    height: Number.isInteger(body.height) ? body.height : null,
    codec: short(body.codec, /^[\w.+-]{1,16}$/),
    settingsHash: short(body.settingsHash, /^[\w-]{1,64}$/),
    displayCheck: short(body.displayCheck, /^[\w-]{1,24}$/),
    figures
  }
  mkdirSync(dirname(FIGURES_FILE), { recursive: true })
  appendFileSync(FIGURES_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  rotateLog(FIGURES_FILE)
  // what the notes learn from it
  const notes = cameraNotes(device, chlId)
  const mono = figures.mono === true
  const lit = entry.period === 'day' || (notes.location === 'indoor' && figures.mono === false && typeof figures.mean === 'number' && figures.mean >= 90)
  const focus = lit && width >= 1920 && entry.stream !== 'sub' && typeof figures.rise25 === 'number'
  if ((entry.period === 'night' && mono) || focus) {
    update((n) => {
      const c = (n.cameras[cameraKey(device, chlId)] ??= blank())
      if (entry.period === 'night' && mono) c.monoNightAt = entry.at
      if (focus) c.focusRef = { rise25: figures.rise25, at: entry.at }
    })
  }
  return entry
}

/** This camera's figures of the last 24 hours, newest first (at most 50). */
export function recentFigures(device, chlId, now = Date.now()) {
  return readLogCached(FIGURES_FILE)
    .filter((e) => e.device === device && e.chl === chlId && now - Date.parse(e.at) < FIGURES_BACK_MS)
    .slice(-50)
    .reverse()
}

// ---- the overlay this app draws (public/osd-overlay.js) ----------------------------------------

export const OSD_PATH = '/api/osd'
export const ADMIN_OSD_PATH = '/api/admin/osd'
/** The same camera key every page and camera-links.mjs uses. */
const OSD_KEY_RE = /^[A-Za-z0-9._-]{1,64}\/\d{1,4}$/
const MAX_OSD_CAMERAS = 512

/**
 * The overlay settings as the pages want them: the site-wide default, already filled in, and only
 * those cameras that have been given something of their own. Cameras are NOT expanded to one entry
 * each — a site with 68 cameras that all use the default should send 68 nothings, not 68 copies —
 * so a page merges a camera over the default itself (osdFor).
 */
export function osdSettings() {
  const stored = load().osd ?? {}
  const dflt = cleanOsdSettings(stored.default ?? null)
  const cameras = {}
  for (const [key, v] of Object.entries(stored.cameras ?? {})) {
    if (!OSD_KEY_RE.test(key)) continue // a damaged entry is skipped, not allowed to fail the read
    try {
      cameras[key] = osdFor(dflt, v)
    } catch {
      // Same reasoning as camera-links.mjs: reading drops a damaged entry rather than leaving every
      // page without an overlay; writing one is refused outright, below.
    }
  }
  return { default: dflt, cameras }
}

/**
 * /api/osd (read, everyone signed in) and /api/admin/osd (write, admins).
 *
 * There is no version check here, unlike camera-links.mjs. That is deliberate: a link drawn between
 * two cameras is a fact two admins can genuinely disagree about, whereas an overlay position is a
 * preference, is visible the moment it is wrong, and is fixed by dragging it again. A version check
 * would only make the panel harder to use for no real protection.
 *
 * @param {string} method
 * @param {string} pathname
 * @param {() => Promise<any>} readJson
 * @param {{ admin?: boolean, canSee?: (nvr: string, ch: number) => boolean }} ctx canSee: which
 *   cameras this person may watch or play back (server.mjs, rights.mjs); missing, none
 * @returns {Promise<null | [number, any, object?]>} null when the path is not ours
 */
export async function handleOsd(method, pathname, readJson, ctx = {}) {
  if (pathname !== OSD_PATH && pathname !== ADMIN_OSD_PATH) return null
  try {
    if (pathname === OSD_PATH) {
      if (method !== 'GET') return [405, { error: 'Method not allowed' }]
      // Never cached: an overlay moved on one screen should be right on the next page load.
      const all = osdSettings()
      // The live OSD clock must read the site's wall time, not the viewing PC's zone (a screen set
      // to UTC otherwise drew UTC over the picture). site-time.mjs: the NVRs' zone, else the env.
      const siteTzMin = siteOffsetMin()
      if (ctx.admin === true) return [200, { ...all, siteTzMin }, { 'cache-control': 'no-store' }]
      // default deny: an overlay's text is a camera's name, so anyone else gets only the cameras
      // they may see (and the default, which every page draws with)
      const see = typeof ctx.canSee === 'function' ? ctx.canSee : () => false
      const cameras = Object.fromEntries(Object.entries(all.cameras).filter(([k]) => {
        const slash = k.lastIndexOf('/')
        return slash > 0 && see(k.slice(0, slash), Number(k.slice(slash + 1)))
      }))
      return [200, { default: all.default, cameras, siteTzMin }, { 'cache-control': 'no-store' }]
    }
    if (!ctx.admin) return [403, { error: 'Only admins can change the overlay' }]
    if (method !== 'PUT') return [405, { error: 'Method not allowed' }]
    const body = await readJson()
    if (!isPlainObject(body)) throw new HttpError(400, 'The request must be a JSON object')

    let dflt
    if (body.default !== undefined) {
      try {
        dflt = cleanOsdSettings(body.default)
      } catch (e) {
        throw new HttpError(400, e.message)
      }
    }
    const patch = {}
    if (body.cameras !== undefined) {
      if (!isPlainObject(body.cameras)) throw new HttpError(400, 'cameras must be an object of "<nvr>/<ch>" settings')
      const keys = Object.keys(body.cameras)
      if (keys.length > MAX_OSD_CAMERAS) throw new HttpError(400, `more than ${MAX_OSD_CAMERAS} cameras in one change`)
      for (const key of keys) {
        if (!OSD_KEY_RE.test(key)) throw new HttpError(400, `bad camera "${key.slice(0, 40)}"; it must be "<nvr>/<channel>"`)
        const v = body.cameras[key]
        if (v === null) {
          patch[key] = null // back to the default
          continue
        }
        try {
          patch[key] = cleanOsdSettings(v, { base: dflt ?? cleanOsdSettings(load().osd?.default ?? null) })
        } catch (e) {
          throw new HttpError(400, `${key}: ${e.message}`)
        }
      }
    }

    update((n) => {
      n.osd ??= { default: null, cameras: {} }
      if (dflt) n.osd.default = dflt
      for (const [key, v] of Object.entries(patch)) {
        if (v === null) delete n.osd.cameras[key]
        else n.osd.cameras[key] = v
      }
    })
    return [200, osdSettings()]
  } catch (e) {
    return errorAnswer(e)
  }
}

// ---- API -------------------------------------------------------------------------------------

/**
 * /channels/:ch/notes and /channels/:ch/figures.
 * @param {'notes' | 'figures'} what
 * @returns {Promise<[number, any]>}
 */
export async function handleCameraNotes(what, method, nvrId, ch, readJson, user) {
  try {
    const { nvr, chlId, name } = cameraOf(nvrs, nvrId, ch)
    const device = deviceOf(nvr)
    if (method === 'GET') {
      if (what === 'figures') return [200, { figures: recentFigures(device, chlId) }]
      return [200, { ...cameraNotes(device, chlId), site: nvr.site, mains: siteNotes(nvr.site).mains }]
    }
    if (method !== 'POST') return [405, { error: 'Method not allowed' }]
    const body = await readJson()
    if (!isPlainObject(body)) throw new HttpError(400, 'The request must be a JSON object')
    if (what === 'figures') {
      if (body.device !== device) throw new HttpError(409, 'These figures are for another NVR address; reopen the panel')
      recordFigures(nvr, ch, chlId, name, body, user)
      return [200, { ok: true, notes: cameraNotes(device, chlId) }]
    }
    if (body.confirm !== true) throw new HttpError(400, 'Changes need confirm: true')
    const location = body.location ?? null
    if (location !== null && !LOCATIONS.includes(location)) throw new HttpError(400, `location must be one of ${LOCATIONS.join(', ')}, or null`)
    update((n) => {
      const c = (n.cameras[cameraKey(device, chlId)] ??= blank())
      c.location = location
    })
    return [200, { ...cameraNotes(device, chlId), site: nvr.site, mains: siteNotes(nvr.site).mains }]
  } catch (e) {
    return errorAnswer(e)
  }
}

/** /api/admin/sites/:site/notes */
export async function handleSiteNotes(method, site, readJson) {
  try {
    if (typeof site !== 'string' || site.length === 0 || site.length > 64) throw new HttpError(400, 'Bad site')
    if (method === 'GET') return [200, { site, ...siteNotes(site) }]
    if (method !== 'POST') return [405, { error: 'Method not allowed' }]
    const body = await readJson()
    if (!isPlainObject(body)) throw new HttpError(400, 'The request must be a JSON object')
    if (body.confirm !== true) throw new HttpError(400, 'Changes need confirm: true')
    const mains = body.mains ?? null
    if (mains !== null && !MAINS.includes(mains)) throw new HttpError(400, 'mains must be "50", "60" or null')
    update((n) => {
      n.site[site] = { ...(n.site[site] ?? {}), mains }
    })
    return [200, { site, ...siteNotes(site) }]
  } catch (e) {
    return errorAnswer(e)
  }
}

// for the offline tests
export const _test = { cleanFigures, recordFigures, NOTES_FILE, DEFAULT_OSD }
