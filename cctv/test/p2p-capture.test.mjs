// Offline check of the P2P code against the owner's own packet captures. Reads local files only;
// nothing is sent. The captures are NOT in the repository:
//   P2P_CAPTURE_DIR   folder holding the *.pcapng files; without it this test prints SKIP
//   P2P_CAPTURE_FILES optional, comma-separated file names to limit the run (default: every *.pcapng)
//   P2P_STREAM_DIR    optional, folder holding earlier rebuilt streams
//                     (stream-<first 8 hex of the connection id>-C-1.bin / -P-1.bin) to compare with
//   node cctv/test/p2p-capture.test.mjs
// It prints counts, sizes and yes/no only: no address, serial, key or payload byte.
//
// What it does for every capture:
//   1. decodes every P2P 2.0 datagram with wire.mjs and encodes it again: must be byte-identical;
//   2. checks each datagram's structure by kind (SYN step / version, ACK list, record magic);
//   3. rebuilds every server link with reliable.mjs + RecordParser and reads each command packet's
//      clear-text envelope; XOR packets (the redirect request) are opened and built again with
//      messages.mjs from the same inputs: must be byte-identical on the wire;
//   4. checks sizes of the encrypted messages against what messages.mjs builds for the same lengths;
//   5. rebuilds both tunnelled byte streams of every device link with reliable.mjs.
// What cannot be checked here: the inside of the RSA and AES bodies (no key in a capture).
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sessionKeyFromBytes } from '../p2p/crypt.mjs'
import { buildP2PConnectRequest, buildPeerCommand, buildRedirectRequest, buildRelaySynStep1, parseRedirectRequest, redirectRequestJson, serverDatagrams } from '../p2p/messages.mjs'
import { readUdp } from '../p2p/pcapng.mjs'
import { ReliableLink } from '../p2p/reliable.mjs'
import { CATEGORY, CMD, ENC, RecordParser, UDT_VERSION, aesCipherLen, decodeAckList, decodeDatagram, decodeEnvelope, decodeSyn, encodeDatagram, looksLikeDatagram, rsaCipherLen } from '../p2p/wire.mjs'

const DIR = process.env.P2P_CAPTURE_DIR
if (!DIR || !existsSync(DIR)) {
  console.log('SKIP  P2P_CAPTURE_DIR is not set (or not there): the capture checks need the owner\'s own captures')
  process.exit(0)
}
const only = (process.env.P2P_CAPTURE_FILES || '').split(',').map((s) => s.trim()).filter(Boolean)
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.pcapng') && (!only.length || only.includes(f)))
  .sort()
const STREAMS = process.env.P2P_STREAM_DIR && existsSync(process.env.P2P_STREAM_DIR) ? process.env.P2P_STREAM_DIR : null

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const info = (text) => console.log(`INFO  ${text}`)
const NAT1_PORT = 8989 // the old NAT 1.0 lookup: another protocol whose packets can look alike
const tally = (o, k, n = 1) => (o[k] = (o[k] || 0) + n)
const table = (o) =>
  Object.keys(o)
    .sort()
    .map((k) => `${k} x${o[k]}`)
    .join('; ')
const fileSha = (path) =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (b) => h.update(b))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
// keys made here, only to build messages of the same length as the captured ones
const dummyKey = sessionKeyFromBytes(Buffer.alloc(16, 1))
const zero16 = Buffer.alloc(16)
const isPrivate = (ip) => /^(10.|192.168.|172.(1[6-9]|2d|3[01]).|169.254.)/.test(ip)
/** true = sent by the client, false = sent to it, null = cannot tell (both ends on the LAN) */
const sentByClient = (d) => (isPrivate(d.src) && !isPrivate(d.dst) ? true : !isPrivate(d.src) && isPrivate(d.dst) ? false : null)

const totals = { files: 0, p2p: 0, roundTrip: 0, redirect: 0, redirectIdentical: 0, streams: 0, streamsCompared: 0 }

for (const name of files) {
  const path = join(DIR, name)
  const size = statSync(path).size
  if (size < 1024) {
    info(`${name}: ${size} bytes, no packets in it`)
    continue
  }
  totals.files++
  const st = { udp: 0, truncated: 0, nat1: 0, other: 0, p2p: 0, roundTrip: 0, bad: {} }
  const kinds = {}
  const syn = {}
  const rst = {}
  const peerCmd = {}
  const relay = {}
  const server = new Map() // connection id + direction -> { link, parser, fromClient, port }
  const serverMsgs = {}
  const redirect = { seen: 0, identical: 0, jsonSame: 0, sizes: {}, pemSizes: {} }
  const aesForms = { client: 0, clientOther: 0, serverNoExtra: 0, serverExtra: 0, serverNeither: 0 }
  const rsa = { n: 0, fit: 0 }
  const reqSizes = { n: 0, same: 0 }
  const conns = new Map() // device links: connection id -> { firstSrc, firstDst, common, dirs }

  const serverRecord = (packet, fromClient, port, h, wire) => {
    let env
    try {
      env = decodeEnvelope(packet)
    } catch {
      tally(st.bad, 'server record that is not a command packet')
      return
    }
    const dir = fromClient ? `C> :${port}` : `>C :${port}`
    if (env.encType === ENC.XOR) {
      redirect.seen++
      try {
        const r = parseRedirectRequest(packet)
        tally(redirect.sizes, wire.length)
        tally(redirect.pemSizes, Buffer.byteLength(r.publicPem ?? ''))
        const j = r.json
        if (redirectRequestJson({ cid: j.cid, isp: j.isp, svid: j.svid, cty: j.cty, isFull: j.isfull === 1 }) === r.jsonText) redirect.jsonSame++
        const rebuilt = serverDatagrams({
          connectionId: Buffer.from(h.connectionId),
          packet: buildRedirectRequest({ cid: j.cid, isp: j.isp, svid: j.svid, cty: j.cty, isFull: j.isfull === 1, publicPem: r.publicPem, cmdId: r.cmdId, time: r.time, xorKey: r.xorKey }),
          firstSendCounter: h.sendCounter,
          peerCounter: h.peerCounter,
          firstDataIndex: h.dataIndex,
          ackIndex: h.ackIndex
        })
        if (rebuilt.length === 1 && rebuilt[0].equals(wire)) redirect.identical++
        tally(serverMsgs, `${dir} XOR redirect request "${Object.keys(j).join(',')}" cty ${j.cty}${j.isfull ? ' isfull' : ''} wire ${wire.length}`)
      } catch (e) {
        tally(st.bad, `XOR packet that does not parse as a redirect request: ${e.message}`)
      }
      return
    }
    if (env.encType === ENC.RSA) {
      rsa.n++
      if (env.body.length === rsaCipherLen(env.plainLen)) rsa.fit++
      tally(serverMsgs, `${dir} RSA record ${packet.length} plain ${env.plainLen} blocks ${env.body.length / 128}`)
      return
    }
    if (env.encType === ENC.AES) {
      const clientForm = env.body.length === aesCipherLen(env.plainLen)
      const noExtra = env.body.length === Math.ceil(env.plainLen / 16) * 16
      if (fromClient) clientForm ? aesForms.client++ : aesForms.clientOther++
      else if (noExtra && !clientForm) aesForms.serverNoExtra++
      else if (clientForm && !noExtra) aesForms.serverExtra++
      else if (!clientForm && !noExtra) aesForms.serverNeither++
      tally(serverMsgs, `${dir} AES record ${packet.length} plain ${env.plainLen} wire ${wire ? wire.length : 'several datagrams'}`)
      if (fromClient && wire && port !== 8635 && port !== 8636 && env.plainLen > 200) {
        // a P2P connect request of the same JSON length, built here: same size, same clear fields
        reqSizes.n++
        const pad = env.plainLen - 24 - buildFillerLen()
        const mine = buildP2PConnectRequest({ cc: 'X', rip: { ip: '00000000', port: 1 }, lp: 1, p2v: '1.1.2', cty: 5, cv: 'v'.repeat(Math.max(0, pad)), sessionKey: dummyKey, keyId0: env.keyId0, keyId1: env.keyId1, cmdId: 1, time: 1 })
        const dg = serverDatagrams({ connectionId: zero16, packet: mine })
        const me = decodeEnvelope(mine)
        if (dg.length === 1 && dg[0].length === wire.length && me.len === env.len && me.plainLen === env.plainLen && mine.subarray(0, 0x14).equals(packet.subarray(0, 0x14))) reqSizes.same++
      }
      return
    }
    tally(serverMsgs, `${dir} plain record ${packet.length}`)
  }

  for (const d of readUdp(path)) {
    st.udp++
    if (d.truncated) {
      st.truncated++
      continue
    }
    if (d.sport === NAT1_PORT || d.dport === NAT1_PORT) {
      st.nat1++
      continue
    }
    const p = d.payload
    if (!looksLikeDatagram(p)) {
      st.other++
      continue
    }
    st.p2p++
    const h = decodeDatagram(p)
    if (encodeDatagram(h, h.payload).equals(p)) st.roundTrip++
    const src = `${d.src}:${d.sport}`
    const dst = `${d.dst}:${d.dport}`
    const cmdName = ['SYN', 'DATA', 'ACK', 'RST'][h.command]
    tally(kinds, `${h.category === 2 ? 'server' : 'peer'} ${cmdName}${h.command === CMD.DATA && h.dataType ? ' (peer command)' : ''}`)

    if (h.category === CATEGORY.SERVER) {
      const id = h.connectionId.toString('hex')
      if (h.command === CMD.SYN || h.command === CMD.RST) {
        tally(st.bad, `server ${cmdName} (the client never sends one)`)
        continue
      }
      if (h.command === CMD.DATA && h.dataIndex === 2 && h.payload.toString('latin1', 0, 4) !== '1010') {
        tally(st.bad, 'server DATA index 2 without "1010"')
        continue
      }
      if (h.command === CMD.ACK) {
        if (h.payload.length % 4) tally(st.bad, 'ragged ACK list')
        continue
      }
      // the cloud servers are on public addresses; if both ends are private, the low port is the server
      const fromClient = sentByClient(d) ?? (d.dport < d.sport && d.dport < 20000)
      const key = `${id}${fromClient ? 'C' : 'S'}`
      let s = server.get(key)
      if (!s) server.set(key, (s = { link: new ReliableLink({ connectionId: Buffer.from(h.connectionId), category: CATEGORY.SERVER }), parser: new RecordParser(), fromClient, port: fromClient ? d.dport : d.sport, wires: new Map() }))
      if (!s.wires.has(h.dataIndex)) s.wires.set(h.dataIndex, Buffer.from(p))
      s.link.receive(p, 0)
      s.link.takeDatagrams()
      const bytes = s.link.takeBytes()
      if (bytes.length) {
        let recs
        try {
          recs = s.parser.push(bytes)
        } catch {
          tally(st.bad, 'server stream that is not "1010" records')
          recs = []
        }
        for (const r of recs) {
          const single = s.wires.size === 1 && s.wires.get(2)?.length === 36 + 8 + r.length
          serverRecord(r, s.fromClient, s.port, decodeDatagram(s.wires.get(2) ?? p), single ? s.wires.get(2) : null)
          s.wires.clear()
        }
      }
      continue
    }

    // ---- device link (category 1)
    const id = h.connectionId.toString('hex')
    let c = conns.get(id)
    if (!c) conns.set(id, (c = { firstSrc: src, firstDst: dst, common: null, dirs: {} }))
    if (!c.common && !(src === c.firstSrc && dst === c.firstDst) && !(src === c.firstDst && dst === c.firstSrc)) {
      // a second path: the endpoint present on both is the client's one socket
      c.common = src === c.firstSrc || dst === c.firstSrc ? c.firstSrc : c.firstDst
    }
    const fromFirst = c.common ? (src === c.common) === (c.common === c.firstSrc) : src === c.firstSrc
    const dk = fromFirst ? 'x' : 'y'
    let D = c.dirs[dk]
    if (!D) c.dirs[dk] = D = { src, wan: sentByClient(d), link: null, hash: createHash('sha256'), bytes: 0, first: null, datagrams: 0, maxIdx: 0, paths: {}, head: null, cmds: 0, replay: true, seen: new Set() }
    D.datagrams++

    if (h.command === CMD.SYN) {
      let s
      try {
        s = decodeSyn(h)
      } catch {
        tally(st.bad, 'SYN without step / version')
        continue
      }
      if (s.version !== UDT_VERSION) tally(st.bad, `SYN version 0x${s.version.toString(16)}`)
      if (s.step < 1 || s.step > 4) tally(st.bad, `SYN step ${s.step}`)
      if (h.sendCounter || h.peerCounter || h.dataIndex || h.ackIndex) tally(st.bad, 'SYN with a non-zero word')
      tally(syn, `${dk} ct${h.connectType} step${s.step} body ${s.body.length}`)
      if (h.connectType === 4 && s.step === 1 && s.body.length) {
        try {
          const env = decodeEnvelope(s.body)
          const tokenLen = env.plainLen - 72
          const mine = buildRelaySynStep1({ rid: Buffer.from(h.connectionId), relayToken: Buffer.alloc(Math.max(0, tokenLen)), sessionKey: dummyKey, keyId0: 1, keyId1: 2, cmdId: 1, time: 1 })
          tally(relay, `enc ${env.encType} plain ${env.plainLen} (token ${tokenLen} bytes) cipher ${env.body.length}: built here with the same token length ${mine.length === p.length && env.body.length === aesCipherLen(env.plainLen) ? 'has the same size' : 'DIFFERS in size'}`)
        } catch {
          tally(relay, 'body that is not a command packet')
        }
      }
      continue
    }
    if (h.command === CMD.RST) {
      tally(rst, `${dk} ct${h.connectType} ${p.length} bytes${p.length === 40 ? ` version 0x${p.readUInt16LE(38).toString(16)}` : ''}`)
      if (p.length !== 36 && p.length !== 40) tally(st.bad, `RST of ${p.length} bytes`)
      continue
    }
    if (h.command === CMD.ACK) {
      if (h.payload.length % 4 || decodeAckList(h.payload).length > 309) tally(st.bad, 'bad ACK list')
      if (h.dataIndex !== 0) tally(st.bad, 'ACK with a data index')
    } else {
      if (!h.payload.length) tally(st.bad, 'DATA without payload')
      if (D.first === null) {
        D.first = h.dataIndex
        // a capture that starts mid-session: begin where it begins
        if (h.dataIndex !== 2) {
          if (!D.link) D.link = new ReliableLink({ connectionId: Buffer.from(h.connectionId) })
          if (D.link.nextExpected === 2) D.link.nextExpected = h.dataIndex
          D.replay = false
        }
      }
      if (h.dataIndex > D.maxIdx) D.maxIdx = h.dataIndex
      D.seen.add(h.dataIndex)
      tally(D.paths, `ct${h.connectType}`)
      if (h.dataType === 1) {
        try {
          const env = decodeEnvelope(h.payload)
          const mine = buildPeerCommand({ json: 'j'.repeat(Math.max(0, env.plainLen - 24)), linkKey: dummyKey, cmdId: 1, time: 1 })
          tally(peerCmd, `${dk} index ${h.dataIndex} enc ${env.encType} key ids ${env.keyId0 || env.keyId1 ? 'set' : '0/0'} plain ${env.plainLen} payload ${h.payload.length}: built here for the same JSON length ${mine.length === h.payload.length ? 'has the same size' : 'DIFFERS in size'}`)
        } catch {
          tally(st.bad, 'peer command that is not a command packet')
        }
      }
    }
    if (!D.link) D.link = new ReliableLink({ connectionId: Buffer.from(h.connectionId) })
    D.link.receive(p, 0)
    D.link.takeDatagrams()
    const b = D.link.takeBytes()
    if (b.length) {
      if (D.head === null) D.head = b.toString('latin1', 0, 4)
      D.hash.update(b)
      D.bytes += b.length
    }
    D.cmds += D.link.takePeerCommands().length
  }

  // ------------------------------------------------------------------------- report this file
  totals.p2p += st.p2p
  totals.roundTrip += st.roundTrip
  console.log(`\n== ${name} (${(size / 1048576).toFixed(1)} MB): ${st.udp} UDP datagrams; ${st.p2p} are P2P 2.0, ${st.nat1} NAT 1.0 (port ${NAT1_PORT}, not ours), ${st.other} other traffic, ${st.truncated} cut short by the capture`)
  if (!st.p2p) {
    info('no P2P 2.0 datagram in this file')
    continue
  }
  info(`kinds: ${table(kinds)}`)
  check(`${name}: every P2P datagram decodes and encodes back byte-identical`, st.roundTrip === st.p2p, `${st.roundTrip}/${st.p2p}`)
  check(`${name}: every datagram has the structure of its kind`, Object.keys(st.bad).length === 0, table(st.bad))

  if (Object.keys(serverMsgs).length) {
    info(`server links rebuilt: ${server.size}; records: ${table(serverMsgs)}`)
    const open = [...server.values()].filter((s) => s.parser.pending).length
    check(`${name}: every server link is whole "1010" records`, open === 0, open ? `${open} with a cut-off record (capture ended, or a datagram is missing)` : '')
  }
  if (redirect.seen) {
    totals.redirect += redirect.seen
    totals.redirectIdentical += redirect.identical
    check(`${name}: redirect request JSON is what messages.mjs writes for the same values`, redirect.jsonSame === redirect.seen, `${redirect.jsonSame}/${redirect.seen}`)
    check(`${name}: redirect request built by messages.mjs from the same inputs is byte-identical on the wire`, redirect.identical === redirect.seen, `${redirect.identical}/${redirect.seen}; wire sizes ${table(redirect.sizes)}; PEM sizes ${table(redirect.pemSizes)}`)
  }
  if (rsa.n) check(`${name}: RSA records are 128 bytes per 117 plain bytes`, rsa.fit === rsa.n, `${rsa.fit}/${rsa.n}`)
  if (aesForms.client + aesForms.clientOther) check(`${name}: AES packets from the client are (plain & ~15) + 16 cipher bytes`, aesForms.clientOther === 0, `${aesForms.client}/${aesForms.client + aesForms.clientOther}`)
  if (aesForms.serverNoExtra + aesForms.serverExtra + aesForms.serverNeither) {
    check(`${name}: AES packets from servers fit one of the two paddings openCommand accepts`, aesForms.serverNeither === 0)
    info(`AES from servers where the two paddings differ: ${aesForms.serverNoExtra} without the extra block, ${aesForms.serverExtra} with it`)
  }
  if (reqSizes.n) check(`${name}: an AES request built by messages.mjs for the same JSON length has the same size and clear fields`, reqSizes.same === reqSizes.n, `${reqSizes.same}/${reqSizes.n}`)
  if (Object.keys(syn).length) info(`SYN (x / y = the two directions): ${table(syn)}`)
  if (Object.keys(relay).length) {
    info(`relay step 1: ${table(relay)}`)
    check(`${name}: relay step 1 built by messages.mjs has the captured size`, Object.keys(relay).every((k) => k.includes('has the same size')))
  }
  if (Object.keys(peerCmd).length) {
    info(`peer command: ${table(peerCmd)}`)
    check(`${name}: peer command built by messages.mjs has the captured size`, Object.keys(peerCmd).every((k) => k.includes('has the same size') && k.includes('enc 2') && k.includes('0/0')))
  }
  if (Object.keys(rst).length) info(`RST: ${table(rst)}`)

  for (const [id, c] of conns) {
    const tag = id.slice(0, 8)
    for (const dk of ['x', 'y']) {
      const D = c.dirs[dk]
      if (!D || !D.link || D.first === null) continue
      const fromClient = c.common ? D.src === c.common : D.wan
      const who = fromClient === null ? `direction ${dk}` : fromClient ? 'client -> NVR' : 'NVR -> client'
      const L = D.link
      const delivered = L.nextExpected - 1
      // the capture itself can lack datagrams; the link can only deliver up to the first hole
      let reachable = D.first - 1
      while (D.seen.has(reachable + 1)) reachable++
      let absent = 0
      for (let i = D.first; i <= D.maxIdx; i++) if (!D.seen.has(i)) absent++
      totals.streams++
      info(`link ${tag}.. ${who}: ${D.datagrams} datagrams, data indexes ${D.first}..${D.maxIdx}, paths ${table(D.paths)}; rebuilt ${D.bytes} stream bytes, ${D.cmds} peer command(s), ${L.stats.duplicates} duplicate copies dropped, ${L.stats.outOfOrder} arrived out of order${D.head ? `, starts "${/^[ -~]{4}$/.test(D.head) ? D.head : '....'}"` : ''}${D.replay ? '' : ' (capture starts mid-session)'}`)
      check(
        `${name}: link ${tag}.. ${who}: reliable.mjs delivers in order every data index the capture holds${absent ? ' up to its first hole' : ''}`,
        delivered === reachable,
        absent ? `${absent} index(es) between ${D.first} and ${D.maxIdx} are not in the capture; delivered up to ${delivered}, first hole after ${reachable}` : `${D.first}..${delivered}`
      )
      if (STREAMS && fromClient !== null) {
        const ref = join(STREAMS, `stream-${tag}-${fromClient ? 'C' : 'P'}-1.bin`)
        if (existsSync(ref) && (!D.replay || statSync(ref).size !== D.bytes)) {
          info(`link ${tag}.. ${who}: an earlier rebuild of this connection exists but is from another capture (${statSync(ref).size} bytes there, ${D.bytes} here${D.replay ? '' : ', and this capture starts mid-session'}): not compared`)
        } else if (existsSync(ref)) {
          totals.streamsCompared++
          const want = await fileSha(ref)
          const got = D.hash.copy().digest('hex')
          check(`${name}: link ${tag}.. ${who}: rebuilt stream is byte-for-byte the earlier rebuild (TEST 1)`, got === want, `${D.bytes} bytes, sha-256 ${got === want ? 'equal' : 'DIFFERENT'}`)
        }
      }
    }
  }
}

function buildFillerLen() {
  // JSON length of the request with an empty `cv`; the caller pads `cv` up to the captured length
  return buildFillerLen.n ?? (buildFillerLen.n = JSON.stringify({ ct: 0, cc: 'X', rip: { ip: '00000000', port: 1 }, p2pid: '', lanIps: [], lp: 1, p2v: '1.1.2', cty: 5, svid: '', cv: '' }).length)
}

console.log(`\ntotals: ${totals.files} capture file(s), ${totals.p2p} P2P datagrams, ${totals.roundTrip} byte-identical after decode + encode; ${totals.redirectIdentical}/${totals.redirect} redirect requests rebuilt byte-identical; ${totals.streams} stream direction(s) rebuilt, ${totals.streamsCompared} compared with earlier rebuilds${STREAMS ? '' : ' (P2P_STREAM_DIR not set)'}`)
check('at least one capture with P2P datagrams was read', totals.p2p > 0)
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
