// Simulated camera pictures for the colour check: a ColorChecker Classic or a white/grey card
// drawn in perspective into a coded I420 frame (full range, BT.709, as TVT cameras code), with
// known faults added. Shared by the offline tests (test/colour-check.test.mjs) and the practice
// page (colour-check-demo.html), so both exercise exactly the same pictures.
//
// Pure and DOM-free. Frames have the shape colour-check.js reads:
// { width, height, y, yStride, u, uStride, v, vStride }.
import { COLORCHECKER_CLASSIC, labToRgb, squareToQuad } from './colour-check.js'

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const enc = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055)
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)))
// gamma-encoded R'G'B' (0-1) -> full-range BT.709 Y'CbCr sample values
const code = ([r, g, b]) => {
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return [Y * 255, 128 + ((b - Y) / 1.8556) * 255, 128 + ((r - Y) / 1.5748) * 255]
}

/** 3x3 inverse of a homography as squareToQuad returns it: frame pixel -> unit square. */
export function invert(H) {
  const m = [[H.a, H.b, H.c], [H.d, H.e, H.f], [H.g, H.h, 1]]
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  const inv = [
    [A, -(b * i - c * h), b * f - c * e],
    [B, a * i - c * g, -(a * f - c * d)],
    [C, -(a * h - b * g), a * e - b * d]
  ].map((r) => r.map((v) => v / det))
  return (x, y) => {
    const w = inv[2][0] * x + inv[2][1] * y + inv[2][2]
    return [(inv[0][0] * x + inv[0][1] * y + inv[0][2]) / w, (inv[1][0] * x + inv[1][1] * y + inv[1][2]) / w]
  }
}

/**
 * A blank W x H I420 frame. `background`: a luma value (flat grey, as the tests use), or
 * (x, y) => [Y, U, V] for a scene behind the chart (the practice page).
 */
function blank(W, H, background) {
  const cw = W / 2
  const ch = H / 2
  const y = new Uint8Array(W * H)
  const u = new Uint8Array(cw * ch).fill(128)
  const v = new Uint8Array(cw * ch).fill(128)
  if (typeof background === 'function') {
    for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) y[py * W + px] = clamp(background(px, py)[0])
    for (let py = 0; py < ch; py++) {
      for (let px = 0; px < cw; px++) {
        const p = background(2 * px + 1, 2 * py + 1)
        u[py * cw + px] = clamp(p[1])
        v[py * cw + px] = clamp(p[2])
      }
    }
  } else y.fill(background)
  return { width: W, height: H, y, yStride: W, u, uStride: cw, v, vStride: cw }
}

/** Paints `at(px, py)` ([Y, U, V], or null to leave the pixel) into a frame, luma then chroma. */
function paint(frame, at) {
  const { width: W, height: H, y, u, v } = frame
  const cw = W / 2
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const p = at(px, py)
      if (p) y[py * W + px] = clamp(p[0])
    }
  }
  // chroma is 4:2:0: one sample per 2x2 block, taken at the block's middle
  for (let py = 0; py < H / 2; py++) {
    for (let px = 0; px < cw; px++) {
      const p = at(2 * px + 1, 2 * py + 1)
      if (p) {
        u[py * cw + px] = clamp(p[1])
        v[py * cw + px] = clamp(p[2])
      }
    }
  }
  return frame
}

/**
 * A W x H I420 frame with the chart drawn so that the chart's patch area corners (as printed
 * upright: top-left, top-right, bottom-right, bottom-left) land on `corners`. `look` changes
 * each patch's linear RGB (camera faults); `mono` codes no colour (a black-and-white camera);
 * `glare` (a 0-based patch index) paints a pure white stripe across that patch. Patches fill 80%
 * of their cell, black between. `border` (in cells, default none) adds the black surround a
 * real chart has outside the patch area; `background` as for blank().
 */
export function drawChart({ corners, W = 1920, H = 1080, look = (rgb) => rgb, mono = false, glare = null, border = 0, background = 110 }) {
  const toChart = invert(squareToQuad(corners))
  const colour = COLORCHECKER_CLASSIC.map((c) => {
    const rgb = look(labToRgb(c.lab).map(lin)).map(enc)
    const [Y, U, V] = code(rgb)
    return mono ? [Y, 128, 128] : [Y, U, V]
  })
  const bu = border / 6
  const bv = border / 4
  const at = (px, py) => {
    const [uu, vv] = toChart(px, py)
    if (uu < -bu || uu >= 1 + bu || vv < -bv || vv >= 1 + bv) return null
    if (uu < 0 || uu >= 1 || vv < 0 || vv >= 1) return [20, 128, 128] // the chart's black surround
    const col = Math.floor(uu * 6)
    const row = Math.floor(vv * 4)
    const fu = uu * 6 - col
    const fv = vv * 4 - row
    if (fu < 0.1 || fu > 0.9 || fv < 0.1 || fv > 0.9) return [20, 128, 128] // black between patches
    const n = row * 6 + col
    if (glare !== null && n === glare && fu > 0.3 && fu < 0.7) return [255, 128, 128]
    return colour[n]
  }
  return paint(blank(W, H, background), at)
}

/**
 * A card (one colour, given as gamma-encoded sRGB 0-1) in a W x H I420 frame, its corners on
 * `corners`; `gradient` darkens it from one side to the other (uneven light, 0 = even).
 */
export function drawCard({ corners, rgb, W = 1920, H = 1080, gradient = 0, background = 90 }) {
  const toCard = invert(squareToQuad(corners))
  const at = (px, py) => {
    const [uu, vv] = toCard(px, py)
    if (uu < 0 || uu >= 1 || vv < 0 || vv >= 1) return null
    return code(rgb.map((x) => Math.min(1, x * (1 - gradient * uu))))
  }
  return paint(blank(W, H, background), at)
}

/**
 * The frame as the browser would show it: RGBA bytes, for putting on a canvas with ImageData.
 * `shown`: how the browser converts it. The default, full-range BT.709, is what the app's display
 * does with the range fix; { range: 'limited' } is what a browser does without it, going by TVT's
 * limited-range flag (the ends of the range are cut off and the rest stretched).
 */
export function frameToRGBA(frame, shown = { range: 'full', matrix: 'bt709' }) {
  const { width: W, height: H, y, u, v, yStride, uStride, vStride } = frame
  const limited = shown.range === 'limited'
  const [kr, kb] = shown.matrix === 'bt601' ? [0.299, 0.114] : [0.2126, 0.0722]
  const out = new Uint8ClampedArray(W * H * 4)
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      // as 0-255 R'G'B' (a Uint8ClampedArray rounds and cuts off what falls outside)
      const Y = limited ? ((y[py * yStride + px] - 16) * 255) / 219 : y[py * yStride + px]
      const cb = (u[(py >> 1) * uStride + (px >> 1)] - 128) * (limited ? 255 / 224 : 1)
      const cr = (v[(py >> 1) * vStride + (px >> 1)] - 128) * (limited ? 255 / 224 : 1)
      const r = Y + 2 * (1 - kr) * cr
      const b = Y + 2 * (1 - kb) * cb
      const i = (py * W + px) * 4
      out[i] = r
      out[i + 1] = (Y - kr * r - kb * b) / (1 - kr - kb)
      out[i + 2] = b
      out[i + 3] = 255
    }
  }
  return out
}
