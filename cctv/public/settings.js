// Settings page (admins only): recording, memory/thumbnails, storage locations, preparing a USB
// drive. The server checks every value again (settings.mjs, storage.mjs, disks.mjs).
const $ = (id) => document.getElementById(id)
const notice = $('notice')

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  if (res.status === 401) location.href = '/login.html'
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  Object.assign(node, props)
  node.append(...children.filter((c) => c !== null && c !== undefined))
  return node
}
const option = (value, text, selected) => el('option', { value, textContent: text, selected })
const say = (id, text, bad = false) => {
  $(id).textContent = text
  $(id).className = bad ? 'st-error' : 'st-meta'
}

const MODE_TEXT = { off: 'Off', continuous: '24/7', motion: 'Motion only', ai: 'AI events only', 'ai-or-motion': 'AI where supported, else motion' }
const AFTER_TEXT = { timelapse: 'Time-lapse + event clips', keep: 'Keep everything', delete: 'Delete' }
/** GET /api/admin/settings `memory`: the RAM each "recent footage" choice needs (rec-cache.mjs), or null. */
let memory = null
const ramSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : '< 1 MB')
const RECENT_TEXT = (m) => {
  if (m === 0) return 'Off'
  const b = memory?.measured ? memory.byMinutes?.[m] : null
  return Number.isFinite(b) ? `${m} min (≈ ${ramSize(b)})` : `${m} min`
}
/** The line under the choices: where the RAM goes, what the server has, what the figures leave out. */
function ramLine() {
  const avail = memory?.memAvailableBytes
  let t = `Held in the system's file cache, not by the app${Number.isFinite(avail) ? `; this server has ${ramSize(avail)} available` : ''}.`
  if (memory && !memory.cameras) t += ' No camera records to the server yet.'
  else if (memory && memory.measured < memory.cameras) {
    const n = memory.cameras - memory.measured
    t += ` ${n} of ${memory.cameras} recording cameras ${n === 1 ? 'has' : 'have'} no recordings yet and ${n === 1 ? 'is' : 'are'} left out of the figures.`
  }
  return t
}
const THUMB_TEXT = { off: 'Off', '1m': 'One per minute', '5m': 'One per 5 minutes' }
const REC_FIELDS = ['fullDays', 'timelapseS', 'retentionDays', 'preS', 'postS']

let settings = null
let choices = null
let cameras = []
let locations = []
const camEdits = new Map() // "<nvr>/<ch>" -> patch

const gb = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${(b / 1e9).toFixed(1)} GB`)

// ---- recording ----------------------------------------------------------------------------------

function renderDefaults() {
  const d = settings.recording.defaults
  $('d-mode').replaceChildren(...choices.modes.map((m) => option(m, MODE_TEXT[m] ?? m, m === d.mode)))
  $('d-after').replaceChildren(...choices.after.map((a) => option(a, AFTER_TEXT[a] ?? a, a === d.after)))
  for (const k of REC_FIELDS) $(`d-${k}`).value = d[k]
}

$('defaults').addEventListener('submit', async (e) => {
  e.preventDefault()
  const defaults = { mode: $('d-mode').value, after: $('d-after').value }
  for (const k of REC_FIELDS) defaults[k] = Number($(`d-${k}`).value)
  try {
    settings = (await api('POST', '/api/admin/settings', { recording: { defaults } })).settings
    say('d-msg', 'Saved')
    render()
    refreshRam() // which cameras record may have changed
  } catch (err) {
    say('d-msg', err.message, true)
  }
})

function camSelect(list, texts, value, dflt, onChange) {
  const s = el('select', {}, option('', `Default (${texts[dflt] ?? dflt})`, value === undefined), ...list.map((v) => option(v, texts[v] ?? v, v === value)))
  s.addEventListener('change', () => onChange(s.value === '' ? null : s.value))
  return s
}
function camNumber(value, dflt, max, onChange) {
  const i = el('input', { type: 'number', min: 1, max, value: value ?? '', placeholder: String(dflt), className: 'se-num' })
  i.addEventListener('input', () => onChange(i.value === '' ? null : Number(i.value)))
  return i
}

function renderCameras() {
  const d = settings.recording.defaults
  const body = $('cams').tBodies[0]
  if (!cameras.length) {
    body.replaceChildren(el('tr', {}, el('td', { colSpan: 6, className: 'st-meta', textContent: 'No cameras (no NVR online yet).' })))
    return
  }
  body.replaceChildren(
    ...cameras.map((c) => {
      const key = `${c.nvr}/${c.ch}`
      const o = settings.recording.cameras[key] ?? {}
      const edit = (field) => (v) => {
        const p = camEdits.get(key) ?? {}
        p[field] = v
        camEdits.set(key, p)
        $('saveCams').disabled = false
      }
      const locSel = el(
        'select',
        {},
        option('', 'Automatic', !o.locationId),
        ...locations.filter((l) => l.role !== 'archive').map((l) => option(l.id, `${l.path} (${l.role})`, l.id === o.locationId))
      )
      locSel.addEventListener('change', () => edit('locationId')(locSel.value || null))
      return el(
        'tr',
        {},
        el('td', {}, el('div', { textContent: c.name }), el('div', { className: 'st-meta', textContent: `${c.site} · ${c.nvrName} · ch ${c.ch + 1}` })),
        el('td', {}, camSelect(choices.modes, MODE_TEXT, o.mode, d.mode, edit('mode'))),
        el('td', {}, camNumber(o.fullDays, d.fullDays, choices.maxRetentionDays, edit('fullDays'))),
        el('td', {}, camSelect(choices.after, AFTER_TEXT, o.after, d.after, edit('after'))),
        el('td', {}, camNumber(o.retentionDays, d.retentionDays, choices.maxRetentionDays, edit('retentionDays'))),
        el('td', {}, locSel)
      )
    })
  )
}

$('saveCams').addEventListener('click', async () => {
  if (!camEdits.size) return
  try {
    settings = (await api('POST', '/api/admin/settings', { recording: { cameras: Object.fromEntries(camEdits) } })).settings
    camEdits.clear()
    $('saveCams').disabled = true
    say('c-msg', 'Saved')
    render()
    refreshRam()
  } catch (err) {
    say('c-msg', err.message, true)
  }
})

// ---- memory, thumbnails, free space ---------------------------------------------------------------

function renderMisc() {
  $('m-recent').replaceChildren(...choices.recentMinutes.map((m) => option(String(m), RECENT_TEXT(m), m === settings.memory.recentMinutes)))
  $('m-thumbs').replaceChildren(...choices.thumbnails.map((t) => option(t, THUMB_TEXT[t] ?? t, t === settings.thumbnails)))
  $('m-low').value = settings.storage.lowFreePct
  $('m-floor').value = settings.storage.floorFreePct
  renderRam()
}

/** The RAM figures only (option texts and the line): keeps whatever is selected. */
function renderRam() {
  for (const o of $('m-recent').options) o.textContent = RECENT_TEXT(Number(o.value))
  $('m-ram').textContent = ramLine()
  $('m-ram').hidden = false
}

/** Fresh RAM figures (they follow the recording cameras and what they have written). */
async function refreshRam() {
  try {
    memory = (await api('GET', '/api/admin/settings')).memory ?? null
    renderRam()
  } catch {} // the figures stay as they were
}

$('misc').addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    settings = (
      await api('POST', '/api/admin/settings', {
        memory: { recentMinutes: Number($('m-recent').value) },
        thumbnails: $('m-thumbs').value,
        storage: { lowFreePct: Number($('m-low').value), floorFreePct: Number($('m-floor').value) }
      })
    ).settings
    say('m-msg', 'Saved')
  } catch (err) {
    say('m-msg', err.message, true)
  }
})

// ---- storage locations --------------------------------------------------------------------------------

function renderLocations() {
  if (!locations.length) {
    $('locations').replaceChildren(el('p', { className: 'st-empty', textContent: 'No storage locations yet: nothing can be recorded. Add a folder below, or prepare a USB drive.' }))
    return
  }
  $('locations').replaceChildren(
    ...locations.map((l) => {
      const h = l.health
      const role = el('select', {}, ...['main', 'overflow', 'archive'].map((r) => option(r, r[0].toUpperCase() + r.slice(1), r === l.role)))
      role.addEventListener('change', () => locAction({ action: 'set', id: l.id, role: role.value }))
      const remove = el('button', { type: 'button', className: 'st-danger', textContent: 'Remove from list' })
      remove.addEventListener('click', () => {
        if (confirm(`Stop using ${l.path}? Recordings already there are left in place.`)) locAction({ action: 'remove', id: l.id })
      })
      const pct = h.totalBytes ? Math.round((h.freeBytes / h.totalBytes) * 100) : null
      return el(
        'article',
        { className: 'st-card' },
        el('div', { className: 'st-card-head' }, el('h3', { textContent: l.path }), el('span', { className: `st-status ${h.ok ? 'st-online' : 'st-offline'}`, textContent: h.ok ? 'OK' : 'Not usable' })),
        el('p', { className: 'st-meta', textContent: `${l.type} · ${l.id}${l.limitGB ? ` · limit ${l.limitGB} GB` : ''}` }),
        h.totalBytes ? el('p', { className: 'st-meta', textContent: `${gb(h.freeBytes)} free of ${gb(h.totalBytes)} (${pct}%)${h.writeMBps ? ` · writes ${h.writeMBps} MB/s` : ''}` }) : null,
        h.ok ? null : el('p', { className: 'st-error-text', textContent: h.reason }),
        l.sameDisk ? el('p', { className: 'st-warn-text', textContent: 'On the system disk: recordings could fill it.' }) : null,
        el('div', { className: 'st-card-actions' }, role, remove)
      )
    })
  )
}

async function locAction(body) {
  try {
    await api('POST', '/api/admin/storage', body)
    say('l-msg', '')
  } catch (err) {
    say('l-msg', err.message, true)
  }
  await loadStorage()
}

$('l-type').addEventListener('change', () => ($('l-same-row').hidden = $('l-type').value !== 'internal'))
$('addLoc').addEventListener('submit', async (e) => {
  e.preventDefault()
  const limit = $('l-limit').value
  await locAction({
    action: 'add',
    path: $('l-path').value.trim(),
    type: $('l-type').value,
    role: $('l-role').value,
    limitGB: limit === '' ? null : Number(limit),
    sameDisk: $('l-type').value === 'internal' && $('l-same').checked
  })
  if (!$('l-msg').textContent) $('addLoc').reset()
})

// ---- the folder browser for "Folder" (folders.mjs: /srv/cctv-rec, /mnt, /media only) ----
let folderAt = null // the folder shown (null: the list of roots)
async function showFolder(path) {
  $('f-error').hidden = true
  try {
    const r = await api('GET', `/api/admin/storage/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`)
    folderAt = r.path
    $('f-path').textContent = r.path ?? 'Places'
    $('f-up').disabled = r.path === null
    $('f-up').dataset.to = r.parent ?? ''
    $('f-select').disabled = r.path === null
    $('f-new').disabled = r.path === null
    $('f-name').disabled = r.path === null
    $('f-list').replaceChildren(
      ...(r.folders.length
        ? r.folders.map((f) => {
            const b = el('button', { type: 'button', className: 'se-folder', textContent: `${f.name}${f.recordings ? ' (recordings)' : ''}` })
            b.addEventListener('click', () => showFolder(f.path))
            const li = el('li', { role: 'option' }, b)
            return li
          })
        : [el('li', { className: 'st-meta', textContent: r.path === null ? 'None of /srv/cctv-rec, /mnt, /media exists.' : 'No folders here.' })])
    )
  } catch (err) {
    $('f-error').textContent = err.message
    $('f-error').hidden = false
  }
}
$('l-browse').addEventListener('click', () => {
  const typed = $('l-path').value.trim()
  showFolder(typed.startsWith('/') ? typed : '').then(() => {
    if (!$('f-error').hidden && typed) showFolder('') // the typed folder cannot be shown: start at the top
  })
  $('folders').showModal()
})
$('f-up').addEventListener('click', () => showFolder($('f-up').dataset.to || ''))
$('f-new').addEventListener('click', async () => {
  const name = $('f-name').value.trim()
  if (!folderAt || !name) return
  try {
    const r = await api('POST', '/api/admin/storage/folders', { path: folderAt, name })
    $('f-name').value = ''
    await showFolder(r.path)
  } catch (err) {
    $('f-error').textContent = err.message
    $('f-error').hidden = false
  }
})
$('f-select').addEventListener('click', () => {
  if (!folderAt) return
  $('l-path').value = folderAt
  $('folders').close()
})
$('f-cancel').addEventListener('click', () => $('folders').close())

async function loadStorage() {
  try {
    locations = (await api('GET', '/api/admin/storage')).locations
    renderLocations()
    if (!camEdits.size) renderCameras() // (never throws away unsaved camera changes)
  } catch (err) {
    say('l-msg', err.message, true)
  }
}

// ---- prepare a USB drive ----------------------------------------------------------------------------------

let prepDisk = null
let jobTimer = null

function renderDisks(list) {
  if (!list.length) {
    $('disks').replaceChildren(el('p', { className: 'st-empty', textContent: 'No drives found.' }))
    return
  }
  $('disks').replaceChildren(
    ...list.map((d) => {
      let go = null
      if (d.eligible) {
        go = el('button', { type: 'button', className: 'st-danger', textContent: 'Prepare…' })
        go.addEventListener('click', () => openPrep(d))
      }
      return el(
        'article',
        { className: 'st-card' },
        el('div', { className: 'st-card-head' }, el('h3', { textContent: `${d.model ?? 'Drive'} (${d.dev})` }), el('span', { className: 'st-meta', textContent: d.sizeBytes ? gb(d.sizeBytes) : '' })),
        el('p', { className: 'st-meta', textContent: `serial ${d.serial || '—'} · ${d.tran ?? '?'}` }),
        ...d.partitions.map((p) => el('p', { className: 'st-meta', textContent: `${p.dev}: ${p.fstype ?? 'unknown'}${p.label ? ` "${p.label}"` : ''}${p.sizeBytes ? `, ${gb(p.sizeBytes)}` : ''}${p.mountpoint ? `, mounted at ${p.mountpoint}` : ''}` })),
        d.eligible ? null : el('p', { className: 'st-warn-text', textContent: `Cannot be prepared: ${d.why}` }),
        go ? el('div', { className: 'st-card-actions' }, go) : null
      )
    })
  )
}

function renderJob(job) {
  const box = $('job')
  if (!job) {
    box.hidden = true
    return
  }
  box.hidden = false
  const title =
    job.state === 'running'
      ? `Preparing ${job.dev}…`
      : job.state === 'done'
        ? `${job.dev} is ready`
        : job.state === 'prepared'
          ? `${job.dev} was prepared, but not added`
          : `Preparing ${job.dev} failed`
  // a real progress bar over the helper's steps, then one line per step (its latest state)
  const STEP_NAMES = { check: 'Check the drive', wipe: 'Erase', partition: 'Partition', format: 'Format', mount: 'Mount', marker: 'Mark for recordings', done: 'Done' }
  const p = job.progress ?? { steps: Object.keys(STEP_NAMES), done: 0, of: 6, pct: 0, step: 'check' }
  const latest = new Map()
  for (const s of job.steps ?? []) latest.set(s.step, s)
  const stepState = (name, i) => {
    if (name === 'done') return job.state === 'done' ? 'done' : 'waiting'
    const s = latest.get(name)
    if (s?.state === 'failed') return 'failed'
    if (i < p.done || s?.state === 'done') return 'done'
    if (job.state === 'running' && name === p.step) return 'working'
    return 'waiting'
  }
  const bar = el('progress', { className: 'se-progress', max: 100, value: p.pct })
  bar.setAttribute('aria-label', `Preparing ${job.dev}: ${p.pct}%`)
  box.replaceChildren(
    el('h3', { textContent: title }),
    bar,
    el(
      'ul',
      { className: 'se-parts' },
      ...p.steps.map((name, i) => {
        const st = stepState(name, i)
        const msg = latest.get(name)?.message
        return el('li', { className: `st-step st-step-${st}`, textContent: `${STEP_NAMES[name] ?? name}${st === 'working' ? '…' : st === 'failed' ? ': failed' : ''}${msg ? ` — ${msg}` : ''}` })
      })
    ),
    job.state === 'failed' && job.error ? el('p', { className: 'st-error-text', textContent: job.error }) : null,
    job.state === 'prepared' && job.nextStep ? el('p', { className: 'st-warn-text', textContent: job.nextStep }) : null,
    job.location ? el('p', { className: 'st-meta', textContent: `Added as a storage location: ${job.location.path} (${job.location.role})` }) : null
  )
}

async function loadDisks() {
  say('u-msg', 'Looking…')
  try {
    const r = await api('GET', '/api/admin/disks')
    say('u-msg', r.error ?? '', Boolean(r.error))
    renderDisks(r.disks)
    renderJob(r.job)
    clearTimeout(jobTimer)
    if (r.job?.state === 'running') jobTimer = setTimeout(loadDisks, 1500)
    else if (r.job?.state === 'done') loadStorage()
  } catch (err) {
    say('u-msg', err.message, true)
  }
}
$('refreshDisks').addEventListener('click', loadDisks)

function openPrep(d) {
  prepDisk = d
  $('p-name').textContent = `${d.model ?? 'drive'} (${d.dev})`
  $('p-info').textContent = `${d.sizeBytes ? gb(d.sizeBytes) : ''} · ${d.tran ?? ''}`
  $('p-parts').replaceChildren(
    ...(d.partitions.length ? d.partitions.map((p) => el('li', { textContent: `${p.dev}: ${p.fstype ?? 'unknown'}${p.label ? ` "${p.label}"` : ''}${p.sizeBytes ? `, ${gb(p.sizeBytes)}` : ''} — will be erased` })) : [el('li', { textContent: 'No partitions.' })])
  )
  $('p-serial').textContent = d.serial
  $('p-typed').value = ''
  $('p-go').disabled = true
  $('p-error').hidden = true
  $('prep').showModal()
}
$('p-typed').addEventListener('input', () => ($('p-go').disabled = $('p-typed').value !== prepDisk?.serial))
$('p-cancel').addEventListener('click', () => $('prep').close())
$('prepForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  if (!prepDisk || $('p-typed').value !== prepDisk.serial) return
  $('p-go').disabled = true
  try {
    const r = await api('POST', '/api/admin/disks/prepare', { dev: prepDisk.dev, serial: $('p-typed').value, fs: $('p-fs').value })
    $('prep').close()
    renderJob(r.job)
    loadDisks()
  } catch (err) {
    $('p-error').textContent = err.message
    $('p-error').hidden = false
    $('p-go').disabled = false
  }
})

// ---- start ----------------------------------------------------------------------------------------------

function render() {
  renderDefaults()
  renderCameras()
  renderMisc()
}

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' })
  location.href = '/login.html'
})

const me = await fetch('/api/me').then((r) => (r.ok ? r.json() : null))
if (!me) location.href = '/login.html'
$('whoami').textContent = me.user
if (!me.admin) {
  notice.textContent = 'Only admins can change settings.'
  notice.hidden = false
  for (const s of document.querySelectorAll('.se-section')) s.hidden = true
} else {
  try {
    const [s, cams] = await Promise.all([api('GET', '/api/admin/settings'), api('GET', '/api/cameras')])
    settings = s.settings
    choices = s.choices
    memory = s.memory ?? null
    cameras = cams
    render()
    await loadStorage()
    await loadDisks()
    setInterval(() => {
      loadStorage()
      refreshRam()
    }, 30_000)
  } catch (err) {
    notice.textContent = `Could not load the settings: ${err.message}`
    notice.hidden = false
  }
}
