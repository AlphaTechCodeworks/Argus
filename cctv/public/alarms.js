// The Alarms page: what still needs a person, in the order it needs them.
//
// The split is the one health.js uses: everything that decides what a line says is in
// alarms-view.js and is tested without a browser; this file fetches, paints and wires up the
// buttons. The motion tuning panel is its own class in motion-tune.js.
// Everything imported here is served from this folder: the browser cannot reach above it, which is
// why the kinds, the words and the priorities live in alarms-view.js and the server imports them
// from there rather than the other way round.
import { EVENT_KINDS, PRIORITIES, alarmRows, filterSummary, labelOf, priorityClass, ruleSummary } from './alarms-view.js'
import { MotionTuner } from './motion-tune.js'

const $ = (id) => document.getElementById(id)
const REFRESH_MS = 30_000

let cameras = []
let admin = false
let tuner = null

const jsonOf = (r) => r.json().catch(() => ({}))
const say = (el, text) => { el.textContent = text }

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
  say($('summary'), filterSummary(body.summary, { acked: $('filters').elements.acked.value === 'false' }))
  paintAlarms(alarmRows(body.alarms))
  paintSources(body.sources)
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
    return
  }
  for (const r of rows) {
    const tr = document.createElement('tr')
    tr.className = `${priorityClass(r.priority)}${r.needsAck ? ' needs-ack' : ''}`
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
    tr.append(pri, when, cell(r.camera), cell(r.what), cell(r.lasted), cell(r.ack || (r.needsAck ? 'not yet' : '')))

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

async function acknowledge(row) {
  const note = prompt(`What did you find? (${row.what} on ${row.camera})`, '')
  if (note === null) return
  const res = await fetch(`/api/alarms/${row.id}/ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) })
  const body = await jsonOf(res)
  if (!res.ok) alert(body.error ?? 'It could not be acknowledged.')
  loadAlarms()
}

async function bookmark(row) {
  const title = prompt('Bookmark this alarm as:', `${row.what} — ${row.camera}`)
  if (title === null) return
  const res = await fetch(`/api/alarms/${row.id}/bookmark`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) })
  const body = await jsonOf(res)
  alert(res.ok ? 'Bookmarked. Housekeeping will now leave this footage alone.' : body.error ?? 'It could not be bookmarked.')
}

/** Exporting stays entirely in the exports page; this only hands it the times to open on. */
async function exportClip(row) {
  const res = await fetch(`/api/alarms/${row.id}/clip`)
  const body = await jsonOf(res)
  if (!res.ok) return void alert(body.error ?? 'The clip times could not be read.')
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
  const cams = $('filters').elements.camera
  const ruleCams = $('ruleForm').elements.cameras
  for (const c of cameras) {
    const key = `${c.nvr}/${c.ch}`
    cams.append(new Option(c.name ?? key, key))
    ruleCams.append(new Option(c.name ?? key, key))
    $('tuneCamera').append(new Option(c.name ?? key, key))
  }
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
    tuner.show(nvr ? { nvr, ch: Number(ch), name: e.target.selectedOptions[0].textContent } : null)
  })
  // Nothing is streamed until somebody picks a camera: this page is opened far more often than the
  // tuning panel is used, and an NVR at its limit should not pay for a panel nobody is looking at.
  $('tuneCamera').prepend(new Option('choose a camera…', ''))
  $('tuneCamera').value = ''

  await Promise.all([loadAlarms(), loadRules()])
  setInterval(loadAlarms, REFRESH_MS)
}

$('logout')?.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {})
  location.href = '/login.html'
})

start()
