import test from 'node:test'
import assert from 'node:assert/strict'
import { followSuggestionsFor } from '../public/camera-follow.js'

test('current keyed suggestions and legacy lists both work', () => {
  assert.deepEqual(followSuggestionsFor({ 'a/0': [{ to: 'a/1' }] }, 'a/0'), [{ to: 'a/1' }])
  assert.deepEqual(followSuggestionsFor([{ from: 'a/0', to: 'a/1' }, { from: 'b/0', to: 'b/1' }], 'a/0'), [{ from: 'a/0', to: 'a/1' }])
})
test('missing and malformed suggestions are safe', () => {
  for (const input of [null, {}, { 'a/0': {} }, { 'a/0': [null, { to: 2 }] }]) {
    assert.deepEqual(followSuggestionsFor(input, 'a/0'), [])
  }
})
