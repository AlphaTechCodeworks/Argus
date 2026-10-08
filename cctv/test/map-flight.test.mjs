import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planFlight, flightPose } from '../public/map-flight.js'

const from = { cx: 0, cy: 0, zoom: 10 }
const viewport = { width: 1000, height: 600, minZoom: 0 }
test('short hops take less time than distant journeys and durations stay bounded', () => {
  const near = planFlight(from, { cx: 0.1, cy: 0, zoom: 10 }, viewport)
  const far = planFlight(from, { cx: 100, cy: 100, zoom: 10 }, viewport)
  assert.ok(near.duration < far.duration)
  assert.ok(near.duration >= 350 && far.duration <= 1400)
  assert.equal(near.pullback, 0)
  assert.equal(far.pullback, 4)
})
test('same destination skips animation and explicit durations are honored', () => {
  assert.equal(planFlight(from, from, viewport).duration, 0)
  assert.equal(planFlight(from, { ...from, cx: 10 }, { ...viewport, duration: 600 }).duration, 600)
})
test('flight lands exactly, keeps zoom bounded and has a smooth approach', () => {
  const to = { cx: 20, cy: 10, zoom: 12 }
  const p = planFlight(from, to, viewport)
  assert.deepEqual(flightPose(from, to, p.lowest, p.pullback, 0), from)
  assert.deepEqual(flightPose(from, to, p.lowest, p.pullback, 1), to)
  for (let i = 0; i <= 100; i++) {
    const pose = flightPose(from, to, p.lowest, p.pullback, i / 100)
    assert.ok(pose.zoom >= p.lowest && pose.zoom <= 12)
    assert.ok(pose.cx >= 0 && pose.cx <= 20)
  }
  assert.ok(flightPose(from, to, p.lowest, p.pullback, .001).cx < .00001)
})
