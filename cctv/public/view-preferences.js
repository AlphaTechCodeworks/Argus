// Browser-only display preferences, separate from server camera permissions and ordering.
export function createViewStore(storage, key) {
  let data = { favorites: [], views: [] }
  try {
    const raw = JSON.parse(storage?.getItem(key) ?? '{}')
    data.favorites = [...new Set((Array.isArray(raw.favorites) ? raw.favorites : []).filter((x) => typeof x === 'string'))].slice(0, 1000)
    data.views = (Array.isArray(raw.views) ? raw.views : []).filter((v) => v && typeof v.id === 'string' && typeof v.name === 'string' && typeof v.layout === 'string').slice(0, 20)
  } catch {}
  const persist = () => {
    try { storage.setItem(key, JSON.stringify(data)); return true } catch { return false }
  }
  return {
    has: (camera) => data.favorites.includes(camera),
    filter: (cameras, only) => only ? cameras.filter((c) => data.favorites.includes(`${c.nvr}/${c.ch}`)) : cameras,
    toggle(camera) {
      const before = data.favorites
      data.favorites = before.includes(camera) ? before.filter((x) => x !== camera) : [...before, camera]
      if (!persist()) { data.favorites = before; return false }
      return true
    },
    views: () => data.views.map((v) => ({ ...v })),
    save(view) {
      if (!view.name.trim() || data.views.length >= 20) return false
      const before = data.views
      data.views = [...before, { ...view, name: view.name.trim().slice(0, 48) }]
      if (!persist()) { data.views = before; return false }
      return true
    },
    remove(id) {
      const before = data.views
      data.views = before.filter((v) => v.id !== id)
      if (!persist()) { data.views = before; return false }
      return true
    }
  }
}

export function streamState(text, live = false) {
  if (live) return 'live'
  if (/stalled|slow/i.test(text)) return 'retrying'
  if (/reconnect|retry/i.test(text)) return 'retrying'
  if (/offline/i.test(text)) return 'offline'
  if (/no video|unavailable|unsupported|H\.265|error/i.test(text)) return 'unavailable'
  if (/connect|wait|starting|busy/i.test(text)) return 'connecting'
  return 'idle'
}

export function lastSeenText(at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return 'Not seen in this session'
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 5) return 'Last seen just now'
  if (seconds < 60) return `Last seen ${seconds}s ago`
  if (seconds < 3600) return `Last seen ${Math.floor(seconds / 60)}m ago`
  return `Last seen ${Math.floor(seconds / 3600)}h ago`
}

const seen = new Map()
export const cameraSeen = (key) => seen.get(key) ?? null
export const rememberCameraSeen = (key, at) => seen.set(key, at)
