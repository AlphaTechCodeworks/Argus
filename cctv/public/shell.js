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

export async function mountShell() {
  if (document.body.classList.contains('has-shell')) return
  let me = {}
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' })
    if (r.ok) me = await r.json()
  } catch {
    // Not knowing who this is shows the viewer's navigation, which is the harmless way to be wrong.
  }
  const groups = navFor({ admin: me.admin === true })
  const here = currentId(location.pathname)
  const theme = readTheme(store)
  applyTheme(theme)

  // the page's own content, moved as it is into the main column
  const main = document.createElement('div')
  main.className = 'app-main'
  for (const n of [...document.body.childNodes]) if (!(n.nodeType === 1 && n.tagName === 'SCRIPT')) main.appendChild(n)

  const side = document.createElement('aside')
  side.className = 'app-shell'
  side.setAttribute('aria-label', 'Main')
  const version = me.build?.version ? esc(me.build.version) : ''
  side.innerHTML = `
    <a class="shell-brand" href="/"><span class="shell-logo">${icon('live')}</span><span>CCTV</span></a>
    <nav class="shell-nav">
      ${groups.map((g) => `<div class="shell-group"><div class="shell-group-label">${esc(g.label)}</div>${g.items.map((i) => link(i, here)).join('')}</div>`).join('')}
    </nav>
    <div class="shell-foot">
      <button type="button" class="shell-theme btn-ghost" data-theme-toggle title="Switch between dark and light">${icon(theme === 'light' ? 'moon' : 'sun')}<span>${theme === 'light' ? 'Dark theme' : 'Light theme'}</span></button>
      <div class="shell-user"><span class="shell-avatar">${esc((me.user ?? '?').slice(0, 1).toUpperCase())}</span>
        <span class="shell-who">${esc(me.user ?? '')}<small>${me.admin ? 'Administrator' : 'Viewer'}${version ? ` · ${version}` : ''}</small></span>
        <button type="button" class="btn-ghost btn-icon" data-sign-out title="Sign out" aria-label="Sign out">${icon('out')}</button></div>
    </div>`

  // the phone bar: the four used most, then More for everything else
  const all = groups.flatMap((g) => g.items)
  const bar = document.createElement('nav')
  bar.className = 'shell-bar'
  bar.setAttribute('aria-label', 'Main')
  const inBar = all.filter((i) => PHONE_BAR.includes(i.id))
  const rest = all.filter((i) => !PHONE_BAR.includes(i.id))
  bar.innerHTML = inBar.map((i) => link(i, here)).join('') +
    `<button type="button" class="shell-more-btn${rest.some((i) => i.id === here) ? ' on' : ''}" aria-expanded="false">${icon('more')}<span>More</span></button>`
  const sheet = document.createElement('div')
  sheet.className = 'shell-sheet'
  sheet.hidden = true
  sheet.innerHTML = rest.map((i) => link(i, here)).join('') +
    `<button type="button" class="shell-theme" data-theme-toggle>${icon(theme === 'light' ? 'moon' : 'sun')}<span>${theme === 'light' ? 'Dark theme' : 'Light theme'}</span></button>` +
    `<button type="button" data-sign-out>${icon('out')}<span>Sign out</span></button>`

  document.body.prepend(side)
  side.after(main)
  document.body.append(bar, sheet)
  document.body.classList.add('has-shell')

  const moreBtn = bar.querySelector('.shell-more-btn')
  moreBtn.addEventListener('click', () => {
    sheet.hidden = !sheet.hidden
    moreBtn.setAttribute('aria-expanded', String(!sheet.hidden))
  })
  for (const b of document.querySelectorAll('[data-theme-toggle]')) {
    b.addEventListener('click', () => {
      const t = nextTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
      applyTheme(t)
      saveTheme(store, t)
      for (const x of document.querySelectorAll('[data-theme-toggle]')) {
        x.innerHTML = `${icon(t === 'light' ? 'moon' : 'sun')}<span>${t === 'light' ? 'Dark theme' : 'Light theme'}</span>`
      }
    })
  }
  for (const b of document.querySelectorAll('[data-sign-out]')) {
    b.addEventListener('click', async () => {
      try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }) } catch {}
      location.href = '/login.html'
    })
  }
}

mountShell()
