import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frameGaps, gapMeter } from '../frame-gaps.mjs'

test('an even stream and a clumped one are told apart, in the page\'s own measure', () => {
  let t = 0
  const lines = []
  const m = gapMeter({ where: 'test', now: () => t, log: (l) => lines.push(l), everyMs: 10_000 })
  // 25 frames a second for 5 s: one every 40 ms; the other waits 200 ms each second, then four at once
  for (let ms = 0; ms <= 5000; ms += 40) {
    t = ms
    m.note('even')
    const inSecond = ms % 1000
    if (inSecond >= 200) m.note('clumped')
    if (inSecond === 200) for (let i = 0; i < 4; i++) m.note('clumped')
  }
  const line = m.report()
  assert.match(line, /^\[gaps test\] 2 streams, 2[45]\.\d frames\/s each/)
  assert.match(line, /middle stream 240 ms, 9 in 10 under 240 ms, worst single wait 240 ms/) // (the upper of two: 40 and 240)
  assert.equal(m.report(), null) // nothing since: nothing said
})

test('it reports by itself once the period is up, and starts again', () => {
  let t = 0
  const lines = []
  const m = gapMeter({ where: 'w', now: () => t, log: (l) => lines.push(l), everyMs: 3000 })
  for (t = 0; t <= 6100; t += 50) m.note('a')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /1 streams.*middle stream 50 ms/)
})

test('switched off, there is no meter at all', () => {
  assert.equal(frameGaps('x', { CCTV_FRAME_GAPS: 'off' }), null)
  assert.ok(frameGaps('x', {}))
})
