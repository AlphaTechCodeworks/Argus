// Tests for the Health page's shaping (public/health.js renderHealth), no DOM.
// Run: node cctv/test/health-page.test.mjs
import { renderHealth } from '../public/health.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 25, 10, 0, 0)
// Times are shown in the server's local time (the spec), so expectations are derived the same
// way rather than hard-coded, or the tests would only pass in one time zone.
const at = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const data = (o = {}) => ({
  now: T0, startedMs: T0 - 3600_000, restartReason: null, open: [],
  locations: [{ id: 'usb', name: 'USB drive', mounted: true, freePct: 59, lowFreePct: 15 }],
  nvrs: [{ id: 'nvr1', name: 'Main site', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }],
  cameras: [{ nvrId: 'nvr1', ch: 0, name: 'Cashier Front', online: true, recording: true, lastSegmentMs: T0 }],
  sending: {}, history: [], ...o
})

// ---- cards -------------------------------------------------------------------------------------
{
  const r = renderHealth(data())
  check('no banner when all is well', r.bannerText === '', r.bannerText)
  check('the server card says running', r.cards.server.value === 'Running', JSON.stringify(r.cards.server))
  check('the drive card shows used, not free', r.cards.drive.value === '41 % used', r.cards.drive?.value)
  check('the camera card counts recording over total', r.cards.cameras.value === '1 / 1', r.cards.cameras?.value)
}
{
  const r = renderHealth(data({ locations: [{ id: 'usb', name: 'USB drive', mounted: false, freePct: 0, lowFreePct: 15 }] }))
  check('an unmounted drive says so', r.cards.drive.value === 'Not mounted', r.cards.drive?.value)
  check('and is marked bad', r.cards.drive.state === 'bad', r.cards.drive?.state)
}
{
  const r = renderHealth(data({ locations: [{ id: 'usb', name: 'USB drive', mounted: true, freePct: 9, lowFreePct: 15 }] }))
  check('a nearly full drive is marked bad', r.cards.drive.state === 'bad' && r.cards.drive.value === '91 % used', JSON.stringify(r.cards.drive))
}
{
  const r = renderHealth(data({ locations: [] }))
  check('no location at all is a warning, not a crash', r.cards.drive.state === 'warn' && r.cards.drive.value === 'None set', JSON.stringify(r.cards.drive))
}

// ---- banner ------------------------------------------------------------------------------------
{
  const r = renderHealth(data({ open: [{ key: 'a', kind: 'nvr-offline', title: 'nvr-2 is offline', detail: 'x', severity: 'high' }, { key: 'b', kind: 'nvr-clock', title: 'nvr1 clock is 220 s fast', detail: 'y', severity: 'medium' }] }))
  check('the banner counts the open alerts', r.bannerText.startsWith('2 problems'), r.bannerText)
  check('the banner names them', r.bannerText.includes('nvr-2 is offline') && r.bannerText.includes('220 s fast'), r.bannerText)
}
{
  const r = renderHealth(data({ open: [{ key: 'a', kind: 'x', title: 'one thing', detail: '', severity: 'high' }] }))
  check('one problem is singular', r.bannerText.startsWith('1 problem:'), r.bannerText)
}

// ---- NVR rows ----------------------------------------------------------------------------------
{
  const r = renderHealth(data({ nvrs: [{ id: 'nvr1', name: 'M', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 220_000 }] }))
  check('a skewed clock is shown in seconds with a sign', r.nvrRows[0].clock === '+220 s', r.nvrRows[0]?.clock)
  check('and marked as a warning', r.nvrRows[0].clockState === 'warn', r.nvrRows[0]?.clockState)
}
{
  const r = renderHealth(data({ nvrs: [{ id: 'n', name: 'M', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }] }))
  check('a good clock reads 0 s and is fine', r.nvrRows[0].clock === '0 s' && r.nvrRows[0].clockState === 'ok', JSON.stringify(r.nvrRows[0]))
}
{
  const r = renderHealth(data({ nvrs: [{ id: 'n', name: 'M', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: -2000 }] }))
  check('a slow clock keeps its minus sign', r.nvrRows[0].clock === '-2 s', r.nvrRows[0]?.clock)
}
{
  const r = renderHealth(data({ nvrs: [{ id: 'n', name: 'M', online: false, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }] }))
  check('an offline NVR reads offline and bad', r.nvrRows[0].status === 'offline' && r.nvrRows[0].statusState === 'bad')
}
{
  const r = renderHealth(data({ nvrs: [{ id: 'n', name: 'M', online: true, loginError: 'wrong password', refusalsLast10Min: 0, clockSkewMs: 0 }] }))
  check('a login failure beats online', r.nvrRows[0].status === 'login refused' && r.nvrRows[0].statusState === 'bad', JSON.stringify(r.nvrRows[0]))
}
{
  const r = renderHealth(data({
    nvrs: [{ id: 'nvr1', name: 'M', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }],
    cameras: [
      { nvrId: 'nvr1', ch: 0, name: 'a', online: true, recording: true, lastSegmentMs: T0 },
      { nvrId: 'nvr1', ch: 1, name: 'b', online: false, recording: true, lastSegmentMs: T0 },
      { nvrId: 'other', ch: 0, name: 'c', online: true, recording: true, lastSegmentMs: T0 }
    ]
  }))
  check('camera counts are per NVR', r.nvrRows[0].cameras === '1 / 2', r.nvrRows[0]?.cameras)
  check('an offline camera makes the NVR a warning', r.nvrRows[0].statusState === 'warn', r.nvrRows[0]?.statusState)
  check('recording counts only online cameras', r.nvrRows[0].recording === '1', r.nvrRows[0]?.recording)
}

// ---- the per-NVR panel ---------------------------------------------------------------------
//
// The rule this whole page now lives by: anything we did not actually read says "not available".
// A zero or a blank that looks like a healthy reading is worse than an admitted gap.
const nvrWith = (extra) => data({ nvrs: [{ id: 'nvr1', name: 'Main site', online: true, status: 'online', loginError: null, refusalsLast10Min: 0, clockSkewMs: 0, ...extra }] })
const field = (panel, label) => panel.fields.find((f) => f.label === label)
const storage = {
  at: T0 - 60_000,
  available: true,
  why: '',
  disks: [
    { name: 'disk1', slot: 1, status: 'read/write', state: 'ok', totalBytes: 4e12, freeBytes: 4.1e10, days: 33 },
    { name: 'disk2', slot: 2, status: 'exception', state: 'bad', totalBytes: 4e12, freeBytes: 0, days: 7 }
  ],
  days: 7,
  worst: 'bad',
  caps: { firmware: '1.4.5.2', maxCameras: 32 }
}
{
  const [p] = renderHealth(nvrWith({ storage, model: 'TD-3532H8', serial: 'SN123', host: '10.0.0.9', via: 'lan', streams: 12, lastContactMs: 800 })).nvrPanels
  check('the panel names the NVR', p.id === 'nvr1' && p.name === 'Main site')
  check('a failed disk is the headline and is marked bad', p.disks.state === 'bad' && p.disks.value === '1 of 2 failed', JSON.stringify(p.disks))
  check('each disk gets a row with its size and how far back it goes', p.diskRows.length === 2 && p.diskRows[1].status === 'exception' && p.diskRows[1].state === 'bad', JSON.stringify(p.diskRows[1]))
  check('sizes are human-readable', p.diskRows[0].size === '4.0 TB · 41.0 GB free', p.diskRows[0].size)
  check('retention is the shortest disk, and under 30 days is bad', p.retention.value === '7 days' && p.retention.state === 'bad', JSON.stringify(p.retention))
  check('firmware comes from the NVR, not from us', field(p, 'Firmware').value === '1.4.5.2')
  check('the camera limit is shown so refusals make sense', field(p, 'Cameras').value === '1 of 1 (it takes 32)', field(p, 'Cameras').value)
  check('streams in use are shown', field(p, 'Streams in use').value === '12')
  check('last contact is in words', field(p, 'Last contact').value === 'just now', field(p, 'Last contact').value)
}
{
  const [p] = renderHealth(nvrWith({ storage: { ...storage, disks: [storage.disks[0]], days: 33, worst: 'ok' } })).nvrPanels
  check('all-healthy disks read well', p.disks.state === 'ok' && p.disks.value === '1 disk', JSON.stringify(p.disks))
  check('33 days clears the site minimum', p.retention.value === '33 days' && p.retention.state === 'ok')
}
{
  const [p] = renderHealth(nvrWith({ storage: { ...storage, available: true, disks: [], days: null, worst: 'missing' } })).nvrPanels
  check('an NVR with no disk says so, loudly', p.disks.value === 'No disk' && p.disks.state === 'bad', JSON.stringify(p.disks))
}
{
  const [p] = renderHealth(nvrWith({ storage: { at: T0, available: false, why: 'queryDiskStatus: not supported', disks: [], days: null, worst: 'unknown', caps: {} } })).nvrPanels
  check('an NVR that would not answer says "not available"', p.disks.value === 'not available' && p.disks.state === 'warn', JSON.stringify(p.disks))
  check('and the reason is shown, not hidden', p.disks.note === 'queryDiskStatus: not supported', p.disks.note)
  check('retention is not available either, and never green', p.retention.value === 'not available' && p.retention.state === 'warn')
  check('no disk rows are invented', p.diskRows.length === 0)
}

// A real disk from a real NVR: full, cycling, and with no condition reported because these boxes
// refuse the command that carries one. Both of those are normal here, and neither is a fault.
{
  const real = {
    name: 'Disk 1', slot: 1, id: '{d1}', model: 'ST12000VE001-3BN101', serial: 'ZRT0CMKL',
    status: null, state: 'unknown', totalBytes: 12_000_138_625_024, freeBytes: 0, recFrom: 0, recTo: 0, days: 18
  }
  const [p] = renderHealth(nvrWith({ storage: { at: T0, available: true, why: '', disks: [real], days: 18, worst: 'unknown', caps: {} } })).nvrPanels
  const r = p.diskRows[0]
  // "0 B free" on a recorder that overwrites its oldest footage by design reads as a fault.
  check('a full cycling disk says it is overwriting, not that it has no space', r.size === '12.0 TB · overwriting oldest', r.size)
  // Every one of these NVRs would otherwise sit amber for ever, which is the alarm nobody reads.
  check('a disk plainly recording is not marked amber for a condition the NVR withheld', r.state === 'ok' && r.status === 'Recording', JSON.stringify(r))
  check('and the summary agrees with its rows', p.disks.state === 'ok' && p.disks.value === '1 disk', JSON.stringify(p.disks))
  check('the model and serial are shown now that they are read', r.detail === 'ST12000VE001-3BN101 · ZRT0CMKL', r.detail)
}
{
  // But a disk with no condition AND no recordings is a genuine unknown and must stay amber.
  const idle = { name: 'Disk 2', slot: 2, id: null, model: null, serial: null, status: null, state: 'unknown', totalBytes: null, freeBytes: null, recFrom: null, recTo: null, days: null }
  const [p] = renderHealth(nvrWith({ storage: { at: T0, available: true, why: '', disks: [idle], days: null, worst: 'unknown', caps: {} } })).nvrPanels
  check('a disk with nothing to show for itself stays amber', p.diskRows[0].state === 'warn' && p.diskRows[0].status === 'not available', JSON.stringify(p.diskRows[0]))
}

// Bandwidth: the fixed budget each NVR shares between recording and live viewing. When it runs
// out the NVR refuses the next stream, which on screen looks exactly like a broken camera. These
// are the real figures from the two NVRs on 2026-09-25.
{
  const caps = (used) => ({ at: T0, available: true, why: '', disks: [], days: null, worst: 'unknown', caps: { totalBandwidthMbps: 192, usedBandwidthKbps: used } })
  const field = (s) => renderHealth(nvrWith({ storage: s })).nvrPanels[0].fields.find((f) => f.label === 'Bandwidth')
  const nvr2 = field(caps(131072))
  check('nvr-2 reads 128 of 192 Mb', nvr2.value === '128 of 192 Mb (67 %)', nvr2.value)
  check('and two thirds spent is worth a colour before it runs out', nvr2.state === 'warn', nvr2.state)
  const nvr1 = field(caps(104857))
  check('nvr1 reads 102.4 of 192 Mb and is fine', nvr1.value === '102.4 of 192 Mb (53 %)' && nvr1.state === 'ok', `${nvr1.value} ${nvr1.state}`)
  check('nearly spent is marked bad', field(caps(176947)).state === 'bad')
  // An NVR that did not give the figures must not be shown a comfortable zero.
  const none = field({ at: T0, available: true, why: '', disks: [], days: null, worst: 'unknown', caps: {} })
  check('an NVR that did not say is "not available", never 0 %', none.value === 'not available' && none.state === 'warn', none.value)
}
{
  const [p] = renderHealth(nvrWith({})).nvrPanels
  check('before the first read, nothing is claimed', p.disks.value === 'not available' && p.retention.value === 'not available')
  check('an unknown model reads "not available", not blank', field(p, 'Model').value === 'not available' && field(p, 'Firmware').value === 'not available')
  check('an unknown stream count reads "not available", not 0', field(p, 'Streams in use').value === 'not available')
  check('an unknown last contact reads "not available", not "just now"', field(p, 'Last contact').value === 'not available')
}
{
  const [p] = renderHealth(nvrWith({ refusalsLast10Min: null })).nvrPanels
  check('a refusal count nobody measured says so', field(p, 'Refused (10 min)').value === 'not measured', field(p, 'Refused (10 min)').value)
  check('and is not painted as healthy', field(p, 'Refused (10 min)').state === 'warn')
  check('the old table column agrees', renderHealth(nvrWith({ refusalsLast10Min: null })).nvrRows[0].refusals === 'not available')
}
{
  const [p] = renderHealth(nvrWith({ refusalsLast10Min: 5 })).nvrPanels
  check('real refusals are counted and marked', field(p, 'Refused (10 min)').value === '5' && field(p, 'Refused (10 min)').state === 'bad')
}
{
  const [p] = renderHealth(nvrWith({ online: false, status: 'offline', error: 'timed out', storage: { at: T0, available: false, why: 'Main site did not answer a connection to 10.0.0.9:6036 within 2000 ms', disks: [], days: null, worst: 'unknown', caps: {} } })).nvrPanels
  check('an unreachable NVR says how it failed', p.status.value === 'Offline' && /within 2000 ms/.test(p.status.note), JSON.stringify(p.status))
}
{
  const [p] = renderHealth(nvrWith({ loginError: 'password wrong' })).nvrPanels
  check('a refused login is distinguished from an unreachable NVR', p.status.value === 'Login refused' && p.status.note === 'password wrong')
}
{
  const [p] = renderHealth(nvrWith({ cooling: true })).nvrPanels
  check('an NVR whose calls are overdue is shown as slow, not offline', p.status.value === 'Online, slow' && p.status.state === 'warn', JSON.stringify(p.status))
}

// ---- sending problems --------------------------------------------------------------------------
{
  const r = renderHealth(data({ sending: { emailError: '535 bad credentials' } }))
  check('a failing sender is surfaced', r.sendingProblem === 'email failing: 535 bad credentials', r.sendingProblem)
}
{
  const r = renderHealth(data({ sending: { ntfyError: 'network down' } }))
  check('a failing phone push is surfaced first', r.sendingProblem === 'phone push failing: network down', r.sendingProblem)
}
{
  check('no sending problem is an empty string', renderHealth(data()).sendingProblem === '')
}

// ---- history -----------------------------------------------------------------------------------
{
  const r = renderHealth(data({ history: [{ at: T0 - 600_000, event: 'opened', key: 'k', kind: 'drive-missing', title: 'USB drive is not mounted', severity: 'high' }] }))
  check('an open row with no clear says open', r.historyRows[0].cleared === 'open', JSON.stringify(r.historyRows[0]))
}
{
  const r = renderHealth(data({ history: [
    { at: T0 - 300_000, event: 'cleared', key: 'k', kind: 'drive-missing', title: 'USB drive is not mounted', severity: 'high' },
    { at: T0 - 600_000, event: 'opened', key: 'k', kind: 'drive-missing', title: 'USB drive is not mounted', severity: 'high' }
  ] }))
  check('open and clear are paired into one row', r.historyRows.length === 1, String(r.historyRows.length))
  check('the row shows both times', r.historyRows[0].started === at(T0 - 600_000) && r.historyRows[0].cleared === at(T0 - 300_000), JSON.stringify(r.historyRows[0]))
}
{
  // two separate episodes of the same problem must stay two rows
  const r = renderHealth(data({ history: [
    { at: T0 - 100_000, event: 'cleared', key: 'k', kind: 'x', title: 'thing', severity: 'high' },
    { at: T0 - 200_000, event: 'opened', key: 'k', kind: 'x', title: 'thing', severity: 'high' },
    { at: T0 - 300_000, event: 'cleared', key: 'k', kind: 'x', title: 'thing', severity: 'high' },
    { at: T0 - 400_000, event: 'opened', key: 'k', kind: 'x', title: 'thing', severity: 'high' }
  ] }))
  check('two episodes of one problem stay two rows', r.historyRows.length === 2, String(r.historyRows.length))
  check('the newest episode is first', r.historyRows[0].started === at(T0 - 200_000) && r.historyRows[1].started === at(T0 - 400_000), JSON.stringify(r.historyRows))
}
{
  check('an empty history is an empty list', renderHealth(data()).historyRows.length === 0)
}

// ---- backup card -------------------------------------------------------------------------------
{
  const r = renderHealth(data({ backup: { at: T0 - 8 * 3600_000, files: [], written: ['/a'], errors: [] } }))
  check('the backup card shows the time', r.cards.backup.value === at(T0 - 8 * 3600_000), r.cards.backup?.value)
  check('and is fine with no errors', r.cards.backup.state === 'ok', r.cards.backup?.state)
}
{
  const r = renderHealth(data({ backup: { at: T0 - 3600_000, files: [], written: [], errors: ['/srv/x: read-only'] } }))
  check('a failed backup is a warning', r.cards.backup.state === 'warn', r.cards.backup?.state)
  check('and says why', r.cards.backup.note.includes('read-only'), r.cards.backup?.note)
}
{
  const r = renderHealth(data())
  check('no backup yet is a warning', r.cards.backup.state === 'warn' && r.cards.backup.value === 'None yet', JSON.stringify(r.cards.backup))
}

// ---- the machine's own figures ------------------------------------------------------------------
const sys = (o = {}) => ({
  cpu: { percent: 23.4, cores: 4, load1: 1.42 },
  memory: { total: 16_000_000_000, used: 5_000_000_000, available: 11_000_000_000 },
  network: { rxBytesPerSec: 30_000_000, txBytesPerSec: 1_500_000 },
  disk: { writeBytesPerSec: 12_400_000 },
  gpu: null,
  ...o
})
{
  const r = renderHealth(data({ system: sys() })).systemCards
  check('CPU is a rounded percentage', r.cpu.value === '23 %', r.cpu?.value)
  check('with the load average and cores beside it', r.cpu.note === 'load 1.42 · 4 cores', r.cpu?.note)
  check('memory reads as used of total', r.memory.value === '5.0 GB of 16.0 GB', r.memory?.value)
  check('and says how much is available', r.memory.note === '11.0 GB available', r.memory?.note)
  check('network is in bits per second, both ways', r.network.value === '↓ 240 Mbps ↑ 12 Mbps', r.network?.value)
  check('disk write is in MB/s', r.disk.value === '12.4 MB/s', r.disk?.value)
}
{
  const r = renderHealth(data({ system: sys({ cpu: { percent: 84, cores: 4, load1: 6.1 } }) })).systemCards
  check('CPU over 80 % is a warning', r.cpu.state === 'warn', r.cpu?.state)
}
{
  const r = renderHealth(data({ system: sys({ cpu: { percent: 99, cores: 4, load1: 20 } }) })).systemCards
  check('a pegged CPU is bad', r.cpu.state === 'bad', r.cpu?.state)
}
{
  const r = renderHealth(data({ system: sys({ cpu: { percent: 40, cores: 4, load1: 1 } }) })).systemCards
  check('an ordinary CPU load is fine', r.cpu.state === 'ok', r.cpu?.state)
}
{
  const r = renderHealth(data({ system: sys({ memory: { total: 16_000_000_000, used: 14_600_000_000, available: 1_400_000_000 } }) })).systemCards
  check('under 10 % memory available is a warning', r.memory.state === 'warn', r.memory?.state)
}
{
  const r = renderHealth(data({ system: sys({ memory: { total: 16_000_000_000, used: 15_600_000_000, available: 400_000_000 } }) })).systemCards
  check('almost no memory available is bad', r.memory.state === 'bad', r.memory?.state)
}
{
  const r = renderHealth(data({ system: sys() })).systemCards
  check('no GPU says none detected, not 0 %', r.gpu.value === 'None detected', r.gpu?.value)
}
{
  const r = renderHealth(data({ system: sys({ gpu: { percent: 37, memUsed: 1_000_000_000, memTotal: 8_000_000_000, name: 'NVIDIA' } }) })).systemCards
  check('a real GPU shows its percentage', r.gpu.value === '37 %', r.gpu?.value)
  check('and its memory', r.gpu.note === 'NVIDIA · 1.0 GB of 8.0 GB', r.gpu?.note)
}
{
  // the very first poll after a restart: the counters have nothing to be compared with yet
  const r = renderHealth(data({ system: sys({ cpu: { percent: null, cores: 4, load1: 1.42 }, network: { rxBytesPerSec: null, txBytesPerSec: null }, disk: { writeBytesPerSec: null } }) })).systemCards
  check('a rate with no previous sample shows a dash, not a zero', r.cpu.value === '—' && r.network.value === '—' && r.disk.value === '—', JSON.stringify([r.cpu.value, r.network.value, r.disk.value]))
  check('and is not coloured as a problem', r.cpu.state === 'ok', r.cpu?.state)
  check('the gauges still show on that first poll', r.cpu.note === 'load 1.42 · 4 cores' && r.memory.value.endsWith('16.0 GB'), r.cpu?.note)
}
{
  const r = renderHealth(data()).systemCards
  check('no system figures at all does not throw', r.cpu.value === '—' && r.memory.value === '—' && r.gpu.value === 'None detected', JSON.stringify(r))
}

// ---- no secret ever leaves ----------------------------------------------------------------------
{
  const r = renderHealth(data({ sending: { emailError: 'nope' } }))
  check('the shaped output carries no password field', !JSON.stringify(r).toLowerCase().includes('pass'), JSON.stringify(r).slice(0, 200))
}

// ---- an NVR whose settings go through the worker's login (the control login is refused)
{
  const [p] = renderHealth(nvrWith({ borrowing: true, lastContactMs: 800 })).nvrPanels
  check('borrowing: the panel says online, as a warning', p.status.value === 'Online' && p.status.state === 'warn', JSON.stringify(p.status))
  check('borrowing: and why', p.status.note === 'Settings are going through the video login; the NVR is refusing a second one.', p.status.note)
  const [q] = renderHealth(nvrWith({ borrowing: false, lastContactMs: 800 })).nvrPanels
  check('not borrowing: the panel is as before', q.status.value === 'Online' && q.status.state === 'ok')
  const [r] = renderHealth(nvrWith({ borrowing: true, online: false, status: 'offline' })).nvrPanels
  check('offline wins over borrowing', r.status.value === 'Offline' && r.status.state === 'bad')
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
