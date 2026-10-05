// The alert history: one JSON line per open or clear, in data/alerts.jsonl.
// Read newest first for the Health page; pruned to 30 days by the nightly job.
// A damaged line is skipped, never thrown: the history is nice to have, not critical, and a
// half-written last line after a power cut must not stop the page from loading.

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = (dataDir) => join(dataDir, 'alerts.jsonl')

/** Appends one row: { at, event: 'opened'|'cleared', key, kind, title, detail, severity, sentTo? }. */
export function appendAlert(dataDir, row) {
  appendFileSync(FILE(dataDir), `${JSON.stringify(row)}\n`, { mode: 0o600 })
}

/** Rows with at >= sinceMs, newest first. Damaged lines are skipped. */
export function readAlerts(dataDir, sinceMs = 0) {
  const f = FILE(dataDir)
  if (!existsSync(f)) return []
  const out = []
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (Number.isFinite(row?.at) && row.at >= sinceMs) out.push(row)
  }
  return out.sort((a, b) => b.at - a.at)
}

/** Drops rows older than beforeMs, by rewriting the file. */
export function pruneAlerts(dataDir, beforeMs) {
  const f = FILE(dataDir)
  if (!existsSync(f)) return
  // Oldest first again, so the file keeps its natural append order after the rewrite.
  const keep = readAlerts(dataDir, beforeMs).sort((a, b) => a.at - b.at)
  // Write-temp-then-rename: a crash mid-prune must not leave a truncated history.
  const tmp = `${f}.tmp`
  writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''), { mode: 0o600 })
  renameSync(tmp, f)
}
