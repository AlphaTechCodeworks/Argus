import assert from 'node:assert/strict'
import test from 'node:test'
import { healthConnection, healthIssue } from '../public/health-layout-model.js'
test('video and management status are independent', () => {
  assert.equal(healthConnection({}, { online: false, videoOnline: true }).text, 'Video only')
  assert.equal(healthConnection({}, { online: true }).text, 'Connected')
  assert.equal(healthConnection({}, { status: 'connecting' }).text, 'Connecting')
  assert.equal(healthConnection({}, { online: false }).text, 'Disconnected')
  assert.equal(healthConnection({}, { online: true, loginError: 'refused' }).text, 'Disconnected')
})
test('unknown disk telemetry is not a confirmed disk failure', () => {
  const panel = { status: { state: 'ok' }, glance: { cameras: { state: 'ok' } }, disks: { state: 'warn' }, retention: { state: 'warn' } }
  assert.equal(healthIssue(panel), false)
  assert.equal(healthIssue({ ...panel, disks: { state: 'bad' } }), true)
  assert.equal(healthIssue({ ...panel, glance: { cameras: { state: 'warn' } } }), true)
})
