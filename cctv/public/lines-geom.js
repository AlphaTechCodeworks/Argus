// The maths of drawing line-crossing lines on a camera's picture (lines-panel.js): the camera's own
// coordinates, which side of a line is A and which is B, the arrow that shows which way a crossing
// counts, and what a press on the picture picks up. Pure (no DOM), so the node tests
// (test/lines-geom.test.mjs) run it exactly as the browser does.
//
// Coordinates are the camera's: whole numbers 0..10000 across the picture's width and down its
// height, origin top-left, Y down (queryTripwire/editTripwire, tripwire-xml.mjs). A slot whose four
// numbers are all 0 has no line. The picture is not square, so what needs true angles or distances
// on screen (the arrow, what a finger can reach) is worked out in screen pixels: sideOf, arrowFor,
// lineLength and hitTest take points in any one space, and the panel gives them screen pixels where
// the shape matters.
//
// Directions, in the firmware's spelling ("botton" is theirs): 'rightortop' counts crossings from A
// to B, 'leftorbotton' from B to A, 'none' both ways. A is the side on the LEFT of the line as drawn,
// start -> end, on screen (the NVR's web client labels it so; the first test walk confirms it on the
// real camera).

export const UNITS = 10000
/** The order a tap on a line's arrow goes through: A -> B, B -> A, both ways. */
export const DIRECTIONS = ['rightortop', 'leftorbotton', 'none']
/**
 * The shortest line the server accepts: tripwire-xml.mjs MIN_LINE_FRACTION (5%) of UNITS, measured
 * the same way (straight distance in camera units). Checked here as well, so a stray tap is dropped
 * at once instead of being refused on Save.
 */
export const MIN_LINE_UNITS = 500

/** A fraction of the picture (held to 0..1: a drag past the edge stops at it) as a whole camera unit. */
export function toUnits(frac) {
  const f = Number(frac)
  if (!Number.isFinite(f)) return 0
  return Math.round(Math.min(1, Math.max(0, f)) * UNITS)
}

/** A camera coordinate as a fraction of the picture. */
export const toFrac = (units) => Number(units) / UNITS

/** Straight distance between two points, in whatever units they are given in. */
export const lineLength = (a, b) => Math.hypot(b.x - a.x, b.y - a.y)

/** A slot with a line in it (an unset slot has all four coordinates 0). */
export const isSet = (line) => Boolean(line) && !(line.start.x === 0 && line.start.y === 0 && line.end.x === 0 && line.end.y === 0)

/**
 * Which side of the line a -> b the point p is on: 'A' on its left as seen on screen (Y down), 'B'
 * on its right; a point exactly on the line counts as A. Any one coordinate space will do:
 * stretching the picture wider or taller never moves a point to the other side.
 */
export function sideOf(p, a, b) {
  // with Y down, the left of (dx, dy) is (dy, -dx): for a line drawn to the right it points up
  const dx = b.x - a.x
  const dy = b.y - a.y
  return (p.x - a.x) * dy - (p.y - a.y) * dx >= 0 ? 'A' : 'B'
}

/**
 * Where a line's direction arrow goes: across the line at its middle. dir is the unit normal the
 * arrow points along: A -> B for 'rightortop', B -> A for 'leftorbotton', and for 'none' the A -> B
 * one with both: true (a head at each end). toA is the unit normal into side A (where the "A" label
 * goes). Give screen pixels for a true right angle. null for a line of no length.
 */
export function arrowFor(line) {
  const a = line.start
  const b = line.end
  const len = lineLength(a, b)
  if (!(len > 0)) return null
  const toA = { x: (b.y - a.y) / len, y: -(b.x - a.x) / len }
  const toB = { x: -toA.x, y: -toA.y }
  return {
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    dir: line.direction === 'leftorbotton' ? toA : toB,
    both: line.direction === 'none',
    toA
  }
}

/**
 * The direction a tap on the arrow turns a line to: A -> B, then B -> A, then both, then round again.
 * allowed: the camera's own list (queryTripwire <types><direction>); one it does not know starts the
 * cycle.
 */
export function nextDirection(d, allowed = DIRECTIONS) {
  const order = DIRECTIONS.filter((x) => allowed.includes(x))
  if (!order.length) return d
  return order[(order.indexOf(d) + 1) % order.length]
}

/**
 * What a press at `point` picks up among `lines` (the slots in order; unset ones are skipped): an end
 * of a line to drag ('start' | 'end'), or the arrow at its middle to turn its direction ('arrow').
 * The nearest within `radius` wins; at the same distance an end beats the arrow, and a lower slot a
 * higher one. null: nothing there (a press on empty picture draws a new line). point, lines and
 * radius in one space (the panel uses screen pixels, so a finger reaches as far across as down).
 */
export function hitTest(point, lines, radius) {
  let best = null
  lines.forEach((l, slot) => {
    if (!isSet(l)) return
    const mid = { x: (l.start.x + l.end.x) / 2, y: (l.start.y + l.end.y) / 2 }
    for (const [end, q] of [['start', l.start], ['end', l.end], ['arrow', mid]]) {
      const d = lineLength(point, q)
      if (d <= radius && (!best || d < best.d)) best = { slot, end, d }
    }
  })
  return best && { slot: best.slot, end: best.end }
}

/** Where a newly drawn line goes: the selected slot when it is empty, else the first empty one; -1 when all are drawn. */
export function slotForNewLine(lines, selected = 0) {
  if (lines[selected] && !isSet(lines[selected])) return selected
  return lines.findIndex((l) => !isSet(l))
}
