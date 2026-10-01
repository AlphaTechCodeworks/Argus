// P2P 2.0 ("NAT2") wire layouts: the 36-byte datagram header, the connector SYN, the "1010" stream
// record, the command packet envelope, the command header and its items, CRC-32.
// Pure encode/decode: no sockets, no crypto (crypt.mjs), no timers. All integers little-endian.
// Field names and layouts follow the vendor's code as read in protocol.md (libNatClientSDK 1.1.1).

export const HEADER_LEN = 36
export const MAX_PAYLOAD = 1236 // 0x4d4
export const MAX_DATAGRAM = HEADER_LEN + MAX_PAYLOAD // 1272
export const MAX_ACK_LIST = 309 // 0x135 data indexes fit one ACK
export const UDT_VERSION = 0x0102 // TNAT_UDT_VERSION, the same in the Linux 1.1.1 and Windows 1.1.2 builds

// Byte 0
export const CATEGORY = Object.freeze({ PEER: 1, SERVER: 2 })
// Byte 1, low nibble
export const CMD = Object.freeze({ SYN: 0, DATA: 1, ACK: 2, RST: 3 })
// Byte 1, high nibble, on DATA only
export const DATA_TYPE = Object.freeze({ STREAM: 0, PEER_CMD: 1 })
// Byte 3: the kind of path this datagram travels on
export const CONNECT_TYPE = Object.freeze({ SERVER: 0, P2P: 1, LAN: 2, UPNP: 3, RELAY: 4 })
// First word of a command packet
export const ENC = Object.freeze({ NONE: 0, RSA: 1, AES: 2, XOR: 3 })
// Command types the client uses
export const CMD_TYPE = Object.freeze({ REDIRECT: 0x2, RELAY_SYNC: 0x202, PEER_CONN_HELP: 0x203, CONN_HELP_QUERY: 0x204, P2P_CONNECT: 0x303 })
export const CMD_VERSION = 4
export const ITEM_VERSION = 4

// ---------------------------------------------------------------------------------------- CRC-32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** Standard CRC-32 (poly 0xEDB88320, init and final xor 0xFFFFFFFF), as CCRC::CRC32. */
export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ------------------------------------------------------------------------------- 36-byte header
/**
 * Encode one datagram: 36-byte header + payload.
 *   category      byte 0     1 device peer, 2 cloud server
 *   command       byte 1 lo  0 SYN, 1 DATA, 2 ACK, 3 RST
 *   dataType      byte 1 hi  on DATA: 0 user stream, 1 peer command
 *   flags         byte 2     always 1
 *   connectType   byte 3     0 server, 1 p2p, 2 lan, 3 upnp, 4 relay
 *   connectionId  4..19      16 bytes
 *   sendCounter   0x14       transmit counter of this packet (a resend gets a new one)
 *   peerCounter   0x18       highest transmit counter received from the other side
 *   dataIndex     0x1c       DATA: index of this packet (first is 2)
 *   ackIndex      0x20       highest in-order data index received (next expected - 1)
 */
export function encodeDatagram(h, payload = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(h.connectionId) || h.connectionId.length !== 16) throw new Error('connectionId must be 16 bytes')
  if (payload.length > MAX_PAYLOAD) throw new Error(`payload ${payload.length} > ${MAX_PAYLOAD}`)
  const b = Buffer.alloc(HEADER_LEN + payload.length)
  b[0] = h.category
  b[1] = ((h.dataType ?? 0) << 4) | (h.command & 15)
  b[2] = h.flags ?? 1
  b[3] = h.connectType ?? 0
  h.connectionId.copy(b, 4)
  b.writeUInt32LE((h.sendCounter ?? 0) >>> 0, 0x14)
  b.writeUInt32LE((h.peerCounter ?? 0) >>> 0, 0x18)
  b.writeUInt32LE((h.dataIndex ?? 0) >>> 0, 0x1c)
  b.writeUInt32LE((h.ackIndex ?? 0) >>> 0, 0x20)
  payload.copy(b, HEADER_LEN)
  return b
}

/** Decode one datagram. `payload` is a view into `buf`, not a copy. */
export function decodeDatagram(buf) {
  if (buf.length < HEADER_LEN) throw new Error(`datagram of ${buf.length} bytes is shorter than the header`)
  return {
    category: buf[0],
    command: buf[1] & 15,
    dataType: buf[1] >> 4,
    flags: buf[2],
    connectType: buf[3],
    connectionId: buf.subarray(4, 20),
    sendCounter: buf.readUInt32LE(0x14),
    peerCounter: buf.readUInt32LE(0x18),
    dataIndex: buf.readUInt32LE(0x1c),
    ackIndex: buf.readUInt32LE(0x20),
    payload: buf.subarray(HEADER_LEN)
  }
}

/** True when the bytes can be a P2P 2.0 datagram at all (used to sort captured UDP). */
export function looksLikeDatagram(buf) {
  return buf.length >= HEADER_LEN && (buf[0] === CATEGORY.PEER || buf[0] === CATEGORY.SERVER) && (buf[1] & 15) <= CMD.RST && (buf[1] >> 4) <= 1 && buf[2] === 1 && buf[3] <= 4
}

/** Payload of an ACK: data indexes received out of order (selective ack), at most 309. */
export function encodeAckList(indexes) {
  const n = Math.min(indexes.length, MAX_ACK_LIST)
  const b = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) b.writeUInt32LE(indexes[i] >>> 0, i * 4)
  return b
}

export function decodeAckList(payload) {
  const out = []
  for (let o = 0; o + 4 <= payload.length; o += 4) out.push(payload.readUInt32LE(o))
  return out
}

// ------------------------------------------------------------------------------- connector SYN
/**
 * Connector SYN (category 1, command 0): header with four zero words, then u16 step (1..4),
 * u16 version (0x0102), then the body. Step 4 has no body (40 bytes in all).
 */
export function encodeSyn({ connectType, connectionId, step, version = UDT_VERSION, body = Buffer.alloc(0) }) {
  const p = Buffer.alloc(4 + body.length)
  p.writeUInt16LE(step, 0)
  p.writeUInt16LE(version, 2)
  body.copy(p, 4)
  return encodeDatagram({ category: CATEGORY.PEER, command: CMD.SYN, connectType, connectionId }, p)
}

/** Takes a decoded datagram. */
export function decodeSyn(h) {
  if (h.command !== CMD.SYN) throw new Error('not a SYN')
  if (h.payload.length < 4) throw new Error('SYN without step/version')
  return { step: h.payload.readUInt16LE(0), version: h.payload.readUInt16LE(2), body: h.payload.subarray(4) }
}

/**
 * Connector RST (CTNATUdtConnector::DisConnect): 40 bytes, command 3, four zero words, then the same
 * two u16 as a SYN. The vendor leaves the first u16 unset (stack bytes); we send 0.
 */
export function encodeConnectorRst({ connectType, connectionId, version = UDT_VERSION }) {
  const p = Buffer.alloc(4)
  p.writeUInt16LE(version, 2)
  return encodeDatagram({ category: CATEGORY.PEER, command: CMD.RST, connectType, connectionId }, p)
}

// ------------------------------------------------------------------------------------- items
/**
 * One item: u8 id, u8 ver (4), u16 count, u32 itemLen, then count * itemLen bytes.
 * Strings and buffers use count 1 (PackStr / PackBufData); a string is stored without its NUL.
 */
export function encodeItem({ id, data, count = 1, itemLen, ver = ITEM_VERSION }) {
  const d = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  const len = itemLen ?? (count ? d.length / count : 0)
  if (!Number.isInteger(len) || len * count !== d.length) throw new Error('item data is not count * itemLen bytes')
  const b = Buffer.alloc(8 + d.length)
  b[0] = id
  b[1] = ver
  b.writeUInt16LE(count, 2)
  b.writeUInt32LE(len, 4)
  d.copy(b, 8)
  return b
}

/** Walks the items as the vendor does: stops at the first one that would run past the end. */
export function decodeItems(buf) {
  const out = []
  let o = 0
  while (o + 8 <= buf.length) {
    const count = buf.readUInt16LE(o + 2)
    const itemLen = buf.readUInt32LE(o + 4)
    const end = o + 8 + count * itemLen
    if (end > buf.length) break
    out.push({ id: buf[o], ver: buf[o + 1], count, itemLen, data: buf.subarray(o + 8, end) })
    o = end
  }
  return out
}

/** First item with this id and version 4 (the vendor skips other versions), or null. */
export function findItem(items, id) {
  return items.find((it) => it.id === id && it.ver === ITEM_VERSION) ?? null
}

// ---------------------------------------------------------- command header + items (plain text)
/** 16-byte command header {version 4, cmdType, cmdId, time (seconds)} followed by the items. */
export function encodeCommand({ version = CMD_VERSION, cmdType, cmdId, time, items = [] }) {
  const parts = items.map((it) => (Buffer.isBuffer(it) ? it : encodeItem(it)))
  const h = Buffer.alloc(16)
  h.writeUInt32LE(version, 0)
  h.writeUInt32LE(cmdType >>> 0, 4)
  h.writeUInt32LE(cmdId >>> 0, 8)
  h.writeUInt32LE(time >>> 0, 12)
  return Buffer.concat([h, ...parts])
}

export function decodeCommand(plain) {
  if (plain.length < 16) throw new Error('command shorter than its 16-byte header')
  return {
    version: plain.readUInt32LE(0),
    cmdType: plain.readUInt32LE(4),
    cmdId: plain.readUInt32LE(8),
    time: plain.readUInt32LE(12),
    items: decodeItems(plain.subarray(16))
  }
}

// ---------------------------------------------------------------------------- packet envelope
/** RSA-1024, PKCS#1 v1.5: 117 plain bytes become one 128-byte block. */
export function rsaCipherLen(plainLen) {
  return Math.ceil(plainLen / 117) * 128
}

/** AES envelope: the cipher text is (plainLen & ~15) + 16 bytes, so a full extra block when plainLen is a multiple of 16. */
export function aesCipherLen(plainLen) {
  return (plainLen & ~15) + 16
}

/**
 * The clear-text part of a command packet. `body` is what follows the per-type fields:
 *   0 NONE  u32 0, u32 len                                              body = command (plain)
 *   1 RSA   u32 1, u32 len, u32 plainLen                                body = 128-byte blocks
 *   2 AES   u32 2, u32 len, u32 keyId0, u32 keyId1, u32 plainLen, u32 crc   body = cipher text
 *   3 XOR   u32 3, u32 len, u8 key[4]                                   body = command XOR key
 * len counts every byte after itself.
 */
export function encodeEnvelope({ encType, body, plainLen, keyId0 = 0, keyId1 = 0, crc = 0, xorKey }) {
  let head
  if (encType === ENC.NONE) head = Buffer.alloc(8)
  else if (encType === ENC.RSA) {
    head = Buffer.alloc(12)
    head.writeUInt32LE(plainLen >>> 0, 8)
  } else if (encType === ENC.AES) {
    head = Buffer.alloc(0x18)
    head.writeUInt32LE(keyId0 >>> 0, 8)
    head.writeUInt32LE(keyId1 >>> 0, 0xc)
    head.writeUInt32LE(plainLen >>> 0, 0x10)
    head.writeUInt32LE(crc >>> 0, 0x14)
  } else if (encType === ENC.XOR) {
    if (!Buffer.isBuffer(xorKey) || xorKey.length !== 4) throw new Error('xorKey must be 4 bytes')
    head = Buffer.alloc(12)
    xorKey.copy(head, 8)
  } else throw new Error(`not support encrypt type:${encType}`)
  head.writeUInt32LE(encType, 0)
  head.writeUInt32LE(head.length - 8 + body.length, 4)
  return Buffer.concat([head, body])
}

export function decodeEnvelope(buf) {
  if (buf.length < 8) throw new Error('command packet shorter than 8 bytes')
  const encType = buf.readUInt32LE(0)
  const len = buf.readUInt32LE(4)
  if (8 + len > buf.length) throw new Error(`command packet length ${len} runs past the ${buf.length} bytes given`)
  const end = 8 + len
  const need = (n) => {
    if (end < n) throw new Error('command packet too short for its encrypt type')
  }
  if (encType === ENC.NONE) return { encType, len, body: buf.subarray(8, end) }
  if (encType === ENC.RSA) {
    need(12)
    return { encType, len, plainLen: buf.readUInt32LE(8), body: buf.subarray(12, end) }
  }
  if (encType === ENC.AES) {
    need(0x18)
    return {
      encType,
      len,
      keyId0: buf.readUInt32LE(8),
      keyId1: buf.readUInt32LE(0xc),
      plainLen: buf.readUInt32LE(0x10),
      crc: buf.readUInt32LE(0x14),
      body: buf.subarray(0x18, end)
    }
  }
  if (encType === ENC.XOR) {
    need(12)
    return { encType, len, xorKey: buf.subarray(8, 12), body: buf.subarray(12, end) }
  }
  throw new Error(`not support encrypt type:${encType}`)
}

// ------------------------------------------------------------------- "1010" stream records
export const RECORD_MAGIC = Buffer.from('1010', 'latin1')
export const RECORD_SPLIT_OVER = 0x12bf8 // a packet larger than this is cut into pieces
export const RECORD_PIECE_MAX = 0x12be8

/**
 * Frame one command packet for a server link: "1010" + u32 len + packet. A packet over 0x12bf8
 * bytes goes as pieces: "1010" + 0xffffffff + {u32 combineId, u16 pieces, u16 pieceNo (from 1),
 * u32 totalLen, u32 pieceLen} + pieceLen bytes. The result is then cut into DATA payloads.
 */
export function encodeRecords(packet, { combineId = 1 } = {}) {
  if (packet.length <= RECORD_SPLIT_OVER) {
    const h = Buffer.alloc(8)
    RECORD_MAGIC.copy(h)
    h.writeUInt32LE(packet.length, 4)
    return Buffer.concat([h, packet])
  }
  const pieces = Math.ceil(packet.length / RECORD_PIECE_MAX)
  const parts = []
  for (let i = 0; i < pieces; i++) {
    const piece = packet.subarray(i * RECORD_PIECE_MAX, (i + 1) * RECORD_PIECE_MAX)
    const h = Buffer.alloc(24)
    RECORD_MAGIC.copy(h)
    h.writeUInt32LE(0xffffffff, 4)
    h.writeUInt32LE(combineId >>> 0, 8)
    h.writeUInt16LE(pieces, 12)
    h.writeUInt16LE(i + 1, 14)
    h.writeUInt32LE(packet.length, 16)
    h.writeUInt32LE(piece.length, 20)
    parts.push(h, piece)
  }
  return Buffer.concat(parts)
}

/** Cut a byte string into DATA payloads of at most 1236 bytes. */
export function cutPayloads(bytes, max = MAX_PAYLOAD) {
  const out = []
  for (let o = 0; o < bytes.length; o += max) out.push(bytes.subarray(o, o + max))
  return out
}

/** Incremental reader of the "1010" record stream of a server link. push() returns whole command packets. */
export class RecordParser {
  #buf = Buffer.alloc(0)
  #sets = new Map() // combineId -> { pieces, total, parts[] }

  get pending() {
    return this.#buf.length
  }

  push(bytes) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, bytes]) : Buffer.from(bytes)
    const out = []
    for (;;) {
      const b = this.#buf
      if (b.length < 8) break
      if (!b.subarray(0, 4).equals(RECORD_MAGIC)) throw new Error(`record does not start with "1010": ${b.subarray(0, 4).toString('hex')}`)
      const len = b.readUInt32LE(4)
      if (len !== 0xffffffff) {
        if (b.length < 8 + len) break
        out.push(Buffer.from(b.subarray(8, 8 + len)))
        this.#buf = b.subarray(8 + len)
        continue
      }
      if (b.length < 24) break
      const combineId = b.readUInt32LE(8)
      const pieces = b.readUInt16LE(12)
      const pieceNo = b.readUInt16LE(14)
      const total = b.readUInt32LE(16)
      const pieceLen = b.readUInt32LE(20)
      if (!pieces || !pieceNo || pieceNo > pieces || pieceLen > RECORD_PIECE_MAX) throw new Error('bad record piece header')
      if (b.length < 24 + pieceLen) break
      let set = this.#sets.get(combineId)
      if (!set) this.#sets.set(combineId, (set = { pieces, total, parts: [] }))
      set.parts[pieceNo - 1] = Buffer.from(b.subarray(24, 24 + pieceLen))
      this.#buf = b.subarray(24 + pieceLen)
      if (set.parts.filter(Boolean).length === set.pieces) {
        this.#sets.delete(combineId)
        const whole = Buffer.concat(set.parts)
        if (whole.length !== set.total) throw new Error(`record pieces join to ${whole.length} bytes, header says ${set.total}`)
        out.push(whole)
      }
    }
    return out
  }
}
