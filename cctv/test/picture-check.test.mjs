// Offline tests for Auto adjust's measuring (public/picture-check.js, the Measurer): made-up
// planar frames with known properties, then the real-figure fixtures the lab harness wrote
// from real camera video with the decoder's own pix_fmt (test/fixtures/figures/*.json).
//   node cctv/test/picture-check.test.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { suggest } from '../public/auto-adjust.js'
import { COLOUR, MONO_NEUTRAL, Measurer, NOISE, combine, describe, displaySelfCheck, measureFrame, planesFromRGBA, selfCheckRegion } from '../public/picture-check.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const near = (a, b, tol) => a !== null && a !== undefined && Math.abs(a - b) <= tol

// ---- synthetic frames ---------------------------------------------------------------
let seed = 1
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const gauss = () => (rand() + rand() + rand() + rand() - 2) * Math.sqrt(3) // unit variance, near enough normal
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

/** An I420 frame from a luma function (plus per-pixel noise) and chroma functions. */
function planar({ W = 640, H = 360, Y, U = () => 128, V = () => 128, noise = 0, stride = W, ...meta }) {
  const y = new Uint8Array(stride * H)
  for (let r = 0; r < H; r++) for (let x = 0; x < W; x++) y[r * stride + x] = clamp(Y(x, r) + (noise ? noise * gauss() : 0))
  const cw = Math.ceil(W / 2)
  const ch = Math.ceil(H / 2)
  const u = new Uint8Array(cw * ch)
  const v = new Uint8Array(cw * ch)
  for (let r = 0; r < ch; r++) {
    for (let x = 0; x < cw; x++) {
      u[r * cw + x] = clamp(U(2 * x, 2 * r))
      v[r * cw + x] = clamp(V(2 * x, 2 * r))
    }
  }
  return { width: W, height: H, y, yStride: stride, u, v, chroma: 'I420', ...meta }
}

/** An I420 frame (full range, BT.709) from an RGB function: what a colour scene codes to. */
function fromRGB({ W = 640, H = 360, rgb, ...meta }) {
  const Yf = (x, y) => {
    const [r, g, b] = rgb(x, y)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  return planar({
    W,
    H,
    Y: Yf,
    U: (x, y) => 128 + (rgb(x, y)[2] - Yf(x, y)) / 1.8556,
    V: (x, y) => 128 + (rgb(x, y)[0] - Yf(x, y)) / 1.5748,
    displayRange: 'full',
    displayMatrix: 'bt709',
    ...meta
  })
}

const scene = (W) => (x, y) => 70 + 90 * (x / W) + 30 * Math.sin(x / 37) * Math.cos(y / 23) // 40-190, smooth
const measure = (frames, opts = { stream: 'main' }) => {
  const m = new Measurer(opts)
  for (const f of frames) m.add(f)
  return m.result()
}
/** Frames at keyframe + 6, 12, 18, 24 in `sets` keyframe intervals, each with fresh noise. */
const gopFrames = (make, sets = 2) => {
  const out = []
  for (let s = 0; s < sets; s++) for (const k of [6, 12, 18, 24]) out.push(make({ set: s, sinceKey: k }))
  return out
}

// ---- noise (plan D2) --------------------------------------------------------------------
{
  const W = 1920
  const H = 1080
  const m = measure(gopFrames((meta) => planar({ W, H, Y: scene(W), noise: 1.5, displayRange: 'limited', ...meta })))
  const expect = Math.sqrt(1.5 ** 2 + 1 / 12) // plus rounding to whole values
  check('noise: sigma recovered within 10% at a gap of 6 frames', near(m.noise.value, expect, 0.1 * expect), `${m.noise.value} vs ${expect.toFixed(3)}`)
  check('  measurable, comparable (1920 wide, main stream), aligned', m.noise.measurable && m.noise.comparable && m.aligned, JSON.stringify({ measurable: m.noise.measurable, comparable: m.noise.comparable, aligned: m.aligned }))
  check('  three usable pairs per set, the figure of each set is its smallest pair', m.noise.sets.length === 2 && m.noise.sets.every((s) => s.pairs.length === 3 && s.pairs.every((q) => q.usable) && s.value === Math.min(...s.pairs.map((q) => q.sigma))), JSON.stringify(m.noise.sets.map((s) => s.pairs.map((q) => q.sigma))))
  check('  spread = |A - B|, small for the same noise', m.noise.spread !== null && m.noise.spread < 0.1 && near(m.noise.spread, Math.abs(m.noise.sets[0].value - m.noise.sets[1].value), 0.0015), String(m.noise.spread))
  check('  ab carries each figure\'s repeatability', m.ab && m.ab.noise === m.noise.spread && m.ab.mean < 0.5, JSON.stringify(m.ab))
  check('  2560 and wider: same figure (noise is always native resolution)', (() => {
    const W2 = 2560
    const H2 = 1440
    const m2 = measure(gopFrames((meta) => planar({ W: W2, H: H2, Y: scene(W2), noise: 1.5, ...meta }), 1))
    return near(m2.noise.value, expect, 0.1 * expect)
  })())

  // an encoder that repeats still areas: most blocks come out exactly as in the frame before
  let prev = null
  const repeat = (meta) => {
    const f = planar({ W, H, Y: scene(W), noise: 1.5, ...meta })
    if (prev) {
      for (let r = 0; r < H; r++) {
        for (let x = 0; x < W; x++) {
          if ((((x >> 4) + (r >> 4)) % 8) !== 0) f.y[r * W + x] = prev.y[r * W + x] // 7 of 8 blocks repeated
        }
      }
    }
    prev = f
    return f
  }
  const sk = measure(gopFrames(repeat, 1))
  check('skip share > 0.8: noise not measurable', !sk.noise.measurable && sk.noise.value === null && /repeats still areas/.test(sk.noise.reason) && sk.noise.skip > 0.8, `${sk.noise.reason}, skip ${sk.noise.skip}`)

  // keyframe positions: pairs too close after a keyframe, or across one, are dropped
  const w = 640
  const h = 360
  const small = (meta) => planar({ W: w, H: h, Y: scene(w), noise: 1.5, ...meta })
  const keyed = measure([0, 6, 12, 18].map((k) => small({ set: 0, sinceKey: k })).concat([18, 24, 3].map((k) => small({ set: 1, sinceKey: k }))))
  const [a, b] = keyed.noise.sets
  check('pairs < 6 frames after a keyframe are dropped', !a.pairs[0].usable && /after a keyframe/.test(a.pairs[0].why) && a.pairs[1].usable && a.pairs[2].usable, a.pairs.map((q) => q.why ?? 'ok').join(', '))
  check('  a pair across a keyframe is dropped', b.pairs[0].usable && !b.pairs[1].usable && /keyframe between/.test(b.pairs[1].why), b.pairs.map((q) => q.why ?? 'ok').join(', '))
  const gap4 = measure([6, 10].map((k) => small({ sinceKey: k })))
  check('  a pair not 6 frames apart is not used', !gap4.noise.measurable && /4 frames apart/.test(gap4.noise.sets[0].pairs[0].why), gap4.noise.sets[0].pairs[0].why)
  const unknown = measure([null, null, null].map((k) => small({ sinceKey: k })))
  check('  position unknown: pairs used, result not aligned', unknown.noise.measurable && !unknown.aligned)

  const narrow = measure(gopFrames((meta) => planar({ W: 1280, H: 720, Y: scene(1280), noise: 1.5, ...meta }), 1))
  check('W < 1920: not comparable', narrow.noise.measurable && !narrow.noise.comparable && /narrower than 1920/.test(narrow.noise.notComparable), narrow.noise.notComparable)
  const sub = measure(gopFrames((meta) => planar({ W, H, Y: scene(W), noise: 1.5, ...meta }), 1), { stream: 'sub' })
  check('  sub stream: not comparable', !sub.noise.comparable && sub.noise.notComparable === 'sub stream')
  check('  describe says so', /not comparable/.test(describe(narrow).noise) && /low|some|high/.test(describe(m).noise), `${describe(narrow).noise} | ${describe(m).noise}`)
  check('  H.264 figures carry the encoder note', /H\.264/.test(describe(measure(gopFrames(small, 1), { stream: 'main', codec: 'h264' })).noise))
  // someone walking: a textured object moves 60 px between the grabbed frames
  const walker = (meta) => {
    const x0 = 400 + 60 * (meta.sinceKey / 6)
    return planar({ W, H, Y: (x, y) => (x >= x0 && x < x0 + 300 && y > 300 && y < 800 ? 120 + 60 * Math.sin(x / 5) * Math.cos(y / 7) : scene(W)(x, y)), noise: 1.5, ...meta })
  }
  const moving = measure(gopFrames(walker, 1))
  check('  a moving object: its blocks are left out, the figure stays within 10%', moving.noise.moving > 0.01 && near(moving.noise.value, expect, 0.1 * expect), `value ${moving.noise.value}, moving ${moving.noise.moving}`)
}

// ---- black and white ----------------------------------------------------------------------
{
  const mono = measure([planar({ Y: scene(640), U: () => 128, V: () => 128 })])
  check('mono: U = V = 128 reads as black and white', mono.mono && mono.neutralChroma === 1 && mono.colour === null && /black and white/.test(describe(mono).colour), `neutral ${mono.neutralChroma}`)
  const col = measure([planar({ Y: scene(640), U: (x) => 128 + 12 * Math.sin(x / 9), V: (x, y) => 128 + 10 * Math.cos(y / 7) })])
  check('  colour chroma does not', !col.mono && col.neutralChroma < MONO_NEUTRAL && col.colour !== null, `neutral ${col.neutralChroma}`)
  const almost = measure([planar({ Y: scene(640), U: (x, y) => 128 + ((x + y) % 3) - 1, V: () => 128 })])
  check('  within 1 of neutral still counts as black and white (IR clips read 1.000)', almost.mono)
}

// ---- coded vs displayed exposure ------------------------------------------------------------
{
  // 10% of the picture coded at 18 and 10% at 233: a limited-range display shows them as 2 and
  // 253, pure black and white
  const Y = (x) => (x < 64 ? 18 : x >= 576 ? 233 : 128)
  const limited = measure([planar({ Y, displayRange: 'limited' })])
  const full = measure([planar({ Y, displayRange: 'full' })])
  check('coded: no pure black or white', limited.black < 0.001 && limited.white < 0.001, `${limited.black} ${limited.white}`)
  check('limited-range display: the same frame shows 10% black and 10% white', near(limited.display.black, 0.1, 0.01) && near(limited.display.white, 0.1, 0.01) && limited.display.range === 'limited', JSON.stringify(limited.display))
  check('  rangeMismatch', limited.rangeMismatch === true)
  check('  displayed spread wider than coded (x 255/219)', limited.display.spread > limited.spread)
  check('full-range display: displayed = coded, no mismatch', full.rangeMismatch === false && full.display.black === full.black && full.display.white === full.white && full.display.spread === full.spread)
  check('  describe shows "as displayed" only when they differ', /as displayed/.test(describe(limited).exposure) && !/as displayed/.test(describe(full).exposure), describe(limited).exposure)
  check('coded min/max and shares are raw (no masks)', limited.coded.min === 18 && limited.coded.max === 233 && limited.coded.le16 === 0 && limited.coded.ge235 === 0, JSON.stringify(limited.coded))
}

// ---- clipped areas: lamps, surfaces, infrared glare, OSD text ------------------------------------
{
  const W = 1920
  const H = 1080
  const base = scene(W)
  // six small lamps (about 0.02% each)
  const lamp = (x, y) => [[300, 300], [700, 250], [1100, 400], [1500, 300], [400, 700], [1300, 650]].some(([cx, cy]) => Math.abs(x - cx) < 10 && Math.abs(y - cy) < 10)
  const lamps = measure([planar({ W, H, Y: (x, y) => (lamp(x, y) ? 255 : base(x, y)), U: (x) => 128 + 8 * Math.sin(x / 50) })])
  check('small lamps: counted as lights, left out of the exposure figures', lamps.clip.lights >= 5 && lamps.clip.light > 0 && lamps.white < 0.0005 && lamps.highlightLoss < 0.001, JSON.stringify(lamps.clip))
  const surf = measure([planar({ W, H, Y: (x, y) => (x > 700 && x < 1100 && y > 300 && y < 560 ? 255 : base(x, y)), U: (x) => 128 + 8 * Math.sin(x / 50) })])
  check('an overlit surface (5%): surface, highlight loss', near(surf.clip.surface, 0.05, 0.01) && near(surf.highlightLoss, 0.05, 0.01) && surf.white > 0.03, JSON.stringify(surf.clip))
  const glare = measure([planar({ W, H, Y: (x, y) => (y > 900 && x > 600 && x < 1300 ? 255 : base(x, y)) })])
  check('infrared picture, clipped low and big: near glare', glare.mono && glare.clip.near > 0.02 && glare.clip.surface < 0.005, JSON.stringify(glare.clip))
  // an OSD line at the top: white strokes with dark outlines (3 on, 1 off)
  const osd = (x, y) => (y >= 40 && y < 60 && x >= 100 && x < 800 ? (x % 4 === 3 ? 0 : 255) : null)
  const text = measure([planar({ W, H, Y: (x, y) => osd(x, y) ?? base(x, y), U: (x) => 128 + 8 * Math.sin(x / 50) })])
  check('OSD text is found and left out', text.osd.length >= 1 && text.clip.text > 0 && text.white < 0.001, JSON.stringify({ osd: text.osd, clip: text.clip, white: text.white }))
}

// ---- colour, in the display matrix ------------------------------------------------------------------
{
  const W = 640
  const H = 360
  // with fine texture, as real pictures have (on a nearly flat picture the rounding of the coded
  // chroma to whole values shows in red and blue edges: grey-edge would read it as a cast)
  const lum = (x, y) => 60 + 110 * ((x / W) * 0.6 + 0.4 * ((Math.sin(x / 37) * Math.cos(y / 23) + 1) / 2)) + 12 * Math.sin(x / 3) * Math.cos(y / 4)
  // a few coloured objects on a grey world, darker than it as real objects are (an edge that
  // changes only red and blue would read as a cast to the grey-edge estimator)
  const tint = (x, y) => (((x >> 6) + 3 * (y >> 6)) % 23 === 0 ? [0.91, 0.7, 0.49] : ((x >> 6) + 3 * (y >> 6)) % 23 === 11 ? [0.49, 0.7, 0.91] : [1, 1, 1])
  // real grey surfaces are never exactly grey: a faint, slow colour wobble that averages out
  // (else the picture reads as black and white, correctly)
  const world = (gain, tinted = true) => (x, y) => {
    const l = lum(x, y)
    const t = tinted ? tint(x, y) : [1, 1, 1]
    const w = 0.05 * Math.sin(x / 97 + y / 61)
    const wob = [1 + w, 1, 1 - w]
    return [0, 1, 2].map((c) => Math.min(255, l * t[c] * wob[c] * gain[c]))
  }
  const grey = measure([fromRGB({ rgb: world([1, 1, 1]) })])
  check('neutral scene: no cast, estimators agree', Math.abs(grey.cast.r) < 0.05 && Math.abs(grey.cast.b) < 0.05 && grey.colour.disagreement < COLOUR.CAST_DISAGREE && describe(grey).colour === 'neutral balance', `${JSON.stringify(grey.cast)} dis ${grey.colour.disagreement}; ${describe(grey).colour}`)
  const blue = measure([fromRGB({ rgb: world([1, 1, 1.15]) })])
  check('blue cast: measured by all three estimators', blue.colour.neutral.b > 0.15 && blue.colour.greyEdge.b > 0.1 && blue.colour.brightNeutral.b > 0.1 && blue.cast.sure && /blue/.test(describe(blue).colour), `${JSON.stringify(blue.colour.neutral)} ${JSON.stringify(blue.colour.greyEdge)} ${JSON.stringify(blue.colour.brightNeutral)}; ${describe(blue).colour}`)
  // warm lamps on the left third, cool on the right: each zone is consistent, the zones are not
  const mixed = measure([fromRGB({ rgb: (x, y) => world(x < W / 3 ? [1.15, 1, 0.88] : x >= (2 * W) / 3 ? [0.88, 1, 1.15] : [1, 1, 1], false)(x, y) })])
  check('mixed lighting (warm left, cool right): zones disagree, described as uncertain', mixed.colour.zoneSpread.r > COLOUR.ZONE_SPREAD && /mixed or uncertain/.test(describe(mixed).colour), `zoneSpread ${JSON.stringify(mixed.colour.zoneSpread)} dis ${mixed.colour.disagreement}; ${describe(mixed).colour}`)
  const red = measure([fromRGB({ rgb: (x, y) => (x > 200 && x < 400 && y > 100 && y < 250 ? [255, 40, 40] : world([1, 1, 1])(x, y)) })])
  check('a colour too strong to show: colourClip', red.colourClip > 0.05 && grey.colourClip < 0.005, `${red.colourClip} vs ${grey.colourClip}`)
  // the same coded frame read as limited range stretches it: the cast stays, levels change
  const asLimited = measure([{ ...fromRGB({ rgb: world([1, 1, 1.15]) }), displayRange: 'limited' }])
  check('  measured in the display range and matrix given', asLimited.displayRange === 'limited' && asLimited.colour.matrix === 'bt709' && asLimited.colour.neutral.b > 0.1)
  const bt601 = measure([{ ...fromRGB({ rgb: world([1, 1, 1]) }), displayMatrix: 'smpte170m' }])
  check('  a BT.601 display matrix is used as such', bt601.displayMatrix === 'bt601' && bt601.colour.matrix === 'bt601')
}

// ---- edges ----------------------------------------------------------------------------------------
{
  const W = 1920
  const H = 1080
  const bars = (x) => ((x >> 6) & 1 ? 180 : 60)
  const sharp = measure([planar({ W, H, Y: (x) => bars(x), U: (x) => 128 + 8 * Math.sin(x / 50) })])
  const soft = measure([planar({ W, H, Y: (x) => { let s = 0; for (let d = -3; d <= 3; d++) s += bars(x + d); return s / 7 }, U: (x) => 128 + 8 * Math.sin(x / 50) })])
  check('edges: a soft picture rises over more pixels', sharp.lines.rise25 !== null && soft.lines.rise25 > sharp.lines.rise25 + 1 && sharp.lines.edges > 100, `${sharp.lines.rise25} vs ${soft.lines.rise25}`)
}

// ---- layouts: NV12, row padding, sets -------------------------------------------------------------------
{
  const f = planar({ W: 640, H: 360, Y: scene(640), U: (x) => 128 + 12 * Math.sin(x / 9), V: (x, y) => 128 + 10 * Math.cos(y / 7), displayRange: 'full' })
  const uv = new Uint8Array(f.u.length * 2)
  for (let i = 0; i < f.u.length; i++) {
    uv[2 * i] = f.u[i]
    uv[2 * i + 1] = f.v[i]
  }
  const a = measure([f])
  const b = measure([{ ...f, u: undefined, v: undefined, uv, chroma: 'NV12' }])
  check('NV12 gives the same figures as I420', a.mean === b.mean && a.neutralChroma === b.neutralChroma && JSON.stringify(a.cast) === JSON.stringify(b.cast), `${a.mean}/${b.mean} ${a.neutralChroma}/${b.neutralChroma}`)
  const padded = planar({ W: 640, H: 360, Y: scene(640), U: (x) => 128 + 12 * Math.sin(x / 9), V: (x, y) => 128 + 10 * Math.cos(y / 7), displayRange: 'full', stride: 704 })
  const c = measure([padded])
  check('  a row stride wider than the picture is honoured', c.mean === a.mean && c.p99 === a.p99)
  const ab = measure([planar({ Y: scene(640), set: 0, sinceKey: 6 }), planar({ Y: (x, y) => scene(640)(x, y) + 10, set: 1, sinceKey: 6 })])
  check('  two sets: ab.mean is |A - B|', near(ab.ab?.mean, 10, 0.6) && JSON.stringify(ab.sets) === '[1,1]', JSON.stringify(ab.ab))
}

// ---- RGBA wrappers (lab harness, old panel) ----------------------------------------------------------
{
  const W = 640
  const H = 360
  const rgba = (lo, hi) => {
    const data = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = lo + (hi - lo) * ((x / W) * 0.6 + 0.4 * ((Math.sin(x / 37) * Math.cos(y / 23) + 1) / 2))
        const t = ((x >> 6) + (y >> 6)) % 5 === 0 ? [1.1, 0.95, 0.85] : [1, 1, 1]
        const i = (y * W + x) * 4
        for (let c = 0; c < 3; c++) data[i + c] = v * t[c]
        data[i + 3] = 255
      }
    }
    return { data, width: W, height: H }
  }
  const dark = combine([measureFrame(rgba(5, 110)), measureFrame(rgba(5, 110))])
  check('RGBA: measureFrame + combine give the v2 result', dark.v === 2 && dark.planes === 'rgba' && dark.frames === 2 && dark.mean < 85, `mean ${dark.mean}`)
  const p = planesFromRGBA(rgba(5, 110))
  check('  planesFromRGBA: BT.709 full range planes', p.chroma === 'I420' && p.displayRange === 'full' && p.y.length === W * H && p.u.length === (W / 2) * (H / 2))
  const TVT = [{ path: 'bright', label: 'Brightness', kind: 'range', min: 0, max: 100, value: 50, default: 50 }, { path: 'saturation', label: 'Saturation', kind: 'range', min: 0, max: 100, value: 50, default: 50 }]
  let list = null
  try {
    list = suggest(dark, { fields: TVT }, { period: 'day' }).changes
  } catch (e) {
    list = e
  }
  check('  the rules (auto-adjust.js suggest) run on the v2 result (dark: more brightness)', Array.isArray(list) && list.some((s) => s.path === 'bright' && s.to > 50), Array.isArray(list) ? list.map((s) => s.path).join(',') : String(list))
  const d = describe(dark)
  check('  describe() on the v2 result: plain strings', ['exposure', 'colour', 'noise', 'focus', 'size'].every((k) => typeof d[k] === 'string') && Array.isArray(d.lines), JSON.stringify(d))
  check('  describe() with stream figures', /4\.9 of 5\.1 Mbit\/s \(96%\), at the cap in 9 of 10 keyframe intervals/.test(describe(dark, { stream: { enough: true, kbps: 4915, qoi: 5120, usage: 0.96, bindShare: 0.9, gops: new Array(10).fill({ kbps: 5000 }), mode: 'gops', windowS: 20 } }).stream), describe(dark, { stream: { enough: true, kbps: 4915, qoi: 5120, usage: 0.96, bindShare: 0.9, gops: new Array(10).fill({}), mode: 'gops' } }).stream)
}

// ---- display self-check ------------------------------------------------------------------------------
{
  const img = (black, white) => {
    const n = 320 * 180
    const data = new Uint8ClampedArray(n * 4)
    for (let i = 0; i < n; i++) {
      const v = i < black * n ? 0 : i >= (1 - white) * n ? 255 : 120
      data.set([v, v, v, 255], 4 * i)
    }
    return { data, width: 320, height: 180 }
  }
  // what a limited-range and a full-range display would show as black and white (Wharf OB West-like)
  const region = { limited: { black: 0.054, white: 0.02 }, full: { black: 0.0003, white: 0.012 } }
  check('self-check: the display shows what a limited-range display would -> limited (the override did not take)', displaySelfCheck(img(0.054, 0.02), region).range === 'limited')
  check('  what a full-range display would -> full', displaySelfCheck(img(0.001, 0.012), region).range === 'full')
  check('  half way between: not clearly either -> unknown', displaySelfCheck(img(0.027, 0.016), region).range === 'unknown')
  check('  a scene where the two displays would hardly differ can\'t tell -> unknown', displaySelfCheck(img(0, 0), { limited: { black: 0.004, white: 0.002 }, full: { black: 0, white: 0 } }).range === 'unknown')
  // the region: 1:1, clear of the OSD bands, where the two displays differ most; coloured
  // highlights (a channel clips) count as the display shows them, not by their luma
  const W = 1280
  const H = 720
  const y = new Uint8Array(W * H).fill(120)
  const u = new Uint8Array((W / 2) * (H / 2)).fill(128)
  const v = new Uint8Array((W / 2) * (H / 2)).fill(128)
  for (let r = 300; r < 400; r++) for (let x = 960; x < 1100; x++) y[r * W + x] = 10 // dark patch, right of centre
  for (let r = 0; r < 60; r++) for (let x = 0; x < 600; x++) y[r * W + x] = 5 // dark OSD band at the top: never used
  const rg = selfCheckRegion({ width: W, height: H, y, u, v })
  check('selfCheckRegion: 320x180 on the dark patch, clear of the top band', rg.sw === 320 && rg.sh === 180 && rg.sy >= 0.15 * H && rg.sx >= 640 && rg.limited.black > 0.2 && rg.full.black === 0, JSON.stringify(rg))
  const hot = { width: 64, height: 64, y: new Uint8Array(64 * 64).fill(240), u: new Uint8Array(32 * 32).fill(128), v: new Uint8Array(32 * 32).fill(128) }
  const grey = selfCheckRegion({ ...hot, u: hot.u, v: hot.v })
  const orange = selfCheckRegion({ ...hot, u: new Uint8Array(32 * 32).fill(80), v: new Uint8Array(32 * 32).fill(190) })
  check('  a grey highlight at 240 shows white on a limited display; a sodium-orange one at 240 does not', grey.limited.white === 1 && orange.limited.white === 0, `${JSON.stringify(grey.limited)} ${JSON.stringify(orange.limited)}`)
}
{
  // real clips (lab: exp/fx-selfcheck.mjs): each clip's region drawn 1:1 by ffmpeg as a
  // limited-range and as a full-range display, with three chroma filters
  const fx = JSON.parse(readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'selfcheck', 'clips.json'), 'utf8'))
  const img = (black, white) => {
    const n = 320 * 180
    const data = new Uint8ClampedArray(n * 4)
    for (let i = 0; i < n; i++) {
      const v = i < Math.round(black * n) ? 0 : i >= n - Math.round(white * n) ? 255 : 120
      data.set([v, v, v, 255], 4 * i)
    }
    return { data, width: 320, height: 180 }
  }
  let wrong = []
  let right = 0
  let unknown = 0
  for (const c of fx.clips) {
    for (const [shown, list] of [['limited', c.limited], ['full', c.full]]) {
      for (const d of list) {
        const r = displaySelfCheck(img(d.black, d.white), c.region).range
        if (r === shown) right++
        else if (r === 'unknown') unknown++
        else wrong.push(`${c.name} ${shown}/${d.flags}: ${r}`)
      }
    }
  }
  const total = right + unknown + wrong.length
  check(`self-check on ${fx.clips.length} real clips, limited and full displays, 3 filters: never the wrong verdict`, fx.clips.length >= 10 && wrong.length === 0, wrong.join('; '))
  check('  and the right one on most (North Gate and Maingate included, which the old check called "full" when limited)', right >= 0.85 * total && ['nvr1-13.bin', 'nvr-192-168-0-226-2.bin'].every((f) => fx.clips.find((c) => c.file === f)?.limited.every((d) => displaySelfCheck(img(d.black, d.white), fx.clips.find((c) => c.file === f).region).range === 'limited')), `${right} right, ${unknown} unknown of ${total}`)
}
{
  // frames that could not be copied out (drawn RGBA): not on the bands' scale, what was coded unknown
  const W = 1920
  const H = 1080
  const frame = (seed) => {
    const data = new Uint8ClampedArray(W * H * 4)
    let s = seed
    for (let i = 0; i < W * H; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      const v = 100 + ((s >> 16) % 5)
      data[4 * i] = data[4 * i + 1] = data[4 * i + 2] = v
      data[4 * i + 3] = 255
    }
    return { data, width: W, height: H }
  }
  const m = combine([6, 12].map((k, i) => measureFrame(frame(i + 1), { set: 0, sinceKey: k })), { stream: 'main' })
  check('RGBA frames: noise not comparable ("measured on the displayed picture"), rangeMismatch unknown (null)', m.planes === 'rgba' && m.noise.comparable === false && m.noise.notComparable === 'measured on the displayed picture' && m.rangeMismatch === null, JSON.stringify({ c: m.noise.comparable, why: m.noise.notComparable, rm: m.rangeMismatch }))
  check('  describe() says the figures are as displayed', /^as displayed in this browser/.test(describe(m).exposure) && /not comparable/.test(describe(m).noise), describe(m).exposure)
}

// ---- real-figure fixtures (written by the lab: harness.mjs --planar --gop-grab --stream --fixtures) ----
const dir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'figures')
const fixture = (name) => {
  const f = join(dir, `${name}.json`)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
}
if (!existsSync(dir)) check('real-figure fixtures present (test/fixtures/figures)', false)
else {
  const all = readdirSync(dir).filter((f) => f.endsWith('.json'))
  check(`real-figure fixtures: ${all.length} clips, all measured on coded planes`, all.length >= 5 && all.every((f) => fixture(f.replace(/\.json$/, '')).mode === 'planar'))
  const jpb = fixture('jpb-door')
  check('JPB DOOR (full-range stream, decoded as yuvj420p): coded max Y > 235', jpb && jpb.pix_fmt === 'yuvj420p' && jpb.color_range === 'pc' && jpb.figures.coded.max > 235 && jpb.figures.coded.ge235 > 0.01, jpb && `${jpb.pix_fmt}/${jpb.color_range} max ${jpb.figures.coded.max} ge235 ${jpb.figures.coded.ge235}`)
  const exit = fixture('pw-exit')
  check('PW Exit (H.265+): noise not measurable, the encoder repeats still areas', exit && !exit.figures.noise.measurable && /repeats still areas/.test(exit.figures.noise.reason) && exit.figures.noise.skip > 0.8, exit && `${exit.figures.noise.reason} skip ${exit.figures.noise.skip}`)
  const gate = fixture('north-gate')
  check('North Gate (Day profile, sharpening 199): at its cap in the looped stream figures', gate && gate.profile === 'day' && gate.stream.looped.usage >= 0.9 && gate.stream.looped.bindShare >= 0.8 && gate.settings.fields.some((f) => f.path === 'sharpen.value' && f.value === 199), gate && `usage ${gate.stream.looped.usage} bindShare ${gate.stream.looped.bindShare}`)
  check('  its noise is in the "low" band (plan: 0.48)', gate && gate.figures.noise.measurable && gate.figures.noise.value < 0.55, gate && String(gate.figures.noise.value))
  const entrance = fixture('pw-entrance')
  check('PW Entrance: colour estimators disagree (white balance must be left alone)', entrance && entrance.figures.colour && (entrance.figures.colour.disagreement > COLOUR.CAST_DISAGREE || entrance.figures.colour.zoneSpread.r > COLOUR.ZONE_SPREAD || entrance.figures.colour.zoneSpread.b > COLOUR.ZONE_SPREAD || entrance.figures.colour.neutralShare < COLOUR.NEUTRAL_SHARE), entrance && JSON.stringify({ dis: entrance.figures.colour.disagreement, zone: entrance.figures.colour.zoneSpread, share: entrance.figures.colour.neutralShare }))
  check('  and the report names no cast for it (the estimators disagree in sign): "no clear cast"', entrance && /^no clear cast/.test(describe(entrance.figures).colour) && !/cyan|red|blue|yellow|green|magenta/.test(describe(entrance.figures).colour), entrance && describe(entrance.figures).colour)
  const lcl = fixture('lcl-destuffing-door')
  check('LCL Destuffing Door: coded mean above the dark threshold (85): no brightness raise', lcl && lcl.figures.mean >= 85, lcl && String(lcl.figures.mean))
  if (!fixture('omar-river')) console.log('NOTE  Omar River: no clip of it exists yet (plan §8), so no fixture; its E1 case is settings-only')
  for (const f of all) {
    const x = fixture(f.replace(/\.json$/, ''))
    let ok = true
    try {
      describe(x.figures, { stream: x.stream?.looped })
    } catch {
      ok = false
    }
    if (!ok) check(`  describe() runs on ${f}`, false)
  }
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
