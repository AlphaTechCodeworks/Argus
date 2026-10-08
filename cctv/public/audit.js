// The Audit page: the trail on the left, the rights screen on the right.
//
// renderAudit() and renderRights() are pure — they turn what the API answered into exactly what
// the page shows and nothing else — so they can be tested without a browser, the same split
// health.js and pb-sources.js use. The DOM code at the bottom only paints and only runs in a page.
//
// One deliberate choice about filtering: the filters are sent to the server and applied there,
// not applied in the browser. The browser never receives rows the signed-in admin is not entitled
// to see, so a filter cannot be "removed" with the developer tools to reveal more.
//
// The access editor (Edit access, on Users & access) is drawn here too, but every rule about what a
// tick means lives in access-model.js, tested without a browser; this file only paints its view
// and posts its row. The server decides again on save (rights.mjs), so nothing here is trusted.

import { COLUMNS, COLUMN_LABELS, COLUMN_TITLES, FORMATS, FORMAT_LABELS, HEAD_ROWS, buildTree, click, copyFrom, copySources, dropKept, fromRow, sameRow, setAdmin, setAll, setFormat, toRow, view } from './access-model.js'

const PAD = (n) => String(n).padStart(2, '0')

/** "25 Sep 14:03:11", local time: an investigator compares these against wall clocks and statements. */
export function stamp(ms) {
  const d = new Date(ms)
  if (!Number.isFinite(ms)) return '—'
  const month = d.toLocaleString('en-GB', { month: 'short' })
  return `${d.getDate()} ${month} ${PAD(d.getHours())}:${PAD(d.getMinutes())}:${PAD(d.getSeconds())}`
}

/** Plain English for each recorded action, because "playback-view" is jargon on a printed page. */
export const ACTION_LABELS = Object.freeze({
  login: 'Signed in',
  'login-failed': 'Sign-in refused',
  logout: 'Signed out',
  'user-sign-out': 'User signed out by administrator',
  'settings-change': 'Settings changed',
  'rights-change': 'Rights changed',
  export: 'Export made',
  'export-download': 'Export downloaded',
  'playback-view': 'Played back',
  'live-view': 'Watched live',
  'audit-prune': 'Old entries removed',
  other: 'Other'
})

export const actionLabel = (a) => ACTION_LABELS[a] ?? String(a ?? 'Other')

/**
 * @param {{rows?:object[], total?:number, damaged?:number, truncated?:boolean, actions?:string[],
 *          retentionDays?:number, health?:{failures?:number,lastError?:string}, mode?:number|null}} d
 * @param {{user?:string, action?:string, from?:string, to?:string}} [filters] what was asked for,
 *   so the summary can say "nothing matched THESE filters" rather than "nothing happened".
 */
export function renderAudit(d, filters = {}) {
  const rows = Array.isArray(d?.rows) ? d.rows : []
  const filtered = Boolean(filters.user || filters.action || filters.from || filters.to)

  const list = rows.map((r) => ({
    when: stamp(r.at),
    at: r.at,
    user: r.user || 'anonymous',
    action: actionLabel(r.action),
    actionKey: r.action ?? 'other',
    target: r.target || '',
    detail: r.detail || '',
    ip: r.ip || '',
    // A refusal is the row people are looking for, so it is marked, not just worded differently.
    state: r.ok === false || r.action === 'login-failed' ? 'bad' : r.action === 'export' || r.action === 'rights-change' ? 'warn' : 'ok'
  }))

  const total = Number.isFinite(d?.total) ? d.total : list.length
  const summary = list.length === 0
    ? filtered ? 'Nothing matches those filters.' : 'Nothing has been recorded yet.'
    : d?.truncated
      ? `Showing the newest ${list.length} of ${total} entries. Narrow the dates to see the rest.`
      : `${total} ${total === 1 ? 'entry' : 'entries'}.`

  // The trail's own problems, stated on the page rather than left in a server log nobody reads.
  const warnings = []
  const failures = d?.health?.failures ?? 0
  if (failures > 0) {
    warnings.push(`${failures} audit ${failures === 1 ? 'entry' : 'entries'} could not be written${d.health.lastError ? `: ${d.health.lastError}` : ''}. The trail is incomplete — check the disk.`)
  }
  if (d?.damaged > 0) warnings.push(`${d.damaged} damaged ${d.damaged === 1 ? 'line was' : 'lines were'} skipped, probably a power cut mid-write.`)
  // 0600 is the point of the file. Anything wider and every account on the box can read who
  // watched which camera.
  if (d?.mode !== null && d?.mode !== undefined && d.mode !== 0o600) {
    warnings.push(`The audit file is mode ${d.mode.toString(8).padStart(3, '0')}, not 600. Others on this server can read it.`)
  }

  return {
    rows: list,
    summary,
    warnings,
    actions: Array.isArray(d?.actions) ? d.actions.map((a) => ({ value: a, label: actionLabel(a) })) : [],
    retentionNote: `Entries are kept for ${d?.retentionDays ?? 365} days and then removed.`
  }
}

// ------------------------------------------------------------------------------ the rights screen

const TARGET_TEXT = (t) => (t === '*' ? 'everywhere' : t.includes('/') ? `${t.split('/')[0]} camera ${Number(t.split('/')[1]) + 1}` : `all of ${t}`)

/** A grant list as a sentence. An empty list says so out loud — a blank cell reads as "unknown". */
export const grantText = (list) => (Array.isArray(list) && list.length ? list.map(TARGET_TEXT).join(', ') : 'no access')

/**
 * @param {{users?:object[], actions?:string[], formats?:string[]}} d the body of GET /api/admin/rights
 */
export function renderRights(d) {
  const sent = (Array.isArray(d?.actions) ? d.actions : []).filter((a) => a !== 'admin')
  // the editor's order and names (access-model.js); an action this page does not know (a newer
  // server) goes last, under its own key
  const actions = [...COLUMNS.filter((a) => sent.includes(a)), ...sent.filter((a) => !COLUMNS.includes(a))]
  const formats = Array.isArray(d?.formats) ? d.formats : []
  const users = (Array.isArray(d?.users) ? d.users : []).map((u) => ({
    user: u.user,
    admin: u.admin === true,
    // An admin's grant lists are irrelevant: admin already covers everything, and showing the
    // empty lists next to it would read as "this admin can do nothing".
    cells: actions.map((a) => ({ action: a, text: u.admin ? 'everywhere (admin)' : grantText(u.grants?.[a]) })),
    formats: u.admin ? [...formats] : formats.filter((f) => (u.formats ?? []).includes(f)),
    formatText: u.admin ? 'any format' : (u.formats ?? []).length ? u.formats.join(', ') : 'none'
  }))

  const admins = users.filter((u) => u.admin).map((u) => u.user)
  return {
    actions,
    labels: actions.map((a) => COLUMN_LABELS[a] ?? a),
    formats,
    users,
    admins,
    // The rule saveRights() enforces, said on the page so nobody discovers it as an error message.
    note: admins.length <= 1
      ? `${admins.length === 1 ? `${admins[0]} is` : 'Nobody is'} the only admin. The last admin cannot be removed here — make someone else an admin first.`
      : `${admins.length} admins: ${admins.join(', ')}.`
  }
}

/**
 * What the access editor's Save should do with a failed POST /api/admin/rights: the message to show,
 * and whether this is the stale-editor refusal (rights.mjs's compare-and-swap, `seen`) rather than an
 * ordinary error. A stale save means the row on screen is no longer the truth — retrying would just
 * resend the same wrong row — so it is offered a reopen instead of a plain "not saved".
 * @param {number} status
 * @param {{ error?: string, stale?: boolean }} body the parsed JSON of a non-2xx response (or {})
 */
export function saveRightsFailure(status, body) {
  return {
    stale: status === 409 && body?.stale === true,
    message: body?.error || `the server answered ${status}`
  }
}

// ---- the page itself (skipped when a test imports this module: there is no document) ------------
if (typeof document !== 'undefined' && document.getElementById('auditRows')) {
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props)
  const id = (x) => document.getElementById(x)

  const dayMs = (value, endOfDay) => {
    if (!value) return null
    const t = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`).getTime()
    return Number.isFinite(t) ? t : null
  }

  const filters = () => ({ user: id('fUser').value.trim(), action: id('fAction').value, from: id('fFrom').value, to: id('fTo').value })

  const paintAudit = (d, f) => {
    const r = renderAudit(d, f)
    id('auditSummary').textContent = r.summary
    id('retention').textContent = r.retentionNote
    const warn = id('auditWarn')
    warn.replaceChildren(...r.warnings.map((w) => el('p', { className: 'bad', textContent: w })))
    warn.hidden = r.warnings.length === 0
    id('auditRows').replaceChildren(...r.rows.map((row) => {
      const tr = el('tr', { className: row.state })
      for (const text of [row.when, row.user, row.action, row.target, row.detail, row.ip]) tr.append(el('td', { textContent: text }))
      return tr
    }))
  }

  const loadAudit = () => {
    const f = filters()
    const q = new URLSearchParams()
    if (f.user) q.set('user', f.user)
    if (f.action) q.set('action', f.action)
    const from = dayMs(f.from, false)
    const to = dayMs(f.to, true)
    if (from !== null) q.set('from', String(from))
    if (to !== null) q.set('to', String(to))
    return fetch(`/api/admin/audit?${q}`)
      .then((x) => x.json())
      .then((d) => {
        if (d.error) { id('auditSummary').textContent = d.error; return }
        if (id('fAction').options.length <= 1) {
          for (const a of renderAudit(d).actions) id('fAction').append(el('option', { value: a.value, textContent: a.label }))
          id('fAction').value = f.action
        }
        paintAudit(d, f)
      })
      .catch(() => { id('auditSummary').textContent = 'Could not read the audit log.' })
  }

  const paintRights = (d) => {
    const r = renderRights(d)
    id('rightsNote').textContent = r.note
    const heads = ['User', 'Admin', ...r.labels, 'Export formats']
    const head = el('tr')
    for (const h of heads) head.append(el('th', { textContent: h }))
    id('rightsHead').replaceChildren(head)
    // each cell carries its column's name: on a phone the table is one card per user (style.css)
    const td = (text, i, className = '') => {
      const c = el('td', { textContent: text, className })
      c.dataset.label = heads[i]
      return c
    }
    id('rightsRows').replaceChildren(...r.users.map((u) => {
      const tr = el('tr')
      tr.append(td(u.user, 0), td(u.admin ? 'yes' : 'no', 1, u.admin ? 'warn' : ''))
      u.cells.forEach((c, i) => tr.append(td(c.text, i + 2)))
      tr.append(td(u.formatText, heads.length - 1))
      return tr
    }))
  }

  // ---- accounts (users-api.mjs) ----
  const usersApi = async (method, path = '', body) => {
    const r = await fetch(`/api/admin/users${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error ?? `${r.status}`)
    return j
  }
  const uSay = (t, bad = false) => { const m = document.getElementById('u-msg'); m.textContent = t; m.classList.toggle('st-error-text', bad) }
  const resetDialog = document.getElementById('resetPasswordDialog')
  const resetForm = document.getElementById('resetPasswordForm')
  const resetNew = document.getElementById('resetPasswordNew')
  const resetConfirm = document.getElementById('resetPasswordConfirm')
  const resetError = document.getElementById('resetPasswordError')
  const resetSave = document.getElementById('resetPasswordSave')
  let resetAccount = null
  let resettingPassword = false
  const openPasswordReset = (name) => {
    resetAccount = name
    resetForm.reset()
    resetConfirm.setCustomValidity('')
    resetError.textContent = ''
    document.getElementById('resetPasswordAccount').textContent = `Set a new password for ${name}.`
    resetDialog.showModal()
    resetNew.focus()
  }
  resetConfirm.addEventListener('input', () => resetConfirm.setCustomValidity(''))
  resetNew.addEventListener('input', () => resetConfirm.setCustomValidity(''))
  document.getElementById('resetPasswordCancel').addEventListener('click', () => { if (!resettingPassword) resetDialog.close() })
  resetDialog.addEventListener('cancel', (e) => { if (resettingPassword) e.preventDefault() })
  resetDialog.addEventListener('close', () => { resetForm.reset(); resetAccount = null })
  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (resettingPassword || !resetAccount) return
    resetConfirm.setCustomValidity(resetNew.value === resetConfirm.value ? '' : 'Passwords do not match')
    if (!resetForm.reportValidity()) return
    resettingPassword = true
    resetSave.disabled = true
    resetError.textContent = ''
    try {
      // Re-read the role rather than trusting the account list from when this page opened.
      const current = (await usersApi('GET')).users.find((u) => u.name === resetAccount)
      if (!current) throw new Error('This account no longer exists. Reload the account list.')
      await usersApi('POST', '', { name: current.name, role: current.role, password: resetNew.value })
      uSay(`Password reset for ${current.name}`)
      resetDialog.close()
    } catch (err) { resetError.textContent = err.message }
    finally { resettingPassword = false; resetSave.disabled = false }
  })
  // the names on the list, so adding a viewer can tell a new account from a changed one
  let knownUsers = new Set()
  const loadUsers = async () => {
    const box = document.getElementById('usersSection')
    let users
    try { users = (await usersApi('GET')).users } catch { return } // not an admin: the section stays hidden
    box.hidden = false
    knownUsers = new Set(users.map((u) => u.name))
    document.getElementById('userRows').replaceChildren(...users.map((u) => {
      const tr = document.createElement('tr')
      const edit = el('button', { type: 'button', className: 'btn-ghost', textContent: 'Edit access' })
      edit.addEventListener('click', () => openAccess(u.name))
      const rm = document.createElement('button')
      rm.type = 'button'
      rm.className = 'btn-ghost'
      rm.textContent = 'Remove'
      rm.addEventListener('click', async () => {
        if (!confirm(`Remove the account ${u.name}? They can no longer sign in.`)) return
        try { await usersApi('DELETE', `/${encodeURIComponent(u.name)}`); uSay(`Removed ${u.name}`); loadUsers(); loadRights() } catch (e) { uSay(e.message, true) }
      })
      const name = document.createElement('td'); name.textContent = u.name
      const role = document.createElement('td'); role.textContent = u.role === 'admin' ? 'Admin' : 'Viewer'
      const connections = el('td')
      const sessions = Array.isArray(u.sessions) ? u.sessions : []
      if (!sessions.length) connections.textContent = 'Not connected'
      for (const session of sessions) connections.append(el('div', { textContent: `${session.connection} · ${session.address}` }))
      const kick = el('button', { type: 'button', className: 'btn-ghost', textContent: 'Sign out user', disabled: u.self === true })
      kick.setAttribute('aria-label', `Sign out all sessions for ${u.name}`)
      if (u.self) kick.title = 'Use Sign out in the sidebar for your own account'
      kick.addEventListener('click', async () => {
        kick.disabled = true
        try {
          await usersApi('POST', `/${encodeURIComponent(u.name)}/sign-out`, {})
          uSay(`Signed out ${u.name} from all sessions. They can sign in again.`)
          await loadUsers()
        } catch (e) { uSay(e.message, true); kick.disabled = false }
      })
      const reset = el('button', { type: 'button', className: 'btn-ghost', textContent: 'Reset password' })
      reset.setAttribute('aria-label', `Reset password for ${u.name}`)
      reset.addEventListener('click', () => openPasswordReset(u.name))
      const act = document.createElement('td'); act.className = 'ac-user-actions'; act.append(edit, reset, kick, rm)
      tr.append(name, role, connections, act)
      return tr
    }))
  }
  setInterval(() => { if (!document.hidden) void loadUsers() }, 30_000)
  document.getElementById('addUser')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = document.getElementById('u-name').value.trim()
    const password = document.getElementById('u-pass').value
    const role = document.getElementById('u-role').value
    const isNew = !knownUsers.has(name)
    try {
      await usersApi('POST', '', { name, role, ...(password ? { password } : {}) })
      document.getElementById('u-pass').value = ''
      uSay(`Saved ${name} (${role})`)
      await loadUsers()
      loadRights()
      // A new viewer can see nothing yet (users-api.mjs starts them with no rights), so the next
      // thing the admin needs is to say what they may see.
      if (isNew && role === 'viewer') openAccess(name)
    } catch (err) { uSay(err.message, true) }
  })
  loadUsers()

  // ---- the access editor ----
  // ac is the one open editing session: whose access, the tree it was opened against, the row as it
  // was loaded (for "unsaved changes"), the state being edited, and the boxes drawn for it.
  let ac = null
  let opening = null // the latest openAccess call: an older one answering late is ignored
  let meName = null
  const acDlg = id('accessDlg')
  const acSay = (text) => { id('ac-error').textContent = text; id('ac-error').hidden = !text }
  const getJson = async (path) => {
    const r = await fetch(path)
    const j = await r.json().catch(() => null)
    if (!r.ok || !j || j.error) throw new Error(j?.error ?? `the server answered ${r.status}`)
    return j
  }
  // fetch() throws a TypeError when it never reached the server: say that, not "Failed to fetch"
  const words = (e) => (e instanceof TypeError ? 'the server could not be reached' : e?.message || 'something went wrong')

  /** Paints the open session's current state: every box, the old grants, formats, warnings. */
  const paintAccess = () => {
    if (!ac) return
    const v = view(ac.state, ac.tree)
    id('ac-admin').checked = v.admin
    id('ac-adminNote').textContent = v.adminNote
    id('ac-adminNote').hidden = !v.admin
    id('ac-body').hidden = v.admin
    // parent: the site's cell, whose note a camera does not repeat (every camera of a site stored
    // as NVR playback only would otherwise say so twenty times over)
    const rowNotes = new Map() // target -> ['Live HD: no effect without Live', …] (the row header, on phones)
    const set = (col, target, cell, parent = null) => {
      const box = ac.boxes.get(`${col} ${target}`)
      if (!box) return
      box.cb.checked = cell.state === 'on'
      box.cb.indeterminate = cell.state === 'some'
      const note = parent && parent.note === cell.note ? '' : cell.note
      box.note.textContent = note
      box.cb.title = cell.note ? `${COLUMN_TITLES[col]}. ${cell.note}` : COLUMN_TITLES[col]
      if (note) rowNotes.set(target, [...(rowNotes.get(target) ?? []), `${COLUMN_LABELS[col]}: ${note}`])
    }
    for (const col of COLUMNS) {
      set(col, '*', v.all[col])
      for (const s of v.sites) {
        set(col, s.nvr, s.cells[col])
        for (const c of s.cameras) set(col, c.key, c.cells[col], s.cells[col])
      }
    }
    for (const [target, small] of ac.rowNotes) small.textContent = (rowNotes.get(target) ?? []).join(' · ')
    for (const f of v.formats) ac.formatBoxes.get(f.id).checked = f.on
    id('ac-kept').hidden = v.kept.length === 0
    id('ac-keptList').replaceChildren(...v.kept.map((k) => {
      const rm = el('button', { type: 'button', className: 'btn-ghost', textContent: 'Remove' })
      rm.setAttribute('aria-label', `Remove ${k.text}`)
      rm.addEventListener('click', () => { ac.state = dropKept(ac.state, k.target); paintAccess() })
      const text = el('span')
      text.append(el('b', { textContent: k.text }), ` · ${k.columns.join(', ')} · ${k.reason}`)
      const li = el('li')
      li.append(text, rm)
      return li
    }))
    const notes = [...v.warnings.map((w) => ['st-notice', w])]
    if (v.nothing) notes.push(['st-help', 'Nothing is ticked: they can sign in, but see no site and no camera.'])
    id('ac-warn').replaceChildren(...notes.map(([className, textContent]) => el('p', { className, textContent })))
    id('ac-dirty').textContent = sameRow(toRow(ac.state), ac.saved) ? '' : 'Unsaved changes'
  }

  /** The tree's rows, drawn once per opening; paintAccess only changes the boxes, so focus stays put. */
  const drawTree = () => {
    const v = view(ac.state, ac.tree)
    ac.boxes = new Map()
    ac.rowNotes = new Map() // target -> its row header's line of notes (shown on phones instead of per box)
    // the two header rows from the model, so the columns and their names cannot disagree
    id('ac-head').replaceChildren(...HEAD_ROWS.map((row) => {
      const tr = el('tr')
      for (const h of row) {
        const th = el('th', { textContent: h.text, className: h.column ? 'ac-col' : h.rowhead ? 'ac-rowhead' : 'ac-group' })
        th.scope = h.colspan ? 'colgroup' : 'col'
        if (h.rowspan) th.rowSpan = h.rowspan
        if (h.colspan) th.colSpan = h.colspan
        if (h.column) {
          th.title = COLUMN_TITLES[h.column]
          th.setAttribute('aria-label', COLUMN_LABELS[h.column])
        }
        tr.append(th)
      }
      return tr
    }))
    const cellTd = (col, target, what) => {
      const cb = el('input', { type: 'checkbox', title: COLUMN_TITLES[col] })
      cb.setAttribute('aria-label', `${COLUMN_LABELS[col]}: ${what}`)
      cb.addEventListener('change', () => { ac.state = click(ac.state, ac.tree, col, target); paintAccess() })
      const note = el('span', { className: 'ac-note' })
      const td = el('td')
      td.append(cb, note)
      ac.boxes.set(`${col} ${target}`, { cb, note })
      return td
    }
    const rowHead = (text, sub, target) => {
      const head = el('div', { className: 'ac-head' })
      const notes = el('small', { className: 'ac-row-notes' })
      ac.rowNotes.set(target, notes)
      head.append(el('span', { className: 'ac-name', textContent: text }), el('small', { textContent: sub }), notes)
      const th = el('th', { scope: 'row' })
      th.append(head)
      return th
    }
    const all = el('tr', { className: 'ac-all' })
    all.append(rowHead('All sites', 'everything, sites added later included', '*'), ...COLUMNS.map((c) => cellTd(c, '*', 'all sites')))
    const rows = [all]
    for (const s of v.sites) {
      const tr = el('tr', { className: 'ac-site' })
      const count = s.cameras.length ? `${s.cameras.length} camera${s.cameras.length === 1 ? '' : 's'}` : 'no cameras listed yet'
      const th = rowHead(s.site, `${s.name !== s.site ? `${s.name} · ` : ''}${count}`, s.nvr)
      const fold = el('button', { type: 'button', className: 'ac-fold', textContent: '▸' })
      fold.setAttribute('aria-label', `Cameras of ${s.site}`)
      fold.disabled = s.cameras.length === 0
      th.firstChild.prepend(fold)
      tr.append(th, ...COLUMNS.map((c) => cellTd(c, s.nvr, s.site)))
      rows.push(tr)
      const camRows = s.cameras.map((c) => {
        const cr = el('tr', { className: 'ac-cam' })
        cr.append(rowHead(c.name, `camera ${c.ch + 1}`, c.key), ...COLUMNS.map((col) => cellTd(col, c.key, `${c.name}, ${s.site}`)))
        return cr
      })
      // A site opens by itself when some of its cameras are ticked and some not: that is the
      // state an admin most needs to see. The rest stay folded, so five sites fit on a screen.
      const showCams = (open) => {
        fold.setAttribute('aria-expanded', String(open))
        for (const cr of camRows) cr.hidden = !open
      }
      showCams(COLUMNS.some((col) => s.cells[col].state === 'some' && s.cameras.some((c) => c.cells[col].state === 'on')))
      fold.addEventListener('click', () => showCams(fold.getAttribute('aria-expanded') !== 'true'))
      rows.push(...camRows)
    }
    id('ac-rows').replaceChildren(...rows)

    ac.formatBoxes = new Map()
    id('ac-formats').replaceChildren(...FORMATS.map((f) => {
      const cb = el('input', { type: 'checkbox' })
      cb.addEventListener('change', () => { ac.state = setFormat(ac.state, f, cb.checked); paintAccess() })
      ac.formatBoxes.set(f, cb)
      const label = el('label', { className: 'st-check' })
      label.append(cb, ` ${FORMAT_LABELS[f]}`)
      return label
    }))

    const copy = id('ac-copy')
    copy.replaceChildren(el('option', { value: '', textContent: 'choose someone' }), ...copySources(ac.users, ac.user).map((u) => el('option', { value: u, textContent: u })))
    copy.disabled = copy.options.length === 1
  }

  /** Opens the editor for one account, with the rights and the camera list as they are right now. */
  async function openAccess(user) {
    const mineCall = {}
    opening = mineCall
    ac = null
    id('ac-user').textContent = user
    id('ac-body').hidden = true
    id('ac-adminNote').hidden = true
    id('ac-dirty').textContent = ''
    id('ac-save').disabled = true
    id('ac-rows').replaceChildren()
    acSay('')
    id('ac-loading').hidden = false
    if (!acDlg.open) acDlg.showModal()
    try {
      // Admins are sent every NVR and every camera by these two, so the tree is the whole server.
      const [rights, sites, cameras] = await Promise.all([getJson('/api/admin/rights'), getJson('/api/sites'), getJson('/api/cameras')])
      if (opening !== mineCall) return
      const users = Array.isArray(rights.users) ? rights.users : []
      const mine = users.find((u) => u.user === user)
      if (!mine) throw new Error(`there is no account called ${user} any more`)
      const tree = buildTree(sites, cameras)
      const state = fromRow(mine, tree)
      // `seen`: the row's compare-and-swap token, sent back unchanged with Save (rights.mjs). Kept on
      // the session, not re-read at save time, because the whole point is to catch a change that
      // happened while this editor sat open.
      ac = { user, tree, state, saved: toRow(state), users, seen: mine.seen }
      drawTree()
      paintAccess()
      id('ac-save').disabled = false
    } catch (e) {
      if (opening !== mineCall) return
      acSay(`Could not open ${user}'s access: ${words(e)}. Close this and try again.`)
    } finally {
      if (opening === mineCall) id('ac-loading').hidden = true
    }
  }

  const acDirty = () => ac !== null && !sameRow(toRow(ac.state), ac.saved)
  const acLeave = () => !acDirty() || confirm(`Close without saving the changes to ${ac.user}'s access?`)
  id('ac-admin').addEventListener('change', (e) => { if (!ac) return; ac.state = setAdmin(ac.state, e.target.checked); paintAccess() })
  id('ac-everything').addEventListener('click', () => { if (!ac) return; ac.state = setAll(ac.state, true); paintAccess() })
  id('ac-nothing').addEventListener('click', () => { if (!ac) return; ac.state = setAll(ac.state, false); paintAccess() })
  id('ac-copy').addEventListener('change', (e) => {
    const from = ac?.users.find((u) => u.user === e.target.value)
    e.target.value = ''
    if (!from) return
    ac.state = copyFrom(ac.state, from, ac.tree)
    paintAccess()
    id('ac-dirty').textContent = `Copied from ${from.user}. Save to keep it.`
  })
  id('ac-cancel').addEventListener('click', () => { if (acLeave()) acDlg.close() })
  // Escape closes a <dialog> by itself: ask first when something would be lost
  acDlg.addEventListener('cancel', (e) => { if (!acLeave()) e.preventDefault() })
  id('acForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!ac) return
    const { user } = ac
    const rights = toRow(ac.state)
    const selfDemote = user === meName && ac.saved.admin && !rights.admin
    if (selfDemote && !confirm('You are switching off your own admin. As soon as this is saved you lose this page and every setting. Go ahead?')) return
    const save = id('ac-save')
    save.disabled = true
    save.setAttribute('aria-busy', 'true')
    acSay('')
    try {
      const r = await fetch('/api/admin/rights', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user, rights, seen: ac.seen }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        const f = saveRightsFailure(r.status, j)
        // A stale save (rights.mjs's compare-and-swap) means the row on screen is already wrong:
        // retrying would only resend it, so this is offered as a reopen, not a plain error to dismiss.
        if (f.stale) { if (confirm(`${f.message} Reopen ${user}'s access now?`)) await openAccess(user); else acSay(f.message) } else acSay(`Not saved: ${f.message}.`)
        return
      }
      ac = null
      acDlg.close()
      if (selfDemote) { location.reload(); return }
      uSay(`Saved ${user}'s access`)
      loadUsers()
      loadRights()
    } catch (err) {
      acSay(`Not saved: ${words(err)}.`)
    } finally {
      save.disabled = false
      save.removeAttribute('aria-busy')
    }
  })

  const loadRights = () =>
    fetch('/api/admin/rights')
      .then((x) => x.json())
      .then((d) => { if (!d.error) paintRights(d) })
      .catch(() => {})

  id('filters').addEventListener('submit', (e) => { e.preventDefault(); loadAudit() })
  id('reset').addEventListener('click', () => {
    for (const f of ['fUser', 'fFrom', 'fTo']) id(f).value = ''
    id('fAction').value = ''
    loadAudit()
  })

  fetch('/api/me')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('signed out'))))
    .then((me) => {
      id('whoami').textContent = me.user
      meName = me.user
      if (me.admin) { const st = id('sitesTab'); if (st) st.hidden = false; const se = id('settingsTab'); if (se) se.hidden = false }
      loadAudit()
      loadRights()
    })
    .catch(() => { location.href = '/login.html' })

  id('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' })
    location.href = '/login.html'
  })
}
