// What /api/health tells someone who is not an admin (health-view.mjs). Health is open to everyone
// signed in, and it named every camera on every site, with its NVR's address, model and serial, to a
// viewer allowed one camera or none. Pure: no NVR, no SDK.
//   node cctv/test/health-view.test.mjs
import { readFileSync } from 'node:fs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

let healthFor = null
try {
  ;({ healthFor } = await import('../health-view.mjs'))
} catch (e) {
  check('health-view.mjs loads', false, e.message)
}

const alert = (key, kind, title, detail) => ({ key, kind, title, detail, severity: 'warn' })
const body = () => ({
  now: 1,
  startedMs: 0,
  restartReason: null,
  nvrs: [
    { id: 'nvr1', name: 'NVR 1', online: true, status: 'online', error: '', host: '10.0.0.5', serial: 'N1SER', model: 'NVR-X', via: 'lan', storage: { disks: [] } },
    { id: 'rigginglot', name: 'Rigginglot', online: false, status: 'offline', error: 'cannot be reached at 10.8.0.9:6036', host: '10.8.0.9', serial: 'RLSER', model: 'NVR-Y', via: 'lan' }
  ],
  cameras: [
    { nvrId: 'nvr1', ch: 0, name: 'Cashier Front', online: true, recording: true, lastSegmentMs: 1 },
    { nvrId: 'nvr1', ch: 1, name: 'Back Office', online: true, recording: true, lastSegmentMs: 1 },
    { nvrId: 'rigginglot', ch: 0, name: 'Gate', online: false, recording: true, lastSegmentMs: 1 }
  ],
  open: [
    alert('not-recording/rigginglot', 'not-recording', 'rigginglot: 2 cameras not recording', 'Gate, Yard — online but nothing written.'),
    alert('nvr-offline/nvr1', 'nvr-offline', 'nvr1 is offline', 'NVR 1: the server cannot reach it.'),
    alert('drive-full/usb', 'drive-full', '/mnt/usb is nearly full', '97 % used.'),
    alert('server-restart/1', 'server-restart', 'The server restarted', null)
  ],
  history: [
    alert('not-recording/rigginglot', 'not-recording', 'rigginglot: 2 cameras not recording', 'Gate, Yard — online but nothing written.'),
    alert('nvr-offline/nvr1', 'nvr-offline', 'nvr1 is offline', 'NVR 1: the server cannot reach it.'),
    alert('drive-full/usb', 'drive-full', '/mnt/usb is nearly full', '97 % used.'),
    alert('server-restart/1', 'server-restart', 'The server restarted', null)
  ],
  locations: [{ id: 'usb', name: '/mnt/usb', mounted: true, freePct: 3 }],
  sending: { ntfyError: 'topic abc refused' },
  backup: { at: 5, files: ['settings.json'], written: ['/mnt/usb/_backup/2026-09-28T02-00'], errors: [] },
  viewing: { traffic: {} },
  system: null
})

if (healthFor) {
  // (a) a viewer allowed one camera
  const one = healthFor(body(), { admin: false, canSee: (n, c) => n === 'nvr1' && c === 0 })
  check('only the camera the viewer may see is listed', one.cameras.length === 1 && one.cameras[0].name === 'Cashier Front', JSON.stringify(one.cameras))
  const text = JSON.stringify(one)
  const leak = /Back Office|Gate|Yard|10\.0\.0\.5|10\.8\.0\.9|N1SER|RLSER|NVR-X|\/mnt\/usb/.exec(text)
  check('no other camera, address, serial, model or drive path appears anywhere', !leak, leak?.[0])
  // (b) the NVRs: only those of a visible camera, name and state only
  check('an NVR with no camera the viewer may see is not listed', !one.nvrs.some((n) => n.id === 'rigginglot'))
  check('the viewer\'s own NVR is, by name and state', one.nvrs.length === 1 && one.nvrs[0].name === 'NVR 1' && one.nvrs[0].status === 'online' && !('host' in one.nvrs[0]) && !('storage' in one.nvrs[0]))
  check('an alert about that NVR is kept', one.open.some((a) => a.key === 'nvr-offline/nvr1') && one.history.some((a) => a.key === 'nvr-offline/nvr1'))
  check('alerts listing cameras by name, and drive and restart alerts, are not', one.open.length === 1 && one.history.length === 1)
  check('the backup is when and how many, never where', one.backup?.at === 5 && one.backup.written.length === 1 && !('files' in one.backup))
  check('what the alert sender is doing is admins\' business', one.sending === null)
  check('the rest of the body is untouched', one.viewing && one.now === 1)
  // (c) a viewer with no cameras at all
  const none = healthFor(body(), { admin: false, canSee: () => false })
  check('a viewer with no cameras is told of no camera, NVR or alert', none.cameras.length === 0 && none.nvrs.length === 0 && none.open.length === 0 && none.history.length === 0)
  check('no rights check handed in is no cameras (default deny)', healthFor(body(), { admin: false }).cameras.length === 0)
  // (d) an admin gets the body itself
  const b = body()
  check('an admin gets everything, as it was', healthFor(b, { admin: true, canSee: () => false }) === b)
  check('only the literal true is an admin', healthFor(body(), { admin: 'true', canSee: () => false }).cameras.length === 0)
  check('a junk body does not throw', (() => { try { return Array.isArray(healthFor({}, { admin: false, canSee: () => true }).cameras) } catch { return false } })())
}

// (e) the route: /api/health goes through it
const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
check('server.mjs sends /api/health through healthFor', /pathname === '\/api\/health'[\s\S]{0,900}healthFor\(/.test(server))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
