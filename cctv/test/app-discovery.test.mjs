// Tests for app-discovery.mjs: the announcement on the local network that lets the Android app on a TV
// find this server by itself. Only the packets are tested here (what is asked, what is answered);
// no socket is opened. SDK-free, runs anywhere.
//   node cctv/test/app-discovery.test.mjs
import { SERVICE, answerFor, encodeAnswer, parseQuery } from '../app-discovery.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

/** A DNS name as it goes on the wire: length-prefixed labels, a zero at the end. */
const wireName = (name) => Buffer.concat([...name.split('.').filter(Boolean).map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])])

/** A query packet asking one question, as a phone or TV sends it. */
const query = (name, type = 12, { response = false } = {}) => {
  const head = Buffer.alloc(12)
  if (response) head.writeUInt16BE(0x8400, 2)
  head.writeUInt16BE(1, 4)
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(type, 0)
  tail.writeUInt16BE(1, 2)
  return Buffer.concat([head, wireName(name), tail])
}

/** Reads a name at `at`, following compression pointers. Returns [name, next offset]. */
const readName = (buf, at) => {
  const labels = []
  let next = -1
  let hops = 0
  while (true) {
    const len = buf[at]
    if (len === 0) { at++; break }
    if ((len & 0xc0) === 0xc0) {
      if (next < 0) next = at + 2
      at = ((len & 0x3f) << 8) | buf[at + 1]
      if (++hops > 20) throw new Error('pointer loop')
      continue
    }
    labels.push(buf.toString('utf8', at + 1, at + 1 + len))
    at += 1 + len
  }
  return [labels.join('.'), next < 0 ? at : next]
}

/** The records of an answer packet: [{ name, type, ttl, data }]. */
const records = (buf) => {
  const count = buf.readUInt16BE(6) + buf.readUInt16BE(10)
  const out = []
  let at = 12
  for (let i = 0; i < count; i++) {
    const [name, after] = readName(buf, at)
    const type = buf.readUInt16BE(after)
    const ttl = buf.readUInt32BE(after + 4)
    const len = buf.readUInt16BE(after + 8)
    out.push({ name, type, ttl, data: buf.subarray(after + 10, after + 10 + len), at: after + 10 })
    at = after + 10 + len
  }
  return out
}

const about = { name: 'Argus office', host: 'cctv', port: 8443, url: 'https://cctv.example.com', addresses: ['192.168.1.232'] }

// --- what is being asked
{
  check('a question for the Argus service is understood', parseQuery(query(`${SERVICE}.local`)).some((q) => q.name === `${SERVICE}.local` && q.type === 12))
  check('names are compared without regard to case', answerFor(parseQuery(query('_ARGUS._tcp.LOCAL')), about) !== null)
  check('a question for another service is not ours', answerFor(parseQuery(query('_ipp._tcp.local')), about) === null)
  check('the list of all services gets an answer too', answerFor(parseQuery(query('_services._dns-sd._udp.local')), about) !== null)
  check('another machine\'s answer is not a question', parseQuery(query(`${SERVICE}.local`, 12, { response: true })).length === 0)
  check('a packet cut short is no question, not a crash', parseQuery(query(`${SERVICE}.local`).subarray(0, 20)).length === 0)
  check('an empty packet is no question', parseQuery(Buffer.alloc(0)).length === 0)
  const loop = Buffer.concat([Buffer.alloc(4), Buffer.from([0, 1, 0, 0, 0, 0, 0, 0]), Buffer.from([0xc0, 12, 0, 12, 0, 1])])
  check('a name that points at itself is no question, not a hang', parseQuery(loop).length === 0)
}

// --- what is answered
{
  const packet = encodeAnswer(about)
  check('the answer is marked as an authoritative response', packet.readUInt16BE(2) === 0x8400)
  const recs = records(packet)
  const ptr = recs.find((r) => r.type === 12 && r.name === `${SERVICE}.local`)
  check('it names this server as one instance of the service', ptr && readName(packet, ptr.at)[0] === `Argus office.${SERVICE}.local`, ptr && readName(packet, ptr.at)[0])
  const srv = recs.find((r) => r.type === 33)
  check('it says which port and which host', srv && srv.data.readUInt16BE(4) === 8443 && readName(packet, srv.at + 6)[0] === 'cctv.local')
  const txt = recs.find((r) => r.type === 16)
  const entries = []
  for (let at = 0; txt && at < txt.data.length; at += 1 + txt.data[at]) entries.push(txt.data.toString('utf8', at + 1, at + 1 + txt.data[at]))
  check('it carries the address people should use', entries.includes('url=https://cctv.example.com'), entries.join(' | '))
  check('it says which protocol version it speaks', entries.some((e) => /^v=\d+$/.test(e)))
  const a = recs.find((r) => r.type === 1 && r.name === 'cctv.local')
  check('it gives the machine\'s address', a && [...a.data].join('.') === '192.168.1.232')
  check('every record may be remembered for a while, not for ever', recs.every((r) => r.ttl > 0 && r.ttl <= 4500))
}

// --- awkward details
{
  const noUrl = records(encodeAnswer({ ...about, url: '' })).find((r) => r.type === 16)
  check('with no public address set, none is claimed', !noUrl.data.toString('utf8').includes('url='))
  const long = encodeAnswer({ ...about, name: 'x'.repeat(200) })
  const ptr = records(long).find((r) => r.type === 12)
  check('a name too long for a label is cut to fit', readName(long, ptr.at)[0].split('.')[0].length <= 63)
  const dotted = encodeAnswer({ ...about, name: 'Head.Office' })
  const p2 = records(dotted).find((r) => r.type === 12)
  check('a dot in the name does not split it into two labels', readName(dotted, p2.at)[0].endsWith(`.${SERVICE}.local`) && !readName(dotted, p2.at)[0].startsWith('Head.Office'))
  check('addresses that are not IPv4 are left out', records(encodeAnswer({ ...about, addresses: ['fe80::1', 'nonsense', '10.0.0.5'] })).filter((r) => r.type === 1).length === 1)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
