// The camera settings editor on the Sites page: a live preview beside the
// Picture / OSD / Lines panels, for one camera at a time. It re-hosts the panels
// the live full-size view used to show (image-panel.js, osd-panel.js,
// lines-panel.js). Only one of the three is active at once — OSD and Lines both
// draw on the live picture — exactly as the full-size view enforced. The preview
// is one main-stream LiveTile (live-tile.js); on a camera the NVR will not give
// HD (or a browser without H.265), the tile drops to its sub stream on its own
// and the panels measure that instead.
import { ImagePanel } from './image-panel.js'
import { OsdPanel } from './osd-panel.js'
import { LinesPanel, linesSupportAsker } from './lines-panel.js'
import { LiveTile, MAIN_STREAM, TILE_HTML } from './live-tile.js'
import { isLocalHost } from './device.js'
import { cameraLabel } from './camera-choice.js'

const REMOTE_PAGE = !isLocalHost()
const linesSupported = linesSupportAsker()

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag)
  Object.assign(n, props)
  for (const k of kids) if (k != null && k !== false) n.append(k)
  return n
}

/**
 * Open the camera editor inside `mountEl` for `cam`
 * ({ nvr, ch, name, site, remote, online }). Only one editor should be open on
 * the page at once; the caller closes any previous one (guard with confirmDiscard).
 * @returns {{ cam: object, close: () => void, confirmDiscard: () => boolean }}
 */
export function openCameraEditor(mountEl, cam, { onClose = null } = {}) {
  // preview: one main-stream tile, shared by all three tabs
  const tileEl = el('div', { className: 'tile ce-tile' })
  tileEl.innerHTML = TILE_HTML
  tileEl.querySelector('.name').textContent = cameraLabel(cam)
  const preview = new LiveTile(tileEl, cam, MAIN_STREAM)
  // the contract image-panel.js / osd-panel.js / lines-panel.js expect from the view
  const getPlayer = () => {
    const p = preview.player
    if (!p || !p.videoWidth || tileEl.classList.contains('pending')) return null
    return { player: p, stream: preview.streamType === MAIN_STREAM ? 'main' : 'sub', remote: Boolean(cam.remote) && REMOTE_PAGE }
  }
  const waitForMain = async (ms) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const v = getPlayer()
      if (v?.stream === 'main' || (cam.remote && REMOTE_PAGE)) return v
      await new Promise((r) => setTimeout(r, 200))
    }
    return getPlayer()
  }
  const liveEl = () => getPlayer()?.player?.canvas ?? null

  // the three tab bodies and the one shared Picture panel
  const picBody = el('div', { className: 'ce-body' })
  const osdBody = el('div', { className: 'ce-body', hidden: true })
  const linesBody = el('div', { className: 'ce-body', hidden: true })
  const image = new ImagePanel({ getPlayer, waitForMain })

  let active = null // 'pic' | 'osd' | 'lines'
  let osd = null
  let lines = null

  // close whatever is active (its DOM goes). Never prompts — guard with confirmDiscard first.
  function closeActive() {
    if (active === 'pic') image.close()
    else if (active === 'osd') { osd?.close(); osd = null }
    else if (active === 'lines') { lines?.close(); lines = null }
    active = null
  }

  function openPanel(key) {
    if (key === 'pic') { image.open(cam); picBody.append(image.el) }
    else if (key === 'osd') { osd = new OsdPanel(osdBody, cam, { liveEl, onClose: () => { osd = null } }); osd.open() }
    else if (key === 'lines') { lines = new LinesPanel(linesBody, cam, { liveEl, onClose: () => { lines = null } }); lines.open() }
    active = key
  }

  // the unsent changes of the active panel (there is only ever one)
  function confirmDiscard() {
    if (active === 'pic') return image.confirmDiscard()
    if (active === 'osd') return osd ? osd.confirmDiscard() : true
    if (active === 'lines') return lines ? lines.confirmDiscard() : true
    return true
  }

  const tabs = [
    { key: 'pic', label: 'Picture', body: picBody },
    { key: 'osd', label: 'OSD', body: osdBody },
    { key: 'lines', label: 'Lines', body: linesBody }
  ]
  const tabBar = el('div', { className: 'ce-tabs' })
  tabBar.setAttribute('role', 'tablist')
  for (const t of tabs) {
    t.btn = el('button', { type: 'button', className: 'ce-tab', textContent: t.label })
    t.btn.setAttribute('role', 'tab')
    t.btn.setAttribute('aria-selected', 'false')
    if (t.key === 'lines') t.btn.hidden = true // shown only when the NVR supports line crossing
    t.btn.addEventListener('click', () => select(t.key))
    tabBar.append(t.btn)
  }

  function select(key) {
    if (key === active) return
    if (!confirmDiscard()) return // keep the current tab; its changes are unsent
    closeActive()
    for (const t of tabs) {
      const on = t.key === key
      t.body.hidden = !on
      t.btn.setAttribute('aria-selected', String(on))
    }
    openPanel(key)
  }

  linesSupported(cam).then((ok) => { if (ok) tabs.find((t) => t.key === 'lines').btn.hidden = false }).catch(() => {})

  const root = el('div', { className: 'ce-editor' },
    el('div', { className: 'ce-preview' }, tileEl),
    el('div', { className: 'ce-panels' }, tabBar, picBody, osdBody, linesBody))
  mountEl.append(root)

  // start on Picture
  for (const t of tabs) { t.body.hidden = t.key !== 'pic'; t.btn.setAttribute('aria-selected', String(t.key === 'pic')) }
  openPanel('pic')

  function close() {
    closeActive()
    preview.close()
    root.remove()
    onClose?.()
  }

  return { cam, close, confirmDiscard }
}
