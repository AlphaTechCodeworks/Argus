// Windows single sign-on, the protocol side: Kerberos tickets that Edge / Chrome / Firefox on a domain
// PC hand over in `Authorization: Negotiate <base64>` (SPNEGO, RFC 4178 / RFC 4559), checked here with
// node:crypto alone. sso.mjs does the rest (the keytab file, the route, the AD look-up).
//
// What is here, and from which standard:
//   - a small DER reader and writer (X.690), enough for the Kerberos messages (RFC 4120 section 5)
//   - SPNEGO NegTokenInit -> the Kerberos mech token (OID 1.2.840.113554.1.2.2 or Microsoft's
//     1.2.840.48018.1.2.2) -> GSS-API framing (RFC 4121 4.1: 0x60, the OID, TOK_ID 01 00) -> AP-REQ
//   - the MIT keytab file (format 0x0502), as Windows' ktpass writes it
//   - aes256-cts-hmac-sha1-96 (etype 18) and aes128-cts-hmac-sha1-96 (17), RFC 3962 on RFC 3961's
//     simplified profile: n-fold, DK() key derivation (Ke = DK(K, usage|0xAA), Ki = DK(K, usage|0x55)),
//     AES-CBC with ciphertext stealing (the last two blocks swapped, IV zero), a 16-byte confounder,
//     HMAC-SHA1 truncated to 96 bits over confounder|plaintext. Also PBKDF2 string-to-key (only for
//     the tests' published vectors and for making test keys). RC4 (23) and DES (1, 3) are refused.
//   - the ticket (key usage 2) and the authenticator (key usage 11) decrypted and checked: realm,
//     service name, the INVALID flag, its validity window, the client name in both, clock skew and a
//     replay cache. The PAC is not read: groups come from LDAP, as for a password sign-in.
//   - the optional AP-REP for mutual authentication (key usage 12), wrapped for SPNEGO.

import { createCipheriv, createDecipheriv, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'

export const OID = Object.freeze({
  spnego: '1.3.6.1.5.5.2',
  krb5: '1.2.840.113554.1.2.2',
  msKrb5: '1.2.840.48018.1.2.2',
  ntlm: '1.3.6.1.4.1.311.2.2.10',
  negoex: '1.3.6.1.4.1.311.2.2.30'
})

export const ETYPES = Object.freeze({
  1: 'des-cbc-crc',
  3: 'des-cbc-md5',
  17: 'aes128-cts-hmac-sha1-96',
  18: 'aes256-cts-hmac-sha1-96',
  19: 'aes128-cts-hmac-sha256-128',
  20: 'aes256-cts-hmac-sha384-192',
  23: 'rc4-hmac',
  24: 'rc4-hmac-exp'
})
export const SUPPORTED_ETYPES = Object.freeze([17, 18])
const KEY_BYTES = { 17: 16, 18: 32 }
export const etypeName = (e) => ETYPES[e] ?? `etype ${e}`

export const MAX_SKEW_MS = 5 * 60_000

/** A refusal: `code` is a short reason for the status list and audit, the message says it plainly. */
export class KerberosError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
const fail = (code, message) => {
  throw new KerberosError(code, message)
}

// ---- DER -------------------------------------------------------------------------------------------

/**
 * One DER element at `pos`: { cls (0 universal, 1 application, 2 context, 3 private), constructed,
 * tag, start, end, body (Buffer) }. Definite lengths only, as DER requires.
 */
export function derRead(buf, pos = 0) {
  if (pos + 2 > buf.length) fail('bad-token', 'The token ends too early.')
  const first = buf[pos]
  let tag = first & 0x1f
  let p = pos + 1
  if (tag === 0x1f) {
    tag = 0
    for (let i = 0; ; i++) {
      if (p >= buf.length || i > 3) fail('bad-token', 'A tag in the token is too long.')
      const b = buf[p++]
      tag = (tag << 7) | (b & 0x7f)
      if (!(b & 0x80)) break
    }
  }
  if (p >= buf.length) fail('bad-token', 'The token ends too early.')
  let len = buf[p++]
  if (len & 0x80) {
    const n = len & 0x7f
    if (n === 0 || n > 4) fail('bad-token', 'A length in the token is not DER.')
    if (p + n > buf.length) fail('bad-token', 'The token ends too early.')
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++]
  }
  const end = p + len
  if (end > buf.length) fail('bad-token', 'The token ends too early.')
  return { cls: first >> 6, constructed: (first & 0x20) !== 0, tag, start: pos, bodyStart: p, end, body: buf.subarray(p, end) }
}

/** The elements inside a constructed element (or a whole buffer). */
export function derChildren(buf) {
  const out = []
  let p = 0
  while (p < buf.length) {
    const e = derRead(buf, p)
    out.push(e)
    p = e.end
  }
  return out
}

/** A SEQUENCE's [n] EXPLICIT fields: Map n -> the inner element. */
function fields(el, what) {
  if (!el || el.cls !== 0 || el.tag !== 16 || !el.constructed) fail('bad-token', `${what} is not a SEQUENCE.`)
  const m = new Map()
  for (const c of derChildren(el.body)) {
    if (c.cls !== 2 || !c.constructed) fail('bad-token', `${what} has a field that is not [n].`)
    const inner = derChildren(c.body)
    if (inner.length !== 1) fail('bad-token', `${what} field [${c.tag}] is not one element.`)
    m.set(c.tag, inner[0])
  }
  return m
}
const need = (m, n, what) => m.get(n) ?? fail('bad-token', `${what} is missing field [${n}].`)

/** [APPLICATION n] wrapping one element: the inner element. */
function app(el, n, what) {
  if (!el || el.cls !== 1 || el.tag !== n) fail('bad-token', `Not a ${what}.`)
  const inner = derChildren(el.body)
  if (inner.length !== 1) fail('bad-token', `${what} is not one element.`)
  return inner[0]
}

export function derInt(el) {
  if (!el || el.cls !== 0 || el.tag !== 2 || !el.body.length || el.body.length > 6) fail('bad-token', 'An INTEGER in the token is not one.')
  // two's complement, as DER has it (Kerberos UInt32 values carry a leading 00 when the top bit is set)
  return el.body[0] & 0x80 ? el.body.readIntBE(0, el.body.length) : el.body.readUIntBE(0, el.body.length)
}
const derOctets = (el, what = 'An OCTET STRING') => (el && el.cls === 0 && el.tag === 4 ? el.body : fail('bad-token', `${what} is not one.`))
const derStr = (el) => (el && el.cls === 0 && (el.tag === 27 || el.tag === 22 || el.tag === 12 || el.tag === 19) ? el.body.toString('utf8') : fail('bad-token', 'A string in the token is not one.'))

export function derOid(el) {
  if (!el || el.cls !== 0 || el.tag !== 6 || !el.body.length) fail('bad-token', 'An OID in the token is not one.')
  const b = el.body
  const parts = []
  let v = 0
  for (let i = 0; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f)
    if (!(b[i] & 0x80)) {
      if (!parts.length) parts.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80)
      else parts.push(v)
      v = 0
    }
  }
  return parts.join('.')
}

/** KerberosTime (GeneralizedTime "YYYYMMDDHHMMSSZ") -> ms since 1970. */
export function derTime(el) {
  if (!el || el.cls !== 0 || el.tag !== 24) fail('bad-token', 'A time in the token is not one.')
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/.exec(el.body.toString('latin1'))
  if (!m) fail('bad-token', 'A time in the token is not in Kerberos form.')
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
}

/** A BIT STRING's flag n (bit 0 is the first byte's top bit). */
function bit(el, n) {
  if (!el || el.cls !== 0 || el.tag !== 3 || !el.body.length) fail('bad-token', 'A flags field in the token is not a BIT STRING.')
  const byte = el.body[1 + (n >> 3)]
  return byte !== undefined && (byte & (0x80 >> (n & 7))) !== 0
}

// writer (for the AP-REP and for the tests' tickets)
const derLen = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : n < 0x10000 ? Buffer.from([0x82, n >> 8, n & 0xff]) : Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]))
export const der = {
  tlv: (tagByte, body) => Buffer.concat([Buffer.from([tagByte]), derLen(body.length), body]),
  seq: (...xs) => der.tlv(0x30, Buffer.concat(xs)),
  ctx: (n, x) => der.tlv(0xa0 | n, x),
  app: (n, x) => der.tlv(0x60 | n, x),
  int: (v) => {
    let hex = BigInt(v).toString(16)
    if (v < 0) {
      const bytes = Math.ceil((hex.length - 1) / 2) + 1
      hex = ((1n << BigInt(bytes * 8)) + BigInt(v)).toString(16)
    }
    if (hex.length % 2) hex = `0${hex}`
    let b = Buffer.from(hex, 'hex')
    if (v >= 0 && b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b])
    return der.tlv(0x02, b)
  },
  octets: (b) => der.tlv(0x04, Buffer.from(b)),
  str: (s) => der.tlv(0x1b, Buffer.from(s, 'utf8')), // GeneralString, as Kerberos uses
  time: (ms) => der.tlv(0x18, Buffer.from(`${new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`, 'latin1')),
  bits: (bytes) => der.tlv(0x03, Buffer.from([0, ...bytes])),
  enumerated: (v) => der.tlv(0x0a, Buffer.from([v])),
  oid: (text) => {
    const p = text.split('.').map(Number)
    const out = [p[0] * 40 + p[1]]
    for (const n of p.slice(2)) {
      const chunk = []
      let v = n
      do {
        chunk.unshift(v & 0x7f)
        v = Math.floor(v / 128)
      } while (v > 0)
      for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80
      out.push(...chunk)
    }
    return der.tlv(0x06, Buffer.from(out))
  },
  principal: (type, names) => der.seq(der.ctx(0, der.int(type)), der.ctx(1, der.seq(...names.map(der.str))))
}

// ---- RFC 3961 / 3962 crypto ------------------------------------------------------------------------

/** n-fold (RFC 3961 5.1), MIT's krb5int_nfold. */
export function nfold(input, outBytes) {
  const inBytes = input.length
  let a = outBytes
  let b = inBytes
  while (b !== 0) [a, b] = [b, a % b]
  const lcm = (outBytes * inBytes) / a
  const out = new Uint8Array(outBytes)
  let carry = 0
  for (let i = lcm - 1; i >= 0; i--) {
    const msbit = ((inBytes << 3) - 1 + ((inBytes << 3) + 13) * Math.floor(i / inBytes) + ((inBytes - (i % inBytes)) << 3)) % (inBytes << 3)
    carry += (((input[(inBytes - 1 - (msbit >> 3)) % inBytes] << 8) | input[(inBytes - (msbit >> 3)) % inBytes]) >> ((msbit & 7) + 1)) & 0xff
    carry += out[i % outBytes]
    out[i % outBytes] = carry & 0xff
    carry >>>= 8
  }
  if (carry) {
    for (let i = outBytes - 1; i >= 0; i--) {
      carry += out[i]
      out[i] = carry & 0xff
      carry >>>= 8
    }
  }
  return Buffer.from(out)
}

const aesName = (key, mode) => `aes-${key.length * 8}-${mode}`
function aesEcb(key, block, decrypt = false) {
  const c = (decrypt ? createDecipheriv : createCipheriv)(aesName(key, 'ecb'), key, null)
  c.setAutoPadding(false)
  return Buffer.concat([c.update(block), c.final()])
}
function aesCbc(key, iv, data, decrypt = false) {
  if (!data.length) return Buffer.alloc(0)
  const c = (decrypt ? createDecipheriv : createCipheriv)(aesName(key, 'cbc'), key, iv)
  c.setAutoPadding(false)
  return Buffer.concat([c.update(data), c.final()])
}
const xor = (a, b) => Buffer.from(a.map((x, i) => x ^ b[i]))

/** AES-CBC with ciphertext stealing, the last two blocks swapped (RFC 3962 5), IV zero by default. */
export function ctsEncrypt(key, plain, iv = Buffer.alloc(16)) {
  const n = plain.length
  if (n < 16) fail('crypto', 'AES-CTS needs at least one block.')
  if (n === 16) return aesCbc(key, iv, plain)
  const m = Math.ceil(n / 16)
  const d = n - 16 * (m - 1) // bytes in the last block, 1..16
  const padded = Buffer.concat([plain, Buffer.alloc(16 * m - n)])
  const c = aesCbc(key, iv, padded)
  return Buffer.concat([c.subarray(0, 16 * (m - 2)), c.subarray(16 * (m - 1), 16 * m), c.subarray(16 * (m - 2), 16 * (m - 2) + d)])
}

export function ctsDecrypt(key, data, iv = Buffer.alloc(16)) {
  const n = data.length
  if (n < 16) fail('crypto', 'AES-CTS needs at least one block.')
  if (n === 16) return aesCbc(key, iv, data, true)
  const m = Math.ceil(n / 16)
  const d = n - 16 * (m - 1)
  const head = data.subarray(0, 16 * (m - 2))
  const prev = m > 2 ? head.subarray(head.length - 16) : iv
  const x = data.subarray(16 * (m - 2), 16 * (m - 1)) // the encryption of the zero-padded last block
  const y = data.subarray(16 * (m - 1)) // the first d bytes of the second-to-last block's ciphertext
  const dx = aesEcb(key, x, true)
  const cPrev = Buffer.concat([y, dx.subarray(d)]) // the whole second-to-last ciphertext block
  const last = xor(dx, cPrev).subarray(0, d)
  const second = xor(aesEcb(key, cPrev, true), prev)
  return Buffer.concat([aesCbc(key, iv, head, true), second, last])
}

/** DK(key, constant) (RFC 3961 5.1): DR with the constant n-folded to a block, random-to-key = identity. */
export function dk(key, constant) {
  let block = nfold(Buffer.from(constant), 16)
  const out = []
  let have = 0
  while (have < key.length) {
    block = aesEcb(key, block)
    out.push(block)
    have += 16
  }
  return Buffer.concat(out).subarray(0, key.length)
}

const usageConstant = (usage, tail) => Buffer.from([(usage >>> 24) & 0xff, (usage >>> 16) & 0xff, (usage >>> 8) & 0xff, usage & 0xff, tail])
export const deriveKeys = (key, usage) => ({ ke: dk(key, usageConstant(usage, 0xaa)), ki: dk(key, usageConstant(usage, 0x55)) })

/** RFC 3962 string-to-key: DK(PBKDF2-HMAC-SHA1(password, salt, iterations), "kerberos"). */
export function stringToKey(etype, password, salt, iterations = 4096) {
  const bytes = KEY_BYTES[etype] ?? fail('etype', `${etypeName(etype)} is not supported.`)
  const b = (x) => (Buffer.isBuffer(x) ? x : Buffer.from(String(x), 'utf8'))
  return dk(pbkdf2Sync(b(password), b(salt), iterations, bytes, 'sha1'), 'kerberos')
}

/** encrypt (RFC 3961 5.3): E(Ke, confounder|plain) | HMAC-SHA1(Ki, confounder|plain)[0..12). */
export function encrypt(etype, key, usage, plain, confounder = randomBytes(16)) {
  if (!SUPPORTED_ETYPES.includes(etype) || key.length !== KEY_BYTES[etype]) fail('etype', `${etypeName(etype)} is not supported.`)
  const { ke, ki } = deriveKeys(key, usage)
  const p = Buffer.concat([confounder, plain])
  return Buffer.concat([ctsEncrypt(ke, p), createHmac('sha1', ki).update(p).digest().subarray(0, 12)])
}

/** decrypt: the integrity check first (timing-safe); a wrong key or a changed byte -> 'integrity'. */
export function decrypt(etype, key, usage, data) {
  if (!SUPPORTED_ETYPES.includes(etype)) fail('etype', `${etypeName(etype)} is not supported: only AES (17, 18).`)
  if (key.length !== KEY_BYTES[etype]) fail('etype', 'The key does not fit its encryption type.')
  if (data.length < 16 + 12) fail('bad-token', 'The encrypted part is too short.')
  const { ke, ki } = deriveKeys(key, usage)
  const p = ctsDecrypt(ke, data.subarray(0, data.length - 12))
  const mac = createHmac('sha1', ki).update(p).digest().subarray(0, 12)
  if (!timingSafeEqual(mac, data.subarray(data.length - 12))) fail('integrity', 'The ticket could not be decrypted with the key in the keytab (the wrong key, or a changed ticket).')
  return p.subarray(16)
}

// ---- keytab ----------------------------------------------------------------------------------------

/**
 * An MIT keytab (format 0x0502; 0x0501 read too). Entries: { principal ("HTTP/host@REALM"), realm,
 * components, nameType, timestamp, kvno, etype, key }. Deleted holes (negative sizes) are skipped.
 * Throws KerberosError('keytab', plain message).
 */
export function parseKeytab(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2 || buf[0] !== 0x05 || (buf[1] !== 0x02 && buf[1] !== 0x01)) fail('keytab', 'This is not a keytab file (it should start with the bytes 05 02).')
  const v1 = buf[1] === 0x01
  const entries = []
  let p = 2
  const at = (n) => (p + n <= buf.length ? true : fail('keytab', 'The keytab file is cut short.'))
  while (p < buf.length) {
    if (buf.length - p < 4) break
    const size = buf.readInt32BE(p)
    p += 4
    if (size === 0) break
    if (size < 0) {
      p += -size
      continue
    }
    at(size)
    const end = p + size
    const e = buf.subarray(p, end)
    let q = 0
    const u16 = () => (q + 2 <= e.length ? ((q += 2), e.readUInt16BE(q - 2)) : fail('keytab', 'A keytab entry is cut short.'))
    const u32 = () => (q + 4 <= e.length ? ((q += 4), e.readUInt32BE(q - 4)) : fail('keytab', 'A keytab entry is cut short.'))
    const bytes = () => {
      const n = u16()
      if (q + n > e.length) fail('keytab', 'A keytab entry is cut short.')
      q += n
      return e.subarray(q - n, q)
    }
    let count = u16()
    if (v1) count -= 1
    if (count < 1 || count > 16) fail('keytab', 'A keytab entry has a strange principal name.')
    const realm = bytes().toString('utf8')
    const components = []
    for (let i = 0; i < count; i++) components.push(bytes().toString('utf8'))
    const nameType = v1 ? 1 : u32()
    const timestamp = u32()
    const vno8 = q < e.length ? e[q++] : fail('keytab', 'A keytab entry is cut short.')
    const etype = u16()
    const key = Buffer.from(bytes())
    const vno32 = e.length - q >= 4 ? u32() : 0
    entries.push({ principal: `${components.join('/')}@${realm}`, realm, components, nameType, timestamp: timestamp * 1000, kvno: vno32 || vno8, etype, key })
    p = end
  }
  if (!entries.length) fail('keytab', 'The keytab file has no keys in it.')
  return entries
}

/** What the page may see of a keytab: never the keys. */
export const describeKeytab = (entries) =>
  entries.map((e) => ({ principal: e.principal, kvno: e.kvno, etype: e.etype, etypeName: etypeName(e.etype), usable: SUPPORTED_ETYPES.includes(e.etype) && e.key.length === KEY_BYTES[e.etype] }))

/** A keytab file built from entries (for the tests, and nothing else). */
export function buildKeytab(entries) {
  const parts = [Buffer.from([0x05, 0x02])]
  for (const en of entries) {
    const [name, realm] = en.principal.split('@')
    const cs = (s) => {
      const b = Buffer.from(s, 'utf8')
      const l = Buffer.alloc(2)
      l.writeUInt16BE(b.length)
      return Buffer.concat([l, b])
    }
    const comps = name.split('/')
    const u16 = (n) => Buffer.from([n >> 8, n & 0xff])
    const u32 = (n) => {
      const b = Buffer.alloc(4)
      b.writeUInt32BE(n >>> 0)
      return b
    }
    const body = Buffer.concat([u16(comps.length), cs(realm), ...comps.map(cs), u32(en.nameType ?? 1), u32(Math.floor((en.timestamp ?? 0) / 1000)), Buffer.from([en.kvno & 0xff]), u16(en.etype), u16(en.key.length), en.key, u32(en.kvno)])
    const size = Buffer.alloc(4)
    size.writeInt32BE(body.length)
    parts.push(size, body)
  }
  return Buffer.concat(parts)
}

// ---- SPNEGO / GSS-API ------------------------------------------------------------------------------

const KRB5_OIDS = new Set([OID.krb5, OID.msKrb5])

/**
 * `Authorization: Negotiate <base64>` token -> { apReq (Buffer, DER), mech (the OID the client used),
 * spnego (whether it came wrapped in SPNEGO) }. An NTLM token -> KerberosError('ntlm'): the browser had
 * no Kerberos ticket for this server (not on the domain, the name not in the Local intranet zone, the
 * SPN missing, or the address typed as an IP).
 */
export function unwrapNegotiate(token) {
  if (!token?.length) fail('bad-token', 'The Negotiate token is empty.')
  if (token.subarray(0, 8).toString('latin1') === 'NTLMSSP\0') fail('ntlm', 'The browser offered NTLM, not Kerberos: it has no Kerberos ticket for this server.')
  const outer = derRead(token, 0)
  if (outer.end !== token.length) fail('bad-token', 'The token has bytes after its end.')
  if (outer.cls === 2 && outer.tag === 1) fail('bad-token', 'A SPNEGO continuation was sent where the first token was expected.')
  if (outer.cls !== 1 || outer.tag !== 0 || !outer.constructed) fail('bad-token', 'The token is not a GSS-API token.')
  const oidEl = derRead(outer.body, 0)
  const mech = derOid(oidEl)
  const rest = outer.body.subarray(oidEl.end)
  if (KRB5_OIDS.has(mech)) return { apReq: krb5Inner(rest), mech, spnego: false }
  if (mech !== OID.spnego) fail('bad-token', `The token is for an unknown mechanism (${mech}).`)
  const choice = derRead(rest, 0)
  if (choice.cls !== 2 || choice.tag !== 0) fail('bad-token', 'The SPNEGO token is not a NegTokenInit.')
  const init = fields(derChildren(choice.body)[0], 'NegTokenInit')
  const types = need(init, 0, 'NegTokenInit')
  const mechs = derChildren(types.body).map(derOid)
  const tokenEl = init.get(2)
  // the optimistic token is always for the first mechanism the client lists
  if (!mechs.length) fail('bad-token', 'The SPNEGO token lists no mechanism.')
  if (!KRB5_OIDS.has(mechs[0])) {
    if (mechs[0] === OID.ntlm) fail('ntlm', 'The browser offered NTLM, not Kerberos: it has no Kerberos ticket for this server.')
    fail('no-kerberos', `The browser's first choice is not Kerberos (${mechs[0]}).`)
  }
  if (!tokenEl) fail('no-kerberos', 'The browser sent no Kerberos ticket.')
  const inner = derOctets(tokenEl, 'The mech token')
  const g = derRead(inner, 0)
  if (g.cls !== 1 || g.tag !== 0) fail('bad-token', 'The Kerberos token is not GSS-API framed.')
  const innerOid = derRead(g.body, 0)
  if (!KRB5_OIDS.has(derOid(innerOid))) fail('bad-token', 'The mech token is not a Kerberos token.')
  return { apReq: krb5Inner(g.body.subarray(innerOid.end)), mech: mechs[0], spnego: true }
}

/** After the krb5 OID: TOK_ID 01 00 (AP-REQ), then the AP-REQ. */
function krb5Inner(b) {
  if (b.length < 3) fail('bad-token', 'The Kerberos token is too short.')
  if (b[0] !== 0x01 || b[1] !== 0x00) fail('bad-token', 'The Kerberos token is not an AP-REQ.')
  const ap = b.subarray(2)
  const el = derRead(ap, 0)
  return ap.subarray(0, el.end)
}

// ---- Kerberos messages -----------------------------------------------------------------------------

function principal(el) {
  const f = fields(el, 'PrincipalName')
  return { type: derInt(need(f, 0, 'PrincipalName')), names: derChildren(need(f, 1, 'PrincipalName').body).map(derStr) }
}
function encData(el) {
  const f = fields(el, 'EncryptedData')
  return { etype: derInt(need(f, 0, 'EncryptedData')), kvno: f.has(1) ? derInt(f.get(1)) : null, cipher: derOctets(need(f, 2, 'EncryptedData')) }
}

/** AP-REQ (RFC 4120 5.5.1) -> { mutual, ticket: { realm, sname, enc }, authenticator: enc }. */
export function parseApReq(buf) {
  const outer = derRead(buf, 0)
  if (outer.cls === 1 && outer.tag === 30) fail('bad-token', 'The browser sent a Kerberos error, not a ticket.')
  const f = fields(app(outer, 14, 'AP-REQ'), 'AP-REQ')
  if (derInt(need(f, 0, 'AP-REQ')) !== 5 || derInt(need(f, 1, 'AP-REQ')) !== 14) fail('bad-token', 'Not a Kerberos 5 AP-REQ.')
  const options = need(f, 2, 'AP-REQ')
  const t = fields(app(need(f, 3, 'AP-REQ'), 1, 'Ticket'), 'Ticket')
  if (derInt(need(t, 0, 'Ticket')) !== 5) fail('bad-token', 'Not a Kerberos 5 ticket.')
  return {
    useSessionKey: bit(options, 1),
    mutual: bit(options, 2),
    ticket: { realm: derStr(need(t, 1, 'Ticket')), sname: principal(need(t, 2, 'Ticket')), enc: encData(need(t, 3, 'Ticket')) },
    authenticator: encData(need(f, 4, 'AP-REQ'))
  }
}

function parseEncTicketPart(buf) {
  const f = fields(app(derRead(buf, 0), 3, 'EncTicketPart'), 'EncTicketPart')
  const k = fields(need(f, 1, 'EncTicketPart'), 'EncryptionKey')
  const authtime = derTime(need(f, 5, 'EncTicketPart'))
  return {
    invalid: bit(need(f, 0, 'EncTicketPart'), 7),
    key: { etype: derInt(need(k, 0, 'EncryptionKey')), value: Buffer.from(derOctets(need(k, 1, 'EncryptionKey'))) },
    crealm: derStr(need(f, 2, 'EncTicketPart')),
    cname: principal(need(f, 3, 'EncTicketPart')),
    authtime,
    starttime: f.has(6) ? derTime(f.get(6)) : authtime,
    endtime: derTime(need(f, 7, 'EncTicketPart'))
  }
}

function parseAuthenticator(buf) {
  const f = fields(app(derRead(buf, 0), 2, 'Authenticator'), 'Authenticator')
  if (derInt(need(f, 0, 'Authenticator')) !== 5) fail('bad-token', 'Not a Kerberos 5 authenticator.')
  return {
    crealm: derStr(need(f, 1, 'Authenticator')),
    cname: principal(need(f, 2, 'Authenticator')),
    cusec: derInt(need(f, 4, 'Authenticator')),
    ctime: derTime(need(f, 5, 'Authenticator')),
    seq: f.has(7) ? derInt(f.get(7)) : null
  }
}

/** Remembers authenticators seen within the skew window; refuses one seen again. Bounded. */
export function makeReplayCache({ windowMs = MAX_SKEW_MS, max = 20_000 } = {}) {
  const seen = new Map() // key -> forget-after (ms)
  return {
    /** true when new (and now remembered), false when a replay */
    check(key, now) {
      for (const [k, until] of seen) {
        if (until > now) break // insertion order is roughly time order: stop at the first live one
        seen.delete(k)
      }
      if (seen.has(key) && seen.get(key) > now) return false
      if (seen.size >= max) seen.delete(seen.keys().next().value)
      seen.set(key, now + 2 * windowMs)
      return true
    },
    get size() {
      return seen.size
    }
  }
}

/**
 * Checks an AP-REQ against the keytab's keys. Throws KerberosError(code, message); returns
 * { user, realm, principal, etype, kvno, kvnoMatched, sessionKey, ctime, cusec, seq, mutual }.
 * @param {{ keys: ReturnType<typeof parseKeytab>, realm: string, service: string[] (e.g. ['HTTP','cctv.jfl.gripe']),
 *   now?: number, replay: ReturnType<typeof makeReplayCache>, skewMs?: number }} o
 */
export function acceptApReq(apReqBuf, { keys, realm, service, now = Date.now(), replay, skewMs = MAX_SKEW_MS }) {
  const ap = parseApReq(apReqBuf)
  const R = String(realm).toUpperCase()
  if (ap.useSessionKey) fail('bad-token', 'User-to-user tickets are not accepted.')
  if (ap.ticket.realm.toUpperCase() !== R) fail('wrong-realm', `The ticket is for the realm ${ap.ticket.realm}, not ${R}.`)
  const sname = ap.ticket.sname.names
  if (sname.length !== service.length || sname.some((n, i) => n.toLowerCase() !== service[i].toLowerCase())) fail('wrong-service', `The ticket is for ${sname.join('/')}, not ${service.join('/')}.`)
  const { etype, kvno, cipher } = ap.ticket.enc
  if (!SUPPORTED_ETYPES.includes(etype)) fail('etype', `The ticket is encrypted with ${etypeName(etype)}; only AES is accepted. Set the service account to AES only (msDS-SupportedEncryptionTypes = 24) and make the keytab again.`)
  const want = service.join('/').toLowerCase()
  const mine = keys.filter((k) => k.etype === etype && k.realm.toUpperCase() === R && k.components.join('/').toLowerCase() === want)
  if (!mine.length) fail('no-key', `The keytab has no ${etypeName(etype)} key for ${service.join('/')}@${R}.`)
  // the key of the ticket's kvno first; the others too (ktpass has written a wrong kvno before)
  const ordered = [...mine.filter((k) => kvno === null || k.kvno === kvno), ...mine.filter((k) => kvno !== null && k.kvno !== kvno)]
  let plain = null
  let used = null
  for (const k of ordered) {
    try {
      plain = decrypt(etype, k.key, 2, cipher)
      used = k
      break
    } catch (e) {
      if (e.code !== 'integrity') throw e
    }
  }
  if (!plain) {
    const have = [...new Set(mine.map((k) => k.kvno))].join(', ')
    fail('integrity', `The ticket could not be decrypted with the keytab (ticket key version ${kvno ?? '?'}, keytab has ${have}). The service account's password was changed after the keytab was made: make it again.`)
  }
  const tkt = parseEncTicketPart(plain)
  if (tkt.invalid) fail('ticket-invalid', 'The ticket is marked invalid.')
  if (tkt.starttime - skewMs > now) fail('ticket-not-yet', 'The ticket is not valid yet (check the server clock).')
  if (tkt.endtime + skewMs < now) fail('ticket-expired', 'The ticket has expired.')
  if (tkt.crealm.toUpperCase() !== R) fail('wrong-realm', `The user is from the realm ${tkt.crealm}, not ${R}.`)
  if (!SUPPORTED_ETYPES.includes(tkt.key.etype)) fail('etype', `The session key is ${etypeName(tkt.key.etype)}; only AES is accepted.`)
  const auth = parseAuthenticator(decrypt(tkt.key.etype, tkt.key.value, 11, ap.authenticator.cipher))
  const same = (a, b) => a.names.length === b.names.length && a.names.every((n, i) => n === b.names[i])
  if (auth.crealm.toUpperCase() !== tkt.crealm.toUpperCase() || !same(auth.cname, tkt.cname)) fail('name-mismatch', 'The authenticator is not from the person the ticket was issued to.')
  if (Math.abs(auth.ctime - now) > skewMs) fail('skew', `The PC's clock and the server's differ by more than ${Math.round(skewMs / 60_000)} minutes.`)
  const who = `${tkt.cname.names.join('/')}@${tkt.crealm.toUpperCase()}`
  if (replay && !replay.check(`${who}|${auth.ctime}|${auth.cusec}`, now)) fail('replay', 'This sign-in token was used before (a replay).')
  if (tkt.cname.names.length !== 1) fail('not-a-user', `${who} is not a user name.`)
  return { user: tkt.cname.names[0], realm: tkt.crealm.toUpperCase(), principal: who, etype, kvno: used.kvno, kvnoMatched: kvno === null || used.kvno === kvno, sessionKey: tkt.key, ctime: auth.ctime, cusec: auth.cusec, seq: auth.seq, mutual: ap.mutual }
}

/**
 * The answer for mutual authentication: AP-REP (RFC 4120 5.5.2; EncAPRepPart under key usage 12),
 * GSS-framed (TOK_ID 02 00) and, when the client used SPNEGO, in a NegTokenResp accept-completed.
 */
export function buildApRepToken(accepted, { spnego = true, mech = OID.msKrb5 } = {}) {
  const enc = der.app(27, der.seq(der.ctx(0, der.time(accepted.ctime)), der.ctx(1, der.int(accepted.cusec)), ...(accepted.seq !== null && accepted.seq !== undefined ? [der.ctx(3, der.int(accepted.seq))] : [])))
  const apRep = der.app(15, der.seq(der.ctx(0, der.int(5)), der.ctx(1, der.int(15)), der.ctx(2, der.seq(der.ctx(0, der.int(accepted.sessionKey.etype)), der.ctx(2, der.octets(encrypt(accepted.sessionKey.etype, accepted.sessionKey.value, 12, enc)))))))
  const gss = der.app(0, Buffer.concat([der.oid(OID.krb5), Buffer.from([0x02, 0x00]), apRep]))
  if (!spnego) return gss
  return der.ctx(1, der.seq(der.ctx(0, der.enumerated(0)), der.ctx(1, der.oid(mech)), der.ctx(2, der.octets(gss))))
}

// ---- for the tests: what a KDC and a browser would make ----------------------------------------------

/**
 * A ticket and AP-REQ as Windows would send them, made with a service key (tests only).
 * @returns {Buffer} the `Negotiate` token (SPNEGO NegTokenInit, mech MS-KRB5)
 */
export function makeTestToken({ serviceKey, etype = 18, kvno = 2, realm = 'JFL.LOCAL', service = ['HTTP', 'cctv.jfl.gripe'], user = 'bob', crealm = realm, authUser = user, now = Date.now(), ctime = now, cusec = 123456, start = now - 60_000, end = now + 10 * 3_600_000, invalid = false, mutual = false, sessionEtype = etype, mechs = [OID.msKrb5, OID.krb5, OID.ntlm], spnego = true }) {
  const sessionKey = randomBytes(KEY_BYTES[sessionEtype] ?? 32)
  const flags = Buffer.from([0x40 | (invalid ? 0x01 : 0x00), 0xa0, 0x00, 0x00]) // forwardable (1), (invalid (7)), renewable (8), pre-authent (10)
  const encTicketPart = der.app(3, der.seq(der.ctx(0, der.bits(flags)), der.ctx(1, der.seq(der.ctx(0, der.int(sessionEtype)), der.ctx(1, der.octets(sessionKey)))), der.ctx(2, der.str(crealm)), der.ctx(3, der.principal(1, user.split('/'))), der.ctx(4, der.seq(der.ctx(0, der.int(1)), der.ctx(1, der.octets(Buffer.alloc(0))))), der.ctx(5, der.time(start)), der.ctx(6, der.time(start)), der.ctx(7, der.time(end))))
  const ticket = der.app(1, der.seq(der.ctx(0, der.int(5)), der.ctx(1, der.str(realm)), der.ctx(2, der.principal(2, service)), der.ctx(3, der.seq(der.ctx(0, der.int(etype)), der.ctx(1, der.int(kvno)), der.ctx(2, der.octets(encrypt(etype, serviceKey, 2, encTicketPart)))))))
  const authenticator = der.app(2, der.seq(der.ctx(0, der.int(5)), der.ctx(1, der.str(crealm)), der.ctx(2, der.principal(1, authUser.split('/'))), der.ctx(4, der.int(cusec)), der.ctx(5, der.time(ctime)), der.ctx(7, der.int(77))))
  const apReq = der.app(14, der.seq(der.ctx(0, der.int(5)), der.ctx(1, der.int(14)), der.ctx(2, der.bits([mutual ? 0x20 : 0x00, 0, 0, 0])), der.ctx(3, ticket), der.ctx(4, der.seq(der.ctx(0, der.int(sessionEtype)), der.ctx(2, der.octets(encrypt(sessionEtype, sessionKey, 11, authenticator)))))))
  const gss = der.app(0, Buffer.concat([der.oid(OID.krb5), Buffer.from([0x01, 0x00]), apReq]))
  if (!spnego) return gss
  return der.app(0, Buffer.concat([der.oid(OID.spnego), der.ctx(0, der.seq(der.ctx(0, der.seq(...mechs.map(der.oid))), der.ctx(2, der.octets(gss))))]))
}
