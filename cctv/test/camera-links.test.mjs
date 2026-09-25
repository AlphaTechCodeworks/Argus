// Offline tests for which camera adjoins which (camera-links.mjs): validation, two-way and one-way
// links, the version check that stops two admins overwriting each other, links to a camera that has
// been removed being left out of the answer, and the nearest-neighbour suggestions from the site map.
// Temp data folder only; no NVR, no network, nothing is sent anywhere.
//   node cctv/test/camera-links.test.mjs
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-camera-links-test-'))
const DATA = process.env.DATA_DIR
const {
  ADMIN_LINKS_PATH,
  LINKS_FILE,
  LINKS_PATH,
  MAX_LABEL,
  MAX_NEIGHBOURS,
  SUGGEST_COUNT,
  addLink,
  cleanLinks,
  handleCameraLinks,
  neighboursOf,
  readLinks,
  removeLink,
  saveLinks,
  suggestNeighbours
} = await import('../camera-links.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const threw = (fn) => {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}
const known = (...keys) => new Set(keys)
const CAMS = known('nvr1/0', 'nvr1/1', 'nvr1/2', 'nvr2/0')
const cameraList = () => [...CAMS].map((k) => ({ nvr: k.split('/')[0], ch: Number(k.split('/')[1]) }))
const to = (links, key) => neighboursOf(links, key).map((n) => n.to)
const reset = () => {
  if (existsSync(LINKS_FILE)) writeFileSync(LINKS_FILE, '')
}

// ---- constants -------------------------------------------------------------------------------------
check('read path', LINKS_PATH === '/api/camera-links')
check('admin path', ADMIN_LINKS_PATH === '/api/admin/camera-links')
check('data/camera-links.json in DATA_DIR', LINKS_FILE === join(DATA, 'camera-links.json'))

// ---- validation ------------------------------------------------------------------------------------
{
  check('a link to a camera that does not exist is refused', /no camera nvr9\/0/.test(threw(() => cleanLinks({ 'nvr1/0': [{ to: 'nvr9/0', label: '' }] }, CAMS))?.message ?? ''))
  check('a camera key that is not "<nvr>/<ch>" is refused', Boolean(threw(() => cleanLinks({ 'nvr1': [{ to: 'nvr1/1', label: '' }] }, CAMS))))
  check('a self-link is refused', /cannot lead to itself/.test(threw(() => cleanLinks({ 'nvr1/0': [{ to: 'nvr1/0', label: '' }] }, CAMS))?.message ?? ''))
  check('  and through addLink too', /cannot lead to itself/.test(threw(() => addLink({}, { from: 'nvr1/0', to: 'nvr1/0' }, CAMS))?.message ?? ''))
  check('the same neighbour twice is refused', /twice/.test(threw(() => cleanLinks({ 'nvr1/0': [{ to: 'nvr1/1', label: 'a' }, { to: 'nvr1/1', label: 'b' }] }, CAMS))?.message ?? ''))
  const long = 'x'.repeat(MAX_LABEL + 1)
  check(`a label longer than ${MAX_LABEL} characters is refused`, /longer than/.test(threw(() => cleanLinks({ 'nvr1/0': [{ to: 'nvr1/1', label: long }] }, CAMS))?.message ?? ''))
  check(`  exactly ${MAX_LABEL} is fine`, cleanLinks({ 'nvr1/0': [{ to: 'nvr1/1', label: 'x'.repeat(MAX_LABEL) }] }, CAMS)['nvr1/0'][0].label.length === MAX_LABEL)
  const many = { 'nvr1/0': Array.from({ length: MAX_NEIGHBOURS + 1 }, (_, i) => ({ to: `nvr5/${i}`, label: '' })) }
  check(`more than ${MAX_NEIGHBOURS} neighbours is refused`, /more than/.test(threw(() => cleanLinks(many))?.message ?? ''))
  check('an unknown field on a neighbour is refused', /Unknown field/.test(threw(() => cleanLinks({ 'nvr1/0': [{ to: 'nvr1/1', label: '', suggested: true }] }, CAMS))?.message ?? ''))
  check('a label is tidied (newlines and padding would break the strip)', cleanLinks({ 'nvr1/0': [{ to: 'nvr1/1', label: '  through the\n front door ' }] }, CAMS)['nvr1/0'][0].label === 'through the front door')
  check('links are sorted, so the same links always give the same file', JSON.stringify(cleanLinks({ 'nvr1/1': [{ to: 'nvr2/0' }], 'nvr1/0': [{ to: 'nvr1/2' }, { to: 'nvr1/1' }] }, CAMS)) === JSON.stringify({ 'nvr1/0': [{ to: 'nvr1/1', label: '' }, { to: 'nvr1/2', label: '' }], 'nvr1/1': [{ to: 'nvr2/0', label: '' }] }))
}

// ---- two-way by default ----------------------------------------------------------------------------
{
  const links = addLink({}, { from: 'nvr1/0', to: 'nvr1/1', label: 'through the front door' }, CAMS)
  check('a link is two-way by default: the yard leads to the gate', to(links, 'nvr1/0').join() === 'nvr1/1')
  check('  and the gate leads back', to(links, 'nvr1/1').join() === 'nvr1/0')
  check('  with the same label both ways (it names the doorway, not a direction)', neighboursOf(links, 'nvr1/1')[0].label === 'through the front door')

  const more = addLink(links, { from: 'nvr1/0', to: 'nvr2/0', label: 'into the yard' }, CAMS)
  check('a second neighbour joins the first', to(more, 'nvr1/0').join() === 'nvr1/1,nvr2/0')

  const gone = removeLink(more, { from: 'nvr1/0', to: 'nvr1/1' })
  check('removing a link removes both directions', to(gone, 'nvr1/0').join() === 'nvr2/0' && to(gone, 'nvr1/1').length === 0)
  check('  a camera with no neighbours left is not kept as an empty list', !('nvr1/1' in gone))

  const relabelled = addLink(more, { from: 'nvr1/0', to: 'nvr1/1', label: 'through the side gate' }, CAMS)
  check('linking the same pair again relabels it rather than duplicating', to(relabelled, 'nvr1/0').join() === 'nvr1/1,nvr2/0' && neighboursOf(relabelled, 'nvr1/0')[0].label === 'through the side gate')
  check('the links passed in are never changed (a refused save must leave the caller as it was)', to(links, 'nvr1/0').join() === 'nvr1/1')
}

// ---- one-way ---------------------------------------------------------------------------------------
{
  const links = addLink({}, { from: 'nvr1/0', to: 'nvr1/1', label: 'down the stairwell', oneWay: true }, CAMS)
  check('a one-way link leads only one way (a stairwell you can only come down)', to(links, 'nvr1/0').join() === 'nvr1/1' && !('nvr1/1' in links))
  const both = addLink(links, { from: 'nvr1/1', to: 'nvr1/0', label: 'up the stairs' }, CAMS)
  check('  a later two-way link fills the other direction in', to(both, 'nvr1/1').join() === 'nvr1/0')
  const half = removeLink(both, { from: 'nvr1/1', to: 'nvr1/0', oneWay: true })
  check('  and one direction can be taken away on its own', to(half, 'nvr1/0').join() === 'nvr1/1' && !('nvr1/1' in half))
}

// ---- the file and the version check ----------------------------------------------------------------
{
  check('no file yet', !existsSync(LINKS_FILE))
  const first = readLinks(CAMS)
  check('nothing saved yet: no links, version 0', Object.keys(first.links).length === 0 && first.version === 0)

  const a = saveLinks(addLink({}, { from: 'nvr1/0', to: 'nvr1/1', label: 'through the front door' }, CAMS), 0, CAMS)
  check('the first save is accepted and becomes version 1', a.saved && a.version === 1)
  check('  the file is the operator-readable shape { version, links }', JSON.parse(readFileSync(LINKS_FILE, 'utf8')).version === 1)
  if (process.platform !== 'win32') check('  and is not world-readable', (statSync(LINKS_FILE).mode & 0o077) === 0)

  const stale = saveLinks(addLink({}, { from: 'nvr1/0', to: 'nvr2/0', label: 'into the yard' }, CAMS), 0, CAMS)
  check('a save made on an old version is refused', !stale.saved && stale.version === 1)
  check('  and answers with the latest links, for the page to redo its change on', to(stale.links, 'nvr1/0').join() === 'nvr1/1')
  check('  nothing was written', readLinks(CAMS).version === 1 && to(readLinks(CAMS).links, 'nvr1/0').join() === 'nvr1/1')

  const redone = saveLinks(addLink(stale.links, { from: 'nvr1/0', to: 'nvr2/0', label: 'into the yard' }, CAMS), stale.version, CAMS)
  check('the same change made on the latest version is accepted', redone.saved && redone.version === 2 && to(redone.links, 'nvr1/0').join() === 'nvr1/1,nvr2/0')
  check('the previous file is kept as .bak', existsSync(`${LINKS_FILE}.bak`))
}

// ---- a camera that has been removed ----------------------------------------------------------------
{
  const left = known('nvr1/0', 'nvr1/1') // nvr2 has been taken out of the system
  const seen = readLinks(left)
  check('links to a camera that no longer exists are left out of the answer', to(seen.links, 'nvr1/0').join() === 'nvr1/1')
  check('  and the camera itself is gone from the list', !('nvr2/0' in seen.links))
  check('  but they are still in the file, so putting the camera back brings them back', /nvr2\/0/.test(readFileSync(LINKS_FILE, 'utf8')))
  check('  and reading with every camera present shows them again', to(readLinks(CAMS).links, 'nvr1/0').join() === 'nvr1/1,nvr2/0')
}

// ---- damaged single entries ------------------------------------------------------------------------
{
  const messy = { 'nvr1/0': [{ to: 'nvr1/1', label: 'ok' }, { to: 'not a key' }, 'rubbish'], 'also rubbish': [{ to: 'nvr1/1' }] }
  const kept = cleanLinks(messy, CAMS, { drop: true })
  check('reading drops damaged entries rather than failing the whole file', to(kept, 'nvr1/0').join() === 'nvr1/1' && Object.keys(kept).length === 1)
  check('  writing the same thing is refused instead (a page must not save rubbish quietly)', Boolean(threw(() => cleanLinks(messy, CAMS))))
}

// ---- suggestions -----------------------------------------------------------------------------------
{
  // a plan map: 0 at the origin, then 1, 2, 3 going away from it
  const map = {
    mode: 'plan',
    plan: { file: 'x.jpg', w: 1000, h: 1000, cams: { 'nvr1/0': { x: 0, y: 0 }, 'nvr1/1': { x: 10, y: 0 }, 'nvr1/2': { x: 40, y: 0 }, 'nvr2/0': { x: 100, y: 0 } } }
  }
  const s = suggestNeighbours(map, {}, { count: 2 })
  check('suggestions are the nearest cameras first', s['nvr1/0'].map((n) => n.to).join() === 'nvr1/1,nvr1/2')
  check('  with the distance, so the page can say how far', s['nvr1/0'][0].distance === 10 && s['nvr1/0'][0].units === 'plan pixels')
  check('  count is respected', s['nvr1/0'].length === 2)
  check('  they are offered from each camera, not just the first', s['nvr2/0'].map((n) => n.to).join() === 'nvr1/2,nvr1/1')
  check('every suggestion says it is a guess, in the data itself', Object.values(s).flat().every((n) => n.suggested === true && typeof n.why === 'string' && n.why && n.label === ''))
  const drawn = { 'nvr1/0': [{ to: 'nvr1/1', label: 'through the front door' }] }
  check('a pair already drawn is not offered again', suggestNeighbours(map, drawn, { count: 2 })['nvr1/0'].map((n) => n.to).join() === 'nvr1/2,nvr2/0')
  check('a camera that no longer exists is not suggested', suggestNeighbours(map, {}, { count: 4, known: known('nvr1/0', 'nvr1/2') })['nvr1/0'].map((n) => n.to).join() === 'nvr1/2')
  check('a map with one camera suggests nothing', Object.keys(suggestNeighbours({ mode: 'plan', plan: { cams: { 'nvr1/0': { x: 1, y: 1 } } } })).length === 0)
  check('no map, no suggestions', Object.keys(suggestNeighbours(undefined)).length === 0)
  check('the default count is a few, not the whole site', SUGGEST_COUNT >= 2 && SUGGEST_COUNT <= 6, String(SUGGEST_COUNT))

  // a street/satellite map: distances in metres, so a tie-break on latitude works out the same way
  const geo = { mode: 'geo', geo: { lat: 51.5, lng: -0.1, zoom: 18, layer: 'street', cams: { 'nvr1/0': { lat: 51.5, lng: -0.1 }, 'nvr1/1': { lat: 51.5001, lng: -0.1 }, 'nvr1/2': { lat: 51.51, lng: -0.1 } } } }
  const g = suggestNeighbours(geo, {}, { count: 2 })
  check('on a street map the nearest is nearest and the distance is in metres', g['nvr1/0'].map((n) => n.to).join() === 'nvr1/1,nvr1/2' && g['nvr1/0'][0].units === 'metres' && Math.abs(g['nvr1/0'][0].distance - 11) <= 2, String(g['nvr1/0'][0].distance))
}

// ---- the routes ------------------------------------------------------------------------------------
{
  const maps = () => ({ sites: { Yard: { mode: 'plan', plan: { file: 'x.jpg', w: 100, h: 100, cams: { 'nvr1/0': { x: 0, y: 0 }, 'nvr1/2': { x: 5, y: 0 } } } } } })
  const ctx = (admin) => ({ admin, cameras: cameraList, maps })
  const call = (method, path, body, admin = false) => handleCameraLinks(method, path, async () => body, ctx(admin))

  check('a path that is not ours is not handled', (await call('GET', '/api/something-else')) === null)
  const [status, body, headers] = await call('GET', LINKS_PATH)
  check('GET answers the links, the version and the suggestions', status === 200 && body.version === 2 && to(body.links, 'nvr1/0').join() === 'nvr1/1,nvr2/0', JSON.stringify(body))
  check('  and is not cached by the browser', /no-store/.test(headers?.['cache-control'] ?? ''))
  check('  the suggestions are a separate field, never mixed in with the links', Array.isArray(body.suggestions['nvr1/0']) && body.suggestions['nvr1/0'].every((n) => n.suggested === true) && Object.values(body.links).flat().every((n) => n.suggested === undefined))
  check('  a pair already linked is not suggested', !body.suggestions['nvr1/0']?.some((n) => n.to === 'nvr1/1'))

  const [notAdmin] = await call('PUT', ADMIN_LINKS_PATH, { links: {}, version: body.version })
  check('a write by someone who is not an admin is refused', notAdmin === 403)
  const [noVersion] = await call('PUT', ADMIN_LINKS_PATH, { links: {} }, true)
  check('a write without a version is refused (it could not have been made on the latest)', noVersion === 400)
  const [bad] = await call('PUT', ADMIN_LINKS_PATH, { links: { 'nvr1/0': [{ to: 'nvr9/9' }] }, version: body.version }, true)
  check('a write naming a camera that does not exist is refused', bad === 400)

  const [ok, put] = await call('POST', ADMIN_LINKS_PATH, { action: 'link', from: 'nvr1/1', to: 'nvr1/2', label: 'through the back door', version: body.version }, true)
  check('POST link adds one link, both ways, and moves the version on', ok === 200 && put.version === body.version + 1 && to(put.links, 'nvr1/2').join() === 'nvr1/1')
  const [stale, staleBody] = await call('POST', ADMIN_LINKS_PATH, { action: 'link', from: 'nvr1/0', to: 'nvr1/2', version: body.version }, true)
  check('a second admin saving on the version they read gets 409, not a silent overwrite', stale === 409 && staleBody.version === put.version && to(staleBody.links, 'nvr1/2').join() === 'nvr1/1')
  const [gone, after] = await call('POST', ADMIN_LINKS_PATH, { action: 'unlink', from: 'nvr1/1', to: 'nvr1/2', version: put.version }, true)
  check('POST unlink takes it away again', gone === 200 && !('nvr1/2' in after.links))
  const [badAction] = await call('POST', ADMIN_LINKS_PATH, { action: 'nonsense', version: after.version }, true)
  check('an unknown action is refused', badAction === 400)
  const [method] = await call('DELETE', ADMIN_LINKS_PATH, {}, true)
  check('an unsupported method is refused', method === 405)
  const [readOnly] = await call('PUT', LINKS_PATH, {})
  check('the read path takes no writes', readOnly === 405)
}

// ---- a damaged file is never read as "no links" -----------------------------------------------------
{
  writeFileSync(LINKS_FILE, '{ this is not json')
  const e = threw(() => readLinks(CAMS))
  check('a damaged file throws rather than answering "no links"', Boolean(e))
  const [status] = await handleCameraLinks('GET', LINKS_PATH, async () => ({}), { cameras: cameraList })
  check('  and GET answers 500, so no page replaces its own copy with nothing', status === 500)
  const [write] = await handleCameraLinks('PUT', ADMIN_LINKS_PATH, async () => ({ links: {}, version: 0 }), { admin: true, cameras: cameraList })
  check('  a write is refused too, so the links cannot be wiped', write === 500)
}

// ---- server.mjs wiring ------------------------------------------------------------------------------
{
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  check('server.mjs imports the module', /from '\.\/camera-links\.mjs'/.test(src))
  const read = src.indexOf('if (pathname === LINKS_PATH)')
  const write = src.indexOf('if (pathname === ADMIN_LINKS_PATH)')
  check('server.mjs dispatches the read route', read > 0)
  check('  after the login check (everyone signed in, so the follow strip works for viewers)', read > src.indexOf('const user = currentUser(req)'))
  check('  before the admin-only routes', read < src.indexOf("if (pathname.startsWith('/api/admin/'))"))
  check('server.mjs dispatches the write route inside the admin block', write > src.indexOf("if (pathname.startsWith('/api/admin/'))"))
}

// ---- the map editor -----------------------------------------------------------------------------
{
  const js = readFileSync(new URL('../public/map.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../public/map.html', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')
  check('the map page has an Edit links button', /id="links"/.test(html))
  check('the editor reads and writes the links API', /'\/api\/camera-links'/.test(js) && /'\/api\/admin\/camera-links'/.test(js))
  check('it sends the version it read, so it cannot overwrite another admin', /version: linkData\.version/.test(js))
  check('  and redoes its change on theirs after a 409', /res\.status === 409/.test(js))
  check('picking a camera then clicking another draws the link', /clickedInLinkMode/.test(js) && /action: 'link'/.test(js))
  check('a one-way link can be drawn', /oneWay: newOneWay/.test(js))
  check('suggestions are drawn dashed and never as drawn links', /class: 'map-link suggested'/.test(js) && /\.map-link\.suggested \{[^}]*dasharray/.test(css))
  check('  and are labelled a guess in the panel', /map-guess-tag/.test(js) && /guesses/.test(js))
  check('nothing suggested is saved until a person adds it', /textContent: 'Add link'/.test(js))
}

reset()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
