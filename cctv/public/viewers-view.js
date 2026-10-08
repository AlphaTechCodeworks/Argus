// Health, "Who is watching" (admins): what /api/admin/viewers answers, shaped into the rows the page
// paints. Pure, like renderHealth in health.js, so it is tested without a browser
// (test/viewers-view.test.mjs); health.js only paints what this returns, as text.

/** The most rows painted: the page is repainted every few seconds and is for a glance. */
export const MAX_ROWS = 60

/** "under a minute", "41 m", "1 h 21 m", "2 d 3 h": how long someone has been connected. */
export function connectedFor(ms) {
  if (!Number.isFinite(ms) || ms < 60_000) return 'under a minute'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m} m`
  if (m < 24 * 60) return `${Math.floor(m / 60)} h ${m % 60} m`
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// what a live stream is being sent (viewers.mjs liveKind); the camera's own stream needs no words
const KIND_TEXT = {
  remote: 'fitted to a remote link',
  phone: 'phone stream',
  h264: 'converted to H.264 for a PC without H.265'
}
const SOURCE_TEXT = { server: 'server recordings', nvr: 'from the NVR' }

const cameraName = (o) => (typeof o.camera === 'string' && o.camera ? o.camera : `Camera ${Number(o.ch) + 1}`)

/** One thing someone has open, as a line: "Cashier Front — live, sub-stream, phone stream". */
export function openLine(o, type) {
  const parts = type === 'live'
    ? ['live', o.stream === 'main' ? 'main stream' : 'sub-stream', KIND_TEXT[o.kind]]
    : type === 'playback'
      ? ['playback', SOURCE_TEXT[o.source]]
      : [o.what === 'motion' ? 'motion search' : String(o.what ?? 'open')]
  return `${cameraName(o)} — ${parts.filter(Boolean).join(', ')}`
}

/**
 * @param {{ now?: number, viewers?: object[], total?: number }|null} d /api/admin/viewers
 * @returns {{ count: number, summary: string, empty: string, more: string, rows: Array<{ key: string, name: string,
 *   where: string, address: string, connected: string, watching: string, groups: Array<{ label: string, lines: string[] }>, more: string }> }}
 *   rows: one per browser signed in with video open, each with what it has open grouped by site and
 *   NVR; key: the same row at the next refresh (so one left open stays open); more: what was left out
 */
export function viewersView(d) {
  const all = Array.isArray(d?.viewers) ? d.viewers : []
  const now = Number.isFinite(d?.now) ? d.now : Date.now()
  const total = Number.isFinite(d?.total) ? Math.max(d.total, all.length) : all.length
  const rows = all.slice(0, MAX_ROWS).map((v) => {
    const groups = new Map() // "Site · NVR" -> lines
    let listed = 0
    const add = (list, type) => {
      for (const o of Array.isArray(list) ? list : []) {
        const label = [o.site, o.nvrName ?? o.nvr].filter(Boolean).join(' · ') || 'Unknown NVR'
        if (!groups.has(label)) groups.set(label, [])
        groups.get(label).push(openLine(o, type))
        listed++
      }
    }
    add(v.live, 'live')
    add(v.playback, 'playback')
    add(v.other, 'other')
    const c = v.counts ?? {}
    const open = (c.live ?? 0) + (c.playback ?? 0) + (c.other ?? 0)
    const cameras = Number.isFinite(c.cameras) ? c.cameras : listed
    return {
      key: `${v.user ?? ''}|${v.address ?? ''}|${v.since ?? ''}`,
      name: v.user || 'unknown',
      where: v.remote ? 'outside' : 'on the network',
      address: v.address || '',
      connected: connectedFor(now - v.since),
      // someone connected with nothing listed: a page between cameras, or a socket of another kind
      watching: cameras === 0 ? 'nothing open' : `${plural(cameras, 'camera')}${(c.playback ?? 0) > 0 ? ` · ${c.playback} in playback` : ''}`,
      groups: [...groups].map(([label, lines]) => ({ label, lines })),
      more: open > listed ? `…and ${open - listed} more` : ''
    }
  })
  const outside = all.filter((v) => v.remote).length
  return {
    count: total,
    summary: total === 0 ? '' : `${plural(total, 'person', 'people')} · ${all.length - outside} on the network · ${outside} outside`,
    empty: 'Nobody has video open right now.',
    more: total > rows.length ? `${total - rows.length} more not shown.` : '',
    rows
  }
}
