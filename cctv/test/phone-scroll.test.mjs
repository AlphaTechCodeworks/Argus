// Exercise the live list's actual observer with deterministic timers and tile stand-ins.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../public/viewer.js', import.meta.url), 'utf8')
const start = source.indexOf('const ENTER_MS =')
const end = source.indexOf('\nfunction watchInView', start)
let callback
let observerOptions
let id = 0
let now = 0
const timers = new Map()
const gridTiles = []
const context = {
  document: { hidden: false },
  gridTiles, SUB_STREAM: 1, tileOptions: () => ({}),
  setTimeout(fn, ms) { timers.set(++id, { fn, due: now + ms }); return id },
  clearTimeout(key) { timers.delete(key) },
  IntersectionObserver: class {
    constructor(fn, options) { callback = fn; observerOptions = options }
  },
  LiveTile: class { close() { this.closed = true } }
}
runInNewContext(source.slice(start, end), context)
const advance = (ms) => {
  now += ms
  for (const [key, timer] of [...timers]) {
    if (timer.due <= now) { timers.delete(key); timer.fn() }
  }
}
const slot = { cam: {}, live: null }
const el = { isConnected: true, _slot: slot }
slot.el = el
const visible = (on) => callback([{ target: el, isIntersecting: on }])
assert.equal(observerOptions.rootMargin, '0px')
visible(true)
advance(100)
visible(false)
advance(500)
assert.equal(gridTiles.length, 0, 'flicking past a tile never starts a stream')
visible(true)
advance(180)
assert.equal(gridTiles.length, 1, 'settled visible camera starts')
const live = slot.live
visible(false)
advance(250)
visible(true)
advance(500)
assert.equal(slot.live, live, 'brief visibility loss preserves the stream')
visible(false)
advance(500)
assert.equal(live.closed, true)
assert.equal(gridTiles.length, 0, 'off-screen camera releases its decoder and stream')
visible(true)
el.isConnected = false
advance(180)
assert.equal(gridTiles.length, 0, 'removed tile cannot open a delayed stream')
console.log('PASS phone scrolling: dwell, cancellation, release and detached tiles')
