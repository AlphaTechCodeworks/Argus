// The red strip shown at the top of every page while any alert is open, so a problem is seen by
// whoever happens to be looking at a camera — not only by someone who opens the Health page.
//
// The wording comes from renderHealth() so the banner and the Health page can never disagree.
// A failed request is ignored on purpose: if the server is unreachable the page has bigger
// problems to report, and a banner that shouts about its own fetch would be noise.

import { renderHealth } from './health.js'

const POLL_MS = 30_000

const bar = document.createElement('div')
bar.className = 'alert-banner'
bar.hidden = true

async function poll() {
  let data
  try {
    const res = await fetch('/api/health')
    if (!res.ok) return
    data = await res.json()
  } catch {
    return
  }
  const { bannerText, criticalText } = renderHealth(data)
  if (!bannerText && !criticalText) {
    bar.hidden = true
    return
  }
  const link = document.createElement('a')
  link.href = '/health.html'
  link.textContent = 'Open Health'
  const lines = []
  if (criticalText) {
    const c = document.createElement('strong')
    c.className = 'alert-critical'
    c.textContent = `⛔ ${criticalText}`
    lines.push(c)
  }
  if (bannerText) {
    const o = document.createElement('span')
    o.textContent = `⚠ ${bannerText}`
    lines.push(o)
  }
  const text = document.createElement('div')
  text.className = 'alert-lines'
  text.append(...lines)
  bar.replaceChildren(text, link)
  bar.classList.toggle('critical', Boolean(criticalText))
  // phones: one line until tapped (css clamps it)
  if (!bar.dataset.tap) {
    bar.dataset.tap = '1'
    bar.addEventListener('click', (e) => { if (e.target.tagName !== 'A') bar.classList.toggle('open') })
  }
  bar.hidden = false
  // inside the page's own column once the shell is there (body is then the two-column frame)
  const host = document.querySelector('.app-main') ?? document.body
  const after = host.querySelector(':scope > .shell-top')
  if (bar.parentElement !== host) (after ? after.after(bar) : host.prepend(bar))
}

poll()
setInterval(poll, POLL_MS)
