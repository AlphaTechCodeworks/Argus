// Recording into memory while no drive can take it, and onto a drive as soon as one can.
//
// On 2026-09-26 the NAS stopped serving files for hours; it was the only recording location, so
// for those hours the server recorded nothing. The machine had 10 GB of memory doing nothing. This
// puts it to use: when every storage location is down, the workers are handed one more location,
// a folder in /dev/shm (which Linux keeps in RAM), and record there. When a real location is healthy
// again, drainSpool() copies each finished segment across, points its index row at the new file,
// and deletes it from memory -- oldest first, a batch at a time, so the drive is not flooded.
//
// What it is and is not: the cameras' main streams fill memory quickly (roughly 10 GB is minutes
// for a site's worth of 4K cameras, hours for a few), so this rides out a blip, a restart of the
// NAS, a cable pulled for a minute. It is not a place to keep footage: a server restart loses
// whatever has not been copied yet, and when it is full (CCTV_RAM_SPOOL_GB, a quarter of the RAM by
// default) recording stops again, with the gap logged as before. A local disk is the real answer.
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { totalmem } from 'node:os'
import { dirname, join, relative } from 'node:path'

export const SPOOL_ID = 'ram-spool'
export const SPOOL_DIR = process.env.CCTV_RAM_SPOOL_DIR ?? '/dev/shm/argus-spool'
/** Segments moved per drain pass: steady, not a flood onto a share that has just come back. */
export const DRAIN_BATCH = 120

/** The most footage memory may hold, in bytes. */
export function spoolCapBytes(env = process.env, ram = totalmem()) {
  const gb = Number(env.CCTV_RAM_SPOOL_GB)
  if (Number.isFinite(gb) && gb >= 0) return gb * 1024 ** 3
  return Math.floor(ram / 4)
}

/**
 * The memory location to hand the workers, or null: not on Linux, no /dev/shm, switched off
 * (CCTV_RAM_SPOOL_GB=0), or already full.
 * @param {{ index: { locationUse: (loc: string) => { bytes: number } }, cap?: number, platform?: string }} o
 */
export function spoolLocation({ index, cap = spoolCapBytes(), platform = process.platform, dir = SPOOL_DIR } = {}) {
  if (platform !== 'linux' || cap <= 0 || !index) return null
  if (!existsSync(dirname(dir))) return null
  if (index.locationUse(SPOOL_ID).bytes >= cap) return null
  try {
    mkdirSync(dir, { recursive: true, mode: 0o750 })
  } catch {
    return null
  }
  return { id: SPOOL_ID, path: dir, role: 'overflow' }
}

/**
 * Moves finished segments from memory to `target`, oldest first. Never throws.
 * @returns {Promise<{ moved: number, bytes: number, left: number, error?: string }>}
 */
export async function drainSpool({ index, target, dir = SPOOL_DIR, batch = DRAIN_BATCH, log = () => {} }) {
  let moved = 0
  let bytes = 0
  try {
    for (const row of index.oldest(batch, { loc: SPOOL_ID })) {
      const rel = relative(dir, row.path)
      if (rel.startsWith('..')) continue // not ours: never touched
      const dest = join(target.path, rel)
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(row.path, dest)
      const idx = `${row.path}.idx`
      if (existsSync(idx)) await copyFile(idx, `${dest}.idx`)
      // the copy is complete before the row moves, and the row moves before memory is freed:
      // at no point is the footage only in a place nothing points to
      const size = (await stat(dest)).size
      index.moveSegment(row.path, dest, target.id)
      await unlink(row.path).catch(() => {})
      await unlink(idx).catch(() => {})
      moved++
      bytes += size
    }
  } catch (e) {
    const left = index.locationUse(SPOOL_ID).segments
    log(`[spool] copying to ${target.path} stopped: ${e.message} (${left} segments still in memory)`)
    return { moved, bytes, left, error: e.message }
  }
  const left = index.locationUse(SPOOL_ID).segments
  if (moved) log(`[spool] moved ${moved} segments (${Math.round(bytes / 1e6)} MB) from memory to ${target.path}; ${left} left`)
  return { moved, bytes, left }
}
