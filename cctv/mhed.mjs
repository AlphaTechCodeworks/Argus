// TVT LAN search ("MHED", UDP port 23456): the protocol behind TVT's IP Tool and
// the SDK's NET_SDK_DiscoverDevice, in plain Node (no SDK, no root, no changes to
// the machine's network settings; the SDK's own search runs sysctl on some hosts).
//
// Request: 140 bytes to 234.55.55.55:23456, TTL 5: "MHED" 08 00 01 00 01 00 then zeros
// (byte for byte what the SDK sends). Every TVT device on the segment answers with a
// 240-byte "MHED" reply to port 23456 (not to the sender's port), so the socket must
// be bound to 23456 and joined to 234.55.55.55 and 234.55.55.56. On Windows the
// firewall lets the replies in only on the socket that sent the request, briefly.
//
// Multicast has to reach the LAN: this works on a PC's own network (Windows or Linux,
// or a Linux container with network_mode: host), not from inside Docker Desktop.
// There, run discovery-helper.mjs on the PC and the app asks it (see discovery.mjs).
//
// Reply layout (little endian; IPs in network order). Worked out from live replies of
// three NVRs, cross-checked against ARP, ONVIF and the web client:
//   0 "MHED"  4 u16 opcode (7 = search reply)  12 name[20]  32 MAC[6]  38 u16 SDK port
//   40 IP  44 netmask  48 gateway  52 u32 firmware (0x01040a00 = 1.4.10.0)
//   56 u32 build date YYYYMMDD  60 u16 HTTP port  64 u32 device type (3 = NVR)
//   112 DNS 1  116 DNS 2  196 model[16] + 180 model continued[16]  228 u32 channels
import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'

export const MHED_PORT = 23456
const GROUP_SEND = '234.55.55.55'
const GROUPS = ['234.55.55.55', '234.55.55.56']
const REQUEST = (() => {
  const b = Buffer.alloc(140)
  Buffer.from('4d484544080001000100', 'hex').copy(b)
  return b
})()
const OPCODE_REPLY = 7
const RESEND_MS = 400 // gap between the two requests
const MAX_DEVICES = 256 // a LAN host flooding fake replies can't grow the list (or memory) beyond this
const DEVICE_TYPES = { 0: 'DVR', 1: 'DVS', 2: 'IP camera', 3: 'NVR', 4: 'Decoder' }

const ipAt = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`
/** A NUL-terminated string field, printable ASCII only (it comes off the network). */
const text = (b, o, n) => {
  const s = b.subarray(o, o + n)
  const z = s.indexOf(0)
  return s
    .toString('latin1', 0, z < 0 ? n : z)
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
}
const version = (v) => `${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`
const validIp = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((x) => Number(x) <= 255)

/** Decodes a search reply; null for anything else (our own request looped back, other traffic). */
export function decodeReply(b) {
  if (b.length < 232 || b.toString('latin1', 0, 4) !== 'MHED' || b.readUInt16LE(4) !== OPCODE_REPLY) return null
  const ip = ipAt(b, 40)
  if (!validIp(ip) || ip === '0.0.0.0') return null
  const type = b.readUInt32LE(64)
  const build = b.readUInt32LE(56)
  const channels = b.readUInt32LE(228)
  return {
    ip,
    name: text(b, 12, 20),
    model: (text(b, 196, 16) + text(b, 180, 16)).trim(),
    mac: [...b.subarray(32, 38)].map((x) => x.toString(16).padStart(2, '0')).join(':'),
    port: b.readUInt16LE(38) || 6036,
    httpPort: b.readUInt16LE(60) || 80,
    netmask: ipAt(b, 44),
    gateway: ipAt(b, 48),
    firmware: version(b.readUInt32LE(52)),
    buildDate: build >= 20000101 && build <= 21001231 ? String(build).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : '',
    type: DEVICE_TYPES[type] ?? `type ${type}`,
    channels: channels > 0 && channels <= 512 ? channels : null
  }
}

/** This machine's LAN IPv4 addresses (the interfaces to search from). */
export function lanAddresses() {
  const out = []
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address)
    }
  }
  return out
}

/**
 * Sends the search request (twice) out of each LAN interface and collects replies.
 * @param {{ waitMs?: number, interfaces?: string[] }} [opts]
 * @returns {Promise<{ devices: object[], interfaces: string[] }>} devices deduplicated by MAC and address
 */
export function mhedSearch({ waitMs = 2500, interfaces = lanAddresses() } = {}) {
  return new Promise((resolve, reject) => {
    const found = new Map()
    // reuseAddr lets Linux share the port with other TVT tools; Windows refuses the bind
    // (EACCES) while another program holds 23456, e.g. TVT's IP Tool
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let finished = false
    const finish = (err) => {
      if (finished) return
      finished = true
      try {
        sock.close()
      } catch {}
      if (err) reject(err)
      else resolve({ devices: [...found.values()], interfaces })
    }
    sock.on('error', (e) => {
      const inUse = e.code === 'EADDRINUSE' || (e.code === 'EACCES' && e.syscall === 'bind')
      finish(new Error(inUse ? `UDP port ${MHED_PORT} is in use by another program (for example TVT's IP Tool): close it and search again` : `TVT search failed: ${e.message}`))
    })
    sock.on('message', (buf, from) => {
      const dev = decodeReply(buf)
      if (!dev) return
      dev.from = from.address
      // keyed by MAC and address: the second request's replies merge, but a reply that
      // claims a real device's MAC with another address can't replace that device
      const key = `${dev.mac}|${dev.ip}`
      if (!found.has(key) && found.size >= MAX_DEVICES) return
      found.set(key, dev)
    })
    sock.bind(MHED_PORT, async () => {
      try {
        sock.setMulticastTTL(5)
        const used = []
        for (const iface of interfaces) {
          let joined = 0
          for (const g of GROUPS) {
            try {
              sock.addMembership(g, iface)
              joined++
            } catch {}
          }
          if (joined) used.push(iface)
        }
        interfaces = used
        if (used.length === 0) return finish(new Error('No network interface could join the TVT search group'))
        // UDP can lose a request or a reply (seen: one NVR missing from a search), so send
        // twice, like the SDK does; replies are deduplicated by MAC
        for (let round = 0; round < 2 && !finished; round++) {
          if (round) await new Promise((res) => setTimeout(res, RESEND_MS))
          for (const iface of used) {
            if (finished) break
            sock.setMulticastInterface(iface)
            await new Promise((res) => sock.send(REQUEST, MHED_PORT, GROUP_SEND, () => res()))
          }
        }
        setTimeout(() => finish(), Math.max(0, waitMs - RESEND_MS))
      } catch (e) {
        finish(e)
      }
    })
  })
}

// run directly for a quick search from a PC:  node cctv/mhed.mjs
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const { devices, interfaces } = await mhedSearch()
  console.log(`searched from ${interfaces.join(', ') || 'no interface'}: ${devices.length} device(s)`)
  for (const d of devices) console.log(`${d.ip}:${d.port}  ${d.model || d.type}  "${d.name}"  ${d.mac}  firmware ${d.firmware}${d.channels ? `  ${d.channels} ch` : ''}`)
}
