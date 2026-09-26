// Per-user rights: who may watch live, play back from the server, play back from the NVR, export
// (and in which formats), and administer. Rights are granted per site (a whole NVR) or per camera.
//
// This is the security layer, so it is written to one rule: DEFAULT DENY. can() returns true only
// when a grant explicitly says so. Anything unexpected — a missing file, a corrupt row, an unknown
// action, a user with no row at all, a target that will not parse — is a refusal, never a shrug.
//
// Two things this module deliberately does NOT do:
//   - It never reads a role, a user id or a rights list out of a request body. The caller passes
//     the `who` that server.mjs built from the signed session cookie; everything else is hostile.
//   - It never grants by accident. The only reason can() ever returns true without a stored grant
//     is `who.admin` from the session (see honourSessionAdmin below), which is how an install with
//     no rights file yet, and CCTV_AUTH=off development, keep working.
//
// Storage: data/rights.json, written 0600 by temp-file-and-rename like settings.mjs.
//
//   { version: 1, users: { alice: { admin: false, grants: { live: ['*'], 'playback-server':
//     ['nvr1', 'nvr2/3'], 'playback-nvr': [], export: ['nvr1/0'] }, formats: ['pack'] } } }
//
// A target in a grant list is one of:
//   '*'        every camera on every NVR ("site-wide" in the plan's words)
//   'nvr1'     every camera on that one NVR
//   'nvr1/3'   channel 3 of that NVR, and nothing else
//
//   GET  /api/admin/rights            -> { users, actions, formats, failures }
//   POST /api/admin/rights            { user, rights } -> { user, rights }
//   GET  /api/rights/me               -> { user, admin, rights }   (anyone signed in: their own)

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR, loadUsers } from './auth.mjs'
import { fileCache } from './file-cache.mjs'
import { audit, useRights } from './audit.mjs'

export const RIGHTS_FILE = join(DATA_DIR, 'rights.json')
const VERSION = 1

/** The five things a person can be allowed to do. Anything not in here is refused outright. */
export const ACTIONS = Object.freeze(['live', 'playback-server', 'playback-nvr', 'export', 'admin'])

/** Export formats, matching export-job.mjs's FORMATS. An export grant with no format is useless. */
export const FORMATS = Object.freeze(['pack', 'mp4', 'stills'])

const GRANTABLE = ACTIONS.filter((a) => a !== 'admin') // 'admin' is a flag, not a per-camera grant

const emptyGrants = () => Object.fromEntries(GRANTABLE.map((a) => [a, []]))

/** A rights row with nothing granted: what an unknown user gets, and what "deny" looks like. */
export const emptyRights = () => ({ admin: false, grants: emptyGrants(), formats: [] })

// ------------------------------------------------------------------- reading and cleaning rows

const isString = (v) => typeof v === 'string'

/**
 * A target is only accepted in exactly the three shapes above. Anything else — an object, a path
 * with two slashes, a negative or non-integer channel, whitespace padding — is dropped rather
 * than guessed at, because a target nobody can read is a target nobody can audit.
 */
function cleanTarget(t) {
  if (!isString(t)) return null
  if (t === '*') return '*'
  const slash = t.indexOf('/')
  if (slash === -1) return /^[\w.:-]{1,64}$/.test(t) ? t : null
  const nvr = t.slice(0, slash)
  const ch = t.slice(slash + 1)
  if (!/^[\w.:-]{1,64}$/.test(nvr)) return null
  if (!/^\d{1,3}$/.test(ch)) return null
  return `${nvr}/${Number(ch)}` // normalised, so '007' and '7' cannot become two different grants
}

/**
 * Turns whatever is on disk (or whatever an admin posted) into a row can() can trust.
 * Everything unrecognised is discarded. There is no "pass it through in case it means something":
 * an unknown key in a rights row is either a bug or an attack, and both should lose.
 */
export function cleanRights(raw) {
  const out = emptyRights()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  out.admin = raw.admin === true // only the literal true; 'true', 1 and {} are not admin
  const grants = raw.grants && typeof raw.grants === 'object' && !Array.isArray(raw.grants) ? raw.grants : {}
  for (const action of GRANTABLE) {
    const list = Array.isArray(grants[action]) ? grants[action] : []
    const seen = new Set()
    for (const t of list) {
      const c = cleanTarget(t)
      if (c) seen.add(c)
    }
    out.grants[action] = [...seen].sort()
  }
  const formats = Array.isArray(raw.formats) ? raw.formats : []
  out.formats = FORMATS.filter((f) => formats.includes(f))
  return out
}

/**
 * The whole store. A missing file triggers the migration below; an unreadable one is reported and
 * treated as empty, which denies everyone except the session-admin fallback — loud, but not a
 * silent grant.
 * @returns {{version:number, users:Record<string, ReturnType<typeof emptyRights>>}}
 */
// read on nearly every request (can): from memory while the file is unchanged (file-cache.mjs)
const rightsCache = fileCache(RIGHTS_FILE, () => readRights())
/** The stored rights (a fresh outer object: a caller may replace .users without touching the cache). */
export function loadRights() {
  return { ...rightsCache.get() }
}

function readRights() {
  if (!existsSync(RIGHTS_FILE)) return migrateRights()
  let raw
  try {
    raw = JSON.parse(readFileSync(RIGHTS_FILE, 'utf8'))
  } catch (e) {
    console.error(`[rights] ${RIGHTS_FILE} is unreadable (${e.message}); nobody has stored rights until it is fixed`)
    return { version: VERSION, users: {} }
  }
  // A null prototype, deliberately: with an ordinary object, looking up the user name
  // "constructor" or "toString" would find something on Object.prototype and hand can() a
  // "rights row" that is really a function. Default deny has to mean deny for every name.
  const users = Object.create(null)
  const src = raw?.users && typeof raw.users === 'object' ? raw.users : {}
  for (const [name, row] of Object.entries(src)) if (isString(name) && name && name !== '__proto__') users[name] = cleanRights(row)
  return { version: VERSION, users }
}

/**
 * The rights of one named user.
 *
 * The fallback matters more than the lookup: a user who has no row at all keeps the role their
 * account already carries in users.json. An admin there is an admin here. Without that, dropping
 * this module onto a running server — or an admin created later with adduser.mjs — would lock the
 * owner out of their own system, and there is no console to recover from.
 * @param {string} name
 */
export function rightsOf(name) {
  if (!isString(name) || !name) return emptyRights()
  const users = loadRights().users
  // Object.hasOwn as well as the null prototype above: belt and braces, because getting this
  // wrong hands an attacker a rights row for any name that happens to exist on Object.prototype.
  if (Object.hasOwn(users, name)) return users[name]
  const accounts = loadUsers()
  const row = emptyRights()
  if (Object.hasOwn(accounts, name) && accounts[name]?.role === 'admin') row.admin = true
  return row
}

// ------------------------------------------------------------------------------- the migration

/**
 * Builds the first rights.json from users.json, preserving exactly what everyone can do today:
 *   - an admin (including an old role-less account, which auth.mjs already calls an admin)
 *     becomes admin here, so nothing they do changes;
 *   - a viewer gets live and NVR playback everywhere, which is what viewers have always had,
 *     and gets no server playback and no export, which is what canPlayServer already refused them.
 * Nobody gains anything. If the file cannot be written the rights are still returned, so a
 * read-only data folder degrades to "same as before" rather than to "everyone locked out".
 */
export function migrateRights() {
  // Null prototype for the same reason loadRights uses one: a user literally called "constructor"
  // must not end up writing to Object.prototype.
  const users = Object.create(null)
  for (const [name, u] of Object.entries(loadUsers())) {
    users[name] =
      u?.role === 'admin'
        ? { ...emptyRights(), admin: true }
        : { ...emptyRights(), grants: { ...emptyGrants(), live: ['*'], 'playback-nvr': ['*'] } }
  }
  const store = { version: VERSION, users }
  try {
    if (Object.keys(users).length > 0) writeStore(store)
  } catch (e) {
    console.error(`[rights] could not write ${RIGHTS_FILE} (${e.message}); falling back to the accounts' own roles`)
  }
  return store
}

function writeStore(store) {
  mkdirSync(dirname(RIGHTS_FILE), { recursive: true })
  const tmp = `${RIGHTS_FILE}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(store, null, 1)}\n`, { mode: 0o600 })
  renameSync(tmp, RIGHTS_FILE)
  rightsCache.forget()
}

/**
 * Stores one user's rights. Two refusals, both deliberate:
 *   - an unknown account cannot be given rights (a typo would otherwise create a ghost row that
 *     springs to life the day somebody creates that name);
 *   - the last admin cannot be demoted. Locking every admin out of a running CCTV server is not
 *     recoverable from the web interface, and this is the only place it could happen.
 * @throws {Error & {status:number}}
 */
export function saveRights(name, raw) {
  const bad = (status, message) => Object.assign(new Error(message), { status })
  if (!isString(name) || !/^[\w.@-]{1,64}$/.test(name)) throw bad(400, 'user name is missing or not allowed')
  if (!Object.hasOwn(loadUsers(), name)) throw bad(400, `there is no account called ${name}`)
  const store = loadRights()
  const row = cleanRights(raw)
  const after = Object.assign(Object.create(null), store.users, { [name]: row })
  // Count admins as they will be, including accounts with no row yet (rightsOf's fallback).
  const accounts = loadUsers()
  const admins = Object.keys(accounts).filter((u) => (Object.hasOwn(after, u) ? after[u].admin : accounts[u]?.role === 'admin'))
  if (admins.length === 0) throw bad(400, 'there must be at least one admin; make someone else an admin first')
  store.users = after
  writeStore(store)
  return row
}

/** Every account that is an admin right now, sorted. The Health page shows this. */
export function adminList() {
  const store = loadRights()
  return Object.entries(loadUsers())
    .filter(([name, u]) => (Object.hasOwn(store.users, name) ? store.users[name].admin : u?.role === 'admin'))
    .map(([name]) => name)
    .sort()
}

/** Every account with its rights, for the rights screen. */
export function listRights() {
  return Object.keys(loadUsers())
    .sort()
    .map((user) => ({ user, ...rightsOf(user) }))
}

// --------------------------------------------------------------------------------- the decision

/**
 * Does one grant list cover this camera? '*' covers everything, 'nvr1' covers that whole site,
 * 'nvr1/3' covers only that camera. A grant is never widened by a target the caller left blank:
 * asking "may I export?" with no camera named only passes on a '*' grant.
 */
function covers(list, nvr, ch) {
  if (!Array.isArray(list) || list.length === 0) return false
  if (list.includes('*')) return true
  if (nvr === null) return false
  if (list.includes(nvr)) return true
  return ch !== null && list.includes(`${nvr}/${ch}`)
}

/** Accepts {nvr, ch}, 'nvr1/3' or 'nvr1'. Anything else is "no camera named", never "all". */
function parseTarget(target) {
  if (target === null || target === undefined) return { nvr: null, ch: null, format: null }
  if (isString(target)) {
    const c = cleanTarget(target)
    if (!c || c === '*') return { nvr: null, ch: null, format: null }
    const slash = c.indexOf('/')
    return slash === -1 ? { nvr: c, ch: null, format: null } : { nvr: c.slice(0, slash), ch: Number(c.slice(slash + 1)), format: null }
  }
  if (typeof target !== 'object') return { nvr: null, ch: null, format: null }
  const nvr = isString(target.nvr) && target.nvr ? target.nvr : isString(target.nvrId) && target.nvrId ? target.nvrId : null
  // Only a real integer channel counts. '3', 3.5, NaN and null all mean "no channel named", which
  // makes a per-camera grant miss rather than match.
  const ch = Number.isInteger(target.ch) && target.ch >= 0 ? target.ch : null
  const format = isString(target.format) ? target.format : null
  return { nvr, ch, format }
}

/**
 * THE decision. Every route asks this and nothing re-implements it.
 *
 * @param {{user?:string, admin?:boolean}|string|null|undefined} who the session's user — built by
 *   server.mjs from the signed cookie. Never pass anything that came out of a request body.
 * @param {'live'|'playback-server'|'playback-nvr'|'export'|'admin'} action
 * @param {{nvr?:string, ch?:number, format?:string}|string|null} [target] the camera, and for an
 *   export the format. An export with no format named is refused: "may export something" is not a
 *   question this system answers.
 * @param {{honourSessionAdmin?:boolean}} [opts] honourSessionAdmin false ignores who.admin and
 *   uses only the stored rights (the tests use it to prove the store alone decides).
 * @returns {boolean} true only when something explicitly allows it.
 */
export function can(who, action, target = null, { honourSessionAdmin = true } = {}) {
  if (!ACTIONS.includes(action)) return false

  const name = isString(who) ? who : isString(who?.user) ? who.user : null
  // who.admin comes from server.mjs (auth.isAdmin, or CCTV_AUTH=off). It is trusted because it is
  // derived from the session, and it is the reason a fresh install is not locked out of itself.
  const sessionAdmin = honourSessionAdmin && who !== null && typeof who === 'object' && who.admin === true
  if (!name && !sessionAdmin) return false

  const rights = name ? rightsOf(name) : emptyRights()
  if (rights.admin || sessionAdmin) return true // an admin may do everything, everywhere
  if (action === 'admin') return false // and only an admin is an admin

  const { nvr, ch, format } = parseTarget(target)
  if (!covers(rights.grants[action], nvr, ch)) return false
  if (action !== 'export') return true
  // An export grant is only half a permission: the format has to be allowed too.
  return format !== null && FORMATS.includes(format) && rights.formats.includes(format)
}

/**
 * "Could this person do this at all, somewhere?" — the coarse gate a page or a listing route uses
 * before it bothers to look up cameras. It is NOT a substitute for can(): every actual camera and
 * format is still checked individually. It returns true only when something is granted, so it is
 * still default deny.
 */
export function canAny(who, action) {
  if (!ACTIONS.includes(action)) return false
  if (can(who, 'admin')) return true
  const name = isString(who) ? who : isString(who?.user) ? who.user : null
  if (!name) return false
  const rights = rightsOf(name)
  if (action === 'admin') return rights.admin
  const list = rights.grants[action] ?? []
  if (list.length === 0) return false
  // An export grant over cameras but no format allowed is not an export permission at all.
  return action !== 'export' || rights.formats.length > 0
}

/** Convenience for the old canPlayServer(who, nvrId, ch) call shape. */
export const canPlayServer = (who, nvrId, ch) =>
  can(who, 'playback-server', { nvr: isString(nvrId) && nvrId ? nvrId : null, ch: Number.isInteger(ch) && ch >= 0 ? ch : null })

// ------------------------------------------------------------------------------------- the route

const ROUTES = { '/api/admin/rights': ['GET', 'POST'], '/api/rights/me': ['GET'] }

/**
 * @param {string} method
 * @param {string} pathname
 * @param {() => Promise<object>} readJson the request's JSON object body
 * @param {{user?:string, admin?:boolean}|null} who the session user, from server.mjs
 * @returns {Promise<[number, any, object?] | null>} null when the path is not one of these routes
 */
export async function handleRights(method, pathname, readJson, who) {
  const methods = ROUTES[pathname]
  if (!methods) return null
  if (!methods.includes(method)) return [405, { error: 'Method not allowed' }, { allow: methods.join(', ') }]

  const name = isString(who) ? who : isString(who?.user) ? who.user : null

  if (pathname === '/api/rights/me') {
    if (!name && !(who && who.admin === true)) return [401, { error: 'Sign in first' }]
    const mine = name ? rightsOf(name) : emptyRights()
    return [200, { user: name, admin: mine.admin || who?.admin === true, rights: mine, actions: ACTIONS, formats: FORMATS }]
  }

  if (!can(who, 'admin')) return [403, { error: 'Only admins can change rights' }]
  if (method === 'GET') return [200, { users: listRights(), actions: ACTIONS, formats: FORMATS, admins: adminList() }]

  try {
    const body = await readJson()
    // The name comes from the body because an admin is editing somebody else. The *authority* to
    // do so came from the session above, which is the part that must never be client-supplied.
    const user = String(body?.user ?? '')
    const rights = saveRights(user, body?.rights)
    // "Who gave them permission" is the first question after "who did it", so a rights change is
    // itself an audited event. The stored row is recorded, not what was posted: they differ
    // whenever cleanRights() has thrown something out.
    audit(DATA_DIR, {
      user: name ?? 'dev',
      action: 'rights-change',
      target: user,
      detail: `${rights.admin ? 'admin; ' : ''}${GRANTABLE.map((a) => `${a}=${rights.grants[a].join('|') || 'none'}`).join(' ')} formats=${rights.formats.join('|') || 'none'}`
    })
    return [200, { user, rights }]
  } catch (e) {
    // Everything that can go wrong here is the caller's fault (unknown account, bad name, bad
    // JSON, the last-admin rule), so 400 with the reason. Nothing else is leaked.
    return [400, { error: e?.message ?? 'bad request' }]
  }
}

// audit.mjs cannot import this module (that would be a cycle), so it is handed can() from here.
// Until this happens, handleAudit falls back to "session admin only", which is stricter, not
// looser — the fallback can never grant more than the real check would.
useRights(can)
