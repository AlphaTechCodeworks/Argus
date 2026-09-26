// The frame around every page: the grouped sidebar on a desktop, an icon rail on a tablet, a bar
// along the bottom on a phone, and the theme switch.
//
// It works on the page as it stands: the page's own content is moved into <div class="app-main">
// and the shell goes beside it, so no page's markup had to be restructured to adopt it. It replaces
// the ten hand-copied header links and admin-tabs.js.
import { PHONE_BAR, currentId, navFor } from './nav-model.js'
import { icon } from './icons.js'
import { nextTheme, readTheme, saveTheme } from './theme.js'

const store = (() => { try { return window.localStorage } catch { return null } })()
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function applyTheme(t) {
  if (t === 'light') document.documentElement.dataset.theme = 'light'
  else delete document.documentElement.dataset.theme
}

function link(item, here, cls = '') {
  const on = item.id === here
  return `<a class="${cls}" href="${item.href}"${on ? ' aria-current="page"' : ''} title="${esc(item.label)}">${icon(item.icon)}<span>${esc(item.label)}</span></a>`
}

// Who is signed in, as last seen: the shell is drawn from this at once, and corrected when /api/me
// answers. Waiting for the server first is what made every page jump sideways as it loaded.
const ME_KEY = 'cctv.me'
const session = (() => { try { return window.sessionStorage } catch { return null } })()
const cachedMe = () => { try { return JSON.parse(session?.getItem(ME_KEY) ?? '{}') ?? {} } catch { return {} } }

const themeButton = (t, cls) => `<button type="button" class="${cls}" data-theme-toggle title="Switch between dark and light">${icon(t === 'light' ? 'moon' : 'sun')}<span>${t === 'light' ? 'Dark theme' : 'Light theme'}</span></button>`

/** Fills the sidebar, phone bar and More sheet for this user. Safe to call again. */
function render(parts, me) {
  const { side, bar, sheet } = parts
  const groups = navFor({ admin: me.admin === true })
  // Storage is a tab of Settings (settings.html#storage), but has its own place in the menu
  const here = location.hash === '#storage' && /settings.html$/.test(location.pathname) ? 'storage' : currentId(location.pathname)
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  const version = me.build?.version ? esc(me.build.version) : ''
  side.innerHTML = `
    <a class="shell-brand" href="/"><img class="shell-logo" src="/logo.svg" alt="" /><span>Argus</span></a>
    <nav class="shell-nav">
      ${groups.map((g) => `<div class="shell-group"><div class="shell-group-label">${esc(g.label)}</div>${g.items.map((i) => link(i, here)).join('')}</div>`).join('')}
    </nav>
    <div class="shell-foot">
      ${themeButton(theme, 'shell-theme btn-ghost')}
      <div class="shell-user"><span class="shell-avatar">${esc((me.user ?? '?').slice(0, 1).toUpperCase())}</span>
        <span class="shell-who">${esc(me.user ?? '')}<small>${me.user ? (me.admin ? 'Administrator' : 'Viewer') : ''}${version ? ` · ${version}` : ''}</small></span>
        <button type="button" class="btn-ghost btn-icon" data-sign-out title="Sign out" aria-label="Sign out">${icon('out')}</button></div>
    </div>`
  // the phone bar: the four used most, then More for everything else
  const all = groups.flatMap((g) => g.items)
  const inBar = all.filter((i) => PHONE_BAR.includes(i.id))
  const rest = all.filter((i) => !PHONE_BAR.includes(i.id))
  bar.innerHTML = inBar.map((i) => link(i, here)).join('') +
    `<button type="button" class="shell-more-btn${rest.some((i) => i.id === here) ? ' on' : ''}" aria-expanded="${!sheet.hidden}">${icon('more')}<span>More</span></button>`
  sheet.innerHTML = rest.map((i) => link(i, here)).join('') + themeButton(theme, 'shell-theme') +
    `<button type="button" data-sign-out>${icon('out')}<span>Sign out</span></button>`
}

export function mountShell() {
  if (document.body.classList.contains('has-shell')) return
  applyTheme(readTheme(store))

  // the page's own content, moved as it is into the main column. This runs before the page's own
  // scripts (shell.js is the first module on every page), so no video has started yet: a playing
  // video that is moved is paused by the browser.
  const main = document.createElement('div')
  main.className = 'app-main'
  for (const n of [...document.body.childNodes]) if (!(n.nodeType === 1 && n.tagName === 'SCRIPT')) main.appendChild(n)

  const side = document.createElement('aside')
  side.className = 'app-shell'
  side.setAttribute('aria-label', 'Main')
  const bar = document.createElement('nav')
  bar.className = 'shell-bar'
  bar.setAttribute('aria-label', 'Main')
  const sheet = document.createElement('div')
  sheet.className = 'shell-sheet'
  sheet.hidden = true
  const parts = { side, bar, sheet }
  let me = cachedMe()
  render(parts, me)

  document.body.prepend(side)
  side.after(main)
  document.body.append(bar, sheet)
  document.body.classList.add('has-shell')
  document.documentElement.classList.remove('shell-pending')

  // one listener for the lot, so a re-render needs no re-binding
  document.body.addEventListener('click', async (e) => {
    const t = e.target.closest?.('.shell-more-btn, [data-theme-toggle], [data-sign-out]')
    if (!t) return
    if (t.matches('.shell-more-btn')) {
      sheet.hidden = !sheet.hidden
      t.setAttribute('aria-expanded', String(!sheet.hidden))
    } else if (t.matches('[data-theme-toggle]')) {
      const next = nextTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
      applyTheme(next)
      saveTheme(store, next)
      for (const x of document.querySelectorAll('[data-theme-toggle]')) x.innerHTML = `${icon(next === 'light' ? 'moon' : 'sun')}<span>${next === 'light' ? 'Dark theme' : 'Light theme'}</span>`
    } else {
      try { session?.removeItem(ME_KEY) } catch {}
      try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }) } catch {}
      location.href = '/login.html'
    }
  })

  addEventListener('hashchange', () => render(parts, me))

  fetch('/api/me', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((fresh) => {
      if (!fresh) return
      try { session?.setItem(ME_KEY, JSON.stringify({ user: fresh.user, admin: fresh.admin, build: fresh.build })) } catch {}
      const changed = fresh.user !== me.user || fresh.admin !== me.admin || fresh.build?.version !== me.build?.version
      me = fresh
      if (changed) render(parts, me)
    })
    .catch(() => {
      // Not knowing who this is keeps the viewer's navigation, which is the harmless way to be wrong.
    })
}

mountShell()
