// Camera grid: each tile streams one camera over WebSocket into a VideoPlayer.
import { diffCameras, shownCameras, visibleCameras } from './grid-diff.js'
import { enableGridDrag } from './grid-drag.js'
import { applyOrder, createOrderSync, moveOp, reuseSlots, swapOp } from './grid-order.js'
import { ImagePanel } from './image-panel.js'
import { LiveTile, MAIN_STREAM, SUB_STREAM, TILE_HTML } from './live-tile.js'
// ?pacing=off draws frames as soon as they decode (for before/after comparison)
const PACING = new URLSearchParams(location.search).get('pacing') !== 'off'

const grid = document.getElementById('grid')
const layoutSelect = document.getElementById('layout')
const pageLabel = document.getElementById('page')
const prevBtn = document.getElementById('prev')
const nextBtn = document.getElementById('next')
const notice = document.getElementById('notice')
const siteSelect = document.getElementById('site')
const hideOffline = document.getElementById('hideOffline')
const smoothBox = document.getElementById('smooth')
const fullBtn = document.getElementById('fullscreen')
const resetBtn = document.getElementById('resetOrder')
const orderNoteEl = document.getElementById('orderNote')
// "Smooth": a bigger playout buffer absorbs uneven delivery (more delay, steadier motion)
const SMOOTH_CLOCK = { startDelayMs: 400, minDelayMs: 300, maxDelayMs: 1200 }
const clockOptions = () => (smoothBox.checked ? SMOOTH_CLOCK : undefined)
// cameras whose main stream this browser can't play: full screen stays on the sub stream
const noMain = new Set()
try {
  for (const k of JSON.parse(sessionStorage.getItem('cctv.noMain') ?? '[]')) noMain.add(k)
} catch {}
const rememberNoMain = (key) => {
  noMain.add(key)
  try { sessionStorage.setItem('cctv.noMain', JSON.stringify([...noMain])) } catch {}
}

let cameras = [] // every camera on every NVR, in this user's order: { nvr, site, nvrName, ch, name, online }
let serverList = [] // the same, as the server sends them (the default order: site, NVR, channel)
let user = null
let page = 0
let single = null // key (nvr/ch) of the camera shown full-size, or null for the grid
const camKey = (cam) => `${cam.nvr}/${cam.ch}`
let tiles = []
let showStats = false
let isAdmin = false

// picture settings of the camera shown full-size (admins); measures the stream on screen
let singleCam = null // the camera shown full-size
/** The player on screen in the full-size view: { player, stream: 'main' | 'sub', remote }, or null. */
const shownPlayer = () => {
  const t = [...singleTiles].reverse().find((x) => !x.closed && x.player.videoWidth && !x.tile.classList.contains('pending'))
  return t ? { player: t.player, stream: t.streamType === MAIN_STREAM ? 'main' : 'sub', remote: Boolean(singleCam?.remote) } : null
}
/** Waits (up to ms) for the main stream to replace the sub stream on screen; the player shown then. */
const waitForMain = async (ms) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const v = shownPlayer()
    // P2P/VPN cameras and browsers without H.265 stay on the sub stream: no point waiting
    if (v?.stream === 'main' || !singleCam || singleCam.remote || noMain.has(camKey(singleCam))) return v
    await new Promise((r) => setTimeout(r, 200))
  }
  return shownPlayer()
}
const imagePanel = new ImagePanel({
  getPlayer: shownPlayer,
  waitForMain,
  onClose: () => {
    for (const b of grid.querySelectorAll('button.pic-toggle')) b.setAttribute('aria-expanded', 'false')
  }
})

if (!('VideoDecoder' in window)) {
  notice.hidden = false
  notice.textContent = window.isSecureContext
    ? 'This browser cannot decode video (no WebCodecs). Use a current Chrome, Edge or Safari.'
    : 'Video needs a secure connection. Open this page with https:// (port 8443) instead.'
}

// for diagnostics from the console: stats of every visible tile
window.cctvStats = () => tiles.map((t) => ({ nvr: t.nvr, ch: t.ch + 1, stream: t.streamType, ...t.player.stats }))

// Layouts: a grid size plus the large tiles (column, row, width, height; 1-based).
// Remaining cells are filled with single tiles in reading order.
const LAYOUTS = {
  g1: { size: 1 },
  g2: { size: 2 },
  g3: { size: 3 },
  g4: { size: 4 },
  g5: { size: 5 },
  g6: { size: 6 },
  g8: { size: 8 },
  '1+5': { size: 3, big: [[1, 1, 2, 2]] },
  '1+7': { size: 4, big: [[1, 1, 3, 3]] },
  '1+12': { size: 4, big: [[2, 2, 2, 2]] },
  '2+8': { size: 4, big: [[1, 1, 2, 2], [3, 1, 2, 2]] }
}

/** Cells of a layout as [column, row, width, height], large tiles first. */
function layoutCells(id) {
  const { size, big = [] } = LAYOUTS[id] ?? LAYOUTS.g3
  const used = new Set()
  for (const [c, r, w, h] of big) for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) used.add(`${x},${y}`)
  const cells = [...big]
  for (let y = 1; y <= size; y++) for (let x = 1; x <= size; x++) if (!used.has(`${x},${y}`)) cells.push([x, y, 1, 1])
  return { size, cells }
}

function tileLabel(cam) {
  // with several sites, say where the camera is
  const where = cam && multiSite() && !siteSelect.value ? `${cam.site} · ` : ''
  return cam ? `${where}${cam.ch + 1} · ${cam.name}` : ''
}

function makeTile(cam) {
  const tile = document.createElement('div')
  tile.className = 'tile'
  tile.innerHTML = TILE_HTML
  tile.querySelector('.name').textContent = tileLabel(cam)
  return tile
}

let gridTiles = [] // LiveTiles of the grid
let gridSlots = [] // one per grid cell: { cam, el, live: LiveTile | null }
let gridStale = false // the camera list changed while the tab was hidden
let singleTiles = [] // LiveTiles of the full-size view (sub, then main)
let overlay = null // the full-size tile, laid over the (suspended) grid

const syncTiles = () => {
  tiles = [...gridTiles, ...singleTiles]
}

/**
 * Builds the grid for the current layout, page and filters (and the full-size view on top, if
 * open). keepSingle: the full-size view is left as it is (its players keep running, so a
 * measurement in the Picture panel goes on), e.g. when only the camera list was refreshed.
 */
function render({ keepSingle = false } = {}) {
  drag.cancel() // a tile being dragged is about to go
  const keep = keepSingle && single !== null && overlay !== null && singleTiles.some((t) => !t.closed)
  for (const t of keep ? gridTiles : [...gridTiles, ...singleTiles]) t.close()
  gridTiles = []
  if (!keep) {
    singleTiles = []
    overlay = null
  }
  grid.classList.toggle('show-stats', showStats)
  // the kept view and its panel stay in place (moving them would close an open dialog)
  const kept = keep ? [overlay, imagePanel.el].filter((n) => n.parentNode === grid) : []
  for (const n of [...grid.children]) if (!kept.includes(n)) n.remove()
  const before = kept[0] ?? null

  const { size, cells } = layoutCells(layoutSelect.value)
  const perPage = cells.length
  grid.style.gridTemplateColumns = `repeat(${size}, 1fr)`
  grid.style.gridTemplateRows = `repeat(${size}, 1fr)`
  grid.dataset.size = String(size)

  gridStale = false
  const v = visibleCameras(cameras, gridView(perPage))
  page = v.page
  const pages = v.pages
  const visible = v.visible

  gridSlots = []
  for (let i = 0; i < perPage; i++) {
    const cam = visible[i]
    const slot = { cam, el: null, live: null }
    gridSlots.push(slot)
    fillSlot(slot, gridArea(cells[i]), gridTiles.length * 60)
    grid.insertBefore(slot.el, before)
  }
  syncTiles()
  updatePager(pages)
  syncSingle(keep)
}

/** A layout cell [column, row, width, height] as a CSS grid-area. */
const gridArea = ([c, r, w, h]) => `${r} / ${c} / span ${h} / span ${w}`

/** The grid's filters and page, for visibleCameras / diffCameras. */
function gridView(perPage = layoutCells(layoutSelect.value).cells.length) {
  return { site: siteSelect.value, hideOffline: hideOffline.checked, perPage, page }
}

/** A new tile element for slot.cam (offline tile, or a LiveTile started after startDelayMs). */
function fillSlot(slot, gridArea, startDelayMs = 0) {
  const { cam } = slot
  const tile = makeTile(cam)
  tile.style.gridArea = gridArea
  slot.el = tile
  slot.live = null
  if (!cam) return
  if (!cam.online) {
    tile.classList.add('offline')
    tile.querySelector('.status').textContent = 'offline'
    return
  }
  slot.live = new LiveTile(tile, cam, SUB_STREAM, startDelayMs, tileOptions())
  gridTiles.push(slot.live)
  tile.addEventListener('click', () => openSingle(slot.cam))
}

/**
 * A camera-list refresh where the page shows the same cameras in the same order: only the
 * tiles whose camera changed are touched (went offline: its stream closes and the offline
 * tile shows; came back: a stream starts for that tile; renamed: the label). The other
 * pictures keep playing.
 */
function updateTiles(changed) {
  for (const { index, cam, online, name } of changed) {
    const slot = gridSlots[index]
    if (!slot) continue
    slot.cam = cam
    if (online) {
      if (slot.live) {
        slot.live.close()
        gridTiles = gridTiles.filter((t) => t !== slot.live)
      }
      const old = slot.el
      fillSlot(slot, old.style.gridArea)
      old.replaceWith(slot.el)
      // under an open full-size view the grid decodes nothing
      if (single !== null) slot.live?.suspend()
    } else if (name) {
      slot.el.querySelector('.name').textContent = tileLabel(cam)
    }
  }
  syncTiles()
  const keep = single !== null && overlay !== null && singleTiles.some((t) => !t.closed)
  syncSingle(keep)
}

/** The full-size view after a grid rebuild or a camera-list refresh. */
function syncSingle(keep) {
  // the full-size view survives a rebuild (camera list refresh, Smooth, etc.)
  if (single !== null) {
    const cam = cameras.find((c) => camKey(c) === single)
    const panelOpen = imagePanel.key === single
    if (!cam || (!cam.online && !panelOpen)) {
      // the camera went away (removed; or offline with no picture panel open): the view goes
      closeSingle()
      return
    }
    // offline with the panel open: most likely a camera restart the panel asked for; the view
    // and panel stay (its tiles reconnect by themselves), so the change's result is shown
    if (keep) {
      for (const t of gridTiles) t.suspend()
      singleCam = cam
    } else openSingle(cam)
    offlineNote(!cam.online)
  }
}

/** "Camera offline (restarting?)" on the full-size view while the camera is reported offline. */
function offlineNote(on) {
  if (!overlay) return
  let note = overlay.querySelector(':scope > .single-offline')
  if (!on) return note?.remove()
  if (!note) {
    note = document.createElement('div')
    note.className = 'single-offline'
    note.setAttribute('role', 'status')
    note.textContent = 'Camera offline (restarting?): the picture comes back by itself when it is.'
    overlay.append(note)
  }
}

const tileOptions = () => ({ pacing: PACING, clock: clockOptions(), statsVisible: () => showStats, onDisconnect: checkSession })

function updatePager(pages = Number(pageLabel.dataset.pages ?? 1)) {
  pageLabel.dataset.pages = String(pages)
  pageLabel.textContent = single !== null ? 'full' : `${page + 1} / ${pages}`
  prevBtn.disabled = single !== null || page === 0
  nextBtn.disabled = single !== null || page >= pages - 1
}

/**
 * Full-size view of one camera, laid over the grid. The grid keeps its connections and last
 * pictures but decodes nothing meanwhile, so coming back is instant. The view starts on the
 * sub stream (already running, so it shows at once) and upgrades to the main stream when its
 * first frame is on screen; if this browser can't play the main stream, the sub stream stays.
 */
function openSingle(cam) {
  closeSingle({ resumeGrid: false })
  single = camKey(cam)
  singleCam = cam
  for (const t of gridTiles) t.suspend()
  overlay = makeTile(cam)
  overlay.classList.add('single', 'single-overlay')
  // links sit next to the name (not in it): a long name is cut short, the links never are
  const links = document.createElement('span')
  links.className = 'links'
  const link = document.createElement('a')
  link.className = 'pb-link'
  link.href = `/playback.html?nvr=${encodeURIComponent(cam.nvr)}&ch=${cam.ch}`
  link.textContent = 'Recordings'
  link.addEventListener('click', (e) => e.stopPropagation())
  links.append(link)
  if (isAdmin) {
    const pic = document.createElement('button')
    pic.type = 'button'
    pic.className = 'pb-link pic-toggle'
    pic.textContent = 'Picture'
    pic.title = 'Camera picture settings and Auto adjust'
    pic.setAttribute('aria-expanded', String(imagePanel.key === single))
    pic.addEventListener('click', (e) => {
      e.stopPropagation()
      if (imagePanel.key === single) {
        imagePanel.requestClose()
        return
      }
      imagePanel.open(cam, { opener: pic })
      pic.setAttribute('aria-expanded', 'true')
      grid.append(imagePanel.el)
    })
    links.append(pic)
  }
  overlay.querySelector('.name').after(links)
  // closing the view discards the panel's unsent changes: ask first
  overlay.addEventListener('click', () => {
    if (imagePanel.confirmDiscard()) closeSingle()
  })
  grid.append(overlay)
  // open for this camera: keep it (and its unsent changes) across a rebuild of the view
  if (imagePanel.key === single) grid.append(imagePanel.el)
  else imagePanel.close()
  const opts = tileOptions()
  const sub = new LiveTile(overlay, cam, SUB_STREAM, 0, opts)
  singleTiles.push(sub)
  // cameras reached through TVT P2P stay on the sub stream (the relay has little bandwidth)
  if (!noMain.has(single) && !cam.remote) upgradeToMain(overlay, cam, sub, opts)
  syncTiles()
  updatePager()
}

/** Back to the grid: the grid tiles pick up again straight away. */
function closeSingle({ resumeGrid = true } = {}) {
  for (const t of singleTiles) t.close()
  singleTiles = []
  overlay?.remove()
  overlay = null
  if (!resumeGrid) return
  imagePanel.close()
  single = null
  singleCam = null
  for (const t of gridTiles) t.resume()
  syncTiles()
  updatePager()
}

function upgradeToMain(tile, cam, sub, opts) {
  const layer = document.createElement('div')
  // full size but invisible until its first frame (a hidden element would give the canvas no size)
  layer.className = 'tile-upgrade pending'
  layer.innerHTML = TILE_HTML
  layer.querySelector('.name').textContent = tile.querySelector('.name').firstChild?.textContent ?? ''
  tile.append(layer)
  const main = new LiveTile(layer, cam, MAIN_STREAM, 0, {
    ...opts,
    onFirstFrame: () => {
      layer.classList.remove('pending')
      const links = tile.querySelector(':scope > .label .links')
      if (links) layer.querySelector('.name').after(links)
      sub.close()
    },
    onUnsupported: () => {
      rememberNoMain(camKey(cam))
      main.close()
      layer.remove()
    }
  })
  singleTiles.push(main)
}

// ---- this user's camera order ------------------------------------------------------------------
// Drag a tile onto another: they swap places. Onto a pager arrow: first place of the page before
// or after. Saved on the server for this user (half a second after the last change); a copy stays
// in this browser, which is sent again if the server did not get it. The same user's other
// screens pick the change up with their next refresh; changes made on two screens at once are
// both kept (the server refuses a save made on an old version, and it is done again on the
// newer one). See grid-order.js.
const GRID_ORDER_URL = '/api/me/grid-order'
const store = (() => {
  try {
    return localStorage
  } catch {
    return null
  }
})()

/** GET or PUT /api/me/grid-order: { status, body } (throws when there is no answer in time). */
async function orderRequest(method, body) {
  const json = body === undefined ? undefined : JSON.stringify(body)
  const res = await fetch(GRID_ORDER_URL, {
    method,
    cache: 'no-store',
    headers: json === undefined ? undefined : { 'content-type': 'application/json' },
    body: json,
    // a change made just before the page closes still arrives (small bodies only)
    keepalive: json !== undefined && json.length < 60_000,
    signal: AbortSignal.timeout?.(json === undefined ? 5_000 : 15_000)
  })
  if (res.status === 401) checkSession()
  return { status: res.status, body: await res.json().catch(() => null) }
}

const sync = createOrderSync({
  request: orderRequest,
  cameras: () => serverList,
  storage: store,
  user: () => user,
  onChange: showOrder,
  onSaved: () => orderNote(''),
  onFailed: () => orderNote('Camera order not saved on the server (kept in this browser). It is sent again shortly.')
})
addEventListener('pagehide', () => sync.flush())

/** A small note that goes by itself (never in the way); '' hides it. */
let orderNoteTimer
function orderNote(text) {
  clearTimeout(orderNoteTimer)
  orderNoteEl.textContent = text
  orderNoteEl.hidden = !text
  if (text) orderNoteTimer = setTimeout(() => (orderNoteEl.hidden = true), 10_000)
}

/**
 * A new order (a change here, or one from another screen): the grid shows it at once, its tiles
 * moved and playing on. While the tab is hidden (no video) the grid is rebuilt when it shows again.
 */
function showOrder() {
  cameras = applyOrder(serverList, sync.order)
  resetBtn.hidden = sync.order.length === 0
  if (document.hidden) {
    gridStale = true
    return
  }
  drag.cancel() // (an order from another screen can come mid-drag: the tiles are about to move)
  relayout()
}

/**
 * The grid after a change of order, without a rebuild: tiles whose camera stays on the page move
 * to their new cell and keep playing; only a camera that left the page closes, only one that
 * came onto it opens.
 */
function relayout() {
  const { cells } = layoutCells(layoutSelect.value)
  const perPage = cells.length
  const v = visibleCameras(cameras, gridView(perPage))
  if (gridSlots.length !== perPage || v.page !== page) return render({ keepSingle: true })
  const before = [overlay, imagePanel.el].find((n) => n?.parentNode === grid) ?? null
  const keys = cells.map((_, i) => (v.visible[i] ? camKey(v.visible[i]) : null))
  const { from, unused } = reuseSlots(gridSlots.map((s) => (s.cam ? camKey(s.cam) : null)), keys)
  const leaving = unused.map((i) => gridSlots[i])
  for (const s of leaving) {
    s.live?.close()
    s.el.remove()
  }
  gridTiles = gridTiles.filter((t) => !leaving.some((s) => s.live === t))
  gridSlots = cells.map((cell, i) => {
    if (from[i] >= 0) {
      const s = gridSlots[from[i]]
      s.cam = v.visible[i]
      s.el.style.gridArea = gridArea(cell)
      return s
    }
    const s = { cam: v.visible[i], el: null, live: null }
    fillSlot(s, gridArea(cell))
    grid.insertBefore(s.el, before)
    // under an open full-size view the grid decodes nothing
    if (single !== null) s.live?.suspend()
    return s
  })
  syncTiles()
  updatePager(v.pages)
}

/** A tile dropped onto another tile (they swap places) or onto a pager arrow (first place of that page). */
function dropTile(dragged, target) {
  const cam = gridSlots.find((s) => s.el === dragged)?.cam
  // (gone meanwhile: the grid was rebuilt by a camera-list refresh)
  if (!cam || single !== null) return
  if (target === prevBtn || target === nextBtn) {
    const perPage = layoutCells(layoutSelect.value).cells.length
    sync.change(moveOp(camKey(cam), page + (target === nextBtn ? 1 : -1), perPage, shownCameras(cameras, gridView(perPage))))
    return
  }
  const other = gridSlots.find((s) => s.el === target)?.cam
  if (other) sync.change(swapOp(sync.order, camKey(cam), camKey(other), serverList))
}

const drag = enableGridDrag(grid, {
  // the grid's tiles with a camera (offline ones too), not while the full-size view is open
  tileOf: (el) => (single === null ? (gridSlots.find((s) => s.cam && s.el.contains(el))?.el ?? null) : null),
  // another camera's tile, or a pager arrow that can be used
  targetOf: (el, dragged) => {
    const arrow = el.closest?.('#prev, #next')
    if (arrow) return arrow.disabled ? null : arrow
    return gridSlots.find((s) => s.cam && s.el !== dragged && s.el.contains(el))?.el ?? null
  },
  onDrop: dropTile
})

resetBtn.addEventListener('click', () => {
  if (confirm('Put the cameras back in the default order (by site, NVR and channel)?')) sync.change({ op: 'reset' })
})

// browser full screen for the camera grid (monitors, video walls); Esc or F leaves it
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  else grid.requestFullscreen?.().catch(() => {})
}
fullBtn.addEventListener('click', toggleFullscreen)
document.addEventListener('fullscreenchange', () => {
  const on = Boolean(document.fullscreenElement)
  fullBtn.setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen')
  fullBtn.title = on ? 'Leave full screen (F or Esc)' : 'Full screen (F)'
})
if (!document.fullscreenEnabled) fullBtn.hidden = true

try {
  smoothBox.checked = localStorage.getItem('cctv.smooth') === '1'
} catch {}
smoothBox.addEventListener('change', () => {
  try { localStorage.setItem('cctv.smooth', smoothBox.checked ? '1' : '0') } catch {}
  render()
})

try {
  const saved = localStorage.getItem('cctv.layout')
  if (saved && LAYOUTS[saved]) layoutSelect.value = saved
} catch {}
layoutSelect.addEventListener('change', () => {
  page = 0
  try { localStorage.setItem('cctv.layout', layoutSelect.value) } catch {}
  render({ keepSingle: true })
})
try {
  hideOffline.checked = localStorage.getItem('cctv.hideOffline') !== '0'
} catch {}
hideOffline.addEventListener('change', () => {
  page = 0
  try { localStorage.setItem('cctv.hideOffline', hideOffline.checked ? '1' : '0') } catch {}
  render({ keepSingle: true })
})
siteSelect.addEventListener('change', () => {
  page = 0
  try { localStorage.setItem('cctv.site', siteSelect.value) } catch {}
  render({ keepSingle: true })
})
prevBtn.addEventListener('click', () => { page--; render() })
nextBtn.addEventListener('click', () => { page++; render() })
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && single !== null && !document.fullscreenElement && imagePanel.confirmDiscard()) closeSingle()
  if ((e.key === 'f' || e.key === 'F') && !e.target.closest?.('input, select, textarea')) toggleFullscreen()
  if (e.key === 'd' || e.key === 'D') {
    showStats = !showStats
    grid.classList.toggle('show-stats', showStats)
  }
})

// no video while the tab is hidden: saves CPU, GPU and NVR bandwidth
let hiddenTimer
document.addEventListener('visibilitychange', () => {
  clearTimeout(hiddenTimer)
  if (document.hidden) {
    hiddenTimer = setTimeout(() => {
      for (const t of tiles) t.close()
      tiles = []
    }, 3000)
    return
  }
  // the camera order may have been changed on another screen meanwhile
  sync.refresh()
  if (tiles.length === 0) render()
  else if (gridStale) render({ keepSingle: true })
})

/** Sends the browser to the sign-in page if the session has expired or been revoked. */
async function checkSession() {
  const res = await fetch('/api/me').catch(() => null)
  if (res?.status === 401) location.href = '/login.html'
  return res?.ok ? res.json() : null
}

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' })
  location.href = '/login.html'
})

const me = await checkSession()
if (me) document.getElementById('whoami').textContent = me.user
if (me?.admin) document.getElementById('sitesTab').hidden = document.getElementById('settingsTab').hidden = false
isAdmin = Boolean(me?.admin)
user = me?.user ?? null
setInterval(checkSession, 60_000)

function multiSite() {
  return new Set(cameras.map((c) => c.site)).size > 1
}

/** Loads cameras from every NVR; keeps the grid as is unless the list changed. */
async function loadCameras() {
  const [fresh, sites] = await Promise.all([
    fetch('/api/cameras').then((r) => r.json()),
    fetch('/api/sites').then((r) => r.json())
  ])
  serverList = fresh
  const list = applyOrder(fresh, sync.order) // this user's order (the grid, the diff and the pages all use it)
  resetBtn.hidden = sync.order.length === 0
  const changed = JSON.stringify(list) !== JSON.stringify(cameras)
  const before = cameras
  const beforeView = gridView() // (the site list below can reset the site filter)
  cameras = list

  // site filter, shown only when there is more than one site
  const names = [...new Set(sites.map((s) => s.site))].sort()
  document.getElementById('siteLabel').hidden = names.length < 2
  const current = siteSelect.value || (() => { try { return localStorage.getItem('cctv.site') ?? '' } catch { return '' } })()
  siteSelect.replaceChildren(new Option('All sites', ''), ...names.map((n) => new Option(n, n)))
  siteSelect.value = names.includes(current) ? current : ''

  const down = sites.filter((s) => s.status !== 'online')
  notice.hidden = down.length === 0 && cameras.length > 0
  notice.textContent = cameras.length === 0 && down.length === 0
    ? 'No cameras yet. Add an NVR with: docker exec -it tvt-cctv node cctv/nvr.mjs add'
    : down.map((s) => `${s.site} · ${s.name} (${s.sn ? `serial ${s.sn}` : s.host}) is ${s.status}${s.error ? `: ${s.error}` : ''}`).join(' — ')
  // another camera coming or going must not rebuild the full-size view (a running measurement or
  // change in its Picture panel would be lost)
  if (!changed) return
  // the grid's tiles were closed while the tab is hidden: rebuilt when it shows again
  if (document.hidden) {
    gridStale = true
    return
  }
  // a camera going offline, coming back or renamed touches only its own tile; the grid is
  // rebuilt only when the page shows other cameras (or in another order) than before
  const view = gridView()
  const diff = gridSlots.length && view.site === beforeView.site ? diffCameras(before, list, view) : { full: true }
  if (diff.full) render({ keepSingle: true })
  else updateTiles(diff.changed)
}

await sync.load()
await loadCameras()
if (sync.unsaved) sync.refresh()
// the camera list, and this user's order (another screen may have changed it)
setInterval(() => {
  loadCameras().catch(() => {})
  sync.refresh()
}, 30_000)
