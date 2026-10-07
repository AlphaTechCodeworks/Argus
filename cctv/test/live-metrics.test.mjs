import test from 'node:test'
import assert from 'node:assert/strict'
import { ReceiveMetrics, liveMetricsText } from '../public/live-metrics.js'

test('received rate uses elapsed time and averages five seconds', () => {
  const m = new ReceiveMetrics(0)
  for (let i = 0; i < 25; i++) m.receive(12000)
  assert.deepEqual(m.sample(1000), { receivedFps: 25, receivedKbps: 2400 })
  assert.deepEqual(m.sample(2000), { receivedFps: 0, receivedKbps: 1200 })
  m.sample(3000); m.sample(4000); m.sample(5000)
  assert.equal(m.sample(6000).receivedKbps, 0)
  m.receive(10000)
  m.reset(7000)
  assert.deepEqual(m.sample(8000), { receivedFps: 0, receivedKbps: 0 })
})
test('received FPS handles delayed timers', () => {
  const m = new ReceiveMetrics(0)
  for (let i = 0; i < 50; i++) m.receive(1000)
  assert.deepEqual(m.sample(2000), { receivedFps: 25, receivedKbps: 200 })
})
test('overlay describes real stream and hides stale measurements', () => {
  const stats = { width: 1920, height: 1080, codec: 'hvc1.1.6.L93', receivedFps: 25, receivedKbps: 2400 }
  assert.equal(liveMetricsText(stats, true, true), 'Main \u00b7 1920\u00d71080 \u00b7 H.265 \u00b7 25 FPS \u00b7 2.40 Mbps')
  assert.equal(liveMetricsText(stats, false, false), 'Sub \u00b7 -- \u00b7 -- \u00b7 -- FPS \u00b7 -- Mbps')
  assert.match(liveMetricsText({ ...stats, codec: 'avc1.640028' }, false, true), /H.264/)
})
