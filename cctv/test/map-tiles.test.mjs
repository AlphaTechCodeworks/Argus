import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tileTarget, createTileLoader, handleMapTile } from '../map-tiles.mjs'

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
test('tile coordinates and provider are strictly bounded', () => {
  assert.match(tileTarget('/api/map-tiles/street/2/1/3'), /World_Street_Map\/MapServer\/tile\/2\/3\/1$/)
  for (const path of ['/api/map-tiles/street/20/0/0', '/api/map-tiles/street/1/2/0', '/api/map-tiles/other/1/0/0', '/api/map-tiles/street/1/-1/0', '/api/map-tiles/street/1/0/0/../../']) assert.equal(tileTarget(path), null)
})
test('cache and concurrent deduplication avoid repeat upstream requests', async () => {
  let calls = 0
  const load = createTileLoader({ fetchTile: async () => { calls++; return new Response(png, { headers: { 'content-type': 'image/png' } }) } })
  const [a, b] = await Promise.all([load('/api/map-tiles/street/1/0/0'), load('/api/map-tiles/street/1/0/0')])
  assert.deepEqual(a.body, png)
  assert.equal(a, b)
  await load('/api/map-tiles/street/1/0/0')
  assert.equal(calls, 1)
})
test('rejects HTML, forged imagery, redirects and oversized bodies', async () => {
  for (const response of [new Response('html'), new Response('fake', { headers: { 'content-type': 'image/png' } }), new Response(png, { status: 302, headers: { 'content-type': 'image/png' } }), new Response(png, { headers: { 'content-type': 'image/png', 'content-length': '600000' } })]) {
    const load = createTileLoader({ fetchTile: async () => response })
    await assert.rejects(load('/api/map-tiles/street/1/0/0'))
  }
})
test('denies users without map access and methods other than GET', async () => {
  const res = { status: 0, writeHead(status) { this.status = status }, end() {} }
  await handleMapTile({ method: 'GET' }, res, '/api/map-tiles/street/1/0/0', false)
  assert.equal(res.status, 403)
  await handleMapTile({ method: 'POST' }, res, '/api/map-tiles/street/1/0/0', true)
  assert.equal(res.status, 405)
})

test('expired imagery refreshes and failed responses are not cached', async () => {
  let time = 0
  let calls = 0
  const load = createTileLoader({ now: () => time, fetchTile: async () => {
    calls++
    if (calls === 2) return new Response('unavailable', { status: 503 })
    return new Response(png, { headers: { 'content-type': 'image/png' } })
  } })
  await load('/api/map-tiles/street/1/0/0')
  time = 86_400_001
  await assert.rejects(load('/api/map-tiles/street/1/0/0'))
  await load('/api/map-tiles/street/1/0/0')
  assert.equal(calls, 3)
})

test('upstream requests are bounded to eight at a time', async () => {
  let active = 0
  let maximum = 0
  const load = createTileLoader({ fetchTile: async () => {
    active++
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setImmediate(resolve))
    active--
    return new Response(png, { headers: { 'content-type': 'image/png' } })
  } })
  await Promise.all(Array.from({ length: 20 }, (_, x) => load(`/api/map-tiles/street/5/${x}/0`)))
  assert.equal(maximum, 8)
})
