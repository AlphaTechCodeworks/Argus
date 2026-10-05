// The Alarms page: what still needs a person, in the order it needs them.
//
// The split is the one health.js uses: everything that decides what a line says is in
// alarms-view.js and is tested without a browser; this file fetches, paints and wires up the
// buttons. The motion tuning panel is its own class in motion-tune.js.
// Everything imported here is served from this folder: the browser cannot reach above it, which is
// why the kinds, the words and the priorities live in alarms-view.js and the server imports them
// from there rather than the other way round.
import { EVENT_KINDS, PRIORITIES, alarmRows, eventFromHash, filterSummary, labelOf, linkedEventNote, priorityClass, ruleSummary, snapshotMayArrive } from './alarms-view.js'
import { fillCameraSelect } from './camera-choice.js'
import { MotionTuner } from './motion-tune.js'

const $ = (id) => document.getElementById(id)
const REFRESH_MS = 30_000

let cameras = []
let admin = false
let tuner = null
// The alarm a link pointed at (a phone alert opens /alarms.html#event=<id>): marked in the list on
// every repaint, scrolled to once per link.
let linked = eventFromHash(location.hash)
let scrolledTo = null
// Line-crossing pictures, kept across the 30 s refresh so the list does not fetch and redraw every
// thumbnail each time; and the alarms whose picture is known not to be coming.
const thumbs = new Map()
const noPicture = new Set()

const jsonOf = (r) => r.json().catch(() => ({}))
const say = (el, text) => { el.textContent = text }

let dlgSeq = 0
/**
 * A themed input dialog in place of prompt(): resolves the entered text, or null if cancelled. Esc or
 * Cancel gives null; the action button (or Enter, single line) submits; showModal traps focus. Uses the
 * app's .ip-dialog look, so it matches every other dialog instead of the browser's own chrome.
 * @param {{ title: string, label?: string, value?: string, placeholder?: string, multiline?: boolean, action?: string }} o
 */
function inputDialog({ title, label = '', value = '', placeholder = '', multiline = false, action = 'Save' }) {
  const d = document.createElement('dialog')
  d.className = 'ip-dialog al-input'
  const tid = `al-d-${++dlgSeq}`
  d.setAttribute('aria-labelledby', tid)
  const h = document.createElement('h3')
  h.id = tid
  h.textContent = title
  const field = document.createElement(multiline ? 'textarea' : 'input')
  if (multiline) field.rows = 3
  else field.type = 'text'
  field.value = value
  field.placeholder = placeholder
  field.id = `${tid}-f`
  const lab = document.createElement('label')
  lab.htmlFor = field.id
  lab.textContent = label
  const buttons = document.createElement('div')
  buttons.className = 'ip-dialog-buttons'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel'
  const ok = document.createElement('button')
  ok.type = 'button'
  ok.className = 'ip-go'
  ok.textContent = action
  buttons.append(cancel, ok)
  d.append(h, ...(label ? [lab] : []), field, buttons)
  document.body.append(d)
  return new Promise((resolve) => {
    const done = (v) => { try { d.close() } catch {} d.remove(); resolve(v) }
    ok.addEventListener('click', () => done(field.value))
    cancel.addEventListener('click', () => done(null))
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(null) }, { once: true }) // Esc
    if (!multiline) field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(field.value) } })
    d.showModal()
    field.focus()
    field.select?.()
  })
}

/** A date input's value as milliseconds, or null when it is empty. */
const dayMs = (v, endOfDay = false) => {
  if (!v) return null
  const t = Date.parse(`${v}T00:00:00`)
  return Number.isFinite(t) ? t + (endOfDay ? 86_399_999 : 0) : null
}

function filterParams() {
  const f = $('filters').elements
  const p = new URLSearchParams()
  const from = dayMs(f.from.value)
  const to = dayMs(f.to.value, true)
  if (from !== null) p.set('from', String(from))
  if (to !== null) p.set('to', String(to))
  if (f.camera.value) p.set('cameras', f.camera.value)
  if (f.type.value) p.set('types', f.type.value)
  if (f.priority.value) p.set('priorities', f.priority.value)
  if (f.acked.value) p.set('acked', f.acked.value)
  if (f.text.value.trim()) p.set('text', f.text.value.trim())
  return p
}

// ---- the list ----------------------------------------------------------------------------------

async function loadAlarms() {
  const res = await fetch(`/api/alarms?${filterParams()}`, { headers: { accept: 'application/json' } })
  if (res.status === 401) return void (location.href = '/login.html')
  const body = await jsonOf(res)
  if (!res.ok) return say($('summary'), body.error ?? 'The alarms could not be read.')
  admin = body.admin === true
  const rows = alarmRows(body.alarms)
  // A linked alarm that is not in this list is explained on the summary line, which is read out as
  // a status: whoever followed the link learns why they are not looking at it.
  say($('summary'), [filterSummary(body.summary, { acked: $('filters').elements.acked.value === 'false' }), linkedEventNote(linked, rows)].filter(Boolean).join(' · '))
  paintAlarms(rows)
  paintSources(body.sources)
  showLinked()
}

function paintAlarms(rows) {
  const list = $('list')
  list.replaceChildren()
  if (!rows.length) {
    const tr = document.createElement('tr')
    const td = document.createElement('td')
    td.colSpan = 7
    // Never "all clear": an empty list means nothing matched these filters, which is a different
    // claim from "nothing happened", and a very different one from "we can see everything".
    td.textContent = 'Nothing matches these filters. See “Where these come from” below for what this page can and cannot report.'
    tr.append(td)
    list.append(tr)
    thumbs.clear()
    return
  }
  for (const r of rows) {
    const tr = document.createElement('tr')
    tr.className = `${priorityClass(r.priority)}${r.needsAck ? ' needs-ack' : ''}${r.id === linked ? ' al-target' : ''}`
    tr.dataset.event = String(r.id)
    const cell = (text) => {
      const td = document.createElement('td')
      td.textContent = text ?? '—'
      return td
    }
    // urgency as a tag, the time with how long ago under it: read at a glance, not parsed
    const pri = document.createElement('td')
    const tag = document.createElement('span')
    tag.className = `al-pri ${priorityClass(r.priority)}`
    tag.textContent = r.priority
    pri.append(tag)
    const when = document.createElement('td')
    when.className = 'al-when'
    const ago = document.createElement('small')
    ago.textContent = r.ago
    when.append(r.when, ago)
    const what = cell(r.what)
    // a line crossing's picture sits under its name (event-snapshot.mjs takes it from the recording)
    if (r.snapshot && !noPicture.has(r.id)) what.append(thumbFor(r))
    tr.append(pri, when, cell(r.camera), what, cell(r.lasted), cell(r.ack || (r.needsAck ? 'not yet' : '')))

    const actions = document.createElement('td')
    actions.className = 'al-actions'
    if (r.needsAck) actions.append(button('Acknowledge…', () => acknowledge(r), 'st-primary'))
    // Opening in playback a little before the alarm: the useful part starts before the trigger.
    actions.append(link('Playback', `/playback.html?nvr=${encodeURIComponent(r.nvr)}&ch=${r.ch}&t=${r.startMs - 30_000}`))
    actions.append(button('Bookmark', () => bookmark(r)))
    actions.append(button('Export', () => exportClip(r)))
    tr.append(actions)
    list.append(tr)
  }
  // pictures of rows that have left the list (acknowledged, filtered out, too old) are let go
  const shown = new Set(rows.map((r) => r.id))
  for (const id of thumbs.keys()) if (!shown.has(id)) thumbs.delete(id)
}

const button = (text, fn, cls = '') => {
  const b = document.createElement('button')
  b.type = 'button'
  if (cls) b.className = cls
  b.textContent = text
  b.addEventListener('click', fn)
  return b
}
const link = (text, href) => {
  const a = document.createElement('a')
  a.textContent = text
  a.href = href
  return a
}

/**
 * A line crossing's picture: a thumbnail that opens the full picture in a new tab. Loaded lazily
 * (the browser fetches it only when the row comes near the screen): the list can hold hundreds of
 * rows, and each picture is a file the server reads from disk. The same element is reused on every
 * refresh, so a picture is fetched once rather than every 30 s.
 */
function thumbFor(row) {
  const kept = thumbs.get(row.id)
  if (kept) return kept
  const a = document.createElement('a')
  a.className = 'al-snap'
  a.href = row.snapshot
  a.target = '_blank'
  a.rel = 'noopener'
  a.title = 'Open the picture'
  const img = document.createElement('img')
  // the alarm a link pointed at is looked at straight away: its picture should not wait for a scroll
  img.loading = row.id === linked ? 'eager' : 'lazy'
  img.decoding = 'async'
  img.alt = `${row.what}, ${row.camera}, ${row.when}`
  // No picture: it is taken from the recording up to three minutes after the crossing, or there was
  // no recording to take it from, or this user may not play that camera back. The empty frame goes;
  // the next refresh asks again only while the picture may still be on its way.
  img.addEventListener('error', () => {
    a.remove()
    thumbs.delete(row.id)
    if (!snapshotMayArrive(row.startMs)) noPicture.add(row.id)
  }, { once: true })
  img.src = row.snapshot
  a.append(img)
  thumbs.set(row.id, a)
  return a
}

/**
 * The alarm a link pointed at: brought into view once per link, and given the focus so a keyboard
 * or a screen reader starts there. Later refreshes keep it marked but leave the scrolling to the user.
 */
function showLinked() {
  if (linked === null || scrolledTo === linked) return
  const tr = $('list').querySelector(`tr[data-event="${linked}"]`)
  if (!tr) return
  scrolledTo = linked
  tr.tabIndex = -1
  tr.scrollIntoView({ block: 'center' })
  tr.focus({ preventScroll: true })
}

async function acknowledge(row) {
  const note = await inputDialog({ title: 'Acknowledge alarm', label: `What did you find? (${row.what} on ${row.camera})`, placeholder: 'e.g. checked the area — all clear', multiline: true, action: 'Acknowledge' })
  if (note === null) return
  const res = await fetch(`/api/alarms/${row.id}/ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) })
  const body = await jsonOf(res)
  if (res.ok) loadAlarms()
  else say($('summary'), body.error ?? 'It could not be acknowledged.')
}

async function bookmark(row) {
  const title = await inputDialog({ title: 'Bookmark alarm', label: 'Save this alarm as:', value: `${row.what} — ${row.camera}`, action: 'Bookmark' })
  if (title === null) return
  const res = await fetch(`/api/alarms/${row.id}/bookmark`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) })
  const body = await jsonOf(res)
  say($('summary'), res.ok ? 'Bookmarked. Housekeeping will now leave this footage alone.' : body.error ?? 'It could not be bookmarked.')
}

/** Exporting stays entirely in the exports page; this only hands it the times to open on. */
async function exportClip(row) {
  const res = await fetch(`/api/alarms/${row.id}/clip`)
  const body = await jsonOf(res)
  if (!res.ok) return void say($('summary'), body.error ?? 'The clip times could not be read.')
  const c = body.clip
  location.href = `/playback.html?nvr=${encodeURIComponent(row.nvr)}&ch=${row.ch}&t=${c.startMs}&markIn=${c.startMs}&markOut=${c.endMs}&export=1`
}

/** The honest footnote: what this page can see, and what it cannot. */
function paintSources(sources) {
  const box = $('sources')
  box.replaceChildren()
  if (!sources) return
  const section = (title, items, render) => {
    const h = document.createElement('h3')
    h.textContent = title
    const ul = document.createElement('ul')
    for (const i of items) {
      const li = document.createElement('li')
      li.textContent = render(i)
      ul.append(li)
    }
    box.append(h, ul)
  }
  section('Reported', sources.confirmed, (c) => `${c.what} — from ${c.how}`)
  section('Not available', sources.notAvailable, (n) => `${n.what} — ${n.why}. To find out whether it can be: ${n.toConfirm}`)
}

// ---- the rules ------------------------------------------------------------------------------------

async function loadRules() {
  const res = await fetch('/api/alarms/rules', { headers: { accept: 'application/json' } })
  const body = await jsonOf(res)
  if (!res.ok) return
  admin = body.admin === true
  $('ruleForm').hidden = !admin
  const ul = $('rules')
  ul.replaceChildren()
  if (!body.rules.length) {
    const li = document.createElement('li')
    li.textContent = 'No rules yet. Without one, events are still recorded and listed here; they are just never urgent and nobody is messaged.'
    ul.append(li)
  }
  for (const rule of body.rules) {
    const li = document.createElement('li')
    const text = document.createElement('span')
    text.textContent = `${rule.name}: ${ruleSummary(rule)}${rule.enabled ? '' : ' (off)'}${rule.damaged ? ' — this rule could not be read and is doing nothing until it is saved again' : ''}`
    li.append(text)
    if (admin) {
      li.append(button(rule.enabled ? 'Turn off' : 'Turn on', () => patchRule(rule.id, { enabled: !rule.enabled })))
      li.append(button('Delete', () => deleteRule(rule.id, rule.name)))
    }
    ul.append(li)
  }
}

async function patchRule(id, fields) {
  await fetch(`/api/alarms/rules/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) })
  loadRules()
}
async function deleteRule(id, name) {
  if (!confirm(`Delete the rule “${name}”? Alarms already filed under it keep the urgency it gave them.`)) return
  await fetch(`/api/alarms/rules/${id}`, { method: 'DELETE' })
  loadRules()
}

async function addRule(e) {
  e.preventDefault()
  const f = e.target.elements
  const days = f.days.value.split(',').map((d) => Number(d.trim())).filter((d) => Number.isInteger(d))
  const schedule = f.from.value || f.to.value || days.length ? [{ days, from: f.from.value || '00:00', to: f.to.value || '00:00' }] : []
  const body = {
    name: f.name.value.trim(),
    cameras: [...f.cameras.selectedOptions].map((o) => o.value),
    types: [...f.types.selectedOptions].map((o) => o.value),
    schedule,
    priority: f.priority.value,
    notify: f.notify.checked,
    minGapS: Number(f.minGapS.value) || 0
  }
  const res = await fetch('/api/alarms/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const answer = await jsonOf(res)
  say($('ruleError'), res.ok ? '' : answer.error ?? 'The rule could not be saved.')
  if (res.ok) {
    e.target.reset()
    loadRules()
  }
}

// ---- setting the page up ----------------------------------------------------------------------------

function fillChoices() {
  // grouped by site, "3 · North Gate" (camera-choice.js); tuning lists only cameras it can measure
  fillCameraSelect($('filters').elements.camera, cameras)
  fillCameraSelect($('ruleForm').elements.cameras, cameras)
  fillCameraSelect($('tuneCamera'), cameras, { onlineOnly: true })
  for (const t of EVENT_KINDS) {
    // An unconfirmed kind is listed, because a rule may be written for the day it works, but it is
    // labelled so nobody sits waiting for alarms that cannot arrive yet.
    const label = t.confirmed ? labelOf(t.type) : `${labelOf(t.type)} (not available yet)`
    $('filters').elements.type.append(new Option(label, t.type))
    $('ruleForm').elements.types.append(new Option(label, t.type))
  }
  for (const p of PRIORITIES) {
    $('filters').elements.priority.append(new Option(p, p))
    $('ruleForm').elements.priority.append(new Option(p, p))
  }
  $('ruleForm').elements.priority.value = 'medium'
}

async function start() {
  cameras = await fetch('/api/cameras', { headers: { accept: 'application/json' } }).then(jsonOf).catch(() => [])
  if (!Array.isArray(cameras)) cameras = cameras.cameras ?? []
  fillChoices()
  $('filters').addEventListener('submit', (e) => {
    e.preventDefault()
    loadAlarms()
  })
  $('ruleForm').addEventListener('submit', addRule)

  tuner = new MotionTuner({
    tile: $('tuneTile'),
    overlay: $('tuneOverlay'),
    meter: $('tuneMeter'),
    note: $('tuneNote'),
    form: $('tuneForm'),
    error: $('tuneError'),
    result: $('tuneResult')
  })
  $('tuneCamera').addEventListener('change', (e) => {
    const [nvr, ch] = e.target.value.split('/')
    // nothing but the picker until a camera is chosen (it was a black box under it)
    $('tuneEmpty').hidden = Boolean(nvr)
    $('tuneBody').hidden = !nvr
    tuner.show(nvr ? { nvr, ch: Number(ch), name: e.target.selectedOptions[0].textContent } : null)
  })
  // Nothing is streamed until somebody picks a camera: this page is opened far more often than the
  // tuning panel is used, and an NVR at its limit should not pay for a panel nobody is looking at.
  $('tuneCamera').prepend(new Option('choose a camera…', ''))
  $('tuneCamera').value = ''

  // A link to one alarm must find it even if someone has acknowledged it already: the list opens on
  // "still needing a look", which would hide exactly the alarm the link was sent about.
  if (linked !== null) $('filters').elements.acked.value = ''
  await Promise.all([loadAlarms(), loadRules()])
  setInterval(loadAlarms, REFRESH_MS)
}

$('logout')?.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {})
  location.href = '/login.html'
})

// A second alert tapped while this page is open changes only what follows the #: follow it here,
// without a reload. A tab link (#rules) is not an alarm and just clears the mark.
addEventListener('hashchange', () => {
  const id = eventFromHash(location.hash)
  if (id === linked) return
  linked = id
  scrolledTo = null
  for (const tr of $('list').querySelectorAll('tr.al-target')) tr.classList.remove('al-target')
  if (id === null) return
  $('filters').elements.acked.value = ''
  loadAlarms()
})

start()
