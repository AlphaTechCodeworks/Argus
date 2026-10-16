const form = document.getElementById('changePassword')
const current = document.getElementById('currentPassword')
const next = document.getElementById('newPassword')
const confirm = document.getElementById('confirmPassword')
const error = document.getElementById('passwordError')
const save = form.querySelector('button[type="submit"]')
// A Windows (Active Directory) account changes its Windows password here, in AD (ad.mjs)
fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((me) => {
  if (!me?.windows) return
  document.title = 'Argus · Change your Windows password'
  document.getElementById('passwordTitle').textContent = 'Change your Windows password'
  document.getElementById('passwordIntro').textContent = 'This changes the password of your Windows account, so it changes on your PC too. The domain’s password rules apply.'
  document.getElementById('currentLabel').textContent = 'Current Windows password'
  document.getElementById('passwordSignOut').textContent = 'Back'
  document.getElementById('passwordSignOut').dataset.back = '1'
}).catch(() => {})
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
    if (result.message) alert(result.message) // a Windows password: "…Use the new one on your PC too."
    location.href = '/'
  } catch (failure) { error.textContent = failure.message; error.hidden = false }
  finally { save.disabled = false }
})
document.getElementById('passwordSignOut').addEventListener('click', async (event) => {
  if (event.currentTarget.dataset.back) { history.length > 1 ? history.back() : (location.href = '/'); return }
  try { await fetch('/api/logout', { method: 'POST' }); location.href = '/login.html' }
  catch { error.textContent = 'Could not reach the server. Try again.'; error.hidden = false }
})
