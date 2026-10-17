// Four of a camera's own detections (admins), in the camera editor on the Sites page: Motion,
// Sterile area, Item monitoring and Fault. One panel, told which kind it is. The camera does the
// detecting; this shows its settings and, where saving is switched on, changes them through the
// NVR (camera-cfg.mjs). Modelled on the OSD and Lines panels so it matches the app.
//
// The form is built from what the server read off the camera: only the settings that camera has
// are shown. For a sterile area and for item monitoring the zones are drawn over the live picture
// (the camera's own 0..10000 units, origin top-left, as lines-panel.js): tap to put down the
// first corners, drag a corner to move it, press on a side to add a corner there, double-click a
// corner to take it out (never below four), Clear to start a zone again.
//
// Nothing reaches the camera without a click on Save. Save sends only what changed; the server
// reads the camera again, writes, reads it back and says which changes the camera does not show.
// A camera without the detection gets a sentence in place of the form; a kind whose saving is
// not switched on yet (the server's write gate) gets the form greyed out, with the reason.
//
// The pure parts (the draft, the change to send, its wording) are exported for node tests.
import { clientToPicture, objectPosition, overlayBox, pictureRect, pictureToOverlay } from './colour-check-ui.js'

export const KIND_LABEL = { motion: 'Motion', perimeter: 'Sterile area', osc: 'Item monitoring', avd: 'Fault' }
const HELP = {
  motion: 'The camera\'s own motion detection: what the recorder treats as movement, and what it does about it.',
  perimeter: 'An alarm when a person or vehicle enters a zone you draw on the picture. Tap the picture to put down a zone\'s corners; drag a corner to move it, press on a side to add one, double-click a corner to take it out.',
  osc: 'An alarm when something is left in, or taken from, a zone you draw on the picture. Tap the picture to put down the zone\'s corners; drag a corner to move it, press on a side to add one, double-click a corner to take it out.',
  avd: 'An alarm when the picture itself goes wrong: the camera has been moved or covered, has gone out of focus, or its colour has shifted.'
}
const ON_WORDS = { motion: 'Motion detection on', perimeter: 'Sterile area on', osc: 'Item monitoring on' }
const SWITCH_WORDS = { sceneChange: 'Alarm when the scene changes (camera moved or covered)', clarityAbnormal: 'Alarm when the picture is blurred', colorAbnormal: 'Alarm when the colour is wrong' }
const OSC_WORDS = { abandum: 'Items left behind', objstolen: 'Items taken away' }
const CLASS_WORDS = { person: 'People', car: 'Cars', motor: 'Motorbikes' }
const CLASS_ORDER = ['person', 'car', 'motor']
const TRIGGER_ORDER = ['record', 'snapshot', 'push', 'buzzer', 'popVideo', 'email']
export const TRIGGER_WORDS = { record: 'Record', snapshot: 'Snapshot', push: 'Push message to phones', buzzer: 'Buzzer on the recorder', popVideo: 'Pop-up video', email: 'Email' }
const AREA_WORDS = { all: 'Detection area: the whole picture (change it on the recorder).', none: 'Detection area: nothing is watched (change it on the recorder).' }
const NO_SCHEDULE_NAME = 'None (never detects)'
/** The settings each half of motion holds: they are saved separately (camera-cfg.mjs). */
const MOTION_PARAM_KEYS = ['enabled', 'sensitivity', 'holdTime']

export const UNITS = 10000
const ZONE_COLOURS = ['#ffd23f', '#3fd0ff', '#ff6bd6', '#7dff6b']
const MOVE_PX = 4 // a press that moved less than this is a tap
const REACH_PX = { touch: 22, pen: 12, mouse: 10 } // how far from a corner or a side a press still picks it up

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('aria-') || k === 'role' || k === 'for') n.setAttribute(k, v === true ? 'true' : String(v))
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

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---- pure: the draft and the change ---------------------------------------------------------------

/** What the admin edits: a copy of the settings the camera has, in the names a change uses. */
export function draftOf(view) {
  const d = {}
  for (const k of ['enabled', 'holdTime', 'schedule', 'oscType']) if (view?.[k] !== undefined && view[k] !== null) d[k] = view[k]
  if (view?.sensitivity) d.sensitivity = view.sensitivity.value
  if (view?.switches) d.switches = { ...view.switches }
  if (view?.zones) d.zones = view.zones.map((z) => z.points.map((p) => ({ x: p.x, y: p.y })))
  if (view?.filter) d.filter = Object.fromEntries(Object.entries(view.filter).map(([k, c]) => [k, { on: c.on, sensitivity: c.sensitivity }]))
  if (view?.trigger) d.trigger = { ...view.trigger }
  return d
}

const changedKeys = (from, to) => Object.fromEntries(Object.entries(to ?? {}).filter(([k, v]) => from?.[k] !== v))

/** The change to send: only what differs from what the camera has. {} when nothing does. */
export function changeOf(view, draft) {
  const c = {}
  if (!view || !draft) return c
  for (const k of ['enabled', 'holdTime', 'schedule', 'oscType']) if (k in draft && draft[k] !== view[k]) c[k] = draft[k]
  if (view.sensitivity && draft.sensitivity !== view.sensitivity.value) c.sensitivity = draft.sensitivity
  if (draft.switches && Object.keys(changedKeys(view.switches, draft.switches)).length) c.switches = changedKeys(view.switches, draft.switches)
  // the zones go as a whole: every zone, changed or not
  if (draft.zones && !same(draft.zones, view.zones.map((z) => z.points))) c.zones = draft.zones.map((z) => z.map((p) => ({ x: p.x, y: p.y })))
  if (draft.filter) {
    const f = {}
    for (const [k, v] of Object.entries(draft.filter)) {
      const bits = changedKeys(view.filter[k], v)
      if (Object.keys(bits).length) f[k] = bits
    }
    if (Object.keys(f).length) c.filter = f
  }
  if (draft.trigger && Object.keys(changedKeys(view.trigger, draft.trigger)).length) c.trigger = changedKeys(view.trigger, draft.trigger)
  return c
}

/** A change in words, one line per setting: what Save lists before it sends. */
export function changeLines(change, schedules = []) {
  const onOff = (v) => (v ? 'on' : 'off')
  const out = []
  if ('enabled' in change) out.push(`Detection: ${onOff(change.enabled)}`)
  for (const [k, v] of Object.entries(change.switches ?? {})) out.push(`${SWITCH_WORDS[k] ?? k}: ${onOff(v)}`)
  if ('oscType' in change) out.push(`Watch for: ${OSC_WORDS[change.oscType] ?? change.oscType}`)
  if ('holdTime' in change) out.push(`Hold the alarm for: ${change.holdTime} seconds`)
  if ('sensitivity' in change) out.push(`Sensitivity: ${change.sensitivity}`)
  if ('schedule' in change) out.push(`Active during: ${schedules.find((s) => s.id === change.schedule)?.name ?? NO_SCHEDULE_NAME}`)
  if ('zones' in change) out.push(`Zones: ${change.zones.map((z, i) => `${i + 1} ${z.length ? `(${plural(z.length, 'corner')})` : '(none)'}`).join(', ')}`)
  for (const [k, v] of Object.entries(change.filter ?? {})) {
    if ('on' in v) out.push(`Detect ${(CLASS_WORDS[k] ?? k).toLowerCase()}: ${onOff(v.on)}`)
    if ('sensitivity' in v) out.push(`${CLASS_WORDS[k] ?? k} sensitivity: ${v.sensitivity}`)
  }
  for (const [k, v] of Object.entries(change.trigger ?? {})) out.push(`${TRIGGER_WORDS[k] ?? k}: ${onOff(v)}`)
  return out
}

/** A motion change as its two saves, in the order they are sent: [{ part, change }]. */
export function motionParts(change) {
  const param = Object.fromEntries(Object.entries(change).filter(([k]) => MOTION_PARAM_KEYS.includes(k)))
  const trigger = Object.fromEntries(Object.entries(change).filter(([k]) => !MOTION_PARAM_KEYS.includes(k)))
  return [{ part: 'param', change: param }, { part: 'trigger', change: trigger }].filter((p) => Object.keys(p.change).length)
}

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
const within = (a, b, p) => Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y)
function segmentsMeet(a, b, c, d) {
  const d1 = cross(a, b, c)
  const d2 = cross(a, b, d)
  const d3 = cross(c, d, a)
  const d4 = cross(c, d, b)
  if (d1 * d2 < 0 && d3 * d4 < 0) return true
  return (d1 === 0 && within(a, b, c)) || (d2 === 0 && within(a, b, d)) || (d3 === 0 && within(c, d, a)) || (d4 === 0 && within(c, d, b))
}

/** Whether a closed shape crosses itself or has no area: the server's rule (camera-cfg-xml.mjs selfCrossing). */
export function selfCrossing(points) {
  const n = points.length
  if (n < 3) return false
  let area = 0
  for (let i = 0; i < n; i++) area += points[i].x * points[(i + 1) % n].y - points[(i + 1) % n].x * points[i].y
  if (area === 0) return true
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue
      if (segmentsMeet(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return true
    }
  }
  return false
}

/** Why a zone cannot be saved as drawn, or '' (an empty zone is fine: it is simply not used). */
export function zoneProblem(points, min, max) {
  if (points.length === 0) return ''
  if (points.length < min) return `needs at least ${min} corners`
  if (points.length > max) return `can have at most ${max} corners`
  return selfCrossing(points) ? 'crosses itself' : ''
}

/** How far the point p is from the segment a-b, and where along it (0..1) the nearest point is. */
export function nearSegment(p, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
  return { t, dist: Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) }
}

// ---- the panel -----------------------------------------------------------------------------------

export class CameraCfgPanel {
  /**
   * @param {HTMLElement} host where the panel goes (the editor's tab body)
   * @param {{ nvr: string, ch: number, name: string }} cam the camera (ch 0-based, as /api/cameras)
   * @param {{ kind: 'motion' | 'perimeter' | 'osc' | 'avd', liveEl: HTMLElement | (() => HTMLElement | null), onClose?: () => void }} opts
   *   liveEl: the element the live picture is drawn in, or a function giving the current one
   */
  constructor(host, cam, { kind, liveEl, onClose = null } = {}) {
    this.host = host
    this.cam = cam
    this.kind = kind
    this.liveEl = liveEl
    this.onClose = onClose
    this.data = null // GET .../cfg/<kind>: { supported, model, schedules, writable, why, parts? }
    this.view = null // data.model, kept up to date from each read-back
    this.draft = null // draftOf(view), as the admin changes it
    this.selected = 0 // the zone a tap on the picture adds to
    this.drag = null // a press on the picture: { id, zone, point, moved, x, y }
    this.syncs = [] // one per control: sets it from the draft
    this.busy = false
    this.sending = 0
    this.session = 0 // bumped on close: late answers for a closed panel are ignored
    this.loadSeq = 0
    this.isOpen = false
    this.ov = null
    this.layoutKey = ''
    this.onResize = () => this.layout()
    this.build()
  }

  get change() {
    return this.view && this.draft ? changeOf(this.view, this.draft) : {}
  }

  /** Unsaved changes, counted as Save lists them. */
  get dirty() {
    return changeLines(this.change).length
  }

  get hasZones() {
    return Array.isArray(this.draft?.zones)
  }

  url() {
    return `/api/admin/nvrs/${encodeURIComponent(this.cam.nvr)}/channels/${this.cam.ch}/cfg/${this.kind}`
  }

  build() {
    const label = KIND_LABEL[this.kind]
    this.head = el('h2', { tabIndex: -1 }, `${label} `, el('span', { className: 'ip-cam' }, `· ${this.cam.ch + 1} ${this.cam.name ?? ''}`))
    this.warn = el('p', { className: 'ln-warn', hidden: true })
    this.form = el('div', { className: 'cc-form' })
    this.result = el('div', { className: 'ip-result cc-result', hidden: true })
    this.errorEl = el('p', { className: 'ip-error', role: 'alert' })
    this.statusEl = el('p', { className: 'ip-status', role: 'status' })
    this.revertBtn = el('button', { type: 'button', className: 'ip-revert' }, 'Revert')
    this.saveBtn = el('button', { type: 'button', className: 'ip-apply cc-save' }, 'Save')
    this.actions = el('div', { className: 'ip-actions', hidden: true }, this.revertBtn, this.saveBtn)
    this.el = el('aside', { className: 'img-panel cc-panel', 'aria-label': label },
      el('div', { className: 'ip-head' }, this.head),
      el('p', { className: 'ln-help' }, HELP[this.kind]),
      this.warn, this.form, this.result, this.errorEl, this.statusEl, this.actions)
    this.revertBtn.addEventListener('click', () => this.revert())
    this.saveBtn.addEventListener('click', () => this.save())

    // the drawing, over the live picture (the OSD and Lines panels' canvas and shield)
    this.shield = el('div', { className: 'ln-shield cc-shield', hidden: true })
    this.canvas = el('canvas', { className: 'ln-overlay cc-overlay', hidden: true, 'aria-label': 'The camera picture: tap to put down a zone\'s corners, drag a corner to move it' })
    this.ctx = this.canvas.getContext('2d')
    for (const n of [this.shield, this.canvas]) {
      n.addEventListener('click', (e) => e.stopPropagation())
      n.addEventListener('dblclick', (e) => e.stopPropagation())
    }
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e))
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e))
    this.canvas.addEventListener('pointercancel', (e) => this.onPointerCancel(e))
    this.canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e))
  }

  open() {
    if (this.isOpen || typeof document === 'undefined') return
    this.isOpen = true
    this.session++
    this.host.append(this.el)
    window.addEventListener('resize', this.onResize)
    this.layoutTimer = setInterval(() => this.layout(), 400)
    this.layout()
    this.load()
  }

  confirmDiscard(n = this.dirty) {
    if (this.sending > 0) return window.confirm('A change is being saved to the camera. If you leave now its result will not be shown here; the change goes ahead. Leave anyway?')
    return n === 0 || window.confirm(`Discard ${plural(n, 'unsaved change')}?`)
  }

  close() {
    if (!this.isOpen) return
    this.isOpen = false
    this.session++
    this.loadSeq++
    clearInterval(this.layoutTimer)
    window.removeEventListener('resize', this.onResize)
    for (const n of [this.el, this.shield, this.canvas]) n.remove()
    this.drag = null
    this.busy = false
    this.sending = 0
    this.onClose?.()
  }

  status(text, { error = false } = {}) {
    this.statusEl.textContent = error ? '' : text
    this.errorEl.textContent = error ? text : ''
  }

  // ---- reading -----------------------------------------------------------------------------------

  async load() {
    const seq = ++this.loadSeq
    this.busy = true
    this.status('Reading the camera\'s settings…')
    try {
      const r = await api('GET', this.url())
      if (seq !== this.loadSeq) return
      if (!r.ok) throw new Error(r.data?.error || `HTTP ${r.status}`)
      this.busy = false
      this.show(r.data)
      this.status('')
    } catch (e) {
      if (seq !== this.loadSeq) return
      this.busy = false
      this.status(e.message, { error: true })
    }
  }

  /** A fresh answer from the server: the whole form is built again from it. */
  show(data) {
    this.data = data
    this.view = data?.supported ? data.model : null
    this.draft = this.view ? draftOf(this.view) : null
    this.selected = 0
    this.render()
    this.update()
    this.layout()
    this.draw()
  }

  /** Whether a group of settings can be saved: the server's write gate, and the camera's own state. */
  canWrite(part = null) {
    if (!this.view || this.view.blocked) return false
    if (this.kind === 'motion' && part) return this.data?.parts?.[part]?.writable === true
    return this.data?.writable === true
  }

  // ---- the form ----------------------------------------------------------------------------------

  /** One control: `sync` sets it from the draft and greys it out when it cannot be changed. */
  control(node, input, part, sync) {
    this.syncs.push(() => {
      sync()
      input.disabled = this.busy || !this.canWrite(part)
    })
    return node
  }

  edit(fn) {
    if (!this.draft || this.busy) return this.update()
    fn()
    this.update()
    this.draw()
  }

  checkRow(text, part, get, set) {
    const input = el('input', { type: 'checkbox' })
    input.addEventListener('change', () => this.edit(() => set(input.checked)))
    return this.control(el('label', { className: 'ip-switch' }, input, ` ${text}`), input, part, () => { input.checked = get() === true })
  }

  selectRow(text, part, options, get, set) {
    const select = el('select', {}, options.map(([value, word]) => new Option(word, value)))
    select.addEventListener('change', () => this.edit(() => set(select.value)))
    return this.control(el('label', { className: 'ln-row' }, text, ' ', select), select, part, () => { if (document.activeElement !== select) select.value = String(get()) })
  }

  rangeRow(text, part, min, max, get, set) {
    const out = el('span', { className: 'cc-num' })
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: '1' })
    input.addEventListener('input', () => this.edit(() => set(Number(input.value))))
    return this.control(el('label', { className: 'ln-range' }, el('span', {}, text), out, input), input, part, () => {
      input.value = String(get())
      out.textContent = String(get())
    })
  }

  /** Why this group is greyed out when the rest of the form is not (motion's two halves). */
  partNote(part) {
    const p = this.data?.parts?.[part]
    return this.kind === 'motion' && this.data?.writable && p && !p.writable ? el('p', { className: 'ln-note' }, p.why) : ''
  }

  render() {
    this.syncs = []
    this.zoneRows = []
    const v = this.view
    const d = this.draft
    this.actions.hidden = !v
    if (!v) {
      // no form: the camera does not have this, or would not say
      this.warn.hidden = true
      this.form.replaceChildren(this.data ? el('p', { className: 'cc-none' }, this.data.why || 'This camera does not have this setting.') : '')
      return
    }
    const why = v.blocked || (!this.data.writable ? this.data.why : '')
    const conflicts = v.conflicts?.length ? `This camera cannot run this together with: ${v.conflicts.join(', ')} (on now).` : ''
    this.warn.textContent = [why, conflicts].filter(Boolean).join(' ')
    this.warn.hidden = !this.warn.textContent

    const main = el('section', { className: 'ln-box' })
    if ('enabled' in d) main.append(this.checkRow(ON_WORDS[this.kind], 'param', () => d.enabled, (on) => { this.draft.enabled = on }))
    for (const k of Object.keys(d.switches ?? {})) main.append(this.checkRow(SWITCH_WORDS[k] ?? k, null, () => this.draft.switches[k], (on) => { this.draft.switches[k] = on }))
    if ('oscType' in d) {
      main.append(this.selectRow('Watch for', null, v.oscTypes.map((t) => [t, OSC_WORDS[t] ?? t]), () => this.draft.oscType, (t) => { this.draft.oscType = t }))
    }
    if (v.sensitivity) main.append(this.rangeRow('Sensitivity', 'param', v.sensitivity.min, v.sensitivity.max, () => this.draft.sensitivity, (n) => { this.draft.sensitivity = n }))
    if (v.holdChoices?.length) {
      main.append(this.selectRow('Hold the alarm for', 'param', v.holdChoices.map((s) => [String(s), `${s} seconds`]), () => this.draft.holdTime, (s) => { this.draft.holdTime = Number(s) }))
    }
    if ('schedule' in d) {
      const list = (this.data.schedules ?? []).map((s) => [s.id, s.name])
      // the one in use is always a choice, also when the recorder's list could not be read
      if (v.schedule !== v.noSchedule && !list.some(([id]) => id === v.schedule)) list.push([v.schedule, 'The schedule in use now'])
      main.append(this.selectRow('Active during', 'trigger', [[v.noSchedule, NO_SCHEDULE_NAME], ...list], () => this.draft.schedule, (id) => { this.draft.schedule = id }))
    }
    if (this.kind === 'motion') main.append(el('p', { className: 'ln-note' }, AREA_WORDS[v.area] ?? 'Detection area: set on the recorder.'))
    const boxes = [main]

    if (this.hasZones) {
      const box = el('section', { className: 'ln-box', 'aria-label': 'Zones' })
      if (!v.zonesEditable) box.append(el('p', { className: 'ln-note' }, 'This camera\'s zones are rectangles: set them on the recorder.'))
      const list = el('ol', { className: 'ln-slots' })
      d.zones.forEach((_z, i) => {
        const pick = el('button', { type: 'button', className: 'ln-pick' }, el('span', { className: 'ln-swatch' }), `Zone ${i + 1}`)
        pick.firstChild.style.background = ZONE_COLOURS[i % ZONE_COLOURS.length]
        const state = el('span', { className: 'ln-state' })
        const clear = el('button', { type: 'button' }, 'Clear')
        pick.addEventListener('click', () => { this.selected = i; this.update(); this.draw() })
        clear.addEventListener('click', () => this.edit(() => { this.draft.zones[i] = []; this.selected = i }))
        const row = el('li', { className: 'ln-slot cc-zone' }, pick, state, clear)
        this.zoneRows.push({ row, pick, state, clear })
        list.append(row)
      })
      box.append(list)
      boxes.push(box)
    }

    if (d.filter) {
      const box = el('section', { className: 'ln-box', 'aria-label': 'What counts' }, el('p', { className: 'ln-note' }, 'What sets it off:'))
      for (const k of CLASS_ORDER.filter((c) => d.filter[c])) {
        box.append(this.checkRow(CLASS_WORDS[k], null, () => this.draft.filter[k].on, (on) => { this.draft.filter[k].on = on }))
        box.append(this.rangeRow(`${CLASS_WORDS[k]} sensitivity`, null, v.filter[k].min, v.filter[k].max, () => this.draft.filter[k].sensitivity, (n) => { this.draft.filter[k].sensitivity = n }))
      }
      boxes.push(box)
    }

    if (d.trigger) {
      const box = el('section', { className: 'ln-box', 'aria-label': 'When it triggers' }, el('p', { className: 'ln-note' }, 'When it triggers:'))
      for (const k of TRIGGER_ORDER.filter((t) => typeof d.trigger[t] === 'boolean')) {
        box.append(this.checkRow(TRIGGER_WORDS[k], 'trigger', () => this.draft.trigger[k], (on) => { this.draft.trigger[k] = on }))
      }
      box.append(this.partNote('trigger'))
      boxes.push(box)
    }
    main.append(this.partNote('param'))
    this.form.replaceChildren(...boxes)
  }

  /** Why the zones cannot be saved as drawn: the first one that is wrong, in words. '' when fine. */
  zonesProblem() {
    if (!this.hasZones) return ''
    for (const [i, z] of this.draft.zones.entries()) {
      const why = zoneProblem(z, this.view.minPoints, this.view.maxPoints)
      if (why) return `Zone ${i + 1} ${why}.`
    }
    return ''
  }

  revert() {
    if (!this.view || this.busy) return
    this.draft = draftOf(this.view)
    this.status('')
    this.update()
    this.draw()
  }

  update() {
    for (const s of this.syncs) s()
    const canZones = this.canWrite() && this.view?.zonesEditable
    this.zoneRows?.forEach((r, i) => {
      const z = this.draft.zones[i]
      const why = zoneProblem(z, this.view.minPoints, this.view.maxPoints)
      const changed = !same(z, this.view.zones[i].points)
      r.row.classList.toggle('ln-current', i === this.selected)
      r.row.classList.toggle('ln-changed', changed)
      r.pick.setAttribute('aria-pressed', String(i === this.selected))
      r.state.textContent = z.length === 0 ? 'not drawn' : why ? `${plural(z.length, 'corner')}: ${why}` : `${plural(z.length, 'corner')}${changed ? ' (changed)' : ''}`
      r.clear.disabled = this.busy || !canZones || z.length === 0
    })
    const n = this.dirty
    const problem = n ? this.zonesProblem() : ''
    this.saveBtn.textContent = n ? `Save ${plural(n, 'change')}` : 'Save'
    this.saveBtn.disabled = this.busy || !this.view || n === 0 || Boolean(problem) || !this.data?.writable || Boolean(this.view.blocked)
    this.revertBtn.disabled = this.busy || n === 0
    if (problem) this.status(problem, { error: true })
    else if (this.errorEl.textContent.startsWith('Zone ')) this.status('')
    this.canvas.classList.toggle('ln-locked', this.busy || !canZones)
  }

  // ---- the drawing -------------------------------------------------------------------------------

  videoEl() {
    try {
      return (typeof this.liveEl === 'function' ? this.liveEl() : this.liveEl) ?? null
    } catch {
      return null
    }
  }

  /** Keeps the canvas exactly over the picture (the OSD panel's layout: the live canvas comes and goes). */
  layout() {
    if (!this.isOpen) return
    const video = this.hasZones ? this.videoEl() : null
    const tile = video?.isConnected ? video.closest('.tile') : null
    if (!tile) {
      if (this.layoutKey !== 'gone') {
        this.layoutKey = 'gone'
        this.ov = null
        this.canvas.hidden = true
        this.shield.hidden = true
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
      this.shield.hidden = true
      return
    }
    const o = overlayBox(pic, hostBox, dpr)
    Object.assign(this.canvas.style, { left: `${o.left}px`, top: `${o.top}px`, width: `${o.width}px`, height: `${o.height}px` })
    if (this.canvas.width !== o.backingWidth) this.canvas.width = o.backingWidth
    if (this.canvas.height !== o.backingHeight) this.canvas.height = o.backingHeight
    this.canvas.hidden = false
    this.shield.hidden = false
    this.ov = o
    this.draw()
  }

  /** Every zone as drawn now: the selected one on top with its corners; one that cannot be saved in red. */
  draw() {
    const g = this.ctx
    const ov = this.ov
    if (!g || !ov) return
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, ov.backingWidth, ov.backingHeight)
    if (!this.hasZones) return
    const k = ov.backingWidth / Math.max(1, ov.width)
    const order = this.draft.zones.map((_z, i) => i).sort((a, b) => (a === this.selected) - (b === this.selected))
    for (const i of order) {
      const pts = this.draft.zones[i].map((p) => pictureToOverlay([p.x / UNITS, p.y / UNITS], ov))
      if (!pts.length) continue
      const current = i === this.selected
      const bad = Boolean(zoneProblem(this.draft.zones[i], this.view.minPoints, this.view.maxPoints))
      const colour = bad ? '#ff6b6b' : ZONE_COLOURS[i % ZONE_COLOURS.length]
      g.beginPath()
      pts.forEach(([x, y], j) => (j ? g.lineTo(x, y) : g.moveTo(x, y)))
      if (pts.length > 2) g.closePath()
      g.globalAlpha = current ? 0.22 : 0.12
      g.fillStyle = colour
      if (pts.length > 2) g.fill()
      g.globalAlpha = 1
      // a dark edge under the colour, so the outline shows on any picture
      g.lineJoin = 'round'
      g.strokeStyle = 'rgba(0,0,0,0.7)'
      g.lineWidth = (current ? 5 : 4) * k
      g.stroke()
      g.strokeStyle = colour
      g.lineWidth = (current ? 2.5 : 1.5) * k
      g.stroke()
      for (const [x, y] of pts) {
        g.beginPath()
        g.arc(x, y, (current ? 6 : 4) * k, 0, Math.PI * 2)
        g.fillStyle = current ? '#fff' : colour
        g.fill()
        g.strokeStyle = 'rgba(0,0,0,0.8)'
        g.lineWidth = 1.5 * k
        g.stroke()
      }
      g.font = `600 ${Math.round(13 * k)}px system-ui, sans-serif`
      g.textBaseline = 'bottom'
      g.fillStyle = '#fff'
      g.strokeStyle = 'rgba(0,0,0,0.8)'
      g.lineWidth = 3 * k
      g.strokeText(String(i + 1), pts[0][0] + 8 * k, pts[0][1] - 6 * k)
      g.fillText(String(i + 1), pts[0][0] + 8 * k, pts[0][1] - 6 * k)
    }
  }

  /** Where a pointer is on the picture, in the camera's units (held to the picture's edges). */
  unitsAt(e, r = this.canvas.getBoundingClientRect()) {
    if (!(r.width > 0 && r.height > 0)) return null
    const [u, v] = clientToPicture(e.clientX, e.clientY, r)
    const unit = (f) => Math.round(Math.min(1, Math.max(0, Number(f) || 0)) * UNITS)
    return { x: unit(u), y: unit(v) }
  }

  /** A zone's corners in CSS px of the canvas, for deciding what a press is on. */
  zonePx(i, r) {
    return this.draft.zones[i].map((p) => ({ x: (p.x / UNITS) * r.width, y: (p.y / UNITS) * r.height }))
  }

  /** The corner a press at CSS-px p picks up: { zone, point } (the selected zone first), or null. */
  cornerAt(p, r, reach) {
    const order = this.draft.zones.map((_z, i) => i).sort((a, b) => (b === this.selected) - (a === this.selected))
    for (const zone of order) {
      let best = null
      this.zonePx(zone, r).forEach((q, point) => {
        const dist = Math.hypot(q.x - p.x, q.y - p.y)
        if (dist <= reach && (!best || dist < best.dist)) best = { zone, point, dist }
      })
      if (best) return best
    }
    return null
  }

  /** The side of the selected zone a press at CSS-px p is on: the index a new corner goes in at, or -1. */
  sideAt(p, r, reach) {
    const pts = this.zonePx(this.selected, r)
    if (pts.length < 3) return -1
    let best = -1
    let bestDist = reach
    pts.forEach((a, i) => {
      const { dist } = nearSegment(p, a, pts[(i + 1) % pts.length])
      if (dist <= bestDist) { best = i + 1; bestDist = dist }
    })
    return best
  }

  canDraw() {
    return this.ov && this.hasZones && !this.busy && this.canWrite() && this.view.zonesEditable
  }

  onPointerDown(e) {
    if (!e.isPrimary || e.button !== 0 || !this.canDraw()) return
    const r = this.canvas.getBoundingClientRect()
    const at = this.unitsAt(e, r)
    if (!at) return
    e.preventDefault()
    e.stopPropagation()
    const p = { x: e.clientX - r.left, y: e.clientY - r.top }
    const reach = REACH_PX[e.pointerType] ?? REACH_PX.mouse
    let hit = this.cornerAt(p, r, reach)
    if (hit) this.selected = hit.zone
    else {
      const zone = this.draft.zones[this.selected]
      const side = this.sideAt(p, r, reach)
      // a press on a side puts a corner there; a tap elsewhere puts down the next of the first corners
      if (side >= 0 && zone.length < this.view.maxPoints) {
        zone.splice(side, 0, at)
        hit = { zone: this.selected, point: side, added: true }
      } else if (zone.length < this.view.minPoints) {
        zone.push(at)
        hit = { zone: this.selected, point: zone.length - 1, added: true }
      } else return
    }
    this.drag = { id: e.pointerId, zone: hit.zone, point: hit.point, moved: Boolean(hit.added), x: e.clientX, y: e.clientY }
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
    this.draft.zones[d.zone][d.point] = at
    this.update()
    this.draw()
  }

  onPointerUp(e) {
    if (!this.drag || e.pointerId !== this.drag.id) return
    this.drag = null
    this.update()
    this.draw()
  }

  onPointerCancel(e) {
    if (!this.drag || e.pointerId !== this.drag.id) return
    this.drag = null
    this.draw()
  }

  /** A double-click on a corner takes it out, but never leaves a zone with fewer than the minimum. */
  onDoubleClick(e) {
    if (!this.canDraw()) return
    const r = this.canvas.getBoundingClientRect()
    const hit = this.cornerAt({ x: e.clientX - r.left, y: e.clientY - r.top }, r, REACH_PX.mouse)
    if (!hit) return
    const zone = this.draft.zones[hit.zone]
    if (zone.length <= this.view.minPoints) {
      this.status(`A zone needs at least ${this.view.minPoints} corners. Use Clear to draw it again.`)
      return
    }
    this.edit(() => zone.splice(hit.point, 1))
  }

  // ---- sending -----------------------------------------------------------------------------------

  async save() {
    if (!this.view || this.busy) return
    const change = this.change
    const lines = changeLines(change, this.data.schedules ?? [])
    if (!lines.length || this.zonesProblem()) return
    if (!window.confirm(`Change this camera's ${KIND_LABEL[this.kind].toLowerCase()} settings?\n\n${lines.join('\n')}`)) {
      this.status('Nothing was sent.')
      return
    }
    // motion is two saves, one after the other; the second is not sent if the first fails
    const sends = this.kind === 'motion' ? motionParts(change) : [{ part: undefined, change }]
    const session = this.session
    this.busy = true
    this.result.hidden = true
    this.update()
    this.status('Saving… the camera is read back afterwards (a couple of seconds)')
    this.sending++
    const done = [] // each save's answer
    let failed = ''
    try {
      for (const s of sends) {
        const r = await api('POST', this.url(), { confirm: true, ...(s.part ? { part: s.part } : {}), change: s.change })
        if (session !== this.session) return
        if (!r.ok) {
          failed = r.data?.error || `HTTP ${r.status}`
          break
        }
        done.push(r.data ?? {})
        // the camera as read back: what the form now starts from
        if (r.data?.view) this.view = { ...this.view, ...r.data.view }
      }
    } catch (e) {
      failed = `Could not reach the server (${e.message}); open this tab again to see what the camera has.`
    } finally {
      if (session === this.session) this.sending--
    }
    if (session !== this.session) return
    this.busy = false
    const unread = done.some((r) => !r.view)
    if (done.length && !unread && !failed) {
      this.data = { ...this.data, model: this.view }
      this.draft = draftOf(this.view)
      this.render()
    }
    this.update()
    this.draw()
    this.showResult(done, failed)
    this.status(failed, { error: true })
  }

  showResult(done, failed) {
    if (!done.length) {
      this.result.hidden = true
      return
    }
    const word = (v) => (v === 'true' ? 'on' : v === 'false' ? 'off' : v === null || v === '' ? '(none)' : String(v))
    const differences = done.flatMap((r) => r.differences ?? [])
    const unread = done.some((r) => !r.view)
    const status = unread ? 'unknown' : differences.length ? 'partial' : 'done'
    const headline = {
      done: failed ? 'Partly saved: the first half is on the camera as asked; the second was not sent (below).' : 'Saved: the camera reports every change as asked.',
      partial: 'Saved, but the camera does not show all of it:',
      unknown: 'Sent, but the camera could not be read back afterwards: open this tab again to see what it has.'
    }[status]
    this.result.className = `ip-result cc-result ip-${failed && status === 'done' ? 'partial' : status}`
    this.result.replaceChildren(
      el('p', {}, headline),
      differences.length ? el('ul', {}, differences.map((d) => el('li', { className: 'ln-no' }, `${d.label ?? d.key}: asked ${word(d.wanted)}, the camera has ${word(d.got)}`))) : ''
    )
    this.result.hidden = false
  }
}
