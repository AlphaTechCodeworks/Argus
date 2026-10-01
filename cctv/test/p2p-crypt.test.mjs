// Offline tests for the P2P 2.0 crypto (p2p/crypt.mjs). Keys are made here or are public test
// vectors; nothing is sent.
//   node cctv/test/p2p-crypt.test.mjs
import { createPublicKey } from 'node:crypto'
import {
  aesDecryptAlignedText,
  aesEcbDecrypt,
  aesEcbEncrypt,
  aesEncryptAligned,
  generateRsaKeyPair,
  openCommand,
  rsaDecryptBlocks,
  rsaEncryptBlocks,
  sealCommand,
  sessionKeyFromBytes,
  xorCrypt
} from '../p2p/crypt.mjs'
import { ENC, crc32, decodeCommand, decodeEnvelope, encodeCommand } from '../p2p/wire.mjs'

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

// ---- XOR
{
  const key = Buffer.from([0x10, 0x20, 0x30, 0x40])
  const x = xorCrypt(Buffer.from([1, 2, 3, 4, 5]), key)
  check('XOR repeats the 4-byte key from byte 0', x.equals(Buffer.from([0x11, 0x22, 0x33, 0x44, 0x15])))
  check('XOR twice gives the input back', xorCrypt(x, key).equals(Buffer.from([1, 2, 3, 4, 5])))
}

// ---- AES-ECB
{
  // FIPS-197 appendix C.3 and C.1
  const k256 = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex')
  const pt = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  check('AES-256-ECB matches the FIPS-197 vector', aesEcbEncrypt(pt, k256).toString('hex') === '8ea2b7ca516745bfeafc49904b496089')
  check('AES-128-ECB matches the FIPS-197 vector', aesEcbEncrypt(pt, k256.subarray(0, 16)).toString('hex') === '69c4e0d86a7b0430d8cdb78070b4c55a')
  check('AES-192 key is accepted', aesEcbDecrypt(aesEcbEncrypt(pt, k256.subarray(0, 24)), k256.subarray(0, 24)).equals(pt))
  check('ECB: equal plain blocks give equal cipher blocks', (() => {
    const c = aesEcbEncrypt(Buffer.concat([pt, pt]), k256)
    return c.subarray(0, 16).equals(c.subarray(16))
  })())
  check('a 20-byte key is refused', threw(() => aesEcbEncrypt(pt, Buffer.alloc(20))) !== null)
  check('input that is not whole blocks is refused', threw(() => aesEcbEncrypt(Buffer.alloc(17), k256)) !== null)
}

// ---- session key rule
{
  const bytes = Buffer.from('00ff10a1b2c3d4e5f60718293a4b5c6d', 'hex')
  const key = sessionKeyFromBytes(bytes)
  check('session key is 32 ASCII characters', key.length === 32)
  check('session key is the 16 bytes as lowercase hex text', key.toString('latin1') === '00ff10a1b2c3d4e5f60718293a4b5c6d')
  check('15 key bytes are refused', threw(() => sessionKeyFromBytes(Buffer.alloc(15))) !== null)
}

// ---- aligned AES (SYN bodies)
{
  const key = Buffer.from('0123456789abcdef0123456789abcdef', 'latin1')
  const text = Buffer.from('{"dx":"AAAAAAAAAAAAAAAAAAAAAA"}\0', 'latin1') // 31 characters + NUL = 32
  const c = aesEncryptAligned(text, key)
  check('aligned AES: 32 plain bytes stay 32 (no extra block)', c.length === 32)
  check('aligned AES: 33 plain bytes become 48', aesEncryptAligned(Buffer.alloc(33, 65), key).length === 48)
  check('aligned AES pads with zeros', aesEcbDecrypt(aesEncryptAligned(Buffer.from('ab'), key), key).subarray(2).equals(Buffer.alloc(14)))
  check('aligned text comes back up to the NUL', aesDecryptAlignedText(c, key) === '{"dx":"AAAAAAAAAAAAAAAAAAAAAA"}')
}

// ---- RSA
const pair = generateRsaKeyPair()
{
  check('public key is PKCS#1 PEM', pair.publicPem.startsWith('-----BEGIN RSA PUBLIC KEY-----\n'))
  check('public PEM is 251 bytes, the size of item 0x03 in the capture', Buffer.byteLength(pair.publicPem) === 251, String(Buffer.byteLength(pair.publicPem)))
  check('private key is PKCS#1 PEM', pair.privatePem.startsWith('-----BEGIN RSA PRIVATE KEY-----\n'))
  const pub = createPublicKey(pair.publicPem)
  check('key is RSA-1024 with e = 65537', pub.asymmetricKeyDetails.modulusLength === 1024 && pub.asymmetricKeyDetails.publicExponent === 65537n)

  const plain = Buffer.alloc(180)
  for (let i = 0; i < plain.length; i++) plain[i] = i
  const cipher = rsaEncryptBlocks(plain, pair.publicPem)
  check('180 plain bytes become two 128-byte blocks', cipher.length === 256)
  check('RSA blocks decrypt to the plain text', rsaDecryptBlocks(cipher, pair.privatePem).equals(plain))
  check('117 plain bytes fill exactly one block', rsaEncryptBlocks(Buffer.alloc(117, 1), pair.publicPem).length === 128)
  check('a plain text with zero bytes survives', rsaDecryptBlocks(rsaEncryptBlocks(Buffer.alloc(40), pair.publicPem), pair.privatePem).equals(Buffer.alloc(40)))
  check('cipher text that is not whole blocks is refused', threw(() => rsaDecryptBlocks(cipher.subarray(0, 200), pair.privatePem)) !== null)
  const other = generateRsaKeyPair()
  check('the wrong private key is refused', threw(() => rsaDecryptBlocks(cipher, other.privatePem)) !== null)
}

// ---- command packets
const plain = encodeCommand({ cmdType: 0x303, cmdId: 3, time: 1700000000, items: [{ id: 0x33, data: 'x'.repeat(243) }] })
{
  check('test command is 267 bytes, the plain length measured in the capture', plain.length === 267)
  const aesKey = sessionKeyFromBytes(Buffer.alloc(16, 0x5a))

  const p0 = sealCommand(plain, { encType: ENC.NONE })
  check('type 0: data + 0x18', p0.length === 267 - 16 + 0x18 && openCommand(p0).plain.equals(plain))

  const p3 = sealCommand(plain, { encType: ENC.XOR, xorKey: Buffer.from('a1b2c3d4', 'hex') })
  check('type 3: data + 0x1c', p3.length === 267 - 16 + 0x1c)
  check('type 3: key is in the packet at offset 8', p3.subarray(8, 12).toString('hex') === 'a1b2c3d4')
  check('type 3: the XOR starts at the command header', (p3[12] ^ 0xa1) === 4 && (p3[13] ^ 0xb2) === 0)
  check('type 3 opens without any key', openCommand(p3).plain.equals(plain))
  check('type 3 without a key given picks a random one', !sealCommand(plain, { encType: ENC.XOR }).equals(sealCommand(plain, { encType: ENC.XOR })))

  const p2 = sealCommand(plain, { encType: ENC.AES, key: aesKey, keyId0: 0x1111, keyId1: 0x2222 })
  check('type 2: (plainLen & ~15) + 0x28 = 296 bytes; with the 36 + 8 around it, the 340 of the capture', p2.length === 296 && 36 + 8 + p2.length === 340)
  const e2 = decodeEnvelope(p2)
  check('type 2: key ids and plain length are in the clear', e2.keyId0 === 0x1111 && e2.keyId1 === 0x2222 && e2.plainLen === 267)
  check('type 2: cipher text is 272 bytes', e2.body.length === 272)
  const padded = Buffer.alloc(272)
  plain.copy(padded)
  check('type 2: CRC-32 is over the padded plain text', e2.crc === crc32(padded))
  const o2 = openCommand(p2, { aesKey })
  check('type 2 opens with the key', o2.plain.equals(plain) && decodeCommand(o2.plain).cmdType === 0x303)
  check('type 2 opens with a key lookup by key id', openCommand(p2, { aesKey: (a, b) => (a === 0x1111 && b === 0x2222 ? aesKey : null) }).plain.equals(plain))
  check('type 2 with the wrong key fails on the CRC', /crc32/.test(threw(() => openCommand(p2, { aesKey: sessionKeyFromBytes(Buffer.alloc(16, 1)) }))?.message ?? ''))
  check('type 2 without a key is refused', threw(() => openCommand(p2)) !== null)
  const flipped = Buffer.from(p2)
  flipped[flipped.length - 1] ^= 1
  check('type 2 with a changed cipher byte is refused', threw(() => openCommand(flipped, { aesKey })) !== null)

  const filled = sealCommand(plain, { encType: ENC.AES, key: aesKey, padFill: Buffer.from([0xcd]) })
  check('type 2: any padding fill is valid, the CRC covers it', openCommand(filled, { aesKey }).plain.equals(plain) && decodeEnvelope(filled).crc !== e2.crc)

  const aligned = encodeCommand({ cmdType: 0x303, cmdId: 3, time: 1, items: [{ id: 0x34, data: '{"ol":0}' }] })
  const pa = sealCommand(aligned, { encType: ENC.AES, key: aesKey })
  check('type 2, client code: a 32-byte plain text gets a whole extra block (72 bytes)', aligned.length === 32 && pa.length === (32 & ~15) + 0x28)
  check('type 2: the extra block opens fine', openCommand(pa, { aesKey }).plain.equals(aligned))
  const ps = sealCommand(aligned, { encType: ENC.AES, key: aesKey, serverStyle: true })
  check('type 2, as the cloud sends it: no extra block, 56 bytes ("10108"), 100 on the wire', ps.length === 56 && 36 + 8 + ps.length === 100)
  check('type 2: the cloud form opens too', openCommand(ps, { aesKey }).plain.equals(aligned))
  check('type 2: both forms are equal when the plain text is not aligned', sealCommand(plain, { encType: ENC.AES, key: aesKey, serverStyle: true }).equals(sealCommand(plain, { encType: ENC.AES, key: aesKey })))

  const big = encodeCommand({ cmdType: 2, cmdId: 1, time: 1, items: [{ id: 4, data: 'y'.repeat(140) }, { id: 5, data: Buffer.alloc(24, 1) }] })
  const p1 = sealCommand(big, { encType: ENC.RSA, publicPem: pair.publicPem })
  check('type 1: 12 + 128 per 117 plain bytes', big.length === 196 && p1.length === 12 + 256)
  check('type 1: plain length is in the clear', decodeEnvelope(p1).plainLen === 196)
  check('type 1 opens with the private key', openCommand(p1, { privatePem: pair.privatePem }).plain.equals(big))
  check('type 1 without the private key is refused', threw(() => openCommand(p1)) !== null)
  const lied = Buffer.from(p1)
  lied.writeUInt32LE(195, 8)
  check('type 1 with a wrong plain length is refused', threw(() => openCommand(lied, { privatePem: pair.privatePem })) !== null)

  check('an unknown encrypt type is refused on seal', threw(() => sealCommand(plain, { encType: 9 })) !== null)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
