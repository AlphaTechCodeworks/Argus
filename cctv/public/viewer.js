// Camera grid: each tile streams one camera over WebSocket into a VideoPlayer.
import { isPhone, maxLiveFps } from './device.js'
import { attachZoom } from './pinch-zoom.js'
import { diffCameras, shownCameras, visibleCameras } from './grid-diff.js'
import { enableGridDrag } from './grid-drag.js'
import { activeTrace, downloadTrace, startTrace, stopTrace } from './frame-trace.js'
import { applyOrder, createOrderSync, moveOp, reuseSlots, swapOp } from './grid-order.js'
import { ImagePanel } from './image-panel.js'
import { LinesPanel } from './lines-panel.js'
import { muxState, useMux } from './live-mux.js'
import { LiveTile, MAIN_STREAM, SUB_STREAM, TILE_HTML } from './live-tile.js'
import { DEFAULT_OSD, clockOffsetFrom } from './osd-overlay.js'
// ?pacing=off draws frames as soon as they decode (for before/after comparison)
const PACING = new URLSearchParams(location.search).get('pacing') !== 'off'
// Every tile's stream on one connection (live-mux.js): the browser opens WebSockets one at a time,
// and an 8x8 grid of sockets took ~16 s through the public link. localStorage 'argus.liveMux' = '0'
// puts this browser back on a socket per tile.
let liveMuxOff = false
try { liveMuxOff = localStorage.getItem('argus.liveMux') === '0' } catch {}
if (!liveMuxOff) useMux(true)

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
// cameras whose main stream this browser could not play: full screen stays on the sub stream, for a
// while. Not for the whole session any more: the server now converts H.265 for phones and remote
// viewers, and a phone that once failed (before it did) was kept on the blurry sub-stream for good.
// A phone is never put on this list at all -- what it is sent is always H.264 it can play.
const NO_MAIN_MS = 2 * 60_000
const noMainUntil = new Map()
const noMain = { has: (key) => (noMainUntil.get(key) ?? 0) > Date.now() }
try { sessionStorage.removeItem('cctv.noMain') } catch {} // the old, session-long list
const rememberNoMain = (key) => {
  if (isPhone()) return
  noMainUntil.set(key, Date.now() + NO_MAIN_MS)
}

let cameras = [] // every camera on every NVR, in this user's order: { nvr, site, nvrName, ch, name, online }
let serverList = [] // the same, as the server sends them (the default order: site, NVR, channel)
let user = null
let page = 0
let fastUntil = Date.now() + 60_000 // the camera list is re-read every 5 s until then (listSoon)
let overlayZoom = null // the full-size view's zoom (pinch-zoom.js), while it is open
let single = null // key (nvr/ch) of the camera shown full-size, or null for the grid
const camKey = (cam) => `${cam.nvr}/${cam.ch}`
let tiles = []
// each tile's counters (press D); ?stats=1 in the address shows them from the start, for a phone,
// which has no D key
let showStats = new URLSearchParams(location.search).get('stats') === '1'
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

// line crossing (admins): lines drawn on the camera shown full-size, for the camera's own detection
// (lines-panel.js). One panel at a time with Picture: both sit over the right of the picture.
let linesPanel = null // the open Lines panel, or null
const linesSupport = new Map() // camKey -> Promise<true | false | null>: asked once per camera while this page is open
/**
 * Whether the camera has line-crossing detection of its own (GET .../lines: the NVR's own answer).
 * null when it could not be asked (camera offline, NVR busy): asked again the next time the view opens.
 */
function linesSupported(cam) {
  const k = camKey(cam)
  if (!linesSupport.has(k)) {
    const ask = fetch(`/api/admin/nvrs/${encodeURIComponent(cam.nvr)}/channels/${cam.ch}/lines`, { cache: 'no-store' })
      .then(async (res) => (res.ok ? (await res.json())?.lines?.supported === true : null))
      .catch(() => null)
      .then((ok) => {
        if (ok === null) linesSupport.delete(k)
        return ok
      })
    linesSupport.set(k, ask)
  }
  return linesSupport.get(k)
}
/** The Lines panel may go (it asks first when lines are drawn but not saved). */
const linesDiscard = () => !linesPanel || linesPanel.confirmDiscard()

if (!('VideoDecoder' in window)) {
  notice.hidden = false
  notice.textContent = window.isSecureContext
    ? 'This browser cannot decode video (no WebCodecs). Use a current Chrome, Edge or Safari.'
    : 'Video needs a secure connection. Open this page with https:// (port 8443) instead.'
}

// for diagnostics from the console: stats of every visible tile
window.cctvStats = () => tiles.map((t) => ({ nvr: t.nvr, ch: t.ch + 1, stream: t.streamType, ...t.player.stats }))
// the cameras started ahead of a full-size view (‹ ›): whether each could be shown at once
window.cctvAhead = () => [...ahead].map(([k, t]) => ({ k, ws: t.ws?.readyState ?? null, gop: t.gop?.length ?? 0, gopKB: Math.round(t.gopBytes / 1024), sinceData: t.lastDataAt ? Date.now() - t.lastDataAt : null, lendable: t.lendable }))
// the shared live connection: open or not, its channels, messages sent, frames (live-mux.js)
window.cctvMux = muxState

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
  '2+8': { size: 4, big: [[1, 1, 2, 2], [3, 1, 2, 2]] },
  // phones: every camera in one scrolling column (up to LIST_PAGE a page), each streaming only
  // while it is on screen
  list: { size: 1, list: true }
}
const LIST_PAGE = 48

/** Cells of a layout as [column, row, width, height], large tiles first. */
function layoutCells(id) {
  if (LAYOUTS[id]?.list) return { size: 1, cells: Array.from({ length: LIST_PAGE }, (_, i) => [1, i + 1, 1, 1]) }
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
  // an unused cell: a grid keeps its shape with it; the phone's list leaves it out (style.css)
  tile.className = cam ? 'tile' : 'tile tile-empty'
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
    stopAhead()
  }
  grid.classList.toggle('show-stats', showStats)
  // the kept view and its panel stay in place (moving them would close an open dialog)
  const kept = keep ? [overlay, imagePanel.el, linesPanel?.el].filter((n) => n?.parentNode === grid) : []
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
  // Tiles open staggered so a big grid does not ask one NVR for everything at once -- but the
  // stagger is counted per NVR, because cameras on different recorders are not competing for
  // anything. Counted across the whole grid, an 8x8 made its last tile wait 63 x 60 = nearly four
  // seconds before it even began connecting, most of it queued behind cameras on other sites
  // entirely. Per NVR, the same grid spread over four of them waits under a second, and each
  // recorder sees exactly the same rate of requests as before.
  const openedPerNvr = new Map()
  for (let i = 0; i < perPage; i++) {
    const cam = visible[i]
    const slot = { cam, el: null, live: null }
    gridSlots.push(slot)
    const n = openedPerNvr.get(cam?.nvr) ?? 0
    openedPerNvr.set(cam?.nvr, n + 1)
    // 15 ms, not 60: the server queues its own calls to each NVR (and a stream it already has costs
    // the NVR nothing), so the page's spacing mostly held back pictures that were ready
    fillSlot(slot, gridArea(cells[i]), n * 15)
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
  tile.addEventListener('click', () => openSingle(slot.cam, { fromTap: true }))
  // the phone list: a camera streams only while it is on screen (48 at once would swamp a phone)
  if (LAYOUTS[layoutSelect.value]?.list) return watchInView(slot, tile)
  slot.live = new LiveTile(tile, cam, SUB_STREAM, startDelayMs, tileOptions(cam))
  gridTiles.push(slot.live)
}

// Phone list: start a tile's stream when it scrolls into view, stop it a few seconds after it
// leaves (a quick flick past does not start and stop a stream for nothing).
const LEAVE_MS = 3000
const inView = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    const slot = e.target._slot
    if (!slot || !slot.el?.isConnected) continue
    clearTimeout(slot.leaveTimer)
    if (e.isIntersecting) {
      if (!slot.live) {
        slot.live = new LiveTile(slot.el, slot.cam, SUB_STREAM, 0, tileOptions(slot.cam))
        gridTiles.push(slot.live)
      }
    } else if (slot.live) {
      slot.leaveTimer = setTimeout(() => {
        if (!slot.live) return
        slot.live.close()
        const i = gridTiles.indexOf(slot.live)
        if (i >= 0) gridTiles.splice(i, 1)
        slot.live = null
      }, LEAVE_MS)
    }
  }
}, { rootMargin: '150px 0px' }) : null
function watchInView(slot, tile) {
  tile._slot = slot
  if (inView) inView.observe(tile)
  else {
    slot.live = new LiveTile(tile, slot.cam, SUB_STREAM, 0, tileOptions(slot.cam))
    gridTiles.push(slot.live)
  }
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

// ---- the overlay this app draws over the picture (osd-overlay.js) --------------------------------

// The settings, fetched once at start and refreshed with the camera list. An empty default until
// then, which draws nothing: better a tile with no overlay for a second than an overlay that jumps
// into place with the wrong text.
let osdSettings = { default: DEFAULT_OSD, cameras: {} }
/**
 * The server's clock minus this browser's. The overlay must show the SERVER's time, because that is
 * the clock we have made authoritative, and a viewing PC's own clock may be minutes out with nobody
 * the wiser. Measured from the Date header of requests the page already makes, so it costs nothing.
 */
let clockOffsetMs = 0
const serverNow = () => Date.now() + clockOffsetMs
/** The time zone the overlay is written in: this browser's, the same one the rest of the page uses. */
const osdTzMs = () => -new Date().getTimezoneOffset() * 60_000

/** Takes the server's clock off any response that carries a Date header. */
function noteServerClock(res) {
  const off = clockOffsetFrom(res?.headers?.get?.('date'))
  if (off !== null) clockOffsetMs = off
}

async function loadOsd() {
  const res = await fetch('/api/osd').catch(() => null)
  if (!res?.ok) return
  noteServerClock(res)
  const data = await res.json().catch(() => null)
  if (data?.default) osdSettings = { default: data.default, cameras: data.cameras ?? {} }
}

/** What a tile should draw: this camera's settings over the site-wide default, and the moment. */
function osdForTile(cam) {
  if (!cam) return null
  const key = camKey(cam)
  try {
    return {
      settings: osdSettings.cameras[key] ?? osdSettings.default,
      // The name is the camera's own, as the NVR reports it. A camera whose name we do not know
      // draws no name line at all rather than a placeholder somebody might read as a fact.
      camera: { name: cam.name },
      atMs: serverNow(),
      tzMs: osdTzMs()
    }
  } catch {
    return null
  }
}

const tileOptions = (cam) => ({
  pacing: PACING,
  clock: clockOptions(),
  statsVisible: () => showStats,
  onDisconnect: () => {
    checkSession()
    listSoon() // the server may be restarting: its cameras come back one NVR at a time
  },
  osd: () => osdForTile(cam),
  maxFps: maxLiveFps()
})

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
// ---- phones: the phone's own video player, as YouTube uses ----
// A camera here is drawn on a canvas, which an iPhone will not put full screen. Its picture is
// turned into a live video (canvas.captureStream) as soon as the view opens, so that by the time
// the button is tapped the video is ready: the iPhone only enters its player straight from a tap,
// and only for a video that has loaded. That player then rotates with the phone by itself.
const standalone = () => matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone === true

function nativeFullButton(tile) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'phone-fs-btn'
  btn.setAttribute('aria-label', 'Full screen')
  btn.textContent = '⛶'
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.setAttribute('playsinline', '')
  // full size behind the picture: iOS will not put a video it considers invisible into its player
  video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0.01;pointer-events:none;z-index:0'
  tile.append(video)
  const canvasNow = () => tile.querySelector('.tile-upgrade:not(.pending) canvas') ?? tile.querySelector('canvas')
  const attach = () => {
    const cv = canvasNow()
    if (!cv?.captureStream) return false
    if (video.dataset.from !== cv.dataset.fsid) {
      cv.dataset.fsid ||= String(Math.random())
      video.dataset.from = cv.dataset.fsid
      video.srcObject = cv.captureStream(15)
      video.play().catch(() => {})
    }
    return true
  }
  attach()
  // the full-size stream replaces the first picture a moment later: follow it
  const follow = setInterval(() => (tile.isConnected ? attach() : clearInterval(follow)), 1000)
  const say = (text) => {
    const n = document.createElement('div')
    n.className = 'phone-fs-note'
    n.textContent = text
    tile.append(n)
    setTimeout(() => n.remove(), 4000)
  }
  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    // 1. the standard way (Android, tablets): the page's own full screen (the phone is not turned:
    // it follows however the viewer holds it)
    const target = document.documentElement
    if (target.requestFullscreen && document.fullscreenEnabled) {
      try {
        if (!document.fullscreenElement) await target.requestFullscreen({ navigationUI: 'hide' })
        document.body.classList.add('phone-full')
        return
      } catch {}
    }
    // 2. an iPhone: the phone's own video player. Safari does not start this video until a tap, so
    // it is started here, inside the tap, and given a moment for its first frame before the player
    // is asked for (it refuses a video with nothing in it yet).
    if (video.webkitEnterFullscreen && attach()) {
      try {
        if (video.paused) await video.play().catch(() => {})
        for (let i = 0; i < 15 && video.readyState < 2; i++) await new Promise((r) => setTimeout(r, 100))
        video.webkitEnterFullscreen()
        return
      } catch {}
      // Safari would not: the camera already fills the screen sideways; say how to lose Safari's bars
      return say(standalone() ? 'This iPhone would not open its player. The picture already fills the screen: turn the phone sideways.' : 'For full screen on an iPhone: tap Share, then Add to Home Screen, and open Argus from there. Meanwhile, turn the phone sideways.')
    }
    say('This browser does not allow full screen here. Turn the phone sideways instead.')
  })
  return btn
}

// ---- phones: a tapped camera fills the screen, turned to landscape ----
// The grid (not the camera's own tile) goes full screen: the tile is rebuilt when the camera list
// refreshes, and taking a full-screen element out of the page drops out of full screen. Android
// Chrome turns the screen with orientation.lock; an iPhone has no full screen for a page element
// and no lock, so there the camera fills the page and turning the phone does the rest.
let phoneFull = false

function enterPhoneFull() {
  if (!isPhone()) return
  phoneFull = true
  // Filling the screen does not depend on the browser allowing it: an iPhone has no full screen
  // for a page element at all, so the camera covers the page itself (css: body.phone-full), and
  // real full screen (hiding the browser's own bars) is added where the phone allows it.
  document.body.classList.add('phone-full')
  if (document.fullscreenElement || !grid.requestFullscreen) return
  grid.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}) // refused: it still fills the page
}

function leavePhoneFull() {
  document.body.classList.remove('phone-full')
  if (!phoneFull) return
  phoneFull = false
  try { screen.orientation?.unlock?.() } catch {}
  if (document.fullscreenElement === grid) document.exitFullscreen().catch(() => {})
}

// ---- the full-size view: instant pictures ----
// The full-size view shows a camera that is usually streaming already: in its grid tile (hidden
// underneath), or started ahead as the camera either side of the one on screen (‹ ›, a flick, the
// arrow keys). It borrows that stream (live-tile.js #borrow) instead of opening a connection of its
// own, which through the internet link took 1-1.8 s before anything showed (2026-09-26).
const ahead = new Map() // camKey -> LiveTile, connected but not decoded (suspended)
function lenderFor(cam) {
  const grid = gridTiles.find((t) => t.nvr === cam.nvr && t.ch === cam.ch && t.streamType === SUB_STREAM && t.lendable)
  if (grid) return grid
  const k = camKey(cam)
  const t = ahead.get(k)
  if (!t?.lendable) return null
  // it becomes the full-size view's own (closed with it), no longer one started ahead
  ahead.delete(k)
  singleTiles.push(t)
  return t
}
/** Starts the cameras either side of this one (not already on the grid page), and lets others go. */
function startAhead(cam) {
  const list = shownCameras(cameras, { site: siteSelect.value, hideOffline: hideOffline.checked })
  const i = list.findIndex((c) => camKey(c) === camKey(cam))
  const want = new Map()
  if (i >= 0 && list.length > 1) {
    for (const d of [1, -1]) {
      const c = list[(i + d + list.length) % list.length]
      if (camKey(c) !== camKey(cam)) want.set(camKey(c), c)
    }
  }
  for (const [k, t] of ahead) {
    if (want.has(k)) continue
    t.close()
    ahead.delete(k)
  }
  for (const [k, c] of want) {
    if (ahead.has(k) || gridTiles.some((t) => t.nvr === c.nvr && t.ch === c.ch && t.streamType === SUB_STREAM && !t.closed)) continue
    const el = document.createElement('div')
    el.className = 'tile'
    el.innerHTML = TILE_HTML
    const t = new LiveTile(el, c, SUB_STREAM, 250, { ...tileOptions(c), noStill: true })
    t.suspend()
    ahead.set(k, t)
  }
}
function stopAhead() {
  for (const t of ahead.values()) t.close()
  ahead.clear()
}

function openSingle(cam, { fromTap = false } = {}) {
  // the camera being left (a step with ‹ ›): the connection that carries its stream is kept, started
  // ahead as the new camera's neighbour, rather than closed and opened again a moment later
  const leftCam = singleCam
  const leaving = leftCam && singleTiles.find((t) => t.streamType === SUB_STREAM && t.nvr === leftCam.nvr && t.ch === leftCam.ch && !t.closed)
  const owner = leaving ? (leaving.source ?? leaving) : null
  const keep = owner && !gridTiles.includes(owner) && owner.ws?.readyState === 1 && !ahead.has(camKey(leftCam)) ? owner : null
  closeSingle({ resumeGrid: false, keep })
  if (keep) {
    keep.suspend()
    ahead.set(camKey(leftCam), keep)
  }
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
      // one panel at a time: the Lines panel goes first (asking when lines are unsaved)
      if (linesPanel && !linesPanel.requestClose()) return
      imagePanel.open(cam, { opener: pic })
      pic.setAttribute('aria-expanded', 'true')
      grid.append(imagePanel.el)
    })
    links.append(pic)
    // Lines: only for a camera whose NVR says it has line crossing of its own (hidden until then)
    const lines = document.createElement('button')
    lines.type = 'button'
    lines.className = 'pb-link lines-toggle'
    lines.textContent = 'Lines'
    lines.title = 'Line crossing: draw lines for the camera\'s own detection'
    lines.hidden = true
    lines.setAttribute('aria-expanded', String(linesPanel?.key === single))
    lines.addEventListener('click', (e) => {
      e.stopPropagation()
      if (linesPanel?.key === single) {
        linesPanel.requestClose()
        return
      }
      // one panel at a time: the Picture panel goes first (asking when changes are unsent)
      if (!imagePanel.confirmDiscard()) return
      imagePanel.close()
      overlayZoom?.reset() // the lines are drawn on the whole picture
      linesPanel = new LinesPanel(grid, cam, {
        liveEl: () => shownPlayer()?.player?.canvas ?? null,
        opener: lines,
        onClose: () => {
          linesPanel = null
          for (const b of grid.querySelectorAll('button.lines-toggle')) b.setAttribute('aria-expanded', 'false')
        }
      })
      linesPanel.open()
      lines.setAttribute('aria-expanded', 'true')
    })
    links.append(lines)
    linesSupported(cam).then((ok) => {
      if (ok) lines.hidden = false
    })
  }
  overlay.querySelector('.name').after(links)
  if (isPhone()) overlay.append(nativeFullButton(overlay))
  overlay.append(...stepArrows()) // ‹ › on every screen (keys: ← →)
  // closing the view discards the panel's unsent changes: ask first
  overlay.addEventListener('click', () => {
    if (imagePanel.confirmDiscard() && linesDiscard()) closeSingle()
  })
  // zoom: the wheel, a pinch, drag to pan, double-click / double-tap back (pinch-zoom.js). Only the
  // pictures move (style.css .single-overlay canvas); the name, the badge and the buttons stay put.
  // While zoomed a tap does not close the view and a flick does not change camera.
  const view = overlay
  overlayZoom = attachZoom(view, {
    // paused while the Lines panel is open: a drag there draws a line, and lines need the whole picture
    busy: () => Boolean(linesPanel),
    apply: (z, x, y) => {
      view.style.setProperty('--zs', String(z))
      view.style.setProperty('--zx', `${x}px`)
      view.style.setProperty('--zy', `${y}px`)
      view.classList.toggle('zoomed', z > 1)
      const badge = view.querySelector(':scope > .zoom-badge')
      if (badge) {
        badge.hidden = z === 1
        badge.textContent = `${z.toFixed(1)}×`
      }
    }
  })
  const badge = document.createElement('span')
  badge.className = 'zoom-badge'
  badge.hidden = true
  overlay.append(badge)
  grid.append(overlay)
  // inside the tap itself: a browser allows full screen only in answer to one
  if (fromTap) enterPhoneFull()
  // open for this camera: keep it (and its unsent changes) across a rebuild of the view
  if (imagePanel.key === single) grid.append(imagePanel.el)
  else imagePanel.close()
  // the Lines panel likewise; its drawing follows the camera's picture into the rebuilt view
  if (linesPanel?.key === single) grid.append(linesPanel.el)
  else linesPanel?.close()
  const opts = tileOptions(cam)
  const sub = new LiveTile(overlay, cam, SUB_STREAM, 0, { ...opts, borrowFrom: lenderFor(cam) })
  singleTiles.push(sub)
  startAhead(cam)
  // cameras reached through TVT P2P stay on the sub stream (the relay has little bandwidth)
  if (!noMain.has(single) && !cam.remote) upgradeToMain(overlay, cam, sub, opts)
  syncTiles()
  updatePager()
}

/** Back to the grid: the grid tiles pick up again straight away. */
function closeSingle({ resumeGrid = true, keep = null } = {}) {
  overlayZoom = null
  for (const t of singleTiles) if (t !== keep) t.close()
  singleTiles = []
  overlay?.remove()
  overlay = null
  if (!resumeGrid) return
  stopAhead()
  leavePhoneFull()
  imagePanel.close()
  linesPanel?.close()
  single = null
  singleCam = null
  // A phone rebuilds its grid instead: under the full-size view the list's tiles were scrolled out,
  // covered or stopped, and after the screen turned some never came back (blank tiles). A fresh
  // grid shows each camera's last picture at once and reconnects.
  if (isPhone()) {
    // (kept where it was: rebuilding the list would otherwise jump back to the first camera)
    const scroller = document.querySelector('.app-main') ?? document.scrollingElement
    const top = scroller?.scrollTop ?? 0
    render()
    if (scroller) scroller.scrollTop = top
    return
  }
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
    noStill: true, // the sub-stream below it already shows the still
    onFirstFrame: () => {
      layer.classList.remove('pending')
      const links = tile.querySelector(':scope > .label .links')
      if (links) layer.querySelector('.name').after(links)
      // the sub-stream's LIVE badge goes with it: it sits above the layer, and where the two do not
      // line up exactly (an iPhone turned sideways) the view showed LIVE twice
      tile.querySelector(':scope > .status')?.remove()
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
  const before = [overlay, imagePanel.el, linesPanel?.el].find((n) => n?.parentNode === grid) ?? null
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
      const was = s.cam
      s.cam = v.visible[i]
      s.el.style.gridArea = gridArea(cell)
      if (Boolean(was?.online) !== Boolean(s.cam?.online)) {
        // (a list refresh with Hide offline off: this camera went offline, or came back)
        if (s.live) {
          s.live.close()
          gridTiles = gridTiles.filter((t) => t !== s.live)
        }
        const old = s.el
        fillSlot(s, gridArea(cell))
        old.replaceWith(s.el)
        if (single !== null) s.live?.suspend()
      } else if (tileLabel(was) !== tileLabel(s.cam)) s.el.querySelector('.name').textContent = tileLabel(s.cam) // (name or site)
      return s
    }
    const s = { cam: v.visible[i], el: null, live: null }
    fillSlot(s, gridArea(cell))
    grid.insertBefore(s.el, before)
    // under an open full-size view the grid decodes nothing
    if (single !== null) s.live?.suspend()
    return s
  })
  // the page in slot order: on a phone the grid places tiles by their order in the page, not their
  // grid-area, so an arriving camera appended at the end showed last (moving a tile does not restart it)
  for (const s of gridSlots) grid.insertBefore(s.el, before)
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
  // the phone's back gesture left full screen: back to the grid too
  if (!on && phoneFull) {
    phoneFull = false
    document.body.classList.remove('phone-full')
    try { screen.orientation?.unlock?.() } catch {}
    if (single !== null) closeSingle()
  }
})
if (!document.fullscreenEnabled) fullBtn.hidden = true

try {
  smoothBox.checked = localStorage.getItem('cctv.smooth') === '1'
} catch {}
smoothBox.addEventListener('change', () => {
  try { localStorage.setItem('cctv.smooth', smoothBox.checked ? '1' : '0') } catch {}
  render()
})

// A phone has room for one camera, or four: the other layouts are taken off its menu, and it keeps
// its own choice (a PC's 4 x 4 must not follow the same user onto a phone).
const PHONE_LAYOUTS = ['list', 'g1', 'g2']
const LAYOUT_KEY = isPhone() ? 'cctv.layout.phone' : 'cctv.layout'
if (isPhone()) {
  for (const o of [...layoutSelect.querySelectorAll('option')]) if (!PHONE_LAYOUTS.includes(o.value)) o.remove()
  for (const g of [...layoutSelect.querySelectorAll('optgroup')]) if (!g.children.length) g.remove()
  const opt = document.createElement('option')
  opt.value = 'list'
  opt.textContent = 'List'
  layoutSelect.prepend(opt)
  layoutSelect.value = 'list'
}
const markPhoneLayout = () => {
  document.body.classList.toggle('phone-g2', isPhone() && layoutSelect.value === 'g2')
  document.body.classList.toggle('phone-list', isPhone() && layoutSelect.value === 'list')
}
try {
  const saved = localStorage.getItem(LAYOUT_KEY)
  if (saved && LAYOUTS[saved] && (!isPhone() || PHONE_LAYOUTS.includes(saved))) layoutSelect.value = saved
} catch {}
markPhoneLayout()
layoutSelect.addEventListener('change', () => {
  page = 0
  markPhoneLayout()
  try { localStorage.setItem(LAYOUT_KEY, layoutSelect.value) } catch {}
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
  // Escape closes the Lines panel first (it lies over the picture), then the full-size view
  if (e.key === 'Escape' && linesPanel) {
    linesPanel.requestClose()
    return
  }
  if (e.key === 'Escape' && single !== null && !document.fullscreenElement && imagePanel.confirmDiscard()) closeSingle()
  // the full-size view: ← → go through the cameras, the same as ‹ › and a flick
  if (single !== null && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.target.closest?.('input, select, textarea')) {
    e.preventDefault()
    stepCamera(e.key === 'ArrowRight' ? 1 : -1)
  }
  if ((e.key === 'f' || e.key === 'F') && !e.target.closest?.('input, select, textarea')) toggleFullscreen()
  if (e.key === 'd' || e.key === 'D') {
    showStats = !showStats
    grid.classList.toggle('show-stats', showStats)
    showTraceBtn()
  }
})

// The frame trace (frame-trace.js), behind the D overlay: for 2 minutes, every frame of every tile
// as it arrives, then a JSON file to download, which test/live-replay.mjs replays through the player
// (stutter report, 2026-09-29, Task 0). Its button shows only with the overlay, or while a trace
// runs; nothing is recorded until it is pressed.
const traceBtn = document.createElement('button')
traceBtn.type = 'button'
traceBtn.title = 'Records when each frame of every tile arrives, for 2 minutes, then saves it as a file (for diagnosing stutter)'
document.querySelector('header .controls')?.append(traceBtn)
let traceTimer = null
let traceSaved = '' // what the last trace was saved as
function showTraceBtn() {
  const t = activeTrace()
  traceBtn.hidden = !showStats && !t
  traceBtn.textContent = t
    ? `● Trace: ${Math.ceil((t.durationMs - t.elapsedMs) / 1000)} s left, ${t.frames} frames (stop)`
    : traceSaved || 'Record trace (2 min)'
}
traceBtn.addEventListener('click', () => {
  if (activeTrace()) {
    stopTrace() // saved at once, as at the end
    return
  }
  traceSaved = ''
  startTrace({
    // what the page was, to read the trace by
    page: {
      host: location.host,
      userAgent: navigator.userAgent,
      layout: layoutSelect.value,
      gridPage: page + 1,
      single,
      smooth: smoothBox.checked,
      pacing: PACING,
      maxFps: maxLiveFps(),
      mux: !liveMuxOff,
      screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
      tiles: tiles.length
    },
    onDone: (trace) => {
      clearInterval(traceTimer)
      traceTimer = null
      const { name, bytes } = downloadTrace(trace)
      traceSaved = `Saved ${name} (${(bytes / 1e6).toFixed(1)} MB): record again`
      showTraceBtn()
    }
  })
  traceTimer = setInterval(showTraceBtn, 1000)
  showTraceBtn()
})
showTraceBtn()

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
  noteServerClock(res) // this runs every minute, so the overlay's clock never drifts from the server's
  if (res?.status === 401) location.href = '/login.html'
  return res?.ok ? res.json() : null
}

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' })
  location.href = '/login.html'
})

// Everything the first screen needs is asked for at once: the session, this user's order, the
// overlay settings and the camera list were four round trips one after another (about a second of
// empty page over mobile data).
const fetchLists = () => Promise.all([fetch('/api/cameras').then((r) => r.json()), fetch('/api/sites').then((r) => r.json())])
const prefetched = fetchLists()
prefetched.catch(() => {}) // (handled where it is used; a signed-out session is sent to sign-in first)
const early = Promise.all([sync.load(), loadOsd().catch(() => {})])
const me = await checkSession()
if (me) document.getElementById('whoami').textContent = me.user
if (me?.admin) { const st = document.getElementById('sitesTab'); if (st) st.hidden = false; const se = document.getElementById('settingsTab'); if (se) se.hidden = false }
isAdmin = Boolean(me?.admin)
user = me?.user ?? null
setInterval(checkSession, 60_000)

function multiSite() {
  return new Set(cameras.map((c) => c.site)).size > 1
}

/** Loads cameras from every NVR; keeps the grid as is unless the list changed. */
async function loadCameras(pre = null) {
  const [fresh, sites] = await (pre ?? fetchLists())
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
  // (a viewer is told only the site, name and state of an NVR: /api/sites, rights.mjs sitesFor)
  notice.textContent = cameras.length === 0 && down.length === 0
    ? (isAdmin ? 'No cameras yet. Add an NVR with: docker exec -it tvt-cctv node cctv/nvr.mjs add' : 'No cameras have been shared with you yet. Ask an admin for access.')
    : down.map((s) => `${s.site} · ${s.name}${s.sn ? ` (serial ${s.sn})` : s.host ? ` (${s.host})` : ''} is ${s.status}${s.error ? `: ${s.error}` : ''}`).join(' — ')
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
  const sameFrame = gridSlots.length > 0 && view.site === beforeView.site
  const diff = sameFrame ? diffCameras(before, list, view) : { full: true }
  if (!diff.full) return updateTiles(diff.changed)
  // A camera came onto or left the page (Hide offline: cameras on nvr1/nvr-2 drop out together for
  // a minute or two when their network blips). The tiles that stay move and keep playing; only a
  // camera that left closes and only one that arrived opens. This rebuilt the whole grid, 9-13 new
  // connections at once, even behind an open full-size view.
  const labelsSame = (new Set(before.map((c) => c.site)).size > 1) === multiSite()
  if (!sameFrame || !labelsSame) return render({ keepSingle: true })
  drag.cancel()
  relayout() // (falls back to render itself when the page or the layout no longer fits)
  syncSingle(single !== null && overlay !== null && singleTiles.some((t) => !t.closed))
}

// A first load that fails (the server restarting: Cloudflare answers 502/530 in HTML) must not stop
// this module here: the timers below would never start and the page would stay empty until someone
// reloaded it. It is retried by the 5 s refresh instead.
// Nor may one that never answers: just after a restart two of these requests hung for over a minute
// (Cloudflare holding them on a connection to the old process) and the grid never appeared. The page
// goes on after a few seconds; the order and the overlay settings arrive with their own refreshes.
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))])
await within(early.catch(() => {}), 6000)
await within(loadCameras(prefetched).catch(() => listSoon()), 8000)
listSoon() // (whatever happened above, the list is re-read every 5 s for the next minute)
if (sync.unsaved) sync.refresh()
// the camera list, and this user's order (another screen may have changed it)
setInterval(() => {
  loadCameras().catch(() => {})
  loadOsd().catch(() => {}) // an overlay changed in Settings reaches every screen within half a minute
  sync.refresh()
}, 30_000)
// ...and every 5 s for a minute after the page opens or its streams drop: after a server restart the
// NVRs' cameras come back one NVR at a time over 10-30 s, and waiting for the 30 s refresh left
// them missing from the grid for up to half a minute longer.
function listSoon() {
  fastUntil = Date.now() + 60_000
}
setInterval(() => {
  if (Date.now() < fastUntil && !document.hidden) loadCameras().catch(() => {})
}, 5000)

// Once per browser: say that the grid can be rearranged, which nothing on screen otherwise shows.
{
  let seen = false
  try { seen = localStorage.getItem('cctv.tip.drag') === '1' } catch {}
  if (!seen && !matchMedia('(pointer: coarse)').matches) {
    const tip = document.createElement('div')
    tip.className = 'live-tip'
    tip.innerHTML = '<span>Tip: drag a camera onto another to swap them, or onto ‹ › to move it to another page. Your order is kept.</span>'
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.textContent = 'Got it'
    ok.addEventListener('click', () => {
      tip.remove()
      try { localStorage.setItem('cctv.tip.drag', '1') } catch {}
    })
    tip.append(ok)
    document.body.append(tip)
  }
}

// ---- phones: flick left and right to go through the cameras ----
/** The next (dir 1) or previous (-1) camera of the grid, full-size. */
function stepCamera(dir) {
  const list = shownCameras(cameras, { site: siteSelect.value, hideOffline: hideOffline.checked })
  if (list.length < 2 || single === null) return
  const i = list.findIndex((c) => camKey(c) === single)
  const next = list[(i + dir + list.length) % list.length]
  if (imagePanel.confirmDiscard() && linesDiscard()) openSingle(next)
}

/** The ‹ › on a phone's full-size camera: they say a flick works, and a tap on one works too. */
function stepArrows() {
  return ['prev', 'next'].map((which) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `phone-step phone-step-${which}`
    b.setAttribute('aria-label', which === 'next' ? 'Next camera' : 'Previous camera')
    b.textContent = which === 'next' ? '›' : '‹'
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      stepCamera(which === 'next' ? 1 : -1)
    })
    return b
  })
}

// In the full-screen view, a flick moves to the next or previous camera of the grid (the same
// site filter, offline hidden the same way, in this user's order). A tap still closes. When the
// picture is shown turned a quarter (an upright phone that would not rotate), "left and right"
// are along the phone's length, so the flick is read on that axis.
{
  const SWIPE_PX = 50
  let t0 = null
  let swipedAt = 0
  const rotated = () => false // the picture is no longer turned sideways on an upright phone
  document.addEventListener('touchstart', (e) => {
    if (!document.body.classList.contains('phone-full') || e.touches.length !== 1) return (t0 = null)
    if (linesPanel) return (t0 = null) // drawing lines: a flick draws, it does not change camera
    if (overlayZoom && overlayZoom.zoom > 1) return (t0 = null) // zoomed: one finger moves the picture
    t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY }
  }, { passive: true })
  document.addEventListener('touchend', (e) => {
    if (!t0 || single === null) return
    if (overlayZoom && overlayZoom.zoom > 1) return (t0 = null) // (a pinch that started as one finger)
    const t = e.changedTouches[0]
    const dx = t.clientX - t0.x
    const dy = t.clientY - t0.y
    t0 = null
    // the picture's own left-right: across the screen, or down the screen when turned a quarter
    const along = rotated() ? dy : dx
    const across = rotated() ? dx : dy
    if (Math.abs(along) < SWIPE_PX || Math.abs(along) < Math.abs(across) * 1.5) return
    swipedAt = performance.now()
    stepCamera(along < 0 ? 1 : -1)
  }, { passive: true })
  // the click a browser sends after the flick must not close the view
  document.addEventListener('click', (e) => {
    if (performance.now() - swipedAt < 500) {
      e.stopPropagation()
      e.preventDefault()
    }
  }, true)
}

// ---- phones: the cameras as a list ----
// A phone shows four cameras at most; to reach the one you want, a list: every camera by site, with
// a search and whether it is online. A tap opens it full screen, where a flick goes on to the next.
{
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.id = 'cameraListBtn'
  btn.className = 'phone-list-btn'
  btn.textContent = 'Cameras'
  siteSelect.closest('label')?.before(btn)

  const sheet = document.createElement('div')
  sheet.className = 'cam-sheet'
  sheet.hidden = true
  sheet.innerHTML = '<div class="cam-sheet-head"><input type="search" placeholder="Find a camera" aria-label="Find a camera" /><button type="button" class="cam-sheet-close" aria-label="Close">✕</button></div><div class="cam-sheet-list" role="list"></div>'
  document.body.append(sheet)
  const search = sheet.querySelector('input')
  const list = sheet.querySelector('.cam-sheet-list')

  const draw = () => {
    const q = search.value.trim().toLowerCase()
    const shown = cameras.filter((c) => !q || `${c.name} ${c.site} ${c.nvrName} ${c.ch + 1}`.toLowerCase().includes(q))
    const bySite = Map.groupBy(shown, (c) => c.site || c.nvrName)
    list.replaceChildren(...[...bySite].flatMap(([site, cams]) => {
      const h = document.createElement('div')
      h.className = 'cam-sheet-site'
      h.textContent = `${site} · ${cams.filter((c) => c.online).length} of ${cams.length} online`
      return [h, ...cams.map((c) => {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = `cam-sheet-row${c.online ? '' : ' off'}`
        row.disabled = !c.online
        row.innerHTML = '<span class="cam-dot"></span><span class="cam-name"></span><span class="cam-ch"></span>'
        row.querySelector('.cam-name').textContent = c.name
        row.querySelector('.cam-ch').textContent = c.online ? `ch ${c.ch + 1}` : 'offline'
        row.addEventListener('click', () => {
          sheet.hidden = true
          openSingle(c, { fromTap: true })
        })
        return row
      })]
    }))
    if (!shown.length) list.textContent = 'No camera matches.'
  }
  btn.addEventListener('click', () => {
    sheet.hidden = false
    search.value = ''
    draw()
  })
  search.addEventListener('input', draw)
  sheet.querySelector('.cam-sheet-close').addEventListener('click', () => (sheet.hidden = true))
}
