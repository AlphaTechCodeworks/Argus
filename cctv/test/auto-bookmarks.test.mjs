// Offline tests for automatic bookmarks (auto-bookmarks.mjs): which bookmarks are automatic (a line
// crossing's, line-actions.mjs autoBookmark) and which are a person's, and forgetting the automatic ones
// once they ended more than their camera's days kept, a bounded page of them a round whatever the cameras keep.
// Data-safety review of 19321dd (2026-09-30): an automatic bookmark an admin annotated on the deployed master
// (whose updateBookmark never changes `user`) was still "system" and would have been forgotten, its footage
// with it; and the forget step read every automatic bookmark older than the shortest days kept, every
// 5 minutes on the main thread (157-199 ms with 20,000 of them when one other camera keeps 1-7 days).
// Temp data folder only, the real bookmarks store; no NVR, no SDK, no settings file: runs on any PC.
//   node cctv/test/auto-bookmarks.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-auto-bookmarks-test-'))
writeFileSync(join(process.env.DATA_DIR, 'users.json'), JSON.stringify({ alice: { hash: 'x', role: 'admin' } }))

const bookmarks = await import('../bookmarks.mjs')
const {
  AUTO_DESCRIPTION, AUTO_DESCRIPTIONS, AUTO_TITLE_PREFIX, AUTO_USER, FORGET_BATCH, FORGET_READ, OLD_AUTO_DESCRIPTION,
  forgetAutoBookmarks, isAutoBookmark
} = await import('../auto-bookmarks.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const J = JSON.stringify

const S = 1000
const MIN = 60 * S
const DAY = 86_400_000
const NOW = Date.parse('2026-11-15T12:00:00Z')
const quiet = () => {}
/** The text every automatic bookmark got on the deployed master (f62d183 line-actions.mjs autoBookmark). */
const MASTER_TEXT = 'Kept automatically around line crossings on this camera; later crossings stretch it.'

// ---- which bookmarks are automatic ---------------------------------------------------------------
{
  const auto = (over = {}) => ({ id: 1, cameras: ['nvr-2/2'], startMs: 0, endMs: 1, title: 'Line crossing — Maingate Roadway', description: AUTO_DESCRIPTION, user: AUTO_USER, ...over })
  check('the texts: the one the deployed master gives them, and the new one', OLD_AUTO_DESCRIPTION === MASTER_TEXT && J(AUTO_DESCRIPTIONS) === J([AUTO_DESCRIPTION, MASTER_TEXT]) && AUTO_TITLE_PREFIX === 'Line crossing' && AUTO_USER === 'system')
  check('  and the new one still says how it ends and how to keep it', /forgotten after/.test(AUTO_DESCRIPTION) && /edit it to keep it/.test(AUTO_DESCRIPTION))
  check('an automatic bookmark: "system", one camera, titled as a line crossing, with the automatic text', isAutoBookmark(auto()) && isAutoBookmark(auto(), 'nvr-2/2'))
  check('  the master\'s text counts too (the ones made before this deploys)', isAutoBookmark(auto({ description: MASTER_TEXT })))
  check('A "SYSTEM" BOOKMARK WHOSE DESCRIPTION A PERSON CHANGED IS A PERSON\'S (edited on the master, which kept "system")',
    !isAutoBookmark(auto({ description: 'White van took the pallet' })) && !isAutoBookmark(auto({ description: `${MASTER_TEXT} Van took the pallet.` })) && !isAutoBookmark(auto({ description: '' })))
  check('  another camera than the one asked about is not', !isAutoBookmark(auto(), 'nvr-2/3'))
  check('  nor one of two cameras, one with no camera, or one whose cameras cannot be read',
    !isAutoBookmark(auto({ cameras: ['nvr-2/2', 'nvr-2/3'] })) && !isAutoBookmark(auto({ cameras: [] })) && !isAutoBookmark(auto({ damaged: true })))
  check('  nor a person\'s, however titled', !isAutoBookmark(auto({ user: 'alice' })))
  check('  nor one titled otherwise', !isAutoBookmark(auto({ title: 'Van at the gate' })))
  check('  nor nothing', !isAutoBookmark(null) && !isAutoBookmark(undefined) && !isAutoBookmark({}))
}

// ---- forgetting: the ones due go, a person's never ---------------------------------------------------
{
  const settings = { recording: { defaults: { retentionDays: 30 }, cameras: { 'nvr-3/5': { retentionDays: 60 } } } }
  const mk = (cam, startMs, { user = AUTO_USER, title = `Line crossing — ${cam}`, description = AUTO_DESCRIPTION } = {}) =>
    bookmarks.createBookmark({ cameras: [cam], startMs, endMs: startMs + 90 * S, title, description }, user, { now: startMs + MIN }).bookmark
  const fresh = mk('nvr-3/1', NOW - 45 * DAY)
  const masters = mk('nvr-3/1', NOW - 44 * DAY, { description: MASTER_TEXT })
  // made on the master, then annotated there by an admin: the master's updateBookmark left it "system"
  const annotated = mk('nvr-3/1', NOW - 43 * DAY, { description: 'White van took the pallet at 14:02' })
  const appended = mk('nvr-3/1', NOW - 43 * DAY + 10 * MIN, { description: `${MASTER_TEXT}\n\nChecked: nothing taken.` })
  const cleared = mk('nvr-3/1', NOW - 43 * DAY + 20 * MIN, { description: '' })
  const young = mk('nvr-3/1', NOW - 10 * DAY)
  const edge = mk('nvr-3/1', NOW - 30 * DAY + 60 * S) // ends 30 s inside the 30 days
  const longer = mk('nvr-3/5', NOW - 45 * DAY) // its camera keeps 60 days
  const hers = mk('nvr-3/1', NOW - 45 * DAY, { user: 'alice', title: 'Van at the gate', description: '' })
  const taken = mk('nvr-3/1', NOW - 42 * DAY)
  const took = bookmarks.updateBookmark(taken.id, { title: 'Line crossing — pallet taken' }, { user: 'alice' }, { now: NOW })
  check('(an admin edits one after this deploys: it is hers)', took.ok && took.bookmark.user === 'alice', J(took))
  const has = (b) => bookmarks.getBookmark(b.id) !== null
  const lines = []
  const cursor = {}
  const r = await forgetAutoBookmarks({ store: bookmarks, settings, now: NOW, log: (l) => lines.push(l), cursor })
  check('AN AUTOMATIC BOOKMARK THAT ENDED MORE THAN ITS CAMERA\'S DAYS AGO IS FORGOTTEN', !has(fresh) && r.forgotten === 2, J(r))
  check('  one made on the master (its text) too', !has(masters))
  check('A "SYSTEM" BOOKMARK AN ADMIN ANNOTATED ON THE MASTER IS NEVER FORGOTTEN (its footage stays)', has(annotated) && has(appended) && has(cleared))
  check('  one still inside its days is kept', has(edge) && has(young))
  check('  a camera\'s own days count (60 here)', has(longer))
  check('  a person\'s own is never forgotten, however old', has(hers))
  check('  nor one a person changed since this deploys (it is theirs)', has(taken) && bookmarks.getBookmark(taken.id).user === 'alice')
  check('  one line in the log, saying how many and why', lines.length === 1 && /forgot 2 automatic line-crossing bookmarks/.test(lines[0]) && /days kept/.test(lines[0]), J(lines))
  for (let i = 0; i < 3; i++) await forgetAutoBookmarks({ store: bookmarks, settings, now: NOW + i * 7 * DAY, log: (l) => lines.push(l), cursor })
  check('  and still never forgotten, round after round, weeks later', has(annotated) && has(appended) && has(cleared) && has(hers) && has(taken))
  const none = await forgetAutoBookmarks({ store: bookmarks, settings: { recording: { defaults: {}, cameras: {} } }, now: NOW + 400 * DAY, log: (l) => lines.push(l) })
  check('no days kept set anywhere: nothing forgotten', none.forgotten === 0 && has(young))
  check('no store (bookmarks not available): nothing, and no throw', (await forgetAutoBookmarks({ store: null, settings, now: NOW, log: quiet })).forgotten === 0)
  check('  nor a store without the page read', (await forgetAutoBookmarks({ store: { removeBookmarks: () => 99 }, settings, now: NOW, log: quiet })).forgotten === 0)
  check('the store may be handed over as a loader (line-actions.mjs loads bookmarks.mjs on first use)',
    (await forgetAutoBookmarks({ store: async () => bookmarks, settings, now: NOW + 30 * DAY, log: quiet, cursor: {} })).forgotten >= 1 && !has(young))
}

// ---- a bounded page a round, whatever the cameras keep ------------------------------------------------
// The review's case: 20,000 automatic bookmarks on a camera that keeps 183 days, and another camera keeping
// 1 day. Before: every round read and parsed all 20,000 (none due), 157-199 ms on the main thread each 5 min.
{
  const N = 20_000
  const CAM = 'nvr-2/2'
  const SPAN = 170 * DAY
  const raw = new DatabaseSync(bookmarks.BOOKMARKS_DB)
  const ins = raw.prepare('INSERT INTO bookmarks (cameras, start_ms, end_ms, title, description, user, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
  raw.exec('BEGIN')
  for (let i = 0; i < N; i++) {
    const s = NOW - SPAN + Math.floor((i * SPAN) / N)
    ins.run(J([CAM]), s, s + 90 * S, 'Line crossing — Maingate Roadway', AUTO_DESCRIPTION, AUTO_USER, s + MIN)
  }
  // a few people's bookmarks among them, which the page skips in SQL
  for (let i = 0; i < 200; i++) ins.run(J([CAM]), NOW - SPAN + i * 17 * 3600 * S, NOW - SPAN + i * 17 * 3600 * S + MIN, 'Van', '', 'alice', NOW)
  raw.exec('COMMIT')
  raw.close()
  const long = { recording: { defaults: { retentionDays: 183 }, cameras: { 'nvr1/5': { retentionDays: 1 } } } }
  const countAuto = () => bookmarks.listEndedBefore(AUTO_USER, NOW + DAY, { limit: 1e6 }).filter((b) => b.cameras[0] === CAM).length

  // one round, timed as the main thread sees it: forgetAutoBookmarks does its work before its first await
  const round = (settings, cursor, now = NOW) => {
    const t0 = performance.now()
    const p = forgetAutoBookmarks({ store: bookmarks, settings, now, log: quiet, cursor })
    return { ms: performance.now() - t0, p }
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

  const cursor = {}
  const times = []
  const reads = []
  let wrapped = 0
  let forgotten = 0
  const cycle = Math.ceil(N / FORGET_READ) + 1
  for (let i = 0; i < cycle + 2; i++) {
    const { ms, p } = round(long, cursor)
    const r = await p
    times.push(ms)
    reads.push(r.read)
    forgotten += r.forgotten
    if (cursor.after === null) wrapped++
  }
  check(`EACH ROUND READS AT MOST ${FORGET_READ} BOOKMARKS, not every one older than the shortest days kept`, reads.every((n) => n <= FORGET_READ) && reads[0] === FORGET_READ, reads.join(' '))
  check('  and none of them is forgotten (the camera keeps 183 days)', forgotten === 0 && countAuto() === N)
  check(`  THE MAIN THREAD'S WORK A ROUND IS UNDER 50 MS (before: 157-199 ms with 20,000 of them)`, median(times) < 50 && Math.max(...times) < 100, times.map((t) => t.toFixed(1)).join(' '))
  check(`  a full pass takes about ${cycle - 1} rounds, then starts again from the oldest`, wrapped >= 1 && reads.some((n) => n < FORGET_READ), reads.join(' '))

  // one due at the far end of the order (a 1-day camera's, ended 2 days ago) is still reached within a pass
  const far = bookmarks.createBookmark({ cameras: ['nvr1/5'], startMs: NOW - 2 * DAY, endMs: NOW - 2 * DAY + 90 * S, title: 'Line crossing — Yard', description: AUTO_DESCRIPTION }, AUTO_USER, { now: NOW - 2 * DAY + MIN }).bookmark
  {
    const c = {}
    let rounds = 0
    while (bookmarks.getBookmark(far.id) && rounds < cycle + 2) {
      rounds++
      await forgetAutoBookmarks({ store: bookmarks, settings: long, now: NOW, log: quiet, cursor: c })
    }
    check('ONE DUE BEHIND 20,000 THAT ARE NOT IS FORGOTTEN WITHIN ONE PASS', bookmarks.getBookmark(far.id) === null && rounds <= cycle, `${rounds} rounds`)
  }

  // days lowered part-way through a pass: the ones now due that lie behind the cursor go in the next pass
  {
    const c = {}
    for (let i = 0; i < 4; i++) await forgetAutoBookmarks({ store: bookmarks, settings: long, now: NOW, log: quiet, cursor: c })
    const passed = c.after
    const lower = { recording: { defaults: { retentionDays: 183 }, cameras: { 'nvr1/5': { retentionDays: 1 }, [CAM]: { retentionDays: 165 } } } }
    const dueNow = bookmarks.listEndedBefore(AUTO_USER, NOW - 165 * DAY, { limit: 1e6 }).filter((b) => b.cameras[0] === CAM).length
    let rounds = 0
    let most = 0
    while (bookmarks.listEndedBefore(AUTO_USER, NOW - 165 * DAY, { limit: 1 }).length && rounds < 2 * cycle) {
      rounds++
      const r = await forgetAutoBookmarks({ store: bookmarks, settings: lower, now: NOW, log: quiet, cursor: c })
      most = Math.max(most, r.read)
    }
    check('(the cursor had passed the ones that become due)', passed !== null && passed.endMs > NOW - 165 * DAY && dueNow > FORGET_BATCH, J({ passed, dueNow }))
    check('A CHANGE OF DAYS BEHIND THE CURSOR IS CAUGHT IN THE NEXT PASS: all of them forgotten', bookmarks.listEndedBefore(AUTO_USER, NOW - 165 * DAY, { limit: 1 }).length === 0 && rounds <= cycle + Math.ceil(dueNow / FORGET_BATCH), `${rounds} rounds for ${dueNow}`)
    check('  never more than a page read a round', most <= FORGET_READ, String(most))
    check('  and none of the rest', countAuto() === N - dueNow, `${countAuto()} of ${N - dueNow}`)
  }

  // every camera 30 days: most of them due at once, FORGET_BATCH a round, each round quick
  {
    const short = { recording: { defaults: { retentionDays: 30 }, cameras: {} } }
    const c = {}
    const before = countAuto()
    const got = []
    for (let i = 0; i < 3; i++) {
      const { ms, p } = round(short, c)
      const r = await p
      got.push({ ms, n: r.forgotten, read: r.read })
    }
    check(`EVERY CAMERA 30 DAYS: ${FORGET_BATCH} FORGOTTEN A ROUND, the next ones the round after`, got.every((g) => g.n === FORGET_BATCH && g.read === FORGET_BATCH) && countAuto() === before - 3 * FORGET_BATCH, J(got))
    check('  each round under 50 ms of main thread (the delete is one transaction)', median(got.map((g) => g.ms)) < 50, got.map((g) => g.ms.toFixed(1)).join(' '))
  }
  check('the people\'s bookmarks among them are all still there', bookmarks.listEndedBefore('alice', NOW + DAY, { limit: 1e6 }).filter((b) => b.title === 'Van').length === 200)
}

bookmarks.closeBookmarks()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
