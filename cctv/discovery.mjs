// Finding TVT NVRs on the network (admins only, from the Sites page).
//
// Three sources, merged per device address:
//   1. TVT LAN search on UDP 23456 (mhed.mjs): name, model, MAC, firmware, ports, channels.
//      Needs multicast on the LAN, so it runs here when the app is on the PC's own network
//      (Linux: network_mode: host, or a native install), otherwise through
//      discovery-helper.mjs running on the PC (Docker Desktop: multicast never leaves it).
//   2. An address sweep of TCP port 6036. A TVT NVR greets every new connection with
//      "head" + its MAC + firmware before anything is sent, which tells it apart from
//      PCs that also have 6036 open. This works from inside Docker.
//   3. The NVRs already added, so results say which are new.
//
//   GET  /api/admin/discovery          -> { ranges: "192.168.0.0/24, ...", helper: bool }
//   POST /api/admin/discovery          { ranges, port? } -> { devices, others, notes, ... }
import { lookup } from 'node:dns/promises'
import net from 'node:net'
import { lanAddresses, mhedSearch } from './mhed.mjs'
import { readConfig } from './nvrs.mjs'

const SDK_PORT = 6036
const MAX_ADDRESSES = 1024
const MAX_DEVICES = 256 // from the TVT search (the helper is another process: don't trust its size)
const SWEEP_CONCURRENCY = 32 // connections in flight
const CONNECT_TIMEOUT_MS = 700
const GREETING_WAIT_MS = 500 // NVRs greet within ~10 ms
const HELPER_URL = process.env.DISCOVERY_HELPER_URL ?? ''
const HELPER_TIMEOUT_MS = 8000
const LOOKUP_TIMEOUT_MS = 2000

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// ---- address ranges -------------------------------------------------------------

const toInt = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0)
const toIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const isIp = (s) => typeof s === 'string' && IP_RE.test(s) && s.split('.').every((x) => Number(x) <= 255)
const is172Private = (n) => n >>> 20 === ((172 << 4) | 1) // 172.16.0.0/12
/** Private (RFC 1918) addresses only: this scans the site's own network, nothing else. */
const isPrivate = (n) => n >>> 24 === 10 || is172Private(n) || n >>> 16 === ((192 << 8) | 168)

/**
 * "192.168.0.0/22, 10.1.1.10-10.1.1.60, 192.168.5.10-60, 192.168.5.7" -> list of addresses.
 * Throws HttpError(400) with a readable message on bad input.
 */
export function parseRanges(input) {
  const parts = String(input ?? '')
    .split(/[\s,;]+/)
    .filter(Boolean)
  if (parts.length === 0) throw new HttpError(400, 'Enter at least one address range, e.g. 192.168.0.0/24')
  const out = new Set()
  for (const part of parts) {
    let lo
    let hi
    const cidr = /^([\d.]+)\/(\d{1,2})$/.exec(part)
    const dash = /^([\d.]+)-([\d.]+)$/.exec(part)
    if (cidr && isIp(cidr[1])) {
      const bits = Number(cidr[2])
      if (bits < 22 || bits > 32) throw new HttpError(400, `${part}: use /22 to /32 (at most 1024 addresses)`)
      const size = 2 ** (32 - bits)
      lo = toInt(cidr[1]) - (toInt(cidr[1]) % size)
      hi = lo + size - 1
      if (size >= 4) {
        lo++ // skip the network and broadcast addresses
        hi--
      }
    } else if (dash && isIp(dash[1]) && isIp(dash[2])) {
      lo = toInt(dash[1])
      hi = toInt(dash[2])
    } else if (dash && isIp(dash[1]) && /^\d{1,3}$/.test(dash[2])) {
      // "192.168.0.10-60" means .10 to .60, within that /24
      if (Number(dash[2]) > 255) throw new HttpError(400, `${part}: the end of the range must be 0-255 or a full address`)
      lo = toInt(dash[1])
      hi = lo - (lo % 256) + Number(dash[2])
    } else if (isIp(part)) {
      lo = hi = toInt(part)
    } else {
      throw new HttpError(400, `"${part}" is not an address, a range (a.b.c.d-e) or a network (a.b.c.d/24)`)
    }
    if (hi < lo) throw new HttpError(400, `${part}: the range ends before it starts`)
    if (hi - lo + 1 > MAX_ADDRESSES) throw new HttpError(400, `${part}: at most ${MAX_ADDRESSES} addresses per scan`)
    for (let n = lo; n <= hi; n++) {
      if (!isPrivate(n)) throw new HttpError(400, `${part}: only private network addresses (10.x, 172.16-31.x, 192.168.x) can be scanned`)
      out.add(toIp(n))
      if (out.size > MAX_ADDRESSES) throw new HttpError(400, `At most ${MAX_ADDRESSES} addresses per scan`)
    }
  }
  return [...out]
}

/**
 * Suggested ranges: the /24s of the NVRs already added, then of this PC (CERT_HOSTS),
 * then of this machine's own addresses. Docker's networks (172.16-31.x on this machine's
 * interfaces) are left out, and so is anything past what one scan allows.
 */
export function defaultRanges() {
  const own = lanAddresses().filter((a) => !is172Private(toInt(a)))
  const hosts = [...readConfig().nvrs.map((n) => n.host), ...String(process.env.CERT_HOSTS ?? '').split(/[\s,]+/), ...own]
  const nets = []
  for (const h of hosts) {
    if (!isIp(h) || !isPrivate(toInt(h))) continue
    const net24 = `${h.split('.').slice(0, 3).join('.')}.0/24`
    if (!nets.includes(net24)) nets.push(net24)
    if (nets.length === Math.floor(MAX_ADDRESSES / 254)) break
  }
  return nets.sort((a, b) => toInt(a.split('/')[0]) - toInt(b.split('/')[0])).join(', ')
}

// ---- address sweep with the NVR greeting ---------------------------------------------

/**
 * Connects to host:port without sending anything and reads what the device says first.
 * @returns {Promise<null | { tvt: boolean, mac?: string, firmware?: string }>} null if the port isn't open
 */
function greet(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    const chunks = []
    let size = 0
    let open = false
    let settled = false
    let timer = setTimeout(() => done(), CONNECT_TIMEOUT_MS)
    function done() {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      if (!open) return resolve(null)
      const b = Buffer.concat(chunks)
      // "head", then u32s; MAC at 32, firmware (u32 LE, 0x01040a00 = 1.4.10.0) at 40
      if (b.length >= 44 && b.toString('latin1', 0, 4) === 'head') {
        const v = b.readUInt32LE(40)
        resolve({
          tvt: true,
          mac: [...b.subarray(32, 38)].map((x) => x.toString(16).padStart(2, '0')).join(':'),
          firmware: `${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`
        })
      } else {
        resolve({ tvt: false })
      }
    }
    sock.once('connect', () => {
      open = true
      clearTimeout(timer)
      timer = setTimeout(done, GREETING_WAIT_MS)
    })
    sock.on('data', (d) => {
      chunks.push(d)
      size += d.length
      if (size >= 44) done() // enough to identify; never keep reading
    })
    sock.once('error', () => done())
    sock.once('close', () => done())
  })
}

async function sweep(addresses, port) {
  const found = []
  let next = 0
  const worker = async () => {
    while (next < addresses.length) {
      const ip = addresses[next++]
      const g = await greet(ip, port)
      if (g) found.push({ ip, port, ...g })
    }
  }
  await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, addresses.length) }, worker))
  return found
}

// ---- TVT search on UDP 23456 --------------------------------------------------------

/** Asks discovery-helper.mjs on the PC (for Docker Desktop, where multicast can't leave). */
async function helperSearch() {
  if (!HELPER_URL) return { ran: false, why: 'no helper configured' }
  try {
    const res = await fetch(`${HELPER_URL.replace(/\/$/, '')}/search`, { signal: AbortSignal.timeout(HELPER_TIMEOUT_MS) })
    const text = await res.text()
    if (text.length > 1_000_000) return { ran: false, why: 'the helper sent an oversized answer' }
    const body = JSON.parse(text || '{}')
    if (!res.ok) return { ran: false, why: clean(body.error, 200) || `the helper answered ${res.status}` }
    return { ran: true, where: 'helper', devices: Array.isArray(body.devices) ? body.devices.slice(0, MAX_DEVICES) : [] }
  } catch (e) {
    const code = e.cause?.code
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { ran: false, why: 'not running' }
    if (e.name === 'TimeoutError') return { ran: false, why: 'it did not answer in time' }
    return { ran: false, why: e.message }
  }
}

/**
 * The TVT search: through the helper when one is configured (Docker Desktop), otherwise
 * from this process (which only reaches the devices when it is on the LAN itself).
 * @returns {Promise<{ ran: boolean, where?: string, devices: object[], why?: string }>}
 */
async function tvtSearch() {
  if (HELPER_URL) {
    const viaHelper = await helperSearch()
    if (viaHelper.ran) return viaHelper
    // Linux with network_mode: host can search from here even with a helper address set
    try {
      const { devices } = await mhedSearch()
      if (devices.length) return { ran: true, where: 'app', devices }
    } catch {}
    return { ran: false, why: viaHelper.why, devices: [] }
  }
  try {
    const { devices, interfaces } = await mhedSearch()
    return { ran: interfaces.length > 0, where: 'app', devices }
  } catch (e) {
    return { ran: false, why: e.message, devices: [] }
  }
}

/** Addresses of the NVRs already added (host names resolved), for "already added". */
async function addedNvrs() {
  return Promise.all(
    // NVRs reached by serial number have the P2P relay as their host: nothing on this network
    readConfig().nvrs.filter((n) => !n.sn).map(async (n) => {
      let ip = isIp(n.host) ? n.host : null
      if (!ip) {
        ip = await Promise.race([
          lookup(n.host, { family: 4 }).then((r) => r.address, () => null),
          new Promise((r) => setTimeout(() => r(null), LOOKUP_TIMEOUT_MS))
        ])
      }
      return { id: n.id, name: n.name, site: n.site, ip, port: Number(n.port) }
    })
  )
}

// ---- scan -------------------------------------------------------------------------

let running = false

/** A field from the TVT search (network data, possibly via another process): plain text only. */
const clean = (v, max = 64) => (typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '').slice(0, max) : undefined)
const cleanNum = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined)

async function scan({ ranges, port = SDK_PORT }) {
  const addresses = parseRanges(ranges)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Port must be 1-65535')
  const t0 = Date.now()
  const [search, swept, added] = await Promise.all([tvtSearch(), sweep(addresses, port), addedNvrs()])

  // one entry per address: a search reply naming another device's MAC can't take over
  // that device's entry (the greeting's MAC can also be the NVR's second network port)
  const devices = new Map()
  for (const raw of search.devices ?? []) {
    const ip = clean(raw.ip, 15)
    if (!isIp(ip) || !isPrivate(toInt(ip)) || devices.has(ip)) continue
    devices.set(ip, {
      ip,
      name: clean(raw.name, 32),
      model: clean(raw.model, 40),
      mac: clean(raw.mac, 17),
      port: cleanNum(raw.port, 1, 65535) ?? SDK_PORT,
      httpPort: cleanNum(raw.httpPort, 1, 65535),
      firmware: clean(raw.firmware, 16),
      buildDate: clean(raw.buildDate, 10),
      type: clean(raw.type, 16) || 'NVR',
      channels: cleanNum(raw.channels, 1, 512),
      foundBy: ['TVT search']
    })
  }
  let others = 0
  for (const g of swept) {
    if (!g.tvt) {
      others++ // port open, but no TVT greeting: a PC or another device
      continue
    }
    const match = devices.get(g.ip)
    if (match) {
      match.foundBy.push(`port ${port}`)
      match.firmware ??= g.firmware
      continue
    }
    devices.set(g.ip, { ip: g.ip, port: g.port, mac: g.mac, firmware: g.firmware, type: 'NVR', foundBy: [`port ${port}`] })
  }

  // which are already in the app
  const list = [...devices.values()].map((d) => {
    const nvr = added.find((n) => n.ip === d.ip && n.port === d.port)
    return { ...d, added: nvr ? { id: nvr.id, name: nvr.name, site: nvr.site } : null }
  })
  list.sort((a, b) => Boolean(a.added) - Boolean(b.added) || toInt(a.ip) - toInt(b.ip))

  const notes = []
  const sweptNvrs = swept.filter((g) => g.tvt).length
  if (!search.ran) {
    if (HELPER_URL) {
      notes.push(
        search.why === 'not running'
          ? 'The TVT network search (UDP 23456) did not run: in Docker Desktop it needs the discovery helper on this PC, and the helper is not running (double-click start-discovery-helper.cmd). Only the address check ran, so names and models are missing and NVRs outside these addresses are not found.'
          : `The TVT network search (UDP 23456) failed: discovery helper: ${search.why}. Only the address check ran.`
      )
    } else {
      notes.push(`The TVT network search (UDP 23456) could not run (${search.why}). Only the address check ran.`)
    }
  } else if ((search.devices ?? []).length === 0 && sweptNvrs > 0) {
    notes.push('The TVT network search (UDP 23456) got no answers, although NVRs were found by address: the search does not reach them (other subnet or VLAN, or a firewall on this PC).')
  }
  console.log(
    `[discovery] ${addresses.length} addresses, search ${search.ran ? `via ${search.where}: ${search.devices.length}` : `not run (${search.why})`}, sweep: ${sweptNvrs} NVR(s), ${others} other; ${list.length} device(s) in ${Date.now() - t0} ms`
  )
  return {
    scanned: addresses.length,
    ms: Date.now() - t0,
    search: { ran: search.ran, where: search.where ?? null, found: (search.devices ?? []).length },
    devices: list,
    others,
    notes
  }
}

/**
 * @returns {Promise<[number, any]>}
 */
export async function handleDiscovery(method, readJson) {
  try {
    if (method === 'GET') return [200, { ranges: defaultRanges(), helper: Boolean(HELPER_URL) }]
    if (method !== 'POST') return [405, { error: 'Method not allowed' }]
    // taken before reading the body, so two requests can't both start a scan
    if (running) throw new HttpError(409, 'A search is already running. Try again in a few seconds.')
    running = true
    try {
      const body = await readJson()
      return [200, await scan({ ranges: body.ranges, port: body.port === undefined ? SDK_PORT : Number(body.port) })]
    } finally {
      running = false
    }
  } catch (e) {
    if (e instanceof HttpError) return [e.status, { error: e.message }]
    if (e instanceof SyntaxError) return [400, { error: 'Bad JSON' }]
    console.error(`[discovery] ${e.stack ?? e}`)
    return [500, { error: e.message }]
  }
}
