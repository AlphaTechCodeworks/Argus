// Camera grid: each tile streams one camera over WebSocket into a VideoPlayer.
import { isLocalHost, isPhone, maxLiveFps } from './device.js'
import { attachZoom } from './pinch-zoom.js'
import { diffCameras, shownCameras, visibleCameras } from './grid-diff.js'
import { enableGridDrag } from './grid-drag.js'
import { activeTrace, downloadTrace, startTrace, stopTrace } from './frame-trace.js'
import { applyOrder, createOrderSync, moveOp, reuseSlots, swapOp } from './grid-order.js'
import { MAX_VIEW_CAMERAS, applyViews, autoLiveGrid, checkView, normaliseViews, searchCameras } from './grid-view.js'
import { icon } from './icons.js'
import { mountCameraBrowser, rememberSite, workspaceSite } from './camera-browser.js'
import { preferenceStorage, preferencesReady } from './user-settings.js'
import { freshenForPageChange, muxState, useMux } from './live-mux.js'
import { H264_RETRY_MS, LiveTile, MAIN_STREAM, SUB_STREAM, TILE_HTML, mainNotConvertedTitle } from './live-tile.js'
import { DEFAULT_OSD, clockOffsetFrom } from './osd-overlay.js'
import { REMOTE_NO_REWIND_MS, REMOTE_QUEUED_FRAMES, loopStats } from './player.js'
import { REMOTE_CLOCK } from './playout.js'
import { startTelemetry } from './telemetry.js'
import { TOLERANCE, knownCapacity, layoutNote as profileNote, noteCapacity, noteSecond, readProfile, saveProfile, statusOf } from './wall-profile.js'
import { THIN_MAX_KEY_MS, THIN_MIN_TILES, THIN_SETTLE_MS, fullRateTiles, nextBudget, thinStart } from './wall-thin.js'
import { NO_H265_NOTE, layoutShown, layoutsOffered } from './grid-view.js'
import { cannotPlayH265 } from './live-tile.js'
// This page is set up from the account's preferences (picture fit, layout, hide offline, the view
// and site last chosen), from its first lines on: it waits here until they are known. It is this
// page's own script, which nothing imports, so it may wait at the top level; user-settings.js, which
// every page shares, may not (the reason is at the top of that file).
await preferencesReady
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
const pictureFit = document.getElementById('pictureFit')
const mobileControls = document.getElementById('mobileControls')
mobileControls.addEventListener('click', () => {
  const expanded = mobileControls.getAttribute('aria-expanded') !== 'true'
  mobileControls.setAttribute('aria-expanded', String(expanded))
  document.body.classList.toggle('mobile-controls-open', expanded)
})
const PICTURE_MODES = ['auto', 'fit', 'fill', 'stretch']
const savedPictureFit = preferenceStorage.getItem('cctv.pictureFit')
pictureFit.value = PICTURE_MODES.includes(savedPictureFit) ? savedPictureFit : 'auto'
grid.dataset.pictureFit = pictureFit.value
pictureFit.addEventListener('change', () => {
  grid.dataset.pictureFit = pictureFit.value
  preferenceStorage.setItem('cctv.pictureFit', pictureFit.value)
  if (layoutSelect.value === 'auto') relayout()
})
const cameraSearch = document.getElementById('cameraSearch')
let cameraQuery = ''
const pageLabel = document.getElementById('page')
const prevBtn = document.getElementById('prev')
const nextBtn = document.getElementById('next')
const notice = document.getElementById('notice')
const siteSelect = document.getElementById('site')
let liveBrowser
const hideOffline = document.getElementById('hideOffline')
const smoothBox = document.getElementById('smooth')
const fullBtn = document.getElementById('fullscreen')
const resetBtn = document.getElementById('resetOrder')
const orderNoteEl = document.getElementById('orderNote')
const viewSel = document.getElementById('viewSel')
const saveViewBtn = document.getElementById('saveView')
const deleteViewBtn = document.getElementById('deleteView')
const viewDlg = document.getElementById('saveViewDlg')
const viewNameEl = document.getElementById('viewName')
const viewMsgEl = document.getElementById('viewMsg')
// "Smooth": a bigger playout buffer absorbs uneven delivery (more delay, steadier motion)
const SMOOTH_CLOCK = { startDelayMs: 400, minDelayMs: 300, maxDelayMs: 1200 }
// A page opened through the Cloudflare tunnel or the tailnet, not on a local address (device.js): its
// one socket stalls now and then for longer than live's buffer holds, and each stall froze every tile
// and then jumped ahead. Its tiles get the buffer that grows with the stalls, up to 2 s, and room for
// that many decoded frames (playout.js REMOTE_CLOCK, player.js REMOTE_QUEUED_FRAMES; stutter report
// 2.4, 29 Sep); with Smooth it starts and stays at least as big as Smooth's. A page on the local
// network keeps live's own clock, or Smooth, exactly as before.
const REMOTE_PAGE = !isLocalHost()
const REMOTE_SMOOTH_CLOCK = { ...REMOTE_CLOCK, startDelayMs: SMOOTH_CLOCK.startDelayMs, minDelayMs: SMOOTH_CLOCK.minDelayMs }
const clockOptions = () => (REMOTE_PAGE ? (smoothBox.checked ? REMOTE_SMOOTH_CLOCK : REMOTE_CLOCK) : smoothBox.checked ? SMOOTH_CLOCK : undefined)
// an unobtrusive mark when this Live page was loaded through the tunnel, not the local address: the
// video is heavier on the link, so on site the local address is faster (playback hunt F1)
if (REMOTE_PAGE) {
  const mark = document.getElementById('remoteMark')
  if (mark) mark.hidden = false
}
// cameras whose main stream this browser could not play: full screen stays on the sub stream, for a
// while. Not for the whole session any more: the server now converts H.265 for phones and remote
// viewers, and a phone that once failed (before it did) was kept on the blurry sub-stream for good.
// A phone is never put on this list at all -- what it is sent is always H.264 it can play.
// Nor is a PC that cannot play H.265 kept off the main stream by it now that the server converts
// that too (h264-fallback.mjs): its tile first asks again for H.264 (live-tile.js), and a camera
// lands here only when H.265 came all the same, from a server that does not convert mains. The list
// lives in this page's memory and nowhere else, so nothing recorded before a reload outlasts it.
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
// saved views (grid-view.js, /api/me/views): a named set of cameras + a layout, kept with the
// account and shared with the Wall. activeView restricts the grid to its cameras in its order; null
// is "(not saved)" — every camera, filtered by site as before. views/viewsVersion mirror the server.
let views = []
let viewsVersion = 0
let activeView = null
let fastUntil = Date.now() + 60_000 // the camera list is re-read every 5 s until then (listSoon)
let overlayZoom = null // the full-size view's zoom (pinch-zoom.js), while it is open
let single = null // key (nvr/ch) of the camera shown full-size, or null for the grid
const camKey = (cam) => `${cam.nvr}/${cam.ch}`
let tiles = []
// each tile's counters (press D); ?stats=1 in the address shows them from the start, for a phone,
// which has no D key
let showStats = new URLSearchParams(location.search).get('stats') === '1'
let isAdmin = false

// the camera shown full-size. Its settings (Picture / OSD / Lines) now live on the Sites page
// (camera-editor.js); the full-size view is view-only.
let singleCam = null

if (!('VideoDecoder' in window)) {
  notice.hidden = false
  notice.textContent = window.isSecureContext
    ? 'This browser cannot decode video (no WebCodecs). Use a current Chrome, Edge or Safari.'
    : 'Video needs a secure connection. Open this page with https:// (port 8443) instead.'
}

// What the viewer actually gets, measured and sent to the server (telemetry.js): each playing tile
// once a second, and how long a first picture and full quality took. It decides nothing.
const telemetry = startTelemetry({
  page: 'live',
  tiles: () => tiles.filter((t) => !t.closed && !t.suspended).map((t) => {
    const s = t.player.stats
    const shown = t.player.firstPainted === true
    return {
      nvr: t.nvr, ch: t.ch, stream: t.streamType, role: singleTiles.includes(t) ? 'focus' : 'grid', playing: shown, attempts: t.attempts, decoderErrors: s.decoderErrors ?? 0,
      fps: s.fps, jitterMs: s.jitterMs, bufMs: s.delayMs, dropped: s.dropped, late: s.late, resync: s.resyncs, decQueue: s.decodeQueue ?? 0, kbps: s.kbps,
      arrived: s.arrived, decoded: s.decoded, gapMs: s.arriveGapMs, decMs: s.decodeMs, skip: s.skipped, over: s.overflowed, rafHz: loopStats.hz, rafGapMs: loopStats.gapMs,
      w: t.player.canvas.clientWidth, h: t.player.canvas.clientHeight, stalled: shown && s.fps === 0 && !t.player.keysOnly && !t.player.afterThin, visible: !document.hidden
    }
  })
})
// for diagnostics from the console: stats of every visible tile
window.cctvStats = () => tiles.map((t) => ({ nvr: t.nvr, ch: t.ch + 1, stream: t.streamType, ...t.player.stats }))
// the cameras started ahead of a full-size view (‹ ›): whether each could be shown at once
window.cctvAhead = () => [...ahead].map(([k, t]) => ({ k, ws: t.ws?.readyState ?? null, gop: t.gop?.length ?? 0, gopKB: Math.round(t.gopBytes / 1024), sinceData: t.lastDataAt ? Date.now() - t.lastDataAt : null, lendable: t.lendable }))
// the shared live connection: open or not, its channels, messages sent, frames (live-mux.js)
window.cctvMux = muxState

// Layouts: a grid size plus the large tiles (column, row, width, height; 1-based).
// Remaining cells are filled with single tiles in reading order.
let noH265Limit = false
const LAYOUTS = {
  auto: { auto: true },
  g1: { size: 1 },
  g2: { size: 2 },
  g3: { size: 3 },
  g4: { size: 4 },
  g5: { size: 5 },
  g6: { size: 6 },
  g8: { size: 8 },
  g10: { size: 10 },
  g12: { size: 12 },
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
  if (id === 'auto') {
    const count = shownCameras(gridCameras(), gridView(144)).length
    const style = getComputedStyle(grid)
    const width = grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const height = grid.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    const ratios = pictureFit.value === 'auto' ? gridTiles.map(t => t.player?.videoWidth / t.player?.videoHeight).filter(r => Number.isFinite(r) && r > 0).sort((a, b) => a - b) : []
    const pictureAspect = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 16 / 9
    const compactViewport = matchMedia('(max-width: 699px), (pointer: coarse) and (max-height: 500px)').matches
    const { size, rows } = autoLiveGrid(count, { noH265: noH265Limit, phone: isPhone() || compactViewport, width, height, gap: parseFloat(style.gap) || 8, pictureAspect })
    return { size, rows, cells: Array.from({ length: size * rows }, (_, i) => [i % size + 1, Math.floor(i / size) + 1, 1, 1]) }
  }
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
function refreshTileName(tile, cam) {
  const label = tileLabel(cam)
  tile.querySelector('.name').textContent = label
  tile.querySelector('.tile-open')?.setAttribute('aria-label', `Open ${label}`)
  tile.querySelector('.tile-move')?.setAttribute('aria-label', `Move ${label}`)
  const source = tile.querySelector('.tile-source')
  if (source) source.textContent = cam?.site || cam?.nvrName || ''
}

function makeTile(cam, { controls = true } = {}) {
  const tile = document.createElement('div')
  // an unused cell: a grid keeps its shape with it; the phone's list leaves it out (style.css)
  tile.className = cam ? 'tile' : 'tile tile-empty'
  tile.innerHTML = TILE_HTML
  tile.querySelector('.name').textContent = tileLabel(cam)
  if (cam) {
    const placeholder = document.createElement('div')
    placeholder.className = 'tile-placeholder'
    placeholder.setAttribute('aria-hidden', 'true')
    placeholder.innerHTML = `${icon('live')}<strong></strong><span></span>`
    placeholder.querySelector('strong').textContent = cam.online ? 'Connecting to camera' : 'Camera offline'
    placeholder.querySelector('span').textContent = cam.online ? 'The picture will appear automatically' : 'Waiting for the camera to come back online'
    tile.append(placeholder)
    const source = document.createElement('span')
    source.className = 'tile-source'
    source.textContent = cam.site || cam.nvrName || ''
    tile.querySelector('.label').append(source)
  }
  if (cam && controls) {
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'tile-open'
    open.setAttribute('aria-label', `Open ${tileLabel(cam)}`)
    open.disabled = !cam.online
    open.addEventListener('click', (e) => { e.stopPropagation(); openSingle(cameras.find((c) => camKey(c) === camKey(cam)) ?? cam, { fromTap: true }) })
    const move = document.createElement('button')
    move.type = 'button'
    move.className = 'tile-move'
    move.textContent = 'Move'
    move.setAttribute('aria-label', `Move ${tileLabel(cam)}`)
    move.addEventListener('click', (e) => { e.stopPropagation(); showMoveCamera(cameras.find((c) => camKey(c) === camKey(cam)) ?? cam) })
    move.addEventListener('pointerdown', (e) => e.stopPropagation())
    tile.append(open, move)
  }
  return tile
}

let gridTiles = [] // LiveTiles of the grid
let pictureLayoutTimer
function refreshPictureLayout() {
  clearTimeout(pictureLayoutTimer)
  pictureLayoutTimer = setTimeout(() => {
    if (pictureFit.value === 'auto' && layoutSelect.value === 'auto' && !document.hidden && single === null) relayout()
  }, 500)
}
let gridSlots = [] // one per grid cell: { cam, el, live: LiveTile | null }
let gridStale = false // the camera list changed while the tab was hidden
let singleTiles = [] // LiveTiles of the full-size view (sub, then main)
let overlay = null // the full-size tile, laid over the (suspended) grid
let upgradeTimer = null // the pending HD upgrade (debounced; cleared by closeSingle on a step or close)
// Wait this long on a camera before asking the NVR for its HD (main) stream, so stepping quickly
// through cameras does not churn main streams the NVR opens and closes (seconds each on a busy NVR).
const UPGRADE_DELAY_MS = 1000
// On a direct open (a click, not stepping) there is nothing to churn, so the HD is asked for almost
// at once -- just enough for the sub stream to paint first -- rather than after the full debounce.
const QUICK_UPGRADE_MS = 200

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
    stopAheadMain()
  }
  grid.classList.toggle('show-stats', showStats)
  // the kept view stays in place (moving it would close an open dialog)
  const kept = keep ? [overlay].filter((n) => n?.parentNode === grid) : []
  for (const n of [...grid.children]) if (!kept.includes(n)) { inView?.unobserve(n); n.remove() } // unobserve: phone-list tiles must not leak into the observer
  const before = kept[0] ?? null

  const { size, rows = size, cells } = layoutCells(layoutSelect.value)
  const perPage = cells.length
  grid.style.gridTemplateColumns = `repeat(${size}, 1fr)`
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`
  grid.dataset.size = String(size)

  gridStale = false
  const v = visibleCameras(gridCameras(), gridView(perPage))
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

/**
 * The cameras the grid draws from: a selected view's cameras in its own order (the ones that still
 * exist), or every camera when none is selected. Everything downstream — render, the diff, the
 * pager, the full-size ‹ › — reads this, so a view needs no special case in any of them.
 */
function gridCameras() {
  if (!activeView) return searchCameras(cameras, cameraQuery)
  const byKey = new Map(cameras.map((c) => [camKey(c), c]))
  return searchCameras(activeView.cameras.map((k) => byKey.get(k)).filter(Boolean), cameraQuery)
}

/** The grid's filters and page, for visibleCameras / diffCameras. A view carries its own set, so the
 *  site filter is left off while one is selected (it would only hide cameras the view names). The site
 *  dropdown's value is a site name, or "@nvr:<id>" for one NVR of a multi-NVR site (its submenu). */
function gridView(perPage = layoutCells(layoutSelect.value).cells.length) {
  const v = activeView ? '' : siteSelect.value
  const nvr = v.startsWith('@nvr:') ? v.slice(5) : ''
  return { site: nvr ? '' : v, nvr, hideOffline: hideOffline.checked, perPage, page }
}

/** The site dropdown's options: every site, and under a site with more than one NVR, an indented
 *  option per NVR (value "@nvr:<id>") so a reader can drill into just that NVR — the site submenu. */
function siteOptions(sites) {
  const bySite = new Map()
  for (const s of sites) { const k = s.site || ''; (bySite.get(k) ?? bySite.set(k, []).get(k)).push(s) }
  const out = [new Option('All sites', '')]
  for (const name of [...bySite.keys()].sort((a, b) => a.localeCompare(b))) {
    const list = bySite.get(name)
    if (list.length <= 1) { out.push(new Option(name, name)); continue }
    out.push(new Option(`${name} — all (${list.length})`, name)) // the whole site
    for (const n of list.slice().sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))) {
      out.push(new Option(` ${n.name}`, `@nvr:${n.id}`)) // one NVR of the site, indented
    }
  }
  return out
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
  // Auto prioritises camera quality; LiveTile falls back to SD if HD is refused
  // or the browser/server cannot play the main stream. Only visible tiles connect.
  const stream = layoutSelect.value === 'auto' ? MAIN_STREAM : SUB_STREAM
  slot.live = new LiveTile(tile, cam, stream, startDelayMs, tileOptions(cam))
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
      refreshTileName(slot.el, cam)
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
    if (!cam || !cam.online) {
      // the camera went away (removed or offline): the view goes
      closeSingle()
      return
    }
    // Live HD given or taken away: the view is built again, upgraded to the main stream or back on the
    // sub-stream with its SD badge (the server's sweep ends a main stream no longer allowed anyway)
    if (keep && Boolean(singleCam?.hd) === Boolean(cam.hd)) {
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
/**
 * The time zone the overlay is written in: the site's wall clock (minutes to add to UTC), sent by
 * /api/osd (server site-time.mjs). A viewing PC may be nowhere near the site and set to any zone —
 * one set to UTC drew UTC over the picture — so the overlay must not follow this browser. Until the
 * site offset has loaded, fall back to this browser's zone (the old behaviour) rather than UTC.
 */
let siteTzMin = null
const osdTzMs = () => (Number.isFinite(siteTzMin) ? siteTzMin : -new Date().getTimezoneOffset()) * 60_000

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
  if (Number.isFinite(data?.siteTzMin)) siteTzMin = data.siteTzMin
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
  onFirstFrame: refreshPictureLayout,
  pacing: PACING,
  clock: clockOptions(),
  maxQueuedFrames: REMOTE_PAGE ? REMOTE_QUEUED_FRAMES : undefined,
  // a level change (or a reconnect) that sends a tile an older picture than it showed: held, not shown
  // (player.js REMOTE_NO_REWIND_MS; stutter report 2.5). A local page has no levels, and stays as it was
  noRewindMs: REMOTE_PAGE ? REMOTE_NO_REWIND_MS : undefined,
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
  document.getElementById('livePager').hidden = pages <= 1 || single !== null
  const summary = document.getElementById('cameraSummary')
  const shown = shownCameras(gridCameras(), gridView())
  const onPage = visibleCameras(gridCameras(), gridView()).visible.length
  grid.dataset.empty = String(onPage === 0)
  const context = activeView?.name || siteSelect.selectedOptions[0]?.textContent.trim() || 'All sites'
  if (summary) {
    // how many are online and which are not, counted over this site or view whatever "Hide offline"
    // says (it hides them from the grid: the more reason to name them here)
    // (an empty channel slot on an NVR is not a camera: the server sends it as not online, and
    // counted here it read as hundreds of cameras offline)
    const all = realCameras()
    const off = all.filter((c) => c.online === false)
    const count = off.length ? `${all.length - off.length} of ${all.length} cameras online` : `${all.length} camera${all.length === 1 ? '' : 's'} online`
    // the number offline is a button: it lists them (showOffline)
    const key = `${context}|${all.length}|${off.map(camKey).join(',')}|${onPage}`
    if (summary.dataset.key !== key) {
      summary.dataset.key = key
      const parts = [`${context} · ${count}`]
      if (off.length) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'offline-count'
        b.textContent = `${off.length} offline`
        b.title = 'Show which cameras are offline'
        b.addEventListener('click', () => showOffline(realCameras().filter((c) => c.online === false), context))
        parts.push(' · ', b)
      }
      parts.push(` · ${onPage} on this page`)
      summary.replaceChildren(...parts)
    }
  }
  const note = document.getElementById('filterNote')
  note.hidden = shown.length > 0 || !cameraQuery
  note.textContent = `No cameras match “${cameraQuery}” in this view. Clear the search or select another site.`
  updateLiveState()
}

/** The cameras that are offline, by site, in a small dialog: what the header's "N offline" opens. */
/** The cameras of this site or view, offline ones too, without the NVRs' empty channel slots. */
function realCameras() {
  return shownCameras(gridCameras(), { ...gridView(), hideOffline: false }).filter((c) => c.configured !== false)
}

function showOffline(off, context) {
  let dlg = document.getElementById('offlineDlg')
  if (!dlg) {
    dlg = document.createElement('dialog')
    dlg.id = 'offlineDlg'
    dlg.className = 'wall-pick offline-dlg'
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() }) // (a click on the backdrop)
    document.body.append(dlg)
  }
  const head = document.createElement('h3')
  head.textContent = `${off.length} camera${off.length === 1 ? '' : 's'} offline · ${context}`
  const bySite = new Map()
  for (const c of off) (bySite.get(c.site || c.nvrName || '') ?? bySite.set(c.site || c.nvrName || '', []).get(c.site || c.nvrName || '')).push(c)
  const body = document.createElement('div')
  body.className = 'offline-list'
  for (const [site, cams] of [...bySite].sort((a, b) => a[0].localeCompare(b[0]))) {
    const h = document.createElement('h4')
    h.textContent = `${site} (${cams.length})`
    const ul = document.createElement('ul')
    for (const c of cams) {
      const li = document.createElement('li')
      li.textContent = `${c.ch + 1} · ${c.name}${c.nvrName && c.nvrName !== site ? ` — ${c.nvrName}` : ''}`
      ul.append(li)
    }
    body.append(h, ul)
  }
  if (!off.length) body.textContent = 'Every camera is online.'
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = 'Close'
  close.addEventListener('click', () => dlg.close())
  dlg.replaceChildren(head, body, close)
  if (!dlg.open) dlg.showModal()
}

function updateLiveState() {
  const occupied = gridSlots.filter((s) => s.cam)
  const live = occupied.filter((s) => s.el.querySelector('.status')?.classList.contains('live')).length
  const offline = occupied.filter((s) => !s.cam.online).length
  const waiting = occupied.length - live - offline
  const label = occupied.length ? [`${live} live`, waiting ? `${waiting} waiting` : '', offline ? `${offline} offline` : ''].filter(Boolean).join(' · ') : 'No cameras'
  const state = document.getElementById('liveState')
  if (state.textContent !== label) state.textContent = label
  state.classList.toggle('all-live', live > 0 && live === occupied.length)
}
// ---- how much of the video this screen is actually showing ----
// Of the frames that arrive for the tiles on screen, the share drawn, over the last 10 s: the one
// number that says whether this device keeps up with this layout (a 36-tile grid drew 72-80% on the
// viewing PC, a 100-tile one 8%, 2026-10-09). Shown beside the connection summary from four tiles
// up, green from 90%, amber from 70%, red below; the measurements behind it are in its tooltip.
let wallProfile = null // this device's measured layouts (wall-profile.js), read when first needed
let wallTol = TOLERANCE // the administrator's, once read (wall-tolerance.mjs); the owner's defaults until then
let wallProfileSavedAt = 0
const storageOrNull = () => { try { return globalThis.localStorage } catch { return null } }
const wallWindow = [] // one entry a second: { n, arrived, decoded, drawn, held }
function updateWallHealth() {
  let el = document.getElementById('wallHealth')
  if (!el) {
    el = document.createElement('span')
    el.id = 'wallHealth'
    el.className = 'live-state wall-health'
    el.hidden = true
    document.getElementById('liveState').before(el)
  }
  if (document.hidden) return // (a hidden page draws nothing: that is not the device falling behind)
  const playing = tiles.filter((x) => !x.closed && !x.suspended && x.player?.firstPainted === true)
  // (judged on the tiles at full rate while some are shown from keyframes only)
  const low = playing.filter((x) => x.player.keysOnly || x.player.afterThin).length
  const fullRate = playing.filter((x) => !x.player.keysOnly && !x.player.afterThin)
  const sum = (k) => fullRate.reduce((a, x) => a + (Number(x.player.stats?.[k]) || 0), 0)
  wallWindow.push({ n: playing.length, low, arrived: sum('arrived'), decoded: sum('decoded'), drawn: sum('fps'), held: fullRate.reduce((a, x) => Math.max(a, Number(x.player.stats?.decodeMs) || 0), 0) })
  if (wallWindow.length > 10) wallWindow.shift()
  const full = wallWindow.filter((w) => w.n === playing.length && w.low === low) // (a layout or the thinning just changed: only its own seconds)
  const arrived = full.reduce((a, w) => a + w.arrived, 0)
  if (playing.length < 4 || full.length < 5 || !(arrived > 0)) { el.hidden = true; return }
  const drawn = full.reduce((a, w) => a + w.drawn, 0)
  const decoded = full.reduce((a, w) => a + w.decoded, 0)
  const share = Math.min(1, drawn / arrived)
  const per = (x) => (x / full.length / Math.max(1, playing.length - low)).toFixed(1)
  const label = low ? `${playing.length - low} of ${playing.length} at full rate · ${Math.round(share * 100)}% of their frames shown` : `${Math.round(share * 100)}% of frames shown`
  if (el.textContent !== label) el.textContent = label
  // (some shown from keyframes only: amber at best, this layout is more than the device can play in full)
  const level = statusOf(share, wallTol)
  el.dataset.level = level === 'ok' && low ? 'warn' : level
  el.title = `Last ${full.length} s, ${playing.length} cameras playing. Each second, per camera: ${per(arrived)} frames arrive, ${per(decoded)} are decoded, ${per(drawn)} are drawn. The decoder held a frame up to ${Math.round(Math.max(...full.map((w) => w.held)))} ms.${low ? ` This screen cannot decode every camera in this layout: the ${playing.length - low} busiest play every frame, the other ${low} show a current picture every few seconds.` : level !== 'ok' ? ' This screen is not keeping up with this layout: a smaller layout will be smoother.' : ''}`
  // into this device's profile, kept every 15 s; the layout picker says what it has seen
  wallProfile ??= readProfile(storageOrNull())
  wallProfile = noteSecond(wallProfile, playing.length, share, { thinned: low > 0 })
  if (Date.now() - wallProfileSavedAt > 15_000) {
    wallProfileSavedAt = Date.now()
    saveProfile(storageOrNull(), wallProfile)
    markLayouts()
  }
  el.hidden = false
}
setInterval(() => { try { updateWallHealth() } catch {} }, 1000)

// ---- a wall this device cannot decode in full: the busiest tiles keep every frame (wall-thin.js) ----
// On unless this browser was told otherwise: localStorage 'argus.wallThin' = 'off' leaves every tile
// at full rate, as before.
const THIN_START_FPS = 25 // what a tile is taken to cost before it has been measured
let thin = thinStart()
const thinSeen = new Map() // camera -> { player, since, fullSince, arrived, decoded, bytes, fps, dec, kbps }
let thinAt = 0
const wallThinOn = () => { try { return localStorage.getItem('argus.wallThin') !== 'off' } catch { return true } }
function updateWallThin() {
  if (document.hidden) return
  const now = performance.now()
  const playing = tiles.filter((x) => !x.closed && !x.suspended && gridTiles.includes(x) && x.player?.firstPainted === true)
  if (single !== null || playing.length < THIN_MIN_TILES || !wallThinOn()) {
    // (a smaller grid, a camera opened full-size, or switched off: everything at full rate again)
    thin = thinStart()
    thinSeen.clear()
    thinAt = 0
    for (const x of tiles) if (x.player?.keysOnly) x.player.setKeysOnly(false)
    return
  }
  // rates over the time since the last look, from the players' running totals: a one-second figure
  // read every 2 s catches the same half of each keyframe interval every time
  const dt = now - thinAt
  const fresh = !(thinAt > 0) || dt > 5000 // the first look, or the page was away: only take the totals down
  thinAt = now
  const rows = []
  const here = new Set()
  for (const x of playing) {
    const key = camKey(x)
    const tot = x.player.totals
    here.add(key)
    const s = thinSeen.get(key)
    if (!s || s.player !== x.player) {
      // (new here, or its player was made again: measured from the next look)
      thinSeen.set(key, { player: x.player, since: now, fullSince: now, arrived: tot.arrived, decoded: tot.decoded, bytes: tot.bytes, fps: 0, dec: 0, kbps: null })
      continue
    }
    if (!fresh) {
      const sec = dt / 1000
      const kbps = ((tot.bytes - s.bytes) * 8) / 1000 / sec
      s.fps = (tot.arrived - s.arrived) / sec
      s.dec = (tot.decoded - s.decoded) / sec
      s.kbps = s.kbps === null ? kbps : (s.kbps + kbps) / 2
    }
    s.arrived = tot.arrived
    s.decoded = tot.decoded
    s.bytes = tot.bytes
    rows.push({ x, key, s })
  }
  for (const k of thinSeen.keys()) if (!here.has(k)) thinSeen.delete(k)
  if (fresh) {
    // A wall this screen is known not to manage in full starts shared out, instead of overloaded for
    // its first ten seconds while that is found out again (wall-profile.js knownCapacity). The first
    // tiles in order keep every frame until the next looks say which are busiest.
    wallProfile ??= readProfile(storageOrNull())
    const cap = knownCapacity(wallProfile)
    if (cap && thin.budget === Infinity && playing.length * THIN_START_FPS > cap) {
      thin = { ...thinStart(), budget: cap, changedAt: now }
      let spent = 0
      for (const x of playing) {
        spent += THIN_START_FPS
        x.player.setKeysOnly(spent > cap)
      }
    }
    return
  }
  if (rows.length === 0) return
  // keeping up is judged on tiles that have played at full rate long enough to have caught up
  const settled = rows.filter(({ x, s }) => !x.player.keysOnly && !x.player.afterThin && now - s.since >= THIN_SETTLE_MS && now - s.fullSince >= THIN_SETTLE_MS)
  const held = settled.map(({ x }) => Number(x.player.stats?.decodeMs) || 0).sort((p, q) => q - p)
  thin = nextBudget(thin, {
    now,
    fed: settled.reduce((n, r) => n + r.s.fps, 0),
    decoded: settled.reduce((n, r) => n + r.s.dec, 0),
    heldMs: held[Math.floor(held.length * 0.2)] ?? 0, // (a figure a fifth of them reach: one stalled link is not the device)
    all: rows.reduce((n, r) => n + r.s.fps, 0),
    capacity: rows.reduce((n, r) => n + r.s.dec, 0)
  })
  // what it settles at is kept as this screen's capacity, for the next wall's start
  if (Number.isFinite(thin.budget) && thin.okSince !== null && now - thin.changedAt > 15_000) wallProfile = noteCapacity(wallProfile ?? readProfile(storageOrNull()), thin.budget)
  // never thinned: a camera whose keyframes are far apart would look frozen (one whose spacing is
  // not known yet is given 10 s to show two keyframes before it is taken for such a camera)
  const fixed = (r) => r.x.player.keyEveryMs > THIN_MAX_KEY_MS || (!(r.x.player.keyEveryMs > 0) && now - r.s.since > 10_000)
  const left = thin.budget - rows.filter(fixed).reduce((n, r) => n + r.s.fps, 0)
  const keep = fullRateTiles(rows.filter((r) => !fixed(r)).map(({ x, key, s }) => ({ key, fps: s.fps, kbps: s.kbps ?? 0, full: !x.player.keysOnly })), left)
  for (const r of rows) {
    const { x, key, s } = r
    const full = fixed(r) || keep.has(key)
    if (full && x.player.keysOnly) s.fullSince = now
    x.player.setKeysOnly(!full)
  }
}
setInterval(() => { try { updateWallThin() } catch {} }, 2000)

let stateFrame = null
new MutationObserver(() => {
  if (stateFrame !== null) return
  stateFrame = requestAnimationFrame(() => { stateFrame = null; updateLiveState() })
}).observe(grid, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })

function applyCameraSearch() {
  cameraQuery = cameraSearch.value.trim()
  document.getElementById('clearCameraSearch').hidden = !cameraSearch.value
  page = 0
  if (single !== null) closeSingle()
  relayout()
}
let searchTimer = null
cameraSearch.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(applyCameraSearch, 150) })
document.getElementById('clearCameraSearch').addEventListener('click', () => {
  clearTimeout(searchTimer)
  cameraSearch.value = ''
  applyCameraSearch()
  cameraSearch.focus()
})
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest('input, textarea, select, [contenteditable], dialog')) { e.preventDefault(); cameraSearch.focus() }
})
const viewOptions = document.querySelector('.live-options')
document.addEventListener('pointerdown', (e) => { if (!viewOptions.contains(e.target)) viewOptions.open = false })
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && viewOptions.open) { viewOptions.open = false; viewOptions.querySelector('summary').focus() }
})

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
      // no frame rate: each picture the tile paints becomes the video's next frame. At 15 the video
      // sampled the canvas every 67 ms, and a 20 fps camera judders again (stutter report 2.8)
      video.srcObject = cv.captureStream()
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
  const list = shownCameras(gridCameras(), gridView())
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

// ...and its full quality at once too. The cameras either side are started ahead on their sub-streams
// only, so a step showed the next camera at once but in SD: its main stream was asked for a second
// later (UPGRADE_DELAY_MS) and then had to start on the NVR. Once the view has settled on a camera
// whose own main stream is showing, the main stream of the camera a step further on -- the way the
// viewer last stepped -- is started as well, connected but not decoded, and a step to it borrows it.
// One at most, and only where it costs nothing but a second stream on the local network: a PC there
// whose browser plays H.265, a camera on a local NVR. A phone's or a remote viewer's main streams,
// and any for a browser without H.265, are converted by the server, which converts few at once; a
// P2P or VPN camera's main stream rides the same slow link as the one being watched.
const AHEAD_MAIN_MS = 1500 // on a camera this long at full quality before the next one's is started
let aheadMain = null // { key, tile }: the one main stream started ahead
let aheadMainTimer = null
let stepDir = 1 // the way the viewer last stepped (stepCamera): which neighbour is "the next"
let onLan = false // this browser reaches the server on the local network (/api/me), not by tunnel or VPN
window.cctvAheadMain = () => (aheadMain ? { k: aheadMain.key, ws: aheadMain.tile.ws?.readyState ?? null, gopKB: Math.round(aheadMain.tile.gopBytes / 1024), lendable: aheadMain.tile.lendable } : null)
const mayStartMainAhead = (c) => onLan && !isPhone() && !cannotPlayH265() && c.online !== false && c.hd !== false && c.remote !== true && !noMain.has(camKey(c))
/** Starts the main stream of the camera a step on from this one (see above), and lets any other go. */
function startAheadMain(cam, { onServer = false } = {}) {
  const list = shownCameras(gridCameras(), gridView())
  const i = list.findIndex((c) => camKey(c) === camKey(cam))
  const next = i >= 0 && list.length > 1 ? list[(i + stepDir + list.length) % list.length] : null
  const k = next ? camKey(next) : null
  if (aheadMain && aheadMain.key === k && !aheadMain.tile.closed) return
  stopAheadMain()
  if (!next || k === camKey(cam)) return
  // Everyone else (a phone, a viewer through the tunnel or the VPN, a browser without H.265) has the
  // server keep that stream running instead, sent to nobody (stream-holds.mjs): when they step to it
  // the NVR does not have to start it, and it costs their link and the server's conversions nothing.
  if (onServer || !mayStartMainAhead(next)) return holdAhead(next)
  const el = document.createElement('div')
  el.className = 'tile'
  el.innerHTML = TILE_HTML
  // Refused, dropped, or not the camera's own stream after all: it is let go, not asked for again
  // and again behind the viewer's back. The next view to settle asks afresh. (After this turn: the
  // tile is still inside its own close handler.)
  // Handed over to a view by then (aheadMain no longer names it): it is closed all the same, and the
  // layer that was borrowing it connects by itself (live-tile.js). Left to reconnect, it came back
  // beside that layer's own connection: the camera on screen with two main streams.
  const drop = () => queueMicrotask(() => { if (aheadMain?.tile === t) stopAheadMain(); else t.close() })
  const t = new LiveTile(el, next, MAIN_STREAM, 0, {
    ...tileOptions(next),
    noStill: true,
    onDisconnect: drop,
    onUnsupported: drop,
    onHdRefused: () => (drop(), true),
    onMainNotConverted: () => (drop(), true)
  })
  t.suspend()
  aheadMain = { key: k, tile: t }
}
function stopAheadMain() {
  clearTimeout(aheadMainTimer)
  aheadMainTimer = null
  clearInterval(holdTimer)
  holdTimer = null
  aheadMain?.tile.close()
  aheadMain = null
}
// A hold lasts 20 s on the server and is asked for again while this camera is still the one expected
// (stream-holds.mjs HOLD_MS); stopAheadMain ends the asking, and the hold then ends by itself. A
// server that will not hold it (too many held, the NVR busy, an older server) is not asked again.
const HOLD_AGAIN_MS = 12_000
let holdTimer = null
function holdAhead(c) {
  if (c.online === false || c.hd === false || c.remote === true || noMain.has(camKey(c))) return
  const ask = () => fetch('/api/live/hold', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nvr: c.nvr, ch: c.ch }) })
    .then((r) => (r.ok ? r.json() : null))
    .then((a) => { if (a?.held !== true) { clearInterval(holdTimer); holdTimer = null } })
    .catch(() => {})
  ask()
  holdTimer = setInterval(() => { if (!document.hidden) ask() }, HOLD_AGAIN_MS)
}
/** The main stream started ahead for this camera, handed over to its view; any other is let go. */
function takeAheadMain(cam) {
  const t = aheadMain?.key === camKey(cam) && !aheadMain.tile.closed ? aheadMain.tile : null
  if (t) aheadMain = null
  stopAheadMain()
  return t
}

// ---- linked cameras: one click to the camera a person walks to next (camera-links.mjs) ----
// The links an administrator drew on the map; where none were drawn for this camera, the two
// nearest on its map, marked as a guess. Read once and kept five minutes.
let camLinks = null
let camLinksAt = 0
async function cameraLinks() {
  if (camLinks && Date.now() - camLinksAt < 5 * 60_000) return camLinks
  try {
    const r = await fetch('/api/camera-links')
    if (r.ok) { camLinks = await r.json(); camLinksAt = Date.now() }
  } catch {}
  return camLinks
}
function linkedCameras(cam, host) {
  const key = `${cam.nvr}/${cam.ch}`
  cameraLinks().then((d) => {
    if (!d || !host.isConnected) return // (the view was closed or moved on while the links were read)
    const drawn = d.links?.[key] ?? []
    const list = drawn.length ? drawn : (d.suggestions?.[key] ?? []).slice(0, 2)
    const byKey = new Map(cameras.map((c) => [`${c.nvr}/${c.ch}`, c]))
    for (const n of list.slice(0, 4)) {
      const to = byKey.get(n.to)
      if (!to || to.online === false || to.configured === false) continue
      const b = document.createElement('button')
      b.type = 'button'
      b.className = drawn.length ? 'cam-link' : 'cam-link suggested'
      b.textContent = `→ ${n.label || to.name}`
      b.title = drawn.length ? `Go to ${to.name}` : `Nearest on the map: ${to.name}`
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        openSingle(to, { stepping: true })
      })
      host.append(b)
    }
  })
}

function openSingle(cam, { fromTap = false, stepping = false } = {}) {
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
  telemetry.event(stepping ? 'step' : 'open', { nvr: cam.nvr, ch: cam.ch, dir: stepping ? stepDir : undefined })
  // free the grid's streams while watching one camera: suspend alone leaves them flowing (frames only
  // dropped at the client), so on a tunnel 25-64 grid streams kept competing with the full-size view.
  // Keep the one it borrows (the lender, lenderFor); release the rest, which reconnect on return.
  const lender = gridTiles.find((t) => t.nvr === cam.nvr && t.ch === cam.ch && t.streamType === SUB_STREAM && t.lendable)
  for (const t of gridTiles) { if (t === lender) t.suspend(); else t.release() }
  pageNote?.remove() // (the note of a page just turned would sit on top of the view)
  overlay = makeTile(cam, { controls: false })
  overlay.classList.add('single', 'single-overlay')
  // links sit next to the name (not in it): a long name is cut short, the links never are
  const links = document.createElement('span')
  links.className = 'links'
  // a tap anywhere in the controls strip (on a button or the gap beside one) must not fall through to
  // the view's close-on-tap: near-misses at the bottom edge were closing the camera (map/viewer).
  links.addEventListener('click', (e) => e.stopPropagation())
  // Recordings only for someone who may play this camera back (/api/cameras playback)
  if (cam.playback !== false) {
    const link = document.createElement('a')
    link.className = 'pb-link'
    link.href = `/playback.html?nvr=${encodeURIComponent(cam.nvr)}&ch=${cam.ch}`
    link.textContent = 'Recordings'
    link.addEventListener('click', (e) => e.stopPropagation())
    links.append(link)
  }
  linkedCameras(cam, links)
  overlay.querySelector('.name').after(links)
  if (isPhone()) overlay.append(nativeFullButton(overlay))
  overlay.append(...stepArrows()) // ‹ › on every screen (keys: ← →)
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'single-close'
  close.textContent = 'Close'
  close.setAttribute('aria-label', 'Close camera')
  close.addEventListener('click', (e) => { e.stopPropagation(); closeSingle() })
  overlay.append(close)
  // closing the view discards the panel's unsent changes: ask first
  overlay.addEventListener('click', () => closeSingle())
  // zoom: the wheel, a pinch, drag to pan, double-click / double-tap back (pinch-zoom.js). Only the
  // pictures move (style.css .single-overlay canvas); the name, the badge and the buttons stay put.
  // While zoomed a tap does not close the view and a flick does not change camera.
  const view = overlay
  overlayZoom = attachZoom(view, {
    // paused while the Lines or OSD panel is open: a drag there draws/places on the whole picture
    busy: () => false,
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
  for (const slot of gridSlots) slot.el.inert = true
  close.focus({ preventScroll: true })
  // inside the tap itself: a browser allows full screen only in answer to one
  if (fromTap) enterPhoneFull()
  const opts = tileOptions(cam)
  const sub = new LiveTile(overlay, cam, SUB_STREAM, 0, { ...opts, borrowFrom: lenderFor(cam) })
  singleTiles.push(sub)
  startAhead(cam)
  // full screen at full quality (the main stream) with Live HD on the camera (/api/cameras hd; the
  // server refuses it anyway); a browser that could not play this main stream stays on the sub
  // stream. A P2P/VPN camera's main stream is asked for too, also by a viewer coming in over the
  // internet (since 2026-10-08, at the owner's wish: it used not to be, because that stream rides the
  // camera's relay and then the tunnel, and can take a long while to come). The sub-stream stays on
  // screen until the main one has a picture, so asking costs the viewer nothing but the wait.
  const warm = takeAheadMain(cam) // its main stream, when it was started ahead (aheadMain)
  if (cam.hd !== false && !noMain.has(single)) {
    // the sub-stream shows at once; the HD is asked for almost immediately on a direct open, but only
    // once the view settles while stepping (UPGRADE_DELAY_MS), so stepping does not churn main streams.
    // One started ahead is here already: shown now, with nothing to churn.
    const o = overlay
    if (warm) upgradeToMain(overlay, cam, sub, opts, warm)
    else upgradeTimer = setTimeout(() => {
      upgradeTimer = null
      if (overlay === o && !sub.closed) upgradeToMain(overlay, cam, sub, opts)
    }, stepping ? UPGRADE_DELAY_MS : QUICK_UPGRADE_MS)
  } else {
    warm?.close()
    if (cam.hd === false) overlay.querySelector('.name').after(sdBadge())
  }
  syncTiles()
  updatePager()
}

/** Back to the grid: the grid tiles pick up again straight away. */
function closeSingle({ resumeGrid = true, keep = null } = {}) {
  const returnKey = single
  const restoreFocus = Boolean(overlay?.contains(document.activeElement))
  if (upgradeTimer) { clearTimeout(upgradeTimer); upgradeTimer = null } // a pending HD upgrade is cancelled
  // ...and so is starting the next camera's main stream ahead; one started already stays for the
  // camera being stepped to (openSingle takes it, or lets it go)
  clearTimeout(aheadMainTimer)
  aheadMainTimer = null
  overlayZoom = null
  for (const t of singleTiles) if (t !== keep) t.close()
  singleTiles = []
  overlay?.remove()
  overlay = null
  for (const slot of gridSlots) slot.el.inert = false
  if (!resumeGrid) return
  stopAhead()
  stopAheadMain()
  leavePhoneFull()
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
  if (restoreFocus) gridSlots.find((s) => s.cam && camKey(s.cam) === returnKey)?.el.querySelector('.tile-open')?.focus({ preventScroll: true })
}

/**
 * The full-size view's note that it stays on the sub-stream for now: the server did not convert the
 * main one for this browser (live-tile.js mainNotConvertedTitle). The SD badge's look, nothing over
 * the picture; it goes when the main stream's picture comes.
 */
function hdBusyBadge(why) {
  const b = sdBadge()
  b.classList.add('hd-busy')
  b.title = mainNotConvertedTitle(why)
  return b
}

/** The full-size view's note that it stays on the sub-stream: no Live HD on this camera. */
function sdBadge() {
  const b = document.createElement('span')
  b.className = 'sd-badge'
  b.textContent = 'SD'
  b.title = 'Full screen at full quality needs Live HD on this camera'
  return b
}

/** warm: this camera's main stream, started ahead (aheadMain): the layer shows that instead of its own. */
function upgradeToMain(tile, cam, sub, opts, warm = null) {
  const layer = document.createElement('div')
  // full size but invisible until its first frame (a hidden element would give the canvas no size)
  layer.className = 'tile-upgrade pending'
  layer.innerHTML = TILE_HTML
  layer.querySelector('.name').textContent = tile.querySelector('.name').firstChild?.textContent ?? ''
  tile.append(layer)
  const main = new LiveTile(layer, cam, MAIN_STREAM, 0, {
    ...opts,
    noStill: true, // the sub-stream below it already shows the still
    borrowFrom: warm,
    // the layer has stopped showing the stream started ahead (that one stalled or ended and the layer
    // connected by itself; the layer was closed, or is asking for H.264 instead): it has no other use
    onUnborrow: (src) => {
      if (src !== warm) return
      warm.close()
      singleTiles = singleTiles.filter((t) => t !== warm)
    },
    onFirstFrame: () => {
      layer.classList.remove('pending')
      for (const b of tile.querySelectorAll('.hd-busy')) b.remove()
      // (the links are in the view's own label, or in the layer this one replaces: onMainNotConverted)
      const links = tile.querySelector(':scope > .label .links') ?? sub.tile.querySelector('.links')
      if (links) layer.querySelector('.name').after(links)
      // the sub-stream's LIVE badge goes with it: it sits above the layer, and where the two do not
      // line up exactly (an iPhone turned sideways) the view showed LIVE twice
      tile.querySelector(':scope > .status')?.remove()
      sub.close()
      if (sub.tile !== tile) sub.tile.remove() // an earlier layer that had gone over to the sub-stream
      // one started ahead that had nothing kept to lend (too long a stretch since its keyframe) only
      // kept the stream running on the server until this layer's own connection had it: done
      if (warm && main.source !== warm) {
        warm.close()
        singleTiles = singleTiles.filter((t) => t !== warm)
      }
      // settled here at full quality, and it is the camera's own stream, not a conversion: the main
      // stream of the camera a step on is started ahead (aheadMain)
      clearTimeout(aheadMainTimer)
      aheadMainTimer = setTimeout(() => {
        aheadMainTimer = null
        // (not in a hidden tab: the first picture is painted there too, and nothing would close it)
        // (a conversion on screen: the next one would be another, so the server holds it instead)
        if (overlay === tile && !main.closed && !document.hidden) startAheadMain(cam, { onServer: main.converted === true })
      }, AHEAD_MAIN_MS)
    },
    onUnsupported: () => {
      rememberNoMain(camKey(cam))
      main.close()
      layer.remove()
    },
    // refused for want of Live HD before it showed anything: this layer goes, the sub-stream under it
    // stays; once shown (its sub-stream closed), the tile goes over to the sub-stream itself (live-tile.js)
    onHdRefused: () => {
      if (!layer.classList.contains('pending')) return false
      main.close()
      layer.remove()
      return true
    },
    // An H.265 main the server did not convert for this browser (no room among the few it converts
    // at once, or it failed): the view stays on the sub-stream, quietly, with a small mark that says
    // why, and the main stream is asked for again every H264_RETRY_MS while the view is open. Not
    // shown yet: this layer goes and the sub-stream under it stays. Shown already (its conversion
    // ended under it): the tile goes over to the sub-stream itself (live-tile.js), and the next try
    // layers over that.
    onMainNotConverted: (why) => {
      const pending = layer.classList.contains('pending')
      if (pending) {
        main.close()
        layer.remove()
        singleTiles = singleTiles.filter((t) => t !== main)
      }
      const under = pending ? sub : main
      for (const b of tile.querySelectorAll('.hd-busy')) b.remove()
      under.tile.querySelector('.name')?.after(hdBusyBadge(why))
      clearTimeout(upgradeTimer)
      upgradeTimer = setTimeout(() => {
        upgradeTimer = null
        if (overlay === tile && !under.closed) upgradeToMain(tile, cam, under, opts)
      }, H264_RETRY_MS)
      return pending
    }
  })
  singleTiles.push(main)
  if (warm) singleTiles.push(warm) // the view's own now: closed with it
  // among the page's tiles from now on: a tab hidden for a while closes them, and this one was left
  // out (added after the list was made), so a main stream nobody could see kept running
  syncTiles()
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
  const { size, rows = size, cells } = layoutCells(layoutSelect.value)
  const perPage = cells.length
  const v = visibleCameras(gridCameras(), gridView(perPage))
  if (v.page !== page) return render({ keepSingle: true })
  grid.style.gridTemplateColumns = `repeat(${size}, 1fr)`
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`
  grid.dataset.size = String(size)
  const before = [overlay].find((n) => n?.parentNode === grid) ?? null
  const keys = cells.map((_, i) => (v.visible[i] ? camKey(v.visible[i]) : null))
  const { from, unused } = reuseSlots(gridSlots.map((s) => (s.cam ? camKey(s.cam) : null)), keys)
  const leaving = unused.map((i) => gridSlots[i])
  for (const s of leaving) {
    s.live?.close()
    inView?.unobserve(s.el) // phone list: stop watching the element before it leaves the DOM (no leak)
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
      } else if (tileLabel(was) !== tileLabel(s.cam)) refreshTileName(s.el, s.cam) // (name or site)
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

let cameraToMove = null
function showMoveCamera(cam) {
  cameraToMove = camKey(cam)
  const select = document.getElementById('moveCameraTarget')
  select.replaceChildren(...shownCameras(gridCameras(), gridView()).filter((c) => camKey(c) !== cameraToMove).map((c) => new Option(tileLabel(c), camKey(c))))
  document.getElementById('moveCameraName').textContent = tileLabel(cam)
  document.getElementById('moveCameraApply').disabled = !select.options.length
  document.getElementById('moveCameraDlg').showModal()
}
document.getElementById('moveCameraApply').addEventListener('click', () => {
  const target = document.getElementById('moveCameraTarget').value
  const valid = shownCameras(gridCameras(), gridView()).map(camKey)
  if (valid.includes(cameraToMove) && valid.includes(target)) sync.change(swapOp(cameraToMove, target))
  document.getElementById('moveCameraDlg').close()
})
let resizeFrame = null
new ResizeObserver(() => {
  if (layoutSelect.value !== 'auto' || !gridSlots.length || document.hidden) return
  cancelAnimationFrame(resizeFrame)
  resizeFrame = requestAnimationFrame(() => relayout())
}).observe(grid)

/** A tile dropped onto another tile (they swap places) or onto a pager arrow (first place of that page). */
function dropTile(dragged, target) {
  const cam = gridSlots.find((s) => s.el === dragged)?.cam
  // (gone meanwhile: the grid was rebuilt by a camera-list refresh)
  if (!cam || single !== null) return
  if (target === prevBtn || target === nextBtn) {
    const perPage = layoutCells(layoutSelect.value).cells.length
    sync.change(moveOp(camKey(cam), page + (target === nextBtn ? 1 : -1), perPage, shownCameras(gridCameras(), gridView(perPage))))
    return
  }
  const other = gridSlots.find((s) => s.el === target)?.cam
  if (other) sync.change(swapOp(sync.order, camKey(cam), camKey(other), serverList))
}

const drag = enableGridDrag(grid, {
  // the grid's tiles with a camera (offline ones too); not while the full-size view is open, and not
  // while a saved view is shown (the view fixes its own order — change it by re-saving the view)
  tileOf: (el) => (single === null && !activeView ? (gridSlots.find((s) => s.cam && s.el.contains(el))?.el ?? null) : null),
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
  smoothBox.checked = preferenceStorage.getItem('cctv.smooth') === '1'
} catch {}
smoothBox.addEventListener('change', () => {
  preferenceStorage.setItem('cctv.smooth', smoothBox.checked ? '1' : '0')
  render()
})

// A phone has room for one camera, or four: the other layouts are taken off its menu, and it keeps
// its own choice (a PC's 4 x 4 must not follow the same user onto a phone). Not Auto: its tiles ask
// for the main stream, and each main stream a phone watches is converted by the server.
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
  const saved = preferenceStorage.getItem(LAYOUT_KEY)
  if (saved && LAYOUTS[saved] && (!isPhone() || PHONE_LAYOUTS.includes(saved))) layoutSelect.value = saved
} catch {}
markPhoneLayout()
/** Beside each layout this screen has played for a while: the share of frames it drew there. */
function markLayouts() {
  wallProfile ??= readProfile(storageOrNull())
  for (const o of layoutSelect.querySelectorAll('option')) {
    if (!LAYOUTS[o.value] || LAYOUTS[o.value].list || o.value === 'auto') continue
    o.dataset.base ??= o.textContent
    const note = profileNote(wallProfile, layoutCells(o.value).cells.length, { tol: wallTol })
    const text = note ? `${o.dataset.base} · ${note.short}` : o.dataset.base
    if (o.textContent !== text) o.textContent = text
    o.title = note ? note.long : ''
  }
}
/** Choosing a layout this screen handled badly says so, once a visit for each. It never stops anyone. */
const layoutWarned = new Set()
function warnLayout() {
  const note = profileNote(wallProfile ?? readProfile(storageOrNull()), layoutCells(layoutSelect.value).cells.length, { tol: wallTol })
  if (!note || note.status === 'ok' || layoutWarned.has(layoutSelect.value)) return
  layoutWarned.add(layoutSelect.value)
  const el = document.createElement('div')
  el.className = 'page-note layout-note'
  el.setAttribute('role', 'status')
  el.textContent = note.long
  const host = document.getElementById('layoutNote') ?? grid // (where the page's other layout note goes)
  host.after(el)
  setTimeout(() => el.remove(), 7000)
}
try { markLayouts() } catch {}

// ---- the administrator's tolerance for a wall (wall-tolerance.mjs) ----
// Read once for everyone; an administrator can change it in View options. A server without it
// (an older one) leaves the owner's defaults in place.
async function wallToleranceSetup(isAdmin) {
  try {
    const r = await fetch('/api/wall-tolerance')
    const t = r.ok ? await r.json() : null
    if (t && t.okShare > t.poorShare) wallTol = { okShare: t.okShare, poorShare: t.poorShare }
    else if (!r.ok) return // (no such route: nothing to set either)
  } catch {
    return
  }
  markLayouts()
  const panel = document.querySelector('.live-options-panel')
  if (!isAdmin || !panel || panel.querySelector('.wall-tol')) return
  const num = (value, title) => {
    const i = document.createElement('input')
    i.type = 'number'
    i.min = '10'
    i.max = '100'
    i.step = '1'
    i.value = String(Math.round(value * 100))
    i.title = title
    return i
  }
  const fine = num(wallTol.okShare, 'A wall drawing at least this share of its frames is fine')
  const poor = num(wallTol.poorShare, 'Below this share a wall is poor; between the two it is below recommended')
  const save = document.createElement('button')
  save.type = 'button'
  save.textContent = 'Save'
  const said = document.createElement('span')
  said.setAttribute('role', 'status')
  const box = document.createElement('label')
  box.className = 'wall-tol'
  box.title = 'What counts as an acceptable wall, for everyone. It warns; it never stops a layout being used.'
  box.append('Wall fine from ', fine, '% of frames shown, poor below ', poor, '% ', save, ' ', said)
  save.addEventListener('click', async () => {
    said.textContent = 'Saving…'
    try {
      const r = await fetch('/api/admin/wall-tolerance', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ okShare: Number(fine.value) / 100, poorShare: Number(poor.value) / 100 }) })
      const t = await r.json().catch(() => null)
      if (!r.ok) { said.textContent = t?.error ?? 'Not saved'; return }
      wallTol = { okShare: t.okShare, poorShare: t.poorShare }
      said.textContent = 'Saved'
      markLayouts()
    } catch {
      said.textContent = 'Not saved: the server did not answer'
    }
  })
  panel.append(box)
}

layoutSelect.addEventListener('change', () => {
  try { warnLayout() } catch {}
  page = 0
  markPhoneLayout()
  preferenceStorage.setItem(LAYOUT_KEY, layoutSelect.value)
  freshenForPageChange() // the cameras on the page change: drop a big grid's backlog (like the pager)
  render({ keepSingle: true })
})
// A PC whose browser cannot play H.265 gets no grid of more than 16 tiles (grid-view.js: each H.265
// camera on it is converted by the server). The page can learn it at any time: the check answers a
// moment after the page loads, and a decoder can refuse an H.265 keyframe much later (live-tile.js),
// so it is asked now and then again every second. From then on the larger layouts are off the menu,
// a larger one on screen becomes 4 x 4, and a note says why. The layout this PC last chose is left as
// it was stored: only choosing one stores it. Not a phone: it has its own short menu above.
const layoutNote = document.getElementById('layoutNote')
// Auto caps itself when the codec result arrives, so it remains offered at every camera count.
const LAYOUT_TILES = Object.fromEntries(Object.keys(LAYOUTS).map((id) => [id, id === 'auto' ? 1 : layoutCells(id).cells.length]))
/** The layout to show for one asked for (a saved view's): cut to 4 x 4 on such a PC, and said. */
function layoutOnThisPc(wanted) {
  const { layout, limited } = layoutShown(wanted, LAYOUT_TILES, { noH265: noH265Limit })
  if (limited && layoutNote) {
    layoutNote.textContent = NO_H265_NOTE
    layoutNote.hidden = false
  }
  return layout
}
function limitForNoH265({ draw = true } = {}) {
  if (noH265Limit || !cannotPlayH265()) return
  noH265Limit = true
  clearInterval(noH265Timer)
  const wanted = layoutSelect.value // read first: removing the chosen option changes it
  const offered = layoutsOffered(LAYOUT_TILES, { noH265: true })
  for (const o of [...layoutSelect.querySelectorAll('option')]) if (!offered.includes(o.value)) o.remove()
  for (const g of [...layoutSelect.querySelectorAll('optgroup')]) if (!g.children.length) g.remove()
  layoutSelect.title = NO_H265_NOTE
  const shown = layoutOnThisPc(wanted)
  layoutSelect.value = shown
  if ((shown === wanted && wanted !== 'auto') || !draw) return
  page = 0
  freshenForPageChange()
  render({ keepSingle: true })
}
const noH265Timer = isPhone() ? null : setInterval(limitForNoH265, 1000)
if (!isPhone()) limitForNoH265({ draw: false }) // (?h265=0 is known already; the first drawing is still to come)
try {
  hideOffline.checked = preferenceStorage.getItem('cctv.hideOffline') !== '0'
} catch {}
hideOffline.addEventListener('change', () => {
  page = 0
  preferenceStorage.setItem('cctv.hideOffline', hideOffline.checked ? '1' : '0')
  freshenForPageChange()
  render({ keepSingle: true })
})
siteSelect.addEventListener('change', () => {
  rememberSite(siteSelect.value.startsWith('@nvr:') ? cameras.find((c) => `@nvr:${c.nvr}` === siteSelect.value)?.site || '' : siteSelect.value)
  liveBrowser?.refresh()
  page = 0
  activeView = null // browsing by site leaves the saved view; the dropdown goes back to "(not saved)"
  preferenceStorage.setItem('cctv.activeView', '')
  renderViewSel()
  preferenceStorage.setItem('cctv.site', siteSelect.value)
  // a whole different set of cameras is about to subscribe; drop the old site's video still draining
  // on the shared socket, or on a big grid the new site's streams queue behind it (never switching)
  freshenForPageChange()
  // a camera open full-size belongs to the site being left: close it so switching site shows the new
  // site's grid, not the old camera stuck over it. (Layout and "hide offline" keep it; a site does not.)
  if (single !== null) closeSingle()
  render()
})

// ---- saved views (grid-view.js, /api/me/views) -------------------------------------------------
// A named set of cameras and a layout, kept with the account and shared with the Wall. Selecting one
// restricts the grid to its cameras in its order; "(not saved)" shows every camera again. Versioned
// exactly as the camera order is: a save on a stale version is refused and the list reloaded.
let viewsRestored = false
async function loadViews() {
  try {
    const res = await fetch('/api/me/views')
    if (!res.ok) throw new Error(String(res.status))
    const got = await res.json()
    views = normaliseViews(got.views).views
    viewsVersion = Number.isSafeInteger(got.version) ? got.version : 0
    if (!viewsRestored) {
      viewsRestored = true
      activeView = views.find((v) => v.id === preferenceStorage.getItem('cctv.activeView')) ?? null
      if (activeView && LAYOUTS[activeView.layout] && !isPhone()) { layoutSelect.value = layoutOnThisPc(activeView.layout); markPhoneLayout() }
    }
  } catch {
    views = [] // a page that cannot read its views still shows the grid
  }
  renderViewSel()
}

function renderViewSel() {
  viewSel.replaceChildren(new Option('(not saved)', ''), ...views.map((v) => new Option(v.name, v.id)))
  viewSel.value = activeView?.id ?? ''
  deleteViewBtn.hidden = !activeView
}

/** Saves the views as they now are, telling the viewer when another screen got there first. */
async function putViews(next) {
  if (!applyViews({ views, version: viewsVersion }, { views: next, version: viewsVersion }).saved) {
    return { ok: false, error: 'Your views were changed on another screen. Reloading them.' }
  }
  const res = await fetch('/api/me/views', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ views: next, version: viewsVersion })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 409) { views = normaliseViews(body.views).views; viewsVersion = body.version ?? viewsVersion; renderViewSel() }
    return { ok: false, error: body.error ?? `HTTP ${res.status}` }
  }
  views = normaliseViews(body.views).views
  viewsVersion = body.version
  renderViewSel()
  return { ok: true, error: null }
}

/**
 * The cameras a view saved now would hold: those on the grid (a view's, or every camera of the site
 * chosen), capped. Offline ones too, whatever "Hide offline" says: a camera that happened to be off
 * at the moment of saving was dropped from the view for good.
 */
const currentViewCameras = () => shownCameras(gridCameras(), { ...gridView(), hideOffline: false }).slice(0, MAX_VIEW_CAMERAS).map(camKey)

function selectView(id) {
  activeView = views.find((v) => v.id === id) ?? null
  preferenceStorage.setItem('cctv.activeView', activeView?.id || '')
  // a live-page layout rides with the view; a Wall layout ('3x3' etc.) the live grid cannot draw is
  // left as it is (layoutCells falls back anyway), rather than blanking the dropdown
  if (activeView && LAYOUTS[activeView.layout] && (!isPhone() || PHONE_LAYOUTS.includes(activeView.layout))) {
    layoutSelect.value = layoutOnThisPc(activeView.layout) // (4 x 4 on a PC without H.265; the view stays as saved)
    markPhoneLayout()
    preferenceStorage.setItem(LAYOUT_KEY, layoutSelect.value)
  }
  page = 0
  renderViewSel()
  freshenForPageChange() // a view is a different set of cameras; drop the old set's backlog first
  render({ keepSingle: true })
}

viewSel.addEventListener('change', () => selectView(viewSel.value))

saveViewBtn.addEventListener('click', () => {
  if (currentViewCameras().length === 0) return
  viewNameEl.value = activeView?.name ?? ''
  viewMsgEl.textContent = ''
  viewDlg.showModal()
  viewNameEl.focus()
})

document.getElementById('viewSave').addEventListener('click', async () => {
  // a view saved under a name already in use replaces it, rather than leaving two the menu cannot tell apart;
  // any other name is a new view (it used to take the selected view's id, and so overwrote that view)
  const name = viewNameEl.value
  const existing = views.find((v) => v.name.trim().toLowerCase() === name.trim().toLowerCase())
  const candidate = {
    id: existing?.id ?? `v${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    name,
    cameras: currentViewCameras(),
    layout: layoutSelect.value
  }
  const { ok, error, value } = checkView(candidate)
  if (!ok) return (viewMsgEl.textContent = error)
  const saved = await putViews([...views.filter((v) => v.id !== value.id), value])
  if (!saved.ok) return (viewMsgEl.textContent = saved.error)
  activeView = views.find((v) => v.id === value.id) ?? value
  preferenceStorage.setItem('cctv.activeView', activeView.id)
  renderViewSel()
  render({ keepSingle: true })
  viewDlg.close()
})

deleteViewBtn.addEventListener('click', async () => {
  if (!activeView) return
  const saved = await putViews(views.filter((v) => v.id !== activeView.id))
  if (!saved.ok) return
  activeView = null
  preferenceStorage.setItem('cctv.activeView', '')
  renderViewSel()
  render({ keepSingle: true })
})
// drop a big grid's backed-up shared connection before the new page subscribes, so it starts clean
// (live-mux.js): the old page's video, still draining over a slow link, otherwise held the new page's
// streams behind it. The tiles are rebuilt by render() regardless.
prevBtn.addEventListener('click', () => { page--; freshenForPageChange(); render() })
nextBtn.addEventListener('click', () => { page++; freshenForPageChange(); render() })
/**
 * The next (dir 1) or previous (-1) page of the grid, for ← → and a flick: round past either end, as
 * stepCamera goes round the cameras. In full screen the pager is out of sight, so these are the only
 * way to turn the page there, and a small note says for a moment which page it is.
 */
function stepPage(dir) {
  const pages = Number(pageLabel.dataset.pages ?? 1)
  if (single !== null || !(pages > 1)) return
  page = (page + dir + pages) % pages
  telemetry.event('page', { dir })
  freshenForPageChange()
  render()
  notePage()
}
let pageNote = null
let pageNoteTimer = null
function notePage() {
  clearTimeout(pageNoteTimer)
  pageNote?.remove() // (render has taken the last one off the grid already)
  pageNote = null
  if (document.fullscreenElement !== grid) return // elsewhere the pager itself says it
  pageNote = document.createElement('div')
  pageNote.className = 'page-note'
  pageNote.setAttribute('role', 'status')
  pageNote.textContent = pageLabel.textContent
  grid.append(pageNote)
  pageNoteTimer = setTimeout(() => { pageNote?.remove(); pageNote = null }, 1500)
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && single !== null && !document.fullscreenElement) closeSingle()
  // the full-size view: ← → go through the cameras, the same as ‹ › and a flick
  if (single !== null && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.target.closest?.('input, select, textarea')) {
    e.preventDefault()
    stepCamera(e.key === 'ArrowRight' ? 1 : -1)
  }
  // the grid: ← → turn its page the same way. Once a press, not while the key is held (every page
  // opens its cameras' streams); not with Alt, Ctrl or ⌘ (Alt+← is the browser's Back); and not from
  // a field, a menu or an open dialog, where the arrows are that control's own.
  if (single === null && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.repeat && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.defaultPrevented &&
    !e.target.closest?.('input, select, textarea, [contenteditable], dialog, .cam-sheet') && !document.querySelector('dialog[open]')) {
    e.preventDefault()
    stepPage(e.key === 'ArrowRight' ? 1 : -1)
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
      remote: REMOTE_PAGE, // (the tiles' playout clock: REMOTE_CLOCK, else live's own)
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
let pageSuspended = false
addEventListener('pagehide', () => {
  pageSuspended = true
  clearTimeout(hiddenTimer)
  // iPhone history navigation can freeze this page before its delayed visibility
  // cleanup runs. Do not retain sockets or decoders across that frozen document.
  for (const t of tiles) t.close()
  tiles = []
  stopAheadMain()
})
addEventListener('pageshow', (event) => {
  if (event.persisted) {
    // WebKit can restore a document whose WebCodecs/GPU resources no longer
    // function. Recreate the document itself, not just its player objects.
    location.reload()
    return
  }
  if (!event.persisted && !pageSuspended) return
  pageSuspended = false
  clearTimeout(hiddenTimer)
  freshenForPageChange(0)
  render()
  checkSession()
  sync.refresh()
  listSoon()
})
document.addEventListener('visibilitychange', () => {
  clearTimeout(hiddenTimer)
  if (document.hidden) {
    if (isPhone()) {
      for (const t of tiles) t.close()
      tiles = []
      freshenForPageChange(0)
      return
    }
    hiddenTimer = setTimeout(() => {
      for (const t of tiles) t.close()
      tiles = []
      stopAheadMain() // (a whole main stream nobody is looking at)
    }, 3000)
    return
  }
  // the camera order may have been changed on another screen meanwhile
  if (isPhone()) {
    for (const t of tiles) t.close()
    tiles = []
    freshenForPageChange(0)
  }
  sync.refresh()
  if (tiles.length === 0) render()
  else if (gridStale) render({ keepSingle: true })
})

/** Sends the browser to the sign-in page if the session has expired or been revoked. */
async function checkSession() {
  const res = await fetchLiveJson('/api/me', true).catch(() => null)
  noteServerClock(res) // this runs every minute, so the overlay's clock never drifts from the server's
  if (res?.status === 401) location.href = '/login.html'
  return res?.ok ? res.data : null
}

async function fetchLiveJson(url, withResponse = false) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (response.status === 401) { location.href = '/login.html'; throw new Error('Session expired') }
    if (!response.ok) throw new Error(`Camera request failed (${response.status})`)
    const data = await response.json()
    return withResponse ? { ok: response.ok, headers: response.headers, data } : data
  } finally { clearTimeout(timer) }
}

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' })
  location.href = '/login.html'
})

// Everything the first screen needs is asked for at once: the session, this user's order, the
// overlay settings and the camera list were four round trips one after another (about a second of
// empty page over mobile data).
const fetchLists = () => Promise.all([fetchLiveJson('/api/cameras'), fetchLiveJson('/api/sites')])
const prefetched = fetchLists()
prefetched.catch(() => {}) // (handled where it is used; a signed-out session is sent to sign-in first)
const early = Promise.all([sync.load(), loadOsd().catch(() => {}), loadViews().catch(() => {})])
const me = await checkSession()
if (me) document.getElementById('whoami').textContent = me.user
if (me?.admin) { const st = document.getElementById('sitesTab'); if (st) st.hidden = false; const se = document.getElementById('settingsTab'); if (se) se.hidden = false }
wallToleranceSetup(me?.admin === true)
isAdmin = Boolean(me?.admin)
user = me?.user ?? null
// where the server sees this browser coming from: the name in the address bar is the same on the
// office network and through the tunnel, so it cannot say (security.mjs routeOf). For aheadMain.
// Only a dotted IPv4 is judged: isLocalHost reads an address-bar host, where IPv6 comes in brackets, and
// takes a bare one (a visitor's own, through the tunnel or the VPN) for a name without a dot: local.
onLan = me?.direct === true && typeof me.address === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(me.address) && isLocalHost(me.address)
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
  const before = gridCameras() // what is on the grid now (a view's subset, or every camera)
  const beforeView = gridView() // (the site list below can reset the site filter)
  cameras = list

  // site filter, shown only when there is more than one site; a multi-NVR site gets an NVR submenu
  const names = [...new Set(sites.map((s) => s.site))]
  document.getElementById('siteLabel').hidden = names.length < 2
  const current = siteSelect.value || (workspaceSite() ?? preferenceStorage.getItem('cctv.site') ?? '')
  const opts = siteOptions(sites)
  siteSelect.replaceChildren(...opts)
  siteSelect.value = opts.some((o) => o.value === current) ? current : ''
  liveBrowser?.refresh()

  const down = sites.filter((s) => s.status !== 'online')
  notice.hidden = down.length === 0 && cameras.length > 0
  // an empty roster is a normal first state, not a fault: show it neutral, keep amber for NVRs down
  const benign = cameras.length === 0 && down.length === 0
  notice.classList.toggle('as-info', benign)
  // (a viewer is told only the site, name and state of an NVR: /api/sites, rights.mjs sitesFor)
  notice.textContent = benign
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
  const diff = sameFrame ? diffCameras(before, gridCameras(), view) : { full: true }
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
liveBrowser = mountCameraBrowser({
  host: document.querySelector('.live-scope'), cameras: () => cameras,
  selectedSite: () => siteSelect.value.startsWith('@nvr:') ? cameras.find((c) => `@nvr:${c.nvr}` === siteSelect.value)?.site || '' : siteSelect.value,
  onSite: (name) => { siteSelect.value = name; siteSelect.dispatchEvent(new Event('change')) },
  onCamera: (cam) => { siteSelect.value = cam.site; siteSelect.dispatchEvent(new Event('change')); openSingle(cam, { fromTap: true }) }
})
listSoon() // (whatever happened above, the list is re-read every 5 s for the next minute)
if (sync.unsaved) sync.refresh()
// the camera list, and this user's order (another screen may have changed it)
setInterval(() => {
  loadCameras().catch(() => {})
  loadOsd().catch(() => {}) // an overlay changed in Settings reaches every screen within half a minute
  loadViews().catch(() => {}) // a view saved or deleted on another screen reaches this one too
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


// ---- phones: flick left and right to go through the cameras ----
/** The next (dir 1) or previous (-1) camera of the grid, full-size. */
function stepCamera(dir) {
  const list = shownCameras(gridCameras(), gridView())
  if (list.length < 2 || single === null) return
  const i = list.findIndex((c) => camKey(c) === single)
  const next = list[(i + dir + list.length) % list.length]
  stepDir = dir < 0 ? -1 : 1
  openSingle(next, { stepping: true })
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
  // ...and with the grid in full screen a flick turns its page (stepPage): the pager is out of sight
  // there. A finger held on a tile first is moving that tile (grid-drag.js), not flicking.
  const gridFull = () => single === null && document.fullscreenElement === grid
  document.addEventListener('touchstart', (e) => {
    if (!(document.body.classList.contains('phone-full') || gridFull()) || e.touches.length !== 1) return (t0 = null)
    if (overlayZoom && overlayZoom.zoom > 1) return (t0 = null) // zoomed: one finger moves the picture
    t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY, at: performance.now() }
  }, { passive: true })
  // A flick starts moving at once. A finger that rested first (grid-drag.js lifts a tile after 400 ms)
  // is not one, even when that drag has since been taken away by the browser: Chrome reports the
  // first touchmove only once the finger has left its slop, by when the drag can have come and gone.
  const RESTED_MS = 300
  document.addEventListener('touchmove', () => {
    if (!t0) return
    if (drag.dragging() || (!t0.moved && performance.now() - t0.at >= RESTED_MS)) return (t0 = null)
    t0.moved = true
  }, { passive: true })
  document.addEventListener('touchend', (e) => {
    if (!t0 || (single === null && !gridFull())) return (t0 = null)
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
    if (single !== null) stepCamera(along < 0 ? 1 : -1)
    else stepPage(along < 0 ? 1 : -1)
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
