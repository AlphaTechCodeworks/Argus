// Storage locations for server recordings: folders (a ZFS pool, a USB drive's mount point, a
// network share) listed in settings.storage.locations, each with a marker file. A location
// without its marker is never written: an empty mount point (drive unplugged, share down)
// must not fill up the system disk.
//
//   location: { id, path, type: 'internal'|'usb'|'network', role: 'main'|'overflow'|'archive',
//               limitGB: number|null, lowFreePct?, floorFreePct?, sameDisk?: true, added, addedBy }
//     limitGB: the most Argus's recordings may take there (as the index counts them), in GB of
//       1,000,000,000 bytes, at most the drive's or share's size; ENFORCED by housekeeping.mjs since
//       2026-09-29 (the owner's 12,000 GB of the shared NAS), once saved here: limitSetAt (an ISO time)
//       says so (location-health.mjs spaceLimit). A limit the old page saved (a note, no question, no
//       size check) has none, and is not enforced until saved again.
//     lowFreePct / floorFreePct: its own free-space marks, else storage.lowFreePct / floorFreePct
//       (location-health.mjs freeMarks)
//   <path>/.cctv-recordings: { id, created }   (the marker)
//   health:   { ok, reason, marker, writable, freeBytes, totalBytes, writeMBps }
//
// Recording goes to the camera's own location when healthy, else a healthy main one, else a
// healthy overflow one (archive locations are for moving old footage to, later).
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { MARKER, _setStatfs, freeMarks, freePercent, healthOf, markerId, probeWriteSpeed, sizeOfFolder, spaceLimit } from './location-health.mjs'
import { HttpError, isPlainObject } from './nvr-xml.mjs'
import { cameraRecording, getSettings, saveSettings } from './settings.mjs'
import { SHARE_ANSWER_MS, keepShareHelpers, onShareStuck, shareAnswerMs, shareCall, shareHelperExits } from './share-calls.mjs'

export { MARKER, freePercent, probeWriteSpeed }
// the file calls the deletion and time-lapse jobs make on a share go through its helper too
export { SHARE_ANSWER_MS, shareCall }
export const TYPES = ['internal', 'usb', 'network']
export const ROLES = ['main', 'overflow', 'archive']
const CHECK_EVERY_MS = 30_000

// replaceable for the offline tests
let devOf = (p) => statSync(p).dev

const writeMBps = new Map() // id -> last write-speed probe (MB/s)

// ---- network shares: never touched by this process -----------------------------------------------
//
// A share whose SMB session has gone stale takes any file call made on it and never gives it back,
// and the process that made it cannot even be killed. On 2026-09-26 that froze the whole server
// twice. So this process never makes a file call on a share: the share's helper does (share-calls.mjs,
// a process of its own started once and kept, since 2026-09-29 instead of a fork of this server every
// 30 s), and what its last check said is the share's health. A helper that does not answer leaves the
// share marked down, and no call goes to that share while it is still stuck; one that has exited is
// replaced by the next check.

const netHealth = new Map() // id -> last health
const GONE_AGAIN_MS = 60_000 // a share helper ending again within this: not asked again in the same check

const downHealth = (reason) => ({ ok: false, reason, marker: false, writable: false, freeBytes: 0, totalBytes: 0, writeMBps: null })

/**
 * Checks one share from its helper. Always resolves, within the answer time (3 times it with the
 * write-speed test) for the check as a whole, as before the helper: a share that takes seconds a call
 * is not one to record to, and the outside watcher remounts one "not answering".
 */
async function probeShare(loc, floor, speed) {
  const ask = () => shareCall(loc, 'probe', { floor, speed }, { timeoutMs: shareAnswerMs() * (speed ? 3 : 1), whole: true })
  try {
    return await ask()
  } catch (e) {
    if (e.code === 'ESHARESTUCK') return downHealth(e.message)
    // a helper that ended by itself (a crash, the kernel's OOM killer) says nothing about the share:
    // asked once more, of a new one, rather than calling the share down for 30 s. Not when another
    // ended within the minute before it: one that ends every time (a bad deploy) would be started twice
    // a check, and each start is a fork of this process, about 25-40 ms of the main thread (verify-6;
    // review of p1-helper, 2026-09-29). Then the next check starts one, as the old checker did.
    if (e.code === 'ESHAREGONE' && shareHelperExits(loc, GONE_AGAIN_MS) > 1) return downHealth(`share check failed: ${e.message}; another had stopped less than a minute before, so a new one is started at the next check`)
    if (e.code === 'ESHAREGONE') {
      try {
        return await ask()
      } catch (e2) {
        return downHealth(e2.code === 'ESHARESTUCK' ? e2.message : `share check failed: ${e2.message}`)
      }
    }
    return downHealth(`share check failed: ${e.message}`)
  }
}

// Any other call on a share that gets no answer (a deletion, a rewrite: Tasks 3-4) says the same as a
// check that gets none: the share is marked down now, and recording told, not at the next check.
onShareStuck((loc, op) => {
  if (op === 'probe') return // its check answers for itself
  const l = getSettings().storage.locations.find((x) => x.id === loc.id && x.type === 'network')
  if (!l) return
  netHealth.set(l.id, { ...downHealth('share not answering'), writeMBps: netHealth.get(l.id)?.writeMBps ?? null })
  tellListeners(listLocations())
})

/** Health of any location: a share's comes from its last check, never from the share itself. */
function locationHealth(loc, floor) {
  if (loc.type === 'network') return netHealth.get(loc.id) ?? downHealth('not checked yet')
  return healthOf(loc, floor, writeMBps.get(loc.id) ?? null)
}

/** Whether the location's folder holds its own marker. A share's answer is its last check's. */
export const markerMatches = (loc) => (loc.type === 'network' ? netHealth.get(loc.id)?.marker === true : markerId(loc.path) === loc.id)

/**
 * Free and total bytes of a location. A share's are from its last check, never asked of the share;
 * one that is down throws, like an unreadable drive. For reports only: a loop that deletes until
 * space is free needs the live number, or it would never see its own deletions free anything.
 */
export function freeOf(loc) {
  if (loc.type !== 'network') {
    const h = healthOf(loc, 0)
    if (h.totalBytes > 0) return { freeBytes: h.freeBytes, totalBytes: h.totalBytes }
    throw new Error(h.reason || 'free space unknown')
  }
  const h = netHealth.get(loc.id)
  if (!h?.marker || !(h.totalBytes > 0)) throw new Error(h?.reason || 'share not checked yet')
  return { freeBytes: h.freeBytes, totalBytes: h.totalBytes }
}

/** A location with its health, judged by its own hard floor (its own, else the settings'). */
const withHealth = (loc, s) => ({
  id: loc.id,
  path: loc.path,
  type: loc.type,
  role: loc.role,
  limitGB: loc.limitGB ?? null,
  // whether housekeeping enforces it (saved here since 2026-09-29), and since when
  limitEnforced: spaceLimit(loc).enforced,
  limitSetAt: spaceLimit(loc).enforced ? loc.limitSetAt : null,
  // its own marks, null where the default applies
  lowFreePct: loc.lowFreePct ?? null,
  floorFreePct: loc.floorFreePct ?? null,
  ...(loc.sameDisk ? { sameDisk: true } : {}),
  health: locationHealth(loc, freeMarks(s, loc).floorFreePct)
})

/** Every location with its current health. Never waits on a network share. */
export function listLocations() {
  const s = getSettings()
  return s.storage.locations.map((l) => withHealth(l, s))
}

const cleanRole = (v) => {
  if (!ROLES.includes(v)) throw new HttpError(400, `role must be one of: ${ROLES.join(', ')}`)
  return v
}

const GB = 1e9
/**
 * The size of a location's drive or share in bytes, or null when it is not known now: a share's is its
 * helper's last check (never asked of the share from here), a drive's is read off it.
 */
function sizeOf(loc) {
  if (loc.type === 'network') {
    const h = netHealth.get(loc.id)
    return h?.marker && h.totalBytes > 0 ? h.totalBytes : null
  }
  // a drive not mounted: its mount point is on the system disk, whose size is not the drive's
  return markerId(loc.path) === loc.id ? sizeOfFolder(loc.path) : null
}
/**
 * A space limit: a positive number of GB (1 GB = 1,000,000,000 bytes, as the Storage page says) and at
 * most the size of the drive or share, since housekeeping.mjs enforces it (2026-09-29): a limit above
 * the size would read as a promise it cannot keep. null, undefined or '' is no limit.
 */
const cleanLimit = (v, sizeNow) => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1e7) throw new HttpError(400, 'limitGB must be a positive number of GB (1 GB = 1,000,000,000 bytes), or empty for no limit')
  const size = sizeNow()
  if (!(size > 0)) throw new HttpError(400, 'the size of this drive or share is not known right now (a share not checked yet, or not mounted), so the limit cannot be checked against it: set it once the location shows its size')
  if (v * GB > size) throw new HttpError(400, `limitGB must be at most the size of the drive or share: ${Math.floor(size / GB).toLocaleString('en-GB')} GB here (1 GB = 1,000,000,000 bytes)`)
  return v
}
/** A location's own marks from `fields` (a whole number from 1 to 50; null or '' for the default), checked together. */
function withMarks(loc, fields, s) {
  const next = { ...loc }
  for (const [k, name] of [['lowFreePct', 'the low mark'], ['floorFreePct', 'the hard floor']]) {
    if (!(k in fields)) continue
    const v = fields[k]
    if (v === null || v === '') {
      delete next[k]
      continue
    }
    if (!Number.isInteger(v) || v < 1 || v > 50) throw new HttpError(400, `${name} must be a whole number from 1 to 50 (% free), or empty for the default`)
    next[k] = v
  }
  const m = freeMarks(s, next)
  if (m.floorFreePct >= m.lowFreePct) throw new HttpError(400, `the hard floor (${m.floorFreePct}% free) must be below the low mark (${m.lowFreePct}% free)`)
  return next
}

function saveLocations(locations, user) {
  saveSettings({ storage: { locations } }, user, { internal: true })
}

/**
 * Adds a folder as a location and writes its marker. Only a folder that exists and is empty or
 * already has a marker; and only on another filesystem than the system's "/", except an
 * internal location when the admin ticked "same disk as the system" (sameDisk).
 */
export function addLocation({ path, type, role, limitGB = null, sameDisk = false } = {}, user) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 256 || /[\0\n]/.test(path)) throw new HttpError(400, 'path must be a full folder path, e.g. /srv/cctv-rec/usb1')
  path = resolve(path)
  if (!TYPES.includes(type)) throw new HttpError(400, `type must be one of: ${TYPES.join(', ')}`)
  cleanRole(role)
  const s = getSettings()
  if (s.storage.locations.some((l) => l.path === path)) throw new HttpError(409, `${path} is already a location`)
  let st
  try {
    st = statSync(path)
  } catch {
    throw new HttpError(400, `${path} does not exist (create or mount it first)`)
  }
  if (!st.isDirectory()) throw new HttpError(400, `${path} is not a folder`)
  const existing = existsSync(join(path, MARKER)) ? markerId(path) : null
  if (existsSync(join(path, MARKER)) && !existing) throw new HttpError(409, `${path} has an unreadable ${MARKER} file`)
  if (!existing && readdirSync(path).length > 0) throw new HttpError(409, `${path} is not empty: choose an empty folder (nothing there is touched)`)
  if (existing && s.storage.locations.some((l) => l.id === existing)) throw new HttpError(409, `the marker in ${path} belongs to a location already in the list`)
  let sameAsSystem
  try {
    sameAsSystem = devOf(path) === devOf('/')
  } catch (e) {
    throw new HttpError(400, `cannot check ${path}: ${e.message}`)
  }
  if (sameAsSystem && !(type === 'internal' && sameDisk === true)) {
    throw new HttpError(
      409,
      type === 'internal'
        ? `${path} is on the same disk as the system. Tick "same disk as the system" to use it anyway (recordings could fill the system disk).`
        : `${path} is on the system disk: the ${type === 'usb' ? 'drive' : 'share'} is not mounted there`
    )
  }
  // a share's size is not known until its helper has checked it: its limit is set after that
  limitGB = cleanLimit(limitGB, () => (type === 'network' ? null : sizeOfFolder(path)))
  const id = existing ?? `loc-${randomBytes(4).toString('hex')}`
  if (!existing) writeFileSync(join(path, MARKER), `${JSON.stringify({ id, created: new Date().toISOString() })}\n`, { flag: 'wx' })
  const loc = { id, path, type, role, limitGB, ...(limitGB ? { limitSetAt: new Date().toISOString() } : {}), ...(sameAsSystem ? { sameDisk: true } : {}), added: new Date().toISOString(), addedBy: user ?? '?' }
  saveLocations([...s.storage.locations, loc], user)
  if (type === 'network') checkHealth().catch(() => {}) // its health is not known until checked
  console.log(`[storage] ${user} added ${id} at ${path} (${type}, ${role})${sameAsSystem ? ' on the system disk' : ''}${limitGB ? `, limit ${limitGB} GB` : ''}`)
  return withHealth(loc, s)
}

/** Changes role, space limit and/or its own free-space marks (lowFreePct, floorFreePct; null: the default). */
export function updateLocation(id, fields, user) {
  if (!isPlainObject(fields)) throw new HttpError(400, 'bad fields')
  const s = getSettings()
  const loc = s.storage.locations.find((l) => l.id === id)
  if (!loc) throw new HttpError(404, 'No such location')
  if ('role' in fields) loc.role = cleanRole(fields.role)
  if ('limitGB' in fields) {
    // The limit as it was, already enforced, is not checked again: a card saved for its marks alone (or
    // an older page) sends it too, and a share's size is not known while it is unmounted or before its
    // first check after a restart, which made the marks unsaveable then (review of p2-delete). Anything
    // else is checked, and stamped as enforced from now: a new or changed limit, or one the old page
    // saved as a note.
    const v = fields.limitGB === '' || fields.limitGB === undefined ? null : fields.limitGB
    const had = spaceLimit(loc)
    const same = v === (loc.limitGB ?? null) && (v === null || had.enforced)
    if (!same) {
      loc.limitGB = cleanLimit(v, () => sizeOf(loc))
      if (loc.limitGB === null) delete loc.limitSetAt
      else loc.limitSetAt = new Date().toISOString()
    }
  }
  if ('lowFreePct' in fields || 'floorFreePct' in fields) {
    const m = withMarks(loc, fields, s)
    for (const k of ['lowFreePct', 'floorFreePct']) {
      if (k in m) loc[k] = m[k]
      else delete loc[k]
    }
  }
  saveLocations(s.storage.locations, user)
  const marks = freeMarks(s, loc)
  console.log(`[storage] ${user} changed ${id}: role ${loc.role}, limit ${loc.limitGB ? `${loc.limitGB} GB (${spaceLimit(loc).enforced ? 'enforced' : 'not enforced: saved before limits were'})` : 'none'}, low mark ${marks.lowFreePct}%${loc.lowFreePct ? '' : ' (default)'}, floor ${marks.floorFreePct}%${loc.floorFreePct ? '' : ' (default)'}`)
  return withHealth(loc, s)
}

/** Removes a location from the list. Its files and marker stay where they are. */
export function removeLocation(id, user) {
  const s = getSettings()
  if (!s.storage.locations.some((l) => l.id === id)) throw new HttpError(404, 'No such location')
  saveLocations(s.storage.locations.filter((l) => l.id !== id), user)
  console.log(`[storage] ${user} removed ${id} from the list (files left in place)`)
}

/**
 * Where a camera's recordings go now: its own location if healthy, else a healthy main one,
 * else a healthy overflow one. Never a location without its marker. null when none.
 * @param {string} camKey "<nvr>/<ch>"
 */
export function pickLocation(camKey) {
  const i = camKey.lastIndexOf('/')
  const own = cameraRecording(camKey.slice(0, i), camKey.slice(i + 1)).locationId
  const list = listLocations().filter((l) => l.health.ok && l.health.marker)
  return (own && list.find((l) => l.id === own && l.role !== 'archive')) || list.find((l) => l.role === 'main') || list.find((l) => l.role === 'overflow') || null
}

// ---- health checks every 30 s --------------------------------------------------------------------

const listeners = new Set()
let lastSummary = ''

/** cb(locations) when any location's health (ok / reason) changes. Returns an unsubscribe function. */
export function onChange(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Tells the listeners when any location's ok / reason changed since they were last told. */
function tellListeners(list) {
  const summary = JSON.stringify(list.map((l) => [l.id, l.health.ok, l.health.reason]))
  if (summary === lastSummary) return
  const first = lastSummary === ''
  lastSummary = summary
  for (const l of list) if (!l.health.ok && !first) console.warn(`[storage] ${l.id} (${l.path}) not usable: ${l.health.reason}`)
  for (const cb of listeners) {
    try {
      cb(list)
    } catch (e) {
      console.warn(`[storage] listener failed: ${e.message}`)
    }
  }
}

/** Checks every location now (with probe: also measures write speed) and tells listeners of changes. */
export async function checkHealth({ probe = false } = {}) {
  const s = getSettings()
  // a location taken off the list: its helper goes (any type: the jobs may use one for a drive too)
  keepShareHelpers(s.storage.locations)
  const shares = s.storage.locations.filter((l) => l.type === 'network')
  // shares all at once, each by its own helper; a stuck one costs the answer time, not the server
  await Promise.all(shares.map(async (l) => {
    const h = await probeShare(l, freeMarks(s, l).floorFreePct, probe)
    if (h.writeMBps == null) h.writeMBps = netHealth.get(l.id)?.writeMBps ?? null
    netHealth.set(l.id, h)
  }))
  if (probe) {
    for (const l of listLocations()) {
      if (!l.health.ok || l.type === 'network') continue
      try {
        writeMBps.set(l.id, await probeWriteSpeed(l.path))
      } catch (e) {
        console.warn(`[storage] write-speed probe on ${l.path} failed: ${e.message}`)
      }
    }
  }
  const list = listLocations()
  tellListeners(list)
  return list
}

let timer = null
let checks = 0
/** Starts the 30-second health checks (write speed measured every 10 minutes). */
export function startHealthChecks(everyMs = CHECK_EVERY_MS) {
  if (timer) return
  // the first check is the quick one (no write-speed test): until a share has been checked it
  // counts as unknown, and a slow first check meant a false "not mounted" after every restart
  const tick = () => checkHealth({ probe: ++checks % 20 === 0 }).catch((e) => console.warn(`[storage] health check failed: ${e.message}`))
  tick()
  timer = setInterval(tick, everyMs)
  timer.unref()
}
export function stopHealthChecks() {
  clearInterval(timer)
  timer = null
}

export const _test = {
  setDevOf(fn) {
    devOf = fn
  },
  setStatfs(fn) {
    _setStatfs(fn)
  },
  setShareHealth(id, h) {
    if (h) netHealth.set(id, h)
    else netHealth.delete(id)
  },
  probeShare
}
