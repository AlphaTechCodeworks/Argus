// Offline tests for the multi-camera playback page's pure logic (public/grid-view.js): the camera
// search, the fixed grids and paging, saved views and their versioning, which lanes to draw, the
// clips a whole view exports, and the rules that pace stream opening and back off after a refusal.
// No DOM and no node APIs beyond the runner, so this runs anywhere:
//   node cctv/test/grid-view.test.mjs
//
// The opening and backoff tests are the ones that matter most on a real site: they are what stands
// between a 3x3 grid and an NVR that stops recording because its bandwidth budget is spent.
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  MAX_EXPORT_CLIPS,
  MAX_VIEWS,
  MAX_VIEW_CAMERAS,
  MAX_VIEW_NAME,
  OPEN_STAGGER_MS,
  afterRefusal,
  afterVideo,
  applyViews,
  autoLiveGrid,
  backoffMs,
  checkView,
  colsOf,
  exportClipsFor,
  groupCameras,
  laneSet,
  layoutFor,
  mayOpen,
  normaliseViews,
  openNote,
  openPlan,
  pageOf,
  searchCameras,
  slotsOf
} from '../public/grid-view.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

check('auto live: six cameras fill three columns and two rows', JSON.stringify(autoLiveGrid(6)) === '{"size":3,"rows":2}')
check('auto live: one camera fills the screen', JSON.stringify(autoLiveGrid(1)) === '{"size":1,"rows":1}')
check('auto live: an empty roster still has a valid grid', JSON.stringify(autoLiveGrid(0)) === '{"size":1,"rows":1}')
check('auto live: a browser without H.265 stays within the automatic decoder budget', JSON.stringify(autoLiveGrid(90, { noH265: true })) === '{"size":3,"rows":3}')
check('auto live: a phone never opens more than four', JSON.stringify(autoLiveGrid(90, { phone: true })) === '{"size":2,"rows":2}')
check('auto live: large rosters keep the previous nine-camera default and use paging', JSON.stringify(autoLiveGrid(200)) === '{"size":3,"rows":3}')
check('auto live: a wide viewport favors three columns for six cameras', JSON.stringify(autoLiveGrid(6, { width: 1600, height: 650 })) === '{"size":3,"rows":2}')
check('auto live: a tall viewport favors two columns for six cameras', JSON.stringify(autoLiveGrid(6, { width: 650, height: 1000 })) === '{"size":2,"rows":3}')
check('auto live: viewport fitting respects the conversion cap', (() => { const g = autoLiveGrid(200, { width: 1800, height: 700, noH265: true }); return g.size * g.rows <= 16 })())
check('auto live: portrait cameras use six tall cells instead of six wide cells', JSON.stringify(autoLiveGrid(6, { width: 1600, height: 900, pictureAspect: 9 / 16 })) === '{"size":6,"rows":1}')
check('auto live: invalid camera proportions use the normal default', JSON.stringify(autoLiveGrid(6, { width: 1600, height: 900, pictureAspect: NaN })) === JSON.stringify(autoLiveGrid(6, { width: 1600, height: 900 })))

const cams = [
  { nvr: 'nvr-1', ch: 0, name: 'Front gate', nvrName: 'Office NVR', site: 'Depot' },
  { nvr: 'nvr-1', ch: 2, name: 'Yard west', nvrName: 'Office NVR', site: 'Depot' },
  { nvr: 'nvr-2', ch: 17, name: 'Loading bay', nvrName: 'Yard NVR', site: 'Depot' },
  { nvr: 'nvr-2', ch: 31, name: 'Back gate', nvrName: 'Yard NVR', site: 'Farm' }
]
const names = (list) => list.map((c) => c.name).join(', ')

// ---- searching the camera list ----------------------------------------------------------------
{
  check('search: no query gives every camera, in the order given', names(searchCameras(cams, '')) === names(cams))
  check('  a word matches the camera name, whatever the case', names(searchCameras(cams, 'GATE')) === 'Front gate, Back gate')
  check('  it matches the NVR name too', names(searchCameras(cams, 'office')) === 'Front gate, Yard west')
  check('  and the site', names(searchCameras(cams, 'farm')) === 'Back gate')
  check('  every word must match, in any order', names(searchCameras(cams, 'gate front')) === 'Front gate')
  check('  a word matching nothing gives nothing', searchCameras(cams, 'gate zebra').length === 0)
  check('  channels are found by the number people see (1-based), not only the stored one',
    names(searchCameras(cams, '18')) === 'Loading bay' && names(searchCameras(cams, '17')) === 'Loading bay')
  check('  a list that is missing or full of rubbish gives nothing rather than an error',
    searchCameras(null, 'gate').length === 0 && searchCameras([null, undefined], 'gate').length === 0)

  const groups = groupCameras(cams)
  check('grouping: one group per site and NVR, in the order they appear',
    groups.map((g) => g.label).join(' | ') === 'Depot · Office NVR | Depot · Yard NVR | Farm · Yard NVR', groups.map((g) => g.label).join(' | '))
  check('  every camera lands in exactly one group', groups.reduce((n, g) => n + g.cameras.length, 0) === cams.length)
}

// ---- the grid ----------------------------------------------------------------------------------
{
  check('slots: 2x2 shows four, 3x3 shows nine, auto shows everything', slotsOf('2x2') === 4 && slotsOf('3x3') === 9 && slotsOf('auto') === 0)
  check('columns: fixed for the fixed grids', colsOf('2x2', 3) === 2 && colsOf('3x3', 5) === 3)
  check('  auto spreads the count over roughly square columns', colsOf('auto', 4) === 2 && colsOf('auto', 9) === 3 && colsOf('auto', 5) === 3)
  check('  auto never asks for no columns at all', colsOf('auto', 0) >= 1)

  const twelve = Array.from({ length: 12 }, (_, i) => `nvr-1/${i}`)
  const p0 = pageOf(twelve, '2x2', 0)
  check('paging: a 2x2 of twelve cameras streams four, not twelve', p0.keys.length === 4 && p0.pages === 3)
  check('  the second page is the next four', pageOf(twelve, '2x2', 1).keys.join() === 'nvr-1/4,nvr-1/5,nvr-1/6,nvr-1/7')
  check('  a page past the end is clamped rather than left blank', pageOf(twelve, '2x2', 99).page === 2 && pageOf(twelve, '2x2', 99).keys.length === 4)
  check('  a negative or rubbish page reads as the first', pageOf(twelve, '2x2', -3).page === 0 && pageOf(twelve, '2x2', NaN).page === 0)
  check('  a last page that is not full holds what is left', pageOf(twelve.slice(0, 10), '3x3', 1).keys.length === 1)
  check('  auto puts everything on one page', pageOf(twelve, 'auto').keys.length === 12 && pageOf(twelve, 'auto').pages === 1)
  check('  no cameras still gives one (empty) page', pageOf([], '2x2').pages === 1 && pageOf([], '2x2').keys.length === 0)
  check('layoutFor: a few cameras want 2x2, more want 3x3', layoutFor(1) === '2x2' && layoutFor(4) === '2x2' && layoutFor(5) === '3x3')

  // bigger grids: the NxN name carries its own size, so slots and columns are read off it
  check('slots: bigger grids read NxN off the name', slotsOf('4x4') === 16 && slotsOf('8x8') === 64 && slotsOf('12x12') === 144)
  check('columns: bigger grids are N wide', colsOf('5x5', 99) === 5 && colsOf('12x12', 1) === 12 && colsOf('10x10', 0) === 10)
  check('paging: a 4x4 of twelve cameras is one page (16 slots)', pageOf(twelve, '4x4').pages === 1 && pageOf(twelve, '4x4').keys.length === 12)
  check('layoutFor: large counts pick a large grid', layoutFor(16) === '4x4' && layoutFor(64) === '8x8' && layoutFor(100) === '10x10' && layoutFor(144) === '12x12' && layoutFor(999) === '12x12')
  check('a 12x12 view may hold up to 144 cameras', checkView({ id: 'big', name: 'Everything', cameras: Array.from({ length: 144 }, (_, i) => `nvr-1/${i}`), layout: '12x12' }).ok)
}

// ---- saved views ---------------------------------------------------------------------------------
{
  const good = { id: 'v1', name: 'Yard and gates', cameras: ['nvr-1/0', 'nvr-2/17'], layout: '2x2' }
  check('checkView: a well-formed view is accepted as it is', checkView(good).ok && checkView(good).value.name === 'Yard and gates')
  check('  the name is trimmed to one line', checkView({ ...good, name: '  Yard\n  and gates ' }).value.name === 'Yard and gates')
  check('  a blank name is refused', !checkView({ ...good, name: '   ' }).ok)
  check('  so is one over the limit', !checkView({ ...good, name: 'x'.repeat(MAX_VIEW_NAME + 1) }).ok)
  check('  a view with no cameras is refused', !checkView({ ...good, cameras: [] }).ok)
  check('  a camera key that is not "<nvr>/<channel>" is refused', !checkView({ ...good, cameras: ['nvr-1'] }).ok && !checkView({ ...good, cameras: ['../etc/passwd'] }).ok)
  check('  more cameras than a view holds is refused', !checkView({ ...good, cameras: Array.from({ length: MAX_VIEW_CAMERAS + 1 }, (_, i) => `nvr-1/${i}`) }).ok)
  check('  repeated cameras are kept once', checkView({ ...good, cameras: ['nvr-1/0', 'nvr-1/0', 'nvr-2/17'] }).value.cameras.length === 2)
  check('  a view with no id is refused rather than given one, so an edit cannot become a copy', !checkView({ ...good, id: undefined }).ok)
  check('  an unknown layout falls back to one that fits the camera count', checkView({ ...good, layout: 'wall' }).value.layout === '2x2')
  check('  a live-page layout id is accepted (views are shared with the live grid)', checkView({ ...good, layout: 'g8' }).value.layout === 'g8' && checkView({ ...good, layout: '1+5' }).value.layout === '1+5')
  check('  a camera that no longer exists is dropped, not made unsaveable',
    checkView(good, { known: new Set(['nvr-1/0']) }).value.cameras.join() === 'nvr-1/0')
  check('  but a view left with no cameras at all is then refused', !checkView(good, { known: new Set() }).ok)
  check('  rubbish in gives a refusal rather than an error', !checkView(null).ok && !checkView([]).ok && !checkView('x').ok)

  const list = normaliseViews([good, { ...good, id: 'v2', name: 'Bay' }, { id: 'v3', name: '', cameras: ['nvr-1/0'] }])
  check('normaliseViews: the bad ones are dropped and counted, the good ones kept', list.views.length === 2 && list.dropped === 1)
  check('  a repeated id is one view, the later one winning (that is what an edit looks like)',
    normaliseViews([good, { ...good, name: 'Renamed' }]).views.map((v) => v.name).join() === 'Renamed')
  check('  more views than allowed are cut', normaliseViews(Array.from({ length: MAX_VIEWS + 5 }, (_, i) => ({ ...good, id: `v${i}` }))).views.length === MAX_VIEWS)

  // versioning, exactly as the live grid's order does it
  const now = { views: [good], version: 3 }
  const ok = applyViews(now, { views: [good, { ...good, id: 'v2' }], version: 3 })
  check('applyViews: a change made on the current version is saved and the version counts up', ok.saved && ok.version === 4 && ok.views.length === 2)
  const stale = applyViews(now, { views: [], version: 2 })
  check('  a change made on an older version is refused and the latest is handed back', !stale.saved && stale.version === 3 && stale.views.length === 1)
  check('  a change with no version at all is refused', !applyViews(now, { views: [] }).saved)
  check('  a first save (version 0) works from nothing', applyViews(null, { views: [good], version: 0 }).saved)
  check('  emptying the list is a real save, not a refusal', applyViews(now, { views: [], version: 3 }).saved)
}

// ---- lanes ------------------------------------------------------------------------------------
{
  const onScreen = [{ key: 'nvr-1/0' }, { key: 'nvr-1/2' }, { key: 'nvr-2/17' }]
  check('lanes: "all cameras in view" gives a lane for every tile on the page', laneSet('all', onScreen).length === 3)
  check('  "this camera" gives only the tile in focus', laneSet('one', onScreen, 'nvr-1/2').map((t) => t.key).join() === 'nvr-1/2')
  check('  with nothing in focus it falls back to the first tile rather than no lane at all', laneSet('one', onScreen).map((t) => t.key).join() === 'nvr-1/0')
  check('  a focus key that is not on this page falls back too', laneSet('one', onScreen, 'nvr-9/1').map((t) => t.key).join() === 'nvr-1/0')
  check('  an empty page gives no lanes rather than an error', laneSet('one', []).length === 0 && laneSet('all', null).length === 0)
}

// ---- exporting a view -------------------------------------------------------------------------
{
  const keys = ['nvr-1/0', 'nvr-2/17']
  const ex = exportClipsFor(keys, 1000, 5000)
  check('export: one clip per camera over the same stretch', ex.clips.length === 2 && ex.error === null)
  check('  each clip is the shape /api/exports takes', ex.clips[0].nvr === 'nvr-1' && ex.clips[0].ch === 0 && ex.clips[0].fromMs === 1000 && ex.clips[0].toMs === 5000)
  check('  a channel past 9 is read whole, not one digit', exportClipsFor(['nvr-2/17'], 0, 1).clips[0].ch === 17)
  check('  a stretch with no length is refused with something to read', exportClipsFor(keys, 5000, 5000).error !== null)
  check('  so is a view with no cameras', exportClipsFor([], 0, 1000).error !== null)
  const many = exportClipsFor(Array.from({ length: MAX_EXPORT_CLIPS + 4 }, (_, i) => `nvr-1/${i}`), 0, 1000)
  check('  more cameras than one export job takes are cut here and counted, not failed at the end',
    many.clips.length === MAX_EXPORT_CLIPS && many.dropped === 4)
}

// ---- opening streams gently -------------------------------------------------------------------
{
  check('backoff: nothing to wait for until something has been refused', backoffMs(0) === 0)
  check('  the first refusal waits, and each one after waits twice as long', backoffMs(1) === BACKOFF_BASE_MS && backoffMs(2) === BACKOFF_BASE_MS * 2 && backoffMs(3) === BACKOFF_BASE_MS * 4)
  check('  the wait is capped, so it never becomes "never"', backoffMs(30) === BACKOFF_MAX_MS)
  check('  the cap is five minutes, matching the recorder\'s own backoff', BACKOFF_MAX_MS === 300_000)

  let s = afterRefusal({}, 1000)
  check('afterRefusal: one refusal, and a moment before which it may not ask again', s.refusals === 1 && s.blockedUntil === 1000 + BACKOFF_BASE_MS)
  check('  and it really may not', !mayOpen(s, 1001) && mayOpen(s, 1000 + BACKOFF_BASE_MS))
  s = afterRefusal(s, 1000 + BACKOFF_BASE_MS)
  check('  refusals in a row lengthen the wait', s.refusals === 2 && s.blockedUntil === 1000 + BACKOFF_BASE_MS * 3)
  check('afterVideo: pictures arriving clear the count and the block', mayOpen(afterVideo(s), 0) && afterVideo(s).refusals === 0)
  check('  a tile that has never been refused may open straight away', mayOpen({}, 0))

  const tiles = [
    { key: 'a', wants: true, streaming: false, opening: false },
    { key: 'b', wants: true, streaming: false, opening: false },
    { key: 'c', wants: true, streaming: true, opening: false }
  ]
  const first = openPlan(tiles, 10_000, { lastOpenAt: -Infinity })
  check('openPlan: only ONE tile is opened at a time, however many are wanted', first.open === 'a' && first.waiting === 2)
  check('  and the one already streaming is left alone', !first.close.includes('c'))
  const tooSoon = openPlan(tiles, 10_000, { lastOpenAt: 10_000 - (OPEN_STAGGER_MS - 1) })
  check('  the next one waits out the stagger, so nine tiles are never nine simultaneous requests', tooSoon.open === null && tooSoon.waiting === 2)
  check('  once the stagger has passed the next one goes', openPlan(tiles, 10_000, { lastOpenAt: 10_000 - OPEN_STAGGER_MS }).open === 'a')
  check('  nothing new opens while one is still waiting for its first picture',
    openPlan([{ key: 'a', wants: true, streaming: false, opening: true }, { key: 'b', wants: true, streaming: false, opening: false }], 10_000, { lastOpenAt: 0 }).open === null)

  const offPage = openPlan(
    [{ key: 'a', wants: false, streaming: true, opening: false }, { key: 'b', wants: false, streaming: false, opening: true }, { key: 'c', wants: true, streaming: false, opening: false }],
    10_000,
    { lastOpenAt: 10_000 } // opening is rate limited; stopping must not be
  )
  check('  a tile nobody is looking at is stopped at once, whatever the stagger says', offPage.close.join() === 'a,b' && offPage.open === null)
  check('  a tile that is off the page is not counted as waiting either', offPage.waiting === 1)

  const blocked = openPlan(
    [{ key: 'a', wants: true, streaming: false, opening: false, blockedUntil: 20_000 }, { key: 'b', wants: true, streaming: false, opening: false }],
    10_000,
    { lastOpenAt: 0 }
  )
  check('  a tile the NVR refused is skipped until its wait is up; the next one goes instead', blocked.open === 'b')
  check('  but it is still counted, so the viewer is told cameras are outstanding', blocked.waiting === 2)
  check('  when everything is blocked, nothing is asked for at all',
    openPlan([{ key: 'a', wants: true, streaming: false, opening: false, blockedUntil: 20_000 }], 10_000, { lastOpenAt: 0 }).open === null)
  check('  nothing wanted, nothing done', openPlan([], 10_000, { lastOpenAt: 0 }).open === null && openPlan(null, 0, {}).close.length === 0)

  check('openNote: a settled grid says nothing', openNote({}).text === '' && openNote({}).level === 'ok')
  check('  a grid still coming up explains why, with a count', openNote({ waiting: 3 }).text.includes('3 to go'))
  check('  a refusal is said plainly, and points at the answer that costs the NVR nothing',
    openNote({ refused: 2 }).level === 'over' && openNote({ refused: 2 }).text.includes('HD'))
  check('  a refusal is said even while others are still opening', openNote({ waiting: 4, refused: 1 }).level === 'over')
}

// ---- a PC whose browser cannot play H.265: no grid of more than 16 tiles ---------------------------
{
  const { NO_H265_LAYOUT, NO_H265_MAX_TILES, NO_H265_NOTE, layoutShown, layoutsOffered } = await import('../public/grid-view.js')
  // the live page's layouts and how many tiles each shows (viewer.js layoutCells), the list last
  const tiles = { g1: 1, g2: 4, g3: 9, g4: 16, g5: 25, g6: 36, g8: 64, g10: 100, g12: 144, '1+5': 6, '1+7': 8, '1+12': 13, '2+8': 10, list: 48 }
  const all = Object.keys(tiles)
  check('no-H.265 limit: 16 tiles, and the layout fallen back to has exactly that', NO_H265_MAX_TILES === 16 && NO_H265_LAYOUT === 'g4' && tiles[NO_H265_LAYOUT] === NO_H265_MAX_TILES)
  check('  a browser that plays H.265 is offered every layout', layoutsOffered(tiles).join() === all.join() && layoutsOffered(tiles, { noH265: false }).join() === all.join())
  check('  one that cannot: nothing over 16 tiles, in the menu\'s order', layoutsOffered(tiles, { noH265: true }).join() === 'g1,g2,g3,g4,1+5,1+7,1+12,2+8')
  check('  ...counted from the tiles, not the names', layoutsOffered({ wide: 17, small: 16, g12: 4 }, { noH265: true }).join() === 'small,g12')
  check('  no layouts at all is none, not a crash', layoutsOffered(null, { noH265: true }).length === 0)
  check('  a larger layout is shown as 4 x 4, and said', JSON.stringify(layoutShown('g8', tiles, { noH265: true })) === JSON.stringify({ layout: 'g4', limited: true }) && layoutShown('g5', tiles, { noH265: true }).layout === 'g4')
  check('  4 x 4 and smaller are left as they are, with nothing to say', ['g1', 'g4', '1+12', '2+8'].every((id) => { const s = layoutShown(id, tiles, { noH265: true }); return s.layout === id && s.limited === false }))
  check('  a browser that plays H.265 keeps the larger layout', JSON.stringify(layoutShown('g12', tiles, { noH265: false })) === JSON.stringify({ layout: 'g12', limited: false }) && layoutShown('g12', tiles).layout === 'g12')
  check('  a layout the page does not draw is left for the caller', layoutShown('8x8', tiles, { noH265: true }).layout === '8x8' && layoutShown(undefined, tiles, { noH265: true }).limited === false)
  // a saved view with a larger layout: shown at 4 x 4, and still what it was
  const view = Object.freeze({ id: 'v1', name: 'Yard', cameras: Object.freeze(['nvr1/0', 'nvr1/1']), layout: 'g8' })
  const before = JSON.stringify(view)
  const shown = layoutShown(view.layout, tiles, { noH265: true })
  check('  a saved 8 x 8 view opens at 4 x 4 without being rewritten', shown.layout === 'g4' && shown.limited && JSON.stringify(view) === before && checkView(view).value.layout === 'g8')
  check('  the note says why, and what the limit is', /cannot play H\.265/.test(NO_H265_NOTE) && /server converts/.test(NO_H265_NOTE) && /4 × 4/.test(NO_H265_NOTE))

  // viewer.js, live-tile.js and index.html wiring (source scan: the viewer needs a browser)
  const { readFileSync } = await import('node:fs')
  const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const src = read('viewer.js')
  const block = src.slice(src.indexOf('const layoutNote ='), src.indexOf('const noH265Timer ='))
  check('viewer.js: fixed tile counts come from layoutCells, Auto caps itself', block.includes("id === 'auto' ? 1 : layoutCells(id).cells.length") && !/g5|g6|g8|g10|g12/.test(block))
  check('viewer.js: the limit is applied whenever the page comes to know, not only at load', /const noH265Timer = isPhone\(\) \? null : setInterval\(limitForNoH265, 1000\)/.test(src) && /if \(noH265Limit \|\| !cannotPlayH265\(\)\) return/.test(block))
  check('viewer.js: the larger layouts leave the menu', /if \(!offered\.includes\(o\.value\)\) o\.remove\(\)/.test(block) && /layoutsOffered\(LAYOUT_TILES, \{ noH265: true \}\)/.test(block))
  check('viewer.js: a larger layout falls back, and Auto redraws when the codec limit arrives', block.includes("shown === wanted && wanted !== 'auto'") && /page = 0\n\s*freshenForPageChange\(\)\n\s*render\(\{ keepSingle: true \}\)/.test(block))
  check('viewer.js: the limit itself stores nothing (the PC\'s own choice and the saved views stay)', !/localStorage|putViews/.test(block))
  check('viewer.js: the note is set as text, when a layout was cut', /if \(limited && layoutNote\) \{\n\s*layoutNote\.textContent = NO_H265_NOTE\n\s*layoutNote\.hidden = false/.test(block) && !/innerHTML/.test(block))
  check('viewer.js: a saved view opens through the same limit', /layoutSelect\.value = layoutOnThisPc\(activeView\.layout\)/.test(src))
  check('index.html: the note has a place of its own, hidden until needed', /<p id="layoutNote" class="page-note" role="status" hidden><\/p>/.test(read('index.html')))
  const tile = read('live-tile.js')
  check('live-tile.js: cannotPlayH265 is the answer the streams are opened with', /export function cannotPlayH265\(\) \{\n\s*return h265Answer\(\{ device: deviceH265, forced: forcedNoH265, learned: learnedNoH265 \}\) === false\n\}/.test(tile))
  check('wall.js: the wall plays recordings (/playback), not the live conversion, and has no such limit', !/cannotPlayH265|layoutsOffered/.test(read('wall.js')))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
