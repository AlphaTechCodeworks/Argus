// Offline tests for the camera wall's pure logic (public/wall-clock.js): the shared clock, the
// conversion between server time and each NVR's own clock, the drift check that keeps the tiles in
// step, the grid layout, the honest load warning, what a tile says at a moment, the lanes and the
// saved camera choice. No DOM, so this runs anywhere:
//   node cctv/test/wall-clock.test.mjs
//
// The skew figures are the real ones from this site: nvr1 runs about 220 s fast. The point of most
// of these tests is that a tile is never asked for, and never reports, a raw time — everything
// crosses the boundary through cameraTime/serverTime, so two NVRs really do line up.
import {
  BUDGET,
  MAX_TILES,
  RESYNC_MS,
  WallClock,
  applyChoice,
  cameraTime,
  coverageAt,
  coversAt,
  gridLayout,
  laneRows,
  loadWarning,
  needsResync,
  MAX_OPEN_LAG_MS,
  OPEN_LAG_MS,
  aheadBy,
  aheadTooFar,
  openLead,
  normaliseChoice,
  serverTime,
  tileState,
  wallMode
} from '../public/wall-clock.js'
import { makeView } from '../public/pb-view.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const eq = (name, got, want) => check(name, Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)

// ---- the two clocks -------------------------------------------------------------------------

const SKEW = 220_000 // nvr1
const T = Date.UTC(2026, 8, 25, 14, 0, 0)

eq('a server moment as nvr1 reads it is 220 s later', cameraTime(T, SKEW), T + SKEW)
eq('and back again is the moment we started with', serverTime(cameraTime(T, SKEW), SKEW), T)
eq('a camera with no skew is left alone', cameraTime(T, 0), T)
eq('a slow clock goes the other way', cameraTime(T, -2000), T - 2000)
eq('a missing skew is treated as none', cameraTime(T, undefined), T)
eq('a time that is not a time stays out of the arithmetic', cameraTime(null, SKEW), null)

// Two cameras on NVRs whose clocks differ by nearly four minutes, asked for the same moment: each
// session is asked for its own clock's time, and both report back the same server moment.
{
  const askedA = cameraTime(T, SKEW) // nvr1, 220 s fast
  const askedB = cameraTime(T, -2000) // value4u, 2 s slow
  check('two NVRs are asked for different times', askedA - askedB === SKEW + 2000)
  eq('but both land on the same server moment', [serverTime(askedA, SKEW), serverTime(askedB, -2000)], [T, T])
}

// ---- drift ----------------------------------------------------------------------------------

check('a tile on the moment is left alone', needsResync(T, T) === false)
check('half a second out is within tolerance', needsResync(T + 500, T) === false)
check('three seconds out is put back', needsResync(T + 3000, T) === true)
check('three seconds behind is put back too', needsResync(T - 3000, T) === true)
check('a tile with no picture yet is left alone', needsResync(null, T) === false)
check('the tolerance can be widened', needsResync(T + 3000, T, { tolMs: 5000 }) === false)
check('the default tolerance is under two seconds', RESYNC_MS <= 2000)
// the tolerance is footage: at 4x and 8x the same real-time lag is 4 and 8 times as much of it
check('at 1x the tolerance is the plain one', needsResync(T + RESYNC_MS + 1, T, { speed: 1 }) === true && needsResync(T + RESYNC_MS, T, { speed: 1 }) === false)
// a stream is asked for where the clock will be, and a tile that comes up early waits for the clock
check('lead: an NVR stream not yet timed, at 1x and at 4x', openLead(null, 1, 'nvr') === OPEN_LAG_MS.nvr && openLead(null, 4, 'nvr') === 4 * OPEN_LAG_MS.nvr)
check('lead: the tile\'s own timing is used once there is one', openLead(1500, 4, 'nvr') === 6000 && openLead(500, 2, 'server') === 1000)
check('lead: the server\'s own recordings open sooner', openLead(null, 4, 'server') === 4 * OPEN_LAG_MS.server)
check('lead: backwards when the wall plays backwards', openLead(1000, -4, 'server') === -4000)
check('lead: a slow opening counts as MAX_OPEN_LAG_MS at most, and a silly speed is 1x', openLead(12_000, 4, 'nvr') === 4 * MAX_OPEN_LAG_MS && openLead(1000, 0, 'nvr') === 1000 && openLead(1000, NaN, 'nvr') === 1000)
check('ahead: by how much, in the direction played', aheadBy(T + 3000, T, 4) === 3000 && aheadBy(T - 3000, T, 4) === -3000 && aheadBy(T - 3000, T, -4) === 3000 && aheadBy(null, T, 1) === 0)
check('ahead: a tile that came up early is left to be caught up', aheadTooFar(T + 4 * MAX_OPEN_LAG_MS, T, { speed: 4 }) === false && aheadTooFar(T + 2000, T, { speed: 1 }) === false)
check('ahead: one further ahead than any lead can put it is asked for again', aheadTooFar(T + 4 * (MAX_OPEN_LAG_MS + RESYNC_MS) + 1, T, { speed: 4 }) === true && aheadTooFar(T + MAX_OPEN_LAG_MS + RESYNC_MS + 1, T, { speed: 1 }) === true)
check('ahead: a tile behind is never "too far ahead"', aheadTooFar(T - 60_000, T, { speed: 4 }) === false)
check('ahead: the furthest a lead can put a tile ahead is inside the allowance', aheadTooFar(T + openLead(12_000, 4, 'nvr'), T, { speed: 4 }) === false && aheadTooFar(T + openLead(12_000, 8, 'nvr'), T, { speed: 8 }) === false)
// the 4x loop measured on production: a stream took 2.6 s to its first picture, asked for at the clock
{
  const lagMs = 2600
  const behindWithout = lagMs * 4 // the clock moved on this far while it opened
  check('(asked for at the clock, a 4x tile came up over the tolerance behind)', needsResync(T - behindWithout, T, { speed: 4 }) === true)
  const first = T + openLead(lagMs, 4, 'nvr') - lagMs * 4 // asked ahead by the lead; the clock moved on meanwhile
  check('asked for with the lead, it comes up on the clock', needsResync(first, T, { speed: 4 }) === false && aheadTooFar(first, T, { speed: 4 }) === false)
  const early = T + openLead(lagMs, 4, 'nvr') - 800 * 4 // this time it opened in 0.8 s
  check('and one that opened sooner than expected is left alone, not seeked', aheadTooFar(early, T, { speed: 4 }) === false)
}
check('three seconds of footage out at 4x is left alone', needsResync(T - 3000, T, { speed: 4 }) === false)
check('... and past four times the tolerance it is put back', needsResync(T - (4 * RESYNC_MS + 1), T, { speed: 4 }) === true)
check('eight seconds out at 8x is left alone, thirteen is not', needsResync(T + 8000, T, { speed: 8 }) === false && needsResync(T + 13_000, T, { speed: 8 }) === true)
check('reverse counts by its size', needsResync(T + 3000, T, { speed: -4 }) === false && needsResync(T + 7000, T, { speed: -4 }) === true)
check('slower than 1x is never tighter than 1x', needsResync(T + 1000, T, { speed: 0.5 }) === false)
check('a speed that is no number is 1x', needsResync(T + 3000, T, { speed: NaN }) === true)
// The mistake this guards against: comparing an NVR position with the clock without taking the skew
// off would make a perfectly synchronised tile look 220 s adrift and be re-seeked for ever.
check('a raw NVR position looks adrift, a converted one does not', needsResync(cameraTime(T, SKEW), T) === true && needsResync(serverTime(cameraTime(T, SKEW), SKEW), T) === false)

// ---- the shared clock -----------------------------------------------------------------------

{
  let perf = 0
  const clock = new WallClock({ atMs: T, now: () => perf })
  eq('a paused clock does not move', (perf = 1000, clock.tick()), T)
  clock.play()
  perf = 3000
  eq('playing, it moves by the real time since', clock.tick(), T + 2000)
  clock.setSpeed(4)
  perf = 4000
  eq('at 4x it moves four times as fast', clock.tick(), T + 6000)
  clock.pause()
  perf = 9000
  eq('paused again it stops where it was', clock.tick(), T + 6000)
  clock.seek(T)
  perf = 20_000
  eq('a seek does not also collect the time waited', clock.tick(), T)
  clock.play()
  clock.setSpeed(-2)
  perf = 21_000
  eq('a negative speed runs the wall backwards', clock.tick(), T - 2000)
}

{
  // Changing speed banks the time already run: it must not be re-run at the new rate.
  let perf = 0
  const clock = new WallClock({ atMs: T, playing: true, now: () => perf })
  perf = 1000
  clock.setSpeed(8)
  perf = 2000
  eq('the second before the change stays at 1x', clock.tick(), T + 1000 + 8000)
}

// ---- what the wall can do -------------------------------------------------------------------

eq('all tiles from the server: the full ladder', wallMode([{ mode: 'server' }, { mode: 'server' }]), 'server')
eq('one tile from an NVR holds the whole wall back', wallMode([{ mode: 'server' }, { mode: 'nvr' }]), 'nvr')
eq('an empty wall is not assumed to be able to reverse', wallMode([]), 'server')

// ---- the grid -------------------------------------------------------------------------------

{
  const wide = gridLayout(3, { width: 1600, height: 400 })
  eq('three cameras on a wide short box go in one row', [wide.cols, wide.rows], [3, 1])
  const tall = gridLayout(3, { width: 400, height: 1200 })
  eq('the same three on a tall box go in one column', [tall.cols, tall.rows], [1, 3])
  const four = gridLayout(4, { width: 1600, height: 900 })
  eq('four on an ordinary screen make a square', [four.cols, four.rows], [2, 2])
  eq('nothing to show has no grid', gridLayout(0), { cols: 0, rows: 0, tileW: 0, tileH: 0 })
  const nine = gridLayout(9, { width: 1600, height: 900 })
  check('nine tiles all fit inside the box', nine.cols * nine.tileW <= 1601 && nine.rows * nine.tileH <= 901)
  check('tiles keep the camera shape', Math.abs(nine.tileW / nine.tileH - 16 / 9) < 1e-9)
}

// ---- the load warning -----------------------------------------------------------------------

eq('the sub-stream budget is nine', BUDGET.sd, 9)
eq('the main-stream budget is four', BUDGET.hd, 4)
check('nine sub-stream tiles are fine', loadWarning(9, 'sd').level === 'ok')
check('ten are called heavy', loadWarning(10, 'sd').level === 'heavy')
check('five HD tiles are already heavy', loadWarning(5, 'hd').level === 'heavy')
check('sixteen HD tiles are called what they are', loadWarning(16, 'hd').level === 'over')
check('the warning says the number asked for and the number that works', /16/.test(loadWarning(16, 'hd').text) && /4/.test(loadWarning(16, 'hd').text))
check('the HD warning offers sub-streams', /sub-stream/.test(loadWarning(16, 'hd').text))
check('an empty wall is not warned about', loadWarning(0).level === 'ok')

// ---- a tile at a moment ---------------------------------------------------------------------

{
  const stretches = [{ s: T, e: T + 600_000, src: 'server' }]
  check('inside a stretch the tile plays', tileState({ stretches, atMs: T + 1000 }).kind === 'playing')
  eq('in a hole it says so rather than showing black', tileState({ stretches, atMs: T + 900_000 }).kind, 'no-footage')
  check('the words are plain', /Nothing recorded/.test(tileState({ stretches, atMs: T + 900_000 }).text))
  eq('a camera the server has nothing for says that instead', tileState({ available: false, atMs: T }).kind, 'unavailable')
  // the server converts H.265 for a PC that cannot play it, so a known codec is no reason to refuse
  eq('H.265 on a PC without the codec is tried (the server converts it)', tileState({ codec: 'h265', h265: false, stretches, atMs: T + 1000 }).kind, 'playing')
  eq('only a real failure to play is named as the reason', tileState({ undecodable: true, stretches, atMs: T + 1000 }).kind, 'undecodable')
  check('and it says what to do about it', /H\.264/.test(tileState({ undecodable: true }).text))
  check('H.265 on a PC that can decode it plays', tileState({ codec: 'h265', h265: true, stretches, atMs: T + 1000 }).kind === 'playing')
  eq('an error beats everything else', tileState({ error: 'The NVR is busy', stretches, atMs: T + 1000 }).kind, 'error')
  check('the end of a stretch is not covered by it', coversAt(stretches, T + 600_000) === false)
  eq('coverage counts the cameras with footage', coverageAt([{ stretches }, { stretches: [] }, { stretches }], T + 1000), { with: 2, total: 3 })
}

// ---- the lanes ------------------------------------------------------------------------------

{
  const view = makeView({ dayStartMs: T, dayEndMs: T + 3_600_000, spanMs: 3_600_000 })
  const rows = laneRows(view, [
    { key: 'nvr1/0', name: 'Front Gate', stretches: [{ s: T, e: T + 1_800_000, src: 'server' }] },
    { key: 'nvr1/1', name: 'Yard', stretches: [] }
  ])
  eq('one lane per camera, named', rows.map((r) => r.name), ['Front Gate', 'Yard'])
  eq('the first lane covers the first half of the window', Math.round(rows[0].boxes[0].widthPct), 50)
  eq('a camera with nothing has an empty lane, not a missing one', rows[1].boxes.length, 0)

  // a whole day of a camera that drops a few seconds every half minute (nvr-2 on a bad day): its
  // holes meet on screen and are drawn as one box, the recording under them as another
  const day = makeView({ dayStartMs: T, dayEndMs: T + 86_400_000, spanMs: 86_400_000 })
  const stretches = []
  for (let t = T; t < T + 3_600_000; t += 30_000) stretches.push({ s: t, e: t + 27_000, src: 'server' }, { s: t + 27_000, e: t + 30_000, kind: 'gap', reason: 'no video from the NVR' })
  const [busy] = laneRows(day, [{ key: 'nvr-2/0', name: 'Busy', stretches }])
  eq('a busy hour on the wall: 120 holes are one gap box and the recording one box', busy.boxes.map((b) => `${b.kind}:${b.n}`), ['server:120', 'gap:120'])
  check('  the gap box starts where the first hole does (its reason is looked up there)', busy.boxes[1].from === T + 27_000 && busy.boxes[1].to === T + 3_600_000)
}

// ---- the saved choice -----------------------------------------------------------------------

eq('keys are kept in order, once each', normaliseChoice(['nvr1/0', 'nvr1/1', 'nvr1/0']), ['nvr1/0', 'nvr1/1'])
eq('rubbish is dropped', normaliseChoice(['nvr1/0', 'nope', 42, null, '../etc/passwd']), ['nvr1/0'])
eq('cameras that no longer exist are dropped', normaliseChoice(['nvr1/0', 'gone/3'], { known: new Set(['nvr1/0']) }), ['nvr1/0'])
eq('the wall is capped', normaliseChoice(Array.from({ length: 30 }, (_, i) => `nvr1/${i}`)).length, MAX_TILES)
eq('not a list at all is no cameras', normaliseChoice(null), [])

{
  const start = { cameras: ['nvr1/0'], version: 0 }
  const ok = applyChoice(start, { cameras: ['nvr1/0', 'nvr1/1'], version: 0 })
  eq('a change made on the version we hold is saved', [ok.saved, ok.cameras, ok.version], [true, ['nvr1/0', 'nvr1/1'], 1])
  const stale = applyChoice({ cameras: ['nvr1/0', 'nvr1/1'], version: 1 }, { cameras: ['nvr1/2'], version: 0 })
  eq('a change made on an older version is refused, with the latest', [stale.saved, stale.cameras, stale.version], [false, ['nvr1/0', 'nvr1/1'], 1])
}

console.log(failures === 0 ? '\nall passed' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
