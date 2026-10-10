// Lets the Android app find this server by itself. A TV box has no camera to scan a setup code
// with and typing an address on a remote is slow, so the server says on the local network "an Argus
// server is here, and this is the address to use", and the app's sign-in screen lists it.
//
// It is the ordinary way devices find each other on a LAN (multicast DNS service discovery, what
// printers and Chromecasts use): the app asks the network for `_argus._tcp`, and every Argus server
// that hears the question answers. The answer carries
//   name   what to call this server in the list
//   url    the address people should use (settings.publicUrl), so the app connects by the name
//          the certificate is for and not by a bare LAN address
//   v      the protocol version, so an app can tell a server too old or too new
// and nothing else: no user names, no camera names, nothing that needs a sign-in to see.
//
// It only ever answers questions from the same network segment (multicast does not cross routers),
// never the internet. CCTV_DISCOVERY=off turns it off. If the port cannot be opened (another
// program holds it exclusively) the server says so once and carries on without it.
import { createSocket } from 'node:dgram'
import { hostname, networkInterfaces } from 'node:os'

export const SERVICE = '_argus._tcp'
const GROUP = '224.0.0.251'
const PORT = 5353
const TTL_S = 120
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 }
const FLUSH = 0x8001 // class IN, and "this replaces what you remembered"
const PROTOCOL = 1
const ALL_SERVICES = '_services._dns-sd._udp.local'

const label = (text) => {
  let b = Buffer.from(String(text), 'utf8')
  if (b.length > 63) b = Buffer.from(b.toString('utf8', 0, 63).replace(/�$/, ''), 'utf8').subarray(0, 63)
  return Buffer.concat([Buffer.from([b.length]), b])
}
/** A name on the wire from its labels (each one whole: a dot inside a label stays inside it). */
const nameOf = (labels) => Buffer.concat([...labels.filter((l) => l !== '').map(label), Buffer.from([0])])
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b }
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const record = (name, type, cls, data) => Buffer.concat([name, u16(type), u16(cls), u32(TTL_S), u16(data.length), data])
const ipv4 = (s) => {
  const parts = String(s).split('.')
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null
  return Buffer.from(parts.map(Number))
}

/**
 * The questions in a packet: [{ name, type }], names lower-cased. A packet that is an answer, is cut
 * short, or is malformed in any way has none; this reads bytes from anyone on the network.
 */
export function parseQuery(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return []
    if (buf.readUInt16BE(2) & 0x8000) return [] // somebody's answer
    const count = Math.min(buf.readUInt16BE(4), 32)
    const out = []
    let at = 12
    for (let i = 0; i < count; i++) {
      const labels = []
      let pos = at
      let end = -1
      let hops = 0
      while (true) {
        if (pos >= buf.length) return []
        const len = buf[pos]
        if (len === 0) { pos++; break }
        if ((len & 0xc0) === 0xc0) {
          if (pos + 1 >= buf.length || ++hops > 16) return []
          if (end < 0) end = pos + 2
          pos = ((len & 0x3f) << 8) | buf[pos + 1]
          continue
        }
        if (len > 63 || pos + 1 + len > buf.length || labels.length > 32) return []
        labels.push(buf.toString('utf8', pos + 1, pos + 1 + len))
        pos += 1 + len
      }
      const after = end < 0 ? pos : end
      if (after + 4 > buf.length) return []
      out.push({ name: labels.join('.').toLowerCase(), type: buf.readUInt16BE(after) })
      at = after + 4
    }
    return out
  } catch {
    return []
  }
}

/**
 * The whole announcement as one packet: the service points at this server, this server is at this
 * host and port, with these notes, and the host is at these addresses.
 * @param {{ name: string, host: string, port: number, url?: string, addresses?: string[] }} about
 */
export function encodeAnswer({ name, host, port, url = '', addresses = [] }) {
  const service = nameOf([...SERVICE.split('.'), 'local'])
  const instance = nameOf([String(name || 'Argus').replace(/\./g, ' '), ...SERVICE.split('.'), 'local'])
  const target = nameOf([String(host || 'argus').split('.')[0], 'local'])
  const notes = [`v=${PROTOCOL}`, `name=${String(name || 'Argus').slice(0, 60)}`]
  if (url) notes.push(`url=${url}`)
  const txt = Buffer.concat(notes.map((n) => { const b = Buffer.from(n, 'utf8').subarray(0, 255); return Buffer.concat([Buffer.from([b.length]), b]) }))
  const records = [
    record(service, TYPE.PTR, 1, instance), // shared by every Argus server: never "replaces"
    record(instance, TYPE.SRV, FLUSH, Buffer.concat([u16(0), u16(0), u16(port), target])),
    record(instance, TYPE.TXT, FLUSH, txt),
    ...addresses.map(ipv4).filter(Boolean).map((a) => record(target, TYPE.A, FLUSH, a))
  ]
  const head = Buffer.alloc(12)
  head.writeUInt16BE(0x8400, 2) // a response, authoritative
  head.writeUInt16BE(records.length, 6)
  return Buffer.concat([head, ...records])
}

/** The packet to send for these questions, or null when none of them is about Argus. */
export function answerFor(questions, about) {
  const wanted = `${SERVICE}.local`
  const ours = questions.some((q) => (q.type === TYPE.PTR || q.type === 255) && (q.name === wanted || q.name === ALL_SERVICES))
  return ours ? encodeAnswer(about) : null
}

const lanAddresses = () =>
  Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)

/**
 * Starts answering. `about` is asked for at each answer, so a public address set later in Settings
 * is announced without a restart.
 * @param {{ about: () => { name?: string, port: number, url?: string }, log?: Function }} o
 * @returns {() => void} stops it
 */
export function startDiscovery({ about, log = console.log }) {
  if (String(process.env.CCTV_DISCOVERY ?? '').toLowerCase() === 'off') return () => {}
  const socket = createSocket({ type: 'udp4', reuseAddr: true })
  let lastSent = 0
  socket.on('error', (e) => {
    log(`[discovery] not announcing this server on the network: ${e.message}`)
    try { socket.close() } catch {}
  })
  socket.on('message', (msg) => {
    try {
      const a = about()
      const packet = answerFor(parseQuery(msg), { name: a.name || hostname(), host: hostname(), port: a.port, url: a.url ?? '', addresses: lanAddresses() })
      // at most one answer a second, however many ask: a flood of questions is not multiplied
      if (!packet || Date.now() - lastSent < 1000) return
      lastSent = Date.now()
      socket.send(packet, PORT, GROUP)
    } catch (e) {
      log(`[discovery] could not answer: ${e.message}`)
    }
  })
  socket.bind(PORT, () => {
    let joined = 0
    for (const address of lanAddresses()) {
      try { socket.addMembership(GROUP, address); joined++ } catch {}
    }
    if (!joined) { try { socket.addMembership(GROUP) } catch {} }
    socket.setMulticastTTL(255)
    log('[discovery] announcing this server on the local network (for the Android app)')
  })
  socket.unref()
  return () => { try { socket.close() } catch {} }
}
