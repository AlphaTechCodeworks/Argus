// Offline tests for the audit trail (audit.mjs) and the Audit page's render (public/audit.js).
// Temp data folder only; nothing is sent anywhere, and no SDK is needed.
//   node cctv/test/audit.test.mjs
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA = mkdtempSync(join(tmpdir(), 'cctv-audit-test-'))
process.env.DATA_DIR = DATA

const A = await import('../audit.mjs')
const { renderAudit, stamp, actionLabel } = await import('../public/audit.js')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const dir = (n) => {
  const d = join(DATA, n)
  mkdirSync(d, { recursive: true })
  return d
}
const lines = (d) => readFileSync(A.AUDIT_FILE(d), 'utf8').split('\n').filter((l) => l.trim())

const T0 = Date.UTC(2026, 8, 25, 9, 0, 0)
const DAY = 86_400_000

// ---- one row -------------------------------------------------------------------------------
{
  const d = dir('basic')
  check('audit() returns true when it wrote', A.audit(d, { at: T0, user: 'boss', action: 'login', ip: '10.0.0.5' }) === true)
  const row = JSON.parse(lines(d)[0])
  check('the row holds what was given', row.user === 'boss' && row.action === 'login' && row.ip === '10.0.0.5' && row.at === T0, JSON.stringify(row))
  check('ok defaults to true', row.ok === true)
  check('one line per event', lines(d).length === 1)
  A.audit(d, { at: T0 + 1, user: 'boss', action: 'logout' })
  check('a second event appends, it does not replace', lines(d).length === 2)

  const mode = statSync(A.AUDIT_FILE(d)).mode & 0o777
  check(
    process.platform === 'win32' ? 'audit.jsonl mode: not checked on Windows' : 'audit.jsonl is mode 0600',
    process.platform === 'win32' ? true : mode === 0o600,
    mode.toString(8)
  )
  check('auditFileMode reports it, and null on Windows where a mode means nothing', A.auditFileMode(d) === (process.platform === 'win32' ? null : mode))
  check('auditFileMode is null when there is no file', A.auditFileMode(dir('empty-dir')) === null)
}

// ---- hostile rows --------------------------------------------------------------------------
{
  const d = dir('hostile')
  // The forgery that matters for a line-per-row file: a newline inside a field would otherwise
  // let a caller write a second, invented audit entry.
  A.audit(d, { at: T0, user: 'evil\n{"at":1,"user":"boss","action":"login"}', action: 'login-failed' })
  check('a newline in a field cannot forge a second row', lines(d).length === 1, lines(d).join(' | '))
  const row = JSON.parse(lines(d)[0])
  check('...the newline became a space', !row.user.includes('\n') && row.user.includes('evil'))

  A.audit(d, { at: T0, user: 'x', action: 'become-admin' })
  const made = JSON.parse(lines(d)[1])
  check('an action we do not know becomes "other"', made.action === 'other')
  check('...and the original is kept as rawAction, not lost', made.rawAction === 'become-admin')

  A.audit(d, { at: T0, user: 'x'.repeat(500), action: 'login', detail: 'y'.repeat(5000), target: 'z'.repeat(5000) })
  const capped = JSON.parse(lines(d)[2])
  check('a huge user name is capped', capped.user.length === 64)
  check('a huge detail is capped', capped.detail.length === 500)
  check('a huge target is capped', capped.target.length === 200)

  A.audit(d, {})
  const bare = JSON.parse(lines(d)[3])
  check('a row with nothing in it still records something', bare.user === 'anonymous' && bare.action === 'other' && Number.isFinite(bare.at))
  A.audit(d, { at: 'not a time', user: 'x', action: 'login' })
  check('a nonsense timestamp becomes now, never NaN', Number.isFinite(JSON.parse(lines(d)[4]).at))
  A.audit(d, { at: T0, user: 'x', action: 'login', ok: false })
  check('ok:false is recorded', JSON.parse(lines(d)[5]).ok === false)
  check('auditRow is pure and exported for testing', A.auditRow({ at: T0, user: 'a', action: 'login' }).action === 'login')
}

// ---- a failed write is visible but harmless -------------------------------------------------
{
  A.resetAuditHealth()
  check('the trail starts healthy', A.auditHealth().failures === 0)
  // A path that cannot be a folder because a FILE of that name is in the way. This is the closest
  // stand-in for the real case (a full or read-only disk) that works the same on Windows and Linux.
  const blocker = join(DATA, 'blocked')
  writeFileSync(blocker, 'not a folder')
  let threw = null
  try {
    A.audit(blocker, { at: T0, user: 'boss', action: 'login' })
  } catch (e) {
    threw = e
  }
  check('a failed audit write does NOT throw (the request survives)', threw === null, String(threw))
  check('...it returns false', A.audit(blocker, { at: T0, user: 'boss', action: 'login' }) === false)
  check('...and it is counted, not silent', A.auditHealth().failures >= 1, String(A.auditHealth().failures))
  check('...with the reason kept', typeof A.auditHealth().lastError === 'string' && A.auditHealth().lastError.length > 0)
  check('...and when it happened', Number.isFinite(A.auditHealth().lastErrorAt))
  A.resetAuditHealth()
  check('resetAuditHealth clears it (for the tests only)', A.auditHealth().failures === 0)
}

// ---- reading and filtering -------------------------------------------------------------------
const d = dir('read')
{
  A.audit(d, { at: T0, user: 'boss', action: 'login', ip: '10.0.0.1' })
  A.audit(d, { at: T0 + 1000, user: 'jo', action: 'login-failed', ip: '10.0.0.2' })
  A.audit(d, { at: T0 + 2000, user: 'jo', action: 'playback-view', target: 'nvr1/3' })
  A.audit(d, { at: T0 + DAY, user: 'BOSS-2', action: 'export', target: 'nvr1/3', detail: 'pack' })
  A.audit(d, { at: T0 + 2 * DAY, user: 'boss', action: 'settings-change', target: 'recording' })

  const all = A.readAudit(d)
  check('every row is read back', all.total === 5 && all.rows.length === 5)
  check('newest first', all.rows[0].action === 'settings-change' && all.rows[4].action === 'login')
  check('nothing damaged', all.damaged === 0 && all.truncated === false)

  check('filter by action', A.readAudit(d, { action: 'login-failed' }).rows.every((r) => r.action === 'login-failed'))
  check('...and it finds exactly the one', A.readAudit(d, { action: 'login-failed' }).total === 1)
  check('filter by user is a case-insensitive substring', A.readAudit(d, { user: 'boss' }).total === 3, String(A.readAudit(d, { user: 'boss' }).total))
  check('filter by user finds nothing for a stranger', A.readAudit(d, { user: 'nobody' }).total === 0)
  check('filter by date range', A.readAudit(d, { from: T0 + 500, to: T0 + 3000 }).total === 2)
  check('filters combine (and)', A.readAudit(d, { user: 'jo', action: 'login-failed' }).total === 1)
  check('a range with nothing in it is empty, not everything', A.readAudit(d, { from: T0 + 10 * DAY }).total === 0)
  check('limit caps the rows but total still says how many matched', A.readAudit(d, { limit: 2 }).rows.length === 2 && A.readAudit(d, { limit: 2 }).total === 5)
  check('...and says it truncated', A.readAudit(d, { limit: 2 }).truncated === true)
  check('a missing file reads as empty, not a crash', A.readAudit(dir('nothing-here')).total === 0)
}

// ---- damaged lines ---------------------------------------------------------------------------
{
  const dd = dir('damaged')
  A.audit(dd, { at: T0, user: 'boss', action: 'login' })
  writeFileSync(A.AUDIT_FILE(dd), `${readFileSync(A.AUDIT_FILE(dd), 'utf8')}{"at":123,"user":"hal"\n\n{"user":"no time"}\nnot json at all\n`)
  A.audit(dd, { at: T0 + 5, user: 'jo', action: 'logout' })
  const r = A.readAudit(dd)
  check('good rows around the damage still read', r.total === 2, JSON.stringify(r.rows))
  check('the damage is counted, not hidden', r.damaged === 3, String(r.damaged))
  check('a row with no usable time counts as damaged', A.readAudit(dd).damaged === 3)
}

// ---- retention ---------------------------------------------------------------------------------
{
  check('a year is the retention', A.RETENTION_DAYS === 365)
  const dp = dir('prune')
  A.audit(dp, { at: T0 - 400 * DAY, user: 'old', action: 'login' })
  A.audit(dp, { at: T0 - 366 * DAY, user: 'older-than-a-year', action: 'login' })
  A.audit(dp, { at: T0 - 300 * DAY, user: 'within-the-year', action: 'login' })
  A.audit(dp, { at: T0, user: 'today', action: 'login' })
  const cut = T0 - A.RETENTION_DAYS * DAY
  const res = A.pruneAudit(dp, cut)
  check('rows older than a year are removed', res.removed === 2 && res.kept === 2, JSON.stringify(res))
  const after = A.readAudit(dp)
  check('...the recent rows survive', after.rows.some((r) => r.user === 'today') && after.rows.some((r) => r.user === 'within-the-year'))
  check('...the old ones are gone', !after.rows.some((r) => r.user === 'old'))
  check('the prune itself is recorded, so the gap is explained', after.rows.some((r) => r.action === 'audit-prune'))
  check('the file is still one JSON object per line', lines(dp).every((l) => JSON.parse(l).at !== undefined))
  check('pruning nothing changes nothing', A.pruneAudit(dp, cut).removed === 0)
  check('pruning a file that is not there is not a crash', A.pruneAudit(dir('never-written'), cut).removed === 0)
}

// ---- the route --------------------------------------------------------------------------------
{
  const P = (o = {}) => new URLSearchParams(o)
  const ADMIN = { user: 'boss', admin: true }
  const VIEWER = { user: 'jo', admin: false }
  // handleAudit asks rights.can; here it is injected, which is also how a caller overrides it.
  const can = (who, action) => action === 'admin' && who?.user === 'boss'

  const [s1, b1] = A.handleAudit('GET', '/api/admin/audit', P(), ADMIN, d, { can })
  check('GET as admin: 200 with the rows', s1 === 200 && b1.rows.length === 5)
  check('...and the retention and the trail health', b1.retentionDays === 365 && b1.health.failures === 0)
  check('...and the list of actions, for the filter menu', b1.actions.includes('playback-view'))

  const [s2, b2] = A.handleAudit('GET', '/api/admin/audit', P(), VIEWER, d, { can })
  check('GET as a viewer: 403', s2 === 403, JSON.stringify(b2))
  const [s3] = A.handleAudit('GET', '/api/admin/audit', P(), null, d, { can })
  check('GET with no session: 403', s3 === 403)
  // The escalation attempt: the filters are in the query string, the authority is not.
  const [s4] = A.handleAudit('GET', '/api/admin/audit', P({ admin: 'true', user: 'boss' }), VIEWER, d, { can })
  check('a viewer cannot become an admin through the query string', s4 === 403)
  const [s5] = A.handleAudit('GET', '/api/admin/audit', P(), { user: 'jo', admin: true }, d, { can })
  check('the injected check decides, not who.admin', s5 === 403)

  const [s6, b6] = A.handleAudit('GET', '/api/admin/audit', P({ action: 'login-failed' }), ADMIN, d, { can })
  check('the action filter reaches readAudit', s6 === 200 && b6.total === 1)
  const [s7, b7] = A.handleAudit('GET', '/api/admin/audit', P({ action: 'nonsense' }), ADMIN, d, { can })
  check('an unknown action filter is refused, not silently ignored', s7 === 400 && /must be one of/.test(b7.error))
  const [s8, b8] = A.handleAudit('GET', '/api/admin/audit', P({ from: 'abc', to: '-5' }), ADMIN, d, { can })
  check('nonsense dates fall back to "everything", they do not crash', s8 === 200 && b8.total === 5)
  const [s9] = A.handleAudit('POST', '/api/admin/audit', P(), ADMIN, d, { can })
  check('the audit log cannot be written to over HTTP: 405', s9 === 405)
  check('another path: not handled (null)', A.handleAudit('GET', '/api/admin/settings', P(), ADMIN, d, { can }) === null)
  check('with no rights function injected, only a session admin gets in', A.handleAudit('GET', '/api/admin/audit', P(), { user: 'x', admin: false }, d, { can: undefined })[0] === 403)
}

// ---- the page's render --------------------------------------------------------------------
{
  const body = A.handleAudit('GET', '/api/admin/audit', new URLSearchParams(), { user: 'boss', admin: true }, d, { can: () => true })[1]
  const r = renderAudit(body)
  check('every row is shown', r.rows.length === 5)
  check('the action is in English, not jargon', r.rows.some((x) => x.action === 'Sign-in refused'))
  check('actionLabel falls back gracefully', actionLabel('who-knows') === 'who-knows')
  check('a refused sign-in is marked bad', r.rows.find((x) => x.actionKey === 'login-failed').state === 'bad')
  check('an export is marked warn: it is the row people look for', r.rows.find((x) => x.actionKey === 'export').state === 'warn')
  check('the summary counts', /5 entries/.test(r.summary), r.summary)
  check('the retention is said on the page', /365 days/.test(r.retentionNote))
  check('no warnings when all is well', r.warnings.length === 0, JSON.stringify(r.warnings))
  check('the filter menu is offered in English', r.actions.some((a) => a.value === 'export' && a.label === 'Export made'))
  check('a timestamp renders', typeof stamp(T0) === 'string' && stamp(T0).length > 5)
  check('a nonsense timestamp renders as a dash, not "Invalid Date"', stamp(Number.NaN) === '—')

  const empty = renderAudit({ rows: [], total: 0 }, { user: 'nobody' })
  check('nothing matching says the filters are why', /those filters/.test(empty.summary), empty.summary)
  check('nothing at all says that instead', /Nothing has been recorded/.test(renderAudit({ rows: [], total: 0 }).summary))

  const warned = renderAudit({ rows: [], total: 0, damaged: 2, health: { failures: 3, lastError: 'ENOSPC' }, mode: 0o644 })
  check('failed writes are shouted about on the page', warned.warnings.some((w) => /could not be written/.test(w) && /ENOSPC/.test(w)))
  check('damaged lines are mentioned', warned.warnings.some((w) => /damaged/.test(w)))
  check('a too-open file mode is mentioned', warned.warnings.some((w) => /644/.test(w)))
  check('mode 600 raises nothing', renderAudit({ rows: [], mode: 0o600 }).warnings.length === 0)
  check('an unknown mode (Windows, or no file) raises nothing', renderAudit({ rows: [], mode: null }).warnings.length === 0)
  check('renderAudit survives a junk body', renderAudit(null).rows.length === 0 && renderAudit(undefined).warnings.length === 0)
  check('renderAudit survives an error body', renderAudit({ error: 'nope' }).rows.length === 0)
}

rmSync(DATA, { recursive: true, force: true })
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
