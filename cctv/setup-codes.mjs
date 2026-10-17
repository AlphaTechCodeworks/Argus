// Set-up codes: how a new person's phone is connected without typing anything. An admin asks for a
// code for an account (Users & access, "Set-up code"); the page shows it as a QR code; the phone that
// scans it opens this server's set-up page (or the Argus app reads it), hands the code back, and is
// signed in as that account, with whatever that account is allowed to see.
//
// A code is not a password and never contains one. It is 24 random bytes, works ONCE, and only for
// CODE_TTL_MS; only its SHA-256 is kept (DATA_DIR/setup-codes.json), so the file cannot be used to
// sign in. Asking for a new code for an account cancels that account's unused ones. A code for an
// account that has since been removed, or been signed out by an admin, is refused.
//
// A factory over a file path, with the clock and the random bytes handed in, so it is tested without
// a server (test/setup-codes.test.mjs).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export const CODE_TTL_MS = 48 * 60 * 60_000 // long enough to hand a phone over the next day
/**
 * A device set up this way stays signed in until an admin signs it out (the owner, 2026-10-12: "do not
 * log user out after 90 days"): it never typed a password to fall back on. Ten years stands for that.
 * A browser keeps a cookie 400 days at most, so the server hands the same cookie back while the
 * device is in use (server.mjs, /api/me) and its 400 days start again.
 */
export const DEVICE_SESSION_MS = 10 * 365 * 24 * 60 * 60_000
/** A session with longer than this left is a device's (an ordinary sign-in has 7 days). */
export const DEVICE_SESSION_MARK_MS = 365 * 24 * 60 * 60_000
/** What is left of a session token, in ms (its expiry is its second part); 0 for anything else. */
export const sessionLeftMs = (token, now = Date.now()) => {
  const expiry = Number(String(token ?? '').split('.')[1])
  return Number.isFinite(expiry) ? Math.max(0, expiry - now) : 0
}
const MAX_CODES = 200
const CODE_RE = /^[A-Za-z0-9_-]{32}$/

const hashOf = (code) => createHash('sha256').update(code).digest('hex')

/**
 * @param {string} file where the codes' hashes are kept
 * @param {{ now?: () => number, random?: (n: number) => Buffer }} [o]
 */
export function makeSetupCodes(file, { now = Date.now, random = randomBytes } = {}) {
  const load = () => {
    try {
      const list = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
      return Array.isArray(list) ? list.filter((e) => e && typeof e.hash === 'string' && typeof e.user === 'string' && Number.isFinite(e.expires)) : []
    } catch {
      return [] // a file that cannot be read holds no codes: nobody is let in by it
    }
  }
  const save = (list) => {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 })
    renameSync(tmp, file)
  }
  const live = (list) => list.filter((e) => e.expires > now())
  return {
    /**
     * A new code for `user`, asked for by the admin `by`. The account's earlier unused codes stop
     * working. @returns {{ code: string, expires: number }} the code is given here and nowhere else
     */
    create(user, by) {
      const code = random(24).toString('base64url')
      const expires = now() + CODE_TTL_MS
      const list = live(load()).filter((e) => e.user !== user).slice(-(MAX_CODES - 1))
      list.push({ hash: hashOf(code), user, by, at: now(), expires })
      save(list)
      return { code, expires }
    },
    /**
     * Uses a code up. @returns {{ user: string, by: string, at: number }|null} whose it was; null for
     * one that is unknown, used already or too old (the caller says the same thing for all three).
     */
    redeem(code) {
      if (typeof code !== 'string' || !CODE_RE.test(code)) return null
      const want = Buffer.from(hashOf(code), 'hex')
      const all = load()
      const hit = all.find((e) => e.hash.length === 64 && timingSafeEqual(Buffer.from(e.hash, 'hex'), want))
      if (!hit) return null
      save(live(all).filter((e) => e !== hit)) // used or not, it is gone
      return hit.expires > now() ? { user: hit.user, by: hit.by, at: hit.at } : null
    },
    /** The account's unused codes stop working (it was removed, or signed out). */
    forget(user) {
      const all = load()
      const kept = live(all).filter((e) => e.user !== user)
      if (kept.length !== all.length) save(kept)
    },
    /** An account renamed (AD, ad.mjs): its unused codes follow it. @returns {() => void} undoes it */
    rename(from, to) {
      const move = (a, b) => {
        const all = load()
        if (!all.some((e) => e.user === a)) return false
        save(all.map((e) => (e.user === a ? { ...e, user: b } : e)))
        return true
      }
      return move(from, to) ? () => move(to, from) : () => {}
    },
    /** How many unused codes there are for an account (the page says one is waiting). */
    pending(user) {
      return live(load()).filter((e) => e.user === user).length
    }
  }
}

/** The link a QR code carries: the set-up page, with the code after the # (never sent in a request line or logged). */
export const setupLink = (base, code) => `${String(base).replace(/\/+$/, '')}/setup.html#c=${code}`
