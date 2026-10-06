import test from 'node:test'
import assert from 'node:assert/strict'
import { liveStartTimeoutMs } from '../live-start-policy.mjs'

test('P2P Main allows the complete vendor connection window', () => {
  assert.equal(liveStartTimeoutMs(0, 'TEST_SERIAL'), 35_000)
})

test('LAN Main and all Sub streams retain their existing timeout', () => {
  assert.equal(liveStartTimeoutMs(0, undefined), 15_000)
  assert.equal(liveStartTimeoutMs(0, ''), 15_000)
  assert.equal(liveStartTimeoutMs(1, 'TEST_SERIAL'), 15_000)
  assert.equal(liveStartTimeoutMs(1, undefined), 15_000)
})
