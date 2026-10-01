// Camera map: every camera of every site on one street/satellite map, where it is and what it
// covers, with a row of site buttons to move between the sites on it. Zoomed out a site is one
// badge; zoomed in, its cameras. A site that has a plan image (a floor plan, a yard layout) opens
// it as its close-up. Click a camera for live video; admins place the sites and aim the cameras.
// What the page works out before it draws is in map-model.js and map-cameras.js.
//
// Map engine: world coordinates are image pixels for a plan, or Web Mercator units
// (the whole world is 256 wide, like one zoom-0 tile) for street/satellite maps.
// screen = (world - centre) * 2^zoom + half the viewport.
import { LiveTile, SUB_STREAM, TILE_HTML } from './live-tile.js'
import {
  MAX_LAT,
  STATES,
  TILE,
  boundsOf,
  buildMarkers,
  camWorld,
  cameraStates,
  clamp,
  clusterMarkers,
  latToY,
  lngToX,
  markerClass,
  markerTitle,
  metresPerUnit,
  playbackHref,
  setCamPos,
  stateCounts,
  xToLng,
  yToLat
} from './map-cameras.js'
import {
  PLACE_ZOOM,
  allView,
  badgeLabel,
  badgeTitle,
  collapsedSites,
  mergeGeo,
  parseLatLng,
  ringPlacements,
  saveBody,
  saveSummary,
  siteBadges,
  siteList,
  sitePosition,
  siteView,
  visibleMarkers
} from './map-model.js'

const $ = (id) => document.getElementById(id)
const LAYERS = {
  street: {
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    maxZoom: 19,
    credit: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
  },
  satellite: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    maxZoom: 19,
    credit: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community'
  }
}
const DEFAULT_GEO = { lat: 30, lng: -40, zoom: 2, layer: 'street' }
const MAX_RANGE = { geo: 5000, plan: 20_000 }
/** Marker centres closer together than this are one illegible smudge, so they are clustered. */
const CLUSTER_GAP = 26

// ---- map engine -------------------------------------------------------------

class MapView {
  constructor(el) {
    this.el = el
    this.tilesEl = el.querySelector('.map-tiles')
    this.img = el.querySelector('.map-plan')
    this.svg = el.querySelector('.map-overlay')
    this.credit = el.querySelector('.map-credit')
    this.mode = null // 'plan' | 'geo' | null
    this.layer = 'street'
    this.planW = 0
    this.planH = 0
    this.cx = 0
    this.cy = 0
    this.zoom = 0
    this.minZoom = 0
    this.maxZoom = 20
    this.needsFit = false
    this.tiles = new Map() // key -> { img, layer, z, tx, ty, loaded }
    this.pointers = new Map()
    this.gesture = null
    this.frame = 0
    this.flyFrame = 0 // a "fly to" in progress
    // set by the page
    this.onDraw = () => {}
    this.hitTest = () => null // (event, point) -> { move, end, click } for dragging something, or null to pan
    this.onClick = () => {}
    this.onViewChange = () => {}
    this.img.addEventListener('load', () => this.requestRender())
    el.addEventListener('pointerdown', (e) => this.#down(e))
    el.addEventListener('pointermove', (e) => this.#move(e))
    el.addEventListener('pointerup', (e) => this.#up(e))
    el.addEventListener('pointercancel', (e) => this.#up(e))
    el.addEventListener('wheel', (e) => this.#wheel(e), { passive: false })
    new ResizeObserver(() => this.render()).observe(el)
  }

  get scale() {
    return 2 ** this.zoom
  }

  size() {
    return { w: this.el.clientWidth, h: this.el.clientHeight }
  }

  toScreen(x, y) {
    const { w, h } = this.size()
    const s = this.scale
    return [(x - this.cx) * s + w / 2, (y - this.cy) * s + h / 2]
  }

  toWorld(sx, sy) {
    const { w, h } = this.size()
    const s = this.scale
    return [(sx - w / 2) / s + this.cx, (sy - h / 2) / s + this.cy]
  }

  clear() {
    this.mode = null
    this.img.hidden = true
    this.img.removeAttribute('src')
    this.#clearTiles()
    this.svg.replaceChildren()
    this.credit.hidden = true
  }

  setPlan(url, w, h, keepView = false) {
    const same = this.mode === 'plan' && this.planW === w && this.planH === h
    this.mode = 'plan'
    this.#clearTiles()
    this.credit.hidden = true
    this.planW = w
    this.planH = h
    if (this.img.getAttribute('src') !== url) this.img.src = url
    this.img.style.width = `${w}px`
    this.img.style.height = `${h}px`
    this.img.hidden = false
    if (!keepView || !same) this.needsFit = true
    this.requestRender()
  }

  setGeo({ layer, lat, lng, zoom }, keepView = false) {
    const wasGeo = this.mode === 'geo'
    this.mode = 'geo'
    this.img.hidden = true
    this.img.removeAttribute('src')
    if (this.layer !== layer) this.#clearTiles()
    this.layer = LAYERS[layer] ? layer : 'street'
    this.credit.innerHTML = LAYERS[this.layer].credit // fixed strings above
    this.credit.hidden = false
    this.minZoom = 1
    this.maxZoom = LAYERS[this.layer].maxZoom + 1 // one level past the tiles, scaled up
    if (!keepView || !wasGeo) {
      this.cx = lngToX(lng)
      this.cy = latToY(clamp(lat, -MAX_LAT, MAX_LAT))
      this.zoom = clamp(zoom, this.minZoom, this.maxZoom)
    }
    this.needsFit = false
    this.requestRender()
  }

  /** Centre and zoom of a street/satellite view, for saving. */
  geoView() {
    const lng = ((xToLng(this.cx) + 540) % 360) - 180 // panned past the date line: back into range
    return { lat: clamp(yToLat(this.cy), -MAX_LAT, MAX_LAT), lng, zoom: this.zoom }
  }

  /** Shows the given world box (e.g. every camera), or the whole plan when none. */
  fit(box) {
    const { w, h } = this.size()
    if (!w || !h) {
      this.needsFit = true
      return
    }
    if (this.mode === 'plan' && !box) {
      box = { x0: 0, y0: 0, x1: this.planW, y1: this.planH }
      const z = Math.log2(Math.min(w / this.planW, h / this.planH) * 0.95)
      this.minZoom = z - 2
      this.maxZoom = z + 5
    }
    if (!box) return
    const bw = Math.max(box.x1 - box.x0, 1e-9)
    const bh = Math.max(box.y1 - box.y0, 1e-9)
    this.zoom = clamp(Math.log2(Math.min(w / bw, h / bh) * 0.9), this.minZoom, this.mode === 'geo' ? 19 : this.maxZoom)
    this.cx = (box.x0 + box.x1) / 2
    this.cy = (box.y0 + box.y1) / 2
    this.needsFit = false
    this.requestRender()
  }

  centreOn(x, y) {
    this.cx = x
    this.cy = y
    this.#clampCentre()
    this.requestRender()
  }

  /**
   * Travel to another place instead of jumping there: zoom out far enough to see both, move
   * across, then zoom back in. Jumping between two sites gives no sense of where the new one is;
   * watching the map pull back and fly over does, and it costs nothing but a second.
   *
   * The curve is the standard "fly to" one: zoom follows a hump so the pull-back is proportional
   * to the distance travelled. A short hop barely zooms out; crossing a county zooms right out.
   *
   * @param {{cx:number, cy:number, zoom:number}} to where to end up
   * @param {number} ms how long to take
   * @returns {Promise<void>} resolves when it lands
   */
  flyTo(to, ms = 1100) {
    this.cancelFly()
    const from = { cx: this.cx, cy: this.cy, zoom: this.zoom }
    // distance in screen pixels at the starting zoom: that, not raw coordinates, is what decides
    // how far back we need to pull to show both ends
    const scale = 2 ** from.zoom
    const dx = (to.cx - from.cx) * scale
    const dy = (to.cy - from.cy) * scale
    const dist = Math.hypot(dx, dy)
    const { w, h } = this.size()
    const span = Math.max(w, h, 1)

    // how much to pull back: enough that the whole journey fits on screen at the midpoint,
    // capped so a trip across the world does not end up at zoom -20
    const out = dist <= span ? 0 : Math.min(Math.log2(dist / span), 4)
    const lowest = Math.max(this.minZoom, Math.min(from.zoom, to.zoom) - out)
    const worthIt = out > 0.15 // a short hop should just glide, not lurch outwards and back

    // a person in the room may prefer no animation at all
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || ms <= 0) {
      this.cx = to.cx; this.cy = to.cy; this.zoom = to.zoom
      this.#clampCentre(); this.requestRender()
      return Promise.resolve()
    }

    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2) // slow, quick, slow
    const start = performance.now()
    return new Promise((done) => {
      const step = (now) => {
        const t = Math.min(1, (now - start) / ms)
        const e = ease(t)
        this.cx = from.cx + (to.cx - from.cx) * e
        this.cy = from.cy + (to.cy - from.cy) * e
        if (worthIt) {
          // a hump: out on the way, back in on arrival. sin gives 0 at both ends, 1 in the middle.
          const hump = Math.sin(Math.PI * e)
          const straight = from.zoom + (to.zoom - from.zoom) * e
          this.zoom = straight - (straight - lowest) * hump
        } else {
          this.zoom = from.zoom + (to.zoom - from.zoom) * e
        }
        this.#clampCentre()
        this.render()
        if (t < 1) this.flyFrame = requestAnimationFrame(step)
        else { this.flyFrame = 0; this.cx = to.cx; this.cy = to.cy; this.zoom = to.zoom; this.#clampCentre(); this.requestRender(); done() }
      }
      this.flyFrame = requestAnimationFrame(step)
    })
  }

  /** Stops a flight in its tracks: any touch of the map should take control back at once. */
  cancelFly() {
    if (this.flyFrame) cancelAnimationFrame(this.flyFrame)
    this.flyFrame = 0
  }

  zoomAt(z, sx, sy) {
    const [wx, wy] = this.toWorld(sx, sy)
    this.zoom = clamp(z, this.minZoom, this.maxZoom)
    const { w, h } = this.size()
    const s = this.scale
    this.cx = wx - (sx - w / 2) / s
    this.cy = wy - (sy - h / 2) / s
    this.#clampCentre()
    this.requestRender()
  }

  zoomBy(dz) {
    const { w, h } = this.size()
    this.zoomAt(this.zoom + dz, w / 2, h / 2)
    this.onViewChange()
  }

  panBy(dx, dy) {
    this.cx -= dx / this.scale
    this.cy -= dy / this.scale
    this.#clampCentre()
    this.requestRender()
  }

  #clampCentre() {
    if (this.mode === 'plan') {
      this.cx = clamp(this.cx, 0, this.planW)
      this.cy = clamp(this.cy, 0, this.planH)
    } else if (this.mode === 'geo') {
      this.cy = clamp(this.cy, 0, TILE)
    }
  }

  requestRender() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render())
  }

  render() {
    cancelAnimationFrame(this.frame)
    this.frame = 0
    const { w, h } = this.size()
    if (!w || !h || !this.mode) return
    if (this.needsFit) this.fit()
    if (this.mode === 'plan') {
      const [tx, ty] = this.toScreen(0, 0)
      this.img.style.transform = `translate(${tx}px, ${ty}px) scale(${this.scale})`
    } else {
      this.#renderTiles(w, h)
    }
    this.onDraw()
  }

  #renderTiles(w, h) {
    const layer = LAYERS[this.layer]
    const z = clamp(Math.round(this.zoom), 0, layer.maxZoom)
    const n = 2 ** z
    const unit = TILE / n // world units per tile at this zoom
    const [x0, y0] = this.toWorld(0, 0)
    const [x1, y1] = this.toWorld(w, h)
    const wanted = new Set()
    let allLoaded = true
    for (let ty = Math.max(0, Math.floor(y0 / unit)); ty <= Math.min(n - 1, Math.floor(y1 / unit)); ty++) {
      for (let tx = Math.floor(x0 / unit); tx <= Math.floor(x1 / unit); tx++) {
        const key = `${this.layer}/${z}/${tx}/${ty}`
        wanted.add(key)
        let t = this.tiles.get(key)
        if (!t) {
          const img = new Image()
          img.className = 'map-tile'
          img.alt = ''
          img.draggable = false
          // tile servers ask for a referrer; the app's pages otherwise send none
          img.referrerPolicy = 'strict-origin-when-cross-origin'
          t = { img, layer: this.layer, z, tx, ty, loaded: false }
          img.onload = img.onerror = () => {
            t.loaded = true
            this.requestRender()
          }
          img.src = layer.url(z, ((tx % n) + n) % n, ty)
          this.tiles.set(key, t)
          this.tilesEl.append(img)
        }
        if (!t.loaded) allLoaded = false
      }
    }
    const s = this.scale
    for (const [key, t] of this.tiles) {
      const u = TILE / 2 ** t.z
      const [sx, sy] = this.toScreen(t.tx * u, t.ty * u)
      const px = u * s
      const onScreen = sx < w && sy < h && sx + px > 0 && sy + px > 0
      // tiles of the previous zoom stay underneath until the new ones have loaded (no flashing)
      const keep = wanted.has(key) || (!allLoaded && t.layer === this.layer && t.loaded && onScreen && this.tiles.size < 400)
      if (!keep) {
        t.img.remove()
        this.tiles.delete(key)
        continue
      }
      t.img.style.transform = `translate(${sx}px, ${sy}px)`
      t.img.style.width = t.img.style.height = `${px + 0.5}px`
      t.img.style.zIndex = t.z === z ? '1' : '0'
    }
  }

  #clearTiles() {
    for (const t of this.tiles.values()) t.img.remove()
    this.tiles.clear()
  }

  #local(e) {
    const r = this.el.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  #down(e) {
    // touching the map takes control back at once: nobody wants to fight an animation
    this.cancelFly()
    if (!this.mode || (e.pointerType === 'mouse' && e.button !== 0)) return
    if (e.target.closest?.('button, a, .map-live, .map-empty')) return
    const p = this.#local(e)
    this.pointers.set(e.pointerId, p)
    this.el.setPointerCapture(e.pointerId)
    if (this.pointers.size === 1) {
      const drag = this.hitTest(e, p)
      this.gesture = drag
        ? { kind: 'drag', drag, start: p, moved: false }
        : { kind: 'pan', start: p, last: p, moved: false, target: e.target }
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]
      this.gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: this.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
    }
  }

  #move(e) {
    if (!this.pointers.has(e.pointerId)) return
    const p = this.#local(e)
    this.pointers.set(e.pointerId, p)
    const g = this.gesture
    if (!g) return
    if (g.kind === 'pinch') {
      if (this.pointers.size !== 2) return
      const [a, b] = [...this.pointers.values()]
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      this.panBy(mid.x - g.mid.x, mid.y - g.mid.y)
      this.zoomAt(g.zoom + Math.log2(Math.hypot(a.x - b.x, a.y - b.y) / g.dist), mid.x, mid.y)
      g.mid = mid
      return
    }
    if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) <= 4) return
    g.moved = true
    if (g.kind === 'drag') {
      g.drag.move?.(p)
    } else {
      this.el.classList.add('panning')
      this.panBy(p.x - g.last.x, p.y - g.last.y)
      g.last = p
    }
  }

  #up(e) {
    if (!this.pointers.has(e.pointerId)) return
    this.pointers.delete(e.pointerId)
    const g = this.gesture
    const tap = e.type === 'pointerup' && g && !g.moved
    if (g?.kind === 'drag') {
      if (g.moved) g.drag.end?.()
      else if (tap) g.drag.click?.()
    } else if (g?.kind === 'pan' && tap) {
      this.onClick(this.#local(e), g.target)
    }
    if (this.pointers.size === 0) {
      this.gesture = null
      this.el.classList.remove('panning')
      if (g?.moved || g?.kind === 'pinch') this.onViewChange()
    } else if (this.pointers.size === 1 && g?.kind === 'pinch') {
      const [p] = this.pointers.values()
      this.gesture = { kind: 'pan', start: p, last: p, moved: true }
    }
  }

  #wheel(e) {
    this.cancelFly()
    if (!this.mode) return
    e.preventDefault()
    const p = this.#local(e)
    const delta = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1)
    this.zoomAt(this.zoom - delta * 0.002, p.x, p.y)
    clearTimeout(this.wheelTimer)
    this.wheelTimer = setTimeout(() => this.onViewChange(), 300)
  }
}

// ---- page -------------------------------------------------------------------

const view = new MapView($('map'))
const sitesRow = $('sites')
const satBox = $('sat')
const namesBox = $('names')
const editBtn = $('edit')
const linksBtn = $('links')
const side = $('side')
const emptyEl = $('empty')
const liveEl = $('live')

let isAdmin = false
let cameras = [] // /api/cameras: { nvr, site, nvrName, ch, name, online, configured }
// What each camera is actually doing, worked out from the body of /api/health -- the very data the
// Health page paints. Taking it from anywhere else is how two pages come to disagree about whether
// a camera is recording. Empty until the first poll answers, and every camera is drawn as unknown
// until then rather than assumed to be well.
let states = {}
let maps = { sites: {} } // /api/maps
let siteNames = [] // every site in the roster, in name order
let site = '' // the site chosen in the row along the top; '' is "All sites"
let planSite = null // the site whose plan is open as its close-up; null while the one map is showing
let layer = 'street' // the one map's background, a choice kept in this browser
let geoBefore = null // where the one map was when a plan was opened, to come back to
let editing = false
let drafts = null // every site's map while editing; a save sends only the ones changed
const dirtySites = new Set()
let selected = null // camera key
let placing = null // camera key waiting for a click on the map
let placingSite = false // the chosen site is waiting for a click on the map to say where it is
let saving = false // a save is on its way: Save and Cancel wait for it
let merged = null // the one map built from every site's placements (oneMap), until something changes
let popup = null // { key, tile }
// Which camera adjoins which (camera-links.mjs). Drawn on the map rather than edited in a list of
// dropdowns because the spatial relationship is the whole idea: you can see that the yard camera
// looks at the gate, so you can see that it leads there.
let linkMode = false
let linkData = { links: {}, version: 0, suggestions: {} } // suggestions: guesses from the map, never stored
let newLabel = '' // the label given to the next link drawn
let newOneWay = false // a one-way door or a stairwell: the link leads only one way

const camKey = (c) => `${c.nvr}/${c.ch}`
const enc = encodeURIComponent
/** The site the camera list is about: the plan that is open, else the one chosen in the row. */
const listSite = () => planSite ?? site
const siteCams = (name = listSite()) => cameras.filter((c) => c.site === name && c.configured !== false).sort((a, b) => a.nvrName.localeCompare(b.nvrName) || a.ch - b.ch)
const camByKey = (key) => cameras.find((c) => camKey(c) === key)
const camLabel = (cam, key) => (cam ? `${cam.ch + 1} · ${cam.name}` : `Unknown camera (${key})`)
/** Every site's map as it stands: the drafts while editing. */
const source = () => (editing ? drafts : maps.sites)
/**
 * The one map: every site's street-map placements as a single map, with the sites and their
 * badges. Worked out once and kept until something it is made from changes (changed(), a save, the
 * 30-second poll), because the draw path asks for it on every frame of a pan or a flight.
 */
function oneMap() {
  if (!merged) {
    const all = { sites: source() }
    const sites = siteList({ cameras, maps: all })
    merged = { ...mergeGeo(all.sites, siteNames), sites, badges: siteBadges({ sites, maps: all, states }) }
  }
  return merged
}
const stale = () => {
  merged = null
}
/** A site's plan as a map of its own, sharing the stored placements. Null when it has no plan. */
const planOf = (name) => {
  const s = source()[name]
  return s?.plan?.file ? { mode: 'plan', plan: s.plan } : null
}
/** The map shown: the open plan, else the one map. */
const current = () => (planSite ? planOf(planSite) : oneMap().map)
/** Camera placements of a map in its current mode. */
const placed = (m = current()) => (m?.[m.mode]?.cams ?? {})
/** The site a camera's placement belongs to. */
const siteOfKey = (key) => planSite ?? oneMap().siteOf[key] ?? camByKey(key)?.site ?? null
const siteInfo = (name) => oneMap().sites.find((s) => s.name === name) ?? null
const badgeOf = (name) => oneMap().badges.find((b) => b.name === name) ?? null

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    // role is not a property every browser reflects: set as an attribute it always reaches a screen reader
    if (k === 'role' || k.startsWith('aria-') || k.startsWith('data-')) node.setAttribute(k, v)
    else node[k] = v
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false))
  return node
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  if (res.status === 401) location.href = '/login.html'
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

/** Sends the browser to the sign-in page if the session has expired or been revoked. */
async function checkSession() {
  const res = await fetch('/api/me').catch(() => null)
  if (res?.status === 401) location.href = '/login.html'
  return res?.ok ? res.json() : null
}

/** The roster keyed the way placements are, for the pure module. */
const rosterByKey = () => new Map(cameras.map((c) => [camKey(c), c]))

/** A camera's state, or 'unknown' when nothing has told us: never a guess at healthy. */
const stateFor = (key) => states[key]?.state ?? 'unknown'

// ---- drawing ----

const SVG_NS = 'http://www.w3.org/2000/svg'
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}
/** Point at angle a (degrees clockwise from up) and distance r from p. */
const polar = (p, a, r) => [p[0] + r * Math.sin((a * Math.PI) / 180), p[1] - r * Math.cos((a * Math.PI) / 180)]

function conePath(p, dir, fov, r) {
  if (fov >= 359.5) return `M ${p[0] - r} ${p[1]} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`
  const [ax, ay] = polar(p, dir - fov / 2, r)
  const [bx, by] = polar(p, dir + fov / 2, r)
  return `M ${p[0]} ${p[1]} L ${ax} ${ay} A ${r} ${r} 0 ${fov > 180 ? 1 : 0} 1 ${bx} ${by} Z`
}

/** Where each placed camera is on screen, for drawing the links between them. */
function screenPoints(m) {
  const pts = {}
  for (const [key, c] of Object.entries(placed(m))) {
    const w = camWorld(m, c)
    pts[key] = view.toScreen(w.x, w.y)
  }
  return pts
}

/** A small arrowhead partway along a -> b, so a one-way link reads as one-way at a glance. */
function arrowHead(a, b) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  const len = Math.hypot(dx, dy) || 1
  const [ux, uy] = [dx / len, dy / len]
  const p = [a[0] + ux * len * 0.6, a[1] + uy * len * 0.6]
  const s = 7
  return `M ${p[0]} ${p[1]} L ${p[0] - ux * s - uy * s * 0.6} ${p[1] - uy * s + ux * s * 0.6} L ${p[0] - ux * s + uy * s * 0.6} ${p[1] - uy * s - ux * s * 0.6} Z`
}

/** The drawn links, and (dashed, only for the chosen camera) the map's guesses at them. */
function linkLayer(m) {
  const g = svgEl('g')
  if (!linkMode || !m) return g
  const pts = screenPoints(m)
  const drawn = new Set()
  for (const [from, list] of Object.entries(linkData.links)) {
    for (const n of list) {
      if (!pts[from] || !pts[n.to]) continue // one of them is not on this map
      const bothWays = (linkData.links[n.to] ?? []).some((x) => x.to === from)
      const pair = [from, n.to].sort().join('\u0000')
      if (bothWays && drawn.has(pair)) continue // a two-way link is one line, not two on top of each other
      drawn.add(pair)
      const a = pts[from]
      const b = pts[n.to]
      const sel = selected === from || selected === n.to ? ' sel' : ''
      const line = svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: `map-link${sel}` })
      const title = svgEl('title')
      title.textContent = `${camLabel(camByKey(from), from)} ${bothWays ? '↔' : '→'} ${camLabel(camByKey(n.to), n.to)}${n.label ? `: ${n.label}` : ''}`
      line.append(title)
      g.append(line)
      if (!bothWays) g.append(svgEl('path', { d: arrowHead(a, b), class: `map-link-arrow${sel}` }))
    }
  }
  // guesses, and only while a camera is chosen, so they are never mistaken for drawn links
  if (selected && pts[selected]) {
    for (const s of suggestionsFor(selected)) {
      if (!pts[s.to]) continue
      const line = svgEl('line', { x1: pts[selected][0], y1: pts[selected][1], x2: pts[s.to][0], y2: pts[s.to][1], class: 'map-link suggested' })
      const title = svgEl('title')
      title.textContent = `Suggestion (not a drawn link): ${camLabel(camByKey(s.to), s.to)}, about ${s.distance} ${s.units} away`
      line.append(title)
      g.append(line)
    }
  }
  return g
}

/** The markers for the map on screen right now, worked out by the pure module. */
function currentMarkers() {
  const m = current()
  if (!m || !view.mode) return []
  return buildMarkers({
    map: m,
    cameras: rosterByKey(),
    states,
    toScreen: (x, y) => view.toScreen(x, y),
    scale: view.scale,
    editing
  })
}

/** One camera's marker: the dot, its channel number, and its name when names are on. */
function markerNode(marker, sel, showNames) {
  const g = svgEl('g', { class: `${markerClass(marker.state)}${sel}`, 'data-key': marker.key, transform: `translate(${marker.x.toFixed(1)} ${marker.y.toFixed(1)})` })
  const title = svgEl('title')
  title.textContent = markerTitle(marker)
  const num = svgEl('text', { class: 'cam-num' })
  num.textContent = marker.cam ? String(marker.cam.ch + 1) : '?'
  g.append(title, svgEl('circle', { r: 12, class: 'cam-dot' }), num)
  if (showNames && marker.cam) {
    const name = svgEl('text', { x: 17, class: 'cam-name' })
    name.textContent = marker.cam.name
    g.append(name)
  }
  return g
}

/** Several cameras in one place: one dot carrying the count, coloured by its worst member. */
function clusterNode(cluster) {
  const g = svgEl('g', { class: `cam cluster st-${cluster.state}`, 'data-cluster': cluster.members.map((m) => m.key).join(' '), transform: `translate(${cluster.x.toFixed(1)} ${cluster.y.toFixed(1)})` })
  const title = svgEl('title')
  title.textContent = `${cluster.count} cameras here — ${STATES[cluster.state].title}. Zoom in, or click to.`
  const num = svgEl('text', { class: 'cam-num' })
  num.textContent = String(cluster.count)
  g.append(title, svgEl('circle', { r: 14, class: 'cam-dot' }), num)
  return g
}

/**
 * A whole site as one badge: its name and camera count, a dot in its worst camera's colour, and
 * the offline count in the alert colour. SVG has no box that grows with its text, so the pill's
 * width is reckoned from the length of the words; a few pixels out either way does not show.
 */
function badgeNode(b) {
  const text = badgeLabel(b)
  const off = b.offline ? ` · ${b.offline} offline` : ''
  const w = Math.round((text.length + off.length) * 6.6) + 34
  const g = svgEl('g', { class: `site-badge st-${b.state}`, 'data-site': b.name, transform: `translate(${b.sx.toFixed(1)} ${b.sy.toFixed(1)})` })
  const title = svgEl('title')
  title.textContent = badgeTitle(b)
  const label = svgEl('text', { x: -w / 2 + 24, class: 'site-badge-text' })
  label.textContent = text
  if (off) {
    const span = svgEl('tspan', { class: 'site-badge-off' })
    span.textContent = off
    label.append(span)
  }
  g.append(title, svgEl('rect', { x: -w / 2, y: -13, width: w, height: 26, rx: 13, class: 'site-badge-pill' }), svgEl('circle', { cx: -w / 2 + 13, cy: 0, r: 5, class: 'site-badge-dot' }), label)
  return g
}

/** While placing sites: a pin where each one is, so its position can be seen and corrected. */
function sitePinNode(name, pos) {
  const [x, y] = view.toScreen(lngToX(pos.lng), latToY(clamp(pos.lat, -MAX_LAT, MAX_LAT)))
  const g = svgEl('g', { class: `site-pin${name === site ? ' sel' : ''}`, transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` })
  const label = svgEl('text', { y: -16, class: 'site-pin-name' })
  label.textContent = name
  g.append(svgEl('path', { d: 'M 0 -9 L 9 0 L 0 9 L -9 0 Z', class: 'site-pin-mark' }), label)
  return g
}

/**
 * The one map's markers at this zoom: the cameras of the sites that are open, and a badge for
 * each site that is not. A plan shows every camera on it, as it always has.
 */
function scene() {
  const all = currentMarkers()
  if (planSite || !view.mode) return { markers: all, badges: [] }
  const { siteOf, badges } = oneMap()
  // the site of the camera being watched or worked on stays open under the person's hands
  const open = [selected, popup?.key].filter(Boolean).map((k) => siteOf[k])
  const shut = collapsedSites(badges, view.zoom, { open, editing: editing || linkMode })
  return {
    markers: visibleMarkers(all, siteOf, shut),
    badges: badges.filter((b) => shut.has(b.name)).map((b) => {
      const [sx, sy] = view.toScreen(b.x, b.y)
      return { ...b, sx, sy }
    })
  }
}

view.onDraw = () => {
  const m = current()
  const cones = svgEl('g')
  const marks = svgEl('g')
  const { markers, badges } = scene()
  if (m && view.mode) {
    const showNames = namesBox.checked
    // While editing, every camera stays its own marker: an admin is moving and aiming individual
    // cameras, and one that merged into a pile under the pointer could not be worked with at all.
    const pinned = [selected, popup?.key].filter(Boolean)
    const clusters = editing ? markers.map((x) => ({ x: x.x, y: x.y, members: [x], state: x.state, count: 1, key: x.key })) : clusterMarkers(markers, CLUSTER_GAP, pinned)
    const alone = new Set(clusters.filter((c) => c.count === 1).map((c) => c.key))
    for (const marker of markers) {
      // A cone belongs to one camera; drawing the cones of a whole cluster would be a blue smear
      // saying nothing, so a clustered camera keeps its position and loses its cone.
      if (!alone.has(marker.key)) continue
      const sel = marker.key === selected || marker.key === popup?.key ? ' sel' : ''
      cones.append(svgEl('path', { d: conePath([marker.x, marker.y], marker.dir, marker.fov, marker.r), class: `cone st-${marker.state}${sel}` }))
      marks.append(markerNode(marker, sel, showNames))
      if (editing && marker.key === selected) {
        const p = [marker.x, marker.y]
        const tip = polar(p, marker.dir, marker.r)
        marks.append(svgEl('circle', { cx: tip[0], cy: tip[1], r: 8, class: 'handle', 'data-handle': 'tip' }))
        if (marker.fov < 359.5) {
          const edge = polar(p, marker.dir + marker.fov / 2, marker.r)
          marks.append(svgEl('circle', { cx: edge[0], cy: edge[1], r: 6, class: 'handle edge', 'data-handle': 'edge' }))
        }
      }
    }
    for (const cluster of clusters) if (cluster.count > 1) marks.append(clusterNode(cluster))
    for (const b of badges) marks.append(badgeNode(b))
    if (editing && !planSite) {
      for (const s of oneMap().sites) if (s.placed) marks.append(sitePinNode(s.name, s.position))
    }
  }
  // links above the cones (they say where a person goes, not what a camera sees) but below the marks
  view.svg.replaceChildren(cones, linkLayer(current()), marks)
}

// ---- interaction ----

view.hitTest = (e, start) => {
  if (!editing || placing || placingSite) return null
  const handle = e.target.closest?.('[data-handle]')
  if (handle && selected && placed()[selected]) return dragHandle(handle.dataset.handle)
  const mark = e.target.closest?.('.cam')
  if (mark?.dataset.key) {
    select(mark.dataset.key)
    return dragCamera(mark.dataset.key, start)
  }
  return null
}

view.onClick = (p, target) => {
  if (placingSite) {
    const [wx, wy] = view.toWorld(p.x, p.y)
    setSitePosition(site, clamp(yToLat(clamp(wy, 0, TILE)), -MAX_LAT, MAX_LAT), clamp(xToLng(wx), -180, 180))
    return
  }
  if (placing) {
    placeAt(placing, p)
    return
  }
  const badge = target?.closest?.('.site-badge')
  if (badge) {
    // a badge is its site seen from far away: clicking it goes there, as its button in the row does
    goSite(badge.dataset.site)
    return
  }
  const pile = target?.closest?.('.cluster')
  if (pile) {
    // Clicking a pile of markers is a request to see what is in it, which only zooming can answer.
    zoomToCluster(pile.dataset.cluster.split(' '))
    return
  }
  const mark = target?.closest?.('.cam')
  if (mark?.dataset.key) {
    if (linkMode) clickedInLinkMode(mark.dataset.key)
    else if (editing) select(mark.dataset.key)
    else openLive(mark.dataset.key)
    return
  }
  if (editing || linkMode) select(null)
}

/**
 * Pick a camera, then click the cameras it leads to. Clicking a camera it already leads to takes
 * that link away again, so drawing and undrawing are the same gesture.
 */
function clickedInLinkMode(key) {
  if (!selected || selected === key) return select(selected === key ? null : key)
  const already = (linkData.links[selected] ?? []).some((n) => n.to === key)
  linkAction(already ? { action: 'unlink', from: selected, to: key } : { action: 'link', from: selected, to: key, label: newLabel, oneWay: newOneWay })
}

function dragCamera(key, start) {
  const m = current()
  const c = placed(m)[key]
  const w = camWorld(m, c)
  const s = view.toScreen(w.x, w.y)
  const offset = { x: s[0] - start.x, y: s[1] - start.y } // keep the grab point under the pointer
  return {
    move: (q) => {
      const [wx, wy] = view.toWorld(q.x + offset.x, q.y + offset.y)
      setCamPos(m, c, wx, wy)
      changed(siteOfKey(key))
      view.requestRender()
    },
    end: () => renderSide()
  }
}

function dragHandle(kind) {
  const m = current()
  const c = placed(m)[selected]
  return {
    move: (q) => {
      const w = camWorld(m, c)
      const p = view.toScreen(w.x, w.y)
      const dx = q.x - p[0]
      const dy = q.y - p[1]
      const angle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360
      if (kind === 'tip') {
        // aim, and set how far it sees
        c.dir = Math.round(angle)
        const dist = Math.hypot(dx, dy) / view.scale
        c.range = m.mode === 'geo' ? Math.round(dist * metresPerUnit(c.lat)) : Math.round(dist)
        c.range = clamp(c.range, 1, MAX_RANGE[m.mode])
      } else {
        // widen or narrow, symmetric about the direction
        const off = Math.abs(((angle - c.dir + 540) % 360) - 180)
        c.fov = clamp(Math.round(off * 2), 5, 360)
      }
      changed(siteOfKey(selected))
      syncInputs()
      view.requestRender()
    },
    end: () => renderSide()
  }
}

function placeAt(key, p) {
  placing = null
  view.el.classList.remove('placing')
  const m = current()
  if (!editing || !m) return
  const [wx, wy] = view.toWorld(p.x, p.y)
  const c = { dir: 0, fov: 90, range: m.mode === 'geo' ? 25 : Math.round(Math.min(m.plan.w, m.plan.h) * 0.12) }
  setCamPos(m, c, wx, wy)
  const name = planSite ?? camByKey(key)?.site
  if (!name) return
  if (planSite) {
    m.plan.cams ??= {}
    m.plan.cams[key] = c
  } else {
    // a camera dropped on the map before its site was placed puts the site there too
    const g = geoDraft(name, c.lat, c.lng)
    g.cams[key] = c
  }
  selected = key
  changed(name)
  renderSites()
  renderSide()
  view.requestRender()
}

/** A site's geo block in the drafts, made at the given position if the site had none. */
function geoDraft(name, lat, lng) {
  const d = (drafts[name] ??= {})
  if (!sitePosition(d)) d.geo = { ...d.geo, lat, lng, zoom: PLACE_ZOOM, layer }
  d.geo.cams ??= {}
  return d.geo
}

/** A site's cameras that are not on the one map yet. */
const unplacedKeys = (name) => {
  const on = source()[name]?.geo?.cams ?? {}
  return siteCams(name).map(camKey).filter((k) => !on[k])
}

/** Drops a site's unplaced cameras in a ring around its position, to be dragged to their spots. */
function dropRing(name) {
  const pos = sitePosition(drafts[name])
  const keys = unplacedKeys(name)
  if (!pos || !keys.length) return 0
  Object.assign(geoDraft(name, pos.lat, pos.lng).cams, ringPlacements(pos, keys))
  changed(name)
  return keys.length
}

/**
 * Says where a site is. The first time, its cameras come with it, in a ring around the spot, so
 * placing a site is one click and then dragging; after that, moving the site's position leaves
 * its cameras where they were put.
 */
function setSitePosition(name, lat, lng) {
  placingSite = false
  view.el.classList.remove('placing')
  if (!editing || !name) return
  const first = !sitePosition(drafts[name])
  const g = geoDraft(name, lat, lng)
  g.lat = lat
  g.lng = lng
  changed(name)
  const dropped = first ? dropRing(name) : 0
  renderSites()
  renderSide()
  setStatus(dropped ? `${name} placed, with ${dropped} camera${dropped === 1 ? '' : 's'} in a ring around it. Drag each to where it is, then Save.` : `${name} ${first ? 'placed' : 'moved'}. Unsaved changes`)
  flyToSite(name)
}

function select(key) {
  if (selected === key) return
  selected = key
  renderSide()
  view.requestRender()
}

/** Something in a site's map was edited: that site is saved, and the one map is worked out again. */
function changed(name) {
  if (name) dirtySites.add(name)
  stale()
  setStatus('Unsaved changes')
}

let statusEl = null
function setStatus(text) {
  if (statusEl) statusEl.textContent = text
}

// drag a camera from the list onto the map
view.el.addEventListener('dragover', (e) => {
  if (editing && e.dataTransfer?.types.includes('text/x-cctv-cam')) e.preventDefault()
})
view.el.addEventListener('drop', (e) => {
  const key = e.dataTransfer?.getData('text/x-cctv-cam')
  if (!editing || !key) return
  e.preventDefault()
  const r = view.el.getBoundingClientRect()
  placeAt(key, { x: e.clientX - r.left, y: e.clientY - r.top })
})

// ---- live popup ----

function openLive(key) {
  const cam = camByKey(key)
  if (!cam) return
  closeLive()
  const tile = el('div', { className: 'tile' })
  tile.innerHTML = TILE_HTML
  const close = el('button', { type: 'button', className: 'map-live-close', textContent: '×', 'aria-label': 'Close' })
  close.addEventListener('click', closeLive)
  // The state is repeated here in words: someone who came to a camera from a coloured dot should
  // not have to remember which colour it was, and "online, recording nothing" is not obvious from
  // a live picture, which looks perfectly healthy while nothing is being kept.
  const state = stateFor(key)
  liveEl.replaceChildren(
    el('div', { className: 'map-live-head' },
      el('span', { className: 'map-live-name', textContent: `${cam.ch + 1} · ${cam.name}` }),
      el('span', { className: `map-live-state st-${state}`, textContent: STATES[state].label, title: STATES[state].title }),
      el('a', { href: playbackHref(cam), textContent: 'Recordings' }),
      close),
    tile
  )
  liveEl.hidden = false
  popup = { key, tile: null }
  // Either source saying it is down is enough not to ask the NVR for a stream it cannot give.
  if (state === 'offline' || !cam.online) {
    tile.classList.add('offline')
    tile.querySelector('.status').textContent = 'offline'
  } else {
    popup.tile = new LiveTile(tile, cam, SUB_STREAM, 0, { onDisconnect: checkSession })
  }
  view.requestRender()
}

function closeLive() {
  popup?.tile?.close()
  popup = null
  liveEl.hidden = true
  liveEl.replaceChildren()
  view.requestRender()
}

// no video while the tab is hidden
let hiddenTimer
document.addEventListener('visibilitychange', () => {
  clearTimeout(hiddenTimer)
  if (document.hidden) hiddenTimer = setTimeout(closeLive, 3000)
})

// ---- the one map, the sites on it, and a site's plan ----

function showEmpty(...content) {
  emptyEl.replaceChildren(...content)
  emptyEl.hidden = false
}

/**
 * Sets up the background: the open plan, else the street/satellite map every site shares.
 * keepView: don't move the view (same background).
 */
function applyView(keepView = false) {
  emptyEl.hidden = true
  const plan = planSite && planOf(planSite)
  if (plan) {
    view.setPlan(`/api/maps/plan/${plan.plan.file}`, plan.plan.w, plan.plan.h, keepView)
    view.requestRender()
    return
  }
  planSite = null
  view.setGeo({ ...DEFAULT_GEO, layer }, keepView)
  if (!editing && !oneMap().badges.length) showEmpty(firstRunCard())
  view.requestRender()
}

/**
 * What the map says before any site has been placed on it, which is how every installation
 * starts. A small solid card, not a sheet over the map: the map behind it still drags and zooms.
 * An admin is taken straight to placing a site; anyone else is told where the plans are.
 */
function firstRunCard() {
  const card = el('div', { className: 'map-empty-card' })
  if (!siteNames.length) {
    card.append(el('p', { textContent: 'No cameras yet.' }))
    return card
  }
  card.append(el('p', { textContent: 'No site is on the map yet.' }))
  const sites = oneMap().sites
  if (isAdmin) {
    const name = sites.some((s) => s.name === site) ? site : sites[0].name
    card.append(
      el('p', { textContent: 'Say where a site is and its cameras are dropped around it, ready to be dragged to their spots.' }),
      el('button', { type: 'button', className: 'st-primary', textContent: `Place ${name}`, onclick: () => startPlaceSite(name) }))
  } else if (sites.some((s) => s.hasPlan)) {
    card.append(el('p', { textContent: 'A site with a plan still opens it: press Plan beside its name in the row above.' }))
  }
  return card
}

const here = () => ({ cx: view.cx, cy: view.cy, zoom: view.zoom })

/** Where the one map should be to show a site, or every site for ''. Null when nothing is placed. */
function siteTarget(name) {
  const all = { sites: source() }
  return name ? siteView(badgeOf(name), all.sites[name], view.size()) : allView(oneMap().badges, all, view.size())
}

/**
 * Travels to a site (or to everything) rather than jumping there: flyTo pulls back far enough to
 * show where the new place is on the way, and lands at once for a person who has asked for no
 * animation. False when the site has no place to go to.
 */
function flyToSite(name, ms) {
  const to = siteTarget(name)
  if (to) view.flyTo(to, ms)
  return Boolean(to)
}

/** Back from a site's plan to the one map, where it was left. */
function leavePlan() {
  if (!planSite) return
  planSite = null
  applyView(false)
  if (geoBefore) Object.assign(view, geoBefore)
  geoBefore = null
}

/** A site button, a badge, or "All sites" (''): choose it and fly there on the one map. */
function goSite(name) {
  site = siteNames.includes(name) ? name : ''
  try { localStorage.setItem('cctv.mapSite', site) } catch {}
  selected = null
  placing = null
  placingSite = false
  view.el.classList.remove('placing')
  closeLive()
  leavePlan()
  renderSites()
  renderSide()
  flyToSite(site)
  view.requestRender()
}

/** A site's plan as its close-up. The one map is left where it was, to come back to. */
function openPlan(name) {
  if (!planOf(name)) return
  view.cancelFly()
  if (!planSite) geoBefore = here()
  site = name
  planSite = name
  selected = null
  placing = null
  placingSite = false
  view.el.classList.remove('placing')
  closeLive()
  applyView(false)
  renderSites()
  renderSide()
}

/** "Place this site": into Edit mode with that site chosen, waiting for a click on the map. */
function startPlaceSite(name) {
  if (!isAdmin) return
  if (linkMode) stopLinks() // one kind of editing at a time
  startEdit() // does nothing when an edit is already under way, so nothing unsaved is dropped
  goSite(name)
  placingSite = true
  view.el.classList.add('placing')
  renderSide()
  setStatus(`Click the map where ${name} is, or type its coordinates.`)
}

/**
 * The row of site buttons along the top: "All sites", then one per site with its camera count
 * and, in the alert colour, how many are offline. A site with a plan has a Plan button beside it;
 * one that is not on the map yet says so and, for an admin, offers to place it. Real buttons, so
 * the row is reachable and usable from the keyboard; it is redrawn whole when anything in it
 * changes, and the focus is put back on the button it was on.
 */
function renderSites({ reveal = true } = {}) {
  const focused = sitesRow.contains(document.activeElement) ? document.activeElement.dataset.fid : null
  const btn = (fid, props, ...children) => el('button', { type: 'button', 'data-fid': fid, ...props }, ...children)
  const parts = []
  if (planSite) {
    const back = btn('back', { className: 'map-site-back', textContent: '← Map', title: 'Back to the map of every site' })
    back.addEventListener('click', () => goSite(site))
    parts.push(back)
  }
  const all = btn('all', { className: 'map-site-go', textContent: 'All sites', 'aria-pressed': String(!planSite && !site) })
  all.addEventListener('click', () => goSite(''))
  parts.push(el('span', { className: `map-site${!planSite && !site ? ' sel' : ''}` }, all))
  for (const s of oneMap().sites) {
    const offline = s.keys.filter((k) => stateFor(k) === 'offline').length
    // said in full for a screen reader: read as written, "37" and "4 offline" run together as 374
    const spoken = `${s.name}, ${s.count} camera${s.count === 1 ? '' : 's'}${offline ? `, ${offline} offline` : ''}${s.placed ? '' : ', not placed on the map'}`
    const go = btn(`go:${s.name}`, { className: 'map-site-go', 'aria-label': spoken, 'aria-pressed': String(!planSite && site === s.name) },
      `${s.name} · ${s.count}`,
      offline ? el('span', { className: 'map-site-off', textContent: `${offline} offline` }) : null,
      s.placed ? null : el('span', { className: 'map-site-hint', textContent: 'not placed' }))
    go.addEventListener('click', () => goSite(s.name))
    const group = el('span', { className: `map-site${site === s.name ? ' sel' : ''}`, role: 'group', 'aria-label': s.name }, go)
    if (s.hasPlan) {
      const plan = btn(`plan:${s.name}`, { className: 'map-site-plan', textContent: 'Plan', title: `The plan of ${s.name}`, 'aria-pressed': String(planSite === s.name) })
      plan.addEventListener('click', () => (planSite === s.name ? goSite(s.name) : openPlan(s.name)))
      group.append(plan)
    }
    if (!s.placed && isAdmin) {
      const place = btn(`place:${s.name}`, { className: 'map-site-place', textContent: 'Place this site' })
      place.addEventListener('click', () => startPlaceSite(s.name))
      group.append(place)
    }
    parts.push(group)
  }
  sitesRow.replaceChildren(...parts)
  if (focused) {
    // back on the button it was on; if that button has gone (a site just placed has no "Place
    // this site" any more), on the site's own button rather than nowhere
    const at = (fid) => [...sitesRow.querySelectorAll('button')].find((b) => b.dataset.fid === fid)
    const own = focused.includes(':') ? `go:${focused.slice(focused.indexOf(':') + 1)}` : site ? `go:${site}` : 'all'
    ;(at(focused) ?? at(own) ?? at('all'))?.focus()
  }
  // the chosen site may be off the end of the row, on a phone usually is: bring it into view
  if (reveal) sitesRow.querySelector('.map-site.sel')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
}

/** Zooms to the chosen site's cameras, or every site's; in a plan, to the whole plan. */
function fitAll() {
  if (!view.mode) return
  if (planSite) return view.fit()
  if (!flyToSite(site, 600)) flyToSite('', 600)
}

/**
 * Opens a pile of markers out: fly to the box holding them, which at that zoom separates them.
 * Flying rather than jumping keeps the sense of where they were, exactly as moving between sites
 * does, and flyTo itself honours a person who has asked for no animation.
 */
function zoomToCluster(keys) {
  const m = current()
  const box = m && boundsOf(m, keys)
  if (!box) return
  const before = { cx: view.cx, cy: view.cy, zoom: view.zoom }
  view.fit(box)
  const to = { cx: view.cx, cy: view.cy, zoom: Math.max(view.zoom, before.zoom + 1) }
  Object.assign(view, before)
  view.flyTo(to, 600)
}

function centreOnCamera(key) {
  const m = current()
  const c = placed(m)[key]
  if (!c) return
  const w = camWorld(m, c)
  view.centreOn(w.x, w.y)
}

/**
 * Brings a camera from the list into view. On the one map that may be a long way off and far
 * closer in than the map is now, so it is flown to; on a plan it is only ever a short slide.
 */
function showCamera(key) {
  const m = current()
  const c = placed(m)[key]
  if (!c) return
  if (planSite) return centreOnCamera(key)
  const w = camWorld(m, c)
  view.flyTo({ cx: w.x, cy: w.y, zoom: Math.max(view.zoom, PLACE_ZOOM) }, 700)
}

// ---- side panel ----

function renderSide() {
  statusEl = null
  side.replaceChildren(...(linkMode ? linkPanel() : editing ? editPanel() : viewPanel()))
}

function camRow(cam, key, extra, opts = {}) {
  // The same colour and the same words as the marker on the map, from the same state.
  const state = cam ? stateFor(key) : 'unknown'
  const dot = el('span', { className: `map-dot st-${state}`, title: STATES[state].title })
  const li = el('li', { className: `${opts.placed ? 'placed' : 'unplaced'}${key === selected || key === popup?.key ? ' sel' : ''}` },
    dot, el('span', { className: 'map-cam-name', textContent: camLabel(cam, key) }), extra)
  return li
}

function viewPanel() {
  const name = listSite()
  const info = name ? siteInfo(name) : null
  const where = placed()
  const list = el('ul', { className: 'map-cams' })
  const names = name ? [name] : siteNames
  let on = 0
  let total = 0
  for (const n of names) {
    // every site at once: each under its own name, so the list reads the way the map does
    if (names.length > 1) list.append(el('li', { className: 'map-cams-site', textContent: n }))
    for (const cam of siteCams(n)) {
      const key = camKey(cam)
      total++
      if (where[key]) {
        on++
        const btn = el('button', { type: 'button', className: 'st-link', textContent: 'Show' })
        const li = camRow(cam, key, btn, { placed: true })
        const show = () => {
          showCamera(key)
          openLive(key)
          renderSide()
        }
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          show()
        })
        li.addEventListener('click', show)
        list.append(li)
      } else {
        list.append(camRow(cam, key, el('span', { className: 'map-note', textContent: planSite ? 'not on plan' : 'not on map' })))
      }
    }
  }
  const parts = [el('h2', { textContent: planSite ? `${planSite}: plan` : name || 'All sites' })]
  if (info && !info.placed && !planSite) {
    // a site nobody has put on the map: say so, and say what can be done about it
    parts.push(el('p', { className: 'map-help', textContent: `${name} is not placed on the map yet.${info.hasPlan ? ' Its plan is still here: press Plan.' : ''}` }))
    const acts = el('div', { className: 'map-actions' })
    if (info.hasPlan) acts.append(el('button', { type: 'button', textContent: 'Plan', onclick: () => openPlan(name) }))
    if (isAdmin) acts.append(el('button', { type: 'button', className: 'st-primary', textContent: 'Place this site', onclick: () => startPlaceSite(name) }))
    if (acts.childElementCount) parts.push(acts)
  } else {
    parts.push(el('p', { className: 'map-help', textContent: `${on} of ${total} on the ${planSite ? 'plan' : 'map'}. Click a camera for live video.` }))
  }
  parts.push(legend(), list)
  return parts
}

/**
 * What the colours mean, with the number of markers in each: the chosen site's, or every site's.
 * A colour nobody can read is worse than no colour, and the count is the quickest answer to "is
 * anything wrong here". States with nothing in them are left out, so the usual case is two short
 * lines, not five.
 */
function legend() {
  const mine = planSite || !site ? currentMarkers() : currentMarkers().filter((m) => oneMap().siteOf[m.key] === site)
  const counts = stateCounts(mine)
  const ul = el('ul', { className: 'map-legend' })
  for (const [state, meta] of Object.entries(STATES)) {
    if (!counts[state]) continue
    ul.append(el('li', {}, el('span', { className: `map-dot st-${state}` }), el('span', { textContent: `${counts[state]} ${meta.label}`, title: meta.title })))
  }
  if (!ul.childElementCount) return el('span', { hidden: true })
  return ul
}

function uploadButton() {
  const input = el('input', { type: 'file', accept: 'image/*', hidden: true })
  input.addEventListener('change', () => input.files[0] && uploadPlan(input.files[0]))
  const btn = el('button', { type: 'button', textContent: drafts?.[listSite()]?.plan?.file ? 'Replace plan image…' : 'Upload plan image…' })
  btn.addEventListener('click', () => input.click())
  return el('span', {}, btn, input)
}

/** Where the chosen site is on the one map: set by a click on the map or by typing coordinates. */
function sitePanel(name) {
  const pos = sitePosition(drafts[name])
  const find = el('input', { type: 'text', placeholder: '42.7070, -71.1631 or a Google Maps link', value: pos ? `${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}` : '' })
  const set = el('button', { type: 'button', textContent: 'Set' })
  const setTyped = () => {
    const at = parseLatLng(find.value)
    if (!at) {
      find.setCustomValidity('Type the latitude and longitude on their own, like 42.7070, -71.1631, or paste a Google Maps link.')
      find.reportValidity()
      return
    }
    find.setCustomValidity('')
    setSitePosition(name, at.lat, at.lng)
  }
  set.addEventListener('click', setTyped)
  find.addEventListener('keydown', (e) => e.key === 'Enter' && setTyped())
  const pick = el('button', { type: 'button', textContent: placingSite ? 'Click the map… (Esc to stop)' : pos ? 'Move it: click the map' : 'Place it: click the map' })
  pick.addEventListener('click', () => {
    placingSite = !placingSite
    placing = null
    view.el.classList.toggle('placing', placingSite)
    renderSide()
  })
  const section = el('section', {},
    el('h2', { textContent: name }),
    el('p', { className: 'map-help', textContent: pos
      ? 'Where this site is on the map. Moving it leaves its cameras where they are.'
      : `${name} is not on the map yet. Say where it is and its cameras are dropped in a ring around it, ready to be dragged to their spots.` }),
    // the label names the box alone; Set sits beside it, not inside it
    el('div', { className: 'map-find' }, el('label', {}, 'Latitude, longitude', find), set),
    pick)
  const waiting = unplacedKeys(name).length
  if (pos && waiting) {
    const ring = el('button', { type: 'button', textContent: `Drop the ${waiting} unplaced camera${waiting === 1 ? '' : 's'} around it` })
    ring.addEventListener('click', () => {
      dropRing(name)
      renderSide()
      flyToSite(name, 600)
    })
    section.append(ring)
  }
  // the plan is the site's close-up: uploaded here, opened from its Plan button in the row
  section.append(uploadButton())
  if (drafts[name]?.plan?.file) section.append(el('button', { type: 'button', textContent: 'Open its plan', onclick: () => openPlan(name) }))
  return section
}

function editPanel() {
  const name = listSite()
  const parts = []
  if (planSite) {
    parts.push(el('section', {},
      el('h2', { textContent: `${planSite}: plan` }),
      uploadButton(),
      el('p', { className: 'map-help', textContent: 'A floor plan, yard layout or aerial photo (JPEG, PNG or WebP). Large images are scaled down to 4096 px.' })))
  } else if (name) {
    parts.push(sitePanel(name))
  } else {
    parts.push(el('section', {},
      el('h2', { textContent: 'Place the sites' }),
      el('p', { className: 'map-help', textContent: 'Choose a site in the row above to say where it is and to place its cameras. Cameras already on the map can be dragged and aimed from here.' })))
  }

  const where = placed()
  if (name) {
    // cameras: this site's, plus whatever else is stored under it -- a placement whose camera no
    // longer exists, or now belongs to another site -- so that it can be seen and removed
    const mine = planSite ? where : drafts[name]?.geo?.cams ?? {}
    const list = el('ul', { className: 'map-cams' })
    const keys = new Set(siteCams(name).map(camKey))
    for (const k of Object.keys(mine)) keys.add(k)
    for (const key of keys) {
      const cam = camByKey(key)
      if (mine[key]) {
        const remove = el('button', { type: 'button', className: 'st-link st-danger', textContent: 'Remove' })
        remove.addEventListener('click', (e) => {
          e.stopPropagation()
          removePlacement(key, name)
        })
        const li = camRow(cam, key, remove, { placed: true })
        if (cam && cam.site !== name) li.append(el('span', { className: 'map-note', textContent: `now at ${cam.site}` }))
        li.addEventListener('click', () => {
          select(key)
          centreOnCamera(key)
        })
        list.append(li)
      } else if (cam) {
        const place = el('button', { type: 'button', className: 'st-link', textContent: placing === key ? 'Click the map…' : 'Place' })
        place.addEventListener('click', () => {
          placing = placing === key ? null : key
          placingSite = false
          view.el.classList.toggle('placing', Boolean(placing))
          renderSide()
        })
        const li = camRow(cam, key, place)
        li.draggable = true
        li.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/x-cctv-cam', key)
          e.dataTransfer.effectAllowed = 'copy'
        })
        list.append(li)
      }
    }
    parts.push(el('section', {},
      el('h2', { textContent: 'Cameras' }),
      el('p', { className: 'map-help', textContent: 'Drag a camera onto the map, or click Place and then click the map.' }),
      list))
  }

  const c = selected && where[selected]
  if (c) parts.push(selectedPanel(current(), c))

  statusEl = el('p', { className: 'map-help', role: 'status', textContent: dirtySites.size ? 'Unsaved changes' : '' })
  const save = el('button', { type: 'button', className: 'st-primary', textContent: 'Save', disabled: saving })
  save.addEventListener('click', saveMap)
  const cancel = el('button', { type: 'button', textContent: 'Cancel', disabled: saving })
  cancel.addEventListener('click', () => stopEdit())
  parts.push(el('div', { className: 'map-actions' }, save, cancel), statusEl)
  return parts
}

/** Takes a camera off the map being edited (the open plan, or its site's place on the one map). */
function removePlacement(key, name = siteOfKey(key)) {
  const cams = planSite ? placed() : drafts[name]?.geo?.cams
  if (!cams?.[key]) return
  delete cams[key]
  if (selected === key) selected = null
  changed(name)
  renderSites()
  renderSide()
  view.requestRender()
}

function selectedPanel(m, c) {
  const cam = camByKey(selected)
  const slider = (label, key, min, max, unit) => {
    const input = el('input', { type: 'range', min, max, step: 1, value: Math.round(c[key]), 'data-field': key })
    const out = el('output', { textContent: `${Math.round(c[key])}${unit}`, 'data-out': key })
    input.addEventListener('input', () => {
      c[key] = Number(input.value)
      out.textContent = `${input.value}${unit}`
      changed(siteOfKey(selected))
      view.requestRender()
    })
    return el('label', {}, el('span', { className: 'map-field' }, label, out), input)
  }
  const range = el('input', { type: 'number', min: 1, max: MAX_RANGE[m.mode], step: 1, value: Math.round(c.range), 'data-field': 'range' })
  range.addEventListener('input', () => {
    const v = Number(range.value)
    if (v >= 1 && v <= MAX_RANGE[m.mode]) {
      c.range = v
      changed(siteOfKey(selected))
      view.requestRender()
    }
  })
  return el('section', { className: 'map-selected' },
    el('h2', { textContent: camLabel(cam, selected) }),
    slider('Direction', 'dir', 0, 359, '°'),
    slider('Field of view', 'fov', 5, 360, '°'),
    el('label', {}, m.mode === 'geo' ? 'Range (metres)' : 'Range (plan pixels)', range),
    el('p', { className: 'map-help', textContent: 'On the map: drag the camera to move it, the white handle to aim it and set its range, the small handle to widen or narrow its view.' }))
}

/** Keeps the selected camera's inputs in step while its handles are dragged. */
function syncInputs() {
  const c = selected && placed()[selected]
  if (!c) return
  for (const input of side.querySelectorAll('[data-field]')) input.value = String(Math.round(c[input.dataset.field]))
  for (const out of side.querySelectorAll('[data-out]')) out.textContent = `${Math.round(c[out.dataset.out])}°`
}

// ---- which camera adjoins which ----

/** The guesses still worth offering for a camera: not ones already drawn since the page loaded. */
function suggestionsFor(key) {
  const drawn = new Set((linkData.links[key] ?? []).map((n) => n.to))
  return (linkData.suggestions[key] ?? []).filter((s) => !drawn.has(s.to))
}

async function loadLinks() {
  try {
    linkData = await api('GET', '/api/camera-links')
  } catch (e) {
    setStatus(`Could not read the camera links: ${e.message}`)
  }
}

/**
 * One change, named against the version it was made on. Another admin having saved in the meantime
 * gives 409 with the latest links; the change is then made again on those rather than overwriting
 * their work. It is tried once more only, so a page cannot loop against a busy server.
 */
async function linkAction(body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch('/api/admin/camera-links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, version: linkData.version })
    })
    if (res.status === 401) return (location.href = '/login.html')
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      linkData.links = data.links
      linkData.version = data.version
      setStatus('Saved')
      renderSide()
      view.requestRender()
      return true
    }
    if (res.status === 409 && attempt === 0) {
      linkData.links = data.links
      linkData.version = data.version
      setStatus('Someone else changed the links; doing your change again on theirs…')
      continue
    }
    setStatus(`Could not save: ${data.error ?? `HTTP ${res.status}`}`)
    renderSide()
    return false
  }
  return false
}

function linkPanel() {
  const m = current()
  const where = placed(m)
  const cam = camByKey(selected)
  const parts = [
    el('h2', { textContent: 'Which camera leads where' }),
    el('p', { className: 'map-help', textContent: 'Click a camera, then click the cameras a person can walk to from it. Clicking a linked camera again takes the link away.' })
  ]

  const label = el('input', { type: 'text', maxLength: 60, value: newLabel, placeholder: 'through the front door' })
  label.addEventListener('input', () => {
    newLabel = label.value
  })
  const oneWay = el('input', { type: 'checkbox', checked: newOneWay })
  oneWay.addEventListener('change', () => {
    newOneWay = oneWay.checked
  })
  parts.push(
    el('section', {},
      el('label', {}, 'Label for the next link', label),
      el('label', { className: 'map-link-oneway' }, oneWay, ' One-way only (a fire door, a stairwell)'),
      el('p', { className: 'map-help', textContent: 'Links lead both ways unless you say otherwise: a way out is nearly always a way back.' }))
  )

  if (!selected) {
    parts.push(el('p', { className: 'map-help', textContent: 'No camera chosen yet.' }))
  } else if (!where[selected]) {
    parts.push(el('p', { className: 'map-help', textContent: `${camLabel(cam, selected)} is not on the map. Place it first, under Edit map.` }))
  } else {
    const list = el('ul', { className: 'map-cams' })
    const mine = linkData.links[selected] ?? []
    for (const n of mine) {
      const back = (linkData.links[n.to] ?? []).some((x) => x.to === selected)
      const text = el('input', { type: 'text', maxLength: 60, value: n.label, placeholder: 'where it leads', className: 'map-link-label' })
      // saved when the box is left, not on every keystroke: one save per edit, not one per letter
      text.addEventListener('change', () => linkAction({ action: 'link', from: selected, to: n.to, label: text.value, oneWay: !back }))
      const flip = el('button', { type: 'button', className: 'st-link', textContent: back ? 'Make one-way' : 'Make two-way' })
      flip.addEventListener('click', () =>
        back
          ? linkAction({ action: 'unlink', from: n.to, to: selected, oneWay: true })
          : linkAction({ action: 'link', from: n.to, to: selected, label: n.label })
      )
      const remove = el('button', { type: 'button', className: 'st-link st-danger', textContent: 'Remove' })
      remove.addEventListener('click', () => linkAction({ action: 'unlink', from: selected, to: n.to }))
      const li = camRow(camByKey(n.to), n.to, el('span', { className: 'map-link-actions' }, flip, remove), { placed: true })
      li.append(el('span', { className: 'map-link-dir', title: back ? 'Leads both ways' : 'Leads one way only', textContent: back ? '↔' : '→' }), text)
      list.append(li)
    }
    parts.push(el('section', {},
      el('h2', { textContent: camLabel(cam, selected) }),
      mine.length ? list : el('p', { className: 'map-help', textContent: 'No links yet. Click the cameras this one leads to.' })))

    const guesses = suggestionsFor(selected).filter((s) => where[s.to])
    if (guesses.length) {
      const gl = el('ul', { className: 'map-cams map-suggested' })
      for (const s of guesses) {
        const add = el('button', { type: 'button', className: 'st-link', textContent: 'Add link' })
        add.addEventListener('click', () => linkAction({ action: 'link', from: selected, to: s.to, label: newLabel, oneWay: newOneWay }))
        const li = camRow(camByKey(s.to), s.to, add)
        li.append(el('span', { className: 'map-note', textContent: `about ${s.distance} ${s.units} away` }))
        gl.append(li)
      }
      parts.push(el('section', { className: 'map-suggest' },
        el('h2', {}, 'Suggestions ', el('span', { className: 'map-guess-tag', textContent: 'guesses' })),
        el('p', { className: 'map-help', textContent: 'Only the nearest cameras on this map. Nothing here is saved until you add it.' }),
        gl))
    }
  }

  statusEl = el('p', { className: 'map-help', role: 'status', textContent: '' })
  const done = el('button', { type: 'button', textContent: 'Done' })
  done.addEventListener('click', stopLinks)
  parts.push(el('div', { className: 'map-actions' }, done), statusEl)
  return parts
}

async function startLinks() {
  closeLive()
  linkMode = true
  selected = null
  editBtn.hidden = true
  linksBtn.hidden = true
  view.el.classList.add('linking')
  renderSide()
  await loadLinks()
  renderSide()
  view.requestRender()
}

function stopLinks() {
  linkMode = false
  selected = null
  view.el.classList.remove('linking')
  editBtn.hidden = linksBtn.hidden = !isAdmin
  renderSide()
  view.requestRender()
}

// ---- editing ----

/**
 * Edit mode works on a copy of every site's map at once: on the one map an admin moves between
 * sites while placing them, and each site that was touched is saved through its own route.
 */
function startEdit() {
  if (editing) return // already editing: starting again would throw the unsaved work away
  closeLive()
  drafts = structuredClone(maps.sites)
  editing = true
  dirtySites.clear()
  selected = null
  placing = null
  placingSite = false
  stale()
  editBtn.hidden = true
  linksBtn.hidden = true
  applyView(true)
  renderSites()
  renderSide()
}

function stopEdit(force = false) {
  if (!force && dirtySites.size && !confirm('Discard the changes to the map?')) return
  editing = false
  drafts = null
  dirtySites.clear()
  selected = null
  placing = null
  placingSite = false
  view.el.classList.remove('placing')
  stale()
  editBtn.hidden = linksBtn.hidden = !isAdmin
  applyView(true)
  renderSites()
  renderSide()
}

async function uploadPlan(file) {
  const name = listSite()
  if (!editing || !name) return
  try {
    setStatus('Preparing the image…')
    const bitmap = await createImageBitmap(file)
    const k = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * k))
    const h = Math.max(1, Math.round(bitmap.height * k))
    const canvas = el('canvas', { width: w, height: h })
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff' // transparent areas of a PNG become white
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    let data = canvas.toDataURL('image/jpeg', 0.85)
    if (data.length > 16_000_000) data = canvas.toDataURL('image/jpeg', 0.6)
    setStatus('Uploading…')
    const saved = await api('POST', `/api/admin/maps/${enc(name)}/plan`, { data, w, h })
    // the server kept its saved cameras in place on the new image; do the same for unsaved ones
    const d = (drafts[name] ??= {})
    const old = d.plan
    const cams = {}
    if (old?.cams && old.w && old.h) {
      const sx = w / old.w
      const sy = h / old.h
      for (const [key, c] of Object.entries(old.cams)) cams[key] = { ...c, x: Math.round(c.x * sx), y: Math.round(c.y * sy), range: Math.round(c.range * Math.sqrt(sx * sy)) }
    }
    maps.sites[name] = saved
    d.plan = { ...saved.plan, cams }
    stale()
    // the new plan is opened, so the cameras can be put on it straight away
    if (planSite === name) {
      applyView(false)
      renderSites()
      renderSide()
    } else {
      openPlan(name)
    }
    changed(name)
    setStatus('Plan uploaded. Place the cameras, then Save.')
  } catch (e) {
    setStatus(`Upload failed: ${e.message}`)
  }
}

/**
 * Saves each site that was changed, through the same admin route as ever, one site at a time.
 * One site failing does not stop the others being stored: every failure is named with its reason,
 * the stored ones are named too, and what failed stays in the edit to be put right and saved
 * again. Save and Cancel wait while it runs, so nothing is sent twice or dropped halfway.
 */
async function saveMap() {
  if (saving) return
  saving = true
  for (const b of side.querySelectorAll('.map-actions button')) b.disabled = true
  setStatus('Saving…')
  const stored = []
  const failed = []
  for (const name of [...dirtySites]) {
    const body = saveBody(drafts[name], layer)
    if (body) {
      try {
        maps.sites[name] = await api('PUT', `/api/admin/maps/${enc(name)}`, body)
        stored.push(name)
      } catch (e) {
        failed.push({ name, error: e.message })
        continue
      }
    }
    dirtySites.delete(name)
  }
  saving = false
  if (!failed.length) return stopEdit(true)
  renderSide()
  setStatus(saveSummary(stored, failed))
}

addEventListener('beforeunload', (e) => {
  if (editing && dirtySites.size) e.preventDefault()
})

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea')) return
  if (e.key === 'Escape') {
    if (placing || placingSite) {
      placing = null
      placingSite = false
      view.el.classList.remove('placing')
      renderSide()
    } else if (popup) {
      closeLive()
    } else if (linkMode && selected) {
      select(null)
    } else if (editing && selected) {
      select(null)
    }
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && editing && selected && placed()[selected]) removePlacement(selected)
  if (e.key === '+' || e.key === '=') view.zoomBy(0.5)
  if (e.key === '-') view.zoomBy(-0.5)
})

$('zoomIn').addEventListener('click', () => view.zoomBy(1))
$('zoomOut').addEventListener('click', () => view.zoomBy(-1))
$('fit').addEventListener('click', fitAll)
editBtn.addEventListener('click', startEdit)
linksBtn.addEventListener('click', startLinks)

try {
  namesBox.checked = localStorage.getItem('cctv.mapNames') !== '0'
} catch {}
namesBox.addEventListener('change', () => {
  try { localStorage.setItem('cctv.mapNames', namesBox.checked ? '1' : '0') } catch {}
  view.requestRender()
})

// street map or satellite pictures: one choice for the whole map, remembered in this browser
satBox.addEventListener('change', () => {
  layer = satBox.checked ? 'satellite' : 'street'
  try { localStorage.setItem('cctv.mapLayer', layer) } catch {}
  if (!planSite && view.mode === 'geo') view.setGeo({ layer, ...view.geoView() }, true)
})

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' })
  location.href = '/login.html'
})

// ---- start ----

const me = await checkSession()
if (me) $('whoami').textContent = me.user
isAdmin = Boolean(me?.admin)
if (isAdmin) { const st = $('sitesTab'); if (st) st.hidden = false; const se = $('settingsTab'); if (se) se.hidden = false }
setInterval(checkSession, 60_000)

/**
 * What every camera is doing, from the Health page's own endpoint. A failed poll leaves the last
 * states alone rather than blanking them: a dropped request is not evidence that anything changed.
 */
async function loadStates() {
  try {
    states = cameraStates(await api('GET', '/api/health')).byKey
    return true
  } catch {
    return false
  }
}

/** The roster, and from it the sites in the row: every site that has a real camera. */
function setCameras(list) {
  cameras = list
  siteNames = [...new Set(cameras.filter((c) => c.configured !== false).map((c) => c.site))].sort((a, b) => String(a).localeCompare(String(b)))
  stale()
}

{
  const [roster, stored] = await Promise.all([api('GET', '/api/cameras'), api('GET', '/api/maps'), loadStates()])
  maps = stored
  setCameras(roster)
}
{
  let savedSite = ''
  let savedLayer = ''
  try {
    savedSite = localStorage.getItem('cctv.mapSite') ?? ''
    savedLayer = localStorage.getItem('cctv.mapLayer') ?? ''
  } catch {}
  site = siteNames.includes(savedSite) ? savedSite : '' // every site, unless one was chosen last time
  // the layer chosen in this browser, else the one the first placed site was saved with
  const first = siteNames.map((n) => maps.sites[n]).find((m) => sitePosition(m))
  layer = LAYERS[savedLayer] ? savedLayer : first?.geo?.layer === 'satellite' ? 'satellite' : 'street'
  satBox.checked = layer === 'satellite'
}
editBtn.hidden = linksBtn.hidden = !isAdmin
applyView(false)
renderSites()
renderSide()
{
  // arrive already looking at the chosen site (or every site): no flight on opening the page
  const land = () => {
    const { w, h } = view.size()
    if (!w || !h) return requestAnimationFrame(land)
    const to = siteTarget(site) ?? siteTarget('')
    if (to) Object.assign(view, to)
    view.requestRender()
  }
  land()
}

// camera colours every 30 s: the roster for names and new cameras, the health poll for the states
setInterval(async () => {
  try {
    setCameras(await api('GET', '/api/cameras'))
  } catch {}
  await loadStates()
  stale() // the badges carry the states
  view.requestRender()
  renderSites({ reveal: false }) // a refresh must not pull the row back from where it was scrolled to
  if (!editing) renderSide()
}, 30_000)
