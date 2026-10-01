// Offline tests for the P2P 2.0 handshake messages (p2p/messages.mjs). Every serial, address, key
// and token here is made up; nothing is sent.
//   node cctv/test/p2p-messages.test.mjs
import { generateRsaKeyPair, sessionKeyFromBytes } from '../p2p/crypt.mjs'
import {
  ITEM,
  LINUX_P2V,
  OSSIA_VALUES,
  answerSynStep1,
  answerSynStep2,
  answerSynStep3,
  b64NoPad,
  buildP2PConnectReply,
  buildP2PConnectRequest,
  buildPeerCommand,
  buildRedirectReply,
  buildRedirectRequest,
  buildRelaySynStep1,
  buildSynStep1,
  buildSynStep2Body,
  buildSynStep3Body,
  connectCandidates,
  createCmdIds,
  hexToIp,
  ipv4ToHex,
  minSyncCount,
  p2pConnectRequestJson,
  parseP2PConnectReply,
  parseP2PConnectRequest,
  parsePeerCommand,
  parseRedirectReply,
  parseRedirectRequest,
  parseRelaySyncBody,
  parseSynStep2Body,
  parseSynStep3Body,
  redirectRequestJson,
  serverDatagrams
} from '../p2p/messages.mjs'
import { CONNECT_TYPE, ENC, RecordParser, decodeDatagram, decodeEnvelope, decodeSyn, encodeCommand } from '../p2p/wire.mjs'
import { aesEcbEncrypt, sealCommand } from '../p2p/crypt.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const threw = (fn) => {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}

const pair = generateRsaKeyPair()
const connId = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', 'hex')
const SERIAL = 'TESTSERIAL00' // made up

// ---- helpers
check('IPv4 to hex is the bytes in network order, lowercase', ipv4ToHex('192.0.2.10') === 'c000020a')
check('hex to IPv4', hexToIp('c000020a') === '192.0.2.10')
check('IPv6 text passes through hexToIp', hexToIp('2001:db8::1') === '2001:db8::1')
check('a bad IPv4 is refused', threw(() => ipv4ToHex('300.1.1.1')) !== null)
check('base64 of 16 bytes without padding is 22 characters', b64NoPad(connId).length === 22 && !b64NoPad(connId).includes('='))
{
  const next = createCmdIds()
  check('command ids count from 1', next() === 1 && next() === 2)
  const wrap = createCmdIds(0xffffffff)
  check('after 0xffffffff the command id is 1', wrap() === 1)
}

// ---- 1. redirect request
{
  const json = redirectRequestJson({ ...OSSIA_VALUES })
  check('redirect JSON with the Ossia values is the text read from the capture', json === '{"rt":"p2p","cid":"","isp":"","svid":"","cty":5,"et":1}')
  check('that JSON is 55 bytes', json.length === 55)
  check('isFull adds "isfull":1 before "et"', redirectRequestJson({ cty: 5, isFull: true }) === '{"rt":"p2p","cid":"","isp":"","svid":"","cty":5,"isfull":1,"et":1}')
  check('cty has no default: leaving it out is refused', threw(() => redirectRequestJson({})) !== null)

  const xorKey = Buffer.from('11223344', 'hex')
  const packet = buildRedirectRequest({ cty: 5, publicPem: pair.publicPem, cmdId: 1, time: 1700000000, xorKey })
  check('redirect request packet is 350 bytes ("1010" length in the capture)', packet.length === 350, String(packet.length))
  const dg = serverDatagrams({ connectionId: connId, packet })
  check('redirect request is one datagram of 394 bytes', dg.length === 1 && dg[0].length === 394)
  const h = decodeDatagram(dg[0])
  check('datagram starts 02 01 01 00', dg[0].subarray(0, 4).toString('hex') === '02010100')
  check('the four words are 1 / 0 / 2 / 1', h.sendCounter === 1 && h.peerCounter === 0 && h.dataIndex === 2 && h.ackIndex === 1)
  check('payload is "1010" + length 350', h.payload.toString('latin1', 0, 4) === '1010' && h.payload.readUInt32LE(4) === 350)
  const env = decodeEnvelope(packet)
  check('encrypt type 3 with the key in the packet', env.encType === ENC.XOR && env.xorKey.equals(xorKey))
  check('the JSON is not readable before the XOR is undone', !packet.includes('"rt"'))
  const r = parseRedirectRequest(packet)
  check('request parses back: JSON, key, id, time', r.json.rt === 'p2p' && r.json.cty === 5 && r.json.et === 1 && r.cmdId === 1 && r.time === 1700000000)
  check('request carries the PEM public key, 251 bytes', r.publicPem === pair.publicPem && Buffer.byteLength(r.publicPem) === 251)

  const full = serverDatagrams({ connectionId: connId, packet: buildRedirectRequest({ cty: 5, isFull: true, publicPem: pair.publicPem, cmdId: 2, time: 1, xorKey }) })
  check('with isFull the datagram is 405 bytes', full[0].length === 405)
  check('a two-digit cty makes it one byte longer', serverDatagrams({ connectionId: connId, packet: buildRedirectRequest({ cty: 12, publicPem: pair.publicPem, cmdId: 2, time: 1, xorKey }) })[0].length === 395)
}

// ---- 2. redirect reply
const keyBytes = Buffer.from('0f1e2d3c4b5a69788796a5b4c3d2e1f0', 'hex')
const sessionKey = sessionKeyFromBytes(keyBytes)
{
  const json = {
    lc: 'xx',
    serverList: [
      { ip: 'c6336402', port: 7645, order: 2, cTimeout: 15 },
      { ip: 'c6336401', port: 7635, order: 1, cTimeout: 15 }
    ],
    pubIp: { ip: 'cb007101', port: 40000 },
    et: 2
  }
  const packet = buildRedirectReply({ json, keyId0: 0x01020304, keyId1: 0x05060708, keyBytes, publicPem: pair.publicPem, cmdId: 1, time: 1700000001 })
  const env = decodeEnvelope(packet)
  check('reply is encrypt type 1 in 128-byte blocks', env.encType === ENC.RSA && env.body.length % 128 === 0)
  const r = parseRedirectReply(packet, { privatePem: pair.privatePem })
  check('server list comes back sorted by order, ip as dotted text', r.serverList.length === 2 && r.serverList[0].ip === '198.51.100.1' && r.serverList[0].port === 7635 && r.serverList[1].order === 2)
  check('cTimeout is kept', r.serverList[0].cTimeout === 15)
  check('our public address is decoded, hex form kept for the next request', r.pubIp.ip === '203.0.113.1' && r.pubIp.ipHex === 'cb007101' && r.pubIp.port === 40000)
  check('et and locality code come back', r.et === 2 && r.lc === 'xx' && r.ac === null)
  check('key ids come from item 0x05', r.keyId0 === 0x01020304 && r.keyId1 === 0x05060708)
  check('session key is the 16 key bytes as 32 lowercase hex characters', r.sessionKey.toString('latin1') === '0f1e2d3c4b5a69788796a5b4c3d2e1f0' && r.sessionKey.equals(sessionKey))

  // 180 plain bytes is what the capture's 312-byte reply holds: two blocks
  const pad = 'x'.repeat(180 - 16 - 8 - 8 - 24 - JSON.stringify({ et: 2, lc: '' }).length)
  const small = buildRedirectReply({ json: { et: 2, lc: pad }, keyId0: 1, keyId1: 2, keyBytes, publicPem: pair.publicPem, cmdId: 1, time: 1 })
  check('a 180-byte reply is 268 bytes: 312 on the wire, as captured', decodeEnvelope(small).plainLen === 180 && 36 + 8 + small.length === 312)

  const other = generateRsaKeyPair()
  check('the reply does not open with another private key', threw(() => parseRedirectReply(packet, { privatePem: other.privatePem })) !== null)
  const noKey = sealCommand(encodeCommand({ cmdType: 2, cmdId: 1, time: 1, items: [{ id: ITEM.REDIRECT_REPLY_JSON, data: '{"et":2}' }] }), { encType: ENC.RSA, publicPem: pair.publicPem })
  check('a reply without the key record is refused', /0x5/.test(threw(() => parseRedirectReply(noKey, { privatePem: pair.privatePem }))?.message ?? ''))
  const noEt = buildRedirectReply({ json: { serverList: [] }, keyId0: 1, keyId1: 2, keyBytes, publicPem: pair.publicPem, cmdId: 1, time: 1 })
  check('a reply without "et" is refused', threw(() => parseRedirectReply(noEt, { privatePem: pair.privatePem })) !== null)
  const et7 = buildRedirectReply({ json: { et: 7 }, keyId0: 1, keyId1: 2, keyBytes, publicPem: pair.publicPem, cmdId: 1, time: 1 })
  check('an encrypt type above 3 is refused', threw(() => parseRedirectReply(et7, { privatePem: pair.privatePem })) !== null)

  // the full list: one RSA record over several datagrams
  const many = { et: 2, serverList: Array.from({ length: 60 }, (_, i) => ({ ip: ipv4ToHex(`198.51.100.${i + 1}`), port: 7635, order: 1, cTimeout: 15 })) }
  const big = buildRedirectReply({ json: many, keyId0: 1, keyId1: 2, keyBytes, publicPem: pair.publicPem, cmdId: 1, time: 1 })
  const dgs = serverDatagrams({ connectionId: connId, packet: big })
  check('a long reply is cut into 1272-byte datagrams with data indexes 2, 3, ..', dgs.length > 1 && dgs[0].length === 1272 && decodeDatagram(dgs[1]).dataIndex === 3)
  const rp = new RecordParser()
  let recs = []
  for (const d of dgs) recs = recs.concat(rp.push(decodeDatagram(d).payload))
  check('the datagrams join into one record that parses', recs.length === 1 && parseRedirectReply(recs[0], { privatePem: pair.privatePem }).serverList.length === 60)
}

// ---- 3. P2P connect request
const reqFields = { cc: SERIAL, rip: { ip: 'cb007101', port: 40000 }, lanIps: ['192.168.1.20'], lp: 50000, p2v: OSSIA_VALUES.p2v, cty: 5 }
{
  const j = p2pConnectRequestJson(reqFields)
  check(
    'P2P request JSON has the keys in the vendor order',
    j === `{"ct":0,"cc":"${SERIAL}","rip":{"ip":"cb007101","port":40000},"p2pid":"","lanIps":["c0a80114"],"lp":50000,"p2v":"1.1.2","cty":5,"svid":"","cv":""}`,
    j
  )
  check('dtm goes after cc, op after p2pid', (() => {
    const k = Object.keys(JSON.parse(p2pConnectRequestJson({ ...reqFields, dtm: 3, op: 'qd' })))
    return k.join() === 'ct,cc,dtm,rip,p2pid,op,lanIps,lp,p2v,cty,svid,cv'
  })())
  check('a dotted rip is turned into hex', JSON.parse(p2pConnectRequestJson({ ...reqFields, rip: { ip: '203.0.113.1', port: 1 } })).rip.ip === 'cb007101')
  check('IPv6 LAN addresses stay text', JSON.parse(p2pConnectRequestJson({ ...reqFields, lanIps: ['fe80::1'] })).lanIps[0] === 'fe80::1')
  check('the Linux library differs only in p2v', p2pConnectRequestJson({ ...reqFields, p2v: LINUX_P2V }) === j.replace('1.1.2', '1.1.1'))
  for (const miss of ['cc', 'rip', 'lp', 'p2v', 'cty']) {
    const f = { ...reqFields }
    delete f[miss]
    check(`P2P request without ${miss} is refused`, threw(() => p2pConnectRequestJson(f)) !== null)
  }

  const packet = buildP2PConnectRequest({ ...reqFields, et: 2, sessionKey, keyId0: 11, keyId1: 22, cmdId: 5, time: 1700000002 })
  const env = decodeEnvelope(packet)
  check('request is encrypt type 2 with the key ids in the clear', env.encType === ENC.AES && env.keyId0 === 11 && env.keyId1 === 22)
  check('plain length is 16 + 8 + JSON', env.plainLen === 24 + j.length)
  check('size is 0x28 + floor16(plain length)', packet.length === 0x28 + (env.plainLen & ~15))
  const p = parseP2PConnectRequest(packet, { sessionKey })
  check('request opens with the session key', p.json.cc === SERIAL && p.cmdId === 5 && p.jsonText === j)
  check('request does not open without the key', threw(() => parseP2PConnectRequest(packet)) !== null)

  // 243 JSON characters is the length measured in the capture (plain length 267)
  const base = p2pConnectRequestJson({ ...reqFields, cv: '' }).length
  const sized = buildP2PConnectRequest({ ...reqFields, cv: 'v'.repeat(243 - base), et: 2, sessionKey, keyId0: 11, keyId1: 22, cmdId: 5, time: 1 })
  check('a 243-character JSON gives plain length 267 and 340 bytes on the wire', decodeEnvelope(sized).plainLen === 267 && serverDatagrams({ connectionId: connId, packet: sized })[0].length === 340)

  // "only 20 bytes differ between nodes": crc (4) + first AES block (16: version, type, id, time)
  const a = buildP2PConnectRequest({ ...reqFields, et: 2, sessionKey, keyId0: 11, keyId1: 22, cmdId: 5, time: 1 })
  const b = buildP2PConnectRequest({ ...reqFields, et: 2, sessionKey, keyId0: 11, keyId1: 22, cmdId: 6, time: 1 })
  let diff = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
  check('two requests that differ only in the command id differ in at most 20 bytes', diff > 0 && diff <= 20 && a.subarray(0x28).equals(b.subarray(0x28)), String(diff))
}

// ---- 4. P2P connect reply
const rid = Buffer.from('101112131415161718191a1b1c1d1e1f', 'hex')
const linkKey = Buffer.from('fedcba9876543210fedcba9876543210', 'latin1')
const syncToken = Buffer.alloc(144, 0x77)
const relayToken = Buffer.alloc(16, 0x66)
{
  const off = buildP2PConnectReply({ json: { ol: 0 }, sessionKey, keyId0: 11, keyId1: 22, cmdId: 5, time: 1 })
  check('"not online" is the 56-byte packet: 100 bytes on the wire ("10108")', off.length === 56 && decodeEnvelope(off).plainLen === 32)
  const o = parseP2PConnectReply(off, { sessionKey })
  check('"not online" parses: online false, nothing else', o.online === false && o.rid === null && o.syncToken === null && o.candidates.length === 0)

  const json = {
    ol: 1,
    dp2v: '1.1.2',
    msc: 40,
    dty: 1,
    dv: '1.0',
    ci: {
      rid: b64NoPad(rid),
      clt: {
        cln: ['ct', 'co', 'uo', 'cmt', 'cnmt', 'dst'],
        its: {
          ct: [2, 3, 1, 4],
          co: [1, 1, 1, 1],
          uo: [1, 2, 3, 4],
          cmt: [5, 5, 15, 15],
          cnmt: [0, 0, 0, 0],
          dst: [[{ pt: 6036, ip: ['c0a80164', 'c0a80264'] }], [{ pt: 44000, ip: 'c6336410' }], [{ pt: 44000, ip: 'c6336410' }], [{ pt: 8635, ip: 'c6336420' }]]
        }
      },
      chs: [{ ct: 1, ch: { hs: { ip: 'c6336430', pt: 7635 } } }]
    }
  }
  const on = buildP2PConnectReply({ json, syncToken, linkKey, relayToken, sessionKey, keyId0: 11, keyId1: 22, cmdId: 5, time: 1 })
  const r = parseP2PConnectReply(on, { sessionKey })
  check('online reply: rid is the 16-byte connection id', r.online && r.rid.equals(rid) && r.ridText.length === 22)
  check('online reply: sync token, link key and relay token come back', r.syncToken.equals(syncToken) && r.linkKey.equals(linkKey) && r.relayToken.equals(relayToken) && r.accessToken === null)
  check('online reply: device version fields', r.dp2v === '1.1.2' && r.msc === 40)
  check('four candidates, one per row of the column table', r.candidates.length === 4)
  check('lan candidate: every address of the ip array, one port', r.candidates[0].ct === CONNECT_TYPE.LAN && r.candidates[0].addresses.length === 2 && r.candidates[0].addresses[1].ip === '192.168.2.100' && r.candidates[0].addresses[0].port === 6036)
  check('relay candidate: use order 4, timeout 15', r.candidates[3].ct === CONNECT_TYPE.RELAY && r.candidates[3].uo === 4 && r.candidates[3].cmt === 15 && r.candidates[3].addresses[0].ip === '198.51.100.32')
  check('hints are kept as sent', r.hints.length === 1 && r.hints[0].ct === 1)
  check('reply does not open with a wrong key', threw(() => parseP2PConnectReply(on, { sessionKey: sessionKeyFromBytes(Buffer.alloc(16)) })) !== null)

  const noTok = buildP2PConnectReply({ json, linkKey, sessionKey, keyId0: 1, keyId1: 2, cmdId: 5, time: 1 })
  check('online without the sync token is refused', /0x36/.test(threw(() => parseP2PConnectReply(noTok, { sessionKey }))?.message ?? ''))
  const noLink = buildP2PConnectReply({ json, syncToken, sessionKey, keyId0: 1, keyId1: 2, cmdId: 5, time: 1 })
  check('online without the link key is refused', /0x24/.test(threw(() => parseP2PConnectReply(noLink, { sessionKey }))?.message ?? ''))
  const noRelay = buildP2PConnectReply({ json, syncToken, linkKey, sessionKey, keyId0: 1, keyId1: 2, cmdId: 5, time: 1 })
  check('online without a relay token is accepted (relayToken null)', parseP2PConnectReply(noRelay, { sessionKey }).relayToken === null)

  check('connectCandidates of nothing is empty', connectCandidates(undefined).length === 0 && connectCandidates({ its: {} }).length === 0)
  check('columns we do not know are kept', connectCandidates({ cln: ['ct', 'zz'], its: { ct: [4], zz: ['q'] } })[0].zz === 'q')
  check('min sync count: the reply value when the device is above 1.1.1, else 0', minSyncCount('1.1.2', 40) === 40 && minSyncCount('1.1.1', 40) === 0 && minSyncCount(null, 40) === 0)
}

// ---- 6. peer SYN
const OWN_ID = 'client-id-0123456789' // made up, 20 characters
{
  const s1 = buildSynStep1({ connectType: CONNECT_TYPE.UPNP, rid, syncToken })
  const h1 = decodeDatagram(s1)
  check('step 1: 36 + 4 + token bytes, category 1, command 0, the rid as connection id', s1.length === 184 && h1.category === 1 && h1.command === 0 && h1.connectType === 3 && h1.connectionId.equals(rid))
  check('step 1 body is the token unchanged', decodeSyn(h1).step === 1 && decodeSyn(h1).body.equals(syncToken))

  // the device's side of both exchanges, built here with the same primitives
  const ownNonce = Buffer.from('202122232425262728292a2b2c2d2e2f', 'hex')
  const tokenPlain = Buffer.alloc(128)
  Buffer.from(JSON.stringify({ cid: OWN_ID, rid: b64NoPad(rid), p3: 'opaque' })).copy(tokenPlain)
  const devStep1Body = aesEcbEncrypt(tokenPlain, sessionKey)
  check('test device token is 128 bytes, as captured', devStep1Body.length === 128)

  const s2 = answerSynStep1({ connectType: CONNECT_TYPE.UPNP, rid, body: devStep1Body, sessionKey, linkKey, ownClientId: OWN_ID, ownNonce, msc: 0 })
  const d2 = decodeSyn(decodeDatagram(s2))
  check('our step 2 answers with step number 2 and version 0x0102', d2.step === 2 && d2.version === 0x0102)
  const j2 = parseSynStep2Body(d2.body, linkKey)
  check('our step 2 carries cid, rid, our nonce as "cx", msc - in that order', Object.keys(j2).join() === 'cid,rid,cx,msc' && j2.cid === OWN_ID && j2.rid === b64NoPad(rid) && j2.cx === b64NoPad(ownNonce) && j2.msc === 0)
  check('our step 2 body is whole AES blocks', d2.body.length % 16 === 0)
  check('step 2 body: 78 + |cid| + |msc| characters + NUL, padded: 112 bytes (as captured) when |cid| + |msc| is 18..33', (() => {
    const body = buildSynStep2Body({ cid: 'c'.repeat(31), rid, nonce: ownNonce, msc: 40, linkKey })
    const body2 = buildSynStep2Body({ cid: 'c'.repeat(16), rid, nonce: ownNonce, msc: 40, linkKey })
    const empty = buildSynStep2Body({ cid: '', rid, nonce: ownNonce, msc: 0, linkKey })
    return body.length === 112 && body2.length === 112 && empty.length === 80
  })())
  check('a step 1 for another rid is refused', threw(() => answerSynStep1({ connectType: 3, rid: connId, body: devStep1Body, sessionKey, linkKey, ownClientId: OWN_ID, ownNonce, msc: 0 })) !== null)
  check('a step 1 for another client id is refused', threw(() => answerSynStep1({ connectType: 3, rid, body: devStep1Body, sessionKey, linkKey, ownClientId: 'someone-else', ownNonce, msc: 0 })) !== null)
  check('a step 1 under another key is refused', threw(() => answerSynStep1({ connectType: 3, rid, body: devStep1Body, sessionKey: sessionKeyFromBytes(Buffer.alloc(16)), linkKey, ownClientId: OWN_ID, ownNonce, msc: 0 })) !== null)

  // the device answers OUR step 1 with its step 2 ("dx"), we answer step 3
  const devNonce = 'DEVICENONCEDEVICENONCE' // 22 characters
  const devStep2Body = buildSynStep2Body({ cid: OWN_ID, rid, nonce: devNonce, msc: 40, linkKey, nonceField: 'dx' })
  const a2 = answerSynStep2({ connectType: CONNECT_TYPE.UPNP, rid, body: devStep2Body, linkKey, ownClientId: OWN_ID })
  const d3 = decodeSyn(decodeDatagram(a2.datagram))
  check('our step 3 echoes the device nonce as {"dx":..}', d3.step === 3 && parseSynStep3Body(d3.body, linkKey).dx === devNonce && a2.peerNonce === devNonce && a2.msc === 40)
  check('our step 3 body with a 22-character nonce is 32 bytes, as captured', d3.body.length === 32)
  check('a step 2 under another link key is refused', threw(() => answerSynStep2({ connectType: 3, rid, body: devStep2Body, linkKey: Buffer.alloc(32, 1), ownClientId: OWN_ID })) !== null)
  check('a step 2 for another rid is refused', threw(() => answerSynStep2({ connectType: 3, rid: connId, body: devStep2Body, linkKey, ownClientId: OWN_ID })) !== null)

  // the device answers our step 2 with its step 3 ({"cx": our nonce}), we answer step 4
  const devStep3Body = buildSynStep3Body({ nonce: b64NoPad(ownNonce), linkKey, nonceField: 'cx' })
  const s4 = answerSynStep3({ connectType: CONNECT_TYPE.UPNP, rid, body: devStep3Body, linkKey, ownNonce })
  check('our step 4 is 40 bytes with an empty body', s4.length === 40 && decodeSyn(decodeDatagram(s4)).step === 4)
  check('a step 3 that echoes another nonce is refused', threw(() => answerSynStep3({ connectType: 3, rid, body: buildSynStep3Body({ nonce: 'x', linkKey, nonceField: 'cx' }), linkKey, ownNonce })) !== null)
  check('link keys of 16 and 24 bytes work too', [16, 24].every((n) => parseSynStep3Body(buildSynStep3Body({ nonce: 'n', linkKey: Buffer.alloc(n, 3) }), Buffer.alloc(n, 3)).dx === 'n'))
  check('a body that is not whole blocks is refused', threw(() => parseSynStep2Body(Buffer.alloc(17), linkKey)) !== null)
}

// ---- relay
{
  const s = buildRelaySynStep1({ rid, relayToken, sessionKey, keyId0: 11, keyId1: 22, cmdId: 9, time: 1700000003 })
  const h = decodeDatagram(s)
  const syn = decodeSyn(h)
  check('relay step 1 goes on connect type 4', h.connectType === CONNECT_TYPE.RELAY && syn.step === 1)
  check('relay body starts with the encrypt type, no "1010"', syn.body.readUInt32LE(0) === ENC.AES)
  const env = decodeEnvelope(syn.body)
  check('relay body: plain length 16 + 8 + 40 + 8 + token', env.plainLen === 72 + relayToken.length && env.keyId0 === 11 && env.keyId1 === 22)
  check('relay body with a 16-byte token is 120 bytes, as captured', syn.body.length === 120)
  const p = parseRelaySyncBody(syn.body, { sessionKey })
  check('relay JSON is {"pt":1,"rsid":"<rid>"} and the token follows', JSON.stringify(p.json) === `{"pt":1,"rsid":"${b64NoPad(rid)}"}` && p.rid.equals(rid) && p.relayToken.equals(relayToken))
}

// ---- 7. peer command 0x203
{
  const json = '{"pts":[40001,40002,40003],"nip":"aa"}' // made up, 38 characters
  const packet = buildPeerCommand({ json, linkKey, cmdId: 3, time: 1700000004 })
  const env = decodeEnvelope(packet)
  check('peer command: encrypt type 2, key ids 0 / 0', env.encType === ENC.AES && env.keyId0 === 0 && env.keyId1 === 0)
  check('peer command: plain length 16 + 8 + JSON', env.plainLen === 24 + json.length)
  const p = parsePeerCommand(packet, { linkKey })
  check('peer command opens with the link key: cmd 0x203 and the JSON', p.cmdType === 0x203 && p.jsonText === json && p.json.pts.length === 3)
  const cap = buildPeerCommand({ json: 'j'.repeat(34), linkKey, cmdId: 3, time: 1 })
  check('a 34-character JSON gives plain length 58 and 88 bytes, as captured', decodeEnvelope(cap).plainLen === 58 && cap.length === 88)
  check('peer command does not open with the session key', threw(() => parsePeerCommand(packet, { linkKey: sessionKey })) !== null)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
