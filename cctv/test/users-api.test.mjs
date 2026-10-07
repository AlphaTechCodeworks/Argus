// Tests adding and removing accounts from the app (users-api.mjs), on a temporary data folder.
//   node cctv/test/users-api.test.mjs
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'cctv-users-'))
process.env.DATA_DIR = dir
const auth = await import('../auth.mjs')
const { handleUsers } = await import('../users-api.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const boss = { user: 'boss', admin: true }
const call = async (method, path, body, who = boss) => {
  try { return await handleUsers(method, path, async () => body, who) } catch (e) { return [e.status ?? 500, { error: e.message }] }
}

auth.saveUsers({ boss: { hash: await auth.hashPassword('boss-password'), role: 'admin' } })
check('a viewer cannot manage accounts', (await call('GET', '/api/admin/users', null, { user: 'x', admin: false }))[0] === 403)
check('other paths are not ours', (await handleUsers('GET', '/api/admin/rights', async () => ({}), boss)) === null)

let [st, body] = await call('POST', '/api/admin/users', { name: 'guard', password: 'guard-pass-1', role: 'viewer' })
check('an admin adds a viewer', st === 200 && body.user.role === 'viewer')
check('who can sign in with that password', await auth.checkLogin('guard', 'guard-pass-1'))
check('and the password is not stored as typed', !JSON.stringify(auth.loadUsers()).includes('guard-pass-1'))
check('a new user needs a password', (await call('POST', '/api/admin/users', { name: 'nopass', role: 'viewer' }))[0] === 400)
check('a short password is refused', (await call('POST', '/api/admin/users', { name: 'short', password: 'abc', role: 'viewer' }))[0] === 400)
check('a bad name is refused', (await call('POST', '/api/admin/users', { name: 'a b/c', password: 'long-enough', role: 'viewer' }))[0] === 400)
;[st] = await call('POST', '/api/admin/users', { name: 'guard', role: 'admin' })
check('a role change keeps the password', st === 200 && (await auth.checkLogin('guard', 'guard-pass-1')) && auth.loadUsers().guard.role === 'admin')
;[st] = await call('POST', '/api/admin/users', { name: 'guard', role: 'viewer' })
check('an admin can be made a viewer while another admin remains', st === 200)
check('the only admin cannot be made a viewer', (await call('POST', '/api/admin/users', { name: 'boss', role: 'viewer' }))[0] === 409)
check('nor removed', (await call('DELETE', '/api/admin/users/boss', null, { user: 'someone', admin: true }))[0] === 409)
check('nobody removes their own account', (await call('DELETE', '/api/admin/users/boss'))[0] === 409)
;[st] = await call('DELETE', '/api/admin/users/guard')
check('a viewer is removed', st === 200 && !Object.hasOwn(auth.loadUsers(), 'guard'))
check('and can no longer sign in', !(await auth.checkLogin('guard', 'guard-pass-1')))

// ---- rights rows follow the accounts (rights.mjs) --------------------------------------------------
// A removed account's rights must not wait for the next person given its name, and neither may its
// sessions: the new holder starts with nothing, and the old holder's cookie stays dead.
const rights = await import('../rights.mjs')
;[st] = await call('POST', '/api/admin/users', { name: 'gone', password: 'first-holder-1', role: 'viewer' })
rights.saveRights('gone', { grants: { live: ['*'], 'playback-nvr': ['*'] } })
const oldToken = auth.createSession('gone')
await call('DELETE', '/api/admin/users/gone')
check('removing an account drops its rights row', !Object.hasOwn(rights.loadRights().users, 'gone'))
await new Promise((r) => setTimeout(r, 5))
;[st] = await call('POST', '/api/admin/users', { name: 'gone', password: 'second-holder', role: 'viewer' })
const g = { user: 'gone', admin: false }
check('a re-created name starts with no access', st === 200 && !rights.can(g, 'live', { nvr: 'nvr1', ch: 0 }) && !rights.canAny(g, 'playback-nvr'))
check('...and has no rights row to inherit', JSON.stringify(rights.rightsOf('gone')) === JSON.stringify(rights.emptyRights()))
check("the earlier holder's cookie stays dead", auth.verifySession(oldToken) === null)
check('a fresh sign-in works', auth.verifySession(auth.createSession('gone')) === 'gone')
// a stale admin row must not make a re-created viewer an admin
;[st] = await call('POST', '/api/admin/users', { name: 'exadm', password: 'exadmin-pass', role: 'admin' })
rights.saveRights('exadm', { admin: true })
await call('DELETE', '/api/admin/users/exadm')
await call('POST', '/api/admin/users', { name: 'exadm', password: 'now-a-viewer', role: 'viewer' })
check('a stale admin row does not survive', !rights.can({ user: 'exadm', admin: false }, 'admin') && JSON.stringify(rights.rightsOf('exadm')) === JSON.stringify(rights.emptyRights()))
// a new viewer made while there is no rights.json yet: the migration must not hand them live '*'
rmSync(rights.RIGHTS_FILE, { force: true })
;[st] = await call('POST', '/api/admin/users', { name: 'fresh', password: 'fresh-viewer-1', role: 'viewer' })
check('a new viewer starts with no access even before rights.json exists', st === 200 && !rights.can({ user: 'fresh', admin: false }, 'live', { nvr: 'nvr1', ch: 0 }))

// A refusal is thrown (HttpError), and server.mjs has to answer it with its status and message: it
// went out as a bare 500, so the page could not say "A password is at least 8 characters".
{
  const refused = await handleUsers('POST', '/api/admin/users', async () => ({ name: 'short', password: 'abc', role: 'viewer' }), boss).catch((e) => e)
  check('a refusal carries its status and its message', refused?.status === 400 && /at least 8 characters/.test(refused.message ?? ''), String(refused))
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const route = server.slice(server.indexOf('usersRoute = await handleUsers('), server.indexOf('if (usersRoute) return sendJson(res, ...usersRoute)'))
  check('server.mjs answers a refusal with its status and message as JSON; anything else is still thrown',
    /catch \(e\) \{\s*if \(!Number\.isInteger\(e\?\.status\)\) throw e\s*usersRoute = \[e\.status, \{ error: e\.message \}\]\s*\}/.test(route), route)
}

rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
