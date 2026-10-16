// "Stream link (RTSP)" for one camera, admins only: one click gives a ready-to-copy rtsp:// address
// for that camera, to paste into VLC, another VMS or an OCR engine (rtsp.mjs on the server).
//
// Each click makes a new key for that camera alone (standard picture and full quality), and its
// password is in the address shown. The server keeps only a hash of it, so the address cannot be
// shown again later: copy it now; lost, click again for a new one. Every link made this way is
// listed in Settings > Camera links, where it can be revoked. When camera links are off, the same
// place offers to turn them on.
// Used by the Live page's full-size view (viewer.js) and the camera's page under Sites (camera-editor.js).

/** The address a program connects to (the same rule as the server's rtsp-core.mjs rtspUrl). */
export function rtspUrl({ host, port = 8554, user, password = null, path }) {
  const h = /:/.test(host) && !/^\[/.test(host) ? `[${host}]` : host
  const auth = user ? `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ''}@` : ''
  return `rtsp://${auth}${h}:${port}/${path}`
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  Object.assign(node, props)
  node.append(...children.filter((c) => c !== null && c !== undefined))
  return node
}

/** Copies text, with the old way for a page not on https (no clipboard API there). */
export async function copyText(text, input = null) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    if (!input) return false
    input.select()
    try {
      return document.execCommand('copy')
    } catch {
      return false
    }
  }
}

async function post(body) {
  const res = await fetch('/api/admin/rtsp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

/** A read-only address with its Copy button. */
export function urlRow(label, url) {
  const input = el('input', { type: 'text', readOnly: true, value: url, className: 'rl-url', spellcheck: false })
  input.setAttribute('aria-label', label)
  input.addEventListener('focus', () => input.select())
  const copy = el('button', { type: 'button', className: 'st-primary', textContent: 'Copy' })
  copy.addEventListener('click', async () => {
    const ok = await copyText(input.value, input)
    copy.textContent = ok ? 'Copied' : 'Select and copy'
    setTimeout(() => (copy.textContent = 'Copy'), 2000)
  })
  return { row: el('div', { className: 'rl-row' }, el('span', { className: 'rl-label', textContent: label }), input, copy), input }
}

let dlg = null
function dialog() {
  if (dlg) return dlg
  dlg = el('dialog', { className: 'st-dialog rl-dialog' })
  dlg.setAttribute('aria-labelledby', 'rl-title')
  dlg.addEventListener('click', (e) => {
    e.stopPropagation() // (the full-size view behind closes on a click)
    if (e.target === dlg) dlg.close()
  })
  document.body.append(dlg)
  return dlg
}

/** The camera's name as the dialog says it. */
const nameOf = (cam) => cam.name || `Camera ${cam.ch + 1}`

/**
 * Opens the dialog for a camera ({ nvr, ch (from 0), name }) and makes its link at once.
 * @param {{ nvr: string, ch: number, name?: string }} cam
 */
export async function openStreamLink(cam, { turnOn = false } = {}) {
  const d = dialog()
  const body = el('div', { className: 'rl-body' })
  const close = el('button', { type: 'button', textContent: 'Close' })
  close.addEventListener('click', () => d.close())
  d.replaceChildren(el('h2', { id: 'rl-title', textContent: `Stream link: ${nameOf(cam)}` }), body, el('div', { className: 'st-actions' }, close))
  body.append(el('p', { className: 'st-meta', textContent: 'Making the link…' }))
  if (!d.open) d.showModal()
  let r
  try {
    r = await post({ action: 'link', nvr: cam.nvr, ch: cam.ch, turnOn })
  } catch (e) {
    body.replaceChildren(el('p', { className: 'st-error', textContent: `Could not make the link: ${e.message}` }))
    return
  }
  if (!r.ready) {
    body.replaceChildren(el('p', { className: 'st-help', textContent: r.message }))
    if (r.why === 'off') {
      const on = el('button', { type: 'button', className: 'st-primary', textContent: 'Turn on camera links' })
      on.addEventListener('click', () => openStreamLink(cam, { turnOn: true }))
      body.append(el('p', { className: 'st-help', textContent: 'Camera links let programs such as VLC, another recorder or a number-plate reader take this camera\'s picture over RTSP, on this network. Each link has its own password and can be revoked in Settings > Camera links.' }), el('p', {}, on))
    }
    return
  }
  const host = el('select', { className: 'rl-host' })
  for (const h of r.hosts?.length ? r.hosts : [location.hostname]) host.append(el('option', { value: h, textContent: h }))
  const sub = urlRow('Standard picture', '')
  const main = urlRow('Full quality', '')
  // (the server leaves path1080 out when 1080p conversions are switched off there)
  const hd = r.path1080 ? urlRow('1080p H.264 — lighter, for older PCs and OCR tools', '') : null
  const fill = () => {
    sub.input.value = rtspUrl({ host: host.value, port: r.port, user: r.key.user, password: r.password, path: r.path })
    main.input.value = rtspUrl({ host: host.value, port: r.port, user: r.key.user, password: r.password, path: r.mainPath })
    if (hd) hd.input.value = rtspUrl({ host: host.value, port: r.port, user: r.key.user, password: r.password, path: r.path1080 })
  }
  host.addEventListener('change', fill)
  fill()
  body.replaceChildren(
    el('p', { className: 'st-help', textContent: 'Paste this into VLC: Media → Open Network Stream. Any program that plays RTSP takes it the same way.' }),
    sub.row,
    main.row,
    hd?.row ?? null,
    hd ? el('p', { className: 'st-meta', textContent: 'The 1080p link is the full-quality picture made smaller (at most 1920×1080, 20 frames a second) and in H.264, which any PC can play. The server converts it while a program reads it, so only a couple of cameras can have it at once.' }) : null,
    r.p2p ? el('p', { className: 'st-meta', textContent: 'This recorder is reached over the internet (P2P): full quality is limited to a few cameras at once and may be refused. The standard picture always works.' }) : null,
    el('label', { className: 'rl-host-label' }, 'Server address ', host),
    el('p', { className: 'st-meta', textContent: 'The password is in the link and is shown only now: copy it before closing. Lost it? Click Stream link again for a new one.' }),
    el('p', { className: 'st-meta', textContent: `Works on this network (port ${r.port}), not through the internet address.${r.earlier ? ` ${r.earlier} earlier link${r.earlier === 1 ? '' : 's'} for this camera still work${r.earlier === 1 ? 's' : ''}.` : ''} Every link is listed in Settings > Camera links, where it can be revoked.` })
  )
  sub.input.focus()
}

/** The button for a camera's tools: "Stream link". */
export function streamLinkButton(cam, className = 'cam-link') {
  const b = el('button', { type: 'button', className, textContent: 'Stream link' })
  b.title = 'An RTSP address for this camera, to paste into VLC or another program'
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    openStreamLink(cam)
  })
  return b
}
