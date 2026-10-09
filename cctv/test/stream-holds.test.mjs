// Tests a main stream held on the server for the camera a viewer is expected to open next
// (stream-holds.mjs).   node --test cctv/test/stream-holds.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { HOLD_PATH, handleHold, makeHolds } from '../stream-holds.mjs'

/** A hub's streams, counted: how many quiet viewers each has, and timers run by hand. */
function world({ refuse = () => false } = {}) {
  const viewers = new Map() // cam -> Set of quiet viewers
  const timers = new Set()
  const streamOf = (nvr, ch) => {
    const cam = `${nvr}/${ch}`
    if (refuse(nvr, ch)) return null
    if (!viewers.has(cam)) viewers.set(cam, new Set())
    const set = viewers.get(cam)
    return { add: (v) => set.add(v), remove: (v) => set.delete(v) }
  }
  const later = (fn) => { const t = { fn }; timers.add(t); return t }
  const cancel = (t) => timers.delete(t)
  const expire = () => { for (const t of [...timers]) { timers.delete(t); t.fn() } }
  const running = () => [...viewers].filter(([, s]) => s.size > 0).map(([k]) => k).sort()
  return { streamOf, later, cancel, expire, running, viewers, timers }
}

test('a hold starts the stream with a quiet background viewer, and ends by itself', () => {
  const w = world()
  const h = makeHolds(w)
  assert.deepEqual(h.hold('v1', 'nvr1', 2), { held: true, ms: 20_000 })
  assert.deepEqual(w.running(), ['nvr1/2'])
  const [quiet] = w.viewers.get('nvr1/2')
  assert.equal(quiet.background, true, 'a real viewer\'s stream is started first')
  assert.doesNotThrow(() => quiet.send(Buffer.alloc(10)))
  w.expire()
  assert.deepEqual(w.running(), [])
  assert.deepEqual(h.state(), { cameras: [], viewers: 0 })
})

test('asked again for the same camera: the same stream, its time started over, not added twice', () => {
  const w = world()
  const h = makeHolds(w)
  h.hold('v1', 'nvr1', 2)
  h.hold('v1', 'nvr1', 2)
  h.hold('v1', 'nvr1', 2)
  assert.equal(w.viewers.get('nvr1/2').size, 1)
  assert.equal(w.timers.size, 1)
})

test('one per viewer: a new hold replaces the last', () => {
  const w = world()
  const h = makeHolds(w)
  h.hold('v1', 'nvr1', 2)
  h.hold('v1', 'nvr1', 3)
  assert.deepEqual(w.running(), ['nvr1/3'])
  assert.equal(w.timers.size, 1)
})

test('two viewers expecting one camera share its stream; it goes when the last lets go', () => {
  const w = world()
  const h = makeHolds(w)
  h.hold('v1', 'nvr1', 2)
  h.hold('v2', 'nvr1', 2)
  assert.equal(w.viewers.get('nvr1/2').size, 1)
  h.release('v1')
  assert.deepEqual(w.running(), ['nvr1/2'])
  h.release('v2')
  assert.deepEqual(w.running(), [])
  assert.doesNotThrow(() => h.release('nobody'))
})

test('bounded: so many on one NVR, so many in all; a refused hold starts nothing', () => {
  const w = world()
  const h = makeHolds({ ...w, perNvr: 2, max: 3 })
  assert.equal(h.hold('a', 'nvr1', 0).held, true)
  assert.equal(h.hold('b', 'nvr1', 1).held, true)
  assert.deepEqual(h.hold('c', 'nvr1', 2), { held: false, why: 'this NVR is holding as many as it may' })
  assert.equal(h.hold('c', 'nvr2', 0).held, true)
  assert.deepEqual(h.hold('d', 'nvr3', 0), { held: false, why: 'the server is holding as many as it may' })
  assert.deepEqual(w.running(), ['nvr1/0', 'nvr1/1', 'nvr2/0'])
  // a viewer already holding on that NVR may move to another of its cameras: theirs makes the room
  assert.equal(h.hold('a', 'nvr1', 5).held, true)
  assert.deepEqual(w.running(), ['nvr1/1', 'nvr1/5', 'nvr2/0'])
  // and a camera someone else holds can always be joined
  assert.equal(h.hold('d', 'nvr2', 0).held, true)
})

test('an NVR that is offline or refusing is not asked; a stream that throws is not held', () => {
  const w = world({ refuse: (nvr) => nvr === 'busy' })
  const h = makeHolds(w)
  assert.deepEqual(h.hold('v', 'busy', 1), { held: false, why: 'not now' })
  assert.deepEqual(h.state(), { cameras: [], viewers: 0 })
  const broken = makeHolds({ ...world(), streamOf: () => ({ add() { throw new Error('gone') }, remove() {} }) })
  assert.deepEqual(broken.hold('v', 'nvr1', 1), { held: false, why: 'not now' })
  assert.deepEqual(broken.state(), { cameras: [], viewers: 0 })
})

const req = (method, body, headers = {}) => {
  const r = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)])
  r.method = method
  r.headers = { host: 'cctv.local', origin: 'https://cctv.local', 'content-type': 'application/json', ...headers }
  return r
}

test('the route: signed in, this site, a real camera, and only one they may watch at full quality', async () => {
  const w = world()
  const holds = makeHolds(w)
  const ctx = { user: 'ann', viewer: 'v-ann', holds, mayHd: (nvr, ch) => nvr === 'nvr1' && ch < 4 }
  assert.equal(await handleHold(req('POST', {}), '/api/other', ctx), null)
  assert.equal((await handleHold(req('POST', { nvr: 'nvr1', ch: 1 }), HOLD_PATH, { ...ctx, user: null }))[0], 401)
  assert.equal((await handleHold(req('GET'), HOLD_PATH, ctx))[0], 405)
  assert.equal((await handleHold(req('POST', { nvr: 'nvr1', ch: 1 }, { 'content-type': 'text/plain' }), HOLD_PATH, ctx))[0], 415)
  assert.equal((await handleHold(req('POST', { nvr: 'nvr1', ch: 1 }, { origin: 'https://evil.example' }), HOLD_PATH, ctx))[0], 403)
  for (const bad of ['{', { nvr: '../x', ch: 1 }, { nvr: 'nvr1', ch: 999 }, { nvr: 'nvr1' }, 'x'.repeat(5000)]) assert.equal((await handleHold(req('POST', bad), HOLD_PATH, ctx))[0], 400)
  // not theirs: refused in the same words as one that cannot be held, and nothing is started
  assert.deepEqual((await handleHold(req('POST', { nvr: 'nvr1', ch: 9 }), HOLD_PATH, ctx))[1], { held: false, why: 'not now' })
  assert.deepEqual(w.running(), [])
  assert.deepEqual((await handleHold(req('POST', { nvr: 'nvr1', ch: 1 }), HOLD_PATH, ctx))[1], { held: true, ms: 20_000 })
  assert.deepEqual(w.running(), ['nvr1/1'])
})
