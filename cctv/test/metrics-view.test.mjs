// Tests for the shaping of Health's "Last 24 hours" (public/metrics-view.js): where a line's points
// go, the failures added up by the hour, the recorders with the most of them in words, and the four
// charts. No DOM: health.js only draws what this returns.
// Run:  node cctv/test/metrics-view.test.mjs
import { BOX, COLLECTING, HOUR_MS, figure, hourly, linePoints, metricsView, niceMax, topRecorders } from '../public/metrics-view.js'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}
const J = (v) => JSON.stringify(v)

// ---- small things ----
{
  check('a round top for a chart', J([0, 0.3, 1, 1.2, 2, 4.1, 8, 12, 150, 201, 980].map(niceMax)) === J([1, 0.5, 1, 2, 2, 5, 10, 20, 200, 500, 1000]), J([0, 0.3, 1, 1.2, 2, 4.1, 8, 12, 150, 201, 980].map(niceMax)))
  check('...and 1 for nothing or nonsense', niceMax(NaN) === 1 && niceMax(-3) === 1 && niceMax(undefined) === 1)
  check('figures: whole as they are, others short', figure(142) === '142' && figure(1.5) === '1.5' && figure(0.123) === '0.12' && figure(12.34) === '12.3' && figure(2.004) === '2' && figure(null) === '–')
}

// ---- where the points go ----
{
  const box = { width: 120, height: 70, left: 10, right: 10, top: 10, bottom: 10 } // 100 wide, 50 high inside
  const runs = linePoints([{ t: 0, v: 0 }, { t: 50, v: 5 }, { t: 100, v: 10 }], { t0: 0, t1: 100, yMax: 10, box })
  check('left to right in time, bottom to top in value', J(runs) === J(['10.0,60.0 60.0,35.0 110.0,10.0']), J(runs))
  const gap = linePoints([{ t: 0, v: 1 }, { t: 10, v: 2 }, { t: 20, v: null }, { t: 30, v: 3 }, { t: 40, v: NaN }, { t: 50, v: 4 }, { t: 60, v: 5 }], { t0: 0, t1: 100, yMax: 10, box })
  check('a missing figure breaks the line; one alone is a run of one', gap.length === 3 && gap[0].split(' ').length === 2 && gap[1].split(' ').length === 1 && gap[2].split(' ').length === 2, J(gap))
  const out = linePoints([{ t: -50, v: 99 }, { t: 500, v: -4 }], { t0: 0, t1: 100, yMax: 10, box })
  check('nothing is drawn outside the box', J(out) === J(['10.0,10.0 110.0,60.0']), J(out))
  check('no time span, no top: no division by nothing', !J(linePoints([{ t: 5, v: 0 }], { t0: 5, t1: 5, yMax: 0, box })).includes('NaN'))
  check('no points, no runs', linePoints([], { t0: 0, t1: 1, yMax: 1 }).length === 0)
}

// ---- failures by the hour ----
const T0 = Date.UTC(2026, 9, 13, 8, 0, 0)
const at = (min, perNvr = {}, o = {}) => ({ t: T0 + min * 60_000, load1: 2, cpuCount: 8, streams: 140, viewers: { people: 5, local: 4, remote: 1 }, sub: { running: 2, units: 150, budgetUnits: 400, refused: 0 }, main: { running: 1, refused: 0 }, perNvr, ...o })
const f = (failedStarts = 0, stalls = 0, relogins = 0, linkDrops = 0) => ({ failedStarts, stalls, relogins, linkDrops })
{
  const h = hourly([at(0, { law: f(2, 1) }), at(30, { law: f(3), gpri: f(0, 0, 1) }), at(60), at(185, { gpri: f(1, 0, 0, 2) })])
  check('one entry an hour, first to last, quiet hours included', h.length === 4 && h[0].t === T0 && h[3].t === T0 + 3 * HOUR_MS, J(h.map((x) => x.t - T0)))
  check('every recorder together, each count on its own', J(h[0]) === J({ t: T0, failedStarts: 5, stalls: 1, relogins: 1, linkDrops: 0 }) && h[1].failedStarts === 0 && h[2].failedStarts === 0 && h[3].failedStarts === 1 && h[3].linkDrops === 2, J(h))
  check('no samples, no hours', hourly([]).length === 0 && hourly(undefined).length === 0)
}

// ---- the recorders with the most failures ----
{
  const samples = [
    at(0, { law: f(200, 100), gpri: f(1), a: f(0, 2), b: f(0, 0, 3), c: f(0, 0, 0, 1), d: f(9), quiet: f() }),
    at(1, { law: f(44, 24), gpri: f(0, 0, 1) })
  ]
  const top = topRecorders(samples, { law: 'Lawrence', gpri: 'GPRI' })
  check('worst first, by name, in words', top[0] === 'Lawrence: 244 failed starts, 124 stalls', top[0])
  check('five at most; nothing counted is left out', top.length === 5 && !top.some((l) => l.startsWith('quiet')) && !top.some((l) => l.startsWith('c:')), J(top))
  check('singular and plural, and the id where there is no name', top.includes('GPRI: 1 failed start, 1 re-login') && top.includes('b: 3 re-logins') && top.includes('d: 9 failed starts') && top.includes('a: 2 stalls'), J(top))
  check('a dropped connection is said too', topRecorders([at(0, { c: f(0, 0, 0, 1) })])[0] === 'c: 1 dropped connection')
  check('nobody failing: no lines', topRecorders([at(0), at(1)]).length === 0 && topRecorders(undefined).length === 0)
}

// ---- the section ----
{
  for (const d of [undefined, null, {}, { samples: [] }, { samples: [at(0)] }, { samples: 'x' }, { samples: [{ t: 'bad' }, at(0)] }]) {
    const v = metricsView(d)
    check(`fewer than two samples: collecting (${J(d)?.slice(0, 24)})`, v.collecting === true && v.message === COLLECTING && v.charts.length === 0 && v.top.length === 0)
  }
  const samples = []
  for (let m = 0; m < 240; m += 2) samples.push(at(m, m % 60 === 0 ? { law: f(4, 2), gpri: f(0, 0, 1) } : {}, { load1: m < 120 ? 2 : 6, streams: 100 + m / 2, viewers: { people: m < 120 ? 3 : 7 }, sub: { running: 2, units: m < 120 ? 100 : 350, budgetUnits: 400, refused: m === 200 ? 2 : 0 } }))
  const now = T0 + 240 * 60_000
  const v = metricsView({ now, samples }, { hours: 24, names: { law: 'Lawrence' } })
  check('the section\'s title follows the span', v.title === 'Last 24 hours' && metricsView({ now, samples }, { hours: 168 }).title === 'Last 7 days')
  check('four charts, in order', v.collecting === false && v.message === '' && J(v.charts.map((c) => c.id)) === J(['load', 'streams', 'conversions', 'failures']), J(v.charts.map((c) => c.id)))
  const [load, streams, conv, fail] = v.charts
  check('load: against the cores, the top above both', load.yMax === 10 && load.series[0].legend === 'Load: now 6, most 6' && load.series[1].limit === true && load.series[1].legend === 'Cores: 8', J(load.series.map((s) => s.legend)))
  check('streams and people, each said in words', streams.series[0].legend === 'Streams: now 219, most 219' && streams.series[1].legend === 'People watching: now 7, most 7' && streams.yMax === 500, J(streams.series.map((s) => s.legend)))
  check('conversions: cores in use against those allowed, and who was refused', conv.yMax === 5 && conv.series[0].legend === 'In use: now 3.5 cores, most 3.5 cores; most at once 3; 2 viewers refused' && conv.series[1].legend === 'Allowed: 4 cores', J(conv.series.map((s) => s.legend)))
  check('failures by the hour, three lines with their totals', J(fail.series.map((s) => s.legend)) === J(['Failed starts: 16 in all', 'Stalls: 8 in all', 'Re-logins: 4 in all']) && fail.yMax === 5, J(fail.series.map((s) => s.legend)))
  {
    // the conversions that are not for office PCs, once the history has them
    const withOther = samples.map((s, i) => ({ ...s, other: { remote: 2, playback: i % 2, playbackSd: 0, ffmpeg: 6 } }))
    const w = metricsView({ now, samples: withOther }, { hours: 24 })
    const all = w.charts.find((c) => c.id === 'all-conversions')
    check('every conversion, by who it is for, once the history has them', J(w.charts.map((c) => c.id)) === J(['load', 'streams', 'conversions', 'all-conversions', 'failures']) && J(all?.series.map((s) => s.label)) === J(['All', 'Office PCs', 'Outside and phones', 'Playback']) && all.series[0].legend.startsWith('All: now 6'), J(all?.series.map((s) => s.legend)))
  }
  check('every line has points, all inside the box and none NaN', v.charts.every((c) => c.series.every((s) => s.runs.length >= 1 && s.runs.every((r) => r.split(' ').every((p) => {
    const [x, y] = p.split(',').map(Number)
    return x >= BOX.left && x <= BOX.width - BOX.right && y >= BOX.top && y <= BOX.height - BOX.bottom
  })))))
  // the last 4 of 24 hours were recorded: the lines sit in the last sixth of the width
  const firstX = Number(load.series[0].runs[0].split(' ')[0].split(',')[0])
  const w = BOX.width - BOX.left - BOX.right
  check('the right edge is now, the left the span ago: a short history starts part-way along', Math.abs(firstX - (BOX.left + w * 20 / 24)) < 0.2, String(firstX))
  check('the hours\' points sit mid-hour', fail.series[0].runs[0].split(' ').length === 4)
  check('five times along the bottom, first to last', v.ticks.length === 5 && v.ticks[0].t === now - 24 * HOUR_MS && v.ticks[4].t === now && v.ticks[0].x === BOX.left && v.ticks[4].x === BOX.width - BOX.right)
  check('the worst recorders, by name', J(v.top) === J(['Lawrence: 16 failed starts, 8 stalls', 'gpri: 4 re-logins']) && v.topNote === '', J(v.top))
  const calm = metricsView({ now, samples: [at(0), at(1)] })
  check('no failures: said so, and nobody refused', calm.top.length === 0 && /No recorder had/.test(calm.topNote) && calm.charts[2].series[0].legend.endsWith('nobody refused') && calm.charts[3].series[0].legend === 'Failed starts: 0 in all', calm.charts[2].series[0].legend)
  const holes = metricsView({ now, samples: [at(0, {}, { load1: null, cpuCount: null, sub: undefined, viewers: undefined }), at(1, {}, { load1: null, cpuCount: null, sub: undefined, viewers: undefined })] })
  check('figures that are missing: no lines for them, no crash, no NaN', holes.charts[0].series[0].runs.length === 0 && holes.charts[0].series[0].legend === 'Load: no figures yet' && !J(holes).includes('NaN'), holes.charts[0].series[0].legend)
}

console.log(failed ? `${failed} FAILED` : 'all passed')
process.exitCode = failed ? 1 : 0
