// NVR register page: one row per NVR with its site, connection, live status, camera counts and the
// login username the app uses (GET /api/admin/register, register.mjs). Admins only. Built live each
// time, so it is always current; Refresh re-reads, and Download Excel saves it. Passwords are not
// shown here.
const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const HEAD = ['Site', 'NVR', 'Connection', 'Status', 'Cameras', 'Login user', 'Model', 'NVR serial']

function connectionOf(n) {
  return n.sn ? `P2P serial ${n.sn}${Number(n.nat) === 1 ? ' (NAT 1.0)' : ''}` : `${n.host || ''}${n.port ? `:${n.port}` : ''}`
}

function flatten(list) {
  return list.map((n) => ({
    online: n.status === 'online',
    blob: `${n.site} ${n.name} ${n.sn} ${n.host} ${n.user} ${n.model} ${n.serial}`.toLowerCase(),
    cells: [n.site || '', n.name || '', connectionOf(n), n.status || '', `${n.camerasOnline} / ${n.cameras}`, n.user || '', n.model || '', n.serial || '']
  }))
}

function render(rows, filter) {
  const q = filter.trim().toLowerCase()
  const shown = q ? rows.filter((r) => r.blob.includes(q)) : rows
  const t = el('table', 'al-table rp-table')
  const thead = el('thead')
  const htr = el('tr')
  for (const h of HEAD) htr.append(el('th', '', h))
  thead.append(htr)
  t.append(thead)
  const tb = el('tbody')
  for (const r of shown) {
    const tr = el('tr', r.online ? '' : 'cm-off')
    r.cells.forEach((cell, i) => {
      const td = el('td', i === 4 ? 'cm-mid' : '')
      td.textContent = cell == null ? '' : String(cell)
      tr.append(td)
    })
    tb.append(tr)
  }
  t.append(tb)
  $('rgTable').replaceChildren(t)
  return shown.length
}

let rows = []

async function load() {
  $('rgStatus').hidden = false
  $('rgStatus').textContent = 'Loading the register…'
  $('rgRefresh').disabled = true
  const res = await fetch('/api/admin/register').catch(() => null)
  $('rgRefresh').disabled = false
  if (res && res.status === 403) {
    $('rgStatus').textContent = 'This register is for admins only.'
    return
  }
  const body = await res?.json().catch(() => null)
  if (!res?.ok || !body?.nvrs) {
    $('rgStatus').textContent = body?.error ?? 'The register could not be loaded.'
    return
  }
  rows = flatten(body.nvrs)
  const online = body.nvrs.filter((n) => n.status === 'online').length
  render(rows, $('rgFilter').value)
  $('rgStatus').hidden = true
  $('rgTitle').textContent = `NVR register — ${online} of ${body.nvrs.length} connected`
}

$('rgFilter').addEventListener('input', () => render(rows, $('rgFilter').value))
$('rgRefresh').addEventListener('click', load)
$('rgXlsx').addEventListener('click', () => {
  window.location = '/api/admin/register.xlsx'
})

load()
