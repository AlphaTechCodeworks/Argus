import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fullRateTiles, nextBudget, thinStart } from '../public/wall-thin.js'

const wall = (n, fps = 22) => Array.from({ length: n }, (_, i) => ({ key: `nvr1/${i}`, fps, kbps: 300 + ((i * 37) % 100), full: true }))

test('a device that keeps up is never limited', () => {
  let s = thinStart()
  for (let t = 0; t < 120_000; t += 2000) s = nextBudget(s, { now: t, fed: 900, decoded: 898, heldMs: 300, all: 900 })
  assert.equal(s.budget, Infinity)
  assert.equal(fullRateTiles(wall(36), s.budget).size, 36)
})

test('the measured wall of 100: cut to what was decoded less a fifth, then left to settle', () => {
  let s = nextBudget(thinStart(), { now: 0, fed: 2200, decoded: 720, heldMs: 2000, all: 2200 })
  assert.equal(s.budget, 576)
  const full = fullRateTiles(wall(100), s.budget)
  assert.equal(full.size, 26) // 26 x 22 = 572 frames a second
  // (still behind 2 s later: not cut again until the decoders have had time to catch up)
  assert.equal(nextBudget(s, { now: 2000, fed: 572, decoded: 400, heldMs: 1500, all: 2200 }).budget, 576)
  assert.equal(nextBudget(s, { now: 7000, fed: 572, decoded: 400, heldMs: 1500, all: 2200 }).budget, 320)
})

test('held too long counts as behind even when every frame comes back', () => {
  assert.equal(nextBudget(thinStart(), { now: 0, fed: 900, decoded: 900, heldMs: 1400, all: 900 }).budget, 720)
})

test('room again for 20 s: 15% more, and back to no limit once that covers the wall', () => {
  let s = { budget: 576, changedAt: 0, okSince: null }
  for (let t = 2000; t <= 26_000; t += 2000) s = nextBudget(s, { now: t, fed: 570, decoded: 570, heldMs: 200, all: 800 })
  assert.equal(s.budget, 663)
  for (let t = 28_000; t <= 80_000; t += 2000) s = nextBudget(s, { now: t, fed: 650, decoded: 650, heldMs: 200, all: 800 })
  assert.equal(s.budget, Infinity)
})

test('never under a few tiles at full rate, however little was decoded', () => {
  assert.equal(nextBudget(thinStart(), { now: 0, fed: 2000, decoded: 10, heldMs: 5000, all: 2000 }).budget, 60)
})

test('the busiest tiles keep every frame, and one already at full rate is not swapped for a near equal', () => {
  const tiles = [
    { key: 'a', fps: 20, kbps: 900, full: false },
    { key: 'b', fps: 20, kbps: 500, full: true },
    { key: 'c', fps: 20, kbps: 560, full: false },
    { key: 'd', fps: 20, kbps: 100, full: true }
  ]
  assert.deepEqual([...fullRateTiles(tiles, 40)].sort(), ['a', 'b']) // b (500 x 1.25) outranks c (560)
  assert.deepEqual([...fullRateTiles(tiles.map((t) => ({ ...t, full: false })), 40)].sort(), ['a', 'c'])
  // a tile too dear for what is left is passed over for a cheaper one further down
  assert.deepEqual([...fullRateTiles([{ key: 'x', fps: 30, kbps: 900, full: false }, { key: 'y', fps: 25, kbps: 800, full: false }, { key: 'z', fps: 10, kbps: 100, full: false }], 40)].sort(), ['x', 'z'])
})
