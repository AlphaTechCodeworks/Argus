// The audit trail: one JSON line per event in data/audit.jsonl, mode 0600, kept for a year.
//
// What goes in: logins, failed logins, settings changes, exports and playback views — the five
// things somebody would later be asked to account for. Rights changes go in too, because "who
// gave them permission" is the first question after "who did it".
//
// Three rules, and the third is the awkward one:
//   1. Append-only. Nothing here edits or deletes a row. The single exception is prune(), which
//      drops rows past the retention age, and says in the log that it did.
//   2. 0600. The file names who watched which camera and when; that is not world-readable.
//   3. A failed write must be VISIBLE but must never take down the request that caused it. If
//      audit() threw, a full disk would stop people signing in — and an audit trail that can be
//      switched off by filling a disk is worse than useless. So a failure is counted, remembered,
//      logged to the console, and surfaced through auditHealth() on the Audit and Health pages.
//      Silence is the one outcome that is not allowed.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const RETENTION_DAYS = 365
const MAX_DETAIL = 500
const MAX_ROW_BYTES = 4096

/** The kinds of event that are recorded. An unknown action is still written, tagged 'other'. */
export const ACTIONS = Object.freeze([
  'login',
  'login-failed',
  'logout',
  'settings-change',
  'rights-change',
  'export',
  'export-download',
  'playback-view',
  'live-view',
  'audit-prune',
  'other'
])

export const AUDIT_FILE = (dataDir) => join(dataDir, 'audit.jsonl')

// Kept in memory only: a counter that survives as long as the server does. It is deliberately not
// written to the audit file, because the thing that failed is writing to the audit file.
const failure = { count: 0, last: null, at: null }

/** What the pages show about the trail's own health. Zero failures is the only good answer. */
export const auditHealth = () => ({ failures: failure.count, lastError: failure.last, lastErrorAt: failure.at })

/** Only for tests. */
export const resetAuditHealth = () => {
  failure.count = 0
  failure.last = null
  failure.at = null
}

const str = (v, max = 200) => (v === null || v === undefined ? '' : String(v).replace(/[\u0000-\u001f]/g, ' ').slice(0, max))

/**
 * One row, cleaned. Control characters are stripped and every field is length-capped, because a
 * row is written as a single line: a newline smuggled into a user name or a camera label would
 * forge a second audit entry, and a megabyte of "detail" would be a cheap way to fill the disk.
 */
export function auditRow({ at = Date.now(), user, action, target = '', detail = '', ip = '', ok = true } = {}) {
  return {
    at: Number.isFinite(at) ? Math.trunc(at) : Date.now(),
    // 'anonymous' rather than '' so a row can never be mistaken for one with the field missing:
    // a failed login before a name is known is still an event that happened.
    user: str(user, 64) || 'anonymous',
    action: ACTIONS.includes(action) ? action : 'other',
    // The action as given, kept when it was not one of ours, so nothing is lost to the tidy-up.
    ...(ACTIONS.includes(action) ? {} : { rawAction: str(action, 64) }),
    target: str(target, 200),
    detail: str(detail, MAX_DETAIL),
    ip: str(ip, 64),
    ok: ok !== false
  }
}

/**
 * Appends one event. Never throws: see rule 3 at the top.
 * @param {string} dataDir
 * @param {{at?:number, user?:string, action?:string, target?:string, detail?:string, ip?:string, ok?:boolean}} row
 * @returns {boolean} whether it was written — callers that care can check, but none must.
 */
export function audit(dataDir, row) {
  let line
  try {
    line = `${JSON.stringify(auditRow(row))}\n`
    if (Buffer.byteLength(line) > MAX_ROW_BYTES) throw new Error('row too long')
    const file = AUDIT_FILE(dataDir)
    if (!existsSync(file)) {
      mkdirSync(dataDir, { recursive: true })
      // Create it with the right mode up front; appendFileSync's mode is ignored once it exists.
      writeFileSync(file, '', { mode: 0o600 })
    }
    appendFileSync(file, line, { mode: 0o600 })
    return true
  } catch (e) {
    failure.count++
    failure.last = String(e?.message ?? e).slice(0, 200)
    failure.at = Date.now()
    // Loud, and on stderr: this is the one log line an operator must never miss.
    console.error(`[audit] COULD NOT RECORD "${row?.action}" by "${row?.user}": ${failure.last}`)
    return false
  }
}

/**
 * Reads the trail, newest first, with the Audit page's filters.
 * A damaged line is skipped rather than thrown on — half a line after a power cut must not hide
 * the year of good rows around it — but skipped lines are counted and reported, because quietly
 * losing audit rows is exactly what this module exists to prevent.
 * @param {string} dataDir
 * @param {{user?:string, action?:string, from?:number, to?:number, limit?:number}} [filters]
 * @returns {{rows:object[], total:number, damaged:number, truncated:boolean}}
 */
export function readAudit(dataDir, { user = '', action = '', from = 0, to = Infinity, limit = 1000 } = {}) {
  const file = AUDIT_FILE(dataDir)
  if (!existsSync(file)) return { rows: [], total: 0, damaged: 0, truncated: false }
  const wantUser = String(user ?? '').trim().toLowerCase()
  const wantAction = String(action ?? '').trim()
  const lo = Number.isFinite(from) ? from : 0
  const hi = Number.isFinite(to) ? to : Infinity
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), 10_000) : 1000

  let damaged = 0
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      damaged++
      continue
    }
    if (!r || typeof r !== 'object' || !Number.isFinite(r.at)) {
      damaged++
      continue
    }
    if (r.at < lo || r.at > hi) continue
    if (wantAction && r.action !== wantAction) continue
    // Substring, case-insensitive: an investigator types part of a name, not an exact match.
    if (wantUser && !String(r.user ?? '').toLowerCase().includes(wantUser)) continue
    out.push(r)
  }
  out.sort((a, b) => b.at - a.at)
  return { rows: out.slice(0, cap), total: out.length, damaged, truncated: out.length > cap }
}

/**
 * Drops rows older than the retention age by rewriting the file (temp-then-rename, so a crash
 * mid-prune cannot truncate the trail). The prune itself is then recorded, so a year from now the
 * gap at the start of the file has an explanation in the file.
 * @returns {{kept:number, removed:number}}
 */
export function pruneAudit(dataDir, beforeMs = Date.now() - RETENTION_DAYS * 86_400_000) {
  const file = AUDIT_FILE(dataDir)
  if (!existsSync(file)) return { kept: 0, removed: 0 }
  const all = readAudit(dataDir, { limit: Number.MAX_SAFE_INTEGER })
  const keep = all.rows.filter((r) => r.at >= beforeMs).sort((a, b) => a.at - b.at)
  const removed = all.total - keep.length
  if (removed <= 0 && all.damaged === 0) return { kept: keep.length, removed: 0 }
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''), { mode: 0o600 })
  renameSync(tmp, file)
  audit(dataDir, { user: 'system', action: 'audit-prune', detail: `removed ${removed} rows older than ${new Date(beforeMs).toISOString()}` })
  return { kept: keep.length, removed }
}

/**
 * The file's mode, for the Audit page to warn about. null when there is no file yet, and null on
 * Windows, where node reports 0666 for everything and a warning about it would be a false alarm
 * on a page whose job is to be believed. Access there is an NTFS ACL question, not a mode one.
 */
export function auditFileMode(dataDir) {
  const file = AUDIT_FILE(dataDir)
  if (!existsSync(file)) return null
  if (process.platform === 'win32') return null
  return statSync(file).mode & 0o777
}

// ------------------------------------------------------------------------------------- the route

/**
 * GET /api/admin/audit?user=&action=&from=&to=&limit=
 * Admins only, decided by rights.mjs — the trail names who watched what, so reading it is itself
 * a privileged act.
 * @param {string} method
 * @param {string} pathname
 * @param {URLSearchParams} params
 * @param {{user?:string, admin?:boolean}|null} who the session user, from server.mjs
 * @param {string} dataDir
 * @param {{can?:Function}} [deps]
 * @returns {[number, any, object?] | null} null when the path is not this route
 */
export function handleAudit(method, pathname, params, who, dataDir, { can = defaultCan } = {}) {
  if (pathname !== '/api/admin/audit') return null
  if (method !== 'GET') return [405, { error: 'Method not allowed' }, { allow: 'GET' }]
  if (!can(who, 'admin')) return [403, { error: 'Only admins can read the audit log' }]

  const num = (name, fallback) => {
    const raw = params?.get?.(name) ?? ''
    return /^\d{1,15}$/.test(raw) ? Number(raw) : fallback
  }
  const action = params?.get?.('action') ?? ''
  // An unknown action filter is refused rather than ignored: silently showing everything when the
  // filter was mistyped is how somebody concludes there is nothing to find.
  if (action && !ACTIONS.includes(action)) return [400, { error: `action must be one of ${ACTIONS.join(', ')}` }]

  const result = readAudit(dataDir, {
    user: params?.get?.('user') ?? '',
    action,
    from: num('from', 0),
    to: num('to', Infinity),
    limit: num('limit', 1000)
  })
  return [200, { ...result, actions: ACTIONS, retentionDays: RETENTION_DAYS, health: auditHealth(), mode: auditFileMode(dataDir) }]
}

// Imported lazily so audit.mjs stays usable (and testable) on its own; rights.mjs does not import
// this module, so there is no cycle.
let cachedCan = null
function defaultCan(who, action) {
  if (!cachedCan) {
    // A synchronous require-alike is not available in ESM, so the caller normally injects `can`.
    // Without it, default deny — the safe answer — rather than guessing.
    return who !== null && typeof who === 'object' && who.admin === true
  }
  return cachedCan(who, action)
}

/** server.mjs (or a test) can hand in rights.can once, so handleAudit needs no deps argument. */
export const useRights = (canFn) => {
  cachedCan = typeof canFn === 'function' ? canFn : null
}
