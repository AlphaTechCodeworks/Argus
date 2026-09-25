// Offline tests for storage locations (storage.mjs) and the /api/admin/storage route. Temp
// folders only; the filesystem checks (different disk from the system, free space) are faked
// where a temp folder can't show them.
//   node cctv/test/storage.test.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-storage-test-'))
writeFileSync(join(process.env.DATA_DIR, 'users.json'), JSON.stringify({ boss: { hash: 'x', role: 'admin' }, viewer: { hash: 'x', role: 'viewer' } }))
const storage = await import('../storage.mjs')
const { saveSettings, getSettings } = await import('../settings.mjs')
const { handleSettings } = await import('../settings-api.mjs')
const { addLocation, removeLocation, updateLocation, listLocations, pickLocation, checkHealth, onChange, probeWriteSpeed, MARKER, freePercent, _test } = storage

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const status = (fn) => {
  try {
    fn()
    return 0
  } catch (e) {
    return e.status ?? -1
  }
}

const base = mkdtempSync(join(tmpdir(), 'cctv-storage-locs-'))
const dir = (name) => {
  const p = join(base, name)
  mkdirSync(p, { recursive: true })
  return p
}
// every temp folder is on the system disk here: pretend folders under base/other* are another disk
const SYSTEM_DEV = 1
_test.setDevOf((p) => (p.startsWith(join(base, 'other')) ? 2 : SYSTEM_DEV))
// free space: 50% unless a test sets it
const space = new Map()
_test.setStatfs((p) => {
  const hit = [...space].find(([k]) => p.startsWith(k))
  const [free, total] = hit ? hit[1] : [500e9, 1000e9]
  return { bavail: free / 4096, blocks: total / 4096, bsize: 4096 }
})

// ---- free-space math ---------------------------------------------------------------------------------
check('free percent', freePercent({ freeBytes: 150, totalBytes: 1000 }) === 15 && freePercent({ freeBytes: 0, totalBytes: 0 }) === 0)

// ---- adding a location ---------------------------------------------------------------------------------
check('missing folder refused (400)', status(() => addLocation({ path: join(base, 'other-nope'), type: 'usb', role: 'main' }, 'boss')) === 400)
check('relative path refused', status(() => addLocation({ path: 'rec', type: 'usb', role: 'main' }, 'boss')) === 400)
check('bad type refused', status(() => addLocation({ path: dir('other-t'), type: 'floppy', role: 'main' }, 'boss')) === 400)
check('bad role refused', status(() => addLocation({ path: dir('other-t'), type: 'usb', role: 'boss' }, 'boss')) === 400)
check('bad limit refused', status(() => addLocation({ path: dir('other-t'), type: 'usb', role: 'main', limitGB: -1 }, 'boss')) === 400)
const full = dir('other-full')
writeFileSync(join(full, 'holiday.jpg'), 'x')
check('folder with other files and no marker refused (409)', status(() => addLocation({ path: full, type: 'usb', role: 'main' }, 'boss')) === 409)
check('...and no marker was written there', !existsSync(join(full, MARKER)))
check('same disk as the system refused for usb', status(() => addLocation({ path: dir('sys-usb'), type: 'usb', role: 'main' }, 'boss')) === 409)
check('same disk as the system refused for internal without the tick', status(() => addLocation({ path: dir('sys-int'), type: 'internal', role: 'main' }, 'boss')) === 409)
check('same disk: the tick does not help a usb location', status(() => addLocation({ path: dir('sys-usb'), type: 'usb', role: 'main', sameDisk: true }, 'boss')) === 409)

const mainPath = dir('other-main')
const main = addLocation({ path: mainPath, type: 'usb', role: 'main', limitGB: null }, 'boss')
check('empty folder on another disk: added', typeof main.id === 'string' && main.role === 'main' && main.type === 'usb' && main.path === mainPath)
const marker = JSON.parse(readFileSync(join(mainPath, MARKER), 'utf8'))
check('marker written with the id and created time', marker.id === main.id && !Number.isNaN(Date.parse(marker.created)), JSON.stringify(marker))
check('saved in settings.storage.locations', getSettings().storage.locations.some((l) => l.id === main.id && l.path === mainPath))
check('the same folder twice refused (409)', status(() => addLocation({ path: mainPath, type: 'usb', role: 'overflow' }, 'boss')) === 409)
const internal = addLocation({ path: dir('sys-int2'), type: 'internal', role: 'archive', sameDisk: true }, 'boss')
check('internal on the system disk with the tick: added (with a warning)', internal.role === 'archive' && internal.sameDisk === true)

// a folder that already has a marker (e.g. a prepared drive, or re-adding after removal) keeps its id
const pre = dir('other-prepared')
writeFileSync(join(pre, MARKER), JSON.stringify({ id: 'usb-ABC123', created: '2026-09-01T00:00:00Z' }))
writeFileSync(join(pre, 'something'), 'x')
const prepared = addLocation({ path: pre, type: 'usb', role: 'overflow' }, 'boss')
check('folder with a marker (and other files) added, keeping the marker id', prepared.id === 'usb-ABC123')

// ---- health --------------------------------------------------------------------------------------
const byId = (id) => listLocations().find((l) => l.id === id)
const h = byId(main.id).health
check('healthy location: ok, marker, writable, free/total', h.ok && h.marker && h.writable && h.freeBytes === 500e9 && h.totalBytes === 1000e9 && h.reason === '', JSON.stringify(h))
check('list has the documented fields', ['id', 'path', 'type', 'role', 'limitGB', 'health'].every((k) => k in byId(main.id)) && ['ok', 'reason', 'marker', 'writable', 'freeBytes', 'totalBytes', 'writeMBps'].every((k) => k in h))
check('no write-test files left behind', readdirSync(mainPath).join() === MARKER, readdirSync(mainPath).join())

// write-speed probe: a small temp file, removed afterwards
const mbps = await probeWriteSpeed(mainPath)
check('write-speed probe gives MB/s', typeof mbps === 'number' && mbps > 0, String(mbps))
check('probe cleans up after itself', readdirSync(mainPath).join() === MARKER, readdirSync(mainPath).join())
await checkHealth({ probe: true })
check('checkHealth with probe stores writeMBps', byId(main.id).health.writeMBps > 0)

// ---- picking the write location -------------------------------------------------------------------------
const overPath = dir('other-over')
const over = addLocation({ path: overPath, type: 'usb', role: 'overflow' }, 'boss')
check('main healthy: main is picked', pickLocation('nvr1/3')?.id === main.id)

// the drive is unplugged: the mount point is an empty folder (marker missing)
rmSync(join(mainPath, MARKER))
check('marker missing: not ok, reason given', !byId(main.id).health.ok && !byId(main.id).health.marker && /marker/i.test(byId(main.id).health.reason))
const picked = pickLocation('nvr1/3')
check('empty mount point is never picked; failover to a healthy one', picked && picked.id !== main.id, picked?.id)
check('...and no marker was recreated on the empty mount point', !existsSync(join(mainPath, MARKER)))
writeFileSync(join(mainPath, MARKER), JSON.stringify({ id: main.id, created: marker.created }))
check('marker back: main picked again', pickLocation('nvr1/3')?.id === main.id)

// a marker from another location (a different drive mounted at the same place)
writeFileSync(join(mainPath, MARKER), JSON.stringify({ id: 'someone-else', created: marker.created }))
check('marker of another location: not ok', !byId(main.id).health.ok && /another/i.test(byId(main.id).health.reason))
writeFileSync(join(mainPath, MARKER), JSON.stringify({ id: main.id, created: marker.created }))

// below the hard floor (5% default)
space.set(mainPath, [40e9, 1000e9])
check('main below the floor: unhealthy', !byId(main.id).health.ok && /floor/i.test(byId(main.id).health.reason))
check('failover main -> overflow when main is below the floor', [over.id, prepared.id].includes(pickLocation('nvr1/3')?.id))
space.set(mainPath, [100e9, 1000e9])
check('10% free (below low-space, above floor): still ok', byId(main.id).health.ok && pickLocation('nvr1/3')?.id === main.id)
space.delete(mainPath)

// the camera's own location first
saveSettings({ recording: { cameras: { 'nvr1/3': { locationId: over.id } } } }, 'boss')
check("camera's own location when healthy", pickLocation('nvr1/3')?.id === over.id)
check('other cameras still get main', pickLocation('nvr1/4')?.id === main.id)
rmSync(join(overPath, MARKER))
check("camera's own location unhealthy: main", pickLocation('nvr1/3')?.id === main.id)
writeFileSync(join(overPath, MARKER), JSON.stringify({ id: over.id, created: marker.created }))

// nothing healthy
rmSync(join(mainPath, MARKER))
rmSync(join(overPath, MARKER))
rmSync(join(pre, MARKER))
check('archive locations are never picked for recording; nothing healthy -> null', pickLocation('nvr1/4') === null)
writeFileSync(join(mainPath, MARKER), JSON.stringify({ id: main.id, created: marker.created }))
writeFileSync(join(overPath, MARKER), JSON.stringify({ id: over.id, created: marker.created }))
writeFileSync(join(pre, MARKER), JSON.stringify({ id: prepared.id, created: marker.created }))

// ---- onChange ------------------------------------------------------------------------------------------
const seen = []
const off = onChange((list) => seen.push(list))
await checkHealth()
const before = seen.length
rmSync(join(mainPath, MARKER))
await checkHealth()
check('onChange fires when health changes', seen.length === before + 1 && seen.at(-1).some((l) => l.id === main.id && !l.health.ok))
await checkHealth()
check('...and not again while nothing changes', seen.length === before + 1)
off()
writeFileSync(join(mainPath, MARKER), JSON.stringify({ id: main.id, created: marker.created }))

// ---- change and remove -----------------------------------------------------------------------------------
check('set role', updateLocation(over.id, { role: 'archive' }, 'boss').role === 'archive' && byId(over.id).role === 'archive')
check('set limit', updateLocation(over.id, { limitGB: 500 }, 'boss').limitGB === 500)
check('bad role refused on update', status(() => updateLocation(over.id, { role: 'x' }, 'boss')) === 400)
check('unknown id: 404', status(() => updateLocation('nope', { role: 'main' }, 'boss')) === 404 && status(() => removeLocation('nope', 'boss')) === 404)
removeLocation(over.id, 'boss')
check('removed from the list; files and marker left alone', !byId(over.id) && existsSync(join(overPath, MARKER)))
check("a camera pointing at a removed location falls back", pickLocation('nvr1/3')?.id === main.id)

// ---- the route ------------------------------------------------------------------------------------------
const json = (o) => async () => o
const [g1, b1] = await handleSettings('GET', '/api/admin/storage', json({}), 'boss')
check('GET /storage: locations + thresholds', g1 === 200 && b1.locations.some((l) => l.id === main.id) && b1.lowFreePct === 15 && b1.floorFreePct === 5)
const addPath = dir('other-api')
const [p1, pb1] = await handleSettings('POST', '/api/admin/storage', json({ action: 'add', path: addPath, type: 'usb', role: 'overflow' }), 'boss')
check('POST add', p1 === 200 && pb1.location?.path === addPath && existsSync(join(addPath, MARKER)), JSON.stringify(pb1))
const [p2] = await handleSettings('POST', '/api/admin/storage', json({ action: 'set', id: pb1.location.id, role: 'main' }), 'boss')
check('POST set role', p2 === 200 && byId(pb1.location.id).role === 'main')
const [p3] = await handleSettings('POST', '/api/admin/storage', json({ action: 'remove', id: pb1.location.id }), 'boss')
check('POST remove', p3 === 200 && !byId(pb1.location.id))
const [p4] = await handleSettings('POST', '/api/admin/storage', json({ action: 'format' }), 'boss')
check('POST unknown action: 400', p4 === 400)
const [p5] = await handleSettings('POST', '/api/admin/storage', json({ action: 'add', path: dir('other-v'), type: 'usb', role: 'main' }), 'viewer')
check('non-admin: 403 and nothing written', p5 === 403 && !existsSync(join(base, 'other-v', MARKER)))

rmSync(base, { recursive: true, force: true })
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
