// Settings > Camera links (RTSP), admins only: switch the service on or off, make a key for a program
// (its password shown once, in ready-to-copy addresses), see each key's last use, revoke one.
// The server (rtsp.mjs) checks everything again; it keeps only a hash of each password.
import { rtspUrl, urlRow } from './rtsp-link.js'

const $ = (id) => document.getElementById(id)
const status = $('rl-status')

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  Object.assign(node, props)
  node.append(...children.filter((c) => c !== null && c !== undefined))
  return node
}

async function api(method, body) {
  const res = await fetch('/api/admin/rtsp', { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

let view = null
const when = (ms) => (ms ? new Date(ms).toLocaleString() : 'never')
const camName = (c) => `${c.site ? `${c.site} · ` : ''}${c.nvrName || c.nvr} · ${c.ch + 1} ${c.name || ''}`.trim()

/** Says how the service stands, and offers the switch. */
function renderStatus() {
  const s = view.status
  const toggle = $('rl-toggle')
  toggle.hidden = false
  if (view.envOff) {
    status.textContent = 'Camera links are switched off on this server (CCTV_RTSP=off in its settings file).'
    toggle.hidden = true
  } else if (!s.installed) {
    status.textContent = 'The RTSP server (MediaMTX) is not installed on this machine yet: run deploy/install-mediamtx.sh on it once. Keys can be made meanwhile.'
  } else if (!view.enabled) {
    status.textContent = 'Camera links are off: no program can connect.'
  } else if (s.running) {
    status.textContent = `On: rtsp://<this server>:${view.port}/… — ${view.feeds} camera${view.feeds === 1 ? '' : 's'} being sent, ${view.readers} program${view.readers === 1 ? '' : 's'} reading.`
  } else {
    status.textContent = `On, but the RTSP server is not running${s.lastError ? `: ${s.lastError}` : ''}. It is tried again by itself.`
  }
  toggle.textContent = view.enabled ? 'Turn off camera links' : 'Turn on camera links'
  toggle.classList.toggle('danger', view.enabled)
  toggle.classList.toggle('st-primary', !view.enabled)
}

/** The camera choices, by site and recorder. */
function renderCameras() {
  const box = $('rl-cams')
  if (box.childElementCount) return
  let group = null
  let groupKey = ''
  for (const c of view.cameras) {
    const k = `${c.site}|${c.nvr}`
    if (k !== groupKey) {
      groupKey = k
      group = el('fieldset', { className: 'rl-cam-group' }, el('legend', { textContent: `${c.site ? `${c.site} · ` : ''}${c.nvrName || c.nvr}` }))
      box.append(group)
    }
    group.append(el('label', {}, el('input', { type: 'checkbox', value: `${c.nvr}/${c.ch}` }), ` ${c.ch + 1} ${c.name || ''}`))
  }
  if (!view.cameras.length) box.append(el('p', { className: 'st-meta', textContent: 'No cameras yet.' }))
}

/** The addresses of a key just made, with its password: shown this once. */
function showMade(r) {
  const box = $('rl-made')
  const host = el('select', { className: 'rl-host' })
  for (const h of r.hosts?.length ? r.hosts : [location.hostname]) host.append(el('option', { value: h, textContent: h }))
  const list = el('div', { className: 'rl-made-list' })
  const fill = () => {
    list.replaceChildren()
    for (const c of r.linkCameras.slice(0, 200)) {
      list.append(urlRow(camName(c), rtspUrl({ host: host.value, port: r.port, user: r.key.user, password: r.password, path: c.path })).row)
      if (r.key.main) list.append(urlRow(`${camName(c)} — full quality`, rtspUrl({ host: host.value, port: r.port, user: r.key.user, password: r.password, path: c.mainPath })).row)
    }
  }
  host.addEventListener('change', fill)
  fill()
  const done = el('button', { type: 'button', textContent: 'I have copied what I need' })
  done.addEventListener('click', () => {
    box.hidden = true
    box.replaceChildren()
  })
  box.replaceChildren(
    el('h3', { textContent: `Key "${r.key.name}" made` }),
    el('p', { className: 'st-help', textContent: 'The password is in these addresses and is shown only now. Copy what the program needs before leaving this page; lost, revoke the key and make a new one. Paste an address into VLC: Media → Open Network Stream.' }),
    el('p', {}, el('span', { className: 'rl-label', textContent: 'User name ' }), el('code', { textContent: r.key.user }), el('span', { className: 'rl-label', textContent: '  Password ' }), el('code', { textContent: r.password })),
    el('label', { className: 'rl-host-label' }, 'Server address ', host),
    list,
    el('p', {}, done)
  )
  box.hidden = false
}

/** The keys: what each covers, when it was last used and from where, and Revoke. */
function renderKeys() {
  const box = $('rl-keys')
  if (!view.keys.length) {
    box.replaceChildren(el('p', { className: 'st-meta', textContent: 'No keys yet.' }))
    return
  }
  const byKey = new Map(view.cameras.map((c) => [`${c.nvr}/${c.ch}`, c]))
  const rows = [...view.keys].sort((a, b) => b.createdAt - a.createdAt).map((k) => {
    const covers = k.cameras === 'all' ? 'every camera' : k.cameras.length === 1 ? (byKey.get(k.cameras[0]) ? camName(byKey.get(k.cameras[0])) : k.cameras[0]) : `${k.cameras.length} cameras`
    const revoke = el('button', { type: 'button', className: 'btn-ghost danger', textContent: 'Revoke' })
    revoke.addEventListener('click', async () => {
      if (!confirm(`Revoke the key "${k.name}"?\n\nAny program using it is cut off and cannot connect again with it.`)) return
      revoke.disabled = true
      try {
        view = await api('POST', { action: 'revoke', id: k.id })
        render()
      } catch (e) {
        revoke.disabled = false
        alert(`Could not revoke: ${e.message}`)
      }
    })
    const paths = (k.cameras === 'all' ? view.cameras : k.cameras.map((x) => byKey.get(x)).filter(Boolean)).slice(0, 50)
    const addresses = el('details', { className: 'rl-addr' }, el('summary', { textContent: 'Addresses' }), ...paths.map((c) => el('div', { className: 'rl-path' }, el('code', { textContent: rtspUrl({ host: view.hosts[0] ?? location.hostname, port: view.port, user: k.user, password: '<password>', path: c.path }).replace('%3Cpassword%3E', '<password>') }), k.main ? el('code', { textContent: ` …/${c.mainPath.split('/').pop()}` }) : null)))
    return el('tr', {},
      el('td', {}, el('strong', { textContent: k.name }), el('br'), el('code', { textContent: k.user })),
      el('td', { textContent: `${covers}${k.main ? ', full quality too' : ''}` }),
      el('td', { textContent: `${when(k.createdAt)}${k.createdBy ? ` by ${k.createdBy}` : ''}` }),
      el('td', { textContent: k.lastUsedAt ? `${when(k.lastUsedAt)}${k.lastUsedIp ? ` from ${k.lastUsedIp}` : ''}` : 'never' }),
      el('td', {}, addresses, revoke))
  })
  box.replaceChildren(el('table', { className: 'rl-table' },
    el('thead', {}, el('tr', {}, ...['Key', 'Cameras', 'Made', 'Last used', ''].map((h) => el('th', { textContent: h })))),
    el('tbody', {}, ...rows)))
}

function render() {
  renderStatus()
  renderCameras()
  renderKeys()
}

async function load() {
  try {
    view = await api('GET')
    render()
  } catch (e) {
    status.textContent = `Could not read camera links: ${e.message}`
  }
}

if (status) {
  $('rl-toggle').addEventListener('click', async () => {
    const on = !view.enabled
    $('rl-toggle-msg').textContent = on ? 'Turning on…' : 'Turning off…'
    try {
      view = await api('POST', { action: 'enable', on })
      $('rl-toggle-msg').textContent = ''
      render()
      setTimeout(load, 2000) // (the RTSP server takes a moment to start)
    } catch (e) {
      $('rl-toggle-msg').textContent = e.message
    }
  })
  for (const r of document.querySelectorAll('input[name="rl-which"]')) r.addEventListener('change', () => ($('rl-cams').hidden = !document.querySelector('input[name="rl-which"][value="some"]').checked))
  $('rl-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const some = document.querySelector('input[name="rl-which"][value="some"]').checked
    const cameras = some ? [...$('rl-cams').querySelectorAll('input:checked')].map((i) => i.value) : 'all'
    $('rl-msg').textContent = 'Making…'
    try {
      const r = await api('POST', { action: 'create', name: $('rl-name').value, cameras, main: $('rl-main').checked })
      view = r
      $('rl-msg').textContent = ''
      $('rl-form').reset()
      $('rl-cams').hidden = true
      render()
      showMade(r)
    } catch (err) {
      $('rl-msg').textContent = err.message
    }
  })
  // admins only: the page says so itself for anyone else (settings.js), and the server refuses
  fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then((me) => (me?.admin ? load() : (status.textContent = 'Only admins can manage camera links.'))).catch(() => {})
  // the status line only (a full render would close an open list of addresses)
  setInterval(async () => {
    if (location.hash !== '#links' || !view) return
    try {
      const keep = view.cameras
      view = { ...(await api('GET')), cameras: keep }
      renderStatus()
    } catch {}
  }, 15_000)
}
