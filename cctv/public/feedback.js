import { icon } from './icons.js'

export function notify(message, { error = false } = {}) {
  let region = document.getElementById('feedback')
  if (!region) {
    region = document.createElement('div')
    region.id = 'feedback'
    region.className = 'feedback-stack'
    document.body.append(region)
  }
  const host = document.fullscreenElement ?? document.body
  if (!host.contains(region)) host.append(region)
  const item = document.createElement('div')
  item.className = `feedback-item${error ? ' feedback-error' : ''}`
  item.setAttribute('role', error ? 'alert' : 'status')
  const text = document.createElement('span')
  text.textContent = message
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.innerHTML = icon('close')
  dismiss.title = 'Dismiss notification'
  dismiss.setAttribute('aria-label', 'Dismiss notification')
  dismiss.addEventListener('click', () => item.remove())
  item.append(text, dismiss)
  region.append(item)
  while (region.children.length > 3) region.firstElementChild.remove()
  if (!error) setTimeout(() => item.remove(), 5000)
}
