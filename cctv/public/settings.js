// Settings page (admins only): recording, memory/thumbnails, storage locations, preparing a USB
// drive, adding a network drive. The server checks every value again (settings.mjs, storage.mjs,
// disks.mjs, netshares.mjs). The NAS password is sent once and cleared: the page never keeps it,
// and no answer from the server ever contains it.
import { DEFAULT_OSD, OSD_CORNERS, cleanOsdSettings, cornerOf, drawOsd, osdFont, osdLayout } from './osd-overlay.js'
import { locationEdit } from './storage.js'

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

/**
 * Asks before a storage location or share is removed. When it is the only place recordings go, a
 * click on OK is not enough: REMOVE must be typed. On 2026-09-26 the only location, the NAS, was
 * removed with one confirm, and the server recorded nothing to disk for hours.
 */
function sureToRemove(what, onlyOne, note) {
  if (!onlyOne) return confirm(`Remove ${what}?

${note}`)
  const typed = prompt(`${what} is the ONLY place recordings go. Removing it stops the server recording to disk until another is added.

${note}

Type REMOVE to go ahead.`, '')
  return typed?.trim().toUpperCase() === 'REMOVE'
}
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

// Grouped by NVR, each group folded until opened: a site with a hundred cameras is a hundred rows,
// and almost all of them just use the defaults. The header of each group says how many do not.
const openGroups = new Set()
const setDifferently = (key) => Object.values(settings.recording.cameras?.[key] ?? {}).some((v) => v !== null && v !== undefined && v !== '') || camEdits.has(key)

function renderCameras() {
  const d = settings.recording.defaults
  const table = $('cams')
  for (const b of [...table.tBodies]) b.remove()
  if (!cameras.length) {
    table.append(el('tbody', {}, el('tr', {}, el('td', { colSpan: 6, className: 'st-meta', textContent: 'No cameras (no NVR online yet).' }))))
    return
  }
  const q = $('camSearch').value.trim().toLowerCase()
  const onlyChanged = $('camChanged').checked
  const shown = cameras.filter((c) => (!q || `${c.name} ${c.nvrName} ${c.site}`.toLowerCase().includes(q)) && (!onlyChanged || setDifferently(`${c.nvr}/${c.ch}`)))
  if (!shown.length) {
    table.append(el('tbody', {}, el('tr', {}, el('td', { colSpan: 6, className: 'st-meta', textContent: onlyChanged ? 'Every camera uses the defaults.' : 'No camera matches.' }))))
    return
  }
  for (const [nvr, list] of Map.groupBy(shown, (c) => c.nvr)) {
    const all = cameras.filter((c) => c.nvr === nvr)
    const changed = all.filter((c) => setDifferently(`${c.nvr}/${c.ch}`)).length
    // a search or the "set differently" filter opens what it found
    const open = openGroups.has(nvr) || Boolean(q) || onlyChanged
    const btn = el('button', { type: 'button', className: 'se-cam-toggle' },
      el('span', { className: 'se-caret', textContent: open ? '▾' : '▸' }),
      el('strong', { textContent: list[0].nvrName }),
      el('span', { className: 'st-meta', textContent: ` ${list[0].site} · ${all.length} camera${all.length === 1 ? '' : 's'}${changed ? ` · ${changed} set differently` : ' · all on the defaults'}` }))
    btn.setAttribute('aria-expanded', String(open))
    btn.addEventListener('click', () => {
      if (openGroups.has(nvr)) openGroups.delete(nvr)
      else openGroups.add(nvr)
      renderCameras()
    })
    const body = el('tbody', {}, el('tr', { className: 'se-cam-group' }, el('td', { colSpan: 6 }, btn)))
    if (open) body.append(...camRows(list, d))
    table.append(body)
  }
}
$('camSearch').addEventListener('input', () => renderCameras())
$('camChanged').addEventListener('change', () => renderCameras())

function camRows(list, d) {
  return list.map((c) => {
      const key = `${c.nvr}/${c.ch}`
      const o = settings.recording.cameras?.[key] ?? {}
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
        el('td', { className: 'se-cam-name' }, el('span', { className: 'st-meta', textContent: `${c.ch + 1}` }), ` ${c.name}`),
        el('td', {}, camSelect(choices.modes, MODE_TEXT, o.mode, d.mode, edit('mode'))),
        el('td', {}, camNumber(o.fullDays, d.fullDays, choices.maxRetentionDays, edit('fullDays'))),
        el('td', {}, camSelect(choices.after, AFTER_TEXT, o.after, d.after, edit('after'))),
        el('td', {}, camNumber(o.retentionDays, d.retentionDays, choices.maxRetentionDays, edit('retentionDays'))),
        el('td', {}, locSel)
      )
  })
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

// A location's space limit and own free-space marks, as typed and not saved yet: the cards are rebuilt
// every 30 s (loadStorage), and that must not throw away what an admin is typing.
const locEdits = new Map() // id -> { limitGB, lowFreePct, floorFreePct } (the inputs' text)
let locNote = null // { id, text, bad }: the last save's answer, shown on its card

/** The card's form: the limit (enforced) and the marks, empty for none / the default. */
function locationForm(l) {
  const typed = locEdits.get(l.id) ?? { limitGB: l.limitGB ?? '', lowFreePct: l.lowFreePct ?? '', floorFreePct: l.floorFreePct ?? '' }
  const input = (key, attrs) => {
    const i = el('input', { type: 'number', value: String(typed[key]), ...attrs })
    i.addEventListener('input', () => locEdits.set(l.id, { ...(locEdits.get(l.id) ?? typed), [key]: i.value }))
    return i
  }
  const limit = input('limitGB', { min: 1, step: 'any', placeholder: 'none' })
  const low = input('lowFreePct', { min: 1, max: 50, step: 1, placeholder: `default ${settings.storage.lowFreePct}` })
  const floor = input('floorFreePct', { min: 1, max: 49, step: 1, placeholder: `default ${settings.storage.floorFreePct}` })
  const form = el(
    'form',
    { className: 'se-grid st-loc-form', autocomplete: 'off' },
    el('label', {}, 'Space limit for Argus (GB)', limit),
    el('label', {}, 'Low mark (% free)', low),
    el('label', {}, 'Hard floor (% free)', floor),
    el('div', { className: 'se-actions' }, el('button', { type: 'submit', textContent: 'Save' }))
  )
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const step = locationEdit(l, { limitGB: limit.value, lowFreePct: low.value, floorFreePct: floor.value })
    if (step.error) {
      locNote = { id: l.id, text: step.error, bad: true }
      return renderLocations()
    }
    // a limit that starts to be enforced, or a lower one, can delete footage from the next clean-up: said
    // in so many words, and a no is taken
    if (step.ask && !confirm(step.ask)) {
      locNote = { id: l.id, text: 'Not changed', bad: false }
      return renderLocations()
    }
    try {
      await api('POST', '/api/admin/storage', step.body)
      locEdits.delete(l.id)
      locNote = { id: l.id, text: 'Saved', bad: false }
    } catch (err) {
      locNote = { id: l.id, text: err.message, bad: true }
    }
    await loadStorage({ force: true })
  })
  return form
}

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
        if (sureToRemove(l.path, locations.filter((x) => x.id !== l.id && x.role !== 'archive').length === 0, 'Recordings already there are left in place.')) locAction({ action: 'remove', id: l.id })
      })
      const pct = h.totalBytes ? Math.round((h.freeBytes / h.totalBytes) * 100) : null
      return el(
        'article',
        { className: 'st-card' },
        el('div', { className: 'st-card-head' }, el('h3', { textContent: l.path }), el('span', { className: `st-status ${h.ok ? 'st-online' : 'st-offline'}`, textContent: h.ok ? 'OK' : 'Not usable' })),
        el('p', { className: 'st-meta', textContent: `${l.type} · ${l.id}${l.limitGB ? ` · limit ${l.limitGB.toLocaleString('en-GB')} GB, ${l.limitEnforced ? 'enforced' : 'not enforced (saved before limits were): Save it below to enforce it'}` : ''}` }),
        h.totalBytes ? el('p', { className: 'st-meta', textContent: `${gb(h.freeBytes)} free of ${gb(h.totalBytes)} (${pct}%)${h.writeMBps ? ` · writes ${h.writeMBps} MB/s` : ''}` }) : null,
        h.ok ? null : el('p', { className: 'st-error-text', textContent: h.reason }),
        l.sameDisk ? el('p', { className: 'st-warn-text', textContent: 'On the system disk: recordings could fill it.' }) : null,
        locationForm(l),
        locNote?.id === l.id ? el('p', { className: locNote.bad ? 'st-error' : 'st-meta', textContent: locNote.text }) : null,
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
  // a limit is enforced from the start: asked as on a card (a folder with a marker may hold footage)
  if (limit !== '') {
    const step = locationEdit({ id: null, path: $('l-path').value.trim(), limitGB: null, limitEnforced: false }, { limitGB: limit })
    if (step.error) return say('l-msg', step.error, true)
    if (step.ask && !confirm(step.ask)) return say('l-msg', 'Not added')
  }
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

async function loadStorage({ force = false } = {}) {
  try {
    locations = (await api('GET', '/api/admin/storage')).locations
    // not while an admin is in a location's limit or marks (the 30-second refresh took the cursor away)
    if (force || !document.activeElement?.closest?.('#locations .st-loc-form')) renderLocations()
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
  box.replaceChildren(...[
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
  ].filter(Boolean)) // (replaceChildren writes a null as the word "null")
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

// ---- network drive (NAS) --------------------------------------------------------------------------------

let netTimer = null

function renderShares(list) {
  if (!list.length) {
    $('netshares').replaceChildren(el('p', { className: 'st-empty', textContent: 'No network drives yet.' }))
    return
  }
  $('netshares').replaceChildren(
    ...list.map((s) => {
      const remove = el('button', { type: 'button', className: 'st-danger', textContent: 'Remove' })
      remove.addEventListener('click', () => {
        const recordsHere = locations.some((l) => l.path === s.path || l.path.startsWith(`${s.path}/`))
        if (sureToRemove(s.path, recordsHere && locations.filter((l) => !(l.path === s.path || l.path.startsWith(`${s.path}/`)) && l.role !== 'archive').length === 0, 'Nothing on the NAS itself is deleted, but its saved password is: adding it back needs the NAS login again.')) shareAction({ action: 'remove', id: s.id })
      })
      const where = s.proto === 'smb' ? `//${s.server}/${s.share}` : `${s.server}:${s.share}`
      return el(
        'article',
        { className: 'st-card' },
        el(
          'div',
          { className: 'st-card-head' },
          el('h3', { textContent: s.path }),
          el('span', { className: `st-status ${s.mounted ? 'st-online' : 'st-offline'}`, textContent: s.mounted ? 'Mounted' : 'Not mounted' })
        ),
        el('p', { className: 'st-meta', textContent: `${s.proto.toUpperCase()} ${where}${s.subdir ? ` · folder "${s.subdir}"` : ''}${s.user ? ` · user ${s.user}` : ''}` }),
        s.mounted && s.totalBytes ? el('p', { className: 'st-meta', textContent: `${gb(s.freeBytes)} free of ${gb(s.totalBytes)}` }) : null,
        s.mounted ? null : el('p', { className: 'st-warn-text', textContent: 'Not mounted: the NAS is off or unreachable. Recording moves to another location until it comes back.' }),
        el('div', { className: 'st-card-actions' }, remove)
      )
    })
  )
}

const NET_STEP_NAMES = { check: 'Check what was typed', credentials: 'Store the password (root only)', unit: 'Write the mount unit', mount: 'Mount', verify: 'Write a test file and read it back', cleanup: 'Undo the test mount', done: 'Done' }

function renderNetJob(job) {
  const box = $('netjob')
  if (!job) {
    box.hidden = true
    return
  }
  box.hidden = false
  const what = job.action === 'remove' ? 'Removing' : job.action === 'test' ? 'Testing' : 'Adding'
  const title =
    job.state === 'running'
      ? `${what} ${job.server}/${job.share}…`
      : job.state === 'done'
        ? job.action === 'test'
          ? 'The share works: it mounted and a test file was written and read back'
          : job.action === 'remove'
            ? 'Removed'
            : `${job.path} is ready`
        : job.state === 'mounted'
          ? 'Mounted, but not added as a storage location'
          : `${what} the share failed`
  const p = job.progress ?? { steps: Object.keys(NET_STEP_NAMES), done: 0, of: 5, pct: 0, step: 'check' }
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
  bar.setAttribute('aria-label', `${what} ${job.server}/${job.share}: ${p.pct}%`)
  box.replaceChildren(...[
    el('h3', { textContent: title }),
    bar,
    el(
      'ul',
      { className: 'se-parts' },
      ...p.steps.map((name, i) => {
        const st = stepState(name, i)
        const msg = latest.get(name)?.message
        return el('li', { className: `st-step st-step-${st}`, textContent: `${NET_STEP_NAMES[name] ?? name}${st === 'working' ? '…' : st === 'failed' ? ': failed' : ''}${msg ? ` — ${msg}` : ''}` })
      })
    ),
    job.state === 'done' && job.vers ? el('p', { className: 'st-meta', textContent: `Mounted with version ${job.vers}.` }) : null,
    job.state === 'failed' && job.error ? el('p', { className: 'st-error-text', textContent: job.error }) : null,
    job.state === 'mounted' && job.nextStep ? el('p', { className: 'st-warn-text', textContent: job.nextStep }) : null,
    job.location ? el('p', { className: 'st-meta', textContent: `Added as a storage location: ${job.location.path} (${job.location.role})` }) : null
  ].filter(Boolean)) // (replaceChildren writes a null as the word "null")
}

async function loadShares() {
  try {
    const r = await api('GET', '/api/admin/netshares')
    renderShares(r.shares)
    renderNetJob(r.job)
    clearTimeout(netTimer)
    if (r.job?.state === 'running') netTimer = setTimeout(loadShares, 1500)
    else if (r.job?.state === 'done' && r.job.action !== 'test') loadStorage()
  } catch (err) {
    say('n-msg', err.message, true)
  }
}

/** What the owner typed. The password is sent and then cleared: the page never keeps it. */
const shareForm = (action) => ({
  action,
  proto: $('n-proto').value,
  server: $('n-server').value.trim(),
  share: $('n-share').value.trim(),
  subdir: $('n-subdir').value.trim(),
  user: $('n-user').value.trim(),
  pass: $('n-pass').value,
  ...(action === 'add' ? { role: $('n-role').value } : {})
})

async function shareAction(body) {
  $('n-test').disabled = true
  $('n-add').disabled = true
  say('n-msg', body.action === 'test' ? 'Testing…' : 'Working…')
  try {
    const r = await api('POST', '/api/admin/netshares', body)
    say('n-msg', '')
    renderNetJob(r.job)
  } catch (err) {
    say('n-msg', err.message, true)
  }
  $('n-test').disabled = false
  $('n-add').disabled = false
  await loadShares()
}

// NFS has no user or password: the server decides by IP address
$('n-proto').addEventListener('change', () => {
  const nfs = $('n-proto').value === 'nfs'
  $('n-user-row').hidden = nfs
  $('n-pass-row').hidden = nfs
  $('n-share-row').firstChild.textContent = nfs ? 'Export path ' : 'Share '
  $('n-share').placeholder = nfs ? '/export/cctv' : 'Backups'
})
$('n-test').addEventListener('click', () => shareAction(shareForm('test')))
$('addShare').addEventListener('submit', async (e) => {
  e.preventDefault()
  await shareAction(shareForm('add'))
  if (!$('n-msg').textContent) {
    $('addShare').reset()
    $('n-proto').dispatchEvent(new Event('change'))
  }
  $('n-pass').value = '' // whether it worked or not, the password does not stay in the page
})

// ---- start ----------------------------------------------------------------------------------------------

// ---- alerts --------------------------------------------------------------------------------------

// Why each kind is worth a message, in the owner's words rather than the engine's ids.
const KIND_TEXT = {
  'server-restart': 'the server restarts',
  'drive-missing': 'the recording drive goes missing',
  'drive-full': 'the drive is nearly full',
  'not-recording': 'a camera stops recording',
  'camera-offline': 'a camera goes offline',
  'nvr-offline': 'an NVR goes offline',
  'nvr-disk': "an NVR's own disk fails or goes missing",
  'nvr-refusing': 'an NVR refuses streams',
  'nvr-login': 'an NVR refuses the login',
  'nvr-clock': "an NVR's clock drifts"
}

function renderAlerts() {
  const a = settings.alerts
  $('a-topic').value = a.ntfy.topic
  $('a-notrec').value = a.notRecordingMinutes
  $('a-skew').value = a.clockSkewSeconds
  $('a-host').value = a.email.host
  $('a-port').value = a.email.port
  $('a-secure').checked = a.email.secure
  $('a-user').value = a.email.user
  // The server answers 'set' rather than the password itself, so it is never sent back to a browser.
  $('a-pass').value = a.email.pass === 'set' ? 'set' : ''
  $('a-from').value = a.email.from
  $('a-to').value = (a.email.to ?? []).join(', ')
  $('a-daily').checked = a.dailySummary !== false
  renderHooks(a.webhooks ?? [])

  // A ticked box means "tell me", so the muted list is the unticked ones.
  const muted = new Set(a.muted ?? [])
  $('a-kinds').replaceChildren(
    el('legend', { textContent: 'Tell me about' }),
    ...(choices.alertKinds ?? Object.keys(KIND_TEXT)).map((k) =>
      el('label', {}, el('input', { type: 'checkbox', value: k, checked: !muted.has(k), className: 'a-kind' }), ` ${KIND_TEXT[k] ?? k}`))
  )
}

// Webhooks: a row each, the address and an optional secret. The server shows a stored secret as 'set'
// and keeps it when 'set' comes back (settings.mjs webhookList), so a secret is never sent to a browser.
function hookRow(h = { url: '', secret: '' }) {
  const row = el('div', { className: 'a-hook' })
  const url = el('input', { type: 'url', className: 'a-hook-url', placeholder: 'https://example.com/argus-hook', value: h.url ?? '' })
  const secret = el('input', { type: 'password', className: 'a-hook-secret', placeholder: 'secret (optional)', autocomplete: 'new-password', value: h.secret === 'set' ? 'set' : '' })
  const remove = el('button', { type: 'button', textContent: 'Remove' })
  remove.addEventListener('click', () => row.remove())
  row.append(url, secret, remove)
  return row
}
function renderHooks(list) {
  $('a-hooks').replaceChildren(...list.map(hookRow))
}
function collectHooks() {
  return [...document.querySelectorAll('.a-hook')]
    .map((r) => ({ url: r.querySelector('.a-hook-url').value.trim(), secret: r.querySelector('.a-hook-secret').value }))
    .filter((h) => h.url)
}
$('a-hook-add').addEventListener('click', () => {
  if (document.querySelectorAll('.a-hook').length >= 5) return say('a-hook-msg', 'At most five.', true)
  $('a-hooks').append(hookRow())
})
$('a-hook-test').addEventListener('click', async () => {
  say('a-hook-msg', 'Sending…')
  try {
    const saved = (settings.alerts.webhooks ?? []).map((h) => h.url).join('|')
    if (collectHooks().map((h) => h.url).join('|') !== saved) return say('a-hook-msg', 'Save first, then test.', true)
    const out = await api('POST', '/api/admin/alerts/test', { method: 'webhook' })
    say('a-hook-msg', out.ok ? 'Sent to every webhook.' : `Could not send: ${out.error}`, !out.ok)
  } catch (err) {
    say('a-hook-msg', err.message, true)
  }
})

$('a-new').addEventListener('click', () => {
  // Long and random: the topic is effectively the password to the owner's phone.
  const letters = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const rnd = crypto.getRandomValues(new Uint8Array(16))
  $('a-topic').value = `cctv-${Array.from(rnd, (b) => letters[b % letters.length]).join('')}`
})

$('a-test').addEventListener('click', async () => {
  say('a-test-msg', 'Sending…')
  try {
    if ($('a-topic').value !== settings.alerts.ntfy.topic) {
      say('a-test-msg', 'Save first, then test.', true)
      return
    }
    const out = await api('POST', '/api/admin/alerts/test', { method: 'ntfy' })
    say('a-test-msg', out.ok ? 'Sent. Check your phone.' : `Could not send: ${out.error}`, !out.ok)
  } catch (err) {
    say('a-test-msg', err.message, true)
  }
})

$('alerts').addEventListener('submit', async (e) => {
  e.preventDefault()
  const pass = $('a-pass').value
  const email = {
    host: $('a-host').value.trim(),
    port: Number($('a-port').value) || 587,
    secure: $('a-secure').checked,
    user: $('a-user').value.trim(),
    from: $('a-from').value.trim(),
    to: $('a-to').value.split(',').map((s) => s.trim()).filter(Boolean)
  }
  // 'set' means "leave the stored password alone"; anything else is a new one.
  if (pass !== 'set') email.pass = pass
  try {
    settings = (
      await api('POST', '/api/admin/settings', {
        alerts: {
          ntfy: { topic: $('a-topic').value.trim() },
          email,
          muted: [...document.querySelectorAll('.a-kind')].filter((c) => !c.checked).map((c) => c.value),
          notRecordingMinutes: Number($('a-notrec').value),
          clockSkewSeconds: Number($('a-skew').value),
          webhooks: collectHooks(),
          dailySummary: $('a-daily').checked
        }
      })
    ).settings
    renderAlerts()
    say('a-msg', 'Saved')
  } catch (err) {
    say('a-msg', err.message, true)
  }
})


// ---- the name and time this app draws over the picture (public/osd-overlay.js) --------------------
//
// PLACEMENT: a nine-corner picker with a fine nudge and a live preview, rather than dragging the
// overlay on a real camera picture. Two reasons, both about being solid rather than clever. First,
// this panel also sets the default for ALL cameras, and there is no single live picture to drag it
// on — the corner picker means the same control works for the default and for one camera. Second,
// dragging on a live tile would have to map a pointer position through the canvas's letterboxing
// (object-fit: contain) on a tile that is also click-to-open and pinch-to-zoom, which is exactly
// where a subtle, hard-to-see bug would live. The preview below the picker is drawn by the very
// same osdLayout() that draws the real thing, at a different size, so what it shows is what the
// tiles will show — including the clamping when the text is too long for the tile.

let osd = { default: { ...DEFAULT_OSD }, cameras: {} }
let osdCam = '' // '' = the default for all cameras, otherwise "<nvr>/<ch>"
let osdDraft = { ...DEFAULT_OSD }

/** The settings being edited: the default, or one camera's own (falling back to the default). */
const osdBase = () => (osdCam === '' ? osd.default : (osd.cameras[osdCam] ?? osd.default))
const osdCamera = () => cameras.find((c) => `${c.nvr}/${c.ch}` === osdCam) ?? null

function renderOsdCameras() {
  const sel = $('o-cam')
  const keep = sel.value
  sel.replaceChildren(
    option('', 'All cameras (the default)', false),
    ...cameras.map((c) => option(`${c.nvr}/${c.ch}`, `${c.site} · ${c.name}${osd.cameras[`${c.nvr}/${c.ch}`] ? ' (its own)' : ''}`))
  )
  sel.value = cameras.some((c) => `${c.nvr}/${c.ch}` === keep) ? keep : ''
  osdCam = sel.value
}

function drawOsdPreview() {
  const c = $('o-preview')
  const ctx = c.getContext('2d')
  if (!ctx) return
  // A plain grey stand-in for a picture: a real frame would only distract from where the text sits,
  // and this panel must work with every camera offline.
  ctx.fillStyle = '#3a4048'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  for (let i = 1; i < 3; i++) {
    ctx.beginPath()
    ctx.moveTo((c.width * i) / 3, 0)
    ctx.lineTo((c.width * i) / 3, c.height)
    ctx.moveTo(0, (c.height * i) / 3)
    ctx.lineTo(c.width, (c.height * i) / 3)
    ctx.stroke()
  }
  let settings
  try {
    settings = cleanOsdSettings(osdDraft)
  } catch {
    return // a half-typed figure: leave the last good preview up rather than flashing an error
  }
  drawOsd(
    ctx,
    osdLayout({
      settings,
      camera: { name: osdCamera()?.name ?? 'Camera name' },
      atMs: Date.now(),
      width: c.width,
      height: c.height,
      tzMs: -new Date().getTimezoneOffset() * 60_000,
      measure: (text, fontPx) => {
        ctx.font = osdFont(fontPx)
        return ctx.measureText(text).width
      }
    })
  )
}

function renderOsd() {
  $('o-name').checked = osdDraft.showName
  $('o-time').checked = osdDraft.showTime
  $('o-text').value = osdDraft.text ?? ''
  $('o-x').value = osdDraft.x
  $('o-y').value = osdDraft.y
  $('o-size').value = osdDraft.size
  const here = cornerOf(osdDraft)
  $('o-corners').replaceChildren(
    ...OSD_CORNERS.map((corner) => {
      const b = el('button', {
        type: 'button',
        textContent: corner.label,
        className: corner.id === here ? 'osd-corner on' : 'osd-corner',
        // The picker is a set of buttons, so it says out loud which one is chosen for a screen reader.
        ariaPressed: String(corner.id === here)
      })
      b.addEventListener('click', () => {
        osdDraft = { ...osdDraft, x: corner.x, y: corner.y }
        renderOsd()
      })
      return b
    })
  )
  $('o-reset').hidden = osdCam === '' || !osd.cameras[osdCam]
  $('o-text').placeholder = osdCamera()?.name ? `${osdCamera().name} (the camera's own name)` : "the camera's own name"
  drawOsdPreview()
}

function bindOsd() {
  const edit = (field, read) => {
    const input = $(field)
    input.addEventListener('input', () => {
      osdDraft = { ...osdDraft, ...read(input) }
      drawOsdPreview()
      // The corner buttons follow the fine nudge: moving x or y off a corner un-highlights it.
      if (field === 'o-x' || field === 'o-y') renderOsd()
    })
  }
  edit('o-name', (i) => ({ showName: i.checked }))
  edit('o-time', (i) => ({ showTime: i.checked }))
  edit('o-text', (i) => ({ text: i.value.trim() === '' ? null : i.value }))
  edit('o-x', (i) => ({ x: Number(i.value) }))
  edit('o-y', (i) => ({ y: Number(i.value) }))
  edit('o-size', (i) => ({ size: Number(i.value) }))

  $('o-cam').addEventListener('change', () => {
    osdCam = $('o-cam').value
    osdDraft = { ...osdBase() }
    say('o-msg', '')
    renderOsd()
  })

  $('o-reset').addEventListener('click', async () => {
    try {
      osd = await api('PUT', '/api/admin/osd', { cameras: { [osdCam]: null } })
      osdDraft = { ...osdBase() }
      renderOsdCameras()
      renderOsd()
      say('o-msg', 'This camera uses the default again')
    } catch (err) {
      say('o-msg', err.message, true)
    }
  })

  $('osd').addEventListener('submit', async (e) => {
    e.preventDefault()
    try {
      // Checked here so a mistyped figure is named before it is sent; the server checks it again
      // with the very same function, because a page is never the last word on what gets stored.
      const settings = cleanOsdSettings(osdDraft)
      osd = await api('PUT', '/api/admin/osd', osdCam === '' ? { default: settings } : { cameras: { [osdCam]: settings } })
      osdDraft = { ...osdBase() }
      renderOsdCameras()
      renderOsd()
      say('o-msg', osdCam === '' ? 'Saved for every camera without its own settings' : 'Saved for this camera')
    } catch (err) {
      say('o-msg', err.message, true)
    }
  })
}

async function loadOsd() {
  try {
    osd = await api('GET', '/api/osd')
  } catch {
    osd = { default: { ...DEFAULT_OSD }, cameras: {} }
  }
  osdDraft = { ...osdBase() }
  renderOsdCameras()
  renderOsd()
}

function render() {
  renderDefaults()
  renderCameras()
  renderMisc()
  renderAlerts()
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
    await loadOsd()
    bindOsd()
    await loadStorage()
    await loadDisks()
    await loadShares()
    setInterval(() => {
      loadStorage()
      refreshRam()
    }, 30_000)
  } catch (err) {
    notice.textContent = `Could not load the settings: ${err.message}`
    notice.hidden = false
  }
}
