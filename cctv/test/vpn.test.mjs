// Offline tests for the app side of the VPN (cctv/vpn.mjs and the admin list): reading the
// status file the hub's timer writes, matching NVRs to VPN sites. No network.
//   node cctv/test/vpn.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'vpn-'))
process.env.DATA_DIR = dir
process.env.VPN_STATUS_FILE = join(dir, 'vpn-status.json')
const { inCidr, readVpn, vpnSiteFor, vpnView } = await import('../vpn.mjs')
const { handleAdmin } = await import('../admin.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const now = Date.parse('2026-09-24T03:00:00Z')
const t = now / 1000
const status = (over = {}) => ({
  at: new Date(now - 10_000).toISOString(),
  hub: { publicKey: 'hubPUBLICkey=', listenPort: 51820, address: '10.77.0.1/24', endpointHint: 'cctv.example.org:51820' },
  sites: [
    { id: 1, name: 'north-yard', tunnelIp: '10.77.0.1', virtualSubnet: '10.78.1.0/24', realLan: '192.168.1.0/24', endpoint: '203.0.113.7:40111', latestHandshake: t - 30, rxBytes: 1000, txBytes: 2000 },
    { id: 2, name: 'south-yard', tunnelIp: '10.77.0.2', virtualSubnet: '10.78.2.0/24', realLan: '192.168.1.0/24', endpoint: null, latestHandshake: t - 3600, rxBytes: 0, txBytes: 0 },
    { id: 3, name: 'new-site', tunnelIp: '10.77.0.3', virtualSubnet: '10.78.3.0/24', realLan: null, endpoint: null, latestHandshake: 0, rxBytes: 0, txBytes: 0 }
  ],
  ...over
})
const write = (obj) => writeFileSync(process.env.VPN_STATUS_FILE, typeof obj === 'string' ? obj : JSON.stringify(obj))

check('CIDR: inside', inCidr('10.78.2.10', '10.78.2.0/24') && inCidr('192.168.3.147', '192.168.0.0/22'))
check('CIDR: outside', !inCidr('10.78.3.10', '10.78.2.0/24') && !inCidr('192.168.4.1', '192.168.0.0/22'))
check('CIDR: nonsense is never inside', !inCidr('10.78.2.300', '10.78.2.0/24') && !inCidr('nvr.local', '10.78.2.0/24') && !inCidr('10.78.2.1', 'bad'))

check('no status file: no VPN', readVpn(now).available === false)
write(status())
const v = readVpn(now)
check('status read', v.available && v.sites.length === 3 && !v.stale, JSON.stringify({ n: v.sites.length, stale: v.stale }))
check('connected: handshake 30 s ago', v.sites[0].connected === true && v.sites[0].lastHandshakeAgoS === 30)
check('not connected: last handshake an hour ago', v.sites[1].connected === false && v.sites[1].lastHandshakeAgoS === 3600)
check('never connected', v.sites[2].connected === false && v.sites[2].lastHandshakeAgoS === null)
check('public key of the hub not passed on', !JSON.stringify(v).includes('hubPUBLICkey'))
write(status({ at: new Date(now - 600_000).toISOString() }))
check('status 10 min old: stale (timer not running)', readVpn(now).stale === true)
write(status({ sites: [...status().sites, { id: 999, name: 'x', virtualSubnet: '10.78.9.0/24' }, { id: 4, name: 'Bad Name;rm', virtualSubnet: '10.78.4.0/24' }, { id: 5, name: 'ok5', virtualSubnet: 'nope' }] }))
check('bad site entries dropped', readVpn(now).sites.length === 3)
write('{not json')
check('garbage file: no VPN (no crash)', readVpn(now).available === false)

write(status())
const nvrsCfg = [
  { id: 'n1', name: 'North NVR', host: '10.78.1.10', port: 6036 },
  { id: 'n2', name: 'South NVR', host: '10.78.2.10', port: 6036 },
  { id: 'local', name: 'Local NVR', host: '192.168.0.228', port: 6036 }
]
const view = vpnView(nvrsCfg, now)
check('NVRs matched to their VPN site (overlapping real LANs kept apart)', view.sites[0].nvrs.map((n) => n.id).join() === 'n1' && view.sites[1].nvrs.map((n) => n.id).join() === 'n2' && view.sites[2].nvrs.length === 0)
check('local NVR is on no VPN site', vpnSiteFor('192.168.0.228', readVpn(now)) === null)

// admin list: an NVR at a VPN site says so, and whether the tunnel is up
write(status({ at: new Date().toISOString(), sites: status().sites.map((s) => ({ ...s, latestHandshake: s.id === 1 ? Math.round(Date.now() / 1000) - 20 : s.latestHandshake })) }))
const post = (body) => handleAdmin('POST', '/api/admin/nvrs', async () => ({ ...body, password: 'x', skipTest: true }))
await post({ site: 'North', name: 'North NVR', user: 'admin', host: '10.78.1.10', port: 6036, remote: true })
await post({ site: 'Main', name: 'Local NVR', user: 'admin', host: '192.168.0.228', port: 6036 })
const [, list] = await handleAdmin('GET', '/api/admin/nvrs', async () => ({}))
const north = list.find((n) => n.name === 'North NVR')
const local = list.find((n) => n.name === 'Local NVR')
check('admin: NVR at a VPN site', north?.via === 'vpn' && north.vpnSite?.name === 'north-yard' && north.vpnSite.connected === true && north.remote === true, JSON.stringify(north?.vpnSite))
check('admin: local NVR', local?.via === 'lan' && local.vpnSite === null && local.remote === false)
const [s, b] = await handleAdmin('PUT', `/api/admin/nvrs/${north.id}`, async () => ({ remote: false }))
const [, list2] = await handleAdmin('GET', '/api/admin/nvrs', async () => ({}))
check('admin: the remote flag can be changed without a login test', s === 200 && b.model === '' && list2.find((n) => n.id === north.id).remote === false)

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
