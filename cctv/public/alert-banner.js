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
  const { bannerText } = renderHealth(data)
  if (!bannerText) {
    bar.hidden = true
    return
  }
  const link = document.createElement('a')
  link.href = '/health.html'
  link.textContent = 'Open Health'
  bar.replaceChildren(document.createTextNode(`⚠ ${bannerText} `), link)
  bar.hidden = false
  if (!bar.isConnected) document.body.prepend(bar)
}

poll()
setInterval(poll, POLL_MS)
