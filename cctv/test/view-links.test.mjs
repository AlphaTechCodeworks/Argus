// Tests the Live page's view links and cycling (public/view-links.js), and the wiring in viewer.js,
// index.html, login.js and server.mjs that a browser would otherwise be needed for.
//   node cctv/test/view-links.test.mjs
import { readFileSync } from 'node:fs'
import {
  CYCLE_DEFAULT_S, CYCLE_IDLE_MS, CYCLE_MAX_S, CYCLE_MIN_S, cycleDue, cycleSeconds, findLinkedView, menuId,
  nextCycleId, parseMenuId, readCycle, readViewLink, safeNext, viewHref
} from '../public/view-links.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---- menu ids ----
check('menuId: one\'s own view is its id, a shared one says whose', menuId({ id: 'v1' }) === 'v1' && menuId({ id: 'v1', owner: 'sam' }) === 's|sam|v1')
check('parseMenuId: both come apart again', same(parseMenuId('v1'), { owner: '', id: 'v1' }) && same(parseMenuId('s|sam|v1'), { owner: 'sam', id: 'v1' }))
check('  an owner with a "|" in the name still parses (the id cannot have one)', same(parseMenuId(menuId({ id: 'v2', owner: 'a|b' })), { owner: 'a|b', id: 'v2' }))
check('  nonsense is null', [null, '', 's|', 's||v1', 's|sam|', 'a b', '../x', 's|sam|v 1'].every((s) => parseMenuId(s) === null))

// ---- links ----
const own = [{ id: 'v1', name: 'Yard' }]
const shared = [{ id: 'v1', name: 'Their yard', owner: 'sam' }, { id: 'v9', name: 'Gate', owner: 'ann' }, { id: 'v9', name: 'Gate 2', owner: 'bob' }]
check('findLinkedView: one\'s own view first', findLinkedView(own, shared, 'v1').name === 'Yard')
check('  &from= picks the shared one even when an own view has that id', findLinkedView(own, shared, 'v1', 'sam').name === 'Their yard')
check('  a shared one by id', findLinkedView(own, shared, 'v9').owner === 'ann' && findLinkedView(own, shared, 'v9', 'bob').name === 'Gate 2')
check('  none, or no such owner: null', findLinkedView(own, shared, 'nope') === null && findLinkedView(own, shared, 'v9', 'zed') === null && findLinkedView(own, shared, null) === null)

check('readViewLink: ?view=&screen=1', same(readViewLink('?view=v1&screen=1'), { view: 'v1', from: '', screen: true, cycle: null, every: CYCLE_DEFAULT_S }))
check('  &from= is read', readViewLink('?view=v1&from=sam').from === 'sam')
check('  a view id that is not one is ignored', readViewLink('?view=../etc').view === null && readViewLink('?view=a%20b').view === null)
check('  screen only when asked', readViewLink('?view=v1').screen === false && readViewLink('?screen=0').screen === false && readViewLink('?screen=yes').screen === true)
check('  ?cycle=a,b&every=45', same(readViewLink('?cycle=v1,s|sam|v2&every=45').cycle, ['v1', 's|sam|v2']) && readViewLink('?cycle=v1,v2&every=45').every === 45)
check('  a cycle of one view, or of rubbish, is no cycle', readViewLink('?cycle=v1').cycle === null && readViewLink('?cycle=,,x y').cycle === null && readViewLink('?cycle=v1,v1').cycle === null)
check('  every out of range is clamped', readViewLink('?cycle=a,b&every=1').every === CYCLE_MIN_S && readViewLink('?cycle=a,b&every=9999').every === CYCLE_MAX_S && readViewLink('?cycle=a,b&every=x').every === CYCLE_DEFAULT_S)
check('  nothing asked: nothing', same(readViewLink(''), { view: null, from: '', screen: false, cycle: null, every: CYCLE_DEFAULT_S }))

check('viewHref: the link to one\'s own view', viewHref('https://cctv.example', { id: 'v1' }) === 'https://cctv.example/index.html?view=v1')
check('  a shared one carries its owner, the TV one screen=1', viewHref('https://x/', { id: 'v1', owner: 'sam' }, { screen: true }) === 'https://x/index.html?view=v1&from=sam&screen=1')
check('  what it makes, readViewLink reads back', (() => {
  const back = readViewLink(new URL(viewHref('https://x', { id: 'v9', owner: 'a b' }, { screen: true })).search)
  return back.view === 'v9' && back.from === 'a b' && back.screen
})())

// ---- cycling ----
check('cycleSeconds: 10 to 300, 30 by default', cycleSeconds(30) === 30 && cycleSeconds('60') === 60 && cycleSeconds(5) === 10 && cycleSeconds(301) === 300 && cycleSeconds(undefined) === 30 && cycleSeconds(null) === 30 && cycleSeconds('') === 30 && cycleSeconds('x') === 30)
check('readCycle: what this browser kept, tidied', same(readCycle('{"ids":["v1","s|sam|v2","v1","bad id"],"every":5,"on":true}'), { ids: ['v1', 's|sam|v2'], every: 10, on: true }))
check('  "on" needs two views', readCycle('{"ids":["v1"],"every":30,"on":true}').on === false)
check('  rubbish (or a browser with nothing kept) is null', readCycle('not json') === null && readCycle(null) === null && readCycle('{"ids":"v1"}') === null && readCycle('[]') === null)

const ids = ['a', 'b', 'c']
check('nextCycleId: round in order, back to the start', nextCycleId(ids, 'a') === 'b' && nextCycleId(ids, 'c') === 'a')
check('  from a view not in the cycle: the first', nextCycleId(ids, '') === 'a' && nextCycleId(ids, 'x') === 'a')
check('  a view that has gone is skipped', nextCycleId(ids, 'a', (id) => id !== 'b') === 'c')
check('  fewer than two left: stays put', nextCycleId(ids, 'a', (id) => id === 'a') === null && nextCycleId([], '') === null)
check('  the one on screen is not "next" when the others went', nextCycleId(ids, 'a', (id) => id !== 'c') === 'b' && nextCycleId(ids, 'b', (id) => id !== 'c') === 'a')

const t0 = 1_000_000
check('cycleDue: after its seconds, not before', cycleDue({ now: t0 + 30_000, shownAt: t0, everyS: 30 }) && !cycleDue({ now: t0 + 29_000, shownAt: t0, everyS: 30 }))
check('  not while paused (full-size view, dialog, hidden tab)', !cycleDue({ now: t0 + 999_000, shownAt: t0, everyS: 30, paused: true }))
check('  not soon after the viewer clicked or pressed a key', !cycleDue({ now: t0 + 60_000, shownAt: t0, lastInput: t0 + 50_000, everyS: 30 }))
check('  and then the view gets its whole time again from that click', !cycleDue({ now: t0 + 50_000 + CYCLE_IDLE_MS + 1000, shownAt: t0, lastInput: t0 + 50_000, everyS: 30 }) &&
  cycleDue({ now: t0 + 50_000 + 30_000, shownAt: t0, lastInput: t0 + 50_000, everyS: 30 }))

// ---- coming back after signing in ----
check('safeNext: the Live page with a plain query', safeNext('/?view=v1&screen=1') === '/?view=v1&screen=1' && safeNext('/index.html?view=v1&from=s%20m') === '/index.html?view=v1&from=s%20m')
check('  never another site or another page', [null, '', '/', '//evil.example/?x', 'https://evil.example/?view=1', '/settings.html?x=1', '/?view=<script>', '/\\evil?x'].every((s) => safeNext(s) === null))

// ---- the wiring (source scan: the page needs a browser) ----
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const viewer = read('public/viewer.js')
const html = read('public/index.html')
check('viewer.js: a cycle switches views exactly as choosing one does (selectView)', /const next = nextCycleId\(cycle\.ids, [^\n]+\n\s*if \(next\) selectView\(next\)/.test(viewer))
check('viewer.js: it waits for the full-size view, a dialog, a hidden tab and a drag', /if \(single !== null \|\| document\.hidden \|\| document\.querySelector\('dialog\[open\]'\) \|\| drag\.dragging\(\)\)/.test(viewer))
check('viewer.js: the cycle is kept in localStorage, inside try/catch', /try \{ return readCycle\(localStorage\.getItem\(CYCLE_KEY\)\) \} catch/.test(viewer) && /try \{ localStorage\.setItem\(CYCLE_KEY/.test(viewer))
check('viewer.js: ?view= finds own or shared views', /findLinkedView\(views, sharedList, viewLink\.view, viewLink\.from\)/.test(viewer))
check('viewer.js: screen mode is set before anything is drawn', viewer.indexOf("classList.add('screen-mode')") > 0 && viewer.indexOf("classList.add('screen-mode')") < viewer.indexOf('function render('))
check('viewer.js: an expired session comes back to the same link', /function toSignIn\(\)/.test(viewer) && !/location\.href = '\/login\.html'\n/.test(viewer.slice(viewer.indexOf('async function checkSession'), viewer.indexOf('async function checkSession') + 900)))
check('viewer.js: a shared view can be used but not edited or deleted', /editViewBtn\.hidden = !mine/.test(viewer) && /deleteViewBtn\.hidden = !mine/.test(viewer) && /if \(!activeView \|\| activeView\.owner\) return/.test(viewer))
check('index.html: the editor, the cycle dialog and the link buttons are there', ['id="vePick"', 'id="veLayout"', 'id="veDrawGrid"', 'id="vePlace"', 'id="veShare"', 'id="cycleDlg"', 'id="cycleStop"', 'id="copyLink"', 'id="copyScreenLink"', 'id="editView"', 'id="copyView"'].every((s) => html.includes(s)))
const login = read('public/login.js')
check('login.js: goes back only where safeNext would allow (the same pattern)', login.includes(String.raw`/^\/(index\.html)?\?[A-Za-z0-9=&,|%._~-]{0,512}$/`) && read('public/view-links.js').includes(String.raw`/^\/(index\.html)?\?[A-Za-z0-9=&,|%._~-]{0,512}$/`))
const server = read('server.mjs')
check('server.mjs: the sign-in redirect carries a Live link back, and only that', /pathname === '\/' \|\| pathname === '\/index\.html'\) && \/\^\\\?\[A-Za-z0-9=&,\|%\._~-\]\{1,512\}\$\/\.test\(url\.search\)/.test(server))
check('server.mjs: shared views are listed with the live right per camera', /handleViews\([^\n]*mayWatch: \(nvr, ch\) => who\.admin \|\| can\(who, 'live', \{ nvr, ch \}\) === true/.test(server))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
