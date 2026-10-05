// Viewer accounts and sessions.
// Users live in data/users.json as scrypt hashes (manage with cctv/adduser.mjs).
// Sessions are stateless signed cookies: base64url(user).expiry.hmac. A signed-out one is remembered
// (revokeSession) until it would have run out anyway, so the token is refused wherever it still is.
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileCache } from './file-cache.mjs'

const scrypt = promisify(scryptCb)

export const DATA_DIR = process.env.DATA_DIR ?? join(import.meta.dirname, '..', 'data')
const USERS_FILE = join(DATA_DIR, 'users.json')
const SECRET_FILE = join(DATA_DIR, 'session-secret')
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const COOKIE_NAME = 'cctv_session'

const ensureDir = (file) => mkdirSync(dirname(file), { recursive: true })

const loadSecret = () => {
  if (!existsSync(SECRET_FILE)) {
    ensureDir(SECRET_FILE)
    writeFileSync(SECRET_FILE, randomBytes(32).toString('hex'), { mode: 0o600 })
  }
  return readFileSync(SECRET_FILE, 'utf8').trim()
}

/**
 * @returns {Record<string, { hash: string, role: 'admin' | 'viewer' }>}
 * Older files stored just the hash per user; those accounts were created before
 * roles existed (by the owner), so they become admins.
 */
// read on every request and video socket (verifySession, isAdmin): from memory while the file is
// unchanged (one stat per use, so adduser.mjs changes apply at once: file-cache.mjs)
const usersCache = fileCache(USERS_FILE, () => readUsers())
/** A fresh copy: callers change it and saveUsers() it. */
export const loadUsers = () => ({ ...usersCache.get() })

const readUsers = () => {
  if (!existsSync(USERS_FILE)) return {}
  const raw = JSON.parse(readFileSync(USERS_FILE, 'utf8'))
  return Object.fromEntries(
    Object.entries(raw).map(([name, v]) => [name, typeof v === 'string' ? { hash: v, role: 'admin' } : v])
  )
}

/** Admins can manage NVRs and sites; viewers can only watch. */
export const isAdmin = (user) => {
  const users = loadUsers()
  return Object.hasOwn(users, user) && users[user]?.role === 'admin'
}

// Told after users.json is saved and after a session is signed out. server.mjs hands in
// access-watch.mjs's sweep: a removed account, a changed role or a signed-out session must also end
// the video sockets already open with it, not only refuse the next request.
const changedHooks = new Set()
/** @returns {() => void} unsubscribes */
export const onUsersChanged = (fn) => {
  changedHooks.add(fn)
  return () => changedHooks.delete(fn)
}
const usersChanged = () => {
  for (const fn of changedHooks) {
    try {
      fn()
    } catch (e) {
      console.error(`[auth] a listener for changed accounts failed: ${e.message}`)
    }
  }
}

export const saveUsers = (users) => {
  ensureDir(USERS_FILE)
  writeFileSync(USERS_FILE, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 })
  usersCache.forget()
  usersChanged()
}

export const hashPassword = async (password) => {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, 64)
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`
}

const verifyPassword = async (password, stored) => {
  const [, saltHex, hashHex] = stored.split(':')
  const expected = Buffer.from(hashHex, 'hex')
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length)
  return timingSafeEqual(actual, expected)
}

// a fixed hash to compare against for unknown users, so response time doesn't reveal valid names
const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'))

export const checkLogin = async (user, password) => {
  const stored = loadUsers()[user]?.hash
  const ok = await verifyPassword(String(password), stored ?? DUMMY_HASH)
  return ok && stored !== undefined
}

const secret = loadSecret()
const sign = (payload) => createHmac('sha256', secret).update(payload).digest('base64url')

export const createSession = (user) => {
  const payload = `${Buffer.from(user).toString('base64url')}.${Date.now() + SESSION_TTL_MS}`
  return `${payload}.${sign(payload)}`
}

/** Returns the user name for a valid session token, otherwise null. */
export const verifySession = (token) => {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const payload = `${parts[0]}.${parts[1]}`
  const sig = Buffer.from(parts[2])
  const expected = Buffer.from(sign(payload))
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null
  if (Number(parts[1]) < Date.now()) return null
  if (revokedSessions().has(parts[2])) return null // signed out (revokeSession)
  const user = Buffer.from(parts[0], 'base64url').toString()
  const users = loadUsers()
  // hasOwn, not `in`: `'constructor' in {}` is true, and a name that resolves through
  // Object.prototype must not count as an account.
  if (!Object.hasOwn(users, user)) return null // removed users lose access immediately
  // The token names the account only by name, so a name removed and made again would take the old
  // holder's unexpired cookie with it. An account made from the app or adduser.mjs records `since`;
  // a token issued before then (issued = expiry - TTL) belongs to the earlier account. An account
  // made before `since` existed has none and keeps its sessions as before.
  const since = users[user]?.since
  if (Number.isFinite(since) && Number(parts[1]) - SESSION_TTL_MS < since) return null
  return user
}

// Signed-out sessions. A session is a signed cookie the server keeps no record of, so signing out
// only cleared the cookie in that one browser: the token itself stayed good until it ran out (7
// days), and a page still open with it kept its video sockets and could open more. Its signature is
// kept here with the time it would have run out anyway, and verifySession refuses it. Written 0600
// by temp-file-and-rename, read once: only this process signs sessions out.
const REVOKED_FILE = join(DATA_DIR, 'revoked-sessions.json')
let revoked = null // signature -> expiry (ms)
const revokedSessions = () => {
  if (revoked) return revoked
  revoked = new Map()
  if (!existsSync(REVOKED_FILE)) return revoked
  try {
    const raw = JSON.parse(readFileSync(REVOKED_FILE, 'utf8'))
    for (const [sig, exp] of Object.entries(raw && typeof raw === 'object' ? raw : {})) if (Number.isFinite(exp) && exp >= Date.now()) revoked.set(sig, exp)
  } catch (e) {
    console.error(`[auth] ${REVOKED_FILE} is unreadable (${e.message}); sessions signed out before now are good again until they run out`)
  }
  return revoked
}

/**
 * Signs one session out for good: verifySession refuses its token from now on, wherever it is (a
 * page still open with it, a copy of the cookie), not only in the browser whose cookie is cleared.
 * @returns {boolean} whether there was a session to sign out (junk never reaches the file)
 */
export const revokeSession = (token) => {
  if (verifySession(token) === null) return false
  const [, expiry, sig] = token.split('.')
  const list = revokedSessions()
  const now = Date.now()
  for (const [s, exp] of list) if (exp < now) list.delete(s) // run out anyway: refused without the list
  list.set(sig, Number(expiry))
  try {
    ensureDir(REVOKED_FILE)
    const tmp = `${REVOKED_FILE}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(list))}\n`, { mode: 0o600 })
    renameSync(tmp, REVOKED_FILE)
  } catch (e) {
    console.error(`[auth] could not write ${REVOKED_FILE} (${e.message}); that session is signed out until the server restarts`)
  }
  usersChanged()
  return true
}

// A cookie value that is not valid percent-encoding ("cctv_session=%") made decodeURIComponent
// throw. On a WebSocket upgrade nothing caught that, so one unauthenticated request with such a
// header took the whole server down (security audit, 2026-09-27). A value that cannot be decoded is
// kept as it came: it matches no session.
const decodeCookie = (v) => {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

export const parseCookies = (header = '') =>
  Object.fromEntries(
    String(header ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [k, decodeCookie(v)])
  )

export const sessionCookie = (token, secure) =>
  `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`

export const clearCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`

/** Simple per-IP limiter for login attempts: 10 failures per 15 minutes. */
const failures = new Map()
export const loginBlocked = (ip) => {
  const f = failures.get(ip)
  return f !== undefined && f.count >= 10 && Date.now() - f.first < 15 * 60 * 1000
}
export const recordFailure = (ip) => {
  const f = failures.get(ip)
  if (!f || Date.now() - f.first > 15 * 60 * 1000) failures.set(ip, { count: 1, first: Date.now() })
  else f.count++
}
export const clearFailures = (ip) => failures.delete(ip)
