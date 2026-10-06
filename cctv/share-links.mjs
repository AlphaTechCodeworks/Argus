// Public, time-limited share links to one finished export (clip sharing). A link carries a long
// random token and nothing else; opening it needs no account. It names exactly one export job and
// expires; it can be revoked. The bytes a link serves are the same ZIP the signed-in download
// streams (export-api.mjs) -- only the gate differs. Design:
// docs/superpowers/specs/2026-10-04-clip-sharing-design.md
//
// Stored in DATA_DIR/shares.json (never on a recording location). Every create, revoke and
// anonymous download is audited. The store file is injectable so the whole module is testable with
// a temp folder and no SDK.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { audit } from './audit.mjs'
import { DATA_DIR } from './auth.mjs'

const FILE = join(DATA_DIR, 'shares.json')
/** The expiries the UI offers, in days. */
export const SHARE_DAYS = Object.freeze([1, 7, 30])
const DAY_MS = 24 * 60 * 60 * 1000
/** 32 random bytes as base64url: the only credential a link carries. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

const isString = (v) => typeof v === 'string'
const nowMs = () => Date.now()

function load(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(raw?.shares) ? raw.shares : []
  } catch {
    return [] // missing or unreadable: no links
  }
}

function save(shares, file) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ version: 1, shares }), { mode: 0o600 })
  renameSync(tmp, file)
}

/** A record is usable only while it exists, is not revoked, and has not expired. */
const live = (s, at) => Boolean(s) && s.revoked !== true && Number.isFinite(s.expiresAt) && s.expiresAt > at

/** The landing page's snapshot, taken at creation so a link never has to re-read the job. */
function cleanInfo(info) {
  const s = (v) => (isString(v) && v ? v.slice(0, 200) : null)
  return { label: s(info?.label), when: s(info?.when), format: s(info?.format) }
}

/**
 * A new link for one finished export. days must be one of SHARE_DAYS. info { label, when, format }
 * is the snapshot the landing page shows. Dead links are pruned on the way. Returns the record.
 * @throws {Error & {status:number}}
 */
export function createShare({ jobId, by, days, info }, { file = FILE } = {}) {
  const bad = (message) => Object.assign(new Error(message), { status: 400 })
  if (!isString(jobId) || !jobId) throw bad('a job is required')
  if (!SHARE_DAYS.includes(Number(days))) throw bad('pick an expiry of 1, 7 or 30 days')
  const at = nowMs()
  const rec = { token: randomBytes(32).toString('base64url'), jobId, by: isString(by) && by ? by : null, createdAt: at, expiresAt: at + Number(days) * DAY_MS, revoked: false, info: cleanInfo(info) }
  const shares = load(file).filter((s) => live(s, at))
  shares.push(rec)
  save(shares, file)
  audit(DATA_DIR, { user: rec.by ?? 'system', action: 'share-create', target: jobId, detail: `${rec.info.label ?? jobId}; expires ${new Date(rec.expiresAt).toISOString()}` })
  return rec
}

/** The live record for a token, or null -- missing, expired and revoked are indistinguishable on purpose. */
export function getShare(token, { file = FILE, at = nowMs() } = {}) {
  if (!isString(token) || !TOKEN_RE.test(token)) return null
  const s = load(file).find((x) => x.token === token)
  return live(s, at) ? s : null
}

/** What the public landing page may know: nothing but what it shows. null for a bad token. */
export function shareInfo(token, opts = {}) {
  const s = getShare(token, opts)
  return s ? { ok: true, label: s.info?.label ?? null, when: s.info?.when ?? null, format: s.info?.format ?? null, expiresAt: s.expiresAt } : { ok: false }
}

/** An admin sees every live link; anyone else only their own. Each with its job snapshot and expiry. */
export function listSharesFor(who, { file = FILE, at = nowMs() } = {}) {
  const admin = who?.admin === true
  const user = isString(who) ? who : isString(who?.user) ? who.user : null
  return load(file)
    .filter((s) => live(s, at))
    .filter((s) => admin || (user && s.by === user))
    .map((s) => ({ token: s.token, jobId: s.jobId, by: s.by, createdAt: s.createdAt, expiresAt: s.expiresAt, info: s.info }))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Revoke a link (drop it): its owner, or an admin. Returns true when one was removed, false when
 * there was no such token.
 * @throws {Error & {status:number}} 403 when it is someone else's link
 */
export function revokeShare(token, who, { file = FILE } = {}) {
  const admin = who?.admin === true
  const user = isString(who) ? who : isString(who?.user) ? who.user : null
  const shares = load(file)
  const s = shares.find((x) => x.token === token)
  if (!s) return false
  if (!admin && !(user && s.by === user)) throw Object.assign(new Error('that link is not yours to revoke'), { status: 403 })
  save(shares.filter((x) => x.token !== token && live(x, nowMs())), file)
  audit(DATA_DIR, { user: user ?? 'system', action: 'share-revoke', target: s.jobId, detail: token })
  return true
}

/**
 * The signed-in share-management routes:
 *   GET    /api/shares          -> { shares: [...] }
 *   DELETE /api/shares/:token   -> { revoked: token }
 * Creating a link is POST /api/exports/:id/share (export-api.mjs: it has the job and mayReach).
 * @returns {[number, object] | null} null when the path is not one of these
 */
export function handleShares(method, pathname, who) {
  if (pathname === '/api/shares') {
    if (method !== 'GET') return [405, { error: 'Method not allowed' }]
    return [200, { shares: listSharesFor(who) }]
  }
  const m = /^\/api\/shares\/([A-Za-z0-9_-]{1,64})$/.exec(pathname)
  if (!m) return null
  if (method !== 'DELETE') return [405, { error: 'Method not allowed' }]
  try {
    return revokeShare(m[1], who) ? [200, { revoked: m[1] }] : [404, { error: 'No such link' }]
  } catch (e) {
    return [Number.isInteger(e?.status) ? e.status : 400, { error: e?.message ?? 'bad request' }]
  }
}

export const _test = { FILE, live, cleanInfo }
