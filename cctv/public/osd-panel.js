// The on-screen display for one camera (admins), over the full-size Live view: the name text and
// the clock the camera BURNS INTO ITS PICTURE -- part of every recording for ever, the timestamp a
// person reads off evidence. The camera carries two independently placed overlays (the name and
// the clock), each with its own on/off switch and X/Y. Drag either box on the live picture to
// place it, edit the name, pick the clock's date/time format, turn each overlay on or off, then
// Save. Modelled on the line-crossing panel (lines-panel.js) so it matches the app and its safety
// model.
//
// Nothing reaches the camera without a click on Save or Undo. Save first lists what it will change
// and warns it is burnt into recordings; the server (osd.mjs) reads the camera, writes only the
// changed fields block by block, reads them back and logs before/after; the result is shown here
// (applied or not, before vs after) and Undo writes the previous values back.
//
// This is the camera's REAL overlay, not Argus's own browser overlay (osd-overlay.js): a different
// thing entirely, left alone. The canvas lies exactly over the picture (colour-check-ui.js's tested
// maths); the placement maths and rules are osd-geom.js (node-tested). The DOM is only touched here.
import { clientToPicture, objectPosition, overlayBox, pictureRect, pictureToOverlay } from './colour-check-ui.js'
import { CORNERS, OSD_MAX, changeCount, changeSummary, changedFields, draftOf, nameError, nearestCorner, overlayHasPosition, overlayMoved, saveLabel, toFrac, toUnits } from './osd-geom.js'

const MOVE_PX = 4 // a press that moved less than this is a tap (place the overlay there)
const REACH_PX = 10 // extra slack around a box when deciding which one a press grabs
const OV_LABEL = { name: 'name', time: 'clock' }
const DATEFMT_WORDS = { 'year-month-day': 'Year-Month-Day', 'month-day-year': 'Month-Day-Year', 'day-month-year': 'Day-Month-Year' }

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'dataset') Object.assign(n.dataset, v)
    else if (k.startsWith('aria-') || k === 'role' || k === 'for') n.setAttribute(k, v === true ? 'true' : String(v))
    else n[k] = v
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false && c !== '') n.append(c)
  return n
}

async function api(method, url, body) {
  const res = await fetch(url, method === 'GET' ? { cache: 'no-store' } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}
const errorOf = (r) => new Error(r.data?.error || `HTTP ${r.status}`)

/** A sample clock in the draft's own format, drawn in the clock box so its place can be judged. */
function sampleTime(time) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const date = time?.dateFormat === 'year-month-day' ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    : time?.dateFormat === 'month-day-year' ? `${p(d.getMonth() + 1)}-${p(d.getDate())}-${d.getFullYear()}`
      : `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`
  const h = time?.timeFormat === '12' ? `${((d.getHours() + 11) % 12) + 1}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getHours() < 12 ? 'AM' : 'PM'}` : `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return `${date} ${h}`
}

/** A translucent box with a dark edge and white text, so it shows on any picture. Returns its rect (CSS px). */
function drawBox(g, x, y, w, h, text, { current, dashed, dim, k }) {
  g.save()
  g.setLineDash(dashed ? [8 * k, 5 * k] : [])
  g.fillStyle = dim ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.55)'
  g.strokeStyle = current ? '#ffd23f' : 'rgba(255,255,255,0.85)'
  g.lineWidth = (current ? 2.5 : 1.5) * k
  const r = 4 * k
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
  g.fill()
  g.stroke()
  g.setLineDash([])
  g.font = `600 ${Math.round(h * 0.5)}px system-ui, sans-serif`
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  g.fillStyle = dim ? 'rgba(255,255,255,0.55)' : '#fff'
  g.fillText(text, x + 8 * k, y + h / 2)
  g.restore()
}

let idSeq = 0

export class OsdPanel {
  /**
   * @param {HTMLElement} host where the panel goes (the Live grid, beside the full-size view)
   * @param {{ nvr: string, ch: number, name: string }} cam the camera (ch 0-based, as /api/cameras)
   * @param {{ liveEl: HTMLElement | (() => HTMLElement | null), opener?: HTMLElement | null, onClose?: () => void }} opts
   */
  constructor(host, cam, { liveEl, opener = null, onClose = null } = {}) {
    this.host = host
    this.cam = cam
    this.liveEl = liveEl
    this.opener = opener
    this.onClose = onClose
    this.osd = null // GET .../osd: the camera's reading (two-overlay model)
    this.draft = null // draftOf(osd), as the admin changes it
    this.undo = null // { want, at, by } the values to put back after a Save
    this.selected = 'name' // the overlay the corner buttons and a tap place
    this.busy = false
    this.sending = 0
    this.session = 0
    this.loadSeq = 0
    this.isOpen = false
    this.folded = false
    this.drag = null
    this.boxes = {} // last-drawn box rects in canvas CSS px, for hit-testing
    this.ov = null
    this.layoutKey = ''
    this.onResize = () => this.layout()
    this.build()
  }

  get key() {
    return `${this.cam.nvr}/${this.cam.ch}`
  }

  get dirty() {
    return this.osd && this.draft ? changeCount(this.osd, this.draft) : 0
  }

  url() {
    return `/api/admin/nvrs/${encodeURIComponent(this.cam.nvr)}/channels/${this.cam.ch}/osd`
  }

  build() {
    this.el = el('aside', { className: 'img-panel osd-panel', 'aria-label': 'On-screen display' })
    this.el.innerHTML = `
      <div class="ip-head"><h2 tabindex="-1">OSD <span class="ip-cam"></span></h2><span class="ln-head-buttons"><button type="button" class="ln-fold" aria-expanded="true" title="Fold the panel away to see the whole picture">Hide</button><button type="button" class="ip-close" aria-label="Close OSD editor">×</button></span></div>
      <p class="ln-help">This is what the camera burns into its picture, and into every recording from now on. Drag the name box or the clock box on the picture to place it; a tap places the selected one. Edit the name and the clock below, then Save.</p>
      <section class="ln-box osd-ov" data-ov="name">
        <label class="ip-switch"><input type="checkbox" class="osd-show-name" /> Show the name</label>
        <label class="ip-row osd-name-row">Name <input type="text" class="osd-name" maxlength="32" /></label>
        <p class="osd-name-err ip-error" role="alert"></p>
        <button type="button" class="osd-select" data-ov="name">Place the name</button>
      </section>
      <section class="ln-box osd-ov" data-ov="time">
        <label class="ip-switch"><input type="checkbox" class="osd-show-time" /> Show the clock</label>
        <label class="ln-row">Date format <select class="osd-datefmt"></select></label>
        <label class="ln-row">Clock <select class="osd-timefmt"></select></label>
        <button type="button" class="osd-select" data-ov="time">Place the clock</button>
      </section>
      <div class="osd-corners"><p class="ln-note">Move the <span class="osd-sel-word">name</span> to a corner:</p><div class="osd-corner-buttons"></div></div>
      <div class="ip-result osd-result" hidden></div>
      <p class="ip-error osd-error" role="alert"></p>
      <p class="ip-status" role="status"></p>
      <p class="ip-undo-note" hidden></p>
      <div class="ip-actions">
        <button type="button" class="ip-undo" hidden>Undo last change</button>
        <button type="button" class="ip-revert">Revert</button>
        <button type="button" class="ip-apply osd-save">Save</button>
      </div>
      <dialog class="ip-dialog"></dialog>`
    const $ = (s) => this.el.querySelector(s)
    this.$ = $
    $('.ip-cam').textContent = `· ${this.cam.ch + 1} ${this.cam.name ?? ''}`
    $('.ip-close').addEventListener('click', () => this.requestClose())
    $('.ln-fold').addEventListener('click', () => this.fold())
    $('.osd-save').addEventListener('click', () => this.save())
    $('.ip-undo').addEventListener('click', () => this.undoLast())
    $('.ip-revert').addEventListener('click', () => this.revert())
    this.nameInput = $('.osd-name')
    this.dateSel = $('.osd-datefmt')
    this.timeSel = $('.osd-timefmt')
    this.nameInput.addEventListener('input', () => this.edit(() => (this.draft.name.text = this.nameInput.value)))
    $('.osd-show-name').addEventListener('change', (e) => this.edit(() => (this.draft.name.show = e.target.checked), 'name'))
    $('.osd-show-time').addEventListener('change', (e) => this.edit(() => (this.draft.time.show = e.target.checked), 'time'))
    this.dateSel.addEventListener('change', () => this.edit(() => (this.draft.time.dateFormat = this.dateSel.value), 'time'))
    this.timeSel.addEventListener('change', () => this.edit(() => (this.draft.time.timeFormat = this.timeSel.value), 'time'))
    for (const b of this.el.querySelectorAll('.osd-select')) b.addEventListener('click', () => this.select(b.dataset.ov))
    this.cornerButtons = CORNERS.map((c) => {
      const b = el('button', { type: 'button', className: 'osd-corner' }, c.label)
      b.addEventListener('click', () => this.edit(() => { this.draft[this.selected].x = c.x; this.draft[this.selected].y = c.y }))
      return { ...c, b }
    })
    $('.osd-corner-buttons').replaceChildren(...this.cornerButtons.map((c) => c.b))

    this.shield = el('div', { className: 'ln-shield' })
    this.canvas = el('canvas', { className: 'ln-overlay', hidden: true, 'aria-label': 'The camera picture: drag the name or clock to place it' })
    this.ctx = this.canvas.getContext('2d')
    for (const n of [this.el, this.shield, this.canvas]) {
      n.addEventListener('click', (e) => e.stopPropagation())
      n.addEventListener('dblclick', (e) => e.stopPropagation())
    }
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape' && !$('.ip-dialog').open) this.requestClose()
    })
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e))
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e))
    this.canvas.addEventListener('pointercancel', (e) => this.onPointerCancel(e))
  }

  open() {
    if (this.isOpen || typeof document === 'undefined') return
    this.isOpen = true
    this.session++
    this.host.append(this.el)
    window.addEventListener('resize', this.onResize)
    this.layoutTimer = setInterval(() => this.layout(), 400)
    this.layout()
    this.load({ first: true })
  }

  requestClose() {
    if (!this.confirmDiscard()) return false
    this.close()
    return true
  }

  confirmDiscard(n = this.dirty) {
    if (this.sending > 0) return window.confirm('A change is being saved to the camera. If you leave now its result will not be shown here; the change goes ahead. Leave anyway?')
    return n === 0 || window.confirm(`Discard ${n} unsaved change${n === 1 ? '' : 's'}?`)
  }

  close() {
    if (!this.isOpen) return
    this.isOpen = false
    this.session++
    this.loadSeq++
    clearInterval(this.layoutTimer)
    window.removeEventListener('resize', this.onResize)
    const d = this.$('.ip-dialog')
    if (d.open) d.close()
    for (const n of [this.el, this.shield, this.canvas]) n.remove()
    this.drag = null
    this.busy = false
    this.sending = 0
    if (this.opener?.isConnected) this.opener.focus()
    this.onClose?.()
  }

  fold(on = !this.folded) {
    this.folded = on
    this.el.classList.toggle('ln-folded', on)
    const b = this.$('.ln-fold')
    b.textContent = on ? 'Show' : 'Hide'
    b.setAttribute('aria-expanded', String(!on))
  }

  status(text, { error = false } = {}) {
    this.$('.ip-status').textContent = error ? '' : text
    this.$('.osd-error').textContent = error ? text : ''
  }

  select(ov) {
    this.selected = ov
    this.update()
    this.draw()
  }

  // ---- reading -----------------------------------------------------------------------------------

  async load({ first = false } = {}) {
    const seq = ++this.loadSeq
    this.busy = true
    this.update()
    this.status('Reading what the camera shows…')
    try {
      const r = await api('GET', this.url())
      if (seq !== this.loadSeq) return false
      if (!r.ok) throw errorOf(r)
      this.show(r.data.osd)
      this.status('')
      if (first) this.$('.ip-head h2').focus()
      return true
    } catch (e) {
      if (seq === this.loadSeq) this.status(e.message, { error: true })
      return false
    } finally {
      if (seq === this.loadSeq) {
        this.busy = false
        this.update()
      }
    }
  }

  /** A fresh reading (GET, or the read-back after a Save or Undo): everything is redrawn from it. */
  show(osd) {
    this.osd = osd ?? null
    this.draft = osd ? draftOf(osd) : null
    // the date/time format choices: the camera's own list, or just the current value when it gave none
    this.fillFormatOptions()
    this.update()
    this.draw()
  }

  fillFormatOptions() {
    const types = this.osd?.types ?? {}
    const dates = types.dateFormat?.length ? types.dateFormat : [this.osd?.time?.dateFormat].filter(Boolean)
    const times = types.timeFormat?.length ? types.timeFormat : [this.osd?.time?.timeFormat].filter(Boolean)
    this.dateSel.replaceChildren(...dates.map((v) => new Option(DATEFMT_WORDS[v] ?? v, v)))
    this.timeSel.replaceChildren(...times.map((v) => new Option(`${v}-hour`, v)))
    this.$('[data-ov="time"].osd-ov').querySelectorAll('.ln-row').forEach((r) => { r.hidden = !(dates.length || times.length) })
  }

  revert() {
    if (!this.osd || this.busy) return
    this.draft = draftOf(this.osd)
    this.status('')
    this.update()
    this.draw()
  }

  /** A change to the draft from a control. ov: select that overlay so the corners/drawing follow it. */
  edit(fn, ov = null) {
    if (!this.draft || this.busy) return this.update()
    fn()
    if (ov) this.selected = ov
    this.update()
    this.draw()
  }

  update() {
    const locked = this.busy || !this.osd
    const d = this.draft
    if (document.activeElement !== this.nameInput) this.nameInput.value = d?.name.text ?? ''
    this.nameInput.disabled = locked
    const nameChanged = d && String(d.name.text) !== String(this.osd?.name?.text ?? '')
    const err = d ? nameError(d.name.text) : null
    this.$('.osd-name-err').textContent = nameChanged && err ? err : ''
    this.$('.osd-show-name').checked = d?.name.show === true
    this.$('.osd-show-time').checked = d?.time.show === true
    if (d) {
      if (document.activeElement !== this.dateSel && d.time.dateFormat != null) this.dateSel.value = d.time.dateFormat
      if (document.activeElement !== this.timeSel && d.time.timeFormat != null) this.timeSel.value = d.time.timeFormat
    }
    for (const n of ['.osd-show-name', '.osd-show-time']) this.$(n).disabled = locked
    this.dateSel.disabled = this.timeSel.disabled = locked
    // which overlay is selected
    for (const s of this.el.querySelectorAll('.osd-ov')) s.classList.toggle('osd-current', s.dataset.ov === this.selected)
    for (const b of this.el.querySelectorAll('.osd-select')) b.setAttribute('aria-pressed', String(b.dataset.ov === this.selected))
    this.$('.osd-sel-word').textContent = OV_LABEL[this.selected]
    const selBlock = d?.[this.selected]
    for (const c of this.cornerButtons) {
      c.b.disabled = locked
      c.b.setAttribute('aria-pressed', String(selBlock && nearestCorner(selBlock.x, selBlock.y) === c.id))
    }
    const n = this.dirty
    const blockedByName = Boolean(nameChanged && err)
    const save = this.$('.osd-save')
    save.textContent = saveLabel(n)
    save.disabled = locked || n === 0 || blockedByName
    this.$('.ip-revert').disabled = this.busy || n === 0
    const undo = this.$('.ip-undo')
    undo.hidden = !this.undo
    undo.disabled = locked
    const note = this.$('.ip-undo-note')
    note.hidden = !this.undo
    note.textContent = this.undo ? `Undo puts back the OSD from before the last change (made ${new Date(this.undo.at).toLocaleString()} by ${this.undo.by}).` : ''
    this.canvas.classList.toggle('ln-locked', locked)
  }

  // ---- the drawing -------------------------------------------------------------------------------

  videoEl() {
    try {
      return (typeof this.liveEl === 'function' ? this.liveEl() : this.liveEl) ?? null
    } catch {
      return null
    }
  }

  layout() {
    if (!this.isOpen) return
    const video = this.videoEl()
    const tile = video?.isConnected ? video.closest('.tile') : null
    if (!tile) {
      if (this.layoutKey !== 'gone') {
        this.layoutKey = 'gone'
        this.ov = null
        this.canvas.hidden = true
      }
      return
    }
    if (this.canvas.parentNode !== tile) {
      tile.append(this.shield, this.canvas)
      this.layoutKey = ''
    }
    const hr = tile.getBoundingClientRect()
    const hostBox = { left: hr.left + tile.clientLeft, top: hr.top + tile.clientTop, width: tile.clientWidth, height: tile.clientHeight }
    const [iw, ih] = video instanceof HTMLVideoElement ? [video.videoWidth, video.videoHeight] : [video.width, video.height]
    const cs = getComputedStyle(video)
    const r = video.getBoundingClientRect()
    const px = (v) => parseFloat(v) || 0
    const b = {
      left: r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft),
      top: r.top + px(cs.borderTopWidth) + px(cs.paddingTop),
      width: r.width - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(cs.paddingLeft) - px(cs.paddingRight),
      height: r.height - px(cs.borderTopWidth) - px(cs.borderBottomWidth) - px(cs.paddingTop) - px(cs.paddingBottom)
    }
    const pic = pictureRect(b, iw, ih, cs.objectFit || 'fill', objectPosition(cs.objectPosition))
    const dpr = window.devicePixelRatio || 1
    const key = pic ? [pic.left, pic.top, pic.width, pic.height, hostBox.left, hostBox.top, hostBox.width, hostBox.height, dpr].map((x) => x.toFixed(1)).join() : 'none'
    if (key === this.layoutKey) return
    this.layoutKey = key
    if (!pic) {
      this.ov = null
      this.canvas.hidden = true
      return
    }
    const o = overlayBox(pic, hostBox, dpr)
    Object.assign(this.canvas.style, { left: `${o.left}px`, top: `${o.top}px`, width: `${o.width}px`, height: `${o.height}px` })
    if (this.canvas.width !== o.backingWidth) this.canvas.width = o.backingWidth
    if (this.canvas.height !== o.backingHeight) this.canvas.height = o.backingHeight
    this.canvas.hidden = false
    this.ov = o
    this.draw()
  }

  /** The two overlay boxes at the draft's positions; the selected one on top, dashed when moved. */
  draw() {
    const g = this.ctx
    const ov = this.ov
    if (!g || !ov) return
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, ov.backingWidth, ov.backingHeight)
    this.boxes = {}
    if (!this.draft) return
    const k = ov.backingWidth / Math.max(1, ov.width)
    const lineH = Math.max(16 * k, ov.backingHeight * 0.055)
    const chW = lineH * 0.6
    // draw the unselected overlay first, so the selected one sits on top and wins a press
    for (const ovName of ['name', 'time'].sort((a) => (a === this.selected ? 1 : -1))) {
      const block = this.draft[ovName]
      if (!overlayHasPosition(block)) continue
      const label = ovName === 'name' ? (block.text || '(no name)') : sampleTime(block)
      const w = Math.max(chW * 3, label.length * chW)
      const [ax, ay] = pictureToOverlay([toFrac(block.x), toFrac(block.y)], ov)
      const moved = overlayMoved(this.osd?.[ovName], block)
      drawBox(g, ax, ay, w, lineH, label, { current: ovName === this.selected, dashed: moved, dim: !block.show, k })
      this.boxes[ovName] = { x: ax / k, y: ay / k, w: w / k, h: lineH / k } // CSS px for hit-testing
    }
  }

  /** Where a pointer is on the picture, in the camera's units (held to the picture's edges). */
  unitsAt(e, r = this.canvas.getBoundingClientRect()) {
    if (!(r.width > 0 && r.height > 0)) return null
    const [u, v] = clientToPicture(e.clientX, e.clientY, r)
    return { x: toUnits(u), y: toUnits(v) }
  }

  /** Which overlay box a press at CSS-px (px,py) lands on (the selected one wins a tie); null if none. */
  boxAt(px, py) {
    let hit = null
    for (const ovName of ['name', 'time']) {
      const b = this.boxes[ovName]
      if (!b) continue
      if (px >= b.x - REACH_PX && px <= b.x + b.w + REACH_PX && py >= b.y - REACH_PX && py <= b.y + b.h + REACH_PX) {
        if (!hit || ovName === this.selected) hit = ovName
      }
    }
    return hit
  }

  onPointerDown(e) {
    if (!e.isPrimary || e.button !== 0 || !this.ov || !this.draft || this.busy) return
    const r = this.canvas.getBoundingClientRect()
    const at = this.unitsAt(e, r)
    if (!at) return
    e.preventDefault()
    e.stopPropagation()
    const hit = this.boxAt(e.clientX - r.left, e.clientY - r.top)
    const target = hit ?? this.selected
    if (!overlayHasPosition(this.draft[target])) return
    this.selected = target
    const block = this.draft[target]
    // grab by the offset from the box's anchor (when the press was on it), so it does not jump
    this.drag = { id: e.pointerId, overlay: target, dx: hit ? block.x - at.x : 0, dy: hit ? block.y - at.y : 0, moved: false, x: e.clientX, y: e.clientY }
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {}
    this.update()
    this.draw()
  }

  onPointerMove(e) {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < MOVE_PX) return
    d.moved = true
    const at = this.unitsAt(e)
    if (!at) return
    const block = this.draft[d.overlay]
    block.x = Math.min(OSD_MAX, Math.max(0, at.x + d.dx))
    block.y = Math.min(OSD_MAX, Math.max(0, at.y + d.dy))
    this.update()
    this.draw()
  }

  onPointerUp(e) {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    this.drag = null
    if (!d.moved) {
      // a tap on empty picture places the selected overlay there; a tap on a box just selects it
      const onBox = this.boxAt(e.clientX - this.canvas.getBoundingClientRect().left, e.clientY - this.canvas.getBoundingClientRect().top)
      if (!onBox) {
        const at = this.unitsAt(e)
        if (at && overlayHasPosition(this.draft[d.overlay])) {
          this.draft[d.overlay].x = at.x
          this.draft[d.overlay].y = at.y
        }
      }
    }
    this.update()
    this.draw()
  }

  onPointerCancel(e) {
    if (!this.drag || e.pointerId !== this.drag.id) return
    this.drag = null
    this.draw()
  }

  // ---- dialogs and sending -----------------------------------------------------------------------

  dialog({ title, lead = '', items = [], action = 'Save anyway' }) {
    const d = this.$('.ip-dialog')
    const back = document.activeElement
    const tid = `osd-d-${++idSeq}`
    d.setAttribute('aria-labelledby', tid)
    const ok = el('button', { type: 'button', className: 'ip-go' }, action)
    const cancel = el('button', { type: 'button' }, 'Cancel')
    d.replaceChildren(
      el('h3', { id: tid }, title),
      lead ? el('p', {}, lead) : '',
      items.length ? el('ul', { className: 'ip-acks' }, items.map((t) => el('li', {}, t))) : '',
      el('div', { className: 'ip-dialog-buttons' }, cancel, ok)
    )
    return new Promise((resolve) => {
      let settled = false
      const done = (v) => {
        if (settled) return
        settled = true
        if (d.open) d.close()
        if (back?.isConnected) back.focus()
        resolve(v)
      }
      ok.addEventListener('click', () => done(true))
      cancel.addEventListener('click', () => done(false))
      d.addEventListener('cancel', (e) => { e.preventDefault(); done(false) }, { once: true })
      d.addEventListener('close', () => done(false), { once: true })
      d.showModal()
      cancel.focus()
    })
  }

  async save() {
    if (!this.osd || this.busy) return
    const change = changedFields(this.osd, this.draft)
    if (Object.keys(change).length === 0) return
    const ok = await this.dialog({
      title: 'Change what this camera burns into its picture?',
      lead: 'This is part of every recording from now on and cannot be edited out of footage later. It changes:',
      items: changeSummary(this.osd, this.draft),
      action: 'Save to camera'
    })
    if (!ok) {
      this.status('Nothing was sent.')
      return
    }
    const undoWant = this.undoWantFor(change)
    await this.send({ ...change, confirm: true }, { verb: 'Saving', undoWant })
  }

  /** The values to put back (Undo): the camera's current reading of exactly the fields being changed. */
  undoWantFor(change) {
    const want = {}
    for (const [block, fields] of Object.entries(change)) {
      const have = this.osd?.[block] ?? {}
      const o = {}
      for (const k of Object.keys(fields)) if (have[k] !== null && have[k] !== undefined) o[k] = have[k]
      if (Object.keys(o).length) want[block] = o
    }
    return want
  }

  async undoLast() {
    if (!this.undo || this.busy) return
    if (!this.confirmDiscard()) return
    // show it as current -> previous, the same way a save is listed
    const draft = draftOf(this.osd)
    for (const [block, fields] of Object.entries(this.undo.want)) for (const [k, v] of Object.entries(fields)) draft[block][k] = v
    const ok = await this.dialog({
      title: 'Put back the previous OSD?',
      lead: 'This writes the previous settings back into the camera (and into its recordings from now on). It sets:',
      items: changeSummary(this.osd, draft),
      action: 'Put it back'
    })
    if (!ok) return
    await this.send({ ...this.undo.want, confirm: true }, { verb: 'Undoing', undoWant: null })
  }

  /** Sends a Save or an Undo, then shows the camera as read back and what happened to each field. */
  async send(body, { verb, undoWant }) {
    const session = this.session
    this.busy = true
    this.update()
    this.$('.osd-result').hidden = true
    this.status(`${verb}… the camera is read back afterwards (up to a couple of seconds)`)
    this.sending++
    let r
    try {
      r = await api('POST', this.url(), body)
    } catch (e) {
      if (session === this.session) {
        this.busy = false
        this.update()
        this.status(`Could not reach the server (${e.message}); reopen the panel to see what the camera has.`, { error: true })
      }
      return
    } finally {
      if (session === this.session) this.sending--
    }
    if (session !== this.session) return
    this.busy = false
    if (!r.ok) {
      this.update()
      this.status(r.data?.error || `HTTP ${r.status}`, { error: true })
      return
    }
    const result = r.data ?? {}
    if (undoWant && Object.keys(undoWant).length && result.applied) this.undo = { want: undoWant, at: Date.now(), by: 'you' }
    else if (verb === 'Undoing') this.undo = null
    if (result.after) this.show(result.after)
    this.showResult(result)
    this.status('')
  }

  showResult(result) {
    const sent = result?.sent ?? {}
    const after = result?.after ?? null
    const label = { 'name.text': 'Name text', 'name.show': 'Show name', 'name.x': 'Name X', 'name.y': 'Name Y', 'time.show': 'Show clock', 'time.x': 'Clock X', 'time.y': 'Clock Y', 'time.dateFormat': 'Date format', 'time.timeFormat': 'Clock format' }
    const valueText = (k, v) => (v === null || v === undefined ? '(none)' : /\.show$/.test(k) ? (v ? 'on' : 'off') : String(v))
    const fields = []
    for (const [block, bits] of Object.entries(sent)) {
      for (const [f, want] of Object.entries(bits)) {
        const key = `${block}.${f}`
        const got = after?.[block]?.[f]
        const ok = after && got === want
        fields.push({ ok, text: ok ? `${label[key] ?? key}: ${valueText(key, want)} (as asked)` : `${label[key] ?? key}: not applied (asked ${valueText(key, want)}, the camera has ${valueText(key, got)})` })
      }
    }
    const good = fields.filter((f) => f.ok).length
    const status = fields.length === 0 ? 'unknown' : result.applied ? 'done' : good > 0 ? 'partial' : 'failed'
    const headline = {
      done: 'Saved: the camera reports every change as asked.',
      partial: 'Partly saved: the camera kept some of it (below).',
      failed: 'Not saved: the camera kept its settings.',
      unknown: 'Sent, but the camera could not be read back afterwards.'
    }[status]
    const box = this.$('.osd-result')
    box.className = `ip-result osd-result ip-${status}`
    box.replaceChildren(
      el('p', {}, headline),
      result.warning && status !== 'done' ? el('p', { className: 'ln-note' }, result.warning) : '',
      fields.length ? el('ul', {}, fields.map((f) => el('li', { className: f.ok ? 'ln-ok' : 'ln-no' }, f.text))) : ''
    )
    box.hidden = false
  }
}
