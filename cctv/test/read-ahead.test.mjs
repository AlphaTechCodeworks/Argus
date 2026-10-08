import assert from 'node:assert/strict'
import { createReadAhead } from '../read-ahead.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
// Baseline guard from rec-playback.mjs: concurrent callers return immediately.
let baselineBusy = false, baselineCompleted = 0
async function baseline(path) {
  if (!path || baselineBusy) return
  baselineBusy = true
  try { await tick(); baselineCompleted++ } finally { baselineBusy = false }
}
for (let i = 0; i < 16; i++) void baseline(`camera-${i}`)
await tick()
assert.equal(baselineCompleted, 1)
let busy = 0, peak = 0, opened = [], closed = 0
let release
const gate = new Promise(resolve => { release = resolve })
let fail = true
const fs = { async open(path) {
  opened.push(path)
  busy++; peak = Math.max(peak, busy)
  if (path === 'retry' && fail) { busy--; throw Error('temporary storage failure') }
  return { async read() { await gate; return { bytesRead: 0 } }, async close() { busy--; closed++ } }
} }
const ahead = createReadAhead({ fs, maxPending: 32 })
for (let i = 0; i < 16; i++) { ahead(`camera-${i}`); ahead(`camera-${i}`) }
release()
for (let i = 0; i < 20; i++) await tick()
assert.equal(opened.length, 16)
assert.equal(closed, 16)
assert.equal(peak, 1)
ahead('retry'); await tick(); fail = false; ahead('retry'); await tick()
assert.equal(opened.filter(p => p === 'retry').length, 2)
assert.equal(busy, 0)
console.log(JSON.stringify({ scenario:'16 simultaneous viewer prefetch requests (mock storage)',beforeCompleted:baselineCompleted,afterCompleted:closed-1,peakConcurrentReads:peak,duplicateReads:0,failedReadRetryPassed:true }))
