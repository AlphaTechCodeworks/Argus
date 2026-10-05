// The site's own wall-clock time. The server runs on UTC (TZ=UTC in the unit); the site is not, and
// the things people set in local terms -- the backfill's off-peak window "01:00-05:00", alarm rule
// schedules, where a day starts in a report, when the daily summary goes out -- must follow the
// site's clock, not the server's. (Until 2026-09-26 the backfill's 01:00-05:00 ran 21:00-01:00 on
// site, UTC-4.)
//
// Where the offset comes from, first that answers:
//   1. what the NVRs themselves are set to (nvr-clock.mjs reads each one's time zone), via useSiteOffset
//   2. CCTV_SITE_TZ_OFFSET_MIN in /etc/cctv/cctv.env (minutes to add to UTC, e.g. -240)
//   3. the server's own zone (the behaviour before, and what the tests on a PC get)

let provider = () => null

/** Where the site's offset comes from (server.mjs: the NVRs' zones). */
export function useSiteOffset(fn) {
  provider = typeof fn === 'function' ? fn : () => null
}

/** Minutes to add to UTC to get the site's wall clock (e.g. -240), at `ms`. */
export function siteOffsetMin(ms = Date.now()) {
  const v = provider()
  if (Number.isFinite(v)) return v
  const env = Number(process.env.CCTV_SITE_TZ_OFFSET_MIN)
  if (process.env.CCTV_SITE_TZ_OFFSET_MIN !== undefined && Number.isFinite(env)) return env
  return -new Date(ms).getTimezoneOffset()
}

/** Minutes past midnight on the site's clock. */
export function siteMinutesOfDay(ms) {
  const d = new Date(Number(ms) + siteOffsetMin(ms) * 60_000)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/** The site's date (YYYY-MM-DD) at `ms`. */
export function siteDate(ms) {
  return new Date(Number(ms) + siteOffsetMin(ms) * 60_000).toISOString().slice(0, 10)
}

/** The UTC moment the site's day `date` (YYYY-MM-DD) starts. */
export function siteDayStart(date) {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`)
  return utcMidnight - siteOffsetMin(utcMidnight) * 60_000
}

/**
 * The most common of the NVRs' zone offsets (minutes), or null when none has been read. Several
 * NVRs on one site should agree; one set wrongly is outvoted rather than moving the whole site.
 */
export function commonOffset(offsets) {
  const counts = new Map()
  for (const o of offsets) if (Number.isFinite(o)) counts.set(o, (counts.get(o) ?? 0) + 1)
  let best = null
  let n = 0
  for (const [o, c] of counts) if (c > n) [best, n] = [o, c]
  return best
}
