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
