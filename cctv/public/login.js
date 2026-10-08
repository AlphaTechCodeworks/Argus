const form = document.getElementById('login')
const error = document.getElementById('error')

// Whoever signs in next starts with nothing the last user of this browser left behind: the live grid's
// last pictures (stills.js, cache "argus-stills") are kept per camera, not per user, and would show a
// camera this person may not open until its live picture replaced it
try {
  globalThis.caches?.delete('argus-stills').catch(() => {})
} catch {}

// Show / Hide beside the password: a mistyped password is the usual reason a sign-in fails, and on
// a phone there is no other way to see it. Shown only while the button says so, and hidden again
// before the form is sent, so the browser's password manager is offered a password field.
const showPass = document.getElementById('show-pass')
const setShown = (on) => {
  form.password.type = on ? 'text' : 'password'
  showPass.textContent = on ? 'Hide' : 'Show'
  showPass.title = on ? 'Hide the password' : 'Show the password'
  showPass.setAttribute('aria-pressed', String(on))
}
showPass.addEventListener('click', () => {
  setShown(form.password.type === 'password')
  form.password.focus()
})

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  error.hidden = true
  setShown(false)
  const button = form.querySelector('button[type="submit"]')
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
      // Signed out when a phone alert's link was tapped: the server sent the browser here from
      // /alarms.html#event=<id>, and the browser kept the # across that redirect (the Fetch
      // standard carries a fragment over when the new address has none). Go on to that alarm
      // rather than to the grid.
      location.href = /^#event=\d{1,15}$/.test(location.hash) ? `/alarms.html${location.hash}` : '/'
      return
    }
    const body = await res.json().catch(() => ({}))
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
