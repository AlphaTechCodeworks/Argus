import test from 'node:test'
import assert from 'node:assert/strict'
import { streamHealth, healthyRetryReset, offlineHealth } from '../public/stream-health.js'
import { diffCameras } from '../public/grid-diff.js'

test('offline reasons use explicit server state, not guesses', () => {
  assert.equal(offlineHealth({ nvrOnline: false }), 'NVR offline')
  assert.equal(offlineHealth({ nvrOnline: true, cameraOnline: false }), 'Camera offline')
  assert.equal(offlineHealth({ nvrOnline: true, cameraOnline: true, nvrVideoOnline: false }), 'Video connection reconnecting')
  assert.equal(offlineHealth({}), 'Offline')
})
test('health-only changes update one tile without rebuilding streams', () => {
  const old = [{ nvr: 'n', ch: 0, site: 's', name: 'c', online: false, nvrOnline: false }]
  const next = [{ ...old[0], nvrOnline: true }]
  const diff = diffCameras(old, next, { site: '', hideOffline: false, perPage: 4, page: 0 })
  assert.equal(diff.full, false)
  assert.equal(diff.changed[0].online, false)
  assert.equal(diff.changed[0].health, true)
})

test('recent packets cannot hide a frozen decoder', () => {
  const h = streamHealth({ now: 14000, openedAt: 1000, dataAt: 13900, frameAt: 1500 })
  assert.equal(h.text, 'Video stalled')
  assert.equal(h.recover, true)
})
test('no first picture and a slow connection are different states', () => {
  assert.equal(streamHealth({ now: 7000, openedAt: 1000, dataAt: 1000, frameAt: 0 }).text, 'No video received')
  assert.equal(streamHealth({ now: 9000, openedAt: 1000, dataAt: 2000, frameAt: 2000 }).text, 'Connection slow - waiting for video')
})
test('hidden pages and explicit NVR waits do not churn streams', () => {
  for (const flags of [{ hidden: true }, { waiting: true }]) {
    assert.equal(streamHealth({ now: 50000, openedAt: 1000, dataAt: 1000, frameAt: 0, ...flags }).recover, false)
  }
})
test('retry reset requires sustained decoded pictures', () => {
  assert.equal(healthyRetryReset(1000, 1001), false)
  assert.equal(healthyRetryReset(1000, 11000), true)
  assert.equal(healthyRetryReset(0, 11000), false)
})
