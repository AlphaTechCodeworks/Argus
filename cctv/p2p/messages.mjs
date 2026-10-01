// P2P 2.0 handshake messages: builders and parsers. Pure functions over buffers; nothing is sent.
//
// Every layout here is KNOWN from the vendor's code (protocol.md). What is NOT known is which
// VALUES the cloud and the device accept or send. Each such value is a named parameter, marked
// "UNKNOWN:" where it enters, so the live driver (stage 2) has one place per open question.
//
// Builders named build*Reply / build*Body for the far side exist so that tests and a local fake
// server can produce the other half of each exchange.
import { aesDecryptAlignedText, aesEcbDecrypt, aesEncryptAligned, openCommand, sealCommand, sessionKeyFromBytes } from './crypt.mjs'
import {
  CATEGORY,
  CMD,
  CMD_TYPE,
  CONNECT_TYPE,
  ENC,
  UDT_VERSION,
  cutPayloads,
  decodeCommand,
  decodeSyn,
  encodeCommand,
  encodeDatagram,
  encodeRecords,
  encodeSyn,
  findItem
} from './wire.mjs'

// Item ids
export const ITEM = Object.freeze({
  REDIRECT_REQ_JSON: 0x01,
  REDIRECT_REQ_PUBKEY: 0x03,
  REDIRECT_REPLY_JSON: 0x04,
  REDIRECT_REPLY_KEY: 0x05,
  RELAY_SYNC_JSON: 0x22,
  RELAY_TOKEN: 0x23,
  LINK_KEY: 0x24,
  PEER_CONN_HELP_JSON: 0x25,
  P2P_REQ_JSON: 0x33,
  P2P_REPLY_JSON: 0x34,
  ACCESS_TOKEN: 0x35,
  SYNC_TOKEN: 0x36
})

/**
 * Values the Windows client (Ossia) sends. `cty` 5 and the empty cid / isp / svid were read from
 * the owner's capture (the redirect request is only XOR-ed). `p2v` is the Windows library's version
 * string. UNKNOWN: Ossia's `cv` and `p2pid` (inside AES; they need one live exchange of our own).
 */
export const OSSIA_VALUES = Object.freeze({ cid: '', isp: '', svid: '', cty: 5, p2v: '1.1.2' })
/** The version string of the vendor's Linux library. The only wire difference to Windows on the connect path. */
export const LINUX_P2V = '1.1.1'

// ------------------------------------------------------------------------------- small helpers
/** IPv4 text -> 8 lowercase hex characters, bytes in network order ("%02x" per byte). */
export function ipv4ToHex(ip) {
  const p = String(ip).split('.')
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || +x > 255)) throw new Error(`not an IPv4 address: ${ip}`)
  return p.map((x) => (+x).toString(16).padStart(2, '0')).join('')
}

/** 8 hex characters -> IPv4 text. Anything else (IPv6 text) is returned unchanged. */
export function hexToIp(s) {
  if (typeof s !== 'string' || !/^[0-9a-fA-F]{8}$/.test(s)) return s
  return [0, 2, 4, 6].map((i) => parseInt(s.slice(i, i + 2), 16)).join('.')
}

/** base64 without '=' padding, as CBase64OpenSSL::Encode(..., false): 16 bytes give 22 characters. */
export function b64NoPad(buf) {
  return buf.toString('base64').replace(/=+$/, '')
}

export function b64Decode(text) {
  return Buffer.from(String(text), 'base64')
}

/** Process-wide command id counter: starts at 1, and 0xffffffff is followed by 1 (g_cmdIdGenerator). */
export function createCmdIds(start = 0) {
  let last = start >>> 0
  return () => (last = last === 0xffffffff ? 1 : last + 1)
}

const jsonOf = (items, id, what) => {
  const it = findItem(items, id)
  if (!it) throw new Error(`${what}: item 0x${id.toString(16)} not found`)
  const z = it.data.indexOf(0)
  const text = it.data.toString('utf8', 0, z < 0 ? it.data.length : z)
  try {
    return { text, json: JSON.parse(text) }
  } catch {
    throw new Error(`${what}: item 0x${id.toString(16)} is not JSON`)
  }
}
const bufOf = (items, id) => {
  const it = findItem(items, id)
  return it ? Buffer.from(it.data) : null
}

// ------------------------------------------------------ datagrams around a server command
/**
 * Wrap one command packet for a cloud server: "1010" record(s), cut into DATA datagrams.
 * Server links are "connectionless": no SYN, category 2, connect type 0, a fresh random 16-byte
 * connection id per request, data index from 2. The first datagram carries the words 1 / 0 / 2 / 1.
 * A resend must use a higher sendCounter and the same dataIndex (reliable.mjs does that).
 */
export function serverDatagrams({ connectionId, packet, firstSendCounter = 1, peerCounter = 0, firstDataIndex = 2, ackIndex = 1 }) {
  return cutPayloads(encodeRecords(packet)).map((payload, i) =>
    encodeDatagram(
      {
        category: CATEGORY.SERVER,
        command: CMD.DATA,
        connectType: CONNECT_TYPE.SERVER,
        connectionId,
        sendCounter: firstSendCounter + i,
        peerCounter,
        dataIndex: firstDataIndex + i,
        ackIndex
      },
      payload
    )
  )
}

// ------------------------------------------------------------------------- 1. redirect request
/**
 * The JSON of item 0x01, keys in the vendor's order.
 *   cid, isp, svid  UNKNOWN whether the cloud looks at them. Ossia sends all three empty.
 *   cty             UNKNOWN what the cloud does with it ("client type"). Ossia sends 5; what the
 *                   vendor's Linux libdvrnetsdk sends is not known. No default: the caller chooses.
 *   isFull          true asks for the full NAT server list (the retry after "not online").
 *   "et":1          asks for an RSA-encrypted reply.
 */
export function redirectRequestJson({ cid = '', isp = '', svid = '', cty, isFull = false }) {
  if (!Number.isInteger(cty)) throw new Error('cty must be given (Ossia sends 5)')
  return JSON.stringify({ rt: 'p2p', cid, isp, svid, cty, ...(isFull ? { isfull: 1 } : {}), et: 1 })
}

/**
 * Redirect request command packet (cmd 0x2): encrypt type 3 (XOR, the 4-byte key travels in the
 * packet), item 0x01 = JSON, item 0x03 = the client's RSA public key as PKCS#1 PEM.
 * With empty cid/isp/svid and a one-digit cty this is 350 bytes: 394 on the wire, 405 with isFull.
 */
export function buildRedirectRequest({ cid, isp, svid, cty, isFull, publicPem, cmdId, time, xorKey }) {
  const plain = encodeCommand({
    cmdType: CMD_TYPE.REDIRECT,
    cmdId,
    time,
    items: [
      { id: ITEM.REDIRECT_REQ_JSON, data: redirectRequestJson({ cid, isp, svid, cty, isFull }) },
      { id: ITEM.REDIRECT_REQ_PUBKEY, data: Buffer.from(publicPem, 'latin1') }
    ]
  })
  return sealCommand(plain, { encType: ENC.XOR, xorKey })
}

export function parseRedirectRequest(packet) {
  const env = openCommand(packet)
  const cmd = decodeCommand(env.plain)
  if (cmd.cmdType !== CMD_TYPE.REDIRECT) throw new Error(`redirect request: command type 0x${cmd.cmdType.toString(16)}`)
  const { text, json } = jsonOf(cmd.items, ITEM.REDIRECT_REQ_JSON, 'redirect request')
  const pem = bufOf(cmd.items, ITEM.REDIRECT_REQ_PUBKEY)
  return { encType: env.encType, xorKey: env.xorKey ? Buffer.from(env.xorKey) : null, cmdId: cmd.cmdId, time: cmd.time, jsonText: text, json, publicPem: pem ? pem.toString('latin1') : null }
}

// --------------------------------------------------------------------------- 2. redirect reply
/**
 * Redirect reply: encrypt type 1 (RSA to our public key). Item 0x04 = JSON, item 0x05 = 24 bytes
 * {u32 keyId0, u32 keyId1, u8 keyBytes[16]}.
 * Returns the server list sorted by `order` (lowest first, as ChangeNatServer takes them), our
 * public address as the server saw it, `et` (the encrypt type for every later request; the client
 * supports 0..3) and the session key (the 16 key bytes as 32 lowercase hex characters).
 * UNKNOWN until our own first exchange: the real JSON values (only the key names and types are
 * known), and whether `et` is always 2.
 */
export function parseRedirectReply(packet, { privatePem }) {
  const env = openCommand(packet, { privatePem })
  const cmd = decodeCommand(env.plain)
  if (cmd.cmdType !== CMD_TYPE.REDIRECT) throw new Error(`redirect reply: command type 0x${cmd.cmdType.toString(16)}`)
  const { json } = jsonOf(cmd.items, ITEM.REDIRECT_REPLY_JSON, 'redirect reply')
  const rec = findItem(cmd.items, ITEM.REDIRECT_REPLY_KEY)
  if (!rec || rec.data.length < 24) throw new Error('redirect reply: item 0x5 (key record) not found')
  if (!Number.isInteger(json.et)) throw new Error('redirect reply: no encrypt type')
  if (json.et < 0 || json.et > 3) throw new Error(`not support encrypt type:${json.et}`)
  const keyBytes = Buffer.from(rec.data.subarray(8, 24))
  const serverList = (Array.isArray(json.serverList) ? json.serverList : [])
    .map((s) => ({ ip: hexToIp(s.ip), port: s.port, order: s.order, cTimeout: s.cTimeout }))
    .sort((a, b) => a.order - b.order)
  return {
    encType: env.encType,
    cmdId: cmd.cmdId,
    time: cmd.time,
    json,
    lc: json.lc ?? null, // locality code, optional
    ac: json.ac ?? null, // area code: only the Windows client reads it, and only logs it
    serverList,
    pubIp: json.pubIp ? { ip: hexToIp(json.pubIp.ip), ipHex: json.pubIp.ip, port: json.pubIp.port } : null,
    et: json.et,
    keyId0: rec.data.readUInt32LE(0),
    keyId1: rec.data.readUInt32LE(4),
    keyBytes,
    sessionKey: sessionKeyFromBytes(keyBytes)
  }
}

/** The far side of step 2, for tests and a local fake server. */
export function buildRedirectReply({ json, keyId0, keyId1, keyBytes, publicPem, cmdId, time }) {
  const rec = Buffer.alloc(24)
  rec.writeUInt32LE(keyId0 >>> 0, 0)
  rec.writeUInt32LE(keyId1 >>> 0, 4)
  keyBytes.copy(rec, 8)
  const plain = encodeCommand({
    cmdType: CMD_TYPE.REDIRECT,
    cmdId,
    time,
    items: [
      { id: ITEM.REDIRECT_REPLY_JSON, data: typeof json === 'string' ? json : JSON.stringify(json) },
      { id: ITEM.REDIRECT_REPLY_KEY, data: rec, count: 1, itemLen: 24 }
    ]
  })
  return sealCommand(plain, { encType: ENC.RSA, publicPem })
}

// --------------------------------------------------------------------- 3. P2P connect request
/**
 * The JSON of item 0x33, keys in the vendor's order.
 *   ct        0 = connect by serial number (KNOWN). 1 = by a dotted "a.b.c" code whose third part
 *             goes out as `dtm`; not used here.
 *   cc        the serial.
 *   rip       our public address from the redirect reply: ip as the hex string received, port.
 *   p2pid     UNKNOWN: the client's P2P id (cfg.clientP2PId). What Ossia sends is inside AES.
 *             It is also the `cid` the device must echo in SYN step 2, so it may have to be non-empty.
 *   op        "qd" only for a query without connecting.
 *   lanIps    our LAN addresses: IPv4 as 8 hex characters, IPv6 as text. UNKNOWN: whether the
 *             cloud needs them (they let the device try the LAN path).
 *   lp        our local UDP port.
 *   p2v       "1.1.2" (Windows) or "1.1.1" (Linux). UNKNOWN whether the cloud treats 1.1.1 differently.
 *   cty       UNKNOWN, as in the redirect request. Ossia: 5.
 *   svid, cv  UNKNOWN: what Ossia sends (cfg.svid, cfg.cv: client version text).
 */
export function p2pConnectRequestJson({ ct = 0, cc, dtm, rip, p2pid = '', op, lanIps = [], lp, p2v, cty, svid = '', cv = '' }) {
  if (typeof cc !== 'string' || !cc) throw new Error('cc (the serial) must be given')
  if (!rip || typeof rip.ip !== 'string' || !Number.isInteger(rip.port)) throw new Error('rip {ip, port} must be given')
  if (!Number.isInteger(lp)) throw new Error('lp (local UDP port) must be given')
  if (typeof p2v !== 'string') throw new Error('p2v must be given ("1.1.2" as Windows, "1.1.1" as Linux)')
  if (!Number.isInteger(cty)) throw new Error('cty must be given (Ossia sends 5)')
  return JSON.stringify({
    ct,
    cc,
    ...(dtm === undefined ? {} : { dtm }),
    rip: { ip: /^[0-9a-f]{8}$/.test(rip.ip) || rip.ip.includes(':') ? rip.ip : ipv4ToHex(rip.ip), port: rip.port },
    p2pid,
    ...(op === undefined ? {} : { op }),
    lanIps: lanIps.map((a) => (a.includes(':') || /^[0-9a-f]{8}$/.test(a) ? a : ipv4ToHex(a))),
    lp,
    p2v,
    cty,
    svid,
    cv
  })
}

/**
 * P2P connect request command packet (cmd 0x303), sent to every NAT server of the current order.
 * `et` is the encrypt type the redirect reply gave (2 = AES with the session key and its key ids).
 * With AES: 36 + 8 + 0x28 + floor16(24 + JSON length) bytes on the wire; 340 when the JSON is
 * 232..247 characters.
 */
export function buildP2PConnectRequest({ et = ENC.AES, sessionKey, keyId0, keyId1, cmdId, time, xorKey, padFill, ...fields }) {
  const plain = encodeCommand({ cmdType: CMD_TYPE.P2P_CONNECT, cmdId, time, items: [{ id: ITEM.P2P_REQ_JSON, data: p2pConnectRequestJson(fields) }] })
  return sealCommand(plain, { encType: et, key: sessionKey, keyId0, keyId1, xorKey, padFill })
}

export function parseP2PConnectRequest(packet, { sessionKey } = {}) {
  const env = openCommand(packet, { aesKey: sessionKey })
  const cmd = decodeCommand(env.plain)
  if (cmd.cmdType !== CMD_TYPE.P2P_CONNECT) throw new Error(`P2P request: command type 0x${cmd.cmdType.toString(16)}`)
  const { text, json } = jsonOf(cmd.items, ITEM.P2P_REQ_JSON, 'P2P request')
  return { encType: env.encType, keyId0: env.keyId0, keyId1: env.keyId1, plainLen: env.plainLen ?? env.plain.length, cmdId: cmd.cmdId, time: cmd.time, jsonText: text, json }
}

// ----------------------------------------------------------------------- 4. P2P connect reply
/**
 * Turn the column table `ci.clt` into one object per connect candidate.
 * `cln` lists the column names, `its` holds one array per column; row i is one candidate:
 *   ct connect type (1 p2p, 2 lan, 3 upnp, 4 relay), co connect order, uo use order (lowest that is
 *   connected carries the data), cmt connect timeout in seconds, cnmt, dst = [{pt, ip}] where ip is
 *   one hex string or an array of them.
 * UNKNOWN: the real values and which combinations the cloud sends; columns we do not know are kept.
 */
export function connectCandidates(clt) {
  const its = clt?.its
  if (!its || typeof its !== 'object') return []
  const cols = Array.isArray(clt.cln) && clt.cln.length ? clt.cln : Object.keys(its)
  const rows = Array.isArray(its.ct) ? its.ct.length : 0
  const out = []
  for (let i = 0; i < rows; i++) {
    const row = {}
    for (const c of cols) row[c] = Array.isArray(its[c]) ? its[c][i] : undefined
    row.addresses = []
    for (const d of Array.isArray(row.dst) ? row.dst : []) {
      for (const ip of Array.isArray(d.ip) ? d.ip : [d.ip]) if (ip !== undefined) row.addresses.push({ ip: hexToIp(ip), port: d.pt })
    }
    out.push(row)
  }
  return out
}

/**
 * P2P connect reply (cmd 0x303, same encrypt type as the request).
 *   item 0x34  JSON: ol (1 = the device is online at this node), dp2v, msc, dty, dv, ci {rid, clt, chs}
 *   item 0x36  sync token: opaque to us, sent unchanged as the body of SYN step 1
 *   item 0x24  link key shared with the device: AES-ECB key for SYN steps 2-3 and for cmd 0x203.
 *              UNKNOWN length (16, 24 or 32; all three work here)
 *   item 0x23  relay token (UNKNOWN whether always present)
 *   item 0x35  access token part, only for ct = 1
 * A node that does not have the device answers {"ol":0} and nothing else.
 */
export function parseP2PConnectReply(packet, { sessionKey } = {}) {
  const env = openCommand(packet, { aesKey: sessionKey })
  const cmd = decodeCommand(env.plain)
  if (cmd.cmdType !== CMD_TYPE.P2P_CONNECT) throw new Error(`P2P reply: command type 0x${cmd.cmdType.toString(16)}`)
  const { json } = jsonOf(cmd.items, ITEM.P2P_REPLY_JSON, 'P2P reply')
  const online = json.ol === 1
  const ci = json.ci ?? null
  const rid = ci?.rid ? b64Decode(ci.rid) : null
  const out = {
    encType: env.encType,
    cmdId: cmd.cmdId,
    time: cmd.time,
    json,
    online,
    dp2v: json.dp2v ?? null, // device P2P version
    msc: json.msc ?? null, // min sync count
    dty: json.dty ?? null,
    dv: json.dv ?? null,
    ridText: ci?.rid ?? null,
    rid, // the 16-byte connection id of the device link
    candidates: connectCandidates(ci?.clt),
    hints: Array.isArray(ci?.chs) ? ci.chs : [], // per connect type: help servers, collider settings
    syncToken: bufOf(cmd.items, ITEM.SYNC_TOKEN),
    linkKey: bufOf(cmd.items, ITEM.LINK_KEY),
    relayToken: bufOf(cmd.items, ITEM.RELAY_TOKEN),
    accessToken: bufOf(cmd.items, ITEM.ACCESS_TOKEN)
  }
  if (online) {
    // CTNATClientPeer::ProP2PConnectReply fails without these
    if (!rid || rid.length !== 16) throw new Error('P2P reply: online but no 16-byte rid')
    if (!out.syncToken) throw new Error('P2P reply: online but item 0x36 (sync token) not found')
    if (!out.linkKey) throw new Error('P2P reply: online but item 0x24 (link key) not found')
  }
  return out
}

/** The far side of step 4, for tests and a local fake server. `serverStyle` AES: no extra block. */
export function buildP2PConnectReply({ json, syncToken, linkKey, relayToken, accessToken, et = ENC.AES, sessionKey, keyId0, keyId1, cmdId, time }) {
  const items = [{ id: ITEM.P2P_REPLY_JSON, data: typeof json === 'string' ? json : JSON.stringify(json) }]
  if (syncToken) items.push({ id: ITEM.SYNC_TOKEN, data: syncToken })
  if (linkKey) items.push({ id: ITEM.LINK_KEY, data: linkKey })
  if (relayToken) items.push({ id: ITEM.RELAY_TOKEN, data: relayToken })
  if (accessToken) items.push({ id: ITEM.ACCESS_TOKEN, data: accessToken })
  const plain = encodeCommand({ cmdType: CMD_TYPE.P2P_CONNECT, cmdId, time, items })
  return sealCommand(plain, { encType: et, key: sessionKey, keyId0, keyId1, serverStyle: true })
}

/**
 * Min sync count the client puts in SYN step 2 and waits for before it calls the path connected:
 * the reply's `msc` when the device P2P version is above "1.1.1" (string compare), otherwise 0.
 * UNKNOWN: the value of `msc` in practice (a vendor log shows 40).
 */
export function minSyncCount(dp2v, msc) {
  return typeof dp2v === 'string' && dp2v > '1.1.1' && Number.isInteger(msc) ? msc : 0
}

// ---------------------------------------------------------------- 6. peer SYN steps 1 to 4
// Packet: 36-byte header {category 1, command 0, 1, connect type, rid, four zero words},
// u16 step, u16 0x0102, body. One exchange per candidate path, all on the same rid.
// Each side starts its own exchange with step 1 and answers the other's; a side is connected
// when it has received step 4 (at least `msc` times).

/** Step 1 from us: the body is the sync token of the P2P reply (item 0x36), unchanged. */
export function buildSynStep1({ connectType, rid, syncToken }) {
  return encodeSyn({ connectType, connectionId: rid, step: 1, body: syncToken })
}

/**
 * Read the body of a step 1 we received (the device's token). KNOWN: plain AES-ECB, JSON
 * {"cid":..,"rid":..,"p3":..}; the client decrypts it with its own server session key.
 * UNKNOWN: the content of `p3`.
 */
export function parseSynStep1Body(body, sessionKey) {
  if (!body.length || body.length % 16) throw new Error('SYN step 1 body is not whole AES blocks')
  const plain = aesEcbDecrypt(body, sessionKey)
  const z = plain.indexOf(0)
  let json
  try {
    json = JSON.parse(plain.toString('utf8', 0, z < 0 ? plain.length : z))
  } catch {
    throw new Error('parse client p2p code failed')
  }
  return json
}

/**
 * Step 2 body: {"cid":..,"rid":..,"cx":..,"msc":n} + NUL, zero-padded to 16, AES-ECB with the link key.
 * The client sends its nonce as "cx" (base64 of a fresh 16-byte GUID, no padding); the device sends "dx".
 *   cid, rid  copied as text from the step 1 that is being answered.
 */
export function buildSynStep2Body({ cid, rid, nonce, msc, linkKey, nonceField = 'cx' }) {
  const text = JSON.stringify({ cid, rid: Buffer.isBuffer(rid) ? b64NoPad(rid) : rid, [nonceField]: Buffer.isBuffer(nonce) ? b64NoPad(nonce) : nonce, msc })
  return aesEncryptAligned(Buffer.from(`${text}\0`, 'utf8'), linkKey)
}

const alignedJson = (body, linkKey, what) => {
  if (!body.length || body.length % 16) throw new Error(`${what} body is not whole AES blocks`)
  try {
    return JSON.parse(aesDecryptAlignedText(body, linkKey))
  } catch {
    throw new Error(`${what}: not JSON under this link key`)
  }
}

export function parseSynStep2Body(body, linkKey) {
  return alignedJson(body, linkKey, 'SYN step 2')
}

/** Step 3 body: {"dx":"<the nonce the device sent in its step 2>"} + NUL, padded, link key. The device sends {"cx":..}. */
export function buildSynStep3Body({ nonce, linkKey, nonceField = 'dx' }) {
  return aesEncryptAligned(Buffer.from(`${JSON.stringify({ [nonceField]: nonce })}\0`, 'utf8'), linkKey)
}

export function parseSynStep3Body(body, linkKey) {
  return alignedJson(body, linkKey, 'SYN step 3')
}

/**
 * We received the device's step 1: check it and build our step 2 (GenerateSyncAckData).
 * Checks: rid = the connection id, cid = our own client id (cfg.clientP2PId, the `p2pid` we sent).
 * Returns the step 2 datagram. Throws when a check fails; the vendor then sends a connector RST.
 *   ownNonce  16 bytes, made once per connection and reused in every step 2 we send.
 */
export function answerSynStep1({ connectType, rid, body, sessionKey, linkKey, ownClientId, ownNonce, msc }) {
  const j = parseSynStep1Body(body, sessionKey)
  if (typeof j.rid !== 'string' || !b64Decode(j.rid).equals(rid) || j.cid !== ownClientId) throw new Error('peer p2p code is invalid')
  return encodeSyn({ connectType, connectionId: rid, step: 2, body: buildSynStep2Body({ cid: j.cid, rid: j.rid, nonce: ownNonce, msc, linkKey }) })
}

/**
 * We received the device's step 2 (the answer to our step 1): check it and build our step 3.
 * Returns { datagram, peerNonce, msc }. UNKNOWN: the format of the device's `dx` (we only echo it).
 */
export function answerSynStep2({ connectType, rid, body, linkKey, ownClientId }) {
  const j = parseSynStep2Body(body, linkKey)
  if (typeof j.rid !== 'string' || !b64Decode(j.rid).equals(rid) || j.cid !== ownClientId) throw new Error('CheckSyncDataValid failed')
  if (typeof j.dx !== 'string') throw new Error('CheckSyncDataValid failed: no dx')
  return { datagram: encodeSyn({ connectType, connectionId: rid, step: 3, body: buildSynStep3Body({ nonce: j.dx, linkKey }) }), peerNonce: j.dx, msc: j.msc ?? 0 }
}

/** We received the device's step 3: it must echo our nonce as "cx". Returns our step 4 (empty body). */
export function answerSynStep3({ connectType, rid, body, linkKey, ownNonce }) {
  const j = parseSynStep3Body(body, linkKey)
  if (j.cx !== (Buffer.isBuffer(ownNonce) ? b64NoPad(ownNonce) : ownNonce)) throw new Error('check cx code failed')
  return encodeSyn({ connectType, connectionId: rid, step: 4 })
}

export { decodeSyn, UDT_VERSION }

// ------------------------------------------------------------------------- relay (ct 4)
/**
 * Relay SYN step 1 body: a command packet with no "1010" in front. Encrypt type 2 with the server
 * session key and its key ids, cmd 0x202, item 0x22 = {"pt":1,"rsid":"<base64 rid, no padding>"},
 * item 0x23 = the relay token of the P2P reply. The relay answers step 2 (body not checked); that
 * is "connected", and it then forwards DATA / ACK both ways.
 * UNKNOWN: the meaning of "pt":1 (the code writes the constant 1).
 */
export function buildRelaySyncBody({ rid, relayToken, sessionKey, keyId0, keyId1, cmdId, time, padFill }) {
  const plain = encodeCommand({
    cmdType: CMD_TYPE.RELAY_SYNC,
    cmdId,
    time,
    items: [
      { id: ITEM.RELAY_SYNC_JSON, data: JSON.stringify({ pt: 1, rsid: b64NoPad(rid) }) },
      { id: ITEM.RELAY_TOKEN, data: relayToken }
    ]
  })
  return sealCommand(plain, { encType: ENC.AES, key: sessionKey, keyId0, keyId1, padFill })
}

export function buildRelaySynStep1(opts) {
  return encodeSyn({ connectType: CONNECT_TYPE.RELAY, connectionId: opts.rid, step: 1, body: buildRelaySyncBody(opts) })
}

export function parseRelaySyncBody(body, { sessionKey }) {
  const env = openCommand(body, { aesKey: sessionKey })
  const cmd = decodeCommand(env.plain)
  if (cmd.cmdType !== CMD_TYPE.RELAY_SYNC) throw new Error(`relay sync: command type 0x${cmd.cmdType.toString(16)}`)
  const { json } = jsonOf(cmd.items, ITEM.RELAY_SYNC_JSON, 'relay sync')
  return { keyId0: env.keyId0, keyId1: env.keyId1, plainLen: env.plainLen, cmdId: cmd.cmdId, time: cmd.time, json, rid: b64Decode(json.rsid), relayToken: bufOf(cmd.items, ITEM.RELAY_TOKEN) }
}

// ------------------------------------------------------------- 7. peer command 0x203 ("01 11")
/**
 * Peer conn-help notify: a command packet sent as a DATA datagram of data type 1 (it takes one
 * data index but is not part of the byte stream; reliable.mjs: sendPeerCommand). Encrypt type 2,
 * key ids 0 / 0, key = the link key; cmd 0x203; item 0x25 = JSON.
 *   json  UNKNOWN: the exact text. The code builds a NAT type notice {"nt":..,"nnt":..} or a public
 *         port list {"pts":[..],"nip":..}; the captured one is 34 characters. Also UNKNOWN whether
 *         the device needs one from us at all (in the capture it sent `head` before ours left).
 */
export function buildPeerCommand({ json, linkKey, cmdId, time, padFill }) {
  const plain = encodeCommand({ cmdType: CMD_TYPE.PEER_CONN_HELP, cmdId, time, items: [{ id: ITEM.PEER_CONN_HELP_JSON, data: typeof json === 'string' ? json : JSON.stringify(json) }] })
  return sealCommand(plain, { encType: ENC.AES, key: linkKey, keyId0: 0, keyId1: 0, padFill })
}

export function parsePeerCommand(packet, { linkKey }) {
  const env = openCommand(packet, { aesKey: linkKey })
  const cmd = decodeCommand(env.plain)
  const it = findItem(cmd.items, ITEM.PEER_CONN_HELP_JSON)
  let json = null
  let jsonText = null
  if (it) {
    jsonText = it.data.toString('utf8')
    try {
      json = JSON.parse(jsonText)
    } catch {
      json = null
    }
  }
  return { cmdType: cmd.cmdType, cmdId: cmd.cmdId, time: cmd.time, plainLen: env.plainLen, jsonText, json }
}
