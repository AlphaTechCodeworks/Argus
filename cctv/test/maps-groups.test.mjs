// The server's half of cone colours: PUT /api/admin/maps/<site> stores a site's colour groups and
// each camera's group/override, and rejects anything that is not a valid hex colour or that would
// let the stored map grow without bound. Pure: a temp data folder, no NVR, no SDK.
//   node cctv/test/maps-groups.test.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_GROUPS } from '../public/map-model.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const DATA = mkdtempSync(join(tmpdir(), 'cctv-maps-groups-'))
process.env.DATA_DIR = DATA // maps.mjs reads it when first imported
// an old street-map site with no colours at all: it must still save unchanged (no migration)
writeFileSync(join(DATA, 'maps.json'), JSON.stringify({
  sites: { 'Value 4 U': { mode: 'geo', geo: { lat: 42.7, lng: -71.16, zoom: 18, layer: 'street', cams: { 'shop/0': { lat: 42.7, lng: -71.16, dir: 0, fov: 90, range: 25 } } } } }
}))

const { handleMapsAdmin, readMaps } = await import('../maps.mjs')
const put = (name, body) => handleMapsAdmin('PUT', `/api/admin/maps/${encodeURIComponent(name)}`, async () => body)
const cam = (extra = {}) => ({ lat: 42.7, lng: -71.16, dir: 0, fov: 90, range: 25, ...extra })
const base = (cams, groups) => ({ mode: 'geo', geo: { lat: 42.7, lng: -71.16, zoom: 18, layer: 'street', cams, ...(groups ? { groups } : {}) } })

{
  const [status, saved] = await put('Value 4 U', base(
    { 'shop/0': cam({ group: 'ent' }), 'shop/1': cam({ color: '#FF8800' }) },
    [{ id: 'ent', name: 'Entrances', color: '#3ba2ff', opacity: 0.3 }]
  ))
  check('a site with groups and coloured cameras is stored', status === 200, J(saved))
  check('  the group palette is kept, hex and all', J(saved.geo.groups) === J([{ id: 'ent', name: 'Entrances', color: '#3ba2ff', opacity: 0.3 }]), J(saved.geo.groups))
  check('  a camera keeps its group id', saved.geo.cams['shop/0'].group === 'ent')
  check('  and another keeps its direct colour override', saved.geo.cams['shop/1'].color === '#FF8800')
  check('  the stored data round-trips through readMaps', readMaps().sites['Value 4 U'].geo.cams['shop/0'].group === 'ent')
}

{
  const [status] = await put('Value 4 U', base({ 'shop/0': cam() }, [{ id: 'ent', name: 'X', color: 'notacolour' }]))
  check('a group with a non-hex colour is a 400', status === 400, String(status))
}
{
  const [status] = await put('Value 4 U', base({ 'shop/0': cam({ color: 'red' }) }))
  check('a camera override that is not hex is a 400', status === 400, String(status))
}
{
  const many = Array.from({ length: MAX_GROUPS + 1 }, (_, i) => ({ id: `g${i}`, name: `G${i}`, color: '#ffffff' }))
  const [status] = await put('Value 4 U', base({ 'shop/0': cam() }, many))
  check('more than the cap on groups is a 400', status === 400, String(status))
}
{
  const [status, saved] = await put('Value 4 U', base({ 'shop/0': cam() }))
  check('an old site with no colours still saves, with no groups key', status === 200 && saved.geo.groups === undefined, J(saved.geo.groups))
}

function J(x) { return JSON.stringify(x) }

rmSync(DATA, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
