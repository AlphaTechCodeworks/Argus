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

/** "1.4 GB", "930 MB": two significant-ish digits, because these sit under a card's label. */
const bytes = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** Network is quoted in bits, not bytes: every link, switch and camera is rated in Mbps. */
const bitsPerSec = (bytesPerSec) => {
  if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return null
  const bits = bytesPerSec * 8
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gbps`
  if (bits >= 1e6) return `${Math.round(bits / 1e6)} Mbps`
  if (bits >= 1e3) return `${Math.round(bits / 1e3)} kbps`
  return `${Math.round(bits)} bps`
}

/**
 * The machine itself. Every figure can be null: on the first poll after a restart the rates have
 * no previous sample to subtract, and on a host without /proc nothing is readable at all. Null is
 * shown as an em dash rather than as a zero, because "0 Mbps" on a server pulling a dozen camera
 * streams is a figure somebody would act on.
 */
function systemCards(sys) {
  const s = sys ?? {}
  const cpuPct = s.cpu?.percent
  const cpu = {
    label: 'CPU',
    value: Number.isFinite(cpuPct) ? `${Math.round(cpuPct)} %` : '—',
    state: !Number.isFinite(cpuPct) ? 'ok' : cpuPct >= 95 ? 'bad' : cpuPct >= 80 ? 'warn' : 'ok',
    note: [
      Number.isFinite(s.cpu?.load1) ? `load ${s.cpu.load1.toFixed(2)}` : null,
      Number.isFinite(s.cpu?.cores) ? `${s.cpu.cores} cores` : null
    ].filter(Boolean).join(' · ')
  }

  const total = s.memory?.total
  const used = s.memory?.used
  const avail = s.memory?.available
  const availPct = Number.isFinite(total) && Number.isFinite(avail) && total > 0 ? (avail / total) * 100 : null
  const memory = {
    label: 'Memory',
    value: Number.isFinite(used) && Number.isFinite(total) ? `${bytes(used)} of ${bytes(total)}` : '—',
    // Available, not free: Linux "free" counts the page cache as used and always looks alarming.
    state: availPct === null ? 'ok' : availPct < 5 ? 'bad' : availPct < 10 ? 'warn' : 'ok',
    note: Number.isFinite(avail) ? `${bytes(avail)} available` : ''
  }

  const rx = bitsPerSec(s.network?.rxBytesPerSec)
  const tx = bitsPerSec(s.network?.txBytesPerSec)
  const network = {
    label: 'Network',
    value: rx === null && tx === null ? '—' : `↓ ${rx ?? '—'} ↑ ${tx ?? '—'}`,
    state: 'ok',
    note: 'all interfaces except loopback'
  }

  const w = s.disk?.writeBytesPerSec
  const disk = {
    label: 'Disk write',
    value: Number.isFinite(w) ? `${(w / 1e6).toFixed(1)} MB/s` : '—',
    state: 'ok',
    note: 'across the real block devices'
  }

  const g = s.gpu
  const gpu = {
    label: 'GPU',
    value: g && Number.isFinite(g.percent) ? `${Math.round(g.percent)} %` : 'None detected',
    state: 'ok',
    note: g && Number.isFinite(g.memUsed) && Number.isFinite(g.memTotal) ? `${g.name ?? ''} · ${bytes(g.memUsed)} of ${bytes(g.memTotal)}`.trim() : g?.name ?? ''
  }

  return { cpu, memory, network, disk, gpu }
}

/**
 * @param {object} d the body of GET /api/health
 * @returns {{ cards: object, systemCards: object, nvrRows: object[], historyRows: object[], bannerText: string, sendingProblem: string }}
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

  return { cards, systemCards: systemCards(d.system), nvrRows, historyRows, bannerText, sendingProblem }
}

// ---- the page itself (skipped when a test imports this module: there is no document) ------------
if (typeof document !== 'undefined' && document.getElementById('cards')) {
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props)

  const paint = (d) => {
    const r = renderHealth(d)

    const paintCards = (id, cards) => {
      const host = document.getElementById(id)
      if (!host) return
      host.replaceChildren(...Object.values(cards).map((c) => {
        const node = el('div', { className: `card ${c.state}` })
        node.append(
          el('div', { className: 'lbl', textContent: c.label }),
          el('div', { className: 'big', textContent: c.value }),
          el('div', { className: 'note', textContent: c.note ?? '' })
        )
        return node
      }))
    }
    paintCards('cards', r.cards)
    paintCards('system', r.systemCards)

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

  // The same account wiring every page does: who is signed in, and the admin-only tabs.
  fetch('/api/me')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('signed out'))))
    .then((me) => {
      document.getElementById('whoami').textContent = me.user
      if (me.admin) {
        document.getElementById('sitesTab').hidden = false
        document.getElementById('settingsTab').hidden = false
      }
    })
    .catch(() => { location.href = '/login.html' })

  document.getElementById('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' })
    location.href = '/login.html'
  })

  const load = () => fetch('/api/health').then((x) => x.json()).then(paint).catch(() => {})
  load()
  setInterval(load, 15_000)
}
