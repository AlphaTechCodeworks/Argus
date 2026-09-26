// Offline tests for the live grid's own camera order (public/grid-order.js): applying a saved
// order to the camera list, swapping two tiles, moving a camera to the first place of the page
// before/after, reset, which tiles a re-layout can keep playing, changes kept as operations (so a
// change can be done again on top of another screen's newer order, and doing one twice is
// harmless), where the order starts from (the server's, with this browser's unsaved changes done
// again on top), and the sync with the server: 500 ms debounce, one request at a time, a save
// from an old version refused by the server (409) and done again on the newer order, re-reading
// the order on the 30 s refresh, failures reported and retried. The sync runs against the real
// server code (user-prefs.mjs, temp data folder) behind a fake network: the same user on several
// screens. Also scans viewer.js / index.html for the wiring (the viewer needs a browser).
//   node cctv/test/grid-order.test.mjs
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { visibleCameras } from '../public/grid-diff.js'
import {
  KEY_RE,
  MAX_CONFLICT_TRIES,
  MAX_KEYS,
  MAX_OPS,
  applyOp,
  applyOps,
  applyOrder,
  cleanOrder,
  createOrderSync,
  effectiveOrder,
  isOp,
  moveOp,
  moveToPage,
  pickStart,
  readLocal,
  reset,
  reuseSlots,
  swapKeys,
  swapOp,
  writeLocal
} from '../public/grid-order.js'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-grid-order-test-'))
const { gridOrderOf, handleGridOrder } = await import('../user-prefs.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const cam = (nvr, ch, extra = {}) => ({ nvr, site: 'A', nvrName: nvr.toUpperCase(), ch, name: `Cam ${ch + 1}`, online: true, remote: false, ...extra })
const key = (c) => `${c.nvr}/${c.ch}`
const keysOf = (list) => list.map(key).join(' ')
// the server's (default) order: site, NVR, channel
const base = () => [cam('n1', 0), cam('n1', 1), cam('n1', 2), cam('n1', 3), cam('n2', 0), cam('n2', 1)]

// ---- the same key rules as the server ------------------------------------------------------------
check('KEY_RE and MAX_KEYS match the server (user-prefs.mjs)', (() => {
  const src = readFileSync(new URL('../user-prefs.mjs', import.meta.url), 'utf8')
  return src.includes(`KEY_RE = ${KEY_RE}`) && new RegExp(`MAX_KEYS = ${MAX_KEYS}\\b`).test(src)
})())

// ---- applyOrder ----------------------------------------------------------------------------------------
{
  check('no saved order: the default order, as a copy', keysOf(applyOrder(base(), [])) === keysOf(base()) && applyOrder(base(), []) !== base())
  check('undefined order: the default order', keysOf(applyOrder(base(), undefined)) === keysOf(base()))
  const o = ['n2/1', 'n1/2', 'n1/0']
  check('saved cameras first, in the saved order; the rest after, in default order', keysOf(applyOrder(base(), o)) === 'n2/1 n1/2 n1/0 n1/1 n1/3 n2/0')
  check('keys of cameras that no longer exist are ignored for display', keysOf(applyOrder(base(), ['gone/4', 'n1/3', 'n9/0'])) === 'n1/3 n1/0 n1/1 n1/2 n2/0 n2/1')
  const withNew = [...base(), cam('n3', 0, { site: 'B' })]
  check('a new camera (not in the saved order) goes at the end', keysOf(applyOrder(withNew, ['n2/1', 'n2/0', 'n1/3', 'n1/2', 'n1/1', 'n1/0'])) === 'n2/1 n2/0 n1/3 n1/2 n1/1 n1/0 n3/0')
  const objs = base()
  check('the camera objects themselves (not copies)', applyOrder(objs, ['n1/1'])[0] === objs[1])
  check('does not change its inputs', (() => { const b = base(); const ord = ['n2/0']; applyOrder(b, ord); return keysOf(b) === keysOf(base()) && ord.length === 1 })())
}

// ---- effectiveOrder: the full list a change starts from ----------------------------------------------------
{
  check('saved keys (kept, even stale ones) then the rest in list order', effectiveOrder(['gone/1', 'n1/2'], base()).join(' ') === 'gone/1 n1/2 n1/0 n1/1 n1/3 n2/0 n2/1')
  check('empty order: every camera in list order', effectiveOrder([], base()).join(' ') === keysOf(base()))
}

// ---- swapKeys ------------------------------------------------------------------------------------------------
{
  const s = swapKeys([], 'n1/0', 'n1/2', base())
  check('swap from the default order: the two change places, the rest stay', s.join(' ') === 'n1/2 n1/1 n1/0 n1/3 n2/0 n2/1', s.join(' '))
  check('  and the grid shows that', keysOf(applyOrder(base(), s)) === 'n1/2 n1/1 n1/0 n1/3 n2/0 n2/1')
  const s2 = swapKeys(['gone/9', 'n2/1', 'n1/0'], 'n2/1', 'n1/3', base())
  check('stale keys keep their place (the camera comes back there)', s2.join(' ') === 'gone/9 n1/3 n1/0 n1/1 n1/2 n2/1 n2/0', s2.join(' '))
  const back = swapKeys(s, 'n1/0', 'n1/2', base())
  check('swapping back gives the default display order', keysOf(applyOrder(base(), back)) === keysOf(base()))
  check('a key that is not a camera: nothing changes', swapKeys(['n1/1'], 'n1/1', 'zz/1', base()).join(' ') === 'n1/1')
  check('a camera with itself: nothing changes', swapKeys(['n1/1'], 'n1/1', 'n1/1', base()).join(' ') === 'n1/1')
  const input = ['n1/1']
  swapKeys(input, 'n1/1', 'n1/0', base())
  check('does not change its input', input.join() === 'n1/1')
  // one global order: a swap under a site filter keeps the other site's cameras where they were
  const two = [cam('a1', 0, { site: 'A' }), cam('b1', 0, { site: 'B' }), cam('a1', 1, { site: 'A' }), cam('b1', 1, { site: 'B' })]
  const sw = swapKeys([], 'a1/0', 'a1/1', two)
  check('site filter: swapping two of site A leaves site B in place', sw.join(' ') === 'a1/1 b1/0 a1/0 b1/1', sw.join(' '))
}

// ---- moveToPage ---------------------------------------------------------------------------------------------------
{
  // 10 cameras, 4 per page: pages [0-3] [4-7] [8-9]
  const ten = Array.from({ length: 10 }, (_, i) => cam('n1', i))
  const view = (order, page, extra = {}) => visibleCameras(applyOrder(ten, order), { site: '', hideOffline: false, perPage: 4, page, ...extra })
  const next = moveToPage([], 'n1/1', 1, 4, ten)
  check('to the next page: first place there', keysOf(view(next, 1).visible) === 'n1/1 n1/5 n1/6 n1/7', keysOf(view(next, 1).visible))
  check('  its old page closes up and takes the next page\'s first camera', keysOf(view(next, 0).visible) === 'n1/0 n1/2 n1/3 n1/4')
  const prev = moveToPage([], 'n1/6', 0, 4, ten)
  check('to the previous page: first place there', keysOf(view(prev, 0).visible) === 'n1/6 n1/0 n1/1 n1/2', keysOf(view(prev, 0).visible))
  check('  that page\'s last camera moves on to the next page', keysOf(view(prev, 1).visible) === 'n1/3 n1/4 n1/5 n1/7')
  const last = moveToPage([], 'n1/5', 2, 4, ten)
  check('to the last (short) page: first place there (its old first camera closes the gap before it)', keysOf(view(last, 2).visible) === 'n1/5 n1/9' && keysOf(view(last, 1).visible) === 'n1/4 n1/6 n1/7 n1/8' && view(last, 2).pages === 3, keysOf(view(last, 2).visible))
  const nine = ten.slice(0, 9) // exactly 2 pages + 1: moving the last-but-one page's camera onto the 1-camera page
  const m9 = moveToPage([], 'n1/0', 2, 4, nine)
  check('onto a page whose only camera then moves up: it becomes that page\'s first (and only) camera', keysOf(visibleCameras(applyOrder(nine, m9), { site: '', hideOffline: false, perPage: 4, page: 2 }).visible) === 'n1/0')
  check('no such page (after the last, or before the first): nothing changes', moveToPage(['n1/1'], 'n1/1', 3, 4, ten).join() === 'n1/1' && moveToPage(['n1/1'], 'n1/1', -1, 4, ten).join() === 'n1/1')
  check('a camera not shown: nothing changes', moveToPage([], 'zz/0', 1, 4, ten).length === 0)
  // with a filter: pages count the shown cameras only; hidden cameras keep their place in the list
  const mixed = ten.map((c, i) => (i % 2 ? { ...c, online: false } : c)) // 0 2 4 6 8 online
  const shown = mixed.filter((c) => c.online)
  const m = moveToPage([], 'n1/8', 0, 2, shown, mixed)
  const after = applyOrder(mixed, m)
  check('hide offline: moves among the shown cameras (to the first place of page 1)', keysOf(visibleCameras(after, { site: '', hideOffline: true, perPage: 2, page: 0 }).visible) === 'n1/8 n1/0', keysOf(after))
  check('  hidden cameras keep their order relative to each other', keysOf(after.filter((c) => !c.online)) === 'n1/1 n1/3 n1/5 n1/7 n1/9')
  check('  every camera is still there once', after.length === 10 && new Set(after.map(key)).size === 10)
  check('keeps stale keys', moveToPage(['gone/1'], 'n1/6', 0, 4, ten).includes('gone/1'))
}

// ---- reset ---------------------------------------------------------------------------------------------------------------
check('reset: the empty order (= default order)', Array.isArray(reset()) && reset().length === 0 && keysOf(applyOrder(base(), reset())) === keysOf(base()))

// ---- changes as operations: done again on another screen's newer order; done twice, no harm --------------------------------
{
  const cams = base()
  const op = swapOp([], 'n1/2', 'n1/0', cams)
  check('swapOp names the two in their order now (a before b)', op?.op === 'swap' && op.a === 'n1/0' && op.b === 'n1/2', JSON.stringify(op))
  const once = applyOp([], op, cams)
  check('  done: the same as swapKeys', once.join(' ') === swapKeys([], 'n1/0', 'n1/2', cams).join(' '), once.join(' '))
  check('  done twice: still swapped (a save whose answer was lost can be sent again)', applyOp(once, op, cams).join(' ') === once.join(' '))
  const other = ['n2/1', 'n1/0', 'n2/0', 'n1/1', 'n1/2', 'n1/3'] // another screen's newer order
  check('  on another screen\'s order: the two change places there, the rest stays as that screen left it', applyOp(other, op, cams).join(' ') === 'n2/1 n1/2 n2/0 n1/1 n1/0 n1/3', applyOp(other, op, cams).join(' '))
  check('  when that order already has them the other way round: nothing changes', applyOp(['n1/2', 'n1/0'], op, cams).join(' ') === 'n1/2 n1/0')
  check('swapOp of a camera with itself, or of an unknown key: null', swapOp([], 'n1/0', 'n1/0', cams) === null && swapOp([], 'n1/0', 'zz/0', cams) === null)
  check('a swap with a camera gone meanwhile (not in the order either): skipped', applyOp(['n1/0'], { op: 'swap', a: 'gone/1', b: 'n1/0' }, cams).join() === 'n1/0')

  const ten = Array.from({ length: 10 }, (_, i) => cam('n1', i))
  const m = moveOp('n1/1', 1, 4, ten)
  check('moveOp: just before the camera that is first on that page now', m?.op === 'move' && m.key === 'n1/1' && m.before === 'n1/5' && m.after === undefined, JSON.stringify(m))
  const moved = applyOp([], m, ten)
  check('  done: the same as moveToPage', moved.join() === moveToPage([], 'n1/1', 1, 4, ten).join())
  check('  done twice: the same', applyOp(moved, m, ten).join() === moved.join())
  check('  on another order: just before that camera there', applyOp(['n1/5', 'n1/0'], m, ten).slice(0, 3).join(' ') === 'n1/1 n1/5 n1/0')
  const m9 = moveOp('n1/0', 2, 4, ten.slice(0, 9))
  check('moveOp onto a page whose only camera then moves up: after the last camera shown', m9?.after === 'n1/8' && m9.before === undefined, JSON.stringify(m9))
  check('moveOp to no such page, or of a camera not shown: null', moveOp('n1/1', 3, 4, ten) === null && moveOp('n1/1', -1, 4, ten) === null && moveOp('zz/0', 1, 4, ten) === null)
  check('a move whose camera is gone meanwhile: skipped', applyOp([], { op: 'move', key: 'n1/1', before: 'gone/5' }, cams).length === 0)

  check('the reset op: the default order, whatever came before', applyOp(['n1/3', 'n1/1'], { op: 'reset' }, cams).length === 0)
  check('a set op: that order', applyOp(['n1/3'], { op: 'set', order: ['n1/1', 'n1/0'] }, cams).join() === 'n1/1,n1/0')
  const two = applyOps([], [swapOp([], 'n1/0', 'n1/1', cams), { op: 'move', key: 'n2/1', before: 'n1/1' }], cams)
  check('applyOps: in turn', two.join(' ') === 'n2/1 n1/1 n1/0 n1/2 n1/3 n2/0', two.join(' '))
  check('applyOps does not change its input', (() => { const o = ['n1/1']; applyOps(o, [{ op: 'reset' }], cams); return o.join() === 'n1/1' })())

  const good = [op, m, m9, { op: 'reset' }, { op: 'set', order: ['n1/0'] }]
  check('isOp: the ones made here', good.every(isOp))
  const bad = [null, 'swap', {}, { op: 'drop' }, { op: 'swap', a: 'n1/0' }, { op: 'swap', a: 'n1/0', b: 'n1/0' }, { op: 'swap', a: 'bad key', b: 'n1/0' },
    { op: 'move', key: 'n1/0' }, { op: 'move', key: 'n1/0', before: 'n1/1', after: 'n1/2' }, { op: 'move', key: 'n1/0', before: 'n1/0' }, { op: 'move', key: '../x', after: 'n1/0' },
    { op: 'set', order: 'n1/0' }, { op: 'set', order: [5] }]
  check('isOp: refuses the rest', bad.every((o) => !isOp(o)), JSON.stringify(bad.filter(isOp)))
}

// ---- cleanOrder: what may be saved -------------------------------------------------------------------------------------------
{
  check('drops bad keys and repeats (first place wins)', cleanOrder(['n1/0', 'bad key', 5, null, 'n1/0', 'n1/1', '../x/1']).join(' ') === 'n1/0 n1/1')
  check('not a list: empty', cleanOrder(null).length === 0 && cleanOrder({ 0: 'n1/0' }).length === 0 && cleanOrder('n1/0').length === 0)
  const many = [...Array.from({ length: MAX_KEYS }, (_, i) => `old/${i}`), 'n1/0', 'n1/1']
  const c = cleanOrder(many, base())
  check('over 4096: stale keys go first (the cameras there now stay)', c.length === MAX_KEYS && c.includes('n1/0') && c.includes('n1/1'), String(c.length))
  check('  without the camera list: cut at 4096', cleanOrder(many).length === MAX_KEYS)
}

// ---- reuseSlots: which tiles a re-layout keeps (their video keeps playing) -------------------------------------------------------
{
  const r = reuseSlots(['a', 'b', 'c', 'd'], ['c', 'b', 'a', 'd'])
  check('a swap: every tile kept, two change cell', r.from.join() === '2,1,0,3' && r.unused.length === 0)
  const r2 = reuseSlots(['a', 'b', 'c', 'd'], ['a', 'c', 'd', 'e'])
  check('a camera moved to another page: the others kept, one new tile, one closed', r2.from.join() === '0,2,3,-1' && r2.unused.join() === '1')
  const r3 = reuseSlots(['a', 'b', null, null], ['b', 'a', null, null])
  check('empty cells are never "kept" (new empty tiles), old ones removed', r3.from.join() === '1,0,-1,-1' && r3.unused.join() === '2,3')
}

// ---- where the order starts from --------------------------------------------------------------------------------------------------
{
  const sw = { op: 'swap', a: 'n1/0', b: 'n1/1' }
  const p1 = pickStart({ server: { order: ['n1/1'], version: 4 }, local: null })
  check('the server\'s order and version', p1.base.order.join() === 'n1/1' && p1.base.version === 4 && p1.ops.length === 0)
  const p2 = pickStart({ server: { order: ['n1/1'], version: 4 }, local: { version: 4, base: ['n1/2'], ops: [] } })
  check('  this browser\'s copy (nothing unsaved in it) does not count', p2.base.order.join() === 'n1/1' && p2.ops.length === 0)
  const p3 = pickStart({ server: { order: ['n2/0'], version: 9 }, local: { version: 2, base: ['n1/2'], ops: [sw] } })
  check('changes this browser never got saved: done again on top of the server\'s (newer) order, never instead of it', p3.base.order.join() === 'n2/0' && p3.base.version === 9 && p3.ops.length === 1 && p3.ops[0] === sw)
  const p4 = pickStart({ server: null, local: { version: 3, base: ['n1/3'], ops: [sw] } })
  check('server unreachable: this browser\'s copy (its version and unsaved changes)', p4.base.order.join() === 'n1/3' && p4.base.version === 3 && p4.ops.length === 1)
  const p5 = pickStart({ server: null, local: null })
  check('neither: the default order, version 0', p5.base.order.length === 0 && p5.base.version === 0 && p5.ops.length === 0)
}

const mem = () => {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }
}

// ---- this browser's copy (localStorage, per user; storage may be missing or throw) -----------------------------------------------------
{
  const sw = { op: 'swap', a: 'n1/0', b: 'n1/1' }
  const s = mem()
  writeLocal(s, 'alice', { version: 3, base: ['n1/1', 'n1/0'], ops: [sw] })
  const l = readLocal(s, 'alice')
  check('written and read back for the same user', l.version === 3 && l.base.join() === 'n1/1,n1/0' && l.ops.length === 1 && l.ops[0].op === 'swap')
  check('another user on the same browser: not theirs', readLocal(s, 'bob') === null)
  writeLocal(s, 'bob', { version: 1, base: ['n1/5'], ops: [] })
  check('  and each keeps their own', readLocal(s, 'alice').base.join() === 'n1/1,n1/0' && readLocal(s, 'bob').base.join() === 'n1/5')
  const throwing = { getItem: () => { throw new Error('SecurityError') }, setItem: () => { throw new Error('QuotaExceeded') } }
  check('storage that throws: no copy, no crash', readLocal(throwing, 'alice') === null && (writeLocal(throwing, 'alice', { version: 0, base: [], ops: [] }), true))
  check('no storage at all: no copy', readLocal(null, 'alice') === null && (writeLocal(null, 'alice', { version: 0, base: [], ops: [] }), true))
  check('no user: nothing read', readLocal(s, undefined) === null)
  const junk = mem()
  junk.setItem('cctv.gridOrder:alice', '{not json')
  check('junk in storage: ignored', readLocal(junk, 'alice') === null)
  junk.setItem('cctv.gridOrder:alice', JSON.stringify({ order: ['n1/0'], unsaved: true }))
  check('a copy without a base order: ignored', readLocal(junk, 'alice') === null)
  junk.setItem('cctv.gridOrder:alice', JSON.stringify({ version: 'x', base: ['n1/0', 'bad key'], ops: [sw, { op: 'drop' }, null] }))
  const j = readLocal(junk, 'alice')
  check('bad keys, bad changes and a bad version in storage: dropped (version 0)', j.base.join() === 'n1/0' && j.ops.length === 1 && j.version === 0, JSON.stringify(j))
}

// ---- the sync with the server: the real server code (user-prefs.mjs) behind a fake network ---------------------------------------------
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
}

/** One screen's network to the server, for one user: can be down, lose an answer, or hold a request. */
function network(user) {
  const net = { down: false, getDown: false, loseAnswer: false, puts: [], gets: 0, gates: [] }
  /** The next request of that method waits (before the server sees it, or after, for its answer) until release(). */
  net.gate = (method, where) => {
    let release
    const p = new Promise((r) => (release = r))
    net.gates.push({ method, where, p })
    return release
  }
  const take = (method, where) => {
    const i = net.gates.findIndex((g) => g.method === method && g.where === where)
    return i < 0 ? null : net.gates.splice(i, 1)[0].p
  }
  net.request = async (method, body) => {
    const before = take(method, 'before')
    const after = take(method, 'after')
    if (method === 'PUT') net.puts.push(JSON.parse(JSON.stringify(body)))
    else net.gets++
    if (net.down || (method === 'GET' && net.getDown)) throw new TypeError('Failed to fetch')
    await before
    const rq = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    rq.method = method
    rq.headers = { host: 'cctv.local:8443', 'content-type': 'application/json' }
    const [status, json] = await handleGridOrder(rq, user)
    await after
    if (method === 'PUT' && net.loseAnswer) {
      net.loseAnswer = false
      throw new TypeError('network error') // the server has it; this screen never hears so
    }
    return { status, body: JSON.parse(JSON.stringify(json)) }
  }
  return net
}

/** A hand-driven clock. */
function clock() {
  let now = 0
  let timers = []
  const setTimer = (fn, ms) => {
    const t = { at: now + ms, fn }
    timers.push(t)
    return t
  }
  const clearTimer = (t) => {
    timers = timers.filter((x) => x !== t)
  }
  const advance = async (ms) => {
    now += ms
    for (;;) {
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      clearTimer(due)
      due.fn()
      await settle()
    }
    await settle()
  }
  return { setTimer, clearTimer, advance, get timers() { return timers.length } }
}

/** One screen of a user: its sync, clock, network, browser storage, and what it reported. */
function screen(user, { storage = mem(), net = network(user), cameras = base } = {}) {
  const c = clock()
  const log = { changes: [], saved: 0, failed: [] }
  const sync = createOrderSync({
    request: net.request,
    cameras: () => cameras(),
    storage,
    user: () => user,
    onChange: (o) => log.changes.push([...o]),
    onSaved: () => log.saved++,
    onFailed: (e) => log.failed.push(e),
    setTimer: c.setTimer,
    clearTimer: c.clearTimer
  })
  return { sync, clock: c, net, storage, log, user }
}
const shown = (s) => keysOf(applyOrder(base(), s.sync.order))
const onServer = (user) => keysOf(applyOrder(base(), gridOrderOf(user)))
const swap = (s, a, b) => s.sync.change(swapOp(s.sync.order, a, b, base()))

// the basics: a change shows at once, is kept in this browser, and saved 500 ms after the last one
{
  const s = screen('amy')
  await s.sync.load()
  check('load: nothing saved yet, the default order', s.sync.order.length === 0 && !s.sync.unsaved && s.net.gets === 1)
  check('  load itself does not re-lay out the grid (the viewer builds it)', s.log.changes.length === 0)
  check('a change: true, and the grid is told at once', swap(s, 'n1/0', 'n1/1') === true && keysOf(applyOrder(base(), s.log.changes.at(-1))) === 'n1/1 n1/0 n1/2 n1/3 n2/0 n2/1')
  check('  kept in this browser as not saved yet', s.sync.unsaved && readLocal(s.storage, 'amy')?.ops.length === 1)
  await s.clock.advance(300)
  swap(s, 'n1/2', 'n1/3')
  await s.clock.advance(400)
  check('changes within 500 ms: nothing sent yet', s.net.puts.length === 0)
  await s.clock.advance(100)
  check('500 ms after the last change: one save, of the latest order, from version 0', s.net.puts.length === 1 && s.net.puts[0].version === 0 && keysOf(applyOrder(base(), s.net.puts[0].order)) === 'n1/1 n1/0 n1/3 n1/2 n2/0 n2/1', JSON.stringify(s.net.puts))
  check('  on the server', onServer('amy') === 'n1/1 n1/0 n1/3 n1/2 n2/0 n2/1')
  check('  reported saved; nothing unsaved; this browser\'s copy has the new version', s.log.saved === 1 && !s.sync.unsaved && readLocal(s.storage, 'amy').version === 1 && readLocal(s.storage, 'amy').ops.length === 0)
  check('a change that changes nothing: false, nothing sent', s.sync.change(swapOp(s.sync.order, 'n1/0', 'n1/0', base())) === false && s.sync.change(null) === false && s.clock.timers === 0)
}

// one request at a time: a change made while a save is on its way waits for it, then goes out
{
  const s = screen('bea')
  await s.sync.load()
  const release = s.net.gate('PUT', 'before')
  swap(s, 'n1/0', 'n1/1')
  await s.clock.advance(500)
  check('slow save on its way', s.net.puts.length === 1 && gridOrderOf('bea').length === 0)
  swap(s, 'n1/2', 'n1/3')
  await s.clock.advance(500)
  check('  a newer change does not overtake it', s.net.puts.length === 1)
  release()
  await settle()
  check('  it goes out when the first returns, from the version that one got (no conflict)', s.net.puts.length === 2 && s.net.puts[1].version === 1 && s.log.failed.length === 0)
  check('  both on the server', onServer('bea') === 'n1/1 n1/0 n1/3 n1/2 n2/0 n2/1' && !s.sync.unsaved)
}

// the review's case: the same user on a desk PC and a wall monitor; neither loses the other's change
{
  const desk = screen('cal')
  const wall = screen('cal')
  await desk.sync.load()
  await wall.sync.load()
  swap(desk, 'n1/0', 'n1/1')
  await desk.clock.advance(500)
  check('desk swaps A and B: saved', onServer('cal') === 'n1/1 n1/0 n1/2 n1/3 n2/0 n2/1')
  // the wall has not re-read the order yet: its change is made on the old one
  swap(wall, 'n2/0', 'n2/1')
  await wall.clock.advance(500)
  check('wall swaps C and D from the old order: its save is refused (409), done again on the newer order and saved', wall.net.puts.length === 2 && wall.net.puts[0].version === 0 && wall.net.puts[1].version === 1, JSON.stringify(wall.net.puts.map((p) => p.version)))
  check('  the server has both changes', onServer('cal') === 'n1/1 n1/0 n1/2 n1/3 n2/1 n2/0', onServer('cal'))
  check('  the wall shows both (the grid told)', shown(wall) === 'n1/1 n1/0 n1/2 n1/3 n2/1 n2/0' && keysOf(applyOrder(base(), wall.log.changes.at(-1))) === shown(wall))
  check('  no failure reported', wall.log.failed.length === 0 && wall.log.saved === 1 && !wall.sync.unsaved)
  const before = desk.log.changes.length
  await desk.sync.refresh()
  check('the desk\'s refresh (every 30 s, and when the tab shows again) picks up the wall\'s change', shown(desk) === 'n1/1 n1/0 n1/2 n1/3 n2/1 n2/0' && desk.log.changes.length === before + 1)
  await desk.sync.refresh()
  check('  nothing new: the grid is not touched, nothing sent', desk.log.changes.length === before + 1 && desk.net.puts.length === 1)
  // the wall is left alone (nobody touches it) and follows the desk
  swap(desk, 'n1/2', 'n1/3')
  await desk.clock.advance(500)
  await wall.sync.refresh()
  check('a screen nobody touches follows the other\'s changes', shown(wall) === 'n1/1 n1/0 n1/3 n1/2 n2/1 n2/0' && wall.net.puts.length === 2)
}

// a refresh never replaces changes waiting to be saved, and an answer that is out of date is not used
{
  const s = screen('dan')
  await s.sync.load()
  swap(s, 'n1/0', 'n1/1')
  const gets = s.net.gets
  await s.sync.refresh()
  check('refresh while a save is due: no GET (the save brings the latest order back)', s.net.gets === gets && shown(s) === 'n1/1 n1/0 n1/2 n1/3 n2/0 n2/1')
  await s.clock.advance(500)
  const release = s.net.gate('GET', 'after')
  const r = s.sync.refresh() // the server answers with version 1; the answer is slow to arrive
  await settle()
  swap(s, 'n2/0', 'n2/1')
  await s.clock.advance(500)
  check('  meanwhile a change is saved (version 2)', onServer('dan') === 'n1/1 n1/0 n1/2 n1/3 n2/1 n2/0')
  release()
  await r
  check('  the old answer is not used (the change stays on screen)', shown(s) === 'n1/1 n1/0 n1/2 n1/3 n2/1 n2/0')
  s.net.getDown = true
  const n = s.log.changes.length
  await s.sync.refresh()
  check('a refresh that fails: nothing changes, no error', shown(s) === 'n1/1 n1/0 n1/2 n1/3 n2/1 n2/0' && s.log.changes.length === n && s.log.failed.length === 0)
}

// a failed save: reported, kept in this browser, not retried in a loop; sent again with the next change or the next refresh
{
  const s = screen('eve')
  await s.sync.load()
  s.net.down = true
  swap(s, 'n1/0', 'n1/1')
  await s.clock.advance(500)
  check('failed save reported', s.log.failed.length === 1 && s.net.puts.length === 1)
  check('  kept in this browser as not saved', s.sync.unsaved && readLocal(s.storage, 'eve').ops.length === 1 && shown(s) === 'n1/1 n1/0 n1/2 n1/3 n2/0 n2/1')
  await s.clock.advance(60_000)
  check('  not retried in a loop', s.net.puts.length === 1)
  s.net.down = false
  await s.sync.refresh()
  check('  the next refresh (every 30 s) sends it', s.net.puts.length === 2 && onServer('eve') === 'n1/1 n1/0 n1/2 n1/3 n2/0 n2/1' && !s.sync.unsaved && s.log.saved === 1)
  s.net.down = true
  swap(s, 'n1/2', 'n1/3')
  await s.clock.advance(500)
  s.net.down = false
  swap(s, 'n2/0', 'n2/1')
  await s.clock.advance(500)
  check('  or the next change (with the latest order)', onServer('eve') === 'n1/1 n1/0 n1/3 n1/2 n2/1 n2/0' && !s.sync.unsaved)
}

// a save whose answer was lost (the server has it): sent again, the change is not done twice (a swap undone)
{
  const s = screen('fay')
  await s.sync.load()
  s.net.loseAnswer = true
  swap(s, 'n1/0', 'n1/1')
  await s.clock.advance(500)
  check('the server has the change; this screen thinks it failed', onServer('fay') === 'n1/1 n1/0 n1/2 n1/3 n2/0 n2/1' && s.log.failed.length === 1 && s.sync.unsaved)
  await s.sync.refresh()
  check('  sent again (409, done again on the saved order): still swapped once', onServer('fay') === 'n1/1 n1/0 n1/2 n1/3 n2/0 n2/1' && shown(s) === onServer('fay') && !s.sync.unsaved, onServer('fay'))
}

// the review's second case: a browser that kept an unsaved change loads after other screens changed the order
{
  const old = screen('gus')
  await old.sync.load()
  old.net.down = true
  swap(old, 'n1/0', 'n1/1')
  await old.clock.advance(500)
  check('an old browser keeps a change the server never got', old.sync.unsaved && gridOrderOf('gus').length === 0)
  const desk = screen('gus')
  await desk.sync.load()
  swap(desk, 'n1/2', 'n2/1')
  await desk.clock.advance(500)
  check('  meanwhile the desk changes the order', onServer('gus') === 'n1/0 n1/1 n2/1 n1/3 n2/0 n1/2')
  const again = screen('gus', { storage: old.storage })
  await again.sync.load()
  check('the old browser opens again: the desk\'s order, with its own change done again on top (nothing of the desk\'s lost)', shown(again) === 'n1/1 n1/0 n2/1 n1/3 n2/0 n1/2' && again.sync.unsaved, shown(again))
  await again.sync.refresh()
  check('  saved like that', onServer('gus') === 'n1/1 n1/0 n2/1 n1/3 n2/0 n1/2' && !again.sync.unsaved)
  // a change sent as the page closed (flush), whose answer the page never read
  const pc = screen('gus2')
  await pc.sync.load()
  pc.net.loseAnswer = true
  swap(pc, 'n1/0', 'n1/1')
  pc.sync.flush()
  await settle()
  check('a change sent as the page closed reached the server; the browser still has it as unsaved', onServer('gus2') === 'n1/1 n1/0 n1/2 n1/3 n2/0 n2/1' && readLocal(pc.storage, 'gus2').ops.length === 1)
  const reopened = screen('gus2', { storage: pc.storage })
  await reopened.sync.load()
  check('  opening the page again does not undo it', shown(reopened) === 'n1/1 n1/0 n1/2 n1/3 n2/0 n2/1', shown(reopened))
}

// the review's third case: the order could not be read (timeout) on a new browser, then a change
{
  const desk = screen('hal')
  await desk.sync.load()
  swap(desk, 'n2/0', 'n1/0')
  await desk.clock.advance(500)
  swap(desk, 'n1/1', 'n2/1')
  await desk.clock.advance(500)
  const saved = onServer('hal')
  check('the user\'s saved order', saved === 'n2/0 n2/1 n1/2 n1/3 n1/0 n1/1', saved)
  const fresh = screen('hal')
  fresh.net.getDown = true
  await fresh.sync.load()
  check('a new browser whose GET failed shows the default order', fresh.sync.order.length === 0)
  swap(fresh, 'n1/2', 'n1/3')
  await fresh.clock.advance(500)
  check('  its first change does not replace the saved order: done on top of it', onServer('hal') === 'n2/0 n2/1 n1/3 n1/2 n1/0 n1/1', onServer('hal'))
  check('  and the grid then shows that', shown(fresh) === 'n2/0 n2/1 n1/3 n1/2 n1/0 n1/1' && keysOf(applyOrder(base(), fresh.log.changes.at(-1))) === shown(fresh))
  const offline = screen('hal2', { storage: (() => { const st = mem(); writeLocal(st, 'hal2', { version: 5, base: ['n1/3'], ops: [] }); return st })() })
  offline.net.getDown = true
  await offline.sync.load()
  check('server unreachable at load, a copy in this browser: that copy is shown', shown(offline).startsWith('n1/3 ') && !offline.sync.unsaved)
  offline.net.getDown = false
  await offline.sync.refresh()
  check('  the next refresh shows the server\'s order (the copy only stands in while the server does not answer)', shown(offline) === keysOf(base()) && offline.log.changes.length === 1)
}

// conflicts that never end (another screen saving all the time): gives up after a few tries, keeps the change, no loop
{
  let v = 0
  let puts = 0
  const request = async (method) => {
    if (method === 'GET') return { status: 200, body: { order: [], version: 0 } }
    puts++
    return { status: 409, body: { error: 'changed elsewhere', order: [], version: ++v } }
  }
  const s = screen('ida', { net: { request } })
  await s.sync.load()
  swap(s, 'n1/0', 'n1/1')
  await s.clock.advance(500)
  check(`gives up after ${MAX_CONFLICT_TRIES} tries more, reports it`, puts === 1 + MAX_CONFLICT_TRIES && s.log.failed.length === 1 && s.sync.unsaved, String(puts))
  await s.clock.advance(60_000)
  check('  no loop', puts === 1 + MAX_CONFLICT_TRIES)
}

// Reset order
{
  const s = screen('jo')
  await s.sync.load()
  swap(s, 'n1/0', 'n1/1')
  await s.clock.advance(500)
  check('reset: the default order at once', s.sync.change({ op: 'reset' }) === true && s.sync.order.length === 0 && s.log.changes.at(-1).length === 0)
  await s.clock.advance(500)
  check('  saved as the empty order', s.net.puts.at(-1).order.length === 0 && gridOrderOf('jo').length === 0 && !s.sync.unsaved)
  check('  reset again: nothing to do', s.sync.change({ op: 'reset' }) === false)
  s.net.down = true
  swap(s, 'n1/0', 'n1/1')
  swap(s, 'n1/2', 'n1/3')
  s.sync.change({ op: 'reset' })
  check('unsaved changes then a reset: only the reset is kept to send', JSON.stringify(readLocal(s.storage, 'jo').ops) === '[{"op":"reset"}]')
}

// flush (the page is closing): a change waiting for its 500 ms goes out at once
{
  const s = screen('kit')
  await s.sync.load()
  swap(s, 'n1/0', 'n1/1')
  s.sync.flush()
  await settle()
  check('flush sends a waiting change at once', s.net.puts.length === 1 && s.clock.timers === 0 && onServer('kit') === 'n1/1 n1/0 n1/2 n1/3 n2/0 n2/1')
  s.sync.flush()
  await settle()
  check('  and nothing when nothing is waiting', s.net.puts.length === 1)
}

// a very long time without the server: the unsaved changes kept stay bounded, the order stays right
{
  const s = screen('lou')
  await s.sync.load()
  s.net.down = true
  let expected = []
  const pairs = [['n1/0', 'n1/1'], ['n1/2', 'n2/0'], ['n2/1', 'n1/0'], ['n1/3', 'n1/2']]
  for (let i = 0; i < MAX_OPS + 25; i++) {
    const [a, b] = pairs[i % pairs.length]
    expected = swapKeys(expected, a, b, base())
    swap(s, a, b)
  }
  const kept = readLocal(s.storage, 'lou').ops.length
  check(`at most ${MAX_OPS} + 1 changes kept`, kept <= MAX_OPS + 1, String(kept))
  check('  the order shown is still right', s.sync.order.join(' ') === expected.join(' '))
  await s.clock.advance(500)
  check('  (its save failed: the server is still away)', s.log.failed.length === 1 && s.sync.unsaved)
  s.net.down = false
  await s.sync.refresh()
  check('  and saved right when the server is back', gridOrderOf('lou').join(' ') === expected.join(' ') && !s.sync.unsaved, `${gridOrderOf('lou').join(' ')} | ${expected.join(' ')} | unsaved ${s.sync.unsaved} failed ${s.log.failed.map(String)}`)
}

// ---- viewer.js / index.html wiring (source scan: the viewer needs a browser) ---------------------------------------------------------------
{
  const src = readFileSync(new URL('../public/viewer.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n') // (a Windows checkout has CRLF)
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const fn = (name) => {
    const i = src.indexOf(`function ${name}(`)
    if (i < 0) return ''
    const j = src.indexOf('\n}\n', i)
    return src.slice(i, j)
  }
  check('viewer imports the order logic and the drag controller', /from '\.\/grid-order\.js'/.test(src) && /import \{ enableGridDrag \} from '\.\/grid-drag\.js'/.test(src))
  const load = src.slice(src.indexOf('async function loadCameras'))
  check('loadCameras keeps the server\'s list (default order) and shows it in the user\'s order', /serverList = fresh/.test(load) && /const list = applyOrder\(fresh, sync\.order\)/.test(load))
  check('the order is loaded before the first camera list', src.includes('const early = Promise.all([sync.load()') && src.indexOf('await early') > 0 && src.indexOf('await early') < src.indexOf('await loadCameras(prefetched)'))
  check('unsaved changes from before are sent once the camera list is known', /await loadCameras\(prefetched\)\r?\nif \(sync\.unsaved\) sync\.refresh\(\)/.test(src))
  check('the order is re-read with every camera-list refresh (30 s)', /setInterval\([\s\S]{0,120}loadCameras\(\)[\s\S]{0,240}sync\.refresh\(\)[\s\S]{0,40}30_000\)/.test(src))
  const vis = src.slice(src.indexOf("document.addEventListener('visibilitychange'"), src.indexOf("document.addEventListener('visibilitychange'") + 600)
  check('  and when the tab shows again', /sync\.refresh\(\)/.test(vis))
  const drop = fn('dropTile')
  check('a drop onto a tile swaps; onto the pager arrows moves to the page before/after', /sync\.change\(swapOp\(sync\.order, /.test(drop) && /sync\.change\(\s*moveOp\(/.test(drop) && /page \+ \(target === nextBtn \? 1 : -1\)/.test(drop))
  check('  and never rebuilds the grid (no render(): the tiles keep playing)', drop.length > 0 && !/render\(/.test(drop))
  const show = fn('showOrder')
  check('showOrder: reorders, re-lays out (no rebuild), not while the tab is hidden', /cameras = applyOrder\(serverList, sync\.order\)/.test(show) && /relayout\(\)/.test(show) && !/render\(/.test(show) && /document\.hidden/.test(show) && /gridStale = true/.test(show))
  check('  a drag under way is dropped first (the tiles are about to move)', /drag\.cancel\(\)/.test(show))
  check('the sync tells showOrder of every new order', /onChange: showOrder/.test(src))
  check('the old whole-order saver is gone', !/createSaver|pickStartOrder|setOrder\(/.test(src))
  const re = fn('relayout')
  check('relayout moves kept tiles (reuseSlots, gridArea) and closes only the ones that left', /reuseSlots\(/.test(re) && /\.style\.gridArea = /.test(re) && /live\?\.close\(\)/.test(re))
  check('relayout uses the same visible set as render', /visibleCameras\(cameras, gridView\(perPage\)\)/.test(re))
  check('drag is off while the full-size view is open', /single === null/.test(src.slice(src.indexOf('enableGridDrag(grid'), src.indexOf('enableGridDrag(grid') + 600)))
  const req = fn('orderRequest')
  check('talks to /api/me/grid-order: PUT as JSON, with a time limit', /GRID_ORDER_URL = '\/api\/me\/grid-order'/.test(src) && /'content-type': 'application\/json'/.test(req) && /AbortSignal\.timeout/.test(req) && /keepalive/.test(req))
  check('Reset order puts the default back (after asking)', /resetBtn\.addEventListener\('click'/.test(src) && /confirm\(/.test(src) && /sync\.change\(\{ op: 'reset' \}\)/.test(src))
  check('index.html: Reset order button (hidden until there is an order), a status note, the stylesheet', /<button id="resetOrder" type="button"[^>]*hidden/.test(html) && /id="orderNote"[^>]*role="status"/.test(html) && /href="grid-order\.css"/.test(html))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
