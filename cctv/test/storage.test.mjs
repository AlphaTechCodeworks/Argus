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
// the space limit is enforced since 2026-09-29 (housekeeping deletes down to it): it must be a size the
// drive can hold, in GB of 1,000,000,000 bytes (the fake drives here are 1,000 GB)
const why = (fn) => {
  try {
    fn()
    return ''
  } catch (e) {
    return `${e.status} ${e.message}`
  }
}
check('limit: the whole drive (1,000 GB) is allowed', updateLocation(over.id, { limitGB: 1000 }, 'boss').limitGB === 1000)
check('limit: more than the drive holds refused, saying its size and what a GB is', /^400 /.test(why(() => updateLocation(over.id, { limitGB: 1000.5 }, 'boss'))) && /1,000 GB/.test(why(() => updateLocation(over.id, { limitGB: 1001 }, 'boss'))) && /1,000,000,000 bytes/.test(why(() => updateLocation(over.id, { limitGB: 1001 }, 'boss'))), why(() => updateLocation(over.id, { limitGB: 1001 }, 'boss')))
check('limit: zero, negative, text and not-a-number refused', [0, -5, '12000', NaN, Infinity].every((v) => /^400 /.test(why(() => updateLocation(over.id, { limitGB: v }, 'boss')))))
check('limit: empty or null means none', updateLocation(over.id, { limitGB: null }, 'boss').limitGB === null && updateLocation(over.id, { limitGB: '' }, 'boss').limitGB === null)
check('limit at add: more than the drive holds refused too', status(() => addLocation({ path: dir('other-big'), type: 'usb', role: 'overflow', limitGB: 5000 }, 'boss')) === 400 && !existsSync(join(base, 'other-big', MARKER)))
{
  // a share: its size is its helper's last check; before the first one it is not known, and a limit is
  // refused rather than taken on trust
  const nas = dir('other-nas')
  writeFileSync(join(nas, MARKER), JSON.stringify({ id: 'nas-1', created: '2026-09-01T00:00:00Z' }))
  saveSettings({ storage: { locations: [...getSettings().storage.locations, { id: 'nas-1', path: nas, type: 'network', role: 'main', limitGB: null }] } }, 'boss', { internal: true })
  _test.setShareHealth('nas-1', null)
  check('limit on a share not checked yet: refused, saying why', /not known|not checked/.test(why(() => updateLocation('nas-1', { limitGB: 12000 }, 'boss'))), why(() => updateLocation('nas-1', { limitGB: 12000 }, 'boss')))
  _test.setShareHealth('nas-1', { ok: true, reason: '', marker: true, writable: true, freeBytes: 7.7e12, totalBytes: 16.63e12, writeMBps: null })
  check('limit on a share of 16,630 GB: 12,000 GB allowed (the owner\'s)', updateLocation('nas-1', { limitGB: 12000 }, 'boss').limitGB === 12000)
  check('... 17,000 GB refused', /16,630 GB/.test(why(() => updateLocation('nas-1', { limitGB: 17000 }, 'boss'))), why(() => updateLocation('nas-1', { limitGB: 17000 }, 'boss')))
  // enforced once saved here (limitSetAt): the old page saved limits as notes, with no question and no
  // size check, and one saved then must not start deleting at the first run after the deploy
  check('a limit saved here is enforced (stamped limitSetAt), and listed as enforced', typeof getSettings().storage.locations.find((l) => l.id === 'nas-1').limitSetAt === 'string' && byId('nas-1').limitEnforced === true, JSON.stringify(byId('nas-1')))
  // a card saved for its marks alone sends its limit unchanged, or an older page does: with the share's
  // size not known (unmounted, or not checked since a restart) that must not fail (review of p2-delete)
  _test.setShareHealth('nas-1', null)
  const marksOnly = updateLocation('nas-1', { limitGB: 12000, lowFreePct: 7 }, 'boss')
  check('the limit as it was, the share\'s size not known: saved (the marks), no size check', marksOnly.lowFreePct === 7 && marksOnly.limitGB === 12000 && marksOnly.limitEnforced === true, JSON.stringify(marksOnly))
  check('... a changed limit still needs the size', /not known/.test(why(() => updateLocation('nas-1', { limitGB: 11000 }, 'boss'))))
  // a limit from before (no limitSetAt), as the old page saved it
  saveSettings({ storage: { locations: getSettings().storage.locations.map((l) => (l.id === 'nas-1' ? { ...l, limitGB: 9000, limitSetAt: undefined } : l)) } }, 'boss', { internal: true })
  check('a limit saved before limits were enforced: listed as not enforced', byId('nas-1').limitGB === 9000 && byId('nas-1').limitEnforced === false, JSON.stringify(byId('nas-1')))
  check('... saved as it is, the size not known: refused (enforcing it is a new limit)', /not known/.test(why(() => updateLocation('nas-1', { limitGB: 9000 }, 'boss'))))
  _test.setShareHealth('nas-1', { ok: true, reason: '', marker: true, writable: true, freeBytes: 7.7e12, totalBytes: 16.63e12, writeMBps: null })
  check('... saved as it is, the size known: enforced from now', updateLocation('nas-1', { limitGB: 9000 }, 'boss').limitEnforced === true)
  check('no limit: not enforced, and no stamp left', updateLocation('nas-1', { limitGB: null }, 'boss').limitEnforced === false && !('limitSetAt' in getSettings().storage.locations.find((l) => l.id === 'nas-1')))
  updateLocation('nas-1', { limitGB: 12000 }, 'boss')

  // each location's own free-space marks (the owner's NAS: a low mark near 7 % so 12 TB is usable)
  const set = updateLocation('nas-1', { lowFreePct: 7, floorFreePct: 4 }, 'boss')
  check('own marks: set, and listed with the location', set.lowFreePct === 7 && set.floorFreePct === 4 && byId('nas-1').lowFreePct === 7 && byId('nas-1').floorFreePct === 4, JSON.stringify(set))
  check('own marks: other locations keep none (the defaults)', byId(main.id).lowFreePct === null && byId(main.id).floorFreePct === null)
  check('own marks: not whole numbers from 1 to 50 refused', [0, 51, 7.5, '7', -1].every((v) => /^400 /.test(why(() => updateLocation('nas-1', { lowFreePct: v }, 'boss')))))
  check('own marks: a floor at or above the low mark refused (its own or the default)', /^400 .*floor/.test(why(() => updateLocation('nas-1', { floorFreePct: 7 }, 'boss'))) && /^400 .*floor/.test(why(() => updateLocation(main.id, { floorFreePct: 15 }, 'boss'))) && /^400 .*floor/.test(why(() => updateLocation(main.id, { lowFreePct: 5 }, 'boss'))))
  check('own marks: nothing was saved by the refusals', byId('nas-1').lowFreePct === 7 && byId('nas-1').floorFreePct === 4 && byId(main.id).floorFreePct === null)
  // (with a floor of its own the default floor is not its; without, it is)
  check('a location with its own floor: the default floor may go above its low mark', saveSettings({ storage: { lowFreePct: 20, floorFreePct: 7 } }, 'boss').storage.floorFreePct === 7)
  saveSettings({ storage: { lowFreePct: 15, floorFreePct: 5 } }, 'boss')
  updateLocation('nas-1', { floorFreePct: null }, 'boss')
  check('... without one, the default floor cannot be raised to its own low mark', status(() => saveSettings({ storage: { lowFreePct: 20, floorFreePct: 7 } }, 'boss')) === 400 && getSettings().storage.floorFreePct === 5)
  updateLocation('nas-1', { floorFreePct: 4 }, 'boss')
  // its own floor is what makes it unfit to record to
  space.set(mainPath, [40e9, 1000e9]) // 4 %
  check('4 % free: below the default floor (5 %), unhealthy', !byId(main.id).health.ok)
  updateLocation(main.id, { floorFreePct: 3 }, 'boss')
  check('... with its own floor of 3 %: healthy', byId(main.id).health.ok, byId(main.id).health.reason)
  check('own marks: null goes back to the default', updateLocation(main.id, { floorFreePct: null }, 'boss').floorFreePct === null && !byId(main.id).health.ok)
  space.delete(mainPath)
  const [pm, pmb] = await handleSettings('POST', '/api/admin/storage', async () => ({ action: 'set', id: 'nas-1', lowFreePct: 8, floorFreePct: null, limitGB: 11000 }), 'boss')
  check('POST set: the limit and the own marks through the route', pm === 200 && pmb.location?.lowFreePct === 8 && pmb.location?.floorFreePct === null && pmb.location?.limitGB === 11000, JSON.stringify(pmb))
  saveSettings({ storage: { locations: getSettings().storage.locations.filter((l) => l.id !== 'nas-1') } }, 'boss', { internal: true })
}
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
