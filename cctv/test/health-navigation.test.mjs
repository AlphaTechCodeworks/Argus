import test from 'node:test'
import assert from 'node:assert/strict'
import { healthRecorderPage } from '../public/health.js'

test('large recorder fleets have bounded pages and faults first', () => {
  const panels = Array.from({ length: 5000 }, (_, i) => ({ id: `r${i}`, name: `Site ${i}`, status: { state: i === 4999 ? 'bad' : 'ok' } }))
  const first = healthRecorderPage(panels)
  assert.equal(first.rows.length, 25)
  assert.equal(first.rows[0].id, 'r4999')
  assert.equal(first.pages, 200)
  const faults = healthRecorderPage(panels, { issuesOnly: true, page: 199 })
  assert.equal(faults.total, 1)
  assert.equal(faults.page, 0)
  assert.equal(healthRecorderPage(panels, { query: 'SITE 4999' }).rows[0].id, 'r4999')
  assert.equal(healthRecorderPage(panels, { query: 'missing' }).rows.length, 0)
})

test('online recorder disk and camera warnings remain discoverable', () => {
  const panels = [{ id: 'disk', status: { state: 'ok' }, disks: { state: 'bad' } }, { id: 'camera', status: { state: 'ok' }, glance: { cameras: { state: 'warn' } } }]
  assert.equal(healthRecorderPage(panels, { issuesOnly: true }).total, 2)
})
