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

// ---- time-lapse and retention: the switch and what the jobs last did ----------------------------
// /api/storage `jobs` (storage-report.mjs jobsReport): { mode, defaults, camerasOwnDays, thinning,
// retention }, the last two being each job's last run (storage-jobs.mjs) or null.

/** The switch's three positions, in the owner's words (2026-09-29). */
export const THINNING_CHOICES = [
  { value: 'dry-run', text: 'Dry run — shows what it would do, changes nothing' },
  { value: 'on', text: 'On — converts and deletes as set' },
  { value: 'off', text: 'Off' }
]

const count = (n) => n.toLocaleString('en-GB')
const cams = (n) => (n === 1 ? '1 camera has days of its own' : `${count(n)} cameras have days of their own`)

/** "Full video for 7 days, then time-lapse (one picture every 10 s) until day 30, then deleted." */
function planText(jobs) {
  const d = jobs.defaults ?? {}
  if (!Number.isFinite(d.fullDays) || !Number.isFinite(d.retentionDays)) return NOT_AVAILABLE
  const main =
    d.after === 'timelapse' && d.fullDays < d.retentionDays
      ? `Full video for ${days(d.fullDays)}, then time-lapse (one picture every ${d.timelapseS} s) until day ${d.retentionDays}, then deleted.`
      : `Everything kept for ${days(d.retentionDays)}, then deleted.`
  return jobs.camerasOwnDays ? `${main} ${cams(jobs.camerasOwnDays)} (Settings › Recording).` : main
}

/** "16:05", or "1 Oct 16:05" when it was not in the last day. */
function when(ms, now) {
  const d = new Date(ms)
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return now - ms < 86_400_000 ? time : `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${time}`
}

/** One job's line: "Last run 16:05 (dry run): would convert 1,240 files, freeing 310 GB". */
function runLine(job, r, now) {
  const label = job === 'thinning' ? 'Time-lapse' : 'Retention'
  if (!r) return { job, label, text: 'not run yet since the server started (it runs every 5 minutes while the server records)', state: '', warnings: [] }
  if (r.mode === 'off') return { job, label, text: `Switched off: not run (checked ${when(r.at, now)})`, state: '', warnings: [] }
  const head = `Last run ${when(r.at, now)}${r.dryRun ? ' (dry run)' : ''}`
  // the job's own warnings go with it: for unreadable bookmarks they hold the reason
  if (r.error) return { job, label, text: `${head} failed: ${r.error}`, state: 'bad', warnings: [...(r.warnings ?? [])] }
  const thin = job === 'thinning'
  let text = r.segments
    ? `${head}: ${thin ? (r.dryRun ? 'would convert' : 'converted') : r.dryRun ? 'would delete' : 'deleted'} ${count(r.segments)} ${r.segments === 1 ? 'file' : 'files'}, ${r.dryRun ? 'freeing' : 'freed'} ${bytes(r.bytes)}`
    : `${head}: nothing to ${thin ? 'convert' : 'delete'} yet`
  if (r.reachedLimit) text += r.dryRun ? ' — the most one run looks at, so there is more' : ' — the most one run takes on; the rest follows in the next runs'
  if (r.skipped) text += ` · ${count(r.skipped)} skipped${r.skippedWhy?.length ? ` (${r.skippedWhy.map((s) => `${s.why} ${count(s.n)}`).join(', ')})` : ''}`
  const warnings = [...(r.warnings ?? [])]
  if (r.warningCount > warnings.length) warnings.push(`and ${count(r.warningCount - warnings.length)} more (the server log has them all)`)
  // Files in play and nobody asked which are bookmarked (storage-jobs.mjs `unprotected`); an empty
  // index also has nobody asked, and is no alarm.
  if (r.unprotected) warnings.unshift('Bookmarks could not be read: nothing was treated as bookmarked or exported.')
  return { job, label, text, state: r.unprotected ? 'bad' : warnings.length ? 'warn' : '', warnings }
}

/**
 * @param {object|undefined} jobs /api/storage `jobs`
 * @returns {{ mode: string|null, plan: string, lines: object[] }}
 */
export function jobsView(jobs, { now = Date.now() } = {}) {
  if (!jobs) {
    // an older server: say nothing we do not know
    const none = (job, label) => ({ job, label, text: NOT_AVAILABLE, state: '', warnings: [] })
    return { mode: null, plan: NOT_AVAILABLE, lines: [none('thinning', 'Time-lapse'), none('retention', 'Retention')] }
  }
  return { mode: jobs.mode ?? 'dry-run', plan: planText(jobs), lines: [runLine('thinning', jobs.thinning, now), runLine('retention', jobs.retention, now)] }
}

/** The question asked before the switch goes to On: what it will do, in so many words. */
export function switchOnWarning(jobs) {
  const d = jobs?.defaults ?? {}
  const full = Number.isFinite(d.fullDays) ? `older than ${days(d.fullDays)}` : 'older than its full-video days'
  const total = Number.isFinite(d.retentionDays) ? `older than ${days(d.retentionDays)}` : 'older than its total days'
  // the same test as planText: no time-lapse is promised where there is no stretch for it
  const both = d.after === 'timelapse' && !(d.fullDays >= d.retentionDays)
  const what = both
    ? `Footage ${full} (the full-video days) will be rewritten to time-lapse, one picture every ${d.timelapseS ?? '?'} s, and footage ${total} (the total days) deleted, for good. Neither can be undone.`
    : `Footage ${total} (the total days) will be deleted, for good. This cannot be undone.`
  const own = jobs?.camerasOwnDays ? `\n\n${cams(jobs.camerasOwnDays)} (Settings › Recording) and ${jobs.camerasOwnDays === 1 ? 'follows' : 'follow'} those.` : ''
  // "kept" must not read as "kept for ever": housekeeping.mjs does not ask the bookmarks (2026-09-29),
  // and it deletes past the total days whatever this switch says. Out when it does ask them.
  const kept = 'Bookmarked and exported stretches are kept by these two jobs. The clean-up rules on this tab still delete footage past the total days, bookmarked or not, whatever this switch says.'
  return `Switch time-lapse and retention ON?\n\n${what}\n\n${kept}${own}`
}

/**
 * What Save does with the choice picked: always sent, and On always asked about first. The page's
 * idea of the switch can be a minute old (another admin, another tab), and saying "No change" on
 * that once left the switch On while the admin believed they had set it Off (review 2026-09-29).
 * Sending an unchanged value is harmless: the audit names the switch only when it really moves.
 */
export function saveSteps(want) {
  if (!THINNING_CHOICES.some((c) => c.value === want)) return { send: false, ask: false }
  return { send: true, ask: want === 'on' }
}

// ---- painting ------------------------------------------------------------------------------------
// Nothing above this line touches the DOM.

if (typeof document !== 'undefined') {
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props)

  function paint(data) {
    const r = renderStorage(data)
    document.getElementById('sr-warnings').replaceChildren(...r.warnings.map((w) => el('li', { textContent: w })))
    document.getElementById('sr-totals').textContent = r.empty
      ? 'No storage locations are set up yet.'
      : `${r.totals.mounted} of ${r.totals.locations} locations mounted · ${r.totals.used} used · ${r.totals.free} free`

    // a camera table someone opened stays open across the minute's refresh (it was rebuilt closed)
    const openFolds = new Set([...document.querySelectorAll('#sr-locations details.sr-cams[open]')].map((x) => x.dataset.key))
    document.getElementById('sr-locations').replaceChildren(
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
          // folded: a hundred cameras is a hundred rows, and the cards above already say how it stands
          const fold = el('details', { className: 'sr-cams' })
          fold.dataset.key = l.title
          fold.open = openFolds.has(l.title)
          fold.append(el('summary', { textContent: `How far back each camera goes (${l.cameras.length})` }))
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
          fold.append(table)
          panel.append(fold)
        }
        return panel
      })
    )
  }

  // ---- the time-lapse and retention switch --------------------------------------------------------
  let jobs = null // the last /api/storage `jobs`
  let picked = null // a choice clicked but not saved yet: the minute's repaint must not undo it
  const say = (text, bad = false) => {
    const m = document.getElementById('sj-msg')
    m.textContent = text
    m.className = bad ? 'st-error' : 'st-meta'
  }

  function paintJobs(data) {
    const form = document.getElementById('sj-form')
    if (!form) return
    jobs = data?.jobs ?? null
    const v = jobsView(jobs)
    document.getElementById('sj-plan').textContent = v.plan
    const box = document.getElementById('sj-choices')
    if (!box.querySelector('input')) {
      for (const c of THINNING_CHOICES) {
        const input = el('input', { type: 'radio', name: 'sj-mode', value: c.value })
        input.addEventListener('change', () => (picked = input.value))
        const label = el('label')
        label.append(input, c.text)
        box.append(label)
      }
    }
    const show = picked ?? v.mode
    for (const r of box.querySelectorAll('input')) r.checked = r.value === show
    form.querySelector('button[type="submit"]').disabled = v.mode === null
    document.getElementById('sj-runs').replaceChildren(
      ...v.lines.map((l) => {
        const li = el('li')
        li.append(el('strong', { textContent: `${l.label}: ` }), el('span', { textContent: l.text, className: l.state }))
        if (l.warnings.length) {
          const list = el('ul')
          list.append(...l.warnings.map((w) => el('li', { textContent: w })))
          li.append(list)
        }
        return li
      })
    )
  }

  document.getElementById('sj-form')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const want = document.querySelector('input[name="sj-mode"]:checked')?.value
    const steps = saveSteps(want)
    if (!steps.send || !jobs?.mode) return
    // On is the one that destroys footage: say exactly what it will do, and take no for an answer.
    if (steps.ask && !confirm(switchOnWarning(jobs))) {
      picked = null
      paintJobs({ jobs })
      return say('Not changed')
    }
    try {
      const res = await fetch('/api/admin/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storage: { thinning: want } }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      picked = null
      say(`Saved: ${THINNING_CHOICES.find((c) => c.value === body.settings?.storage?.thinning)?.text ?? want}`)
      load()
    } catch (err) {
      say(err.message, true)
    }
  })

  const load = () =>
    fetch('/api/storage')
      .then((x) => x.json())
      .then((data) => {
        paint(data)
        paintJobs(data)
      })
      .catch(() => {})
  load()
  setInterval(load, 60_000)
}
