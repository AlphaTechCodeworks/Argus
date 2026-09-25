// The Health page. renderHealth() shapes what /api/health answers into what the page shows, and
// is pure so it can be tested without a browser (the same split pb-sources.js uses for playback);
// the DOM code at the bottom only paints. alert-banner.js reuses bannerText on every other page,
// which is why the banner wording lives here rather than in the page.

const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

/** "41 m" up to an hour, then "1 h 21 m": short enough to sit under a card's number. */
const dur = (ms) => {
  const m = Math.floor(ms / 60_000)
  return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h ${m % 60} m`
}

/**
 * @param {object} d the body of GET /api/health
 * @returns {{ cards: object, nvrRows: object[], historyRows: object[], bannerText: string, sendingProblem: string }}
 */
export function renderHealth(d) {
  const cameras = d.cameras ?? []
  const nvrs = d.nvrs ?? []
  const loc = d.locations?.[0] ?? null
  const recording = cameras.filter((c) => c.recording && c.online).length

  // The drive is stated as "used", not "free": people think in how full a disk is.
  const drive = !loc
    ? { value: 'None set', state: 'warn', note: 'No recording location is configured.' }
    : !loc.mounted
      ? { value: 'Not mounted', state: 'bad', note: `${loc.name}: nothing can be recorded.` }
      : { value: `${Math.round(100 - loc.freePct)} % used`, state: loc.freePct <= loc.lowFreePct ? 'bad' : 'ok', note: loc.name }

  const backup = d.backup?.at
    ? {
        value: hhmm(d.backup.at),
        state: d.backup.errors?.length ? 'warn' : 'ok',
        note: `${d.backup.written?.length ?? 0} ${(d.backup.written?.length ?? 0) === 1 ? 'copy' : 'copies'}${d.backup.errors?.length ? ` · ${d.backup.errors[0]}` : ''}`
      }
    : { value: 'None yet', state: 'warn', note: '' }

  const cards = {
    server: {
      label: 'Server',
      value: 'Running',
      state: 'ok',
      note: `up ${dur(d.now - d.startedMs)}${d.restartReason ? ` · last restart ${hhmm(d.startedMs)} (${d.restartReason})` : ''}`
    },
    drive: { label: 'Recording drive', ...drive },
    cameras: {
      label: 'Cameras recording',
      value: `${recording} / ${cameras.length}`,
      state: recording === cameras.length ? 'ok' : 'warn',
      note: `${cameras.filter((c) => !c.online).length} offline`
    },
    backup: { label: 'Last settings backup', ...backup }
  }

  const nvrRows = nvrs.map((n) => {
    const secs = Math.round((n.clockSkewMs ?? 0) / 1000)
    const mine = cameras.filter((c) => c.nvrId === n.id)
    return {
      id: n.id,
      name: n.name,
      status: n.loginError ? 'login refused' : n.online ? 'online' : 'offline',
      statusState: n.loginError || !n.online ? 'bad' : mine.some((c) => !c.online) ? 'warn' : 'ok',
      cameras: `${mine.filter((c) => c.online).length} / ${mine.length}`,
      recording: String(mine.filter((c) => c.recording && c.online).length),
      clock: `${secs > 0 ? '+' : ''}${secs} s`,
      clockState: Math.abs(secs) >= 30 ? 'warn' : 'ok',
      refusals: String(n.refusalsLast10Min ?? 0)
    }
  })

  // History: pair each "cleared" with the "opened" that came before it, so one episode is one row.
  // Walking newest first means a second episode of the same problem never swallows the first.
  const historyRows = []
  const awaitingOpen = new Map()
  for (const r of [...(d.history ?? [])].sort((a, b) => b.at - a.at)) {
    if (r.event === 'cleared') { awaitingOpen.set(r.key, r); continue }
    const closed = awaitingOpen.get(r.key)
    awaitingOpen.delete(r.key)
    historyRows.push({
      title: r.title,
      kind: r.kind,
      severity: r.severity,
      started: hhmm(r.at),
      cleared: closed ? hhmm(closed.at) : 'open',
      at: r.at
    })
  }
  historyRows.sort((a, b) => b.at - a.at)

  const open = d.open ?? []
  const bannerText = open.length === 0
    ? ''
    : `${open.length} ${open.length === 1 ? 'problem' : 'problems'}: ${open.map((a) => a.title).join(' · ')}`

  // Only the failure is shown, never the topic or the address it failed to reach: the ntfy topic
  // is effectively a password for the owner's phone.
  const s = d.sending ?? {}
  const sendingProblem = s.ntfyError
    ? `phone push failing: ${s.ntfyError}`
    : s.emailError
      ? `email failing: ${s.emailError}`
      : ''

  return { cards, nvrRows, historyRows, bannerText, sendingProblem }
}

// ---- the page itself (skipped when a test imports this module: there is no document) ------------
if (typeof document !== 'undefined' && document.getElementById('cards')) {
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props)

  const paint = (d) => {
    const r = renderHealth(d)

    document.getElementById('cards').replaceChildren(...Object.values(r.cards).map((c) =>
      el('div', { className: `card ${c.state}` }).appendChild(el('div', { className: 'lbl', textContent: c.label })).parentElement
    ))
    for (const [i, node] of [...document.getElementById('cards').children].entries()) {
      const c = Object.values(r.cards)[i]
      node.append(el('div', { className: 'big', textContent: c.value }), el('div', { className: 'note', textContent: c.note ?? '' }))
    }

    document.getElementById('nvrs').replaceChildren(...r.nvrRows.map((n) => {
      const tr = el('tr')
      const cells = [[`${n.id} · ${n.name}`, ''], [n.status, n.statusState], [n.cameras, ''], [n.recording, ''], [n.clock, n.clockState], [n.refusals, '']]
      for (const [text, cls] of cells) tr.append(el('td', { textContent: text, className: cls }))
      return tr
    }))

    document.getElementById('history').replaceChildren(...r.historyRows.map((h) => {
      const tr = el('tr')
      for (const text of [h.title, h.started, h.cleared]) tr.append(el('td', { textContent: text }))
      return tr
    }))

    document.getElementById('sending').textContent = r.sendingProblem
  }

  const load = () => fetch('/api/health').then((x) => x.json()).then(paint).catch(() => {})
  load()
  setInterval(load, 15_000)
}
