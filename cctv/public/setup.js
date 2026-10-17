// The set-up page (setup.html): a scanned set-up code is handed to the server, which signs this
// browser in as the account it was made for (setup-codes.mjs, POST /api/setup/redeem). Nothing is
// sent until a button is pressed: the code works once, and an Android phone may want it for the app.
const code = new URLSearchParams(location.hash.replace(/^#/, '')).get('c') ?? ''
const say = document.getElementById('setupSay')
const here = document.getElementById('setupHere')
const error = document.getElementById('error')
const signIn = document.getElementById('setupSignIn')

const fail = (text) => {
  error.textContent = text
  error.hidden = false
  here.hidden = true
  document.getElementById('setupNote').hidden = true
  signIn.hidden = false
}

if (!/^[A-Za-z0-9_-]{32}$/.test(code)) {
  say.textContent = 'This page sets a device up from a set-up code.'
  fail('There is no set-up code in this address. Scan the QR code again, or ask for a new one.')
} else {
  // the code leaves the address bar and the history at once: a screenshot or a shared link has none
  history.replaceState(null, '', location.pathname)
  // the Argus app reads the same QR code with its own Scan button (connect/SetupCode.kt): say so, since
  // the code works once and pressing the button here would use it up for the browser
  if (/Android/i.test(navigator.userAgent)) document.getElementById('setupNote').hidden = false
  here.addEventListener('click', async () => {
    here.disabled = true
    here.textContent = 'Setting up…'
    try {
      const res = await fetch('/api/setup/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) return fail(j.error || 'The set-up code was not accepted. Ask for a new one.')
      say.textContent = `Signed in as ${j.user}.`
      try { document.getElementById('authenticated')?.beginElement(); await new Promise((r) => setTimeout(r, 320)) } catch {}
      location.replace('/')
    } catch {
      here.disabled = false
      here.textContent = 'Use Argus in this browser'
      error.textContent = 'The server did not answer. Check the connection and try again.'
      error.hidden = false
    }
  })
}
