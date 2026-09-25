// Camera map: where each camera is and what it covers, per site, on an uploaded site
// plan or a street/satellite map. Click a camera for live video; admins place and aim them.
//
// Map engine: world coordinates are image pixels for a plan, or Web Mercator units
// (the whole world is 256 wide, like one zoom-0 tile) for street/satellite maps.
// screen = (world - centre) * 2^zoom + half the viewport.
import { LiveTile, SUB_STREAM, TILE_HTML } from './live-tile.js'

const $ = (id) => document.getElementById(id)
const TILE = 256
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
const MAX_LAT = 85
const MAX_RANGE = { geo: 5000, plan: 20_000 }

// Web Mercator
const lngToX = (lng) => ((lng + 180) / 360) * TILE
const latToY = (lat) => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE
}
const xToLng = (x) => (x / TILE) * 360 - 180
const yToLat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / TILE))) * 180) / Math.PI
/** Metres per world unit at a latitude. */
const metresPerUnit = (lat) => 156543.03392 * Math.cos((lat * Math.PI) / 180)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

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
const siteSelect = $('site')
const namesBox = $('names')
const editBtn = $('edit')
const side = $('side')
const emptyEl = $('empty')
const liveEl = $('live')

let isAdmin = false
let cameras = [] // /api/cameras: { nvr, site, nvrName, ch, name, online }
let maps = { sites: {} } // /api/maps
let site = ''
let editing = false
let draft = null // the site's map being edited
let dirty = false
let selected = null // camera key
let placing = null // camera key waiting for a click on the map
let popup = null // { key, tile }

const camKey = (c) => `${c.nvr}/${c.ch}`
const enc = encodeURIComponent
const siteCams = () => cameras.filter((c) => c.site === site).sort((a, b) => a.nvrName.localeCompare(b.nvrName) || a.ch - b.ch)
const camByKey = (key) => cameras.find((c) => camKey(c) === key)
const camLabel = (cam, key) => (cam ? `${cam.ch + 1} · ${cam.name}` : `Unknown camera (${key})`)
/** The map shown: the draft while editing. */
const current = () => (editing ? draft : maps.sites[site]) ?? null
/** Camera placements of a map in its current mode. */
const placed = (m = current()) => (m?.[m.mode]?.cams ?? {})

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('aria-') || k.startsWith('data-')) node.setAttribute(k, v)
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

/** World position (and range in world units) of a placement. */
function camWorld(m, c) {
  if (m.mode === 'geo') return { x: lngToX(c.lng), y: latToY(c.lat), r: c.range / metresPerUnit(c.lat) }
  return { x: c.x, y: c.y, r: c.range }
}

function setPos(m, c, wx, wy) {
  if (m.mode === 'geo') {
    c.lat = clamp(yToLat(clamp(wy, 0, TILE)), -MAX_LAT, MAX_LAT)
    c.lng = clamp(xToLng(wx), -180, 180)
  } else {
    c.x = Math.round(clamp(wx, 0, m.plan.w))
    c.y = Math.round(clamp(wy, 0, m.plan.h))
  }
}

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

view.onDraw = () => {
  const m = current()
  const cones = svgEl('g')
  const marks = svgEl('g')
  if (m && view.mode) {
    const showNames = namesBox.checked
    for (const [key, c] of Object.entries(placed(m))) {
      const cam = camByKey(key)
      if (!cam && !editing) continue // its NVR was removed: kept in the data, not shown
      const w = camWorld(m, c)
      const p = view.toScreen(w.x, w.y)
      const r = Math.max(6, w.r * view.scale)
      const cls = `${cam?.online ? '' : ' off'}${key === selected || key === popup?.key ? ' sel' : ''}`
      cones.append(svgEl('path', { d: conePath(p, c.dir, c.fov, r), class: `cone${cls}` }))
      const g = svgEl('g', { class: `cam${cls}`, 'data-key': key, transform: `translate(${p[0].toFixed(1)} ${p[1].toFixed(1)})` })
      const title = svgEl('title')
      title.textContent = `${camLabel(cam, key)}${cam && !cam.online ? ' (offline)' : ''}`
      const num = svgEl('text', { class: 'cam-num' })
      num.textContent = cam ? String(cam.ch + 1) : '?'
      g.append(title, svgEl('circle', { r: 12, class: 'cam-dot' }), num)
      if (showNames && cam) {
        const name = svgEl('text', { x: 17, class: 'cam-name' })
        name.textContent = cam.name
        g.append(name)
      }
      marks.append(g)
      if (editing && key === selected) {
        const tip = polar(p, c.dir, r)
        marks.append(svgEl('circle', { cx: tip[0], cy: tip[1], r: 8, class: 'handle', 'data-handle': 'tip' }))
        if (c.fov < 359.5) {
          const edge = polar(p, c.dir + c.fov / 2, r)
          marks.append(svgEl('circle', { cx: edge[0], cy: edge[1], r: 6, class: 'handle edge', 'data-handle': 'edge' }))
        }
      }
    }
  }
  view.svg.replaceChildren(cones, marks)
}

// ---- interaction ----

view.hitTest = (e, start) => {
  if (!editing || placing) return null
  const handle = e.target.closest?.('[data-handle]')
  if (handle && selected && placed(draft)[selected]) return dragHandle(handle.dataset.handle)
  const mark = e.target.closest?.('.cam')
  if (mark) {
    select(mark.dataset.key)
    return dragCamera(mark.dataset.key, start)
  }
  return null
}

view.onClick = (p, target) => {
  if (placing) {
    placeAt(placing, p)
    return
  }
  const mark = target?.closest?.('.cam')
  if (mark) {
    if (editing) select(mark.dataset.key)
    else openLive(mark.dataset.key)
    return
  }
  if (editing) select(null)
}

function dragCamera(key, start) {
  const m = draft
  const c = placed(m)[key]
  const w = camWorld(m, c)
  const s = view.toScreen(w.x, w.y)
  const offset = { x: s[0] - start.x, y: s[1] - start.y } // keep the grab point under the pointer
  return {
    move: (q) => {
      const [wx, wy] = view.toWorld(q.x + offset.x, q.y + offset.y)
      setPos(m, c, wx, wy)
      changed()
      view.requestRender()
    },
    end: () => renderSide()
  }
}

function dragHandle(kind) {
  const m = draft
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
      changed()
      syncInputs()
      view.requestRender()
    },
    end: () => renderSide()
  }
}

function placeAt(key, p) {
  placing = null
  view.el.classList.remove('placing')
  const m = draft
  if (!m || !m[m.mode]) return
  const [wx, wy] = view.toWorld(p.x, p.y)
  const c = { dir: 0, fov: 90, range: m.mode === 'geo' ? 25 : Math.round(Math.min(m.plan.w, m.plan.h) * 0.12) }
  setPos(m, c, wx, wy)
  m[m.mode].cams ??= {}
  m[m.mode].cams[key] = c
  selected = key
  changed()
  renderSide()
  view.requestRender()
}

function select(key) {
  if (selected === key) return
  selected = key
  renderSide()
  view.requestRender()
}

function changed() {
  dirty = true
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
  liveEl.replaceChildren(
    el('div', { className: 'map-live-head' },
      el('span', { className: 'map-live-name', textContent: `${cam.ch + 1} · ${cam.name}` }),
      el('a', { href: `/playback.html?nvr=${enc(cam.nvr)}&ch=${cam.ch}`, textContent: 'Recordings' }),
      close),
    tile
  )
  liveEl.hidden = false
  popup = { key, tile: null }
  if (!cam.online) {
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

// ---- showing a site ----

function showEmpty(...content) {
  emptyEl.replaceChildren(...content)
  emptyEl.hidden = false
}

/** Sets up the background for the current map. keepView: don't move the view (same background). */
function applyView(keepView = false) {
  const m = current()
  emptyEl.hidden = true
  if (!m || (m.mode === 'plan' && !m.plan?.file)) {
    view.clear()
    if (editing) {
      showEmpty(
        el('p', { textContent: 'Upload a site plan (a floor plan, yard layout or aerial photo), or choose Street map or Satellite in the panel.' }),
        uploadButton()
      )
    } else {
      const create = isAdmin ? el('button', { type: 'button', className: 'st-primary', textContent: 'Create a map', onclick: startEdit }) : null
      showEmpty(el('p', { textContent: site ? `No map for ${site} yet.` : 'No cameras yet.' }), create)
    }
    return
  }
  if (m.mode === 'plan') view.setPlan(`/api/maps/plan/${m.plan.file}`, m.plan.w, m.plan.h, keepView)
  else view.setGeo(m.geo ?? DEFAULT_GEO, keepView)
  view.requestRender()
}

/** Zooms to every placed camera (street/satellite), or the whole plan. */
function fitAll() {
  const m = current()
  if (!m || !view.mode) return
  if (m.mode === 'plan') return view.fit()
  const pts = Object.values(placed(m)).map((c) => camWorld(m, c))
  if (pts.length === 0) return
  const pad = Math.max(...pts.map((p) => p.r))
  view.fit({
    x0: Math.min(...pts.map((p) => p.x)) - pad,
    y0: Math.min(...pts.map((p) => p.y)) - pad,
    x1: Math.max(...pts.map((p) => p.x)) + pad,
    y1: Math.max(...pts.map((p) => p.y)) + pad
  })
}

function centreOnCamera(key) {
  const m = current()
  const c = placed(m)[key]
  if (!c) return
  const w = camWorld(m, c)
  view.centreOn(w.x, w.y)
}

// ---- side panel ----

function renderSide() {
  statusEl = null
  side.replaceChildren(...(editing ? editPanel() : viewPanel()))
}

function camRow(cam, key, extra, opts = {}) {
  const dot = el('span', { className: `map-dot${cam?.online ? '' : ' off'}`, title: cam?.online ? 'online' : 'offline' })
  const li = el('li', { className: `${opts.placed ? 'placed' : 'unplaced'}${key === selected || key === popup?.key ? ' sel' : ''}` },
    dot, el('span', { className: 'map-cam-name', textContent: camLabel(cam, key) }), extra)
  return li
}

function viewPanel() {
  const m = current()
  const where = placed(m)
  const list = el('ul', { className: 'map-cams' })
  for (const cam of siteCams()) {
    const key = camKey(cam)
    if (where[key]) {
      const btn = el('button', { type: 'button', className: 'st-link', textContent: 'Show' })
      const li = camRow(cam, key, btn, { placed: true })
      const show = () => {
        centreOnCamera(key)
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
      list.append(camRow(cam, key, el('span', { className: 'map-note', textContent: 'not on map' })))
    }
  }
  const count = Object.keys(where).filter((k) => camByKey(k)?.site === site).length
  return [
    el('h2', { textContent: 'Cameras' }),
    el('p', { className: 'map-help', textContent: m ? `${count} of ${siteCams().length} on the map. Click a camera for live video.` : 'This site has no map yet.' }),
    list
  ]
}

function uploadButton() {
  const input = el('input', { type: 'file', accept: 'image/*', hidden: true })
  input.addEventListener('change', () => input.files[0] && uploadPlan(input.files[0]))
  const btn = el('button', { type: 'button', textContent: draft?.plan?.file ? 'Replace plan image…' : 'Upload plan image…' })
  btn.addEventListener('click', () => input.click())
  return el('span', {}, btn, input)
}

function editPanel() {
  const m = draft
  const bg = el('select', {},
    el('option', { value: 'plan', textContent: 'Site plan image' }),
    el('option', { value: 'street', textContent: 'Street map' }),
    el('option', { value: 'satellite', textContent: 'Satellite' }))
  bg.value = m.mode === 'geo' ? m.geo?.layer ?? 'street' : 'plan'
  bg.addEventListener('change', () => setBackground(bg.value))

  const bgSection = el('section', {}, el('h2', { textContent: 'Background' }), el('label', {}, 'Show cameras on', bg))
  if (m.mode === 'plan') {
    bgSection.append(uploadButton(), el('p', { className: 'map-help', textContent: 'A floor plan, yard layout or aerial photo (JPEG, PNG or WebP). Large images are scaled down to 4096 px.' }))
  } else {
    const find = el('input', { type: 'text', placeholder: '42.7070, -71.1631 or a Google Maps link' })
    const go = el('button', { type: 'button', textContent: 'Go' })
    const goTo = () => {
      const t = find.value
      // "lat, lng", or a Google Maps link with @lat,lng
      const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(t) ?? /(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/.exec(t)
      const lat = at && Number(at[1])
      const lng = at && Number(at[2])
      if (!at || Math.abs(lat) > MAX_LAT || Math.abs(lng) > 180) {
        find.setCustomValidity('Enter latitude, longitude')
        find.reportValidity()
        return
      }
      find.setCustomValidity('')
      view.setGeo({ layer: m.geo.layer, lat, lng, zoom: 18 })
      changed()
    }
    go.addEventListener('click', goTo)
    find.addEventListener('keydown', (e) => e.key === 'Enter' && goTo())
    bgSection.append(
      el('label', {}, 'Find the site', el('span', { className: 'map-find' }, find, go)),
      el('p', { className: 'map-help', textContent: 'Or pan and zoom to it. The view you leave is saved with the map.' })
    )
  }

  // cameras: this site's, plus placements whose camera no longer exists
  const where = placed(m)
  const list = el('ul', { className: 'map-cams' })
  const keys = new Set(siteCams().map(camKey))
  for (const k of Object.keys(where)) if (!keys.has(k) && !camByKey(k)) keys.add(k)
  for (const key of keys) {
    const cam = camByKey(key)
    if (where[key]) {
      const remove = el('button', { type: 'button', className: 'st-link st-danger', textContent: 'Remove' })
      remove.addEventListener('click', (e) => {
        e.stopPropagation()
        delete where[key]
        if (selected === key) selected = null
        changed()
        renderSide()
        view.requestRender()
      })
      const li = camRow(cam, key, remove, { placed: true })
      li.addEventListener('click', () => {
        select(key)
        centreOnCamera(key)
      })
      list.append(li)
    } else if (cam) {
      const place = el('button', { type: 'button', className: 'st-link', textContent: placing === key ? 'Click the map…' : 'Place' })
      place.addEventListener('click', () => {
        placing = placing === key ? null : key
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
  const camSection = el('section', {},
    el('h2', { textContent: 'Cameras' }),
    el('p', { className: 'map-help', textContent: 'Drag a camera onto the map, or click Place and then click the map.' }),
    list)

  const parts = [bgSection, camSection]
  const c = selected && where[selected]
  if (c) parts.push(selectedPanel(m, c))

  statusEl = el('p', { className: 'map-help', role: 'status', textContent: dirty ? 'Unsaved changes' : '' })
  const save = el('button', { type: 'button', className: 'st-primary', textContent: 'Save' })
  save.addEventListener('click', saveMap)
  const cancel = el('button', { type: 'button', textContent: 'Cancel' })
  cancel.addEventListener('click', () => stopEdit())
  parts.push(el('div', { className: 'map-actions' }, save, cancel), statusEl)
  return parts
}

function selectedPanel(m, c) {
  const cam = camByKey(selected)
  const slider = (label, key, min, max, unit) => {
    const input = el('input', { type: 'range', min, max, step: 1, value: Math.round(c[key]), 'data-field': key })
    const out = el('output', { textContent: `${Math.round(c[key])}${unit}`, 'data-out': key })
    input.addEventListener('input', () => {
      c[key] = Number(input.value)
      out.textContent = `${input.value}${unit}`
      changed()
      view.requestRender()
    })
    return el('label', {}, el('span', { className: 'map-field' }, label, out), input)
  }
  const range = el('input', { type: 'number', min: 1, max: MAX_RANGE[m.mode], step: 1, value: Math.round(c.range), 'data-field': 'range' })
  range.addEventListener('input', () => {
    const v = Number(range.value)
    if (v >= 1 && v <= MAX_RANGE[m.mode]) {
      c.range = v
      changed()
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
  const c = selected && placed(draft)[selected]
  if (!c) return
  for (const input of side.querySelectorAll('[data-field]')) input.value = String(Math.round(c[input.dataset.field]))
  for (const out of side.querySelectorAll('[data-out]')) out.textContent = `${Math.round(c[out.dataset.out])}°`
}

// ---- editing ----

function startEdit() {
  closeLive()
  draft = structuredClone(maps.sites[site] ?? { mode: 'plan' })
  editing = true
  dirty = false
  selected = null
  placing = null
  editBtn.hidden = true
  siteSelect.disabled = true
  applyView(true)
  renderSide()
}

function stopEdit(force = false) {
  if (!force && dirty && !confirm('Discard the changes to this map?')) return
  editing = false
  draft = null
  dirty = false
  selected = null
  placing = null
  view.el.classList.remove('placing')
  editBtn.hidden = !isAdmin
  siteSelect.disabled = false
  applyView(true)
  renderSide()
}

function setBackground(value) {
  const m = draft
  selected = null
  placing = null
  if (value === 'plan') {
    m.mode = 'plan'
  } else {
    const wasGeo = m.mode === 'geo'
    m.mode = 'geo'
    m.geo ??= { ...DEFAULT_GEO, cams: {} }
    if (wasGeo) Object.assign(m.geo, view.geoView()) // switching street <-> satellite: stay where we are
    m.geo.layer = value
  }
  changed()
  applyView(false)
  renderSide()
}

async function uploadPlan(file) {
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
    const saved = await api('POST', `/api/admin/maps/${enc(site)}/plan`, { data, w, h })
    // the server kept its saved cameras in place on the new image; do the same for unsaved ones
    const old = draft.plan
    const cams = {}
    if (old?.cams && old.w && old.h) {
      const sx = w / old.w
      const sy = h / old.h
      for (const [key, c] of Object.entries(old.cams)) cams[key] = { ...c, x: Math.round(c.x * sx), y: Math.round(c.y * sy), range: Math.round(c.range * Math.sqrt(sx * sy)) }
    }
    maps.sites[site] = saved
    draft.plan = { ...saved.plan, cams }
    draft.mode = 'plan'
    applyView(false)
    renderSide()
    changed()
    setStatus('Plan uploaded. Place the cameras, then Save.')
  } catch (e) {
    setStatus(`Upload failed: ${e.message}`)
  }
}

async function saveMap() {
  const m = draft
  if (m.mode === 'plan' && !m.plan?.file) return setStatus('Upload a site plan first, or choose Street map or Satellite.')
  if (m.mode === 'geo') Object.assign(m.geo, view.geoView())
  try {
    setStatus('Saving…')
    const body = { mode: m.mode, plan: m.plan ? { cams: m.plan.cams ?? {} } : undefined, geo: m.geo }
    maps.sites[site] = await api('PUT', `/api/admin/maps/${enc(site)}`, body)
    stopEdit(true)
  } catch (e) {
    setStatus(`Could not save: ${e.message}`)
  }
}

addEventListener('beforeunload', (e) => {
  if (editing && dirty) e.preventDefault()
})

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea')) return
  if (e.key === 'Escape') {
    if (placing) {
      placing = null
      view.el.classList.remove('placing')
      renderSide()
    } else if (popup) {
      closeLive()
    } else if (editing && selected) {
      select(null)
    }
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && editing && selected && placed(draft)[selected]) {
    delete placed(draft)[selected]
    selected = null
    changed()
    renderSide()
    view.requestRender()
  }
  if (e.key === '+' || e.key === '=') view.zoomBy(0.5)
  if (e.key === '-') view.zoomBy(-0.5)
})

$('zoomIn').addEventListener('click', () => view.zoomBy(1))
$('zoomOut').addEventListener('click', () => view.zoomBy(-1))
$('fit').addEventListener('click', fitAll)
editBtn.addEventListener('click', startEdit)

try {
  namesBox.checked = localStorage.getItem('cctv.mapNames') !== '0'
} catch {}
namesBox.addEventListener('change', () => {
  try { localStorage.setItem('cctv.mapNames', namesBox.checked ? '1' : '0') } catch {}
  view.requestRender()
})

siteSelect.addEventListener('change', () => {
  site = siteSelect.value
  try { localStorage.setItem('cctv.mapSite', site) } catch {}
  closeLive()
  applyView(false)
  renderSide()
  fitAll()
})

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' })
  location.href = '/login.html'
})

// ---- start ----

const me = await checkSession()
if (me) $('whoami').textContent = me.user
isAdmin = Boolean(me?.admin)
if (isAdmin) $('sitesTab').hidden = $('settingsTab').hidden = false
setInterval(checkSession, 60_000)

;[cameras, maps] = await Promise.all([api('GET', '/api/cameras'), api('GET', '/api/maps')])
const siteNames = [...new Set(cameras.map((c) => c.site))].sort()
siteSelect.replaceChildren(...siteNames.map((n) => new Option(n, n)))
{
  let saved = ''
  try { saved = localStorage.getItem('cctv.mapSite') || localStorage.getItem('cctv.site') || '' } catch {}
  site = siteNames.includes(saved) ? saved : siteNames[0] ?? ''
  siteSelect.value = site
}
editBtn.hidden = !isAdmin || !site
applyView(false)
renderSide()
requestAnimationFrame(fitAll)

// camera status (online/offline colours) every 30 s
setInterval(async () => {
  try {
    cameras = await api('GET', '/api/cameras')
    view.requestRender()
    if (!editing) renderSide()
  } catch {}
}, 30_000)
