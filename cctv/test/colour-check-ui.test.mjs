// Offline tests for the colour check's screen side (public/colour-check-ui.js): mapping a click
// on the video to the frame's own pixels (object-fit letterboxing, devicePixelRatio), the grid
// drawn over the video in the orientation the check found, the median of three pictures, the
// plain words, the text summary and where the results go. No DOM, no SDK.
//   node cctv/test/colour-check-ui.test.mjs
import { checkColours, checkWhiteCard, colourSuggestions, squareToQuad } from '../public/colour-check.js'
import { drawCard, drawChart, frameToRGBA, invert } from '../public/colour-chart-sim.js'
import {
  GRABS, GRAB_GAP_MS, VIDEO_LIMIT, atVideoLimit, autoWhiteBalanceNote, band, cardArea, castWords, chartCells, checkNotes, chooseBar, chooseDock, clientToFrame,
  clientToPicture, cornerTrouble, describeCard, describeChart, edgeCorners, frameToPicture, furthestOff, insetChart, loupeSpot, medianResult, objectPosition,
  orientedCorners, overlayBox, pictureRect, pictureToClient, pictureToFrame, pictureToOverlay, planesFromImageData, planesFromVideoFrame, playerFrames,
  pressTarget, provisionalOrientation, summaryText, wildSquares
} from '../public/colour-check-ui.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const near = (a, b, tol = 1e-6) => Number.isFinite(a) && Math.abs(a - b) <= tol
const isPlanes = (f) => Boolean(f && f.y && f.width > 0 && !f.error)
const nearPt = (p, q, tol = 1e-6) => near(p[0], q[0], tol) && near(p[1], q[1], tol)
const show = (x) => JSON.stringify(x, (k, v) => (typeof v === 'number' ? Number(v.toFixed(3)) : v))

// ---- where the picture is: object-fit: contain -------------------------------------------------
// a 1000 x 800 tile at (10, 20); the player's canvas is 960 x 540 (on-screen size, video's shape)
const tileBox = { left: 10, top: 20, width: 1000, height: 800 }
const pic = pictureRect(tileBox, 960, 540)
check('letterboxed: full width, bars above and below', near(pic.left, 10) && near(pic.width, 1000) && near(pic.height, 562.5) && near(pic.top, 20 + 118.75), show(pic))
const pillar = pictureRect({ left: 0, top: 0, width: 1000, height: 400 }, 1920, 1080)
check('pillarboxed: full height, bars at the sides', near(pillar.height, 400) && near(pillar.width, 400 * 16 / 9) && near(pillar.left, (1000 - 400 * 16 / 9) / 2) && near(pillar.top, 0), show(pillar))
const phone = pictureRect({ left: 0, top: 60, width: 375, height: 700 }, 1280, 720)
check('phone held upright (375 px): the picture is a band across the middle', near(phone.width, 375) && near(phone.height, 210.9375) && near(phone.top, 60 + (700 - 210.9375) / 2), show(phone))
check('object-fit: fill is the whole box; cover overflows it', show(pictureRect(tileBox, 960, 540, 'fill')) === show(tileBox) && pictureRect(tileBox, 960, 540, 'cover').height === 800 && pictureRect(tileBox, 960, 540, 'cover').width > 1000)
check('object-position: "left top" puts the bars all below', near(pictureRect(tileBox, 960, 540, 'contain', objectPosition('left top')).top, 20))
check('object-position parsing (percentages, keywords, either order)',
  show(objectPosition('50% 50%')) === '[0.5,0.5]' && show(objectPosition('left top')) === '[0,0]' && show(objectPosition('top')) === '[0.5,0]' &&
  show(objectPosition('right 25%')) === '[1,0.25]' && show(objectPosition('bottom left')) === '[0,1]' && show(objectPosition('')) === '[0.5,0.5]')
check('no picture yet (0 x 0 canvas): no rectangle', pictureRect(tileBox, 0, 0) === null)

// ---- a click -> the frame's own pixels ----------------------------------------------------------
// the frame is the video at its own size (1920 x 1080), twice the canvas: only fractions carry over
const mid = [10 + 500, 20 + 118.75 + 281.25]
check('the middle of the picture is the middle of the frame', nearPt(clientToFrame(mid[0], mid[1], pic, 1920, 1080), [959.5, 539.5]), show(clientToFrame(mid[0], mid[1], pic, 1920, 1080)))
check('the picture\'s top-left edge is -0.5, -0.5 (pixel 0\'s middle is at 0, as the check reads)', nearPt(clientToFrame(pic.left, pic.top, pic, 1920, 1080), [-0.5, -0.5]))
const px0 = [pic.left + 0.5 * (1000 / 1920), pic.top + 0.5 * (562.5 / 1080)]
check('the middle of the first frame pixel shown maps to pixel 0', nearPt(clientToFrame(px0[0], px0[1], pic, 1920, 1080), [0, 0]))
check('a click in the bar above the picture is outside it (v < 0)', clientToPicture(500, 30, pic)[1] < 0)
const corner = [1300, 820]
check('frame -> screen -> frame round trip', nearPt(pictureToFrame(clientToPicture(...pictureToClient(frameToPicture(corner, 1920, 1080), pic), pic), 1920, 1080), corner, 1e-9))
check('same click, sub stream (704 x 396) and main stream (1920 x 1080): the same place in both', nearPt(frameToPicture(clientToFrame(700, 400, pic, 704, 396), 704, 396), frameToPicture(clientToFrame(700, 400, pic, 1920, 1080), 1920, 1080), 1e-12))
const phoneMid = clientToFrame(187.5, 60 + 350, phone, 1280, 720)
check('phone: the middle of the screen is the middle of the frame', nearPt(phoneMid, [639.5, 359.5]), show(phoneMid))

// ---- the overlay canvas: exactly over the picture, sharp at any devicePixelRatio ------------------
const host = { left: 10, top: 20 }
const ov2 = overlayBox(pic, host, 2)
check('overlay sits on the picture inside the host (CSS px)', near(ov2.left, 0) && near(ov2.top, 118.75) && near(ov2.width, 1000) && near(ov2.height, 562.5), show(ov2))
check('  its backing store is devicePixelRatio (2) times that', ov2.backingWidth === 2000 && ov2.backingHeight === 1125)
check('  a frame point lands on the right backing pixel', nearPt(pictureToOverlay(frameToPicture([959.5, 539.5], 1920, 1080), ov2), [1000, 562.5]))
const ov15 = overlayBox(pic, host, 1.5)
check('  devicePixelRatio 1.5: rounded backing store', ov15.backingWidth === 1500 && ov15.backingHeight === 844)
const ovPhone = overlayBox(phone, { left: 0, top: 60 }, 3)
check('  phone (DPR 3): overlay 375 x 211 CSS px, 1125 x 633 backing', near(ovPhone.top, (700 - 210.9375) / 2) && ovPhone.backingWidth === 1125 && ovPhone.backingHeight === 633, show(ovPhone))

// ---- the grid drawn over the video: the orientation the check found --------------------------------
// smaller frames here to keep the test quick; the chart about 365 x 245 px
const W = 960
const H = 540
const up = [[300, 150], [665, 170], [650, 410], [310, 395]]
let allWays = true
const got = []
for (let turn = 0; turn < 4; turn++) {
  for (const mirrored of [false, true]) {
    let c = [0, 1, 2, 3].map((i) => up[(i + turn) % 4])
    if (mirrored) c = [c[1], c[0], c[3], c[2]]
    const r = checkColours(drawChart({ corners: c, W, H }), [up[2], up[0], up[3], up[1]]) // clicked in any order
    const oc = orientedCorners(up, r.orientation)
    // oc[0] must be where square 1 (dark skin) has its top-left corner, and so on round
    const same = r.ok && oc.every((p, i) => nearPt(p, c[i], 1e-9))
    got.push(`${r.orientation.turn}${r.orientation.mirrored ? 'm' : ''}`)
    if (!same) allWays = false
  }
}
check('orientedCorners puts square 1 where the chart really has it, all 8 ways round', allWays, got.join(' '))
const way = [0, 1, 2, 3].map((i) => up[(i + 1) % 4])
const toChart = invert(squareToQuad(way))
const cells = chartCells(orientedCorners(up, checkColours(drawChart({ corners: way, W, H }), up).orientation))
check('24 cells, each drawn over its own square (middle maps to the square\'s middle on the chart)', cells.length === 24 && cells.every((c) => nearPt(toChart(...c.centre), [(c.col + 0.5) / 6, (c.row + 0.5) / 4], 1e-9)))
check('  the part drawn as read is the middle half of each square (as colour-check.js reads)', cells.every((c) => nearPt(toChart(...c.read[0]), [(c.col + 0.25) / 6, (c.row + 0.25) / 4], 1e-9) && nearPt(toChart(...c.read[2]), [(c.col + 0.75) / 6, (c.row + 0.75) / 4], 1e-9)))
// in overlay pixels (another scale in x and y) the grid is the same grid: the found orientation carries over
const ovScale = (p) => [p[0] * 0.8 + 3, p[1] * 1.3 + 7]
const cellsOv = chartCells(orientedCorners(up.map(ovScale), checkColours(drawChart({ corners: way, W, H }), up).orientation))
check('  worked out in overlay pixels instead (different x and y scale): the same cells', cellsOv.every((c, i) => nearPt(c.centre, ovScale(cells[i].centre), 1e-9)))
check('provisional grid before the check: the long side gets the six columns', provisionalOrientation(up).turn === 0 && provisionalOrientation([[100, 100], [300, 100], [300, 400], [100, 400]]).turn === 1)
const cardC = [[800, 400], [1100, 420], [1090, 640], [805, 625]]
const toCard = invert(squareToQuad(cardC))
const area = cardArea(cardC)
check('card: the middle 70% is drawn as read', nearPt(toCard(...area[0]), [0.15, 0.15], 1e-9) && nearPt(toCard(...area[2]), [0.85, 0.85], 1e-9))
check('bad corners: no grid (three points, or all on a line)', orientedCorners(up.slice(0, 3)) === null && chartCells(null).length === 0 && cardArea([[0, 0], [1, 1], [2, 2], [3, 3]]) === null)

// ---- three pictures, one answer ------------------------------------------------------------------------
check('three pictures, 300 ms apart', GRABS === 3 && GRAB_GAP_MS === 300)
const fake = (meanDE, extra = {}) => ({ ok: true, orientation: { turn: 0, mirrored: false }, summary: { meanDE }, ...extra })
const m1 = medianResult([fake(2.2), fake(2.0), fake(2.1)])
check('median of three: the middle one, with the spread', m1.result.summary.meanDE === 2.1 && near(m1.spread, 0.2, 1e-9) && !m1.unsteady && m1.used === 3 && m1.failed === 0, show({ r: m1.result.summary.meanDE, spread: m1.spread }))
const m2 = medianResult([fake(2), fake(5), fake(3)])
check('  pictures far apart (2, 3, 5): median 3, flagged as unsteady', m2.result.summary.meanDE === 3 && m2.unsteady && near(m2.spread, 3))
const m3 = medianResult([{ error: 'no picture' }, fake(2), fake(3)])
check('  one picture failed: the other two used (the worse of two), the failure reported', m3.result.summary.meanDE === 3 && m3.used === 2 && m3.failed === 1 && m3.errors[0] === 'no picture')
const mono = { ok: false, problems: [{ key: 'mono', text: 'no colour', fatal: true }] }
const m4 = medianResult([mono, fake(2), { ...mono }])
check('  most pictures refused (2 of 3 black and white): the refusal is the answer', m4.result.ok === false && m4.result.problems[0].key === 'mono' && m4.used === 2)
const m5 = medianResult([{ error: 'x' }, mono, fake(4)])
check('  one refused, one fine: the fine one wins the tie', m5.result.ok && m5.result.summary.meanDE === 4)
const m6 = medianResult([{ error: 'timeout' }, { error: 'timeout' }, { error: 'closed' }])
check('  no picture at all: no result, the reasons kept', m6.result === null && m6.failed === 3 && m6.errors.join() === 'timeout,timeout,closed')
const m7 = medianResult([fake(2), fake(2.1, { orientation: { turn: 2, mirrored: false } }), fake(2.2)])
check('  the chart read different ways round in different pictures: unsteady', m7.unsteady && m7.orientationsDiffer)
const cardR = (size) => ({ ok: true, cast: { size, a: 0, b: -size, name: 'blue' }, card: { L: 90 }, verdict: 'slight cast', problems: [] })
const m8 = medianResult([cardR(3), cardR(2.5), cardR(3.2)], 'card')
check('  white card: median by the cast\'s size', m8.result.cast.size === 3 && near(m8.spread, 0.7, 1e-9) && !m8.unsteady)
// real pictures: the same chart three times with a little noise, then one darker
const upF = [[600, 300], [1330, 340], [1300, 820], [620, 790]]
const base = drawChart({ corners: upF })
const noisy = (f, seed) => {
  const y = f.y.slice()
  let s = seed
  for (let i = 0; i < y.length; i += 5) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    y[i] = Math.max(0, Math.min(255, y[i] + (s % 3) - 1))
  }
  return { ...f, y }
}
const real = [1, 2, 3].map((k) => checkColours(noisy(base, k), upF))
const mr = medianResult(real)
check('  real pictures (noise only): steady, median is one of them', mr.result.ok && !mr.unsteady && real.includes(mr.result) && mr.spread < 0.2, `spread ${mr.spread.toFixed(3)}`)

// ---- plain words -----------------------------------------------------------------------------------------
check('dE00 bands: under 3, 3-6, 6-10, over 10', band(2.99).key === 'good' && band(3).key === 'small' && band(6).key === 'clear' && band(10).key === 'poor' && band(NaN).key === 'none')
const perfect = checkColours(base, upF)
const dp = describeChart(perfect.summary)
check('perfect chart in words: all about right', dp.grade === 'Excellent' && dp.band === 'good' && [dp.saturation, dp.hue, dp.contrast, dp.exposure].every((t) => t === 'about right') && /neutral/.test(dp.whiteBalance), show(dp))
const dark = describeChart(checkColours(drawChart({ corners: upF, look: (rgb) => rgb.map((c) => c * 0.7) }), upF).summary)
check('darker exposure in words: half a stop darker, allowed for', /^0\.5 stop darker than ideal/.test(dark.exposure), dark.exposure)
const warmR = checkColours(drawChart({ corners: upF, look: ([r, g, b]) => [r * 1.18, g, b * 0.9] }), upF)
check('warm camera in words: a clear orange cast', describeChart(warmR.summary).whiteBalance === 'clear orange cast (6.2)', describeChart(warmR.summary).whiteBalance)
const washedR = checkColours(drawChart({ corners: upF, look: (rgb) => {
  const Y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
  return rgb.map((c) => Y + (c - Y) * 0.65)
} }), upF)
check('washed-out colours in words: weaker than the chart', /% weaker than the chart \(washed out\)/.test(describeChart(washedR.summary).saturation), describeChart(washedR.summary).saturation)
check('hue and contrast wording, both ways', /reds lean orange/.test(describeChart({ ...perfect.summary, hueTurn: 8 }).hue) && /reds lean pink/.test(describeChart({ ...perfect.summary, hueTurn: -8 }).hue) &&
  /too little/.test(describeChart({ ...perfect.summary, contrast: 0.8 }).contrast) && /too much/.test(describeChart({ ...perfect.summary, contrast: 1.25 }).contrast))
check('cast words on the card\'s scale', castWords({ size: 1, name: 'neutral' }).startsWith('neutral') && castWords({ size: 3, name: 'blue' }) === 'slight blue cast (3.0)' && castWords({ size: 12, name: 'yellow' }).startsWith('strong'))
const cardWarm = checkWhiteCard(drawCard({ corners: cardC, rgb: [0.92, 0.85, 0.72] }), cardC)
const dc = describeCard(cardWarm)
check('white card in words: verdict, cast, lightness', dc.verdict === 'Strong colour cast' && /yellow cast/.test(dc.cast) && /of 100/.test(dc.lightness), show(dc))

const wbField = (value) => [{ path: 'whiteBalance.mode', value }]
check('a clear cast on auto white balance: a note says why nothing is suggested', /already on auto/.test(autoWhiteBalanceNote(cardWarm.cast, wbField('auto'), [])) &&
  autoWhiteBalanceNote(cardWarm.cast, wbField('outdoor'), [{ path: 'whiteBalance.mode' }]) === null && autoWhiteBalanceNote({ size: 1 }, wbField('auto'), []) === null && autoWhiteBalanceNote(cardWarm.cast, [], []) === null)

// ---- the text summary ---------------------------------------------------------------------------------------
const wb = [
  { path: 'whiteBalance.mode', label: 'White balance', kind: 'select', options: ['auto', 'indoor', 'outdoor', 'manual'], value: 'indoor' },
  { path: 'saturation', label: 'Saturation', kind: 'range', min: 0, max: 100, value: 50 }
]
const warmMedian = medianResult([warmR, warmR, warmR])
const text = summaryText({ kind: 'chart', median: warmMedian, camera: '3 Yard gate', at: '24/09/2026 10:12', suggestions: colourSuggestions(warmR, wb) })
const lines = text.split('\n')
check('text summary: what, which camera, when', lines[0] === 'Colour check with a ColorChecker Classic chart' && lines.includes('Camera: 3 Yard gate') && lines.includes('When: 24/09/2026 10:12'), lines.slice(0, 3).join(' | '))
check('  the result with the exposure-corrected and raw averages', lines.some((l) => /^Result: Good, average colour difference \d+\.\d ΔE00 \(exposure evened out; \d+\.\d as the camera shows it\)$/.test(l)), lines.find((l) => l.startsWith('Result')))
check('  the plain-word lines and the suggestion', ['White balance: clear orange cast (6.2)', 'Hue: about right'].every((l) => lines.includes(l)) && lines.some((l) => l.startsWith('- White balance: indoor → auto')))
check('  all 24 squares with their dE00 (a colon before each number: "neutral 3.5" ends in one)', /1 dark skin: \d+\.\d/.test(text) && /24 black 2: \d+\.\d/.test(text) && /23 neutral 3\.5: \d+\.\d/.test(text) && (text.match(/ · /g) ?? []).length === 20)
check('  the three furthest off, each difference in brackets', /^Furthest off: [a-z .\d]+ \(\d+\.\d\), [a-z .\d]+ \(\d+\.\d\), [a-z .\d]+ \(\d+\.\d\)$/m.test(text), lines.find((l) => l.startsWith('Furthest')))
check('  how many pictures, and that they agreed', lines.some((l) => l === 'Pictures: 3 of 3 pictures, median; they agreed within 0.0 ΔE00'), lines.find((l) => l.startsWith('Pictures')))
const refused = summaryText({ kind: 'chart', median: medianResult([mono, mono, mono]) })
check('  refused: "not checked" with the reason, no score', /Result: not checked\n- no colour/.test(refused) && !/ΔE00 \(/.test(refused))
const cardText = summaryText({ kind: 'card', median: medianResult([cardWarm], 'card'), suggestions: [] })
check('  white card: verdict, cast and lightness; no squares', /Result: Strong colour cast/.test(cardText) && /Cast: strong yellow cast/.test(cardText) && /Lightness: \d+ of 100/.test(cardText) && !/dark skin/.test(cardText))
check('  no picture: says so, with the reason', /no picture could be read \(timeout; closed\)/.test(summaryText({ kind: 'chart', median: m6 })))
const glareR = checkColours(drawChart({ corners: upF, glare: 6 }), upF)
check('  a square left out for glare says so, and the note is there', /7 orange: left out/.test(summaryText({ kind: 'chart', median: medianResult([glareR]) })) && /Note: Glare/.test(summaryText({ kind: 'chart', median: medianResult([glareR]) })))

// ---- where the results go ------------------------------------------------------------------------------------
const phoneHost = [375, 700]
const phonePic = { left: 0, top: (700 - 210.9375) / 2, width: 375, height: 210.9375 }
const dPhone = chooseDock(...phoneHost, phonePic, [0.5, 0.5])
check('phone upright: results in the bar below the picture, not over it', dPhone.side === 'bottom' && !dPhone.covers && near(dPhone.top, phonePic.top + phonePic.height + 8) && dPhone.maxHeight > 200, show(dPhone))
const dWide = chooseDock(1800, 600, { left: (1800 - 1066.67) / 2, top: 0, width: 1066.67, height: 600 }, [0.5, 0.5])
check('wide tile with bars at the sides: results beside the picture', dWide.side === 'right' && !dWide.covers && dWide.left >= (1800 + 1066.67) / 2, show(dWide))
const filled = { left: 0, top: 0, width: 1280, height: 720 }
check('picture fills the tile: over the side away from the chart', chooseDock(1280, 720, filled, [0.3, 0.5]).side === 'right' && chooseDock(1280, 720, filled, [0.8, 0.5]).side === 'left' && chooseDock(1280, 720, filled, [0.8, 0.5]).covers)
const dNarrow = chooseDock(375, 211, { left: 0, top: 0, width: 375, height: 211 }, [0.5, 0.3])
check('phone on its side (picture fills a short tile): a sheet at the bottom, away from the chart', dNarrow.side === 'bottom' && dNarrow.covers && dNarrow.bottom === 8 && dNarrow.top === undefined, show(dNarrow))

// ---- the magnifier: beside the point, never over the dialog -------------------------------------------------
const bar = { left: 250, top: 8, width: 780, height: 140 }
check('magnifier goes above-left of the point when that is clear', show(loupeSpot(600, 400, 60, 80, [1272, 715], bar)) === '[520,320]')
check('  and moves to another corner rather than cover the corner bar', (() => {
  const [cx, cy] = loupeSpot(400, 200, 60, 80, [1272, 715], bar)
  return cy - 60 > bar.top + bar.height || cx + 60 < bar.left
})(), show(loupeSpot(400, 200, 60, 80, [1272, 715], bar)))
check('  near the top-left of the tile: below-right, inside the tile', show(loupeSpot(20, 20, 60, 80, [1272, 715])) === '[100,100]')

// ---- pictures as the browser shows them (player.grab()'s ImageData) -----------------------------------------
const small = [[150, 75], [332, 85], [325, 205], [155, 197]]
const sim = drawChart({ corners: small, W: 480, H: 270 })
const planes = planesFromImageData({ data: frameToRGBA(sim), width: 480, height: 270 })
const direct = checkColours(sim, small)
const viaRgba = checkColours(planes, small, planes.decode)
check('RGBA pixels -> planes: marked full range BT.709, and the check reads the same colours', planes.decode.range === 'full' && planes.decode.matrix === 'bt709' && viaRgba.ok && Math.abs(viaRgba.summary.meanDE - direct.summary.meanDE) < 0.5, `${direct.summary.meanDE.toFixed(2)} direct, ${viaRgba.summary.meanDE.toFixed(2)} via RGBA`)

// without the display range fix the browser shows TVT's full-range video as limited range
const contrastField = [{ path: 'contrast', label: 'Contrast', kind: 'range', min: 0, max: 100, value: 50 }]
const limitedRGBA = { data: frameToRGBA(sim, { range: 'limited' }), width: 480, height: 270 }
const naive = checkColours(planesFromImageData(limitedRGBA), small)
check('the browser\'s limited-range picture read as if exact: a perfect camera looks too contrasty (why it must not be)', naive.summary.contrast > 1.1 && colourSuggestions(naive, contrastField).length === 1, `contrast ${naive.summary.contrast.toFixed(3)}`)
const undone = planesFromImageData(limitedRGBA, { shown: { range: 'limited', matrix: 'bt709' } })
const undoneR = checkColours(undone, small, undone.decode)
check('  told how the browser showed it, its conversion is undone: contrast right, no suggestion', Math.abs(undoneR.summary.contrast - 1) < 0.1 && colourSuggestions(undoneR, contrastField).length === 0 && Math.abs(undoneR.summary.meanDE - direct.summary.meanDE) < 1,
  `contrast ${undoneR.summary.contrast.toFixed(3)}, mean ${undoneR.summary.meanDE.toFixed(2)} (direct ${direct.summary.meanDE.toFixed(2)})`)
check('  the white square the browser cut off is left out (not misread), and the planes say they came from the screen', undoneR.patches[18].clipped > 0.2 && undone.source === 'screen' && undone.shown.range === 'limited' && undone.decode.range === 'full')

// ---- pictures from the player: the values the camera coded -----------------------------------------------
/** A stand-in for a decoded VideoFrame, as grabAfterKey hands one to its sink. */
function fakeVideoFrame(f, format = 'I420') {
  const { width: FW, height: FH } = f
  const cw = FW / 2
  const chh = FH / 2
  let bytes
  let layout
  if (format === 'I420') {
    bytes = new Uint8Array(FW * FH * 1.5)
    bytes.set(f.y, 0)
    bytes.set(f.u, FW * FH)
    bytes.set(f.v, FW * FH + cw * chh)
    layout = [{ offset: 0, stride: FW }, { offset: FW * FH, stride: cw }, { offset: FW * FH + cw * chh, stride: cw }]
  } else if (format === 'NV12') {
    bytes = new Uint8Array(FW * FH * 1.5)
    bytes.set(f.y, 0)
    for (let i = 0; i < cw * chh; i++) {
      bytes[FW * FH + 2 * i] = f.u[i]
      bytes[FW * FH + 2 * i + 1] = f.v[i]
    }
    layout = [{ offset: 0, stride: FW }, { offset: FW * FH, stride: FW }]
  } else {
    // I420P10: 16-bit little-endian samples holding 10 bits
    bytes = new Uint8Array(FW * FH * 3)
    const dv = new DataView(bytes.buffer)
    const put = (src, off) => src.forEach((x, i) => dv.setUint16(off + 2 * i, x * 4, true))
    put(f.y, 0)
    put(f.u, 2 * FW * FH)
    put(f.v, 2 * FW * FH + 2 * cw * chh)
    layout = [{ offset: 0, stride: 2 * FW }, { offset: 2 * FW * FH, stride: 2 * cw }, { offset: 2 * FW * FH + 2 * cw * chh, stride: 2 * cw }]
  }
  const frame = {
    format, codedWidth: FW, codedHeight: FH, visibleRect: { x: 0, y: 0, width: FW, height: FH }, displayWidth: FW, displayHeight: FH, closed: false,
    allocationSize: () => bytes.length,
    copyTo: async (buf) => {
      buf.set(bytes)
      return layout
    },
    close() {
      frame.closed = true
    }
  }
  return frame
}
const formatsOk = []
for (const fmt of ['I420', 'NV12', 'I420P10']) {
  const p = await planesFromVideoFrame(fakeVideoFrame(sim, fmt))
  const r = checkColours(p, small, p.decode)
  if (p.source === 'coded' && near(r.summary.meanDE, direct.summary.meanDE, 1e-9)) formatsOk.push(fmt)
}
check('decoded frames (I420, NV12, 10-bit I420): the coded values, read exactly as the camera coded them', formatsOk.length === 3, formatsOk.join(' '))

/** A stand-in for the app's VideoPlayer's grabAfterKey (it tells the sink the display is limited range, as without the fix). */
function fakePlayer({ fail = null, stop = null, fps = 25 } = {}) {
  const p = {
    stats: { fps },
    calls: [],
    made: [],
    grabAfterKey(opts) {
      p.calls.push(opts)
      if (fail) return Promise.reject(new Error(fail))
      if (opts.signal?.aborted) return Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
      const n = stop ?? opts.offsets.length
      for (let i = 0; i < n; i++) {
        const vf = fakeVideoFrame(sim)
        p.made.push(vf)
        opts.sink(vf, { set: 0, sinceKey: opts.offsets[i], displayRange: 'limited', displayMatrix: 'bt709' })
      }
      return Promise.resolve({ frames: n, complete: n === opts.offsets.length, reason: n === opts.offsets.length ? 'complete' : 'timeout' })
    }
  }
  return p
}
const pl = fakePlayer()
const three = await playerFrames(() => pl)(3)
check('playerFrames: three coded pictures in one grab, 300 ms apart at the camera\'s frame rate (25 fps: every 8th frame)', three.length === 3 && three.every((f) => f.source === 'coded' && f.decode.range === 'full') &&
  show(pl.calls[0].offsets) === '[0,8,16]' && pl.calls[0].sets === 1, show(pl.calls[0].offsets))
check('  every frame handed over is closed (the decoder has only a few)', pl.made.length === 3 && pl.made.every((f) => f.closed))
check('  the coded values, whatever the browser\'s display does', near(checkColours(three[1], small, three[1].decode).summary.meanDE, direct.summary.meanDE, 1e-9))
const busy = await playerFrames(() => fakePlayer({ fail: 'a measurement is already running' }))(3).catch((e) => e.message)
const none = await playerFrames(() => null)(3).catch((e) => e.message)
check('  refusals in plain words: Auto adjust running, no video', /Auto adjust/.test(busy) && /isn’t playing/.test(none), `${busy} | ${none}`)
const short2 = await playerFrames(() => fakePlayer({ stop: 2 }))(3)
check('  a grab that ends early: the missing picture says why', short2.length === 3 && isPlanes(short2[1]) && short2[2].error === 'no more pictures came in time', show(short2[2]))
const aborted = new AbortController()
aborted.abort()
const abortName = await playerFrames(() => fakePlayer())(3, { signal: aborted.signal }).catch((e) => e.name)
check('  a cancelled check stops the grab (AbortError passes through)', abortName === 'AbortError')
const screenPlayer = {
  displayColour: () => ({ range: 'limited', matrix: 'bt709', rangeFixed: false }),
  grab: async () => ({ data: frameToRGBA(sim, { range: 'limited' }), width: 480, height: 270 })
}
const shot = await playerFrames(() => screenPlayer, { gapMs: 0 })(2)
const shotR = checkColours(shot[0], small, shot[0].decode)
check('  a player without grabAfterKey: the picture as shown, the browser\'s conversion undone', shot.length === 2 && shot[0].source === 'screen' && Math.abs(shotR.summary.contrast - 1) < 0.1, `contrast ${shotR.summary.contrast.toFixed(3)}`)
check('  and the results will say it was read from the screen', checkNotes({ kind: 'chart', result: shotR, frames: shot }).some((t) => /as this browser shows it/.test(t)) && checkNotes({ kind: 'chart', result: direct, frames: three }).length === 0)
const shotText = summaryText({ kind: 'chart', median: medianResult([shotR]), notes: checkNotes({ kind: 'chart', result: shotR, frames: shot }), screen: true })
check('  the white the browser cut off is put down to the browser, not called glare', !/Note: Glare/.test(shotText) && /here: white 9\.5\): that can be the browser rather than glare/.test(shotText))

// ---- placing corners on a phone -----------------------------------------------------------------------------
// a small chart the check accepts (its corners 14-21 CSS px apart on a 375 px screen): four taps, four corners
const phoneSize = [375, 211]
const tiny = [[0.4, 0.45], [0.456, 0.45], [0.456, 0.516], [0.4, 0.516]]
const placed = []
const actions = tiny.map((t) => {
  const a = pressTarget(placed, t, phoneSize, 'touch')
  if (a === -1) placed.push(t)
  return a
})
check('four taps on a small chart\'s corners place four corners (none is taken for moving the one before)', placed.length === 4 && actions.every((a) => a === -1), show(actions))
check('  with all four placed, a tap near one picks it up; a tap far from all does nothing', pressTarget(placed, [0.458, 0.452], phoneSize, 'touch') === 1 && pressTarget(placed, [0.9, 0.9], phoneSize, 'touch') === null)
check('  a mouse must be closer (10 px) than a finger (22 px)', pressTarget(placed, [0.4 - 15 / 375, 0.45], phoneSize, 'mouse') === null && pressTarget(placed, [0.4 - 15 / 375, 0.45], phoneSize, 'touch') === 0 &&
  pressTarget(placed, [0.4 - 8 / 375, 0.45], phoneSize, 'mouse') === 0)

// ---- corners put on the chart's black edge -------------------------------------------------------------------
const bordered = drawChart({ corners: up, W, H, border: 0.4 })
const Hup = squareToQuad(up)
const atUp = (u, v) => {
  const w = Hup.g * u + Hup.h * v + 1
  return [(Hup.a * u + Hup.b * v + Hup.c) / w, (Hup.d * u + Hup.e * v + Hup.f) / w]
}
const edgeClicks = [atUp(-0.4 / 6, -0.1), atUp(1 + 0.4 / 6, -0.1), atUp(1 + 0.4 / 6, 1.1), atUp(-0.4 / 6, 1.1)]
const asClicked = checkColours(bordered, edgeClicks)
const edge = edgeCorners(bordered, edgeClicks, asClicked)
const edgeTrouble = cornerTrouble(asClicked, edge)
check('corners on the black edge: the engine alone gives a believable wrong score', asClicked.ok && asClicked.summary.meanDE > 5, `mean ${asClicked.summary.meanDE.toFixed(2)}`)
check('  the UI finds the mistake: moved in, the corners fit the chart', edgeTrouble?.kind === 'edge' && edge.meanDE < 1 && /black edge/.test(edgeTrouble.text), edge && `border ${edge.border}, mean ${edge.meanDE.toFixed(2)}`)
const truthQ = orientedCorners(up, { turn: 0 })
const offPx = edge ? Math.max(...orientedCorners(edge.corners, { turn: 0 }).map((p, i) => Math.hypot(p[0] - truthQ[i][0], p[1] - truthQ[i][1]))) : Infinity
check('  and the corners it offers are near the true ones (within a tenth of a square)', offPx < 0.1 * 365 / 6, `${offPx.toFixed(1)} px`)
const edgeText = summaryText({ kind: 'chart', median: medianResult([asClicked]), trouble: edgeTrouble })
check('  no grade in the summary, only "check the corners"', /Result: not scored: the corners need checking/.test(edgeText) && !/Result: (Fair|Good|Poor|Excellent)/.test(edgeText))
check('insetChart: a quad moved in by the edge width is the patch area again', (() => {
  const back = insetChart(orientedCorners(edgeClicks, asClicked.orientation), 0.4)
  return back && orientedCorners(back, { turn: 0 }).every((p, i) => nearPt(p, truthQ[i], 1e-6))
})())
const troubleFor = (look) => {
  const f = drawChart({ corners: up, W, H, look, border: 0.4 })
  const r = checkColours(f, up)
  return cornerTrouble(r, edgeCorners(f, up, r))?.kind ?? 'none'
}
const lumaOf = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
const faults = {
  right: (rgb) => rgb,
  warm: ([r, g, b]) => [r * 1.18, g, b * 0.9],
  tungstenPreset: ([r, g, b]) => [r * 0.6, g, b * 1.6],
  washed: (rgb) => rgb.map((c) => lumaOf(rgb) + (c - lumaOf(rgb)) * 0.4),
  crushed: (rgb) => rgb.map((c) => Math.max(0, (c - 0.2) * 2.5))
}
const faultKinds = Object.entries(faults).map(([k, look]) => `${k}:${troubleFor(look)}`)
check('  right corners are never taken for wrong ones, whatever the camera does (a cast, washed out, crushed shadows)', faultKinds.every((t) => t.endsWith(':none')), faultKinds.join(' '))
const whiteAsBlack = { ...perfect, patches: perfect.patches.map((p) => (p.n === 19 ? { ...p, measured: [9, 0, 0], dE: 80 } : p)) }
check('squares out of order (white read as black) are wild: no grade, no suggestions', wildSquares(whiteAsBlack).map((p) => p.name).join() === 'white 9.5' && cornerTrouble(whiteAsBlack)?.kind === 'wild')
const crushedGreys = { ...perfect, patches: perfect.patches.map((p) => (p.n >= 23 ? { ...p, measured: [8 - (p.n - 23), 0, 0], dE: 20 } : p)) }
check('  dark greys crushed together are not out of order', wildSquares(crushedGreys).length === 0)

// ---- things worth knowing -------------------------------------------------------------------------------------
const mirrorR = checkColours(drawChart({ corners: [up[1], up[0], up[3], up[2]], W, H }), up)
const mirrorFields = [{ path: 'mirrorSwitch', label: 'Mirror', value: true }, { path: 'flipSwitch', label: 'Flip', value: false }]
const mirrorNotes = checkNotes({ kind: 'chart', result: mirrorR, fields: mirrorFields })
check('a mirrored picture: the camera\'s Mirror or Flip is on, said with what the panel shows', mirrorR.ok && mirrorR.orientation.mirrored && mirrorNotes.length === 1 && /Mirror or Flip/.test(mirrorNotes[0]) && /Mirror on, Flip off/.test(mirrorNotes[0]), mirrorNotes[0])
check('  and it reaches the text summary', /Note: The picture is mirrored/.test(summaryText({ kind: 'chart', median: medianResult([mirrorR]), notes: mirrorNotes })))
check('  a chart held upside down is not mirrored: nothing said', checkNotes({ kind: 'chart', result: checkColours(drawChart({ corners: [up[2], up[3], up[0], up[1]], W, H }), up) }).length === 0)
check('video colours can\'t show cyan exactly (about 3.5): it alone is out of their reach', VIDEO_LIMIT.filter((x) => x > 1).length === 1 && VIDEO_LIMIT[17] > 3 && VIDEO_LIMIT[17] < 4, VIDEO_LIMIT[17].toFixed(2))
const perfectCyan = perfect.patches[17]
check('  so on a perfect camera cyan is not "furthest off", and the summary says why', atVideoLimit(perfectCyan) && !furthestOff(perfect).some((p) => p.n === 18) &&
  /cyan: video colours can’t show cyan exactly/.test(summaryText({ kind: 'chart', median: medianResult([perfect]) })), `cyan ${perfectCyan.dE.toFixed(2)}`)
check('  a camera that gets cyan clearly wrong still has it counted; other squares have no such allowance', !atVideoLimit({ n: 18, dE: 6 }) && atVideoLimit({ n: 18, dE: 3.4 }) && !atVideoLimit({ n: 13, dE: 3.4 }))

// ---- where the results and the corner bar go --------------------------------------------------------------------
const wide = { left: 0, top: 0, width: 1264, height: 711 }
const dChart = chooseDock(1264, 711, wide, { left: 0.29, right: 0.72, top: 0.25, bottom: 0.8 })
check('results over the picture: as narrow as keeps them off the chart', dChart.side === 'left' && !dChart.covers && dChart.left + dChart.width <= 0.29 * 1264 && dChart.width >= 280, show(dChart))
const dBig = chooseDock(1264, 711, wide, { left: 0.1, right: 0.9, top: 0.1, bottom: 0.9 })
check('  a chart filling the picture: the narrowest panel, said to cover it', dBig.width === 280 && dBig.covers)
const phoneBand = chooseDock(375, 559, { left: 0, top: 174, width: 375, height: 211 }, { left: 0.3, right: 0.7, top: 0.28, bottom: 0.76 })
check('phone upright: the short band below takes the picture\'s edge too, as far as the chart', phoneBand.side === 'bottom' && phoneBand.bottom === 8 && phoneBand.maxHeight > 174 - 16 && 559 - 8 - phoneBand.maxHeight >= 174 + 0.76 * 211 - 0.01, show(phoneBand))
const land = chooseBar(789, 240, { left: 185, top: 0, width: 427, height: 240 }, 116)
check('corner bar, phone on its side (bands only at the sides): a column in the wider side band, off the picture', land.mode === 'column' && land.where === 'left' && land.left + land.width <= 185 && land.width >= 150, show(land))
check('  a tile with room above the picture: in the band above', show(chooseBar(1000, 800, { left: 0, top: 119, width: 1000, height: 562 }, 100)) === '{"mode":"band","where":"top","top":13}')
check('  no room anywhere: over the picture (then shortened)', chooseBar(1280, 720, { left: 0, top: 0, width: 1280, height: 720 }, 100).mode === 'over')

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
