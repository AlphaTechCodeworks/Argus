// Account preferences are authoritative on the server. Local copies are namespaced by user.
//
// Nothing in this file waits at the top level. Every page's scripts share it, and Safari before 27
// (Chrome on an iPhone too: the same engine; WebKit bug 242740) lets a second script that imports a
// module run while that module is still stopped at a top-level await, its exports not yet set. The
// Live page reads a preference in its first lines: there it stops with a ReferenceError and stays on
// "Loading your cameras…", which is the likely cause of exactly that on an iPhone (2026-10-08; not
// confirmed on the phone itself). The values are asked for at import instead, and preferencesReady
// says when they are known. A page's own script waits for that before it reads one; a file that
// other files import must never wait at its top level.
let user = null
let values = {}
let pending = {}
let sending = {}
let timer, saving = false
let accountChanged = false
let loaded = false
const cacheKey = () => `cctv.ui:${user}`
const pendingKey = () => `cctv.uiPending:${user}`
function cache() {
  if (user) try {
    localStorage.setItem(cacheKey(), JSON.stringify(values))
    localStorage.setItem(pendingKey(), JSON.stringify({ ...sending, ...pending }))
  } catch {}
}
function report(state) { document.dispatchEvent(new CustomEvent('preferences-save', { detail: state })) }
async function load() {
  try {
    const response = await fetch('/api/me/preferences', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('Preferences unavailable')
    const data = await response.json()
    if (typeof data.user === 'string' && data.preferences && typeof data.preferences === 'object') {
      user = data.user; values = data.preferences
    }
  } catch {
    // Only reuse a cache after checking the current session, never the last browser user's values.
    try {
      const response = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) })
      if (response.ok) {
        const me = await response.json()
        if (typeof me.user === 'string') { user = me.user; values = JSON.parse(localStorage.getItem(cacheKey()) || '{}') }
      }
    } catch {}
  }
  if (user) {
    // (a choice made while this was loading is newer than one kept from an earlier page)
    try { pending = { ...JSON.parse(localStorage.getItem(pendingKey()) || '{}'), ...pending } } catch {}
    values = { ...values, ...pending }
    cache()
  }
}

async function flush() {
  if (saving || !Object.keys(pending).length) return
  if (!loaded) return // not before the account is known: whatever is waiting is sent when it is
  if (accountChanged) { report('accountchanged'); return }
  if (!user) { report('failed'); return }
  saving = true
  const patch = pending; sending = patch; pending = {}; cache()
  try {
    const response = await fetch('/api/me/preferences', { method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: user, preferences: patch }), keepalive: true })
    if (response.status === 409) { pending = { ...patch, ...pending }; accountChanged = true; report('accountchanged'); return }
    if (!response.ok) throw new Error('Save failed')
    report('saved')
  } catch {
    pending = { ...patch, ...pending }
    report('failed')
  } finally { saving = false; sending = {}; cache() }
  if (Object.keys(pending).length) timer = setTimeout(flush, 5000)
}
export const savePendingSettings = flush
export const preferenceStorage = {
  getItem(key) { return values[key] ?? null },
  setItem(key, value) {
    values[key] = String(value); pending[key] = String(value); cache(); report('saving')
    clearTimeout(timer); timer = setTimeout(flush, 300)
  }
}
if (typeof window !== 'undefined') addEventListener('pagehide', () => { clearTimeout(timer); flush() })
/**
 * Settles once the values are known: the account's own, or after a failed or unanswered request (5 s
 * each) this browser's copy of them for whoever is signed in, or none. It never rejects. Until then
 * getItem answers null, as for a preference never set.
 */
export const preferencesReady = load().catch(() => {}).then(() => {
  loaded = true
  clearTimeout(timer)
  if (Object.keys(pending).length) timer = setTimeout(flush, 300)
})
