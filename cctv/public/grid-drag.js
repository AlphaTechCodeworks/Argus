// Dragging live-grid tiles to rearrange the cameras (viewer.js decides what a drop does).
// One code path for mouse, pen and touch (pointer events):
//   - mouse/pen: the drag starts once the pointer has moved 6 px with the button down; less than
//     that is a click, which opens the full-size view exactly as before;
//   - touch: press and hold 400 ms, then drag; a finger that moves on sooner scrolls the page as
//     it always did, and a quick tap is a click.
// The tile itself follows the pointer (a CSS transform: its video keeps playing), the tile or
// pager arrow under it is highlighted, and the click the browser sends after a drag is swallowed.
// Tested offline with a fake DOM: test/grid-drag.test.mjs.

export const DRAG_THRESHOLD_PX = 6
export const HOLD_MS = 400
/** A finger may wobble this much while holding still for the 400 ms. */
export const TOUCH_SLOP_PX = 10
/** A big tile is shrunk while dragged, so it doesn't hide where it goes. */
const MAX_LIFTED_WIDTH_PX = 280

/**
 * Click vs drag for one pointer, without the DOM.
 * down(x, y, touch); move(x, y) -> 'none' | 'start' | 'drag' | 'cancel' (touch moved before the
 * hold: not ours, the page scrolls); hold() -> true when a touch press becomes draggable;
 * up() -> 'click' (let the browser's click through) | 'drop' | 'none' (swallow the click).
 */
export function createGesture({ threshold = DRAG_THRESHOLD_PX, touchSlop = TOUCH_SLOP_PX } = {}) {
  let s = null // { x0, y0, touch, phase: 'pressed' | 'armed' | 'dragging' }
  return {
    get phase() {
      return s?.phase ?? 'idle'
    },
    down(x, y, touch) {
      s = { x0: x, y0: y, touch: Boolean(touch), phase: 'pressed' }
    },
    move(x, y) {
      if (!s) return 'none'
      if (s.phase === 'dragging') return 'drag'
      const d = Math.hypot(x - s.x0, y - s.y0)
      if (s.phase === 'pressed' && s.touch) {
        if (d < touchSlop) return 'none'
        s = null
        return 'cancel'
      }
      if (d < threshold) return 'none'
      s.phase = 'dragging'
      return 'start'
    },
    hold() {
      if (s?.phase !== 'pressed' || !s.touch) return false
      s.phase = 'armed'
      return true
    },
    up() {
      const phase = s?.phase ?? 'idle'
      s = null
      return phase === 'dragging' ? 'drop' : phase === 'pressed' ? 'click' : 'none'
    },
    cancel() {
      s = null
    }
  }
}

/**
 * Lets the user drag the grid's tiles.
 * @param {HTMLElement} grid
 * @param {{ tileOf: (el: Element) => HTMLElement | null, targetOf: (el: Element, dragged: HTMLElement) => HTMLElement | null,
 *   onDrop: (dragged: HTMLElement, target: HTMLElement) => void, doc?: Document, win?: Window }} opts
 *   tileOf: the draggable tile an event target is in (null: not draggable, e.g. the full-size view);
 *   targetOf: what a drop at that element would land on (another tile, an enabled pager arrow) or null
 * @returns {{ cancel: () => void, dragging: () => boolean }}
 */
export function enableGridDrag(grid, { tileOf, targetOf, onDrop, doc = document, win = window }) {
  const gesture = createGesture()
  let active = null // { id, tile, x0, y0, scale, target, timer }
  let swallowClick = false // the click that follows a drag (or a touch hold) is not a click on a tile

  const onDown = (e) => {
    swallowClick = false
    if (active) {
      // a second finger or pointer: a pinch or a mistake, not a drag
      if (e.pointerId !== active.id) return end(true)
      // the same pointer pressed again: its release was never seen (e.g. over another window);
      // the old gesture is over, this press starts afresh
      end(false)
      swallowClick = false
    }
    if (e.button !== 0 || e.isPrimary === false) return
    const tile = tileOf(e.target)
    if (!tile) return
    const touch = e.pointerType === 'touch'
    active = { id: e.pointerId, tile, x0: e.clientX, y0: e.clientY, scale: 1, target: null, timer: null }
    gesture.down(e.clientX, e.clientY, touch)
    if (touch) active.timer = win.setTimeout(onHold, HOLD_MS)
    win.addEventListener('pointermove', onMove)
    win.addEventListener('pointerup', onUp)
    win.addEventListener('pointercancel', onCancel)
    win.addEventListener('keydown', onKey)
    win.addEventListener('blur', onLost)
  }

  // the window lost focus (Alt+Tab, a notification) or the grid lost the pointer capture: no
  // pointerup will come, so the drag must not stay stuck to the pointer
  const onLost = (e) => {
    if (!active) return
    if (e?.type === 'lostpointercapture' && e.pointerId !== undefined && e.pointerId !== active.id) return
    const was = gesture.phase
    gesture.cancel()
    end(was !== 'pressed')
  }

  const onHold = () => {
    if (active && gesture.hold()) active.tile.classList.add('drag-armed')
  }

  const onMove = (e) => {
    if (!active || e.pointerId !== active.id) return
    // a mouse or pen with no button held: the release happened where we could not see it
    if (e.pointerType !== 'touch' && e.buttons === 0) return onLost(e)
    const r = gesture.move(e.clientX, e.clientY)
    if (r === 'cancel') return end(false)
    if (r === 'start') lift()
    if (r === 'start' || r === 'drag') {
      follow(e.clientX, e.clientY)
      e.preventDefault?.()
    }
  }

  const lift = () => {
    const { tile } = active
    win.clearTimeout(active.timer)
    const rect = tile.getBoundingClientRect()
    active.scale = Math.min(1, MAX_LIFTED_WIDTH_PX / Math.max(1, rect.width))
    // shrink around the point held, so it stays under the pointer
    tile.style.transformOrigin = `${active.x0 - rect.left}px ${active.y0 - rect.top}px`
    tile.classList.remove('drag-armed')
    tile.classList.add('dragging')
    doc.body?.classList.add('grid-dragging')
    try {
      // keeps the pointer's events coming even outside the window
      grid.setPointerCapture?.(active.id)
    } catch {}
  }

  const follow = (x, y) => {
    const { tile } = active
    tile.style.transform = `translate(${x - active.x0}px, ${y - active.y0}px) scale(${active.scale})`
    const under = doc.elementFromPoint(x, y)
    const target = under ? targetOf(under, tile) : null
    if (target === active.target) return
    active.target?.classList.remove('drop-target')
    target?.classList.add('drop-target')
    active.target = target
  }

  const onUp = (e) => {
    if (!active || e.pointerId !== active.id) return
    const r = gesture.up()
    const { tile, target } = active
    end(r !== 'click')
    if (r === 'drop' && target) onDrop(tile, target)
  }

  const onCancel = (e) => {
    if (!active || e.pointerId !== active.id) return
    const was = gesture.phase
    gesture.cancel()
    end(was !== 'pressed')
  }

  const onKey = (e) => {
    if (e.key !== 'Escape' || !active) return
    e.preventDefault?.()
    gesture.cancel()
    end(true)
  }

  /** Back to rest: the tile in its place, no highlight, no listeners. */
  const end = (swallow) => {
    const a = active
    active = null
    if (!a) return
    gesture.cancel()
    win.clearTimeout(a.timer)
    win.removeEventListener('pointermove', onMove)
    win.removeEventListener('pointerup', onUp)
    win.removeEventListener('pointercancel', onCancel)
    win.removeEventListener('keydown', onKey)
    win.removeEventListener('blur', onLost)
    a.tile.classList.remove('dragging', 'drag-armed')
    a.tile.style.transform = ''
    a.tile.style.transformOrigin = ''
    a.target?.classList.remove('drop-target')
    doc.body?.classList.remove('grid-dragging')
    try {
      grid.releasePointerCapture?.(a.id)
    } catch {}
    if (swallow) swallowClick = true
  }

  grid.addEventListener('pointerdown', onDown)
  grid.addEventListener('lostpointercapture', onLost)
  // capture: runs before the tile's own click (which opens the full-size view)
  grid.addEventListener(
    'click',
    (e) => {
      if (!swallowClick) return
      swallowClick = false
      e.stopPropagation()
      e.preventDefault()
    },
    true
  )
  // once a touch is held (or dragging), the finger drags the tile instead of scrolling the page
  grid.addEventListener(
    'touchmove',
    (e) => {
      if (active && (gesture.phase === 'armed' || gesture.phase === 'dragging')) e.preventDefault()
    },
    { passive: false }
  )
  // no long-press menu under a held finger
  grid.addEventListener('contextmenu', (e) => {
    if (active) e.preventDefault()
  })

  return {
    cancel: () => end(false),
    dragging: () => gesture.phase === 'dragging'
  }
}
