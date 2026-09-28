// Offline tests for the playback page's view window (public/pb-view.js): which part of the day is on
// screen (zoom, pan, follow), the tick ladder and labels, the clock format and the lane boxes drawn
// for each recorded stretch. No DOM, so this runs anywhere:
//   node cctv/test/pb-view.test.mjs
//
// Everything is absolute milliseconds, as state.view and pb-sources.js already are, and wall-clock
// times come from a time-zone offset rather than the machine's own. So the expected clock strings are
// derived with fmtClock itself, never written out: the tests then say the same thing in every
// timezone, and the two offsets below (UTC and +05:30) prove the offset is really being used.
import {
  DAY_MS,
  MAX_BOXES,
  fmtClock,
  follow,
  laneBoxes,
  makeView,
  panBy,
  spanLabel,
  tickStep,
  ticks,
  zoomAt
} from '../public/pb-view.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

const S = 1000
const TZ = 5.5 * 3600 * S // a half-hour offset, so an hour ladder cannot accidentally line up
// Midnight local on the day shown, the way the page works it out (dayStartOf in playback.js).
const dayStart = Date.parse('2026-09-25T00:00:00Z') - TZ
const dayEnd = dayStart + DAY_MS
const day = { dayStartMs: dayStart, dayEndMs: dayEnd }

/** A window is valid when it sits inside its day and its span is within its own limits. */
const valid = (v) =>
  v.startMs >= v.dayStartMs &&
  v.endMs <= v.dayEndMs &&
  near(v.endMs, v.startMs + v.spanMs) &&
  v.spanMs >= v.minSpanMs - 1e-9 &&
  v.spanMs <= v.maxSpanMs + 1e-9

// ---- makeView -------------------------------------------------------------------------------------
{
  const v = makeView({ spanMs: 3600 * S, startMs: dayStart + 3600 * S, ...day })
  check('makeView: keeps a window that is already valid, and works out endMs', v.spanMs === 3600 * S && v.startMs === dayStart + 3600 * S && v.endMs === dayStart + 7200 * S)
  check('  the span is clamped to minSpanMs', makeView({ spanMs: 1, startMs: dayStart, minSpanMs: 30 * S, ...day }).spanMs === 30 * S)
  check('  and to maxSpanMs', makeView({ spanMs: DAY_MS * 4, startMs: dayStart, maxSpanMs: 7200 * S, ...day }).spanMs === 7200 * S)
  check('  a span longer than the day cannot happen even when maxSpanMs asks for one', makeView({ spanMs: DAY_MS * 2, startMs: dayStart, maxSpanMs: DAY_MS * 2, ...day }).spanMs === DAY_MS)
  check('  a start before the day is pulled forward to its first moment', makeView({ spanMs: 600 * S, startMs: dayStart - 5_000_000, ...day }).startMs === dayStart)
  check('  a start past the day is pulled back so the window ends with the day', makeView({ spanMs: 600 * S, startMs: dayEnd + 1, ...day }).startMs === dayEnd - 600 * S)
  const full = makeView({ spanMs: DAY_MS, startMs: dayStart + 45_000_000, ...day })
  check('  a full-day span pins startMs to the start of the day', full.startMs === dayStart && full.endMs === dayEnd)
  check('  the day it was clamped against travels with the view, as do the limits', v.dayStartMs === dayStart && v.dayEndMs === dayEnd && makeView({ spanMs: 60 * S, startMs: dayStart, minSpanMs: 20 * S, ...day }).minSpanMs === 20 * S)
  check('  with no day given it covers one day from the start given', valid(makeView({ spanMs: 600 * S, startMs: dayStart })) && makeView({ spanMs: 600 * S, startMs: dayStart }).dayEndMs === dayEnd)
  check('  rubbish in gives a valid window rather than NaN', valid(makeView({ spanMs: NaN, startMs: NaN, ...day })) && valid(makeView({})))
  const src = makeView({ spanMs: 600 * S, startMs: dayStart + 100_000, ...day })
  check('  makeView of a view is the same window again (idempotent)', JSON.stringify(makeView(src)) === JSON.stringify(src))
}

// ---- zoomAt ---------------------------------------------------------------------------------------
{
  const v = makeView({ spanMs: 3600 * S, startMs: dayStart + 30_000 * S, minSpanMs: 30 * S, maxSpanMs: DAY_MS, ...day })
  const at = dayStart + 31_800 * S // half way across
  const frac = (x, w) => (x - w.startMs) / w.spanMs
  const zin = zoomAt(v, 0.5, at)
  check('zoomAt: zooming in halves the span', zin.spanMs === 1800 * S, String(zin.spanMs))
  check('  the moment under the pointer stays under the same pixel', near(frac(at, zin), frac(at, v)), `${frac(at, zin)} vs ${frac(at, v)}`)
  const zout = zoomAt(v, 2, at)
  check('  zooming out doubles the span and still holds that moment still', zout.spanMs === 7200 * S && near(frac(at, zout), frac(at, v)))
  check('  the original view is untouched', v.spanMs === 3600 * S && v.startMs === dayStart + 30_000 * S)

  const atEdge = zoomAt(v, 0.5, v.startMs)
  check('  pointing at the left edge keeps that edge', near(atEdge.startMs, v.startMs) && atEdge.spanMs === 1800 * S)
  check('  pointing at the right edge keeps that edge', near(zoomAt(v, 0.5, v.endMs).endMs, v.endMs))

  // The awkward cases: naive maths puts startMs before the day or endMs past its end here.
  const first = makeView({ spanMs: 3600 * S, startMs: dayStart, ...day })
  const outFirst = zoomAt(first, 2, dayStart)
  check('zoomAt: zooming out at the very first moment of the day stays valid', valid(outFirst) && outFirst.startMs === dayStart, JSON.stringify(outFirst))
  check('  and zooming in at it too', valid(zoomAt(first, 0.25, dayStart)) && zoomAt(first, 0.25, dayStart).startMs === dayStart)
  const last = makeView({ spanMs: 3600 * S, startMs: dayEnd - 3600 * S, ...day })
  const outLast = zoomAt(last, 2, dayEnd)
  check('zoomAt: zooming out at the very last moment of the day stays valid', valid(outLast) && outLast.endMs === dayEnd, JSON.stringify(outLast))
  check('  and zooming in at it too', valid(zoomAt(last, 0.25, dayEnd)) && zoomAt(last, 0.25, dayEnd).endMs === dayEnd)
  check('  a pointer outside the window (a stale pointer during a wheel burst) still gives a valid window', valid(zoomAt(last, 0.5, dayStart)) && valid(zoomAt(first, 0.5, dayEnd)))

  const tiny = makeView({ spanMs: 30 * S, startMs: dayStart + 1000 * S, minSpanMs: 30 * S, maxSpanMs: 7200 * S, ...day })
  check('zoomAt: cannot zoom in past minSpanMs', zoomAt(tiny, 0.1, dayStart + 1010 * S).spanMs === 30 * S)
  const wide = makeView({ spanMs: 7200 * S, startMs: dayStart + 1000 * S, minSpanMs: 30 * S, maxSpanMs: 7200 * S, ...day })
  check('  cannot zoom out past maxSpanMs', zoomAt(wide, 10, dayStart + 4000 * S).spanMs === 7200 * S)
  check('  a silly factor gives a valid window back rather than NaN', valid(zoomAt(v, 0, at)) && valid(zoomAt(v, NaN, at)) && valid(zoomAt(v, -2, at)))
}

// ---- panBy ----------------------------------------------------------------------------------------
{
  const v = makeView({ spanMs: 3600 * S, startMs: dayStart + 30_000 * S, ...day })
  check('panBy: moves by a fraction of the span', panBy(v, 0.25).startMs === dayStart + 30_900 * S)
  check('  backwards as well', panBy(v, -0.25).startMs === dayStart + 29_100 * S)
  check('  the span is unchanged and the original is untouched', panBy(v, 0.25).spanMs === 3600 * S && v.startMs === dayStart + 30_000 * S)
  check('  clamps at the start of the day', panBy(v, -100).startMs === dayStart)
  check('  and at the end', panBy(v, 100).endMs === dayEnd)
  check('  a full-day window cannot pan at all', panBy(makeView({ spanMs: DAY_MS, startMs: dayStart, ...day }), 0.5).startMs === dayStart)
}

// ---- follow ---------------------------------------------------------------------------------------
{
  const v = makeView({ spanMs: 3600 * S, startMs: dayStart + 30_000 * S, ...day })
  const at = (secs) => dayStart + secs * S
  check('follow: the very same object back when the playhead is comfortably inside', follow(v, at(31_000)) === v)
  const late = follow(v, at(33_500)) // 97 % across, past the 0.9 edge
  check('  re-centres once the playhead passes the edge', late !== v && near((at(33_500) - late.startMs) / late.spanMs, 0.5), JSON.stringify(late))
  check('  the span is kept when it re-centres', late.spanMs === 3600 * S)
  const before = follow(v, at(100))
  check('  a playhead before the window brings the window back too', before !== v && valid(before) && near((at(100) - before.startMs) / before.spanMs, 0.5) === false ? before.startMs === dayStart : true, JSON.stringify(before))
  check('  the edge can be moved', follow(v, at(32_000)) === v && follow(v, at(32_000), { edge: 0.5 }) !== v)
  check('  re-centring at the end of the day still gives a valid window', valid(follow(makeView({ spanMs: 3600 * S, startMs: dayEnd - 3600 * S, ...day }), dayEnd)) && valid(follow(makeView({ spanMs: 3600 * S, startMs: dayStart, ...day }), dayStart)))
  check('  a playhead that is not a number changes nothing', follow(v, NaN) === v && follow(v, null) === v)
}

// ---- tickStep -------------------------------------------------------------------------------------
{
  const LADDER = [1, 5, 10, 30, 60, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200].map((s) => s * S)
  check('tickStep: every answer comes from the ladder', LADDER.includes(tickStep(30 * S)) && LADDER.includes(tickStep(DAY_MS)) && LADDER.includes(tickStep(137 * S)))
  // Counted as marks actually drawn, not as steps: both ends of the window can land on one.
  let worst = 0
  for (let span = S; span <= DAY_MS; span += 7919) {
    worst = Math.max(worst, ticks(makeView({ spanMs: span, startMs: dayStart, minSpanMs: S, ...day }), TZ).length)
  }
  check('  never more than 8 labels at any span', worst <= 8, `worst ${worst}`)
  check('  and it takes the smallest step that manages that (the densest useful labels)', tickStep(3600 * S) === 600 * S && tickStep(600 * S) === 300 * S && tickStep(60 * S) === 10 * S, `${tickStep(3600 * S)} ${tickStep(600 * S)} ${tickStep(60 * S)}`)
  check('  a whole day gets six-hourly labels (the 12 h rung is only ever a fallback)', tickStep(DAY_MS) === 21_600 * S, String(tickStep(DAY_MS) / S))
  check('  a tiny span uses the finest, and steps up as soon as second marks would crowd', tickStep(S) === S && tickStep(7 * S) === S && tickStep(8 * S) === 5 * S, `${tickStep(8 * S) / S}`)
}

// ---- ticks ----------------------------------------------------------------------------------------
{
  const hour = makeView({ spanMs: 3600 * S, startMs: dayStart + 34_200 * S, ...day }) // 09:30 local onwards
  const t = ticks(hour, TZ)
  check('ticks: every tick is inside the view', t.every((x) => x.ms >= hour.startMs && x.ms <= hour.endMs), JSON.stringify(t.map((x) => x.ms)))
  check('  they land on local clock boundaries, in order', t.every((x, i) => (x.ms + TZ) % tickStep(hour.spanMs) === 0 && (i === 0 || x.ms > t[i - 1].ms)))
  check('  at most 8 of them', t.length <= 8 && t.length >= 2, String(t.length))
  check('  a step of a minute or more is labelled to the minute', t.every((x) => x.label === fmtClock(x.ms, { tzOffsetMs: TZ }).slice(0, 5)), t[0]?.label)
  const short = makeView({ spanMs: 40 * S, startMs: dayStart + 34_200 * S, minSpanMs: 10 * S, ...day })
  const ts = ticks(short, TZ)
  check('  a step below a minute is labelled to the second', ts.length > 0 && ts.every((x) => x.label === fmtClock(x.ms, { tzOffsetMs: TZ })), ts[0]?.label)
  check('  every tick is inside a short view too', ts.every((x) => x.ms >= short.startMs && x.ms <= short.endMs))
  const whole = ticks(makeView({ spanMs: DAY_MS, startMs: dayStart, ...day }), TZ)
  check('  a whole day runs from local midnight to local midnight', whole.at(0).ms === dayStart && whole.at(-1).ms === dayEnd && whole.at(0).label === fmtClock(dayStart, { tzOffsetMs: TZ }).slice(0, 5))
  // A half-hour offset only shifts the marks once the step is an hour or more, so compare the day view.
  check('  the offset really is used: the same day in UTC lands on different marks', ticks(makeView({ spanMs: DAY_MS, startMs: dayStart, ...day }), 0).some((x, i) => x.ms !== whole[i]?.ms))
  check('  no offset given means UTC rather than an error', ticks(hour).every((x) => (x.ms % tickStep(hour.spanMs)) === 0))
}

// ---- fmtClock -------------------------------------------------------------------------------------
{
  const tz = { tzOffsetMs: TZ }
  check('fmtClock: an absolute timestamp as the local wall clock, zero-padded', fmtClock(dayStart, tz) === '00:00:00' && fmtClock(dayStart + (9 * 3600 + 34 * 60 + 48) * S, tz) === '09:34:48')
  check('  every field is padded to two digits', fmtClock(dayStart + 3661 * S, tz) === '01:01:01' && fmtClock(dayStart + 59 * S, tz) === '00:00:59')
  check('  milliseconds only when asked, padded to three', fmtClock(dayStart + 34_488_199, { ...tz, ms: true }) === `${fmtClock(dayStart + 34_488_000, tz)}.199` && fmtClock(dayStart + 34_488_199, tz) === fmtClock(dayStart + 34_488_000, tz))
  check('  a fraction of a millisecond does not round the second up', fmtClock(dayStart + 34_488_000.4, { ...tz, ms: true }) === `${fmtClock(dayStart + 34_488_000, tz)}.000`)
  check('  the last second of the day, and the day after ends where the next begins', fmtClock(dayEnd - S, tz) === '23:59:59' && fmtClock(dayEnd, tz) === fmtClock(dayStart, tz))
  check('  the offset is what makes it local: UTC reads the half hour differently', fmtClock(dayStart, { tzOffsetMs: 0 }) === '18:30:00' && fmtClock(dayStart) === '18:30:00', fmtClock(dayStart))
  check('  rubbish gives a readable clock rather than NaN:NaN', fmtClock(NaN, tz) === '00:00:00' && fmtClock(null, tz) === '00:00:00' && fmtClock(Infinity, tz) === '00:00:00')
}

// ---- spanLabel ------------------------------------------------------------------------------------
{
  check('spanLabel: hours, minutes and seconds', spanLabel(3600 * S) === '1 h' && spanLabel(2880 * S) === '48 min' && spanLabel(30 * S) === '30 s')
  check('  a whole day, and a half hour', spanLabel(DAY_MS) === '24 h' && spanLabel(1800 * S) === '30 min')
  check('  an awkward span is rounded rather than printed to six decimals', spanLabel(5400 * S) === '1.5 h' && spanLabel(91 * S) === '1.5 min' && spanLabel(3599 * S) === '60 min', `${spanLabel(5400 * S)} ${spanLabel(91 * S)} ${spanLabel(3599 * S)}`)
}

// ---- laneBoxes ------------------------------------------------------------------------------------
{
  const v = makeView({ spanMs: 3600 * S, startMs: dayStart + 30_000 * S, ...day })
  const at = (secs) => dayStart + secs * S
  const pct = (ms) => ((ms - v.startMs) / v.spanMs) * 100
  const b = laneBoxes(v, [{ from: at(30_900), to: at(31_800), kind: 'server' }])
  check('laneBoxes: a range wholly inside becomes its share of the width', b.length === 1 && near(b[0].leftPct, pct(at(30_900))) && near(b[0].widthPct, 25) && b[0].kind === 'server')
  check('  the clipped from/to come back with it', b[0].from === at(30_900) && b[0].to === at(31_800))

  const left = laneBoxes(v, [{ from: dayStart, to: at(30_900), kind: 'nvr' }])
  check('  a range starting before the view is clipped to the left edge', left.length === 1 && left[0].leftPct === 0 && left[0].from === v.startMs && near(left[0].widthPct, 25))
  const right = laneBoxes(v, [{ from: at(33_000), to: dayEnd, kind: 'gap' }])
  check('  a range ending after the view is clipped to the right edge', right.length === 1 && right[0].to === v.endMs && near(right[0].leftPct + right[0].widthPct, 100))
  const over = laneBoxes(v, [{ from: dayStart, to: dayEnd, kind: 'server' }])
  check('  a range covering the whole view fills it exactly', over.length === 1 && over[0].leftPct === 0 && near(over[0].widthPct, 100))

  check('  ranges entirely outside are dropped', laneBoxes(v, [{ from: dayStart, to: at(1000) }, { from: at(40_000), to: at(50_000) }]).length === 0)
  check('  one touching an edge with no width is dropped too', laneBoxes(v, [{ from: at(20_000), to: v.startMs }, { from: v.endMs, to: at(40_000) }]).length === 0)
  check('  so are reversed and zero-length ranges', laneBoxes(v, [{ from: at(31_000), to: at(30_000) }, { from: at(31_000), to: at(31_000) }]).length === 0)

  const sliver = laneBoxes(v, [{ from: at(31_000), to: at(31_000) + S, kind: 'gap' }]) // 1 s of an hour = 0.028 %
  check('  a one-second gap is widened to a clickable minimum', sliver.length === 1 && sliver[0].widthPct === 0.1, String(sliver[0]?.widthPct))
  check('  and its real from/to are kept, so a click still seeks to the right moment', sliver[0].from === at(31_000) && sliver[0].to === at(31_000) + S)
  const atEnd = laneBoxes(v, [{ from: v.endMs - 100, to: v.endMs, kind: 'gap' }])
  check('  a sliver at the right edge is pulled in so it does not overflow', near(atEnd[0].leftPct + atEnd[0].widthPct, 100) && atEnd[0].leftPct <= 100 - 0.1 + 1e-9, JSON.stringify(atEnd[0]))

  check('  order is kept and everything is in view', laneBoxes(v, [{ from: at(30_100), to: at(30_200) }, { from: at(33_000), to: at(33_500) }]).every((x, i, a) => x.leftPct >= 0 && x.leftPct + x.widthPct <= 100 + 1e-9 && (i === 0 || x.leftPct >= a[i - 1].leftPct)))
  check('  pb-sources stretches ({ s, e, src }) are understood as they are', laneBoxes(v, [{ s: at(30_900), e: at(31_800), src: 'nvr' }])[0]?.kind === 'nvr')
  check('  no ranges, or rubbish in the list, gives no boxes rather than an error', laneBoxes(v, []).length === 0 && laneBoxes(v).length === 0 && laneBoxes(v, [null, { from: NaN, to: at(31_000) }]).length === 0)
}

// ---- laneBoxes: boxes of a kind that meet on screen are drawn as one ------------------------------------
{
  const v = makeView({ spanMs: 3600 * S, startMs: dayStart + 30_000 * S, ...day })
  const at = (secs) => dayStart + secs * S
  const two = laneBoxes(v, [{ from: at(30_900), to: at(31_000), kind: 'server' }, { from: at(31_000), to: at(31_500), kind: 'server' }])
  check('laneBoxes: two boxes of a kind that touch become one, spanning both', two.length === 1 && two[0].from === at(30_900) && two[0].to === at(31_500) && near(two[0].widthPct, (600 / 3600) * 100) && two[0].n === 2, JSON.stringify(two))
  const apart = laneBoxes(v, [{ from: at(30_900), to: at(31_000), kind: 'server' }, { from: at(31_100), to: at(31_500), kind: 'server' }])
  check('  apart on screen they stay two', apart.length === 2 && apart.every((b) => b.n === 1))
  // 1 s holes 2 s apart: each is drawn 3.6 s wide (MIN_BOX_PCT of an hour), so on screen they overlap
  const holes = Array.from({ length: 5 }, (_, i) => ({ from: at(31_000 + 2 * i), to: at(31_001 + 2 * i), kind: 'gap' }))
  const one = laneBoxes(v, holes)
  check('  slivers widened into each other are one box, from the first one\'s start to the last one\'s end', one.length === 1 && one[0].from === at(31_000) && one[0].to === at(31_009) && one[0].n === 5, JSON.stringify(one))
  check('  as wide as they were drawn together, never less than the minimum', near(one[0].leftPct, ((at(31_000) - v.startMs) / v.spanMs) * 100) && near(one[0].leftPct + one[0].widthPct, ((at(31_008) - v.startMs) / v.spanMs) * 100 + 0.1), JSON.stringify(one[0]))

  // kinds never merge into each other, and a box of another kind between two of a kind does not
  // keep them apart: the NVR-only slivers between server boxes must not stop those boxes merging
  const mixed = laneBoxes(v, [
    { s: at(31_000), e: at(31_001), src: 'server' },
    { s: at(31_001), e: at(31_002), src: 'nvr' },
    { s: at(31_002), e: at(31_003), src: 'server' },
    { s: at(31_003), e: at(31_004), src: 'nvr' },
    { from: at(31_000), to: at(31_001), kind: 'gap' }
  ])
  const kinds = mixed.map((b) => `${b.kind}:${b.n}`).join(' ')
  check('laneBoxes: kinds never merge across, whatever lies between', kinds === 'server:2 nvr:2 gap:1', kinds)
  check('  each merged box keeps its own kind\'s times', mixed[0].from === at(31_000) && mixed[0].to === at(31_003) && mixed[1].from === at(31_001) && mixed[1].to === at(31_004))
  const edge = laneBoxes(v, [{ from: at(30_000), to: at(30_010), kind: 'server' }, { from: at(30_010), to: at(30_020), kind: 'gap' }, { from: at(30_020), to: at(30_030), kind: 'server' }])
  check('  a gap between two recorded stretches stays a gap between two boxes, though it touches both', edge.map((b) => `${b.kind}:${b.n}`).join(' ') === 'server:1 gap:1 server:1', edge.map((b) => `${b.kind}:${b.n}`).join(' '))
  const late = laneBoxes(v, [{ from: v.endMs - 500, to: v.endMs - 400, kind: 'gap' }, { from: v.endMs - 300, to: v.endMs - 200, kind: 'gap' }])
  check('  merged slivers at the right edge still end inside the track', late.length === 1 && late[0].leftPct >= 0 && late[0].leftPct + late[0].widthPct <= 100 + 1e-9, JSON.stringify(late))
  const unsorted = laneBoxes(v, [{ from: at(31_100), to: at(31_200), kind: 'server' }, { from: at(31_000), to: at(31_100), kind: 'server' }])
  check('  a list out of time order merges the same way', unsorted.length === 1 && unsorted[0].from === at(31_000) && unsorted[0].to === at(31_200), JSON.stringify(unsorted))
}

// ---- laneBoxes on a busy day: nvr-2 camera 23 on 09-27 ---------------------------------------------------
// 22.8 h recorded as 911 ranges with 2,295 holes of about 3 s between them. Drawn one box each, the
// 3,206 boxes ran over the lane's cap: the recorded lane stopped at 08:13 and not one hole was drawn.
{
  const dayView = makeView({ spanMs: DAY_MS, startMs: dayStart, ...day })
  const RANGES = 911
  const HOLES = 2295
  const lens = [] // [kind, ms] in time order
  let holesLeft = HOLES
  for (let i = 0; i < RANGES; i++) {
    // every fifth a few minutes of steady recording, the others a trickle of a few seconds
    lens.push(['server', i % 5 === 0 ? (200 + ((i * 37) % 390)) * S : (2 + (i % 9)) * S])
    if (i === RANGES - 1) break
    // 2 or 3 holes back to back after each range, spread evenly so there are exactly HOLES of them
    const n = Math.floor(((i + 1) * HOLES) / (RANGES - 1)) - Math.floor((i * HOLES) / (RANGES - 1))
    for (let j = 0; j < n; j++) lens.push(['gap', 3000 + ((i * 7 + j * 131) % 400)])
    holesLeft -= n
  }
  const total = lens.reduce((sum, [, ms]) => sum + ms, 0)
  // it ends at midnight, as a camera recording through the night does
  let t = dayEnd - total
  const stretches = []
  const gaps = []
  for (const [kind, ms] of lens) {
    if (kind === 'server') stretches.push({ s: t, e: t + ms, src: 'server' })
    else gaps.push([t, t + ms])
    t += ms
  }
  // what the page draws in its top lane (playback.js recRanges): the stretches, then the holes
  const lane = [...stretches, ...gaps.map(([s, e]) => ({ s, e, kind: 'gap' }))]
  check('busy day: the day as measured, over the cap one box each', holesLeft === 0 && stretches.length === RANGES && gaps.length === HOLES && total < DAY_MS && lane.length > MAX_BOXES, `${stretches.length} ranges, ${gaps.length} holes, ${(total / 3_600_000).toFixed(1)} h, cap ${MAX_BOXES}`)

  const boxes = laneBoxes(dayView, lane)
  const shown = boxes.slice(0, MAX_BOXES) // what fillLane keeps
  check('busy day: 2,295 small holes collapse to fit under the cap', boxes.length <= MAX_BOXES && boxes.length < lane.length / 4, `${boxes.length} boxes for ${lane.length} ranges`)
  const recorded = shown.filter((b) => b.kind === 'server')
  const rightmost = Math.max(...recorded.map((b) => b.leftPct + b.widthPct))
  check('  the recorded lane reaches the end of the day', near(rightmost, 100) && Math.max(...recorded.map((b) => b.to)) === dayEnd, `ends at ${rightmost.toFixed(3)} %`)
  const inside = (list, s, e) => list.some((b) => b.from <= s && e <= b.to)
  const drawnHoles = shown.filter((b) => b.kind === 'gap')
  check('  every hole is drawn, the last of the day included', gaps.every(([s, e]) => inside(drawnHoles, s, e)), `${gaps.filter(([s, e]) => !inside(drawnHoles, s, e)).length} missing`)
  check('  every recorded range is inside a recorded box', stretches.every(({ s, e }) => inside(recorded, s, e)))
  check('  and only the two kinds that went in come out', shown.every((b) => b.kind === 'server' || b.kind === 'gap') && shown.reduce((n, b) => n + b.n, 0) === lane.length)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
