// How the jobs that delete footage delete it (housekeeping.mjs; thinning.mjs runRetention), since
// 2026-09-29 (perf report R2 / Task 3 and its check verify-2):
//
//   makeDeleter({ share, loc, index, ... })   files go to the location's helper (share-calls.mjs) in
//                                             batches of DELETE_BATCH; a batch's index rows go in one
//                                             transaction, and only for the files the helper confirmed
//   CameraCursors                             each camera's oldest rows on one location, asked for once
//                                             per run (one statement), refilled 50 at a time
//   Heap                                      the merge of those cursors, by whatever order a job wants
//   checkFreeRose / freeingStalled            a location where deleting does not free space (a recycle
//                                             bin or snapshots on the NAS) stops being deleted from for
//                                             free space, instead of deleting more every run
//
// Why. The deletion jobs did their file calls on the main thread (unlinkSync of each file and its
// .idx, rmdirSync of its folder, statfsSync of the share after every file) and picked each file by
// asking every camera again for its oldest 50 rows (22.8 ms for 87 cameras). At the NAS's 5 % floor
// each 5-minute run deletes what 5 minutes recorded, about 470 files: 12-15 s of frozen live video,
// pages and alarm checks every run, and a stale share would hang the whole server in the first
// unlinkSync (perf report R2). Now the main thread only decides; the helper process makes the calls.
//
// The safeguards stay where they were and are not loosened here: the callers check the marker and
// that a file is inside its location's folder, and skip bookmarked stretches; the helper checks the
// marker again (read at that moment) and the folder on its own, and refuses anything else.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DATA_DIR } from './auth.mjs'

/** Files per call to the helper (each file and its .idx is two file calls; each one that comes back restarts its clock). */
export const DELETE_BATCH = 100
/** Rows asked for per camera at a run's first look, and at each look after that. */
export const FIRST_ROWS = 8
export const MORE_ROWS = 50

const n = (x) => Number(x) || 0

/**
 * A deleter for one location: add() segments as a job picks them; every DELETE_BATCH they go to the
 * location's helper, and the rows of the files it confirmed are removed from the index.
 * @param {{ share: Function, loc: { id, path }, index: object,
 *           keepDirs?: () => Set<string>|null,
 *           onDeleted?: (seg, why) => void, onFailed?: (seg, error, why) => void, onStop?: (message, code) => void }} o
 *   keepDirs: folders the index says still hold a row (not worth an rmdir; an rmdir of a folder with a
 *   file in it fails anyway, it only costs a call on the share)
 *   beforeBatch: asked before each batch goes; a text stops the deleter with that as its reason (the
 *   switch in front of runRetention, set to Off during a run)
 */
export function makeDeleter({ share, loc, index, keepDirs = null, beforeBatch = null, onDeleted, onFailed, onStop, batch = DELETE_BATCH }) {
  let pending = [] // [{ seg, why }]
  const d = {
    pendingBytes: 0,
    pendingPaths: new Set(),
    /** Bytes of the files the helper confirmed deleted. */
    doneBytes: 0,
    doneFiles: 0,
    /** Why the location was given up on in this run (the helper stuck or gone, the marker gone), or null. */
    stopped: null,
    stopCode: null,
    /** Queues a segment; sends the batch when it is full. false when the location was given up on. */
    async add(seg, why) {
      if (d.stopped) return false
      pending.push({ seg, why })
      d.pendingBytes += n(seg.bytes)
      d.pendingPaths.add(seg.path)
      if (pending.length >= batch) await d.flush()
      return !d.stopped
    },
    /** Sends what is queued. */
    async flush() {
      if (!pending.length || d.stopped) return
      const halt = beforeBatch?.()
      if (halt) return stop(halt, 'EHALT')
      const list = pending
      pending = []
      d.pendingBytes = 0
      d.pendingPaths = new Set()
      const bySeg = new Map(list.map((x) => [x.seg.path, x]))
      let results
      try {
        results = await share(loc, 'unlink', { paths: list.map((x) => x.seg.path), withIdx: true })
      } catch (e) {
        // not answering (the share is marked down: share-calls.mjs), the helper gone, the marker gone:
        // nothing more on this location in this run. What the helper did delete before it stopped is
        // "not there" next time, which counts as deleted then (its row goes too).
        return stop(e.code === 'EMARKER' ? `its marker is not there any more (${e.message}): nothing more deleted on it in this run` : `${e.message}: nothing more deleted on it in this run`, e.code ?? null)
      }
      const gone = []
      let markerLost = false
      for (const r of Array.isArray(results) ? results : []) {
        const x = bySeg.get(r?.path)
        if (!x) continue
        bySeg.delete(r.path)
        if (r.ok) gone.push(x)
        else if (r.error === 'EMARKER') markerLost = true
        else onFailed?.(x.seg, `${r.error}${r.file && r.file !== r.path ? ` (${r.file})` : ''}`, x.why)
      }
      // an answer without a line for a file: not deleted, as far as anyone knows (its row stays)
      for (const x of bySeg.values()) onFailed?.(x.seg, 'no answer for it', x.why)
      if (gone.length) {
        index.removeMany(gone.map((x) => x.seg.path))
        for (const x of gone) {
          d.doneBytes += n(x.seg.bytes)
          d.doneFiles++
          onDeleted?.(x.seg, x.why)
        }
        // the folders these files leave empty (hour, then day, camera, NVR, while empty; never the
        // location itself: the helper's rule), except those the index says still hold a file
        const keep = keepDirs?.() ?? null
        const dirs = [...new Set(gone.map((x) => dirname(resolve(x.seg.path))))].filter((dir) => !keep?.has(dir))
        if (dirs.length) {
          try {
            await share(loc, 'rmdir', { dirs })
          } catch (e) {
            if (e.code === 'ESHARESTUCK' || e.code === 'ESHAREGONE') return stop(`${e.message}: nothing more deleted on it in this run`, e.code)
          }
        }
      }
      if (markerLost) stop('its marker went while files were being deleted (unmounted?): nothing more deleted on it in this run', 'EMARKER')
    }
  }
  function stop(message, code) {
    d.stopped = message
    d.stopCode = code
    pending = []
    d.pendingBytes = 0
    d.pendingPaths = new Set()
    onStop?.(message, code)
  }
  return d
}

/** The folder a segment's file is in (as the helper resolves it). */
export const dirOf = (seg) => dirname(resolve(seg.path))

/**
 * Each camera's rows on one location, oldest first, read as they are needed: one statement for every
 * camera's first FIRST_ROWS (index.oldestPerCamera), then MORE_ROWS more for a camera that runs out
 * (index.oldestOf from where it got to). Rows a job passes over (bookmarked, outside the folder, a
 * file that would not go) stay passed over for the rest of the run. `fromMs`: every camera starts
 * there (firstUnprotected: the rows before it are all bookmarked). skipTo() steps a camera over a
 * bookmarked stretch with one look instead of a row at a time.
 */
export class CameraCursors {
  /** @param {{ index: object, locId: string, cams: { nvr, ch }[], fromMs?: number|null }} o */
  constructor({ index, locId, cams, fromMs = null, first = FIRST_ROWS, more = MORE_ROWS }) {
    this.index = index
    this.locId = locId
    this.fromMs = fromMs
    this.first = first
    this.more = more
    this.filled = false
    // from: where the camera's next look starts when it is not simply on from its last row (skipTo)
    this.list = cams.map((c, order) => ({ key: `${c.nvr}/${c.ch}`, nvr: c.nvr, ch: c.ch, order, rows: [], i: 0, full: false, done: false, lastStart: null, atLast: new Set(), from: null }))
  }

  fill() {
    if (this.filled) return
    this.filled = true
    if (!this.list.length) return
    const byKey = new Map(this.list.map((c) => [c.key, c]))
    const rows = this.fromMs === null ? this.index.oldestPerCamera(this.locId, this.list, this.first) : this.index.oldestPerCamera(this.locId, this.list, this.first, this.fromMs)
    for (const r of rows) byKey.get(`${r.nvr}/${r.ch}`)?.rows.push(r)
    for (const c of this.list) {
      c.full = c.rows.length >= this.first
      if (!c.rows.length) c.done = true
    }
  }

  /** The camera's next row, asking the index for more when its rows run out; null when there is none. */
  head(c) {
    this.fill()
    while (!c.done && c.i >= c.rows.length) {
      if (!c.full) {
        c.done = true
        break
      }
      // from the last start passed, that one included (another file may start in the same millisecond),
      // less the rows already passed there; or from the end of a stretch skipTo() stepped over
      const from = c.from ?? c.lastStart ?? this.fromMs ?? Number.MIN_SAFE_INTEGER
      const raw = this.index.oldestOf(c.nvr, c.ch, this.locId, this.more, from)
      const rows = c.from !== null ? raw : raw.filter((r) => !(r.startMs === c.lastStart && c.atLast.has(r.path)))
      c.from = null
      c.rows = rows
      c.i = 0
      c.full = raw.length >= this.more
      // (a full answer made only of rows already passed -- more than MORE_ROWS files starting in the
      // same millisecond, never written on purpose -- would be asked for again for ever)
      if (!rows.length) c.done = true
    }
    return c.done ? null : c.rows[c.i]
  }

  /**
   * Moves the camera past every row that starts before `fromMs` (the end of a bookmarked stretch): the
   * rows already read are passed here, and if they run out the camera's next look starts at fromMs, so
   * the rows in between are never read. Nothing is asked of the index here.
   */
  skipTo(c, fromMs) {
    this.fill()
    while (c.i < c.rows.length && c.rows[c.i].startMs < fromMs) this.next(c)
    if (c.done || c.i < c.rows.length) return
    if (!c.full) {
      c.done = true // its last look was not full: there is nothing after these
      return
    }
    c.from = Math.max(c.from ?? Number.MIN_SAFE_INTEGER, fromMs)
    c.lastStart = null
    c.atLast = new Set()
  }

  /** The camera's next row if it is already here (never asks the index); null otherwise. */
  peek(c) {
    return this.filled && !c.done && c.i < c.rows.length ? c.rows[c.i] : null
  }

  /** Moves past the camera's current row (taken for deletion, or passed over). */
  next(c) {
    const r = c.rows[c.i++]
    if (!r) return
    if (r.startMs !== c.lastStart) c.atLast = new Set()
    c.lastStart = r.startMs
    c.atLast.add(r.path)
  }
}

/** Where a walk goes on after a protected stretch [from, to] (thinning.mjs protectionFor's stretchOf): the first start after it. Starts are whole milliseconds. */
export const afterStretch = (st) => Math.floor(st[1]) + 1

/**
 * Where a deletion job's walk of one location can start: the first row, oldest first, that no protected
 * stretch of its own camera covers (`row`, null when there is none). Every row that starts before `row`
 * is protected.
 * Bookmarked footage is never deleted, so it stays the oldest there for good; walking it row by row was
 * every run's cost (review of p2-delete, 2026-09-29). Here a stretch costs a look at most: the rows that
 * start inside it are all protected and are not read. A file that starts before a stretch and runs into
 * it is protected too, and passed by itself.
 *
 * Camera by camera since 2026-09-30 (a bookmark keeps the cameras it names; thinning.mjs protectionFor).
 * The walk took the oldest rows of the whole location and jumped each stretch for every camera, which is
 * right only for a stretch that keeps every camera (guard.commonOf: those are still jumped for every
 * camera in one statement). A camera's own stretch is stepped over by that camera alone (CameraCursors:
 * its next rows read after the stretch, MORE_ROWS at a time), oldest first across the cameras (a heap).
 * So the cost is one look per MORE_ROWS of a camera's bookmarked rows at the oldest end, or one per
 * stretch when they are long: a 16-camera 24-hour bookmark 16 looks where a walk of the location's rows
 * would read its 23,040 rows every run, and one camera's line-crossing bookmarks (4 files each) a look
 * per dozen crossings, where the jumps took one each (the review of the final round: "grows by one look
 * per crossing"). Automatic bookmarks end after their camera's days kept (line-actions.mjs), which bounds
 * how many there are.
 * `passed`: the first row of each stretch stepped over (once per camera and stretch).
 * @param {{ index: object, locId: string, guard: { stretchOf: Function, commonOf?: Function }, pace?: () => Promise<void>,
 *           cams?: { nvr, ch }[] }} o  cams: every camera with rows (index.cameras(), asked here when not given)
 * @returns {Promise<{ row: object|null, passed: { path, stretch }[] }>}
 */
export async function firstUnprotected({ index, locId, guard, pace = null, cams = null }) {
  const passed = []
  const list = cams ?? index.cameras()
  const said = new Set() // camera and stretch already in `passed`
  const pass = (c, r, st) => {
    const k = `${c.key}|${st[0]}`
    if (said.has(k)) return
    said.add(k)
    passed.push({ path: r.path, stretch: st })
  }
  const byStart = (a, b) => a.s.startMs < b.s.startMs || (a.s.startMs === b.s.startMs && a.c.order < b.c.order)
  const start = (fromMs) => {
    // (each camera's oldest row first, in one statement: with no bookmark at the oldest end, the usual case,
    // that is all it takes)
    const cur = new CameraCursors({ index, locId, cams: list, fromMs, first: 1 })
    const heap = new Heap(byStart)
    for (const c of cur.list) {
      const s = cur.head(c)
      if (s) heap.push({ c, s })
    }
    return { cur, heap }
  }
  let { cur, heap } = start(null)
  while (heap.size) {
    const { c, s } = heap.pop()
    const st = guard.stretchOf(s)
    if (!st) return { row: s, passed }
    pass(c, s, st)
    // a stretch of every camera's that this row starts in: every camera's rows before its end are in it (this
    // row is the oldest of all not yet passed), so every camera starts again after it, in one statement
    const common = guard.commonOf?.(s) ?? null
    if (common && s.startMs >= common[0]) {
      ;({ cur, heap } = start(afterStretch(common)))
    } else {
      if (s.startMs >= st[0]) cur.skipTo(c, afterStretch(st))
      else cur.next(c) // protected, but it starts before the stretch: passed by itself
      const n = cur.head(c)
      if (n) heap.push({ c, s: n })
    }
    await pace?.()
  }
  return { row: null, passed }
}

/**
 * A pacer for a job's walk on the main thread: `await pace()` between steps lets the event loop go round
 * once `ms` have gone by since it last did, so no stretch of the walk holds up live video, pages and
 * alarm checks for longer than that and one step (the 50 ms rule). The review of p2-delete measured 196-204
 * ms for a 3,000-file run on the production VM, part of it all 87 cameras refilling in one go; paced,
 * 36-44 ms there (2026-09-29). What is left above 50 ms is a WAL checkpoint inside one removeMany (80-181
 * ms, now and then): moving checkpoints off the main thread is Task 12's.
 */
export function makePacer(ms = PACE_MS) {
  let last = performance.now()
  return async () => {
    if (performance.now() - last < ms) return
    await new Promise((r) => setImmediate(r))
    last = performance.now()
  }
}
export const PACE_MS = 10

/** A binary heap; `before(a, b)` true when a comes out first. */
export class Heap {
  constructor(before) {
    this.before = before
    this.a = []
  }
  get size() {
    return this.a.length
  }
  peek() {
    return this.a[0]
  }
  push(x) {
    const a = this.a
    a.push(x)
    for (let i = a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1
      if (!this.before(a[i], a[p])) break
      ;[a[i], a[p]] = [a[p], a[i]]
      i = p
    }
  }
  pop() {
    const a = this.a
    const top = a[0]
    const last = a.pop()
    if (a.length) {
      a[0] = last
      for (let i = 0; ; ) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && this.before(a[l], a[m])) m = l
        if (r < a.length && this.before(a[r], a[m])) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }
}

// ---- does deleting free space? -------------------------------------------------------------------------
// A NAS that keeps deleted files (a recycle bin, or snapshots holding them) frees nothing when they
// are deleted. The old loop then went on to its 20,000-file cap in one run (about 240 GB and ten
// minutes frozen) and did it again every run; with the bytes counted here instead, one run stops at
// its target, but every run would still delete its target again for nothing (verify-2, 2026-09-29).
// So after a run that deleted at least RISE_MIN_BYTES on a location, its free space is read again: it
// must have risen by at least half of what was deleted (recording writes meanwhile; about 17 MB/s on
// the site, 0.1 GB over a run's few seconds), asked again after 10 s and 30 s in case the NAS reports it
// late. If not, the location is "stalled": nothing more is deleted on it for free space (retention and
// the space limit go by the index, not by free space, and go on), with a loud warning; an hour later
// one small try (PROBE_BYTES) is allowed, and free space seen to rise with it ends the stall.
//
// Since the review of p2-delete (2026-09-29):
// - The share is shared: another program writing to it during the check (the other backups on the NAS)
//   can make free space look stuck too. The warning says so, and below the hard floor housekeeping makes
//   its small try every run instead of every hour: deleting comes back within 5 minutes once such a
//   writer pauses, while a NAS that really keeps deleted files loses at most PROBE_BYTES a run of its
//   oldest footage (which its recycle bin or snapshots then still hold).
// - A stall is kept in DATA_DIR (STALLS_FILE), not in memory only: after each restart, a NAS with a
//   recycle bin had its whole shortfall deleted again, up to 20,000 files (about 240 GB), before it
//   stalled once more.

export const RISE_MIN_BYTES = 1e9
export const RISE_WAITS_MS = [10_000, 20_000]
export const STALL_RETRY_MS = 60 * 60_000
export const PROBE_BYTES = 2e9

const stalls = new Map() // location id -> { since, retryAt, deletedBytes, roseBytes, freeAfter }
/** Where the stalls are kept across restarts (a small file on the system disk, never on a share). */
export const STALLS_FILE = 'storage-stalls.json'
let loaded = false

/** The stalls kept in DATA_DIR, read once (a few lines, on the system disk). */
function load() {
  if (loaded) return
  loaded = true
  let j = null
  try {
    j = JSON.parse(readFileSync(join(DATA_DIR, STALLS_FILE), 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[housekeeping] ${STALLS_FILE} could not be read (${e.message}): locations where deleting did not free space are not known until found again`)
    return
  }
  for (const [id, st] of Object.entries(j ?? {})) {
    if (st && Number.isFinite(st.since) && Number.isFinite(st.retryAt) && Number.isFinite(st.deletedBytes)) stalls.set(id, st)
  }
}

/** Writes the stalls to DATA_DIR (a temporary file, then renamed over the old one). Never throws. */
function save() {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const f = join(DATA_DIR, STALLS_FILE)
    writeFileSync(`${f}.tmp`, `${JSON.stringify(Object.fromEntries(stalls), null, 1)}\n`)
    renameSync(`${f}.tmp`, f)
  } catch (e) {
    console.warn(`[housekeeping] ${STALLS_FILE} could not be written (${e.message}): a restart forgets where deleting did not free space`)
  }
}

/** { since, retryAt, deletedBytes, roseBytes, freeAfter } while deleting on the location is known not to free space, else null. */
export function freeingStalled(locId) {
  load()
  const s = stalls.get(locId)
  return s ? { ...s } : null
}

const gbText = (b) => `${(b / 1e9).toFixed(1)} GB`

/**
 * A stalled location whose free space, read at a later run's start, has risen since by at least half of
 * what was deleted (the NAS freed it late, or someone emptied its recycle bin): no longer stalled.
 * Recording only lowers free space meanwhile, so a rise that large is the deleted files' space.
 * @returns {boolean} whether it was stalled and is not any more
 */
export function stallEnded(locId, freeBytes) {
  load()
  const s = stalls.get(locId)
  if (!s || !Number.isFinite(freeBytes) || !Number.isFinite(s.freeAfter)) return false
  if (freeBytes - s.freeAfter < s.deletedBytes / 2) return false
  stalls.delete(locId)
  save()
  return true
}

/**
 * After a run deleted `deletedBytes` on `loc`, whose free space was `before.freeBytes` when it started:
 * reads free space again (freeOf, from the helper), waiting and asking again while it has risen by less
 * than half. Records the outcome (freeingStalled). Never throws.
 * @returns {Promise<{ checked: boolean, rose: number|null, stalled: boolean, cleared: boolean, warning: string|null }>}
 */
export async function checkFreeRose({ loc, before, deletedBytes, freeOf, now = Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), waits = RISE_WAITS_MS }) {
  const out = { checked: false, rose: null, stalled: false, cleared: false, warning: null }
  if (!(deletedBytes >= RISE_MIN_BYTES) || !Number.isFinite(before?.freeBytes)) return out
  load()
  const want = deletedBytes / 2
  for (let i = 0; ; i++) {
    let f
    try {
      f = await freeOf(loc)
    } catch {
      return out // unreadable now: nothing learnt either way
    }
    out.checked = true
    out.rose = n(f?.freeBytes) - before.freeBytes
    if (out.rose >= want) {
      out.cleared = stalls.delete(loc.id)
      if (out.cleared) save()
      return out
    }
    if (i >= waits.length) break
    await sleep(waits[i])
  }
  out.stalled = true
  stalls.set(loc.id, { since: now, retryAt: now + STALL_RETRY_MS, deletedBytes, roseBytes: out.rose, freeAfter: before.freeBytes + out.rose })
  save()
  const waited = waits.reduce((a, b) => a + b, 0) / 1000
  out.warning = `${loc.path}: deleted ${gbText(deletedBytes)} but its free space rose by only ${gbText(out.rose)} in ${waited} s: the share may keep deleted files (a recycle bin, or snapshots), or another program writing to the share at the same time (another backup) used the space. Nothing more is deleted on it for free space (one small try an hour; every run while it is below its hard floor, at most ${gbText(PROBE_BYTES)} each); recording stops when it is full. Check the NAS.`
  return out
}

export const _test = {
  reset() {
    loaded = true
    stalls.clear()
    save()
  },
  setStall(id, s) {
    load()
    if (s) stalls.set(id, s)
    else stalls.delete(id)
    save()
  },
  /** As after a restart: forgets the stalls in memory, reads them again from DATA_DIR at the next look. */
  reload() {
    stalls.clear()
    loaded = false
  }
}
