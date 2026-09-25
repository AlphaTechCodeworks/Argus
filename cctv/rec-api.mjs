// The playback page's timeline from the server's recordings, in one request and from the database
// only: it never calls the NVR (it answers while the NVR is busy or offline).
//
//   GET /api/playback/timeline?nvr=ID&ch=N&from=ms&to=ms      (0 < to - from <= 48 h)
//     -> { available: false }   flag off (no index), not allowed (rec-access.mjs), or no recordings
//      | { available: true, now, tzOffsetMs|null, skewMs, firstMs, codec: 'h264'|'h265',
//          ranges: [[s, e]], gaps: [[s, e, reason]] }
//   All times are the server's clock (UTC ms). tzOffsetMs and skewMs (NVR clock - server clock)
//   come from the NVR's last clock read (playback.mjs lastClock()): null and 0 when there is none.
import { canPlayServer } from './rec-access.mjs'

const MAX_SPAN_MS = 48 * 3_600_000
const INT = /^\d{1,15}$/

/**
 * @param {{ nvr: object|undefined, params: URLSearchParams, who: {user?: string, admin?: boolean}|null,
 *           index: object|null, now?: number }} opts  index: rec-index.mjs (null: CCTV_LIVE_WORKER off)
 * @returns {[number, object]} status and body
 */
export function timelineApi({ nvr, params, who, index, now = Date.now() }) {
  if (!nvr) return [404, { error: 'Unknown NVR' }]
  const raw = { ch: params.get('ch') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '' }
  if (!/^\d{1,3}$/.test(raw.ch) || !INT.test(raw.from) || !INT.test(raw.to)) return [400, { error: 'ch, from and to (UTC ms) required' }]
  const ch = Number(raw.ch)
  const from = Number(raw.from)
  const to = Number(raw.to)
  if (to <= from) return [400, { error: 'to must be after from' }]
  if (to - from > MAX_SPAN_MS) return [400, { error: 'at most 48 hours per request' }]
  if (!index || !canPlayServer(who, nvr.id, ch)) return [200, { available: false }]
  try {
    const first = index.first(nvr.id, ch)
    if (!first) return [200, { available: false }]
    const { ranges, gaps, codec } = index.timeline(nvr.id, ch, from, to, now)
    const clock = nvr.playback?.lastClock?.() ?? null // stored: no NVR call
    return [200, { available: true, now, tzOffsetMs: clock?.tzOffsetMs ?? null, skewMs: clock?.skewMs ?? 0, firstMs: first.startMs, codec, ranges, gaps }]
  } catch (e) {
    return [500, { error: `recordings index: ${e.message}` }]
  }
}
