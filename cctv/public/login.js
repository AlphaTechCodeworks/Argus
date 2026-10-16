const form = document.getElementById('login')
const error = document.getElementById('error')

// Whoever signs in next starts with nothing the last user of this browser left behind: the live grid's
// last pictures (stills.js, cache "argus-stills") are kept per camera, not per user, and would show a
// camera this person may not open until its live picture replaced it
try {
  globalThis.caches?.delete('argus-stills').catch(() => {})
} catch {}

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  error.hidden = true
  const button = form.querySelector('button[type="submit"]') // not the password's Show button (show-password.js)
  const label = button.textContent
  button.disabled = true
  button.textContent = 'Signing in…'
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: form.user.value.trim(), password: form.password.value })
    })
    if (res.ok) {
      const signedIn = await res.json()
      // the mark's ring pulses once to say so (the wordmark's #authenticated), then the app opens
      try { document.getElementById('authenticated')?.beginElement(); await new Promise((r) => setTimeout(r, 320)) } catch {}
      if (signedIn.mustChangePassword) { location.href = '/change-password.html'; return }
      // Signed out when a phone alert's link was tapped: the server sent the browser here from
      // /alarms.html#event=<id>, and the browser kept the # across that redirect (the Fetch
      // standard carries a fragment over when the new address has none). Go on to that alarm
      // rather than to the grid.
      // A Live link to a view (?view=…, a TV's &screen=1) goes back to it: the server and the Live page
      // send ?next=/?<query> here. Only the Live page with a plain query (view-links.js safeNext, the
      // same pattern), so this page can never be made to send anyone to another site.
      const next = new URLSearchParams(location.search).get('next') ?? ''
      const back = /^\/(index\.html)?\?[A-Za-z0-9=&,|%._~-]{0,512}$/.test(next) ? next : '/'
      location.href = /^#event=\d{1,15}$/.test(location.hash) ? `/alarms.html${location.hash}` : back
      return
    }
    const body = await res.json().catch(() => ({}))
    // AD says this Windows password must be changed first: offer that here
    if (body.canChangePassword) { showWindowsChange(form.user.value.trim()); return }
    error.textContent = body.error ?? 'Sign in failed'
    error.hidden = false
    form.password.select()
  } catch {
    error.textContent = 'Cannot reach the server'
    error.hidden = false
  } finally {
    button.disabled = false
    button.textContent = label
  }
})

// ---- a Windows (AD) password that must be changed before signing in (ad.mjs changeExpired) ----
const win = document.getElementById('winPassword')
const winError = document.getElementById('winError')
function showWindowsChange(user) {
  form.hidden = true
  win.hidden = false
  win.dataset.user = user
  document.getElementById('winUser').textContent = user
  winError.hidden = true
  document.getElementById('winCurrent').focus()
}
document.getElementById('winCancel')?.addEventListener('click', () => { win.reset(); win.hidden = true; form.hidden = false; form.password.value = '' })
win?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const next = document.getElementById('winNew')
  const again = document.getElementById('winConfirm')
  again.setCustomValidity(next.value === again.value ? '' : 'The new passwords are not the same')
  if (!win.reportValidity()) return
  const button = win.querySelector('button[type="submit"]')
  button.disabled = true
  winError.hidden = true
  try {
    const res = await fetch('/api/login/windows-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: win.dataset.user, currentPassword: document.getElementById('winCurrent').value, newPassword: next.value }) })
    const body = await res.json().catch(() => ({}))
    if (res.ok) {
      win.reset()
      alert(body.message ?? 'Your Windows password has been changed. Use the new one on your PC too.')
      location.href = '/'
      return
    }
    winError.textContent = body.error ?? 'The password was not changed.'
    winError.hidden = false
  } catch {
    winError.textContent = 'Cannot reach the server'
    winError.hidden = false
  } finally {
    button.disabled = false
  }
})
document.getElementById('winConfirm')?.addEventListener('input', (e) => e.target.setCustomValidity(''))
