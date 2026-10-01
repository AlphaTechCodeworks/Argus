// P2P 2.0 crypto: the four command-packet encrypt types (none, RSA, AES-ECB + CRC-32, XOR), the
// session key rule, and the "aligned" AES used by the SYN bodies. Node's own crypto only.
// Everything here works on buffers; nothing is sent anywhere.
import { createCipheriv, createDecipheriv, constants, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto'
import { ENC, aesCipherLen, crc32, decodeEnvelope, encodeEnvelope } from './wire.mjs'

// ------------------------------------------------------------------------------------- XOR
/** XOR with a repeating key, starting at byte 0 of `buf` (CNatDataEncrypt::XOREncrypt). Returns a new buffer. */
export function xorCrypt(buf, key) {
  if (!key.length) throw new Error('empty XOR key')
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length]
  return out
}

// ------------------------------------------------------------------------------------- RSA
export const RSA_BLOCK = 128 // RSA-1024
export const RSA_PLAIN_PER_BLOCK = 117 // PKCS#1 v1.5: 128 - 11

/**
 * The client's key pair: RSA-1024, e = 65537, both halves as PKCS#1 PEM
 * ("-----BEGIN RSA PUBLIC KEY-----"), as RSA_generate_key(1024, 0x10001) + PEM_write_bio_RSAPublicKey.
 * The public PEM is 251 bytes; that is the size of item 0x03 in the owner's capture.
 */
export function generateRsaKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicExponent: 0x10001,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  return { publicPem: publicKey, privatePem: privateKey }
}

/** Encrypt as the server does: 117 plain bytes per 128-byte block, PKCS#1 v1.5. (Used by tests and a fake server.) */
export function rsaEncryptBlocks(plain, publicPem) {
  const out = []
  for (let o = 0; o < plain.length; o += RSA_PLAIN_PER_BLOCK) {
    out.push(publicEncrypt({ key: publicPem, padding: constants.RSA_PKCS1_PADDING }, plain.subarray(o, o + RSA_PLAIN_PER_BLOCK)))
  }
  return Buffer.concat(out)
}

/**
 * Decrypt 128-byte blocks with the private key and strip the PKCS#1 v1.5 padding
 * (00 02 <non-zero filler, at least 8> 00 <data>). The raw RSA step is done with no padding and the
 * padding is removed here, because some Node releases refuse PKCS#1 v1.5 in privateDecrypt.
 * This is not constant-time; it only ever sees replies to our own request, with our own key.
 */
export function rsaDecryptBlocks(cipher, privatePem) {
  if (!cipher.length || cipher.length % RSA_BLOCK) throw new Error(`RSA cipher text of ${cipher.length} bytes is not whole 128-byte blocks`)
  const out = []
  for (let o = 0; o < cipher.length; o += RSA_BLOCK) {
    const em = privateDecrypt({ key: privatePem, padding: constants.RSA_NO_PADDING }, cipher.subarray(o, o + RSA_BLOCK))
    if (em.length !== RSA_BLOCK || em[0] !== 0 || em[1] !== 2) throw new Error('TNAT_ENCRYPT_RSA decrypt failed')
    const z = em.indexOf(0, 2)
    if (z < 10) throw new Error('TNAT_ENCRYPT_RSA decrypt failed')
    out.push(em.subarray(z + 1))
  }
  return Buffer.concat(out)
}

// ------------------------------------------------------------------------------------- AES
const aesName = (key) => {
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) throw new Error(`AES key of ${key.length} bytes (need 16, 24 or 32)`)
  return `aes-${key.length * 8}-ecb`
}

/** AES-ECB over whole blocks, no padding, no IV (CAESECBImp). Key of 16, 24 or 32 bytes. */
export function aesEcbEncrypt(buf, key) {
  if (buf.length % 16) throw new Error('AES-ECB input is not whole blocks')
  const c = createCipheriv(aesName(key), key, null)
  c.setAutoPadding(false)
  return Buffer.concat([c.update(buf), c.final()])
}

export function aesEcbDecrypt(buf, key) {
  if (buf.length % 16) throw new Error('AES-ECB input is not whole blocks')
  const d = createDecipheriv(aesName(key), key, null)
  d.setAutoPadding(false)
  return Buffer.concat([d.update(buf), d.final()])
}

/**
 * The session key rule: the 16 key bytes of item 0x05 printed as 32 lowercase hex characters
 * ("%02x"); those 32 ASCII bytes are the AES-256 key.
 */
export function sessionKeyFromBytes(keyBytes) {
  if (keyBytes.length !== 16) throw new Error('session key record must hold 16 bytes')
  return Buffer.from(keyBytes.toString('hex'), 'latin1')
}

/**
 * CNatDataEncrypt::AESEncryptByAlign: zero-pad to a multiple of 16 (no extra block when already
 * aligned), then AES-ECB. Used for the SYN step 2 / 3 bodies, where the plain text is JSON + NUL.
 */
export function aesEncryptAligned(plain, key) {
  const padded = Buffer.alloc(Math.ceil(plain.length / 16) * 16)
  plain.copy(padded)
  return aesEcbEncrypt(padded, key)
}

/** Decrypt a body made by aesEncryptAligned and return the text up to the first NUL. */
export function aesDecryptAlignedText(cipher, key) {
  const plain = aesEcbDecrypt(cipher, key)
  const z = plain.indexOf(0)
  return plain.toString('utf8', 0, z < 0 ? plain.length : z)
}

// ----------------------------------------------------------------------- command packets
/**
 * Encrypt one command (16-byte command header + items, from wire.encodeCommand) into a command
 * packet, as CCMDPacket::CCMDPacket + EncryptCMDData.
 *   encType 0  nothing
 *   encType 1  RSA to `publicPem` (the client never sends this; a fake server does)
 *   encType 2  AES-ECB with `key`; keyId0 / keyId1 in the clear; CRC-32 over the padded plain text.
 *              The plain text is padded to (plainLen & ~15) + 16 bytes. The vendor does not clear
 *              the padding (it is whatever was in the heap); we write `padFill` bytes, zeros
 *              unless the caller passes something else. The CRC covers the padding, so any fill is valid.
 *              A plain text that is already a multiple of 16 still gets a whole extra block: that
 *              is the client's code. The cloud's own packets do not (its "not online" reply has
 *              plain length 32 and 32 cipher bytes); `serverStyle: true` builds that form for a
 *              fake server. openCommand accepts both.
 *   encType 3  XOR with the 4-byte `xorKey`, which travels in the packet (random when not given)
 */
export function sealCommand(plain, { encType, key, keyId0 = 0, keyId1 = 0, xorKey, publicPem, padFill, serverStyle = false } = {}) {
  if (encType === ENC.NONE) return encodeEnvelope({ encType, body: plain })
  if (encType === ENC.XOR) {
    const k = xorKey ?? randomBytes(4)
    return encodeEnvelope({ encType, xorKey: k, body: xorCrypt(plain, k) })
  }
  if (encType === ENC.AES) {
    const padded = Buffer.alloc(serverStyle ? Math.ceil(plain.length / 16) * 16 : aesCipherLen(plain.length), 0)
    if (padFill) for (let i = plain.length; i < padded.length; i++) padded[i] = padFill[(i - plain.length) % padFill.length]
    plain.copy(padded)
    return encodeEnvelope({ encType, keyId0, keyId1, plainLen: plain.length, crc: crc32(padded), body: aesEcbEncrypt(padded, key) })
  }
  if (encType === ENC.RSA) return encodeEnvelope({ encType, plainLen: plain.length, body: rsaEncryptBlocks(plain, publicPem) })
  throw new Error(`not support encrypt type:${encType}`)
}

/**
 * Decrypt a command packet, as CCMDPacket::DecryptCMDData. Returns the envelope's clear fields
 * plus `plain` (the 16-byte command header + items).
 *   keys.privatePem  for encType 1
 *   keys.aesKey      for encType 2: a Buffer, or a function (keyId0, keyId1) => Buffer
 * Throws when the key is missing, the CRC does not match or the lengths do not fit.
 */
export function openCommand(packet, keys = {}) {
  const env = decodeEnvelope(packet)
  if (env.encType === ENC.NONE) return { ...env, plain: env.body }
  if (env.encType === ENC.XOR) return { ...env, plain: xorCrypt(env.body, env.xorKey) }
  if (env.encType === ENC.RSA) {
    if (!keys.privatePem) throw new Error('RSA packet but no private key')
    const plain = rsaDecryptBlocks(env.body, keys.privatePem)
    if (plain.length !== env.plainLen) throw new Error(`RSA plain text is ${plain.length} bytes, header says ${env.plainLen}`)
    return { ...env, plain }
  }
  const key = typeof keys.aesKey === 'function' ? keys.aesKey(env.keyId0, env.keyId1) : keys.aesKey
  if (!key) throw new Error('AES packet but no key')
  if (env.body.length % 16 || env.plainLen > env.body.length) throw new Error('AES packet lengths do not fit')
  const padded = aesEcbDecrypt(env.body, key)
  if (crc32(padded) !== env.crc) throw new Error('AESDeEncrypt crc32 not match')
  return { ...env, plain: padded.subarray(0, env.plainLen) }
}
