// VPN status for the Sites page. Remote sites reach this server through the WireGuard hub
// (deploy/vpn): site N's NVR network appears here as 10.78.N.0/24, so an NVR at that site is
// added by an address in that range. A root timer writes the status file every 15 s; this
// only reads it (it holds no secrets).
//
//   GET /api/admin/vpn -> { available, stale?, at?, hub?, sites: [{ id, name, virtualSubnet,
//                          realLan, endpoint, connected, lastHandshakeAgoS, rxBytes, txBytes, nvrs }] }
import { readFileSync } from 'node:fs'

export const VPN_STATUS_FILE = process.env.VPN_STATUS_FILE || '/run/cctv/vpn-status.json'
// WireGuard re-handshakes about every 2 minutes while packets flow (keepalive every 25 s)
const CONNECTED_S = 180
// the timer writes every 15 s: older than this, the status itself is out of date
const STALE_S = 90

const ipToInt = (ip) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip))
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}
const parseCidr = (cidr) => {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(String(cidr))
  const base = m ? ipToInt(m[1]) : null
  const bits = m ? Number(m[2]) : NaN
  if (base === null || !(bits >= 0 && bits <= 32)) return null
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return { base: (base & mask) >>> 0, mask }
}
/** Whether an IPv4 address lies in a CIDR block. */
export const inCidr = (ip, cidr) => {
  const a = ipToInt(ip)
  const c = parseCidr(cidr)
  return a !== null && c !== null && ((a & c.mask) >>> 0) === c.base
}

const str = (v, max = 64) => (typeof v === 'string' && v.length <= max ? v : null)
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0)

/** The status file, checked field by field; { available: false } when there is no VPN. */
export function readVpn(now = Date.now()) {
  let raw
  try {
    raw = JSON.parse(readFileSync(VPN_STATUS_FILE, 'utf8'))
  } catch {
    return { available: false, sites: [] }
  }
  const at = Date.parse(raw?.at)
  const sites = (Array.isArray(raw?.sites) ? raw.sites : [])
    .filter((s) => Number.isInteger(s?.id) && s.id >= 1 && s.id <= 250 && /^[a-z0-9-]{1,32}$/.test(String(s?.name)) && parseCidr(s?.virtualSubnet))
    .map((s) => {
      const hs = num(s.latestHandshake)
      const ago = hs > 0 ? Math.max(0, Math.round(now / 1000 - hs)) : null
      return {
        id: s.id,
        name: s.name,
        virtualSubnet: s.virtualSubnet,
        realLan: str(s.realLan, 32),
        endpoint: str(s.endpoint, 64),
        connected: ago !== null && ago < CONNECTED_S,
        lastHandshakeAgoS: ago,
        rxBytes: num(s.rxBytes),
        txBytes: num(s.txBytes)
      }
    })
    .sort((a, b) => a.id - b.id)
  return {
    available: true,
    at: Number.isFinite(at) ? new Date(at).toISOString() : null,
    stale: !Number.isFinite(at) || now - at > STALE_S * 1000,
    hub: raw?.hub ? { listenPort: num(raw.hub.listenPort) || null, address: str(raw.hub.address, 32), endpointHint: str(raw.hub.endpointHint, 128) } : null,
    sites
  }
}

/** The VPN site whose virtual subnet holds this NVR address, or null. */
export const vpnSiteFor = (host, vpn) => vpn.sites.find((s) => inCidr(host, s.virtualSubnet)) ?? null

/** Status plus, for each site, the NVRs in the app that are reached through it. */
export function vpnView(nvrConfigs, now = Date.now()) {
  const vpn = readVpn(now)
  return {
    ...vpn,
    sites: vpn.sites.map((s) => ({
      ...s,
      nvrs: nvrConfigs.filter((n) => !n.sn && inCidr(n.host, s.virtualSubnet)).map((n) => ({ id: n.id, name: n.name, host: n.host }))
    }))
  }
}
