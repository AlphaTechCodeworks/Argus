// The file calls on one storage location's folder, made by the share helper (share-helper.mjs) in a
// process of its own, never by the server (share-calls.mjs says why).
//
// Every call here is asynchronous, so the helper can answer the server's health check while a
// deletion or a rewrite is under way; and each op reports every file call that came back (tick()),
// so the server can tell a share that is slow from one that has stopped: SHARE_ANSWER_MS is the
// time one file call may take, not a whole batch (a batch of 100 deletions at the 3.1-3.3 ms a call
// measured on production is 0.3 s, but at the 96.6 ms seen once it would be 10 s).
//
// Safeguards, as in housekeeping.mjs and thinning.mjs, and here as well so a mistake on the server's
// side cannot get past them:
//  - nothing outside the location's folder (resolve + prefix), nor the folder itself, nor its
//    marker, is ever deleted, renamed or written; outside it nothing is even read;
//  - nothing is deleted, rmdir'd or rewritten unless the marker is there with this location's id,
//    read at that moment: an unmounted share's mount point is an empty folder on the system disk;
//  - a time-lapse rewrite is journalled exactly like thinning.mjs's swapIn, and the step that
//    updates the index stays on the server, between 'thin' (or 'thinSwap') and 'thinCommit'.
import { randomBytes } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { MARKER, freePercent } from './location-health.mjs'
import { parseIdx } from './segment-writer.mjs'
import { buildThinned, checkThinned, codecOf, planThin, thinNames } from './thin-file.mjs'

const CHUNK = 8 * 1024 * 1024 // a whole segment is read and written in pieces of this, each a file call
const PROBE_BYTES = 8 * 1024 * 1024 // the write-speed test, as location-health.mjs

const refuse = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code })

/**
 * The ops for one location. Each is (args, tick) -> Promise<result>; tick() after every file call
 * that came back. A refused call throws with .code (EOUTSIDE, EMARKER, EBADARG).
 * @param {{ id: string, root: string }} loc
 */
export function makeShareOps({ id, root: rootIn }) {
  const root = resolve(rootIn)
  const marker = join(root, MARKER)
  const within = (p) => {
    const r = resolve(String(p))
    return r.startsWith(root + sep) ? r : null
  }
  /** A path we may read: the folder itself or inside it. */
  const readable = (p) => {
    const r = resolve(String(p))
    return r === root || r.startsWith(root + sep) ? r : null
  }
  /** A path we may change: strictly inside, and not the marker. */
  const changeable = (p) => {
    const r = within(p)
    return r && r !== marker ? r : null
  }
  const list = (v, what) => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw refuse('EBADARG', `${what} must be a list of paths`)
    return v
  }
  async function markerIdNow() {
    try {
      const j = JSON.parse(await fsp.readFile(marker, 'utf8'))
      return typeof j?.id === 'string' ? j.id : null
    } catch {
      return null
    }
  }
  async function needMarker(tick) {
    const m = await markerIdNow()
    tick()
    if (m !== id) throw refuse('EMARKER', m ? `${root} holds the marker of another location (${m}): nothing touched` : `${root} has no marker (not mounted?): nothing touched`)
  }
  // tick (when given) after the call comes back, as after every file call of an op: the server's clock
  // is per file call. Before, thinSwap made four file calls in a row unreported, and in a test at 300 ms
  // a call with 1 s to answer it was called stuck on its own (review of p1-helper, 2026-09-29).
  const unlinkQuiet = async (f, tick) => {
    try {
      await fsp.unlink(f)
      return true
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
      return false
    } finally {
      tick?.()
    }
  }
  const exists = async (f, tick) => {
    try {
      await fsp.stat(f)
      return true
    } catch {
      return false
    } finally {
      tick?.()
    }
  }
  async function readWhole(file, tick) {
    const fh = await fsp.open(file, 'r')
    tick()
    try {
      const { size } = await fh.stat()
      tick()
      const buf = Buffer.allocUnsafe(size)
      let off = 0
      while (off < size) {
        const { bytesRead } = await fh.read(buf, off, Math.min(CHUNK, size - off), off)
        tick()
        if (!bytesRead) break
        off += bytesRead
      }
      return off === size ? buf : buf.subarray(0, off)
    } finally {
      await fh.close()
      tick()
    }
  }
  async function writeFsync(file, buf, tick) {
    const fh = await fsp.open(file, 'w')
    tick()
    try {
      for (let off = 0; off < buf.length; ) {
        const { bytesWritten } = await fh.write(buf, off, Math.min(CHUNK, buf.length - off))
        tick()
        off += bytesWritten
      }
      await fh.sync()
      tick()
    } finally {
      await fh.close()
      tick()
    }
  }

  // ---- health: location-health.mjs healthOf and probeWriteSpeed, step for step, asynchronously ----

  async function canWrite() {
    const f = join(root, `.cctv-write-test-${process.pid}`)
    try {
      await fsp.writeFile(f, 'x')
      await fsp.unlink(f)
      return true
    } catch {
      try {
        await fsp.unlink(f)
      } catch {}
      return false
    }
  }
  async function writeSpeed(tick, bytes = PROBE_BYTES) {
    const f = join(root, `.cctv-speed-test-${process.pid}-${randomBytes(3).toString('hex')}`)
    const buf = Buffer.alloc(1024 * 1024, 0x5a)
    const t0 = process.hrtime.bigint()
    let fh
    try {
      fh = await fsp.open(f, 'w')
      for (let n = 0; n < bytes; n += buf.length) {
        await fh.write(buf, 0, Math.min(buf.length, bytes - n))
        tick()
      }
      await fh.sync()
    } finally {
      if (fh) await fh.close()
      try {
        await fsp.unlink(f)
      } catch {}
    }
    const s = Math.max(Number(process.hrtime.bigint() - t0) / 1e9, 1e-6)
    return Math.round((bytes / 1e6 / s) * 10) / 10
  }

  /** thinning.mjs swapIn steps 1-3: journal (fsynced), original aside, rewrite in its place. */
  async function swapIn(n, tick) {
    await writeFsync(n.journal, Buffer.from(`${JSON.stringify({ path: n.seg, at: new Date().toISOString() })}\n`), tick)
    for (const [from, to] of [
      [n.seg, n.oldSeg],
      [n.idx, n.oldIdx],
      [n.newSeg, n.seg],
      [n.newIdx, n.idx]
    ]) {
      await fsp.rename(from, to)
      tick()
    }
  }

  return {
    /** The location's health, as healthOf gives it; with speed, also writeMBps (or speedError). */
    async probe({ floor = 0, speed = false } = {}, tick) {
      const h = { ok: false, reason: '', marker: false, writable: false, freeBytes: 0, totalBytes: 0, writeMBps: null }
      let st
      try {
        st = await fsp.stat(root)
      } catch {
        h.reason = 'folder missing (drive or share not connected?)'
        return h
      }
      tick()
      if (!st.isDirectory()) {
        h.reason = 'not a folder'
        return h
      }
      const mid = await markerIdNow()
      tick()
      if (!mid) {
        h.reason = 'no marker file: not prepared, or the drive/share is not mounted'
        return h
      }
      if (mid !== id) {
        h.reason = `the marker belongs to another location (${mid}): a different drive is mounted here`
        return h
      }
      h.marker = true
      try {
        const s = await fsp.statfs(root)
        h.freeBytes = Number(s.bavail) * Number(s.bsize)
        h.totalBytes = Number(s.blocks) * Number(s.bsize)
      } catch (e) {
        h.reason = `free space unknown: ${e.message}`
        return h
      }
      tick()
      h.writable = await canWrite()
      tick()
      if (!h.writable) {
        h.reason = 'not writable'
        return h
      }
      const pct = freePercent(h)
      if (pct < floor) {
        h.reason = `below the hard floor (${pct.toFixed(1)}% free, floor ${floor}%)`
        return h
      }
      h.ok = true
      if (speed) {
        try {
          h.writeMBps = await writeSpeed(tick)
        } catch (e) {
          h.speedError = e.message
        }
      }
      return h
    },

    /** Free and total bytes of the location, now. */
    async statfs() {
      const s = await fsp.statfs(root)
      return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) }
    },

    /** [{ path, size, mtimeMs, isFile, isDirectory } | { path, error }] */
    async stat({ paths } = {}, tick) {
      const out = []
      for (const p of list(paths, 'paths')) {
        const r = readable(p)
        if (!r) {
          out.push({ path: p, error: 'EOUTSIDE' })
          continue
        }
        try {
          const s = await fsp.stat(r)
          out.push({ path: p, size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() })
        } catch (e) {
          out.push({ path: p, error: e.code || e.message })
        }
        tick()
      }
      return out
    },

    /**
     * What crash recovery needs of a file a dead worker left without an index row (rec-recover.mjs),
     * read here so the server makes no file call on the share after a worker restart (perf report R8,
     * 2026-09-30): [{ path, size, mtimeMs, isFile, keyframes, firstKeyMs, lastKeyMs } | { path, error }].
     * The keyframes are its .idx rows within its size (a torn last row, or one past the end, not counted);
     * no .idx (the worker died between the two opens) is none, firstKeyMs and lastKeyMs null.
     * A row AT the file's end is past it too: the writer writes a keyframe's row before its data
     * (segment-writer.mjs #data), so that row is a keyframe none of whose bytes reached the disk (as
     * rec-reader.mjs reads it; audit of 2026-10-07).
     */
    async segInfo({ paths } = {}, tick) {
      const out = []
      for (const p of list(paths, 'paths')) {
        const r = readable(p)
        if (!r) {
          out.push({ path: p, error: 'EOUTSIDE' })
          continue
        }
        let s
        try {
          s = await fsp.stat(r)
        } catch (e) {
          out.push({ path: p, error: e.code || e.message })
          continue
        } finally {
          tick()
        }
        let rows = []
        try {
          rows = parseIdx(await fsp.readFile(`${r}.idx`)).filter((x) => x.offset < s.size)
        } catch {} // no .idx: none
        tick()
        out.push({ path: p, size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), keyframes: rows.length, firstKeyMs: rows[0]?.tsMs ?? null, lastKeyMs: rows.at(-1)?.tsMs ?? null })
      }
      return out
    },

    /** [{ dir, entries: [{ name, file, dir }] } | { dir, error }] */
    async readdir({ dirs } = {}, tick) {
      const out = []
      for (const d of list(dirs, 'dirs')) {
        const r = readable(d)
        if (!r) {
          out.push({ dir: d, error: 'EOUTSIDE' })
          continue
        }
        try {
          const es = await fsp.readdir(r, { withFileTypes: true })
          out.push({ dir: d, entries: es.map((e) => ({ name: e.name, file: e.isFile(), dir: e.isDirectory() })) })
        } catch (e) {
          out.push({ dir: d, error: e.code || e.message })
        }
        tick()
      }
      return out
    },

    /**
     * Deletes each path (withIdx: and then its .idx, as housekeeping.mjs does: the .idx is not tried
     * when the segment could not be deleted). One already gone counts as deleted.
     * @returns {Promise<({ path, ok: true } | { path, ok: false, error, file? })[]>}
     */
    async unlink({ paths, withIdx = false } = {}, tick) {
      list(paths, 'paths')
      await needMarker(tick)
      const out = []
      const absent = [] // results whose segment file was not there
      for (const p of paths) {
        const r = changeable(p)
        if (!r) {
          out.push({ path: p, ok: false, error: 'EOUTSIDE' })
          continue
        }
        let failed = null
        let gone = false
        for (const f of withIdx ? [r, `${r}.idx`] : [r]) {
          try {
            if (!(await unlinkQuiet(f)) && f === r) gone = true
          } catch (e) {
            failed = { path: p, ok: false, error: e.code || e.message, file: f }
          }
          tick()
          if (failed) break
        }
        out.push(failed ?? { path: p, ok: true })
        if (!failed && gone) absent.push(out.length - 1)
      }
      // "Not there" means deleted only while the share is still mounted: were it unmounted during
      // the batch, every file would be "not there" in the empty mount point while still on the NAS,
      // and the caller would drop their index rows. So the marker is read again after any.
      if (absent.length && (await markerIdNow()) !== id) {
        for (const i of absent) out[i] = { path: out[i].path, ok: false, error: 'EMARKER' }
      }
      return out
    },

    /**
     * Removes each folder and then its parents while they are empty, never the location itself (as
     * housekeeping.mjs does after a deletion). A folder with anything in it stays, and ends the walk.
     * @returns {Promise<({ dir, removed: string[] } | { dir, error })[]>}
     */
    async rmdir({ dirs } = {}, tick) {
      list(dirs, 'dirs')
      await needMarker(tick)
      const out = []
      for (const d of dirs) {
        const r = within(d)
        if (!r) {
          out.push({ dir: d, error: 'EOUTSIDE' })
          continue
        }
        const removed = []
        for (let x = r; x.startsWith(root + sep); x = dirname(x)) {
          try {
            await fsp.rmdir(x)
            removed.push(x)
          } catch {
            break
          } finally {
            tick()
          }
        }
        out.push({ dir: d, removed })
      }
      return out
    },

    /**
     * "Thin this file": one time-lapse rewrite, the file work of thinning.mjs runThinning for one
     * segment. Reads it and its .idx, keeps one keyframe per timelapseS (cursor: the last kept time
     * of the file before, or null), writes the new pair beside it (fsynced), reads it back and checks
     * it; then, unless swap is false, journals and swaps it in (thinning.mjs swapIn steps 1-3). The
     * server then updates the index row and sends thinCommit; if it cannot, thinRecover puts the
     * original back. When thin, thinSwap or thinCommit fails, or the helper is lost during one, the
     * state on disk is unknown: thinRecover for that path first (with its journal there it rolls back).
     * @returns {Promise<{ outcome: 'thinned', swapped, wasBytes, bytes, keyframes, droppedKeyframes, cursor, startMs, endMs }
     *                 | { outcome: 'skipped', why, cursor? } | { outcome: 'failed', why }>}
     */
    async thin({ path, timelapseS, cursor = null, maxBytes, swap = true } = {}, tick) {
      const r = changeable(path)
      if (!r) throw refuse('EOUTSIDE', `${path} is outside ${root}`)
      if (!(Number(timelapseS) > 0)) throw refuse('EBADARG', 'timelapseS must be a positive number of seconds')
      if (!(Number(maxBytes) > 0)) throw refuse('EBADARG', 'maxBytes must be a positive number')
      await needMarker(tick)
      const n = thinNames(r)
      if (await exists(n.journal, tick)) return { outcome: 'skipped', why: 'a rewrite of it was left half done: thinRecover first' }
      let buf
      let rows
      try {
        const st = await fsp.stat(n.seg)
        tick()
        if (st.size > maxBytes) return { outcome: 'skipped', why: `larger than ${maxBytes} bytes` }
        buf = await readWhole(n.seg, tick)
        rows = parseIdx(await readWhole(n.idx, tick))
      } catch (e) {
        // A share unmounted since the marker was read leaves an empty folder, where the file is "not
        // there": the server would take that for a file gone for good and never look at it again (review
        // of p3-thin, 2026-09-29), so the marker is read once more first, as unlink does.
        const m = await markerIdNow()
        tick()
        if (m !== id) throw refuse('EMARKER', `${root} lost its marker while ${basename(r)} was read (unmounted?): nothing touched`)
        return { outcome: 'skipped', why: `cannot read it (${e.code || e.message})` }
      }
      if (!rows.length) return { outcome: 'skipped', why: 'no index rows' }
      const codec = codecOf(r)
      let plan
      try {
        plan = planThin(buf, rows, { codec, timelapseS: Number(timelapseS), cursor: Number.isFinite(cursor) ? cursor : -Infinity })
      } catch (e) {
        return { outcome: 'skipped', why: `cannot be parsed (${e.message})` }
      }
      // Every keyframe falls inside the previous one's interval: left for the retention job, as in
      // runThinning (deleting it here would be a second kind of destruction inside a "thin" job).
      if (!plan.keep.length) return { outcome: 'skipped', why: 'nothing to keep at this interval (left alone)' }
      const built = buildThinned(buf, plan.keep)
      if (built.bytes.length >= buf.length) return { outcome: 'skipped', why: 'already thin', cursor: plan.cursor }
      let v
      try {
        await writeFsync(n.newSeg, built.bytes, tick)
        await writeFsync(n.newIdx, built.idx, tick)
        v = checkThinned(n.newSeg, await readWhole(n.newSeg, tick), parseIdx(await readWhole(n.newIdx, tick)), { bytes: built.bytes.length, keyframes: plan.keep.length, codec })
      } catch (e) {
        await unlinkQuiet(n.newSeg, tick).catch(() => {})
        await unlinkQuiet(n.newIdx, tick).catch(() => {})
        return { outcome: 'failed', why: `rewrite failed: ${e.message}; the original is untouched` }
      }
      const row = { outcome: 'thinned', swapped: false, wasBytes: buf.length, bytes: v.bytes, keyframes: v.keyframes, droppedKeyframes: rows.length - plan.keep.length, cursor: plan.cursor, startMs: v.startMs, endMs: v.endMs }
      if (!swap) return row
      await swapIn(n, tick)
      return { ...row, swapped: true }
    },

    /** Swaps in a rewrite that 'thin' left beside the original (swap: false). */
    async thinSwap({ path } = {}, tick) {
      const r = changeable(path)
      if (!r) throw refuse('EOUTSIDE', `${path} is outside ${root}`)
      await needMarker(tick)
      const n = thinNames(r)
      // swapped already and not committed: a second swap would move the rewrite over the original
      // kept beside it, and there would be no footage left to roll back to
      if (await exists(n.journal, tick)) throw refuse('EBADARG', `${path} was swapped already and not committed: thinCommit, or thinRecover to put the original back`)
      if (!(await exists(n.newSeg, tick)) || !(await exists(n.newIdx, tick))) throw refuse('EBADARG', `${path} has no rewrite waiting to be swapped in`)
      await swapIn(n, tick)
      return { swapped: true }
    },

    /**
     * After the index row is updated: the journal goes (the commit point), then the original. Only
     * after a swap that finished: the journal there, the rewrite in place of the segment and its .idx,
     * the original pair beside them, and no .thin-new left. Anything else is refused with nothing
     * touched. In thinning.mjs the swap and the commit are one synchronous call; over the helper they
     * are two, and a commit after a swap that stopped half way (a rename that failed, or the helper
     * lost just after `seg -> .thin-old`) deleted the original and left the rewrite only as .thin-new,
     * which the next thinRecover swept up too (review of p1-helper, 2026-09-29).
     */
    async thinCommit({ path } = {}, tick) {
      const r = changeable(path)
      if (!r) throw refuse('EOUTSIDE', `${path} is outside ${root}`)
      await needMarker(tick)
      const n = thinNames(r)
      if (!(await exists(n.journal, tick))) throw refuse('EBADARG', `${path} has no swap waiting to be committed (no journal): nothing touched`)
      const wrong = []
      for (const [f, want] of [
        [n.seg, true],
        [n.idx, true],
        [n.oldSeg, true],
        [n.oldIdx, true],
        [n.newSeg, false],
        [n.newIdx, false]
      ]) {
        if ((await exists(f, tick)) !== want) wrong.push(want ? `no ${basename(f)}` : `${basename(f)} still there`)
      }
      if (wrong.length) throw refuse('EBADARG', `the swap did not finish: thinRecover puts the original back (${path}: ${wrong.join(', ')}); nothing touched`)
      await fsp.unlink(n.journal)
      tick()
      await unlinkQuiet(n.oldSeg, tick)
      await unlinkQuiet(n.oldIdx, tick)
      return { committed: true }
    },

    /** Throws away a rewrite that was not swapped in (swap: false); the original is as it was. */
    async thinAbort({ path } = {}, tick) {
      const r = changeable(path)
      if (!r) throw refuse('EOUTSIDE', `${path} is outside ${root}`)
      await needMarker(tick)
      const n = thinNames(r)
      if (await exists(n.journal, tick)) throw refuse('EBADARG', `${path} was already swapped: thinRecover puts the original back`)
      await unlinkQuiet(n.newSeg, tick)
      await unlinkQuiet(n.newIdx, tick)
      return { aborted: true }
    },

    /**
     * thinning.mjs recoverThinning for the given segments (the ones a lost helper had in hand): with
     * a journal the rewrite did not commit, so the original is put back and the rewrite thrown away;
     * without one, leftovers beside the file are litter and go -- but only while the segment and its
     * .idx are both there. With either missing, what is beside them may be all that is left of that
     * footage (review of p1-helper, 2026-09-29): an original set aside (.thin-old) is put back, as
     * with a journal, even when the journal has gone; with nothing to put back, the files are left as
     * they are, journal and all, and the path is listed in `left` for a person to look at. With nothing of
     * it at all, it is `gone` -- said only after the marker is read again: a share unmounted since the first
     * read leaves an empty mount point, where every path is "not there" while the journal, the original and
     * the rewrite are all still on the share, and the server, taking that for deleted, stopped keeping the
     * path from every deletion and from being put right (review of p3-thin, round 2, 2026-09-30). The marker
     * gone then is EMARKER, as for thin and unlink.
     * @returns {Promise<{ rolledBack: string[], sweptUp: string[], left: string[], refused: string[], gone: string[] }>}
     */
    async thinRecover({ paths } = {}, tick) {
      list(paths, 'paths')
      await needMarker(tick)
      const out = { rolledBack: [], sweptUp: [], left: [], refused: [], gone: [] }
      const stillMounted = async (p) => {
        const m = await markerIdNow()
        tick()
        if (m !== id) throw refuse('EMARKER', `${root} lost its marker while ${basename(p)} was put right (unmounted?): nothing more touched`)
      }
      for (const p of paths) {
        const r = changeable(p)
        if (!r) {
          out.refused.push(p)
          continue
        }
        const n = thinNames(r)
        const whole = async () => (await exists(n.seg, tick)) && (await exists(n.idx, tick))
        const journal = await exists(n.journal, tick)
        if (journal || !(await whole())) {
          let moved = false
          for (const [from, to] of [
            [n.oldSeg, n.seg],
            [n.oldIdx, n.idx]
          ]) {
            if (await exists(from, tick)) {
              await fsp.rename(from, to)
              tick()
              moved = true
            }
          }
          if (!(await whole())) {
            // not whole, nothing put back: first, is this still the share?
            await stillMounted(p)
            if (journal || (await exists(n.newSeg, tick)) || (await exists(n.newIdx, tick))) out.left.push(p)
            else if (!moved) out.gone.push(p)
            continue
          }
          await unlinkQuiet(n.newSeg, tick)
          await unlinkQuiet(n.newIdx, tick)
          await unlinkQuiet(n.journal, tick)
          if (journal || moved) out.rolledBack.push(p)
        } else {
          let any = false
          for (const f of [n.oldSeg, n.oldIdx, n.newSeg, n.newIdx]) any = (await unlinkQuiet(f, tick)) || any
          if (any) out.sweptUp.push(p)
        }
      }
      return out
    }
  }
}
