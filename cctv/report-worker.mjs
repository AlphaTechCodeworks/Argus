// The counting behind a report (reports.mjs), in its own thread with its own read-only connection to
// the recordings database: a week is about a million segment rows, and adding them up on the main
// thread would hold up the live video it also serves.
//
// In:  workerData { dbFile, fromMs, toMs }
// Out: { coverage: [{ nvr, ch, ms, bytes, segments }], gaps: [{ nvr, ch, reason, n, ms }],
//        events: [{ nvr, ch, type, n }] } or { error }
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

// a segment is at most an hour long (rec-index.mjs MAX_SEGMENT_MS): bounds the index range scan
const MAX_SEGMENT_MS = 60 * 60_000

export function countWindow(db, fromMs, toMs) {
  const plain = (rows) => rows.map((r) => ({ ...r }))
  const coverage = db.prepare(`
    SELECT nvr, ch,
           SUM(MIN(end_ms, :to) - MAX(start_ms, :from)) AS ms,
           SUM(bytes) AS bytes, COUNT(*) AS segments
      FROM segments
     WHERE start_ms >= :lo AND start_ms < :to AND end_ms > :from
     GROUP BY nvr, ch`).all({ from: fromMs, to: toMs, lo: fromMs - MAX_SEGMENT_MS })
  const gaps = db.prepare(`
    SELECT nvr, ch, COALESCE(reason, '') AS reason, COUNT(*) AS n,
           SUM(MIN(to_ms, :to) - MAX(from_ms, :from)) AS ms
      FROM gaps
     WHERE from_ms < :to AND to_ms > :from
     GROUP BY nvr, ch, reason`).all({ from: fromMs, to: toMs })
  let events = []
  try {
    events = db.prepare(`
      SELECT nvr, ch, type, COUNT(*) AS n
        FROM events
       WHERE start_ms >= :from AND start_ms < :to
       GROUP BY nvr, ch, type`).all({ from: fromMs, to: toMs })
  } catch {} // (a database from before the events table)
  return { coverage: plain(coverage), gaps: plain(gaps), events: plain(events) }
}

if (parentPort && workerData?.dbFile) {
  let db
  try {
    db = new DatabaseSync(workerData.dbFile, { readOnly: true })
    parentPort.postMessage(countWindow(db, workerData.fromMs, workerData.toMs))
  } catch (e) {
    parentPort.postMessage({ error: e.message })
  } finally {
    try { db?.close() } catch {}
  }
}
