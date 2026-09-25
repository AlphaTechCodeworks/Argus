// The Health page. renderHealth() shapes what /api/health answers into what the page shows, and
// is pure so it can be tested without a browser (the same split pb-sources.js uses for playback);
// the DOM code at the bottom only paints. alert-banner.js reuses bannerText on every other page,
// which is why the banner wording lives here rather than in the page.
import { smartRows, smartSummary } from './smart-view.js'

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
 * Anything we did not manage to read says so in words. Never a zero, never a blank: the whole
 * point of this page is that it does not report good news it never actually checked.
 */
const NOT_AVAILABLE = 'not available'

/** "31 days", "not available". Days come from the NVR's own oldest and newest recording. */
const days = (n) => (Number.isFinite(n) ? `${n} ${n === 1 ? 'day' : 'days'}` : NOT_AVAILABLE)

/** "2 s ago", "4 m ago": how long ago a call from this NVR last came back. */
const ago = (ms) => {
  if (!Number.isFinite(ms)) return NOT_AVAILABLE
  if (ms < 1000) return 'just now'
  if (ms < 60_000) return `${Math.round(ms / 1000)} s ago`
  return `${dur(ms)} ago`
}

/** The site rule: an NVR is meant to hold at least this long by itself (streams.mjs MIN_RETENTION_DAYS). */
const MIN_NVR_DAYS = 30

/**
 * One NVR's panel: everything we can honestly say about it, and "not available" for the rest.
 * @param {object} n one entry of /api/health's `nvrs`
 * @param {object[]} mine that NVR's cameras (already filtered to real, configured channels)
 * @param {number} nowMs
 */
function nvrPanel(n, mine, nowMs) {
  const st = n.storage ?? null
  const secs = Math.round((n.clockSkewMs ?? 0) / 1000)
  const online = Boolean(n.online)
  const recording = mine.filter((c) => c.recording && c.online).length
  const camerasOnline = mine.filter((c) => c.online).length

  // Why it is not usable, in the order that matters: refused credentials are a different job from
  // a dead network, and an NVR that is merely cooling down is neither.
  const status = n.loginError
    ? { value: 'Login refused', state: 'bad', note: n.loginError }
    : !online
      ? {
          value: n.status === 'connecting' ? 'Connecting' : 'Offline',
          state: 'bad',
          // st.why carries the TCP probe's verdict when it was made: "did not answer ... within
          // 2000 ms" versus "answers on the network but is not logged in".
          note: st?.why || n.error || 'the server cannot reach it'
        }
      : n.cooling
        ? { value: 'Online, slow', state: 'warn', note: 'calls to it are overdue; new streams and playbacks are held back' }
        : { value: 'Online', state: 'ok', note: `last contact ${ago(n.lastContactMs)}` }

  // Disks. An NVR we could not ask says so; an NVR that answered "no disks" is a real fault, and
  // is exactly the silent failure this panel exists to catch.
  const diskRows = (st?.disks ?? []).map((disk) => {
    // A CCTV recorder fills its disk once and then overwrites the oldest footage for the rest of
    // its life, so zero free space is the normal, healthy state and "0 B free" reads as a fault
    // that is not there. What matters is that it is still writing, which the recording dates say.
    const cycling = Number.isFinite(disk.freeBytes) && disk.freeBytes === 0 && Number.isFinite(disk.days)
    const free = !Number.isFinite(disk.freeBytes) ? '' : cycling ? ' · overwriting oldest' : ` · ${bytes(disk.freeBytes)} free`
    // These NVRs do not answer the command that carries a disk's condition, so `status` is blank
    // on every one of them. Painting all four amber for ever is the alarm nobody reads. A disk
    // with recordings running up to today is observably writing -- that is evidence, not a guess,
    // and it is reported as what it is rather than as the condition the NVR would not give us.
    const writing = !disk.status && Number.isFinite(disk.days) && disk.days > 0
    // The drive's own SMART verdict. "read/write" only says the NVR is still using the disk; this
    // is the disk's own opinion of itself, and it is the earlier warning of the two.
    const s = disk.smart
    const health = !s
      ? NOT_AVAILABLE
      : [
          s.verdict === 'lowHealth' ? 'Low health' : s.verdict ? s.verdict[0].toUpperCase() + s.verdict.slice(1) : 'Unknown',
          Number.isFinite(s.temperature) ? `${s.temperature} °C` : null,
          Number.isFinite(s.powerOnDays) ? `${s.powerOnDays} days on` : null
        ].filter(Boolean).join(' · ')
    return {
      name: disk.name,
      status: disk.status || (writing ? 'Recording' : NOT_AVAILABLE),
      state: disk.state === 'unknown' ? (writing ? 'ok' : 'warn') : disk.state === 'busy' ? 'warn' : disk.state,
      detail: [disk.model, disk.serial].filter(Boolean).join(' · '),
      size: Number.isFinite(disk.totalBytes) ? `${bytes(disk.totalBytes)}${free}` : NOT_AVAILABLE,
      days: days(disk.days),
      health,
      healthState: s ? s.state : 'warn',
      // Why it is not green, in words rather than SMART attribute numbers nobody reads.
      concerns: s?.concerns ?? [],
      // The full SMART table, in readable form, behind a disclosure on the row.
      smartSummary: smartSummary(s),
      smartRows: smartRows(s)
    }
  })

  const disks = !st
    ? { value: NOT_AVAILABLE, state: 'warn', note: 'the NVR has not been asked yet' }
    : !st.available
      ? { value: NOT_AVAILABLE, state: 'warn', note: st.why || 'the NVR did not answer' }
      : diskRows.length === 0
        ? { value: 'No disk', state: 'bad', note: 'this NVR is keeping no copy of its own' }
        : st.worst === 'bad'
          ? { value: `${diskRows.filter((r) => r.state === 'bad').length} of ${diskRows.length} failed`, state: 'bad', note: 'its own copy of the recordings is at risk' }
          // the rows already worked out what each disk's state really is, including the disks
          // that are plainly recording but whose NVR will not name their condition
          : { value: `${diskRows.length} ${diskRows.length === 1 ? 'disk' : 'disks'}`, state: diskRows.every((r) => r.state === 'ok') ? 'ok' : 'warn', note: st.why || '' }

  const held = st?.available ? st.days : null
  const retention = {
    value: days(held),
    // Below the site's minimum is worth a colour, but an unknown figure is never green.
    state: !Number.isFinite(held) ? 'warn' : held < MIN_NVR_DAYS ? 'bad' : 'ok',
    note: Number.isFinite(held) ? `the site asks for at least ${MIN_NVR_DAYS}` : 'the NVR did not give its recording dates'
  }

  // The stream limit: nvr-2 refuses streams once it is full, which looks like a broken camera
  // unless the limit is on the page next to it.
  const maxCameras = st?.caps?.maxCameras
  const refused = n.refusalsLast10Min

  // The real reason an NVR turns a stream away. Each box shares one fixed budget between recording
  // and live viewing; when it is spent the next stream is refused, which on screen is indis-
  // tinguishable from a broken camera. nvr-2 runs at 128 Mb of 192 where nvr1 runs at 102, and
  // that alone is why one of them refuses and the other does not. Amber well before the ceiling:
  // by the time it is actually full, people have already been staring at black tiles.
  const totalMb = st?.caps?.totalBandwidthMbps
  const usedKb = st?.caps?.usedBandwidthKbps
  const bw = Number.isFinite(totalMb) && totalMb > 0 && Number.isFinite(usedKb)
    ? { used: Math.round((usedKb / 1024) * 10) / 10, total: totalMb, pct: Math.round((usedKb / 1024 / totalMb) * 100) }
    : null
  const windows = st?.caps?.maxPlaybackWindows

  return {
    id: n.id,
    name: n.name,
    status,
    disks,
    diskRows,
    retention,
    fields: [
      { label: 'Model', value: n.model || NOT_AVAILABLE },
      { label: 'Firmware', value: st?.caps?.firmware || NOT_AVAILABLE },
      { label: 'Serial', value: n.serial || NOT_AVAILABLE },
      { label: 'Address', value: n.host ? `${n.host}${n.via === 'p2p' ? ' (by serial)' : ''}` : NOT_AVAILABLE },
      {
        label: 'Cameras',
        value: `${camerasOnline} of ${mine.length}${Number.isFinite(maxCameras) ? ` (it takes ${maxCameras})` : ''}`,
        state: mine.length === 0 ? 'warn' : camerasOnline === mine.length ? 'ok' : 'warn'
      },
      { label: 'Recording here', value: `${recording} of ${mine.length}`, state: recording === mine.length ? 'ok' : 'warn' },
      { label: 'Streams in use', value: Number.isFinite(n.streams) ? String(n.streams) : NOT_AVAILABLE },
      {
        label: 'Bandwidth',
        value: bw ? `${bw.used} of ${bw.total} Mb (${bw.pct} %)` : NOT_AVAILABLE,
        // 65, not a rounder 75 or 80: nvr-2 was observed refusing streams at 67 % on 2026-09-25,
        // so a threshold above that would stay green through the very fault it exists to explain.
        state: !bw ? 'warn' : bw.pct >= 85 ? 'bad' : bw.pct >= 65 ? 'warn' : 'ok'
      },
      { label: 'Playback windows', value: Number.isFinite(windows) ? String(windows) : NOT_AVAILABLE },
      {
        label: 'Refused (10 min)',
        value: refused === null || refused === undefined ? 'not measured' : String(refused),
        state: !Number.isFinite(refused) ? 'warn' : refused >= 3 ? 'bad' : 'ok'
      },
      { label: 'Clock', value: `${secs > 0 ? '+' : ''}${secs} s`, state: Math.abs(secs) >= 30 ? 'warn' : 'ok' },
      { label: 'Last contact', value: ago(n.lastContactMs) },
      { label: 'Disks read', value: st ? `${ago(nowMs - st.at)}` : NOT_AVAILABLE }
    ]
  }
}

/**
 * @param {object} d the body of GET /api/health
 * @returns {{ cards: object, systemCards: object, nvrRows: object[], nvrPanels: object[], historyRows: object[], bannerText: string, sendingProblem: string }}
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
      // Nobody counted them is not the same as none happened, and this column used to say "0"
      // for a figure that was never measured at all.
      refusals: n.refusalsLast10Min === null || n.refusalsLast10Min === undefined ? NOT_AVAILABLE : String(n.refusalsLast10Min)
    }
  })

  const nvrPanels = nvrs.map((n) => nvrPanel(n, cameras.filter((c) => c.nvrId === n.id), d.now))

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

  return { cards, systemCards: systemCards(d.system), nvrRows, nvrPanels, historyRows, bannerText, sendingProblem }
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

    document.getElementById('nvrs').replaceChildren(...r.nvrPanels.map((n) => {
      const panel = el('section', { className: 'nvr-panel' })
      const head = el('div', { className: 'nvr-head' })
      head.append(
        el('h3', { textContent: `${n.id} · ${n.name}` }),
        el('span', { className: `pill ${n.status.state}`, textContent: n.status.value }),
        el('span', { className: 'nvr-why', textContent: n.status.note ?? '' })
      )

      const headline = el('div', { className: 'cards nvr-headline' })
      for (const c of [{ label: 'NVR disks', ...n.disks }, { label: 'It holds', ...n.retention }]) {
        const node = el('div', { className: `card ${c.state}` })
        node.append(
          el('div', { className: 'lbl', textContent: c.label }),
          el('div', { className: 'big', textContent: c.value }),
          el('div', { className: 'note', textContent: c.note ?? '' })
        )
        headline.append(node)
      }

      const facts = el('dl', { className: 'nvr-facts' })
      for (const f of n.fields) {
        facts.append(el('dt', { textContent: f.label }), el('dd', { textContent: f.value, className: f.state ?? '' }))
      }

      panel.append(head, headline, facts)

      if (n.diskRows.length) {
        const table = el('table', { className: 'hp-table nvr-disks' })
        const thead = el('thead')
        const hr = el('tr')
        for (const t of ['Disk', 'State', 'Health', 'Size', 'Recordings go back']) hr.append(el('th', { textContent: t }))
        thead.append(hr)
        const tbody = el('tbody')
        for (const row of n.diskRows) {
          const tr = el('tr')
          // The make and serial go under the disk's name: it is what an engineer needs to order a
          // replacement, and the only place in this system that knows it.
          const nameCell = el('td')
          nameCell.append(el('div', { textContent: row.name }))
          if (row.detail) nameCell.append(el('div', { className: 'hp-sub', textContent: row.detail }))
          tr.append(nameCell)
          const healthCell = el('td', { className: row.healthState })
          healthCell.append(el('div', { textContent: row.health }))
          // What is actually wrong, spelled out. A SMART attribute number tells nobody anything.
          for (const c of row.concerns) healthCell.append(el('div', { className: 'hp-sub', textContent: c }))
          for (const [text, cls, node] of [[row.status, row.state], [null, '', healthCell], [row.size, ''], [row.days, '']]) {
            tr.append(node ?? el('td', { textContent: text, className: cls }))
          }
          tbody.append(tr)

          // The full SMART report, behind a disclosure so the disk table stays readable. Closed by
          // default: two dozen attributes are what you want when you are investigating a disk, and
          // noise when you are checking whether the site is recording.
          if (row.smartRows.length) {
            const detail = el('tr', { className: 'hp-smart-row' })
            const cell = el('td')
            cell.colSpan = 5
            const box = el('details', { className: 'hp-smart' })
            box.append(el('summary', { textContent: `SMART report — ${row.name}${row.detail ? ` (${row.detail})` : ''}` }))

            // The few facts worth reading before the table.
            const sum = el('div', { className: 'hp-smart-summary' })
            for (const f of row.smartSummary) {
              const item = el('div', { className: 'hp-smart-fact' })
              item.append(el('div', { className: 'hp-sub', textContent: f.label }))
              item.append(el('div', { className: `hp-smart-value ${f.state}`, textContent: f.value }))
              if (f.note) item.append(el('div', { className: 'hp-sub', textContent: f.note }))
              sum.append(item)
            }
            box.append(sum)

            const t = el('table', { className: 'hp-table hp-smart-table' })
            const th = el('thead')
            const thr = el('tr')
            for (const h of ['#', 'Attribute', 'Reading', 'Value / limit', 'Type', 'What it means']) thr.append(el('th', { textContent: h }))
            th.append(thr)
            const tb = el('tbody')
            for (const a of row.smartRows) {
              const r = el('tr', { className: a.state === 'muted' ? 'hp-muted' : '' })
              r.append(el('td', { textContent: String(a.id) }))
              const nameCell = el('td', { textContent: a.name })
              // The five that actually predict a failure, marked so they are findable at a glance.
              if (a.key) nameCell.append(el('span', { className: 'hp-key', textContent: ' key' }))
              r.append(nameCell)
              r.append(el('td', { textContent: a.raw, className: a.state === 'bad' ? 'bad' : a.state === 'warn' ? 'warn' : '' }))
              r.append(el('td', { textContent: a.margin }))
              r.append(el('td', { textContent: a.kind }))
              r.append(el('td', { textContent: a.note, className: 'hp-sub' }))
              tb.append(r)
            }
            t.append(th, tb)
            box.append(t)
            cell.append(box)
            detail.append(cell)
            tbody.append(detail)
          }
        }
        table.append(thead, tbody)
        panel.append(table)
      }
      return panel
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
