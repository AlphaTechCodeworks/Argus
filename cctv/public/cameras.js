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

const HEAD = ['NVR', 'Site', 'Ch', 'Camera', 'Online', 'IP', 'Make', 'Model', 'Main', 'Sub', 'Codec', 'Rec', 'PoE']

/** Flattens the report to display rows; each keeps a lower-cased search blob. */
function flatten(report) {
  const rows = []
  for (const n of report.nvrs ?? []) {
    const cams = (n.cameras ?? []).slice().sort((a, b) => (a.ch ?? 0) - (b.ch ?? 0))
    if (cams.length === 0) {
      const why = n.nvrOnline ? n.error || 'no cameras returned' : 'offline — no cameras listed'
      rows.push({ offline: true, cells: [n.nvrName || n.nvr, n.site || '', '', `(${why})`, '', '', '', '', '', '', '', '', ''], blob: `${n.nvrName} ${n.site} ${why}`.toLowerCase() })
      continue
    }
    for (const c of cams) {
      const main = c.mainRes ? (c.mainFps ? `${c.mainRes} @${c.mainFps}` : c.mainRes) : ''
      const sub = c.subRes ? (c.subFps ? `${c.subRes} @${c.subFps}` : c.subRes) : ''
      rows.push({
        offline: false,
        camOffline: !c.online,
        cells: [n.nvrName || n.nvr, n.site || '', c.ch, c.name || '', c.online ? 'Yes' : 'No', c.ip || '', c.maker || '', c.model || '', main, sub, (c.subCodec || '').toUpperCase(), c.recStatus || '', c.poe ? 'Yes' : 'No'],
        blob: `${n.nvrName} ${n.site} ${c.name} ${c.ip} ${c.maker} ${c.model} ${c.recStatus}`.toLowerCase()
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
      const td = el('td', i === 2 || i === 4 || i === 12 ? 'cm-mid' : '')
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
let lastBody = null // the last report, for the optimiser's NVR list

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
  lastBody = body
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

// ---- optimise codecs: bulk H.265 + VBR (POST /api/admin/nvrs/:id/streams/optimise) ----
const btn = (text, onClick) => {
  const b = el('button', '', text)
  b.type = 'button'
  b.style.marginRight = '8px'
  b.style.marginTop = '10px'
  b.addEventListener('click', onClick)
  return b
}
const optClear = () => {
  $('cmOptPanel').hidden = true
  $('cmOptPanel').replaceChildren()
}
async function optPost(nvrId, confirm) {
  const res = await fetch(`/api/admin/nvrs/${encodeURIComponent(nvrId)}/streams/optimise`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(confirm ? { confirm: true } : {})
  }).catch(() => null)
  const body = await res?.json().catch(() => null)
  return { ok: Boolean(res?.ok), body }
}
function optTable(head, rows) {
  const t = el('table', 'al-table rp-table')
  const thead = el('thead')
  const htr = el('tr')
  for (const h of head) htr.append(el('th', '', h))
  thead.append(htr)
  const tb = el('tbody')
  for (const r of rows) {
    const tr = el('tr')
    for (const c of r) tr.append(el('td', '', c == null ? '' : String(c)))
    tb.append(tr)
  }
  t.append(thead, tb)
  return t
}
async function startOptimise() {
  const panel = $('cmOptPanel')
  const online = (lastBody?.nvrs ?? []).filter((n) => n.nvrOnline)
  panel.hidden = false
  if (!online.length) {
    panel.replaceChildren(el('p', 'hp-note', 'No NVRs are online to optimise.'))
    return
  }
  $('cmOptimise').disabled = true
  panel.replaceChildren(el('p', 'hp-note', `Planning H.265 + VBR changes across ${online.length} NVR${online.length === 1 ? '' : 's'}… (reading each camera's encoder settings)`))
  const plans = []
  for (const n of online) {
    const { ok, body } = await optPost(n.nvr, false)
    if (ok && Array.isArray(body?.cameras)) {
      const cams = body.cameras.filter((c) => Array.isArray(c.moves) && c.moves.length)
      if (cams.length) plans.push({ nvr: n.nvr, name: n.nvrName || n.nvr, cams })
    }
  }
  $('cmOptimise').disabled = false
  renderPlan(plans)
}
function renderPlan(plans) {
  const panel = $('cmOptPanel')
  const total = plans.reduce((t, p) => t + p.cams.length, 0)
  const box = el('section', 'se-section')
  box.append(el('h2', '', 'Optimise codecs to H.265 + VBR'))
  if (total === 0) {
    box.append(el('p', 'hp-note', "Nothing to change — every online camera is already on H.265/H.265+ (and VBR), or can't be upgraded."))
    box.append(btn('Close', optClear))
    panel.replaceChildren(box)
    return
  }
  const count = (pred) => plans.reduce((t, p) => t + p.cams.filter((c) => c.moves.some(pred)).length, 0)
  const h264 = count((m) => m.startsWith('enct h264'))
  const cbr = count((m) => m.startsWith('bitType CBR'))
  box.append(el('p', 'st-help', `${total} camera${total === 1 ? '' : 's'} across ${plans.length} NVR${plans.length === 1 ? '' : 's'} would change (H.264→H.265: ${h264}, CBR→VBR: ${cbr}). The bitrate cap and picture quality are kept — these only save space. Each camera's encoder restarts briefly (a few seconds without video/recording). Already-optimal and H.265+ cameras are left alone.`))
  box.append(optTable(['NVR', 'Ch', 'Camera', 'Change'], plans.flatMap((p) => p.cams.map((c) => [p.name, c.ch, c.name, c.moves.join(', ')]))))
  box.append(btn(`Apply to ${total} camera${total === 1 ? '' : 's'}`, () => applyPlan(plans)), btn('Cancel', optClear))
  panel.replaceChildren(box)
}
async function applyPlan(plans) {
  const panel = $('cmOptPanel')
  panel.replaceChildren(el('p', 'hp-note', 'Applying, one camera at a time… (this can take a while)'))
  const results = []
  for (const p of plans) {
    const { ok, body } = await optPost(p.nvr, true)
    if (ok && Array.isArray(body?.results)) for (const r of body.results) results.push({ nvr: p.name, ...r })
    else results.push({ nvr: p.name, status: 'failed', message: body?.error || 'request failed' })
  }
  const done = results.filter((r) => r.status === 'done').length
  const notDone = results.filter((r) => r.status !== 'done' && r.status !== 'skipped')
  const box = el('section', 'se-section')
  box.append(el('h2', '', 'Optimise results'))
  box.append(el('p', 'st-help', `${done} applied${notDone.length ? `, ${notDone.length} did not take` : ''}. Press Refresh to see the new settings. Any change can be undone from the camera's stream settings.`))
  if (notDone.length) box.append(optTable(['NVR', 'Ch', 'Camera', 'Result'], notDone.map((r) => [r.nvr, r.ch, r.name, r.message || r.status])))
  box.append(btn('Close & refresh', () => { optClear(); load({ fresh: false }) }))
  panel.replaceChildren(box)
}
$('cmOptimise').addEventListener('click', startOptimise)

load()
