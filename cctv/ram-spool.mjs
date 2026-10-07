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
// whatever has not been copied yet. When it is full (CCTV_RAM_SPOOL_GB, a quarter of the RAM by
// default) it rotates: the oldest footage in memory is deleted to make room (trimSpool), so it always
// holds the latest stretch rather than stopping. A local disk is the real answer.
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises'
import { existsSync, mkdirSync, statfsSync } from 'node:fs'
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
 * The memory location to hand the workers, or null: not on Linux, no /dev/shm, or switched off
 * (CCTV_RAM_SPOOL_GB=0). Full is not a reason: trimSpool makes room.
 * @param {{ index: { locationUse: (loc: string) => { bytes: number } }, cap?: number, platform?: string }} o
 */
export function spoolLocation({ index, cap = spoolCapBytes(), platform = process.platform, dir = SPOOL_DIR } = {}) {
  if (platform !== 'linux' || cap <= 0 || !index) return null
  if (!existsSync(dirname(dir))) return null
  try {
    mkdirSync(dir, { recursive: true, mode: 0o750 })
  } catch {
    return null
  }
  return { id: SPOOL_ID, path: dir, role: 'overflow' }
}

/**
 * Of the healthy locations, those the recorder can write to: not the archive ones (recorder.mjs #pickLocation
 * takes none of them). Whether memory records, and where it is copied to afterwards, are asked of these: with
 * a healthy archive counted, the outage buffer stayed off while the recorder had nowhere to write, and memory
 * could be copied onto the archive (audit of 2026-10-07).
 */
export const writableLocations = (locations) => (locations ?? []).filter((l) => l.role !== 'archive')

/** Deletion starts at this share of the cap and frees down to TRIM_TO, so it runs now and then, not every segment. */
export const TRIM_AT = 0.95
export const TRIM_TO = 0.85
// The disk under the spool keeps at least this much free whatever the index says: files it does not
// count (a segment still being written, its .idx) or another user of the same disk must never fill
// it, because a full disk would stop recording just when the spool is the only place left for it.
export const MIN_FREE_BYTES = 1.5 * 1024 ** 3

/** Free bytes on the filesystem holding `dir` (for this process), or null when it cannot be told. */
export function freeBytesOf(dir) {
  try {
    const st = statfsSync(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return null
  }
}

/**
 * Makes room: deletes the oldest footage in memory until it holds under TRIM_TO of the cap. Never
 * throws. Only ever touches files under the spool folder. A row of this location whose file is somewhere
 * else (the spool folder setting was changed while rows of the old folder remained) is forgotten when its
 * file is gone, and passed over when it is there: its file is not ours to delete.
 * @returns {Promise<{ removed: number, bytes: number }>}
 */
export async function trimSpool({ index, cap = spoolCapBytes(), dir = SPOOL_DIR, log = () => {}, freeOf = freeBytesOf }) {
  let removed = 0
  let bytes = 0
  try {
    let used = index.locationUse(SPOOL_ID).bytes
    // the disk itself running low: make that much room as well, whatever the cap says
    const free = freeOf(dir)
    const short = free !== null && free < MIN_FREE_BYTES ? MIN_FREE_BYTES - free : 0
    if (!short && used < cap * TRIM_AT) return { removed, bytes }
    const target = Math.min(cap * TRIM_TO, Math.max(0, used - short))
    // Rows passed over (outside the spool folder, their file still there) are not asked for again: the same
    // oldest 50 came back every time, nothing was removed, and the loop never ended, on the main thread
    // (audit of 2026-10-07). Each pass now removes a row or passes one over for good, or it is the last.
    const passed = new Set()
    let forgotten = 0
    while (used > target) {
      const rows = index.oldest(50 + passed.size, { loc: SPOOL_ID }).filter((r) => !passed.has(r.path))
      if (!rows.length) break
      for (const row of rows) {
        if (used <= target) break
        if (relative(dir, row.path).startsWith('..')) {
          if (existsSync(row.path)) passed.add(row.path)
          else {
            // nothing is there: the row held no memory, and counted against the cap
            index.remove(row.path)
            used -= row.bytes
            forgotten++
          }
          continue
        }
        index.remove(row.path)
        await unlink(row.path).catch(() => {})
        await unlink(`${row.path}.idx`).catch(() => {})
        used -= row.bytes
        bytes += row.bytes
        removed++
      }
    }
    if (forgotten) log(`[spool] forgot ${forgotten} index rows of files that are gone (outside the outage buffer's folder ${dir})`)
  } catch (e) {
    log(`[spool] making room failed: ${e.message}`)
  }
  if (removed) log(`[spool] outage buffer full: dropped the oldest ${removed} segments (${Math.round(bytes / 1e6)} MB) to keep recording`)
  return { removed, bytes }
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
      if (rel.startsWith('..')) {
        // not ours: never touched. Gone, its row points at nothing and still counts against the cap
        // (trimSpool): the row goes
        if (!existsSync(row.path)) index.remove(row.path)
        continue
      }
      // gone from memory (a restart: systemd clears /dev/shm for this service): nothing to copy,
      // and a row pointing at nothing would stop every later copy at this one
      if (!existsSync(row.path)) {
        index.remove(row.path)
        continue
      }
      let dest = join(target.path, rel)
      // The minute recording moved back from memory to the drive, both hold a file for it under the
      // same name, and the index takes one row per name ("UNIQUE constraint failed", 2026-09-26).
      // Both are real footage, so the copy from memory is kept beside it under its own name.
      if (index.has?.(dest) || existsSync(dest)) dest = dest.replace(/(.[^./]+)$/, '.spool$1')
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
