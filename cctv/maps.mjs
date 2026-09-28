// Site maps: where each camera is and what it covers, on a site plan image or a
// street/satellite map. Stored in data/maps.json; plan images in data/maps/.
//
//   GET  /api/maps                         -> { sites: { [site]: SiteMap } }   (everyone signed in: an
//                                             admin every site; anyone else only the sites and camera
//                                             placements they may see, mapsFor)
//   GET  /api/maps/plan/<file>             -> the plan image (of a site the user is shown)
//   PUT  /api/admin/maps/<site>            { mode, plan: { cams }, geo: { lat, lng, zoom, layer, cams } }
//   POST /api/admin/maps/<site>/plan       { data: "data:image/jpeg;base64,...", w, h }  -> new plan image
//
// SiteMap: { mode: 'plan' | 'geo',
//            plan: { file, w, h, cams: { "nvr/ch": { x, y, dir, fov, range } } },          (image pixels)
//            geo:  { lat, lng, zoom, layer: 'street' | 'satellite',
//                    cams: { "nvr/ch": { lat, lng, dir, fov, range } } } }                  (range in metres)
// dir: degrees clockwise from up/north; fov: degrees.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './auth.mjs'

const MAPS_FILE = join(DATA_DIR, 'maps.json')
const PLANS_DIR = join(DATA_DIR, 'maps')
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_CAMS = 512
const PLAN_FILE_RE = /^[a-f0-9]{16}\.jpg$/
const CAM_KEY_RE = /^[a-z0-9-]{1,40}\/\d{1,3}$/

export const SAVE_LIMIT = 512 * 1024 // request body limits
export const UPLOAD_LIMIT = 17 * 1024 * 1024 // base64 of MAX_IMAGE_BYTES plus JSON

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Every site's map, as stored. Exported for camera-links.mjs, which suggests neighbours from it. */
export const readMaps = () => {
  if (!existsSync(MAPS_FILE)) return { sites: {} }
  const data = JSON.parse(readFileSync(MAPS_FILE, 'utf8'))
  return { sites: data && typeof data.sites === 'object' && data.sites ? data.sites : {} }
}

/** Written to a temporary file first, so a crash mid-write can't leave half a file. */
const writeMaps = (maps) => {
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${MAPS_FILE}.tmp`
  writeFileSync(tmp, `${JSON.stringify(maps, null, 1)}\n`, { mode: 0o600 })
  renameSync(tmp, MAPS_FILE)
}

const num = (v, min, max, what) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `Bad ${what}`)
  return Math.round(v * 1e6) / 1e6
}

const cleanCams = (input, mode, plan) => {
  const out = {}
  if (input === undefined) return out
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Bad camera list')
  const entries = Object.entries(input)
  if (entries.length > MAX_CAMS) throw new HttpError(400, 'Too many cameras')
  for (const [key, c] of entries) {
    if (!CAM_KEY_RE.test(key) || !c || typeof c !== 'object') throw new HttpError(400, 'Bad camera')
    const cone = {
      dir: num(c.dir, -360, 720, 'direction') % 360,
      fov: num(c.fov, 1, 360, 'field of view'),
      range: mode === 'geo' ? num(c.range, 1, 5000, 'range') : num(c.range, 1, 20_000, 'range')
    }
    if (cone.dir < 0) cone.dir += 360
    out[key] =
      mode === 'geo'
        ? { lat: num(c.lat, -85, 85, 'latitude'), lng: num(c.lng, -180, 180, 'longitude'), ...cone }
        : { x: num(c.x, 0, plan?.w ?? 0, 'position'), y: num(c.y, 0, plan?.h ?? 0, 'position'), ...cone }
  }
  return out
}

/** A site's map from the page, checked; the plan image itself only changes by upload. */
const cleanSite = (input, existing = {}) => {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Bad map')
  const mode = input.mode === 'geo' ? 'geo' : 'plan'
  const out = { mode }
  // a part the page didn't send is kept as it was
  if (existing.plan?.file) {
    out.plan = { ...existing.plan, cams: input.plan ? cleanCams(input.plan.cams, 'plan', existing.plan) : existing.plan.cams ?? {} }
  }
  if (!input.geo && existing.geo) out.geo = existing.geo
  if (input.geo) {
    const g = input.geo
    out.geo = {
      lat: num(g.lat, -85, 85, 'latitude'),
      lng: num(g.lng, -180, 180, 'longitude'),
      zoom: num(g.zoom, 0, 21, 'zoom'),
      layer: g.layer === 'satellite' ? 'satellite' : 'street',
      cams: cleanCams(g.cams, 'geo')
    }
  }
  if (mode === 'plan' && !out.plan) throw new HttpError(400, 'Upload a site plan first')
  return out
}

const siteName = (raw) => {
  let name
  try {
    name = decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, 'Bad site name')
  }
  if (!name || name.length > 64) throw new HttpError(400, 'Bad site name')
  return name
}

/** Removes plan images no site uses any more. */
const pruneImages = (maps) => {
  const used = new Set(Object.values(maps.sites).map((s) => s?.plan?.file).filter(Boolean))
  if (!existsSync(PLANS_DIR)) return
  for (const f of readdirSync(PLANS_DIR)) {
    if (PLAN_FILE_RE.test(f) && !used.has(f)) {
      try {
        unlinkSync(join(PLANS_DIR, f))
      } catch {}
    }
  }
}

const savePlan = (name, body) => {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(body?.data ?? ''))
  if (!m) throw new HttpError(400, 'Send the plan as a JPEG image')
  const buf = Buffer.from(m[1], 'base64')
  if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'The image is too large (max 12 MB)')
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw new HttpError(400, 'Not a JPEG image')
  const w = Math.round(num(body.w, 1, 8192, 'image width'))
  const h = Math.round(num(body.h, 1, 8192, 'image height'))
  const file = `${createHash('sha256').update(buf).digest('hex').slice(0, 16)}.jpg`
  mkdirSync(PLANS_DIR, { recursive: true })
  writeFileSync(join(PLANS_DIR, file), buf, { mode: 0o600 })

  const maps = readMaps()
  const site = maps.sites[name] ?? {}
  // a new plan of a different size: keep the cameras where they were, relative to the picture
  const old = site.plan
  const cams = {}
  if (old?.cams && old.w && old.h) {
    const sx = w / old.w
    const sy = h / old.h
    for (const [k, c] of Object.entries(old.cams)) cams[k] = { ...c, x: c.x * sx, y: c.y * sy, range: c.range * Math.sqrt(sx * sy) }
  }
  maps.sites[name] = { ...site, mode: 'plan', plan: { file, w, h, cams } }
  writeMaps(maps)
  pruneImages(maps)
  return maps.sites[name]
}

/**
 * What one user may see of the maps: a site only when they may see a camera at it, and in it only
 * their own cameras' placements (on the plan and on the street map alike). A placement is where a
 * camera is and what it covers, and so where it does not. null = an admin, who sees everything.
 * @param {{ sites: object }} maps
 * @param {{ canSee: (nvr: string, ch: number) => boolean, siteVisible: (site: string) => boolean } | null} view
 */
export const mapsFor = (maps, view) => {
  if (!view) return maps
  const keep = (cams) => Object.fromEntries(Object.entries(cams ?? {}).filter(([k]) => {
    const slash = k.lastIndexOf('/')
    return slash > 0 && view.canSee(k.slice(0, slash), Number(k.slice(slash + 1)))
  }))
  const sites = {}
  for (const [name, s] of Object.entries(maps.sites)) {
    if (!s || !view.siteVisible(name)) continue
    sites[name] = { ...s, ...(s.plan && { plan: { ...s.plan, cams: keep(s.plan.cams) } }), ...(s.geo && { geo: { ...s.geo, cams: keep(s.geo.cams) } }) }
  }
  return { sites }
}

/**
 * Serves GET /api/maps and GET /api/maps/plan/<file>. Returns false if the path is not a maps path.
 * @param {(res, status, data) => void} sendJson
 * @param {Parameters<typeof mapsFor>[1]} [view] what this user may see (mapsFor); null for an admin
 */
export function handleMapsRead(pathname, res, sendJson, headers, view = null) {
  if (pathname === '/api/maps') {
    try {
      sendJson(res, 200, mapsFor(readMaps(), view))
    } catch (e) {
      sendJson(res, 500, { error: `Cannot read maps: ${e.message}` })
    }
    return true
  }
  if (pathname.startsWith('/api/maps/plan/')) {
    const file = pathname.slice('/api/maps/plan/'.length)
    const path = join(PLANS_DIR, file)
    // another site's plan is 404 as well, so a guessed name does not even confirm the file exists
    let mine = true
    try {
      mine = !view || Object.values(mapsFor(readMaps(), view).sites).some((s) => s?.plan?.file === file)
    } catch {
      mine = false
    }
    if (!PLAN_FILE_RE.test(file) || !mine || !existsSync(path)) {
      res.writeHead(404, headers).end('Not found')
      return true
    }
    // named by content hash: never changes, cache for good
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable', ...headers })
    createReadStream(path).pipe(res)
    return true
  }
  return false
}

/**
 * Admin writes under /api/admin/maps/<site>[/plan].
 * @returns {Promise<[number, any]>}
 */
export async function handleMapsAdmin(method, pathname, readJson) {
  try {
    const rest = pathname.slice('/api/admin/maps/'.length)
    const planUpload = rest.endsWith('/plan')
    const name = siteName(planUpload ? rest.slice(0, -'/plan'.length) : rest)
    if (planUpload && method === 'POST') {
      const site = savePlan(name, await readJson())
      console.log(`[maps] new plan for "${name}" (${site.plan.w}x${site.plan.h})`)
      return [200, site]
    }
    if (!planUpload && method === 'PUT') {
      const maps = readMaps()
      const site = cleanSite(await readJson(), maps.sites[name])
      maps.sites[name] = site
      writeMaps(maps)
      const count = Object.keys(site[site.mode]?.cams ?? {}).length
      console.log(`[maps] saved "${name}" (${site.mode}, ${count} cameras placed)`)
      return [200, site]
    }
    return [405, { error: 'Method not allowed' }]
  } catch (e) {
    if (e instanceof HttpError) return [e.status, { error: e.message }]
    if (e instanceof SyntaxError) return [400, { error: 'Bad JSON' }]
    console.error(`[maps] ${e.stack ?? e}`)
    return [500, { error: e.message }]
  }
}
