// Windows single sign-on, the route and the wiring (sso.mjs, ad.mjs loginSso, server.mjs, the sign-in
// page and Settings), against the fake directory in fake-ldap.mjs and tickets made in kerberos.mjs
// with a test service key (no real KDC): the keytab upload and what the page sees of it, when it is
// offered (office name only, never through Cloudflare), 401 + Negotiate only on /api/sso, the same AD
// record / role / refusals as a password sign-in, local accounts never signed in so, replays and bad
// tokens counted, the kill switch, and the sign-in page's silent try.
//   node cctv/test/sso.test.mjs
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'cctv-sso-'))
process.env.DATA_DIR = dir
const auth = await import('../auth.mjs')
const ad = await import('../ad.mjs')
const { makeSso, viaTunnel } = await import('../sso.mjs')
const k = await import('../kerberos.mjs')
const { ldapOpen } = await import('../ldap.mjs')
const { startFakeLdap, sampleDir } = await import('./fake-ldap.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'

// ---- AD on the fake directory, and the single sign-on on top ----
const fake = await startFakeLdap({ dir: sampleDir() })
const viaFake = (o) => ldapOpen({ ...o, host: '127.0.0.1', port: fake.port, transport: 'tcp', timeoutMs: 3000 })
const store = ad.makeAdStore(join(dir, 'active-directory.json'))
const base = { ...ad.AD_DEFAULTS, enabled: true, pins: { '192.168.0.19': FP, '192.168.1.19': FP }, lookupUser: 'svc-cctv', lookupPassword: 'Svc-pass-1' }
store.save(base)
const rows = []
let clock = Date.UTC(2026, 9, 16, 9, 0, 0)
const A = ad.makeAd({ store, open: viaFake, now: () => clock, audit: (r) => rows.push(r) })
auth.saveUsers({ localboss: { hash: await auth.hashPassword('Local-boss-1'), role: 'admin', since: 1 } })
const env = {}
const S = makeSso({ ad: A, dataDir: dir, now: () => clock, env, audit: (r) => rows.push(r) })

const svcKey = randomBytes(32)
const keytab = k.buildKeytab([{ principal: 'HTTP/cctv.jfl.gripe@JFL.LOCAL', kvno: 3, etype: 18, key: svcKey }])
const boss = { user: 'localboss', admin: true }
const admin = (method, path, body, who = boss) => S.handleAdmin(method, path, async () => body, who, { ip: '192.168.3.10' })
const req = ({ token, headers = {}, peer = '192.168.3.50', method = 'GET' } = {}) => ({ method, socket: { remoteAddress: peer }, headers: { host: 'cctv.jfl.gripe', 'sec-fetch-site': 'same-origin', 'x-argus-sso': '1', ...(token ? { authorization: `Negotiate ${token.toString('base64')}` } : {}), ...headers } })
const sso = (r, o = {}) => S.handlePublic(r, '/api/sso', { ip: r.socket.remoteAddress, ...o })
const available = async (r) => (await S.handlePublic(r, '/api/sso/available', {})).body.available
const ticket = (o = {}) => k.makeTestToken({ serviceKey: svcKey, kvno: 3, now: clock, ctime: clock, cusec: Math.floor(Math.random() * 999999), ...o })

// ---- set-up ----
check('not offered before it is set up', (await available(req())) === false && (await sso(req())).status === 404)
const st0 = (await admin('GET', '/api/admin/ad/sso'))[1].sso
check('status: off, the service principal shown, "no keytab" said', st0.enabled === false && st0.servicePrincipal === 'HTTP/cctv.jfl.gripe@JFL.LOCAL' && st0.problems.includes('No keytab uploaded yet.'))
check('switching it on without a keytab is refused in words', (await admin('POST', '/api/admin/ad/sso', { enabled: true }))[0] === 400)
check('only an admin', (await admin('GET', '/api/admin/ad/sso', null, { user: 'bob', admin: false }))[0] === 403)
check('a file that is not a keytab is refused in words', /not a keytab/.test((await admin('POST', '/api/admin/ad/sso/keytab', { keytab: Buffer.from('hello there').toString('base64') }))[1].error))
const rc4 = k.buildKeytab([{ principal: 'HTTP/cctv.jfl.gripe@JFL.LOCAL', kvno: 3, etype: 23, key: randomBytes(16) }])
check('a keytab with only an RC4 key is refused, saying to make it with AES256-SHA1', /only RC4 or DES keys.*AES256-SHA1/.test((await admin('POST', '/api/admin/ad/sso/keytab', { keytab: rc4.toString('base64') }))[1].error))
const other = k.buildKeytab([{ principal: 'HTTP/other.jfl.local@JFL.LOCAL', kvno: 3, etype: 18, key: randomBytes(32) }])
check('a keytab for another name is refused, listing what it has', /no AES key for HTTP\/cctv\.jfl\.gripe@JFL\.LOCAL.*HTTP\/other\.jfl\.local@JFL\.LOCAL/.test((await admin('POST', '/api/admin/ad/sso/keytab', { keytab: other.toString('base64') }))[1].error))
const up = await admin('POST', '/api/admin/ad/sso/keytab', { keytab: keytab.toString('base64') })
check('the keytab is accepted, kept in DATA_DIR, and listed (principal, etype, kvno)', up[0] === 200 && existsSync(join(dir, 'sso.keytab')) && up[1].sso.keytab.entries[0].principal === 'HTTP/cctv.jfl.gripe@JFL.LOCAL' && up[1].sso.keytab.entries[0].etypeName === 'aes256-cts-hmac-sha1-96' && up[1].sso.keytab.entries[0].kvno === 3 && up[1].sso.keytab.uploadedBy === 'localboss')
check('the page never gets the key back', !JSON.stringify((await admin('GET', '/api/admin/ad/sso'))[1]).includes(svcKey.toString('hex')) && !JSON.stringify((await admin('GET', '/api/admin/ad/sso'))[1]).includes(svcKey.toString('base64')))
check('the upload is audited (without the key)', rows.some((r) => r.action === 'settings-change' && /keytab uploaded for HTTP\/cctv\.jfl\.gripe@JFL\.LOCAL: aes256-cts-hmac-sha1-96 version 3/.test(r.detail)))
check('uploaded but not switched on: still not offered', (await available(req())) === false)
check('switched on', (await admin('POST', '/api/admin/ad/sso', { enabled: true }))[1].sso.ready === true)

// ---- where it is offered ----
check('offered to the office: straight to the server, on cctv.jfl.gripe', (await available(req())) === true)
check('the Host with a port is the same name', (await available(req({ headers: { host: 'CCTV.jfl.gripe:443' } }))) === true)
check('NOT offered through the Cloudflare tunnel (CF-Connecting-IP)', (await available(req({ headers: { 'cf-connecting-ip': '81.2.3.4' }, peer: '127.0.0.1' }))) === false)
check('NOT offered to anything arriving from cloudflared on this machine, header or not', (await available(req({ peer: '::ffff:127.0.0.1' }))) === false && viaTunnel({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }))
check('NOT offered on another name (an IP address gets no Kerberos ticket)', (await available(req({ headers: { host: '192.168.1.232:8443' } }))) === false)
const tunnel = await sso(req({ token: ticket(), headers: { 'cf-connecting-ip': '81.2.3.4' }, peer: '127.0.0.1' }))
check('/api/sso through the tunnel: refused, and never a Negotiate challenge', tunnel.status === 403 && !tunnel.headers?.['www-authenticate'] && !tunnel.user)

// ---- the challenge ----
const ch = await sso(req())
check('/api/sso with no Authorization: 401 + WWW-Authenticate: Negotiate, not cached', ch.status === 401 && ch.headers['www-authenticate'] === 'Negotiate' && ch.headers['cache-control'] === 'no-store')
check('/api/sso/available never challenges', !(await S.handlePublic(req(), '/api/sso/available', {})).headers['www-authenticate'])
check('a cross-site request (an image on another site) is refused, no challenge', (await sso(req({ headers: { 'sec-fetch-site': 'cross-site' } }))).status === 403)
check('without the page\'s own header: refused, no challenge', (await sso(req({ headers: { 'x-argus-sso': undefined } }))).headers['www-authenticate'] === undefined)
check('only GET', (await sso(req({ method: 'POST' }))).status === 405)
check('an address over the limit: 429 before anything', (await sso(req({ token: ticket() }), { blocked: true })).status === 429)

// ---- signing in ----
const bob = await sso(req({ token: ticket({ user: 'bob' }) }))
check('bob@JFL.LOCAL with a good ticket: signed in as bob, a viewer (nested group), session to be set', bob.status === 200 && bob.user === 'bob' && bob.body.user === 'bob' && bob.clear === true)
const ub = auth.loadUsers().bob
check('the same AD record as a password sign-in: source ad, objectGUID, role, no password', ub?.source === 'ad' && /^[0-9a-f-]{36}$/.test(ub.adGuid) && ub.role === 'viewer' && ub.adValidUntil > clock && !('hash' in ub))
check('audited as "Windows single sign-on, Viewer"', rows.some((r) => r.action === 'login' && r.user === 'bob' && /^Windows single sign-on, Viewer/.test(r.detail)))
check('AD names are found whatever capitals the ticket has', (await sso(req({ token: ticket({ user: 'ANN.ADMIN' }) }))).user === 'Ann.Admin' && auth.isAdmin('Ann.Admin'))
const replayTok = ticket({ user: 'wendy' })
const w1 = await sso(req({ token: replayTok }))
const w2 = await sso(req({ token: replayTok }))
check('watch-only works; the same token again is a replay: refused, counted', w1.user === 'wendy' && auth.isWatchOnly('wendy') && w2.status === 403 && w2.body.reason === 'replay' && w2.count === true)
const nog = await sso(req({ token: ticket({ user: 'nogroup' }) }))
check('in no CCTV group: refused with the same words as a password sign-in, not counted', nog.status === 403 && nog.body.error === ad.REFUSALS['no-group'][1] && !nog.count && !auth.loadUsers().nogroup)
const dis = await sso(req({ token: ticket({ user: 'disabled' }) }))
check('disabled in AD: refused with the same words', dis.status === 403 && dis.body.error === ad.REFUSALS.disabled[1])
check('not in the directory: refused', (await sso(req({ token: ticket({ user: 'ghost' }) }))).status === 403)
const before = fake.connections
const lb = await sso(req({ token: ticket({ user: 'localboss' }) }))
check('a LOCAL Argus account of that name is never signed in by single sign-on (AD not even asked)', lb.status === 403 && lb.body.reason === 'sso-local' && fake.connections === before && auth.loadUsers().localboss.source === undefined && Boolean(auth.loadUsers().localboss.hash))
const ntlm = await sso(req({ token: Buffer.from('NTLMSSP\0\x01\0\0\0\x07\x82\x08\xa2', 'latin1') }))
check('NTLM instead of Kerberos: refused in plain words, no new challenge, not counted', ntlm.status === 403 && /did not offer a Windows \(Kerberos\) sign-in/.test(ntlm.body.error) && !ntlm.headers['www-authenticate'] && !ntlm.count)
const junk = await sso(req({ token: randomBytes(64) }))
check('a junk token: refused, counted with the failed sign-ins', junk.status === 403 && junk.count === true)
const forged = await sso(req({ token: k.makeTestToken({ serviceKey: randomBytes(32), kvno: 3, now: clock, user: 'Ann.Admin' }) }))
check('a ticket made with another key (forged): refused as integrity, counted', forged.status === 403 && forged.body.reason === 'integrity' && forged.count === true)
check('a ticket for another realm: refused', (await sso(req({ token: ticket({ realm: 'EVIL.LOCAL', crealm: 'EVIL.LOCAL' }) }))).body.reason === 'wrong-realm')
check('a ticket for another service: refused', (await sso(req({ token: ticket({ service: ['HTTP', 'intranet.jfl.local'] }) }))).body.reason === 'wrong-service')
check('an expired ticket: refused', (await sso(req({ token: ticket({ start: clock - 11 * 3_600_000, end: clock - 3_600_000 }) }))).body.reason === 'ticket-expired')
const skew = await sso(req({ token: ticket({ ctime: clock - 10 * 60_000 }) }))
check('a PC clock 10 minutes out: refused, saying so, not counted', skew.body.reason === 'skew' && /clock/.test(skew.body.error) && !skew.count)
const mutual = await sso(req({ token: ticket({ user: 'bob', mutual: true }) }))
check('mutual authentication asked: the 200 carries a Negotiate answer token', mutual.status === 200 && /^Negotiate [A-Za-z0-9+/]+=*$/.test(mutual.headers['www-authenticate'] ?? ''))
check('every refusal is audited with its reason', ['replay', 'no-group', 'sso-local', 'ntlm', 'integrity', 'wrong-realm', 'skew'].every((why) => rows.some((r) => r.action === 'login-failed' && r.detail.startsWith('Windows single sign-on: ') && r.detail.includes(why))))
const st = (await admin('GET', '/api/admin/ad/sso'))[1].sso
check('Settings shows the last attempts, newest first, with the reason', st.recent.length > 5 && st.recent[0].ok === true && st.recent[0].user === 'bob' && st.recent.some((a) => a.reason === 'replay'))

// ---- what has to hold for it to be offered ----
store.save({ ...base, lookupUser: '', lookupPassword: '' })
check('without the look-up account: not offered, and the reason shown', (await available(req())) === false && (await admin('GET', '/api/admin/ad/sso'))[1].sso.problems.some((p) => /look-up account/.test(p)))
store.save({ ...base, enabled: false })
check('AD sign-in off: not offered', (await available(req())) === false && (await sso(req({ token: ticket() }))).status === 404)
store.save(base)
env.CCTV_SSO = 'off'
const Killed = makeSso({ ad: A, dataDir: dir, now: () => clock, env })
check('CCTV_SSO=off: never offered, /api/sso 404, Settings says so', (await Killed.handlePublic(req(), '/api/sso/available', {})).body.available === false && (await Killed.handlePublic(req({ token: ticket() }), '/api/sso', {})).status === 404 && /CCTV_SSO=off/.test(Killed.status().problems.join()))
delete env.CCTV_SSO
check('switched off in Settings: not offered', (await admin('POST', '/api/admin/ad/sso', { enabled: false }))[0] === 200 && (await available(req())) === false)
const rm = await admin('POST', '/api/admin/ad/sso/keytab', { keytab: null })
check('removing the keytab deletes the file', rm[0] === 200 && !existsSync(join(dir, 'sso.keytab')) && rm[1].sso.keytab.present === false)
check('the keytab is nowhere in the data folder now', !readdirSync(dir).some((f) => { try { return readFileSync(join(dir, f)).includes(svcKey) } catch { return false } }))

// ---- server.mjs wiring, read from the file ----
const server = read('server.mjs')
check('server: /api/sso and /api/sso/available are answered before the sign-in check', server.indexOf("pathname === '/api/sso' || pathname === '/api/sso/available'") > 0 && server.indexOf("pathname === '/api/sso' || pathname === '/api/sso/available'") < server.indexOf('if (PUBLIC_PATHS.has(pathname))'))
check('server: no other route sends WWW-Authenticate (only sso.mjs, only on /api/sso)', readdirSync(new URL('..', import.meta.url)).filter((f) => f.endsWith('.mjs') && f !== 'sso.mjs').every((f) => !/['"`]www-authenticate['"`]/i.test(read(f))))
check('server: the session cookie is made the same way as a password sign-in', /if \(r\.user\) headers\['set-cookie'\] = auth\.sessionCookie\(auth\.createSession\(r\.user\), Boolean\(req\.socket\.encrypted\)\)/.test(server))
check('server: failures counted and cleared like other sign-ins', /if \(r\.count\) auth\.recordFailure\(ip\)/.test(server) && /blocked: auth\.loginBlocked\(ip\)/.test(server))
check('server: the admin routes are wired, behind the /api/admin/ guard', server.indexOf('sso.handleAdmin(') > server.indexOf("if (pathname.startsWith('/api/admin/')) {"))
check('server: 64 KB of headers allowed (big Kerberos tickets), on HTTP and HTTPS', /createServer\(\{ maxHeaderSize: MAX_HEADER_BYTES \}, onRequest\)/.test(server) && /maxHeaderSize: MAX_HEADER_BYTES \}, onRequest\)/.test(server.slice(server.indexOf('createHttpsServer('))))
check('server: the sign-in page\'s sso-login.js is public', /'\/login\.js', '\/sso-login\.js'/.test(server))

// ---- the sign-in page ----
const login = read('public/login.html')
const loginJs = read('public/login.js')
check('sign-in page: a "Sign in with Windows" button and a status line, both hidden until offered', /<button id="ssoButton" type="button" class="login-sso" hidden>Sign in with Windows<\/button>/.test(login) && /<p id="ssoStatus" class="login-sso-status" role="status" hidden><\/p>/.test(login))
check('it says "Signing you in with Windows…" while it tries', /Signing you in with Windows…/.test(loginJs))
check('a refused try by hand says to use the user name and password', /Sign in with your user name and password/.test(loginJs))
check('after signing in it goes on as a password sign-in does (next, #event)', /await goOn\(\{ user: r\.user \}\)/.test(loginJs) && /async function goOn\(signedIn\)/.test(loginJs) && /await goOn\(await res\.json\(\)\)/.test(loginJs))
const sl = await import('../public/sso-login.js')
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0'
check('tries by itself only on Windows, when offered', sl.shouldTry({ available: true, ua }) && !sl.shouldTry({ available: false, ua }) && !sl.shouldTry({ available: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }) && !sl.shouldTry({ available: true, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }))
check('not again for a day after it failed in this browser', !sl.shouldTry({ available: true, ua, failed: 1000, now: 1000 + 23 * 3_600_000 }) && sl.shouldTry({ available: true, ua, failed: 1000, now: 1000 + 25 * 3_600_000 }))
const mem = new Map()
const storage = { getItem: (key) => mem.get(key) ?? null, setItem: (key, v) => mem.set(key, v), removeItem: (key) => mem.delete(key) }
sl.markFailed(storage, 1234)
check('the failure is remembered per browser, and forgotten after a success', sl.failedAt(storage) === 1234 && (sl.clearFailed(storage), sl.failedAt(storage) === 0))
const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
check('storage that refuses (private window) never breaks the page', sl.failedAt(broken) === 0 && (sl.markFailed(broken), sl.clearFailed(broken), true) && sl.failedAt(null) === 0)
let asked = null
const okFetch = async (url, o) => { asked = { url, o }; return { ok: true, json: async () => ({ user: 'bob' }) } }
check('one try: GET /api/sso with the page\'s header and credentials', (await sl.trySso({ fetchFn: okFetch })).user === 'bob' && asked.url === '/api/sso' && asked.o.headers['x-argus-sso'] === '1' && asked.o.credentials === 'include')
check('a refusal gives the server\'s words; a network error or timeout gives none', (await sl.trySso({ fetchFn: async () => ({ ok: false, json: async () => ({ error: 'nope' }) }) })).message === 'nope' && (await sl.trySso({ fetchFn: async () => { throw new TypeError('x') } })).ok === false)
check('a hung request is given up after the timeout', (await sl.trySso({ timeoutMs: 20, fetchFn: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))) })).ok === false)

// ---- Settings ----
const settings = read('public/settings.html')
check('Settings > Active Directory has the single sign-on part, with its words and controls', /Single sign-on \(Windows\)/.test(settings) && ['sso-status', 'sso-principal', 'sso-keytab', 'sso-upload', 'sso-remove', 'sso-enabled', 'sso-recent'].every((id) => settings.includes(`id="${id}"`)) && /<script type="module" src="sso-settings.js"><\/script>/.test(settings) && /sso-setup-dc\.ps1/.test(settings) && /sso-browsers-gpo\.ps1/.test(settings) && /Local Argus accounts are never signed in this way/.test(settings))
const ss = await import('../public/sso-settings.js')
check('status words: on / off with reasons / kill switch', /^On: office Windows PCs/.test(ss.ssoStatusText({ ready: true })) && ss.ssoStatusText({ enabled: false, problems: ['No keytab uploaded yet.'] }) === 'Off. No keytab uploaded yet.' && /CCTV_SSO=off/.test(ss.ssoStatusText({ killed: true })))
check('keytab lines say which keys are used and which not', ss.keytabLines({ present: true, entries: [{ principal: 'HTTP/cctv.jfl.gripe@JFL.LOCAL', etypeName: 'aes256-cts-hmac-sha1-96', kvno: 3, usable: true, matches: true }, { principal: 'HTTP/cctv.jfl.gripe@JFL.LOCAL', etypeName: 'rc4-hmac', kvno: 3, usable: false, matches: true }] }).join('|') === 'HTTP/cctv.jfl.gripe@JFL.LOCAL · aes256-cts-hmac-sha1-96 · key version 3|HTTP/cctv.jfl.gripe@JFL.LOCAL · rc4-hmac · key version 3 · not accepted (only AES is)')
check('an attempt line', ss.attemptLine({ at: 0, ip: '192.168.3.50', user: 'bob', ok: false, reason: 'no-group', message: 'Not in a group.' }, () => 'T') === 'T · 192.168.3.50 · bob: refused (no-group) Not in a group.')

// ---- the scripts for the domain controller ----
const dc = read('../deploy/sso-setup-dc.ps1')
check('DC script: AES only (24), never expires, cannot change, setspn -S, ktpass AES256-SHA1 KRB5_NT_PRINCIPAL', /msDS-SupportedEncryptionTypes/.test(dc) && /\b24\b/.test(dc) && /PasswordNeverExpires\s+\$true/.test(dc) && /CannotChangePassword\s+\$true/.test(dc) && /setspn(\.exe)?['"]?\s.*-S/i.test(dc) && /\/crypto['"]?,?\s*['"]?AES256-SHA1/.test(dc) && /KRB5_NT_PRINCIPAL/.test(dc) && /HTTP\/cctv\.jfl\.gripe@JFL\.LOCAL/.test(dc))
const gpo = read('../deploy/sso-browsers-gpo.ps1')
check('GPO script: "Argus single sign-on", Local intranet zone (1), Edge and Chrome AuthServerAllowlist', /Argus single sign-on/.test(gpo) && /ZoneMapKey/.test(gpo) && /https:\/\/cctv\.jfl\.gripe/.test(gpo) && /Policies\\Microsoft\\Edge/.test(gpo) && /Policies\\Google\\Chrome/.test(gpo) && /AuthServerAllowlist/.test(gpo))

await fake.close()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
