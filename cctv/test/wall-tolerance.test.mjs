import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULTS, TOLERANCE_ADMIN_PATH, TOLERANCE_PATH, cleanTolerance, handleTolerance, makeTolerance } from '../wall-tolerance.mjs'

const req = (method, body, headers = {}) => {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  return { method, headers: { 'content-type': 'application/json', host: 'cctv.test', ...headers }, async *[Symbol.asyncIterator]() { yield* chunks } }
}

test('a pair is kept only when fine is above poor and both are sensible shares', () => {
  assert.deepEqual(cleanTolerance({ okShare: 0.9, poorShare: 0.6 }), { okShare: 0.9, poorShare: 0.6 })
  assert.deepEqual(cleanTolerance({ okShare: '0.853', poorShare: 0.5 }), { okShare: 0.85, poorShare: 0.5 })
  for (const bad of [null, {}, { okShare: 0.7, poorShare: 0.7 }, { okShare: 0.6, poorShare: 0.8 }, { okShare: 1.2, poorShare: 0.5 }, { okShare: 0.8, poorShare: 0.05 }, { okShare: 'x', poorShare: 0.5 }]) assert.equal(cleanTolerance(bad), null)
})

test('never set, or unreadable: the owner\'s defaults; set: kept on disk and read back by a new process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'argus-tol-'))
  const store = makeTolerance({ dir, now: () => Date.parse('2026-10-09T19:00:00Z') })
  assert.deepEqual(store.get(), DEFAULTS)
  assert.deepEqual(store.set({ okShare: 0.9, poorShare: 0.75 }, 'mike'), { okShare: 0.9, poorShare: 0.75 })
  assert.equal(store.set({ okShare: 0.5, poorShare: 0.9 }, 'mike'), null)
  assert.deepEqual(store.get(), { okShare: 0.9, poorShare: 0.75 }) // (the refused one changed nothing)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'wall-tolerance.json'), 'utf8')), { okShare: 0.9, poorShare: 0.75, by: 'mike', at: '2026-10-09T19:00:00.000Z' })
  assert.deepEqual(makeTolerance({ dir }).get(), { okShare: 0.9, poorShare: 0.75 })
  writeFileSync(join(dir, 'wall-tolerance.json'), '{broken')
  assert.deepEqual(makeTolerance({ dir }).get(), DEFAULTS)
})

test('reading is for anyone signed in; changing is for administrators, from this site, in JSON', async () => {
  const store = makeTolerance({ dir: mkdtempSync(join(tmpdir(), 'argus-tol-')) })
  const lines = []
  const as = (user, admin) => ({ user, admin, store, log: (l) => lines.push(l) })
  assert.equal(await handleTolerance(req('GET'), '/api/other', as('mike', true)), null)
  assert.equal((await handleTolerance(req('GET'), TOLERANCE_PATH, as(null, false)))[0], 401)
  assert.deepEqual((await handleTolerance(req('GET'), TOLERANCE_PATH, as('viewer', false))).slice(0, 2), [200, { ...DEFAULTS, defaults: { ...DEFAULTS } }])
  assert.equal((await handleTolerance(req('PUT', { okShare: 0.9, poorShare: 0.6 }), TOLERANCE_ADMIN_PATH, as('viewer', false)))[0], 403)
  assert.equal((await handleTolerance(req('POST', {}), TOLERANCE_ADMIN_PATH, as('mike', true)))[0], 405)
  assert.equal((await handleTolerance(req('PUT', {}, { 'content-type': 'text/plain' }), TOLERANCE_ADMIN_PATH, as('mike', true)))[0], 415)
  assert.equal((await handleTolerance(req('PUT', { okShare: 0.9, poorShare: 0.6 }, { origin: 'https://evil.example' }), TOLERANCE_ADMIN_PATH, as('mike', true)))[0], 403)
  assert.equal((await handleTolerance(req('PUT', '{not json'), TOLERANCE_ADMIN_PATH, as('mike', true)))[0], 400)
  assert.equal((await handleTolerance(req('PUT', { okShare: 0.6, poorShare: 0.9 }), TOLERANCE_ADMIN_PATH, as('mike', true)))[0], 400)
  assert.deepEqual(store.get(), DEFAULTS)
  const ok = await handleTolerance(req('PUT', { okShare: 0.9, poorShare: 0.6 }, { origin: 'https://cctv.test' }), TOLERANCE_ADMIN_PATH, as('mike', true))
  assert.deepEqual(ok.slice(0, 2), [200, { okShare: 0.9, poorShare: 0.6, defaults: { ...DEFAULTS } }])
  assert.deepEqual(store.get(), { okShare: 0.9, poorShare: 0.6 })
  assert.match(lines[0], /mike set the wall tolerance: fine from 90%, poor below 60%/)
})

test('a folder that cannot be written: said, and nothing changes', async () => {
  const store = makeTolerance({ dir: '/nowhere', write: () => { throw Object.assign(new Error('no'), { code: 'EACCES' }) } })
  const r = await handleTolerance(req('PUT', { okShare: 0.9, poorShare: 0.6 }), TOLERANCE_ADMIN_PATH, { user: 'mike', admin: true, store })
  assert.equal(r[0], 500)
  assert.match(r[1].error, /EACCES/)
  assert.deepEqual(store.get(), DEFAULTS)
})
