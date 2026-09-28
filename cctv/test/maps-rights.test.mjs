// Which maps a user is shown (maps.mjs handleMapsRead with a rights view). A map is where each
// camera is and what it covers, so its blind spots too: a viewer limited to one site used to get
// every site's placements and every floor plan. Pure: a temp data folder, no NVR, no SDK.
//   node cctv/test/maps-rights.test.mjs
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const DATA = mkdtempSync(join(tmpdir(), 'cctv-maps-rights-'))
process.env.DATA_DIR = DATA // maps.mjs reads it when first imported
const cone = (x, y) => ({ x, y, dir: 0, fov: 90, range: 10 })
const PLAN_A = 'aaaaaaaaaaaaaaaa.jpg'
const PLAN_B = 'bbbbbbbbbbbbbbbb.jpg'
writeFileSync(join(DATA, 'maps.json'), JSON.stringify({
  sites: {
    'IT Office': { mode: 'plan', plan: { file: PLAN_A, w: 100, h: 100, cams: { 'solus/0': cone(1, 1), 'nvr1/3': cone(2, 2) } }, geo: { lat: 1, lng: 2, zoom: 3, layer: 'street', cams: { 'solus/0': { lat: 1, lng: 2, dir: 0, fov: 90, range: 10 }, 'nvr1/3': { lat: 1, lng: 2, dir: 0, fov: 90, range: 10 } } } },
    'Main site': { mode: 'plan', plan: { file: PLAN_B, w: 100, h: 100, cams: { 'nvr1/0': cone(3, 3) } } }
  }
}))
mkdirSync(join(DATA, 'maps'), { recursive: true })
for (const f of [PLAN_A, PLAN_B]) writeFileSync(join(DATA, 'maps', f), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))

const { handleMapsRead } = await import('../maps.mjs')

/** One request through handleMapsRead: the status and, for JSON, the body. */
const get = (pathname, view) => {
  const out = { status: 0, body: null }
  const res = {
    writeHead(s) {
      out.status = s
      return { end() {} }
    },
    // createReadStream(...).pipe(res) needs a writable; nothing is read back from it here
    write() { return true },
    end() {},
    on() { return this },
    once() { return this },
    emit() { return true }
  }
  const sendJson = (r, s, data) => {
    out.status = s
    out.body = data
  }
  handleMapsRead(pathname, res, sendJson, {}, view)
  return out
}

// a viewer who may see only the IT Office's camera solus/0
const viewer = { canSee: (nvr) => nvr === 'solus', siteVisible: (s) => s === 'IT Office' }
{
  const { body } = get('/api/maps', viewer)
  check('a viewer gets only the site they may see', Object.keys(body?.sites ?? {}).join() === 'IT Office', Object.keys(body?.sites ?? {}).join())
  check('...and in it only their own camera\'s placement', Object.keys(body?.sites?.['IT Office']?.plan?.cams ?? {}).join() === 'solus/0')
  check('...on the street map as well', Object.keys(body?.sites?.['IT Office']?.geo?.cams ?? {}).join() === 'solus/0')
  check('another site\'s floor plan is 404', get(`/api/maps/plan/${PLAN_B}`, viewer).status === 404)
  check('their own site\'s plan is served', get(`/api/maps/plan/${PLAN_A}`, viewer).status === 200)
}
// an admin (view null) sees everything
{
  const { body } = get('/api/maps', null)
  check('an admin gets every site', Object.keys(body.sites).sort().join() === 'IT Office,Main site')
  check('...with every camera', Object.keys(body.sites['IT Office'].plan.cams).length === 2)
  check('...and every plan', get(`/api/maps/plan/${PLAN_A}`, null).status === 200 && get(`/api/maps/plan/${PLAN_B}`, null).status === 200)
}
// a viewer with no grants at all
{
  const none = { canSee: () => false, siteVisible: () => false }
  check('a viewer with no cameras gets no sites', JSON.stringify(get('/api/maps', none).body) === '{"sites":{}}')
  check('...and no plan', get(`/api/maps/plan/${PLAN_A}`, none).status === 404 && get(`/api/maps/plan/${PLAN_B}`, none).status === 404)
}
check('an unknown plan is still 404 for an admin', get('/api/maps/plan/cccccccccccccccc.jpg', null).status === 404)

// FAIL CLOSED: a caller that forgets the view hook entirely (the 5th argument left out, not an
// explicit null) must get nothing, never every site as an admin would. Admin is only ever the
// explicit null server.mjs passes for who.admin.
{
  const forgot = get('/api/maps') // view left undefined, as a caller who forgot the hook would
  check('a forgotten view hook: no sites, not every site', JSON.stringify(forgot.body) === '{"sites":{}}', JSON.stringify(forgot.body))
  check('...and no plan either', get(`/api/maps/plan/${PLAN_A}`).status === 404 && get(`/api/maps/plan/${PLAN_B}`).status === 404)
}

// source-shape: server.mjs always hands handleMapsRead an explicit view (null for who.admin, the
// rights hook otherwise) rather than leaving the argument out and falling on the fail-closed default
{
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  check(
    'server.mjs passes handleMapsRead an explicit view (who.admin ? null : { canSee, siteVisible })',
    /handleMapsRead\(pathname, res, sendJson, SECURITY_HEADERS, who\.admin \? null : \{ canSee, siteVisible \}\)/.test(server)
  )
}

rmSync(DATA, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
