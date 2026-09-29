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
 *
 * Nothing enforces it, though: the writer only rolls over on a keyframe, so a camera that sent no
 * keyframe for an hour would write a longer file. The playback lookups would then miss the start of
 * that one file; lastSegmentEnd() must not be wrong about the camera's newest footage, so it also
 * asks segments_long (below), which holds exactly the rows longer than this.
 */
export const MAX_SEGMENT_MS = 60 * 60_000
/** A row longer than MAX_SEGMENT_MS. The same text in the partial index and the query, or SQLite will not use the index. */
const LONG_ROW = `end_ms - start_ms > ${MAX_SEGMENT_MS}`
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
-- Only the rows longer than MAX_SEGMENT_MS (lastSegmentEnd): empty while every file is shorter, as
-- they are meant to be, so it costs nothing to keep. Building it on an index that predates it reads
-- every row once, at the first start with this code.
CREATE INDEX IF NOT EXISTS segments_long ON segments (nvr, ch, end_ms) WHERE ${LONG_ROW};
CREATE TABLE IF NOT EXISTS gaps (
  id INTEGER PRIMARY KEY, nvr TEXT NOT NULL, ch INTEGER NOT NULL, from_ms INTEGER NOT NULL,
  to_ms INTEGER NOT NULL, reason TEXT);
CREATE INDEX IF NOT EXISTS gaps_cam ON gaps (nvr, ch, from_ms);
-- The backfill ledger (phase 2b, backfill.mjs). One row per hole we have decided to do something
-- about, so that the work survives a restart and a hole that can never be filled is not retried
-- forever. It is deliberately separate from the gaps table, which is the recorder's account of what it
-- could not record and must not be rewritten by a later job.
CREATE TABLE IF NOT EXISTS backfill_gaps (
  id INTEGER PRIMARY KEY, nvr TEXT NOT NULL, ch INTEGER NOT NULL, from_ms INTEGER NOT NULL,
  to_ms INTEGER NOT NULL, reason TEXT, kind TEXT, state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, last_try_ms INTEGER, last_error TEXT, filled_ms INTEGER,
  note TEXT, first_seen_ms INTEGER,
  UNIQUE (nvr, ch, from_ms, to_ms));
CREATE INDEX IF NOT EXISTS backfill_state ON backfill_gaps (state, from_ms);
`

/**
 * Bookmarks (phase 3, bookmarks.mjs): stretches someone marked as mattering. They live in this
 * database because this is where the jobs that would delete the footage already look, not because
 * they have anything to do with the segment index — housekeeping and thinning ask bookmarks.mjs
 * which stretches they must leave alone.
 *
 * Its own statement, run both here and by bookmarks.mjs, so the table exists whichever of the two
 * opens the file first. Everything in it is CREATE ... IF NOT EXISTS: nothing is dropped, altered
 * or rewritten, so running it against the populated database on the server adds the table and
 * leaves every existing row as it was.
 *
 * `cameras` is a JSON array of "<nvr>/<channel>" keys. One row per bookmark, rather than a row per
 * camera, keeps a bookmark one thing to edit and delete; the cost is that filtering by camera is a
 * text match rather than an index lookup, which is affordable because a site has bookmarks in the
 * hundreds, not the millions that segments run to.
 */
export const BOOKMARKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY, cameras TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', user TEXT NOT NULL,
  created_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS bookmarks_start ON bookmarks (start_ms);
CREATE INDEX IF NOT EXISTS bookmarks_end ON bookmarks (end_ms);
CREATE INDEX IF NOT EXISTS bookmarks_user ON bookmarks (user);
`
/**
 * Events and alarm rules (phase 7, events-db.mjs). Same reasoning as the bookmarks table above:
 * they live in the recordings database because that is where the footage an event points at is
 * indexed, and because it is the one file both the jobs and the pages already open. Its own
 * statement, run here and by events-db.mjs, so the tables exist whichever opens the file first.
 *
 * Everything is CREATE ... IF NOT EXISTS: run against the populated database on the server it adds
 * two tables and changes not one existing row.
 *
 * The UNIQUE key on an event is what makes intake safe to repeat. The NVRs are polled gently and a
 * poll re-reads a stretch it has already read (that is the cheapest way to catch an event that
 * arrived late); INSERT OR IGNORE against this key means the same event seen five times is still
 * one row, with its acknowledgement intact.
 */
export const EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, nvr TEXT NOT NULL, ch INTEGER NOT NULL, type TEXT NOT NULL,
  subtype TEXT NOT NULL DEFAULT '', start_ms INTEGER NOT NULL, end_ms INTEGER,
  source TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'low', rule_id INTEGER, rule_name TEXT, notified_ms INTEGER,
  ack_ms INTEGER, ack_user TEXT, ack_note TEXT, seen_ms INTEGER NOT NULL,
  UNIQUE (nvr, ch, type, subtype, start_ms));
CREATE INDEX IF NOT EXISTS events_start ON events (start_ms);
CREATE INDEX IF NOT EXISTS events_cam ON events (nvr, ch, start_ms);
CREATE INDEX IF NOT EXISTS events_ack ON events (ack_ms);
CREATE TABLE IF NOT EXISTS alarm_rules (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  cameras TEXT NOT NULL DEFAULT '[]', types TEXT NOT NULL DEFAULT '[]',
  schedule TEXT NOT NULL DEFAULT '[]', priority TEXT NOT NULL DEFAULT 'low',
  notify INTEGER NOT NULL DEFAULT 0, min_gap_s INTEGER NOT NULL DEFAULT 0,
  user TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
`

const SEG_COLS = 'nvr, ch, path, start_ms AS startMs, end_ms AS endMs, bytes, keyframes, loc, source, filled_ms AS filledMs'
const BF_COLS = 'id, nvr, ch, from_ms AS fromMs, to_ms AS toMs, reason, kind, state, attempts, last_try_ms AS lastTryMs, last_error AS lastError, filled_ms AS filledMs, note, first_seen_ms AS firstSeenMs'
/** Fields of a backfill ledger row a job may change, and the column each one is stored in. */
const BF_SET = { state: 'state', attempts: 'attempts', lastTryMs: 'last_try_ms', lastError: 'last_error', filledMs: 'filled_ms', note: 'note', reason: 'reason', kind: 'kind', toMs: 'to_ms' }
/**
 * The lookups that run for every camera on a timer: the Health snapshot (lastSegmentEnd, cameras;
 * every 30 s and on every /api/health poll) and housekeeping and thinning (olderThan, cameras; every
 * 5 min). They run on the main thread, which also paces every playback, so each must be an index
 * search, never a read of every row: MAX(end_ms) over a camera (segments_cam has no end_ms) took
 * 640 ms for the site's 87 cameras on a 3-day index, twice per snapshot, and playback froze for it
 * every 15-30 s. Kept here as text so rec-index-scans.test.mjs can check each one's query plan.
 */
export const CAMERA_SQL = {
  // lastSegmentEnd(): the newest start, then the latest end among the rows that started within
  // MAX_SEGMENT_MS of it, then the latest end of the rows longer than that (see lastSegmentEnd())
  newestStart: 'SELECT MAX(start_ms) AS s FROM segments WHERE nvr = ? AND ch = ? AND start_ms < ?',
  endSince: 'SELECT MAX(end_ms) AS e FROM segments WHERE nvr = ? AND ch = ? AND start_ms >= ? AND start_ms < ?',
  longEnd: `SELECT MAX(end_ms) AS e FROM segments INDEXED BY segments_long WHERE nvr = ? AND ch = ? AND start_ms < ? AND ${LONG_ROW}`,
  // olderThan(): a row that ended before the cutoff started before it, so start_ms bounds the walk
  // of segments_cam. Without it, a camera with nothing that old (every camera until the index is
  // older than its retention, and every camera again once a pass has deleted what was) read every
  // one of its rows: 600 ms for 87 cameras on a 3-day index, three times every 5 minutes. A row that
  // ends before it starts (never written on purpose) now waits until its start passes the cutoff:
  // this only ever deletes less, never more.
  olderThan: `SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? AND start_ms < ? AND end_ms < ? ORDER BY start_ms LIMIT ?`,
  // cameras(): one index seek per camera (a skip scan of segments_cam) instead of SELECT DISTINCT,
  // which reads every entry of the index (26 ms on 3 days, and the site keeps 183)
  firstNvr: 'SELECT MIN(nvr) AS nvr FROM segments',
  nextNvr: 'SELECT MIN(nvr) AS nvr FROM segments WHERE nvr > ?',
  firstCh: 'SELECT MIN(ch) AS ch FROM segments WHERE nvr = ?',
  nextCh: 'SELECT MIN(ch) AS ch FROM segments WHERE nvr = ? AND ch > ?'
}
/** lastSegmentEnd() without a bound: later than any start. */
const NO_BOUND = Number.MAX_SAFE_INTEGER
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
  db.exec(BOOKMARKS_SCHEMA)
  db.exec(EVENTS_SCHEMA)
  // An index written before phase 2b has no `source`/`filled_ms` columns. They are added here
  // rather than by recreating the table: the rows are the only record of where the footage is,
  // and a migration that rewrites them is a migration that can lose them.
  {
    const have = new Set(db.prepare('PRAGMA table_info(segments)').all().map((r) => r.name))
    if (!have.has('source')) db.exec('ALTER TABLE segments ADD COLUMN source TEXT')
    if (!have.has('filled_ms')) db.exec('ALTER TABLE segments ADD COLUMN filled_ms INTEGER')
  }
  const q = {
    add: db.prepare('INSERT OR REPLACE INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc, source, filled_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    // the ledger: a hole seen again keeps the state and the attempt count it already had
    bfAdd: db.prepare('INSERT OR IGNORE INTO backfill_gaps (nvr, ch, from_ms, to_ms, reason, kind, first_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    bfFind: db.prepare(`SELECT ${BF_COLS} FROM backfill_gaps WHERE nvr = ? AND ch = ? AND from_ms = ? AND to_ms = ?`),
    bfById: db.prepare(`SELECT ${BF_COLS} FROM backfill_gaps WHERE id = ?`),
    bfAll: db.prepare(`SELECT ${BF_COLS} FROM backfill_gaps ORDER BY from_ms DESC LIMIT ?`),
    bfState: db.prepare(`SELECT ${BF_COLS} FROM backfill_gaps WHERE state = ? ORDER BY from_ms DESC LIMIT ?`),
    // the job's pick list: oldest hole first (served by backfill_state (state, from_ms))
    bfPending: db.prepare(`SELECT ${BF_COLS} FROM backfill_gaps WHERE state = 'pending' ORDER BY from_ms LIMIT ?`),
    bfForget: db.prepare('DELETE FROM backfill_gaps WHERE to_ms < ?'),
    bfDrop: db.prepare('DELETE FROM backfill_gaps WHERE id = ?'),
    gap: db.prepare('INSERT INTO gaps (nvr, ch, from_ms, to_ms, reason) VALUES (?, ?, ?, ?, ?)'),
    // (start_ms bounded below as in at(): the rows just before the range, never the camera's whole history)
    segs: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? AND start_ms >= ? AND start_ms <= ? AND end_ms >= ? ORDER BY start_ms`),
    byPath: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE path = ?`),
    gaps: db.prepare('SELECT nvr, ch, from_ms AS fromMs, to_ms AS toMs, reason FROM gaps WHERE nvr = ? AND ch = ? AND to_ms >= ? AND from_ms <= ? ORDER BY from_ms'),
    oldest: db.prepare(`SELECT ${SEG_COLS} FROM segments ORDER BY start_ms LIMIT ?`),
    oldestAt: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE loc = ? ORDER BY start_ms LIMIT ?`),
    oldestOf: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? AND loc = ? ORDER BY start_ms LIMIT ?`),
    olderThan: db.prepare(CAMERA_SQL.olderThan),
    remove: db.prepare('DELETE FROM segments WHERE path = ?'),
    // ram-spool.mjs: a segment copied from memory to a drive keeps its row, with its new place
    moveSeg: db.prepare('UPDATE segments SET path = ?, loc = ? WHERE path = ?'),
    locBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b, COUNT(*) AS n FROM segments WHERE loc = ?'),
    has: db.prepare('SELECT 1 AS one FROM segments WHERE path = ?'),
    firstNvr: db.prepare(CAMERA_SQL.firstNvr),
    nextNvr: db.prepare(CAMERA_SQL.nextNvr),
    firstCh: db.prepare(CAMERA_SQL.firstCh),
    nextCh: db.prepare(CAMERA_SQL.nextCh),
    oldGaps: db.prepare('DELETE FROM gaps WHERE to_ms < ?'),
    // playback lookups: all served by segments_cam (nvr, ch, start_ms)
    at: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? AND start_ms <= ? AND start_ms >= ? AND end_ms >= ? ORDER BY start_ms DESC LIMIT 1`),
    next: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? AND start_ms > ? ORDER BY start_ms LIMIT 1`),
    prev: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? AND start_ms < ? ORDER BY start_ms DESC LIMIT 1`),
    first: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? ORDER BY start_ms LIMIT 1`),
    newest: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? ORDER BY start_ms DESC LIMIT 1`),
    recent: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? ORDER BY start_ms DESC LIMIT ?`),
    window: db.prepare('SELECT path, start_ms AS s, end_ms AS e FROM segments WHERE nvr = ? AND ch = ? AND start_ms >= ? AND start_ms <= ? AND end_ms >= ? ORDER BY start_ms'),
    newestStart: db.prepare(CAMERA_SQL.newestStart),
    endSince: db.prepare(CAMERA_SQL.endSince),
    longEnd: db.prepare(CAMERA_SQL.longEnd),
    // every row of the camera: only when lastSegmentEnd()'s shortcut cannot be trusted (see there)
    lastEndBefore: db.prepare('SELECT MAX(end_ms) AS e FROM segments WHERE nvr = ? AND ch = ? AND start_ms < ?'),
    lastGapEnd: db.prepare('SELECT MAX(to_ms) AS e FROM gaps WHERE nvr = ? AND ch = ?'),
    // ... of the rows that started before a time (served by gaps_cam): what the service or a worker
    // left before it went down, not what the new one has written since
    lastGapEndBefore: db.prepare('SELECT MAX(to_ms) AS e FROM gaps WHERE nvr = ? AND ch = ? AND from_ms < ?')
  }
  /**
   * The latest end_ms of one camera's rows that started before `before`: the end of its newest
   * footage. MAX(end_ms) over the camera straight out reads every one of its rows; this asks the
   * index three times instead, and is exact:
   *   S = the newest start. If the rows that started within MAX_SEGMENT_MS of S end at S or later
   *   (the newest file ends after it starts, as every file should), then any row that ends later
   *   still either started within MAX_SEGMENT_MS of S too, or is longer than MAX_SEGMENT_MS (a row
   *   that started earlier and is no longer than that has ended before S). The first are the window,
   *   the second are segments_long; the answer is the later of the two.
   * If the window ends before S (the newest file ends before it starts: a clock stepped back), that
   * reasoning fails, and every row of the camera is read as before. No such row is in the site's index.
   */
  const lastSegmentEnd = (nvr, ch, before) => {
    const s = q.newestStart.get(nvr, ch, before).s
    if (s === null) return null
    const inWindow = q.endSince.get(nvr, ch, s - MAX_SEGMENT_MS, before).e
    if (inWindow < s) return q.lastEndBefore.get(nvr, ch, before).e
    const long = q.longEnd.get(nvr, ch, before).e
    return long !== null && long > inWindow ? long : inWindow
  }
  /** camera key -> the file its writer has open: { nvr, ch, path, startMs, loc } (memory only) */
  const opens = new Map()
  const openSeg = (o) => (o ? { nvr: o.nvr, ch: o.ch, path: o.path, startMs: o.startMs, endMs: null, bytes: null, keyframes: null, loc: o.loc, open: true } : null)
  const openFor = (nvr, ch) => opens.get(camKey(nvr, ch)) ?? null
  return {
    addSegment(s) {
      // source/filledMs: null for footage the recorder wrote live; backfill.mjs sets them to
      // "backfill:<nvr id>" and the time it was pulled, which is what an evidence export states.
      q.add.run(String(s.path), String(s.nvr), Number(s.ch), Math.round(s.startMs), Math.round(s.endMs), Number(s.bytes), Number(s.keyframes), s.loc ?? null, s.source ?? null, s.filledMs == null ? null : Math.round(s.filledMs))
    },

    // ---- the backfill ledger (phase 2b; see backfill.mjs)
    /** Records a hole worth filling, or returns the row already there (state and attempts kept). */
    backfillNote(g, nowMs = Date.now()) {
      q.bfAdd.run(String(g.nvr), Number(g.ch), Math.round(g.fromMs), Math.round(g.toMs), g.reason ?? null, g.kind ?? null, Math.round(nowMs))
      return one(q.bfFind.get(String(g.nvr), Number(g.ch), Math.round(g.fromMs), Math.round(g.toMs)))
    },
    /** The ledger row for exactly this hole, or null (used to tell a new hole from a known one). */
    backfillFind: (nvr, ch, fromMs, toMs) => one(q.bfFind.get(String(nvr), Number(ch), Math.round(fromMs), Math.round(toMs))),
    /** One ledger row by its id, or null. */
    backfillRow: (id) => one(q.bfById.get(Number(id))),
    /** Ledger rows, newest hole first; `state` filters to one state. */
    backfillList: ({ state = null, limit = 1000 } = {}) => (state ? q.bfState.all(String(state), Number(limit)) : q.bfAll.all(Number(limit))).map(plain),
    /**
     * Pending ledger rows, oldest hole first: what the job picks from. Oldest first because those are
     * the rows nearest the NVR's deadline; with backfillList (newest first, every state) a long ledger
     * cut its oldest pending rows off, and they were never tried.
     */
    backfillPending: ({ limit = 10_000 } = {}) => q.bfPending.all(Number(limit)).map(plain),
    /** Changes a ledger row (only the fields in BF_SET; unknown fields are ignored). */
    backfillSet(id, fields) {
      const cols = []
      const vals = []
      for (const [k, v] of Object.entries(fields ?? {})) {
        if (!BF_SET[k]) continue
        cols.push(`${BF_SET[k]} = ?`)
        vals.push(v === undefined ? null : v)
      }
      if (!cols.length) return null
      db.prepare(`UPDATE backfill_gaps SET ${cols.join(', ')} WHERE id = ?`).run(...vals, Number(id))
      return one(q.bfById.get(Number(id)))
    },
    backfillRemove(id) {
      q.bfDrop.run(Number(id))
    },
    /** Ledger rows about footage that has since been deleted (housekeeping) explain nothing. */
    backfillForgetBefore(ms) {
      q.bfForget.run(Math.round(ms))
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
    /** A segment now lives elsewhere (same footage, new file). */
    moveSegment(oldPath, newPath, loc) {
      q.moveSeg.run(String(newPath), loc, String(oldPath))
    },
    /** { bytes, segments } held at one location. */
    locationUse: (loc) => {
      const r = q.locBytes.get(String(loc))
      return { bytes: Number(r.b), segments: Number(r.n) }
    },
    oldest: (limit, { loc } = {}) => (loc ? q.oldestAt.all(loc, limit) : q.oldest.all(limit)).map(plain),
    /** One camera's oldest segments on one location. */
    oldestOf: (nvr, ch, loc, limit) => q.oldestOf.all(String(nvr), Number(ch), loc, limit).map(plain),
    /** One camera's segments that ended before ms (oldest first). */
    olderThan: (nvr, ch, ms, limit) => q.olderThan.all(String(nvr), Number(ch), ms, ms, limit).map(plain),
    /** Whether a segment file has a row. */
    has: (path) => q.has.get(String(path)) !== undefined,
    remove(path) {
      q.remove.run(String(path))
    },
    /** Every camera with a row, as { nvr, ch }, ordered by nvr then ch. */
    cameras() {
      const out = []
      for (let nvr = q.firstNvr.get().nvr; nvr !== null; nvr = q.nextNvr.get(nvr).nvr) {
        for (let ch = q.firstCh.get(nvr).ch; ch !== null; ch = q.nextCh.get(nvr, ch).ch) out.push({ nvr, ch })
      }
      return out
    },
    /** One camera's newest `limit` segments, newest first (rec-cache.mjs: its bytes per minute). */
    recentOf: (nvr, ch, limit) => q.recent.all(String(nvr), Number(ch), Math.max(0, Math.floor(Number(limit) || 0))).map(plain),
    /**
     * The end of one camera's newest recording (null when none): the Health snapshot's "last
     * recorded", for every camera every time. beforeMs: only rows that started before it count.
     */
    lastSegmentEnd: (nvr, ch, beforeMs = null) => lastSegmentEnd(String(nvr), Number(ch), Number.isFinite(beforeMs) ? beforeMs : NO_BOUND),
    /**
     * The end of one camera's newest recording and of its newest gap row: { segEnd, gapEnd } (null
     * when none). beforeMs: only rows that started before it count. For the downtime rows at a start
     * (rec-recover.mjs); what only needs segEnd asks lastSegmentEnd(), because MAX(to_ms) reads every
     * gap row of the camera (23 ms for 87 cameras on a 3-day index, and gap rows are kept as long as footage).
     */
    lastEnds: (nvr, ch, beforeMs = null) => {
      const n = String(nvr)
      const c = Number(ch)
      const bounded = Number.isFinite(beforeMs)
      return {
        segEnd: lastSegmentEnd(n, c, bounded ? beforeMs : NO_BOUND),
        gapEnd: (bounded ? q.lastGapEndBefore.get(n, c, beforeMs) : q.lastGapEnd.get(n, c))?.e ?? null
      }
    },
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
