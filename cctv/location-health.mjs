// How healthy a storage location is, read straight off the disk. Synchronous, so it is only ever
// called directly for local drives; network shares are checked by their helper, a process of their
// own, with share-ops.mjs's asynchronous copy of the same steps (see share-calls.mjs).
import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, statSync, statfsSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export const MARKER = '.cctv-recordings'
const PROBE_BYTES = 8 * 1024 * 1024

// replaceable for the offline tests
let statfs = (p) => statfsSync(p)
export const _setStatfs = (fn) => {
  statfs = fn
}

export const freePercent = (h) => (h.totalBytes > 0 ? (h.freeBytes / h.totalBytes) * 100 : 0)

/**
 * A location's free-space marks: its own (location.lowFreePct / floorFreePct) where set, else the
 * settings' (storage.lowFreePct / floorFreePct). Each location's own since 2026-09-29: the NAS is a share
 * with 3.44 TB of other backups on it, and the owner's 12 TB for Argus is usable only with its low mark
 * near 7 %, where a USB drive of Argus's own is better at the default 15 % (perf report D1).
 * settings.mjs keeps floor < low for every location.
 * @returns {{ lowFreePct: number, floorFreePct: number }}
 */
export function freeMarks(settings, loc) {
  const s = settings?.storage ?? {}
  const own = (v) => (Number.isInteger(v) ? v : null)
  return { lowFreePct: own(loc?.lowFreePct) ?? s.lowFreePct ?? 15, floorFreePct: own(loc?.floorFreePct) ?? s.floorFreePct ?? 5 }
}

/**
 * A location's space limit for Argus's recordings (limitGB, 1 GB = 1,000,000,000 bytes) and whether it
 * is enforced. Enforced (housekeeping.mjs deletes down to it) only once saved through storage.mjs since
 * 2026-09-29, which checks it against the drive's or share's size, asks first on the page, and stamps
 * limitSetAt. Before that the limit was a note: the old page saved it with no question and no check, so
 * a value saved then must not start deleting on the first run after the deploy (review of p2-delete).
 * @returns {{ gb: number|null, bytes: number|null, enforced: boolean }}
 */
export function spaceLimit(loc) {
  const gb = Number(loc?.limitGB)
  if (!(gb > 0) || !Number.isFinite(gb)) return { gb: null, bytes: null, enforced: false }
  return { gb, bytes: gb * 1e9, enforced: typeof loc.limitSetAt === 'string' && loc.limitSetAt !== '' }
}

/** The size in bytes of the filesystem holding `path`, or null. Synchronous: local drives only. */
export function sizeOfFolder(path) {
  try {
    const s = statfs(path)
    const t = Number(s.blocks) * Number(s.bsize)
    return t > 0 ? t : null
  } catch {
    return null
  }
}

/** The marker's id, or null (missing or unreadable). */
export function markerId(path) {
  try {
    const j = JSON.parse(readFileSync(join(path, MARKER), 'utf8'))
    return typeof j?.id === 'string' ? j.id : null
  } catch {
    return null
  }
}

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

/** Health of one location, without the write-speed probe. */
export function healthOf(loc, floorFreePct, writeMBps = null) {
  const h = { ok: false, reason: '', marker: false, writable: false, freeBytes: 0, totalBytes: 0, writeMBps }
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
