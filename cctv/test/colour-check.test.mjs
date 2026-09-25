// Offline tests for the colour check (public/colour-check.js): the CIEDE2000 formula against
// published test pairs, then synthetic ColorChecker charts drawn in perspective into a coded
// I420 frame (full range, BT.709, as TVT cameras code), with known faults added.
//   node cctv/test/colour-check.test.mjs
import { COLORCHECKER_CLASSIC, checkColours, colourSuggestions, deltaE2000, labToRgb, rgbToLab, yuvToRgb } from '../public/colour-check.js'
import { drawCard, drawChart } from '../public/colour-chart-sim.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol

// ---- CIEDE2000: test pairs from Sharma, Wu and Dalal (2005) ---------------------------------
for (const [l1, l2, want] of [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 0, 0], [50, -1, 2], 2.3669],
  [[50, 2.5, 0], [73, 25, -18], 27.1492],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373]
]) {
  const got = deltaE2000(l1, l2)
  check(`CIEDE2000 ${JSON.stringify(l1)} vs ${JSON.stringify(l2)} = ${want}`, near(got, want, 0.0001), got.toFixed(4))
}
check('CIEDE2000 is 0 for the same colour, and symmetric', deltaE2000([40, 10, -5], [40, 10, -5]) === 0 && near(deltaE2000([40, 10, -5], [60, -8, 20]), deltaE2000([60, -8, 20], [40, 10, -5]), 1e-9))

// ---- the chart values ---------------------------------------------------------------------------
check('24 patches, post-2014 values (dark skin 37.54/14.37/14.92, white 95.19/-1.03/2.93, black 20.64/0.07/-0.46)',
  COLORCHECKER_CLASSIC.length === 24 && COLORCHECKER_CLASSIC[0].lab.join() === '37.54,14.37,14.92' && COLORCHECKER_CLASSIC[18].lab.join() === '95.19,-1.03,2.93' && COLORCHECKER_CLASSIC[23].lab.join() === '20.64,0.07,-0.46')
// Lab -> sRGB -> Lab: exact for colours inside sRGB (the chart's cyan lies a little outside it)
const round = COLORCHECKER_CLASSIC.map((c) => ({ name: c.name, dE: deltaE2000(c.lab, rgbToLab(labToRgb(c.lab))) }))
check('colour maths round trip: within 0.05 for every in-gamut patch', round.filter((r) => r.name !== 'cyan').every((r) => r.dE < 0.05), round.map((r) => r.dE.toFixed(2)).join(' '))
check('  cyan is just outside sRGB (so a screen can never show it exactly)', round.find((r) => r.name === 'cyan').dE > 0.5)
check('full-range BT.709 decode: white, black and mid grey', yuvToRgb(255, 128, 128).every((v) => near(v, 1, 1e-9)) && yuvToRgb(0, 128, 128).every((v) => near(v, 0, 1e-9)) && yuvToRgb(128, 128, 128).every((v) => near(v, 128 / 255, 1e-9)))
check('limited-range decode: 16 = black, 235 = white', yuvToRgb(16, 128, 128, { range: 'limited' }).every((v) => near(v, 0, 1e-9)) && yuvToRgb(235, 128, 128, { range: 'limited' }).every((v) => near(v, 1, 1e-9)))

// ---- synthetic charts (drawn by public/colour-chart-sim.js, shared with the practice page) -------
// a chart about 700x470 px, turned and in slight perspective, like one held up in front of a camera
const upright = [[600, 300], [1330, 340], [1300, 820], [620, 790]]
const perfect = drawChart({ corners: upright })
const r0 = checkColours(perfect, upright)
check('perfect chart: read and scored', r0.ok && r0.problems.length === 0, r0.why ?? r0.problems.map((p) => p.key).join())
check('  mean dE00 under 1 (only rounding, chroma subsampling and sRGB gamut)', r0.summary.meanDE < 1, r0.summary.meanDE.toFixed(2))
check('  graded excellent; exposure, cast, saturation, hue and contrast all right', r0.summary.grade === 'excellent' && near(r0.summary.exposureStops, 0, 0.05) && r0.summary.cast.name === 'neutral' && near(r0.summary.saturation, 1, 0.03) && near(r0.summary.hueTurn, 0, 1.5) && near(r0.summary.contrast, 1, 0.03), JSON.stringify(r0.summary, (k, x) => (typeof x === 'number' ? Number(x.toFixed(3)) : x)))
check('  every patch named and has screen colours for both swatches', r0.patches.length === 24 && r0.patches.every((p) => p.refRgb.length === 3 && p.measuredRgb.length === 3 && p.name))

// the corners clicked in any order, and the chart held any way round (or seen mirrored)
const shuffled = [upright[2], upright[0], upright[3], upright[1]]
check('corners clicked in any order', checkColours(perfect, shuffled).summary.meanDE < 1)
let allWays = true
const ways = []
for (let turn = 0; turn < 4; turn++) {
  for (const mirrored of [false, true]) {
    let c = [0, 1, 2, 3].map((i) => upright[(i + turn) % 4])
    if (mirrored) c = [c[1], c[0], c[3], c[2]]
    const r = checkColours(drawChart({ corners: c }), upright)
    ways.push(r.summary.meanDE.toFixed(2))
    if (!(r.ok && r.summary.meanDE < 1)) allWays = false
  }
}
check('chart held any of the 8 ways round: found and scored', allWays, ways.join(' '))

// exposure: the picture 30% darker. Exposure-corrected score still good; the raw one isn't.
const dark = checkColours(drawChart({ corners: upright, look: (rgb) => rgb.map((c) => c * 0.7) }), upright)
check('darker exposure: corrected score stays excellent, exposure reported (-0.5 stop)', dark.summary.grade === 'excellent' && near(dark.summary.exposureStops, Math.log2(0.7), 0.05) && dark.summary.meanDERaw > 3, `${dark.summary.meanDE.toFixed(2)} corrected, ${dark.summary.meanDERaw.toFixed(2)} raw, ${dark.summary.exposureStops.toFixed(2)} stops`)

// white balance: too much red
const warm = checkColours(drawChart({ corners: upright, look: ([r, g, b]) => [r * 1.18, g, b * 0.9] }), upright)
check('red/yellow cast measured on the greys', warm.summary.cast.size > 3 && warm.summary.cast.a > 0 && warm.summary.cast.b > 0 && ['red', 'orange', 'yellow'].includes(warm.summary.cast.name), JSON.stringify(warm.summary.cast, (k, x) => (typeof x === 'number' ? Number(x.toFixed(2)) : x)))
const wb = (mode) => [
  { path: 'whiteBalance.mode', label: 'White balance', kind: 'select', options: ['auto', 'indoor', 'outdoor', 'manual'], value: mode },
  { path: 'whiteBalance.red', label: 'Red gain', kind: 'range', min: 0, max: 100, value: 50 },
  { path: 'whiteBalance.blue', label: 'Blue gain', kind: 'range', min: 0, max: 100, value: 50 },
  { path: 'saturation', label: 'Saturation', kind: 'range', min: 0, max: 100, value: 50 },
  { path: 'hue', label: 'Hue', kind: 'range', min: 0, max: 100, value: 50 },
  { path: 'contrast', label: 'Contrast', kind: 'range', min: 0, max: 100, value: 50 }
]
const sIndoor = colourSuggestions(warm, wb('indoor'))
check('  fixed "indoor" white balance: suggest auto (optional)', sIndoor.some((s) => s.path === 'whiteBalance.mode' && s.to === 'auto' && s.optional), JSON.stringify(sIndoor.map((s) => `${s.path}->${s.to}`)))
const sManual = colourSuggestions(warm, wb('manual'))
check('  manual white balance: less red gain, more blue gain', sManual.some((s) => s.path === 'whiteBalance.red' && s.to < 50) && sManual.some((s) => s.path === 'whiteBalance.blue' && s.to > 50), JSON.stringify(sManual.map((s) => `${s.path}->${s.to}`)))
check('  auto white balance: left alone (it follows the light; check again in other light)', !colourSuggestions(warm, wb('auto')).some((s) => s.path.startsWith('whiteBalance')))

// washed-out colours: each patch 35% of the way to its own grey
const washed = checkColours(drawChart({ corners: upright, look: (rgb) => {
  const Y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
  return rgb.map((c) => Y + (c - Y) * 0.65)
} }), upright)
check('washed-out colours: saturation well below 1, suggestion to raise it', washed.summary.saturation < 0.85 && colourSuggestions(washed, wb('auto')).some((s) => s.path === 'saturation' && s.to > 50), `saturation ${washed.summary.saturation.toFixed(2)}`)
check('  no suggestions at all for a perfect chart', colourSuggestions(r0, wb('auto')).length === 0)

// ---- what can go wrong ------------------------------------------------------------------------
const tiny = [[900, 500], [940, 502], [939, 528], [901, 526]]
const rt = checkColours(drawChart({ corners: tiny }), tiny)
check('chart too small in the picture: refused, with the reason', !rt.ok && rt.problems.some((p) => p.key === 'too-small' && p.fatal), rt.problems.map((p) => p.text).join(' | '))
const rm = checkColours(drawChart({ corners: upright, mono: true }), upright)
check('black-and-white picture: refused (check colours in daylight)', !rm.ok && rm.problems.some((p) => p.key === 'mono'))
const rg = checkColours(drawChart({ corners: upright, glare: 6 }), upright)
check('glare on a patch: reported and left out of the score', rg.problems.some((p) => p.key === 'clipped' && /orange/.test(p.text)) && rg.ok && rg.summary.meanDE < 1.5, rg.problems.map((p) => p.text).join(' | '))
check('bad clicks: three points, or all on a line, refused', !checkColours(perfect, upright.slice(0, 3)).ok && !checkColours(perfect, [[0, 0], [10, 10], [20, 20], [30, 30]]).ok)
const wrong = [[100, 100], [500, 110], [490, 400], [110, 390]] // clicked on the background, not the chart
const rw = checkColours(perfect, wrong)
check('corners clicked off the chart: refused as not a ColorChecker', !rw.ok && rw.problems.some((p) => p.key === 'not-found' || p.key === 'mono'), rw.problems.map((p) => p.key).join())

// ---- white or grey card -----------------------------------------------------------------------
const card = [[800, 400], [1100, 420], [1090, 640], [805, 625]]
const { checkWhiteCard, whiteCardSuggestions } = await import('../public/colour-check.js')
const white = checkWhiteCard(drawCard({ corners: card, rgb: [0.9, 0.9, 0.9] }), card)
check('white card, neutral: no cast, lightness read', white.ok && white.verdict === 'neutral' && white.cast.size < 1 && near(white.card.L, 91.5, 1.5), JSON.stringify({ L: white.card.L?.toFixed(1), cast: white.cast.size.toFixed(2), verdict: white.verdict }))
const warmCard = checkWhiteCard(drawCard({ corners: card, rgb: [0.92, 0.85, 0.72] }), card)
check('white card, warm camera: clear orange/yellow cast', warmCard.ok && ['clear cast', 'strong cast'].includes(warmCard.verdict) && ['orange', 'yellow'].includes(warmCard.cast.name), `${warmCard.verdict}, ${warmCard.cast.name}, ${warmCard.cast.size.toFixed(1)}`)
check('  fixed white balance: suggest auto; auto: nothing to suggest', whiteCardSuggestions(warmCard, wb('outdoor')).some((s) => s.path === 'whiteBalance.mode' && s.to === 'auto') && whiteCardSuggestions(warmCard, wb('auto')).length === 0)
check('  only white balance is suggested from a card (no saturation/hue/contrast guesses)', whiteCardSuggestions(warmCard, wb('manual')).every((s) => s.path.startsWith('whiteBalance')))
const blown = checkWhiteCard(drawCard({ corners: card, rgb: [1, 1, 1] }), card)
check('over-exposed card: refused (colour can’t be read)', !blown.ok && blown.problems.some((p) => p.key === 'clipped' && p.fatal))
const uneven = checkWhiteCard(drawCard({ corners: card, rgb: [0.85, 0.85, 0.85], gradient: 0.5 }), card)
check('uneven light across the card: warned', uneven.problems.some((p) => p.key === 'uneven'), uneven.problems.map((p) => p.key).join())
const tinyCard = [[900, 500], [915, 501], [914, 514], [901, 513]]
check('card too small in the picture: refused', !checkWhiteCard(drawCard({ corners: tinyCard, rgb: [0.9, 0.9, 0.9] }), tinyCard).ok)
const paper = checkWhiteCard(drawCard({ corners: card, rgb: [0.88, 0.9, 0.95] }), card)
check('slightly blue office paper: the brightener note is given', paper.problems.some((p) => p.key === 'brightener'), `${paper.cast.name} ${paper.cast.size.toFixed(1)} b=${paper.cast.b.toFixed(1)}`)

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
