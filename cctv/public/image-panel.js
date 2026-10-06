// Picture settings for one camera (admins), laid over the full-size view: every setting the
// camera reports, under its own labels, for the profile it is using (Normal, Day or Night).
//
// Nothing reaches the camera without a click on Apply (or on Undo, "Apply the other N changes",
// "Restart camera to apply", the lens, stream or Day/Night set-up buttons, each with its own
// dialog). Auto adjust measures the live picture and the stream (picture-check.js,
// stream-check.js), and its suggestions (auto-adjust.js) only prefill unsent values; Apply sends
// exactly what is shown, never a new measurement. The server re-reads the camera first, refuses
// if anything changed since it was shown (409 stale), and asks for its own confirmation of
// anything that can restart the camera, pause recording, switch the floodlight or turn the
// picture over (409 needsAck + ackToken, shown here as a dialog).
//
// The pure parts (texts, request bodies, the result view) are exported for node tests
// (test/image-panel.test.mjs); the DOM is only touched inside the ImagePanel class.
import {
  Convergence,
  FOCUS,
  SETTLE,
  VERDICTS,
  afterCheck,
  browserLabel,
  cameraPosition,
  comparable,
  contradiction,
  displayCheck,
  figuresForLog,
  isSettled,
  lightPeriod,
  mergePending,
  resolutionChange,
  resolutionOptions,
  settingsHash,
  settleMs,
  sortSuggestions,
  streamChangeOf,
  streamLine,
  suggest,
  valueText
} from './auto-adjust.js'
import { Measurer, PictureWorker, describe, planesFromRGBA } from './picture-check.js'
import { canDecodeH265 } from './player.js'
import { StreamMeter } from './stream-check.js'
import { ColourCheck, playerFrames } from './colour-check-ui.js'

export const PROFILE_NAMES = { normal: 'Normal', day: 'Day', night: 'Night' }
export const profileName = (p) => PROFILE_NAMES[p] ?? String(p)
export const PROGRAMS = {
  normal: 'always uses Normal',
  day: 'always uses Day',
  night: 'always uses Night',
  auto: 'switches between Day and Night by the light, by itself',
  time: 'switches between Day and Night by the time, by itself'
}
const LOCATIONS = [['', 'not set'], ['outdoor', 'outdoor'], ['covered', 'covered (under a roof)'], ['indoor', 'indoor']]
const STALE_MEASURE_MS = 5 * 60_000 // after this, Apply says how old the measurement is
const VERIFIED_WITHIN_MS = 30 * 24 * 3600_000
const GRAB_TIMEOUT_MS = 45_000
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
    }, { once: true })
  })
const same = (a, b) => String(a) === String(b)
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const hhmm = (at) => {
  const d = new Date(at)
  return Number.isFinite(d.getTime()) ? d.toTimeString().slice(0, 5) : String(at)
}

// ---- pure helpers (node-testable) -------------------------------------------------------------

/** "This camera switches between Day and Night by the light, by itself." */
export function scheduleText(schedule) {
  const p = schedule?.program
  if (!p || !PROGRAMS[p]) return ''
  return `This camera ${PROGRAMS[p]}${p === 'time' && schedule.dayTime ? ` (Day from ${schedule.dayTime}, Night from ${schedule.nightTime})` : ''}.`
}

/**
 * "Using: Day profile now" plus, for cameras that switch by themselves and have not been seen
 * on both profiles yet, why that report is not confirmed ("at 19:00 it still reported Day").
 * notes: GET /notes (seen: [{ at, cfgFile }]).
 */
export function usingText(settings, notes = null, now = Date.now()) {
  if (!settings?.profile || !settings.active) return null
  let text = `Using: ${profileName(settings.active)} profile now.`
  const program = settings.schedule?.program
  if (settings.activeVerified === false && (program === 'auto' || program === 'time')) {
    const seen = (notes?.seen ?? []).filter((s) => now - Date.parse(s.at) < VERIFIED_WITHIN_MS)
    const missing = ['day', 'night'].filter((p) => !seen.some((s) => s.cfgFile === p)).map(profileName)
    const last = seen.at(-1)
    text += ` (Not confirmed: not yet seen on ${missing.join(' or ') || 'both profiles'}${last ? `; at ${hhmm(last.at)} it still reported ${profileName(last.cfgFile)}` : ''}.)`
  }
  if (settings.profile !== settings.active) text += ` Showing ${profileName(settings.profile)}: changes here show only when the camera switches to it.`
  return text
}

/** Does a dependent setting's controller have the value it works with? valueOf: the value shown (pending or current). */
export function needMet(need, fieldsByPath, valueOf) {
  if (!need) return true
  const ctl = fieldsByPath.get(need.path)
  if (!ctl) return true
  const v = valueOf(need.path)
  const shown = need.label && ctl.kind === 'index' ? ctl.labels[Number(v)] : v
  return 'eq' in need ? same(shown, need.eq) : !same(shown, need.ne)
}

/** What the admin saw for each changed setting, exactly as the GET gave it (the server's stale check). */
export function seenOf(settings, paths) {
  const byPath = new Map((settings?.fields ?? []).map((f) => [f.path, f]))
  return Object.fromEntries(paths.map((p) => [p, byPath.get(p)?.value ?? null]))
}

/**
 * The Apply request: exactly the unsent changes, the values they were seen with, and
 * origin 'auto' when any came from Auto adjust (the server then refuses if the camera switched
 * profile since the measurement).
 */
export function applyBody(settings, pending, origins, extra = {}) {
  const changes = Object.fromEntries(pending)
  const body = { device: settings.nvr.device, profile: settings.profile ?? null, changes, seen: seenOf(settings, Object.keys(changes)), confirm: true, ...extra }
  if ([...(origins?.values() ?? [])].includes('auto') && !('origin' in extra)) body.origin = 'auto'
  return body
}

/** "Apply 3 changes", with the measurement's age once it is older than 5 minutes. */
export function applyLabel(n, measuredAt = null, now = Date.now()) {
  if (!n) return 'Apply'
  const base = `Apply ${plural(n, 'change')}`
  if (!measuredAt || now - measuredAt < STALE_MEASURE_MS) return base
  return `${base} (measured ${Math.round((now - measuredAt) / 60_000)} min ago)`
}

/** Unsent changes (values and ticked Recording-quality suggestions). */
export const dirtyCount = (pending, streamTicked = 0) => (pending?.size ?? 0) + streamTicked

/** "Brightness 50 → 56" in the camera's own labels. */
export function changeLine(f, from, to, label = f?.label) {
  return `${label ?? '?'} ${valueText(f, from)} → ${valueText(f, to)}`
}

/** What Undo puts back, naming the side effects it also reverses (and what it cannot). */
export function undoText(undo) {
  if (!undo) return null
  const back = (undo.sideEffects ?? []).filter((e) => e.writable)
  let t
  if (undo.sideOnly) t = `Undo puts back what the camera changed by itself when a change was not applied: ${undo.puts}`
  else {
    t = `Undo puts back ${undo.puts}`
    if (back.length) t += `, and what the camera also changed: ${back.map((e) => `${e.label} ${e.to ?? '(none)'}`).join(', ')}`
  }
  t += ` (changed ${new Date(undo.at).toLocaleString()} by ${undo.by}).`
  if (undo.cannot?.length) t += ` Cannot be put back from here: ${undo.cannot.join(', ')}.`
  return t
}

/** The Defaults set (computed by the server: picture and colour only) as lines. */
export function defaultsList(settings) {
  const byPath = new Map((settings?.fields ?? []).map((f) => [f.path, f]))
  return Object.entries(settings?.defaults ?? {}).map(([p, to]) => ({ path: p, to, text: changeLine(byPath.get(p), byPath.get(p)?.value, to, byPath.get(p)?.label ?? p) }))
}

const STATUS_TEXT = { done: 'done', kept: 'kept by the camera', 'restart-needed': 'needs a camera restart', refused: 'refused', 'not-sent': 'not sent', unknown: 'unknown (could not be read back)', partial: 'partly done' }

/**
 * The result of a change, for the panel: its message, each group's outcome, what the camera
 * also changed, and the two follow-ups (never automatic): "Apply the other N changes" (once,
 * not after a retry) and "Restart camera to apply X" (the server's offers for this change).
 */
export function resultView(result, settings) {
  const byPath = new Map((settings?.fields ?? []).map((f) => [f.path, f]))
  const groups = (result?.groups ?? []).map((g) => ({ ...g, text: `${g.label}: ${STATUS_TEXT[g.status] ?? g.status}` }))
  const sideEffects = Object.entries(result?.sideEffects ?? {}).map(([p, [b, a]]) => {
    const f = byPath.get(p)
    return `${f?.label ?? p} ${b === null ? '(none)' : valueText(f, b)} → ${a === null ? '(none)' : valueText(f, a)}`
  })
  const remaining = result?.remaining ?? {}
  const other = result?.retryOf ? 0 : Object.keys(remaining).length
  const offers = (settings?.restart ?? []).filter((o) => o.seq === result?.seq)
  return { status: result?.status ?? 'unknown', message: result?.message ?? '', groups, sideEffects, other, remaining, offers }
}

/** Plain lines for the stream estimate dialog (POST /stream/estimate). */
export function estimateLines(e) {
  if (!e) return []
  const out = []
  const keys = ['QoI', 'level', 'enct', 'res', 'fps'].filter((k) => e.to && e.from && String(e.to[k]) !== String(e.from[k]))
  const names = { QoI: 'Bitrate cap (kbit/s)', level: 'Quality level', enct: 'Codec', res: 'Resolution', fps: 'Frame rate' }
  for (const k of keys) out.push(`${names[k]}: ${e.from[k]} → ${e.to[k]}`)
  const r = e.remain ?? {}
  if (r.before && r.after && !r.cycle) {
    out.push(`The NVR's estimate of recording days: ${r.before.map((g, i) => `${g.days} → ${r.after[i]?.days ?? '?'}${r.before.length > 1 ? ` (disk group ${g.group ?? i + 1})` : ''}`).join(', ')}.`)
  } else if (typeof r.ratio === 'number') {
    out.push(`${r.cycle ? 'With cycle recording the NVR estimates no days; ' : r.error ? `The NVR's estimate is not available (${r.error}); ` : ''}recordings would last about ${Math.round(r.ratio * 100)}% as long as now (all cameras at their caps).`)
  }
  const b = e.bandwidth ?? {}
  if (b.freeBeforeMbps !== null && b.freeBeforeMbps !== undefined) out.push(`NVR bandwidth free: ${b.freeBeforeMbps} → ${b.freeAfterMbps ?? '?'} Mbit/s of ${b.totalMbps}.`)
  if (e.worstCase?.text) out.push(e.worstCase.text)
  if (e.retention?.refused) out.push(e.retention.refused)
  return out
}

const FOCUS_LIGHT_MS = 10 * 60_000

/**
 * May "Focus now" be offered? From the last measurement's light (last: { period, mono, mean,
 * at, indoor }): by day, judged by the sun now (period), not when it was measured; or a lit
 * indoor scene in colour (plan §4.6 focus gating). Not after 10 minutes: the light changes.
 * Returns { ok, why, light } (light: what the server is told).
 */
export function focusLight(last, { now = Date.now(), period = null } = {}) {
  if (!last) return { ok: false, why: 'Measure the picture first (Auto adjust): focusing needs good light', light: null }
  if (!(now - last.at <= FOCUS_LIGHT_MS)) return { ok: false, why: `The last measurement is ${Math.round((now - last.at) / 60_000)} minutes old: measure again (Auto adjust) before focusing`, light: null }
  const p = period ?? last.period
  const ok = p === 'day' || (Boolean(last.indoor) && !last.mono && last.mean >= FOCUS.LIT_MEAN)
  return { ok, why: ok ? null : 'Focus now needs good light: by day, or a lit indoor scene in colour (autofocus in the dark hunts)', light: ok ? { period: p, mono: Boolean(last.mono), mean: last.mean } : null }
}

/** The server's confirmation texts are exactly the ones already shown (so one click covers them). */
export const sameTexts = (list, shown) => Array.isArray(list) && list.length > 0 && list.every((i) => shown.includes(i.text))

// ---- measuring without the Worker (fallback) --------------------------------------------------

/** A Measurer on the page's own thread, with the Worker's sink/result shape (for browsers without module Workers). */
function mainThreadMeasurer(opts) {
  const meas = new Measurer(opts)
  let chain = Promise.resolve()
  let buf = null
  const errors = []
  const planesOf = async (frame) => {
    const fmt = frame.format
    const W = frame.visibleRect?.width ?? frame.codedWidth
    const H = frame.visibleRect?.height ?? frame.codedHeight
    if (fmt === 'I420' || fmt === 'I420A' || fmt === 'NV12') {
      const size = frame.allocationSize()
      if (!buf || buf.byteLength < size) buf = new Uint8Array(size)
      const layout = await frame.copyTo(buf)
      const at = (i) => buf.subarray(layout[i].offset)
      if (fmt === 'NV12') return { width: W, height: H, chroma: 'NV12', y: at(0), yStride: layout[0].stride, uv: at(1), uvStride: layout[1].stride, planes: 'coded' }
      return { width: W, height: H, chroma: 'I420', y: at(0), yStride: layout[0].stride, u: at(1), uStride: layout[1].stride, v: at(2), vStride: layout[2].stride, planes: 'coded' }
    }
    const c = document.createElement('canvas')
    c.width = frame.displayWidth
    c.height = frame.displayHeight
    const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(frame, 0, 0)
    return planesFromRGBA(g.getImageData(0, 0, c.width, c.height))
  }
  return {
    sink: (frame, meta) => {
      chain = chain
        .then(async () => {
          try {
            const p = await planesOf(frame)
            meas.add({ ...p, set: meta.set, sinceKey: meta.sinceKey, ts: meta.ts, aligned: meta.aligned, ...(p.planes === 'coded' ? { displayMatrix: meta.displayMatrix, displayRange: meta.displayRange } : {}) })
          } finally {
            frame.close()
          }
        })
        .catch((e) => errors.push(e.message))
    },
    result: async () => {
      await chain
      const r = meas.result()
      if (r) r.selfCheck = null
      return r
    },
    close() {},
    frameErrors: errors
  }
}

/** Average brightness of what the player shows (tiny copy of its canvas): to see the picture settle. */
function quickMean(player) {
  const src = player?.canvas
  if (!src || !src.width) return null
  const c = quickMean.canvas ?? (quickMean.canvas = Object.assign(document.createElement('canvas'), { width: 32, height: 18 }))
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(src, 0, 0, 32, 18)
  const d = g.getImageData(0, 0, 32, 18).data
  let s = 0
  for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
  return s / (d.length / 4)
}

/** A small DOM builder: el('p', { className: 'x' }, 'text', child). */
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'dataset') Object.assign(n.dataset, v)
    else if (k.startsWith('aria-') || k === 'role' || k === 'for') n.setAttribute(k, v === true ? 'true' : String(v))
    else n[k] = v
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c)
  return n
}

async function api(method, url, body) {
  const res = await fetch(url, method === 'GET' ? { cache: 'no-store' } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}
const errorOf = (r) => new Error(r.data?.error || `HTTP ${r.status}`)

// ---- the panel -----------------------------------------------------------------------------------

let idSeq = 0

export class ImagePanel {
  /**
   * @param {{ getPlayer: () => ({ player: import('./player.js').VideoPlayer, stream: 'main' | 'sub', remote: boolean } | null),
   *   waitForMain?: (ms: number) => Promise<object | null>, onClose?: () => void }} opts  the full-size view
   */
  constructor({ getPlayer, waitForMain = null, onClose = null }) {
    this.getPlayer = getPlayer
    this.waitForMain = waitForMain ?? (async () => getPlayer())
    this.onClose = onClose
    this.cam = null
    this.settings = null
    this.pending = new Map() // path -> value not sent yet
    this.origins = new Map() // path -> 'manual' | 'defaults' | 'auto'
    this.rows = new Map() // path -> { row, input, field }
    this.busy = false
    this.sending = 0 // camera writes on their way (this opening of the panel)
    this.seq = 0 // bumped on open/close: answers for an older camera are ignored
    this.el = el('aside', { className: 'img-panel', 'aria-label': 'Picture settings' })
    this.el.innerHTML = `
      <div class="ip-head"><h2 tabindex="-1">Picture <span class="ip-cam"></span></h2><button type="button" class="ip-close" aria-label="Close picture settings">×</button></div>
      <p class="ip-using" hidden></p>
      <label class="ip-profile" hidden>Profile shown <select></select></label>
      <p class="ip-note" hidden></p>
      <label class="ip-location">Camera location <select></select></label>
      <div class="ip-auto">
        <div class="ip-auto-buttons"><button type="button" class="ip-measure" title="Measure the live picture and suggest settings">Auto adjust</button><button type="button" class="ip-cancel" hidden>Cancel</button><button type="button" class="ip-colour" title="Hold a ColorChecker chart or a white card in front of the camera and check its colours; nothing is sent until Apply">Colour check</button></div>
        <div class="ip-report" hidden></div>
      </div>
      <section class="ip-box ip-stream" hidden aria-label="Recording quality"></section>
      <section class="ip-box ip-lens" hidden aria-label="Lens"></section>
      <div class="ip-split" hidden></div>
      <div class="ip-fields"></div>
      <div class="ip-result" hidden></div>
      <p class="ip-error" role="alert"></p>
      <p class="ip-status" role="status"></p>
      <p class="ip-undo-note" hidden></p>
      <div class="ip-actions">
        <button type="button" class="ip-undo" hidden>Undo last change</button>
        <button type="button" class="ip-defaults" title="The camera's factory values for picture and colour (never exposure, night light, backlight or orientation); nothing is sent until Apply">Defaults</button>
        <button type="button" class="ip-revert">Revert</button>
        <button type="button" class="ip-apply">Apply</button>
      </div>
      <dialog class="ip-dialog"></dialog>`
    const $ = (s) => this.el.querySelector(s)
    this.$ = $
    $('.ip-close').addEventListener('click', () => this.requestClose())
    $('.ip-profile select').addEventListener('change', (e) => {
      // another profile's settings replace these: unsent changes go, so ask first
      if (!this.confirmDiscard(this.pending.size)) {
        e.target.value = this.settings?.profile ?? ''
        return
      }
      this.load(e.target.value)
    })
    $('.ip-location select').replaceChildren(...LOCATIONS.map(([v, t]) => new Option(t, v)))
    $('.ip-location select').addEventListener('change', (e) => this.saveLocation(e.target.value || null))
    $('.ip-measure').addEventListener('click', () => this.autoAdjust())
    $('.ip-cancel').addEventListener('click', () => this.measuring?.abort())
    $('.ip-colour').addEventListener('click', () => this.colourCheck())
    $('.ip-apply').addEventListener('click', () => this.apply())
    $('.ip-undo').addEventListener('click', () => this.undo())
    $('.ip-revert').addEventListener('click', () => {
      this.pending.clear()
      this.origins.clear()
      this.status('')
      this.update()
    })
    $('.ip-defaults').addEventListener('click', () => this.defaults())
    // the full-size view closes on a click and has keyboard shortcuts: not from in here
    this.el.addEventListener('click', (e) => e.stopPropagation())
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape' && !$('.ip-dialog').open) this.requestClose()
    })
  }

  get key() {
    return this.cam ? `${this.cam.nvr}/${this.cam.ch}` : null
  }

  /** Unsent changes: values waiting for Apply, and ticked Recording-quality suggestions. */
  get dirty() {
    return dirtyCount(this.pending, (this.streamItems ?? []).filter((i) => i.ticked).length)
  }

  url(what = 'image') {
    return `/api/admin/nvrs/${encodeURIComponent(this.cam.nvr)}/channels/${this.cam.ch}/${what}`
  }

  /** @param cam { nvr, ch, name, site, remote } */
  open(cam, { opener = null } = {}) {
    this.close({ quiet: true })
    this.session = (this.session ?? 0) + 1 // this opening: late answers for an earlier one are ignored
    this.cam = cam
    this.opener = opener
    // everything learnt about the previous camera goes (its light must not enable Focus now here)
    this.notes = null
    this.position = null
    this.streamInfo = null
    this.streamError = null
    this.streamItems = []
    this.streamNotes = []
    this.lensInfo = null
    this.lensSug = null
    this.lensPending = null
    this.lensAfter = null
    this.lastLight = null
    this.plan = null
    this.items = []
    this.lastItems = []
    this.lastFromAuto = false
    this.measured = null // { m, at, profile, stream, streamFig }
    this.conv = new Convergence()
    this.appliedItems = []
    this.nextRules = null // for the figures log: what the last Apply sent, rule by path
    this.nextRefused = null
    this.$('.ip-cam').textContent = `· ${cam.ch + 1} ${cam.name}`
    this.timer = setInterval(() => this.everySecond(), 1000)
    // H.264 -> H.265 is only suggested to a browser that can play H.265 (checked once)
    canDecodeH265().then((ok) => {
      this.canH265 = ok
    }).catch(() => {})
    this.load(null, { first: true })
  }

  /** Closes, asking first when changes are unsent. Returns whether it closed. */
  requestClose() {
    if (!this.confirmDiscard()) return false
    this.close()
    return true
  }

  /**
   * "Discard N unsent changes?" when there are any; true = go ahead. While a change is being
   * sent it says that instead: those changes are not unsent, but their result would not be
   * shown here (the server finishes the change either way; Undo stays available).
   * n: the changes that would be lost (by default all, with ticked Recording-quality ones).
   */
  confirmDiscard(n = this.cam ? this.dirty : 0) {
    if (this.cam && this.sending > 0) return window.confirm('A change is being applied to the camera (a camera restart can take up to 3 minutes). If you leave now its result will not be shown here; the change goes ahead, and Undo stays available when you reopen the panel. Leave anyway?')
    return n === 0 || window.confirm(`Discard ${plural(n, 'unsent change')}?`)
  }

  close({ quiet = false } = {}) {
    const wasOpen = Boolean(this.cam)
    this.seq++
    this.session = (this.session ?? 0) + 1
    this.measuring?.abort()
    this.measuring = null
    this.colour?.close()
    this.colour = null
    this.colourKey = null
    this.el.hidden = false
    clearInterval(this.timer)
    clearInterval(this.progressTimer)
    this.detachMeter()
    this.cam = null
    this.settings = null
    this.pending.clear()
    this.origins.clear()
    this.busy = false
    this.sending = 0
    this.usageCheck = null
    this.streamItems = []
    this.$('.ip-fields').replaceChildren()
    this.$('.ip-report').hidden = true
    this.$('.ip-result').hidden = true
    for (const s of ['.ip-stream', '.ip-lens', '.ip-split']) this.$(s).hidden = true
    this.$('.ip-undo').classList.remove('ip-warn')
    this.$('.ip-undo').title = ''
    const d = this.$('.ip-dialog')
    if (d.open) d.close()
    this.el.remove()
    if (wasOpen && !quiet) {
      if (this.opener?.isConnected) this.opener.focus()
      this.onClose?.()
    }
  }

  status(text, { error = false } = {}) {
    clearInterval(this.progressTimer)
    this.$('.ip-status').textContent = error ? '' : text
    this.$('.ip-error').textContent = error ? text : ''
  }

  /** A status that counts the seconds (for requests that can take minutes: a camera restart). */
  progress(text) {
    const t0 = Date.now()
    this.status(text)
    this.progressTimer = setInterval(() => {
      this.$('.ip-status').textContent = `${text} (${Math.round((Date.now() - t0) / 1000)} s)`
    }, 1000)
  }

  everySecond() {
    if (!this.cam) return
    this.attachMeter()
    this.tick = (this.tick ?? 0) + 1
    if (this.tick % 2 === 0) this.renderStreamLine()
    if (this.tick % 5 === 0) this.checkUsage()
    if (this.tick % 30 === 0) {
      this.update() // the Apply label says how old the measurement is
      if (this.lastLight && !this.busy) this.renderLens() // Focus now goes off once the light reading is old
    }
  }

  // ---- the stream meter: counts the bytes of the video already arriving ----------------------

  attachMeter() {
    const view = this.getPlayer()
    const player = view?.player ?? null
    if (player === this.meterPlayer) return
    this.detachMeter()
    if (!player) return
    this.meter = new StreamMeter()
    this.meterPlayer = player
    this.meterStream = view.stream
    player.onChunk = (chunk) => this.meter.add(chunk)
  }

  detachMeter() {
    if (this.meterPlayer && this.meterPlayer.onChunk) this.meterPlayer.onChunk = null
    this.meterPlayer = null
    this.meter = null
    this.meterStream = null
  }

  /** The main stream's figures with its cap, or null (sub stream, no cap known). sinceMark: only since the last applied change. */
  streamFigures({ sinceMark = false } = {}) {
    if (!this.meter || this.meterStream !== 'main') return null
    return this.meter.figures(this.streamInfo?.current?.QoI ?? null, { sinceMark })
  }

  /**
   * After an applied change: once 20 s of the stream since it are measured, has the rate risen
   * by 0.15 of the cap or more? Then Undo is highlighted (the re-measure right after a change
   * comes too soon to see it).
   */
  checkUsage() {
    const c = this.usageCheck
    if (!c) return
    if (Date.now() - c.at > 10 * 60_000) {
      this.usageCheck = null
      return
    }
    const f = this.streamFigures({ sinceMark: true })
    if (!f?.enough) return
    this.usageCheck = null
    const r = afterCheck(null, null, { before: c.before, after: f })
    if (!r.undo) return
    const undo = this.$('.ip-undo')
    undo.classList.add('ip-warn')
    undo.title = `Consider Undo: ${r.reasons.join('; ')}`
    this.status(`Since the last change ${r.reasons.join('; ')}: consider Undo.`)
  }

  // ---- loading ---------------------------------------------------------------------------------

  async load(profile, { first = false, keepPending = false } = {}) {
    const seq = ++this.seq
    this.busy = true
    this.update()
    this.status('Reading the camera\'s settings…')
    try {
      const r = await api('GET', profile ? `${this.url()}?profile=${encodeURIComponent(profile)}` : this.url())
      if (seq !== this.seq) return
      if (!r.ok) throw errorOf(r)
      this.show(r.data.settings, { keepPending })
      this.status('')
      if (first) {
        this.$('.ip-head h2').focus()
        this.loadExtras(this.session)
      }
    } catch (e) {
      if (seq === this.seq) this.status(e.message, { error: true })
    } finally {
      if (seq === this.seq) {
        this.busy = false
        this.update()
      }
    }
  }

  /**
   * App notes, the figures log, the camera's place on the map, then (one at a time, not to load
   * the NVR) the stream, the lens and the Day/Night plan. Tied to this opening of the panel, not
   * to a request: showing another profile meanwhile does not stop it.
   */
  async loadExtras(session) {
    const get = async (url) => {
      const r = await api('GET', url).catch((e) => ({ ok: false, data: { error: e.message } }))
      return session === this.session ? r : null
    }
    const notes = await get(this.url('notes'))
    if (!notes) return
    if (notes.ok) this.notes = notes.data
    const figures = await get(this.url('figures'))
    if (!figures) return
    this.conv = new Convergence({ history: figures.ok ? figures.data.figures : [] })
    const maps = await get('/api/maps')
    if (!maps) return
    this.position = cameraPosition(maps.ok ? maps.data : null, this.cam)
    this.renderHead()
    const stream = await get(this.url('stream'))
    if (!stream) return
    this.streamInfo = stream.ok ? stream.data.stream : null
    this.streamError = stream.ok ? null : stream.data?.error
    this.renderStream()
    const lens = await get(this.url('lens'))
    if (!lens) return
    this.lensInfo = lens.ok ? lens.data.lens : null
    this.renderLens()
    await this.loadPlan(session)
  }

  /** The Day/Night set-up plan, read only where a quick look says it could be offered (3 reads on the NVR). */
  async loadPlan(session = this.session) {
    const s = this.settings
    this.plan = null
    if (!s || !['normal', 'day', 'night'].every((p) => s.profiles.includes(p))) return this.renderSplit()
    const why = []
    if (s.schedule?.program !== 'normal') why.push(`The camera already switches profiles by itself (${s.schedule?.program ?? 'unknown'})`)
    else if (!s.schedule?.programs?.includes('auto')) why.push('The camera cannot switch profiles by the light')
    if (s.info?.hwdr) why.push('HWDR is on (not offered on HWDR cameras: separate profiles could pause recording or restart the camera at every switch)')
    if (!this.notes?.monoNightAt) why.push('Under floodlights a camera stays in colour at night, so it would stay on Day; this camera has not been measured black-and-white at night yet (run Auto adjust at night)')
    if (why.length) {
      this.plan = { offerable: false, reasons: why, local: true }
      return this.renderSplit()
    }
    const r = await api('GET', this.url('image/profiles')).catch((e) => ({ ok: false, data: { error: e.message } }))
    if (session !== this.session) return
    this.plan = r.ok ? r.data.plan : { offerable: false, reasons: [r.data?.error ?? 'could not be read'] }
    this.renderSplit()
  }

  show(settings, { keepPending = false, stale = [] } = {}) {
    const profileChanged = this.settings && this.settings.profile !== settings.profile
    this.settings = settings
    if (!keepPending || profileChanged) {
      this.pending.clear()
      this.origins.clear()
    } else {
      // unsent values that the camera now has anyway are no longer changes
      for (const [p, v] of this.pending) {
        const f = settings.fields.find((x) => x.path === p)
        if (!f || same(f.value, v)) {
          this.pending.delete(p)
          this.origins.delete(p)
        }
      }
    }
    if (profileChanged) {
      // a result, and an Auto adjust report, are for the profile they were made on: ticking a
      // report item now would put that profile's suggestion into this one
      this.$('.ip-result').hidden = true
      this.$('.ip-report').hidden = true
      this.$('.ip-report').replaceChildren()
      this.items = []
      this.measured = null
    }
    this.renderHead()
    this.renderFields(stale)
    this.renderOffers()
    this.update()
  }

  /** "Restart camera to apply X" offers the server still holds (10 minutes), e.g. after reopening the panel. */
  renderOffers() {
    const s = this.settings
    const box = this.$('.ip-result')
    if (!s?.restart?.length || !box.hidden) return
    box.hidden = false
    box.className = 'ip-result ip-restart-needed'
    const n = s.restart.length
    box.replaceChildren(
      el('p', {}, `${plural(n, 'recent change')} ${n === 1 ? 'was' : 'were'} not made because ${n === 1 ? 'it needs' : 'they need'} a camera restart (offered for 10 minutes after the change):`),
      el('div', { className: 'ip-result-buttons' }, s.restart.map((offer) => {
        const b = el('button', { type: 'button', className: 'ip-danger' }, `Restart camera to apply ${offer.label}…`)
        b.addEventListener('click', () => this.restart(offer))
        return b
      }))
    )
  }

  renderHead() {
    const s = this.settings
    if (!s) return
    const sel = this.$('.ip-profile select')
    this.$('.ip-profile').hidden = !s.profile || s.profiles.length < 2
    sel.replaceChildren(...s.profiles.map((p) => new Option(`${profileName(p)}${p === s.active ? ' (in use)' : ''}`, p)))
    if (s.profile) sel.value = s.profile
    const using = usingText(s, this.notes)
    this.$('.ip-using').hidden = !using
    this.$('.ip-using').textContent = using ?? ''
    const note = this.$('.ip-note')
    const sched = scheduleText(s.schedule)
    const info = [s.info?.frequency ? `mains ${s.info.frequency}` : null, s.info?.imageRotate && s.info.imageRotate !== '0' ? `corridor mode ${s.info.imageRotate}` : null].filter(Boolean)
    note.hidden = !sched && !info.length && !s.profile
    note.textContent = `${s.profile ? `Changes apply to the ${profileName(s.profile)} profile. ` : ''}${sched}${info.length ? ` Shown only: ${info.join(', ')}.` : ''}`
    this.$('.ip-location select').value = (this.notes?.location ?? s.location) || ''
  }

  renderFields(stale = []) {
    const s = this.settings
    const box = this.$('.ip-fields')
    box.replaceChildren()
    this.rows.clear()
    this.byPath = new Map(s.fields.map((f) => [f.path, f]))
    if (s.fields.length === 0) {
      box.textContent = 'This camera reports no picture settings that can be changed here.'
      return
    }
    const staleSet = new Set(stale.map((x) => x.path))
    for (const section of s.sections ?? ['Picture', 'Light', 'Exposure', 'Night', 'Colour', 'Orientation']) {
      const fields = s.fields.filter((f) => f.section === section)
      if (!fields.length) continue
      const fs = el('fieldset', {}, el('legend', {}, section))
      for (const f of fields) fs.append(this.row(f, staleSet.has(f.path)))
      box.append(fs)
    }
  }

  row(f, stale) {
    const id = `ip-f-${++idSeq}`
    const single = (f.kind === 'select' && f.options.length === 1) || (f.kind === 'index' && f.labels.length === 1) || (f.kind === 'usec' && f.options.length === 1)
    const kind = single ? 'text' : f.kind
    const row = el('div', { className: `ip-field ip-${kind === 'range' ? 'range' : kind === 'switch' ? 'switch' : 'select'}${stale ? ' ip-stale' : ''}` })
    const def = f.default === null || f.default === undefined ? null : `default ${valueText(f, f.default)}`
    const name = el('label', { className: 'ip-label', htmlFor: id }, f.label)
    const defEl = def ? el('small', { className: 'ip-def' }, def) : null
    const set = (v) => {
      this.setPending(f, v)
      this.update()
    }
    let input
    if (kind === 'range') {
      input = el('input', { type: 'range', min: f.min, max: f.max, step: 1, id })
      const num = el('input', { type: 'number', min: f.min, max: f.max, step: 1, className: 'ip-num', 'aria-label': `${f.label} value` })
      input.addEventListener('input', () => set(Number(input.value)))
      num.addEventListener('change', () => {
        const v = Math.round(Number(num.value))
        if (Number.isFinite(v)) set(Math.max(f.min, Math.min(f.max, v)))
      })
      row.append(name, num, input, defEl ?? '')
      this.rows.set(f.path, { row, input, num, field: f })
      return row
    }
    if (kind === 'switch') {
      input = el('input', { type: 'checkbox', id })
      input.addEventListener('change', () => set(input.checked))
      row.append(input, name, defEl ?? '')
    } else if (kind === 'text') {
      input = el('output', { id, className: 'ip-fixed' }, valueText(f, f.value))
      row.append(name, input, defEl ?? '')
    } else if (kind === 'time') {
      input = el('input', { type: 'time', step: 60, id, required: true })
      input.addEventListener('change', () => {
        if (/^([01]\d|2[0-3]):[0-5]\d$/.test(input.value)) set(input.value)
      })
      row.append(name, input, defEl ?? '')
    } else {
      input = el('select', { id })
      if (f.kind === 'index') input.append(...f.labels.map((l, i) => new Option(l, String(i))))
      else if (f.kind === 'usec') input.append(...f.options.map((o) => new Option(o.label, String(o.us))))
      else input.append(...f.options.map((o) => new Option(o, o)))
      input.addEventListener('change', () => set(f.kind === 'index' || f.kind === 'usec' ? Number(input.value) : input.value))
      row.append(name, input, defEl ?? '')
    }
    this.rows.set(f.path, { row, input, field: f, kind })
    return row
  }

  setPending(f, v, origin = 'manual') {
    if (same(v, f.value)) {
      this.pending.delete(f.path)
      this.origins.delete(f.path)
    } else {
      this.pending.set(f.path, v)
      this.origins.set(f.path, origin)
    }
  }

  valueOf(path) {
    return this.pending.has(path) ? this.pending.get(path) : this.byPath?.get(path)?.value
  }

  /** Brings the controls in line with the settings, the unsent changes and whether a request runs. */
  update() {
    const s = this.settings
    for (const [path, { row, input, num, field, kind }] of this.rows) {
      const v = this.valueOf(path)
      if (field.kind === 'switch') input.checked = v === true
      else if (kind !== 'text' && document.activeElement !== input) input.value = String(v)
      if (num && document.activeElement !== num) num.value = String(v)
      row.classList.toggle('ip-changed', this.pending.has(path))
      const ok = needMet(field.needs, this.byPath, (p) => this.valueOf(p))
      input.disabled = this.busy || !ok
      if (num) num.disabled = this.busy || !ok
      row.classList.toggle('ip-off', !ok)
      row.title = ok ? '' : `Only matters while ${this.byPath.get(field.needs.path)?.label ?? field.needs.path} is ${'eq' in field.needs ? valueText(this.byPath.get(field.needs.path), field.needs.eq) : `not ${field.needs.ne}`}`
    }
    const n = this.pending.size
    const auto = [...this.origins.values()].includes('auto')
    const apply = this.$('.ip-apply')
    apply.disabled = this.busy || n === 0 || !s
    apply.textContent = applyLabel(n, auto ? this.measured?.at : null)
    this.$('.ip-revert').disabled = this.busy || n === 0
    this.$('.ip-defaults').disabled = this.busy || !s
    this.$('.ip-profile select').disabled = this.busy
    this.$('.ip-location select').disabled = this.busy || !s
    const measure = this.$('.ip-measure')
    const other = s?.profile && s.active && s.profile !== s.active
    measure.textContent = other ? `Show ${profileName(s.active)} (in use) to auto adjust` : 'Auto adjust'
    measure.disabled = this.busy || !s
    measure.hidden = Boolean(this.measuring)
    const colour = this.$('.ip-colour')
    colour.disabled = this.busy || !s || Boolean(other)
    colour.hidden = Boolean(this.measuring)
    colour.title = other ? `Show ${profileName(s.active)} (in use) to check the colours: the check sees the profile in use` : 'Hold a ColorChecker chart or a white card in front of the camera and check its colours; nothing is sent until Apply'
    this.$('.ip-cancel').hidden = !this.measuring
    const undo = this.$('.ip-undo')
    undo.hidden = !s?.undo
    undo.disabled = this.busy
    const note = this.$('.ip-undo-note')
    note.hidden = !s?.undo
    note.textContent = s?.undo ? undoText(s.undo) : ''
    if (s?.undo) undo.setAttribute('aria-label', `Undo last change: ${s.undo.puts}`)
    for (const box of this.el.querySelectorAll('.ip-report input[data-item]')) {
      const it = this.items?.find((x) => x.id === box.dataset.item)
      box.checked = Boolean(it) && it.changes.every((c) => this.pending.has(c.path) && same(this.pending.get(c.path), c.to))
      box.disabled = this.busy
    }
    for (const b of this.el.querySelectorAll('.ip-box button, .ip-split button, .ip-result button')) if (!b.dataset.keep) b.disabled = this.busy || b.dataset.off === '1'
  }

  // ---- dialogs ---------------------------------------------------------------------------------

  /**
   * A modal dialog: title, lead text, a list (confirmation texts, or changes), and the action
   * button. Resolves true on the action, false on Cancel or Escape.
   */
  dialog({ title, lead = '', items = [], details = [], action = 'Apply anyway', danger = false }) {
    const d = this.$('.ip-dialog')
    const back = document.activeElement
    const tid = `ip-d-${++idSeq}`
    d.setAttribute('aria-labelledby', tid)
    const ok = el('button', { type: 'button', className: danger ? 'ip-danger' : 'ip-go' }, action)
    const cancel = el('button', { type: 'button' }, 'Cancel')
    d.replaceChildren(
      el('h3', { id: tid }, title),
      lead ? el('p', {}, lead) : '',
      items.length ? el('ul', { className: 'ip-acks' }, items.map((t) => el('li', {}, t))) : '',
      details.length ? el('details', { open: details.length <= 8 }, el('summary', {}, plural(details.length, 'value')), el('ul', {}, details.map((t) => el('li', {}, t)))) : '',
      el('div', { className: 'ip-dialog-buttons' }, cancel, ok)
    )
    return new Promise((resolve) => {
      const done = (v) => {
        d.close()
        if (back?.isConnected) back.focus()
        resolve(v)
      }
      ok.addEventListener('click', () => done(true))
      cancel.addEventListener('click', () => done(false))
      d.addEventListener('cancel', (e) => {
        e.preventDefault()
        done(false)
      }, { once: true })
      d.showModal()
      cancel.focus()
    })
  }

  /**
   * POST with the server's confirmations: a 409 needsAck is shown (or accepted without asking
   * when `shown` already listed exactly those texts) and the same body is sent again with the
   * acknowledgement keys and the token that ties them to this exact change.
   */
  async post(what, body, { title, lead, action = 'Apply anyway', shown = null, long = null, danger = false } = {}) {
    const send = async (b) => {
      if (long) this.progress(long)
      const session = this.session
      this.sending++
      try {
        return await api('POST', this.url(what), b)
      } finally {
        clearInterval(this.progressTimer)
        if (session === this.session) this.sending--
      }
    }
    let r = await send(body)
    for (let round = 0; round < 2 && r.status === 409 && Array.isArray(r.data?.needsAck); round++) {
      const list = r.data.needsAck
      const already = shown && sameTexts(list, shown)
      if (!already) {
        const ok = await this.dialog({ title: title ?? 'This change needs your confirmation', lead, items: list.map((i) => i.text), action, danger })
        if (!ok) return { cancelled: true }
      }
      r = await send({ ...body, ack: list.map((i) => i.key), ackToken: r.data.ackToken })
      shown = list.map((i) => i.text)
    }
    return r
  }

  // ---- Apply, Undo, Defaults -------------------------------------------------------------------

  defaults() {
    const s = this.settings
    if (!s) return
    const list = defaultsList(s)
    for (const { path, to } of list) {
      const f = this.byPath.get(path)
      if (f) this.setPending(f, to, 'defaults')
    }
    this.update()
    this.status(list.length ? `Defaults will change: ${list.map((x) => x.text).join(', ')}. Nothing is sent until Apply.` : 'Picture and colour are already at the camera\'s factory values.')
  }

  async apply() {
    const s = this.settings
    if (!s || this.busy || this.pending.size === 0) return
    const fromAuto = [...this.origins.values()].includes('auto')
    const body = applyBody(s, this.pending, this.origins)
    const items = fromAuto ? (this.items ?? []).filter((it) => it.changes.every((c) => this.pending.has(c.path) && same(this.pending.get(c.path), c.to))) : []
    const lines = Object.entries(body.changes).map(([p, v]) => changeLine(this.byPath.get(p), this.byPath.get(p)?.value, v))
    await this.change(body, { verb: 'Applying', lines, items, fromAuto })
  }

  async undo() {
    const s = this.settings
    if (!s?.undo || this.busy) return
    await this.change({ device: s.nvr.device, profile: s.profile ?? null, undo: true, seq: s.undo.seq, confirm: true }, { verb: 'Undoing', lines: [undoText(s.undo)] })
  }

  /** "Apply the other N changes" after a restart refusal: only those, once. */
  async applyOther(result) {
    const s = this.settings
    if (!s || this.busy) return
    const changes = result.remaining
    const body = { device: s.nvr.device, profile: s.profile ?? null, changes, seen: seenOf(s, Object.keys(changes)), retryOf: result.seq, confirm: true, ...(this.lastFromAuto ? { origin: 'auto' } : {}) }
    await this.change(body, { verb: 'Applying the other changes', lines: Object.entries(changes).map(([p, v]) => changeLine(this.byPath.get(p), this.byPath.get(p)?.value, v)), items: this.lastItems ?? [], fromAuto: this.lastFromAuto })
  }

  /** "Restart camera to apply X": its own dialog (the server's texts), then the restart path. */
  async restart(offer) {
    const s = this.settings
    if (!s || this.busy) return
    const lines = offer.changes.map((c) => changeLine(this.byPath.get(c.path), c.from, c.to, c.label))
    const body = { device: s.nvr.device, profile: s.profile ?? null, restartFor: offer.seq, group: offer.group, confirm: true }
    await this.change(body, {
      verb: `Restarting the camera to apply ${offer.label}`,
      lines,
      restart: true,
      title: `Restart camera to apply ${offer.label}?`,
      lead: `The camera restarts: offline about 1-2 minutes, and a gap in recording. It then gets: ${lines.join(', ')}.`,
      action: 'Restart camera',
      danger: true
    })
  }

  /**
   * Sends a change, Undo, retry or restart; handles the server's confirmations, a stale view,
   * and shows the result. After an applied Auto adjust change it lets the picture settle and
   * measures again.
   */
  async change(body, { verb, lines = [], items = [], fromAuto = false, restart = false, title, lead, action, danger } = {}) {
    const seq = this.seq
    const measuredBefore = this.measured
    this.busy = true
    this.update()
    this.status(`${verb}…`)
    let r
    try {
      r = await this.post('image', body, {
        title: title ?? 'This change needs your confirmation',
        lead: lead ?? (lines.length ? `It sends: ${lines.join(', ')}.` : ''),
        action: action ?? 'Apply anyway',
        danger,
        long: `${verb}… a change that may restart the camera waits up to 3 minutes for it`
      })
    } catch (e) {
      if (seq === this.seq) {
        this.busy = false
        this.update()
        this.status(`Could not reach the server (${e.message}); reopen the panel to see what the camera has`, { error: true })
      }
      return
    }
    if (seq !== this.seq) return
    this.busy = false
    if (r.cancelled) {
      this.update()
      this.status('Nothing was sent.')
      return
    }
    const data = r.data ?? {}
    if (!r.ok) {
      if (r.status === 409 && Array.isArray(data.stale) && data.settings) {
        // the camera changed since it was shown: the new values, the unsent ones kept, what changed marked
        this.show(data.settings, { keepPending: true, stale: data.stale })
        this.status(`${data.error}${/[.!]$/.test(data.error) ? '' : '.'} Check the marked settings, then Apply again.`, { error: true })
      } else if (r.status === 409 && data.active) {
        this.update()
        this.status(`${data.error}.`, { error: true })
      } else {
        this.update()
        this.status(data.error ?? `HTTP ${r.status}`, { error: true })
      }
      return
    }
    const result = data.result
    this.show(data.settings)
    this.lastItems = items
    this.lastFromAuto = fromAuto
    this.renderResult(result)
    this.status('')
    // what the next figures entry records: the rules applied, and what the camera refused or kept
    if (fromAuto) {
      this.conv.noteApplied(items, result, measuredBefore?.m)
      this.nextRules = Object.fromEntries(items.flatMap((it) => it.changes.map((c) => [c.path, it.rule])))
      this.nextRefused = Object.fromEntries(Object.entries(result.paths ?? {}).filter(([, st]) => ['kept', 'refused', 'restart-needed'].includes(st)))
    }
    const applied = ['done', 'partial'].includes(result.status)
    if (applied) {
      // the stream from now on is the changed camera's: judged on its own once 20 s are in
      this.meter?.mark()
      const before = measuredBefore?.streamFig ?? null
      this.usageCheck = before?.enough && typeof before.usage === 'number' ? { before, at: Date.now() } : null
    }
    if (applied && measuredBefore && (fromAuto || restart) && seq === this.seq) {
      const paths = Object.keys(body.changes ?? {}).length ? Object.keys(body.changes) : (result.groups ?? []).flatMap((g) => g.paths)
      const restarted = restart || (body.ack ?? []).some((k) => k === 'restart' || k === 'recording-gap') || Object.keys(result.paths ?? {}).some((p) => /^(backlightCompensation\.mode|WDR\.switch)$/.test(p))
      await this.settleAndMeasure({ paths, restarted, before: measuredBefore })
    }
  }

  renderResult(result) {
    const box = this.$('.ip-result')
    const v = resultView(result, this.settings)
    box.hidden = false
    box.className = `ip-result ip-${v.status}`
    const kids = [el('p', { className: 'ip-result-msg' }, v.message)]
    if (v.groups.length > 1 || v.groups.some((g) => g.status !== 'done')) kids.push(el('ul', {}, v.groups.map((g) => el('li', { className: `ip-st-${g.status}` }, g.text))))
    if (v.sideEffects.length) kids.push(el('p', { className: 'ip-side' }, `The camera also changed: ${v.sideEffects.join(', ')}.${this.settings?.undo ? ' Undo puts these back where it can.' : ''}`))
    const buttons = []
    if (v.other > 0) {
      const b = el('button', { type: 'button' }, `Apply the other ${plural(v.other, 'change')}`)
      b.addEventListener('click', () => this.applyOther(result))
      buttons.push(b)
    }
    for (const offer of v.offers) {
      const b = el('button', { type: 'button', className: 'ip-danger' }, `Restart camera to apply ${offer.label}…`)
      b.addEventListener('click', () => this.restart(offer))
      buttons.push(b)
    }
    if (buttons.length) kids.push(el('div', { className: 'ip-result-buttons' }, buttons))
    box.replaceChildren(...kids)
    this.update()
  }

  // ---- camera notes -----------------------------------------------------------------------------

  async saveLocation(location) {
    if (!this.cam) return
    const seq = this.seq
    const r = await api('POST', this.url('notes'), { location, confirm: true }).catch((e) => ({ ok: false, data: { error: e.message } }))
    if (seq !== this.seq) return
    if (!r.ok) return this.status(`Location not saved: ${r.data?.error ?? r.status}`, { error: true })
    this.notes = r.data
    if (this.settings) this.settings.location = r.data.location
    this.status(`Location saved (${r.data.location ?? 'not set'}): it decides whether colour is judged by the sun. Nothing is sent to the camera.`)
  }

  // ---- Auto adjust ------------------------------------------------------------------------------

  /**
   * The colour check over the full-size view (ColorChecker chart or white card). Its suggestions
   * come back as unsent changes of the profile in use, for Apply; nothing is sent from here.
   */
  colourCheck() {
    const s = this.settings
    if (!s || this.busy || this.measuring) return
    if (s.profile && s.active && s.profile !== s.active) return this.status(`Show ${profileName(s.active)} (in use) to check the colours: the check sees the profile in use.`, { error: true })
    if (!this.getPlayer()?.player) return this.status('No picture to check yet', { error: true })
    if (this.colourKey !== this.key) {
      // one per camera, so "Use the same corners as last time" works
      this.colour?.close()
      this.colour = null
    }
    this.colourKey = this.key
    // functions: they follow the sub -> main stream swap and the view's tile rebuilds
    const shown = () => this.getPlayer()?.player ?? null
    this.colour ??= new ColourCheck({
      host: () => shown()?.canvas?.closest('.tile') ?? null,
      video: () => shown()?.canvas ?? null,
      getFrames: playerFrames(shown), // decoded frames after a keyframe: the values the camera coded
      fields: () => this.settings?.fields ?? [],
      camera: `${this.cam.ch + 1} ${this.cam.name}`,
      onSuggest: (list) => {
        // [{ path, label, from, to, why }]: the ticked ones. Origin 'auto': the server refuses them
        // if the camera has switched profile since, as for Auto adjust's
        const cur = this.settings
        if (!cur || this.busy) return this.status('The colour changes were not added: the panel is busy; run the check again.', { error: true })
        if (cur.profile && cur.active && cur.profile !== cur.active) return this.status(`The colour changes were not added: the panel shows ${profileName(cur.profile)}, not the profile in use.`, { error: true })
        let n = 0
        for (const x of list) {
          const f = this.byPath?.get(x.path)
          if (!f) continue
          this.setPending(f, x.to, 'auto')
          n++
        }
        this.update()
        this.status(n ? `${plural(n, 'colour change')} ready: press Apply, then run the colour check again.` : 'No colour changes to make.')
      },
      onClose: () => {
        this.el.hidden = false
      }
    })
    if (!this.colour.open()) {
      this.el.hidden = false
      return this.status('No picture to check yet', { error: true })
    }
    this.el.hidden = true // the panel lies over the picture; the check needs all of it
  }

  /**
   * Measures the live picture (two keyframe intervals, in a Worker), reads the camera's settings
   * again, and prefills the ticked suggestions (optional ones stay unticked). `again`: the
   * measurement before an applied change, to compare with and judge it.
   */
  async autoAdjust({ again = null } = {}) {
    const s = this.settings
    if (!s || this.busy || this.colour?.isOpen) return // both take frames from the player, which allows one grab at a time
    if (!again && s.profile && s.active && s.profile !== s.active) {
      // "Show <active> (in use) to auto adjust": the profile shown changes, so unsent changes go
      if (!this.confirmDiscard(this.pending.size)) return
      return this.load(s.active)
    }
    const seq = this.seq
    const ctl = new AbortController()
    this.measuring = ctl
    this.busy = true
    this.update()
    try {
      this.status('Waiting for the main stream…')
      let view = this.getPlayer()
      if (!view?.player) throw new Error('No picture to measure yet')
      if (view.stream !== 'main' && !view.remote) view = (await this.waitForMain(5000)) ?? view
      if (!view?.player) throw new Error('No picture to measure yet')
      this.status('Measuring the picture: two keyframe intervals…')
      const m = await this.measure(view, ctl.signal)
      if (seq !== this.seq) return
      // the settings again, of the profile in use: the camera may have switched meanwhile
      this.status('Reading the camera\'s settings again…')
      const r = await api('GET', this.url())
      if (seq !== this.seq) return
      if (!r.ok) throw errorOf(r)
      const fresh = r.data.settings
      const switched = s.profile && fresh.profile !== s.profile ? `The camera switched to ${profileName(fresh.profile)} while measuring: measure again.` : null
      this.show(fresh, { keepPending: true })
      const streamFig = this.streamFigures()
      this.report(m, { again, switched, view, streamFig })
    } catch (e) {
      if (seq !== this.seq) return
      this.status(e?.name === 'AbortError' ? 'Measuring cancelled.' : `Could not measure the picture (${e.message})`, { error: e?.name !== 'AbortError' })
    } finally {
      if (seq === this.seq) {
        this.measuring = null
        this.busy = false
        this.update()
      }
    }
  }

  /** Two keyframe-aligned sets of frames through the Worker's Measurer (main thread if Workers fail). */
  async measure(view, signal) {
    const { player, stream } = view
    const codec = player.codecId === 1 ? 'h265' : player.codecId === 0 ? 'h264' : null
    let w
    try {
      w = new PictureWorker({ stream, codec })
    } catch {
      w = mainThreadMeasurer({ stream, codec })
    }
    try {
      const grab = await player.grabAfterKey({ sink: w.sink, signal, timeoutMs: GRAB_TIMEOUT_MS })
      const m = await w.result()
      if (!m) throw new Error(w.frameErrors?.[0] ?? 'no frame could be measured')
      m.grab = { reason: grab.reason, complete: grab.complete, gopMs: grab.gopMs }
      m.rangeFixed = Boolean(player.rangeFixed)
      return m
    } finally {
      w.close()
    }
  }

  report(m, { again, switched, view, streamFig }) {
    const s = this.settings
    const pos = this.position ?? cameraPosition(null, this.cam)
    const location = this.notes?.location ?? s.location ?? null
    const light = lightPeriod(new Date(), pos.lat, pos.lng, { location, mono: m.mono })
    const dc = displayCheck(m)
    const contra = contradiction(m, s)
    const sub = view.stream !== 'main'
    const ctx = {
      period: light.period,
      lightFollowsSun: light.lightFollowsSun,
      location,
      stream: sub ? null : streamFig,
      streamInfo: this.streamInfo,
      sub,
      lens: this.lensInfo,
      focusRef: this.notes?.focusRef ?? null,
      history: this.conv,
      canH265: this.canH265 ?? null,
      rangeMismatch: dc.mismatch
    }
    const verdicts = again ? this.conv.judge(m) : []
    const sug = suggest(m, s, ctx)
    const { changes, dropped } = this.conv.filter(sug.changes)
    const noTicks = switched ?? contra ?? null
    const items = sortSuggestions(changes, { settings: s, period: light.period, lightFollowsSun: light.lightFollowsSun, rangeMismatch: dc.mismatch, noTicks })
    const merged = mergePending(this.pending, this.origins, items)
    this.pending = merged.pending
    this.origins = merged.origins
    this.items = items
    this.streamItems = sug.stream.filter((x) => !x.note)
    this.streamNotes = sug.stream.filter((x) => x.note).map((x) => x.note)
    this.lensSug = sug.lens
    // for Focus now: good light is judged again at the click (it goes off after 10 minutes)
    this.lastLight = { period: light.period, mono: Boolean(m.mono), mean: m.mean, at: Date.now(), indoor: location === 'indoor', stream: view.stream }
    this.measured = { m, at: Date.now(), profile: s.profile, stream: view.stream, streamFig }
    // the stream after a change: only what was sent since it (the meter keeps 5 minutes)
    const streamAfter = again && !sub ? this.streamFigures({ sinceMark: true }) : null
    this.renderReport({ m, light, dc, items, sug, dropped, verdicts, again, merged, noTicks, sub, streamFig, streamAfter })
    this.renderStream()
    this.renderLens()
    this.update()
    const ticked = items.filter((i) => i.tier === 'tick').length
    this.status(noTicks ? noTicks : ticked ? `${plural(ticked, 'ticked change')} ready: press Apply, or untick what you don't want.` : 'Nothing ticked: see the report.')
    this.postFigures(m, light, dc, streamFig, view.stream)
    // Undo is highlighted when the last change made things worse (the stream only once 20 s
    // since the change are measured: checkUsage() does it then)
    if (streamAfter?.enough) this.usageCheck = null
    const worse = again ? afterCheck(again.m, m, { before: again.streamFig, after: streamAfter?.enough ? streamAfter : null }) : { undo: false, reasons: [] }
    const bad = worse.undo || verdicts.some((v) => v.verdict === 'worse')
    this.$('.ip-undo').classList.toggle('ip-warn', bad)
    if (bad) this.$('.ip-undo').title = `Consider Undo: ${[...worse.reasons, ...verdicts.filter((v) => v.verdict === 'worse').map((v) => `${v.rule} made it worse`)].join('; ')}`
  }

  renderReport({ m, light, dc, items, sug, dropped, verdicts, again, merged, noTicks, sub, streamFig, streamAfter = null }) {
    const s = this.settings
    const box = this.$('.ip-report')
    box.hidden = false
    const d = describe(m, { stream: sub ? null : streamFig })
    const head = `${again ? 'Measured again' : 'Measured'}: ${d.size}, ${sub ? 'sub' : 'main'} stream, ${m.frames} frames, ${s.profile ? `${profileName(s.profile)} profile, ` : ''}${hhmm(Date.now())} (${light.period}${light.elevation !== null ? `, sun ${light.elevation}°` : ''})`
    const kids = [el('h3', {}, head)]
    const line = (label, text) => el('p', {}, el('b', {}, `${label}: `), text)
    if (again) {
      const cmp = comparable(again.m, m, again.profile, s.profile)
      if (cmp.ok) {
        const b = describe(again.m, { stream: again.streamFig })
        const then = (k) => (b[k] === d[k] ? `unchanged: ${d[k]}` : `${b[k]} → ${d[k]}`)
        kids.push(line('Exposure', then('exposure')), line('Colour', then('colour')), line('Noise', then('noise')), line('Edges', then('focus')))
      } else {
        kids.push(el('p', { className: 'ip-muted' }, `Not compared with before: ${cmp.why}.`))
        kids.push(line('Exposure', d.exposure), line('Colour', d.colour), line('Noise', d.noise), line('Edges', d.focus))
      }
      if (verdicts.length) {
        kids.push(el('h4', {}, 'Last changes'))
        kids.push(el('ul', { className: 'ip-verdicts' }, verdicts.map((v) => el('li', { className: `ip-v-${v.verdict}` }, `${v.rule} (${v.paths.map((p) => this.byPath.get(p)?.label ?? p).join(', ')}): ${VERDICTS[v.verdict]}${v.before !== null && v.after !== null ? ` — ${v.target} ${v.before} → ${v.after}${v.spread !== null ? ` (spread ±${v.spread})` : ''}` : ''}`))))
      }
      if (this.conv.converged) kids.push(el('p', { className: 'ip-good' }, `Converged after ${this.conv.maxRounds} rounds: no more suggestions this session.`))
    } else {
      kids.push(line('Exposure', d.exposure), line('Colour', d.colour), line('Noise', d.noise), line('Edges', d.focus))
    }
    if (d.stream) kids.push(line('Stream', d.stream))
    if (again && streamAfter && !streamAfter.enough) kids.push(el('p', { className: 'ip-muted' }, `Stream since the change: not measured enough yet (${Math.floor(streamAfter.windowS ?? 0)} of 20 s); Undo is highlighted if its rate rises by 15% of the cap or more.`))
    else if (again && streamAfter?.enough) kids.push(line('Stream since the change', streamLine(streamAfter)))
    if (dc.text) kids.push(el('p', { className: dc.clips ? 'ip-warn-text' : 'ip-muted' }, `Display check: ${dc.text}`))
    if (m.grab && !m.grab.complete) kids.push(el('p', { className: 'ip-muted' }, `Measured ${m.frames} frames (${m.grab.reason}).`))
    if (noTicks) kids.push(el('p', { className: 'ip-warn-text', role: 'alert' }, noTicks))
    if (merged.kept.length) kids.push(el('p', { className: 'ip-muted' }, `Your unsent changes are kept: ${merged.kept.map((p) => this.byPath.get(p)?.label ?? p).join(', ')}.`))
    if (merged.conflicts.length) kids.push(el('p', { className: 'ip-muted' }, `Suggestions not used where you changed a value by hand: ${merged.conflicts.map((c) => this.byPath.get(c.path)?.label ?? c.path).join(', ')}.`))

    const section = (title, list, { checked = false } = {}) => {
      if (!list.length) return
      kids.push(el('h4', {}, title))
      kids.push(el('ul', { className: 'ip-items' }, list.map((it) => this.itemRow(it, checked))))
    }
    section('Ticked', items.filter((i) => i.tier === 'tick'), { checked: true })
    section('Optional', items.filter((i) => i.tier === 'optional'))
    section('Needs your confirmation', items.filter((i) => i.tier === 'confirm'))
    const left = [...sug.left.map((x) => x.text), ...dropped.filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i).map((x) => `${x.id} (${this.byPath.get(x.path)?.label ?? x.path}): not suggested again, ${x.why}.`)]
    if (left.length) {
      kids.push(el('h4', {}, 'Left alone'))
      kids.push(el('ul', { className: 'ip-plain' }, left.map((t) => el('li', {}, t))))
    }
    if (sug.info.length) {
      kids.push(el('h4', {}, 'Information'))
      kids.push(el('ul', { className: 'ip-plain' }, sug.info.map((x) => el('li', {}, x.text))))
    }
    const cast = m.colour?.neutral && Math.max(Math.abs(m.colour.neutral.r), Math.abs(m.colour.neutral.b)) >= 0.08
    if (!items.length && !left.length && !sug.info.length && !cast) kids.push(el('p', { className: 'ip-good' }, 'No suggestions from these rules for this light.'))
    if (this.streamItems.length || this.streamNotes?.length) kids.push(el('p', { className: 'ip-muted' }, 'Recording quality: see the box below (applied separately, with its own storage check).'))
    box.replaceChildren(...kids)
  }

  /** One suggestion: checkbox, from → to, why, downside and why it is not ticked. */
  itemRow(it, checked) {
    const wid = `ip-w-${++idSeq}`
    const cb = el('input', { type: 'checkbox', dataset: { item: it.id }, 'aria-describedby': wid })
    cb.checked = checked
    cb.addEventListener('change', () => {
      for (const c of it.changes) {
        const f = this.byPath.get(c.path)
        if (!f) continue
        if (cb.checked) this.setPending(f, c.to, 'auto')
        else if (this.pending.has(c.path) && same(this.pending.get(c.path), c.to)) {
          this.pending.delete(c.path)
          this.origins.delete(c.path)
        }
      }
      this.update()
    })
    const what = it.changes.map((c) => `${c.label} ${c.fromText} → ${c.toText}`).join(', ')
    const notes = [it.note ? `(${it.note})` : null, it.reasons.length ? `${it.tier === 'confirm' ? 'Needs your confirmation' : 'Not ticked'}: ${it.reasons.join('; ')}.` : null].filter(Boolean)
    return el('li', {},
      el('label', {}, cb, el('span', {}, `${what} `, el('small', { className: 'ip-rule' }, it.rule))),
      el('small', { id: wid, className: 'ip-why' }, it.why, el('br'), `Downside: ${it.downside}`, ...(notes.length ? [el('br'), notes.join(' ')] : []))
    )
  }

  /** Lets the picture settle after a change (and the stream come back after a restart), then measures again. */
  async settleAndMeasure({ paths, restarted, before }) {
    const seq = this.seq
    const ctl = new AbortController()
    this.measuring = ctl
    this.busy = true
    this.update()
    try {
      if (restarted) {
        this.status('Waiting for the picture to come back…')
        const until = Date.now() + 180_000
        let steady = 0
        while (Date.now() < until && steady < 3) {
          await sleep(1000, ctl.signal)
          steady = (this.getPlayer()?.player?.stats?.fps ?? 0) > 0 ? steady + 1 : 0
        }
        await sleep(SETTLE.AFTER_RESTART_MS, ctl.signal)
      }
      this.status('Letting the picture settle…')
      await sleep(settleMs(paths, this.settings), ctl.signal)
      const samples = []
      const t0 = Date.now()
      while (Date.now() - t0 < SETTLE.MAX_MS) {
        const v = quickMean(this.getPlayer()?.player)
        if (v !== null) samples.push(v)
        if (isSettled(samples)) break
        await sleep(SETTLE.EVERY_MS, ctl.signal)
      }
    } catch (e) {
      if (seq === this.seq) {
        this.measuring = null
        this.busy = false
        this.update()
        this.status(e?.name === 'AbortError' ? 'Measuring again cancelled.' : e.message, { error: e?.name !== 'AbortError' })
      }
      return
    }
    if (seq !== this.seq) return
    this.measuring = null
    this.busy = false
    this.update()
    await this.autoAdjust({ again: before })
  }

  /** The figures log entry for this measurement (numbers only; app data). */
  async postFigures(m, light, dc, streamFig, stream) {
    const s = this.settings
    if (!s || !this.cam) return
    // the browser goes with it: the display fix and its self-check are judged per browser
    const figures = figuresForLog(m, { stream: streamFig, rules: this.nextRules, refused: this.nextRefused, round: this.conv.round, browser: browserLabel(globalThis.navigator) })
    this.nextRules = null
    this.nextRefused = null
    const body = {
      device: s.nvr.device,
      period: light.period,
      profile: s.profile ?? null,
      stream,
      width: m.width,
      height: m.height,
      codec: m.codec ?? null,
      settingsHash: settingsHash(s),
      displayCheck: dc.range,
      figures
    }
    const r = await api('POST', this.url('figures'), body).catch(() => null)
    if (r?.ok && r.data.notes) this.notes = { ...this.notes, ...r.data.notes }
  }

  // ---- Recording quality (main stream) ------------------------------------------------------------

  /** Choose a recording resolution from the dropdown: replaces any resolution item (suggested or
   *  manual), keeps the other Recording-quality suggestions, and re-renders. Back to the current
   *  size clears it. The change still goes through Review (storage estimate) → confirm → apply. */
  pickResolution(target) {
    const si = this.streamInfo
    if (!si) return
    const kept = (this.streamItems ?? []).filter((it) => !it.change?.res)
    const item = resolutionChange(si, target)
    this.streamItems = item ? [item, ...kept] : kept
    this.renderStream()
  }

  renderStream() {
    const box = this.$('.ip-stream')
    const si = this.streamInfo
    if (!this.cam || (!si && !this.streamError)) {
      box.hidden = true
      return
    }
    box.hidden = false
    const kids = [el('h3', {}, 'Recording quality')]
    if (!si) {
      kids.push(el('p', { className: 'ip-muted' }, `Not available: ${this.streamError}`))
      box.replaceChildren(...kids)
      return
    }
    const c = si.current ?? {}
    kids.push(el('p', {}, `${String(c.enct ?? '').toUpperCase()} ${c.res} at ${c.fps} fps, bitrate cap ${c.QoI} kbit/s (${c.bitType}), quality ${c.level}.`))
    kids.push(el('p', { className: 'ip-stream-line ip-muted' }, ''))
    if (!si.candidate) kids.push(el('p', { className: 'ip-muted' }, `Changes are not offered here: ${si.why}.`))
    // resolution picker: pick any size the camera offers (raises or keeps; a bigger picture pulls
    // the bitrate cap up with it). Chosen here, it becomes one Recording-quality item, applied
    // through the same storage estimate and confirmation as the suggested changes.
    if (si.candidate) {
      const opts = resolutionOptions(si)
      if (opts.length > 1) {
        const chosen = (this.streamItems ?? []).find((it) => it.ticked && it.change?.res)?.change.res ?? c.res
        const sel = el(
          'select',
          { 'aria-label': 'Resolution' },
          opts.map((o) =>
            el('option', { value: o.res, disabled: o.disabled, title: o.reason ?? undefined }, o.reason ? `${o.res} — ${o.reason}` : o.res)
          )
        )
        sel.value = chosen
        sel.addEventListener('change', () => this.pickResolution(sel.value))
        kids.push(el('div', { className: 'ip-res' }, el('label', {}, 'Resolution ', sel)))
      }
    }
    for (const n of this.streamNotes ?? []) kids.push(el('p', { className: 'ip-muted' }, n))
    if (this.streamItems?.length) {
      kids.push(el('ul', { className: 'ip-items' }, this.streamItems.map((it) => {
        const wid = `ip-w-${++idSeq}`
        const cb = el('input', { type: 'checkbox', 'aria-describedby': wid })
        cb.checked = it.ticked
        cb.addEventListener('change', () => {
          it.ticked = cb.checked
          this.update()
          this.renderStream()
        })
        const what = Object.keys(it.change).map((k) => `${k} ${it.from[k]} → ${it.change[k]}`).join(', ')
        return el('li', {}, el('label', {}, cb, el('span', {}, `${what} `, el('small', { className: 'ip-rule' }, it.rule))), el('small', { id: wid, className: 'ip-why' }, it.why, el('br'), `Downside: ${it.downside}`))
      })))
      const ticked = this.streamItems.filter((i) => i.ticked)
      const review = el('button', { type: 'button', dataset: { off: ticked.length ? '0' : '1' } }, 'Review stream changes…')
      review.addEventListener('click', () => this.reviewStream())
      kids.push(el('div', { className: 'ip-box-buttons' }, review))
    }
    if (si.undo) {
      const u = el('button', { type: 'button' }, 'Undo stream change')
      u.title = `Puts back ${si.undo.puts} (changed ${new Date(si.undo.at).toLocaleString()} by ${si.undo.by})`
      u.addEventListener('click', () => this.undoStream())
      kids.push(el('div', { className: 'ip-box-buttons' }, u))
    }
    box.replaceChildren(...kids)
    this.renderStreamLine()
    this.update()
  }

  renderStreamLine() {
    const p = this.$('.ip-stream .ip-stream-line')
    if (!p) return
    const f = this.streamFigures()
    p.textContent = this.meterStream === 'sub' ? 'The full-size view is on the sub stream: the recording stream\'s rate is not measured.' : f ? `Measured: ${streamLine(f)}.` : 'Measuring the stream…'
  }

  /** Estimate dialog (the NVR's own storage estimate, before and after, and the worst case), then apply. */
  async reviewStream() {
    const si = this.streamInfo
    const ticked = (this.streamItems ?? []).filter((i) => i.ticked)
    if (!si || !ticked.length || this.busy) return
    const seq = this.seq
    const change = streamChangeOf(ticked)
    const measured = this.streamFigures()?.kbps ?? null
    this.busy = true
    this.update()
    this.status('Asking the NVR for its storage estimate…')
    try {
      const est = await api('POST', this.url('stream/estimate'), { change, ...(measured !== null ? { measuredKbps: measured } : {}) })
      if (seq !== this.seq) return
      if (!est.ok) throw errorOf(est)
      const e = est.data.estimate
      const impacts = e.impacts ?? []
      this.busy = false
      this.update()
      this.status('')
      if (e.retention?.refused) {
        // the site's minimum recording time: shown, never offered
        await this.dialog({ title: 'This stream change is refused', lead: 'The NVR\'s storage estimate, before and after:', items: estimateLines(e), action: 'OK' })
        return this.status(`${e.retention.refused} Nothing was sent.`, { error: true })
      }
      const ok = await this.dialog({ title: 'Change the recording stream?', lead: 'The NVR\'s storage estimate, before and after:', items: [...estimateLines(e), ...impacts.map((i) => i.text)], action: 'Apply stream change' })
      if (!ok || seq !== this.seq) return this.status('Nothing was sent.')
      this.busy = true
      this.update()
      this.status('Changing the recording stream…')
      const cur = si.current
      // Every setting the server will compare, bitType included. The server rejects a `seen` that
      // does not list them all -- the point being that nobody can confirm a change against a
      // picture of the camera that has since moved on -- so a setting added there has to be added
      // here in the same breath, or every stream change starts failing.
      const body = { device: this.settings.nvr.device, change, seen: { enct: cur.enct, res: cur.res, fps: cur.fps, QoI: cur.QoI, level: cur.level, bitType: cur.bitType }, confirm: true }
      const r = await this.post('stream', body, { title: 'Change the recording stream?', shown: impacts.map((i) => i.text), action: 'Apply stream change' })
      if (seq !== this.seq) return
      if (r.cancelled) return this.status('Nothing was sent.')
      if (!r.ok) throw errorOf(r)
      if (r.data.stream) this.streamInfo = r.data.stream
      this.streamItems = []
      this.streamNotes = []
      this.meter?.reset()
      this.status(r.data.result?.message ?? 'Done', { error: !['done'].includes(r.data.result?.status) })
    } catch (e) {
      if (seq === this.seq) this.status(e.message, { error: true })
    } finally {
      if (seq === this.seq) {
        this.busy = false
        this.renderStream()
        this.update()
      }
    }
  }

  async undoStream() {
    const si = this.streamInfo
    if (!si?.undo || this.busy) return
    const seq = this.seq
    this.busy = true
    this.update()
    this.status('Undoing the stream change…')
    try {
      const r = await this.post('stream', { device: this.settings.nvr.device, undo: true, seq: si.undo.seq, confirm: true }, { title: 'Undo the stream change?', lead: `Puts back ${si.undo.puts}.`, action: 'Undo stream change' })
      if (seq !== this.seq) return
      if (r.cancelled) return this.status('Nothing was sent.')
      if (!r.ok) throw errorOf(r)
      if (r.data.stream) this.streamInfo = r.data.stream
      this.meter?.reset()
      this.status(r.data.result?.message ?? 'Done', { error: r.data.result?.status !== 'done' })
    } catch (e) {
      if (seq === this.seq) this.status(e.message, { error: true })
    } finally {
      if (seq === this.seq) {
        this.busy = false
        this.renderStream()
      }
    }
  }

  // ---- Lens --------------------------------------------------------------------------------------

  renderLens() {
    const box = this.$('.ip-lens')
    const lens = this.lensInfo
    if (!lens?.supported) {
      box.hidden = true
      return
    }
    box.hidden = false
    const { ok: lightOk, why } = focusLight(this.lastLight, { period: this.periodNow() })
    const focus = el('button', { type: 'button', dataset: { off: lightOk ? '0' : '1' } }, 'Focus now')
    if (why) focus.title = why
    focus.addEventListener('click', () => this.focusNow())
    const id = `ip-l-${++idSeq}`
    const refocus = el('input', { type: 'checkbox', id })
    refocus.checked = this.lensPending ?? lens.IrchangeFocus
    refocus.addEventListener('change', () => {
      this.lensPending = refocus.checked === lens.IrchangeFocus ? null : refocus.checked
      this.renderLens()
    })
    const save = el('button', { type: 'button', dataset: { off: this.lensPending === null || this.lensPending === undefined ? '1' : '0' } }, 'Save')
    save.addEventListener('click', () => this.saveLens())
    const kids = [
      el('h3', {}, 'Lens'),
      el('p', { className: 'ip-muted' }, `Focus: ${lens.focusType ?? '?'}${lens.timeInterval ? `, refocus interval ${lens.timeInterval}` : ''}.${this.lensSug?.rise25 ? ` Edges now: ${this.lensSug.rise25.toFixed(2)} px.` : ''}${this.lensAfter ? ` ${this.lensAfter}` : ''}`),
      el('div', { className: 'ip-field ip-switch' }, refocus, el('label', { htmlFor: id, className: 'ip-label' }, 'Refocus at each day/night switch'), save),
      el('div', { className: 'ip-box-buttons' }, focus, why ? el('small', { className: 'ip-muted' }, why) : '')
    ]
    if (lens.undo) {
      const u = el('button', { type: 'button' }, 'Undo lens change')
      u.title = `Puts back ${lens.undo.puts} (not the refocus interval: in manual focus the NVR sets it to 0, and asks first when it is not 0)`
      u.addEventListener('click', () => this.lensPost({ action: 'undo', seq: lens.undo.seq }, 'Undoing the lens change…'))
      kids.push(el('div', { className: 'ip-box-buttons' }, u))
    }
    box.replaceChildren(...kids)
    this.update()
  }

  async saveLens() {
    const lens = this.lensInfo
    if (!lens || this.lensPending === null || this.lensPending === undefined) return
    await this.lensPost({ action: 'save', IrchangeFocus: this.lensPending, seen: { IrchangeFocus: lens.IrchangeFocus } }, 'Saving the lens setting…', { title: 'Save the lens setting?' })
    this.lensPending = null
    this.renderLens()
  }

  /** Day, dusk or night at this camera now (the sun where it is). */
  periodNow() {
    const pos = this.position ?? cameraPosition(null, this.cam)
    return lightPeriod(new Date(), pos.lat, pos.lng, { location: this.notes?.location ?? this.settings?.location ?? null }).period
  }

  async focusNow() {
    if (this.busy) return
    // the light again at the click: an old reading, or dusk since, turns it off
    const { ok: good, why, light } = focusLight(this.lastLight, { period: this.periodNow() })
    if (!good) {
      this.renderLens()
      this.status(why, { error: true })
      return
    }
    const ok = await this.dialog({ title: 'Focus now?', lead: 'The lens refocuses by itself: the picture blurs for a few seconds. Only in good light (autofocus in the dark hunts).', action: 'Focus now' })
    if (!ok) return
    const before = this.measured?.m?.lines?.rise25 ?? null
    const done = await this.lensPost({ action: 'focus', light }, 'Focusing…')
    if (!done || !this.cam) return
    // edges before and after (a measurement only; no suggestions change)
    const seq = this.seq
    try {
      await sleep(5000)
      const view = this.getPlayer()
      if (!view?.player || seq !== this.seq) return
      this.status('Measuring the edges after focusing…')
      const m = await this.measure(view)
      if (seq !== this.seq) return
      const after = m.lines?.rise25 ?? null
      this.lensAfter = `After Focus now: edges ${before !== null ? `${before.toFixed(2)} → ` : ''}${after !== null ? after.toFixed(2) : '?'} px (lower is sharper).`
      this.status(this.lensAfter)
      this.renderLens()
    } catch (e) {
      if (seq === this.seq) this.status(`Could not measure after focusing (${e.message})`, { error: true })
    }
  }

  async lensPost(body, verb, opts = {}) {
    if (this.busy || !this.settings) return false
    const seq = this.seq
    this.busy = true
    this.update()
    this.status(verb)
    try {
      const r = await this.post('lens', { device: this.settings.nvr.device, confirm: true, ...body }, { title: opts.title ?? 'This lens change needs your confirmation', action: 'Save anyway' })
      if (seq !== this.seq) return false
      if (r.cancelled) {
        this.status('Nothing was sent.')
        return false
      }
      if (!r.ok) {
        if (r.data?.lens) this.lensInfo = r.data.lens
        throw errorOf(r)
      }
      this.lensInfo = r.data.lens
      this.status(r.data.result?.message ?? 'Done', { error: r.data.result?.status === 'failed' })
      return r.data.result?.status !== 'failed'
    } catch (e) {
      if (seq === this.seq) this.status(e.message, { error: true })
      return false
    } finally {
      if (seq === this.seq) {
        this.busy = false
        this.renderLens()
      }
    }
  }

  // ---- Day/Night set-up ---------------------------------------------------------------------------

  renderSplit() {
    const box = this.$('.ip-split')
    const s = this.settings
    const plan = this.plan
    if (!s || (!plan && !s.scheduleUndo)) {
      box.hidden = true
      return
    }
    box.hidden = false
    const kids = []
    if (plan) {
      const b = el('button', { type: 'button', dataset: { off: plan.offerable ? '0' : '1' } }, 'Day/Night set-up…')
      if (!plan.offerable) b.title = `Not offered: ${plan.reasons.join('; ')}`
      b.addEventListener('click', () => this.split())
      kids.push(b)
      if (!plan.offerable) kids.push(el('small', { className: 'ip-muted' }, `Day/Night set-up not offered: ${plan.reasons[0]}${plan.reasons.length > 1 ? ` (and ${plural(plan.reasons.length - 1, 'more reason')}, on hover)` : ''}.`))
    }
    if (s.scheduleUndo) {
      const u = el('button', { type: 'button' }, 'Undo schedule change')
      u.title = `Puts back ${s.scheduleUndo.puts} (changed ${new Date(s.scheduleUndo.at).toLocaleString()} by ${s.scheduleUndo.by})`
      u.addEventListener('click', () => this.undoSchedule())
      kids.push(u)
    }
    box.replaceChildren(...kids)
    this.update()
  }

  async split() {
    const plan = this.plan
    if (!plan?.offerable || this.busy) return
    const seq = this.seq
    const details = [...plan.day.map((d) => `Day: ${d.label} ${d.from ?? '(none)'} → ${d.to ?? '(none)'}`), ...plan.night.map((d) => `Night: ${d.label} ${d.from ?? '(none)'} → ${d.to ?? '(none)'}`)]
    const ok = await this.dialog({
      title: 'Set up Day and Night profiles?',
      lead: 'Day and Night start as copies of Normal (every value below), then the camera switches between them by the light. Floodlit colour cameras stay on Day at night. Normal is not changed; Undo puts the schedule back to Normal.',
      items: plan.impacts.map((i) => i.text),
      details,
      action: 'Set up Day/Night'
    })
    if (!ok || seq !== this.seq) return
    this.busy = true
    this.update()
    this.progress('Copying Normal into Day and Night, then switching to automatic…')
    const session = this.session
    this.sending++
    try {
      const r = await api('POST', this.url('image/profiles'), { device: this.settings.nvr.device, action: 'split', ack: plan.impacts.map((i) => i.key), ackToken: plan.ackToken, confirm: true }).finally(() => {
        if (session === this.session) this.sending--
      })
      if (seq !== this.seq) return
      if (r.data?.plan) this.plan = r.data.plan
      if (!r.ok) throw errorOf(r)
      this.status(r.data.result.message, { error: r.data.result.status !== 'done' })
    } catch (e) {
      if (seq === this.seq) this.status(e.message, { error: true })
    } finally {
      if (seq === this.seq) {
        this.busy = false
        await this.load(null, { keepPending: false })
        this.loadPlan()
      }
    }
  }

  async undoSchedule() {
    const s = this.settings
    if (!s?.scheduleUndo || this.busy) return
    const seq = this.seq
    this.busy = true
    this.update()
    this.status('Putting the schedule back…')
    try {
      const r = await this.post('image/schedule', { device: s.nvr.device, undo: true, seq: s.scheduleUndo.seq, confirm: true }, { title: 'Undo the schedule change?', lead: `Puts back ${s.scheduleUndo.puts}.`, action: 'Undo schedule change' })
      if (seq !== this.seq) return
      if (r.cancelled) return this.status('Nothing was sent.')
      if (!r.ok) throw errorOf(r)
      this.show(r.data.settings)
      this.status(r.data.result?.message ?? 'Done', { error: r.data.result?.status !== 'done' })
    } catch (e) {
      if (seq === this.seq) this.status(e.message, { error: true })
    } finally {
      if (seq === this.seq) {
        this.busy = false
        this.update()
        this.loadPlan()
      }
    }
  }
}
