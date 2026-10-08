import { searchCameras } from './grid-view.js'
import { preferenceStorage } from './user-settings.js'

const CONTEXT_KEY = 'cctv.workspaceSite'
const FAVORITES_KEY = 'cctv.favoriteSites'
const RECENTS_KEY = 'cctv.recentSites'
const read = (key, fallback) => { try { return JSON.parse(preferenceStorage.getItem(key)) ?? fallback } catch { return fallback } }
const write = (key, value) => { try { preferenceStorage.setItem(key, JSON.stringify(value)) } catch {} }
export const workspaceSite = () => read(CONTEXT_KEY, null)
export function rememberSite(site) {
  write(CONTEXT_KEY, site || '')
  if (site) write(RECENTS_KEY, [site, ...read(RECENTS_KEY, []).filter((s) => s !== site)].slice(0, 8))
}

export function browserResults(cameras, { mode = 'sites', site = '', query = '', favorites = [], recents = [] } = {}) {
  if (mode === 'cameras') return searchCameras(cameras.filter((c) => !site || c.site === site), query)
  const counts = new Map()
  for (const c of cameras) if (c.site) counts.set(c.site, (counts.get(c.site) || 0) + 1)
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return [...counts].map(([name, count]) => ({ name, count })).filter((s) => words.every((w) => s.name.toLowerCase().includes(w)))
    .sort((a, b) => Number(favorites.includes(b.name)) - Number(favorites.includes(a.name)) ||
      (recents.includes(a.name) ? recents.indexOf(a.name) : 99) - (recents.includes(b.name) ? recents.indexOf(b.name) : 99) || a.name.localeCompare(b.name))
}

// Shared native dialog: bounded rows, native keyboard controls and automatic modal focus trapping.
export function mountCameraBrowser({ host, cameras, selectedSite, onSite, onCamera }) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'camera-browser-launch'
  button.setAttribute('aria-haspopup', 'dialog')
  host.prepend(button)
  const dialog = document.createElement('dialog')
  dialog.className = 'camera-browser'
  dialog.setAttribute('aria-label', 'Sites and cameras')
  dialog.innerHTML = `<form method="dialog" class="camera-browser-head"><h2>Sites and cameras</h2><button aria-label="Close sites and cameras">Close</button></form>
    <div class="camera-browser-tabs" role="group" aria-label="Browse"><button type="button" data-mode="sites" aria-pressed="true">Sites</button><button type="button" data-mode="cameras" aria-pressed="false">Cameras</button></div>
    <label class="camera-browser-search">Search<input type="search" placeholder="Find a site" autocomplete="off" /></label>
    <div class="camera-browser-scope"></div><p class="camera-browser-count" role="status"></p><ul class="camera-browser-results"></ul>
    <div class="camera-browser-pages"><button type="button" data-page="-1">Previous</button><button type="button" data-page="1">Next</button></div>`
  document.body.append(dialog)
  const search = dialog.querySelector('input')
  const list = dialog.querySelector('ul')
  const count = dialog.querySelector('.camera-browser-count')
  const scope = dialog.querySelector('.camera-browser-scope')
  let mode = 'sites', page = 0, timer
  const makeButton = (label, action) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label
    b.addEventListener('click', action); return b
  }
  const chooseSite = (name) => { dialog.close(); rememberSite(name); onSite(name); refresh() }
  function render() {
    const favorites = read(FAVORITES_KEY, [])
    const recents = read(RECENTS_KEY, [])
    const site = selectedSite() || ''
    const results = browserResults(cameras(), { mode, site, query: search.value, favorites, recents })
    page = Math.min(page, Math.max(0, Math.ceil(results.length / 50) - 1))
    scope.replaceChildren()
    if (mode === 'sites') scope.append(makeButton('All sites', () => chooseSite('')))
    else {
      scope.textContent = site ? `Cameras in ${site}` : 'Cameras across all sites'
      if (site) scope.append(makeButton('Browse all sites', () => { mode = 'sites'; page = 0; search.value = ''; updateMode(); render() }))
    }
    count.textContent = results.length ? `${page * 50 + 1}–${Math.min(results.length, (page + 1) * 50)} of ${results.length} ${mode}` : 'No matches. Try another name or choose another site.'
    list.replaceChildren()
    for (const item of results.slice(page * 50, (page + 1) * 50)) {
      const li = document.createElement('li')
      if (mode === 'sites') {
        const favorite = favorites.includes(item.name)
        const select = makeButton(item.name, () => chooseSite(item.name))
        select.className = 'camera-browser-choice'
        const meta = document.createElement('small')
        meta.textContent = `${item.count} cameras${favorite ? ' · Favorite' : recents.includes(item.name) ? ' · Recent' : ''}`
        select.append(meta)
        const star = makeButton(favorite ? '★' : '☆', () => {
          write(FAVORITES_KEY, favorite ? favorites.filter((s) => s !== item.name) : [...favorites, item.name]); render()
          const stars = [...list.querySelectorAll('.camera-browser-favorite')]
          stars.find((s) => s.dataset.site === item.name)?.focus()
        })
        star.className = 'camera-browser-favorite'; star.dataset.site = item.name
        star.setAttribute('aria-label', `Favorite ${item.name}`); star.setAttribute('aria-pressed', String(favorite))
        li.append(select, star)
      } else {
        const select = makeButton(item.name || `Camera ${item.ch + 1}`, () => { dialog.close(); rememberSite(item.site); onCamera(item); refresh() })
        select.className = 'camera-browser-choice'
        const meta = document.createElement('small')
        meta.textContent = `${item.site} · ${item.nvrName} · Channel ${item.ch + 1} · ${item.online ? 'Online' : 'Offline'}`
        select.append(meta); li.append(select)
      }
      list.append(li)
    }
    for (const b of dialog.querySelectorAll('[data-page]')) b.disabled = Number(b.dataset.page) < 0 ? page === 0 : (page + 1) * 50 >= results.length
  }
  function updateMode() {
    for (const b of dialog.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode))
    search.placeholder = mode === 'sites' ? 'Find a site' : 'Camera, recorder or channel'
  }
  function refresh() { button.textContent = `Browse · ${selectedSite() || 'All sites'}`; if (dialog.open) render() }
  button.addEventListener('click', () => { page = 0; search.value = ''; render(); dialog.showModal(); search.focus() })
  dialog.addEventListener('close', () => button.focus())
  for (const b of dialog.querySelectorAll('[data-mode]')) b.addEventListener('click', () => { mode = b.dataset.mode; page = 0; search.value = ''; updateMode(); render(); search.focus() })
  for (const b of dialog.querySelectorAll('[data-page]')) b.addEventListener('click', () => { page += Number(b.dataset.page); render(); list.scrollTop = 0 })
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { page = 0; render() }, 150) })
  refresh()
  return { refresh }
}
