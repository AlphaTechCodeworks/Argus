// The sign-in page's Windows single sign-on (the server side is sso.mjs): on a Windows PC in the
// office, with it set up, the page first tries to sign in with the PC's own Windows sign-in, silently.
// When that does not work, the normal form is there, with a "Sign in with Windows" button to try
// again; and this browser does not try by itself again for a day.

export const FAILED_KEY = 'argus-sso-failed'
export const RETRY_AFTER_MS = 24 * 3_600_000
export const TIMEOUT_MS = 10_000

/** Only Windows browsers can have a domain Kerberos ticket: elsewhere the button is not even shown. */
export const isWindows = (ua) => /\bWindows NT\b/.test(String(ua ?? ''))

/** When it last failed in this browser (ms), or 0. Storage may be missing or refuse: then 0. */
export function failedAt(storage) {
  try {
    const n = Number(storage?.getItem(FAILED_KEY))
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}
export function markFailed(storage, now = Date.now()) {
  try {
    storage?.setItem(FAILED_KEY, String(now))
  } catch {}
}
export function clearFailed(storage) {
  try {
    storage?.removeItem(FAILED_KEY)
  } catch {}
}

/** Try silently now? Only when offered here, on Windows, and not failed in the last day. */
export const shouldTry = ({ available, ua, failed = 0, now = Date.now() }) => available === true && isWindows(ua) && !(failed && now - failed < RETRY_AFTER_MS)

/** Is it offered for this page (set up, and reached in the office, not through Cloudflare)? */
export async function ssoAvailable(fetchFn = fetch) {
  try {
    const r = await fetchFn('/api/sso/available', { cache: 'no-store' })
    return r.ok && (await r.json()).available === true
  } catch {
    return false
  }
}

/**
 * One attempt. The browser answers the server's "Negotiate" by itself, with the PC's Kerberos ticket.
 * @returns {Promise<{ ok: true, user: string } | { ok: false, message: string }>}
 */
export async function trySso({ fetchFn = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null
  try {
    const r = await fetchFn('/api/sso', { credentials: 'include', cache: 'no-store', headers: { 'x-argus-sso': '1' }, signal: ctl?.signal })
    const body = await r.json().catch(() => ({}))
    if (r.ok && typeof body.user === 'string') return { ok: true, user: body.user }
    return { ok: false, message: typeof body.error === 'string' ? body.error : '' }
  } catch {
    return { ok: false, message: '' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
