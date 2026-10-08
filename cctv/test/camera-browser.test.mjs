import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserResults } from '../public/camera-browser.js'

const cameras = [
  { site: 'North yard', name: 'Gate', nvrName: 'Recorder A', nvr: 'a', ch: 0, online: true },
  { site: 'North yard', name: 'Warehouse', nvrName: 'Recorder A', nvr: 'a', ch: 1, online: false },
  { site: 'South yard', name: 'Gate', nvrName: 'Recorder B', nvr: 'b', ch: 0, online: true }
]
test('site browser counts cameras and ranks favorites before recent sites', () => {
  assert.deepEqual(browserResults(cameras, { favorites: ['South yard'], recents: ['North yard'] }), [
    { name: 'South yard', count: 1 }, { name: 'North yard', count: 2 }
  ])
  assert.deepEqual(browserResults(cameras, { query: 'north yard' }), [{ name: 'North yard', count: 2 }])
})
test('camera search combines site scope with recorder and name words, retaining offline cameras', () => {
  assert.deepEqual(browserResults(cameras, { mode: 'cameras', site: 'North yard', query: 'warehouse recorder' }), [cameras[1]])
  assert.deepEqual(browserResults(cameras, { mode: 'cameras', site: 'South yard', query: 'warehouse' }), [])
  assert.equal(browserResults(cameras, { mode: 'cameras', query: 'gate' }).length, 2)
})
test('preferences do not add sites outside the supplied roster', () => {
  assert.equal(browserResults(cameras, { favorites: ['Private site'], recents: ['Removed site'] }).length, 2)
})
