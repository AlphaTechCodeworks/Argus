import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const temporary = mkdtempSync(join(tmpdir(), 'argus-password-test-'))
process.env.DATA_DIR = temporary
const auth = await import('../auth.mjs')

test('reset sessions are restricted until a distinct new password is saved', async () => {
  auth.saveUsers({ alice: { hash: await auth.hashPassword('temporary-password'), role: 'viewer', mustChangePassword: true }, bob: { hash: await auth.hashPassword('bob-password'), role: 'admin' } })
  const token = auth.createSession('alice')
  assert.equal(auth.verifySession(token), null)
  assert.equal(auth.verifySession(token, { allowPasswordChange: true }), 'alice')
  assert.ok((await auth.changePassword('alice', 'incorrect', 'new-user-password')).error)
  assert.ok((await auth.changePassword('alice', 'temporary-password', 'temporary-password')).error)
  assert.ok((await auth.changePassword('alice', 'temporary-password', 'short')).error)
  assert.equal(auth.mustChangePassword('alice'), true)
  assert.deepEqual(await auth.changePassword('alice', 'temporary-password', 'new-user-password'), { ok: true })
  assert.equal(auth.mustChangePassword('alice'), false)
  assert.equal(auth.loadUsers().alice.role, 'viewer')
  assert.equal(await auth.checkLogin('alice', 'temporary-password'), false)
  assert.equal(await auth.checkLogin('alice', 'new-user-password'), true)
  assert.equal(await auth.checkLogin('bob', 'bob-password'), true)
  assert.equal(auth.verifySession(token, { allowPasswordChange: true }), null)
  assert.equal(auth.verifySession(auth.createSession('alice')), 'alice')
})

test('restricted sessions can still sign out', async () => {
  const users = auth.loadUsers()
  users.alice = { ...users.alice, mustChangePassword: true }
  auth.saveUsers(users)
  const token = auth.createSession('alice')
  assert.equal(auth.revokeSession(token), true)
  assert.equal(auth.verifySession(token, { allowPasswordChange: true }), null)
})
test.after(() => rmSync(temporary, { recursive: true, force: true }))
