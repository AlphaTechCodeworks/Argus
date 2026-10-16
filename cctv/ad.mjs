// Active Directory sign-in: staff sign in with their Windows account, and their role comes from the
// AD group they are in (Settings > Active Directory; the admin API is ad-api.mjs).
//
// Who is asked, in order:
//   1. A local Argus account of that name (users.json with a password) ALWAYS wins and works as it
//      did; AD is not asked at all. A local admin is how anyone gets in when the DCs cannot be reached.
//   2. Otherwise, with AD switched on: the typed name ("bob", "JFL\bob" or "bob@JFL.LOCAL") and the
//      password are checked by binding to a domain controller over LDAPS (ldap.mjs; TLS always, and
//      only to a certificate an admin pinned or one signed by the CA an admin gave). The person's own
//      entry is then read (objectGUID, sAMAccountName, displayName, userAccountControl) and their
//      membership of the three mapped groups asked, nested groups included (LDAP_MATCHING_RULE_IN_CHAIN,
//      memberOf:1.2.840.113556.1.4.1941:=<group DN>). The highest role wins: admin, viewer, watch.
//      In none of them: refused, "Your account is not in a CCTV group".
//   3. On success an ordinary Argus session is made for them. users.json keeps a small record of the
//      AD user under their current sAMAccountName (no password, ever): source 'ad', `adGuid` (their
//      objectGUID, which never changes), the role from AD, display name, last sign-in, and
//      `adValidUntil`, the time until which the directory's "yes" holds. auth.mjs verifySession
//      refuses an AD user's sessions once that has passed, so they end by themselves.
//
// Identity is the objectGUID, not the name. IT may rename an account in AD: when someone signs in
// whose objectGUID is known under another name, everything kept under the old name (rights,
// saved views, camera order and preferences, set-up codes, bookmarks: the `renamers` server.mjs
// hands in) moves to the new name, all or nothing (each step can be undone, and is if a later one
// fails), the old name's sessions end, and the audit says "renamed in AD: old -> new". If a LOCAL
// account already has the new name, nothing is merged: the sign-in is refused and audited. A name
// whose record has a different objectGUID belonged to somebody else (deleted from AD since): the
// newcomer starts afresh, with none of their rights.
//
// Re-checks: with a look-up account set (an ordinary domain account that may read the directory),
// every AD user still signed in is looked up again (by objectGUID) every `recheckMinutes`; still in a
// group and not disabled, their `adValidUntil` moves on by `graceHours` (and their role follows AD);
// removed from the groups, disabled, deleted or renamed, their sessions end at once (`since` moves on,
// as Sign out user does; a renamed one carries everything over at their next sign-in). When no DC
// answers, nothing changes and the session lasts until `adValidUntil`: the grace. Without a look-up
// account there is nobody to ask, so an AD user simply signs in again after `graceHours`.
//
// Windows passwords (switch `allowPasswordChange`, on by default): an AD user can change their own
// Windows password from Argus, at any time from Change password, and from the sign-in page when AD
// says it has expired or must be changed (AD sub-codes 532 / 773). It is AD's own "change" (not a
// reset): an LDAP modify of unicodePwd deleting the old value and adding the new one, over the same
// verified LDAPS. Bound as the person when AD lets them bind; when it does not (expired / must
// change) bound as the look-up account, AD then checks the old password itself. Argus never resets
// or stores a Windows password, and never logs either one.
//
// Windows single sign-on (sso.mjs, kerberos.mjs) hands a name the browser proved with a Kerberos
// ticket to loginSso: the person is read through the look-up account and the sign-in ends in the same
// finish() as a password one (record, role, renames, audit). Local accounts are never signed in so.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { DATA_DIR, accountName, loadUsers, saveUsers, setWindowsPasswordChanger } from './auth.mjs'
import { writeFileAtomicSync } from './atomic-write.mjs'
import { LdapError, escapeFilterBytes, escapeFilterValue, guidToString, ldapOpen, normaliseFingerprint, splitServer, unicodePwd } from './ldap.mjs'

export const ROLE_ORDER = Object.freeze(['admin', 'viewer', 'watch']) // highest first
export const ROLE_LABELS = Object.freeze({ admin: 'Admin', viewer: 'Viewer', watch: 'Watch only' })
export const IN_CHAIN = '1.2.840.113556.1.4.1941' // LDAP_MATCHING_RULE_IN_CHAIN: nested membership

export const AD_DEFAULTS = Object.freeze({
  enabled: false,
  servers: ['192.168.0.19', '192.168.1.19'],
  domain: 'JFL.LOCAL',
  baseDn: 'DC=JFL,DC=LOCAL',
  groups: { admin: 'CCTV Admins', viewer: 'CCTV Viewers', watch: 'CCTV Watch-only' },
  pins: {}, // server -> SHA-256 fingerprint of its certificate
  caPem: '', // or: the domain CA's certificate
  lookupUser: '',
  lookupPassword: '',
  graceHours: 8,
  recheckMinutes: 15,
  timeoutSeconds: 8,
  allowPasswordChange: true
})

const UAC_DISABLED = 0x2
const UAC_LOCKOUT = 0x10

export const MUST_CHANGE_TEXT = 'Your Windows password must be changed. Change it on a Windows PC, then sign in again.'
export const CHANGED_TEXT = 'Your Windows password has been changed. Use the new one on your PC too.'

/** What a refused sign-in or password change says, and the HTTP status it goes back with. */
export const REFUSALS = Object.freeze({
  'wrong-password': [401, 'Wrong user name or password'],
  'no-such-user': [401, 'Wrong user name or password'],
  'not-found': [401, 'Wrong user name or password'],
  disabled: [403, 'Your Windows account is disabled. Ask an administrator.'],
  locked: [403, 'Your Windows account is locked out. Wait a while and try again, or ask an administrator.'],
  'password-expired': [403, MUST_CHANGE_TEXT],
  'must-change-password': [403, MUST_CHANGE_TEXT],
  'account-expired': [403, 'Your Windows account has expired. Ask an administrator.'],
  'time-restricted': [403, 'Your Windows account may not sign in at this time of day.'],
  'workstation-restricted': [403, 'Your Windows account may not sign in from here.'],
  'no-group': [403, 'Your account is not in a CCTV group. Ask an administrator.'],
  'sso-local': [403, 'That name is a local Argus account: sign in with its Argus password.'],
  'local-name': [401, 'That name is a local Argus account: sign in with just the name and its Argus password.'],
  'renamed-onto-local': [409, 'Your Windows account was renamed to a name that is also a local Argus account, so it cannot sign in. Ask an administrator.'],
  'rename-failed': [503, 'Your Windows account was renamed and Argus could not move your settings to the new name. Try again, or ask an administrator.'],
  unreachable: [503, 'The Windows sign-in servers cannot be reached right now. Try again later, or use a local Argus account.'],
  config: [503, 'Windows sign-in is not set up correctly. Ask an administrator.'],
  // changing a Windows password
  'wrong-current': [400, 'The current password is wrong.'],
  policy: [400, 'The new password does not meet the domain’s password rules — length, complexity or history (or the password was changed too recently). Choose another.'],
  'same-password': [400, 'Choose a new password that is different from the current one.'],
  'change-off': [403, 'Change your Windows password on a Windows PC.'],
  'no-change-right': [503, 'Argus may not change Windows passwords on this domain. Change it on a Windows PC, and tell an administrator.']
})
const refusal = (reason, extra = {}) => ({ ok: false, reason, status: REFUSALS[reason]?.[0] ?? 401, message: REFUSALS[reason]?.[1] ?? 'Sign-in refused', ...extra })
const MUST_CHANGE = new Set(['password-expired', 'must-change-password'])

// ---- settings --------------------------------------------------------------------------------------

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/
const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/
const DN_RE = /^[A-Za-z][A-Za-z0-9-]*=(?:[^,\\]|\\.)+(?:\s*,\s*[A-Za-z][A-Za-z0-9-]*=(?:[^,\\]|\\.)+)*$/
const CTRL_RE = /[\u0000-\u001f\u007f]/

const bad = (message) => Object.assign(new Error(message), { status: 400 })

/** A server as typed, checked: "host" or "host:port"; null if it is not one. */
export function cleanServer(text) {
  const s = String(text ?? '').trim()
  const sp = splitServer(s)
  if (!sp || !HOST_RE.test(sp.host) || sp.host.length > 253) return null
  return sp.port === 636 ? sp.host : `${sp.host}:${sp.port}`
}

/** The domain CA as a PEM bundle, checked; '' for none. Throws with a plain message. */
export function cleanCaPem(text) {
  const s = String(text ?? '').trim()
  if (!s) return ''
  if (s.length > 64 * 1024) throw bad('The CA certificate text is too long.')
  const pems = s.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)
  if (!pems) throw bad('The CA certificate must be in PEM form: the text from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----.')
  for (const p of pems) {
    try {
      new X509Certificate(p)
    } catch {
      throw bad('The CA certificate could not be read. Paste the whole PEM text, Base-64 encoded (.cer exported as "Base-64 encoded X.509").')
    }
  }
  return pems.join('\n')
}

/**
 * Settings from the page, checked and merged over the current ones. Throws an Error with status 400
 * and a plain message. The look-up password is kept unless a new one is given (the page never
 * receives it back), and cleared with the look-up user.
 */
export function validateAdSettings(input, current = AD_DEFAULTS) {
  const b = input && typeof input === 'object' ? input : {}
  const out = { ...AD_DEFAULTS, ...current, groups: { ...AD_DEFAULTS.groups, ...(current.groups ?? {}) }, pins: { ...(current.pins ?? {}) } }
  if ('enabled' in b) out.enabled = b.enabled === true
  if ('allowPasswordChange' in b) out.allowPasswordChange = b.allowPasswordChange === true
  if ('servers' in b) {
    const list = (Array.isArray(b.servers) ? b.servers : String(b.servers ?? '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean)
    if (!list.length) throw bad('Give at least one domain controller.')
    if (list.length > 6) throw bad('Give at most 6 domain controllers.')
    const clean = []
    for (const s of list) {
      const c = cleanServer(s)
      if (!c) throw bad(`"${s.slice(0, 80)}" is not a server address. Use a name or IP address, with :port only if it is not 636.`)
      if (!clean.includes(c)) clean.push(c)
    }
    out.servers = clean
  }
  if ('domain' in b) {
    const d = String(b.domain ?? '').trim()
    if (!DOMAIN_RE.test(d)) throw bad('The domain is the full DNS name of the domain, like JFL.LOCAL.')
    out.domain = d.toUpperCase()
  }
  if ('baseDn' in b) {
    const dn = String(b.baseDn ?? '').trim()
    if (!DN_RE.test(dn) || dn.length > 512 || CTRL_RE.test(dn)) throw bad('The base DN looks like DC=JFL,DC=LOCAL.')
    out.baseDn = dn
  }
  if ('groups' in b) {
    const g = b.groups && typeof b.groups === 'object' ? b.groups : {}
    for (const role of ROLE_ORDER) {
      if (!(role in g)) continue
      const name = String(g[role] ?? '').trim()
      if (name.length > 256 || CTRL_RE.test(name)) throw bad(`The group for ${ROLE_LABELS[role]} is not a group name.`)
      out.groups[role] = name
    }
    if (!ROLE_ORDER.some((r) => out.groups[r])) throw bad('Name at least one AD group.')
  }
  if ('caPem' in b) out.caPem = cleanCaPem(b.caPem)
  if ('lookupUser' in b) {
    const u = String(b.lookupUser ?? '').trim()
    if (u && !parseTypedName(u, out.domain)) throw bad('The look-up account is a Windows user name, like svc-cctv or JFL\\svc-cctv.')
    if (u !== out.lookupUser) out.lookupPassword = ''
    out.lookupUser = u
  }
  if (typeof b.lookupPassword === 'string' && b.lookupPassword !== '') {
    if (b.lookupPassword.length > 1024) throw bad('That password is too long.')
    out.lookupPassword = b.lookupPassword
  }
  if (!out.lookupUser) out.lookupPassword = ''
  const num = (key, lo, hi, what) => {
    if (!(key in b)) return
    const n = Number(b[key])
    if (!Number.isFinite(n) || n < lo || n > hi) throw bad(`${what} must be between ${lo} and ${hi}.`)
    out[key] = Math.round(n * 100) / 100
  }
  num('graceHours', 0.25, 72, 'The hours a session lasts without the servers')
  num('recheckMinutes', 5, 240, 'The minutes between re-checks')
  num('timeoutSeconds', 2, 30, 'The seconds to wait for a server')
  // a pin for a server no longer listed is dropped
  for (const s of Object.keys(out.pins)) if (!out.servers.includes(s) || !normaliseFingerprint(out.pins[s])) delete out.pins[s]
  if (out.enabled) {
    const untrusted = out.servers.filter((s) => !out.pins[s] && !out.caPem)
    if (untrusted.length) throw bad(`Before turning this on, check and trust the certificate of ${untrusted.join(' and ')} (or give the domain's CA certificate).`)
  }
  return out
}

/** The settings as the page sees them: never the look-up password. */
export function publicSettings(s) {
  const { lookupPassword, ...rest } = s
  return {
    ...rest,
    lookupPasswordSet: Boolean(lookupPassword),
    trust: Object.fromEntries(s.servers.map((sv) => [sv, s.pins[sv] ? 'pinned' : s.caPem ? 'ca' : 'none']))
  }
}

export function makeAdStore(file = join(DATA_DIR, 'active-directory.json')) {
  let cache = null
  return {
    file,
    get() {
      if (cache) return cache
      let raw = {}
      try {
        if (existsSync(file)) raw = JSON.parse(readFileSync(file, 'utf8')) ?? {}
      } catch (e) {
        console.error(`[ad] ${file} is unreadable (${e.message}); Windows sign-in stays off until it is saved again`)
        raw = { enabled: false }
      }
      cache = { ...AD_DEFAULTS, ...raw, groups: { ...AD_DEFAULTS.groups, ...(raw.groups ?? {}) }, pins: { ...(raw.pins ?? {}) } }
      return cache
    },
    save(s) {
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileAtomicSync(file, `${JSON.stringify(s, null, 2)}\n`) // 0600: it may hold the look-up password
      cache = null
    }
  }
}

// ---- names ----------------------------------------------------------------------------------------

/**
 * What a typed name means to AD: "bob", "JFL\bob" -> sAMAccountName bob, bound as bob@JFL.LOCAL;
 * "bob@jfl.local" -> the same; "bob@other.suffix" -> bound and found by that userPrincipalName.
 * @returns {{ sam?: string, upn: string, bindName: string } | null}
 */
export function parseTypedName(typed, domain) {
  const t = String(typed ?? '').trim()
  if (!t || t.length > 256 || CTRL_RE.test(t)) return null
  // characters Windows does not allow in a logon name
  const samOk = (s) => s.length >= 1 && s.length <= 104 && !/["/\\[\]:;|=,+*?<>@]/.test(s) && !/^\.+$/.test(s) && s.trim() === s
  const slash = t.indexOf('\\')
  if (slash >= 0) {
    const sam = t.slice(slash + 1)
    if (!samOk(sam) || !t.slice(0, slash)) return null
    return { sam, upn: `${sam}@${domain}`, bindName: `${sam}@${domain}` }
  }
  const at = t.lastIndexOf('@')
  if (at >= 0) {
    const sam = t.slice(0, at)
    const suffix = t.slice(at + 1)
    if (!samOk(sam) || !DOMAIN_RE.test(suffix)) return null
    if (suffix.toLowerCase() === String(domain).toLowerCase()) return { sam, upn: `${sam}@${domain}`, bindName: `${sam}@${domain}` }
    return { upn: t, bindName: t }
  }
  if (!samOk(t)) return null
  return { sam: t, upn: `${t}@${domain}`, bindName: `${t}@${domain}` }
}

/** The highest role among those a person is in, or null. */
export function roleFrom(memberOf) {
  return ROLE_ORDER.find((r) => memberOf.has(r)) ?? null
}

// ---- talking to AD --------------------------------------------------------------------------------

/** AD's reason for a refused bind, as one of REFUSALS' keys. */
export function bindRefusal(result) {
  const r = result?.adReason
  if (r && REFUSALS[r]) return r
  return 'wrong-password'
}

/**
 * AD's answer to a password change it refused, as one of REFUSALS' keys. AD says constraintViolation
 * (19) both for a wrong current password (Windows error 0x56, "00000056: AtrErr") and for a new one
 * against the policy (0x52D, "0000052D: Constraint violation"); unwillingToPerform (53) for a change
 * it will not do now (minimum password age, an unencrypted connection); 50 when the bound account
 * may not change it.
 */
export function changeRefusal(result) {
  const text = String(result?.message ?? '')
  if (result?.code === 49) return 'wrong-current'
  if (result?.code === 19 && /^0*56\b/i.test(text)) return 'wrong-current'
  if (result?.code === 19 || result?.code === 53) return 'policy'
  if (result?.code === 50) return 'no-change-right'
  return 'config'
}

/**
 * Runs fn(client, server) against the first server that answers and whose certificate is trusted.
 * A server that cannot be reached, times out, refuses TLS, or says busy/unavailable: the next one.
 * @returns {Promise<any>} fn's answer; throws { unreachable: true, errors } when none would do
 */
export async function withServer(s, fn, open = ldapOpen) {
  const errors = []
  for (const server of s.servers) {
    const sp = splitServer(server)
    if (!sp) continue
    let client
    try {
      client = await open({ host: sp.host, port: sp.port, pin: s.pins?.[server], ca: s.caPem || undefined, timeoutMs: s.timeoutSeconds * 1000 })
    } catch (e) {
      errors.push(`${server}: ${e.message}`)
      continue
    }
    try {
      return await fn(client, server)
    } catch (e) {
      const retry = e instanceof LdapError && (e.kind === 'connect' || e.kind === 'timeout' || e.kind === 'protocol' || (e.kind === 'result' && [51, 52].includes(e.result?.code)))
      if (!retry) throw e
      errors.push(`${server}: ${e.message}`)
    } finally {
      client.close()
    }
  }
  throw Object.assign(new Error(errors.join('; ') || 'No domain controller is set'), { unreachable: true, errors })
}

/**
 * The DN of each mapped group, looked up by name (cn or sAMAccountName, any capitals).
 * @returns {Promise<Record<'admin'|'viewer'|'watch', string|null>>}
 */
export async function resolveGroups(client, s) {
  const names = ROLE_ORDER.map((r) => s.groups[r]).filter(Boolean)
  const out = { admin: null, viewer: null, watch: null }
  if (!names.length) return out
  const any = names.flatMap((n) => [`(cn=${escapeFilterValue(n)})`, `(sAMAccountName=${escapeFilterValue(n)})`]).join('')
  const { entries } = await client.search({ base: s.baseDn, scope: 'sub', filter: `(&(objectClass=group)(|${any}))`, attributes: ['cn', 'sAMAccountName'], sizeLimit: 50, timeLimit: s.timeoutSeconds })
  for (const role of ROLE_ORDER) {
    const want = String(s.groups[role] ?? '').toLowerCase()
    if (!want) continue
    const hit = entries.find((e) => [...(e.attributes.cn ?? []), ...(e.attributes.samaccountname ?? [])].some((v) => v.toLowerCase() === want))
    out[role] = hit?.dn ?? null
  }
  return out
}

/** "a1b2...-..." -> the 16 bytes AD stores (the inverse of guidToString). */
export function guidBytes(guid) {
  const hex = String(guid ?? '').replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null
  const b = Buffer.from(hex, 'hex')
  return Buffer.from([b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], ...b.subarray(8)])
}

/** The search filter that finds one person: by objectGUID when known, else by name. */
export function personFilter(who) {
  const g = who.guid ? guidBytes(who.guid) : null
  const by = g ? `(objectGUID=${escapeFilterBytes(g)})` : who.sam ? `(sAMAccountName=${escapeFilterValue(who.sam)})` : `(userPrincipalName=${escapeFilterValue(who.upn)})`
  return `(&(objectCategory=person)(objectClass=user)${by})`
}

/** The person's own entry: DN, objectGUID, names, account flags. null when not exactly one. */
export async function findPerson(client, s, who) {
  const { entries } = await client.search({ base: s.baseDn, scope: 'sub', filter: personFilter(who), attributes: ['objectGUID', 'sAMAccountName', 'displayName', 'userAccountControl', 'userPrincipalName'], sizeLimit: 2, timeLimit: s.timeoutSeconds })
  if (entries.length !== 1) return null
  const e = entries[0]
  const uac = Number(e.attributes.useraccountcontrol?.[0] ?? 0)
  return {
    dn: e.dn,
    guid: guidToString(e.raw?.objectguid?.[0]),
    name: e.attributes.samaccountname?.[0] ?? who.sam ?? who.upn,
    displayName: e.attributes.displayname?.[0] ?? '',
    disabled: (uac & UAC_DISABLED) !== 0,
    locked: (uac & UAC_LOCKOUT) !== 0
  }
}

/**
 * One person's entry and role, read over a connection already bound (as them, or as the look-up
 * account). @returns {Promise<{ found: false } | { found: true, dn, guid, name, displayName, disabled,
 *   locked, role, groups }>}
 */
export async function lookupPerson(client, s, who) {
  const p = await findPerson(client, s, who)
  if (!p) return { found: false }
  const groups = await resolveGroups(client, s)
  const memberOf = new Set()
  // highest first, and stop at the first: that is the role
  for (const role of ROLE_ORDER) {
    if (!groups[role]) continue
    const r = await client.search({ base: p.dn, scope: 'base', filter: `(memberOf:${IN_CHAIN}:=${escapeFilterValue(groups[role])})`, attributes: ['1.1'], sizeLimit: 1, timeLimit: s.timeoutSeconds })
    if (r.entries.length) {
      memberOf.add(role)
      break
    }
  }
  return { found: true, ...p, role: roleFrom(memberOf), groups }
}

/**
 * Checks a name and password against AD. Never throws.
 * @returns {Promise<{ ok: true, guid, name, displayName, role, groups, server } | { ok: false, reason, status, message, detail? }>}
 */
export async function authenticate(s, typed, password, { open = ldapOpen } = {}) {
  const who = parseTypedName(typed, s.domain)
  if (!who) return refusal('wrong-password', { detail: 'not a Windows user name' })
  if (typeof password !== 'string' || password === '') return refusal('wrong-password', { detail: 'no password' })
  try {
    return await withServer(
      s,
      async (client, server) => {
        try {
          await client.bind(who.bindName, password)
        } catch (e) {
          if (e instanceof LdapError && e.kind === 'result' && e.result?.code === 49) return refusal(bindRefusal(e.result), { detail: `AD ${e.result.adCode ?? 'invalid credentials'}`, server })
          throw e
        }
        const p = await lookupPerson(client, s, who)
        if (!p.found) return refusal('not-found', { detail: `not found under ${s.baseDn}`, server })
        if (p.disabled) return refusal('disabled', { server })
        if (!p.role) return refusal('no-group', { server, groups: p.groups, name: p.name })
        if (!p.guid) return refusal('config', { detail: 'the directory did not give the objectGUID', server })
        return { ok: true, guid: p.guid, name: p.name, displayName: p.displayName, role: p.role, groups: p.groups, server }
      },
      open
    )
  } catch (e) {
    if (e.unreachable) return refusal('unreachable', { detail: e.message })
    console.error(`[ad] sign-in check failed: ${e.message}`)
    return refusal('config', { detail: e.message })
  }
}

/**
 * Changes a Windows password the way a person does it themselves: delete the old unicodePwd value,
 * add the new one, in one modify. Bound as the person; when AD will not let them bind because the
 * password must be changed (532 / 773), bound as the look-up account instead (AD then checks the old
 * value itself). Never throws. @returns {Promise<{ ok: true, name } | { ok: false, reason, status, message, detail? }>}
 */
export async function changeWindowsPassword(s, typed, oldPassword, newPassword, { open = ldapOpen } = {}) {
  if (!s.allowPasswordChange) return refusal('change-off')
  const who = parseTypedName(typed, s.domain)
  if (!who) return refusal('wrong-current', { detail: 'not a Windows user name' })
  if (typeof oldPassword !== 'string' || !oldPassword) return refusal('wrong-current', { detail: 'no current password' })
  if (typeof newPassword !== 'string' || !newPassword || newPassword.length > 256) return refusal('policy', { detail: 'empty or too long' })
  if (newPassword === oldPassword) return refusal('same-password')
  try {
    return await withServer(
      s,
      async (client, server) => {
        let asLookup = false
        try {
          await client.bind(who.bindName, oldPassword)
        } catch (e) {
          if (!(e instanceof LdapError && e.kind === 'result' && e.result?.code === 49)) throw e
          const why = bindRefusal(e.result)
          if (!MUST_CHANGE.has(why)) return refusal(why === 'wrong-password' || why === 'no-such-user' ? 'wrong-current' : why, { detail: `AD ${e.result.adCode ?? 'invalid credentials'}`, server })
          // the old password is right, and AD wants it changed: only the look-up account can bind now
          if (!s.lookupUser || !s.lookupPassword) return refusal(why, { detail: 'no look-up account to change it through', server })
          await client.bind(parseTypedName(s.lookupUser, s.domain).bindName, s.lookupPassword)
          asLookup = true
        }
        const p = await findPerson(client, s, who)
        if (!p) return refusal('not-found', { server })
        try {
          await client.modify(p.dn, [
            { op: 'delete', type: 'unicodePwd', values: [unicodePwd(oldPassword)] },
            { op: 'add', type: 'unicodePwd', values: [unicodePwd(newPassword)] }
          ])
        } catch (e) {
          if (e instanceof LdapError && e.kind === 'result') {
            const why = changeRefusal(e.result)
            return refusal(why, { detail: `AD ${e.result.name}${asLookup ? ' (through the look-up account)' : ''}`, server })
          }
          throw e
        }
        return { ok: true, name: p.name, server }
      },
      open
    )
  } catch (e) {
    if (e.unreachable) return refusal('unreachable', { detail: e.message })
    console.error(`[ad] password change failed: ${e.message}`)
    return refusal('config', { detail: e.message })
  }
}

// ---- the AD users in users.json ---------------------------------------------------------------------

/** The account in users.json a name means, any capitals: [key, record] or null. */
const findAccount = (users, name) => {
  const key = Object.keys(users).find((u) => u.toLowerCase() === String(name).toLowerCase())
  return key === undefined ? null : [key, users[key]]
}
export const isLocalAccount = (u) => Boolean(u) && u.source !== 'ad'

/**
 * Notes an AD sign-in in users.json (never a password), by objectGUID: a renamed account takes its
 * old name's record and everything else with it (renamers), all or nothing.
 * @param {{ guid, name, role, displayName }} person
 * @param {{ now: number, graceMs: number, renamers?: ((from: string, to: string) => () => void)[] }} o
 * @returns {{ name, isNew, renamedFrom?, replaced? } | { error: 'local-name'|'renamed-onto-local'|'rename-failed', from?, detail? }}
 */
export function recordAdUser(person, { now, graceMs, renamers = [], forgetRights = () => {} }) {
  const users = loadUsers()
  const byGuid = Object.entries(users).find(([, u]) => u.source === 'ad' && u.adGuid === person.guid) ?? null
  const holder = findAccount(users, person.name)
  const renamed = byGuid && byGuid[0] !== person.name
  if (holder && isLocalAccount(holder[1])) return renamed ? { error: 'renamed-onto-local', from: byGuid[0] } : { error: 'local-name' }
  const fresh = { role: person.role, source: 'ad', adGuid: person.guid, displayName: String(person.displayName ?? '').slice(0, 128), lastSignIn: now, adCheckedAt: now, adValidUntil: now + graceMs }
  if (renamed) {
    const from = byGuid[0]
    // a record already under the new name is somebody else's (another objectGUID): theirs goes
    const replaced = holder && holder[0] !== from ? holder[0] : null
    const undo = []
    try {
      // the departed holder's rights must not be what the renamed person inherits
      if (replaced) forgetRights(replaced)
      for (const move of renamers) undo.push(move(from, person.name))
      const now2 = loadUsers()
      const { hash, mustChangePassword, ...kept } = now2[from] ?? byGuid[1]
      delete now2[from]
      if (replaced) delete now2[replaced]
      now2[person.name] = { ...kept, ...fresh }
      saveUsers(now2) // the old name has no account now: its sessions are refused from here on
    } catch (e) {
      for (const u of undo.reverse()) {
        try {
          u()
        } catch (e2) {
          console.error(`[ad] undoing a rename step failed: ${e2.message}`)
        }
      }
      return { error: 'rename-failed', from, detail: e.message }
    }
    return { name: person.name, isNew: false, renamedFrom: from, replacedOld: replaced }
  }
  // the same name held by a different objectGUID: that account was deleted from AD and the name reused
  const reused = holder && holder[1].adGuid && holder[1].adGuid !== person.guid
  const key = holder ? holder[0] : person.name
  const { hash, mustChangePassword, ...before } = holder && !reused ? holder[1] : { since: now }
  users[key] = { ...before, ...(reused ? { since: Math.max(now, (holder[1].since || 0) + 1) } : {}), ...fresh }
  saveUsers(users)
  return { name: key, isNew: !holder || Boolean(reused), replaced: reused ? key : null }
}

// ---- the whole of it, for server.mjs and ad-api.mjs --------------------------------------------------

/**
 * @param {{ store?: ReturnType<typeof makeAdStore>, open?: typeof ldapOpen, now?: () => number,
 *   audit?: (row: object) => void, forgetRights?: (name: string) => void,
 *   renamers?: ((from: string, to: string) => () => void)[] }} [o]
 *   renamers: each moves what is kept under a user name and returns how to undo that (server.mjs)
 */
export function makeAd({ store = makeAdStore(), open = ldapOpen, now = Date.now, audit = () => {}, forgetRights = () => {}, renamers = [] } = {}) {
  const state = { lastRecheck: null, lastRecheckError: null, running: false }
  let onEnded = () => {}
  const ended = (n) => {
    try {
      onEnded(n)
    } catch (e) {
      console.error(`[ad] ending ${n}'s sessions: ${e.message}`)
    }
  }

  /** Can this person change an expired / must-change password here (the sign-in page offers it)? */
  const canChangeExpired = (s) => s.allowPasswordChange && Boolean(s.lookupUser && s.lookupPassword)

  /**
   * A sign-in from the login page, the app or anything else on /api/login.
   * @returns {Promise<null | { ok: true, user } | { ok: false, status, message, count: boolean, canChangePassword?: boolean }>}
   *   null: not ours (AD off, or a local account of that name), go on as before
   */
  async function login(typed, password, { ip = '' } = {}) {
    const s = store.get()
    if (!s.enabled) return null
    const users = loadUsers()
    const local = accountName(typed, users)
    if (Object.hasOwn(users, local) && isLocalAccount(users[local])) return null // local accounts always win
    const who = parseTypedName(typed, s.domain)
    // "JFL\mike" where mike is a local account: the local one, which AD must not stand in for
    const twin = who?.sam ? findAccount(users, who.sam) : null
    let r
    if (twin && isLocalAccount(twin[1])) r = refusal('local-name')
    else r = await authenticate(s, typed, password, { open })
    const shown = r.name ?? who?.sam ?? String(typed ?? '').trim()
    const done = finish(r, shown, { ip, how: 'Active Directory' })
    if (done.ok) return done
    const change = MUST_CHANGE.has(done.reason) && canChangeExpired(s)
    // a DC that cannot be reached is not somebody guessing passwords
    return { ok: false, status: done.status, message: change ? 'Your Windows password must be changed. You can change it here.' : done.message, count: !['unreachable', 'config', 'password-expired', 'must-change-password'].includes(done.reason), ...(change ? { canChangePassword: true } : {}) }
  }

  /**
   * After AD said yes (or no): the users.json record, renames and the audit row, one path for a
   * password sign-in and for Windows single sign-on (`how` names which in the audit).
   * @returns {{ ok: true, user } | { ok: false, status, message, reason }}
   */
  function finish(r, shown, { ip, how }) {
    if (r.ok) {
      const s = store.get()
      const rec = recordAdUser(r, { now: now(), graceMs: s.graceHours * 3_600_000, renamers, forgetRights })
      if (rec.error) {
        if (rec.from) audit({ user: r.name, action: 'login-failed', ip, ok: false, detail: `${how}: renamed in AD: ${rec.from} → ${r.name}, ${rec.error === 'renamed-onto-local' ? 'refused: a local account has that name' : `not carried over (${rec.detail})`}` })
        r = refusal(rec.error)
      } else {
        if (rec.renamedFrom) {
          audit({ user: rec.name, action: 'settings-change', target: rec.renamedFrom, ip, detail: `renamed in AD: ${rec.renamedFrom} → ${rec.name}` })
          console.log(`[ad] renamed in AD: ${rec.renamedFrom} -> ${rec.name}; rights, views and preferences moved`)
          ended(rec.renamedFrom)
          if (rec.replacedOld) ended(rec.replacedOld)
        }
        if (rec.replaced) {
          forgetRights(rec.replaced) // the name's earlier holder's rights are not the newcomer's
          ended(rec.replaced)
        }
        if (rec.isNew && !rec.replaced) forgetRights(rec.name) // a row left behind by an earlier account of this name
        audit({ user: rec.name, action: 'login', ip, detail: `${how}, ${ROLE_LABELS[r.role]}${r.server ? ` (${r.server})` : ''}` })
        console.log(`[ad] ${how}: login ok for "${rec.name}" (${r.role}) from ${ip}`)
        return { ok: true, user: rec.name }
      }
    }
    audit({ user: shown, action: 'login-failed', ip, ok: false, detail: `${how}: ${r.reason}${r.detail ? ` (${r.detail})` : ''}` })
    console.log(`[ad] ${how}: login refused for "${shown}" from ${ip}: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`)
    return { ok: false, status: r.status, message: r.message, reason: r.reason }
  }

  /**
   * Windows single sign-on (sso.mjs): the browser proved with a Kerberos ticket that it is `name` of
   * this domain. There is no password to bind with, so the person is read through the look-up account
   * (by sAMAccountName: objectGUID, groups, enabled), and it then ends exactly as a password sign-in
   * does (finish): the same record, role, renames and audit. A local Argus account of that name is
   * never signed in this way. Never throws.
   * @returns {Promise<{ ok: true, user } | { ok: false, status, message, reason }>}
   */
  async function loginSso(name, { ip = '' } = {}) {
    const s = store.get()
    const who = parseTypedName(String(name ?? ''), s.domain)
    const holder = who?.sam ? findAccount(loadUsers(), who.sam) : null
    let r
    if (!s.enabled) r = refusal('config', { detail: 'Windows sign-in (Active Directory) is off' })
    else if (!who?.sam) r = refusal('not-found', { detail: 'not a Windows user name' })
    else if (holder && isLocalAccount(holder[1])) r = refusal('sso-local')
    else if (!s.lookupUser || !s.lookupPassword) r = refusal('config', { detail: 'single sign-on needs the look-up account' })
    else {
      try {
        const svc = parseTypedName(s.lookupUser, s.domain)
        r = await withServer(
          s,
          async (client, server) => {
            await client.bind(svc.bindName, s.lookupPassword)
            const p = await lookupPerson(client, s, { sam: who.sam })
            if (!p.found) return refusal('not-found', { detail: `not found under ${s.baseDn}`, server })
            if (p.disabled) return refusal('disabled', { server })
            if (!p.role) return refusal('no-group', { server, groups: p.groups, name: p.name })
            if (!p.guid) return refusal('config', { detail: 'the directory did not give the objectGUID', server })
            return { ok: true, guid: p.guid, name: p.name, displayName: p.displayName, role: p.role, groups: p.groups, server }
          },
          open
        )
      } catch (e) {
        r = e.unreachable ? refusal('unreachable', { detail: e.message }) : refusal('config', { detail: `the look-up account could not read the directory: ${e.message}` })
      }
    }
    return finish(r, r.name ?? who?.sam ?? String(name ?? ''), { ip, how: 'Windows single sign-on' })
  }

  /**
   * The sign-in page's "Change your Windows password" (an expired / must-change password), then the
   * sign-in itself with the new one. Same answers as login(), plus `changed`.
   */
  async function changeExpired(typed, oldPassword, newPassword, { ip = '' } = {}) {
    const s = store.get()
    if (!s.enabled) return { ok: false, status: 404, message: 'Windows sign-in is off.', count: false }
    const users = loadUsers()
    const local = accountName(typed, users)
    const who = parseTypedName(typed, s.domain)
    const twin = who?.sam ? findAccount(users, who.sam) : null
    if ((Object.hasOwn(users, local) && isLocalAccount(users[local])) || (twin && isLocalAccount(twin[1]))) return { ok: false, status: 400, message: REFUSALS['local-name'][1], count: true }
    const r = await changeWindowsPassword(s, typed, oldPassword, newPassword, { open })
    const shown = r.name ?? who?.sam ?? String(typed ?? '').trim()
    if (!r.ok) {
      audit({ user: shown, action: 'password-change', ip, ok: false, detail: `Windows password (Active Directory) not changed: ${r.reason}${r.detail ? ` (${r.detail})` : ''}` })
      return { ok: false, status: r.status, message: r.message, count: !['unreachable', 'config', 'policy', 'same-password'].includes(r.reason) }
    }
    audit({ user: shown, action: 'password-change', ip, detail: 'changed Windows password (Active Directory), from the sign-in page' })
    console.log(`[ad] ${shown} changed their Windows password from ${ip}`)
    const signedIn = await login(r.name, newPassword, { ip })
    if (signedIn?.ok) return { ...signedIn, changed: true, message: CHANGED_TEXT }
    return { ok: false, changed: true, status: signedIn?.status ?? 503, message: `${CHANGED_TEXT} ${signedIn?.message ?? ''}`.trim(), count: false }
  }

  /** Change password, signed in: auth.changePassword hands an AD user's change here. */
  async function changeSignedIn(user, current, next) {
    const s = store.get()
    if (!s.enabled) return { error: 'Windows sign-in is off: change your password on a Windows PC.' }
    const r = await changeWindowsPassword(s, user, current, next, { open })
    if (!r.ok) {
      audit({ user, action: 'password-change', ok: false, detail: `Windows password (Active Directory) not changed: ${r.reason}${r.detail ? ` (${r.detail})` : ''}` })
      return { error: r.message }
    }
    console.log(`[ad] ${user} changed their Windows password`)
    return { ok: true, message: CHANGED_TEXT }
  }
  setWindowsPasswordChanger(changeSignedIn)

  /** AD users whose sessions may still be good and whose last check is older than recheckMinutes. */
  const due = (s, t) =>
    Object.entries(loadUsers())
      .filter(([, u]) => u.source === 'ad' && u.adValidUntil > t && t - (u.adCheckedAt || 0) >= s.recheckMinutes * 60_000)
      .map(([n]) => n)

  /**
   * Looks every due AD user up again with the look-up account. @returns {Promise<{ checked, ended, kept, error? }>}
   */
  async function recheck({ force = false } = {}) {
    const s = store.get()
    const t = now()
    if (!s.enabled || !s.lookupUser || !s.lookupPassword || state.running) return { checked: 0, ended: [], kept: 0 }
    const names = force ? Object.entries(loadUsers()).filter(([, u]) => u.source === 'ad' && u.adValidUntil > t).map(([n]) => n) : due(s, t)
    if (!names.length) return { checked: 0, ended: [], kept: 0 }
    state.running = true
    const outcome = new Map() // name -> person | { found: false }
    const recs = loadUsers()
    try {
      const svc = parseTypedName(s.lookupUser, s.domain)
      await withServer(
        s,
        async (client) => {
          await client.bind(svc.bindName, s.lookupPassword)
          for (const n of names) outcome.set(n, await lookupPerson(client, s, recs[n]?.adGuid ? { guid: recs[n].adGuid } : { sam: n }))
        },
        open
      )
      state.lastRecheckError = null
    } catch (e) {
      // nobody answered, or the look-up account itself was refused: sessions run on to adValidUntil
      state.lastRecheckError = e.unreachable ? `No domain controller answered: ${e.message}` : `The look-up account could not read the directory: ${e.message}`
      console.error(`[ad] re-check: ${state.lastRecheckError}`)
    } finally {
      state.running = false
      state.lastRecheck = now()
    }
    if (!outcome.size) return { checked: 0, ended: [], kept: names.length, error: state.lastRecheckError }
    const t2 = now()
    const users = loadUsers() // as they are now: an admin may have changed something meanwhile
    const gone = []
    for (const [n, p] of outcome) {
      const u = users[n]
      if (!u || u.source !== 'ad') continue
      const renamed = p.found && p.name.toLowerCase() !== n.toLowerCase()
      if (p.found && !p.disabled && p.role && !renamed) {
        users[n] = { ...u, role: p.role, displayName: p.displayName || u.displayName || '', adCheckedAt: t2, adValidUntil: t2 + s.graceHours * 3_600_000 }
      } else {
        const why = !p.found ? 'no longer in the directory' : renamed ? `renamed in AD to ${p.name} (moves over at their next sign-in)` : p.disabled ? 'account disabled' : 'no longer in a CCTV group'
        users[n] = { ...u, adCheckedAt: t2, adValidUntil: 0, since: Math.max(t2 + 1, (u.since || 0) + 1) }
        gone.push([n, why])
      }
    }
    saveUsers(users)
    for (const [n, why] of gone) {
      audit({ user: n, action: 'logout', ok: false, detail: `Active Directory re-check: ${why}; signed out` })
      console.log(`[ad] ${n} signed out: ${why}`)
      ended(n)
    }
    return { checked: outcome.size, ended: gone.map(([n]) => n), kept: 0 }
  }

  /** Ends every AD user's sessions (Windows sign-in switched off). */
  function endAll() {
    const users = loadUsers()
    const ad = Object.keys(users).filter((n) => users[n].source === 'ad' && users[n].adValidUntil > 0)
    if (!ad.length) return []
    for (const n of ad) users[n] = { ...users[n], adValidUntil: 0 }
    saveUsers(users)
    for (const n of ad) ended(n)
    return ad
  }

  let timer = null
  return {
    store,
    state,
    login,
    loginSso,
    changeExpired,
    changeSignedIn,
    recheck,
    endAll,
    authenticate: (s, typed, password) => authenticate(s, typed, password, { open }),
    open,
    /** Starts the re-check timer (every minute it looks for anyone due). */
    start({ ended: fn = () => {}, everyMs = 60_000 } = {}) {
      onEnded = fn
      if (timer) return
      timer = setInterval(() => void recheck().catch((e) => console.error(`[ad] re-check: ${e.message}`)), everyMs)
      timer.unref?.()
    },
    stop() {
      clearInterval(timer)
      timer = null
    }
  }
}
