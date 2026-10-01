// Minimal capture reader for the offline checks: yields the UDP datagrams of a pcapng file, or of
// a classic pcap file (one of the owner's ".pcapng" files is really classic pcap).
// Reads a local file only. Ethernet (with or without one VLAN tag) and raw IP link types, IPv4,
// unfragmented. Not used by the tunnel itself.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

const LINK_ETHERNET = 1
const LINK_RAW = 101

// One captured frame -> the UDP datagram in it, or null.
function udpOf(link, p, truncatedFrame) {
  let o = -1
  if (link === LINK_ETHERNET && p.length >= 14) {
    let et = p.readUInt16BE(12)
    o = 14
    if (et === 0x8100 && p.length >= 18) {
      et = p.readUInt16BE(16)
      o = 18
    }
    if (et !== 0x0800) o = -1
  } else if (link === LINK_RAW) o = 0
  if (o < 0 || p.length < o + 28 || p[o] >> 4 !== 4 || p[o + 9] !== 17 || (p.readUInt16BE(o + 6) & 0x3fff) !== 0) return null
  const u = o + (p[o] & 15) * 4
  if (p.length < u + 8) return null
  const ulen = p.readUInt16BE(u + 4)
  return {
    src: p.subarray(o + 12, o + 16).join('.'),
    dst: p.subarray(o + 16, o + 20).join('.'),
    sport: p.readUInt16BE(u),
    dport: p.readUInt16BE(u + 2),
    payload: p.subarray(u + 8, Math.min(p.length, u + ulen)),
    truncated: truncatedFrame || p.length < u + ulen
  }
}

/** Yields { idx, ts, src, dst, sport, dport, payload, truncated } for every UDP datagram. */
export function* readUdp(file) {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const hdr = Buffer.alloc(24)
    if (size < 24) return
    readSync(fd, hdr, 0, 24, 0)
    const magic = hdr.readUInt32LE(0)
    let idx = 0

    if (magic === 0xa1b2c3d4 || magic === 0xd4c3b2a1 || magic === 0xa1b23c4d || magic === 0x4d3cb2a1) {
      // classic pcap: 24-byte file header, then {ts_sec, ts_frac, incl_len, orig_len} + frame
      const le = magic === 0xa1b2c3d4 || magic === 0xa1b23c4d
      const u32 = (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
      const link = u32(hdr, 20)
      const rec = Buffer.alloc(16)
      let pos = 24
      while (pos + 16 <= size) {
        readSync(fd, rec, 0, 16, pos)
        const cap = u32(rec, 8)
        const orig = u32(rec, 12)
        if (cap > 0x1000000 || pos + 16 + cap > size) break
        const frame = Buffer.alloc(cap)
        readSync(fd, frame, 0, cap, pos + 16)
        const d = udpOf(link, frame, cap < orig)
        if (d) yield { idx, ts: u32(rec, 0) * 1e6 + u32(rec, 4), ...d }
        idx++
        pos += 16 + cap
      }
      return
    }

    // pcapng: blocks {type, length, body, length}
    const links = []
    let pos = 0
    let le = true
    const u32 = (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
    const u16 = (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o))
    while (pos + 12 <= size) {
      readSync(fd, hdr, 0, 12, pos)
      let type = hdr.readUInt32LE(0)
      if (type === 0x0a0d0d0a) {
        le = hdr.readUInt32LE(8) === 0x1a2b3c4d
        links.length = 0
      } else type = u32(hdr, 0)
      const len = u32(hdr, 4)
      if (len < 12 || pos + len > size) break
      if (type === 1 || type === 6) {
        const b = Buffer.alloc(len)
        readSync(fd, b, 0, len, pos)
        if (type === 1) links.push(u16(b, 8))
        else {
          const cap = u32(b, 20)
          const d = udpOf(links[u32(b, 8)], b.subarray(28, 28 + cap), cap < u32(b, 24))
          if (d) yield { idx, ts: u32(b, 12) * 4294967296 + u32(b, 16), ...d }
          idx++
        }
      }
      pos += len
    }
  } finally {
    closeSync(fd)
  }
}
