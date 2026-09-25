// The Audit page: the trail on the left, the rights screen on the right.
//
// renderAudit() and renderRights() are pure — they turn what the API answered into exactly what
// the page shows and nothing else — so they can be tested without a browser, the same split
// health.js and pb-sources.js use. The DOM code at the bottom only paints and only runs in a page.
//
// One deliberate choice about filtering: the filters are sent to the server and applied there,
// not applied in the browser. The browser never receives rows the signed-in admin is not entitled
// to see, so a filter cannot be "removed" with the developer tools to reveal more.

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
  const actions = (Array.isArray(d?.actions) ? d.actions : []).filter((a) => a !== 'admin')
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
    formats,
    users,
    admins,
    // The rule saveRights() enforces, said on the page so nobody discovers it as an error message.
    note: admins.length <= 1
      ? `${admins.length === 1 ? `${admins[0]} is` : 'Nobody is'} the only admin. The last admin cannot be removed here — make someone else an admin first.`
      : `${admins.length} admins: ${admins.join(', ')}.`
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
    const head = el('tr')
    for (const h of ['User', 'Admin', ...r.actions, 'Export formats']) head.append(el('th', { textContent: h }))
    id('rightsHead').replaceChildren(head)
    id('rightsRows').replaceChildren(...r.users.map((u) => {
      const tr = el('tr')
      tr.append(el('td', { textContent: u.user }))
      tr.append(el('td', { textContent: u.admin ? 'yes' : 'no', className: u.admin ? 'warn' : '' }))
      for (const c of u.cells) tr.append(el('td', { textContent: c.text }))
      tr.append(el('td', { textContent: u.formatText }))
      return tr
    }))
  }

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
      if (me.admin) { id('sitesTab').hidden = false; id('settingsTab').hidden = false }
      loadAudit()
      loadRights()
    })
    .catch(() => { location.href = '/login.html' })

  id('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' })
    location.href = '/login.html'
  })
}
