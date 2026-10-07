// The motion tuning panel on the Alarms page: a live picture with the NVR's watched zones drawn
// over it, a meter showing how much of that area this server measures changing, and — behind an
// explicit per-camera confirmation — the one control that writes to the owner's NVR.
//
// The arithmetic is all in motion-view.js and tested there. This file opens the stream, samples it
// and paints.
//
// The live picture is a LiveTile on the SUB-stream, the same one the grid and the map use. That
// matters here: nvr-2 is at its bandwidth ceiling and refuses main streams, and tuning a camera
// must not be the thing that costs somebody their live view.
import { LiveTile, SUB_STREAM, TILE_HTML } from './live-tile.js'
import { changedFraction, confirmText, maskFromArea, meterReading, pct, thresholdNote } from './motion-view.js'

/** How often the picture is sampled. Twice a second is plenty for a meter somebody is watching. */
const SAMPLE_MS = 500
/** The sample size. Small on purpose: this runs in the browser, beside a decoding video. */
const W = 64
const H = 48
/** How many samples the meter remembers. About a minute at two a second. */
const HISTORY = 120
/** Samples not counted after a camera is chosen: the stored still giving way to the live picture read as 87 % 'movement'. */
const WARMUP_SAMPLES = 4
/** Starts with a capital, ends with a full stop. */
const sentence = (s) => {
  const t = String(s ?? '').trim()
  if (!t) return ''
  return `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}`
}

export class MotionTuner {
  /**
   * @param {{ tile: HTMLElement, overlay: HTMLCanvasElement, meter: HTMLElement, note: HTMLElement,
   *           form: HTMLFormElement, error: HTMLElement, result: HTMLElement }} els
   */
  constructor(els) {
    this.els = els
    this.tile = null
    this.camera = null
    this.motion = null
    this.mask = null
    this.history = []
    this.prev = null
    this.sampler = document.createElement('canvas')
    this.sampler.width = W
    this.sampler.height = H
    this.ctx = this.sampler.getContext('2d', { willReadFrequently: true })
    this.timer = null
    // counts the cameras chosen, so an answer can tell whether it is still for the one on show
    this.seq = 0
    els.form?.addEventListener('submit', (e) => this.#onSubmit(e))
  }

  /** Switches to a camera: opens its stream, reads what the NVR says, starts measuring. */
  async show(camera) {
    this.stop()
    const seq = ++this.seq
    this.camera = camera
    // the last camera's answer is not this one's: no write control until this camera's own is in
    this.motion = null
    this.els.form.hidden = true
    this.history = []
    this.prev = null
    // the first pictures are the stored still, then the live one arriving: not movement
    this.warmup = WARMUP_SAMPLES
    if (!camera) return
    this.els.tile.innerHTML = TILE_HTML
    // (a LiveTile connects itself as soon as it is made)
    this.tile = new LiveTile(this.els.tile, { nvr: camera.nvr, ch: camera.ch }, SUB_STREAM, 0)

    // What the NVR itself is set to. Everything here degrades: a camera whose NVR does not answer
    // shows the meter and says the setting is not available, rather than showing a made-up slider.
    const motion = await fetch(`/api/admin/nvrs/${encodeURIComponent(camera.nvr)}/channels/${camera.ch}/motion-tune`, { headers: { accept: 'application/json' } })
      .then((r) => r.json())
      .catch((e) => ({ available: false, why: `the server could not be asked: ${e.message}` }))
    // Another camera was chosen, or the panel closed, while the NVR was being asked (it can take many
    // seconds). This answer is the earlier camera's: shown now it would put that camera's sensitivity
    // and zones on this one, and its timer would be one nothing ever stops.
    if (seq !== this.seq) return
    this.motion = motion
    this.els.note.textContent = sentence(thresholdNote(this.motion))
    const masked = maskFromArea(this.motion?.area, W, H)
    this.mask = masked.mask
    // two sentences, not one run-on line
    if (masked.why) this.els.note.textContent = `${sentence(this.els.note.textContent)} ${sentence(masked.why)}`
    this.#drawZones()
    // The write control appears only when we actually read a current value, because a change is
    // built by sending the NVR's own answer back with one number altered — with no answer there is
    // nothing safe to send.
    this.els.form.hidden = !this.motion?.available
    if (this.motion?.available) this.els.form.elements.threshold.value = this.motion.sensitivity
    clearInterval(this.timer)
    this.timer = setInterval(() => this.#sample(), SAMPLE_MS)
  }

  stop() {
    this.seq++ // an answer still on its way is for a camera no longer shown
    clearInterval(this.timer)
    this.timer = null
    this.tile?.close?.()
    this.tile = null
    this.els.result.textContent = ''
    this.els.error.textContent = ''
  }

  /** One measurement: the tile's canvas shrunk to a small greyscale sample and compared with the last. */
  #sample() {
    const canvas = this.els.tile.querySelector('canvas')
    if (!canvas?.width) return
    this.ctx.drawImage(canvas, 0, 0, W, H)
    const { data } = this.ctx.getImageData(0, 0, W, H)
    const grey = new Uint8Array(W * H)
    for (let i = 0; i < grey.length; i++) {
      // the usual luminance weights: green carries most of the brightness a person sees
      grey[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8
    }
    const f = changedFraction(this.prev, grey, this.mask)
    this.prev = grey
    if (this.warmup > 0) {
      this.warmup--
      return
    }
    if (f !== null) {
      this.history.push(f)
      if (this.history.length > HISTORY) this.history.shift()
    }
    this.#drawMeter()
  }

  #drawMeter() {
    const r = meterReading(this.history)
    const m = this.els.meter
    if (!r.samples) {
      m.textContent = 'Waiting for video from this camera…'
      return
    }
    // three figures side by side, the words under them (was one long sentence)
    const stat = (value, words) => {
      const d = document.createElement('div')
      d.className = 'al-stat'
      const b = document.createElement('b')
      b.textContent = pct(value)
      const s = document.createElement('span')
      s.textContent = words
      d.append(b, s)
      return d
    }
    const grid = document.createElement('div')
    grid.className = 'al-stats'
    grid.append(stat(r.now, 'moving now'), stat(r.average, 'average'), stat(r.peak, 'highest seen'))
    const note = document.createElement('p')
    note.className = 'hp-note'
    note.textContent = `Share of the watched area changing between two pictures, over the last ${r.samples} samples (two a second).`
    m.replaceChildren(grid, note)
  }

  /** The NVR's watched zones, shaded over the picture. Nothing is drawn when it did not tell us. */
  #drawZones() {
    const c = this.els.overlay
    const area = this.motion?.area
    const box = this.els.tile.getBoundingClientRect()
    c.width = Math.max(1, Math.round(box.width))
    c.height = Math.max(1, Math.round(box.height))
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, c.width, c.height)
    if (!area?.cells?.length) return
    const cw = c.width / area.cols
    const chh = c.height / area.rows
    ctx.fillStyle = 'rgba(80, 160, 255, 0.18)'
    ctx.strokeStyle = 'rgba(80, 160, 255, 0.35)'
    for (let y = 0; y < area.rows; y++) {
      for (let x = 0; x < area.cols; x++) {
        if (!area.cells[y][x]) continue
        ctx.fillRect(x * cw, y * chh, cw, chh)
        ctx.strokeRect(x * cw, y * chh, cw, chh)
      }
    }
  }

  /** The write. Two gates: the browser's own confirm, and `confirm: true` in the request body. */
  async #onSubmit(e) {
    e.preventDefault()
    this.els.error.textContent = ''
    this.els.result.textContent = ''
    const want = Number(this.els.form.elements.threshold.value)
    if (!Number.isInteger(want)) return void (this.els.error.textContent = 'Give a whole number.')
    if (!confirm(confirmText(this.camera.name ?? `${this.camera.nvr}/${this.camera.ch}`, this.motion.sensitivity, want))) return
    const res = await fetch(`/api/admin/nvrs/${encodeURIComponent(this.camera.nvr)}/channels/${this.camera.ch}/motion-tune`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threshold: want, confirm: true })
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return void (this.els.error.textContent = body.error ?? `The change failed (${res.status}).`)
    // The server read the setting back rather than trusting the NVR's "success", and says which.
    this.els.result.textContent = body.changed === false
      ? body.note
      : body.applied
        ? `Changed on the NVR: ${body.before.sensitivity} → ${body.after.sensitivity}. It is in data/motion-changes.log.`
        : body.warning ?? 'The NVR accepted the change but did not report the new value.'
    this.motion = body.after?.available ? { ...this.motion, ...body.after } : this.motion
    this.els.note.textContent = sentence(thresholdNote(this.motion))
  }
}
