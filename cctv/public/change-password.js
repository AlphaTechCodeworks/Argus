const form = document.getElementById('changePassword')
const current = document.getElementById('currentPassword')
const next = document.getElementById('newPassword')
const confirm = document.getElementById('confirmPassword')
const error = document.getElementById('passwordError')
const save = form.querySelector('button[type="submit"]')
for (const input of [next, confirm]) input.addEventListener('input', () => confirm.setCustomValidity(''))
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  confirm.setCustomValidity(next.value === confirm.value ? '' : 'Passwords do not match')
  if (!form.reportValidity()) return
  save.disabled = true
  error.hidden = true
  try {
    const response = await fetch('/api/me/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: current.value, newPassword: next.value }) })
    if (response.status === 401) { location.href = '/login.html'; return }
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? 'Could not change your password.')
    form.reset()
    location.href = '/'
  } catch (failure) { error.textContent = failure.message; error.hidden = false }
  finally { save.disabled = false }
})
document.getElementById('passwordSignOut').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); location.href = '/login.html' }
  catch { error.textContent = 'Could not reach the server. Try again.'; error.hidden = false }
})
