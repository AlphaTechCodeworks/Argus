// The switch in front of the two jobs that rewrite and delete footage on purpose (thinning.mjs
// runThinning and runRetention), what each job's last run did, and the log lines about it.
//
//   runStorageJobs({ mode, index, jobs: { thinning, retention }, args, limit })   every 5 minutes
//                                                                                (server.mjs)
//   lastRuns() -> { thinning, retention }   what the Storage page shows (storage-report.mjs)
//
// mode is settings.storage.thinning, set by an admin on Settings > Storage (settings.mjs checks
// it and the change is audited there). server.mjs passes a function that reads it, and it is read
// again before each job, so a switch to Off or Dry run during a long thinning run holds for the
// retention run straight after it:
//   'off'      neither job runs;
//   'dry-run'  both run and work out exactly what they would do, and touch nothing (the default);
//   'on'       they convert and delete as the recording settings say.
// Anything that is not exactly 'on' is a dry run: a typo must never be the thing that arms them.
//
// The last run of each is kept in memory only. It is what the page shows ("Last run 16:05 (dry
// run): would convert 1,240 files, freeing 310 GB") and it is gone after a restart, which is fine:
// the next run is at most 5 minutes away, and the journal keeps the lines below.
//
// The log. In dry run the jobs run every 5 minutes, and a line each time would be 288 a day saying
// the same thing; no line at all left it unclear whether they ran (the first dry run, on
// 2026-09-25, found nothing and said nothing). So a summary is written at most once an hour per job,
// even when it found nothing, so that silence is never ambiguous; at once when the switch or the
// error changes; and, when the switch is on, after every run that really changed footage, because
// each of those is a destruction somebody may later have to account for.
// This module does no file work itself and imports nothing, so it is testable on any laptop.

export const SUMMARY_EVERY_MS = 60 * 60_000
const JOBS = ['thinning', 'retention']
const MAX_WARNINGS = 5
const MAX_REASONS = 3

const runs = { thinning: null, retention: null }
const logged = { thinning: { key: null, at: -Infinity }, retention: { key: null, at: -Infinity } }

/** The last run of each job, as copies (the page's figures cannot be changed through them). */
export const lastRuns = () => structuredClone(runs)

const n = (x) => x.toLocaleString('en-GB')
const gb = (b) => `${(b / 1e9).toFixed(2)} GB`
const plural = (k, one, many) => `${n(k)} ${k === 1 ? one : many}`

/** One run as it is remembered. `result` is what runThinning / runRetention returned, or null. */
function record(job, mode, result, { at, tookMs = null, limit = null, error = null }) {
  const list = result ? (job === 'thinning' ? result.thinned : result.deleted) ?? [] : null
  const skipped = result?.skipped ?? null
  const why = new Map()
  for (const s of skipped ?? []) why.set(s.why, (why.get(s.why) ?? 0) + 1)
  const warnings = result?.warnings ?? []
  // 'unread': asking the bookmarks threw and the job stopped before any file. That is a run that
  // did not happen, not one that found "nothing to convert" (its own warning has the reason).
  if (!error && result?.protection === 'unread') error = 'the bookmarks could not be read, so it stopped before touching anything'
  return {
    job,
    mode,
    dryRun: mode !== 'on',
    at,
    tookMs,
    segments: list ? list.length : null,
    bytes: result ? Number(result.freedBytes) || 0 : null,
    skipped: skipped ? skipped.length : null,
    skippedWhy: [...why].sort((a, b) => b[1] - a[1]).slice(0, MAX_REASONS).map(([w, k]) => ({ why: w, n: k })),
    warnings: warnings.slice(0, MAX_WARNINGS).map(String),
    warningCount: warnings.length,
    limit,
    // The jobs stop at `limit` files a run. In dry run the same first files are counted again next
    // time, so a figure at the limit means "at least this much", never "this is all of it".
    reachedLimit: Boolean(list && Number.isFinite(limit) && list.length >= limit),
    protection: result?.protection ?? null,
    // The alarm: files were (or, in dry run, would have been) taken on with nobody asked which of
    // them are bookmarked. 'none' alone is not it: an empty index says 'none' too, having had
    // nothing to ask about, and was a red line and an hourly warning for nothing (review 2026-09-29).
    unprotected: result?.protection === 'none' && (list?.length > 0 || skipped?.length > 0),
    error
  }
}

/** The log line for one run: "[thinning] dry run, nothing touched: would convert 1,240 files, ..." */
export function summaryLine(r) {
  const tag = `[${r.job}]`
  if (r.mode === 'off') return `${tag} switched off (Settings > Storage): not run`
  const how = r.dryRun ? 'dry run, nothing touched' : 'on'
  if (r.error) return `${tag} ${how}: did not run: ${r.error}`
  const extra = [r.skipped ? `${n(r.skipped)} skipped` : '', r.warningCount ? `${plural(r.warningCount, 'warning', 'warnings')} (above)` : '', r.unprotected ? 'BOOKMARKS NOT CHECKED' : '']
    .filter(Boolean)
    .join(', ')
  const tail = extra ? `; ${extra}` : ''
  if (!r.segments) return `${tag} ${how}: nothing to ${r.job === 'thinning' ? 'convert' : 'delete'}${tail}`
  const verb = r.job === 'thinning' ? (r.dryRun ? 'would convert' : 'converted') : r.dryRun ? 'would delete' : 'deleted'
  const what = `${verb} ${plural(r.segments, 'file', 'files')}${r.job === 'thinning' && !r.dryRun ? ' to time-lapse' : ''}, ${r.dryRun ? 'freeing' : 'freed'} ${gb(r.bytes)}`
  const more = r.reachedLimit ? ' (the most one run takes on: there is more)' : ''
  // "[thinning] converted 12 files ..." rather than "[thinning] on: converted ...": what was done is the news
  return `${tag} ${r.dryRun ? `${how}: ` : ''}${what}${more}${tail}`
}

/** Keeps the run and writes its line if the rules at the top say so. */
function keep(r, { log, warn }) {
  runs[r.job] = r
  const last = logged[r.job]
  const key = `${r.mode}|${r.error ?? ''}`
  const changedFootage = r.mode === 'on' && r.segments > 0
  // A clock put back (a server that started a day ahead, then NTP) makes `since` negative: that is
  // due now, or there would be no line until the clock passed the old time again (review 2026-09-29).
  const since = r.at - last.at
  if (!changedFootage && key === last.key && since >= 0 && since < SUMMARY_EVERY_MS) return
  logged[r.job] = { key, at: r.at }
  ;(r.error || r.unprotected ? warn : log)(summaryLine(r))
}

/** The switch as it is right now: 'on' | 'off' | 'dry-run'. One that cannot be read is a dry run. */
function switchNow(mode) {
  let v
  try {
    v = typeof mode === 'function' ? mode() : mode
  } catch {
    v = null
  }
  return v === 'on' || v === 'off' ? v : 'dry-run'
}

/**
 * Resolves once the event loop has been round at least once and looked at its sockets: an admin's
 * save that arrived while a synchronous job held the loop is then in the settings. One setImmediate
 * is not that: from an I/O callback (the chain once housekeeping or thinning waits on a helper
 * process or the disk) it runs before the loop polls again, and a real POST sent during a 400 ms
 * block was still unread (review 2026-09-29, storage-jobs.test.mjs). A setImmediate queued from
 * inside another runs in the next turn, after that turn's poll, whichever phase this started in.
 */
const letTheLoopTurn = () => new Promise((r) => setImmediate(() => setImmediate(r)))

/**
 * Runs thinning, then retention, as the switch says, and remembers each.
 * @param {{ mode: string|(() => string), index: object|null, jobs: { thinning: Function, retention: Function },
 *           args: () => object, limit?: number|null, clock?: () => number,
 *           log?: (line: string) => void, warn?: (line: string) => void }} o
 *   mode:   the switch, or better a function that reads it: it is read again before each job
 *   args(): what both jobs are called with besides dryRun (index, settings, protectedRanges, present)
 *   limit:  the most files one run of a job takes on (thinning.mjs MAX_SEGMENTS_PER_RUN)
 */
export async function runStorageJobs({ mode, index, jobs, args, limit = null, clock = Date.now, log = console.log, warn = console.warn }) {
  const out = { log, warn }
  const m = switchNow(mode)
  if (m === 'off') {
    for (const job of JOBS) keep(record(job, 'off', null, { at: clock() }), out)
    return
  }
  if (!index) {
    for (const job of JOBS) keep(record(job, m, null, { at: clock(), error: 'the recordings index is not open' }), out)
    return
  }
  for (const job of JOBS) {
    // Read again before each job (review 2026-09-29): with the switch On a thinning run can take
    // minutes (up to 2000 files read, rewritten, fsynced and read back over SMB), and an admin who
    // set Off or Dry run meanwhile was told "Saved: Off" while retention went on to delete up to
    // 2000 files in the same round. runThinning's file work is synchronous, so the save (an HTTP
    // request) cannot even be handled until it is done: the event loop is let go round first, and a
    // save that was waiting on a connection already open is in the settings before the switch is
    // read. (A save on a brand-new connection needs more turns than that. While retention's file
    // work is synchronous too, such a save is not answered "Saved" until retention has finished; once
    // that work waits on a helper, saves are answered during it, and the job itself must then look
    // at the switch between files, not only here.)
    let sw = m
    if (job !== JOBS[0]) {
      await letTheLoopTurn()
      sw = switchNow(mode)
    }
    if (sw === 'off') {
      keep(record(job, 'off', null, { at: clock() }), out)
      continue
    }
    const dryRun = sw !== 'on'
    const t0 = clock()
    try {
      const result = await jobs[job]({ ...args(), dryRun })
      keep(record(job, sw, result, { at: clock(), tookMs: clock() - t0, limit }), out)
    } catch (e) {
      keep(record(job, sw, null, { at: clock(), tookMs: clock() - t0, limit, error: String(e?.message ?? e) }), out)
      // As before 2026-09-29: an unexpected failure stops this round, and retention waits for the
      // next one rather than deleting after a job that went wrong in a way nobody foresaw.
      for (const rest of JOBS.slice(JOBS.indexOf(job) + 1)) keep(record(rest, sw, null, { at: clock(), error: `${job} failed first, so this waits for the next round` }), out)
      return
    }
  }
}

/** Only for tests. */
export const _test = {
  reset() {
    for (const job of JOBS) {
      runs[job] = null
      logged[job] = { key: null, at: -Infinity }
    }
  }
}
