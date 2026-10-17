// A layout somebody drew for themselves: a square grid of 2 to 8 cells a side, with some cells merged
// into bigger tiles. It is the shape the Live page already draws its own featured layouts with
// (viewer.js LAYOUTS: '1+5' is { size: 3, big: [[1, 1, 2, 2]] }), so a drawn layout needs nothing new
// to show it: each big tile is [column, row, width, height], 1-based, and every cell no big tile covers
// is a tile of its own, in reading order.
//
// No DOM and nothing from node: grid-view.js checks a saved view's drawn layout with checkCustomGrid,
// on the page and on the server alike, and the editor (view-editor.js) changes one with mergeRect and
// splitAt. Tested offline: test/custom-layout.test.mjs.

/** The smallest and largest grid that may be drawn. 8 x 8 is 64 tiles: more than enough for a screen. */
export const CUSTOM_MIN_SIZE = 2
export const CUSTOM_MAX_SIZE = 8
/** The most merged tiles one layout may have (a guard against a client sending thousands). */
export const CUSTOM_MAX_BIG = 16

const isInt = (n) => Number.isSafeInteger(n)

/** Whether two rectangles [c, r, w, h] share any cell. */
export function overlaps([c1, r1, w1, h1], [c2, r2, w2, h2]) {
  return c1 < c2 + w2 && c2 < c1 + w1 && r1 < r2 + h2 && r2 < r1 + h1
}

/**
 * A drawn layout checked and copied: the size in range, every big tile a whole rectangle inside the
 * grid, more than one cell, and no two sharing a cell. Anything else is refused, never repaired: a
 * layout that was saved wrong should be drawn again, not opened as something its owner did not draw.
 * @returns {{ ok: boolean, error: string|null, value: { size: number, big: number[][] }|null }}
 */
export function checkCustomGrid(raw) {
  const bad = (error) => ({ ok: false, error, value: null })
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad('A drawn layout must be an object')
  const { size } = raw
  if (!isInt(size) || size < CUSTOM_MIN_SIZE || size > CUSTOM_MAX_SIZE) return bad(`A drawn layout is ${CUSTOM_MIN_SIZE} to ${CUSTOM_MAX_SIZE} squares a side`)
  const list = raw.big ?? []
  if (!Array.isArray(list)) return bad('A drawn layout\'s big tiles must be a list')
  if (list.length > CUSTOM_MAX_BIG) return bad(`A drawn layout has at most ${CUSTOM_MAX_BIG} big tiles`)
  const big = []
  for (const rect of list) {
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(isInt)) return bad('A big tile must be [column, row, width, height]')
    const [c, r, w, h] = rect
    if (c < 1 || r < 1 || w < 1 || h < 1 || c + w - 1 > size || r + h - 1 > size) return bad('A big tile must lie inside the grid')
    if (w * h < 2) return bad('A big tile covers more than one square')
    if (big.some((o) => overlaps(o, rect))) return bad('Two big tiles may not overlap')
    big.push([c, r, w, h])
  }
  return { ok: true, error: null, value: { size, big } }
}

/** Every tile of a drawn layout as [column, row, width, height]: the big ones first, then the single
 *  cells in reading order, exactly as viewer.js layoutCells lays out its own featured layouts. */
export function cellsOfGrid({ size, big = [] }) {
  const cells = big.map((b) => [...b])
  for (let y = 1; y <= size; y++) {
    for (let x = 1; x <= size; x++) if (!big.some((b) => overlaps(b, [x, y, 1, 1]))) cells.push([x, y, 1, 1])
  }
  return cells
}

/** The big tile covering a cell, or -1. */
export function bigAt({ big = [] }, col, row) {
  return big.findIndex((b) => overlaps(b, [col, row, 1, 1]))
}

/**
 * The layout with the cells from (c1, r1) to (c2, r2), corners either way round, merged into one tile.
 * Big tiles wholly inside the new one are absorbed into it; one that sticks out of it cannot be, and
 * the merge is refused with a reason the editor can say. A single cell is no merge at all.
 * @returns {{ grid: { size: number, big: number[][] }, error: string|null }}
 */
export function mergeRect(grid, [c1, r1], [c2, r2]) {
  const rect = [Math.min(c1, c2), Math.min(r1, r2), Math.abs(c2 - c1) + 1, Math.abs(r2 - r1) + 1]
  const same = { grid, error: null }
  if (rect[2] * rect[3] < 2) return same
  const inside = (b) => b[0] >= rect[0] && b[1] >= rect[1] && b[0] + b[2] <= rect[0] + rect[2] && b[1] + b[3] <= rect[1] + rect[3]
  const kept = []
  for (const b of grid.big ?? []) {
    if (inside(b)) continue
    if (overlaps(b, rect)) return { grid, error: 'That would cut through a big tile. Split it first, or drag around all of it.' }
    kept.push(b)
  }
  const next = { size: grid.size, big: [...kept, rect] }
  const { ok, error } = checkCustomGrid(next)
  return ok ? { grid: next, error: null } : { grid, error }
}

/** The layout with the big tile covering (col, row) split back into single squares. */
export function splitAt(grid, col, row) {
  const i = bigAt(grid, col, row)
  if (i < 0) return grid
  return { size: grid.size, big: grid.big.filter((_, j) => j !== i) }
}

/** The same drawing on a grid of another size: big tiles that no longer fit are dropped. */
export function resizeGrid(grid, size) {
  const s = Math.min(CUSTOM_MAX_SIZE, Math.max(CUSTOM_MIN_SIZE, Math.floor(Number(size) || CUSTOM_MIN_SIZE)))
  return { size: s, big: (grid?.big ?? []).filter(([c, r, w, h]) => c + w - 1 <= s && r + h - 1 <= s) }
}
