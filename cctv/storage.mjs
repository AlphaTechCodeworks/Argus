// Storage locations for server recordings: folders (a ZFS pool, a USB drive's mount point, a
// network share) listed in settings.storage.locations, each with a marker file. A location
// without its marker is never written: an empty mount point (drive unplugged, share down)
// must not fill up the system disk.
//
//   location: { id, path, type: 'internal'|'usb'|'network', role: 'main'|'overflow'|'archive',
//               limitGB: number|null, sameDisk?: true, added, addedBy }
//   <path>/.cctv-recordings: { id, created }   (the marker)
//   health:   { ok, reason, marker, writable, freeBytes, totalBytes, writeMBps }
//
// Recording goes to the camera's own location when healthy, else a healthy main one, else a
// healthy overflow one (archive locations are for moving old footage to, later).
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, statSync, statfsSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { HttpError, isPlainObject } from './nvr-xml.mjs'
import { cameraRecording, getSettings, saveSettings } from './settings.mjs'

export const MARKER = '.cctv-recordings'
export const TYPES = ['internal', 'usb', 'network']
export const ROLES = ['main', 'overflow', 'archive']
const PROBE_BYTES = 8 * 1024 * 1024
const CHECK_EVERY_MS = 30_000

// replaceable for the offline tests
let devOf = (p) => statSync(p).dev
let statfs = (p) => statfsSync(p)

export const freePercent = (h) => (h.totalBytes > 0 ? (h.freeBytes / h.totalBytes) * 100 : 0)

const writeMBps = new Map() // id -> last write-speed probe (MB/s)

/** The marker's id, or null (missing or unreadable). */
function markerId(path) {
  try {
    const j = JSON.parse(readFileSync(join(path, MARKER), 'utf8'))
    return typeof j?.id === 'string' ? j.id : null
  } catch {
    return null
  }
}

/** Whether the location's folder holds its own marker (the drive/share is really there). */
export const markerMatches = (loc) => markerId(loc.path) === loc.id

function canWrite(path) {
  const f = join(path, `.cctv-write-test-${process.pid}`)
  try {
    writeFileSync(f, 'x')
    unlinkSync(f)
    return true
  } catch {
    try {
      unlinkSync(f)
    } catch {}
    return false
  }
}

/** Health of one location, without the write-speed probe (fast, synchronous). */
function healthOf(loc, floorFreePct) {
  const h = { ok: false, reason: '', marker: false, writable: false, freeBytes: 0, totalBytes: 0, writeMBps: writeMBps.get(loc.id) ?? null }
  let st
  try {
    st = statSync(loc.path)
  } catch {
    h.reason = 'folder missing (drive or share not connected?)'
    return h
  }
  if (!st.isDirectory()) {
    h.reason = 'not a folder'
    return h
  }
  const id = markerId(loc.path)
  if (!id) {
    h.reason = 'no marker file: not prepared, or the drive/share is not mounted'
    return h
  }
  if (id !== loc.id) {
    h.reason = `the marker belongs to another location (${id}): a different drive is mounted here`
    return h
  }
  h.marker = true
  try {
    const s = statfs(loc.path)
    h.freeBytes = Number(s.bavail) * Number(s.bsize)
    h.totalBytes = Number(s.blocks) * Number(s.bsize)
  } catch (e) {
    h.reason = `free space unknown: ${e.message}`
    return h
  }
  h.writable = canWrite(loc.path)
  if (!h.writable) {
    h.reason = 'not writable'
    return h
  }
  const pct = freePercent(h)
  if (pct < floorFreePct) {
    h.reason = `below the hard floor (${pct.toFixed(1)}% free, floor ${floorFreePct}%)`
    return h
  }
  h.ok = true
  return h
}

const withHealth = (loc, floor) => ({
  id: loc.id,
  path: loc.path,
  type: loc.type,
  role: loc.role,
  limitGB: loc.limitGB ?? null,
  ...(loc.sameDisk ? { sameDisk: true } : {}),
  health: healthOf(loc, floor)
})

/** Every location with its current health. */
export function listLocations() {
  const s = getSettings()
  return s.storage.locations.map((l) => withHealth(l, s.storage.floorFreePct))
}

/**
 * Measures write speed: writes a small temp file (fsync'd) in the folder, then removes it.
 * @returns {Promise<number>} MB/s
 */
export async function probeWriteSpeed(path, bytes = PROBE_BYTES) {
  const f = join(path, `.cctv-speed-test-${process.pid}-${randomBytes(3).toString('hex')}`)
  const buf = Buffer.alloc(1024 * 1024, 0x5a)
  let fd
  const t0 = process.hrtime.bigint()
  try {
    fd = openSync(f, 'w')
    for (let n = 0; n < bytes; n += buf.length) writeSync(fd, buf, 0, Math.min(buf.length, bytes - n))
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(f)
    } catch {}
  }
  const s = Math.max(Number(process.hrtime.bigint() - t0) / 1e9, 1e-6)
  return Math.round((bytes / 1e6 / s) * 10) / 10
}

const cleanRole = (v) => {
  if (!ROLES.includes(v)) throw new HttpError(400, `role must be one of: ${ROLES.join(', ')}`)
  return v
}
const cleanLimit = (v) => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1e7) throw new HttpError(400, 'limitGB must be a positive number of GB, or empty for no limit')
  return v
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
  limitGB = cleanLimit(limitGB)
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
  const id = existing ?? `loc-${randomBytes(4).toString('hex')}`
  if (!existing) writeFileSync(join(path, MARKER), `${JSON.stringify({ id, created: new Date().toISOString() })}\n`, { flag: 'wx' })
  const loc = { id, path, type, role, limitGB, ...(sameAsSystem ? { sameDisk: true } : {}), added: new Date().toISOString(), addedBy: user ?? '?' }
  saveLocations([...s.storage.locations, loc], user)
  console.log(`[storage] ${user} added ${id} at ${path} (${type}, ${role})${sameAsSystem ? ' on the system disk' : ''}`)
  return withHealth(loc, s.storage.floorFreePct)
}

/** Changes role and/or space limit. */
export function updateLocation(id, fields, user) {
  if (!isPlainObject(fields)) throw new HttpError(400, 'bad fields')
  const s = getSettings()
  const loc = s.storage.locations.find((l) => l.id === id)
  if (!loc) throw new HttpError(404, 'No such location')
  if ('role' in fields) loc.role = cleanRole(fields.role)
  if ('limitGB' in fields) loc.limitGB = cleanLimit(fields.limitGB)
  saveLocations(s.storage.locations, user)
  console.log(`[storage] ${user} changed ${id}: role ${loc.role}, limit ${loc.limitGB ?? 'none'}`)
  return withHealth(loc, s.storage.floorFreePct)
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

/** Checks every location now (with probe: also measures write speed) and tells listeners of changes. */
export async function checkHealth({ probe = false } = {}) {
  if (probe) {
    for (const l of listLocations()) {
      if (!l.health.ok) continue
      try {
        writeMBps.set(l.id, await probeWriteSpeed(l.path))
      } catch (e) {
        console.warn(`[storage] write-speed probe on ${l.path} failed: ${e.message}`)
      }
    }
  }
  const list = listLocations()
  const summary = JSON.stringify(list.map((l) => [l.id, l.health.ok, l.health.reason]))
  if (summary !== lastSummary) {
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
  return list
}

let timer = null
let checks = 0
/** Starts the 30-second health checks (write speed measured every 10 minutes). */
export function startHealthChecks(everyMs = CHECK_EVERY_MS) {
  if (timer) return
  const tick = () => checkHealth({ probe: checks++ % 20 === 0 }).catch((e) => console.warn(`[storage] health check failed: ${e.message}`))
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
    statfs = fn
  }
}
