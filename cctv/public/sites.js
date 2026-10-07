// Sites page: add, edit and remove NVRs (admins only).
import { openCameraEditor } from './camera-editor.js'
import { camerasForNvr, cameraLabel } from './camera-choice.js'

import { icon } from './icons.js'
import { notify } from './feedback.js'
import { connectionState, matchesNvr } from './sites-model.js'
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
const searchBar = document.createElement('div')
searchBar.className = 'site-search-bar'
const siteSearch = document.createElement('input')
siteSearch.type = 'search'
siteSearch.placeholder = 'Search sites or NVRs'
siteSearch.setAttribute('aria-label', 'Search sites or NVRs')
const statusFilter = document.createElement('select')
statusFilter.setAttribute('aria-label', 'Filter NVR status')
statusFilter.append(new Option('All statuses', ''), new Option('Connected', 'online'), new Option('Video only', 'partial'), new Option('Connecting', 'connecting'), new Option('Disconnected', 'offline'))
const resultsNote = document.createElement('span')
resultsNote.className = 'st-meta'
resultsNote.setAttribute('role', 'status')
resultsNote.textContent = 'Loading NVRs...'
searchBar.append(siteSearch, statusFilter, resultsNote)
sitesEl.before(searchBar)
const preferenceKey = 'argus-sites-layout-v1'
let preferences = {}
try { preferences = JSON.parse(localStorage.getItem(preferenceKey) || '{}') || {} } catch {}
if (typeof preferences !== 'object' || Array.isArray(preferences)) preferences = {}
const collapsed = new Set(Array.isArray(preferences.collapsed) ? preferences.collapsed.filter((s) => typeof s === 'string') : [])
siteSearch.value = typeof preferences.search === 'string' ? preferences.search : ''
statusFilter.value = ['online', 'partial', 'connecting', 'offline'].includes(preferences.status) ? preferences.status : ''
const main = document.querySelector('.st-main')
let restoreScroll = true
let renderedSignature = ''
function savePreferences() {
  try { localStorage.setItem(preferenceKey, JSON.stringify({ search: siteSearch.value, status: statusFilter.value, collapsed: [...collapsed], scroll: main.scrollTop })) } catch {}
}
siteSearch.addEventListener('input', () => { render(); savePreferences() })
statusFilter.addEventListener('change', () => { render(); savePreferences() })
main.addEventListener('scroll', savePreferences, { passive: true })
document.addEventListener('click', (e) => {
  for (const menu of sitesEl.querySelectorAll('details[open]')) if (!menu.contains(e.target)) menu.open = false
})

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  if (res.status === 401) location.href = '/login.html'
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`)
    err.status = res.status
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
  $('st-site-count').textContent = new Set(nvrList.map((n) => n.site || 'Unassigned')).size
  $('st-nvr-count').textContent = nvrList.length
  $('st-online-count').textContent = nvrList.filter((n) => connectionState(n).key === 'online').length
  $('st-camera-count').textContent = nvrList.reduce((sum, n) => sum + (Number(n.cameras) || 0), 0)
  if (sitesEl.contains(document.activeElement) || sitesEl.querySelector('details[open]')) return
  const signature = JSON.stringify([nvrList, siteSearch.value, statusFilter.value])
  if (signature === renderedSignature) return
  renderedSignature = signature
  const scroll = main.scrollTop
  if (nvrList.length === 0) {
    resultsNote.textContent = '0 NVRs'
    sitesEl.replaceChildren(el('p', { className: 'st-empty', textContent: 'No NVRs yet. Click “+ Add NVR” to add the first one.' }))
    return
  }
  // a camera dropdown open means its editor is mounted inside it; a full re-render (the 5 s poll)
  // would tear it out, so hold off until every dropdown is closed again
  if (sitesEl.querySelector('details[open]')) return
  // one block per site: a heading that sums the site up, then one row per NVR
  const query = siteSearch.value.trim().toLocaleLowerCase()
  const matches = nvrList.filter((n) => matchesNvr(n, query, statusFilter.value))
  resultsNote.textContent = `${matches.length} of ${nvrList.length} NVRs`
  if (!matches.length) { sitesEl.replaceChildren(el('p', { className: 'st-empty', textContent: 'No matching sites or NVRs' })); return }
  const bySite = Map.groupBy(matches, (n) => n.site || 'Unassigned')
  const groups = [...bySite].sort(([a], [b]) => a.localeCompare(b)).map(([site, list]) => {
    const rename = el('button', { type: 'button', className: 'btn-ghost st-site-rename', title: `Rename ${site}` })
    rename.textContent = 'Rename'
    rename.setAttribute('aria-label', `Rename ${site}`)
    rename.addEventListener('click', () => renameSite(site, nvrList.filter((n) => (n.site || 'Unassigned') === site)))
    const cams = list.reduce((t, n) => t + (n.cameras ?? 0), 0)
    const camsUp = list.reduce((t, n) => t + (['online', 'partial'].includes(connectionState(n).key) ? n.camerasOnline ?? 0 : 0), 0)
    const down = list.filter((n) => !['online', 'partial'].includes(connectionState(n).key)).length
    const summary = `${list.length} NVR${list.length === 1 ? '' : 's'} · ${camsUp} of ${cams} cameras reported online${down ? ` · ${down} NVR${down === 1 ? '' : 's'} not connected` : ''}`
    const rows = list.flatMap((n) => {
      const previous = [...sitesEl.querySelectorAll('.st-nvr')].find((row) => row.dataset.nvrId === n.id)
      const rowSignature = JSON.stringify(n)
      if (previous?.dataset.signature === rowSignature) return [previous, camerasPanel(n)]
      const edit = el('button', { type: 'button', textContent: 'Edit' })
      edit.addEventListener('click', () => openForm(nvrList.find((item) => item.id === n.id) || n))
      const remove = el('button', { type: 'button', className: 'btn-ghost st-row-remove', textContent: 'Remove', title: `Remove ${n.name}` })
      remove.addEventListener('click', () => removeNvr(n))
      let subs = null
      if (n.status === 'online') {
        subs = el('button', { type: 'button', textContent: 'Sub-streams' })
        subs.addEventListener('click', () => openSubstreams(n))
      }
      const state = connectionState(n)
      const online = state.key === 'online' || state.key === 'partial'
      const actions = el('details', { className: 'st-nvr-actions' })
      const summaryAction = el('summary', { title: `Actions for ${n.name}` })
      summaryAction.innerHTML = icon('more')
      summaryAction.setAttribute('aria-label', `Actions for ${n.name}`)
      const menu = el('div', { className: 'st-action-menu' }, subs, remove)
      actions.append(summaryAction, menu)
      actions.addEventListener('keydown', (e) => { if (e.key === 'Escape') { actions.open = false; summaryAction.focus() } })
      menu.addEventListener('click', () => { actions.open = false })
      const pct = online && n.cameras ? Math.round((100 * (n.camerasOnline ?? 0)) / n.cameras) : 0
      const problem = n.vpnSite && !n.vpnSite.connected
        ? `VPN tunnel to ${n.vpnSite.name}: ${tunnelText(n.vpnSite)}`
        : !online && n.error ? n.error : ''
      const note = subStreamNote(n.subStreamsSeen)
      const diagnostics = problem || note ? el('details', { className: 'st-diagnostics' }, el('summary', { textContent: 'Details' }), problem ? el('p', { className: 'st-error-text', textContent: problem }) : null, note) : null
      const row = el(
        'div',
        { className: `st-nvr st-nvr-${state.key}` },
        el('span', { className: `st-dot st-${state.key}`, title: state.text, ariaHidden: 'true' }),
        el('div', { className: 'st-nvr-main' },
          el('div', { className: 'st-nvr-name', textContent: n.name }),
          el('div', { className: 'st-meta', textContent: n.model || 'NVR' }), diagnostics),
        el('div', { className: 'st-connection' }, el('span', { textContent: n.via === 'p2p' ? 'P2P cloud' : n.vpnSite ? 'VPN' : 'IP / LAN' }), el('span', { className: 'st-meta', textContent: whereText(n) })),
        el('div', { className: 'st-nvr-cams' },
          el('span', { textContent: online ? `${n.camerasOnline ?? 0} / ${n.cameras ?? 0} cameras` : `${n.cameras ?? 0} cameras` }),
          online && n.cameras > (n.camerasOnline ?? 0) ? el('span', { className: 'st-warn-text', textContent: `${n.cameras - (n.camerasOnline ?? 0)} not reported online` }) : null,
          online ? el('span', { className: 'st-bar' }, el('span', { style: `width:${pct}%` })) : null),
        el('div', { className: 'st-state' }, el('span', { className: `st-status-label st-${state.key}`, textContent: state.text }), el('span', { className: 'st-meta', textContent: state.detail })),
        el('div', { className: 'st-direct-actions' }, edit, actions)
      )
      row.dataset.nvrId = n.id
      row.dataset.signature = rowSignature
      return [row, camerasPanel(n)]
    })
    const body = el('div', { className: 'st-nvrs' }, el('div', { className: 'st-columns', ariaHidden: 'true' }, el('span'), el('span', { textContent: 'NVR' }), el('span', { textContent: 'Connection' }), el('span', { textContent: 'Cameras' }), el('span', { textContent: 'Status' }), el('span', { textContent: 'Actions' })), ...rows)
    body.hidden = collapsed.has(site)
    const toggle = el('button', { type: 'button', className: 'st-site-toggle', textContent: `${body.hidden ? '+' : '-'} ${site}` })
    toggle.setAttribute('aria-expanded', String(!body.hidden))
    toggle.addEventListener('click', () => {
      body.hidden = !body.hidden
      body.hidden ? collapsed.add(site) : collapsed.delete(site)
      toggle.textContent = `${body.hidden ? '+' : '-'} ${site}`
      toggle.setAttribute('aria-expanded', String(!body.hidden))
      savePreferences()
    })
    return el(
      'section',
      { className: 'st-site' },
      el('div', { className: 'st-site-head' }, el('div', {}, el('h2', {}, toggle), el('p', { className: 'st-meta', textContent: summary })), rename), body
    )
  })
  sitesEl.replaceChildren(...groups)
  main.scrollTop = restoreScroll && Number.isFinite(preferences.scroll) ? preferences.scroll : scroll
  restoreScroll = false
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

async function load() {
  sitesEl.setAttribute('aria-busy', 'true')
  try {
    ;[nvrList, vpn] = await Promise.all([api('GET', '/api/admin/nvrs'), api('GET', '/api/admin/vpn').catch(() => ({ available: false, sites: [] }))])
    notice.hidden = true
    renderVpn()
    render()
    $('siteNames').replaceChildren(...[...new Set(nvrList.map((n) => n.site))].map((s) => el('option', { value: s })))
  } catch (e) {
    const denied = e.status === 403
    notice.replaceChildren(document.createTextNode(denied ? 'You do not have permission to manage sites.' : `Could not refresh sites: ${e.message}`))
    if (!denied) {
      const retry = el('button', { type: 'button', textContent: 'Retry' })
      retry.addEventListener('click', () => { retry.disabled = true; void load() })
      notice.append(retry)
    }
    if (!nvrList.length) resultsNote.textContent = denied ? 'Access denied' : 'Sites unavailable'
    notice.hidden = false
  } finally {
    sitesEl.setAttribute('aria-busy', 'false')
  }
}

/** How an NVR is reached, for cards and messages. */
const whereText = (n) =>
  n.via === 'p2p' ? `P2P cloud · serial ${n.sn}` : n.vpnSite ? `${n.host} via VPN site ${n.vpnSite.name}` : `${n.host}:${n.port}`

/** "12 s", "4 min", "3 h", "2 days" */
const agoS = (s) => (s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`)
const tunnelText = (t) => (t.connected ? `connected (${agoS(t.lastHandshakeAgoS)} ago)` : t.lastHandshakeAgoS === null ? 'never connected' : `not connected — last seen ${agoS(t.lastHandshakeAgoS)} ago`)
const byP2p = () => $('f-via-p2p').checked

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

/** @param {object} [prefill] { host, port, name } from Find NVRs */
function openForm(nvr = null, prefill = {}) {
  editing = nvr?.id ?? null
  $('formTitle').textContent = nvr ? `Edit ${nvr.name}` : 'Add NVR'
  $('f-site').value = nvr?.site ?? prefill.site ?? nvrList[0]?.site ?? ''
  $('f-name').value = nvr?.name ?? prefill.name ?? `NVR ${nvrList.length + 1}`
  const p2p = nvr?.via === 'p2p'
  $(p2p ? 'f-via-p2p' : 'f-via-lan').checked = true
  $('f-host').value = p2p ? '' : nvr?.host ?? prefill.host ?? ''
  $('f-port').value = p2p ? 6036 : nvr?.port ?? prefill.port ?? 6036
  $('f-sn').value = nvr?.sn ?? ''
  $('f-nat').value = String(nvr?.nat === 1 ? 1 : 2) // default NAT 2.0
  $('f-remote').checked = nvr ? Boolean(nvr.remote) : Boolean(prefill.remote)
  showVia()
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

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const p2p = byP2p()
  const body = {
    site: $('f-site').value,
    name: $('f-name').value,
    user: $('f-user').value,
    remote: $('f-remote').checked,
    skipTest: $('f-skip').checked
  }
  // by serial number no address or port is sent (the server uses its P2P server); sn '' switches an
  // NVR back to its address
  if (p2p) Object.assign(body, { sn: $('f-sn').value.trim().toUpperCase(), nat: Number($('f-nat').value) === 1 ? 1 : 2 })
  else Object.assign(body, { sn: '', host: $('f-host').value, port: Number($('f-port').value) })
  if ($('f-password').value) body.password = $('f-password').value
  formError.hidden = true
  saveBtn.disabled = true
  // an unreachable address takes the SDK ~20 s (3 tries x 5 s) to give up on
  saveBtn.textContent = body.skipTest ? 'Saving…' : p2p ? 'Testing login through the P2P cloud (up to 40 s)…' : 'Testing login (up to 20 s)…'
  try {
    if (editing) await api('PUT', `/api/admin/nvrs/${encodeURIComponent(editing)}`, body)
    else await api('POST', '/api/admin/nvrs', body)
    dialog.close()
    await load()
    notify('NVR saved')
  } catch (err) {
    formError.textContent = err.testFailed
      ? `${err.message}. Check ${p2p ? 'the serial number and login, and that P2P is on in the NVR’s network settings' : 'the address, port and login'}, or tick “Save even if…” to save anyway.`
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

async function removeNvr(n) {
  if (!confirm(`Remove ${n.name} (${whereText(n)}) from site "${n.site}"?\n\nIts cameras disappear from the app. Nothing on the NVR itself is changed.`)) return
  try {
    await api('DELETE', `/api/admin/nvrs/${encodeURIComponent(n.id)}`)
    await load()
    notify('NVR removed')
  } catch (e) {
    notify(`Could not remove the NVR: ${e.message}`, { error: true })
  }
}

async function renameSite(site, list) {
  const name = prompt(`New name for site "${site}":`, site)?.trim()
  if (!name || name === site) return
  try {
    for (const n of list) await api('PUT', `/api/admin/nvrs/${encodeURIComponent(n.id)}`, { site: name })
    await load()
    notify('Site renamed')
  } catch (e) {
    notify(`Could not finish renaming the site: ${e.message}`, { error: true })
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
  notice.textContent = 'Only admins can manage NVRs and sites. Ask the owner to make your account an admin.'
  notice.hidden = false
} else {
  const se = $('settingsTab'); if (se) se.hidden = false
  await load()
  // show connection status as new NVRs log in
  setInterval(load, 5000)
}
