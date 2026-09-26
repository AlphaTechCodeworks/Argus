// Tests adding and removing accounts from the app (users-api.mjs), on a temporary data folder.
//   node cctv/test/users-api.test.mjs
import { mkdtempSync, rmSync } from 'node:fs'
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

rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
