// The Storage page. renderStorage() shapes what /api/storage answers into what the page shows and
// is pure, so it is tested without a browser (the same split health.js uses); the DOM code at the
// bottom only paints.
//
// The rule from health.js holds here too and matters more: never invent a figure. A null is
// "not available", never 0 and never "—% used". The forecast in particular is allowed to say it
// does not know, and it says so in words rather than showing a confident wrong date.

/** Anything we did not manage to read says so in words. */
export const NOT_AVAILABLE = 'not available'

/** "1.4 GB", "930 MB", or null -> "not available". */
export function bytes(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return NOT_AVAILABLE
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  let v = Math.abs(n)
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${n < 0 ? '-' : ''}${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** "12.4 days", "1 day", "today". */
export function days(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return NOT_AVAILABLE
  if (n < 1) return 'less than a day'
  const r = Math.round(n * 10) / 10
  return `${r} ${r === 1 ? 'day' : 'days'}`
}

const pctText = (n) => (Number.isFinite(n) ? `${Math.round(n)} %` : NOT_AVAILABLE)

/**
 * The "full in N days" line. Every not-confident case gets its own sentence: the forecast is the
 * one figure on this page somebody would act on, so an honest "we cannot say yet" is the whole
 * point of it.
 */
export function forecastCell(f, { alertDays = 7 } = {}) {
  if (!f) return { value: NOT_AVAILABLE, state: 'ok', note: '' }
  const growth = Number.isFinite(f.bytesPerDay) && f.bytesPerDay > 0 ? `growing ${bytes(f.bytesPerDay)} a day` : ''
  if (!f.confident || !Number.isFinite(f.daysToFull)) {
    return {
      value: NOT_AVAILABLE,
      state: 'ok',
      note: f.reason === 'not filling up' ? 'not filling up (recycling, or nothing is being written)' : f.reason || 'not enough history yet'
    }
  }
  return {
    value: f.daysToFull < 1 ? 'full today' : `full in ${days(f.daysToFull)}`,
    state: f.daysToFull < alertDays ? 'bad' : f.daysToFull < alertDays * 4 ? 'warn' : 'ok',
    note: growth
  }
}

/** One camera row: days kept here against what the camera is meant to keep. */
function cameraRow(c) {
  const target = Number.isFinite(c.targetDays) ? `${c.targetDays} days` : NOT_AVAILABLE
  return {
    camera: c.camera,
    kept: days(c.daysKept),
    target,
    // null (we cannot say) is not "failing": it gets no colour at all.
    state: c.meetsTarget === null || c.meetsTarget === undefined ? '' : c.meetsTarget ? 'ok' : 'warn',
    short: c.meetsTarget === false && Number.isFinite(c.daysKept) && Number.isFinite(c.targetDays) ? `${days(c.targetDays - c.daysKept)} short` : ''
  }
}

/**
 * @param {object} data the body of /api/storage
 * @returns {{ locations: object[], warnings: string[], totals: object, empty: boolean }}
 */
export function renderStorage(data, { alertDays = 7 } = {}) {
  const d = data ?? {}
  const locations = (d.locations ?? []).map((l) => {
    const usable = l.mounted && Number.isFinite(l.usedBytes)
    return {
      id: l.id,
      path: l.path,
      title: `${l.path} · ${l.type ?? '?'} · ${l.role ?? '?'}`,
      mounted: l.mounted === true,
      status: l.mounted ? { value: 'Mounted', state: 'ok' } : { value: 'Not mounted', state: 'bad' },
      used: usable ? `${bytes(l.usedBytes)} of ${bytes(l.totalBytes)}` : NOT_AVAILABLE,
      usedPct: usable ? pctText(l.usedPct) : NOT_AVAILABLE,
      free: usable ? bytes(l.freeBytes) : NOT_AVAILABLE,
      // A drive at 98 % that is recycling is fine; the colour follows the thresholds, not a guess.
      usedState: !usable ? 'ok' : Number.isFinite(l.freePct) && l.freePct <= (l.floorFreePct ?? 5) ? 'bad' : Number.isFinite(l.freePct) && l.freePct <= (l.lowFreePct ?? 15) ? 'warn' : 'ok',
      growth: l.forecast && Number.isFinite(l.forecast.bytesPerDay) ? `${bytes(l.forecast.bytesPerDay)} a day` : NOT_AVAILABLE,
      forecast: forecastCell(l.forecast, { alertDays }),
      recycling: l.cycling === true ? 'yes — oldest footage is being overwritten as designed' : l.cycling === false ? 'not yet' : NOT_AVAILABLE,
      cameras: (l.cameras ?? []).map(cameraRow)
    }
  })
  const totals = {
    locations: locations.length,
    mounted: locations.filter((l) => l.mounted).length,
    // Summed only over the locations we could actually read; nothing is assumed for the rest.
    used: bytes((d.locations ?? []).reduce((a, l) => (Number.isFinite(l.usedBytes) ? a + l.usedBytes : a), 0) || null),
    free: bytes((d.locations ?? []).reduce((a, l) => (Number.isFinite(l.freeBytes) ? a + l.freeBytes : a), 0) || null)
  }
  return { locations, warnings: d.warnings ?? [], totals, empty: locations.length === 0 }
}

// ---- painting ------------------------------------------------------------------------------------
// Nothing above this line touches the DOM.

if (typeof document !== 'undefined') {
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props)

  function paint(data) {
    const r = renderStorage(data)
    document.getElementById('warnings').replaceChildren(...r.warnings.map((w) => el('li', { textContent: w })))
    document.getElementById('totals').textContent = r.empty
      ? 'No storage locations are set up yet.'
      : `${r.totals.mounted} of ${r.totals.locations} locations mounted · ${r.totals.used} used · ${r.totals.free} free`

    document.getElementById('locations').replaceChildren(
      ...r.locations.map((l) => {
        const panel = el('section', { className: 'nvr-panel' })
        const head = el('div', { className: 'nvr-head' })
        head.append(el('h3', { textContent: l.title }), el('span', { className: `pill ${l.status.state}`, textContent: l.status.value }))
        panel.append(head)

        const cards = el('div', { className: 'cards' })
        for (const c of [
          { label: 'Used', value: l.usedPct, state: l.usedState, note: l.used },
          { label: 'Free', value: l.free, state: 'ok', note: '' },
          { label: 'Growth', value: l.growth, state: 'ok', note: '' },
          { label: 'Forecast', value: l.forecast.value, state: l.forecast.state, note: l.forecast.note },
          { label: 'Recycling', value: l.recycling, state: 'ok', note: '' }
        ]) {
          const node = el('div', { className: `card ${c.state}` })
          node.append(el('div', { className: 'lbl', textContent: c.label }), el('div', { className: 'big', textContent: c.value }), el('div', { className: 'note', textContent: c.note }))
          cards.append(node)
        }
        panel.append(cards)

        if (l.cameras.length) {
          const table = el('table', { className: 'hp-table' })
          const thead = el('thead')
          const hr = el('tr')
          for (const t of ['Camera', 'Kept here', 'Target', '']) hr.append(el('th', { textContent: t }))
          thead.append(hr)
          const tbody = el('tbody')
          for (const c of l.cameras) {
            const tr = el('tr')
            tr.append(el('td', { textContent: c.camera }), el('td', { textContent: c.kept, className: c.state }), el('td', { textContent: c.target }), el('td', { textContent: c.short, className: 'hp-sub' }))
            tbody.append(tr)
          }
          table.append(thead, tbody)
          panel.append(table)
        }
        return panel
      })
    )
  }

  fetch('/api/me')
    .then((x) => (x.ok ? x.json() : Promise.reject(new Error('signed out'))))
    .then((me) => {
      document.getElementById('whoami').textContent = me.user
      if (me.admin) {
        document.getElementById('sitesTab').hidden = false
        document.getElementById('settingsTab').hidden = false
      }
    })
    .catch(() => {
      location.href = '/login.html'
    })

  document.getElementById('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' })
    location.href = '/login.html'
  })

  const load = () => fetch('/api/storage').then((x) => x.json()).then(paint).catch(() => {})
  load()
  setInterval(load, 60_000)
}
