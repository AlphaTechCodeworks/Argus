import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MODULES, SICEX_ADMIN_PATH, SICEX_PATH, autoOffReason, cleanSicex, effective, handleSicex, makeSicex, sicexDefaults } from '../sicex.mjs'

const req = (method, body, headers = {}) => {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  return { method, headers: { 'content-type': 'application/json', host: 'cctv.test', ...headers }, async *[Symbol.asyncIterator]() { yield* chunks } }
}
const dir = () => mkdtempSync(join(tmpdir(), 'argus-sicex-'))
const allOn = Object.fromEntries(MODULES.map((m) => [m.id, true]))
const allOff = Object.fromEntries(MODULES.map((m) => [m.id, false]))
const cohorts = (on, off, secs = 5000) => ({ hours: 24, cohorts: { apsi: { score: on, tileSeconds: secs }, holdout: { score: off, tileSeconds: secs } } })

test('everything is on until someone says otherwise; a change touches only what it names', () => {
  assert.deepEqual(sicexDefaults().modules, allOn)
  const s = cleanSicex({ modules: { wallThin: false, nonsense: true }, sitesOff: [' Shad ', 'Shad', 'G-Port'] })
  assert.deepEqual([s.enabled, s.modules.wallThin, s.modules.linked, 'nonsense' in s.modules, s.sitesOff], [true, false, true, false, ['G-Port', 'Shad']])
  for (const bad of [null, 'x', { enabled: 'yes' }, { modules: [] === 0 }, { modules: { linked: 1 } }, { sitesOff: 'Shad' }, { sitesOff: [''] }, { sitesOff: [7] }]) assert.equal(cleanSicex(bad), null, JSON.stringify(bad))
})

test('in effect for a browser: nothing with the engine off, nothing for the comparison group', () => {
  const s = cleanSicex({ modules: { hold: false } })
  assert.deepEqual(effective(s, 'apsi'), { ...allOn, hold: false })
  assert.deepEqual(effective(s, 'holdout'), allOff)
  assert.deepEqual(effective({ ...s, enabled: false }, 'apsi'), allOff)
})

test('kept on disk, read back by a new process, and everything on when the file is unreadable', () => {
  const d = dir()
  const store = makeSicex({ dir: d, now: () => Date.parse('2026-10-09T21:00:00Z') })
  assert.deepEqual(store.get(), sicexDefaults())
  assert.equal(store.set({ modules: { wallThin: 'no' } }, 'mike'), null)
  assert.equal(store.set({ enabled: false, sitesOff: ['Shad'] }, 'mike').enabled, false)
  const kept = JSON.parse(readFileSync(join(d, 'sicex.json'), 'utf8'))
  assert.deepEqual([kept.enabled, kept.sitesOff, kept.by, kept.at], [false, ['Shad'], 'mike', '2026-10-09T21:00:00.000Z'])
  assert.deepEqual(makeSicex({ dir: d }).get().sitesOff, ['Shad'])
  writeFileSync(join(d, 'sicex.json'), '{broken')
  assert.deepEqual(makeSicex({ dir: d }).get(), sicexDefaults())
})

test('it switches itself off only on a clear margin, with enough of both groups measured', () => {
  assert.equal(autoOffReason(cohorts(0.6, 0.7)), 'over the last 24 h the screens with it scored 60 and the screens without it 70')
  assert.equal(autoOffReason(cohorts(0.66, 0.7)), null) // (inside the margin)
  assert.equal(autoOffReason(cohorts(0.8, 0.7)), null) // (it helps)
  assert.equal(autoOffReason(cohorts(0.5, 0.9, 600)), null) // (not enough measured)
  assert.equal(autoOffReason(cohorts(null, 0.9)), null)
  assert.equal(autoOffReason({}), null)
})

test('switched off by itself: kept, said in the log once, and cleared when a person turns it on again', () => {
  const d = dir()
  const lines = []
  const store = makeSicex({ dir: d, now: () => Date.parse('2026-10-09T21:00:00Z'), log: (l) => lines.push(l) })
  assert.equal(store.autoCheck(cohorts(0.8, 0.7)), null)
  assert.match(store.autoCheck(cohorts(0.5, 0.7)), /scored 50 .* without it 70/)
  assert.deepEqual([store.get().enabled, store.get().auto.at], [false, '2026-10-09T21:00:00.000Z'])
  assert.equal(store.autoCheck(cohorts(0.5, 0.7)), null) // (off already: nothing more to do or say)
  assert.equal(lines.filter((l) => /SWITCHED ITSELF OFF/.test(l)).length, 1)
  assert.deepEqual(makeSicex({ dir: d }).get().enabled, false) // (a restart does not bring it back)
  const on = store.set({ enabled: true }, 'mike')
  assert.deepEqual([on.enabled, on.auto], [true, null])
})

test('a data folder that cannot be written: still switched off in this process', () => {
  const lines = []
  const store = makeSicex({ dir: '/nowhere', write: () => { throw Object.assign(new Error('no'), { code: 'EACCES' }) }, log: (l) => lines.push(l) })
  assert.ok(store.autoCheck(cohorts(0.5, 0.7)))
  assert.equal(store.get().enabled, false)
  assert.match(lines[0], /EACCES/)
})

test('anyone signed in may read what applies to their browser; only an administrator, from this site, may change it', async () => {
  const store = makeSicex({ dir: dir() })
  const lines = []
  const as = (user, admin, device = '') => ({ user, admin, store, device, cohortOf: (u, dev) => (dev === 'heldbackdevice' ? 'holdout' : 'apsi'), log: (l) => lines.push(l) })
  assert.equal(await handleSicex(req('GET'), '/api/other', as('mike', true)), null)
  assert.equal((await handleSicex(req('GET'), SICEX_PATH, as(null, false)))[0], 401)
  const mine = (await handleSicex(req('GET'), SICEX_PATH, as('viewer', false, 'abc123abc123')))[1]
  assert.deepEqual([mine.enabled, mine.cohort, mine.modules, mine.list.length], [true, 'apsi', allOn, MODULES.length])
  const held = (await handleSicex(req('GET'), SICEX_PATH, as('viewer', false, 'heldbackdevice')))[1]
  assert.deepEqual([held.cohort, held.modules, held.set], ['holdout', allOff, allOn]) // (set: what the administrator chose)
  assert.equal((await handleSicex(req('GET'), SICEX_PATH, as('viewer', false, '../etc')))[1].cohort, 'apsi') // (no device named: not held back)
  assert.equal((await handleSicex(req('PUT', { enabled: false }), SICEX_ADMIN_PATH, as('viewer', false)))[0], 403)
  assert.equal((await handleSicex(req('POST', {}), SICEX_ADMIN_PATH, as('mike', true)))[0], 405)
  assert.equal((await handleSicex(req('PUT', {}, { 'content-type': 'text/plain' }), SICEX_ADMIN_PATH, as('mike', true)))[0], 415)
  assert.equal((await handleSicex(req('PUT', { enabled: false }, { origin: 'https://evil.example' }), SICEX_ADMIN_PATH, as('mike', true)))[0], 403)
  assert.equal((await handleSicex(req('PUT', { modules: { linked: 'off' } }), SICEX_ADMIN_PATH, as('mike', true)))[0], 400)
  assert.deepEqual(store.get(), sicexDefaults())
  const ok = await handleSicex(req('PUT', { modules: { wallThin: false }, sitesOff: ['Shad'] }, { origin: 'https://cctv.test' }), SICEX_ADMIN_PATH, as('mike', true))
  assert.deepEqual([ok[0], ok[1].modules.wallThin, ok[1].sitesOff], [200, false, ['Shad']])
  assert.match(lines.at(-1), /mike set the engine on, modules off: wallThin, sites left out: Shad/)
})
