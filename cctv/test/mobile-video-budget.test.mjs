import assert from 'node:assert/strict'
import { createVideoBudget } from '../public/video-budget.js'
globalThis.window = { devicePixelRatio: 1 }
const renders = []
globalThis.requestAnimationFrame = fn => { renders.push(fn); return renders.length }
globalThis.ResizeObserver = class { observe() {} disconnect() {} }
globalThis.EncodedVideoChunk = class { constructor(o) { Object.assign(this, o) } }
const made = []
class Frame {
  constructor(timestamp) { this.timestamp = timestamp; this.displayWidth = this.codedWidth = 640;
    this.displayHeight = this.codedHeight = 360; this.closed = false; made.push(this) }
  clone() { return new Frame(this.timestamp) }
  close() { this.closed = true }
}
let probe = null
globalThis.VideoDecoder = class {
  static async isConfigSupported() { if (probe) await probe; return { supported: true } }
  constructor({ output }) { this.output = output; this.state = 'unconfigured'; this.decodeQueueSize = 0 }
  configure() { this.state = 'configured' }
  decode(chunk) { this.output(new Frame(chunk.timestamp)) }
  close() { this.state = 'closed' }
}
const { VideoPlayer, clearDecoderConfigCache } = await import('../public/player.js')
const turn = () => new Promise(resolve => setImmediate(resolve))
const chunk = (timestamp = 0, isKey = true) => ({ timestampUs: timestamp, isKey, codecId: 0, data: new Uint8Array([1,2,3]) })
const canvas = (fail = false) => ({ width: 640, height: 360,
  getContext: () => ({ drawImage() { if (fail) throw new Error('lost canvas') } }),
  getBoundingClientRect: () => ({ width: 640, height: 360 }) })
const budget = createVideoBudget({ decoders: 2, imageBytes: 640 * 360 * 4 * 4 })
let refusals = 0
const players = Array.from({ length: 3 }, () => new VideoPlayer(canvas(), { resources: budget, onResourceLimit: () => refusals++ }))
for (const p of players) p.push(chunk())
await turn()
assert.equal(budget.active, 2)
assert.equal(refusals, 1)
for (let i = 1; i <= 20; i++) for (const p of players.slice(0,2)) p.push(chunk(i * 66667, false))
assert.ok(players.reduce((n,p) => n + p.queue.length, 0) <= 4, 'shared decoded surfaces stay bounded')
players[0].reset()
assert.equal(budget.active, 1)
players[2].push(chunk(2000000))
await turn()
assert.equal(budget.active, 2, 'released admission becomes reusable')
players.forEach(p => p.close())
assert.equal(budget.active, 0)
assert.ok(made.every(f => f.closed))

clearDecoderConfigCache()
let finish
probe = new Promise(resolve => { finish = resolve })
const cancelled = new VideoPlayer(canvas(), { resources: budget })
cancelled.push(chunk())
cancelled.reset()
finish(); await turn()
assert.equal(cancelled.decoder, null, 'reset during capability probe cannot recreate decoder')
assert.equal(budget.active, 0)
cancelled.close(); probe = null
clearDecoderConfigCache()
probe = new Promise(resolve => { finish = resolve })
const replacement = new VideoPlayer(canvas(), { resources: budget })
replacement.push(chunk())
replacement.reset()
replacement.push(chunk(5000000))
finish(); await turn()
assert.equal(replacement.queue.length, 1, 'a new keyframe survives cancellation of the old configuration')
assert.equal(replacement.queue[0].ts, 5000)
replacement.close(); probe = null
let errors = 0
const failing = new VideoPlayer(canvas(true), { resources: budget, paintFirst: true, onError: () => errors++ })
failing.push(chunk()); await turn()
assert.equal(errors, 1)
assert.ok(made.every(f => f.closed), 'presentation failure closes original and poster clone')
failing.close()
console.log('PASS shared decoder/image budget, reuse, cancelled configuration and draw failure ownership')
