// The one map: every site's cameras on a single street/satellite map, and the sites you move
// between on it. This module is the thinking behind that page and nothing else -- which sites
// there are and whether each has been placed, the badge a site collapses into when you are zoomed
// too far out to tell its cameras apart, where to fly to for a site or for everything, where
// unplaced cameras are dropped when a site is first placed, and what a save sends. map.js paints
// what this returns, the same split map-cameras.js has, so all of it is tested with no browser.
//
// Nothing here decides what a person may see: the page is handed only the sites and placements
// GET /api/maps gave this user (maps.mjs mapsFor), and works with those.
//
// Stored data is used as it is. A site's place on the one map is the lat/lng its geo block has
// always had; a site saved as a plan with no geo block simply is not placed yet, and its plan
// still opens as before.
import { MAX_LAT, STATES, boundsOf, clamp, latToY, lngToX, metresPerUnit, worstState, xToLng, yToLat } from './map-cameras.js'

/** At this zoom and closer a site always shows its cameras, however close together they are. */
export const DETAIL_ZOOM = 17
/** Further out than that, a site whose cameras span fewer pixels than this is drawn as one badge. */
export const BADGE_SPAN = 90
/** The closest a fit will go: the last zoom the tile servers have pictures for. */
const FIT_MAX_ZOOM = 19
const FIT_MIN_ZOOM = 1
/** The zoom a newly placed site is saved with, and flown to: close enough to see a building. */
export const PLACE_ZOOM = 18

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

// ---- cone colours (admin-assigned groups) -------------------------------------------------------
//
// An admin may colour a camera's VIEW CONE by a named group, or with a per-camera override, while
// the camera's recording status stays on the small marker dot (so green/amber/red for
// recording/degraded/offline is never lost). A camera with no colour of its own keeps today's cone
// (coloured by status), so old stored data needs no migration: no group, no override, no change.
//
// Storage: a site's geo block may carry `groups: [{ id, name, color, opacity? }]`, and a placement
// may carry `group` (a group id) or `color` (a direct hex override). Groups are a street-map
// feature; a plan camera can still carry a direct `color`.

/** The most groups one site may define: enough to label a real site, small enough to stay bounded. */
export const MAX_GROUPS = 32
/** The cone fill opacity used when a group gives no opacity of its own. Matches today's blue cone. */
export const DEFAULT_CONE_OPACITY = 0.2

/** A CSS hex colour, #rgb or #rrggbb. Nothing else is let near a stored map or an inline style. */
export const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
export const isHexColor = (s) => typeof s === 'string' && HEX_RE.test(s)

/**
 * The cone colour a placement resolves to: its own `color` override first, then its `group`'s
 * colour, then null for "no colour of its own" (the caller leaves today's status-coloured cone).
 * @param {{group?: string, color?: string}|null|undefined} placement
 * @param {{id: string, name?: string, color: string, opacity?: number}[]} groups the site's groups
 * @returns {{ color: string, opacity: number }|null}
 */
export function coneStyle(placement, groups = []) {
  if (isHexColor(placement?.color)) return { color: placement.color, opacity: DEFAULT_CONE_OPACITY }
  const id = placement?.group
  if (id === undefined || id === null || id === '') return null
  const g = (groups ?? []).find((x) => x && x.id === id)
  if (!g || !isHexColor(g.color)) return null
  const opacity = isNum(g.opacity) && g.opacity > 0 && g.opacity <= 1 ? g.opacity : DEFAULT_CONE_OPACITY
  return { color: g.color, opacity }
}

/**
 * A site's groups, cleaned for storage and for the edit UI: each one a { id, name, color } (and an
 * optional opacity), ids unique, colours valid hex, capped at MAX_GROUPS. `strict` throws on the
 * first bad entry (the server, which must reject junk); otherwise bad entries are dropped (the
 * page, which must still draw). A group whose colour is not hex is never kept: an invalid colour is
 * not a colour.
 * @param {unknown} input
 * @param {{ strict?: boolean, max?: number }} [opts]
 * @returns {{ id: string, name: string, color: string, opacity?: number }[]}
 */
export function cleanGroups(input, { strict = false, max = MAX_GROUPS } = {}) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) {
    if (strict) throw new Error('Groups must be a list')
    return []
  }
  if (input.length > max) {
    if (strict) throw new Error(`Too many groups (max ${max})`)
    input = input.slice(0, max)
  }
  const out = []
  const seen = new Set()
  for (const g of input) {
    const bad = (msg) => { if (strict) throw new Error(msg) }
    if (!g || typeof g !== 'object') { bad('Bad group'); continue }
    const id = String(g.id ?? '').slice(0, 40)
    if (!id || seen.has(id)) { bad('Bad or duplicate group id'); continue }
    if (!isHexColor(g.color)) { bad(`Bad colour for group "${id}"`); continue }
    seen.add(id)
    const entry = { id, name: String(g.name ?? '').slice(0, 60), color: g.color }
    if (isNum(g.opacity) && g.opacity > 0 && g.opacity <= 1) entry.opacity = Math.round(g.opacity * 100) / 100
    out.push(entry)
  }
  return out
}

// ---- live lighting (motion / alarm) -------------------------------------------------------------
//
// A marker reacts when something happens on its camera. The page polls GET /api/events (newest
// first, already filtered to the cameras this user may see) and asks which markers are "active":
// a brief motion pulse, or a stronger alarm highlight that lingers. Offline is folded in by the
// caller from the health poll it already has, so a camera the server cannot reach rings too.

/**
 * The event kinds that light a marker with the stronger, lingering alarm highlight rather than the
 * brief motion pulse. 'motion' is deliberately not here: motion is the quiet, common thing and gets
 * its own short pulse. Kinds the app cannot actually produce yet are left out.
 */
export const ALARM_EVENT_TYPES = Object.freeze([
  'line-crossing', 'tamper', 'sensor', 'ai', 'face', 'pos', 'video-loss', 'camera-offline', 'nvr-event'
])

/**
 * Which markers are active, from the latest events and a decay window. Pure: the same events and
 * the same `now` always give the same answer, so it is tested with no clock and no DOM.
 *
 * An event in the future (a clock skew) is ignored rather than lit forever. A key is in `motion`
 * while a motion event on it is younger than `motionMs`, and in `alarm` while an alarm-kind event
 * on it is younger than `alarmMs`; the same key can be in both.
 *
 * @param {{nvr: string, ch: number, type: string, startMs: number}[]} events from GET /api/events
 * @param {{ now?: number, motionMs?: number, alarmMs?: number, alarmTypes?: readonly string[] }} [opts]
 * @returns {{ motion: Set<string>, alarm: Set<string> }} keyed "nvr/ch"
 */
export function activeMarkers(events, { now = Date.now(), motionMs = 6000, alarmMs = 60_000, alarmTypes = ALARM_EVENT_TYPES } = {}) {
  const motion = new Set()
  const alarm = new Set()
  const alarmSet = alarmTypes instanceof Set ? alarmTypes : new Set(alarmTypes)
  for (const e of events ?? []) {
    if (!e || e.nvr === undefined || e.ch === undefined) continue
    const t = Number(e.startMs)
    if (!Number.isFinite(t)) continue
    const age = now - t
    if (age < 0) continue
    const key = `${e.nvr}/${e.ch}`
    if (e.type === 'motion') {
      if (age <= motionMs) motion.add(key)
    } else if (alarmSet.has(e.type)) {
      if (age <= alarmMs) alarm.add(key)
    }
  }
  return { motion, alarm }
}

/**
 * The view the old editor gave a site the moment "Street map" was chosen: the middle of the
 * Atlantic, zoomed right out. Saved with no camera on it, it was never anyone's idea of where the
 * site is, so it must not put a badge in the ocean.
 */
const OLD_DEFAULT = { lat: 30, lng: -40, zoom: 2 }

/** Where a site is on the one map, or null when nobody has placed it. */
export function sitePosition(siteMap) {
  const g = siteMap?.geo
  if (!g || !isNum(g.lat) || !isNum(g.lng)) return null
  const untouched = g.lat === OLD_DEFAULT.lat && g.lng === OLD_DEFAULT.lng && g.zoom === OLD_DEFAULT.zoom && !Object.keys(g.cams ?? {}).length
  return untouched ? null : { lat: g.lat, lng: g.lng }
}

/**
 * A site's street-map placements that really have a position, as [key, placement] pairs. With
 * `keys` (the site's cameras in the roster), only those: a placement left behind by a camera that
 * has been removed, or moved to another site, is not a camera anyone can open.
 */
const geoCams = (siteMap, keys) => {
  const mine = keys && new Set(keys)
  return Object.entries(siteMap?.geo?.cams ?? {}).filter(([k, c]) => c && isNum(c.lat) && isNum(c.lng) && (!mine || mine.has(k)))
}

/** The same, as a map boundsOf and buildMarkers can read. */
const geoOnly = (siteMap, keys) => ({ mode: 'geo', geo: { cams: Object.fromEntries(geoCams(siteMap, keys)) } })

/**
 * The sites in the row along the top: one per site in the camera roster, in name order.
 * `count` is the site's real cameras (an empty channel slot is not a camera); `onMap` is how many
 * of them are on the one map; `placed` is whether the site itself has a position.
 * @param {{ cameras: object[], maps: { sites: object } }} o  /api/cameras and /api/maps
 */
export function siteList({ cameras = [], maps }) {
  const by = new Map()
  for (const c of cameras) {
    if (!c || c.configured === false) continue
    if (!by.has(c.site)) by.set(c.site, [])
    by.get(c.site).push(c)
  }
  return [...by.keys()].sort((a, b) => String(a).localeCompare(String(b))).map((name) => {
    const siteMap = maps?.sites?.[name]
    const position = sitePosition(siteMap)
    const cams = by.get(name).sort((a, b) => String(a.nvrName ?? '').localeCompare(String(b.nvrName ?? '')) || a.ch - b.ch)
    const keys = cams.map((c) => `${c.nvr}/${c.ch}`)
    return {
      name,
      keys,
      count: cams.length,
      position,
      placed: Boolean(position),
      hasPlan: Boolean(siteMap?.plan?.file),
      onMap: geoCams(siteMap, keys).length
    }
  })
}

/**
 * Every named site's street-map placements gathered into one map, in the shape a single site's
 * map has, so everything that draws a site's map draws this one unchanged. The placements are the
 * stored objects themselves, not copies: moving one on the map moves it in its site.
 * @param {Record<string, object>} sites  maps.sites (or the drafts being edited)
 * @param {string[]} names  the sites to include
 * @returns {{ map: object, siteOf: Record<string, string> }} siteOf: which site each key is under
 */
export function mergeGeo(sites, names = []) {
  const cams = {}
  const siteOf = {}
  for (const name of names) {
    for (const [key, c] of geoCams(sites?.[name])) {
      cams[key] = c
      siteOf[key] = name
    }
  }
  return { map: { mode: 'geo', geo: { cams } }, siteOf }
}

/**
 * One badge per placed site: what the site looks like from too far away to see its cameras.
 * It carries the site's camera count and how many of them are offline, takes the worst state of
 * its cameras (a fault must not hide inside a badge any more than inside a cluster), and sits in
 * the middle of the cameras it would open into -- or at the site's own position when none of its
 * cameras has been placed yet. `box` is the bare box of its cameras, with no view ranges added.
 * @param {{ sites: ReturnType<typeof siteList>, maps: { sites: object }, states: Record<string, {state: string}> }} o
 */
export function siteBadges({ sites = [], maps, states = {} }) {
  const out = []
  for (const s of sites) {
    if (!s.placed) continue
    // only the site's own cameras shape the badge: what it opens into is what the roster holds
    const pts = geoCams(maps?.sites?.[s.name], s.keys).map(([, c]) => ({ x: lngToX(c.lng), y: latToY(c.lat) }))
    const box = pts.length
      ? { x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) }
      : null
    const camStates = s.keys.map((k) => states[k]?.state ?? 'unknown')
    out.push({
      name: s.name,
      count: s.count,
      offline: camStates.filter((st) => st === 'offline').length,
      state: worstState(camStates),
      x: box ? (box.x0 + box.x1) / 2 : lngToX(s.position.lng),
      y: box ? (box.y0 + box.y1) / 2 : latToY(clamp(s.position.lat, -MAX_LAT, MAX_LAT)),
      box,
      onMap: pts.length,
      keys: s.keys
    })
  }
  return out
}

/** "Value 4 U · 26": what a badge, and the site's button in the row, says. */
export const badgeLabel = (b) => `${b.name} · ${b.count}`

/** The badge's tooltip: the same in a sentence, with the state in the legend's own words. */
export const badgeTitle = (b) =>
  `${b.name}: ${b.count} camera${b.count === 1 ? '' : 's'}${b.offline ? `, ${b.offline} offline` : ''} — ${(STATES[b.state] ?? STATES.unknown).title}. Click to go there.`

/**
 * Which sites are drawn as one badge at this zoom, by name.
 *
 * A site is a badge while its cameras would land within BADGE_SPAN pixels of each other, where
 * they would be a smudge; from DETAIL_ZOOM in, it always shows its cameras, so a one-camera site
 * (which spans nothing at any zoom) opens too. A site named in `open` -- the one holding the
 * camera being watched -- is never collapsed under the person's hands, and nothing is collapsed
 * while editing, when every camera must be there to be dragged. A site with no camera placed has
 * nothing to open into and stays a badge.
 * @param {ReturnType<typeof siteBadges>} badges
 * @param {number} zoom
 * @param {{ open?: Iterable<string>, editing?: boolean }} [opts]
 * @returns {Set<string>}
 */
export function collapsedSites(badges, zoom, { open = [], editing = false } = {}) {
  const shut = new Set()
  if (editing) return shut
  const keep = new Set(open)
  for (const b of badges) {
    if (!b.onMap || !b.box) {
      shut.add(b.name)
      continue
    }
    if (keep.has(b.name) || zoom >= DETAIL_ZOOM) continue
    const span = Math.max(b.box.x1 - b.box.x0, b.box.y1 - b.box.y0) * 2 ** zoom
    if (span < BADGE_SPAN) shut.add(b.name)
  }
  return shut
}

/** The markers left once the collapsed sites' own cameras are taken out. */
export const visibleMarkers = (markers, siteOf, shut) => (shut.size ? markers.filter((m) => !shut.has(siteOf[m.key])) : markers)

/**
 * The view (centre and zoom) that shows a world box with a little margin, or null when there is
 * no box or no room to show it in. The same sum MapView.fit does, here so a flight's destination
 * can be worked out without moving the map there first.
 * @param {{x0:number,y0:number,x1:number,y1:number}|null} box
 * @param {{w:number,h:number}} size the map's size on screen
 */
export function boxView(box, size, { minZoom = FIT_MIN_ZOOM, maxZoom = FIT_MAX_ZOOM } = {}) {
  if (!box || !size?.w || !size?.h) return null
  const bw = Math.max(box.x1 - box.x0, 1e-9)
  const bh = Math.max(box.y1 - box.y0, 1e-9)
  return {
    cx: (box.x0 + box.x1) / 2,
    cy: (box.y0 + box.y1) / 2,
    zoom: clamp(Math.log2(Math.min(size.w / bw, size.h / bh) * 0.9), minZoom, maxZoom)
  }
}

/**
 * Where to fly for one site: its cameras and what they see, fitted to the screen -- but never so
 * far out that the site arrives still collapsed into its badge, which would make the button look
 * as if it had done nothing. A site with no cameras placed is shown at its own position.
 * @param {object|null} badge the site's badge (siteBadges), null when it is not placed
 * @param {object} siteMap the site's stored map
 */
export function siteView(badge, siteMap, size) {
  if (!badge || !size?.w || !size?.h) return null
  if (!badge.onMap || !badge.box) {
    const z = siteMap?.geo?.zoom
    return { cx: badge.x, cy: badge.y, zoom: clamp(isNum(z) ? z : PLACE_ZOOM, FIT_MIN_ZOOM, FIT_MAX_ZOOM) }
  }
  const fit = boxView(boundsOf(geoOnly(siteMap, badge.keys)), size)
  if (!fit) return null
  const span = Math.max(badge.box.x1 - badge.box.x0, badge.box.y1 - badge.box.y0)
  const opens = span > 0 ? Math.min(DETAIL_ZOOM, Math.log2(BADGE_SPAN / span) + 0.01) : DETAIL_ZOOM
  return { ...fit, zoom: clamp(Math.max(fit.zoom, opens), FIT_MIN_ZOOM, FIT_MAX_ZOOM) }
}

/** Where to fly for "All sites": every placed site, with or without cameras. Null when none is. */
export function allView(badges, maps, size) {
  if (!badges.length) return null
  if (badges.length === 1) return siteView(badges[0], maps?.sites?.[badges[0].name], size)
  const boxes = badges.map((b) => (b.onMap ? boundsOf(geoOnly(maps?.sites?.[b.name], b.keys)) : null) ?? { x0: b.x, y0: b.y, x1: b.x, y1: b.y })
  return boxView({
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1))
  }, size)
}

/**
 * Placements for cameras that have none yet, in a ring around their site's position: every one
 * visible and grabbable at once, ready to be dragged to where it really is. The ring grows with
 * the number of cameras so neighbours never overlap, the first camera is due north and the rest
 * follow clockwise in the order given, and each looks outwards so the cones do not pile up.
 * @param {{lat:number, lng:number}} centre the site's position
 * @param {string[]} keys the cameras to place, "nvr/ch"
 * @returns {Record<string, {lat:number, lng:number, dir:number, fov:number, range:number}>}
 */
export function ringPlacements(centre, keys, { spacing = 8, minRadius = 12, fov = 90, range = 25 } = {}) {
  const out = {}
  const n = keys.length
  if (!n) return out
  const lat = clamp(centre.lat, -MAX_LAT, MAX_LAT)
  const radius = Math.max(minRadius, (n * spacing) / (2 * Math.PI)) / metresPerUnit(lat) // metres -> world units
  const cx = lngToX(centre.lng)
  const cy = latToY(lat)
  keys.forEach((key, i) => {
    const deg = (360 * i) / n
    const a = (deg * Math.PI) / 180
    out[key] = {
      lat: clamp(yToLat(cy - radius * Math.cos(a)), -MAX_LAT, MAX_LAT),
      lng: clamp(xToLng(cx + radius * Math.sin(a)), -180, 180),
      dir: Math.round(deg) % 360,
      fov,
      range
    }
  })
  return out
}

/**
 * "42.7070, -71.1631" (as pasted from a map, with or without a trailing ", 17z"), or a Google
 * Maps link with @lat,lng in it; null when it is neither. The plain form must be the whole text:
 * two numbers picked out of a sentence ("Site 5, 42.7, -71.1") would put a site somewhere nobody
 * meant, and a wrong place on a map looks exactly as sure of itself as a right one.
 */
export function parseLatLng(text) {
  const t = String(text ?? '')
  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(t) ?? /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*\d+(?:\.\d+)?z)?\s*$/.exec(t)
  if (!at) return null
  const lat = Number(at[1])
  const lng = Number(at[2])
  if (Math.abs(lat) > MAX_LAT || Math.abs(lng) > 180) return null
  return { lat, lng }
}

/**
 * What to tell the admin after a save in which some sites failed: every site that failed and why,
 * which ones were stored, and that the rest is still there. Empty when nothing failed.
 * @param {string[]} stored
 * @param {{name: string, error: string}[]} failed
 */
export function saveSummary(stored, failed) {
  if (!failed.length) return ''
  const bad = failed.map((f) => `${f.name} (${f.error})`).join('; ')
  return `Could not save ${bad}.${stored.length ? ` Stored: ${stored.join(', ')}.` : ''} What failed is still unsaved here: put it right and press Save again.`
}

/**
 * What PUT /api/admin/maps/<site> is sent for one edited site, or null when it has neither a plan
 * nor a position and so nothing to store.
 *
 * `mode` no longer chooses what the page shows (the one map shows the geo block, the Plan button
 * the plan), but it is still stored and camera-links.mjs still reads it to pick which placements
 * to guess neighbours from. So it is left as it was saved, except that an empty plan never
 * outranks cameras that are on the street map.
 * @param {object} draft the site's map as edited
 * @param {'street'|'satellite'} layer the layer in use, stored with the position
 */
export function saveBody(draft, layer) {
  const position = sitePosition(draft)
  const hasPlan = Boolean(draft?.plan?.file)
  if (!position && !hasPlan) return null
  const groups = cleanGroups(draft?.geo?.groups)
  const geo = position
    ? {
        ...position,
        zoom: isNum(draft.geo.zoom) ? draft.geo.zoom : PLACE_ZOOM,
        layer: layer === 'satellite' ? 'satellite' : 'street',
        cams: draft.geo.cams ?? {},
        ...(groups.length ? { groups } : {})
      }
    : undefined
  const plan = hasPlan ? { cams: draft.plan.cams ?? {} } : undefined
  let mode = draft.mode === 'geo' ? 'geo' : 'plan'
  if (!plan) mode = 'geo'
  else if (!geo) mode = 'plan'
  else if (mode === 'plan' && !Object.keys(plan.cams).length && Object.keys(geo.cams).length) mode = 'geo'
  return { mode, plan, geo }
}
