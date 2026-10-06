// Cameras report page: the live per-camera inventory (GET /api/admin/cameras, camera-export.mjs),
// with a text filter, a Refresh that forces a new read, and an Excel download. Admins only -- a
// viewer who reaches the page gets the API's 403 and a message. Built with DOM calls; names and
// addresses come from the NVRs.
const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const ENCT = { h264: 'H.264', h264p: 'H.264+', h264s: 'H.264 Smart', h265: 'H.265', h265p: 'H.265+', h265s: 'H.265 Smart' }
const enctLabel = (e) => (e ? ENCT[e] ?? String(e).toUpperCase() : '')
const yesNoBlank = (v) => (v == null ? '' : v ? 'Yes' : 'No')

const HEAD = ['NVR', 'Site', 'Ch', 'Camera', 'Online', 'IP', 'Make', 'Model', 'Main', 'Main codec', 'Bitrate', 'H.265+?', 'Sub', 'Codec', 'Rec', 'PoE']

/** Flattens the report to display rows; each keeps a lower-cased search blob. */
function flatten(report) {
  const rows = []
  for (const n of report.nvrs ?? []) {
    const cams = (n.cameras ?? []).slice().sort((a, b) => (a.ch ?? 0) - (b.ch ?? 0))
    if (cams.length === 0) {
      const why = n.nvrOnline ? n.error || 'no cameras returned' : 'offline — no cameras listed'
      rows.push({ offline: true, cells: [n.nvrName || n.nvr, n.site || '', '', `(${why})`, '', '', '', '', '', '', '', '', '', '', '', ''], blob: `${n.nvrName} ${n.site} ${why}`.toLowerCase() })
      continue
    }
    for (const c of cams) {
      const main = c.mainRes ? (c.mainFps ? `${c.mainRes} @${c.mainFps}` : c.mainRes) : ''
      const sub = c.subRes ? (c.subFps ? `${c.subRes} @${c.subFps}` : c.subRes) : ''
      rows.push({
        offline: false,
        camOffline: !c.online,
        cells: [n.nvrName || n.nvr, n.site || '', c.ch, c.name || '', c.online ? 'Yes' : 'No', c.ip || '', c.maker || '', c.model || '', main, enctLabel(c.mainEnct), c.mainBitType || '', yesNoBlank(c.h265pCapable), sub, (c.subCodec || '').toUpperCase(), c.recStatus || '', c.poe ? 'Yes' : 'No'],
        blob: `${n.nvrName} ${n.site} ${c.name} ${c.ip} ${c.maker} ${c.model} ${c.recStatus} ${c.mainEnct || ''} ${c.mainBitType || ''}`.toLowerCase()
      })
    }
  }
  return rows
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
    const tr = el('tr', r.offline ? 'cm-off' : r.camOffline ? 'cm-camoff' : '')
    r.cells.forEach((cell, i) => {
      const td = el('td', i === 2 || i === 4 || i === 11 || i === 15 ? 'cm-mid' : '')
      td.textContent = cell === null || cell === undefined ? '' : String(cell)
      tr.append(td)
    })
    tb.append(tr)
  }
  t.append(tb)
  $('cmTable').replaceChildren(t)
  return shown.length
}

let rows = []
let lastTotal = 0

async function load({ fresh = false } = {}) {
  $('cmStatus').hidden = false
  $('cmStatus').textContent = fresh ? 'Reading every NVR…' : 'Loading the cameras…'
  $('cmRefresh').disabled = true
  const res = await fetch(`/api/admin/cameras${fresh ? '?fresh=1' : ''}`).catch(() => null)
  $('cmRefresh').disabled = false
  if (res && res.status === 403) {
    $('cmStatus').textContent = 'This report is for admins only.'
    return
  }
  const body = await res?.json().catch(() => null)
  if (!res?.ok || !body?.nvrs) {
    $('cmStatus').textContent = body?.error ?? 'The report could not be loaded.'
    return
  }
  rows = flatten(body)
  const cams = rows.filter((r) => !r.offline).length
  const online = (body.nvrs ?? []).filter((n) => n.nvrOnline).length
  const when = body.at ? new Date(body.at).toLocaleString('en-GB') : ''
  lastTotal = render(rows, $('cmFilter').value)
  $('cmStatus').hidden = true
  $('cmTitle').textContent = `Cameras — ${cams} across ${online} online NVR${online === 1 ? '' : 's'}`
  $('cmSub')?.remove()
  const sub = el('p', 'hp-note')
  sub.id = 'cmSub'
  sub.textContent = body.cached
    ? `As of ${when} (the nightly snapshot). Press Refresh to read every NVR now.`
    : `Read every NVR just now — ${when}.`
  $('cmTitle').after(sub)
}

$('cmFilter').addEventListener('input', () => {
  const shown = render(rows, $('cmFilter').value)
  if (shown !== lastTotal || $('cmFilter').value) $('cmStatus').hidden = true
})
$('cmRefresh').addEventListener('click', () => load({ fresh: true }))
$('cmXlsx').addEventListener('click', () => {
  window.location = '/api/admin/cameras.xlsx'
})

load()
