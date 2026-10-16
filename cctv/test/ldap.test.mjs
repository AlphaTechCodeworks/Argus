// The LDAP client (ldap.mjs): BER encoding of bind/search/unbind, RFC 4515 filters and escaping,
// result parsing with AD's sub-codes, TLS trust (pin or CA), and the whole exchange against a fake
// server over plain TCP and over TLS with a certificate made by openssl at test time (skipped, and
// said so, when openssl is not on the PATH).
//   node cctv/test/ldap.test.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AD_SUB_CODES, LdapError, TAG, adSubCode, berInteger, berLength, berSequence, berString, decodeMessage, encodeBind, encodeFilter, encodeSearch,
  encodeUnbind, escapeFilterValue, ldapOpen, encodeModify, unicodePwd, guidToString, escapeFilterBytes, messageReader, normaliseFingerprint, parseFilter, readTlv, splitServer, tlv, verifyPeer
} from '../ldap.mjs'
import { fakeGuid, guidBuf, GROUPS, IN_CHAIN, adBindError, decodeFilter, decodeRequest, result, sampleDir, startFakeLdap } from './fake-ldap.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const hex = (b) => b.toString('hex')
const throws = (fn, re) => { try { fn(); return false } catch (e) { return re ? re.test(e.message) : true } }

// ---- BER ----
check('length: short form', hex(berLength(5)) === '05' && hex(berLength(127)) === '7f')
check('length: long form', hex(berLength(128)) === '8180' && hex(berLength(300)) === '82012c' && hex(berLength(70000)) === '83011170')
check('integer: 0, 127, 128, 256, -1, -129', hex(berInteger(0)) === '020100' && hex(berInteger(127)) === '02017f' && hex(berInteger(128)) === '02020080' && hex(berInteger(256)) === '02020100' && hex(berInteger(-1)) === '0201ff' && hex(berInteger(-129)) === '0202ff7f')
check('a TLV still arriving reads as not yet', readTlv(Buffer.from('3005020101', 'hex')) === null)
check('indefinite length is refused', throws(() => readTlv(Buffer.from('3080', 'hex')), /indefinite/))

// ---- bind ----
check('BindRequest, simple, byte for byte', hex(encodeBind(1, 'cn=a', 'b')) === '3011020101600c020103040463' + '6e3d61' + '800162')
const bindReq = decodeRequest(encodeBind(7, 'bob@JFL.LOCAL', 'pässword'))
check('bind decodes: version 3, the name, simple [0], UTF-8 password', bindReq.op === 'bind' && bindReq.id === 7 && bindReq.version === 3 && bindReq.name === 'bob@JFL.LOCAL' && bindReq.authTag === 0x80 && bindReq.password === 'pässword')
check('an empty password is never sent (it would be an unauthenticated bind, which AD accepts)', throws(() => encodeBind(1, 'bob@JFL.LOCAL', ''), /empty password/))
check('UnbindRequest', hex(encodeUnbind(3)) === '30050201034200')

// ---- filters and escaping ----
check('escape: * ( ) \\ NUL', escapeFilterValue('a*b(c)\\d\u0000') === 'a\\2ab\\28c\\29\\5cd\\00')
check('escape leaves ordinary text alone (incl. non-ASCII)', escapeFilterValue('José.O\'Neil-1') === 'José.O\'Neil-1')
const evil = 'bob)(|(objectClass=*'
const f1 = parseFilter(`(&(objectClass=user)(sAMAccountName=${escapeFilterValue(evil)}))`)
check('an injection attempt stays one equality value', f1.and.length === 2 && f1.and[1].eq[0] === 'sAMAccountName' && f1.and[1].eq[1].toString() === evil)
check('an unescaped * in a value is an error, never a wildcard', throws(() => parseFilter('(sAMAccountName=b*)'), /unescaped/))
check('a stray ")" breaks the filter rather than changing it', throws(() => parseFilter('(cn=a)b)')))
check('presence', JSON.stringify(parseFilter('(member=*)')) === '{"present":"member"}')
const nested = parseFilter(`(memberOf:${IN_CHAIN}:=${escapeFilterValue(GROUPS.viewers)})`)
check('extensible match: attr, rule, value', nested.ext.attr === 'memberOf' && nested.ext.rule === IN_CHAIN && nested.ext.value.toString() === GROUPS.viewers && nested.ext.dn === false)
const nestedBer = encodeFilter(nested)
check('extensible match BER: [9] with [1] rule, [2] type, [3] value', nestedBer[0] === 0xa9 && nestedBer.includes(Buffer.concat([Buffer.from([0x81, IN_CHAIN.length]), Buffer.from(IN_CHAIN)])) && nestedBer.includes(Buffer.from([0x82, 8])))
const roundTrip = decodeFilter(nestedBer, readTlv(nestedBer, 0))
check('and it decodes back the same', roundTrip.ext.rule === IN_CHAIN && roundTrip.ext.attr === 'memberOf' && roundTrip.ext.value.toString() === GROUPS.viewers)
const dnParen = 'CN=Smith\\, John (Ops),OU=Staff,DC=JFL,DC=LOCAL'
check('a DN with brackets and a backslash survives the trip', parseFilter(`(memberOf:${IN_CHAIN}:=${escapeFilterValue(dnParen)})`).ext.value.toString() === dnParen)
check('and/or/not encode to [0]/[1]/[2]', encodeFilter('(&(a=1)(|(b=2)(!(c=3))))')[0] === 0xa0 && encodeFilter('(|(a=1))')[0] === 0xa1 && encodeFilter('(!(a=1))')[0] === 0xa2)
check('>= and the like are refused (not needed, not guessed at)', throws(() => parseFilter('(a>=1)')))

// ---- search ----
const sreq = decodeRequest(encodeSearch(4, { base: 'DC=JFL,DC=LOCAL', scope: 'base', filter: `(memberOf:${IN_CHAIN}:=${escapeFilterValue(GROUPS.admins)})`, attributes: ['1.1'], sizeLimit: 1, timeLimit: 8 }))
check('SearchRequest: base, scope, deref never, limits, typesOnly, attributes', sreq.op === 'search' && sreq.base === 'DC=JFL,DC=LOCAL' && sreq.scope === 0 && sreq.deref === 0 && sreq.sizeLimit === 1 && sreq.timeLimit === 8 && sreq.typesOnly === false && sreq.attributes.join() === '1.1')
check('SearchRequest: the nested-group filter', sreq.filter.ext?.rule === IN_CHAIN && sreq.filter.ext.value.toString() === GROUPS.admins)
check('a bad scope is refused', throws(() => encodeSearch(1, { base: '', scope: 'everything', filter: '(a=1)' })))

// ---- modify (a Windows password change) and objectGUID ----
check('unicodePwd: the password in double quotes, UTF-16LE', hex(unicodePwd('Ab1')) === '220041006200310022' + '00')
const mod = encodeModify(9, 'CN=Ed,DC=JFL,DC=LOCAL', [{ op: 'delete', type: 'unicodePwd', values: [unicodePwd('old')] }, { op: 'add', type: 'unicodePwd', values: [unicodePwd('new')] }])
check('ModifyRequest is [APPLICATION 6]', mod[readTlv(mod, 0).start + 3] === 0x66)
const modReq = decodeRequest(mod)
check('ModifyRequest decodes: DN, delete old then add new, values as given', modReq.op === 'modify' && modReq.dn === 'CN=Ed,DC=JFL,DC=LOCAL' && modReq.changes.map((c) => c.op).join() === 'delete,add' && modReq.changes[0].values[0].equals(unicodePwd('old')) && modReq.changes[1].type === 'unicodePwd')
check('a modify with nothing in it is refused', throws(() => encodeModify(1, 'x', [])))
const modResp = decodeMessage(berSequence([berInteger(9), tlv(TAG.MODIFY_RESPONSE, result(19, '0000052D: Constraint violation - check_password_restrictions'))]))
check('ModifyResponse parses (constraintViolation)', modResp.type === 'modify' && modResp.result.code === 19 && modResp.result.name === 'constraintViolation')
const g = fakeGuid('bob')
check('objectGUID bytes read as the usual text form (little-endian first parts)', guidToString(guidBuf(g)) === g && guidToString(Buffer.alloc(3)) === null)
check('binary filter values: every byte escaped, and back the same', parseFilter(`(objectGUID=${escapeFilterBytes(guidBuf(g))})`).eq[1].equals(guidBuf(g)))

// ---- results and AD sub-codes ----
const resp = (code, text, op = TAG.BIND_RESPONSE, id = 2) => berSequence([berInteger(id), tlv(op, result(code, text))])
const bad = decodeMessage(resp(49, adBindError('775')))
check('BindResponse: code, name, message', bad.type === 'bind' && bad.id === 2 && bad.result.code === 49 && bad.result.name === 'invalidCredentials' && /AcceptSecurityContext/.test(bad.result.message))
check('AD sub-code 775 is "locked"', bad.result.adCode === '775' && bad.result.adReason === 'locked')
const subs = { '52e': 'wrong-password', 525: 'no-such-user', 530: 'time-restricted', 531: 'workstation-restricted', 532: 'password-expired', 533: 'disabled', 701: 'account-expired', 773: 'must-change-password', 775: 'locked' }
check('every sub-code a person can meet has a meaning', Object.entries(subs).every(([c, r]) => AD_SUB_CODES[c] === r && decodeMessage(resp(49, adBindError(c))).result.adReason === r))
check('upper-case hex reads too ("data 52E")', adSubCode('..., data 52E, v893') === '52e')
check('no sub-code: none', decodeMessage(resp(0, '')).result.adCode === undefined && adSubCode('') === null)
check('SearchResultDone parses', decodeMessage(resp(0, '', TAG.SEARCH_DONE)).type === 'done')
const entry = berSequence([berInteger(3), tlv(TAG.SEARCH_ENTRY, [berString('CN=Bob,DC=JFL,DC=LOCAL'), berSequence([berSequence([berString('displayName'), tlv(TAG.SET, [berString('Bob Gate')])]), berSequence([berString('memberOf'), tlv(TAG.SET, [berString('A'), berString('B')])])])])])
const e = decodeMessage(entry)
check('SearchResultEntry: DN and attributes (names in lower case, every value)', e.type === 'entry' && e.dn === 'CN=Bob,DC=JFL,DC=LOCAL' && e.attributes.displayname[0] === 'Bob Gate' && e.attributes.memberof.join() === 'A,B')
const ref = decodeMessage(berSequence([berInteger(3), tlv(TAG.SEARCH_REFERENCE, [berString('ldap://x/DC=y')])]))
check('SearchResultReference', ref.type === 'reference' && ref.uris[0] === 'ldap://x/DC=y')
const notice = decodeMessage(berSequence([berInteger(0), tlv(TAG.EXTENDED_RESPONSE, [...result(52, 'going away'), berString('1.3.6.1.4.1.1466.20036', 0x8a)])]))
check('notice of disconnection', notice.type === 'notice' && notice.id === 0 && notice.oid === '1.3.6.1.4.1.1466.20036')
const reader = messageReader()
const both = Buffer.concat([entry, resp(0, '', TAG.SEARCH_DONE, 3)])
const part1 = reader(both.subarray(0, 7))
const part2 = reader(both.subarray(7, 40))
const part3 = reader(both.subarray(40))
check('messages arriving in pieces come out whole and in order', part1.length === 0 && part2.length === 0 && part3.length === 2 && part3[0].type === 'entry' && part3[1].type === 'done')

// ---- TLS trust, without a network ----
const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
const cert = { fingerprint256: FP, subject: { CN: 'DC01.JFL.LOCAL' }, subjectaltname: 'DNS:DC01.JFL.LOCAL, DNS:JFL.LOCAL' }
check('fingerprint forms: colons, spaces, lower case', normaliseFingerprint(FP.toLowerCase().replace(/:/g, '')) === FP && normaliseFingerprint(FP.replace(/:/g, ' ')) === FP && normaliseFingerprint('abc') === null)
check('pinned and the same: accepted', verifyPeer({ cert, host: '192.168.0.19', pin: FP }).ok === true)
const changed = verifyPeer({ cert: { ...cert, fingerprint256: FP.replace(/^AA/, 'AB') }, host: '192.168.0.19', pin: FP })
check('pinned and different: refused, saying it changed', changed.ok === false && /has changed/.test(changed.reason))
check('nothing set up: refused (never "accept anything")', verifyPeer({ cert, host: '192.168.0.19' }).ok === false)
check('CA: chain good and the name matches: accepted', verifyPeer({ cert, host: 'DC01.JFL.LOCAL', ca: 'x', authorized: true }).how === 'ca')
const byIp = verifyPeer({ cert, host: '192.168.0.19', ca: 'x', authorized: true })
check('CA: reached by an IP the certificate does not name: refused, saying to use the name', byIp.ok === false && /is for DC01\.JFL\.LOCAL/.test(byIp.reason))
check('CA: chain not good: refused', verifyPeer({ cert, host: 'DC01.JFL.LOCAL', ca: 'x', authorized: false, authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN' }).ok === false)
check('no certificate at all: refused', verifyPeer({ cert: {}, host: 'x', pin: FP }).ok === false)
check('server forms: host, host:port, [v6]:port; bad port refused', splitServer('dc01').port === 636 && splitServer('10.0.0.1:3269').port === 3269 && splitServer('[::1]:636').host === '::1' && splitServer('x:0') === null && splitServer('a b') === null)

// ---- against a fake server over plain TCP ----
const fake = await startFakeLdap({ dir: sampleDir() })
const c = await ldapOpen({ host: '127.0.0.1', port: fake.port, transport: 'tcp', timeoutMs: 3000 })
let err = await c.bind('bob@JFL.LOCAL', 'wrong').then(() => null, (x) => x)
check('TCP: a wrong password is an LdapError with code 49 and AD 52e', err instanceof LdapError && err.kind === 'result' && err.result.code === 49 && err.result.adReason === 'wrong-password')
check('TCP: a right one binds', (await c.bind('bob@JFL.LOCAL', 'Bob-pass-1')).code === 0)
const found = await c.search({ base: 'DC=JFL,DC=LOCAL', filter: `(&(objectCategory=person)(objectClass=user)(sAMAccountName=${escapeFilterValue('bob')}))`, attributes: ['sAMAccountName', 'displayName'], sizeLimit: 2 })
check('TCP: the search finds the entry (and the referral is kept apart)', found.entries.length === 1 && found.entries[0].attributes.displayname[0] === 'Bob Gate' && found.references.length === 1)
const inViewers = await c.search({ base: found.entries[0].dn, scope: 'base', filter: `(memberOf:${IN_CHAIN}:=${escapeFilterValue(GROUPS.viewers)})`, attributes: ['1.1'], sizeLimit: 1 })
const inAdmins = await c.search({ base: found.entries[0].dn, scope: 'base', filter: `(memberOf:${IN_CHAIN}:=${escapeFilterValue(GROUPS.admins)})`, attributes: ['1.1'], sizeLimit: 1 })
check('TCP: nested membership: in Viewers through Gate Staff, not in Admins', inViewers.entries.length === 1 && inAdmins.entries.length === 0)
const withGuid = await c.search({ base: 'DC=JFL,DC=LOCAL', filter: `(objectGUID=${escapeFilterBytes(guidBuf(fakeGuid('bob')))})`, attributes: ['objectGUID', 'sAMAccountName'] })
check('TCP: found by objectGUID, and its bytes come back unharmed', withGuid.entries.length === 1 && guidToString(withGuid.entries[0].raw.objectguid[0]) === fakeGuid('bob'))
err = await c.modify(found.entries[0].dn, [{ op: 'delete', type: 'unicodePwd', values: [unicodePwd('not-it')] }, { op: 'add', type: 'unicodePwd', values: [unicodePwd('Bob-pass-2')] }]).then(() => null, (x) => x)
check('TCP: a change with the wrong old password: AD constraintViolation 00000056', err?.result?.code === 19 && /^00000056/.test(err.result.message))
err = await c.modify(found.entries[0].dn, [{ op: 'delete', type: 'unicodePwd', values: [unicodePwd('Bob-pass-1')] }, { op: 'add', type: 'unicodePwd', values: [unicodePwd('short')] }]).then(() => null, (x) => x)
check('TCP: a new password against the policy: 0000052D', err?.result?.code === 19 && /^0000052D/.test(err.result.message))
check('TCP: a good change goes through', (await c.modify(found.entries[0].dn, [{ op: 'delete', type: 'unicodePwd', values: [unicodePwd('Bob-pass-1')] }, { op: 'add', type: 'unicodePwd', values: [unicodePwd('Bob-pass-2')] }])).code === 0)
const injected = await c.search({ base: 'DC=JFL,DC=LOCAL', filter: `(sAMAccountName=${escapeFilterValue('*')})`, attributes: ['1.1'] })
check('TCP: a typed "*" finds nobody (it is the letter *, not everyone)', injected.entries.length === 0)
c.close()
await new Promise((r) => setTimeout(r, 100))
check('TCP: close sends an UnbindRequest', fake.requests.some((r) => r.op === 'unbind'))
const slow = await startFakeLdap({ dir: { users: {}, groups: [] } })
// a server that accepts the connection and never answers: the bind times out
const silent = await import('node:net').then(({ default: net }) => new Promise((r) => { const s = net.createServer(() => {}); s.listen(0, '127.0.0.1', () => r(s)) }))
const c2 = await ldapOpen({ host: '127.0.0.1', port: silent.address().port, transport: 'tcp', timeoutMs: 300 })
const t0 = Date.now()
err = await c2.bind('x@JFL.LOCAL', 'y').then(() => null, (x) => x)
check('TCP: a server that never answers times out', err?.kind === 'timeout' && Date.now() - t0 < 2000)
err = await ldapOpen({ host: '127.0.0.1', port: 1, transport: 'tcp', timeoutMs: 1000 }).then(() => null, (x) => x)
check('TCP: nothing listening: a connect error', err?.kind === 'connect' || err?.kind === 'timeout')
silent.close()
await slow.close()
await fake.close()

// ---- over TLS, with a certificate made now ----
let openssl = true
try { execFileSync('openssl', ['version'], { stdio: 'pipe' }) } catch { openssl = false }
if (!openssl) {
  console.log('SKIP  TLS against a fake server: openssl is not on the PATH (the trust logic is tested above without a network)')
} else {
  const dir = mkdtempSync(join(tmpdir(), 'cctv-ldaps-'))
  const make = (name, subj, san) => {
    const cfg = join(dir, `${name}.cnf`)
    writeFileSync(cfg, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${subj}\n[ext]\nsubjectAltName=${san}\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\n`)
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.pem`), '-config', cfg], { stdio: 'pipe' })
    return { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.pem`)) }
  }
  const named = make('dc', 'dc01.test', 'DNS:localhost,IP:127.0.0.1')
  const tlsFake = await startFakeLdap({ dir: sampleDir(), tlsOptions: named })
  const peek = await ldapOpen({ host: '127.0.0.1', port: tlsFake.port, peek: true, timeoutMs: 3000 })
  check('TLS: Check connection shows the certificate (subject, issuer, dates, SHA-256)', peek.cert.subject === 'CN=dc01.test' && peek.cert.issuer === 'CN=dc01.test' && normaliseFingerprint(peek.cert.fingerprint256) !== null && Boolean(peek.cert.validTo) && peek.cert.selfIssued === true)
  const before = tlsFake.requests.length
  check('TLS: checking sends no LDAP at all', tlsFake.requests.length === before && before === 0)
  err = await ldapOpen({ host: '127.0.0.1', port: tlsFake.port, timeoutMs: 3000 }).then(() => null, (x) => x)
  check('TLS: no pin and no CA: refused before anything is sent', err?.kind === 'tls' && tlsFake.requests.length === 0)
  err = await ldapOpen({ host: '127.0.0.1', port: tlsFake.port, pin: FP, timeoutMs: 3000 }).then(() => null, (x) => x)
  check('TLS: a different pinned fingerprint: refused', err?.kind === 'tls' && /has changed/.test(err.message) && tlsFake.requests.length === 0)
  const pinned = await ldapOpen({ host: '127.0.0.1', port: tlsFake.port, pin: peek.cert.fingerprint256, timeoutMs: 3000 })
  check('TLS: the pinned certificate: bind and search work', (await pinned.bind('Ann.Admin@JFL.LOCAL', 'Ann-pass-1')).code === 0 && (await pinned.search({ base: 'DC=JFL,DC=LOCAL', filter: '(sAMAccountName=Ann.Admin)', attributes: ['displayName'] })).entries[0]?.attributes.displayname[0] === 'Ann Admin')
  pinned.close()
  const viaCa = await ldapOpen({ host: 'localhost', port: tlsFake.port, ca: named.cert.toString(), timeoutMs: 3000 })
  check('TLS: through the CA, by a name the certificate has: accepted', (await viaCa.bind('bob@JFL.LOCAL', 'Bob-pass-1')).code === 0)
  viaCa.close()
  const other = make('other', 'other-ca', 'DNS:nowhere.test')
  err = await ldapOpen({ host: 'localhost', port: tlsFake.port, ca: other.cert.toString(), timeoutMs: 3000 }).then(() => null, (x) => x)
  check('TLS: a CA that did not sign it: refused', err?.kind === 'tls' && /not signed by the CA/.test(err.message))
  await tlsFake.close()
  const wrongName = make('wn', 'dc01.test', 'DNS:dc01.test')
  const wnFake = await startFakeLdap({ dir: sampleDir(), tlsOptions: wrongName })
  err = await ldapOpen({ host: '127.0.0.1', port: wnFake.port, ca: wrongName.cert.toString(), timeoutMs: 3000 }).then(() => null, (x) => x)
  check('TLS: through the CA but reached by an address it does not name: refused', err?.kind === 'tls' && /is for dc01\.test/.test(err.message))
  await wnFake.close()
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
