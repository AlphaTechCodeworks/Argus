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
      location.href = '/'
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
