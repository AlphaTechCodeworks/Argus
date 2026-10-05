// Crash recovery for server recordings (main process). A worker that dies (crash, SIGKILL by its
// watchdog, the app itself killed) leaves its open segment files on disk without an index row
// (the 'segment' message is sent only after the close); housekeeping only deletes what the index
// knows, so such files would stay forever. When an NVR's worker (re)starts, recoverOrphans()
// looks through that NVR's folder on each location for segment files with no row and indexes
// them as they are (bytes kept; a trailing partial frame is harmless to playback):
//   startMs  the first .idx row (the first keyframe), else the minute in the file name
//   endMs    the file's last change (the last frame written), kept between startMs and startMs + 5 min
//            (never before the last .idx row)
//   keyframes  the .idx rows; bytes: the file size
// Only files last changed before the new worker started are touched: anything newer may be one
// the new worker is writing.
//
// Which folders, and who lists them (2026-09-30, perf report R8 / Task 8). The scan listed every hour
// folder the NVR has on the location, after every worker restart (about 12 a day): 15.7-30.3 s and
// about 3,000 listings on the NAS per restart at 4-5 days (verify-3), growing with the days kept (about
// 3 minutes at 30 days), and made from the main process, whose thread pool a stale share hangs for good.
// A worker can only have left without a row the files it had open when it died, and the ones it closed
// just before (their messages lost with it): those started after the camera's newest indexed file (or
// the file the worker announced open), and none before the worker itself started, which was when this
// location was last looked through (a location down then, and skipped, is looked through from the scan
// before). So after a restart only the hour folders from an hour before that are listed (recoverySince):
// 2 or 3 a camera, about 53 for an NVR of 26 cameras whatever the days kept. Every folder is still listed
// at the service's start, and at the next start of a worker after a scan that failed (it may have missed
// older files). The listings and the file reads are made by the location's share helper
// (share-calls.mjs), never by this process; the RAM spool, which is memory and has no helper, is read
// here with the helper's own code (share-ops.mjs).
// Now found only by the scan at the service's start: a file a writer gave up on ("location not writable":
// closed without a row, no crash) more than an hour before the camera's newest file.
import { basename, dirname, join, resolve } from 'node:path'
import { shareCall } from './share-calls.mjs'
import { makeShareOps } from './share-ops.mjs'

const CH_RE = /^\d{1,3}$/
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const HOUR_RE = /^\d{2}$/
const FILE_RE = /^(\d{2})-(\d{2})(?:-\d{1,2})?\.(h264|h265)$/
const MAX_SPAN_MS = 5 * 60_000
const HOUR_MS = 3_600_000
/**
 * After a restart, a camera's hour folders are listed from this long before the newest time its files
 * left open could start (a file is in the folder of its start, and a camera switching location can have
 * a file open a little before its newest row's).
 */
export const RECENT_MARGIN_MS = HOUR_MS
/** Up to this many hours from a camera's bound to the restart, its hour folders are named, not found by listing its days. */
const DIRECT_HOURS = 6
/** Folders listed per call to the helper (a folder of minute files and their .idx is about 6 KB of answer). */
const LIST_BATCH = 25
/** Files asked about per call to the helper. */
const INFO_BATCH = 50

const pad = (n) => String(n).padStart(2, '0')
const dayName = (ms) => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
const hourName = (ms) => pad(new Date(ms).getUTCHours())

/** The helper's file calls for a location read in this process (the RAM spool: memory, and no helper of its own). */
export function localCalls(loc) {
  const ops = makeShareOps({ id: loc.id, root: loc.path })
  return (op, args) => ops[op](args ?? {}, () => {})
}

/**
 * After a worker restart: for each camera, the earliest time a file left without a row can have
 * started, less RECENT_MARGIN_MS, as (ch) -> ms, or null for a camera nothing bounds (its whole tree is
 * listed). Such a file started after the camera's newest indexed file that started before the new
 * worker (a file closes, and gets its row, before the next opens), or the file the dead worker announced
 * open when that is earlier; and not before lastScanMs: the location's last scan that did not fail
 * found every file left before the worker then started (its beforeMs), which bounds a camera with neither.
 * missed: that scan was not the one at the dead worker's start (the location was down, and skipped): a
 * file an earlier worker left there is older than what has been indexed since, and only lastScanMs bounds.
 * @param {{ index: { newestStart: Function }, nvrId: string, beforeMs: number, opens?: { ch: number, startMs: number }[],
 *   lastScanMs?: number|null, missed?: boolean }} o
 */
export function recoverySince({ index, nvrId, beforeMs, opens = [], lastScanMs = null, missed = false }) {
  return (ch) => {
    const known = missed ? [] : [index.newestStart(String(nvrId), Number(ch), beforeMs), ...opens.filter((o) => Number(o.ch) === Number(ch)).map((o) => o.startMs)].filter(Number.isFinite)
    const bounds = [known.length ? Math.min(...known) : null, lastScanMs].filter(Number.isFinite)
    return bounds.length ? Math.max(...bounds) - RECENT_MARGIN_MS : null
  }
}

/**
 * Indexes the segment files of one NVR on one location that have no index row.
 * @param {{ index: {has, addSegment}, loc: {id, path}, nvrId: string, beforeMs: number,
 *   since?: ((ch: number) => number|null)|null, call?: (op: string, args: object) => Promise<any> }} opts
 *   since: null lists every folder (the service's start); else from each camera's bound (recoverySince) on.
 *   call: the file calls (share-ops.mjs readdir and segInfo); the location's share helper by default
 * @returns {Promise<object[]>} the rows added
 */
export async function recoverOrphans({ index, loc, nvrId, beforeMs, since = null, call = null }) {
  const ask = call ?? ((op, args) => shareCall(loc, op, args))
  const base = join(loc.path, String(nvrId))
  /** The folders in these folders whose names match `re`, with the folder they are in: [[path, parent]]. */
  const folders = async (dirs, re) => {
    const out = []
    for (let i = 0; i < dirs.length; i += LIST_BATCH) {
      for (const r of await ask('readdir', { dirs: dirs.slice(i, i + LIST_BATCH) })) {
        for (const e of r.entries ?? []) if (e.dir && re.test(e.name)) out.push([join(r.dir, e.name), r.dir])
      }
    }
    return out
  }
  // the camera folders, and for each the hour folders to list: named from its bound, or found by
  // listing its days (a bound over DIRECT_HOURS back, or none: every day)
  const hours = []
  const walk = new Map() // camera folder -> its bound (null: every folder)
  for (const [chDir] of await folders([base], CH_RE)) {
    const s = since ? since(Number(basename(chDir))) : null
    if (Number.isFinite(s) && beforeMs - s <= DIRECT_HOURS * HOUR_MS) {
      for (let h = Math.floor(s / HOUR_MS) * HOUR_MS; h <= beforeMs; h += HOUR_MS) hours.push(join(chDir, dayName(h), hourName(h)))
    } else walk.set(chDir, Number.isFinite(s) ? s : null)
  }
  if (walk.size) {
    const days = (await folders([...walk.keys()], DAY_RE)).filter(([d, chDir]) => walk.get(chDir) === null || basename(d) >= dayName(walk.get(chDir)))
    for (const [h, dayDir] of await folders(days.map(([d]) => d), HOUR_RE)) {
      const s = walk.get(dirname(dayDir))
      if (s === null || basename(dayDir) > dayName(s) || basename(h) >= hourName(s)) hours.push(h)
    }
  }
  const added = []
  for (let i = 0; i < hours.length; i += LIST_BATCH) {
    const found = []
    for (const r of await ask('readdir', { dirs: hours.slice(i, i + LIST_BATCH) })) {
      if (!r.entries) continue // not there (a named hour with nothing recorded), or not readable
      const hour = basename(r.dir)
      const dm = DAY_RE.exec(basename(dirname(r.dir)))
      if (!dm) continue
      const ch = Number(basename(dirname(dirname(r.dir))))
      for (const e of r.entries) {
        const fm = FILE_RE.exec(e.name)
        if (!fm || fm[1] !== hour) continue
        const path = join(r.dir, e.name)
        if (index.has(path)) continue
        found.push({ path, ch, named: Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(hour), Number(fm[2])) })
      }
    }
    for (let j = 0; j < found.length; j += INFO_BATCH) {
      const batch = found.slice(j, j + INFO_BATCH)
      const infos = await ask('segInfo', { paths: batch.map((f) => f.path) })
      batch.forEach((f, k) => {
        const st = infos[k]
        if (!st || st.error || !st.isFile || st.mtimeMs >= beforeMs) return
        if (index.has(f.path)) return // indexed meanwhile (another scan of this location)
        const startMs = st.firstKeyMs ?? f.named
        const lastKey = st.lastKeyMs ?? startMs
        const endMs = Math.round(Math.max(lastKey, Math.min(st.mtimeMs, startMs + MAX_SPAN_MS)))
        const seg = { nvr: String(nvrId), ch: f.ch, path: f.path, startMs, endMs, bytes: st.size, keyframes: st.keyframes, loc: loc.id }
        index.addSegment(seg)
        added.push(seg)
      })
    }
  }
  return added
}

// (NVR, location) -> { fullAt, doneTo }: its every folder looked through (or being) since this process
// started, for the worker started at fullAt; doneTo: the beforeMs of its last scan that did not fail (null
// while the first is running). Not there: the next recovery lists every folder (the first one, or after
// one that failed).
const scans = new Map()
const scanKey = (nvrId, loc) => `${nvrId}\n${loc.id}\n${resolve(loc.path)}`

/**
 * The recovery of one NVR's files on one location when its worker has started (nvrs.mjs recoverFor):
 * every folder the first time since this process started (and after a scan that failed), the hour
 * folders a worker can have left files in since the location's last scan after that. A helper that
 * stopped by itself is asked once more (a new one); any other failure is thrown, and the next recovery
 * lists every folder.
 * @param {{ index: object, loc: {id, path}, nvrId: string, beforeMs: number, prevSpawnMs?: number|null,
 *   opens?: object[], local?: boolean, call?: Function }} o  prevSpawnMs: when the dead worker started (null:
 *   not known); opens: the files it announced open; local: read in this process (the RAM spool)
 * @returns {Promise<{ added: object[], full: boolean, listed: number, ms: number }>}
 */
export async function recoverLocation({ index, loc, nvrId, beforeMs, prevSpawnMs = null, opens = [], local = false, call = null }) {
  const key = scanKey(nvrId, loc)
  let st = scans.get(key)
  const full = !st
  if (full) scans.set(key, (st = { fullAt: beforeMs, doneTo: null }))
  // (a first scan still running counts as done: if it fails, the next recovery lists every folder anyway)
  const lastScanMs = st.doneTo ?? st.fullAt
  const inner = call ?? (local ? localCalls(loc) : (op, args) => shareCall(loc, op, args))
  let listed = 0
  const counted = async (op, args) => {
    if (op === 'readdir') listed += args.dirs.length
    try {
      return await inner(op, args)
    } catch (e) {
      if (e?.code !== 'ESHAREGONE') throw e
      return inner(op, args) // (both calls only read)
    }
  }
  const t0 = Date.now()
  try {
    const since = full ? null : recoverySince({ index, nvrId, beforeMs, opens, lastScanMs, missed: lastScanMs !== prevSpawnMs })
    const added = await recoverOrphans({ index, loc, nvrId, beforeMs, since, call: counted })
    if (scans.get(key) === st) st.doneTo = Math.max(st.doneTo ?? beforeMs, beforeMs)
    return { added, full, listed, ms: Date.now() - t0 }
  } catch (e) {
    if (scans.get(key) === st) scans.delete(key)
    throw e
  }
}

const DOWNTIME_MIN_MS = 3000 // playback's gapMs: shorter holes are not reported

/**
 * At startup (or a worker restart), after recoverOrphans: a gap row for each recording camera from the
 * end of its newest segment (or gap row, when later) to atMs, so the index explains the time the
 * service or worker was down. Cameras without footage, and holes under 3 s, get none.
 * Only rows that started before atMs count: the new worker's own rows are none of the downtime. Its
 * 'recording starting after a restart' row (recorder.mjs) often lands first -- the recovery scan
 * before this lists the NVR's folders on every location -- and, counted, left the downtime itself (the
 * service or worker down) in no row at all after every deploy.
 * @param {{ index: {lastEnds, addGap}, nvrId: string, channels: number[], atMs: number, reason: string }} opts
 * @returns {object[]} the rows added
 */
export function downtimeGaps({ index, nvrId, channels, atMs, reason }) {
  const added = []
  for (const ch of channels) {
    const { segEnd, gapEnd } = index.lastEnds(nvrId, ch, atMs)
    if (segEnd == null) continue
    const fromMs = Math.max(segEnd, gapEnd ?? -Infinity)
    if (!(atMs - fromMs >= DOWNTIME_MIN_MS)) continue
    const g = { nvr: String(nvrId), ch: Number(ch), fromMs, toMs: atMs, reason }
    index.addGap(g)
    added.push(g)
  }
  return added
}

export const _test = {
  reset: () => scans.clear()
}
