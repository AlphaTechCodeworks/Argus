// Sites page: "Find device" (admins). One box for a MAC, an address or a name; the server answers
// from what it already knows (find-device.mjs) and, on request, a TVT network search.
// The words are built by the pure functions below (tested in test/find-device.test.mjs); the
// dialog wiring is setupFindDevice, which only runs when the page calls it.

/** "14 Oct, 02:00" in this browser's time (the year too when it is not this year). */
export function whenText(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return 'an unknown time'
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit' })
}

/** How a row was found, in words: "the Cameras report of 14 Oct, 02:00 and the server’s network table". */
export function foundByText(sources, looked = {}, now = Date.now()) {
  const words = {
    report: looked.report ? `the Cameras report of ${whenText(looked.report.at, now)}` : 'the Cameras report',
    live: 'the recorder’s camera list now',
    recorders: 'the app’s recorder list',
    arp: 'the server’s network table',
    search: looked.search ? `the network search of ${whenText(looked.search.at, now)}` : 'a network search'
  }
  const order = ['recorders', 'live', 'report', 'arp', 'search']
  const list = order.filter((s) => (sources ?? []).includes(s)).map((s) => words[s])
  if (list.length === 0) return ''
  return list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`
}

/** Where the server looked, for "Nothing matches" (and under every answer, small). */
export function lookedText(looked = {}, now = Date.now()) {
  const parts = []
  const r = looked.report
  parts.push(r ? `the Cameras report of ${whenText(r.at, now)} (${r.cameras} cameras on ${r.recorders} recorders)` : 'no Cameras report yet (Reports → Cameras makes one, and it is redone every night)')
  const l = looked.live
  if (l) parts.push(`the recorders’ camera lists now (${l.cameras} cameras on ${l.recorders} recorders)`)
  const a = looked.arp
  if (a) parts.push(a.ok ? `the server’s network table (${a.devices} devices)` : `not the server’s network table (${a.why || 'not available'})`)
  const s = looked.search
  if (!s) parts.push('no network search (use “Search the network too”)')
  else if (s.ran) parts.push(`the network search of ${whenText(s.at, now)} (${s.devices} devices answered)`)
  else parts.push(`not the network: the search did not run (${s.why || 'unknown reason'})`)
  return `Looked in ${parts.join('; ')}.`
}

/** The row's title, place and facts, as plain strings. */
export function rowText(r) {
  const title = r.kind === 'recorder' ? `Recorder ${r.label}` : r.label
  const place = r.kind === 'camera' ? [r.site, r.nvrName && r.nvrName !== r.site ? `recorder ${r.nvrName}` : r.nvrName ? 'its recorder' : null].filter(Boolean).join(' · ')
    : r.kind === 'recorder' ? r.site || ''
    : 'On the server’s own network'
  const status = r.online === null || r.online === undefined ? null
    : r.kind === 'recorder' ? (r.online ? 'connected' : 'not connected')
    : r.online ? 'online' : 'offline'
  const facts = [
    r.address ? `address ${r.address}` : 'address not known',
    r.mac ? `MAC ${r.mac}` : 'MAC not known',
    r.model,
    r.type && r.type !== r.model ? r.type : null,
    r.poe ? 'on a PoE port' : null,
    status
  ].filter(Boolean)
  return { title, place, facts: facts.join(' · '), status }
}

/** Where a row's button goes: a camera full size in Live, a recorder on this page; null for a loose device. */
export function openTarget(r) {
  if (r.kind === 'camera' && r.nvr && Number.isInteger(r.ch)) return { href: `/?nvr=${encodeURIComponent(r.nvr)}&ch=${encodeURIComponent(r.ch)}`, text: 'Open in Live' }
  if (r.kind === 'recorder' && r.nvr) return { nvr: r.nvr, text: 'Show' }
  return null
}

/**
 * Wires the dialog. `api(method, path, body, timeoutMs)` and `el(tag, props, ...children)` come from
 * sites.js; `showRecorder(id)` scrolls the page to that recorder.
 */
export function setupFindDevice({ api, el, showRecorder }) {
  const $ = (id) => document.getElementById(id)
  const dialog = $('fd')
  const input = $('fd-q')
  const status = $('fd-status')
  const notes = $('fd-notes')
  const list = $('fd-results')
  const buttons = [$('fd-go'), $('fd-search')]
  let seq = 0

  async function run(search) {
    const q = input.value.trim()
    if (q.length < 2) {
      input.reportValidity()
      return
    }
    const mine = ++seq
    for (const b of buttons) b.disabled = true
    status.textContent = search ? 'Searching the network… a few seconds.' : 'Looking…'
    try {
      const r = await api('GET', `/api/admin/find-device?q=${encodeURIComponent(q)}${search ? '&search=1' : ''}`, undefined, search ? 30_000 : 8000)
      if (mine !== seq) return
      show(r)
    } catch (e) {
      if (mine !== seq) return
      status.textContent = e.message
      notes.replaceChildren()
      list.replaceChildren()
    } finally {
      if (mine === seq) for (const b of buttons) b.disabled = false
    }
  }

  function show(r) {
    const n = r.results.length
    status.textContent = n === 0 ? `Nothing matches “${r.query}”.` : `${n + r.more} match${n + r.more === 1 ? '' : 'es'}${r.more ? `, the first ${n} shown: type more to narrow it down` : ''}.`
    const lines = [...r.notes]
    const search = r.looked?.search
    if (search?.now && !search.ran) lines.unshift(`The network search did not run: ${search.why || 'unknown reason'}.`)
    notes.replaceChildren(
      ...lines.map((t) => el('p', { className: 'st-warn-text', textContent: t })),
      el('p', { className: 'st-meta', textContent: lookedText(r.looked) })
    )
    list.replaceChildren(...r.results.map((row) => item(row, r.looked)))
  }

  function item(r, looked) {
    const t = rowText(r)
    const target = openTarget(r)
    let action = null
    if (target?.href) action = el('a', { className: 'btn', href: target.href, textContent: target.text })
    else if (target?.nvr) {
      action = el('button', { type: 'button', textContent: target.text })
      action.addEventListener('click', () => {
        dialog.close()
        showRecorder(target.nvr)
      })
    }
    if (action) action.setAttribute('aria-label', `${target.text}: ${t.title}`)
    const by = foundByText(r.sources, looked)
    return el(
      'li',
      { className: `st-found-item${r.online === false ? ' fd-off' : ''}` },
      el('div', { className: 'st-found-main' },
        el('strong', { textContent: t.title }),
        t.place ? el('span', { className: 'st-meta', textContent: t.place }) : null,
        el('span', { className: 'st-meta fd-facts', textContent: t.facts }),
        by ? el('span', { className: 'st-found-by', textContent: `Found in ${by}` }) : null,
        r.note ? el('span', { className: 'fd-note', textContent: r.note }) : null),
      action
    )
  }

  $('fd-form').addEventListener('submit', (e) => {
    e.preventDefault()
    run(false)
  })
  $('fd-search').addEventListener('click', () => run(true))
  $('fd-close').addEventListener('click', () => dialog.close())
  $('findDevice').addEventListener('click', () => {
    dialog.showModal()
    input.focus()
    input.select()
  })
}
