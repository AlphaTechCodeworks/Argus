// Offline tests for the Live page's start order: which cameras of a page are asked for first
// (public/grid-view.js startPlan / startRanks / checkStartOrder), kept on a saved view (checkView,
// views.mjs, shared views read-only) or, with no view, as the preference cctv.startOrder
// (user-prefs.mjs). Temp data folder only; nothing is sent anywhere.
//   node cctv/test/start-order.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-start-order-'))
const {
  MAX_START_ORDER, MAX_VIEW_CAMERAS, START_LEAD_MS, START_STEP_MS,
  checkStartOrder, checkView, normaliseViews, parseStartOrder, startPlan, startRanks, withStartOrder
} = await import('../public/grid-view.js')
const { SHARED_VIEWS_PATH, VIEWS_PATH, handleViews } = await import('../views.mjs')
const { handleUiPreferences } = await import('../user-prefs.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const slot = (key) => (key ? { key, nvr: key.slice(0, key.lastIndexOf('/')) } : null)

// ---- the order tiles open in ----------------------------------------------------------------------
{
  check('the constants: 15 ms per NVR, a 100 ms head start, as many as a view holds', START_STEP_MS === 15 && START_LEAD_MS === 100 && MAX_START_ORDER === MAX_VIEW_CAMERAS)

  // a 2x2 page: A/0 A/1 / B/0 A/2
  const page = ['A/0', 'A/1', 'B/0', 'A/2'].map(slot)
  const plain = startPlan(page, [])
  check('no start order: reading order', same(plain.order, [0, 1, 2, 3]), JSON.stringify(plain))
  check('  stagger counted per NVR, no head start (exactly as before)', same(plain.delays, [0, 15, 0, 30]), JSON.stringify(plain.delays))
  check('  undefined order is the same', same(startPlan(page).delays, plain.delays))

  const ord = startPlan(page, ['A/2', 'B/0'])
  check('numbered cameras first, in their order, then the rest in reading order', same(ord.order, [3, 2, 0, 1]), JSON.stringify(ord.order))
  check('  on each NVR the first numbered camera is asked first; the rest wait the head start', same(ord.delays, [15 + 100, 30 + 100, 0, 0]), JSON.stringify(ord.delays))

  const off = startPlan(page, ['Z/9', 'A/1', 'C/4'])
  check('cameras in the order but not on this page are skipped', same(off.order, [1, 0, 2, 3]) && same(off.delays, [115, 0, 100, 130]), JSON.stringify(off))
  const none = startPlan(page, ['Z/9'])
  check('  an order naming only cameras elsewhere: no head start either', same(none.delays, plain.delays))

  const gaps = startPlan([slot('A/0'), null, slot('A/1'), null], ['A/1'])
  check('empty and offline tiles neither wait nor count', same(gaps.order, [2, 0]) && same(gaps.delays, [115, 0, 0, 0]), JSON.stringify(gaps))
  check('options: step and lead', same(startPlan(page, ['A/2'], { stepMs: 60, leadMs: 0 }).delays, [60, 120, 0, 0]))
  check('nothing at all', same(startPlan([], ['A/0']), { order: [], delays: [] }) && same(startPlan(null), { order: [], delays: [] }))

  check('ranks: numbers over this page only, 0 for the rest', same(startRanks(['A/0', 'A/1', null, 'B/0'], ['Z/1', 'B/0', 'A/0', 'B/0']), [2, 0, 0, 1]))
  check('  no order: all 0', same(startRanks(['A/0', null], null), [0, 0]))
}

// ---- checking a start order ---------------------------------------------------------------------------
{
  check('a list of keys is accepted, repeats kept once', same(checkStartOrder(['A/1', 'B/2', 'A/1']).value, ['A/1', 'B/2']))
  check('  not a list: refused', !checkStartOrder('A/1').ok && !checkStartOrder({}).ok)
  check('  a bad key: refused', !checkStartOrder(['A/1', '../x']).ok && !checkStartOrder([3]).ok)
  check('  more than MAX_START_ORDER: refused', !checkStartOrder(Array.from({ length: MAX_START_ORDER + 1 }, (_, i) => `A/${i}`)).ok)
  check('  within: keys outside dropped', same(checkStartOrder(['A/1', 'Z/9'], { within: new Set(['A/1']) }).value, ['A/1']))
  check('parseStartOrder: the stored text read back; junk is []', same(parseStartOrder('["A/1","B/2"]'), ['A/1', 'B/2']) && same(parseStartOrder('nope'), []) && same(parseStartOrder(null), []) && same(parseStartOrder('["bad key"]'), []))
  check('withStartOrder: set, and [] takes it off', same(withStartOrder({ id: 'v', startOrder: ['x/1'] }, []), { id: 'v' }) && same(withStartOrder({ id: 'v' }, ['A/1']), { id: 'v', startOrder: ['A/1'] }))
}

// ---- on a saved view ---------------------------------------------------------------------------------
{
  const view = { id: 'v1', name: 'Yard', cameras: ['A/0', 'A/1', 'B/0'], layout: 'g2' }
  const old = checkView(view)
  check('a view without a start order is unchanged (no field added)', old.ok && !('startOrder' in old.value))
  const v = checkView({ ...view, startOrder: ['B/0', 'A/0'] })
  check('a view keeps its start order', v.ok && same(v.value.startOrder, ['B/0', 'A/0']))
  check('  only cameras of the view: others dropped, repeats once', same(checkView({ ...view, startOrder: ['Z/9', 'A/1', 'A/1'] }).value.startOrder, ['A/1']))
  check('  an empty order is left off', !('startOrder' in checkView({ ...view, startOrder: [] }).value))
  check('  null is the same as none', checkView({ ...view, startOrder: null }).ok && !('startOrder' in checkView({ ...view, startOrder: null }).value))
  check('  a bad key refuses the view', !checkView({ ...view, startOrder: ['nope'] }).ok)
  check('  so does a list longer than a view may hold', !checkView({ ...view, startOrder: Array.from({ length: MAX_VIEW_CAMERAS + 1 }, (_, i) => `A/${i}`) }).ok)
  check('  not a list: refused', !checkView({ ...view, startOrder: 'A/0' }).ok)
  check('  a camera that no longer exists drops from the order as from the view', same(checkView({ ...view, startOrder: ['B/0', 'A/0'] }, { known: new Set(['A/0', 'A/1']) }).value.startOrder, ['A/0']))
  check('normaliseViews keeps it', same(normaliseViews([{ ...view, startOrder: ['A/1'] }]).views[0].startOrder, ['A/1']))

  // the server: saved with the view, and a shared view's order shown only over cameras the reader may watch
  const body = (x) => () => Promise.resolve(x)
  const [st, saved] = await handleViews('PUT', VIEWS_PATH, body({ views: [{ ...view, shared: true, startOrder: ['B/0', 'A/1'] }], version: 0 }), 'mike')
  check('PUT /api/me/views saves the start order', st === 200 && same(saved.views[0].startOrder, ['B/0', 'A/1']), JSON.stringify(saved))
  const [, back] = await handleViews('GET', VIEWS_PATH, body({}), 'mike')
  check('  and GET gives it back', same(back.views[0].startOrder, ['B/0', 'A/1']))
  const [bad] = await handleViews('PUT', VIEWS_PATH, body({ views: [{ ...view, startOrder: ['../x'] }], version: 1 }), 'mike')
  check('  a bad start order is refused (400)', bad === 400)
  const shared = async (user, may) => (await handleViews('GET', SHARED_VIEWS_PATH, body({}), user, { mayWatch: may }))[1].views
  const forAnn = await shared('ann', () => true)
  check('shared: the owner\'s order comes with the view', same(forAnn[0]?.startOrder, ['B/0', 'A/1']))
  const forSam = await shared('sam', (nvr) => nvr === 'A')
  check('  but never names a camera the reader may not watch', same(forSam[0]?.cameras, ['A/0', 'A/1']) && same(forSam[0]?.startOrder, ['A/1']), JSON.stringify(forSam))
  const forZed = await shared('zed', (nvr, ch) => nvr === 'A' && ch === 0)
  check('  and is left off when none of it is left', forZed.length === 1 && !('startOrder' in forZed[0]), JSON.stringify(forZed))
}

// ---- as a preference (no view) ---------------------------------------------------------------------
{
  const req = (body) => {
    const r = Readable.from([JSON.stringify(body)])
    r.method = 'PATCH'
    r.headers = { host: 'cctv.local', origin: 'https://cctv.local', 'content-type': 'application/json' }
    return r
  }
  const patch = (value) => handleUiPreferences(req({ account: 'alice', preferences: { 'cctv.startOrder': value } }), 'alice')
  const [s1, b1] = await patch('["A/2","B/0"]')
  check('cctv.startOrder: a JSON list of keys is saved', s1 === 200 && b1.preferences['cctv.startOrder'] === '["A/2","B/0"]', JSON.stringify(b1))
  check('  [] (cleared) too', (await patch('[]'))[0] === 200)
  check('  not JSON: refused', (await patch('A/2'))[0] === 400)
  check('  not a list: refused', (await patch('{"a":1}'))[0] === 400)
  check('  a bad key: refused', (await patch('["A/2","no"]'))[0] === 400)
  check('  a repeated key: refused', (await patch('["A/2","A/2"]'))[0] === 400)
  check('  more than MAX_START_ORDER keys: refused', (await patch(JSON.stringify(Array.from({ length: MAX_START_ORDER + 1 }, (_, i) => `A/${i}`))))[0] === 400)
  const longest = Array.from({ length: MAX_START_ORDER }, (_, i) => `${'n'.repeat(64)}/${1000 + i}`)
  check('  the most it may hold, with the longest keys, fits', (await patch(JSON.stringify(longest)))[0] === 200)
  check('  not a string: refused', (await handleUiPreferences(req({ account: 'alice', preferences: { 'cctv.startOrder': ['A/2'] } }), 'alice'))[0] === 400)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
