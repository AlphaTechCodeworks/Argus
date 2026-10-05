// The Health page. renderHealth() shapes what /api/health answers into what the page shows, and
// is pure so it can be tested without a browser (the same split pb-sources.js uses for playback);
// the DOM code at the bottom only paints. alert-banner.js reuses bannerText on every other page,
// which is why the banner wording lives here rather than in the page.
import { smartRows, smartSummary } from './smart-view.js'

// Absolute times are shown on the site's wall clock, not the viewing PC's zone (a screen set to UTC
// otherwise showed UTC): add the site offset, then read it back as UTC. siteTzMs is set from
// /api/health (server site-time.mjs) at the top of renderHealth; until then it is this browser's.
let siteTzMs = -new Date().getTimezoneOffset() * 60_000
const hhmm = (ms) => new Date(ms + siteTzMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })

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
    pct: Number.isFinite(cpuPct) ? cpuPct : null,
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
    pct: Number.isFinite(used) && Number.isFinite(total) && total > 0 ? (used / total) * 100 : null,
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
    // The reading was kept from an earlier poll when this one's queryDiskSmartInfo did not come back
    // over P2P (nvr-disks.mjs carrySmart); say so and how old, so it is never read as live.
    const carried = s && (st?.stale || (Number.isFinite(disk.smartAt) && Number.isFinite(st?.at) && disk.smartAt < st.at - 60_000))
    const ageNote = !carried ? null : !Number.isFinite(disk.smartAt) ? 'earlier reading'
      : (() => { const m = Math.max(0, Math.round((Date.now() - disk.smartAt) / 60_000)); return `as of ${m < 60 ? `${m} min` : `${Math.round(m / 60)} h`} ago` })()
    const health = !s
      ? NOT_AVAILABLE
      : [
          s.verdict === 'lowHealth' ? 'Low health' : s.verdict ? s.verdict[0].toUpperCase() + s.verdict.slice(1) : 'Unknown',
          Number.isFinite(s.temperature) ? `${s.temperature} °C` : null,
          Number.isFinite(s.powerOnDays) ? `${s.powerOnDays} days on` : null,
          ageNote
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
    // what the folded tile shows: the few numbers that say whether this NVR is all right
    glance: {
      cameras: { value: `${camerasOnline} / ${mine.length}`, pct: mine.length ? (camerasOnline / mine.length) * 100 : 0, state: mine.length && camerasOnline === mine.length ? 'ok' : 'warn' },
      holds: { value: Number.isFinite(held) ? `${held} days` : '—', state: retention.state },
      disks: { value: disks.value, state: disks.state },
      load: bw ? { value: `${bw.pct} %`, pct: bw.pct, state: bw.pct >= 85 ? 'bad' : bw.pct >= 65 ? 'warn' : 'ok' } : null
    },
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
      // How far its own recordings go back -- for a recorder that overwrites the oldest, this is both
      // what it holds now and, near enough, how many days it will keep. The shortest disk sets it.
      { label: 'Recording held', value: Number.isFinite(st?.days) ? `${st.days} day${st.days === 1 ? '' : 's'}` : NOT_AVAILABLE, state: Number.isFinite(st?.days) && st.days < 3 ? 'warn' : 'ok' },
      { label: 'Disks read', value: st ? `${ago(nowMs - st.at)}` : NOT_AVAILABLE }
    ]
  }
}

/**
 * @param {object} d the body of GET /api/health
 * @returns {{ cards: object, systemCards: object, nvrRows: object[], nvrPanels: object[], historyRows: object[], bannerText: string, sendingProblem: string }}
 */
export function renderHealth(d) {
  if (Number.isFinite(d?.siteTzMin)) siteTzMs = d.siteTzMin * 60_000 // show times on the site's clock
  const cameras = d.cameras ?? []
  const nvrs = d.nvrs ?? []
  const loc = d.locations?.[0] ?? null
  const recording = cameras.filter((c) => c.recording && c.online).length

  // The drive is stated as "used", not "free": people think in how full a disk is.
  const drive = !loc
    ? { value: 'None set', state: 'warn', note: 'No recording location is configured.' }
    : loc.mounted === null
      ? { value: 'Checking…', state: 'warn', note: `${loc.name}: being checked after a restart.` }
    : !loc.mounted
      ? { value: 'Not mounted', state: 'bad', note: `${loc.name}: nothing can be recorded.` }
      : { value: `${Math.round(100 - loc.freePct)} % used`, state: loc.freePct <= loc.lowFreePct ? 'bad' : 'ok', note: loc.name, pct: 100 - loc.freePct }

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
      pct: cameras.length ? (recording / cameras.length) * 100 : null,
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

  // Recording storage gone is not one problem among several: the server is saving nothing. It gets
  // its own line, above everything, on every page (alert-banner.js).
  const locs = d.locations ?? []
  const down = locs.filter((l) => l.mounted === false) // null: not checked yet since a restart
  const criticalText = down.length === 0
    ? ''
    : down.length === locs.length
      ? `Recording stopped: ${down.map((l) => l.name).join(', ')} ${down.length === 1 ? 'is' : 'are'} not mounted. Nothing is being saved to the server; the NVRs are still recording to their own disks.`
      : `${down.map((l) => l.name).join(', ')} ${down.length === 1 ? 'is' : 'are'} not mounted: recordings for ${down.length === 1 ? 'it' : 'them'} have moved to the other locations, or stopped.`

  const open = (d.open ?? []).filter((a) => !(criticalText && a.kind === 'drive-missing'))
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

  // Who holds the keys, from rights.mjs adminList() by way of /api/health. Worth a line on the
  // page everyone already looks at: an admin account nobody remembers creating is the sort of
  // thing that is only ever noticed if it is put somewhere in plain sight.
  const admins = Array.isArray(d.admins) ? d.admins.filter((a) => typeof a === 'string' && a).slice().sort() : []
  const adminText = admins.length === 0
    ? 'No admins — nobody can change settings. Create one with adduser.mjs.'
    : `${admins.length} ${admins.length === 1 ? 'admin' : 'admins'}: ${admins.join(', ')}`
  const adminState = admins.length === 0 ? 'bad' : admins.length > 4 ? 'warn' : 'ok'

  // the headline at the top of the page: one sentence and a colour
  const overall = criticalText
    ? { state: 'bad', text: criticalText.startsWith('Recording stopped') ? 'Recording stopped' : 'Storage not mounted', note: criticalText.replace(/^Recording stopped: /, '') }
    : open.length
      ? { state: 'warn', text: `${open.length} ${open.length === 1 ? 'thing needs' : 'things need'} a look`, note: '' }
      : { state: 'ok', text: 'Everything is working', note: 'All NVRs, cameras and storage are as they should be.' }
  const openAlerts = open.map((a) => ({ title: a.title, severity: a.severity ?? 'medium' }))
  // remote viewing: what goes out over the internet, who is watching from outside and at what
  // frame rate, and what the video conversions cost the server
  const vw = d.viewing
  const mbps = (bps) => `${((bps ?? 0) * 8 / 1e6).toFixed(1)} Mb/s`
  const levels = vw ? Object.entries(vw.remote.viewers.reduce((m, v) => ((m[v.level] = (m[v.level] ?? 0) + 1), m), {})).map(([l, n]) => `${n} at ${l === 'full' ? 'full' : `${l} fps`}`).join(' · ') : ''
  const running = vw ? vw.conversions.playback.running + vw.conversions.phones.running : 0 // phones and remote viewers share one pool
  const cap = vw ? vw.conversions.playback.cap + vw.conversions.phones.cap : 0
  const cpu = vw?.conversions.cpu?.percent
  const viewingCards = !vw ? null : {
    people: {
      label: 'People connected',
      value: String(vw.people?.people ?? 0),
      state: 'ok',
      note: `${vw.people?.local ?? 0} on the network · ${vw.people?.remote ?? 0} over the internet`
    },
    internet: {
      label: 'Out to the internet',
      value: mbps(vw.traffic.internet.bps),
      state: vw.remote.budgetBps && vw.traffic.internet.bps > vw.remote.budgetBps * 0.9 ? 'warn' : 'ok',
      pct: vw.remote.budgetBps ? (vw.traffic.internet.bps / vw.remote.budgetBps) * 100 : null,
      note: `of ${mbps(vw.remote.budgetBps)} allowed · ${vw.traffic.internet.sockets} stream${vw.traffic.internet.sockets === 1 ? '' : 's'}`
    },
    local: { label: 'On the local network', value: mbps(vw.traffic.local.bps), state: 'ok', note: `${vw.traffic.local.sockets} stream${vw.traffic.local.sockets === 1 ? '' : 's'}` },
    remote: {
      label: 'Remote viewers',
      value: String(vw.remote.viewers.length),
      state: 'ok',
      note: levels || 'nobody watching from outside'
    },
    encoding: {
      label: 'Video conversions',
      value: `${running} running`,
      state: cap && running >= cap ? 'warn' : Number.isFinite(cpu) && cpu > 300 ? 'warn' : 'ok',
      pct: cap ? (running / cap) * 100 : null,
      note: `of ${cap} allowed${Number.isFinite(cpu) ? ` · ${cpu} % of a core` : ''}`
    }
  }
  return { overall, openAlerts, viewingCards, cards, systemCards: systemCards(d.system), nvrRows, nvrPanels, historyRows, bannerText, criticalText, sendingProblem, admins, adminText, adminState }
}

// ---- the page itself (skipped when a test imports this module: there is no document) ------------
if (typeof document !== 'undefined' && document.getElementById('cards')) {
  const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props)
    node.append(...kids.filter((k) => k !== null && k !== undefined && k !== ''))
    return node
  }
  /** A thin bar, filled to pct, coloured by state. */
  const meter = (pct, state = 'ok') => {
    const bar = el('span', { className: `hp-meter ${state}` })
    bar.append(el('span', { style: `width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%` }))
    return bar
  }

  // The NVR's own event log (nvr-log.mjs), fetched on demand and cached, since the page repaints
  // every 2 s and this query is heavier than the rest. Admins only (the endpoint refuses others).
  let isAdmin = false
  const LOG_FRESH_MS = 60_000
  const logCache = new Map() // nvr id -> { at, items } | { at, error }
  const renderLog = (body, entry) => {
    if (entry.error) return body.replaceChildren(el('p', { className: 'hp-sub', textContent: `Could not load: ${entry.error}` }))
    if (!entry.items.length) return body.replaceChildren(el('p', { className: 'hp-sub', textContent: 'No events in the last 24 h.' }))
    const tb = el('tbody')
    for (const it of entry.items.slice(0, 60)) {
      tb.append(el('tr',
        {},
        el('td', { textContent: Number.isFinite(it.atMs) ? hhmm(it.atMs) : '' }),
        el('td', { textContent: it.camera || (Number.isFinite(it.ch) ? `Camera ${it.ch + 1}` : '') }),
        el('td', { textContent: it.content || it.type || '' })))
    }
    body.replaceChildren(el('table', { className: 'hp-table' }, tb))
  }
  const loadLog = async (body, id) => {
    const hit = logCache.get(id)
    if (hit && Date.now() - hit.at < LOG_FRESH_MS) return renderLog(body, hit)
    body.replaceChildren(el('p', { className: 'hp-sub', textContent: 'Loading…' }))
    try {
      const res = await fetch(`/api/admin/nvrs/${encodeURIComponent(id)}/log`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      const entry = { at: Date.now(), items: Array.isArray(data.items) ? data.items : [] }
      logCache.set(id, entry)
      renderLog(body, entry)
    } catch (e) {
      const entry = { at: Date.now(), error: e.message }
      logCache.set(id, entry)
      renderLog(body, entry)
    }
  }

  const paint = (d) => {
    const r = renderHealth(d)

    const paintCards = (id, cards) => {
      const host = document.getElementById(id)
      if (!host) return
      host.replaceChildren(...Object.values(cards).map((c) => {
        const node = el('div', { className: `card ${c.state}` })
        node.append(
          el('div', { className: 'lbl', textContent: c.label }),
          el('div', { className: 'big', textContent: c.value })
        )
        if (Number.isFinite(c.pct)) node.append(meter(c.pct, c.state))
        node.append(el('div', { className: 'note', textContent: c.note ?? '' }))
        return node
      }))
    }
    // the headline: one colour and one sentence, then each open problem as a tag
    const hero = document.getElementById('hero')
    if (hero) {
      hero.className = `hp-hero ${r.overall.state}`
      const tags = el('div', { className: 'hp-hero-tags' })
      for (const a of r.openAlerts) tags.append(el('span', { className: `hp-tag ${a.severity === 'high' || a.severity === 'critical' ? 'bad' : 'warn'}`, textContent: a.title }))
      hero.replaceChildren(
        el('span', { className: 'hp-hero-dot' }),
        el('div', { className: 'hp-hero-text' }, el('strong', { textContent: r.overall.text }), el('span', { textContent: r.overall.note })),
        tags
      )
    }
    paintCards('cards', r.cards)
    paintCards('system', r.systemCards)
    if (r.viewingCards) paintCards('viewing', r.viewingCards)

    // Each NVR folded to a tile of the few numbers that matter; the full detail opens on a click.
    // Which ones are open is kept across the 15 s refresh.
    const wasOpen = new Set([...document.querySelectorAll('#nvrs details.nvr-panel[open]')].map((x) => x.dataset.id))
    const logOpen = new Set([...document.querySelectorAll('#nvrs details.hp-log[open]')].map((x) => x.dataset.id))
    // ...and so is each disk's SMART report: the 2 s refresh rebuilt it closed a moment after it
    // was opened (the owner: "why does the SMART report drop down not stay open?")
    const smartOpen = new Set([...document.querySelectorAll('#nvrs details.hp-smart[open]')].map((x) => x.dataset.key))
    document.getElementById('nvrs').replaceChildren(...r.nvrPanels.map((n) => {
      const panel = el('details', { className: `nvr-panel nvr-tile ${n.status.state}` })
      panel.dataset.id = n.id
      panel.open = wasOpen.has(n.id)
      const g = n.glance
      const stat = (label, x, withBar) => {
        const box = el('div', { className: `nvr-stat ${x?.state ?? ''}` }, el('span', { className: 'lbl', textContent: label }), el('span', { className: 'val', textContent: x?.value ?? '—' }))
        if (withBar && Number.isFinite(x?.pct)) box.append(meter(x.pct, x.state))
        return box
      }
      const summary = el('summary', { className: 'nvr-sum' },
        el('div', { className: 'nvr-sum-head' },
          el('span', { className: `hp-dot ${n.status.state}` }),
          el('strong', { textContent: n.name }),
          el('span', { className: `pill ${n.status.state}`, textContent: n.status.value })),
        el('div', { className: 'nvr-stats' }, stat('Cameras', g.cameras, true), stat('Disks hold', g.holds), stat('Disks', g.disks), stat('Load', g.load, true)),
        n.status.state !== 'ok' && n.status.note ? el('div', { className: 'nvr-why', textContent: n.status.note }) : '')
      const head = el('div', { className: 'nvr-head' })
      head.append(el('span', { className: 'hp-sub', textContent: `${n.id}${n.status.note ? ` · ${n.status.note}` : ''}` }))
      panel.append(summary)

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
            box.dataset.key = `${n.id}/${row.name}`
            box.open = smartOpen.has(box.dataset.key)
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

      // Maintenance: reboot or power the NVR off (admins only; the endpoint refuses others and offline
      // NVRs). Each is behind a confirm, since the whole site drops for a minute or two.
      if (isAdmin) {
        const doPower = async (action) => {
          const warn = action === 'reboot'
            ? `Reboot ${n.name}?\n\nEvery camera on it goes offline for 1–2 minutes while it restarts, and the NVR's own recording pauses until it is back.`
            : `Shut DOWN ${n.name}?\n\nIt powers OFF and CANNOT be turned back on remotely — someone must switch it on at the site.`
          if (!confirm(warn)) return
          try {
            const res = await fetch(`/api/admin/nvrs/${encodeURIComponent(n.id)}/power`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, confirm: true }) })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
            alert(data.message || 'Sent.')
          } catch (e) {
            alert(`Could not ${action === 'reboot' ? 'reboot' : 'shut down'} ${n.name}: ${e.message}`)
          }
        }
        const btn = (label, action, danger) => {
          const b = el('button', { type: 'button', textContent: label, style: `font:inherit;padding:.25rem .7rem;border-radius:6px;border:1px solid ${danger ? '#b4433a' : '#555'};background:transparent;color:${danger ? '#e06a5f' : 'inherit'};cursor:pointer;margin-right:.5rem` })
          b.addEventListener('click', () => doPower(action))
          return b
        }
        panel.append(el('div', { className: 'nvr-power', style: 'margin-top:.8rem;padding-top:.6rem;border-top:1px solid #333' },
          el('span', { className: 'hp-sub', textContent: 'Maintenance: ', style: 'margin-right:.5rem' }),
          btn('Reboot NVR', 'reboot', false),
          btn('Shut down', 'shutdown', true)))
      }

      // The NVR's own event log, read on demand (nvr-log.mjs; admins only). Kept behind a disclosure
      // so it is never in the way when you are just checking the site is up.
      if (isAdmin && n.status.state !== 'bad') {
        const logBox = el('details', { className: 'hp-log' })
        logBox.dataset.id = n.id
        const body = el('div', { className: 'hp-log-body' })
        logBox.append(el('summary', { textContent: 'Recent NVR events' }), body)
        logBox.open = logOpen.has(n.id)
        logBox.addEventListener('toggle', () => { if (logBox.open) loadLog(body, n.id) })
        if (logBox.open) loadLog(body, n.id)
        else body.append(el('p', { className: 'hp-sub', textContent: 'Open to load the NVR’s own log (last 24 h).' }))
        panel.append(logBox)
      }
      return panel
    }))

    document.getElementById('historyCount').textContent = `(${r.historyRows.length})`
    document.getElementById('history').replaceChildren(...r.historyRows.map((h) => {
      const tr = el('tr')
      for (const text of [h.title, h.started, h.cleared]) tr.append(el('td', { textContent: text }))
      return tr
    }))

    document.getElementById('sending').textContent = r.sendingProblem

    const adminBox = document.getElementById('admins')
    if (adminBox) {
      adminBox.textContent = r.adminText
      adminBox.className = `hp-note ${r.adminState}`
    }
  }

  // The same account wiring every page does: who is signed in, and the admin-only tabs.
  fetch('/api/me')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('signed out'))))
    .then((me) => {
      document.getElementById('whoami').textContent = me.user
      isAdmin = me.admin === true
      if (me.admin) {
        const sitesTab = document.getElementById('sitesTab'); if (sitesTab) sitesTab.hidden = false
        const settingsTab = document.getElementById('settingsTab'); if (settingsTab) settingsTab.hidden = false
        const at = document.getElementById('auditTab'); if (at) at.hidden = false
      }
    })
    .catch(() => { location.href = '/login.html' })

  document.getElementById('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' })
    location.href = '/login.html'
  })

  const load = () => fetch('/api/health').then((x) => x.json()).then(paint).catch(() => {})
  load()
  // live: every 2 s while the page is visible (a hidden tab asks nothing), with a dot that pulses at
  // each fresh answer and goes grey when the server stops answering
  const liveDot = document.createElement('span')
  liveDot.className = 'hp-live'
  liveDot.title = 'Updating live'
  liveDot.textContent = 'Live'
  document.querySelector('main')?.prepend(liveDot)
  let lastOk = 0
  const tick = async () => {
    if (document.hidden) return
    try {
      const r = await fetch('/api/health')
      if (!r.ok) throw new Error(String(r.status))
      paint(await r.json())
      lastOk = Date.now()
      liveDot.classList.remove('stale')
      liveDot.classList.remove('pulse')
      void liveDot.offsetWidth // restart the animation
      liveDot.classList.add('pulse')
    } catch {
      if (Date.now() - lastOk > 8000) liveDot.classList.add('stale')
    }
  }
  setInterval(tick, 2000)
  document.addEventListener('visibilitychange', tick)
}
