// A Show / Hide button inside every password box on the page. A mistyped password is the usual
// reason a sign-in or an NVR test fails, and on a phone there is no other way to see what was typed.
// The box goes back to hidden when its form is sent, so the browser's password manager is offered
// a password field, and what was typed does not stay readable on a screen left open.
function enhance(input) {
  if (input.dataset.showPass) return
  input.dataset.showPass = '1'
  const wrap = document.createElement('span')
  wrap.className = 'pass-wrap'
  input.replaceWith(wrap)
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'pass-show'
  if (input.id) button.setAttribute('aria-controls', input.id)
  const setShown = (on) => {
    input.type = on ? 'text' : 'password'
    button.textContent = on ? 'Hide' : 'Show'
    button.title = on ? 'Hide the password' : 'Show the password'
    button.setAttribute('aria-pressed', String(on))
  }
  setShown(false)
  button.addEventListener('click', (e) => {
    e.preventDefault() // inside a <label>: the click is ours alone
    setShown(input.type === 'password')
    input.focus()
  })
  wrap.append(input, button)
  input.form?.addEventListener('submit', () => setShown(false), true)
}

for (const input of document.querySelectorAll('input[type="password"]')) enhance(input)
