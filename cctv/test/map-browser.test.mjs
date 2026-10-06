import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchesMapSearch, mapIssue } from '../public/map-browser.js'

test('site and camera search match all terms without case sensitivity', () => {
  assert.equal(matchesMapSearch('marine BACK', 'Backgate Marine Safety'), true)
  assert.equal(matchesMapSearch('marine north', 'Backgate Marine Safety'), false)
  assert.equal(matchesMapSearch('  ', 'Main Office'), true)
  assert.equal(matchesMapSearch('office', null), false)
})
test('issues include alarms, offline and online cameras not recording', () => {
  for (const state of ['offline', 'alert', 'idle']) assert.equal(mapIssue(state), true)
  for (const state of ['recording', 'unknown', undefined]) assert.equal(mapIssue(state), false)
})
