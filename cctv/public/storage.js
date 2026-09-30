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

/** Whole GB of 1,000,000,000 bytes, as a space limit is set: "5,512 GB". */
export const wholeGB = (b) => `${Math.round(b / 1e9).toLocaleString('en-GB')} GB`

/**
 * How quickly the limit takes footage away: one clean-up every 5 minutes, at most 20,000 files each
 * (housekeeping.mjs MAX_DELETES, about 240 GB of the site's 12 MB files), so a limit far below what Argus
 * holds takes several (review of p2-delete, 2026-09-29: "within 5 minutes" said otherwise).
 */
const LIMIT_PACE = 'from the next clean-up (every 5 minutes, at most about 240 GB each)'

/** Under a location with a space limit: that it is enforced, and how (housekeeping.mjs, 2026-09-29). */
export const LIMIT_TEXT = `The space limit is enforced: when Argus's recordings here go over it, the oldest are deleted down to it ${LIMIT_PACE}, footage past its full-video days first; never the newest 24 hours, nor bookmarked or exported stretches (of the cameras each bookmark names). 1 GB = 1,000,000,000 bytes.`

/**
 * Argus's recordings on a location (as the index counts them) against its space limit. A limit saved
 * before the limit was enforced (limitEnforced false: the old page saved it as a note) is shown as such.
 */
export function limitCell(l) {
  const held = Number.isFinite(l?.argusBytes) ? l.argusBytes : null
  const limit = Number.isFinite(l?.limitBytes) && l.limitBytes > 0 ? l.limitBytes : null
  if (!limit) return { value: held === null ? NOT_AVAILABLE : wholeGB(held), state: 'ok', note: 'no space limit set' }
  if (l.limitEnforced === false) return { value: held === null ? NOT_AVAILABLE : wholeGB(held), state: 'ok', note: `a ${wholeGB(limit)} limit saved before limits were enforced: not enforced until it is saved again on its card (Settings › Storage)` }
  if (held === null) return { value: NOT_AVAILABLE, state: 'ok', note: `of the ${wholeGB(limit)} limit (enforced)` }
  const pct = (held / limit) * 100
  return { value: wholeGB(held), state: held > limit ? 'bad' : pct >= 95 ? 'warn' : 'ok', note: `of the ${wholeGB(limit)} limit (enforced), ${Math.round(pct)} %` }
}

/**
 * Settings > Storage, a location's card: what saving its limit and own marks sends, and the question
 * asked first when the limit starts to be enforced or is lowered (footage over it goes from the next
 * clean-up). The limit is sent only when it changed, or to enforce one saved before limits were
 * (loc.limitEnforced false): the server checks a limit it is sent against the share's size, which is not
 * known while the share is unmounted, and a card saved for its marks alone must not fail on that (review
 * of p2-delete, 2026-09-29).
 * form: the inputs' text; empty is no limit / the default mark. The server checks everything again.
 * @returns {{ body: object|null, ask: string|null, error: string|null }}
 */
export function locationEdit(loc, form) {
  const text = (v) => String(v ?? '').trim()
  const limitGB = text(form.limitGB) === '' ? null : Number(text(form.limitGB))
  if (limitGB !== null && !(Number.isFinite(limitGB) && limitGB > 0)) return { body: null, ask: null, error: 'The space limit must be a positive number of GB (1 GB = 1,000,000,000 bytes), or empty for none.' }
  const marks = {}
  for (const [k, name] of [['lowFreePct', 'The low mark'], ['floorFreePct', 'The hard floor']]) {
    const t = text(form[k])
    const v = t === '' ? null : Number(t)
    if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= 50)) return { body: null, ask: null, error: `${name} must be a whole number from 1 to 50 (% free), or empty for the default.` }
    marks[k] = v
  }
  const had = Number(loc.limitGB) > 0 ? Number(loc.limitGB) : null
  const enforced = loc.limitEnforced === true
  const send = limitGB !== had || (limitGB !== null && !enforced)
  const body = { action: 'set', id: loc.id, ...(send ? { limitGB } : {}), ...marks }
  // asked when it starts deleting: a limit new, lower, or not enforced before
  const starts = send && limitGB !== null && (!enforced || had === null || limitGB < had)
  const ask = starts
    ? `Limit Argus's recordings on ${loc.path} to ${limitGB.toLocaleString('en-GB')} GB?\n\nThe limit is enforced: if Argus holds more than that there, its oldest footage is deleted down to the limit ${LIMIT_PACE}. Footage past its full-video days goes first; never the newest 24 hours, nor bookmarked or exported stretches. Deleted footage cannot be brought back.\n\n1 GB = 1,000,000,000 bytes.`
    : null
  return { body, ask, error: null }
}

// ---- days kept against the target (retention-target.mjs, 2026-09-30) --------------------------------------
// /api/storage `retention`: { available, reason, targetDays, camerasOwnTarget, locations: { [id]: ... }, overall }.
// The figures are the server's (measured from the index every 5 minutes); these only say them.

const targetOf = (l) => (l.targets?.length > 1 ? `${l.targets[0]}-${l.targets.at(-1)} days` : Number.isFinite(l.targetDays) ? days(l.targetDays) : NOT_AVAILABLE)
const markName = (l, what) => (what === 'limit' ? `the ${Number.isFinite(l.capacity?.limitBytes) ? wholeGB(l.capacity.limitBytes) : ''} limit` : what === 'floor' ? 'the hard floor' : 'the low mark')
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)
const pct1 = (x) => `${Math.round(x * 1000) / 10} %`
const splitOf = (s) => (s.timelapseDays > 0 ? `${days(s.fullDays)} of full video + ${days(s.timelapseDays)} of time-lapse` : 'full video only')

/** "Days kept" on a location's panel: how far back its footage goes, against the target. */
export function keptCell(ret, id) {
  const l = ret?.locations?.[id]
  if (!ret) return { value: NOT_AVAILABLE, state: 'ok', note: '' }
  if (!ret.available || !l?.available) return { value: NOT_AVAILABLE, state: 'ok', note: (ret.available ? l?.reason : ret.reason) || 'not measured yet' }
  const parts = [`target ${targetOf(l)}`]
  if (l.timelapse) parts.push(Number.isFinite(l.fullDaysKept) ? `full video ${days(l.fullDaysKept)}, then time-lapse ${days(l.timelapse.days)}` : `time-lapse ${days(l.timelapse.days)}, no full video after it`)
  else if (Number.isFinite(l.daysKept)) parts.push('no time-lapse here')
  return { value: Number.isFinite(l.daysKept) ? days(l.daysKept) : NOT_AVAILABLE, state: l.short?.actual ? 'bad' : l.short?.forecast ? 'warn' : 'ok', note: parts.join(' · ') }
}

/** "Days that fit": the forecast at the last whole days' volume under the location's limit and marks. */
export function fitCell(ret, id) {
  const l = ret?.locations?.[id]
  if (!ret?.available || !l?.available) return { value: NOT_AVAILABLE, state: 'ok', note: '' }
  const s = l.forecast?.now
  if (!s) return { value: NOT_AVAILABLE, state: 'ok', note: l.forecastReason || '' }
  const parts = [`${splitOf(s)}, at ${bytes(l.perDay)} a day (the last ${l.wholeDays.length} whole ${l.wholeDays.length === 1 ? 'day' : 'days'})`]
  if (s.reach) parts.push(s.reach.reached ? `${markName(l, s.reach.what)} reached` : Number.isFinite(s.reach.ms) ? `${markName(l, s.reach.what)} reached about ${dayOf(s.reach.ms)}` : `${markName(l, s.reach.what)} not reached at this volume`)
  const t = l.forecast.timelapse
  if (t) parts.push(`With time-lapse On: about ${days(t.daysFit)} (${splitOf(t)})`)
  if (l.share && (s.timelapseDays > 0 || t?.timelapseDays > 0)) parts.push(l.share.how === 'measured' ? `time-lapse ${pct1(l.share.value)} of full video, measured from ${l.share.files.toLocaleString('en-GB')} real time-lapse files` : `time-lapse about ${pct1(l.share.value)} of full video, an estimate from its keyframes (${Math.round(l.share.low * 1000) / 10}-${pct1(l.share.high)})`)
  return { value: s.shortBy > 0 ? `about ${days(s.daysFit)}` : `all ${days(s.targetDays)}`, state: l.short?.forecast ? 'bad' : 'ok', note: parts.join(' · ') }
}

/**
 * "Recycling" as the report's `cycling` has it (a camera there has reached its own target), or, where it deletes
 * to stay at its space limit or low mark (the days kept, retention-target.mjs), that: a NAS recycling at 8 days
 * against 30 said "not yet" beside "deleting to stay at its space limit" (seen in a browser, 2026-09-30).
 */
export function recyclingCell(l, ret) {
  const r = ret?.available ? ret.locations?.[l.id] : null
  if (r?.available && r.recycling) return { value: 'yes, for space', note: `deleting to stay at its ${r.recycling === 'limit' ? 'space limit' : 'low mark'}`, state: r.short?.actual ? 'bad' : 'ok' }
  return { value: l.cycling === true ? 'yes — oldest footage is being overwritten as designed' : l.cycling === false ? 'not yet' : NOT_AVAILABLE, note: '', state: 'ok' }
}

/** One line for every location: how far back the footage goes, against the target, and who is short of it. */
export function targetLine(ret) {
  if (!ret) return ''
  if (!ret.available) return `Days kept against the target: ${ret.reason || NOT_AVAILABLE}.`
  const o = ret.overall ?? {}
  const back = Number.isFinite(o.daysKept) ? `Footage goes back ${days(o.daysKept)}${Number.isFinite(o.fullDaysKept) && o.timelapseOldestMs ? ` (full video ${days(o.fullDaysKept)})` : ''}` : 'No footage yet'
  const own = ret.camerasOwnTarget ? ` (${ret.camerasOwnTarget === 1 ? '1 camera has' : `${ret.camerasOwnTarget} cameras have`} its own)` : ''
  const target = Number.isFinite(ret.targetDays) ? `the ${ret.targetDays}-day target${own}` : 'no target set'
  const paths = (o.short ?? []).map((id) => ret.locations?.[id]?.path ?? id)
  return `${back}, against ${target}. ${paths.length ? `Short of it: ${paths.join(', ')}.` : o.worst ? 'No location is short of it.' : 'No forecast yet.'}`
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
 * @returns {{ locations: object[], warnings: string[], totals: object, target: string, empty: boolean }}
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
      recycling: recyclingCell(l, d.retention).value,
      recyclingNote: recyclingCell(l, d.retention).note,
      recyclingState: recyclingCell(l, d.retention).state,
      limit: limitCell(l),
      limitText: Number.isFinite(l.limitBytes) && l.limitBytes > 0 && l.limitEnforced !== false ? LIMIT_TEXT : '',
      kept: keptCell(d.retention, l.id),
      fit: fitCell(d.retention, l.id),
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
  return { locations, warnings: d.warnings ?? [], totals, target: targetLine(d.retention), empty: locations.length === 0 }
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
  const withCams = jobs.camerasOwnDays ? `${main} ${cams(jobs.camerasOwnDays)} (Settings › Recording).` : main
  // how fast and when (thin-pace.mjs, 2026-09-29): the server says it, the page does not guess it
  return jobs.pace && d.after === 'timelapse' && d.fullDays < d.retentionDays ? `${withCams} Time-lapse is written at ${jobs.pace} first.` : withCams
}

/**
 * "131-135 GB" (one unit when both have it), else "930 MB-1.1 GB". Two ends that round alike ("1.3-1.3
 * TB" for a day of the site's footage: seen in a browser, 2026-09-29) are said in whole GB instead.
 */
function range(lo, hi) {
  const a = bytes(lo)
  const b = bytes(hi)
  if (a === b) return `${Math.round(lo / 1e9).toLocaleString('en-GB')}-${Math.round(hi / 1e9).toLocaleString('en-GB')} GB`
  const unit = (s) => s.split(' ')[1]
  return unit(a) === unit(b) ? `${a.split(' ')[0]}-${b}` : `${a}-${b}`
}
const hoursPast = (ms) => `${(ms / 3_600_000).toFixed(1)} h`

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
  // (with Off: rewrites left half done wait for Dry run or On to be put right, storage-jobs.mjs offRecord)
  if (r.mode === 'off') return { job, label, text: `Switched off: not run (checked ${when(r.at, now)})`, state: r.warnings?.length ? 'warn' : '', warnings: [...(r.warnings ?? [])] }
  const head = `Last run ${when(r.at, now)}${r.dryRun ? ' (dry run)' : ''}`
  // the job's own warnings go with it: for unreadable bookmarks they hold the reason
  if (r.error) return { job, label, text: `${head} failed: ${r.error}`, state: 'bad', warnings: [...(r.warnings ?? [])] }
  const thin = job === 'thinning'
  const files = (n) => `${count(n)} ${n === 1 ? 'file' : 'files'}`
  // thinning's dry run is worked out from the index since 2026-09-29 (no file is read): the size of the
  // time-lapse, and so what it frees, is an estimate, said with its range
  const est = thin && r.dryRun && r.estimate && Number.isFinite(r.fullBytes)
  let text = r.segments
    ? est
      ? `${head}: would convert ${files(r.segments)} (${bytes(r.fullBytes)} of full video), freeing about ${bytes(r.bytes)} (an estimate from the index: ${range(r.fullBytes - r.estimate.high, r.fullBytes - r.estimate.low)})`
      : `${head}: ${thin ? (r.dryRun ? 'would convert' : 'converted') : r.dryRun ? 'would delete' : 'deleted'} ${files(r.segments)}, ${r.dryRun ? 'freeing' : 'freed'} ${bytes(r.bytes)}`
    : thin && !r.dryRun && r.decision && !r.decision.work && r.after?.files
      ? `${head}: nothing converted: ${r.decision.why}`
      : `${head}: nothing to ${thin ? 'convert' : 'delete'} yet`
  if (est && Number.isFinite(r.backlog?.lagMs) && r.backlog.lagMs > 0) text += ` · the oldest ${hoursPast(r.backlog.lagMs)} past its full-video days`
  // with the switch On: what still waits, and why a round stopped before its minutes were up
  if (thin && !r.dryRun && r.after?.files) text += ` · ${r.segments ? 'still waiting' : 'waiting'}: ${files(r.after.files)}, ${bytes(r.after.bytes)}`
  const early = thin && !r.dryRun && r.stopped && !/^this round's/.test(r.stopped) ? r.stopped : null
  if (early) text += ` · stopped early: ${early}`
  if (r.reachedLimit) text += r.dryRun ? ' — the most one run looks at, so there is more' : ' — the most one run takes on; the rest follows in the next runs'
  if (r.skipped) text += ` · ${count(r.skipped)} skipped${r.skippedWhy?.length ? ` (${r.skippedWhy.map((s) => `${s.why} ${count(s.n)}`).join(', ')})` : ''}`
  const warnings = [...(r.warnings ?? [])]
  if (r.warningCount > warnings.length) warnings.push(`and ${count(r.warningCount - warnings.length)} more (the server log has them all)`)
  // Files in play and nobody asked which are bookmarked (storage-jobs.mjs `unprotected`); an empty
  // index also has nobody asked, and is no alarm.
  if (r.unprotected) warnings.unshift('Bookmarks could not be read: nothing was treated as bookmarked or exported.')
  return { job, label, text, state: r.unprotected ? 'bad' : warnings.length || early ? 'warn' : '', warnings }
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
  // housekeeping.mjs asks the bookmarks too since 2026-09-29; it deletes past the total days (and at low
  // space, and over a space limit) whatever this switch says
  // (a bookmark keeps the cameras it names since 2026-09-30, and a line crossing's own bookmark ends with its
  // camera's days kept: line-actions.mjs)
  const kept = 'Bookmarked and exported stretches are kept, by these two jobs and by the clean-up rules on this tab, which delete footage past the total days whatever this switch says. A bookmark keeps the cameras it names; the automatic ones around line crossings end with their camera\'s total days.'
  return `Switch time-lapse and retention ON?\n\n${what}\n\n${kept}${own}`
}

/**
 * The switch as the server has it, in words, and whether the choice clicked is still unsaved. An
 * admin once clicked Off, went to another tab without Save and came back to Off still checked (a
 * picked choice survives the minute's repaint on purpose) with the server On, and nothing on the
 * page said so (review 2026-09-29).
 * @param {string|null} mode   /api/storage jobs.mode (null: an older server, nothing is said)
 * @param {string|null} picked the choice clicked and not saved yet
 * @returns {{ now: string, unsaved: string }}
 */
export function switchNote(mode, picked) {
  const choice = THINNING_CHOICES.find((c) => c.value === mode)
  if (!choice) return { now: '', unsaved: '' }
  const short = choice.text.split(' — ')[0]
  return {
    now: `Now: ${choice.text}`,
    unsaved: picked && picked !== mode ? `Not saved yet: the switch is still ${short} until you press Save` : ''
  }
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
    const target = document.getElementById('sr-target')
    if (target) target.textContent = r.target

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
          { label: "Argus's recordings", value: l.limit.value, state: l.limit.state, note: l.limit.note },
          { label: 'Growth', value: l.growth, state: 'ok', note: '' },
          { label: 'Forecast', value: l.forecast.value, state: l.forecast.state, note: l.forecast.note },
          { label: 'Recycling', value: l.recycling, state: l.recyclingState, note: l.recyclingNote },
          { label: 'Days kept', value: l.kept.value, state: l.kept.state, note: l.kept.note },
          { label: 'Days that fit', value: l.fit.value, state: l.fit.state, note: l.fit.note }
        ]) {
          const node = el('div', { className: `card ${c.state}` })
          node.append(el('div', { className: 'lbl', textContent: c.label }), el('div', { className: 'big', textContent: c.value }), el('div', { className: 'note', textContent: c.note }))
          cards.append(node)
        }
        panel.append(cards)
        if (l.limitText) panel.append(el('p', { className: 'hp-note', textContent: l.limitText }))

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
  let unsavedSaid = '' // the "Not saved yet" words #sj-msg holds, so they are taken back, and nothing else is
  let runsSaid = '' // what #sj-runs shows: rebuilt only when that changes, not every minute

  /** "Now: On — ..." from the server, and "Not saved yet" while the choice clicked differs from it. */
  function noteSwitch() {
    const n = switchNote(jobs?.mode ?? null, picked)
    document.getElementById('sj-now').textContent = n.now
    const m = document.getElementById('sj-msg')
    if (n.unsaved) {
      if (m.textContent !== n.unsaved) {
        m.textContent = n.unsaved
        m.className = 'st-warn-text'
      }
    } else if (unsavedSaid && m.textContent === unsavedSaid) say('')
    unsavedSaid = n.unsaved
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
        input.addEventListener('change', () => {
          picked = input.value
          noteSwitch()
        })
        const label = el('label')
        label.append(input, c.text)
        box.append(label)
      }
    }
    // picked again, or the server moved to it: nothing is left unsaved
    if (picked === v.mode) picked = null
    const show = picked ?? v.mode
    for (const r of box.querySelectorAll('input')) r.checked = r.value === show
    form.querySelector('button[type="submit"]').disabled = v.mode === null
    noteSwitch()
    const said = JSON.stringify(v.lines)
    if (said === runsSaid) return
    runsSaid = said
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
