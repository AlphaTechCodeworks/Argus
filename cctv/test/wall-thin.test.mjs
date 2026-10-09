import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fullRateTiles, nextBudget, thinStart } from '../public/wall-thin.js'

const wall = (n, fps = 22) => Array.from({ length: n }, (_, i) => ({ key: `nvr1/${i}`, fps, kbps: 300 + ((i * 37) % 100), full: true }))
/** Readings every 2 s from `from` to `to`, all the same. */
const run = (s, from, to, m) => { for (let t = from; t <= to; t += 2000) s = nextBudget(s, { now: t, ...m }); return s }
const BEHIND = { fed: 2200, decoded: 720, heldMs: 2000, all: 2200 }

test('a device that keeps up is never limited', () => {
  const s = run(thinStart(), 0, 120_000, { fed: 900, decoded: 898, heldMs: 300, all: 900 })
  assert.equal(s.budget, Infinity)
  assert.equal(fullRateTiles(wall(36), s.budget).size, 36)
})

test('one reading behind is a hiccup; two running cut to what was decoded less a fifth', () => {
  let s = nextBudget(thinStart(), { now: 0, ...BEHIND })
  assert.equal(s.budget, Infinity)
  assert.equal(nextBudget(s, { now: 2000, fed: 900, decoded: 900, heldMs: 100, all: 900 }).budget, Infinity) // it passed
  s = nextBudget(s, { now: 2000, ...BEHIND })
  assert.equal(s.budget, 576)
  assert.equal(fullRateTiles(wall(100), s.budget).size, 26) // 26 x 22 = 572 frames a second
})

test('after a cut the decoders are given time: no second cut while they settle, then two more readings', () => {
  let s = run(thinStart(), 0, 2000, BEHIND) // cut at 2000
  s = run(s, 4000, 6000, { fed: 572, decoded: 400, heldMs: 1500, all: 2200 })
  assert.equal(s.budget, 576) // (still settling)
  s = run(s, 8000, 10_000, { fed: 572, decoded: 400, heldMs: 1500, all: 2200 })
  assert.equal(s.budget, 320)
})

test('held too long counts as behind even when every frame comes back', () => {
  assert.equal(run(thinStart(), 0, 2000, { fed: 900, decoded: 900, heldMs: 1400, all: 900 }).budget, 720)
})

test('room again for 20 s: 15% more, and back to no limit once that covers the wall', () => {
  let s = { ...thinStart(), budget: 576, changedAt: 0 }
  s = run(s, 6000, 28_000, { fed: 570, decoded: 570, heldMs: 200, all: 800 })
  assert.equal(s.budget, 663)
  s = run(s, 30_000, 90_000, { fed: 650, decoded: 650, heldMs: 200, all: 800 })
  assert.equal(s.budget, Infinity)
})

test('a hiccup now and then does not ratchet the budget down, nor stop it rising', () => {
  let s = { ...thinStart(), budget: 576, changedAt: 0 }
  for (let t = 6000; t <= 60_000; t += 2000) {
    const hiccup = t % 14_000 === 0 // one reading in seven
    s = nextBudget(s, { now: t, fed: 570, decoded: hiccup ? 300 : 570, heldMs: 200, all: 2200 })
  }
  assert.ok(s.budget > 576, `budget ${s.budget}`)
})

test('at the device\'s limit: a raise that fails is remembered, not tried again every 40 s', () => {
  let s = { ...thinStart(), budget: 600, changedAt: 0 }
  const ok = { fed: 590, decoded: 590, heldMs: 200, all: 2200 }
  s = run(s, 6000, 28_000, ok) // raised to 690 at 26 s
  assert.equal(s.budget, 690)
  s = run(s, 34_000, 36_000, { fed: 690, decoded: 600, heldMs: 1200, all: 2200 }) // too much: cut, 690 remembered
  assert.equal(s.ceiling, 690)
  const cut = s.budget
  let raises = 0
  for (let t = 44_000; t <= 240_000; t += 2000) {
    const before = s.budget
    s = nextBudget(s, { now: t, fed: s.budget, decoded: s.budget, heldMs: 200, all: 2200 })
    if (s.budget > before) raises++
    assert.ok(s.budget < 690, `raised to ${s.budget} at ${t}`)
  }
  assert.ok(s.budget >= cut && raises <= 3, `budget ${s.budget}, ${raises} raises`)
})

test('never under a few tiles at full rate, however little was decoded', () => {
  assert.equal(run(thinStart(), 0, 2000, { fed: 2000, decoded: 10, heldMs: 5000, all: 2000 }).budget, 60)
})

test('nothing settled at full rate yet (a wall just opened): no judgement', () => {
  assert.equal(run(thinStart(), 0, 20_000, { fed: 0, decoded: 0, heldMs: 0, all: 2200 }).budget, Infinity)
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
  // nothing left once the cameras that are never thinned have taken their share: none, not all
  assert.equal(fullRateTiles(tiles, -50).size, 0)
})
