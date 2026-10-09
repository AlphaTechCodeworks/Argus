// Health, "Viewing experience" (admins): what /api/admin/telemetry answers, shaped into the rows the
// page draws. Pure, so it is tested without a page (test/telemetry.test.mjs); health.js only draws.
//
// Two rows: the viewers the optimiser serves, and the holdout it leaves on today's fixed rules. While
// the optimiser decides nothing yet the two are served alike, and should score alike.
import { PARTS, WEIGHTS } from './qoe.js'

const LABEL = { smoothness: 'Smoothness', startup: 'First picture', scrubbing: 'Scrubbing', switching: 'Switching', stability: 'Stability', efficiency: 'Efficiency' }
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}` : '–')

/**
 * @param {{ hours?: number, cohorts?: object, kept?: object }|null} d /api/admin/telemetry
 * @returns {{ heads: string[], rows: string[][], note: string }}
 */
export function experienceView(d) {
  const heads = ['Viewers', 'Score', ...PARTS.map((p) => `${LABEL[p]} (${Math.round(WEIGHTS[p] * 100)}%)`), 'Sessions', 'Measured']
  const row = (name, c) => [name, pct(c?.score), ...PARTS.map((p) => pct(c?.parts?.[p])), String(c?.sessions ?? 0), `${Math.round((c?.tileSeconds ?? 0) / 60)} tile-min`]
  const c = d?.cohorts ?? {}
  const rows = [row('Optimised', c.apsi), row('Holdout (today’s rules)', c.holdout)]
  const seen = (c.apsi?.batches ?? 0) + (c.holdout?.batches ?? 0)
  const parts = [...new Set([...(c.apsi?.from ?? []), ...(c.holdout?.from ?? [])])]
  const missing = PARTS.filter((p) => !parts.includes(p)).map((p) => LABEL[p].toLowerCase())
  const lost = d?.kept?.notWritten > 0 ? ` ${d.kept.notWritten} batches were not kept (the store was full or could not be written).` : ''
  const note = seen === 0
    ? 'Nothing measured yet in this period.'
    : `Out of 100, over the last ${d?.hours ?? 24} hours, since the server last started. Each score is made only from the parts that were seen${missing.length ? `; not seen yet: ${missing.join(', ')}` : ''}.${lost}`
  return { heads, rows, note, ...nvrView(d), ...wallView(d) }
}

const secs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '–')

/** Each screen at each number of cameras at once: the share of arriving frames it drew. Biggest walls first. */
export function wallView(d) {
  const wallHeads = ['Person', 'Screen', 'Cameras at once', 'Frames shown', 'Readings', 'Last seen (UTC)']
  const wallRows = (d?.walls ?? []).slice(0, 40).map((w) => [
    String(w.user), String(w.device).slice(0, 6), String(w.tiles), `${Math.round(w.share * 100)}%`, String(w.moments),
    Number.isFinite(w.at) ? new Date(w.at).toISOString().slice(0, 16).replace('T', ' ') : '–'
  ])
  return { wallHeads, wallRows }
}

/** The same answer by NVR, slowest to a first picture first: where the waiting actually is. */
export function nvrView(d) {
  const nvrHeads = ['NVR', 'Opens', 'First picture', '9 in 10 within', 'Full quality', 'Smoothness', 'Frozen', 'Reconnects']
  const nvrRows = (d?.nvrs ?? []).filter((n) => n.opens > 0 || n.tileSeconds > 0).slice(0, 30).map((n) => [
    String(n.nvr), String(n.opens), secs(n.firstMs), secs(n.firstMs90), secs(n.hdMs), pct(n.smoothness),
    Number.isFinite(n.frozenShare) ? `${(n.frozenShare * 100).toFixed(1)}%` : '–', String(n.reconnects ?? 0)
  ])
  return { nvrHeads, nvrRows }
}
