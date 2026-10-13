// Health, "Last 24 hours" (admins): what /api/admin/metrics answers (metrics-history.mjs), shaped
// into the charts the page draws: where each line's points go, the failures added up by the hour,
// and the recorders with the most of them, in words. Pure, like viewers-view.js, so it is tested
// without a browser (test/metrics-view.test.mjs); health.js only draws what this returns.

/** The drawing's own units (the SVG's viewBox): the page scales it to the width it has. */
export const BOX = { width: 600, height: 150, left: 34, right: 8, top: 8, bottom: 18 }
export const HOUR_MS = 3_600_000
export const TOP_RECORDERS = 5
export const COLLECTING = 'Collecting… the first figures appear in a couple of minutes.'

const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
/** A figure for a legend: whole numbers as they are, others to one decimal. */
export const figure = (v) => (!finite(v) ? '–' : Number.isInteger(v) ? String(v) : v.toFixed(v < 10 ? 2 : 1).replace(/\.?0+$/, ''))

/** A round number at or above v for the top of a chart: 1, 2, 5, 10, 20, 50, ... (1 for nothing). */
export function niceMax(v) {
  if (!finite(v) || v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const step = [1, 2, 5, 10].find((m) => m * p >= v - 1e-9)
  return step * p
}

/**
 * Where a line's points go in the box, as the "x,y x,y" an SVG polyline takes. A value that is
 * missing breaks the line: each unbroken run is its own string (a single point is a run of one).
 * @param {{ t: number, v: number|null }[]} points oldest first
 * @param {{ t0: number, t1: number, yMax: number, box?: object }} o the times at the left and right edge, and the value at the top
 * @returns {string[]}
 */
export function linePoints(points, { t0, t1, yMax, box = BOX }) {
  const w = box.width - box.left - box.right
  const h = box.height - box.top - box.bottom
  const span = t1 > t0 ? t1 - t0 : 1
  const top = yMax > 0 ? yMax : 1
  const runs = []
  let run = []
  for (const p of points) {
    if (!finite(p?.v) || !finite(p?.t)) {
      if (run.length) runs.push(run)
      run = []
      continue
    }
    const x = box.left + (Math.min(Math.max(p.t, t0), t1) - t0) / span * w
    const y = box.top + (1 - Math.min(Math.max(p.v, 0), top) / top) * h
    run.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  }
  if (run.length) runs.push(run)
  return runs.map((r) => r.join(' '))
}

const COUNTS = ['failedStarts', 'stalls', 'relogins', 'linkDrops']

/**
 * The recorders' failures added up by the hour, every recorder together: one entry per hour from
 * the first sample's to the last's, hours with nothing included (a quiet hour is a point at 0, not
 * a gap).
 * @returns {{ t: number, failedStarts: number, stalls: number, relogins: number, linkDrops: number }[]}
 */
export function hourly(samples) {
  const hours = new Map()
  let first = Infinity
  let last = -Infinity
  for (const s of samples ?? []) {
    if (!finite(s?.t)) continue
    const h = Math.floor(s.t / HOUR_MS) * HOUR_MS
    first = Math.min(first, h)
    last = Math.max(last, h)
    let into = hours.get(h)
    if (!into) hours.set(h, (into = { t: h, failedStarts: 0, stalls: 0, relogins: 0, linkDrops: 0 }))
    for (const c of Object.values(s.perNvr ?? {})) for (const k of COUNTS) if (finite(c?.[k])) into[k] += c[k]
  }
  const out = []
  for (let h = first; h <= last; h += HOUR_MS) out.push(hours.get(h) ?? { t: h, failedStarts: 0, stalls: 0, relogins: 0, linkDrops: 0 })
  return out
}

/**
 * The recorders with the most failures over the samples, worst first, each as a line of words:
 * "Lawrence: 244 failed starts, 124 stalls". Counts of nothing are left out of the line.
 * @param {object[]} samples
 * @param {Record<string, string>} [names] recorder id -> its name (the id where there is none)
 */
export function topRecorders(samples, names = {}, most = TOP_RECORDERS) {
  const totals = new Map()
  for (const s of samples ?? []) {
    for (const [id, c] of Object.entries(s?.perNvr ?? {})) {
      let into = totals.get(id)
      if (!into) totals.set(id, (into = { failedStarts: 0, stalls: 0, relogins: 0, linkDrops: 0 }))
      for (const k of COUNTS) if (finite(c?.[k])) into[k] += c[k]
    }
  }
  const all = (c) => c.failedStarts + c.stalls + c.relogins + c.linkDrops
  return [...totals]
    .filter(([, c]) => all(c) > 0)
    .sort((a, b) => all(b[1]) - all(a[1]) || String(a[0]).localeCompare(String(b[0])))
    .slice(0, most)
    .map(([id, c]) => {
      const parts = [
        c.failedStarts ? plural(c.failedStarts, 'failed start') : '',
        c.stalls ? plural(c.stalls, 'stall') : '',
        c.relogins ? plural(c.relogins, 're-login') : '',
        c.linkDrops ? plural(c.linkDrops, 'dropped connection') : ''
      ].filter(Boolean)
      return `${(typeof names?.[id] === 'string' && names[id]) || id}: ${parts.join(', ')}`
    })
}

/** The last value there is, and the highest, of a line's points. */
const lastOf = (points) => points.findLast?.((p) => finite(p.v))?.v ?? [...points].reverse().find((p) => finite(p.v))?.v ?? null
const mostOf = (points) => points.reduce((m, p) => (finite(p.v) && p.v > m ? p.v : m), 0)

/**
 * Everything the section shows.
 * @param {{ now?: number, samples?: object[] }} data /api/admin/metrics
 * @param {{ hours?: number, names?: Record<string, string> }} [o] hours: the span asked for (24 or 168)
 * @returns {{ collecting: boolean, message: string, title: string, charts: object[], top: string[], topNote: string, ticks: { x: number, t: number }[] }}
 *   charts: { id, title, note, yMax, series: [{ label, tone, runs, legend }] }; tone names the line's
 *   colour and dash (health.css mv-<tone>); a series marked limit is the level not to pass.
 *   ticks: where along the bottom to write a time, and which
 */
export function metricsView(data, { hours = 24, names = {} } = {}) {
  const samples = (Array.isArray(data?.samples) ? data.samples : []).filter((s) => finite(s?.t))
  const title = hours > 48 ? `Last ${Math.round(hours / 24)} days` : `Last ${hours} hours`
  if (samples.length < 2) return { collecting: true, message: COLLECTING, title, charts: [], top: [], topNote: '', ticks: [] }
  const t1 = finite(data?.now) ? Math.max(data.now, samples.at(-1).t) : samples.at(-1).t
  const t0 = t1 - hours * HOUR_MS
  const of = (get) => samples.map((s) => ({ t: s.t, v: get(s) }))
  const series = (label, tone, points, { yMax, unit = '', limit = false, extra = '' } = {}) => ({
    label,
    tone,
    limit,
    runs: linePoints(points, { t0, t1, yMax }),
    legend: lastOf(points) === null ? `${label}: no figures yet` : limit ? `${label}: ${figure(lastOf(points))}${unit}` : `${label}: now ${figure(lastOf(points))}${unit}, most ${figure(mostOf(points))}${unit}${extra}`
  })

  // 1. the load against the cores: at or over the line, the server has more to do than it can
  const load = of((s) => s.load1)
  const cores = of((s) => s.cpuCount)
  const loadMax = niceMax(Math.max(mostOf(load), mostOf(cores)))
  // 2. two things on their own scales: streams run to the hundreds, people to a handful
  const streams = of((s) => s.streams)
  const people = of((s) => s.viewers?.people)
  const streamsMax = niceMax(mostOf(streams))
  // 3. the conversions' CPU against what they are allowed, in cores (the server counts in hundredths)
  const cores100 = (v) => (finite(v) ? v / 100 : null)
  const used = of((s) => cores100(s.sub?.units))
  const allowed = of((s) => cores100(s.sub?.budgetUnits))
  const running = of((s) => (finite(s.sub?.running) ? s.sub.running + (finite(s.main?.running) ? s.main.running : 0) : null))
  const refused = samples.reduce((n, s) => n + (finite(s.sub?.refused) ? s.sub.refused : 0) + (finite(s.main?.refused) ? s.main.refused : 0), 0)
  const convMax = niceMax(Math.max(mostOf(used), mostOf(allowed)))
  // 4. failures by the hour, all recorders together
  const hrs = hourly(samples)
  const hourPoints = (k) => hrs.map((h) => ({ t: h.t + HOUR_MS / 2, v: h[k] }))
  const failMax = niceMax(Math.max(...hrs.flatMap((h) => [h.failedStarts, h.stalls, h.relogins]), 0))
  const total = (k) => hrs.reduce((n, h) => n + h[k], 0)
  const failSeries = (label, tone, k) => ({ label, tone, limit: false, runs: linePoints(hourPoints(k), { t0, t1, yMax: failMax }), legend: `${label}: ${total(k)} in all` })

  const charts = [
    {
      id: 'load',
      title: 'Server load',
      note: 'How much work is waiting for the processor. Staying under the number of cores is comfortable; at or over it, video starts to stutter.',
      yMax: loadMax,
      series: [series('Load', 'a', load, { yMax: loadMax }), series('Cores', 'limit', cores, { yMax: loadMax, limit: true })]
    },
    {
      id: 'streams',
      title: 'Streams and people watching',
      note: 'Camera streams the server is receiving, and browsers or apps with video open. Each line fills the height to its own highest figure.',
      yMax: streamsMax,
      series: [series('Streams', 'a', streams, { yMax: streamsMax }), series('People watching', 'b', people, { yMax: niceMax(mostOf(people)) })]
    },
    {
      id: 'conversions',
      title: 'Video conversions for PCs without H.265',
      note: 'The processor time conversions are counted as, against what they are allowed. A viewer is refused when there is no room left.',
      yMax: convMax,
      series: [
        series('In use', 'a', used, { yMax: convMax, unit: ' cores', extra: `; most at once ${figure(mostOf(running))}; ${refused ? plural(refused, 'viewer') : 'nobody'} refused` }),
        series('Allowed', 'limit', allowed, { yMax: convMax, unit: ' cores', limit: true })
      ]
    },
    {
      id: 'failures',
      title: 'Failures per hour',
      note: 'Across every recorder: streams that would not start, streams that stopped and were restarted, and times the server had to log in to a recorder again.',
      yMax: failMax,
      series: [failSeries('Failed starts', 'd', 'failedStarts'), failSeries('Stalls', 'c', 'stalls'), failSeries('Re-logins', 'b', 'relogins')]
    }
  ]
  const top = topRecorders(samples, names)
  const w = BOX.width - BOX.left - BOX.right
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ x: BOX.left + f * w, t: t0 + f * (t1 - t0) }))
  return { collecting: false, message: '', title, charts, top, topNote: top.length ? '' : 'No recorder had a failed start, a stall or a re-login in this time.', ticks }
}
