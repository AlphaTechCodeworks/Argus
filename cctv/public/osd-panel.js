// The on-screen display for one camera (admins), over the full-size Live view: the name text and
// the clock the camera BURNS INTO ITS PICTURE -- part of every recording for ever, the timestamp a
// person reads off evidence. Drag the overlay on the live picture to place it, edit the name, turn
// the name/time on or off, then Save. Modelled on the line-crossing panel (lines-panel.js) so it
// matches the app and its safety model.
//
// Nothing reaches the camera without a click on Save or Undo. Save first lists what it will change
// and warns it is burnt into recordings; the server (osd.mjs) reads the camera, writes only the
// changed fields, reads them back and logs before/after; the result is shown here (applied or not,
// before vs after) and Undo writes the previous values back.
//
// This is the camera's REAL overlay, not Argus's own browser overlay (osd-overlay.js): a different
// thing entirely, left alone.
//
// The drawing canvas lies exactly over the picture (colour-check-ui.js's tested maths); the
// placement maths and rules are osd-geom.js (node-tested). The DOM is only touched in OsdPanel.
import { clientToPicture, objectPosition, overlayBox, pictureRect, pictureToOverlay } from './colour-check-ui.js'
import { CORNERS, OSD_MAX, changeCount, changeSummary, changedFields, draftOf, hasFreePosition, nameError, nearestCorner, saveLabel, toFrac, toUnits } from './osd-geom.js'

const MOVE_PX = 4 // a press that moved less than this is a tap (place the overlay there)

/** A small DOM builder: el('p', { className: 'x' }, 'text', child). */
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

/** A sample clock in the camera's own format, drawn in the time box so its place can be judged. */
function sampleTime(osd) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const date = /year-month-day/i.test(osd?.dateFormat ?? '') ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` : `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`
  const h = /^12/.test(osd?.timeFormat ?? '') ? `${((d.getHours() + 11) % 12) + 1}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getHours() < 12 ? 'AM' : 'PM'}` : `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return `${date} ${h}`
}

/** A translucent box with a dark edge and white text, so it shows on any picture. */
function box(g, x, y, w, h, text, { current, dashed, dim, k }) {
  g.save()
  g.setLineDash(dashed ? [8 * k, 5 * k] : [])
  g.fillStyle = dim ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.55)'
  g.strokeStyle = current ? '#ffd23f' : 'rgba(255,255,255,0.85)'
  g.lineWidth = (current ? 2.5 : 1.5) * k
  g.beginPath()
  const r = 4 * k
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
  g.fill()
  g.stroke()
  g.setLineDash([])
  g.font = `600 ${Math.round(h * 0.52)}px system-ui, sans-serif`
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
    this.osd = null // GET .../osd: the camera's reading
    this.draft = null // draftOf(osd), as the admin changes it
    this.undo = null // { fields, at, by } the values to put back after a Save
    this.busy = false
    this.sending = 0
    this.session = 0
    this.loadSeq = 0
    this.isOpen = false
    this.folded = false
    this.drag = null
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
      <p class="ln-help">This is what the camera burns into its picture, and into every recording from now on. Drag the overlay on the picture to place it; edit the name and turn the name or clock on or off, then Save.</p>
      <p class="osd-nopos ln-note" hidden></p>
      <label class="ip-row osd-name-row">Name <input type="text" class="osd-name" maxlength="32" /></label>
      <p class="osd-name-err ip-error" role="alert"></p>
      <label class="ip-switch"><input type="checkbox" class="osd-show-name" /> Show the name</label>
      <label class="ip-switch"><input type="checkbox" class="osd-show-time" /> Show the clock</label>
      <div class="osd-corners" hidden><p class="ln-note">Place the overlay:</p><div class="osd-corner-buttons"></div></div>
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
    this.nameInput.addEventListener('input', () => this.edit(() => (this.draft.name = this.nameInput.value)))
    $('.osd-show-name').addEventListener('change', (e) => this.edit(() => (this.draft.showName = e.target.checked)))
    $('.osd-show-time').addEventListener('change', (e) => this.edit(() => (this.draft.showTime = e.target.checked)))
    // four corner buttons, for a camera that does not expose a free position
    this.cornerButtons = CORNERS.map((c) => {
      const b = el('button', { type: 'button', className: 'osd-corner' }, c.label)
      b.addEventListener('click', () => this.edit(() => { this.draft.x = c.x; this.draft.y = c.y }))
      return { ...c, b }
    })
    $('.osd-corner-buttons').replaceChildren(...this.cornerButtons.map((c) => c.b))

    this.shield = el('div', { className: 'ln-shield' })
    this.canvas = el('canvas', { className: 'ln-overlay', hidden: true, 'aria-label': 'The camera picture: drag the overlay to place it' })
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
    const free = hasFreePosition(osd)
    const nopos = this.$('.osd-nopos')
    nopos.hidden = free || !osd
    nopos.textContent = free || !osd ? '' : 'The camera did not report where it places the overlay, so it cannot be dragged. Use a corner below; if the camera does not accept it, the result will say so.'
    this.$('.osd-corners').hidden = !osd || free
    this.update()
    this.draw()
  }

  revert() {
    if (!this.osd || this.busy) return
    this.draft = draftOf(this.osd)
    this.status('')
    this.update()
    this.draw()
  }

  edit(fn) {
    if (!this.draft || this.busy) return this.update()
    fn()
    this.update()
    this.draw()
  }

  /** Brings the controls in line with the draft, the unsaved changes and whether a request runs. */
  update() {
    const locked = this.busy || !this.osd
    if (document.activeElement !== this.nameInput) this.nameInput.value = this.draft?.name ?? ''
    this.nameInput.disabled = locked
    const err = this.draft ? nameError(this.draft.name) : null
    this.$('.osd-name-err').textContent = this.draft && String(this.draft.name) !== String(this.osd?.name ?? '') && err ? err : ''
    const sn = this.$('.osd-show-name')
    const st = this.$('.osd-show-time')
    sn.checked = this.draft?.showName === true
    st.checked = this.draft?.showTime === true
    sn.disabled = st.disabled = locked
    for (const c of this.cornerButtons) {
      c.b.disabled = locked
      c.b.setAttribute('aria-pressed', String(this.draft && nearestCorner(this.draft.x, this.draft.y) === c.id))
    }
    const n = this.dirty
    const blockedByName = Boolean(this.draft && String(this.draft.name) !== String(this.osd?.name ?? '') && nameError(this.draft.name))
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

  /** Puts the canvas exactly over the picture (letterboxing and devicePixelRatio accounted for), in whichever tile holds it now. */
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
    const ov = overlayBox(pic, hostBox, dpr)
    Object.assign(this.canvas.style, { left: `${ov.left}px`, top: `${ov.top}px`, width: `${ov.width}px`, height: `${ov.height}px` })
    if (this.canvas.width !== ov.backingWidth) this.canvas.width = ov.backingWidth
    if (this.canvas.height !== ov.backingHeight) this.canvas.height = ov.backingHeight
    this.canvas.hidden = false
    this.ov = ov
    this.draw()
  }

  /** The overlay boxes (name, clock) at the draft's position, dashed when moved but not saved. */
  draw() {
    const g = this.ctx
    const ov = this.ov
    if (!g || !ov) return
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, ov.backingWidth, ov.backingHeight)
    if (!this.draft || !hasFreePosition(this.draft)) return
    const k = ov.backingWidth / Math.max(1, ov.width)
    const [ax, ay] = pictureToOverlay([toFrac(this.draft.x), toFrac(this.draft.y)], ov)
    const moved = this.osd && (this.draft.x !== this.osd.x || this.draft.y !== this.osd.y)
    const lineH = Math.max(16 * k, ov.backingHeight * 0.055)
    const chW = lineH * 0.6
    let y = ay
    if (this.draft.showName || this.draft.name) {
      const label = this.draft.name || '(no name)'
      box(g, ax, y, Math.max(chW * 3, label.length * chW), lineH, label, { current: true, dashed: moved, dim: !this.draft.showName, k })
      y += lineH + 4 * k
    }
    if (this.draft.showTime) {
      const t = sampleTime(this.osd)
      box(g, ax, y, t.length * chW, lineH, t, { current: !this.draft.showName && !this.draft.name, dashed: moved, dim: false, k })
    }
  }

  /** Where a pointer is on the picture, in the camera's units (held to the picture's edges). */
  unitsAt(e, r = this.canvas.getBoundingClientRect()) {
    if (!(r.width > 0 && r.height > 0)) return null
    const [u, v] = clientToPicture(e.clientX, e.clientY, r)
    return { x: toUnits(u), y: toUnits(v) }
  }

  onPointerDown(e) {
    if (!e.isPrimary || e.button !== 0 || !this.ov || !this.draft || this.busy || !hasFreePosition(this.draft)) return
    const at = this.unitsAt(e)
    if (!at) return
    e.preventDefault()
    e.stopPropagation()
    // grab by the offset from the overlay's anchor, so a drag on the box does not make it jump
    this.drag = { id: e.pointerId, dx: this.draft.x - at.x, dy: this.draft.y - at.y, moved: false, x: e.clientX, y: e.clientY }
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {}
  }

  onPointerMove(e) {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < MOVE_PX) return
    d.moved = true
    const at = this.unitsAt(e)
    if (!at) return
    // a tap (no move yet) placed the anchor under the finger; a drag keeps the grab offset
    this.draft.x = Math.min(OSD_MAX, Math.max(0, at.x + d.dx))
    this.draft.y = Math.min(OSD_MAX, Math.max(0, at.y + d.dy))
    this.update()
    this.draw()
  }

  onPointerUp(e) {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    this.drag = null
    if (!d.moved) {
      // a tap places the overlay there
      const at = this.unitsAt(e)
      if (at) {
        this.draft.x = at.x
        this.draft.y = at.y
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
    const fields = changedFields(this.osd, this.draft)
    if (Object.keys(fields).length === 0) return
    const summary = changeSummary(this.osd, this.draft)
    const ok = await this.dialog({
      title: 'Change what this camera burns into its picture?',
      lead: 'This is part of every recording from now on and cannot be edited out of footage later. It changes:',
      items: summary,
      action: 'Save to camera'
    })
    if (!ok) {
      this.status('Nothing was sent.')
      return
    }
    // the values to put back, for Undo: the camera's current reading of exactly the fields we change
    const before = {}
    for (const f of Object.keys(fields)) if (this.osd[f] !== null && this.osd[f] !== undefined) before[f] = this.osd[f]
    await this.send({ ...fields, confirm: true }, { verb: 'Saving', undoFields: before })
  }

  async undoLast() {
    if (!this.undo || this.busy) return
    if (!this.confirmDiscard()) return
    const ok = await this.dialog({
      title: 'Put back the previous OSD?',
      lead: 'This writes the previous name, switches and position back into the camera (and into its recordings from now on). It sets:',
      items: changeSummary(this.osd, { ...draftOf(this.osd), ...this.undo.fields }),
      action: 'Put it back'
    })
    if (!ok) return
    await this.send({ ...this.undo.fields, confirm: true }, { verb: 'Undoing', undoFields: null })
  }

  /** Sends a Save or an Undo, then shows the camera as read back and what happened to each field. */
  async send(body, { verb, undoFields }) {
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
    // keep Undo only when something was actually applied and we have values to put back
    if (undoFields && Object.keys(undoFields).length && result.applied) {
      this.undo = { fields: undoFields, at: Date.now(), by: 'you' }
    } else if (verb === 'Undoing') {
      this.undo = null
    }
    if (result.after) this.show(result.after)
    this.showResult(result)
    this.status('')
  }

  showResult(result) {
    const sent = result?.sent ?? {}
    const after = result?.after ?? null
    const label = { name: 'Name', showName: 'Show name', showTime: 'Show time', x: 'Position X', y: 'Position Y' }
    const valueText = (k, v) => (v === null || v === undefined ? '(none)' : k === 'showName' || k === 'showTime' ? (v ? 'on' : 'off') : String(v))
    const fields = Object.entries(sent).map(([k, want]) => {
      const got = after ? after[k] : undefined
      const ok = after && got === want
      return { ok, text: ok ? `${label[k] ?? k}: ${valueText(k, want)} (as asked)` : `${label[k] ?? k}: not applied (asked ${valueText(k, want)}, the camera has ${valueText(k, got)})` }
    })
    const good = fields.filter((f) => f.ok).length
    const status = fields.length === 0 ? 'unknown' : result.applied ? 'done' : good > 0 ? 'partial' : 'failed'
    const headline = {
      done: 'Saved: the camera reports every change as asked.',
      partial: 'Partly saved: the camera kept some of it (below).',
      failed: 'Not saved: the camera kept its settings.',
      unknown: 'Sent, but the camera could not be read back afterwards.'
    }[status]
    const box2 = this.$('.osd-result')
    box2.className = `ip-result osd-result ip-${status}`
    box2.replaceChildren(
      el('p', {}, headline),
      result.warning && status !== 'done' ? el('p', { className: 'ln-note' }, result.warning) : '',
      fields.length ? el('ul', {}, fields.map((f) => el('li', { className: f.ok ? 'ln-ok' : 'ln-no' }, f.text))) : ''
    )
    box2.hidden = false
  }
}
