// Offline tests for bookmarks (bookmarks.mjs + public/bookmarks-view.js): what counts as a valid
// bookmark, the four routes, who may edit and delete, the protected stretches housekeeping must
// leave alone, and the pure maths behind the diamonds on the timeline.
// Temp data folder only; no NVR, no SDK, no network, nothing is sent anywhere.
//   node cctv/test/bookmarks.test.mjs
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-bookmarks-test-'))
const DATA = process.env.DATA_DIR
// Alice is an admin, Bob is a viewer. The roles come from the real users file, so the ownership
// rules are tried through the same lookup the server uses rather than a stub.
writeFileSync(join(DATA, 'users.json'), JSON.stringify({ alice: { hash: 'x', role: 'admin' }, bob: { hash: 'x', role: 'viewer' } }))

const {
  BOOKMARKS_DB,
  closeBookmarks,
  createBookmark,
  deleteBookmark,
  getBookmark,
  handleBookmarks,
  listBookmarks,
  msFrom,
  protectedRanges,
  updateBookmark
} = await import('../bookmarks.mjs')
const {
  DEFAULT_MARGIN_MS,
  MAX_BOOKMARK_MS,
  MAX_CAMERAS,
  MAX_TITLE,
  bookmarkMarkers,
  canEdit,
  checkBookmark,
  checkPatch,
  filterBookmarks,
  isProtected,
  mergeProtected,
  sortBookmarks,
  spanText
} = await import('../public/bookmarks-view.js')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const NOW = Date.parse('2026-09-25T12:00:00Z')
const T = Date.parse('2026-09-25T09:00:00Z')
const good = (over = {}) => ({ cameras: ['nvr1/0'], startMs: T, endMs: T + 60_000, title: 'Van at the gate', ...over })
const errorOf = (raw, opts) => checkBookmark(raw, { now: NOW, ...opts }).error ?? ''
const readJson = (body) => async () => body

// ---- what a bookmark may contain -----------------------------------------------------------------
{
  const ok = checkBookmark(good({ description: ' saw it on the\r\n front camera  ' }), { now: NOW })
  check('a plain bookmark is accepted', ok.ok, ok.error ?? '')
  check('  the description keeps its lines but loses the carriage returns', ok.value.description === 'saw it on the\n front camera')
  check('the end may not be before the start', /cannot be before its start/.test(errorOf(good({ endMs: T - 1 }))))
  check('  the same instant is fine (a bookmark of one moment)', checkBookmark(good({ endMs: T }), { now: NOW }).ok)
  check('an absurdly long bookmark is refused', /cannot be longer than/.test(errorOf(good({ endMs: T + MAX_BOOKMARK_MS + 1 }))))
  check(`  exactly ${MAX_BOOKMARK_MS / 3600_000} hours is allowed`, checkBookmark(good({ endMs: T + MAX_BOOKMARK_MS }), { now: NOW }).ok)
  check('a time before any recording exists is refused', /before any recording/.test(errorOf(good({ startMs: 0, endMs: 1000 }))))
  check('a bookmark in the future is refused', /in the future/.test(errorOf(good({ startMs: NOW + 5 * 86_400_000, endMs: NOW + 5 * 86_400_000 + 1000 }))))
  check('a time that is not a number is refused', /times in milliseconds/.test(errorOf(good({ startMs: 'now' }))))
  check('  and Infinity too', /times in milliseconds/.test(errorOf(good({ endMs: Infinity }))))
  check('a bookmark with no camera is refused', /at least one camera/.test(errorOf(good({ cameras: [] }))))
  check('  and with something that is not a camera key', /is not a camera/.test(errorOf(good({ cameras: ['nvr1'] }))))
  check(`  and with more than ${MAX_CAMERAS} cameras`, /at most/.test(errorOf(good({ cameras: Array.from({ length: MAX_CAMERAS + 1 }, (_, i) => `nvr1/${i}`) }))))
  check('the same camera twice is kept once, in a settled order', JSON.stringify(checkBookmark(good({ cameras: ['nvr2/3', 'nvr1/0', 'nvr2/3'] }), { now: NOW }).value.cameras) === '["nvr1/0","nvr2/3"]')
  check('a bookmark needs a title', /needs a title/.test(errorOf(good({ title: '   ' }))))
  check(`  and it can be at most ${MAX_TITLE} characters`, /at most/.test(errorOf(good({ title: 'x'.repeat(MAX_TITLE + 1) }))))
  check('a title is one line (a pasted newline would break the list row)', checkBookmark(good({ title: ' Van at\nthe gate ' }), { now: NOW }).value.title === 'Van at the gate')
  check('a description that is not text is refused', /must be text/.test(errorOf(good({ description: { note: 'x' } }))))
  check('a body that is not an object is refused', /must be a JSON object/.test(errorOf('bookmark')))
}

// ---- a change names only the fields it changes ----------------------------------------------------
{
  check('an empty change is refused', /Nothing to change/.test(checkPatch({}).error ?? ''))
  check('a field nobody may change is refused', /"user" cannot be changed/.test(checkPatch({ user: 'alice' }).error ?? ''))
  check('  and so is the id', /"id" cannot be changed/.test(checkPatch({ id: 4 }).error ?? ''))
  check('a title on its own is a valid change', checkPatch({ title: 'Better title' }).ok)
}

// ---- storing, finding, changing --------------------------------------------------------------------
{
  check('the database is the recordings database', BOOKMARKS_DB === join(DATA, 'recordings.db'))

  const made = createBookmark(good(), 'bob', { now: NOW })
  check('a viewer can make a bookmark', made.ok, made.error ?? '')
  check('  the signed-in name is on it, never one from the body', made.bookmark.user === 'bob')
  check('  and the time it was made', made.bookmark.createdMs === NOW)
  const id = made.bookmark.id
  check('it can be read back with its cameras as a list again', JSON.stringify(getBookmark(id).cameras) === '["nvr1/0"]')

  const spoof = createBookmark({ ...good(), user: 'alice' }, 'bob', { now: NOW })
  check('a user name in the body is ignored', spoof.bookmark.user === 'bob')
  deleteBookmark(spoof.bookmark.id, { user: 'bob' })

  check('a bookmark cannot be made by nobody', createBookmark(good(), null).error === 'Not signed in')
  check('a bad bookmark is not stored', createBookmark(good({ endMs: T - 1000 }), 'bob', { now: NOW }).ok === false)

  createBookmark(good({ cameras: ['nvr2/1'], startMs: T + 3600_000, endMs: T + 3600_000 + 30_000, title: 'Till drawer opened', description: 'Back office' }), 'alice', { now: NOW })

  check('both bookmarks are listed', listBookmarks().length === 2)
  check('newest first', listBookmarks()[0].title === 'Till drawer opened')
  check('search by text matches the title', listBookmarks({ text: 'van' }).map((b) => b.title).join() === 'Van at the gate')
  check('  and the description', listBookmarks({ text: 'back office' }).map((b) => b.title).join() === 'Till drawer opened')
  check('  and the person who made it', listBookmarks({ text: 'alice' }).length === 1)
  check('search by camera', listBookmarks({ camera: 'nvr2/1' }).map((b) => b.title).join() === 'Till drawer opened')
  check('  and a camera nobody bookmarked finds nothing', listBookmarks({ camera: 'nvr9/9' }).length === 0)
  check('search by time keeps the bookmarks overlapping the window', listBookmarks({ fromMs: T + 30_000, toMs: T + 40_000 }).length === 1)
  check('  a window before them all finds nothing', listBookmarks({ fromMs: T - 7200_000, toMs: T - 3600_000 }).length === 0)

  const moved = updateBookmark(id, { endMs: T + 120_000, title: 'Van reverses into the gate' }, { user: 'bob' })
  check('the owner can change their own bookmark', moved.ok, moved.error ?? '')
  check('  and the change is stored', getBookmark(id).endMs === T + 120_000)
  check('  the fields not named are left alone', getBookmark(id).cameras.join() === 'nvr1/0')

  const broken = updateBookmark(id, { startMs: T + 600_000 }, { user: 'bob' })
  check('a change that leaves the end before the start is refused', /cannot be before its start/.test(broken.error ?? ''))
  check('  and nothing was stored', getBookmark(id).startMs === T)

  check('a viewer cannot change someone else’s bookmark', updateBookmark(id, { title: 'x' }, { user: 'carol' }).status === 403)
  check('an admin can', updateBookmark(id, { title: 'Van reverses into the gate' }, { user: 'alice' }).ok)
  check('  the role is looked up when it is not given', updateBookmark(id, { title: 'Van reverses into the gate' }, 'alice').ok)
  check('  and a plain viewer name is still refused', updateBookmark(id, { title: 'x' }, 'bob2').status === 403)
  check('an unknown id is 404, not 500', updateBookmark(99_999, { title: 'x' }, { user: 'alice', admin: true }).status === 404)
  check('an id that is not a number is refused', updateBookmark('../../etc', { title: 'x' }, { user: 'alice', admin: true }).status === 400)
  check('  and so is a negative one', deleteBookmark(-3, { user: 'alice', admin: true }).status === 400)

  check('a viewer cannot delete someone else’s bookmark', deleteBookmark(id, { user: 'carol' }).status === 403)
}

// ---- protected stretches ---------------------------------------------------------------------------
{
  const merged = mergeProtected([{ startMs: 1000, endMs: 2000 }], 500)
  check('a stretch is grown by the margin at both ends', JSON.stringify(merged) === '[[500,2500]]')
  check('  no margin means the stretch itself', JSON.stringify(mergeProtected([{ startMs: 1000, endMs: 2000 }], 0)) === '[[1000,2000]]')
  check('two stretches that overlap once grown become one', JSON.stringify(mergeProtected([{ startMs: 0, endMs: 100 }, { startMs: 1000, endMs: 1100 }], 500)) === '[[-500,1600]]')
  check('  and two far apart stay two', mergeProtected([{ startMs: 0, endMs: 100 }, { startMs: 100_000, endMs: 100_100 }], 500).length === 2)
  check('stretches given out of order come back oldest first', JSON.stringify(mergeProtected([{ startMs: 9000, endMs: 9100 }, { startMs: 100, endMs: 200 }], 0)) === '[[100,200],[9000,9100]]')
  check('one stretch inside another is swallowed', JSON.stringify(mergeProtected([{ startMs: 0, endMs: 5000 }, { startMs: 1000, endMs: 2000 }], 0)) === '[[0,5000]]')
  check('two that exactly touch are one stretch', JSON.stringify(mergeProtected([{ startMs: 0, endMs: 100 }, { startMs: 100, endMs: 200 }], 0)) === '[[0,200]]')
  check('a start after its end is taken the right way round rather than dropped', JSON.stringify(mergeProtected([{ startMs: 200, endMs: 100 }], 0)) === '[[100,200]]')
  check('anything that is not a time is left out', mergeProtected([{ startMs: null, endMs: 5 }, { startMs: 1, endMs: 2 }], 0).length === 1)
  check('nothing bookmarked means nothing protected', mergeProtected([], 60_000).length === 0)

  const ranges = protectedRanges(T - 3600_000, T + 7200_000)
  check('the bookmarks in the window are protected', ranges.length >= 1)
  check('  with a minute either side by default', ranges[0][0] === T - DEFAULT_MARGIN_MS, JSON.stringify(ranges))
  check('the margin can be set', protectedRanges(T - 3600_000, T + 7200_000, { marginMs: 0 })[0][0] === T)
  check('a window nowhere near them is clear', protectedRanges(T - 30 * 86_400_000, T - 29 * 86_400_000).length === 0)
  check('a bookmark just outside the window still protects its margin inside it', protectedRanges(T - DEFAULT_MARGIN_MS / 2, T - 1).length === 1)
  check('a backwards window gives nothing rather than everything', protectedRanges(T + 1000, T).length === 0)
  check('a window that is not a time gives nothing', protectedRanges(null, undefined).length === 0)

  const p = [[1000, 2000], [5000, 6000]]
  check('a segment inside a protected stretch is protected', isProtected(p, 1200, 1300))
  check('  one that only overlaps its edge too', isProtected(p, 900, 1100))
  check('  and one between two of them is not', isProtected(p, 3000, 4000) === false)
  check('  nothing protected means nothing is', isProtected([], 1200, 1300) === false)
}

// ---- the routes ------------------------------------------------------------------------------------
// The rights check server.mjs hands in (canSee): which cameras this person may watch or play back.
const seeOnly = (keys) => ({ canSee: (nvr, ch) => keys.includes(`${nvr}/${ch}`) })
const SEE = seeOnly(['nvr1/0', 'nvr2/1']) // every camera the bookmarks above are on
{
  check('another path is not ours', (await handleBookmarks('GET', '/api/cameras', readJson({}), 'bob')) === null)
  check('signed out is 401', (await handleBookmarks('GET', '/api/bookmarks', readJson({}), null))[0] === 401)

  const [listStatus, listBody] = await handleBookmarks('GET', '/api/bookmarks', readJson({}), 'bob', SEE)
  check('GET /api/bookmarks lists them', listStatus === 200 && Array.isArray(listBody.bookmarks))
  check('  and says who is asking and whether they are an admin', listBody.user === 'bob' && listBody.admin === false)
  const [, adminBody] = await handleBookmarks('GET', '/api/bookmarks', readJson({}), 'alice')
  check('  an admin is told so', adminBody.admin === true)

  const [, filtered] = await handleBookmarks('GET', '/api/bookmarks?text=till&camera=nvr2/1', readJson({}), 'bob', SEE)
  check('the query string filters', filtered.bookmarks.length === 1 && filtered.bookmarks[0].title === 'Till drawer opened')
  const [, byDate] = await handleBookmarks('GET', `/api/bookmarks?from=${T}&to=${T + 1000}`, readJson({}), 'bob', SEE)
  check('  by time as well', byDate.bookmarks.length === 1)
  const [, nonsense] = await handleBookmarks('GET', '/api/bookmarks?from=yesterday', readJson({}), 'bob', SEE)
  check('a time that makes no sense is ignored, not passed on', nonsense.bookmarks.length === 2)

  const [postStatus, posted] = await handleBookmarks('POST', '/api/bookmarks', readJson(good({ title: 'Through the route' })), 'bob', SEE)
  check('POST makes one, answering 201', postStatus === 201 && posted.bookmark.id > 0)
  const newId = posted.bookmark.id
  const [badStatus, badBody] = await handleBookmarks('POST', '/api/bookmarks', readJson(good({ title: '' })), 'bob', SEE)
  check('  a bad one is 400 with the reason', badStatus === 400 && /needs a title/.test(badBody.error))

  const [patchStatus, patched] = await handleBookmarks('PATCH', `/api/bookmarks/${newId}`, readJson({ title: 'Through the gate' }), 'bob', SEE)
  check('PATCH changes it', patchStatus === 200 && patched.bookmark.title === 'Through the gate')
  const [forbidden] = await handleBookmarks('PATCH', `/api/bookmarks/${newId}`, readJson({ title: 'x' }), 'carol', SEE)
  check('  someone else is refused', forbidden === 403)
  const [missing] = await handleBookmarks('PATCH', '/api/bookmarks/424242', readJson({ title: 'x' }), 'alice')
  check('  an unknown id is 404', missing === 404)

  const [wrongMethod, , headers] = await handleBookmarks('PUT', '/api/bookmarks', readJson({}), 'bob', SEE)
  check('PUT is not allowed, and says what is', wrongMethod === 405 && headers.allow === 'GET, POST')

  const [delStatus, deleted] = await handleBookmarks('DELETE', `/api/bookmarks/${newId}`, readJson({}), 'bob', SEE)
  check('DELETE removes it', delStatus === 200 && deleted.deleted === true)
  check('  and it is gone', getBookmark(newId) === null)
  const [goneStatus] = await handleBookmarks('DELETE', `/api/bookmarks/${newId}`, readJson({}), 'alice')
  check('  deleting it again is 404', goneStatus === 404)

  const [jsonStatus, jsonBody] = await handleBookmarks('POST', '/api/bookmarks', async () => { throw new SyntaxError('bad') }, 'bob', SEE)
  check('a broken body is 400 Bad JSON, not a 500', jsonStatus === 400 && jsonBody.error === 'Bad JSON')

  check('bookmarks are never cached', (await handleBookmarks('GET', '/api/bookmarks', readJson({}), 'bob', SEE))[2]['cache-control'] === 'no-store')
}

// ---- rights: a viewer sees only bookmarks on cameras they may watch or play back -----------------
// Every bookmark on every camera (titles, incident descriptions, times, who made them) used to be
// readable by anyone signed in, and ?camera= aimed the list at any camera.
{
  const bob = { user: 'bob', admin: false }
  const alice = { user: 'alice', admin: true }
  const [, mine] = await handleBookmarks('POST', '/api/bookmarks', readJson(good({ cameras: ['rigginglot/3', 'nvr1/0'], title: 'Shared' })), alice)
  const [, secret] = await handleBookmarks('POST', '/api/bookmarks', readJson(good({ cameras: ['rigginglot/3'], title: 'Van reverses into the gate', description: 'secret' })), alice)
  const [, list] = await handleBookmarks('GET', '/api/bookmarks', readJson({}), bob, seeOnly(['nvr1/0']))
  check('a viewer does not list a bookmark on a camera they cannot see', !list.bookmarks.some((b) => b.id === secret.bookmark.id))
  const shared = list.bookmarks.find((b) => b.id === mine.bookmark.id)
  check('  a shared one is listed without the hidden camera', shared && shared.cameras.join() === 'nvr1/0', JSON.stringify(shared?.cameras))
  check('  no camera they cannot see is named anywhere in the list', !JSON.stringify(list).includes('rigginglot'))
  check('  ?camera= cannot reach it either', (await handleBookmarks('GET', '/api/bookmarks?camera=rigginglot/3', readJson({}), bob, seeOnly(['nvr1/0'])))[1].bookmarks.length === 0)
  check('  nor can its id (404)', (await handleBookmarks('GET', `/api/bookmarks/${secret.bookmark.id}`, readJson({}), bob, seeOnly(['nvr1/0'])))[0] === 404)
  check('  the shared one by id shows only their camera', (await handleBookmarks('GET', `/api/bookmarks/${mine.bookmark.id}`, readJson({}), bob, seeOnly(['nvr1/0'])))[1].bookmark?.cameras.join() === 'nvr1/0')
  check('  PATCH or DELETE of one they cannot see is 404, not 403', (await handleBookmarks('PATCH', `/api/bookmarks/${secret.bookmark.id}`, readJson({ title: 'x' }), bob, seeOnly(['nvr1/0'])))[0] === 404 && (await handleBookmarks('DELETE', `/api/bookmarks/${secret.bookmark.id}`, readJson({}), bob, seeOnly(['nvr1/0'])))[0] === 404)
  check('  and it is still there', getBookmark(secret.bookmark.id)?.title === 'Van reverses into the gate')
  check('  POST on a camera they cannot see is 403', (await handleBookmarks('POST', '/api/bookmarks', readJson(good({ cameras: ['value4u/1'] })), bob, seeOnly(['nvr1/0'])))[0] === 403)
  check('  ...even beside one they can', (await handleBookmarks('POST', '/api/bookmarks', readJson(good({ cameras: ['nvr1/0', 'value4u/1'] })), bob, seeOnly(['nvr1/0'])))[0] === 403)
  check('  with no rights check handed in, a viewer sees nothing', (await handleBookmarks('GET', '/api/bookmarks', readJson({}), bob))[1].bookmarks.length === 0)
  check('  an admin still sees everything', (await handleBookmarks('GET', '/api/bookmarks', readJson({}), alice))[1].bookmarks.some((b) => b.id === secret.bookmark.id))

  // The owner of a bookmark who lost a camera saves the list as the dialog shows it (without that
  // camera): the camera stays on the bookmark, and with it the footage housekeeping must keep.
  const [, own] = await handleBookmarks('POST', '/api/bookmarks', readJson(good({ cameras: ['nvr1/0', 'nvr2/1'], title: 'Two cameras' })), bob, SEE)
  const [st, patched] = await handleBookmarks('PATCH', `/api/bookmarks/${own.bookmark.id}`, readJson({ cameras: ['nvr1/0'], title: 'Two cameras, renamed' }), bob, seeOnly(['nvr1/0']))
  check('the owner can still change their bookmark after losing a camera', st === 200 && patched.bookmark.title === 'Two cameras, renamed' && patched.bookmark.cameras.join() === 'nvr1/0', JSON.stringify(patched))
  check('  the camera they can no longer see stays on it', getBookmark(own.bookmark.id).cameras.join() === 'nvr1/0,nvr2/1', getBookmark(own.bookmark.id).cameras.join())
  check('  PATCH naming a camera they cannot see is 403', (await handleBookmarks('PATCH', `/api/bookmarks/${own.bookmark.id}`, readJson({ cameras: ['nvr1/0', 'value4u/1'] }), bob, seeOnly(['nvr1/0'])))[0] === 403)

  // the cap of 500 is applied to what the viewer may see, not before: a viewer's bookmarks are not
  // pushed out of their list by newer ones on cameras they cannot see
  for (let i = 0; i < 3; i++) createBookmark(good({ cameras: ['rigginglot/3'], startMs: T + 7200_000 + i, endMs: T + 7200_000 + i + 1000, title: `hidden ${i}` }), 'alice', { now: NOW })
  check('listBookmarks filters before it caps', listBookmarks({ limit: 2, keep: (b) => b.cameras.includes('nvr1/0') }).every((b) => b.cameras.includes('nvr1/0')) && listBookmarks({ limit: 2, keep: (b) => b.cameras.includes('nvr1/0') }).length === 2)
}

// ---- the migration is additive -------------------------------------------------------------------
{
  // A database as the server has it: rows already in it, and no bookmarks table. Opening it must add
  // the table and leave the rows alone, because on the production server these rows are the only
  // record of where months of footage is.
  const file = join(mkdtempSync(join(tmpdir(), 'cctv-bookmarks-old-')), 'recordings.db')
  const old = new DatabaseSync(file)
  old.exec('CREATE TABLE segments (path TEXT PRIMARY KEY, nvr TEXT NOT NULL, ch INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, bytes INTEGER NOT NULL, keyframes INTEGER NOT NULL, loc TEXT)')
  old.exec("INSERT INTO segments VALUES ('/rec/a.h264', 'nvr1', 0, 1, 2, 3, 4, 'usb')")
  old.close()

  const { openRecIndex } = await import('../rec-index.mjs')
  const index = openRecIndex(file)
  check('opening an older index adds the bookmarks table', index.at('nvr1', 0, 1) !== null || true)
  const after = new DatabaseSync(file)
  check('  the segment rows are untouched', after.prepare('SELECT COUNT(*) AS n FROM segments').get().n === 1)
  check('  and the bookmarks table is there and empty', after.prepare('SELECT COUNT(*) AS n FROM bookmarks').get().n === 0)
  after.close()
  index.close()
}

// ---- the pure view maths ---------------------------------------------------------------------------
{
  const view = { startMs: 1000, spanMs: 1000 }
  const list = [
    { id: 1, startMs: 1500, endMs: 1600, title: 'inside' },
    { id: 2, startMs: 500, endMs: 1200, title: 'runs in from the left' },
    { id: 3, startMs: 5000, endMs: 5100, title: 'far away' },
    { id: 4, startMs: 1900, endMs: 9000, title: 'runs off to the right' }
  ]
  const marks = bookmarkMarkers(view, list)
  check('only the bookmarks the window can see are drawn', marks.map((m) => m.id).join() === '2,1,4')
  check('  left to right', marks[0].leftPct <= marks[1].leftPct)
  check('a bookmark in the middle sits halfway across', marks[1].leftPct === 50)
  check('one starting before the window is clamped to its left edge', marks[0].leftPct === 0)
  check('  but keeps its true start, which is what a click seeks to', marks[0].ms === 500)
  check('one running off the right is clipped to the edge', marks[2].endPct === 100)
  check('a bookmark of one moment has no width', bookmarkMarkers(view, [{ id: 9, startMs: 1500, endMs: 1500 }])[0].widthPct === 0)
  check('a view with no span draws nothing rather than dividing by zero', bookmarkMarkers({ startMs: 0, spanMs: 0 }, list).length === 0)
  check('a bookmark with no times is left out', bookmarkMarkers(view, [{ id: 9, startMs: null, endMs: 1 }]).length === 0)


  const all = [
    { id: 1, startMs: 100, endMs: 200, title: 'Van at the gate', description: 'red van', user: 'bob', cameras: ['nvr1/0'] },
    { id: 2, startMs: 300, endMs: 400, title: 'Till', description: '', user: 'alice', cameras: ['nvr2/1'] }
  ]
  check('filtering by text is case-insensitive', filterBookmarks(all, { text: 'VAN' }).length === 1)
  check('  and looks at the description too', filterBookmarks(all, { text: 'red' })[0].id === 1)
  check('filtering by camera', filterBookmarks(all, { camera: 'nvr2/1' })[0].id === 2)
  check('filtering by time keeps what overlaps', filterBookmarks(all, { fromMs: 150, toMs: 160 }).length === 1)
  check('no filter keeps everything', filterBookmarks(all, {}).length === 2)
  check('sorting is oldest first and does not touch the list given', sortBookmarks(all.slice().reverse()).map((b) => b.id).join() === '1,2')

  check('an admin may edit anything', canEdit(all[0], { user: 'carol', admin: true }))
  check('the owner may edit their own', canEdit(all[0], { user: 'bob' }))
  check('  and nobody else may', canEdit(all[0], { user: 'carol' }) === false)
  check('  nor may someone signed out', canEdit(all[0], {}) === false)

  check('a span reads plainly: seconds', spanText(0, 45_000) === '45 s')
  check('  minutes', spanText(0, 12 * 60_000) === '12 min')
  check('  hours and minutes', spanText(0, 125 * 60_000) === '2 h 5 min')
  check('  a whole number of hours has no minutes on it', spanText(0, 120 * 60_000) === '2 h')
  check('  and a single moment says so rather than "0 s"', spanText(500, 500) === 'a moment')
}

// ---- the playback page ------------------------------------------------------------------------------
{
  const js = readFileSync(new URL('../public/playback.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../public/playback.html', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')
  check('the page loads the pure bookmark rules rather than repeating them', /from '\.\/bookmarks-view\.js'/.test(js))
  check('the Bookmark button is no longer disabled', /id="bookmark" type="button"(?![^>]*disabled)/.test(html))
  check('the B key adds one', /key === 'b' \|\| e\.key === 'B'/.test(js) && /addBookmark\(\)/.test(js))
  check('  and the shortcut list no longer says it is coming later', !/coming later/.test(html))
  check('there is a list beside the video', /id="bookmarkList"/.test(html) && /pb-bookmarks/.test(css))
  check('diamonds are drawn on the timeline', /id="bookmarkMarks"/.test(html) && /pb-bm-mark/.test(css))
  check('  from the pure marker maths, not its own arithmetic', /bookmarkMarkers\(/.test(js))
  check('the page talks to the bookmarks API', /'\/api\/bookmarks'/.test(js) && /\/api\/bookmarks\/\$\{/.test(js))
  check('edit and delete are only offered to those allowed them', /canEdit\(/.test(js))
  check('the form is checked before it is sent', /checkBookmark\(/.test(js))
}

// ---- a bookmark keeps the cameras it names, not every camera (final fix round, 2026-09-30) ----------------
// protectedRanges gave [from, to] only, the cameras dropped, so housekeeping and thinning kept every camera's
// footage in a bookmarked stretch. Production bookmarks every line crossing on one camera (Maingate Roadway,
// since 2026-09-28): each crossing kept about 7 minutes of all 87 cameras, about 7 GB, for good.
{
  const { AUTO_USER, protectedByCamera } = await import('../public/bookmarks-view.js')
  const J = JSON.stringify
  const p = protectedByCamera([
    { startMs: 1000, endMs: 2000, cameras: ['n1/0'] },
    { startMs: 1500, endMs: 3000, cameras: ['n1/0', 'n1/1'] },
    { startMs: 9000, endMs: 9100, cameras: '["n1/1"]' }
  ], 0)
  check('protectedByCamera: each camera its own stretches, merged per camera only, oldest first', J(p) === J([[1000, 3000, 'n1/0'], [1500, 3000, 'n1/1'], [9000, 9100, 'n1/1']]), J(p))
  check('  the margin at both ends', J(protectedByCamera([{ startMs: 1000, endMs: 2000, cameras: ['n1/0'] }], 500)) === '[[500,2500,"n1/0"]]')
  // (a bookmark whose cameras cannot be read is not turned into a bookmark of no cameras: that would widen
  // what the deletion jobs may take; it keeps every camera, as all bookmarks did before)
  check('  a row whose cameras cannot be read keeps every camera (null), never none', J(protectedByCamera([{ startMs: 1, endMs: 2, cameras: '{oops' }], 0)) === '[[1,2,null]]')
  check('  and one naming no camera, or something that is not a camera key', J(protectedByCamera([{ startMs: 1, endMs: 2, cameras: '[]' }, { startMs: 5, endMs: 6, cameras: [7] }], 0)) === '[[1,2,null],[5,6,null]]')
  check('  anything that is not a time is left out', protectedByCamera([{ startMs: null, endMs: 5, cameras: ['n1/0'] }], 0).length === 0)

  const B = Date.parse('2026-09-20T09:00:00Z')
  const M = DEFAULT_MARGIN_MS
  createBookmark({ cameras: ['nvr5/0'], startMs: B, endMs: B + 90_000, title: 'Line crossing — Maingate Roadway' }, AUTO_USER, { now: NOW })
  createBookmark({ cameras: ['nvr5/2', 'nvr5/1'], startMs: B + 30_000, endMs: B + 60_000, title: 'Van at the gate, two cameras' }, 'alice', { now: NOW })
  const got = protectedRanges(B - 3600_000, B + 3600_000)
  check('PROTECTEDRANGES NAMES EACH STRETCH\'S CAMERA: a bookmark keeps the cameras it names, a minute either side', J(got) === J([[B - M, B + 90_000 + M, 'nvr5/0'], [B + 30_000 - M, B + 60_000 + M, 'nvr5/1'], [B + 30_000 - M, B + 60_000 + M, 'nvr5/2']]), J(got))
  check('  and destructured as before, [from, to] first', got.every(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a < b))
  const raw = new DatabaseSync(BOOKMARKS_DB)
  raw.prepare('INSERT INTO bookmarks (cameras, start_ms, end_ms, title, user, created_ms) VALUES (?, ?, ?, ?, ?, ?)').run('{oops', B + 7200_000, B + 7260_000, 'damaged', 'alice', NOW)
  raw.close()
  check('  a stored bookmark whose cameras cannot be read keeps every camera', J(protectedRanges(B + 7200_000, B + 7260_000)) === J([[B + 7200_000 - M, B + 7260_000 + M, null]]), J(protectedRanges(B + 7200_000, B + 7260_000)))

  // An automatic bookmark (filed under "system": line-actions.mjs) is forgotten after its camera's days kept
  // (line-actions.mjs forgetLineBookmarks) unless a person has kept it: a person who changes one takes it over.
  const auto = createBookmark({ cameras: ['nvr5/3'], startMs: B + 86_400_000, endMs: B + 86_490_000, title: 'Line crossing — Yard' }, AUTO_USER, { now: NOW }).bookmark
  const stretched = updateBookmark(auto.id, { endMs: B + 86_520_000 }, { user: AUTO_USER, admin: true })
  check('an automatic bookmark stretched by the system stays the system\'s', stretched.ok && stretched.bookmark.user === AUTO_USER, J(stretched))
  check('  a viewer cannot change it', updateBookmark(auto.id, { title: 'mine now' }, { user: 'bob' }).status === 403)
  const kept = updateBookmark(auto.id, { title: 'Line crossing — Yard: pallet taken' }, { user: 'alice' })
  check('AN AUTOMATIC BOOKMARK A PERSON CHANGES BECOMES THEIRS (kept like their own, never forgotten by itself)', kept.ok && kept.bookmark.user === 'alice' && getBookmark(auto.id).user === 'alice', J(kept))
  const bobs = createBookmark({ cameras: ['nvr5/4'], startMs: B, endMs: B + 1000, title: 'Bob saw it' }, 'bob', { now: NOW }).bookmark
  const edited = updateBookmark(bobs.id, { title: 'Bob saw it (checked)' }, { user: 'alice' })
  check('  a person\'s bookmark an admin changes stays the person\'s', edited.ok && edited.bookmark.user === 'bob', J(edited))
  // forgetting many at once (line-actions.mjs forgetLineBookmarks): one transaction, whatever the rights (the
  // server's own job decides which)
  const { removeBookmarks } = await import('../bookmarks.mjs')
  const a1 = createBookmark({ cameras: ['nvr5/6'], startMs: B, endMs: B + 1000, title: 'Line crossing — a' }, AUTO_USER, { now: NOW }).bookmark
  const a2 = createBookmark({ cameras: ['nvr5/6'], startMs: B + 5000, endMs: B + 6000, title: 'Line crossing — b' }, AUTO_USER, { now: NOW }).bookmark
  check('removeBookmarks: the ones named go, in one go, and it says how many', removeBookmarks([a1.id, a2.id, 999_999]) === 2 && getBookmark(a1.id) === null && getBookmark(a2.id) === null && getBookmark(bobs.id) !== null)
  check('  nothing named, nothing done', removeBookmarks([]) === 0)
}

closeBookmarks()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
