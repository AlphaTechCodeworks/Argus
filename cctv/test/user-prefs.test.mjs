// Offline tests for the per-user camera order of the live grid (user-prefs.mjs):
// GET/PUT /api/me/grid-order for any logged-in user, stored by user name in data/user-prefs.json
// (temp file + rename, mode 0600). Each save names the version it was made from; a save from a
// screen that has not seen the latest order is refused (409, with the latest order), so one
// screen can never overwrite another's change. Temp data folder only; nothing is sent anywhere.
//   node cctv/test/user-prefs.test.mjs
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-user-prefs-test-'))
const DATA = process.env.DATA_DIR
const { BODY_LIMIT, GRID_ORDER_PATH, KEY_RE, MAX_KEYS, PREFS_FILE, gridOrderOf, handleGridOrder } = await import('../user-prefs.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

/** A request as node:http gives it: a readable body with method and headers. */
const req = (method, body, headers = {}) => {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const r = Readable.from(chunks)
  r.method = method
  r.headers = { host: 'cctv.local:8443', 'content-type': 'application/json', ...headers }
  return r
}
const put = (user, body, headers) => handleGridOrder(req('PUT', body, headers), user)
const get = (user) => handleGridOrder(req('GET'), user)
const versionOf = async (user) => (await get(user))[1].version
/** A save from a screen that has the latest order (the version read just before). */
const save = async (user, order, headers) => put(user, { order, version: await versionOf(user) }, headers)
const fileJson = () => JSON.parse(readFileSync(PREFS_FILE, 'utf8'))
const keys = (n, nvr = 'nvr1') => Array.from({ length: n }, (_, i) => `${nvr}/${i}`)

// ---- the module's constants ----------------------------------------------------------------------
check('route path', GRID_ORDER_PATH === '/api/me/grid-order')
check('data/user-prefs.json in DATA_DIR', PREFS_FILE === join(DATA, 'user-prefs.json'))
check('at most 4096 keys', MAX_KEYS === 4096)
check('body limit fits 4096 of the longest keys (and not much more)', BODY_LIMIT >= 12 + MAX_KEYS * (64 + 1 + 4 + 3) && BODY_LIMIT <= 512 * 1024, String(BODY_LIMIT))
check('key pattern: "<nvr>/<ch>"', ['nvr1/0', 'nvr-2/31', 'a.b_c-D/9999', `${'x'.repeat(64)}/1`].every((k) => KEY_RE.test(k)))
check('key pattern refuses the rest', ['nvr1', 'nvr1/', '/1', 'nvr1/12345', 'nvr1/-1', 'nvr1/1.5', 'nvr 1/1', '../x/1', 'nvr1/1/2', `${'x'.repeat(65)}/1`, 'nvr1/1\n', 'nvr1/0x1'].every((k) => !KEY_RE.test(k)))

// ---- nothing saved yet ------------------------------------------------------------------------------
{
  check('no file yet', !existsSync(PREFS_FILE))
  const [status, body, headers] = await get('alice')
  check('GET with nothing saved: 200, empty order (= the default order), version 0', status === 200 && Array.isArray(body.order) && body.order.length === 0 && body.version === 0, JSON.stringify(body))
  check('  not cached by the browser', /no-store/.test(headers?.['cache-control'] ?? ''))
  check('  a GET writes nothing', !existsSync(PREFS_FILE))
}

// ---- save and read back -------------------------------------------------------------------------------
{
  const order = ['nvr-2/3', 'nvr1/0', 'nvr1/5', 'gone/7']
  const [status, body] = await put('alice', { order, version: 0 })
  check('PUT: 200, the order as saved and its new version', status === 200 && JSON.stringify(body.order) === JSON.stringify(order) && body.version === 1, JSON.stringify(body))
  check('  file written, keyed by the session user', JSON.stringify(fileJson().alice?.gridOrder) === JSON.stringify(order), readFileSync(PREFS_FILE, 'utf8'))
  if (process.platform !== 'win32') check('  mode 0600', (statSync(PREFS_FILE).mode & 0o777) === 0o600, (statSync(PREFS_FILE).mode & 0o777).toString(8))
  check('  no temp file left behind', readdirSync(DATA).every((f) => !f.includes('.tmp')), readdirSync(DATA).join())
  const [s2, b2] = await get('alice')
  check('GET returns it, with its version', s2 === 200 && JSON.stringify(b2.order) === JSON.stringify(order) && b2.version === 1)
  check('gridOrderOf(user) the same', JSON.stringify(gridOrderOf('alice')) === JSON.stringify(order))
  const ino = statSync(PREFS_FILE).ino
  await save('alice', ['nvr1/0'])
  if (process.platform !== 'win32') check('a new save replaces the file (temp + rename), never rewrites it in place', statSync(PREFS_FILE).ino !== ino)
  check('  and holds the new order', JSON.stringify(gridOrderOf('alice')) === '["nvr1/0"]')
}

// ---- each user their own order --------------------------------------------------------------------------
{
  await save('alice', ['nvr1/1', 'nvr1/0'])
  await save('bob', ['nvr1/0', 'nvr1/1'])
  check('two users, two orders', JSON.stringify(gridOrderOf('alice')) === '["nvr1/1","nvr1/0"]' && JSON.stringify(gridOrderOf('bob')) === '["nvr1/0","nvr1/1"]')
  const [s] = await put('bob', { user: 'alice', order: ['nvr9/9'], version: await versionOf('bob') })
  check('a user name in the body is refused (400) ...', s === 400)
  check('  ... and changes nobody\'s order', JSON.stringify(gridOrderOf('alice')) === '["nvr1/1","nvr1/0"]' && JSON.stringify(gridOrderOf('bob')) === '["nvr1/0","nvr1/1"]')
  check('  each user their own version', (await versionOf('alice')) === 3 && (await versionOf('bob')) === 1 && (await versionOf('nobody')) === 0)
  const both = await Promise.all([put('carol', { order: ['nvr1/2'], version: 0 }), put('dave', { order: ['nvr1/3'], version: 0 })])
  check('two saves at once (different users): both kept', both.every(([st]) => st === 200) && gridOrderOf('carol')[0] === 'nvr1/2' && gridOrderOf('dave')[0] === 'nvr1/3')
  check('  the others untouched', gridOrderOf('alice').length === 2 && gridOrderOf('bob').length === 2)
  const [s0, b0] = await save('carol', [])
  check('empty order (reset): 200, and GET gives the default again', s0 === 200 && b0.order.length === 0 && gridOrderOf('carol').length === 0)
  check('  the order is dropped from the file (its version stays)', fileJson().carol?.gridOrder === undefined && fileJson().carol?.gridOrderVersion === 2 && Object.hasOwn(fileJson(), 'dave'), JSON.stringify(fileJson().carol))
}

// ---- versions: a save from a screen that has not seen the latest order is refused --------------------------
{
  // the same user on two screens (a desk PC and a wall monitor), both read version 0
  const [, first] = await get('ivan')
  const [sDesk, bDesk] = await put('ivan', { order: ['nvr1/1', 'nvr1/0'], version: first.version })
  check('desk saves from version 0: 200, version 1', sDesk === 200 && bDesk.version === 1)
  const [sWall, bWall] = await put('ivan', { order: ['nvr1/0', 'nvr1/1', 'nvr1/3', 'nvr1/2'], version: first.version })
  check('wall saves from version 0 too (it never saw the desk\'s change): 409', sWall === 409 && typeof bWall.error === 'string', `${sWall} ${JSON.stringify(bWall)}`)
  check('  the answer holds the latest order and its version (to redo the change on)', JSON.stringify(bWall.order) === '["nvr1/1","nvr1/0"]' && bWall.version === 1)
  check('  the desk\'s change is kept', JSON.stringify(gridOrderOf('ivan')) === '["nvr1/1","nvr1/0"]' && (await versionOf('ivan')) === 1)
  const [sRedo, bRedo] = await put('ivan', { order: ['nvr1/1', 'nvr1/0', 'nvr1/3', 'nvr1/2'], version: bWall.version })
  check('the wall redoes its change on the latest order: 200, version 2', sRedo === 200 && bRedo.version === 2 && JSON.stringify(gridOrderOf('ivan')) === '["nvr1/1","nvr1/0","nvr1/3","nvr1/2"]')
  const [sAhead] = await put('ivan', { order: ['nvr1/0'], version: 7 })
  check('a version the server never gave: 409', sAhead === 409 && (await versionOf('ivan')) === 2)
  // a reset does not start the count again (else an old screen's version could match again)
  const [sReset, bReset] = await put('ivan', { order: [], version: 2 })
  check('reset: 200, version 3', sReset === 200 && bReset.version === 3 && gridOrderOf('ivan').length === 0)
  const [sOld] = await put('ivan', { order: ['nvr1/5'], version: 2 })
  check('  a screen that saw version 2 cannot undo the reset', sOld === 409 && gridOrderOf('ivan').length === 0)
  const [sZero] = await put('ivan', { order: ['nvr1/5'], version: 0 })
  check('  nor one that never saw any version', sZero === 409 && gridOrderOf('ivan').length === 0)
  const [sNext, bNext] = await put('ivan', { order: ['nvr1/5'], version: 3 })
  check('  the next save goes on counting', sNext === 200 && bNext.version === 4)
  // two screens saving at the same moment from the same version: one wins, the other is told
  const two = await Promise.all([put('ivan', { order: ['nvr1/6'], version: 4 }), put('ivan', { order: ['nvr1/7'], version: 4 })])
  const codes = two.map(([st]) => st).sort().join()
  check('two saves at once from the same version: one 200, one 409', codes === '200,409', codes)
  const winner = two.find(([st]) => st === 200)[1].order[0]
  check('  the saved one is the winner\'s, version 5', gridOrderOf('ivan')[0] === winner && (await versionOf('ivan')) === 5)
  const before = readFileSync(PREFS_FILE, 'utf8')
  const bad = async (name, version) => {
    const body = version === undefined ? { order: ['nvr1/1'] } : { order: ['nvr1/1'], version }
    const [st, b] = await put('ivan', body)
    check(name, st === 400 && typeof b.error === 'string', `${st} ${JSON.stringify(b)}`)
  }
  await bad('no version: 400 (a save must say which order it changed)')
  await bad('version null: 400', null)
  await bad('version as text: 400', '5')
  await bad('version -1: 400', -1)
  await bad('version 1.5: 400', 1.5)
  await bad('version too big: 400', 2 ** 53)
  check('  refused saves change nothing', readFileSync(PREFS_FILE, 'utf8') === before)
  // files from before versions, and damaged versions, count as version 0
  const all = fileJson()
  writeFileSync(PREFS_FILE, JSON.stringify({ ...all, old: { gridOrder: ['nvr1/2'] }, odd: { gridOrder: ['nvr1/3'], gridOrderVersion: 'x' }, neg: { gridOrderVersion: -4 } }), { mode: 0o600 })
  const [, gOld] = await get('old')
  check('an order saved without a version: version 0', gOld.version === 0 && gOld.order[0] === 'nvr1/2')
  check('  a damaged version: 0', (await versionOf('odd')) === 0 && (await versionOf('neg')) === 0)
  const [sOld0, bOld0] = await put('old', { order: ['nvr1/9'], version: 0 })
  check('  and the next save from it: version 1', sOld0 === 200 && bOld0.version === 1)
}

// ---- odd user names can't reach other data -------------------------------------------------------------
{
  const [s] = await save('__proto__', ['nvr1/4'])
  check('user "__proto__": saved as a plain entry', s === 200 && JSON.stringify(gridOrderOf('__proto__')) === '["nvr1/4"]')
  check('  no prototype pollution', ({}).gridOrder === undefined && Object.prototype.gridOrder === undefined)
  check('  other users unaffected; "constructor" has no order', gridOrderOf('alice').length === 2 && gridOrderOf('constructor').length === 0 && gridOrderOf('toString').length === 0)
  const [s401] = await handleGridOrder(req('GET'), '')
  check('no user: 401', s401 === 401)
}

// ---- validation -------------------------------------------------------------------------------------------
{
  const before = readFileSync(PREFS_FILE, 'utf8')
  const version = await versionOf('alice')
  const refused = async (name, body, status = 400, headers) => {
    const [s, b] = await put('alice', body, headers)
    check(name, s === status && typeof b.error === 'string', `${s} ${JSON.stringify(b)}`)
  }
  await refused('a bad key: 400', { order: ['nvr1/0', '../etc/1'], version })
  await refused('a channel too long: 400', { order: ['nvr1/12345'], version })
  await refused('an NVR id too long: 400', { order: [`${'x'.repeat(65)}/1`], version })
  await refused('a number instead of a key: 400', { order: [3], version })
  await refused('null in the list: 400', { order: [null], version })
  await refused('order not a list: 400', { order: 'nvr1/0', version })
  await refused('order missing: 400', { version })
  await refused('an unknown field: 400', { order: [], version, extra: 1 })
  await refused('more than 4096 keys: 400', { order: keys(MAX_KEYS + 1), version })
  await refused('not JSON: 400', '{order:')
  await refused('a JSON list as the body: 400', ['nvr1/0'])
  await refused('JSON null: 400', 'null')
  await refused('empty body: 400', '')
  check('refused saves change nothing', readFileSync(PREFS_FILE, 'utf8') === before && (await versionOf('alice')) === version)
  const [s4096] = await save('erin', keys(MAX_KEYS))
  check('exactly 4096 keys: saved', s4096 === 200 && gridOrderOf('erin').length === MAX_KEYS)
  const [sd, bd] = await save('erin', ['nvr1/1', 'nvr1/2', 'nvr1/1'])
  check('repeated keys: kept once, first place wins', sd === 200 && JSON.stringify(bd.order) === '["nvr1/1","nvr1/2"]')
}

// ---- the same checks as the other writes: same origin, JSON ------------------------------------------------
{
  const s = async (headers) => (await save('frank', ['nvr1/0'], headers))[0]
  check('another site\'s Origin: 403', (await s({ origin: 'https://evil.example' })) === 403)
  check('Origin "null": 403', (await s({ origin: 'null' })) === 403)
  check('Origin with another port: 403', (await s({ origin: 'https://cctv.local:9999' })) === 403)
  check('text/plain (a cross-site form can send that): 403', (await s({ 'content-type': 'text/plain' })) === 403)
  check('no content type: 403', (await s({ 'content-type': '' })) === 403)
  check('nothing saved by the refused requests', gridOrderOf('frank').length === 0)
  check('same Origin, application/json; charset=utf-8: 200', (await s({ origin: 'https://cctv.local:8443', 'content-type': 'application/json; charset=utf-8' })) === 200)
  check('no Origin (same-origin GET-style tools): 200', (await s({})) === 200)
  const [g] = await handleGridOrder(req('GET', undefined, { origin: 'https://evil.example', 'content-type': '' }), 'frank')
  check('GET needs neither (read only)', g === 200)
  for (const m of ['POST', 'DELETE', 'PATCH']) {
    const [st, , h] = await handleGridOrder(req(m, { order: [] }), 'frank')
    check(`${m}: 405, Allow: GET, PUT`, st === 405 && h?.allow === 'GET, PUT')
  }
}

// ---- body size -------------------------------------------------------------------------------------------------
{
  const big = JSON.stringify({ order: ['nvr1/0'], pad: 'x'.repeat(BODY_LIMIT) })
  const [s1, , h1] = await put('gina', big, { 'content-length': String(big.length) })
  check('declared length over the limit: 413 without reading', s1 === 413 && h1?.connection === 'close')
  const [s2] = await put('gina', big)
  check('streamed body over the limit (no length given): 413', s2 === 413)
  check('  nothing saved', gridOrderOf('gina').length === 0)
}

// ---- a damaged file ----------------------------------------------------------------------------------------------
{
  // a damaged file must not wipe everyone's orders: GET and PUT refuse (500: the pages keep
  // their own copies and try again later) and the file is left exactly as it is
  const damaged = '{"alice": {"gridOrder": ["nvr1/0"'
  writeFileSync(PREFS_FILE, damaged, { mode: 0o600 })
  const [s, b] = await get('alice')
  check('damaged file: GET refuses (500, not an empty order that would replace the page copy)', s === 500 && !('order' in b), JSON.stringify([s, b]))
  const [s2] = await put('alice', { order: ['nvr1/7'], version: 0 })
  check('  a save is refused (500) and the damaged file is not overwritten', s2 === 500 && readFileSync(PREFS_FILE, 'utf8') === damaged)
  check('  gridOrderOf does not throw ([])', gridOrderOf('alice').length === 0)
  // good file again (e.g. restored from the .bak by hand): back to normal
  writeFileSync(PREFS_FILE, JSON.stringify({ alice: { gridOrder: ['nvr1/0', 'bad key', 5, 'nvr1/1'] }, bob: 'x' }), { mode: 0o600 })
  check('bad entries in the file are left out on read', JSON.stringify(gridOrderOf('alice')) === '["nvr1/0","nvr1/1"]' && gridOrderOf('bob').length === 0)
  // every save keeps the previous good file as user-prefs.json.bak
  const before = readFileSync(PREFS_FILE, 'utf8')
  const [s3] = await put('carol', { order: ['nvr2/1'], version: 0 })
  check('a save keeps the previous file as user-prefs.json.bak (mode 0600 on POSIX)', s3 === 200 && readFileSync(`${PREFS_FILE}.bak`, 'utf8') === before && (process.platform === 'win32' || (statSync(`${PREFS_FILE}.bak`).mode & 0o777) === 0o600))
  check('  and the new file has everyone', fileJson().carol.gridOrder[0] === 'nvr2/1' && fileJson().alice.gridOrder.length === 4)
}
{
  // unreadable (not missing): a read error other than ENOENT (here: a folder in its place)
  const { renameSync, mkdirSync, rmSync } = await import('node:fs')
  renameSync(PREFS_FILE, `${PREFS_FILE}.keep`)
  mkdirSync(PREFS_FILE)
  const [s] = await get('alice')
  const [s2] = await put('alice', { order: ['nvr1/9'], version: 1 })
  check('unreadable file: GET and PUT refuse (500), nothing written', s === 500 && s2 === 500 && statSync(PREFS_FILE).isDirectory())
  rmSync(PREFS_FILE, { recursive: true })
  renameSync(`${PREFS_FILE}.keep`, PREFS_FILE)
  const [s3] = await get('alice')
  check('  readable again: GET works', s3 === 200)
}

// ---- over real HTTP (node:http), as server.mjs calls it ----------------------------------------------------------
{
  const srv = createServer(async (rq, rs) => {
    const [status, body, headers = {}] = await handleGridOrder(rq, 'henry')
    rs.writeHead(status, { 'content-type': 'application/json', ...headers })
    rs.end(JSON.stringify(body))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const call = (method, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const q = request({ host: '127.0.0.1', port, method, path: GRID_ORDER_PATH, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
      })
      q.on('error', (e) => resolve({ status: 0, error: e.code }))
      if (body !== undefined) q.write(body)
      q.end()
    })
  // the longest keys there can be: a 64-character NVR id and 4-digit channels
  const order = Array.from({ length: MAX_KEYS }, (_, i) => `${'n'.repeat(64)}/${1000 + i}`)
  const r1 = await call('PUT', JSON.stringify({ order, version: 0 }))
  check('HTTP: a full-size order (4096 long keys) is accepted', r1.status === 200 && r1.body.order.length === MAX_KEYS, `${r1.status} ${JSON.stringify(r1.body)?.slice(0, 80)}`)
  check('  (and fits the body limit with the version, 409 answers too)', JSON.stringify({ order, version: Number.MAX_SAFE_INTEGER }).length <= BODY_LIMIT)
  const r2 = await call('GET')
  check('HTTP: and read back', r2.status === 200 && r2.body.order.length === MAX_KEYS && r2.body.order[5] === order[5] && r2.body.version === 1)
  const r2b = await call('PUT', JSON.stringify({ order: ['nvr1/0'], version: 0 }))
  check('HTTP: a save from an old version: 409 with the latest order', r2b.status === 409 && r2b.body.version === 1 && r2b.body.order.length === MAX_KEYS)
  const r3 = await call('PUT', 'x'.repeat(BODY_LIMIT + 10))
  check('HTTP: an oversized body gets 413 (the server stays up)', r3.status === 413 || r3.error === 'ECONNRESET' || r3.error === 'EPIPE', JSON.stringify(r3))
  const r4 = await call('GET')
  check('HTTP: the server still answers after that', r4.status === 200)
  srv.close()
}

// ---- server.mjs: only a hook, for logged-in users, before the admin routes -----------------------------------------
{
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  check('server.mjs imports the module', /import \{[^}]*handleGridOrder[^}]*\} from '\.\/user-prefs\.mjs'/.test(src))
  const hook = src.search(/if \(pathname === GRID_ORDER_PATH\) return sendJson\(res, \.\.\.\(await handleGridOrder\(req, user\)\)\)/)
  check('server.mjs dispatches the route with the session user', hook > 0)
  check('  after the login check', hook > src.indexOf('const user = currentUser(req)') && hook > src.indexOf("if (!user) {"))
  check('  before the admin-only routes (any logged-in user may use it)', hook < src.indexOf("if (pathname.startsWith('/api/admin/'))"))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
