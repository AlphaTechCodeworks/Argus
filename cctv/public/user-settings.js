// Account preferences are authoritative on the server. Local copies are namespaced by user.
let user = null
let values = {}
let pending = {}
let sending = {}
let timer, saving = false
let accountChanged = false
const cacheKey = () => `cctv.ui:${user}`
const pendingKey = () => `cctv.uiPending:${user}`
function cache() {
  if (user) try {
    localStorage.setItem(cacheKey(), JSON.stringify(values))
    localStorage.setItem(pendingKey(), JSON.stringify({ ...sending, ...pending }))
  } catch {}
}
function report(state) { document.dispatchEvent(new CustomEvent('preferences-save', { detail: state })) }
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
  try { pending = JSON.parse(localStorage.getItem(pendingKey()) || '{}') } catch {}
  values = { ...values, ...pending }
  cache()
}

async function flush() {
  if (saving || !Object.keys(pending).length) return
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
if (Object.keys(pending).length) timer = setTimeout(flush, 300)
