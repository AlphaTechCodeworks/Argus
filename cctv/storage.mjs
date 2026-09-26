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
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { MARKER, _setStatfs, freePercent, healthOf, markerId, probeWriteSpeed } from './location-health.mjs'
import { HttpError, isPlainObject } from './nvr-xml.mjs'
import { cameraRecording, getSettings, saveSettings } from './settings.mjs'

export { MARKER, freePercent, probeWriteSpeed }
export const TYPES = ['internal', 'usb', 'network']
export const ROLES = ['main', 'overflow', 'archive']
const CHECK_EVERY_MS = 30_000
/** How long a network share gets to answer its check before it is called down. */
export const SHARE_ANSWER_MS = 10_000

// replaceable for the offline tests
let devOf = (p) => statSync(p).dev

const writeMBps = new Map() // id -> last write-speed probe (MB/s)

// ---- network shares: never touched by this process -----------------------------------------------
//
// A share whose SMB session has gone stale takes any file call made on it and never gives it back,
// and the process that made it cannot even be killed. On 2026-09-26 that froze the whole server
// twice. So this process never makes a file call on a share to learn its health: a child process
// (location-probe.mjs) does, with SHARE_ANSWER_MS to answer, and what it last said is the share's
// health. A child that does not answer leaves the share marked down, and no second child is sent
// after it while the first is still stuck.

let PROBE = join(import.meta.dirname, 'location-probe.mjs')
const netHealth = new Map() // id -> last health
const stuck = new Map() // id -> { since } while a probe has not come back

const downHealth = (reason) => ({ ok: false, reason, marker: false, writable: false, freeBytes: 0, totalBytes: 0, writeMBps: null })

/** Checks one share from a child process. Always resolves, within SHARE_ANSWER_MS. */
function probeShare(loc, floor, speed) {
  const prev = stuck.get(loc.id)
  if (prev) return Promise.resolve(downHealth(`share not answering: a check has been stuck for ${Math.round((Date.now() - prev.since) / 1000)} s`))
  return new Promise((done) => {
    let settled = false
    const finish = (h) => {
      if (!settled) {
        settled = true
        done(h)
      }
    }
    const since = Date.now()
    stuck.set(loc.id, { since })
    const child = execFile(process.execPath, [PROBE, JSON.stringify({ id: loc.id, path: loc.path }), String(floor), speed ? 'speed' : ''], { timeout: SHARE_ANSWER_MS * (speed ? 3 : 1), killSignal: 'SIGKILL' }, (err, out) => {
      stuck.delete(loc.id)
      try {
        if (err) throw err
        finish(JSON.parse(String(out).trim()))
      } catch (e) {
        finish(downHealth(err?.killed ? 'share not answering' : `share check failed: ${e.message}`))
      }
    })
    child.unref()
    // the child may be stuck where even SIGKILL cannot reach it: do not wait for it to exit
    setTimeout(() => finish(downHealth('share not answering')), SHARE_ANSWER_MS * (speed ? 3 : 1) + 500).unref()
  })
}

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

const withHealth = (loc, floor) => ({
  id: loc.id,
  path: loc.path,
  type: loc.type,
  role: loc.role,
  limitGB: loc.limitGB ?? null,
  ...(loc.sameDisk ? { sameDisk: true } : {}),
  health: locationHealth(loc, floor)
})

/** Every location with its current health. Never waits on a network share. */
export function listLocations() {
  const s = getSettings()
  return s.storage.locations.map((l) => withHealth(l, s.storage.floorFreePct))
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
  if (type === 'network') checkHealth().catch(() => {}) // its health is not known until checked
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
  const s = getSettings()
  const floor = s.storage.floorFreePct
  // shares all at once, each in its own process; a stuck one costs SHARE_ANSWER_MS, not the server
  await Promise.all(s.storage.locations.filter((l) => l.type === 'network').map(async (l) => {
    const h = await probeShare(l, floor, probe)
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
  probeShare,
  setProbe(p) {
    PROBE = p
  }
}
