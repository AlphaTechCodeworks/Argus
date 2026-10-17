// Open problems (the Health page's list: cameras offline, a recorder refusing streams, the server's
// own alerts) shown as the bell in the sidebar and the phone bar turning red, on every page (shell.js
// loads this). It used to be a red strip across the top of the page; the owner asked for the bell
// instead (2026-10-15: "just make the bell red on the side bar", "don't have it at the top").
// Hovering the bell lists the problems; the Health page has them in full.
//
// The wording comes from renderHealth() so the bell and the Health page can never disagree.
// A failed request is ignored on purpose: if the server is unreachable the page has bigger problems
// to report, and a bell that turned red about its own fetch would be noise.

import { renderHealth } from './health.js'

const POLL_MS = 30_000
let said = '' // what the bell says, kept to put back after the shell is drawn again

/** The bell's links (sidebar, phone bar, More sheet), as the shell has drawn them now. */
const bells = () => document.querySelectorAll('a[href="/alarms.html"]')

/** Turns every bell red (with the problems as its tooltip) or back to normal. */
function paint() {
  const on = said !== ''
  document.body.classList.toggle('has-problems', on)
  for (const a of bells()) {
    if (on) a.title = `${said}. Open Health for the details.`
    else if (a.title !== 'Alarms') a.title = 'Alarms'
  }
}

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
  said = [criticalText, bannerText].filter(Boolean).join(' · ')
  paint()
}

// (the red comes from body.has-problems, so it survives the shell drawing its links again; the
// tooltip goes back on at the next poll)
poll()
setInterval(poll, POLL_MS)
