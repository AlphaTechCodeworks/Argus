// Offline tests for the live grid's camera-list refresh (public/grid-diff.js): which refreshes
// rebuild the grid and which only touch single tiles (a camera going offline or coming back, a
// new name), so a 30 s poll no longer blanks and reconnects every picture.
//   node cctv/test/grid-diff.test.mjs
import { diffCameras, shownCameras, visibleCameras } from '../public/grid-diff.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const cam = (nvr, ch, extra = {}) => ({ nvr, site: 'A', nvrName: nvr.toUpperCase(), ch, name: `Cam ${ch + 1}`, online: true, remote: false, ...extra })
const base = () => [cam('n1', 0), cam('n1', 1), cam('n1', 2), cam('n1', 3), cam('n2', 0), cam('n2', 1)]
const view = (o = {}) => ({ site: '', hideOffline: false, perPage: 4, page: 0, ...o })
const edit = (list, i, fields) => list.map((c, j) => (j === i ? { ...c, ...fields } : c))

// ---- visible set -----------------------------------------------------------------------------------
{
  const v = visibleCameras(base(), view())
  check('page 1 of 2 shows the first 4', v.pages === 2 && v.page === 0 && v.visible.map((c) => c.ch).join() === '0,1,2,3')
  const v2 = visibleCameras(base(), view({ page: 5 }))
  check('page beyond the end is clamped', v2.page === 1 && v2.visible.length === 2)
  const v3 = visibleCameras(edit(base(), 1, { online: false }), view({ hideOffline: true }))
  check('hide offline drops offline cameras', v3.visible.map((c) => `${c.nvr}/${c.ch}`).join() === 'n1/0,n1/2,n1/3,n2/0')
  const v4 = visibleCameras([...base(), cam('n3', 0, { site: 'B' })], view({ site: 'B' }))
  check('site filter', v4.visible.length === 1 && v4.visible[0].nvr === 'n3')
  const all = [...edit(base(), 1, { online: false }), cam('n3', 0, { site: 'B' })]
  const s = shownCameras(all, view({ site: 'A', hideOffline: true }))
  check('shownCameras: every page\'s cameras under the same filters, in list order', s.map((c) => `${c.nvr}/${c.ch}`).join() === 'n1/0,n1/2,n1/3,n2/0,n2/1')
  check('  the pages are slices of it', visibleCameras(all, view({ site: 'A', hideOffline: true, page: 1 })).visible[0] === s[4])
}

// ---- nothing changed ---------------------------------------------------------------------------
{
  const d = diffCameras(base(), base(), view())
  check('same list: no rebuild, nothing to update', !d.full && d.changed.length === 0)
}

// ---- per-camera changes on the page: only those tiles --------------------------------------------
{
  const d = diffCameras(base(), edit(base(), 2, { online: false }), view())
  check('camera goes offline (not hidden): only its tile', !d.full && d.changed.length === 1 && d.changed[0].index === 2 && d.changed[0].online && !d.changed[0].name)
  const back = diffCameras(edit(base(), 2, { online: false }), base(), view())
  check('camera back online: only its tile', !back.full && back.changed.length === 1 && back.changed[0].index === 2 && back.changed[0].online && back.changed[0].cam.online === true)
  const n = diffCameras(base(), edit(base(), 1, { name: 'Gate' }), view())
  check('name change: label only', !n.full && n.changed.length === 1 && n.changed[0].name && !n.changed[0].online && n.changed[0].cam.name === 'Gate')
  const r = diffCameras(base(), edit(base(), 3, { remote: true }), view())
  check('remote flag change: tile listed, no rebuild', !r.full && r.changed.length === 1 && r.changed[0].remote)
  const two = diffCameras(base(), edit(edit(base(), 0, { online: false }), 3, { name: 'X' }), view())
  check('two cameras change: two tiles', !two.full && two.changed.map((c) => c.index).join() === '0,3')
}

// ---- changes off the current page don't touch the grid ------------------------------------------
{
  const d = diffCameras(base(), edit(base(), 5, { online: false }), view())
  check('camera on another page goes offline: nothing to do', !d.full && d.changed.length === 0)
  const d2 = diffCameras(base(), edit(base(), 5, { online: false }), view({ page: 1 }))
  check('... but on that page: its tile', !d2.full && d2.changed.length === 1 && d2.changed[0].index === 1)
}

// ---- the visible set or order changes: full rebuild ------------------------------------------------
{
  check('camera added on the page: rebuild', diffCameras(base(), [cam('n0', 0), ...base()], view()).full)
  check('camera removed: rebuild', diffCameras(base(), base().slice(1), view()).full)
  check('order changed: rebuild', diffCameras(base(), [base()[1], base()[0], ...base().slice(2)], view()).full)
  // hide offline: a camera going offline moves the others up
  check('hide offline, camera goes offline: rebuild', diffCameras(base(), edit(base(), 1, { online: false }), view({ hideOffline: true })).full)
  check('hide offline, camera comes back: rebuild', diffCameras(edit(base(), 1, { online: false }), base(), view({ hideOffline: true })).full)
  // a camera added on a later page changes the page count (the pager), not the tiles
  check('camera added on a later page: rebuild (pager)', diffCameras(base(), [...base(), cam('n2', 2), cam('n2', 3), cam('n2', 4)], view()).full)
  // a second site appears: every label gets its site prefix
  check('second site appears: rebuild (labels)', diffCameras(base(), [...base().slice(0, 5), cam('n2', 1, { site: 'B' })], view()).full)
  check('camera moves to another site under a site filter: rebuild', diffCameras(base(), edit(base(), 0, { site: 'B' }), view({ site: 'A' })).full)
  check('first load (empty before): rebuild', diffCameras([], base(), view()).full)
}

// ---- viewer.js wiring (source scan: the viewer needs a browser) -----------------------------------
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../public/viewer.js', import.meta.url), 'utf8')
  const load = src.slice(src.indexOf('async function loadCameras'))
  check('loadCameras updates tiles in place when nothing moved', /diffCameras\(before, gridCameras\(\), view\)/.test(load) && /if \(!diff\.full\) return updateTiles\(diff\.changed\)/.test(load))
  // a camera coming onto or leaving the page moves the tiles that stay (relayout), not a rebuild
  // of every tile (9-13 new connections at once, behind an open full-size view)
  check('... and a camera arriving or leaving moves tiles (relayout), rebuilding only when the page frame changed', /relayout\(\)/.test(load.slice(0, load.indexOf('\n}\n'))) && /if \(!sameFrame \|\| !labelsSame\) return render\(\{ keepSingle: true \}\)/.test(load))
  check('render uses the same visible set as the diff', /visibleCameras\(gridCameras\(\), gridView\(perPage\)\)/.test(src))
}

// ---- Live HD per camera (stream rights) -----------------------------------------------------------------
{
  const d = diffCameras(base(), edit(base(), 1, { hd: true }), view())
  check('hd flipping is a change of that tile, not a rebuild', d.full === false && d.changed.length === 1 && d.changed[0].hd === true && d.changed[0].index === 1)
  check('hd the same: no change', diffCameras(edit(base(), 1, { hd: true }), edit(base(), 1, { hd: true }), view()).changed.length === 0)
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../public/viewer.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  check('viewer.js: full screen goes to main with Live HD (not a browser that failed main; a P2P camera only when local)', /if \(cam\.hd !== false && !noMain\.has\(single\) && !\(cam\.remote && REMOTE_PAGE\)\)/.test(src) && /upgradeToMain\(overlay, cam, sub, opts\)/.test(src))
  check('viewer.js: without it, the SD badge', /else if \(cam\.hd === false\) overlay\.querySelector\('\.name'\)\.after\(sdBadge\(\)\)/.test(src))
  check('viewer.js: the full-size view is rebuilt when Live HD flips', /if \(keep && Boolean\(singleCam\?\.hd\) === Boolean\(cam\.hd\)\)/.test(src))
  check('viewer.js: "Recordings" only with a playback right', /if \(cam\.playback !== false\) \{/.test(src))
  check('viewer.js: a main layer refused before it showed goes, the sub-stream stays', /onHdRefused: \(\) => \{\n\s*if \(!layer\.classList\.contains\('pending'\)\) return false/.test(src))
}

console.log(failures ?`\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
