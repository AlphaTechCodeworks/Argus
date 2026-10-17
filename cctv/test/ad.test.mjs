// Windows (Active Directory) sign-in, ad.mjs and ad-api.mjs, against the fake directory in
// fake-ldap.mjs over plain TCP (the TLS side is ldap.test.mjs's): settings checks, local accounts
// first, role from groups (nested too), the plain refusals, the users.json record (never a password),
// sessions that end by themselves, re-checks and their grace, objectGUID identity and renames (all or
// nothing), Windows password changes (expired at sign-in, and any time when signed in), and the
// admin routes.
//   node cctv/test/ad.test.mjs
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'cctv-ad-'))
process.env.DATA_DIR = dir
const auth = await import('../auth.mjs')
const ad = await import('../ad.mjs')
const { handleAd } = await import('../ad-api.mjs')
// users-api.mjs reaches the NVR SDK (nvr-xml.mjs), which loads only on Linux: its checks are skipped elsewhere
const { handleUsers } = await import('../users-api.mjs').catch((e) => { console.log(`SKIP  Users & access route checks: ${e.message.slice(0, 80)}`); return {} })
const rights = await import('../rights.mjs')
const { renameUserViews, VIEWS_FILE } = await import('../views.mjs')
const { renameUserPrefs, PREFS_FILE } = await import('../user-prefs.mjs')
const { makeSetupCodes } = await import('../setup-codes.mjs')
const bookmarks = await import('../bookmarks.mjs')
const { ldapOpen, LdapError } = await import('../ldap.mjs')
const { startFakeLdap, sampleDir, fakeGuid, GROUPS } = await import('./fake-ldap.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const throwsStatus = (fn, status, re) => { try { fn(); return false } catch (e) { return e.status === status && (!re || re.test(e.message)) } }
const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'

// ---- settings ----
const D = ad.AD_DEFAULTS
check('defaults: off, the two DCs, JFL.LOCAL, the three groups, password changes allowed', D.enabled === false && D.servers.join() === '192.168.0.19,192.168.1.19' && D.domain === 'JFL.LOCAL' && D.baseDn === 'DC=JFL,DC=LOCAL' && D.groups.admin === 'CCTV Admins' && D.groups.viewer === 'CCTV Viewers' && D.groups.watch === 'CCTV Watch-only' && D.allowPasswordChange === true)
check('a server that is not an address is refused', throwsStatus(() => ad.validateAdSettings({ servers: ['dc01; rm -rf'] }), 400, /not a server address/))
check('servers: one per line, :port kept, 636 dropped, duplicates once', ad.validateAdSettings({ servers: 'dc01.jfl.local\n192.168.1.19:636\n10.0.0.5:3269\ndc01.jfl.local' }).servers.join() === 'dc01.jfl.local,192.168.1.19,10.0.0.5:3269')
check('turning it on with an untrusted DC is refused, saying which', throwsStatus(() => ad.validateAdSettings({ enabled: true }), 400, /trust the certificate of 192\.168\.0\.19 and 192\.168\.1\.19/))
check('turning it on with every DC pinned is fine', ad.validateAdSettings({ enabled: true }, { ...D, pins: { '192.168.0.19': FP, '192.168.1.19': FP } }).enabled === true)
check('a pin for a server no longer listed is dropped', Object.keys(ad.validateAdSettings({ servers: ['192.168.0.19'] }, { ...D, pins: { '192.168.0.19': FP, '192.168.1.19': FP } }).pins).join() === '192.168.0.19')
check('a junk CA certificate is refused in plain words', throwsStatus(() => ad.validateAdSettings({ caPem: '-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----' }), 400, /could not be read/))
check('the domain and base DN are checked', throwsStatus(() => ad.validateAdSettings({ domain: 'jfl' }), 400) && throwsStatus(() => ad.validateAdSettings({ baseDn: 'JFL.LOCAL' }), 400) && ad.validateAdSettings({ domain: 'jfl.local' }).domain === 'JFL.LOCAL')
check('no group at all is refused', throwsStatus(() => ad.validateAdSettings({ groups: { admin: '', viewer: '', watch: '' } }), 400))
check('grace hours within 0.25..72', throwsStatus(() => ad.validateAdSettings({ graceHours: 0 }), 400) && ad.validateAdSettings({ graceHours: 12 }).graceHours === 12)
const withPw = ad.validateAdSettings({ lookupUser: 'svc-cctv', lookupPassword: 'Svc-pass-1' })
check('the look-up password is kept when not typed again', ad.validateAdSettings({ lookupUser: 'svc-cctv' }, withPw).lookupPassword === 'Svc-pass-1')
check('and cleared with a new look-up user', ad.validateAdSettings({ lookupUser: 'other' }, withPw).lookupPassword === '')
check('the page never gets the look-up password back', !JSON.stringify(ad.publicSettings(withPw)).includes('Svc-pass-1') && ad.publicSettings(withPw).lookupPasswordSet === true)
check('the password-change switch is read', ad.validateAdSettings({ allowPasswordChange: false }).allowPasswordChange === false)

// ---- names, roles, AD's answers ----
const p = (t) => ad.parseTypedName(t, 'JFL.LOCAL')
check('bob, JFL\\bob and bob@jfl.local are all bob@JFL.LOCAL', p('bob').bindName === 'bob@JFL.LOCAL' && p('JFL\\bob').sam === 'bob' && p('bob@jfl.local').sam === 'bob' && p('bob@jfl.local').bindName === 'bob@JFL.LOCAL')
check('another UPN suffix is bound and found by that UPN', p('bob@jfl.co.uk').upn === 'bob@jfl.co.uk' && p('bob@jfl.co.uk').sam === undefined)
check('names Windows would not allow are not names', p('a*b') === null && p('') === null && p('x\\') === null && p('a\u0000b') === null)
check('highest role wins', ad.roleFrom(new Set(['watch', 'admin'])) === 'admin' && ad.roleFrom(new Set(['watch', 'viewer'])) === 'viewer' && ad.roleFrom(new Set(['watch'])) === 'watch' && ad.roleFrom(new Set()) === null)
check('password-change refusals: wrong current (00000056), policy (0000052D), will not (53), no right (50)', ad.changeRefusal({ code: 19, message: '00000056: AtrErr: DSID-03190F80' }) === 'wrong-current' && ad.changeRefusal({ code: 19, message: '0000052D: Constraint violation' }) === 'policy' && ad.changeRefusal({ code: 53, message: '0000001F: SvcErr' }) === 'policy' && ad.changeRefusal({ code: 50 }) === 'no-change-right')
check('the expired / must-change message is the owner\'s wording', ad.REFUSALS['password-expired'][1] === 'Your Windows password must be changed. Change it on a Windows PC, then sign in again.' && ad.REFUSALS['must-change-password'][1] === ad.REFUSALS['password-expired'][1])

// ---- the fake directory, and an AD instance on it ----
const directory = sampleDir()
const fake = await startFakeLdap({ dir: directory })
const viaFake = (o) => ldapOpen({ ...o, host: '127.0.0.1', port: fake.port, transport: 'tcp', timeoutMs: 3000 })
const store = ad.makeAdStore(join(dir, 'active-directory.json'))
const base = { ...D, enabled: true, pins: { '192.168.0.19': FP, '192.168.1.19': FP }, lookupUser: 'svc-cctv', lookupPassword: 'Svc-pass-1' }
store.save(base)
const rows = []
const endedNames = []
const setupCodes = makeSetupCodes(join(dir, 'setup-codes.json'))
let clock = Date.now()
const renamers = [rights.renameRights, renameUserViews, renameUserPrefs, (f, t) => setupCodes.rename(f, t), bookmarks.renameBookmarkUser]
const A = ad.makeAd({ store, open: viaFake, now: () => clock, audit: (r) => rows.push(r), forgetRights: rights.forgetRights, renamers })
A.start({ ended: (n) => endedNames.push(n), everyMs: 3_600_000 })

// local accounts: localboss also exists in AD (with another password); kkk exists only here
auth.saveUsers({ localboss: { hash: await auth.hashPassword('Local-boss-1'), role: 'admin', since: 1 }, kkk: { hash: await auth.hashPassword('Kkk-pass-1'), role: 'viewer', since: 1 } })
const before = fake.connections
check('a local account always wins: AD is not asked at all', (await A.login('localboss', 'AD-boss-1', { ip: '10.0.0.1' })) === null && (await A.login('LocalBoss', 'x', {})) === null && fake.connections === before)
const twin = await A.login('JFL\\localboss', 'AD-boss-1', { ip: '10.0.0.1' })
check('JFL\\<local name> is refused (AD never stands in for a local account), without asking AD', twin?.ok === false && /local Argus account/.test(twin.message) && fake.connections === before)
store.save({ ...base, enabled: false })
check('AD off: not ours (the login carries on as before)', (await A.login('bob', 'Bob-pass-1', {})) === null)
store.save(base)

const ann = await A.login('Ann.Admin', 'Ann-pass-1', { ip: '10.0.0.2' })
check('an AD admin signs in', ann?.ok === true && ann.user === 'Ann.Admin' && auth.isAdmin('Ann.Admin'))
const bob = await A.login('JFL\\bob', 'Bob-pass-1', { ip: '10.0.0.3' })
check('in CCTV Viewers only through a nested group: a viewer', bob?.ok === true && bob.user === 'bob' && auth.loadUsers().bob.role === 'viewer' && !auth.isAdmin('bob'))
check('watch only', (await A.login('wendy@JFL.LOCAL', 'Wendy-pass-1', {}))?.ok === true && auth.isWatchOnly('wendy'))
const nog = await A.login('nogroup', 'No-pass-1', { ip: '10.0.0.4' })
check('in no CCTV group: refused, in the owner\'s words, counted', nog.ok === false && nog.status === 403 && nog.message === 'Your account is not in a CCTV group. Ask an administrator.' && nog.count === true && !auth.loadUsers().nogroup)
const wrong = await A.login('bob', 'nope', { ip: '10.0.0.5' })
check('a wrong password: the same words as a local one, counted', wrong.ok === false && wrong.status === 401 && wrong.message === 'Wrong user name or password' && wrong.count === true)
check('an unknown name: the same words', (await A.login('nobody', 'x', {})).message === 'Wrong user name or password')
check('locked out (775): said plainly', /locked out/.test((await A.login('locked', 'Locked-1', {})).message))
check('disabled: said plainly', /disabled/.test((await A.login('disabled', 'Dis-pass-1', {})).message))
const exp = await A.login('expired', 'Old-pass-1', {})
check('must change (773), with a look-up account: offered here', exp.ok === false && exp.canChangePassword === true && /You can change it here/.test(exp.message) && exp.count === false)
store.save({ ...base, lookupUser: '', lookupPassword: '' })
const exp2 = await A.login('expired', 'Old-pass-1', {})
check('must change, without a look-up account: "change it on a Windows PC"', exp2.canChangePassword === undefined && exp2.message === ad.MUST_CHANGE_TEXT)
store.save(base)
check('every refusal is audited with its reason', rows.some((r) => r.action === 'login-failed' && /no-group/.test(r.detail)) && rows.some((r) => r.action === 'login-failed' && /locked/.test(r.detail)) && rows.some((r) => r.action === 'login' && r.user === 'Ann.Admin' && /Active Directory, Admin/.test(r.detail)))

const users = auth.loadUsers()
check('the record: source ad, objectGUID, role, display name, last sign-in; no hash', users['Ann.Admin'].source === 'ad' && users['Ann.Admin'].adGuid === fakeGuid('Ann.Admin') && users['Ann.Admin'].displayName === 'Ann Admin' && users['Ann.Admin'].lastSignIn === clock && !('hash' in users['Ann.Admin']))
const everything = () => readdirSync(dir).filter((f) => !f.endsWith('.db') && !f.includes('.db-')).map((f) => { try { return readFileSync(join(dir, f), 'utf8') } catch { return '' } }).join('\n')
check('no AD user\'s password is written anywhere', !['Ann-pass-1', 'Bob-pass-1', 'Wendy-pass-1', 'No-pass-1', 'nope'].some((pw) => everything().includes(pw)))
check('an AD user cannot sign in with a local password check', !(await auth.checkLogin('bob', 'Bob-pass-1')))

// ---- sessions end by themselves ----
const tokBob = auth.createSession('bob')
check('a session for an AD user is good while AD said yes', auth.verifySession(tokBob) === 'bob')
const u1 = auth.loadUsers()
auth.saveUsers({ ...u1, bob: { ...u1.bob, adValidUntil: Date.now() - 1 } })
check('and refused once that has run out', auth.verifySession(tokBob) === null)
auth.saveUsers(u1)
check('back when it holds again', auth.verifySession(tokBob) === 'bob')

// ---- DCs unreachable ----
const down = ad.makeAd({ store, open: async () => { throw new LdapError('connect', 'Cannot reach 192.168.0.19:636 (ECONNREFUSED)') }, audit: (r) => rows.push(r) })
const dr = await down.login('bob', 'Bob-pass-1', { ip: '10.0.0.9' })
check('no DC answers: 503, plain words, not counted as a guess', dr.ok === false && dr.status === 503 && /cannot be reached/.test(dr.message) && dr.count === false)
check('and a local admin still signs in (not ours)', (await down.login('localboss', 'Local-boss-1', {})) === null && (await auth.checkLogin('localboss', 'Local-boss-1')))

// ---- Users & access, rights ----
const boss = { user: 'localboss', admin: true }
const call = async (method, path, body, who = boss) => { try { return await handleUsers(method, path, async () => body, who) } catch (e) { return [e.status ?? 500, { error: e.message }] } }
if (handleUsers) {
  const listed = (await call('GET', '/api/admin/users'))[1].users
  const lb = listed.find((u) => u.name === 'bob')
  check('Users & access lists AD users as such, with display name', lb?.source === 'ad' && lb.displayName === 'Bob Gate' && listed.find((u) => u.name === 'kkk').source === undefined)
  check('an AD user\'s role and password cannot be set here', (await call('POST', '/api/admin/users', { name: 'bob', role: 'admin' }))[0] === 409 && (await call('POST', '/api/admin/users', { name: 'BOB', password: 'whatever-1', role: 'viewer' }))[0] === 409)
  check('the last LOCAL admin cannot be removed, even with an AD admin about', (await call('DELETE', '/api/admin/users/localboss', null, { user: 'Ann.Admin', admin: true }))[0] === 409)
  check('an AD user can be signed out like anyone', (await call('POST', '/api/admin/users/wendy/sign-out'))[0] === 200 && auth.verifySession(auth.createSession('wendy', 1)) === null)
} else {
  // the same rules, read from the source where the route cannot run here
  const src = readFileSync(new URL('../users-api.mjs', import.meta.url), 'utf8')
  check('(source) Users & access lists source and display name, refuses changes to AD users, counts only local admins', /source: 'ad', displayName/.test(src) && /signs in with Windows \(Active Directory\)/.test(src) && /u\.role === 'admin' && u\.source !== 'ad'/.test(src))
  auth.signOutUser('wendy')
}
check('nor the Admin switch of the access editor', throwsStatus(() => rights.saveRights('bob', { admin: true }), 409, /AD group/))
check('per-camera rights are set as for anyone', rights.saveRights('bob', { admin: false, live: ['n1/0'] }) && rights.loadRights().users.bob)
check('a set-up code can be made for an AD user', setupCodes.create('bob', 'localboss').code.length > 20 && setupCodes.pending('bob') === 1)

// ---- re-checks ----
clock += 20 * 60_000
const tokAnn = auth.createSession('Ann.Admin')
directory.users.bob.chain = [] // IT takes bob out of every group
directory.users.wendy.chain = [GROUPS.admins] // and makes wendy an admin
const u2 = auth.loadUsers()
auth.saveUsers({ ...u2, wendy: { ...u2.wendy, adValidUntil: clock + 3_600_000 } })
const rc = await A.recheck()
check('re-check: bob, out of the groups, is signed out at once', rc.ended.includes('bob') && auth.verifySession(tokBob) === null && endedNames.includes('bob'))
check('re-check: wendy\'s role follows AD', auth.loadUsers().wendy.role === 'admin')
check('re-check: Ann carries on, her time moved on', auth.verifySession(tokAnn) === 'Ann.Admin' && auth.loadUsers()['Ann.Admin'].adCheckedAt === clock)
check('re-check: audited with the reason', rows.some((r) => r.user === 'bob' && /no longer in a CCTV group/.test(r.detail)))
directory.users.bob.chain = [GROUPS.gate, GROUPS.viewers]
clock += 20 * 60_000
const A2 = ad.makeAd({ store, open: async () => { throw new LdapError('timeout', 'did not answer') }, now: () => clock })
const rc2 = await A2.recheck()
check('re-check with no DC answering: nobody is signed out', rc2.ended.length === 0 && auth.verifySession(tokAnn) === 'Ann.Admin' && /No domain controller answered/.test(A2.state.lastRecheckError))
const u3 = auth.loadUsers()
auth.saveUsers({ ...u3, 'Ann.Admin': { ...u3['Ann.Admin'], adValidUntil: Date.now() - 1 } })
check('...until the grace has passed', auth.verifySession(tokAnn) === null)
auth.saveUsers(u3)
store.save({ ...base, lookupUser: '', lookupPassword: '' })
check('without a look-up account there are no re-checks (the grace alone ends sessions)', (await A.recheck({ force: true })).checked === 0)
store.save(base)

// ---- objectGUID identity: renamed in AD ----
// Ann has rights, saved views, a camera order, a set-up code and a bookmark under her old name
rights.saveRights('Ann.Admin', { admin: true })
const roleRow = rights.loadRights().users['Ann.Admin']
writeFileSync(VIEWS_FILE, JSON.stringify({ 'Ann.Admin': { views: [], viewsVersion: 3 }, kkk: { views: [], viewsVersion: 1 } }))
writeFileSync(PREFS_FILE, JSON.stringify({ 'Ann.Admin': { gridOrder: ['n1/0'], gridOrderVersion: 2 } }))
setupCodes.create('Ann.Admin', 'localboss')
const bm = bookmarks.createBookmark({ cameras: ['n1/0'], startMs: Date.now() - 60_000, endMs: Date.now(), title: 'gate' }, 'Ann.Admin')
const annTok = auth.createSession('Ann.Admin')
directory.users['Ann.Boss'] = { ...directory.users['Ann.Admin'], guid: fakeGuid('Ann.Admin'), upn: 'Ann.Boss@JFL.LOCAL' }
delete directory.users['Ann.Admin']
endedNames.length = 0
const ren = await A.login('Ann.Boss', 'Ann-pass-1', { ip: '10.0.0.7' })
const u4 = auth.loadUsers()
check('renamed in AD: signs in under the new name, the same record', ren?.ok === true && ren.user === 'Ann.Boss' && !u4['Ann.Admin'] && u4['Ann.Boss'].adGuid === fakeGuid('Ann.Admin') && u4['Ann.Boss'].role === 'admin')
check('rights moved', rights.loadRights().users['Ann.Boss'] !== undefined && rights.loadRights().users['Ann.Admin'] === undefined && Boolean(roleRow))
check('saved views moved (others untouched)', (() => { const v = JSON.parse(readFileSync(VIEWS_FILE, 'utf8')); return v['Ann.Boss']?.viewsVersion === 3 && !v['Ann.Admin'] && v.kkk })())
check('camera order moved', (() => { const v = JSON.parse(readFileSync(PREFS_FILE, 'utf8')); return v['Ann.Boss']?.gridOrder?.[0] === 'n1/0' && !v['Ann.Admin'] })())
check('set-up code moved', setupCodes.pending('Ann.Boss') === 1 && setupCodes.pending('Ann.Admin') === 0)
check('bookmark moved', bm.ok && bookmarks.getBookmark(bm.bookmark.id)?.user === 'Ann.Boss')
check('the old name\'s sessions end', auth.verifySession(annTok) === null && endedNames.includes('Ann.Admin'))
check('audited: "renamed in AD: old → new"', rows.some((r) => r.detail === 'renamed in AD: Ann.Admin → Ann.Boss'))

// all or nothing: a later step failing undoes the earlier ones
directory.users['Ann.Second'] = { ...directory.users['Ann.Boss'], upn: 'Ann.Second@JFL.LOCAL' }
delete directory.users['Ann.Boss']
const failing = ad.makeAd({ store, open: viaFake, now: () => clock, audit: (r) => rows.push(r), renamers: [rights.renameRights, renameUserViews, () => { throw new Error('disk full') }] })
const rf = await failing.login('Ann.Second', 'Ann-pass-1', {})
check('a rename that cannot finish: refused, plainly', rf.ok === false && rf.status === 503 && /could not move your settings/.test(rf.message))
check('and nothing moved: record, rights and views all under the old name still', auth.loadUsers()['Ann.Boss'] && !auth.loadUsers()['Ann.Second'] && rights.loadRights().users['Ann.Boss'] && !rights.loadRights().users['Ann.Second'] && JSON.parse(readFileSync(VIEWS_FILE, 'utf8'))['Ann.Boss'])
check('audited, saying it was not carried over', rows.some((r) => /renamed in AD: Ann\.Boss → Ann\.Second, not carried over \(disk full\)/.test(r.detail ?? '')))
directory.users['Ann.Boss'] = directory.users['Ann.Second']
delete directory.users['Ann.Second']

// renamed onto a local account's name: never merged
const onto = ad.recordAdUser({ guid: fakeGuid('wendy'), name: 'kkk', role: 'viewer', displayName: '' }, { now: clock, graceMs: 1, renamers })
check('renamed in AD to a LOCAL account\'s name: refused, nothing merged', onto.error === 'renamed-onto-local' && onto.from === 'wendy' && auth.loadUsers().kkk.hash && auth.loadUsers().wendy.source === 'ad')
check('its message is plain', /renamed to a name that is also a local Argus account/.test(ad.REFUSALS['renamed-onto-local'][1]))

// a name reused by a different person (another objectGUID): they start afresh
const bobOld = auth.createSession('bob')
check('(bob signs in again first)', (await A.login('bob', 'Bob-pass-1', {}))?.ok === true && auth.verifySession(auth.createSession('bob')) === 'bob')
const bobTok = auth.createSession('bob')
directory.users.bob = { ...directory.users.bob, guid: fakeGuid('a different bob') }
const nb = await A.login('bob', 'Bob-pass-1', {})
check('a new bob (another objectGUID) does not inherit the old bob\'s rights or sessions', nb?.ok === true && auth.loadUsers().bob.adGuid === fakeGuid('a different bob') && !rights.loadRights().users.bob && auth.verifySession(bobTok) === null && auth.verifySession(bobOld) === null)

// ---- Windows passwords ----
const bad1 = await A.changeExpired('expired', 'not-it', 'New-pass-77', { ip: '10.0.0.8' })
check('expired: a wrong current password is said plainly, and counted', bad1.ok === false && bad1.message === 'The current password is wrong.' && bad1.count === true)
check('expired: the same password again is refused', (await A.changeExpired('expired', 'Old-pass-1', 'Old-pass-1', {})).message === ad.REFUSALS['same-password'][1])
const pol = await A.changeExpired('expired', 'Old-pass-1', 'short', {})
check('expired: against the domain\'s rules, AD\'s reason in plain words', pol.ok === false && /does not meet the domain’s password rules — length, complexity or history/.test(pol.message))
const good = await A.changeExpired('expired', 'Old-pass-1', 'New-pass-77', { ip: '10.0.0.8' })
check('expired: changed, then signed in with the new one', good.ok === true && good.user === 'expired' && good.changed === true && good.message === ad.CHANGED_TEXT && directory.users.expired.password === 'New-pass-77')
check('it was changed through the look-up account (the person cannot bind yet), deleting the old value', fake.requests.some((r) => r.op === 'modify' && r.changes[0].op === 'delete' && r.changes[1].op === 'add'))
check('audited as "changed Windows password", with no password in it', rows.some((r) => r.action === 'password-change' && /changed Windows password/.test(r.detail)) && !JSON.stringify(rows).includes('New-pass-77') && !JSON.stringify(rows).includes('Old-pass-1'))
store.save({ ...base, allowPasswordChange: false })
check('switch off: not offered, and refused', (await A.changeExpired('expired', 'New-pass-77', 'Newer-pass-8', {})).message === 'Change your Windows password on a Windows PC.')
store.save(base)
// signed in, any time: through auth.changePassword (the Change password page)
const sig = await auth.changePassword('bob', 'Bob-pass-1', 'Bob-new-pass-9')
check('signed in: an AD user changes their Windows password from Change password', sig.ok === true && sig.message === 'Your Windows password has been changed. Use the new one on your PC too.' && directory.users.bob.password === 'Bob-new-pass-9')
check('signed in: bound as themselves (no look-up account needed)', fake.requests.filter((r) => r.op === 'bind').slice(-1)[0]?.name === 'bob@JFL.LOCAL')
check('signed in: a wrong current password', (await auth.changePassword('bob', 'nope', 'Bob-new-pass-10')).error === 'The current password is wrong.')
directory.minLength = 14 // the domain wants longer than Argus's own 8
check('signed in: against the domain\'s rules, said plainly', /password rules — length, complexity or history/.test((await auth.changePassword('bob', 'Bob-new-pass-9', 'Shortish-9'))?.error ?? '') && directory.users.bob.password === 'Bob-new-pass-9')
delete directory.minLength
const localChange = await auth.changePassword('kkk', 'Kkk-pass-1', 'Kkk-pass-2')
check('a local account\'s Change password is as before (AD not asked)', localChange.ok === true && localChange.message === undefined && (await auth.checkLogin('kkk', 'Kkk-pass-2')))
check('no Windows password is stored anywhere', !['New-pass-77', 'Old-pass-1', 'Bob-new-pass-9', 'Bob-pass-1'].some((pw) => everything().includes(pw)))

// ---- admin routes ----
const adm = { user: 'localboss', admin: true }
const peekOpen = async (o) => (o.peek ? { cert: { subject: 'CN=DC01.JFL.LOCAL', issuer: 'DC=LOCAL, DC=JFL, CN=DC01', altNames: 'DNS:DC01.JFL.LOCAL', validFrom: 'Jan 1 2026', validTo: 'Jan 1 2027', fingerprint256: FP }, chain: [], authorized: false } : viaFake(o))
const R = ad.makeAd({ store, open: peekOpen, now: () => clock })
const route = (method, path, body, who = adm) => handleAd(R, method, path, async () => body, who, { ip: '10.9.9.9' })
check('not ours: other paths', (await route('GET', '/api/admin/users')) === null)
check('viewers may not', (await route('GET', '/api/admin/ad', null, { user: 'bob', admin: false }))[0] === 403)
const got = await route('GET', '/api/admin/ad')
check('GET: settings without the look-up password', got[0] === 200 && got[1].settings.lookupPasswordSet === true && !JSON.stringify(got[1]).includes('Svc-pass-1'))
const chk = await route('POST', '/api/admin/ad/check', { server: '192.168.0.19' })
check('Check connection: the certificate, and that it is the pinned one', chk[1].reachable === true && chk[1].cert.fingerprint256 === FP && chk[1].trusted.pinMatches === true)
store.save({ ...base, enabled: false, pins: {} })
check('Trust: refused for a server not in the list', (await route('POST', '/api/admin/ad/trust', { server: '10.1.1.1', fingerprint: FP }))[0] === 400)
check('Trust: refused when the server now shows another certificate', (await route('POST', '/api/admin/ad/trust', { server: '192.168.0.19', fingerprint: FP.replace(/^AA/, 'AB') }))[0] === 409)
const tr = await route('POST', '/api/admin/ad/trust', { server: '192.168.0.19', fingerprint: FP.toLowerCase() })
check('Trust: pins the fingerprint for that server', tr[0] === 200 && store.get().pins['192.168.0.19'] === FP && tr[1].settings.trust['192.168.0.19'] === 'pinned')
const saveOn = await route('POST', '/api/admin/ad', { enabled: true })
check('Save on with one DC untrusted: refused in plain words', saveOn[0] === 400 && /192\.168\.1\.19/.test(saveOn[1].error))
const saved = await route('POST', '/api/admin/ad', { enabled: true, servers: ['192.168.0.19'] })
check('Save: ok, and audited as a settings change', saved[0] === 200 && saved[1].settings.enabled === true && readFileSync(join(dir, 'audit.jsonl'), 'utf8').includes('active-directory'))
const test = await route('POST', '/api/admin/ad/test', { user: 'wendy', password: 'Wendy-pass-1', settings: { servers: ['192.168.0.19'] } })
check('Test a sign-in: the role it would get, and that re-checks can find them', test[0] === 200 && test[1].ok === true && test[1].role === 'admin' && test[1].lookup?.ok === true)
const test2 = await route('POST', '/api/admin/ad/test', { user: 'nogroup', password: 'No-pass-1' })
check('Test a sign-in: the plain reason', test2[1].ok === false && test2[1].message === 'Your account is not in a CCTV group. Ask an administrator.')
check('the test password is not kept or logged', !everything().includes('Wendy-pass-1') && !everything().includes('No-pass-1'))
const off = await route('POST', '/api/admin/ad', { enabled: false })
check('switching it off ends every AD user\'s sessions', off[0] === 200 && auth.verifySession(auth.createSession('wendy')) === null)

A.stop()
bookmarks.closeBookmarks()
await fake.close()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
