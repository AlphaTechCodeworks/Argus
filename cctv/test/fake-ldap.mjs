// A tiny fake Active Directory for the tests (ldap.test.mjs, ad.test.mjs): an LDAP server over plain
// TCP or TLS that answers simple binds the way AD does (result 49 with "data 52e/533/775..." in the
// message) and searches over a handful of users and groups, including nested membership through the
// LDAP_MATCHING_RULE_IN_CHAIN rule. It decodes requests with ldap.mjs's own BER reader, so a request
// it understands is one a real server can read too.
import { createHash } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'
import { TAG, berInteger, berSequence, berString, children, readInteger, readString, readTlv, tlv } from '../ldap.mjs'

export const IN_CHAIN = '1.2.840.113556.1.4.1941'

/** A made-up but stable objectGUID per name, in the usual text form. */
export const fakeGuid = (name) => {
  const h = createHash('md5').update(String(name)).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
/** The text form as AD's 16 bytes (first three parts little-endian). */
export const guidBuf = (guid) => {
  const b = Buffer.from(guid.replace(/-/g, ''), 'hex')
  return Buffer.from([b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], ...b.subarray(8)])
}

/** A BER filter (at t in buf) as the same tree parseFilter makes. */
export function decodeFilter(buf, t) {
  const kids = () => children(buf, t)
  switch (t.tag) {
    case 0xa0: return { and: kids().map((k) => decodeFilter(buf, k)) }
    case 0xa1: return { or: kids().map((k) => decodeFilter(buf, k)) }
    case 0xa2: return { not: decodeFilter(buf, kids()[0]) }
    case 0xa3: { const [a, v] = kids(); return { eq: [readString(buf, a), buf.subarray(v.start, v.end)] } }
    case 0x87: return { present: readString(buf, t) }
    case 0xa9: {
      const ext = { dn: false }
      for (const k of kids()) {
        if (k.tag === 0x81) ext.rule = readString(buf, k)
        else if (k.tag === 0x82) ext.attr = readString(buf, k)
        else if (k.tag === 0x83) ext.value = buf.subarray(k.start, k.end)
        else if (k.tag === 0x84) ext.dn = buf[k.start] !== 0
      }
      return { ext }
    }
    default: throw new Error(`fake ldap: filter tag 0x${t.tag.toString(16)}`)
  }
}

/** One request message: { id, op: 'bind'|'search'|'unbind', ... }. */
export function decodeRequest(buf) {
  const top = readTlv(buf, 0)
  const [idT, opT] = children(buf, top)
  const id = readInteger(buf, idT)
  if (opT.tag === TAG.BIND_REQUEST) {
    const [v, n, auth] = children(buf, opT)
    return { id, op: 'bind', version: readInteger(buf, v), name: readString(buf, n), authTag: auth.tag, password: readString(buf, auth) }
  }
  if (opT.tag === TAG.SEARCH_REQUEST) {
    const [base, scope, deref, size, time, typesOnly, filter, attrs] = children(buf, opT)
    return {
      id,
      op: 'search',
      base: readString(buf, base),
      scope: readInteger(buf, scope),
      deref: readInteger(buf, deref),
      sizeLimit: readInteger(buf, size),
      timeLimit: readInteger(buf, time),
      typesOnly: buf[typesOnly.start] !== 0,
      filter: decodeFilter(buf, filter),
      attributes: children(buf, attrs).map((a) => readString(buf, a))
    }
  }
  if (opT.tag === TAG.UNBIND_REQUEST) return { id, op: 'unbind' }
  if (opT.tag === TAG.MODIFY_REQUEST) {
    const [dnT, changesT] = children(buf, opT)
    const changes = children(buf, changesT).map((c) => {
      const [opE, attrT] = children(buf, c)
      const [typeT, valsT] = children(buf, attrT)
      return { op: ['add', 'delete', 'replace'][readInteger(buf, opE)], type: readString(buf, typeT), values: children(buf, valsT).map((v) => Buffer.from(buf.subarray(v.start, v.end))) }
    })
    return { id, op: 'modify', dn: readString(buf, dnT), changes }
  }
  return { id, op: 'other', tag: opT.tag }
}

export const result = (code, message = '', matched = '') => [berInteger(code, TAG.ENUMERATED), berString(matched), berString(message)]
export const adBindError = (data) => `80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data ${data}, v4563\u0000`
const msg = (id, op) => berSequence([berInteger(id), op])

/**
 * @param {{ users: Record<string, { password: string, dn: string, displayName?: string, uac?: number,
 *   upn?: string, chain?: string[], bindError?: string }>, groups: { dn: string, cn: string }[] }} dir
 *   chain: every group DN the user is in, directly or through other groups (what IN_CHAIN answers)
 */
export function fakeDirectory(dir) {
  const entries = () => [
    ...Object.entries(dir.users).map(([sam, u]) => ({
      dn: u.dn,
      attrs: { objectguid: [guidBuf(u.guid ?? fakeGuid(sam))], objectclass: ['top', 'person', 'user'], objectcategory: ['person'], samaccountname: [sam], displayname: u.displayName ? [u.displayName] : [], useraccountcontrol: [String(u.uac ?? 512)], userprincipalname: [u.upn ?? `${sam}@JFL.LOCAL`] },
      chain: (u.chain ?? []).map((d) => d.toLowerCase())
    })),
    ...dir.groups.map((g) => ({ dn: g.dn, attrs: { objectclass: ['top', 'group'], cn: [g.cn], samaccountname: [g.sam ?? g.cn] }, chain: [] }))
  ]
  const match = (f, e) => {
    if (f.and) return f.and.every((x) => match(x, e))
    if (f.or) return f.or.some((x) => match(x, e))
    if (f.not) return !match(f.not, e)
    if (f.present) return (e.attrs[f.present.toLowerCase()] ?? []).length > 0
    if (f.eq) return (e.attrs[f.eq[0].toLowerCase()] ?? []).some((v) => (Buffer.isBuffer(v) ? v.equals(f.eq[1]) : v.toLowerCase() === f.eq[1].toString('utf8').toLowerCase()))
    if (f.ext) {
      if (f.ext.rule === IN_CHAIN && f.ext.attr?.toLowerCase() === 'memberof') return e.chain.includes(f.ext.value.toString('utf8').toLowerCase())
      return false
    }
    return false
  }
  return { entries, match }
}

/**
 * Starts the fake server. @returns {Promise<{ port, requests: object[], close: () => Promise<void>, connections: number }>}
 * @param {{ tlsOptions?: { key, cert }, dir }} o
 */
export async function startFakeLdap({ tlsOptions = null, dir }) {
  const d = fakeDirectory(dir)
  const requests = []
  const state = { connections: 0 }
  const onSocket = (sock) => {
    state.connections++
    let bound = null
    let pending = Buffer.alloc(0)
    sock.on('error', () => {})
    sock.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        const t = readTlv(pending, 0)
        if (!t) break
        const req = decodeRequest(pending.subarray(0, t.end))
        pending = pending.subarray(t.end)
        requests.push(req)
        if (req.op === 'unbind') return sock.end()
        if (req.op === 'bind') {
          const sam = Object.keys(dir.users).find((s) => (dir.users[s].upn ?? `${s}@JFL.LOCAL`).toLowerCase() === req.name.toLowerCase())
          const u = sam ? dir.users[sam] : null
          if (!u) sock.write(msg(req.id, tlv(TAG.BIND_RESPONSE, result(49, adBindError('52e')))))
          else if (u.password !== req.password) sock.write(msg(req.id, tlv(TAG.BIND_RESPONSE, result(49, adBindError('52e')))))
          else if (u.bindError) sock.write(msg(req.id, tlv(TAG.BIND_RESPONSE, result(49, adBindError(u.bindError)))))
          else {
            bound = sam
            sock.write(msg(req.id, tlv(TAG.BIND_RESPONSE, result(0))))
          }
        } else if (req.op === 'modify') {
          // AD's own-password change: delete the old unicodePwd value, add the new one
          const sam = Object.keys(dir.users).find((s) => dir.users[s].dn.toLowerCase() === req.dn.toLowerCase())
          const u = sam ? dir.users[sam] : null
          const pwd = (b) => { const t = b.toString('utf16le'); return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : null }
          const del = req.changes.find((c) => c.op === 'delete' && c.type.toLowerCase() === 'unicodepwd')
          const add = req.changes.find((c) => c.op === 'add' && c.type.toLowerCase() === 'unicodepwd')
          const answer = (code, text) => sock.write(msg(req.id, tlv(TAG.MODIFY_RESPONSE, result(code, text))))
          if (!bound) answer(1, '000004DC: LdapErr: DSID-0C090A5C, comment: In order to perform this operation a successful bind must be completed on the connection., data 0, v4563')
          else if (!u) answer(32, '0000208D: NameErr: DSID-03100245, problem 2001 (NO_OBJECT), data 0')
          else if (bound !== sam && !dir.changers?.includes(bound)) answer(50, '00002098: SecErr: DSID-03150F94, problem 4003 (INSUFF_ACCESS_RIGHTS), data 0')
          else if (!del || !add || pwd(del.values[0]) !== u.password) answer(19, '00000056: AtrErr: DSID-03190F80, #1: 0: 00000056: DSID-03190F80, problem 1005 (CONSTRAINT_ATT_TYPE), data 0, Att 9005a (unicodePwd)')
          else if ((pwd(add.values[0]) ?? '').length < (dir.minLength ?? 8)) answer(19, '0000052D: Constraint violation - check_password_restrictions: the password does not meet the complexity criteria!')
          else {
            u.password = pwd(add.values[0])
            if (u.bindError === '773' || u.bindError === '532') delete u.bindError
            answer(0)
          }
        } else if (req.op === 'search') {
          if (!bound) {
            sock.write(msg(req.id, tlv(TAG.SEARCH_DONE, result(1, '000004DC: LdapErr: DSID-0C090A5C, comment: In order to perform this operation a successful bind must be completed on the connection., data 0, v4563'))))
            continue
          }
          const all = d.entries()
          const scoped = req.scope === 0 ? all.filter((e) => e.dn.toLowerCase() === req.base.toLowerCase()) : all.filter((e) => e.dn.toLowerCase().endsWith(req.base.toLowerCase()))
          let hits = scoped.filter((e) => d.match(req.filter, e))
          let code = 0
          if (req.sizeLimit && hits.length > req.sizeLimit) {
            hits = hits.slice(0, req.sizeLimit)
            code = 4
          }
          for (const e of hits) {
            const wanted = req.attributes.length && !req.attributes.includes('1.1') ? req.attributes.map((a) => a.toLowerCase()) : req.attributes.includes('1.1') ? [] : Object.keys(e.attrs)
            const attrs = Object.entries(e.attrs).filter(([k]) => wanted.includes(k)).map(([k, vals]) => berSequence([berString(k), tlv(TAG.SET, vals.map((v) => (Buffer.isBuffer(v) ? tlv(TAG.OCTET_STRING, v) : berString(v))))]))
            sock.write(msg(req.id, tlv(TAG.SEARCH_ENTRY, [berString(e.dn), berSequence(attrs)])))
          }
          // AD hands out referrals to its other naming contexts on a subtree search from the root
          if (req.scope === 2) sock.write(msg(req.id, tlv(TAG.SEARCH_REFERENCE, [berString('ldap://ForestDnsZones.JFL.LOCAL/DC=ForestDnsZones,DC=JFL,DC=LOCAL')])))
          sock.write(msg(req.id, tlv(TAG.SEARCH_DONE, result(code))))
        }
      }
    })
  }
  const server = tlsOptions ? tls.createServer(tlsOptions, onSocket) : net.createServer(onSocket)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: server.address().port,
    requests,
    get connections() { return state.connections },
    close: () => new Promise((r) => { server.close(() => r()); setTimeout(r, 300).unref() })
  }
}

/** The directory most tests use. */
export const GROUPS = {
  admins: 'CN=CCTV Admins,OU=Groups,DC=JFL,DC=LOCAL',
  viewers: 'CN=CCTV Viewers,OU=Groups,DC=JFL,DC=LOCAL',
  watch: 'CN=CCTV Watch-only,OU=Groups,DC=JFL,DC=LOCAL',
  gate: 'CN=Gate Staff,OU=Groups,DC=JFL,DC=LOCAL'
}
export const sampleDir = () => ({
  changers: ['svc-cctv'], // may change others' passwords given the old one (Everyone has "Change Password" in AD)
  groups: [
    { dn: GROUPS.admins, cn: 'CCTV Admins' },
    { dn: GROUPS.viewers, cn: 'CCTV Viewers' },
    { dn: GROUPS.watch, cn: 'CCTV Watch-only' },
    { dn: GROUPS.gate, cn: 'Gate Staff' }
  ],
  users: {
    'Ann.Admin': { password: 'Ann-pass-1', dn: 'CN=Ann Admin,OU=Staff,DC=JFL,DC=LOCAL', displayName: 'Ann Admin', chain: [GROUPS.admins, GROUPS.viewers] },
    // in CCTV Viewers only through Gate Staff (nested)
    bob: { password: 'Bob-pass-1', dn: 'CN=Bob Gate,OU=Staff,DC=JFL,DC=LOCAL', displayName: 'Bob Gate', chain: [GROUPS.gate, GROUPS.viewers] },
    wendy: { password: 'Wendy-pass-1', dn: 'CN=Wendy Watch,OU=Staff,DC=JFL,DC=LOCAL', displayName: 'Wendy Watch', chain: [GROUPS.watch] },
    nogroup: { password: 'No-pass-1', dn: 'CN=No Group,OU=Staff,DC=JFL,DC=LOCAL', chain: [GROUPS.gate] },
    locked: { password: 'Locked-1', dn: 'CN=Locked,OU=Staff,DC=JFL,DC=LOCAL', chain: [GROUPS.viewers], bindError: '775' },
    expired: { password: 'Old-pass-1', dn: 'CN=Expired,OU=Staff,DC=JFL,DC=LOCAL', displayName: 'Ed Expired', chain: [GROUPS.viewers], bindError: '773' },
    disabled: { password: 'Dis-pass-1', dn: 'CN=Disabled,OU=Staff,DC=JFL,DC=LOCAL', chain: [GROUPS.viewers], uac: 514 },
    'svc-cctv': { password: 'Svc-pass-1', dn: 'CN=svc-cctv,OU=Service,DC=JFL,DC=LOCAL', chain: [] },
    // the same name as a local Argus account in the tests
    localboss: { password: 'AD-boss-1', dn: 'CN=Local Boss,OU=Staff,DC=JFL,DC=LOCAL', chain: [GROUPS.admins] }
  }
})
