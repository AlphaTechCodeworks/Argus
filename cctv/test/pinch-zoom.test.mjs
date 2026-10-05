// Picture zoom gestures (public/pinch-zoom.js), with a stand-in element: the wheel and a pinch zoom
// about the pointer / the fingers, a drag pans within the picture, a double-click or double-tap goes
// back, and while zoomed a tap does nothing else (it used to close Live's full-size view).
//   node cctv/test/pinch-zoom.test.mjs
import { attachZoom } from '../public/pinch-zoom.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
globalThis.performance ??= { now: () => Date.now() }

function fakeEl() {
  const handlers = {}
  return {
    handlers,
    addEventListener(type, fn, opts) { (handlers[type] ??= []).push({ fn, capture: opts === true || opts?.capture === true }) },
    fire(type, ev) {
      const e = { type, target: { closest: () => null }, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true }, ...ev }
      for (const h of handlers[type] ?? []) h.fn(e)
      return e
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 })
  }
}
const el = fakeEl()
let last = { z: 1, x: 0, y: 0 }
let isBusy = false
const zoom = attachZoom(el, { apply: (z, x, y) => (last = { z, x, y }), busy: () => isBusy })

el.fire('wheel', { deltaY: -1, clientX: 200, clientY: 150 })
check('wheel up zooms in by 1.25', Math.abs(last.z - 1.25) < 1e-9 && zoom.zoom === last.z, JSON.stringify(last))
// the point under the pointer stays: picture point (200,150) maps to screen (200,150)
check('... about the pointer (what was under it stays under it)', Math.abs(200 * last.z + last.x - 200) < 1e-6 && Math.abs(150 * last.z + last.y - 150) < 1e-6, JSON.stringify(last))
for (let i = 0; i < 20; i++) el.fire('wheel', { deltaY: -1, clientX: 200, clientY: 150 })
check('never past the maximum (8x)', last.z === 8)
el.fire('dblclick', {})
check('double-click: back to the whole picture', last.z === 1 && last.x === 0 && last.y === 0)

// a pinch: two fingers 100 px apart moving to 200 px apart -> 2x about the middle
el.fire('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 150, clientY: 150 })
el.fire('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 250, clientY: 150 })
el.fire('pointermove', { pointerId: 1, clientX: 100, clientY: 150 })
el.fire('pointermove', { pointerId: 2, clientX: 300, clientY: 150 })
check('a pinch zooms by the change in finger spread', Math.abs(last.z - 2) < 1e-6, JSON.stringify(last))
el.fire('pointerup', { pointerId: 1, pointerType: 'touch' })
el.fire('pointerup', { pointerId: 2, pointerType: 'touch' })
const afterPinch = el.fire('click', {})
check('the click that ends a pinch does nothing else (the view stays open)', afterPinch.stopped === true)

// a one-finger drag pans, and never past the edge of the picture
el.fire('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 200, clientY: 150 })
el.fire('pointermove', { pointerId: 3, clientX: 5000, clientY: 5000 })
check('panning stops at the picture\'s top-left edge', last.x === 0 && last.y === 0, JSON.stringify(last))
el.fire('pointermove', { pointerId: 3, clientX: -5000, clientY: -5000 })
check('... and at its bottom-right edge', last.x === -400 && last.y === -300, JSON.stringify(last))
el.fire('pointerup', { pointerId: 3, pointerType: 'touch' })

// while zoomed, a plain tap on the picture does nothing else; a button still works
const tap = el.fire('click', {})
check('zoomed: a tap on the picture is not passed on', tap.stopped === true)
const onButton = el.fire('click', { target: { closest: () => ({}) } })
check('zoomed: a tap on a button or link is passed on', onButton.stopped !== true)

// a double-tap on a touch screen goes back
el.fire('pointerdown', { pointerId: 4, pointerType: 'touch', clientX: 10, clientY: 10 })
el.fire('pointerup', { pointerId: 4, pointerType: 'touch' })
el.fire('pointerdown', { pointerId: 5, pointerType: 'touch', clientX: 10, clientY: 10 })
el.fire('pointerup', { pointerId: 5, pointerType: 'touch' })
check('double-tap: back to the whole picture', last.z === 1)
const plain = el.fire('click', {})
check('not zoomed: a tap is passed on (the view closes as before)', plain.stopped !== true)

isBusy = true
el.fire('wheel', { deltaY: -1, clientX: 10, clientY: 10 })
check('busy (a search box over the picture): gestures are ignored', last.z === 1)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
