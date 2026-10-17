// Tests the saved-views routes (views.mjs) against a scratch data folder: GET/PUT /api/me/views with
// drawn layouts and the share flag, and GET /api/views/shared — everyone else's shared views, with
// only the cameras the asker may watch live, and no way to change them.
//   node cctv/test/views.test.mjs
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'cctv-views-'))
process.env.DATA_DIR = dir
const { SHARED_VIEWS_PATH, VIEWS_FILE, VIEWS_PATH, handleViews } = await import('../views.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const body = (x) => () => Promise.resolve(x)
const put = (user, views, version) => handleViews('PUT', VIEWS_PATH, body({ views, version }), user)
const get = (user) => handleViews('GET', VIEWS_PATH, body({}), user)
// sam may watch nvr-1 only; ann everything on nvr-1 and nvr-2
const rights = { sam: (nvr) => nvr === 'nvr-1', ann: (nvr) => nvr === 'nvr-1' || nvr === 'nvr-2' }
const shared = (user) => handleViews('GET', SHARED_VIEWS_PATH, body({}), user, { mayWatch: rights[user] ?? (() => false) })

try {
  check('the views file lives in the data folder', VIEWS_FILE.startsWith(dir))
  check('nothing saved yet: no views, version 0', JSON.stringify(await get('mike')) === JSON.stringify([200, { views: [], version: 0 }]))

  const yard = { id: 'v1', name: 'Yard', cameras: ['nvr-1/0', 'nvr-2/3'], layout: 'custom', custom: { size: 3, big: [[1, 1, 2, 2]] }, shared: true }
  const desk = { id: 'v2', name: 'Desk', cameras: ['nvr-2/1'], layout: 'g2' }
  const [st, saved] = await put('mike', [yard, desk], 0)
  check('PUT: a drawn, shared view and a plain one are saved', st === 200 && saved.version === 1 && saved.views.length === 2)
  check('  the drawing and the flag are stored as sent', JSON.stringify(saved.views[0]) === JSON.stringify(yard))
  check('  the plain one gains nothing', JSON.stringify(saved.views[1]) === JSON.stringify(desk))
  const onDisk = JSON.parse(readFileSync(VIEWS_FILE, 'utf8'))
  check('  in the owner\'s own entry, with its own version', onDisk.mike.viewsVersion === 1 && onDisk.mike.views[0].custom.size === 3)

  const [badSt, bad] = await put('mike', [{ ...yard, custom: { size: 3, big: [[1, 1, 2, 2], [2, 2, 2, 2]] } }], 1)
  check('PUT: a drawing with overlapping tiles is refused, not saved', badSt === 400 && /could not be saved/.test(bad.error) && JSON.parse(readFileSync(VIEWS_FILE, 'utf8')).mike.viewsVersion === 1)
  check('  so is a drawn layout without its drawing', (await put('mike', [{ ...yard, custom: undefined }], 1))[0] === 400)
  check('  and one far too big', (await put('mike', [{ ...yard, custom: { size: 50, big: [] } }], 1))[0] === 400)

  // ---- sharing ----
  const [s1, forSam] = await shared('sam')
  check('shared: listed to another user, with whose it is', s1 === 200 && forSam.views.length === 1 && forSam.views[0].owner === 'mike' && forSam.views[0].name === 'Yard')
  check('  only the cameras that user may watch live', JSON.stringify(forSam.views[0].cameras) === JSON.stringify(['nvr-1/0']))
  check('  the drawing comes with it', JSON.stringify(forSam.views[0].custom) === JSON.stringify(yard.custom))
  check('  a view not shared is not listed', !forSam.views.some((v) => v.id === 'v2'))
  check('  someone with every camera of it gets them all', JSON.stringify((await shared('ann'))[1].views[0].cameras) === JSON.stringify(yard.cameras))
  check('  someone who may watch none of its cameras is not told of it at all', (await shared('zed'))[1].views.length === 0)
  check('  the owner does not get their own views twice', (await shared('mike'))[1].views.length === 0)
  check('  without a mayWatch, no camera at all (default deny)', (await handleViews('GET', SHARED_VIEWS_PATH, body({}), 'sam'))[1].views.length === 0)
  check('  signed out: 401', (await shared(''))[0] === 401)
  check('  read-only: PUT/POST/DELETE refused', (await Promise.all(['PUT', 'POST', 'DELETE'].map((m) => handleViews(m, SHARED_VIEWS_PATH, body({ views: [] }), 'sam')))).every(([s]) => s === 405))

  // another user's save cannot touch mike's views: each user's own entry, own version
  const [samSt] = await put('sam', [{ ...yard, id: 'v1', name: 'Sam copy', shared: false }], 0)
  check('another user saving a view with the same id makes their own, not a change to the owner\'s', samSt === 200 && (await get('mike'))[1].views[0].name === 'Yard' && (await get('mike'))[1].version === 1)
  check('  a copy saved unshared is not listed to anyone', !(await shared('ann'))[1].views.some((v) => v.owner === 'sam'))

  // un-sharing takes it off everyone's list
  const [, now] = await get('mike')
  await put('mike', now.views.map((v) => ({ ...v, shared: false })), now.version)
  check('unsharing: gone from the others\' list', (await shared('sam'))[1].views.length === 0)
  check('  and the owner still has the view, drawing and all', (await get('mike'))[1].views[0].custom?.size === 3 && !('shared' in (await get('mike'))[1].views[0]))

  // an old file, from before drawn layouts and sharing, reads exactly as it did
  const { writeFileSync } = await import('node:fs')
  writeFileSync(VIEWS_FILE, JSON.stringify({ old: { views: [{ id: 'o1', name: 'Old', cameras: ['nvr-1/0'], layout: 'g3' }], viewsVersion: 4 } }))
  check('an old view reads back unchanged', JSON.stringify(await get('old')) === JSON.stringify([200, { views: [{ id: 'o1', name: 'Old', cameras: ['nvr-1/0'], layout: 'g3' }], version: 4 }]))
  check('  and is not shared', (await shared('sam'))[1].views.length === 0)
  writeFileSync(VIEWS_FILE, '{ damaged')
  check('a damaged file: the shared list says so (500), it does not answer "none"', (await shared('sam'))[0] === 500)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
