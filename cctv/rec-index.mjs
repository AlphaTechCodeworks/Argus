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
-- One storage location's rows (LOCATION_SQL): locationUse('ram-spool') every 30 s read every row to
-- find the spool's few or none, 40 ms of the main thread on production's 377,000 (29 Sep). start_ms
-- keeps the oldest files of a location in order without a sort: an index on loc alone, or on (loc,
-- bytes), had the main drive's oldest(50) sort all of its rows instead of walking segments_start
-- (0.3-1.3 s on a 377,000-row copy). Building it on an index that predates it reads every row once,
-- at the first start with this code: 1.6-1.8 s and 11 MB more file for 377,000 synthetic rows on the
-- development PC (whose full scan of them takes 200-270 ms, against 40 ms on production); every open
-- after that, 7-10 ms.
CREATE INDEX IF NOT EXISTS segments_loc ON segments (loc, start_ms);
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
 * The bytes and files each storage location holds, kept by triggers as rows come and go (locationUse).
 * A location's space limit is enforced against this every 5 minutes (housekeeping.mjs), and the Storage
 * page shows it. SUM(bytes) over the main drive's rows reads every one of them, however it is indexed:
 * 102 ms for 440,000 synthetic rows on the development PC (about 20 ms on production's VM, which scans
 * 4-5 times faster), and the index grows to about 3.7 million rows at 30 days (perf report 1): a main
 * thread stall every time it was asked. Here it is one row. The triggers are in the file, so a row
 * written by any connection counts. REPLACE (addSegment of a file already indexed: a time-lapse rewrite)
 * deletes the old row without the delete trigger under SQLite's default settings, which every other
 * connection has (older code of ours after a roll-back, the sqlite3 tool): so the old row is taken off
 * BEFORE the insert, by loc_totals_replace, and the delete trigger is left out of it (recursive_triggers
 * off, as openRecIndex sets it; on, the old row would be taken off twice). Until 2026-09-29's review it
 * was the other way round, and a REPLACE from any other connection counted the file twice. (A hand-typed
 * INSERT OR IGNORE / OR FAIL of a file already indexed would still count wrong: nothing here does that.)
 * A row with no location counts under ''. Created, and filled from the rows already there, the first time
 * this code opens an index (one read of every row, once).
 * To rebuild it, WITH THE SERVER STOPPED: DROP TABLE loc_totals, then start it (the open fills it again).
 * Dropped while the server runs, every segment it indexes fails ("no such table") until it is restarted.
 * (2026-09-29, perf report Task 3 and the owner's 12 TB limit)
 */
const TOTALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS loc_totals (loc TEXT PRIMARY KEY NOT NULL, bytes INTEGER NOT NULL, segments INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS loc_totals_replace BEFORE INSERT ON segments
  WHEN EXISTS (SELECT 1 FROM segments WHERE path = NEW.path) BEGIN
  UPDATE loc_totals SET bytes = bytes - (SELECT bytes FROM segments WHERE path = NEW.path), segments = segments - 1
    WHERE loc = (SELECT IFNULL(loc, '') FROM segments WHERE path = NEW.path);
END;
CREATE TRIGGER IF NOT EXISTS loc_totals_add AFTER INSERT ON segments BEGIN
  INSERT INTO loc_totals (loc, bytes, segments) VALUES (IFNULL(NEW.loc, ''), NEW.bytes, 1)
    ON CONFLICT (loc) DO UPDATE SET bytes = bytes + excluded.bytes, segments = segments + 1;
END;
CREATE TRIGGER IF NOT EXISTS loc_totals_remove AFTER DELETE ON segments BEGIN
  UPDATE loc_totals SET bytes = bytes - OLD.bytes, segments = segments - 1 WHERE loc = IFNULL(OLD.loc, '');
END;
CREATE TRIGGER IF NOT EXISTS loc_totals_change AFTER UPDATE OF loc, bytes ON segments BEGIN
  UPDATE loc_totals SET bytes = bytes - OLD.bytes, segments = segments - 1 WHERE loc = IFNULL(OLD.loc, '');
  INSERT INTO loc_totals (loc, bytes, segments) VALUES (IFNULL(NEW.loc, ''), NEW.bytes, 1)
    ON CONFLICT (loc) DO UPDATE SET bytes = bytes + excluded.bytes, segments = segments + 1;
END;
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

/**
 * Time-lapse thinning's rows (thinning.mjs, since 2026-09-29; perf report Task 4 and its check verify-1).
 * `thinned` on a segment row: null = full video, not looked at yet; THIN.timelapse = rewritten to one
 * keyframe per timelapseS; THIN.kept = looked at and left as it was (already that thin, nothing to keep
 * at the interval, cannot be parsed, the file not there). A rewritten row used to keep its place among
 * a camera's oldest rows unchanged: olderThan() gave the same oldest 500 every run, the job read all of
 * them again ("already thin", about 57 GB over SMB a run at 87 cameras) and never got past them
 * (verify-1 correction 2). The job walks segments_full instead, which holds only the rows still null:
 * about the newest fullDays of footage plus what waits for the job, never the time-lapse days. Its key
 * is time first, cameras after: the deletion jobs and the job itself take the oldest files of every
 * camera together, and with a camera-first key each batch of 100 touched 87 more index pages (1,350 WAL
 * pages for 470 files deleted instead of 931, so a checkpoint on the main thread in every such run: 36-92
 * ms on the development PC); time-first adds about 15. A camera left out of a walk (not set to time-lapse)
 * is passed on the index's own columns, without reading its rows (0.4 us a row against 1.4 us read, on
 * the development PC, scratchpad idx-bench.mjs). Building it on an index that predates it reads every
 * row once, at the first start with this code (as segments_loc did: about 1.6-1.8 s for 377,000 rows on
 * the development PC).
 * thin_inflight: each rewrite between its start and its commit, with the file's size and keyframes
 * before; after the swap the segment row has the new ones. It is on the system disk with the index, so
 * a server that stops in the middle of one finds it at the next run and has the share helper put the
 * file right (share-ops.mjs thinRecover) before anything else touches that file: housekeeping and
 * retention pass over it meanwhile.
 */
export const THIN = Object.freeze({ timelapse: 1, kept: 2 })
const THIN_SCHEMA = `
CREATE INDEX IF NOT EXISTS segments_full ON segments (start_ms, nvr, ch) WHERE thinned IS NULL;
CREATE TABLE IF NOT EXISTS thin_inflight (
  path TEXT PRIMARY KEY, loc TEXT, was_bytes INTEGER NOT NULL, was_keyframes INTEGER NOT NULL, at_ms INTEGER NOT NULL);
`

/**
 * Days kept against the target (retention-target.mjs, 2026-09-30, p4-target): where each location's
 * time-lapse begins and ends, and a sample of its real time-lapse files to weigh them against full video.
 * Walking the rows for that reads the whole time-lapse stretch (23 days of 87 cameras at the owner's plan),
 * and an index of every time-lapse row writes one more index page with every file converted: thinning
 * commits a file at a time and is held to 4 WAL pages a file (thinning.test.mjs; WAL checkpoints land on the
 * main thread until perf report Task 12), and every page more brings a checkpoint sooner. So this one holds
 * only the time-lapse files that start in the first minute of an hour -- about one per camera and hour, as
 * files roll over each minute -- and converting a file touches it 1 time in 60 (rec-index-scans.test.mjs:
 * under 0.1 page a file more), at about 1/60 of the size (some 1.5 MB at 23 days of 87 cameras). What it
 * answers is to the hour: the oldest and newest time-lapse are the files of those minutes, and the sample
 * is an hour's first file of each camera, which spreads it over the day and night alike. The query must say
 * TL_ROW word for word, or SQLite will not use the index. Building it on an index that predates it reads
 * every row once, at the first start with this code (as segments_full did).
 */
const TL_ROW = `thinned = ${THIN.timelapse} AND start_ms % 3600000 < 60000`
const TARGET_SCHEMA = `CREATE INDEX IF NOT EXISTS segments_tl ON segments (loc, start_ms) WHERE ${TL_ROW};`
/**
 * retention-target.mjs's lookups, every 5 minutes on the main thread off the hot path (its own timer, one
 * statement per turn of the event loop). Kept here as text so rec-index-scans.test.mjs can check each
 * one's query plan.
 */
export const TARGET_SQL = {
  // where the n-th row from a time starts, whatever its camera or location: a window's end, so each dayUse
  // below reads at most that many rows (counted on segments_start alone, no row read)
  startNth: 'SELECT start_ms AS s FROM segments INDEXED BY segments_start WHERE start_ms >= ? ORDER BY start_ms LIMIT 1 OFFSET ?',
  // what every camera recorded on each location in a window: files, bytes, footage time, and the bytes
  // weighted by the share of keyframes one per interval keeps (thinning's estimate, THIN_SQL.fullSummary)
  dayUse: `SELECT IFNULL(loc, '') AS loc, nvr, ch, COUNT(*) AS files, SUM(bytes) AS bytes, SUM(MAX(0, end_ms - start_ms)) AS ms,
    SUM(bytes * MIN(1.0, MAX(1.0, (end_ms - start_ms) * 1.0 / ?) / MAX(keyframes, 1))) AS weighted
    FROM segments INDEXED BY segments_start WHERE start_ms >= ? AND start_ms < ? GROUP BY IFNULL(loc, ''), nvr, ch`,
  // a location's oldest and newest time-lapse, to the hour (TL_SCHEMA above)
  tlOldest: `SELECT start_ms AS s FROM segments INDEXED BY segments_tl WHERE ${TL_ROW} AND loc = ? ORDER BY start_ms LIMIT 1`,
  tlNewest: `SELECT start_ms AS s FROM segments INDEXED BY segments_tl WHERE ${TL_ROW} AND loc = ? ORDER BY start_ms DESC LIMIT 1`,
  // an hour's first time-lapse file of each camera in a window, by camera: what the real files weigh
  tlSample: `SELECT nvr, ch, COUNT(*) AS files, SUM(bytes) AS bytes, SUM(MAX(0, end_ms - start_ms)) AS ms
    FROM segments INDEXED BY segments_tl WHERE ${TL_ROW} AND loc = ? AND start_ms >= ? AND start_ms < ? GROUP BY nvr, ch`,
  // the first full-video row on a location from a time, among the next `limit` rows there (a window: the
  // caller goes on from `last`); where full video begins after the newest time-lapse
  fullNext: `SELECT MIN(CASE WHEN thinned IS NULL THEN start_ms END) AS s, MAX(start_ms) AS last, COUNT(*) AS n
    FROM (SELECT start_ms, thinned FROM segments INDEXED BY segments_loc WHERE loc = ? AND start_ms >= ? ORDER BY start_ms LIMIT ?)`
}

/**
 * The backfill scan and the recovery after a worker restart (2026-09-30, perf report R5 and R8, and R11's
 * first item for these two). Both run on the main thread, and both read a camera's whole history:
 *  - A gap row is found by gaps_cam (nvr, ch, from_ms), and the rows of a window are those that end after
 *    its start, which from_ms cannot bound: gaps() and lastEnds()'s MAX(to_ms) walked every gap row the
 *    camera has, and they are kept 183 days (nvr-2/0 writes about 5,000 a day; lastEnds for 87 cameras
 *    took 808 ms at 31 days, storage.md). A row that ends after a time and is no longer than LONG_GAP_MS
 *    started at most that long before it: those are a bounded walk of gaps_cam. The longer ones (an
 *    outage of hours or days: a few per camera) are in gaps_long, which holds only them. The query must
 *    say LONG_GAP word for word, or SQLite will not use the index. Building it on an index that predates
 *    it reads every gap row once, at the first start with this code.
 *  - backfill_scan: how far each camera's history has been looked through for holes (backfill.mjs scan()),
 *    so that a scan goes on from there instead of reading 32 days of 87 cameras every tick (3.3-4.5 s of
 *    main thread on production at 4 days of index, about 65-70 s at 32: verify-5). mark_ms: where the
 *    next scan starts (a point inside footage, or where there was none yet); from_ms and min_gap_ms: the
 *    window's start and the shortest hole when the camera's scan began: when either changes, the window
 *    is looked through again.
 */
export const LONG_GAP_MS = 60 * 60_000
const LONG_GAP = `to_ms - from_ms > ${LONG_GAP_MS}`
const SCAN_SCHEMA = `
CREATE INDEX IF NOT EXISTS gaps_long ON gaps (nvr, ch, to_ms) WHERE ${LONG_GAP};
CREATE TABLE IF NOT EXISTS backfill_scan (
  nvr TEXT NOT NULL, ch INTEGER NOT NULL, mark_ms INTEGER NOT NULL, from_ms INTEGER NOT NULL, min_gap_ms INTEGER NOT NULL,
  PRIMARY KEY (nvr, ch));
`
/** Gap rows near a window, and a camera's last gap end (above). Kept here as text so rec-index-scans.test.mjs can check each one's query plan. */
export const GAP_SQL = {
  // every gap row overlapping a window (to_ms >= its start, from_ms <= its end), in from_ms order as gaps()
  // gives them: those that started within LONG_GAP_MS before the window, then the longer ones before that
  near: `SELECT id, nvr, ch, from_ms AS fromMs, to_ms AS toMs, reason FROM gaps WHERE nvr = ? AND ch = ? AND from_ms >= ? AND from_ms <= ? AND to_ms >= ?
    UNION ALL SELECT id, nvr, ch, from_ms, to_ms, reason FROM gaps INDEXED BY gaps_long WHERE nvr = ? AND ch = ? AND to_ms >= ? AND from_ms < ? AND ${LONG_GAP}
    ORDER BY fromMs, id`,
  // lastEnds(): the newest start before a time, the latest end among the rows that started within
  // LONG_GAP_MS of it, and the latest end of the longer ones (lastSegmentEnd()'s way, with gaps_long)
  fromBefore: 'SELECT MAX(from_ms) AS f FROM gaps WHERE nvr = ? AND ch = ? AND from_ms < ?',
  endSince: 'SELECT MAX(to_ms) AS e FROM gaps WHERE nvr = ? AND ch = ? AND from_ms >= ? AND from_ms < ?',
  longEnd: `SELECT MAX(to_ms) AS e FROM gaps INDEXED BY gaps_long WHERE nvr = ? AND ch = ? AND from_ms < ? AND ${LONG_GAP}`
}
/**
 * The backfill scan's reads of one camera (backfill.mjs scan()): a file's start and end, all it needs (the
 * other columns, made into objects, were 72% of the old scan's time: verify-5). Kept here as text so
 * rec-index-scans.test.mjs can check each one's query plan.
 */
export const SCAN_SQL = {
  // every file overlapping a window: those that started within MAX_SEGMENT_MS before it, then the longer
  // ones before that (segments() leaves those out: a false hole at the window's start for the scan)
  spans: `SELECT start_ms AS startMs, end_ms AS endMs FROM segments WHERE nvr = ? AND ch = ? AND start_ms >= ? AND start_ms <= ? AND end_ms >= ?
    UNION ALL SELECT start_ms, end_ms FROM segments INDEXED BY segments_long WHERE nvr = ? AND ch = ? AND end_ms >= ? AND start_ms < ? AND ${LONG_ROW}`,
  // the first file starting after a time and not after a bound
  after: 'SELECT start_ms AS startMs, end_ms AS endMs FROM segments WHERE nvr = ? AND ch = ? AND start_ms > ? AND start_ms <= ? ORDER BY start_ms LIMIT 1'
}

const SEG_COLS = 'nvr, ch, path, start_ms AS startMs, end_ms AS endMs, bytes, keyframes, loc, source, filled_ms AS filledMs'
// (thinning's rows only: playback's keep the shape they had)
const THIN_COLS = `${SEG_COLS}, thinned`
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
  // this only ever deletes less, never more. The lower bound: where the walk goes on after a
  // bookmarked stretch (thinning.mjs runRetention; NO_START for the camera's oldest).
  olderThan: `SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? AND start_ms >= ? AND start_ms < ? AND end_ms < ? ORDER BY start_ms LIMIT ?`,
  // cameras(): one index seek per camera (a skip scan of segments_cam) instead of SELECT DISTINCT,
  // which reads every entry of the index (26 ms on 3 days, and the site keeps 183)
  firstNvr: 'SELECT MIN(nvr) AS nvr FROM segments',
  nextNvr: 'SELECT MIN(nvr) AS nvr FROM segments WHERE nvr > ?',
  firstCh: 'SELECT MIN(ch) AS ch FROM segments WHERE nvr = ?',
  nextCh: 'SELECT MIN(ch) AS ch FROM segments WHERE nvr = ? AND ch > ?'
}
/**
 * The lookups on one storage location: locationUse() (the RAM spool's rows, every 30 s on the main
 * thread: nvrs.mjs watchSpool, ram-spool.mjs; each location's against its space limit, every 5 min:
 * housekeeping.mjs) and the oldest files on one location (housekeeping and thinning, every 5 min per
 * location; ram-spool.mjs). Kept here as text so rec-index-scans.test.mjs can check each one's query plan.
 */
export const LOCATION_SQL = {
  locBytes: 'SELECT bytes AS b, segments AS n FROM loc_totals WHERE loc = ?',
  oldestAt: `SELECT ${SEG_COLS} FROM segments WHERE loc = ? AND start_ms >= ? ORDER BY start_ms LIMIT ?`,
  // (INDEXED BY: with the start bound SQLite chose segments_loc (loc=? AND start_ms>?), a walk of every
  // camera's rows on the drive to find one camera's; segments_cam finds them directly)
  oldestOf: `SELECT ${SEG_COLS} FROM segments INDEXED BY segments_cam WHERE nvr = ? AND ch = ? AND loc = ? AND start_ms >= ? ORDER BY start_ms LIMIT ?`,
  // Each camera's oldest `limit` rows on one location, in one statement: the deletion jobs' first look
  // at a location every 5 minutes (housekeeping.mjs). The cameras come as a JSON list of [nvr, ch]; the
  // subquery is oldestOf's, searched once per camera (CROSS JOIN keeps the list the outer loop). Asking
  // 87 cameras one by one was 87 statements, and asking them again for every file deleted was the 22.8 ms
  // pick that froze the main thread 12-15 s a run once the NAS is full (perf report R2). From a start
  // time on: the first row no bookmark covers (segment-delete.mjs firstUnprotected), NO_START otherwise.
  oldestPerCamera: `SELECT s.nvr, s.ch, s.path, s.start_ms AS startMs, s.end_ms AS endMs, s.bytes, s.keyframes, s.loc, s.source, s.filled_ms AS filledMs
    FROM json_each(?) AS c CROSS JOIN segments AS s
    WHERE s.rowid IN (SELECT rowid FROM segments INDEXED BY segments_cam WHERE nvr = json_extract(c.value, '$[0]') AND ch = json_extract(c.value, '$[1]') AND loc = ? AND start_ms >= ? ORDER BY start_ms LIMIT ?)
    ORDER BY c.key, s.start_ms, s.rowid`
}
/**
 * Time-lapse thinning's lookups (thinning.mjs; THIN above), every 5 minutes on the main thread. Kept here
 * as text so rec-index-scans.test.mjs can check each one's query plan. INDEXED BY: the partial index is
 * the point (a camera's time-lapse days are never read), and it names the mistake at once if the WHERE
 * ever stops implying the index's own.
 */
// (the cameras a walk or a sum is for: a JSON list of "nvr/ch" keys, matched on the index's own columns)
const IN_CAMS = "(nvr || '/' || ch) IN (SELECT value FROM json_each(?))"
export const THIN_SQL = {
  // Where the n-th full-video row from a time on starts, whatever its camera: the end of a window the
  // statements below may pass (thinning.mjs WINDOW_ROWS). A camera not set to time-lapse (or with more
  // full-video days than the rest) keeps its rows here until its retention; the others' walks and sums
  // pass them, at 0.19 us a row on the production VM, and in one statement that was 251-260 ms on the
  // development PC for 20 such cameras of 87 over 31 days (review of p3-thin, 2026-09-29). Counted on the
  // index alone, no row read (the plan does not say covering, as `thinned` is not in the index): 5,000
  // entries in 0.27 ms, 20,000 in 0.63 ms on the development PC (scratchpad p3fix/nth-bench.mjs).
  fullNth: 'SELECT start_ms AS s FROM segments INDEXED BY segments_full WHERE thinned IS NULL AND start_ms >= ? ORDER BY start_ms LIMIT 1 OFFSET ?',
  // the job's walk: some cameras' full-video rows (those with one cutoff) that ended before it, oldest first,
  // starting in one window
  fullOlderThan: `SELECT ${THIN_COLS} FROM segments INDEXED BY segments_full WHERE thinned IS NULL AND start_ms >= ? AND start_ms < ? AND end_ms < ? AND ${IN_CAMS} ORDER BY start_ms LIMIT ?`,
  // where those cameras' next full-video row starts (the sums below skip hours with none)
  firstFull: `SELECT start_ms AS s FROM segments INDEXED BY segments_full WHERE thinned IS NULL AND start_ms >= ? AND start_ms < ? AND ${IN_CAMS} ORDER BY start_ms LIMIT 1`,
  // the dry run's figures and the backlog, a stretch of time at a time, by camera and location: files,
  // bytes, and bytes weighted by the share of keyframes one per timelapseS keeps (at least one a file,
  // at most all of them). No file is read for them (verify-1: the dry run read ~24 GB a run).
  fullSummary: `SELECT nvr, ch, loc, COUNT(*) AS files, SUM(bytes) AS bytes, SUM(bytes * MIN(1.0, MAX(1.0, (end_ms - start_ms) * 1.0 / ?) / MAX(keyframes, 1))) AS weighted, MIN(start_ms) AS firstMs
    FROM segments INDEXED BY segments_full WHERE thinned IS NULL AND start_ms >= ? AND start_ms < ? AND end_ms < ? AND ${IN_CAMS} GROUP BY nvr, ch, loc`,
  // the same sums for ONE camera, from its own rows (camera first): a camera with bookmarks of its own is
  // summed between its own stretches (thinning.mjs backlogOf, since 2026-09-30), and through segments_full
  // each of its windows would pass every other camera's rows again
  fullSummaryOf: `SELECT loc, COUNT(*) AS files, SUM(bytes) AS bytes, SUM(bytes * MIN(1.0, MAX(1.0, (end_ms - start_ms) * 1.0 / ?) / MAX(keyframes, 1))) AS weighted, MIN(start_ms) AS firstMs
    FROM segments INDEXED BY segments_cam WHERE nvr = ? AND ch = ? AND start_ms >= ? AND start_ms < ? AND end_ms < ? AND thinned IS NULL GROUP BY loc`,
  // what every camera recorded in a window (the rate footage passes the cutoff at: thinning's pace)
  startedBetween: 'SELECT COUNT(*) AS files, IFNULL(SUM(bytes), 0) AS bytes FROM segments WHERE start_ms >= ? AND start_ms < ?'
}
/** "From the start" for oldestOf / oldest: earlier than any start_ms. */
const NO_START = Number.MIN_SAFE_INTEGER
/** lastSegmentEnd() without a bound: later than any start. */
const NO_BOUND = Number.MAX_SAFE_INTEGER
const plain = (r) => ({ ...r }) // node:sqlite rows have a null prototype
const one = (r) => (r === undefined ? null : plain(r))
const camKey = (nvr, ch) => `${nvr}/${Number(ch)}`
const codecOf = (path) => /\.(h26[45])$/.exec(String(path))?.[1] ?? null

/**
 * Opens (creating if needed) the index at `file`.
 * walAutocheckpoint: SQLite's automatic checkpoint, every 1,000 WAL pages by default (the server keeps
 * that). Only the tests that measure a job's own main-thread work set it (0: off), because a checkpoint
 * lands in whichever commit crosses the mark, recording's included, and takes 12-124 ms on the production
 * VM: moving checkpoints off the main thread is perf report R11 / Task 12 (2026-09-29, p3-thin).
 */
export function openRecIndex(file, { walAutocheckpoint = null } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  if (Number.isInteger(walAutocheckpoint) && walAutocheckpoint >= 0) db.exec(`PRAGMA wal_autocheckpoint = ${walAutocheckpoint}`)
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
    // (THIN above; a column added with no default costs nothing, the partial index reads every row once)
    if (!have.has('thinned')) db.exec('ALTER TABLE segments ADD COLUMN thinned INTEGER')
  }
  db.exec(THIN_SCHEMA)
  db.exec(TARGET_SCHEMA)
  db.exec(SCAN_SCHEMA)
  // The totals per location (TOTALS_SCHEMA above). A REPLACE's old row is taken off by loc_totals_replace,
  // so the delete trigger must stay out of it: recursive_triggers off (SQLite's default, set in case).
  db.exec('PRAGMA recursive_triggers = OFF')
  if (db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'loc_totals'").get()) db.exec(TOTALS_SCHEMA)
  else {
    // first open with this code: create and fill in one transaction, asked again inside it, so a row
    // written meanwhile by another connection is counted exactly once
    db.exec('BEGIN IMMEDIATE')
    try {
      const had = db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'loc_totals'").get()
      db.exec(TOTALS_SCHEMA)
      if (!had) db.exec("INSERT INTO loc_totals (loc, bytes, segments) SELECT IFNULL(loc, ''), SUM(bytes), COUNT(*) FROM segments GROUP BY IFNULL(loc, '')")
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  const q = {
    add: db.prepare('INSERT OR REPLACE INTO segments (path, nvr, ch, start_ms, end_ms, bytes, keyframes, loc, source, filled_ms, thinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    fullNth: db.prepare(THIN_SQL.fullNth),
    fullOlderThan: db.prepare(THIN_SQL.fullOlderThan),
    firstFull: db.prepare(THIN_SQL.firstFull),
    fullSummary: db.prepare(THIN_SQL.fullSummary),
    fullSummaryOf: db.prepare(THIN_SQL.fullSummaryOf),
    startedBetween: db.prepare(THIN_SQL.startedBetween),
    startNth: db.prepare(TARGET_SQL.startNth),
    dayUse: db.prepare(TARGET_SQL.dayUse),
    tlOldest: db.prepare(TARGET_SQL.tlOldest),
    tlNewest: db.prepare(TARGET_SQL.tlNewest),
    tlSample: db.prepare(TARGET_SQL.tlSample),
    fullNext: db.prepare(TARGET_SQL.fullNext),
    setThin: db.prepare('UPDATE segments SET thinned = ?, bytes = IFNULL(?, bytes), keyframes = IFNULL(?, keyframes) WHERE path = ?'),
    thinBegin: db.prepare('INSERT OR REPLACE INTO thin_inflight (path, loc, was_bytes, was_keyframes, at_ms) VALUES (?, ?, ?, ?, ?)'),
    thinEnd: db.prepare('DELETE FROM thin_inflight WHERE path = ?'),
    thinRow: db.prepare(`SELECT ${THIN_COLS} FROM segments WHERE path = ?`),
    thinAll: db.prepare('SELECT path, loc, was_bytes AS wasBytes, was_keyframes AS wasKeyframes, at_ms AS atMs FROM thin_inflight ORDER BY at_ms, path'),
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
    // the pick a page at a time: pending rows after (from_ms, id), in that order (backfill_state (state, from_ms), the id its rowid)
    bfPage: db.prepare(`SELECT ${BF_COLS} FROM backfill_gaps WHERE state = 'pending' AND (from_ms, id) > (?, ?) ORDER BY from_ms, id LIMIT ?`),
    // holes the NVR has rolled past: the oldest pending ones that ended before a time, a batch at a time
    bfAgeOut: db.prepare("UPDATE backfill_gaps SET state = 'permanent', note = ? WHERE id IN (SELECT id FROM backfill_gaps WHERE state = 'pending' AND from_ms < ? AND to_ms < ? ORDER BY from_ms LIMIT ?)"),
    bfMarks: db.prepare('SELECT nvr, ch, mark_ms AS markMs, from_ms AS fromMs, min_gap_ms AS minGapMs FROM backfill_scan'),
    bfMark: db.prepare('INSERT OR REPLACE INTO backfill_scan (nvr, ch, mark_ms, from_ms, min_gap_ms) VALUES (?, ?, ?, ?, ?)'),
    gapsNear: db.prepare(GAP_SQL.near),
    gapFromBefore: db.prepare(GAP_SQL.fromBefore),
    gapEndSince: db.prepare(GAP_SQL.endSince),
    gapLongEnd: db.prepare(GAP_SQL.longEnd),
    spans: db.prepare(SCAN_SQL.spans),
    spanAfter: db.prepare(SCAN_SQL.after),
    gap: db.prepare('INSERT INTO gaps (nvr, ch, from_ms, to_ms, reason) VALUES (?, ?, ?, ?, ?)'),
    // (start_ms bounded below as in at(): the rows just before the range, never the camera's whole history)
    segs: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE nvr = ? AND ch = ? AND start_ms >= ? AND start_ms <= ? AND end_ms >= ? ORDER BY start_ms`),
    byPath: db.prepare(`SELECT ${SEG_COLS} FROM segments WHERE path = ?`),
    gaps: db.prepare('SELECT nvr, ch, from_ms AS fromMs, to_ms AS toMs, reason FROM gaps WHERE nvr = ? AND ch = ? AND to_ms >= ? AND from_ms <= ? ORDER BY from_ms'),
    oldest: db.prepare(`SELECT ${SEG_COLS} FROM segments ORDER BY start_ms LIMIT ?`),
    oldestAt: db.prepare(LOCATION_SQL.oldestAt),
    oldestOf: db.prepare(LOCATION_SQL.oldestOf),
    oldestPerCamera: db.prepare(LOCATION_SQL.oldestPerCamera),
    olderThan: db.prepare(CAMERA_SQL.olderThan),
    remove: db.prepare('DELETE FROM segments WHERE path = ?'),
    // ram-spool.mjs: a segment copied from memory to a drive keeps its row, with its new place
    moveSeg: db.prepare('UPDATE segments SET path = ?, loc = ? WHERE path = ?'),
    locBytes: db.prepare(LOCATION_SQL.locBytes),
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
  /**
   * The latest to_ms of one camera's gap rows that started before `before`, the same way (GAP_SQL): F = the
   * newest start; a row no longer than LONG_GAP_MS that started before F - LONG_GAP_MS ended before F, and
   * the rows from there on end at F or later (the newest one does, if it ends after it starts), so the
   * answer is theirs or a longer row's (gaps_long). When the rows from F - LONG_GAP_MS on all end before F
   * (the newest row ends before it starts), that fails, and every row of the camera is read as before.
   */
  const lastGapEnd = (nvr, ch, before) => {
    const f = q.gapFromBefore.get(nvr, ch, before).f
    if (f === null) return null
    const near = q.gapEndSince.get(nvr, ch, f - LONG_GAP_MS, before).e
    if (near < f) return q.lastGapEndBefore.get(nvr, ch, before).e
    const long = q.gapLongEnd.get(nvr, ch, before).e
    return long !== null && long > near ? long : near
  }
  /** [{ nvr, ch }] -> the JSON list THIN_SQL matches cameras against ("nvr/ch", as the index's columns make it). */
  const camKeys = (cams) => JSON.stringify(cams.map((c) => camKey(c.nvr, c.ch)))
  /** Runs fn over items in one transaction (nothing to do: no transaction). */
  const inOne = (items, fn) => {
    if (!items.length) return
    if (items.length === 1) return fn(items[0])
    db.exec('BEGIN')
    try {
      for (const x of items) fn(x)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  /** camera key -> the file its writer has open: { nvr, ch, path, startMs, loc } (memory only) */
  const opens = new Map()
  const openSeg = (o) => (o ? { nvr: o.nvr, ch: o.ch, path: o.path, startMs: o.startMs, endMs: null, bytes: null, keyframes: null, loc: o.loc, open: true } : null)
  const openFor = (nvr, ch) => opens.get(camKey(nvr, ch)) ?? null
  return {
    addSegment(s) {
      // source/filledMs: null for footage the recorder wrote live; backfill.mjs sets them to
      // "backfill:<nvr id>" and the time it was pulled, which is what an evidence export states.
      // thinned: a file written again is full video again (the recorder and backfill never pass it)
      q.add.run(String(s.path), String(s.nvr), Number(s.ch), Math.round(s.startMs), Math.round(s.endMs), Number(s.bytes), Number(s.keyframes), s.loc ?? null, s.source ?? null, s.filledMs == null ? null : Math.round(s.filledMs), s.thinned == null ? null : Number(s.thinned))
    },

    // ---- time-lapse thinning (THIN above; thinning.mjs)
    /** Where the full-video row `n` rows on from fromMs starts (n 0: the first at or after it), any camera; null when there are not that many. */
    fullNth: (fromMs, n = 0) => q.fullNth.get(fromMs, Math.max(0, Math.floor(Number(n) || 0)))?.s ?? null,
    /**
     * Some cameras' ([{ nvr, ch }]) full-video rows (thinned null) that ended before ms, oldest first, starting
     * in [fromMs, untilMs) (untilMs: a window's end, thinning.mjs; at most ms).
     */
    fullOlderThan: (cams, ms, limit, fromMs = NO_START, untilMs = ms) => q.fullOlderThan.all(fromMs, Math.min(ms, untilMs), ms, camKeys(cams), Number(limit)).map(plain),
    /** Where those cameras' next full-video row in [fromMs, toMs) starts, or null. */
    firstFull: (cams, fromMs, toMs) => q.firstFull.get(fromMs, toMs, camKeys(cams))?.s ?? null,
    /**
     * Those cameras' full-video rows starting in [fromMs, toMs) and ending before endBefore, by camera and
     * location: [{ nvr, ch, loc, files, bytes, weighted, firstMs }] (weighted: THIN_SQL.fullSummary).
     */
    fullSummary: (cams, { fromMs = NO_START, toMs, endBefore, stepMs }) =>
      q.fullSummary.all(Math.max(1, Number(stepMs)), fromMs, toMs, endBefore, camKeys(cams)).map((r) => ({ nvr: r.nvr, ch: Number(r.ch), loc: r.loc, files: Number(r.files), bytes: Number(r.bytes), weighted: Number(r.weighted), firstMs: Number(r.firstMs) })),
    /** fullSummary for one camera ({ nvr, ch }), read from its own rows only (THIN_SQL.fullSummaryOf). */
    fullSummaryOf: (cam, { fromMs = NO_START, toMs, endBefore, stepMs }) =>
      q.fullSummaryOf.all(Math.max(1, Number(stepMs)), String(cam.nvr), Number(cam.ch), fromMs, toMs, endBefore).map((r) => ({ nvr: String(cam.nvr), ch: Number(cam.ch), loc: r.loc, files: Number(r.files), bytes: Number(r.bytes), weighted: Number(r.weighted), firstMs: Number(r.firstMs) })),
    /** { files, bytes } of every camera's rows that started in [fromMs, toMs). */
    startedBetween: (fromMs, toMs) => {
      const r = q.startedBetween.get(fromMs, toMs)
      return { files: Number(r.files), bytes: Number(r.bytes) }
    },
    /** Marks a row (THIN.timelapse, THIN.kept, or null for full video again); bytes/keyframes when given. */
    setThin(path, state, { bytes = null, keyframes = null } = {}) {
      q.setThin.run(state == null ? null : Number(state), bytes == null ? null : Number(bytes), keyframes == null ? null : Number(keyframes), String(path))
    },
    /**
     * Rewrites of these files may start: what each was (thin_inflight). One row { path, loc, bytes,
     * keyframes } or a list of them, in one transaction (thinning.mjs notes a few files at a time: each
     * commit is WAL pages, and a checkpoint on the main thread every 1,000 of them).
     */
    thinBegin(rows, atMs = Date.now()) {
      inOne(Array.isArray(rows) ? rows : [rows], (r) => q.thinBegin.run(String(r.path), r.loc ?? null, Number(r.bytes), Number(r.keyframes), Math.round(atMs)))
    },
    /** The rewrite is in the file's place (the swap, before its commit): the row says time-lapse with the new size. */
    thinSwapped(path, { bytes, keyframes }) {
      q.setThin.run(THIN.timelapse, Number(bytes), Number(keyframes), String(path))
    },
    /** These rewrites are over (committed, put right, or never started): one path or a list, one transaction. */
    thinEnd(paths) {
      inOne(Array.isArray(paths) ? paths : [paths], (p) => q.thinEnd.run(String(p)))
    },
    /** The rewrites in flight: [{ path, loc, wasBytes, wasKeyframes, atMs }]. */
    thinInflight: () => q.thinAll.all().map(plain),
    /** A file's row with its `thinned` mark (byPath's fields and that), or null. */
    thinRow: (path) => one(q.thinRow.get(String(path))),

    // ---- days kept against the target (TARGET_SQL above; retention-target.mjs)
    /** Where the row `n` rows on from fromMs starts (n 0: the first at or after it), any camera or location; null when there are not that many. */
    startNth: (fromMs, n = 0) => q.startNth.get(fromMs, Math.max(0, Math.floor(Number(n) || 0)))?.s ?? null,
    /**
     * What every camera recorded on each location, of the rows starting in [fromMs, toMs): [{ loc ('' for none), nvr, ch,
     * files, bytes, ms (footage time), weighted (bytes by the share of keyframes one per stepMs keeps) }].
     */
    dayUse: (fromMs, toMs, stepMs) =>
      q.dayUse.all(Math.max(1, Number(stepMs)), fromMs, toMs).map((r) => ({ loc: r.loc, nvr: r.nvr, ch: Number(r.ch), files: Number(r.files), bytes: Number(r.bytes), ms: Number(r.ms), weighted: Number(r.weighted) })),
    /** A location's oldest and newest time-lapse file, to the hour (TL_ROW), or null when it has none. */
    timelapseEdges(loc) {
      const o = q.tlOldest.get(String(loc))?.s ?? null
      return o === null ? null : { oldestMs: o, newestMs: q.tlNewest.get(String(loc))?.s ?? o }
    },
    /** An hour's first time-lapse file of each camera on a location, starting in [fromMs, toMs), by camera: [{ nvr, ch, files, bytes, ms }]. */
    timelapseSample: (loc, fromMs, toMs) => q.tlSample.all(String(loc), fromMs, toMs).map((r) => ({ nvr: r.nvr, ch: Number(r.ch), files: Number(r.files), bytes: Number(r.bytes), ms: Number(r.ms) })),
    /** Among a location's next `limit` rows from fromMs: where the first full-video one starts (s, or null), the last start looked at and how many were. */
    fullNext(loc, fromMs, limit) {
      const r = q.fullNext.get(String(loc), fromMs, Math.max(1, Math.floor(Number(limit) || 1)))
      return { s: r?.s ?? null, last: r?.last ?? null, n: Number(r?.n ?? 0) }
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
    /**
     * Notes many holes in one transaction (backfill.mjs scan(); backfillNote's INSERT OR IGNORE, without
     * reading each row back): returns how many were new.
     */
    backfillNoteMany(gs, nowMs = Date.now()) {
      let added = 0
      inOne(gs, (g) => {
        added += Number(q.bfAdd.run(String(g.nvr), Number(g.ch), Math.round(g.fromMs), Math.round(g.toMs), g.reason ?? null, g.kind ?? null, Math.round(nowMs)).changes)
      })
      return added
    },
    /** Pending rows after `after` ({ fromMs, id }; null: from the oldest), oldest hole first, `limit` of them (backfill.mjs's pick, a page at a time). */
    backfillPendingPage: ({ after = null, limit = 500 } = {}) => q.bfPage.all(after ? Math.round(after.fromMs) : NO_START, after ? Number(after.id) : NO_START, Number(limit)).map(plain),
    /** Marks the oldest `limit` pending rows that ended before toMs permanent, with `note`: how many were. */
    backfillAgeOut: (toMs, note, limit) => Number(q.bfAgeOut.run(note ?? null, Math.round(toMs), Math.round(toMs), Number(limit)).changes),
    /** How far each camera has been scanned for holes: [{ nvr, ch, markMs, fromMs, minGapMs }] (backfill_scan above). */
    backfillMarks: () => q.bfMarks.all().map(plain),
    /** Keeps these cameras' scan marks, in one transaction. */
    backfillMarkSet(marks) {
      inOne(Array.isArray(marks) ? marks : [marks], (m) => q.bfMark.run(String(m.nvr), Number(m.ch), Math.round(m.markMs), Math.round(m.fromMs), Math.round(m.minGapMs)))
    },
    addGap(g) {
      q.gap.run(String(g.nvr), Number(g.ch), Math.round(g.fromMs), Math.round(g.toMs), g.reason ?? null)
    },
    /** Segments of one camera overlapping [fromMs, toMs], oldest first. */
    segments: (nvr, ch, fromMs, toMs) => q.segs.all(String(nvr), Number(ch), fromMs - MAX_SEGMENT_MS, toMs, fromMs).map(plain),
    /**
     * Every file of one camera overlapping [fromMs, toMs], files longer than MAX_SEGMENT_MS that began
     * before it included, as { startMs, endMs } in no set order (SCAN_SQL; backfill.mjs scan()).
     */
    scanSpans: (nvr, ch, fromMs, toMs) => {
      const n = String(nvr)
      const c = Number(ch)
      return q.spans.all(n, c, fromMs - MAX_SEGMENT_MS, toMs, fromMs, n, c, fromMs, Math.min(fromMs - MAX_SEGMENT_MS, toMs + 1))
    },
    /** One camera's first file starting in (afterMs, boundMs], as { startMs, endMs }, or null. */
    scanSpanAfter: (nvr, ch, afterMs, boundMs) => q.spanAfter.get(String(nvr), Number(ch), afterMs, boundMs) ?? null,
    /** The segment row of a file (its primary key), or null (not indexed: still open, or removed). */
    byPath: (path) => one(q.byPath.get(String(path))),
    gaps: (nvr, ch, fromMs, toMs) => q.gaps.all(String(nvr), Number(ch), fromMs, toMs).map(plain),
    /**
     * gaps()'s rows, in its order, without reading the camera's history (GAP_SQL.near: rows that started
     * within LONG_GAP_MS before the window, and the longer ones), each with its id. For the backfill scan
     * and its fill every tick (backfill.mjs).
     */
    gapsNear: (nvr, ch, fromMs, toMs) => {
      const n = String(nvr)
      const c = Number(ch)
      return q.gapsNear.all(n, c, fromMs - LONG_GAP_MS, toMs, fromMs, n, c, fromMs, Math.min(fromMs - LONG_GAP_MS, toMs + 1))
    },
    /** A segment now lives elsewhere (same footage, new file). */
    moveSegment(oldPath, newPath, loc) {
      q.moveSeg.run(String(newPath), loc, String(oldPath))
    },
    /** { bytes, segments } held at one location (the totals kept by triggers: one row read). */
    locationUse: (loc) => {
      const r = q.locBytes.get(String(loc))
      return { bytes: Number(r?.b ?? 0), segments: Number(r?.n ?? 0) }
    },
    /** The oldest segments (all locations; or one location id, those starting at or after fromMs). */
    oldest: (limit, { loc, fromMs = NO_START } = {}) => (loc ? q.oldestAt.all(loc, fromMs, limit) : q.oldest.all(limit)).map(plain),
    /** One camera's oldest segments on one location (those starting at or after fromMs). */
    oldestOf: (nvr, ch, loc, limit, fromMs = NO_START) => q.oldestOf.all(String(nvr), Number(ch), loc, fromMs, limit).map(plain),
    /**
     * Each camera's oldest `limit` segments on one location (those starting at or after fromMs), in one
     * statement: cams [{ nvr, ch }]; the rows come camera by camera in the order given, each camera's
     * oldest first.
     */
    oldestPerCamera: (loc, cams, limit, fromMs = NO_START) => q.oldestPerCamera.all(JSON.stringify(cams.map((c) => [String(c.nvr), Number(c.ch)])), String(loc), fromMs, Number(limit)).map(plain),
    /** One camera's segments that ended before ms (oldest first; those starting at or after fromMs). */
    olderThan: (nvr, ch, ms, limit, fromMs = NO_START) => q.olderThan.all(String(nvr), Number(ch), fromMs, ms, ms, limit).map(plain),
    /** Whether a segment file has a row. */
    has: (path) => q.has.get(String(path)) !== undefined,
    remove(path) {
      q.remove.run(String(path))
    },
    /** Removes the rows of many files in one transaction (a batch the share helper has deleted). */
    removeMany(paths) {
      if (!paths?.length) return
      db.exec('BEGIN')
      try {
        for (const p of paths) q.remove.run(String(p))
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
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
     * when none). beforeMs: only rows that started before it count. For the downtime rows after a start
     * or a worker restart (rec-recover.mjs, 26 cameras at a time). MAX(to_ms) read every gap row of the
     * camera, kept 183 days (23 ms for 87 cameras on a 3-day index, 808 ms at 31 days): lastGapEnd() above
     * since 2026-09-30. Without a bound (tests), still every row.
     */
    lastEnds: (nvr, ch, beforeMs = null) => {
      const n = String(nvr)
      const c = Number(ch)
      const bounded = Number.isFinite(beforeMs)
      return {
        segEnd: lastSegmentEnd(n, c, bounded ? beforeMs : NO_BOUND),
        gapEnd: bounded ? lastGapEnd(n, c, beforeMs) : (q.lastGapEnd.get(n, c)?.e ?? null)
      }
    },
    /** The start of one camera's newest file that started before beforeMs, or null (rec-recover.mjs: where a crash's leftovers can start). */
    newestStart: (nvr, ch, beforeMs) => q.newestStart.get(String(nvr), Number(ch), beforeMs).s ?? null,
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
    /** The files an NVR's worker has announced open: [{ nvr, ch, path, startMs, loc }] (a worker that died: what it left without a row). */
    opensOf: (nvr) => [...opens.values()].filter((o) => o.nvr === String(nvr)).map((o) => ({ ...o })),
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
