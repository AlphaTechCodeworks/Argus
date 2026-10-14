// Alerts about the server itself, made from the history of its key numbers (metrics-history.mjs):
// the box overloaded, its own disk nearly full, one recorder failing over and over, and viewers
// turned away for want of room to convert their video. The Health page's "Last 24 hours" showed all
// of these afterwards; nothing told the owner while they were happening.
//
// They go out through the same machinery as every other alert (alerts.mjs, alert-checks.mjs): handed
// in as ready-made candidates (snapshot `extra`), muted by kind in Settings, listed on Health, sent to
// the phone. What is different is the timing. Each of these needs its own hold ("10 minutes over",
// "under for 5 minutes", "3 of the last 10 minutes"), worked out from the samples, so alerts.mjs opens
// them on the first sighting and clears them on the first absence (its SELF_TIMED kinds): its own
// 2-minute raise and 5-minute clear on top would only stack a second delay on the first.
//
// Each alert has two thresholds (hysteresis): a high one to open and a lower one it must fall under to
// clear, so a number hovering at the line is one alert and not a message every minute. Which alerts
// were up at the last look is the only state, kept by makeServerHealth; serverHealthAlerts itself is a
// plain function of the samples, the disks and that list. No I/O and no SDK: tested on any machine
// (test/server-health-alerts.test.mjs).

export const KINDS = Object.freeze(['server-overloaded', 'server-disk', 'nvr-failing', 'viewers-refused'])

const GB = 2 ** 30 // as `df -h` counts them, which is what anybody checking will look at

export const LIMITS = Object.freeze({
  // load1 at or over the number of cores for this many minutes in a row opens it ...
  overloadMinutes: 10,
  // ... and it clears once load1 has been under this share of the cores for this many minutes
  overloadClearShare: 0.8,
  overloadClearMinutes: 5,
  // free space on the server's own disk: under this opens, over the second clears
  diskLowBytes: 1.5 * GB,
  diskClearBytes: 2 * GB,
  // one recorder, over the last 30 minutes: this many failed starts and stalls, or this many
  // re-logins, opens; under half of both clears
  nvrWindowMinutes: 30,
  nvrFailures: 30,
  nvrRelogins: 6,
  // conversions refused (no room) in this many of the last 10 minutes opens; in at most one clears
  refusedMinutes: 3,
  refusedWindowMinutes: 10,
  refusedClearMinutes: 1
})

const MINUTE = 60_000
// a sample this much later than the one before still follows on from it (one is taken a minute)
const GAP_MS = 90_000

const one = (v) => (Math.round(v * 10) / 10).toString()
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

/**
 * The samples counting back from the newest while `ok` holds and each follows on from the next
 * (no minute missed): how many minutes in a row something has been true. 0 when the newest sample
 * is not from the last two minutes -- a stopped sampler says nothing about now.
 */
function runFromNewest(samples, now, ok) {
  let n = 0
  let after = now
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]
    if (!(after - s.t <= (n === 0 ? 2 * MINUTE : GAP_MS))) break
    if (!ok(s)) break
    n++
    after = s.t
  }
  return n
}

/** Load and cores of a sample, or null when either is not known. */
const loadOf = (s) => (Number.isFinite(s?.load1) && Number.isFinite(s?.cpuCount) && s.cpuCount > 0 ? { load: s.load1, cores: s.cpuCount } : null)

/**
 * The server-health alerts that should be up now, with their wording, as alerts.mjs candidates
 * ({ key, kind, title, detail }). The alert-send line is "<title> — <detail>".
 * @param {object} o
 * @param {object[]} o.samples   metrics-history.mjs samples, oldest first (its recent())
 * @param {{ path: string, freeBytes: number|null }[]} [o.disks] the server's own filesystems (diskFree)
 * @param {Record<string, string>} [o.nvrNames] NVR id -> the name people know it by
 * @param {Set<string>} [o.wasUp] the keys that were up at the last look (the lower thresholds apply)
 * @param {number} o.now
 * @param {typeof LIMITS} [o.limits]
 */
export function serverHealthAlerts({ samples = [], disks = [], nvrNames = {}, wasUp = new Set(), now, limits = LIMITS }) {
  const L = limits
  const list = samples.filter((s) => Number.isFinite(s?.t) && s.t <= now).sort((a, b) => a.t - b.t)
  const out = []

  // ---- overloaded: the load average at or over the number of cores ----
  {
    const key = 'server-overloaded'
    const newest = loadOf(list.at(-1))
    const over = runFromNewest(list, now, (s) => {
      const l = loadOf(s)
      return l !== null && l.load >= l.cores
    })
    // the same stretch counted on the lower line: how long it has been busy, for a held alert's wording
    const busy = runFromNewest(list, now, (s) => {
      const l = loadOf(s)
      return l !== null && l.load >= l.cores * L.overloadClearShare
    })
    const calm = runFromNewest(list, now, (s) => {
      const l = loadOf(s)
      return l !== null && l.load < l.cores * L.overloadClearShare
    })
    const fresh = newest !== null && now - list.at(-1).t <= 2 * MINUTE
    // Held while it has not yet been calm for the clear time. With no fresh sample nothing is known
    // about now, so an open alert stays as it is rather than clearing and opening again.
    const up = over >= L.overloadMinutes || (wasUp.has(key) && calm < L.overloadClearMinutes)
    if (up) {
      const minutes = over >= L.overloadMinutes ? over : busy
      out.push({
        key,
        kind: key,
        title: fresh
          ? `Server overloaded: load ${one(newest.load)} on ${newest.cores} cores${minutes > 0 ? ` for ${plural(minutes, 'minute')}` : ''}`
          : 'Server overloaded',
        detail: 'video may stutter'
      })
    }
  }

  // ---- the server's own disk nearly full ----
  for (const d of disks) {
    if (!d?.path) continue
    const key = `server-disk/${d.path}`
    const free = Number.isFinite(d.freeBytes) ? d.freeBytes : null
    // a disk that could not be read this time: an open alert stays open, nothing new opens
    const up = free === null ? wasUp.has(key) : free < L.diskLowBytes || (wasUp.has(key) && free <= L.diskClearBytes)
    if (!up) continue
    out.push({
      key,
      kind: 'server-disk',
      title: free === null ? `Server disk nearly full (${d.path})` : `Server disk nearly full: ${one(free / GB)} GB free on ${d.path}`,
      detail: 'when it fills up the server cannot save its settings or logs and may stop'
    })
  }

  // ---- one recorder failing: streams that will not start or keep stalling, or logging in again ----
  {
    const since = now - L.nvrWindowMinutes * MINUTE
    const per = new Map() // id -> { failures, relogins }
    for (const s of list) {
      if (s.t <= since) continue
      for (const [id, c] of Object.entries(s.perNvr ?? {})) {
        const n = per.get(id) ?? { failures: 0, relogins: 0 }
        n.failures += (Number.isFinite(c?.failedStarts) ? c.failedStarts : 0) + (Number.isFinite(c?.stalls) ? c.stalls : 0)
        n.relogins += Number.isFinite(c?.relogins) ? c.relogins : 0
        per.set(id, n)
      }
    }
    // an NVR held up whose counts stopped altogether is still looked at (and clears on zero)
    for (const k of wasUp) if (k.startsWith('nvr-failing/') && !per.has(k.slice(12))) per.set(k.slice(12), { failures: 0, relogins: 0 })
    for (const [id, n] of [...per].sort(([a], [b]) => a.localeCompare(b))) {
      const key = `nvr-failing/${id}`
      const raise = n.failures >= L.nvrFailures || n.relogins >= L.nvrRelogins
      const hold = n.failures >= L.nvrFailures / 2 || n.relogins >= L.nvrRelogins / 2
      if (!(raise || (wasUp.has(key) && hold))) continue
      const name = nvrNames[id] || id
      const what = [
        n.failures ? `${plural(n.failures, 'stream')} failed or stalled` : '',
        n.relogins ? `${plural(n.relogins, 're-login')}` : ''
      ].filter(Boolean).join(' and ')
      out.push({
        key,
        kind: 'nvr-failing',
        title: `Recorder ${name} failing: ${what} in ${L.nvrWindowMinutes} minutes`,
        detail: 'its cameras may drop out or freeze; it may be overloaded or its link poor'
      })
    }
  }

  // ---- viewers refused: conversions turned away for want of room ----
  {
    const key = 'viewers-refused'
    const since = now - L.refusedWindowMinutes * MINUTE
    let minutes = 0
    let total = 0
    for (const s of list) {
      if (s.t <= since) continue
      const n = (Number.isFinite(s.sub?.refused) ? s.sub.refused : 0) + (Number.isFinite(s.main?.refused) ? s.main.refused : 0)
      if (n > 0) {
        minutes++
        total += n
      }
    }
    if (minutes >= L.refusedMinutes || (wasUp.has(key) && minutes > L.refusedClearMinutes)) {
      out.push({
        key,
        kind: key,
        title: `Viewers refused: ${plural(total, 'picture')} turned away in ${minutes} of the last ${L.refusedWindowMinutes} minutes`,
        detail: 'the server is converting as many cameras as it is allowed for PCs that cannot play H.265; those PCs were shown "server busy" or the standard picture'
      })
    }
  }
  return out
}

/**
 * Free space on the server's own filesystems: each path's, once per filesystem (two paths on the same
 * disk are one entry, the first named). A path that does not exist is left out (/opt/cctv on a
 * development PC); one that cannot be read is { freeBytes: null }.
 * @param {string[]} paths
 * @param {{ statSync: Function, statfsSync: Function }} fs node:fs (tests: fakes)
 */
export function diskFree(paths, { statSync, statfsSync }) {
  const seen = new Set()
  const out = []
  for (const path of paths) {
    if (!path) continue
    let dev
    try {
      dev = statSync(path).dev
    } catch {
      continue // not there: nothing to watch
    }
    if (seen.has(dev)) continue
    seen.add(dev)
    try {
      const s = statfsSync(path)
      out.push({ path, freeBytes: Number(s.bavail) * Number(s.bsize) })
    } catch {
      out.push({ path, freeBytes: null })
    }
  }
  return out
}

/**
 * The state around serverHealthAlerts: which were up at the last look. candidates() never throws --
 * a broken provider must not stop the other alerts being checked -- and on a failure answers what it
 * answered last time, so nothing clears and opens again over a hiccup. A failure is said once an hour.
 * @param {{ samples: () => object[], disks?: () => object[], nvrNames?: () => Record<string, string>,
 *   now?: () => number, log?: (line: string) => void, limits?: typeof LIMITS }} o
 */
export function makeServerHealth({ samples, disks = () => [], nvrNames = () => ({}), now = Date.now, log = (line) => console.warn(line), limits = LIMITS }) {
  let last = []
  let saidAt = -Infinity
  return {
    candidates() {
      try {
        const out = serverHealthAlerts({ samples: samples() ?? [], disks: disks() ?? [], nvrNames: nvrNames() ?? {}, wasUp: new Set(last.map((a) => a.key)), now: now(), limits })
        last = out
        return out
      } catch (e) {
        if (now() - saidAt >= 3_600_000) {
          saidAt = now()
          log(`[alerts] the server-health checks failed: ${e?.message ?? e} (said once an hour)`)
        }
        return last
      }
    }
  }
}
