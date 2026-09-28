// Line crossing for one camera (admins), over the full-size Live view: up to four lines drawn on the
// live picture for the camera's OWN line-crossing detection, and its settings (on/off, the
// person/vehicle filter the camera has, hold time, schedule). The camera does the detecting; the
// server writes the lines into it through the NVR (tripwire.mjs) and turns what it reports into
// events within seconds (alarm-watch.mjs).
//
// Nothing reaches the camera without a click on Save or Undo. The server reads the camera again
// first and refuses if anything changed since this panel was filled (409 stale), asks for the
// admin's acknowledgement of its warnings (409 needsAck + ackToken, shown here as the Picture
// panel's dialog), logs the change before sending it and reads it back field by field. The result
// is listed here and the lines are redrawn from what the camera then reports. "Alert my phone for
// this camera" changes only Argus's own "Line crossing" alarm rule (line-actions.mjs), never the
// camera; it is on by default: a Save that switches a camera's line crossing on adds the camera to
// the rule unless the admin has switched the alert off here.
//
// The drawing canvas lies exactly over the picture (colour-check-ui.js's tested maths: pictureRect,
// overlayBox, clientToPicture, pictureToOverlay); the line maths is lines-geom.js. viewer.js pauses
// pinch-zoom while the panel is open (a drag here draws).
//
// The pure parts (the change to send, the texts, the result view, the alert state) are exported
// for node tests (test/lines-panel.test.mjs); the DOM is only touched inside the LinesPanel class.
import { clientToPicture, loupeSpot, objectPosition, overlayBox, pictureRect, pictureToOverlay } from './colour-check-ui.js'
import { MIN_LINE_UNITS, arrowFor, hitTest, isSet, lineLength, nextDirection, slotForNewLine, toFrac, toUnits } from './lines-geom.js'

/** The alarm rule the phone alerts go through (line-actions.mjs LINE_RULE_NAME; that server module is not loaded here). */
export const LINE_RULE_NAME = 'Line crossing'
export const ALERT_URL = '/api/admin/lines/alert'
export const DIRECTION_WORDS = { rightortop: 'A → B', leftorbotton: 'B → A', none: 'A ↔ B' }
/** The filter's classes as the camera names them, in the order the panel shows them. */
export const CLASS_WORDS = { person: 'Person', car: 'Car', motor: 'Motorbike' }
const CLASS_ORDER = ['person', 'car', 'motor']
// The detections a camera lists in <mutexList> (tripwire-xml.mjs uses the same words in its warning).
const MUTEX_WORDS = {
  perimeter: 'intrusion zones', pea: 'intrusion zones', osc: 'abandoned/missing object detection', cdd: 'crowd density',
  cpc: 'people counting', ipd: 'people intrusion', tripwire: 'line crossing', vfd: 'face detection',
  avd: 'video exception detection', vehicle: 'number plate detection', aoientry: 'area entry', aoileave: 'area exit'
}
const FIELD_WORDS = {
  enabled: 'Line crossing', holdTime: 'Hold time', schedule: 'Schedule', 'filter.sensitivity': 'Sensitivity',
  triggerAudio: 'Camera sound trigger', triggerWhiteLight: 'Camera white-light trigger', saveTargetPicture: 'Save target picture',
  saveSourcePicture: 'Save source picture', autoTrack: 'Auto tracking'
}
const TRIGGER_WORDS = {
  rec: 'record cameras', alarmOuts: 'alarm outputs', presets: 'PTZ presets', snap: 'snapshot', msgPush: 'push message', buzzer: 'buzzer',
  popVideo: 'pop-up video', email: 'email', sysAudio: 'sound', recOn: 'record', alarmOutOn: 'alarm output', presetOn: 'PTZ preset',
  sysSnap: 'NVR snapshot', popMsg: 'pop-up message', manualAudio: 'manual sound', manualLight: 'manual light'
}
const ACK_WORDS = { mutex: 'a detection that cannot run beside it', 'no-filter': 'no person/vehicle filter', 'short-hold': 'a short hold time', 'no-lines': 'no line drawn' }
const HEADLINES = {
  done: 'Saved: the camera reports every change as asked.',
  partial: 'Partly saved: the camera kept some of it (below).',
  failed: 'Not saved: the camera kept its settings.',
  unknown: 'Sent, but the camera could not be read back: reopen this panel to see what it has.'
}
// Each slot's own colour, on the picture and beside its row: bright on any video, told apart at a glance.
const SLOT_COLOURS = ['#ffd23f', '#3fd0ff', '#ff6bd6', '#7dff6b']
const MOVE_PX = 4 // a press that moved less than this is a tap (on the arrow: turn the line)
const REACH_PX = { touch: 22, pen: 12, mouse: 10 } // how far from an end or the arrow a press still picks it up

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const copyLine = (l) => ({ direction: l.direction, start: { x: l.start.x, y: l.start.y }, end: { x: l.end.x, y: l.end.y } })
const sameLine = (a, b) => Boolean(a && b) && a.direction === b.direction && a.start.x === b.start.x && a.start.y === b.start.y && a.end.x === b.end.x && a.end.y === b.end.y

// ---- pure helpers (node-testable) -------------------------------------------------------------

/**
 * What the admin can change, as the panel keeps it while they work (a copy: cfg is untouched).
 * filter: null (none), { sensitivity } (one for everything) or { person: { on, sensitivity }, ... }.
 */
export function draftOf(cfg) {
  let filter = null
  if (cfg.filter?.kind === 'single') filter = { sensitivity: cfg.filter.sensitivity }
  if (cfg.filter?.kind === 'objects') filter = Object.fromEntries(Object.entries(cfg.filter.classes).map(([k, c]) => [k, { on: c.on, sensitivity: c.sensitivity }]))
  return { enabled: cfg.enabled, holdTime: cfg.holdTime, scheduleGuid: cfg.scheduleGuid, lines: cfg.lines.map(copyLine), filter }
}

/**
 * The change to send (POST .../lines `change`, tripwire-xml.mjs applyChange's shape): only what
 * differs from the camera's settings. The lines go as all four slots when any one differs (the
 * server takes the whole list; a cleared slot is all zeros and keeps its direction); the filter as
 * only the classes and values that changed. {} when nothing did.
 */
export function changeOf(cfg, draft) {
  const out = {}
  if (draft.enabled !== cfg.enabled) out.enabled = draft.enabled
  if (draft.holdTime !== cfg.holdTime) out.holdTime = draft.holdTime
  if (draft.scheduleGuid !== cfg.scheduleGuid) out.scheduleGuid = draft.scheduleGuid
  if (draft.lines.some((l, i) => !sameLine(l, cfg.lines[i]))) out.lines = draft.lines.map(copyLine)
  if (cfg.filter?.kind === 'single' && draft.filter.sensitivity !== cfg.filter.sensitivity) out.filter = { sensitivity: draft.filter.sensitivity }
  if (cfg.filter?.kind === 'objects') {
    const f = {}
    for (const [k, c] of Object.entries(cfg.filter.classes)) {
      const d = draft.filter[k]
      const one = {}
      if (d.on !== c.on) one.on = d.on
      if (d.sensitivity !== c.sensitivity) one.sensitivity = d.sensitivity
      if (Object.keys(one).length) f[k] = one
    }
    if (Object.keys(f).length) out.filter = f
  }
  return out
}

/** A schedule's name from the NVR's list, or its id when the list does not have it. */
const scheduleName = (id, schedules = []) => schedules.find((s) => s.id === id)?.name ?? id

/** What one slot shows beside its number: its state and whether it is saved. */
export function slotText(line, saved) {
  if (sameLine(line, saved)) return isSet(line) ? 'drawn' : 'not drawn'
  if (!isSet(line)) return 'cleared, not saved'
  if (!isSet(saved)) return 'new, not saved'
  const moved = line.start.x !== saved.start.x || line.start.y !== saved.start.y || line.end.x !== saved.end.x || line.end.y !== saved.end.y
  return moved ? 'moved, not saved' : 'turned, not saved'
}

/**
 * What a Save would change, one line each, in plain words: the Save button counts them, the
 * confirmation dialog lists them. [] when nothing changed.
 */
export function changeLines(cfg, draft, schedules = []) {
  const out = []
  const onOff = (v) => (v ? 'on' : 'off')
  if (draft.enabled !== cfg.enabled) out.push(`Line crossing: ${onOff(cfg.enabled)} → ${onOff(draft.enabled)}`)
  draft.lines.forEach((l, i) => {
    const was = cfg.lines[i]
    if (sameLine(l, was)) return
    const name = `Line ${i + 1}`
    if (!isSet(l)) out.push(`${name}: cleared`)
    else if (!isSet(was)) out.push(`${name}: new line (${DIRECTION_WORDS[l.direction] ?? l.direction})`)
    else {
      const moved = l.start.x !== was.start.x || l.start.y !== was.start.y || l.end.x !== was.end.x || l.end.y !== was.end.y
      const turned = l.direction !== was.direction
      out.push(`${name}: ${[moved ? 'moved' : '', turned ? `direction now ${DIRECTION_WORDS[l.direction] ?? l.direction}` : ''].filter(Boolean).join(', ')}`)
    }
  })
  if (cfg.filter?.kind === 'single' && draft.filter.sensitivity !== cfg.filter.sensitivity) out.push(`Sensitivity: ${cfg.filter.sensitivity} → ${draft.filter.sensitivity}`)
  if (cfg.filter?.kind === 'objects') {
    for (const k of CLASS_ORDER) {
      const c = cfg.filter.classes[k]
      const d = draft.filter[k]
      if (!c || !d) continue
      if (d.on !== c.on) out.push(`${CLASS_WORDS[k]}: ${onOff(c.on)} → ${onOff(d.on)}`)
      if (d.sensitivity !== c.sensitivity) out.push(`${CLASS_WORDS[k]} sensitivity: ${c.sensitivity} → ${d.sensitivity}`)
    }
  }
  if (draft.holdTime !== cfg.holdTime) out.push(`Hold time: ${cfg.holdTime} s → ${draft.holdTime} s`)
  if (draft.scheduleGuid !== cfg.scheduleGuid) out.push(`Schedule: ${scheduleName(cfg.scheduleGuid, schedules)} → ${scheduleName(draft.scheduleGuid, schedules)}`)
  return out
}

/** "Save", "Save 1 change", "Save 3 changes". */
export const saveLabel = (n) => (n ? `Save ${plural(n, 'change')}` : 'Save')

/**
 * The schedule choices: the NVR's list, with the camera's own first-hand value added when the
 * list does not have it (or could not be read), so the select never shows something else.
 */
export function scheduleChoices(cfg, schedules = []) {
  const list = schedules.map((s) => ({ id: s.id, name: s.name }))
  if (!list.some((s) => s.id === cfg.scheduleGuid)) list.unshift({ id: cfg.scheduleGuid, name: schedules.length ? 'the camera\'s current schedule (not in the NVR\'s list)' : 'the camera\'s current schedule' })
  return list
}

/** The detections that cannot run beside line crossing and are on now, in words. */
export function mutexOn(cfg) {
  return [...new Set((cfg?.mutex ?? []).filter((m) => m.on).map((m) => MUTEX_WORDS[m.object] ?? m.object))]
}

/**
 * Why nothing may be changed on this camera from here, or null: its own sound or white-light
 * trigger is on (the server refuses every change then; the floodlight is worked by hand only).
 */
export function blockedText(cfg) {
  if (!cfg?.triggerAudio && !cfg?.triggerWhiteLight) return null
  const what = [cfg.triggerAudio ? 'sound' : '', cfg.triggerWhiteLight ? 'white-light' : ''].filter(Boolean).join(' and ')
  return `This camera's ${what} trigger is on for line crossing. Nothing can be changed here until it is set off on the NVR itself: the floodlight and sirens are worked by hand only.`
}

/** What Undo puts back, and when and by whom the change it undoes was made. */
export function undoText(undo) {
  if (!undo) return null
  const at = new Date(undo.at)
  return `Undo puts back the line settings from before the last change (made ${Number.isFinite(at.getTime()) ? at.toLocaleString() : undo.at} by ${undo.by}).`
}

/** A read-back field's name ('line.0.start' -> 'Line 1 start'). */
export function fieldLabel(key) {
  const line = /^line\.(\d+)\.(\w+)$/.exec(key)
  if (line) return `Line ${Number(line[1]) + 1} ${line[2]}`
  const cls = /^filter\.(\w+)\.(on|sensitivity|min|max)$/.exec(key)
  if (cls) return `${CLASS_WORDS[cls[1]] ?? cls[1]}${{ on: '', sensitivity: ' sensitivity', min: ' smallest size', max: ' largest size' }[cls[2]]}`
  const mutex = /^mutex\.(\w+?)(?:\.\d+)?$/.exec(key)
  if (mutex) return `${MUTEX_WORDS[mutex[1]] ?? mutex[1]} (cannot run beside line crossing)`
  const trig = /^trigger\.(\w+)$/.exec(key)
  if (trig) return `NVR action: ${TRIGGER_WORDS[trig[1]] ?? trig[1]}`
  return FIELD_WORDS[key] ?? key
}

/** A read-back value as the admin reads it (flatten()'s strings: 'true', '20', '1200,3400', a schedule id). */
export function valueText(key, v, schedules = []) {
  if (v === null || v === undefined) return '(none)'
  if (v === 'true' || v === 'false') return v === 'true' ? 'on' : 'off'
  if (/\.direction$/.test(key)) return DIRECTION_WORDS[v] ?? String(v)
  if (key === 'holdTime') return `${v} s`
  if (key === 'schedule') return scheduleName(v, schedules)
  return String(v)
}

/**
 * The result of a Save or Undo (POST .../lines `result`: compareReadBack's fields and
 * sideEffects, and the warnings acknowledged): a headline, each changed field as asked or not,
 * and what else the camera changed by itself.
 */
export function resultView(result, schedules = []) {
  const fields = (result?.fields ?? []).map((f) => {
    const ok = f.status === 'as asked'
    const name = fieldLabel(f.key)
    return {
      ok,
      text: ok ? `${name}: ${valueText(f.key, f.got, schedules)} (as asked)` : `${name}: not applied (asked ${valueText(f.key, f.want, schedules)}, the camera has ${valueText(f.key, f.got, schedules)})`
    }
  })
  const sideEffects = (result?.sideEffects ?? []).map((s) => `${fieldLabel(s.key)}: ${valueText(s.key, s.from, schedules)} → ${valueText(s.key, s.to, schedules)}`)
  const good = fields.filter((f) => f.ok).length
  const status = fields.length === 0 ? 'unknown' : good === fields.length ? 'done' : good > 0 ? 'partial' : 'failed'
  const acked = (result?.warningsAcked ?? []).map((k) => ACK_WORDS[k] ?? k)
  return { status, headline: HEADLINES[status], fields, sideEffects, acked }
}

/** Is this camera in the "Line crossing" alarm rule, switched on and notifying? rules: GET /api/alarms/rules. */
export function alertOn(rules, key) {
  const rule = (rules ?? []).find((r) => r?.name === LINE_RULE_NAME)
  return Boolean(rule && rule.enabled && rule.notify && Array.isArray(rule.cameras) && rule.cameras.includes(key))
}

/**
 * "Alert my phone" is on by default: after a Save that switched the camera's line crossing on,
 * the camera joins the rule when it is not in it yet and the admin has not touched the switch in
 * this panel. alert: { on: true | false | null | undefined (not known), touched }.
 */
export function autoAlert(before, after, alert) {
  return alert?.on === false && !alert.touched && Boolean(after?.enabled) && !before?.enabled
}

/**
 * The words under the alert switch. on: undefined while the rules are being read, null when they
 * could not be. topicSet: settings has an ntfy topic (GET .../lines ntfy.topicSet).
 */
export function alertNote(on, enabled, topicSet) {
  if (on === undefined) return ''
  if (on === null) return 'Whether this camera alerts your phone could not be read.'
  if (on && topicSet) return 'A crossing sends an alert to the ntfy topic in Settings (Alerts), with a link to the event.'
  if (on) return 'On, but no ntfy topic is set: switch this off and on again to make one, or set one in Settings (Alerts).'
  if (!enabled) return 'Off. It switches on by itself when you save lines with line crossing on, unless you switch it off here first.'
  return 'Off: crossings on this camera show on the Alarms page only.'
}

/**
 * How to get the alerts on a phone, from POST /api/admin/lines/alert's ntfy ({ topic, created,
 * url? }), or null when there is no topic.
 */
export function ntfyHelp(ntfy) {
  if (!ntfy?.topic) return null
  const url = String(ntfy.url ?? '').replace(/\/+$/, '')
  const server = url && url !== 'https://ntfy.sh' ? url : null
  return {
    lead: ntfy.created ? 'A private ntfy topic was made for Argus\'s phone alerts:' : 'Phone alerts go to this ntfy topic:',
    topic: ntfy.topic,
    steps: [
      'On your phone, install the free ntfy app (Android or iPhone).',
      `Tap +, and subscribe to the topic above${server ? `, with "Use another server" set to ${server}` : ''}.`,
      'Keep the topic name private: anyone who knows it can read these alerts and send you messages.'
    ]
  }
}

// ---- the DOM ------------------------------------------------------------------------------------

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

/** A line (or an arrow shaft) with a dark edge, so it shows on any picture. */
function stroke(g, pts, colour, width, dash = []) {
  g.beginPath()
  g.moveTo(pts[0][0], pts[0][1])
  for (const p of pts.slice(1)) g.lineTo(p[0], p[1])
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.setLineDash([])
  g.strokeStyle = 'rgba(0,0,0,0.7)'
  g.lineWidth = width + 2
  g.stroke()
  g.setLineDash(dash)
  g.strokeStyle = colour
  g.lineWidth = width
  g.stroke()
  g.setLineDash([])
}

function dot(g, [x, y], r, colour) {
  g.beginPath()
  g.arc(x, y, r, 0, 2 * Math.PI)
  g.fillStyle = colour
  g.fill()
  g.lineWidth = Math.max(1, r / 3)
  g.strokeStyle = 'rgba(0,0,0,0.8)'
  g.stroke()
}

/** An arrow head at `tip`, pointing along the unit vector d. */
function head(g, tip, d, size, colour) {
  const back = [tip[0] - d.x * size, tip[1] - d.y * size]
  const side = [-d.y * size * 0.6, d.x * size * 0.6]
  g.beginPath()
  g.moveTo(tip[0], tip[1])
  g.lineTo(back[0] + side[0], back[1] + side[1])
  g.lineTo(back[0] - side[0], back[1] - side[1])
  g.closePath()
  g.fillStyle = colour
  g.fill()
  g.lineWidth = 1
  g.strokeStyle = 'rgba(0,0,0,0.8)'
  g.stroke()
}

function label(g, text, x, y, size) {
  g.font = `600 ${size}px system-ui, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.lineWidth = Math.max(2, size / 4)
  g.strokeStyle = 'rgba(0,0,0,0.85)'
  g.strokeText(text, x, y)
  g.fillStyle = '#fff'
  g.fillText(text, x, y)
}

let idSeq = 0

export class LinesPanel {
  /**
   * @param {HTMLElement} host where the panel goes (the Live grid, beside the full-size view)
   * @param {{ nvr: string, ch: number, name: string }} cam the camera (ch 0-based, as /api/cameras)
   * @param {{ liveEl: HTMLElement | (() => HTMLElement | null), opener?: HTMLElement | null, onClose?: () => void }} opts
   *   liveEl: the element the live picture is drawn in (the player's canvas), or a function giving
   *   the current one: the view swaps the sub stream's canvas for the main stream's and rebuilds its
   *   tile now and then, and the drawing follows it into the tile that holds it. opener: focused
   *   again on close. onClose: after the panel closed.
   */
  constructor(host, cam, { liveEl, opener = null, onClose = null } = {}) {
    this.host = host
    this.cam = cam
    this.liveEl = liveEl
    this.opener = opener
    this.onClose = onClose
    this.view = null // GET .../lines: { supported, cfg, schedules, device, seen, undo, ntfy }
    this.draft = null // draftOf(view.cfg), as the admin changes it
    this.blocked = null // blockedText(view.cfg)
    this.selected = 0 // the slot a new line goes into first
    this.drag = null // a press on the picture: { id, type, slot, end, from, before, moved, x, y }
    this.busy = false
    this.sending = 0 // camera writes on their way
    this.session = 0 // bumped on close: late answers for a closed panel are ignored
    this.loadSeq = 0
    this.isOpen = false
    this.folded = false
    this.alert = { on: undefined, touched: false, busy: false } // on: the camera is in the "Line crossing" rule (undefined: not read yet, null: could not be)
    this.ov = null
    this.layoutKey = ''
    this.onResize = () => this.layout()
    this.build()
  }

  get key() {
    return `${this.cam.nvr}/${this.cam.ch}`
  }

  /** Unsaved changes (lines and settings). */
  get dirty() {
    return this.view?.cfg && this.draft ? changeLines(this.view.cfg, this.draft).length : 0
  }

  url() {
    return `/api/admin/nvrs/${encodeURIComponent(this.cam.nvr)}/channels/${this.cam.ch}/lines`
  }

  build() {
    this.el = el('aside', { className: 'img-panel lines-panel', 'aria-label': 'Line crossing' })
    this.el.innerHTML = `
      <div class="ip-head"><h2 tabindex="-1">Lines <span class="ip-cam"></span></h2><span class="ln-head-buttons"><button type="button" class="ln-fold" aria-expanded="true" title="Fold the panel away to draw on the whole picture">Hide</button><button type="button" class="ip-close" aria-label="Close line crossing">×</button></span></div>
      <p class="ln-help">Drag on the picture to draw a line. Drag an end to move it; tap the arrow in its middle to change which way a crossing counts. A is the side on the left of the line as drawn.</p>
      <p class="ln-warn" hidden></p>
      <ol class="ln-slots"></ol>
      <div class="ln-settings"></div>
      <section class="ln-box ln-alert" aria-label="Phone alerts" hidden>
        <label class="ip-switch"><input type="checkbox" class="ln-alert-on" /> Alert my phone for this camera</label>
        <p class="ln-note ln-alert-note"></p>
        <div class="ln-ntfy" hidden></div>
      </section>
      <div class="ip-result ln-result" hidden></div>
      <p class="ip-error" role="alert"></p>
      <p class="ip-status" role="status"></p>
      <p class="ip-undo-note" hidden></p>
      <div class="ip-actions">
        <button type="button" class="ip-undo" hidden>Undo last change</button>
        <button type="button" class="ip-revert">Revert</button>
        <button type="button" class="ip-apply ln-save">Save</button>
      </div>
      <dialog class="ip-dialog"></dialog>`
    const $ = (s) => this.el.querySelector(s)
    this.$ = $
    $('.ip-cam').textContent = `· ${this.cam.ch + 1} ${this.cam.name ?? ''}`
    $('.ip-close').addEventListener('click', () => this.requestClose())
    $('.ln-fold').addEventListener('click', () => this.fold())
    $('.ln-save').addEventListener('click', () => this.save())
    $('.ip-undo').addEventListener('click', () => this.undo())
    $('.ip-revert').addEventListener('click', () => this.revert())
    $('.ln-alert-on').addEventListener('change', (e) => {
      this.alert.touched = true
      this.setAlert(e.target.checked)
    })
    // over the picture: a canvas exactly on it, a shield under it that catches taps on the bars
    // beside it (the full-size view closes on a tap), and the magnifier shown while dragging
    this.shield = el('div', { className: 'ln-shield' })
    this.canvas = el('canvas', { className: 'ln-overlay', hidden: true, 'aria-label': 'The camera picture: drag on it to draw a line' })
    this.ctx = this.canvas.getContext('2d')
    this.loupe = el('canvas', { className: 'ln-loupe', hidden: true, 'aria-hidden': 'true' })
    // the full-size view closes on a click and has keyboard shortcuts: not from in here
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
    // the video's canvas is resized and swapped (sub -> main stream) without telling anyone
    this.layoutTimer = setInterval(() => this.layout(), 400)
    this.layout()
    this.load({ first: true })
    this.loadAlert()
  }

  /** Closes, asking first when changes are unsaved. Returns whether it closed. */
  requestClose() {
    if (!this.confirmDiscard()) return false
    this.close()
    return true
  }

  /**
   * "Discard N unsaved changes?" when there are any; true = go ahead. While a change is being sent
   * it says that instead: the server finishes it either way, but its result would not be shown.
   */
  confirmDiscard(n = this.dirty) {
    if (this.sending > 0) return window.confirm('A change is being saved to the camera. If you leave now its result will not be shown here; the change goes ahead, and Undo stays available when you reopen the panel. Leave anyway?')
    return n === 0 || window.confirm(`Discard ${plural(n, 'unsaved change')}?`)
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
    for (const n of [this.el, this.shield, this.canvas, this.loupe]) n.remove()
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
    this.$('.ip-error').textContent = error ? text : ''
  }

  // ---- reading -------------------------------------------------------------------------------------

  async load({ first = false } = {}) {
    const seq = ++this.loadSeq
    this.busy = true
    this.update()
    this.status('Reading the camera\'s line settings…')
    try {
      const r = await api('GET', this.url())
      if (seq !== this.loadSeq) return
      if (!r.ok) throw errorOf(r)
      this.show(r.data.lines)
      this.status('')
      if (first) this.$('.ip-head h2').focus()
    } catch (e) {
      if (seq === this.loadSeq) this.status(e.message, { error: true })
    } finally {
      if (seq === this.loadSeq) {
        this.busy = false
        this.update()
      }
    }
  }

  /** Whether the camera is in the "Line crossing" alarm rule (the alert switch). */
  async loadAlert() {
    const session = this.session
    const r = await api('GET', '/api/alarms/rules').catch(() => null)
    if (session !== this.session) return
    this.alert.on = r?.ok ? alertOn(r.data?.rules, this.key) : null
    this.updateAlert()
  }

  /** A fresh view from the server (GET, or the read-back after a Save or Undo): everything is redrawn from it. */
  show(view) {
    this.view = view ?? null
    const cfg = view?.supported ? view.cfg : null
    this.draft = cfg ? draftOf(cfg) : null
    this.blocked = cfg ? blockedText(cfg) : null
    const warn = this.$('.ln-warn')
    warn.hidden = !this.blocked
    warn.textContent = this.blocked ?? ''
    this.$('.ln-help').hidden = !cfg
    this.$('.ln-alert').hidden = !cfg
    if (!cfg) {
      this.slotRows = []
      this.controls = []
      this.$('.ln-slots').replaceChildren()
      this.$('.ln-settings').replaceChildren(el('p', { className: 'ln-note' }, 'The NVR says this camera has no line-crossing detection of its own.'))
    } else {
      if (!(this.selected < cfg.lines.length)) this.selected = 0
      this.renderSlots()
      this.renderSettings()
    }
    this.updateAlert()
    this.update()
    this.draw()
  }

  renderSlots() {
    this.slotRows = this.draft.lines.map((_, i) => {
      const swatch = el('span', { className: 'ln-swatch', 'aria-hidden': 'true' })
      swatch.style.background = SLOT_COLOURS[i % SLOT_COLOURS.length]
      const pick = el('button', { type: 'button', className: 'ln-pick', title: 'The line a new drag draws, when it is not drawn yet' }, swatch, `Line ${i + 1}`)
      const state = el('span', { className: 'ln-state' })
      const dir = el('button', { type: 'button', className: 'ln-dir', title: 'Which way a crossing counts: A → B, B → A, or both. Click to change.' })
      const clear = el('button', { type: 'button', className: 'ln-clear' }, 'Clear')
      pick.addEventListener('click', () => {
        this.selected = i
        this.update()
        this.draw()
      })
      dir.addEventListener('click', () => this.turn(i))
      clear.addEventListener('click', () => this.clearSlot(i))
      return { row: el('li', { className: 'ln-slot' }, pick, state, dir, clear), pick, state, dir, clear }
    })
    this.$('.ln-slots').replaceChildren(...this.slotRows.map((r) => r.row))
  }

  renderSettings() {
    const cfg = this.view.cfg
    const rows = []
    const on = el('input', { type: 'checkbox', className: 'ln-enabled' })
    on.addEventListener('change', () => this.edit(() => (this.draft.enabled = on.checked)))
    rows.push(el('label', { className: 'ip-switch' }, on, 'Line crossing on'))
    this.controls = [{ input: on, value: () => this.draft.enabled }]
    if (cfg.filter === null) {
      rows.push(el('p', { className: 'ln-note' }, 'This camera has no person/vehicle filter: anything that crosses a line counts, including water, boats, shadows and headlights.'))
    } else if (cfg.filter.kind === 'single') {
      rows.push(this.rangeRow('Sensitivity', () => this.draft.filter.sensitivity, (v) => (this.draft.filter.sensitivity = v)))
    } else {
      for (const k of CLASS_ORDER.filter((c) => c in cfg.filter.classes)) {
        const box = el('input', { type: 'checkbox' })
        box.addEventListener('change', () => this.edit(() => (this.draft.filter[k].on = box.checked)))
        this.controls.push({ input: box, value: () => this.draft.filter[k].on })
        rows.push(el('label', { className: 'ip-switch' }, box, `${CLASS_WORDS[k]} crossing counts`))
        rows.push(this.rangeRow(`${CLASS_WORDS[k]} sensitivity`, () => this.draft.filter[k].sensitivity, (v) => (this.draft.filter[k].sensitivity = v), () => this.draft.filter[k].on))
      }
    }
    const hold = el('select', {}, ...cfg.holdChoices.map((s) => new Option(`${s} s`, String(s))))
    hold.addEventListener('change', () => this.edit(() => (this.draft.holdTime = Number(hold.value))))
    this.controls.push({ input: hold, value: () => String(this.draft.holdTime) })
    rows.push(el('label', { className: 'ln-row', title: 'How long an alarm stays on after a crossing. Under 10 s a crossing could fall between two of Argus\'s checks (every 5 s).' }, 'Hold time', hold))
    const choices = scheduleChoices(cfg, this.view.schedules ?? [])
    const sched = el('select', {}, ...choices.map((s) => new Option(s.name, s.id)))
    sched.addEventListener('change', () => this.edit(() => (this.draft.scheduleGuid = sched.value)))
    // one choice (the NVR's list could not be read): shown, not changeable
    this.controls.push({ input: sched, value: () => this.draft.scheduleGuid, fixed: choices.length < 2 })
    rows.push(el('label', { className: 'ln-row', title: 'When the camera detects. The schedules themselves are the NVR\'s, edited there.' }, 'Schedule', sched))
    const busyWith = mutexOn(cfg)
    if (busyWith.length) rows.push(el('p', { className: 'ln-note' }, `This camera cannot run line crossing beside ${busyWith.join(', ')}, which ${busyWith.length === 1 ? 'is' : 'are'} on: switching line crossing on may switch ${busyWith.length === 1 ? 'it' : 'them'} off.`))
    this.$('.ln-settings').replaceChildren(el('section', { className: 'ln-box', 'aria-label': 'Detection settings' }, ...rows))
  }

  /** A 1-100 sensitivity: a slider and its number. on(): whether it matters now (its class counts). */
  rangeRow(name, get, set, on = () => true) {
    const range = el('input', { type: 'range', min: 1, max: 100, step: 1 })
    const num = el('input', { type: 'number', min: 1, max: 100, step: 1, className: 'ip-num', 'aria-label': name })
    const put = (v) => {
      const n = Math.round(Number(v))
      if (Number.isInteger(n) && n >= 1 && n <= 100) this.edit(() => set(n))
    }
    range.addEventListener('input', () => put(range.value))
    num.addEventListener('change', () => put(num.value))
    this.controls.push({ input: range, value: () => String(get()), on }, { input: num, value: () => String(get()), on })
    return el('label', { className: 'ln-range' }, el('span', {}, name), num, range)
  }

  /** A change to the draft from a control: the rest of the panel follows it. */
  edit(fn) {
    if (!this.draft || this.busy || this.blocked) return this.update()
    fn()
    this.update()
    this.draw()
  }

  turn(i) {
    if (!this.draft || this.busy || this.blocked || !isSet(this.draft.lines[i])) return
    this.draft.lines[i].direction = nextDirection(this.draft.lines[i].direction, this.view.cfg.directions)
    this.selected = i
    this.update()
    this.draw()
  }

  clearSlot(i) {
    if (!this.draft || this.busy || this.blocked) return
    const l = this.draft.lines[i]
    // a cleared slot keeps its direction: the camera wants one for every slot
    l.start = { x: 0, y: 0 }
    l.end = { x: 0, y: 0 }
    this.selected = i
    this.update()
    this.draw()
  }

  revert() {
    if (!this.view?.cfg || this.busy) return
    this.draft = draftOf(this.view.cfg)
    this.status('')
    this.update()
    this.draw()
  }

  /** Brings the controls in line with the draft, the unsaved changes and whether a request runs. */
  update() {
    const cfg = this.view?.supported ? this.view.cfg : null
    const locked = this.busy || Boolean(this.blocked) || !cfg
    for (const c of this.controls ?? []) {
      const v = c.value()
      if (c.input.type === 'checkbox') c.input.checked = v === true
      else if (document.activeElement !== c.input) c.input.value = String(v)
      c.input.disabled = locked || c.fixed === true || (c.on ? !c.on() : false)
    }
    for (const [i, { row, pick, state, dir, clear }] of (this.slotRows ?? []).entries()) {
      const l = this.draft.lines[i]
      row.classList.toggle('ln-current', i === this.selected)
      row.classList.toggle('ln-changed', !sameLine(l, cfg.lines[i]))
      pick.setAttribute('aria-pressed', String(i === this.selected))
      pick.disabled = locked
      state.textContent = slotText(l, cfg.lines[i])
      dir.textContent = DIRECTION_WORDS[l.direction] ?? l.direction
      dir.disabled = locked || !isSet(l)
      clear.disabled = locked || !isSet(l)
    }
    const n = this.dirty
    const save = this.$('.ln-save')
    save.textContent = saveLabel(n)
    save.disabled = locked || n === 0
    this.$('.ip-revert').disabled = this.busy || n === 0
    const undo = this.$('.ip-undo')
    const u = this.view?.undo ?? null
    undo.hidden = !u
    undo.disabled = locked
    const note = this.$('.ip-undo-note')
    note.hidden = !u
    note.textContent = u ? undoText(u) : ''
    this.canvas.classList.toggle('ln-locked', locked)
  }

  updateAlert() {
    const box = this.$('.ln-alert-on')
    box.checked = this.alert.on === true
    box.indeterminate = this.alert.on === null || this.alert.on === undefined
    box.disabled = this.alert.busy || !this.view?.supported
    this.$('.ln-alert-note').textContent = this.view?.supported ? alertNote(this.alert.on, this.view.cfg.enabled, Boolean(this.view.ntfy?.topicSet)) : ''
  }

  // ---- the drawing ----------------------------------------------------------------------------------

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
      // no picture yet, or the view is being rebuilt: nothing to draw on until it is back
      if (this.layoutKey !== 'gone') {
        this.layoutKey = 'gone'
        this.ov = null
        this.canvas.hidden = true
        this.hideLoupe()
      }
      return
    }
    if (this.canvas.parentNode !== tile) {
      tile.append(this.shield, this.canvas, this.loupe)
      this.layoutKey = ''
    }
    const hr = tile.getBoundingClientRect()
    const hostBox = { left: hr.left + tile.clientLeft, top: hr.top + tile.clientTop, width: tile.clientWidth, height: tile.clientHeight }
    const [iw, ih] = video instanceof HTMLVideoElement ? [video.videoWidth, video.videoHeight] : [video.width, video.height]
    const cs = getComputedStyle(video)
    const r = video.getBoundingClientRect()
    const px = (v) => parseFloat(v) || 0
    const box = {
      left: r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft),
      top: r.top + px(cs.borderTopWidth) + px(cs.paddingTop),
      width: r.width - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(cs.paddingLeft) - px(cs.paddingRight),
      height: r.height - px(cs.borderTopWidth) - px(cs.borderBottomWidth) - px(cs.paddingTop) - px(cs.paddingBottom)
    }
    const pic = pictureRect(box, iw, ih, cs.objectFit || 'fill', objectPosition(cs.objectPosition))
    const dpr = window.devicePixelRatio || 1
    const key = pic ? [pic.left, pic.top, pic.width, pic.height, hostBox.left, hostBox.top, hostBox.width, hostBox.height, dpr].map((x) => x.toFixed(1)).join() : 'none'
    if (key === this.layoutKey) return
    this.layoutKey = key
    this.hostSize = [hostBox.width, hostBox.height]
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

  /** Where a pointer is on the picture, in the camera's units (held to the picture's edges). */
  unitsAt(e, r = this.canvas.getBoundingClientRect()) {
    if (!(r.width > 0 && r.height > 0)) return null
    const [u, v] = clientToPicture(e.clientX, e.clientY, r)
    return { x: toUnits(u), y: toUnits(v) }
  }

  /** The draft's lines in the canvas's CSS pixels: true distances on screen, for what a press reaches. */
  linesPx(r) {
    const at = (p) => ({ x: toFrac(p.x) * r.width, y: toFrac(p.y) * r.height })
    return this.draft.lines.map((l) => ({ direction: l.direction, start: at(l.start), end: at(l.end) }))
  }

  onPointerDown(e) {
    if (!e.isPrimary || e.button !== 0 || !this.ov || !this.draft || this.busy || this.blocked) return
    const r = this.canvas.getBoundingClientRect()
    const at = this.unitsAt(e, r)
    if (!at) return
    e.preventDefault()
    e.stopPropagation()
    const hit = hitTest({ x: e.clientX - r.left, y: e.clientY - r.top }, this.linesPx(r), REACH_PX[e.pointerType] ?? REACH_PX.mouse)
    let slot
    let end
    if (hit) ({ slot, end } = hit)
    else {
      slot = slotForNewLine(this.draft.lines, this.selected)
      end = 'new'
      if (slot < 0) return this.status('All four lines are drawn: clear one to draw another, or drag an end to move it.')
    }
    this.drag = { id: e.pointerId, type: e.pointerType, slot, end, from: at, before: copyLine(this.draft.lines[slot]), moved: false, x: e.clientX, y: e.clientY }
    this.selected = slot
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
    if (d.end === 'arrow') return // a drag that started on the arrow moves nothing
    const at = this.unitsAt(e)
    if (!at) return
    const l = this.draft.lines[d.slot]
    if (d.end === 'new') {
      l.start = { ...d.from }
      l.end = at
    } else l[d.end] = at
    this.draw()
    this.drawLoupe(at)
  }

  onPointerUp(e) {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    this.drag = null
    this.hideLoupe()
    const l = this.draft.lines[d.slot]
    if (d.end === 'arrow') {
      if (!d.moved) this.turn(d.slot)
      return
    }
    if (d.moved && lineLength(l.start, l.end) < MIN_LINE_UNITS) {
      Object.assign(l, copyLine(d.before))
      this.status('Too short: a line must be at least 5% of the picture long. Drag further.', { error: true })
    } else if (d.moved) this.status('')
    this.update()
    this.draw()
  }

  onPointerCancel(e) {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    this.drag = null
    this.hideLoupe()
    Object.assign(this.draft.lines[d.slot], copyLine(d.before))
    this.update()
    this.draw()
  }

  /** The lines as they will be saved: numbered, coloured, an arrow across each with its A and B sides; unsaved ones dashed. */
  draw() {
    const g = this.ctx
    const ov = this.ov
    if (!g || !ov) return
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, ov.backingWidth, ov.backingHeight)
    if (!this.draft) return
    const k = ov.backingWidth / Math.max(1, ov.width) // backing pixels per CSS pixel (devicePixelRatio)
    const saved = this.view.cfg.lines
    this.draft.lines.forEach((l, i) => {
      if (!isSet(l)) return
      const a = pictureToOverlay([toFrac(l.start.x), toFrac(l.start.y)], ov)
      const b = pictureToOverlay([toFrac(l.end.x), toFrac(l.end.y)], ov)
      const colour = SLOT_COLOURS[i % SLOT_COLOURS.length]
      const current = i === this.selected
      stroke(g, [a, b], colour, (current ? 3 : 2) * k, sameLine(l, saved[i]) ? [] : [8 * k, 5 * k])
      dot(g, a, (current ? 6 : 5) * k, colour)
      dot(g, b, (current ? 6 : 5) * k, colour)
      const arrow = arrowFor({ direction: l.direction, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] } })
      if (!arrow) return
      const { mid, dir, both, toA } = arrow
      // the slot's number just before the start, along the line
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      label(g, String(i + 1), a[0] - ((b[0] - a[0]) / len) * 14 * k, a[1] - ((b[1] - a[1]) / len) * 14 * k, 13 * k)
      const shaft = 22 * k
      const tail = [mid.x - dir.x * shaft, mid.y - dir.y * shaft]
      const tip = [mid.x + dir.x * shaft, mid.y + dir.y * shaft]
      stroke(g, [tail, tip], colour, 2 * k)
      head(g, tip, dir, 9 * k, colour)
      if (both) head(g, tail, { x: -dir.x, y: -dir.y }, 9 * k, colour)
      const off = shaft + 12 * k
      label(g, 'A', mid.x + toA.x * off, mid.y + toA.y * off, 14 * k)
      label(g, 'B', mid.x - toA.x * off, mid.y - toA.y * off, 14 * k)
    })
  }

  /** A magnifier near the end being placed, showing the picture there (a fingertip hides it). */
  drawLoupe(at) {
    const video = this.videoEl()
    const ov = this.ov
    if (!video || !ov || !this.hostSize) return this.hideLoupe()
    const [iw, ih] = video instanceof HTMLVideoElement ? [video.videoWidth, video.videoHeight] : [video.width, video.height]
    if (!iw || !ih) return this.hideLoupe()
    const R = Math.round(Math.min(56, (Math.min(...this.hostSize) - 16) / 2))
    if (R < 20) return this.hideLoupe()
    const zoom = 3
    const dpr = window.devicePixelRatio || 1
    const c = this.loupe
    const size = Math.round(2 * R * dpr)
    if (c.width !== size) c.width = c.height = size
    c.style.width = c.style.height = `${2 * R}px`
    const u = toFrac(at.x)
    const v = toFrac(at.y)
    const x = ov.left + u * ov.width
    const y = ov.top + v * ov.height
    const off = R + (this.drag?.type === 'touch' ? 36 : 20)
    const [lx, ly] = loupeSpot(x, y, R, off, this.hostSize, this.panelBox())
    c.style.left = `${lx - R}px`
    c.style.top = `${ly - R}px`
    const g = c.getContext('2d')
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.fillStyle = '#000'
    g.fillRect(0, 0, size, size)
    const span = (2 * R) / zoom // CSS px of picture shown across the magnifier
    const sw = (span / ov.width) * iw
    const sh = (span / ov.height) * ih
    try {
      g.drawImage(video, u * iw - sw / 2, v * ih - sh / 2, sw, sh, 0, 0, size, size)
    } catch {}
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    stroke(g, [[R - 12, R], [R + 12, R]], '#fff', 1.5)
    stroke(g, [[R, R - 12], [R, R + 12]], '#fff', 1.5)
    c.hidden = false
  }

  hideLoupe() {
    this.loupe.hidden = true
  }

  /** The panel's box inside the tile (the magnifier keeps clear of it), or null when folded or elsewhere. */
  panelBox() {
    const tile = this.canvas.parentNode
    if (this.folded || !tile?.getBoundingClientRect || !this.el.isConnected) return null
    const p = this.el.getBoundingClientRect()
    const h = tile.getBoundingClientRect()
    return p.width ? { left: p.left - h.left - tile.clientLeft, top: p.top - h.top - tile.clientTop, width: p.width, height: p.height } : null
  }

  // ---- dialogs and sending ------------------------------------------------------------------------------

  /** The Picture panel's modal dialog: title, lead, a list, and the action. Resolves true on the action. */
  dialog({ title, lead = '', items = [], action = 'Save anyway' }) {
    const d = this.$('.ip-dialog')
    const back = document.activeElement
    const tid = `ln-d-${++idSeq}`
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
      d.addEventListener('cancel', (e) => {
        e.preventDefault()
        done(false)
      }, { once: true })
      // closed any other way (the panel closing under it): the same as Cancel, so nothing waits for ever
      d.addEventListener('close', () => done(false), { once: true })
      d.showModal()
      cancel.focus()
    })
  }

  /**
   * POST .../lines with the server's confirmations: a 409 needsAck is shown as a dialog and the same
   * body is sent again with the acknowledgement keys and the token that ties them to this exact change.
   */
  async post(body, { lead = '' } = {}) {
    const send = async (b) => {
      const session = this.session
      this.sending++
      try {
        return await api('POST', this.url(), b)
      } finally {
        if (session === this.session) this.sending--
      }
    }
    let r = await send(body)
    for (let round = 0; round < 2 && r.status === 409 && Array.isArray(r.data?.needsAck); round++) {
      const list = r.data.needsAck
      const ok = await this.dialog({ title: 'This change needs your confirmation', lead, items: list.map((i) => i.text), action: 'Save anyway' })
      if (!ok) return { cancelled: true }
      r = await send({ ...body, ack: list.map((i) => i.key), ackToken: r.data.ackToken })
    }
    return r
  }

  async save() {
    const cfg = this.view?.cfg
    if (!cfg || this.busy || this.blocked) return
    const change = changeOf(cfg, this.draft)
    if (Object.keys(change).length === 0) return
    await this.send({ device: this.view.device, seen: this.view.seen, change, confirm: true }, { verb: 'Saving', lines: changeLines(cfg, this.draft, this.view.schedules ?? []) })
  }

  async undo() {
    const v = this.view
    if (!v?.undo || this.busy || this.blocked) return
    // Undo shows the camera's settings afterwards: lines drawn but not saved would go
    if (!this.confirmDiscard()) return
    await this.send({ device: v.device, undo: true, seq: v.undo.seq, confirm: true }, { verb: 'Undoing', lines: [undoText(v.undo)] })
  }

  /** Sends a Save or an Undo, then shows the camera as read back and what happened to each field. */
  async send(body, { verb, lines = [] }) {
    const session = this.session
    const before = this.view.cfg
    this.busy = true
    this.update()
    this.$('.ln-result').hidden = true
    this.status(`${verb}… the camera is read back afterwards (up to 6 s)`)
    let r
    try {
      r = await this.post(body, { lead: lines.length ? `It sends: ${lines.join('; ')}.` : '' })
    } catch (e) {
      if (session === this.session) {
        this.busy = false
        this.update()
        this.status(`Could not reach the server (${e.message}); reopen the panel to see what the camera has.`, { error: true })
      }
      return
    }
    if (session !== this.session) return
    this.busy = false
    if (r.cancelled) {
      this.update()
      this.status('Nothing was sent.')
      return
    }
    const data = r.data ?? {}
    if (!r.ok) {
      if (r.status === 409 && data.stale) {
        // what the admin changed was drawn on settings that are no longer the camera's: shown afresh
        await this.load()
        if (session === this.session) this.status('The camera\'s line settings were changed elsewhere since this panel read them, so nothing was sent. They are shown again now; your unsaved changes were dropped: draw them again.', { error: true })
        return
      }
      this.update()
      this.status(data.error || `HTTP ${r.status}`, { error: true })
      return
    }
    this.show(data.lines)
    this.showResult(data.result)
    this.status('')
    if (autoAlert(before, data.lines?.cfg, this.alert)) await this.setAlert(true, { auto: true })
  }

  showResult(result) {
    const v = resultView(result, this.view?.schedules ?? [])
    const box = this.$('.ln-result')
    box.className = `ip-result ln-result ip-${v.status}`
    box.replaceChildren(
      el('p', {}, v.headline),
      result?.message && v.status !== 'done' ? el('p', { className: 'ln-note' }, result.message) : '',
      v.fields.length ? el('ul', {}, v.fields.map((f) => el('li', { className: f.ok ? 'ln-ok' : 'ln-no' }, f.text))) : '',
      v.sideEffects.length ? el('p', { className: 'ln-no' }, 'The camera also changed by itself:') : '',
      v.sideEffects.length ? el('ul', {}, v.sideEffects.map((t) => el('li', {}, t))) : '',
      v.acked.length ? el('p', { className: 'ln-note' }, `You confirmed: ${v.acked.join(', ')}.`) : ''
    )
    box.hidden = false
  }

  // ---- phone alerts (Argus's alarm rule, not the camera) ---------------------------------------------

  /** Adds this camera to the "Line crossing" alarm rule, or takes it out. auto: the default after a Save that switched it on. */
  async setAlert(on, { auto = false } = {}) {
    const session = this.session
    this.alert.busy = true
    this.updateAlert()
    let r
    try {
      r = await api('POST', ALERT_URL, { nvr: this.cam.nvr, ch: this.cam.ch, on })
    } catch (e) {
      r = { ok: false, status: 0, data: { error: e.message } }
    }
    if (session !== this.session) return
    this.alert.busy = false
    if (!r.ok) {
      this.updateAlert()
      this.status(`Phone alert not changed: ${r.data?.error || `HTTP ${r.status}`}`, { error: true })
      return
    }
    this.alert.on = alertOn([r.data.rule], this.key)
    if (this.view?.ntfy && r.data.ntfy?.topic) this.view.ntfy.topicSet = true
    this.updateAlert()
    this.showNtfy(this.alert.on ? r.data.ntfy : null, { auto })
  }

  showNtfy(ntfy, { auto = false } = {}) {
    const box = this.$('.ln-ntfy')
    const help = ntfyHelp(ntfy)
    box.replaceChildren(
      auto && this.alert.on ? el('p', {}, 'Phone alerts are now on for this camera (the default). Switch them off above if you do not want them.') : '',
      help ? el('p', {}, help.lead) : '',
      help ? el('p', { className: 'ln-topic' }, el('code', {}, help.topic)) : '',
      help ? el('ol', {}, help.steps.map((t) => el('li', {}, t))) : ''
    )
    box.hidden = box.childElementCount === 0
  }
}
