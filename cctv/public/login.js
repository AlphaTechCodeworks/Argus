const form = document.getElementById('login')
const error = document.getElementById('error')

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  error.hidden = true
  const button = form.querySelector('button')
  button.disabled = true
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
  }
})
