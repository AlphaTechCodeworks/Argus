// "Recent footage in RAM" (settings memory.recentMinutes; playback phase 3, ruling R3): the OS
// file cache holds it (the Linux page cache, the ZFS ARC on the R540), not this process.
//
// createWarmer(): each finished segment (a worker's {t:'segment'}, see nvrs.mjs) and its .idx are
// read once, start to end, as soon as they are reported. The bytes were written moments ago and
// are still cached, so the read is a memcpy, not a disk read (about 23 MB/s at full scale). That
// second access promotes the pages (page cache: inactive -> active list; ARC: MRU -> MFU), so
// recent minutes outlive streaming reads of old footage (exports, other playbacks). Nothing is
// kept here: one reused 1 MB buffer, one file at a time, a bounded queue. Setting 0 turns the
// warming off; the kernel still caches as it likes. The newest minute (the file still being
// written) needs no warming: playback reads it while it grows (R4).
//
// estimateRecentRam(): the RAM each choice needs, from the recording cameras' real bytes per
// minute (their newest segments in the index), next to the server's MemAvailable, for Settings.
import { readFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { RECENT_MINUTES, getSettings } from './settings.mjs'

const MINUTE = 60_000
/** Segments per camera the estimate averages over (its newest). */
export const SAMPLE_SEGMENTS = 5

/**
 * @param {{ minutes?: () => number, fs?: typeof fsp, now?: () => number, maxPending?: number, chunk?: number }} [opts]
 * @returns {{ onSegment(seg: { path: string, endMs: number }): void, idle(): Promise<void>,
 *   stats(): { warmed, files, bytes, skipped, dropped, errors, pending, busy, lastError } }}
 */
export function createWarmer({ minutes = () => getSettings().memory.recentMinutes, fs = fsp, now = Date.now, maxPending = 64, chunk = 1 << 20 } = {}) {
  const queue = [] // segments waiting, oldest first: { path, endMs }
  let running = null // the loop's promise while it works through the queue
  let buf = null // the one read buffer (allocated on first use)
  let warned = false
  const st = { warmed: 0, files: 0, bytes: 0, skipped: 0, dropped: 0, errors: 0, lastError: null }

  const minutesNow = () => {
    try {
      const m = Number(minutes())
      return Number.isFinite(m) && m > 0 ? m : 0
    } catch {
      return 0 // settings unreadable: as off
    }
  }
  const tooOld = (seg, m) => seg.endMs < now() - m * MINUTE

  /** Reads one file start to end into the shared buffer; returns the bytes read. */
  async function readThrough(path) {
    const fh = await fs.open(path, 'r')
    try {
      const { size } = await fh.stat()
      buf ??= Buffer.allocUnsafe(chunk)
      let pos = 0
      while (pos < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos)
        if (!bytesRead) break // shorter than its size said (truncated meanwhile): done
        pos += bytesRead
      }
      return pos
    } finally {
      await fh.close().catch(() => {})
    }
  }

  async function warm(seg) {
    const m = minutesNow()
    if (!m || tooOld(seg, m)) {
      st.skipped++ // turned off while it waited, or it is no longer recent
      return
    }
    try {
      for (const path of [seg.path, `${seg.path}.idx`]) {
        st.bytes += await readThrough(path)
        st.files++
      }
      st.warmed++
    } catch (e) {
      // e.g. ENOENT (housekeeping deleted it) or a read error: counted, never thrown
      st.errors++
      st.lastError = `${seg.path}: ${e.message}`
      if (!warned) {
        warned = true
        console.warn(`[rec-cache] could not read ${seg.path} into the file cache: ${e.message} (further errors are only counted)`)
      }
    }
  }

  const kick = () => {
    if (running) return
    running = (async () => {
      try {
        while (queue.length) await warm(queue.shift())
      } finally {
        running = null
      }
    })()
  }

  return {
    /** A finished segment ({t:'segment'} from a worker): queued for one read when the setting is on. */
    onSegment(seg) {
      if (!seg || typeof seg.path !== 'string' || !seg.path) return
      const m = minutesNow()
      if (!m) return
      const s = { path: seg.path, endMs: Number(seg.endMs) }
      if (tooOld(s, m)) {
        st.skipped++
        return
      }
      queue.push(s)
      while (queue.length > maxPending) {
        queue.shift() // the oldest: the newest footage matters most
        st.dropped++
      }
      kick()
    },
    /** Resolves once the queue is empty and nothing is being read. */
    async idle() {
      while (running) await running
    },
    stats: () => ({ ...st, pending: queue.length, busy: running !== null })
  }
}

/** MemAvailable from /proc/meminfo in bytes, or null (not Linux, unreadable, no such line). */
export function memAvailableBytes(readMeminfo = () => readFileSync('/proc/meminfo', 'utf8')) {
  try {
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(String(readMeminfo()))
    return m ? Number(m[1]) * 1024 : null
  } catch {
    return null
  }
}

/**
 * The RAM each memory.recentMinutes choice needs. Each camera whose recording mode is not 'off'
 * contributes the average bytes per minute of its newest SAMPLE_SEGMENTS segments
 * (sum(bytes) / sum(endMs - startMs) * 60000). A recording camera without segments yet is counted
 * in `cameras` but not in `measured` or the figures.
 * The cameras looked at: `list` ({ nvr, ch }: the NVRs' cameras) when given, else the index's
 * cameras (index.cameras(): an index search, under a millisecond on the site), plus
 * every camera with a per-camera setting.
 * @param {{ index: object|null, settings?: object, readMeminfo?: () => string, choices?: number[], list?: {nvr, ch}[]|null }} opts
 * @returns {{ perMinuteBytes: number, byMinutes: Record<number, number>, cameras: number, measured: number, memAvailableBytes: number|null }}
 */
export function estimateRecentRam({ index, settings = getSettings(), readMeminfo, choices = RECENT_MINUTES, list = null } = {}) {
  const rec = settings?.recording ?? {}
  const overrides = rec.cameras ?? {}
  const modeOf = (key) => overrides[key]?.mode ?? rec.defaults?.mode ?? 'off'
  const cams = new Map() // "<nvr>/<ch>" -> { nvr, ch }
  const add = (nvr, ch) => {
    if (nvr === undefined || nvr === null || nvr === '' || !Number.isInteger(Number(ch))) return
    cams.set(`${nvr}/${Number(ch)}`, { nvr: String(nvr), ch: Number(ch) })
  }
  if (Array.isArray(list)) for (const c of list) add(c?.nvr, c?.ch)
  else if (index) {
    try {
      for (const c of index.cameras()) add(c.nvr, c.ch)
    } catch {}
  }
  for (const key of Object.keys(overrides)) {
    const i = key.lastIndexOf('/')
    if (i > 0) add(key.slice(0, i), key.slice(i + 1))
  }
  let perMinute = 0
  let cameras = 0
  let measured = 0
  for (const [key, { nvr, ch }] of cams) {
    if (modeOf(key) === 'off') continue
    cameras++
    let segs = []
    try {
      segs = index?.recentOf(nvr, ch, SAMPLE_SEGMENTS) ?? []
    } catch {}
    let bytes = 0
    let ms = 0
    for (const s of segs) {
      const d = Number(s.endMs) - Number(s.startMs)
      const b = Number(s.bytes)
      if (d > 0 && b >= 0) {
        bytes += b
        ms += d
      }
    }
    if (ms > 0) {
      perMinute += (bytes / ms) * MINUTE
      measured++
    }
  }
  const byMinutes = {}
  for (const m of choices) if (m > 0) byMinutes[m] = Math.round(perMinute * m)
  return {
    perMinuteBytes: Math.round(perMinute),
    byMinutes,
    cameras,
    measured,
    memAvailableBytes: readMeminfo ? memAvailableBytes(readMeminfo) : memAvailableBytes()
  }
}
