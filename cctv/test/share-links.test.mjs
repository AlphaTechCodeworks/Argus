// Offline tests for clip share links (share-links.mjs) and the public landing page's render mapping
// (public/share.js). Temp data folder only; nothing is sent anywhere, no SDK needed.
//   node cctv/test/share-links.test.mjs
//
// The point of this file is the refusals: a token that is missing, expired or revoked must all look
// the same (null / not valid), and one person must not reach or revoke another's link.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-share-test-'))
const S = await import('../share-links.mjs')
const { view } = await import('../public/share.js')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const threw = (fn) => {
  try { fn(); return null } catch (e) { return e }
}

const FILE = join(process.env.DATA_DIR, 'shares.json')
const ADMIN = { user: 'boss', admin: true }
const ALICE = { user: 'alice', admin: false }
const BOB = { user: 'bob', admin: false }

// ---- create / get -------------------------------------------------------------------------
const rec = S.createShare({ jobId: 'exp-1', by: 'alice', days: 7, info: { label: 'Gate · 10:02', when: 'today', format: 'mp4' } }, { file: FILE })
check('createShare returns a 43-char base64url token', S.TOKEN_RE.test(rec.token), rec.token)
check('...with the job, owner and a future expiry', rec.jobId === 'exp-1' && rec.by === 'alice' && rec.expiresAt > rec.createdAt)
check('getShare returns the live record', S.getShare(rec.token, { file: FILE })?.jobId === 'exp-1')
check('shareInfo shows only the snapshot', (() => { const i = S.shareInfo(rec.token, { file: FILE }); return i.ok === true && i.label === 'Gate · 10:02' && i.format === 'mp4' && i.expiresAt === rec.expiresAt && !('jobId' in i) && !('token' in i) })())

// ---- the refusals, all indistinguishable --------------------------------------------------
check('a bad-shaped token is null', S.getShare('nope', { file: FILE }) === null && S.getShare('', { file: FILE }) === null && S.getShare(null, { file: FILE }) === null)
check('an unknown (well-shaped) token is null', S.getShare('A'.repeat(43), { file: FILE }) === null)
check('an expired token is null (checked at a time past its expiry)', S.getShare(rec.token, { file: FILE, at: rec.expiresAt + 1 }) === null)
check('shareInfo for a bad token says only { ok: false }', JSON.stringify(S.shareInfo('nope', { file: FILE })) === JSON.stringify({ ok: false }))

check('days must be 1, 7 or 30', threw(() => S.createShare({ jobId: 'x', by: 'a', days: 3, info: {} }, { file: FILE }))?.status === 400 && threw(() => S.createShare({ jobId: 'x', by: 'a', days: 7, info: {} }, { file: FILE })) === null)
check('a job is required', threw(() => S.createShare({ jobId: '', by: 'a', days: 7, info: {} }, { file: FILE }))?.status === 400)

// ---- listing is scoped --------------------------------------------------------------------
S.createShare({ jobId: 'exp-2', by: 'bob', days: 1, info: { label: 'Yard' } }, { file: FILE })
check('an owner sees only their own links', S.listSharesFor(ALICE, { file: FILE }).every((s) => s.by === 'alice') && S.listSharesFor(ALICE, { file: FILE }).length >= 1)
check('a stranger sees none of them', S.listSharesFor({ user: 'carol', admin: false }, { file: FILE }).length === 0)
check('an admin sees every live link', S.listSharesFor(ADMIN, { file: FILE }).length >= 2)
check('a listed link carries its snapshot and expiry, not nothing', (() => { const s = S.listSharesFor(ADMIN, { file: FILE })[0]; return typeof s.token === 'string' && typeof s.expiresAt === 'number' && 'info' in s })())

// ---- revoke ------------------------------------------------------------------------------
check('a stranger cannot revoke someone else’s link (403)', threw(() => S.revokeShare(rec.token, BOB, { file: FILE }))?.status === 403)
check('...and it is still live', S.getShare(rec.token, { file: FILE }) !== null)
check('the owner may revoke their own link', S.revokeShare(rec.token, ALICE, { file: FILE }) === true && S.getShare(rec.token, { file: FILE }) === null)
check('revoking a token that is not there is false, not a throw', S.revokeShare('A'.repeat(43), ADMIN, { file: FILE }) === false)

// ---- handleShares (the signed-in routes) --------------------------------------------------
check('GET /api/shares lists the caller’s links', S.handleShares('GET', '/api/shares', ADMIN)[0] === 200)
check('a path that is not ours is null', S.handleShares('GET', '/api/health', ADMIN) === null)
check('POST /api/shares is 405 (creating is a /api/exports route)', S.handleShares('POST', '/api/shares', ADMIN)[0] === 405)
const alive = S.listSharesFor(ADMIN, { file: FILE })[0]
check('DELETE /api/shares/:token revokes', S.handleShares('DELETE', `/api/shares/${alive.token}`, ADMIN)[0] === 200 && S.getShare(alive.token, { file: FILE }) === null)
check('DELETE of an unknown token is 404', S.handleShares('DELETE', `/api/shares/${'B'.repeat(43)}`, ADMIN)[0] === 404)

// ---- the store on disk is private and well-formed ----------------------------------------
check('shares.json holds a version and an array', (() => { const raw = JSON.parse(readFileSync(FILE, 'utf8')); return raw.version === 1 && Array.isArray(raw.shares) })())

// ---- the public landing page's render mapping (share.js view) -----------------------------
check('view: a bad token -> a plain message, not a crash', view({ ok: false }).ok === false && /no longer valid/.test(view({ ok: false }).message) && view(null).ok === false)
check('view: a good token -> label, format upper-cased, expiry formatted', (() => { const v = view({ ok: true, label: 'Gate', when: 'today', format: 'mp4', expiresAt: Date.UTC(2030, 0, 1) }); return v.ok && v.label === 'Gate' && v.format === 'MP4' && typeof v.expires === 'string' })())
check('view: a missing label falls back to "Evidence clip"', view({ ok: true }).label === 'Evidence clip')

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
