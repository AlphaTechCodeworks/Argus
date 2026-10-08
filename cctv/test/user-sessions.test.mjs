import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectionOf, makeUserSessions } from '../user-sessions.mjs'
import { makePresence } from '../presence.mjs'

assert.equal(connectionOf('::ffff:192.168.3.223').connection, 'LAN')
assert.equal(connectionOf('10.1.2.3', '8.8.8.8').connection, 'LAN') // untrusted header ignored
assert.equal(connectionOf('127.0.0.1', '8.8.8.8').connection, 'Web')
assert.equal(connectionOf('8.8.8.8').connection, 'Web')
assert.equal(connectionOf('100.64.0.1').connection, 'Web')
assert.equal(connectionOf('fd12::1').connection, 'LAN')
let disconnected = 0
const presence = makePresence()
presence.join('alice-browser', { close(code) { assert.equal(code, 1008); disconnected++ } }, { user: 'alice' })
presence.join('bob-browser', { close() { throw Error('Wrong user disconnected') } }, { user: 'bob' })
assert.equal(presence.disconnectUser('alice'), 1)
assert.equal(disconnected, 1)
assert.equal(presence.summary().people, 1)
let clock = 0
const sessions = makeUserSessions({ now: () => clock, ttlMs: 100, max: 2 })
sessions.touch('secret-a', 'alice', '192.168.1.2')
sessions.touch('secret-b', 'alice', '127.0.0.1', '8.8.8.8')
assert.deepEqual(sessions.list().map(s => s.connection), ['LAN', 'Web'])
assert.ok(!JSON.stringify(sessions.list()).includes('secret'))
sessions.forgetToken('secret-a'); assert.equal(sessions.list().length, 1)
sessions.forget('alice'); assert.equal(sessions.list().length, 0)
for (let i = 0; i < 3; i++) sessions.touch(`t${i}`, `u${i}`, '10.0.0.1')
assert.equal(sessions.list().length, 2)
clock = 101; assert.equal(sessions.list().length, 0)

const dir = mkdtempSync(join(tmpdir(), 'argus-kick-'))
process.env.DATA_DIR = dir
try {
  const auth = await import('../auth.mjs')
  auth.saveUsers({ alice: { role: 'viewer', hash: 'unchanged' }, bob: { role: 'admin', hash: 'unchanged' } })
  const old = auth.createSession('alice'), bob = auth.createSession('bob')
  assert.equal(auth.verifySession(old), 'alice')
  assert.equal(auth.signOutUser('alice'), true)
  assert.equal(auth.verifySession(old), null)
  assert.equal(auth.verifySession(bob), 'bob')
  assert.equal(auth.verifySession(auth.createSession('alice')), 'alice')
  assert.equal(auth.loadUsers().alice.hash, 'unchanged')
  assert.equal(auth.loadUsers().alice.role, 'viewer')
  assert.equal(auth.signOutUser('missing'), false)
} finally { rmSync(dir, { recursive: true, force: true }) }
console.log('PASS LAN/Web classification, privacy, expiry, bounded sessions, immediate same-millisecond kick, re-login and account preservation')
