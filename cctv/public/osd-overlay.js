// The on-screen display this app draws over the picture: the camera's name and the time, worked
// out here and painted by the pages (live-tile.js on the live tiles, playback.js over the playback
// canvas). Pure: no DOM, no imports, so the arithmetic can be tested offline (test/osd-overlay.test.mjs).
//
// WHY THE APP DRAWS IT RATHER THAN THE CAMERA
// The obvious way would be to move the camera's own burnt-in OSD over the NVR, and the SDK does
// have queryIPChlORChlOSD / editIPChlORChlOSD for exactly that. Both of our NVRs flatly refuse
// those calls (nvr1 errorCode 536871059, solus 536870923) whatever we send them, including an empty
// body, so the request shape is not the problem and there is nothing left to try; cctv/osd.mjs and
// cctv/osd-doc.mjs keep that work in case a shape ever turns up. Drawing it here is better anyway,
// for three reasons worth stating plainly:
//   1. It shows the SERVER's clock, which is the authoritative one now that the master-clock sync
//      is fixed. Until today solus was 27 minutes fast, so anything burnt in by that camera was 27
//      minutes wrong, for ever, in the footage. What we draw is right because the server is right.
//   2. It is reversible. A badly placed overlay here is a settings change; a badly placed overlay
//      burnt in by a camera sits across a month of recorded evidence and cannot be taken out.
//   3. It is one change in one place rather than sixty-eight changes on sixty-eight cameras, each
//      needing the camera to be reachable and each able to fail halfway.
// The cost, stated honestly: this overlay is drawn at viewing time, so it is NOT in the recorded
// file and NOT in an export. Export deliberately copies the recorded stream without re-encoding
// (export-job.mjs, mp4.mjs), and burning text in would mean re-encoding every exported clip. That
// trade is described in the report; the export path is left exactly as it is.
//
// POSITION is held as fractions of the width and height (0-1), not pixels, so the same setting
// holds on a phone tile, a 1080p tile and a 4K full-screen view. SIZE is the text height as a
// percentage of the tile's height, again so it scales, with a floor in real pixels so that a tile
// in an 8x8 grid on a phone does not end up with two-pixel text nobody can read.

/** Text height as a percentage of the tile height. */
export const DEFAULT_SIZE = 3.2
export const MIN_SIZE = 1
export const MAX_SIZE = 12
/** The floor in real pixels: below this the text is not readable at all, so scaling stops here. */
export const MIN_FONT_PX = 11
export const MAX_TEXT = 40
/** Appended when a line will not fit the tile even after the font floor has been reached. */
export const ELLIPSIS = '…'

/**
 * What every camera gets unless it has been given its own settings. Name and time both on, near
 * the top-left corner, because that is where a viewer's eye already goes and it is the corner
 * least often covered by the tile's own label strip at the bottom.
 */
export const DEFAULT_OSD = Object.freeze({
  showName: true,
  showTime: true,
  text: null, // null means "use the camera's own name"; never a made-up placeholder
  x: 0.02,
  y: 0.03,
  size: DEFAULT_SIZE
})

const FIELDS = Object.keys(DEFAULT_OSD)

/**
 * The nine places the corner picker offers. These are only shortcuts for an x/y pair: a position
 * that came from somewhere else is still valid, and the picker simply shows none of them as chosen.
 * The insets are not zero because a real picture usually has something at its very edge, and
 * because a television or a projector may cut the outermost few per cent off altogether.
 */
export const OSD_CORNERS = Object.freeze([
  { id: 'top-left', label: 'Top left', x: 0.02, y: 0.03 },
  { id: 'top-centre', label: 'Top centre', x: 0.5, y: 0.03 },
  { id: 'top-right', label: 'Top right', x: 0.98, y: 0.03 },
  { id: 'middle-left', label: 'Middle left', x: 0.02, y: 0.5 },
  { id: 'centre', label: 'Centre', x: 0.5, y: 0.5 },
  { id: 'middle-right', label: 'Middle right', x: 0.98, y: 0.5 },
  { id: 'bottom-left', label: 'Bottom left', x: 0.02, y: 0.97 },
  { id: 'bottom-centre', label: 'Bottom centre', x: 0.5, y: 0.97 },
  { id: 'bottom-right', label: 'Bottom right', x: 0.98, y: 0.97 }
])

/** Which corner an x/y pair is sitting on, or null when it has been nudged off all of them. */
export function cornerOf({ x, y } = {}) {
  const near = (a, b) => Math.abs(a - b) < 0.005
  return OSD_CORNERS.find((c) => near(c.x, x) && near(c.y, y))?.id ?? null
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// ---- settings ---------------------------------------------------------------------------------

/**
 * Checks one camera's (or the default) OSD settings and returns a tidy copy. Throws with a message
 * a person can act on, because the same function runs in the page and again on the server, and an
 * admin who mistypes a figure deserves to be told which one. Anything missing falls back to the
 * built-in default rather than being left undefined, so a stored settings object is always complete
 * and the drawing code never has to guess.
 *
 * @param {unknown} v
 * @param {{ base?: object }} [opts] base: what a missing field falls back to (a camera falls back
 *   to the site-wide default, the site-wide default falls back to DEFAULT_OSD)
 */
export function cleanOsdSettings(v, { base = DEFAULT_OSD } = {}) {
  if (v === null || v === undefined) return { ...DEFAULT_OSD, ...base }
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('OSD settings must be an object')
  for (const k of Object.keys(v)) if (!FIELDS.includes(k)) throw new Error(`OSD settings: unknown field "${String(k).slice(0, 32)}"`)
  const d = { ...DEFAULT_OSD, ...base }
  const out = {}

  for (const k of ['showName', 'showTime']) {
    const b = v[k]
    if (b === undefined) out[k] = d[k]
    else if (typeof b !== 'boolean') throw new Error(`OSD settings: ${k} must be true or false`)
    else out[k] = b
  }

  // The text defaults to the camera's own name, which is why null is a real value here and not
  // simply "unset": an admin who clears the box is asking for the camera's name back, not for a
  // blank overlay. A name that is not known stays unknown (osdLines draws no name line at all)
  // rather than becoming "Camera 3" or any other invention.
  if (v.text === undefined) out.text = d.text ?? null
  else if (v.text === null) out.text = null
  else if (typeof v.text !== 'string') throw new Error('OSD settings: text must be a string, or null for the camera’s own name')
  else {
    const t = v.text.replace(/\s+/g, ' ').trim()
    if (t.length > MAX_TEXT) throw new Error(`OSD settings: text is longer than ${MAX_TEXT} characters`)
    out.text = t === '' ? null : t
  }

  for (const k of ['x', 'y']) {
    if (v[k] === undefined) out[k] = d[k]
    else {
      const n = num(v[k])
      if (n === null) throw new Error(`OSD settings: ${k} must be a number`)
      if (n < 0 || n > 1) throw new Error(`OSD settings: ${k} must be between 0 and 1 (a fraction of the picture)`)
      out[k] = n
    }
  }

  if (v.size === undefined) out.size = d.size
  else {
    const n = num(v.size)
    if (n === null) throw new Error('OSD settings: size must be a number')
    if (n < MIN_SIZE || n > MAX_SIZE) throw new Error(`OSD settings: size must be between ${MIN_SIZE} and ${MAX_SIZE} (per cent of the picture height)`)
    out.size = n
  }
  return out
}

/** One camera's settings: its own where it has them, otherwise the site-wide default. */
export function osdFor(defaults, perCamera) {
  const base = cleanOsdSettings(defaults)
  return cleanOsdSettings(perCamera, { base })
}

/** Nothing to draw at all — the pages skip the whole overlay rather than sizing a canvas for it. */
export const osdIsOff = (s) => !s || (!s.showName && !s.showTime)

// ---- the time ---------------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0')

/**
 * "2026-09-25 14:03:12", the same shape playback.js already prints under the timeline (fmtDate +
 * fmtTime), so a still taken off a tile and a still taken off playback read alike.
 *
 * `atMs` is a moment on the SERVER's clock, and `tzMs` is the offset (local - UTC) it is to be
 * shown in — the same trick playback.js uses, reading a shifted Date with getUTC* so the browser's
 * own time zone can never creep in. Both pages label this clock as the server's in the settings UI:
 * it is not the camera's clock and must not be passed off as one.
 */
export function osdTimeText(atMs, tzMs = 0) {
  if (!Number.isFinite(atMs)) return null
  const d = new Date(atMs + (Number.isFinite(tzMs) ? tzMs : 0))
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/**
 * The lines of text, top to bottom, for one camera at one moment. A camera whose name is not known
 * simply has no name line: an overlay saying "Unknown" or "Camera" would be worse than nothing,
 * because a viewer would read it as a fact about that camera.
 */
export function osdLines(settings, camera = {}, atMs = null, tzMs = 0) {
  const s = settings ?? DEFAULT_OSD
  const out = []
  if (s.showName) {
    const name = s.text ?? (typeof camera.name === 'string' ? camera.name.trim() : '')
    if (name) out.push(name)
  }
  if (s.showTime) {
    const t = osdTimeText(atMs, tzMs)
    if (t) out.push(t)
  }
  return out
}

// ---- measuring and fitting ---------------------------------------------------------------------

/**
 * A rough width when there is no canvas to ask (the tests, and the first paint before a context
 * exists). 0.55 em per character is close enough for a sans-serif at these sizes; the pages pass a
 * real measurer, so this only ever has to be in the right area.
 */
export const estimateWidth = (text, fontPx) => text.length * fontPx * 0.55

/**
 * Cuts a line down until it fits, keeping the start and marking the cut with an ellipsis. The start
 * is kept because that is where a camera name carries its meaning ("Yard — north gate, by the
 * bins"): losing the tail still leaves something recognisable, losing the head does not.
 */
export function fitText(text, maxPx, fontPx, measure = estimateWidth) {
  if (!text) return ''
  if (measure(text, fontPx) <= maxPx) return text
  // Nothing sensible fits at all: better an empty line than a lone ellipsis pretending to be text.
  if (measure(ELLIPSIS, fontPx) > maxPx) return ''
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(text.slice(0, mid) + ELLIPSIS, fontPx) <= maxPx) lo = mid
    else hi = mid - 1
  }
  return lo === 0 ? ELLIPSIS : text.slice(0, lo).trimEnd() + ELLIPSIS
}

/**
 * The font size for a tile. The stored size is a percentage of the tile's height so it scales with
 * the tile, but two limits apply in real pixels: never below MIN_FONT_PX, or a small tile on a
 * phone becomes unreadable, and never more than a sixth of the tile's height, or two lines of text
 * cover a third of the picture.
 */
export function osdFontPx(size, height) {
  const h = Math.max(1, Number(height) || 0)
  const pct = clamp(Number(size) || DEFAULT_SIZE, MIN_SIZE, MAX_SIZE)
  return Math.round(clamp((h * pct) / 100, MIN_FONT_PX, Math.max(MIN_FONT_PX, h / 6)))
}

/**
 * Everything the painter needs: where each line goes, in pixels, for this canvas size.
 *
 * The block of text is placed by its anchor (settings.x/y as fractions), then clamped so it can
 * never hang off an edge — including the case where the text is simply wider than the tile, when
 * it is pinned to the left margin and cut to fit rather than allowed to run away. The alignment
 * follows the anchor: an overlay on the right-hand side grows leftwards, one at the bottom grows
 * upwards, so dragging it into a corner behaves the way a person expects.
 *
 * @param {object} p
 * @param {object} p.settings cleaned settings (osdFor)
 * @param {{ name?: string }} [p.camera]
 * @param {number|null} [p.atMs] the moment, on the server's clock
 * @param {number} p.width canvas width in pixels
 * @param {number} p.height canvas height in pixels
 * @param {number} [p.tzMs] offset the time is shown in (local - UTC)
 * @param {(text: string, fontPx: number) => number} [p.measure] a real text measurer if there is one
 * @returns {{ fontPx: number, lineHeight: number, pad: number, box: {x,y,w,h}|null,
 *   lines: Array<{ text: string, x: number, y: number, align: 'left'|'centre'|'right' }> }}
 */
export function osdLayout({ settings, camera = {}, atMs = null, width, height, tzMs = 0, measure = estimateWidth }) {
  const s = settings ?? DEFAULT_OSD
  const w = Math.max(1, Number(width) || 0)
  const h = Math.max(1, Number(height) || 0)
  const fontPx = osdFontPx(s.size, h)
  const lineHeight = Math.round(fontPx * 1.3)
  const padPx = Math.max(2, Math.round(fontPx * 0.35))
  const empty = { fontPx, lineHeight, pad: padPx, box: null, lines: [] }

  const texts = osdLines(s, camera, atMs, tzMs)
  if (!texts.length) return empty

  // How wide a line may be. The margin is taken off both sides, and a tile narrower than its own
  // margins (it happens while a pane is being dragged) draws nothing rather than negative widths.
  const avail = w - 2 * padPx
  if (avail <= 0) return empty
  const fitted = texts.map((t) => fitText(t, avail, fontPx, measure)).filter(Boolean)
  if (!fitted.length) return empty

  const widths = fitted.map((t) => measure(t, fontPx))
  const blockW = Math.min(avail, Math.max(...widths))
  const blockH = fitted.length * lineHeight

  // Which way the block grows from its anchor. Past the middle of the picture it grows back
  // towards the near edge, which is what makes the corner shortcuts land in the corners.
  const align = s.x <= 0.35 ? 'left' : s.x >= 0.65 ? 'right' : 'centre'
  const anchorX = s.x * w
  let left = align === 'left' ? anchorX : align === 'right' ? anchorX - blockW : anchorX - blockW / 2
  let top = s.y <= 0.5 ? s.y * h : s.y * h - blockH

  // The clamp. Math.max after Math.min so that a block taller or wider than the tile still starts
  // at the top-left margin instead of being pushed off the opposite edge.
  left = Math.max(padPx, Math.min(left, w - padPx - blockW))
  top = Math.max(padPx, Math.min(top, h - padPx - blockH))

  return {
    fontPx,
    lineHeight,
    pad: padPx,
    box: { x: left, y: top, w: blockW, h: blockH },
    lines: fitted.map((text, i) => ({
      text,
      align,
      x: align === 'left' ? left : align === 'right' ? left + blockW : left + blockW / 2,
      y: top + i * lineHeight
    }))
  }
}

// ---- painting ----------------------------------------------------------------------------------

/** The font string both pages use, kept here so a still and a tile never disagree about it. */
export const osdFont = (fontPx) => `600 ${fontPx}px system-ui, "Segoe UI", Roboto, sans-serif`

/**
 * Paints a layout onto a 2D context. Takes the context rather than finding one, so it stays
 * testable with a stand-in object and works the same over a live tile and over playback.
 *
 * White text with a dark outline, not a filled backdrop: CCTV pictures are as often a bright
 * overcast yard as a dark car park, and an outline stays readable over both without hiding a strip
 * of the picture, which is the thing people are actually trying to look at.
 */
export function drawOsd(ctx, layout) {
  if (!ctx || !layout?.lines?.length) return
  ctx.save()
  ctx.font = osdFont(layout.fontPx)
  ctx.textBaseline = 'top'
  ctx.textAlign = layout.lines[0].align === 'centre' ? 'center' : layout.lines[0].align
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
  ctx.lineWidth = Math.max(2, layout.fontPx / 6)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)'
  ctx.fillStyle = '#ffffff'
  for (const line of layout.lines) {
    ctx.strokeText(line.text, line.x, line.y)
    ctx.fillText(line.text, line.x, line.y)
  }
  ctx.restore()
}

/**
 * Turns a pointer position on the canvas into an x/y setting, for dragging the overlay. Kept pure
 * so the drag can be tested: the page only has to supply the pointer's pixel position and the
 * canvas size.
 */
export function osdPositionFrom(pxX, pxY, width, height) {
  const w = Math.max(1, Number(width) || 0)
  const h = Math.max(1, Number(height) || 0)
  return { x: clamp((Number(pxX) || 0) / w, 0, 1), y: clamp((Number(pxY) || 0) / h, 0, 1) }
}

// ---- the server's clock --------------------------------------------------------------------------

/**
 * How far this browser's clock is from the server's, from the Date header of any response the page
 * already makes. The overlay must show the SERVER's time — that is the whole point of drawing it
 * here — and a viewing PC with a wrong clock would otherwise quietly put the wrong time on the
 * picture. The header is only good to the nearest second, which is fine for a wall clock and is
 * why nothing here pretends to millisecond accuracy.
 *
 * Returns null when there is no usable header, and the caller then keeps whatever offset it had
 * (falling back to zero, i.e. this browser's own clock) rather than jumping about.
 */
export function clockOffsetFrom(dateHeader, browserNowMs = Date.now()) {
  if (!dateHeader) return null
  const t = typeof dateHeader === 'number' ? dateHeader : Date.parse(dateHeader)
  if (!Number.isFinite(t)) return null
  const off = t - browserNowMs
  // A difference of years means a broken clock somewhere, not a skew worth following.
  return Math.abs(off) > 365 * 86_400_000 ? null : off
}
