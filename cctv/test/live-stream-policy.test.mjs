import test from 'node:test'
import assert from 'node:assert/strict'
import { gridStreamType } from '../public/live-stream-policy.js'

test('single-window grids select Main automatically', () => {
  assert.equal(gridStreamType({ cells: 1 }), 0)
  assert.equal(gridStreamType({ cells: 1, remote: true }), 0)
})

test('multi-window grids retain Sub', () => {
  for (const cells of [4, 9, 16, 64]) assert.equal(gridStreamType({ cells }), 1)
})

test('single-window grids respect HD, codec and remote limits', () => {
  assert.equal(gridStreamType({ cells: 1, hd: false }), 1)
  assert.equal(gridStreamType({ cells: 1, unsupportedMain: true }), 1)
  assert.equal(gridStreamType({ cells: 1, remote: true, remotePage: true }), 1)
  assert.equal(gridStreamType({ cells: 1, remote: false, remotePage: true }), 0)
})
