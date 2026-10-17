// Settings > Active Directory, for admins (ad.mjs does the signing in).
//
//   GET  /api/admin/ad          -> { settings, status }        never the look-up password
//   POST /api/admin/ad          { ...settings } -> { settings } saved; switching it off ends AD sessions
//   POST /api/admin/ad/check    { server, caPem? } -> { server, cert, chain, trusted }
//                               connects over LDAPS and shows the certificate; sends no LDAP at all
//   POST /api/admin/ad/trust    { server, fingerprint } -> { settings }  pins that certificate for that
//                               server, if it is still the one the server shows; fingerprint null removes it
//   POST /api/admin/ad/test     { user, password, settings? } -> what that sign-in would get, with the
//                               settings on the page (saved or not); the password is used once and
//                               never stored or logged
//
// Every change is in the audit trail. The test counts with the failed sign-ins of the admin's
// address, so it is no faster a way to guess Windows passwords than the sign-in page.

import { audit, withDevice } from './audit.mjs'
import { DATA_DIR, loginBlocked, recordFailure } from './auth.mjs'
import { AD_DEFAULTS, ROLE_LABELS, cleanServer, lookupPerson, parseTypedName, publicSettings, validateAdSettings, withServer } from './ad.mjs'
import { normaliseFingerprint, splitServer, verifyPeer } from './ldap.mjs'

const err = (status, error) => [status, { error }]

/**
 * @param {ReturnType<import('./ad.mjs').makeAd>} ad
 * @returns {Promise<[number, object]|null>} null when the path is not ours
 */
export async function handleAd(ad, method, pathname, readJson, who, { ip = '', device = '' } = {}) {
  if (pathname !== '/api/admin/ad' && !pathname.startsWith('/api/admin/ad/')) return null
  if (!who?.admin) return err(403, 'Only an admin can change Windows sign-in')
  const store = ad.store
  try {
    if (method === 'GET' && pathname === '/api/admin/ad') {
      return [200, { settings: publicSettings(store.get()), status: { ...ad.state }, defaults: { servers: AD_DEFAULTS.servers, groups: AD_DEFAULTS.groups } }, { 'cache-control': 'no-store' }]
    }
    if (method !== 'POST') return err(405, 'Method not allowed')
    const body = (await readJson()) ?? {}

    if (pathname === '/api/admin/ad') {
      const before = store.get()
      const next = validateAdSettings(body, before)
      store.save(next)
      const changed = describeChange(before, next)
      audit(DATA_DIR, { user: who.user, action: 'settings-change', target: 'active-directory', detail: withDevice(changed || 'saved, nothing changed', device), ip })
      if (before.enabled && !next.enabled) ad.endAll()
      return [200, { settings: publicSettings(next) }]
    }

    if (pathname === '/api/admin/ad/check') {
      const server = cleanServer(body.server)
      if (!server) return err(400, 'Give a server name or IP address.')
      const s = store.get()
      const sp = splitServer(server)
      let ca = s.caPem
      if (typeof body.caPem === 'string' && body.caPem.trim()) ca = validateAdSettings({ caPem: body.caPem }, s).caPem
      let peek
      try {
        peek = await ad.open({ host: sp.host, port: sp.port, peek: true, ca: ca || undefined, timeoutMs: s.timeoutSeconds * 1000 })
      } catch (e) {
        return [200, { server, reachable: false, error: e.message }]
      }
      const pin = s.pins[server]
      const viaPin = pin ? normaliseFingerprint(pin) === normaliseFingerprint(peek.cert?.fingerprint256) : false
      // the CA way: the chain must verify AND the certificate must name the address it was reached at
      const viaCa = ca ? verifyPeer({ cert: { fingerprint256: peek.cert?.fingerprint256, subject: { CN: firstCn(peek.cert?.subject) }, subjectaltname: peek.cert?.altNames }, authorized: peek.authorized, authorizationError: peek.authorizationError, host: sp.host, ca }) : null
      return [200, { server, reachable: true, cert: peek.cert, chain: peek.chain, trusted: { pinned: Boolean(pin), pinMatches: viaPin, ca: viaCa ? viaCa.ok : null, caReason: viaCa && !viaCa.ok ? viaCa.reason : '' } }]
    }

    if (pathname === '/api/admin/ad/trust') {
      const server = cleanServer(body.server)
      const s = store.get()
      if (!server || !s.servers.includes(server)) return err(400, 'Save that server in the list first, then trust its certificate.')
      if (body.fingerprint === null) {
        const next = { ...s, pins: { ...s.pins } }
        delete next.pins[server]
        if (next.enabled && !next.caPem) return err(409, 'Windows sign-in is on and needs this server trusted: turn it off first, or give the CA certificate.')
        store.save(next)
        audit(DATA_DIR, { user: who.user, action: 'settings-change', target: 'active-directory trust', detail: withDevice(`${server}: no longer trusted`, device), ip })
        return [200, { settings: publicSettings(next) }]
      }
      const fp = normaliseFingerprint(body.fingerprint)
      if (!fp) return err(400, 'That is not a SHA-256 fingerprint.')
      // it must still be what the server shows now, not what a page showed earlier
      const sp = splitServer(server)
      let peek
      try {
        peek = await ad.open({ host: sp.host, port: sp.port, peek: true, timeoutMs: s.timeoutSeconds * 1000 })
      } catch (e) {
        return err(502, `Could not reach ${server} to confirm its certificate: ${e.message}`)
      }
      if (normaliseFingerprint(peek.cert?.fingerprint256) !== fp) return err(409, `${server} now shows a different certificate. Check the connection again before trusting it.`)
      const next = { ...s, pins: { ...s.pins, [server]: fp } }
      store.save(next)
      audit(DATA_DIR, { user: who.user, action: 'settings-change', target: 'active-directory trust', detail: withDevice(`${server}: trusted certificate ${peek.cert.subject} (SHA-256 ${fp})`, device), ip })
      return [200, { settings: publicSettings(next) }]
    }

    if (pathname === '/api/admin/ad/test') {
      if (loginBlocked(ip)) return err(429, 'Too many attempts, try again later')
      const s = body.settings && typeof body.settings === 'object' ? validateAdSettings({ ...body.settings, enabled: false }, store.get()) : store.get()
      const user = String(body.user ?? '')
      const password = typeof body.password === 'string' ? body.password : ''
      if (!user || !password) return err(400, 'Type a user name and that person’s password.')
      const r = await ad.authenticate(s, user, password)
      if (!r.ok && r.reason !== 'unreachable' && r.reason !== 'config') recordFailure(ip)
      const groups = r.groups ? Object.fromEntries(Object.entries(r.groups).map(([role, dn]) => [role, { name: s.groups[role], dn }])) : null
      const out = r.ok
        ? { ok: true, name: r.name, displayName: r.displayName, role: r.role, roleLabel: ROLE_LABELS[r.role], server: r.server, groups, message: `${r.name}${r.displayName ? ` (${r.displayName})` : ''} would sign in as ${ROLE_LABELS[r.role]}.` }
        : { ok: false, reason: r.reason, message: r.message, detail: r.detail ?? '', groups }
      // re-checks: can the look-up account find this person too?
      if (r.ok && s.lookupUser && s.lookupPassword) out.lookup = await lookupTest(s, r.name, ad.open)
      audit(DATA_DIR, { user: who.user, action: 'ad-test', target: r.name ?? user.slice(0, 64), ok: r.ok, detail: withDevice(r.ok ? `would be ${r.role}` : `refused: ${r.reason}`, device), ip })
      return [200, out, { 'cache-control': 'no-store' }]
    }
    return err(404, 'Not found')
  } catch (e) {
    if (Number.isInteger(e?.status)) return err(e.status, e.message)
    throw e
  }
}

async function lookupTest(s, name, open) {
  try {
    const svc = parseTypedName(s.lookupUser, s.domain)
    const p = await withServer(
      s,
      async (client) => {
        await client.bind(svc.bindName, s.lookupPassword)
        return lookupPerson(client, s, { sam: name })
      },
      open
    )
    return p.found ? { ok: true, message: `The look-up account can re-check ${name} (${p.role ? ROLE_LABELS[p.role] : 'no CCTV group'}).` } : { ok: false, message: `The look-up account cannot find ${name}.` }
  } catch (e) {
    return { ok: false, message: `The look-up account could not read the directory: ${e.message}` }
  }
}

const firstCn = (subject) => /(?:^|,\s*)CN=([^,]+)/.exec(String(subject ?? ''))?.[1]

/** A short "what changed" for the audit row; never the look-up password or a certificate's text. */
export function describeChange(a, b) {
  const out = []
  if (a.enabled !== b.enabled) out.push(b.enabled ? 'turned on' : 'turned off')
  if (a.servers.join() !== b.servers.join()) out.push(`servers ${b.servers.join(', ')}`)
  if (a.domain !== b.domain) out.push(`domain ${b.domain}`)
  if (a.baseDn !== b.baseDn) out.push(`base DN ${b.baseDn}`)
  for (const r of Object.keys(ROLE_LABELS)) if ((a.groups[r] ?? '') !== (b.groups[r] ?? '')) out.push(`${ROLE_LABELS[r]} group "${b.groups[r]}"`)
  if (a.caPem !== b.caPem) out.push(b.caPem ? 'CA certificate set' : 'CA certificate removed')
  if (a.lookupUser !== b.lookupUser) out.push(b.lookupUser ? `look-up account ${b.lookupUser}` : 'look-up account removed')
  else if (a.lookupPassword !== b.lookupPassword && b.lookupPassword) out.push('look-up password changed')
  if (a.allowPasswordChange !== b.allowPasswordChange) out.push(b.allowPasswordChange ? 'AD users may change their Windows password in Argus' : 'Windows password changes in Argus off')
  if (a.graceHours !== b.graceHours) out.push(`grace ${b.graceHours} h`)
  if (a.recheckMinutes !== b.recheckMinutes) out.push(`re-check every ${b.recheckMinutes} min`)
  if (a.timeoutSeconds !== b.timeoutSeconds) out.push(`timeout ${b.timeoutSeconds} s`)
  return out.join('; ')
}
