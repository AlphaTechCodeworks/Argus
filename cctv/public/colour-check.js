// Colour check: scores a camera's colour against a ColorChecker Classic (24 patches) held in
// its view, from the values the camera coded (Y/U/V planes, as picture-check.js measures).
//
// The admin clicks the chart's four outer corners (the corners of the patch area, in any
// order); the chart's orientation is found by trying all eight ways round. Each patch is read
// from the middle of its square (its borders and edges left out), converted to CIE L*a*b*
// (D50) the way a viewer's sRGB screen shows it, and compared with the chart's published
// values (X-Rite "after November 2014", as in colour-science's ColorChecker24 dataset and the
// RC ColorChecker Calculator) by CIEDE2000 (dE00). The main score is exposure-corrected: the
// camera's exposure is fitted on the grey patches first, as colour-test software does, so a
// darker or brighter picture doesn't count as a colour error; the uncorrected score is kept.
//
// Rough guide to dE00: under ~3 hard to see side by side, 3-6 visible but small, 6-10 clearly
// off, above 10 poor. Only as good as the light on the chart: daylight, no glare, chart flat.
//
// Pure and DOM-free (node-testable). Nothing here changes a camera: suggestions only fill in
// values in the panel, which an admin applies with a click.

/** The chart (post-November-2014 formulation), row by row as the chart is printed upright. */
export const COLORCHECKER_CLASSIC = [
  ['dark skin', 37.54, 14.37, 14.92], ['light skin', 64.66, 19.27, 17.5], ['blue sky', 49.32, -3.82, -22.54],
  ['foliage', 43.46, -12.74, 22.72], ['blue flower', 54.94, 9.61, -24.79], ['bluish green', 70.48, -32.26, -0.37],
  ['orange', 62.73, 35.83, 56.5], ['purplish blue', 39.43, 10.75, -45.17], ['moderate red', 50.57, 48.64, 16.67],
  ['purple', 30.1, 22.54, -20.87], ['yellow green', 71.77, -24.13, 58.19], ['orange yellow', 71.51, 18.24, 67.37],
  ['blue', 28.37, 15.42, -49.8], ['green', 54.38, -39.72, 32.27], ['red', 42.43, 51.05, 28.62],
  ['yellow', 81.8, 2.67, 80.41], ['magenta', 50.63, 51.28, -14.12], ['cyan', 49.57, -29.71, -28.32],
  ['white 9.5', 95.19, -1.03, 2.93], ['neutral 8', 81.29, -0.57, 0.44], ['neutral 6.5', 66.89, -0.75, -0.06],
  ['neutral 5', 50.76, -0.13, 0.14], ['neutral 3.5', 35.63, -0.46, -0.48], ['black 2', 20.64, 0.07, -0.46]
].map(([name, L, a, b], i) => ({ n: i + 1, name, lab: [L, a, b], row: Math.floor(i / 6), col: i % 6 }))

const COLS = 6
const ROWS = 4
const GREYS = [19, 20, 21, 22, 23, 24] // patch numbers
const EXPOSURE_GREYS = [20, 21, 22, 23] // white and black clip first: left out of the exposure fit
const SATURATED = [13, 14, 15, 16, 17, 18]
const MIN_PATCH_PX = 8 // a patch must be at least this wide on screen to be read reliably
const SAMPLE = 0.5 // the middle half of each patch square is read (borders and edges left out)

// ---- colour maths ------------------------------------------------------------------------------

const D50 = [0.96422, 1, 0.82521]
// linear sRGB (D65) -> XYZ D50, i.e. sRGB -> XYZ D65 followed by Bradford D65 -> D50
const RGB_TO_XYZ50 = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733]
]
const XYZ50_TO_RGB = [
  [3.1338561, -1.6168667, -0.4906146],
  [-0.9787684, 1.9161415, 0.033454],
  [0.0719453, -0.2289914, 1.4052427]
]
const mul = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const clamp01 = (x) => Math.min(1, Math.max(0, x))

/**
 * Coded Y'CbCr (0-255 sample values) -> gamma-encoded R'G'B' (0-1), with the range and matrix
 * the stream is really coded in. TVT cameras code the full 0-255 range (while flagging limited).
 */
export function yuvToRgb(Y, U, V, { range = 'full', matrix = 'bt709' } = {}) {
  const y = range === 'full' ? Y / 255 : (Y - 16) / 219
  const cb = range === 'full' ? (U - 128) / 255 : (U - 128) / 224
  const cr = range === 'full' ? (V - 128) / 255 : (V - 128) / 224
  const [kr, kb] = matrix === 'bt601' ? [0.299, 0.114] : [0.2126, 0.0722]
  const kg = 1 - kr - kb
  const r = y + 2 * (1 - kr) * cr
  const b = y + 2 * (1 - kb) * cb
  const g = (y - kr * r - kb * b) / kg
  return [r, g, b]
}

const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
const fInv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27))

/** Gamma-encoded sRGB (0-1, may be out of range) -> CIE L*a*b* D50. */
export function rgbToLab(rgb) {
  const lin = rgb.map((c) => Math.sign(c) * srgbToLinear(Math.abs(c)))
  const [X, Y, Z] = mul(RGB_TO_XYZ50, lin)
  const [fx, fy, fz] = [X / D50[0], Y / D50[1], Z / D50[2]].map(f)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** CIE L*a*b* D50 -> gamma-encoded sRGB (0-1, clamped), e.g. for showing a swatch on screen. */
export function labToRgb([L, a, b]) {
  const fy = (L + 16) / 116
  const xyz = [fInv(fy + a / 500) * D50[0], fInv(fy) * D50[1], fInv(fy - b / 200) * D50[2]]
  return mul(XYZ50_TO_RGB, xyz).map((c) => clamp01(linearToSrgb(Math.max(0, c))))
}

const rad = (d) => (d * Math.PI) / 180
const deg = (r) => (r * 180) / Math.PI

/** CIEDE2000 colour difference (kL = kC = kH = 1), per Sharma, Wu and Dalal (2005). */
export function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1
  const [L2, a2, b2] = lab2
  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cm = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)))
  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)
  const h = (bb, ap) => (bb === 0 && ap === 0 ? 0 : (deg(Math.atan2(bb, ap)) + 360) % 360)
  const h1p = h(b1, a1p)
  const h2p = h(b2, a2p)
  const dLp = L2 - L1
  const dCp = C2p - C1p
  let dhp = 0
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2))
  const Lpm = (L1 + L2) / 2
  const Cpm = (C1p + C2p) / 2
  let hpm = h1p + h2p
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hpm = (h1p + h2p) / 2
    else hpm = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2
  }
  const T = 1 - 0.17 * Math.cos(rad(hpm - 30)) + 0.24 * Math.cos(rad(2 * hpm)) + 0.32 * Math.cos(rad(3 * hpm + 6)) - 0.2 * Math.cos(rad(4 * hpm - 63))
  const dTheta = 30 * Math.exp(-(((hpm - 275) / 25) ** 2))
  const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * (Lpm - 50) ** 2) / Math.sqrt(20 + (Lpm - 50) ** 2)
  const Sc = 1 + 0.045 * Cpm
  const Sh = 1 + 0.015 * Cpm * T
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))
}

const chroma = ([, a, b]) => Math.hypot(a, b)
const hueDeg = ([, a, b]) => (deg(Math.atan2(b, a)) + 360) % 360
const hueDiff = (h1, h2) => ((h2 - h1 + 540) % 360) - 180

// ---- geometry: the clicked corners -> the chart's patch grid -------------------------------------

/** Homography mapping the unit square's corners (0,0),(1,0),(1,1),(0,1) to four points. */
export function squareToQuad([p0, p1, p2, p3]) {
  const [x0, y0] = p0
  const [x1, y1] = p1
  const [x2, y2] = p2
  const [x3, y3] = p3
  const dx1 = x1 - x2
  const dx2 = x3 - x2
  const sx = x0 - x1 + x2 - x3
  const dy1 = y1 - y2
  const dy2 = y3 - y2
  const sy = y0 - y1 + y2 - y3
  const den = dx1 * dy2 - dx2 * dy1
  if (Math.abs(den) < 1e-12) return null
  const g = (sx * dy2 - dx2 * sy) / den
  const h = (dx1 * sy - sx * dy1) / den
  return {
    a: x1 - x0 + g * x1, b: x3 - x0 + h * x3, c: x0,
    d: y1 - y0 + g * y1, e: y3 - y0 + h * y3, f: y0,
    g, h
  }
}
const apply = (H, u, v) => {
  const w = H.g * u + H.h * v + 1
  return [(H.a * u + H.b * v + H.c) / w, (H.d * u + H.e * v + H.f) / w]
}

/** Four clicked points in order round the quadrilateral (clockwise on screen), or null. */
export function orderCorners(points) {
  if (!Array.isArray(points) || points.length !== 4 || points.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) return null
  const cx = points.reduce((s, p) => s + p[0], 0) / 4
  const cy = points.reduce((s, p) => s + p[1], 0) / 4
  const sorted = [...points].sort((p, q) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx))
  // a proper (convex) quadrilateral: every turn goes the same way
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
  const turns = sorted.map((p, i) => cross(p, sorted[(i + 1) % 4], sorted[(i + 2) % 4]))
  if (!(turns.every((t) => t > 0) || turns.every((t) => t < 0))) return null
  return sorted
}

/** The eight ways the chart can lie in the clicked quadrilateral (rotations, and mirrored). */
function orientations(quad) {
  const out = []
  for (let r = 0; r < 4; r++) {
    const rot = [0, 1, 2, 3].map((i) => quad[(i + r) % 4])
    out.push({ corners: rot, mirrored: false, turn: r })
    out.push({ corners: [rot[1], rot[0], rot[3], rot[2]], mirrored: true, turn: r })
  }
  return out
}

// ---- reading the patches ---------------------------------------------------------------------------

/**
 * Median Y/U/V of the middle of every patch, for one orientation. `frame` is the coded picture:
 * { width, height, y, yStride, u, v, uStride, vStride } (I420) or { ..., uv, uvStride } (NV12).
 */
function readPatches(frame, H) {
  const { width: W, height: Hh } = frame
  const nv12 = Boolean(frame.uv)
  const chromaAt = (x, y) => {
    const cx = x >> 1
    const cy = y >> 1
    if (nv12) {
      const i = cy * frame.uvStride + cx * 2
      return [frame.uv[i], frame.uv[i + 1]]
    }
    return [frame.u[cy * frame.uStride + cx], frame.v[cy * frame.vStride + cx]]
  }
  const median = (arr) => {
    const s = [...arr].sort((p, q) => p - q)
    return s.length ? s[s.length >> 1] : NaN
  }
  const patches = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const Ys = []
      const Us = []
      const Vs = []
      let clipped = 0
      let outside = 0
      const steps = 9
      for (let i = 0; i < steps; i++) {
        for (let j = 0; j < steps; j++) {
          const u = (col + 0.5 + SAMPLE * ((i + 0.5) / steps - 0.5)) / COLS
          const v = (row + 0.5 + SAMPLE * ((j + 0.5) / steps - 0.5)) / ROWS
          const [fx, fy] = apply(H, u, v)
          const x = Math.round(fx)
          const y = Math.round(fy)
          if (x < 0 || y < 0 || x >= W || y >= Hh) {
            outside++
            continue
          }
          const Y = frame.y[y * frame.yStride + x]
          const [U, V] = chromaAt(x, y)
          if (Y >= 250 || Y <= 3) clipped++
          Ys.push(Y)
          Us.push(U)
          Vs.push(V)
        }
      }
      // size of the patch on screen: distance between the centres of neighbouring patches
      const c = apply(H, (col + 0.5) / COLS, (row + 0.5) / ROWS)
      const r = apply(H, (col + 1.5) / COLS, (row + 0.5) / ROWS)
      const d = apply(H, (col + 0.5) / COLS, (row + 1.5) / ROWS)
      const px = Math.min(Math.hypot(r[0] - c[0], r[1] - c[1]), Math.hypot(d[0] - c[0], d[1] - c[1]))
      patches.push({ Y: median(Ys), U: median(Us), V: median(Vs), clipped: clipped / (steps * steps), outside: outside / (steps * steps), px })
    }
  }
  return patches
}

// ---- scoring ------------------------------------------------------------------------------------------

/** Exposure factor k (on linear light) that best matches the grey patches, least squares in log. */
function fitExposure(measuredY, refY) {
  let s = 0
  let n = 0
  for (const p of EXPOSURE_GREYS) {
    const m = measuredY[p - 1]
    const r = refY[p - 1]
    if (m > 0 && r > 0) {
      s += Math.log(r / m)
      n++
    }
  }
  return n ? Math.exp(s / n) : 1
}

const labToY = ([L]) => fInv((L + 16) / 116)
const scaleLab = (lab, k) => {
  // scale linear light by k: through XYZ so the colour's chromaticity is kept
  const fy = (lab[0] + 16) / 116
  const xyz = [fInv(fy + lab[1] / 500), fInv(fy), fInv(fy - lab[2] / 200)].map((v) => v * k)
  const [fx, fyy, fz] = xyz.map(f)
  return [116 * fyy - 16, 500 * (fx - fyy), 200 * (fyy - fz)]
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)

/** Scores one orientation's patches against the chart. */
function score(patches, decode) {
  const measuredRaw = patches.map((p) => rgbToLab(yuvToRgb(p.Y, p.U, p.V, decode)))
  const refLab = COLORCHECKER_CLASSIC.map((c) => c.lab)
  const k = fitExposure(measuredRaw.map(labToY), refLab.map(labToY))
  const measured = measuredRaw.map((lab) => scaleLab(lab, k))
  const rows = COLORCHECKER_CLASSIC.map((c, i) => {
    const m = measured[i]
    const r = c.lab
    return {
      n: c.n,
      name: c.name,
      ref: r,
      measured: m,
      measuredRaw: measuredRaw[i],
      dE: deltaE2000(r, m),
      dERaw: deltaE2000(r, measuredRaw[i]),
      dL: m[0] - r[0],
      dC: chroma(m) - chroma(r),
      dh: chroma(r) > 10 && chroma(m) > 5 ? hueDiff(hueDeg(r), hueDeg(m)) : null,
      clipped: patches[i].clipped,
      outside: patches[i].outside,
      px: patches[i].px
    }
  })
  return { k, rows }
}

/**
 * The colour check. `frame`: coded planes (see readPatches); `corners`: four [x, y] points in
 * the frame's own pixels; `decode`: { range: 'full'|'limited', matrix: 'bt709'|'bt601' } of the
 * stream (TVT: full, bt709). Returns { ok, why?, orientation, patches, summary, problems }.
 */
export function checkColours(frame, corners, decode = { range: 'full', matrix: 'bt709' }) {
  const quad = orderCorners(corners)
  if (!quad) return { ok: false, why: 'Click the four outer corners of the chart’s colour squares (they must form a proper four-sided shape).' }
  // the right orientation is the one where the patches match the chart best
  let best = null
  for (const o of orientations(quad)) {
    const H = squareToQuad(o.corners)
    if (!H) continue
    const patches = readPatches(frame, H)
    if (patches.some((p) => !Number.isFinite(p.Y))) continue
    const s = score(patches, decode)
    const fit = mean(s.rows.map((r) => r.dE))
    if (!best || fit < best.fit) best = { fit, o, s }
  }
  if (!best) return { ok: false, why: 'The chart is (partly) outside the picture.' }
  const { rows, k } = best.s
  const problems = []
  const smallest = Math.min(...rows.map((r) => r.px))
  if (smallest < MIN_PATCH_PX) problems.push({ key: 'too-small', text: `The chart is too small in the picture (patches ${Math.round(smallest)} px wide; at least ${MIN_PATCH_PX} needed): bring it closer to the camera.`, fatal: true })
  if (rows.some((r) => r.outside > 0)) problems.push({ key: 'outside', text: 'Part of the chart is outside the picture.', fatal: true })
  const glare = rows.filter((r) => r.clipped > 0.2 && r.n !== 24)
  if (glare.length) problems.push({ key: 'clipped', text: `Glare or over-exposure on ${glare.map((r) => r.name).join(', ')}: tilt the chart away from the light (those patches are left out of the score).` })
  const greysChroma = rows.filter((r) => GREYS.includes(r.n)).map((r) => chroma(r.measured))
  if (mean(rows.filter((r) => SATURATED.includes(r.n)).map((r) => chroma(r.measured))) < 5) problems.push({ key: 'mono', text: 'The picture has no colour (black and white / infrared): check colours in daylight.', fatal: true })
  if (best.fit > 25) problems.push({ key: 'not-found', text: 'The squares don’t match a ColorChecker Classic: check the four corners were clicked on the chart’s outer squares.', fatal: true })

  const scored = rows.filter((r) => !(r.clipped > 0.2 && r.n !== 24))
  const colours = scored.filter((r) => r.n <= 18)
  const greys = scored.filter((r) => GREYS.includes(r.n) && r.n !== 19 && r.n !== 24)
  // white balance: the greys' average colour (a*, b*) is the cast
  const castA = mean(greys.map((r) => r.measured[1] - r.ref[1]))
  const castB = mean(greys.map((r) => r.measured[2] - r.ref[2]))
  // saturation: measured / reference chroma over the colour patches that are clearly coloured
  const sat = scored.filter((r) => r.n <= 18 && chroma(r.ref) > 20)
  const saturation = mean(sat.map((r) => chroma(r.measured))) / mean(sat.map((r) => chroma(r.ref)))
  // hue: average signed hue turn over the saturated patches
  const hueTurn = mean(scored.filter((r) => r.dh !== null && chroma(r.ref) > 30).map((r) => r.dh))
  // tone: slope of measured vs reference lightness on the greys (1 = right contrast)
  const g = scored.filter((r) => GREYS.includes(r.n))
  const mx = mean(g.map((r) => r.ref[0]))
  const my = mean(g.map((r) => r.measured[0]))
  const slope = g.reduce((s, r) => s + (r.ref[0] - mx) * (r.measured[0] - my), 0) / g.reduce((s, r) => s + (r.ref[0] - mx) ** 2, 0)
  const meanDE = mean(scored.map((r) => r.dE))
  const summary = {
    meanDE,
    meanDEColours: mean(colours.map((r) => r.dE)),
    meanDERaw: mean(scored.map((r) => r.dERaw)),
    maxDE: Math.max(...scored.map((r) => r.dE)),
    worst: [...scored].sort((p, q) => q.dE - p.dE).slice(0, 3).map((r) => r.name),
    grade: meanDE <= 3 ? 'excellent' : meanDE <= 6 ? 'good' : meanDE <= 10 ? 'fair' : 'poor',
    exposureStops: Math.log2(k) === 0 ? 0 : -Math.log2(k), // + = the picture is brighter than the chart would be
    cast: { a: castA, b: castB, size: Math.hypot(castA, castB), name: castName(castA, castB) },
    saturation, // 1 = right; below 1 = colours washed out, above 1 = over-saturated
    hueTurn, // degrees, + = colours turned anticlockwise (e.g. reds towards yellow)
    contrast: slope, // 1 = right; above 1 = too much contrast
    greyChroma: mean(greysChroma)
  }
  return {
    ok: !problems.some((p) => p.fatal),
    orientation: { turn: best.o.turn, mirrored: best.o.mirrored },
    patches: rows.map((r) => ({ ...r, refRgb: labToRgb(r.ref), measuredRgb: labToRgb(r.measured) })),
    summary,
    problems
  }
}

// ---- white or grey card (no chart needed) ------------------------------------------------------

const CARD_SAMPLES = 15 // per side: 225 points over the middle of the card
const CARD_INNER = 0.7 // the middle 70% of the card is read (its edges and fingers left out)

/**
 * A white sheet or grey card held in the camera's view, in daylight shade: its colour should be
 * neutral (a* = b* = 0), so what the camera shows is its colour cast. `corners`: the card's four
 * corners in the frame's own pixels. Returns { ok, why?, card: { L, a, b, spread, clipped },
 * cast: { a, b, size, name }, problems }. Office paper often contains optical brighteners that
 * look slightly blue in daylight, so a small blue reading can be the paper: said in the result.
 */
export function checkWhiteCard(frame, corners, decode = { range: 'full', matrix: 'bt709' }) {
  const quad = orderCorners(corners)
  if (!quad) return { ok: false, why: 'Click the four corners of the card (they must form a proper four-sided shape).' }
  const H = squareToQuad(quad)
  if (!H) return { ok: false, why: 'Click the four corners of the card.' }
  const { width: W, height: Hh } = frame
  const nv12 = Boolean(frame.uv)
  const labs = []
  let clipped = 0
  let outside = 0
  for (let i = 0; i < CARD_SAMPLES; i++) {
    for (let j = 0; j < CARD_SAMPLES; j++) {
      const u = 0.5 + CARD_INNER * ((i + 0.5) / CARD_SAMPLES - 0.5)
      const v = 0.5 + CARD_INNER * ((j + 0.5) / CARD_SAMPLES - 0.5)
      const [fx, fy] = apply(H, u, v)
      const x = Math.round(fx)
      const y = Math.round(fy)
      if (x < 0 || y < 0 || x >= W || y >= Hh) {
        outside++
        continue
      }
      const Y = frame.y[y * frame.yStride + x]
      const cx = x >> 1
      const cy = y >> 1
      const U = nv12 ? frame.uv[cy * frame.uvStride + cx * 2] : frame.u[cy * frame.uStride + cx]
      const V = nv12 ? frame.uv[cy * frame.uvStride + cx * 2 + 1] : frame.v[cy * frame.vStride + cx]
      if (Y >= 250) clipped++
      labs.push(rgbToLab(yuvToRgb(Y, U, V, decode)))
    }
  }
  const total = CARD_SAMPLES * CARD_SAMPLES
  const problems = []
  if (outside > 0) problems.push({ key: 'outside', text: 'Part of the card is outside the picture.', fatal: true })
  if (!labs.length) return { ok: false, why: 'The card is outside the picture.', problems }
  const side = Math.min(...[[0, 1], [1, 2], [2, 3], [3, 0]].map(([p, q]) => Math.hypot(quad[p][0] - quad[q][0], quad[p][1] - quad[q][1])))
  if (side < 24) problems.push({ key: 'too-small', text: `The card is too small in the picture (${Math.round(side)} px): bring it closer to the camera.`, fatal: true })
  const med = (k) => {
    const s = labs.map((l) => l[k]).sort((p, q) => p - q)
    return s[s.length >> 1]
  }
  const L = med(0)
  const a = med(1)
  const b = med(2)
  const Ls = labs.map((l) => l[0]).sort((p, q) => p - q)
  const spread = Ls[Math.floor(Ls.length * 0.9)] - Ls[Math.floor(Ls.length * 0.1)]
  if (clipped / total > 0.2) problems.push({ key: 'clipped', text: 'The card is over-exposed (pure white on screen), so its colour can’t be read: hold it in shade, or use a grey card.', fatal: true })
  if (spread > 8) problems.push({ key: 'uneven', text: `The light on the card is uneven (lightness varies by ${spread.toFixed(0)}): hold it flat, out of shadows and reflections.` })
  if (L < 25) problems.push({ key: 'dark', text: 'The card is very dark in the picture: check in daylight, or bring it closer.', fatal: true })
  const cast = { a, b, size: Math.hypot(a, b), name: castName(a, b) }
  // bright office paper typically reads b* -5 to -8 in daylight (its brighteners glow blue in UV)
  if (cast.size >= 2 && b < 0 && b > -9 && Math.abs(a) < 3) problems.push({ key: 'brightener', text: 'A blue reading can come from the paper itself (optical brighteners in office paper): a grey card gives a surer answer.' })
  return {
    ok: !problems.some((p) => p.fatal),
    card: { L, a, b, spread, clipped: clipped / total, rgb: labToRgb([L, a, b]) },
    cast,
    // same rough scale as the chart: under ~2 neutral, 2-5 slight, 5-10 clear, above 10 strong
    verdict: cast.size < 2 ? 'neutral' : cast.size < 5 ? 'slight cast' : cast.size < 10 ? 'clear cast' : 'strong cast',
    problems
  }
}

/** White balance suggestions from a white card check (optional, as for the chart). */
export function whiteCardSuggestions(result, fields) {
  if (!result?.ok || result.cast.size < 3) return []
  return colourSuggestions({ ok: true, summary: { cast: result.cast } }, fields).filter((s) => s.path.startsWith('whiteBalance'))
}

function castName(a, b) {
  if (Math.hypot(a, b) < 2) return 'neutral'
  const angle = (deg(Math.atan2(b, a)) + 360) % 360
  // a*+ = red/magenta, b*+ = yellow, a*- = green, b*- = blue
  const names = ['red', 'orange', 'yellow', 'yellow-green', 'green', 'cyan', 'blue', 'purple']
  return names[Math.round(angle / 45) % 8]
}

/**
 * Suggested changes from a colour check, for the camera's own settings (the panel's field list:
 * { path, kind, value, min, max, default, options }). All optional: they are filled into the
 * panel for the admin to apply, then the chart is checked again. Only settings the camera has.
 */
export function colourSuggestions(result, fields) {
  if (!result?.ok) return []
  const by = new Map(fields.map((x) => [x.path, x]))
  const out = []
  const add = (path, to, why) => {
    const x = by.get(path)
    if (!x) return
    if (x.kind === 'range') to = Math.max(x.min, Math.min(x.max, Math.round(to)))
    if (x.kind === 'select' && !x.options?.includes(to)) return
    if (String(x.value) === String(to)) return
    out.push({ path, label: x.label ?? path, from: x.value, to, why, optional: true })
  }
  const s = result.summary
  const step = (x) => (x.max - x.min) / 20 // a small step on the camera's own scale
  const wb = by.get('whiteBalance.mode')
  if (s.cast.size >= 3 && wb) {
    if (wb.value !== 'auto' && wb.value !== 'manual') add('whiteBalance.mode', 'auto', `The greys have a ${s.cast.name} cast (${s.cast.size.toFixed(1)}); white balance is set to "${wb.value}".`)
    else if (wb.value === 'manual') {
      const red = by.get('whiteBalance.red')
      const blue = by.get('whiteBalance.blue')
      // a* > 0: too red; b* > 0: too yellow (not enough blue)
      if (red) add('whiteBalance.red', red.value - Math.sign(s.cast.a) * Math.min(3, Math.ceil(Math.abs(s.cast.a) / 2)) * step(red), `The greys lean ${s.cast.a > 0 ? 'red' : 'green'}: ${s.cast.a > 0 ? 'less' : 'more'} red gain.`)
      if (blue) add('whiteBalance.blue', blue.value + Math.sign(s.cast.b) * Math.min(3, Math.ceil(Math.abs(s.cast.b) / 2)) * step(blue), `The greys lean ${s.cast.b > 0 ? 'yellow' : 'blue'}: ${s.cast.b > 0 ? 'more' : 'less'} blue gain.`)
    }
  }
  const sat = by.get('saturation')
  if (sat && Number.isFinite(s.saturation) && Math.abs(s.saturation - 1) >= 0.1) {
    // about one step per 10% off, at most three; checked again afterwards
    const steps = Math.min(3, Math.round(Math.abs(s.saturation - 1) / 0.1))
    add('saturation', sat.value + (s.saturation < 1 ? 1 : -1) * steps * step(sat), `Colours are ${Math.round(Math.abs(s.saturation - 1) * 100)}% ${s.saturation < 1 ? 'weaker' : 'stronger'} than on the chart.`)
  }
  const hue = by.get('hue')
  if (hue && Number.isFinite(s.hueTurn) && Math.abs(s.hueTurn) >= 5) {
    add('hue', hue.value - Math.sign(s.hueTurn) * Math.min(2, Math.round(Math.abs(s.hueTurn) / 5)) * step(hue), `Colours are turned by ${s.hueTurn.toFixed(0)}° on average.`)
  }
  const con = by.get('contrast')
  if (con && Number.isFinite(s.contrast) && Math.abs(s.contrast - 1) >= 0.1) {
    add('contrast', con.value + (s.contrast < 1 ? 1 : -1) * Math.min(2, Math.round(Math.abs(s.contrast - 1) / 0.1)) * step(con), `The grey steps show ${s.contrast < 1 ? 'too little' : 'too much'} contrast (${s.contrast.toFixed(2)}×).`)
  }
  return out
}
