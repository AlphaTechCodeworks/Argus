// Tests for the one map's pure side (public/map-model.js): which sites exist and whether each is
// placed, every site's cameras merged onto one street map, the badge a site collapses into when
// zoomed out, where to fly for a site or for everything, the ring unplaced cameras are dropped in,
// and what a save sends. No DOM, no server, nothing is sent anywhere.
//   node cctv/test/map-model.test.mjs
import { boundsOf, latToY, lngToX, metresPerUnit } from '../public/map-cameras.js'
import {
  BADGE_SPAN,
  DETAIL_ZOOM,
  allView,
  badgeLabel,
  boxView,
  collapsedSites,
  mergeGeo,
  parseLatLng,
  ringPlacements,
  saveBody,
  siteBadges,
  siteList,
  sitePosition,
  siteView,
  visibleMarkers
} from '../public/map-model.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol
const J = (x) => JSON.stringify(x)

// Three sites as /api/cameras answers: a shop with a street-map placement, an office that only ever
// had a floor plan (saved before the one map existed), and a yard nobody has put anywhere.
const cam = (nvr, ch, name, site, extra = {}) => ({ nvr, ch, name, site, nvrName: nvr, online: true, configured: true, ...extra })
const CAMERAS = [
  cam('shop', 0, 'Till', 'Value 4 U'), cam('shop', 1, 'Door', 'Value 4 U'), cam('shop', 2, 'Stock', 'Value 4 U'),
  cam('shop', 3, '', 'Value 4 U', { configured: false }), // an empty channel slot
  cam('office', 0, 'Desk', 'IT Office'), cam('office', 1, 'Rack', 'IT Office'),
  cam('yard', 0, 'Gate', 'Rigging lot')
]
const g = (lat, lng, range = 25) => ({ lat, lng, dir: 0, fov: 90, range })
const MAPS = {
  sites: {
    'Value 4 U': { mode: 'geo', geo: { lat: 42.707, lng: -71.1631, zoom: 18, layer: 'street', cams: { 'shop/0': g(42.7071, -71.1632), 'shop/1': g(42.7069, -71.163) } } },
    'IT Office': { mode: 'plan', plan: { file: 'aaaaaaaaaaaaaaaa.jpg', w: 1000, h: 800, cams: { 'office/0': { x: 10, y: 10, dir: 0, fov: 90, range: 40 } } } }
  }
}
const STATES = {
  'shop/0': { state: 'recording', alerts: [] },
  'shop/1': { state: 'offline', alerts: [] },
  'shop/2': { state: 'recording', alerts: [] },
  'office/0': { state: 'recording', alerts: [] },
  'office/1': { state: 'recording', alerts: [] }
}

// ---- which sites there are, and whether each is on the map ---------------------------------------
{
  check('a site with a geo position is placed', J(sitePosition(MAPS.sites['Value 4 U'])) === J({ lat: 42.707, lng: -71.1631 }))
  check('a site saved as a plan with no geo block is not placed', sitePosition(MAPS.sites['IT Office']) === null)
  check('a site with no map at all is not placed', sitePosition(undefined) === null)
  check('a geo block with no real position is not placed', sitePosition({ mode: 'geo', geo: { cams: {} } }) === null)

  const sites = siteList({ cameras: CAMERAS, maps: MAPS })
  check('one entry per site in the roster, in name order', sites.map((s) => s.name).join('|') === 'IT Office|Rigging lot|Value 4 U', sites.map((s) => s.name).join('|'))
  const shop = sites.find((s) => s.name === 'Value 4 U')
  check('a site counts its real cameras, not empty channel slots', shop.count === 3, String(shop.count))
  check('  and names them the way placements are keyed', shop.keys.join(',') === 'shop/0,shop/1,shop/2', shop.keys.join(','))
  check('  and knows how many of them are on the map', shop.onMap === 2 && shop.placed === true, J(shop))
  const office = sites.find((s) => s.name === 'IT Office')
  check('an old plan-only site is not placed, but its plan is still there to open', office.placed === false && office.hasPlan === true, J(office))
  const yard = sites.find((s) => s.name === 'Rigging lot')
  check('a site nobody has mapped is listed, not placed, with no plan', yard.placed === false && yard.hasPlan === false && yard.count === 1, J(yard))
  check('no cameras means no sites', siteList({ cameras: [], maps: MAPS }).length === 0)
}

// ---- every site's cameras on one map --------------------------------------------------------------
{
  const names = ['IT Office', 'Rigging lot', 'Value 4 U']
  const { map, siteOf } = mergeGeo(MAPS.sites, names)
  check('the one map is a street map', map.mode === 'geo')
  check('it carries every geo placement of every site', Object.keys(map.geo.cams).sort().join(',') === 'shop/0,shop/1', Object.keys(map.geo.cams).join(','))
  check('a plan placement is not a place on the street map', !map.geo.cams['office/0'])
  check('each camera remembers which site it was placed under', siteOf['shop/0'] === 'Value 4 U' && siteOf['shop/1'] === 'Value 4 U')
  check('the placements are the stored ones, so dragging one moves the stored one', map.geo.cams['shop/0'] === MAPS.sites['Value 4 U'].geo.cams['shop/0'])

  const hidden = mergeGeo({ ...MAPS.sites, Elsewhere: { mode: 'geo', geo: { lat: 1, lng: 1, zoom: 3, cams: { 'else/0': g(1, 1) } } } }, names)
  check('a site outside the list given contributes nothing', !hidden.map.geo.cams['else/0'])
  const broken = mergeGeo({ 'Value 4 U': { mode: 'geo', geo: { lat: 1, lng: 1, cams: { 'shop/0': { dir: 0, fov: 90, range: 5 } } } } }, names)
  check('a placement with no position is left out, not drawn at 0,0', Object.keys(broken.map.geo.cams).length === 0)
  check('no maps at all is an empty map, not an error', Object.keys(mergeGeo(undefined, names).map.geo.cams).length === 0)
}

// ---- the badge a site becomes when zoomed out -------------------------------------------------------
const sites = siteList({ cameras: CAMERAS, maps: MAPS })
const badges = siteBadges({ sites, maps: MAPS, states: STATES })
{
  check('only placed sites get a badge', badges.map((b) => b.name).join('|') === 'Value 4 U', badges.map((b) => b.name).join('|'))
  const b = badges[0]
  check('the badge says the site and its camera count', badgeLabel(b) === 'Value 4 U · 3', badgeLabel(b))
  check('it counts the offline cameras', b.offline === 1, String(b.offline))
  check('  and takes the worst state of its cameras', b.state === 'offline', b.state)
  check('it sits in the middle of the cameras it stands for', near(b.x, (lngToX(-71.1632) + lngToX(-71.163)) / 2) && near(b.y, (latToY(42.7071) + latToY(42.7069)) / 2), `${b.x},${b.y}`)
  check('it knows how many cameras it would open into', b.onMap === 2)

  const bare = siteBadges({
    sites: siteList({ cameras: CAMERAS, maps: { sites: { 'Rigging lot': { mode: 'geo', geo: { lat: 10, lng: 20, zoom: 17, layer: 'street', cams: {} } } } } }),
    maps: { sites: { 'Rigging lot': { mode: 'geo', geo: { lat: 10, lng: 20, zoom: 17, layer: 'street', cams: {} } } } },
    states: {}
  })
  check('a placed site with no cameras placed sits at its own position', bare.length === 1 && near(bare[0].x, lngToX(20)) && near(bare[0].y, latToY(10)), J(bare))
  check('cameras nobody has measured are not called offline', bare[0].offline === 0 && bare[0].state === 'unknown', J(bare[0]))
}
{
  const b = badges[0]
  const span = Math.max(b.box.x1 - b.box.x0, b.box.y1 - b.box.y0)
  const zoomAt = (px) => Math.log2(px / span) // the zoom at which the cameras are px apart on screen
  check('zoomed out, the site is one badge', collapsedSites(badges, zoomAt(BADGE_SPAN / 4)).has('Value 4 U'))
  check('zoomed in past the threshold, it opens into its cameras', !collapsedSites(badges, zoomAt(BADGE_SPAN * 2)).has('Value 4 U'))
  check('a site whose camera is being watched stays open', !collapsedSites(badges, zoomAt(BADGE_SPAN / 4), { open: ['Value 4 U'] }).has('Value 4 U'))
  check('while editing nothing is collapsed: every camera must be reachable', collapsedSites(badges, 3, { editing: true }).size === 0)

  const one = [{ name: 'Solo', onMap: 1, box: { x0: 5, y0: 5, x1: 5, y1: 5 } }]
  check('a one-camera site is a badge from far away', collapsedSites(one, DETAIL_ZOOM - 1).has('Solo'))
  check('  and its camera close up', !collapsedSites(one, DETAIL_ZOOM).has('Solo'))
  const none = [{ name: 'Empty', onMap: 0, box: null }]
  check('a site with no camera placed stays a badge: there is nothing to open', collapsedSites(none, 19).has('Empty'))

  const markers = [{ key: 'shop/0' }, { key: 'shop/1' }, { key: 'far/0' }]
  const siteOf = { 'shop/0': 'Value 4 U', 'shop/1': 'Value 4 U', 'far/0': 'Far' }
  check('a collapsed site hides its own markers and nobody else\'s', visibleMarkers(markers, siteOf, new Set(['Value 4 U'])).map((m) => m.key).join(',') === 'far/0')
  check('nothing collapsed hides nothing', visibleMarkers(markers, siteOf, new Set()).length === 3)
}

// ---- where to fly ---------------------------------------------------------------------------------
const SIZE = { w: 1000, h: 600 }
{
  const v = boxView({ x0: 10, y0: 20, x1: 30, y1: 30 }, SIZE)
  check('a box is centred', v.cx === 20 && v.cy === 25, J(v))
  check('  and zoomed so it fits with a margin', near(v.zoom, Math.log2(Math.min(1000 / 20, 600 / 10) * 0.9)), String(v.zoom))
  check('a single point does not zoom past the tiles', boxView({ x0: 5, y0: 5, x1: 5, y1: 5 }, SIZE).zoom === 19)
  check('the whole world does not zoom out past the map', boxView({ x0: 0, y0: 0, x1: 256, y1: 256 }, { w: 100, h: 100 }).zoom === 1)
  check('no box or no room gives nothing to fly to', boxView(null, SIZE) === null && boxView({ x0: 0, y0: 0, x1: 1, y1: 1 }, { w: 0, h: 0 }) === null)
}
{
  const b = badges[0]
  const v = siteView(b, MAPS.sites['Value 4 U'], SIZE)
  const box = boundsOf({ mode: 'geo', geo: MAPS.sites['Value 4 U'].geo })
  check('a site is flown to at the middle of its cameras and their view ranges', near(v.cx, (box.x0 + box.x1) / 2) && near(v.cy, (box.y0 + box.y1) / 2), J(v))
  check('arriving there, the site is open, not still a badge', !collapsedSites(badges, v.zoom).has('Value 4 U'), String(v.zoom))

  // cameras a few metres apart that see a long way: fitting their ranges alone would land too far out
  const wide = { mode: 'geo', geo: { lat: 42, lng: -71, zoom: 18, cams: { 'shop/0': g(42, -71, 2000), 'shop/1': g(42.00002, -71, 2000) } } }
  const wb = siteBadges({ sites: siteList({ cameras: CAMERAS, maps: { sites: { 'Value 4 U': wide } } }), maps: { sites: { 'Value 4 U': wide } }, states: {} })
  const wv = siteView(wb[0], wide, SIZE)
  check('even long-sighted cameras huddled together open on arrival', !collapsedSites(wb, wv.zoom).has('Value 4 U'), String(wv.zoom))

  const bareMap = { mode: 'geo', geo: { lat: 10, lng: 20, zoom: 17, layer: 'street', cams: {} } }
  const bv = siteView({ name: 'Rigging lot', onMap: 0, box: null, x: lngToX(20), y: latToY(10) }, bareMap, SIZE)
  check('a site with no cameras placed is flown to at its own position and saved zoom', near(bv.cx, lngToX(20)) && near(bv.cy, latToY(10)) && bv.zoom === 17, J(bv))
  check('an unplaced site has nowhere to fly to', siteView(null, MAPS.sites['IT Office'], SIZE) === null)
}
{
  const two = {
    sites: {
      'Value 4 U': MAPS.sites['Value 4 U'],
      'Rigging lot': { mode: 'geo', geo: { lat: 42.8, lng: -71.0, zoom: 17, layer: 'street', cams: {} } }
    }
  }
  const bs = siteBadges({ sites: siteList({ cameras: CAMERAS, maps: two }), maps: two, states: {} })
  const v = allView(bs, two, SIZE)
  const inView = (x, y) => Math.abs(x - v.cx) * 2 ** v.zoom < SIZE.w / 2 && Math.abs(y - v.cy) * 2 ** v.zoom < SIZE.h / 2
  check('"All sites" shows every placed site, cameras or not', inView(lngToX(-71.1632), latToY(42.7071)) && inView(lngToX(-71.0), latToY(42.8)), J(v))
  check('with nothing placed there is nothing to fit', allView([], { sites: {} }, SIZE) === null)
}

// ---- dropping a site's unplaced cameras around it ---------------------------------------------------
{
  const centre = { lat: 42.707, lng: -71.1631 }
  const keys = Array.from({ length: 26 }, (_, i) => `shop/${i}`)
  const ring = ringPlacements(centre, keys)
  check('every camera gets a place', Object.keys(ring).join(',') === keys.join(','))
  const metres = (c) => {
    const dx = (lngToX(c.lng) - lngToX(centre.lng)) * metresPerUnit(centre.lat)
    const dy = (latToY(c.lat) - latToY(centre.lat)) * metresPerUnit(centre.lat)
    return { dx, dy, d: Math.hypot(dx, dy) }
  }
  const ds = keys.map((k) => metres(ring[k]).d)
  check('they are all the same distance from the site: a ring', Math.max(...ds) - Math.min(...ds) < 0.5, `${Math.min(...ds)}..${Math.max(...ds)}`)
  const a = metres(ring['shop/0'])
  const b = metres(ring['shop/1'])
  check('neighbours are far enough apart to grab one without the other', Math.hypot(a.dx - b.dx, a.dy - b.dy) >= 7, String(Math.hypot(a.dx - b.dx, a.dy - b.dy)))
  check('the first is due north of the site', Math.abs(a.dx) < 0.01 && a.dy < 0, J(a))
  check('each looks outwards, so the cones do not pile up in the middle', ring['shop/0'].dir === 0 && ring['shop/13'].dir === 180, `${ring['shop/0'].dir},${ring['shop/13'].dir}`)
  check('each is a placement the server will store', keys.every((k) => {
    const c = ring[k]
    return Math.abs(c.lat) <= 85 && Math.abs(c.lng) <= 180 && c.dir >= 0 && c.dir < 360 && c.fov >= 1 && c.fov <= 360 && c.range >= 1 && c.range <= 5000
  }))
  const few = ringPlacements(centre, ['shop/0', 'shop/1'])
  check('a couple of cameras still stand clear of the site itself', metres(few['shop/0']).d >= 10, String(metres(few['shop/0']).d))
  check('no cameras, no ring', Object.keys(ringPlacements(centre, [])).length === 0)
  check('the same cameras land in the same places every time', J(ringPlacements(centre, keys)) === J(ring))
}

// ---- typed coordinates --------------------------------------------------------------------------------
{
  check('"lat, lng" is read', J(parseLatLng('42.7070, -71.1631')) === J({ lat: 42.707, lng: -71.1631 }))
  check('a Google Maps link is read from its @lat,lng', J(parseLatLng('https://www.google.com/maps/place/x/@51.5,-0.12,17z')) === J({ lat: 51.5, lng: -0.12 }))
  check('a space will do for the comma', J(parseLatLng('51.5 -0.12')) === J({ lat: 51.5, lng: -0.12 }))
  check('nonsense is refused', parseLatLng('the shop') === null && parseLatLng('') === null)
  check('a latitude off the map is refused', parseLatLng('95, 10') === null)
  check('a longitude off the map is refused', parseLatLng('10, 200') === null)
}

// ---- what a save sends -----------------------------------------------------------------------------
{
  const fresh = saveBody({ geo: { lat: 1, lng: 2, cams: { 'yard/0': g(1, 2) } } }, 'satellite')
  check('a site placed for the first time is saved as a street-map site', fresh.mode === 'geo' && fresh.plan === undefined, J(fresh))
  check('  with its position, a zoom and the layer in use', fresh.geo.lat === 1 && fresh.geo.lng === 2 && fresh.geo.zoom === 18 && fresh.geo.layer === 'satellite', J(fresh.geo))

  const planSite = structuredClone(MAPS.sites['IT Office'])
  planSite.geo = { lat: 5, lng: 6, zoom: 17, layer: 'street', cams: { 'office/0': g(5, 6) } }
  const both = saveBody(planSite, 'street')
  check('a plan site placed on the map keeps its plan and its plan cameras', both.mode === 'plan' && J(both.plan) === J({ cams: planSite.plan.cams }), J(both))
  check('  and gains its place on the one map', both.geo.lat === 5 && Object.keys(both.geo.cams).length === 1)
  check('  keeping the zoom it had', both.geo.zoom === 17)

  const planOnly = saveBody(structuredClone(MAPS.sites['IT Office']), 'street')
  check('a plan site still not placed sends no geo block at all', planOnly.mode === 'plan' && planOnly.geo === undefined, J(planOnly))

  const emptyPlan = { mode: 'plan', plan: { file: 'bbbbbbbbbbbbbbbb.jpg', w: 10, h: 10, cams: {} }, geo: { lat: 1, lng: 2, zoom: 18, layer: 'street', cams: { 'yard/0': g(1, 2) } } }
  check('an empty plan does not outrank cameras placed on the street map', saveBody(emptyPlan, 'street').mode === 'geo')
  const geoWithPlan = { ...emptyPlan, mode: 'geo', plan: { ...emptyPlan.plan, cams: { 'yard/0': { x: 1, y: 1, dir: 0, fov: 90, range: 5 } } } }
  check('a site already saved as a street-map site stays one', saveBody(geoWithPlan, 'street').mode === 'geo')
  check('a site with neither a plan nor a position has nothing to save', saveBody({}, 'street') === null && saveBody(undefined, 'street') === null)
}

console.log(failures ? `\n${failures} FAILED` : '\nAll passed')
process.exit(failures ? 1 : 0)
