import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MIN_SECONDS, PROFILE_KEY, layoutNote, noteSecond, readProfile, saveProfile, statusOf } from '../public/wall-profile.js'

const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m } }
const nav = { userAgent: 'Chrome/141' }
const watch = (p, tiles, share, seconds, o) => { for (let i = 0; i < seconds; i++) p = noteSecond(p, tiles, share, o); return p }

test('the owner\'s tolerances: 20% dropped is fine, over 30% is not', () => {
  assert.deepEqual([1, 0.8, 0.79, 0.7, 0.69, 0].map((s) => statusOf(s)), ['ok', 'ok', 'warn', 'warn', 'bad', 'bad'])
  assert.equal(statusOf(0.85, { okShare: 0.9, poorShare: 0.5 }), 'warn') // (an administrator's own)
})

test('nothing is said about a layout until it has been watched for half a minute', () => {
  let p = readProfile(store(), nav)
  p = watch(p, 36, 0.72, MIN_SECONDS - 1)
  assert.equal(layoutNote(p, 36), null)
  p = noteSecond(p, 36, 0.72)
  assert.deepEqual([layoutNote(p, 36).status, layoutNote(p, 36).pct, layoutNote(p, 36).short], ['warn', 72, '72% shown'])
  assert.equal(layoutNote(p, 100), null) // (never watched)
})

test('the figure follows what is seen lately, not one bad second', () => {
  let p = watch(readProfile(store(), nav), 16, 0.98, 120)
  p = noteSecond(p, 16, 0.1)
  assert.equal(layoutNote(p, 16).status, 'ok')
  p = watch(p, 16, 0.5, 120)
  assert.equal(layoutNote(p, 16).status, 'bad')
  assert.match(layoutNote(p, 16).long, /^Performance is below recommended levels/)
})

test('a layout that had to be thinned is never called fine, for a week', () => {
  const t = Date.parse('2026-10-09T18:00:00Z')
  const p = watch(readProfile(store(), nav), 100, 0.97, 60, { now: t, thinned: true })
  assert.deepEqual([layoutNote(p, 100, { now: t }).status, layoutNote(p, 100, { now: t }).short], ['warn', 'part at full rate'])
  assert.equal(layoutNote(p, 100, { now: t + 8 * 86_400_000 }).status, 'ok')
})

test('kept in the browser, and started again on another browser version or when unreadable', () => {
  const s = store()
  saveProfile(s, watch(readProfile(s, nav), 36, 0.9, 40))
  assert.equal(layoutNote(readProfile(s, nav), 36).pct, 90)
  assert.equal(layoutNote(readProfile(s, { userAgent: 'Chrome/142' }), 36), null)
  s.setItem(PROFILE_KEY, '{not json')
  assert.deepEqual(readProfile(s, nav).layouts, {})
  assert.doesNotThrow(() => saveProfile({ setItem() { throw new Error('blocked') } }, readProfile(s, nav)))
  assert.deepEqual(readProfile(null, nav).layouts, {})
})

test('bad readings are passed over, and the profile does not grow without end', () => {
  let p = readProfile(store(), nav)
  assert.equal(noteSecond(p, 0, 0.5), p)
  assert.equal(noteSecond(p, 9, NaN), p)
  for (let n = 1; n <= 60; n++) p = noteSecond(p, n, 0.9, { now: n })
  assert.equal(Object.keys(p.layouts).length, 40)
  assert.equal(p.layouts[1], undefined) // (the one seen longest ago went first)
})
