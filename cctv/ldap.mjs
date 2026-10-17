// A small LDAPv3 client, just what Active Directory sign-in needs (ad.mjs), on node:tls with no
// npm dependency (the release ships its own node_modules and nothing is added to them).
//
// What it speaks: a simple BindRequest (name + password), a SearchRequest (base, scope, size and
// time limits, the attributes wanted, and a filter of AND / OR / NOT / equality / presence /
// extensible match), and UnbindRequest. What it reads: BindResponse, SearchResultEntry,
// SearchResultReference, SearchResultDone, and the server's "notice of disconnection". Every
// LDAPResult comes back with its code, its name and the server's diagnostic message, and Active
// Directory's sub-code from that message ("... data 52e, v4563": wrong password; 533 disabled; 701
// expired; 773 must change password; 775 locked) is read out of it (adSubCode).
//
// One connection per sign-in: open, bind, search, unbind, close. Every step has a timeout.
//
// TLS: ldapOpen never sends a byte to a server whose certificate it has not accepted: either its
// SHA-256 fingerprint equals the one an admin pinned for it, or it chains to the CA certificate an
// admin pasted AND names the host it was reached at. There is no "accept anything" mode; plain TCP
// (transport 'tcp') exists for the protocol tests only, and ad.mjs never asks for it.
//
// Filters are strings in the RFC 4515 form, "(&(objectClass=user)(sAMAccountName=bob))", parsed
// here into BER. A value from a person (a typed user name) goes in through escapeFilterValue, so
// "*", "(", ")", "\" and NUL in it are data, never filter syntax: no LDAP injection.

import net from 'node:net'
import tls from 'node:tls'
import { X509Certificate } from 'node:crypto'

// ---- BER (the subset of ASN.1 Basic Encoding Rules LDAP uses) ------------------------------------

export const TAG = Object.freeze({
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  ENUMERATED: 0x0a,
  SEQUENCE: 0x30,
  SET: 0x31,
  // LDAP protocol operations ([APPLICATION n])
  BIND_REQUEST: 0x60,
  BIND_RESPONSE: 0x61,
  UNBIND_REQUEST: 0x42,
  SEARCH_REQUEST: 0x63,
  SEARCH_ENTRY: 0x64,
  SEARCH_DONE: 0x65,
  SEARCH_REFERENCE: 0x73,
  MODIFY_REQUEST: 0x66,
  MODIFY_RESPONSE: 0x67,
  EXTENDED_RESPONSE: 0x78
})

/** A length in BER: short form under 128, else 0x8n and n big-endian bytes. */
export function berLength(n) {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

/** One TLV: tag, length, value (value a Buffer or a list of Buffers to concatenate). */
export function tlv(tag, value) {
  const v = Array.isArray(value) ? Buffer.concat(value) : value
  return Buffer.concat([Buffer.from([tag]), berLength(v.length), v])
}

/** Two's-complement, fewest bytes. */
export function berIntegerBytes(n) {
  if (!Number.isSafeInteger(n)) throw new RangeError(`not an integer: ${n}`)
  const bytes = []
  let v = n
  do {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  } while (!(v === 0 && (bytes[0] & 0x80) === 0) && !(v === -1 && (bytes[0] & 0x80) !== 0))
  return Buffer.from(bytes)
}
export const berInteger = (n, tag = TAG.INTEGER) => tlv(tag, berIntegerBytes(n))
export const berString = (s, tag = TAG.OCTET_STRING) => tlv(tag, Buffer.from(String(s), 'utf8'))
export const berBoolean = (b, tag = TAG.BOOLEAN) => tlv(tag, Buffer.from([b ? 0xff : 0x00]))
export const berSequence = (items, tag = TAG.SEQUENCE) => tlv(tag, items)

/**
 * Reads the TLV at `offset`. @returns {{ tag: number, start: number, end: number, next: number }|null}
 * null while the buffer does not yet hold all of it (a message arriving in pieces).
 * Throws on what no BER encoder writes (indefinite length, a length over 4 bytes).
 */
export function readTlv(buf, offset = 0) {
  if (offset + 2 > buf.length) return null
  const tag = buf[offset]
  if ((tag & 0x1f) === 0x1f) throw new Error('BER: multi-byte tags are not used by LDAP')
  let len = buf[offset + 1]
  let start = offset + 2
  if (len & 0x80) {
    const n = len & 0x7f
    if (n === 0) throw new Error('BER: indefinite length is not allowed in LDAP')
    if (n > 4) throw new Error('BER: length too long')
    if (start + n > buf.length) return null
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i]
    start += n
  }
  const end = start + len
  if (end > buf.length) return null
  return { tag, start, end, next: end }
}

/** The TLVs inside a constructed value, in order. Throws if one runs past its parent. */
export function children(buf, { start, end }) {
  const out = []
  let at = start
  while (at < end) {
    const t = readTlv(buf.subarray(0, end), at)
    if (!t) throw new Error('BER: truncated element')
    out.push(t)
    at = t.next
  }
  return out
}

export function readInteger(buf, { start, end }) {
  if (end <= start) throw new Error('BER: empty integer')
  if (end - start > 6) throw new Error('BER: integer too large')
  let v = buf[start] & 0x80 ? -1 : 0
  for (let i = start; i < end; i++) v = v * 256 + buf[i]
  return v
}
export const readString = (buf, { start, end }) => buf.toString('utf8', start, end)

// ---- filters (RFC 4515 strings -> BER) ---------------------------------------------------------

/**
 * A value made safe to put in a filter string: "*", "(", ")", "\" and NUL become \2a \28 \29 \5c \00
 * (RFC 4515 section 3). Everything a person types goes in through this.
 */
export function escapeFilterValue(value) {
  return String(value).replace(/[*()\\\u0000]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/** Bytes (a binary value such as an objectGUID) as filter text: every byte \hh. */
export const escapeFilterBytes = (buf) => [...buf].map((b) => `\\${b.toString(16).padStart(2, '0')}`).join('')

const unescapeValue = (s) => {
  const bytes = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      const hex = s.slice(i + 1, i + 3)
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error('filter: a backslash must be followed by two hex digits')
      bytes.push(parseInt(hex, 16))
      i += 2
    } else if (c === '*' || c === '(' || c === ')' || c === '\u0000') {
      // an unescaped "*" in a value would be a substring filter; this client has no need of one, so a
      // stray one is an error, never a wildcard
      throw new Error(`filter: unescaped "${c}" in a value`)
    } else {
      bytes.push(...Buffer.from(c, 'utf8'))
    }
  }
  return Buffer.from(bytes)
}

const ATTR_RE = /^(?:[A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)*)(?:;[A-Za-z0-9-]+)*$/
const OID_RE = /^(?:\d+(?:\.\d+)*|[A-Za-z][A-Za-z0-9-]*)$/

/**
 * Parses an RFC 4515 filter string into a tree: { and: [...] } | { or: [...] } | { not: f } |
 * { eq: [attr, Buffer] } | { present: attr } | { ext: { rule, attr, value: Buffer, dn } }.
 */
export function parseFilter(text) {
  const s = String(text).trim()
  let i = 0
  const filter = () => {
    if (s[i] !== '(') throw new Error(`filter: expected "(" at ${i}`)
    i++
    let f
    if (s[i] === '&' || s[i] === '|') {
      const op = s[i++] === '&' ? 'and' : 'or'
      const list = []
      while (s[i] === '(') list.push(filter())
      if (!list.length) throw new Error(`filter: empty ${op}`)
      f = { [op]: list }
    } else if (s[i] === '!') {
      i++
      f = { not: filter() }
    } else {
      // an item: up to the closing ")" that is not escaped (a value cannot hold a raw ")")
      const close = s.indexOf(')', i)
      if (close < 0) throw new Error('filter: missing ")"')
      f = item(s.slice(i, close))
      i = close
    }
    if (s[i] !== ')') throw new Error(`filter: expected ")" at ${i}`)
    i++
    return f
  }
  const item = (body) => {
    const eq = body.indexOf('=')
    if (eq <= 0) throw new Error('filter: an item needs attribute=value')
    const left = body.slice(0, eq)
    const right = body.slice(eq + 1)
    if (left.endsWith(':')) {
      // extensible: attr[:dn][:rule]:=value
      const parts = left.slice(0, -1).split(':')
      const attr = parts.shift()
      let dn = false
      let rule
      for (const p of parts) {
        if (p.toLowerCase() === 'dn') dn = true
        else if (OID_RE.test(p) && rule === undefined) rule = p
        else throw new Error(`filter: bad extensible match "${left}"`)
      }
      if (attr && !ATTR_RE.test(attr)) throw new Error(`filter: bad attribute "${attr}"`)
      if (!attr && !rule) throw new Error('filter: an extensible match needs an attribute or a rule')
      return { ext: { rule, attr: attr || undefined, value: unescapeValue(right), dn } }
    }
    if (/[<>~]$/.test(left)) throw new Error('filter: only = and := are supported')
    if (!ATTR_RE.test(left)) throw new Error(`filter: bad attribute "${left}"`)
    if (right === '*') return { present: left }
    return { eq: [left, unescapeValue(right)] }
  }
  const f = filter()
  if (i !== s.length) throw new Error('filter: text after the end')
  return f
}

/** A filter tree (parseFilter) as BER. */
export function encodeFilter(f) {
  if (typeof f === 'string') f = parseFilter(f)
  if (f.and) return tlv(0xa0, f.and.map(encodeFilter))
  if (f.or) return tlv(0xa1, f.or.map(encodeFilter))
  if (f.not) return tlv(0xa2, encodeFilter(f.not))
  if (f.eq) return tlv(0xa3, [berString(f.eq[0]), tlv(TAG.OCTET_STRING, f.eq[1])])
  if (f.present) return berString(f.present, 0x87)
  if (f.ext) {
    const parts = []
    if (f.ext.rule) parts.push(berString(f.ext.rule, 0x81))
    if (f.ext.attr) parts.push(berString(f.ext.attr, 0x82))
    parts.push(tlv(0x83, f.ext.value))
    if (f.ext.dn) parts.push(berBoolean(true, 0x84))
    return tlv(0xa9, parts)
  }
  throw new Error('filter: unknown node')
}

// ---- requests ------------------------------------------------------------------------------------

const message = (id, op) => berSequence([berInteger(id), op])

/** BindRequest, simple authentication. An empty password is refused here: to AD that is an
 * "unauthenticated bind", which SUCCEEDS without checking anything (RFC 4513 5.1.2). */
export function encodeBind(id, name, password) {
  if (typeof password !== 'string' || password === '') throw new Error('An empty password is never sent')
  return message(id, berSequence([berInteger(3), berString(name), berString(password, 0x80)], TAG.BIND_REQUEST))
}

export const SCOPE = Object.freeze({ base: 0, one: 1, sub: 2 })

/**
 * SearchRequest. @param {{ base: string, scope?: 'base'|'one'|'sub', filter: string|object,
 * attributes?: string[], sizeLimit?: number, timeLimit?: number }} o (timeLimit in seconds)
 */
export function encodeSearch(id, { base, scope = 'sub', filter, attributes = [], sizeLimit = 0, timeLimit = 0, typesOnly = false }) {
  if (!(scope in SCOPE)) throw new Error(`bad scope ${scope}`)
  return message(
    id,
    berSequence(
      [
        berString(base),
        berInteger(SCOPE[scope], TAG.ENUMERATED),
        berInteger(0, TAG.ENUMERATED), // derefAliases: never
        berInteger(sizeLimit),
        berInteger(timeLimit),
        berBoolean(typesOnly),
        encodeFilter(filter),
        berSequence(attributes.map((a) => berString(a)))
      ],
      TAG.SEARCH_REQUEST
    )
  )
}

export const encodeUnbind = (id) => message(id, Buffer.from([TAG.UNBIND_REQUEST, 0x00]))

export const MOD_OP = Object.freeze({ add: 0, delete: 1, replace: 2 })

/**
 * ModifyRequest. @param {string} dn @param {{ op: 'add'|'delete'|'replace', type: string, values: (string|Buffer)[] }[]} changes
 */
export function encodeModify(id, dn, changes) {
  if (!changes.length) throw new Error('a modify needs at least one change')
  return message(
    id,
    berSequence(
      [
        berString(dn),
        berSequence(
          changes.map((c) => {
            if (!(c.op in MOD_OP)) throw new Error(`bad modify operation ${c.op}`)
            return berSequence([berInteger(MOD_OP[c.op], TAG.ENUMERATED), berSequence([berString(c.type), tlv(TAG.SET, c.values.map((v) => tlv(TAG.OCTET_STRING, Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8'))))])])
          })
        )
      ],
      TAG.MODIFY_REQUEST
    )
  )
}

/** AD's unicodePwd value: the password in double quotes, UTF-16LE (MS-ADTS 3.1.1.3.1.5). */
export const unicodePwd = (password) => Buffer.from(`"${password}"`, 'utf16le')

/** AD's objectGUID bytes as the usual text form (the first three parts are little-endian). */
export function guidToString(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 16) return null
  const h = (a) => a.map((i) => buf[i].toString(16).padStart(2, '0')).join('')
  return `${h([3, 2, 1, 0])}-${h([5, 4])}-${h([7, 6])}-${h([8, 9])}-${h([10, 11, 12, 13, 14, 15])}`
}

// ---- responses -----------------------------------------------------------------------------------

export const RESULT_NAMES = Object.freeze({
  0: 'success',
  1: 'operationsError',
  2: 'protocolError',
  3: 'timeLimitExceeded',
  4: 'sizeLimitExceeded',
  7: 'authMethodNotSupported',
  8: 'strongerAuthRequired',
  10: 'referral',
  11: 'adminLimitExceeded',
  13: 'confidentialityRequired',
  16: 'noSuchAttribute',
  19: 'constraintViolation',
  14: 'saslBindInProgress',
  32: 'noSuchObject',
  34: 'invalidDNSyntax',
  48: 'inappropriateAuthentication',
  49: 'invalidCredentials',
  50: 'insufficientAccessRights',
  51: 'busy',
  52: 'unavailable',
  53: 'unwillingToPerform',
  80: 'other'
})

/** AD's reason inside a failed bind's diagnostic message ("..., data 775, v4563" -> '775'), or null. */
export function adSubCode(diagnostic) {
  const m = /\bdata\s+([0-9a-f]{3,8})\b/i.exec(String(diagnostic ?? ''))
  return m ? m[1].toLowerCase() : null
}

/** What each AD sub-code means (the ones a person signing in can meet). */
export const AD_SUB_CODES = Object.freeze({
  525: 'no-such-user',
  '52e': 'wrong-password',
  530: 'time-restricted',
  531: 'workstation-restricted',
  532: 'password-expired',
  533: 'disabled',
  568: 'too-many-sids',
  701: 'account-expired',
  773: 'must-change-password',
  775: 'locked'
})

const readResult = (buf, items) => {
  const code = readInteger(buf, items[0])
  const result = { code, name: RESULT_NAMES[code] ?? `code${code}`, matchedDN: readString(buf, items[1]), message: readString(buf, items[2]) }
  const sub = adSubCode(result.message)
  if (sub) {
    result.adCode = sub
    result.adReason = AD_SUB_CODES[sub] ?? null
  }
  return result
}

/**
 * One whole LDAPMessage (its TLV at 0 of buf) as { id, type, ... }:
 *   bind:      { result }
 *   entry:     { dn, attributes: { lowercased name: string[] } }
 *   reference: { uris }
 *   done:      { result }
 *   notice:    { result, oid }   (AD's notice of disconnection, id 0)
 *   other:     { tag }
 */
export function decodeMessage(buf) {
  const top = readTlv(buf, 0)
  if (!top || top.tag !== TAG.SEQUENCE) throw new Error('LDAP: a message must be a SEQUENCE')
  const [idT, opT] = children(buf, top)
  if (!idT || !opT || idT.tag !== TAG.INTEGER) throw new Error('LDAP: bad message')
  const id = readInteger(buf, idT)
  switch (opT.tag) {
    case TAG.MODIFY_RESPONSE:
      return { id, type: 'modify', result: readResult(buf, children(buf, opT)) }
    case TAG.BIND_RESPONSE:
      return { id, type: 'bind', result: readResult(buf, children(buf, opT)) }
    case TAG.SEARCH_DONE:
      return { id, type: 'done', result: readResult(buf, children(buf, opT)) }
    case TAG.SEARCH_ENTRY: {
      const [dnT, attrsT] = children(buf, opT)
      const attributes = {}
      const raw = {} // the same values as bytes, for binary ones (objectGUID)
      for (const a of attrsT ? children(buf, attrsT) : []) {
        const [typeT, valsT] = children(buf, a)
        const name = readString(buf, typeT).toLowerCase()
        const vals = valsT ? children(buf, valsT) : []
        attributes[name] = vals.map((v) => readString(buf, v))
        raw[name] = vals.map((v) => Buffer.from(buf.subarray(v.start, v.end)))
      }
      return { id, type: 'entry', dn: readString(buf, dnT), attributes, raw }
    }
    case TAG.SEARCH_REFERENCE:
      return { id, type: 'reference', uris: children(buf, opT).map((u) => readString(buf, u)) }
    case TAG.EXTENDED_RESPONSE: {
      const items = children(buf, opT)
      const oid = items.find((t) => t.tag === 0x8a)
      return { id, type: 'notice', result: readResult(buf, items), oid: oid ? readString(buf, oid) : '' }
    }
    default:
      return { id, type: 'other', tag: opT.tag }
  }
}

const MAX_MESSAGE = 4 * 1024 * 1024

/** Splits a byte stream into whole messages. push(chunk) -> decoded messages now complete. */
export function messageReader() {
  let pending = Buffer.alloc(0)
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    const out = []
    for (;;) {
      const t = readTlv(pending, 0)
      if (!t) {
        if (pending.length > MAX_MESSAGE) throw new Error('LDAP: message too large')
        break
      }
      if (t.end > MAX_MESSAGE) throw new Error('LDAP: message too large')
      out.push(decodeMessage(pending.subarray(0, t.end)))
      pending = pending.subarray(t.end)
    }
    return out
  }
}

// ---- TLS trust -----------------------------------------------------------------------------------

/** "ab:CD:..." or "abcd..." -> "AB:CD:..." (Node's fingerprint256 form); null if not 32 bytes of hex. */
export function normaliseFingerprint(fp) {
  const hex = String(fp ?? '').replace(/[\s:]/g, '').toUpperCase()
  if (!/^[0-9A-F]{64}$/.test(hex)) return null
  return hex.match(/../g).join(':')
}

const dnText = (o) => (o && typeof o === 'object' ? Object.entries(o).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`).join(', ') : String(o ?? ''))

/** The parts of a peer certificate an admin needs to decide whether to trust it. */
export function describeCert(cert) {
  if (!cert || !cert.fingerprint256) return null
  return {
    subject: dnText(cert.subject),
    issuer: dnText(cert.issuer),
    altNames: cert.subjectaltname ?? '',
    validFrom: cert.valid_from,
    validTo: cert.valid_to,
    expired: Date.parse(cert.valid_to) < Date.now(),
    notYetValid: Date.parse(cert.valid_from) > Date.now(),
    fingerprint256: cert.fingerprint256,
    selfIssued: dnText(cert.subject) === dnText(cert.issuer)
  }
}

const isIp = (h) => net.isIP(h) !== 0

/**
 * Whether a server's certificate is to be accepted. Pure, so it is tested without a network.
 * @param {{ cert: object, authorized: boolean, authorizationError?: any, host: string,
 *   pin?: string, ca?: string }} o  authorized: Node's chain check against `ca` (only meaningful with ca)
 * @returns {{ ok: true, how: 'pin'|'ca' } | { ok: false, reason: string }}
 */
export function verifyPeer({ cert, authorized, authorizationError, host, pin, ca }) {
  if (!cert || !cert.fingerprint256) return { ok: false, reason: 'The server sent no certificate.' }
  const want = pin ? normaliseFingerprint(pin) : null
  if (want) {
    if (normaliseFingerprint(cert.fingerprint256) === want) return { ok: true, how: 'pin' }
    if (!ca) return { ok: false, reason: `The certificate of ${host} has changed since it was trusted (it is now ${cert.fingerprint256}). Check it in Settings and trust it again.` }
  }
  if (ca) {
    // Node already folds the name check into authorized when the host is an IP address
    const nameOnly = String(authorizationError?.code ?? authorizationError ?? '').includes('ALTNAME')
    const wrongName = () => ({ ok: false, reason: `The certificate of ${host} is for ${cert.subject?.CN ?? 'another name'}, not ${host}. Enter the server by that name, or trust its certificate by fingerprint.` })
    if (!authorized && nameOnly) return wrongName()
    if (!authorized) return { ok: false, reason: `The certificate of ${host} is not signed by the CA certificate you gave (${authorizationError?.code ?? authorizationError ?? 'not trusted'}).` }
    const nameErr = tls.checkServerIdentity(host, cert)
    if (nameErr) return wrongName()
    return { ok: true, how: 'ca' }
  }
  return { ok: false, reason: `No trust is set up for ${host}: check its certificate in Settings and trust it, or give the CA certificate.` }
}

/** "host" or "host:port" (port 636 by default; "[v6]:port" for IPv6). */
export function splitServer(server, defaultPort = 636) {
  const s = String(server ?? '').trim()
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s)
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : defaultPort }
  const m = /^([^:\s]+)(?::(\d+))?$/.exec(s)
  if (!m) return null
  const port = m[2] ? Number(m[2]) : defaultPort
  if (!(port >= 1 && port <= 65535)) return null
  return { host: m[1], port }
}

const caList = (ca) => {
  if (!ca) return undefined
  // a PEM bundle: each certificate on its own; X509Certificate throws on junk
  const pems = String(ca).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
  for (const p of pems) new X509Certificate(p)
  return pems.length ? pems : undefined
}

// ---- the connection ------------------------------------------------------------------------------

export class LdapError extends Error {
  /** kind: 'connect' (could not reach it), 'tls' (certificate refused), 'timeout', 'protocol', 'result' */
  constructor(kind, message, result = null) {
    super(message)
    this.kind = kind
    this.result = result
  }
}

/**
 * Opens a connection. @param {{ host: string, port?: number, transport?: 'tls'|'tcp', pin?: string,
 * ca?: string, timeoutMs?: number, peek?: boolean }} o
 *   transport 'tcp' is for tests; peek: only fetch the certificate (no trust check), then close.
 * @returns {Promise<LdapClient|{ cert: object, chain: object[], authorized: boolean, authorizationError: any }>}
 */
export function ldapOpen({ host, port = 636, transport = 'tls', pin, ca, timeoutMs = 8000, peek = false }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock?.destroy()
      reject(e)
    }
    const timer = setTimeout(() => fail(new LdapError('timeout', `${host}:${port} did not answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
    let sock
    try {
      if (transport === 'tcp') {
        sock = net.connect({ host, port })
        sock.once('connect', () => done())
      } else {
        // the chain is checked here against the admin's CA (if any) but never refused by Node itself:
        // verifyPeer decides, before anything is sent
        const cas = caList(ca)
        sock = tls.connect({ host, port, ca: cas, rejectUnauthorized: false, ...(isIp(host) ? {} : { servername: host }), minVersion: 'TLSv1.2' })
        sock.once('secureConnect', () => done())
      }
    } catch (e) {
      return fail(new LdapError('tls', `The CA certificate could not be read: ${e.message}`))
    }
    sock.once('error', (e) => fail(new LdapError('connect', `Cannot reach ${host}:${port} (${e.code ?? e.message})`)))
    const done = () => {
      if (settled) return
      if (transport !== 'tcp') {
        const cert = sock.getPeerCertificate(true)
        if (peek) {
          const chain = []
          const seen = new Set()
          for (let c = cert; c && c.fingerprint256 && !seen.has(c.fingerprint256); c = c.issuerCertificate) {
            seen.add(c.fingerprint256)
            chain.push(describeCert(c))
          }
          settled = true
          clearTimeout(timer)
          sock.end()
          sock.destroy()
          return resolve({ cert: describeCert(cert), chain, authorized: sock.authorized, authorizationError: sock.authorizationError ?? null })
        }
        const v = verifyPeer({ cert, authorized: sock.authorized, authorizationError: sock.authorizationError, host, pin, ca })
        if (!v.ok) return fail(new LdapError('tls', v.reason))
      }
      settled = true
      clearTimeout(timer)
      resolve(new LdapClient(sock, { host, timeoutMs }))
    }
  })
}

export class LdapClient {
  constructor(sock, { host, timeoutMs }) {
    this.sock = sock
    this.host = host
    this.timeoutMs = timeoutMs
    this.nextId = 1
    this.pending = new Map() // id -> { resolve, reject, entries, references, timer }
    this.closed = false
    const read = messageReader()
    sock.on('data', (chunk) => {
      let msgs
      try {
        msgs = read(chunk)
      } catch (e) {
        return this._failAll(new LdapError('protocol', e.message))
      }
      for (const m of msgs) this._dispatch(m)
    })
    sock.on('error', (e) => this._failAll(new LdapError('connect', `The connection to ${host} failed (${e.code ?? e.message})`)))
    sock.on('close', () => this._failAll(new LdapError('connect', `${host} closed the connection`)))
  }

  _dispatch(m) {
    if (m.id === 0 && m.type === 'notice') return this._failAll(new LdapError('connect', `${this.host} ended the connection: ${m.result.message || m.result.name}`, m.result))
    const p = this.pending.get(m.id)
    if (!p) return
    if (m.type === 'entry') p.entries.push({ dn: m.dn, attributes: m.attributes, raw: m.raw })
    else if (m.type === 'reference') p.references.push(...m.uris)
    else if (m.type === 'bind' || m.type === 'done' || m.type === 'modify') {
      clearTimeout(p.timer)
      this.pending.delete(m.id)
      p.resolve({ result: m.result, entries: p.entries, references: p.references })
    }
  }

  _failAll(err) {
    this.closed = true
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      this.pending.delete(id)
      p.reject(err)
    }
  }

  _send(build, what) {
    if (this.closed) return Promise.reject(new LdapError('connect', `The connection to ${this.host} is closed`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new LdapError('timeout', `${this.host} did not answer the ${what} within ${Math.round(this.timeoutMs / 1000)} s`))
        this.close()
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, entries: [], references: [], timer })
      this.sock.write(build(id))
    })
  }

  /** Simple bind. Resolves with the LDAPResult; a non-success result is an LdapError('result'). */
  async bind(name, password) {
    const { result } = await this._send((id) => encodeBind(id, name, password), 'sign-in')
    if (result.code !== 0) throw new LdapError('result', result.message || result.name, result)
    return result
  }

  /** @returns {Promise<{ entries: {dn, attributes}[], references: string[], result }>} sizeLimitExceeded counts as done */
  /** One ModifyRequest; a non-success result is an LdapError('result'). */
  async modify(dn, changes) {
    const { result } = await this._send((id) => encodeModify(id, dn, changes), 'change')
    if (result.code !== 0) throw new LdapError('result', result.message || result.name, result)
    return result
  }

  async search(opts) {
    const r = await this._send((id) => encodeSearch(id, opts), 'search')
    if (r.result.code !== 0 && r.result.code !== 4) throw new LdapError('result', r.result.message || r.result.name, r.result)
    return r
  }

  /** Says goodbye and closes; never throws. */
  close() {
    if (!this.closed) {
      try {
        this.sock.write(encodeUnbind(this.nextId++))
      } catch {}
    }
    this.closed = true
    try {
      this.sock.end()
    } catch {}
    setTimeout(() => this.sock.destroy(), 200).unref?.()
  }
}
