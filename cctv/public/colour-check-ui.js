// Colour check, on the video: the admin holds a ColorChecker chart (or a white or grey card) in
// front of a camera, clicks its four corners on the full-size view, and gets the camera's colour
// accuracy, with optional setting suggestions (colour-check.js does the maths).
//
// A standalone controller the Picture panel opens (see the ColourCheck class). It lays a canvas
// exactly over the video's visible picture (CSS object-fit letterboxing and devicePixelRatio
// accounted for), reads three pictures ~300 ms apart as the camera coded them (playerFrames():
// decoded frames from the player, never the colours the browser shows) and shows the median
// result. Corners put on the chart's black edge are caught before any score or suggestion.
// Nothing here changes a camera: "Use these" only hands the ticked suggestions to the panel's
// list of unsent changes, which the admin applies there.
//
// The pure parts (coordinate mapping, pictures from the player, median of results, corner
// mistakes, wording, the text summary, where the results go) are exported for node tests
// (test/colour-check-ui.test.mjs); the DOM is only touched inside the ColourCheck class and the
// canvas fallback of planesFromVideoFrame, so this module imports fine in node.
import {
  COLORCHECKER_CLASSIC, checkColours, checkWhiteCard, colourSuggestions, deltaE2000, labToRgb, orderCorners, rgbToLab, squareToQuad, whiteCardSuggestions
} from './colour-check.js'

export const GRABS = 3 // pictures read per check
export const GRAB_GAP_MS = 300 // apart: a passing change of light or a moving chart shows as a spread
const GRAB_TIMEOUT_MS = 8000 // one picture through getFrame()
const BATCH_TIMEOUT_MS = 15_000 // all of them through getFrames(): it may wait for a keyframe first
const CHART_SAMPLE = 0.5 // as colour-check.js reads: the middle half of each square
const CARD_INNER = 0.7 // as colour-check.js reads: the middle 70% of the card
const UNSTEADY_DE = 1.5 // pictures further apart than this: the chart or the light moved
const UNSTEADY_CAST = 2
const TV_DECODE = { range: 'full', matrix: 'bt709' } // how TVT cameras really code their video

// ---- where the picture is on screen ---------------------------------------------------------------

/**
 * Where the picture is drawn inside an element with CSS object-fit: its rectangle in CSS pixels
 * (client coordinates). `box`: the element's content box { left, top, width, height }; iw x ih:
 * the element's intrinsic size (a canvas's width/height, a video's videoWidth/videoHeight). The
 * player sizes its canvas to the on-screen size with the video's shape, so the picture is
 * letterboxed (bars above and below) or pillarboxed (bars at the sides) inside the tile.
 * `position`: object-position as fractions ([0.5, 0.5], centred, is the CSS default).
 */
export function pictureRect(box, iw, ih, fit = 'contain', position = [0.5, 0.5]) {
  if (!(iw > 0 && ih > 0 && box.width > 0 && box.height > 0)) return null
  let w = box.width
  let h = box.height
  if (fit !== 'fill') {
    const sx = box.width / iw
    const sy = box.height / ih
    let s = Math.min(sx, sy) // contain
    if (fit === 'cover') s = Math.max(sx, sy)
    else if (fit === 'none') s = 1
    else if (fit === 'scale-down') s = Math.min(1, s)
    w = iw * s
    h = ih * s
  }
  return { left: box.left + (box.width - w) * position[0], top: box.top + (box.height - h) * position[1], width: w, height: h }
}

const KEYWORD = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 }
/** CSS object-position ("50% 50%", "left top", "center") as fractions; other forms: centred. */
export function objectPosition(css = '') {
  const parts = String(css).trim().split(/\s+/).filter(Boolean)
  const frac = (s) => (s in KEYWORD ? KEYWORD[s] : /^-?[\d.]+%$/.test(s) ? parseFloat(s) / 100 : 0.5)
  if (parts.length === 0) return [0.5, 0.5]
  if (parts.length === 1) return parts[0] === 'top' || parts[0] === 'bottom' ? [0.5, KEYWORD[parts[0]]] : [frac(parts[0]), 0.5]
  let [x, y] = parts
  if (x === 'top' || x === 'bottom' || y === 'left' || y === 'right') [x, y] = [y, x]
  return [frac(x), frac(y)]
}

/** A client (CSS pixel) position -> where it is on the picture, as fractions [u, v] (0-1 inside). */
export function clientToPicture(x, y, pic) {
  return [(x - pic.left) / pic.width, (y - pic.top) / pic.height]
}

/** Picture fractions -> client CSS pixels. */
export function pictureToClient([u, v], pic) {
  return [pic.left + u * pic.width, pic.top + v * pic.height]
}

/**
 * Picture fractions -> the frame's own pixel coordinates, as colour-check.js reads them: pixel
 * i's middle is at i, so the picture spans -0.5 .. W - 0.5 and clicking the middle of the first
 * pixel shown gives 0. Only fractions carry over from the screen: the frame (the video at its
 * own size) is usually bigger than the canvas it is drawn in, and the sub and main streams differ.
 */
export function pictureToFrame([u, v], W, H) {
  return [u * W - 0.5, v * H - 0.5]
}

export function frameToPicture([x, y], W, H) {
  return [(x + 0.5) / W, (y + 0.5) / H]
}

/**
 * The overlay canvas for a picture rectangle: its CSS box relative to the host's padding box
 * (what position: absolute is measured from), and a backing store devicePixelRatio times that,
 * so its lines stay sharp on HiDPI screens and phones.
 */
export function overlayBox(pic, hostBox, dpr = 1) {
  return {
    left: pic.left - hostBox.left,
    top: pic.top - hostBox.top,
    width: pic.width,
    height: pic.height,
    backingWidth: Math.max(1, Math.round(pic.width * dpr)),
    backingHeight: Math.max(1, Math.round(pic.height * dpr))
  }
}

/** Picture fractions -> the overlay's backing-store pixels. */
export function pictureToOverlay([u, v], ov) {
  return [u * ov.backingWidth, v * ov.backingHeight]
}

/** A client position straight to frame pixels (what a click on the video means). */
export function clientToFrame(x, y, pic, W, H) {
  return pictureToFrame(clientToPicture(x, y, pic), W, H)
}

// ---- the grid the check reads ------------------------------------------------------------------------

const applyH = (H, u, v) => {
  const w = H.g * u + H.h * v + 1
  return [(H.a * u + H.b * v + H.c) / w, (H.d * u + H.e * v + H.f) / w]
}

/**
 * The clicked corners in the order the chart was found in: [top-left of square 1 (dark skin),
 * top-right, bottom-right, bottom-left] as the chart is printed upright. `orientation` is the
 * result's { turn, mirrored }; this mirrors colour-check.js's own orientations(). Any
 * coordinates (frame pixels, overlay pixels) work: stretching x and y keeps the corners' order.
 */
export function orientedCorners(corners, { turn = 0, mirrored = false } = {}) {
  const quad = orderCorners(corners)
  if (!quad) return null
  const rot = [0, 1, 2, 3].map((i) => quad[(i + turn) % 4])
  return mirrored ? [rot[1], rot[0], rot[3], rot[2]] : rot
}

/** Before the chart is found: the long side taken as the six columns (how a chart looks mostly). */
export function provisionalOrientation(corners) {
  const q = orderCorners(corners)
  if (!q) return null
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
  return { turn: d(q[0], q[1]) + d(q[2], q[3]) >= d(q[1], q[2]) + d(q[3], q[0]) ? 0 : 1, mirrored: false }
}

/**
 * The 24 squares as the check reads them, in the corners' coordinates: each square's cell, the
 * middle part that is read, and its middle point, for drawing over the video.
 */
export function chartCells(oriented) {
  const H = oriented && squareToQuad(oriented)
  if (!H) return []
  const lo = (1 - CHART_SAMPLE) / 2
  const hi = 1 - lo
  const cells = []
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 6; col++) {
      const at = (du, dv) => applyH(H, (col + du) / 6, (row + dv) / 4)
      cells.push({ n: row * 6 + col + 1, row, col, cell: [at(0, 0), at(1, 0), at(1, 1), at(0, 1)], read: [at(lo, lo), at(hi, lo), at(hi, hi), at(lo, hi)], centre: at(0.5, 0.5) })
    }
  }
  return cells
}

/** The part of a card that is read (its middle 70%), in the corners' coordinates. */
export function cardArea(corners) {
  const quad = orderCorners(corners)
  const H = quad && squareToQuad(quad)
  if (!H) return null
  const lo = (1 - CARD_INNER) / 2
  const hi = 1 - lo
  return [applyH(H, lo, lo), applyH(H, hi, lo), applyH(H, hi, hi), applyH(H, lo, hi)]
}

// ---- three pictures, one answer ---------------------------------------------------------------------

const fatalKeys = (r) => r.why ?? (r.problems ?? []).filter((p) => p.fatal).map((p) => p.key).sort().join()

/**
 * One answer from the pictures read: the median result (by mean dE00 for the chart, by cast size
 * for the card) and how far apart the pictures were. Pictures that couldn't be had (getFrame
 * failed: { error }) are left out. When most of the pictures read were refused (a fatal
 * problem: too small, black and white, not a chart...), the most common refusal is the answer.
 * Returns { result (null if no picture), pictures, used, failed, errors, spread, unsteady,
 * orientationsDiffer }.
 */
export function medianResult(results, kind = 'chart') {
  const read = results.filter((r) => r && !r.error)
  const errors = results.filter((r) => !r || r.error).map((r) => r?.error ?? 'no picture')
  const base = { pictures: results.length, used: 0, failed: errors.length, errors, spread: null, unsteady: false, orientationsDiffer: false }
  if (!read.length) return { ...base, result: null }
  const ok = read.filter((r) => r.ok)
  if (ok.length * 2 < read.length) {
    const count = new Map()
    for (const r of read.filter((x) => !x.ok)) count.set(fatalKeys(r), (count.get(fatalKeys(r)) ?? 0) + 1)
    const [top, n] = [...count].sort((a, b) => b[1] - a[1])[0]
    return { ...base, used: n, result: read.find((r) => !r.ok && fatalKeys(r) === top) }
  }
  const key = kind === 'card' ? (r) => r.cast.size : (r) => r.summary.meanDE
  const sorted = [...ok].sort((a, b) => key(a) - key(b))
  const result = sorted[sorted.length >> 1]
  const spread = key(sorted[sorted.length - 1]) - key(sorted[0])
  const orientationsDiffer = kind === 'chart' && ok.some((r) => r.orientation.turn !== result.orientation.turn || r.orientation.mirrored !== result.orientation.mirrored)
  const unsteady = orientationsDiffer || spread > (kind === 'card' ? UNSTEADY_CAST : UNSTEADY_DE)
  return { ...base, used: ok.length, result, spread, unsteady, orientationsDiffer }
}

// ---- plain words ----------------------------------------------------------------------------------------

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '?')

/** The rough dE00 scale: under 3 hard to see side by side, 3-6 small, 6-10 clearly off, over 10 poor. */
export function band(dE) {
  if (!Number.isFinite(dE)) return { key: 'none', label: 'not read' }
  if (dE < 3) return { key: 'good', label: 'hard to see' }
  if (dE < 6) return { key: 'small', label: 'visible but small' }
  if (dE < 10) return { key: 'clear', label: 'clearly off' }
  return { key: 'poor', label: 'poor' }
}

const GRADE_BAND = { excellent: 'good', good: 'small', fair: 'clear', poor: 'poor' }
const GRADES = { excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor' }
const CARD_BAND = { neutral: 'good', 'slight cast': 'small', 'clear cast': 'clear', 'strong cast': 'poor' }
const VERDICTS = { neutral: 'Neutral: no colour cast', 'slight cast': 'Slight colour cast', 'clear cast': 'Clear colour cast', 'strong cast': 'Strong colour cast' }

/** A colour cast { a, b, size, name } in words, on the same scale as the card's verdict. */
export function castWords(cast) {
  if (!cast || !Number.isFinite(cast.size)) return 'not measured'
  if (cast.size < 2) return 'neutral (no colour cast)'
  const strength = cast.size < 5 ? 'slight' : cast.size < 10 ? 'clear' : 'strong'
  return `${strength} ${cast.name} cast (${f1(cast.size)})`
}

/** The chart's summary in plain words: { grade, band, whiteBalance, saturation, hue, contrast, exposure }. */
export function describeChart(s) {
  const pct = (x) => Math.round(Math.abs(x - 1) * 100)
  const stops = s.exposureStops
  const st = Math.abs(stops)
  return {
    grade: GRADES[s.grade] ?? String(s.grade),
    band: GRADE_BAND[s.grade] ?? 'none',
    whiteBalance: castWords(s.cast),
    saturation: !Number.isFinite(s.saturation) ? 'not measured'
      : Math.abs(s.saturation - 1) < 0.1 ? 'about right'
        : s.saturation < 1 ? `${pct(s.saturation)}% weaker than the chart (washed out)` : `${pct(s.saturation)}% stronger than the chart (over-saturated)`,
    hue: !Number.isFinite(s.hueTurn) ? 'not measured'
      : Math.abs(s.hueTurn) < 5 ? 'about right'
        : `turned ${Math.round(Math.abs(s.hueTurn))}° (${s.hueTurn > 0 ? 'reds lean orange, blues lean purple' : 'reds lean pink, blues lean cyan'})`,
    contrast: !Number.isFinite(s.contrast) ? 'not measured'
      : Math.abs(s.contrast - 1) < 0.1 ? 'about right'
        : s.contrast < 1 ? `too little (${s.contrast.toFixed(2)}×): the greys are too close together, so the picture looks flat` : `too much (${s.contrast.toFixed(2)}×): the greys are too far apart, so the picture looks harsh`,
    exposure: !Number.isFinite(stops) ? 'not measured'
      : st < 0.25 ? 'about right'
        : `${st.toFixed(1)} stop${st >= 1.05 ? 's' : ''} ${stops < 0 ? 'darker' : 'brighter'} than ideal (the score allows for this)`
  }
}

/** A white-card result in plain words: { verdict, band, cast, lightness }. */
export function describeCard(r) {
  const L = r.card?.L
  return {
    verdict: VERDICTS[r.verdict] ?? String(r.verdict),
    band: CARD_BAND[r.verdict] ?? 'none',
    cast: castWords(r.cast),
    lightness: !Number.isFinite(L) ? 'not measured'
      : `${Math.round(L)} of 100${L >= 93 ? ' (close to pure white: a little less light, or a grey card, is safer)' : L < 35 ? ' (dark: more light would help)' : ''}`
  }
}

/**
 * Why a clear cast brings no suggestion: colour-check.js leaves automatic white balance alone
 * (it follows the light, so one reading can't say which way to push it). Null when not needed.
 */
export function autoWhiteBalanceNote(cast, fields, suggestions) {
  const mode = fields.find((f) => f.path === 'whiteBalance.mode')?.value
  if (!(cast?.size >= 3) || mode !== 'auto' || suggestions.some((s) => s.path.startsWith('whiteBalance'))) return null
  return 'White balance is already on auto (it follows the light), so nothing is suggested for the cast. Check again in other daylight; if the cast stays, set white balance to manual in the Picture panel and adjust the red and blue gains, then check again.'
}

/** Squares left out of the score (glare or over-exposure), as colour-check.js leaves them out. */
const leftOut = (p) => p.clipped > 0.2 && p.n !== 24

/**
 * How close normal video colours (sRGB, as every camera sends) can come to each square: only
 * cyan lies outside them, so even a perfect camera reads it about 3.5 off.
 */
export const VIDEO_LIMIT = COLORCHECKER_CLASSIC.map((c) => deltaE2000(c.lab, rgbToLab(labToRgb(c.lab))))
/** A square about as close as video colours allow (within 1 of that limit): not the camera's fault. */
export const atVideoLimit = (p) => VIDEO_LIMIT[p.n - 1] > 1 && p.dE <= VIDEO_LIMIT[p.n - 1] + 1
const limitText = (p) => `video colours can’t show ${p.name} exactly: about ${Math.round(VIDEO_LIMIT[p.n - 1])} is the best any camera can do`
/** The band a square is shown in: one at the video limit counts as right. */
const squareBand = (p) => (leftOut(p) ? 'none' : atVideoLimit(p) ? 'good' : band(p.dE).key)

/** The (up to) three squares furthest off, leaving out one only as far off as video colours allow. */
export function furthestOff(r) {
  return (r?.patches ?? []).filter((p) => !leftOut(p) && !atVideoLimit(p)).sort((a, b) => b.dE - a.dE).slice(0, 3)
}
const furthestText = (r) => furthestOff(r).map((p) => `${p.name} (${f1(p.dE)})`).join(', ') // "neutral 3.5" ends in a number: brackets

// ---- corners in the wrong place ---------------------------------------------------------------------

// no camera setting puts a colour square this far off (crushed shadows with the contrast far too
// high reach about 35 on blue sky): it was read from something else
const WILD_DE = 40
const GREY_ORDER_L = 5 // a grey reading this much lighter than a lighter grey: the greys are out of order
const EDGE_TRIES = Array.from({ length: 23 }, (_, i) => 0.1 + i * 0.05) // widths of black edge tried, in squares (0.1-1.2)

/**
 * Squares read from something other than their square: a colour square further off than any
 * camera setting puts one, or a grey out of order (every camera keeps lighter greys lighter,
 * though harsh contrast can crush the dark ones together, so greys are judged by order, not by
 * difference). Returns the patches.
 */
export function wildSquares(result) {
  const scored = (result?.patches ?? []).filter((p) => !leftOut(p))
  const greys = scored.filter((p) => p.n >= 19)
  const outOfOrder = greys.filter((p) => greys.some((q) => q.n > p.n && q.measured[0] > p.measured[0] + GREY_ORDER_L))
  const colours = scored.filter((p) => p.n <= 18 && p.dE > WILD_DE)
  return [...colours, ...outOfOrder].sort((a, b) => b.dE - a.dE)
}

/** The quad `b` squares in from every side of a chart's corners (in its found orientation). */
export function insetChart(oriented, b) {
  const H = oriented && squareToQuad(oriented)
  if (!H) return null
  const du = b / (6 + 2 * b)
  const dv = b / (4 + 2 * b)
  return [applyH(H, du, dv), applyH(H, 1 - du, dv), applyH(H, 1 - du, 1 - dv), applyH(H, du, 1 - dv)]
}

/**
 * Corners put on the chart's outer black edge (the mistake the steps warn about) instead of the
 * colour squares' corners: the grid is then too big, and the outer squares are read partly from
 * the black. The corners are tried moved in by edge widths from 0.1 to 1.2 squares; when some
 * fit the chart far better, that was the mistake. A range of widths fits about equally well (each
 * square is read from its middle), and the middle of that range is taken as the edge. Only
 * looked for when the result is poor or refused as "not a chart" (a good result can't get much
 * better). `corners`: the clicks in the frame's own pixels; `result`: checkColours() of them.
 * Returns { border, corners, meanDE, before } or null.
 */
export function edgeCorners(frame, corners, result, decode = TV_DECODE) {
  if (!result?.orientation || !result.summary || !Array.isArray(result.patches)) return null
  const keys = (result.problems ?? []).map((p) => p.key)
  if (keys.includes('too-small')) return null // moved in, it only gets smaller
  const poor = result.ok ? result.summary.meanDE > 2 || wildSquares(result).length > 0 : keys.includes('not-found')
  if (!poor) return null
  const before = result.summary.meanDE
  // which side has the six columns: as found, unless the chart wasn't found (then as it looks)
  const turns = new Set([result.ok ? result.orientation.turn % 2 : null, provisionalOrientation(corners)?.turn].filter(Number.isInteger))
  let best = null
  for (const turn of turns) {
    const oriented = orientedCorners(corners, { turn, mirrored: false })
    const fits = []
    for (const b of EDGE_TRIES) {
      const inner = insetChart(oriented, b)
      const r = inner && checkColours(frame, inner, decode)
      if (r?.ok) fits.push({ border: b, corners: inner, meanDE: r.summary.meanDE })
    }
    if (!fits.length) continue
    const low = Math.min(...fits.map((f) => f.meanDE))
    const flat = fits.filter((f) => f.meanDE <= low + Math.max(0.2, 0.05 * low))
    // the squares are misread as far one way as the other at the two ends of the widths that
    // fit, and that misreading grows evenly with the share of the clicked width taken off
    // (b / (6 + 2b) across, b / (4 + 2b) down), not with b: the middle of those shares is the edge
    const [lo, hi] = [flat[0].border, flat[flat.length - 1].border]
    const across = (b) => b / (6 + 2 * b)
    const down = (b) => b / (4 + 2 * b)
    const ga = (across(lo) + across(hi)) / 2
    const gd = (down(lo) + down(hi)) / 2
    const b = ((6 * ga) / (1 - 2 * ga) + (4 * gd) / (1 - 2 * gd)) / 2
    const inner = insetChart(oriented, b)
    const r = inner && checkColours(frame, inner, decode)
    const mid = r?.ok && r.summary.meanDE <= low + Math.max(0.2, 0.05 * low) ? { border: b, corners: inner, meanDE: r.summary.meanDE } : flat[flat.length >> 1]
    if (!best || mid.meanDE < best.meanDE) best = mid
  }
  return best && best.meanDE <= before * 0.6 && before - best.meanDE >= 2 ? { ...best, before } : null
}

/**
 * Whether the chart's result can be trusted as clicked: { kind: 'edge' | 'wild', text, detail? }
 * or null. 'edge': edgeCorners() found the corners on the black edge. 'wild': squares far further
 * off than any camera setting makes them (a corner off the squares, or a reflection). Either way
 * the result gets no grade and no suggestions: they would be about the corners, not the camera.
 */
export function cornerTrouble(result, edge = null) {
  if (!result?.patches) return null
  if (edge) {
    return {
      kind: 'edge',
      text: 'Some squares were read from the black edge around them: the corners go on the outer corners of the colour squares, not of the card.',
      detail: `With the corners moved in onto the squares, the chart reads ${f1(edge.meanDE)} instead of ${f1(edge.before)} (average difference).`
    }
  }
  if (!result.ok) return null
  const wild = wildSquares(result)
  if (!wild.length) return null
  return {
    kind: 'wild',
    text: `Some squares don’t read as the chart has them: ${wild.slice(0, 3).map((p) => `${p.name} (${f1(p.dE)})`).join(', ')}. No camera setting does that: a corner is probably off the colour squares (on the black edge or the background), or a square is catching a reflection. Check the corners and the squares drawn in red, then check again.`
  }
}

/**
 * Things worth knowing about a check that aren't faults the camera's colour settings fix:
 * a mirrored picture (the camera's Mirror or Flip), and pictures read from the screen without
 * the display range fix. `frames`: the pictures read (planes or { error }).
 */
export function checkNotes({ kind, result, frames = [], fields = [] }) {
  const notes = []
  if (kind === 'chart' && result?.ok && result.orientation?.mirrored) {
    const onOff = (path) => {
      const f = fields.find((x) => x.path === path)
      return f ? `${f.label ?? path} ${f.value === true || f.value === 'true' ? 'on' : 'off'}` : null
    }
    const now = [onOff('mirrorSwitch'), onOff('flipSwitch')].filter(Boolean)
    notes.push(`The picture is mirrored (the chart reads back to front), so the camera’s Mirror or Flip setting is on: one of them, not both (both together only turn the picture upside down).${now.length ? ` The Picture panel shows ${now.join(', ')}.` : ''} Nothing is suggested: the way the camera is mounted may need it.`)
  }
  if (fromScreen(frames)) {
    const out = (result?.patches ?? []).filter(leftOut).map((p) => p.name)
    notes.push(`The camera’s own picture values weren’t available, so the picture was read as this browser shows it, which cuts off the brightest and darkest parts. Squares shown pure white or black are left out of the score${out.length ? ` (here: ${out.join(', ')})` : ''}: that can be the browser rather than glare.`)
  }
  return notes
}

/** Pictures read from the screen without the display range fix (its ends cut off). */
export const fromScreen = (frames = []) => frames.some((f) => f?.source === 'screen' && f.shown?.range === 'limited')
/** The engine's notes to show: its glare note is replaced by checkNotes()'s when read from such a screen. */
const shownProblems = (problems, screen) => problems.filter((p) => !(screen && p.key === 'clipped'))

function picturesLine(m, kind) {
  let s = `${m.used} of ${m.pictures} picture${m.pictures === 1 ? '' : 's'}`
  if (m.result?.ok && m.used > 1) s += `, median; they agreed within ${f1(m.spread)}${kind === 'card' ? ' (cast)' : ' ΔE00'}`
  if (m.failed) s += `; ${m.failed} could not be had (${[...new Set(m.errors)].join('; ')})`
  if (m.unsteady) s += `. They differed${m.orientationsDiffer ? ' (the chart was read differently)' : ''}: the chart or the light moved, or the camera was still adjusting. Hold it still and check again.`
  return s
}

/** Each square's dE00 as text lines, four rows of six. */
function squareLines(r) {
  const out = []
  for (let row = 0; row < 4; row++) {
    out.push('  ' + r.patches.slice(row * 6, row * 6 + 6).map((p) => `${p.n} ${p.name}: ${leftOut(p) ? 'left out' : f1(p.dE)}`).join(' · '))
  }
  return out
}

/**
 * The result as plain text, for copying into a message to someone. `check`: { kind: 'chart' |
 * 'card', median (medianResult()), camera?, at? (Date or text), suggestions?, trouble?
 * (cornerTrouble()), notes? (checkNotes()), screen? (fromScreen() of the pictures) }.
 */
export function summaryText({ kind, median, camera = '', at = null, suggestions = [], trouble = null, notes = [], screen = false }) {
  const r = median.result
  const out = [`Colour check with a ${kind === 'card' ? 'white or grey card' : 'ColorChecker Classic chart'}`]
  if (camera) out.push(`Camera: ${camera}`)
  if (at) out.push(`When: ${at instanceof Date ? at.toLocaleString() : String(at)}`)
  if (!r) {
    out.push(`Result: no picture could be read (${[...new Set(median.errors)].join('; ') || 'no picture'})`)
    return out.join('\n')
  }
  out.push(`Pictures: ${picturesLine(median, kind)}`)
  if (trouble) {
    out.push('Result: not scored: the corners need checking')
    out.push(`- ${trouble.text}`)
    if (trouble.detail) out.push(`- ${trouble.detail}`)
    if (trouble.kind === 'wild') {
      out.push('Each square as read, ΔE00:')
      out.push(...squareLines(r))
    }
    return out.join('\n')
  }
  const problems = r.why ? [{ text: r.why, fatal: true }] : (r.problems ?? [])
  if (!r.ok) {
    out.push('Result: not checked')
    for (const p of problems.filter((x) => x.fatal)) out.push(`- ${p.text}`)
    return out.join('\n')
  }
  if (kind === 'card') {
    const d = describeCard(r)
    out.push(`Result: ${d.verdict}`)
    out.push(`Cast: ${d.cast}`)
    out.push(`Lightness: ${d.lightness}`)
  } else {
    const s = r.summary
    const d = describeChart(s)
    out.push(`Result: ${d.grade}, average colour difference ${f1(s.meanDE)} ΔE00 (exposure evened out; ${f1(s.meanDERaw)} as the camera shows it)`)
    out.push(`Furthest off: ${furthestText(r) || 'none'}`)
    out.push(`White balance: ${d.whiteBalance}`)
    out.push(`Colour strength: ${d.saturation}`)
    out.push(`Hue: ${d.hue}`)
    out.push(`Contrast: ${d.contrast}`)
    out.push(`Exposure: ${d.exposure}`)
  }
  for (const p of shownProblems(problems, screen)) out.push(`Note: ${p.text}`)
  for (const n of notes) out.push(`Note: ${n}`)
  if (suggestions.length) {
    out.push('Suggested changes (optional):')
    for (const x of suggestions) out.push(`- ${x.label ?? x.path}: ${x.from} → ${x.to} (${x.why})`)
  }
  if (kind !== 'card') {
    out.push('Each square, ΔE00 (under 3 hard to see, 3-6 small, 6-10 clearly off, over 10 poor):')
    out.push(...squareLines(r))
    for (const p of r.patches.filter(atVideoLimit)) out.push(`(${p.n} ${p.name}: ${limitText(p)}.)`)
    out.push('Reference: X-Rite ColorChecker Classic (after November 2014), CIEDE2000.')
  }
  return out.join('\n')
}

// ---- where the results go --------------------------------------------------------------------------

/**
 * Where the results panel goes in the host (CSS px, relative to it): in a bar beside or below
 * the picture when one is big enough, so the grid drawn over the video stays in view (a phone
 * held upright has bars above and below; a short one also takes the picture's edge as far as
 * the chart); otherwise over the side of the picture away from the chart, as narrow as keeps
 * it off the chart, and it can be hidden. `chart`: where the chart is on the picture, as
 * fractions { left, top, right, bottom }, or only its middle [u, v] (then the whole picture is
 * kept clear). `pic`: the picture's box in the host. Returns { side, covers (the chart),
 * left, width, maxHeight } and top, or bottom for a panel held to the bottom edge (it grows
 * upwards with its content).
 */
export function chooseDock(hostW, hostH, pic, chart = [0.5, 0.5], { sideMin = 300, bandMin = 150, sheetMin = 190, maxWidth = 400, minWidth = 280, bandWidth = 760, narrow = 600, gap = 8 } = {}) {
  const isBox = Boolean(chart) && !Array.isArray(chart)
  const mid = isBox ? [(chart.left + chart.right) / 2, (chart.top + chart.bottom) / 2] : (chart ?? [0.5, 0.5])
  const cb = isBox
    ? { left: pic.left + chart.left * pic.width, right: pic.left + chart.right * pic.width, top: pic.top + chart.top * pic.height, bottom: pic.top + chart.bottom * pic.height }
    : { left: pic.left, right: pic.left + pic.width, top: pic.top, bottom: pic.top + pic.height }
  const space = { left: pic.left, right: hostW - pic.left - pic.width, top: pic.top, bottom: hostH - pic.top - pic.height }
  const free = { left: cb.left, right: hostW - cb.right, top: cb.top, bottom: hostH - cb.bottom } // up to the chart
  const side = space.right >= space.left ? 'right' : 'left'
  if (space[side] >= sideMin) {
    const w = Math.min(maxWidth, space[side] - 2 * gap)
    return { side, covers: false, left: side === 'right' ? hostW - gap - w : gap, top: gap, width: w, maxHeight: hostH - 2 * gap }
  }
  const bar = space.bottom >= space.top ? 'bottom' : 'top'
  if (space[bar] >= bandMin) {
    const w = Math.min(bandWidth, hostW - 2 * gap)
    const left = (hostW - w) / 2
    if (free[bar] > space[bar] + gap) {
      return { side: bar, covers: false, left, ...(bar === 'bottom' ? { bottom: gap } : { top: gap }), width: w, maxHeight: free[bar] - 2 * gap }
    }
    return { side: bar, covers: false, left, top: bar === 'bottom' ? hostH - space.bottom + gap : gap, width: w, maxHeight: space[bar] - 2 * gap }
  }
  if (hostW < narrow) {
    const where = mid[1] < 0.5 ? 'bottom' : 'top'
    const room = free[where] - 2 * gap
    const h = Math.round(Math.min(hostH - 2 * gap, Math.max(sheetMin, isBox ? room : hostH * 0.55)))
    return { side: where, covers: !isBox || h > room, left: gap, ...(where === 'bottom' ? { bottom: gap } : { top: gap }), width: hostW - 2 * gap, maxHeight: h }
  }
  const where = isBox ? (free.left > free.right ? 'left' : 'right') : mid[0] > 0.5 ? 'left' : 'right'
  const room = free[where] - 2 * gap
  const w = isBox ? Math.min(maxWidth, hostW - 2 * gap, Math.max(minWidth, room)) : Math.min(maxWidth, hostW - 2 * gap)
  return { side: where, covers: !isBox || w > room, left: where === 'right' ? hostW - gap - w : gap, top: gap, width: w, maxHeight: hostH - 2 * gap }
}

/**
 * Where the corner bar goes (CSS px in the host), for a bar `h` tall at full width: in the band
 * above or below the picture when it fits there (`at`, unless it only fits in the other one and
 * the admin hasn't moved it); else in the wider side band as a column when that is at least
 * `columnMin` wide (a phone on its side); else over the picture ('over': the caller shortens it
 * and puts it at the top or bottom edge). `ov`: the picture's box in the host.
 */
export function chooseBar(hostW, hostH, ov, h, { at = 'top', moved = false, columnMin = 170, gap = 6 } = {}) {
  const above = ov.top
  const below = hostH - ov.top - ov.height
  const fitsAbove = above >= h + 2 * gap
  const fitsBelow = below >= h + 2 * gap
  let where = at
  if (!moved && where === 'top' && !fitsAbove && fitsBelow) where = 'bottom'
  if (!moved && where === 'bottom' && !fitsBelow && fitsAbove) where = 'top'
  if (where === 'top' && fitsAbove) return { mode: 'band', where, top: above - h - gap }
  if (where === 'bottom' && fitsBelow) return { mode: 'band', where, top: ov.top + ov.height + gap }
  const left = ov.left
  const right = hostW - ov.left - ov.width
  const side = right >= left ? 'right' : 'left'
  const room = Math.max(left, right)
  if (room >= columnMin) return { mode: 'column', where: side, left: side === 'right' ? hostW - room + gap : gap, width: room - 2 * gap }
  return { mode: 'over', where }
}

/**
 * What a press on the picture does while placing corners: the index of the corner it picks up
 * to move, -1 to add a new corner, or null for nothing. While fewer than four are placed a press
 * always adds one: on a small chart the corners are closer together than a fingertip, so "near
 * a corner" can't mean "move it" (Undo point takes one back). With all four placed it picks up
 * the nearest within reach (22 CSS px for a finger, 10 for a mouse or pen). `points` and `p`:
 * picture fractions; `size`: the picture's [width, height] in CSS px.
 */
export function pressTarget(points, p, size, type = 'mouse') {
  if (points.length < 4) return -1
  const reach = type === 'touch' ? 22 : 10
  let best = null
  let bestD = Infinity
  points.forEach((q, i) => {
    const d = Math.hypot((q[0] - p[0]) * size[0], (q[1] - p[1]) * size[1])
    if (d <= reach && d < bestD) {
      best = i
      bestD = d
    }
  })
  return best
}

// ---- pictures for the check -------------------------------------------------------------------------
//
// The check must read the values the camera coded, not the colours the browser shows: without the
// player's display range fix the browser takes TVT's full-range video for limited range, cuts off
// its ends and stretches the rest, and a perfect camera would then read as too contrasty.

const FULL_709 = { range: 'full', matrix: 'bt709' }
/** A WebCodecs matrix name ('smpte170m', 'bt709', ...) as the check's 'bt601' | 'bt709'. */
const matrixOf = (m) => (m === 'smpte170m' || m === 'bt470bg' || m === 'bt601' ? 'bt601' : 'bt709')

/**
 * A decoded VideoFrame's planes, copied out so the caller can close the frame at once (a decoder
 * has only a few frames to hand out). I420, NV12 and 10-bit I420 frames give the values the camera
 * coded. Other formats (a GPU frame the browser won't copy out) are drawn and read back, and
 * `shown` (how the browser converts the frame for display: { range, matrix }, e.g. the player's
 * displayColour(); by default the frame's own colour space) undoes that conversion as far as it
 * can (see planesFromImageData). `decode`: how the stream is really coded (TVT: full, BT.709).
 */
export async function planesFromVideoFrame(frame, { decode = TV_DECODE, shown = null } = {}) {
  const fmt = frame.format
  const W = frame.visibleRect?.width ?? frame.codedWidth
  const H = frame.visibleRect?.height ?? frame.codedHeight
  if (fmt === 'I420' || fmt === 'I420A' || fmt === 'NV12' || fmt === 'I420P10' || fmt === 'I420AP10') {
    const buf = new Uint8Array(frame.allocationSize())
    const layout = await frame.copyTo(buf)
    if (fmt.endsWith('P10')) return { ...tenBitTo8(buf, layout, W, H), decode, source: 'coded' }
    const at = (i) => buf.subarray(layout[i].offset)
    if (fmt === 'NV12') return { width: W, height: H, y: at(0), yStride: layout[0].stride, uv: at(1), uvStride: layout[1].stride, decode, source: 'coded' }
    return { width: W, height: H, y: at(0), yStride: layout[0].stride, u: at(1), uStride: layout[1].stride, v: at(2), vStride: layout[2].stride, decode, source: 'coded' }
  }
  const cs = frame.colorSpace
  const how = shown ?? { range: cs?.fullRange ? 'full' : 'limited', matrix: matrixOf(cs?.matrix) }
  const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(frame.displayWidth, frame.displayHeight) : Object.assign(document.createElement('canvas'), { width: frame.displayWidth, height: frame.displayHeight })
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(frame, 0, 0, c.width, c.height)
  return planesFromImageData(g.getImageData(0, 0, c.width, c.height), { shown: how, decode })
}

/** 10-bit planes (16-bit little-endian samples) as the 8-bit planes the check reads. */
function tenBitTo8(buf, layout, W, H) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const plane = (i, w, h) => {
    const out = new Uint8Array(w * h)
    const { offset, stride } = layout[i]
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = Math.min(255, (view.getUint16(offset + y * stride + 2 * x, true) + 2) >> 2)
    return out
  }
  const cw = Math.ceil(W / 2)
  const ch = Math.ceil(H / 2)
  return { width: W, height: H, y: plane(0, W, H), yStride: W, u: plane(1, cw, ch), uStride: cw, v: plane(2, cw, ch), vStride: cw }
}

/**
 * Planes from RGBA pixels as the browser shows them (player.grab()'s ImageData, or a frame drawn
 * on a canvas). `shown`: how the browser converted the video to those pixels. Its conversion is
 * undone, which gives back the values the camera coded, and the planes are marked with the
 * stream's real coding (`decode`). With the display range fix (shown full range) that is exact.
 * Without it (shown limited range) the ends the browser cut off can't be had back: pixels shown
 * pure white or pure black are marked as clipped, so the check leaves those squares out rather
 * than misread them. The planes carry source 'screen' and `shown`, for the results to say so.
 */
export function planesFromImageData({ data, width: W, height: H }, { shown = FULL_709, decode = TV_DECODE } = {}) {
  const limited = shown.range === 'limited'
  const [kr, kb] = shown.matrix === 'bt601' ? [0.299, 0.114] : [0.2126, 0.0722]
  const kg = 1 - kr - kb
  // back to the browser's input: limited range puts Y' at 16-235 and colour at 16-240
  const yScale = limited ? 219 / 255 : 1
  const yOff = limited ? 16 : 0
  const cScale = limited ? 224 / 255 : 1
  const cw = Math.ceil(W / 2)
  const ch = Math.ceil(H / 2)
  const y = new Uint8Array(W * H)
  const u = new Uint8Array(cw * ch)
  const v = new Uint8Array(cw * ch)
  const luma = (i) => kr * data[i] + kg * data[i + 1] + kb * data[i + 2]
  for (let j = 0, i = 0; j < W * H; j++, i += 4) {
    const cutOff = limited && ((data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) || (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0))
    y[j] = cutOff ? (data[i] ? 255 : 0) : Math.round(yOff + yScale * luma(i))
  }
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let r = 0
      let b = 0
      let yy = 0
      let n = 0
      for (let dy = 0; dy < 2 && 2 * cy + dy < H; dy++) {
        for (let dx = 0; dx < 2 && 2 * cx + dx < W; dx++) {
          const i = ((2 * cy + dy) * W + 2 * cx + dx) * 4
          r += data[i]
          b += data[i + 2]
          yy += luma(i)
          n++
        }
      }
      u[cy * cw + cx] = Math.max(0, Math.min(255, Math.round(128 + (cScale * (b - yy)) / n / (2 * (1 - kb)))))
      v[cy * cw + cx] = Math.max(0, Math.min(255, Math.round(128 + (cScale * (r - yy)) / n / (2 * (1 - kr)))))
    }
  }
  return { width: W, height: H, y, yStride: W, u, uStride: cw, v, vStride: cw, decode, source: 'screen', shown: { range: limited ? 'limited' : 'full', matrix: kr === 0.299 ? 'bt601' : 'bt709' } }
}

const GRAB_WORDS = {
  'no picture': 'no picture came from the camera in time',
  closed: 'the video stopped',
  'a measurement is already running': 'the Picture panel is already measuring the picture (Auto adjust): wait for it to finish'
}
const END_WORDS = {
  timeout: 'no more pictures came in time',
  'keyframe interval shorter than the offsets': 'the camera starts a new keyframe too often'
}
const grabError = (e) => (e?.name === 'AbortError' ? e : new Error(GRAB_WORDS[e?.message] ?? e?.message ?? String(e)))

/**
 * getFrames() for ColourCheck from the app's VideoPlayer (`getPlayer()`: the one on screen now,
 * or null): n pictures about `gapMs` apart, as the camera coded them. It uses the player's
 * grabAfterKey, which hands over clones of decoded frames (one wait for a keyframe, then the
 * frames `gapMs` apart; with rare keyframes it takes them from wherever the stream is after
 * `keyWaitMs`). A player without grabAfterKey falls back to grab() (the picture as shown),
 * with its displayColour() to undo the browser's conversion. Rejects in plain words; resolves
 * [planes | { error }] of length n.
 */
export function playerFrames(getPlayer, { decode = TV_DECODE, gapMs = GRAB_GAP_MS, timeoutMs = 10_000, keyWaitMs = 1500 } = {}) {
  return async (n, { signal = null, onFrame = null } = {}) => {
    const player = getPlayer()
    if (!player || player.closed) throw new Error('the video isn’t playing')
    if (typeof player.grabAfterKey !== 'function') return screenFrames(player, n, { decode, gapMs, signal, onFrame })
    const fps = player.stats?.fps > 0 ? player.stats.fps : 20
    const step = Math.max(1, Math.round((fps * gapMs) / 1000))
    const copies = []
    let end = null
    try {
      end = await player.grabAfterKey({
        offsets: Array.from({ length: n }, (_, i) => i * step),
        sets: 1,
        keyWaitMs,
        timeoutMs,
        signal: signal ?? undefined,
        sink: (frame, meta = {}) => {
          if (copies.length >= n) return frame.close()
          const shown = { range: meta.displayRange === 'full' ? 'full' : 'limited', matrix: matrixOf(meta.displayMatrix) }
          copies.push(planesFromVideoFrame(frame, { decode, shown }).finally(() => frame.close()))
          onFrame?.(copies.length, n)
        }
      })
    } catch (e) {
      if (e?.name === 'AbortError' || !copies.length) throw grabError(e)
    }
    const got = await Promise.allSettled(copies)
    const out = got.map((g) => (g.status === 'fulfilled' ? g.value : { error: `the picture could not be copied (${g.reason?.message ?? g.reason})` }))
    while (out.length < n) out.push({ error: END_WORDS[end?.reason] ?? 'fewer pictures came than asked for' })
    return out
  }
}

/** The fallback: n pictures as the player shows them, `gapMs` apart. */
async function screenFrames(player, n, { decode, gapMs, signal, onFrame }) {
  if (typeof player.grab !== 'function') throw new Error('this player can’t hand over pictures')
  const shown = player.displayColour?.() ?? { range: player.rangeFixed ? 'full' : 'limited', matrix: 'bt709' }
  const out = []
  for (let i = 0; i < n; i++) {
    if (i) await sleep(gapMs)
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
    try {
      out.push(planesFromImageData(await player.grab(GRAB_TIMEOUT_MS), { shown: { range: shown.range, matrix: matrixOf(shown.matrix) }, decode }))
    } catch (e) {
      out.push({ error: grabError(e).message })
    }
    onFrame?.(i + 1, n)
  }
  return out
}

const isFrame = (f) => f && f.width > 0 && f.height > 0 && f.y && ((f.u && f.v) || f.uv)

// ---- the controller ---------------------------------------------------------------------------------------

let styled = false
/** The check's stylesheet, added once next to this module (so the page needs no change). */
function ensureStyles() {
  if (styled || typeof document === 'undefined') return
  styled = true
  const href = new URL('./colour-check.css', import.meta.url).href
  // already linked by the page (under any spelling of its address)?
  if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href)) return
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('no picture in time') })])
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false))
  return e
}
const button = (text, cls, onClick, extra = {}) => el('button', { type: 'button', className: cls, textContent: text, onclick: onClick, ...extra })
const rgbCss = (rgb) => `rgb(${rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255)).join(' ')})`
const labText = (lab) => `L* ${lab[0].toFixed(1)}, a* ${lab[1].toFixed(1)}, b* ${lab[2].toFixed(1)}`
const BAND_COLOUR = { good: '#3fb950', small: '#c9d44a', clear: '#f0a33a', poor: '#ff6b6b', none: '#8a93a0' }
const STEPS = {
  chart: [
    'Daylight: outdoors in open shade, or by a big window. Not in direct sun or under coloured lamps; at dusk or night the camera may switch to black and white.',
    'Hold the chart flat and still, facing the camera straight on (a stand or a helper makes this easy). If a square shines, tilt the chart a little.',
    'Close enough: the chart should fill at least a tenth of the picture’s width (each square at least 8 pixels on the camera’s own picture). With a wide lens that is usually within 2-4 m; further away, use the large ColorChecker (XL). Not so close that it goes out of focus.',
    'Then click the four outer corners of the colour squares (not the edge of the card), in any order.'
  ],
  card: [
    'Daylight: outdoors in open shade, or by a big window. Not in direct sun or under coloured lamps.',
    'Hold a plain white sheet or a grey card flat and still, facing the camera, big in the picture. Keep your fingers at its edges.',
    'It must not look pure white on screen: hold it in shade. A grey card gives a surer answer than office paper (paper can look slightly blue).',
    'Then click the card’s four corners, in any order.'
  ]
}
let ids = 0

/**
 * The colour check, laid over a camera's full-size view.
 *
 *   const cc = new ColourCheck({ host, video, getFrames, decode, fields, camera, onSuggest, onClose })
 *   cc.open()            // shows the first step (false if there is no host); cc.close() takes it all away
 *
 * host: the element to lay the overlay and dialog in (the full-size tile; positioned), or a
 * function giving the current one: the view rebuilds its tile now and then (camera list refresh,
 * tab shown again), and the check then moves into the new one, corners and all. video: the
 * element the video is drawn in (a canvas with object-fit), or a function giving the current one
 * (the view swaps the sub stream's canvas for the main stream's). getFrames(n, { signal,
 * onFrame }): async, n pictures about GRAB_GAP_MS apart as coded planes at the video's own size,
 * each planes or { error } (playerFrames() makes one from the app's player); or getFrame(): one
 * picture, called n times. decode: how the planes are coded (a frame's own `decode` wins).
 * fields: the camera's picture settings (array or function), for suggestions. onSuggest(list):
 * "Use these", with the ticked [{ path, label, from, to, why }]. onClose(): after it closed.
 *
 * Clicks on it never reach the tile (which closes the full-size view on a click), and Escape
 * closes only the check. The last corners are kept for the next open() on the same instance, so
 * checking again after a change needs no new clicks.
 */
export class ColourCheck {
  constructor({ host, video, getFrame = null, getFrames = null, decode = TV_DECODE, fields = [], camera = '', onSuggest = null, onClose = null }) {
    if (!host || (typeof getFrame !== 'function' && typeof getFrames !== 'function')) throw new Error('ColourCheck needs a host and getFrames() or getFrame()')
    this.hostOpt = host
    this.host = null
    this.video = video
    this.getFrame = getFrame
    this.getFrames = getFrames
    this.decode = decode
    this.fields = fields
    this.camera = camera
    this.onSuggest = onSuggest
    this.onClose = onClose
    this.id = ++ids
    this.step = 'closed' // intro | corners | measuring | results | error
    this.mode = 'chart'
    this.points = [] // picture fractions [u, v], in click order
    this.selected = -1 // a point picked (keyboard 1-4) to move with the arrow keys
    this.cursor = [0.5, 0.5] // the keyboard's cross
    this.aim = null // a pointer held down: { id, type, drag, pos }
    this.hover = null // the mouse over the picture (for the magnifier)
    this.autoChecked = false // the first check starts by itself on the 4th corner
    this.check = null // the last result: { kind, median, at, suggestions, points }
    this.last = null // { mode, points } of the last check, offered on the next open()
    this.seq = 0 // bumped on close and each check: a late picture for an older check is ignored
    this.collapsed = false
    this.barAt = 'top'
    this.barMode = null
    this.ov = null
    this.layoutKey = ''
    this.abort = null // the running check's AbortController (stops the player's grab on close)
    this.lastFocus = null // inside the check: given back after a move to a rebuilt tile
    this.onWindowKey = (e) => {
      if (e.key !== 'Escape' || !this.isOpen) return
      // Escape closes the check only, not the full-size view under it
      e.preventDefault()
      e.stopPropagation()
      this.close()
    }
    this.onResize = () => this.layout()
  }

  get isOpen() {
    return this.step !== 'closed'
  }

  videoEl() {
    try {
      return (typeof this.video === 'function' ? this.video() : this.video) ?? null
    } catch {
      return null
    }
  }

  hostEl() {
    try {
      return (typeof this.hostOpt === 'function' ? this.hostOpt() : this.hostOpt) ?? null
    } catch {
      return null
    }
  }

  /** The host must be positioned for the overlay to sit on the picture: made so while open. */
  claimHost() {
    if (getComputedStyle(this.host).position === 'static') {
      this.hostPosition = this.host.style.position
      this.host.style.position = 'relative'
    }
  }

  releaseHost() {
    if (this.host && this.hostPosition !== undefined) this.host.style.position = this.hostPosition
    this.hostPosition = undefined
  }

  /** Into a rebuilt tile: the same step and corners (picture fractions carry over). */
  moveTo(host) {
    const hadFocus = this.lastFocus
    this.releaseHost()
    this.host = host
    this.claimHost()
    host.append(this.shield, this.overlay, this.loupe, this.root)
    this.resizeObserver?.disconnect()
    this.resizeObserver?.observe(host)
    this.layoutKey = ''
    // the old tile took the focus with it when it left the page
    const lost = !document.activeElement || document.activeElement === document.body
    if (lost && hadFocus?.isConnected) hadFocus.focus({ preventScroll: true })
  }

  fieldList() {
    try {
      return (typeof this.fields === 'function' ? this.fields() : this.fields) ?? []
    } catch {
      return []
    }
  }

  /** Opens at the first step (mode: 'chart' | 'card' to preselect one). False if it can't (no host yet). */
  open({ mode } = {}) {
    if (typeof document === 'undefined') return false
    if (this.isOpen) {
      this.root.focus?.()
      return true
    }
    const host = this.hostEl()
    if (!host?.isConnected) return false
    ensureStyles()
    if (mode === 'chart' || mode === 'card') this.mode = mode
    this.opener = document.activeElement
    this.coarse = matchMedia?.('(pointer: coarse)').matches ?? false
    this.host = host
    this.claimHost()
    this.barMode = null
    this.build()
    window.addEventListener('keydown', this.onWindowKey, true)
    window.addEventListener('resize', this.onResize)
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(this.onResize) : null
    this.resizeObserver?.observe(this.host)
    // the video's canvas is resized and swapped (sub -> main stream) without telling anyone
    this.layoutTimer = setInterval(() => this.layout(), 400)
    this.layoutKey = ''
    this.setStep('intro')
    return true
  }

  close() {
    if (!this.isOpen) return
    this.seq++
    this.abort?.abort()
    this.abort = null
    this.step = 'closed'
    clearInterval(this.layoutTimer)
    this.resizeObserver?.disconnect()
    window.removeEventListener('keydown', this.onWindowKey, true)
    window.removeEventListener('resize', this.onResize)
    for (const e of [this.shield, this.overlay, this.loupe, this.root]) e?.remove()
    this.releaseHost()
    this.lastFocus = null
    this.aim = null
    this.hover = null
    try {
      this.onClose?.()
    } catch (e) {
      console.warn('colour check onClose', e)
    }
    if (this.opener?.isConnected) this.opener.focus?.()
    this.opener = null
  }

  build() {
    const id = `cc-${this.id}`
    // under the overlay: catches clicks beside the picture, which would close the full-size view
    this.shield = el('div', { className: 'cc-shield' })
    this.overlay = el('canvas', { className: 'cc-overlay', tabIndex: 0 })
    this.overlay.setAttribute('role', 'application')
    this.overlay.setAttribute('aria-roledescription', 'corner picker')
    this.overlay.setAttribute('aria-label', 'The camera picture. Click or tap the corners here; or use the arrow keys to move the cross and Enter to place a corner.')
    this.overlay.setAttribute('aria-describedby', `${id}-prompt`)
    this.ctx = this.overlay.getContext('2d')
    this.loupe = el('canvas', { className: 'cc-loupe', hidden: true })
    this.loupe.setAttribute('aria-hidden', 'true')
    this.root = el('section', { className: 'cc', tabIndex: -1 })
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-modal', 'false') // the picture beside it must stay clickable
    this.root.setAttribute('aria-labelledby', `${id}-title`)
    const title = el('h2', { className: 'cc-title', id: `${id}-title`, tabIndex: -1 }, 'Colour check', this.camera ? el('span', { className: 'cc-cam', textContent: ` · ${this.camera}` }) : null)
    this.collapseBtn = button('Hide', 'cc-collapse', () => this.setCollapsed(!this.collapsed), { hidden: true })
    this.collapseBtn.setAttribute('aria-expanded', 'true')
    const closeBtn = button('×', 'cc-close', () => this.close())
    closeBtn.setAttribute('aria-label', 'Close colour check')
    this.body = el('div', { className: 'cc-body' })
    this.statusEl = el('p', { className: 'cc-status' })
    this.statusEl.setAttribute('role', 'status')
    this.statusEl.setAttribute('aria-live', 'polite')
    this.root.append(el('div', { className: 'cc-head' }, title, this.collapseBtn, closeBtn), this.body, this.statusEl)
    for (const e of [this.shield, this.overlay, this.root]) {
      // the full-size tile closes on a click, and the page has single-key shortcuts: not from here
      e.addEventListener('click', (ev) => ev.stopPropagation())
      e.addEventListener('dblclick', (ev) => ev.stopPropagation())
      e.addEventListener('keydown', (ev) => ev.stopPropagation())
    }
    for (const e of [this.overlay, this.root]) e.addEventListener('focusin', (ev) => (this.lastFocus = ev.target))
    this.shield.addEventListener('click', () => {
      if (this.step === 'corners') this.status('Click on the picture itself.')
    })
    this.root.addEventListener('keydown', (e) => this.onRootKey(e))
    this.overlay.addEventListener('keydown', (e) => this.onOverlayKey(e))
    this.overlay.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    this.overlay.addEventListener('pointermove', (e) => this.onPointerMove(e))
    this.overlay.addEventListener('pointerup', (e) => this.onPointerUp(e))
    this.overlay.addEventListener('pointercancel', () => this.endAim(false))
    this.overlay.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.aim) {
        this.hover = null
        this.draw()
      }
    })
    this.overlay.addEventListener('focus', () => {
      // focus that came from the keyboard (Tab, or Start pressed with Enter) shows the cross at once
      try {
        this.keyboard = this.overlay.matches(':focus-visible')
      } catch {}
      this.draw()
    })
    this.overlay.addEventListener('blur', () => this.draw())
    this.host.append(this.shield, this.overlay, this.loupe, this.root)
  }

  status(text) {
    if (this.statusEl) this.statusEl.textContent = text
  }

  setCollapsed(on) {
    this.collapsed = on
    this.root.classList.toggle('cc-collapsed', on)
    this.collapseBtn.textContent = on ? 'Show results' : 'Hide'
    this.collapseBtn.setAttribute('aria-expanded', String(!on))
    this.collapseBtn.title = on ? 'Show the results again' : 'Hide the results to see the whole picture'
  }

  setStep(step) {
    this.step = step
    this.root.dataset.step = step
    this.root.classList.remove('cc-covers', 'cc-short')
    this.setCollapsed(false)
    this.collapseBtn.hidden = !(step === 'results' || step === 'error')
    this.overlay.classList.toggle('cc-picking', step === 'corners')
    this.body.replaceChildren()
    if (step === 'intro') this.renderIntro()
    else if (step === 'corners' || step === 'measuring') this.renderBar()
    else if (step === 'results') this.renderResults()
    else if (step === 'error') this.renderError()
    this.layoutKey = ''
    this.layout()
    this.place()
    this.draw()
  }

  // ---- layout ---------------------------------------------------------------------------------------

  /** Puts the overlay exactly over the picture (letterboxing and devicePixelRatio accounted for). */
  layout() {
    if (!this.isOpen) return
    // where the focus is in the check (focus events can lag while the window is in the background)
    const active = document.activeElement
    if (active && (active === this.overlay || this.root.contains(active))) this.lastFocus = active
    const host = this.hostEl()
    if (host && host !== this.host && host.isConnected) this.moveTo(host)
    if (!this.host.isConnected) {
      // a fixed host that left the page: the view closed. One given as a function comes back
      // when the view has rebuilt its tile; until then there is nothing to lay over.
      if (typeof this.hostOpt !== 'function') return this.close()
      if (this.layoutKey !== 'gone') {
        this.layoutKey = 'gone'
        this.pic = null
        this.ov = null
        this.aim = null
        this.overlay.hidden = true
        this.hideLoupe()
      }
      return
    }
    const video = this.videoEl()
    const hr = this.host.getBoundingClientRect()
    const hostBox = { left: hr.left + this.host.clientLeft, top: hr.top + this.host.clientTop, width: this.host.clientWidth, height: this.host.clientHeight }
    const dpr = window.devicePixelRatio || 1
    let pic = null
    if (video?.isConnected) {
      const [iw, ih] = video instanceof HTMLVideoElement ? [video.videoWidth, video.videoHeight] : video instanceof HTMLImageElement ? [video.naturalWidth, video.naturalHeight] : [video.width, video.height]
      const cs = getComputedStyle(video)
      const r = video.getBoundingClientRect()
      const px = (v) => parseFloat(v) || 0
      const box = {
        left: r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft),
        top: r.top + px(cs.borderTopWidth) + px(cs.paddingTop),
        width: r.width - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(cs.paddingLeft) - px(cs.paddingRight),
        height: r.height - px(cs.borderTopWidth) - px(cs.borderBottomWidth) - px(cs.paddingTop) - px(cs.paddingBottom)
      }
      pic = pictureRect(box, iw, ih, cs.objectFit || 'fill', objectPosition(cs.objectPosition))
    }
    const key = pic ? [pic.left, pic.top, pic.width, pic.height, hostBox.left, hostBox.top, hostBox.width, hostBox.height, dpr].map((x) => x.toFixed(1)).join() : 'none'
    if (key === this.layoutKey) return
    this.layoutKey = key
    this.pic = pic
    this.hostSize = [hostBox.width, hostBox.height]
    if (!pic) {
      this.overlay.hidden = true
      this.ov = null
      if (this.step === 'corners') this.status('Waiting for the picture…')
      return
    }
    const ov = overlayBox(pic, hostBox, dpr)
    Object.assign(this.overlay.style, { left: `${ov.left}px`, top: `${ov.top}px`, width: `${ov.width}px`, height: `${ov.height}px` })
    if (this.overlay.width !== ov.backingWidth) this.overlay.width = ov.backingWidth
    if (this.overlay.height !== ov.backingHeight) this.overlay.height = ov.backingHeight
    this.overlay.hidden = false
    this.ov = ov
    this.place()
    this.draw()
  }

  /** Positions the dialog for the step: centred, a bar clear of the picture, or the results dock. */
  place() {
    const s = this.root.style
    for (const k of ['left', 'top', 'width', 'maxHeight', 'right', 'bottom']) s[k] = ''
    this.root.classList.remove('cc-column', 'cc-tight')
    if (!this.ov || this.step === 'intro') return
    const [W, H] = this.hostSize
    const ov = this.ov
    if (this.step === 'corners' || this.step === 'measuring') {
      // in the empty band above or below the picture when it fits in one (a phone held upright
      // has both), else in a side band (a phone on its side), else shortened over the picture's
      // edge, where the admin can move it
      const bar = chooseBar(W, H, ov, this.root.offsetHeight, { at: this.barAt, moved: this.barMoved })
      this.barPlaced = bar.where
      this.barMode = bar.mode
      if (bar.mode === 'column') {
        this.root.classList.add('cc-column')
        Object.assign(s, { left: `${bar.left}px`, width: `${bar.width}px`, right: 'auto', top: '8px', maxHeight: `${H - 16}px` })
      } else if (bar.mode === 'band') s.top = `${bar.top}px`
      else {
        this.root.classList.add('cc-tight')
        const h = this.root.offsetHeight
        s.top = `${bar.where === 'top' ? 8 : Math.max(8, H - h - 8)}px`
      }
      this.updateMoveButton()
      return
    }
    const d = chooseDock(W, H, ov, this.chartBox() ?? [0.5, 0.5])
    Object.assign(s, { left: `${d.left}px`, width: `${d.width}px`, maxHeight: `${d.maxHeight}px` })
    if (d.bottom !== undefined) s.bottom = `${d.bottom}px`
    else s.top = `${d.top}px`
    this.root.classList.toggle('cc-covers', d.covers)
    // a short panel (a phone): compact, the squares folded away; the buttons stay in view
    const short = d.maxHeight < 320
    this.root.classList.toggle('cc-short', short)
    if (this.squaresFresh && this.squaresEl) {
      this.squaresEl.open = !short
      this.squaresFresh = false
    }
  }

  /** Where the chart (or card) is on the picture, as fractions with a little room for the grid's marks. */
  chartBox() {
    if (this.points.length !== 4) return null
    const us = this.points.map((p) => p[0])
    const vs = this.points.map((p) => p[1])
    const pad = 0.02
    return { left: Math.max(0, Math.min(...us) - pad), right: Math.min(1, Math.max(...us) + pad), top: Math.max(0, Math.min(...vs) - pad), bottom: Math.min(1, Math.max(...vs) + pad) }
  }

  // ---- the steps ----------------------------------------------------------------------------------------

  renderIntro() {
    const name = `cc-${this.id}-mode`
    const steps = el('ol', { className: 'cc-steps' })
    const same = el('label', { className: 'cc-same' })
    const sameBox = el('input', { type: 'checkbox', checked: true })
    same.append(sameBox, ' Use the same corners as last time')
    const start = button('', 'cc-primary cc-start', () => this.startCorners(sameBox.checked && !same.hidden))
    const fill = () => {
      steps.replaceChildren(...STEPS[this.mode].map((t) => el('li', { textContent: t })))
      same.hidden = !(this.last && this.last.mode === this.mode)
      start.textContent = this.mode === 'card' ? 'Start: click the card’s corners' : 'Start: click the chart’s corners'
    }
    const option = (value, title, text) => {
      const input = el('input', { type: 'radio', name, value, checked: this.mode === value })
      input.addEventListener('change', () => {
        this.mode = value
        fill()
      })
      return el('label', { className: 'cc-mode' }, input, el('span', {}, el('b', { textContent: title }), el('small', { textContent: text })))
    }
    const modes = el('fieldset', { className: 'cc-modes' },
      el('legend', { textContent: 'What will you hold up?' }),
      option('chart', 'ColorChecker chart', '24 colour squares (ColorChecker Classic): a full colour score.'),
      option('card', 'White or grey card', 'A plain sheet or grey card: checks white balance only.'))
    fill()
    this.body.append(
      el('p', { className: 'cc-lead', textContent: 'Check this camera’s colours against a chart or card held in front of it. Nothing on the camera changes: any suggestions go to the Picture panel for you to apply.' }),
      modes,
      el('h3', { className: 'cc-sub', textContent: 'How to do it' }),
      steps,
      same,
      el('div', { className: 'cc-actions' }, button('Cancel', 'cc-cancel', () => this.close()), start)
    )
    this.status('')
    queueMicrotask(() => this.body.querySelector('input:checked')?.focus())
  }

  startCorners(useLast) {
    this.points = useLast && this.last ? this.last.points.map((p) => [...p]) : []
    this.selected = -1
    this.autoChecked = this.points.length === 4
    this.check = null
    this.setStep('corners')
    if (this.points.length === 4) {
      this.status('The same corners as last time: press Check colours, or drag a corner to adjust it.')
      this.body.querySelector('.cc-check')?.focus()
    } else {
      this.status('')
      this.overlay.focus({ preventScroll: true })
    }
  }

  renderBar() {
    const id = `cc-${this.id}`
    const measuring = this.step === 'measuring'
    const what = this.mode === 'card' ? 'card' : 'chart'
    this.prompt = el('p', { className: 'cc-prompt', id: `${id}-prompt` })
    if (measuring) {
      this.body.append(this.prompt, el('div', { className: 'cc-row' }, button('Cancel', 'cc-cancel', () => this.cancelMeasuring())))
      this.prompt.textContent = 'Reading the picture…'
      return
    }
    this.undoBtn = button('Undo point', 'cc-undo', () => this.undo())
    this.restartBtn = button('Start again', 'cc-restart', () => this.restart())
    this.checkBtn = button(this.mode === 'card' ? 'Check the card' : 'Check colours', 'cc-primary cc-check', () => this.runCheck())
    this.moveBtn = button('⇅', 'cc-move', () => {
      this.barAt = this.barPlaced === 'top' ? 'bottom' : 'top'
      this.barMoved = true
      this.place()
    })
    this.moveBtn.dataset.what = what
    this.body.append(
      this.prompt,
      el('div', { className: 'cc-row' }, this.undoBtn, this.restartBtn, this.checkBtn, this.moveBtn),
      el('p', { className: 'cc-help' },
        el('span', { className: 'cc-help-fine', textContent: 'Once all four are placed, drag one to move it; Undo point takes the last one back. Keyboard: arrow keys move the cross (Shift: faster), Enter places a corner, 1-4 picks one to move, Backspace undoes, Esc cancels.' }),
        el('span', { className: 'cc-help-coarse', textContent: 'Touch and slide to aim (the magnifier shows where), lift to place. Once all four are placed, drag one to move it. Two fingers zoom in on a small chart.' }))
    )
    this.updateBar()
  }

  updateMoveButton() {
    const b = this.moveBtn
    if (!b?.isConnected) return
    const text = `Move this bar ${this.barPlaced === 'top' ? 'down' : 'up'}`
    b.setAttribute('aria-label', text)
    b.title = `${text} (if it covers the ${b.dataset.what})`
  }

  updateBar() {
    if (this.step !== 'corners' || !this.prompt) return
    const n = this.points.length
    const what = this.mode === 'card' ? 'the card' : 'the chart’s colour squares'
    this.prompt.replaceChildren()
    const tap = this.coarse ? 'Tap' : 'Click'
    if (n < 4) this.prompt.append(el('b', { textContent: `${tap} corner ${n + 1} of 4` }), ` of ${what} (any order).`)
    else if (this.selected >= 0) this.prompt.append(el('b', { textContent: `Moving corner ${this.selected + 1}` }), ': arrow keys move it, Enter puts it down.')
    else this.prompt.append(el('b', { textContent: 'All four corners placed.' }), ' Drag one to adjust, then check.')
    this.undoBtn.disabled = n === 0
    this.restartBtn.disabled = n === 0
    this.checkBtn.disabled = n !== 4
    this.place()
  }

  undo() {
    if (this.step !== 'corners' || !this.points.length) return
    this.points.pop()
    this.selected = -1
    this.status(`Corner ${this.points.length + 1} taken away.`)
    this.updateBar()
    this.draw()
  }

  restart() {
    if (this.step !== 'corners') return
    this.points = []
    this.selected = -1
    this.autoChecked = false
    this.status('Corners cleared: click the first corner.')
    this.updateBar()
    this.draw()
    this.overlay.focus({ preventScroll: true })
  }

  place4th() {
    this.updateBar()
    this.draw()
    if (this.points.length !== 4) return
    if (!orderCorners(this.points)) {
      this.status('The four corners must make a proper four-sided shape: drag one, or undo it.')
      return
    }
    if (!this.autoChecked) {
      this.autoChecked = true
      this.runCheck()
    }
  }

  addPoint(p) {
    if (this.points.length >= 4) return
    this.points.push(clampPic(p))
    const n = this.points.length
    this.status(n < 4 ? `Corner ${n} placed. Now corner ${n + 1}.` : 'All four corners placed.')
    this.place4th()
  }

  // ---- pointer and keyboard ------------------------------------------------------------------------------

  /** Where a pointer event is on the picture. The overlay is exactly the picture, measured now:
   *  a scroll of the page moves it on screen without any resize to tell the layout. */
  toPic(e) {
    const r = this.overlay?.getBoundingClientRect()
    if (r && r.width > 0 && r.height > 0) return clientToPicture(e.clientX, e.clientY, r)
    return this.pic ? clientToPicture(e.clientX, e.clientY, this.pic) : null
  }

  onPointerDown(e) {
    if (this.step !== 'corners' || !e.isPrimary || e.button !== 0 || !this.ov) return
    const p = this.toPic(e)
    if (!p) return
    e.preventDefault()
    this.keyboard = false
    this.overlay.focus({ preventScroll: true })
    const drag = pressTarget(this.points, p, [this.ov.width, this.ov.height], e.pointerType)
    if (drag === null) return this.status('All four corners are placed: drag one to move it, or Undo point.')
    try {
      this.overlay.setPointerCapture(e.pointerId)
    } catch {}
    this.selected = -1
    this.aim = { id: e.pointerId, type: e.pointerType, drag, pos: clampPic(p) }
    this.draw()
  }

  onPointerMove(e) {
    const p = this.toPic(e)
    if (!p) return
    if (this.aim && e.pointerId === this.aim.id) {
      this.aim.pos = clampPic(p)
      if (this.aim.drag >= 0) this.points[this.aim.drag] = this.aim.pos
      this.draw()
    } else if (e.pointerType === 'mouse' && this.step === 'corners') {
      this.hover = p
      this.draw()
    }
  }

  onPointerUp(e) {
    if (!this.aim || e.pointerId !== this.aim.id) return
    this.endAim(true)
  }

  endAim(commit) {
    const a = this.aim
    this.aim = null
    if (a && commit) {
      if (a.drag >= 0) {
        this.points[a.drag] = a.pos
        this.status(`Corner ${a.drag + 1} moved.`)
        this.place4th()
      } else this.addPoint(a.pos)
    }
    this.draw()
  }

  onRootKey(e) {
    if ((e.key === 'Backspace' || e.key === 'Delete') && this.step === 'corners' && !e.target.closest('input, textarea, select')) {
      e.preventDefault()
      this.undo()
    }
  }

  onOverlayKey(e) {
    if (this.step !== 'corners' || !this.ov) return
    if (e.key.startsWith('Arrow') || e.key === 'Enter' || e.key === ' ') this.keyboard = true
    const px = e.shiftKey ? 20 : e.altKey ? 0.5 : 2 // CSS px per press
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
    if (dir) {
      e.preventDefault()
      const moving = this.selected >= 0
      const from = moving ? this.points[this.selected] : this.cursor
      const to = clampPic([from[0] + (dir[0] * px) / this.ov.width, from[1] + (dir[1] * px) / this.ov.height])
      if (moving) this.points[this.selected] = to
      this.cursor = to
      this.draw()
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (this.selected >= 0) {
        const n = this.selected
        this.selected = -1
        this.status(`Corner ${n + 1} put down.`)
        this.place4th()
      } else if (this.points.length < 4) this.addPoint(this.cursor)
      else this.status('All four corners are placed: press 1-4 to move one, or Check colours.')
      return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      this.undo()
      return
    }
    const n = Number(e.key)
    if (n >= 1 && n <= 4 && n <= this.points.length) {
      e.preventDefault()
      this.selected = this.selected === n - 1 ? -1 : n - 1
      if (this.selected >= 0) this.cursor = [...this.points[this.selected]]
      this.status(this.selected >= 0 ? `Moving corner ${n}: arrow keys, then Enter.` : `Corner ${n} put down.`)
      this.updateBar()
      this.draw()
    }
  }

  // ---- the check ------------------------------------------------------------------------------------

  cancelMeasuring() {
    this.seq++
    this.abort?.abort()
    this.abort = null
    this.setStep('corners')
    this.status('Check cancelled.')
  }

  /** The pictures for one check: through getFrames() when given, else getFrame() n times, GRAB_GAP_MS apart. */
  async readFrames(n, { signal, onFrame }) {
    if (this.getFrames) return this.getFrames(n, { signal, onFrame })
    const out = []
    for (let i = 0; i < n; i++) {
      if (i) await sleep(GRAB_GAP_MS)
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
      try {
        out.push(await withTimeout(Promise.resolve().then(() => this.getFrame()), GRAB_TIMEOUT_MS))
      } catch (e) {
        out.push({ error: e?.message || String(e) })
      }
      onFrame?.(i + 1, n)
    }
    return out
  }

  /** Reads GRABS pictures about GRAB_GAP_MS apart and shows the median result. */
  async runCheck() {
    if (this.points.length !== 4 || !orderCorners(this.points)) return
    const seq = ++this.seq
    const points = this.points.map((p) => [...p])
    const kind = this.mode
    this.setStep('measuring')
    this.prompt.textContent = 'Waiting for a picture from the camera…'
    const ctl = typeof AbortController === 'function' ? new AbortController() : null
    this.abort = ctl
    const onFrame = (i, n) => {
      if (seq === this.seq && this.prompt) this.prompt.textContent = i < n ? `Reading the pictures: ${i} of ${n}…` : 'Checking the colours…'
    }
    let frames
    try {
      frames = await withTimeout(this.readFrames(GRABS, { signal: ctl?.signal, onFrame }), BATCH_TIMEOUT_MS)
    } catch (e) {
      ctl?.abort() // a timeout: stop the player's grab too
      if (seq !== this.seq) return
      frames = Array.from({ length: GRABS }, () => ({ error: e?.message || String(e) }))
    } finally {
      if (this.abort === ctl) this.abort = null
    }
    if (seq !== this.seq) return
    if (!Array.isArray(frames) || !frames.length) frames = [{ error: 'no pictures came' }]
    const results = frames.map((f) => (f?.error ? { error: String(f.error) } : !isFrame(f) ? { error: 'the picture came without its colour planes' } : checkOne(f, points, kind, f.decode ?? this.decode)))
    const median = medianResult(results, kind)
    const r = median.result
    const frame = r ? frames[results.indexOf(r)] : null
    const fields = this.fieldList()
    // corners on the chart's black edge (or squares wildly off): no grade and no suggestions
    const edge = kind === 'chart' && frame ? edgeCorners(frame, r.corners, r, frame.decode ?? this.decode) : null
    const trouble = kind === 'chart' ? cornerTrouble(r, edge) : null
    const suggestions = r?.ok && !trouble ? (kind === 'card' ? whiteCardSuggestions(r, fields) : colourSuggestions(r, fields)) : []
    const notes = trouble ? [] : checkNotes({ kind, result: r, frames, fields })
    this.check = { kind, median, at: new Date(), suggestions, points, trouble, edge, notes, screen: fromScreen(frames), frameSize: r?.frameSize ?? null }
    if (!r) {
      this.setStep('error')
      return
    }
    if (r.ok && !trouble) this.last = { mode: kind, points }
    this.setStep('results')
    const words = trouble ? 'check the corners' : kind === 'card' ? (r.ok ? describeCard(r).verdict : 'not checked') : r.ok ? `${describeChart(r.summary).grade}, average difference ${f1(r.summary.meanDE)}` : 'not checked'
    this.status(`Colour check done: ${words}.`)
    this.root.querySelector('.cc-title')?.focus({ preventScroll: true })
  }

  /** The corners moved in off the black edge (as edgeCorners() found them), checked again. */
  useEdge() {
    const e = this.check?.edge
    const size = this.check?.frameSize
    if (!e || !size) return
    this.points = e.corners.map((p) => clampPic(frameToPicture(p, size[0], size[1])))
    this.selected = -1
    this.autoChecked = true
    this.runCheck()
  }

  renderError() {
    const m = this.check?.median
    this.body.append(
      el('p', { className: 'cc-problem cc-fatal', textContent: `Couldn’t get a picture from the camera (${[...new Set(m?.errors ?? ['no picture'])].join('; ')}). Check the video is playing, then try again.` }),
      el('div', { className: 'cc-actions' },
        button('Adjust corners', '', () => this.adjust()),
        button('Close', '', () => this.close()),
        button('Try again', 'cc-primary', () => this.runCheck()))
    )
    this.status('No picture could be read.')
  }

  adjust() {
    this.check = null
    this.setStep('corners')
    this.status('Drag a corner to adjust it, then check again.')
    this.overlay.focus({ preventScroll: true })
  }

  renderResults() {
    const { kind, median, suggestions, trouble, notes = [] } = this.check
    const r = median.result
    const box = this.body
    const problems = r.why ? [{ text: r.why, fatal: true }] : [...(r.problems ?? [])].sort((a, b) => Number(Boolean(b.fatal)) - Number(Boolean(a.fatal)))
    const note = (text, cls = 'cc-note') => el('p', { className: cls, textContent: text })
    const pictures = note(`Pictures: ${picturesLine(median, kind)}`, median.unsteady ? 'cc-note cc-warn' : 'cc-note')
    const again = button('Check again', 'cc-primary', () => this.runCheck())
    this.squaresEl = null
    if (trouble) {
      // the corners, not the camera: no grade and no suggestions until they are right
      box.append(el('h3', { className: 'cc-grade cc-b-clear', textContent: 'Check the corners' }))
      box.append(el('p', { className: 'cc-problem', textContent: trouble.text }))
      if (trouble.detail) box.append(note(trouble.detail))
      box.append(note(trouble.kind === 'wild'
        ? `As read, the average difference is ${f1(r.summary.meanDE)}, but it can’t be trusted until the corners are right. No setting changes are suggested meanwhile.`
        : 'No setting changes are suggested until the corners are right.'))
      box.append(pictures)
      if (trouble.kind === 'wild') box.append(this.swatchTable(r))
      box.append(this.summaryBox())
      const fix = trouble.kind === 'edge' ? button('Move the corners in and check', 'cc-primary', () => this.useEdge()) : again
      box.append(el('div', { className: 'cc-actions' }, button('Adjust corners', '', () => this.adjust()), button('Close', 'cc-close-2', () => this.close()), fix))
      return
    }
    if (!r.ok) {
      box.append(el('h3', { className: 'cc-grade cc-b-poor', textContent: 'Not checked' }))
      box.append(el('ul', { className: 'cc-problems' }, ...problems.map((p) => el('li', { className: p.fatal ? 'cc-fatal' : '', textContent: p.text }))))
      box.append(note(`Adjust the corners, or start again with the ${kind === 'card' ? 'card' : 'chart'} held as the steps describe.`))
      box.append(pictures)
    } else {
      // the verdict, then what qualifies it, then what to do: the details and the squares after
      if (kind === 'card') {
        const d = describeCard(r)
        box.append(el('h3', { className: `cc-grade cc-b-${d.band}`, textContent: d.verdict }))
        const sw = el('span', { className: 'cc-sw' })
        sw.style.background = rgbCss(r.card.rgb)
        sw.title = labText([r.card.L, r.card.a, r.card.b])
        box.append(el('dl', { className: 'cc-words' },
          el('dt', { textContent: 'Colour cast' }), el('dd', { textContent: d.cast }),
          el('dt', { textContent: 'Lightness' }), el('dd', { textContent: d.lightness }),
          el('dt', { textContent: 'Card as seen' }), el('dd', {}, sw, ' as the camera shows it')))
      } else {
        const d = describeChart(r.summary)
        box.append(el('h3', { className: `cc-grade cc-b-${d.band}`, textContent: d.grade }))
        box.append(el('p', { className: 'cc-score' }, el('b', { textContent: f1(r.summary.meanDE) }), ' average colour difference (ΔE00). Under 3 is hard to see side by side, 3-6 small, 6-10 clearly off, over 10 poor.'))
      }
      const others = [...shownProblems(problems.filter((p) => !p.fatal), this.check.screen).map((p) => p.text), ...notes]
      if (others.length) box.append(el('ul', { className: 'cc-problems' }, ...others.map((t) => el('li', { textContent: t }))))
      box.append(this.suggestionList(suggestions, autoWhiteBalanceNote(kind === 'card' ? r.cast : r.summary.cast, this.fieldList(), suggestions)))
      if (kind === 'chart') {
        const s = r.summary
        const d = describeChart(s)
        box.append(el('p', {}, el('b', { textContent: 'Furthest off: ' }), furthestText(r) || 'none'))
        box.append(el('dl', { className: 'cc-words' },
          ...[['White balance', d.whiteBalance], ['Colour strength', d.saturation], ['Hue', d.hue], ['Contrast', d.contrast], ['Exposure', d.exposure]]
            .flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })])))
        box.append(note(`Exposure is evened out first, so a darker or brighter picture doesn’t count as a colour error; as the camera shows it the average is ${f1(s.meanDERaw)}.`))
      }
      box.append(pictures)
      if (kind === 'chart') box.append(this.swatchTable(r))
    }
    box.append(this.summaryBox())
    box.append(el('div', { className: 'cc-actions' }, button('Adjust corners', '', () => this.adjust()), button('Close', 'cc-close-2', () => this.close()), again))
  }

  suggestionList(list, extra = null) {
    const wrap = el('section', { className: 'cc-suggest' })
    if (!list.length) {
      wrap.append(el('p', { className: extra ? '' : 'cc-good', textContent: 'No setting changes suggested.' }))
      if (extra) wrap.append(el('p', { className: 'cc-note', textContent: extra }))
      return wrap
    }
    wrap.append(el('h4', { textContent: 'Suggested changes (optional)' }))
    const use = button('Use these', 'cc-primary cc-use', () => {
      const chosen = list.filter((_, i) => boxes[i].checked).map(({ path, label, from, to, why }) => ({ path, label, from, to, why }))
      if (!chosen.length) return
      try {
        this.onSuggest?.(chosen)
      } catch (e) {
        console.warn('colour check onSuggest', e)
      }
      this.status(`${chosen.length} change${chosen.length > 1 ? 's' : ''} added to the Picture panel.`)
      this.close()
    }, { disabled: true })
    const boxes = list.map(() => el('input', { type: 'checkbox' }))
    const count = () => {
      const n = boxes.filter((b) => b.checked).length
      use.disabled = n === 0
      use.textContent = n ? `Use these (${n})` : 'Use these'
    }
    wrap.append(el('ul', {}, ...list.map((x, i) => {
      boxes[i].addEventListener('change', count)
      return el('li', {}, el('label', {}, boxes[i], el('span', { textContent: `${x.label ?? x.path}: ${x.from} → ${x.to}` })), el('small', { textContent: x.why }))
    })))
    wrap.append(el('div', { className: 'cc-row' }, use))
    wrap.append(el('p', { className: 'cc-note', textContent: 'Ticked changes go to the Picture panel’s list; nothing changes on the camera until you press Apply there. Then check again.' }))
    if (extra) wrap.append(el('p', { className: 'cc-note', textContent: extra }))
    return wrap
  }

  /** The 24 squares, chart beside camera, in a section that folds away (folded on a short panel). */
  swatchTable(r) {
    const worst = new Set(this.check?.trouble ? [] : furthestOff(r).map((p) => p.name))
    const table = el('table', { className: 'cc-table' })
    table.append(el('caption', { textContent: 'The chart’s colour beside the camera’s (exposure evened out), and how far apart they are (ΔE00).' }))
    table.append(el('thead', {}, el('tr', {}, ...['#', 'Square', 'Chart', 'Camera', 'ΔE00'].map((t) => el('th', { scope: 'col', textContent: t })))))
    const body = el('tbody')
    for (const p of r.patches) {
      const ref = el('span', { className: 'cc-sw cc-sw-ref', title: `Chart: ${labText(p.ref)}` })
      ref.style.background = rgbCss(p.refRgb)
      const got = el('span', { className: 'cc-sw cc-sw-cam', title: `Camera: ${labText(p.measured)}` })
      got.style.background = rgbCss(p.measuredRgb)
      const out = leftOut(p)
      const limit = !out && atVideoLimit(p)
      const de = el('span', {
        className: `cc-de cc-b-${squareBand(p)}`,
        textContent: out ? 'left out' : f1(p.dE),
        title: out ? 'Glare or over-exposure: left out of the score' : limit ? 'about as close as video colours allow' : band(p.dE).label
      })
      const tag = (text) => el('span', { className: 'cc-tag', textContent: text })
      const tr = el('tr', { className: worst.has(p.name) ? 'cc-worst' : '' },
        el('td', { textContent: String(p.n) }),
        el('td', {}, p.name, worst.has(p.name) ? tag(' furthest off') : null, VIDEO_LIMIT[p.n - 1] > 1 ? el('small', { className: 'cc-limit', textContent: `${limitText(p)}.` }) : null),
        el('td', { className: 'cc-swc' }, ref),
        el('td', { className: 'cc-swc' }, got),
        el('td', {}, de))
      body.append(tr)
    }
    table.append(body)
    this.squaresEl = el('details', { className: 'cc-squares' }, el('summary', { textContent: 'Each square: chart beside camera (24)' }), el('div', { className: 'cc-table-wrap' }, table))
    this.squaresFresh = true
    return this.squaresEl
  }

  summaryBox() {
    const text = summaryText({ ...this.check, camera: this.camera })
    const area = el('textarea', { className: 'cc-text', readOnly: true, rows: 8, value: text })
    area.setAttribute('aria-label', 'Colour check summary, as text')
    const copy = button('Copy', '', async () => {
      try {
        await navigator.clipboard.writeText(text)
        this.status('Summary copied.')
      } catch {
        area.focus()
        area.select()
        this.status('Press Ctrl+C (or ⌘C) to copy the selected summary.')
      }
    })
    return el('details', { className: 'cc-summary' }, el('summary', { textContent: 'Text summary (to send to someone)' }), area, el('div', { className: 'cc-row' }, copy))
  }

  // ---- drawing -------------------------------------------------------------------------------------------

  draw() {
    const ov = this.ov
    if (!this.isOpen || !ov) return this.hideLoupe()
    const g = this.ctx
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, this.overlay.width, this.overlay.height)
    // the last check's corners stay hidden until the admin chooses to use them again
    if (this.step === 'intro') return this.hideLoupe()
    // draw in the overlay's CSS pixels; the backing store is devicePixelRatio times bigger
    g.setTransform(ov.backingWidth / ov.width, 0, 0, ov.backingHeight / ov.height, 0, 0)
    const P = (p) => [p[0] * ov.width, p[1] * ov.height]
    const pts = this.points.map(P)
    const r = this.step === 'results' ? this.check?.median.result : null
    if (pts.length === 4 && orderCorners(pts)) {
      if (this.mode === 'card') this.drawCard(pts, r)
      else this.drawChart(pts, r)
    } else if (pts.length > 1) {
      g.setLineDash([6, 4])
      line(g, pts, false, 'rgba(255,255,255,0.9)')
      g.setLineDash([])
    }
    // where the corners probably belong, when they were put on the chart's black edge
    const edge = this.step === 'results' ? this.check?.edge : null
    if (edge && this.check.frameSize) {
      const [fw, fh] = this.check.frameSize
      g.setLineDash([5, 4])
      line(g, edge.corners.map((q) => P(frameToPicture(q, fw, fh))), true, '#3ba3ff', 2)
      g.setLineDash([])
    }
    // corners close together (a small chart) get smaller marks, so they don't hide it; once the
    // grid is numbered, the corners' own numbers would read as squares' numbers: left off
    const gaps = pts.flatMap((p, i) => pts.slice(i + 1).map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])))
    const size = Math.max(2.5, Math.min(6, (Math.min(Infinity, ...gaps) / 4)))
    const numbered = this.step === 'results' && this.mode === 'chart'
    pts.forEach((p, i) => this.drawPoint(p, i, size, !numbered))
    // the keyboard's cross only while the keyboard is in use; the mouse's while it hovers
    const keys = this.keyboard && this.overlay === document.activeElement
    const aimAt = this.aim?.pos ?? (keys ? (this.selected >= 0 ? this.points[this.selected] : this.cursor) : null) ?? (this.points.length < 4 ? this.hover : null)
    if (aimAt && this.step === 'corners') {
      if (!this.aim || this.aim.drag < 0) cross(g, P(aimAt), 10)
      this.drawLoupe(aimAt)
    } else this.hideLoupe()
  }

  drawPoint([x, y], i, r = 6, numbered = true) {
    const g = this.ctx
    const on = i === this.selected || i === this.aim?.drag
    g.beginPath()
    g.arc(x, y, on ? r + 2 : r, 0, 2 * Math.PI)
    g.fillStyle = on ? '#ffcf87' : '#3ba3ff'
    g.strokeStyle = '#fff'
    g.lineWidth = r < 4 ? 1 : 2
    g.fill()
    g.stroke()
    if (numbered) label(g, String(i + 1), x + r + 3, y - r - 3, 12, 'left')
  }

  drawChart(pts, r) {
    const g = this.ctx
    const found = r?.orientation
    const cells = chartCells(orientedCorners(pts, found ?? provisionalOrientation(pts)))
    if (!cells.length) return
    const fatal = r && !r.ok
    const patches = r?.patches
    const pitch = Math.min(...cells.map((c) => Math.hypot(c.cell[1][0] - c.cell[0][0], c.cell[1][1] - c.cell[0][1])))
    for (const c of cells) {
      g.setLineDash(found ? [] : [4, 3])
      line(g, c.cell, true, 'rgba(255,255,255,0.45)', 1)
      g.setLineDash([])
      const p = patches?.[c.n - 1]
      const colour = !r ? 'rgba(255,255,255,0.8)' : fatal ? BAND_COLOUR.poor : BAND_COLOUR[squareBand(p)]
      line(g, c.read, true, colour, found ? 2 : 1.5)
      if (found && pitch >= 16) label(g, String(c.n), c.centre[0], c.centre[1], Math.max(9, Math.min(13, pitch / 3)), 'center')
    }
    line(g, orientedCorners(pts, found ?? provisionalOrientation(pts)), true, fatal ? BAND_COLOUR.poor : 'rgba(255,255,255,0.95)', 2)
    if (found && !fatal) {
      // square 1 (dark skin) marks how the chart was found to be held
      const c = cells[0]
      g.beginPath()
      g.arc(c.cell[0][0], c.cell[0][1], 4, 0, 2 * Math.PI)
      g.fillStyle = '#ffcf87'
      g.fill()
    }
  }

  drawCard(pts, r) {
    const area = cardArea(pts)
    const quad = orderCorners(pts)
    const colour = !r ? 'rgba(255,255,255,0.85)' : !r.ok ? BAND_COLOUR.poor : BAND_COLOUR[describeCard(r).band]
    line(this.ctx, quad, true, 'rgba(255,255,255,0.95)', 2)
    if (!area) return
    this.ctx.setLineDash([6, 4])
    line(this.ctx, area, true, colour, 2)
    this.ctx.setLineDash([])
  }

  /** A magnifier near the point being aimed at, showing the video's own pixels there. */
  drawLoupe(at) {
    const video = this.videoEl()
    const ov = this.ov
    if (!video || !ov || !this.hostSize) return this.hideLoupe()
    const [iw, ih] = video instanceof HTMLVideoElement ? [video.videoWidth, video.videoHeight] : [video.width, video.height]
    if (!iw || !ih) return this.hideLoupe()
    const R = Math.round(Math.min(this.coarse ? 52 : 60, (Math.min(...this.hostSize) - 16) / 2))
    const zoom = 4
    const dpr = window.devicePixelRatio || 1
    const c = this.loupe
    const size = Math.round(2 * R * dpr)
    if (c.width !== size) c.width = c.height = size
    c.style.width = c.style.height = `${2 * R}px`
    // clear of the finger or cursor and of the dialog: above-left first, else another corner
    const x = ov.left + at[0] * ov.width
    const y = ov.top + at[1] * ov.height
    const off = R + (this.aim?.type === 'touch' ? 36 : 20)
    const [lx, ly] = loupeSpot(x, y, R, off, this.hostSize, boxIn(this.root, this.host))
    c.style.left = `${lx - R}px`
    c.style.top = `${ly - R}px`
    const g = c.getContext('2d')
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.fillStyle = '#000'
    g.fillRect(0, 0, size, size)
    g.imageSmoothingEnabled = false // the real pixels, so a corner can be put on the right one
    // the region around the point, in the video element's and the overlay's own pixels
    const span = (2 * R) / zoom // CSS px of picture shown across the loupe
    const sw = (span / ov.width) * iw
    const sh = (span / ov.height) * ih
    try {
      g.drawImage(video, at[0] * iw - sw / 2, at[1] * ih - sh / 2, sw, sh, 0, 0, size, size)
    } catch {}
    // the other corners as thin rings (a scaled copy of the overlay would hide the spot aimed at)
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const toLoupe = (q) => [((q[0] - at[0]) * ov.width * zoom) + R, ((q[1] - at[1]) * ov.height * zoom) + R]
    this.points.forEach((q, i) => {
      if (i === this.aim?.drag || i === this.selected) return
      const [qx, qy] = toLoupe(q)
      if (Math.hypot(qx - R, qy - R) > R + 8) return
      g.beginPath()
      g.arc(qx, qy, 5, 0, 2 * Math.PI)
      g.lineWidth = 3
      g.strokeStyle = 'rgba(0,0,0,0.7)'
      g.stroke()
      g.lineWidth = 1.5
      g.strokeStyle = '#3ba3ff'
      g.stroke()
    })
    cross(g, [R, R], R * 0.45)
    c.hidden = false
  }

  hideLoupe() {
    if (this.loupe) this.loupe.hidden = true
  }
}

/** A result for one picture: the corners taken from picture fractions to its own pixels. */
function checkOne(frame, points, kind, decode) {
  const corners = points.map((p) => pictureToFrame(p, frame.width, frame.height))
  try {
    const r = kind === 'card' ? checkWhiteCard(frame, corners, decode) : checkColours(frame, corners, decode)
    return Object.assign(r, { frameSize: [frame.width, frame.height], corners })
  } catch (e) {
    return { error: `the picture could not be read (${e.message})` }
  }
}

const clampPic = ([u, v]) => [Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))]

/** An element's box relative to the host's padding box (CSS px), or null when not shown. */
function boxIn(e, host) {
  if (!e?.isConnected) return null
  const r = e.getBoundingClientRect()
  const h = host.getBoundingClientRect()
  return r.width ? { left: r.left - h.left - host.clientLeft, top: r.top - h.top - host.clientTop, width: r.width, height: r.height } : null
}

/**
 * Where the magnifier (radius R) goes for a point at x, y in a host of `size`: `off` away from
 * it diagonally, trying above-left, above-right, below-left, below-right, the first that fits in
 * the host without covering `avoid` (the dialog); else the first that fits, pushed inside.
 */
export function loupeSpot(x, y, R, off, [W, H], avoid = null) {
  const fits = ([cx, cy]) => cx - R >= 4 && cy - R >= 4 && cx + R <= W - 4 && cy + R <= H - 4
  const clear = ([cx, cy]) => !avoid || cx + R < avoid.left || cx - R > avoid.left + avoid.width || cy + R < avoid.top || cy - R > avoid.top + avoid.height
  const spots = [[x - off, y - off], [x + off, y - off], [x - off, y + off], [x + off, y + off]]
  const best = spots.find((s) => fits(s) && clear(s)) ?? spots.find(fits) ?? spots[0]
  return [Math.max(R + 4, Math.min(W - R - 4, best[0])), Math.max(R + 4, Math.min(H - R - 4, best[1]))]
}

/** A line (or closed shape) with a dark edge, so it shows on any picture. */
function line(g, pts, closed, colour, width = 1.5) {
  if (!pts || pts.length < 2) return
  g.beginPath()
  g.moveTo(pts[0][0], pts[0][1])
  for (const p of pts.slice(1)) g.lineTo(p[0], p[1])
  if (closed) g.closePath()
  g.lineJoin = 'round'
  g.strokeStyle = 'rgba(0,0,0,0.7)'
  g.lineWidth = width + 2
  g.stroke()
  g.strokeStyle = colour
  g.lineWidth = width
  g.stroke()
}

function cross(g, [x, y], r) {
  line(g, [[x - r, y], [x - 3, y]], false, '#fff', 1.5)
  line(g, [[x + 3, y], [x + r, y]], false, '#fff', 1.5)
  line(g, [[x, y - r], [x, y - 3]], false, '#fff', 1.5)
  line(g, [[x, y + 3], [x, y + r]], false, '#fff', 1.5)
}

function label(g, text, x, y, size, align) {
  g.font = `600 ${size}px system-ui, sans-serif`
  g.textAlign = align
  g.textBaseline = 'middle'
  g.lineWidth = 3
  g.strokeStyle = 'rgba(0,0,0,0.85)'
  g.strokeText(text, x, y)
  g.fillStyle = '#fff'
  g.fillText(text, x, y)
}
