// Windows single sign-on: a person at a domain PC in the office opens Argus and is signed in as
// their Windows account without typing anything (Kerberos through "Negotiate", RFC 4559). It sits on
// top of the Active Directory sign-in (ad.mjs) and ends exactly as a password sign-in does there: the
// same users.json record, role from the AD groups, renames, audit rows and session cookie.
//
//   GET /api/sso/available -> { available }   no sign-in needed; true only when single sign-on is set
//                              up and switched on AND the request came straight to this server on the
//                              office name (cctv.jfl.gripe), not through the Cloudflare tunnel
//   GET /api/sso            -> without `Authorization: Negotiate …`: 401 + `WWW-Authenticate: Negotiate`
//                              (this route ONLY: no other page or API ever asks for it, so a browser
//                              outside the office never shows a password box anywhere else). With it:
//                              the Kerberos ticket is checked (kerberos.mjs) against the keytab, the
//                              person read from AD through the look-up account (ad.mjs loginSso), and
//                              { user } comes back with the session cookie (server.mjs sets it).
//                              Refusals are 403 with a plain message and never a new challenge, so a
//                              browser cannot loop or fall back to a password prompt.
//   Admins (Settings > Active Directory > Single sign-on), behind server.mjs's /api/admin/ guard:
//   GET  /api/admin/ad/sso          -> { sso: status }  never the keys
//   POST /api/admin/ad/sso          { enabled } -> { sso }
//   POST /api/admin/ad/sso/keytab   { keytab: base64 | null } -> { sso }  checked, kept 0600 in DATA_DIR
//
// The keytab is made on DC01 by deploy/sso-setup-dc.ps1 (ktpass, AES-256 only) and uploaded here.
// CCTV_SSO=off switches all of it off on this server, whatever the setting says.
// Through the tunnel there is no domain controller to get a ticket from, and Cloudflare is not where
// a ticket for cctv.jfl.gripe should travel: there it is simply not offered.

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './auth.mjs'
import { writeFileAtomicSync } from './atomic-write.mjs'
import { KerberosError, SUPPORTED_ETYPES, acceptApReq, buildApRepToken, describeKeytab, etypeName, makeReplayCache, parseKeytab, unwrapNegotiate } from './kerberos.mjs'

export const DEFAULT_HOST = 'cctv.jfl.gripe'
const LOOPBACK = /^(?:::ffff:)?127\.0\.0\.1$|^::1$/
const MAX_TOKEN_CHARS = 48 * 1024
const MAX_KEYTAB_BYTES = 64 * 1024
const RECENT = 25

/** Refusals that are somebody's token being wrong (counted with the failed sign-ins of the address). */
const COUNTED = new Set(['bad-token', 'integrity', 'replay', 'wrong-realm', 'wrong-service', 'name-mismatch', 'ticket-invalid', 'ticket-expired', 'ticket-not-yet', 'not-a-user'])

/** What the person sees when single sign-on did not work: they then use the form. */
const TOKEN_MESSAGE = 'Windows could not sign you in automatically. Sign in with your user name and password.'
const PLAIN = {
  ntlm: 'This PC did not offer a Windows (Kerberos) sign-in for Argus. Sign in with your user name and password.',
  'no-kerberos': 'This PC did not offer a Windows (Kerberos) sign-in for Argus. Sign in with your user name and password.',
  skew: 'This PC’s clock is more than 5 minutes out from the server’s. Sign in with your user name and password, and tell an administrator.'
}

/** Did this request come through the Cloudflare tunnel (cloudflared connects from this machine)? */
export const viaTunnel = (req) => req.headers['cf-connecting-ip'] !== undefined || LOOPBACK.test(req.socket?.remoteAddress ?? '')

/** The Host header's name, lower case, without a port. */
export const hostOf = (req) => String(req.headers.host ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')

/**
 * @param {{ ad: ReturnType<import('./ad.mjs').makeAd>, dataDir?: string, now?: () => number,
 *   env?: NodeJS.ProcessEnv, audit?: (row: object) => void }} o
 */
export function makeSso({ ad, dataDir = DATA_DIR, now = Date.now, env = process.env, audit = () => {} }) {
  const settingsFile = join(dataDir, 'sso.json')
  const keytabFile = join(dataDir, 'sso.keytab')
  const killed = env.CCTV_SSO === 'off'
  const host = String(env.CCTV_SSO_HOST || DEFAULT_HOST).toLowerCase()
  const replay = makeReplayCache()
  const recent = [] // newest first: { at, ok, user, reason, message, ip }
  let settings = null
  let keys // undefined: not read yet; null: none / unreadable

  const readSettings = () => {
    if (settings) return settings
    try {
      settings = existsSync(settingsFile) ? { enabled: false, ...JSON.parse(readFileSync(settingsFile, 'utf8')) } : { enabled: false }
    } catch (e) {
      console.error(`[sso] ${settingsFile} is unreadable (${e.message}); single sign-on stays off until it is saved again`)
      settings = { enabled: false }
    }
    return settings
  }
  const saveSettings = (s) => {
    mkdirSync(dataDir, { recursive: true })
    writeFileAtomicSync(settingsFile, `${JSON.stringify(s, null, 2)}\n`)
    settings = null
  }
  const readKeys = () => {
    if (keys !== undefined) return keys
    try {
      keys = existsSync(keytabFile) ? parseKeytab(readFileSync(keytabFile)) : null
    } catch (e) {
      console.error(`[sso] the keytab ${keytabFile} could not be read: ${e.message}`)
      keys = null
    }
    return keys
  }

  const realm = () => String(ad.store.get().domain ?? '').toUpperCase()
  const service = () => ['HTTP', host]
  const principal = () => `HTTP/${host}@${realm()}`
  const isOurs = (e) => e.realm.toUpperCase() === realm() && e.components.join('/').toLowerCase() === `http/${host}`
  const usableKeys = (list = readKeys()) => (list ?? []).filter((e) => isOurs(e) && SUPPORTED_ETYPES.includes(e.etype))

  /** Why single sign-on cannot work now, in plain words ([] when it can). */
  function problems() {
    const out = []
    const a = ad.store.get()
    if (killed) out.push('Switched off on this server (CCTV_SSO=off).')
    if (!a.enabled) out.push('Windows sign-in (Active Directory) above is off.')
    if (!a.lookupUser || !a.lookupPassword) out.push('It needs the look-up account (above): Argus reads the person’s groups with it.')
    if (!readKeys()) out.push('No keytab uploaded yet.')
    else if (!usableKeys().length) out.push(`The keytab has no AES key for ${principal()}.`)
    return out
  }
  const ready = () => !killed && readSettings().enabled === true && problems().length === 0

  function status() {
    const s = readSettings()
    const list = readKeys()
    const p = problems()
    return {
      killed,
      enabled: s.enabled === true,
      ready: s.enabled === true && p.length === 0 && !killed,
      problems: p,
      servicePrincipal: principal(),
      host,
      keytab: list ? { present: true, uploadedAt: s.keytabUploadedAt ?? null, uploadedBy: s.keytabUploadedBy ?? '', entries: describeKeytab(list).map((e, i) => ({ ...e, matches: isOurs(list[i]) })) } : { present: false },
      recent: recent.slice()
    }
  }

  const note = (row) => {
    recent.unshift({ at: now(), ...row })
    recent.length = Math.min(recent.length, RECENT)
  }

  /**
   * GET /api/sso and /api/sso/available. @returns {Promise<null | { status, body, headers?, user?, count?, clear? }>}
   *   user: sign this browser in as that user (server.mjs makes the session and cookie);
   *   count: a failed sign-in for the address; clear: forget its failed sign-ins
   */
  async function handlePublic(req, pathname, { ip = '', blocked = false } = {}) {
    if (pathname !== '/api/sso' && pathname !== '/api/sso/available') return null
    const noStore = { 'cache-control': 'no-store' }
    if (req.method !== 'GET') return { status: 405, body: { error: 'Method not allowed' }, headers: noStore }
    const here = !viaTunnel(req) && hostOf(req) === host
    if (pathname === '/api/sso/available') return { status: 200, body: { available: ready() && here }, headers: noStore }
    if (killed || !ready()) return { status: 404, body: { error: 'Windows single sign-on is not set up.' }, headers: noStore }
    if (!here) return { status: 403, body: { error: 'Windows single sign-on works only on the office network, at https://' + host + '.' }, headers: noStore }
    // only the sign-in page's own fetch: never an image or a link from another site
    const site = req.headers['sec-fetch-site']
    if ((site !== undefined && site !== 'same-origin') || req.headers['x-argus-sso'] !== '1') return { status: 403, body: { error: 'Forbidden' }, headers: noStore }
    if (blocked) return { status: 429, body: { error: 'Too many attempts, try again later' }, headers: noStore }
    const m = /^Negotiate\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(String(req.headers.authorization ?? ''))
    if (!m) return { status: 401, body: { error: 'Windows sign-in needed' }, headers: { ...noStore, 'www-authenticate': 'Negotiate' } }
    let accepted
    try {
      if (m[1].length > MAX_TOKEN_CHARS) throw new KerberosError('bad-token', 'The token is too large.')
      const token = Buffer.from(m[1], 'base64')
      const { apReq, mech, spnego } = unwrapNegotiate(token)
      accepted = { ...acceptApReq(apReq, { keys: usableKeys(), realm: realm(), service: service(), now: now(), replay }), mech, spnego }
    } catch (e) {
      const code = e instanceof KerberosError ? e.code : 'error'
      if (!(e instanceof KerberosError)) console.error(`[sso] checking a ticket: ${e.stack ?? e.message}`)
      audit({ user: '(Windows single sign-on)', action: 'login-failed', ip, ok: false, detail: `Windows single sign-on: ${code} (${e.message})` })
      console.log(`[sso] refused from ${ip}: ${code}: ${e.message}`)
      note({ ok: false, user: '', reason: code, message: e.message, ip })
      return { status: 403, body: { error: PLAIN[code] ?? TOKEN_MESSAGE, reason: code }, headers: noStore, count: COUNTED.has(code) }
    }
    if (!accepted.kvnoMatched) console.log(`[sso] ${accepted.principal}: the keytab's key version (${accepted.kvno}) is not the ticket's, but its key fits`)
    const r = await ad.loginSso(accepted.user, { ip })
    if (!r.ok) {
      // ad.mjs has audited it with the reason; a person holding a real ticket is not guessing passwords
      note({ ok: false, user: accepted.user, reason: r.reason, message: r.message, ip })
      return { status: r.status === 401 ? 403 : r.status, body: { error: r.message, reason: r.reason }, headers: noStore }
    }
    note({ ok: true, user: r.user, reason: '', message: `signed in (${etypeName(accepted.etype)})`, ip })
    const headers = { ...noStore }
    if (accepted.mutual) {
      try {
        headers['www-authenticate'] = `Negotiate ${buildApRepToken(accepted, { spnego: accepted.spnego, mech: accepted.mech }).toString('base64')}`
      } catch (e) {
        console.error(`[sso] the mutual-authentication answer: ${e.message}`)
      }
    }
    return { status: 200, body: { user: r.user }, headers, user: r.user, clear: true }
  }

  /** Settings > Active Directory > Single sign-on. @returns {Promise<[number, object]|null>} */
  async function handleAdmin(method, pathname, readJson, who, { ip = '', device = '', withDevice = (d) => d } = {}) {
    if (pathname !== '/api/admin/ad/sso' && pathname !== '/api/admin/ad/sso/keytab') return null
    if (!who?.admin) return [403, { error: 'Only an admin can change Windows sign-in' }]
    if (method === 'GET' && pathname === '/api/admin/ad/sso') return [200, { sso: status() }, { 'cache-control': 'no-store' }]
    if (method !== 'POST') return [405, { error: 'Method not allowed' }]
    const body = (await readJson()) ?? {}
    const s = readSettings()
    if (pathname === '/api/admin/ad/sso') {
      if (typeof body.enabled !== 'boolean') return [400, { error: 'Say whether single sign-on is on or off.' }]
      if (body.enabled) {
        const p = problems().filter((x) => !x.startsWith('Switched off on this server'))
        if (p.length) return [400, { error: `Single sign-on cannot be switched on yet: ${p.join(' ')}` }]
      }
      saveSettings({ ...s, enabled: body.enabled })
      audit({ user: who.user, action: 'settings-change', target: 'single sign-on', ip, detail: withDevice(body.enabled ? 'Windows single sign-on turned on' : 'Windows single sign-on turned off', device) })
      return [200, { sso: status() }]
    }
    // the keytab
    if (body.keytab === null) {
      rmSync(keytabFile, { force: true })
      keys = undefined
      saveSettings({ ...s, enabled: false, keytabUploadedAt: null, keytabUploadedBy: '' })
      audit({ user: who.user, action: 'settings-change', target: 'single sign-on', ip, detail: withDevice('keytab removed; single sign-on off', device) })
      return [200, { sso: status() }]
    }
    if (typeof body.keytab !== 'string' || !body.keytab.trim()) return [400, { error: 'Choose the keytab file (argus-sso.keytab) first.' }]
    const raw = Buffer.from(body.keytab.replace(/^data:[^,]*,/, ''), 'base64')
    if (!raw.length || raw.length > MAX_KEYTAB_BYTES) return [400, { error: 'That file is not a keytab (empty or far too large).' }]
    let list
    try {
      list = parseKeytab(raw)
    } catch (e) {
      return [400, { error: e.message }]
    }
    const ours = usableKeys(list)
    if (!ours.length) {
      const has = describeKeytab(list).map((e) => `${e.principal} (${e.etypeName}, version ${e.kvno})`).join('; ')
      const weak = list.some((e) => isOurs(e)) ? ' It has only RC4 or DES keys for it, which Argus does not accept: make it again with /crypto AES256-SHA1.' : ''
      return [400, { error: `This keytab has no AES key for ${principal()}.${weak} It contains: ${has}.` }]
    }
    mkdirSync(dataDir, { recursive: true })
    writeFileAtomicSync(keytabFile, raw) // 0600, and it never goes back to a page
    keys = undefined
    saveSettings({ ...s, keytabUploadedAt: now(), keytabUploadedBy: who.user })
    const summary = ours.map((e) => `${etypeName(e.etype)} version ${e.kvno}`).join(', ')
    audit({ user: who.user, action: 'settings-change', target: 'single sign-on', ip, detail: withDevice(`keytab uploaded for ${principal()}: ${summary}`, device) })
    console.log(`[sso] keytab uploaded by ${who.user}: ${summary}`)
    return [200, { sso: status() }]
  }

  return { handlePublic, handleAdmin, status, ready, killed, host, principal, files: { settingsFile, keytabFile } }
}
