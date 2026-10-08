// The red strip shown at the top of every page while any alert is open, so a problem is seen by
// whoever happens to be looking at a camera — not only by someone who opens the Health page.
//
// The wording comes from renderHealth() so the banner and the Health page can never disagree.
// A failed request is ignored on purpose: if the server is unreachable the page has bigger
// problems to report, and a banner that shouts about its own fetch would be noise.

import { renderHealth } from './health.js'

const POLL_MS = 30_000
const dismissalKey = 'cctv.dismissedHealthBanner'
let dismissed = ''
try { dismissed = sessionStorage.getItem(dismissalKey) ?? '' } catch {}

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
    dismissed = ''
    try { sessionStorage.removeItem(dismissalKey) } catch {}
    return
  }
  // Include the account and the actual problems, so another account or a changed
  // warning never inherits this tab's dismissal. A cleared problem can recur.
  let account = ''
  try { account = JSON.parse(sessionStorage.getItem('cctv.me') ?? '{}').user ?? '' } catch {}
  const signature = JSON.stringify([account, criticalText, (data.open ?? []).map((a) => [a.key, a.kind, a.severity, a.title]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])
  if (dismissed === signature) { bar.hidden = true; return }
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
  const details = document.createElement('details')
  details.className = 'alert-disclosure'
  details.open = Boolean(bar.querySelector('details')?.open)
  const summary = document.createElement('summary')
  summary.textContent = bannerText ? `⚠ ${bannerText.split(':')[0]} · Show details` : 'Show details'
  details.append(summary, text)
  // Critical failures remain visible even when the routine problem list is collapsed.
  const critical = document.createElement('strong')
  critical.textContent = criticalText ? `⛔ ${criticalText}` : ''
  critical.hidden = !criticalText
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = 'Dismiss'
  dismiss.className = 'alert-dismiss'
  dismiss.setAttribute('aria-label', 'Dismiss this warning banner')
  dismiss.title = 'Hide these warnings in this tab. Changed problems will appear again.'
  dismiss.addEventListener('click', () => {
    dismissed = signature
    try { sessionStorage.setItem(dismissalKey, signature) } catch {}
    bar.hidden = true
  })
  bar.replaceChildren(critical, details, link, dismiss)
  bar.classList.toggle('critical', Boolean(criticalText))
  bar.hidden = false
  // inside the page's own column once the shell is there (body is then the two-column frame)
  const host = document.querySelector('.app-main') ?? document.body
  const after = host.querySelector(':scope > .shell-top')
  if (bar.parentElement !== host) (after ? after.after(bar) : host.prepend(bar))
}

poll()
setInterval(poll, POLL_MS)
