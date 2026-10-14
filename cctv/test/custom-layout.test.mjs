// Tests a layout somebody draws for a saved view (public/custom-layout.js): what is accepted, how the
// tiles come out, and the editor's merge and split.
//   node cctv/test/custom-layout.test.mjs
import { CUSTOM_MAX_BIG, CUSTOM_MAX_SIZE, CUSTOM_MIN_SIZE, bigAt, cellsOfGrid, checkCustomGrid, mergeRect, resizeGrid, splitAt } from '../public/custom-layout.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---- checking ----
check('a plain grid with no big tiles is a layout', checkCustomGrid({ size: 3, big: [] }).ok && checkCustomGrid({ size: 3 }).ok)
check('  its size is 2 to 8 a side', CUSTOM_MIN_SIZE === 2 && CUSTOM_MAX_SIZE === 8 &&
  !checkCustomGrid({ size: 1 }).ok && !checkCustomGrid({ size: 9 }).ok && checkCustomGrid({ size: 8 }).ok && !checkCustomGrid({ size: 2.5 }).ok && !checkCustomGrid({ size: '4' }).ok)
check('  big tiles inside the grid are kept, as copies', (() => {
  const raw = { size: 4, big: [[1, 1, 2, 2]] }
  const { ok, value } = checkCustomGrid(raw)
  return ok && same(value, raw) && value.big[0] !== raw.big[0]
})())
check('  a tile reaching past the edge is refused', !checkCustomGrid({ size: 4, big: [[4, 1, 2, 1]] }).ok && !checkCustomGrid({ size: 4, big: [[1, 3, 1, 3]] }).ok)
check('  a tile at 0 or of no size is refused', !checkCustomGrid({ size: 4, big: [[0, 1, 2, 2]] }).ok && !checkCustomGrid({ size: 4, big: [[1, 1, 0, 2]] }).ok)
check('  a "big" tile of one square is refused', !checkCustomGrid({ size: 4, big: [[2, 2, 1, 1]] }).ok)
check('  overlapping tiles are refused', !checkCustomGrid({ size: 4, big: [[1, 1, 2, 2], [2, 2, 2, 2]] }).ok)
check('  side by side is fine', checkCustomGrid({ size: 4, big: [[1, 1, 2, 2], [3, 1, 2, 2]] }).ok)
check('  not a rectangle of four numbers: refused', !checkCustomGrid({ size: 4, big: [[1, 1, 2]] }).ok && !checkCustomGrid({ size: 4, big: [['1', 1, 2, 2]] }).ok && !checkCustomGrid({ size: 4, big: 'x' }).ok)
check('  more big tiles than allowed: refused', !checkCustomGrid({ size: 8, big: Array.from({ length: CUSTOM_MAX_BIG + 1 }, (_, i) => [1 + (i % 4) * 2, 1 + Math.floor(i / 4) * 2, 2, 1]) }).ok)
check('  rubbish in gives a refusal, not an error', [null, [], 'x', 3, undefined].every((r) => !checkCustomGrid(r).ok))

// ---- the tiles, as Live draws them ----
const onePlusFive = { size: 3, big: [[1, 1, 2, 2]] }
check('cellsOfGrid: the big tiles first, then single squares in reading order (as viewer.js layoutCells)',
  same(cellsOfGrid(onePlusFive), [[1, 1, 2, 2], [3, 1, 1, 1], [3, 2, 1, 1], [1, 3, 1, 1], [2, 3, 1, 1], [3, 3, 1, 1]]))
check('  a plain 2 x 2 is four tiles', cellsOfGrid({ size: 2, big: [] }).length === 4)
check('  every square is covered exactly once', (() => {
  const g = { size: 5, big: [[1, 1, 3, 2], [4, 3, 2, 3]] }
  const seen = new Map()
  for (const [c, r, w, h] of cellsOfGrid(g)) for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) seen.set(`${x},${y}`, (seen.get(`${x},${y}`) ?? 0) + 1)
  return seen.size === 25 && [...seen.values()].every((n) => n === 1)
})())

// ---- drawing: merge and split ----
const blank = { size: 4, big: [] }
const m1 = mergeRect(blank, [1, 1], [2, 2])
check('mergeRect: dragging across squares makes one big tile', !m1.error && same(m1.grid.big, [[1, 1, 2, 2]]))
check('  dragged either way round, the same tile', same(mergeRect(blank, [2, 2], [1, 1]).grid, m1.grid) && same(mergeRect(blank, [2, 1], [1, 2]).grid, m1.grid))
check('  a click on one square is no merge', same(mergeRect(blank, [3, 3], [3, 3]).grid, blank))
const m2 = mergeRect(m1.grid, [1, 1], [3, 3])
check('  a bigger drag around a big tile swallows it', !m2.error && same(m2.grid.big, [[1, 1, 3, 3]]))
const cut = mergeRect(m1.grid, [2, 2], [3, 3])
check('  one that cuts through a big tile is refused, with a reason, and nothing changes', Boolean(cut.error) && same(cut.grid, m1.grid))
check('  the input is never changed', same(blank, { size: 4, big: [] }))
check('bigAt: which big tile covers a square', bigAt(m1.grid, 2, 2) === 0 && bigAt(m1.grid, 3, 3) === -1)
check('splitAt: clicking a big tile splits it back into squares', same(splitAt(m1.grid, 2, 1), blank))
check('  clicking a plain square changes nothing', same(splitAt(m1.grid, 4, 4), m1.grid))
check('resizeGrid: tiles that still fit stay, the rest go', same(resizeGrid({ size: 4, big: [[1, 1, 2, 2], [3, 3, 2, 2]] }, 3), { size: 3, big: [[1, 1, 2, 2]] }))
check('  the size is kept in range', resizeGrid(blank, 99).size === CUSTOM_MAX_SIZE && resizeGrid(blank, 0).size === CUSTOM_MIN_SIZE)
check('everything the editor makes passes the check the server makes', [m1.grid, m2.grid, splitAt(m2.grid, 1, 1), resizeGrid(m2.grid, 2)].every((g) => checkCustomGrid(g).ok))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
