// Per-user rights: who may watch live, watch live at full quality, play back from the NVR or from this
// server, export (and in which formats), and administer. Granted per site (a whole NVR) or per camera.
//
// This is the security layer, so it is written to one rule: DEFAULT DENY. can() returns true only
// when a grant explicitly says so. Anything unexpected — a missing file, a corrupt row, an unknown
// action, a user with no row at all, a target that will not parse — is a refusal, never a shrug.
//
// Two things this module deliberately does NOT do:
//   - It never reads a role, a user id or a rights list out of a request body. The caller passes
//     the `who` that server.mjs built from the signed session cookie; everything else is hostile.
//   - It never grants by accident. The only reason can() ever returns true without a stored grant
//     is admin: the account's role in users.json (rightsOf), or `who.admin` from the session (see
//     honourSessionAdmin below), which is how an install with no rights file yet, and CCTV_AUTH=off
//     development, keep working. Admin is stored nowhere else: an admin flag in a row is ignored.
//
// The actions, with the access editor's names: live (Live: the grid, on the camera's sub-stream),
// live-hd (Live HD: full screen at full quality, the main stream; it counts only where live covers
// the camera too), playback-nvr (Playback SD: the NVR's own recordings), playback-server (Playback HD:
// this server's own recordings), export (with its formats). mayHd below is the one rule for a
// recorded or still picture from the main stream: Live HD or Playback HD on the camera.
//
// Storage: data/rights.json, written 0600 by temp-file-and-rename like settings.mjs.
//
//   { version: 2, users: { alice: { admin: false, grants: { live: ['*'], 'live-hd': ['nvr1'],
//     'playback-server': ['nvr1', 'nvr2/3'], 'playback-nvr': [], export: ['nvr1/0'] }, formats: ['pack'] } } }
//
// A version 1 file (before Live HD) is upgraded when first read: Live HD wherever Live is, except for
// an account the shadow data/rights.v2.json remembers (upgradeToV2). The file replaced is kept as
// data/rights.v1.json. A file from a newer release is read as far as this one understands it and
// never rewritten: the access editor's saves are refused, and an account removed or made again takes
// out only its own row (forgetInNewer).
//
// A target in a grant list is one of:
//   '*'        every camera on every NVR ("site-wide" in the plan's words)
//   'nvr1'     every camera on that one NVR
//   'nvr1/3'   channel 3 of that NVR, and nothing else
//
//   GET  /api/admin/rights            -> { users, actions, formats, admins }; each user's row
//                                         carries `seen`, a token of it right now
//   POST /api/admin/rights            { user, rights, seen } -> { user, rights }
//                                         409 { error, stale: true } when `seen` is missing or does
//                                         not match: a stale editor screen must not silently put back
//                                         access someone else already took away while it sat open;
//                                         409 { error, outdated: true } when rights.grants['live-hd']
//                                         is missing: an editor page from before Live HD would store
//                                         it empty; 409 { error, newer: true } when rights.json is
//                                         from a newer release
// The pages learn what they may do per camera from /api/cameras (liveCameras, playbackCameras), not
// from their rights row.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR, loadUsers, saveUsers } from './auth.mjs'
import { fileCache } from './file-cache.mjs'
import { audit, useRights } from './audit.mjs'

export const RIGHTS_FILE = join(DATA_DIR, 'rights.json')
/** The version 1 file an upgrade replaced, byte for byte: a manual rollback is a copy back. */
export const RIGHTS_V1_BACKUP = join(DATA_DIR, 'rights.v1.json')
/** Every account's Live HD as this version last wrote it: what an upgrade after a rollback restores. */
export const RIGHTS_SHADOW = join(DATA_DIR, 'rights.v2.json')
/** Where an upgrade keeps a copy of a shadow it could not use (it then gives Live HD to nobody: upgradeToV2). */
export const RIGHTS_SHADOW_UNREADABLE = `${RIGHTS_SHADOW}.unreadable`
/** No shadow was written before 2026 (it came with this release): an earlier writtenAt is not a time it was written at. */
const SHADOW_FIRST_MS = Date.UTC(2026, 0, 1)
const VERSION = 2

/** The six things a person can be allowed to do. Anything not in here is refused outright. */
export const ACTIONS = Object.freeze(['live', 'live-hd', 'playback-server', 'playback-nvr', 'export', 'admin'])

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
  let text
  let raw
  try {
    text = readFileSync(RIGHTS_FILE, 'utf8')
    raw = JSON.parse(text)
  } catch (e) {
    console.error(`[rights] ${RIGHTS_FILE} is unreadable (${e.message}); nobody has stored rights until it is fixed`)
    return { version: VERSION, users: Object.create(null) }
  }
  // A null prototype, deliberately: with an ordinary object, looking up the user name
  // "constructor" or "toString" would find something on Object.prototype and hand can() a
  // "rights row" that is really a function. Default deny has to mean deny for every name.
  const users = Object.create(null)
  const plain = raw?.users !== null && typeof raw?.users === 'object' && !Array.isArray(raw.users)
  const src = plain ? raw.users : {}
  for (const [name, row] of Object.entries(src)) if (isString(name) && name && name !== '__proto__') users[name] = cleanRights(row)
  // a missing or odd version is 1: the files before Live HD, tests and hand edits leave it out
  const from = Number.isInteger(raw?.version) && raw.version >= 1 ? raw.version : 1
  if (from > VERSION) {
    noteNewer(from)
    return { version: VERSION, users, newer: from }
  }
  // Never a file whose users is not an object: that stays on disk for a human to fix, and denies.
  if (from < VERSION && plain) return upgradeToV2(users, text, from, src, raw.version)
  return { version: VERSION, users }
}

let newerNoted = 0 // the newer on-disk version this process has already reported
function noteNewer(from) {
  if (newerNoted === from) return
  newerNoted = from
  const detail = `rights.json is version ${from}, newer than this release (${VERSION}): read as far as version ${VERSION} understands it; editor saves refused, and an account removed or made again takes out only its own row`
  console.warn(`[rights] ${detail}`)
  audit(DATA_DIR, { user: 'system', action: 'rights-change', target: '*', detail })
}

/**
 * The shadow as { writtenAt, users: { name: [targets] } }; null when there is none; { unreadable: why }
 * when there is one that cannot be used (unreadable, not JSON, not a shadow, a writtenAt that is no
 * time a Date can hold, or before 2026), which the upgrade must not take for "none": that would give
 * Live HD = Live to everyone, back to every account it had been taken from (upgradeToV2 fails closed
 * instead). An account's entry that is not a list holds no Live HD, for the same reason (it is still
 * remembered).
 * An unusable shadow comes with its bytes (`bytes`), for the copy upgradeToV2 keeps; none when it
 * could not be read at all.
 */
function readShadow() {
  if (!existsSync(RIGHTS_SHADOW)) return null
  let bytes
  try {
    bytes = readFileSync(RIGHTS_SHADOW)
  } catch (e) {
    return { unreadable: e.message }
  }
  try {
    const raw = JSON.parse(bytes.toString('utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a rights shadow')
    // within the Date range (+-8.64e15 ms): the upgrade's audit row prints it, and toISOString throws past it
    if (!Number.isFinite(raw.writtenAt) || Math.abs(raw.writtenAt) > 8.64e15) throw new Error('its writtenAt is not a time')
    // and not before this file existed (0, 1970, a clock that was wrong): every account with users.json
    // `since` would count as made after it, and get Live HD = Live
    if (raw.writtenAt < SHADOW_FIRST_MS) throw new Error('its writtenAt is before any shadow was written')
    if (!raw.users || typeof raw.users !== 'object' || Array.isArray(raw.users)) throw new Error('it has no users')
    const users = Object.create(null)
    for (const [name, list] of Object.entries(raw.users)) {
      if (!isString(name) || !name || name === '__proto__') continue
      users[name] = Array.isArray(list) ? [...new Set(list.map(cleanTarget).filter(Boolean))].sort() : []
    }
    return { writtenAt: raw.writtenAt, users }
  } catch (e) {
    return { unreadable: e.message, bytes }
  }
}

/**
 * Every account's Live HD, beside rights.json: an older release never touches this file. With
 * `before` (the rows as they were), each account's list is cut to what the old row had too
 * (writeStore's first write: the shadow never holds Live HD that rights.json has not got yet).
 * @throws {Error} when it cannot be written
 */
function writeShadow(users, before = null) {
  const hd = (name) => (before ? intersectTargets(before[name]?.grants?.['live-hd'], users[name].grants['live-hd']) : users[name].grants['live-hd'])
  const shadow = { version: VERSION, writtenAt: Date.now(), users: Object.fromEntries(Object.keys(users).sort().map((n) => [n, hd(n)])) }
  const tmp = `${RIGHTS_SHADOW}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, `${JSON.stringify(shadow, null, 1)}\n`, { mode: 0o600 })
    renameSync(tmp, RIGHTS_SHADOW)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {}
    throw new Error(`could not write rights.v2.json (${e.code ?? e.message})`)
  }
}

/** Whether a grant list covers every camera of target t: '*' covers all, a site all of its cameras. */
const coversAll = (list, t) => list.includes('*') || list.includes(t) || (t.includes('/') && list.includes(t.slice(0, t.indexOf('/'))))

/** "a, b, c", or the first eight "and 3 more": names in an audit row, which is cut at 500 characters. */
const someNames = (list) => (list.length > 8 ? `${list.slice(0, 8).join(', ')} and ${list.length - 8} more` : list.join(', '))

/**
 * A version 1 file (before Live HD) as version 2: Live HD wherever Live is, which is what everyone
 * with Live has always had (full screen went to the main stream for anyone who could open the grid).
 * An account the shadow remembers gets the Live HD it had when this version last wrote the file,
 * limited to its Live as it is now: without that, an older release writing the file (an editor save,
 * an account added or removed) and this one coming back would give Live HD back to everyone it had
 * been taken from. An account made after the shadow was written (users.json `since`) is a new person
 * and gets Live HD = Live, as in any first upgrade. Written back once, with the file it replaced kept
 * as rights.v1.json and one audit row; if that cannot be written, the upgraded rights are used from
 * memory and the upgrade is tried again on the next read.
 *
 * Not quite nothing changes: an account whose Playback SD reaches cameras its Live does not (live
 * n1/0, playback-nvr n1) played the NVR's HD stream and saw full-size event pictures there, which now
 * need Live HD or Playback HD (mayHd). They are not given (default deny); the audit row names them.
 *
 * Two cases fail closed. A row that already carries a live-hd list (a version 2 file whose version was
 * mangled into a string or a fraction, read as version 1) keeps that list, cut to its Live: never
 * widened to Live or by the shadow, as a version 2 file is read as it is; a live-hd there that is not
 * a list is an empty one, as a version 2 file reads it. A shadow that is there but
 * cannot be used is not "no shadow" (that would give everyone Live HD = Live, back to every account it
 * had been taken from): every account gets no Live HD (an admin keeps everything: admin is the role),
 * and the audit row and the console say so, with the accounts to give it back to. A copy of its bytes
 * is kept as rights.v2.json.unreadable, and the file itself stays in its place until writeStore's new
 * shadow replaces it (one rename): there is never a moment without a shadow, which a crash, or
 * adduser.mjs upgrading at the same moment, would find with rights.json still version 1 and take for
 * "no shadow". If the copy cannot be kept (or the shadow could not be read at all, so there are no
 * bytes to keep) nothing is written (the shadow would be written over) and the rights are used from
 * memory, with Live HD for nobody. The new shadow in place and rights.json then not written leaves a
 * shadow with no Live HD for anyone, which the next try restores: Live HD for nobody again.
 * @param {object} raw the file's own rows (which of them already carry a live-hd list)
 * @param {*} said the file's own version field (named in the audit row when it is not `from`)
 */
function upgradeToV2(users, text, from, raw = {}, said = from) {
  const shadow = readShadow()
  const bad = shadow?.unreadable ?? null // why the shadow there cannot be used: then Live HD for nobody
  const accounts = loadUsers()
  const restored = []
  const copied = []
  const kept = []
  const withheld = [] // viewers with Live that the unusable shadow left without Live HD
  const sdOnly = []
  const viewer = (name) => Object.hasOwn(accounts, name) && accounts[name]?.role !== 'admin'
  for (const name of Object.keys(users).sort()) {
    const row = users[name]
    // a live-hd key at all, a list or not (as cleanRights reads the grants): a version 2 file reads one
    // that is not a list as [], so it is the row's own list here too, never Live
    const grants = Object.hasOwn(raw, name) ? raw[name]?.grants : undefined
    const own = grants !== null && typeof grants === 'object' && !Array.isArray(grants) && Object.hasOwn(grants, 'live-hd')
    if (bad !== null) {
      row.grants['live-hd'] = []
      if (viewer(name) && row.grants.live.length) withheld.push(name)
    } else if (own) {
      // what the file already says (cleanRights kept it in the row, [] when not a list), only ever narrowed: to Live
      row.grants['live-hd'] = intersectTargets(row.grants['live-hd'], row.grants.live)
      kept.push(name)
    } else {
      const since = Object.hasOwn(accounts, name) ? accounts[name]?.since : undefined
      const remembered = shadow !== null && Object.hasOwn(shadow.users, name) && !(Number.isFinite(since) && since > shadow.writtenAt)
      row.grants['live-hd'] = remembered ? intersectTargets(shadow.users[name], row.grants.live) : [...row.grants.live]
      ;(remembered ? restored : copied).push(name)
    }
    const hd = [...row.grants['live-hd'], ...row.grants['playback-server']]
    if (viewer(name) && row.grants['playback-nvr'].some((t) => !coversAll(hd, t))) sdOnly.push(name)
  }
  const store = { version: VERSION, users }
  try {
    if (bad !== null) {
      // a copy for a person to look at; the file itself is replaced only by writeStore's shadow (a rename
      // over it), never moved first: a shadow gone missing would mean Live HD = Live for everyone
      if (!shadow.bytes) throw new Error(`${RIGHTS_SHADOW} could not be read, so it cannot be kept`)
      writeFileSync(RIGHTS_SHADOW_UNREADABLE, shadow.bytes, { mode: 0o600 })
    }
    const tmp = `${RIGHTS_V1_BACKUP}.tmp-${process.pid}`
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, RIGHTS_V1_BACKUP)
    writeStore(store)
  } catch (e) {
    const none = bad !== null ? `, with Live HD for nobody (${RIGHTS_SHADOW} cannot be used: ${bad})` : ''
    console.error(`[rights] could not write the upgraded ${RIGHTS_FILE} (${e.message}); using it upgraded from memory${none}`)
    return store
  }
  // rights.json is rewritten: from here nothing may throw, or the audit row of what was done is lost
  let detail
  try {
    const lines = []
    // first, so the audit row's 500-character cap never cuts it; the names last, for the same reason
    if (bad !== null) lines.push(`rights.v2.json could not be used (${String(bad).slice(0, 80)}) and a copy of it is kept as rights.v2.json.unreadable, so Live HD was given to nobody; re-grant it in the access editor (Users & audit, Edit access) to whoever should have it: ${withheld.length ? `${withheld.length} account(s) with Live have none now (${someNames(withheld)})` : 'no account but an admin has Live'}`)
    if (kept.length) lines.push(`Live HD kept as the file had it (cut to Live) for ${kept.length} account(s) (${someNames(kept)})`)
    if (copied.length) lines.push(`Live HD given wherever Live was granted for ${copied.length} account(s) (${someNames(copied)})`)
    if (restored.length) lines.push(`Live HD restored from rights.v2.json (written ${new Date(shadow.writtenAt).toISOString()}) for ${restored.length} account(s) (${someNames(restored)})`)
    if (!lines.length) lines.push('no account had rights stored')
    if (sdOnly.length) lines.push(`${sdOnly.length} account(s) (${someNames(sdOnly)}) have Playback SD on cameras without Live HD or Playback HD: there the NVR's recordings and event pictures are now SD only`)
    // (a missing version is an ordinary version 1 file; a string or a fraction is worth saying)
    const version = said === undefined || said === from ? '' : ` (the file said version ${String(JSON.stringify(said)).slice(0, 20)})`
    detail = `rights.json upgraded from version ${from}${version} to ${VERSION}: ${lines.join('; ')}; the stored playback, export and admin rights are unchanged; the old file is kept as rights.v1.json`
  } catch (e) {
    detail = `rights.json upgraded from version ${from} to ${VERSION} (its summary failed: ${e.message}); the old file is kept as rights.v1.json`
  }
  try {
    ;(bad !== null ? console.warn : console.log)(`[rights] ${detail}`)
  } catch {}
  audit(DATA_DIR, { user: 'system', action: 'rights-change', target: '*', detail }) // (never throws)
  return store
}

/**
 * The rights of one named user.
 *
 * Admin is the account's role in users.json and nothing else. The session, the /api/admin gate,
 * users-api.mjs and adduser.mjs all read the role, so a second admin flag stored here could only
 * ever disagree with it: a demoted admin kept every camera through a stale admin row, and switching
 * Admin off in the access editor changed nothing while the role still said admin. The flag stored
 * in a row is ignored; saveRights writes the Admin switch to the role instead. An admin created
 * later with adduser.mjs is therefore an admin here at once, with or without a row.
 *
 * A row whose account is gone grants nothing: a name that comes back is a new person.
 * @param {string} name
 */
export function rightsOf(name) {
  if (!isString(name) || !name) return emptyRights()
  const accounts = loadUsers()
  if (!Object.hasOwn(accounts, name)) return emptyRights()
  const users = loadRights().users
  // Object.hasOwn as well as the null prototype above: belt and braces, because getting this
  // wrong hands an attacker a rights row for any name that happens to exist on Object.prototype.
  const row = Object.hasOwn(users, name) ? { ...users[name] } : emptyRights()
  row.admin = accounts[name]?.role === 'admin'
  return row
}

/**
 * A short fingerprint of one user's rights row (the admin flag included, which mirrors the account's
 * role). Two reads a moment apart get the same token only when nothing changed in between: the
 * access editor's compare-and-swap (handleRights below) sends this back as `seen`, so a stale editor
 * screen cannot silently restore access someone else already took away while it sat open.
 */
export function rightsToken(row) {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 16)
}

// ------------------------------------------------------------------------------- the migration

/**
 * Builds the first rights.json from users.json, preserving exactly what everyone can do today:
 *   - an admin (including an old role-less account, which auth.mjs already calls an admin)
 *     becomes admin here, so nothing they do changes;
 *   - a viewer gets live, full screen at full quality (live-hd) and NVR playback everywhere,
 *     which is what viewers have always had,
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
        : { ...emptyRights(), grants: { ...emptyGrants(), live: ['*'], 'live-hd': ['*'], 'playback-nvr': ['*'] } }
  }
  const store = { version: VERSION, users }
  try {
    if (Object.keys(users).length > 0) writeStore(store)
  } catch (e) {
    console.error(`[rights] could not write ${RIGHTS_FILE} (${e.message}); falling back to the accounts' own roles`)
  }
  return store
}

// Told after every write of rights.json. server.mjs hands in access-watch.mjs's sweep: a camera taken
// away must also end the sockets already showing it, not only refuse the next one.
const savedHooks = new Set()
/** @returns {() => void} unsubscribes */
export function onRightsSaved(fn) {
  savedHooks.add(fn)
  return () => savedHooks.delete(fn)
}

const saved = () => {
  for (const fn of savedHooks) {
    try {
      fn()
    } catch (e) {
      console.error(`[rights] a listener for saved rights failed: ${e.message}`)
    }
  }
}

/**
 * Writes rights.json and the shadow beside it (every account's Live HD: what an upgrade after a
 * rollback restores, upgradeToV2). The shadow must never hold Live HD that rights.json has not got,
 * or a save that failed half way, then a rollback and a return, would give back HD that was taken
 * away or never given. So, given the rows as they were (`before`): first the shadow with each
 * account's Live HD cut to what the old row had too, then rights.json, then the shadow as the new
 * rows. A shadow that cannot be written refuses the save before rights.json is touched; the last
 * write failing leaves the cut shadow, which errs on the side of less. Without `before` (a first
 * file, or the upgrade itself, which a crash repeats with the same result) the shadow is the new rows.
 * @param {{ version: number, users: object, newer?: number }} store
 * @param {object|null} [before] the rows before this change
 * @throws {Error} a store read from a newer release's file (it would lose what this one does not know)
 */
function writeStore(store, before = null) {
  if (store.newer) throw new Error(`rights.json is version ${store.newer}, from a newer release: this one does not rewrite it`)
  mkdirSync(dirname(RIGHTS_FILE), { recursive: true })
  writeShadow(store.users, before)
  const tmp = `${RIGHTS_FILE}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify({ version: VERSION, users: store.users }, null, 1)}\n`, { mode: 0o600 })
  renameSync(tmp, RIGHTS_FILE)
  rightsCache.forget()
  if (before) {
    try {
      writeShadow(store.users)
    } catch (e) {
      console.error(`[rights] ${e.message}; it keeps the Live HD the old and the new rows both have`)
    }
  }
  saved()
}

/**
 * forgetRights on a rights.json from a newer release: only that account's row is taken out, and the
 * file is written back as it was otherwise (its version, and every right this release does not know).
 * Rewriting it as version 2 would drop those; leaving the row would hand it to the next account of
 * that name. Audited, since the newer release will read a file this one changed.
 */
function forgetInNewer(name) {
  const raw = JSON.parse(readFileSync(RIGHTS_FILE, 'utf8'))
  if (!raw?.users || typeof raw.users !== 'object' || Array.isArray(raw.users) || !Object.hasOwn(raw.users, name)) return false
  delete raw.users[name]
  const tmp = `${RIGHTS_FILE}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(raw, null, 1)}\n`, { mode: 0o600 })
  renameSync(tmp, RIGHTS_FILE)
  rightsCache.forget()
  audit(DATA_DIR, { user: 'system', action: 'rights-change', target: name, detail: `rights.json (version ${raw.version}, from a newer release): the row of ${name} removed with the account; the rest kept as it was` })
  saved()
  return true
}

/** The stored rows of accounts that exist, in a fresh null-prototype object (never the cached one). */
function rowsOfAccounts(users, accounts) {
  const out = Object.create(null)
  for (const name of Object.keys(users)) if (name !== '__proto__' && Object.hasOwn(accounts, name)) out[name] = users[name]
  return out
}

/**
 * Stores one user's rights. Two refusals, both deliberate:
 *   - an unknown account cannot be given rights (a typo would otherwise create a ghost row that
 *     springs to life the day somebody creates that name);
 *   - the last admin cannot be demoted. Locking every admin out of a running CCTV server is not
 *     recoverable from the web interface, and this is the only place it could happen.
 * The Admin switch is written to the account's role in users.json (see rightsOf: the role is the only
 * admin there is). Rows left behind by accounts that no longer exist are dropped on the way.
 * @throws {Error & {status:number}}
 */
export function saveRights(name, raw) {
  const bad = (status, message) => Object.assign(new Error(message), { status })
  if (!isString(name) || !/^[\w.@-]{1,64}$/.test(name)) throw bad(400, 'user name is missing or not allowed')
  const accounts = loadUsers()
  if (!Object.hasOwn(accounts, name)) throw bad(400, `there is no account called ${name}`)
  const store = loadRights()
  if (store.newer) throw bad(409, `rights.json was written by a newer version of Argus (version ${store.newer}); this version will not change it`)
  const row = cleanRights(raw)
  // Count admins as they will be: every account's role, with this one's as it is being saved.
  const admins = Object.keys(accounts).filter((u) => (u === name ? row.admin : accounts[u]?.role === 'admin'))
  if (admins.length === 0) throw bad(400, 'there must be at least one admin; make someone else an admin first')
  const before = store.users
  store.users = Object.assign(rowsOfAccounts(store.users, accounts), { [name]: row })
  writeStore(store, before)
  if (row.admin !== (accounts[name]?.role === 'admin')) saveUsers({ ...accounts, [name]: { ...accounts[name], role: row.admin ? 'admin' : 'viewer' } })
  return row
}

/**
 * Drops one user's stored row. Called when an account is removed and when a new one is made, so a
 * name that comes back starts from rightsOf's fallback (nothing, or admin for an admin account)
 * instead of inheriting whatever the last holder of that name was allowed. With no rights.json yet,
 * loadRights migrates first (a viewer would get live '*'), and the new name's row goes straight after.
 * @returns {boolean} whether there was a row to drop
 */
export function forgetRights(name) {
  if (!isString(name) || !name || name === '__proto__') return false
  const store = loadRights()
  if (!Object.hasOwn(store.users, name)) return false
  if (store.newer) return forgetInNewer(name)
  const before = store.users
  const users = Object.assign(Object.create(null), store.users) // never change the cached object
  delete users[name]
  store.users = users
  writeStore(store, before)
  return true
}

/** Every account that is an admin right now (its role in users.json), sorted. The Health page shows this. */
export function adminList() {
  return Object.entries(loadUsers())
    .filter(([, u]) => u?.role === 'admin')
    .map(([name]) => name)
    .sort()
}

/** Every account with its rights, for the rights screen; each row carries `seen` (rightsToken), the
 * compare-and-swap token the access editor must send back with any change to that row. */
export function listRights() {
  return Object.keys(loadUsers())
    .sort()
    .map((user) => {
      const rights = rightsOf(user)
      return { user, ...rights, seen: rightsToken(rights) }
    })
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
 * @param {'live'|'live-hd'|'playback-server'|'playback-nvr'|'export'|'admin'} action
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
  // Live HD is an add-on to Live on the same camera, never a way in by itself: a stray live-hd target
  // (hand-edited, restored from the shadow) grants nothing where Live does not cover the camera too
  if (action === 'live-hd' && !covers(rights.grants.live, nvr, ch)) return false
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
  if (action === 'live-hd' && rights.grants.live.length === 0) return false // HD counts only with Live
  // An export grant over cameras but no format allowed is not an export permission at all.
  return action !== 'export' || rights.formats.length > 0
}

/**
 * GET /api/sites for one user. An admin gets every NVR as nvrs.mjs info() gives it. Anyone else
 * gets only the NVRs they hold some grant on ('*', the NVR, or one of its cameras, in any action),
 * and of those only the site, name and status the viewer's site filter and "is offline" notice
 * need: the address, P2P serial, model, serial number, camera counts and error text (which names
 * host:port) are admin-only. A zero-grant viewer is told about no site at all.
 */
export function sitesFor(who, list) {
  if (can(who, 'admin')) return list
  const user = isString(who) ? who : isString(who?.user) ? who.user : null
  if (!user) return []
  const { grants } = rightsOf(user)
  const onNvr = (t, id) => t === '*' || t === id || t.startsWith(`${id}/`)
  return list
    // Live HD alone shows nothing (it counts only with Live), so it reveals no site either
    .filter((s) => GRANTABLE.some((a) => a !== 'live-hd' && (grants[a] ?? []).some((t) => onNvr(t, s.id))))
    .map(({ id, site, name, status }) => ({ id, site, name, status }))
}

/** Convenience for the old canPlayServer(who, nvrId, ch) call shape. */
export const canPlayServer = (who, nvrId, ch) =>
  can(who, 'playback-server', { nvr: isString(nvrId) && nvrId ? nvrId : null, ch: Number.isInteger(ch) && ch >= 0 ? ch : null })

/**
 * The same for the NVR's own recordings: an NVR playback session, and what fills a server playback's
 * gaps (rec-fallback.mjs). playback-server alone never reaches the NVR, which may still hold days
 * the server has already let go.
 */
export const canPlayNvr = (who, nvrId, ch) =>
  can(who, 'playback-nvr', { nvr: isString(nvrId) && nvrId ? nvrId : null, ch: Number.isInteger(ch) && ch >= 0 ? ch : null })

/**
 * May this person see a recorded or still picture from this camera's main stream: Live HD or Playback
 * HD on it. The one rule for the NVR's main stream in playback (with playback-nvr, rec-playback.mjs)
 * and the full-size event picture (event-snapshot.mjs). Live main asks live-hd alone (live-attach.mjs):
 * Playback HD does not open full screen live.
 */
export const mayHd = (who, nvrId, ch) => {
  const t = { nvr: isString(nvrId) && nvrId ? nvrId : null, ch: Number.isInteger(ch) && ch >= 0 ? ch : null }
  return can(who, 'live-hd', t) || can(who, 'playback-server', t)
}

/** The one target covering exactly the cameras both cover, or null: '*' ∩ x = x, 'n1' ∩ 'n1/3' = 'n1/3'. */
function meet(a, b) {
  if (a === '*') return b
  if (b === '*') return a
  const nvrA = a.includes('/') ? a.slice(0, a.indexOf('/')) : a
  const nvrB = b.includes('/') ? b.slice(0, b.indexOf('/')) : b
  if (nvrA !== nvrB) return null
  if (!a.includes('/')) return b
  if (!b.includes('/')) return a
  return a === b ? a : null
}

/**
 * The cameras two grant lists both cover, as a grant list (sorted, each target once): what an upgrade
 * after a rollback restores of the Live HD the shadow remembers, limited to the Live there is now
 * (upgradeToV2), and what the shadow's first write keeps (writeStore).
 */
export function intersectTargets(a, b) {
  const out = new Set()
  for (const x of a ?? []) for (const y of b ?? []) {
    const m = meet(x, y)
    if (m) out.add(m)
  }
  return [...out].sort()
}

/**
 * GET /api/cameras for one user: the cameras they may watch live, each with `hd` (Live HD there: full
 * screen at full quality) and `playback` (either playback right there: the full-size view's Recordings
 * link). An admin gets every camera with everything allowed. The pages use these only to not offer
 * what the server would refuse; every stream asks can() again.
 * @param {object} who the session's user
 * @param {Array<{ nvr: string, ch: number }>} cams nvrs.mjs allCameras()
 */
export function liveCameras(who, cams) {
  // an admin (the session says so, as server.mjs built it): everything, without asking can() four
  // times a camera, each a look at the rights file (file-cache.mjs), every 30 s per open page
  if (who?.admin === true) return cams.map((c) => ({ ...c, hd: true, playback: true }))
  const out = []
  for (const c of cams) {
    const t = { nvr: c.nvr, ch: c.ch }
    if (!can(who, 'live', t)) continue
    out.push({ ...c, hd: can(who, 'live-hd', t), playback: can(who, 'playback-nvr', t) || can(who, 'playback-server', t) })
  }
  return out
}

/**
 * GET /api/cameras?for=playback: the cameras they may play back (either right), each with sd (the NVR's
 * copy: Playback SD), hd (the server's recordings: Playback HD), nvrHd (the NVR's main stream: SD and a
 * right to see main, as rec-playback.mjs asks) and legs (the server's gaps filled from the NVR: both).
 * @param {object} who the session's user
 * @param {Array<{ nvr: string, ch: number }>} cams nvrs.mjs allCameras()
 */
export function playbackCameras(who, cams) {
  if (who?.admin === true) return cams.map((c) => ({ ...c, sd: true, hd: true, nvrHd: true, legs: true }))
  const out = []
  for (const c of cams) {
    const t = { nvr: c.nvr, ch: c.ch }
    const sd = can(who, 'playback-nvr', t)
    const hd = can(who, 'playback-server', t)
    if (!sd && !hd) continue
    out.push({ ...c, sd, hd, nvrHd: sd && (hd || can(who, 'live-hd', t)), legs: sd && hd })
  }
  return out
}

/**
 * May this person play back anything at all on this NVR? /api/playback/now and /dates answer for the
 * whole NVR (its clock and time zone, the days it holds recordings) and each ask costs an SDK call
 * to it, so they are for someone who may play back at least one of its cameras, not for everyone
 * signed in. ch null is asked too, so an NVR-wide or '*' grant counts before any camera is listed.
 */
export function canPlayAnyOn(who, nvrId, chs = []) {
  if (!isString(nvrId) || !nvrId) return false
  return [null, ...chs].some((ch) => can(who, 'playback-nvr', { nvr: nvrId, ch }) || can(who, 'playback-server', { nvr: nvrId, ch }))
}

// ------------------------------------------------------------------------------------- the route

const ROUTES = { '/api/admin/rights': ['GET', 'POST'] }

/**
 * The detail of a rights-change audit row: what changed first, then the whole row, so the audit's
 * 500-character cut (audit.mjs) takes the summary and never the change. The role note comes first:
 * an unchanged "admin" reads the same for someone always an admin and someone just now demoted
 * (rights.admin is false either way once they are out), so a role change says so explicitly.
 */
export function rightsChangeDetail(before, after) {
  const roleNote = before.admin === after.admin ? (after.admin ? 'admin; ' : '') : after.admin ? 'made admin; ' : 'admin removed; '
  const changes = []
  const diff = (label, was, now) => {
    const added = now.filter((t) => !was.includes(t))
    const removed = was.filter((t) => !now.includes(t))
    if (added.length) changes.push(`added ${label}: ${added.join('|')}`)
    if (removed.length) changes.push(`removed ${label}: ${removed.join('|')}`)
  }
  for (const a of GRANTABLE) diff(a, before.grants?.[a] ?? [], after.grants?.[a] ?? [])
  diff('formats', before.formats ?? [], after.formats ?? [])
  const now = `${GRANTABLE.map((a) => `${a}=${after.grants[a].join('|') || 'none'}`).join(' ')} formats=${after.formats.join('|') || 'none'}`
  return `${roleNote}${changes.length ? changes.join('; ') : 'no changes'} | now: ${now}`
}

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
  if (!can(who, 'admin')) return [403, { error: 'Only admins can change rights' }]
  if (method === 'GET') return [200, { users: listRights(), actions: ACTIONS, formats: FORMATS, admins: adminList() }]

  try {
    const body = await readJson()
    // The name comes from the body because an admin is editing somebody else. The *authority* to
    // do so came from the session above, which is the part that must never be client-supplied.
    const user = String(body?.user ?? '')
    // An editor page opened before Live HD existed knows four rights: its row would store live-hd
    // empty, taking full screen at full quality from that person everywhere, and its "Reopen" after
    // the stale refusal below would do exactly that. So a body without the live-hd list is refused
    // first, without the `stale` flag: that page is told to reload, not offered a reopen.
    if (!Array.isArray(body?.rights?.grants?.['live-hd'])) {
      return [409, { error: 'This page is from an older version of Argus: reload it (the access was not saved)', outdated: true }]
    }
    // rights.json from a newer release: saving here would drop every right this version does not know
    const newer = loadRights().newer
    if (newer) return [409, { error: `rights.json was written by a newer version of Argus (version ${newer}); this version will not change it`, newer: true }]
    // Compare-and-swap (STALE EDITOR): the access editor's GET handed out this row's `seen` token.
    // If it does not match the row as it is right now, somebody else changed this person's access
    // while the editor sat open, and saving the whole row it opened with would silently put that
    // change back. A missing token fails the same `!==` compare. Only checked for an account that
    // exists: for one that does not, saveRights below gives the clearer "no account" 400.
    const before = rightsOf(user)
    if (Object.hasOwn(loadUsers(), user) && body?.seen !== rightsToken(before)) {
      return [409, { error: 'Someone changed this person\'s access since you opened it; reopen to see it', stale: true }]
    }
    const rights = saveRights(user, body?.rights)
    // "Who gave them permission" is the first question after "who did it", so a rights change is
    // itself an audited event: the stored row (not what was posted), the change first.
    audit(DATA_DIR, { user: name ?? 'dev', action: 'rights-change', target: user, detail: rightsChangeDetail(before, rights) })
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
