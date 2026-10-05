// The line maths of the Lines panel (public/lines-geom.js): the camera's 0..10000 coordinates, which
// side of a line is A, the direction arrow, the order a tap on it goes through, and what a press on
// the picture picks up. No DOM.
//   node cctv/test/lines-geom.test.mjs
import { DIRECTIONS, MIN_LINE_UNITS, UNITS, arrowFor, hitTest, isSet, lineLength, nextDirection, sideOf, slotForNewLine, toFrac, toUnits } from '../public/lines-geom.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const near = (a, b, tol = 1e-9) => Number.isFinite(a) && Math.abs(a - b) <= tol
const show = (x) => JSON.stringify(x)
const P = (x, y) => ({ x, y })
const L = (direction, sx, sy, ex, ey) => ({ direction, start: P(sx, sy), end: P(ex, ey) })

// ---- the camera's coordinates -------------------------------------------------------------------
check('toUnits: fractions to whole camera units, both edges included', toUnits(0) === 0 && toUnits(1) === 10000 && toUnits(0.5) === 5000 && toUnits(0.1234) === 1234, show([toUnits(0.1234)]))
check('  always a whole number (the camera takes integers only)', toUnits(1 / 3) === 3333 && toUnits(2 / 3) === 6667)
check('  a drag past the edge stops at it', toUnits(-0.2) === 0 && toUnits(1.3) === 10000)
check('  not a number: 0', toUnits(Number.NaN) === 0 && toUnits(undefined) === 0)
check('toFrac: back to a fraction of the picture', toFrac(2500) === 0.25 && toFrac(UNITS) === 1 && toFrac(0) === 0)
check('lineLength: straight distance', lineLength(P(0, 0), P(300, 400)) === 500)
check('MIN_LINE_UNITS is 5% of the picture (the server refuses shorter: tripwire-xml.mjs MIN_LINE_FRACTION)', MIN_LINE_UNITS === 0.05 * UNITS)
check('isSet: all four zero is an unset slot; a line from the corner is set', !isSet(L('rightortop', 0, 0, 0, 0)) && isSet(L('none', 0, 0, 600, 0)) && !isSet(null))

// ---- A and B: A is on the left of start -> end as seen on screen (Y down) ---------------------------
{
  const a = P(1000, 5000)
  const b = P(9000, 5000) // across the middle, drawn left to right
  check('drawn left to right: above the line is A, below it is B', sideOf(P(5000, 1000), a, b) === 'A' && sideOf(P(5000, 9000), a, b) === 'B')
  check('  the same line drawn right to left: the sides swap', sideOf(P(5000, 1000), b, a) === 'B' && sideOf(P(5000, 9000), b, a) === 'A')
  check('drawn top to bottom: A is the screen\'s right (the left of someone walking down it)', sideOf(P(9000, 5000), P(5000, 1000), P(5000, 9000)) === 'A' && sideOf(P(1000, 5000), P(5000, 1000), P(5000, 9000)) === 'B')
  check('a point on the line counts as A', sideOf(P(5000, 5000), a, b) === 'A')
  // camera units -> a 1920 x 1080 picture on screen: x and y are stretched by different amounts
  const toScreen = (p) => P(p.x * 0.192, p.y * 0.108)
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) % 10001
  let same = true
  for (let i = 0; i < 200; i++) {
    const [p, s, e] = [P(rnd(), rnd()), P(rnd(), rnd()), P(rnd(), rnd())]
    if (sideOf(p, s, e) !== sideOf(toScreen(p), toScreen(s), toScreen(e))) same = false
  }
  check('stretching the picture to the screen never moves a point to the other side (200 random cases)', same)
}

// ---- the arrow -------------------------------------------------------------------------------------
{
  const a = P(0, 0)
  const b = P(100, 0)
  const ab = arrowFor(L('rightortop', 0, 0, 100, 0))
  check('arrowFor: at the middle of the line', ab.mid.x === 50 && ab.mid.y === 0, show(ab))
  check('  A -> B (rightortop): from A (above) to B (below), one head', near(ab.dir.x, 0) && near(ab.dir.y, 1) && ab.both === false, show(ab))
  check('  toA points into side A (where the "A" label goes)', sideOf(P(ab.mid.x + ab.toA.x, ab.mid.y + ab.toA.y), a, b) === 'A' && near(ab.toA.y, -1))
  const ba = arrowFor(L('leftorbotton', 0, 0, 100, 0))
  check('  B -> A (leftorbotton): the other way', near(ba.dir.y, -1) && ba.both === false)
  const both = arrowFor(L('none', 0, 0, 100, 0))
  check('  both ways (none): the A -> B normal, with a head at each end', both.both === true && near(both.dir.y, 1))
  const d = arrowFor(L('rightortop', 0, 0, 300, 400))
  const tail = P(d.mid.x - d.dir.x * 20, d.mid.y - d.dir.y * 20)
  const head = P(d.mid.x + d.dir.x * 20, d.mid.y + d.dir.y * 20)
  check('  a unit vector at a right angle to the line', near(Math.hypot(d.dir.x, d.dir.y), 1) && near(d.dir.x * 300 + d.dir.y * 400, 0), show(d.dir))
  check('  it crosses from A to B: tail on A, head on B', sideOf(tail, P(0, 0), P(300, 400)) === 'A' && sideOf(head, P(0, 0), P(300, 400)) === 'B')
  const back = arrowFor(L('leftorbotton', 0, 0, 300, 400))
  const backHead = P(back.mid.x + back.dir.x * 20, back.mid.y + back.dir.y * 20)
  check('  B -> A: its head is on A', sideOf(backHead, P(0, 0), P(300, 400)) === 'A')
  check('  a line of no length has no arrow', arrowFor(L('none', 5, 5, 5, 5)) === null)
}

// ---- turning a line's direction ------------------------------------------------------------------------
check('DIRECTIONS in the order a tap goes through them', show(DIRECTIONS) === '["rightortop","leftorbotton","none"]')
check('nextDirection: A -> B, B -> A, both, and round again', nextDirection('rightortop') === 'leftorbotton' && nextDirection('leftorbotton') === 'none' && nextDirection('none') === 'rightortop')
check('  only the directions the camera lists (in any order it lists them)', nextDirection('rightortop', ['none', 'rightortop']) === 'none' && nextDirection('none', ['none', 'rightortop']) === 'rightortop' && nextDirection('rightortop', ['none', 'rightortop', 'leftorbotton']) === 'leftorbotton')
check('  one it does not know starts the cycle', nextDirection('sideways') === 'rightortop')
check('  a camera that lists none: unchanged', nextDirection('none', []) === 'none')

// ---- what a press picks up ----------------------------------------------------------------------------------
{
  const lines = [
    L('rightortop', 100, 100, 500, 100),
    L('none', 0, 0, 0, 0), // unset
    L('leftorbotton', 100, 300, 100, 700),
    L('rightortop', 0, 0, 0, 0) // unset
  ]
  check('hitTest: an end within reach', show(hitTest(P(104, 97), lines, 10)) === '{"slot":0,"end":"start"}')
  check('  the other end', show(hitTest(P(500, 108), lines, 10)) === '{"slot":0,"end":"end"}')
  check('  the middle is the arrow (a tap turns the direction)', show(hitTest(P(300, 105), lines, 10)) === '{"slot":0,"end":"arrow"}')
  check('  another slot\'s end', show(hitTest(P(100, 695), lines, 10)) === '{"slot":2,"end":"end"}')
  check('  on a line but away from its ends and middle: nothing (a press there draws a new line)', hitTest(P(200, 100), lines, 10) === null)
  check('  unset slots are never picked, even at 0,0', hitTest(P(0, 0), lines, 10) === null)
  const short = [L('rightortop', 1000, 1000, 1016, 1000)]
  check('  the nearest wins (the arrow of a short line)', show(hitTest(P(1007, 1000), short, 10)) === '{"slot":0,"end":"arrow"}')
  check('  ...or its end', show(hitTest(P(1002, 1000), short, 10)) === '{"slot":0,"end":"start"}')
  check('  at the same distance an end beats the arrow', show(hitTest(P(1004, 1000), short, 10)) === '{"slot":0,"end":"start"}')
  check('  a finger reaches further than a mouse', hitTest(P(118, 100), lines, 10) === null && show(hitTest(P(118, 100), lines, 22)) === '{"slot":0,"end":"start"}')

  check('slotForNewLine: the selected slot when it is empty', slotForNewLine(lines, 3) === 3)
  check('  else the first empty one', slotForNewLine(lines, 0) === 1 && slotForNewLine(lines, 2) === 1)
  check('  all four drawn: -1', slotForNewLine([lines[0], lines[0], lines[2], lines[2]], 0) === -1)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
