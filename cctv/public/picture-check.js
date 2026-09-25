// "Auto adjust": measures a camera's live picture (the suggestions are in auto-adjust.js).
//
// These are rules of thumb, not a calibration. There is no colour chart in view, so the colour
// figures say whether things that should be grey come out neutral ("neutral balance"), not
// whether colour is accurate. Suggestions are for the light at the moment of measuring.
//
// What is measured (Measurer): the CODED planes of the video, as VideoFrame.copyTo() gives
// them (I420 or NV12), with no range or matrix conversion. TVT cameras flag their video as
// limited range (16-235) but code the full 0-255 range (Y reaches 0 on every TVT clip, with
// no pile-up at 16), so what a browser shows through its limited-range conversion clips
// shadows and highlights that the camera did record (Wharf OB West: 5.37% black on screen,
// 0.03% in the coded values). Exposure is therefore measured on the coded values, and the
// "as displayed" figures are worked out from them for the range the display uses.
//
// Noise (plan D2): temporal, frame against frame over still blocks, at native resolution,
// with the two frames 6 apart and at least 6 frames after a keyframe (the frame just after a
// keyframe differs from its neighbours for reasons that are not grain). The panel grabs
// keyframe +6, +12, +18, +24 in two keyframe intervals in a row (sets A and B): the noise
// figure is the smallest of a set's pairs, and |A - B| is how repeatable it is.
//
// The per-frame work runs in a Worker (picture-worker.js) on frames the browser already
// decoded; measureFrame()/combine() are the same measurement on an ImageData (RGBA as the
// browser shows it), for the lab harness.

const SAMPLES = 300_000 // pixels looked at per frame for the brightness and colour statistics
const r3 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000)
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const median = (a) => {
  if (!a.length) return null
  const s = Float64Array.from(a).sort()
  return s[s.length >> 1]
}
const pctl = (a, p) => {
  if (!a.length) return null
  const s = Float64Array.from(a).sort()
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)

/** Evidence for these is in the plan (§4.4): coded-plane runs on the dusk and night clips. */
export const MONO_NEUTRAL = 0.9 // share of chroma samples within 1 of neutral: IR clips read 1.000, colour at most 0.491
export const NOISE = {
  GRID_X: 96, // 16x16 blocks sampled on a 96x54 grid, native pixels
  GRID_Y: 54,
  BLOCK: 16,
  GAP: 6, // frames between the two frames of a pair
  AFTER_KEY: 6, // first frame of a pair at least this many frames after a keyframe
  SKIP_MAX: 0.8, // more still blocks than this repeated exactly: the encoder skips them, no grain to see
  MIN_WIDTH: 1920 // narrower pictures give other figures (same scene: s=1 about 2x s=2): not comparable
}
/** Provisional bands, native scale, gap 6, min over pairs (plan §4.4); they drive optional suggestions only. */
export const NOISE_BANDS = { high: 0.8, some: 0.55 }
export const COLOUR = { CAST: 0.08, CAST_DISAGREE: 0.12, ZONE_SPREAD: 0.3, NEUTRAL_SHARE: 0.5 }

// Kr, Kb per matrix. 'rgb' is what a browser may report for TVT's 0/0/0 colour description:
// it can't be meant (4:2:0 video can't use the identity matrix), so it counts as the default.
const MATRICES = { bt709: [0.2126, 0.0722], bt601: [0.299, 0.114], bt2020: [0.2627, 0.0593] }
/** The Measurer's name for a VideoColorSpace matrix (or one of its own names). */
export function matrixName(m) {
  if (m === 'bt470bg' || m === 'smpte170m' || m === 'bt601') return 'bt601'
  if (m === 'bt2020-ncl' || m === 'bt2020') return 'bt2020'
  return 'bt709'
}

// ---- helpers on a luma plane ------------------------------------------------

/** Connected blobs (8-neighbour) of the set cells of a mask. */
function components(mask, bw, bh) {
  const seen = new Uint8Array(mask.length)
  const out = []
  const stack = []
  for (let j = 0; j < mask.length; j++) {
    if (!mask[j] || seen[j]) continue
    stack.length = 0
    stack.push(j)
    seen[j] = 1
    const c = { n: 0, x0: bw, y0: bh, x1: -1, y1: -1, list: [] }
    while (stack.length) {
      const k = stack.pop()
      const x = k % bw
      const y = (k - x) / bw
      c.n++
      c.list.push(k)
      if (x < c.x0) c.x0 = x
      if (y < c.y0) c.y0 = y
      if (x > c.x1) c.x1 = x
      if (y > c.y1) c.y1 = y
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= bh) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= bw) continue
          const q = yy * bw + xx
          if (mask[q] && !seen[q]) {
            seen[q] = 1
            stack.push(q)
          }
        }
      }
    }
    out.push(c)
  }
  return out
}

let planeBuf = null // the exposure plane: reused, nothing keeps it after a frame is measured

/** Luma at analysis scale s: 2x2 box mean when s = 2 (pictures 2560 wide and more), else a copy. */
function lumaPlane(y, stride, W, H, s) {
  const w = Math.floor(W / s)
  const h = Math.floor(H / s)
  if (!planeBuf || planeBuf.length < w * h) planeBuf = new Float32Array(w * h)
  const L = planeBuf
  if (s === 1) {
    for (let r = 0; r < h; r++) {
      const o = r * stride
      const q = r * w
      for (let x = 0; x < w; x++) L[q + x] = y[o + x]
    }
  } else {
    for (let r = 0; r < h; r++) {
      let a = 2 * r * stride
      let b = a + stride
      const q = r * w
      for (let x = 0; x < w; x++, a += 2, b += 2) L[q + x] = (y[a] + y[a + 1] + y[b] + y[b + 1]) * 0.25
    }
  }
  return { L, w, h }
}

/** Coded Y as it is, on a sparse grid, with nothing masked (range checks, the display self-check). */
function nativeStats(y, stride, W, H) {
  const step = Math.max(1, Math.round(Math.sqrt((W * H) / SAMPLES)))
  let n = 0
  let le4 = 0
  let le16 = 0
  let ge235 = 0
  let ge251 = 0
  let min = 255
  let max = 0
  for (let r = 0; r < H; r += step) {
    const o = r * stride
    for (let x = 0; x < W; x += step) {
      const v = y[o + x]
      n++
      if (v <= 4) le4++
      if (v <= 16) le16++
      if (v >= 235) ge235++
      if (v >= 251) ge251++
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  return { min, max, le4: le4 / n, le16: le16 / n, ge235: ge235 / n, ge251: ge251 / n }
}

/** OSD text lines in the top/bottom 15% (white glyphs with an outline on both sides). Plane units. */
function osdMask(L, w, h) {
  const t = Math.max(6, Math.round(h / 120))
  const reach = Math.max(2, Math.round(h / 300))
  const tw = Math.ceil(w / t)
  const th = Math.ceil(h / t)
  const cnt = new Uint16Array(tw * th)
  const band = Math.round(0.15 * h)
  const scan = (y0, y1) => {
    for (let y = Math.max(reach, y0); y < Math.min(h - reach, y1); y++) {
      const row = y * w
      const trow = ((y / t) | 0) * tw
      for (let x = reach; x < w - reach; x++) {
        const i = row + x
        if (L[i] < 210) continue
        let a = false
        let b = false
        let c = false
        let d = false
        for (let k = 1; k <= reach; k++) {
          if (L[i - k] <= 60) a = true
          if (L[i + k] <= 60) b = true
          if (L[i - k * w] <= 60) c = true
          if (L[i + k * w] <= 60) d = true
        }
        if ((a && b) || (c && d)) cnt[trow + ((x / t) | 0)]++
      }
    }
  }
  scan(0, band)
  scan(h - band, h)
  const minCount = Math.max(3, Math.round(t * t * 0.04))
  const cand = new Uint8Array(tw * th)
  const link = new Uint8Array(tw * th)
  for (let j = 0; j < cand.length; j++) if (cnt[j] >= minCount) cand[j] = 1
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) if (cand[y * tw + x]) for (let dx = -2; dx <= 2; dx++) if (x + dx >= 0 && x + dx < tw) link[y * tw + x + dx] = 1
  const mask = new Uint8Array(tw * th)
  const boxes = []
  for (const c of components(link, tw, th)) {
    let real = 0
    for (const k of c.list) real += cand[k]
    const hp = (c.y1 - c.y0 + 1) * t
    const wp = (c.x1 - c.x0 + 1) * t
    if (real < 4 || hp > 0.06 * h || wp < 3 * hp) continue
    boxes.push([r3((c.x0 * t) / w), r3((c.y0 * t) / h), r3(Math.min(1, ((c.x1 + 1) * t) / w)), r3(Math.min(1, ((c.y1 + 1) * t) / h))])
    for (let y = Math.max(0, c.y0 - 1); y <= Math.min(th - 1, c.y1 + 1); y++) for (let x = Math.max(0, c.x0 - 1); x <= Math.min(tw - 1, c.x1 + 1); x++) mask[y * tw + x] = 1
  }
  return { boxes, at: (x, y) => mask[((y / t) | 0) * tw + ((x / t) | 0)] === 1 }
}

/**
 * Exposure on the coded luma plane. Clipped cells (more than half the samples at 250 or more)
 * form blobs: on the OSD (text), small ones (light sources: lamps, under 0.15% each, left out of
 * the figures with a margin of 2 cells), large ones low in an infrared picture or at its edge
 * (near: infrared glare off something close to the camera), and the rest (surface: overlit
 * areas, lost detail).
 */
function exposure(L, w, h, osd, mono, displayRange) {
  const cell = Math.max(4, Math.round(h / 135))
  const cw = Math.floor(w / cell)
  const ch = Math.floor(h / cell)
  const clip = new Uint8Array(cw * ch)
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let c = 0
      let n = 0
      for (let y = cy * cell; y < (cy + 1) * cell; y += 2) {
        for (let x = cx * cell; x < (cx + 1) * cell; x += 2) {
          n++
          if (L[y * w + x] >= 250) c++
        }
      }
      if (c * 2 > n) clip[cy * cw + cx] = 1
    }
  }
  const excl = new Uint8Array(cw * ch)
  const sum = { surface: 0, near: 0, light: 0, lights: 0, text: 0 }
  const tot = cw * ch
  for (const c of components(clip, cw, ch)) {
    let inO = 0
    for (const k of c.list) if (osd.at((k % cw) * cell + (cell >> 1), ((k / cw) | 0) * cell + (cell >> 1))) inO++
    const area = c.n / tot
    if (inO * 2 >= c.n) {
      sum.text += area
      for (const k of c.list) excl[k] = 1
      continue
    }
    const edge = c.x0 === 0 || c.x1 === cw - 1 || c.y1 === ch - 1
    if (area < 0.0015) {
      sum.light += area
      sum.lights++
      for (const k of c.list) {
        const x = k % cw
        const y = (k - x) / cw
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (x + dx >= 0 && y + dy >= 0 && x + dx < cw && y + dy < ch) excl[(y + dy) * cw + x + dx] = 1
      }
    } else if (mono && area >= 0.005 && (edge || (c.y0 + c.y1) / 2 / ch > 0.6)) sum.near += area
    else sum.surface += area
  }
  const excluded = (x, y) => {
    if (osd.at(x, y)) return true
    const cx = (x / cell) | 0
    const cy = (y / cell) | 0
    return cx < cw && cy < ch && excl[cy * cw + cx] === 1
  }
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / SAMPLES)))
  const hist = new Float64Array(256)
  let n = 0
  let sumY = 0
  let wsum = 0
  let wY = 0
  // centre weight: a Gaussian over the middle of the picture, separable in x and y
  const gauss = (t) => Math.exp(-0.5 * ((t - 0.5) / 0.35) ** 2)
  const wx = new Float32Array(Math.ceil(w / step))
  for (let x = 0, i = 0; x < w; x += step, i++) wx[i] = gauss(x / w)
  for (let y = 0; y < h; y += step) {
    const ky = gauss(y / h)
    const row = y * w
    for (let x = 0, i = 0; x < w; x += step, i++) {
      if (excluded(x, y)) continue
      const v = L[row + x]
      n++
      sumY += v
      hist[v | 0]++
      const k = ky * wx[i]
      wsum += k
      wY += k * v
    }
  }
  n = Math.max(1, n)
  const share = (a, b) => {
    let t = 0
    for (let v = a; v <= b; v++) t += hist[v]
    return t / n
  }
  const pct = (p) => {
    let acc = 0
    for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= p * n) return v
    return 255
  }
  const p1 = pct(0.01)
  const p99 = pct(0.99)
  const fig = {
    mean: sumY / n,
    centre: wsum ? wY / wsum : sumY / n,
    p1,
    p50: pct(0.5),
    p99,
    spread: p99 - p1,
    black: share(0, 4),
    white: share(251, 255),
    clip: sum,
    excluded
  }
  // as displayed: a limited-range display maps 16 -> 0 and 235 -> 255 and clips beyond; pure
  // black and white are then what shows as <= 4 and >= 251, like the coded figures (coded <= 19
  // and >= 232: Wharf OB West shows 5.8% black through the browser's path, Y <= 16 alone 3.2%)
  if (displayRange === 'limited') {
    const d = (v) => Math.max(0, Math.min(255, ((v - 16) * 255) / 219))
    let m = 0
    let black = 0
    let white = 0
    for (let v = 0; v < 256; v++) {
      m += d(v) * hist[v]
      if (d(v) <= 4) black += hist[v]
      if (d(v) >= 251) white += hist[v]
    }
    fig.display = { mean: m / n, p1: d(p1), p99: d(p99), spread: d(p99) - d(p1), black: black / n, white: white / n }
  } else fig.display = { mean: fig.mean, p1, p99, spread: fig.spread, black: fig.black, white: fig.white }
  return fig
}

// ---- chroma -----------------------------------------------------------------

/** Uniform access to I420 (three planes) and NV12 (interleaved UV) chroma, 4:2:0. */
function chromaOf(p) {
  const cw = Math.ceil(p.width / 2)
  const ch = Math.ceil(p.height / 2)
  if (p.uv) return { cw, ch, u: p.uv, v: p.uv, uStride: p.uvStride ?? 2 * cw, vStride: p.uvStride ?? 2 * cw, step: 2, uOff: 0, vOff: 1 }
  return { cw, ch, u: p.u, v: p.v, uStride: p.uStride ?? cw, vStride: p.vStride ?? cw, step: 1, uOff: 0, vOff: 0 }
}

/** Share of chroma samples within 1 of neutral (128): 1.000 on infrared pictures. */
function neutralChroma(c) {
  const step = Math.max(1, Math.round(Math.sqrt((c.cw * c.ch) / 100_000)))
  let n = 0
  let k = 0
  for (let y = 0; y < c.ch; y += step) {
    for (let x = 0; x < c.cw; x += step) {
      const u = c.u[y * c.uStride + x * c.step + c.uOff] - 128
      const v = c.v[y * c.vStride + x * c.step + c.vOff] - 128
      n++
      if (u >= -1 && u <= 1 && v >= -1 && v <= 1) k++
    }
  }
  return n ? k / n : 0
}

/**
 * Colour cast in the display's own matrix and range (what the viewer sees): neutral pixels
 * (saturation < 0.25), grey-edge, brightest 5% of the neutral pixels, and neutral pixels per
 * zone of a 3x3 grid. Three estimators that agree show consistent lighting, not accuracy.
 */
function colour(p, c, excluded, s, matrix, range) {
  const [kr, kb] = MATRICES[matrixName(matrix)]
  const kg = 1 - kr - kb
  const lim = range === 'limited'
  const ys = lim ? 255 / 219 : 1
  const cs = lim ? 255 / 224 : 1
  const yo = lim ? 16 : 0
  const W = p.width
  const H = p.height
  const step = Math.max(1, Math.round(Math.sqrt((c.cw * c.ch) / SAMPLES)))
  const nx = Math.floor((c.cw - 1) / step) + 1
  const prev = new Float32Array(3 * nx) // RGB of the previous sample row (grey-edge)
  const np = [0, 0, 0, 0]
  const ge = [0, 0, 0, 0]
  const zone = Array.from({ length: 9 }, () => [0, 0, 0, 0])
  const hist = new Float64Array(256) // neutral pixels by luma, with their R, G, B sums (brightest 5%)
  const byY = new Float64Array(3 * 256)
  let satSum = 0
  let satN = 0
  let clipN = 0
  let seen = 0
  for (let row = 0, cy = 0; cy < c.ch; row++, cy += step) {
    const py = Math.min(H - 1, 2 * cy)
    const zy = Math.min(2, ((3 * py) / H) | 0)
    let lr = 0
    let lg = 0
    let lb = 0
    for (let col = 0, cx = 0; cx < c.cw; col++, cx += step) {
      const px = Math.min(W - 1, 2 * cx)
      const Yd = (p.y[py * p.yStride + px] - yo) * ys
      const cb = (c.u[cy * c.uStride + cx * c.step + c.uOff] - 128) * cs
      const cr = (c.v[cy * c.vStride + cx * c.step + c.vOff] - 128) * cs
      let r = Yd + 2 * (1 - kr) * cr
      let b = Yd + 2 * (1 - kb) * cb
      let g = (Yd - kr * r - kb * b) / kg
      r = r < 0 ? 0 : r > 255 ? 255 : r
      g = g < 0 ? 0 : g > 255 ? 255 : g
      b = b < 0 ? 0 : b > 255 ? 255 : b
      const j = 3 * col
      const ur = prev[j]
      const ug = prev[j + 1]
      const ub = prev[j + 2]
      prev[j] = r
      prev[j + 1] = g
      prev[j + 2] = b
      const hasLeft = col > 0
      const hasUp = row > 0
      const leftR = lr
      const leftG = lg
      const leftB = lb
      lr = r
      lg = g
      lb = b
      if (excluded((px / s) | 0, (py / s) | 0)) continue
      seen++
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b
      const Y = kr * r + kg * g + kb * b
      // one colour at its limit in a pixel of middling brightness: a colour too strong to show
      // (lamps and lamp-lit surfaces clip from exposure, which saturation can't fix)
      if (mx >= 254 && mn < 200 && Y < 170) clipN++
      if (mx >= 250 || Y < 24 || Y > 235) continue
      const sat = (mx - mn) / mx
      satSum += sat
      satN++
      if (sat < 0.25) {
        np[0] += r
        np[1] += g
        np[2] += b
        np[3]++
        const z = zone[zy * 3 + Math.min(2, ((3 * px) / W) | 0)]
        z[0] += r
        z[1] += g
        z[2] += b
        z[3]++
        const bin = Y | 0
        hist[bin]++
        byY[3 * bin] += r
        byY[3 * bin + 1] += g
        byY[3 * bin + 2] += b
      }
      if (hasLeft && hasUp) {
        ge[0] += Math.abs(r - leftR) + Math.abs(r - ur)
        ge[1] += Math.abs(g - leftG) + Math.abs(g - ug)
        ge[2] += Math.abs(b - leftB) + Math.abs(b - ub)
        ge[3]++
      }
    }
  }
  const cast = (q) => (q[3] > 50 && q[0] > 0 && q[1] > 0 && q[2] > 0 ? { r: Math.log2(q[0] / q[1]), b: Math.log2(q[2] / q[1]), n: q[3] } : null)
  let thr = 255
  let acc = 0
  for (let v = 255; v >= 0; v--) {
    if ((acc += hist[v]) >= 0.05 * np[3]) {
      thr = v
      break
    }
  }
  const bn = [0, 0, 0, 0]
  for (let v = thr; v < 256; v++) {
    bn[0] += byY[3 * v]
    bn[1] += byY[3 * v + 1]
    bn[2] += byY[3 * v + 2]
    bn[3] += hist[v]
  }
  const zones = zone.map(cast)
  const zc = zones.filter(Boolean)
  const zoneSpread = (key) => (zc.length >= 4 ? Math.max(...zc.map((q) => q[key])) - Math.min(...zc.map((q) => q[key])) : null)
  const NP = cast(np)
  const GE = cast(ge)
  const BN = cast(bn)
  const est = [NP, GE, BN].filter(Boolean)
  const disagreement = est.length === 3 ? Math.max(...['r', 'b'].map((k) => Math.max(...est.map((e) => e[k])) - Math.min(...est.map((e) => e[k])))) : null
  return {
    saturation: satN ? satSum / satN : 0,
    colourClip: seen ? clipN / seen : 0,
    neutral: NP,
    greyEdge: GE,
    brightNeutral: BN,
    zones,
    zoneSpread: { r: zoneSpread('r'), b: zoneSpread('b') },
    disagreement,
    neutralShare: satN ? np[3] / satN : 0
  }
}

// ---- edges ------------------------------------------------------------------

/**
 * Native rows and columns (every H/135-th): edge rise (10-90%) and overshoot (halo) for focus
 * and sharpening, and the block-grid discontinuity (compression) index.
 */
function lines(y, stride, W, H, excluded, s) {
  const k = Math.max(4, Math.round(H / 135))
  const rise = []
  const over = []
  const bs = new Float64Array(64)
  const bn = new Float64Array(64)
  const run = (buf, len, fixed, isRow) => {
    // block grid: |first difference| by position mod 64 where both neighbours are smooth
    for (let q = 2; q < len - 1; q++) {
      const dl = buf[q - 1] - buf[q - 2]
      const dr = buf[q + 1] - buf[q]
      if (dl < 2.5 && dl > -2.5 && dr < 2.5 && dr > -2.5) {
        const d = buf[q] - buf[q - 1]
        bs[q & 63] += d < 0 ? -d : d
        bn[q & 63]++
      }
    }
    let prevG = 0
    let prevPrevG = 0
    for (let q = 24; q < len - 24; q++) {
      const g = buf[q + 1] - buf[q - 1]
      const ag = prevG < 0 ? -prevG : prevG
      if (ag >= 8 && ag >= Math.abs(prevPrevG) && ag > Math.abs(g)) {
        const c = q - 1
        const px = isRow ? c : fixed
        const py = isRow ? fixed : c
        if (!excluded((px / s) | 0, (py / s) | 0)) {
          const sg = prevG > 0 ? 1 : -1
          let a = 0
          while (a < 16 && sg * (buf[c - a] - buf[c - a - 1]) > 0) a++
          let b = 0
          while (b < 16 && sg * (buf[c + b + 1] - buf[c + b]) > 0) b++
          const lo = buf[c - a]
          const hi = buf[c + b]
          const st = sg * (hi - lo)
          if (st >= 30 && a < 16 && b < 16 && lo > 2 && hi > 2 && lo < 253 && hi < 253) {
            const t1 = lo + sg * 0.1 * st
            const t9 = lo + sg * 0.9 * st
            let p1 = null
            let p9 = null
            for (let j = -a; j < b; j++) {
              const v0 = buf[c + j]
              const v1 = buf[c + j + 1]
              if (p1 === null && sg * (v1 - t1) >= 0 && sg * (v0 - t1) < 0) p1 = j + (t1 - v0) / (v1 - v0)
              if (p9 === null && sg * (v1 - t9) >= 0 && sg * (v0 - t9) < 0) p9 = j + (t9 - v0) / (v1 - v0)
            }
            if (p1 !== null && p9 !== null) rise.push(p9 - p1)
            let sh = 0
            let sh2 = 0
            let sl = 0
            let sl2 = 0
            for (let j = 2; j <= 5; j++) {
              const vh = buf[c + b + j]
              const vl = buf[c - a - j]
              sh += vh
              sh2 += vh * vh
              sl += vl
              sl2 += vl * vl
            }
            const mh = sh / 4
            const ml = sl / 4
            if (Math.sqrt(Math.max(0, sh2 / 4 - mh * mh)) < 0.08 * st && Math.sqrt(Math.max(0, sl2 / 4 - ml * ml)) < 0.08 * st) {
              over.push((Math.max(0, sg * (hi - mh)) + Math.max(0, sg * (ml - lo))) / 2 / st)
            }
          }
        }
      }
      prevPrevG = prevG
      prevG = g
    }
  }
  const row = new Float32Array(W)
  for (let r = 8; r < H - 8; r += k) {
    const o = r * stride
    for (let q = 0; q < W; q++) row[q] = y[o + q]
    run(row, W, r, true)
  }
  const rows = { s: bs.slice(), n: bn.slice() }
  bs.fill(0)
  bn.fill(0)
  // the columns, gathered row by row (reading down a column of a 4K plane misses the cache)
  const xs = []
  for (let x = 8; x < W - 8; x += k) xs.push(x)
  const cols = new Float32Array(xs.length * H)
  for (let r = 0; r < H; r++) {
    const o = r * stride
    for (let c = 0; c < xs.length; c++) cols[c * H + r] = y[o + xs[c]]
  }
  for (let c = 0; c < xs.length; c++) run(cols.subarray(c * H, (c + 1) * H), H, xs[c], false)
  const ratio = (S, N) => {
    const q = Array.from(S, (v, i) => v / Math.max(1, N[i]))
    let off = 0
    let c = 0
    for (let i = 0; i < 64; i++) {
      if (i % 4) {
        off += q[i]
        c++
      }
    }
    off /= c
    if (!off) return 0
    const at = (f) => {
      let a = 0
      let n = 0
      for (let i = 0; i < 64; i++) {
        if (!f(i)) continue
        a += q[i]
        n++
      }
      return a / n / off
    }
    return Math.max(at((i) => i % 8 === 0 && i % 16 !== 0), at((i) => i % 16 === 0 && i % 32 !== 0), at((i) => i === 32), at((i) => i === 0)) - 1
  }
  return { rise25: pctl(rise, 0.25), rise: median(rise), overshoot: median(over), edges: rise.length, block: (ratio(rows.s, rows.n) + ratio(bs, bn)) / 2 }
}

// ---- temporal noise ---------------------------------------------------------

/**
 * Where the sampled noise blocks sit (origins), for a picture size: whole 16x16 blocks of the
 * encoder's grid, spread evenly. A block straddling the encoder's block edges mixes a repeated
 * part with a coded one and picks up block-edge steps (PW Entrance read 0.58 instead of 0.47).
 */
function noiseGrid(W, H) {
  const B = NOISE.BLOCK
  const nx = Math.floor(W / B)
  const ny = Math.floor(H / B)
  const gx = Math.max(1, Math.min(NOISE.GRID_X, nx))
  const gy = Math.max(1, Math.min(NOISE.GRID_Y, ny))
  const xs = Array.from({ length: gx }, (_, i) => B * Math.floor(((i + 0.5) * nx) / gx))
  const ys = Array.from({ length: gy }, (_, i) => B * Math.floor(((i + 0.5) * ny) / gy))
  return { gx, gy, xs, ys }
}

/** The sampled blocks' native Y into buf (gx*gy blocks of 16x16 bytes), plus which blocks are OSD. */
function noiseSample(y, stride, W, H, osd, s, buf) {
  const B = NOISE.BLOCK
  const { gx, gy, xs, ys } = noiseGrid(W, H)
  const need = gx * gy * B * B
  if (!buf || buf.length < need) buf = new Uint8Array(need)
  const onOsd = new Uint8Array(gx * gy)
  let o = 0
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      for (let r = 0; r < B; r++) {
        const a = (ys[j] + r) * stride + xs[i]
        for (let c = 0; c < B; c++) buf[o++] = y[a + c]
      }
      if (osd.at(((xs[i] + B / 2) / s) | 0, ((ys[j] + B / 2) / s) | 0)) onOsd[j * gx + i] = 1
    }
  }
  return { buf, gx, gy, onOsd }
}

/**
 * Temporal noise between two frames' sampled blocks: the frame difference over still blocks
 * (not moving, block mean changed by less than 2, not black or white, not OSD), sigma =
 * sqrt(median block variance / 2) (the difference of two frames holds the grain twice).
 * skip = share of still blocks the encoder repeated exactly (90% of their pixels unchanged).
 */
function temporal(A, B) {
  const P = NOISE.BLOCK * NOISE.BLOCK
  const n = A.gx * A.gy
  const mad = new Float32Array(n)
  const vr = new Float32Array(n)
  const zero = new Float32Array(n)
  const lvl = new Float32Array(n)
  const dm = new Float32Array(n)
  const a = A.buf
  const b = B.buf
  for (let j = 0, o = 0; j < n; j++) {
    let s1 = 0
    let s2 = 0
    let sa = 0
    let z = 0
    let l = 0
    for (let k = 0; k < P; k++, o++) {
      const d = b[o] - a[o]
      s1 += d
      s2 += d * d
      sa += d < 0 ? -d : d
      if (d === 0) z++
      l += b[o]
    }
    mad[j] = sa / P
    dm[j] = s1 / P
    vr[j] = s2 / P - dm[j] * dm[j]
    zero[j] = z / P
    lvl[j] = l / P
  }
  const codedMad = []
  for (let j = 0; j < n; j++) if (zero[j] < 0.9) codedMad.push(mad[j])
  const T = Math.max(2.5, 3 * (median(codedMad) ?? 0))
  const mv = new Uint8Array(n)
  let moving = 0
  for (let y = 0; y < A.gy; y++) {
    for (let x = 0; x < A.gx; x++) {
      if (mad[y * A.gx + x] <= T) continue
      moving++
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (y + dy >= 0 && y + dy < A.gy && x + dx >= 0 && x + dx < A.gx) mv[(y + dy) * A.gx + x + dx] = 1
    }
  }
  const coded = []
  let skip = 0
  let still = 0
  for (let j = 0; j < n; j++) {
    if (mv[j] || B.onOsd[j] || lvl[j] < 16 || lvl[j] > 240 || dm[j] >= 2 || dm[j] <= -2) continue
    still++
    if (zero[j] >= 0.9) skip++
    else coded.push(vr[j])
  }
  const m = median(coded)
  return { sigma: m === null ? null : Math.sqrt(Math.max(0, m) / 2), skip: still ? skip / still : null, moving: moving / n, still }
}

// ---- one frame --------------------------------------------------------------

/**
 * Everything measured on one frame's planes. `sampleBuf` (optional) is reused for the noise
 * blocks. The result keeps no reference to the planes.
 */
function analyse(p, opts, sampleBuf) {
  const t0 = now()
  const ms = {}
  const W = p.width
  const H = p.height
  const yStride = p.yStride ?? W
  const s = W >= 2560 ? 2 : 1
  const displayRange = p.displayRange ?? opts.displayRange ?? null
  const displayMatrix = matrixName(p.displayMatrix ?? opts.displayMatrix ?? 'bt709')
  let t = now()
  const { L, w, h } = lumaPlane(p.y, yStride, W, H, s)
  const native = nativeStats(p.y, yStride, W, H)
  ms.plane = now() - t
  t = now()
  const c = chromaOf(p)
  const nc = neutralChroma(c)
  const mono = nc >= MONO_NEUTRAL
  const osd = osdMask(L, w, h)
  const ex = exposure(L, w, h, osd, mono, displayRange)
  ms.exposure = now() - t
  t = now()
  const col = mono ? null : colour({ ...p, yStride }, c, ex.excluded, s, displayMatrix, displayRange)
  ms.colour = now() - t
  t = now()
  const ln = lines(p.y, yStride, W, H, ex.excluded, s)
  ms.lines = now() - t
  t = now()
  const sample = noiseSample(p.y, yStride, W, H, osd, s, sampleBuf)
  ms.noise = now() - t
  ms.total = now() - t0
  return {
    width: W,
    height: H,
    set: p.set ?? 0,
    sinceKey: Number.isInteger(p.sinceKey) ? p.sinceKey : null,
    ts: p.ts ?? null,
    aligned: p.aligned !== false,
    planes: p.planes ?? 'coded',
    displayRange,
    displayMatrix,
    native,
    mono,
    neutralChroma: nc,
    exposure: { mean: ex.mean, centre: ex.centre, p1: ex.p1, p50: ex.p50, p99: ex.p99, spread: ex.spread, black: ex.black, white: ex.white, clip: ex.clip, display: ex.display },
    osd: osd.boxes,
    colour: col,
    lines: ln,
    sample,
    ms
  }
}

/** A noise pair between two frames of one set, with the reason when it can't be used. */
function pairOf(a, b) {
  const gap = a.sinceKey !== null && b.sinceKey !== null ? b.sinceKey - a.sinceKey : null
  const out = { a: a.sinceKey, b: b.sinceKey, gap, sigma: null, skip: null, moving: null, still: 0, usable: false, why: null }
  if (a.width !== b.width || a.height !== b.height) out.why = 'picture size changed'
  else if (gap !== null && gap <= 0) out.why = 'a keyframe between the two frames'
  else if (a.sinceKey !== null && a.sinceKey < NOISE.AFTER_KEY) out.why = `less than ${NOISE.AFTER_KEY} frames after a keyframe`
  else if (gap !== null && gap !== NOISE.GAP) out.why = `${gap} frames apart, not ${NOISE.GAP}`
  if (out.why) return out
  const t = temporal(a.sample, b.sample)
  Object.assign(out, { sigma: r3(t.sigma), skip: r3(t.skip), moving: r3(t.moving), still: t.still })
  if (t.skip !== null && t.skip > NOISE.SKIP_MAX) out.why = 'the encoder repeats still areas'
  else if (t.sigma === null) out.why = 'no still blocks'
  else out.usable = true
  return out
}

// ---- combining frames ----------------------------------------------------------

const avgOf = (list, get) => {
  const v = list.map(get).filter((x) => x !== null && x !== undefined && Number.isFinite(x))
  return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null
}

/** The figures of a list of frames (one set, or all). */
function figuresOf(list) {
  const e = (k) => r3(avgOf(list, (f) => f.exposure[k]))
  const d = (k) => r3(avgOf(list, (f) => f.exposure.display[k]))
  const cl = (k) => r3(avgOf(list, (f) => f.exposure.clip[k]))
  const cols = list.map((f) => f.colour).filter(Boolean)
  const cc = (get) => r3(avgOf(cols, get))
  const est = (k) => {
    const v = cols.map((c) => c[k]).filter(Boolean)
    return v.length ? { r: r3(mean(v.map((x) => x.r))), b: r3(mean(v.map((x) => x.b))) } : null
  }
  const colourFig = cols.length * 2 > list.length
    ? {
        saturation: cc((c) => c.saturation),
        colourClip: cc((c) => c.colourClip),
        neutral: est('neutral'),
        greyEdge: est('greyEdge'),
        brightNeutral: est('brightNeutral'),
        zones: Array.from({ length: 9 }, (_, z) => {
          const v = cols.map((c) => c.zones[z]).filter(Boolean)
          return v.length ? { r: r3(mean(v.map((x) => x.r))), b: r3(mean(v.map((x) => x.b))) } : null
        }),
        zoneSpread: { r: cc((c) => c.zoneSpread.r), b: cc((c) => c.zoneSpread.b) },
        disagreement: cc((c) => c.disagreement),
        neutralShare: cc((c) => c.neutralShare)
      }
    : null
  const ln = (k) => r3(median(list.map((f) => f.lines[k]).filter((v) => v !== null && Number.isFinite(v))))
  return {
    mean: e('mean'),
    centre: e('centre'),
    p1: e('p1'),
    p50: e('p50'),
    p99: e('p99'),
    spread: e('spread'),
    black: e('black'),
    white: e('white'),
    clip: { surface: cl('surface'), near: cl('near'), light: cl('light'), lights: r3(avgOf(list, (f) => f.exposure.clip.lights)), text: cl('text') },
    display: { mean: d('mean'), p1: d('p1'), p99: d('p99'), spread: d('spread'), black: d('black'), white: d('white') },
    neutralChroma: r3(avgOf(list, (f) => f.neutralChroma)),
    colour: colourFig,
    lines: { rise25: ln('rise25'), rise: ln('rise'), overshoot: ln('overshoot'), edges: list.reduce((a, f) => a + f.lines.edges, 0), block: ln('block') }
  }
}

/** The result shape (see Measurer.result). */
function summarise(frames, pairs, opts) {
  if (!frames.length) return null
  const first = frames[0]
  const W = first.width
  const H = first.height
  const setIds = [...new Set(frames.map((f) => f.set))]
  const all = figuresOf(frames)
  const perSet = setIds.map((id) => figuresOf(frames.filter((f) => f.set === id)))
  const mono = all.neutralChroma !== null && all.neutralChroma >= MONO_NEUTRAL
  const colourFig = mono ? null : all.colour

  // noise: per set the smallest usable pair; the figure is the mean of the sets
  const noiseSets = setIds.map((id) => {
    const ps = pairs.filter((q) => q.set === id)
    const ok = ps.filter((q) => q.usable)
    return { set: id, value: ok.length ? r3(Math.min(...ok.map((q) => q.sigma))) : null, pairs: ps.map(({ set, ...q }) => q) }
  })
  const values = noiseSets.map((q) => q.value).filter((v) => v !== null)
  const measured = pairs.filter((q) => q.skip !== null)
  let reason = null
  if (!values.length) {
    if (measured.length && measured.every((q) => q.skip > NOISE.SKIP_MAX)) reason = 'the encoder repeats still areas'
    else if (!pairs.length) reason = 'too few frames'
    else reason = pairs.find((q) => q.why)?.why ?? 'no usable pair'
  }
  const stream = opts.stream ?? null
  // measured on what the browser drew (a frame that could not be copied out): its noise comes
  // through the display's range stretch (about 1.16x under a limited-range display), so it is
  // not on the bands' scale
  const rgba = first.planes === 'rgba'
  const comparable = !rgba && W >= NOISE.MIN_WIDTH && stream !== 'sub'
  const noise = {
    value: values.length ? r3(mean(values)) : null,
    spread: values.length === 2 ? r3(Math.abs(values[0] - values[1])) : null,
    measurable: values.length > 0,
    reason,
    comparable,
    notComparable: comparable ? null : rgba ? 'measured on the displayed picture' : W < NOISE.MIN_WIDTH ? `picture narrower than ${NOISE.MIN_WIDTH}` : 'sub stream',
    skip: r3(median(measured.map((q) => q.skip))),
    moving: r3(median(measured.map((q) => q.moving))),
    gap: NOISE.GAP,
    sets: noiseSets
  }

  const displayRange = first.displayRange
  // null = not known: drawn pictures are already "as displayed", and what the camera coded is
  // unknown then (the rules treat it as a mismatch)
  const rangeMismatch = rgba ? null : displayRange === 'limited' && (Math.abs(all.display.black - all.black) > 0.01 || Math.abs(all.display.white - all.white) > 0.01)
  const nat = (k, agg) => r3(agg(frames.map((f) => f.native[k])))
  const ab = perSet.length === 2
    ? (() => {
        const [A, B] = perSet
        const dif = (get) => {
          const x = get(A)
          const y = get(B)
          return x === null || y === null || x === undefined || y === undefined ? null : r3(Math.abs(x - y))
        }
        return {
          mean: dif((q) => q.mean),
          black: dif((q) => q.black),
          white: dif((q) => q.white),
          spread: dif((q) => q.spread),
          neutralChroma: dif((q) => q.neutralChroma),
          saturation: dif((q) => q.colour?.saturation ?? null),
          castR: dif((q) => q.colour?.neutral?.r ?? null),
          castB: dif((q) => q.colour?.neutral?.b ?? null),
          rise25: dif((q) => q.lines.rise25),
          overshoot: dif((q) => q.lines.overshoot),
          noise: noise.spread
        }
      })()
    : null
  const cast = colourFig?.neutral
  const sure = Boolean(colourFig && colourFig.disagreement !== null && colourFig.disagreement <= COLOUR.CAST_DISAGREE)
  return {
    v: 2,
    width: W,
    height: H,
    frames: frames.length,
    sets: setIds.map((id) => frames.filter((f) => f.set === id).length),
    planes: first.planes,
    stream,
    codec: opts.codec ?? null,
    aligned: frames.every((f) => f.aligned && f.sinceKey !== null),
    displayRange,
    displayMatrix: first.displayMatrix,
    // exposure, coded values (lamps, OSD text and their margins left out)
    mean: all.mean,
    centre: all.centre,
    p1: all.p1,
    p50: all.p50,
    p99: all.p99,
    spread: all.spread,
    black: all.black,
    white: all.white,
    highlightLoss: r3((all.clip.surface ?? 0) + (all.clip.near ?? 0)),
    clip: all.clip,
    osd: first.osd,
    display: { range: displayRange, ...all.display },
    rangeMismatch,
    coded: { min: nat('min', (a) => Math.min(...a)), max: nat('max', (a) => Math.max(...a)), le4: nat('le4', mean), le16: nat('le16', mean), ge235: nat('ge235', mean), ge251: nat('ge251', mean) },
    // black and white (infrared) or colour
    neutralChroma: all.neutralChroma,
    mono,
    colour: colourFig ? { matrix: first.displayMatrix, ...colourFig } : null,
    saturation: colourFig?.saturation ?? 0,
    colourClip: colourFig?.colourClip ?? 0,
    cast: cast ? { r: cast.r, b: cast.b, sure } : { r: 0, b: 0, sure: false },
    noise,
    lines: all.lines,
    ab,
    ms: {
      frame: r3(median(frames.map((f) => f.ms.total))),
      ...Object.fromEntries(['plane', 'exposure', 'colour', 'lines', 'noise'].map((k) => [k, r3(median(frames.map((f) => f.ms[k])))]))
    }
  }
}

/**
 * The picture measurement, one frame at a time, on the coded planes. State is explicit: create
 * one per measurement. Frames of a set should come in order; noise pairs are formed between
 * consecutive frames of the same set.
 */
export class Measurer {
  /** @param {{ stream?: 'main' | 'sub' | null, codec?: 'h264' | 'h265' | null, displayRange?: 'limited' | 'full', displayMatrix?: string }} [opts] */
  constructor(opts = {}) {
    this.opts = opts
    this.frames = []
    this.pairs = []
    this.last = null // previous frame (with its noise blocks)
    this.spare = null // a noise-block buffer to reuse
  }

  /**
   * One frame: { width, height, y, yStride?, u, v, uStride?, vStride? (I420) | uv, uvStride?
   * (NV12), chroma?: 'I420' | 'NV12', set?, sinceKey? (frames since the last keyframe; null
   * when unknown), ts?, aligned?, displayMatrix?, displayRange?: 'limited' | 'full', planes?:
   * 'coded' | 'rgba' }. The planes are read here and not kept. Returns this frame's timing and
   * its unmasked coded shares: { ms: { total, ... }, coded: { min, max, le4, le16, ge235, ge251 } }.
   */
  add(p) {
    const f = analyse(p, this.opts, this.spare)
    this.spare = null
    this.#pair(f)
    return { ms: f.ms, coded: f.native }
  }

  /** Adds a frame already measured by measureFrame(). */
  addMeasured(f) {
    this.#pair(f)
  }

  #pair(f) {
    const prev = this.last
    if (prev && prev.set === f.set) this.pairs.push({ set: f.set, ...pairOf(prev, f) })
    if (prev && prev.sample.buf !== f.sample.buf) this.spare = prev.sample.buf
    this.last = f
    const { sample, ...kept } = f
    this.frames.push(kept)
  }

  /**
   * The figures. Coded values unless `planes` is 'rgba'. Shape:
   * { v: 2, width, height, frames, sets: [n per set], planes, stream, codec, aligned,
   *   displayRange, displayMatrix,
   *   mean, centre, p1, p50, p99, spread, black (Y <= 4), white (Y >= 251), highlightLoss,
   *   clip: { surface, near, light, lights, text }, osd: [[x0, y0, x1, y1] (0-1)],
   *   display: { range, mean, p1, p99, spread, black (shows as <= 4), white (>= 251) } (as the
   *     display range shows the coded values; = coded when 'full'), rangeMismatch (null when
   *     planes is 'rgba': what the camera coded is not known),
   *   coded: { min, max, le4, le16, ge235, ge251 } (unmasked),
   *   neutralChroma, mono, colour: null | { matrix, saturation, colourClip, neutral, greyEdge,
   *     brightNeutral ({ r, b } log2 ratios to green), zones: [9], zoneSpread: { r, b },
   *     disagreement, neutralShare },
   *   saturation, colourClip, cast: { r, b, sure },
   *   noise: { value, spread, measurable, reason, comparable, notComparable, skip, moving, gap,
   *     sets: [{ set, value, pairs: [{ a, b, gap, sigma, skip, moving, still, usable, why }] }] },
   *   lines: { rise25, rise, overshoot, edges, block },
   *   ab: null | { mean, black, white, spread, neutralChroma, saturation, castR, castB, rise25,
   *     overshoot, noise } (|set A - set B|), ms: { frame, plane, exposure, colour, lines, noise } }
   */
  result() {
    return summarise(this.frames, this.pairs, this.opts)
  }
}

// ---- RGBA (what the browser shows) ------------------------------------------------

let rgbaPlanes = null

/**
 * Planes from RGBA pixels, as the browser shows them (BT.709, full range): for the lab's RGBA
 * path and the fallbacks for frames that can't be copied (format null).
 * The planes (reused buffers) are valid until the next call.
 */
export function planesFromRGBA({ data, width: W, height: H }) {
  const cw = Math.ceil(W / 2)
  const ch = Math.ceil(H / 2)
  if (!rgbaPlanes || rgbaPlanes.W !== W || rgbaPlanes.H !== H) rgbaPlanes = { W, H, y: new Uint8Array(W * H), u: new Uint8Array(cw * ch), v: new Uint8Array(cw * ch) }
  const { y, u, v } = rgbaPlanes
  for (let j = 0, i = 0; j < W * H; j++, i += 4) y[j] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] + 0.5
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let r = 0
      let b = 0
      let yy = 0
      let n = 0
      for (let dy = 0; dy < 2; dy++) {
        const py = 2 * cy + dy
        if (py >= H) continue
        for (let dx = 0; dx < 2; dx++) {
          const px = 2 * cx + dx
          if (px >= W) continue
          const i = (py * W + px) * 4
          r += data[i]
          b += data[i + 2]
          yy += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
          n++
        }
      }
      const k = cy * cw + cx
      u[k] = Math.max(0, Math.min(255, 128 + (b - yy) / n / 1.8556 + 0.5))
      v[k] = Math.max(0, Math.min(255, 128 + (r - yy) / n / 1.5748 + 0.5))
    }
  }
  return { width: W, height: H, y, yStride: W, u, v, uStride: cw, vStride: cw, chroma: 'I420', planes: 'rgba', displayMatrix: 'bt709', displayRange: 'full' }
}

/**
 * One frame's figures from an ImageData (RGBA as displayed). meta: { set, sinceKey, ts }.
 * The figures keep that frame's noise blocks (about 1.3 MB at 4K) for combine().
 */
export function measureFrame(img, meta = {}) {
  return analyse({ ...planesFromRGBA(img), ...meta }, {}, null)
}

/** The figures of frames from measureFrame(), in order (the Measurer result shape). */
export function combine(list, opts = {}) {
  const m = new Measurer(opts)
  for (const f of list) m.addMeasured(f)
  return m.result()
}

// ---- display self-check -------------------------------------------------------------
//
// Does this browser show the coded values (full range: the range fix took) or stretch them as
// limited range (coded 16 -> black, 235 -> white)? The check compares like with like: the
// browser draws a region of the frame 1:1 (no scaling to average away thin text or small
// highlights), clear of the OSD bands, and the coded Y, Cb, Cr of that same region, converted
// to RGB as each kind of display would (clipped per channel: a coloured highlight shows below
// white even when its luma is above it), say how much of it each would show as black (display
// luma <= 2) and white (>= 253). It answers 'limited' or 'full' only when the two predictions
// differ clearly (by at least 1% of the region) and what the browser drew is clearly nearer one
// of them; else 'unknown' (many scenes have too little near black or white to tell).

export const SELF_CHECK = { W: 320, H: 180, MIN_SEP: 0.01, NEAR: 0.3 }

/** Shares of a region that a limited-range and a full-range display would show as black and white. */
function regionShares(p, c, [kr, kb], sx, sy, sw, sh, step) {
  const kg = 1 - kr - kb
  const stride = p.yStride ?? p.width
  const shown = (Y, cb, cr, yo, ys, cs) => {
    const Yd = (Y - yo) * ys
    const r0 = Yd + 2 * (1 - kr) * cr * cs
    const b0 = Yd + 2 * (1 - kb) * cb * cs
    const g0 = (Yd - kr * r0 - kb * b0) / kg
    const r = r0 < 0 ? 0 : r0 > 255 ? 255 : r0
    const g = g0 < 0 ? 0 : g0 > 255 ? 255 : g0
    const b = b0 < 0 ? 0 : b0 > 255 ? 255 : b0
    return kr * r + kg * g + kb * b
  }
  let n = 0
  const lim = { black: 0, white: 0 }
  const full = { black: 0, white: 0 }
  for (let y = sy; y < sy + sh; y += step) {
    const o = y * stride
    const cy = y >> 1
    for (let x = sx; x < sx + sw; x += step) {
      const Y = p.y[o + x]
      const cb = c.u[cy * c.uStride + (x >> 1) * c.step + c.uOff] - 128
      const cr = c.v[cy * c.vStride + (x >> 1) * c.step + c.vOff] - 128
      n++
      const l = shown(Y, cb, cr, 16, 255 / 219, 255 / 224)
      const f = shown(Y, cb, cr, 0, 1, 1)
      if (l <= 2) lim.black++
      else if (l >= 253) lim.white++
      if (f <= 2) full.black++
      else if (f >= 253) full.white++
    }
  }
  const share = (o) => ({ black: o.black / n, white: o.white / n })
  return { limited: share(lim), full: share(full) }
}

/**
 * Where the self-check looks: of a few 320x180 regions (smaller for small pictures) clear of
 * the OSD bands (top and bottom 15%), the one where the two kinds of display would differ most.
 * p: coded planes (Measurer.add's input); matrix: the display's. Returns { sx, sy, sw, sh,
 * limited: { black, white }, full: { black, white } } (what each display would show there), or
 * null for a picture too small.
 */
export function selfCheckRegion(p, matrix = 'bt709') {
  const W = p.width
  const H = p.height
  const sw = Math.min(SELF_CHECK.W, W) & ~1
  const sh = Math.min(SELF_CHECK.H, Math.floor(H * 0.7)) & ~1
  if (sw < 16 || sh < 16) return null
  const c = chromaOf(p)
  const k = MATRICES[matrixName(matrix)]
  const even = (v) => Math.max(0, Math.round(v / 2) * 2)
  const top = Math.ceil(H * 0.15)
  const bottom = Math.floor(H * 0.85) - sh
  const xs = [0, 0.25, 0.5, 0.75, 1].map((t) => even(t * (W - sw)))
  const ys = bottom > top ? [0, 0.5, 1].map((t) => even(top + t * (bottom - top))) : [even((H - sh) / 2)]
  const sep = (s) => s.limited.black + s.limited.white - (s.full.black + s.full.white)
  let best = null
  for (const sy of ys) {
    for (const sx of xs) {
      const s = sep(regionShares(p, c, k, sx, sy, sw, sh, 2))
      if (!best || s > best.sep) best = { sx, sy, sep: s }
    }
  }
  const s = regionShares(p, c, k, best.sx, best.sy, sw, sh, 1)
  const round = (o) => ({ black: r3(o.black), white: r3(o.white) })
  return { sx: best.sx, sy: best.sy, sw, sh, limited: round(s.limited), full: round(s.full) }
}

/**
 * The verdict. img: the region as this browser drew it, 1:1 (ImageData); region: what each
 * display would show there (selfCheckRegion). Returns { range: 'limited' | 'full' | 'unknown',
 * displayBlack, displayWhite, limitedWould, fullWould } (black + white each would show).
 */
export function displaySelfCheck(img, region) {
  const { data } = img
  let n = 0
  let black = 0
  let white = 0
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    n++
    if (l <= 2) black++
    if (l >= 253) white++
  }
  const displayBlack = n ? black / n : 0
  const displayWhite = n ? white / n : 0
  const full = region.full.black + region.full.white
  const limited = region.limited.black + region.limited.white
  const sep = limited - full
  // where the drawn picture lies between the two predictions: 0 = as full range, 1 = as limited
  const t = sep > 0 ? (displayBlack + displayWhite - full) / sep : null
  const range = sep < SELF_CHECK.MIN_SEP ? 'unknown' : t <= SELF_CHECK.NEAR ? 'full' : t >= 1 - SELF_CHECK.NEAR ? 'limited' : 'unknown'
  return { range, displayBlack: r3(displayBlack), displayWhite: r3(displayWhite), limitedWould: r3(limited), fullWould: r3(full) }
}

// ---- the Worker, from the page ------------------------------------------------------

/**
 * A Measurer in a Worker (picture-worker.js): `sink` takes a VideoFrame (ownership passes:
 * it is transferred, never kept here) with its meta; result() resolves once every frame sent
 * before it has been measured. For player.grabAfterKey({ sink: worker.sink }).
 */
export class PictureWorker {
  constructor(opts = {}) {
    this.worker = new Worker(new URL('./picture-worker.js', import.meta.url), { type: 'module' })
    this.waiting = new Map()
    this.next = 0
    this.failed = null // the worker itself failed
    this.frameErrors = [] // frames that could not be measured (the others still count)
    this.added = [] // { ms, selfCheck } per measured frame, as the worker reports it
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'added') this.added.push({ ms: data.ms, selfCheck: data.selfCheck })
      const w = data.id ? this.waiting.get(data.id) : null
      if (data.type === 'error' && !w) this.frameErrors.push(data.message)
      if (!w) return
      this.waiting.delete(data.id)
      if (data.type === 'error') w.reject(new Error(data.message))
      else w.resolve(data.result)
    }
    this.worker.onerror = (e) => {
      this.failed = new Error(e.message || 'picture worker failed')
      for (const w of this.waiting.values()) w.reject(this.failed)
      this.waiting.clear()
    }
    this.worker.postMessage({ type: 'start', opts })
    this.sink = (frame, meta) => {
      try {
        this.worker.postMessage({ type: 'frame', frame, meta }, [frame])
      } catch (e) {
        frame.close()
        this.frameErrors.push(e.message)
      }
    }
  }

  /** The Measurer's result (null when no frame was measured). */
  result() {
    if (this.failed) return Promise.reject(this.failed)
    const id = ++this.next
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.worker.postMessage({ type: 'result', id })
    })
  }

  close() {
    this.worker.terminate()
    for (const w of this.waiting.values()) w.reject(new Error('closed'))
    this.waiting.clear()
  }
}

// ---- plain-language report ------------------------------------------------------------

const pctOf = (v) => `${Math.round((v / 255) * 100)}%`
const pc1 = (v) => `${(v * 100).toFixed(1)}%`

export function castName({ r, b }) {
  const C = COLOUR.CAST
  if (r > C && b > C) return 'magenta'
  if (r < -C && b < -C) return 'green'
  if (r > C && b < -C / 2) return 'yellow-orange'
  if (b > C && r < -C / 2) return 'blue-cyan'
  if (Math.abs(r) >= Math.abs(b)) return r > 0 ? 'red' : 'cyan'
  return b > 0 ? 'blue' : 'yellow'
}

/** Noise band of a comparable figure: 'high' | 'some' | 'low'. */
export const noiseBand = (v) => (v >= NOISE_BANDS.high ? 'high' : v >= NOISE_BANDS.some ? 'some' : 'low')

/**
 * Plain-language description of a result, for the panel: { exposure, colour, noise, focus,
 * stream, size, lines: [all of these as sentences] }. ctx: { stream: StreamMeter figures }.
 */
export function describe(m, ctx = {}) {
  const exp = (e) => `average ${pctOf(e.mean)}, uses ${pctOf(e.spread)} of the range; ${pc1(e.black)} pure black, ${pc1(e.white)} pure white`
  let exposureText = exp(m)
  if (m.planes === 'rgba') exposureText = `as displayed in this browser (the camera's own values could not be read): ${exposureText}`
  else if (m.rangeMismatch) exposureText += ` (as displayed in this browser: ${exp(m.display)}; the display clips shadows and highlights the camera recorded)`
  const clip = m.clip ?? {}
  if ((clip.surface ?? 0) + (clip.near ?? 0) >= 0.005) exposureText += `; overlit areas ${pc1((clip.surface ?? 0) + (clip.near ?? 0))}${clip.near >= 0.005 ? ` (infrared glare ${pc1(clip.near)})` : ''}`
  if (clip.lights) exposureText += `; ${Math.round(clip.lights)} lamp${Math.round(clip.lights) === 1 ? '' : 's'} left out`

  let colourText
  const c = m.colour
  if (m.mono) colourText = 'black and white (infrared)'
  else if (!c || !c.neutral) colourText = 'not measured (too few grey areas)'
  else {
    const amount = Math.max(Math.abs(c.neutral.r), Math.abs(c.neutral.b))
    const mixed = (c.disagreement ?? 1) > COLOUR.CAST_DISAGREE || Math.max(c.zoneSpread.r ?? 0, c.zoneSpread.b ?? 0) > COLOUR.ZONE_SPREAD || c.neutralShare < COLOUR.NEUTRAL_SHARE
    // when the estimates disagree neither a cast nor a neutral balance is known: name neither
    colourText = mixed ? 'no clear cast (mixed or uncertain lighting: the estimates disagree)' : amount < COLOUR.CAST ? 'neutral balance' : `${castName(c.neutral)} cast (${Math.round((2 ** amount - 1) * 100)}%)`
  }

  const n = m.noise
  let noiseText
  if (!n || !n.measurable) noiseText = `not measurable (${n?.reason ?? 'no frames'})`
  else {
    const fig = `${n.value.toFixed(2)}${n.spread !== null ? ` ± ${n.spread.toFixed(2)}` : ''}`
    noiseText = n.comparable ? `${noiseBand(n.value)} (${fig})` : `${fig}, not comparable with other cameras (${n.notComparable})`
    if (m.codec === 'h264') noiseText += ' (H.264: encoder noise adds to this figure)'
    if (!m.aligned) noiseText += ' (position in the keyframe interval unknown)'
  }

  const l = m.lines ?? {}
  const focusText = l.rise25 === null || l.rise25 === undefined ? 'not measured (too few edges)' : `edges rise over ${l.rise25.toFixed(2)} px, overshoot ${Math.round((l.overshoot ?? 0) * 100)}%, block index ${(l.block ?? 0).toFixed(2)}`

  const s = ctx.stream
  let streamText = null
  if (s) {
    if (!s.enough) streamText = `measuring the stream (${Math.floor(s.windowS ?? 0)} of 20 s)`
    else if (!s.qoi) streamText = `${(s.kbps / 1000).toFixed(1)} Mbit/s (cap unknown)`
    else {
      const bound = Math.round((s.bindShare ?? 0) * s.gops.length)
      streamText = `${(s.kbps / 1000).toFixed(1)} of ${(s.qoi / 1000).toFixed(1)} Mbit/s (${Math.round(s.usage * 100)}%), at the cap in ${bound} of ${s.gops.length} ${s.mode === 'gops' ? 'keyframe intervals' : '10 s windows'}`
    }
  }
  const out = { exposure: exposureText, colour: colourText, noise: noiseText, focus: focusText, stream: streamText, size: `${m.width}×${m.height}` }
  out.lines = [`Exposure: ${out.exposure}`, `Colour: ${out.colour}`, `Noise: ${out.noise}`, `Edges: ${out.focus}`, ...(streamText ? [`Stream: ${streamText}`] : [])]
  return out
}

// The rules that turn these figures into setting changes are in auto-adjust.js (suggest()).

