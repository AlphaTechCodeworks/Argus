// Tests for the map's pure side (public/map-cameras.js): projection, camera state, markers and
// clustering. No DOM, no SDK. Run: node cctv/test/map-cameras.test.mjs
import {
  MAX_LAT,
  STATES,
  alertsByNvr,
  boundsOf,
  buildMarkers,
  camWorld,
  cameraStates,
  clusterMarkers,
  lngToX,
  latToY,
  markerClass,
  markerLabel,
  markerTitle,
  metresPerUnit,
  playbackHref,
  setCamPos,
  stateCounts,
  stateOf,
  worstState,
  xToLng,
  yToLat
} from '../public/map-cameras.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol

// ---- projection --------------------------------------------------------------------------------
{
  check('the prime meridian is halfway across the world', near(lngToX(0), 128), String(lngToX(0)))
  check('the equator is halfway down it', near(latToY(0), 128), String(latToY(0)))
  check('longitude round-trips', near(xToLng(lngToX(-71.1631)), -71.1631, 1e-9), String(xToLng(lngToX(-71.1631))))
  check('latitude round-trips', near(yToLat(latToY(42.707)), 42.707, 1e-9), String(yToLat(latToY(42.707))))
  check('Mercator stretches away from the equator', metresPerUnit(60) < metresPerUnit(0) * 0.51)
}
{
  const geo = { mode: 'geo', geo: { cams: {} } }
  const w = camWorld(geo, { lat: 42.707, lng: -71.1631, range: 50, dir: 0, fov: 90 })
  check('a geo camera projects to its own point', near(w.x, lngToX(-71.1631)) && near(w.y, latToY(42.707)))
  check('its range converts metres to world units', near(w.r, 50 / metresPerUnit(42.707)))

  const plan = { mode: 'plan', plan: { w: 1000, h: 800, cams: {} } }
  const p = camWorld(plan, { x: 120, y: 340, range: 60, dir: 0, fov: 90 })
  check('a plan camera is already in world units', p.x === 120 && p.y === 340 && p.r === 60)
}
{
  const plan = { mode: 'plan', plan: { w: 1000, h: 800, cams: {} } }
  const c = setCamPos(plan, { range: 10 }, 5000, -20)
  check('a plan position is clamped to the image', c.x === 1000 && c.y === 0, JSON.stringify(c))

  const geo = { mode: 'geo', geo: { cams: {} } }
  const g = setCamPos(geo, { range: 10 }, lngToX(12.5), latToY(51))
  check('a geo position round-trips through lat/lng', near(g.lat, 51, 1e-9) && near(g.lng, 12.5, 1e-9), JSON.stringify(g))
  const far = setCamPos(geo, { range: 10 }, lngToX(0), -9999)
  check('and never runs off the top of the Mercator world', far.lat <= MAX_LAT && far.lat >= -MAX_LAT, String(far.lat))
}
{
  const plan = { mode: 'plan', plan: { w: 1000, h: 800, cams: { 'nvr1/0': { x: 100, y: 100, range: 10, dir: 0, fov: 90 }, 'nvr1/1': { x: 300, y: 500, range: 20, dir: 0, fov: 90 } } } }
  const b = boundsOf(plan)
  check('the bounds hold every camera, padded by the longest range', b.x0 === 80 && b.y0 === 80 && b.x1 === 320 && b.y1 === 520, JSON.stringify(b))
  check('no cameras means no bounds, not a box at 0,0', boundsOf({ mode: 'plan', plan: { cams: {} } }) === null)
}

// ---- camera state ------------------------------------------------------------------------------
{
  check('online and recording is recording', stateOf({ online: true, recording: true }) === 'recording')
  check('online and recording nothing is its own state', stateOf({ online: true, recording: false }) === 'idle')
  check('and it is not lumped in with recording', STATES.idle.rank > STATES.recording.rank)
  check('offline is offline', stateOf({ online: false, recording: false }) === 'offline')
  check('an open alert outranks a healthy camera', stateOf({ online: true, recording: true }, [{ key: 'nvr-disk/nvr1', title: 'x' }]) === 'alert')
  check('but offline is still said as offline', stateOf({ online: false, recording: false }, [{ key: 'nvr-offline/nvr1', title: 'x' }]) === 'offline')
}
{
  // The rule the whole page hangs on: a camera nobody has told us about is never drawn as healthy.
  check('no entry at all is unknown', stateOf(undefined) === 'unknown')
  check('a missing online flag is unknown', stateOf({ recording: true }) === 'unknown')
  check('an online camera with no recording flag is unknown', stateOf({ online: true }) === 'unknown')
  check('unknown is never recording', STATES.unknown.rank > STATES.recording.rank)
}
{
  const by = alertsByNvr([{ key: 'camera-offline/nvr1' }, { key: 'nvr-disk/nvr1' }, { key: 'nvr-clock/nvr-2' }, { key: 'malformed' }])
  check('alerts gather under the NVR their key names', by.get('nvr1').length === 2 && by.get('nvr-2').length === 1, [...by.keys()].join(','))
  check('a key naming nothing is dropped rather than guessed at', !by.has('') && by.size === 2)
}
{
  const health = {
    now: 1000,
    open: [{ key: 'not-recording/nvr1', title: 'nvr1: 1 camera not recording' }],
    cameras: [
      { nvrId: 'nvr1', ch: 0, online: true, recording: true },
      { nvrId: 'nvr1', ch: 1, online: true, recording: false },
      { nvrId: 'nvr-2', ch: 4, online: false, recording: false }
    ]
  }
  const { byKey, at } = cameraStates(health)
  check('states are keyed the way the map stores placements', Object.keys(byKey).sort().join(',') === 'nvr-2/4,nvr1/0,nvr1/1', Object.keys(byKey).join(','))
  check('the alert reaches the camera on that NVR', byKey['nvr1/0'].state === 'alert', byKey['nvr1/0'].state)
  check('the one writing nothing still reads as not recording', byKey['nvr1/1'].state === 'idle', byKey['nvr1/1'].state)
  check('a camera on an NVR with no alert is untouched by it', byKey['nvr-2/4'].state === 'offline', byKey['nvr-2/4'].state)
  check('the time the states were taken is carried along', at === 1000)
  check('an empty health body yields no states rather than throwing', Object.keys(cameraStates(undefined).byKey).length === 0)
}

// ---- markers -----------------------------------------------------------------------------------

const toScreen = (x, y) => [x, y] // one world unit per pixel keeps the expectations readable
const roster = {
  'nvr1/0': { nvr: 'nvr1', ch: 0, name: 'Yard gate', site: 'Main', configured: true },
  'nvr1/1': { nvr: 'nvr1', ch: 1, name: 'Loading bay', site: 'Main', configured: true },
  'nvr1/7': { nvr: 'nvr1', ch: 7, name: '', site: 'Main', configured: false }
}
const planMap = (cams) => ({ mode: 'plan', plan: { w: 1000, h: 800, cams } })

{
  const map = planMap({
    'nvr1/0': { x: 100, y: 100, dir: 0, fov: 90, range: 40 },
    'nvr1/7': { x: 200, y: 200, dir: 0, fov: 90, range: 40 }, // an empty channel slot
    'nvr1/9': { x: 300, y: 300, dir: 0, fov: 90, range: 40 } // a camera that has left the roster
  })
  const states = { 'nvr1/0': { state: 'recording', alerts: [] } }
  const m = buildMarkers({ map, cameras: roster, states, toScreen, scale: 1 })
  check('only real, placed cameras get a marker', m.length === 1 && m[0].key === 'nvr1/0', m.map((x) => x.key).join(','))
  check('a camera with no stored position is absent, not piled at 0,0', !m.some((x) => x.x === 0 && x.y === 0))

  const edit = buildMarkers({ map, cameras: roster, states, toScreen, scale: 1, editing: true })
  check('editing shows the stale placement so an admin can remove it', edit.map((x) => x.key).sort().join(',') === 'nvr1/0,nvr1/9', edit.map((x) => x.key).join(','))
  check('but never the empty channel slot', !edit.some((x) => x.key === 'nvr1/7'))
  check('a placement with no camera behind it is unknown, not healthy', edit.find((x) => x.key === 'nvr1/9').state === 'unknown')
}
{
  const map = planMap({ 'nvr1/0': { x: 100, y: 100, dir: 0, fov: 90, range: 40 } })
  const m = buildMarkers({ map, cameras: roster, states: {}, toScreen, scale: 1 })
  check('a camera the health data never mentioned is unknown', m[0].state === 'unknown', m[0].state)

  const zoomed = buildMarkers({ map, cameras: roster, states: {}, toScreen: (x, y) => [x * 4, y * 4], scale: 4 })
  check('the view range scales with the zoom', zoomed[0].r === 160, String(zoomed[0].r))
  const tiny = buildMarkers({ map, cameras: roster, states: {}, toScreen, scale: 0.001 })
  check('a cone never shrinks below the marker itself', tiny[0].r === 6, String(tiny[0].r))
  check('no map means no markers', buildMarkers({ map: null, cameras: roster, toScreen, scale: 1 }).length === 0)
}
{
  const m = { key: 'nvr1/0', cam: roster['nvr1/0'], state: 'idle', alerts: [] }
  check('a marker is labelled by channel and name', markerLabel(m) === '1 · Yard gate', markerLabel(m))
  check('a marker with no camera says so plainly', markerLabel({ key: 'nvr1/9', cam: null }) === 'Unknown camera (nvr1/9)')
  check('the tooltip explains the state in words', markerTitle(m).includes('online, but nothing is being recorded'), markerTitle(m))
  const alerted = { ...m, state: 'alert', alerts: [{ title: 'nvr1 reports no disk' }] }
  check('and names the alert when there is one', markerTitle(alerted).includes('nvr1 reports no disk'), markerTitle(alerted))
  check('the class carries the state for the stylesheet', markerClass('offline') === 'cam st-offline', markerClass('offline'))
  check('an unrecognised state falls back to unknown, never to a healthy colour', markerClass('nonsense') === 'cam st-unknown', markerClass('nonsense'))
  check('the marker links to that camera\'s recordings', playbackHref(roster['nvr1/0']) === '/playback.html?nvr=nvr1&ch=0', playbackHref(roster['nvr1/0']))
}

// ---- clustering --------------------------------------------------------------------------------
{
  const mk = (key, x, y, state) => ({ key, x, y, state, cam: { ch: 0, name: key }, alerts: [] })
  const markers = [mk('a', 10, 10, 'recording'), mk('b', 15, 12, 'offline'), mk('c', 400, 400, 'recording')]
  const c = clusterMarkers(markers, 26)
  check('markers on top of each other become one', c.length === 2, String(c.length))
  const pile = c.find((x) => x.count > 1)
  check('the cluster counts its members', pile.count === 2, String(pile.count))
  check('and takes the worst of their colours', pile.state === 'offline', pile.state)
  check('it sits between the cameras it stands for', pile.x === 12.5 && pile.y === 11, `${pile.x},${pile.y}`)

  const spread = clusterMarkers(markers, 2)
  check('far enough apart, nothing is clustered', spread.length === 3 && spread.every((x) => x.count === 1))
  const pinned = clusterMarkers(markers, 26, ['b'])
  check('the camera being worked with is never swallowed by a pile', pinned.length === 3, String(pinned.length))
  check('clustering is stable: same markers, same answer', JSON.stringify(clusterMarkers(markers, 26)) === JSON.stringify(c))
}
{
  check('an unknown state is never hidden behind a healthy one', worstState(['recording', 'unknown']) === 'unknown')
  check('offline is the loudest thing a cluster can say', worstState(['alert', 'idle', 'offline', 'recording']) === 'offline')
  check('all-healthy stays healthy', worstState(['recording', 'recording']) === 'recording')
  check('a state from nowhere is treated as unknown', worstState(['recording', 'made-up']) === 'unknown')
  check('nothing at all is not a fault', worstState([]) === 'recording')
}
{
  const counts = stateCounts([{ state: 'recording' }, { state: 'recording' }, { state: 'idle' }, { state: 'offline' }, { state: 'rubbish' }])
  check('the legend counts each state', counts.recording === 2 && counts.idle === 1 && counts.offline === 1 && counts.unknown === 1, JSON.stringify(counts))
}

console.log(failures ? `\n${failures} FAILED` : '\nAll passed')
process.exit(failures ? 1 : 0)

// ---- recording switched off: live is green, not "not recording" ---------------------------------
{
  const off = cameraStates({ cameras: [{ nvrId: 'a', ch: 0, online: true, recording: false }, { nvrId: 'a', ch: 1, online: false, recording: false }] })
  check('nothing recording anywhere: an online camera is live', off.byKey['a/0'].state === 'live')
  check('  and an offline one is offline', off.byKey['a/1'].state === 'offline')
  const on = cameraStates({ cameras: [{ nvrId: 'a', ch: 0, online: true, recording: false }, { nvrId: 'b', ch: 0, online: true, recording: true }] })
  check('one camera recording somewhere: one that is not stays "not recording"', on.byKey['a/0'].state === 'idle' && on.byKey['b/0'].state === 'recording')
  check('live ranks with recording: a cluster of live cameras is not coloured as a fault', STATES.live.rank === STATES.recording.rank)
}
assert.equal(stateCounts([{ state: 'live' }, { state: 'live' }, { state: 'offline' }]).live, 2, 'live cameras are counted for the legend')
