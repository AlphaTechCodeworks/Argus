import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionState, matchesNvr } from '../public/sites-model.js'

test('video-only NVR is not reported disconnected', () => {
  assert.deepEqual(connectionState({ status: 'offline', videoOnline: true, managementOnline: false }), { key: 'partial', text: 'Video only', detail: 'Management unavailable' })
})
test('management and video status remain independent', () => {
  assert.equal(connectionState({ status: 'online', videoOnline: false }).detail, 'Video disconnected')
  assert.equal(connectionState({ status: 'offline' }).detail, 'Video status unknown')
  assert.equal(connectionState({ status: 'connecting', videoOnline: false }).key, 'connecting')
})
test('multiword search and connection filters work together', () => {
  const n = { name: 'North NVR', site: 'Loading Yard', sn: 'TEST123', status: 'offline', videoOnline: true }
  assert.equal(matchesNvr(n, 'yard north', 'partial'), true)
  assert.equal(matchesNvr(n, 'yard north', 'offline'), false)
  assert.equal(matchesNvr(n, 'wrong', ''), false)
})
