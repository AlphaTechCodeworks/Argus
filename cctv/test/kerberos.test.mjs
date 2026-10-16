// Windows single sign-on, the protocol side (kerberos.mjs): the published crypto vectors (RFC 3961
// n-fold, RFC 3962 string-to-key = PBKDF2 + DK, RFC 3962 AES-CTS), DER and SPNEGO parsing, the MIT
// keytab format, and whole tickets built here with a test service key and checked as a browser's
// would be: realm, service name, expiry, clock skew, replay, wrong key, RC4, NTLM, the AP-REP.
// No KDC is involved: the tickets are made by makeTestToken, the way a domain controller would.
//   node cctv/test/kerberos.test.mjs
import { randomBytes } from 'node:crypto'
import * as k from '../kerberos.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex')
const code = (fn) => { try { fn(); return 'ok' } catch (e) { return e instanceof k.KerberosError ? e.code : `throw ${e.message}` } }

// ---- RFC 3961 A.1: n-fold ----
const NFOLD = [
  ['012345', 64, 'be072631276b1955'],
  ['password', 56, '78a07b6caf85fa'],
  ['Rough Consensus, and Running Code', 64, 'bb6ed30870b7f0e0'],
  ['password', 168, '59e4a8ca7c0385c3c37b3f6d2000247cb6e6bd5b3e'],
  ['MASSACHVSETTS INSTITVTE OF TECHNOLOGY', 192, 'db3b0d8f0b061e603282b308a50841229ad798fab9540c1b'],
  ['Q', 168, '518a54a215a8452a518a54a215a8452a518a54a215'],
  ['ba', 168, 'fb25d531ae8974499f52fd92ea9857c4ba24cf297e'],
  ['kerberos', 64, '6b65726265726f73'],
  ['kerberos', 128, '6b65726265726f737b9b5b2b93132b93'],
  ['kerberos', 168, '8372c236344e5f1550cd0747e15d62ca7a5a3bcea4'],
  ['kerberos', 256, '6b65726265726f737b9b5b2b93132b935c9bdcdad95c9899c4cae4dee6d6cae4']
]
for (const [s, bits, want] of NFOLD) {
  const got = k.nfold(Buffer.from(s, 'latin1'), bits / 8).toString('hex')
  check(`RFC 3961 A.1: ${bits}-fold("${s}")`, got === want, got)
}

// ---- RFC 3962 Appendix B: string-to-key (PBKDF2-HMAC-SHA1, then DK(tkey, "kerberos")) ----
const S2K = [
  [1, 'password', 'ATHENA.MIT.EDUraeburn', '42263c6e89f4fc28b8df68ee09799f15', 'fe697b52bc0d3ce14432ba036a92e65bbb52280990a2fa27883998d72af30161'],
  [2, 'password', 'ATHENA.MIT.EDUraeburn', 'c651bf29e2300ac27fa469d693bdda13', 'a2e16d16b36069c135d5e9d2e25f896102685618b95914b467c67622225824ff'],
  [1200, 'password', 'ATHENA.MIT.EDUraeburn', '4c01cd46d632d01e6dbe230a01ed642a', '55a6ac740ad17b4846941051e1e8b0a7548d93b0ab30a8bc3ff16280382b8c2a'],
  [5, 'password', Buffer.from('1234567878563412', 'hex'), 'e9b23d52273747dd5c35cb55be619d8e', '97a4e786be20d81a382d5ebc96d5909cabcdadc87ca48f574504159f16c36e31'],
  [1200, 'X'.repeat(64), 'pass phrase equals block size', '59d1bb789a828b1aa54ef9c2883f69ed', '89adee3608db8bc71f1bfbfe459486b05618b70cbae22092534e56c553ba4b34'],
  [1200, 'X'.repeat(65), 'pass phrase exceeds block size', 'cb8005dc5f90179a7f02104c0018751d', 'd78c5c9cb872a8c9dad4697f0bb5b2d21496c82beb2caeda2112fceea057401b'],
  [50, '\u{1D11E}', 'EXAMPLE.COMpianist', 'f149c1f2e154a73452d43e7fe62a56e5', '4b6d9839f84406df1f09cc166db4b83c571848b784a3d6bdc346589a3e393f9e']
]
for (const [iter, pw, salt, k128, k256] of S2K) {
  const a = k.stringToKey(17, pw, salt, iter).toString('hex')
  const b = k.stringToKey(18, pw, salt, iter).toString('hex')
  check(`RFC 3962 B: string-to-key, ${iter} iterations, salt ${Buffer.isBuffer(salt) ? 'bytes 1234567878563412' : `"${salt}"`}: AES-128 and AES-256`, a === k128 && b === k256, `${a} ${b}`)
}

// ---- RFC 3962 Appendix B: AES-128 CBC with ciphertext stealing, IV zero ----
const CTS_KEY = Buffer.from('chicken teriyaki')
const PLAIN = Buffer.from("I would like the General Gau's Chicken, please, and wonton soup.")
const CTS = [
  [17, 'c6353568f2bf8cb4d8a580362da7ff7f97'],
  [31, 'fc00783e0efdb2c1d445d4c8eff7ed2297687268d6ecccc0c07b25e25ecfe5'],
  [32, '39312523a78662d5be7fcbcc98ebf5a897687268d6ecccc0c07b25e25ecfe584'],
  [47, '97687268d6ecccc0c07b25e25ecfe584b3fffd940c16a18c1b5549d2f838029e39312523a78662d5be7fcbcc98ebf5'],
  [48, '97687268d6ecccc0c07b25e25ecfe5849dad8bbb96c4cdc03bc103e1a194bbd839312523a78662d5be7fcbcc98ebf5a8'],
  [64, '97687268d6ecccc0c07b25e25ecfe58439312523a78662d5be7fcbcc98ebf5a84807efe836ee89a526730dbc2f7bc8409dad8bbb96c4cdc03bc103e1a194bbd8']
]
for (const [n, want] of CTS) {
  const c = k.ctsEncrypt(CTS_KEY, PLAIN.subarray(0, n))
  check(`RFC 3962 B: AES-CTS of ${n} bytes encrypts to the vector and decrypts back`, c.toString('hex') === want && k.ctsDecrypt(CTS_KEY, hex(want)).equals(PLAIN.subarray(0, n)), c.toString('hex'))
}
check('AES-CTS with a 256-bit key round-trips every length 16..80', Array.from({ length: 65 }, (_, i) => i + 16).every((n) => { const key = randomBytes(32); const p = randomBytes(n); return k.ctsDecrypt(key, k.ctsEncrypt(key, p)).equals(p) }))

// ---- RFC 3961 encrypt / decrypt (confounder, Ke/Ki per key usage, HMAC-SHA1-96) ----
const key256 = k.stringToKey(18, 'password', 'ATHENA.MIT.EDUraeburn', 1)
const ct = k.encrypt(18, key256, 2, Buffer.from('a ticket'))
check('encrypt: 16-byte confounder + plaintext + 12-byte HMAC', ct.length === 16 + 8 + 12)
check('decrypt gives the plaintext back', k.decrypt(18, key256, 2, ct).toString() === 'a ticket')
check('the key usage is part of the key (usage 11 cannot read usage 2)', code(() => k.decrypt(18, key256, 11, ct)) === 'integrity')
const flipped = Buffer.from(ct); flipped[5] ^= 1
check('one changed byte fails the integrity check', code(() => k.decrypt(18, key256, 2, flipped)) === 'integrity')
check('Ke and Ki differ, and differ per usage', (() => { const a = k.deriveKeys(key256, 2); const b = k.deriveKeys(key256, 11); return !a.ke.equals(a.ki) && !a.ke.equals(b.ke) })())
check('the same with AES-128', k.decrypt(17, k.stringToKey(17, 'pw', 'SALT'), 11, k.encrypt(17, k.stringToKey(17, 'pw', 'SALT'), 11, Buffer.from('authenticator-ish!'))).toString() === 'authenticator-ish!')
check('RC4 (23) and DES (3) are refused', code(() => k.decrypt(23, randomBytes(16), 2, randomBytes(40))) === 'etype' && code(() => k.decrypt(3, randomBytes(8), 2, randomBytes(40))) === 'etype')

// ---- DER ----
check('DER: INTEGER both ways, incl. 0, 127, 128, 2^31, -1', [0, 5, 127, 128, 255, 256, 2 ** 31, 4294967295, -1, -129].every((v) => k.derInt(k.derRead(k.der.int(v))) === v))
check('DER: OID both ways (SPNEGO, krb5, MS krb5, NTLM)', [k.OID.spnego, k.OID.krb5, k.OID.msKrb5, k.OID.ntlm].every((o) => k.derOid(k.derRead(k.der.oid(o))) === o))
check('DER: the Kerberos OID encodes as RFC 1964 says', k.der.oid(k.OID.krb5).toString('hex') === '06092a864886f712010202' && k.der.oid(k.OID.msKrb5).toString('hex') === '06092a864882f712010202')
check('DER: KerberosTime both ways (whole seconds)', k.derTime(k.derRead(k.der.time(Date.UTC(2026, 9, 16, 8, 30, 5)))) === Date.UTC(2026, 9, 16, 8, 30, 5))
check('DER: long-form lengths', k.derRead(k.der.octets(Buffer.alloc(300))).body.length === 300 && k.derRead(k.der.octets(Buffer.alloc(70000))).body.length === 70000)
check('DER: a length past the end is refused, not read', code(() => k.derRead(Buffer.from([0x04, 0x05, 1, 2]))) === 'bad-token' && code(() => k.derRead(Buffer.from([0x04, 0x85, 1, 1, 1, 1, 1]))) === 'bad-token')

// ---- keytab ----
const svcKey = randomBytes(32)
const svcKey128 = randomBytes(16)
const KT = [
  { principal: 'HTTP/cctv.jfl.gripe@JFL.LOCAL', kvno: 3, etype: 18, key: svcKey, timestamp: Date.UTC(2026, 9, 16) },
  { principal: 'HTTP/cctv.jfl.gripe@JFL.LOCAL', kvno: 3, etype: 17, key: svcKey128 },
  { principal: 'HTTP/cctv.jfl.gripe@JFL.LOCAL', kvno: 3, etype: 23, key: randomBytes(16) },
  { principal: 'host/other.jfl.local@JFL.LOCAL', kvno: 9, etype: 18, key: randomBytes(32) }
]
const ktBytes = k.buildKeytab(KT)
const keys = k.parseKeytab(ktBytes)
check('keytab: version 05 02, four entries, names, kvno, etypes, keys', keys.length === 4 && keys[0].principal === 'HTTP/cctv.jfl.gripe@JFL.LOCAL' && keys[0].components.join() === 'HTTP,cctv.jfl.gripe' && keys[0].realm === 'JFL.LOCAL' && keys[0].kvno === 3 && keys[0].etype === 18 && keys[0].key.equals(svcKey) && keys[0].timestamp === Date.UTC(2026, 9, 16) && keys[3].kvno === 9)
// what ktpass writes: the 8-bit kvno only (no trailing 32-bit one), and a deleted hole
const short = Buffer.from(ktBytes)
{
  // drop the trailing 32-bit kvno of the first entry: size - 4
  const size = short.readInt32BE(2)
  const first = Buffer.concat([short.subarray(0, 2), Buffer.from([0, 0, 0, 0]), short.subarray(6, 6 + size - 4)])
  first.writeInt32BE(size - 4, 2)
  const hole = Buffer.alloc(4 + 10); hole.writeInt32BE(-10, 0)
  const ks = k.parseKeytab(Buffer.concat([first, hole]))
  check('keytab: an entry with only the 8-bit kvno, and a deleted hole, are read', ks.length === 1 && ks[0].kvno === 3 && ks[0].key.equals(svcKey))
}
check('keytab: describe never includes the key, and says which keys can be used', (() => { const d = k.describeKeytab(keys); return !JSON.stringify(d).includes(svcKey.toString('hex')) && d.every((e) => !('key' in e)) && d[0].usable && d[1].usable && !d[2].usable && d[2].etypeName === 'rc4-hmac' })())
check('keytab: not a keytab, cut short, empty: refused in words', code(() => k.parseKeytab(Buffer.from('hello'))) === 'keytab' && code(() => k.parseKeytab(ktBytes.subarray(0, 30))) === 'keytab' && code(() => k.parseKeytab(Buffer.from([5, 2]))) === 'keytab')

// ---- whole tickets: a token as Windows sends it, checked ----
const SERVICE = ['HTTP', 'cctv.jfl.gripe']
const now = Date.UTC(2026, 9, 16, 9, 0, 0)
const accept = (token, o = {}) => k.acceptApReq(k.unwrapNegotiate(token).apReq, { keys, realm: 'JFL.LOCAL', service: SERVICE, now, replay: k.makeReplayCache(), ...o })
const tok = (o = {}) => k.makeTestToken({ serviceKey: svcKey, kvno: 3, now, ...o })

const unwrapped = k.unwrapNegotiate(tok())
check('SPNEGO NegTokenInit: the MS Kerberos mech token is found, unwrapped to the AP-REQ', unwrapped.spnego === true && unwrapped.mech === k.OID.msKrb5 && unwrapped.apReq[0] === 0x6e)
check('the standard Kerberos OID first works too', k.unwrapNegotiate(tok({ mechs: [k.OID.krb5, k.OID.ntlm] })).mech === k.OID.krb5)
check('a bare Kerberos GSS token (no SPNEGO) works too', k.unwrapNegotiate(tok({ spnego: false })).spnego === false)
const ok = accept(tok())
check('a good ticket: bob@JFL.LOCAL, AES-256, kvno 3', ok.user === 'bob' && ok.realm === 'JFL.LOCAL' && ok.principal === 'bob@JFL.LOCAL' && ok.etype === 18 && ok.kvno === 3 && ok.kvnoMatched)
check('AES-128 tickets are accepted', accept(k.makeTestToken({ serviceKey: svcKey128, etype: 17, sessionEtype: 17, kvno: 3, now })).user === 'bob')
check('the realm and service compare without regard to capitals (as AD does)', accept(tok({ realm: 'jfl.local', service: ['http', 'CCTV.JFL.GRIPE'] })).user === 'bob')
check('NTLM offered first (no ticket): refused as ntlm', code(() => accept(k.makeTestToken({ serviceKey: svcKey, now, mechs: [k.OID.ntlm, k.OID.krb5] }))) === 'ntlm')
check('a raw NTLMSSP token: refused as ntlm', code(() => k.unwrapNegotiate(Buffer.from('NTLMSSP\0\x01\0\0\0', 'latin1'))) === 'ntlm')
check('garbage: refused as a bad token, never a crash', [Buffer.from('nonsense'), Buffer.alloc(0), Buffer.from([0x60, 0x80]), randomBytes(200), tok().subarray(0, 100)].every((b) => code(() => accept(b)) === 'bad-token'))
check('another realm in the ticket: refused', code(() => accept(tok({ realm: 'EVIL.LOCAL' }))) === 'wrong-realm')
check('a user of another realm (crealm): refused', code(() => accept(tok({ crealm: 'OTHER.LOCAL' }))) === 'wrong-realm')
check('a ticket for another service (HTTP/other): refused', code(() => accept(tok({ service: ['HTTP', 'other.jfl.local'] }))) === 'wrong-service')
check('a ticket for host/ instead of HTTP/: refused', code(() => accept(tok({ service: ['host', 'cctv.jfl.gripe'] }))) === 'wrong-service')
check('expired (endtime + 5 min passed): refused', code(() => accept(tok({ start: now - 11 * 3_600_000, end: now - 6 * 60_000, ctime: now }))) === 'ticket-expired')
check('ended 4 minutes ago: still within the skew', accept(tok({ start: now - 10 * 3_600_000, end: now - 4 * 60_000 })).user === 'bob')
check('not valid yet (starts in 10 min): refused', code(() => accept(tok({ start: now + 10 * 60_000 }))) === 'ticket-not-yet')
check('marked INVALID: refused', code(() => accept(tok({ invalid: true }))) === 'ticket-invalid')
check('the PC clock 6 minutes behind: refused as skew', code(() => accept(tok({ ctime: now - 6 * 60_000 }))) === 'skew')
check('the PC clock 6 minutes ahead: refused as skew', code(() => accept(tok({ ctime: now + 6 * 60_000 }))) === 'skew')
check('4 minutes out: fine', accept(tok({ ctime: now + 4 * 60_000 })).user === 'bob')
check('the authenticator from someone other than the ticket\'s holder: refused', code(() => accept(tok({ authUser: 'mallory' }))) === 'name-mismatch')
const replay = k.makeReplayCache()
const once = tok()
check('the same token twice: the second is a replay', k.acceptApReq(k.unwrapNegotiate(once).apReq, { keys, realm: 'JFL.LOCAL', service: SERVICE, now, replay }).user === 'bob' && code(() => k.acceptApReq(k.unwrapNegotiate(once).apReq, { keys, realm: 'JFL.LOCAL', service: SERVICE, now: now + 1000, replay })) === 'replay')
check('a new authenticator (another cusec) from the same person is not a replay', k.acceptApReq(k.unwrapNegotiate(tok({ cusec: 999 })).apReq, { keys, realm: 'JFL.LOCAL', service: SERVICE, now, replay }).user === 'bob')
const rc = k.makeReplayCache({ max: 3 })
check('the replay cache forgets after the window and stays bounded', rc.check('a', 0) && !rc.check('a', 1000) && rc.check('a', 11 * 60_000) && rc.check('b', 11 * 60_000) && rc.check('c', 11 * 60_000) && rc.check('d', 11 * 60_000) && rc.size <= 3)
check('the wrong service key (password reset since): refused, saying make it again', (() => { try { accept(k.makeTestToken({ serviceKey: randomBytes(32), kvno: 3, now })); return false } catch (e) { return e.code === 'integrity' && /make it again/.test(e.message) } })())
check('a wrong kvno in the keytab but the right key (a ktpass quirk): accepted, and said so', (() => { const r = accept(tok({ kvno: 4 })); return r.user === 'bob' && r.kvnoMatched === false && r.kvno === 3 })())
{
  // an RC4 ticket cannot be made with the AES code here: the etype of a good one is changed to 23
  const t = Buffer.from(tok())
  const i = t.indexOf(Buffer.from([0xa0, 0x03, 0x02, 0x01, 18]), t.indexOf(Buffer.from('cctv.jfl.gripe')))
  t[i + 4] = 23
  check('an RC4 (23) ticket: refused, saying only AES', i > 0 && code(() => accept(t)) === 'etype')
}
check('no key for the service in the keytab: refused as no-key', code(() => accept(tok(), { keys: keys.filter((x) => !x.principal.startsWith('HTTP/')) })) === 'no-key')
check('a two-part client name (not a user): refused', code(() => accept(tok({ user: 'host/pc1', authUser: 'host/pc1' }))) === 'not-a-user')

// ---- mutual authentication: the AP-REP ----
const mut = accept(tok({ mutual: true }))
check('mutual-required is read from the AP options', mut.mutual === true && accept(tok()).mutual === false)
const rep = k.buildApRepToken(mut, { spnego: true, mech: k.OID.msKrb5 })
{
  const resp = k.derRead(rep)
  const seq = k.derChildren(resp.body)[0]
  const f = new Map(k.derChildren(seq.body).map((c) => [c.tag, k.derChildren(c.body)[0]]))
  const negState = f.get(0).body[0]
  const gss = k.derRead(f.get(2).body)
  const oidEl = k.derRead(gss.body)
  const afterOid = gss.body.subarray(oidEl.end)
  const apRep = k.derRead(afterOid.subarray(2))
  const repSeq = k.derChildren(apRep.body)[0]
  const rf = new Map(k.derChildren(repSeq.body).map((c) => [c.tag, k.derChildren(c.body)[0]]))
  const encF = new Map(k.derChildren(rf.get(2).body).map((c) => [c.tag, k.derChildren(c.body)[0]]))
  const plain = k.decrypt(k.derInt(encF.get(0)), mut.sessionKey.value, 12, encF.get(2).body)
  const encPart = k.derChildren(k.derChildren(k.derRead(plain).body)[0].body)
  const ctime = k.derTime(k.derChildren(encPart[0].body)[0])
  const cusec = k.derInt(k.derChildren(encPart[1].body)[0])
  check('AP-REP: NegTokenResp accept-completed, the mech echoed, GSS TOK_ID 02 00, [APPLICATION 15]', resp.tag === 1 && resp.cls === 2 && negState === 0 && k.derOid(f.get(1)) === k.OID.msKrb5 && k.derOid(oidEl) === k.OID.krb5 && afterOid[0] === 2 && afterOid[1] === 0 && apRep.cls === 1 && apRep.tag === 15)
  check('AP-REP: EncAPRepPart decrypts with the session key (usage 12) and echoes ctime and cusec', ctime === mut.ctime && cusec === mut.cusec)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
