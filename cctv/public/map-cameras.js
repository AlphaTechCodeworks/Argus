// Everything the camera map works out before it draws anything: where a camera sits in world
// coordinates, what colour it should be, and which markers have collapsed on top of each other at
// this zoom. map.js only paints what this module returns, the same split health.js uses, so all of
// it can be tested on a machine with no browser.
//
// The states come from the body of GET /api/health -- the Health page's own data -- rather than
// from /api/cameras, so the map and the Health page cannot disagree about whether a camera is
// recording. /api/cameras is still the roster (names, sites, which slots hold a real camera).

export const TILE = 256 // one zoom-0 Web Mercator tile: the whole world, in world units
export const MAX_LAT = 85 // past this the Mercator projection runs off to infinity

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// ---- Web Mercator ------------------------------------------------------------------------------

export const lngToX = (lng) => ((lng + 180) / 360) * TILE
export const latToY = (lat) => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE
}
export const xToLng = (x) => (x / TILE) * 360 - 180
export const yToLat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / TILE))) * 180) / Math.PI

/** Metres per world unit at a latitude: Mercator stretches as you leave the equator. */
export const metresPerUnit = (lat) => 156543.03392 * Math.cos((lat * Math.PI) / 180)

/** World position (and range in world units) of one stored placement. */
export function camWorld(map, c) {
  if (map.mode === 'geo') return { x: lngToX(c.lng), y: latToY(c.lat), r: c.range / metresPerUnit(c.lat) }
  return { x: c.x, y: c.y, r: c.range }
}

/** Moves a placement to a world point, in whichever coordinates its map stores. */
export function setCamPos(map, c, wx, wy) {
  if (map.mode === 'geo') {
    c.lat = clamp(yToLat(clamp(wy, 0, TILE)), -MAX_LAT, MAX_LAT)
    c.lng = clamp(xToLng(wx), -180, 180)
  } else {
    c.x = Math.round(clamp(wx, 0, map.plan?.w ?? 0))
    c.y = Math.round(clamp(wy, 0, map.plan?.h ?? 0))
  }
  return c
}

/** The world box holding every placement, padded by the longest view range, or null if none. */
export function boundsOf(map, keys) {
  const cams = map?.[map.mode]?.cams ?? {}
  const pts = (keys ? keys.filter((k) => cams[k]) : Object.keys(cams)).map((k) => camWorld(map, cams[k]))
  if (pts.length === 0) return null
  const pad = Math.max(...pts.map((p) => p.r))
  return {
    x0: Math.min(...pts.map((p) => p.x)) - pad,
    y0: Math.min(...pts.map((p) => p.y)) - pad,
    x1: Math.max(...pts.map((p) => p.x)) + pad,
    y1: Math.max(...pts.map((p) => p.y)) + pad
  }
}

// ---- what state a camera is in -----------------------------------------------------------------

/**
 * The five things a camera can be, and what each one means on screen. `rank` is only used to
 * decide the colour of a cluster of markers: the cluster takes its worst member's colour, so a
 * pile of markers can never look calmer than the cameras inside it.
 *
 * "online, recording nothing" is its own state and its own colour, deliberately. At this site a
 * camera that is up but writing nothing is the failure that actually happens, and lumping it in
 * with "online" is how it goes unnoticed for a month.
 */
export const STATES = {
  recording: { rank: 0, label: 'recording', title: 'online and recording' },
  // (while nothing anywhere is being recorded: recording is switched off, and "not recording" would
  // paint every camera amber for a fault nobody has. Green for live, red for offline, at the owner's wish.)
  live: { rank: 0, label: 'live', title: 'online (recording is switched off)' },
  unknown: { rank: 1, label: 'state unknown', title: 'the server has not said what this camera is doing' },
  idle: { rank: 2, label: 'not recording', title: 'online, but nothing is being recorded' },
  alert: { rank: 3, label: 'alert', title: 'there is an open alert about this camera' },
  offline: { rank: 4, label: 'offline', title: 'the server cannot reach this camera' }
}

export const camKey = (nvrId, ch) => `${nvrId}/${ch}`

/**
 * Open alerts gathered by the NVR they name. Every alert key ends in the NVR's id
 * (`camera-offline/nvr1`, `nvr-disk/nvr1`, ...), and the camera-level ones name their cameras only
 * inside a prose `detail` string. Matching on that prose would be guesswork, so an alert about an
 * NVR is treated as an alert about all of its cameras -- which is what it usually is, and which
 * errs towards showing a problem rather than hiding one.
 */
export function alertsByNvr(open = []) {
  const by = new Map()
  for (const a of open) {
    const id = String(a?.key ?? '').split('/').slice(1).join('/')
    if (!id) continue
    const list = by.get(id)
    if (list) list.push(a)
    else by.set(id, [a])
  }
  return by
}

/**
 * One camera's state, from its entry in /api/health's `cameras`.
 *
 * A camera we have no entry for is `unknown`, never `recording` and never `offline`: the map must
 * not report a state nobody measured. Offline outranks an open alert because "offline" is the more
 * specific thing to say, and the alert about it is nearly always the reason it is open.
 *
 * @param {{online?: boolean, recording?: boolean}|null|undefined} entry
 * @param {object[]} alerts the open alerts naming this camera's NVR
 * @param {{ recordingOff?: boolean }} [o] recordingOff: no camera anywhere is recording (cameraStates),
 *   so one that is online and not recording is simply live, not a camera that has stopped recording
 */
export function stateOf(entry, alerts = [], { recordingOff = false } = {}) {
  if (!entry || typeof entry.online !== 'boolean') return 'unknown'
  if (!entry.online) return 'offline'
  if (typeof entry.recording !== 'boolean') return 'unknown'
  if (!entry.recording) return recordingOff ? 'live' : 'idle'
  return alerts.length > 0 ? 'alert' : 'recording'
}

/**
 * Every camera's state, keyed "nvr/ch", from the body of GET /api/health.
 * @returns {{ byKey: Record<string, {state: string, alerts: object[]}>, at: number|null }}
 */
export function cameraStates(health) {
  const alerts = alertsByNvr(health?.open ?? [])
  const byKey = {}
  // Not one camera recording, on any NVR: recording is switched off (the health answer has no word
  // for that itself). With even one recording, a camera that is not stays amber: that is the fault.
  const recordingOff = !(health?.cameras ?? []).some((c) => c?.recording === true)
  for (const c of health?.cameras ?? []) {
    if (c?.nvrId === undefined || c?.ch === undefined) continue
    const mine = alerts.get(String(c.nvrId)) ?? []
    byKey[camKey(c.nvrId, c.ch)] = { state: stateOf(c, mine, { recordingOff }), alerts: mine }
  }
  return { byKey, at: Number.isFinite(health?.now) ? health.now : null }
}

/** The SVG class list for a marker in a state; the colours themselves live in style.css. */
export const markerClass = (state, extra = '') => `cam st-${STATES[state] ? state : 'unknown'}${extra}`

// ---- markers -----------------------------------------------------------------------------------

/**
 * One marker per placed camera, in screen coordinates, ready to be drawn.
 *
 * A camera with no stored position is simply not here: nothing is placed at 0,0 for it. An empty
 * channel slot (`configured: false`) is dropped even if something once placed it, because there is
 * no camera there to have a state. A placement whose camera has gone from the roster altogether is
 * kept only while editing, so an admin can see it and remove it.
 *
 * @param {object} o
 * @param {object} o.map the site's map as stored ({ mode, plan | geo })
 * @param {Map<string, object>|Record<string, object>} o.cameras the roster, keyed "nvr/ch"
 * @param {Record<string, {state: string}>} o.states from cameraStates().byKey
 * @param {(x: number, y: number) => [number, number]} o.toScreen
 * @param {number} o.scale world units -> screen pixels
 */
export function buildMarkers({ map, cameras, states = {}, toScreen, scale, editing = false, minRadius = 6 }) {
  if (!map || !map.mode) return []
  const roster = cameras instanceof Map ? cameras : new Map(Object.entries(cameras ?? {}))
  const out = []
  for (const [key, c] of Object.entries(map[map.mode]?.cams ?? {})) {
    const cam = roster.get(key)
    if (cam && cam.configured === false) continue
    if (!cam && !editing) continue
    const w = camWorld(map, c)
    const [x, y] = toScreen(w.x, w.y)
    const state = cam ? states[key]?.state ?? 'unknown' : 'unknown'
    out.push({
      key,
      cam: cam ?? null,
      x,
      y,
      r: Math.max(minRadius, w.r * scale),
      dir: c.dir,
      fov: c.fov,
      state,
      alerts: states[key]?.alerts ?? []
    })
  }
  return out
}

/** "3 · Yard gate", or something honest when the camera is no longer on any NVR. */
export const markerLabel = (marker) => (marker.cam ? `${marker.cam.ch + 1} · ${marker.cam.name}` : `Unknown camera (${marker.key})`)

/** What the marker's tooltip says: the camera, then the state in the same words the legend uses. */
export const markerTitle = (marker) => {
  const s = STATES[marker.state] ?? STATES.unknown
  const why = marker.alerts?.length ? `: ${marker.alerts[0].title}` : ''
  return `${markerLabel(marker)} — ${s.title}${why}`
}

/**
 * Markers that have landed on top of each other at this zoom, gathered into clusters.
 *
 * Zoomed out far enough, a dozen cameras in one yard become one illegible smudge and clicking any
 * of them is luck. A cluster is drawn as one marker with a count instead, and takes its worst
 * member's colour so a fault is never hidden inside it. `pinned` keys (the chosen camera, the one
 * whose video is open) always stay on their own, because a marker the person is working with must
 * not vanish into a pile under their hands.
 *
 * Greedy nearest-first grouping: markers are walked in order and each joins the first cluster whose
 * centre it is within `minGap` pixels of. It is not the prettiest clustering, but it is stable
 * (same input, same output) and cheap enough to run on every frame.
 *
 * @param {object[]} markers from buildMarkers
 * @param {number} minGap pixels between marker centres below which they are the same smudge
 * @param {Iterable<string>} pinned keys that must never be clustered
 * @returns {{x:number, y:number, members:object[], state:string, count:number, key:string}[]}
 */
export function clusterMarkers(markers, minGap = 26, pinned = []) {
  const keep = new Set([...pinned].filter(Boolean))
  const clusters = []
  const single = (m) => ({ x: m.x, y: m.y, members: [m], state: m.state, count: 1, key: m.key })
  if (!(minGap > 0)) return markers.map(single)
  for (const m of markers) {
    if (keep.has(m.key)) {
      clusters.push(single(m))
      continue
    }
    const near = clusters.find((c) => c.members.length && !keep.has(c.members[0].key) && Math.hypot(c.x - m.x, c.y - m.y) <= minGap)
    if (!near) {
      clusters.push(single(m))
      continue
    }
    near.members.push(m)
    near.count = near.members.length
    // the cluster sits at the average of its members, so it points at where they actually are
    near.x = near.members.reduce((s, p) => s + p.x, 0) / near.count
    near.y = near.members.reduce((s, p) => s + p.y, 0) / near.count
    near.state = worstState(near.members.map((p) => p.state))
  }
  return clusters
}

/** The most alarming of several states: what a cluster of markers is coloured. */
export function worstState(states) {
  let worst = 'recording'
  for (const s of states) {
    const rank = (STATES[s] ?? STATES.unknown).rank
    if (rank > (STATES[worst] ?? STATES.unknown).rank) worst = STATES[s] ? s : 'unknown'
  }
  return worst
}

/** How many cameras are in each state, for the count under the map's legend. */
export function stateCounts(markers) {
  const counts = { recording: 0, live: 0, idle: 0, alert: 0, offline: 0, unknown: 0 }
  for (const m of markers) counts[STATES[m.state] ? m.state : 'unknown']++
  return counts
}

/** Where a click on a marker goes: that camera live, and on from there to its recordings. */
export const playbackHref = (cam) => `/playback.html?nvr=${encodeURIComponent(cam.nvr)}&ch=${cam.ch}`
