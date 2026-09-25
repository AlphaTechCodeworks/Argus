// The index of server recordings (data/recordings.db, node:sqlite, main process only): one row
// per segment file the live workers reported, and the gaps they reported. The files on the
// storage locations are the recording; this index is how playback and housekeeping find them.
//
// Playback lookups (one camera; a segment is { nvr, ch, path, startMs, endMs, bytes, keyframes,
// loc, open? }): at(t), next(afterStartMs), prev(beforeStartMs), first(), byPath(path) (the row of a
// file that was open when looked up), and timeline() (a day's merged ranges, gaps and codec in one
// request); none of them scans a camera's whole history; recentOf() (newest first) for the RAM estimate
// in Settings (rec-cache.mjs). The file a camera's writer has open has no row
// yet (the 'segment' message comes after its close): the workers announce it ({t:'segopen'},
// noteOpen) and it is kept here in memory only, one per camera, with open: true and endMs null.
// It is dropped when its segment is indexed (noteClosed) or its worker restarts (dropOpen).
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Segments closer than this are one stretch on the timeline (the seam between two files is one frame). */
export const JOIN_MS = 2000
/**
 * Longer than any segment (a file rolls over at the first keyframe after each minute; recovered
 * files are capped at 5 min): bounds the lookups to the rows just before t, so a time in a gap
 * does not scan a camera's whole history.
 */
export const MAX_SEGMENT_MS = 60 * 60_000
/**
 * An open file this far past its start is no longer growing (its writer failed, the NVR went
 * offline and sends nothing): it counts only up to startMs + OPEN_MAX_MS, not up to now.
 */
export const OPEN_MAX_MS = 3 * 60_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS segments (
  path TEXT PRIMARY KEY, nvr TEXT NOT NULL, ch INTEGER NOT NULL, start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL, bytes INTEGER NOT NULL, keyframes INTEGER NOT NULL, loc TEXT);
CREATE INDEX IF NOT EXISTS segments_cam ON segments (nvr, ch, start_ms);
CREATE INDEX IF NOT EXISTS segments_start ON segments (start_ms);
CREATE TABLE IF NOT EXISTS gaps (
  id INTEGER PRIMARY KEY, nvr TEXT NOT NULL, ch INTEGER NOT NULL, from_ms INTEGER NOT NULL,
  to_ms INTEGER NOT NULL, reason TEXT);
CREATE INDEX IF NOT EXISTS gaps_cam ON gaps (nvr, ch, from_ms);
`
const SEG_COLS = 'nvr, ch, path, start_ms AS startMs, end_ms AS endMs, bytes, keyframes, loc'
const plain = (r) => ({ ...r }) // node:sqlite rows have a null prototype
const one = (r) => (r === undefined ? null : plain(r))
const camKey = (nvr, ch) => `${nvr}/${Number(ch)}`
const codecOf = (path) => /\.(h26[45])$/.exec(String(path))?.[1] ?? null

/** Opens (creating if needed) the index at `file`. */
export function openRecIndex(file) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  db.exec(SCHEMA)
  const q = {
    add: db.prepare('INSERT OR REPLACE INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    gap: db.prepare('INSERT INTO gaps (nvr, ch, from_ms, to_ms, reason) VALUES (?, ?, ?, ?, ?)'),
    // (start_ms bounded below as in at(): the rows just before the range, never the camera's whole history)
    segs: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? AND start_ms >= ? AND start_ms <= ? AND end_ms >= ? ORDER BY start_ms`),
    byPath: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE path = ?`),
    gaps: db.prepare('SELECT nvr, ch, from_ms AS fromMs, to_ms AS toMs, reason FROM gaps WHERE nvr = ? AND ch = ? AND to_ms >= ? AND from_ms <= ? ORDER BY from_ms'),
    oldest: db.prepare(`SELECT ${SEG_COLS} FROM segments ORDER BY start_ms LIMIT ?`),
    oldestAt: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE loc = ? ORDER BY start_ms LIMIT ?`),
    oldestOf: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? AND loc = ? ORDER BY start_ms LIMIT ?`),
    olderThan: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? AND end_ms < ? ORDER BY start_ms LIMIT ?`),
    remove: db.prepare('DELETE FROM segments WHERE path = ?'),
    has: db.prepare('SELECT 1 AS one FROM segments WHERE path = ?'),
    cameras: db.prepare('SELECT DISTINCT nvr, ch FROM segments ORDER BY nvr, ch'),
    oldGaps: db.prepare('DELETE FROM gaps WHERE to_ms < ?'),
    // playback lookups: all served by segments_cam (nvr, ch, start_ms)
    at: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? AND start_ms <= ? AND start_ms >= ? AND end_ms >= ? ORDER BY start_ms DESC LIMIT 1`),
    next: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? AND start_ms > ? ORDER BY start_ms LIMIT 1`),
    prev: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? AND start_ms < ? ORDER BY start_ms DESC LIMIT 1`),
    first: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? ORDER BY start_ms LIMIT 1`),
    newest: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? ORDER BY start_ms DESC LIMIT 1`),
    recent: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? ORDER BY start_ms DESC LIMIT ?`),
    window: db.prepare('SELECT path, start_ms AS s, end_ms AS e FROM segments WHERE nvr = ? AND ch = ? AND start_ms >= ? AND start_ms <= ? AND end_ms >= ? ORDER BY start_ms'),
    lastEnd: db.prepare('SELECT MAX(end_ms) AS e FROM segments WHERE nvr = ? AND ch = ?'),
    lastGapEnd: db.prepare('SELECT MAX(to_ms) AS e FROM gaps WHERE nvr = ? AND ch = ?')
  }
  /** camera key -> the file its writer has open: { nvr, ch, path, startMs, loc } (memory only) */
  const opens = new Map()
  const openSeg = (o) => (o ? { nvr: o.nvr, ch: o.ch, path: o.path, startMs: o.startMs, endMs: null, bytes: null, keyframes: null, loc: o.loc, open: true } : null)
  const openFor = (nvr, ch) => opens.get(camKey(nvr, ch)) ?? null
  return {
    addSegment(s) {
      q.add.run(String(s.path), String(s.nvr), Number(s.ch), Math.round(s.startMs), Math.round(s.endMs), Number(s.bytes), Number(s.keyframes), s.loc ?? null)
    },
    addGap(g) {
      q.gap.run(String(g.nvr), Number(g.ch), Math.round(g.fromMs), Math.round(g.toMs), g.reason ?? null)
    },
    /** Segments of one camera overlapping [fromMs, toMs], oldest first. */
    segments: (nvr, ch, fromMs, toMs) => q.segs.all(String(nvr), Number(ch), fromMs - MAX_SEGMENT_MS, toMs, fromMs).map(plain),
    /** The segment row of a file (its primary key), or null (not indexed: still open, or removed). */
    byPath: (path) => one(q.byPath.get(String(path))),
    gaps: (nvr, ch, fromMs, toMs) => q.gaps.all(String(nvr), Number(ch), fromMs, toMs).map(plain),
    /** The oldest segments (all locations, or one location id). */
    oldest: (limit, { loc } = {}) => (loc ? q.oldestAt.all(loc, limit) : q.oldest.all(limit)).map(plain),
    /** One camera's oldest segments on one location. */
    oldestOf: (nvr, ch, loc, limit) => q.oldestOf.all(String(nvr), Number(ch), loc, limit).map(plain),
    /** One camera's segments that ended before ms (oldest first). */
    olderThan: (nvr, ch, ms, limit) => q.olderThan.all(String(nvr), Number(ch), ms, limit).map(plain),
    /** Whether a segment file has a row. */
    has: (path) => q.has.get(String(path)) !== undefined,
    remove(path) {
      q.remove.run(String(path))
    },
    cameras: () => q.cameras.all().map(plain),
    /** One camera's newest `limit` segments, newest first (rec-cache.mjs: its bytes per minute). */
    recentOf: (nvr, ch, limit) => q.recent.all(String(nvr), Number(ch), Math.max(0, Math.floor(Number(limit) || 0))).map(plain),
    /** The end of one camera's newest recording and of its newest gap row: { segEnd, gapEnd } (null when none). */
    lastEnds: (nvr, ch) => ({ segEnd: q.lastEnd.get(String(nvr), Number(ch))?.e ?? null, gapEnd: q.lastGapEnd.get(String(nvr), Number(ch))?.e ?? null }),
    forgetGapsBefore(ms) {
      q.oldGaps.run(ms)
    },

    // ---- playback lookups (one camera)
    /** The segment holding t (start and end inclusive; the latest-starting one), else the open file when t is in it; else null. */
    at(nvr, ch, t) {
      const row = one(q.at.get(String(nvr), Number(ch), t, t - MAX_SEGMENT_MS, t))
      if (row) return row
      const o = openFor(nvr, ch)
      return o && t >= o.startMs && t <= o.startMs + OPEN_MAX_MS ? openSeg(o) : null
    },
    /** The first segment starting after afterStartMs, else the open file when it starts later; else null. */
    next(nvr, ch, afterStartMs) {
      const row = one(q.next.get(String(nvr), Number(ch), afterStartMs))
      if (row) return row
      const o = openFor(nvr, ch)
      return o && o.startMs > afterStartMs ? openSeg(o) : null
    },
    /** The last segment starting before beforeStartMs (the open file counts too), else null. */
    prev(nvr, ch, beforeStartMs) {
      const row = one(q.prev.get(String(nvr), Number(ch), beforeStartMs))
      const o = openFor(nvr, ch)
      if (o && o.startMs < beforeStartMs && (!row || o.startMs > row.startMs)) return openSeg(o)
      return row
    },
    /** The camera's oldest segment (a camera recording its first minute: the open file), else null. */
    first(nvr, ch) {
      const row = one(q.first.get(String(nvr), Number(ch)))
      const o = openFor(nvr, ch)
      if (o && (!row || o.startMs < row.startMs)) return openSeg(o)
      return row
    },
    /**
     * One camera's footage in [fromMs, toMs] for the timeline, in one query.
     * ranges: [[s, e]] segments within JOIN_MS of each other merged, clipped to the window; the open
     *   file counts as [startMs, now] (at most OPEN_MAX_MS long)
     * gaps: [[fromMs, toMs, reason]] the recorder's gap rows overlapping the window
     * codec: 'h264'|'h265' from the newest segment's extension (in the window, else the camera's newest), or null
     */
    timeline(nvr, ch, fromMs, toMs, now = Date.now()) {
      const n = String(nvr)
      const c = Number(ch)
      const rows = q.window.all(n, c, fromMs - MAX_SEGMENT_MS, toMs, fromMs)
      const spans = rows.map((r) => [r.s, r.e])
      let newest = rows.at(-1) ?? null
      const o = openFor(n, c)
      if (o) {
        const end = Math.max(o.startMs, Math.min(now, o.startMs + OPEN_MAX_MS))
        if (o.startMs <= toMs && end >= fromMs) {
          spans.push([o.startMs, end])
          if (!newest || o.startMs >= newest.s) newest = { path: o.path, s: o.startMs }
        }
      }
      spans.sort((x, y) => x[0] - y[0])
      const merged = []
      for (const [s, e] of spans) {
        const last = merged.at(-1)
        if (last && s <= last[1] + JOIN_MS) last[1] = Math.max(last[1], e)
        else merged.push([s, e])
      }
      const ranges = merged.map(([s, e]) => [Math.max(s, fromMs), Math.min(e, toMs)]).filter(([s, e]) => e >= s)
      const gaps = q.gaps.all(n, c, fromMs, toMs).map((g) => [g.fromMs, g.toMs, g.reason])
      const codec = codecOf(newest?.path ?? o?.path ?? q.newest.get(n, c)?.path)
      return { ranges, gaps, codec }
    },

    // ---- the files being written (memory only; see the top)
    /** A worker's {t:'segopen'}: { nvr, ch, path, startMs, loc }. One per camera: the newest wins. */
    noteOpen(m) {
      if (!m?.path || !Number.isFinite(Number(m.startMs))) return
      const key = camKey(m.nvr, m.ch)
      const cur = opens.get(key)
      if (cur && cur.startMs > m.startMs) return // an older file announced late (a location switch): the newer stays
      opens.set(key, { nvr: String(m.nvr), ch: Number(m.ch), path: String(m.path), startMs: Math.round(Number(m.startMs)), loc: m.loc ?? null })
    },
    /** The file at path was closed (its segment is indexed now). */
    noteClosed(path) {
      for (const [k, o] of opens) if (o.path === String(path)) opens.delete(k)
    },
    /** An NVR's worker (re)started: nothing it had open is being written any more. */
    dropOpen(nvr) {
      for (const [k, o] of opens) if (o.nvr === String(nvr)) opens.delete(k)
    },
    /** The file a camera's writer has open: { nvr, ch, path, startMs, loc }, or null. */
    openOf(nvr, ch) {
      const o = openFor(nvr, ch)
      return o ? { ...o } : null
    },
    close: () => db.close()
  }
}
