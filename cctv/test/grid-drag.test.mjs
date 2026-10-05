// Offline tests for dragging live-grid tiles (public/grid-drag.js): click vs drag (a click, under
// 6 px of movement, still opens the full-size view; the click after a drag does not), the drop
// target highlight, drops onto another tile or a pager arrow, Escape, and touch (press and hold
// 400 ms, then drag; a finger that moves sooner scrolls the page as before). Runs against a
// small fake DOM: pointer events are dispatched by hand.
//   node cctv/test/grid-drag.test.mjs
import { DRAG_THRESHOLD_PX, HOLD_MS, createGesture, enableGridDrag } from '../public/grid-drag.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

// ---- the gesture on its own ---------------------------------------------------------------------------
{
  check('6 px to start a drag, 400 ms hold on touch', DRAG_THRESHOLD_PX === 6 && HOLD_MS === 400)
  const g = createGesture()
  g.down(100, 100, false)
  check('mouse: pressed', g.phase === 'pressed')
  check('  moves under 6 px: still a click', g.move(103, 104) === 'none' && g.phase === 'pressed')
  check('  6 px: the drag starts', g.move(106, 100) === 'start' && g.phase === 'dragging')
  check('  then follows', g.move(150, 120) === 'drag')
  check('  release: a drop', g.up() === 'drop' && g.phase === 'idle')
  g.down(0, 0, false)
  check('mouse: press and release in place: a click', g.up() === 'click')
  g.down(0, 0, false)
  g.move(4, 0)
  check('mouse: a long press without moving is still a click (hold is for touch only)', g.hold() === false && g.up() === 'click')
  g.down(0, 0, true)
  check('touch: small wobble during the hold is allowed', g.move(6, 5) === 'none' && g.phase === 'pressed')
  check('touch: moving on before the hold: given up (the page scrolls)', g.move(0, 14) === 'cancel' && g.phase === 'idle')
  g.down(0, 0, true)
  check('touch: held 400 ms: armed', g.hold() === true && g.phase === 'armed')
  check('  then moving drags', g.move(2, 2) === 'none' && g.move(0, 8) === 'start' && g.up() === 'drop')
  g.down(0, 0, true)
  g.hold()
  check('touch: held, released without moving: nothing (no click, no drop)', g.up() === 'none')
  g.down(0, 0, true)
  check('touch: a quick tap is a click', g.up() === 'click')
  check('nothing pressed: moves and releases do nothing', g.move(50, 50) === 'none' && g.up() === 'none')
}

// ---- a fake DOM -------------------------------------------------------------------------------------------
class El {
  constructor(name, rect = null, parent = null) {
    this.name = name
    this.rect = rect
    this.parent = parent
    this.listeners = {}
    this.style = {}
    this.disabled = false
    const cls = new Set()
    this.classList = {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      contains: (c) => cls.has(c),
      toggle: (c, on) => (on ?? !cls.has(c) ? cls.add(c) : cls.delete(c))
    }
  }
  addEventListener(type, fn, opts) {
    ;(this.listeners[type] ??= []).push({ fn, capture: opts === true || Boolean(opts?.capture), passive: opts?.passive })
  }
  removeEventListener(type, fn, opts) {
    const capture = opts === true || Boolean(opts?.capture)
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => !(l.fn === fn && l.capture === capture))
  }
  contains(o) {
    for (let x = o; x; x = x.parent) if (x === this) return true
    return false
  }
  getBoundingClientRect() {
    const [left, top, width, height] = this.rect
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }
  }
  setPointerCapture(id) {
    this.captured = id
  }
  releasePointerCapture() {
    this.captured = null
  }
}

function setup() {
  const win = new El('window')
  let now = 0
  let timers = []
  win.setTimeout = (fn, ms) => {
    const t = { at: now + ms, fn }
    timers.push(t)
    return t
  }
  win.clearTimeout = (t) => (timers = timers.filter((x) => x !== t))
  const advance = (ms) => {
    now += ms
    for (const t of timers.filter((x) => x.at <= now)) {
      win.clearTimeout(t)
      t.fn()
    }
  }
  const body = new El('body', [0, -60, 400, 460])
  const grid = new El('grid', [0, 0, 400, 400], body)
  const tile = (name, x, y) => {
    const t = new El(name, [x, y, 200, 200], grid)
    t.canvas = new El(`${name}.canvas`, [x, y, 200, 200], t)
    t.clicks = 0
    t.addEventListener('click', () => t.clicks++)
    return t
  }
  const A = tile('A', 0, 0)
  const B = tile('B', 200, 0)
  const C = tile('C', 0, 200)
  const D = tile('D', 200, 200)
  const O = new El('overlay', [0, 0, 400, 400], grid) // the full-size view: not draggable
  const prev = new El('prev', [0, -40, 30, 30], body)
  const next = new El('next', [40, -40, 30, 30], body)
  const tiles = [A, B, C, D]
  const doc = {
    body,
    // like the browser: the dragged tile has pointer-events: none (see grid-order.css)
    elementFromPoint: (x, y) => {
      const inside = (e) => {
        const r = e.getBoundingClientRect()
        return x >= r.left && x < r.right && y >= r.top && y < r.bottom
      }
      const hit = [prev, next, ...tiles].find((e) => inside(e) && !e.classList.contains('dragging'))
      return hit ? (hit.canvas ?? hit) : inside(grid) ? grid : inside(body) ? body : null
    }
  }
  const drops = []
  let overlayOpen = false
  const ctl = enableGridDrag(grid, {
    tileOf: (el) => (overlayOpen ? null : tiles.find((t) => t.contains(el)) ?? null),
    targetOf: (el, dragged) => {
      if (el === prev || el === next) return el.disabled ? null : el
      const t = tiles.find((x) => x.contains(el))
      return t && t !== dragged ? t : null
    },
    onDrop: (dragged, target) => drops.push([dragged.name, target.name]),
    doc,
    win
  })
  /** Dispatches like the browser: capture down the path, then bubble up it, then window. */
  const fire = (target, type, props = {}) => {
    const path = []
    for (let x = target; x; x = x.parent) path.push(x)
    const ev = {
      type,
      target,
      button: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 0,
      clientY: 0,
      key: '',
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true
      },
      stopPropagation() {
        this.stopped = true
      },
      ...props
    }
    const run = (el, capture) => {
      for (const l of [...(el.listeners[type] ?? [])]) if (l.capture === capture || el === target) l.fn(ev)
    }
    for (const el of [...path].reverse()) {
      if (el !== target) run(el, true)
      if (ev.stopped) return ev
    }
    for (const el of path) {
      run(el, false)
      if (ev.stopped) return ev
    }
    if (type !== 'click' && type !== 'touchmove' && type !== 'contextmenu') run(win, false)
    return ev
  }
  const at = (x, y) => doc.elementFromPoint(x, y) ?? body
  const p = (x, y, extra = {}) => ({ clientX: x, clientY: y, ...extra })
  return {
    win, doc, grid, A, B, C, D, O, prev, next, drops, ctl, fire, at, p, advance,
    setOverlay: (on) => (overlayOpen = on),
    down: (x, y, extra) => fire(at(x, y), 'pointerdown', p(x, y, extra)),
    move: (x, y, extra) => fire(at(x, y), 'pointermove', p(x, y, extra)),
    up: (x, y, extra) => fire(at(x, y), 'pointerup', p(x, y, extra)),
    click: (x, y) => fire(at(x, y), 'click', p(x, y))
  }
}
const listening = (win) => ['pointermove', 'pointerup', 'pointercancel', 'keydown'].reduce((n, t) => n + (win.listeners[t]?.length ?? 0), 0)

// ---- mouse: a click still opens the full-size view -----------------------------------------------------------
{
  const t = setup()
  t.down(50, 50)
  t.move(53, 52)
  t.up(53, 52)
  t.click(53, 52)
  check('mouse click (3 px of movement): the tile\'s own click runs (full-size view opens)', t.A.clicks === 1 && t.drops.length === 0)
  check('  the tile was never lifted', !t.A.classList.contains('dragging') && !t.A.style.transform)
  check('  no window listeners left behind', listening(t.win) === 0)
  t.move(300, 300)
  check('moving with no button down does nothing', !t.A.classList.contains('dragging') && !t.D.classList.contains('drop-target'))
}

// ---- mouse: drag onto another tile ------------------------------------------------------------------------------------------
{
  const t = setup()
  t.down(50, 50)
  t.move(60, 50)
  check('10 px: the tile is lifted and follows the pointer', t.A.classList.contains('dragging') && /^translate\(10px, 0px\)/.test(t.A.style.transform ?? ''), t.A.style.transform)
  check('  the whole page shows a grabbing cursor', t.doc.body.classList.contains('grid-dragging'))
  t.move(250, 60)
  check('over another tile: it is highlighted as the drop target', t.B.classList.contains('drop-target') && !t.A.classList.contains('drop-target'))
  t.move(250, 260)
  check('  the highlight follows (one target at a time)', t.D.classList.contains('drop-target') && !t.B.classList.contains('drop-target'))
  t.up(250, 260)
  check('released over it: dropped onto that tile', t.drops.length === 1 && t.drops[0].join() === 'A,D')
  check('  tile put back (no transform, classes gone), no highlight left', !t.A.classList.contains('dragging') && !t.A.style.transform && !t.D.classList.contains('drop-target') && !t.doc.body.classList.contains('grid-dragging'))
  check('  no window listeners left behind', listening(t.win) === 0)
  const ev = t.fire(t.grid, 'click', t.p(250, 260))
  check('the click the browser sends after the drag is swallowed', ev.stopped && ev.defaultPrevented && t.A.clicks === 0 && t.D.clicks === 0)
  t.down(250, 260)
  t.up(250, 260)
  t.click(250, 260)
  check('  the next real click works again', t.D.clicks === 1)
}

// ---- mouse: drag back onto itself, outside, Escape --------------------------------------------------------------------------------
{
  const t = setup()
  t.down(50, 50)
  t.move(120, 50)
  t.move(55, 50)
  t.up(55, 50)
  t.click(55, 50)
  check('dragged and brought back onto itself: no drop, and no full-size view', t.drops.length === 0 && t.A.clicks === 0)
  t.down(50, 50)
  t.move(50, 150)
  t.move(390, -50)
  t.up(390, -50)
  check('released outside any tile or arrow: no drop', t.drops.length === 0 && !t.A.classList.contains('dragging'))
  t.down(50, 50)
  t.move(250, 50)
  const esc = t.fire(t.grid, 'keydown', { key: 'Escape' })
  check('Escape during a drag: the tile goes back', !t.A.classList.contains('dragging') && !t.B.classList.contains('drop-target') && esc.defaultPrevented)
  t.up(250, 50)
  t.click(250, 50)
  check('  and releasing afterwards drops nothing, opens nothing', t.drops.length === 0 && t.B.clicks === 0 && t.A.clicks === 0)
}

// ---- mouse: pager arrows ----------------------------------------------------------------------------------------------------------------
{
  const t = setup()
  t.down(50, 50)
  t.move(15, -25)
  check('over the "previous page" arrow: highlighted', t.prev.classList.contains('drop-target'))
  t.up(15, -25)
  check('  dropped onto it', t.drops.length === 1 && t.drops[0].join() === 'A,prev')
  t.next.disabled = true
  t.down(250, 50)
  t.move(55, -25)
  check('a disabled arrow (last page) is no target', !t.next.classList.contains('drop-target'))
  t.up(55, -25)
  check('  nothing dropped', t.drops.length === 1)
}

// ---- only grid tiles; left button only; one pointer at a time ------------------------------------------------------------------------------
{
  const t = setup()
  t.setOverlay(true)
  t.down(50, 50)
  t.move(250, 50)
  check('full-size view open: nothing can be dragged', !t.A.classList.contains('dragging') && listening(t.win) === 0)
  t.up(250, 50)
  t.setOverlay(false)
  t.down(50, 50, { button: 2 })
  t.move(250, 50)
  check('right button: no drag', !t.A.classList.contains('dragging'))
  t.up(250, 50, { button: 2 })
  t.down(50, 50)
  t.move(250, 50)
  t.down(260, 260, { pointerId: 2, isPrimary: false, pointerType: 'touch' })
  check('a second finger/pointer: the drag is called off', !t.A.classList.contains('dragging') && listening(t.win) === 0)
  t.up(250, 50)
  check('  and nothing dropped', t.drops.length === 0)
  t.down(50, 50)
  t.move(250, 50)
  t.fire(t.grid, 'pointercancel', t.p(250, 50))
  check('pointercancel: called off', !t.A.classList.contains('dragging') && listening(t.win) === 0 && t.drops.length === 0)
}

// ---- touch: press and hold, then drag ---------------------------------------------------------------------------------------------------------------
{
  const touch = { pointerType: 'touch' }
  const t = setup()
  t.down(50, 50, touch)
  t.advance(100)
  const tm0 = t.fire(t.grid, 'touchmove')
  check('touch, before the hold: touchmove not blocked (the page can scroll)', !tm0.defaultPrevented)
  t.move(50, 70, touch)
  t.advance(400)
  check('  the finger moved on before 400 ms: no drag, the tile is not armed later', !t.A.classList.contains('drag-armed') && !t.A.classList.contains('dragging') && listening(t.win) === 0)
  t.up(50, 70, touch)
  check('  nothing dropped', t.drops.length === 0)

  t.down(50, 50, touch)
  t.advance(399)
  check('touch: not armed at 399 ms', !t.A.classList.contains('drag-armed'))
  t.advance(1)
  check('  armed at 400 ms (shown)', t.A.classList.contains('drag-armed'))
  check('  touchmove is blocked now (no page scroll under the finger)', t.fire(t.grid, 'touchmove').defaultPrevented)
  check('  no long-press menu', t.fire(t.A.canvas, 'contextmenu').defaultPrevented)
  t.move(60, 60, touch)
  t.move(250, 250, touch)
  check('  then the drag follows the finger, target highlighted', t.A.classList.contains('dragging') && !t.A.classList.contains('drag-armed') && t.D.classList.contains('drop-target'))
  t.up(250, 250, touch)
  check('  released: dropped onto that tile', t.drops.length === 1 && t.drops[0].join() === 'A,D')
  check('  touchmove free again', !t.fire(t.grid, 'touchmove').defaultPrevented)

  t.down(250, 50, touch)
  t.advance(400)
  t.up(250, 50, touch)
  t.click(250, 50)
  check('touch: held and released without moving: no drop, no full-size view', t.drops.length === 1 && t.B.clicks === 0 && !t.B.classList.contains('drag-armed'))

  t.down(50, 250, touch)
  t.advance(150)
  t.up(50, 250, touch)
  t.advance(400)
  t.click(50, 250)
  check('touch: a quick tap opens the full-size view as before (and is not armed later)', t.C.clicks === 1 && !t.C.classList.contains('drag-armed'))
  check('a mouse right-click menu is left alone', !t.fire(t.A.canvas, 'contextmenu').defaultPrevented)
}

// ---- a drag can't get stuck: button released outside the window, capture lost, window blurred ---------------------------------------
{
  const t = setup()
  t.down(50, 50)
  t.move(250, 50)
  // Chrome sends no pointerup when the button is released over another app: the next move has buttons 0
  t.move(260, 60, { buttons: 0 })
  check('mouse moves with no button held: the stuck drag ends, no drop', !t.A.classList.contains('dragging') && t.drops.length === 0 && listening(t.win) === 0 && !t.ctl.dragging())
  t.down(250, 50)
  t.up(250, 50)
  t.click(250, 50)
  check('  the next click on a tile opens it (not a swap)', t.B.clicks === 1 && t.drops.length === 0)
  t.down(50, 50)
  t.move(250, 50, { buttons: 1 })
  check('  a move with the button held still drags', t.A.classList.contains('dragging'))
  t.fire(t.grid, 'lostpointercapture', { pointerId: 1 })
  check('lostpointercapture while dragging: the drag ends, tile put back, no drop', !t.A.classList.contains('dragging') && t.A.style.transform === '' && t.drops.length === 0 && listening(t.win) === 0)
  t.down(50, 50)
  t.move(250, 50)
  t.fire(t.win, 'blur')
  check('window blur while dragging: the drag ends, no drop', !t.A.classList.contains('dragging') && t.drops.length === 0 && listening(t.win) === 0 && !(t.win.listeners.blur ?? []).length)
  t.down(50, 50)
  t.move(250, 50)
  // a pointerdown with the same pointer while a drag is (wrongly) still on: end it, start afresh
  t.down(250, 250)
  check('pointerdown with the same pointer mid-drag: the old drag ends', !t.A.classList.contains('dragging') && t.A.style.transform === '')
  t.up(250, 250)
  t.click(250, 250)
  check('  ... and the new press is a normal click (opens that tile)', t.D.clicks === 1 && t.drops.length === 0)
}

{
  const { readFileSync } = await import('node:fs')
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')
  check('narrow screens: the header controls wrap (pager arrows stay visible)', /@media \(max-width: 700px\)[^{]*\{ \.controls \{ flex-wrap: wrap; \} \}/.test(css))
}

// ---- stop -------------------------------------------------------------------------------------------------------------------------------------------------
{
  const t = setup()
  t.down(50, 50)
  t.move(250, 50)
  t.ctl.cancel()
  check('cancel(): a drag in progress stops, tile put back', !t.A.classList.contains('dragging') && !t.B.classList.contains('drop-target') && listening(t.win) === 0)
  check('dragging() tells whether a drag is on', t.ctl.dragging() === false && (t.down(50, 50), t.move(250, 50), t.ctl.dragging() === true))
  t.up(250, 50)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
