// Offline tests for the P2P 2.0 wire layouts (p2p/wire.mjs). Synthetic bytes only; nothing is sent.
//   node cctv/test/p2p-wire.test.mjs
import {
  CATEGORY,
  CMD,
  CONNECT_TYPE,
  DATA_TYPE,
  ENC,
  HEADER_LEN,
  MAX_PAYLOAD,
  RECORD_SPLIT_OVER,
  RecordParser,
  crc32,
  decodeAckList,
  decodeCommand,
  decodeDatagram,
  decodeEnvelope,
  decodeItems,
  decodeSyn,
  encodeAckList,
  encodeCommand,
  encodeDatagram,
  encodeEnvelope,
  encodeItem,
  encodeRecords,
  encodeSyn,
  findItem,
  rsaCipherLen
} from '../p2p/wire.mjs'

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
const id16 = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

// ---- CRC-32
check('crc32 of "123456789" is the standard check value', crc32(Buffer.from('123456789')) === 0xcbf43926)
check('crc32 of nothing is 0', crc32(Buffer.alloc(0)) === 0)

// ---- 36-byte header
{
  const d = encodeDatagram(
    {
      category: CATEGORY.SERVER,
      command: CMD.DATA,
      dataType: DATA_TYPE.STREAM,
      connectType: CONNECT_TYPE.SERVER,
      connectionId: id16,
      sendCounter: 1,
      peerCounter: 0,
      dataIndex: 2,
      ackIndex: 1
    },
    Buffer.from('1010')
  )
  check('header is 36 bytes and the payload follows', d.length === HEADER_LEN + 4 && d.toString('latin1', 36) === '1010')
  check('server data packet starts 02 01 01 00', d.subarray(0, 4).toString('hex') === '02010100')
  check('connection id sits at offset 4', d.subarray(4, 20).equals(id16))
  check(
    'the four words are little-endian at 0x14, 0x18, 0x1c, 0x20',
    d.readUInt32LE(0x14) === 1 && d.readUInt32LE(0x18) === 0 && d.readUInt32LE(0x1c) === 2 && d.readUInt32LE(0x20) === 1
  )
  const h = decodeDatagram(d)
  check(
    'decode gives every field back',
    h.category === 2 &&
      h.command === CMD.DATA &&
      h.dataType === 0 &&
      h.flags === 1 &&
      h.connectType === 0 &&
      h.connectionId.equals(id16) &&
      h.sendCounter === 1 &&
      h.peerCounter === 0 &&
      h.dataIndex === 2 &&
      h.ackIndex === 1 &&
      h.payload.toString('latin1') === '1010'
  )
  check('decode then encode is byte-identical', encodeDatagram(h, h.payload).equals(d))
}
{
  const d = encodeDatagram({
    category: CATEGORY.PEER,
    command: CMD.DATA,
    dataType: DATA_TYPE.PEER_CMD,
    connectType: CONNECT_TYPE.UPNP,
    connectionId: id16,
    sendCounter: 9,
    peerCounter: 8,
    dataIndex: 2,
    ackIndex: 3
  })
  check('peer command packet starts 01 11 01 03', d.subarray(0, 4).toString('hex') === '01110103')
  check('no payload gives exactly 36 bytes', d.length === 36)
  const h = decodeDatagram(d)
  check('high nibble of byte 1 is the data type', h.command === CMD.DATA && h.dataType === DATA_TYPE.PEER_CMD)
}
check('a datagram shorter than 36 bytes is refused', threw(() => decodeDatagram(Buffer.alloc(35))) !== null)
check('a connection id that is not 16 bytes is refused', threw(() => encodeDatagram({ category: 1, command: 1, connectionId: Buffer.alloc(15) })) !== null)
check(
  'a payload over 1236 bytes is refused',
  threw(() => encodeDatagram({ category: 1, command: 1, connectionId: id16 }, Buffer.alloc(MAX_PAYLOAD + 1))) !== null
)
check(
  'exactly 1236 bytes is the largest datagram, 1272',
  encodeDatagram({ category: 1, command: 1, connectionId: id16 }, Buffer.alloc(MAX_PAYLOAD)).length === 1272
)

// ---- selective ACK list
{
  const p = encodeAckList([5, 7, 9])
  check('ack list is u32 little-endian each', p.length === 12 && p.readUInt32LE(4) === 7)
  check('ack list decodes', decodeAckList(p).join() === '5,7,9')
  check('ack list is cut at 309 entries', encodeAckList(Array.from({ length: 400 }, (_, i) => i)).length === 309 * 4)
  check('a ragged ack list ignores the tail bytes', decodeAckList(Buffer.concat([p, Buffer.from([1, 2])])).length === 3)
}

// ---- connector SYN
{
  const body = Buffer.alloc(144, 0xab)
  const d = encodeSyn({ connectType: CONNECT_TYPE.LAN, connectionId: id16, step: 1, body })
  check('SYN step 1 with a 144-byte body is 184 bytes', d.length === 36 + 4 + 144)
  check('SYN starts 01 00 01 <connect type>', d.subarray(0, 4).toString('hex') === '01000102')
  check('SYN has four zero words', d.subarray(0x14, 0x24).equals(Buffer.alloc(16)))
  check('step at 0x24, version 0x0102 at 0x26', d.readUInt16LE(0x24) === 1 && d.readUInt16LE(0x26) === 0x0102)
  const s = decodeSyn(decodeDatagram(d))
  check('SYN decodes', s.step === 1 && s.version === 0x0102 && s.body.equals(body))
  const d4 = encodeSyn({ connectType: CONNECT_TYPE.RELAY, connectionId: id16, step: 4 })
  check('SYN step 4 has an empty body: 40 bytes', d4.length === 40 && decodeSyn(decodeDatagram(d4)).body.length === 0)
  check('decodeSyn refuses a data packet', threw(() => decodeSyn(decodeDatagram(encodeDatagram({ category: 1, command: 1, connectionId: id16 })))) !== null)
}

// ---- items
{
  const a = encodeItem({ id: 0x01, data: Buffer.from('{"a":1}') })
  check('item header: id, ver 4, count 1, length', a[0] === 1 && a[1] === 4 && a.readUInt16LE(2) === 1 && a.readUInt32LE(4) === 7)
  check('item is 8 + data bytes', a.length === 15)
  const b = encodeItem({ id: 0x05, data: Buffer.alloc(24, 7) })
  const items = decodeItems(Buffer.concat([a, b]))
  check('two items decode in order', items.length === 2 && items[0].id === 1 && items[1].id === 5 && items[1].data.length === 24)
  check('findItem finds by id', findItem(items, 5)?.data[0] === 7 && findItem(items, 9) === null)
  const odd = Buffer.from(a)
  odd[1] = 3
  check('an item with version other than 4 is not returned by findItem', findItem(decodeItems(odd), 1) === null)
  const multi = encodeItem({ id: 0x71, count: 3, itemLen: 4, data: Buffer.alloc(12, 1) })
  check('count * itemLen items decode', decodeItems(multi)[0].count === 3 && decodeItems(multi)[0].data.length === 12)
  check('a cut-off item is dropped, the ones before are kept', decodeItems(Buffer.concat([a, b.subarray(0, 20)])).length === 1)
  check('string data is accepted', encodeItem({ id: 2, data: 'abc' }).length === 11)
}

// ---- command (the 16-byte command header + items)
{
  const plain = encodeCommand({ cmdType: 0x303, cmdId: 7, time: 1700000000, items: [{ id: 0x33, data: '{}' }] })
  check('command plain text is 16 + items', plain.length === 16 + 8 + 2)
  check(
    'command header is version 4, type, id, time',
    plain.readUInt32LE(0) === 4 && plain.readUInt32LE(4) === 0x303 && plain.readUInt32LE(8) === 7 && plain.readUInt32LE(12) === 1700000000
  )
  const c = decodeCommand(plain)
  check('command decodes', c.version === 4 && c.cmdType === 0x303 && c.cmdId === 7 && c.items[0].id === 0x33)
  check('a command shorter than 16 bytes is refused', threw(() => decodeCommand(Buffer.alloc(15))) !== null)
}

// ---- envelopes (clear-text part only; the crypto is in crypt.mjs)
{
  const body = Buffer.alloc(40, 1)
  const e0 = encodeEnvelope({ encType: ENC.NONE, body })
  check('type 0: 8 + body, len counts what follows', e0.length === 48 && e0.readUInt32LE(0) === 0 && e0.readUInt32LE(4) === 40)
  check('type 0 decodes', decodeEnvelope(e0).body.equals(body))

  const e3 = encodeEnvelope({ encType: ENC.XOR, xorKey: Buffer.from([1, 2, 3, 4]), body })
  check('type 3: data + 0x1c for a 16-byte header + data body', e3.length === 40 + 12 && e3.readUInt32LE(4) === 44)
  const d3 = decodeEnvelope(e3)
  check('type 3 decodes key and body', d3.xorKey.equals(Buffer.from([1, 2, 3, 4])) && d3.body.equals(body))

  const cipher = Buffer.alloc(48, 9)
  const e2 = encodeEnvelope({ encType: ENC.AES, keyId0: 0x11, keyId1: 0x22, plainLen: 40, crc: 0xdeadbeef, body: cipher })
  check('type 2: 0x18 bytes of header then the cipher text', e2.length === 0x18 + 48 && e2.readUInt32LE(4) === 16 + 48)
  const d2 = decodeEnvelope(e2)
  check(
    'type 2 decodes key ids, plain length, crc',
    d2.keyId0 === 0x11 && d2.keyId1 === 0x22 && d2.plainLen === 40 && d2.crc === 0xdeadbeef && d2.body.equals(cipher)
  )
  check('type 2 total is (plainLen & ~15) + 0x28', e2.length === (40 & ~15) + 0x28)

  const rsa = Buffer.alloc(256, 5)
  const e1 = encodeEnvelope({ encType: ENC.RSA, plainLen: 180, body: rsa })
  check('type 1: 12 bytes of header then 128-byte blocks', e1.length === 12 + 256 && e1.readUInt32LE(4) === 260 && e1.readUInt32LE(8) === 180)
  check('type 1 decodes', decodeEnvelope(e1).plainLen === 180 && decodeEnvelope(e1).body.length === 256)
  check('rsaCipherLen: 117 plain bytes per 128-byte block', rsaCipherLen(180) === 256 && rsaCipherLen(117) === 128 && rsaCipherLen(3906) === 34 * 128)

  check('an unknown encrypt type is refused', threw(() => decodeEnvelope(Buffer.from('0900000004000000aabbccdd', 'hex'))) !== null)
  check('a length word that runs past the buffer is refused', threw(() => decodeEnvelope(Buffer.from('0000000010000000aabb', 'hex'))) !== null)
  const padded = Buffer.concat([e0, Buffer.alloc(5)])
  check('bytes after the length word are not part of the body', decodeEnvelope(padded).body.length === 40)
}

// ---- "1010" stream records
{
  const packet = Buffer.alloc(56, 3)
  const rec = encodeRecords(packet)
  check('record is "1010" + u32 length + packet', rec.length === 64 && rec.toString('latin1', 0, 4) === '1010' && rec.readUInt32LE(4) === 56)
  check('a 56-byte packet gives the "10108" of the vendor notes', rec.toString('latin1', 0, 5) === '10108')

  const p = new RecordParser()
  check('nothing comes out of half a record', p.push(rec.subarray(0, 30)).length === 0)
  const out = p.push(Buffer.concat([rec.subarray(30), rec]))
  check('two records come out once the bytes are there', out.length === 2 && out[0].equals(packet) && out[1].equals(packet))
  check('parser holds no bytes afterwards', p.pending === 0)

  const big = Buffer.alloc(RECORD_SPLIT_OVER + 100)
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 255
  const split = encodeRecords(big, { combineId: 42 })
  check('a packet over 0x12bf8 bytes is split: first record has length 0xffffffff', split.readUInt32LE(4) === 0xffffffff)
  check(
    'piece header: combine id, pieces, piece number from 1, total length, piece length',
    split.readUInt32LE(8) === 42 &&
      split.readUInt16LE(12) === 2 &&
      split.readUInt16LE(14) === 1 &&
      split.readUInt32LE(16) === big.length &&
      split.readUInt32LE(20) === 0x12be8
  )
  check('split size is the packet plus 24 bytes per piece', split.length === big.length + 2 * 24)
  const q = new RecordParser()
  let got = []
  for (let o = 0; o < split.length; o += 1236) got = got.concat(q.push(split.subarray(o, o + 1236)))
  check('pieces fed in 1236-byte steps join into the packet', got.length === 1 && got[0].equals(big))
  check('exactly 0x12bf8 bytes is not split', encodeRecords(Buffer.alloc(RECORD_SPLIT_OVER)).readUInt32LE(4) === RECORD_SPLIT_OVER)

  const bad = new RecordParser()
  check('bytes that do not start with "1010" are refused', threw(() => bad.push(Buffer.from('1111aaaaaaaa'))) !== null)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
