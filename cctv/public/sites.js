// Sites page: add, edit and remove NVRs (admins only).
import { openCameraEditor } from './camera-editor.js'
import { camerasForNvr, cameraLabel } from './camera-choice.js'
import { setupFindDevice } from './find-device.js'

const $ = (id) => document.getElementById(id)
const sitesEl = $('sites')
const notice = $('notice')
const dialog = $('dialog')
const form = $('form')
const formError = $('formError')
const saveBtn = $('save')

let nvrList = []
let vpn = { available: false, sites: [] } // the WireGuard hub's status (deploy/vpn)
let editing = null // id of the NVR being edited, or null when adding

async function api(method, path, body, timeoutMs = 8000) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (res.status === 401) location.href = '/login.html'
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`)
    err.testFailed = data.testFailed
    throw err
  }
  return data
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  Object.assign(node, props)
  node.append(...children.filter((c) => c !== null && c !== undefined))
  return node
}

const STATUS_TEXT = { online: 'Online', connecting: 'Connecting…', offline: 'Offline' }

/** Which codec the cameras' sub streams (used for live grids) were seen sending. */
function subStreamNote(seen) {
  if (!seen || seen.h264 + seen.h265 === 0) return null
  if (seen.h265 === 0) return el('p', { className: 'st-meta', textContent: `Sub-streams: H.264 (${seen.h264} seen) — plays in every browser` })
  return el('p', {
    className: 'st-warn-text',
    textContent: `Sub-streams: ${seen.h265} H.265${seen.h264 ? `, ${seen.h264} H.264` : ''}. Most browsers can’t play H.265 in live grids — set these cameras’ sub-streams to H.264 on the NVR.`
  })
}

let cameraList = null // /api/cameras, fetched once when a dropdown first opens
async function allCameras() {
  if (!cameraList) cameraList = await api('GET', '/api/cameras').catch(() => [])
  return cameraList
}

let openEditor = null // { chip, mount, handle } — one camera editor on the page at a time
/** Close the open editor, asking first when it has unsent changes. Returns false if it was kept open. */
function closeEditor() {
  if (!openEditor) return true
  if (!openEditor.handle.confirmDiscard()) return false
  openEditor.chip.setAttribute('aria-pressed', 'false')
  openEditor.handle.close()
  openEditor = null
  return true
}

/** A per-NVR dropdown of its cameras; a chip opens the inline settings editor with a live preview. */
function camerasPanel(n) {
  const body = el('div', { className: 'st-cameras-body' })
  const mount = el('div', { className: 'st-cameras-editor' })
  const d = el('details', { className: 'st-cameras' }, el('summary', { className: 'st-cameras-sum' }, `Cameras (${n.cameras ?? 0})`), body, mount)
  let built = false
  d.addEventListener('toggle', async () => {
    if (!d.open || built) return
    built = true
    const cams = camerasForNvr(await allCameras(), n.id)
    if (!cams.length) { body.append(el('p', { className: 'st-meta', textContent: 'No cameras reported for this NVR.' })); return }
    for (const cam of cams) {
      const chip = el('button', { type: 'button', className: `st-cam-chip${cam.online === false ? ' st-cam-off' : ''}`, textContent: cameraLabel(cam) })
      chip.setAttribute('aria-pressed', 'false')
      chip.addEventListener('click', () => {
        if (openEditor?.chip === chip) { closeEditor(); return } // click the open chip to close
        if (!closeEditor()) return // another editor had unsent changes and was kept
        chip.setAttribute('aria-pressed', 'true')
        openEditor = { chip, mount, handle: openCameraEditor(mount, cam, { onClose: () => { openEditor = null } }) }
      })
      body.append(chip)
    }
  })
  // collapsing the dropdown closes its editor; unsent changes are asked about first
  d.querySelector('summary').addEventListener('click', (e) => {
    if (d.open && openEditor && openEditor.mount === mount && !closeEditor()) e.preventDefault()
  })
  return d
}

function render() {
  if (nvrList.length === 0) {
    sitesEl.replaceChildren(el('p', { className: 'st-empty', textContent: 'No NVRs yet. Click “+ Add NVR” to add the first one.' }))
    return
  }
  // a camera dropdown open means its editor is mounted inside it; a full re-render (the 5 s poll)
  // would tear it out, so hold off until every dropdown is closed again
  if (sitesEl.querySelector('details[open]')) return
  // one block per site: a heading that sums the site up, then one row per NVR
  const bySite = Map.groupBy(nvrList, (n) => n.site || 'Unassigned')
  const groups = [...bySite].sort(([a], [b]) => a.localeCompare(b)).map(([site, list]) => {
    const rename = el('button', { type: 'button', className: 'btn-ghost st-site-rename', textContent: 'Rename' })
    rename.addEventListener('click', () => renameSite(site, list))
    const cams = list.reduce((t, n) => t + (n.cameras ?? 0), 0)
    const camsUp = list.reduce((t, n) => t + (n.status === 'online' ? n.camerasOnline ?? 0 : 0), 0)
    const down = list.filter((n) => n.status !== 'online').length
    const summary = `${list.length} NVR${list.length === 1 ? '' : 's'} · ${camsUp} of ${cams} cameras online${down ? ` · ${down} NVR${down === 1 ? '' : 's'} not connected` : ''}`
    const rows = list.flatMap((n) => {
      const edit = el('button', { type: 'button', textContent: 'Edit' })
      edit.addEventListener('click', () => openForm(n))
      const remove = el('button', { type: 'button', className: 'btn-ghost st-row-remove', textContent: 'Remove', title: `Remove ${n.name}` })
      remove.addEventListener('click', () => removeNvr(n))
      let subs = null
      // (the sub-stream switch speaks the TVT NVR's own settings: not for a Hikvision device)
      if (n.status === 'online' && n.brand !== 'hikvision') {
        subs = el('button', { type: 'button', textContent: 'Sub-streams' })
        subs.addEventListener('click', () => openSubstreams(n))
      }
      const online = n.status === 'online'
      const pct = online && n.cameras ? Math.round((100 * (n.camerasOnline ?? 0)) / n.cameras) : 0
      const problem = n.vpnSite && !n.vpnSite.connected
        ? `VPN tunnel to ${n.vpnSite.name}: ${tunnelText(n.vpnSite)}`
        : !online && n.error ? n.error : ''
      const note = subStreamNote(n.subStreamsSeen)
      const row = el(
        'div',
        { className: `st-nvr st-nvr-${n.status}` },
        el('span', { className: `st-dot st-${n.status}`, title: STATUS_TEXT[n.status] ?? n.status }),
        el('div', { className: 'st-nvr-main' },
          el('div', { className: 'st-nvr-name', textContent: n.name }),
          el('div', { className: 'st-meta', textContent: [whereText(n), n.model, `user ${n.user}`].filter(Boolean).join(' · ') }),
          problem ? el('div', { className: 'st-error-text', textContent: problem }) : null,
          note),
        el('div', { className: 'st-nvr-cams' },
          el('span', { textContent: online ? `${n.camerasOnline} / ${n.cameras}` : STATUS_TEXT[n.status] ?? n.status }),
          online ? el('span', { className: 'st-bar' }, el('span', { style: `width:${pct}%` })) : null),
        el('div', { className: 'st-nvr-actions' }, subs, edit, remove)
      )
      row.dataset.nvr = n.id // Find device's "Show" scrolls to it
      return [row, camerasPanel(n)]
    })
    return el(
      'section',
      { className: 'st-site' },
      el('div', { className: 'st-site-head' }, el('div', {}, el('h2', { textContent: site }), el('p', { className: 'st-meta', textContent: summary })), rename),
      el('div', { className: 'st-nvrs' }, ...rows)
    )
  })
  sitesEl.replaceChildren(...groups)
}

/** The VPN sites: whether each tunnel is up, and the NVRs reached through it. */
function renderVpn() {
  const box = $('vpn')
  box.hidden = !vpn.available
  if (!vpn.available) return
  const rows = vpn.sites.map((s) => {
    const add = el('button', { type: 'button', textContent: 'Add NVR here' })
    add.addEventListener('click', () => openForm(null, { host: s.virtualSubnet.replace(/0\/24$/, ''), remote: true, site: s.name, name: `${s.name} NVR` }))
    const nvrs = s.nvrs.length ? s.nvrs.map((n) => `${n.name} (${n.host})`).join(', ') : 'no NVR added yet'
    return el(
      'li',
      { className: 'st-vpn-site' },
      el('span', { className: `st-status ${s.connected ? 'st-online' : 'st-offline'}`, textContent: s.name }),
      el('span', { className: 'st-meta', textContent: `${s.virtualSubnet}${s.realLan ? ` = ${s.realLan} there` : ''} · ${tunnelText(s)}${s.endpoint ? ` · from ${s.endpoint}` : ''}` }),
      el('span', { className: 'st-meta', textContent: `NVRs: ${nvrs}` }),
      add
    )
  })
  box.replaceChildren(
    ...[
    el('h2', { id: 'vpn-title', textContent: 'VPN sites' }),
    vpn.stale ? el('p', { className: 'st-warn-text', textContent: `VPN status is out of date (last written ${vpn.at ?? 'never'}): is the cctv-vpn-status timer running on the server?` }) : null,
    vpn.sites.length
      ? el('ul', { className: 'st-vpn-list' }, ...rows)
      : el('p', { className: 'st-meta', textContent: 'The VPN hub is set up, but no remote site has been added yet (deploy/vpn/README.md).' }),
    el('p', { className: 'st-help', textContent: 'An NVR at a VPN site is added with its address inside that site’s 10.78.x range: 10.78.<site>.<last number of its real address>.' })
    ].filter(Boolean)
  )
}

let siteLoad = null
function load() {
  if (document.hidden) return Promise.resolve()
  if (siteLoad) return siteLoad
  siteLoad = loadImpl().finally(() => { siteLoad = null })
  return siteLoad
}
async function loadImpl() {
  try {
    ;[nvrList, vpn] = await Promise.all([api('GET', '/api/admin/nvrs'), api('GET', '/api/admin/vpn').catch(() => ({ available: false, sites: [] }))])
    notice.hidden = true
    renderVpn()
    render()
    $('siteNames').replaceChildren(...[...new Set(nvrList.map((n) => n.site))].map((s) => el('option', { value: s })))
  } catch (e) {
    notice.textContent = e.message
    notice.hidden = false
  }
}

/** How an NVR is reached, for cards and messages. */
const whereText = (n) =>
  (n.brand === 'hikvision' ? 'Hikvision · ' : '') +
  (n.via === 'p2p' ? `P2P cloud · serial ${n.sn}` : n.vpnSite ? `${n.host} via VPN site ${n.vpnSite.name}` : `${n.host}:${n.port}`)

/** "12 s", "4 min", "3 h", "2 days" */
const agoS = (s) => (s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`)
const tunnelText = (t) => (t.connected ? `connected (${agoS(t.lastHandshakeAgoS)} ago)` : t.lastHandshakeAgoS === null ? 'never connected' : `not connected — last seen ${agoS(t.lastHandshakeAgoS)} ago`)
const isHikForm = () => $('f-brand-hik').checked
const byP2p = () => !isHikForm() && $('f-via-p2p').checked
const TVT_PORT = 6036
const HIK_PORT = 8000

// ---- Hikvision: Hik-Connect (P2P) ----
// The account sign-in goes through the SDK's NET_SDK_P2P_LOGIN_2C (hik-config.mjs). It stays off until
// the four values Hikvision gives with developer access are known (typed here, already stored, or set for
// the whole server); the server refuses it otherwise. Secrets are never sent back: only "set" or "not set".
const HP_DEV = [['appId', 'f-hp-appid'], ['authAddr', 'f-hp-auth'], ['platformAddr', 'f-hp-platform'], ['platformType', 'f-hp-ptype']]
let hpStored = null // the edited device's public p2p (publicP2p), or null
const hpHas = (key, input) => $(input).value.trim() !== '' || Boolean(hpStored?.[`${key}Set`] || hpStored?.fromServer?.[key])
const hpAccess = () => HP_DEV.every(([k, i]) => hpHas(k, i))
const hpTouched = () => Boolean(hpStored) || $('f-hp-on').checked || ['f-hp-account', 'f-hp-password', ...HP_DEV.map(([, i]) => i)].some((i) => $(i).value.trim() !== '')

/** The Hik-Connect switch is usable only once the developer values are there; its line says why not. */
function showHikP2p() {
  const access = hpAccess()
  const on = $('f-hp-on')
  on.disabled = !access
  if (!access) on.checked = false
  for (const [k, i] of HP_DEV) {
    const hint = $(`${i}-hint`)
    if (hint) hint.textContent = $(i).value.trim() ? 'will be saved' : hpStored?.[`${k}Set`] ? 'set (leave empty to keep it)' : hpStored?.fromServer?.[k] ? 'set for the whole server' : 'not set'
  }
  $('f-hp-password-hint').textContent = hpStored?.passwordSet ? 'Set (leave empty to keep it). Kept on the server, never shown again.' : 'Kept on the server like the device password, never shown again.'
  $('f-hp-state').textContent = !access
    ? 'Off — needs Hik-Connect developer access (AppID and server addresses from Hikvision).'
    : on.checked ? 'On — signs in to Hik-Connect when the device connects (unverified).' : 'Off — tick the box to sign in to Hik-Connect for this device.'
}
for (const id of ['f-hp-on', 'f-hp-account', ...HP_DEV.map(([, i]) => i)]) $(id).addEventListener('input', showHikP2p)

/** The body's p2p block for a Hikvision device, or undefined when nothing about it was touched. */
function hikP2pBody() {
  if (!hpTouched()) return undefined
  const b = { enabled: $('f-hp-on').checked && !$('f-hp-on').disabled, account: $('f-hp-account').value.trim() }
  if ($('f-hp-password').value) b.password = $('f-hp-password').value
  for (const [k, i] of HP_DEV) if ($(i).value.trim() !== '') b[k] = k === 'platformType' ? Number($(i).value) : $(i).value.trim()
  return b
}

/** TVT or Hikvision: which fields the dialog shows. A Hikvision device is reached by its address only. */
function showBrand() {
  const hik = isHikForm()
  $('f-via-set').hidden = hik
  $('f-hik-help').hidden = !hik
  $('f-hikp2p').hidden = !hik
  $('test').hidden = !hik
  // the other make's usual port is swapped for this one's; a port typed by hand stays
  const port = Number($('f-port').value)
  if (hik && port === TVT_PORT) $('f-port').value = HIK_PORT
  if (!hik && port === HIK_PORT) $('f-port').value = TVT_PORT
  $('f-password-hint').textContent = hik ? 'The device’s own login (the one its web page uses). It is tested before saving and never shown again.' : 'The NVR\'s own login. It is tested before saving and never shown again.'
  showHikP2p()
  showVia()
}
for (const id of ['f-brand-tvt', 'f-brand-hik']) $(id).addEventListener('change', showBrand)

/** Shows the address fields or the serial number field. */
function showVia() {
  const p2p = byP2p()
  $('f-lan').hidden = p2p
  $('f-p2p').hidden = !p2p
  $('f-host').required = !p2p
  $('f-port').required = !p2p
  $('f-sn').required = p2p
  // hidden fields are disabled too, so a leftover value there never blocks the form
  $('f-sn').disabled = !p2p
  $('f-host').disabled = p2p
  $('f-port').disabled = p2p
}
for (const id of ['f-via-lan', 'f-via-p2p']) $(id).addEventListener('change', showVia)
$('f-host').addEventListener('change', () => {
  if (!editing && /^10\.78\./.test($('f-host').value.trim())) $('f-remote').checked = true
})

/** @param {object} [prefill] { host, port, name } from Find NVRs, or { brand: 'hikvision', host, port, name } from Discover devices */
function openForm(nvr = null, prefill = {}) {
  editing = nvr?.id ?? null
  const hik = (nvr?.brand ?? prefill.brand) === 'hikvision'
  $('formTitle').textContent = nvr ? `Edit ${nvr.name}` : hik ? 'Add Hikvision device' : 'Add NVR'
  $(hik ? 'f-brand-hik' : 'f-brand-tvt').checked = true
  // the make of a saved recorder cannot change (remove it and add it again)
  for (const id of ['f-brand-tvt', 'f-brand-hik']) $(id).disabled = Boolean(nvr)
  hpStored = hik ? nvr?.p2p ?? null : null
  $('f-hp-on').checked = Boolean(hpStored?.enabled)
  $('f-hp-account').value = hpStored?.account ?? ''
  for (const id of ['f-hp-password', ...HP_DEV.map(([, i]) => i)]) $(id).value = ''
  $('f-hikp2p').open = Boolean(hpStored?.enabled)
  $('formResult').hidden = true
  $('f-site').value = nvr?.site ?? prefill.site ?? nvrList[0]?.site ?? ''
  $('f-name').value = nvr?.name ?? prefill.name ?? `NVR ${nvrList.length + 1}`
  const p2p = nvr?.via === 'p2p'
  $(p2p ? 'f-via-p2p' : 'f-via-lan').checked = true
  $('f-host').value = p2p ? '' : nvr?.host ?? prefill.host ?? ''
  $('f-port').value = p2p ? TVT_PORT : nvr?.port ?? prefill.port ?? (hik ? HIK_PORT : TVT_PORT)
  $('f-sn').value = nvr?.sn ?? ''
  $('f-nat').value = String(nvr?.nat === 1 ? 1 : 2) // default NAT 2.0
  $('f-remote').checked = nvr ? Boolean(nvr.remote) : Boolean(prefill.remote)
  showBrand()
  $('f-user').value = nvr?.user ?? 'admin'
  $('f-password').value = ''
  $('f-password').required = !nvr
  $('f-password').placeholder = nvr ? 'leave empty to keep the current password' : ''
  $('f-skip').checked = false
  formError.hidden = true
  saveBtn.disabled = false
  saveBtn.textContent = 'Test & save'
  dialog.showModal()
  // found by Find NVRs: the address is known, the password is what's left to type
  // a VPN site's range ("10.78.2."): the last number is what's left to type
  ;(nvr ? $('f-name') : prefill.host && !prefill.host.endsWith('.') ? $('f-password') : $('f-host')).focus()
}

/** The form as a request body (Hikvision: brand, address and the Hik-Connect block). */
function formBody() {
  const hik = isHikForm()
  const p2p = byP2p()
  const body = {
    site: $('f-site').value,
    name: $('f-name').value,
    user: $('f-user').value,
    remote: $('f-remote').checked,
    skipTest: $('f-skip').checked
  }
  if (hik) {
    Object.assign(body, { brand: 'hikvision', host: $('f-host').value, port: Number($('f-port').value) })
    const hp = hikP2pBody()
    if (hp) body.p2p = hp
  } else if (p2p) {
    // by serial number no address or port is sent (the server uses its P2P server)
    Object.assign(body, { sn: $('f-sn').value.trim().toUpperCase(), nat: Number($('f-nat').value) === 1 ? 1 : 2 })
  } else {
    // sn '' switches an NVR back to its address
    Object.assign(body, { sn: '', host: $('f-host').value, port: Number($('f-port').value) })
  }
  if ($('f-password').value) body.password = $('f-password').value
  return body
}

/** One line from a Hikvision test login's answer: model, serial, cameras (and Hik-Connect's word). */
function hikTestText(r) {
  const parts = [`Logged in: ${r.model || 'Hikvision device'}${r.name ? ` “${r.name}”` : ''}`]
  if (r.serial) parts.push(`serial ${r.serial}`)
  parts.push(`${r.cameras} camera${r.cameras === 1 ? '' : 's'}${r.channels && r.channels !== r.cameras ? ` (${r.channels} channels)` : ''}`)
  if (r.note) parts.push(r.note)
  if (r.p2p?.state === 'ready' && r.p2p.message) parts.push(r.p2p.message)
  return parts.join(' · ')
}

// "Test" (Hikvision): one login, nothing saved
$('test').addEventListener('click', async () => {
  if (!$('f-host').reportValidity() || !$('f-port').reportValidity() || !$('f-user').reportValidity()) return
  const body = { ...formBody(), id: editing ?? undefined }
  formError.hidden = true
  $('formResult').hidden = true
  const btn = $('test')
  btn.disabled = true
  btn.textContent = 'Testing (up to 60 s)…'
  try {
    $('formResult').textContent = hikTestText(await api('POST', '/api/admin/nvr-test', body, 75_000))
    $('formResult').hidden = false
  } catch (err) {
    formError.textContent = `Could not log in: ${err.message}`
    formError.hidden = false
  } finally {
    btn.disabled = false
    btn.textContent = 'Test'
  }
})

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const hik = isHikForm()
  const p2p = byP2p()
  const body = formBody()
  formError.hidden = true
  saveBtn.disabled = true
  // an unreachable address takes the SDK ~20 s (3 tries x 5 s) to give up on; a Hikvision device's test
  // runs in a process of its own and takes up to a minute
  saveBtn.textContent = body.skipTest ? 'Saving…' : p2p ? 'Testing login through the P2P cloud (up to 40 s)…' : hik ? 'Testing login (up to 60 s)…' : 'Testing login (up to 20 s)…'
  const wait = hik && !body.skipTest ? 75_000 : undefined // (a TVT NVR's as before)
  try {
    if (editing) await api('PUT', `/api/admin/nvrs/${encodeURIComponent(editing)}`, body, wait)
    else await api('POST', '/api/admin/nvrs', body, wait)
    dialog.close()
    await load()
  } catch (err) {
    formError.textContent = err.testFailed
      ? `${err.message}. Check ${p2p ? 'the serial number and login, and that P2P is on in the NVR’s network settings' : hik ? 'the address, the SDK port (8000 unless changed on the device) and the login' : 'the address, port and login'}, or tick “Save even if…” to save anyway.`
      : err.message
    formError.hidden = false
  } finally {
    saveBtn.disabled = false
    saveBtn.textContent = 'Test & save'
  }
})

$('cancel').addEventListener('click', () => dialog.close())
$('add').addEventListener('click', () => openForm())

// ---- Find NVRs ----

const discover = $('discover')
const dStatus = $('d-status')
const dResults = $('d-results')
const dNotes = $('d-notes')
const dSearch = $('d-search')
let lastFound = null // the last search, shown again (with fresh "added" marks) when the dialog reopens

$('find').addEventListener('click', async () => {
  discover.showModal()
  if (lastFound) {
    // an NVR added from these results since: mark it, don't offer it again
    for (const d of lastFound.devices) {
      const n = nvrList.find((x) => x.host === d.ip && Number(x.port) === d.port)
      d.added = n ? { id: n.id, name: n.name, site: n.site } : null
    }
    showFound(lastFound)
  }
  if ($('d-ranges').value) return
  let saved = ''
  try { saved = localStorage.getItem('cctv.findRanges') ?? '' } catch {}
  if (saved) {
    $('d-ranges').value = saved
    return
  }
  try {
    const d = await api('GET', '/api/admin/discovery')
    $('d-ranges').value ||= d.ranges
  } catch {}
})
$('d-close').addEventListener('click', () => discover.close())

$('d-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const ranges = $('d-ranges').value.trim()
  try { localStorage.setItem('cctv.findRanges', ranges) } catch {}
  dSearch.disabled = true
  dNotes.replaceChildren()
  dResults.replaceChildren()
  dStatus.textContent = 'Searching… this can take up to half a minute.'
  try {
    const r = await api('POST', '/api/admin/discovery', { ranges, port: Number($('d-port').value) })
    lastFound = r
    showFound(r)
  } catch (err) {
    dStatus.textContent = err.message
  } finally {
    dSearch.disabled = false
  }
})

const isCamera = (d) => d.type === 'IP camera'

function showFound(r) {
  const secs = Math.max(1, Math.round(r.ms / 1000))
  const recorders = r.devices.filter((d) => !isCamera(d))
  const cameras = r.devices.length - recorders.length
  const fresh = recorders.filter((d) => !d.added).length
  dStatus.textContent =
    (recorders.length
      ? `Found ${recorders.length} NVR${recorders.length === 1 ? '' : 's'} (${fresh} not added yet)`
      : 'No NVRs found') +
    (cameras ? ` and ${cameras} TVT camera${cameras === 1 ? '' : 's'}` : '') +
    `, checked ${r.scanned} addresses in ${secs} s.`
  dNotes.replaceChildren(...r.notes.map((n) => el('p', { className: 'st-warn-text', textContent: n })))
  if (r.others) {
    dNotes.append(el('p', { className: 'st-meta', textContent: `${r.others} other device${r.others === 1 ? '' : 's'} had the port open but did not answer like a TVT NVR (usually PCs), so they are not listed.` }))
  }
  dResults.replaceChildren(...r.devices.map(foundItem))
}

function foundItem(d) {
  const title = d.name || d.model || 'TVT NVR'
  const facts = [
    d.type && d.type !== 'NVR' ? d.type : null,
    d.name && d.model ? d.model : null,
    `${d.ip}:${d.port}`,
    d.channels ? `${d.channels} channels` : null,
    d.firmware ? `firmware ${d.firmware}` : null,
    d.mac ? `MAC ${d.mac}` : null
  ].filter(Boolean)
  let action
  if (d.added) {
    action = el('span', { className: 'st-meta', textContent: `Added as ${d.added.name} (${d.added.site})` })
  } else if (isCamera(d)) {
    // single cameras are shown through their NVR: adding one as an NVR would duplicate it
    action = el('span', { className: 'st-meta', textContent: 'Camera: add its NVR' })
  } else {
    action = el('button', { type: 'button', className: 'st-primary', textContent: 'Add' })
    action.setAttribute('aria-label', `Add ${title} (${d.ip}:${d.port})`)
    action.addEventListener('click', () => {
      discover.close()
      openForm(null, { host: d.ip, port: d.port, name: (d.name || d.model || `NVR ${d.ip}`).slice(0, 64) })
    })
  }
  return el(
    'li',
    { className: `st-found-item${d.added ? ' st-found-added' : ''}` },
    el('div', { className: 'st-found-main' },
      el('strong', { textContent: title }),
      el('span', { className: 'st-meta', textContent: facts.join(' · ') }),
      el('span', { className: 'st-found-by', textContent: `Found by ${d.foundBy.join(' and ')}` })),
    action
  )
}

/** Find device's "Show": scrolls to that recorder's row and marks it for a moment. */
function showRecorder(id) {
  const row = [...sitesEl.querySelectorAll('.st-nvr')].find((r) => r.dataset.nvr === id)
  if (!row) return
  row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  row.classList.add('fd-flash')
  setTimeout(() => row.classList.remove('fd-flash'), 2500)
}

async function removeNvr(n) {
  if (!confirm(`Remove ${n.name} (${whereText(n)}) from site "${n.site}"?\n\nIts cameras disappear from the app. Nothing on the NVR itself is changed.`)) return
  try {
    await api('DELETE', `/api/admin/nvrs/${encodeURIComponent(n.id)}`)
    await load()
  } catch (e) {
    alert(e.message)
  }
}

async function renameSite(site, list) {
  const name = prompt(`New name for site "${site}":`, site)?.trim()
  if (!name || name === site) return
  try {
    for (const n of list) await api('PUT', `/api/admin/nvrs/${encodeURIComponent(n.id)}`, { site: name })
    await load()
  } catch (e) {
    alert(e.message)
  }
}

// ---- sub-streams (H.265 -> H.264) ----

const subsDialog = $('subs')
const sStatus = $('s-status')
const sError = $('s-error')
const sList = $('s-list')
const sApply = $('s-apply')
let subsNvr = null // the NVR the dialog is for
let subsData = null // its last answer (always for subsNvr: see openSeq)
let subsBusy = false
let openSeq = 0 // bumps on every open and close: answers and loops from an older one are dropped
const picked = new Set() // ticked channels, kept across redraws

const bitrateChoice = () => $('s-form').querySelector('input[name="s-bitrate"]:checked')?.value ?? 'match'
const selectedIds = () => (subsData?.channels ?? []).filter((c) => c.canSwitch && picked.has(c.id)).map((c) => c.id)
const subsUrl = (id, tail = '') => `/api/admin/nvrs/${encodeURIComponent(id)}/substreams${tail}`
const showError = (text) => {
  sError.textContent = text ?? ''
  sError.hidden = !text
}
const updateApply = () => {
  const n = selectedIds().length
  sApply.disabled = subsBusy || n === 0
  sApply.textContent = n ? `Switch ${n} to H.264` : 'Switch to H.264'
}

async function openSubstreams(nvr) {
  const seq = ++openSeq
  subsNvr = nvr
  subsData = null
  subsBusy = false
  picked.clear()
  showError(null)
  $('s-title').textContent = `Sub-streams: ${nvr.name}`
  sList.replaceChildren()
  sStatus.textContent = 'Reading the sub-stream settings from the NVR…'
  subsDialog.showModal()
  await loadSubstreams(seq)
}

/** Reads the list for the dialog's NVR; ignored if the dialog was closed or reopened meanwhile. */
async function loadSubstreams(seq) {
  const nvrId = subsNvr.id
  try {
    const data = await api('GET', subsUrl(nvrId))
    if (seq !== openSeq || data.nvr?.id !== nvrId) return
    subsData = data
    renderSubstreams()
    if (data.job?.running) watchJob(seq)
  } catch (e) {
    if (seq !== openSeq) return
    showError(`Could not read the sub-streams: ${e.message}`)
    sStatus.textContent = subsData ? 'Showing the last list read.' : ''
  }
}

/** How long ago, for step results from an earlier change. */
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}

function renderSubstreams() {
  const chs = subsData.channels
  const count = (codec) => chs.filter((c) => c.codec === codec).length
  const h264 = count('H.264')
  const h265 = chs.filter((c) => c.h265).length
  const other = chs.length - h264 - h265
  const seen265 = chs.filter((c) => c.seen?.startsWith('H.265') && !c.h265).length
  sStatus.textContent =
    `${chs.length} cameras: ${h264} on H.264, ${h265} on H.265${other ? `, ${other} other or unknown` : ''}.` +
    (seen265 ? ` The live video of ${seen265} showed H.265 in the last 10 minutes although the NVR says H.264: those cameras may not follow the NVR’s setting.` : '')
  const job = subsData.job
  // results of a change: while it runs, and for a while after
  const showSteps = job && (job.running || Date.now() - (job.finishedAt ?? 0) < 30 * 60_000)
  const steps = new Map(showSteps ? job.steps.map((s) => [s.id, s]) : [])
  const bitrate = bitrateChoice()
  const order = (c) => (c.canSwitch ? 0 : c.undo ? 1 : c.h265 ? 2 : 3)
  const rows = [...chs]
    .sort((a, b) => order(a) - order(b) || (a.ch ?? 0) - (b.ch ?? 0))
    .map((c) => {
      const detail = [c.codec ?? 'no sub-stream', c.res, c.fps ? `${c.fps} fps` : null, c.kbps ? `${c.kbps} kbps${c.bitType ? ` ${c.bitType}` : ''}` : null]
      const facts = [detail.filter(Boolean).join(' · ')]
      // only when the base codec differs (H.265 vs H.265+ is the same stream format)
      if (c.seen && c.codec && c.seen.slice(0, 5) !== c.codec.slice(0, 5)) facts.push(`live video: ${c.seen}`)
      if (c.canSwitch) facts.push(`→ H.264 at ${c.newKbps[bitrate]} kbps`)
      else if (c.why && !/^already/.test(c.why)) facts.push(c.why)
      if (c.undo) facts.push(`changed by ${c.undo.by ?? 'the app'} ${ago(Date.parse(c.undo.at))}`)
      const step = steps.get(c.id)
      const main = el('div', { className: 'st-found-main' },
        el('strong', { textContent: `${c.ch ?? '?'} · ${c.name || 'Camera'}` }),
        el('span', { className: 'st-meta', textContent: facts.join(' · ') }),
        step ? el('span', { className: `st-step st-step-${step.status}`, textContent: stepText(step, job) }) : null)
      let box = null
      let button = null
      if (c.canSwitch) {
        box = el('input', { type: 'checkbox', value: c.id, disabled: subsBusy, checked: picked.has(c.id) })
        box.setAttribute('aria-label', `Switch ${c.ch} ${c.name} to H.264`)
        box.addEventListener('change', (e) => {
          if (e.target.checked) picked.add(c.id)
          else picked.delete(c.id)
          updateApply()
        })
      } else if (c.undo) {
        button = el('button', { type: 'button', textContent: 'Undo', disabled: subsBusy, title: `Back to ${c.undo.to}` })
        button.setAttribute('aria-label', `Undo: switch ${c.ch} ${c.name} back to ${c.undo.to}`)
        button.addEventListener('click', () =>
          runSubstreams('undo', [c.id], `Switch camera ${c.ch} (${c.name}) on ${subsNvr.name} back to ${c.undo.to}?\n\nIts sub-stream restarts: live grids lose it for a few seconds.`)
        )
      }
      return el('li', { className: `st-found-item${c.h265 || c.undo || step ? '' : ' st-found-added'}` }, box, main, button)
    })
  sList.replaceChildren(...rows)
  $('s-all').disabled = subsBusy || !chs.some((c) => c.canSwitch)
  updateApply()
}

function stepText(s, job) {
  const when = job.running ? '' : ` (${ago(job.finishedAt)}, by ${job.user})`
  switch (s.status) {
    case 'waiting': return 'Waiting…'
    case 'working': return 'Changing… (the camera’s sub-stream restarts)'
    case 'done': return `Done: now ${s.now}${when}`
    case 'skipped': return `Not changed: ${s.reason}${when}`
    case 'unknown': return `Unclear whether it changed: ${s.reason}. Check it on the NVR${when}`
    default: return `Failed: ${s.reason}${when}`
  }
}

$('s-all').addEventListener('click', () => {
  for (const c of subsData?.channels ?? []) if (c.canSwitch) picked.add(c.id)
  renderSubstreams()
})
for (const r of $('s-form').querySelectorAll('input[name="s-bitrate"]')) r.addEventListener('change', () => subsData && renderSubstreams())
$('s-close').addEventListener('click', () => subsDialog.close())
subsDialog.addEventListener('close', () => {
  openSeq++ // stops any loop still following a change (the change itself carries on)
  subsBusy = false
})
$('s-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const ids = selectedIds()
  if (!ids.length) return
  const bitrate = bitrateChoice()
  const lines = subsData.channels
    .filter((c) => ids.includes(c.id))
    .map((c) => `${c.ch} · ${c.name}: ${c.codec} ${c.kbps} kbps → H.264 ${c.newKbps[bitrate]} kbps`)
  runSubstreams(
    'h264',
    ids,
    `Switch ${ids.length} camera${ids.length === 1 ? '' : 's'} on ${subsNvr.name} to H.264?\n\n${lines.join('\n')}\n\n` +
      'Each camera’s sub-stream restarts, so live grids lose it for a few seconds; if the NVR also records the sub-stream, that recording pauses briefly too. Main streams are not changed. You can undo it here afterwards.'
  )
})

async function runSubstreams(action, ids, question) {
  if (!confirm(question)) return
  const seq = openSeq
  const data = subsData
  showError(null)
  try {
    subsBusy = true
    renderSubstreams()
    // the device the list came from: the server refuses if it no longer matches
    const r = await api('POST', subsUrl(data.nvr.id), { action, channels: ids, bitrate: bitrateChoice(), device: data.nvr.device, confirm: true })
    for (const id of ids) picked.delete(id)
    if (seq !== openSeq) return
    subsData.job = r.job
    renderSubstreams()
    await watchJob(seq)
  } catch (e) {
    if (seq === openSeq) showError(e.message)
  } finally {
    if (seq === openSeq) {
      subsBusy = false
      if (subsData) renderSubstreams()
    }
  }
}

/** Follows a running change until it ends (or the dialog closes), then reads the list again. */
async function watchJob(seq) {
  const nvrId = subsNvr.id
  subsBusy = true
  let errors = 0
  while (seq === openSeq) {
    await new Promise((r) => setTimeout(r, 1500))
    if (seq !== openSeq) return
    try {
      const { job } = await api('GET', subsUrl(nvrId, '/job'))
      if (seq !== openSeq) return
      errors = 0
      subsData.job = job
      renderSubstreams()
      if (!job?.running) break
    } catch (e) {
      if (++errors >= 5) {
        showError(`Lost track of the change: ${e.message}. Close and reopen this list to see where it got to.`)
        break
      }
    }
  }
  if (seq !== openSeq) return
  subsBusy = false
  await loadSubstreams(seq)
}

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' })
  location.href = '/login.html'
})

let me = await fetch('/api/me').then((r) => (r.ok ? r.json() : null))
// location.href only queues the navigation, so the rest of init still runs this tick: an empty object
// keeps it from throwing on me.user/.admin (which stopped the redirect finishing) while the page leaves.
if (!me) { location.href = '/login.html'; me = {} }
$('whoami').textContent = me.user ?? ''
// adding by serial number (P2P cloud) unless the server has it switched off (CCTV_P2P=off)
$('f-via-p2p').closest('label').hidden = !me.p2p
$('f-via-p2p').disabled = !me.p2p
if (!me.admin) {
  $('add').hidden = true
  $('find').hidden = true
  $('findDevice').hidden = true
  notice.textContent = 'Only admins can manage NVRs and sites. Ask the owner to make your account an admin.'
  notice.hidden = false
} else {
  const se = $('settingsTab'); if (se) se.hidden = false
  // a Hikvision device found by Discover devices: "Add" opens this page's dialog, filled in
  setupFindDevice({ api, el, showRecorder, addDevice: (prefill) => openForm(null, prefill) })
  await load()
  // show connection status as new NVRs log in
  setInterval(load, 5000)
}
