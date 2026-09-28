// Viewer accounts and sessions.
// Users live in data/users.json as scrypt hashes (manage with cctv/adduser.mjs).
// Sessions are stateless signed cookies: base64url(user).expiry.hmac
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

export const saveUsers = (users) => {
  ensureDir(USERS_FILE)
  writeFileSync(USERS_FILE, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 })
  usersCache.forget()
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
