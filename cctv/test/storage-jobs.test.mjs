// Offline tests for storage-jobs.mjs: the switch in front of the two jobs that rewrite and delete
// footage (thinning.mjs), what each job's last run is remembered as, and the log lines. The jobs
// themselves are fakes here; thinning.test.mjs covers what they do to files. No SDK, Windows-safe.
//   node cctv/test/storage-jobs.test.mjs
const { runStorageJobs, lastRuns, SUMMARY_EVERY_MS, _test } = await import('../storage-jobs.mjs')

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 2, 17, 0, 0)
const INDEX = { fake: 'index' }

/** A fake job that answers like runThinning / runRetention and remembers how it was called. */
function fakeJob(kind, answer = {}) {
  const calls = []
  const fn = async (o) => {
    calls.push(o)
    if (answer.throws) throw new Error(answer.throws)
    const list = answer.list ?? []
    return { dryRun: o.dryRun, [kind]: list, skipped: answer.skipped ?? [], warnings: answer.warnings ?? [], freedBytes: answer.freedBytes ?? 0, protection: answer.protection ?? 'ranges' }
  }
  fn.calls = calls
  return fn
}
const files = (n) => Array.from({ length: n }, (_, i) => ({ path: `/rec/f${i}` }))

/** One run with a captured log; `now` is fixed. */
async function run(mode, { thinning = fakeJob('thinned'), retention = fakeJob('deleted'), now = T0, index = INDEX, limit = 2000 } = {}) {
  const logs = []
  const warns = []
  await runStorageJobs({ mode, index, jobs: { thinning, retention }, args: () => ({ index, settings: { s: 1 } }), limit, clock: () => now, log: (l) => logs.push(l), warn: (l) => warns.push(l) })
  return { logs, warns, thinning, retention, runs: lastRuns() }
}

// ---- before anything has run --------------------------------------------------------------------
_test.reset()
check('nothing remembered before the first run', lastRuns().thinning === null && lastRuns().retention === null)

// ---- the switch decides what the jobs are allowed to do -----------------------------------------------
{
  _test.reset()
  const r = await run('dry-run')
  check('dry run: both jobs run, each told dryRun: true', r.thinning.calls.length === 1 && r.retention.calls.length === 1 && r.thinning.calls[0].dryRun === true && r.retention.calls[0].dryRun === true)
  check('dry run: the jobs get the caller\'s arguments', r.thinning.calls[0].index === INDEX && r.thinning.calls[0].settings?.s === 1)
}
{
  _test.reset()
  const r = await run('on')
  check('on: both jobs run with dryRun: false', r.thinning.calls[0].dryRun === false && r.retention.calls[0].dryRun === false)
}
for (const odd of [undefined, null, '', 'yes', 'ON', true]) {
  _test.reset()
  const r = await run(odd)
  check(`a switch value that is not exactly 'on' (${JSON.stringify(odd)}) is a dry run`, r.thinning.calls[0]?.dryRun === true && r.retention.calls[0]?.dryRun === true && r.runs.thinning.mode === 'dry-run')
}
{
  _test.reset()
  const r = await run('off')
  check('off: neither job is called', r.thinning.calls.length === 0 && r.retention.calls.length === 0)
  check('off: both are remembered as switched off, with when', r.runs.thinning.mode === 'off' && r.runs.retention.mode === 'off' && r.runs.thinning.at === T0 && r.runs.thinning.segments === null)
  check('off: said in the log, once for each job', r.logs.length === 2 && r.logs.every((l) => /off/.test(l)) && /^\[thinning\]/.test(r.logs[0]) && /^\[retention\]/.test(r.logs[1]), JSON.stringify(r.logs))
}
{
  _test.reset()
  const r = await run('on', { index: null })
  check('no recordings index: neither job is called', r.thinning.calls.length === 0 && r.retention.calls.length === 0)
  check('no recordings index: remembered as not run, with the reason', /index/.test(r.runs.thinning.error ?? '') && /index/.test(r.runs.retention.error ?? ''), JSON.stringify(r.runs.thinning))
}

// ---- what a run is remembered as ---------------------------------------------------------------------
{
  _test.reset()
  const thinning = fakeJob('thinned', {
    list: files(1240),
    freedBytes: 310e9,
    skipped: [{ path: 'a', why: 'bookmarked or exported' }, { path: 'b', why: 'bookmarked or exported' }, { path: 'c', why: '/srv/x is not mounted' }, { path: 'd', why: 'already thin' }, { path: 'e', why: 'already thin' }, { path: 'f', why: 'already thin' }, { path: 'g', why: 'no index rows' }],
    warnings: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']
  })
  const retention = fakeJob('deleted', { list: files(3), freedBytes: 1.2e9 })
  const r = await run('dry-run', { thinning, retention, now: T0 + 5 * MIN })
  const t = r.runs.thinning
  check('the thinning run: mode, when, files, bytes', t.mode === 'dry-run' && t.dryRun === true && t.at === T0 + 5 * MIN && t.segments === 1240 && t.bytes === 310e9, JSON.stringify(t))
  check('the thinning run: skipped counted, reasons grouped most first (top 3)', t.skipped === 7 && t.skippedWhy.length === 3 && t.skippedWhy[0].why === 'already thin' && t.skippedWhy[0].n === 3 && t.skippedWhy[1].why === 'bookmarked or exported' && t.skippedWhy[1].n === 2, JSON.stringify(t.skippedWhy))
  check('the thinning run: warnings kept (the first 5) with their count', t.warnings.length === 5 && t.warningCount === 7 && t.warnings[0] === 'w1')
  check('the thinning run: which protection it had, no error', t.protection === 'ranges' && t.error === null)
  check('the retention run is remembered separately', r.runs.retention.segments === 3 && r.runs.retention.bytes === 1.2e9 && r.runs.retention.job === 'retention')
  check('under the per-run limit: not marked as having hit it', t.reachedLimit === false && t.limit === 2000)
  check('a copy is handed out (changing it changes nothing here)', (() => {
    lastRuns().thinning.segments = 1
    return lastRuns().thinning.segments === 1240
  })())
  check('the dry-run log line says what it would do, in the owner\'s words', r.logs.some((l) => /^\[thinning\] dry run/.test(l) && /would convert 1,240 files/.test(l) && /310\.00 GB/.test(l) && /7 skipped/.test(l)), JSON.stringify(r.logs))
  check('the retention line too', r.logs.some((l) => /^\[retention\] dry run/.test(l) && /would delete 3 files/.test(l)), JSON.stringify(r.logs))
}
{
  _test.reset()
  const r = await run('dry-run', { thinning: fakeJob('thinned', { list: files(2000), freedBytes: 5e9 }) })
  check('a run that stopped at the per-run limit is marked so (there is more)', r.runs.thinning.reachedLimit === true && r.logs.some((l) => /most one run/.test(l)), JSON.stringify(r.logs))
}
{
  _test.reset()
  const r = await run('on', { thinning: fakeJob('thinned', { list: files(12), freedBytes: 3.1e9 }), retention: fakeJob('deleted', { list: files(5), freedBytes: 2e9 }) })
  check('on: the log says what it did, not what it would do', r.logs.some((l) => /^\[thinning\] converted 12 files/.test(l)) && r.logs.some((l) => /^\[retention\] deleted 5 files/.test(l)) && !r.logs.some((l) => /would/.test(l)), JSON.stringify(r.logs))
}

// ---- a job that throws ----------------------------------------------------------------------------------
{
  _test.reset()
  const r = await run('on', { thinning: fakeJob('thinned', { throws: 'database is locked' }) })
  check('thinning throws: remembered with the error', r.runs.thinning.error === 'database is locked' && r.runs.thinning.segments === null)
  check('thinning throws: retention is not run after it (as before)', r.retention.calls.length === 0 && /thinning failed first/.test(r.runs.retention.error ?? ''), JSON.stringify(r.runs.retention))
  check('thinning throws: a warning in the log', r.warns.some((l) => /^\[thinning\]/.test(l) && /database is locked/.test(l)), JSON.stringify(r.warns))
  const again = await run('on', { thinning: fakeJob('thinned', { throws: 'database is locked' }), now: T0 + 5 * MIN })
  check('the same error five minutes later is not logged again', again.warns.length === 0, JSON.stringify(again.warns))
  const other = await run('on', { thinning: fakeJob('thinned', { throws: 'disk I/O error' }), now: T0 + 10 * MIN })
  check('a different error is logged at once', other.warns.some((l) => /disk I\/O error/.test(l)))
}

// ---- silence is never ambiguous: a summary at most once an hour, even when nothing was found -------------
{
  _test.reset()
  const a = await run('dry-run', { now: T0 })
  check('first dry run with nothing to do: logged anyway', a.logs.length === 2 && /nothing to convert/.test(a.logs[0]) && /nothing to delete/.test(a.logs[1]), JSON.stringify(a.logs))
  const b = await run('dry-run', { now: T0 + 5 * MIN })
  check('five minutes later: not logged again', b.logs.length === 0, JSON.stringify(b.logs))
  const c = await run('dry-run', { thinning: fakeJob('thinned', { list: files(40), freedBytes: 1e9 }), now: T0 + 30 * MIN })
  check('in dry run even a run that found something waits for the hour', c.logs.length === 0, JSON.stringify(c.logs))
  check('...but it is remembered at once for the page', lastRuns().thinning.segments === 40 && lastRuns().thinning.at === T0 + 30 * MIN)
  const d = await run('dry-run', { now: T0 + SUMMARY_EVERY_MS })
  check('an hour after the last line: logged again, even with nothing found', d.logs.length === 2, JSON.stringify(d.logs))
  const e = await run('on', { now: T0 + SUMMARY_EVERY_MS + 5 * MIN })
  check('switching mode is logged at once, even inside the hour', e.logs.length === 2 && e.logs.every((l) => !/dry run/.test(l)), JSON.stringify(e.logs))
  const f = await run('on', { thinning: fakeJob('thinned', { list: files(3), freedBytes: 1e8 }), now: T0 + SUMMARY_EVERY_MS + 10 * MIN })
  check('on: a run that changed footage is logged every time', f.logs.length === 1 && /converted 3 files/.test(f.logs[0]), JSON.stringify(f.logs))
  const g = await run('on', { now: T0 + SUMMARY_EVERY_MS + 15 * MIN })
  check('on: a run that changed nothing waits for the hour', g.logs.length === 0, JSON.stringify(g.logs))
  const h = await run('off', { now: T0 + SUMMARY_EVERY_MS + 20 * MIN })
  const i = await run('off', { now: T0 + SUMMARY_EVERY_MS + 25 * MIN })
  check('off: said once, then once an hour', h.logs.length === 2 && i.logs.length === 0, JSON.stringify([h.logs, i.logs]))
}
{
  // A clock put back (a server that started a day or a year ahead and then got its time from NTP)
  // must not buy a day or a year of silence (review 2026-09-29).
  _test.reset()
  const a = await run('dry-run', { now: T0 })
  const b = await run('dry-run', { now: T0 - 86_400_000 })
  check('the clock put back a day: logged at once, not a day later', a.logs.length === 2 && b.logs.length === 2, JSON.stringify([a.logs, b.logs]))
  const c = await run('dry-run', { now: T0 - 86_400_000 + 5 * MIN })
  check('...and from the new time on, once an hour again', c.logs.length === 0, JSON.stringify(c.logs))
  const d = await run('dry-run', { now: T0 - 365 * 86_400_000 })
  check('put back a year: logged at once too', d.logs.length === 2, JSON.stringify(d.logs))
}

// ---- the bookmarks: an alarm only when footage could have been touched without them ----------------------
// thinning.mjs says protection 'none' when there was no protectedRanges to ask (files then go
// unprotected), but also when there was nothing to look at; 'unread' when asking threw and the job
// stopped before touching anything. Only the first, with files in play, is the alarm.
{
  _test.reset()
  const r = await run('dry-run', { thinning: fakeJob('thinned', { protection: 'none' }), retention: fakeJob('deleted', { protection: 'none' }) })
  check('no bookmarks asked but nothing to look at (an empty index): no alarm', r.warns.length === 0 && r.logs.length === 2 && !r.logs.some((l) => /BOOKMARKS/.test(l)) && r.runs.thinning.unprotected === false, JSON.stringify([r.logs, r.warns]))
}
{
  _test.reset()
  const r = await run('dry-run', { thinning: fakeJob('thinned', { protection: 'none', list: files(3), freedBytes: 1e9 }), retention: fakeJob('deleted', { protection: 'none', skipped: [{ path: 'a', why: '/srv/x is not mounted' }] }) })
  check('no bookmarks asked and files in play: the alarm, as a warning', r.warns.length === 2 && r.warns.every((l) => /BOOKMARKS NOT CHECKED/.test(l)) && r.runs.thinning.unprotected === true && r.runs.retention.unprotected === true, JSON.stringify([r.logs, r.warns]))
}
{
  _test.reset()
  const r = await run('on', {
    thinning: fakeJob('thinned', { protection: 'unread', warnings: ['bookmarks could not be read (bookmarks table locked): nothing thinned this run'] }),
    retention: fakeJob('deleted', { protection: 'unread', warnings: ['bookmarks could not be read (bookmarks table locked): nothing deleted this run'] })
  })
  const t = r.runs.thinning
  check('bookmarks unreadable: remembered as not run, saying why, not as "nothing to convert"', /bookmarks could not be read/.test(t.error ?? '') && /nothing was touched|before touching/.test(t.error ?? '') && t.unprotected === false, JSON.stringify(t))
  check('...with the job\'s own warning kept (it has the reason)', t.warnings.some((w) => /bookmarks table locked/.test(w)))
  check('...logged as a warning, without the false "not checked" alarm', r.warns.length === 2 && !r.warns.some((l) => /BOOKMARKS NOT CHECKED|nothing to convert|nothing to delete/.test(l)), JSON.stringify(r.warns))
  check('...and retention still ran (it asks the bookmarks itself)', r.retention.calls.length === 1)
}

// ---- the switch is read again before each job (review round 2, 2026-09-29) ----------------------------
// With the switch On a thinning run can take minutes (up to 2000 files read, rewritten, fsynced and
// read back over SMB). An admin who sets Off or Dry run meanwhile must not see "Saved: Off" and then
// retention delete up to 2000 files in the same round because the switch was read once at the start.
{
  _test.reset()
  let sw = 'on'
  const thinning = fakeJob('thinned')
  const flip = async (o) => {
    const r = await thinning(o)
    sw = 'dry-run' // set by an admin while thinning ran
    return r
  }
  const retention = fakeJob('deleted')
  await runStorageJobs({ mode: () => sw, index: INDEX, jobs: { thinning: flip, retention }, args: () => ({}), clock: () => T0, log: () => {}, warn: () => {} })
  check('switched On -> Dry run while thinning ran: thinning ran for real, retention as a dry run', thinning.calls[0]?.dryRun === false && retention.calls[0]?.dryRun === true, JSON.stringify([thinning.calls, retention.calls]))
  check('...each remembered with the mode it really ran in', lastRuns().thinning.mode === 'on' && lastRuns().retention.mode === 'dry-run' && lastRuns().retention.dryRun === true, JSON.stringify(lastRuns()))
}
{
  _test.reset()
  let sw = 'on'
  const retention = fakeJob('deleted')
  const flip = async (o) => {
    sw = 'off'
    return fakeJob('thinned')(o)
  }
  const logs = []
  await runStorageJobs({ mode: () => sw, index: INDEX, jobs: { thinning: flip, retention }, args: () => ({}), clock: () => T0, log: (l) => logs.push(l), warn: (l) => logs.push(l) })
  check('switched On -> Off while thinning ran: retention not called at all', retention.calls.length === 0)
  check('...and remembered and logged as switched off', lastRuns().retention.mode === 'off' && logs.some((l) => /^\[retention\] switched off/.test(l)), JSON.stringify(logs))
}
{
  // A save is an HTTP request: it can only be handled when the event loop is free, which is not
  // during runThinning's loop (synchronous file work). Between the jobs the loop is let go once, so a
  // save that arrived meanwhile is in the settings before retention reads the switch.
  _test.reset()
  let sw = 'on'
  const retention = fakeJob('deleted')
  const thinning = async (o) => {
    setImmediate(() => (sw = 'off')) // the admin's POST, waiting for the loop
    return fakeJob('thinned')(o)
  }
  await runStorageJobs({ mode: () => sw, index: INDEX, jobs: { thinning, retention }, args: () => ({}), clock: () => T0, log: () => {}, warn: () => {} })
  check('a save waiting on the event loop while thinning ran is read before retention', retention.calls.length === 0 && lastRuns().retention.mode === 'off', JSON.stringify(lastRuns().retention))
}
{
  _test.reset()
  const thinning = fakeJob('thinned')
  const retention = fakeJob('deleted')
  await runStorageJobs({ mode: () => { throw new Error('settings unreadable') }, index: INDEX, jobs: { thinning, retention }, args: () => ({}), clock: () => T0, log: () => {}, warn: () => {} })
  check('a switch that cannot be read is a dry run, never on', thinning.calls[0]?.dryRun === true && retention.calls[0]?.dryRun === true && lastRuns().thinning.mode === 'dry-run')
}
{
  _test.reset()
  let reads = 0
  const r = await run(() => (reads++, 'off'))
  check('a getter that says off: neither job is called', r.thinning.calls.length === 0 && r.retention.calls.length === 0 && reads >= 1)
}

// ---- server.mjs hands the jobs what makes the switch real (review round 2, 2026-09-29) ---------------------
// The jobs are fakes above and settings.test.mjs stops at the store: this is the one place that
// checks the wiring. Dropping protectedRanges would stop protecting bookmarks, dropping present
// would stop checking the location's marker, and reading the wrong key would leave the switch
// with nothing behind it; every other suite would still pass.
{
  const { readFileSync } = await import('node:fs')
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const body = server.match(/\nfunction thinAndRetain\(\) \{\n[\s\S]*?\n\}\n/)?.[0] ?? ''
  check('server.mjs has thinAndRetain calling runStorageJobs', /runStorageJobs\(\{/.test(body), body ? '' : 'no thinAndRetain found')
  check('...the switch read from settings.storage.thinning, each time it is asked', /\bmode: \(\) => getSettings\(\)\.storage\?\.thinning,/.test(body), body.match(/mode:[^\n]*/)?.[0])
  check('...the real jobs', /jobs: \{ thinning: runThinning, retention: runRetention \}/.test(body), body.match(/jobs:[^\n]*/)?.[0])
  const args = body.match(/args: \(\) => \(\{([^}]*)\}\)/)?.[1] ?? ''
  check('...the bookmarks asked (protectedRanges) and the location markers checked (present: markerMatches)', /\bprotectedRanges\b/.test(args) && /\bpresent: markerMatches\b/.test(args) && /\bsettings: getSettings\(\)/.test(args) && /\bindex\b/.test(args), args)
  check('...protectedRanges from bookmarks.mjs, markerMatches from storage.mjs, the jobs from thinning.mjs',
    /import \{[^}]*\bprotectedRanges\b[^}]*\} from '\.\/bookmarks\.mjs'/.test(server) && /import \{[^}]*\bmarkerMatches\b[^}]*\} from '\.\/storage\.mjs'/.test(server) && /import \{[^}]*\brunRetention, runThinning\b[^}]*\} from '\.\/thinning\.mjs'/.test(server))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
