import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'argus-ui-prefs-'))
const { handleUiPreferences, handleGridOrder, PREFS_FILE } = await import('../user-prefs.mjs')
function req(method, body, headers = {}) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  request.method = method
  request.headers = { host: 'cctv.local', origin: 'https://cctv.local', 'content-type': 'application/json', ...headers }
  return request
}
const get = (user) => handleUiPreferences(req('GET'), user)
const patch = (user, preferences, account = user, headers) => handleUiPreferences(req('PATCH', { account, preferences }, headers), user)

test('settings follow each account and patches retain unrelated settings and camera order', async () => {
  assert.deepEqual((await get('alice'))[1], { user: 'alice', preferences: {} })
  assert.equal((await patch('alice', { 'cctv.layout': 'g4', 'cctv.theme': 'light' }))[0], 200)
  assert.equal((await patch('bob', { 'cctv.layout': 'auto', 'cctv.theme': 'dark' }))[0], 200)
  await handleGridOrder(req('PUT', { order: ['nvr/0'], version: 0 }), 'alice')
  await patch('alice', { 'cctv.sidebarPinned': '1' })
  assert.deepEqual((await get('alice'))[1].preferences, { 'cctv.layout': 'g4', 'cctv.theme': 'light', 'cctv.sidebarPinned': '1' })
  assert.equal((await get('bob'))[1].preferences['cctv.layout'], 'auto')
  assert.deepEqual(JSON.parse(readFileSync(PREFS_FILE, 'utf8')).alice.gridOrder, ['nvr/0'])
  assert.equal((await get('alice'))[2]['cache-control'], 'no-store')
})
test('preferences reject anonymous, cross-origin, invalid and account-switched writes', async () => {
  assert.equal((await get(null))[0], 401)
  assert.equal((await patch('alice', { 'cctv.theme': 'dark' }, 'bob'))[0], 409)
  assert.equal((await patch('alice', { 'admin': '1' }))[0], 400)
  assert.equal((await patch('alice', { 'cctv.layout': 'g99' }))[0], 400)
  assert.equal((await patch('alice', { 'cctv.layout.phone': 'g12' }))[0], 400)
  assert.equal((await patch('alice', { 'cctv.favoriteSites': JSON.stringify(Array(101).fill('Site')) }))[0], 400)
  assert.equal((await patch('alice', { 'cctv.theme': 'dark' }, 'alice', { origin: 'https://evil.test' }))[0], 403)
  assert.equal((await get('alice'))[1].preferences['cctv.theme'], 'light')
})
test('damaged preference files are not overwritten', async () => {
  writeFileSync(PREFS_FILE, 'damaged')
  assert.equal((await get('alice'))[0], 500)
  assert.equal((await patch('alice', { 'cctv.theme': 'dark' }))[0], 500)
  assert.equal(readFileSync(PREFS_FILE, 'utf8'), 'damaged')
})
