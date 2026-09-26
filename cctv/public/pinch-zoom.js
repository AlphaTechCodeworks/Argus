// Zooming into a picture, the same way on Live's full-size view and in Playback: the mouse wheel and a
// two-finger pinch zoom about the pointer / between the fingers, dragging moves the picture once it is
// zoomed, and a double-click or a double-tap goes back to the whole picture. It only transforms what is
// already on screen: no extra video is fetched and no detail is invented, so zooming past what the
// camera sends shows bigger pixels. Phones had no picture zoom at all (the wheel only), and Live none.
//
// The caller paints (apply): this keeps the state and reads the gestures. While zoomed, a tap or a
// drag must not also do what it does on a whole picture (close the full-size view, change camera):
// the click that ends a drag is swallowed, as is a tap on the picture itself while zoomed; buttons and
// links inside keep working.

const DOUBLE_TAP_MS = 300
const MOVE_PX = 6 // a pointer that moved this far was a drag, not a tap

/**
 * @param {HTMLElement} el the element the gestures happen on
 * @param {{ apply: (z: number, x: number, y: number) => void, rect?: () => DOMRect, max?: number,
 *   busy?: () => boolean }} o apply(z, x, y): scale z, and the scaled picture's offset in pixels
 *   (top-left origin); rect: the box the picture fills; busy: gestures are ignored (e.g. a search box
 *   drawn over the picture needs raw pointer coordinates)
 * @returns {{ reset: () => void, readonly zoom: number, reapply: () => void }}
 */
export function attachZoom(el, { apply, rect = () => el.getBoundingClientRect(), max = 8, busy = () => false }) {
  const st = { z: 1, x: 0, y: 0 }
  const pointers = new Map() // pointerId -> { x, y }
  let pinch = null // { d0, z0 }
  let drag = null // { x, y, ox, oy }
  let moved = false
  let lastTap = 0

  /** Keeps the picture covering its box: never panned to an empty edge. */
  const clamp = () => {
    const { width: w, height: h } = rect()
    st.x = Math.min(0, Math.max(-(st.z - 1) * w, st.x))
    st.y = Math.min(0, Math.max(-(st.z - 1) * h, st.y))
  }
  const commit = () => {
    if (st.z <= 1.001) {
      st.z = 1
      st.x = 0
      st.y = 0
    }
    clamp()
    apply(st.z, st.x, st.y)
  }
  /** Zooms to z about a point on screen, so what is under it stays under it. */
  const zoomTo = (z, cx, cy) => {
    const r = rect()
    const next = Math.min(max, Math.max(1, z))
    const px = (cx - r.left - st.x) / st.z
    const py = (cy - r.top - st.y) / st.z
    st.z = next
    st.x = cx - r.left - px * next
    st.y = cy - r.top - py * next
    commit()
  }
  const reset = () => {
    st.z = 1
    st.x = 0
    st.y = 0
    apply(1, 0, 0)
  }

  el.addEventListener('wheel', (e) => {
    if (busy()) return
    e.preventDefault()
    zoomTo(st.z * (e.deltaY > 0 ? 1 / 1.25 : 1.25), e.clientX, e.clientY)
  }, { passive: false })

  el.addEventListener('pointerdown', (e) => {
    if (busy() || e.target.closest?.('button, a, input, select, textarea')) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    moved = false
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: st.z }
      drag = null
    } else if (pointers.size === 1 && st.z > 1) {
      drag = { x: e.clientX, y: e.clientY, ox: st.x, oy: st.y }
    }
  })
  el.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId)
    if (!p) return
    p.x = e.clientX
    p.y = e.clientY
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()]
      moved = true
      zoomTo(pinch.z0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0), (a.x + b.x) / 2, (a.y + b.y) / 2)
    } else if (drag) {
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      if (Math.abs(dx) + Math.abs(dy) > MOVE_PX) moved = true
      st.x = drag.ox + dx
      st.y = drag.oy + dy
      commit()
    }
  })
  const up = (e) => {
    if (!pointers.has(e.pointerId)) return
    pointers.delete(e.pointerId)
    if (pointers.size < 2) pinch = null
    if (pointers.size === 0) drag = null
    // a double-tap on a touch screen: back to the whole picture (a double-click does it on a PC)
    if (e.type === 'pointerup' && e.pointerType === 'touch' && !moved && st.z > 1) {
      const now = performance.now()
      if (now - lastTap < DOUBLE_TAP_MS) {
        lastTap = 0
        reset()
      } else lastTap = now
    }
  }
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  el.addEventListener('dblclick', (e) => {
    if (busy() || st.z === 1 || e.target.closest?.('button, a, input, select, textarea')) return
    e.preventDefault()
    e.stopPropagation()
    reset()
  })
  // the click that ends a drag or a pinch, and a tap on a zoomed picture, do nothing else
  el.addEventListener('click', (e) => {
    if (e.target.closest?.('button, a, input, select, textarea')) return
    if (moved || st.z > 1) {
      e.stopPropagation()
      e.preventDefault()
    }
    moved = false
  }, true)

  return {
    reset,
    /** Paints the current zoom again (the box changed size: the pan limits did too). */
    reapply: commit,
    get zoom() {
      return st.z
    }
  }
}
