// A history of the server's key numbers, for the Health page's "Last 24 hours": once a minute one
// line of JSON is added to DATA_DIR/metrics.jsonl, and 14 days are kept. /healthz and the Health
// page say how things are now; the journal holds a day and a half. Neither could answer "was the
// server this loaded yesterday evening?" or "which recorder's streams have been failing all week?".
//
// The numbers come from providers the server hands in (the same sources as /healthz), so nothing
// here imports the SDK or the NVRs and all of it is tested without them (test/metrics-history.test.mjs).
// The per-recorder failures are counted from the workers' own log lines as they pass through the
// main process (worker-supervisor.mjs prefixLines): no change to the workers, and nothing new sent.
//
// One line, about 350 to 500 bytes (more with many recorders failing in the same minute):
//   { t, load1, cpuCount, nvrsOnline, nvrsTotal, streams, viewers: { people, local, remote },
//     sub: { running, units, budgetUnits, refused }, main: { running, refused },
//     sdk: { inFlight, late }, loopWorstMs,
//     perNvr: { <id>: { failedStarts, stalls, relogins, linkDrops } } }
// sub and main are the H.264 conversions for local PCs (h264-fallback.mjs). refused and everything
// under perNvr are counts for that minute, not totals; a recorder with nothing to count is left out.
// sdk adds the workers' calls to this process's, and loopWorstMs is the worst of them all.
import { promises as fsp } from 'node:fs'

export const SAMPLE_MS = 60_000
export const KEEP_MS = 14 * 86_400_000
export const TRIM_EVERY_MS = 3_600_000 // old lines are dropped, and a failed write said, once an hour at most
export const MAX_POINTS = 720 // what one answer holds: 24 hours at 2 minutes, 7 days at 14
export const MAX_HOURS = 336
export const METRICS_PATH = '/api/admin/metrics'
const NO_STORE = { 'cache-control': 'no-store' }
const TAIL_CHUNK = 256 * 1024

// ---- the workers' lines ------------------------------------------------------------------------

export const COUNTERS = ['failedStarts', 'stalls', 'relogins', 'linkDrops']
const STREAM_RE = /^stream \S+\/\d+:(?:sub|main) (.*)$/

/**
 * Which count a worker's line adds to, or null (most lines). The lines are live.mjs's and nvrs.mjs's:
 *   "stream gpri/3:sub failed to start (refused in 12 ms: busy)"             failedStarts
 *   "stream gpri/3:main no video within 8 s of starting (...), restarting"   failedStarts
 *   "stream gpri/3:sub stalled, restarting"                                  stalls
 *   "[gpri] 3 streams failed to start, logging in again in 30 s"             relogins
 *   "[gpri] the NVR dropped its links: viewers' new streams on it wait 30 s" linkDrops
 * @param {string} line without the "[worker <id>] " prefix
 */
export function classifyWorkerLine(line) {
  const s = String(line ?? '')
  const stream = STREAM_RE.exec(s)
  if (stream) {
    const what = stream[1]
    if (what.startsWith('failed to start')) return 'failedStarts'
    if (what.startsWith('no video within') && what.endsWith('restarting')) return 'failedStarts'
    if (what.startsWith('stalled') && what.endsWith('restarting')) return 'stalls'
    return null
  }
  if (!s.startsWith('[')) return null
  if (s.includes('the NVR dropped its links')) return 'linkDrops'
  if (/^\[[^\]]+\] .*logging in again/.test(s)) return 'relogins'
  return null
}

/** The counts per recorder since they were last taken. */
export function makeLineCounts() {
  let per = new Map()
  return {
    /** One line of a worker's output; counted when it is one of the lines above. */
    line(nvrId, text) {
      const k = classifyWorkerLine(text)
      if (!k) return null
      let c = per.get(nvrId)
      if (!c) per.set(nvrId, (c = { failedStarts: 0, stalls: 0, relogins: 0, linkDrops: 0 }))
      c[k]++
      return k
    },
    /** { <id>: counts } for the recorders with anything counted; starts again from nothing. */
    take() {
      const out = Object.fromEntries(per)
      per = new Map()
      return out
    }
  }
}

/** The one the supervisor counts into and the server's recorder takes from. */
export const workerLineCounts = makeLineCounts()

// ---- one sample --------------------------------------------------------------------------------

const num = (v) => (Number.isFinite(v) ? v : null)
const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)

/**
 * The minute's line from what the providers say. A provider that throws leaves its numbers null:
 * one bad source never costs the rest of the line.
 * @param {object} p load1(), cpuCount(), nvrs() -> { online, total }, streams(), viewers() -> presence.mjs
 *   summary, h264() -> h264-fallback.mjs summary, sdk() -> { inFlight, late }, loopWorstMs()
 * @param {{ t: number, perNvr?: object, last?: { sub: number|null, main: number|null } }} o
 *   last: the conversions' refused totals at the sample before, kept here for the next
 */
export function buildSample(p, { t, perNvr = {}, last = { sub: null, main: null } }) {
  const ask = (fn) => {
    try {
      return fn?.() ?? null
    } catch {
      return null
    }
  }
  // refused is a total since the server started: this minute's is the difference (none at the
  // first sample, or after a restart set the total back)
  const since = (key, total) => {
    const before = last[key]
    last[key] = Number.isFinite(total) ? total : null
    return Number.isFinite(total) && Number.isFinite(before) && total > before ? total - before : 0
  }
  const nvrs = ask(p.nvrs)
  const viewers = ask(p.viewers)
  const h264 = ask(p.h264)
  const sdk = ask(p.sdk)
  const other = ask(p.other)
  return {
    t,
    load1: round2(ask(p.load1)),
    cpuCount: num(ask(p.cpuCount)),
    nvrsOnline: num(nvrs?.online),
    nvrsTotal: num(nvrs?.total),
    streams: num(ask(p.streams)),
    viewers: { people: num(viewers?.people), local: num(viewers?.local), remote: num(viewers?.remote) },
    sub: { running: num(h264?.running), units: num(h264?.units), budgetUnits: num(h264?.budgetUnits), refused: since('sub', h264?.refused) },
    main: { running: num(h264?.main?.running ?? 0), refused: since('main', h264?.main?.refused) },
    // the conversions that are not for office PCs: remote viewers' and phones' (one pool), playback's
    // (full and SD), and every ffmpeg on the box whatever started it. On 2026-10-14 a remote viewer's
    // conversions put the load at 6-7 at night with 'no conversions' in this history.
    other: { remote: num(other?.remote), playback: num(other?.playback), playbackSd: num(other?.playbackSd), ffmpeg: num(other?.ffmpeg) },
    sdk: { inFlight: num(sdk?.inFlight), late: num(sdk?.late) },
    loopWorstMs: num(ask(p.loopWorstMs)),
    perNvr
  }
}

/**
 * How many running processes have this name, from the names of all of them (Linux: /proc/<pid>/comm).
 * @param {string} name @param {Iterable<string>} comms
 */
export function countNamed(name, comms) {
  let n = 0
  for (const c of comms) if (String(c).trim() === name) n++
  return n
}

// ---- the file ----------------------------------------------------------------------------------

/** A line's time without parsing the line (every line starts {"t":...). NaN for one that is not ours. */
const timeOf = (line) => Number(/^\{"t":(\d+)/.exec(line)?.[1] ?? NaN)

/**
 * The lines from sinceMs on, read from the end of the file backwards: a day is the last 700 kB of
 * a file that grows to about 10 MB, and the page asks once a minute.
 */
async function readSince(file, sinceMs, io) {
  let fh
  try {
    fh = await io.open(file, 'r')
  } catch {
    return [] // no file yet: nothing recorded
  }
  try {
    const { size } = await fh.stat()
    const parts = []
    let pos = size
    while (pos > 0) {
      const len = Math.min(TAIL_CHUNK, pos)
      pos -= len
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, pos)
      parts.unshift(buf)
      // the first whole line of this piece: older than asked for means everything needed is read
      const a = buf.indexOf(10)
      const b = a < 0 ? -1 : buf.indexOf(10, a + 1)
      if (b > 0 && timeOf(buf.toString('utf8', a + 1, b)) < sinceMs) break
    }
    const lines = Buffer.concat(parts).toString('utf8').split('\n')
    if (pos > 0) lines.shift() // (cut mid-line)
    const out = []
    for (const line of lines) {
      if (!(timeOf(line) >= sinceMs)) continue
      try {
        out.push(JSON.parse(line))
      } catch {} // (a line cut short by a power loss)
    }
    return out
  } finally {
    await fh.close().catch(() => {})
  }
}

/**
 * The recorder. start() samples every SAMPLE_MS; nothing it does can throw into the caller, and a
 * disk that cannot be written is said once an hour at most.
 * @param {{ file: string, providers: object, counts?: { take: () => object }, now?: () => number,
 *   log?: (line: string) => void, io?: object }} o
 *   file: DATA_DIR/metrics.jsonl; counts: the per-recorder counts (workerLineCounts); io: node's
 *   fs.promises (tests)
 */
export function makeMetricsHistory({ file, providers, counts = workerLineCounts, now = Date.now, log = (line) => console.warn(line), io = fsp }) {
  const last = { sub: null, main: null }
  let queue = Promise.resolve() // one write at a time: a trim never runs across an append
  let trimmedAt = now() // (the first trim an hour after the start: nothing to do at a restart)
  let saidAt = -Infinity
  let timer = null
  const failed = (what, e) => {
    if (now() - saidAt < TRIM_EVERY_MS) return
    saidAt = now()
    log(`[metrics] ${what}: ${e?.message ?? e} (the history on the Health page has a gap; said once an hour)`)
  }
  /** Drops the lines older than KEEP_MS by writing the rest to a new file put in its place. */
  const trim = async () => {
    const text = await io.readFile(file, 'utf8')
    const cutoff = now() - KEEP_MS
    let at = 0
    // the lines are in time order: the first one young enough ends the search
    while (at < text.length) {
      const nl = text.indexOf('\n', at)
      const line = nl < 0 ? text.slice(at) : text.slice(at, nl)
      if (timeOf(line) >= cutoff) break
      at = nl < 0 ? text.length : nl + 1
    }
    if (at === 0) return 0
    const tmp = `${file}.tmp`
    await io.writeFile(tmp, text.slice(at), { mode: 0o600 })
    await io.rename(tmp, file)
    return at
  }
  const api = {
    file,
    /** Takes one sample now and adds its line; resolves to the sample once written (or not). */
    sample() {
      let s
      try {
        s = buildSample(providers, { t: now(), perNvr: counts.take(), last })
      } catch (e) {
        failed('could not take a sample', e)
        return Promise.resolve(null)
      }
      queue = queue
        .then(() => io.appendFile(file, `${JSON.stringify(s)}\n`, { mode: 0o600 }))
        .then(() => {
          if (now() - trimmedAt < TRIM_EVERY_MS) return
          trimmedAt = now()
          return trim()
        })
        .catch((e) => failed('could not write the history', e))
      return queue.then(() => s)
    },
    /** The samples of the last `hours`, oldest first; none when the file cannot be read. */
    async read(hours) {
      try {
        return await readSince(file, now() - hours * 3_600_000, io)
      } catch (e) {
        failed('could not read the history', e)
        return []
      }
    },
    start(everyMs = SAMPLE_MS) {
      if (timer) return api
      timer = setInterval(() => {
        try {
          api.sample().catch(() => {})
        } catch {}
      }, everyMs)
      timer.unref?.()
      return api
    },
    stop() {
      clearInterval(timer)
      timer = null
    },
    /** Resolves when everything asked for so far is on the disk (tests). */
    settled: () => queue
  }
  return api
}

// ---- the answer --------------------------------------------------------------------------------

/**
 * At most about maxPoints points for a span: the samples in each stretch of time become one, the
 * levels averaged (the worst event-loop pause: the worst), the counts added up.
 * @param {object[]} samples oldest first
 * @param {{ spanMs: number, maxPoints?: number }} o spanMs: the time asked for, which sets the stretch
 */
export function downsample(samples, { spanMs, maxPoints = MAX_POINTS }) {
  const bucketMs = SAMPLE_MS * Math.max(1, Math.ceil(spanMs / SAMPLE_MS / maxPoints))
  if (bucketMs === SAMPLE_MS) return { bucketMs, samples }
  const out = []
  let group = []
  let key = null
  const mean = (get) => {
    const v = group.map(get).filter(Number.isFinite)
    return v.length ? round2(v.reduce((a, b) => a + b, 0) / v.length) : null
  }
  const sum = (get) => group.map(get).filter(Number.isFinite).reduce((a, b) => a + b, 0)
  const most = (get) => {
    const v = group.map(get).filter(Number.isFinite)
    return v.length ? Math.max(...v) : null
  }
  const flush = () => {
    if (!group.length) return
    const perNvr = {}
    for (const s of group) {
      for (const [id, c] of Object.entries(s.perNvr ?? {})) {
        const into = (perNvr[id] ??= { failedStarts: 0, stalls: 0, relogins: 0, linkDrops: 0 })
        for (const k of COUNTERS) into[k] += Number.isFinite(c?.[k]) ? c[k] : 0
      }
    }
    const worst = group.map((s) => s.loopWorstMs).filter(Number.isFinite)
    out.push({
      t: key * bucketMs,
      load1: mean((s) => s.load1),
      cpuCount: group.at(-1).cpuCount ?? null,
      nvrsOnline: mean((s) => s.nvrsOnline),
      nvrsTotal: mean((s) => s.nvrsTotal),
      streams: mean((s) => s.streams),
      // whole people: the most watching within the stretch, not an average of 0.5 of one
      viewers: { people: most((s) => s.viewers?.people), local: most((s) => s.viewers?.local), remote: most((s) => s.viewers?.remote) },
      sub: { running: mean((s) => s.sub?.running), units: mean((s) => s.sub?.units), budgetUnits: mean((s) => s.sub?.budgetUnits), refused: sum((s) => s.sub?.refused) },
      main: { running: mean((s) => s.main?.running), refused: sum((s) => s.main?.refused) },
      other: { remote: mean((s) => s.other?.remote), playback: mean((s) => s.other?.playback), playbackSd: mean((s) => s.other?.playbackSd), ffmpeg: mean((s) => s.other?.ffmpeg) },
      sdk: { inFlight: mean((s) => s.sdk?.inFlight), late: mean((s) => s.sdk?.late) },
      loopWorstMs: worst.length ? Math.max(...worst) : null,
      perNvr
    })
    group = []
  }
  for (const s of samples) {
    if (!Number.isFinite(s?.t)) continue
    const k = Math.floor(s.t / bucketMs)
    if (k !== key) {
      flush()
      key = k
    }
    group.push(s)
  }
  flush()
  return { bucketMs, samples: out }
}

/** hours as asked: 1 to MAX_HOURS, 24 when not said or not a number. */
export const hoursOf = (v) => {
  const n = v === null || v === undefined || v === '' ? NaN : Number(v)
  return Number.isFinite(n) ? Math.min(MAX_HOURS, Math.max(1, Math.floor(n))) : 24
}

/**
 * GET /api/admin/metrics?hours=24 (admins): { now, stepSeconds, bucketSeconds, hours, samples }.
 * stepSeconds is how often a sample is taken; bucketSeconds what one point of this answer covers.
 * @returns {Promise<[number, object, object]|null>} null: not this route
 */
export async function handleMetrics(method, pathname, who, params, history, { now = Date.now } = {}) {
  if (pathname !== METRICS_PATH) return null
  if (who?.admin !== true) return [403, { error: 'Admins only' }, NO_STORE]
  if (method !== 'GET') return [405, { error: 'Method not allowed' }, { ...NO_STORE, allow: 'GET' }]
  const hours = hoursOf(params?.get?.('hours'))
  const { bucketMs, samples } = downsample(await history.read(hours), { spanMs: hours * 3_600_000 })
  return [200, { now: now(), stepSeconds: SAMPLE_MS / 1000, bucketSeconds: bucketMs / 1000, hours, samples }, NO_STORE]
}
