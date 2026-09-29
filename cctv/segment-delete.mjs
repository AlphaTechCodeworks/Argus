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
import { dirname, resolve } from 'node:path'

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
 * file that would not go) stay passed over for the rest of the run.
 */
export class CameraCursors {
  /** @param {{ index: object, locId: string, cams: { nvr, ch }[] }} o */
  constructor({ index, locId, cams, first = FIRST_ROWS, more = MORE_ROWS }) {
    this.index = index
    this.locId = locId
    this.first = first
    this.more = more
    this.filled = false
    this.list = cams.map((c, order) => ({ key: `${c.nvr}/${c.ch}`, nvr: c.nvr, ch: c.ch, order, rows: [], i: 0, full: false, done: false, lastStart: null, atLast: new Set() }))
  }

  fill() {
    if (this.filled) return
    this.filled = true
    if (!this.list.length) return
    const byKey = new Map(this.list.map((c) => [c.key, c]))
    for (const r of this.index.oldestPerCamera(this.locId, this.list, this.first)) byKey.get(`${r.nvr}/${r.ch}`)?.rows.push(r)
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
      // less the rows already passed there
      const raw = this.index.oldestOf(c.nvr, c.ch, this.locId, this.more, c.lastStart ?? Number.MIN_SAFE_INTEGER)
      const rows = raw.filter((r) => !(r.startMs === c.lastStart && c.atLast.has(r.path)))
      c.rows = rows
      c.i = 0
      c.full = raw.length >= this.more
      // (a full answer made only of rows already passed -- more than MORE_ROWS files starting in the
      // same millisecond, never written on purpose -- would be asked for again for ever)
      if (!rows.length) c.done = true
    }
    return c.done ? null : c.rows[c.i]
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

export const RISE_MIN_BYTES = 1e9
export const RISE_WAITS_MS = [10_000, 20_000]
export const STALL_RETRY_MS = 60 * 60_000
export const PROBE_BYTES = 2e9

const stalls = new Map() // location id -> { since, retryAt, deletedBytes, roseBytes }

/** { since, retryAt, deletedBytes, roseBytes } while deleting on the location is known not to free space, else null. */
export function freeingStalled(locId) {
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
  const s = stalls.get(locId)
  if (!s || !Number.isFinite(freeBytes) || !Number.isFinite(s.freeAfter)) return false
  if (freeBytes - s.freeAfter < s.deletedBytes / 2) return false
  stalls.delete(locId)
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
      return out
    }
    if (i >= waits.length) break
    await sleep(waits[i])
  }
  out.stalled = true
  stalls.set(loc.id, { since: now, retryAt: now + STALL_RETRY_MS, deletedBytes, roseBytes: out.rose, freeAfter: before.freeBytes + out.rose })
  const waited = waits.reduce((a, b) => a + b, 0) / 1000
  out.warning = `${loc.path}: deleted ${gbText(deletedBytes)} but its free space rose by only ${gbText(out.rose)} in ${waited} s: the share may keep deleted files (a recycle bin, or snapshots). Nothing more is deleted on it for free space (one small try an hour); recording stops when it is full. Check the NAS.`
  return out
}

export const _test = {
  reset() {
    stalls.clear()
  },
  setStall(id, s) {
    if (s) stalls.set(id, s)
    else stalls.delete(id)
  }
}
